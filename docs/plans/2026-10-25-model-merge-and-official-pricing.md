# 模型合并与官方价计价

更新：2026-10-26（补充 Codex 评审意见与验收修正；三条评审意见已逐条对代码核实，另补两处评审未提到的坑，见 §3.3 末与 §3.4）。状态：**方案已定稿（§6 三项已决），本批21/23卡已验收；后端已合根，界面隔离验收后待共享文件窗口**。本文是「把同一模型的多条命名合成一行、并统一按官方 API 价（含峰谷）计价」的唯一规格入口。

本文取代 [价目覆盖、代理线路与汇率](2026-10-22-pricing-coverage-and-route-pricing-plan.md) §5 的线路定价方向，并处置 [A](2026-10-24-pricing-implementation-A.md)/[B](2026-10-24-pricing-implementation-B.md) 两线成果：**整包作废，不合并任何一行**（§6.2）。A/B 的「缺价模型手动纠正」改记为独立后继，不在本方案范围。

2026-10-26 用户要求编制双 worker 实施计划，并确认同时纳入覆盖、刷新状态和汇率改进，统一施工入口为[价目覆盖与汇率：双 worker Implementation Plan](2026-10-26-pricing-two-worker-implementation-plan.md)。本文继续定义模型归一与官方计价语义；实施计划按约 15–20 分钟小卡安排两个 worker，用户已授权开工，实际进度见实施计划所链执行记录和[本批验收](../validation/2026-10-26-pricing/FINAL-REPORT.md)。

## 0. 定位与判据

费用不是账本，是**从金额里看出满足感**的展示功能。因此本文的唯一判据是：

> 一行模型、一个官方价、一个能一眼看懂的金额。

由此推出三条硬约束：

1. **不问卖家**。同一个模型经由哪个中转、哪个节点、哪个 plan 到达，都不改变它的价格。
2. **不猜套餐**。不抓取各家的 plan 档位，不探测用户在用哪种订阅——这既算不出真值，也触碰隐私。
3. **原始名是证据，合并只发生在投影层**。事件、索引、归档里仍然存日志原样写下的模型名；合并只影响汇总、时间图、价目弹窗和计费解析。

**Codex 评审意见（2026-10-26）**：赞同本次转向及 A/B 整包作废。此前线路方案围绕卖家身份、分线路费率和覆盖机制展开，对这里的展示目的做重了；318 项测试证明实现曾被验证，不构成继续保留它的产品理由。保留原始证据、共用规范化判断，并让 TPS 继续使用自己的分组维度，已经能满足本批目标。以下补充只收紧实现与验收口径，不增加线路机制、新增模型入口或常驻 UI 说明框。

## 1. 现状

### 1.1 一个模型，八行

2026-10-25 快照（`preset=all`，107,510 事件，全站 ¥6,256）：

| tokens | 原始模型名 | 来源 |
| --- | --- | --- |
| 3,483.4M | `deepseek-v4.1-flash` | dsh, claude, workbuddy |
| 2,709.4M | `opendesign/deepseek-v4.1-flash` | Codex |
| 401.9M | `workbuddy-ai/deepseek-v4.1-flash` | dsh, Codex |
| 379.8M | `workbuddy-ai/deepseek-v4.1-flash-sg` | Codex |
| 308.7M | `opencode-go/deepseek-v4.1-flash` | Codex, dsh |
| 282.1M | `deepseek-flash` | zcode, dsh, claude |
| 101.8M | `deepseek-v4.1-flash-sg` | claude, workbuddy |
| 22.9M | `group/deepseek` | dsh |

合计 7.69B tokens，占全站 49.7%。这八行是**同一个模型**，三种命名来源叠加：

- `<provider>/` 前缀：Magpie 把**请求侧的线路 id** 写进了日志的 `model` 字段（`.codex/config.toml` 的 `model`、DSH profile 的 `id`）。
- `-sg` 后缀：wb-intl 注册时走的 SG 节点。DS 的 `-sg` **没有**特殊价格。
- `group/deepseek`：Magpie 的路由组 id，日志里根本没有模型名，只有组名。
- `deepseek-v4.1-flash` ↔ `deepseek-flash`：DS 官方当前的改名，两者是同一个模型。

同样的问题不止 DS：`codex/gpt-6.1-sol`（120.1M）、`stepfun-cn/step-5-preview`（27.6M）、`opencode-go/gemini-4-argon-contributor`（27.2M）、`opencode-go/muse-spark-1.3-contributor`（0.6M）都是前缀造成的额外行。

### 1.2 金额现在是错的，而且方向相反地互相抵消

同一个 7.69B tokens 的 DS 用量：

| 口径 | 金额 |
| --- | --- |
| 当前看板 | **¥940** |
| 官方价 + 真实峰谷 | **¥601**（峰 ¥144 / 谷 ¥457，峰时 tokens 占 12.1%） |
| 官方价全按峰时 | ¥1,059 |
| 官方价全按谷时 | ¥529 |

（同日晚些时候重读，当前看板已是 **¥906**——用量在涨，绝对值会漂，看的是「当前口径与官方口径差多少」这个关系。）

¥940「看起来差不多」纯属巧合，两处错误互相抵消：

- `deepseek-v4.1-flash` 用的是 QwenCloud 转售价（USD 0.3 / 0.03 / 1.2，峰时窗口 08:00–22:00 全周），缓存价折人民币约 0.20 元，是官方 0.04 元的 **5 倍**；币种还是 USD。这行是 3.48B tokens，误差被放大。
- `opendesign/` 等 6 个前缀行命中未知模型最低费率兜底，比官方价**低** 5～6 倍。

也就是说，当前既不是「贵」也不是「便宜」，而是**每一行都不可信**。

### 1.3 官方价已核实，峰谷已建模

`src/pricing.js:222` 的 `deepseek-flash` 条目与 [DS 官方价目](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 一致：

- CNY，短/长档同价（DS 没有长上下文溢价）：输入 2 / 缓存读 0.04 / 输出 8 元每百万
- `offPeakMultiplier: 0.5`，`peakWindows` = 北京时间周一至周五 09:00–12:00、14:00–18:00

峰谷判定链路（`isPeakPricingTime` → `peakLocalTuple` → `peakWindowsHit`）已经在用，`test/pricing.test.js`「DeepSeek 谷时段按 5 折计价」钉住了三种时点。**这一块不需要改，只需要让所有 DS 行走到它上面。**

## 2. 决策

| # | 事项 | 结论 |
| --- | --- | --- |
| D1 | 合并后的规范名 | `deepseek-flash`（官方文档用名，也是现有价目键） |
| D2 | 合并发生在哪一层 | 投影层（汇总 / 时间图 / 界面 / 计价解析）。reader 与存储不动 |
| D3 | 前缀规则 | 剥掉 `<provider>/`，**仅当**剩余部分能解析成已知价目键时；否则保持原名 |
| D4 | 后缀规则 | 规则本身不改；但 D6 之后 `-sg` **不再自动命中**，须补显式别名，见 §2.3 |
| D5 | 别名 | 显式三条：`deepseek-v4.1-flash` → `deepseek-flash`（官方改名）、`deepseek-v4.1-flash-sg` → `deepseek-flash`（SG 节点无特殊价）、`group/deepseek` → `deepseek-flash`（Magpie 路由组，本机约定） |
| D6 | 转售条目 | 从内置价目删除 `deepseek-v4.1-flash`、`deepseek-v4-flash-0731` 两个 QwenCloud 条目 |
| D7 | 规范化的时机 | 在 `resolvePricingModel` 里**先**规范化、**再**走 exact/alias/free/suffix 链 |
| D8 | A/B 的 `routes`/`canonical`/`routeOverrides` | **不合并**。按线路分别定价与 D1–D3 直接冲突 |
| D9 | 索引迁移 | 不需要。合并是读侧投影，`usage_rollup_models` 仍按原始模型名存储 |

### 2.1 为什么规范化要放在 exact 之前（D7）

单看 D5/D6，把别名挂在现有 alias 段也能跑通：删掉 `deepseek-v4.1-flash` 条目后 exact 不再命中，别名自然生效。真正的理由在别处：

**展示合并与计费解析必须走同一条判断。** 若界面把 `opendesign/deepseek-v4.1-flash` 显示成 `deepseek-flash` 那一行，而计费仍按原始名去查——那么只要原始名在价目里有一条手动条目，这一行就会挂着 A 的名字、显示 B 的价。exact 先行正是保留这种可能性的机制。

所以：先在 `public/pricing-models.js` 算 `canonicalModelName(raw, models)`，再对规范名跑现有链路。一个函数同时服务展示合并和计费解析，两处不会漂移；`models` 显式传入本次查询使用的有效价目。

**代价（必须明说）**：规范化在 exact 之前，意味着对原始名的**手动价目覆盖会失效**——给 `opendesign/deepseek-v4.1-flash` 手填的价会被规范成 `deepseek-flash` 的价。这与 D1–D3 一致（本来就不该按卖家定价），且本机当前没有 `~/.codex-usage/pricing.json`，实际影响为零。若将来确实要给某条线路单独定价，正确做法是在代码里加一条显式例外，而不是恢复按名覆盖。

### 2.2 为什么前缀规则要求「剩余部分可解析」

无条件剥前缀会把两个不同模型合并成一个。加这个门槛后：

- `opendesign/deepseek-v4.1-flash` → 尾部 `deepseek-v4.1-flash` 是别名 → 命中 `deepseek-flash` ✅
- `codex/gpt-6.1-sol` → 尾部 `gpt-6.1-sol` 是价目键 → 命中 ✅
- `opencode-go/gemini-4-argon-contributor` → 尾部没有价目键 → 保持原名，仍按最低费率估算 ⚠️（诚实：我们确实不知道它的官方价）

### 2.3 `-sg` 必须补显式别名（实测修正）

本文早先写过「后缀规则已经能处理 `-sg`」——**那是错的**，实测推翻了：

| 原始名 | 现在 | 删掉 QwenCloud 条目后 |
| --- | --- | --- |
| `deepseek-v4.1-flash-sg` | `suffix` → `deepseek-v4.1-flash` ✅ | `missing` ❌ |
| `workbuddy-ai/deepseek-v4.1-flash-sg` | `missing` ❌ | `missing` ❌ |

原因：`resolvePricingModel` 的后缀规则是 `normalized.startsWith(key + "-")`，即「**已知键是前缀**」。`deepseek-v4.1-flash-sg` 之所以今天能命中，纯粹因为价目里恰好有 `deepseek-v4.1-flash` 这条——D6 删掉它，命中就消失。而 `deepseek-flash` 并不是 `deepseek-v4.1-flash-sg` 的前缀。

同样地，剥掉 `workbuddy-ai/` 后剩下 `deepseek-v4.1-flash-sg`。在原 D5（两条别名）下它既不是别名也不是价目键，D3 的门槛「剩余部分可解析」不通过——所以这条带前缀的 `-sg` 行**现在**就是 `missing`，不补别名的话合并后仍是 `missing`。

**修法**：把 `deepseek-v4.1-flash-sg` → `deepseek-flash` 加进 `PRICING_MODEL_ALIASES`（D5 第三条）。带前缀的两种写法靠 D3 的「尾部先查别名」自然命中，不需要再写。这两行合计 481.6M tokens（101.8M + 379.8M），不是可以放着不管的量。

补完之后八个原始名全部落到 `deepseek-flash`（已用真实价目模拟整条链验证）。

### 2.4 `group/deepseek` 为什么必须显式写

尾部 `deepseek` 不是任何价目键，也推不出是 flash 还是 pro。Magpie 的组名是用户自己起的，只能按约定映射。这行在 2026-10-25 早间快照是 22.9M，同日傍晚再读已涨到 99.3M（807 事件、全站 0.64%）——用户当前 Codex 配置里的 `model` 就是它，会持续产生，必须处理。

## 3. 改动点

### 3.1 `public/pricing-models.js`（前后端共用，唯一真源）

- 新增 `canonicalModelName(raw, models)`：显式别名 → 剥 `<provider>/` 前缀（尾部需可解析）→ 返回规范名。解析失败返回原名。
- `PRICING_MODEL_ALIASES` 增加三条（§2 D5），其中 `deepseek-v4.1-flash-sg` 那条是实测必需项（§2.3）。
- `resolvePricingModel` 入口改为先规范化；返回值新增 `canonicalModel` 字段，`rawModel` 保持原样（证据不丢）。

**目录依赖（2026-10-26 评审补充）**：D3 的「可解析」取决于目录内容，因此规范化不能暗中读取全局最新价目或固定内置目录。展示、计费和 SQL UDF 均使用本次查询的同一份 `models`；实时查询使用当前目录，冻结查询使用其冻结目录。用户后来补入一个裸名时，相应前缀名应立即归并；冻结查询仍维持原先的解析结果。沿用现有目录对象替换与版本机制，不另建映射配置系统。

### 3.2 `src/pricing.js`

- 删除 `deepseek-v4.1-flash`（`:519`）与 `deepseek-v4-flash-0731`（`:532`）两个 QwenCloud 条目。
- `normalizeModel`（`:939`）改为用规范名查价目，`name` 字段保留原始名（供最低费率提示与证据）。

删条目会撞到两处写死的内置模型数（已实测：103 → 101）：

| 断言 | 现值 | 改后 |
| --- | --- | --- |
| `test/pricing.test.js:784` `Object.keys(catalog.models).length` | 103 | 101 |
| `test/pricing-auto.test.js:199` `coverage.totalModelCount` | 103 | 101 |
| 同处 `supportedModelCount` | 99 | 97 |
| 同处 `supportedUsdModelCount` | 66 | 64 |
| 同处 `providers.alibaba` | 9 | 7 |

`supportedCnyModelCount`（33）与 `unsupportedCurrencyModelCount`（4）不变——删掉的两条都是 USD 的 QwenCloud 条目。`MAX_PRICING_MODELS`（256）与按 `MAX - length` 算余量的容量测试不受影响。

**本机实测的一个坑**：删内置条目**不会**清掉自动缓存里的同名条目。`~/.codex-usage/pricing-auto.json` 里有 `deepseek-v4-flash-0731`（`cachedInput` 0.088，内置是 0.044），`automaticBase()` 用 `overlay(defaults, automatic.models)` 合并，所以删完之后**本机生效价目仍是 102 条**而不是 101。`deepseek-v4.1-flash` 不在缓存里，会真的消失。

这不需要写清理代码：

- 两条都删后 `deepseek-v4.1-flash` 归一化为 `deepseek-flash`，D7 的「先规范化再 exact」让残留的缓存条目**永远轮不到命中**——这正是 D7 在实现层的第二个理由（第一个见 §2.1）。
- `deepseek-v4-flash-0731` 不在 §1.1 的八行里（本机无可见用量），残留只是让 `totalModelCount` 多 1，不产生金额。
- 若将来要清理，正确做法是在 `automaticBase()` 里按内置键集合过滤 `automatic.models`，但那是独立改动，不在本方案。

### 3.3 投影层（展示合并）

同一份规范名函数，接到所有按模型聚合的地方：

| 位置 | 现状 |
| --- | --- |
| `src/usage-core.js:4404` | 索引路径 `models:` |
| `src/usage-core.js:4484` | 内存路径 `models:` |
| `groupedRange`（`src/usage-store.js:9447`） | `SELECT ${dimension}`；`models:` 由 `:10328` 传入 `"model"` |
| `periodAggregate("model", …)`（`src/usage-store.js:9737`） | 走 rollup |
| `src/usage-rollups.js:123` | 原始事件回填 `GROUP BY model`（`SELECT model` 在 `:120`） |
| `src/usage-rollups.js:592` / `:641` | 单日 / 区间 rollup 查询的 `GROUP BY model` |
| `buildTimelineRows`（`public/timeline-utils.js:658`） | 时间图 `modelGroups` 的键 `modelName`；`modelCosts` 的键是 `modelName\0currency`（`:674`，2026-10-25 已改） |
| `public/app.js:1208` | 客户端重新分组 |

SQL 六处沿用既有做法：在 `usage-store.js:4148` 旁边注册确定性的 `usage_model_group` UDF（对照 `usage_source_group`），把 `GROUP BY model` 与 `SELECT model` 换成 UDF 结果。`usage-rollups.js` 的查询都从 `usage-store.js:9637/9647` 传入 `this.database`，与 UDF 同一条连接，注册一次即可。rollup 表**不重建**——读侧聚合，`usage_rollup_models` 仍按原始名存。

**时间图多一处**：`modelCosts` 现在按 `modelName\0currency` 分桶（同一天同一模型可能同时有 CNY 与 USD 估算），`costByModel` 在混币时输出 `model\0currency` 键并在值里带 `model` 字段（`public/timeline-utils.js:710-745`）。规范化 `modelName` 时这两处键要跟着一起换，不能只改 `modelGroups`——否则图例会合并而金额仍分两条。

> 本节的行号是 2026-10-26 核对时的值。`src/usage-store.js`、`public/app.js`、`public/timeline-utils.js` 正在被其他会话改动，实施时以**函数名**为准重新定位。

**聚合与缓存（2026-10-26 评审补充）**：

- 合并的是模型身份，token 与事件数可累加，会话数必须按 `sessionId` 去重。一个会话先后出现两个别名，合并后仍只算一个会话。SQL 路径保留按规范名分组后的 `COUNT(DISTINCT session_id)`；内存与客户端沿用会话集合，不能直接相加已聚合行的 `sessions`。（已核对：`groupedRange` 的 `:9449` 就是 `COUNT(DISTINCT session_id)`；`groupByUsage` / `groupIndexedEvents` / `groupEvents` / `addSegment` 都按组持有会话 `Set`。而 `periodAggregate` 的模型行只返回 `{key, name, periods}`，本来就没有会话字段——所以这条是预防性约束，不是在修一个现存 bug。）
- 模型投影现在依赖价目：即使用量没变，目录增删也可能改变 D3 的归并结果。检查模型汇总、期间比较和时间图的现有缓存入口，使目录变更后重算相关投影；需要时将现有价目版本纳入缓存键或失效条件。SQL UDF 在一次查询内使用固定的目录上下文，冻结查询不能借用实时目录。

**这条在本机代码里有一个具体的坑（2026-10-26 核对）**：`syncDerivedRevision()`（`src/usage-store.js:4579`）是 `metadataCache` / `periodComparisonCache` 的**唯一**失效入口，而它只在 `derivedRevision !== storeRevision` 时触发——**只看用量侧**。紧邻的注释（`:7208-7211`）把这条写成了硬前提：

> `periodComparison()` 走 `periodAggregate()` —— 那条 SQL **只读 `events`**，不用价目、不用 `source_files`、不用任何 perf 表。

模型分组一旦走读价目的 UDF，这句话就不成立了。`periodComparisonCache` 的键是 `${zone}|${dateKey}|${excludeHomes}`（`:9715`），**不含价目版本**。后果很具体：用户在 `pricing.json` 里补一条 `gemini-4-argon-contributor`，`opencode-go/gemini-4-argon-contributor` 本应立即并过去，但只要没有新事件，期间比较就会一直返回合并前的旧分组。执行器侧的 `applyPricingCatalog()`（`src/usage-executor.js:114`）按版本号换目录，完全不经过 `syncDerivedRevision()`，所以不会顺带清缓存。

修法（三选一，实施时定）：① 缓存键加上 `activePricing.version`；② 在 `setPricingCatalog` 后显式清 `periodComparisonCache`；③ 给 `syncDerivedRevision` 增加一个价目版本比对。①最省事且与 `eventCostMemo` 现有做法一致（它的键里已经含 `activePricing.version`）。同时要改掉 `:7208-7211` 那段注释，否则下一个人会照它把缓存键改回去。

2026-10-26 开工基线已包含 retention 的 all-hot summaryProjectionCache；模型目录的键集合也影响分组，V03 已将其纳入摘要缓存输入。期间比较另由 V05 纳入目录版本；时间图随本次响应目录构建，见实施计划 V06/R09。

`src/perf-stats.js:2003` 的 TPS 分组键**不改**。TPS 关心的是「哪个 provider 的哪个模型快」，卖家信息在那里是有效维度；而本机的 `modelProvider` 与模型名是两件事。

### 3.4 价目弹窗的「用量覆盖」口径（2026-10-26 核对补充）

`buildUsagePricingCoverage`（`public/pricing-models.js:147`）按**原始名**去重：`used` 这个 Map 的键是 `normalized` 原样，`usedModelCount = used.size`。`renderAutomaticPricingStatus`（`public/app.js:3328`）在有 activity 时会用它现算一遍，所以「用量覆盖 N/M」这一行**会继续把 8 个 DS 名算成 8 个在用模型**——模型视图已经并成 1 行，这里还是 8，两个数字对不上。

D7 之后 `matchedUsedModelCount` 会自己变好（每个前缀名都会被解析成 `deepseek-flash`，不再落 `missing`），但**分母不会**。改法：`used` 的键改用 `canonicalModelName(...)` 的结果，`missingUsedModels` 也只报规范名。`harnessModels` 本身仍是原始名（`src/usage-store.js:9087` 的 `SELECT DISTINCT channel, model`、`:883`、`public/app.js:2902`）——**证据层不动**，只在计数时归并。

这对自动发现无副作用：`scheduleUsageDiscovery`（`src/server.js:457`）拿 `missingUsedModels` 去查价，而规范化只在「尾部可解析」时才会改写名字——改写过的一定已经命中价目，不会出现在 `missing` 里；真未知的（`opencode-go/gemini-4-argon-contributor`、`sensenova-6.8-flash-lite`）保持原名，发现流程照旧。

价目弹窗的**模型列表**不用改：`pricingRowsForNames`（`public/app.js:3657`）已经按 `catalog:` + `catalogKey` 去重，`pricingHarnessRows`（`:3694`）再用 `claimedCatalogKeys` 跨 harness 去重，合并后本来就会收敛成一行。

### 3.5 不做

- 不碰 `tools/out`。
- 不改任何 reader（`src/*-usage.js`、`src/perf-sources/*`）与存储 schema。
- 不抓 plan 档位、不探测订阅、不读 Magpie 账本做计价。
- 不合并 `output/pricing-implementation-20261024/` 的 A/B 补丁；`docs/02-tasks.md` 与 `docs/00-index.md` 已改为「线路定价方向由本文取代，AB 补丁整包作废、留作归档」。该补丁现已无法整包应用（`src/server.js`、`test/pricing.test.js` 两处冲突），见 §6.2。
- 不给 `MODEL_COLOR_ORDER` 加固定色槽——`deepseek-flash` 落进溢出槽即可。

## 4. 预期结果（快照，实施后复核）

下表是 2026-10-25 早间的读数。同日晚些时候再读一次（108,287 事件）已经是全站 ¥6,208、DS ¥906、仍是 32 行 8 个 DS——**数据每天都在长，绝对值会漂**。验收看的是关系：DS 从 8 行并成 1 行、DS 金额向官方价靠拢、未知模型从 11 项降到 3 项；不要拿下面某个具体数字当通过条件。

| 指标 | 现在 | 改后 |
| --- | --- | --- |
| 模型行数 | 32 | 22 |
| DeepSeek 行数 | 8 | 1 |
| DeepSeek 金额 | ¥940 | ¥601 |
| 全站金额 | ¥6,256 | ¥6,063 |
| `minimumRateModels` | 11 项 | 3 项：`Unknown model`、`opencode-go/gemini-4-argon-contributor`、`sensenova-6.8-flash-lite` |

全站只降 ¥193 而 DS 降 ¥339，是因为 `codex/gpt-6.1-sol` 从最低费率兜底的 ¥5 涨到官方价 ¥133、`stepfun-cn/step-5-preview` 从 ¥1 涨到 ¥18。**这正是「按官方价计价」的效果：原来被兜底压低的行涨回去，原来被转售价抬高的行降下来。**

顺带一个信号：未知模型从 11 项降到 3 项。剩下的三个是真的不知道官方价——`gemini-4-argon-contributor` 与 `sensenova-6.8-flash-lite` 尾部没有价目键，`Unknown model` 本来就没有名字。它们继续按最低费率估算并带提示，是诚实的边界，不是待修的缺陷。

## 5. 验收

按影响选择，不跑全量。

1. **解析表**：八个原始名逐一断言 `canonicalModelName` 与 `resolvePricingModel(...).catalogKey` 都是 `deepseek-flash`，外加三个必须**不**被合并的负例（`opencode-go/gemini-4-argon-contributor`、`sensenova-6.8-flash-lite`、`Unknown model`）。`deepseek-v4.1-flash-sg` 单列一条（§2.3 的实测修正）。
2. **别名同价、峰谷不变**：对同一份 token、来源、计费档位与时间戳，分别以八个原始名和 `deepseek-flash` 在新解析下计价，`totalUsd` 逐条相等；原先已直接使用 `deepseek-flash` 的事件，实施前后峰谷结果保持不变。覆盖峰时、谷时和边界时点。不要求旧的转售价或未知最低价与新金额相等，那些金额发生变化正是本批目标。
3. **三路一致与会话去重**：内存 / SQLite 索引 / HTTP 三条路径的 `summary.models` 逐行相等（`test/three-path-parity.test.js` 口径）。加入同一会话使用两个别名的样例：合并后 token、事件数累计，会话数仍为 1；客户端重新分组遵守同一口径。
4. **真实数据**：本机 `preset=all` 复核 §4 的关系（行数、DS 合并成一行、`minimumRateModels` 三项），绝对值以当日读数为准。
5. **界面**：模型视图、时间图图例、价目弹窗「在用模型」三处显示合并后的名字；`deepseek-flash` 有颜色、可点开编辑。
6. **反向证据**：任一事件的 `report.events[].model` 仍是原始名（合并没写回存储）。
7. **内置模型数**：改 §3.2 表格里的四处断言（103→101、99→97、66→64、alibaba 9→7），并确认 `deepseek-v4-flash-0731` 若残留在 `pricing-auto.json` 里也不影响任何金额（§3.2 末尾）。
8. **目录变更与冻结一致**：在不增加事件的情况下，为原先未知的前缀名补入可解析裸名，确认实时模型汇总、期间比较、时间图和价目在用清单同步归并并按新价计费；变更前创建的冻结视图继续使用其旧目录与旧分组。验证现有缓存不会返回变更前的实时结果——具体到 `periodComparisonCache`：同一进程内先取一次 `periodComparison()`，`setPricingCatalog()` 换目录后再取，两次的 `models` 必须不同（§3.3 的坑）。
9. **用量覆盖口径**：`usagePricingCoverageText` 的分母按规范名计数——八个 DS 名只贡献 1（§3.4）。同一次渲染里「模型视图行数」与「用量覆盖分母」不得互相矛盾。

## 6. 已定事项（2026-10-25 用户决定）

### 6.1 `group/deepseek` → 写进代码 ✅ 已定

Magpie 的 routing 日志里 `group` 字段是**自描述的**：

```json
"group": {"id":"deepseek","ref":"group/deepseek","name":"DeepSeek","routing":"order",
          "members":["workbuddy-ai/deepseek-v4.1-flash:max",
                     "opendesign/deepseek-v4.1-flash:max",
                     "workbuddy-ai/deepseek-v4.1-flash-sg:max"]}
```

`usage.jsonl` 里 794 行 `req=group/deepseek` 全部由 `deepseek-v4.1-flash` 服务（1 行 `served=deepseek-flash`）。历史 routing 日志里只有这**一个**组，1152 条记录成员完全相同。

比较过的两条路：

| | 写进 `PRICING_MODEL_ALIASES` | 写进 `pricing.json` 的 `aliases` 段 |
| --- | --- | --- |
| 改动量 | 1 行常量 | 新配置段 + 读写 + 校验 + 界面入口，约 150–200 行 |
| 生效范围 | 任何人 | 只在本机 |
| 组改名/新增组 | 要改代码 | 用户自己改配置 |

关键判断：**只有 22.9M tokens（全站 0.3%）**（同日傍晚已涨到 99.3M / 0.64%，但量级仍在 1% 以下），且 `gpt-daybreak-blue-latest` 这类本机别名本来就在代码里，再加一条不改变性质。

**决定：写进代码。** 注释必须写明「Magpie 路由组的本机约定，组名由用户自定；改 Magpie 配置后要同步这里」。若将来组指向了别的模型，代码不会知道——这一点写在哪里都防不住，不构成选配置的理由。

### 6.2 A/B 的 `routes` 成果 → 整包作废 ✅ 已定

`output/pricing-implementation-20261024/` 里有 37 个文件、6,813 行新增，其中 559 行直接提到 route。该补丁**现已无法整包应用**——`src/server.js` 与 `test/pricing.test.js` 两处冲突（后者被 `b84885a` 的 `test/pricing.test.js` 改动顶掉）。排除这两个文件后其余 35 个可干净应用。

比较过的三条路：

| 处置 | 拿走什么 | 代价 |
| --- | --- | --- |
| **整包作废** | 什么都不拿 | 缺价模型仍不可手动补价 |
| 只挑线路相关 | 约 560 行 | 与本文目的直接冲突，且要解两处冲突 |
| 只挑「缺价模型手动纠正」 | `test/pricing-editor.test.js`（681 行）+ app.js 建模型分支 | 仍要解两处冲突；带走的是为 routes 服务的编辑器 |

**为什么第三条不划算（一处需要说准）**：A 的 `newModelNameIssue()` 拒绝含 `/` 的名字，因为它在设计上把「带 `/` 的名称」推给第二批的线路编辑。但按本文 D3，裸名 `gemini-4-argon-contributor` 一旦进入价目，`opencode-go/gemini-4-argon-contributor` 就会自动并过去——**A 的编辑器在 D3 之后反而比现在管用**。所以不作废它的理由不是「无效」，而是：

1. 它的模型新建流程、校验与 681 行测试是围绕「线路名与模型名两类实体」设计的，而 D3 之后只剩一类实体、且只剩 2–3 个未知模型；
2. 整包无法应用，单独摘取仍需解决 `src/server.js` 与 `test/pricing.test.js` 两处冲突；
3. 真正要作废的是同一份补丁里的 routes——把它的界面层留下来，等于留下 routes 的入口。

**决定：整包作废，不合并任何一行。**「缺价模型手动补价」记为独立后继（§7），按 D3 之后的需要重新做，不复用 A/B 代码。

沉没成本如实记录：这 6,813 行已通过 318 项定向测试与独立复核。但按 §0 判据，routes 把「同一模型的不同卖家」当成不同计价对象，正是要消除的东西——**保留它等于把要拆的先装上**。

`output/pricing-implementation-20261024/` 本身（650 MB，未跟踪、未被 gitignore）**不删除**，留作归档；清理见 §7。

### 6.3 未知模型手动补价 → 本批不做 ✅ 已定

合并后仍按最低费率估算的两个：`sensenova-6.8-flash-lite`（9 事件 / 0.3M）、`opencode-go/gemini-4-argon-contributor`（118 事件 / 27.2M）。

**决定：先不管。** 不在本批加「新增模型」入口。

真需要时手改 `~/.codex-usage/pricing.json` 就能生效，**且按 D3 的规则，合并后比现在更管用**：前缀规则要求「剩余部分可解析」，所以在 `modelOverrides` 里加一条 `gemini-4-argon-contributor` 之后，`opencode-go/gemini-4-argon-contributor` 的尾部就可解析，这一行会自动并过去并按你填的价计费；现在则不行——`resolvePricingModel` 只认 exact/alias/后缀，尾部不在价目里的带前缀名一律落到最低费率。

键名合法性已验证（按当前 103 条内置价目实测）：`validatePricingCatalog` 接受 `gemini-4-argon-contributor`，拒绝含 `/` 的键（`Invalid model name`）。所以只能填裸名——`opencode-go/gemini-4-argon-contributor` 作为键写不进去，但 D3 会把它折到裸名上。

代价是没有界面入口，得手写 JSON。这正是 §7 的后继要补的。

## 7. 后继（不在本方案范围）

- **缺价模型手动补价**：给「全部模型」列表加「新增模型」入口，让用户在界面上填一个价目条目，不必手改 `pricing.json`。独立立项，**不复用 A/B 代码**（理由见 §6.2）。规模远小于 A 的 681 行编辑器：合并后只剩 2–3 个未知模型，且不支持含 `/` 的键。
- **`output/pricing-implementation-20261024/` 的清理**：650 MB，未跟踪、未被 gitignore。本方案不动它；删除需用户另行决定。
