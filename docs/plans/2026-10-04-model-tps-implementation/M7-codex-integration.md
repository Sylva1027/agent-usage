# M7：Codex 跨 rollout 索引与估算接入

前置：M4.6 三源共享链路、M6.4 JSONL 候选引擎及附加 SQLite 决议。此模块由**一个集成者串行拥有** `src/usage-store.js / usage-core.js / server.js / perf-sources/index.js` 及必要 UI Codex 文案；不得与 M3/M4/M5 在同文件同时写。新测试固定为 `test/perf-codex-index.test.js`、`test/perf-codex-api.test.js`。主目标是一次线程重建涵盖同 `(homeId,threadId)` 的全部 rollout，不按物理文件各自算一次轮。

## M7.1 新 schema 版本与跨文件依赖

再次核对实际 `STORE_SCHEMA_VERSION`，以**下一个空闲字面版本**迁移。新增 `perf_sample_sources(sample_key,source_path,role)`：`sample_key` FK `perf_samples ON DELETE CASCADE`、`source_path` FK `source_files ON DELETE CASCADE`，PK `(sample_key,source_path)`，按 source_path 建反查索引。另建辅助 `perf_rollout_threads(source_path,home_id,thread_id)`，保存一个 rollout 的稳定线程归属，即使该文件尚未形成可统计样本也可定位后续新增/删除影响；同样 FK 到 `source_files`，主键按 source_path，按 `(home_id,thread_id)` 建索引。两表只保存内部身份/路径，不进 API。

现有 `perf_samples.source_path` 仍是单个主归属文件；Codex 候选同时登记该线程**所有**参与的 rollout 路径为依赖，不能只登记最后 token 文件。若 M6.4 决定启用附加 SQLite，作为**整个产品版本的统一决议**另建 `perf_aux_sources(path,home_id,role,size,mtime_ms)` 与 `perf_sample_aux_sources(sample_key,aux_path)`，分别保存辅助库主文件+WAL 指纹与候选依赖；**不得**把 state/history 库插入普通 `source_files`，否则现有 `nonCodexHomeIds()` 会把 Codex home 错判为非 Codex。若不启用附加库，不建这两张空表；不能同一 schema 版本按用户机器形成两种结构。新迁移对 Codex source_files 标记重索引；三源候选不重复增殖，三源的单文件写路径继续正常。测试从上一版索引升级、迁移失败回滚、FK 删除、两个 home 同 threadId 不碰撞。

## M7.2 受影响线程规划器

在 sync 对 Codex 文件执行更新/删除**之前**，通过旧 `perf_sample_sources` 与 `perf_rollout_threads` 取受影响 `(homeId,threadId)`；新/改文件用 M6.1 的小型 session_meta 投影取新身份，旧/新身份都列入重建集合。新增 rollout 即使旧样本没有引用，也必须触发所属线程重建；归档移动视旧路径删除+新路径添加，但同一线程最后只能保留一份候选。

规划器为每个受影响线程列出本次发现的所有当前 rollout（含 archived_sessions），先按物理路径排序并核对只读可访问；仅已确认属于同一 home/thread 的文件进入同一个 `buildCodexThreadPerfSamples` 调用。附加 SQLite 若启用，其主库/WAL 指纹变化时从 `perf_sample_aux_sources` 找旧受影响线程；新辅助库或无法定位局部变化时保守重建该 Codex home 的全部线程。同时让现有 `buildUsageFingerprint` 在该产品版本把附加库主文件+WAL 的状态纳入同一次来源指纹，使 `/api/status?since=` 能发现**仅辅助 WAL 改变**；M4 的内存/索引 `indexVersion` 都用这个扩展后的指纹。任一必需 rollout 无法读、格式不支持或扫描时变化，硬阻塞该 home 排名，不用可读子集冒充完整轮；可选辅助库失败则保留完整 JSONL 候选、标软降级 warning，代理缺证据归 unknown。记录计划中旧/新文件集合的**脱敏数量与指纹**，不输出原始路径/ID。

验收：新文件承接旧轮、旧文件内容替换、删除一份依赖、同路径线程 ID 改变、归档移动、不同 home 同 ID、无样本但有 mapping 的线程；每案受影响线程集合必须精确。

## M7.3 线程候选与依赖的事务重建

先在内存阶段构造受影响线程的**完整**候选/依赖及 warning，不能边读文件边删除旧线程样本。现有逐文件 `replaceFile()` 可先更新 events，但 perf 状态在整个 sync 期间保持 `rebuilding`；**源文件删除延后**至线程候选已成功 staged。随后 `BEGIN IMMEDIATE`：按 `(homeId,threadId)` 删除旧 Codex perf 候选及依赖，更新 `perf_rollout_threads`，处理延后的 `source_files` 删除，插入新候选及全部依赖，写发布状态/指纹，最后 COMMIT。任一步失败 ROLLBACK，旧性能候选与其依赖保持一致，状态为 degraded/rebuilding，不对外标 ready；不能因源行先被 FK 级联删掉而丢失回滚能力。

附加 SQLite 若 M6.4 启用，必须在同一事务更新独立主库+WAL 指纹和候选依赖；仅 WAL 变化也触发受影响线程。没有启用时不扫描附加库。完成后固定 fixture 验证同轮跨 2–3 文件只一候选、替换/删除/归档/失败回滚/重复 sync 幂等、依赖数量与实际输入文件相等；旧 events 用量不能重复插入。`perf_index_version` 仅在本次完整 sync 结束后与事件发布的来源指纹一起更新。

## M7.4 内存报告、API、页面与估算诊断

`buildUsageReport()` 对 Codex home 按线程聚合文件，调用 M6 候选引擎一次/线程；不能沿用 M4.1 的单文件 dispatcher 逐 file 输出轮。由本模块所有者把跨 rollout Codex 数据扩进 `test-support/perf-fixture.mjs`，保持既有三源 fixture 输入/预期不变。`UsageStore.summarize` 读索引候选后继续调用同一 `summarizePerf`。两个路径对固定跨 rollout fixture 的 groups/coverage 一致；`/api/usage?view=dashboard`、`/api/summary`、`detail=full` 和冻结快照都可见 Codex 估算且 snapshot 不随 live 追加变化。

UI 的 Codex 行必须标 `estimated`、单独 timingKind 排名池、展示 recent/legacy 的有跨度/完整/有效率；按实际数据 `n<20` 可全部落入样本不足区，不能为凑排名放宽完整性。`sourceWarnings` 对附加源不可用、部分 item、旧时段缺跨度清楚区分。最后使用固定 fixture 验证：完整多请求长轮仍有效，partial/冲突/未完成剔除，未知 agent 不叫主代理，ZCode/DSH/OpenCode 结果不因接入 Codex 变化；若启用附加库，还须验证仅 WAL 改动使 `/api/status` 变化、旧冻结快照保持。`M7.md` 必须附 SQL 事务顺序、受影响线程矩阵、API parity 和浏览器证据；模块完成后才进入 G3。
