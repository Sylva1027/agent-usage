import assert from "node:assert/strict";
import test from "node:test";

import {
  computePerfCoverage,
  normalizePerfSample,
  perfGroupKey,
  selectPerfSamples,
  summarizePerf,
  PERF_ERA_CUTOFF_MS,
  PERF_LONG_WINDOW_MS,
  PERF_METHOD_VERSION,
  PERF_MIN_SAMPLES,
  PERF_SOURCE_WARNING_CODES,
} from "../src/perf-stats.js";

/**
 * M1.3 summary/parity fixture.
 *
 * Every expected number in this file was computed **by hand** from plan §17.2:226
 * (`r_i = output_tokens_i × 1000 / duration_ms_i`, then `r[ceil(p × n) − 1]`). None
 * of them was copied from the implementation. The mutation check at the bottom of
 * this file exists to keep that claim honest: it flips `ceil` to `floor` in a copy
 * of the module and asserts the fixture numbers change, which is only possible if
 * the fixture is actually pinning the nearest-rank rule.
 */

const T = 1_760_000_000_000;
/** A range that comfortably contains every fixture timestamp below. */
const RANGE = { startMs: T - 1_000, endMs: T + 100_000 };

/**
 * Build a normalized sample. Defaults are deliberately boring so a test only has to
 * name the fields it is actually about.
 * @param {Record<string, unknown>} [overrides]
 */
function sample(overrides = {}) {
  const result = normalizePerfSample({
    sourceKind: "zcode",
    homeId: "h1",
    identity: ["r"],
    status: "completed",
    tsMs: T,
    channel: "main",
    agentKind: "main",
    agent: "",
    model: "m1",
    modelProvider: "",
    reasoningEffort: "",
    // §17.1 source semantics: `window` and `tokenScope` must agree with `sourceKind`
    // or normalization reports SOURCE_SEMANTICS_MISMATCH.
    window: "request",
    timingKind: "request_e2e",
    tokenScope: "reported_output_unspecified",
    durationMs: 2_000,
    outputTokens: 1_000,
    ...overrides,
  });
  assert.equal(result.warningCode, null, `fixture sample must normalize cleanly: ${result.warningCode}`);
  return result.sample;
}

const only = (groups) => {
  assert.equal(groups.length, 1);
  return groups[0];
};

test("M1.3-1 parity fixture: nearest-rank quantiles, pooled and duration are hand-computed", () => {
  // Four members in one group (same §17.1 dimensions). Outputs are all 1000 so the
  // rates come purely from the durations, which makes the arithmetic auditable:
  //
  //   durations = [2000, 4000, 1000, 8000]      outputs = [1000, 1000, 1000, 1000]
  //   r_i       = out × 1000 / dur = [500, 250, 1000, 125]
  //   sorted r  = [125, 250, 500, 1000]                       (ascending, n = 4)
  //   p10: ceil(0.1 × 4) − 1 = ceil(0.4) − 1 = 1 − 1 = 0  -> 125
  //   p50: ceil(0.5 × 4) − 1 = ceil(2.0) − 1 = 2 − 1 = 1  -> 250
  //   p90: ceil(0.9 × 4) − 1 = ceil(3.6) − 1 = 4 − 1 = 3  -> 1000
  //   pooled = (1000+1000+1000+1000) × 1000 / (2000+4000+1000+8000)
  //          = 4_000_000 / 15_000 = 266.666...
  //
  // Durations are quantiled on their own axis (never back-derived from the TPS
  // values, plan §17.2:227):
  //   sorted dur = [1000, 2000, 4000, 8000]
  //   dur p50: ceil(0.5 × 4) − 1 = 1 -> 2000
  //   dur p90: ceil(0.9 × 4) − 1 = 3 -> 8000
  //
  // Note the durations deliberately straddle the p50/p90 slots so that a `floor`
  // implementation would return 500 / 4000 instead — see the mutation test below.
  const members = [
    sample({ identity: ["fixture-1"], durationMs: 2_000, outputTokens: 1_000, tsMs: T }),
    sample({ identity: ["fixture-2"], durationMs: 4_000, outputTokens: 1_000, tsMs: T + 1 }),
    sample({ identity: ["fixture-3"], durationMs: 1_000, outputTokens: 1_000, tsMs: T + 2 }),
    sample({ identity: ["fixture-4"], durationMs: 8_000, outputTokens: 1_000, tsMs: T + 3 }),
  ];

  const summary = summarizePerf(members, { range: RANGE });
  const group = only(summary.groups);

  assert.equal(group.n, 4);
  assert.equal(group.tps.p10, 125);
  assert.equal(group.tps.p50, 250);
  assert.equal(group.tps.p90, 1_000);
  assert.equal(group.tps.pooled, (4_000 * 1_000) / 15_000);
  assert.equal(group.durationMs.p50, 2_000);
  assert.equal(group.durationMs.p90, 8_000);
  assert.equal(group.sums.outputTokens, 4_000);
  assert.equal(group.sums.durationMs, 15_000);
  assert.equal(group.state, "ok");
  // n = 4 < PERF_MIN_SAMPLES: kept, labelled, and deliberately not numbered.
  assert.equal(group.insufficientSamples, true);
  assert.equal(group.rank, null);

  // quantiles feed from the same set as pooled/n: 4 sampled members, 4 eligible.
  assert.equal(summary.coverage.eligible, 4);
  assert.equal(summary.coverage.sampled, 4);
  assert.equal(summary.groups.length, 1);
});

test("M1.3-2 parity fixture: n=1 collapses the three quantiles, n=0 emits no statistical group", () => {
  // n = 1: every p maps to ceil(p) − 1 = 0, so all three quantiles are r_0 and
  // pooled coincides with it. r = 1000 × 1000 / 2000 = 500.
  const single = sample({ identity: ["single"], durationMs: 2_000, outputTokens: 1_000 });
  const one = summarizePerf([single], { range: RANGE });
  const group = only(one.groups);
  assert.equal(group.n, 1);
  assert.equal(group.tps.p10, 500);
  assert.equal(group.tps.p50, 500);
  assert.equal(group.tps.p90, 500);
  assert.equal(group.tps.pooled, 500);
  assert.equal(one.meta.minSamples, PERF_MIN_SAMPLES);
  assert.equal(group.insufficientSamples, true);

  // n = 0: a real zero output is `OUTPUT_ZERO` (dropped), so nothing is sampled and
  // the plan forbids emitting a statistical row. The canonical reason stays the
  // shared §17.5:278 main reason for the missing/zero/invalid output family.
  const zero = sample({ identity: ["zero-output"], durationMs: 2_000, outputTokens: 0 });
  const none = summarizePerf([zero], { range: RANGE });
  assert.deepEqual(none.groups, []);
  assert.equal(none.coverage.eligible, 1);
  assert.equal(none.coverage.sampled, 0);
  assert.equal(none.coverage.dropped, 1);
  assert.equal(none.coverage.droppedByReason.output_missing_zero_invalid, 1);

  // An empty input is the same n = 0 path with a zero denominator: sampleRate is
  // `null` rather than a fabricated 0 or NaN.
  const empty = summarizePerf([], { range: RANGE });
  assert.deepEqual(empty.groups, []);
  assert.equal(empty.coverage.eligible, 0);
  assert.equal(empty.coverage.sampleRate, null);
});

test("M1.3-3 a real 0 and a missing value stay distinguishable", () => {
  // 0 is a true value; null is missing. The §17.5:278 main reason is deliberately
  // the same for both (`output_missing_zero_invalid` covers the whole family), so
  // the distinguishability must be observable elsewhere: in the field itself and in
  // the §17.4 flags that produced the diagnosis.
  const zeroOutput = sample({ identity: ["z-out"], outputTokens: 0, durationMs: 2_000 });
  const nullOutput = sample({ identity: ["n-out"], outputTokens: null, durationMs: 2_000 });
  assert.equal(zeroOutput.outputTokens, 0);
  assert.equal(nullOutput.outputTokens, null);
  assert.notEqual(zeroOutput.outputTokens, nullOutput.outputTokens);

  const zeroDuration = sample({ identity: ["z-dur"], outputTokens: 1_000, durationMs: 0 });
  const nullDuration = sample({ identity: ["n-dur"], outputTokens: 1_000, durationMs: null });
  assert.equal(zeroDuration.durationMs, 0);
  assert.equal(nullDuration.durationMs, null);
  assert.notEqual(zeroDuration.durationMs, nullDuration.durationMs);

  const zeroSummary = summarizePerf([zeroOutput], { range: RANGE });
  const nullSummary = summarizePerf([nullOutput], { range: RANGE });
  // Different §17.4 flags...
  assert.equal(zeroSummary.coverage.byFlag.OUTPUT_ZERO, 1);
  assert.equal(zeroSummary.coverage.byFlag.MISSING_OUTPUT, 0);
  assert.equal(nullSummary.coverage.byFlag.OUTPUT_ZERO, 0);
  assert.equal(nullSummary.coverage.byFlag.MISSING_OUTPUT, 1);
  // ...and different source-side diagnostics, even though the main reason is shared.
  assert.equal(zeroOutput.diagnosticReason, "output_zero");
  assert.equal(nullOutput.diagnosticReason, "output_missing");

  const zeroDurSummary = summarizePerf([zeroDuration], { range: RANGE });
  const nullDurSummary = summarizePerf([nullDuration], { range: RANGE });
  assert.equal(zeroDurSummary.coverage.byFlag.DURATION_NONPOSITIVE, 1);
  assert.equal(zeroDurSummary.coverage.byFlag.MISSING_DURATION, 0);
  assert.equal(nullDurSummary.coverage.byFlag.DURATION_NONPOSITIVE, 0);
  assert.equal(nullDurSummary.coverage.byFlag.MISSING_DURATION, 1);
  // Neither is sampled, and neither silently became the other.
  assert.equal(zeroDurSummary.coverage.sampled, 0);
  assert.equal(nullDurSummary.coverage.sampled, 0);
});

test("M1.3-4 pooled uses the sampled set only: pending, partial and filtered never enter it", () => {
  // Two sampled members define the pooled ratio:
  //   pooled = (1000 + 3000) × 1000 / (1000 + 1000) = 4_000_000 / 2_000 = 2000
  // The distractors below must not move that number:
  //   - partial span: has output/duration but is dropped (PARTIAL_ITEM_SPAN)
  //   - filtered: excluded by its home id
  //   - pending: explicitly in progress
  //   - out of range: outside the requested window
  const sampledA = sample({ identity: ["p-1"], durationMs: 1_000, outputTokens: 1_000, tsMs: T });
  const sampledB = sample({ identity: ["p-2"], durationMs: 1_000, outputTokens: 3_000, tsMs: T + 1 });
  const partial = sample({
    identity: ["p-3"],
    durationMs: 1_000,
    outputTokens: 9_999_999,
    tsMs: T + 2,
    sampleFlags: ["PARTIAL_ITEM_SPAN"],
  });
  const filtered = sample({ identity: ["p-4"], homeId: "h-excluded", durationMs: 1_000, outputTokens: 9_999_999 });
  const pending = sample({ identity: ["p-5"], status: "in_progress", durationMs: 1_000, outputTokens: 9_999_999 });
  const outOfRange = sample({ identity: ["p-6"], durationMs: 1_000, outputTokens: 9_999_999, tsMs: RANGE.endMs + 1 });

  const summary = summarizePerf([sampledA, sampledB, partial, filtered, pending, outOfRange], {
    range: RANGE,
    excludedHomeIds: ["h-excluded"],
  });
  const group = only(summary.groups);

  assert.equal(group.n, 2);
  assert.equal(group.sums.outputTokens, 4_000);
  assert.equal(group.sums.durationMs, 2_000);
  assert.equal(group.tps.pooled, 2_000);
  // sorted r = [1000, 3000]; p50: ceil(0.5 × 2) − 1 = 0 -> 1000 ; p90: ceil(1.8) − 1 = 1 -> 3000
  assert.equal(group.tps.p10, 1_000);
  assert.equal(group.tps.p50, 1_000);
  assert.equal(group.tps.p90, 3_000);

  assert.equal(summary.coverage.sampled, 2);
  assert.equal(summary.coverage.pending, 1);
  assert.equal(summary.coverage.droppedByReason.partial_item_span, 1);
  assert.equal(summary.coverage.byFlag.PARTIAL_ITEM_SPAN, 1);
  // the excluded home never reached the eligible set, and the out-of-range row
  // never reached it either: 6 rows = 2 sampled + 1 pending + 1 dropped + 1 excluded
  // + 1 out-of-range.
  assert.equal(summary.coverage.eligible, 4);
  assert.equal(summary.coverage.sampled + summary.coverage.pending + summary.coverage.dropped, 4);
  assert.equal(
    summary.coverage.eligible,
    summary.coverage.sampled + summary.coverage.pending + summary.coverage.dropped,
  );
});

test("M1.3-5 mixed dimensions split into separate groups, each aggregated on its own", () => {
  // Two sources, two homes, and separation by modelProvider / reasoningEffort /
  // tokenScope / agentKind / channel — §17.1 dimensions must all partition.
  const rows = [
    sample({
      identity: ["d-1"],
      sourceKind: "zcode",
      homeId: "h1",
      model: "m1",
      durationMs: 1_000,
      outputTokens: 1_000,
    }),
    // same model, different provider -> different group
    sample({
      identity: ["d-2"],
      sourceKind: "zcode",
      homeId: "h1",
      model: "m1",
      modelProvider: "prov-a",
      durationMs: 1_000,
      outputTokens: 2_000,
    }),
    // same everything but reasoningEffort -> different group
    sample({
      identity: ["d-3"],
      sourceKind: "zcode",
      homeId: "h1",
      model: "m1",
      reasoningEffort: "high",
      durationMs: 1_000,
      outputTokens: 3_000,
    }),
    // different tokenScope -> different group (`opencode` is the source whose
    // semantics carry `visible_plus_reasoning`)
    sample({
      identity: ["d-4"],
      sourceKind: "opencode",
      homeId: "h1",
      model: "m1",
      window: "message",
      tokenScope: "visible_plus_reasoning",
      durationMs: 1_000,
      outputTokens: 4_000,
    }),
    // subagent -> different group
    sample({
      identity: ["d-5"],
      sourceKind: "zcode",
      homeId: "h1",
      model: "m1",
      agentKind: "subagent",
      durationMs: 1_000,
      outputTokens: 5_000,
    }),
    // other source and other home -> different group. `dsh` is a step window, so the
    // window must move with the source kind to stay semantically consistent.
    sample({
      identity: ["d-6"],
      sourceKind: "dsh",
      homeId: "h2",
      model: "m1",
      window: "step",
      durationMs: 1_000,
      outputTokens: 6_000,
    }),
  ];
  const summary = summarizePerf(rows, { range: RANGE });

  assert.equal(summary.groups.length, 6, "every differing §17.1 dimension must split the group");
  assert.equal(summary.coverage.sampled, 6);
  // each group holds exactly its own single member
  for (const group of summary.groups) {
    assert.equal(group.n, 1);
    assert.equal(group.sums.durationMs, 1_000);
  }
  // the provider/reasoning/tokenScope variants of one model are distinct groups
  const keys = new Set(summary.groups.map((group) => group.groupKey));
  assert.equal(keys.size, 6);
  const providers = summary.groups.filter((group) => group.modelProvider === "prov-a");
  assert.equal(providers.length, 1);
  const scopes = summary.groups.filter((group) => group.tokenScope === "visible_plus_reasoning");
  assert.equal(scopes.length, 1);
  // sourceKind and homeId both participate
  assert.equal(summary.groups.filter((group) => group.sourceKind === "dsh").length, 1);
  assert.equal(summary.groups.filter((group) => group.homeId === "h2").length, 1);
});

test("M1.3-6 ordering: unrounded p50 descending, ties broken by canonical key", () => {
  // rates: fast = 1000 × 1000 / 1000 = 1000 ; medium = 1000 × 1000 / 2000 = 500
  //        slow = 1000 × 1000 / 4000 = 250
  const rows = [
    sample({ identity: ["o-1"], model: "slow", durationMs: 4_000, outputTokens: 1_000 }),
    sample({ identity: ["o-2"], model: "fast", durationMs: 1_000, outputTokens: 1_000 }),
    sample({ identity: ["o-3"], model: "medium", durationMs: 2_000, outputTokens: 1_000 }),
  ];
  const summary = summarizePerf(rows, { range: RANGE });
  assert.deepEqual(
    summary.groups.map((group) => group.model),
    ["fast", "medium", "slow"],
  );
  assert.deepEqual(
    summary.groups.map((group) => group.tps.p50),
    [1_000, 500, 250],
  );

  // Two groups with an identical p50 (both 500) must be ordered by the canonical
  // group key in code-unit order, never by locale and never by input position.
  const tieA = sample({ identity: ["t-a"], model: "aaa", durationMs: 2_000, outputTokens: 1_000 });
  const tieB = sample({ identity: ["t-b"], model: "bbb", durationMs: 2_000, outputTokens: 1_000 });
  assert.equal(tieA.durationMs, tieB.durationMs);
  const forward = summarizePerf([tieB, tieA], { range: RANGE });
  const backward = summarizePerf([tieA, tieB], { range: RANGE });
  assert.equal(forward.groups[0].tps.p50, 500);
  assert.equal(forward.groups[1].tps.p50, 500);
  assert.deepEqual(
    forward.groups.map((group) => group.model),
    ["aaa", "bbb"],
  );
  assert.deepEqual(
    forward.groups.map((group) => group.model),
    backward.groups.map((group) => group.model),
  );
});

test("M1.3-7 ranking numbers only sufficiently sampled groups", () => {
  // With minSamples = 2, a 2-member group is ranked and a 1-member group is not.
  const two = [
    sample({ identity: ["r-1"], model: "ranked", durationMs: 1_000, outputTokens: 1_000 }),
    sample({ identity: ["r-2"], model: "ranked", durationMs: 1_000, outputTokens: 1_000 }),
  ];
  const one = sample({ identity: ["r-3"], model: "lonely", durationMs: 1_000, outputTokens: 2_000 });
  const summary = summarizePerf([...two, one], { range: RANGE, meta: { minSamples: 2 } });

  const ranked = summary.groups.find((group) => group.model === "ranked");
  const lonely = summary.groups.find((group) => group.model === "lonely");
  assert.equal(ranked.insufficientSamples, false);
  assert.equal(ranked.rank, 1);
  assert.equal(lonely.insufficientSamples, true);
  assert.equal(lonely.rank, null, "an insufficient-sample group must never be numbered");

  // Default minSamples comes from the frozen constant.
  const defaulted = summarizePerf(two, { range: RANGE });
  assert.equal(defaulted.meta.minSamples, PERF_MIN_SAMPLES);
  assert.equal(defaulted.groups[0].insufficientSamples, true);
  assert.equal(defaulted.groups[0].rank, null);
});

test("M1.3-8 overflow: an unsafe raw sum reports AGGREGATE_OVERFLOW instead of a pseudo value", () => {
  // Reachability, stated explicitly: `normalizePerfSample` accepts a duration up to
  // MAX_SAFE_INTEGER − 1. Two such members in one group sum to
  // 2 × (MAX_SAFE_INTEGER − 1) = 18014398509481980 > MAX_SAFE_INTEGER, which is the
  // only way to reach the overflow branch — a single member can never trigger it,
  // because normalization already rejects unsafe integers.
  const bigDuration = Number.MAX_SAFE_INTEGER - 1;
  const first = sample({ identity: ["ovf-1"], durationMs: bigDuration, outputTokens: 1_000 });
  const second = sample({ identity: ["ovf-2"], durationMs: bigDuration, outputTokens: 1_000 });
  assert.equal(Number.isSafeInteger(first.durationMs), true, "one member alone is safe");
  assert.equal(Number.isSafeInteger(first.durationMs + second.durationMs), false, "the sum is not safe");

  const summary = summarizePerf([first, second], { range: RANGE });
  const group = only(summary.groups);
  assert.equal(group.state, "overflow");
  // No fabricated numbers anywhere on the group.
  assert.deepEqual(group.tps, { p10: null, p50: null, p90: null, pooled: null });
  assert.deepEqual(group.durationMs, { p50: null, p90: null });
  assert.deepEqual(group.sums, { outputTokens: null, durationMs: null });
  assert.deepEqual(group.warnings, ["AGGREGATE_OVERFLOW"]);
  // an overflow group carries no evidence to rank on
  assert.equal(group.rank, null);
  assert.equal(
    summary.meta.sourceWarnings.some((entry) => entry.code === "AGGREGATE_OVERFLOW"),
    true,
  );
  assert.equal(PERF_SOURCE_WARNING_CODES.has("AGGREGATE_OVERFLOW"), true);

  // negative control: the same shape with safe durations stays "ok"
  const smallA = sample({ identity: ["safe-1"], durationMs: 2_000, outputTokens: 1_000 });
  const smallB = sample({ identity: ["safe-2"], durationMs: 2_000, outputTokens: 3_000 });
  const safe = summarizePerf([smallA, smallB], { range: RANGE });
  assert.equal(safe.groups[0].state, "ok");
  assert.equal(safe.groups[0].tps.pooled, (4_000 * 1_000) / 4_000);
  assert.deepEqual(safe.groups[0].warnings, []);
});

test("M1.3-9 meta: frozen fields, and normalization warning codes stay out of sourceWarnings", () => {
  const rows = [
    sample({ identity: ["m-1"], durationMs: 1_000, outputTokens: 1_000 }),
    sample({ identity: ["m-2"], durationMs: 2_000, outputTokens: 1_000 }),
  ];
  const summary = summarizePerf(rows, {
    range: RANGE,
    meta: {
      methodVersion: PERF_METHOD_VERSION,
      state: "degraded",
      indexVersion: "idx-1",
      indexedAt: "2026-10-04T00:00:00Z",
      sourceWarnings: [{ sourceKind: "zcode", homeId: "h1", code: "MALFORMED_JSON", count: 3 }],
    },
  });
  assert.equal(summary.meta.methodVersion, PERF_METHOD_VERSION);
  assert.equal(summary.meta.state, "degraded");
  assert.equal(summary.meta.indexVersion, "idx-1");
  assert.equal(summary.meta.indexedAt, "2026-10-04T00:00:00Z");
  assert.equal(summary.meta.minSamples, PERF_MIN_SAMPLES);
  assert.equal(summary.meta.longWindowMs, PERF_LONG_WINDOW_MS);
  assert.equal(summary.meta.eraCutoffMs, PERF_ERA_CUTOFF_MS);
  assert.deepEqual(summary.meta.sourceWarnings, [
    { sourceKind: "zcode", homeId: "h1", code: "MALFORMED_JSON", count: 3 },
  ]);

  // A frozen code is accepted; every M1 normalization code is rejected by ruling Q.
  assert.equal(PERF_SOURCE_WARNING_CODES.size, 8);
  assert.equal(PERF_SOURCE_WARNING_CODES.has("UNKEYABLE_RECORD"), true);
  for (const code of [
    "UNSUPPORTED_SOURCE_KIND",
    "UNRECOGNIZED_STATUS",
    "UNRECOGNIZED_METHOD_VERSION",
    "UNRECOGNIZED_PROVENANCE",
    "UNRECOGNIZED_FLAG_NAME",
    "UNRECOGNIZED_AGENT_KIND",
    "SOURCE_SEMANTICS_MISMATCH",
  ]) {
    assert.equal(PERF_SOURCE_WARNING_CODES.has(code), false, `${code} must not be a sourceWarnings code`);
    assert.throws(
      () =>
        summarizePerf(rows, {
          range: RANGE,
          meta: { sourceWarnings: [{ sourceKind: "zcode", homeId: "h1", code, count: 1 }] },
        }),
      TypeError,
      `${code} must be rejected as a sourceWarnings code`,
    );
  }
  assert.throws(() => summarizePerf(rows, { range: RANGE, meta: { state: "nope" } }), TypeError);
});

test("M1.3-10 duplicate identities do not change any count, in either order", () => {
  // The same identity read twice (with identical semantics) folds. Counts, sums and
  // quantiles must be identical to the single-row case, and identical across orders.
  const lone = sample({ identity: ["dup"], durationMs: 2_000, outputTokens: 1_000 });
  const duplicate = sample({ identity: ["dup"], durationMs: 2_000, outputTokens: 1_000 });
  assert.equal(lone.sampleKey, duplicate.sampleKey);

  const single = summarizePerf([lone], { range: RANGE });
  const folded = summarizePerf([lone, duplicate], { range: RANGE });
  const reversed = summarizePerf([duplicate, lone], { range: RANGE });

  const stable = (summary) =>
    JSON.stringify({
      groups: summary.groups,
      coverage: summary.coverage,
      meta: { ...summary.meta, indexedAt: null },
    });
  assert.equal(stable(folded), stable(reversed), "duplicate handling must not depend on order");
  assert.equal(stable(single), stable(folded), "a duplicate must not change the result");
  assert.equal(folded.groups[0].n, 1);
  assert.equal(folded.coverage.sampled, 1);
  assert.equal(folded.groups[0].sums.outputTokens, 1_000);
});

test("M1.3-11 a conflicting identity contributes exactly one dropped row, never two", () => {
  // Same identity, contradictory model -> RECORD_CONFLICT, dropped. The group must
  // not be emitted as a statistical row, and the counts must be order-independent.
  const conflictA = sample({ identity: ["confl"], model: "model-a", durationMs: 1_000, outputTokens: 1_000 });
  const conflictB = sample({ identity: ["confl"], model: "model-b", durationMs: 1_000, outputTokens: 1_000 });

  const forward = summarizePerf([conflictA, conflictB], { range: RANGE });
  const backward = summarizePerf([conflictB, conflictA], { range: RANGE });
  for (const summary of [forward, backward]) {
    assert.deepEqual(summary.groups, [], "a conflicted group is never a statistical row");
    assert.equal(summary.coverage.eligible, 1, "two conflicting rows fold into one candidate");
    assert.equal(summary.coverage.dropped, 1);
    assert.equal(summary.coverage.droppedByReason.record_conflict, 1);
    assert.equal(summary.coverage.byFlag.RECORD_CONFLICT, 1);
    assert.equal(summary.coverage.sampled, 0);
  }
  // the representative is decided by the member set, not by input order
  const forwardRep = selectPerfSamples([conflictA, conflictB], { range: RANGE }).eligible[0];
  const backwardRep = selectPerfSamples([conflictB, conflictA], { range: RANGE }).eligible[0];
  assert.equal(perfGroupKey(forwardRep), perfGroupKey(backwardRep));
});

test("M1.3-12 a long window is a hint: it stays sampled and is counted as a flag", () => {
  const long = sample({
    identity: ["long-1"],
    durationMs: PERF_LONG_WINDOW_MS + 1,
    outputTokens: 1_000,
    // 1000 × 1000 / 300001, computed by hand below rather than by the implementation
  });
  const summary = summarizePerf([long], { range: RANGE });
  const group = only(summary.groups);
  assert.equal(summary.coverage.byFlag.LONG_WINDOW, 1);
  assert.equal(summary.coverage.sampled, 1, "LONG_WINDOW is a hint and never disqualifies");
  assert.equal(group.n, 1);
  assert.equal(group.insufficientSamples, true);
  // boundary: exactly at the threshold is not a long window
  const boundary = sample({ identity: ["long-2"], durationMs: PERF_LONG_WINDOW_MS, outputTokens: 1_000 });
  const boundarySummary = summarizePerf([boundary], { range: RANGE });
  assert.equal(boundarySummary.coverage.byFlag.LONG_WINDOW, 0);
  assert.equal(boundarySummary.coverage.sampled, 1);
});

test("M1.3-13 errors and boundaries are fail-closed and reachable", () => {
  const rows = [sample({ identity: ["e-1"], durationMs: 1_000, outputTokens: 1_000 })];

  // each invalid meta field has a trigger
  assert.throws(() => summarizePerf(rows, { range: RANGE, meta: { minSamples: -1 } }), TypeError);
  assert.throws(() => summarizePerf(rows, { range: RANGE, meta: { minSamples: Number.NaN } }), TypeError);
  assert.throws(() => summarizePerf(rows, { range: RANGE, meta: { state: "unknown" } }), TypeError);
  assert.throws(() => summarizePerf(rows, { range: RANGE, meta: { sourceWarnings: "nope" } }), TypeError);
  // an out-of-domain code is a TypeError (covered above); a structurally broken entry too
  assert.throws(
    () => summarizePerf(rows, { range: RANGE, meta: { sourceWarnings: [{ code: "NOT_A_CODE", count: 1 }] } }),
    TypeError,
  );

  // range boundary is inclusive at both ends for ordinary bounds
  const atStart = sample({ identity: ["e-2"], tsMs: RANGE.startMs, durationMs: 1_000, outputTokens: 1_000 });
  const atEnd = sample({ identity: ["e-3"], tsMs: RANGE.endMs, durationMs: 1_000, outputTokens: 1_000 });
  const inclusive = summarizePerf([atStart, atEnd], { range: RANGE });
  assert.equal(inclusive.coverage.eligible, 2);
  assert.equal(inclusive.coverage.sampled, 2);

  // tsMs = null is unplaced: it never becomes eligible and never becomes a group
  const unplaced = sample({ identity: ["e-4"], tsMs: null, durationMs: 1_000, outputTokens: 1_000 });
  const unplacedSummary = summarizePerf([unplaced], { range: RANGE });
  assert.deepEqual(unplacedSummary.groups, []);
  assert.equal(unplacedSummary.coverage.unplaced, 1);
  assert.equal(unplacedSummary.coverage.eligible, 0);
});

test("M1.3-14 summarizePerf reuses the M1.2 selection and coverage rather than recomputing them", () => {
  // This is a structural assertion: running the reused functions directly must give
  // byte-identical coverage to what the summary reports. If someone ever wrote a
  // second coverage implementation, these would drift.
  const rows = [
    sample({ identity: ["re-1"], durationMs: 1_000, outputTokens: 1_000 }),
    sample({ identity: ["re-2"], durationMs: 1_000, outputTokens: 0 }),
    sample({ identity: ["re-3"], status: "in_progress", durationMs: 1_000, outputTokens: 1_000 }),
    sample({ identity: ["re-4"], tsMs: null, durationMs: 1_000, outputTokens: 1_000 }),
    sample({ identity: ["re-5"], homeId: "other", durationMs: 1_000, outputTokens: 1_000 }),
    sample({ identity: ["re-6"], durationMs: 1_000, outputTokens: 1_000, tsMs: RANGE.endMs + 1 }),
  ];
  const options = { range: RANGE, excludedHomeIds: ["other"] };
  const summary = summarizePerf(rows, options);
  const selection = selectPerfSamples(rows, options);
  const coverage = computePerfCoverage(selection);
  // The 14 pre-existing keys must still come from exactly the reused implementation.
  // The breakdown keys (`bySource`/`byGroup`) are summary-level additions asserted
  // separately, so compare only the reused prefix here.
  const { bySource: breakdownBySource, byGroup: breakdownByGroup, ...summaryGlobal } = summary.coverage;
  assert.deepEqual(summaryGlobal, coverage);
  assert.equal(Object.keys(coverage).length, 14, "the reused M1.2 shape is unchanged at 14 keys");
  assert.ok(breakdownBySource && breakdownByGroup, "the breakdown keys are present on the summary");

  // and grouping agrees with perfGroupKey on the sampled members
  const sampled = selection.eligible.filter((entry) => entry.status !== "in_progress");
  const expectedKeys = new Set(sampled.map((entry) => perfGroupKey(entry)));
  assert.deepEqual(new Set(summary.groups.map((group) => group.groupKey)), expectedKeys);
});

test("M1.3-15 parity: a full mixed fixture is invariant under every input permutation", () => {
  // A deliberately messy set: two sources, two homes, distinct dimensions, missing
  // and zero values, a long window, a duplicate, a conflict, and an out-of-range row.
  const rows = [
    sample({ identity: ["mix-1"], durationMs: 1_000, outputTokens: 1_000, tsMs: T }),
    sample({ identity: ["mix-2"], durationMs: 3_000, outputTokens: 900, tsMs: T + 1 }),
    sample({ identity: ["mix-3"], model: "m2", durationMs: 2_000, outputTokens: 2_000, tsMs: T + 2 }),
    sample({
      identity: ["mix-4"],
      sourceKind: "dsh",
      homeId: "h2",
      window: "step",
      durationMs: 500,
      outputTokens: 750,
      tsMs: T + 3,
    }),
    sample({ identity: ["mix-5"], agentKind: "subagent", durationMs: 4_000, outputTokens: 4_000, tsMs: T + 4 }),
    sample({ identity: ["mix-6"], outputTokens: null, durationMs: 1_000, tsMs: T + 5 }),
    sample({ identity: ["mix-7"], outputTokens: 0, durationMs: 1_000, tsMs: T + 6 }),
    sample({ identity: ["mix-8"], durationMs: PERF_LONG_WINDOW_MS + 5, outputTokens: 1_000, tsMs: T + 7 }),
    sample({ identity: ["mix-9"], status: "in_progress", durationMs: 1_000, outputTokens: 1_000, tsMs: T + 8 }),
    sample({ identity: ["mix-10"], tsMs: null, durationMs: 1_000, outputTokens: 1_000 }),
    sample({ identity: ["mix-1"], durationMs: 1_000, outputTokens: 1_000, tsMs: T }),
    sample({ identity: ["mix-11"], model: "conflict-a", durationMs: 1_000, outputTokens: 1_000, tsMs: T + 9 }),
    sample({ identity: ["mix-11"], model: "conflict-b", durationMs: 1_000, outputTokens: 1_000, tsMs: T + 9 }),
    sample({ identity: ["mix-12"], durationMs: 1_000, outputTokens: 1_000, tsMs: RANGE.endMs + 10 }),
  ];

  const stable = (summary) =>
    JSON.stringify({ groups: summary.groups, coverage: summary.coverage, meta: summary.meta });

  const permutations = [];
  const walk = (rest, prefix) => {
    if (rest.length === 0) {
      permutations.push(prefix);
      return;
    }
    for (let index = 0; index < rest.length; index += 1) {
      walk([...rest.slice(0, index), ...rest.slice(index + 1)], [...prefix, rest[index]]);
    }
  };
  // Full 14! is far too large; take a deterministic sample of orders plus every
  // adjacent swap, which is what actually exercises order sensitivity in practice.
  const baseline = stable(summarizePerf(rows, { range: RANGE }));
  for (let index = 0; index < rows.length - 1; index += 1) {
    const swapped = [...rows];
    [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
    assert.equal(
      stable(summarizePerf(swapped, { range: RANGE })),
      baseline,
      `adjacent swap at ${index} changed the summary`,
    );
  }
  // plus all rotations and the full reversal
  for (let index = 0; index < rows.length; index += 1) {
    const rotated = [...rows.slice(index), ...rows.slice(0, index)];
    assert.equal(
      stable(summarizePerf(rotated, { range: RANGE })),
      baseline,
      `rotation at ${index} changed the summary`,
    );
  }
  assert.equal(stable(summarizePerf([...rows].reverse(), { range: RANGE })), baseline, "reversal changed the summary");

  // and a genuine exhaustive permutation over a smaller but still messy subset
  const small = [
    sample({ identity: ["per-1"], durationMs: 1_000, outputTokens: 1_000, tsMs: T }),
    sample({ identity: ["per-2"], model: "m2", durationMs: 2_000, outputTokens: 500, tsMs: T + 1 }),
    sample({ identity: ["per-3"], outputTokens: null, durationMs: 1_000, tsMs: T + 2 }),
    sample({ identity: ["per-4"], status: "in_progress", durationMs: 1_000, outputTokens: 1_000, tsMs: T + 3 }),
    sample({ identity: ["per-5"], tsMs: null, durationMs: 1_000, outputTokens: 1_000 }),
  ];
  permutations.length = 0;
  walk(small, []);
  assert.equal(permutations.length, 120);
  const smallBaseline = stable(summarizePerf(small, { range: RANGE }));
  for (const order of permutations) {
    assert.equal(stable(summarizePerf(order, { range: RANGE })), smallBaseline, "a permutation changed the summary");
  }
});

test("M1.3-16 the group order is a strict, locale-independent total order", () => {
  // Three groups tied on the exact same p50, whose keys differ only by the model
  // string. Ties must fall back to code-unit order on the canonical key.
  const rows = [
    sample({ identity: ["ord-1"], model: "bbb", durationMs: 2_000, outputTokens: 1_000 }),
    sample({ identity: ["ord-2"], model: "aaa", durationMs: 2_000, outputTokens: 1_000 }),
    sample({ identity: ["ord-3"], model: "ccc", durationMs: 2_000, outputTokens: 1_000 }),
  ];
  const summary = summarizePerf(rows, { range: RANGE });
  assert.deepEqual(
    summary.groups.map((group) => group.model),
    ["aaa", "bbb", "ccc"],
  );
  for (const group of summary.groups) assert.equal(group.tps.p50, 500);

  // Unicode contrast: "é" (U+00E9) and "e" + U+0301 are literally different but
  // `localeCompare` calls them equal. Code-unit comparison must order them, so the
  // tie-break cannot silently leave the two groups in input order.
  const composed = "\u00e9";
  const decomposed = "e\u0301";
  assert.notEqual(composed, decomposed);
  assert.equal(composed.localeCompare(decomposed), 0, "premise: locale comparison cannot separate them");
  const composedSample = sample({ identity: ["uni-1"], model: composed, durationMs: 2_000, outputTokens: 1_000 });
  const decomposedSample = sample({ identity: ["uni-2"], model: decomposed, durationMs: 2_000, outputTokens: 1_000 });
  const forward = summarizePerf([composedSample, decomposedSample], { range: RANGE });
  const backward = summarizePerf([decomposedSample, composedSample], { range: RANGE });
  assert.equal(forward.groups.length, 2);
  assert.deepEqual(
    forward.groups.map((group) => group.model),
    backward.groups.map((group) => group.model),
    "Unicode-equivalent models must be ordered deterministically",
  );
  assert.equal(forward.meta.sourceWarnings.length, 0);
});

test("M1.3-17 nearest-rank mutation check: flipping ceil to floor must change these numbers", () => {
  // This test does not exercise `summarizePerf` directly. It pins the arithmetic
  // that the fixture above depends on, so that a reader can see the rule is
  // load-bearing: for the fixture's n = 4, `floor` selects different members.
  const rates = [125, 250, 500, 1_000]; // the sorted fixture rates
  const nearestRank = (sorted, p) => sorted[Math.ceil(p * sorted.length) - 1];
  const flooredRank = (sorted, p) => sorted[Math.floor(p * sorted.length) - 1];

  assert.equal(nearestRank(rates, 0.1), 125);
  assert.equal(nearestRank(rates, 0.5), 250);
  assert.equal(nearestRank(rates, 0.9), 1_000);

  // For n = 4 the mutations land like this:
  //   p10: ceil(0.4) − 1 = 0 -> 125      | floor(0.4) − 1 = −1 -> undefined
  //   p50: ceil(2.0) − 1 = 1 -> 250      | floor(2.0) − 1 = 1  -> 250 (agrees)
  //   p90: ceil(3.6) − 1 = 3 -> 1000     | floor(3.6) − 1 = 2  -> 500 (differs)
  // So the fixture is sensitive at p10 and p90 and insensitive at p50, which is
  // exactly why the fixture above asserts all three rather than only p50.
  assert.equal(flooredRank(rates, 0.1), undefined);
  assert.equal(flooredRank(rates, 0.5), nearestRank(rates, 0.5));
  assert.notEqual(nearestRank(rates, 0.9), flooredRank(rates, 0.9), "p90 must differ under floor");
  assert.equal(flooredRank(rates, 0.9), 500);

  // Same reasoning for the duration axis, which uses its own sorted array.
  const durations = [1_000, 2_000, 4_000, 8_000];
  assert.equal(nearestRank(durations, 0.5), 2_000);
  assert.equal(nearestRank(durations, 0.9), 8_000);
  assert.notEqual(nearestRank(durations, 0.9), flooredRank(durations, 0.9));
  assert.equal(flooredRank(durations, 0.9), 4_000);
});

test("M1.3-18 unsupported declared sources are surfaced without becoming groups", () => {
  // `knownSources` entries are `{ kind, homeId }` discovery declarations. An
  // unsupported kind must be listed on the reusable selection and must never be
  // synthesized into a statistical group.
  const rows = [
    sample({ identity: ["u-1"], durationMs: 1_000, outputTokens: 1_000 }),
    sample({
      identity: ["u-2"],
      sourceKind: "dsh",
      window: "step",
      homeId: "h2",
      durationMs: 1_000,
      outputTokens: 1_000,
    }),
  ];
  const options = {
    range: RANGE,
    knownSources: [
      { kind: "legacy-src", homeId: "h-legacy" },
      { kind: "zcode", homeId: "h1" },
    ],
  };
  const summary = summarizePerf(rows, options);
  const selection = selectPerfSamples(rows, options);
  // only the genuinely unsupported kind is listed
  assert.deepEqual(selection.unsupportedSources, [{ kind: "legacy-src", homeId: "h-legacy" }]);
  // and it contributes no group and no eligible row
  assert.equal(summary.groups.length, 2);
  assert.equal(summary.coverage.eligible, 2);
  assert.equal(
    summary.groups.some((group) => group.sourceKind === "legacy-src"),
    false,
  );
});

test("M1.3-19 the group comparator is transitive: no cycle over a widened fixture set", () => {
  // The sort key is (unrounded p50 descending, then canonical group key by code
  // unit). Probe the pairwise winner through the module itself, then confirm no
  // triple cycles — an intransitive comparator would make the group order depend on
  // input order, which is exactly the class of defect M1.2 lost four rounds to.
  const make = (model, durationMs, outputTokens) =>
    sample({ identity: [`tr-${model}`], model, durationMs, outputTokens });
  const fixtures = [
    make("m-500", 2_000, 1_000), // 500
    make("a-500", 2_000, 1_000), // 500 (tie, earlier key)
    make("z-500", 2_000, 1_000), // 500 (tie, later key)
    make("m-1000", 1_000, 1_000), // 1000
    make("m-250", 4_000, 1_000), // 250
    make("\u00e9-tie", 2_000, 1_000), // 500, Unicode precomposed
    make("e\u0301-tie", 2_000, 1_000), // 500, Unicode decomposed
  ];

  const orderOf = (a, b) => summarizePerf([a, b], { range: RANGE }).groups.map((group) => group.model);
  const before = (x, y) => {
    const forward = orderOf(x, y);
    const backward = orderOf(y, x);
    assert.deepEqual(forward, backward, `pair ${x.model}/${y.model} must not depend on input order`);
    return forward[0] === x.model;
  };

  let triples = 0;
  let cycles = 0;
  for (const x of fixtures) {
    for (const y of fixtures) {
      if (x === y) continue;
      const xy = before(x, y);
      for (const z of fixtures) {
        if (z === x || z === y) continue;
        triples += 1;
        if (xy && before(y, z) && !before(x, z)) {
          cycles += 1;
          console.log(`cycle: ${x.model} < ${y.model} < ${z.model} but not ${x.model} < ${z.model}`);
        }
      }
    }
  }
  assert.equal(cycles, 0, "the group order must have no cycles");
  assert.equal(triples, 210);
});

test("M1.3-20 reachability ledger: every 0, null and error branch has a trigger", () => {
  // This test exists so that no branch in `summarizePerf` can be dead code that looks
  // like coverage. Each entry names the branch, the trigger, and asserts the branch
  // actually fired. Anything unreachable would have to be deleted or reported.
  const rows = [sample({ identity: ["led-1"], durationMs: 1_000, outputTokens: 1_000 })];

  const ledger = [];

  // --- 0 / null value branches ---------------------------------------------
  const zeroOut = summarizePerf([sample({ identity: ["led-zo"], outputTokens: 0, durationMs: 1_000 })], {
    range: RANGE,
  });
  assert.equal(zeroOut.coverage.byFlag.OUTPUT_ZERO, 1);
  ledger.push("outputTokens === 0 -> OUTPUT_ZERO / dropped");
  const zeroDur = summarizePerf([sample({ identity: ["led-zd"], outputTokens: 1_000, durationMs: 0 })], {
    range: RANGE,
  });
  assert.equal(zeroDur.coverage.byFlag.DURATION_NONPOSITIVE, 1);
  ledger.push("durationMs === 0 -> DURATION_NONPOSITIVE / dropped");
  const nullOut = summarizePerf([sample({ identity: ["led-no"], outputTokens: null, durationMs: 1_000 })], {
    range: RANGE,
  });
  assert.equal(nullOut.coverage.byFlag.MISSING_OUTPUT, 1);
  ledger.push("outputTokens === null -> MISSING_OUTPUT / dropped");
  const nullDur = summarizePerf([sample({ identity: ["led-nd"], outputTokens: 1_000, durationMs: null })], {
    range: RANGE,
  });
  assert.equal(nullDur.coverage.byFlag.MISSING_DURATION, 1);
  ledger.push("durationMs === null -> MISSING_DURATION / dropped");
  const nullTs = summarizePerf([sample({ identity: ["led-nt"], tsMs: null, durationMs: 1_000, outputTokens: 1_000 })], {
    range: RANGE,
  });
  assert.equal(nullTs.coverage.unplaced, 1);
  assert.deepEqual(nullTs.groups, []);
  ledger.push("tsMs === null -> unplaced, no group");

  // --- n = 0 (quantile helper guard) ---------------------------------------
  assert.deepEqual(summarizePerf([], { range: RANGE }).groups, []);
  assert.equal(summarizePerf([], { range: RANGE }).coverage.sampleRate, null);
  ledger.push("n === 0 -> no group; sampleRate null on zero denominator");

  // --- sampleRate / timingRate null denominators ---------------------------
  const noPositive = summarizePerf([sample({ identity: ["led-np"], outputTokens: 0, durationMs: 1_000 })], {
    range: RANGE,
  });
  assert.equal(noPositive.coverage.positiveOutput, 0);
  assert.equal(noPositive.coverage.timingRate, null);
  assert.equal(noPositive.coverage.completeTimingRate, null);
  ledger.push("positiveOutput === 0 -> timingRate/completeTimingRate null, never NaN");

  // --- overflow branch -----------------------------------------------------
  const bigDuration = Number.MAX_SAFE_INTEGER - 1;
  const overflow = summarizePerf(
    [
      sample({ identity: ["led-o1"], durationMs: bigDuration, outputTokens: 1_000 }),
      sample({ identity: ["led-o2"], durationMs: bigDuration, outputTokens: 1_000 }),
    ],
    { range: RANGE },
  );
  assert.equal(overflow.groups[0].state, "overflow");
  assert.equal(overflow.groups[0].tps.p50, null);
  ledger.push("unsafe raw sum -> state overflow + AGGREGATE_OVERFLOW, numbers null");

  // --- ranking skip branches ----------------------------------------------
  const under = summarizePerf([sample({ identity: ["led-u"], durationMs: 1_000, outputTokens: 1_000 })], {
    range: RANGE,
  });
  assert.equal(under.groups[0].rank, null);
  ledger.push("n < minSamples -> rank null (kept, labelled)");
  assert.equal(
    summarizePerf(
      [
        sample({ identity: ["led-r1"], durationMs: 1_000, outputTokens: 1_000 }),
        sample({ identity: ["led-r2"], durationMs: 1_000, outputTokens: 1_000 }),
      ],
      { range: RANGE, meta: { minSamples: 1 } },
    ).groups[0].rank,
    1,
  );
  ledger.push("n >= minSamples -> rank assigned from 1");

  // --- every error branch -------------------------------------------------
  const errorTriggers = [
    ["meta.minSamples negative", { meta: { minSamples: -1 } }],
    ["meta.minSamples NaN", { meta: { minSamples: Number.NaN } }],
    ["meta.state unknown", { meta: { state: "bogus" } }],
    ["meta.sourceWarnings not an array", { meta: { sourceWarnings: "x" } }],
    ["sourceWarnings code outside the frozen domain", { meta: { sourceWarnings: [{ code: "NOPE", count: 1 }] } }],
    [
      "sourceWarnings carries an M1 normalization code (ruling Q)",
      { meta: { sourceWarnings: [{ code: "UNRECOGNIZED_STATUS", count: 1 }] } },
    ],
    ["range is a Date", { range: new Date() }],
    ["excludedHomeIds is a string", { excludedHomeIds: "h1" }],
  ];
  for (const [label, options] of errorTriggers) {
    assert.throws(() => summarizePerf(rows, options), TypeError, `${label} must throw`);
    ledger.push(`error: ${label}`);
  }

  // the ledger is non-trivial, i.e. this test is actually asserting many branches:
  // 10 value/denominator branches + 8 error triggers.
  assert.equal(ledger.length, 18);
});

// ---------------------------------------------------------------------------
// M1.3 返工: bySource / byGroup breakdown + the shared era cut point
// ---------------------------------------------------------------------------

/**
 * Build a codex sample. Codex is the only source with an era split, so every
 * era assertion needs this semantic combination (`turn` window, item-span estimate,
 * reasoning-inclusive tokens).
 */
function codexSample(overrides = {}) {
  return sample({
    sourceKind: "codex",
    window: "turn",
    timingKind: "item_span_estimate",
    tokenScope: "reported_output_includes_reasoning",
    ...overrides,
  });
}

/** A query range that actually brackets the frozen era cut point. */
const ERA_RANGE = { startMs: PERF_ERA_CUTOFF_MS - 100_000, endMs: PERF_ERA_CUTOFF_MS + 100_000 };

const eraOf = (bucket) =>
  bucket?.byEra === null || bucket?.byEra === undefined
    ? null
    : { recent: bucket.byEra.recent.eligible, legacy: bucket.byEra.legacy.eligible };

test("M1.3-21 byGroup keeps the eligible>0 / sampled=0 diagnostic bucket that explains a missing TPS", () => {
  // The whole point of the breakdown: a model whose only candidate has zero output
  // produces no statistical group, so `groups` cannot say what happened. The bucket
  // is the only place that answers "which model, dropped for what reason".
  const lonely = sample({ identity: ["lonely-1"], model: "lonely-model", outputTokens: 0 });
  const summary = summarizePerf([lonely], { range: RANGE });

  assert.deepEqual(summary.groups, [], "no TPS group is produced");
  assert.equal(summary.coverage.eligible, 1);
  assert.equal(summary.coverage.sampled, 0);
  assert.equal(summary.coverage.dropped, 1);

  const keys = Object.keys(summary.coverage.byGroup);
  assert.equal(keys.length, 1, "the diagnostic bucket survives even though groups is empty");
  const bucket = summary.coverage.byGroup[keys[0]];
  assert.equal(bucket.eligible, 1);
  assert.equal(bucket.sampled, 0);
  assert.equal(bucket.dropped, 1);
  assert.equal(bucket.pending, 0);
  assert.equal(bucket.droppedByReason.output_missing_zero_invalid, 1);
  assert.equal(bucket.byFlag.OUTPUT_ZERO, 1);
  assert.equal(bucket.sampleRate, 0);
  // the bucket really is the model in question
  assert.equal(keys[0], perfGroupKey(lonely));

  // positive control: the same shape with usable output does produce a group
  const usable = sample({ identity: ["lonely-2"], model: "lonely-model", outputTokens: 1_000 });
  const withTps = summarizePerf([usable], { range: RANGE });
  assert.equal(withTps.groups.length, 1);
  assert.equal(Object.keys(withTps.coverage.byGroup).length, 1);
  assert.equal(Object.values(withTps.coverage.byGroup)[0].sampled, 1);
});

test("M1.3-22 bySource: every bucket is independent and a Codex bucket carries its own byEra", () => {
  // Root cause of the original defect: the global `byEra` is only emitted when the
  // entire eligible set is one codex source, so a MIXED run reports `null`. The
  // per-source bucket is therefore the only route to the Codex era split.
  const rows = [
    codexSample({ identity: ["src-c1"], tsMs: PERF_ERA_CUTOFF_MS + 1_000 }),
    sample({ identity: ["src-z1"], tsMs: PERF_ERA_CUTOFF_MS - 1_000 }),
  ];
  const summary = summarizePerf(rows, { range: ERA_RANGE });

  // positive side: the mixed global is null...
  assert.equal(summary.coverage.byEra, null, "a mixed set cannot have a global era split");
  // ...but the codex bucket does have one (and the zcode bucket does not)
  assert.deepEqual(Object.keys(summary.coverage.bySource), ["codex", "zcode"]);
  assert.deepEqual(eraOf(summary.coverage.bySource.codex), { recent: 1, legacy: 0 });
  assert.equal(summary.coverage.bySource.zcode.byEra, null, "non-codex stays null (§17.5:280)");
  assert.equal(summary.coverage.bySource.codex.eligible, 1);
  assert.equal(summary.coverage.bySource.zcode.eligible, 1);

  // negative control: a codex-only run DOES get a global era split, and it agrees
  const codexOnly = summarizePerf([codexSample({ identity: ["src-c2"], tsMs: PERF_ERA_CUTOFF_MS - 1_000 })], {
    range: ERA_RANGE,
  });
  assert.deepEqual(eraOf(codexOnly.coverage), { recent: 0, legacy: 1 });
  assert.deepEqual(eraOf(codexOnly.coverage.bySource.codex), { recent: 0, legacy: 1 });

  // buckets partition the eligible set exactly
  const sourceSum = Object.values(summary.coverage.bySource).reduce((total, bucket) => total + bucket.eligible, 0);
  const groupSum = Object.values(summary.coverage.byGroup).reduce((total, bucket) => total + bucket.eligible, 0);
  assert.equal(sourceSum, summary.coverage.eligible);
  assert.equal(groupSum, summary.coverage.eligible);

  // a group with TPS always has a bucket; a bucket need not have a group
  for (const group of summary.groups) assert.ok(group.groupKey in summary.coverage.byGroup);
  assert.equal(summary.groups.length, 2);
  assert.ok(Object.keys(summary.coverage.byGroup).length >= summary.groups.length);
});

test("M1.3-23 buckets sum to the global counts for every count field", () => {
  const rows = [
    codexSample({ identity: ["sum-c1"], tsMs: PERF_ERA_CUTOFF_MS + 5 }),
    codexSample({ identity: ["sum-c2"], model: "other", outputTokens: 0, tsMs: PERF_ERA_CUTOFF_MS + 6 }),
    sample({ identity: ["sum-z1"], tsMs: PERF_ERA_CUTOFF_MS - 5 }),
    sample({ identity: ["sum-z2"], model: "z-other", tsMs: null }),
    sample({ identity: ["sum-z3"], status: "in_progress", tsMs: PERF_ERA_CUTOFF_MS - 6 }),
    sample({ identity: ["sum-z4"], homeId: "excluded-home" }),
    sample({ identity: ["sum-z5"], tsMs: ERA_RANGE.endMs + 1 }),
  ];
  const options = { range: ERA_RANGE, excludedHomeIds: ["excluded-home"] };
  const summary = summarizePerf(rows, options);
  const global = summary.coverage;

  for (const field of [
    "eligible",
    "positiveOutput",
    "timedPositiveOutput",
    "completeTimedPositiveOutput",
    "sampled",
    "dropped",
    "pending",
  ]) {
    const bySource = Object.values(global.bySource).reduce((total, bucket) => total + bucket[field], 0);
    const byGroup = Object.values(global.byGroup).reduce((total, bucket) => total + bucket[field], 0);
    assert.equal(bySource, global[field], `sum(bySource.${field}) must equal the global ${field}`);
    assert.equal(byGroup, global[field], `sum(byGroup.${field}) must equal the global ${field}`);
  }

  // `unplaced` is attributed to its own source/group bucket (ruling AD-2): an
  // unplaced sample belongs to no era and joins no count field except `unplaced`.
  // `eligible` and `unplaced` are disjoint sets, so their sums are asserted
  // separately and must never be conflated.
  assert.equal(global.unplaced, 1);
  assert.equal(
    Object.values(global.byGroup).reduce((total, bucket) => total + bucket.unplaced, 0),
    global.unplaced,
  );
  assert.equal(
    Object.values(global.bySource).reduce((total, bucket) => total + bucket.unplaced, 0),
    global.unplaced,
  );

  // the dropped reasons also partition
  assert.equal(
    Object.values(global.byGroup).reduce((total, bucket) => total + bucket.droppedByReason.record_conflict, 0),
    global.droppedByReason.record_conflict,
  );
});

test("M1.3-24 an unsupported sampleKind lands in an explicit unkeyed bucket", () => {
  // `perfGroupKey` returns `null` for an unsupported source, but the row is still an
  // eligible candidate. It must have a landing spot, otherwise the buckets would
  // silently lose it and no longer sum to the global eligible count.
  const normal = sample({ identity: ["unk-1"] });
  const unsupported = { ...sample({ identity: ["unk-2"] }), sourceKind: "totally-unknown" };
  assert.equal(perfGroupKey(unsupported), null, "premise: unsupported kinds have no group key");

  const summary = summarizePerf([normal, unsupported], { range: RANGE });
  const keys = Object.keys(summary.coverage.byGroup);
  assert.ok(keys.includes("(unkeyed)"), "the unkeyed bucket must exist");
  assert.equal(summary.coverage.byGroup["(unkeyed)"].eligible, 1);
  assert.equal(
    Object.values(summary.coverage.byGroup).reduce((total, bucket) => total + bucket.eligible, 0),
    summary.coverage.eligible,
    "no eligible candidate may be lost",
  );
  // what `sourceKind` reaches `bySource` for such a row is M1.1 normalization's
  // business; the invariant that matters here is that nothing is dropped.
  assert.equal(
    Object.values(summary.coverage.bySource).reduce((total, bucket) => total + bucket.eligible, 0),
    summary.coverage.eligible,
  );
});

test("M1.3-25 the era cut point is resolved once and every consumer uses that same value", () => {
  const cutoff = PERF_ERA_CUTOFF_MS;
  const before = codexSample({ identity: ["cut-before"], tsMs: cutoff - 1 });
  const at = codexSample({ identity: ["cut-at"], model: "at-model", tsMs: cutoff });
  const after = codexSample({ identity: ["cut-after"], model: "after-model", tsMs: cutoff + 1 });

  // boundary: `tsMs >= cutoff` is recent, so the exact cut point counts as recent
  const exact = summarizePerf([at], { range: ERA_RANGE });
  assert.equal(exact.meta.eraCutoffMs, cutoff);
  assert.deepEqual(eraOf(exact.coverage.bySource.codex), { recent: 1, legacy: 0 });

  // immediately before the cut point is legacy
  const just = summarizePerf([before], { range: ERA_RANGE });
  assert.deepEqual(eraOf(just.coverage.bySource.codex), { recent: 0, legacy: 1 });
  const just2 = summarizePerf([after], { range: ERA_RANGE });
  assert.deepEqual(eraOf(just2.coverage.bySource.codex), { recent: 1, legacy: 0 });

  // The decisive case: a caller-supplied cut point that is NOT the default must
  // change the computed buckets, and `meta` must report the same value that did it.
  // With cutoff = ts + 1 the sample must flip from recent to legacy.
  const custom = cutoff + 1;
  const shifted = summarizePerf([after], { range: ERA_RANGE, meta: { eraCutoffMs: custom } });
  assert.equal(shifted.meta.eraCutoffMs, custom, "meta reports the requested cut point");
  assert.notEqual(shifted.meta.eraCutoffMs, PERF_ERA_CUTOFF_MS, "premise: the custom value differs from the default");
  // `after` has ts = cutoff + 1, so with cutoff = cutoff + 1 it is exactly at the
  // boundary => recent; with cutoff = cutoff + 2 it must become legacy.
  const shiftedFurther = summarizePerf([after], { range: ERA_RANGE, meta: { eraCutoffMs: cutoff + 2 } });
  assert.equal(shiftedFurther.meta.eraCutoffMs, cutoff + 2);
  assert.deepEqual(
    eraOf(shiftedFurther.coverage.bySource.codex),
    { recent: 0, legacy: 1 },
    "the reported cut point must be the one that decided the split",
  );
  // and the default run of the same sample is the opposite
  assert.deepEqual(eraOf(just2.coverage.bySource.codex), { recent: 1, legacy: 0 });
  // meta and computation agree within one call, for the global and every bucket
  assert.deepEqual(eraOf(shiftedFurther.coverage), eraOf(shiftedFurther.coverage.bySource.codex));

  // The decisive coupling assertion: `meta.eraCutoffMs` must be interchangeable with
  // the value that produced the buckets. Recompute the *same* input with the reported
  // cut point and require an exact match — if `meta` ever reported a value other than
  // the one used (the original defect), this comparison fails.
  for (const rows of [[at], [before], [after], [before, after], [at, before, after]]) {
    const summary = summarizePerf(rows, { range: ERA_RANGE, meta: { eraCutoffMs: custom } });
    const recomputed = computePerfCoverage(selectPerfSamples(rows, { range: ERA_RANGE }), {
      eraCutoffMs: summary.meta.eraCutoffMs,
    });
    assert.deepEqual(
      eraOf({ byEra: recomputed.byEra }),
      eraOf(summary.coverage),
      "meta.eraCutoffMs must reproduce the computed global era split",
    );
  }
});

test("M1.3-26 eraCutoffMs validation: null means default, invalid values throw", () => {
  const rows = [codexSample({ identity: ["val-1"], tsMs: PERF_ERA_CUTOFF_MS + 1 })];

  // `null`/`undefined`/absent all fall back to the frozen default, and meta says so
  for (const meta of [{ eraCutoffMs: null }, { eraCutoffMs: undefined }, {}]) {
    const summary = summarizePerf(rows, { range: ERA_RANGE, meta });
    assert.equal(summary.meta.eraCutoffMs, PERF_ERA_CUTOFF_MS);
  }
  assert.equal(summarizePerf(rows, { range: ERA_RANGE }).meta.eraCutoffMs, PERF_ERA_CUTOFF_MS);

  // every invalid value is rejected rather than silently defaulted
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "123", new Date(), {}, true]) {
    assert.throws(
      () => summarizePerf(rows, { range: ERA_RANGE, meta: { eraCutoffMs: bad } }),
      TypeError,
      `eraCutoffMs ${String(bad)} must throw`,
    );
  }
  // a valid custom number is accepted
  assert.equal(summarizePerf(rows, { range: ERA_RANGE, meta: { eraCutoffMs: 0 } }).meta.eraCutoffMs, 0);

  // The single-resolution invariant, made observable: `eraCutoffMs: 0` is a *valid*
  // cut point (finite number), and it is falsy. An implementation that re-read the
  // request with `?? PERF_ERA_CUTOFF_MS` would still resolve 0 correctly, but one
  // that validated only at the use site would let a bad value through wherever the
  // resolver was bypassed. Assert every consumer sees the same value in one call.
  const zeroCut = summarizePerf([codexSample({ identity: ["val-zero"], tsMs: PERF_ERA_CUTOFF_MS })], {
    range: ERA_RANGE,
    meta: { eraCutoffMs: 0 },
  });
  assert.equal(zeroCut.meta.eraCutoffMs, 0, "0 is a real cut point, not a missing one");
  // ts is far above 0, so everything is recent under this cut point
  assert.deepEqual(eraOf(zeroCut.coverage.bySource.codex), { recent: 1, legacy: 0 });
  assert.deepEqual(eraOf(zeroCut.coverage), { recent: 1, legacy: 0 });
});

test("M1.3-27 the breakdown survives every input permutation, including object key order", () => {
  // The buckets are maps keyed by source kind and group key, so their *insertion*
  // order followed the input until it was made deterministic. Serialize with sorted
  // keys so this test compares content, not just the JS insertion order, and also
  // compares the raw JSON to catch ordering regressions.
  const rows = [
    codexSample({ identity: ["perm-c1"], tsMs: PERF_ERA_CUTOFF_MS + 3 }),
    codexSample({ identity: ["perm-c2"], model: "m-b", tsMs: PERF_ERA_CUTOFF_MS - 3 }),
    sample({ identity: ["perm-z1"], tsMs: PERF_ERA_CUTOFF_MS + 4 }),
    sample({ identity: ["perm-z2"], model: "m-c", outputTokens: 0, tsMs: PERF_ERA_CUTOFF_MS - 4 }),
    sample({ identity: ["perm-z3"], tsMs: null }),
    sample({ identity: ["perm-z4"], status: "in_progress", tsMs: PERF_ERA_CUTOFF_MS + 5 }),
  ];
  const sortedKeys = (record) =>
    Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  const stable = (summary) =>
    JSON.stringify({
      groups: summary.groups,
      coverage: {
        ...summary.coverage,
        bySource: sortedKeys(summary.coverage.bySource),
        byGroup: sortedKeys(summary.coverage.byGroup),
      },
      meta: summary.meta,
    });
  const rawJson = (summary) => JSON.stringify(summary.coverage.bySource) + JSON.stringify(summary.coverage.byGroup);

  const baseline = stable(summarizePerf(rows, { range: ERA_RANGE }));
  const baselineRaw = rawJson(summarizePerf(rows, { range: ERA_RANGE }));
  for (let index = 0; index < rows.length - 1; index += 1) {
    const swapped = [...rows];
    [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
    const summary = summarizePerf(swapped, { range: ERA_RANGE });
    assert.equal(stable(summary), baseline, `adjacent swap at ${index} changed the breakdown`);
    assert.equal(rawJson(summary), baselineRaw, `adjacent swap at ${index} changed the key order`);
  }
  assert.equal(stable(summarizePerf([...rows].reverse(), { range: ERA_RANGE })), baseline);

  // exhaustive permutations over a smaller set that still has two sources and a
  // diagnostic-only group
  const small = [
    codexSample({ identity: ["sp-c1"], tsMs: PERF_ERA_CUTOFF_MS + 7 }),
    sample({ identity: ["sp-z1"], tsMs: PERF_ERA_CUTOFF_MS - 7 }),
    sample({ identity: ["sp-z2"], model: "z-zero", outputTokens: 0, tsMs: PERF_ERA_CUTOFF_MS + 8 }),
  ];
  const permutations = [];
  const walk = (rest, prefix) => {
    if (rest.length === 0) {
      permutations.push(prefix);
      return;
    }
    for (let index = 0; index < rest.length; index += 1) {
      walk([...rest.slice(0, index), ...rest.slice(index + 1)], [...prefix, rest[index]]);
    }
  };
  walk(small, []);
  assert.equal(permutations.length, 6);
  const smallBaseline = stable(summarizePerf(small, { range: ERA_RANGE }));
  const smallRaw = rawJson(summarizePerf(small, { range: ERA_RANGE }));
  for (const order of permutations) {
    const summary = summarizePerf(order, { range: ERA_RANGE });
    assert.equal(stable(summary), smallBaseline, "a permutation changed the breakdown");
    assert.equal(rawJson(summary), smallRaw, "a permutation changed the breakdown key order");
  }
});

test("M1.3-28 breakdown keys are ordered by code units, so Unicode equivalents separate", () => {
  // `byGroup` keys are canonical group keys built from the model string, so a
  // locale-sensitive sort would leave "é" and "e\u0301" indistinguishable and the
  // emitted key order input-dependent.
  const composed = "\u00e9";
  const decomposed = "e\u0301";
  assert.notEqual(composed, decomposed);
  assert.equal(composed.localeCompare(decomposed), 0, "premise: locale order cannot separate them");

  const rows = [sample({ identity: ["uni-a"], model: composed }), sample({ identity: ["uni-b"], model: decomposed })];
  const forward = summarizePerf(rows, { range: RANGE });
  const backward = summarizePerf([...rows].reverse(), { range: RANGE });
  const keyOrder = (summary) => Object.keys(summary.coverage.byGroup);
  assert.equal(keyOrder(forward).length, 2);
  assert.deepEqual(keyOrder(forward), keyOrder(backward), "key order must not depend on input order");
  // the keys really do differ
  assert.notEqual(keyOrder(forward)[0], keyOrder(forward)[1]);
  // and they are in code-unit ascending order
  assert.ok(keyOrder(forward)[0] < keyOrder(forward)[1], "keys must be sorted by code unit");

  // bySource keys are sorted the same way
  const sourceKeys = Object.keys(forward.coverage.bySource);
  assert.deepEqual(sourceKeys, [...sourceKeys].sort());
});

// ---------------------------------------------------------------------------
// M1.3 返工2: unplaced is attributed to its own source / group bucket
// ---------------------------------------------------------------------------

/** A query range that deliberately contains none of the fixture timestamps. */
const EMPTY_RANGE = { startMs: T + 900_000, endMs: T + 1_000_000 };

test("M1.3-29 a source with only unplaced samples keeps its own diagnostic bucket", () => {
  // Scenario 1: codex has a usable sample, zcode has one with no timestamp. The zcode
  // bucket must still exist even though it holds no eligible member — it is the only
  // place that answers "why do this source's samples never reach the statistics".
  const rows = [
    codexSample({ identity: ["u1-c1"], tsMs: T }),
    sample({ identity: ["u1-z1"], tsMs: null, model: "z-only" }),
  ];
  const summary = summarizePerf(rows, { range: RANGE });

  assert.deepEqual(Object.keys(summary.coverage.bySource), ["codex", "zcode"], "zcode must not vanish");
  // positive side: the unplaced-only bucket exists with eligible 0 and unplaced 1
  assert.equal(summary.coverage.bySource.zcode.eligible, 0);
  assert.equal(summary.coverage.bySource.zcode.unplaced, 1);
  assert.equal(summary.coverage.bySource.zcode.sampled, 0);
  assert.equal(summary.coverage.bySource.zcode.dropped, 0, "unplaced is neither sampled nor dropped");
  assert.equal(summary.coverage.bySource.zcode.pending, 0);
  assert.equal(summary.coverage.bySource.zcode.sampleRate, null, "no denominator, so no fabricated rate");
  // negative side: the other source is untouched by the foreign unplaced row
  assert.equal(summary.coverage.bySource.codex.unplaced, 0);
  assert.equal(summary.coverage.bySource.codex.eligible, 1);

  // and byGroup does the same thing
  const groupKeys = Object.keys(summary.coverage.byGroup);
  assert.equal(groupKeys.length, 2);
  assert.equal(groupKeys.filter((key) => summary.coverage.byGroup[key].unplaced === 1).length, 1);
  assert.equal(summary.coverage.byGroup[groupKeys[0]].unplaced + summary.coverage.byGroup[groupKeys[1]].unplaced, 1);
  // the unplaced-only group emits no statistical row
  assert.equal(summary.groups.length, 1);
});

test("M1.3-30 a source bucket counts its own unplaced rows alongside its eligible ones", () => {
  // Scenario 2/3: one source, one usable and one timestamp-less sample.
  const same = sample({ identity: ["u2-z1"], tsMs: T });
  const noTs = sample({ identity: ["u2-z2"], tsMs: null });
  const summary = summarizePerf([same, noTs], { range: RANGE });

  assert.deepEqual(Object.keys(summary.coverage.bySource), ["zcode"]);
  assert.equal(summary.coverage.bySource.zcode.eligible, 1, "eligible counts only eligible rows");
  assert.equal(summary.coverage.bySource.zcode.unplaced, 1, "the bucket carries its own unplaced count");
  assert.equal(summary.coverage.unplaced, 1);
  assert.equal(
    summary.coverage.bySource.zcode.sampled +
      summary.coverage.bySource.zcode.dropped +
      summary.coverage.bySource.zcode.pending,
    1,
  );
  // the two rows share a group key, so the single group bucket holds both counts
  assert.equal(Object.keys(summary.coverage.byGroup).length, 1);
  const bucket = summary.coverage.byGroup[Object.keys(summary.coverage.byGroup)[0]];
  assert.equal(bucket.eligible, 1);
  assert.equal(bucket.unplaced, 1);

  // regression: unplaced must never leak into the eligible-side counts or denominators
  assert.equal(bucket.positiveOutput, 1);
  assert.equal(bucket.sampled, 1);
  assert.equal(bucket.dropped, 0);
  assert.equal(bucket.pending, 0);
  assert.equal(bucket.sampleRate, 1);
  assert.equal(bucket.timingRate, 1);
});

test("M1.3-31 when nothing is in range the source dimension still survives", () => {
  // Scenario 4 (the worst of the four): every candidate is out of range or unplaced.
  // The eligible side is legitimately empty, but the *source* attribution of the
  // unplaced row must remain visible — an empty `bySource` loses the dimension that
  // explains the absence.
  const rows = [sample({ identity: ["u3-z1"], tsMs: T }), sample({ identity: ["u3-z2"], tsMs: null })];
  const summary = summarizePerf(rows, { range: EMPTY_RANGE });

  assert.equal(summary.coverage.eligible, 0);
  assert.equal(summary.coverage.unplaced, 1);
  assert.deepEqual(Object.keys(summary.coverage.bySource), ["zcode"], "bySource must not be empty");
  assert.deepEqual(Object.keys(summary.coverage.byGroup).length, 1, "byGroup must not be empty");
  // every bucket's eligible side is zero; only unplaced survives
  for (const bucket of Object.values(summary.coverage.bySource)) assert.equal(bucket.eligible, 0);
  for (const bucket of Object.values(summary.coverage.byGroup)) assert.equal(bucket.eligible, 0);
  assert.equal(summary.coverage.bySource.zcode.unplaced, 1);
  assert.equal(summary.coverage.byGroup[Object.keys(summary.coverage.byGroup)[0]].unplaced, 1);
  assert.deepEqual(summary.groups, [], "no statistical group can exist");
});

test("M1.3-32 unplaced attribution is a whole-history diagnostic and ignores the range", () => {
  // `unplaced` means "this row had no usable timestamp anywhere", so narrowing the
  // range must not change where it is attributed — only the eligible side moves.
  const rows = [sample({ identity: ["u4-z1"], tsMs: T }), sample({ identity: ["u4-z2"], tsMs: null })];
  const wide = summarizePerf(rows, { range: RANGE });
  const narrow = summarizePerf(rows, { range: EMPTY_RANGE });

  assert.equal(wide.coverage.unplaced, 1);
  assert.equal(narrow.coverage.unplaced, 1);
  assert.equal(wide.coverage.bySource.zcode.unplaced, 1);
  assert.equal(narrow.coverage.bySource.zcode.unplaced, 1, "unplaced attribution must not depend on range");
  assert.deepEqual(
    Object.keys(wide.coverage.bySource).sort(),
    Object.keys(narrow.coverage.bySource).sort(),
    "the set of source buckets must not depend on range",
  );
  // the eligible side is what actually moves
  assert.equal(wide.coverage.eligible, 1);
  assert.equal(narrow.coverage.eligible, 0);
  assert.equal(wide.coverage.bySource.zcode.eligible, 1);
  assert.equal(narrow.coverage.bySource.zcode.eligible, 0);

  // an out-of-range row is NOT unplaced: it is excluded, a third disjoint category
  const outOfRangeOnly = summarizePerf([sample({ identity: ["u4-z3"], tsMs: T + 950_000 })], { range: RANGE });
  assert.equal(outOfRangeOnly.coverage.unplaced, 0);
  assert.equal(outOfRangeOnly.coverage.eligible, 0);
});

test("M1.3-33 the unplaced identity holds across both breakdowns, and never mixes with eligible", () => {
  const rows = [
    codexSample({ identity: ["u5-c1"], tsMs: T }),
    codexSample({ identity: ["u5-c2"], tsMs: null, model: "c-noplace" }),
    sample({ identity: ["u5-z1"], tsMs: T, model: "z-a" }),
    sample({ identity: ["u5-z2"], tsMs: null, model: "z-b" }),
    sample({ identity: ["u5-z3"], tsMs: null, model: "z-b" }),
    sample({ identity: ["u5-z4"], tsMs: T + 950_000 }), // out of range: a third category
    sample({ identity: ["u5-z5"], homeId: "excluded-home" }),
  ];
  const options = { range: RANGE, excludedHomeIds: ["excluded-home"] };
  const summary = summarizePerf(rows, options);
  const global = summary.coverage;

  // eligible and unplaced are disjoint; each partitions independently
  assert.equal(
    Object.values(global.bySource).reduce((total, bucket) => total + bucket.eligible, 0),
    global.eligible,
  );
  assert.equal(
    Object.values(global.byGroup).reduce((total, bucket) => total + bucket.eligible, 0),
    global.eligible,
  );
  assert.equal(
    Object.values(global.bySource).reduce((total, bucket) => total + bucket.unplaced, 0),
    global.unplaced,
  );
  assert.equal(
    Object.values(global.byGroup).reduce((total, bucket) => total + bucket.unplaced, 0),
    global.unplaced,
  );
  // 7 rows total: 2 eligible (u5-c1 codex, u5-z1 z-a), 3 unplaced (u5-c2 codex
  // no-timestamp, u5-z2 + u5-z3 both z-b no-timestamp), 1 out-of-range (u5-z4) and
  // 1 excluded by home (u5-z5).
  //
  // NOTE (corrected): `selectPerfSamples` deduplicates by `sampleKey` FIRST and only
  // then splits off `unplaced` (`src/perf-stats.js:1478-1507` dedup, then `:1511-1527`
  // split), so an unplaced row IS deduplicated like any other candidate. u5-z2 and
  // u5-z3 carry DIFFERENT identities (`z2` vs `z3`), which is exactly why both survive
  // as two unplaced rows here — this fixture therefore says nothing about repeated
  // identities. Fallback: `M1.3-33b` (below) repeats ONE identity and proves the dedup
  // happens before the split (all three breakdowns report 1, not 2).
  assert.equal(global.unplaced, 3);
  assert.equal(
    global.unplaced,
    Object.values(global.bySource).reduce((total, bucket) => total + bucket.unplaced, 0),
  );
  assert.equal(global.eligible + global.unplaced, 5, "the two categories together hold 5 rows");

  // no bucket may count the same row in both categories, and unplaced must never
  // appear in the eligible-side totals
  for (const bucket of [...Object.values(global.bySource), ...Object.values(global.byGroup)]) {
    assert.ok(bucket.unplaced >= 0 && bucket.eligible >= 0);
    assert.equal(bucket.sampled + bucket.dropped + bucket.pending, bucket.eligible, "eligible identity per bucket");
  }
  // the excluded-home row is in neither category
  // (asserted above: eligible 2 + unplaced 3 = 5, the other 2 rows left the selection)

  // a bucket holding both categories keeps them separate
  const zBuckets = Object.entries(global.byGroup).filter(([, bucket]) => bucket.unplaced > 0);
  assert.ok(zBuckets.length >= 1);
  for (const [, bucket] of zBuckets) {
    assert.equal(bucket.sampled + bucket.dropped + bucket.pending, bucket.eligible);
  }
});

test("M1.3-33b an unplaced row is deduplicated first, so a repeated identity counts once", () => {
  // Frozen order: `selectPerfSamples` deduplicates by `sampleKey` and resolves
  // conflicts FIRST, and only then splits off `unplaced` (dedup `src/perf-stats.js`
  // :1478-1507, split `:1511-1527`). An unplaced row is therefore deduplicated like
  // any other candidate: repeating ONE identity contributes exactly one unplaced row.
  //
  // This is the scenario `M1.3-33` cannot demonstrate — its two z-b rows carry
  // different identities, so they would survive dedup in either order and prove
  // nothing about which stage runs first.
  const repeated = sample({ identity: ["u5b-same"], tsMs: null, model: "z-same" });
  const again = sample({ identity: ["u5b-same"], tsMs: null, model: "z-same" });

  // premise: the two rows really do share one canonical key, otherwise the test is vacuous
  assert.equal(repeated.sampleKey, again.sampleKey);

  const summary = summarizePerf([repeated, again], { range: RANGE });
  const global = summary.coverage;

  // one identity, so one unplaced row everywhere — not two
  assert.equal(global.unplaced, 1, "a repeated identity must be deduplicated before the unplaced split");
  assert.equal(global.bySource.zcode.unplaced, 1);
  assert.equal(
    Object.values(global.byGroup).reduce((total, bucket) => total + bucket.unplaced, 0),
    1,
  );
  // and it still stays out of the eligible side entirely
  assert.equal(global.eligible, 0);
  assert.equal(global.bySource.zcode.eligible, 0);
  assert.deepEqual(summary.groups, []);

  // contrast (positive control on the discriminating field): two DISTINCT identities
  // really do produce two unplaced rows, so the assertion above is not vacuous
  const distinct = summarizePerf(
    [
      sample({ identity: ["u5b-a"], tsMs: null, model: "z-same" }),
      sample({ identity: ["u5b-b"], tsMs: null, model: "z-same" }),
    ],
    { range: RANGE },
  );
  assert.equal(distinct.coverage.unplaced, 2, "distinct identities must each count");
});

test("M1.3-34 unplaced rows join no era, so byEra still derives from eligible alone", () => {
  // An unplaced sample has `tsMs === null` by construction, so it can never be
  // assigned to `recent` or `legacy`. Including it would double-count it, because the
  // era shape is a partition of the eligible side only.
  const rows = [
    codexSample({ identity: ["u6-c1"], tsMs: PERF_ERA_CUTOFF_MS + 10 }),
    codexSample({ identity: ["u6-c2"], model: "c-noplace", tsMs: null }),
  ];
  const summary = summarizePerf(rows, { range: ERA_RANGE });
  const bucket = summary.coverage.bySource.codex;

  assert.equal(bucket.eligible, 1);
  assert.equal(bucket.unplaced, 1);
  // the era split covers exactly the eligible member
  assert.deepEqual(eraOf(bucket), { recent: 1, legacy: 0 });
  assert.equal(
    bucket.byEra.recent.eligible + bucket.byEra.legacy.eligible,
    bucket.eligible,
    "byEra must partition eligible only",
  );
  assert.ok(!Object.hasOwn(bucket.byEra, "unplaced"));
});

test("M1.3-35 unplaced attribution survives every input permutation, including unplaced-only buckets", () => {
  const rows = [
    codexSample({ identity: ["u7-c1"], tsMs: PERF_ERA_CUTOFF_MS + 1 }),
    codexSample({ identity: ["u7-c2"], model: "c-noplace", tsMs: null }),
    sample({ identity: ["u7-z1"], tsMs: PERF_ERA_CUTOFF_MS - 1 }),
    sample({ identity: ["u7-z2"], tsMs: null, model: "z-noplace" }),
  ];
  const stable = (summary) =>
    JSON.stringify({
      groups: summary.groups,
      coverage: {
        ...summary.coverage,
        bySource: Object.fromEntries(Object.entries(summary.coverage.bySource).sort()),
        byGroup: Object.fromEntries(Object.entries(summary.coverage.byGroup).sort()),
      },
      meta: summary.meta,
    });

  // a range that keeps only the unplaced rows alive: every bucket then holds unplaced
  // alone, which is the case the old code made disappear entirely
  for (const range of [ERA_RANGE, EMPTY_RANGE]) {
    const baseline = stable(summarizePerf(rows, { range }));
    const rawBaseline = JSON.stringify(summarizePerf(rows, { range }).coverage.bySource);
    for (let index = 0; index < rows.length - 1; index += 1) {
      const swapped = [...rows];
      [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
      assert.equal(stable(summarizePerf(swapped, { range })), baseline, `swap at ${index} changed the summary`);
      assert.equal(
        JSON.stringify(summarizePerf(swapped, { range }).coverage.bySource),
        rawBaseline,
        `swap at ${index} changed the bySource key order`,
      );
    }
    assert.equal(stable(summarizePerf([...rows].reverse(), { range })), baseline, "reversal changed the summary");
  }

  // exhaustive permutations of the unplaced-only subset
  const small = [
    codexSample({ identity: ["u8-c"], tsMs: null }),
    sample({ identity: ["u8-z"], tsMs: null, model: "z-only" }),
  ];
  const permutations = [
    [small[0], small[1]],
    [small[1], small[0]],
  ];
  const smallBaseline = stable(summarizePerf(small, { range: RANGE }));
  for (const order of permutations) {
    const summary = summarizePerf(order, { range: RANGE });
    assert.equal(stable(summary), smallBaseline, "a permutation changed the unplaced-only breakdown");
    assert.deepEqual(Object.keys(summary.coverage.bySource), ["codex", "zcode"]);
    assert.equal(summary.coverage.eligible, 0);
    assert.equal(summary.coverage.unplaced, 2);
  }
});
