/**
 * TPS kernel: candidate identity, persistent flags and normalization (M1.1).
 *
 * Authority: `docs/plans/2026-10-03-model-latency-throughput-plan.md` §17.1 (identity and
 * per-source values), §17.4 (flag bits), §17.5 (coverage) and the frozen
 * `docs/validation/2026-10-04-perf-metrics/20261004T035100/source-contract.md`.
 *
 * This module is a pure-function kernel: it reads no files, no SQLite and no DOM.
 */

/** @typedef {import("./usage-types.js").PerfSample} PerfSample */

/**
 * Persistent method version (plan §4). An unrecognized version is never silently
 * rewritten: normalization keeps the supplied value and reports a warning.
 */
export const PERF_METHOD_VERSION = "tps-v4";
export const PERF_SUPPORTED_METHOD_VERSIONS = Object.freeze(["tps-v1", "tps-v2", "tps-v3", PERF_METHOD_VERSION]);

/** v3 and v4 share response identities and the non-reasoning generation contract. */
export function isGenerationPerfMethod(version) {
  return version === "tps-v3" || version === PERF_METHOD_VERSION;
}

/** Groups with fewer samples are shown but not ranked (plan §17.6). */
export const PERF_MIN_SAMPLES = 20;

/** `duration_ms` above this value is a hint only; the sample still counts (plan §17.4 bit 4). */
export const PERF_LONG_WINDOW_MS = 300_000;

/**
 * Epoch-millisecond timestamps are at least this large. A smaller positive value is a
 * second-unit timestamp and must be converted before use (plan §3; contract §3-7, X-04).
 * Contract ruling T: this threshold belongs to the method metadata and may be updated
 * there (the same way §17.5 handles `eraCutoffMs`); it is not a permanent boundary. A
 * value below it is diagnosed as `timestamp_unit_unsupported` and is **never** silently
 * multiplied by 1000.
 */
export const PERF_EPOCH_MS_MIN = 1_000_000_000_000;

/**
 * The full §17.4 bit table, indexed by bit number. Bits 2 and 3 are reserved: the old
 * `GEN_BELOW_FIRST_TOKEN` and `CROSS_PERIOD` names must never be set again, so their
 * slots exist but carry no settable name.
 * @type {readonly (string | null)[]}
 */
export const PERF_FLAG_BITS = Object.freeze([
  "OUTPUT_ZERO", // 0 true zero output; diagnosed, never sampled
  "DURATION_NONPOSITIVE", // 1 true zero/negative duration; diagnosed, never sampled
  null, // 2 reserved: old GEN_BELOW_FIRST_TOKEN, must never be set
  null, // 3 reserved: old CROSS_PERIOD moved to query-time crossPeriod
  "LONG_WINDOW", // 4 duration_ms > PERF_LONG_WINDOW_MS; hint only, still sampled
  "MULTI_REQUEST_TURN", // 5 Codex turn with more than one deduplicated request; hint only
  "PARTIAL_ITEM_SPAN", // 6 Codex turn with a target item missing a usable span; dropped
  "MISSING_DURATION", // 7 denominator missing; dropped
  "MISSING_OUTPUT", // 8 numerator missing; dropped
  "MODEL_AMBIGUOUS", // 9 per-turn model conflict; dropped
  "TERMINAL_UNVERIFIED", // 10 no terminal evidence; dropped
  "SOURCE_FILTERED", // 11 source-side failure/cancel/retry filter; dropped
  "RECORD_CONFLICT", // 12 same-identity count/time/ownership conflict; dropped
  "OVERLAPPING_ITEM_SPAN", // 13 target item spans overlap; dropped
  "TIME_INVALID", // 14 non-finite, contradictory or unsupported-unit time; dropped
  "TIME_UNPLACED", // 15 ts_ms missing; global placement diagnostic, not in eligible
  "METHOD_ESTIMATE", // 16 historical/explicit estimate hint; still sampled, never rank-admitted
  "TOKEN_INVALID", // 17 negative, non-integer or non-finite output; dropped
]);

/** Bit numbers that exist in §17.4 but can never be set. */
export const PERF_RESERVED_FLAG_BITS = Object.freeze([2, 3]);

/** Cancelled legacy flag names; neither may ever be set again (plan §17.4 bits 2/3). */
export const PERF_FORBIDDEN_FLAG_NAMES = Object.freeze(["GEN_BELOW_FIRST_TOKEN", "CROSS_PERIOD"]);

/**
 * Settable flag names in bit order: exactly the 16 valid §17.4 names.
 * @type {readonly string[]}
 */
export const PERF_FLAG_NAMES = Object.freeze(
  PERF_FLAG_BITS.filter((name) => {
    return name !== null;
  }),
);

/**
 * Name -> bit for every settable flag. Bits 2/3 have no entry.
 * @type {Readonly<Record<string, number>>}
 */
export const PERF_FLAGS = Object.freeze(
  PERF_FLAG_BITS.reduce(
    (table, name, bit) => {
      if (name !== null) table[name] = bit;
      return table;
    },
    /** @type {Record<string, number>} */ ({}),
  ),
);

/**
 * Per-source window/timing/token semantics frozen by plan §17.1 and contract §1.
 * Normalization is the enforcement point: a reader-supplied value never overrides
 * these. Codex v2 sums complete request durations within one turn while retaining
 * turn-level sampling.
 * @type {Readonly<Record<string, { window: string, timingKind: string, tokenScope: string }>>}
 */
const PERF_LEGACY_SOURCE_SEMANTICS = Object.freeze({
  zcode: Object.freeze({ window: "request", timingKind: "request_e2e", tokenScope: "reported_output_unspecified" }),
  dsh: Object.freeze({ window: "step", timingKind: "request_e2e", tokenScope: "reported_output_unspecified" }),
  opencode: Object.freeze({ window: "message", timingKind: "request_e2e", tokenScope: "visible_plus_reasoning" }),
  codex: Object.freeze({
    window: "turn",
    timingKind: "request_e2e",
    tokenScope: "reported_output_includes_reasoning",
  }),
  // WorkBuddy：一次模型响应 = 一个 request 窗口，时长取自 trace 里 `generation` span 的
  // `duration`（**直接观测值**，不是时间戳相减）⇒ `timingKind` 用 `request_e2e`，
  // reader 的 `timingSource` 必须是 `explicit`。`outputTokens` 含 reasoning。
  workbuddy: Object.freeze({
    window: "request",
    timingKind: "request_e2e",
    tokenScope: "reported_output_includes_reasoning",
  }),
  claude: Object.freeze({
    window: "request",
    timingKind: "request_e2e",
    tokenScope: "reported_output_includes_reasoning",
  }),
});

export const PERF_SOURCE_SEMANTICS = Object.freeze(
  Object.fromEntries(
    Object.keys(PERF_LEGACY_SOURCE_SEMANTICS).map((kind) => [
      kind,
      Object.freeze({ window: "request", timingKind: "generation", tokenScope: "non_reasoning_output" }),
    ]),
  ),
);

const DSH_ALL_GENERATION_PROVIDERS = new Set(["deepseek-account", "deepseek-official"]);
const DSH_ALL_GENERATION_SEMANTICS = Object.freeze({
  window: "request",
  timingKind: "generation",
  tokenScope: "all_generated_output",
});

function generationSourceSemantics(sourceKind, modelProvider, methodVersion = PERF_METHOD_VERSION) {
  return methodVersion === PERF_METHOD_VERSION &&
    sourceKind === "dsh" &&
    DSH_ALL_GENERATION_PROVIDERS.has(modelProvider)
    ? DSH_ALL_GENERATION_SEMANTICS
    : PERF_SOURCE_SEMANTICS[sourceKind];
}

function hasGenerationPerfSemantics(sample) {
  const semantics = generationSourceSemantics(sample.sourceKind, sample.modelProvider);
  return (
    isGenerationPerfMethod(sample.methodVersion) &&
    semantics !== undefined &&
    sample.window === semantics.window &&
    sample.timingKind === semantics.timingKind &&
    sample.tokenScope === semantics.tokenScope
  );
}

/** Canonical perf source kinds. Anything else is `unsupported`. */
export const PERF_SOURCE_KINDS = Object.freeze(["zcode", "dsh", "opencode", "codex", "workbuddy", "claude"]);

/** The only accepted §17.1 `status` values. */
export const PERF_STATUSES = Object.freeze(["completed", "failed", "cancelled", "in_progress", "unverified"]);

/** Literal source statuses mapped onto the §17.1 enum; anything else warns and stays unverified. */
export const PERF_STATUS_ALIASES = Object.freeze({ error: "failed", canceled: "cancelled" });

/** Accepted `agent_kind` values (plan §4). */
export const PERF_AGENT_KINDS = Object.freeze(["main", "subagent", "unknown"]);

/** Accepted duration provenance values for `timingSource`. */
export const PERF_TIMING_SOURCES = Object.freeze(["explicit", "timestamp_fallback", "mixed", "unknown"]);

/**
 * M1-local diagnostic codes returned by {@link normalizePerfSample}. Only
 * `UNKEYABLE_RECORD` already exists in the contract's `sourceWarnings` list; the other
 * codes are M1-side diagnostics and must not be written into `meta.sourceWarnings`
 * until the single contract writer ratifies them.
 */
export const PERF_NORMALIZE_WARNING_CODES = Object.freeze([
  "UNKEYABLE_RECORD",
  "UNSUPPORTED_SOURCE_KIND",
  "UNRECOGNIZED_STATUS",
  "UNRECOGNIZED_METHOD_VERSION",
  "UNRECOGNIZED_PROVENANCE",
  "UNRECOGNIZED_FLAG_NAME",
  "UNRECOGNIZED_AGENT_KIND",
  "SOURCE_SEMANTICS_MISMATCH",
]);

/**
 * A structural violation of the persistent flag table (reserved bit, forbidden legacy
 * name, or a malformed mask). It is thrown instead of degraded, because a reserved bit
 * can only ever come from a producer bug.
 */
export class PerfFlagError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "PerfFlagError";
    /** @type {string} */
    this.code = code;
  }
}

/**
 * Bit number of a settable flag name, or `undefined` when the name has no bit.
 * @param {unknown} name
 * @returns {number | undefined}
 */
export function perfFlagBit(name) {
  if (typeof name !== "string") return undefined;
  return PERF_FLAGS[name.trim()];
}

/**
 * Name of a flag bit. Reserved and out-of-range bits return `null`; they have no name.
 * @param {unknown} bit
 * @returns {string | null}
 */
export function perfFlagName(bit) {
  if (typeof bit !== "number" || !Number.isSafeInteger(bit) || bit < 0 || bit >= PERF_FLAG_BITS.length) return null;
  return PERF_FLAG_BITS[bit];
}

/**
 * Fail-closed guard for the only sanctioned way to set a bit.
 * @param {unknown} bit
 * @returns {number}
 */
export function assertSettablePerfFlagBit(bit) {
  if (typeof bit !== "number" || !Number.isSafeInteger(bit) || bit < 0 || bit >= PERF_FLAG_BITS.length) {
    throw new PerfFlagError("UNKNOWN_FLAG_BIT", `flag bit ${String(bit)} is outside the §17.4 table`);
  }
  if (PERF_RESERVED_FLAG_BITS.includes(bit)) {
    throw new PerfFlagError("RESERVED_FLAG_BIT", `flag bit ${bit} is reserved by §17.4 and must never be set`);
  }
  return bit;
}

/**
 * Mask of the bits that exist in the §17.4 table (`0..17`), including the reserved ones.
 * JS bitwise operators first coerce their operands through `ToInt32`/`ToUint32`, so
 * `2**32` silently becomes `0` — every mask must be validated against this constant
 * **before** any bitwise operation, never after.
 */
const PERF_FLAG_TABLE_MASK = (1 << PERF_FLAG_BITS.length) - 1;

/** Largest value bitwise-coercible into a JS flag set without `ToInt32` wrapping. */
const PERF_FLAG_MAX_MASK = 2 ** 31 - 1;

/**
 * Reject any mask that is not a non-negative safe integer confined to the §17.4 table.
 * This is the single validation gate every mask-taking entry point must pass through;
 * reserved bits are reported separately by {@link assertNoReservedFlagBits}.
 *
 * The range check must happen **before** any bitwise operation. `ToInt32` wraps modulo
 * `2**32`, so `2**32` becomes `0` and `2**32 | (1 << 0)` quietly yields `1` — a
 * `(mask | 0) < 0`-style probe is not enough, because `ToInt32(2**32)` is `0`, not
 * negative.
 * @param {unknown} mask
 * @returns {number}
 */
export function assertPerfFlagMaskInTable(mask) {
  if (typeof mask !== "number" || !Number.isSafeInteger(mask) || mask < 0) {
    throw new PerfFlagError("INVALID_FLAG_MASK", `perf flag mask must be a non-negative safe integer`);
  }
  if (mask > PERF_FLAG_MAX_MASK) {
    throw new PerfFlagError(
      "UNKNOWN_FLAG_BIT",
      `perf flag mask ${mask} is outside the 32-bit flag range of the §17.4 table`,
    );
  }
  if ((mask & ~PERF_FLAG_TABLE_MASK) !== 0) {
    throw new PerfFlagError(
      "UNKNOWN_FLAG_BIT",
      `perf flag mask ${mask} has bits outside the §17.4 table (allowed bits 0..${PERF_FLAG_BITS.length - 1})`,
    );
  }
  return mask;
}

/**
 * Throw when a mask has any reserved bit set. Reserved bits are structurally
 * unreachable through the name table, so a set reserved bit is always a producer bug.
 * Out-of-table bits (≥18) are rejected first, because a bitwise test on them would be
 * silently truncated by `ToInt32`.
 * @param {unknown} mask
 * @returns {number}
 */
export function assertNoReservedFlagBits(mask) {
  const safeMask = assertPerfFlagMaskInTable(mask);
  const reservedMask = PERF_RESERVED_FLAG_BITS.reduce((acc, bit) => acc | (1 << bit), 0);
  if ((safeMask & reservedMask) !== 0) {
    throw new PerfFlagError(
      "RESERVED_FLAG_BIT",
      `flag bits ${PERF_RESERVED_FLAG_BITS.join(",")} are reserved by §17.4 and must never be set`,
    );
  }
  return safeMask;
}

/**
 * Set one flag bit by name. Unknown names and the cancelled legacy names throw. The
 * incoming mask is validated first, so an out-of-table bit can never be silently lost to
 * `ToInt32` truncation.
 * @param {number} mask
 * @param {string} name
 * @returns {number}
 */
export function setPerfFlag(mask, name) {
  assertNoReservedFlagBits(mask);
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (PERF_FORBIDDEN_FLAG_NAMES.includes(trimmed)) {
    throw new PerfFlagError("RESERVED_FLAG_BIT", `flag name ${trimmed} was cancelled by §17.4 and must never be set`);
  }
  const bit = perfFlagBit(trimmed);
  if (bit === undefined) throw new PerfFlagError("UNKNOWN_FLAG_NAME", `unknown perf flag name: ${String(name)}`);
  assertSettablePerfFlagBit(bit);
  return mask | (1 << bit);
}

/**
 * Names of every set flag bit, in bit order. The mask is validated first: reporting `[]`
 * for a mask that merely has out-of-table bits would hide a producer bug.
 * @param {number} mask
 * @returns {string[]}
 */
export function perfFlagNamesOf(mask) {
  assertNoReservedFlagBits(mask);
  /** @type {string[]} */
  const names = [];
  for (const [bit, name] of PERF_FLAG_BITS.entries()) {
    if (name !== null && (mask & (1 << bit)) !== 0) names.push(name);
  }
  return names;
}

/**
 * Map a discovered source kind onto the canonical perf source kind. `main`, `jetbrains`,
 * `extra` and `codex` are all the same Codex source family (plan §4); `project-log` and
 * anything unknown are `unsupported`. The input value is never mutated: raw kinds stay
 * available to source discovery and quota eligibility.
 * @param {unknown} kind
 * @returns {"zcode" | "dsh" | "opencode" | "codex" | "workbuddy" | "claude" | "unsupported"}
 */
export function canonicalPerfSourceKind(kind) {
  const value = typeof kind === "string" ? kind.trim() : "";
  if (value === "main" || value === "jetbrains" || value === "extra" || value === "codex") return "codex";
  if (value === "zcode" || value === "dsh" || value === "opencode" || value === "workbuddy") return value;
  if (value === "claude") return "claude";
  return "unsupported";
}

/**
 * Normalize one identity part: non-empty trimmed string, or safe integer.
 * Trimmed identities keep their case, so `a1` and `A1` stay different (§17.1).
 * @param {unknown} part
 * @returns {string | number | null}
 */
function normalizeIdentityPart(part) {
  if (typeof part === "string") {
    const trimmed = part.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof part === "number") return Number.isSafeInteger(part) ? part : null;
  return null;
}

/**
 * Canonical JSON-array sample key: `[canonicalSourceKind, homeId, ...identity]`.
 *
 * The tuple is serialized as a JSON array, never joined with `:` or `#` (plan §4), so
 * `["a:b","c"]` and `["a","b:c"]` cannot collide, and `homeId` participates in the
 * identity so the same raw id in two homes cannot collide.
 *
 * Returns `null` when the record cannot form the stable identity of §17.1 (missing
 * source kind, missing home id, empty identity, or a non-string/non-safe-integer part).
 * A timestamp is never used as a substitute identity.
 * @param {unknown} sourceKind
 * @param {unknown} homeId
 * @param {...unknown} identity
 * @returns {string | null}
 */
export function perfSampleKey(sourceKind, homeId, ...identity) {
  const kind = canonicalPerfSourceKind(sourceKind);
  if (kind === "unsupported") return null;
  const home = normalizeIdentityPart(homeId);
  if (home === null || typeof home === "number") return null;
  if (identity.length === 0) return null;
  const parts = [];
  for (const part of identity) {
    const value = normalizeIdentityPart(part);
    if (value === null) return null;
    parts.push(value);
  }
  return JSON.stringify([kind, home, ...parts]);
}

/**
 * Group key of §17.2: canonical serialization of
 * `(source_kind, home_id, channel, agent_kind, agent, model, model_provider,
 * reasoning_effort, timing_kind, token_scope)`.
 *
 * `source_kind` is always present, so Codex samples can never share a group with the
 * request-level sources even if their other dimensions were identical. Unsupported
 * source kinds have no group. Unknown names are the empty string (plan §4).
 * @param {Partial<PerfSample> | null | undefined} sample
 * @returns {string | null}
 */
export function perfGroupKey(sample) {
  if (sample === null || typeof sample !== "object") return null;
  const kind = canonicalPerfSourceKind(sample.sourceKind);
  if (kind === "unsupported") return null;
  /** @param {unknown} value */
  const part = (value) => (typeof value === "string" ? value.trim() : "");
  return JSON.stringify([
    kind,
    part(sample.homeId),
    part(sample.channel),
    part(sample.agentKind),
    part(sample.agent),
    part(sample.model),
    part(sample.modelProvider),
    part(sample.reasoningEffort),
    part(sample.timingKind),
    part(sample.tokenScope),
  ]);
}

/** @param {unknown} value */
function trimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * @typedef {"missing" | "zero" | "positive" | "negative" | "not_integer" | "not_finite" | "unsafe" | "not_number"} PerfNumberState
 */

/**
 * Ordered numeric classification. Order matters and is fixed:
 * missing -> not a number -> non-finite (NaN/±Infinity) -> non-integer -> outside the
 * safe-integer range -> zero -> negative -> positive. `null` is "missing" and is never
 * folded into `0`.
 * @param {unknown} value
 * @returns {PerfNumberState}
 */
function classifyInteger(value) {
  if (value === null || value === undefined) return "missing";
  if (typeof value !== "number") return "not_number";
  if (Number.isNaN(value)) return "not_finite";
  if (!Number.isFinite(value)) return "not_finite";
  if (!Number.isInteger(value)) return "not_integer";
  if (value > Number.MAX_SAFE_INTEGER || value < -Number.MAX_SAFE_INTEGER) return "unsafe";
  if (value === 0) return "zero";
  if (value < 0) return "negative";
  return "positive";
}

/** Deterministic reason suffixes for the invalid numeric states. */
const PERF_NUMERIC_REASON_SUFFIX = Object.freeze({
  not_finite: "not_finite",
  not_integer: "not_integer",
  unsafe: "not_safe_integer",
  not_number: "not_a_number",
  negative: "negative",
  out_of_range: "out_of_range",
});

/**
 * @typedef {"missing" | "ok" | "unit_unsupported" | "out_of_range" | "not_integer" | "not_finite" | "unsafe" | "not_number"} PerfEpochState
 */

/**
 * Classify an absolute timestamp. A finite positive value below {@link PERF_EPOCH_MS_MIN}
 * is treated as a second-unit timestamp: the unit is unsupported until converted
 * (contract §3-7). Zero and negative values are out of range.
 * @param {unknown} value
 * @returns {PerfEpochState}
 */
function classifyEpochMs(value) {
  const state = classifyInteger(value);
  if (state === "missing") return "missing";
  if (state === "positive") {
    return /** @type {number} */ (value) >= PERF_EPOCH_MS_MIN ? "ok" : "unit_unsupported";
  }
  if (state === "zero" || state === "negative") return "out_of_range";
  return state;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function safeIntegerOrNull(value) {
  const state = classifyInteger(value);
  if (state === "zero" || state === "positive") return /** @type {number} */ (value);
  return null;
}

/**
 * @typedef {object} PerfSampleRaw
 * Reader-supplied candidate. `identity` (or the per-source identity fields) is the only
 * accepted source of a sample key; `sampleKey` is a validated fallback.
 * @property {unknown} [sourceKind]
 * @property {unknown} [homeId]
 * @property {unknown} [sampleKey]
 * @property {unknown} [identity]
 * @property {unknown} [rowId]
 * @property {unknown} [sessionId]
 * @property {unknown} [turn]
 * @property {unknown} [step]
 * @property {unknown} [threadId]
 * @property {unknown} [turnId]
 * @property {unknown} [databaseIdentity]
 * @property {unknown} [messageId]
 * @property {unknown} [sourcePath]
 * @property {unknown} [channel]
 * @property {unknown} [rejectedFlagNames]
 * @property {unknown} [agentKind]
 * @property {unknown} [agent]
 * @property {unknown} [turnKey]
 * @property {unknown} [model]
 * @property {unknown} [modelProvider]
 * @property {unknown} [reasoningEffort]
 * @property {unknown} [modelEvidence]
 * @property {unknown} [window]
 * @property {unknown} [timingKind]
 * @property {unknown} [timingSource]
 * @property {unknown} [tokenScope]
 * @property {unknown} [status]
 * @property {unknown} [terminalVerified]
 * @property {unknown} [inProgress]
 * @property {unknown} [cancelledByUser]
 * @property {unknown} [retryCount]
 * @property {unknown} [sourceFiltered]
 * @property {unknown} [filterReason]
 * @property {unknown} [tsMs]
 * @property {unknown} [startedAtMs]
 * @property {unknown} [completedAtMs]
 * @property {unknown} [windowStartMs]
 * @property {unknown} [windowEndMs]
 * @property {unknown} [durationMs]
 * @property {unknown} [outputTokens]
 * @property {unknown} [inputTokens]
 * @property {unknown} [requestCount]
 * @property {unknown} [itemCount]
 * @property {unknown} [timedItemCount]
 * @property {unknown} [sampleFlags]
 * @property {unknown} [flags]
 * @property {unknown} [partialItemSpan]
 * @property {unknown} [overlappingItemSpan]
 * @property {unknown} [modelAmbiguous]
 * @property {unknown} [recordConflict]
 * @property {unknown} [multiRequestTurn]
 * @property {unknown} [methodEstimate]
 * @property {unknown} [methodVersion]
 */

/** @typedef {{ sample: PerfSample | null, warningCode: string | null, warnings: string[] }} NormalizePerfSampleResult */

/**
 * Resolve the identity of a raw candidate in the order `identity` array ->
 * per-source identity fields -> validated precomputed `sampleKey`. There is no
 * timestamp fallback.
 * @param {string} sourceKind canonical source kind
 * @param {PerfSampleRaw} raw
 * @returns {string | null}
 */
function resolvePerfSampleKey(sourceKind, raw) {
  if (Array.isArray(raw.identity) && raw.identity.length > 0) {
    return perfSampleKey(sourceKind, raw.homeId, ...raw.identity);
  }
  if (sourceKind === "zcode") return perfSampleKey(sourceKind, raw.homeId, raw.rowId);
  if (sourceKind === "dsh") return perfSampleKey(sourceKind, raw.homeId, raw.sessionId, raw.turn, raw.step);
  if (sourceKind === "codex") return perfSampleKey(sourceKind, raw.homeId, raw.threadId, raw.turnId);
  if (sourceKind === "opencode") return perfSampleKey(sourceKind, raw.homeId, raw.databaseIdentity, raw.messageId);
  if (sourceKind === "workbuddy") return perfSampleKey(sourceKind, raw.homeId, raw.messageId);
  return null;
}

/**
 * Accept a precomputed key only when it is the canonical JSON array of §17.1: first
 * element is the canonical source kind, at least one identity column follows, all parts
 * are trimmed non-empty strings or safe integers. Anything else cannot be keyed.
 *
 * The key's home id (element 1) must also agree with the sample's own `homeId`, and a
 * key without any `homeId` to check against is rejected outright. Otherwise identity,
 * ownership (which drives `excludedHomeIds`) and grouping would each rest on a different
 * home, letting a record be deduplicated under one home while being grouped or excluded
 * under another. The comparison is done by **recomputing** the canonical key from the
 * declared home id, so trim/case rules can never drift between the two code paths.
 * @param {string} sourceKind
 * @param {unknown} value
 * @param {unknown} homeId
 * @returns {string | null}
 */
function validateProvidedSampleKey(sourceKind, value, homeId) {
  if (typeof value !== "string" || value.trim() === "") return null;
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(value.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length < 3 || parsed[0] !== sourceKind) return null;
  for (const part of parsed) {
    if (typeof part === "string") {
      if (part === "" || part !== part.trim()) return null;
    } else if (typeof part === "number") {
      if (!Number.isSafeInteger(part)) return null;
    } else {
      return null;
    }
  }
  // The declared homeId must exist and must reproduce the key's home column exactly.
  const declaredHome = normalizeIdentityPart(homeId);
  if (declaredHome === null || typeof declaredHome === "number") return null;
  const canonicalWithoutHome = perfSampleKey(sourceKind, declaredHome, ...parsed.slice(2));
  if (canonicalWithoutHome === null) return null;
  return canonicalWithoutHome === JSON.stringify(parsed) ? canonicalWithoutHome : null;
}

/**
 * Turn `sampleFlags`/`flags` into a bit mask. A name array, or an integer mask for
 * SQLite round-trips. Reserved bits and the cancelled legacy names throw; other unknown
 * names are reported and ignored.
 * @param {unknown} value
 * @param {string[]} warnings
 * @returns {number}
 */
function normalizeRawFlags(value, warnings) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") {
    assertNoReservedFlagBits(value);
    return value;
  }
  if (!Array.isArray(value)) {
    throw new PerfFlagError("INVALID_FLAG_MASK", "sampleFlags must be a flag-name array or an integer mask");
  }
  let mask = 0;
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new PerfFlagError("INVALID_FLAG_NAME", `flag name must be a string, received ${typeof entry}`);
    }
    const name = entry.trim();
    if (PERF_FORBIDDEN_FLAG_NAMES.includes(name)) {
      throw new PerfFlagError("RESERVED_FLAG_BIT", `flag name ${name} was cancelled by §17.4 and must never be set`);
    }
    if (perfFlagBit(name) === undefined) {
      if (!warnings.includes("UNRECOGNIZED_FLAG_NAME")) warnings.push("UNRECOGNIZED_FLAG_NAME");
      continue;
    }
    mask = setPerfFlag(mask, name);
  }
  return mask;
}

/**
 * Normalize one reader-supplied candidate into the canonical {@link PerfSample}.
 *
 * Guarantees enforced here (M1.1 acceptance):
 * - identity is the canonical JSON tuple; no stable identity at all returns
 *   `{ sample: null, warningCode: "UNKEYABLE_RECORD" }` and the caller must not count it
 *   in eligible;
 * - missing (`null`) and true zero are always different flags: `MISSING_OUTPUT` vs
 *   `OUTPUT_ZERO`, `MISSING_DURATION` vs `DURATION_NONPOSITIVE`;
 * - an empty status never becomes `completed`; only an explicit §17.1 status or
 *   explicit terminal evidence can;
 * - `timingKind`/`tokenScope`/`window` come from the canonical source kind, never from
 *   raw input;
 * - a candidate with a stable identity but no `ts_ms` is still returned, with
 *   `TIME_UNPLACED`;
 * - reserved flag bits (2/3) throw a {@link PerfFlagError}.
 *
 * Ruling S: `status` is taken from `raw.status` (or explicit terminal evidence). A state
 * synthesized from source-filter evidence is always both recorded in
 * `diagnosticReasonChain` as `status_synthesized_from_filter_evidence` and kept as the
 * dominant `diagnosticReason` when nothing more actionable outranks it, so it is never
 * silent.
 * @param {PerfSampleRaw} raw
 * @returns {NormalizePerfSampleResult}
 */
export function normalizePerfSample(raw) {
  if (raw === null || typeof raw !== "object") {
    return { sample: null, warningCode: "UNKEYABLE_RECORD", warnings: ["UNKEYABLE_RECORD"] };
  }
  const sourceKind = canonicalPerfSourceKind(raw.sourceKind);
  if (sourceKind === "unsupported") {
    return { sample: null, warningCode: "UNSUPPORTED_SOURCE_KIND", warnings: ["UNSUPPORTED_SOURCE_KIND"] };
  }
  const sampleKey =
    resolvePerfSampleKey(sourceKind, raw) ?? validateProvidedSampleKey(sourceKind, raw.sampleKey, raw.homeId);
  if (sampleKey === null) {
    return { sample: null, warningCode: "UNKEYABLE_RECORD", warnings: ["UNKEYABLE_RECORD"] };
  }
  const providedMethodVersion = trimmedString(raw.methodVersion);
  const methodVersion =
    providedMethodVersion ||
    (["request_e2e", "item_span_estimate"].includes(trimmedString(raw.timingKind)) ? "tps-v2" : PERF_METHOD_VERSION);

  /** @type {string[]} */
  const warnings = [];
  let flags = normalizeRawFlags(raw.sampleFlags ?? raw.flags, warnings);
  /** @type {string} */
  let reason = "";
  let reasonRank = Number.POSITIVE_INFINITY;
  /** Ruling S: set when the terminal state was derived from filter evidence, not read. */
  let statusSynthesized = false;
  /** Reasons that were considered; keeps derivations visible even when outranked. */
  const reasonChain = [];
  /**
   * Keep the most actionable reason: output (1) > duration (2) > time (3) > source
   * filter (4) > semantics (5) > status (6). Every reason is also retained in
   * `reasonChain`, so a derivation is never lost even when it is outranked.
   * @param {string} value
   * @param {number} rank
   */
  const setReason = (value, rank) => {
    reasonChain.push(value);
    if (rank < reasonRank) {
      reason = value;
      reasonRank = rank;
    }
  };
  const REASON_RANK = { output: 1, duration: 2, time: 3, filter: 4, semantics: 5, status: 6 };

  // --- output tokens (numerator): missing, zero, negative, non-integer, unsafe ---
  /** @type {number | null} */
  let outputTokens = null;
  const outputState = classifyInteger(raw.outputTokens);
  if (outputState === "missing") {
    flags = setPerfFlag(flags, "MISSING_OUTPUT");
    setReason("output_missing", REASON_RANK.output);
  } else if (outputState === "zero") {
    outputTokens = 0;
    flags = setPerfFlag(flags, "OUTPUT_ZERO");
    setReason("output_zero", REASON_RANK.output);
  } else if (outputState === "positive") {
    outputTokens = /** @type {number} */ (raw.outputTokens);
  } else {
    flags = setPerfFlag(flags, "TOKEN_INVALID");
    setReason(`output_${PERF_NUMERIC_REASON_SUFFIX[outputState]}`, REASON_RANK.output);
  }
  const inputTokens = safeIntegerOrNull(raw.inputTokens);

  // --- duration (denominator) ---
  /** @type {number | null} */
  let durationMs = null;
  const durationState = classifyInteger(raw.durationMs);
  if (durationState === "missing") {
    flags = setPerfFlag(flags, "MISSING_DURATION");
    setReason("duration_missing", REASON_RANK.duration);
  } else if (durationState === "zero" || durationState === "negative") {
    durationMs = /** @type {number} */ (raw.durationMs);
    flags = setPerfFlag(flags, "DURATION_NONPOSITIVE");
    setReason(durationState === "zero" ? "duration_zero" : "duration_negative", REASON_RANK.duration);
  } else if (durationState === "positive") {
    durationMs = /** @type {number} */ (raw.durationMs);
    if (durationMs > PERF_LONG_WINDOW_MS) flags = setPerfFlag(flags, "LONG_WINDOW");
  } else {
    flags = setPerfFlag(flags, "TIME_INVALID");
    setReason(`duration_${PERF_NUMERIC_REASON_SUFFIX[durationState]}`, REASON_RANK.duration);
  }

  // --- sample timestamp placement ---
  /** @type {number | null} */
  let tsMs = null;
  const tsState = classifyEpochMs(raw.tsMs);
  if (tsState === "missing") {
    flags = setPerfFlag(flags, "TIME_UNPLACED");
    setReason("timestamp_missing", REASON_RANK.time);
  } else if (tsState === "ok") {
    tsMs = /** @type {number} */ (raw.tsMs);
  } else {
    flags = setPerfFlag(flags, "TIME_INVALID");
    setReason(
      tsState === "unit_unsupported"
        ? "timestamp_unit_unsupported"
        : `timestamp_${PERF_NUMERIC_REASON_SUFFIX[tsState]}`,
      REASON_RANK.time,
    );
  }
  const windowStartState = classifyEpochMs(raw.windowStartMs);
  const windowEndState = classifyEpochMs(raw.windowEndMs);
  const windowStartMs = windowStartState === "ok" ? /** @type {number} */ (raw.windowStartMs) : null;
  const windowEndMs = windowEndState === "ok" ? /** @type {number} */ (raw.windowEndMs) : null;
  for (const [state, label] of [
    [windowStartState, "window_start"],
    [windowEndState, "window_end"],
  ]) {
    if (state === "missing" || state === "ok") continue;
    flags = setPerfFlag(flags, "TIME_INVALID");
    setReason(
      state === "unit_unsupported" ? `${label}_unit_unsupported` : `${label}_${PERF_NUMERIC_REASON_SUFFIX[state]}`,
      REASON_RANK.time,
    );
  }
  const startedAtMs = classifyEpochMs(raw.startedAtMs) === "ok" ? /** @type {number} */ (raw.startedAtMs) : null;
  const completedAtMs = classifyEpochMs(raw.completedAtMs) === "ok" ? /** @type {number} */ (raw.completedAtMs) : null;
  if (startedAtMs !== null && completedAtMs !== null && completedAtMs < startedAtMs) {
    flags = setPerfFlag(flags, "TIME_INVALID");
    setReason("timestamp_order_conflict", REASON_RANK.time);
  }
  if (windowStartMs !== null && windowEndMs !== null && windowEndMs < windowStartMs) {
    flags = setPerfFlag(flags, "TIME_INVALID");
    setReason("window_order_conflict", REASON_RANK.time);
  }

  // --- terminal status ---
  const rawStatus = trimmedString(raw.status);
  const alias = Object.hasOwn(PERF_STATUS_ALIASES, rawStatus) ? PERF_STATUS_ALIASES[rawStatus] : "";
  // "absent" and "present but unknown" are different states and must stay different:
  // only a genuinely absent status may ever be filled in from other evidence.
  const statusAbsent = rawStatus === "";
  /** @type {string} */
  let status;
  let statusExplicit = false;
  if (PERF_STATUSES.includes(rawStatus)) {
    status = rawStatus;
    statusExplicit = true;
  } else if (alias !== "") {
    status = alias;
    statusExplicit = true;
  } else if (statusAbsent && raw.terminalVerified === true) {
    // Fallback for a missing status only. An unrecognized status (e.g. "retrying") must
    // never be promoted here, or §17.1:222 "an absent field is never forced to completed"
    // would be reopened through the back door.
    status = "completed";
    statusExplicit = true;
  } else {
    // Unknown status, or absent status without explicit terminal evidence: both stay
    // unverified and are reported, never upgraded to completed.
    status = "unverified";
    if (statusAbsent) {
      setReason("status_missing", REASON_RANK.status);
    } else {
      warnings.push("UNRECOGNIZED_STATUS");
      setReason("status_unrecognized", REASON_RANK.status);
    }
  }
  if (!statusExplicit && raw.inProgress === true) {
    status = "in_progress";
    statusExplicit = true;
  }
  const retryCount = safeIntegerOrNull(raw.retryCount);
  /** @type {string} */
  let filterReason = trimmedString(raw.filterReason);
  // Contract ruling S: these source literals are normalization, not invention.
  if (status === "failed") filterReason = filterReason === "" ? "source_failed" : filterReason;
  if (status === "cancelled") filterReason = filterReason === "" ? "source_cancelled" : filterReason;
  if (raw.cancelledByUser === true) filterReason = filterReason === "" ? "cancelled_by_user" : filterReason;
  if (retryCount !== null && retryCount > 0) filterReason = filterReason === "" ? "retry" : filterReason;
  if (raw.sourceFiltered === true) filterReason = filterReason === "" ? "source_filtered" : filterReason;
  if (filterReason !== "") {
    flags = setPerfFlag(flags, "SOURCE_FILTERED");
    setReason(filterReason, REASON_RANK.filter);
    // Ruling S: a reader that can decide the terminal state must pass `status` itself;
    // deriving one here is only a fallback, and the derivation is recorded in the reason
    // chain below (`status_synthesized_from_filter_evidence`) so it is never silent.
    if (!statusExplicit) {
      status = filterReason === "source_cancelled" || filterReason === "cancelled_by_user" ? "cancelled" : "failed";
      statusSynthesized = true;
      statusExplicit = true;
    }
  }
  if (status === "unverified") flags = setPerfFlag(flags, "TERMINAL_UNVERIFIED");
  if (statusSynthesized) {
    // Ruling S: surfaced via the chain only, so the source-side filter evidence keeps its
    // own reason (`retry`/`source_failed`/`cancelled_by_user`) as the dominant one.
    reasonChain.push("status_synthesized_from_filter_evidence");
  }
  reasonChain.push(reason);

  // --- reader-supplied structural flags ---
  if (raw.partialItemSpan === true) flags = setPerfFlag(flags, "PARTIAL_ITEM_SPAN");
  if (raw.overlappingItemSpan === true) flags = setPerfFlag(flags, "OVERLAPPING_ITEM_SPAN");
  if (raw.modelAmbiguous === true) flags = setPerfFlag(flags, "MODEL_AMBIGUOUS");
  if (raw.recordConflict === true) flags = setPerfFlag(flags, "RECORD_CONFLICT");

  // --- per-source semantics are authoritative ---
  const semantics = isGenerationPerfMethod(methodVersion)
    ? generationSourceSemantics(sourceKind, trimmedString(raw.modelProvider), methodVersion)
    : PERF_LEGACY_SOURCE_SEMANTICS[sourceKind];
  const window = trimmedString(raw.window) || semantics.window;
  const timingKind = trimmedString(raw.timingKind) || semantics.timingKind;
  const tokenScope = trimmedString(raw.tokenScope) || semantics.tokenScope;
  let semanticsMismatch = false;
  for (const [provided, expected] of [
    [raw.window, semantics.window],
    [raw.timingKind, semantics.timingKind],
    [raw.tokenScope, semantics.tokenScope],
  ]) {
    if (trimmedString(provided) !== "" && trimmedString(provided) !== expected) semanticsMismatch = true;
  }
  if (semanticsMismatch) {
    warnings.push("SOURCE_SEMANTICS_MISMATCH");
    setReason("source_semantics_mismatch", REASON_RANK.semantics);
  }
  // --- counts and provenance ---
  const requestCount = safeIntegerOrNull(raw.requestCount);
  const itemCount = safeIntegerOrNull(raw.itemCount);
  const timedItemCount = safeIntegerOrNull(raw.timedItemCount);
  if (requestCount !== null && requestCount > 1 && sourceKind === "codex") {
    flags = setPerfFlag(flags, "MULTI_REQUEST_TURN");
  }
  if (raw.multiRequestTurn === true) flags = setPerfFlag(flags, "MULTI_REQUEST_TURN");
  if (raw.methodEstimate === true) flags = setPerfFlag(flags, "METHOD_ESTIMATE");
  /** @type {string} */
  let timingSource = trimmedString(raw.timingSource);
  if (timingSource === "") {
    timingSource = "unknown";
  } else if (!PERF_TIMING_SOURCES.includes(timingSource)) {
    warnings.push("UNRECOGNIZED_PROVENANCE");
    timingSource = "unknown";
  }
  if (providedMethodVersion !== "" && !PERF_SUPPORTED_METHOD_VERSIONS.includes(providedMethodVersion)) {
    warnings.push("UNRECOGNIZED_METHOD_VERSION");
  }

  // --- names: unknown names are the empty string (plan §4:51); the unknown *identity*
  // kind stays the `unknown` enum value (implementation plan §3:79) ---
  /** @type {string} */
  let agentKind = trimmedString(raw.agentKind);
  if (agentKind === "") {
    agentKind = "unknown";
  } else if (!PERF_AGENT_KINDS.includes(agentKind)) {
    warnings.push("UNRECOGNIZED_AGENT_KIND");
    agentKind = "unknown";
  }
  /**
   * Contract ruling P: `modelProvider`/`reasoningEffort`/`modelEvidence` are name-class
   * fields, so "no evidence" has exactly one literal — the empty string. A literal
   * `"unknown"` from a reader is normalized to `""` as well. The same absent state must
   * never have two literals: a reader sending `"unknown"` and another sending `""` would
   * otherwise split one model into two `perfGroupKey` groups, which is the opposite of
   * §17.6:288 (real provider/effort differences must stay distinguishable; missing
   * evidence must not be amplified into a difference).
   */
  const nameOrEmpty = (/** @type {unknown} */ value) => {
    const name = trimmedString(value);
    return name === "unknown" ? "" : name;
  };

  /** @type {PerfSample} */
  const sample = {
    sampleKey,
    sourcePath: trimmedString(raw.sourcePath),
    sourceKind,
    homeId: trimmedString(raw.homeId),
    channel: trimmedString(raw.channel),
    agentKind,
    agent: trimmedString(raw.agent),
    sessionId: trimmedString(raw.sessionId),
    turnKey: trimmedString(raw.turnKey),
    model: trimmedString(raw.model),
    modelProvider: nameOrEmpty(raw.modelProvider),
    reasoningEffort: nameOrEmpty(raw.reasoningEffort),
    modelEvidence: nameOrEmpty(raw.modelEvidence),
    window,
    timingKind,
    timingSource,
    tokenScope,
    status,
    tsMs,
    windowStartMs,
    windowEndMs,
    durationMs,
    outputTokens,
    inputTokens,
    requestCount,
    itemCount,
    timedItemCount,
    sampleFlags: flags,
    // Ruling R: `diagnosticReason` is the source-side fine-grained vocabulary and must
    // never be forwarded as a §17.5:278 `droppedByReason`; M1.2 derives that separately.
    diagnosticReason: reason,
    diagnosticReasonChain: reasonChain.filter((entry, index) => entry !== "" && reasonChain.indexOf(entry) === index),
    methodVersion,
  };
  return { sample, warningCode: warnings.length > 0 ? warnings[0] : null, warnings };
}

/**
 * M1.2: filtering, coverage and the single main drop reason.
 *
 * Authority: plan §17.4 (flag bits), §17.5:272-282 (coverage shape, rates, `byEra`,
 * fixed reason priority) and the frozen `source-contract.md` §2-E (12-flag deduction
 * set, priority wording), §8 rulings P/R (two reason vocabularies).
 *
 * Everything below is pure: no files, no SQLite, no DOM. Only appended exports;
 * no M1.1 export semantics are changed.
 */

/**
 * Default Codex recent/legacy split point (plan §17.5:280). It lives in method
 * metadata and may be updated there; callers override it per call via
 * `computePerfCoverage(selection, { eraCutoffMs })`. A sample is `recent` when
 * `tsMs >= eraCutoffMs`, otherwise `legacy`.
 */
export const PERF_ERA_CUTOFF_MS = Date.parse("2026-09-28T01:00:57Z");

/**
 * The eight §17.5:278 `droppedByReason` main reasons, in fixed priority order
 * (frozen wording of `source-contract.md` §2-E and `fixture-cases.md` N-02).
 * @type {readonly string[]}
 */
export const PERF_DROPPED_BY_REASONS = Object.freeze([
  "record_conflict",
  "model_ambiguous",
  "terminal_unverified",
  "source_filtered",
  "output_missing_zero_invalid",
  "duration_missing_nonpositive_invalid",
  "partial_item_span",
  "overlapping_item_span",
  "historical_method",
  "source_semantics_mismatch",
]);

/**
 * The 12 §17.4 flags that disqualify a candidate from `sampled`
 * (`source-contract.md` §2-E). `LONG_WINDOW` (bit 4), `MULTI_REQUEST_TURN`
 * (bit 5) and `METHOD_ESTIMATE` (bit 16) are hints only; `TIME_UNPLACED`
 * (bit 15) never reaches `eligible` at all.
 * @type {readonly string[]}
 */
export const PERF_DEDUCTION_FLAG_NAMES = Object.freeze([
  "SOURCE_FILTERED",
  "TERMINAL_UNVERIFIED",
  "RECORD_CONFLICT",
  "MODEL_AMBIGUOUS",
  "OUTPUT_ZERO",
  "MISSING_OUTPUT",
  "TOKEN_INVALID",
  "MISSING_DURATION",
  "DURATION_NONPOSITIVE",
  "TIME_INVALID",
  "PARTIAL_ITEM_SPAN",
  "OVERLAPPING_ITEM_SPAN",
]);

/**
 * Flag clusters in fixed §17.5:278 priority order. One entry per main reason;
 * a dropped candidate takes the reason of the first entry that matches any of
 * its flags, so every dropped candidate gets exactly one reason.
 */
const PERF_DROPPED_REASON_PRIORITY = Object.freeze([
  Object.freeze({ flags: Object.freeze(["RECORD_CONFLICT"]), reason: "record_conflict" }),
  Object.freeze({ flags: Object.freeze(["MODEL_AMBIGUOUS"]), reason: "model_ambiguous" }),
  Object.freeze({ flags: Object.freeze(["TERMINAL_UNVERIFIED"]), reason: "terminal_unverified" }),
  Object.freeze({ flags: Object.freeze(["SOURCE_FILTERED"]), reason: "source_filtered" }),
  Object.freeze({
    flags: Object.freeze(["MISSING_OUTPUT", "OUTPUT_ZERO", "TOKEN_INVALID"]),
    reason: "output_missing_zero_invalid",
  }),
  Object.freeze({
    flags: Object.freeze(["MISSING_DURATION", "DURATION_NONPOSITIVE", "TIME_INVALID"]),
    reason: "duration_missing_nonpositive_invalid",
  }),
  Object.freeze({ flags: Object.freeze(["PARTIAL_ITEM_SPAN"]), reason: "partial_item_span" }),
  Object.freeze({ flags: Object.freeze(["OVERLAPPING_ITEM_SPAN"]), reason: "overlapping_item_span" }),
]);

/**
 * Set of set flag names for one sample. This is the only flag-reading path:
 * it routes through {@link perfFlagNamesOf}, hence through the
 * {@link assertPerfFlagMaskInTable} gate, so an out-of-table mask throws
 * instead of being silently truncated.
 * @param {PerfSample} sample
 * @returns {Set<string>}
 */
function perfFlagSetOf(sample) {
  return new Set(perfFlagNamesOf(sample.sampleFlags));
}

/**
 * Whether a candidate contributes to n/quantiles/pooled (plan §17.5:276):
 * `status === "completed"`, no deduction flag, positive known output and
 * positive known duration. `LONG_WINDOW`, `MULTI_REQUEST_TURN` and
 * `METHOD_ESTIMATE` never disqualify; `TIME_UNPLACED` never qualifies.
 * @param {PerfSample} sample
 * @param {Set<string>} flags
 * @returns {boolean}
 */
function isPerfSampled(sample, flags) {
  if (sample.status !== "completed") return false;
  if (!hasGenerationPerfSemantics(sample)) return false;
  if (flags.has("TIME_UNPLACED")) return false;
  for (const name of PERF_DEDUCTION_FLAG_NAMES) {
    if (flags.has(name)) return false;
  }
  if (sample.outputTokens === null || sample.outputTokens <= 0) return false;
  if (sample.durationMs === null || sample.durationMs <= 0) return false;
  return true;
}

/**
 * Numeric generation rows can cover all output; unified ranking compares the
 * reviewed non-reasoning phase only. Compatible v3 samples retain their version.
 * @param {PerfSample} sample
 * @param {Set<string>} [flags]
 * @returns {boolean}
 */
function isPerfRankAdmitted(sample, flags = perfFlagSetOf(sample)) {
  if (!hasGenerationPerfSemantics(sample)) return false;
  if (sample.tokenScope !== "non_reasoning_output") return false;
  if (flags.has("METHOD_ESTIMATE")) return false;
  return sample.window === "request";
}

/**
 * The single §17.5:278 main reason of one candidate, derived from its flags in
 * fixed priority order (ruling R: `diagnosticReason` is never forwarded; only
 * flags decide). Returns `null` for candidates that are not dropped (`sampled`
 * or `pending`). Throws when a dropped candidate carries none of the reason
 * flags, because that would break `sum(droppedByReason) === dropped` silently.
 *
 * With M1.1-normalized samples the throw is unreachable: `failed`/`cancelled`
 * always carry `SOURCE_FILTERED`, `unverified` always carries
 * `TERMINAL_UNVERIFIED`, `in_progress` is pending, and any other non-sampled
 * `completed` candidate carries at least one deduction flag.
 * @param {PerfSample} sample
 * @returns {string | null}
 */
export function perfDroppedByReason(sample) {
  if (sample === null || typeof sample !== "object") {
    throw new TypeError("perfDroppedByReason expects a PerfSample object");
  }
  if (sample.status === "in_progress") return null;
  const flags = perfFlagSetOf(sample);
  for (const entry of PERF_DROPPED_REASON_PRIORITY) {
    for (const name of entry.flags) {
      if (flags.has(name)) return entry.reason;
    }
  }
  if (isPerfSampled(sample, flags)) return null;
  if (!isGenerationPerfMethod(sample.methodVersion)) return "historical_method";
  if (!hasGenerationPerfSemantics(sample)) return "source_semantics_mismatch";
  throw new Error(`perf sample ${sample.sampleKey} is dropped but carries none of the §17.5:278 reason flags`);
}

/**
 * @typedef {object} PerfSelectRange
 * @property {number | Date | null} [startMs] Inclusive lower bound; `null`/absent means unbounded.
 * @property {number | Date | null} [endMs] Inclusive upper bound for the ordinary
 *   (`start <= ts <= end`) range; ignored when `windowEndExclusiveMs` is present.
 * @property {number | Date | null} [windowEndExclusiveMs] Exclusive upper bound of a
 *   quota window (`ts < endExclusive`); wins over `endMs` when present.
 */

/**
 * @typedef {object} PerfSelectOptions
 * @property {PerfSelectRange | null} [range]
 * @property {string[] | Set<string> | null} [excludedHomeIds] Source exclusion,
 *   applied before the range filter.
 * @property {Array<{ kind?: unknown, homeId?: unknown }> | null} [knownSources]
 *   Discovery-level source list; `unsupported` entries are only listed, never sampled.
 */

/**
 * @typedef {object} PerfSelection The single selection result shared by
 * group/source/era consumers (plan §17.5:281).
 * @property {PerfSample[]} eligible Placeable, non-excluded, deduplicated candidates.
 * @property {PerfSample[]} unplaced Full-history placement diagnostics
 *   (`tsMs` missing): never in `eligible`, independent of the range filter.
 * @property {PerfSample[]} excluded Candidates removed by `excludedHomeIds`.
 * @property {PerfSample[]} outOfRange Placed, non-excluded candidates outside `range`.
 * @property {{ kind: string, homeId: string }[]} unsupportedSources Listed only;
 *   no `eligible === 0` pseudo-source is ever synthesized for them.
 */

/**
 * Canonical JSON serialization with sorted object keys, so two independently
 * built but field-identical samples compare equal regardless of key order.
 * @param {unknown} value
 * @returns {string}
 */
function stablePerfValueString(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stablePerfValueString(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    // Keys are object property names, so they are always strings; the code-unit
    // comparator keeps the serialization independent of locale.
    const keys = Object.keys(record).sort(perfCodeUnitCompare);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stablePerfValueString(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Total order over strings by UTF-16 code unit. Defined as: **any two strings that
 * are not `===` must compare non-zero.** `localeCompare` cannot promise that — it
 * consults the runtime's ICU tables, so `"é"` (U+00E9) and `"e\u0301"` (e + combining
 * acute) are literally different yet compare equal, which would let a duplicate set
 * keep an unresolved tie. Code-unit comparison is locale-independent and therefore
 * stable across environments and Node versions.
 * @param {string} a
 * @param {string} b
 * @returns {number} -1, 0 or 1
 */
function perfCodeUnitCompare(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Merge the diagnostic evidence of a duplicate group — **shared by both the
 * consistent-fold path and the conflict path.** Folding and conflicting are two sides
 * of one evidence-retention duty: members that agree still contribute flags and
 * reasons, and members that disagree do too. Keeping the merge in one function is
 * what prevents the two paths from drifting apart.
 *
 * Order-independent by construction:
 * - `sampleFlags` is the bitwise OR of the members (every member mask already passed
 *   the single flag gate, so the OR stays inside the table).
 * - `diagnosticReasonChain` is the union of member chains, ordered by the flag bit
 *   that produces each reason (§17.4 fixes the bit order), then by code unit for
 *   reasons with no flag equivalent. The chain never follows member order.
 * - `diagnosticReason` is the headline for the merged flags, chosen by the same
 *   {@link PERF_DROPPED_REASON_PRIORITY} table that later derives the main drop
 *   reason, falling back to the merged chain when no drop flag is set.
 * @param {PerfSample[]} group One or more rows sharing a `sampleKey`.
 * @returns {{ sampleFlags: number, diagnosticReason: string, diagnosticReasonChain: string[] }}
 */
function perfMergedDiagnosticEvidence(group) {
  let sampleFlags = 0;
  for (const row of group) sampleFlags = sampleFlags | row.sampleFlags;
  return {
    sampleFlags,
    diagnosticReason: perfMergedDiagnosticReason(sampleFlags, group),
    diagnosticReasonChain: perfMergedReasonChain(sampleFlags, group),
  };
}

/**
 * Flag name behind each reason **literal** as written by normalization, so a merged
 * chain can be ordered by the §17.4 flag table. Several flags share one §17.5:278
 * main reason, but their `diagnosticReason` literals stay distinct, and each literal
 * must resolve to its own bit — so this maps literals explicitly instead of reversing
 * a flag→reason table, whose many-to-one shape would collapse them.
 * @type {Map<string, string>}
 */
const PERF_FLAG_BY_REASON = new Map([
  ["output_missing", "MISSING_OUTPUT"],
  ["output_zero", "OUTPUT_ZERO"],
  [`output_${PERF_NUMERIC_REASON_SUFFIX.not_finite}`, "TOKEN_INVALID"],
  [`output_${PERF_NUMERIC_REASON_SUFFIX.not_integer}`, "TOKEN_INVALID"],
  [`output_${PERF_NUMERIC_REASON_SUFFIX.unsafe}`, "TOKEN_INVALID"],
  [`output_${PERF_NUMERIC_REASON_SUFFIX.not_number}`, "TOKEN_INVALID"],
  [`output_${PERF_NUMERIC_REASON_SUFFIX.negative}`, "TOKEN_INVALID"],
  [`output_${PERF_NUMERIC_REASON_SUFFIX.out_of_range}`, "TOKEN_INVALID"],
  ["duration_missing", "MISSING_DURATION"],
  ["duration_zero", "DURATION_NONPOSITIVE"],
  ["duration_negative", "DURATION_NONPOSITIVE"],
  [`duration_${PERF_NUMERIC_REASON_SUFFIX.not_finite}`, "TIME_INVALID"],
  [`duration_${PERF_NUMERIC_REASON_SUFFIX.not_integer}`, "TIME_INVALID"],
  [`duration_${PERF_NUMERIC_REASON_SUFFIX.unsafe}`, "TIME_INVALID"],
  [`duration_${PERF_NUMERIC_REASON_SUFFIX.not_number}`, "TIME_INVALID"],
  [`duration_${PERF_NUMERIC_REASON_SUFFIX.negative}`, "TIME_INVALID"],
  [`duration_${PERF_NUMERIC_REASON_SUFFIX.out_of_range}`, "TIME_INVALID"],
  ["timestamp_missing", "TIME_UNPLACED"],
  ["timestamp_order_conflict", "TIME_INVALID"],
  ["window_order_conflict", "TIME_INVALID"],
  ["partial_item_span", "PARTIAL_ITEM_SPAN"],
  ["overlapping_item_span", "OVERLAPPING_ITEM_SPAN"],
  ["model_ambiguous", "MODEL_AMBIGUOUS"],
  ["record_conflict", "RECORD_CONFLICT"],
  ["long_window", "LONG_WINDOW"],
  ["multi_request_turn", "MULTI_REQUEST_TURN"],
  ["method_estimate", "METHOD_ESTIMATE"],
]);

/**
 * Bit position of each flag name, so a merged chain can be ordered by the §17.4
 * table instead of by the order members were folded.
 * @type {Map<string, number>}
 */
const PERF_FLAG_BIT_BY_NAME = new Map(
  PERF_FLAG_BITS.map((name, bit) => /** @type {[string, number]} */ ([name ?? "", bit])).filter(
    ([name]) => name !== "",
  ),
);

/**
 * Union of member reason chains in a deterministic order: reasons that map to a
 * flag come first in flag-bit order, then the rest alphabetically.
 * @param {number} mask
 * @param {PerfSample[]} group
 * @returns {string[]}
 */
function perfMergedReasonChain(mask, group) {
  const setFlags = new Set(perfFlagNamesOf(mask));
  const bitOfReason = (reason) => {
    const flag = PERF_FLAG_BY_REASON.get(reason);
    if (flag !== undefined && setFlags.has(flag)) return PERF_FLAG_BIT_BY_NAME.get(flag) ?? Number.MAX_SAFE_INTEGER;
    return Number.MAX_SAFE_INTEGER;
  };
  const seen = new Set();
  for (const row of group) for (const entry of row.diagnosticReasonChain ?? []) if (entry !== "") seen.add(entry);
  return [...seen].sort((a, b) => {
    const delta = bitOfReason(a) - bitOfReason(b);
    return delta !== 0 ? delta : perfCodeUnitCompare(a, b);
  });
}

/**
 * Headline reason for a merged group. Drop flags decide it in the contract's own
 * priority order (exactly the order later used to derive the main drop reason); when
 * only hint flags are present, the earliest flag-bit reason wins. Every path reads
 * the merged mask and the merged chain only, so member order cannot leak in.
 * @param {number} mask
 * @param {PerfSample[]} group
 * @returns {string}
 */
function perfMergedDiagnosticReason(mask, group) {
  const setFlags = new Set(perfFlagNamesOf(mask));
  const chain = perfMergedReasonChain(mask, group);
  for (const entry of PERF_DROPPED_REASON_PRIORITY) {
    const flag = entry.flags.find((candidate) => setFlags.has(candidate));
    if (flag === undefined) continue;
    // Prefer the member-recorded literal belonging to this flag when one exists.
    const literal = chain.find((reason) => PERF_FLAG_BY_REASON.get(reason) === flag);
    return literal ?? entry.reason;
  }
  return chain[0] ?? "";
}

/**
 * The fields whose disagreement makes two same-identity rows a `RECORD_CONFLICT`
 * (plan §17.1:212 rule 4: "conflicting non-empty counts, ownership or start/end
 * values"). This is a **named allow-list**, not a whole-object comparison, because
 * whole-object comparison also compares fields that are not evidence about the turn.
 *
 * Deliberately excluded:
 * - `sourcePath`: the location a row was read from. Cross-rollout duplicates
 *   (D-11) necessarily come from different files and must still fold.
 * - `sampleFlags`/`diagnosticReason`/`diagnosticReasonChain`: normalization-derived
 *   diagnostics; comparing them only amplifies noise from identical input.
 * - `methodVersion`: a version difference is diagnosed separately, it is not
 *   evidence that two rows disagree about the same turn.
 * - `sampleKey`: constant within a group by construction.
 * @type {readonly string[]}
 */
export const PERF_CONFLICT_COMPARE_KEYS = Object.freeze([
  "status",
  "outputTokens",
  "durationMs",
  "tsMs",
  "windowStartMs",
  "windowEndMs",
  "inputTokens",
  "requestCount",
  "itemCount",
  "timedItemCount",
  "model",
  "modelProvider",
  "reasoningEffort",
  "modelEvidence",
  "agent",
  "agentKind",
  "sessionId",
  "turnKey",
  "channel",
  "timingKind",
  "timingSource",
  "tokenScope",
  "window",
]);

/**
 * Signature used for duplicate/conflict comparison: the allow-listed fields only.
 * @param {PerfSample} sample
 * @returns {string}
 */
function perfConflictSignature(sample) {
  /** @type {Record<string, unknown>} */
  const picked = {};
  for (const key of PERF_CONFLICT_COMPARE_KEYS) {
    if (Object.hasOwn(sample, key)) picked[key] = sample[key];
  }
  return stablePerfValueString(picked);
}

/**
 * Resolve one conflicting `sampleKey` group into a single order-independent
 * candidate. Every rule below is a function of the group as a *set*, never of which
 * row happened to be read first:
 *
 * 1. **Status** — the survivor is forced to `failed`, so the classifier always
 *    chooses the `record_conflict` main reason. A group whose evidence contradicts
 *    itself is neither "explicitly in progress" (so never `pending`) nor a valid
 *    sample (so never `sampled`). `diagnosticReason` keeps the source-side
 *    vocabulary (ruling R): `record_conflict` is never written into it.
 * 2. **Time / range membership** — membership is decided on the union of member
 *    `tsMs`: if *any* member lies inside the range the group is eligible there, so
 *    the conflict diagnostic can never disappear just because a later row was read
 *    first. The representative `tsMs` is the minimum among the in-range members
 *    (the earliest in-window observation); when no member is in range, the minimum
 *    over the whole group is kept for diagnostics only.
 * 3. **Ownership** — `sampleKey` is identical within the group and M1.1-返工2
 *    guarantees `sampleKey[1] === homeId`, so all members share one home by
 *    construction. A member that disagrees (impossible unless a caller fabricates
 *    samples) is folded under the lexicographically smallest home so the result
 *    stays deterministic.
 * @param {PerfSample[]} group Two or more rows sharing one `sampleKey`.
 * @param {{ startMs: number | null, endMs: number | null, windowEndExclusiveMs: number | null }} bounds
 * @returns {PerfSample}
 */
function perfResolveConflictGroup(group, bounds) {
  // Explicit code-unit order rather than the default `Array.prototype.sort` string
  // coercion: both are code-unit based today, but naming the comparator keeps this
  // key independent of locale and of any future `homeId` type change.
  const homes = [...new Set(group.map((row) => row.homeId))].sort(perfCodeUnitCompare);
  const homeId = homes[0] ?? "";
  const candidates = group.filter((row) => row.homeId === homeId);
  const timed = candidates.filter((row) => typeof row.tsMs === "number");
  const inRangeTimed = timed.filter((row) => perfTsInRange(/** @type {number} */ (row.tsMs), bounds));
  const pool = inRangeTimed.length > 0 ? inRangeTimed : timed;
  const tsMs = pool.length > 0 ? Math.min(...pool.map((row) => /** @type {number} */ (row.tsMs))) : null;
  // Deterministic base row. The comparator below is a **strict lexicographic** order
  // over the keys (in-range first → missing `tsMs` last → timestamp ascending → path by
  // code unit → semantic signature by code unit), which is what makes it transitive:
  // a lexicographic comparison of totally-ordered keys is itself a total order, so
  // `Array.prototype.sort` cannot produce an input-order-dependent result.
  //
  // Missing timestamps get an explicit slot **after** every number, rather than
  // falling through to the path key. Falling through would let a numeric pair be
  // decided by time while a numeric/missing pair is decided by path — and that mixed
  // rule is not transitive: with A(t, path z), B(t+1, path a), C(missing, path m) it
  // yields A<B (by time), B<C (by path) and C<A (by path), a cycle A<B<C<A. Numbers
  // are concrete evidence, so they rank ahead of a missing value.
  //
  // The chosen row is **arbitrary but stable**: no member of a contradictory group is
  // authoritative, and since the merged flags/reasons are taken over the whole group
  // (see `perfMergedDiagnosticEvidence`), the pick affects no count or diagnostic —
  // its only job is to keep ownership (`perfGroupKey`) independent of input order.
  // Every string key uses code units, so the order is strict and locale-independent,
  // and the key is a pure function of the members' own fields (no randomness, object
  // identity or insertion index).
  const base = [...candidates].sort((a, b) => {
    const aIn = typeof a.tsMs === "number" && perfTsInRange(a.tsMs, bounds) ? 0 : 1;
    const bIn = typeof b.tsMs === "number" && perfTsInRange(b.tsMs, bounds) ? 0 : 1;
    if (aIn !== bIn) return aIn - bIn;
    const aHas = typeof a.tsMs === "number" ? 0 : 1;
    const bHas = typeof b.tsMs === "number" ? 0 : 1;
    if (aHas !== bHas) return aHas - bHas;
    if (aHas === 0 && a.tsMs !== b.tsMs) return /** @type {number} */ (a.tsMs) - /** @type {number} */ (b.tsMs);
    const byPath = perfCodeUnitCompare(a.sourcePath, b.sourcePath);
    if (byPath !== 0) return byPath;
    return perfCodeUnitCompare(perfConflictSignature(a), perfConflictSignature(b));
  })[0];
  // Merged evidence over *all* members, then the conflict bit on top. Central to the
  // symmetry with the fold path: a member's filter marker must survive whether the
  // group agreed or disagreed. `base` now decides only the semantic fields (model,
  // session, ...), never the flags/reason/chain.
  const merged = perfMergedDiagnosticEvidence(candidates);
  return {
    ...base,
    homeId,
    tsMs,
    // Never inherit a member's terminal state: contradiction means dropped.
    status: "failed",
    ...merged,
    sampleFlags: setPerfFlag(merged.sampleFlags, "RECORD_CONFLICT"),
  };
}

/**
 * Coerce a range bound to epoch milliseconds. `Date` instances are read via
 * `getTime()`; finite numbers pass through; `null`/`undefined` means unbounded.
 * An invalid `Date` (whose `getTime()` is `NaN`) is rejected exactly like a
 * non-finite number: `ts < NaN` is always false, so accepting it would silently
 * disable the bound instead of failing.
 * @param {unknown} value
 * @returns {number | null}
 */
function perfRangeBoundMs(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    if (!Number.isFinite(time)) {
      throw new TypeError("perf range bounds must be finite millisecond numbers or Dates");
    }
    return time;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new TypeError("perf range bounds must be finite millisecond numbers or Dates");
}

/**
 * The one range test, shared by the conflict resolver and the classifier so that
 * "in range" can never mean two different things. `windowEndExclusiveMs` wins over
 * `endMs` when both are given, matching the classifier's precedence.
 * @param {number} tsMs
 * @param {{ startMs: number | null, endMs: number | null, windowEndExclusiveMs: number | null }} bounds
 * @returns {boolean}
 */
function perfTsInRange(tsMs, bounds) {
  if (bounds.startMs !== null && tsMs < bounds.startMs) return false;
  if (bounds.windowEndExclusiveMs !== null) return tsMs < bounds.windowEndExclusiveMs;
  if (bounds.endMs !== null && tsMs > bounds.endMs) return false;
  return true;
}

/**
 * Select the candidates for one query: deduplicate, exclude sources, split off
 * unplaceable rows, then apply the time range to `tsMs`.
 *
 * Order is fixed: duplicate-`sampleKey` rows fold when field-identical and the
 * survivor of a conflicting group is marked `RECORD_CONFLICT` (flag only;
 * `diagnosticReason` stays source-side per ruling R); source exclusion runs
 * before the range filter; `tsMs === null` rows only join the full-history
 * `unplaced` diagnostics and never enter `eligible`.
 * @param {PerfSample[]} samples Normalized candidates (usually `normalizePerfSample` output).
 * @param {PerfSelectOptions | null | undefined} [options]
 * @returns {PerfSelection}
 */
export function selectPerfSamples(samples, options = {}) {
  if (!Array.isArray(samples)) throw new TypeError("selectPerfSamples expects an array of PerfSample");
  const opts = options ?? {};
  if (opts !== null && typeof opts !== "object") throw new TypeError("selectPerfSamples options must be an object");

  const rawExcluded = opts.excludedHomeIds ?? [];
  if (typeof rawExcluded === "string" || typeof rawExcluded[Symbol.iterator] !== "function") {
    throw new TypeError("excludedHomeIds must be an array or Set of home ids");
  }
  const excludedSet = new Set();
  for (const entry of rawExcluded) {
    if (typeof entry === "string" && entry.trim() !== "") excludedSet.add(entry.trim());
  }

  const range = opts.range ?? null;
  if (range !== null && (typeof range !== "object" || range instanceof Date)) {
    throw new TypeError("selectPerfSamples range must be an object with startMs/endMs/windowEndExclusiveMs");
  }
  const startMs = range === null ? null : perfRangeBoundMs(range.startMs);
  const endMs = range === null ? null : perfRangeBoundMs(range.endMs);
  const windowEndExclusiveMs = range === null ? null : perfRangeBoundMs(range.windowEndExclusiveMs);
  const bounds = { startMs, endMs, windowEndExclusiveMs };

  /** @type {Map<string, PerfSample[]>} */
  const byKey = new Map();
  /** @type {PerfSample[]} */
  const keyless = [];
  for (const entry of samples) {
    if (entry === null || typeof entry !== "object") continue;
    if (typeof entry.sampleKey !== "string") {
      keyless.push(entry);
      continue;
    }
    const group = byKey.get(entry.sampleKey);
    if (group !== undefined) group.push(entry);
    else byKey.set(entry.sampleKey, [entry]);
  }
  /** @type {PerfSample[]} */
  const deduped = [...keyless];
  for (const members of byKey.values()) {
    // A v4 DSH remeasurement replaces the old phase for this response, not its history.
    const currentDsh = members.filter(
      (row) => row.sourceKind === "dsh" && row.methodVersion === PERF_METHOD_VERSION && hasGenerationPerfSemantics(row),
    );
    const group = currentDsh.length > 0 ? members.filter((row) => row.methodVersion !== "tps-v3") : members;
    if (group.length === 1) {
      deduped.push(group[0]);
      continue;
    }
    const first = perfConflictSignature(group[0]);
    const consistent = group.every((row) => perfConflictSignature(row) === first);
    if (consistent) {
      // Identical evidence folds once. Prefer the current method version so a stale
      // v1 duplicate cannot hide an admitted v2 row, then merge every diagnostic.
      const representative = group.find((row) => row.methodVersion === PERF_METHOD_VERSION) ?? group[0];
      deduped.push({ ...representative, ...perfMergedDiagnosticEvidence(group) });
      continue;
    }
    deduped.push(perfResolveConflictGroup(group, bounds));
  }

  /** @type {PerfSelection} */
  const selection = { eligible: [], unplaced: [], excluded: [], outOfRange: [], unsupportedSources: [] };
  for (const sample of deduped) {
    // M1.1-返工2 invariant: sampleKey[1] === groupKey[1] === homeId, so one field decides.
    if (excludedSet.has(sample.homeId)) {
      selection.excluded.push(sample);
      continue;
    }
    if (typeof sample.tsMs !== "number") {
      selection.unplaced.push(sample);
      continue;
    }
    const ts = sample.tsMs;
    if (!perfTsInRange(ts, bounds)) {
      selection.outOfRange.push(sample);
      continue;
    }
    selection.eligible.push(sample);
  }

  for (const entry of opts.knownSources ?? []) {
    if (entry === null || typeof entry !== "object") continue;
    if (canonicalPerfSourceKind(entry.kind) !== "unsupported") continue;
    selection.unsupportedSources.push({
      kind: typeof entry.kind === "string" ? entry.kind.trim() : "",
      homeId: typeof entry.homeId === "string" ? entry.homeId.trim() : "",
    });
  }
  return selection;
}

/**
 * @typedef {object} PerfCoverageOptions
 * @property {number | null | undefined} [eraCutoffMs] Override of
 *   {@link PERF_ERA_CUTOFF_MS}; must be a finite number when present.
 */

/**
 * @typedef {object} PerfCoverage The §17.5:272 count shape for one candidate set.
 * @property {number} eligible
 * @property {number} positiveOutput Eligible with known output > 0.
 * @property {number} timedPositiveOutput Of those, with positive observed duration.
 * @property {number} completeTimedPositiveOutput Of those, with a complete target
 *   window (no `PARTIAL_ITEM_SPAN` / `OVERLAPPING_ITEM_SPAN`).
 * @property {number} sampled Through the default filter; feeds n/quantiles/pooled.
 * @property {number} dropped Other disqualified candidates; exactly one
 *   `droppedByReason` each.
 * @property {number} pending Explicitly in-progress candidates.
 * @property {number} unplaced Full-history placement diagnostics, outside `eligible`.
 * @property {Record<string, number>} byFlag Overlapping per-flag counts over
 *   `eligible`; never summed as `dropped`.
 * @property {Record<string, number>} droppedByReason Mutually exclusive main
 *   reasons; values sum to `dropped`.
 * @property {number | null} timingRate `timedPositiveOutput / positiveOutput`, `null` on zero denominator.
 * @property {number | null} completeTimingRate `completeTimedPositiveOutput / positiveOutput`, `null` on zero denominator.
 * @property {number | null} sampleRate `sampled / eligible`, `null` on zero denominator.
 * @property {{ recent: PerfCoverage, legacy: PerfCoverage } | null} byEra Codex-only
 *   split of `eligible` by `tsMs` vs `eraCutoffMs`; `null` for non-Codex sets.
 */

/**
 * @param {number} numerator
 * @param {number} denominator
 * @returns {number | null}
 */
function perfRateOrNull(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * @param {PerfSample[]} eligible
 * @param {number} unplacedCount
 * @param {number} eraCutoffMs
 * @param {boolean} allowEra
 * @returns {PerfCoverage}
 */
function computePerfCoverageCounts(eligible, unplacedCount, eraCutoffMs, allowEra) {
  /** @type {Record<string, number>} */
  const byFlag = {};
  for (const name of PERF_FLAG_NAMES) byFlag[name] = 0;
  /** @type {Record<string, number>} */
  const droppedByReason = {};
  for (const reason of PERF_DROPPED_BY_REASONS) droppedByReason[reason] = 0;

  let positiveOutput = 0;
  let timedPositiveOutput = 0;
  let completeTimedPositiveOutput = 0;
  let sampled = 0;
  let pending = 0;
  /** @type {PerfSample[]} */
  const droppedSamples = [];
  for (const sample of eligible) {
    const flags = perfFlagSetOf(sample);
    for (const name of flags) byFlag[name] = (byFlag[name] ?? 0) + 1;
    const positive = sample.outputTokens !== null && sample.outputTokens > 0;
    if (positive) positiveOutput += 1;
    const timedPositive = positive && sample.durationMs !== null && sample.durationMs > 0;
    if (timedPositive) timedPositiveOutput += 1;
    if (timedPositive && !flags.has("PARTIAL_ITEM_SPAN") && !flags.has("OVERLAPPING_ITEM_SPAN")) {
      completeTimedPositiveOutput += 1;
    }
    if (sample.status === "in_progress") pending += 1;
    else if (isPerfSampled(sample, flags)) sampled += 1;
    else droppedSamples.push(sample);
  }
  const dropped = droppedSamples.length;
  for (const sample of droppedSamples) {
    const reason = perfDroppedByReason(sample);
    if (reason === null) {
      throw new Error(`perf sample ${sample.sampleKey} is dropped but has no §17.5:278 main reason`);
    }
    droppedByReason[reason] += 1;
  }

  /** @type {{ recent: PerfCoverage, legacy: PerfCoverage } | null} */
  let byEra = null;
  if (allowEra && eligible.length > 0) {
    const kinds = new Set(eligible.map((sample) => sample.sourceKind));
    if (kinds.size === 1 && kinds.has("codex")) {
      const recent = eligible.filter((sample) => typeof sample.tsMs === "number" && sample.tsMs >= eraCutoffMs);
      const recentKeys = new Set(recent.map((sample) => sample.sampleKey));
      const legacy = eligible.filter((sample) => !recentKeys.has(sample.sampleKey));
      byEra = {
        recent: computePerfCoverageCounts(recent, 0, eraCutoffMs, false),
        legacy: computePerfCoverageCounts(legacy, 0, eraCutoffMs, false),
      };
    }
  }

  return {
    eligible: eligible.length,
    positiveOutput,
    timedPositiveOutput,
    completeTimedPositiveOutput,
    sampled,
    dropped,
    pending,
    unplaced: unplacedCount,
    byFlag,
    droppedByReason,
    timingRate: perfRateOrNull(timedPositiveOutput, positiveOutput),
    completeTimingRate: perfRateOrNull(completeTimedPositiveOutput, positiveOutput),
    sampleRate: perfRateOrNull(sampled, eligible.length),
    byEra,
  };
}

/**
 * Coverage of one {@link PerfSelection}: the §17.5:272 shape. Guarantees
 * `eligible === sampled + dropped + pending` (pending is checked before the
 * sampled rule, dropped is the remainder, so the identity holds by
 * construction), the five-level monotone chain
 * `sampled <= completeTimedPositiveOutput <= timedPositiveOutput <=
 * positiveOutput <= eligible`, and `sum(droppedByReason) === dropped`
 * (every dropped candidate yields exactly one priority reason; a dropped
 * candidate with none throws instead of silently breaking the sum).
 * `byEra` splits Codex `eligible` by `tsMs` vs `eraCutoffMs` and is `null`
 * for any non-Codex set.
 * @param {PerfSelection} selection
 * @param {PerfCoverageOptions | null | undefined} [options]
 * @returns {PerfCoverage}
 */
export function computePerfCoverage(selection, options = {}) {
  if (selection === null || typeof selection !== "object") {
    throw new TypeError("computePerfCoverage expects a PerfSelection object");
  }
  const eligible = selection.eligible ?? [];
  const unplaced = selection.unplaced ?? [];
  if (!Array.isArray(eligible) || !Array.isArray(unplaced)) {
    throw new TypeError("computePerfCoverage expects selection.eligible/unplaced arrays");
  }
  return computePerfCoverageCounts(eligible, unplaced.length, resolvePerfEraCutoffMs(options?.eraCutoffMs), true);
}

/**
 * Resolve and validate the Codex era cut point **once**. `null`/`undefined` means
 * "use the frozen default"; anything else must be a finite millisecond number.
 *
 * This exists because the cut point is consumed in several places (the global
 * coverage, every `bySource` bucket, and `meta.eraCutoffMs`). Resolving it separately
 * in each place is how `meta` ends up reporting a value that the computation never
 * used — metadata must never impersonate a calculation parameter. Every consumer
 * shares this one resolved value.
 * @param {unknown} value
 * @returns {number}
 */
function resolvePerfEraCutoffMs(value) {
  if (value === null || value === undefined) return PERF_ERA_CUTOFF_MS;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("eraCutoffMs must be a finite millisecond number");
  }
  return value;
}

/**
 * The key used to bucket candidates that have no canonical group key, i.e. samples
 * whose `sourceKind` is `unsupported` so `perfGroupKey` returns `null`. Such rows are
 * still real candidates that were counted as `eligible`, so they must have an explicit
 * landing spot rather than being silently dropped from the breakdown: dropping them
 * would make `sum(byGroup buckets) !== coverage.eligible`, and the whole point of the
 * breakdown is to explain the dropped candidates.
 * @type {string}
 */
const PERF_UNKEYED_GROUP_BUCKET = "(unkeyed)";

/**
 * Compute the §17.5 count shape **plus** the `bySource` / `byGroup` breakdowns, all
 * from one already-built selection and one already-resolved cut point.
 *
 * Single implementation: the global coverage and every bucket call the same
 * {@link computePerfCoverageCounts}. No coverage arithmetic is repeated here, and the
 * same candidate array is never re-filtered, so a bucket can only ever be a subset of
 * the global numbers (by construction: `sum(bySource) === global` for `eligible`).
 *
 * `bySource` exists for a contract reason beyond convenience: `byEra` is produced only
 * when the whole eligible set is one `sourceKind` equal to `codex`, so a mixed set
 * necessarily reports `byEra: null`. The per-source buckets are therefore the only way
 * to obtain the Codex era split in a mixed run.
 *
 * Diagnostic buckets are **kept**: a group with `eligible > 0` but `sampled === 0` is
 * exactly the answer to "which model was dropped and why does it produce no TPS", so
 * these are retained even though they emit no statistical group.
 * @param {PerfSelection} selection
 * @param {number} eraCutoffMs Already resolved and validated.
 * @returns {PerfCoverage & { bySource: Record<string, PerfCoverage>, byGroup: Record<string, PerfCoverage> }}
 */
function computePerfCoverageWithBreakdown(selection, eraCutoffMs) {
  const eligible = selection.eligible ?? [];
  const unplaced = selection.unplaced ?? [];
  const global = computePerfCoverageCounts(eligible, unplaced.length, eraCutoffMs, true);

  // `eligible` and `unplaced` are **disjoint** sets, and both must be attributed to
  // their source/group. `unplaced` is the "this source's samples had no usable
  // timestamp anywhere in history" diagnostic (§17.5:279, ruling AD-2), so attributing
  // it by source is the entire reason it exists; dropping it made a source with only
  // unplaced samples vanish from `bySource` entirely, and made a fully-out-of-range run
  // lose the source dimension altogether.
  // Each bucket therefore receives the sum of two counts: how many of its members came
  // from `eligible`, and how many from `unplaced`. Only the first feeds `eligible`.
  /** @type {Map<string, { sampled: PerfSample[], unplaced: PerfSample[] }>} */
  const sourceBuckets = new Map();
  const bucketFor = (map, key) => {
    const found = map.get(key);
    if (found !== undefined) return found;
    const created = { sampled: [], unplaced: [] };
    map.set(key, created);
    return created;
  };
  for (const sample of eligible)
    bucketFor(sourceBuckets, canonicalPerfSourceKind(sample.sourceKind)).sampled.push(sample);
  for (const sample of unplaced)
    bucketFor(sourceBuckets, canonicalPerfSourceKind(sample.sourceKind)).unplaced.push(sample);

  /** @type {Record<string, PerfCoverage>} */
  const bySource = {};
  // Emit in code-unit key order rather than Map insertion order: insertion order
  // follows the input, which would make the serialized coverage depend on sample
  // order even though every bucket's contents are order-independent.
  for (const kind of [...sourceBuckets.keys()].sort(perfCodeUnitCompare)) {
    const bucket = /** @type {{ sampled: PerfSample[], unplaced: PerfSample[] }} */ (sourceBuckets.get(kind));
    // `allowEra` so a Codex bucket gets its own era split; non-Codex buckets stay
    // `null` because the inner rule keys off `sourceKind === "codex"`. Era is derived
    // from `eligible` only: an unplaced sample has no `tsMs` by definition, so it can
    // never be assigned to an era and must not influence the split.
    bySource[kind] = computePerfCoverageCounts(bucket.sampled, bucket.unplaced.length, eraCutoffMs, true);
  }

  /** @type {Map<string, { sampled: PerfSample[], unplaced: PerfSample[] }>} */
  const groupBuckets = new Map();
  for (const sample of eligible)
    bucketFor(groupBuckets, perfGroupKey(sample) ?? PERF_UNKEYED_GROUP_BUCKET).sampled.push(sample);
  for (const sample of unplaced)
    bucketFor(groupBuckets, perfGroupKey(sample) ?? PERF_UNKEYED_GROUP_BUCKET).unplaced.push(sample);

  /** @type {Record<string, PerfCoverage>} */
  const byGroup = {};
  // Object insertion order follows input order, which would make the serialized shape
  // order-sensitive. Emit buckets in code-unit key order instead; `byGroup` keys are
  // canonical JSON group keys (or the unkeyed marker).
  for (const key of [...groupBuckets.keys()].sort(perfCodeUnitCompare)) {
    const bucket = /** @type {{ sampled: PerfSample[], unplaced: PerfSample[] }} */ (groupBuckets.get(key));
    byGroup[key] = computePerfCoverageCounts(bucket.sampled, bucket.unplaced.length, eraCutoffMs, true);
  }

  return { ...global, bySource, byGroup };
}

/**
 * The eight `sourceWarnings.code` values frozen by the implementation plan §3:83.
 * Ruling Q: the seven `PERF_NORMALIZE_WARNING_CODES` are reader-side return-value
 * diagnostics and are **never** allowed into a `sourceWarnings` shape; the shape
 * accepts only these codes. `AGGREGATE_OVERFLOW` is a member of this frozen set,
 * which is what makes it the correct encoding for plan §17.2:229 overflow.
 * @type {ReadonlySet<string>}
 */
export const PERF_SOURCE_WARNING_CODES = Object.freeze(
  new Set([
    "UNKEYABLE_RECORD",
    "READ_ONLY_OPEN_FAILED",
    "UNSUPPORTED_SCHEMA",
    "MALFORMED_JSON",
    "MALFORMED_FRAME",
    "LIVE_SOURCE_CHANGED",
    "OPTIONAL_SOURCE_UNAVAILABLE",
    "AGGREGATE_OVERFLOW",
  ]),
);

/**
 * `state` values for `meta.state` (implementation plan §3:81).
 * @type {readonly ["rebuilding", "ready", "degraded"]}
 */
const PERF_SUMMARY_STATES = Object.freeze(["rebuilding", "ready", "degraded"]);

/**
 * One statistical group of a sample set: §17.1:212 dimensions plus the §17.2
 * aggregation results. The authoritative shape (with per-field notes) is the
 * `PerfSummaryGroup` typedef in `src/usage-types.js`.
 * @typedef {import("./usage-types.js").PerfSummaryGroup} PerfSummaryGroup
 * @typedef {import("./usage-types.js").PerfModelRow} PerfModelRow
 * @typedef {import("./usage-types.js").PerfCodexTimingCoverage} PerfCodexTimingCoverage
 */

/**
 * `null`-safe integer check against the Number safe-integer range, used for the
 * raw sums of plan §17.2:229 ("原始整数和总和必须在 Number 安全整数范围内").
 * @param {unknown} value
 * @returns {boolean}
 */
function isPerfSafeCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * nearest-rank quantile over an ascending numeric array: `r[ceil(p * n) - 1]`
 * (plan §17.2:226, the single frozen algorithm).
 *
 * Returns `null` for an empty array, because `n = 0` produces **no** statistical
 * row (plan §17.2:227); callers must not fabricate a value. With `n = 1` every `p`
 * maps to index 0, so all three quantiles coincide as the plan requires.
 *
 * `Math.ceil` is load-bearing and is exercised by the parity fixture: replacing it
 * with `Math.floor` changes which member is selected for every `p * n` that is not
 * an integer, so a fixture that survives that mutation is not testing this rule.
 * @param {number[]} sorted Ascending; must not be mutated.
 * @param {number} p In (0, 1].
 * @returns {number | null}
 */
function perfNearestRank(sorted, p) {
  const n = sorted.length;
  if (n === 0) return null;
  const index = Math.ceil(p * n) - 1;
  // `index` is always inside [0, n - 1] for p in (0, 1]; clamp anyway so a caller
  // passing an out-of-contract p can never read past the array.
  const clamped = index < 0 ? 0 : index >= n ? n - 1 : index;
  return sorted[clamped];
}

/**
 * Count Codex timing coverage for the current method on the same selection as the
 * summary. This filters only source and method version, never `sampled`, so missing
 * duration/output evidence remains in the denominator.
 * @param {PerfSelection} selection
 * @param {Array<{ kind?: unknown, homeId?: unknown }> | null | undefined} knownSources
 * @param {string[] | Set<string> | null | undefined} excludedHomeIds
 * @param {number} eraCutoffMs
 * @returns {PerfCodexTimingCoverage | null}
 */
function computeCodexTimingCoverage(selection, knownSources, excludedHomeIds, eraCutoffMs) {
  const excluded = new Set();
  for (const homeId of excludedHomeIds ?? []) {
    if (typeof homeId === "string" && homeId.trim() !== "") excluded.add(homeId.trim());
  }
  let applicable = false;
  for (const source of knownSources ?? []) {
    if (
      source !== null &&
      typeof source === "object" &&
      canonicalPerfSourceKind(source.kind) === "codex" &&
      typeof source.homeId === "string" &&
      source.homeId.trim() !== "" &&
      !excluded.has(source.homeId.trim())
    ) {
      applicable = true;
      break;
    }
  }
  if (!applicable) return null;

  const currentCodex = (sample) => sample?.sourceKind === "codex" && isGenerationPerfMethod(sample.methodVersion);
  const eligible = selection.eligible.filter(currentCodex);
  const unplaced = selection.unplaced.filter(currentCodex);
  let recordedOutputTokens = 0;
  let sampledOutputTokens = 0;
  let unknownOutputCandidates = 0;
  for (const sample of eligible) {
    const output = sample.outputTokens;
    if (!isPerfSafeCount(output) || output < 0) {
      unknownOutputCandidates += 1;
      continue;
    }
    if (recordedOutputTokens !== null) {
      const next = recordedOutputTokens + output;
      recordedOutputTokens = isPerfSafeCount(next) ? next : null;
    }
    const flags = perfFlagSetOf(sample);
    if (sample.status === "in_progress" || !isPerfSampled(sample, flags)) continue;
    if (sampledOutputTokens !== null) {
      const next = sampledOutputTokens + output;
      sampledOutputTokens = isPerfSafeCount(next) ? next : null;
    }
  }
  return {
    methodVersion: PERF_METHOD_VERSION,
    recordedOutputTokens,
    sampledOutputTokens,
    unknownOutputCandidates,
    counts: computePerfCoverage(
      {
        ...selection,
        eligible,
        unplaced,
      },
      { eraCutoffMs },
    ),
  };
}

/**
 * Project the single sampled set into source/model/effort/provider speed rows. Home,
 * channel and main/subagent identity deliberately do not participate. Historical
 * Codex estimates remain in diagnostics but never enter the speed overview. Current
 * Codex candidates without duration retain a separate row with no speed statistics.
 * @param {PerfSample[]} sampled
 * @param {number} [minSamples]
 * @param {PerfSample[]} [candidates] Already selected, deduplicated candidates.
 * @returns {PerfModelRow[]}
 */
export function projectPerfModels(sampled, minSamples = PERF_MIN_SAMPLES, candidates = []) {
  if (!Array.isArray(sampled)) throw new TypeError("projectPerfModels expects an array of sampled perf rows");

  /** @type {Map<string, { key: string, sourceKind: string, model: string, reasoningEffort: string, modelProvider: string, members: PerfSample[], rankAdmitted: boolean }>} */
  const buckets = new Map();
  for (const sample of sampled) {
    const sourceKind = canonicalPerfSourceKind(sample?.sourceKind);
    const model = trimmedString(sample?.model);
    if (sourceKind === "unsupported" || model === "") continue;
    const flags = perfFlagSetOf(sample);
    if (!isPerfSampled(sample, flags) || flags.has("METHOD_ESTIMATE")) continue;
    const reasoningEffort = trimmedString(sample.reasoningEffort);
    const modelProvider = trimmedString(sample.modelProvider);
    const key = JSON.stringify([sourceKind, model, reasoningEffort, modelProvider]);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.members.push(sample);
      bucket.rankAdmitted &&= isPerfRankAdmitted(sample);
    } else {
      buckets.set(key, {
        key,
        sourceKind,
        model,
        reasoningEffort,
        modelProvider,
        members: [sample],
        rankAdmitted: isPerfRankAdmitted(sample),
      });
    }
  }

  /** @type {PerfModelRow[]} */
  const models = [];
  for (const bucket of buckets.values()) {
    let sumOutputTokens = 0;
    let sumDurationMs = 0;
    let firstSampleAtMs = null;
    let lastSampleAtMs = null;
    const windows = new Set();
    for (const member of bucket.members) {
      sumOutputTokens += /** @type {number} */ (member.outputTokens);
      sumDurationMs += /** @type {number} */ (member.durationMs);
      if (typeof member.tsMs === "number") {
        if (firstSampleAtMs === null || member.tsMs < firstSampleAtMs) firstSampleAtMs = member.tsMs;
        if (lastSampleAtMs === null || member.tsMs > lastSampleAtMs) lastSampleAtMs = member.tsMs;
      }
      windows.add(trimmedString(member.window));
    }
    const overflow = !isPerfSafeCount(sumOutputTokens) || !isPerfSafeCount(sumDurationMs);
    const n = bucket.members.length;
    /** @type {PerfModelRow["window"]} */
    const window =
      windows.size === 1
        ? /** @type {PerfModelRow["window"]} */ (trimmedString(windows.values().next().value))
        : "mixed";
    const rankState = overflow
      ? "overflow"
      : bucket.rankAdmitted !== true || window === "mixed"
        ? "unverified"
        : n < minSamples
          ? "insufficient_samples"
          : "eligible";
    const rates = overflow
      ? []
      : bucket.members
          .map(
            (member) => /** @type {number} */ (member.outputTokens * 1000) / /** @type {number} */ (member.durationMs),
          )
          .sort((a, b) => a - b);

    models.push({
      key: bucket.key,
      sourceKind: bucket.sourceKind,
      model: bucket.model,
      reasoningEffort: bucket.reasoningEffort,
      modelProvider: bucket.modelProvider,
      window,
      firstSampleAtMs,
      lastSampleAtMs,
      averageTps: overflow ? null : (sumOutputTokens * 1000) / sumDurationMs,
      p10: overflow ? null : perfNearestRank(rates, 0.1),
      p90: overflow ? null : perfNearestRank(rates, 0.9),
      n,
      state: overflow ? "overflow" : "ok",
      rankState,
      rank: null,
    });
  }

  // Keep observed models visible when their requests lack generation timing.
  /** @type {Map<string, PerfModelRow>} */
  const missing = new Map();
  for (const sample of candidates) {
    if (!hasGenerationPerfSemantics(sample)) continue;
    if (typeof sample.tsMs !== "number") continue;
    if (sample.durationMs !== null && sample.durationMs > 0) continue;
    const model = trimmedString(sample.model);
    const flags = perfFlagSetOf(sample);
    if (model === "" || flags.has("MODEL_AMBIGUOUS") || flags.has("METHOD_ESTIMATE")) continue;
    if (sample.timingKind !== "generation") continue;
    const reasoningEffort = trimmedString(sample.reasoningEffort);
    const modelProvider = trimmedString(sample.modelProvider);
    const key = JSON.stringify([sample.sourceKind, model, reasoningEffort, modelProvider]);
    if (buckets.has(key)) continue;
    let row = missing.get(key);
    if (!row) {
      row = {
        key,
        sourceKind: sample.sourceKind,
        model,
        reasoningEffort,
        modelProvider,
        window: "request",
        firstSampleAtMs: null,
        lastSampleAtMs: null,
        averageTps: null,
        p10: null,
        p90: null,
        n: 0,
        state: "missing_duration",
        rankState: "unverified",
        rank: null,
        candidateCount: 0,
        firstCandidateAtMs: sample.tsMs,
        lastCandidateAtMs: sample.tsMs,
      };
      missing.set(key, row);
    }
    row.candidateCount += 1;
    row.firstCandidateAtMs = Math.min(row.firstCandidateAtMs, sample.tsMs);
    row.lastCandidateAtMs = Math.max(row.lastCandidateAtMs, sample.tsMs);
  }
  models.push(...missing.values());

  models.sort((a, b) => {
    const aMissing = a.state === "missing_duration";
    const bMissing = b.state === "missing_duration";
    if (aMissing !== bMissing) return aMissing ? 1 : -1;
    const aOverflow = a.rankState === "overflow";
    const bOverflow = b.rankState === "overflow";
    if (aOverflow !== bOverflow) return aOverflow ? 1 : -1;
    const aEligible = a.rankState === "eligible";
    const bEligible = b.rankState === "eligible";
    if (aEligible !== bEligible) return aEligible ? -1 : 1;
    if (a.averageTps !== null && b.averageTps !== null && a.averageTps !== b.averageTps) {
      return b.averageTps - a.averageTps;
    }
    return perfCodeUnitCompare(a.key, b.key);
  });
  let rank = 1;
  for (const model of models) {
    if (model.rankState !== "eligible") continue;
    model.rank = rank;
    rank += 1;
  }
  return models;
}

/**
 * Aggregate one already-filtered sample set into a `PerfSummary` (plan §17.2 is
 * the only aggregation algorithm; the plan requires both production summary paths
 * to share this one function).
 *
 * Contract points that the tests pin down:
 * - quantiles, `pooled`, the sums and `n` all read **the same set** — the
 *   `sampled` members only. Pending, partial and filtered rows never enter the
 *   pooled ratio (plan §17.2:228).
 * - duration `p50`/`p90` are computed from the durations directly and are **never**
 *   back-derived from the TPS quantiles (plan §17.2:227, explicitly).
 * - `n = 0` emits no statistical group at all, only coverage/diagnostics.
 * - raw integer sums outside the safe-integer range yield `state: "overflow"` with
 *   `null` numbers instead of a pseudo-precise TPS (plan §17.2:229).
 * - display order is the **unrounded** `p50` descending, ties broken by the
 *   canonical group key in code-unit order, so the order never depends on locale
 *   or input order (plan §17.3: "显示排序用未舍入 p50，稳定同值排序用规范 key").
 * @param {PerfSample[]} samples
 * @param {{ range?: object | null, excludedHomeIds?: string[] | Set<string>, knownSources?: { kind?: unknown, homeId?: unknown }[], meta?: object }} [options]
 * @returns {{ groups: PerfSummaryGroup[], models: PerfModelRow[], coverage: PerfCoverage, codexTimingCoverage: PerfCodexTimingCoverage | null, meta: object }}
 */
export function summarizePerf(samples, options = {}) {
  const opts = options ?? {};
  // Reuse M1.2 filtering/dedup verbatim — a second coverage implementation would
  // drift from the one the coverage contract is written against.
  /** @type {{ kind?: unknown, homeId?: unknown }[]} */
  const knownSources = opts.knownSources ?? [];
  const selection = selectPerfSamples(samples, {
    range: opts.range ?? null,
    excludedHomeIds: opts.excludedHomeIds ?? [],
    knownSources,
  });

  // Resolve the era cut point **once**, before anything consumes it. The global
  // coverage, every `bySource` bucket and `meta.eraCutoffMs` all receive this exact
  // value, so `meta` can never describe a cut point other than the one used to
  // compute `byEra` (it previously echoed the request while the computation silently
  // fell back to the default).
  const eraCutoffMs = resolvePerfEraCutoffMs(opts.meta?.eraCutoffMs);
  const coverage = computePerfCoverageWithBreakdown(selection, eraCutoffMs);
  const codexTimingCoverage = computeCodexTimingCoverage(
    selection,
    knownSources,
    opts.excludedHomeIds ?? [],
    eraCutoffMs,
  );

  const minSamples = opts.meta?.minSamples ?? PERF_MIN_SAMPLES;
  if (typeof minSamples !== "number" || !Number.isFinite(minSamples) || minSamples < 0) {
    throw new TypeError("meta.minSamples must be a non-negative finite number");
  }
  const state = opts.meta?.state ?? "ready";
  if (!PERF_SUMMARY_STATES.includes(state)) {
    throw new TypeError(`meta.state must be one of ${PERF_SUMMARY_STATES.join("|")}`);
  }
  const sourceWarnings = opts.meta?.sourceWarnings ?? [];
  if (!Array.isArray(sourceWarnings)) {
    throw new TypeError("meta.sourceWarnings must be an array of {sourceKind, homeId, code, count}");
  }

  // Build the sampled set once; the old groups and the model projection must agree.
  /** @type {PerfSample[]} */
  const sampled = [];
  for (const sample of selection.eligible) {
    const flags = perfFlagSetOf(sample);
    if (sample.status === "in_progress") continue;
    if (!isPerfSampled(sample, flags)) continue;
    sampled.push(sample);
  }

  // Group the `sampled` members by the canonical §17.1 key. `perfGroupKey` is
  // reused rather than rebuilt so grouping can never disagree with M1.1/M1.2.
  /** @type {Map<string, PerfSample[]>} */
  const byGroup = new Map();
  let overflowCount = 0;
  for (const sample of sampled) {
    const key = perfGroupKey(sample);
    if (key === null) continue;
    const group = byGroup.get(key);
    if (group !== undefined) group.push(sample);
    else byGroup.set(key, [sample]);
  }

  /** @type {PerfSummaryGroup[]} */
  const groups = [];
  for (const [groupKey, members] of byGroup) {
    const first = members[0];
    const n = members.length;

    let sumOutputTokens = 0;
    let sumDurationMs = 0;
    let sumsSafe = true;
    for (const member of members) {
      const output = /** @type {number} */ (member.outputTokens);
      const duration = /** @type {number} */ (member.durationMs);
      sumOutputTokens += output;
      sumDurationMs += duration;
      if (!isPerfSafeCount(sumOutputTokens) || !isPerfSafeCount(sumDurationMs)) sumsSafe = false;
    }

    // Raw, unrounded and ascending-by-construction for the quantile helper.
    const rates = members.map(
      (member) => /** @type {number} */ (member.outputTokens * 1000) / /** @type {number} */ (member.durationMs),
    );
    const durations = members.map((member) => /** @type {number} */ (member.durationMs));
    rates.sort((a, b) => a - b);
    durations.sort((a, b) => a - b);

    const overflow = !sumsSafe;
    if (overflow) overflowCount += 1;

    /** @type {PerfSummaryGroup} */
    const group = {
      groupKey,
      sourceKind: first.sourceKind,
      homeId: first.homeId,
      channel: first.channel,
      agentKind: first.agentKind,
      agent: first.agent,
      model: first.model,
      modelProvider: first.modelProvider,
      reasoningEffort: first.reasoningEffort,
      timingKind: first.timingKind,
      tokenScope: first.tokenScope,
      n,
      tps: overflow
        ? { p10: null, p50: null, p90: null, pooled: null }
        : {
            p10: perfNearestRank(rates, 0.1),
            p50: perfNearestRank(rates, 0.5),
            p90: perfNearestRank(rates, 0.9),
            pooled: (sumOutputTokens * 1000) / sumDurationMs,
          },
      // Never back-derived from the TPS quantiles (plan §17.2:227).
      durationMs: overflow
        ? { p50: null, p90: null }
        : { p50: perfNearestRank(durations, 0.5), p90: perfNearestRank(durations, 0.9) },
      sums: overflow
        ? { outputTokens: null, durationMs: null }
        : { outputTokens: sumOutputTokens, durationMs: sumDurationMs },
      state: overflow ? "overflow" : "ok",
      rank: null,
      insufficientSamples: n < minSamples,
      warnings: overflow ? ["AGGREGATE_OVERFLOW"] : [],
    };
    groups.push(group);
  }

  // Display order: unrounded p50 descending, then canonical key in code-unit order.
  // An overflow group has no p50, so it sorts last — it has no evidence to rank on,
  // which is the same reasoning that puts a missing value after a real one.
  groups.sort((a, b) => {
    const aP50 = a.tps.p50;
    const bP50 = b.tps.p50;
    if (aP50 === null && bP50 !== null) return 1;
    if (aP50 !== null && bP50 === null) return -1;
    if (aP50 !== null && bP50 !== null && aP50 !== bP50) return bP50 - aP50;
    return perfCodeUnitCompare(a.groupKey, b.groupKey);
  });

  // Ranking is only meaningful for groups that carry the minimum sample count;
  // an under-sampled group is kept and labelled but deliberately not numbered
  // (its rank stays `null`), so a low-n group can never masquerade as a rank.
  let nextRank = 1;
  for (const group of groups) {
    const members = byGroup.get(group.groupKey);
    if (
      group.insufficientSamples ||
      group.state === "overflow" ||
      members === undefined ||
      !members.every((member) => isPerfRankAdmitted(member))
    ) {
      continue;
    }
    group.rank = nextRank;
    nextRank += 1;
  }

  /** @type {{ sourceKind: string, homeId: string, code: string, count: number }[]} */
  const warnings = [];
  for (const entry of sourceWarnings) {
    const code = entry?.code;
    // Ruling Q: the seven M1 normalization codes are reader-internal return-value
    // diagnostics. Accepting them here would silently widen the frozen domain.
    if (!PERF_SOURCE_WARNING_CODES.has(code)) {
      throw new TypeError(`sourceWarnings.code ${String(code)} is outside the frozen §3:83 domain`);
    }
    warnings.push({ sourceKind: entry.sourceKind, homeId: entry.homeId, code, count: entry.count });
  }
  if (overflowCount > 0) {
    for (const group of groups) {
      if (group.state !== "overflow") continue;
      // `sourceWarnings` is keyed by sourceKind/homeId, so an overflow is attributed
      // to the group it was observed in rather than reported as a bare count.
      warnings.push({ sourceKind: group.sourceKind, homeId: group.homeId, code: "AGGREGATE_OVERFLOW", count: 1 });
    }
  }
  warnings.sort((a, b) => {
    const bySource = perfCodeUnitCompare(a.sourceKind, b.sourceKind);
    if (bySource !== 0) return bySource;
    const byHome = perfCodeUnitCompare(a.homeId, b.homeId);
    if (byHome !== 0) return byHome;
    return perfCodeUnitCompare(a.code, b.code);
  });

  const meta = {
    methodVersion: opts.meta?.methodVersion ?? PERF_METHOD_VERSION,
    state,
    indexVersion: opts.meta?.indexVersion ?? null,
    indexedAt: opts.meta?.indexedAt ?? null,
    minSamples,
    longWindowMs: opts.meta?.longWindowMs ?? PERF_LONG_WINDOW_MS,
    // The same resolved cut point the coverage used — never a re-read of the request,
    // so `meta` cannot report a cutoff other than the one that produced `byEra`.
    eraCutoffMs,
    sourceWarnings: warnings,
  };
  return {
    groups,
    models: projectPerfModels(sampled, minSamples, selection.eligible),
    coverage,
    codexTimingCoverage,
    meta,
  };
}
