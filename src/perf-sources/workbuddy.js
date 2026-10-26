// WorkBuddy 的 TPS 候选 reader。
//
// 关键结构约束（实施计划 §1.4 / §6 P2）：
// - **复用** `streamWorkbuddySessionEvents` 拿事件，不重新解析会话文件 —— 事件里带的 `messageId`
//   就是 trace span 的关联键（该字段只服务本 reader，不进库、不进 API）。
// - `durationMs` **只能查表得来**（按 home 归属的 duration observations，由 trace 预扫写入），
//   reader 自己**不算**时间：会话转录里根本没有可靠的首末时间戳。
// - 查不到时长 ⇒ 计 `skippedNoDuration` 并**跳过**，绝不造 0 时长样本（否则会伪造
//   `DURATION_NONPOSITIVE` 扣分）。
import { streamWorkbuddySessionEvents } from "../workbuddy-usage.js";

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * @param {string} filePath
 * @param {{ id?: unknown, path?: unknown, label?: unknown }} source
 * @param {(sample: Record<string, unknown>) => void} onSample
 * @param {{
 *   onWarning?: (warning: string) => void,
 *   lookupGenerationDuration?: (messageId: string) => { durationMs?: unknown, endedAtMs?: unknown } | null,
 * }} [options]
 * @returns {Promise<{ state: "enabled", stats: { candidates: number, skippedNoDuration: number, malformedLines: number } }>}
 */
export async function streamWorkbuddyPerfSamples(filePath, source, onSample, options = {}) {
  const onWarning = typeof options.onWarning === "function" ? options.onWarning : () => {};
  const homeId = trimmed(source?.id) || trimmed(source?.path);
  const lookup = typeof options.lookupGenerationDuration === "function" ? options.lookupGenerationDuration : null;
  const stats = { candidates: 0, skippedNoDuration: 0, malformedLines: 0 };
  const seen = new Set();

  await streamWorkbuddySessionEvents(
    filePath,
    source,
    (event) => {
      const messageId = trimmed(event.messageId);
      if (!messageId || seen.has(messageId)) return;
      seen.add(messageId);
      const duration = lookup === null ? null : lookup(messageId);
      const durationMs = Number(duration?.durationMs);
      if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
        stats.skippedNoDuration += 1;
        return;
      }
      stats.candidates += 1;
      onSample({
        sourceKind: "workbuddy",
        homeId,
        sourcePath: trimmed(source?.path) || trimmed(filePath),
        messageId,
        channel: "workbuddy",
        sessionId: trimmed(event.sessionId),
        model: trimmed(event.model),
        tsMs: event.timestampMs,
        outputTokens: event.usage.output,
        inputTokens: event.usage.input,
        durationMs,
        status: "completed",
        // span.duration 是**直接观测值**（不是时间戳相减）⇒ explicit。
        timingSource: "explicit",
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
