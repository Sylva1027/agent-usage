/** Build Codex performance candidates from response-level generation ledgers. */

import { generationPerfValues } from "../perf-request-timing.js";
import { PERF_METHOD_VERSION } from "../perf-stats.js";
import { resolveCodexRequestTiming, resolveCodexTurnRequestTiming } from "./codex-request-timing.js";

const TARGET_ITEM_TYPES = new Set(["AgentMessage", "Reasoning"]);
const TURN_WIDE_RESPONSE_FLAGS = new Set(["MODEL_AMBIGUOUS"]);

/** @typedef {{timestampMs: number | null, outputTokens: number | null}} CodexRequestLedger */
/** @typedef {{itemType: string | null, startedAtMs: number | null, completedAtMs: number | null}} CodexItemLedger */
/** @typedef {{responseId: string, outputTokens: number | null, reasoningOutputTokens: number | null, reasoningOutputTokensKnown: boolean, timestampMs: number | null, events: Array<Record<string, unknown>>, conflict: boolean, nativeGeneration?: unknown}} CodexResponseLedger */
/**
 * @typedef {object} CodexTurnLedger
 * @property {string} threadId
 * @property {string} turnId
 * @property {CodexRequestLedger[]} requests
 * @property {CodexResponseLedger[]} responses
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

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function generationValues(generation, reportedOutputTokens, reportedDurationMs) {
  if (!isRecord(generation)) return null;
  try {
    if (positiveInteger(generation.outputTokens) && generation.outputTokens > reportedOutputTokens) return null;
    if (
      positiveInteger(generation.durationMs) &&
      positiveInteger(reportedDurationMs) &&
      generation.durationMs > reportedDurationMs
    ) {
      return null;
    }
    const values = generationPerfValues(generation);
    if (!isRecord(values) || !positiveInteger(values.outputTokens) || !positiveInteger(values.durationMs)) return null;
    return values;
  } catch {
    return null;
  }
}

function selectGeneration(lookupGeneration, reportedOutputTokens, reportedDurationMs) {
  const lookup = generationValues(lookupGeneration, reportedOutputTokens, reportedDurationMs);
  if (lookup) return { generation: lookupGeneration, values: lookup };
  return null;
}

/**
 * @typedef {{homeId: string, threadId: string, turnId: string, responseId: string, model: string | null, outputTokens: unknown, reasoningOutputTokens: number | null}} CodexRequestTimingQuery
 * @typedef {(query: CodexRequestTimingQuery) => {state: string, durationMs: unknown, reportedOutputTokens: unknown, requestedModel: unknown, generation?: unknown}} CodexRequestTimingLookup
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
    window: "turn",
    timingKind: "request_e2e",
    tokenScope: "reported_output_includes_reasoning",
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
    methodVersion: "tps-v2",
  };
}

/**
 * @param {string} homeId
 * @param {CodexTurnLedger} turn
 * @param {CodexResponseLedger} response
 * @param {{lookupRequestTiming?: CodexRequestTimingLookup}} options
 */
function buildResponseCandidate(homeId, turn, response, options = {}) {
  const flags = new Set(
    (Array.isArray(turn.flags) ? turn.flags : []).filter((flag) => TURN_WIDE_RESPONSE_FLAGS.has(flag)),
  );
  if (response.conflict === true) flags.add("RECORD_CONFLICT");

  const timing = resolveCodexRequestTiming(homeId, turn, response, options.lookupRequestTiming);
  if (timing.state === "conflict") flags.add("RECORD_CONFLICT");
  if (timing.state === "invalid") flags.add("TIME_INVALID");

  const conflict = response.conflict === true || timing.state === "conflict";
  const selected = conflict
    ? null
    : (selectGeneration(response.nativeGeneration, response.outputTokens, null) ??
      selectGeneration(timing.generation, timing.reportedOutputTokens, timing.durationMs));
  if (!selected) flags.add("MISSING_DURATION");

  const events = Array.isArray(response.events) ? response.events : [];
  const timedItemCount = events.filter(
    (event) =>
      (event.outputKind === "text" &&
        positiveInteger(event.startedAtMs) &&
        positiveInteger(event.completedAtMs) &&
        event.completedAtMs > event.startedAtMs) ||
      (event.outputKind === "tool" && positiveInteger(event.timestampMs)),
  ).length;

  return {
    sourceKind: "codex",
    homeId,
    identity: [turn.threadId, turn.turnId, response.responseId],
    threadId: turn.threadId,
    turnId: turn.turnId,
    responseId: response.responseId,
    channel: "",
    agentKind: typeof turn.agentKind === "string" ? turn.agentKind : "unknown",
    agent: "",
    model: typeof turn.model === "string" ? turn.model : "",
    modelProvider: "",
    reasoningEffort: typeof turn.effort === "string" ? turn.effort : "",
    modelEvidence: turn.modelEvidence === "turn_context" ? "turn_context" : "",
    window: "request",
    timingKind: "generation",
    timingSource: selected ? "explicit" : "unknown",
    tokenScope: "non_reasoning_output",
    status: "completed",
    terminalVerified: true,
    tsMs: response.timestampMs,
    windowStartMs: null,
    windowEndMs: null,
    durationMs: selected?.values.durationMs ?? null,
    outputTokens: selected?.values.outputTokens ?? null,
    inputTokens: null,
    requestCount: 1,
    itemCount: events.length,
    timedItemCount,
    sampleFlags: [...flags],
    methodVersion: PERF_METHOD_VERSION,
    reportedOutputTokens: response.outputTokens,
    reportedDurationMs: timing.durationMs,
    reasoningOutputTokens: response.reasoningOutputTokens,
    reasoningOutputTokensKnown: response.reasoningOutputTokensKnown === true,
    generation: selected?.generation ?? null,
  };
}

function hasTurnEvidence(turn) {
  return (
    turn.requests.length > 0 ||
    (Array.isArray(turn.responses) && turn.responses.length > 0) ||
    turn.items.length > 0 ||
    turn.hasTaskComplete === true ||
    (turn.diagnostics?.unkeyableRequestCount ?? 0) > 0 ||
    (turn.diagnostics?.unkeyableItemCount ?? 0) > 0 ||
    turn.recordConflictCount > 0
  );
}

/**
 * Convert folded turns into one candidate per completed response. A missing
 * generation window does not remove the response or its model row.
 *
 * @param {string} homeId
 * @param {{turns: any[], stats?: Record<string, unknown>}} folded
 * @param {string[]} rolloutFiles
 * @param {{lookupRequestTiming?: CodexRequestTimingLookup}} [options]
 * @returns {{candidates: Array<Record<string, unknown>>, warnings: Array<{sourceKind: string, homeId: string, code: string, count: number}>, rolloutFiles: string[]}}
 */
export function buildCodexResponseCandidates(homeId, folded, rolloutFiles, options = {}) {
  if (typeof homeId !== "string" || homeId.trim() === "")
    throw new TypeError("Codex homeId must be a non-empty string");
  if (!isRecord(folded) || !Array.isArray(folded.turns)) throw new TypeError("Codex folded turns must be an array");
  if (!Array.isArray(rolloutFiles) || rolloutFiles.some((file) => typeof file !== "string" || file === "")) {
    throw new TypeError("Codex rolloutFiles must be an array of paths");
  }

  const candidates = [];
  let unkeyableTurns = 0;
  for (const turn of folded.turns) {
    if (!isRecord(turn) || !Array.isArray(turn.responses)) {
      throw new TypeError("Each Codex turn must contain a response array");
    }
    if (turn.responses.length === 0) continue;
    if (!validIdentityPart(turn.threadId) || !validIdentityPart(turn.turnId)) {
      unkeyableTurns += 1;
      continue;
    }
    for (const response of turn.responses) {
      if (!isRecord(response) || !validIdentityPart(response.responseId)) {
        unkeyableTurns += 1;
        continue;
      }
      candidates.push(buildResponseCandidate(homeId, turn, response, options));
    }
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
