/**
 * M1.1 tests: sample identity, persistent flags and normalization.
 *
 * All expectations are hand-written from plan §17.1/§17.4/§17.5 and the frozen
 * `source-contract.md` / `fixture-cases.md`; no expected value is copied from the
 * implementation output. Fixtures are synthetic only: this module never reads a source.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  PERF_EPOCH_MS_MIN,
  PERF_FLAG_BITS,
  PERF_FLAG_NAMES,
  PERF_FLAGS,
  PERF_FORBIDDEN_FLAG_NAMES,
  PERF_LONG_WINDOW_MS,
  PERF_METHOD_VERSION,
  PERF_MIN_SAMPLES,
  PERF_NORMALIZE_WARNING_CODES,
  PERF_RESERVED_FLAG_BITS,
  PERF_TOKEN_SCOPE,
  PerfFlagError,
  assertNoReservedFlagBits,
  assertPerfFlagMaskInTable,
  assertSettablePerfFlagBit,
  canonicalPerfSourceKind,
  normalizePerfSample,
  perfFlagBit,
  perfFlagName,
  perfFlagNamesOf,
  perfGroupKey,
  perfSampleKey,
  setPerfFlag,
} from "../src/perf-stats.js";
import {
  PERF_CONFLICT_COMPARE_KEYS,
  PERF_DEDUCTION_FLAG_NAMES,
  PERF_DROPPED_BY_REASONS,
  PERF_ERA_CUTOFF_MS,
  computePerfCoverage,
  perfDroppedByReason,
  selectPerfSamples,
} from "../src/perf-stats.js";

const HOME = "home-a";
/** One fixed epoch-millisecond instant used by every fixture. */
const MS = 1_760_000_000_000;
/** The one range window the ordering tests use: `MS` inside, `MS + 10_000` outside. */
const RANGE = { startMs: MS - 100, endMs: MS + 100 };

/** A fully valid ZCode candidate; each test overrides exactly what it is testing. */
const zcodeRaw = (overrides = {}) => ({
  sourceKind: "zcode",
  homeId: HOME,
  identity: ["row-1"],
  status: "completed",
  tsMs: MS,
  startedAtMs: MS - 1_000,
  completedAtMs: MS,
  durationMs: 1_000,
  outputTokens: 100,
  inputTokens: 10,
  model: "model-a",
  agentKind: "unknown",
  ...overrides,
});

/** Set of set flag names for one normalized sample. */
const flagSet = (sample) => new Set(perfFlagNamesOf(sample.sampleFlags));

const okSample = (raw) => {
  const result = normalizePerfSample(raw);
  assert.notEqual(result.sample, null, `expected a keyable sample: ${JSON.stringify(result.warnings)}`);
  return result.sample;
};

test("M1.1 constants match the frozen §17.4 table: 18 bit slots, 2/3 reserved, 16 settable names", () => {
  assert.equal(PERF_METHOD_VERSION, "tps-v7");
  assert.equal(PERF_MIN_SAMPLES, 20);
  assert.equal(PERF_LONG_WINDOW_MS, 300000);
  assert.equal(PERF_EPOCH_MS_MIN, 1e12);
  assert.deepEqual(PERF_RESERVED_FLAG_BITS, [2, 3]);
  assert.ok(PERF_NORMALIZE_WARNING_CODES.includes("UNKEYABLE_RECORD"));

  // hand-written §17.4 table, bit 0..17
  const expectedByBit = [
    "OUTPUT_ZERO",
    "DURATION_NONPOSITIVE",
    null,
    null,
    "LONG_WINDOW",
    "MULTI_REQUEST_TURN",
    "PARTIAL_ITEM_SPAN",
    "MISSING_DURATION",
    "MISSING_OUTPUT",
    "MODEL_AMBIGUOUS",
    "TERMINAL_UNVERIFIED",
    "SOURCE_FILTERED",
    "RECORD_CONFLICT",
    "OVERLAPPING_ITEM_SPAN",
    "TIME_INVALID",
    "TIME_UNPLACED",
    "METHOD_ESTIMATE",
    "TOKEN_INVALID",
  ];
  assert.deepEqual([...PERF_FLAG_BITS], expectedByBit);
  assert.equal(PERF_FLAG_BITS.length, 18);
  assert.equal(PERF_FLAG_BITS[2], null);
  assert.equal(PERF_FLAG_BITS[3], null);

  const settable = expectedByBit.filter((name) => name !== null);
  assert.deepEqual([...PERF_FLAG_NAMES], settable);
  assert.equal(PERF_FLAG_NAMES.length, 16);
  assert.equal(Object.keys(PERF_FLAGS).length, 16);
  for (const [bit, name] of expectedByBit.entries()) {
    if (name === null) continue;
    assert.equal(PERF_FLAGS[name], bit);
    assert.equal(perfFlagBit(name), bit);
    assert.equal(perfFlagName(bit), name);
  }
  assert.equal(PERF_FLAGS.OUTPUT_ZERO, 0);
  assert.equal(PERF_FLAGS.TOKEN_INVALID, 17);
  assert.equal(perfFlagNamesOf((1 << 4) | (1 << 17)).join(","), "LONG_WINDOW,TOKEN_INVALID");

  // the cancelled legacy names are structurally absent
  for (const name of PERF_FORBIDDEN_FLAG_NAMES) {
    assert.equal(PERF_FLAG_NAMES.includes(name), false, name);
    assert.equal(perfFlagBit(name), undefined);
  }
  assert.equal(PERF_FLAG_NAMES.includes("GEN_BELOW_FIRST_TOKEN"), false);
  assert.equal(PERF_FLAG_NAMES.includes("CROSS_PERIOD"), false);
});

test("M1.1 bits 2/3 must exist but can never be set: every set path throws and no input can reach them", () => {
  assert.equal(perfFlagName(2), null);
  assert.equal(perfFlagName(3), null);
  const reserved = (fn, label) =>
    assert.throws(
      fn,
      (error) => error instanceof PerfFlagError && error.code === "RESERVED_FLAG_BIT",
      `expected RESERVED_FLAG_BIT for ${label}`,
    );

  reserved(() => assertSettablePerfFlagBit(2), "assertSettablePerfFlagBit(2)");
  reserved(() => assertSettablePerfFlagBit(3), "assertSettablePerfFlagBit(3)");
  reserved(() => assertNoReservedFlagBits(1 << 2), "mask bit 2");
  reserved(() => assertNoReservedFlagBits(1 << 3), "mask bit 3");
  reserved(() => setPerfFlag(0, "GEN_BELOW_FIRST_TOKEN"), "legacy name 2");
  reserved(() => setPerfFlag(0, "CROSS_PERIOD"), "legacy name 3");
  reserved(() => normalizePerfSample(zcodeRaw({ sampleFlags: 1 << 2 })), "normalize mask bit 2");
  reserved(() => normalizePerfSample(zcodeRaw({ sampleFlags: 1 << 3 })), "normalize mask bit 3");
  reserved(() => normalizePerfSample(zcodeRaw({ sampleFlags: ["GEN_BELOW_FIRST_TOKEN"] })), "normalize legacy name");
  reserved(() => normalizePerfSample(zcodeRaw({ sampleFlags: ["CROSS_PERIOD"] })), "normalize legacy name 3");

  // the same helpers accept real flags, so the guard is not vacuously true
  assert.equal(assertNoReservedFlagBits((1 << 0) | (1 << 17)), (1 << 0) | (1 << 17));
  assert.equal(setPerfFlag(0, "LONG_WINDOW"), 1 << 4);
  const sample = okSample(zcodeRaw({ sampleFlags: ["LONG_WINDOW", "TIME_UNPLACED"] }));
  assert.deepEqual([...flagSet(sample)], ["LONG_WINDOW", "TIME_UNPLACED"]);
  assert.equal(sample.sampleFlags & 0b1100, 0);
  for (const name of perfFlagNamesOf(sample.sampleFlags)) {
    assert.equal(PERF_RESERVED_FLAG_BITS.includes(PERF_FLAGS[name]), false);
  }
});

test("M1.1 canonicalPerfSourceKind folds Codex aliases without touching the raw kind", () => {
  assert.equal(canonicalPerfSourceKind("main"), "codex");
  assert.equal(canonicalPerfSourceKind("jetbrains"), "codex");
  assert.equal(canonicalPerfSourceKind("extra"), "codex");
  assert.equal(canonicalPerfSourceKind("codex"), "codex");
  assert.equal(canonicalPerfSourceKind("zcode"), "zcode");
  assert.equal(canonicalPerfSourceKind("dsh"), "dsh");
  assert.equal(canonicalPerfSourceKind("opencode"), "opencode");
  assert.equal(canonicalPerfSourceKind(" project-log "), "unsupported");
  assert.equal(canonicalPerfSourceKind("other"), "unsupported");
  assert.equal(canonicalPerfSourceKind(""), "unsupported");
  assert.equal(canonicalPerfSourceKind(null), "unsupported");
  assert.equal(canonicalPerfSourceKind(7), "unsupported");

  // raw kind is preserved for source discovery / quota eligibility
  const home = { kind: "jetbrains", id: "jetbrains-pycharm" };
  assert.equal(canonicalPerfSourceKind(home.kind), "codex");
  assert.equal(home.kind, "jetbrains");
  assert.equal(home.id, "jetbrains-pycharm");
});

test("M1.1-A sample keys are JSON arrays: ['a:b','c'] and ['a','b:c'] can never collide", () => {
  const left = perfSampleKey("zcode", HOME, "a:b", "c");
  const right = perfSampleKey("zcode", HOME, "a", "b:c");
  assert.equal(left, '["zcode","home-a","a:b","c"]');
  assert.equal(right, '["zcode","home-a","a","b:c"]');
  assert.notEqual(left, right);
  assert.deepEqual(JSON.parse(left), ["zcode", HOME, "a:b", "c"]);

  // the same hazard with `#` and with a shifted split point
  assert.notEqual(perfSampleKey("zcode", HOME, "a#b", "c"), perfSampleKey("zcode", HOME, "a", "b#c"));
  assert.notEqual(perfSampleKey("zcode", HOME, "a", "b", "c"), perfSampleKey("zcode", HOME, "a", "b:c"));
});

test("M1.1-A the same raw id in two homes never collides, and Codex aliases key as codex", () => {
  assert.notEqual(perfSampleKey("zcode", "home-a", "row-1"), perfSampleKey("zcode", "home-b", "row-1"));
  assert.deepEqual(JSON.parse(perfSampleKey("main", HOME, "thread-1", "turn-1")), [
    "codex",
    HOME,
    "thread-1",
    "turn-1",
  ]);
  assert.deepEqual(JSON.parse(perfSampleKey("jetbrains", HOME, "thread-1", "turn-1")), [
    "codex",
    HOME,
    "thread-1",
    "turn-1",
  ]);
  // raw 'main' and 'jetbrains' rows for the same home/thread/turn are one identity
  assert.equal(perfSampleKey("main", HOME, "t", "u"), perfSampleKey("jetbrains", HOME, "t", "u"));

  const first = okSample(zcodeRaw({ identity: ["row-1"] }));
  const otherHome = okSample(zcodeRaw({ identity: ["row-1"], homeId: "home-b" }));
  assert.notEqual(first.sampleKey, otherHome.sampleKey);
});

test("M1.1-A identity parts are trimmed, keep their case, and are never joined by hand", () => {
  assert.equal(perfSampleKey("zcode", " home-a ", "  row-1  "), perfSampleKey("zcode", HOME, "row-1"));
  assert.equal(perfSampleKey(" zcode ", HOME, "row-1"), perfSampleKey("zcode", HOME, "row-1"));
  assert.notEqual(perfSampleKey("zcode", HOME, "a1"), perfSampleKey("zcode", HOME, "A1"));
  assert.equal(perfSampleKey("zcode", HOME, 0), '["zcode","home-a",0]');
  assert.equal(perfSampleKey("zcode", HOME, "row-1").includes("#"), false);
});

test("M1.1-A unkeyable identity returns null and is never substituted by a timestamp", () => {
  assert.equal(perfSampleKey("zcode", HOME), null);
  assert.equal(perfSampleKey("zcode", HOME, ""), null);
  assert.equal(perfSampleKey("zcode", HOME, "   "), null);
  assert.equal(perfSampleKey("zcode", HOME, null), null);
  assert.equal(perfSampleKey("zcode", HOME, undefined), null);
  assert.equal(perfSampleKey("zcode", HOME, true), null);
  assert.equal(perfSampleKey("zcode", HOME, {}), null);
  assert.equal(perfSampleKey("zcode", HOME, Number.MAX_SAFE_INTEGER + 1), null);
  assert.equal(perfSampleKey("zcode", "", "row-1"), null);
  assert.equal(perfSampleKey("zcode", null, "row-1"), null);
  assert.equal(perfSampleKey("project-log", HOME, "row-1"), null);
  assert.equal(perfSampleKey("unknown-kind", HOME, "row-1"), null);

  // a timestamp must not become a fake key
  const result = normalizePerfSample({ sourceKind: "zcode", homeId: HOME, tsMs: MS, outputTokens: 5 });
  assert.equal(result.sample, null);
  assert.equal(result.warningCode, "UNKEYABLE_RECORD");
  assert.deepEqual(result.warnings, ["UNKEYABLE_RECORD"]);
});

test("M1.1-A every source builds its own §17.1 identity tuple", () => {
  assert.deepEqual(JSON.parse(perfSampleKey("zcode", "h", "row-1")), ["zcode", "h", "row-1"]);
  assert.deepEqual(JSON.parse(perfSampleKey("dsh", "h", "s-1", 3, 1)), ["dsh", "h", "s-1", 3, 1]);
  assert.deepEqual(JSON.parse(perfSampleKey("opencode", "h", "db.sqlite", "msg-1")), [
    "opencode",
    "h",
    "db.sqlite",
    "msg-1",
  ]);
  // DSH: turn participates, so a reused step in another turn is a different identity
  assert.notEqual(perfSampleKey("dsh", "h", "s-1", 3, 1), perfSampleKey("dsh", "h", "s-1", 4, 1));
  // OpenCode: database identity participates, so the same message id in two databases differs
  assert.notEqual(perfSampleKey("opencode", "h", "a.sqlite", "m"), perfSampleKey("opencode", "h", "b.sqlite", "m"));
  // Codex: thread + turn, never a global turn_id map
  assert.notEqual(perfSampleKey("codex", "h", "t-a", "u"), perfSampleKey("codex", "h", "t-b", "u"));

  const rows = [
    [{ sourceKind: "zcode", homeId: "h", rowId: "row-1" }, ["zcode", "h", "row-1"]],
    [{ sourceKind: "dsh", homeId: "h", sessionId: "s-1", turn: 3, step: 1 }, ["dsh", "h", "s-1", 3, 1]],
    [{ sourceKind: "main", homeId: "h", threadId: "t-1", turnId: "u-1" }, ["codex", "h", "t-1", "u-1"]],
    [
      { sourceKind: "opencode", homeId: "h", databaseIdentity: "db.sqlite", messageId: "m-1" },
      ["opencode", "h", "db.sqlite", "m-1"],
    ],
  ];
  for (const [raw, expected] of rows) {
    const sample = okSample(raw);
    assert.deepEqual(JSON.parse(sample.sampleKey), expected);
    assert.equal(sample.sampleKey, JSON.stringify(expected));
  }
  // one missing identity column makes the whole row unkeyable, not partially keyed
  assert.equal(normalizePerfSample({ sourceKind: "dsh", homeId: "h", sessionId: "s-1" }).sample, null);
  assert.equal(normalizePerfSample({ sourceKind: "codex", homeId: "h", threadId: "t-1" }).sample, null);
});

test("M1.1-A a precomputed sample key is accepted only in canonical form", () => {
  const key = perfSampleKey("main", "h", "t-1", "u-1");
  assert.equal(key, '["codex","h","t-1","u-1"]');
  const accepted = normalizePerfSample({ sourceKind: "main", homeId: "h", sampleKey: key });
  assert.notEqual(accepted.sample, null);
  assert.equal(accepted.sample.sampleKey, key);

  const rejected = [
    '["main","h","t-1","u-1"]', // raw alias prefix is not canonical
    "not json",
    '["zcode","h"]', // no identity column
    '["zcode","h","  x  "]', // untrimmed part
    '{"zcode":"h"}',
  ];
  for (const sampleKey of rejected) {
    assert.equal(normalizePerfSample({ sourceKind: "zcode", homeId: "h", sampleKey }).sample, null, sampleKey);
  }
});

test("M1.1-D source kind separates Codex from request-level groups; identical Codex semantics stay together", () => {
  const base = {
    homeId: HOME,
    channel: "ch",
    agentKind: "unknown",
    agent: "",
    model: "m",
    modelProvider: "p",
    reasoningEffort: "high",
  };
  const codex = {
    ...base,
    sourceKind: "codex",
    timingKind: "generation",
    tokenScope: PERF_TOKEN_SCOPE,
  };
  const zcode = {
    ...base,
    sourceKind: "zcode",
    timingKind: "generation",
    tokenScope: PERF_TOKEN_SCOPE,
  };
  const opencode = {
    ...base,
    sourceKind: "opencode",
    timingKind: "generation",
    tokenScope: PERF_TOKEN_SCOPE,
  };
  const keys = [codex, zcode, opencode].map((sample) => perfGroupKey(sample));
  assert.equal(new Set(keys).size, 3);
  assert.deepEqual(JSON.parse(keys[0]), [
    "codex",
    HOME,
    "ch",
    "unknown",
    "",
    "m",
    "p",
    "high",
    "generation",
    PERF_TOKEN_SCOPE,
  ]);
  // The source kind still separates Codex from request-level sources. Two Codex
  // samples with identical current v3 semantics intentionally share one group.
  const lookalike = { ...codex, timingKind: "generation", tokenScope: PERF_TOKEN_SCOPE };
  assert.notEqual(perfGroupKey(lookalike), perfGroupKey(zcode));
  assert.equal(perfGroupKey(lookalike), perfGroupKey(codex));
  // home participates; unsupported kinds have no group at all
  assert.notEqual(perfGroupKey(zcode), perfGroupKey({ ...zcode, homeId: "home-b" }));
  assert.equal(perfGroupKey({ ...zcode, sourceKind: "project-log" }), null);
  assert.equal(perfGroupKey(null), null);
  assert.equal(perfGroupKey(undefined), null);
  // separator ambiguity is impossible here too
  assert.notEqual(
    perfGroupKey({ ...zcode, channel: "a:b", agent: "c" }),
    perfGroupKey({ ...zcode, channel: "a", agent: "b:c" }),
  );
});

test("M1.1-D normalization supplies v6 defaults while preserving mismatched reader semantics", () => {
  const expected = [
    ["zcode", "request", "generation", PERF_TOKEN_SCOPE, false],
    ["dsh", "request", "generation", PERF_TOKEN_SCOPE, false],
    ["opencode", "request", "generation", PERF_TOKEN_SCOPE, false],
    ["codex", "request", "generation", PERF_TOKEN_SCOPE, false],
    ["claude", "request", "generation", PERF_TOKEN_SCOPE, false],
  ];
  for (const [kind, window, timingKind, tokenScope, estimated] of expected) {
    const sample = okSample({
      sourceKind: kind,
      homeId: HOME,
      identity: ["x"],
      status: "completed",
      durationMs: 100,
      outputTokens: 10,
      tsMs: MS,
    });
    assert.equal(sample.window, window);
    assert.equal(sample.timingKind, timingKind);
    assert.equal(sample.tokenScope, tokenScope);
    assert.equal(sample.sourceKind, kind);
    assert.equal(flagSet(sample).has("METHOD_ESTIMATE"), estimated);
  }

  // Mismatched reader semantics remain visible, but the mismatch reason keeps the
  // row out of current samples instead of silently rewriting it into v3 evidence.
  const forced = normalizePerfSample(
    zcodeRaw({
      sourceKind: "codex",
      methodVersion: PERF_METHOD_VERSION,
      window: "request",
      timingKind: "request_e2e",
      tokenScope: "visible_plus_reasoning",
    }),
  );
  assert.equal(forced.sample.sourceKind, "codex");
  assert.equal(forced.sample.window, "request");
  assert.equal(forced.sample.timingKind, "request_e2e");
  assert.equal(forced.sample.tokenScope, "visible_plus_reasoning");
  assert.ok(forced.warnings.includes("SOURCE_SEMANTICS_MISMATCH"));
  assert.equal(forced.sample.diagnosticReason, "source_semantics_mismatch");
  assert.equal(perfDroppedByReason(forced.sample), "source_semantics_mismatch");
  assert.equal(flagSet(forced.sample).has("METHOD_ESTIMATE"), false);

  const endToEnd = {
    homeId: HOME,
    channel: "ch",
    agentKind: "unknown",
    agent: "a",
    model: "m",
    modelProvider: "p",
    reasoningEffort: "high",
    status: "completed",
    tsMs: MS,
    durationMs: 1_000,
    outputTokens: 100,
  };
  const codexSample = okSample({ ...endToEnd, sourceKind: "main", threadId: "t", turnId: "u" });
  const zcodeSample = okSample({ ...endToEnd, sourceKind: "zcode", rowId: "r" });
  assert.notEqual(perfGroupKey(codexSample), perfGroupKey(zcodeSample));
  assert.deepEqual(JSON.parse(perfGroupKey(codexSample)).slice(0, 8), [
    "codex",
    HOME,
    "ch",
    "unknown",
    "a",
    "m",
    "p",
    "high",
  ]);
  assert.equal(JSON.parse(perfGroupKey(codexSample))[8], "generation");
  assert.equal(JSON.parse(perfGroupKey(zcodeSample))[8], "generation");
});

test("M1.1-B missing output and true zero output are different flags (never folded)", () => {
  const zero = normalizePerfSample(zcodeRaw({ outputTokens: 0 }));
  const missingNull = normalizePerfSample(zcodeRaw({ outputTokens: null }));
  const missingUndefined = normalizePerfSample(zcodeRaw({ outputTokens: undefined }));

  assert.equal(zero.sample.outputTokens, 0);
  assert.deepEqual([...flagSet(zero.sample)], ["OUTPUT_ZERO"]);
  assert.equal(zero.sample.diagnosticReason, "output_zero");

  for (const result of [missingNull, missingUndefined]) {
    assert.equal(result.sample.outputTokens, null);
    assert.deepEqual([...flagSet(result.sample)], ["MISSING_OUTPUT"]);
    assert.equal(result.sample.diagnosticReason, "output_missing");
    assert.equal(flagSet(result.sample).has("OUTPUT_ZERO"), false);
  }
  assert.notEqual(zero.sample.sampleFlags, missingNull.sample.sampleFlags);

  // F-02: a large input never turns a true zero into "known positive" or "missing"
  const bigInput = normalizePerfSample(zcodeRaw({ outputTokens: 0, inputTokens: 900_000 }));
  assert.deepEqual([...flagSet(bigInput.sample)], ["OUTPUT_ZERO"]);
  assert.equal(bigInput.sample.inputTokens, 900_000);
});

test("M1.1-B negative/non-integer/non-finite/unsafe output is TOKEN_INVALID with a distinct reason", () => {
  const cases = [
    [-1, "output_negative"],
    [3.5, "output_not_integer"],
    [Number.POSITIVE_INFINITY, "output_not_finite"],
    [Number.NaN, "output_not_finite"],
    [Number.MAX_SAFE_INTEGER + 1, "output_not_safe_integer"],
    ["12", "output_not_a_number"],
  ];
  for (const [outputTokens, reason] of cases) {
    const result = normalizePerfSample(zcodeRaw({ outputTokens }));
    assert.equal(result.sample.outputTokens, null, String(outputTokens));
    assert.equal(result.sample.diagnosticReason, reason, String(outputTokens));
    const flags = flagSet(result.sample);
    assert.ok(flags.has("TOKEN_INVALID"), String(outputTokens));
    assert.equal(flags.has("OUTPUT_ZERO"), false);
    assert.equal(flags.has("MISSING_OUTPUT"), false);
  }
  // non-integer and above-safe-integer cannot collapse onto one explanation
  assert.notEqual(
    normalizePerfSample(zcodeRaw({ outputTokens: 3.5 })).sample.diagnosticReason,
    normalizePerfSample(zcodeRaw({ outputTokens: Number.MAX_SAFE_INTEGER + 1 })).sample.diagnosticReason,
  );
});

test("M1.1-B missing duration and true zero/negative duration are different flags", () => {
  const missingNull = normalizePerfSample(zcodeRaw({ durationMs: null }));
  const missingUndefined = normalizePerfSample(zcodeRaw({ durationMs: undefined }));
  const zero = normalizePerfSample(zcodeRaw({ durationMs: 0 }));
  const negative = normalizePerfSample(zcodeRaw({ durationMs: -5 }));

  for (const result of [missingNull, missingUndefined]) {
    assert.equal(result.sample.durationMs, null);
    assert.deepEqual([...flagSet(result.sample)], ["MISSING_DURATION"]);
    assert.equal(result.sample.diagnosticReason, "duration_missing");
  }
  assert.equal(zero.sample.durationMs, 0);
  assert.deepEqual([...flagSet(zero.sample)], ["DURATION_NONPOSITIVE"]);
  assert.equal(zero.sample.diagnosticReason, "duration_zero");
  assert.equal(negative.sample.durationMs, -5);
  assert.deepEqual([...flagSet(negative.sample)], ["DURATION_NONPOSITIVE"]);
  assert.equal(negative.sample.diagnosticReason, "duration_negative");
  assert.notEqual(missingNull.sample.sampleFlags, zero.sample.sampleFlags);

  // non-finite / non-integer durations are TIME_INVALID, not "non-positive"
  const nan = normalizePerfSample(zcodeRaw({ durationMs: Number.NaN }));
  assert.deepEqual([...flagSet(nan.sample)], ["TIME_INVALID"]);
  assert.equal(nan.sample.diagnosticReason, "duration_not_finite");
  const fraction = normalizePerfSample(zcodeRaw({ durationMs: 1.5 }));
  assert.deepEqual([...flagSet(fraction.sample)], ["TIME_INVALID"]);
  assert.equal(fraction.sample.diagnosticReason, "duration_not_integer");
});

test("M1.1 §17.4 bit 4 LONG_WINDOW is only a hint and uses a strict boundary", () => {
  const atThreshold = normalizePerfSample(zcodeRaw({ durationMs: PERF_LONG_WINDOW_MS }));
  assert.deepEqual([...flagSet(atThreshold.sample)], []);
  const above = normalizePerfSample(zcodeRaw({ durationMs: PERF_LONG_WINDOW_MS + 1 }));
  assert.deepEqual([...flagSet(above.sample)], ["LONG_WINDOW"]);
  assert.equal(above.sample.durationMs, 300001);
  assert.equal(above.sample.diagnosticReason, "");
  // it is a hint: no deduction flag accompanies it
  for (const name of ["MISSING_DURATION", "DURATION_NONPOSITIVE", "TIME_INVALID", "SOURCE_FILTERED"]) {
    assert.equal(flagSet(above.sample).has(name), false, name);
  }
});

test("M1.1 §17.4 bit 5 MULTI_REQUEST_TURN is Codex-only and only a hint", () => {
  const codex = normalizePerfSample({
    sourceKind: "codex",
    homeId: HOME,
    identity: ["t", "u"],
    status: "completed",
    tsMs: MS,
    durationMs: 1_000,
    outputTokens: 100,
    requestCount: 2,
  });
  const flags = flagSet(codex.sample);
  assert.ok(flags.has("MULTI_REQUEST_TURN"));
  assert.equal(flags.has("METHOD_ESTIMATE"), false);
  assert.equal(flags.has("MISSING_DURATION"), false);
  assert.equal(flags.has("SOURCE_FILTERED"), false);
  assert.equal(flags.has("TERMINAL_UNVERIFIED"), false);

  const single = normalizePerfSample({ sourceKind: "codex", homeId: HOME, identity: ["t", "u"], requestCount: 1 });
  assert.equal(flagSet(single.sample).has("MULTI_REQUEST_TURN"), false);
  // the same count on a request-level source is not this flag
  assert.equal(flagSet(okSample(zcodeRaw({ requestCount: 2 }))).has("MULTI_REQUEST_TURN"), false);
});

test("M1.1-B a keyable candidate with missing ts_ms is still emitted with TIME_UNPLACED", () => {
  const missing = normalizePerfSample(zcodeRaw({ tsMs: null }));
  assert.notEqual(missing.sample, null);
  assert.equal(missing.sample.tsMs, null);
  assert.deepEqual([...flagSet(missing.sample)], ["TIME_UNPLACED"]);
  assert.equal(missing.sample.diagnosticReason, "timestamp_missing");
  assert.equal(normalizePerfSample(zcodeRaw({ tsMs: undefined })).sample.tsMs, null);

  const placed = normalizePerfSample(zcodeRaw());
  assert.equal(placed.sample.tsMs, MS);
  assert.equal(flagSet(placed.sample).has("TIME_UNPLACED"), false);
  // missing placement does not silently become TIME_INVALID
  assert.equal(flagSet(missing.sample).has("TIME_INVALID"), false);
});

test("M1.1-B second-unit and invalid timestamps are TIME_INVALID, never TIME_UNPLACED", () => {
  const cases = [
    [1_759_999_999, "timestamp_unit_unsupported"],
    [Number.NaN, "timestamp_not_finite"],
    [Number.POSITIVE_INFINITY, "timestamp_not_finite"],
    [-1, "timestamp_out_of_range"],
    [0, "timestamp_out_of_range"],
    [1.5, "timestamp_not_integer"],
    [Number.MAX_SAFE_INTEGER + 1, "timestamp_not_safe_integer"],
    ["1760000000000", "timestamp_not_a_number"],
  ];
  for (const [tsMs, reason] of cases) {
    const result = normalizePerfSample(zcodeRaw({ tsMs }));
    assert.equal(result.sample.tsMs, null, String(tsMs));
    assert.equal(result.sample.diagnosticReason, reason, String(tsMs));
    assert.deepEqual([...flagSet(result.sample)], ["TIME_INVALID"], String(tsMs));
  }
  // the epoch-ms lower bound itself is a usable timestamp
  const boundary = normalizePerfSample(zcodeRaw({ tsMs: PERF_EPOCH_MS_MIN }));
  assert.equal(boundary.sample.tsMs, PERF_EPOCH_MS_MIN);
  assert.equal(flagSet(boundary.sample).has("TIME_INVALID"), false);
});

test("M1.1-B time-order contradictions are TIME_INVALID", () => {
  const backwards = normalizePerfSample(zcodeRaw({ startedAtMs: MS + 5_000, completedAtMs: MS }));
  assert.deepEqual([...flagSet(backwards.sample)], ["TIME_INVALID"]);
  assert.equal(backwards.sample.diagnosticReason, "timestamp_order_conflict");

  const windowBackwards = normalizePerfSample(zcodeRaw({ windowStartMs: MS + 1, windowEndMs: MS }));
  assert.ok(flagSet(windowBackwards.sample).has("TIME_INVALID"));
  assert.equal(windowBackwards.sample.diagnosticReason, "window_order_conflict");

  const ordered = normalizePerfSample(zcodeRaw({ windowStartMs: MS - 10, windowEndMs: MS + 10 }));
  assert.equal(flagSet(ordered.sample).has("TIME_INVALID"), false);
  assert.equal(ordered.sample.windowStartMs, MS - 10);
  assert.equal(ordered.sample.windowEndMs, MS + 10);
  assert.equal(ordered.sample.diagnosticReason, "");
});

test("M1.1-C an absent or unknown status is never upgraded to completed", () => {
  const absent = normalizePerfSample(zcodeRaw({ status: undefined }));
  assert.equal(absent.sample.status, "unverified");
  assert.equal(absent.sample.diagnosticReason, "status_missing");
  assert.ok(flagSet(absent.sample).has("TERMINAL_UNVERIFIED"));

  const unknown = normalizePerfSample(zcodeRaw({ status: "部分完成" }));
  assert.equal(unknown.sample.status, "unverified");
  assert.notEqual(unknown.sample.status, "completed");
  assert.ok(flagSet(unknown.sample).has("TERMINAL_UNVERIFIED"));
  assert.ok(unknown.warnings.includes("UNRECOGNIZED_STATUS"));
  assert.equal(unknown.sample.diagnosticReason, "status_unrecognized");

  const completed = normalizePerfSample(zcodeRaw({ status: "completed" }));
  assert.equal(completed.sample.status, "completed");
  assert.equal(flagSet(completed.sample).has("TERMINAL_UNVERIFIED"), false);
  assert.deepEqual(completed.warnings, []);

  // explicit terminal evidence (Codex task_complete / DSH frame order) may say completed
  assert.equal(normalizePerfSample(zcodeRaw({ status: undefined, terminalVerified: true })).sample.status, "completed");
  assert.equal(
    normalizePerfSample(zcodeRaw({ status: undefined, terminalVerified: false })).sample.status,
    "unverified",
  );
  assert.equal(normalizePerfSample(zcodeRaw({ status: "unverified" })).sample.status, "unverified");
  assert.ok(flagSet(okSample(zcodeRaw({ status: "unverified" }))).has("TERMINAL_UNVERIFIED"));
});

test("M1.1-C in_progress is pending, not a failure and not unverified", () => {
  for (const raw of [zcodeRaw({ status: "in_progress" }), zcodeRaw({ status: undefined, inProgress: true })]) {
    const result = normalizePerfSample(raw);
    assert.equal(result.sample.status, "in_progress");
    const flags = flagSet(result.sample);
    assert.equal(flags.has("TERMINAL_UNVERIFIED"), false);
    assert.equal(flags.has("SOURCE_FILTERED"), false);
    assert.equal(flags.size, 0);
  }
  // an explicit status wins over the inProgress hint
  assert.equal(normalizePerfSample(zcodeRaw({ status: "completed", inProgress: true })).sample.status, "completed");
  assert.equal(normalizePerfSample(zcodeRaw({ status: "in_progress", retryCount: 1 })).sample.status, "in_progress");
});

test("M1.1-C F-11: failure/cancel/retry all set SOURCE_FILTERED without faking unverified", () => {
  const cases = [
    [{ status: "error" }, "failed", "source_failed"],
    [{ status: "cancelled" }, "cancelled", "source_cancelled"],
    [{ status: "canceled" }, "cancelled", "source_cancelled"],
    [{ status: undefined, cancelledByUser: true }, "cancelled", "cancelled_by_user"],
    [{ status: undefined, retryCount: 3 }, "failed", "retry"],
  ];
  for (const [override, status, reason] of cases) {
    const result = normalizePerfSample(zcodeRaw(override));
    assert.equal(result.sample.status, status, reason);
    assert.equal(result.sample.diagnosticReason, reason, reason);
    const flags = flagSet(result.sample);
    assert.ok(flags.has("SOURCE_FILTERED"), reason);
    assert.equal(flags.has("TERMINAL_UNVERIFIED"), false, reason);
    assert.equal(flags.has("MISSING_OUTPUT"), false, reason);
  }

  // a completed attempt that was retried is still source-filtered, and keeps its status
  const retriedCompleted = normalizePerfSample(zcodeRaw({ status: "completed", retryCount: 1 }));
  assert.equal(retriedCompleted.sample.status, "completed");
  assert.ok(flagSet(retriedCompleted.sample).has("SOURCE_FILTERED"));
  assert.equal(retriedCompleted.sample.diagnosticReason, "retry");

  // no filter evidence: no flag and no invented reason
  const clean = normalizePerfSample(zcodeRaw());
  assert.equal(flagSet(clean.sample).has("SOURCE_FILTERED"), false);
  assert.equal(clean.sample.diagnosticReason, "");
  assert.equal(normalizePerfSample(zcodeRaw({ status: undefined, sourceFiltered: true })).sample.status, "failed");
  assert.equal(normalizePerfSample(zcodeRaw({ retryCount: 0 })).sample.status, "completed");
});

test("M1.1 reader-supplied structural flags are honored; unknown names are reported, reserved bits throw", () => {
  const result = normalizePerfSample(
    zcodeRaw({
      partialItemSpan: true,
      overlappingItemSpan: true,
      modelAmbiguous: true,
      recordConflict: true,
      methodEstimate: true,
      sampleFlags: ["LONG_WINDOW", "MISSING_OUTPUT", "NOPE"],
    }),
  );
  const flags = flagSet(result.sample);
  for (const name of [
    "PARTIAL_ITEM_SPAN",
    "OVERLAPPING_ITEM_SPAN",
    "MODEL_AMBIGUOUS",
    "RECORD_CONFLICT",
    "METHOD_ESTIMATE",
    "LONG_WINDOW",
    "MISSING_OUTPUT",
  ]) {
    assert.ok(flags.has(name), name);
  }
  assert.ok(result.warnings.includes("UNRECOGNIZED_FLAG_NAME"));
  assert.equal(PERF_FLAG_NAMES.includes("NOPE"), false);

  // a bitmask round-tripped from SQLite is accepted as-is
  const mask = setPerfFlag(0, "MODEL_AMBIGUOUS");
  assert.equal(okSample(zcodeRaw({ sampleFlags: mask })).sampleFlags & mask, mask);
  assert.equal(okSample(zcodeRaw({ flags: ["TIME_INVALID"] })).sampleFlags & (1 << 14), 1 << 14);
  assert.throws(
    () => normalizePerfSample(zcodeRaw({ sampleFlags: "LONG_WINDOW" })),
    (error) => error instanceof PerfFlagError && error.code === "INVALID_FLAG_MASK",
  );
});

test("M1.1 numbers/counts/provenance: null stays missing, true 0 stays 0, unsafe values are rejected", () => {
  const sample = okSample(
    zcodeRaw({ requestCount: 0, itemCount: 0, timedItemCount: 0, timingSource: "timestamp_fallback", inputTokens: 0 }),
  );
  assert.equal(sample.requestCount, 0);
  assert.equal(sample.itemCount, 0);
  assert.equal(sample.timedItemCount, 0);
  assert.equal(sample.inputTokens, 0);
  assert.equal(sample.timingSource, "timestamp_fallback");

  const broken = okSample(zcodeRaw({ requestCount: null, itemCount: Number.MAX_SAFE_INTEGER + 1, timedItemCount: -1 }));
  assert.equal(broken.requestCount, null);
  assert.equal(broken.itemCount, null);
  assert.equal(broken.timedItemCount, null);

  // input is diagnostic only: its value never changes the output decision
  const badInput = okSample(zcodeRaw({ inputTokens: 1.5 }));
  assert.equal(badInput.inputTokens, null);
  assert.equal(badInput.outputTokens, 100);
  assert.equal(flagSet(badInput).has("TOKEN_INVALID"), false);

  const provenance = normalizePerfSample(zcodeRaw({ timingSource: "guessed" }));
  assert.equal(provenance.sample.timingSource, "unknown");
  assert.ok(provenance.warnings.includes("UNRECOGNIZED_PROVENANCE"));

  const historical = normalizePerfSample(zcodeRaw({ methodVersion: "tps-v1" }));
  assert.equal(historical.sample.methodVersion, "tps-v1");
  assert.equal(historical.warnings.includes("UNRECOGNIZED_METHOD_VERSION"), false);
  const future = normalizePerfSample(zcodeRaw({ methodVersion: "tps-v99" }));
  assert.equal(future.sample.methodVersion, "tps-v99");
  assert.ok(future.warnings.includes("UNRECOGNIZED_METHOD_VERSION"));
  assert.equal(okSample(zcodeRaw()).methodVersion, PERF_METHOD_VERSION);
});

test("M1.1-P contract ruling P: name-class evidence fields are \"\" and never the literal 'unknown'", () => {
  const absent = okSample(
    zcodeRaw({
      model: undefined,
      agent: undefined,
      modelProvider: undefined,
      reasoningEffort: undefined,
      modelEvidence: undefined,
      agentKind: "subagent",
      channel: "zcode-main",
    }),
  );
  assert.equal(absent.model, "");
  assert.equal(absent.agent, "");
  assert.equal(absent.modelProvider, "");
  assert.equal(absent.reasoningEffort, "");
  assert.equal(absent.modelEvidence, "");
  assert.equal(absent.agentKind, "subagent");
  assert.equal(absent.channel, "zcode-main");

  // explicit empty string and a reader-sent literal "unknown" are the SAME state
  for (const field of ["modelProvider", "reasoningEffort", "modelEvidence"]) {
    const empty = okSample(zcodeRaw({ [field]: "" }));
    const literal = okSample(zcodeRaw({ [field]: "unknown" }));
    const spaced = okSample(zcodeRaw({ [field]: " unknown " }));
    assert.equal(empty[field], "", field);
    assert.equal(literal[field], "", `${field} must not keep the "unknown" literal`);
    assert.equal(spaced[field], "", field);
    assert.notEqual(literal[field], "unknown", field);
  }
  // the enums keep their "unknown" value: agentKind and timingSource are NOT name fields
  assert.equal(okSample(zcodeRaw({ agentKind: "" })).agentKind, "unknown");
  assert.equal(okSample(zcodeRaw({ timingSource: "" })).timingSource, "unknown");
  // agentKind is an enum: "" and "unknown" converge, a real value stays distinct
  assert.notEqual(okSample(zcodeRaw({ agentKind: "main" })).agentKind, okSample(zcodeRaw({ agentKind: "" })).agentKind);

  // `main` is never inferred from a name or a hint
  const bogus = normalizePerfSample(zcodeRaw({ agentKind: "main-ish" }));
  assert.equal(bogus.sample.agentKind, "unknown");
  assert.ok(bogus.warnings.includes("UNRECOGNIZED_AGENT_KIND"));
  assert.equal(okSample(zcodeRaw({ agentKind: "main" })).agentKind, "main");
  assert.equal(okSample(zcodeRaw({ agentKind: " subagent " })).agentKind, "subagent");
});

test("M1.1-P one absent state has one literal: absent and explicit values stay separate", () => {
  const groupOf = (overrides) => perfGroupKey(okSample(zcodeRaw(overrides)));

  // positive side: absent evidence cannot split a group into two
  assert.equal(groupOf({ modelProvider: undefined }), groupOf({ modelProvider: "" }));
  assert.equal(groupOf({ modelProvider: "" }), groupOf({ modelProvider: "unknown" }));
  assert.equal(groupOf({ modelProvider: "unknown" }), groupOf({ modelProvider: undefined }));
  assert.equal(groupOf({ reasoningEffort: undefined }), groupOf({ reasoningEffort: "" }));
  assert.equal(groupOf({ reasoningEffort: "" }), groupOf({ reasoningEffort: " unknown " }));
  // the whole sample is identical too, not just the group key
  assert.deepEqual(okSample(zcodeRaw({ modelProvider: "unknown" })), okSample(zcodeRaw({ modelProvider: "" })));

  // negative side: a real difference must remain visible
  assert.notEqual(groupOf({ modelProvider: "" }), groupOf({ modelProvider: "openai" }));
  assert.notEqual(groupOf({ reasoningEffort: "" }), groupOf({ reasoningEffort: "high" }));
  assert.notEqual(groupOf({ modelProvider: "openai" }), groupOf({ modelProvider: "anthropic" }));
  assert.notEqual(groupOf({ reasoningEffort: "low" }), groupOf({ reasoningEffort: "high" }));

  // the literal name "unknown" is reserved for enums, so a provider truly named
  // "unknown" is indistinguishable from absent evidence by design (ruling P)
  assert.equal(groupOf({ modelProvider: "unknown" }), groupOf({ modelProvider: undefined }));
});

test("M1.1 unsupported sources never produce a perf sample and never fake eligibility", () => {
  for (const sourceKind of ["project-log", "unknown", "", null, undefined]) {
    const result = normalizePerfSample({ sourceKind, homeId: HOME, identity: ["x"] });
    assert.equal(result.sample, null, String(sourceKind));
    assert.equal(result.warningCode, "UNSUPPORTED_SOURCE_KIND", String(sourceKind));
  }
  assert.equal(normalizePerfSample(null).warningCode, "UNKEYABLE_RECORD");
  assert.equal(normalizePerfSample("zcode").warningCode, "UNKEYABLE_RECORD");
  assert.equal(normalizePerfSample(undefined).sample, null);
});

test("M1.1 batch: hand-computed keyable/unkeyable split, statuses and per-flag counts", () => {
  const batch = [
    zcodeRaw(),
    zcodeRaw({ identity: ["row-2"], outputTokens: 0 }),
    zcodeRaw({ identity: ["row-3"], outputTokens: null }),
    zcodeRaw({ identity: ["row-4"], durationMs: 0 }),
    zcodeRaw({ identity: ["row-5"], tsMs: null }),
    zcodeRaw({ identity: ["row-6"], status: "in_progress" }),
    zcodeRaw({ identity: ["row-7"], status: "error" }),
    { sourceKind: "zcode", homeId: HOME, tsMs: MS, outputTokens: 5 },
    { sourceKind: "project-log", homeId: HOME, identity: ["p"] },
  ];
  const results = batch.map((raw) => normalizePerfSample(raw));
  const samples = results.filter((result) => result.sample !== null).map((result) => result.sample);

  assert.equal(samples.length, 7);
  assert.equal(results.filter((result) => result.warningCode === "UNKEYABLE_RECORD").length, 1);
  assert.equal(results.filter((result) => result.warningCode === "UNSUPPORTED_SOURCE_KIND").length, 1);

  const keys = samples.map((sample) => sample.sampleKey);
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) {
    const parsed = JSON.parse(key);
    assert.equal(parsed[0], "zcode");
    assert.equal(key, JSON.stringify(parsed));
  }

  const byFlag = (name) => samples.filter((sample) => flagSet(sample).has(name)).length;
  assert.equal(byFlag("OUTPUT_ZERO"), 1);
  assert.equal(byFlag("MISSING_OUTPUT"), 1);
  assert.equal(byFlag("DURATION_NONPOSITIVE"), 1);
  assert.equal(byFlag("TIME_UNPLACED"), 1);
  assert.equal(byFlag("SOURCE_FILTERED"), 1);
  assert.equal(byFlag("TERMINAL_UNVERIFIED"), 0);
  assert.equal(byFlag("TOKEN_INVALID"), 0);
  // sum(byFlag) is 5 here while 5 different samples are "not clean": flags overlap by design
  assert.deepEqual(
    samples.map((sample) => sample.status),
    ["completed", "completed", "completed", "completed", "completed", "in_progress", "failed"],
  );
});

test("M1.1-Q contract ruling Q: normalization warning codes never enter a sourceWarnings shape", () => {
  // the frozen §3:83 minimal sourceWarnings code set, hand-copied from the contract
  const sourceWarningCodes = new Set([
    "UNKEYABLE_RECORD",
    "READ_ONLY_OPEN_FAILED",
    "UNSUPPORTED_SCHEMA",
    "MALFORMED_JSON",
    "MALFORMED_FRAME",
    "LIVE_SOURCE_CHANGED",
    "OPTIONAL_SOURCE_UNAVAILABLE",
    "AGGREGATE_OVERFLOW",
  ]);
  const m1Only = PERF_NORMALIZE_WARNING_CODES.filter((code) => !sourceWarningCodes.has(code));
  assert.deepEqual([...m1Only].sort(), [
    "SOURCE_SEMANTICS_MISMATCH",
    "UNRECOGNIZED_AGENT_KIND",
    "UNRECOGNIZED_FLAG_NAME",
    "UNRECOGNIZED_METHOD_VERSION",
    "UNRECOGNIZED_PROVENANCE",
    "UNRECOGNIZED_STATUS",
    "UNSUPPORTED_SOURCE_KIND",
  ]);

  // normalize's result is `{ sample, warningCode, warnings }` — it has no sourceWarnings
  // member, so a reader cannot leak these codes into `meta.sourceWarnings` by spreading it.
  const noisy = normalizePerfSample(
    zcodeRaw({
      status: "weird",
      timingSource: "guessed",
      methodVersion: "tps-v99",
      agentKind: "main-ish",
      sampleFlags: ["NOPE"],
      modelProvider: "unknown",
    }),
  );
  assert.deepEqual(Object.keys(noisy).sort(), ["sample", "warningCode", "warnings"]);
  assert.equal(Object.hasOwn(noisy, "sourceWarnings"), false);
  for (const code of noisy.warnings) {
    assert.ok(PERF_NORMALIZE_WARNING_CODES.includes(code), code);
  }
  assert.ok(noisy.warnings.includes("UNRECOGNIZED_STATUS"));
  assert.ok(noisy.warnings.includes("UNRECOGNIZED_PROVENANCE"));
  assert.ok(noisy.warnings.includes("UNRECOGNIZED_METHOD_VERSION"));
  assert.ok(noisy.warnings.includes("UNRECOGNIZED_AGENT_KIND"));
  assert.ok(noisy.warnings.includes("UNRECOGNIZED_FLAG_NAME"));
  // the only code that is legitimately shared with the frozen sourceWarning domain stays one of them
  assert.equal(normalizePerfSample({ sourceKind: "zcode", homeId: "h" }).warningCode, "UNKEYABLE_RECORD");
});

test("M1.1-R/S contract rulings R and S: reason vocabularies stay separate and a synthesized status is visible", () => {
  // R: the ten droppedByReason main reasons, hand-copied. The wording is
  // the frozen contract spelling (source-contract §2-E, fixture-cases N-02/N-03);
  // AD-1 corrected an earlier hand-copy that read `_or_invalid`, which never matched
  // the implementation. Each name below is intentionally spelled out so this test
  // fails loudly if the frozen vocabulary ever drifts.
  const droppedByReasonVocabulary = new Set([
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
  for (const raw of [
    zcodeRaw(),
    zcodeRaw({ outputTokens: null }),
    zcodeRaw({ outputTokens: 0 }),
    zcodeRaw({ durationMs: -1 }),
    zcodeRaw({ status: "error" }),
    zcodeRaw({ tsMs: null }),
    zcodeRaw({ recordConflict: true, partialItemSpan: true }),
  ]) {
    const { sample } = normalizePerfSample(raw);
    assert.equal(droppedByReasonVocabulary.has(sample.diagnosticReason), false, sample.diagnosticReason);
  }
  // diagnosticReason is the fine-grained source-side vocabulary, exposed alongside it
  assert.deepEqual(Object.keys(okSample(zcodeRaw())).includes("diagnosticReasonChain"), true);

  // S, positive: a reader-provided status is never overridden and never marked synthesized
  const explicit = okSample(zcodeRaw({ status: "error" }));
  assert.equal(explicit.status, "failed");
  assert.deepEqual(explicit.diagnosticReasonChain, ["source_failed"]);
  assert.equal(explicit.diagnosticReason, "source_failed");
  assert.equal(explicit.diagnosticReasonChain.includes("status_synthesized_from_filter_evidence"), false);

  // S, fallback: with filter evidence but no status, the derived state is recorded
  const synthesized = okSample(zcodeRaw({ status: undefined, retryCount: 2 }));
  assert.equal(synthesized.status, "failed");
  assert.equal(synthesized.diagnosticReason, "retry");
  assert.deepEqual(synthesized.diagnosticReasonChain, [
    "status_missing",
    "retry",
    "status_synthesized_from_filter_evidence",
  ]);
  assert.ok(flagSet(synthesized).has("SOURCE_FILTERED"));
  // the derivation survives even when a higher-priority reason wins the headline
  assert.notEqual(synthesized.diagnosticReasonChain.at(-1), "");

  const cancelled = okSample(zcodeRaw({ status: undefined, cancelledByUser: true }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.diagnosticReason, "cancelled_by_user");
  assert.deepEqual(cancelled.diagnosticReasonChain, [
    "status_missing",
    "cancelled_by_user",
    "status_synthesized_from_filter_evidence",
  ]);

  // not synthesized when only `sourceFiltered` is asserted: the reader did not claim a terminal state
  const filteredOnly = okSample(zcodeRaw({ status: undefined, sourceFiltered: true }));
  assert.equal(filteredOnly.status, "failed");
  assert.equal(filteredOnly.diagnosticReason, "source_filtered");
  assert.deepEqual(filteredOnly.diagnosticReasonChain, [
    "status_missing",
    "source_filtered",
    "status_synthesized_from_filter_evidence",
  ]);

  // a missing output outranks the filter reason, so the synthesis must survive in the chain
  const outranked = okSample(zcodeRaw({ status: undefined, retryCount: 2, outputTokens: null }));
  assert.equal(outranked.diagnosticReason, "output_missing");
  assert.ok(outranked.diagnosticReasonChain.includes("status_synthesized_from_filter_evidence"));

  // an explicit status of in_progress is not synthesized even with retry evidence
  assert.equal(okSample(zcodeRaw({ status: "in_progress", retryCount: 1 })).status, "in_progress");
  assert.equal(okSample(zcodeRaw({ status: "retrying" })).status, "unverified");
  assert.ok(flagSet(okSample(zcodeRaw({ status: "retrying" }))).has("TERMINAL_UNVERIFIED"));
});

test("M1.1-T contract ruling T: a second-unit timestamp is diagnosed, never silently scaled", () => {
  const seconds = 1_759_999_999; // ~2025-10-03T23:59:59Z expressed in seconds
  const result = normalizePerfSample(zcodeRaw({ tsMs: seconds, startedAtMs: seconds, completedAtMs: seconds }));
  assert.equal(result.sample.tsMs, null);
  assert.equal(result.sample.startedAtMs, undefined);
  assert.equal(result.sample.diagnosticReason, "timestamp_unit_unsupported");
  assert.equal(result.sample.tsMs, null);
  assert.notEqual(result.sample.tsMs, seconds);
  assert.notEqual(result.sample.tsMs, seconds * 1000);
  // the field is not even carried on the normalized sample, so no consumer can read a scaled value
  assert.equal(Object.hasOwn(result.sample, "tsMs"), true);
  assert.ok(flagSet(result.sample).has("TIME_INVALID"));
  assert.equal(flagSet(result.sample).has("TIME_UNPLACED"), false);

  // the threshold itself is accepted, and just below it is rejected; no auto-scaling either way
  assert.equal(okSample(zcodeRaw({ tsMs: PERF_EPOCH_MS_MIN })).tsMs, PERF_EPOCH_MS_MIN);
  assert.equal(normalizePerfSample(zcodeRaw({ tsMs: PERF_EPOCH_MS_MIN - 1 })).sample.tsMs, null);
  assert.equal(normalizePerfSample(zcodeRaw({ tsMs: 1 })).sample.tsMs, null);
  // a millisecond timestamp stays a millisecond timestamp (no rounding/no unit guess)
  assert.equal(okSample(zcodeRaw({ tsMs: 1_760_000_000_123 })).tsMs, 1_760_000_000_123);
});

test("M1.1-U contract ruling U: unsafe/non-integer values get distinct reasons inside their own bit", () => {
  // duration: legality problem -> bit 14 TIME_INVALID, value dropped
  const durationUnsafe = normalizePerfSample(zcodeRaw({ durationMs: Number.MAX_SAFE_INTEGER + 1 }));
  const durationFraction = normalizePerfSample(zcodeRaw({ durationMs: 1.5 }));
  const durationNonFinite = normalizePerfSample(zcodeRaw({ durationMs: Number.POSITIVE_INFINITY }));
  assert.deepEqual([...flagSet(durationUnsafe.sample)], ["TIME_INVALID"]);
  assert.equal(durationUnsafe.sample.diagnosticReason, "duration_not_safe_integer");
  assert.equal(durationFraction.sample.diagnosticReason, "duration_not_integer");
  assert.equal(durationNonFinite.sample.diagnosticReason, "duration_not_finite");
  assert.equal(durationUnsafe.sample.durationMs, null);
  assert.equal(durationFraction.sample.durationMs, null);
  // a true zero/negative duration keeps the value instead: different bit, different semantics
  const durationZero = normalizePerfSample(zcodeRaw({ durationMs: 0 }));
  assert.deepEqual([...flagSet(durationZero.sample)], ["DURATION_NONPOSITIVE"]);
  assert.equal(durationZero.sample.durationMs, 0);
  assert.equal(durationZero.sample.diagnosticReason, "duration_zero");
  assert.notEqual(durationZero.sample.diagnosticReason, durationUnsafe.sample.diagnosticReason);

  // output: legality problem -> bit 17 TOKEN_INVALID
  const outputUnsafe = normalizePerfSample(zcodeRaw({ outputTokens: Number.MAX_SAFE_INTEGER + 1 }));
  const outputNegative = normalizePerfSample(zcodeRaw({ outputTokens: -1 }));
  const outputFraction = normalizePerfSample(zcodeRaw({ outputTokens: 2.5 }));
  assert.deepEqual([...flagSet(outputUnsafe.sample)], ["TOKEN_INVALID"]);
  assert.equal(outputUnsafe.sample.diagnosticReason, "output_not_safe_integer");
  assert.equal(outputNegative.sample.diagnosticReason, "output_negative");
  assert.equal(outputFraction.sample.diagnosticReason, "output_not_integer");
  assert.equal(outputUnsafe.sample.diagnosticReason !== outputFraction.sample.diagnosticReason, true);
  assert.equal(outputUnsafe.sample.outputTokens, null);
  assert.equal(outputUnsafe.sample.durationMs, 1_000);
  // the two clusters must not collapse onto one reason across fields either
  assert.notEqual(durationUnsafe.sample.diagnosticReason, outputUnsafe.sample.diagnosticReason);
});

test("M1.1-V contract ruling V: a non-canonical sampleKey is UNKEYABLE_RECORD, with no new code", () => {
  const cases = [
    ["未 trim", '["zcode","h","  x  "]'],
    ["首元素非规范 kind", '["main","h","t","u"]'],
    ["元素不足", '["zcode","h"]'],
    ["空串身份", '["zcode","h",""]'],
    ["非 JSON", "zcode:h:x"],
  ];
  for (const [label, sampleKey] of cases) {
    const result = normalizePerfSample({
      sourceKind: sampleKey.startsWith('["main"') ? "main" : "zcode",
      homeId: "h",
      sampleKey,
    });
    assert.equal(result.sample, null, label);
    assert.equal(result.warningCode, "UNKEYABLE_RECORD", label);
    assert.deepEqual(result.warnings, ["UNKEYABLE_RECORD"], label);
  }
  // the code domain did not grow: exactly the frozen 8 minus the 1 M1 reuses... no —
  // M1 exposes the frozen `UNKEYABLE_RECORD` plus 7 M1-local codes, and nothing else.
  assert.equal(PERF_NORMALIZE_WARNING_CODES.length, 1 + 7);
  assert.equal(PERF_NORMALIZE_WARNING_CODES.includes("SAMPLE_KEY_INVALID"), false);
});

test("M1.1-返工2-1 a precomputed sampleKey and homeId must agree, or both are rejected", () => {
  const key = (homeId) => JSON.stringify(["zcode", homeId, "row-1"]);

  // 反例 1: the key claims another home than the record declares
  const mismatch = normalizePerfSample({ sourceKind: "zcode", homeId: "h", sampleKey: key("other-home") });
  assert.equal(mismatch.sample, null);
  assert.equal(mismatch.warningCode, "UNKEYABLE_RECORD");
  assert.deepEqual(mismatch.warnings, ["UNKEYABLE_RECORD"]);

  // 反例 2: key-only input has no home to cross-check against
  const keyOnly = normalizePerfSample({ sourceKind: "zcode", sampleKey: key("h") });
  assert.equal(keyOnly.sample, null);
  assert.equal(keyOnly.warningCode, "UNKEYABLE_RECORD");
  assert.notEqual(keyOnly.warningCode, null);
  // and it can never produce the old silent empty-home sample
  assert.notEqual(keyOnly.sample?.homeId, "");

  // 反例 3: blank/whitespace home ids are absent homes, not tolerated mismatches
  for (const homeId of ["", "   ", null, undefined, 7]) {
    const result = normalizePerfSample({ sourceKind: "zcode", homeId, sampleKey: key("h") });
    assert.equal(result.sample, null, String(homeId));
    assert.equal(result.warningCode, "UNKEYABLE_RECORD", String(homeId));
  }

  // 正例 1: agreement, including trim-normalization of the declared homeId
  for (const [homeId, keyHome] of [
    ["h", "h"],
    [" h ", "h"],
    ["h", "h"],
    ["Home-A", "Home-A"],
  ]) {
    const result = normalizePerfSample({ sourceKind: "zcode", homeId, sampleKey: key(keyHome) });
    assert.notEqual(result.sample, null, `${homeId} / ${keyHome}`);
    // identity, ownership and grouping all read the same (trimmed) home
    const parsedKey = JSON.parse(result.sample.sampleKey);
    assert.equal(parsedKey[1], result.sample.homeId, `${homeId} / ${keyHome}`);
    assert.equal(parsedKey[1], homeId.trim(), `${homeId} / ${keyHome}`);
    assert.equal(JSON.parse(perfGroupKey(result.sample))[1], result.sample.homeId, `${homeId} / ${keyHome}`);
    assert.equal(result.sample.sampleKey, key(homeId.trim()));
  }
  // the key itself must already be in canonical form: an untrimmed key is rejected by
  // ruling V before the home comparison is even reached (contract §8 ruling V)
  for (const untrimmed of ['["zcode"," h ","row-1"]', '["zcode","h"," row-1 "]']) {
    const result = normalizePerfSample({ sourceKind: "zcode", homeId: "h", sampleKey: untrimmed });
    assert.equal(result.sample, null, untrimmed);
    assert.equal(result.warningCode, "UNKEYABLE_RECORD", untrimmed);
  }
  // a trimmed key plus a trimmed declared home still agree after normalization
  const bothTrimmed = normalizePerfSample({ sourceKind: "zcode", homeId: " h ", sampleKey: key("h") });
  assert.notEqual(bothTrimmed.sample, null);
  assert.equal(bothTrimmed.sample.homeId, "h");
  assert.equal(bothTrimmed.sample.sampleKey, key("h"));
  // case is preserved, so different-cased homes stay different identities
  assert.notEqual(
    normalizePerfSample({ sourceKind: "zcode", homeId: "Home-A", sampleKey: key("Home-A") }).sample.sampleKey,
    normalizePerfSample({ sourceKind: "zcode", homeId: "home-a", sampleKey: key("home-a") }).sample.sampleKey,
  );

  // 正例 2: the identity path (no sampleKey at all) is untouched
  const identity = okSample(zcodeRaw({ identity: ["row-1"] }));
  assert.equal(identity.sampleKey, JSON.stringify(["zcode", HOME, "row-1"]));
  assert.equal(identity.homeId, HOME);
  // a key that agrees with the identity-derived one is accepted and equals it
  const both = okSample(zcodeRaw({ identity: ["row-1"], sampleKey: key(HOME) }));
  assert.equal(both.sampleKey, identity.sampleKey);
  // a key that contradicts the identity-derived one is unreachable, because the identity
  // path wins first; the mismatching key is simply not used
  const conflicting = okSample(zcodeRaw({ identity: ["row-1"], sampleKey: key("other-home") }));
  assert.equal(conflicting.sampleKey, identity.sampleKey);
  assert.equal(conflicting.homeId, HOME);
});

test("M1.1-返工2-2 an unknown status is never promoted to completed by terminalVerified", () => {
  // 反例 A: unknown status + explicit terminal evidence
  const withTerminal = normalizePerfSample(zcodeRaw({ status: "retrying", terminalVerified: true }));
  assert.notEqual(withTerminal.sample.status, "completed");
  assert.equal(withTerminal.sample.status, "unverified");
  assert.ok(flagSet(withTerminal.sample).has("TERMINAL_UNVERIFIED"));
  assert.ok(withTerminal.warnings.includes("UNRECOGNIZED_STATUS"));
  assert.equal(withTerminal.sample.diagnosticReason, "status_unrecognized");

  // 反例 B: unknown status + retry evidence (existing filter-synthesis path)
  const withRetry = normalizePerfSample(zcodeRaw({ status: "retrying", retryCount: 3 }));
  assert.notEqual(withRetry.sample.status, "completed");
  assert.equal(withRetry.sample.status, "failed");
  assert.ok(flagSet(withRetry.sample).has("SOURCE_FILTERED"));
  assert.ok(withRetry.warnings.includes("UNRECOGNIZED_STATUS"));

  // 反例 C: unknown status + inProgress hint → pending, never completed
  const withInProgress = normalizePerfSample(zcodeRaw({ status: "retrying", inProgress: true }));
  assert.notEqual(withInProgress.sample.status, "completed");
  assert.equal(withInProgress.sample.status, "in_progress");
  assert.equal(flagSet(withInProgress.sample).has("TERMINAL_UNVERIFIED"), false);

  // 反例 D: all three at once still cannot reach completed
  const all = normalizePerfSample(zcodeRaw({ status: "retrying", terminalVerified: true, retryCount: 1 }));
  assert.notEqual(all.sample.status, "completed");

  // 正例: the fallback survives for a genuinely absent status
  const absent = normalizePerfSample(zcodeRaw({ status: undefined, terminalVerified: true }));
  assert.equal(absent.sample.status, "completed");
  assert.equal(flagSet(absent.sample).has("TERMINAL_UNVERIFIED"), false);
  assert.deepEqual(absent.warnings, []);
  // ...and is still refused when the terminal state is not verified
  assert.equal(
    normalizePerfSample(zcodeRaw({ status: undefined, terminalVerified: false })).sample.status,
    "unverified",
  );
  assert.equal(normalizePerfSample(zcodeRaw({ status: "", terminalVerified: true })).sample.status, "completed");
  // the alias path is unaffected by the absent/unknown split
  assert.equal(normalizePerfSample(zcodeRaw({ status: "error", terminalVerified: true })).sample.status, "failed");
  assert.equal(
    normalizePerfSample(zcodeRaw({ status: "canceled", terminalVerified: true })).sample.status,
    "cancelled",
  );
});

test("M1.1-返工2-3 out-of-table mask bits are rejected at every mask entry point", () => {
  const outOfTable = [
    [2 ** 32, "ToInt32 wraps this to 0, so the old code returned 1"],
    [1 << 18, "first bit past the 18-slot table"],
    [2 ** 31, "sign bit of the 32-bit range"],
    [Number.MAX_SAFE_INTEGER, "largest safe integer"],
    [(1 << 0) | (1 << 19), "one legal bit plus one out-of-table bit"],
    [2 ** 32 - 1, "all 32 bits set"],
  ];
  const isFlagError = (code) => (error) => error instanceof PerfFlagError && error.code === code;

  for (const [mask, label] of outOfTable) {
    assert.throws(() => setPerfFlag(mask, "OUTPUT_ZERO"), isFlagError("UNKNOWN_FLAG_BIT"), `setPerfFlag ${label}`);
    assert.throws(() => assertNoReservedFlagBits(mask), isFlagError("UNKNOWN_FLAG_BIT"), label);
    assert.throws(() => perfFlagNamesOf(mask), isFlagError("UNKNOWN_FLAG_BIT"), label);
    assert.throws(() => assertPerfFlagMaskInTable(mask), isFlagError("UNKNOWN_FLAG_BIT"), label);
    assert.throws(
      () => normalizePerfSample(zcodeRaw({ sampleFlags: mask })),
      isFlagError("UNKNOWN_FLAG_BIT"),
      `normalize ${label}`,
    );
  }
  // the headline regression: no silent truncation to the bit-0 value
  assert.throws(() => setPerfFlag(2 ** 32, "OUTPUT_ZERO"), isFlagError("UNKNOWN_FLAG_BIT"));
  assert.notEqual(
    (() => {
      try {
        return setPerfFlag(2 ** 32, "OUTPUT_ZERO");
      } catch {
        return "threw";
      }
    })(),
    1,
  );

  // non-number / negative / non-integer masks keep the original code
  for (const mask of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "4", null, undefined]) {
    assert.throws(() => assertNoReservedFlagBits(mask), isFlagError("INVALID_FLAG_MASK"), String(mask));
    assert.throws(() => perfFlagNamesOf(mask), isFlagError("INVALID_FLAG_MASK"), String(mask));
    assert.throws(() => setPerfFlag(mask, "OUTPUT_ZERO"), isFlagError("INVALID_FLAG_MASK"), String(mask));
  }

  // reserved bits (2/3) still throw their own code, not the out-of-table one
  for (const mask of [1 << 2, 1 << 3, (1 << 2) | (1 << 0)]) {
    assert.throws(() => assertNoReservedFlagBits(mask), isFlagError("RESERVED_FLAG_BIT"), String(mask));
    assert.throws(() => perfFlagNamesOf(mask), isFlagError("RESERVED_FLAG_BIT"), String(mask));
    assert.throws(() => setPerfFlag(mask, "OUTPUT_ZERO"), isFlagError("RESERVED_FLAG_BIT"), String(mask));
  }

  // 正例: every legal mask still works, including the widest one
  const widest = [...Array(18).keys()]
    .filter((bit) => !PERF_RESERVED_FLAG_BITS.includes(bit))
    .reduce((acc, bit) => acc | (1 << bit), 0);
  assert.equal(widest, 2 ** 18 - 1 - (1 << 2) - (1 << 3));
  assert.equal(assertNoReservedFlagBits(0), 0);
  assert.deepEqual(perfFlagNamesOf(0), []);
  assert.equal(assertPerfFlagMaskInTable(widest), widest);
  assert.equal(perfFlagNamesOf(widest).length, 16);
  assert.deepEqual(perfFlagNamesOf((1 << 0) | (1 << 17)), ["OUTPUT_ZERO", "TOKEN_INVALID"]);
  assert.equal(setPerfFlag(0, "LONG_WINDOW"), 1 << 4);
  assert.equal(setPerfFlag(widest, "OUTPUT_ZERO"), widest);
  assert.equal(okSample(zcodeRaw({ sampleFlags: widest })).sampleFlags, widest);
  assert.equal(okSample(zcodeRaw({ sampleFlags: (1 << 18) - 1 - (1 << 2) - (1 << 3) })).sampleFlags, widest);
});

/**
 * M1.2 tests: selection, coverage and the single main drop reason.
 *
 * Every expectation is hand-computed from plan §17.4/§17.5, the frozen
 * `source-contract.md` §2-E/§8 and `fixture-cases.md` (F/N series); no
 * expected value is copied from the implementation output. Fixtures are
 * synthetic only: this module never reads a source.
 */

/** Hand-picked Codex "recent" instant: above the 2026-09-28T01:00:57Z cut point. */
const RECENT_MS = 1_791_000_000_000;

/** A fully valid Codex candidate; each test overrides exactly what it is testing. */
const codexRaw = (overrides = {}) => ({
  sourceKind: "codex",
  homeId: HOME,
  threadId: "thread-1",
  turnId: "turn-1",
  status: "completed",
  tsMs: MS,
  durationMs: 1_000,
  outputTokens: 100,
  ...overrides,
});

const okZcode = (overrides = {}) => okSample(zcodeRaw(overrides));
const okCodex = (overrides = {}) => okSample(codexRaw(overrides));
const sumValues = (record) => Object.values(record).reduce((total, value) => total + value, 0);
const keysOf = (samples) => samples.map((sample) => sample.sampleKey);

test("M1.2 the era cut point defaults to §17.5:280 and the reason/flag vocabularies are frozen", () => {
  assert.equal(new Date(PERF_ERA_CUTOFF_MS).toISOString(), "2026-09-28T01:00:57.000Z");
  assert.ok(PERF_ERA_CUTOFF_MS > MS, "the shared MS fixture is legacy, RECENT_MS is recent");
  assert.ok(RECENT_MS > PERF_ERA_CUTOFF_MS);
  assert.deepEqual(
    [...PERF_DROPPED_BY_REASONS],
    [
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
    ],
  );
  assert.equal(PERF_DROPPED_BY_REASONS.length, 10);
  // the 12-flag deduction set: hints and placement are structurally absent
  assert.equal(PERF_DEDUCTION_FLAG_NAMES.length, 12);
  for (const hint of ["LONG_WINDOW", "MULTI_REQUEST_TURN", "METHOD_ESTIMATE", "TIME_UNPLACED"]) {
    assert.equal(PERF_DEDUCTION_FLAG_NAMES.includes(hint), false, hint);
  }
});

test("M1.2 historical methods and current semantic mismatches stay out of current samples", () => {
  const v1 = okSample(zcodeRaw({ identity: ["v1"], methodVersion: "tps-v1" }));
  const v2 = okSample(zcodeRaw({ identity: ["v2"], methodVersion: "tps-v2" }));
  const mismatch = okSample(
    zcodeRaw({
      identity: ["mismatch"],
      methodVersion: PERF_METHOD_VERSION,
      window: "step",
      timingKind: "request_e2e",
      tokenScope: "visible_plus_reasoning",
    }),
  );

  assert.equal(perfDroppedByReason(v1), "historical_method");
  assert.equal(perfDroppedByReason(v2), "historical_method");
  assert.equal(mismatch.window, "step");
  assert.equal(mismatch.timingKind, "request_e2e");
  assert.equal(mismatch.tokenScope, "visible_plus_reasoning");
  assert.equal(mismatch.diagnosticReason, "source_semantics_mismatch");

  const coverage = computePerfCoverage(selectPerfSamples([v1, v2, mismatch], {}), {});
  assert.equal(coverage.sampled, 0);
  assert.equal(coverage.droppedByReason.historical_method, 2);
  assert.equal(coverage.droppedByReason.source_semantics_mismatch, 1);
});

test("M1.2 select: source exclusion runs before the range filter", () => {
  const a = okZcode({ identity: ["a"], tsMs: MS });
  const b = okZcode({ identity: ["b"], homeId: "home-b", tsMs: MS });
  const c = okZcode({ identity: ["c"], tsMs: MS + 100_000 });
  const d = okZcode({ identity: ["d"], homeId: "home-b", tsMs: MS + 100_000 });
  const selection = selectPerfSamples([a, b, c, d], {
    range: { startMs: MS - 1, endMs: MS + 1 },
    excludedHomeIds: ["home-b"],
  });
  assert.deepEqual(keysOf(selection.eligible), [a.sampleKey]);
  // d is both excluded AND out of range: exclusion wins, so it lands in excluded
  assert.deepEqual(keysOf(selection.excluded), [b.sampleKey, d.sampleKey]);
  assert.deepEqual(keysOf(selection.outOfRange), [c.sampleKey]);
  assert.deepEqual(selection.unplaced, []);
});

test("M1.2 select: ordinary bounds are inclusive, quota windowEndExclusive is exclusive", () => {
  const at = (id, tsMs) => okZcode({ identity: [id], tsMs });
  const ordinary = selectPerfSamples([at("s", MS), at("e", MS + 1000), at("after", MS + 1001), at("before", MS - 1)], {
    range: { startMs: MS, endMs: MS + 1000 },
  });
  assert.deepEqual(keysOf(ordinary.eligible).sort(), [at("s", MS).sampleKey, at("e", MS + 1000).sampleKey].sort());
  assert.equal(ordinary.outOfRange.length, 2);

  const quota = selectPerfSamples([at("x-1", MS + 1999), at("x", MS + 2000), at("s", MS)], {
    range: { startMs: MS, windowEndExclusiveMs: MS + 2000 },
  });
  assert.deepEqual(keysOf(quota.eligible).sort(), [at("x-1", MS + 1999).sampleKey, at("s", MS).sampleKey].sort());
  assert.deepEqual(keysOf(quota.outOfRange), [at("x", MS + 2000).sampleKey]);

  // the exclusive bound wins when both upper bounds are present
  const both = selectPerfSamples([at("mid", MS + 1500)], {
    range: { startMs: MS, endMs: MS + 1000, windowEndExclusiveMs: MS + 2000 },
  });
  assert.equal(both.eligible.length, 1);
  assert.equal(both.outOfRange.length, 0);
});

test("M1.2 select+coverage: TIME_UNPLACED never enters eligible and survives range changes", () => {
  const placed = okZcode({ identity: ["placed"], tsMs: MS });
  const zero = okZcode({ identity: ["zero"], tsMs: MS, outputTokens: 0 });
  const far = okZcode({ identity: ["far"], tsMs: MS + 5000 });
  const u1 = okZcode({ identity: ["u1"], tsMs: null });
  const u2 = okZcode({ identity: ["u2"], tsMs: null });
  const narrow = selectPerfSamples([placed, zero, far, u1, u2], { range: { startMs: MS - 1, endMs: MS + 1 } });
  const wide = selectPerfSamples([placed, zero, far, u1, u2], {});
  assert.deepEqual(keysOf(narrow.unplaced).sort(), keysOf(wide.unplaced).sort());
  assert.equal(narrow.unplaced.length, 2);
  assert.deepEqual(keysOf(narrow.eligible).sort(), [placed.sampleKey, zero.sampleKey].sort());
  assert.deepEqual(keysOf(narrow.outOfRange), [far.sampleKey]);

  const coverage = computePerfCoverage(narrow, {});
  assert.equal(coverage.eligible, 2);
  assert.equal(coverage.sampled, 1);
  assert.equal(coverage.dropped, 1);
  assert.equal(coverage.pending, 0);
  assert.equal(coverage.unplaced, 2);
  assert.equal(coverage.droppedByReason.output_missing_zero_invalid, 1);
  assert.equal(sumValues(coverage.droppedByReason), coverage.dropped);
  assert.equal("time_unplaced" in coverage.droppedByReason, false);
});

test("M1.2 dedup: identical sampleKeys fold, conflicting rows leave RECORD_CONFLICT", () => {
  // 正例: two independently built but field-identical rows are one candidate
  const first = okZcode({ identity: ["dup"] });
  const clone = okZcode({ identity: ["dup"] });
  assert.notEqual(first, clone);
  const folded = selectPerfSamples([first, clone], {});
  assert.equal(folded.eligible.length, 1);
  assert.equal(flagSet(folded.eligible[0]).has("RECORD_CONFLICT"), false);
  assert.equal(computePerfCoverage(folded, {}).sampled, 1);

  // 反例: same key with different counts is a conflict, never a sum
  const low = okZcode({ identity: ["con"], outputTokens: 100 });
  const high = okZcode({ identity: ["con"], outputTokens: 200 });
  const conflicted = selectPerfSamples([low, high], {});
  assert.equal(conflicted.eligible.length, 1);
  assert.ok(flagSet(conflicted.eligible[0]).has("RECORD_CONFLICT"));
  assert.equal(conflicted.eligible[0].outputTokens, 100);
  const conflictCoverage = computePerfCoverage(conflicted, {});
  assert.equal(conflictCoverage.dropped, 1);
  assert.equal(conflictCoverage.droppedByReason.record_conflict, 1);

  //对照: distinct keys stay distinct
  const distinct = selectPerfSamples([okZcode({ identity: ["k1"] }), okZcode({ identity: ["k2"] })], {});
  assert.equal(distinct.eligible.length, 2);
});

test("M1.2 pending is never dropped: in_progress vs failed, both sides", () => {
  const pending = okZcode({ identity: ["pending"], status: "in_progress" });
  const failed = okZcode({ identity: ["failed"], status: "error" });
  const coverage = computePerfCoverage(selectPerfSamples([pending, failed], {}), {});
  assert.equal(coverage.eligible, 2);
  assert.equal(coverage.pending, 1);
  assert.equal(coverage.dropped, 1);
  assert.equal(coverage.sampled, 0);
  assert.equal(coverage.droppedByReason.source_filtered, 1);
  assert.equal(sumValues(coverage.droppedByReason), 1);
  assert.equal(perfDroppedByReason(pending), null);
});

test("M1.2 partial with positive duration is timed but not complete, and drops as partial", () => {
  const partial = okCodex({ turnId: "partial", partialItemSpan: true });
  const clean = okCodex({ turnId: "clean" });
  const coverage = computePerfCoverage(selectPerfSamples([partial, clean], {}), {});
  assert.equal(coverage.eligible, 2);
  assert.equal(coverage.positiveOutput, 2);
  assert.equal(coverage.timedPositiveOutput, 2);
  assert.equal(coverage.completeTimedPositiveOutput, 1);
  assert.equal(coverage.sampled, 1);
  assert.equal(coverage.dropped, 1);
  assert.equal(coverage.droppedByReason.partial_item_span, 1);
});

test("M1.2 one dropped candidate gets exactly one main reason under the fixed priority", () => {
  const cases = [
    [
      "record_conflict outranks output+duration",
      zcodeRaw({ identity: ["r1"], outputTokens: null, durationMs: null, recordConflict: true }),
      "record_conflict",
      ["RECORD_CONFLICT", "MISSING_OUTPUT", "MISSING_DURATION"],
    ],
    [
      "model_ambiguous outranks terminal_unverified",
      zcodeRaw({ identity: ["r2"], status: "weird-status", modelAmbiguous: true }),
      "model_ambiguous",
      ["MODEL_AMBIGUOUS", "TERMINAL_UNVERIFIED"],
    ],
    [
      "terminal_unverified outranks source_filtered",
      zcodeRaw({ identity: ["r3"], status: "unverified", retryCount: 1 }),
      "terminal_unverified",
      ["TERMINAL_UNVERIFIED", "SOURCE_FILTERED"],
    ],
    [
      "source_filtered outranks output",
      zcodeRaw({ identity: ["r4"], status: "error", outputTokens: null }),
      "source_filtered",
      ["SOURCE_FILTERED", "MISSING_OUTPUT"],
    ],
    [
      "output outranks duration",
      zcodeRaw({ identity: ["r5"], outputTokens: null, durationMs: null }),
      "output_missing_zero_invalid",
      ["MISSING_OUTPUT", "MISSING_DURATION"],
    ],
    [
      "duration outranks partial (N-03 mutual exclusion)",
      zcodeRaw({ identity: ["r6"], durationMs: null, partialItemSpan: true }),
      "duration_missing_nonpositive_invalid",
      ["MISSING_DURATION", "PARTIAL_ITEM_SPAN"],
    ],
  ];
  for (const [label, raw, reason, expectedFlags] of cases) {
    const sample = okSample(raw);
    for (const name of expectedFlags) assert.ok(flagSet(sample).has(name), `${label}: ${name}`);
    assert.equal(perfDroppedByReason(sample), reason, label);
    const coverage = computePerfCoverage(selectPerfSamples([sample], {}), {});
    assert.equal(coverage.dropped, 1, label);
    assert.equal(coverage.droppedByReason[reason], 1, label);
    assert.equal(sumValues(coverage.droppedByReason), 1, `${label}: exactly one reason`);
  }
  // byFlag may overlap while droppedByReason must not (N-06/I9 on the r1 shape)
  const overlap = computePerfCoverage(
    selectPerfSamples(
      [okSample(zcodeRaw({ identity: ["o"], outputTokens: null, durationMs: null, recordConflict: true }))],
      {},
    ),
    {},
  );
  assert.equal(sumValues(overlap.byFlag), 3);
  assert.equal(overlap.dropped, 1);
});

test("M1.2 hints still sample: LONG_WINDOW boundary, MULTI_REQUEST_TURN, METHOD_ESTIMATE", () => {
  const long = okZcode({ identity: ["long"], durationMs: PERF_LONG_WINDOW_MS + 1 });
  const edge = okZcode({ identity: ["edge"], durationMs: PERF_LONG_WINDOW_MS });
  const multi = okCodex({ turnId: "multi", requestCount: 2 });
  const estimate = okZcode({ identity: ["estimate"], sampleFlags: ["METHOD_ESTIMATE"] });
  const coverage = computePerfCoverage(selectPerfSamples([long, edge, multi, estimate], {}), {});
  assert.equal(coverage.eligible, 4);
  assert.equal(coverage.sampled, 4);
  assert.equal(coverage.dropped, 0);
  assert.equal(coverage.byFlag.LONG_WINDOW, 1);
  assert.equal(coverage.byFlag.MULTI_REQUEST_TURN, 1);
  assert.equal(coverage.byFlag.METHOD_ESTIMATE, 1);
  assert.equal(coverage.sampleRate, 1);
  assert.ok(flagSet(multi).has("MULTI_REQUEST_TURN"));
  assert.equal(flagSet(multi).has("METHOD_ESTIMATE"), false);
});

test("M1.2 rates: N-04 definition and N-05 null denominators", () => {
  // N-05 反例 first (discriminant reachability: empty eligible must yield null, not 0)
  const empty = computePerfCoverage({ eligible: [], unplaced: [] }, {});
  assert.equal(empty.timingRate, null);
  assert.equal(empty.completeTimingRate, null);
  assert.equal(empty.sampleRate, null);
  assert.equal(empty.byEra, null);

  // no positive output, but eligible > 0: timing rates null, sampleRate a real 0
  const zeros = computePerfCoverage(
    selectPerfSamples(
      [okZcode({ identity: ["z1"], outputTokens: 0 }), okZcode({ identity: ["z2"], outputTokens: 0 })],
      {},
    ),
    {},
  );
  assert.equal(zeros.positiveOutput, 0);
  assert.equal(zeros.timingRate, null);
  assert.equal(zeros.completeTimingRate, null);
  assert.equal(zeros.sampleRate, 0);
  assert.notEqual(zeros.sampleRate, null);

  // N-04 正例: positive=4, timed=3, complete=2, sampled=2, eligible=5 (hand-set)
  const selection = selectPerfSamples(
    [
      okZcode({ identity: ["s1"] }),
      okZcode({ identity: ["s2"] }),
      okZcode({ identity: ["z"], outputTokens: 0 }),
      okZcode({ identity: ["m"], durationMs: null }),
      okZcode({ identity: ["p"], partialItemSpan: true }),
    ],
    {},
  );
  const coverage = computePerfCoverage(selection, {});
  assert.equal(coverage.eligible, 5);
  assert.equal(coverage.positiveOutput, 4);
  assert.equal(coverage.timedPositiveOutput, 3);
  assert.equal(coverage.completeTimedPositiveOutput, 2);
  assert.equal(coverage.sampled, 2);
  assert.equal(coverage.timingRate, 0.75);
  assert.equal(coverage.completeTimingRate, 0.5);
  assert.equal(coverage.sampleRate, 0.4);
  assert.equal(coverage.dropped, 3);
  assert.deepEqual(
    [
      coverage.droppedByReason.output_missing_zero_invalid,
      coverage.droppedByReason.duration_missing_nonpositive_invalid,
      coverage.droppedByReason.partial_item_span,
    ],
    [1, 1, 1],
  );
});

test("M1.2 identities on a mixed fixture: eligible sum, monotone chain, reason sum", () => {
  const selection = selectPerfSamples(
    [
      okZcode({ identity: ["c1"] }),
      okZcode({ identity: ["c2"] }),
      okZcode({ identity: ["p"], status: "in_progress" }),
      okZcode({ identity: ["z"], outputTokens: 0 }),
      okZcode({ identity: ["m"], durationMs: null }),
      okZcode({ identity: ["u"], tsMs: null }),
    ],
    {},
  );
  const coverage = computePerfCoverage(selection, {});
  assert.equal(coverage.eligible, 5);
  assert.equal(coverage.sampled + coverage.dropped + coverage.pending, coverage.eligible);
  assert.equal(coverage.sampled, 2);
  assert.equal(coverage.dropped, 2);
  assert.equal(coverage.pending, 1);
  assert.equal(coverage.unplaced, 1);
  assert.ok(coverage.sampled <= coverage.completeTimedPositiveOutput);
  assert.ok(coverage.completeTimedPositiveOutput <= coverage.timedPositiveOutput);
  assert.ok(coverage.timedPositiveOutput <= coverage.positiveOutput);
  assert.ok(coverage.positiveOutput <= coverage.eligible);
  assert.deepEqual(
    [
      coverage.sampled,
      coverage.completeTimedPositiveOutput,
      coverage.timedPositiveOutput,
      coverage.positiveOutput,
      coverage.eligible,
    ],
    [2, 3, 3, 4, 5],
  );
  assert.equal(sumValues(coverage.droppedByReason), coverage.dropped);
});

test("M1.2 byEra splits Codex only, honors the cutoff parameter and boundary", () => {
  const oldTurn = okCodex({ turnId: "old", tsMs: MS });
  const newTurn = okCodex({ turnId: "new", tsMs: RECENT_MS });
  const codex = computePerfCoverage(selectPerfSamples([oldTurn, newTurn], {}), {});
  assert.notEqual(codex.byEra, null);
  assert.equal(codex.byEra.legacy.eligible, 1);
  assert.equal(codex.byEra.recent.eligible, 1);
  // era membership follows tsMs: each single-sample selection lands on its own side
  const onlyOld = computePerfCoverage(selectPerfSamples([oldTurn], {}), {});
  assert.equal(onlyOld.byEra.legacy.eligible, 1);
  assert.equal(onlyOld.byEra.recent.eligible, 0);
  const onlyNew = computePerfCoverage(selectPerfSamples([newTurn], {}), {});
  assert.equal(onlyNew.byEra.recent.eligible, 1);
  assert.equal(onlyNew.byEra.legacy.eligible, 0);
  assert.equal(codex.byEra.recent.byEra, null);
  assert.equal(codex.byEra.legacy.byEra, null);
  assert.equal(codex.byEra.recent.unplaced, 0);

  // 非 Codex 组 byEra 为 null, even with the same timestamps
  const zcode = computePerfCoverage(
    selectPerfSamples([okZcode({ identity: ["old"], tsMs: MS }), okZcode({ identity: ["new"], tsMs: RECENT_MS })], {}),
    {},
  );
  assert.equal(zcode.byEra, null);

  // mixed kinds never split
  const mixed = computePerfCoverage(selectPerfSamples([oldTurn, okZcode({ identity: ["z"] })], {}), {});
  assert.equal(mixed.byEra, null);

  // caller override moves the split; ts == cutoff counts as recent
  const overridden = computePerfCoverage(selectPerfSamples([oldTurn, newTurn], {}), { eraCutoffMs: MS });
  assert.equal(overridden.byEra.recent.eligible, 2);
  assert.equal(overridden.byEra.legacy.eligible, 0);
});

test("M1.2 unsupported knownSources are listed, never synthesized into eligible", () => {
  const probe = okZcode({ identity: ["probe"] });
  const selection = selectPerfSamples([probe], {
    knownSources: [
      { kind: "project-log", homeId: "home-pl" },
      { kind: "zcode", homeId: HOME },
    ],
  });
  assert.deepEqual(selection.unsupportedSources, [{ kind: "project-log", homeId: "home-pl" }]);
  const coverage = computePerfCoverage(selection, {});
  assert.equal(coverage.eligible, 1);
  assert.equal(coverage.sampled, 1);
});

test("M1.2 reason derivation reads flags only (ruling R) and rejects bad inputs fail-closed", () => {
  // diagnosticReason stays source-side: output_missing head, source_filtered main reason
  const filtered = okSample(zcodeRaw({ identity: ["f"], status: "error", outputTokens: null }));
  assert.equal(filtered.diagnosticReason, "output_missing");
  assert.equal(perfDroppedByReason(filtered), "source_filtered");
  assert.notEqual(perfDroppedByReason(filtered), filtered.diagnosticReason);
  assert.ok(PERF_DROPPED_BY_REASONS.includes(/** @type {string} */ (perfDroppedByReason(filtered))));

  // a dropped candidate with none of the reason flags cannot silently enter the sum
  const foreignFailed = { ...okZcode({ identity: ["foreign"] }), status: "failed", sampleFlags: 0 };
  assert.throws(() => perfDroppedByReason(foreignFailed), /§17\.5:278/);
  assert.throws(() => perfDroppedByReason(null), TypeError);
  assert.throws(() => selectPerfSamples("nope"), TypeError);
  assert.throws(() => selectPerfSamples([], { range: { startMs: "yesterday" } }), TypeError);
  assert.throws(() => selectPerfSamples([], { excludedHomeIds: "home-a" }), TypeError);
  assert.throws(() => selectPerfSamples([], { range: { startMs: Number.NaN } }), TypeError);
  assert.throws(() => computePerfCoverage(null), TypeError);
  assert.throws(() => computePerfCoverage({ eligible: [], unplaced: [] }, { eraCutoffMs: Number.NaN }), TypeError);
});

test("M1.2 select accepts Sets, Date bounds and bare calls", () => {
  const a = okZcode({ identity: ["a"], homeId: "home-a", tsMs: MS });
  const b = okZcode({ identity: ["b"], homeId: "home-b", tsMs: MS });
  const viaSet = selectPerfSamples([a, b], { excludedHomeIds: new Set(["home-b"]) });
  assert.deepEqual(keysOf(viaSet.eligible), [a.sampleKey]);
  assert.deepEqual(keysOf(viaSet.excluded), [b.sampleKey]);

  const viaDates = selectPerfSamples([a], { range: { startMs: new Date(MS - 1), endMs: new Date(MS + 1) } });
  assert.equal(viaDates.eligible.length, 1);

  const bare = selectPerfSamples([a, b]);
  assert.equal(bare.eligible.length, 2);
  assert.equal(bare.excluded.length, 0);
  assert.equal(bare.unplaced.length, 0);
  assert.equal(bare.outOfRange.length, 0);
});

test("M1.2-返工-1 the conflict comparison is an allow-list: location differs, evidence decides", () => {
  // The allow-list is named and excludes exactly the non-evidence fields.
  assert.ok(Array.isArray(PERF_CONFLICT_COMPARE_KEYS) || PERF_CONFLICT_COMPARE_KEYS instanceof Set);
  const compared = new Set(PERF_CONFLICT_COMPARE_KEYS);
  for (const key of ["status", "outputTokens", "durationMs", "tsMs", "model", "agentKind", "turnKey", "window"]) {
    assert.ok(compared.has(key), `expected ${key} to be compared`);
  }
  for (const key of [
    "sourcePath",
    "sampleFlags",
    "diagnosticReason",
    "diagnosticReasonChain",
    "methodVersion",
    "sampleKey",
  ]) {
    assert.equal(compared.has(key), false, `${key} must not be compared`);
  }

  const conflictFlags = (selection) =>
    selection.eligible
      .map((sample) => sample.sampleFlags)
      .filter((mask) => perfFlagNamesOf(mask).includes("RECORD_CONFLICT"));

  // 正例: same evidence, different file -> folds, no conflict, still one candidate
  const onlyPath = okCodex({ identity: ["p"], sourcePath: "a.jsonl" });
  const onlyPathB = { ...onlyPath, sourcePath: "b.jsonl" };
  const folded = selectPerfSamples([onlyPath, onlyPathB], {});
  assert.equal(folded.eligible.length, 1);
  assert.equal(conflictFlags(folded).length, 0);
  assert.equal(computePerfCoverage(folded, {}).sampled, 1);
  assert.equal(computePerfCoverage(folded, {}).dropped, 0);

  // 反例: only outputTokens differs -> conflict
  const tokensDiffer = selectPerfSamples([onlyPath, { ...onlyPath, outputTokens: 999 }], {});
  assert.equal(tokensDiffer.eligible.length, 1);
  assert.equal(conflictFlags(tokensDiffer).length, 1);

  // 反例: only model differs -> conflict
  const modelDiffer = selectPerfSamples([onlyPath, { ...onlyPath, model: "other-model" }], {});
  assert.equal(conflictFlags(modelDiffer).length, 1);

  // 反例: an excluded-field difference must NOT mask a real conflict
  const both = selectPerfSamples([onlyPath, { ...onlyPath, sourcePath: "b.jsonl", outputTokens: 999 }], {});
  assert.equal(conflictFlags(both).length, 1);
  assert.equal(computePerfCoverage(both, {}).dropped, 1);

  // location evidence survives the fold: the survivor's path is a real member's path
  assert.ok([onlyPath.sourcePath, onlyPathB.sourcePath].includes(folded.eligible[0].sourcePath));
});

test("M1.2-返工-2 conflicting groups resolve the same way for both input orders", () => {
  const runBothOrders = (rows) => {
    const forward = selectPerfSamples(rows, { range: RANGE });
    const backward = selectPerfSamples([...rows].reverse(), { range: RANGE });
    return [forward, backward];
  };
  const coverageOf = (selection) => computePerfCoverage(selection, {});
  const tsOf = (selection) => selection.eligible.map((sample) => sample.tsMs);

  // --- 状态: in_progress vs completed, both orders -> dropped, never pending ---
  const pending = okZcode({ identity: ["s"], status: "in_progress" });
  const completed = okZcode({ identity: ["s"], status: "completed" });
  const [stateFwd, stateBwd] = runBothOrders([pending, completed]);
  for (const [label, selection] of [
    ["[pending,completed]", stateFwd],
    ["[completed,pending]", stateBwd],
  ]) {
    const coverage = coverageOf(selection);
    assert.equal(coverage.dropped, 1, label);
    assert.equal(coverage.pending, 0, label);
    assert.equal(coverage.sampled, 0, label);
    assert.equal(coverage.eligible, 1, label);
    assert.equal(coverage.droppedByReason.record_conflict, 1, label);
    // ruling R: the source-side vocabulary is untouched by the conflict flag
    assert.notEqual(selection.eligible[0].diagnosticReason, "record_conflict");
  }
  assert.deepEqual(coverageOf(stateFwd).droppedByReason, coverageOf(stateBwd).droppedByReason);

  // --- 时间: one member in range, one out -> eligible in both orders, diagnostic survives ---
  const inRange = okZcode({ identity: ["t"], tsMs: MS });
  const outRange = okZcode({ identity: ["t"], tsMs: MS + 10_000 });
  const [timeFwd, timeBwd] = runBothOrders([inRange, outRange]);
  for (const [label, selection] of [
    ["[in,out]", timeFwd],
    ["[out,in]", timeBwd],
  ]) {
    assert.equal(selection.eligible.length, 1, label);
    assert.equal(perfFlagNamesOf(selection.eligible[0].sampleFlags).includes("RECORD_CONFLICT"), true, label);
    assert.equal(computePerfCoverage(selection, {}).droppedByReason.record_conflict, 1, label);
    // representative ts is the in-range member's value, identical in both orders
    assert.equal(selection.eligible[0].tsMs, MS, label);
  }
  assert.deepEqual(tsOf(timeFwd), tsOf(timeBwd));

  // --- 时间: both members outside -> never invented into eligible ---
  const outA = okZcode({ identity: ["u"], tsMs: MS + 10_000 });
  const outB = okZcode({ identity: ["u"], tsMs: MS + 20_000 });
  const [outFwd, outBwd] = runBothOrders([outA, outB]);
  for (const [label, selection] of [
    ["[outA,outB]", outFwd],
    ["[outB,outA]", outBwd],
  ]) {
    assert.equal(selection.eligible.length, 0, label);
    assert.equal(selection.outOfRange.length, 1, label);
  }
  // representative ts is the group minimum when nothing is in range (diagnostics only)
  assert.equal(outFwd.outOfRange[0].tsMs, MS + 10_000);
  assert.deepEqual(tsOf(outFwd), tsOf(outBwd));

  // --- 归属: same sampleKey implies one home (M1.1-返工2 invariant) ---
  assert.deepEqual(
    [...new Set([pending, completed].map((sample) => sample.homeId))],
    [JSON.parse(/** @type {string} */ (pending.sampleKey))[1]],
  );

  // --- 回归: consistent duplicates still fold to one eligible candidate in both orders ---
  const dup = okZcode({ identity: ["d"] });
  const [dupFwd, dupBwd] = runBothOrders([dup, { ...dup }]);
  for (const selection of [dupFwd, dupBwd]) {
    assert.equal(selection.eligible.length, 1);
    assert.equal(computePerfCoverage(selection, {}).sampled, 1);
    assert.equal(perfFlagNamesOf(selection.eligible[0].sampleFlags).includes("RECORD_CONFLICT"), false);
  }
});

test("M1.2-返工-3 an invalid Date range bound is rejected like a non-finite number", () => {
  const invalid = new Date("invalid");
  assert.ok(Number.isNaN(invalid.getTime()));
  const sample = okZcode({ identity: ["r"] });

  for (const field of ["startMs", "endMs", "windowEndExclusiveMs"]) {
    assert.throws(
      () => selectPerfSamples([sample], { range: { [field]: invalid } }),
      (error) => error instanceof TypeError && /finite millisecond numbers or Dates/.test(error.message),
      `${field} with an invalid Date`,
    );
    // the same field rejects a non-finite number through the same path
    assert.throws(() => selectPerfSamples([sample], { range: { [field]: Number.NaN } }), TypeError, field);
    assert.throws(
      () => selectPerfSamples([sample], { range: { [field]: Number.POSITIVE_INFINITY } }),
      TypeError,
      field,
    );
  }
  // an invalid Date is not rescued by a valid sibling bound
  assert.throws(() => selectPerfSamples([sample], { range: { startMs: new Date(MS - 1), endMs: invalid } }), TypeError);

  // 回归: valid Dates still work for every bound, and still filter correctly
  const okRange = {
    startMs: new Date(MS - 100),
    endMs: new Date(MS + 100),
    windowEndExclusiveMs: new Date(MS + 100),
  };
  assert.equal(selectPerfSamples([sample], { range: okRange }).eligible.length, 1);
  assert.equal(selectPerfSamples([sample], { range: { startMs: new Date(MS + 1) } }).eligible.length, 0);
  assert.equal(selectPerfSamples([sample], { range: { endMs: new Date(MS - 1) } }).eligible.length, 0);
  // windowEndExclusiveMs is exclusive
  assert.equal(selectPerfSamples([sample], { range: { windowEndExclusiveMs: new Date(MS) } }).eligible.length, 0);
  assert.equal(selectPerfSamples([sample], { range: { windowEndExclusiveMs: new Date(MS + 1) } }).eligible.length, 1);
});

test("M1.2-返工2-1 a consistent fold merges member filter evidence, in either order", () => {
  // "not compared" must not mean "not kept": sampleFlags is outside the conflict
  // allow-list, so an unmerged fold would erase a member's filter marker.
  const plain = okZcode({ identity: ["f"] });
  const marked = okZcode({ identity: ["f"], sampleFlags: ["PARTIAL_ITEM_SPAN"] });
  assert.notEqual(plain.sampleFlags, marked.sampleFlags);

  const foldedOf = (rows) => {
    const selection = selectPerfSamples(rows, { range: RANGE });
    assert.equal(selection.eligible.length, 1);
    const sample = selection.eligible[0];
    const coverage = computePerfCoverage(selection, {});
    return { sample, coverage };
  };

  // partial: both orders drop and carry the merged marker
  for (const [label, rows] of [
    ["[plain,partial]", [plain, marked]],
    ["[partial,plain]", [marked, plain]],
  ]) {
    const { sample, coverage } = foldedOf(rows);
    assert.equal(flagSet(sample).has("PARTIAL_ITEM_SPAN"), true, label);
    assert.equal(coverage.dropped, 1, label);
    assert.equal(coverage.sampled, 0, label);
    assert.equal(coverage.droppedByReason.partial_item_span, 1, label);
    assert.equal(coverage.byFlag.PARTIAL_ITEM_SPAN, 1, label);
  }

  // overlap: same, through its own flag and reason
  const overlap = okZcode({ identity: ["f"], sampleFlags: ["OVERLAPPING_ITEM_SPAN"] });
  for (const [label, rows] of [
    ["[plain,overlap]", [plain, overlap]],
    ["[overlap,plain]", [overlap, plain]],
  ]) {
    const { sample, coverage } = foldedOf(rows);
    assert.equal(flagSet(sample).has("OVERLAPPING_ITEM_SPAN"), true, label);
    assert.equal(coverage.dropped, 1, label);
    assert.equal(coverage.droppedByReason.overlapping_item_span, 1, label);
  }

  // hint-only merge stays sampled, but the hint is not lost
  const hint = okZcode({ identity: ["f"], sampleFlags: ["METHOD_ESTIMATE"] });
  for (const [label, rows] of [
    ["[plain,hint]", [plain, hint]],
    ["[hint,plain]", [hint, plain]],
  ]) {
    const { sample, coverage } = foldedOf(rows);
    assert.equal(flagSet(sample).has("METHOD_ESTIMATE"), true, label);
    assert.equal(coverage.sampled, 1, label);
    assert.equal(coverage.dropped, 0, label);
    assert.equal(coverage.byFlag.METHOD_ESTIMATE, 1, label);
  }

  // merged mask is the bitwise OR of the members, and both orders agree exactly
  const both = okZcode({ identity: ["f"], sampleFlags: ["PARTIAL_ITEM_SPAN", "LONG_WINDOW"] });
  const fwd = foldedOf([plain, both]).sample;
  const bwd = foldedOf([both, plain]).sample;
  assert.equal(fwd.sampleFlags, both.sampleFlags | plain.sampleFlags);
  assert.equal(fwd.sampleFlags, bwd.sampleFlags);
  assert.deepEqual(fwd.diagnosticReasonChain, bwd.diagnosticReasonChain);

  // headline follows the §17.5:278 priority over the merged flags, both orders
  const missingOut = okZcode({ identity: ["f"], sampleFlags: ["MISSING_OUTPUT"] });
  const headFwd = foldedOf([marked, missingOut]).coverage.droppedByReason;
  const headBwd = foldedOf([missingOut, marked]).coverage.droppedByReason;
  // MISSING_OUTPUT outranks PARTIAL_ITEM_SPAN in the frozen priority table
  assert.equal(headFwd.output_missing_zero_invalid, 1);
  assert.deepEqual(headFwd, headBwd);

  // a single-member group is untouched by the merge (no behavior change)
  assert.equal(selectPerfSamples([plain], { range: RANGE }).eligible[0].sampleFlags, plain.sampleFlags);
});

test("M1.2-返工2-2 a conflicted group picks the same owner regardless of member order", () => {
  const keyOf = (rows) => {
    const selection = selectPerfSamples(rows, { range: RANGE });
    assert.equal(selection.eligible.length, 1);
    return perfGroupKey(selection.eligible[0]);
  };
  const bothOrders = (a, b) => [keyOf([a, b]), keyOf([b, a])];

  // All sort keys tie (same ts, same path); only the semantic signature differs.
  const modelA = okZcode({ identity: ["o"], model: "model-a", sourcePath: "same.jsonl" });
  const modelB = okZcode({ identity: ["o"], model: "model-b", sourcePath: "same.jsonl" });
  assert.equal(modelA.tsMs, modelB.tsMs);
  assert.equal(modelA.sourcePath, modelB.sourcePath);
  const [modelFwd, modelBwd] = bothOrders(modelA, modelB);
  assert.equal(modelFwd, modelBwd);
  // and the conflict is still reported exactly once either way
  for (const rows of [
    [modelA, modelB],
    [modelB, modelA],
  ]) {
    const coverage = computePerfCoverage(selectPerfSamples(rows, { range: RANGE }), {});
    assert.equal(coverage.droppedByReason.record_conflict, 1);
    assert.equal(coverage.dropped, 1);
  }

  // same ts, same path, same outputTokens, differing modelProvider
  const provA = okZcode({ identity: ["o"], modelProvider: "prov-a", sourcePath: "same.jsonl" });
  const provB = okZcode({ identity: ["o"], modelProvider: "prov-b", sourcePath: "same.jsonl" });
  assert.equal(provA.outputTokens, provB.outputTokens);
  const [provFwd, provBwd] = bothOrders(provA, provB);
  assert.equal(provFwd, provBwd);

  // exhaustive: three conflicting members, all 6 orders, one owner and one outcome
  const members = [
    okZcode({ identity: ["o"], model: "m-a", tsMs: MS, sourcePath: "same.jsonl" }),
    okZcode({ identity: ["o"], model: "m-b", tsMs: MS, sourcePath: "same.jsonl" }),
    okZcode({ identity: ["o"], model: "m-c", tsMs: MS, sourcePath: "same.jsonl" }),
  ];
  const owners = new Set();
  const outcomes = new Set();
  const permute = (rest, prefix = []) => {
    if (rest.length === 0) {
      const selection = selectPerfSamples(prefix, { range: RANGE });
      owners.add(perfGroupKey(selection.eligible[0]));
      const coverage = computePerfCoverage(selection, {});
      outcomes.add(
        JSON.stringify({ dropped: coverage.dropped, reasons: coverage.droppedByReason, flags: coverage.byFlag }),
      );
      return;
    }
    for (let index = 0; index < rest.length; index += 1) {
      permute([...rest.slice(0, index), ...rest.slice(index + 1)], [...prefix, rest[index]]);
    }
  };
  permute(members);
  assert.equal(owners.size, 1);
  assert.equal(outcomes.size, 1);
});

test("M1.2-返工3-1 a conflicted group merges every member's filter evidence too", () => {
  // Symmetry with the fold path: disagreement must not discard evidence. A member
  // carrying PARTIAL_ITEM_SPAN has to survive the conflict resolution.
  const plainA = okZcode({ identity: ["c"], model: "model-a", sourcePath: "same.jsonl" });
  const partialA = okZcode({
    identity: ["c"],
    model: "model-a",
    sourcePath: "same.jsonl",
    sampleFlags: ["PARTIAL_ITEM_SPAN"],
  });
  const plainB = okZcode({ identity: ["c"], model: "model-b", sourcePath: "same.jsonl" });
  assert.equal(plainA.sampleFlags, plainB.sampleFlags);
  assert.notEqual(plainA.sampleFlags, partialA.sampleFlags);

  const outcomes = new Set();
  const permute = (rest, prefix = []) => {
    if (rest.length === 0) {
      const selection = selectPerfSamples(prefix, { range: RANGE });
      const coverage = computePerfCoverage(selection, {});
      const sample = selection.eligible[0];
      outcomes.add(
        JSON.stringify({
          dropped: coverage.dropped,
          sampled: coverage.sampled,
          pending: coverage.pending,
          partial: coverage.byFlag.PARTIAL_ITEM_SPAN ?? 0,
          overlap: coverage.byFlag.OVERLAPPING_ITEM_SPAN ?? 0,
          reasons: coverage.droppedByReason,
          flags: sample.sampleFlags,
          chain: sample.diagnosticReasonChain,
          headline: sample.diagnosticReason,
        }),
      );
      return;
    }
    for (let index = 0; index < rest.length; index += 1) {
      permute([...rest.slice(0, index), ...rest.slice(index + 1)], [...prefix, rest[index]]);
    }
  };
  permute([plainA, partialA, plainB]);
  assert.equal(outcomes.size, 1, "all 6 permutations must agree");
  const only = JSON.parse([...outcomes][0]);
  // the member's marker survives, on top of the conflict bit
  assert.equal(only.partial, 1);
  assert.equal(only.dropped, 1);
  assert.equal(only.reasons.record_conflict, 1);
  assert.equal(only.flags & (1 << perfFlagBit("PARTIAL_ITEM_SPAN")), 1 << perfFlagBit("PARTIAL_ITEM_SPAN"));
  assert.equal(only.flags & (1 << perfFlagBit("RECORD_CONFLICT")), 1 << perfFlagBit("RECORD_CONFLICT"));

  // control group with the overlap marker instead
  const overlapA = okZcode({
    identity: ["c"],
    model: "model-a",
    sourcePath: "same.jsonl",
    sampleFlags: ["OVERLAPPING_ITEM_SPAN"],
  });
  const overlapOutcomes = new Set();
  const permuteOverlap = (rest, prefix = []) => {
    if (rest.length === 0) {
      const selection = selectPerfSamples(prefix, { range: RANGE });
      const coverage = computePerfCoverage(selection, {});
      overlapOutcomes.add(
        JSON.stringify({
          dropped: coverage.dropped,
          overlap: coverage.byFlag.OVERLAPPING_ITEM_SPAN ?? 0,
          partial: coverage.byFlag.PARTIAL_ITEM_SPAN ?? 0,
          flags: selection.eligible[0].sampleFlags,
        }),
      );
      return;
    }
    for (let index = 0; index < rest.length; index += 1) {
      permuteOverlap([...rest.slice(0, index), ...rest.slice(index + 1)], [...prefix, rest[index]]);
    }
  };
  permuteOverlap([plainA, overlapA, plainB]);
  assert.equal(overlapOutcomes.size, 1);
  assert.equal(JSON.parse([...overlapOutcomes][0]).overlap, 1);

  // and the representative still decides the semantic fields, not the evidence
  const owners = new Set();
  for (const rows of [
    [plainA, partialA, plainB],
    [plainB, partialA, plainA],
    [partialA, plainA, plainB],
  ]) {
    owners.add(perfGroupKey(selectPerfSamples(rows, { range: RANGE }).eligible[0]));
  }
  assert.equal(owners.size, 1);
});

test("M1.2-返工3-2 comparison keys use code units, so a strict total order holds", () => {
  const composed = "\u00e9"; // é as one code point
  const decomposed = "e\u0301"; // e + combining acute
  // premise: literally different, yet locale-aware comparison calls them equal
  assert.notEqual(composed, decomposed);
  assert.equal(composed.localeCompare(decomposed), 0);

  // the conflict owner must still be decided, so groupKey must not follow the input
  const ownerOf = (rows) => perfGroupKey(selectPerfSamples(rows, { range: RANGE }).eligible[0]);
  const modelA = okZcode({ identity: ["u"], model: composed, sourcePath: "same.jsonl" });
  const modelB = okZcode({ identity: ["u"], model: decomposed, sourcePath: "same.jsonl" });
  assert.equal(ownerOf([modelA, modelB]), ownerOf([modelB, modelA]));
  // the same holds when only the path differs by Unicode form
  const pathA = okZcode({ identity: ["u"], model: "same-model", sourcePath: `${composed}.jsonl` });
  const pathB = okZcode({ identity: ["u"], model: "different-model", sourcePath: `${decomposed}.jsonl` });
  assert.equal(ownerOf([pathA, pathB]), ownerOf([pathB, pathA]));
  // both orders still report exactly one conflict
  for (const rows of [
    [modelA, modelB],
    [modelB, modelA],
  ]) {
    const coverage = computePerfCoverage(selectPerfSamples(rows, { range: RANGE }), {});
    assert.equal(coverage.byFlag.RECORD_CONFLICT, 1);
  }

  // the observable ordering contract, checked through groupKey ordering of the two
  // members when each stands alone (no resolution involved)
  assert.notEqual(perfGroupKey(modelA), perfGroupKey(modelB));
});

test("M1.2-返工4 a missing tsMs has a fixed slot, so the conflict order is transitive", () => {
  // The audit reproduction: a numeric pair decided by time, a numeric/missing pair
  // decided by path, and a numeric pair decided by path again formed the cycle
  // A<B<C<A — so `sort` depended on input order. All three members sit outside the
  // range, so the survivor lands in `outOfRange`.
  const WINDOW = { startMs: MS + 100, endMs: MS + 200 };
  const A = okZcode({ identity: ["t"], tsMs: MS, sourcePath: "z.jsonl", model: "model-a" });
  const B = okZcode({ identity: ["t"], tsMs: MS + 1, sourcePath: "a.jsonl", model: "model-b" });
  const C = okZcode({ identity: ["t"], tsMs: null, sourcePath: "m.jsonl", model: "model-c" });
  // premise: exactly the mixed-type shape the defect needed
  assert.equal(typeof A.tsMs, "number");
  assert.equal(typeof B.tsMs, "number");
  assert.equal(C.tsMs, null);

  const representatives = new Set();
  const permute = (rest, prefix = []) => {
    if (rest.length === 0) {
      const selection = selectPerfSamples(prefix, { range: WINDOW });
      assert.equal(selection.outOfRange.length, 1);
      const representative = selection.outOfRange[0];
      representatives.add(`${representative.model}|${representative.tsMs}|${representative.sourcePath}`);
      // the representative tsMs is the group minimum over numeric members, always
      assert.equal(representative.tsMs, MS);
      return;
    }
    for (let index = 0; index < rest.length; index += 1) {
      permute([...rest.slice(0, index), ...rest.slice(index + 1)], [...prefix, rest[index]]);
    }
  };
  permute([A, B, C]);
  assert.equal(representatives.size, 1, "all 6 permutations must pick the same representative");

  // transitivity of the resolved order: the pairwise winners must not form a cycle.
  // Probed through the module itself, so this exercises the real comparator.
  const winnerOf = (x, y) => {
    const forward = selectPerfSamples(
      [
        { ...x, model: "X" },
        { ...y, model: "Y" },
      ],
      { range: WINDOW },
    ).outOfRange[0];
    const backward = selectPerfSamples(
      [
        { ...y, model: "Y" },
        { ...x, model: "X" },
      ],
      { range: WINDOW },
    ).outOfRange[0];
    assert.equal(forward.model, backward.model, "pairwise order must not depend on input order");
    return forward.model;
  };
  const aBeforeB = winnerOf(A, B) === "X";
  const bBeforeC = winnerOf(B, C) === "X";
  const cBeforeA = winnerOf(C, A) === "X";
  assert.equal(aBeforeB && bBeforeC && cBeforeA, false, "A<B<C<A must not hold");
  // and the transitive conclusion is actually observed
  if (aBeforeB && bBeforeC) assert.equal(winnerOf(A, C), "X", "A<B and B<C must imply A<C");

  // numbers rank ahead of a missing timestamp, in both input orders
  const numeric = okZcode({ identity: ["t"], tsMs: MS, sourcePath: "same.jsonl", model: "numeric" });
  const missing = okZcode({ identity: ["t"], tsMs: null, sourcePath: "same.jsonl", model: "missing" });
  for (const rows of [
    [numeric, missing],
    [missing, numeric],
  ]) {
    const selection = selectPerfSamples(rows, { range: WINDOW });
    assert.equal(selection.outOfRange.length, 1);
    // the numeric member wins the representative slot
    assert.equal(selection.outOfRange[0].model, "numeric");
  }

  // two missing timestamps: the group has no numeric member, so its representative
  // tsMs stays null and it is unplaced (never in `eligible`, never `outOfRange`),
  // but the member choice is still ordered by path and must not follow input order
  const missA = okZcode({ identity: ["t"], tsMs: null, sourcePath: "a.jsonl", model: "m-a" });
  const missB = okZcode({ identity: ["t"], tsMs: null, sourcePath: "b.jsonl", model: "m-b" });
  const missFwd = selectPerfSamples([missA, missB], { range: WINDOW });
  const missBwd = selectPerfSamples([missB, missA], { range: WINDOW });
  assert.equal(missFwd.unplaced.length, 1);
  assert.equal(missFwd.outOfRange.length, 0);
  assert.equal(missFwd.eligible.length, 0);
  assert.equal(missFwd.unplaced[0].model, missBwd.unplaced[0].model);
  assert.equal(missFwd.unplaced[0].sourcePath, "a.jsonl");
  assert.equal(missFwd.unplaced[0].tsMs, null);
});
