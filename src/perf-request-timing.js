/**
 * Normalize and merge request timing evidence without authenticating its
 * producer. Shape validity does not imply that an origin passed source review.
 */

const INVALID_INPUT = "REQUEST_TIMING_INVALID_INPUT";

/**
 * @typedef {object} RequestTimingEvidence
 * @property {1} schemaVersion
 * @property {string} evidenceOrigin
 * @property {string} responseId
 * @property {string} requestedModel
 * @property {number} reportedOutputTokens
 * @property {number} durationMs
 * @property {"completed"} status
 * @property {number | null} completedAtMs
 */

function invalidInput(message) {
  return Object.assign(new Error(message), { code: INVALID_INPUT });
}

/** @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @returns {value is number} */
function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidInput(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * @param {unknown} raw
 * @returns {RequestTimingEvidence}
 */
export function normalizeRequestTimingEvidence(raw) {
  if (!isRecord(raw)) throw invalidInput("Timing evidence must be an object");
  if (raw.schemaVersion !== 1) throw invalidInput("schemaVersion must be 1");
  if (!isNonNegativeSafeInteger(raw.reportedOutputTokens)) {
    throw invalidInput("reportedOutputTokens must be a non-negative safe integer");
  }
  if (typeof raw.durationMs !== "number" || !Number.isSafeInteger(raw.durationMs) || raw.durationMs <= 0) {
    throw invalidInput("durationMs must be a positive safe integer");
  }
  if (raw.status !== "completed") throw invalidInput("status must be completed");
  if (raw.completedAtMs !== null && !isNonNegativeSafeInteger(raw.completedAtMs)) {
    throw invalidInput("completedAtMs must be null or a non-negative safe integer");
  }

  return {
    schemaVersion: 1,
    evidenceOrigin: requiredString(raw.evidenceOrigin, "evidenceOrigin"),
    responseId: requiredString(raw.responseId, "responseId"),
    requestedModel: requiredString(raw.requestedModel, "requestedModel"),
    reportedOutputTokens: raw.reportedOutputTokens,
    durationMs: raw.durationMs,
    status: "completed",
    completedAtMs: /** @type {number | null} */ (raw.completedAtMs),
  };
}

function sameEvidence(left, right) {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.evidenceOrigin === right.evidenceOrigin &&
    left.responseId === right.responseId &&
    left.requestedModel === right.requestedModel &&
    left.reportedOutputTokens === right.reportedOutputTokens &&
    left.durationMs === right.durationMs &&
    left.status === right.status &&
    left.completedAtMs === right.completedAtMs
  );
}

/**
 * Merge observations for one response identity. Different origins or any
 * differing normative field are a conflict; no observation is preferred.
 *
 * @param {unknown[]} records
 * @returns {{state: "missing" | "available" | "conflict", evidence: RequestTimingEvidence | null}}
 */
export function mergeRequestTimingEvidence(records) {
  if (!Array.isArray(records)) throw invalidInput("Timing evidence records must be an array");
  if (records.length === 0) return { state: "missing", evidence: null };

  const normalized = records.map(normalizeRequestTimingEvidence);
  const first = normalized[0];
  for (let index = 1; index < normalized.length; index += 1) {
    if (!sameEvidence(first, normalized[index])) return { state: "conflict", evidence: null };
  }
  return { state: "available", evidence: first };
}
