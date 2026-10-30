/**
 * Stream a single Codex rollout into a small, private metadata projection.
 *
 * This is the M6.1 boundary: it preserves only stable identity, model/agent
 * evidence, token counts, response/item identity and lifecycle metadata,
 * terminal fields, and source ordering.
 * It deliberately does not fold duplicate records or construct TPS samples;
 * M6.2/M6.3 own those decisions.
 */
import { readRolloutLines } from "../codex-rollout.js";
import path from "node:path";
import { normalizeMeasuredOutput, OUTPUT_TIME_RESOLUTION_MS } from "../perf-output-tokens.js";

const TARGET_ITEM_TYPES = new Set(["AgentMessage", "Reasoning"]);

// These types were observed and registered by M0.5/M0.6 but are not inputs to
// the M6 candidate projection. Unknown labels are counted without retaining
// their value or inspecting the rest of their payload.
const IGNORED_TOP_LEVEL_TYPES = new Set(["world_state", "rollout"]);
const PROJECTED_RESPONSE_ITEM_TYPES = new Set(["reasoning", "function_call", "custom_tool_call"]);
const IGNORED_EVENT_TYPES = new Set([
  "token_count",
  "task_started",
  "thread_settings_applied",
  "turn_aborted",
  "custom_tool_call",
  "custom_tool_call_output",
]);

// M8.2 §3 (2026-10-06 生产方案实施裁定): context/bookkeeping records observed
// in real rollouts. They are accepted so a single unregistered label no longer
// rejects a whole file, but they are NOT projected: no request, item, time
// window, or terminal evidence. Their payload bodies (compaction history,
// nested token-usage snapshots, retained context) are never read. A valid label
// must not mask a broken container, so an object payload is still required.
const IGNORED_CONTEXT_TOP_LEVEL_TYPES = new Set([
  "compacted",
  "inter_agent_communication_metadata",
  "retained_context",
]);

// M8.2 §3: registered non-target `item_completed` discriminators. Only these
// labels are skipped; anything else still counts as an unknown type. The
// TPS numerator is request-level reported output tokens and the denominator is
// the two target item types, so these items never contribute tokens or spans —
// their tool/extension durations must not enter the target denominator.
const IGNORED_ITEM_TYPES = new Set([
  "CommandExecution",
  "UserMessage",
  "FileChange",
  "McpToolCall",
  "Extension",
  "ImageView",
  "ContextCompaction",
  "SubAgentActivity",
  "CollabAgentToolCall",
  "DynamicToolCall",
  "Plan",
  "FunctionCallOutput",
  "WebSearch",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeNonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nonNegativeFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function projectNativeGeneration(value) {
  if (!isRecord(value) || value.schema_version !== 5 || value.clock !== "transport_receive") return null;
  const rawWindows = Array.isArray(value.windows) ? value.windows : [];
  return normalizeMeasuredOutput({
    tokenizer: value.tokenizer,
    samplingWindowMs: OUTPUT_TIME_RESOLUTION_MS,
    outputTokens: value.output_tokens,
    durationMs: value.observed_duration_ms,
    windows: rawWindows.map((window) =>
      isRecord(window)
        ? {
            startMs: window.start_ms,
            endMs: window.end_ms,
            outputTokens: window.output_tokens,
          }
        : null,
    ),
  });
}

function fieldType(value, present) {
  if (!present) return "absent";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function emptyStats() {
  return {
    linesRead: 0,
    malformedJsonLines: 0,
    nonObjectRows: 0,
    invalidPayloadRows: 0,
    invalidItemRows: 0,
    unknownTopLevelTypes: 0,
    unknownEventTypes: 0,
    unknownItemTypes: 0,
    sessionMetaWithoutThreadId: 0,
    // M8.2 §4.1(2) internal header-integrity evidence: a `session_meta` row whose
    // payload is not an object is a broken header container. It is tracked
    // separately from `invalidPayloadRows` because a broken *item* or other
    // payload may still belong to a legitimately isolatable thread, while a
    // broken header must never let a later healthy header wash it away.
    // Internal only — never surfaced through the public API or probe key domain.
    invalidSessionMetaPayloads: 0,
    ambiguousSessionMetaThreadId: 0,
    recordsWithoutThreadId: 0,
    recordsWithoutTurnId: 0,
  };
}

function sessionMetaRecord(payload, sourcePath, lineNumber, threadEvidence, ordinal) {
  // M8.2 §2 field ruling. Upstream `codex-rs/protocol/src/protocol.rs`
  // (`SessionMeta`) types `id` as `ThreadId` — the CURRENT thread — and
  // `session_id` as `SessionId` — the ROOT thread. They are different identity
  // levels, so inequality is NOT a current-thread conflict and must not be
  // required to hold. `SessionMetaLine::deserialize` back-fills `session_id`
  // from `id` for legacy headers; there is no reverse rule for `id`.
  // Consequence: `session_id`-only headers are rejected on purpose (the root
  // thread must not stand in for a current sub-thread). This intentionally
  // revises the former `id || sessionId` fallback.
  const id = text(payload.id);
  const threadId = id;
  if (threadId) threadEvidence.add(threadId);
  // A real conflict is now "this file already showed a different current
  // thread id", i.e. more than one distinct `id` across headers.
  const threadEvidenceConflict = threadEvidence.size > 1;

  const source = payload.source;
  const sourceIsRecord = isRecord(source);
  const sourceIsString = typeof source === "string";
  const subagent = sourceIsRecord && isRecord(source.subagent) ? source.subagent : null;
  const threadSpawn = subagent && isRecord(subagent.thread_spawn);
  const historyModePresent = Object.hasOwn(payload, "history_mode");
  const historyMode = payload.history_mode;
  const startOrdinalPresent = Object.hasOwn(payload, "subagent_history_start_ordinal");
  const startOrdinal = payload.subagent_history_start_ordinal;
  const historyBasePresent = Object.hasOwn(payload, "history_base");
  const historyBase = isRecord(payload.history_base) ? payload.history_base : null;
  const historyBaseThreadIdPresent = Boolean(historyBase && Object.hasOwn(historyBase, "thread_id"));
  const historyBaseEndOrdinalPresent = Boolean(historyBase && Object.hasOwn(historyBase, "end_ordinal_exclusive"));
  const historyBaseEndBytePresent = Boolean(historyBase && Object.hasOwn(historyBase, "end_byte_offset"));

  return {
    kind: "session_meta",
    sourcePath,
    lineNumber,
    ordinal,
    threadId,
    threadEvidenceConflict,
    sessionId: text(payload.session_id),
    parentThreadId: text(payload.parent_thread_id),
    forkedFromId: text(payload.forked_from_id),
    sourceKind: sourceIsRecord ? "structured" : sourceIsString ? "string" : source == null ? "missing" : "other",
    explicitSubagent: subagent !== null,
    explicitThreadSpawn: Boolean(threadSpawn),
    historyModePresent,
    historyModeType: fieldType(historyMode, historyModePresent),
    historyMode: typeof historyMode === "string" ? historyMode : null,
    subagentHistoryStartOrdinalPresent: startOrdinalPresent,
    subagentHistoryStartOrdinalType: fieldType(startOrdinal, startOrdinalPresent),
    subagentHistoryStartOrdinal: safeNonNegativeInteger(startOrdinal),
    historyBasePresent,
    historyBaseIsObject: historyBase !== null,
    historyBaseThreadIdPresent,
    historyBaseThreadIdType: historyBaseThreadIdPresent ? fieldType(historyBase.thread_id, true) : "absent",
    historyBaseThreadId: text(historyBase?.thread_id),
    historyBaseEndOrdinalPresent,
    historyBaseEndOrdinalType: historyBaseEndOrdinalPresent
      ? fieldType(historyBase.end_ordinal_exclusive, true)
      : "absent",
    historyBaseEndOrdinalExclusive: safeNonNegativeInteger(historyBase?.end_ordinal_exclusive),
    historyBaseEndByteOffsetPresent: historyBaseEndBytePresent,
    historyBaseEndByteOffsetType: historyBaseEndBytePresent ? fieldType(historyBase.end_byte_offset, true) : "absent",
    historyBaseEndByteOffset: safeNonNegativeInteger(historyBase?.end_byte_offset),
    forkedFromOrdinalExclusive: safeNonNegativeInteger(payload.forked_from_ordinal_exclusive),
    forkedFromOrdinalExclusivePresent: Object.hasOwn(payload, "forked_from_ordinal_exclusive"),
    forkedFromOrdinalExclusiveType: fieldType(
      payload.forked_from_ordinal_exclusive,
      Object.hasOwn(payload, "forked_from_ordinal_exclusive"),
    ),
    threadSource: text(payload.thread_source),
    modelProvider: text(payload.model_provider),
  };
}

function projectedRecord(kind, sourcePath, lineNumber, threadId, turnId, fields = {}, ordinal = null) {
  return { kind, sourcePath, lineNumber, ordinal, threadId, turnId, ...fields };
}

function emptyOrdinalSequence() {
  return {
    rowCount: 0,
    invalidCount: 0,
    duplicateCount: 0,
    physicalOrderReversalCount: 0,
    gapCount: 0,
    firstLineNumber: null,
    secondLineNumber: null,
    firstOrdinal: null,
    lastOrdinal: null,
  };
}

/**
 * Read one rollout file from either `sessions` or `archived_sessions`.
 *
 * Records are returned in physical line order. Callers merging multiple
 * rollouts must order files by source path first, then retain this order.
 * `sourcePath` is internal dependency metadata and must never enter an API or
 * public report. Read errors throw so the indexing layer can mark the source
 * incomplete instead of publishing a readable subset.
 *
 * @param {string} filePath absolute or workspace-relative rollout JSONL path
 * @returns {Promise<{records: Array<Record<string, unknown>>, stats: ReturnType<typeof emptyStats>, ordinalSequence: ReturnType<typeof emptyOrdinalSequence>}>}
 */
export async function readCodexRolloutMetadata(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new TypeError("Codex rollout path must be a non-empty string");
  }

  const sourcePath = path.resolve(filePath);
  const stats = emptyStats();
  const ordinalSequence = emptyOrdinalSequence();
  /** @type {Array<Record<string, unknown> & { kind: string, threadId: string | null, turnId?: string | null }>} */
  const records = [];
  const threadEvidence = new Set();
  let conflictingSessionMeta = false;
  let previousOrdinal = null;
  let previousOrdinalValid = false;
  let currentTurnId = null;
  let lineNumber = 0;
  for await (const line of readRolloutLines(sourcePath)) {
    lineNumber += 1;
    if (!line.trim()) continue;
    stats.linesRead += 1;

    let row;
    try {
      row = JSON.parse(line);
    } catch {
      if (sourcePath.endsWith(".jsonl.zst")) throw new Error(`Invalid compressed rollout JSON at line ${lineNumber}`);
      stats.malformedJsonLines += 1;
      continue;
    }
    if (!isRecord(row)) {
      stats.nonObjectRows += 1;
      continue;
    }

    ordinalSequence.rowCount += 1;
    if (ordinalSequence.firstLineNumber === null) ordinalSequence.firstLineNumber = lineNumber;
    else if (ordinalSequence.secondLineNumber === null) ordinalSequence.secondLineNumber = lineNumber;
    const ordinal = safeNonNegativeInteger(row.ordinal);
    if (ordinalSequence.rowCount === 1) ordinalSequence.firstOrdinal = ordinal;
    ordinalSequence.lastOrdinal = ordinal;
    if (ordinal === null) {
      ordinalSequence.invalidCount += 1;
      previousOrdinal = null;
      previousOrdinalValid = false;
    } else {
      if (previousOrdinalValid) {
        if (ordinal < previousOrdinal) ordinalSequence.physicalOrderReversalCount += 1;
        else if (ordinal === previousOrdinal) ordinalSequence.duplicateCount += 1;
        else if (previousOrdinal === Number.MAX_SAFE_INTEGER || ordinal !== previousOrdinal + 1)
          ordinalSequence.gapCount += 1;
      }
      previousOrdinal = ordinal;
      previousOrdinalValid = true;
    }

    const topType = text(row.type);
    const payload = isRecord(row.payload) ? row.payload : null;
    const payloadTurnId = text(payload?.turn_id);
    if (payloadTurnId) currentTurnId = payloadTurnId;

    if (topType === "session_meta") {
      if (!payload) {
        stats.invalidPayloadRows += 1;
        stats.invalidSessionMetaPayloads += 1;
        continue;
      }
      const record = sessionMetaRecord(payload, sourcePath, lineNumber, threadEvidence, ordinal);
      conflictingSessionMeta ||= record.threadEvidenceConflict;
      if (!record.threadId) stats.sessionMetaWithoutThreadId += 1;
      records.push(record);
      continue;
    }

    if (topType === "turn_context") {
      if (!payload) {
        stats.invalidPayloadRows += 1;
        continue;
      }
      records.push(
        projectedRecord(
          "turn_context",
          sourcePath,
          lineNumber,
          text(payload.thread_id),
          text(payload.turn_id),
          {
            model: text(payload.model),
            effort: text(payload.effort),
          },
          ordinal,
        ),
      );
      continue;
    }

    if (topType === "token_usage_record") {
      if (!payload) {
        stats.invalidPayloadRows += 1;
        continue;
      }
      const usage = isRecord(payload.usage) ? payload.usage : null;
      const turnTokenUsage = isRecord(payload.turn_token_usage) ? payload.turn_token_usage : null;
      const nativeGeneration = projectNativeGeneration(payload.generation_timing);
      // Schema 3 is the only native contract with final visible-output token windows.
      records.push(
        projectedRecord(
          "token_usage_record",
          sourcePath,
          lineNumber,
          text(payload.thread_id),
          text(payload.turn_id),
          {
            responseId: text(payload.response_id),
            outputTokens: safeNonNegativeInteger(usage?.output_tokens),
            reasoningOutputTokens: safeNonNegativeInteger(usage?.reasoning_output_tokens),
            reasoningOutputTokensKnown: safeNonNegativeInteger(usage?.reasoning_output_tokens) !== null,
            ...(nativeGeneration === null ? {} : { nativeGeneration }),
            turnOutputTokens: safeNonNegativeInteger(turnTokenUsage?.output_tokens),
            timestamp: text(row.timestamp),
          },
          ordinal,
        ),
      );
      continue;
    }

    if (topType === "response_item") {
      if (!payload) continue;
      const itemType = text(payload.type);
      const role = text(payload.role);
      const generatedText = itemType === "message" && role === "assistant";
      if (!generatedText && !PROJECTED_RESPONSE_ITEM_TYPES.has(itemType)) continue;
      records.push(
        projectedRecord(
          "response_item",
          sourcePath,
          lineNumber,
          text(payload.thread_id),
          text(payload.turn_id) ?? currentTurnId,
          {
            itemId: text(payload.id),
            responseItemType: itemType,
            role,
            status: text(payload.status),
            callId: text(payload.call_id),
            timestamp: text(row.timestamp),
          },
          ordinal,
        ),
      );
      continue;
    }

    if (topType === "event_msg") {
      if (!payload) {
        stats.invalidPayloadRows += 1;
        continue;
      }
      const eventType = text(payload.type);

      if (eventType === "item_completed") {
        const item = isRecord(payload.item) ? payload.item : null;
        if (!item) {
          stats.invalidItemRows += 1;
          continue;
        }
        const itemType = text(item.type);
        if (IGNORED_ITEM_TYPES.has(itemType)) {
          // M8.2 §2/§3: registered non-target item. Retain only the envelope's
          // explicit thread id so a genuine ownership contradiction is still
          // detected when the type is skipped; project nothing else (no item
          // count, no time window, no terminal evidence, no body). The item's
          // own sender/receiver/agent_thread_id fields are never used as this
          // file's identity.
          const envelopeThreadId = text(payload.thread_id);
          if (envelopeThreadId) {
            records.push({
              kind: "ignored_item_envelope",
              sourcePath,
              lineNumber,
              ordinal,
              threadId: envelopeThreadId,
              turnId: text(payload.turn_id),
            });
          }
          continue;
        }
        if (!TARGET_ITEM_TYPES.has(itemType)) {
          stats.unknownItemTypes += 1;
          continue;
        }
        records.push(
          projectedRecord(
            "item_completed",
            sourcePath,
            lineNumber,
            text(payload.thread_id),
            text(payload.turn_id),
            {
              itemId: text(item.id),
              itemType,
              startedAtMs: safeNonNegativeInteger(payload.started_at_ms),
              completedAtMs: safeNonNegativeInteger(payload.completed_at_ms),
            },
            ordinal,
          ),
        );
        continue;
      }

      if (eventType === "task_complete") {
        records.push(
          projectedRecord(
            "task_complete",
            sourcePath,
            lineNumber,
            text(payload.thread_id),
            text(payload.turn_id),
            {
              // These are epoch seconds in Codex JSONL. They are terminal
              // evidence only; M6.3 must not use them as the TPS denominator.
              startedAtSec: nonNegativeFiniteNumber(payload.started_at),
              completedAtSec: nonNegativeFiniteNumber(payload.completed_at),
              durationMs: safeNonNegativeInteger(payload.duration_ms),
            },
            ordinal,
          ),
        );
        continue;
      }

      if (eventType && IGNORED_EVENT_TYPES.has(eventType)) continue;
      stats.unknownEventTypes += 1;
      continue;
    }

    if (topType && IGNORED_CONTEXT_TOP_LEVEL_TYPES.has(topType)) {
      // Accepted context/bookkeeping record: requires an object payload but is
      // never projected and its body is never read.
      if (!payload) {
        stats.invalidPayloadRows += 1;
        continue;
      }
      continue;
    }

    if (topType && IGNORED_TOP_LEVEL_TYPES.has(topType)) continue;
    stats.unknownTopLevelTypes += 1;
  }

  const uniqueFileThreadId = threadEvidence.size === 1 && !conflictingSessionMeta ? [...threadEvidence][0] : null;
  if (threadEvidence.size > 1 || conflictingSessionMeta) stats.ambiguousSessionMetaThreadId += 1;

  for (const record of records) {
    if (record.kind === "session_meta") continue;
    if (!record.threadId && uniqueFileThreadId) record.threadId = uniqueFileThreadId;
    if (!record.threadId) stats.recordsWithoutThreadId += 1;
    if (!record.turnId) stats.recordsWithoutTurnId += 1;
  }

  return { records, stats, ordinalSequence };
}
