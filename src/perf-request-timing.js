/**
 * Normalize and merge request timing evidence without authenticating its
 * producer. Shape validity does not imply that an origin passed source review.
 */

const INVALID_INPUT = "REQUEST_TIMING_INVALID_INPUT";
const GENERATION_TIMING_KINDS = new Set(["first_last_output", "first_output_response_end", "explicit"]);
const GENERATION_PRIORITY = Object.freeze({
  first_last_output: 3,
  explicit: 2,
  first_output_response_end: 1,
});

/**
 * @typedef {object} GenerationTiming
 * @property {number} outputTokens
 * @property {number} durationMs
 * @property {number} startOutputTokens
 * @property {"first_last_output" | "first_output_response_end" | "explicit"} timingKind
 */

/**
 * @typedef {object} RequestTimingEvidence
 * @property {1 | 2} schemaVersion
 * @property {string} evidenceOrigin
 * @property {string} responseId
 * @property {string} requestedModel
 * @property {number} reportedOutputTokens
 * @property {number} durationMs
 * @property {"completed"} status
 * @property {number | null} completedAtMs
 * @property {GenerationTiming | null} [generation]
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
 * @returns {GenerationTiming | null}
 */
export function normalizeGenerationTiming(raw) {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) throw invalidInput("generation must be null or an object");
  if (!isNonNegativeSafeInteger(raw.outputTokens)) {
    throw invalidInput("generation.outputTokens must be a non-negative safe integer");
  }
  if (typeof raw.durationMs !== "number" || !Number.isSafeInteger(raw.durationMs) || raw.durationMs <= 0) {
    throw invalidInput("generation.durationMs must be a positive safe integer");
  }
  if (!isNonNegativeSafeInteger(raw.startOutputTokens)) {
    throw invalidInput("generation.startOutputTokens must be a non-negative safe integer");
  }
  if (raw.startOutputTokens > raw.outputTokens) {
    throw invalidInput("generation.startOutputTokens must not exceed generation.outputTokens");
  }
  if (typeof raw.timingKind !== "string" || !GENERATION_TIMING_KINDS.has(raw.timingKind)) {
    throw invalidInput("generation.timingKind is invalid");
  }
  return {
    outputTokens: raw.outputTokens,
    durationMs: raw.durationMs,
    startOutputTokens: raw.startOutputTokens,
    timingKind: /** @type {GenerationTiming["timingKind"]} */ (raw.timingKind),
  };
}

/**
 * Check non-reasoning output before deducting tokens already present at the start.
 *
 * @param {GenerationTiming | null | undefined} generation
 * @param {number} reportedOutputTokens
 * @param {number | null | undefined} reasoningOutputTokens
 */
export function generationMatchesKnownReasoning(generation, reportedOutputTokens, reasoningOutputTokens) {
  if (generation === null || generation === undefined || !isNonNegativeSafeInteger(reasoningOutputTokens)) {
    return true;
  }
  return generation.outputTokens === reportedOutputTokens - reasoningOutputTokens;
}

/**
 * Return the net non-reasoning output count and generation duration. A missing
 * generation window and a boundary with no net output both produce null.
 *
 * @param {unknown} raw
 * @returns {{outputTokens: number, durationMs: number} | null}
 */
export function generationPerfValues(raw) {
  const generation = normalizeGenerationTiming(raw);
  if (generation === null || generation.outputTokens <= generation.startOutputTokens) return null;
  return {
    outputTokens: generation.outputTokens - generation.startOutputTokens,
    durationMs: generation.durationMs,
  };
}

/**
 * @param {unknown} raw
 * @returns {RequestTimingEvidence}
 */
export function normalizeRequestTimingEvidence(raw) {
  if (!isRecord(raw)) throw invalidInput("Timing evidence must be an object");
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2) {
    throw invalidInput("schemaVersion must be 1 or 2");
  }
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

  const common = {
    evidenceOrigin: requiredString(raw.evidenceOrigin, "evidenceOrigin"),
    responseId: requiredString(raw.responseId, "responseId"),
    requestedModel: requiredString(raw.requestedModel, "requestedModel"),
    reportedOutputTokens: raw.reportedOutputTokens,
    durationMs: raw.durationMs,
    status: /** @type {"completed"} */ ("completed"),
    completedAtMs: /** @type {number | null} */ (raw.completedAtMs),
  };
  if (raw.schemaVersion === 1) {
    if (Object.hasOwn(raw, "generation")) {
      throw invalidInput("schemaVersion 1 evidence cannot contain generation");
    }
    return { schemaVersion: 1, ...common };
  }

  const generation = normalizeGenerationTiming(raw.generation);
  if (generation !== null && generation.outputTokens > raw.reportedOutputTokens) {
    throw invalidInput("generation.outputTokens must not exceed reportedOutputTokens");
  }
  if (generation !== null && generation.durationMs > raw.durationMs) {
    throw invalidInput("generation.durationMs must not exceed durationMs");
  }
  return { schemaVersion: 2, ...common, generation };
}

function generationRank(record) {
  return record.generation === undefined || record.generation === null
    ? 0
    : GENERATION_PRIORITY[record.generation.timingKind];
}

function preferredEvidence(left, right) {
  const rankDelta = generationRank(right) - generationRank(left);
  if (rankDelta !== 0) return rankDelta > 0 ? right : left;
  const schemaDelta = right.schemaVersion - left.schemaVersion;
  if (schemaDelta !== 0) return schemaDelta > 0 ? right : left;
  return left.evidenceOrigin <= right.evidenceOrigin ? left : right;
}

/**
 * Merge observations for one response identity. A new origin, schema field, or
 * more precise generation window fills the same fact. Counts that describe the
 * same reported output remain normative; conflicts within one origin remain
 * conflicts even when their generation windows differ.
 *
 * @param {unknown[]} records
 * @returns {{state: "missing" | "available" | "conflict", evidence: RequestTimingEvidence | null}}
 */
export function mergeRequestTimingEvidence(records) {
  if (!Array.isArray(records)) throw invalidInput("Timing evidence records must be an array");
  if (records.length === 0) return { state: "missing", evidence: null };

  const normalized = records.map(normalizeRequestTimingEvidence);
  const first = normalized[0];
  const generationCounts = new Set(
    normalized.map((record) => record.generation?.outputTokens).filter((value) => value !== undefined),
  );
  if (generationCounts.size > 1) return { state: "conflict", evidence: null };

  const byOrigin = new Map();
  for (const record of normalized) {
    if (record.responseId !== first.responseId || record.requestedModel !== first.requestedModel) {
      return { state: "conflict", evidence: null };
    }
    if (record.reportedOutputTokens !== first.reportedOutputTokens) {
      return { state: "conflict", evidence: null };
    }

    let origin = byOrigin.get(record.evidenceOrigin);
    if (origin === undefined) {
      origin = { durationMs: record.durationMs, completedAtMs: record.completedAtMs, generations: new Map() };
      byOrigin.set(record.evidenceOrigin, origin);
    } else if (origin.durationMs !== record.durationMs || origin.completedAtMs !== record.completedAtMs) {
      return { state: "conflict", evidence: null };
    }
    if (record.generation === null || record.generation === undefined) {
      continue;
    }
    const peerGeneration = origin.generations.get(record.generation.timingKind);
    if (peerGeneration === undefined) {
      origin.generations.set(record.generation.timingKind, record.generation);
    } else if (
      peerGeneration.durationMs !== record.generation.durationMs ||
      peerGeneration.startOutputTokens !== record.generation.startOutputTokens
    ) {
      return { state: "conflict", evidence: null };
    }
  }

  let preferred = normalized[0];
  for (let index = 1; index < normalized.length; index += 1) {
    preferred = preferredEvidence(preferred, normalized[index]);
  }
  return { state: "available", evidence: preferred };
}
