import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate, verifyHistoryArchiveCandidate } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

const HISTORICAL_METHOD_VERSION = "tps-v5";
const EVENT_AUTHORITY_KEY = "history_archive_event_authority";
const PERF_AUTHORITY_KEY = "history_archive_perf_authority";
const PERF_COMPONENT_KEYS = [
  "history_archive_perf_sources_v1",
  "history_archive_perf_samples_v1",
  "history_archive_perf_index_v1",
  "history_archive_perf_timing_v1",
];
const HOT_START_MS = Date.parse("2026-10-04T12:00:00.000Z");

function writeMeta(database, key, value) {
  database
    .prepare(
      `INSERT INTO store_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, JSON.stringify(value));
}

function stablePublicEvidence(summary, report) {
  return {
    events: report.events,
    totals: summary.totals,
    costEstimate: summary.costEstimate,
    perf: structuredClone(summary.perf),
  };
}

test("explicit cold perf authority keeps an evicted ZCode sample in summarizeHistory", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const homeDir = fixture.serverOptions.homeDir;
  const archivedFile = path.join(homeDir, "cold-perf-authority-archived.sqlite");
  const oracleFile = path.join(homeDir, "cold-perf-authority-oracle.sqlite");
  const candidateFile = path.join(homeDir, "cold-perf-authority-candidate.sqlite");
  const archivedOptions = { ...fixture.serverOptions, databaseFile: archivedFile };
  const oracleOptions = {
    ...fixture.serverOptions,
    databaseFile: oracleFile,
    importStoreFile: path.join(homeDir, "cold-perf-authority-oracle-imports.json"),
  };
  const archived = new UsageStore(archivedOptions);
  const oracle = new UsageStore(oracleOptions);
  try {
    await archived.sync({ options: archivedOptions });
    await oracle.sync({ options: oracleOptions });

    const coldStartMs = Number(archived.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    await createHistoryArchiveCandidate(archived.database, candidateFile, {
      startMs: coldStartMs,
      endMs: HOT_START_MS,
    });

    const verified = await verifyHistoryArchiveCandidate(candidateFile);
    assert.equal(verified.ok, true);
    let candidateColdSampleKeys;
    const candidate = new DatabaseSync(candidateFile, { readOnly: true });
    try {
      const keys = candidate
        .prepare(
          `SELECT key FROM store_meta
           WHERE key IN (?, ?, ?, ?) ORDER BY key`,
        )
        .all(...PERF_COMPONENT_KEYS)
        .map((row) => String(row.key));
      assert.deepEqual(keys, [...PERF_COMPONENT_KEYS].sort(), "candidate must expose all verified perf components");
      candidateColdSampleKeys = candidate
        .prepare(`SELECT sample_key FROM perf_samples WHERE ts_ms >= ? AND ts_ms < ? ORDER BY sample_key`)
        .all(coldStartMs, HOT_START_MS)
        .map((row) => String(row.sample_key));
    } finally {
      candidate.close();
    }

    const registered = await archived.registerHistoryArchiveCandidate(candidateFile);
    const coldSamples = archived
      .perfCandidatesForRange({ startMs: coldStartMs, endMs: HOT_START_MS - 1 })
      .sort((left, right) => left.tsMs - right.tsMs || left.sampleKey.localeCompare(right.sampleKey));
    const coldSample = coldSamples.find(
      (sample) =>
        sample.status === "completed" &&
        sample.outputTokens === null &&
        sample.durationMs === null &&
        sample.requestCount === 1,
    );
    assert.ok(coldSample, "fixture must expose a cold ZCode candidate with missing generation timing");
    assert.equal(coldSample.sourceKind, "zcode");
    assert.equal(coldSample.methodVersion, HISTORICAL_METHOD_VERSION);
    assert.equal(coldSample.timingKind, "generation");
    assert.equal(coldSample.tokenScope, "non_reasoning_output");
    assert.equal(coldSample.timingSource, "unknown");
    assert.deepEqual([...new Set(coldSamples.map((sample) => sample.sourceKind))], ["zcode"]);
    assert.deepEqual([...new Set(coldSamples.map((sample) => sample.methodVersion))], [HISTORICAL_METHOD_VERSION]);

    const hotSamplesBefore = archived.perfCandidatesForRange({
      startMs: HOT_START_MS,
      endMs: Number.MAX_SAFE_INTEGER,
    });
    const unplacedSamplesBefore = archived.unplacedPerfSamples();
    assert.ok(hotSamplesBefore.length > 0, "fixture must contain hot perf samples");
    assert.ok(unplacedSamplesBefore.length > 0, "fixture must contain unplaced perf samples");

    const perfAuthority = {
      formatVersion: 1,
      segments: [
        {
          segmentId: registered.segmentId,
          databaseSha256: registered.databaseSha256,
          sourceKinds: ["zcode"],
          methodVersions: [HISTORICAL_METHOD_VERSION],
        },
      ],
    };
    archived.database.exec("BEGIN IMMEDIATE");
    try {
      writeMeta(archived.database, EVENT_AUTHORITY_KEY, {
        formatVersion: 1,
        segmentIds: [registered.segmentId],
      });
      writeMeta(archived.database, PERF_AUTHORITY_KEY, perfAuthority);
      archived.database.prepare("DELETE FROM events WHERE timestamp_ms < ?").run(HOT_START_MS);
      archived.database.exec("COMMIT");
    } catch (error) {
      archived.database.exec("ROLLBACK");
      throw error;
    }
    assert.equal(
      Number(
        archived.database
          .prepare("SELECT COUNT(*) AS count FROM archive_segments WHERE segment_id = ?")
          .get(registered.segmentId).count,
      ),
      1,
      "perf authority requires the same registered segment",
    );
    assert.deepEqual(
      JSON.parse(archived.database.prepare("SELECT value FROM store_meta WHERE key = ?").get(PERF_AUTHORITY_KEY).value),
      perfAuthority,
    );

    const deleted = archived.database
      .prepare("DELETE FROM perf_samples WHERE sample_key = ?")
      .run(coldSample.sampleKey);
    assert.equal(Number(deleted.changes), 1, "test must remove exactly one cold perf sample");
    assert.ok(candidateColdSampleKeys.includes(coldSample.sampleKey));
    const overlappingColdSampleKeys = coldSamples
      .map((sample) => sample.sampleKey)
      .filter((sampleKey) => sampleKey !== coldSample.sampleKey);
    assert.ok(overlappingColdSampleKeys.length > 0, "candidate and live perf must overlap for a deduplication check");
    assert.deepEqual(
      archived
        .perfCandidatesForRange({ startMs: coldStartMs, endMs: HOT_START_MS - 1 })
        .map((sample) => sample.sampleKey)
        .sort(),
      [...overlappingColdSampleKeys].sort(),
      "the eviction must leave overlapping cold samples in the live carrier",
    );
    assert.deepEqual(
      archived.perfCandidatesForRange({ startMs: HOT_START_MS, endMs: Number.MAX_SAFE_INTEGER }),
      hotSamplesBefore,
      "cold sample eviction must leave hot perf rows unchanged",
    );
    assert.deepEqual(
      archived.unplacedPerfSamples(),
      unplacedSamplesBefore,
      "cold sample eviction must leave unplaced perf rows unchanged",
    );

    const filters = { preset: "all", now: "2026-10-04T13:00:00.000Z", calendarZone: "utc" };
    const oracleReport = await oracle.publishedHistoryUsageReport();
    const oracleSummary = await oracle.summarizeHistory(filters);
    const expected = stablePublicEvidence(oracleSummary, oracleReport);
    expected.perf.indexedAt = null;
    expected.perf.meta.indexedAt = null;

    const archivedReport = await archived.publishedHistoryUsageReport();
    const archivedSummary = await archived.summarizeHistory(filters);
    const actual = stablePublicEvidence(archivedSummary, archivedReport);
    actual.perf.indexedAt = null;
    actual.perf.meta.indexedAt = null;
    assert.deepEqual(actual, expected, "cold authority must preserve the complete public report");

    const noOpOptions = { ...archivedOptions, force: false };
    await archived.sync({ options: noOpOptions });
    const afterNoOpReport = await archived.publishedHistoryUsageReport();
    const afterNoOpSummary = await archived.summarizeHistory(filters);
    const afterNoOp = stablePublicEvidence(afterNoOpSummary, afterNoOpReport);
    afterNoOp.perf.indexedAt = null;
    afterNoOp.perf.meta.indexedAt = null;
    assert.deepEqual(afterNoOp, expected, "a no-op sync must not duplicate or change public history");

    archived.close();
    await archived.open();
    const reopenedReport = await archived.publishedHistoryUsageReport();
    const reopenedSummary = await archived.summarizeHistory(filters);
    const reopened = stablePublicEvidence(reopenedSummary, reopenedReport);
    reopened.perf.indexedAt = null;
    reopened.perf.meta.indexedAt = null;
    assert.deepEqual(reopened, expected, "close/reopen must not duplicate or change public history");
  } finally {
    archived.close();
    oracle.close();
    fixture.close();
  }
});
