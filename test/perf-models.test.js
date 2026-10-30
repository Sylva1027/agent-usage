import assert from "node:assert/strict";
import test from "node:test";

import { PERF_METHOD_VERSION, PERF_TOKEN_SCOPE, normalizePerfSample, summarizePerf } from "../src/perf-stats.js";

const T = 1_760_000_000_000;
const RANGE = { startMs: T - 1_000, endMs: T + 10_000 };

const SEMANTICS = {
  zcode: { window: "request", timingKind: "generation", tokenScope: PERF_TOKEN_SCOPE },
  dsh: { window: "request", timingKind: "generation", tokenScope: PERF_TOKEN_SCOPE },
  opencode: { window: "request", timingKind: "generation", tokenScope: PERF_TOKEN_SCOPE },
  codex: { window: "request", timingKind: "generation", tokenScope: PERF_TOKEN_SCOPE },
  workbuddy: { window: "request", timingKind: "generation", tokenScope: PERF_TOKEN_SCOPE },
  claude: { window: "request", timingKind: "generation", tokenScope: PERF_TOKEN_SCOPE },
};

const LEGACY_SEMANTICS = {
  zcode: { window: "request", timingKind: "request_e2e", tokenScope: "reported_output_unspecified" },
  dsh: { window: "step", timingKind: "request_e2e", tokenScope: "reported_output_unspecified" },
  opencode: { window: "message", timingKind: "request_e2e", tokenScope: "visible_plus_reasoning" },
  codex: { window: "turn", timingKind: "request_e2e", tokenScope: "reported_output_includes_reasoning" },
  workbuddy: { window: "request", timingKind: "request_e2e", tokenScope: "reported_output_includes_reasoning" },
  claude: { window: "request", timingKind: "request_e2e", tokenScope: "reported_output_includes_reasoning" },
};

function rawSample(overrides = {}) {
  const sourceKind = overrides.sourceKind ?? "zcode";
  const { identity = "row", ...rest } = overrides;
  const methodVersion = overrides.methodVersion ?? PERF_METHOD_VERSION;
  const historicalGeneration = methodVersion === "tps-v3" || methodVersion === "tps-v4" || methodVersion === "tps-v5";
  const allGeneration =
    historicalGeneration &&
    sourceKind === "dsh" &&
    (methodVersion === "tps-v4" || methodVersion === "tps-v5") &&
    ["deepseek-account", "deepseek-official"].includes(overrides.modelProvider);
  const semantics =
    methodVersion === PERF_METHOD_VERSION
      ? SEMANTICS[sourceKind]
      : historicalGeneration
        ? {
            window: "request",
            timingKind: "generation",
            tokenScope: allGeneration ? "all_generated_output" : "non_reasoning_output",
          }
        : LEGACY_SEMANTICS[sourceKind];
  return normalizePerfSample({
    sourceKind,
    homeId: "home-a",
    status: "completed",
    tsMs: T,
    channel: "main",
    agentKind: "main",
    agent: "",
    model: "model-a",
    modelProvider: "",
    reasoningEffort: "",
    durationMs: 1_000,
    outputTokens: 100,
    timingSource: "explicit",
    ...semantics,
    ...rest,
    identity: [identity],
  });
}

function sample(overrides = {}) {
  const result = rawSample(overrides);
  assert.equal(result.warningCode, null, JSON.stringify(result.warnings));
  return result.sample;
}

function repeated(model, count, rate, extra = {}) {
  return Array.from({ length: count }, (_, index) =>
    sample({
      identity: `${model}-${index}`,
      sourceKind: "codex",
      model,
      outputTokens: rate,
      durationMs: 1_000,
      ...extra,
    }),
  );
}

test("current-day Codex candidates without request duration retain model identity and actual candidate dates", () => {
  const today = Date.parse("2026-10-23T00:00:00+08:00");
  const rows = [1, 2].map((i) =>
    sample({
      identity: `missing-${i}`,
      sourceKind: "codex",
      model: "current-codex",
      reasoningEffort: "high",
      modelProvider: "provider-a",
      durationMs: null,
      timingSource: "unknown",
      tsMs: today + i * 1_000,
    }),
  );
  const perf = summarizePerf([...rows, rows[0]], {
    range: { startMs: today, windowEndExclusiveMs: today + 86_400_000 },
  });
  assert.deepEqual(perf.groups, []);
  assert.equal(perf.models.length, 1);
  assert.deepEqual(perf.models[0], {
    key: JSON.stringify(["codex", "current-codex", "high", "provider-a"]),
    sourceKind: "codex",
    model: "current-codex",
    reasoningEffort: "high",
    modelProvider: "provider-a",
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
    candidateCount: 2,
    firstCandidateAtMs: today + 1_000,
    lastCandidateAtMs: today + 2_000,
  });
  assert.deepEqual(summarizePerf([...rows].reverse(), { range: null }).models, perf.models);
});

test("missing-duration Codex rows never duplicate or overwrite a timed model, and preserve provider/effort", () => {
  const valid = sample({
    identity: "valid",
    sourceKind: "codex",
    model: "same",
    reasoningEffort: "high",
    modelProvider: "a",
  });
  const missing = sample({
    identity: "missing",
    sourceKind: "codex",
    model: "same",
    reasoningEffort: "high",
    modelProvider: "a",
    durationMs: null,
  });
  const otherProvider = sample({
    identity: "provider",
    sourceKind: "codex",
    model: "same",
    reasoningEffort: "high",
    modelProvider: "b",
    durationMs: null,
  });
  const otherEffort = sample({
    identity: "effort",
    sourceKind: "codex",
    model: "same",
    reasoningEffort: "low",
    modelProvider: "a",
    durationMs: null,
  });
  const perf = summarizePerf([valid, missing, otherProvider, otherEffort], { range: RANGE });
  assert.equal(perf.models.length, 3);
  assert.deepEqual(
    perf.models.find((row) => row.key === JSON.stringify(["codex", "same", "high", "a"])),
    summarizePerf([valid], { range: RANGE }).models[0],
  );
  assert.equal(perf.models.filter((row) => row.state === "missing_duration").length, 2);
  assert.ok(perf.models.filter((row) => row.state === "missing_duration").every((row) => row.candidateCount === 1));
});

test("missing-duration model rows are retained for every current source", () => {
  const valid = sample({ identity: "z-valid", sourceKind: "zcode" });
  const rows = ["claude", "zcode", "dsh", "opencode", "workbuddy"].map((sourceKind) =>
    sample({
      identity: `${sourceKind}-missing`,
      sourceKind,
      model: "missing",
      durationMs: null,
    }),
  );
  const perf = summarizePerf([valid, ...rows], { range: RANGE });
  assert.equal(perf.models.filter((row) => row.state === "ok").length, 1);
  assert.deepEqual(
    perf.models
      .filter((row) => row.state === "missing_duration")
      .map((row) => row.sourceKind)
      .sort(),
    ["claude", "dsh", "opencode", "workbuddy", "zcode"],
  );
  assert.ok(
    perf.models
      .filter((row) => row.state === "missing_duration")
      .every((row) => row.window === "request" && row.rankState === "unverified"),
  );
});

test("historical v3-v5 generation identities stay visible without contributing current rates", () => {
  const rows = [];
  for (const methodVersion of ["tps-v3", "tps-v4", "tps-v5"]) {
    for (const sourceKind of ["claude", "zcode", "dsh", "opencode", "workbuddy", "codex"]) {
      rows.push(
        sample({
          identity: `${sourceKind}-${methodVersion}`,
          sourceKind,
          model: `${sourceKind}-${methodVersion}`,
          methodVersion,
          outputTokens: 278,
          durationMs: 6,
        }),
      );
    }
  }

  const perf = summarizePerf(rows, { range: RANGE });
  assert.deepEqual(perf.groups, []);
  assert.equal(perf.coverage.sampled, 0);
  assert.equal(perf.coverage.droppedByReason.historical_method, rows.length);
  assert.equal(perf.models.length, rows.length);
  assert.ok(
    perf.models.every(
      (row) =>
        row.state === "missing_duration" &&
        row.rankState === "unverified" &&
        row.window === "request" &&
        row.n === 0 &&
        row.averageTps === null &&
        row.p10 === null &&
        row.p90 === null &&
        row.candidateCount === 1,
    ),
  );
});

test("historical identity visibility preserves filters, current precedence, and measured-model deduplication", () => {
  const currentMeasured = sample({
    identity: "shared-current",
    sourceKind: "claude",
    model: "shared-measured",
  });
  const historicalSameModel = sample({
    identity: "shared-history",
    sourceKind: "claude",
    model: "shared-measured",
    methodVersion: "tps-v5",
    outputTokens: 999,
    durationMs: 1,
  });
  const currentIdentity = sample({
    identity: "same-identity",
    sourceKind: "opencode",
    model: "current-wins",
    durationMs: null,
  });
  const historicalSameIdentity = sample({
    identity: "same-identity",
    sourceKind: "opencode",
    model: "historical-loses",
    methodVersion: "tps-v5",
    outputTokens: 999,
    durationMs: 1,
  });
  const includedHistory = sample({
    identity: "included-history",
    sourceKind: "zcode",
    model: "included-history",
    methodVersion: "tps-v5",
    outputTokens: 278,
    durationMs: 6,
  });
  const excludedHome = sample({
    identity: "excluded-history",
    sourceKind: "zcode",
    model: "excluded-history",
    methodVersion: "tps-v5",
    homeId: "excluded",
  });
  const outOfRange = sample({
    identity: "outside-history",
    sourceKind: "zcode",
    model: "outside-history",
    methodVersion: "tps-v5",
    tsMs: RANGE.endMs + 1,
  });
  const unplaced = sample({
    identity: "unplaced-history",
    sourceKind: "zcode",
    model: "unplaced-history",
    methodVersion: "tps-v5",
    tsMs: null,
  });
  const mismatch = rawSample({
    identity: "mismatch-history",
    sourceKind: "zcode",
    model: "mismatch-history",
    methodVersion: "tps-v5",
    window: "turn",
  }).sample;
  const estimate = sample({
    identity: "estimate-history",
    sourceKind: "zcode",
    model: "estimate-history",
    methodVersion: "tps-v1",
    methodEstimate: true,
  });
  const v2Estimate = sample({
    identity: "v2-estimate-history",
    sourceKind: "zcode",
    model: "v2-estimate-history",
    methodVersion: "tps-v2",
    methodEstimate: true,
  });
  const ambiguous = sample({
    identity: "ambiguous-history",
    sourceKind: "zcode",
    model: "ambiguous-history",
    methodVersion: "tps-v5",
    modelAmbiguous: true,
  });

  const perf = summarizePerf(
    [
      currentMeasured,
      historicalSameModel,
      currentIdentity,
      historicalSameIdentity,
      includedHistory,
      excludedHome,
      outOfRange,
      unplaced,
      mismatch,
      estimate,
      v2Estimate,
      ambiguous,
    ],
    { range: RANGE, excludedHomeIds: ["excluded"] },
  );
  assert.equal(perf.coverage.sampled, 1);
  assert.deepEqual(
    perf.models.map((row) => [row.model, row.state, row.n, row.averageTps, row.candidateCount ?? null]),
    [
      ["shared-measured", "ok", 1, 100, null],
      ["current-wins", "missing_duration", 0, null, 1],
      ["included-history", "missing_duration", 0, null, 1],
    ],
  );
  assert.equal(
    perf.models.some((row) =>
      [
        "historical-loses",
        "excluded-history",
        "outside-history",
        "estimate-history",
        "v2-estimate-history",
        "ambiguous-history",
      ].includes(row.model),
    ),
    false,
  );
});

test("missing-duration visibility cannot leak excluded homes, dates, unplaced rows or historical estimates", () => {
  const missing = (identity, extra = {}) =>
    sample({ identity, sourceKind: "codex", model: identity, durationMs: null, ...extra });
  const included = missing("included", { tsMs: T + 1_000 });
  const rows = [
    included,
    missing("excluded-home", { homeId: "excluded" }),
    missing("before-range", { tsMs: RANGE.startMs - 1 }),
    missing("at-exclusive-end", { tsMs: T + 10_000 }),
    missing("unplaced", { tsMs: null }),
    missing("historical", { methodVersion: "tps-v1", methodEstimate: true }),
    missing("estimate", { methodEstimate: true }),
    { ...missing("item-window"), timingKind: "item_span_estimate" },
    missing("ambiguous", { sampleFlags: ["MODEL_AMBIGUOUS"] }),
    missing("blank", { model: "" }),
  ];
  const options = {
    range: { startMs: RANGE.startMs, windowEndExclusiveMs: T + 10_000 },
    excludedHomeIds: ["excluded"],
  };
  const perf = summarizePerf(rows, options);
  assert.deepEqual(perf.models, summarizePerf([included], options).models);
  assert.equal(perf.models[0].candidateCount, 1);
  assert.equal(perf.models[0].firstCandidateAtMs, T + 1_000);
  assert.equal(perf.models[0].lastCandidateAtMs, T + 1_000);
});

test("historical item estimates stay readable but never enter current speed statistics", () => {
  const historical = repeated("historical", 102, 1_000, {
    model: "same-model",
    methodVersion: "tps-v1",
    sampleFlags: ["METHOD_ESTIMATE"],
  }).map((row) => ({
    ...row,
    timingKind: "item_span_estimate",
  }));
  const reviewed = repeated("same-model", 6, 100);
  const expected = summarizePerf(reviewed, { range: RANGE }).models;
  const combined = summarizePerf([...historical, ...reviewed], { range: RANGE });
  assert.deepEqual(combined.models, expected);
  assert.equal(combined.models[0].n, 6);
  assert.equal(combined.models[0].averageTps, 100);
  assert.equal(combined.models[0].p10, 100);
  assert.equal(combined.models[0].p90, 100);
  assert.equal(combined.models[0].rankState, "insufficient_samples");
  assert.equal(combined.models[0].rank, null);
  assert.equal(combined.coverage.sampled, 6);
  assert.equal(combined.coverage.droppedByReason.historical_method, 102);
  assert.equal(combined.groups.length, 1);
  assert.equal(combined.groups[0].n, 6);
  assert.deepEqual(summarizePerf(historical, { range: RANGE }).groups, []);
  assert.deepEqual(summarizePerf(historical, { range: RANGE }).models, []);
});

test("D1 hand calculation: pooled average can sit outside the p10-p90 band", () => {
  const slowStart = sample({
    identity: "outside-band-slow",
    sourceKind: "codex",
    model: "outside-band",
    outputTokens: 100,
    durationMs: 100_000,
  });
  const fast = Array.from({ length: 19 }, (_, index) =>
    sample({
      identity: `outside-band-fast-${index}`,
      sourceKind: "codex",
      model: "outside-band",
      outputTokens: 100,
      durationMs: 1_000,
    }),
  );

  const perf = summarizePerf([slowStart, ...fast], { range: RANGE });
  assert.equal(perf.models.length, 1);
  const row = perf.models[0];

  // 19 samples at 100 tok/s plus one at 1 tok/s:
  // sorted rates = [1, 100, 100, ..., 100]
  // p10 = sorted[ceil(0.1 * 20) - 1] = sorted[1] = 100
  // p90 = sorted[ceil(0.9 * 20) - 1] = sorted[17] = 100
  // average = (20 * 100) * 1000 / (19 * 1000 + 100000) = 2000 / 119
  assert.equal(row.n, 20);
  assert.equal(row.p10, 100);
  assert.equal(row.p90, 100);
  assert.equal(row.averageTps, (2_000 * 1_000) / 119_000);
  assert.ok(row.averageTps < row.p10);
  assert.equal(row.rankState, "eligible");
  assert.equal(row.rank, 1);
  assert.equal(row.state, "ok");
});

test("D1 identity: source/model/effort/provider split rows while home/agent merge", () => {
  const rows = [
    sample({
      identity: "provider-a-home-a",
      sourceKind: "codex",
      homeId: "home-a",
      channel: "main",
      agentKind: "main",
      agent: "root",
      modelProvider: "provider-a",
      model: "Model-X",
      reasoningEffort: "high",
      outputTokens: 1_000,
    }),
    sample({
      identity: "provider-a-home-b",
      sourceKind: "codex",
      homeId: "home-b",
      channel: "subagent",
      agentKind: "subagent",
      agent: "worker",
      modelProvider: "provider-a",
      model: "Model-X",
      reasoningEffort: "high",
      outputTokens: 2_000,
    }),
    sample({
      identity: "provider-b",
      sourceKind: "codex",
      homeId: "home-c",
      modelProvider: "provider-b",
      model: "Model-X",
      reasoningEffort: "high",
      outputTokens: 3_000,
    }),
    sample({
      identity: "empty-provider",
      sourceKind: "codex",
      modelProvider: "",
      model: "Model-X",
      reasoningEffort: "high",
      outputTokens: 500,
    }),
    sample({
      identity: "split-effort",
      sourceKind: "codex",
      model: "Model-X",
      modelProvider: "provider-a",
      reasoningEffort: "low",
      outputTokens: 400,
    }),
    sample({
      identity: "split-source",
      sourceKind: "dsh",
      model: "Model-X",
      reasoningEffort: "high",
      outputTokens: 500,
    }),
    sample({ identity: "empty-model", model: "", outputTokens: 100 }),
  ];

  const perf = summarizePerf(rows, { range: RANGE });
  assert.equal(
    perf.groups.some((group) => group.model === ""),
    true,
    "old groups keep the empty-model group",
  );
  assert.deepEqual(
    perf.models.map((row) => ({
      sourceKind: row.sourceKind,
      model: row.model,
      reasoningEffort: row.reasoningEffort,
      modelProvider: row.modelProvider,
      rankState: row.rankState,
      averageTps: row.averageTps,
      p10: row.p10,
      p90: row.p90,
      n: row.n,
      rank: row.rank,
    })),
    [
      {
        sourceKind: "codex",
        model: "Model-X",
        reasoningEffort: "high",
        modelProvider: "provider-b",
        rankState: "insufficient_samples",
        averageTps: 3_000,
        p10: 3_000,
        p90: 3_000,
        n: 1,
        rank: null,
      },
      {
        sourceKind: "codex",
        model: "Model-X",
        reasoningEffort: "high",
        modelProvider: "provider-a",
        rankState: "insufficient_samples",
        averageTps: 1_500,
        p10: 1_000,
        p90: 2_000,
        n: 2,
        rank: null,
      },
      {
        sourceKind: "codex",
        model: "Model-X",
        reasoningEffort: "high",
        modelProvider: "",
        rankState: "insufficient_samples",
        averageTps: 500,
        p10: 500,
        p90: 500,
        n: 1,
        rank: null,
      },
      {
        sourceKind: "dsh",
        model: "Model-X",
        reasoningEffort: "high",
        modelProvider: "",
        rankState: "insufficient_samples",
        averageTps: 500,
        p10: 500,
        p90: 500,
        n: 1,
        rank: null,
      },
      {
        sourceKind: "codex",
        model: "Model-X",
        reasoningEffort: "low",
        modelProvider: "provider-a",
        rankState: "insufficient_samples",
        averageTps: 400,
        p10: 400,
        p90: 400,
        n: 1,
        rank: null,
      },
    ],
  );
  assert.equal(perf.models[0].key, JSON.stringify(["codex", "Model-X", "high", "provider-b"]));
  assert.deepEqual(summarizePerf([...rows].reverse(), { range: RANGE }).models, perf.models);
});

test("D2 dates: range and home filters use actual member timestamps", () => {
  const rows = [
    sample({
      identity: "date-a-early",
      sourceKind: "codex",
      homeId: "home-a",
      model: "dated",
      modelProvider: "provider-date",
      tsMs: T + 1_000,
    }),
    sample({
      identity: "date-b",
      sourceKind: "codex",
      homeId: "home-b",
      model: "dated",
      modelProvider: "provider-date",
      tsMs: T + 2_000,
    }),
    sample({
      identity: "date-a-late",
      sourceKind: "codex",
      homeId: "home-a",
      model: "dated",
      modelProvider: "provider-date",
      tsMs: T + 3_000,
    }),
    sample({
      identity: "date-b-late",
      sourceKind: "codex",
      homeId: "home-b",
      model: "dated",
      modelProvider: "provider-date",
      tsMs: T + 4_000,
    }),
  ];

  const full = summarizePerf(rows, { range: RANGE }).models[0];
  assert.equal(full.n, 4);
  assert.equal(full.firstSampleAtMs, T + 1_000);
  assert.equal(full.lastSampleAtMs, T + 4_000);
  assert.equal(full.window, "request");

  const ranged = summarizePerf(rows, { range: { startMs: T + 1_500, endMs: T + 3_500 } }).models[0];
  assert.equal(ranged.n, 2);
  assert.equal(ranged.firstSampleAtMs, T + 2_000);
  assert.equal(ranged.lastSampleAtMs, T + 3_000);

  const homeFiltered = summarizePerf(rows, { range: RANGE, excludedHomeIds: ["home-b"] }).models[0];
  assert.equal(homeFiltered.n, 2);
  assert.equal(homeFiltered.firstSampleAtMs, T + 1_000);
  assert.equal(homeFiltered.lastSampleAtMs, T + 3_000);
});

test("D2 dates: v1 does not widen v3; current Codex stays request-scoped and requestCount is not projected", () => {
  const rows = [
    sample({
      identity: "v1-early",
      sourceKind: "codex",
      model: "v2-only",
      modelProvider: "provider-date",
      methodVersion: "tps-v1",
      tsMs: T - 500,
      requestCount: 7,
    }),
    sample({
      identity: "v2-late",
      sourceKind: "codex",
      model: "v2-only",
      modelProvider: "provider-date",
      tsMs: T + 2_000,
      requestCount: 7,
    }),
    sample({
      identity: "v2-early",
      sourceKind: "codex",
      model: "v2-only",
      modelProvider: "provider-date",
      tsMs: T + 1_000,
      requestCount: 7,
    }),
  ];

  const row = summarizePerf(rows, { range: RANGE }).models.find((model) => model.model === "v2-only");
  assert.equal(row.n, 2);
  assert.equal(row.firstSampleAtMs, T + 1_000);
  assert.equal(row.lastSampleAtMs, T + 2_000);
  assert.equal(row.window, "request");
  assert.equal(Object.hasOwn(row, "requestCount"), false);
});

test("D1 rankState: default n=20 is eligible; n=1/17/19 stay unranked; explicit threshold applies", () => {
  const rows = [
    ...repeated("twenty", 20, 40),
    ...repeated("nineteen", 19, 30),
    ...repeated("seventeen", 17, 20),
    ...repeated("one", 1, 10),
  ];

  const defaulted = summarizePerf(rows, { range: RANGE });
  assert.deepEqual(
    defaulted.models.map((row) => [row.model, row.n, row.rankState, row.rank]),
    [
      ["twenty", 20, "eligible", 1],
      ["nineteen", 19, "insufficient_samples", null],
      ["seventeen", 17, "insufficient_samples", null],
      ["one", 1, "insufficient_samples", null],
    ],
  );
  assert.equal(defaulted.meta.minSamples, 20);

  const explicit = summarizePerf(rows, { range: RANGE, meta: { minSamples: 19 } });
  assert.deepEqual(
    explicit.models.map((row) => [row.model, row.n, row.rankState, row.rank]),
    [
      ["twenty", 20, "eligible", 1],
      ["nineteen", 19, "eligible", 2],
      ["seventeen", 17, "insufficient_samples", null],
      ["one", 1, "insufficient_samples", null],
    ],
  );
  assert.equal(explicit.meta.minSamples, 19);
});

test("model display order follows average TPS regardless of sample threshold, with missing values last", () => {
  const rows = [
    ...repeated("slow-eligible", 20, 68),
    ...repeated("fast-small", 1, 360),
    ...repeated("middle-small", 1, 191),
    ...repeated("workbuddy-small", 2, 183, { sourceKind: "workbuddy" }),
    sample({ identity: "missing", sourceKind: "codex", model: "missing", durationMs: null }),
  ];
  const perf = summarizePerf(rows, { range: RANGE });
  assert.deepEqual(
    perf.models.map((row) => [row.model, row.averageTps, row.rank]),
    [
      ["fast-small", 360, null],
      ["middle-small", 191, null],
      ["workbuddy-small", 183, null],
      ["slow-eligible", 68, 1],
      ["missing", null, null],
    ],
  );
  assert.deepEqual(summarizePerf([...rows].reverse(), { range: RANGE }).models, perf.models);
});

test("D1 order: rows use unrounded averages, then key order for exact ties", () => {
  const rows = [
    ...repeated("twenty", 20, 40),
    ...repeated("nineteen", 19, 30),
    ...repeated("seventeen", 17, 20),
    ...repeated("one", 1, 10),
    sample({ identity: "round-a", sourceKind: "codex", model: "round-a", outputTokens: 104, durationMs: 100_000 }),
    sample({ identity: "round-b", sourceKind: "codex", model: "round-b", outputTokens: 103, durationMs: 100_000 }),
    sample({ identity: "tie-b", sourceKind: "codex", model: "tie-b", outputTokens: 5 }),
    sample({ identity: "tie-a", sourceKind: "codex", model: "tie-a", outputTokens: 5 }),
  ];

  const perf = summarizePerf(rows.reverse(), { range: RANGE, meta: { minSamples: 1 } });
  assert.deepEqual(
    perf.models.map((row) => [row.model, row.n, row.rank]),
    [
      ["twenty", 20, 1],
      ["nineteen", 19, 2],
      ["seventeen", 17, 3],
      ["one", 1, 4],
      ["tie-a", 1, 5],
      ["tie-b", 1, 6],
      ["round-a", 1, 7],
      ["round-b", 1, 8],
    ],
  );
  const roundA = perf.models.find((row) => row.model === "round-a");
  const roundB = perf.models.find((row) => row.model === "round-b");
  assert.equal(roundA.averageTps.toFixed(1), roundB.averageTps.toFixed(1));
  assert.ok(roundA.averageTps > roundB.averageTps);
  assert.ok(perf.models.every((row) => row.rankState === "eligible"));
});

test("D1 rankState: every current source can rank; overflow stays last", () => {
  const maxSafeMinusOne = Number.MAX_SAFE_INTEGER - 1;
  const rows = [
    ...repeated("eligible", 20, 10),
    ...repeated("dsh-large", 20, 100, { sourceKind: "dsh" }),
    sample({
      identity: "overflow-a",
      sourceKind: "codex",
      model: "overflow-model",
      durationMs: maxSafeMinusOne,
      outputTokens: 1_000,
    }),
    sample({
      identity: "overflow-b",
      sourceKind: "codex",
      model: "overflow-model",
      durationMs: maxSafeMinusOne,
      outputTokens: 1_000,
    }),
  ];

  const perf = summarizePerf(rows, { range: RANGE });
  assert.deepEqual(
    perf.models.map((row) => [row.model, row.state, row.rankState, row.rank]),
    [
      ["dsh-large", "ok", "eligible", 1],
      ["eligible", "ok", "eligible", 2],
      ["overflow-model", "overflow", "overflow", null],
    ],
  );
});

test("D1 overflow: merged model sums fail without changing old groups/coverage/meta", () => {
  const maxSafeMinusOne = Number.MAX_SAFE_INTEGER - 1;
  const rows = [
    sample({
      identity: "overflow-a",
      sourceKind: "codex",
      homeId: "home-a",
      model: "overflow-model",
      tsMs: T - 500,
      durationMs: maxSafeMinusOne,
      outputTokens: 1_000,
    }),
    sample({
      identity: "overflow-b",
      sourceKind: "codex",
      homeId: "home-b",
      model: "overflow-model",
      tsMs: T + 2_000,
      durationMs: maxSafeMinusOne,
      outputTokens: 1_000,
    }),
    sample({ identity: "healthy", sourceKind: "codex", model: "healthy", outputTokens: 100 }),
  ];

  const perf = summarizePerf(rows, { range: RANGE });
  assert.equal(perf.groups.length, 3, "home still separates the old groups");
  assert.equal(
    perf.groups.every((group) => group.state === "ok"),
    true,
    "each old group sum is safe",
  );
  assert.equal(perf.coverage.sampled, 3);
  assert.deepEqual(perf.meta.sourceWarnings, [], "model overflow must not add a group warning");

  assert.deepEqual(perf.models[0], {
    key: JSON.stringify(["codex", "healthy", "", ""]),
    sourceKind: "codex",
    model: "healthy",
    reasoningEffort: "",
    modelProvider: "",
    window: "request",
    firstSampleAtMs: T,
    lastSampleAtMs: T,
    averageTps: 100,
    p10: 100,
    p90: 100,
    n: 1,
    state: "ok",
    rankState: "insufficient_samples",
    rank: null,
  });
  assert.deepEqual(perf.models[1], {
    key: JSON.stringify(["codex", "overflow-model", "", ""]),
    sourceKind: "codex",
    model: "overflow-model",
    reasoningEffort: "",
    modelProvider: "",
    window: "request",
    firstSampleAtMs: T - 500,
    lastSampleAtMs: T + 2_000,
    averageTps: null,
    p10: null,
    p90: null,
    n: 2,
    state: "overflow",
    rankState: "overflow",
    rank: null,
  });
});

test("D1 rankState: overflow takes priority over unverified", () => {
  const maxSafeMinusOne = Number.MAX_SAFE_INTEGER - 1;
  const rows = [
    sample({
      identity: "unverified-overflow-a",
      sourceKind: "dsh",
      model: "unverified-overflow",
      durationMs: maxSafeMinusOne,
      outputTokens: 1_000,
    }),
    sample({
      identity: "unverified-overflow-b",
      sourceKind: "dsh",
      model: "unverified-overflow",
      durationMs: maxSafeMinusOne,
      outputTokens: 1_000,
    }),
  ];

  const perf = summarizePerf(rows, { range: RANGE });
  assert.equal(perf.models.length, 1);
  assert.equal(perf.models[0].n, 2);
  assert.equal(perf.models[0].rankState, "overflow");
  assert.equal(perf.models[0].rank, null);
});

test("D1 stability: input order and duplicate sample identities do not change models", () => {
  const rows = [
    sample({ identity: "stable-z", model: "z-model", outputTokens: 300 }),
    sample({ identity: "stable-a", sourceKind: "dsh", model: "a-model", outputTokens: 100 }),
    sample({ identity: "stable-m", sourceKind: "codex", model: "m-model", outputTokens: 200 }),
    sample({ identity: "stable-b", model: "b-model", outputTokens: 200 }),
  ];
  const forward = summarizePerf(rows, { range: RANGE });
  const backward = summarizePerf([...rows].reverse(), { range: RANGE });
  assert.deepEqual(backward.models, forward.models);

  const once = sample({ identity: "duplicate-identity", model: "duplicate", outputTokens: 100 });
  const duplicated = summarizePerf([once, once], { range: RANGE });
  assert.equal(duplicated.coverage.sampled, 1);
  assert.equal(duplicated.models.length, 1);
  assert.equal(duplicated.models[0].n, 1);
  assert.equal(duplicated.models[0].averageTps, 100);
});

test("D1 shape and empty cases: exactly fifteen fields, no row for n=0 or an empty model", () => {
  const empty = summarizePerf([], { range: RANGE });
  assert.deepEqual(empty.models, []);

  const emptyModel = summarizePerf([sample({ identity: "blank-model", model: "   " })], { range: RANGE });
  assert.deepEqual(emptyModel.models, []);
  assert.equal(emptyModel.groups.length, 1, "old groups still retain the empty-model group");

  const one = summarizePerf(
    [sample({ identity: "shape", sourceKind: "opencode", model: "Case-Sensitive", reasoningEffort: "max" })],
    { range: RANGE },
  );
  assert.deepEqual(Object.keys(one.models[0]).sort(), [
    "averageTps",
    "firstSampleAtMs",
    "key",
    "lastSampleAtMs",
    "model",
    "modelProvider",
    "n",
    "p10",
    "p90",
    "rank",
    "rankState",
    "reasoningEffort",
    "sourceKind",
    "state",
    "window",
  ]);
  assert.equal(one.models[0].key, JSON.stringify(["opencode", "Case-Sensitive", "max", ""]));
  assert.equal(one.models[0].model, "Case-Sensitive");
  assert.equal(one.models[0].modelProvider, "");
  assert.equal(one.models[0].window, "request");
  assert.equal(one.models[0].firstSampleAtMs, T);
  assert.equal(one.models[0].lastSampleAtMs, T);
});

test("B2 unified ranking is source-independent for current v6 generation samples", () => {
  const rows = [
    sample({ identity: "codex-v3", sourceKind: "codex", model: "codex-v3" }),
    sample({
      identity: "codex-v1",
      sourceKind: "codex",
      model: "codex-v1",
      methodVersion: "tps-v1",
    }),
    rawSample({
      identity: "codex-future",
      sourceKind: "codex",
      model: "codex-future",
      methodVersion: "tps-v99",
    }).sample,
    sample({
      identity: "codex-unknown-source",
      sourceKind: "codex",
      model: "codex-unknown-source",
      timingSource: "unknown",
    }),
    sample({
      identity: "codex-estimate",
      sourceKind: "codex",
      model: "codex-estimate",
      methodEstimate: true,
    }),
    sample({ identity: "dsh", sourceKind: "dsh", model: "dsh" }),
    sample({ identity: "zcode", sourceKind: "zcode", model: "zcode" }),
    sample({ identity: "opencode", sourceKind: "opencode", model: "opencode" }),
    sample({ identity: "workbuddy", sourceKind: "workbuddy", model: "workbuddy" }),
  ];
  const perf = summarizePerf(rows, { range: RANGE, meta: { minSamples: 1 } });
  const modelOf = (name) => perf.models.find((row) => row.model === name);
  const groupOf = (name) => perf.groups.find((group) => group.model === name);

  assert.equal(perf.coverage.sampled, 7);
  assert.equal(perf.coverage.droppedByReason.historical_method, 2);
  for (const name of ["codex-v3", "codex-unknown-source", "dsh", "zcode", "opencode", "workbuddy"]) {
    assert.equal(modelOf(name).rankState, "eligible", `${name} model rankState`);
    assert.notEqual(modelOf(name).rank, null, `${name} model rank`);
    assert.notEqual(groupOf(name).rank, null, `${name} group rank`);
    assert.equal(modelOf(name).n, 1);
    assert.equal(modelOf(name).averageTps, 100);
  }
  assert.equal(modelOf("codex-estimate"), undefined, "estimate rows do not enter the ranked model projection");
  assert.equal(groupOf("codex-estimate").n, 1, "estimate rows remain visible in sampled group diagnostics");
  assert.equal(groupOf("codex-estimate").rank, null);
  assert.equal(perf.coverage.byFlag.METHOD_ESTIMATE, 1);
  for (const name of ["codex-v1", "codex-future"]) {
    assert.equal(modelOf(name), undefined, `${name} does not enter the speed overview`);
    assert.equal(groupOf(name), undefined, `${name} does not enter current statistics`);
  }

  const opencode = modelOf("opencode");
  assert.deepEqual([opencode.p10, opencode.p90], [100, 100]);
  assert.equal(groupOf("opencode").n, 1);
});

test("B2 duplicate folding prefers the current v6 representative over stale v1", () => {
  const current = sample({
    identity: "same-turn",
    sourceKind: "codex",
    model: "same-turn",
    methodVersion: PERF_METHOD_VERSION,
  });
  // The same stored row may remain readable as v1 after the method label changes.
  // Its already-recorded current semantics must stay byte-for-byte comparable for folding.
  const v1 = { ...current, methodVersion: "tps-v1" };

  const forward = summarizePerf([v1, current], { range: RANGE, meta: { minSamples: 1 } });
  const backward = summarizePerf([current, v1], { range: RANGE, meta: { minSamples: 1 } });
  assert.equal(forward.coverage.sampled, 1);
  assert.equal(forward.models[0].rankState, "eligible");
  assert.equal(forward.models[0].rank, 1);
  assert.equal(forward.groups[0].rank, 1);
  assert.deepEqual(backward.models, forward.models);
  assert.deepEqual(backward.groups, forward.groups);
});

test("B2 Claude request-level timestamp fallback samples are rank-admitted", () => {
  const claude = sample({
    identity: "claude-ok",
    sourceKind: "claude",
    model: "claude-model",
    timingSource: "timestamp_fallback",
  });

  const perf = summarizePerf([claude], { range: RANGE, meta: { minSamples: 1 } });
  assert.equal(perf.models.length, 1);
  assert.equal(perf.models[0].sourceKind, "claude");
  assert.equal(perf.models[0].n, 1);
  assert.equal(perf.models[0].averageTps, 100);
  assert.equal(perf.models[0].rankState, "eligible");
  assert.equal(perf.models[0].rank, 1);
  assert.equal(perf.groups.length, 1);
  assert.equal(perf.groups[0].rank, 1);
});

test("B2 current provenance is source-independent while method and semantics remain gated", () => {
  const base = sample({
    identity: "claude-base",
    sourceKind: "claude",
    model: "claude-variant",
    timingSource: "timestamp_fallback",
  });
  const explicit = { ...base, timingSource: "explicit" };
  const explicitPerf = summarizePerf([explicit], { range: RANGE, meta: { minSamples: 1 } });
  assert.equal(explicitPerf.models[0].rankState, "eligible");
  assert.equal(explicitPerf.models[0].rank, 1);

  const windowMismatch = { ...base, window: "turn" };
  const mismatchPerf = summarizePerf([windowMismatch], { range: RANGE, meta: { minSamples: 1 } });
  assert.deepEqual(mismatchPerf.models, []);
  assert.deepEqual(mismatchPerf.groups, []);
  assert.equal(mismatchPerf.coverage.sampled, 0);
  assert.equal(mismatchPerf.coverage.droppedByReason.source_semantics_mismatch, 1);

  const historical = sample({
    identity: "claude-v1",
    sourceKind: "claude",
    model: "claude-variant",
    timingSource: "timestamp_fallback",
    methodVersion: "tps-v1",
  });
  const historicalPerf = summarizePerf([historical], { range: RANGE, meta: { minSamples: 1 } });
  assert.deepEqual(historicalPerf.models, []);
  assert.deepEqual(historicalPerf.groups, []);
  assert.equal(historicalPerf.coverage.droppedByReason.historical_method, 1);

  const estimate = sample({
    identity: "claude-estimate",
    sourceKind: "claude",
    model: "claude-variant",
    timingSource: "timestamp_fallback",
    methodEstimate: true,
  });
  const estimatePerf = summarizePerf([estimate], { range: RANGE, meta: { minSamples: 1 } });
  assert.deepEqual(estimatePerf.models, [], "estimate evidence cannot create a ranked model row");
  assert.equal(estimatePerf.coverage.sampled, 1);
  assert.equal(estimatePerf.coverage.byFlag.METHOD_ESTIMATE, 1);
  assert.equal(estimatePerf.groups.length, 1);
  assert.equal(estimatePerf.groups[0].n, 1);
  assert.equal(estimatePerf.groups[0].rank, null);
});

test("B2 mixed Codex and Claude buckets rank continuously; estimate siblings stay coverage-only", () => {
  const rows = [
    // 1.04 vs 1.03 tok/s: the same display rounding, different raw means.
    sample({
      identity: "codex-round-higher",
      sourceKind: "codex",
      model: "codex-round-higher",
      outputTokens: 104,
      durationMs: 100_000,
    }),
    sample({
      identity: "claude-round-lower",
      sourceKind: "claude",
      model: "claude-round-lower",
      timingSource: "timestamp_fallback",
      outputTokens: 103,
      durationMs: 100_000,
    }),
    sample({
      identity: "claude-fast",
      sourceKind: "claude",
      model: "claude-fast",
      timingSource: "timestamp_fallback",
      outputTokens: 200,
      durationMs: 1_000,
    }),
  ];

  const perf = summarizePerf(rows, { range: RANGE, meta: { minSamples: 1 } });
  assert.deepEqual(
    perf.models.map((row) => [row.model, row.rank]),
    [
      ["claude-fast", 1],
      ["codex-round-higher", 2],
      ["claude-round-lower", 3],
    ],
  );
  assert.ok(perf.models.every((row) => row.rankState === "eligible"));
  const higher = perf.models.find((row) => row.model === "codex-round-higher");
  const lower = perf.models.find((row) => row.model === "claude-round-lower");
  assert.equal(higher.averageTps.toFixed(1), lower.averageTps.toFixed(1));
  assert.ok(higher.averageTps > lower.averageTps, "display-round ties still order by raw mean");
  assert.deepEqual(
    perf.groups
      .map((group) => group.rank)
      .filter((rank) => rank !== null)
      .sort((a, b) => a - b),
    [1, 2, 3],
  );

  // Estimate evidence stays in coverage and gates its sampled group, while the
  // ranked model projection contains only the admitted sibling.
  const sibling = sample({
    identity: "claude-sibling",
    sourceKind: "claude",
    model: "claude-mixed",
    timingSource: "timestamp_fallback",
  });
  const estimate = sample({
    identity: "claude-stale",
    sourceKind: "claude",
    model: "claude-mixed",
    timingSource: "timestamp_fallback",
    methodEstimate: true,
  });
  const mixed = summarizePerf([sibling, estimate], {
    range: RANGE,
    meta: { minSamples: 1 },
  });
  assert.equal(mixed.coverage.sampled, 2);
  assert.equal(mixed.coverage.byFlag.METHOD_ESTIMATE, 1);
  assert.equal(mixed.models.length, 1);
  assert.equal(mixed.models[0].n, 1);
  assert.equal(mixed.models[0].window, "request");
  assert.equal(mixed.models[0].rankState, "eligible");
  assert.equal(mixed.models[0].rank, 1);
  assert.equal(mixed.groups.length, 1);
  assert.equal(mixed.groups[0].n, 2);
  assert.equal(mixed.groups[0].rank, null);
});
