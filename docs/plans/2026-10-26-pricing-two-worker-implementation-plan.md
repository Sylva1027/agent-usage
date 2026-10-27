# 价目覆盖与汇率：双 worker Implementation Plan

日期：2026-10-26。状态：**21/23 卡已验收（R01–R10、V01–V11）；后端已按窗口合根，界面完成隔离联合验收、待共享 UI 文件窗口；R11/R12 等完整官方材料。** 用户已确认范围：最新「模型合并与官方价计价」加上旧方案仍有效的覆盖、刷新状态和汇率改进。本文是这批工作的统一施工入口；实际派工与验收见[执行记录](../validation/2026-10-26-pricing/README.md)。

产品语义以[模型合并与官方价计价](2026-10-25-model-merge-and-official-pricing.md)为准；[价目覆盖、代理线路与汇率](2026-10-22-pricing-coverage-and-route-pricing-plan.md)仅提供仍适用的覆盖、自动刷新与 FX 需求和带日期的诊断。冲突时采用最新用户决定。旧 [A](2026-10-24-pricing-implementation-A.md)/[B](2026-10-24-pricing-implementation-B.md)及隔离补丁整包作废，不摘取代码、不续派旧卡，也不删除归档产物。

## 1. 本批交付范围

1. 同一模型的别名在费用汇总、时间图、期间比较、价目在用列表及覆盖计数中合并，统一使用官方模型条目。原始事件名、reader、索引与 rollup 存储保持原样；TPS 的 provider/model 分组保持现有语义。
2. 覆盖按规范名计数；最低费率假设和真正未定价份额在用户主动查看的费用详情内可见。**未知模型继续使用现行最低费率估算**，不恢复旧方案的 priced-only 切换，不新增普通模型或线路编辑入口。
3. 价格部分失败、各来源结果、价格与 FX 的独立时间、自动/手动/内置 FX 来源可以查看；说明放进现有价目弹窗或主动展开的详情，沿用现有金额卡、布局和视觉层级。
4. 价格维护、缺价发现和 FX 按各自到期条件请求；行内重新匹配只处理该模型，全局刷新仍是全局。终态拒绝不每小时盲重试，能力变化后可重新评估。
5. 服务运行时在启动及每小时独立检查，复用成功 24h、失败 1h 门槛；手动 FX 不被自动刷新覆盖，撤销时取最新自动值。没有页面也能工作，导入的只读实例保持冻结、不联网更新。
6. 自动发现按官方提供商逐项扩大，先交付前三批，再做有完整证据的首个官方来源。无法确认的模型保持现状，不承诺消除全部缺价。

不包含 `routes`/`routeOverrides`、卖家身份关联、账本定价、订阅探测、数据库迁移、归档重做、备用 FX 源、新依赖及通用定价框架。现有两条转售内置项按新设计删除，但不批量清理用户的自动缓存或手动配置。

## 2. 人员、归属与开工基线

沿用用户已有的两位 worker，本计划使用新角色名 W1/W2，避免与已作废的 A/B 分区混淆：

- **W1，价目与服务：[Price-worker-A](codex://threads/01a16b03-da82-70e3-8c27-02945d1869d4)。** 独写 `public/pricing-models.js`、`src/pricing.js`、`src/pricing-auto.js`、`src/pricing-store.js`、`src/server.js`、必要的 `src/usage-executor.js` 接点。测试归属：`test/pricing-models.test.js`、`test/pricing.test.js`、`test/pricing-auto.test.js`、`test/claude-pricing.test.js`、必要的 `test/server.test.js`/`test/w1-executor.test.js`；本次可按需新建 `test/pricing-refresh.test.js`、`test/pricing-scheduler.test.js`，不复制旧隔离测试。
- **W2，聚合与界面：[Price-worker-B](codex://threads/01a16b03-e8b0-7081-bb98-b0458c5e9ecc)。** 独写 `src/usage-core.js`、`src/usage-store.js`、`src/usage-rollups.js`、`public/timeline-utils.js`、`public/period-comparison.js`、`public/app.js`、必要的 `public/app-state.js`/`public/i18n.js`/`public/index.html` 接点。测试归属：`test/timeline-utils.test.js`、`test/period-comparison.test.js`、`test/usage-rollups.test.js`、`test/three-path-parity.test.js`、`test/app-summary.test.js`、`test/app-render.test.js`、`test/i18n.test.js`、现有 `test/history-timeline-currency-order.test.js`；本次按需新建 `test/pricing-model-merge.test.js` 与小型 `test-support/pricing-official-fixture.mjs`。
- **本 chat 主审：** 冻结共用接口、安排卡、独立复核、协调共享文件窗口，以及最终文档与交付记录。不并写 worker 正在编辑的产品文件，也不另起第三个实现 worker。

测试归属不表示所有文件必改；每卡只取本卡确需的文件。`styles.css` 默认不动；确有既有布局适配需要时由主审单独移交 W2，不借本批重做样式。

历史保留线仍在施工，见[其实施计划 §3](2026-10-22-history-retention-implementation-plan.md#3-人员文件所有权与协作规则)。以上是本批内部责任划分，**不是共享文件已经释放**。开工前主审核对当前文件 owner，保存相关文件真实前像与 SHA-256，再给唯一写入者；保留现有 memo FIFO、峰谷快路、导入只读语义、冷区/perf carrier 和混币修复。当前源码的未提交改动也是基线的一部分，不能用 HEAD 或旧隔离副本覆盖。

拿不到窗口时，可以在包含当前未提交基线的隔离副本完成该卡；共享源码合入另核前像。不要为等待窗口无休止增加探针，也不要重新制作数百 MB 的多份全目录副本。生产配置、生产数据库、来源日志与正式服务不在本批写入范围；真实数据验收优先使用已有只读接口或独立测试副本。

## 3. 两位 worker 共用契约

### 3.1 模型身份与查询目录

- W1 提供 `canonicalModelName(raw, models)`；`models` 是本次查询的有效目录。未知名返回原名；别名与可解析前缀遵守新设计 D3–D7。旧免费规则、Claude 版本守卫和已有后缀适用边界不能因归一化变成错误收费或扩大匹配。
- `resolvePricingModel(raw, models)` 保留既有字段，新增 `canonicalModel`；`rawModel` 保留原始名。W2 只调用这份共用逻辑，不另写一套正则或别名表。
- `buildUsagePricingCoverage(harnessModels, models, ready)` 保留签名，按规范名去重并合并 harness 集合。空集/未就绪仍有区别；`harnessModels` 和活动观测中的原始名不写回修改。
- `buildTimelineRows` 通过现有 `options` 增加 `pricingModels`，W2 更新内存、索引、store 与浏览器调用者。使用当前报告或冻结响应对应的完整目录，不用弹窗草稿或另一次实时 GET 的目录替代。W1 在 R09 补足 HTTP/执行器实际缺失的传递接点。
- SQL 使用 `usage_model_group(model)`，调用同一函数；一次同步查询的目录上下文固定。UDF 用于读侧分组，不用于 rollup 写入、索引表达式或持久化规范名。

### 3.2 聚合、混币与缓存

- tokens/事件数按规范名累加，会话按 `sessionId` 去重。没有会话字段的期间比较行不新增该字段。
- 时间图已有混币契约继续成立：逻辑模型名先规范化，成本仍按「规范名＋原币种」分桶；混币内部键不能成为显示名、颜色键或 TPS 身份。同币种 shape 沿用现有格式，跨 bucket 详情按币种合计，保留 `costPairFromSlots`。
- 不从原币币种标签推断 `totalUsd` 已统一成美元；沿用当前 native pair 的汇总/展示链。归一化后输入顺序倒置，原生 USD/CNY 两部分必须相同。
- `periodComparisonCache` 的现有键加入本次目录版本，并修正“只依赖用量”的旧注释。其他派生缓存只在实际依赖模型归一化时补失效；不新增通用缓存管理层。
- 原始事实和费用逐事件计算保留；不把 token 先按模型求和再套峰谷/上下文档位。目录更新无新事件时实时投影重算；旧冻结/导入实例维持其目录和分组。

### 3.3 状态、刷新与 FX

在既有 API 与缓存格式上做兼容增量，旧缓存缺字段可读取，不升级手动价目 schema：

- `automatic.pricePartialFailure` 直接返回已持久化的价格侧部分失败；保留 `priceAttemptedAt`、`priceUpdatedAt`、FX 的三个时间、`issues`、`modelMetadata` 和 `priceUpdateSummary`。全局更新时间不称为“全部来源成功”。
- 在现有 `priceUpdateSummary` 中补 `sourceResults`；每个实际尝试来源记录 `source`、`attemptedAt`、`fetched`、`parsed`、`updatedModelCount`。抓取失败时 `parsed` 可为 null；解析成功但价格没变时 count 为 0。未尝试来源保留自己的上次结果与问题，不伪造本轮成功，也不清掉旧失败。
- FX 增量字段 `exchangeRateMode` 为 `automatic` / `manual` / `built-in`，表达当前有效值来源；`automaticUsdToCnyRate` 继续表达后台最新自动值。年龄由 `exchangeRateDate` 与受控当前时间计算，超过 5 个自然日的情况在详情内说明，不增加工作日历或常驻警告。
- `discoveryResults` 中每条结果补 `retryable` 与 `nextRetryAt`；终态没有下次自动时间。网络失败按 1h 门槛，not-found 随后续目录更新再评估，解析能力/明确官方映射改变时使旧终态可再评估。复用现有发现结果存储，不另建任务队列表。
- `POST /api/pricing/refresh` 无 `model` 仍是现有全局操作；带 `{model, force:false}` 时只处理该模型的解析/发现所需来源，不顺带更新全目录或 FX。行内操作遵守冷却，不能偷偷改为全局 `force:true`。模型已归并命中则直接报告匹配，不联网。非法请求保持现有错误处理；冻结/导入上下文不借行内操作修改实时目录。
- 后台固定 1h 检查，价格与 FX 分别判断 24h/1h 门槛，不能以缺价发现让六源全重拉。定时器 `unref`、关闭清理并等待在途操作；导入只读实例禁用自动更新。测试可注入时钟、fetcher 和调度，不实等一小时。
- 手动 FX 优先，自动值仍缓存更新；撤销才切回最新自动值。沿用版本校验、原子保存及失败回滚，必要的最小串行提交覆盖自动刷新与保存；不搬入旧 A/B 的独立 editVersion、routes 或编辑器机制。

### 3.4 界面表达与来源扩展

覆盖比率的模型分母是同一活动范围内的规范模型数；全历史金额中的最低费率份额来自当前查询 `costEstimate`，两者不互相代替。`minimumEstimatedTokens` 是 priced 子集，不能重复相加；重叠诊断不拼成百分比总和，零分母显示无适用数据。

普通页面保持“一行模型、一个金额”。估算机制、价格源失败、参考汇率及非结算口径默认放在用户主动打开的详情，复用现有弹窗/展开控件。不得新增常驻说明、警告框、徽标墙或“卖家价”入口；不为本批改变金额卡名称和整体几何布局。

官方发现扩展只接受明确官方提供商及完整费率/上下文政策，不按日志的线路前缀猜供应商，不从转售价反推官方价。一个来源、一个实际候选依次落地；缺必需字段或全零且无免费政策证据时保留拒绝原因，不补 0、不套用 OpenAI 的 Fast 倍增/长短档假设。

## 4. 派工与并行顺序

每卡目标 **15–20 分钟，包含本卡实现、1–3 个关键行为验证和简短回报**。一个 worker 同时只拿一张卡；同一卡返修不反复换编号。到约 15 分钟仍无法收口，交实际 diff、失败与剩余行为；预计超过 25 分钟由主审把明确的剩余行为拆成后继，不能默默扩大范围或用弱断言凑绿。

主审逐卡读 diff、核对消费者，并独立复跑必要验证后释放依赖。上下游可读待审代码准备下一卡，但依赖未接受前不宣称完成。等待时拿真正就绪的卡，不靠无关审计填满时间。

推荐排班（是依赖顺序，不要求每轮严格等长）：

2026-10-26 实际调度：V06 接受后，V08 的状态/详情不依赖行内匹配，先实施 V08，再接 R06 就绪后的 V07，避免等待。

1. W1 **R01**；W2 **V01**。先让共用函数与代表性夹具落地，避免 UI 与 SQL 各造自己的规范化。
2. W1 **R02**；W2 **V02**，均依赖已接受的 R01。
3. W1 **R03**；W2 **V03**。
4. W1 **R04**；W2 **V04**。
5. W1 **R05**；W2 **V05**。模型第一批的核心接点至此具备。
6. W1 **R06**；W2 **V06**。
7. W1 **R07**；W2 **V07**。W2 可按已冻结的响应夹具开发，真实行内联调等 R07。
8. W1 **R09**；W2 **V08**，不要让状态 UI 等后台 timer。
9. W1 **R08**；W2 **V09**。三路对拍先等 R09 目录传递完成。
10. W1 **R10**；W2 **V10 → V11**。把三路对拍、冷热冻结和浏览器拆开，避免最后一张卡承担全部集成。主审可在 W2 收口时完成 W1 独立复核。
11. 首三批接受且来源材料齐备后，W1 依次 **R11 → R12**。W2 若无对应缺口即结束本批，不为维持并行制造 UI 工作；新来源改变了实际输出时才补必要页面回归。

主审开卡前只需给：卡号、基线/工作目录、允许文件和共享窗口、已接受前置、验收命令。回报统一为：卡号、文件、实际行为、命令/结果、剩余项。只有失败或改接口才追加说明，不要求每卡长报告。

## 5. W1 小卡：价目、刷新与服务

### R01 — 共用规范化与解析（20 min）

前置：共享文件已释放。文件：`public/pricing-models.js`、`test/pricing-models.test.js`。

实现 §3.1 共用函数、三条 DS 显式别名和先规范化再解析；保留 rawModel。给 `group/deepseek` 注释写清本机 Magpie 组约定与配置变动后需同步。验证八个 DS 名落同一目录键，三个未知负例保持，现有免费和 Claude 守卫不退化；使用一份带过时同名条目的目录验证先规范化优先级。交付导出与返回字段，解锁 R02/R03/V02/V03。

### R02 — 官方条目与逐事件金额（20 min）

前置：R01。文件：`src/pricing.js`、对应 pricing/auto/Claude 测试。

删两条 QwenCloud 内置条目，`normalizeModel` 使用共用解析结果，证据名保留原样。修正内置数量与 provider 覆盖断言；不改 DS 峰谷引擎、现有 Fast 政策、memo FIFO 或未知最低费率算法。验证别名/规范名在同 token、来源、档位、时间戳下金额相等，峰谷和边界时点保持；新目录下费用 memo 不返回旧结果。自动缓存残留不清理，只验证被归一化的历史别名不会抢官方键。解锁费用对拍。

### R03 — 覆盖按规范名计数（15 min）

前置：R01。文件：`public/pricing-models.js`、其专测。

coverage 的 used/missing 去重键使用规范名，合并 harness 集合，不改活动名单原始证据。八个 DS 名只贡献一个已匹配模型，未知与未就绪/空集区分保留。用不同目录验证后来补入裸名会更新覆盖，旧目录不变。交付实际 API 数据形状，解锁 V07。

### R04 — 独立价格/FX 状态（20 min）

前置：R03。文件：`src/pricing-store.js`、`test/pricing-refresh.test.js`。

接出 §3.3 的部分失败、来源结果和 FX mode，复用现有时间与元数据；状态变更能更新 statusVersion。旧自动缓存缺新字段可读取。验证价格部分成功不冒充全成功、无自动报价使用 built-in、手动 FX 和后台自动值可同时表达。无需新增调度即可接受，解锁 V08。

### R05 — 分开价格维护、发现与 FX 的 fetch 计划（20 min）

前置：R04。文件：`src/pricing-store.js`、刷新专测。

拆开现有 updatePrices 对 discoveryDue 的捆绑，发现只请求需要的现有目录源并复用一次下载；未到期 FX 不顺带抓取。分别保留未尝试来源的问题、上次有效值与时间。用记录 URL 的假 fetcher 验证“仅 FX 到期”“仅一个模型发现”“完整价格到期”三条路径及部分失败，不扩供应商解析。交付刷新内部参数给 R06/R08。

### R06 — 有限重试与单模型刷新内核（20 min）

前置：R05。文件：`src/pricing-store.js`、必要的 `src/pricing-auto.js`、刷新专测。

实现单模型过滤、retryable/nextRetryAt 与终态再评估，沿用现有发现结果；模型已命中时不联网。网络失败到期可再试，unsupported 当前能力下不小时重拉，能力修订后允许重评，not-found 随后续目录刷新再试。验证目标操作不处理其他缺价模型、不改变全量到期窗口。暂不增加厂商适配器，解锁 R07/V07。

### R07 — API 接线与 FX 保存并发（20 min）

前置：R06。文件：`src/server.js`、必要的 `src/pricing-store.js`、刷新/API 测试。

既有 refresh 端点接入带 model 请求，保留无 model 的全局 force 行为；复用/最小修正共享刷新与保存的串行提交，确保刷新不丢手动 FX、撤销取最新自动值，取消不保存，失败回滚。保持旧 API 错误与版本校验，导入只读拒绝写入。验证实际 HTTP 目标请求的 fetch 范围，以及一次保存与刷新交错，不能只测 body 里出现 model。解锁行内真实联调。

### R08 — 页面关闭时仍有后台检查（20 min）

前置：R05、R07。文件：`src/server.js`、`test/pricing-scheduler.test.js`，必要的现有测试夹具开关。

在服务启动就绪后及每小时检查到期，复用刷新 promise；实现 unref、关闭清理/等待与只读导入禁用。测试开关只服务确定性测试，正常服务默认工作。验证成功 24h、失败 1h、与手动刷新并发不重复、关闭后不再调度；不实等，不依赖浏览器打开。受影响的 server 测试显式离线/禁用调度，不能全仓机械改夹具。

### R09 — HTTP、冻结与执行器使用各自目录（20 min）

前置：R02、R03、V02；与 V05 对齐上下文契约。文件：`src/server.js`、必要的 `src/usage-executor.js`、API/执行器专测。

核对 full/dashboard/summary 与 pricing 返回、执行器请求、snapshot/importContext 的目录来源；仅补缺失的传递点，供 V06 消费。旧冻结不能拿实时目录或实时 FX 状态解释旧金额；导入包没有自动抓取状态时按缺省/不可用展示，不制造联网成功记录。不扩备份格式。目录替换后实时读更新，旧冻结/导入维持；解锁 V09。

### R10 — 后端联合回归与交接（15–20 min）

前置：R01–R09、V05。文件：只修本 worker 已有文件与相关专测。

在同一完成基线上跑 resolver、计价、auto、刷新/API、scheduler 的相关测试；新增覆盖只补前面缺的关键行为。核对 schema 未变、旧配置可读、全局刷新/FX 撤销仍可用、导入实例不联网；交付实际失败及基线对照。通过后与 V11 一起接受前三批，不把 R11/R12 来源证据绑定为前置。

### R11 — 首个官方来源发现解析（20 min，证据齐备才开）

前置：前三批已接受；主审指定**一个**官方 provider/裸名候选及完整来源样本。文件：`src/pricing-auto.js`、其专测。

复用现有 provider 映射和 fetch/校验，按精确官方键新增一个来源的发现能力；供应商政策独立处理，不泛扫所有 reseller。验证完整样本可解析，缺写入或上下文政策及无免费证据全零样本不发布，不推广 OpenAI Fast 倍增。若找不到完整官方证据，记录该具体输入缺口并保持本卡待开始，不拿转售线路样本替代。

### R12 — 官方发现发布与已有覆盖联动（20 min）

前置：R11。文件：`src/pricing-store.js`、必要的 auto 专测及刷新专测。

接入该来源候选，验证写入仍用现有模型上限、目录验证与原子发布；冲突/非法候选不改变旧有效值，成功后同一裸名的可解析前缀按 R01 自动收敛。一次真实 HTTP 夹具刷新验证 coverage 更新、来源状态正确、其他手动值保留；未支持的两个真实未知模型仍可保持未知。只接受这一个 provider 的能力，不以合成通过宣称全官方目录都可发现。

## 6. W2 小卡：投影、缓存与界面

### V01 — 代表性共用夹具（15 min）

前置：无；与 R01 并行。文件：小型 `test-support/pricing-official-fixture.mjs`、`test/pricing-model-merge.test.js`。

提供八个 DS 名、三个未知负例、一个已知非 DS 前缀；同会话出现两个别名、峰谷时间戳、不同来源及可替换 A/B 目录。沿用现有 fixture pattern，原事件输入不归一化、不写 fake resolver。补一个能暴露现状的合并断言并说明预计红测；不扩成 fixture 框架。解锁后续共用对拍。

### V02 — 内存与紧凑索引汇总（20 min）

前置：R01、V01。文件：`src/usage-core.js`、模型合并/三路专测。

两条 models 分组使用同一目录和共用规范化；沿用会话 Set、排除来源和范围逻辑，report.events/紧凑索引 strings 不回写。准备传递 timeline 的 pricingModels，完整金额仍逐事件算。验证内存/紧凑索引模型行相同、会话去重、原始名保留，不改 perf 分组。

### V03 — SQLite 普通模型汇总（20 min）

前置：R01、V01。文件：`src/usage-store.js`、模型合并专测。

在现有连接注册只读 `usage_model_group` 并把 groupedRange 的 model 维度接入；保持 source、其他维度、会话 DISTINCT 与 excludeHomes。目录上下文跟随当前读请求，不能在开库时永久捕获初始 models。验证 SQL 与内存同名/同额，且 events.model 的读取结果仍是原名。暂不改 rollup 写入或冷区事务。

### V04 — 期间比较的 rollup/部分日归并（20 min）

前置：V03。文件：`src/usage-rollups.js`、`src/usage-store.js`、rollup 专测。

模型日/区间与部分日查询按规范名合并，periodAggregate 使用同一结果；原 rollup 回填/写入仍按原始 model，旧表不重建。独立 DatabaseSync reader 的默认调用保持原始模型分组，不隐含要求安装 UDF；Store 只在已有注册与查询目录作用域内显式传 canonicalModels: true。单独调用日、区间、窗口（含 raw fallback）均须保持兼容，不能仅修改测试注册函数来掩盖旧 API 回归。验证整日+两端部分日、排除来源和已有旧 rollup，其他 token 明细/可用性字段不丢。

### V05 — 目录变化使期间缓存失效（15–20 min）

前置：V04；采用 §3.2 已选的版本缓存键，不重新比较三套实现。文件：`src/usage-store.js`、模型合并专测。

把本次目录版本纳入 periodComparisonCache，并改相关“只读 events、不依赖价目”注释。核对 hot/cold prepared 结果已有的价格版本，不重造缓存。无新事件的同一进程先用目录 A 读期间比较，再换目录 B 补裸名：实时归并更新，A 的冻结读仍旧。验证缓存命中与未命中结果一致。

### V06 — 时间图与客户端归一，保留混币（20 min）

前置：R02、V02、V05；HTTP 完整联调等 R09。文件：`public/timeline-utils.js`、`public/app.js`、core/store 的必要调用接点、timeline/app-summary 专测。

接 options.pricingModels；时间图 modelGroups、modelCosts 的逻辑模型名与客户端 summarize 模型行共用归一。保留 mixed-only 内部复合键、值中的 model 身份、native pair 和跨 slot 消费者。验证同一模型别名在 token 图合为一行、金额按币种正确分开、反转事件顺序结果相同；已修的 history currency-order 回归继续通过。

### V07 — 价目在用列表与行内匹配（20 min）

2026-10-26 消费者追踪补接点：共用 summarizePeriodComparison 的内存/full/冷区模型分组也需要 options.pricingModels，W2 小幅补 helper 与 store 调用、W1 R09 补 server；V09 对拍期间模型表。此项是既定模型归并范围内的遗漏修正，不新增存储机制。

前置：R03、R06、V06；真实 API 验证等 R07。文件：`public/app.js`、必要 app-state、app-render 专测。

列表显示规范名并沿用 catalogKey 去重，可点击已有官方条目编辑；coverage 用 R03 的规范名口径，活动范围保持不变。行内匹配传目标 model、force:false，终态/冷却文案读取实际结果，全局按钮仍独立。不增加新增模型表单。验证八个 DS 名只占一个在用模型、未知仍显示原名、成功后列表和覆盖同步，不把复合币种键当模型名。

### V08 — 费用详情、来源结果与 FX（20 min）

前置：R04、V06；可先于 V07 实施，目标重试仍由 V07 接线。文件：`public/app.js`、`public/i18n.js`，确需时少量现有 HTML；相关 render/i18n 专测。

在现有主动展开的详情/价目弹窗表达最低费率 token 与占比、真正 unpriced、价格部分失败、独立 FX mode/报价日期/年龄；机制与参考汇率解释也放详情。模型覆盖与查询 token 覆盖分别标清分母，保持金额算法及主卡布局。验证中英文、零分母、首次联网失败、旧报价和手动 FX；状态刷新不能静默覆盖未保存费率/汇率草稿，取消仍不写入。

### V09 — 三路对拍与事实保留（20 min）

前置：R09、V05、V06。文件：模型合并/三路专测；产品返修只限 W2 自有文件。

用同一小批原始事件对拍内存、SQLite、HTTP models 与 native 成本。验证同会话别名去重、排除来源和 UTC/local 范围，原始 events 名和 rollup 行仍原样。固定输入时核对金额与规范名官方价相等，不拿旧转售价要求新旧金额相同。冷热/冻结留给 V10，不扩这张卡。

### V10 — 冷读、冻结与目录替换（20 min）

前置：V09。文件：模型合并专测及确需的已有历史夹具；产品返修只限 W2 自有文件。

复用既有冷段和导入路径，验证一份代表性小数据的热/冷读结果一致。目录 A→B 且无新事件时，实时模型/期间/时间图更新，旧 snapshot 与导入 A 保持。只补这些接点的回归，不重复历史保留整线的恢复矩阵。若出现现有冷区故障，用当前基线同例对照并回主审，不顺手重做归档。

### V11 — 浏览器与界面收口（20 min）

前置：R07–R09、V07–V10。文件：只修 W2 已有文件及相关专测。

离线合成 home 的真实浏览器验模型视图、时间图图例、价目在用列表、官方条目编辑取消、目标重试和中英文；无新增常驻说明框、主卡几何回归或控制台错误。测试 FX 手动值与撤销，确认数值与 R07 语义一致。保存一张可验证结果的截图，回报使用的临时实例与目录，不访问正式服务的保存/刷新按钮。

## 7. 分批出口与验收

**G1：模型归一与官方金额。** R01–R03、V01–V07 中的模型行为以及 R09/V09/V10 的目录与冻结接线通过。八名归一、别名同价、会话去重、三路一致、原始名不变，期间缓存与混币不退化。行内刷新尚未接通时不提前宣称该按钮已交付；不以此阻塞已完成的模型计价。

**G2：覆盖、刷新状态与 FX 使用闭环。** R04–R07、R09、V07–V11 通过。状态与 FX 详情不依赖 R08；行内刷新实测只处理目标，最低费率与 unpriced 份额可在详情查看，手动/自动 FX 优先级、草稿取消与失败保留通过。

**G3：独立后台调度。** R08/R10 通过，并验证现有 GUI/CLI 生命周期和导入只读实例。成功 24h/失败 1h 是门槛，固定 1h 检查意味着到期后至多等一个检查周期，文档不能承诺精确到点。

**G4：首个官方来源发现。** R11/R12 独立接受。若缺完整证据，只记录具体 provider/model/字段和待开始卡；G1–G3照常交付，不声称 G4 已完成，也不恢复旧的线路发现任务。

单卡跑相关测试文件即可；默认使用现有 `node --test test/<相关文件>.test.js`。若环境确有 runner `spawn EPERM`，一文件一进程使用 `node --test --test-isolation=none test/<文件>.test.js`；不把多个文件混进同一共享模块状态。最终对完成基线集中跑相关 pricing、timeline、app、parity、缓存/冻结测试及 `npm.cmd run typecheck`、`npm.cmd run lint`、受影响文件格式检查。已通过且源码未变不反复全仓重跑；失败区分本次新增、当前基线同例及环境阻塞，不降断言。

真实数据只读复核采用同一冻结输入，验“八名是否合一、未知列表按当前输入收敛、非 DS 已知前缀归一、原币金额合理变化”；不把 2026-10-25 的 32→22 行或 ¥601 固定为测试期望。近期模型覆盖与全历史模型行范围不同，不能强求两个分母无条件相等。公网官方价格若需新核验，保留日期与来源；本计划不把旧快照变成当日价格承诺。

主审收口时更新 `docs/11-pricing.md`、两份设计入口、索引及简短执行记录，记录已接受卡、实际命令、共享基线/交付 diff、截图和剩余卡。不生成新的多套 A/B 计划，不应用旧补丁，不把文档计划当成产品已上线。
