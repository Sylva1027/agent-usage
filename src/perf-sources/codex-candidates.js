/** Build one M1 raw performance candidate per stable Codex turn ledger. */

import { resolveCodexTurnRequestTiming } from "./codex-request-timing.js";

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

/**
 * @typedef {{homeId: string, threadId: string, turnId: string, responseId: string, model: string | null, outputTokens: unknown}} CodexRequestTimingQuery
 * @typedef {(query: CodexRequestTimingQuery) => {state: string, durationMs: unknown, reportedOutputTokens: unknown, requestedModel: unknown}} CodexRequestTimingLookup
 */

/**
 * @param {string} homeId
 * @param {CodexTurnLedger} turn
 * @param {{lookupRequestTiming?: CodexRequestTimingLookup}} [options]
 */
function buildCandidate(homeId, turn, options = {}) {
  const requests = turn.requests;
  // M6.1 admits only these item types; null here means M6.2 found conflicting target types.
  const targetItems = turn.items.filter((item) => item.itemType === null || TARGET_ITEM_TYPES.has(item.itemType));
  const timedItemCount = targetItems.filter(
    (item) =>
      Number.isSafeInteger(item.startedAtMs) &&
      Number.isSafeInteger(item.completedAtMs) &&
      /** @type {number} */ (item.completedAtMs) > /** @type {number} */ (item.startedAtMs),
  ).length;

  const timing = resolveCodexTurnRequestTiming(homeId, turn, options.lookupRequestTiming);
  const flags = new Set(Array.isArray(turn.flags) ? turn.flags : []);
  if (timing.state === "missing") flags.add("MISSING_DURATION");
  if (timing.state === "conflict") flags.add("RECORD_CONFLICT");
  if (timing.state === "invalid") flags.add("TIME_INVALID");

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
    timingSource: timing.state === "complete" ? "explicit" : "unknown",
    terminalVerified: ended,
    tsMs:
      ended && requestSetComplete && Number.isSafeInteger(lastRequest?.timestampMs) ? lastRequest.timestampMs : null,
    windowStartMs: null,
    windowEndMs: null,
    durationMs: timing.durationMs,
    outputTokens: requestSetComplete ? turn.requestOutputSum : null,
    inputTokens: null,
    requestCount: requests.length,
    itemCount: targetItems.length,
    timedItemCount,
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
 * @param {{lookupRequestTiming?: CodexRequestTimingLookup}} [options]
 * @returns {{candidates: Array<Record<string, unknown>>, warnings: Array<{sourceKind: string, homeId: string, code: string, count: number}>, rolloutFiles: string[]}}
 */
export function buildCodexTurnCandidates(homeId, folded, rolloutFiles, options = {}) {
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
    candidates.push(buildCandidate(homeId, turn, options));
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
