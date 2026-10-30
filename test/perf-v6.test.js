import assert from "node:assert/strict";
import test from "node:test";

import {
  PERF_METHOD_VERSION,
  PERF_SUPPORTED_METHOD_VERSIONS,
  PERF_TOKEN_SCOPE,
  isGenerationPerfMethod,
  normalizePerfSample,
  summarizePerf,
} from "../src/perf-stats.js";

const MS = 1_793_376_000_000;

function raw(overrides = {}) {
  return {
    sourceKind: "zcode",
    homeId: "home",
    identity: ["request-1"],
    model: "model-a",
    agentKind: "unknown",
    status: "completed",
    tsMs: MS,
    window: "request",
    timingKind: "generation",
    tokenScope: PERF_TOKEN_SCOPE,
    durationMs: 1_000,
    outputTokens: 100,
    ...overrides,
  };
}

function normalized(value) {
  const result = normalizePerfSample(value);
  assert.notEqual(result.sample, null);
  return result.sample;
}

test("tps-v8 keeps v1-v7 readable and recognizes v3-v8 as generation methods", () => {
  assert.equal(PERF_METHOD_VERSION, "tps-v8");
  assert.deepEqual(PERF_SUPPORTED_METHOD_VERSIONS, [
    "tps-v1",
    "tps-v2",
    "tps-v3",
    "tps-v4",
    "tps-v5",
    "tps-v6",
    "tps-v7",
    "tps-v8",
  ]);
  for (const version of ["tps-v3", "tps-v4", "tps-v5", "tps-v6", "tps-v7", "tps-v8"]) {
    assert.equal(isGenerationPerfMethod(version), true, version);
  }
  for (const version of ["tps-v1", "tps-v2", "tps-v9", "", null]) {
    assert.equal(isGenerationPerfMethod(version), false, String(version));
  }
});

test("only current v8 samples with the unified scope contribute displayed statistics", () => {
  const current = normalized(raw());
  assert.equal(current.methodVersion, "tps-v8");
  assert.equal(current.tokenScope, PERF_TOKEN_SCOPE);

  const summary = summarizePerf([current]);
  assert.equal(summary.groups.length, 1);
  assert.equal(summary.groups[0].n, 1);
  assert.equal(summary.groups[0].tokenScope, PERF_TOKEN_SCOPE);
  assert.equal(summary.models[0].averageTps, 100);
});

test("explicit v6 with a legacy scope keeps v6 and reports a semantics mismatch", () => {
  const result = normalizePerfSample(
    raw({
      methodVersion: "tps-v6",
      timingKind: "request_e2e",
      tokenScope: "reported_output_unspecified",
    }),
  );
  assert.notEqual(result.sample, null);
  assert.equal(result.sample.methodVersion, "tps-v6");
  assert.equal(result.sample.tokenScope, "reported_output_unspecified");
  assert.equal(result.sample.outputTokens, 100);
  assert.ok(result.warnings.includes("SOURCE_SEMANTICS_MISMATCH"));

  const oldSummary = summarizePerf([result.sample]);
  assert.equal(oldSummary.groups.length, 0);
  assert.equal(oldSummary.models.length, 0);
});

test("historical v5 generation samples remain readable but are excluded from current statistics", () => {
  const result = normalizePerfSample(
    raw({
      methodVersion: "tps-v5",
      timingKind: "generation",
      tokenScope: "non_reasoning_output",
    }),
  );
  assert.notEqual(result.sample, null);
  assert.equal(result.warnings.includes("SOURCE_SEMANTICS_MISMATCH"), false);
  const historical = result.sample;

  assert.equal(historical.methodVersion, "tps-v5");
  assert.equal(historical.window, "request");
  assert.equal(historical.timingKind, "generation");
  assert.equal(historical.tokenScope, "non_reasoning_output");
  assert.equal(historical.outputTokens, 100);
  assert.equal(historical.durationMs, 1_000);

  const summary = summarizePerf([historical]);
  assert.equal(summary.groups.length, 0);
  assert.equal(summary.models.length, 1);
  assert.equal(summary.models[0].n, 0);
  assert.equal(summary.models[0].state, "missing_duration");
  assert.deepEqual([summary.models[0].averageTps, summary.models[0].p10, summary.models[0].p90], [null, null, null]);
});

test("v6 reference-token windows remain historical and cannot inflate current statistics", () => {
  const historical = normalized(
    raw({
      sourceKind: "codex",
      identity: ["thread", "turn", "response"],
      methodVersion: "tps-v6",
      outputTokens: 680,
      durationMs: 15,
    }),
  );
  assert.equal(historical.methodVersion, "tps-v6");
  assert.equal(historical.outputTokens, 680);
  assert.equal(historical.durationMs, 15);
  const legacySummary = summarizePerf([historical]);
  assert.equal(legacySummary.models[0].n, 0);
  assert.equal(legacySummary.models[0].averageTps, null);

  const current = normalized(
    raw({
      sourceKind: "codex",
      identity: ["thread", "turn", "response"],
      outputTokens: 200,
      durationMs: 2_000,
    }),
  );
  const mixed = summarizePerf([historical, current]);
  assert.equal(mixed.models[0].n, 1);
  assert.equal(mixed.models[0].averageTps, 100);
  assert.equal(mixed.models[0].p90, 100);
});

test("historical v7 measurements without 100ms precision stay v7 and never contribute current statistics", () => {
  const result = normalizePerfSample(
    raw({
      sourceKind: "codex",
      identity: ["thread", "turn", "response"],
      methodVersion: "tps-v7",
      outputTokens: 680,
      durationMs: 15,
    }),
  );
  assert.notEqual(result.sample, null);
  assert.equal(result.warnings.includes("SOURCE_SEMANTICS_MISMATCH"), false);

  const historical = result.sample;
  assert.equal(historical.methodVersion, "tps-v7");
  assert.equal(historical.tokenScope, PERF_TOKEN_SCOPE);
  assert.equal(historical.outputTokens, 680);
  assert.equal(historical.durationMs, 15);

  const summary = summarizePerf([historical]);
  assert.equal(summary.groups.length, 0);
  assert.equal(summary.models.length, 1);
  assert.deepEqual(
    {
      sourceKind: summary.models[0].sourceKind,
      model: summary.models[0].model,
      window: summary.models[0].window,
      state: summary.models[0].state,
      n: summary.models[0].n,
      averageTps: summary.models[0].averageTps,
      p10: summary.models[0].p10,
      p90: summary.models[0].p90,
      candidateCount: summary.models[0].candidateCount,
    },
    {
      sourceKind: "codex",
      model: "model-a",
      window: "request",
      state: "missing_duration",
      n: 0,
      averageTps: null,
      p10: null,
      p90: null,
      candidateCount: 1,
    },
    "historical v7 must retain an identity-only missing-duration model row with zero statistics",
  );
  assert.equal(summary.coverage.eligible, 1);
  assert.equal(summary.coverage.sampled, 0);
  assert.equal(summary.coverage.droppedByReason.historical_method, 1);
});

test("historical v5 DSH provider scope remains readable without being relabeled", () => {
  const result = normalizePerfSample(
    raw({
      sourceKind: "dsh",
      modelProvider: "deepseek-account",
      methodVersion: "tps-v5",
      tokenScope: "all_generated_output",
    }),
  );
  assert.notEqual(result.sample, null);
  assert.equal(result.warnings.includes("SOURCE_SEMANTICS_MISMATCH"), false);
  const historical = result.sample;

  assert.equal(historical.methodVersion, "tps-v5");
  assert.equal(historical.tokenScope, "all_generated_output");
  const summary = summarizePerf([historical]);
  assert.equal(summary.groups.length, 0);
  assert.equal(summary.models.length, 1);
  assert.equal(summary.models[0].n, 0);
  assert.equal(summary.models[0].state, "missing_duration");
  assert.deepEqual([summary.models[0].averageTps, summary.models[0].p10, summary.models[0].p90], [null, null, null]);
});

test("missing v6 measurement retains a model row without zero-filled values", () => {
  const missing = normalized(
    raw({
      sourceKind: "codex",
      identity: ["thread", "turn", "response"],
      outputTokens: null,
      durationMs: null,
    }),
  );
  const summary = summarizePerf([missing]);

  assert.equal(summary.groups.length, 0);
  assert.equal(summary.models.length, 1);
  assert.equal(summary.models[0].state, "missing_duration");
  assert.equal(summary.models[0].candidateCount, 1);
  assert.equal(summary.models[0].n, 0);
  assert.equal(summary.models[0].averageTps, null);
});
