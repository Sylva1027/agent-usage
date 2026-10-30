// Claude Code 生成 TPS 候选 reader（只读、单遍、**文件顺序**）。
//
// 口径依据：[生成 TPS 方案](../../docs/plans/2026-10-27-generation-tps-plan.md) §1 / §2 / §3 / §9。
//
// 两条结构约束（都来自真实转录实测，不能"优化"掉）：
// 1. 同一 `message.id` 会写成 1–10 行。必须按 id 聚合；直接累加会把 token 放大 2.5–3 倍。
// 2. 同一 id 的最终 output 与 thinking 必须取自同一条用量行；分别取最大值会把两个时刻拼在一起。
//
// 只读字段：`type`、`timestamp`、`sessionId`、`message.id`、`message.model`、`message.usage`、
// `message.stop_reason`、`effort`、`isSidechain`、`attributionAgent`。正文与工具参数一律不读。
// 复用 `readRolloutLines`（处理 U+2028/U+2029）与 `claudeUsageFromRaw`（输入超集 / reasoning 拆分），
// 但**不复用** `streamClaudeSessionEvents`：本 reader 需要保留稳定 message.id 的多行合并规则。
import { claudeUsageFromRaw } from "../claude-code-usage.js";
import { readRolloutLines } from "../codex-rollout.js";
import { generationPerfValues } from "../perf-request-timing.js";
import { USAGE_DETAIL_MASK } from "../../public/usage-fields.js";

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

function nonReasoningOutput(entry) {
  const known =
    (entry.bestDetailMask & USAGE_DETAIL_MASK.output) !== 0 &&
    (entry.bestDetailMask & USAGE_DETAIL_MASK.reasoning) !== 0;
  if (!known) return null;
  return entry.bestOutput - entry.bestReasoning;
}

function generationForEntry(entry, options) {
  const lookup = typeof options.lookupRequestTiming === "function" ? options.lookupRequestTiming : null;
  if (lookup === null) return null;

  const query = {
    homeId: entry.homeId,
    responseId: entry.id,
    model: entry.model,
    outputTokens: entry.bestOutput,
    reasoningOutputTokens: entry.bestReasoningKnown ? entry.bestReasoning : null,
  };
  let timing;
  try {
    timing = lookup(query);
  } catch {
    return null;
  }
  if (
    timing?.state !== "available" ||
    timing.requestedModel !== query.model ||
    timing.reportedOutputTokens !== query.outputTokens
  ) {
    return null;
  }
  return timing.generation ?? null;
}

function generationPerformanceForEntry(entry, options) {
  try {
    return generationPerfValues(generationForEntry(entry, options));
  } catch {
    return null;
  }
}

/**
 * 扫描一个 Claude Code 转录文件，产出 raw 性能候选（C-2，键名固定）。
 *
 * 计数恒等式：
 * `candidates === emitted + skippedZeroUsage`；`skippedNoAnchor` 为兼容字段并恒为 0。
 * 其中 `candidates` 是去重后的 `message.id` 数（不含 `model` 以 `<` 开头的 synthetic 行）。
 *
 * @param {string} filePath 物理转录文件（主转录或 `<sessionId>/subagents/agent-*.jsonl`）
 * @param {{ id?: unknown, path?: unknown, kind?: unknown, label?: unknown }} source
 * @param {(sample: Record<string, unknown>) => void} onSample 每条可采样消息调用一次
 * @param {{
 *   onWarning?: (warning: { sourceKind: string, homeId: string, code: string, count: number }) => void,
 *   lookupRequestTiming?: (query: {
 *     homeId: string,
 *     responseId: string,
 *     model: string,
 *     outputTokens: number,
 *     reasoningOutputTokens: number | null,
 *   }) => {
 *     state?: unknown,
 *     requestedModel?: unknown,
 *     reportedOutputTokens?: unknown,
 *     generation?: unknown,
 *   } | null,
 * }} [options]
 * @returns {Promise<{ state: "enabled", stats: { candidates: number, skippedZeroUsage: number, skippedNoAnchor: number, missingMessageId: number, malformedLines: number } }>}
 */
export async function streamClaudePerfSamples(filePath, source, onSample, options = {}) {
  const onWarning = typeof options.onWarning === "function" ? options.onWarning : () => {};
  const homeId = trimmed(source?.id) || trimmed(source?.path);
  const sourcePath = trimmed(source?.path) || trimmed(filePath);
  const subagentFile = isSubagentPath(filePath);

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
    if (type !== "assistant" || !record?.message?.usage) continue;

    const model = trimmed(record.message.model);
    const messageId = trimmed(record.message.id);

    // `<synthetic>` 是 harness 本地生成的记录，不是模型响应：整条忽略，不进 candidates。
    if (model.startsWith("<")) continue;

    // 有 usage 但没有稳定身份：不能成为样本，只计 `UNKEYABLE_RECORD`。
    // 绝不退化成按 sessionId 或时间窗匹配（§5.8）。
    if (messageId === "") {
      missingMessageId += 1;
      continue;
    }

    const mapped = claudeUsageFromRaw(record.message.usage);

    let entry = messages.get(messageId);
    if (!entry) {
      entry = {
        id: messageId,
        homeId,
        lastTs: ts,
        bestOutput: 0,
        bestInput: 0,
        bestReasoning: 0,
        bestReasoningKnown: false,
        bestDetailMask: 0,
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
    // 最佳行 = output 最大的行；input、reasoning、known 位与模型随同一条行一起取。
    // 相同 output 时取后出现的行，代表该 message.id 的最终完成记录。
    if (mapped.usage.output >= entry.bestOutput) {
      entry.bestOutput = mapped.usage.output;
      entry.bestInput = mapped.usage.input;
      entry.bestReasoning = mapped.usage.reasoning;
      entry.bestReasoningKnown = (mapped.detailMask & USAGE_DETAIL_MASK.reasoning) !== 0;
      entry.bestDetailMask = mapped.detailMask;
      entry.model = model;
      entry.effort = trimmed(record.effort);
      entry.sessionId = trimmed(record.sessionId);
    }
    if (record.message.stop_reason !== null && record.message.stop_reason !== undefined) {
      entry.hasStop = true;
    }
    if (record.isSidechain === true) entry.sidechain = true;
    if (!entry.sessionId) entry.sessionId = trimmed(record.sessionId);
    if (!entry.effort) entry.effort = trimmed(record.effort);
    if (!entry.agent) entry.agent = trimmed(record.attributionAgent);
  }

  // 没有 prompt 锚点不再阻止候选；只有确定没有输出的占位消息不产出。
  let skippedZeroUsage = 0;
  const skippedNoAnchor = 0;
  for (const entry of order) {
    if (entry.bestOutput <= 0) {
      skippedZeroUsage += 1;
      continue;
    }
    const localOutput = nonReasoningOutput(entry);
    const performance = generationPerformanceForEntry(entry, options);
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
      timingKind: "generation",
      timingSource: performance === null ? "unknown" : "explicit",
      tokenScope: "non_reasoning_output",
      methodVersion: "tps-v5",
      status: entry.hasStop ? "completed" : "unverified",
      tsMs: entry.lastTs,
      windowStartMs: null,
      windowEndMs: null,
      durationMs: performance === null ? null : performance.durationMs,
      outputTokens: performance === null ? localOutput : performance.outputTokens,
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
