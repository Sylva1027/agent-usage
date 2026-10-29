import assert from "node:assert/strict";
import test from "node:test";

import { PERF_METHOD_VERSION, normalizePerfSample, summarizePerf } from "../src/perf-stats.js";

const T = Date.parse("2026-10-29T12:00:00Z");

function sample(overrides = {}) {
  const result = normalizePerfSample({
    sourceKind: "workbuddy",
    homeId: "local",
    identity: ["session", "response"],
    model: "model-a",
    status: "completed",
    tsMs: T,
    windowStartMs: T - 1_000,
    windowEndMs: T,
    window: "request",
    timingKind: "generation",
    tokenScope: "non_reasoning_output",
    timingSource: "explicit",
    outputTokens: 99,
    durationMs: 1_000,
    ...overrides,
  });
  assert.ok(result.sample);
  return result;
}

test("v4 displays complete DSH generation while ranking only the non-reasoning phase", () => {
  const dsh = sample({
    sourceKind: "dsh",
    modelProvider: "deepseek-account",
    tokenScope: "all_generated_output",
    outputTokens: 199,
  });
  assert.deepEqual(dsh.warnings, []);
  const result = summarizePerf([sample().sample, dsh.sample], { meta: { minSamples: 1 } });
  assert.equal(result.meta.methodVersion, "tps-v4");
  assert.equal(result.coverage.sampled, 2);
  const total = result.models.find((row) => row.sourceKind === "dsh");
  assert.equal(total.averageTps, 199);
  assert.equal(total.n, 1);
  assert.equal(total.p10, 199);
  assert.equal(total.p90, 199);
  assert.equal(total.rank, null);
  assert.equal(result.models.find((row) => row.sourceKind === "workbuddy").rank, 1);
  assert.equal(result.groups.find((row) => row.sourceKind === "dsh").tokenScope, "all_generated_output");
});

test("an unreviewed provider cannot claim DSH all-generation semantics", () => {
  const raw = sample({ sourceKind: "dsh", modelProvider: "third-party", tokenScope: "all_generated_output" });
  assert.ok(raw.warnings.includes("SOURCE_SEMANTICS_MISMATCH"));
  const result = summarizePerf([raw.sample]);
  assert.equal(result.coverage.sampled, 0);
  assert.equal(result.models.length, 0);
});

test("v3 generation remains readable and measurable without changing the stored method", () => {
  for (const sourceKind of ["codex", "workbuddy", "opencode", "zcode", "claude"]) {
    const old = sample({ sourceKind, methodVersion: "tps-v3" });
    assert.deepEqual(old.warnings, []);
    const result = summarizePerf([old.sample], { meta: { minSamples: 1 } });
    assert.equal(result.models[0].averageTps, 99);
    assert.equal(result.models[0].rank, 1);
    assert.equal(old.sample.methodVersion, "tps-v3");
    assert.equal(result.meta.methodVersion, PERF_METHOD_VERSION);
    assert.equal(summarizePerf([old.sample, sample({ sourceKind }).sample]).models[0].n, 1);
  }
});

test("v1/v2 E2E samples keep their original meaning and never become generation speed", () => {
  for (const methodVersion of ["tps-v1", "tps-v2"]) {
    const old = sample({
      methodVersion,
      timingKind: "request_e2e",
      tokenScope: "reported_output_includes_reasoning",
    });
    assert.deepEqual(old.warnings, []);
    const result = summarizePerf([old.sample]);
    assert.equal(result.coverage.sampled, 0);
    assert.equal(result.models.length, 0);
    assert.equal(old.sample.methodVersion, methodVersion);
  }
});

test("a DSH scope upgrade measures a response once and does not blend two phases", () => {
  const old = sample({ sourceKind: "dsh", modelProvider: "deepseek-official", methodVersion: "tps-v3" });
  const current = sample({
    sourceKind: "dsh",
    modelProvider: "deepseek-official",
    tokenScope: "all_generated_output",
    outputTokens: 199,
    durationMs: 2_000,
  });
  for (const rows of [
    [old.sample, current.sample],
    [current.sample, old.sample],
  ]) {
    const result = summarizePerf(rows);
    assert.equal(result.coverage.eligible, 1);
    assert.equal(result.coverage.sampled, 1);
    assert.equal(result.models.length, 1);
    assert.equal(result.models[0].averageTps, 99.5);
    assert.equal(result.models[0].n, 1);
  }
  assert.equal(old.sample.methodVersion, "tps-v3");
});
