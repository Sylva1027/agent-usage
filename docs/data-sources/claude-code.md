# Claude Code 数据源

更新：2026-10-20（模型身份改为线路模型）。本文维护当前支持的 Claude Code 会话转录（JSONL）；共同规则见[数据来源](../10-data-sources.md)，计价见[计价规则](../11-pricing.md)。

> 结构结论来自 2026-10-20 的本机样本（Claude Code 2.1.299：10 个 JSONL、4,191 行、1,565 条 assistant 记录，去重后 608 个唯一 `message.id`；另有 4 个子代理文件、581 条 sidechain 记录）。不代表未来版本。

## 存储布局

| 项目 | 位置 |
|---|---|
| Claude Code home | `~/.claude`（默认；`CLAUDE_CONFIG_DIR` 指定的目录与默认位置**并存**发现；可用 `CODEX_USAGE_CLAUDE_HOMES` 追加，`CODEX_USAGE_CLAUDE=0` 关闭） |
| 主转录 | `<home>/projects/<encoded-cwd>/<sessionId>.jsonl` |
| 子代理转录 | `<home>/projects/<encoded-cwd>/<sessionId>/subagents/agent-<agentId>.jsonl` |
| 显式跳过 | `<sessionId>/tool-results/`（外部化的大工具输出，单文件可达数十 MB）、`memory/`、非 `.jsonl` 文件 |
| 导入 | 只收**目录**（`claude-home`），不收单个 `.jsonl` 路径 |

Claude Code 没有 Codex 那样的限额存储，因此**不参与** Codex 的 5 小时与每周限额窗口（`nonCodexHomeIds()` 按 `kind` 自动排除）。

### 分类顺序

`~/.claude/sessions/` 与 Codex 的 `sessions/` 同名。`classifyImportDirectory` 里 **Claude 判定必须排在 Codex 之前**，否则一个含 `sessions/` 的 Claude home 会被误判成 `codex-home`。`test/usage-core.test.js` 用"同时含 `sessions/` 的 `.claude` 目录"钉住这条。

## 记录结构

每行一个 JSON 对象。适配器只处理 `type === "assistant"` 且 `message.usage` 存在的记录，其余类型（`user`、`system`、`summary`、`custom-title`、`agent-name`、`file-history-snapshot` 等）忽略；未知 `type` 一律跳过，不按 `version` 硬拒绝。

```jsonc
{ "type": "assistant", "uuid": "...", "timestamp": "2026-10-19T20:00:00.000Z",
  "sessionId": "...", "cwd": "/work/project", "version": "2.1.299",
  "requestedModel": "claude-sonnet-4-5",
  "message": { "id": "msg_...", "model": "claude-sonnet-4-5",
               "usage": { "input_tokens": 100, "cache_read_input_tokens": 900,
                          "cache_creation_input_tokens": 50, "output_tokens": 20,
                          "output_tokens_details": { "thinking_tokens": 12 },
                          "service_tier": "standard" } } }
```

### 必须按 `message.id` 去重

一条 assistant 消息**按内容块拆成多行**写入（实测同一 `message.id` 重复 1–6 次，内容块不同但 `usage` 相同）。直接累加会把 token 放大 2.5–3 倍。适配器以 `message.id` 为去重键，保留 **token 总和最大** 的那条记录；缺失 `message.id` 时退回 `uuid`（记录级唯一，但无法跨块去重），并发一条 `CLAUDE_MISSING_MESSAGE_ID:<n>` 告警。

去重键同时也是 `eventId`，所以重复解析同一文件不会产生重复事件。

### 子代理

子代理转录在**独立文件**里，父转录没有对应记录；只扫主文件会明显少算。子代理文件先写**零用量占位块**、最后一块才有真实 `usage` —— 这正是"取 token 最大者"要覆盖的第二种情形（零用量记录本身也会被直接跳过）。

按产品口径，子代理用量**计入总量并合并到主渠道** `Claude Code`，`sessionId` 取父会话 id（不是 `agentId`），因此会话数不虚增。

2026-10-20 本机实测：12 个文件（7 个主转录 + 5 个子代理），1,199 个事件里 305 个来自子代理（25.4%），140,133,520 tokens 里 33,934,976 来自子代理（24.2%）。只扫主文件会少算约四分之一。

## 用量字段与口径

Claude 的三个输入计数是**并列**的（`input_tokens` 不含缓存），必须重构成看板要求的超集：

| 看板字段 | 取值 |
|---|---|
| `input` | `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`（总输入） |
| `cached` | `cache_read_input_tokens` |
| `cacheWriteTokens` / `cacheWriteKnown` | `cache_creation_input_tokens` / 字段存在且为有限数 |
| `output` | `output_tokens` |
| `reasoning` | `output_tokens_details.thinking_tokens`（存在且为有限数才置位） |
| `total` | `input + output`（构造值，恒满足总量恒等） |
| `requestInputTokens` / `contextLevel` | 总输入；`> LONG_CONTEXT_INPUT_THRESHOLD` 为 `long` |
| `detailMask` | input \| cached \| output \| cacheWrite（+ reasoning 若有） |

重构后天然满足 `cached ⊆ input`，`validateUsageDetails()` 不会产生不一致位（`test/claude-code-usage.test.js` 精确断言 `{total: 25_500, input: 25_000, cached: 20_000, output: 500, reasoning: 120}` 且 mask 无 inconsistent 位）。

### 其他映射

| 看板字段 | 来源 |
|---|---|
| `channel` / `source` | 恒为 `Claude Code` / `claude`（主转录与子代理合并） |
| `sessionId` | `record.sessionId`，缺失时用文件名去扩展名 |
| `cwd` / 仓库归属 | `record.cwd`，经 `createRepositoryResolver()` |
| `model` | `message.model`（线路模型）→ `requestedModel` → `Unknown model`；`<synthetic>` 等占位名视为缺失 |
| `conversationName` | `custom-title` / `agent-name` 记录，后写覆盖先写，截断 120 字符 |
| `serviceTier` | `usage.speed === "fast"` → `fast`；否则 `service_tier` 归一化（`standard`/`default` → standard，`priority`/`fast` → fast，其余 unknown） |
| `priceVersion` | `pricingVersionForTimestamp(timestamp)` |

**模型身份取 `message.model`（API 实际服务的线路模型），不是 `requestedModel`。** `requestedModel` 是请求侧的 harness 别名：直连时是 tier 别名（内置子代理定义里的 `model: "haiku"`），经网关时是路由名（本机的 `mythos-magpie-*`）。两者在网关场景下必然不同，而只有线路模型能被价目表识别。

识别方法不是硬编码映射，而是两条独立的证据链（2026-10-20 本机实测，见[验收记录](../validation/2026-10-20-claude-model-identity/README.md)）：

1. **响应 id 连接**：转录 `message.id` 就是网关账本 `response_id`。1,498/1,499 个唯一 id 在账本里找到，`message.model` 与账本 `served` 字段 **0 处分歧**；账本同时给出路由链 `req → served`（如 `workbuddy-ai/deepseek-v4.1-flash → deepseek-v4.1-flash`）。未匹配的 1 个是 `<synthetic>` 本地记录。
2. **计数器连接**：同一批 id 的 `input/output/cache_read/cache_creation` 与账本 `in/out/cache_read/cache_write` **1,498/1,498 逐项精确相等**，说明匹配的是同一次请求而不是同名巧合。

因此 `mythos-magpie-3145220055` / `-3772476608` / `-5487751739` 分别解析为 `deepseek-v4.1-flash`、`deepseek-v4.1-flash-sg`、`deepseek-v4.1-flash`（第三个走的是 `opencode-go` 路由）。适配器不认识这些名字，它只读线路模型。

**`claude-haiku-5-5` 也是同一机制，不是 Anthropic Haiku 用量。** 它来自内置 `claude-code-guide` 子代理：二进制里的代理定义写的是 `model:"haiku"`（tier 别名），harness 解析后把 `claude-haiku-5-5` 记进 `requestedModel`，而线路模型是 `deepseek-v4.1-flash`（workbuddy-ai 订阅）。26 个 id、1 个会话，全部有账本对照。该子代理在账本里另有 14 行没有落盘（4 行 `claude-haiku-5-5` + 10 行网关路由名，均无 `effort` 字段、token 签名与任何转录行都不重复），按网关侧完成但 harness 未收到响应处理，不影响身份。详见[验收记录](../validation/2026-10-20-claude-model-identity/README.md)。

### 排序与坏行

文件顺序不保证单调（实测有倒序）。读完后按 `timestampMs` 再按 `eventId` 排序输出。`JSON.parse` 失败只计数并在文件末发一条 `CLAUDE_MALFORMED_JSON:<n>` 告警，不中断其余记录。

### 未收录模型

改用线路模型后，本机 Claude 转录里的模型是 `deepseek-v4.1-flash` 与 `deepseek-v4.1-flash-sg`，两者都在价目表内：前者精确命中，后者按既有的后缀规则（`<catalog-key>-*`，最长键优先）解析到同一价目。因此这些事件**按真实单价计价**，不再走未知模型回退。

`claude-haiku-5-5` 这类名字只在 `message.model` 缺失或为占位符时才会作为回退身份出现；此时它仍受计价端的 Claude 守卫（任何 `claude-` 前缀都不借用旧 Claude 价）约束，显示为缺价。`src/pricing.js` 未改动。

如需为价目表外的模型补录单价，可用 `~/.codex-usage/pricing.json`；补录后按精确价目计价。

### 1 小时缓存写

转录的 `cache_creation` 区分 5 分钟与 1 小时 TTL，但索引不持久化 TTL，费用端按 5 分钟场景估算并带 `cache-write-ttl-unknown-5m-scenario` 提示。本次不扩展 schema。

## 输出吞吐（TPS）

**已提供（2026-10-21）。** Claude 转录没有显式请求时长，但同一 `message.id` 的末行时间戳减请求锚点就是请求端到端时长：`window = "request"`、`timingKind = "request_e2e"`、`timingSource = "timestamp_fallback"`、`tokenScope = "reported_output_includes_reasoning"`。它含请求等待与 TTFT，不是纯解码速度。锚点按**文件顺序**取运行最大值的 `user` / `attachment` 行；文件顺序不保证时间单调，不能先按时间排序再扫。完整规则见 [Claude Code TPS 方案](../plans/2026-10-21-claude-code-tps-plan.md)与[实施计划](../plans/2026-10-21-claude-code-tps-implementation-plan.md)。

三条容易被误解的边界：

1. **只对紧随 prompt/attachment 行的请求计时，同轮续写不采样。** 若一条消息的首行之前已写过 assistant 行，锚点已陈旧，只能落在上一响应写盘的时刻，会把 harness 处理间隙算进请求（本机该例多算 624 ms）；这类消息不产出样本，计入 `skippedNoAnchor`。每条 Claude 样本的锚点都落在真实的 user/attachment 行上。
2. **TPS 分子比事件路径的 output 总和少 0.0137%（597 token）。** 被剔除的那条同轮续写仍留在事件路径，面板 token 总量仍包含它；采样集内部（本机 3,263 条）两者逐位相等。这 597 token 占事件路径 output 的 0.0137%，不能把「分子必须等于事件输出」当作校验条件。
3. **已进入统一排名：池化均值可比，p10/p90 不可比。** Claude 与修订后的 Codex v2 同属 `request_e2e`，池化均值（总输出 / 总时长）可以同表排名；但 Claude 是**请求级**分布、Codex 是轮级分布，p10/p90 仍是各自粒度的请求级历史分布，跨来源的分位差不能直接比较。

精度证据（2026-10-21 本机只读核对）：与网关账本按 `message.id` 逐条关联 2,747 条，时长比值 p50 1.008、p99 1.0249、max 1.0416，绝对误差 max 125 ms，池化 154.21 vs 154.96 tok/s（−0.48%）；输出 token 2,747/2,747 精确相等。证据只覆盖约 33 小时、13 个会话、Claude Code 2.1.299 与一条网关路由，不能外推为所有 Claude Code 用户的精度。

来源在 perf 注册表中具名 `Claude`（`canonicalPerfSourceKind("claude")`）；样本键只用 `message.id`，不按会话或时间窗匹配（账本里同一会话的辅助请求没有 `message.id`，因此不会进入统计）。注册前 `classifyPerfSources` 把它放在 `notEnabled` 桶、`kind` 为 `"unsupported"`，界面把两个桶合并显示为「不支持来源」；现在它位于 `enabled`。

## 增量索引

`UsageStore.usageFiles()` 对 `kind === "claude"` 的 home 展开 `claudeSessionFiles()`，每个 JSONL 各自按 `size + mtime` 判定是否重解析。主转录变化会按会话级联到同会话的子代理文件（C5 的 `earlierFileChanged` 语义），这是预期行为。

**迁移只在进程启动时执行。** v15→v16 的标脏发生在打开索引时，已在运行的旧进程不会自行重扫，界面会继续显示 `requestedModel` 身份。升级后需重启看板服务（`node src/cli.js restart`）才会重读 Claude 转录；重启后 `PRAGMA user_version` 为 16，`events` 中 `home_id` 属 Claude 的行不应再有 `mythos-magpie-*` 或 `claude-haiku-5-5`。

## 隐私口径

只提取 `timestamp`、`sessionId`、`cwd`、`requestedModel`、`message.id`、`message.model`、`message.usage` 与标题白名单字段。消息正文、工具参数、工具结果**不进入任何产出事件、SQLite 索引与日志**；`tool-results/` 目录根本不打开（`test/claude-code-usage.test.js` 放了 `SENTINEL-TOOL-OUTPUT` 哨兵文件守着）。

文件读取边界见[共同说明](../10-data-sources.md#读取与数据边界)。

## 保留期

Claude Code 默认只保留 30 天转录，过期即从磁盘消失。看板索引保留已解析事件，但不能假设可回溯重扫。TPS 样本与转录同寿：文件消失后 `source_files` 行删除，对应 `perf_samples` 级联清除，历史 TPS 无法从已过期文件重建。

## 相关文件

| 文件 | 作用 |
|---|---|
| `src/claude-code-usage.js` | 解析与归一化 |
| `src/usage-core.js` | 发现、分类、指纹、索引、report 接线 |
| `src/usage-store.js` | SQLite 增量索引（v16）与 harness 归组 |
| `src/server.js` | 导入标签（`Claude Code <name>`） |
| `public/timeline-utils.js` | `sourceGroup` / 限额按钮排除 |
| `public/app.js` | `HARNESS_ORDER` / `bucketForChannel` |
| `test/claude-code-usage.test.js` | 单元与语义测试 |
| `test/three-path-parity.test.js` | 内存 / SQLite / 静态快照三路一致 |
