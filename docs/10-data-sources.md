# 数据来源与统计口径

更新：2026-10-29（生成 TPS v4）。本文维护共同规则；各来源的字段映射分别见下方专题。

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

## 模型生成速度（TPS）

当前工作树方法为 `tps-v4`，统一使用 `window=request`、`timingKind=generation`。一次已完成模型响应作为一个样本，速度为 `(N−B) * 1000 / D`：B 是计时起点已经输出的 token 数，D 是对应生成耗时。常规首 token 边界取 B=1；覆盖全部生成的明确阶段耗时取 B=0。Codex 等已核验路径使用 `non_reasoning_output`，N 为非推理输出（含正文、代码和工具参数）；DSH 官方 `deepseek-account` / `deepseek-official` 固定使用 `all_generated_output`，N 为同一成功响应最终 output，D 覆盖 reasoning、正文及实际工具参数增量。不猜缺失的 reasoning 拆分。原始 output、reasoning、请求 E2E 保留，用量、费用和限额口径不变。范围契约见[本地接入方案](plans/2026-10-29-local-generation-adoption-plan.md)。

性能来源限定为各工具已经保存在本机的原生记录，运行链路不读取 Magpie 数据，也不要求中继或修改路由。Codex 补丁版已提供完整并排包及 CLI/Desktop 启动器，官方普通安装不会自动采用它；当前 Desktop 保持运行，实际采用尚未验收。DSH 可直接从现有 canonical stream 恢复全部生成，真实 reader 的 881 个官方候选中 870 个有效、8 个无正窗口、3 个身份冲突。WorkBuddy 已恢复已核验的纯正文子集；Claude、ZCode、OpenCode 的剩余 producer 缺口见[原生采集计划](plans/2026-10-28-native-generation-timing-plan.md)。缺计时只排除该请求，不把请求、step、item 或 trace span 总耗时回退成生成速度；模型候选和用量保留，速度沿用 `—`。旧 v1/v2 保留版本供恢复，不混入当前速度；同语义 v3 生成样本保留原版本并继续可读、可统计和归档恢复。

[深入采集计划](plans/2026-10-28-native-generation-timing-plan.md)已固定实际 producer 边界：Codex 现有 OTel 不含完整摘要，OpenCode 的 ephemeral/合批事件不能靠持久化开关恢复；WorkBuddy 的 `qua.end` 正文间隔只作待验证子集，ZCode 两条已知 adapter 可用 output-reasoning。默认接入仍为原生本地摘要到各自 reader，不建设中继依赖或通用遥测平台。

`summary.perf.models` 按 `[sourceKind, model, reasoningEffort, modelProvider]` 聚合同一有效请求集合，同 provider 合并 home、渠道与主/子代理；空 provider 保持未知。同一来源/provider 在当前方法中固定一个已审核范围，DSH 官方 v4 会替代同响应的 v3 非推理投影，不混合两种范围。平均速度为有效分子之和除以生成耗时之和，p10/p90 是同集逐请求 TPS 的最近秩，n 是请求数。一个有效样本即可显示数值；既有排名门槛仍为 20，统一非推理排名不接收全部生成范围，DSH 行仍显示数值、区间和样本数，rank 为 null。没有有效样本的模型行保留空值，不填 0 或借旧 E2E。页面沿用现有表格、样本数和区间，不新增说明、警告、徽标或详情区块。实施及普通安装边界见[本地接入方案](plans/2026-10-29-local-generation-adoption-plan.md)，[前轮验收](validation/2026-10-28-generation-tps/README.md)保持历史版本归属。

`summary.perf.codexTimingCoverage` 保留当前方法的同范围内部诊断，沿用来源排除及健康发布过滤。counts 记录候选、采样、互斥丢因、pending 和 unplaced；输出计数使用性能投影字段，不代替原始用量总数。没有适用 Codex 来源为 null，已配置但范围无候选为零计数；rebuilding/uninitialized 不发布假覆盖。全历史 unplaced 不纳入当前范围分母。

coverage 分开表达 `eligible`、`sampled`、`dropped`、`pending` 和 `unplaced`，可定位候选满足 `eligible = sampled + dropped + pending`。计时晚到或升级只重算受影响请求和性能分组；Q2 静态用量缓存继续复用，Q3 同步 reader 从自身快照读取性能数据。请求局部缺失或冲突不连带淘汰其它可测响应；真实身份、归属与发布冲突继续按既有规则处理。

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

当前代码 `STORE_SCHEMA_VERSION` 为 22。11→19 依次建立性能样本、Codex 依赖/投影、Claude 和 WorkBuddy、请求计时及 home-scoped duration observation；19→20 保存重解析替换的用量事实，20→21 建立冷归档目录，21→22 扩展生成计时约束和证据并标记来源重解析。旧行和依赖保留，不把 v1/v2 数值改名为 v3。新增证据随导入导出、备份及冷归档恢复保留，旧十列计时清单仍可读；无需手动删除索引。本机正式服务上次[切换记录](validation/2026-10-27-performance-production-cutover/README.md)为 `852034b` / schema21 / tps-v2，本轮源码尚未部署。

## 读取与数据边界

标准事件提取用量和必要元数据，不把 prompt、响应正文、工具参数或密钥作为事件字段。原始文件和 JSON 解析过程中可能包含正文，不能将“输出不含正文”写成“原始正文从不进入内存”。

SQLite 适配器优先只读打开；当前 ZCode/OpenCode 在只读打开失败时会退回普通打开，可能触发 SQLite 恢复或辅助文件操作。应用不主动修改上游业务记录，但不能承诺文件系统层面的绝对零写入。严格对照应使用可靠的一致快照，而不是顺序复制正在写入的 db/WAL 后假定二者一致。

上述回退属于普通用量 reader。新增 TPS 的 ZCode/OpenCode reader 严格只读，打开失败即报告错误，不回退可写连接，并在 SQL 中只投影性能所需标量；不能把普通用量 reader 的限制或保证套到性能路径。真实来源验收绑定完整冻结副本与 source-start 清单，逐文件采集不等于 live 目录的原子时刻；未来来源变化仍触发 `LIVE_SOURCE_CHANGED` 并拒绝发布。

索引和验收日志可能包含模型名、会话元数据与本机路径；分享前检查实际产物。自动价格请求只读取公共来源，不上传本地用量，详见 [11](11-pricing.md)。

## 接线与回归

新增来源要同时核对 `usage-core` 的分类/发现/指纹/事件分派、`usage-store` 的文件展开与元数据、服务器导入标签、前端 harness 分组、非 Codex 限额排除、i18n 和 README。来源测试、索引测试与三路一致测试分别覆盖语义和接线；真实来源 UI 验收独立记录。

### 本地额度来源筛选

5h/7d 的来源判定只读本机 Codex 会话与 `logs_2.sqlite` 中可关联线程的原生诊断，不查询线上账户、不依赖 Magpie、不读取凭据。SQLite 保存脱敏来源状态，静态快照携带相同分类；既有原始用量保持不变。额度周期与趋势口径见[看板说明](12-dashboard.md)。
