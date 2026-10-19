/** Build one M1 raw performance candidate per stable Codex turn ledger. */

const TARGET_ITEM_TYPES = new Set(["AgentMessage", "Reasoning"]);

/** @typedef {{timestampMs: number | null, outputTokens: number | null}} CodexRequestLedger */
/** @typedef {{itemType: string | null, startedAtMs: number | null, completedAtMs: number | null}} CodexItemLedger */
/**
 * @typedef {object} CodexTurnLedger
 * @property {string} threadId
 * @property {string} turnId
 * @property {CodexRequestLedger[]} requests
 * @property {CodexItemLedger[]} items
 * @property {boolean} hasTaskComplete
 * @property {boolean} requestSetComplete
 * @property {number | null} requestOutputSum
 * @property {string[]} flags
 * @property {number} recordConflictCount
 * @property {{unkeyableRequestCount?: number, unkeyableItemCount?: number}} diagnostics
 * @property {string | null} agentKind
 * @property {string | null} model
 * @property {string | null} effort
 * @property {string | null} modelEvidence
 */

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validIdentityPart(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** @param {CodexItemLedger[]} items */
function getTimedSpans(items) {
  const spans = [];
  for (const item of items) {
    const startMs = item.startedAtMs;
    const endMs = item.completedAtMs;
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs) continue;
    spans.push({ startMs, endMs, durationMs: endMs - startMs });
  }
  return spans;
}

/** @param {string} homeId @param {CodexTurnLedger} turn */
function buildCandidate(homeId, turn) {
  const requests = turn.requests;
  // M6.1 admits only these item types; null here means M6.2 found conflicting target types.
  const targetItems = turn.items.filter((item) => item.itemType === null || TARGET_ITEM_TYPES.has(item.itemType));
  const spans = getTimedSpans(targetItems);
  const sortedSpans = [...spans].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  let furthestEnd = Number.NEGATIVE_INFINITY;
  let overlappingItemSpan = false;
  let durationMs = 0;
  let durationOverflow = false;
  let windowStartMs = null;
  let windowEndMs = null;

  for (const span of sortedSpans) {
    if (span.startMs < furthestEnd) overlappingItemSpan = true;
    furthestEnd = Math.max(furthestEnd, span.endMs);
    windowStartMs = windowStartMs === null ? span.startMs : Math.min(windowStartMs, span.startMs);
    windowEndMs = windowEndMs === null ? span.endMs : Math.max(windowEndMs, span.endMs);
    if (!durationOverflow) {
      durationMs += span.durationMs;
      if (!Number.isSafeInteger(durationMs)) durationOverflow = true;
    }
  }

  const partialItemSpan =
    spans.length > 0 && (spans.length < targetItems.length || (turn.diagnostics?.unkeyableItemCount ?? 0) > 0);
  const flags = new Set(Array.isArray(turn.flags) ? turn.flags : []);
  if (partialItemSpan) flags.add("PARTIAL_ITEM_SPAN");
  if (overlappingItemSpan) flags.add("OVERLAPPING_ITEM_SPAN");

  // An incomplete request identity set cannot prove either the total output or its final request time.
  const requestSetComplete = turn.requestSetComplete === true;
  const ended = turn.hasTaskComplete === true;
  const lastRequest = requests.at(-1);

  return {
    sourceKind: "codex",
    homeId,
    identity: [turn.threadId, turn.turnId],
    threadId: turn.threadId,
    turnId: turn.turnId,
    channel: "",
    agentKind: typeof turn.agentKind === "string" ? turn.agentKind : "unknown",
    agent: "",
    model: typeof turn.model === "string" ? turn.model : "",
    // session_meta.provider has unknown historical scope, so it cannot be attached to a turn.
    modelProvider: "",
    reasoningEffort: typeof turn.effort === "string" ? turn.effort : "",
    modelEvidence: turn.modelEvidence === "turn_context" ? "turn_context" : "",
    timingSource: "timestamp_fallback",
    terminalVerified: ended,
    tsMs:
      ended && requestSetComplete && Number.isSafeInteger(lastRequest?.timestampMs) ? lastRequest.timestampMs : null,
    windowStartMs,
    windowEndMs,
    durationMs: spans.length === 0 ? null : durationOverflow ? Number.MAX_SAFE_INTEGER + 1 : durationMs,
    outputTokens: requestSetComplete ? turn.requestOutputSum : null,
    inputTokens: null,
    requestCount: requests.length,
    itemCount: targetItems.length,
    timedItemCount: spans.length,
    sampleFlags: [...flags],
  };
}

function hasTurnEvidence(turn) {
  return (
    turn.requests.length > 0 ||
    turn.items.length > 0 ||
    turn.hasTaskComplete === true ||
    (turn.diagnostics?.unkeyableRequestCount ?? 0) > 0 ||
    (turn.diagnostics?.unkeyableItemCount ?? 0) > 0 ||
    turn.recordConflictCount > 0
  );
}

/**
 * Convert the M6.2 turn ledger into M1 raw candidates. The returned rollout file list
 * is internal dependency metadata and must never enter an API/report. This function
 * does not infer provider scope from session_meta records.
 *
 * @param {string} homeId
 * @param {{turns: any[], stats?: Record<string, unknown>}} folded
 * @param {string[]} rolloutFiles Complete discovered file set for downstream dependency tracking.
 * @returns {{candidates: Array<Record<string, unknown>>, warnings: Array<{sourceKind: string, homeId: string, code: string, count: number}>, rolloutFiles: string[]}}
 */
export function buildCodexTurnCandidates(homeId, folded, rolloutFiles) {
  if (typeof homeId !== "string" || homeId.trim() === "")
    throw new TypeError("Codex homeId must be a non-empty string");
  if (!isRecord(folded) || !Array.isArray(folded.turns)) throw new TypeError("Codex folded turns must be an array");
  if (!Array.isArray(rolloutFiles) || rolloutFiles.some((file) => typeof file !== "string" || file === "")) {
    throw new TypeError("Codex rolloutFiles must be an array of paths");
  }

  const candidates = [];
  let unkeyableTurns = 0;
  for (const turn of folded.turns) {
    if (!isRecord(turn) || !Array.isArray(turn.requests) || !Array.isArray(turn.items)) {
      throw new TypeError("Each Codex turn must contain request and item arrays");
    }
    if (!hasTurnEvidence(turn)) continue;
    if (!validIdentityPart(turn.threadId) || !validIdentityPart(turn.turnId)) {
      unkeyableTurns += 1;
      continue;
    }
    candidates.push(buildCandidate(homeId, turn));
  }

  const stats = isRecord(folded.stats) ? folded.stats : {};
  const requestCount = stats.unkeyableRequestRecords;
  const itemCount = stats.unkeyableItemRecords;
  const unkeyableRequests =
    typeof requestCount === "number" && Number.isSafeInteger(requestCount) && requestCount >= 0 ? requestCount : 0;
  const unkeyableItems =
    typeof itemCount === "number" && Number.isSafeInteger(itemCount) && itemCount >= 0 ? itemCount : 0;
  const unkeyableCount = unkeyableRequests + unkeyableItems + unkeyableTurns;
  const warnings =
    unkeyableCount > 0 ? [{ sourceKind: "codex", homeId, code: "UNKEYABLE_RECORD", count: unkeyableCount }] : [];

  return { candidates, warnings, rolloutFiles: [...rolloutFiles] };
}
