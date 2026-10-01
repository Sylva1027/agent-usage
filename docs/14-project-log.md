# 项目日志接入规范

更新：2026-10-01。面向接入开发者和执行模型，说明其他项目如何产出 Agent Usage 可识别的真实 Token 用量。本文从根目录 `log-README.md` 整合而来；共同统计规则见[数据来源](10-data-sources.md)。

不要默认把本文件复制到目标项目。读取本文件后，在目标项目代码里实现日志写入，让目标项目生成：

```text
<target-project>/.codex-usage/usage.jsonl
```

只要这个文件存在，`codex-usage` 前端的“导入目录”就可以导入 `<target-project>` 目录。

## 接入任务

1. 找到目标项目里实际调用 Codex、`codex-oauth` 或 OpenAI-compatible 模型 API 的代码路径。
2. 在每次请求成功返回后，从响应对象中读取真实 token usage。
3. 每次请求向 `.codex-usage/usage.jsonl` 追加一行 JSON。
4. 如果 `.codex-usage/` 不存在，先创建它。
5. 除非用户明确要求提交本地用量日志，否则把 `.codex-usage/` 加入目标项目的 `.gitignore`。
6. 不要记录 prompt、completion、messages、API key、OAuth token、cookie、Authorization header 或完整请求/响应正文。
7. 如果响应里没有真实 token usage，不要估算。跳过这条事件，或在 `usage.jsonl` 之外输出本地 warning。

## 日志位置

默认日志文件必须是：

```text
<target-project>/.codex-usage/usage.jsonl
```

格式是 JSONL，不是 JSON 数组。每一行是一条独立 JSON 对象。

## JSONL Schema

每行推荐格式：

```json
{
  "schema_version": "codex-usage.project-log.v1",
  "timestamp": "2026-05-31T12:00:00.000Z",
  "source": "claudish",
  "channel": "Claudish",
  "provider": "openai-codex",
  "auth": "codex-oauth",
  "api_surface": "chatgpt-codex-responses",
  "project_root": "/absolute/path/to/project",
  "cwd": "/absolute/path/to/project/or/current/workdir",
  "session_id": "stable-session-or-run-id",
  "request_id": "provider-request-id-if-available",
  "model": "gpt-5.5",
  "usage": {
    "total": 12345,
    "input": 10000,
    "cached": 6000,
    "output": 2345,
    "reasoning": 500
  }
}
```

必填字段：

- `schema_version`：固定为 `codex-usage.project-log.v1`
- `timestamp`：请求完成时间，ISO 8601 格式
- `source`：机器可读的产生日志的项目或组件，例如 `claudish`、`codex-api-service`、`my-agent`
- `channel`：前端展示名称，通常对应产生日志的项目或组件，例如 `Claudish`、`Codex API Service`
- `project_root`：目标项目根目录的绝对路径
- `cwd`：这次请求发生时的工作目录绝对路径
- `session_id`：一次会话、一次批处理或一次进程运行的稳定 ID
- `model`：请求使用的模型名
- `usage.total`：服务商返回的总 token 数
- `usage.input`：服务商返回的输入 token 数
- `usage.output`：服务商返回的输出 token 数

可选字段：

- `request_id`：服务商 request id，如果能拿到就写
- `provider`：实际调用的上游 provider，例如 `openai-codex`、`openai`、`anthropic-compatible`
- `auth`：认证方式，例如 `codex-oauth`、`api-key`、`none`
- `api_surface`：接口形态或后端面，例如 `chatgpt-codex-responses`、`openai-responses`、`openai-chat-completions`
- `usage.cached`：缓存命中输入；确知为零时写 `0`，上游未提供时省略以保留未知状态。
- `usage.reasoning`：总输出中的推理子集；确知为零时写 `0`，未提供时省略。
- `usage.cache_write_input_tokens`：明确的缓存写入输入，确知为零时可写 `0`。
- `service_tier`：明确的服务档位，如 `standard`、`fast` 或 `priority`；未提供时不猜测。

## Token 语义

- `cached` 通常是 `input` 的子集，不要把它再额外加进 `total`。
- `reasoning` 通常是输出 token 的明细或子集；只有服务商返回真实值时才写。
- 若服务商将可见输出与推理分别提供，应按其已确认语义合成总输出，再保留推理子集；原始 input/cache/write 若为并列关系，也须先重构总输入。
- `usage.total` 优先使用服务商返回的 `total_tokens` 或等价字段。
- 不要根据 prompt 或 response 文本倒推历史 token 用量。

## 常见字段映射

OpenAI 风格响应通常可以这样映射：

```text
usage.total_tokens -> usage.total
usage.input_tokens or usage.prompt_tokens -> usage.input
usage.output_tokens or usage.completion_tokens -> usage.output
usage.cached_input_tokens or usage.prompt_tokens_details.cached_tokens -> usage.cached
usage.reasoning_output_tokens or usage.output_tokens_details.reasoning_tokens -> usage.reasoning
```

## 来源字段建议

`source` 和 `channel` 应该表达“谁产生日志”，不要只表达认证方式。认证方式请放到 `auth`，上游 provider 请放到 `provider`。

例如 `claudish` 通过 `codex-oauth` 调用 `openai-codex` 时，推荐设置：

```json
{
  "source": "claudish",
  "channel": "Claudish",
  "provider": "openai-codex",
  "auth": "codex-oauth",
  "api_surface": "chatgpt-codex-responses"
}
```

如果另一个项目直接调用同一套 `codex-oauth`，也应该把 `source` 写成那个项目自身，例如 `codex-api-service`。这样 `codex-usage` 的分组能回答“哪个项目产生了用量”，同时仍然保留“它通过什么认证和上游接口调用”的信息。

## 写入规则

追加 JSONL，不要每次重写整个文件。

伪代码：

```text
ensure directory "<project_root>/.codex-usage" exists
build event from real response usage
append JSON.stringify(event) + "\n" to "<project_root>/.codex-usage/usage.jsonl"
```

如果目标项目可能并发发起多个请求，使用目标语言的 append mode。不要把日志读出来、拼接、再整体写回。

`request_id` 不只是展示字段：当前解析器有请求标识且输入明细已知时，才将该行输入视为单次请求上下文证据。按请求记录增量，不写跨请求累计值；缺少 ID 或可信明细时保持上下文 unknown。

项目日志不参与 Codex 限额窗口，资格由来源 kind 决定，不因 channel 或 auth 的名称改变。

## 最小校验

完成接入后，让目标项目实际跑一次模型请求，然后在目标项目根目录执行：

```powershell
node -e "const fs=require('node:fs'); const text=fs.readFileSync('.codex-usage/usage.jsonl','utf8').trim(); if(!text) throw new Error('Empty usage log'); for(const line of text.split(/\r?\n/)) JSON.parse(line); console.log('JSONL syntax OK');"
```

该命令只检查非空与 JSONL 语法，不能证明 Token 语义、时间和模型正确。继续核对字段、input/cache/output/reasoning 的子集关系及敏感内容，再导入项目目录，与上游单次请求记录对照统计和计价。解析入口见 [usage-core.js](../src/usage-core.js)，相关回归见 [usage-core 测试](../test/usage-core.test.js)与[三路一致测试](../test/three-path-parity.test.js)。
