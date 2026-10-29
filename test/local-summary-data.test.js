import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  codexSampleThreadId,
  createCodexProjectionCache,
  createCodexPublishFilter,
  rankedCodexHomeIds,
} from "../src/perf-sources/codex-thread.js";
import { normalizePerfSample, selectPerfSamples, summarizePerf } from "../src/perf-stats.js";
import { UsageStore, createPersistentCodexProjectionCache } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const UNIQUE_ITERABLE = Symbol.for("codex-usage.perf.unique-iterable.v1");
const T = 1_760_000_000_000;
const RANGE = { startMs: T - 100, endMs: T + 1_000 };

function sample(overrides = {}) {
  const normalized = normalizePerfSample({
    sourceKind: "zcode",
    homeId: "home-z",
    identity: ["default"],
    status: "completed",
    tsMs: T,
    channel: "main",
    agentKind: "main",
    agent: "",
    model: "model-z",
    modelProvider: "",
    reasoningEffort: "",
    window: "request",
    timingKind: "generation",
    tokenScope: "non_reasoning_output",
    durationMs: 2_000,
    outputTokens: 1_000,
    ...overrides,
  });
  assert.equal(normalized.warningCode, null, `fixture sample must normalize cleanly: ${normalized.warningCode}`);
  return normalized.sample;
}

function* iterableOf(entries) {
  yield* entries;
}

function markedUnique(entries) {
  const iterator = iterableOf(entries);
  Object.defineProperty(iterator, UNIQUE_ITERABLE, { value: true });
  return iterator;
}

function summaryOptions() {
  return {
    range: RANGE,
    excludedHomeIds: ["home-excluded"],
    knownSources: [
      { kind: "zcode", homeId: "home-z" },
      { kind: "zcode", homeId: "home-excluded" },
    ],
  };
}

test("iterable summaries match arrays while public selection stays array-only", () => {
  const samples = [
    sample({ identity: ["a"], tsMs: RANGE.startMs }),
    sample({ identity: ["b"], tsMs: RANGE.endMs, durationMs: 1_000, outputTokens: 1_500 }),
    sample({ identity: ["unplaced"], tsMs: null }),
    sample({ identity: ["excluded"], homeId: "home-excluded" }),
    sample({ identity: ["outside"], tsMs: RANGE.endMs + 1 }),
  ];
  const options = summaryOptions();
  const expected = summarizePerf(samples, options);
  const actual = summarizePerf(iterableOf(samples), options);

  assert.deepEqual(actual, expected);
  assert.equal(actual.coverage.eligible, 2);
  assert.equal(actual.coverage.unplaced, 1);
  assert.throws(() => selectPerfSamples(new Set(samples), options), TypeError);
  assert.throws(() => summarizePerf(new Set(samples), { range: "invalid" }), TypeError);
});

test("the unique primary-key marker bypasses duplicate grouping only for iterables", () => {
  const left = sample({ identity: ["duplicate"], model: "model-left" });
  const right = sample({ identity: ["duplicate"], model: "model-right", tsMs: T + 1 });
  const options = summaryOptions();

  const arraySummary = summarizePerf([left, right], options);
  const iterableSummary = summarizePerf(iterableOf([left, right]), options);
  const markedSummary = summarizePerf(markedUnique([left, right]), options);

  assert.deepEqual(iterableSummary, arraySummary);
  assert.equal(arraySummary.coverage.eligible, 1);
  assert.equal(arraySummary.coverage.byFlag.RECORD_CONFLICT, 1);
  assert.equal(markedSummary.coverage.eligible, 2);
  assert.equal(markedSummary.coverage.byFlag.RECORD_CONFLICT, 0);
});

test("compact identities preserve ranked Codex ownership semantics", () => {
  const rows = [
    { sample_key: "legacy-healthy", source_kind: "codex", home_id: "home-healthy" },
    {
      sample_key: JSON.stringify(["codex", "home-partial", "thread-blocked", "turn-a"]),
      source_kind: "codex",
      home_id: "home-partial",
    },
    {
      sample_key: JSON.stringify(["codex", "home-partial", "thread-good", "turn-b"]),
      source_kind: "codex",
      home_id: "home-partial",
    },
    { sample_key: "legacy-partial", source_kind: "codex", home_id: "home-partial" },
    { sample_key: "empty-home", source_kind: "codex", home_id: "" },
    { sample_key: "opencode", source_kind: "opencode", home_id: "home-other" },
    { sample_key: "dsh", source_kind: "dsh", home_id: "home-degraded" },
  ];
  const fakeDatabase = {
    prepare(sql) {
      assert.equal(sql, "SELECT sample_key, source_kind, home_id FROM perf_samples");
      return { iterate: () => rows[Symbol.iterator]() };
    },
  };
  const compact = UsageStore.prototype.perfSampleIdentities.call({ database: fakeDatabase }, true);
  const degradedHomeIds = ["home-partial", "home-degraded"];
  const partialHomes = [{ homeId: "home-partial", blockedThreadIds: ["thread-blocked"] }];
  const publicationFilter = createCodexPublishFilter(degradedHomeIds, partialHomes);
  const legacyIdentities = rows.map((row) => ({
    sampleKey: String(row.sample_key),
    sourceKind: String(row.source_kind),
    homeId: String(row.home_id),
  }));
  const legacyHomeIds = [
    ...new Set([
      ...rankedCodexHomeIds(publicationFilter, legacyIdentities),
      ...legacyIdentities
        .filter((entry) => entry.sourceKind !== "codex")
        .filter((entry) => !degradedHomeIds.includes(entry.homeId))
        .map((entry) => entry.homeId)
        .filter(Boolean),
    ]),
  ].sort();

  const compactHomeIds = new Set();
  for (const [homeId, threadIds] of compact.codexThreadsByHome) {
    for (const threadId of threadIds) {
      if (!publicationFilter.threadAllowed(homeId, threadId)) continue;
      compactHomeIds.add(homeId);
      break;
    }
  }
  for (const homeId of compact.otherHomeIds) {
    if (homeId && !degradedHomeIds.includes(homeId)) compactHomeIds.add(homeId);
  }

  assert.deepEqual([...compactHomeIds].sort(), legacyHomeIds);
  assert.deepEqual([...compactHomeIds].sort(), ["home-healthy", "home-other", "home-partial"]);
  assert.equal(compact.codexThreadsByHome.get("home-healthy").has(null), true);
  assert.equal(compact.codexThreadsByHome.get("home-partial").has(null), true);
  assert.equal(compact.codexThreadsByHome.has(""), false);
  assert.equal(codexSampleThreadId(legacyIdentities[0]), null);
});

test("transient projection staging skips the memory cache and invalidates one path", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE perf_codex_projections (
        path TEXT PRIMARY KEY,
        home_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        method_version TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        projection TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    const inner = createCodexProjectionCache();
    const cache = createPersistentCodexProjectionCache({
      database,
      inner,
      methodVersion: inner.stats().methodVersion,
    });
    const filePath = path.join(tmpdir(), "fixture-rollout.jsonl");
    const projection = { records: [{ kind: "session_meta", threadId: "thread-a" }] };
    const args = {
      homeId: "home-a",
      kind: "codex",
      filePath,
      fingerprints: { [filePath]: "fingerprint-a" },
      projection,
      methodVersion: inner.stats().methodVersion,
      transient: true,
    };

    assert.equal(cache.stage(args), true);
    assert.equal(inner.stats().stagedEntries, 0);
    cache.commit(args.homeId);
    assert.deepEqual(cache.lookup(args), projection);
    assert.equal(inner.stats().entries, 0);
    assert.equal(inner.stats().stagedEntries, 0);
    assert.equal(cache.invalidate({ filePath }), true);
    assert.equal(
      database.prepare("SELECT projection FROM perf_codex_projections WHERE path = ?").get(filePath),
      undefined,
    );
  } finally {
    database.close();
  }
});

test("cold and streaming perf carriers keep their public array and one-shot iterable contracts", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.open();
    await store.sync({ options: fixture.reportOptions });

    const cold = store.capturePerfCarrier();
    assert.equal(Array.isArray(cold.samples), true);

    const streamed = store.capturePerfCarrier({ streamSamples: true });
    assert.equal(Array.isArray(streamed.samples), false);
    assert.equal(typeof streamed.samples.next, "function");
    assert.equal(streamed.samples[UNIQUE_ITERABLE], true);

    assert.deepEqual([...streamed.samples], cold.samples);
    assert.deepEqual([...streamed.samples], []);
  } finally {
    store.close();
    fixture.close();
  }
});

test("bulk publication reuses insert, dependency and delete statements", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.open();
    const counts = { samples: 0, dependencies: 0, deletes: 0 };
    const prepare = store.database.prepare.bind(store.database);
    store.database.prepare = (sql) => {
      if (sql.startsWith("INSERT INTO perf_samples (")) counts.samples += 1;
      if (sql.startsWith("INSERT INTO perf_sample_sources (")) counts.dependencies += 1;
      if (sql === "DELETE FROM perf_samples WHERE sample_key = ?") counts.deletes += 1;
      return prepare(sql);
    };

    await store.sync({ options: fixture.reportOptions });
    assert.deepEqual(counts, { samples: 1, dependencies: 1, deletes: 1 });

    for (const file of fixture.rolloutFiles) {
      appendFileSync(
        file,
        `${JSON.stringify({
          type: "turn_context",
          payload: {
            thread_id: "fixture-codex-thread",
            turn_id: "turn-01",
            model: "codex-fixture-model",
            effort: "high",
          },
        })}\n`,
      );
    }
    counts.samples = 0;
    counts.dependencies = 0;
    counts.deletes = 0;

    await store.sync({ options: fixture.reportOptions });
    assert.deepEqual(counts, { samples: 1, dependencies: 1, deletes: 1 });
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE source_kind = 'codex'").get().count,
      26,
    );
  } finally {
    store.close();
    fixture.close();
  }
});
