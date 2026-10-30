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

## 实际输出速度（TPS）

当前 tps-v7 读取专用 CLI 启动器保存的本地接收窗口。实际 CLI 使用 Axios/Node HTTP，通过 `IncomingMessage.push` 获取消费者解析之前的接收批次；同一同步批次合并，正文与工具参数按完整 lane 使用 `o200k_base` 编码一次。`X-Conversation-ID` 和 `X-Conversation-Message-ID` 提供本地身份，不能用不同的 wire response ID 猜配。

观测位于 `<home>/generation-timing/<session哈希>.jsonl`，以 session 与本地 message ID 精确关联，并参与 reader 指纹与正常增量刷新。仅保存标量计数、时窗及身份，不复制正文。当前支持未压缩 HTTP 传输；出现背压会保留正常应用行为并撤销该次测量。实际 CLI 2.165.0 的原始会话、内存 reader、SQLite 闭环已核对。

安装和启动见[本地采集安装](../10-data-sources.md#本地采集安装)。只有经专用启动器发起的新 CLI 请求具备该观测；WorkBuddy Desktop 尚未接入。缺测请求保留用量和模型身份，不从 trace span 或 `qua.end` 回退成新口径速度。Auto 的原有整体排除规则不变。

历史 `workbuddy_generation_duration_observations` 仍按 home/message 保存 trace 的 distinct duration，并保留冲突及恢复语义。generation span 的完整调用时长不等同于当前可见输出的窗口，旧 v1-v6 数值不会混入 v7。原生 output/reasoning 继续用于用量与费用，不参与参考 token 分子。完整验收见[本轮记录](../validation/2026-10-31-receive-clock-tps/README.md)。

## 已知限制

1. **用量去重是文件内的。** 同一份数据复制成两份文件可能重复计入用量；性能候选另按稳定 sampleKey 去重。
2. **旧值缺 home 归属。** 新 observation 已按 home 隔离；旧表仅按上述单 home 条件兜底，不猜测多 home 的归属。
3. **当前速度需要新采集观测。** 旧 trace 不能补出接收批次，WorkBuddy Desktop 尚未接入；Auto 继续整体排除。
4. **`serviceTier` 恒 `unknown`。** WorkBuddy 转录没有 Fast/priority 之类的档位字段。
5. **会话名不参与统计。** `ai-title` 记录被跳过，`conversationName` 为空。
