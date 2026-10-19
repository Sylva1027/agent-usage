# M4：内存/索引汇总、API 与三源逐个接线

前置：M1.3，M3.3；ZCode 垂直切片还需 M2.1。模块集成者唯一写 `src/usage-core.js / src/server.js / src/cli.js / src/perf-sources/index.js`；需要改 `src/usage-store.js` 时先与 M3 所有者串行交接。测试文件 `test/perf-summary-parity.test.js`、`test/perf-server.test.js`。`summarizeUsageIndex(index)` 与浏览器导出 `summarize(report)` 仍只承担既有用量 parity，不为 TPS 扩出第三、第四套统计实现。

## M4.1 内存报告候选载体

在 `buildUsageReport()` 完成现有事件收集后，按**同一 `homes` 列表**使用 `streamPerfSamplesForFile` 逐物理文件收集 `perfSamples` 与编码 `perfWarnings`；发现路径沿用 ZCode usageLogPath、DSH `dshSessionFiles`、OpenCode `opencodeDatabaseFiles`、Codex `discoverSessionFiles` 的现成逻辑，不发明新 home。首版 dispatcher 只开 ZCode。独立再次只读扫描源可接受，但不能复用 ZCode/OpenCode 旧 reader 的可写兜底。某 home 报错只将该 home 标 degraded，其他源继续；`UsageReport` 增加 `perfSamples/perfMeta`，`report.events` 与旧 CLI JSON 字段不变。

同一 homes 列表在候选读取前后各算一次 `buildUsageFingerprint`；相同时把指纹作为内存 `perfMeta.indexVersion`，不同时 `perfMeta.state='degraded'` 并记录 `LIVE_SOURCE_CHANGED`；不能宣称内存/索引跨 live 数据严格数值相同。固定 fixture 上必须完全相同。内部 `perfSamples.sourcePath` 只用于归属，不得带正文/工具内容；公开输出由 M4.3 脱敏投影。

> **2026-10-05 口径修订（复核2 §1 要求同步；接受方裁定，原文保留供审计）** —— 上一段"同一 homes 指纹不同即 `state='degraded'` + `LIVE_SOURCE_CHANGED`"**不再是内存路径的判据**。现行口径（M4.1 返工1 + 返工2，两轮独立复核共同确认）：
> ① **`indexVersion` 只描述已启用的性能来源**（与 M3.4 `perf_index_version` 同口径；`usage-store.js:660` 明文"未启用来源不影响…不入聚合"）——未启用来源（如 Codex rollout）在读取期间变化**不**使稳定的 TPS 版本失效，也**不**令任何已启用 home 退化；
> ② **归因必须有该 home 自己的证据**：`degradedHomeIds` / `sourceWarnings` / 排名排除只能来自该 home 的**读取失败**或**它自己的内容指纹变化**；禁止"全局指纹变了就连坐所有 home"（复核 P1 已否决该做法）；
> ③ 用量全局指纹的前后比较**仍然保留**，但只作**诊断轴**写入 `perfMeta.usageFingerprintStable` —— "用量诊断不能替代性能来源的整轮验证"（复核2 §1）；
> ④ 检测必须用**内容指纹**（`size:mtimeMs:sha256(首尾各 64KiB) 前 32 位`，与 M3 同源），并在**整轮候选读取开始前**与**全部读取结束后**（结束时**重新发现**文件集合）逐 home 核对 —— 覆盖"先读完的 home 在后续读取期间被改写"。
> 下游（M4.2/M4.3）**不得**按旧口径实现"用量指纹一变就 TPS degraded / 版本不可发布"。

## M4.2 两条生产汇总路径

`summarizeUsage(report,filters)` 在现有 `resolveDateRange` 后调用 `summarizePerf(report.perfSamples,context)`；`UsageStore.summarizeInReadTransaction(filters,...)` 在已确定同一个 `range`/`scopeExclusions` 后调用同一函数，候选来自 `perfCandidatesForRange`。两端 `summary.perf` 的 `groups/coverage/methodVersion` 和所有计数相同，SQLite 不能另写百分位。`includeDetails=false` 只门控原有重详情，不删 perf 组或覆盖率。`state=rebuilding` 时不返回部分排名；`degraded` 时按 M3.4 排除受阻 home 并显示告警。

限额筛选继续使用现有 `quotaPreset` 判定与非 Codex home 排除；同一来源是否有样本不改变其限额资格。范围和来源过滤先统一作用于候选，再作分组；`knownSources` 包含未启用来源和 project-log 的 unsupported 标记。`summary.perf` 不影响 `totals/channels/models/timeline`。测试固定 fixture 中普通、custom、UTC、quota、excludeHome、n=0、unplaced 和 dashboard 详情门控。

## M4.3 两个 API 与冻结快照

`/api/usage` 默认与 `view=dashboard` 返回完整 `summary.perf`；`/api/summary` 返回同形状。`/api/usage?detail=full` 的内存汇总也返回同形状，`withoutExcludedHomes()` 必须同时过滤内部 `perfSamples` 或把过滤严格传给统计函数。计算 summary 后调用 `toPublicUsageReport(report)` 只投影原有公开 report 字段；`src/cli.js` 的 `codex-usage json` 也用它，不能把内部 `perfSamples`、`sampleKey/sourcePath` 和原始线程 ID 序列化出去。公开 report 的来源排除仍按原逻辑。正常页面入口是 `/api/usage`，不能只测 `/api/summary`。

冻结路径 `createSnapshot()` 继续先等 `loadUsageStore()`，backup 同一 SQLite 的 events、perf、store_meta，固定同一个 `asOf`；后续 live 文件变化不能影响旧 snapshot 的 groups/coverage/meta。snapshot id 过期保持 410 和现有恢复，不加新独立 perf 缓存。测试覆盖 freeze 前后 ZCode 追加、dashboard/full/summary 响应字段与被排除 home、旧 snapshot 不变；`detail=full` 的低内存 413 原行为保持。

## M4.4 ZCode 垂直切片验收

在 `test-support/perf-fixture.mjs` 建 `createPerfIntegrationFixture({sources=['zcode']})`，只在唯一临时目录造固定时间的源文件/索引，返回 `{reportOptions,serverOptions,expected,fixtureHash,close}`；`expected` 的分位与 coverage 从 M0.6 的手算清单转入，不调用产品统计函数生成预期。`close()` 可重复，递归删除前校验路径仍在本测试临时目录下。先用临时 ZCode SQLite fixture 同时跑 `buildUsageReport→summarizeUsage`、`UsageStore.sync→summarize`、`/api/usage`、`/api/summary`、freeze。手算 1–2 个组的分位和 pooled，断言 eligible 分解与过滤前后差异、未知 agent 不叫 main、缺 TTFT 不影响样本。真实只读来源只作日期快照复核，不要求全部 3×4 组合存在。交接 `M4.4.md` 标出 fixture 摘要与 UI 接入前的 API 证据。

## M4.5 DSH 注册与 parity

前置：M2.2/M4.4。只由本模块所有者在 dispatcher 注册 DSH，并为共享 `createPerfIntegrationFixture({sources:['zcode','dsh']})` 扩充固定 zstd 多帧数据；复用 M4.1 物理文件发现与 M3 的同一表/事务，禁止 DSH reader 自己写 store。合成 fixture 的内存/SQLite/API 完全一致；坏帧时该 home degraded，不删其他源；同 turn 同 step 与两个会话重复编号不碰撞。真实来源检验 `step/start→assistant/message` 的输出/时长口径，输出带指纹诊断，不硬编码 n。

## M4.6 OpenCode 注册与 parity

前置：M2.3/M4.5。dispatcher 注册 OpenCode，并把 v1/v2 多数据库场景扩进共享集成 fixture；按现有多数据库展开，每库主库+WAL 指纹触发替换，严格只读。v2 的 output+reasoning 只加一次；缺 completed、v1、版本未知的判定与 M0 决议一致。合成 fixture 验证同 home 不同数据库同 message.id 不碰撞、内存/SQLite/API 数值一致、WAL-only 更新、只读失败单 home 退化。模块出口 `M4.md` 核对三个来源的全链路、两个 API 与 freeze；共有文件此后交 M7 Codex 集成者。
