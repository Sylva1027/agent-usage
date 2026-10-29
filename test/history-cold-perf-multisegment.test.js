import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { PERF_METHOD_VERSION } from "../src/perf-stats.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

const EVENT_AUTHORITY_KEY = "history_archive_event_authority";
const PERF_AUTHORITY_KEY = "history_archive_perf_authority";
const SEGMENT_BOUNDARY_MS = Date.parse("2026-10-04T12:00:00.000Z");

function writeMeta(database, key, value) {
  database
    .prepare(
      `INSERT INTO store_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, JSON.stringify(value));
}

function fileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function stablePerfEvidence(perf) {
  const evidence = structuredClone(perf);
  evidence.indexedAt = null;
  evidence.meta.indexedAt = null;
  return evidence;
}

test("summarizeHistory merges two explicitly authorized ZCode perf segments", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const homeDir = fixture.serverOptions.homeDir;
  const archivedFile = path.join(homeDir, "cold-perf-multisegment-archived.sqlite");
  const oracleFile = path.join(homeDir, "cold-perf-multisegment-oracle.sqlite");
  const smallCandidateFile = path.join(homeDir, "cold-perf-multisegment-small.sqlite");
  const rankedCandidateFile = path.join(homeDir, "cold-perf-multisegment-ranked.sqlite");
  const archivedOptions = { ...fixture.serverOptions, databaseFile: archivedFile };
  const oracleOptions = {
    ...fixture.serverOptions,
    databaseFile: oracleFile,
    importStoreFile: path.join(homeDir, "cold-perf-multisegment-oracle-imports.json"),
  };
  const archived = new UsageStore(archivedOptions);
  const oracle = new UsageStore(oracleOptions);
  try {
    await archived.sync({ options: archivedOptions });
    await oracle.sync({ options: oracleOptions });
    const filters = { preset: "all", now: "2026-10-04T13:00:00.000Z", calendarZone: "utc" };
    const oracleSummary = await oracle.summarizeHistory(filters);

    const bounds = archived.database
      .prepare("SELECT MIN(timestamp_ms) AS startMs, MAX(timestamp_ms) AS endMs FROM events")
      .get();
    const coldStartMs = Number(bounds.startMs);
    const coldEndMs = Number(bounds.endMs) + 1;
    assert.ok(coldStartMs < SEGMENT_BOUNDARY_MS && SEGMENT_BOUNDARY_MS < coldEndMs);

    await createHistoryArchiveCandidate(archived.database, smallCandidateFile, {
      startMs: coldStartMs,
      endMs: SEGMENT_BOUNDARY_MS,
    });
    await createHistoryArchiveCandidate(archived.database, rankedCandidateFile, {
      startMs: SEGMENT_BOUNDARY_MS,
      endMs: coldEndMs,
    });
    const smallDigest = fileSha256(smallCandidateFile);
    const rankedDigest = fileSha256(rankedCandidateFile);
    const smallSegment = await archived.registerHistoryArchiveCandidate(smallCandidateFile);
    const rankedSegment = await archived.registerHistoryArchiveCandidate(rankedCandidateFile);
    assert.notEqual(smallSegment.segmentId, rankedSegment.segmentId);

    const smallSample = archived
      .perfCandidatesForRange({ startMs: coldStartMs, endMs: SEGMENT_BOUNDARY_MS - 1 })
      .find(
        (sample) =>
          sample.status === "completed" &&
          sample.outputTokens === null &&
          sample.durationMs === null &&
          sample.requestCount === 1,
      );
    const rankedSample = archived
      .perfCandidatesForRange({ startMs: SEGMENT_BOUNDARY_MS, endMs: coldEndMs - 1 })
      .find(
        (sample) =>
          sample.status === "completed" &&
          sample.outputTokens === null &&
          sample.durationMs === null &&
          sample.requestCount === 1,
      );
    assert.ok(smallSample, "fixture must expose a small-model candidate with missing generation timing");
    assert.ok(rankedSample, "fixture must expose a ranked-model candidate with missing generation timing");
    assert.equal(smallSample.sourceKind, "zcode");
    assert.equal(rankedSample.sourceKind, "zcode");
    assert.equal(smallSample.methodVersion, PERF_METHOD_VERSION);
    assert.equal(rankedSample.methodVersion, PERF_METHOD_VERSION);
    for (const sample of [smallSample, rankedSample]) {
      assert.equal(sample.timingKind, "generation");
      assert.equal(sample.tokenScope, "non_reasoning_output");
      assert.equal(sample.timingSource, "unknown");
    }

    const unplacedBefore = archived.unplacedPerfSamples();
    assert.ok(unplacedBefore.length > 0, "fixture must retain an unplaced hot perf sample");
    const eventCount = Number(
      archived.database
        .prepare("SELECT COUNT(*) AS count FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ?")
        .get(coldStartMs, coldEndMs).count,
    );
    const segments = [smallSegment, rankedSegment].map((segment) => ({
      segmentId: segment.segmentId,
      databaseSha256: segment.databaseSha256,
      sourceKinds: ["zcode"],
      methodVersions: [PERF_METHOD_VERSION],
    }));
    archived.database.exec("BEGIN IMMEDIATE");
    try {
      writeMeta(archived.database, EVENT_AUTHORITY_KEY, {
        formatVersion: 1,
        segmentIds: segments.map((segment) => segment.segmentId),
      });
      writeMeta(archived.database, PERF_AUTHORITY_KEY, { formatVersion: 1, segments });
      const deletedEvents = archived.database
        .prepare("DELETE FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ?")
        .run(coldStartMs, coldEndMs);
      assert.equal(Number(deletedEvents.changes), eventCount);
      for (const sample of [smallSample, rankedSample]) {
        const deleted = archived.database
          .prepare("DELETE FROM perf_samples WHERE sample_key = ?")
          .run(sample.sampleKey);
        assert.equal(Number(deleted.changes), 1, `test must evict ${sample.sampleKey} from the live carrier`);
      }
      archived.database.exec("COMMIT");
    } catch (error) {
      archived.database.exec("ROLLBACK");
      throw error;
    }
    assert.deepEqual(archived.unplacedPerfSamples(), unplacedBefore, "eviction must leave unplaced perf hot");

    let summary;
    try {
      summary = await archived.summarizeHistory(filters);
    } finally {
      assert.equal(fileSha256(smallCandidateFile), smallDigest, "small segment must remain byte-identical");
      assert.equal(fileSha256(rankedCandidateFile), rankedDigest, "ranked segment must remain byte-identical");
    }
    assert.deepEqual(
      stablePerfEvidence(summary.perf),
      stablePerfEvidence(oracleSummary.perf),
      "two explicit authority segments must reproduce the complete unarchived perf summary",
    );
  } finally {
    archived.close();
    oracle.close();
    fixture.close();
  }
});
