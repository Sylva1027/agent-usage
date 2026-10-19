# 看板刷新性能 Implementation Plan

日期：2026-10-09（Asia/Shanghai）。状态：**施工计划已成文；任务均未派发，产品修复和新版本验收尚未执行。**

本文件把[修复方案与验收规格](2026-10-09-dashboard-refresh-performance-plan.md)拆为 **28 个基础单元、5 个条件单元**，供主线审查者协调并发 subagent。规格定义行为与性能目标，本文定义派工、文件归属、单元验收和进度；**只有本文任务表维护施工状态**。本文卡号与规格的 P0–P6 阶段号分开：R 为计价，S/C 为同步，D 为读路径，Q 为响应，U 为客户端。诊断和复核是参考材料，不是额外施工授权。本轮只交付计划，后续启动实施时再派发 worker。

## 1. 最小协作方式

采用 **1 名主线审查者 + 最多 3 名 worker**，使用当前任务的 subagent 和消息能力。主审负责派工、文件锁、审查、条件决策和最终集成；worker 一次只接一张卡。无需新增调度器、agent 配置、自动化、项目看板或通用任务框架。

正常使用当前工作区，按文件分工。确有隔离需要时才用独立工作树；工作树不消除接口冲突和合入审查。当前有大量 tracked/untracked 未提交工作，禁止 reset/clean、覆盖式还原或为本轮捆绑提交其它工作。

### 每个单元的闭环

1. **主审派发**：给出卡号、已通过的前置证据、允许修改的文件、开始摘要、验收项和本轮耗时预算。依赖未通过，不派发实现。
2. **worker 实施**：先读相关调用链和既有实现，复用现有 helper/fixture；完成一项可观察行为及其最小有效检查，不顺手扩范围。
3. **worker 交审**：保存本卡差异、定向测试、行为/计数证据和未测项，状态改为 `REVIEW`，主动向主审发送完成报告。**写完代码或测试退出 0 都不等于完成。**
4. **主审确认质量**：检查实际差异和证据，在受测版本上复跑一个关键行为或关键反例；核对接口、性能和相邻路径。给出 `ACCEPTED` 或具体 `REWORK`。
5. **及时返工**：`REWORK` 必须包含复现方式、实际/预期和受影响验收项。原 worker 在同一卡内修复并重新交审，主审复验后才能通过；不能先开下一张依赖卡，把缺陷留到最终验收。
6. **释放与交接**：主审记录接受的文件摘要/证据、释放文件锁，再派下一卡。后续代码改变已接受的关键行为时，重开受影响卡并做定向复验。

worker 交审后停止修改本卡产物，等待明确回复；等待期间可阅读下一卡材料，但不开始新的产品变更。独立 worker 可以继续已获授权的卡。worker 在自己的 handoff 更新交接状态，由主审更新唯一任务表。主审通常在一个 10–15 分钟审查窗口内回应；复杂行为可延长审查，不能为保持并发而降低标准。

### 防止长尾

- 卡片的预计时间包括阅读、实现、自测和交接，多数为 30–120 分钟，**不包含主审等待**。预计值不是通过期限。
- 30 分钟仍无法定位接入点、发现跨文件归属冲突，或新增 schema/执行器需求时，立即汇报；90 分钟没有可运行证据时交一个诊断检查点。
- 预计超过 2 小时，主审先把剩余工作拆为可独立验收的 `原卡号-a/b` 并补入任务表，再继续；不允许以“整个 P2/P3”为一个 worker 单元。原卡保留为验收汇总，全部子卡通过后才释放其依赖，拆卡本身不算完成。纯计时运行可以异步等待，不能把无人值守采样算成复杂实现。
- 拆卡按行为边界：例如“坏内容保持隔离”与“修复后恢复”，或“执行器同步完成”与“冻结/崩溃恢复”。不提交不能运行的空接口或半套框架充数。
- 同一问题返工两次仍未收敛，主审一起定位最小反例或调整卡片边界；不反复让 worker 盲修，也不以此直接放弃性能目标。

## 2. 并发边界与启动顺序

### 文件归属

| 文件组 | 默认写入者 | 并发规则 |
| --- | --- | --- |
| `src/usage-store.js`、`test/usage-store.test.js`、`test/perf-store.test.js` | 后端主线 worker | 整文件单写者，S/C/D/Q/T/W 卡串行移交；不同函数也不能同时写 |
| `src/usage-core.js`、`src/perf-sources/codex-thread.js`、必要时 `codex-jsonl.js`，Codex/state 测试 | 同一后端 worker | 和 store 卡共同持锁，保留原有规划/解析语义 |
| `src/pricing.js`、`public/pricing-models.js`、计价测试 | 计价 worker | R1→R2 串行；与 store、UI 卡可并行 |
| `public/i18n.js`、`public/perf-ui.js`、`public/app.js`及相应 UI 测试 | 客户端 worker | U1→U2→U3→U4 串行；与计价、后端卡可并行 |
| `src/server.js`、`test/server.test.js`、`test/perf-server.test.js` | 主审指定的后端 worker | 按实际卡临时持锁；D1/Q/W/V 中不得同时写 |
| 验证脚本、隔离输入与本卡证据目录 | 测量 worker / 当前卡 worker | 独立目录；固定数据禁止别人改，重型基准一次只跑一份 |
| 本计划任务表、文档入口、最终报告 | 主审 | worker 只写自己的 handoff，不争写总状态 |

测试文件也按整文件锁管理。卡片列出的文件是**允许范围**，无需每张卡都修改全部文件；超出范围须先向主审说明具体原因，再移交锁。主审用任务表中的 worker/状态记录归属即可，不另造锁管理服务。

### 可实际运行的并发排程

| 波次 | 后端 worker | 第二 worker | 第三 worker | 主审门禁 |
| --- | --- | --- | --- | --- |
| 0 | H0 独立索引热修 | 阅读计价调用链 | 阅读客户端与现有探针 | H0 最小恢复点、索引和结果等价 |
| 1 | 等待/协助只读取样 | B1 完整还原点、固定输入 | B2 复用探针与计数 | B1 取样时短暂冻结产品写入；B2 只写诊断文件 |
| 2 | 等待基线 | B3 原版/H0 版基线 | 阅读 U1 接入点 | `G_BASE`：H0、B1、B2、B3 全部通过 |
| 3 | S1→S2 | R1→R2 | U1→U2→U3 | 每卡独立审查；R2/S2 通过后才进入 C1 |
| 4 | C1→C5 | 按已接受快照记录阶段 A/B | 完成 UI，随后接 C6 容量测量 | `G_CAP`：C6 通过，且容量分支已处理 |
| 5 | D1→D5 | 复核计价失效与等价性 | D4 通过后执行 U4 | store 单写者；价目/读侧接口按实际接受版本 |
| 6 | Q1→Q2，必要时 W1→W3 | 只读核对既有证据 | 客户端定向复测 | `G_RESP`：响应门槛通过，执行器分支已处理 |
| 7 | V1 正确性矩阵 | 等待/独立只读审查 | 等待/独立只读审查 | V1 通过再跑 V2；V3 最终集成版本收口 |

只有有用且独立的任务才占 worker，不追求三个槽位始终满载。测量必须从**已接受的文件快照**启动独立隔离实例；不能在别人正在改的工作目录中做 A/B。每卡差异相对派工时保存的文件内容生成，不能拿整个 dirty 工作区相对 HEAD 的 diff 冒充本卡变更。累加 A/B 在隔离副本按“原版→索引→formatter→模型索引→解码映射→探针去重”组合已接受差异，即使这些卡在主工作区并发完成，也保留各项单独收益。需要端到端计时的窗口暂停其它重型测试，计时完成再恢复并行。

定向交审检查也不能依赖另一个 worker 尚未审完的改动：用 B1 还原点叠加已接受差异和本卡差异，在临时副本运行；能确认相关导入文件全部稳定时，可在工作区直接运行并记录摘要。只保存必要摘要/差异/日志，不为每卡重复归档整套原始数据或长期保留一套工作树。

后端最长路径为 `S1→S2→C1…C5→容量门禁→D1…D5→Q1→Q2→响应门禁`。它受共享文件和正确性依赖约束，不靠多派 store 写入者缩短；通过小卡、早期容量验证和即时审查减少返工长尾。

## 3. 共同契约与审查标准

完整约束和绝对性能目标沿用[规格 §2](2026-10-09-dashboard-refresh-performance-plan.md#2-范围正确性约束与完成标准)，不在每卡复制或调低。主审派发前核对当前源码；本计划的函数名是接入点，行号和旧测量不作为永久依据。

- **结果**：费用、用量、历史新高、告警、TPS 分组/覆盖率、全局 home、quota 时钟和冻结结果保持契约。不能以缩短历史范围、取消告警或漏字段换速度。
- **同步**：保留 `syncPromise` 合并；手动刷新检查来源。`skipCheck` 无同步和等待已有同步分别测量，不能把后者算进 500 毫秒无等待目标。
- **稳定窗口**：读取前、读取后、发布前独立验证，同一窗口内才可复用同一物理文件摘要；保留同尺寸/mtime 改写和 WAL 检测。
- **缓存**：稳定尝试与已发布版本分开；缓存投影只读；自身成功提交推进实例修订，外部连接用同一连接的 `data_version` 变化检测；回滚、实例关闭和价目更换有明确失效路径。
- **事务**：共享 SQLite 连接的事务内不得插入 `await`。执行器使用私有连接；候选发布、读侧状态与冻结一致性不可拆成可见中间态。
- **计时**：固定隔离来源、固定正确性时刻/价目；冷态与暖态分开；暖态 2 轮预热后至少 20 个保留样本。完整响应、探针字节和实际解析次数都记录，阶段包含关系不重复相加。
- **最小实现**：先复用 `UsageStore`、既有 parser/planner、metadata/period 缓存和 fixture；首发单条 memo 或简单有界缓存。无新生产依赖、通用缓存框架、HTTP 整包缓存、虚拟滚动或 UI 改版。

主审对每卡核对：范围内最小差异、成功行为、关键失败/边界行为、命令退出码、计数/耗时口径、接受版本摘要。没有改逻辑的纯取样卡验证可复跑性；简单 formatter/索引不另造测试框架，复用现有检查即可。新分支/缓存失效必须留下一个能在行为退化时失败的有效回归。

业务或稳定性失败直接返工。未达阶段预算必须定位并在当前阶段补卡处理，不能带着未解决的必测缺口进入下一门禁。条件优化确实不需要时，主审用实测证据标为 `NOT_REQUIRED`，不能由 worker 自行跳过。

## 4. 任务与唯一进度表

状态：`TODO → IN_PROGRESS → REVIEW → ACCEPTED`；返工为 `REWORK → REVIEW`。依赖/环境阻塞为 `BLOCKED`，必须写恢复条件；条件卡初始 `DORMANT`，主审依据实测转 `TODO` 或 `NOT_REQUIRED`。只有主审能标记 `ACCEPTED/NOT_REQUIRED`，其余状态不能释放依赖。

`G_BASE`、`G_CAP`、`G_RESP` 是三个审查结论，不是额外实现模块。`G_CAP` = C6 接受且 T1/T2 接受或明确不需要；`G_RESP` = Q2 接受且 W1–W3 接受或明确不需要。

C6 是容量测量单元，Q2 是有限调度改动与路线裁定单元；可信测量发现阶段目标未达时，可以接受该单元的证据并启动条件卡，**不能因此释放阶段门禁**。例如 C6 发现 4× 淘汰，则 T1/T2 必须收口后 D1 才能开始；Q2 发现摘要事务仍阻塞，则 W 分支完成并复验后 V1 才能开始。代码错误或证据不可信仍直接 `REWORK`。

| 卡号 | 单元 | 必须通过的前置 | 预计工作 | worker | 状态 / 证据 |
| --- | --- | --- | --- | --- | --- |
| H0 | 兼容索引热修 | 最小还原点（本卡内） | 15–30 分钟 | h0-index（subagent） | **ACCEPTED** · 主审复跑 9/9 + 3785.963→20.235 ms + 结果集等价（+1 行，版本仍 13） · 证据：[H0.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/H0.md) |
| B1 | 完整还原点与隔离输入 | H0 | 60–90 分钟 | b1-baseline（subagent） | **ACCEPTED** · 主审抽查恢复文件 + 亲自重启隔离副本（4/4 来源在隔离内、真实库与价目未变）；两点边界已裁定 · 证据：[B1.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/B1.md) |
| B2 | 最小测量脚本与计数口径 | H0 | 60–90 分钟 | b2-measure（subagent） | **ACCEPTED** · 主审复跑 verify-b2 四阶段 PASS + append-check 36 项 PASS + 手算复核；真实输入冒烟转 B3 · 证据：[B2.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/B2.md) |
| B3 | 原版/H0 基线和阶段预算 | B1、B2 | 60–90 分钟 | b3-baseline（subagent） | **ACCEPTED** · `G_BASE` 成立 · 主审自行跨臂比对 119 个响应文件（产品差异 0，仅白名单 `snapshotId`）+ 端到端样本 + 阶段包含关系复核；P2 现状全未达标（C 卡靶子）· 证据：[B3.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/B3.md) |
| R1 | 峰谷 formatter 复用 | G_BASE | 30–60 分钟 | r1-pricing（subagent） | **ACCEPTED** · 主审复跑 `probe/r1-probe.mjs` **PASS 21/21**（场景 A 224 事件：构造 **224 → 1**，`formatToParts` **224/224 不变** ⇒ 只省构造段、**不宣称整体提速**；判定段 729 字符与改前逐字节一致；交付态源码不含插桩标记；`src/` 中 `Intl.DateTimeFormat` 仍唯一 1 处） · 已登记边界：不跨重启持久化、`public/` 侧 6 处 formatter 与峰谷计价无关（未测未改） · 证据：[R1.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/R1.md) |
| R2 | 模型价目索引复用及失效 | R1 | 45–90 分钟 | r2-models（subagent） | **ACCEPTED** · 主审独立复算「无原地改写键集合路径」+ 纯改动区隔离（前缀 2884/后缀 3539，改动仅 1 处连续替换）；探针 14/14、测试 68/68 · 证据：[R2.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/R2.md) |
| S1 | published 映射解码复用 | G_BASE | 45–90 分钟 | s1-store（subagent） | **ACCEPTED** · 主审复跑 verify-s1 **PASS 10/10**（before 453/456 → after 1/1，与 B3 基线逐位一致；4 个变异体各被抓）；`replaceFile` 签名与 H0 逐字节相同 · 证据：[S1.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/S1.md) |
| S2 | 同稳定窗口的探针去重 | S1 | 90–120 分钟 | s2-probe-dedup（subagent） | **ACCEPTED** · 主审复跑 verify-s2 **PASS 28/28**（探针 1558→1197、`decision.loop` 449→88、窗口新鲜度三项不变、8 个变异体全被抓、B2 的 26 锚点零破坏）；**波次 3 收口** · 证据：[S2.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/S2.md) |
| C1 | 稳定失败尝试与规划复用 | R2、S2 | 90–120 分钟 | c1-stable-failure（subagent，第 2 实例） | **ACCEPTED** · 主审复跑 `verify-c1.mjs` **PASS 12/12**（r2/r3 `codexParse=0`、解析字节 0、探针 1197→834、7 变异体全抓、B2 锚点零破坏）；首实例启动即失败、零产物（已核验） · 证据：[C1.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/C1.md) |
| C2 | 失败复用的全部触发/告警/恢复 | C1 | 90–120 分钟 | c2-failure-lifecycle（subagent，第 2 实例） | **ACCEPTED** · 主审复跑 `verify-c2.mjs` **PASS 13/13**（`decision.loop` 449→88、总摘要 834→473、8/12 变异被抓、B2 锚点零破坏）；修掉 C1 一处策略写回缺陷（附非对称性登记） · 证据：[C2.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/C2.md) |
| C3 | 未变文件标准化投影复用 | C2 | 90–120 分钟 | c3-projection-reuse（subagent，实现）+ **c3-closer（Agent Teams 队友，收尾）** | **ACCEPTED** · 主审全量复跑 `verify-c3.mjs` **PASS 17/17**（内容真变轮 **362 份/1,274,551,055 B → 1 份/83,967,454 B**；12/12 错误变体被指名 `AssertionError` 抓住）· **容量发现 ⇒ C6 必须重裁**（前任 192 MiB 手算从未实测；实测 4× ≈ 254–303 MiB 超上限） · 证据：[C3.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/C3.md) |
| C4 | 只构建与发布受影响线程 | C3 | 90–120 分钟 | c4-affected-publish（Agent Teams 队友，共享任务 `task-2`） | **ACCEPTED** · 主审全量复跑 `verify-c4.mjs` **PASS 17/17**（内容真变轮 `codexBuild` **353 → 1**，staged=1/retained=352；已发布零变化轮 **353 → 0** 且发布 1 → 0；未受影响线程 rowid 逐项不变；7/7 错误变体被具名 `AssertionError` 抓住） · 一轮返工（交付态哈希终值 + 片段收缩用例 + 共享门禁纪律） · **主审另修共享门禁非封闭缺陷**（见 [HARDENING-record.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/tools/out/hardening/HARDENING-record.md)） · 证据：[C4.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/C4.md) |
| C5 | 无实际变更时不空发布/不改写候选 | C4 | 90–120 分钟 | c5-noop-publish（Agent Teams 队友，共享任务 `task-3`） | **ACCEPTED** · 主审全量复跑 `verify-c5.mjs` **PASS（44 项 / exit 0）** + **代码级核验"定向失效完备"**（`events`/`source_files` 运行时写点恰 4 处、全部置位；home 形状键 4 元组**完备**）· 连续三轮 no-op 两臂 `replaceFile/解析/构建/发布` **全 0** 且**第四轮写入立刻生效**；两臂 6 表语义哈希 + 消费者读数 + 版本号**全等**；失败注入后**下一轮重试成功**；8/8 错误变体被具名 `AssertionError` 抓住 · 一轮返工（§9 **取代链**声明 + 新增门禁经主审**判别力对照**证明非摆设）· 交付 D1 的**提交路径清单** · 证据：[C5.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/C5.md) |
| C6 | 1×/2×/4× 容量及规格 P2 门禁 | C5 | 60–90 分钟 | c6-capacity-gate（Agent Teams 队友，共享任务 `task-4`） | **ACCEPTED**（18:39） · 夹具 = `baseline/isolated` 全部 **362 份真实 rollout（1,274,551,054 B）逐字节副本**，2×/4× 确定性 id 派生（`--rebuild` 后 digest 逐位一致） · **判决项：真变轮，不是 no-op 轮**（`r2lookupΔ=0` ⇒ no-op 轮不进 planner，故 `r2parse=0` 不是证据）⇒ 改 1 份：1×/192、2×/192、4×/192 = **1 份**；**2×/缺省 64 MiB = 84 份 / 893,718,901 B**、**4×/缺省 64 MiB = 363 份 / 3,766,975,634 B（≈3.77 GB = 全语料 74%）**；恒等式 `lookupΔ=hitsΔ+missesΔ+staleΔ` + 字节独立重算 **Δ=0**；真变后缓存**二阶塌缩 1086→202** · 容量：字节 1×=43.61 MiB（68.1% ⇒ 只兜住 ≈1.47×）/ 2×=87.73（缺省 97.0%）/ **4×=175.97 MiB（192 MiB 的 91.7%，余量 8.3% < 25%）**；真实堆 26.07/52.18/**104.38 MiB**（**推翻 C3 的 75.65 MiB/份** = `structuredClone` 丢字符串共享 ×1.94 × C3 脚本除以 2 的 ×1.5） · **卡面第二句（规格 P2 暖 sync p50 ≤800 ms）如实登记未达**（单样本 0.93–1.13 s；计数口径达标：解析/发布 = 0）⇒ 分位数归 Q1/Q2/V2 · **T1/T2 = 已确认 TRIGGERED（用户 16:54 裁定）** · 不变量 6 项 + 新增 `inv.scale`/`rss-not-negative-decoration` 全绿 · **一轮返工**（`--fast --growth-scale=2` 期望值未随 scale ⇒ 主审 FAIL 2/107）· 主审独立复跑 `--fast` 与 `--fast --growth-scale=2` 各 **PASS 109/109**；产品文件与共享门禁**零改动** · 证据：[C6.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/C6.md) |
| D1 | 提交修订与外部提交失效 | G_CAP、R2 | 90–120 分钟 | d1-commit-revision（Agent Teams 队友，共享任务 `task-7`） | **ACCEPTED**（22:06） · **两条腿**：① 自身提交 = 显式实例修订 `storeRevision`（只为用量/quota/perf/home/service-tier 成功提交 +1，**例行时刻字段不算变化**）② 外部提交 = 同连接 `PRAGMA data_version` 检出 ⇒ 失效派生缓存 + 重载 `store_meta`；**回滚不推进修订**（写事务深度 >0 时**不落任何缓存** + 回滚再清）· 交付 `src/usage-store.js` **`68487b8f…`**（254,975 B，+17,244；**schema 仍 14**）、`test/usage-store.test.js` `2a7f75d6…`（+4 用例）· 主审**串行亲跑全量 44/44 exit 0 / 129,344 ms** + **自写探针 16/16**（`data_version 2→3→4`、外部改 `generated_at` 被重载、**同连接自身提交 `data_version` 恒不变**、回滚无幻影行且缓存清零、重试落地）· `server.js` **一行未改**（mtime 10-05，早于开工 4 天）· **一轮返工**（真缺陷：`verify-d1.mjs` 引用未声明的 `VARIANTS_HINT` ⇒ 全量档崩、归档"41/41"不可复现；返工加单飞锁 + 变异判据 `期望 ⊆ 实际` + 报告**自带身份**）· 取代链第 6 段 · 证据：[D1.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/D1.md) |
| D2 | 历史冠军复用、范围判定分离 | D1 | 90–120 分钟 | d2-record-memo（Agent Teams 队友，共享任务 `task-8`） | **ACCEPTED**（22:44） · `recordsForRange` 拆成 **memo 查找 → `buildRecordChampions`（与 range 无关）→ `recordsWithinRange`（包含判定）**；**六项键**（数据修订/价目版本/汇率/evidence 签名/时区/规范排除集合）· 关键读码结论：**冠军选择只用 `where`，`range` 从不进 WHERE** · 交付 `src/usage-store.js` **`0e757098…`**（260,576 B）· 主审亲跑 `--gates` **全 PASS/exit 0** + **自写 A/B 等价探针 32/32**（D1 冻结字节 vs 本卡交付字节，5 夹具 × 6 范围 `recordsForRange` **逐字相同**；并列不点亮且 memo 不留冠军；整周差 1 ms 不点亮；local/utc 冠军期不同；改汇率 ⇒ 成本冠军立即 ×3 且暖 memo == 冷实例）+ **自写扫描计数探针 6/6**（冷 1 次、暖 4 次调用仍 1 次 ⇒ 不再重复全历史计价）· **跨卡契约**：memo 遵守 D1 的 `writeTransactionDepth === 0` 写事务门 · 取代链第 7 段（主审替它冻结 `D2/diagnostics/chain/d2-usage-store.js`）· 证据：[D2.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/D2.md) |
| D3 | quota 观测复用、时钟实时计算 | D2 | 45–90 分钟 | `d2-record-memo`（复用同一 durable 队友；队友上限 8 已满；共享任务 `task-9`） | **ACCEPTED**（23:15） · `quotaObservations()` 改为"修订键复用"：`syncDerivedRevision()` → `cacheable = writeTransactionDepth === 0` → 命中 `revision === storeRevision` 返回**同一份规范映射**（缓存内容**恰 10 个静态列、零时间派生字段**；`open`/`close`/`syncDerivedRevision` 三处复位）· 交付 `src/usage-store.js` **`8efac2a1…`**（264,331 B）、`test/usage-store.test.js` `1215dbe8…`、`test/server.test.js` `16c125c2…` · 主审亲跑 `--gates` **PASS/exit 0** + **自写推时钟探针 12/12**（**不改源**：暖(缓存已建)与冷实例在每个时刻**逐字相同** 8,029/8,036 B；跨复位两侧抛同一个 `QUOTA_WINDOW_UNAVAILABLE`；`percentStale` 只在过期那步翻 true；6 次不同 asOf **多读 0 次**观测；外部第二连接写入立刻生效）· **一轮小返工（证据元数据）**：`verify-d3.mjs` 曾把 `startedAt` 伪造成 `finishedAt`，返工后真实取值（19,259 ms）且报告自述脚本哈希 = 现场脚本哈希 · 取代链第 8 段（`D3/diagnostics/chain/d3-usage-store.js` = 交付）· 证据：[D3.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/D3.md) |
| D4 | metadata/周期对比实际变更失效 | D3 | 60–120 分钟 | `d2-record-memo`（复用；共享任务 `task-10`） | **ACCEPTED**（23:58） · 主审亲跑 `--gates` PASS/exit 0 + **自写 24/24 探针**（暖==冷于 7 个 asOf：未来事件前/后、跨日、跨周、跨月、日界 ±1 ms；陷阱 1 命中响应 `asOf` = 本次请求时刻；陷阱 2 `modelLastSeen.Codex.gpt-6-mini` 随 asOf 出现/消失并回退复原；稳态观测聚合查询 **0** 次、每次仅 1 条 `PRAGMA data_version`）+ **D2/D3 回归探针 32/32、12/12**（无回退）· 冷路径 +1 条语句（为算全表 `MAX(timestamp_ms)`，**诚实代价**）· 残余 2 判定 `NOT_REQUIRED`（单步内无重复 `COUNT(DISTINCT …)`）· 证据：[D4.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/D4.md)
 · 范围已先收窄：C5 已交付的失效判据（`usageDerivedChanged \|\| homeSetChanged` @`:4239-4240`）与 metadata 静态块缓存（`:4330/:4335/:4379`）**只做"未被回退"的计数证明、不重做**；残余 = `metadata()` 尾部 `buildModelActivity(observations, asOf)` @`:4400` 与 `aggregateRange` 家族 `COUNT DISTINCT`（`:4411/:4412/:4449/:4508/:4510/:4538`）；**重点陷阱**：`periodComparison` 命中路径必须刷新 `asOf`（`{...structuredClone(cached), asOf: now}` @`:4604`）与"未来事件不得被缓存吃掉" · 另因**他方会话正并行写 `test/skin-palette-*`**，本卡起 `node --test` 一律显式点名文件 |
| D5 | 全局排名 home 轻量查询 | D4 | 45–90 分钟 | `d2-record-memo`（复用；共享任务 `task-11`） | **ACCEPTED**（00:35） · 主审亲跑 `--gates` **PASS/exit 0**（00:24:59→00:25:23）· **主审自写 A/B 探针 6/6**：用**共享冻结夹具**（`tools/fixture.mjs`，同一路径重建两次 ⇒ home id 相同）对 **D4 冻结字节 vs D5 交付字节**比对 —— 归一化载荷（今日/样本日/metadata 三份）**逐字相同**；逐次读调用：`summarize` 总语句 25→24、全列样本查询 4→2、三列身份投影 0→1（metadata 5/0/0 不变）⇒ 与自述"取排名 2 语句→1、全列解码归零"口径一致 · **全局/今日（主审复核项）**：今日 `eligible 0 / groups 0` 而排名仍 1 个，样本日 `eligible 2 / groups 1` 且**排名逐字相同** ⇒ 排名是全局的、可信性是当日范围的 · 交付 `src/usage-store.js` `b4110374…`/268,925、`test/perf-summary-parity.test.js` `adbd2ab5…`、`test/perf-store.test.js` `9b8f20ce…`（`test/perf-summary.test.js` `bc36c839…` 未动）· 取代链第 10 段 · 证据：[D5.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/D5.md) · 靶子：`rankedHomeIds`（`:5106` 附近 IIFE）改为用**必要身份列/全局聚合**，**不再解码全量 sample JSON**；沿用 partial/degraded 过滤（`:5043-5059`），保留完整 `summary.perf` · 主审点名：必须专造"**全局有可信样本、今日无样本**"的 home 夹具；失败 home 的陈旧候选不得入可信统计（发现过滤有洞**停下汇报**）；改前/改后同一夹具逐项读数**字节相等**证明未牺牲覆盖面；另按卡面记录**读路径阶段预算**给 Q1 · 禁止碰 `public/**`（U4 正在改）与 `tools/out` |
| U4 | 自动刷新周期与时钟重算 | U3、C5、D4 | 60–90 分钟 | `d1-commit-revision`（**复用另一 durable 队友并行**；与 D5 写入范围互斥） | **ACCEPTED**（00:35） · 主审**自写逐行 diff** 证实唯一 hunk = 前缀 4,369 行相同 + **6 删 / 10 增** + 后缀相同（其脚本报 679 属"末尾空行"计数约定）；**亲跑门禁** `test/app-autorefresh.test.js`+`test/app-toolbar.test.js` **6/6 exit 0**；**复跑其 14 段门禁 EXIT=0**（自愈对照 1/2/3 vs 改前 0/0/0、**真实 60 秒周期 61,000 ms**、9/9 突变体具名抓住、MISSED 0）；hunk 不含 `skipCheck`、`60_000` 不变、`state.now` 无赋值 ⇒ **未以少查来源换性能**（四类计数 9/8/8、9/11/11、周期 `skipCheck` 0/0/0、29/89/89 改前=改后）· `public/app.js` `b94162d3…`/211,215 → **`91b595d7…`/211,568**（+353 B）· 证据：[U4.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/U4.md) · 主审点名：只有**已完成等价内容校验**的周期才许 `skipCheck`；同尺寸改写/WAL 不得漏更新；quota 时钟（today+5h+week 各 ≥3 确定性周期，含 reset/切范围/暂停恢复/与 sync 重叠）；**至少一次真实 60 秒周期**；源检查/时钟重算/实际同步**分别计数**；**不得以少查来源或关闭自动刷新换性能** · **并发写守卫**：动手前后校验 `app.js` 哈希，若被他方改动即停下汇报 · 禁止跑 `tools/verify-b2.mjs`、禁止碰 `src/**` |
| Q1 | 残余阻塞 profile 与路线裁定 | D5 | 45–60 分钟 | `d2-record-memo`（复用；共享任务 `task-12`） | **ACCEPTED**（00:55） · 产品**零改动**（我复核三个受测哈希 + `usage-core.js` 全与链尾/红线一致，清单 4,221/0/0）· 主审复核：**逐条重算**其原始样本分位数**无一处置错误**；**自己解析两份原始 CPU profile**，自用时与它的归因**逐项吻合到 0.1 ms**（同步 7,426.4 ms 全归属：`open` 2,526.2 ← `perfContentFingerprint`(usage-core.js:2055)←(:2110)←`planStableCodexHome`(:2172)、`stat` 269.9、`read` 199.7、`syncRound` 172.0；读路径 22,265.2 ms：`groupedRange`(:4492) 2,432.8、`costEventsForRange`(:4541) 1,944.1、`selectQuotaWindows` 737.9、`periodAggregate` 736.9） · **★Q1-lead-1**：主审自起服务器复量，**"重请求在飞"时 `/api/status` 5/5 轮首答被阻塞到 ≈ 大请求全长（429.2/431.5 ms）⇒ p95 429.2 / max 431.5 超 `max ≤ 250 ms`**，且发生在 `skipCheck=1`（**不含同步**）⇒ Q1"轻量 API 三项全达标"**口径过窄已收窄**，同时**独立印证"把同步搬走不算解决 HTTP 侧阻塞"** · 端到端 **暖 sync 1,138/1,160 ❌、无变化刷新 p50 1,368 ❌ / p95 1,380 ✅**（照录不修饰） · 裁定采纳并收窄：B1（只在 **home 之间**让出）、B2/B3（先取 SQL/JS 拆分证据）、**B5 收窄为只验证不动**、B6/B7 不动、W1/W2 条件性保留、W3 不改 · 证据：[Q1.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/Q1.md) |
| Q2 | 必要的事务外让出与响应验证 | Q1 | 60–120 分钟 | `d2-record-memo`（复用；共享任务 `task-13`） | **IN_PROGRESS**（00:58 派发） · **证据优先**：先取 ① B1 运行时事务边界 ② B2 的 SQL/JS 拆分 ③ B3 `iterate` vs `buildTimelineRows` 拆分 ④ **并发口径基线**（空载 + 大请求在飞各 ≥20 次）· 只动 B1（**home 之间**让出，同一 home 前后指纹仍同处取得）+（有拆分证据时）B2/B3；**不得在事务内 `await`**；B5 只验证；B6/B7 不动 · 验收 = 轻量 API **在并发口径下** p95 ≤ 100 ms、max ≤ 250 ms（主审已证当前 max 431.5 ms ❌）+ 三个测试文件 + 独立进程探针 · 交付冻结副本并声明取代链第 11 段；改 `usage-core.js` 前须确认不破 `verify-b2` 26 锚点，**会破就停下汇报** | **ACCEPTED**（02:05） · **唯一改动** `src/usage-store.js` `b4110374…/268,925B → 2b80f77b…/270,175B`（我复核：对 D5 冻结副本 diff = **唯一 hunk、14 增 0 删**，让出在逐 home 循环顶部、唯一新 `await` 为 `setImmediate` 宏任务；`usage-core.js`/`server.js`/`public/**` 未动） · 我自跑：三相 **74/74 exit 0**、`verify-b2` **exit 0 / PASS**（26 锚点，先 228 MB 字节快照后跑并逐文件还原 ⇒ 26/26 一致、清单 0/0）、冻结副本逐字节一致 · **"事务外"我自己读代码确认**（`runInSavepoint` :1321-1330 内 `SAVEPOINT→work→RELEASE`；:3094–:3948 无 `BEGIN`） · **★Q2-lead-1 判据未达标**：大 summary 在飞 p95/max **423/435 → 439/466 ❌**（空载 6/6→7/7 ✅、同步在飞 219→240 max ✅、冷启动 8,130→**9,112 ms ❌**）；before/after 非交错对照 ⇒ 方向性差异不可归因，**绝对超标可归因** ⇒ **`G_RESP` 不释放 + 触发 W1** · 采纳其"不动+证据"：B2（SQL 占 99%）、B3（读事务内）、B5（我收窄为只验证）、B6/B7/W3 · 突变 6/6 DETECTED · 主审更正三处：其"清单 0/0"测于覆盖之前（交付瞬间 8 变更，我已从 T1 字节快照 8/8 还原）、`handoffs/Q2.md` 误写仓库根（我字节不变移入 `<run>/handoffs/` 并删空目录）、`inputs-smoke.sqlite` 仅 WAL checkpoint · 登记未决：B1 长块量级冲突（Q1 1,147 ms vs Q2 无 ≥20 ms 块）由 W1/V2 用 `monitorEventLoopDelay()` 裁决 |
| U1 | 翻译受影响子树与 locale formatter | G_BASE | 60–90 分钟 | u1-i18n（subagent） | **ACCEPTED** · 主审逐行核对全部 163 增/42 删（无 `activeLocale` 短路、回填与 `SKIP_USER_DATA` 保留）；探针 27/27、i18n 测试 8/8 · 证据：[U1.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/U1.md) |
| U2 | 周期表输出复用、尺寸更新合并 | U1 | 60–120 分钟 | u2-period-table（subagent） | **ACCEPTED** · 主审复跑探针 exit 0 + 卡面 57/57 + 并集 70/70；核实表缓存不变量（静态容器、唯一写者、无祖先重建）成立 · 证据：[U2.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/U2.md) |
| U3 | 性能数值 formatter 与 tooltip 更新 | U2 | 45–90 分钟 | u3-perf-formatter（subagent） | **ACCEPTED** · 主审复跑探针 exit 0（43/43）+ 四文件 70/70；逐行核对 perf-ui/app.js 全部增删行，U2 五区域未被触碰；三项裁定已下 · 证据：[U3.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/U3.md) |
| U4 | 自动刷新检查/时钟路径确认 | U3、C5、D4 | 60–90 分钟 | d1-commit-revision（Agent Teams 队友，共享任务 `task-14`） | **ACCEPTED**（2026-10-10 00:35；与上表 `U4` 行是同一张卡，此处为该旧文本行的收口） · 60 秒循环契约审计 + 一处"首轮取数失败后永久停摆"缺陷自愈 · `public/app.js` `b94162d3…/211,215 → 91b595d7…/211,568`（唯一 hunk：6 删/10 增）· 主审复跑 14 段门禁 **EXIT=0**、**真实 60 秒周期 61,000 ms**、突变 **9/9** 具名抓住、周期 `skipCheck` 计数 **0/0/0**（未以少查来源换性能）· 证据：[U4.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/U4.md) |
| V1 | 集成正确性与异常恢复矩阵 | G_RESP、U4 | 90–120 分钟 | v1-integration（Agent Teams 队友，共享任务 `task-17`） | **ACCEPTED**（2026-10-10 05:45，三轮：FAIL → 两条读码裁定 → 通过） · A–G/K 正确性与原版等价；**产品与既有测试三轮一字未改**；白名单外差异 **0**（7 条具名屏蔽，含 `^modelActivity\.modelUsageAsOf$`）· W2 由"串行化结构性证据 + `F2-half-publish` 突变"结案 · 两条具名工具缺口见报告 §7 · 证据：[V1.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/V1.md) |
| V2 | 冷暖/增长/内存/浏览器最终测量 | V1 | 90–120 分钟 | v2-final-measure（Agent Teams 队友，共享任务 `task-18`） | **交付接受（ACCEPTED as measurement）**（2026-10-10 06:25） · `:62` **达标** · `:59`/`:77` **未达** · `:60` **部分未达** · `:61`/P4/P8 **未做** · 冷启动 7,081–7,086 ms 已测 · Edge headless + CDP 分离数字（headless 下 FCP 取不到，如实标注）· 主审 n=10 复跑三组量级全部复现；**引用口径必须区分**：`V2/out/P1-*.json` = 主审 n=10 复跑，worker n=50 原始在 `handoffs/V2.md` §4 + `V2/logs/**` · 证据：[V2.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/V2.md) |
| V3 | 集成检查、回退核对和交付文档 | V2 | 60–120 分钟 | d1-commit-revision（Agent Teams 队友，共享任务 `task-20`） | **REVIEW**（2026-10-10） · 最终报告 + 任务表 + 文档入口 + 全仓门禁 + 清理清单（只列不删）· **全仓门禁 4 项红、如实记账**：① `npm.cmd test` = `node --test` 默认发现**扫进证据树内的测试副本** ⇒ 19,923 测试/611 fail（真实套件另跑记录在案）；② `typecheck` **29 条**（含本波**从未触碰**的 `src/perf-sources/codex-thread.js` 11 条 ⇒ 本就非绿）；③ `lint`/`format:check` 因证据树内 `V1/out/code-current/biome.json` **嵌套配置**令 biome 配置报错退出；排除证据树后 **lint 0 error**、format 有 **3 个本波测试文件**的差异（V3 禁改测试 ⇒ 不修） · 证据：[FINAL-REPORT.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/FINAL-REPORT.md) · [V3.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/V3.md) |
| T1 | 私有投影持久化的 schema/迁移 | C6 触发、主审接受具体设计 | 90–120 分钟 | t1-projection-persistence（Agent Teams 队友，共享任务 `task-5`） | **ACCEPTED**（19:14） · `STORE_SCHEMA_VERSION` **13 → 14**（首次 bump，用户批准）· 新增私有表（**空表、零回填、不标脏**）+ 可注入接缝 `createPersistentCodexProjectionCache` ⇒ **产品行为零变化**（`this.codexProjections` 仍纯内存）· 交付 `src/usage-store.js` **`3d6ce3e6…`**（235,446 B）、新 `test/perf-projection-store.test.js` `09c4858c…` · 主审亲跑全量 **55/55 exit 0** + **自写打靶 26/26**（同名 VIEW/窄表被拒 + 版本停 13 + 可恢复 + 注入失败无半行 + `clear()` 不清表 + `stats()` 纯内存）· 迁移三臂 7 表逐字节等价、旧程序打开 14 库明确报错不损坏 · 他人证据跑前快照 **4,221 文件 / 跑后 0 变更 0 缺失** · 取代链第 4 段：[T1.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/T1.md) |
| T2 | 投影读写接入、故障与容量复验 | T1 | 90–120 分钟 | t2-planner-wiring（Agent Teams 队友，共享任务 `task-6`） | **ACCEPTED**（21:02） · **唯一语义改动 = `open()` 尾部一行**（构造器里 `this.database` 还是 `null` ⇒ 位置是硬约束）· 交付 `src/usage-store.js` **`021358f0…`**（237,731 B）+ 新增 `test/perf-projection-planner.test.js` `0c726a0e…` · **主审自己的逐行 diff：33 条差异条目里唯一一行代码就是接线行** ✓；T2 反解的 T1 交付副本 = `3d6ce3e6…` 逐字节相同 ✓；`codex-thread.js`/`usage-core.js` **未动** ✓ · 主审亲跑 `verify-t2.mjs --skip-measure` **PASS 40/40 exit 0**，跑后 4,221 文件清单 **0 变更 / 0 缺失** · **C6 缺口闭合由"另一个作者的测量台"(C6 的 harness) 独立复测**：改 1 份全文解析 2×/64 **84 → 1**、4×/64 **363 → 1**，字节 = 3,968,994 = 被改那份 · 墙钟 4×/64 真变轮 **20,752 → 10,871 ms（−47.6%）**；冷启动（含真·新进程）同样 1 份 · **容量结论（主审）**：**维持缺省 64 MiB、不采纳 192 MiB**（192 违反 25% 余量口径：4× 序列化需 234.63 MiB；接线后反而 **+58%** 变慢；只换 454 ms 却多 124.5 MiB 常驻堆）⇒ **`G_CAP` RELEASED（21:05）** · 取代链第 5 段：[T2.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/T2.md) |
| W1 | 必要阻塞工作的单执行器接入 | Q2 触发、主审接受具体边界 | 90–120 分钟 | `t2-planner-wiring`（W1-a）/ `c6-capacity-gate`（W1-b） | **W1-a ACCEPTED**（2026-10-10 02:45；按计划 `:28` 拆为 W1-a 落地 / W1-b 证据）· `src/server.js` `c4f7f8e3…/31,377 → d9b08700…/32,925` + 新增 `src/usage-executor.js` `071ce854…/13,460` + 新测试 `test/w1-executor.test.js` `68924cb8…`；`usage-store.js`/`usage-core.js`/`public/app.js`/`test/server.test.js` **未动** · **主审独立复量（我自己的探针，非采信自述）：空载 3.0/4.7/5.0 ms；并发（大请求在飞）2.9/5.0/5.4 ms，对比我自己的改前 429.2/431.5 ms ⇒ `G_RESP` 并发判据 p95 ≤ 100 / max ≤ 250 独立达标**（5/5 轮每次轮询 ≤5.4 ms）· 我自跑 4 文件门禁 **80/80 exit 0**；冻结副本 3/3 逐字节相等；`test/server.test.js` `cea50896…` 逐字节不变（未放松既有测试）；我通读其 `server.js` 单卡差异（32 增 / 15 删）· 它另发现 §5 未列两条跨线程根因（RC4 worker 价目目录不同源 `usage-store.js:4771`；RC5 `serviceTierEvidence` 类实例过不了 JSON）· 冷启动 9,395.9 → 5,353.1 ms **仍不达标**（事件环 max 901.3 → 11.8 ms ⇒ 已非阻塞问题，属 W2/W3 延迟项）· **W1-b ACCEPTED**（03:50，原 owner `c6-capacity-gate` 两次运行崩溃无收尾 ⇒ 改派 `d1-commit-revision`）：突变 **6 DETECTED + 1 等价变体**（我独立重跑与其记录**逐行一致**，控制组 13/13 GREEN、全部还原）；B1 让出**回退**（`usage-store.js` 逐字节回到 D5 `b4110374`，取代链**段 13**；★Q2-a/b/d 断言按取代删除、原文留证、★Q2-c 保留）；`close()` 显式 Promise/flush（`server.js b32fa0c9…/33,459`）；我自跑 4 文件门禁 **84/84 exit 0**；冻结副本 5/5 逐字节相等 · **W2 判定：实质由 W1 覆盖，不另派实施卡**（W2 的机制：唯一连接在执行器内 ⇒ 主线程不打开库、读侧快照提交后发布、冻结用快照自己的 `asOf`/metadata；我已复跑"冻结与发布重叠"链路 = 载荷完整 / 新内容确实发布 / 旧冻结按 `snapshotId` 再读**逐字节稳定** / 在飞轻量端点 6.4–1.1 ms；"无读到半发布状态"由 `F2-half-publish` 突变机械钉住；仅一条**子树级**快照一致性复核转 V1）· **主审预接受边界**：待移工作 = **HTTP summary/读路径**（`summarize`/`summarizeInReadTransaction`，实测 447 ms/请求 = SQL 248 + JS 199；含 B2/B3 读事务段）+ **同步**（`syncRound`；B1 归因冲突由本卡用 `monitorEventLoopDelay()` 裁决后定）；**执行器独占数据库连接、绝不跨线程共享 `DatabaseSync`**；主线程只服务轻量端点（"已提交读侧状态"由 W2 收口）；**私有最小消息集**，不加调度池/通用 RPC/无限重试；`syncPromise` 合并语义与"手动刷新等真实完成、不在候选发布中途回成功"不变 · 验收 = ✓正常刷新链路 + 并发合并可运行，✓**并发口径下轻量 API p95 ≤ 100 ms / max ≤ 250 ms**（当前 439/466 ❌），✓空载不劣化（当前 7/7）· 门禁：三相测试 + `verify-b2` 26 锚点 + T1 清单 0/0（**先字节快照再跑**）+ 突变 ≥6 · 硬约束：不加依赖（`worker_threads` 内置）/schema 仍 14/不碰 `public/**`/不缓存完整 HTTP JSON/不新增通用缓存框架 · 交付冻结副本并声明取代链第 12 段 |
| W2 | 已提交读侧状态与冻结一致性 | W1 | 90–120 分钟 | 主审裁定 | **判定：实质由 W1 覆盖，不另派实施卡**（账本 `:812`） · 机制：唯一连接在执行器内 ⇒ 主线程不打开库、读侧快照提交后发布、冻结用快照自己的 `asOf`/metadata；主审复跑"冻结与发布重叠"链路（载荷完整 / 新内容确实发布 / 旧冻结按 `snapshotId` 再读**逐字节稳定** / 在飞轻量端点 6.4–1.1 ms）；"无读到半发布状态"由 `F2-half-publish` 突变机械钉住；仅一条**子树级**快照一致性复核转 V1（已在 [V1.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/V1.md) 结案） |
| W3 | 执行器故障恢复、关闭和响应复验 | W2 | 90–120 分钟 | w3-fault-recovery（Agent Teams 队友，共享任务 `task-19`） | **ACCEPTED**（2026-10-10 04:25） · 故障矩阵 **8/8**（真注入：在途硬崩溃可重试不挂死 / 崩溃后重启 `restarts=1` / 发布中途 **3,230 次采样、半成品 0** / `close()` 期崩溃 **13.6 ms** 落定 / 幂等 / 目录立即可删 / 3 循环线程不累积 / SIGKILL 后可删）· `src/usage-executor.js` `071ce854…/13,460 → 6e876c82…/16,511` + 新 `test/w3-fault.test.js` `fc479cd5…/19,059`；`server.js`/`store`/`server.test.js` 未动 · 主审自跑 5 文件 **93/93 exit 0** + 并发判据在 W3 字节上复测仍 PASS · **三处未做**（真实库崩溃恢复、多请求同时打崩、事务中途崩溃的 `-wal` 恢复完整性）+ 端到端"改源 ⇒ 读到新内容"子项**登记未确立**（不冒充通过）· 证据：[W3.md](../validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/handoffs/W3.md) |

预计核心总工程工作量沿用规格的 4–6 个工作日，并行压缩独立支线等待，不能保证主线也按 worker 数等比例缩短。容量/执行器额外预留 1–3 天；两者都触发时分别重估、拆卡，不能把架构工作无限塞进两小时单元。

## 5. 基础任务卡：取样、热点与增量同步

### H0

- **写入范围**：`src/usage-store.js`，确需补缺时 `test/usage-store.test.js`；本卡证据目录。
- **实施**：最小内容归档+摘要、恢复演练和一致性索引副本后，在 `open()` 无条件 `CREATE INDEX IF NOT EXISTS` 补 `events(source_path)`。不抬 schema 版本、不捆绑缓存。
- **验收**：副本上的两处 session 反查结果一致，`EXPLAIN QUERY PLAN` 走索引；已有库重开获得索引且版本不变。记录原循环/索引后循环、建索引时间、体积和回退补丁。
- **交审检查**：`node --test test/usage-store.test.js`；主审重看索引 SQL 和一份查询计划。H0 保存原版可运行工作集，不丢掉后续 before 基线。

### B1

- **写入范围**：本轮验证目录中的 `baseline/` 与本卡证据；不改产品代码。
- **实施**：归档受影响运行/测试工作集，含 untracked 文件和配置；临时目录恢复并比对摘要。隔离四来源 home、原始文件、价目和一致性索引，保留原版/H0 版；活 SQLite 用既有 backup，不拼接 db/wal/shm 复制。
- **验收**：隔离服务能启动，来源发现全部落在隔离目录；恢复摘要一致；完整参数、文件/表规模、Node/浏览器、有效价目、日期/时区、自动刷新和后台任务可识别。固定 A/B 不读写真实上游。
- **交审检查**：主审抽查一个恢复文件和来源路径映射，重启一份副本。隐私原始数据与大归档保留本地隔离目录，报告只存必要摘要，不提交原始日志。

### B2

- **写入范围**：本轮验证目录 `tools/` 和本卡证据；优先复用下列探针的计时/包装逻辑，在隔离代码副本插桩。产品计时若确需保留，再向主审申请具体文件短锁。
- **实施**：最小 Node 脚本/包装器记录非重叠阶段，reader 调用/命中/实际解析字节、replace/build/publish、全历史计价、published 解码、两个摘要入口的窗口/字节。使用现有 `performance.now()` 和 fixture，不多调用被测函数。
- **验收**：包装器零行为差异；一次可控文件追加计数正确；稳定窗口前/后/发布计数分开；轻量请求从独立进程每 50 毫秒采样，定义超时并在同步结束停采样。
- **交审检查**：主审对一份小 fixture 手算计数并复跑；观测不输出原始内容、不增加生产 UI。诊断包装器本身记摘要。

可复用的现有脚本入口如下；先读源码再适配隔离路径、参数和口径，不原样执行历史假设：

| 用途 | 现有入口 | 本轮必须适配 |
| --- | --- | --- |
| API/阶段/SQL | [api latency](../validation/2026-10-09-refresh-performance/probe-api-latency.mjs)、[store phases](../validation/2026-10-09-refresh-performance/probe-store-phases.mjs)、[query plans](../validation/2026-10-09-refresh-performance/probe-query-plans.mjs) | 固定隔离来源、一致性 backup、hour/day 参数、完整响应；旧 phases 的 db/wal/shm 文件复制不能沿用 |
| 计价/读路径 | [cost factors](../validation/2026-10-09-refresh-performance/probe-cost-factors.mjs)、[read attribution](../validation/2026-10-09-refresh-performance/probe-read-path-attribution.mjs) | 实际生效价目、固定时刻、每项单独 A/B，保留字段等价性 |
| 同步/探针计数 | [post-P1 budget](../validation/2026-10-09-refresh-performance/probe-post-p1-sync-budget.mjs)、[content probe](../validation/2026-10-09-refresh-performance/probe-content-probe-cost.mjs) | 复用计时/包装方式，移除实验性的全局缓存补丁；覆盖两个摘要入口和实际解析字节，不夹带待测优化 |
| 事件循环 | [event loop](../validation/2026-10-09-refresh-performance/probe-event-loop-blocking.mjs) | 独立客户端、50ms 间隔、超时、同步结束停采样，测全部轻量路径 |

### B3

- **写入范围**：本卡测量结果和基线报告；不改产品代码。
- **实施**：原版/H0 同输入同价目对照；固定时刻比完整结果，活请求测时间。暖态预热 2 次后保留至少 20 次；冷态新进程和副本，记录 OS 页缓存条件；先预估投影 1×/2×/4× 工作集。
- **验收**：有完整样本和有效价目命中数；今日默认/skipCheck、静态响应及阶段残余能复跑。scope/time 的变化另列，不能只测最快路径或把旧报告当基线。
- **交审检查**：主审检查字段差异白名单、一个端到端样本和阶段包含关系，确认 `G_BASE`。B3 后才能派发其余产品修复。

### R1

- **写入范围**：`src/pricing.js`、必要的既有计价测试。
- **实施**：按实际峰谷时区复用 `Intl.DateTimeFormat`，只移出重复构造；保留 weekday/hour/minute、无效时区和峰谷边界处理。
- **验收**：固定价目下所有费用一致；时区/价目切换和边界行为不变。独立快照分别测构造计数、计价阶段和完整请求收益。
- **交审检查**：`node --test test/pricing.test.js test/claude-pricing.test.js`；主审复验一个峰谷边界。保留原版→H0→formatter 的中间版本供累加 A/B。

### R2

- **写入范围**：`public/pricing-models.js`、确需修复失效点时 `src/pricing.js`，模型/价目测试。
- **实施**：按稳定 models 对象用 `WeakMap` 复用模型索引；检查全部 resolver 调用和价目替换/重置/手动保存，热路径继续用 `activePricing.models`，不逐事件深拷贝目录。
- **验收**：别名/后缀匹配和费用一致；更换价目后立即命中新模型，旧索引不污染新对象；若存在原地改写，修正该真实失效点。
- **交审检查**：`node --test test/pricing-models.test.js test/pricing.test.js test/pricing-auto.test.js test/claude-pricing.test.js`；主审重跑一次价目替换，分别保存 formatter/模型索引收益。

### S1

- **写入范围**：`src/usage-store.js`、`test/perf-store.test.js`。
- **实施**：同步轮次内复用已解码 published fingerprints/warnings；只在成功提交后更新视图，回滚保留旧值。不要新增通用长期 `readMetaRaw` 缓存。
- **验收**：无提交时两份 map 各最多解码一次/轮；多文件成功提交读到最新映射；注入事务失败后旧告警/指纹保持一致，不在循环内整表重解码。
- **交审检查**：`node --test test/perf-store.test.js test/usage-store.test.js`；主审核对提交/回滚边界和实际解码计数。

### S2

- **写入范围**：`src/usage-store.js`、`src/usage-core.js`，必要的 perf-state/Codex-index 测试。
- **实施**：让 `enabledPerfSourceStat` 与 `perfContentFingerprint` 在同一验证窗口复用等价摘要；规范物理路径、算法和 main/codex 启用身份。优先小型内部参数/现有 helper，不造通用探针服务。
- **验收**：同物理文件每窗口实际摘要至多一次；前后/发布窗口分别新鲜；同尺寸同 mtime 改写、读取期间变化和 SQLite WAL 改写仍检出。
- **交审检查**：`node --test test/perf-state.test.js test/perf-codex-index.test.js test/perf-store.test.js`；主审复验一个同元数据改写，检查没有跨 await/读操作误复用。规格 P1 阶段剩余预算随本卡交接。

### C1

- **写入范围**：`src/usage-store.js`，必要时 `src/usage-core.js`；Codex-index 测试。
- **实施**：实例私有稳定尝试记录，签名包含 home、完整排序路径集、内容指纹和方法版本；仅稳定验证完成的确定性失败可复用。先使 home 规划入口正确复用，发布指纹保持原职责。
- **验收**：相同坏 JSON 三轮同步不再全文规划；指纹/集合/home/方法版本改变立即重试；`LIVE_SOURCE_CHANGED`、读取失败和发布失败不缓存为可跳过状态。
- **交审检查**：`node --test test/perf-codex-index.test.js test/perf-state.test.js`；主审核对所有 `shouldPlan` 条件，不接受只移除 degraded/partial 两个判断。

### C2

- **写入范围**：C1 文件及 `test/perf-store.test.js`、`test/perf-codex-api.test.js`。
- **实施**：把 C1 判定贯通 pendingChange、逐文件 refresh 与收尾；分别处理用量提交和 perf 尝试。重建本轮 partial/degraded/warnings，修复/删除/迁移后失效，不累加告警。
- **验收**：稳定坏线程不重读，告警/排名相同；健康兄弟线程仍更新；坏内容修复、暂不可读恢复、失败提交重试自动恢复。未知归属继续按原保守规则处置。
- **交审检查**：`node --test test/perf-codex-index.test.js test/perf-store.test.js test/perf-codex-api.test.js`；主审亲自核对“坏→连续复用→修好”的一条完整链路。C1 不能单独宣称失败复用已全部完成。

### C3

- **写入范围**：`src/usage-core.js`、`src/perf-sources/codex-thread.js`、`src/usage-store.js`；确有必要时 `codex-jsonl.js`；Codex-index/Codex 测试。
- **实施**：在全文读取之前按路径/来源/指纹/方法查私有投影；缓存现有 `readCodexRolloutMetadata` 标准化结果，不存原始 JSONL、不另写 parser。完整文件集合仍参与归属证明和前后稳定性验证。
- **验收**：不变文件实际全文解析为零；只解析改变文件；planner/builder 不改写缓存对象。只保留当前文件版本、替换/删除淘汰；先实现简单有界 RAM，容量由 C6 决定。
- **交审检查**：`node --test test/perf-codex-index.test.js test/perf-codex.test.js test/perf-state.test.js`；主审检查全部调用方和一条跨 rollout 依赖，不以 reader 包装调用次数冒充解析次数。

### C4

- **写入范围**：`src/usage-store.js`、`src/usage-core.js`、`src/perf-sources/codex-thread.js`；Codex-index/perf-store 测试。
- **实施**：依据新旧归属和依赖集合确定受影响线程，只对这些线程构建/发布；其全部 rollout 包含归档片段。无关线程复用已发布候选。
- **验收**：一文件追加只构建关联线程；多片段、身份重归属、删除、归档/跨 home 迁移符合原语义；失败线程不能发布其好片段，健康线程可继续发布。
- **交审检查**：`node --test test/perf-codex-index.test.js test/perf-codex.test.js test/perf-store.test.js`；主审核对 affected 集合和候选替换事务，保留 `foreign_key_check`。

### C5

- **写入范围**：`src/usage-store.js`、perf-store/usage-store 测试。
- **实施**：无实际变更时不空发布、不改写候选、不无条件清空派生缓存；仍按契约更新检查时刻。保留 `earlierFileChanged/changedSessions` 级联，别用提前跳过破坏用量提取。
- **验收**：隔离稳定源连续三轮：全文解析/候选写入/发布为零；checkedAt 正确；generatedAt/indexedAt 保持原语义；失败提交后能重试。记录规格 P2 的 sync 绝对时间与各残余阶段。
- **交审检查**：`node --test test/perf-store.test.js test/usage-store.test.js test/perf-codex-api.test.js`；主审检查真正的数据变更点，为 D1 交付提交路径清单，不只凭源 fingerprint 判断。

### C6

- **写入范围**：容量数据生成/测量脚本、本卡报告；不改产品文件。
- **实施**：确定性 1×/2×/4× 全量规模，保留今日数据相同；测当前投影实际工作集、暖解析数、probe 字节/延迟及 GC 后 heap/RSS。预算至少留 25% 工作集余量，首轮候选上限 192 MiB；字节估算与真实堆占用分别报告。
- **验收**：4× 仍没有遍历淘汰→下轮全文重读；只保留当前版本，删除生效，缓存有界。当前规模 sync 达规格 P2 中间目标；增长下的探针成本另列。
- **交审检查**：主审复跑一个增长样本，裁定 T1/T2 是否触发。容量不够立即在这里处理；不能提高上限掩盖问题或等 V2 才首次验证。若 sync 超预算但不是容量问题，在本阶段补小卡解决归因。

## 6. 基础任务卡：读路径与网页响应

### D1

- **写入范围**：`src/usage-store.js`、必要时 `src/server.js`及 store/server 测试。
- **实施**：实例修订覆盖实际用量/quota/perf 发布、home 和 service-tier evidence 的成功提交；例行时刻元数据不作为用量变化。用同连接 `PRAGMA data_version` 检出外部提交，失效并重载必要元数据；自身提交仍用显式修订。
- **验收**：无变化同步保留缓存；自身和另一连接的更改都使结果更新；回滚不伪造成功变更，事务内已读派生缓存安全清理；close/open 和 live/frozen 实例独立。
- **交审检查**：`node --test test/usage-store.test.js test/perf-store.test.js test/server.test.js`；主审复验外部提交和回滚各一次。先用简单实例标记，不造事件总线或多层 cache manager。

### D2

- **写入范围**：`src/usage-store.js`、usage-store/three-path-parity 测试。
- **实施**：完整 scope 的历史冠军按数据/价目/汇率/evidence/时区/规范排除集合 memo；每请求判断冠军是否完整落在当前范围。优先一条 memo，不直接增加今日 WHERE。
- **验收**：暖今日/week/month 不重复全历史计价；严格新高、并列、至少两期规则和范围边界正确；价目、历史修正、来源开关立即更新。保持 full/summary/dashboard/CLI 的有意差异。
- **交审检查**：`node --test test/usage-store.test.js test/three-path-parity.test.js`；主审复验并列与价格改变，不接受只比今日总费用。

### D3

- **写入范围**：`src/usage-store.js`、usage-store/server 的 quota 既有测试；server 测试先申请文件锁。
- **实施**：复用已提交 quota 观测的规范映射；窗口/stale/倒计时/reset 按当前或冻结 asOf 每次计算。只缓存静态输入。
- **验收**：同源跨 reset 和观测过期能变化；`quota_5h`/`quota_week`、暂停自动刷新/冻结保持时刻；新观测和外部提交立即更新。
- **交审检查**：`node --test test/usage-store.test.js test/server.test.js`；主审推进时钟而不改源，验证缓存没有冻结时间字段。

### D4

- **写入范围**：`src/usage-store.js`、usage-store/server 既有测试。
- **实施**：复用现有 metadataCache/periodComparisonCache，按实际变更失效；COUNT DISTINCT、home/model 集合不重复全表计算。保留 asOf、日历日、排除键和未来事件过滤，警告/身份按自身语义更新。
- **验收**：稳定同步后命中；更改数据、来源、跨日/周/月、未来事件、冻结和 live 都正确，period 响应 asOf 仍新鲜。
- **交审检查**：`node --test test/usage-store.test.js test/server.test.js`；主审复验跨日和未来事件边界；不新增维护计数表或缓存完整 HTTP JSON。

### D5

- **写入范围**：`src/usage-store.js`、perf-summary/perf-summary-parity/perf-store 既有测试。
- **实施**：rankedHomeIds 通过必要身份列/全局聚合取得，避免解码全量 sample JSON；沿用 partial/degraded 发布过滤，保留完整 summary.perf。
- **验收**：无今日样本但全局有可信样本的 home 仍正确；失败 home 的陈旧候选不入可信统计；四来源/所有 report 路径 parity 保持。
- **交审检查**：`node --test test/perf-summary.test.js test/perf-summary-parity.test.js test/perf-store.test.js`；主审核对全局/今日区别，并记录读路径阶段预算。

### Q1

- **写入范围**：profile/阻塞测量脚本和本卡报告；不改产品代码。
- **实施**：测当前 sync/发布、summary 读事务、metadata/period、序列化最长连续块；独立进程探测静态/轻量 API，分别记录 skipCheck 无等待和等待已有同步。
- **验收**：有慢样本、调用栈、最长块和端到端残余；单段 >200 毫秒有定位。主审明确 Q2 可以处理哪些块、是否需要 W 分支及确切工作/连接边界。
- **交审检查**：主审查看最慢请求与对应 profile；没有证据不启动执行器。同步搬走不能算解决 HTTP 侧 summary/纪录构建阻塞。

### Q2

- **写入范围**：定位出的 `src/usage-store.js`/`src/usage-core.js`，确需时 `src/server.js`；perf-state/server 测试。
- **实施**：仅在必要的事务外长循环，按约 8 毫秒工作预算 `setImmediate` 让出；保持来源稳定性验证。不在事务内 await，不把每 N 个文件当最大延迟保证。若已有路径已达标，本卡只验证，无需新增调度代码。
- **验收**：同步合并、错误/重试与快照语义不变；轻量 API p95≤100ms、max≤250ms。单次操作/事务仍超标时交明确 W1–W3 触发方案，不能宣称插入让出即完成目标。
- **交审检查**：`node --test test/perf-state.test.js test/server.test.js test/perf-server.test.js`和独立进程探针；主审检查所有新增 await 的事务位置。只有响应证据或条件分支收口后才释放 `G_RESP`。

## 7. 基础任务卡：客户端与最终验收

### U1

- **写入范围**：`public/i18n.js`、`test/i18n.test.js`。
- **实施**：observer 合并受影响子树任务；语言切换仍全页恢复/翻译，保留 WeakMap 和用户数据跳过。`formatLocalDateTime` 按实际 locale 复用 formatter。不以 zh-CN 判断跳过英文→中文恢复。
- **验收**：中→英→中、动态插入/属性变化、无效日期正确；无反复全页遍历和 observer 自激循环；现有用户数据不被翻译。
- **交审检查**：`node --test test/i18n.test.js`及一个真实页面动态插入；主审复验原文恢复。只改重复工作，不新增翻译系统。

### U2

- **写入范围**：`public/app.js`、app-render/app-toolbar/app-perf-mode 既有测试。
- **实施**：比较周期表最终输出，未变则不写 innerHTML；含语言/搜索/排序/状态。合并 window/ResizeObserver 更新，只盒子变化时重画图表，数据变化仍更新必要区块，先读尺寸再写 canvas。
- **验收**：同结果不重建表；排序/搜索/语言仍更新；一次 resize 不触发两轮整页 render；视图/主题/角色切换图表正确，焦点/滚动保留。
- **交审检查**：`node --test test/app-render.test.js test/app-toolbar.test.js test/app-perf-mode.test.js`及真实视口 resize 计数；主审核对当前 TPS 重构版本，不恢复旧分支、不新增拆表 API。

### U3

- **写入范围**：`public/perf-ui.js`、tooltip 确需时 `public/app.js`；perf-ui/app-render 既有测试。
- **实施**：复用实际需要的数值 formatter；tooltip 命中对象/内容变化才写正文，移动只定位，保留键盘行为。若当前 TPS 已替换实现，验证等效热点已消除即可。
- **验收**：数值/单位/locale 不变；同命中移动不改正文，新数据同命中会更新；键盘、主题和隐藏/重新显示正确。没有残余证据不加命中索引。
- **交审检查**：`node --test test/perf-ui.test.js test/app-render.test.js test/app-perf-mode.test.js`及浏览器 pointer/keyboard 计数；主审确认收益与范围相称。

### U4

- **写入范围**：`public/app.js`、`test/app-autorefresh.test.js`；仅检出明确契约缺陷时另申请 server 文件锁。
- **实施**：检查实际 60 秒循环：changed/手动刷新继续检查，quota 时钟重算正确。只有已经完成等价内容校验的周期才用 skipCheck；无法证明 status 覆盖同元数据改写时保留现有周期内容检查，依靠增量同步减成本，不另造强校验定时器。
- **验收**：today、两个 quota 预设各至少三个确定性周期，覆盖 changed=false/true、同尺寸改写、WAL、reset、切范围、暂停/恢复、已有 sync 重叠；至少一次真实 60 秒周期验证接线。源检查/时钟重算/实际同步分别计数。
- **交审检查**：`node --test test/app-autorefresh.test.js test/app-toolbar.test.js`及浏览器周期记录；主审确认没有以少查来源或关闭自动刷新换取性能。

### V1

- **写入范围**：集成验证脚本、fixture 及本卡证据；发现产品问题退回对应卡，不在验收卡顺手修多个模块。
- **实施**：对规格 §9 的 A–G/K 正确性部分联合检查：四来源/所有范围与报告、失败隔离和恢复、迁移/删除/事务错误、价目/汇率/evidence、跨日/reset、live/frozen、并发与自动刷新。先复用已有测试，把新增案例放在对应既有文件。
- **验收**：固定 now/价目的完整业务结果与原版等价；差异白名单仅含预期时刻/诊断字段，费用/告警/纪录/覆盖率不得忽略。新增组合有最小失败反例可重跑。
- **交审检查**：主审复跑一个跨模块链路，如坏线程恢复→价目变化→冻结/并发，核对接受版本摘要。任何必测缺口明确返工，不写“基本通过”。

### V2

- **写入范围**：最终测量数据/profile/截图、本卡报告；产品代码冻结。
- **实施**：规格 A–K 的计时和增长/内存部分：今日默认/skipCheck、单线程追加、同步期间轻量请求、已有库/新库冷态、1×/2×/4×、50 次重复刷新及 PC 浏览器。只跑一套重型测量，不与其它基准抢 CPU/I/O。
- **验收**：逐项达到规格绝对目标，完整保留慢样本；计数证明稳定源无全文解析/发布，今日暖读无重复全历史计价；探针增长、容量和 GC 后 heap/RSS 有实际证据。浏览器区分网络、脚本、布局与实际可用时刻。
- **交审检查**：主审抽取最慢样本复跑，并检查真实自动刷新和 active-source 观察是否另列。目标未达，回开对应卡/条件分支，不修改目标或用暖态代替冷态。

### V3

- **写入范围**：最终报告、本计划任务表、`docs/00-index.md`、`docs/02-tasks.md`；行为改变时 `docs/03-development.md`、`docs/12-dashboard.md`。
- **实施**：worker 在最终集成快照跑一次 `npm.cmd test`、`npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run format:check`，写验证报告；主审更新任务表和文档入口。检查每文件最后一次接受的摘要与受测版本一致，早期卡的行为由必要定向回归覆盖；核对还原点/迁移回退/服务生命周期。
- **验收**：失败区分本轮回归、既有失败和环境 skip，skip 不算通过；报告包含 before/after、冷暖/规模边界、恢复、响应、内存及未达项目。全部必做和触发分支通过才标整轮完成。
- **交审检查**：主审负责最终裁定；套件通过后不无理由重复全仓检查。后续改动只重跑受影响检查并更新摘要，实际服务切换遵循用户当时授权和原生命周期，不因本计划自动切换。

## 8. 条件任务卡：证据触发才实现

### T1

- **触发**：C6 全量容量无法在有界 RAM 内维持稳定命中，或遍历淘汰导致反复全文解析。主审先接受一页具体设计：私有表/键/版本、写入事务、兼容与回退、预计文件；不提前建框架。
- **写入范围**：`src/usage-store.js`、必要的 schema/投影测试。复用现有迁移方式，保存规范投影和明确失败信息，区分尝试与发布，不缓存 raw JSONL。
- **验收/交审**：旧库迁移、失败中断和重开安全；方法版本变更只失效必要投影、不无条件标脏全库。旧程序兼容或回退策略明确，不能用旧备份覆盖迁移后新增业务数据。主审复验迁移故障，再派 T2。

### T2

- **写入范围**：T1 文件以及 `src/usage-core.js`/Codex planner 的实际接入点；Codex-index/perf-store 测试。
- **实施**：稳定键查询先走有界 RAM，再用私有持久投影；改变文件才重新全文读取。原子更新/删除、只读投影、失败恢复和方法失效沿用 C 卡契约，不造多级缓存库。
- **验收/交审**：1×/2×/4× 全量复验，重启/冷态边界另列；暖解析为零且内存有界，发布前来源仍新鲜。主审确认 C6 缺口闭合才释放 `G_CAP`。

### W1

- **触发**：Q2 后仍有超预算同步块，静态/轻量 API 未达标，且定向优化不能满足目标。主审先接受具体待移工作、单写者/查询者角色、私有消息和连接归属；若症结是 HTTP summary，边界必须覆盖它。
- **写入范围**：`src/server.js`、复用 `UsageStore` 的最小接入点；确需时一个私有执行器入口文件；server/perf-server 测试。
- **实施**：只建一个 worker 或子进程，复用现有模块；数据库连接归执行器独占，不跨线程共享 `DatabaseSync`。已有 syncPromise 合并继续有效，手动刷新等待真实完成，不在候选发布中途回复成功。
- **验收/交审**：一条正常刷新链路与并发合并可运行；HTTP 轻量请求能在工作期间响应。主审检查边界覆盖被测慢块；W2/W3 完成前执行器方案不交付为完整修复。

### W2

- **写入范围**：server/执行器/必要 store 接入点，server/perf-server/perf-summary-parity 测试。
- **实施**：HTTP 私有读连接只读已提交视图；homes/evidence/warnings 和派生缓存按已提交修订同步。freeze/snapshot/asOf/full 保持契约，已有 SQLite backup 继续保证一致性。
- **验收/交审**：live 新内容和旧冻结并存、partial/坏线程隔离、价目变化与并发读等价；无读到半发布状态或过期告警。主审复跑一条冻结与发布重叠链路。

### W3

- **写入范围**：W1/W2 文件与故障/关闭测试、本卡证据。
- **实施**：最小崩溃重启、在途错误返回/可重试、初始化和关闭清理；重用原服务生命周期，不加调度池、通用 RPC 或无限重试。
- **验收/交审**：同步/查询期间故障可恢复，退出无连接/进程泄漏；独立进程轻量响应、skipCheck 两类和完整端到端重新测量。主审确认全部 W 卡及必要 D 卡缓存边界后释放 `G_RESP`。

## 9. 派工与单卡证据模板

实施时创建 `docs/validation/2026-10-09-refresh-performance-fix/<runId>/`，`runId` 使用本地时间且不复用旧诊断目录。本轮只提供模板，不创建虚假的执行记录。每卡一个 `handoffs/<卡号>.md`，重交审追加一轮证据和主审结论，不覆盖之前的失败记录；数据/日志放同卡目录即可，无需每阶段另造模块总报告。

主审给 worker 的派工消息可直接用：

```text
执行卡 <ID>，只完成该卡范围。
前置：<已接受卡的报告/摘要>；工作目录与开始摘要：<...>。
允许修改：<文件列表>；锁归你，超出范围先汇报。
验收：<本卡关键成功行为、关键反例、计数/性能目标>。
预算：<预计时间>；遇到冲突/升级立即反馈，超时先交诊断检查点。
完成后提交 handoff 并发送 REVIEW，等待主审 ACCEPTED 或 REWORK；不自行开始下一卡。
```

单卡交接仅保留必要证据：

```md
# <ID> — <卡名>
状态：REVIEW；worker：<名称>；工作目录/运行日期：<...>
前置接受记录：<链接及关键摘要>
受测版本：<HEAD + dirty 清单/文件 SHA-256；不能只写 HEAD>
实际文件与开始→结束摘要：<含新建/删除，附仅本卡差异>
实现行为：<接入点、关键接口/失效/事务边界；纯测量填输入与口径>
检查：<完整命令、exit、关键行为与计数/样本，证据路径>
未测/失败/边界：<明确列出，无则写无>
还原：<本卡逆向差异或归档引用；不覆盖其它 worker 改动>
下一卡输入：<已稳定接口、需要重跑的检查>

主审结论：<ACCEPTED 或 REWORK；reviewer、时刻、复跑证据、接受摘要>
返工要求：<复现步骤、实际/预期、具体验收项；通过时写无>
```

主审回复示例：`ACCEPTED C2，受测摘要…；坏→复用→修好链路和告警计数已复验，允许 C3 接续。` 或 `REWORK C2：同 home 坏文件第三轮告警消失；复现…，预期…；补该回归后重新交审。`

某张卡通过不替代全局验收。正式收口以 V3 裁定为准；恢复、性能和业务等价都必须对应最终集成版本。
