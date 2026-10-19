# M2：三源独立候选 reader

前置：M0.6 的来源字段决议、M1.1 的样本接口。[实施总计划](../2026-10-04-model-tps-implementation-plan.md)固定 `stream*PerfSamples` 签名。三卡各写不同新文件与测试，**可以并行**；除 M2.2 对 `readDshSessionRows()` 的限定坏行计数钩子外，不改现有适配器；不得改 `usage-core.js` 或 `usage-store.js`。reader 读一个物理文件，用回调逐条输出规范候选；非致命错误通过 `{sourceKind,homeId,code,count}` 警告，致命只读/schema 错误抛出，集成层标 degraded。`sourcePath` 是本项目索引归属文件，原始路径不写报告。

## M2.1 ZCode 请求尝试行

允许文件：`src/perf-sources/zcode.js`、`test/perf-zcode.test.js`。

1. 只读打开 `db.sqlite`，失败不回退普通打开；按 M0 字段决议先做 `PRAGMA table_info(model_usage)` 能力守护，SQL 只选身份、状态、计数、时长、代理、模型、provider、variant 的必需列，并按 `id` 稳定迭代。`model_usage` 的每条**尝试行**形成一个候选；`logical_request_id` 只辅助重试过滤。
2. `sampleKey=JSON.stringify(['zcode',homeId,row.id])`；`durationMs` 优先显式安全整数 `duration_ms`，字段缺失才用两个 epoch-ms 时间戳之差，不能在显式真 0/负数时暗中回退。`tsMs` 优先 completed 再 started；缺时间可保留 unplaced 候选。`outputTokens` 直接取 `output_tokens`，不加 reasoning；input 直接取 input，不叠缓存。
3. `window='request'`、`timingKind='request_e2e'`、`tokenScope='reported_output_unspecified'`。status/error/cancel/retry 按 M0 决议置 `SOURCE_FILTERED` 和枚举 `diagnosticReason`，即使来源过滤仍保留有身份候选供覆盖率。`query_source/task_type` 明确子代理优先；agent 名与 kind 分别记录。TTFT 缺失、超 1000 tok/s 均不自动剔除。

验收：临时 SQLite 夹具至少包含完成/取消/错误/重试、显式时长与 fallback、缺 TTFT、同 logical_request_id 的两个尝试、未知 agent 和 WAL 仅更新。上游主库/WAL 的字节或哈希在 reader 前后不变；只读失败有编码原因。

## M2.2 DSH step 请求时窗

允许文件：`src/perf-sources/dsh.js`、`test/perf-dsh.test.js`；为坏 JSON 行诊断，M2.2 独占 `src/dsh-usage.js` 的 `readDshSessionRows()` 内**计数并调用现有 `onWarning`**这一小段及其原测试，其他映射不变。

1. 复用 `readDshSessionRows(filePath,{onWarning})` 解压和 v4 守护；现有函数对坏 JSON 行静默跳过，本卡只加坏行数的编码 warning，保持用量事件行为。仅取 session header、request header/context config、`step/start` 的 `(turn,step,time)`、`assistant/message` 的 `(turn,step,time,usage.outputTokens)`。**不访问** `data.stream`、message/content、step/end；坏帧/坏行在 `sourceWarnings` 中使该文件 degraded。
2. 在单会话内以 `(turn,step)` 保存 start 与最终 message，头配置按当前请求作用域关联，不能把上一轮模型套到无 header 的下一请求；M0 未证明 header 作用域时 model 留空。身份 `['dsh',homeId,sessionId,turn,step]`，turn 间 step 重置也不碰撞。重复一致折叠；不同 start/message 冲突保留一个 `RECORD_CONFLICT` 候选，不任选较快时窗。
3. `durationMs=message.time-start.time`，`tsMs=message.time`，`window='step'`、`timingKind='request_e2e'`，输出仅显式 `usage.outputTokens`。缺 start/usage 仍保留候选与缺失原因；in-progress 只有明确证据才置，日志截断或未知终态用 unverified。`agentPreset` 名与 `delegationDepth` kind 分离。

验收：多帧/坏帧、跨 turn 相同 step、两个会话相同 `(turn,step)`、模型切换、缺 start、0/负时长、缺 usage、正文哨兵。手算至少两组请求 TPS，确认从未读取 stream key 完成公式。

## M2.3 OpenCode v2 assistant 消息

允许文件：`src/perf-sources/opencode.js`、`test/perf-opencode.test.js`。

1. 严格只读打开每个发现的 `opencode*.db`；核对 `session_message` 必需列和 `session_v2` 版本。SQL `WHERE type='assistant' AND json_valid(data)`，用 `json_extract` 选 `data.time.created/completed`、`data.tokens.output/reasoning`、`data.model.id/providerID`、`data.agent`、已核实的 finish/status；坏 JSON 行另用计数查询记警告，不能让 `json_extract` 对坏行中断整库。不 `SELECT data` 或 `item_json`。
2. `sampleKey=['opencode',homeId,规范数据库身份,message.id]`；`window='message'`、`timingKind='request_e2e'`、`tokenScope='visible_plus_reasoning'`。输出仅在 output/reasoning 两字段各自已知时相加；缺任一项不能把缺值当 0。`durationMs=completed-created`，不得使用 streamed。completed 缺失且仍在进行时 pending，否则按已证终态标 unverified/filtered。
3. v1 明确排除并警告；版本缺失按现行 adapter 的“放行并警告”处理，但语义不确定时不得给精确排名，按 M0 决议处理该候选。`data.agent` 只证明名称时 kind=unknown；provider/variant/effort 缺证据不从当前配置回填。

验收：v1/v2/版本缺失、reasoning 正值/真 0/字段缺失、无 completed、取消、两个数据库同 message.id、WAL-only 变化及 >1000 tok/s 合成反例。测试证明 reader 只 SELECT JSON 标量且只读失败不触碰源库。

模块出口：三个 reader 的固定签名、单源 fixture 与诊断枚举。集成者检查每个 reader 的 SQL 字段白名单、输入语义和 `sampleKey`，写 `handoffs/M2.md`；M3/M4 再统一注册，三个 reader 不直接互相 import。
