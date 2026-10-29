// WorkBuddy 的生成 TPS 候选 reader。
//
// 关键结构约束：
// - **复用** `streamWorkbuddySessionEvents` 拿事件，不重新解析会话文件 —— 事件里带的 `messageId`
//   就是 trace span 的关联键（该字段只服务本 reader，不进库、不进 API）。
// - trace 的 `generation` span duration 是完整调用时长，不能冒充首/末有效输出之间的生成时长。
// - `qua.end` 的正文间隔只有同时通过当前日志、会话与 trace 三侧标量证明时才成为生成时长；
//   未闭合的候选仍产出，`durationMs = null`，绝不跳过模型行。
// - 原始 output 含 reasoning；只有 reasoning known 位存在时才映射为非推理 output。
import { streamWorkbuddySessionEvents } from "../workbuddy-usage.js";
import { USAGE_DETAIL_MASK } from "../../public/usage-fields.js";

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function textTimingMatchesSession(timing, proof, event) {
  if (!timing || !proof || proof.textOnly !== true || proof.completeOutput !== true) return false;
  if (
    proof.usageCount !== 1 ||
    proof.messageCount !== 1 ||
    proof.reasoningBeforeText !== true ||
    !Number.isSafeInteger(proof.outputTokens) ||
    !Number.isSafeInteger(proof.reasoningTokens) ||
    proof.outputTokens !== timing.outputTokens ||
    proof.reasoningTokens !== timing.reasoningTokens ||
    proof.outputTokens !== event.usage.output ||
    proof.reasoningTokens !== event.usage.reasoning ||
    timing.nonReasoningTokens !== proof.outputTokens - proof.reasoningTokens
  ) {
    return false;
  }
  if (
    timing.conversationRequestId &&
    proof.conversationRequestId &&
    timing.conversationRequestId !== proof.conversationRequestId
  ) {
    return false;
  }
  return true;
}

/**
 * @param {string} filePath
 * @param {{ id?: unknown, path?: unknown, label?: unknown }} source
 * @param {(sample: Record<string, unknown>) => void} onSample
 * @param {{
 *   onWarning?: (warning: string) => void,
 *   lookupGenerationDuration?: (messageId: string) => { durationMs?: unknown, endedAtMs?: unknown } | null,
 *   lookupTextTiming?: (messageId: string) => Record<string, unknown> | null,
 * }} [options]
 * @returns {Promise<{ state: "enabled", stats: {
 *   candidates: number,
 *   skippedNoDuration: number,
 *   missingGenerationDuration: number,
 *   textTimingSamples: number,
 *   missingTextTiming: number,
 *   malformedLines: number
 * } }>}
 */
export async function streamWorkbuddyPerfSamples(filePath, source, onSample, options = {}) {
  const onWarning = typeof options.onWarning === "function" ? options.onWarning : () => {};
  const homeId = trimmed(source?.id) || trimmed(source?.path);
  const lookup = typeof options.lookupGenerationDuration === "function" ? options.lookupGenerationDuration : null;
  const lookupTextTiming = typeof options.lookupTextTiming === "function" ? options.lookupTextTiming : null;
  const stats = {
    candidates: 0,
    skippedNoDuration: 0,
    missingGenerationDuration: 0,
    textTimingSamples: 0,
    missingTextTiming: 0,
    malformedLines: 0,
  };
  const seen = new Set();

  await streamWorkbuddySessionEvents(
    filePath,
    source,
    (event) => {
      const messageId = trimmed(event.messageId);
      if (!messageId || seen.has(messageId)) return;
      seen.add(messageId);
      const duration = lookup === null ? null : lookup(messageId);
      const textTiming = lookupTextTiming === null ? null : lookupTextTiming(messageId);
      const explicitTextTiming = textTimingMatchesSession(textTiming, event.nativeProof, event);
      const reportedDurationMs = Number(duration?.durationMs);
      const outputKnown = (event.detailMask & USAGE_DETAIL_MASK.output) !== 0;
      const reasoningKnown = (event.detailMask & USAGE_DETAIL_MASK.reasoning) !== 0;
      const nonReasoningOutputTokens =
        outputKnown && reasoningKnown ? event.usage.output - event.usage.reasoning : null;
      const windowOutputTokens =
        explicitTextTiming && Number.isSafeInteger(nonReasoningOutputTokens)
          ? nonReasoningOutputTokens - 1
          : nonReasoningOutputTokens;
      stats.candidates += 1;
      if (explicitTextTiming) {
        stats.textTimingSamples += 1;
      } else {
        stats.missingGenerationDuration += 1;
        stats.missingTextTiming += 1;
      }
      onSample({
        sourceKind: "workbuddy",
        homeId,
        sourcePath: trimmed(source?.path) || trimmed(filePath),
        messageId,
        channel: "workbuddy",
        sessionId: trimmed(event.sessionId),
        model: trimmed(event.model),
        tsMs: event.timestampMs,
        window: "request",
        timingKind: "generation",
        tokenScope: "non_reasoning_output",
        outputTokens: windowOutputTokens,
        inputTokens: event.usage.input,
        durationMs: explicitTextTiming ? textTiming.durationMs : null,
        status: "completed",
        requestCount: 1,
        timingSource: explicitTextTiming ? "explicit" : "unknown",
        reportedOutputTokens: event.usage.output,
        reportedReasoningTokens: reasoningKnown ? event.usage.reasoning : null,
        reportedDurationMs:
          Number.isSafeInteger(reportedDurationMs) && reportedDurationMs > 0 ? reportedDurationMs : null,
        agentKind: "main",
      });
    },
    {
      onWarning: (warning) => {
        const match = /^WORKBUDDY_MALFORMED_JSON:(\d+)/.exec(String(warning));
        if (match) stats.malformedLines += Number(match[1]);
        onWarning(warning);
      },
    },
  );

  return { state: "enabled", stats };
}
