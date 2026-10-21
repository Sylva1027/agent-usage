// Claude Code TPS 候选 reader（只读、单遍、**文件顺序**）。
//
// 口径依据：[Claude Code TPS 接入方案](../../docs/plans/2026-10-21-claude-code-tps-plan.md) §2.2 / §5，
// 契约见[实施计划](../../docs/plans/2026-10-21-claude-code-tps-implementation-plan.md) C-1 / C-2。
//
// 三条结构约束（都来自真实转录实测，不能"优化"掉）：
// 1. 同一 `message.id` 会写成 1–10 行。必须按 id 聚合；直接累加会把 token 放大 2.5–3 倍。
// 2. 文件顺序 ≠ 时间顺序（实测有倒退的 user/attachment/assistant 行）。锚点取 prompt 行的
//    **运行最大值**，且整条扫描不排序；先按时间排序再扫会改变 7 条真实样本的时长。
// 3. 锚点只认 user/attachment 行。消息首行时若已经写过 assistant 行（含零用量占位），
//    说明它是同一轮内的续写，锚点已陈旧 ⇒ 不采样（计入 `skippedNoAnchor`），绝不退回
//    上一条 assistant 行或更旧的 prompt。
//
// 只读字段：`type`、`timestamp`、`sessionId`、`message.id`、`message.model`、`message.usage`、
// `message.stop_reason`、`effort`、`isSidechain`、`attributionAgent`。正文与工具参数一律不读。
// 复用 `readRolloutLines`（处理 U+2028/U+2029）与 `claudeUsageFromRaw`（输入超集 / reasoning 拆分），
// 但**不复用** `streamClaudeSessionEvents`：后者只回吐每个消息的最佳行，丢掉了锚点所需的行时间戳。
import { claudeUsageFromRaw } from "../claude-code-usage.js";
import { readRolloutLines } from "../codex-rollout.js";

const PROMPT_TYPES = new Set(["user", "attachment"]);
const SUBAGENTS_SEGMENT = "/subagents/";

/** 本 reader 可以发出的 warning 编码；两者都在冻结的 `PERF_SOURCE_WARNING_CODES` 里。 */
export const CLAUDE_READER_WARNING_CODES = Object.freeze(["MALFORMED_JSON", "UNKEYABLE_RECORD"]);

function trimmed(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/** 行时间戳 → epoch 毫秒；缺失/不可解析返回 `null`（该行不参与任何游标）。 */
function timestampMs(value) {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** 子代理文件位于 `<sessionId>/subagents/agent-*.jsonl`；Windows 路径同样识别。 */
function isSubagentPath(filePath) {
  return String(filePath).split("\\").join("/").includes(SUBAGENTS_SEGMENT);
}

function laterTimestamp(current, candidate) {
  return current === null ? candidate : Math.max(current, candidate);
}

/**
 * 扫描一个 Claude Code 转录文件，产出 raw 性能候选（C-2，键名固定）。
 *
 * 结束条件与计数恒等式：
 * `candidates === emitted + skippedZeroUsage + skippedNoAnchor`，
 * 其中 `candidates` 是去重后的 `message.id` 数（不含 `model` 以 `<` 开头的 synthetic 行）。
 *
 * @param {string} filePath 物理转录文件（主转录或 `<sessionId>/subagents/agent-*.jsonl`）
 * @param {{ id?: unknown, path?: unknown, kind?: unknown, label?: unknown }} source
 * @param {(sample: Record<string, unknown>) => void} onSample 每条可采样消息调用一次
 * @param {{ onWarning?: (warning: { sourceKind: string, homeId: string, code: string, count: number }) => void }} [options]
 * @returns {Promise<{ state: "enabled", stats: { candidates: number, skippedZeroUsage: number, skippedNoAnchor: number, missingMessageId: number, malformedLines: number } }>}
 */
export async function streamClaudePerfSamples(filePath, source, onSample, options = {}) {
  const onWarning = typeof options.onWarning === "function" ? options.onWarning : () => {};
  const homeId = trimmed(source?.id) || trimmed(source?.path);
  const sourcePath = trimmed(source?.path) || trimmed(filePath);
  const subagentFile = isSubagentPath(filePath);

  // 锚点游标：只认 user/attachment 行的运行最大值。
  /** @type {number | null} */
  let promptTs = null;
  /** @type {"prompt_text" | "attachment" | ""} */
  let promptKind = "";
  // `assistantTs` **只用于判陈旧**，永远不作为锚点；含零用量占位行与 `<synthetic>` 行。
  /** @type {number | null} */
  let assistantTs = null;

  /** @type {Map<string, any>} */
  const messages = new Map();
  /** @type {any[]} */
  const order = [];
  let malformedLines = 0;
  let missingMessageId = 0;

  for await (const line of readRolloutLines(filePath)) {
    if (!line.trim()) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }

    const ts = timestampMs(record?.timestamp);
    if (ts === null) continue;

    const type = String(record?.type || "");
    if (type !== "assistant" || !record?.message?.usage) {
      if (PROMPT_TYPES.has(type) && (promptTs === null || ts > promptTs)) {
        promptTs = ts;
        promptKind = type === "attachment" ? "attachment" : "prompt_text";
      }
      continue;
    }

    const model = trimmed(record.message.model);
    const messageId = trimmed(record.message.id);

    // `<synthetic>` 是 harness 本地生成的记录，不是模型响应：整条忽略，不进 candidates。
    // 它仍推进 `assistantTs`（"这条消息首行之前写过 assistant 行" 的证据）。
    if (model.startsWith("<")) {
      assistantTs = laterTimestamp(assistantTs, ts);
      continue;
    }

    // 有 usage 但没有稳定身份：不能成为样本，只计 `UNKEYABLE_RECORD`。
    // 绝不退化成按 sessionId 或时间窗匹配（§5.8）。
    if (messageId === "") {
      missingMessageId += 1;
      assistantTs = laterTimestamp(assistantTs, ts);
      continue;
    }

    const mapped = claudeUsageFromRaw(record.message.usage);

    let entry = messages.get(messageId);
    if (!entry) {
      // 首行时才判定锚点：`assistantTs` 此刻不含当前行。
      // prompt 之后已经写过 assistant 行 ⇒ 同轮续写，锚点陈旧 ⇒ 不采样（anchor = null）。
      const usable = promptTs !== null && (assistantTs === null || promptTs >= assistantTs);
      entry = {
        id: messageId,
        anchorTs: usable ? promptTs : null,
        anchorKind: usable ? promptKind : "none",
        lastTs: ts,
        bestOutput: 0,
        bestInput: 0,
        model,
        effort: trimmed(record.effort),
        sessionId: trimmed(record.sessionId),
        hasStop: false,
        sidechain: record.isSidechain === true,
        agent: trimmed(record.attributionAgent),
      };
      messages.set(messageId, entry);
      order.push(entry);
    }

    if (ts > entry.lastTs) entry.lastTs = ts;
    // 最佳行 = output 最大的行（与事件路径选中同一行）；input 与 model 随最佳行一起取。
    if (mapped.usage.output > entry.bestOutput) {
      entry.bestOutput = mapped.usage.output;
      entry.bestInput = mapped.usage.input;
      entry.model = model;
    }
    if (record.message.stop_reason !== null && record.message.stop_reason !== undefined) {
      entry.hasStop = true;
    }
    if (record.isSidechain === true) entry.sidechain = true;
    if (!entry.sessionId) entry.sessionId = trimmed(record.sessionId);
    if (!entry.effort) entry.effort = trimmed(record.effort);
    if (!entry.agent) entry.agent = trimmed(record.attributionAgent);

    assistantTs = laterTimestamp(assistantTs, ts);
  }

  // 扫描结束后统一决定是否产出。两个跳过桶互斥（恒等式要求）：
  // 锚点不可用优先于零用量 —— 前者是"不可计时"，后者是"没有输出"。
  let skippedZeroUsage = 0;
  let skippedNoAnchor = 0;
  for (const entry of order) {
    if (entry.anchorTs === null) {
      skippedNoAnchor += 1;
      continue;
    }
    if (entry.bestOutput <= 0) {
      skippedZeroUsage += 1;
      continue;
    }
    onSample({
      sourceKind: "claude",
      homeId,
      sourcePath,
      identity: [entry.id],
      messageId: entry.id,
      sessionId: entry.sessionId,
      channel: "claude",
      agentKind: subagentFile || entry.sidechain ? "subagent" : "main",
      agent: entry.agent,
      model: entry.model,
      modelProvider: "",
      reasoningEffort: entry.effort,
      modelEvidence: "request_scope",
      window: "request",
      timingKind: "request_e2e",
      timingSource: "timestamp_fallback",
      tokenScope: "reported_output_includes_reasoning",
      status: entry.hasStop ? "completed" : "unverified",
      tsMs: entry.lastTs,
      windowStartMs: entry.anchorTs,
      windowEndMs: entry.lastTs,
      durationMs: entry.lastTs - entry.anchorTs,
      outputTokens: entry.bestOutput,
      inputTokens: entry.bestInput,
      requestCount: 1,
    });
  }

  const stats = {
    candidates: messages.size,
    skippedZeroUsage,
    skippedNoAnchor,
    missingMessageId,
    malformedLines,
  };

  // 逐行问题不抛异常；只有读取本身失败才向上抛（由 `replaceFile` 回滚）。
  if (malformedLines > 0) {
    onWarning({ sourceKind: "claude", homeId, code: "MALFORMED_JSON", count: malformedLines });
  }
  if (missingMessageId > 0) {
    onWarning({ sourceKind: "claude", homeId, code: "UNKEYABLE_RECORD", count: missingMessageId });
  }

  return { state: "enabled", stats };
}
