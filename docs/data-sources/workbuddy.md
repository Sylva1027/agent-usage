# WorkBuddy 数据源

更新：2026-10-21（首次接入）。本文维护 WorkBuddy 会话转录（JSONL）与 trace（JSONL）的读取规则；共同规则见[数据来源](../10-data-sources.md)，计价见[计价规则](../11-pricing.md)，施工与验收见[实施计划](../plans/2026-10-21-workbuddy-implementation-plan.md)与[验收目录](../validation/2026-10-21-workbuddy-implementation/README.md)。

> 结构结论来自 2026-10-21 的本机样本（4 个会话文件、453 条带 `providerData.usage` 的记录、7 条 Auto、20 个 trace 文件、458 个 `generation` span）。不代表未来版本。

## 存储布局

| 项目 | 位置 |
|---|---|
| WorkBuddy home | `~/.workbuddy-ai`（默认；可用 `CODEX_USAGE_WORKBUDDY_HOMES` 追加，`CODEX_USAGE_WORKBUDDY=0` 关闭） |
| 会话转录 | `<home>/projects/<cwd-slug>/<sessionId>.jsonl` |
| 响应时长（trace） | `<home>/traces/<pid>/trace_*.jsonl` 的 `span_end` 记录 |
| 显式跳过 | `<sessionId>/tool-results/`（外部化的大工具输出，单文件可达数十 MB）、非 `.jsonl` 文件 |
| 导入 | 只收**目录**（`workbuddy-home`），不收单个 `.jsonl` 路径 |

WorkBuddy 没有 Codex 那样的限额存储，因此**不参与** Codex 的 5 小时与每周限额窗口（`nonCodexHomeIds()` 按 `kind` 自动排除）。

### 分类顺序（内容判别）

`~/.workbuddy-ai/projects/<slug>/*.jsonl` 会同时满足 `claudeHomeLooksUsable`（只看 `projects/*/*.jsonl` 存在），所以**不能靠目录结构区分**。判据是内容：`projects/<slug>/*.jsonl` 的前 64 KiB 里出现 `"type":"session-meta"` 或 `"type":"function_call"`（最多探测 3 个文件）。

`classifyImportDirectory` 里 **WorkBuddy 判定必须排在 Claude Code 之前**；同时不能挪到 ZCode/DSH/OpenCode 之前（那三个判据更具体）。`test/workbuddy-core.test.js` 用"同一夹具删掉内容行后不再判为 workbuddy-home"和"纯 Claude home 仍判 claude-home"两条钉住顺序与判据。

## 记录结构与去重

每行一个 JSON 对象。适配器只认 `type` 属于 `function_call` / `message`、且带 `providerData.usage` 与 `providerData.messageId` 的记录；`session-meta`、`function_call_result`、`reasoning`、`ai-title`、`file-history-snapshot` 一律跳过（即使被构造成带 `usage` 也不产事件）。

```jsonc
{ "type": "function_call", "timestamp": 1792537466382,
  "sessionId": "21201ca7-…", "cwd": "e:\\12 AI\\ccusage\\codex-usage",
  "providerData": {
    "messageId": "01a15b8f08017822aace05dcf0e57787",   // 一次响应的身份
    "model": "deepseek-v4.1-flash",                    // 线路模型
    "requestModelName": "Deepseek-V4.1-Flash",         // 请求侧别名（Auto 时为 "Auto"）
    "usage": { "inputTokens": 37336, "outputTokens": 324, "totalTokens": 37660,
               "inputTokensDetails": [{ "cached_tokens": 0 }],
               "outputTokensDetails": [{ "reasoning_tokens": 135 }] },
    "rawUsage": { "cache_creation_input_tokens": 0 } },
  "message": { "usage": { "input_tokens": 37336, "output_tokens": 324, "total_tokens": 37660 } } }
```

**一次模型响应会写成多行**（每个工具调用一行，另有 `message` 一行），只有其中一条携带 `providerData.usage`。适配器以 `providerData.messageId` 为去重键，同 id 只产一个事件（`test/workbuddy-usage.test.js` 用"5 条同 id、仅 1 条带 usage ⇒ 1 个事件"钉住）。去重是**文件内**的；同一份数据被复制成两个文件时会各算一次（见"已知限制"）。

### 输入口径是反的

与 Claude Code 相反，WorkBuddy 的 `usage.inputTokens` **已包含缓存**、`outputTokens` **已包含 reasoning**：

| 看板字段 | 来源 | 说明 |
|---|---|---|
| `input` | `providerData.usage.inputTokens` | 已是请求侧总量，**不能**再加 `cached_tokens` |
| `cached` | `inputTokensDetails[0].cached_tokens` | `input >= cached` 恒成立 |
| `output` | `providerData.usage.outputTokens` | 含 reasoning |
| `reasoning` | `outputTokensDetails[0].reasoning_tokens` | |
| `total` | `usage.totalTokens` | 实测等于 `input + output` |
| `requestInputTokens` | `usage.input` | 与 Claude 相反，这里本身就是请求侧总量 |
| `cacheWriteTokens` | `rawUsage.cache_creation_input_tokens` | 本机恒 0 |
| `detailMask` | 四位齐全 ⇒ `15` | bit1 input / bit2 cached / bit4 output / bit8 reasoning |

`providerData.usage`、`providerData.rawUsage`、`message.usage` 三份冗余**只取第一份**，不做交叉校验、不累加（`test/workbuddy-usage.test.js` 用"改第二份的值不改变输出"钉住）。

### Auto 整体排除

`providerData.model === "default-model"` 或 `requestModelName` 归一化后等于 `auto` 的记录**整条丢弃**：Auto 没有确定的线路模型，无法计价，也无法归属 TPS 分母。同一文件里的非 Auto 记录不受影响。这是用户裁决（实施计划 §0），不是实现细节。

## TPS 与时长 side table

会话转录里**没有**可靠的首末时间戳，时长只存在于 trace：`<home>/traces/<pid>/trace_*.jsonl` 的 `span_end`，条件为 `span.type === "generation"` 且 `span.status === "ok"`。`span.toolOutput` 是 JSON 字符串，`[0].id` 就是该次响应的 `messageId`；`span.duration` 是**直接观测的毫秒数**（不是时间戳相减，因此 `timingSource = "explicit"`）。

| 项目 | 取值 |
|---|---|
| 表 | `workbuddy_generation_durations(message_id PK, duration_ms, ended_at_ms, capture_version, captured_at)` |
| 写入 | trace 预扫时 `INSERT OR IGNORE`（幂等、先到先得；同 id 多 span 只留第一条） |
| `capture_version` | `workbuddy.trace.v1` |
| 触发 | **只在会话文件需要重新解析时**（同一 home 每轮至多一次），且**在 `replaceFile` 事务之外** |
| 指纹 | 进程内 `Map<path,{size,mtimeMs}>`：跨轮保留、进程重启清空 ⇒ 首轮全扫；**不建**指纹表 |
| 保留 | 不主动清理。10 万条约 10 MB；回收若要做另开 CLI |
| 查询 | reader 通过 `lookupGenerationDuration(messageId)` 回调查表（`replaceFile` 内按调用建局部缓存） |

`duration <= 0`、非整数、`toolOutput` 无法解析、`status !== "ok"` 的 span **都不入库**——不制造 `DURATION_NONPOSITIVE` 假样本。缺时长的响应不产 TPS 候选，只累加计数，并在每 home 每轮合并成**一条普通 warning**（`<label>：N 个响应缺少 generation 时长`）；该计数**不进**冻结告警码域。

### 30 天窗口与表兜底

trace 只保留约 30 天，会话转录不清理。因此"删掉 trace 后再重解析会话"是正常场景：时长已经在表里，TPS 样本数**不变**（`test/workbuddy-store.test.js` 的"删掉 trace 目录后重解析会话文件 ⇒ 样本数不变"钉住）。反过来说，**从未被 trace 覆盖过**的历史响应没有时长，只能永久缺席 TPS。

### TPS 口径

`PERF_SOURCE_SEMANTICS.workbuddy = { window: "request", timingKind: "request_e2e", tokenScope: "reported_output_includes_reasoning" }`。`sampleKey` 是三元组 `["workbuddy", homeId, messageId]`；`methodVersion` 取默认 `tps-v1`（采集方法版本写在 `capture_version` 列，两者不是一回事）。`agentKind` 恒 `main`（`providerData.agent` 目前只区分 `cli`，没有子代理语义）。

## 已知限制

1. **去重是文件内的。** 同一份数据被复制成两份文件（或同一 home 被导入两次）时，事件会重复计入；时长表靠 `message_id` 主键先到先得，不会重复。
2. **时长表不区分 home。** `message_id` 是全局唯一 id，两个 home 出现同一 id 时共用第一条时长（实测不会发生，但不设约束）。
3. **无 trace 即无 TPS。** 只在 trace 覆盖窗口内的响应能算速度；Auto 响应永久无样本（已整体排除）。
4. **`serviceTier` 恒 `unknown`。** WorkBuddy 转录没有 Fast/priority 之类的档位字段。
5. **会话名不参与统计。** `ai-title` 记录被跳过，`conversationName` 为空。
