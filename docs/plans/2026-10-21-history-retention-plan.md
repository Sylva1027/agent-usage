# 历史数据保留、汇总与卷宗归档计划

研究基线：2026-10-21（第二稿）；施工衔接更新：2026-10-25。状态：**研究稿保留原时点证据，施工计划整理完成，恢复按交付出口推进**。

2026-10-22 施工更新：本稿保留研究过程；实施已启动，唯一施工契约为[历史保留 Implementation Plan](2026-10-22-history-retention-implementation-plan.md)，实际状态见[执行账本](../validation/2026-10-22-history-retention/README.md)。该施工更新时schema为19；本稿的v18落点、H3整轮指纹复用、费用维度“已满足”及只从热库重建等描述已被新计划修订，不能直接照本稿施工。
证据来源：`~/.codex-usage/usage-index.sqlite`（只读连接，2026-10-21 09:3x–09:4x 复测）、
[看板刷新性能账本](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/README.md)、
以及本文档"实测"小节中标注来源的临时库探针。

> **第二稿相对第一稿的修订**（第一稿的 08:2x 数字保留在文中作为对照）：
> ① WAL 的病因从"待查"改为**已定位的机制**（§1.4），H0 的落点因此改变；
> ② 撤回第一稿 §5 的 `sealed_at` 方案——它与仓库既有的 B7 防御正面冲突，改为**单轮内探针去重**；
> ③ 汇总层补 `home_label` / `context_level` / 来源 kind，`detail_mask` 改为**预派生列**而非求和；
> ④ `session_dims` 改为 `(session_id, day_key)`，否则区间 DISTINCT 不精确；
> ⑤ 卷宗封存改为 `ATTACH`（`VACUUM INTO` 不能在事务内执行），挂载改用**独立只读连接**（`PRAGMA query_only` 是连接级的）；
> ⑥ schema 版本改为 **18**（v17 已被 WorkBuddy 占用并落地）；
> ⑦ 新增"事件基线漂移"待查项（§12.6）。

本稿回答一个问题：历史越攒越多时，怎样既**一行不丢、随时能打包带走**，又不让冷启动和"全部"视图跟着线性变慢。

### 2026-10-24 施工约束修订（原研究数据保留）

用户授权分析[实施警示](2026-10-24-history-retention-warnings.md)后，正式施工契约已在[Implementation Plan](2026-10-22-history-retention-implementation-plan.md)§3、§4.5、§6 I3与§7修订。下列要求覆盖本稿旧假设；研究时点数字与旧估算不改写成今日结论。

- 冷events与perf/timing采用同一段目录和发布快照，旧event authority不自动授权perf淘汰。段须保存perf-only来源、原生依赖闭包、方法及旧修订证据；unplaced和不能证明闭包的依赖首版留热。沿用累计delta保全算法，events-v1格式不变，perf/timing另用具名表约束的perf-v1差分，同事务发布。原始样本重算TPS分位数，缺段/冲突整体失败。物理候选含perf表已确认，单段reader已验，不等于完整契约实现或可淘汰。
- 百万整站门槛：已有库health ready p95≤2.5s；首次完整dashboard HTTP p95≤10s/单次≤15s；skipCheck完整HTTP p95≤2s/单次≤5s；服务及executor合计峰值RSS≤1GiB；WAL稳态<100MB。按固定全热/冷热两布局各20新进程、每进程20暖请求及独立oracle验收，准确计时/内存边界以施工计划§7为准；未达标不算第19项完成。minimumRatesFor缓存已经修复，后续先profile当前残余热点。
- 共用store/core/类型/迁移/parity文件须跨线确认冻结窗口、唯一owner及前像摘要；A/C不可执行时按实际串行排期，保留单行为短卡，不扩成阶段大包。
- 第20项必有真数据副本staging上的dry-run→verify→新备份→提交→实际恢复，以及完整包异目录/新进程导入与冻结源对拍。400k/180天自动阈值不改，未达阈值可显式仅在staging选测试范围，自动封存默认关闭。在线真库提交/服务切换另需授权，不能把生产首次实验当测试门禁。
- 对旧93,977→84,029差额必须给两端快照/口径及逐事实归因，或明确缺失证据和可证明边界；当下可转移不证明旧差额已恢复。本稿“一行不丢”指实施后的保全目标，不能冒充对缺证历史的担保。

2026-10-25用户先要求完善计划，整理完成后已明确要求重新开始工作、继续推进。Implementation Plan §0/§3/§5–8已按剩余15–20项重排：有效修订→正式安全提交；归档/导入API、PC多段归档带和整站性能按依赖并行，最后真实副本演练与工程门禁。每项有完成条件、有限出口及唯一owner；旧阶段号/已验队列归档，不再从本研究稿派工。当前17/20、2进行中、1待开始（16已声明冷热修订范围、17导入冻结上下文及18真实浏览器闭环验收后更新），性能阈值与真实演练不下调。旧v18、ATTACH跨库写入与旧拆卡仅为研究记录，实际schema/协议/锁以施工计划与账本为准。

## 0 决策摘要

| 事项 | 结论 |
| --- | --- |
| 底线 | **事实层永不删**。归档是搬家，不是删除；"历史数据不容丢弃"是硬约束 |
| 头号问题 | **WAL 无界增长**，病因已定位：执行器在整个 sync 期间持有一个读快照（`usage-executor.js:147-176` 打开并 `BEGIN`），而**所有写都发生在这个窗口内** ⇒ checkpoint 永远 `busy=1`、WAL 从不 reset。实测 8.08 GB → 重启后 2.6 MB → 40 分钟又回到 13 MB |
| 归因 | 冷启动与"全部"视图的线性成本**不是 events 行数**（84k 行全量 SUM 28 ms、全行读进 JS 142 ms）。真实驱动是 ① WAL 恢复 ② 每轮 4 遍内容指纹（实测 589 ms / 495 MB）③ `buildRecordChampions()` 的全历史扫描 |
| 汇总层 | 新增 `rollup_daily` 等派生表。**它是索引，不是账本**，任何时刻可从明细重建（带 `rollup_version`） |
| 卷宗 | 一年以上明细整段搬进独立 `usage-YYYY-NN.sqlite`（明细 + 汇总 + manifest），主库只留目录行。导出即复制，导入即登记 |
| 触发 | **不按自然年**。行数 + 天数双阈值（≥40 万行 且 最老数据 ≥180 天），边界对齐本地日界。按当前外推，一年会产生 **3–4 段**（§4.6） |
| 反对 | 不做"只留一个总数"。汇总一旦成为唯一副本，按项目回溯、换价目重算、去重重放三件事同时失效 |
| 界面 | "成为象征"只发生在默认视图：时间轴上封存段显示为一条归档带，点开才展开 |
| 顺序 | P0 修 WAL → P1 探针去重 → P2 汇总层 → P3 读路径切换 → P4 卷宗 → P5 界面 |

## 1 实测：四种"负担"不是一回事

### 1.1 当前数据规模（2026-10-21 09:38 复测）

| 对象 | 行数 | 体积 | 单位成本 |
| --- | --- | --- | --- |
| `events` | **84,029** | — | — |
| `perf_samples` | 41,496 | — | — |
| `source_files` | **1,077** | — | main 894（456 MB `.jsonl.zst` + 1,687 MB `.jsonl`）、dsh 159 / 155 MB、claude 18 / 80 MB、workbuddy 4 / 7 MB、zcode 1 / 257 MB、opencode 1 / 30 MB |
| 主库文件 | — | 240 MB（60,025 页 × 4 KiB） | — |
| `perf_codex_projections` | 894 | **89.6 MB** | 100 KB/行 |
| `perf_file_fingerprints` | 1 行 JSON | **226 KB** | 每轮重写 |
| `perf_file_warnings` | 1 行 JSON | **156 KB** | 每轮重写 |
| `-wal` | — | **8.08 GB（08:59）→ 2.6 MB（09:27 重启）→ 13.2 MB（09:44）** | 仍在增长 |

时间跨度 37 天（2026-09-15 → 10-21），日均 2,271 条；峰值 6,319（10-04）。

> **与第一稿的差异**：第一稿 08:2x 记 93,977 行、峰值 10,726（10-18）。09:00 左右有 **291 个 main 文件被重新索引**（`source_files.indexed_at` 分布），总行数随后为 84,029、峰值日变为 10-04。当前服务运行的是**未提交的工作区代码**。⇒ **施工前必须重新取一次基线**，并先查清这 ~1 万行的差额是去重/对账口径变化还是真实丢失（见 §12.6）。本文其余数字都按 09:38 基线。

### 1.2 各路径实测（同一只读连接，84k 行）

| 路径 | 耗时 | 说明 |
| --- | --- | --- |
| `COUNT(*)` | 3.3 ms | |
| `SUM(total/input/output)` 全量 | **28.1 ms** | 汇总类路径 |
| `GROUP BY day_key` | 36.5 ms | 时间轴 |
| `GROUP BY project` / `repository_key` | 3.9 / 3.9 ms | |
| `COUNT(DISTINCT session_id)` | 32.3 ms | `metadata()` |
| `SELECT DISTINCT channel, model` | 34.5 ms | `metadata()` |
| `GROUP BY channel, model, home_id` + `MAX(ts)` | 64.0 ms | 观测聚合 |
| 全行 `SELECT` 进 JS | **142.4 ms** | 明细路径（逐事件计价、冠军） |
| 内容指纹单遍（1,075 文件，首尾各 64 KiB） | **147 ms / 读 124 MB** | 见 §1.4 ③ |
| 汇总粒度 `day×home×channel×model×project×repo` | **336 行 / 37 天** | 见 §3.1 的完整键 |

### 1.3 一年后外推

按当前日均 2,271（第一稿按 3,300–4,600）：一年 83–170 万行，表 + 索引 0.6–1.3 GB。

| 路径 | 现在（84k 行） | 一年（1.5M 行，线性外推） |
| --- | --- | --- |
| 全量 `SUM` | 28 ms | ≈0.5 s |
| 按天分组 | 37 ms | ≈0.7 s |
| `metadata()` 三条聚合 | ≈130 ms | ≈2.3 s（每次数据变更后重算） |
| 全行读进 JS | 142 ms | **≈2.5 s + 1.5 GB 堆** |
| `buildRecordChampions()` | 未单测（含逐事件计价，高于 142 ms） | **数秒** |

### 1.4 归因结论（第二稿改写）

1. **存储不是问题**。C 盘剩 694 GB，一年 1.2–1.6 GB。
2. **WAL 是头号问题，且病因明确**：`wal_checkpoint(TRUNCATE)` 在任何读者持有快照时返回 `busy=1` 且**不收缩**（临时库实测：读者开着时 `{busy:1, log:5040, checkpointed:3}`、20.76 MB 不变；读者关闭后 `{busy:0, log:0}`、0 MB）。而执行器的 published reader 在 `store.sync()` **之前**打开、在 sync **之后**才关闭（`usage-executor.js:147-176`），sync 期间的所有写（`replaceFile`、codex 发布事务、轮末元数据）都落在该快照之后 ⇒ **checkpoint 从来没有成功过**。重启之所以"治好"它，只是新进程重建了 WAL 索引（临时库实测：1.24 GB WAL 首次 `open` + 全表 count 需 1,270 ms）。另外 `PRAGMA journal_size_limit` **不跨连接持久**（重开回到 `-1`，实测）⇒ 必须在 `open()` 里设。
3. **内容指纹是每轮固定成本，且被重复了 4 遍**：`roundStart`（`usage-core.js:2669`）+ codex `planStableCodexHome` 的前后两次（`:2418`/`:2441`）+ 轮末核对（`:2813`）。实测单遍 147 ms / 124 MB，4 遍 ≈ **589 ms / 495 MB 每轮**——自动刷新每 60 s 一轮，等于持续磁盘读。第一稿把它归为"冷启动第一大项"不准确：冷启动 5.3–9.4 s 里它只占约 10%，真正的首项是 `open()` 与逐文件全文读元数据（10-09 账本 §6.14：362 次 ≈1.45 s）。
4. **`buildRecordChampions()` 随历史线性增长**（`usage-store.js:5179`，只按 home 过滤，扫全历史并逐事件计价）。注意它的触发点不是"每次请求"，而是**每次数据修订变化后的第一个请求**（memo 键含 `storeRevision`，`usage-store.js:5148-5167`）＋冷启动；`preset=all` 时反而返回 `{}`（`:5435`）。
5. **库体积唯一直接伤害延迟的地方**是 `snapshot()` 的 `backup(database)` 整库复制（`usage-executor.js:208`，最多留 8 份）⇒ 冻结成本 O(库大小)。

## 2 三层划分

| 层 | 内容 | 是否可丢 | 查询角色 |
| --- | --- | --- | --- |
| 事实层 | `events` 明细、`perf_samples` | **否** | 下钻、重算、导出 |
| 汇总层 | `rollup_daily`、`session_days`、`project_paths` | 可（可从事实层重建） | 所有汇总类查询的唯一入口 |
| 卷宗层 | `usage-YYYY-NN.sqlite` + manifest | 否（属于事实层的搬家用形态） | 按需只读挂载 |

一句话：**汇总层压缩"查询面"，卷宗压缩"主库的驻留体积"，事实一行不少。**

## 3 汇总层

### 3.1 粒度

`rollup_daily` 主键：`(day_key, home_id, home_label, channel, source_kind, model, project, repository_key, service_tier, context_level, price_band, detail_mask)`

实测（本机 37 天、84k 行）：

| 键 | 行数 |
| --- | --- |
| `day×home×channel×model×project×repo` | 336 |
| `+ service_tier` | 336（本机只有 standard / unknown 两值，且与其它维不交叉） |
| `+ context_level` | 366 |
| `+ home_label` | 366 |
| `+ price_version`（**不进键**，仅作对照） | 403 |

按 366–450 行 / 37 天外推，一年 **4,000–5,000 行**（< 2 MB）。

每一维的理由：

- `home_label` **必须进键**：`groupedRange("home_label")`（`usage-store.js:5557`）是明细视图的一个分组列。
- `source_kind` **必须进键**：非配额范围的 `groupedRange("channel")` 分组表达式是 `usage_source_group(channel, source_files.kind)`（`usage-store.js:4864`）。只存原始 channel 会把 Codex 的多个 channel 合并错。
- `context_level` **必须进键**：`contextTierFor()`（`pricing.js:1172`）按上下文档位选费率，日粒度的 token 之和无法反推费用。
- `price_band` **必须进键**：`pricing.js:227` 的 `offPeakMultiplier: 0.5` + `peakWindows`。内置峰谷价目只有 DeepSeek 系列，行数放大有限，但正确性上不可省。
- `repository_key` **必须进键**：实测与 `project` 几乎一一对应（48 个 project / 41 个 repo，0 个 project 跨 repo、5 个 repo 跨 project），零额外行数；不进则仓库维度只能退回明细。
- `detail_mask` **必须进键**（第一稿遗漏）：它不是可加数值，而是逐事件的位掩码。`periodAggregate` 用 18 个 `CASE WHEN (detail_mask & N)` 派生列（`usage-store.js:4992-5008`）。汇总表必须把**每个 CASE 的结果**预派生为独立列（`input_known`、`cached_known`、`output_known`、`reasoning_known`、`unattributed_detail_tokens`、`inconsistent_tokens`、`reconciliation_gap` 等），**绝不能存一个 SUM 后的 mask**。这是 H1 最容易埋雷的地方。

数值列与 `usageFromRow()` / `aggregateRange()` / `createCostSummaryState()` 的读取集合逐列对齐：`event_count`、`total`、`input`、`cached`、`output`、`reasoning`、`cache_write_tokens`、`cache_write_known`、上述派生列。**漏一列就是静默差异**，由 parity 测试兜底。

### 3.2 两个不可加指标

| 指标 | 现状 | 处置 |
| --- | --- | --- |
| `session_count` | `COUNT(DISTINCT session_id)`（`usage-store.js:4835`） | 新增 `session_days(session_id, day_key, home_id, ...)`，**一行一个"会话×日"**。实测 1,095 行（964 个会话 / 37 天）。区间内 `COUNT(DISTINCT session_id)` 由此精确。第一稿的 `session_dims`（一行一个"会话×维度组合"+ first/last day）**只能回答"是否相交"**，跨边界的会话会被多算，不可用 |
| `path_count` | `COUNT(DISTINCT NULLIF(cwd,''))`（`usage-store.js:4960`） | 新增 `project_paths(project, cwd, repository_kind)`，实测 48 个项目 / 48 个 cwd。否则周期对比的"路径数"会因跨日重复而虚高 |

`home_count` 不用单独处理：`home_id` 在主键里，`COUNT(DISTINCT home_id)` 天然精确。

`repositoriesRange` 的 `json_group_array(DISTINCT session_id)`（`usage-store.js:4963`）**不进汇总层**——它只服务明细视图，保留读 `events`。

### 3.3 维护时机

**轮末按"受影响日"重算，不在 `replaceFile` 事务内增量维护。**

- 受影响日 = 本轮所有被重解析文件的 `[MIN(day_key), MAX(day_key)]` 并集；对每个日执行 `DELETE FROM rollup_daily WHERE day_key = ?` + `INSERT … SELECT … GROUP BY … FROM events WHERE day_key = ?`。
- 幂等、可中断、可全量重建；不需要触发器，不需要在写事务里加第二条写路径。
- 代价：一个三年前的老会话追加一行会触发重算它覆盖的全部日。但这本来就要重扫该文件全部事件，量级同阶，可接受。
- 冷启动**不做**全量重算；只在 `rollup_version` 落后时做一次（一次性成本，按 84k 行 28 ms 量级估算）。

### 3.4 读路径改造点

先分清热路径：UI 走 `/api/usage?view=dashboard`，服务端对这条路径传 `includeDetails: false`（`server.js:788`）⇒ `summary.homes` / `projects` / `repositories` **不在默认请求里**（`usage-store.js:5556`）。因此优先级按"每请求 / 每次修订 / 仅明细"三档排：

| 现调用 | 触发频率 | 改法 |
| --- | --- | --- |
| `aggregateRange` / 上一期聚合 | 每请求 | 改读 `rollup_daily`（`session_count` 走 `session_days`） |
| `timelineRange` | 每请求 | 改读 `rollup_daily`，按 `day_key` 分桶；周/月桶由日桶在内存里再聚合。**`bucket === "hour"` 必须保留明细路径**（`groupedRange` 的 `hour_key` 同理，`usage-store.js:4854`），日汇总无法重建小时桶 |
| `buildRecordChampions` | **每次修订后的首个请求** + 冷启动 | 改读 `rollup_daily`（日/周/月三种槽位都由日桶推出）。这是本计划最大的单点收益 |
| `groupedRange("channel"/"model")` | 每请求 | 改读 `rollup_daily`；channel 用预存的 `source_kind` 复现 `usage_source_group` |
| `metadata()` 的三条全表聚合 | 每次修订后一次 | `COUNT(DISTINCT session_id)` 走 `session_days`；`SELECT DISTINCT channel, model` 走 `rollup_daily`；`GROUP BY channel,model,home_id` + `MAX(ts)` 走 `rollup_daily` 的 `MAX(day)` 近似或单独小表 |
| `periodAggregate` | 每请求（dashboard 内） | 四个周期各按日区间求和 `rollup_daily` |
| `repositoriesRange` | 仅明细视图 | **不动**（含 `session_ids`，无法从汇总重建） |
| `costEstimateRange` / `costEventsForRange` | 每请求 / 明细 | 明细路径保留；汇总路径按 `price_band` + `context_level` + `detail_mask` 分组后套价目 |

`recordsForRange` 对 `preset=all` 本来就返回 `{}`（`usage-store.js:5435`），无需处理。

**费用口径的非线性**：`estimateEventCost` 需要逐事件的 `detail_mask`、`cache_write_tokens`、`request_input_tokens`、`service_tier`、`context_level` 与时间戳。汇总行能复现费用的前提是这些维**都在键里**（本稿已满足），且价目目录未变。若 H1 的 parity 在"成本冠军"上过不去，允许分两步：H2 先只把 **token 类冠军**切到汇总，成本类冠军暂留明细，等 parity 证明后再切。

### 3.5 版本与重建

- `rollup_daily.rollup_version` 单列。价目口径、去重规则、`price_band` 判定、`contextTierFor` 任一变更 ⇒ 抬版本 ⇒ 后台按日重建，不阻塞读。
- 重建必须能"从零开始"：删除全部汇总行 → 按日重算。这是验收项，不是可选项。
- 汇总行**不随卷宗删除**。卷宗搬走的是明细，汇总永久留在主库（一年 5,000 行，十年 5 万行，全扫 < 50 ms）。

### 3.6 不建周/月表

周/月/年桶一律由日桶在内存里聚合：十年 3,650 行，扫一遍 < 1 ms。多建表只增加维护面与不一致面。

## 4 卷宗

### 4.1 形态

```
~/.codex-usage/archive/
  usage-2025-01.sqlite     # events + perf_samples + rollup_daily（副本）+ manifest
  usage-2025-01.manifest.json
```

命名带序号：按 §1.3 的外推，40 万行阈值一年会切 **3–4 段**（§4.6），单一年份名装不下。

manifest 字段：`schema_version`、`rollup_version`、`min_ts`/`max_ts`、`min_day`/`max_day`、`event_count`、`sample_count`、`byte_size`、`sha256`、`source_homes[]`、`sealed_at`、`created_by_version`。

卷宗自带汇总副本是冗余的（主库已有），但**保留它让卷宗自包含**：单独拷走也能打开、能校验、能被另一个实例直接登记。

⚠️ **卷宗内的 `events` 表不能照抄主库 DDL**：主库的 `source_path` 是 `REFERENCES source_files(path) ON DELETE CASCADE`（`usage-store.js:2048`），卷宗里没有 `source_files`。卷宗建表时把该列降级为普通 `TEXT`（保留列名，便于导出/导入对拍）。

### 4.2 封存流程（顺序是硬约束）

1. 选边界日 `D`（本地日界，与 `day_key` 一致），确认 `max_day < D` 的全部明细都在范围内；
2. 在执行器内 `ATTACH DATABASE '<seg>' AS seg`，建表后 `INSERT … SELECT` 写出卷宗。**不能用 `VACUUM INTO`**：临时库实测 `cannot VACUUM from within a transaction`；而 `ATTACH` 在事务内是允许的（实测）。注意 attached 库的 `journal_mode` 是 `delete`（实测），所以卷宗天然不带 `-wal/-shm`，这正是想要的形态；
3. 校验：行数、`MIN/MAX`、`SUM(total)` 与主库逐项相等；写 manifest 与 sha256；
4. **校验通过后**才 `DELETE FROM events WHERE day_key < D`；
5. 登记 `archive_segments` 一行，`COMMIT`。

第 2 步与第 4 步之间**不要**把主库的写事务一直开着：`INSERT … SELECT` 可能持续数分钟，期间任何读请求都会被拖住。建议写成"写卷宗（独立连接/独立事务）→ 校验 → 开主库短事务删除 → 登记"。

任何一步失败：最多留下"卷宗已写、主库未删"的重复状态，重跑幂等。**反过来做就是数据没了**，不接受。

### 4.3 查询与挂载

- 汇总类查询完全不碰卷宗（§3.5）。
- 下钻到封存区间：用**独立的只读连接**（`new DatabaseSync(segPath, { readOnly: true })`）打开卷宗，用完即关。
  **不能**在主库连接上 `ATTACH` + `PRAGMA seg.query_only = 1`：临时库实测该 PRAGMA 是**连接级**的，设上之后**主库也变成只读**（写主库直接 `attempt to write a readonly database`），与"封存期间继续 sync"直接冲突。
- 挂载失败（文件被移走/校验和不符）⇒ 返回明确的"该段不可用"状态，**不回退成空数据**。

### 4.4 导出 / 导入

- 导出：`usage export --since 2025-01-01 --out ./backup/`，产出卷宗 + manifest；也可 `--format jsonl` 供人读，但**可重放的载体是卷宗**。
- 导入：`usage import ./usage-2025-01.sqlite`，校验 sha256 与 manifest 后登记，不重解析任何 agent 日志。
- 导出的卷宗不依赖 `source_files`，换机器、换版本都能读（受 `schema_version` 守卫）。

### 4.5 与 `source_files` 的关系

`events.source_path` 外键 `ON DELETE CASCADE`（`usage-store.js:2052`）。明细搬进卷宗后，源文件消失不再影响它——**这顺带解决了[评估稿](2026-10-21-workbuddy-source-plan.md) §3.1 的跨来源问题**（Claude/DSH 卸载即丢历史），且不需要给每个来源单独加 Codex 那种豁免。

**但封存与 `replaceFile` 的冲突必须先定规则**：`replaceFile` 是整文件 `DELETE FROM events WHERE source_path = ?` + 重插（`usage-store.js:3138`），一个跨年会话会同时含封存期与热区事件。§8 不变量 4 的"按 day_key 守卫"只有两种实现：
- **拒收整文件**（封存期有事件就跳过重解析）⇒ 该会话的热区新增也停止更新；
- **只重插热区事件**（封存期事件丢弃）⇒ 封存期数据与源文件不再一致。

两种都有代价，属于产品语义，施工前必须拍板（§12.2）。

### 4.6 阈值与段大小

- 触发：`event_count ≥ 400,000` **且** `最老数据 ≥ 180 天`。
- 按 §1.3 外推（一年 83–170 万行），40 万行阈值意味着**一年 2–4 段**，不是一年一段。界面与命名必须按"多段"设计（§7）。
- 边界对齐 `day_key`，保证段之间**无缝无叠**（§8 不变量 1）。

### 4.7 `perf_samples` 与 TPS

- 样本随卷宗走（本机 41,496 行；按一年外推约 39 万行 / 280 MB）。
- **分位数不可加**：TPS 的 p50/p90 不能由日汇总推出。一期方案：TPS 查"全部"时按需挂载各段；二期可选"日级直方图"（20 个对数桶/日/来源）使跨段合并成为可能。二期不在本计划承诺范围内。
- 注意 `perf_samples.source_path` 同样有指向 `source_files` 的外键（`usage-store.js:204`），卷宗内同样要降级为普通列。

## 5 内容指纹：撤回 sealed 方案，改为单轮内去重

### 5.1 为什么撤回第一稿的 `sealed_at`

第一稿的规则是"`mtime` 早于 now−7d 且 `size` 未变 ⇒ 不再读内容"。它**与仓库既有的 B7 防御正面冲突**：

- `perf-state.test.js:1452`「指纹必须含内容摘要」与 `perf-codex-index.test.js:3435`「同尺寸 + 同 mtime 的原地改写必须重新读取」两处测试钉住的正是"`size`+`mtime` 不足以判定未变"；
- `usage-store.js:3985` 的预扫与 `:4054-4055` 的循环内判据都写明："同尺寸原地改写并把 mtime 钉成同一整毫秒 ⇒ 两个分量完全相同，但内容已变"。

这两条测试用的是**新写入的文件**（mtime = now），所以"7 天"门槛能让它们继续绿——但那只是绕过了测试，没有绕过风险：`cp -p` 恢复、备份还原、某些同步工具都会产生"旧 mtime + 新内容"。**用测试的可观测窗口去定义一个正确性边界，不可接受。**

### 5.2 真正的成本在"重复"，不在"读取"

实测：单遍内容指纹 1,075 个文件 **147 ms / 读 124 MB**；而每轮做了 **4 遍**（`usage-core.js:2669`、`:2418`、`:2441`、`:2813`）⇒ **589 ms / 495 MB 每轮**。自动刷新每 60 s 一轮，等于持续磁盘读。

⇒ 规则改为：**同一轮内，同一物理文件的指纹只算一次**。

- 键 = 规范物理路径（已有 `canonicalPerfProbePath`，`usage-store.js:967`）+ `size` + `mtimeMs` + `-wal` 的 `size/mtime`；
- 复用范围**严格限定在同一轮**：跨轮不复用（跨轮复用等价于第一稿的 sealed，会重开 B7 的洞）；
- 失效条件不变：`size`/`mtime` 任一变化 ⇒ 重算；读取期间变化 ⇒ 本轮标记 `LIVE_SOURCE_CHANGED`（既有语义不动）；
- 预期收益：589 ms → ~150–200 ms/轮，**零正确性代价**。这同时兑现了 10-09 计划评审里"把单轮内复用内容探针结果从 P4 提前到 P1"的建议。

### 5.3 冷启动的真正大头

按 10-09 账本 §6.14，冷启动的 1.4 s 增量是**逐文件全文读元数据 362 次**（`readCodexRolloutMetadata`），不是指纹。持久投影缓存（`perf_codex_projections`，89.6 MB）已存在（T2），但 `new UsageStore()` 未注入时每轮从头算。**这是独立于本计划的既有问题**，不在 H1–H6 范围内，只在此登记。

## 6 冷启动预算

现状（见[刷新性能账本](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/README.md)）：已有库首次打开 **5,353–9,396 ms**；V2 记 7,081–7,086 ms。

| 分项 | 现状 | P0–P3 后目标 |
| --- | --- | --- |
| WAL 恢复 / 打开 | 8 GB 量级，首次打开实测 1.24 GB WAL ≈ 1.27 s | < 300 ms（WAL 收敛到 < 100 MB） |
| 文件发现 + 指纹 | 4 遍 ≈ 589 ms/轮 | < 250 ms（单轮去重后 1–2 遍） |
| 规划 / 投影 | 有持久化投影缓存 | 不变 |
| 首屏读路径 | 30 天范围，有界 | 不变（改读汇总后更小） |
| **合计目标** | 5.3–9.4 s | **< 2.5 s**（不含 §5.3 的全文读元数据，该项不在本计划内） |

明确不做：按需延迟建索引。重建索引比读慢，且会让首屏出现"数据在长出来"的观感。

## 7 界面：把边界画成一条归档带

- 时间轴在封存边界前显示一条合并带："2025 归档 · 120 万次请求"，数值来自汇总层，鼠标悬停给年度总量。
- **多段**：按 §4.6，一年可能产生 3–4 段。默认把相邻段合并成一条带（显示年份），点开后再按段展开；段不可用时只标该段。
- 点开归档带 ⇒ 用独立只读连接挂载对应卷宗，时间轴展开为按日，明细列表可用。
- 默认口径不变（today / week / month / 30d 仍是默认），"全部"仍是显式选择。
- 段不可用时显示"该年度归档不可用（文件缺失）"，不静默变成 0。
- i18n 需要 `HARNESS` 之外的一套"归档"文案键。

## 8 不变量与风险

| # | 不变量 | 检验方式 |
| --- | --- | --- |
| 1 | 段边界无缝无叠：`seg[i].max_day + 1 == seg[i+1].min_day`，且并集 == `events` 曾覆盖的全部 `day_key` | 封存前后 `day_key` 集合逐项比对 |
| 2 | 汇总可重建：删空 `rollup_daily` 后全量重建，与重建前逐行相等 | parity 测试（构造夹具，非本机库） |
| 3 | 明细与汇总一致：任取区间，`SUM(rollup)` == `SUM(events)` 逐列相等 | 随机区间抽样 20 组 |
| 4 | 已封存窗口不接受热区写入 | 规则待定（§4.5）；测试用"封存后再解析同一源文件" |
| 5 | 封存失败不丢数据 | 注入第 4 步失败，断言明细仍在、卷宗可重跑 |
| 6 | 跨来源卸载不影响卷宗 | 删除源目录后重开，卷宗仍可挂载 |
| 7 | 卷宗不可写 | 独立只读连接（`readOnly: true`）；写尝试必须抛错。**不要**用 `PRAGMA seg.query_only`（连接级，会把主库也锁成只读） |

风险：

| 风险 | 处置 |
| --- | --- |
| 迁移版本冲突 | **当前 `STORE_SCHEMA_VERSION = 17`**（WorkBuddy v17 已落地，`usage-store.js:61`），历史保留取 **18**；WorkBuddy 实施计划里"16 → 17"的描述已过时，需同步更正 |
| `CREATE TABLE IF NOT EXISTS` 静默接受错形状旧表 | 沿用 v12 起的"事务内 `PRAGMA table_info` 自检"，不符即 `ROLLBACK` |
| WAL checkpoint 被并发读阻塞 | 只在 `publishedStore.close()` **之后**执行；记录返回的 `busy/log/checkpointed`；`busy=1` 时不重试、只告警 |
| 首次 `TRUNCATE` 很慢 | 8 GB 需拷回主库（分钟级）。放到 `open()` 后的首个空闲点，一次性完成并记日志 |
| 归档与 sync 并发 | 封存只在执行器内、单写者；卷宗写入用独立连接，主库删除用短事务 |
| 汇总与明细口径漂移 | `rollup_version` + parity 测试；口径变更必须抬版本并重建 |
| `price_band` 判定与 `pricing.js` 的 `peakWindows` 漂移 | 复用 `pricing.js` 的判定函数，不复制时段表 |
| **基线漂移** | 09:00 的 291 文件重索引让事件总数从 93,977 掉到 84,029（§1.1）。**施工前必须重取基线并查明原因**，否则所有 parity 与性能对比都建立在移动的地基上 |

## 9 施工拆卡

| 卡 | 依赖 | 范围 | 验收 | 规模 |
| --- | --- | --- | --- | --- |
| H0 | — | WAL 止血：`open()` 里设 `journal_size_limit`；`publishedStore.close()` 之后 `wal_checkpoint(TRUNCATE)`；记录 `busy/log/checkpointed` | 稳态 WAL < 100 MB；重启后 30 分钟内不再单调增长；崩溃恢复可测 | 1–2 处改动 + 日志 |
| H1 | H0 | `rollup_daily` / `session_days` / `project_paths` + 迁移 v18 + 全量回填 + `rollup_version` | parity：重建前后逐行相等；回填耗时如实记录 | 500–600 行 |
| H2 | H1 | 读路径切换（§3.4 的六处），`hour` 桶与 `repositoriesRange` 不动 | 同一夹具下，切换前后汇总载荷逐字相等 | 350–450 行 |
| H3 | H0 | 单轮内指纹去重（§5.2） | 每轮真实内容读取次数 ≤ 文件数；B7/C3 两处测试保持绿；冷启动前后对比 | 150–250 行 |
| H4 | H1、H2 | 卷宗封存（ATTACH 写段）+ `archive_segments` + 独立只读连接挂载 | §8 不变量 1/4/5/6/7 | 450–550 行 |
| H5 | H4 | `export` / `import` CLI + manifest 校验 | 导出→换目录→导入→查询结果一致 | 200–300 行 |
| H6 | H4 | 界面归档带（多段）+ 下钻 + 不可用态 | 浏览器实测三态（正常/不可用/展开） | 150–250 行 |

H0 与 H3 是**当下**的收益（WAL 停止增长、每轮少读 370 MB）；H1–H2 是"全部"与冠军从 O(全部行数) 降到 O(日数)；H4–H5 兑现"不丢 + 可转移"；H6 兑现"成为象征"。

**顺序建议**：H0 → H3 → H1 → H2 → H4 → H5 → H6。H0 与 H3 互不依赖，可并行；H1 的 parity 夹具应在 H2 之前写完。

## 10 验收标准

- `events` 行数不变的前提下，`buildRecordChampions` 与 `timelineRange` 的 SQL 不再扫 `events`（可用 `EXPLAIN QUERY PLAN` + 语句计数断言）。
- 同一冻结夹具，H2 前后 `/api/usage` 汇总载荷逐字相等。
- 删空汇总表后全量重建，逐行相等；`rollup_version` 落后时自动重建一次。
- 封存后：主库 `events` 只剩热区，卷宗可单独打开且校验通过，`day_key` 并集不变。
- 封存后重解析同一源文件，总量不翻倍（不变量 4，规则待定）。
- 卷宗缺失时界面显示"不可用"，不显示 0。
- 冷启动（已有库）< 2.5 s，稳态 WAL < 100 MB。
- **WAL 回归**：连续 3 轮有写入的 sync 之后，WAL 不得单调增长（每轮记录 `PRAGMA wal_checkpoint` 返回值）。

## 11 工作量

编码约 **8–11 个工作日**（H1–H2 占一半以上），真机验收 2 天。难度：H0 2/5（机制已明确，但要处理首次 TRUNCATE 的分钟级耗时）、H1 3/5（18 个派生列与 11 维键容易漏）、H2 3/5、H3 2/5、H4 4/5（顺序、幂等、外键、连接隔离）、H5 2/5、H6 2/5。

第一稿的 3–4 天偏乐观：它按"5 处读路径、9 列数值"估算，实际是 6 处读路径、18 个派生列、11 维键、2 张去重表。

## 12 待验证 / 开放问题

1. 明细保留期取多少：本稿按"封存后主库只留最近段"设计，未定具体天数（90 / 180）。取决于用户是否常看三个月前的会话明细。
2. **封存与 `replaceFile` 的冲突规则**（§4.5）：拒收整文件，还是只重插热区事件？这是产品语义，施工前必须拍板。
3. 价目重算的边界：卷宗可挂载重算，但"一次重算全部历史"的成本未测。
4. `peak` 判定在节假日的行为（`pricing.js` 明说"无法识别的节假日按高峰计"）会写进 `price_band`，跨版本变更需抬 `rollup_version`。
5. `perf_samples` 二期直方图是否值得做，取决于 TPS 视图是否会选"全部"。
6. **事件基线漂移**：08:2x 的 93,977 行 vs 09:38 的 84,029 行，差额集中在 10-18（峰值日从 10,726 变为 6,319）。09:00 有 291 个 main 文件被重索引，且当前服务运行的是未提交的工作区代码。需确认是去重/对账口径变化还是真实丢失——**这直接关系"事实层永不删"这一前提是否已经成立**。
7. 归档后 `VACUUM` 才真正有意义（此时 `freelist` 会大幅增长）；顺序必须 checkpoint → VACUUM，且只在封存后做一次。

2026-10-26最新收口：用户明确性能数字本质为估计参考，不必严格匹配，剩余优化交其他计划。本轮已完成容量验证与逐项目标差距交接（20/20），最终源码工程门禁也已通过；不再追加性能实验。下文旧数值/20×20要求保留原修订时点，当前完成条件以Implementation Plan §0/§6.5/§7为准，未测p95不冒称通过。
