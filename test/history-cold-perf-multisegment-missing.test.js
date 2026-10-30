import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

const HISTORICAL_METHOD_VERSION = "tps-v5";
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

test("summarizeHistory fails wholly when a later authorized perf segment disappears", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const homeDir = fixture.serverOptions.homeDir;
  const archivedFile = path.join(homeDir, "cold-perf-multisegment-missing-archived.sqlite");
  const oracleFile = path.join(homeDir, "cold-perf-multisegment-missing-oracle.sqlite");
  const smallCandidateFile = path.join(homeDir, "cold-perf-multisegment-missing-small.sqlite");
  const rankedCandidateFile = path.join(homeDir, "cold-perf-multisegment-missing-ranked.sqlite");
  const movedRankedFile = `${rankedCandidateFile}.moved`;
  const archivedOptions = { ...fixture.serverOptions, databaseFile: archivedFile };
  const oracleOptions = {
    ...fixture.serverOptions,
    databaseFile: oracleFile,
    importStoreFile: path.join(homeDir, "cold-perf-multisegment-missing-oracle-imports.json"),
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
    const smallSegment = await archived.registerHistoryArchiveCandidate(smallCandidateFile);
    const rankedSegment = await archived.registerHistoryArchiveCandidate(rankedCandidateFile);
    const smallDigest = fileSha256(smallCandidateFile);
    const rankedDigest = fileSha256(rankedCandidateFile);

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
    assert.equal(smallSample.methodVersion, HISTORICAL_METHOD_VERSION);
    assert.equal(rankedSample.methodVersion, HISTORICAL_METHOD_VERSION);
    for (const sample of [smallSample, rankedSample]) {
      assert.equal(sample.timingKind, "generation");
      assert.equal(sample.tokenScope, "non_reasoning_output");
      assert.equal(sample.timingSource, "unknown");
    }

    const eventCount = Number(
      archived.database
        .prepare("SELECT COUNT(*) AS count FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ?")
        .get(coldStartMs, coldEndMs).count,
    );
    const segments = [smallSegment, rankedSegment].map((segment) => ({
      segmentId: segment.segmentId,
      databaseSha256: segment.databaseSha256,
      sourceKinds: ["zcode"],
      methodVersions: [HISTORICAL_METHOD_VERSION],
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

    const originalReadSnapshot = archived.readHistoryArchiveSnapshot.bind(archived);
    let rankedSnapshotRead = false;
    archived.readHistoryArchiveSnapshot = async (record) => {
      const snapshot = await originalReadSnapshot(record);
      if (String(record.segment_id) === rankedSegment.segmentId) {
        rankedSnapshotRead = true;
        renameSync(rankedCandidateFile, movedRankedFile);
      }
      return snapshot;
    };
    try {
      await assert.rejects(archived.summarizeHistory(filters), (error) => {
        assert.equal(error.code, "ENOENT");
        return true;
      });
      assert.equal(rankedSnapshotRead, true, "the second perf segment must be removed after its event read");
      assert.equal(existsSync(rankedCandidateFile), false);
      assert.equal(existsSync(movedRankedFile), true);
    } finally {
      archived.readHistoryArchiveSnapshot = originalReadSnapshot;
      if (existsSync(movedRankedFile)) renameSync(movedRankedFile, rankedCandidateFile);
    }

    assert.equal(fileSha256(smallCandidateFile), smallDigest, "first segment must remain byte-identical");
    assert.equal(fileSha256(rankedCandidateFile), rankedDigest, "restored second segment must remain byte-identical");

    const recovered = await archived.summarizeHistory(filters);
    assert.deepEqual(
      stablePerfEvidence(recovered.perf),
      stablePerfEvidence(oracleSummary.perf),
      "the same store must recover with complete perf after the segment is restored",
    );
    assert.equal(
      fileSha256(smallCandidateFile),
      smallDigest,
      "first segment must remain byte-identical after recovery",
    );
    assert.equal(
      fileSha256(rankedCandidateFile),
      rankedDigest,
      "second segment must remain byte-identical after recovery",
    );
  } finally {
    archived.close();
    oracle.close();
    fixture.close();
  }
});
