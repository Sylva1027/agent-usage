# Claude Code TPS 接入方案：转录时间戳的请求端到端口径

日期：2026-10-21。状态：**方案完成、未实施**。本稿只回答"能不能做、按什么口径做、改动落在哪"；不修改代码、不改写现有文档结论、不重启服务、不写真实索引、不打开 `tools/out`。

本稿与 [TPS 计量口径修订方案](2026-10-21-tps-measurement-correction-plan.md) 并行，不替代它：那份处理 Codex 旧分母的范围不匹配；本稿只新增一个来源。两者都会改 `src/perf-stats.js`，但改动面不相交（那份改 Codex 的准入元组与 tps-v2，本稿只加 `claude` 的四行加法），在同一个工作区里按各自的卡顺序推进即可，不需要把本稿排进另一条线的波次。施工顺序见 §7。

## 0 结论摘要

| 问题 | 结论 |
| --- | --- |
| 能不能做 | 能。转录没有时长字段，但同一 `message.id` 的末行时间戳减请求锚点就是请求端到端时长 |
| 精度 | 与网关账本逐条对齐 2,747 条：时长比值 p50 **1.008**、p99 1.0249、max 1.0416；绝对误差 max 125 ms；池化 154.21 vs 154.96 tok/s（**−0.48%**） |
| 分子 | 采样集内与事件路径同一批 `message.id`、同一 token 总数（4,370,010 == 4,370,010）；采样集外有 1 条 597 token 只在事件路径（§1.3） |
| 口径 | `window="request"`、`timingKind="request_e2e"`、`timingSource="timestamp_fallback"`、`tokenScope="reported_output_includes_reasoning"` |
| 排名 | **纳入统一排名**（`isPerfRankAdmitted` 增加 `claude` 分支），因此会改 `src/perf-stats.js` 的准入函数，见 §6.5 |
| 要改什么 | 规范 kind + 语义 + 新 reader + 文件发现 + UI 标签 + 排名准入 + 4 处钉住测试；**无 schema、无迁移、无 `PERF_METHOD_VERSION` 变更** |
| 不能宣称什么 | 不是纯解码速度（TTFT 占请求时长 p50 63%）；本机证据只覆盖约 33 小时、13 个会话、一条网关路由 |

## 1 已确认的事实

### 1.1 语料快照与测量方式

只读扫描 `C:/Users/Silver/.claude/projects`，快照时刻 **2026-10-21T04:36:21Z**：

| 项 | 值 |
| --- | --- |
| 文件 | 19（其中 6 个子代理 `subagents/agent-*.jsonl`；13 个含 `queue-operation` 行，本方案不采用） |
| 会话 | 13（子代理文件继承父会话 `sessionId`，6/6 与父目录同名） |
| 版本 | Claude Code `2.1.299`（全部文件一致） |
| 行数 / 体积 | 21,331 行 / 90.0 MB；解析 164 ms（约 1.8 ms/MB） |
| 无时间戳行 | 4,868（`custom-title` 1,142、`atis-latch` 1,126、`agent-name` 1,123、`last-prompt` 1,119、`mode` 300、`file-history-snapshot` 52、`cost-state` 6） |
| 坏行 | 0；`assistant` 行缺 `usage` 0；缺 `message.id` 0 |
| 去重后消息 | 3,266 个 `message.id`；去掉 1 条 `<synthetic>` 后 3,265 条 |
| 可采样 | **3,263**（两个缺口：1 条全零用量消息见 §5.1，1 条锚点陈旧见 §5.2） |
| 时间跨度 | 2026-10-19T19:24Z 起，快照时约 33 小时（仍在增长） |

**语料是活的，而且包含这次分析本身。** 同一天内四次快照的消息数为 3,084 → 3,138 → 3,153 → 3,265，本会话的转录也在持续写入。所有计数取各自快照时刻；**比值分位与池化 TPS 在四次快照间逐位相同**（1.008 / 1.0174 / 1.0249、154.21），新增会话没有改变结论。

上表是锁定快照（2026-10-21T04:36Z）。少数条目来自稍后的复核，已在原处标注"复核快照"：§1.5 第 2、3、7 条（17,092 条带时间戳行）、§2.2 的 3,376 条、§3 表下的 3,453/3,454 条。差异只来自转录增长，不来自口径。§1.2 的账本对比在更晚一次复核中重跑，仍是 2,747 条、2,747 条 token 相等——命中集没有随语料增长而扩大，因为账本窗口停在 02:36Z。

测量方式：只读扫描转录 + 离线比对本机 Magpie 网关账本。**没有执行产品代码、没有打开任何数据库、没有写索引**；账本只在分析脚本里读，产品路径永远不会读它（§10）。

这些数字由一次性脚本产出，测完即删（脚本与账本导出含本机网关记录，不入库）；本稿保留结论与分位，不复刻原始行。C0 的夹具只从转录生成，不需要账本。

### 1.2 与网关账本的独立核对

账本（`agent = claude-desktop`，30 天 4,290 行）提供独立计时证据：

- 关联键：账本 `response_id` == 转录 `message.id`，精确匹配，不做模糊或时间近似。
- 4,290 行中 19 行无 `response_id`，4,271 个唯一 ID，**2,749 个**命中转录。
- 命中的 2,749 个里，**2,747 个**进入采样集（另 1 个是全零用量消息，按 §5.1 不采样；1 个锚点陈旧，按 §5.2 不采样）。账本侧少的是**样本**，不是转录行。
- **输出 token 2,747/2,747 精确相等**，没有"ID 对、计数错"的行。
- 时长比值 `(末行 − 锚点) / 账本 ms`：p50 **1.008**、p90 1.0174、p99 1.0249、min 1.0002、max **1.0416**。
- 绝对误差：p50 **37 ms**、p90 56 ms、p99 81 ms、max **125 ms**；>100 ms 6 条（含被剔除的回退锚点样本时是 7 条、max 624 ms）。
- 池化：转录 154.21 tok/s vs 账本 154.96 tok/s（**−0.48%**）。
- 主/子代理分别看：主代理 **2,950** 条 −0.50%，子代理 313 条 −0.34%——偏差不是某一类会话造成的（被剔除的那条是主代理，剔除后两位小数不变）。
- 命中样本覆盖全部采样输出 token 的 **77.02%**（分子分母同时少 597 token，2 位小数不变）。

账本覆盖窗 **2026-10-19T19:21:16Z – 2026-10-21T02:36:46Z**。窗内转录样本 2,747 条，**全部命中**；窗外 516 条（全部晚于 tMax）、窗内之前 0 条。因此"未命中"不是算法缺陷。

账本另有 **1,522 行**未命中（1,521 行 HTTP 200 + 1 行 499）。它们不是随机噪声，见 §5.8。

### 1.3 分子与事件路径一致

用量事件按"同一 `message.id` 取 token 和最大的一行"去重；TPS 候选按"同一 `message.id` 取输出最大的一行"。实测 3,265 条非 `<synthetic>` 消息中两种取法选中**同一行**（0 例外），最大 output 恒在该消息的末行。302 条消息的重复行之间 input 计数不同，但不影响选中行。

采样集内（3,263 条）分子总和 **4,370,010 == 4,370,010**。采样集外的 2 条：全零用量消息本来就没有 output；锚点陈旧的那条有 **597 token**，它留在事件路径、不进 TPS 分子——这是剔除回退锚点的已知代价，占事件路径 output 的 **0.0137%**，必须写在方法说明里，不能假装分子与事件路径永远逐位相等。

也就是说：TPS 的分子不是新算法，就是看板已经在显示的那批 output token，**减去 0.0137% 的不可计时请求**。

### 1.4 锚点语义的直接证据

把"首行 − 锚点 − `thinkingDurationMs`"与账本 `ttft_ms` 相减，2,199 条带思考时长的命中样本残差为：p50 **+38 ms**、p90 +57 ms、p99 +82 ms、min +8 ms、max 624 ms（该 max 与 §5.2 被剔除样本的绝对误差同值，是同一类锚点间隙；变体 A 下这条不参与）。残差恒为正且只有几十毫秒，说明**锚点就是请求开始时刻**（略早于服务端记账），而不是"上一次写盘"。

另一条独立分解：`thinkingDurationMs + (末行 − 首行)` 与账本 `ms − ttft_ms` 相差 p50 **−1 ms**、p90 0、p99 6 ms、maxAbs 22 ms（n=2,199）。说明首行在思考块写完之后、末行在响应完成时落盘，两段相加正好是解码段。

`thinkingDurationMs` 只覆盖约 **81%** 的样本（多次快照 81.3%–81.7%）。两条分解都只用于**验证**，不进入公式——产品路径不读账本，也不依赖 `thinkingDurationMs`。

### 1.5 结构约束（都必须在实现里守住）

1. **同一 `message.id` 会写成 1–10 行**（p50 2、p90 3、max 10；491 条只有一行）。必须按 ID 去重；直接累加会把 token 放大 2.5–3 倍。
2. **文件顺序不等于时间顺序**（复核快照 17,092 条带时间戳行）：相邻两行时间戳倒退 **147** 次（45 `user`、94 `attachment`、8 `assistant`）；低于本文件运行最大值的时间戳行 **528** 条（93 `user`、370 `attachment`、65 `assistant`）。锚点必须按**文件顺序**扫，不能先按时间排序（反事实见 §3）。
3. **子代理**：1,014 行 `isSidechain: true` 全部在 `subagents/agent-*.jsonl`；6,933 行 `isSidechain: false` 全部在主转录——复核快照仍是 100% 对应，没有反例。`attributionAgent` 在 1,014/1,014 子代理行出现、在主转录 0 行出现（Explore 497、Plan 406、claude-code-guide 111）。
4. **跨文件重复 0**：锁定快照的 3,266 个 `message.id` 全部只出现在一个文件；多次复核同样为 0。同一 ID 不会同时属于主转录和子代理。
5. **同一消息的元数据稳定**：`message.model`、`effort`、`sessionId` 在一条消息的所有行之间从未分歧；`stop_reason` 只在 `null → 具体值` 之间变化（302 条，均为占位行 + 真实行）。
6. **锚点间隔恒为正**：首行 − 锚点最小 1,255 ms、p50 3,790 ms、负值 0。没有任何样本能在锚点之前开始。时长分布 p50 4,485 ms、p90 19,727 ms、p99 55,497 ms、max 185,693 ms——**没有一条超过 `PERF_LONG_WINDOW_MS`（300 s）**，因此不会产生 `LONG_WINDOW` 提示标记。
7. **终态完整**（复核快照）：全部可采样消息都至少有一行 `stop_reason`（`tool_use` 3,303、`end_turn` 51、`max_tokens` 1），没有"无终态"的消息。

## 2 方法定义

### 2.1 公式

```text
sampleDurationMs = lastRowTs(messageId) − anchorTs(messageId)
sampleOutput     = max(output_tokens) over rows of messageId
requestTps       = sampleOutput * 1000 / sampleDurationMs
```

`lastRowTs` 是该 `message.id` 所有行的最大时间戳（不是"文件里最后一行"，以抵御 §1.5 第 2 条）。

### 2.2 锚点规则（变体 A：只认 prompt 行，陈旧即剔除）

单遍、按**文件顺序**扫描：

```text
promptTs    = 目前见过的 user / attachment 行时间戳的运行最大值
assistantTs = 目前见过的 assistant 行时间戳的运行最大值（含零用量占位行；只用来判陈旧，不用作锚点）

遇到一条新 message.id 的首行时：
  promptTs === null                                  ⇒ 不产生样本（skippedNoAnchor）
  assistantTs !== null && assistantTs > promptTs     ⇒ 锚点已陈旧，不产生样本（skippedNoAnchor）
  否则 anchor = promptTs，anchorKind = 该 prompt 行的 type（"prompt_text" | "attachment"）
```

本机锚点来源：attachment **3,228**、prompt_text 35，合计 **3,263**；`skippedNoAnchor` **1**（§5.2）。

**为什么不用上一 assistant 行补锚点**：它只能覆盖"同一轮内没有新 prompt 行"的续写。那种情况下锚点落在上一响应写盘的时刻，包含了 harness 从写完响应到发出下一次请求的间隙——那段时间不属于请求本身。实测唯一一例因此多算 **624 ms**（比值 1.1098），而它只占 597 token / 0.0137%。**剔除它，保证每条样本的锚点都落在真实的 user/attachment 行上**，代价是分子比事件路径少这 597 token（§1.3）和 1 条真实请求不可计时。

**为什么取"运行最大值"而不是"最近一条"**：倒退行会让"最近一条"把锚点推回过去。实测一例（`msg_19a65c…`）：文件里先出现 05:31:40 的 user 行，随后才写入一条 05:25:46 的 attachment 行。取最近一条会把锚点定在 05:25:46，得到 372,934 ms；取运行最大值得到 **18,737 ms**，账本为 18,657 ms（比值 1.0043）。两种取法在复核快照的 3,376 条样本（变体 B 计数）中只有 **17 条**不同：16 条各差 1 ms，1 条就是上面这例（差 354,197 ms）。所以运行最大值不是精度的来源，而是**防御性**选择；真正有实测分量的是"不按时间排序"（§3）。

### 2.3 为什么是"末行 − 锚点"

- 锚点是请求发出时刻（§1.4 两条独立分解，残差几十毫秒）。
- 末行是响应完成时写盘的时刻；`lastRowTs` 与账本 `ms` 的误差 p50 37 ms。
- 差值是**完整请求窗口**：含请求等待与 TTFT，不含响应完成后的工具执行。这正是[统一口径 §4.1](2026-10-21-tps-measurement-correction-plan.md)要求的"用户实际获得输出的请求速度"。

### 2.4 伪代码（reader 单遍）

```js
const PROMPT_TYPES = new Set(["user", "attachment"]);
let promptTs = null;
let promptKind = null;
let assistantTs = null;                       // 只用于判陈旧
const messages = new Map(); // id -> entry
const order = [];

for await (const line of readRolloutLines(filePath)) {
  const record = JSON.parse(line);            // 坏行计入 malformed，继续
  const ts = Date.parse(record.timestamp);
  if (!Number.isFinite(ts)) continue;

  if (record.type !== "assistant" || !record.message?.usage) {
    if (PROMPT_TYPES.has(record.type) && (promptTs === null || ts > promptTs)) {
      promptTs = ts;
      promptKind = record.type === "attachment" ? "attachment" : "prompt_text";
    }
    continue;
  }

  const usage = claudeUsageFromRaw(record.message.usage);
  const id = String(record.message?.id || "").trim();
  if (!id) { assistantTs = assistantTs === null ? ts : Math.max(assistantTs, ts); continue; }

  let entry = messages.get(id);
  if (!entry) {
    // 锚点必须是最近的 prompt 行；它之后写过 assistant 行，就说明这是同轮续写，不能计时。
    const usable = promptTs !== null && (assistantTs === null || promptTs >= assistantTs);
    entry = {
      id,
      anchor: usable ? promptTs : null,
      anchorKind: usable ? promptKind : "none",
      firstTs: ts, lastTs: ts, bestOutput: 0, bestInput: 0,
      model: wireModel(record), effort: String(record.effort || ""),
      stop: null, sidechain: record.isSidechain === true,
      agent: String(record.attributionAgent || ""),
    };
    messages.set(id, entry);
    order.push(entry);
  }
  entry.firstTs = Math.min(entry.firstTs, ts);
  entry.lastTs = Math.max(entry.lastTs, ts);
  if (usage.usage.output > entry.bestOutput) {
    entry.bestOutput = usage.usage.output;
    entry.bestInput = usage.usage.input;
    entry.model = wireModel(record);
  }
  if (record.message.stop_reason != null) entry.stop = record.message.stop_reason;
  assistantTs = assistantTs === null ? ts : Math.max(assistantTs, ts);
}

// 扫描结束后逐条产出：bestOutput <= 0 或 anchor === null 的不产出
```

`readRolloutLines` 复用 `src/codex-rollout.js`（与事件路径同一个按行读取器，正确处理 U+2028/U+2029）；`claudeUsageFromRaw` 复用 `src/claude-code-usage.js:144`（不重复实现 input 超集与 reasoning 拆分）。线路模型判断（`message.model` 非 `<` 前缀）在 reader 内联三行——`servedModel` 目前是 `src/claude-code-usage.js:190` 的私有函数，**本方案不导出它**，避免为 TPS 改动事件路径的模块表面。

**不要复用 `streamClaudeSessionEvents`**：它只回吐每个 message 的"最佳一行"，丢掉了锚点所需的全部行时间戳，而且会为每个事件做仓库解析（额外 I/O）。新 reader 只读 `type`、`timestamp`、`sessionId`、`message.id`、`message.model`、`message.usage`、`message.stop_reason`、`effort`、`isSidechain`、`attributionAgent`——与事件路径同一条隐私边界，不读正文与工具结果。

## 3 候选变体与取舍（同一语料、同一账本）

| 变体 | 锚点规则 | 样本 | 无锚点 | 比值 min | 比值 max | 绝对误差 max | 池化偏差 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **A（采用）** | 仅 user/attachment；锚点之后写过 assistant 行即剔除 | **3,263** | **1** | 1.0002 | **1.0416** | **125 ms** | **−0.48%** |
| B | A + 上一 assistant 行 | 3,264 | 0 | 1.0002 | 1.1098 | 624 ms | −0.48% |
| C | A + queue-operation | 3,263 | 1 | **0.0187** | 1.0416 | **27,778 ms** | −0.18% |
| D | C + 上一 assistant 行 | 3,264 | 0 | 0.0187 | 1.1098 | 27,778 ms | −0.19% |

表内是**锁定快照**的数值。复核快照里语料增长到 3,453/3,454 条，A 与 B 仍只差那 1 条，C/D 的塌陷样本与最大误差不变。

- **不采用 queue-operation**：19 个文件里 13 个有 `queue-operation` 行，但它是入队时刻，可能远早于真正发出请求。把 C 与 A 逐条对比，**20 条样本的时长改变**，其中 **8 条**的比值塌到 0.0187–0.709（例：28,350 → 530 ms，账本 28,308 ms；19,464 → 5,969 ms，账本 19,425 ms）。池化看似"更接近账本"，实际是系统性高估分母。这类偏差不能用"数值更接近"来洗白。
- **不采用 B（上一 assistant 行）**：B 与 A 的差异**只有 1 条**（复核语料：3,453 vs 3,454，其余样本时长逐条相同）。那条恰好是同一轮内没有新 prompt 行的续写；用上一 assistant 行补锚点，代价是这条 +624 ms（比值 1.1098，全库最差）、绝对误差 624 ms。**已裁定剔除**：它只值 597 token / 0.0137%，而锚点里混进了不属于请求的 harness 间隙；剔除后池化只变 0.009%（2 位小数不变），换来的是一条可解释的口径——每条样本的锚点都落在真实 prompt 行上。代价记在 §1.3 与 §5.2。
- **A 的 1 条无锚点是判定剔除，不是退回旧 prompt 时间戳**："仅 prompt"隐含一条陈旧性判定——锚点之后已写入过 assistant 行就不能再用它。退回旧 prompt 得到 9,693 ms（比值 1.706），那是另一个反事实（允许 assistant 锚点、但让零用量占位行不推进游标），比 624 ms 更差，不在候选之列。
- **不采用 decode-only**：账本显示 TTFT 占请求时长 p10 13.9%、p50 63%、p90 86.7%；按 `ms − ttft` 池化为 230.6 tok/s，而请求端到端是 154.21 tok/s。项目统一口径明确包含 TTFT（修订方案 §4.1），且转录本身无法可靠拆出 TTFT——`thinkingDurationMs` 只覆盖约 81% 的样本。改成 decode-only 会与 ZCode/DSH/OpenCode/WorkBuddy 不可比。
- **不采用 `thinkingDurationMs` 补时长**：它加上行跨度等于解码段（§1.4），不是请求段。它是验证工具，不是分子。

**反事实：按时间排序再扫。** 与文件顺序相比，**7 条样本的时长改变**，最大 −13,836 ms（24,637 → 10,801 ms），次大 −13,495 ms（19,464 → 5,969 ms）。这是"必须按文件顺序"的直接证据，也是 §8 测试 2 的由来。

## 4 推荐的统一口径

| 字段 | 值 | 依据 |
| --- | --- | --- |
| `sourceKind` | `"claude"`（规范 kind） | 与 `src/usage-core.js:623` 的 home kind 一致 |
| `window` | `"request"` | 一个 `message.id` = 一次模型响应 |
| `timingKind` | `"request_e2e"` | 含请求等待与 TTFT，不含工具执行 |
| `timingSource` | `"timestamp_fallback"` | 时长由时间戳相减得来，不是来源显式字段 |
| `tokenScope` | `"reported_output_includes_reasoning"` | 转录 `output_tokens` 与账本 `out` 2,747/2,747 相等；`output_tokens_details.thinking_tokens` 是它的细分，不二次相加 |
| `status` | 该消息任一行有 `stop_reason` ⇒ `"completed"`；否则 `"unverified"` | 采样集内 3,263/3,263 都有终态，不把"没有终态证据"升级为完成 |
| `agentKind` | `isSidechain === true` 或文件位于 `subagents/` ⇒ `"subagent"`，否则 `"main"` | 已裁定接受该推断；依据是 §1.5 第 3 条的 100% 对应 |
| `agent` | `attributionAgent`（子代理才有），否则空串 | 名字类字段无证据就是空串 |
| `channel` | `"claude"` | 已裁定：与 WorkBuddy 同一个渠道值；主/子代理已由 `agentKind` 区分，不再拆 `claude-subagent` |
| `model` | `message.model`（线路模型），`<synthetic>` 不采样 | 与事件路径 `servedModel` 一致 |
| `reasoningEffort` | 顶层 `effort`（`"max"`/`"high"`），缺失为空串 | 见 §5.4 |
| `modelEvidence` | `"request_scope"` | 模型随每次响应写在 `message.model` |
| `tsMs` | 末行时间戳 | 与 ZCode/OpenCode 偏好"完成时刻"一致 |
| `windowStartMs` / `windowEndMs` | 锚点 / 末行 | 与 `durationMs` 同源，保证窗口与时长自洽 |
| `durationMs` | 末行 − 锚点 | §2.1 |
| `outputTokens` | 该消息所有行 `output_tokens` 的最大值 | 与事件路径同一行（§1.3） |
| `inputTokens` | 最佳行的 `input_tokens + cache_read + cache_creation` | 诊断字段；与事件路径的输入超集口径一致 |
| `requestCount` | `1` | 一个 `message.id` 一次请求 |
| 身份 | `identity: [messageId]` ⇒ `["claude", homeId, messageId]` | `resolvePerfSampleKey`（`src/perf-stats.js:532`）已优先读 `identity`，**不需要改它** |
| `methodVersion` | 不传，由内核填当前 `PERF_METHOD_VERSION`（工作区现为 `tps-v2`） | 见 §6.3 |

## 5 边界规则与已观察到的异常

### 5.1 零用量占位行与全零消息

695 条 `assistant` 行的 `stop_reason == null` 且四个 token 计数全零，分布在 304 条消息里——它们绝大多数是消息的**首行占位**，同一 `message.id` 后面还有真实行。唯一的例外是那条全零消息本身（`msg_99ea4c11…`，单行、无 `stop_reason`、`deepseek-flash`、账本 `out = 0`）：它的"末行"就是这条占位行。另有 1 条 `<synthetic>` 行（`stop_sequence`、全零），单独不采样。

规则：**按消息去重后再判零**——最佳行的 output 为 0 ⇒ 不产出样本、计入 `skippedZeroUsage`，不伪造 `OUTPUT_ZERO` 扣分候选。这样与用量事件路径的 `isZeroUsage` 跳过口径一致（同一批 3,265 条非 `<synthetic>` 消息）。

### 5.2 同轮续写不采样（锚点陈旧即剔除）

本机唯一一条无可用锚点的消息 `msg_7e5db2d7…`：它的首行之前，最新的 user/attachment 行是 15:53:41.269，但之后又写过一条 15:53:44.656 的零用量 assistant 占位行——说明这是同一轮内的续写，中间隔了 harness 处理时间。拿 15:53:44.656 当锚点会得到 6,306 ms，账本是 5,682 ms，**多算 624 ms**；拿 15:53:41.269 当锚点则得到 9,693 ms，多算 4,011 ms。两个都不对，所以这条**不采样**。

规则：消息首行时若 `assistantTs > promptTs`，锚点已陈旧 ⇒ 不产出样本，计入 `skippedNoAnchor`。它只进 reader `stats`，不进覆盖明细、也没有告警码（§5.5）——面板上不会出现一条假样本。

零用量占位行仍然推进 `assistantTs`，但**只用于判陈旧**，永远不会成为锚点；`<synthetic>` 行同理。如果占位行不推进，这条消息会退回旧 prompt 锚点得到 9,693 ms（比值 1.706），比 624 ms 更差——这是保留该游标的唯一理由。

**剔除还是保留这一条：已裁定剔除。** 两种做法只差这一条：

| | 剔除（采用） | 保留（变体 B，已否决） |
| --- | --- | --- |
| 样本数 | 3,263 | 3,264 |
| 无锚点 | 1（`skippedNoAnchor`，只进 stats） | 0 |
| 分子 | 4,370,010；事件路径另有 597 token（0.0137%） | 4,370,607，与事件路径逐位相等 |
| 池化（锁定语料） | 154.21 tok/s | 154.21 tok/s（当前语料实测只差 0.009%） |
| 全库最差单条 | 1.0416、125 ms | 1.1098、624 ms |
| 锚点纯净度 | 每条样本的锚点都是真实 prompt 行 | 一条落在 assistant 写盘时刻，含 harness 间隙 |

被剔除的这条输出占 0.0137%、时长占 0.021%，剔除对池化、p10/p90、各模型组均值都无可见影响（`deepseek-flash` 组均值 +0.17% 是四舍五入级别）。**换来的是一条可以一句话讲清的口径**：Claude 的每条 TPS 样本都从一条真实的 user/attachment 行开始计时；同轮续写不进样本集，也不假装能计时。代价是 TPS 分子比事件路径少这 597 token，已写进 §1.3 与 §9 的文档要求。

（改用 queue-operation 作锚点的 C/D 也不采用：8 条样本比值塌到 0.0187–0.709，见 §3。）

### 5.3 `max_tokens` 截断请求保留

本机 1 条：32,000 token、转录 140,155 ms、账本 140,126 ms、228 tok/s，账本 `stop = length`、`tries = 2`。它是合法完成的请求，不因触顶剔除。`tries = 2` 的 361 条样本误差上限 75 ms、`tries = 3` 的 8 条上限 58 ms，说明账本 `ms` 不含失败尝试的重试时间——这一点不能反过来推广到别的账本。

### 5.4 effort 与账本不一致的 28 条

同一文件（`8aae56f2…`）在 2026-10-20T04:12:01Z–04:23:41Z 之间，转录 `effort = "high"` 而账本 `effort = "max"`。**以转录为准**：分组键用看板自己记录的强度，不引入第二份来源。该窗口之外的命中样本全部一致。

### 5.5 告警码只能用冻结的 8 个

`PERF_SOURCE_WARNING_CODES`（`src/perf-stats.js:1837`）是冻结集合，`summarizePerf`（`:2159`）遇到域外码直接抛 `TypeError`。Claude reader 只能映射到已有码：

- `CLAUDE_MALFORMED_JSON:n` ⇒ `{ sourceKind: "claude", homeId, code: "MALFORMED_JSON", count: n }`
- `CLAUDE_MISSING_MESSAGE_ID:n` ⇒ `{ ..., code: "UNKEYABLE_RECORD", count: n }`

不得新增 `MISSING_DURATION` 之类的码。WorkBuddy 的同类计数也走普通 warning 字符串通道（`src/usage-store.js:4848` 的注释与随后的 `warnings.push`），本方案沿用该先例：`skippedZeroUsage` / `skippedNoAnchor` 只进 `stats`，不伪造告警码。

### 5.6 30 天保留期

Claude Code 默认只保留 30 天转录。文件消失后 `source_files` 行被删除，`perf_samples` 经 `ON DELETE CASCADE`（`src/usage-store.js:226`）一并消失。**本方案不改变这一点**：TPS 历史与转录同寿。长期保留属于[历史保留方案](2026-10-21-history-retention-plan.md)的范围。

### 5.7 跨文件重复 ID

本快照 0 例。若将来出现，`perf_samples` 主键会让第二次插入报错并回滚整个文件事务（`degraded`），而不是静默重复计数——与 WorkBuddy 的 `message_id` 主键行为一致，属于可接受的显式失败。

### 5.8 账本里那 1,522 行未命中，不能算进 Claude Code

这是本方案最容易做错的一处，必须写清楚：

- 它们与命中行一样，`agentName` 全是 `Claude Desktop`；
- 1,502/1,522 带 `native_session`，其中 **1,501 个**能对上某个真实转录会话——所以它们不是别的程序；
- 但 **1,189 条 effort 是 `"low"`**（另有 243 条 `max`、88 条空、2 条 `high`），而转录里从来没有 `low`（只有 `max`/`high`）；
- 26 条与某条命中行**共用 `rid`**；只有 2 条能在 ±2 s 内找到输出数相同的转录行；
- 输出 p50 只有 **89** token（命中行 p50 378），时长 p50 2,241 ms，端点分布里多出 `/v1/messages → /v1/responses` 5 条。

结论：它们是同一会话内的**辅助请求**（摘要、标题、压缩、网关侧转发等），Claude Code 的转录不记录它们。它们不是"Claude Code 的某次模型响应"，因此：

1. 关联键必须是 `message.id`，**不能**用 `sessionId` 或时间窗——那会把它们吸进来；
2. 若错误纳入，池化会被拉低（它们又慢又短），而不是"更全面"；
3. 它们在产品路径不可见，也不需要可见：没有 `message.id` 就没有可归属的请求。

## 6 架构改动清单

### 6.1 文件级改动

| 文件 | 改动 | 说明 |
| --- | --- | --- |
| `src/perf-stats.js:100-117` | `PERF_SOURCE_SEMANTICS` 增加 `claude` 条目 | **必须**：normalizer 直接读 `semantics.window`（`:841`），缺条目会 `TypeError` |
| `src/perf-stats.js:120` | `PERF_SOURCE_KINDS` 末尾追加 `"claude"` | 决定 `enabledPerfSourceKinds()` 的输出与顺序 |
| `src/perf-stats.js:310-314` | `canonicalPerfSourceKind` 映射 `"claude"` | 否则 `normalizePerfSample` 返回 `UNSUPPORTED_SOURCE_KIND`，一条样本都进不来 |
| `src/perf-stats.js:1069-1079` | `isPerfRankAdmitted` 增加 `claude` 分支，并将其上方 `:1055-1064` 的准入说明改写 | 裁定纳入排名（§6.5）；Codex 分支条件逐字不变 |
| `src/perf-sources/claude.js` | **新增** `streamClaudePerfSamples` | §2.4；返回 `{ state: "enabled", stats }` |
| `src/perf-sources/index.js:46-54` | 注册 `["claude", streamClaudePerfSamples]` | 注册即启用；`classifyPerfSources` 随之把 Claude 从 `notEnabled` 移入 `enabled` |
| `src/usage-core.js:2253-2261` | `perfPhysicalFilesForHome` 增加 claude 分支 → `claudeSessionFiles(home.path)` | 见 §6.4 的 parity 陷阱 |
| `public/perf-ui.js:77-88` | `sourceLabel` 增加 `claude: "Claude"` | 否则显示"未知来源" |
| `test/perf-store.test.js:1715-1717` | 两处五元数组改为六元 | 钉住注册表顺序 |
| `test/perf-workbuddy.test.js:62,183` | 同上 | 钉住 `PERF_SOURCE_KINDS` 与 `enabledPerfSourceKinds` |
| `test/perf-ui.test.js:849-854` | 增加 `sourceLabel("claude", …)` 断言 | 现有断言只覆盖 workbuddy/codex/unsupported |
| `test/perf-models.test.js:334-390` | 增加 claude 准入（`request` + `timestamp_fallback`）与两个拒绝用例（`turn` 锚、`explicit` 来源） | "其他来源一律无排名"的现有断言里没有 claude，不会因新增分支失败 |
| `test/perf-claude.test.js` | **新增** | §8 |

**不改**：`src/usage-store.js` 的 schema 与迁移、`usageFiles()`（`src/usage-store.js:3222`，其中 `:3253` 已有 claude 分支）、`resolvePerfSampleKey`（`identity` 数组已足够）、`src/claude-code-usage.js` 的导出面、`scripts/perf-probe.mjs` 的 `PROBE_SOURCES`（探测外壳独立，本来就没有 WorkBuddy）、`public/timeline-utils.js`（`sourceGroup` 已把 `homeKind === "claude"` 与渠道名 `claude` 映射成 "Claude"，`:10`/`:17`；`NON_CODEX_SOURCE_KINDS` 也已含 `claude`，`:289`）。

`test/perf-stats.test.js:365-370` 的语义表只列 4 个来源、逐项断言，不会因新增 kind 而失败；建议顺手补一行 claude 作为新覆盖，但它不是"必须修的钉住点"。

### 6.2 新增 reader 的 raw 候选形状

```js
{
  sourceKind: "claude",
  homeId,                                  // source.id
  sourcePath,                              // store/调度器会覆盖成物理文件路径
  identity: [messageId],                   // ⇒ ["claude", homeId, messageId]
  messageId,
  sessionId,
  channel: "claude",
  agentKind: "main" | "subagent",
  agent: attributionAgent || "",
  model: message.model,
  modelProvider: "",
  reasoningEffort: effort || "",
  modelEvidence: "request_scope",
  window: "request",
  timingKind: "request_e2e",
  timingSource: "timestamp_fallback",
  tokenScope: "reported_output_includes_reasoning",
  status: "completed",
  tsMs: lastTs,
  windowStartMs: anchorTs,
  windowEndMs: lastTs,
  durationMs: lastTs - anchorTs,
  outputTokens: bestOutput,
  inputTokens: bestInput,
  requestCount: 1,
}
```

`stats` 至少包含：`candidates`、`skippedZeroUsage`、`skippedNoAnchor`、`missingMessageId`、`malformedLines`。锁定快照下 `skippedNoAnchor` 应为 **1**（§5.2 的续写），不是 0；测试夹具里必须有一条这样的负例。

### 6.3 为什么不动版本号

- **无 schema 变更**：`perf_samples` 的 `source_kind` 只有 `<> ''` 约束，`timing_kind` 已允许 `request_e2e`，`status` 已允许 `completed`、`agent_kind` 已允许 `main/subagent`。
- **无迁移**：`perfFileNeedsExtraction`（`src/usage-store.js:962`）在"没有已发布指纹"时返回 `true` ⇒ 首次 sync 自动回填，无需标脏。v15 已登记 Claude 来源（`src/usage-store.js:2360`，只抬版本号、不动表结构）。
- **不改 `PERF_METHOD_VERSION` 常量**：Claude 与 ZCode/DSH/OpenCode 同属 `request_e2e` + 时间戳相减，不是新方法，不需要为它单独抬版本号。reader **不传** `methodVersion`，样本落库时取当时的内核版本——工作区里另一条线已经把常量抬到 `tps-v2`，所以本机 Claude 行实测落 `tps-v2`，而不是方案初稿写的 `tps-v1`。逐行 `method_version` 在插入时写死，将来全局升级不会改写已有行。
- **由此带来的耦合**：Claude 的行会跟着共享常量一起升版。将来谁再抬 `PERF_METHOD_VERSION`，必须在同一轮复核 `isPerfRankAdmitted` 的 `claude` 分支；`PERF_HISTORICAL_METHOD_VERSIONS` 只让旧版行静默保留，不给它们排名。
- 当前工作树的 `STORE_SCHEMA_VERSION` 是 **18**（`src/usage-store.js:68`，并行任务未提交的请求计时迁移），`docs/10-data-sources.md:63` 写的是 17。**本方案不新增迁移，落点在哪一版都不需要为本方案抬版本**；文档那处偏差属于并行任务。

### 6.4 自动生效链路与一个 parity 陷阱

1. `isPerfSourceEnabled("claude")` 为真 ⇒ `src/usage-store.js:3545` 的 gate 放行，`replaceFile` 在**同一事务**里写 events 与 perf_samples。
2. 同一 gate 在 `:3684` 写 `perf_file_warnings`；指纹在事务内提交，`LIVE_SOURCE_CHANGED` 仍会整体回滚。
3. `perf_samples.source_path` 外键指向 `source_files(path)`；store 传的是物理文件路径（`{ ...source, path: filePath }`），与 `claudeSessionFiles` 的展开结果逐字一致。
4. **陷阱**：内存路径 `collectMemoryPerfCarrier` 经 `perfPhysicalFilesForHome` 拿文件，而 SQLite 路径走 `usageFiles()` 的 claude 分支。若只注册 reader、不加 `perfPhysicalFilesForHome` 的 claude 分支，内存路径会落到 `discoverSessionFiles`，只扫 `<home>/sessions` 与 `<home>/archived_sessions`——本机 `~/.claude/sessions` 只有 12 个 `.json` + 12 个 `.key`，`archived_sessions` 不存在，于是**内存报告 0 个样本、SQLite 有样本**，跨路径 parity 直接破。C2 的验收必须同时看两条路径。
5. 真实删除（转录过期）时 `source_files` 行删除，perf 样本级联消失（§5.6）。

### 6.5 排名准入：已裁定纳入

`isPerfRankAdmitted`（`src/perf-stats.js:1069`）目前只承认 Codex（`sourceKind === "codex"` + `window === "turn"` + `timingSource === "explicit"`），`projectPerfModels`（`:1974`）与分组排名（`:2145`）都要求 `rankAdmitted`。若不改它，Claude 会像 WorkBuddy/ZCode/DSH/OpenCode 一样有平均速度、样本数和 p10–p90，但排名列显示"—"。**裁定：Claude 纳入排名**，因此本方案包含 `src/perf-stats.js` 的第四处改动。

改法（Codex 分支逐字保留，只加一个分支）：

```js
function isPerfRankAdmitted(sample, flags = perfFlagSetOf(sample)) {
  if (sample.methodVersion !== PERF_METHOD_VERSION) return false;
  if (sample.timingKind !== "request_e2e") return false;
  if (sample.tokenScope !== "reported_output_includes_reasoning") return false;
  if (flags.has("METHOD_ESTIMATE")) return false;
  if (sample.sourceKind === "codex") {
    return sample.window === "turn" && sample.timingSource === "explicit";
  }
  if (sample.sourceKind === "claude") {
    return sample.window === "request" && sample.timingSource === "timestamp_fallback";
  }
  return false;
}
```

函数上方 `:1055-1064` 的注释现在逐条说明"为什么 DSH/ZCode/OpenCode/WorkBuddy 没有排名"，必须同步补一句 Claude 的准入依据，否则注释与代码相反。

**连带后果，必须让用户看到**：

1. 排名序号是在**整张按平均速度排序的模型表**上顺序分配的（`:1971-1977`），所以 Claude 行拿到名次后，排在它后面的 Codex 行名次会下移。这正是统一排名的目的，不是回归。
2. 一个桶只有**全部成员**都准入、且样本量够、且未溢出才编号（`rankAdmitted &&=` 与 `insufficientSamples`）。桶里混进一条 pending 或旧版样本，整桶失去名次——Claude 行也遵守这条，不做例外。
3. 准入只主张"池化均值可比"，不主张分位可比：Claude 是请求级、Codex 是轮级，[修订方案 §4.1.1](2026-10-21-tps-measurement-correction-plan.md) 第 4 条对分位粒度的限制原样保留。排名不是解码基准，也不是硬件基准（同条第 3 条）。
4. 准入证据：账本逐条核对起止边界（条件 1，采样集内 2,747 条、残差 p50 37 ms）、输出范围 2,748/2,748 相等（条件 2）、请求级粒度与 ZCode/WorkBuddy 同类（条件 4 的粒度前提）。§5.8 的 1,522 条辅助请求没有 `message.id`，进入不了样本集，因此不会污染排名。

**与既有改动的关系**：`isPerfRankAdmitted` 的前半段（`methodVersion` / `timingKind` / `tokenScope` / `METHOD_ESTIMATE`）是 Codex 侧已经落定的公共条件，本稿只在其后追加 `claude` 分支，Codex 分支逐字保留。工作区里若已有对 Codex 准入元组的修改，实施时先 `git diff` 看清，追加减法而不是重写函数；两边的改动在同一函数里可以共存，不需要谁先谁后。

## 7 实施卡

卡片的并行拆分、文件所有权与开工条件见[多 subagent 并行实施计划](2026-10-21-claude-code-tps-implementation-plan.md)；本节只保留口径层面的卡边界。

**施工边界**：本方案由当前会话独立实施，改 `src/perf-stats.js` 与 `src/usage-core.js` 的都是一行到几行的加法（§6.1、§6.4）。这两个文件在工作区里已有其他并行工作的未提交改动，实施时按加法处理并在卡内先 `git diff` 核对；同一文件同一时刻只允许一个写入者，由派发方保证。

### C0：口径与夹具冻结（不改产品代码）

- 用 §2.4 的伪代码对快照产出固定夹具：每条消息的 `message.id`（可脱敏为序号）、锚点种类、`firstTs`/`lastTs`、`output`、`durationMs`、期望 TPS。锁定快照应是 **3,263** 条，`skippedNoAnchor = 1`。
- 手算 4 条：纯文本、工具调用、子代理各一，加一条锚点陈旧的续写（期望不产出、计数 +1）。
- 交付：夹具 JSON + 独立复算脚本；**不含**对话正文、工具参数、网关账本原文。

### C1：内核与 reader

- `src/perf-stats.js` 四处（§6.1）：语义表、kind 列表、`canonicalPerfSourceKind`、`isPerfRankAdmitted`（§6.5）。
- 新建 `src/perf-sources/claude.js`，按 §2.4 / §6.2 实现。
- `src/perf-sources/index.js` 注册。
- `test/perf-claude.test.js`：§8 的 1–8、12 条；`test/perf-models.test.js` 增加准入/拒绝用例。
- 通过条件：夹具逐条相等；`perf-stats`、`perf-models`、`perf-workbuddy`、`perf-store` 定向通过；同一夹具下 `projectPerfModels` 的 Claude 行 `rank` 为非 null，混入一条 `timingSource` 不符的样本后该桶 `rank` 回到 null。

### C2：发现与存储接线

- `src/usage-core.js:2253` 增加 claude 分支。
- 隔离库验证：首次 sync 回填、重复 sync 不重复、指纹不变不重读、文件追加后 `LIVE_SOURCE_CHANGED` 回滚、文件删除后级联清除。
- 通过条件：memory 与 SQLite 对同一夹具的 `sampleKey`/`durationMs`/`outputTokens` 逐条相等（§6.4 第 4 条）。

### C3：界面与文档

- `public/perf-ui.js` 标签；`test/perf-ui.test.js` 断言。
- 按 §9 更新文档。
- 通过条件：只选 Claude 时模型速度区出现该来源行；覆盖明细的"不支持来源"不再列出 Claude。

## 8 测试点

1. **去重**：同一 `message.id` 三行（含首行零用量占位）⇒ 1 个样本，output 取最大、duration 取末行 − 锚点。
2. **文件顺序**：构造一条时间倒退的 attachment 行，锚点不得回退；再构造"若按时间排序就会改变结果"的夹具（本机有 7 条这样的真实样本，最大差 13.8 s），钉住实现没有排序。
3. **锚点种类**：prompt_text、attachment 各一例；没有 prompt 行 ⇒ `skippedNoAnchor`；**锚点之后写过 assistant 行 ⇒ `skippedNoAnchor`**，不得退回那条 assistant 行，也不得退回更旧的 prompt 行。
4. **零用量与续写**：全零消息与 `<synthetic>` 不产出样本、不产生扣分候选；占位行只推进陈旧判定、永不成为锚点。用 §5.2 的真实形态做夹具：同一条消息若允许 assistant 锚点会得到 6,306 ms，若退回旧 prompt 会得到 9,693 ms——本方案必须**两者都不产出**，且 `skippedNoAnchor` 加 1。
5. **子代理**：`subagents/` 文件 ⇒ `agentKind = "subagent"`、`agent = attributionAgent`、`sessionId` 继承父会话。
6. **告警域**：坏行 ⇒ `MALFORMED_JSON` 计数；缺 `message.id` ⇒ `UNKEYABLE_RECORD` 计数；两者都不得越出冻结码域（`summarizePerf` 不抛错）。
7. **注册表**：`canonicalPerfSourceKind("claude") === "claude"`；`resolvePerfSourceReader("claude").state === "enabled"`；`classifyPerfSources` 把 claude 放入 `enabled` 而非 `notEnabled`/`unsupported`。
8. **语义镜像**：raw 候选显式传 `window`/`timingKind`/`tokenScope` 时不得触发 `SOURCE_SEMANTICS_MISMATCH`。
9. **存储**：`replaceFile` 写出的 `source_path` 等于物理文件路径；重复 sync 幂等；真实删除后 `perf_samples` 行数为 0。
10. **分子一致**：同一夹具下，事件路径的 output 总和 == TPS 路径的 `outputTokens` 总和（§1.3 的回归版）。
11. **关联键**：构造两条同 `sessionId`、其中一条无 `message.id` 的记录，断言只产出一条样本（§5.8 的回归版：不允许退化成按会话或时间窗匹配）。
12. **排名准入**（§6.5）：`claude` + `window="request"` + `timingSource="timestamp_fallback"` ⇒ 模型行与分组行的 `rank` 都非 null；把 `window` 改成 `"turn"`、`timingSource` 改成 `"explicit"`、`methodVersion` 改成 `"tps-v1"`、`methodEstimate` 置真这四种变体分别 ⇒ `rank` 为 null。再断言一个 Codex 桶与一个 Claude 桶同时准入时名次连续、顺序仍按未舍入均值，且桶内混入一条不合格样本时整桶回到 null。

定向命令：`node --test test/perf-claude.test.js test/perf-stats.test.js test/perf-models.test.js test/perf-workbuddy.test.js test/perf-store.test.js test/perf-ui.test.js`，随后 `npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run format:check`。全量 `npm.cmd test` 只在 C3 收口时跑一次。

## 9 文档更新清单

| 文件 | 现状 | 应改为 |
| --- | --- | --- |
| `docs/data-sources/claude-code.md:110` | "**不做。** ……未注册 perf reader，`classifyPerfSources` 把该来源归为 `unsupported`" | 改写为请求端到端口径、锚点规则（**只对紧随 prompt/attachment 行的请求计时；同轮续写不采样**）、精度证据、**已进入统一排名（请求级均值可比、分位粒度不同）**、TPS 分子比事件输出少 0.0137% 与 30 天保留限制。**现文有一处不准确**：实测 `classifyPerfSources` 把它放进 `notEnabled` 桶、`kind` 为 `"unsupported"`；是 UI 把两个桶合并成"不支持来源" |
| `docs/data-sources/claude-code.md:112` | 解释"改成具名会牵动 `canonicalPerfSourceKind`、样本键与分组键" | 删除该结论，改为已具名 `Claude`；并说明样本键只用 `message.id` |
| `docs/data-sources/claude-code.md:128` | 保留期只讲事件 | 补一句：TPS 样本与转录同寿 |
| `README.md:31` | "Claude Code 转录没有请求时长，暂不提供速度统计" | 改为已提供；来源列表加 Claude |
| `README.en.md:31` | 同上（英文） | 同上 |
| `docs/10-data-sources.md:31-33` | TPS 段只列 ZCode/DSH/OpenCode/Codex/WorkBuddy | 增加 Claude 的时间戳回退口径（含 TTFT；只对紧随 prompt/attachment 行的请求计时，同轮续写不采样） |
| `docs/12-dashboard.md:43` | "来源指 Codex / DSH / OpenCode / ZCode" | 补 WorkBuddy 与 Claude（现文已漏 WorkBuddy） |
| `docs/02-tasks.md:25` | "子代理计入并合并；不做 TPS（转录无请求时长）" | 删除该结论，改指本方案 |
| `docs/02-tasks.md:27` | 验收记录写"TPS 列为「不支持来源」" | 这是 2026-10-20 的历史快照，**不改写**，只加一句"该结论已由本方案取代" |
| `docs/plans/2026-10-21-tps-measurement-correction-plan.md:61` | "Claude Code / project-log：当前缺少可靠请求时长……" | 加一句"Claude 已由[本方案]单独认证；project-log 仍为结构性不支持" |
| `docs/00-index.md:34` | 仅链接 | 无需改 |

`docs/10-data-sources.md:63` 的 schema 历史**不需要**为本方案改：本次没有迁移。

## 10 已裁定的口径与明确限制

**以下四点已确认，并按裁定写进了上文**

1. `channel = "claude"`（同 WorkBuddy，不区分主/子代理）——§4。主/子代理已由 `agentKind` 分开，渠道不需要再分裂。
2. `agentKind = "main"` 可接受（非 sidechain 即 main）——§4。依据是 1,014/1,014 与 6,933/6,933 的精确对应；它仍是**推断**而非字段直说，但保守成 `"unknown"` 的代价（界面显示"代理未知"、主/子代理不再分组）大于推断风险。
3. **剔除** §5.2 那条同轮续写——§5.2 的量化表。首行之前已有 assistant 行 ⇒ 锚点陈旧 ⇒ 不采样。代价是 TPS 分子比事件路径少 597 token（0.0137%）、1 条真实请求不可计时；换来的是每条样本的锚点都落在真实 prompt 行上，全库最差单条从 1.1098 / 624 ms 收到 1.0416 / 125 ms。
4. Claude 纳入统一排名——§6.5。需要改 `isPerfRankAdmitted`，因此本方案不再是"三处改动"，也不是"不碰排名策略"。

**明确限制**

- **不是纯解码速度**：含请求等待与 TTFT，TTFT 占请求时长 p50 63%。
- **排名可比、分位不可比**：Claude 进入统一排名后，与修订后的 Codex v2 同属 `request_e2e`（Claude 一个请求一条、Codex 一轮内请求求和），池化均值可比；旧的 Codex `item_span_estimate` 不在准入集合里，那些历史行不参与排名。p10/p90 仍是各自粒度的历史分布（修订方案 §4.1.1 第 4 条），跨来源的分位差不能读成同一请求级的波动。
- **证据范围窄**：本机语料约 33 小时、13 个会话、Claude Code 2.1.299、一条网关路由（Claude Code → Magpie → DeepSeek）。方法在 harness 层，理应通用；但**数值精度只在这条路径上被验证过**，不能外推成"所有 Claude Code 用户的 TPS 都准"。
- **语料会自己长大**：本会话就在往转录里写。计数是快照，不是恒定值；分位与池化在多次快照间稳定，但绝对样本数每次运行都不同。
- **依赖文件顺序**：任何"先按时间排序再扫"的实现都会在 7 条样本上改变时长（最大 13.8 s）。必须由测试 2 钉住。
- **账本只用于离线验证**：产品路径不读网关、不读鉴权、不联网。没有网关的用户同样能用，只是少了这条交叉验证。
- **30 天保留**：转录过期即样本消失，历史 TPS 无法回溯重扫。这是既有删除语义，本方案不改变。
- **无 `<synthetic>` 与零用量样本**：它们不是模型响应，本就不该有 TPS。
- **分子不等于事件路径的 output 总和**：同轮续写不采样，所以 TPS 分子比事件路径少 597 token（0.0137%）。面板的 token 总量仍包含它——这是两个不同的数，不能互相校验为"必须相等"。采样集内部（3,263 条）仍逐位相等。
- **同轮续写没有速度**：本机 1/3,265 条（0.03%）。若将来某类会话大量出现"响应后直接续写、没有新的 user/attachment 行"，Claude 的样本覆盖率会下降；reader 的 `skippedNoAnchor` 会让这件事可见（只进 stats，不上告警）。
- **会话内辅助请求不可见**：§5.8 的 1,522 条账本行没有 `message.id`，永远进不了看板。这是口径选择，不是缺陷；若将来要看"Claude Desktop 全部请求"，需要另一条按 `rid` 的链路，不在本方案范围。
