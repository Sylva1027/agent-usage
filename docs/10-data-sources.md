# 数据来源与统计口径

更新：2026-10-21（新增 WorkBuddy 来源）。本文维护共同规则；各来源的字段映射分别见下方专题。

## 来源与导入

- [Codex](data-sources/codex.md)：默认 `~/.codex`，读取会话 `.jsonl` 和 `.jsonl.zst`，并探测本机 JetBrains 集成目录；`CODEX_USAGE_HOMES` 可追加 Codex home。
- [ZCode](data-sources/zcode.md)：默认 `~/.zcode`，依次探测 `cli/db/db.sqlite`、`db/db.sqlite`。
- [DSH](data-sources/dsh.md)：默认 `~/.dsh`，读取 `sessions/<cwd-slug>/<sessionId>/session.v<N>.jsonl.zstd`。
- [OpenCode](data-sources/opencode.md)：探测 `~/.local/share/opencode`、Windows APPDATA/LOCALAPPDATA 和 macOS Application Support 下的目录，再展开目录中的 `opencode*.db`。
- [Claude Code](data-sources/claude-code.md)：默认 `~/.claude`（并发现 `CLAUDE_CONFIG_DIR`），读取 `projects/<cwd>/<sessionId>.jsonl` 与 `projects/<cwd>/<sessionId>/subagents/agent-*.jsonl`，按 `message.id` 去重。
- [WorkBuddy](data-sources/workbuddy.md)：默认 `~/.workbuddy-ai`，读取 `projects/<cwd-slug>/<sessionId>.jsonl`，按 `providerData.messageId` 去重；响应时长另取 `traces/<pid>/trace_*.jsonl` 的 `generation` span。Auto（`model=default-model`）记录整体排除。
- [项目日志](14-project-log.md)：导入包含 `.codex-usage/usage.jsonl` 的项目目录。

看板导入的是 home、数据目录或项目目录，不直接导入单个数据库文件。显式导入目录先按 ZCode、DSH、OpenCode、Claude Code 的具体结构判定，再检查 Codex 和项目日志，避免同名 `sessions` 目录误判（`~/.claude/sessions/` 与 Codex 的 `sessions/` 同名，Claude 必须先判）。

WorkBuddy 的判定必须排在 Claude Code 之前：两者都是 `projects/<cwd-slug>/<sessionId>.jsonl` 结构，只能按内容区分。探测只看最多 3 个会话文件的前 64 KiB，出现 `"type":"session-meta"` 或 `"type":"function_call"` 即判为 `workbuddy-home`；目录形状相同但内容不符时仍按 Claude Code 判定。

追加来源分别使用 `CODEX_USAGE_ZCODE_HOMES`、`CODEX_USAGE_DSH_HOMES`、`CODEX_USAGE_OPENCODE_HOMES`、`CODEX_USAGE_CLAUDE_HOMES`、`CODEX_USAGE_WORKBUDDY_HOMES`；多个路径使用系统分隔符（Windows `;`，macOS/Linux `:`）。设置 `CODEX_USAGE_ZCODE=0`、`CODEX_USAGE_DSH=0`、`CODEX_USAGE_OPENCODE=0`、`CODEX_USAGE_CLAUDE=0`、`CODEX_USAGE_WORKBUDDY=0` 可关闭对应的自动发现；显式导入是独立路径，不能把这些开关当成禁止导入策略。`CODEX_USAGE_IMPORT_DIRS` 可提供额外导入目录。

## 统一事件口径

标准事件携带时间、会话、来源、渠道、模型、仓库归属、Token 数量和已知明细标记。`total` 保留来源提供的可信总量或来源适配器明确构造的总量；缺失与真正的 0 分开处理。

看板按以下子集关系使用明细：缓存命中属于总输入，推理属于总输出，缓存写入作为独立计价明细记录。来源的原始计数若为并列关系，适配器须先重构；不能用缓存命中输入再次增加总量，也不能把独立推理输出漏出总输出。

`validateUsageDetails()` 校验明细与总量关系；不一致时撤销不可信明细并保留差额标记。费用端随后选择适用估算，见[计价](11-pricing.md)。这不是把缺失数据补零或从正文估算 Token 的许可。

DSH 当前非零缓存写入边界尚待核实，不能把“所有适配器都完整满足输入超集关系”作为已验收事实，见[任务清单](02-tasks.md)。

## 历史输出吞吐（TPS）

TPS 是基于历史结构化记录的输出吞吐统计，不是 TTFT，也不是纯解码速度。单样本按 `outputTokens * 1000 / durationMs` 计算。Codex 的 `tps-v2` 对同轮全部已识别请求求完整端到端时长之和，分子与分母严格覆盖同一集合；缺任一计时整轮不采样，不使用旧 item span 补缺。计时须显式离线导入已审 producer 批次，正常 summary 不访问网关。ZCode、DSH 使用来源记录的请求窗口，OpenCode 使用 `streamed-created`，排除流结束后的工具处理。WorkBuddy 使用 trace 的显式 generation duration，并持久保留异值冲突。Claude 使用转录时间戳回退（`timingSource=timestamp_fallback`）：同一 `message.id` 末行减有效 user/attachment 锚点，同轮续写不采样；既有采样集比用量事件少 597 output token（0.0137%），不从面板用量总数删除这部分。各来源均计入其请求窗口内的等待。

代码中的统计内核版本为 `tps-v2`；正式服务是否已加载新方法以实际 API 为准，验收状态见[主审整合记录](validation/2026-10-21-tps-measurement-correction/review/final-integration/README.md)。来源、来源实例、渠道、代理类别/名称、模型、provider、effort、计时方法、token 范围和窗口共同决定旧 `groups` 分组；组内报告最近秩 p10/p50/p90、n、时长分位与 pooled（总输出/总时长）。Codex 的 n/分位仍按轮，不能与请求级分位当成同粒度稳定性比较。旧 groups 的 `n < 20` 不获排名；样本只取已完成且输出和时长均为正的候选，溢出不伪造数值。

`summary.perf.models` 供独立模型速度区域消费：同一过滤、去重和sampled集合按 `[sourceKind, model, reasoningEffort, modelProvider]` 聚合，同provider仍合并home、渠道与主/子代理；空provider保持未知，不从名称推断。平均速度仍为总输出乘1000除以总时长，p10/p90仍取同集逐条TPS最近秩。行含实际成员首末日期、window与rankState；eligible先于参考行，溢出最后，各段按未舍入均值降序、key决胜。编号要求原有已审时间/输出范围准入，并满足有效meta.minSamples（默认20）；rankState优先级为overflow、unverified、insufficient_samples、eligible。DSH/ZCode输出范围未知，OpenCode/WorkBuddy缺逐样本来源版本证明，保留参考统计但不编号；混合单位不排名。旧Codex估算只留诊断，不进入模型总览。空模型不生成行，溢出不伪造数值。验收与限制见[修复账本](validation/2026-10-23-tps-remediation/README.md)。

`summary.perf.codexTimingCoverage` 单列当前方法Codex的同范围覆盖，沿用来源排除及健康发布过滤：counts复用候选/采样/互斥丢因/pending/unplaced；recordedOutputTokens只累加已知非负输出，sampledOutputTokens为可采样子集，unknownOutputCandidates单列未知输出。两个安全整数和独立溢出为null。没有适用Codex来源为null，已配置但范围无候选为零计数；rebuilding/uninitialized不发布假覆盖。全历史unplaced不纳入当前范围分母。旧coverage及groups不变。

coverage 分开表达 `eligible`、`sampled`、`dropped`、`pending` 和 `unplaced`。对可定位候选，恒等式为 `eligible = sampled + dropped + pending`；缺时间的 `unplaced` 作为所选来源的全历史诊断，不进入当前日期范围分母。没有样本的来源只报告诊断，不合成 0 TPS。未知来源格式、无法唯一归属、读取错误、来源变化及发布失败按 warning/degraded 状态显式呈现；Codex 对可靠归属的坏线程整线程隔离，未知或含糊边界 fail closed。TPS 候选与普通用量事件分开存储和汇总，不增加 `totals`、费用、时间线或限额统计。

默认及 dashboard 用量响应、`/api/summary` 和 `detail=full` 的 `summary.perf` 携带性能聚合与公开状态。内部 `perfSamples/perfMeta`、sampleKey 与物理来源路径不序列化到公开 report；full 提供的是原有用量明细，并非 TPS 候选明细。冻结查询绑定当时索引，后续同步不会改变已冻结的统计；full 走 live 内存路径，不能与 freeze/snapshot 组合，明确返回 `SNAPSHOT_FULL_DETAIL_UNSUPPORTED`。来源变化或事务失败时保留旧数据用于恢复，并按发布 policy 排除失败线程，不能让旧样本继续排名。公开 `indexVersion` 反映已发布统计及告警的变化。具体验收与残留见[最终审核包](validation/2026-10-04-perf-metrics/20261004T035100/final-audit.md)。

## 统计范围与限额

普通今日、本周、本月、全部、自定义日期和普通最近范围统计所有已选来源。`5h / week` 限额按钮以及“上一个 5h”“上周”只统计 Codex 来源；边界来自实际限额观察值，缺失时不猜测。

限额能力依据来源 kind 判断，不依据渠道显示名称。项目日志即使把 `channel` 写成 Codex，也不会因此获得 Codex 限额资格。ZCode、DSH、OpenCode、Claude Code 和 WorkBuddy 不参与 Codex 限额窗口。

## 渠道展示与归组

普通范围将 Codex Desktop、Editor Integration、CLI、Codex Exec、codex_work_desktop 归入 Codex，ZCode Subagent 归入 ZCode，DSH Subagent 归入 DSH，OpenCode 保持独立，Claude Code 与 Claude Code Subagent 归入 Claude，WorkBuddy 归入 WorkBuddy。来源 kind/homeId 的证据优先，明确旧标签作兼容回退；未知自定义渠道没有来源证据时保留原名。当前和上一完整 Codex 5h/7d 限额范围保留原渠道。

归组在汇总与时间线展示时完成，不改写事件 channel；计价继续使用原始标签。合并会话按唯一 ID 去重，不直接相加分渠道会话数。内存报告、SQLite 与浏览器纯统计共用 timeline-utils 中的归组规则。

## 增量索引与版本

默认索引位于 `~/.codex-usage/usage-index.sqlite`。JSONL/zstd 按文件大小和修改时间检测变化；ZCode/OpenCode 的指纹包含主库和 `-wal`。DSH 按日志文件展开，OpenCode 按数据目录下的多个数据库展开，Claude Code 按 `projects/**/*.jsonl`（含 subagents）展开，WorkBuddy 按 `projects/**/*.jsonl`（跳过 `tool-results/`）展开。

变化来源通过 `replaceFile` 替换对应事件，未变化来源保留索引。模型元数据按 Codex、ZCode、DSH、OpenCode、Claude、WorkBuddy 分组；项目日志的渠道名称按现有分组规则处理，不改变其限额资格。

WorkBuddy 的计时是独立输入：普通 `sync` 每轮对每个启用 home 预扫 trace，复用未变化文件的进程内指纹，把新 distinct duration 写入 home-scoped observation 表，并定位受影响会话重建。预扫发生在 `replaceFile` 事务之外，不把 `await` 拉进写事务。trace 集合与已解析计时参与 memory/store 性能版本及读取稳定性检查；删除 trace 不遗忘已知时长或冲突。

当前代码 `STORE_SCHEMA_VERSION` 为 19。11→12 增加 TPS 样本表，12→13 增加 Codex rollout 依赖，13→14 增加投影表；14→15 登记 Claude，15→16 更正 Claude 线路模型并定向重扫；16→17 登记 WorkBuddy 和旧无 home 时长表；17→18 增加 Codex 请求计时证据与 dirty 线程；18→19 增加 WorkBuddy home-scoped duration observation。旧无 home 行保留，不猜归属回填；多 home 不借用，单/多模式变化重建相关候选。迁移短事务执行，保留用量/费用及原始来源；证据导入不等于候选发布，性能版本用成功消费 dirty 的事务内发布序号表达部分成功。无需手动删除索引；本机 3765 正式服务已于 2026-10-21 切换至 schema19/tps-v2，并导入原六轮 326 条审核计时；其他安装仍由首次打开执行迁移。

## 读取与数据边界

标准事件提取用量和必要元数据，不把 prompt、响应正文、工具参数或密钥作为事件字段。原始文件和 JSON 解析过程中可能包含正文，不能将“输出不含正文”写成“原始正文从不进入内存”。

SQLite 适配器优先只读打开；当前 ZCode/OpenCode 在只读打开失败时会退回普通打开，可能触发 SQLite 恢复或辅助文件操作。应用不主动修改上游业务记录，但不能承诺文件系统层面的绝对零写入。严格对照应使用可靠的一致快照，而不是顺序复制正在写入的 db/WAL 后假定二者一致。

上述回退属于普通用量 reader。新增 TPS 的 ZCode/OpenCode reader 严格只读，打开失败即报告错误，不回退可写连接，并在 SQL 中只投影性能所需标量；不能把普通用量 reader 的限制或保证套到性能路径。真实来源验收绑定完整冻结副本与 source-start 清单，逐文件采集不等于 live 目录的原子时刻；未来来源变化仍触发 `LIVE_SOURCE_CHANGED` 并拒绝发布。

索引和验收日志可能包含模型名、会话元数据与本机路径；分享前检查实际产物。自动价格请求只读取公共来源，不上传本地用量，详见 [11](11-pricing.md)。

## 接线与回归

新增来源要同时核对 `usage-core` 的分类/发现/指纹/事件分派、`usage-store` 的文件展开与元数据、服务器导入标签、前端 harness 分组、非 Codex 限额排除、i18n 和 README。来源测试、索引测试与三路一致测试分别覆盖语义和接线；真实来源 UI 验收独立记录。
