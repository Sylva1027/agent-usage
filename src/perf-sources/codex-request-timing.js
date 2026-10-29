/** Resolve complete per-request timing for one deduplicated Codex turn ledger. */

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @returns {value is number} */
function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** @returns {value is number} */
function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function result(state, durationMs, timedRequestCount, requestCount) {
  return { state, durationMs, timedRequestCount, requestCount };
}

/**
 * Resolve one response without imposing the legacy whole-turn completeness
 * rule. Raw output and E2E duration remain available for reconciliation; the
 * v3 generation window is optional and is validated by the caller.
 *
 * @param {string} homeId
 * @param {{threadId: string, turnId: string, model: string | null}} turn
 * @param {{responseId: string, outputTokens: unknown, reasoningOutputTokensKnown?: boolean, reasoningOutputTokens?: number | null}} request
 * @param {(query: {homeId: string, threadId: string, turnId: string, responseId: string, model: string | null, outputTokens: unknown, reasoningOutputTokens: number | null}) => Record<string, unknown>} [lookupRequestTiming]
 */
export function resolveCodexRequestTiming(homeId, turn, request, lookupRequestTiming) {
  if (typeof homeId !== "string" || homeId.trim() === "")
    throw new TypeError("Codex homeId must be a non-empty string");
  if (!isRecord(turn)) throw new TypeError("Codex turn must be an object");
  if (!isRecord(request) || typeof request.responseId !== "string" || request.responseId === "") {
    throw new TypeError("Codex request must contain a responseId");
  }
  const missing = {
    state: "missing",
    durationMs: null,
    reportedOutputTokens: null,
    requestedModel: null,
    generation: null,
  };
  if (typeof lookupRequestTiming !== "function") return missing;

  const timing = lookupRequestTiming({
    homeId,
    threadId: turn.threadId,
    turnId: turn.turnId,
    responseId: request.responseId,
    model: turn.model,
    outputTokens: request.outputTokens,
    reasoningOutputTokens:
      request.reasoningOutputTokensKnown === true && isNonNegativeSafeInteger(request.reasoningOutputTokens)
        ? request.reasoningOutputTokens
        : null,
  });
  if (!isRecord(timing)) return missing;
  if (timing.state === "conflict") {
    return {
      state: "conflict",
      durationMs: timing.durationMs ?? null,
      reportedOutputTokens: timing.reportedOutputTokens ?? null,
      requestedModel: timing.requestedModel ?? null,
      generation: null,
    };
  }
  if (timing.state !== "available") {
    return {
      state: timing.state === "invalid" ? "invalid" : "missing",
      durationMs: timing.durationMs ?? null,
      reportedOutputTokens: timing.reportedOutputTokens ?? null,
      requestedModel: timing.requestedModel ?? null,
      generation: null,
    };
  }

  const modelMatches = typeof turn.model === "string" && turn.model !== "" && timing.requestedModel === turn.model;
  const outputMatches =
    isNonNegativeSafeInteger(request.outputTokens) && timing.reportedOutputTokens === request.outputTokens;
  return {
    state: modelMatches && outputMatches ? "available" : "conflict",
    durationMs: timing.durationMs ?? null,
    reportedOutputTokens: timing.reportedOutputTokens ?? null,
    requestedModel: timing.requestedModel ?? null,
    generation: isRecord(timing.generation) ? timing.generation : null,
  };
}

/**
 * @param {string} homeId
 * @param {{threadId: string, turnId: string, model: string | null, requests: Array<Record<string, unknown>>, requestSetComplete?: boolean}} turn
 * @param {(query: {homeId: string, threadId: string, turnId: string, responseId: string, model: string | null, outputTokens: unknown}) => {state: string, durationMs: unknown, reportedOutputTokens: unknown, requestedModel: unknown}} [lookupRequestTiming]
 * @returns {{state: "complete" | "missing" | "conflict" | "invalid", durationMs: number | null, timedRequestCount: number, requestCount: number}}
 */
export function resolveCodexTurnRequestTiming(homeId, turn, lookupRequestTiming) {
  if (typeof homeId !== "string" || homeId.trim() === "")
    throw new TypeError("Codex homeId must be a non-empty string");
  if (!isRecord(turn) || !Array.isArray(turn.requests)) throw new TypeError("Codex turn must contain a request array");

  const requests = turn.requests;
  const requestIds = new Set();
  let conflict = false;
  let invalid = false;
  let missing = requests.length === 0 || turn.requestSetComplete === false;
  let timedRequestCount = 0;
  let durationMs = 0;

  for (const request of requests) {
    if (!isRecord(request) || typeof request.responseId !== "string" || request.responseId === "") {
      conflict = true;
      continue;
    }
    if (requestIds.has(request.responseId)) conflict = true;
    else requestIds.add(request.responseId);

    if (typeof lookupRequestTiming !== "function") {
      missing = true;
      continue;
    }

    const timing = lookupRequestTiming({
      homeId,
      threadId: turn.threadId,
      turnId: turn.turnId,
      responseId: request.responseId,
      model: turn.model,
      outputTokens: request.outputTokens,
    });
    if (!isRecord(timing)) {
      missing = true;
      continue;
    }
    if (timing.state === "conflict") {
      conflict = true;
      continue;
    }
    if (timing.state !== "available") {
      missing = true;
      continue;
    }

    let matched = true;
    if (typeof turn.model !== "string" || turn.model === "" || timing.requestedModel !== turn.model) {
      conflict = true;
      matched = false;
    }
    if (!isNonNegativeSafeInteger(request.outputTokens) || timing.reportedOutputTokens !== request.outputTokens) {
      conflict = true;
      matched = false;
    }
    const requestDurationMs = isPositiveSafeInteger(timing.durationMs) ? timing.durationMs : null;
    if (requestDurationMs === null) {
      invalid = true;
      matched = false;
    }
    if (!matched || requestDurationMs === null) continue;

    timedRequestCount += 1;
    const sum = durationMs + requestDurationMs;
    if (!Number.isSafeInteger(sum)) invalid = true;
    else durationMs = sum;
  }

  if (conflict) return result("conflict", null, timedRequestCount, requests.length);
  if (invalid) return result("invalid", null, timedRequestCount, requests.length);
  if (missing) return result("missing", null, timedRequestCount, requests.length);
  return result("complete", durationMs, timedRequestCount, requests.length);
}
