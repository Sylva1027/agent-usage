import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readCodexRolloutMetadata } from "../src/perf-sources/codex-jsonl.js";
import { foldCodexRolloutMetadata } from "../src/perf-sources/codex-fold.js";
import { buildCodexResponseCandidates } from "../src/perf-sources/codex-candidates.js";
import { buildUsageReport, summarizeUsage } from "../src/usage-core.js";
import { UsageStore } from "../src/usage-store.js";

const DATE = "2026-10-29T02:00:00.000Z";
const FILTERS = { preset: "all", now: new Date(DATE), calendarZone: "utc" };
const nativeGeneration = {
  schema_version: 2,
  first_output_ms: 125,
  last_output_ms: 145,
  observed_duration_ms: 20,
  output_tokens: 2,
  start_output_tokens: 1,
  first_output_read_id: 1,
  last_output_read_id: 2,
};
const row = (id, generation = nativeGeneration, usage = {}) => ({
  type: "token_usage_record",
  timestamp: DATE,
  payload: {
    thread_id: "thread",
    turn_id: "turn",
    response_id: id,
    usage: { output_tokens: 3, reasoning_output_tokens: 1, ...usage },
    generation_timing: generation,
  },
});
const headers = [
  { type: "session_meta", payload: { id: "thread", source: "cli" } },
  { type: "turn_context", payload: { thread_id: "thread", turn_id: "turn", model: "model-a", effort: "high" } },
];
const lines = (rows) => `${rows.map((value) => JSON.stringify(value)).join("\n")}\n`;
const timing = (responseId, overrides = {}) => ({
  schemaVersion: 2,
  evidenceOrigin: "fixture.provider-duration.v1",
  responseId,
  requestedModel: "model-a",
  reportedOutputTokens: 3,
  durationMs: 2000,
  status: "completed",
  completedAtMs: null,
  generation: {
    outputTokens: 2,
    durationMs: 1000,
    startOutputTokens: 0,
    timingKind: "explicit",
  },
  ...overrides,
});

function storeOptions(root, home) {
  return {
    homeDir: root,
    env: {},
    automaticDiscoveryEnabled: false,
    importDirs: [],
    databaseFile: path.join(root, "usage.sqlite"),
    extraHomes: home,
  };
}

function importTimings(store, homeId, records) {
  return store.importRequestTimingEvidence({
    homeId,
    records,
    reviewedOrigins: ["fixture.provider-duration.v1"],
  });
}

function assertUntimedCandidate(value, reportedOutputTokens = 3, reasoningOutputTokens = 1) {
  assert.equal(value.outputTokens, null);
  assert.equal(value.durationMs, null);
  assert.equal(value.reportedDurationMs, null);
  assert.equal(value.timingSource, "unknown");
  assert.equal(value.generation, null);
  assert.equal(value.reportedOutputTokens, reportedOutputTokens);
  assert.equal(value.reasoningOutputTokens, reasoningOutputTokens);
  assert.equal(value.reasoningOutputTokensKnown, true);
  assert.equal(value.model, "model-a");
  assert.equal(value.reasoningEffort, "high");
  assert.ok(value.sampleFlags.includes("MISSING_DURATION"));
}

function assertNoPublishedTps(summary, candidateCount = 1) {
  assert.equal(summary.perf.meta.methodVersion, "tps-v5");
  assert.equal(summary.perf.models.length, 1);
  assert.equal(summary.perf.models[0].candidateCount, candidateCount);
  assert.equal(summary.perf.models[0].n, 0);
  assert.equal(summary.perf.models[0].averageTps, null);
}

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), "native-generation-"));
  const home = path.join(root, "codex");
  const file = path.join(home, "sessions", "rollout.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await run({ root, home, file });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function candidates(file) {
  const projected = await readCodexRolloutMetadata(file);
  const folded = foldCodexRolloutMetadata("home", [projected]);
  return { projected, values: buildCodexResponseCandidates("home", folded, [file]).candidates };
}

test("schema 1 and 2 clocks never create TPS while raw usage and model identity remain", async () => {
  await fixture(async ({ file }) => {
    const schema1 = { ...nativeGeneration, schema_version: 1 };
    delete schema1.first_output_read_id;
    delete schema1.last_output_read_id;
    const cases = [
      { id: "schema1-20ms", generation: schema1, outputTokens: 3, reasoningOutputTokens: 1 },
      {
        id: "schema2-20ms",
        generation: { ...nativeGeneration, body: "BODY_MUST_NOT_LEAK" },
        outputTokens: 3,
        reasoningOutputTokens: 1,
      },
      {
        id: "schema2-1ms",
        generation: { ...nativeGeneration, last_output_ms: 126, observed_duration_ms: 1 },
        outputTokens: 3,
        reasoningOutputTokens: 1,
      },
      {
        id: "schema2-10s",
        generation: { ...nativeGeneration, last_output_ms: 10_125, observed_duration_ms: 10_000 },
        outputTokens: 3,
        reasoningOutputTokens: 1,
      },
      {
        id: "schema2-first-batch-900-total-1100",
        generation: {
          ...nativeGeneration,
          first_output_ms: 125,
          last_output_ms: 334,
          observed_duration_ms: 209,
          output_tokens: 1100,
          start_output_tokens: 900,
        },
        outputTokens: 1100,
        reasoningOutputTokens: 0,
      },
    ];
    await writeFile(
      file,
      lines([
        ...headers,
        ...cases.map(({ id, generation, outputTokens, reasoningOutputTokens }) =>
          row(id, generation, {
            output_tokens: outputTokens,
            reasoning_output_tokens: reasoningOutputTokens,
          }),
        ),
        row("missing", null),
      ]),
    );
    const { projected, values } = await candidates(file);
    assert.equal(JSON.stringify(projected).includes("BODY_MUST_NOT_LEAK"), false);
    assert.equal(values.length, cases.length + 1);
    for (const expected of cases) {
      assertUntimedCandidate(
        values.find((value) => value.responseId === expected.id),
        expected.outputTokens,
        expected.reasoningOutputTokens,
      );
    }
    assertUntimedCandidate(values.find((value) => value.responseId === "missing"));
  });
});

test("persisted v4 278/6ms and late schema2 appends remain unmeasurable without changing usage", async () => {
  await fixture(async ({ root, home, file }) => {
    const oldTiming = {
      schema_version: 1,
      first_output_ms: 8358,
      last_output_ms: 8364,
      observed_duration_ms: 6,
      output_tokens: 279,
      start_output_tokens: 1,
    };
    const oldRow = row("old-clock", oldTiming, { output_tokens: 280, reasoning_output_tokens: 1 });
    const usage = {
      type: "event_msg",
      timestamp: DATE,
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 0,
            output_tokens: 280,
            reasoning_output_tokens: 1,
            total_tokens: 380,
          },
        },
      },
    };
    await writeFile(file, lines([...headers, oldRow, usage]));
    const options = storeOptions(root, home);
    const store = new UsageStore(options);
    try {
      await store.sync();
      const before = await store.summarize(FILTERS);
      assert.equal(before.totals.total, 380);
      assertNoPublishedTps(before);

      store.database.exec(
        "UPDATE perf_samples SET method_version = 'tps-v4', output_tokens = 278, duration_ms = 6, sample_flags = 0, diagnostic_reason = '';",
      );
      store.writeMeta("perf_method_version", "tps-v4");
      const stale = await store.summarize(FILTERS);
      assertNoPublishedTps(stale);

      await store.sync();
      const rebuilt = await store.summarize(FILTERS);
      assertNoPublishedTps(rebuilt);
      assert.deepEqual(rebuilt.totals, before.totals);

      await appendFile(
        file,
        lines([
          row(
            "old-clock",
            {
              ...nativeGeneration,
              first_output_ms: 125,
              last_output_ms: 1125,
              observed_duration_ms: 1000,
              output_tokens: 279,
              start_output_tokens: 1,
            },
            { output_tokens: 280, reasoning_output_tokens: 1 },
          ),
        ]),
      );
      await store.sync();
      const lateAppend = await store.summarize(FILTERS);
      assertNoPublishedTps(lateAppend);
      assert.deepEqual(lateAppend.totals, before.totals);
    } finally {
      store.close();
    }
  });
});

test("untrusted clock duplicates do not conflict usage, while real usage conflicts stay isolated", async () => {
  await fixture(async ({ file }) => {
    await writeFile(
      file,
      lines([
        ...headers,
        row("clock-only", nativeGeneration),
        row("clock-only", {
          ...nativeGeneration,
          schema_version: 1,
          last_output_ms: 10_125,
          observed_duration_ms: 10_000,
        }),
        row("usage-conflict", nativeGeneration),
        row("usage-conflict", nativeGeneration, { output_tokens: 4 }),
      ]),
    );
    const { values } = await candidates(file);
    assert.equal(values.length, 2);

    const clocks = values.find((value) => value.responseId === "clock-only");
    assertUntimedCandidate(clocks);
    assert.equal(clocks.sampleFlags.includes("RECORD_CONFLICT"), false);

    const conflict = values.find((value) => value.responseId === "usage-conflict");
    assert.equal(conflict.outputTokens, null);
    assert.equal(conflict.durationMs, null);
    assert.equal(conflict.reportedOutputTokens, null);
    assert.equal(conflict.reasoningOutputTokens, 1);
    assert.equal(conflict.model, "model-a");
    assert.equal(conflict.reasoningEffort, "high");
    assert.equal(conflict.generation, null);
    assert.ok(conflict.sampleFlags.includes("RECORD_CONFLICT"));
  });
});

test("schema2 stays untimed across store reuse and late append while explicit evidence remains usable", async () => {
  await fixture(async ({ root, home, file }) => {
    const options = storeOptions(root, home);
    await writeFile(file, lines([...headers, row("first", null), row("late", null)]));
    const store = new UsageStore(options);
    try {
      await store.sync();
      const initial = await store.summarize(FILTERS);
      assertNoPublishedTps(initial, 2);
      const homeId = store.homes.find((item) => item.path === home).id;

      assert.equal(importTimings(store, homeId, [timing("first")]).changed, true);
      await store.sync();
      const oneTimed = await store.summarize(FILTERS);
      assert.equal(oneTimed.perf.models[0].n, 1);
      assert.equal(oneTimed.perf.models[0].averageTps, 2);
      assert.deepEqual(oneTimed.totals, initial.totals);

      await appendFile(file, lines([row("late"), row("first")]));
      await store.sync();
      const lateSchema2 = await store.summarize(FILTERS);
      assert.equal(lateSchema2.perf.models[0].n, 1);
      assert.equal(lateSchema2.perf.models[0].averageTps, 2);
      assert.deepEqual(lateSchema2.totals, initial.totals);

      assert.equal(importTimings(store, homeId, [timing("late")]).changed, true);
      await store.sync();
      const after = await store.summarize(FILTERS);
      assert.equal(after.perf.models[0].n, 2);
      assert.equal(after.perf.models[0].averageTps, 2);
      assert.deepEqual(after.totals, initial.totals);

      const memory = summarizeUsage(
        await buildUsageReport({
          ...options,
          lookupRequestTiming: (query) => store.lookupRequestTiming(query),
        }),
        FILTERS,
      );
      assert.deepEqual(memory.perf.models, after.perf.models);
      await store.sync();
      assert.deepEqual((await store.summarize(FILTERS)).perf.models, after.perf.models);
    } finally {
      store.close();
    }

    const reopened = new UsageStore(options);
    try {
      await reopened.sync();
      const afterReopen = await reopened.summarize(FILTERS);
      assert.equal(afterReopen.perf.models[0].n, 2);
      assert.equal(afterReopen.perf.models[0].averageTps, 2);
    } finally {
      reopened.close();
    }
    assert.ok((await readFile(file, "utf8")).includes("generation_timing"));
  });
});

test("source drift retains published explicit timing while fresh memory reads stay isolated", async () => {
  await fixture(async ({ root, home, file }) => {
    const options = storeOptions(root, home);
    await writeFile(file, lines([...headers, row("completed", null), row("untimed", null)]));
    const store = new UsageStore(options);
    try {
      await store.sync();
      const homeId = store.homes.find((item) => item.path === home).id;
      assert.equal(importTimings(store, homeId, [timing("completed")]).changed, true);
      await store.sync();
      const before = await store.summarize(FILTERS);
      assert.equal(before.perf.models[0].n, 1);
      assert.equal(before.perf.models[0].averageTps, 2);

      const warnings = [{ sourceKind: "codex", homeId, code: "LIVE_SOURCE_CHANGED", count: 1 }];
      const policy = JSON.stringify({ revision: 2, partialHomes: [{ homeId, blockedThreadIds: ["thread"] }] });
      store.writeMeta("perf_state", "degraded");
      store.writeMeta("perf_degraded_home_ids", JSON.stringify([homeId]));
      store.writeMeta("perf_codex_publication_policy", policy);
      store.writeMeta("perf_source_warnings", JSON.stringify(warnings));
      const during = await store.summarize(FILTERS);
      assert.equal(during.perf.models[0].n, 1);
      assert.equal(during.perf.models[0].averageTps, 2);
      assert.deepEqual(during.totals, before.totals);

      const report = await buildUsageReport({
        ...options,
        lookupRequestTiming: (query) => store.lookupRequestTiming(query),
      });
      assert.deepEqual(summarizeUsage(report, FILTERS).perf.models, during.perf.models);
      Object.assign(report.perfMeta, {
        state: "degraded",
        degradedHomeIds: [homeId],
        codexPublicationPolicy: policy,
        sourceWarnings: warnings,
      });
      assert.equal(summarizeUsage(report, FILTERS).perf.models.length, 0);

      store.writeMeta(
        "perf_source_warnings",
        JSON.stringify([...warnings, { sourceKind: "codex", homeId, code: "READ_ONLY_OPEN_FAILED", count: 1 }]),
      );
      store.writeMeta("perf_codex_publication_policy", JSON.stringify({ revision: 2, partialHomes: [] }));
      assert.equal((await store.summarize(FILTERS)).perf.models.length, 0);
    } finally {
      store.close();
    }
  });
});
