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

与 Claude Code 相反，当前安装版本（`5.8.4` / bundle `37.10.3-42`）的 Chat Completions 适配路径中，WorkBuddy 的 `usage.inputTokens` **已包含缓存**、`outputTokens` **已包含 reasoning**：

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

依据不是字段名或样本猜测：安装包 `main/netdrive-env-route.js` 将 Agent SDK usage 写入 `providerData`；`@openai/agents-openai` 的 Chat Completions 适配器把 `outputTokens` 设为 `completion_tokens`，把 `reasoning_tokens` 放入独立 detail；同包 OpenAI 类型文档明确 reasoning 类 token 仍计入 completion 总量。该认证只覆盖当前安装的 Chat Completions 路径，不外推到未来版本或违反该契约的兼容 provider。

### Auto 整体排除

`providerData.model === "default-model"` 或 `requestModelName` 归一化后等于 `auto` 的记录**整条丢弃**：Auto 没有确定的线路模型，无法计价，也无法归属 TPS 分母。同一文件里的非 Auto 记录不受影响。这是用户裁决（实施计划 §0），不是实现细节。

## TPS 与时长 side table

会话转录里**没有**可靠的首末时间戳，时长只存在于 trace：`<home>/traces/<pid>/trace_*.jsonl` 的 `span_end`，条件为 `span.type === "generation"` 且 `span.status === "ok"`。`span.toolOutput` 是 JSON 字符串，`[0].id` 就是该次响应的 `messageId`；`span.duration` 是**直接观测的毫秒数**（不是时间戳相减，因此 `timingSource = "explicit"`）。

| 项目 | 取值 |
|---|---|
| 表 | `workbuddy_generation_duration_observations`，主键为 `(home_id, message_id, duration_ms)`；旧无 home 表保留 |
| 写入 | trace 预扫时保存全部 distinct duration；同值幂等，异值持久冲突，不能先到先得 |
| `capture_version` | `workbuddy.trace.v1` |
| 触发 | 每轮普通 sync 独立预扫（同一 home 每轮至多一次），在 `replaceFile` 事务之外；新 observation 定位相关会话重建 |
| 指纹 | 进程内 trace 指纹跨轮复用，重开后重新预扫；trace 依赖同时进入 memory/store 性能版本及读取稳定性检查 |
| 保留 | 不主动清理。10 万条约 10 MB；回收若要做另开 CLI |
| 查询 | reader 通过 `lookupGenerationDuration(messageId)` 回调查表（`replaceFile` 内按调用建局部缓存） |

`duration <= 0`、非整数、`toolOutput` 无法解析、`status !== "ok"` 的 span **都不入库**——不制造 `DURATION_NONPOSITIVE` 假样本。缺时长的响应不产 TPS 候选，只累加计数，并在每 home 每轮合并成**一条普通 warning**（`<label>：N 个响应缺少 generation 时长`）；该计数**不进**冻结告警码域。

### 30 天窗口与表兜底

trace 只保留约 30 天，会话转录不清理。已归属的时长 observation 与冲突不会因删除 trace 或重开而消失。旧无 home 表仅在恰好一个启用的 WorkBuddy home、且该消息没有 scoped observation 时兜底；多 home 不借用旧值。单→多会撤出依赖兜底的候选，多→单恢复允许的旧值，原记录不删除。历史响应若从未采到可靠计时，就保持缺失，不能由会话相邻时间推算。

### TPS 口径

`PERF_SOURCE_SEMANTICS.workbuddy = { window: "request", timingKind: "request_e2e", tokenScope: "reported_output_includes_reasoning" }`。`sampleKey` 是三元组 `["workbuddy", homeId, messageId]`；`methodVersion` 取默认 `tps-v2`（采集方法版本写在 `capture_version` 列，两者不是一回事）。`agentKind` 恒 `main`（`providerData.agent` 目前只区分 `cli`，没有子代理语义）。

`workbuddyGenerationSpans()` 按稳定文件路径顺序保留每个合格 generation span，不在解析阶段选一条。memory/store 均按 distinct duration 归并：一个值可用，多个值阻断该消息。当前安装版本 Chat adapter 的输出包含 reasoning 证据已留存，但样本尚缺逐条版本 provenance，因此保留自身速度统计、统一 `rank=null`。实现与隔离验收见[计量修订账本](../validation/2026-10-21-tps-measurement-correction/README.md)，不代表正式服务已迁移。

## 已知限制

1. **用量去重是文件内的。** 同一份数据复制成两份文件可能重复计入用量；性能候选另按稳定 sampleKey 去重。
2. **旧值缺 home 归属。** 新 observation 已按 home 隔离；旧表仅按上述单 home 条件兜底，不猜测多 home 的归属。
3. **无 trace 即无 TPS。** 只在 trace 覆盖窗口内的响应能算速度；Auto 响应永久无样本（已整体排除）。
4. **`serviceTier` 恒 `unknown`。** WorkBuddy 转录没有 Fast/priority 之类的档位字段。
5. **会话名不参与统计。** `ai-title` 记录被跳过，`conversationName` 为空。
