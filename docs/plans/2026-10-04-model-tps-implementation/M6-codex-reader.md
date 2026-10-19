# M6：Codex JSONL 轮候选引擎

前置：M0.5 的字段/终态探测、M0.6 来源契约、M1.1 样本接口。M6.1 写 `src/perf-sources/codex-jsonl.js`，M6.2 写 `src/perf-sources/codex-fold.js`，M6.3 写 `src/perf-sources/codex-candidates.js`，必要时 M6.4 才写 `src/perf-sources/codex-sqlite.js`；共同测试为 `test/perf-codex.test.js`。不改 `usage-core.js/usage-store.js/server.js`，由 M7 接线。默认只用 JSONL，SQLite 不是前置条件。

## M6.1 逐 rollout 元数据投影

按 `usage-core.js` 私有 `readJsonlRows` 的 `createReadStream`/readline 方式在本模块流式逐行解析 `sessions` 与 `archived_sessions` 的 rollout 文件；该函数目前未导出，不从 `usage-core.js` 私自 import 或为了本卡改共享文件。新 reader 还要计坏 JSON 行数。只输出小型元数据记录；每文件最多保存本线程必要的 turn/request/item 状态，不保存正文、summary_text、raw_content、args、item_json。接受的顶层/内层类型由 M0.5 锁定，特别是 `event_msg/item_completed` 的 PascalCase `AgentMessage/Reasoning`；未知类型只计编码告警，不把任意 JSON 对象当 item。

提取 `session_meta` 的线程/agent 证据，`turn_context` 的精确 `(thread_id,turn_id,model,effort)`，token usage 的 `(thread_id,turn_id,response_id,usage,turn_token_usage,timestamp)`，目标 item 的 `(thread_id,turn_id,item.id,item.type,started_at_ms,completed_at_ms)`，`task_complete` 的同轮终态字段。若某记录本身无 thread_id，只在文件 `session_meta` 唯一确认线程时使用该文件线程，不靠“当前最近 turn”跨轮关联；缺 turn_id 或线程仍不明则计警告。`task_complete.started_at/completed_at` 的秒转换仅用于终态核对；**不做 TPS 分母**。每条元数据附内部 `sourcePath` 作为依赖，绝不附到 API/report。

验收：两个文件同 thread、不同 thread 同 turnId、archived 文件、错误 JSON 行、PascalCase 正例/camelCase JSONL 反例、包含正文哨兵的文件。只从投影对象检查没有正文/工具键；测试不能仅扫描最终 API 以掩盖中间对象泄漏。

## M6.2 复合键去重与模型/代理归属

把一线程所有 rollout 元数据按文件路径稳定顺序合并。请求 key `(homeId,threadId,responseId)`，轮 key `(homeId,threadId,turnId)`，item key `(homeId,threadId,turnId,item.id)`；所有字符串保留大小写。重复相同记录折叠；一个记录缺字段、另一同身份记录字段一致时可补齐；任意非空 output、归属、时间、模型冲突置 `RECORD_CONFLICT` 或 `MODEL_AMBIGUOUS`，不任选最后一条。缺 responseId/itemId 不能用时间或行号临时做“独立请求/item”，要给轮记不可完整去重的诊断。

请求的 `usage.output_tokens` 已含 reasoning，不重复加；去重请求的 output 求和，末条 `turn_token_usage.output_tokens` 只交叉校验。累计值不一致时标冲突并保留核查计数，不能改用累计值掩盖缺请求。只以**精确同轮** turn_context 归属 model/effort；同线程会话或 state 的最新 model 不回填历史轮。agentKind 从 M0 已核实的 session_meta.source 映射，明确 subagent 才是 subagent，缺证据 unknown；vscode/cli 入口不等于 main。

验收：跨线程相同 turnId、同线程换模型、同轮两种模型、两个 rollout 同 request/item 重放、一致补缺、非空冲突、两个 request 累加与累计核对。测试给出每轮请求数和冲突 flag 的精确预期。

## M6.3 轮状态、完整 item 时窗与候选

每个有 token usage、目标 item 或 task_complete 证据的稳定轮输出**一个**候选；只见 context 而无实际轮证据不建假候选。`sampleKey=['codex',homeId,threadId,turnId]`，`window='turn'`、`timingKind='item_span_estimate'`、`tokenScope='reported_output_includes_reasoning'`、`METHOD_ESTIMATE` 恒置。`tsMs` 只取**已结束且请求身份集合完整**的轮之末条去重 token_usage_record 时间；无此时间或请求集合不完整时留 unplaced，不能用 item.created/线程创建时间归属范围。请求集合不完整时仍保留候选，但 `outputTokens=null`、发出 `UNKEYABLE_RECORD` 来源告警；不得把部分 `requestOutputSum` 或 `lastTurnOutputTokens` 当作完整输出，也不得把来源告警放进样本 flag 位域。provider 的 `providerScope=unknown`，不从 `session_meta` 盲目回填历史轮或从当前配置补值。M7 调用候选器时须同时传入完整发现的 rollout 路径列表（包括空文件）；该内部依赖列表与候选并行返回，不得序列化到 API/report。

去重后只统计 `AgentMessage/Reasoning` 目标 item。每个目标 item 的 start/end 必须为安全整数、end>start；存在至少一个正跨度，但另有已识别目标 item 缺/坏跨度或轮级 `unkeyableItemCount>0` 时置 `PARTIAL_ITEM_SPAN`，不以整轮 output 除以残缺时窗。缺身份行不生成合成 item/count，也不加入时窗。所有有效跨度的长度求和是 `durationMs`；`windowStartMs=min(start)`、`windowEndMs=max(end)` 仅作观测边界，两者差值**不替代** duration。目标 item 之间有重叠置 `OVERLAPPING_ITEM_SPAN` 并剔除；完整 >300000ms 只置 `LONG_WINDOW`，多请求只置 `MULTI_REQUEST_TURN`，仍可统计。无有效跨度时保留缺时长候选。

仅同轮可信 `task_complete` 证明 `completed`。按冻结的 Codex 来源契约，当前 JSONL 投影没有可用的 `in_progress`、失败、取消或中断状态字段；`task_started` 与 `turn_aborted` 不作状态推断。因此缺 `task_complete` 的轮一律 `unverified`，不伪造 `pending`/`SOURCE_FILTERED`；将来只有出现契约认可的显式状态证据才可交给 M1 分类。`time_to_first_token_ms` 不作任何比较；小于 TTFT 的完整 item 时窗不得因此剔除。`requestCount/itemCount/timedItemCount` 与参与计算的去重对象一致，所有有稳定身份的候选，即使 output=0/缺时长/未完成也输出供 coverage。

验收：手算完整单请求、多请求长轮、partial、重叠、缺全部 item、尚未结束（含 `task_started`/`turn_aborted` 不能推断状态）、输出 0、完整时窗小于 TTFT 的反例；明确检查 flag 与默认 sampled，并核对已定位候选的 `eligible=sampled+dropped+pending`。failed/cancelled/in-progress 在当前 Codex JSONL 证据中不可达，不伪造夹具冒充来源能力。

## M6.4 SQLite 可选补缺决议与来源 fixture

先读 M0.5：若无明确可验证的增益，交付 `NO_SQLITE_BY_EVIDENCE` 报告和“JSONL-only”测试，**不创建附加 reader**。若确认必要，`codex-sqlite.js` 只读打开 `state_5.sqlite`/`thread_history_1.sqlite`，探测实际列与投影就绪，窄 SELECT 代理或 item 标量字段；绝不 SELECT `item_json`，也不 fallback 可写打开。JSONL 主路径与 SQLite 同 `(home,thread,turn,item)` 对齐；非空时窗冲突保留 JSONL 证据并置冲突，补缺标 `timingSource='mixed'`。可选库缺失不阻断 JSONL 源，但降级 warning 可见。

有附加库才向 M7 交付必须纳入指纹/依赖的数据库主库+WAL 路径及失效测试；否则 M7 不建空依赖。模块集成者用固定 fixture 跑 `node --test test/perf-codex.test.js`，逐项检查复合键、终态、时窗和隐私，写 `handoffs/M6.md`。本机有界探测的数值仅用于日期诊断，不能成为固定测试阈值。
