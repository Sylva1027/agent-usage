# M0：工作区基线、来源证据与契约冻结

前置：[实施总计划](../2026-10-04-model-tps-implementation-plan.md)、[指标方案](../2026-10-03-model-latency-throughput-plan.md)。本模块只读生产代码和历史源；除本模块探测脚本、validation 证据及受证据影响的计划修订外不改产品。六张卡中 M0.2–M0.5 在 M0.1 提供运行目录/探测输出接口后可分别交给四个 agent。

共同探测格式：`scripts/perf-probe.mjs --source zcode|dsh|opencode|codex --max-files N --max-rows N --output <validation目录>`；默认有界，按规范排序后取首尾文件及每源最多 N 行，报告实际扫描范围。每个来源模块只输出聚合字段/枚举计数和脱敏指纹。`--full` 必须显式指定，并记录耗时、源变动前后指纹；不把“有界探测”称为全量覆盖。输出 JSON 固定 `probeVersion/methodVersion/startedAt/endedAt/nodeVersion/gitRevision/dirtyState/sourceFingerprintBefore/sourceFingerprintAfter/liveSourceChanged/scanned/fields/decisions/warnings`。探测源库只用 `DatabaseSync(...,{readOnly:true})`，失败即记录，不回退可写。

## M0.1 基线与探测外壳

允许文件：`scripts/perf-probe.mjs`、`biome.json` 中仅新增探测脚本检查范围、本 run 的 `run.json / baseline.json / handoffs/M0.1.md`。生产代码只读。

1. 记录 HEAD、dirty 列表与 `src/usage-core.js/usage-store.js/server.js/zcode-usage.js/dsh-usage.js/opencode-usage.js`、相关 `public/` 文件的工作区 SHA-256；记录 Node、npm、OS、当前 store user_version、既有测试命令与覆盖范围。
2. 只读核对 `buildUsageReport`、`summarizeUsage`、`UsageStore.summarize`、`/api/usage` 两分支、`/api/summary`、CLI `json` 的公开序列化、freeze backup、`timelineModes`，记录真实函数/文件锚点。确认 `summarizeUsageIndex` 与浏览器导出 `summarize` 仅旧用量回归使用的现状。
3. 建探测 CLI 与按来源动态 import 的分发接口；未领取来源模块尚不存在时，帮助和已实现来源仍可运行。参数校验、输出目录必须在本次 validation 下、运行失败仍写退出原因。每个来源探测可单独运行，不依赖其他来源存在。`biome.json` 的 `files.includes/formatter.includes` 只增加 `scripts/perf-probe.mjs`、`scripts/perf-probe-sources/**` 与将由 M4.4 创建的 `test-support/perf-fixture.mjs`，因为现有 typecheck 只覆盖 src、现有 Biome 不覆盖这些新文件；本卡另跑 `node --check`。日志只打印编码告警和计数，不打印路径/ID/正文。

验收：基线含相关文件摘要、当前 schema/运行时和确切接线图；帮助/非法参数/缺源三条 CLI 测试；不创建或修改上游文件。把冻结的输出形状与运行目录交 M0.2–M0.5。若其他工作改了相关文件，受影响卡在最终 `DONE` 前重核摘要。

## M0.2 ZCode 有界字段与过滤证据

允许文件：`scripts/perf-probe-sources/zcode.mjs`、`test/perf-probe-zcode.test.js`、本卡 JSON 与 handoff。使用 M0.1 CLI，不改公共 CLI。

1. `PRAGMA table_info(model_usage)` 确认 §17.1 所需 `id/session_id/model_id/provider_id/variant/agent/query_source/task_type/status/attempt_index/retry_count/retryable/cancelled_by_user/started_at/completed_at/duration_ms/input_tokens/output_tokens/logical_request_id` 的实际存在与数值单位；缺列逐项记录，不能默认空值等于 0。
2. 仅 `SELECT` 字段白名单。按 `status`、重试/取消标记、输出正值、时长正值分层计数；采样核对显式 duration 与完成−开始；检验源身份 `(home_id,row.id)` 唯一性。TTFT 列可以确认存在与否，但不读取或用于任何 TPS 公式。
3. 明确 `agent_kind` 的可证映射：明确 subagent 标志优先；`main` 只能由已核实的源值赋予；其余 unknown。`logical_request_id` 只做重试诊断。输出 tokenScope 维持 `reported_output_unspecified`，除非本次获得版本化写库证据。

验收：固定小库 fixture 覆盖 completed/error/cancelled/retry、duration fallback、缺字段与只读失败；报告 all/positive/filtered 分母和源指纹，不把本机 n 写成测试断言。

## M0.3 DSH 有界字段与配对证据

允许文件：`scripts/perf-probe-sources/dsh.mjs`、`test/perf-probe-dsh.test.js`、本卡 JSON 与 handoff。

1. 复用 `readDshSessionRows()` 的解压/坏帧告警，但投影只访问 `session`、`request/header|context` 的 config、`step/start` 的 `(turn,step,time)`、`assistant/message` 的 `(turn,step,time,usage.outputTokens)`；不访问 `data.stream`、正文、`step/end`。
2. 按 `(home_id,session_id,turn,step)` 建配对；核对同 turn 同 step 是否多条 start/message、跨 turn step 复用和 header 变更。重复一致折叠；冲突计数并定为诊断，不任选末条。
3. 把版本 4 之外、缺 session 头、缺 start、缺 usage、负时长、坏帧分别计数；确认请求作用域 model/provider 的来源和 `agentPreset/delegationDepth` 的身份语义。

验收：合成多帧 fixture 同时覆盖 step 重置和模型变更，使用正文哨兵证明产物不含正文；报告 message−start 的时间单位与实际匹配率，不能把坏帧后剩余记录称为完整来源。

## M0.4 OpenCode 有界字段与版本证据

允许文件：`scripts/perf-probe-sources/opencode.mjs`、`test/perf-probe-opencode.test.js`、本卡 JSON 与 handoff。

1. 严格只读检查 `session_message` 所需列和 `session_v2.version`。只选择 `json_valid(data)` 的 assistant 行，用 SQLite `json_extract` 窄取 `data.time.created/completed`、`tokens.output/reasoning`、`data.model.id/providerID`、`data.agent`、终态字段；坏 JSON 行单独计数，不 `SELECT data` 整串正文。
2. 按 v2 guard 分出支持/旧版/版本未知；未知版本仍沿用现有放行+告警策略，但候选 `sourceWarnings` 必须可见。确认输出与 reasoning 的并列关系，缺一项与真 0 分开；`streamed` 只作为错误分母反例，不进入产品 reader。
3. 复核 `data.agent` 是否只给名称、能否证明 main/subagent；没有角色证据时 `agentKind=unknown`。身份以 `(home_id,database_identity,message.id)`，不是全局 seq。

验收：临时 v1/v2 SQLite fixture 及缺 completed、无 tokens、坏 JSON、缺 schema 列、只读失败均有编码结果；报告含主库/WAL 前后指纹，源变化时标 `liveSourceChanged`。

## M0.5 Codex 元数据、终态和范围证据

允许文件：`scripts/perf-probe-sources/codex.mjs`、`test/perf-probe-codex.test.js`、本卡 JSON 与 handoff。

1. 同时抽 `sessions` 与 `archived_sessions`，按顶层 `turn_context`、`event_msg` 内 `token_usage_record/item_completed/task_complete` 的精确类型计数。确认 item `AgentMessage/Reasoning` 的 `id/started_at_ms/completed_at_ms`、请求 `response_id` 与轮 `thread_id/turn_id`；不读取 item content、task_complete 的 last_agent_message 或 TTFT。
2. 用复合键检查重放/跨 rollout 重复、同轮 request output 之和与末条累计 output、精确 `turn_context.turn_id` 模型/effort 冲突、task_complete 的结束证据和秒/毫秒单位。区分 raw/positive/full-span/finalized；缺终态不可当完成。
3. 用不含原始 ID 的结构计数评估“整请求输出是否能对应目标 item 时窗”。若仍不能证明，决议保持 `item_span_estimate`，不宣称纯解码速度；旧时段缺跨度单列。可选 history/state 只读探测字段与潜在增益，分别报告投影自身覆盖和全 JSONL 候选覆盖，不预设必须接入。

验收：fixture 有跨线程相同 turn_id、同线程多 rollout、重复 item、partial、长轮、多请求、未结束和模型切换；报告 `JSONL_ONLY / OPTIONAL_SQLITE_WORTHWHILE / UNSUPPORTED` 的理由，不附原始 ID。

## M0.6 契约决议与测试清单

前置：M0.2–M0.5 各自报告；单源 `BLOCKED` 可明确标为该源待解，不妨碍其他源。允许文件：本 run 的 `source-contract.md / fixture-cases.md / handoffs/M0.6.md`，以及**只在证据证明冲突时**修订现行 TPS 方案与本实施计划。只有协调者写公共计划。

把每源确认的列、单位、终态、身份、代理映射、`tokenScope/timingKind`、过滤原因和只读策略逐项写入 `source-contract.md`；每条注明 `confirmed / conditional / unsupported`、证据文件摘要和对应方案段落。`fixture-cases.md` 列出 M1–M7 必测的最小输入/预期输出，至少覆盖全部 §17.4 flag、§17.5 计数恒等式与四源去重。对未证实的 main 身份或终态只能保留 unknown/unverified。集成者复查四份报告实际输入/指纹，写 `handoffs/M0.md` 后开放 G0。

验收：所有下游 agent 读取同一版契约 SHA-256；来源待决项有明确受阻范围和处理人，不让各 adapter 自己猜。M0.6 不记录一个未经固定输入复测的“正式 TPS p50”。
