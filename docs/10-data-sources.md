# 数据来源与统计口径

更新：2026-10-20。本文维护共同规则；各来源的字段映射分别见下方专题。

## 来源与导入

- [Codex](data-sources/codex.md)：默认 `~/.codex`，读取会话 `.jsonl` 和 `.jsonl.zst`，并探测本机 JetBrains 集成目录；`CODEX_USAGE_HOMES` 可追加 Codex home。
- [ZCode](data-sources/zcode.md)：默认 `~/.zcode`，依次探测 `cli/db/db.sqlite`、`db/db.sqlite`。
- [DSH](data-sources/dsh.md)：默认 `~/.dsh`，读取 `sessions/<cwd-slug>/<sessionId>/session.v<N>.jsonl.zstd`。
- [OpenCode](data-sources/opencode.md)：探测 `~/.local/share/opencode`、Windows APPDATA/LOCALAPPDATA 和 macOS Application Support 下的目录，再展开目录中的 `opencode*.db`。
- [Claude Code](data-sources/claude-code.md)：默认 `~/.claude`（并发现 `CLAUDE_CONFIG_DIR`），读取 `projects/<cwd>/<sessionId>.jsonl` 与 `projects/<cwd>/<sessionId>/subagents/agent-*.jsonl`，按 `message.id` 去重。
- [项目日志](14-project-log.md)：导入包含 `.codex-usage/usage.jsonl` 的项目目录。

看板导入的是 home、数据目录或项目目录，不直接导入单个数据库文件。显式导入目录先按 ZCode、DSH、OpenCode、Claude Code 的具体结构判定，再检查 Codex 和项目日志，避免同名 `sessions` 目录误判（`~/.claude/sessions/` 与 Codex 的 `sessions/` 同名，Claude 必须先判）。

追加来源分别使用 `CODEX_USAGE_ZCODE_HOMES`、`CODEX_USAGE_DSH_HOMES`、`CODEX_USAGE_OPENCODE_HOMES`、`CODEX_USAGE_CLAUDE_HOMES`；多个路径使用系统分隔符（Windows `;`，macOS/Linux `:`）。设置 `CODEX_USAGE_ZCODE=0`、`CODEX_USAGE_DSH=0`、`CODEX_USAGE_OPENCODE=0`、`CODEX_USAGE_CLAUDE=0` 可关闭对应的自动发现；显式导入是独立路径，不能把这些开关当成禁止导入策略。`CODEX_USAGE_IMPORT_DIRS` 可提供额外导入目录。

## 统一事件口径

标准事件携带时间、会话、来源、渠道、模型、仓库归属、Token 数量和已知明细标记。`total` 保留来源提供的可信总量或来源适配器明确构造的总量；缺失与真正的 0 分开处理。

看板按以下子集关系使用明细：缓存命中属于总输入，推理属于总输出，缓存写入作为独立计价明细记录。来源的原始计数若为并列关系，适配器须先重构；不能用缓存命中输入再次增加总量，也不能把独立推理输出漏出总输出。

`validateUsageDetails()` 校验明细与总量关系；不一致时撤销不可信明细并保留差额标记。费用端随后选择适用估算，见[计价](11-pricing.md)。这不是把缺失数据补零或从正文估算 Token 的许可。

DSH 当前非零缓存写入边界尚待核实，不能把“所有适配器都完整满足输入超集关系”作为已验收事实，见[任务清单](02-tasks.md)。

## 历史输出吞吐（TPS）

TPS 是基于历史结构化记录的输出吞吐统计，不是 TTFT，也不是只计算模型解码阶段的速度。单样本按 `outputTokens * 1000 / durationMs` 计算；ZCode、DSH、OpenCode 使用请求端到端时长，计入记录所覆盖的请求等待时间。Codex 只提供带 `item_span_estimate` 标签的轮级 item 时窗估算，不冒充请求 wall-clock 时长。

统计内核版本为 `tps-v1`。来源、来源实例、渠道、代理类别/名称、模型、provider、effort、计时方法、token 范围和窗口口径共同决定分组；不同口径不会合并。组内报告最近秩 p10/p50/p90（p10 较慢、p90 较快）、样本数 `n`、时长分位数和 pooled TPS（样本输出 token 总和除以时长总和）。`n < 20` 仍展示统计但不参与排名；溢出时不伪造数值。样本只取已完成且输出 token 与时长均为正的候选；长时窗和估算是提示标记，不单独作为剔除理由。

coverage 分开表达 `eligible`、`sampled`、`dropped`、`pending` 和 `unplaced`。对可定位候选，恒等式为 `eligible = sampled + dropped + pending`；缺时间的 `unplaced` 作为所选来源的全历史诊断，不进入当前日期范围分母。没有样本的来源只报告诊断，不合成 0 TPS。未知来源格式、无法唯一归属、读取错误、来源变化及发布失败按 warning/degraded 状态显式呈现；Codex 对可靠归属的坏线程整线程隔离，未知或含糊边界 fail closed。TPS 候选与普通用量事件分开存储和汇总，不增加 `totals`、费用、时间线或限额统计。

默认及 dashboard 用量响应、`/api/summary` 和 `detail=full` 的 `summary.perf` 携带性能聚合与公开状态。内部 `perfSamples/perfMeta`、sampleKey 与物理来源路径不序列化到公开 report；full 提供的是原有用量明细，并非 TPS 候选明细。冻结查询绑定当时索引，后续同步不会改变已冻结的统计；full 走 live 内存路径，不能与 freeze/snapshot 组合，明确返回 `SNAPSHOT_FULL_DETAIL_UNSUPPORTED`。来源变化或事务失败时保留旧数据用于恢复，并按发布 policy 排除失败线程，不能让旧样本继续排名。公开 `indexVersion` 反映已发布统计及告警的变化。具体验收与残留见[最终审核包](validation/2026-10-04-perf-metrics/20261004T035100/final-audit.md)。

## 统计范围与限额

普通今日、本周、本月、全部、自定义日期和普通最近范围统计所有已选来源。`5h / week` 限额按钮以及“上一个 5h”“上周”只统计 Codex 来源；边界来自实际限额观察值，缺失时不猜测。

限额能力依据来源 kind 判断，不依据渠道显示名称。项目日志即使把 `channel` 写成 Codex，也不会因此获得 Codex 限额资格。ZCode、DSH、OpenCode 和 Claude Code 不参与 Codex 限额窗口。

## 渠道展示与归组

普通范围将 Codex Desktop、Editor Integration、CLI、Codex Exec、codex_work_desktop 归入 Codex，ZCode Subagent 归入 ZCode，DSH Subagent 归入 DSH，OpenCode 保持独立，Claude Code 与 Claude Code Subagent 归入 Claude。来源 kind/homeId 的证据优先，明确旧标签作兼容回退；未知自定义渠道没有来源证据时保留原名。当前和上一完整 Codex 5h/7d 限额范围保留原渠道。

归组在汇总与时间线展示时完成，不改写事件 channel；计价继续使用原始标签。合并会话按唯一 ID 去重，不直接相加分渠道会话数。内存报告、SQLite 与浏览器纯统计共用 timeline-utils 中的归组规则。

## 增量索引与版本

默认索引位于 `~/.codex-usage/usage-index.sqlite`。JSONL/zstd 按文件大小和修改时间检测变化；ZCode/OpenCode 的指纹包含主库和 `-wal`。DSH 按日志文件展开，OpenCode 按数据目录下的多个数据库展开，Claude Code 按 `projects/**/*.jsonl`（含 subagents）展开。

变化来源通过 `replaceFile` 替换对应事件，未变化来源保留索引。模型元数据按 Codex、ZCode、DSH、OpenCode、Claude 分组；项目日志的渠道名称按现有分组规则处理，不改变其限额资格。

当前 `STORE_SCHEMA_VERSION` 为 16（2026-10-20 快照）。11→12 增加 TPS 样本表，12→13 增加 Codex rollout 依赖索引，13→14 增加 Codex 投影表，14→15 登记 Claude Code 来源（表结构不变，只抬版本号），15→16 把 Claude Code 的模型身份改为线路模型并只标脏 `kind = 'claude'` 重扫；相应迁移按来源标记文件待重扫，保留现有用量表并在事务中升级。DSH 历史迁移仍先使 DSH 指纹失效，以重新归一化非零缓存写入。升级不要求手动删除真实索引或改写原始日志；TPS 首次接入也不把来源正文写入索引。

## 读取与数据边界

标准事件提取用量和必要元数据，不把 prompt、响应正文、工具参数或密钥作为事件字段。原始文件和 JSON 解析过程中可能包含正文，不能将“输出不含正文”写成“原始正文从不进入内存”。

SQLite 适配器优先只读打开；当前 ZCode/OpenCode 在只读打开失败时会退回普通打开，可能触发 SQLite 恢复或辅助文件操作。应用不主动修改上游业务记录，但不能承诺文件系统层面的绝对零写入。严格对照应使用可靠的一致快照，而不是顺序复制正在写入的 db/WAL 后假定二者一致。

上述回退属于普通用量 reader。新增 TPS 的 ZCode/OpenCode reader 严格只读，打开失败即报告错误，不回退可写连接，并在 SQL 中只投影性能所需标量；不能把普通用量 reader 的限制或保证套到性能路径。真实来源验收绑定完整冻结副本与 source-start 清单，逐文件采集不等于 live 目录的原子时刻；未来来源变化仍触发 `LIVE_SOURCE_CHANGED` 并拒绝发布。

索引和验收日志可能包含模型名、会话元数据与本机路径；分享前检查实际产物。自动价格请求只读取公共来源，不上传本地用量，详见 [11](11-pricing.md)。

## 接线与回归

新增来源要同时核对 `usage-core` 的分类/发现/指纹/事件分派、`usage-store` 的文件展开与元数据、服务器导入标签、前端 harness 分组、非 Codex 限额排除、i18n 和 README。来源测试、索引测试与三路一致测试分别覆盖语义和接线；真实来源 UI 验收独立记录。
