import assert from "node:assert/strict";
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { PERF_METHOD_VERSION } from "../src/perf-stats.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

const EVENT_AUTHORITY_KEY = "history_archive_event_authority";
const PERF_AUTHORITY_KEY = "history_archive_perf_authority";
const HOT_START_MS = Date.parse("2026-10-04T12:00:00.000Z");

function manifestPathFor(databaseFile) {
  const parsed = path.parse(databaseFile);
  return path.join(parsed.dir, `${parsed.name}.manifest.json`);
}

function writeMeta(database, key, value) {
  database
    .prepare(
      `INSERT INTO store_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, JSON.stringify(value));
}

function setArchivePath(databaseFile, segmentId, databasePath) {
  const writer = new DatabaseSync(databaseFile);
  try {
    writer.exec("BEGIN IMMEDIATE");
    try {
      const changed = writer
        .prepare("UPDATE archive_segments SET database_path = ? WHERE segment_id = ?")
        .run(databasePath, segmentId);
      assert.equal(Number(changed.changes), 1);
      writer.exec("COMMIT");
    } catch (error) {
      writer.exec("ROLLBACK");
      throw error;
    }
  } finally {
    writer.close();
  }

  const reader = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    assert.equal(
      String(
        reader.prepare("SELECT database_path FROM archive_segments WHERE segment_id = ?").get(segmentId).database_path,
      ),
      databasePath,
    );
  } finally {
    reader.close();
  }
}

function stablePerfEvidence(perf) {
  const evidence = structuredClone(perf);
  evidence.indexedAt = null;
  evidence.meta.indexedAt = null;
  return evidence;
}

test("summarizeHistory pins the captured perf carrier record across cold event reads", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const homeDir = fixture.serverOptions.homeDir;
  const archivedFile = path.join(homeDir, "cold-perf-carrier-archived.sqlite");
  const oracleFile = path.join(homeDir, "cold-perf-carrier-oracle.sqlite");
  const candidateFile = path.join(homeDir, "cold-perf-carrier-candidate.sqlite");
  const missingFile = path.join(homeDir, "cold-perf-carrier-missing.sqlite");
  const archivedOptions = { ...fixture.serverOptions, databaseFile: archivedFile };
  const oracleOptions = {
    ...fixture.serverOptions,
    databaseFile: oracleFile,
    importStoreFile: path.join(homeDir, "cold-perf-carrier-oracle-imports.json"),
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
    const registered = await archived.registerHistoryArchiveCandidate(candidateFile);
    const coldSample = archived
      .perfCandidatesForRange({ startMs: coldStartMs, endMs: HOT_START_MS - 1 })
      .find((sample) => sample.status === "completed" && sample.outputTokens > 0 && sample.durationMs > 0);
    assert.ok(coldSample, "fixture must expose a computable cold ZCode perf sample");
    assert.equal(coldSample.sourceKind, "zcode");
    assert.equal(coldSample.methodVersion, PERF_METHOD_VERSION);

    archived.database.exec("BEGIN IMMEDIATE");
    try {
      writeMeta(archived.database, EVENT_AUTHORITY_KEY, {
        formatVersion: 1,
        segmentIds: [registered.segmentId],
      });
      writeMeta(archived.database, PERF_AUTHORITY_KEY, {
        formatVersion: 1,
        segments: [
          {
            segmentId: registered.segmentId,
            databaseSha256: registered.databaseSha256,
            sourceKinds: ["zcode"],
            methodVersions: [PERF_METHOD_VERSION],
          },
        ],
      });
      archived.database.prepare("DELETE FROM events WHERE timestamp_ms < ?").run(HOT_START_MS);
      const deleted = archived.database
        .prepare("DELETE FROM perf_samples WHERE sample_key = ?")
        .run(coldSample.sampleKey);
      assert.equal(Number(deleted.changes), 1, "test must evict one cold perf sample");
      archived.database.exec("COMMIT");
    } catch (error) {
      archived.database.exec("ROLLBACK");
      throw error;
    }

    const filters = { preset: "all", now: "2026-10-04T13:00:00.000Z", calendarZone: "utc" };
    const oracleSummary = await oracle.summarizeHistory(filters);
    const originalReadSnapshot = archived.readHistoryArchiveSnapshot.bind(archived);
    let injected = false;
    archived.readHistoryArchiveSnapshot = async (record) => {
      if (!injected) {
        injected = true;
        assert.equal(path.resolve(String(record.database_path)), path.resolve(candidateFile));
        assert.equal(String(record.segment_id), registered.segmentId);
        copyFileSync(manifestPathFor(candidateFile), manifestPathFor(missingFile));
        setArchivePath(archivedFile, registered.segmentId, missingFile);
        assert.equal(existsSync(missingFile), false);
        assert.equal(existsSync(candidateFile), true);
      }
      return originalReadSnapshot(record);
    };

    let first;
    try {
      first = await archived.summarizeHistory(filters);
    } finally {
      archived.readHistoryArchiveSnapshot = originalReadSnapshot;
    }
    assert.equal(injected, true);
    assert.deepEqual(
      stablePerfEvidence(first.perf),
      stablePerfEvidence(oracleSummary.perf),
      "the first call must use its captured candidate record",
    );

    await assert.rejects(archived.summarizeHistory(filters), (error) => {
      assert.equal(error.code, "ENOENT");
      return true;
    });

    setArchivePath(archivedFile, registered.segmentId, candidateFile);
    const recovered = await archived.summarizeHistory(filters);
    assert.deepEqual(
      stablePerfEvidence(recovered.perf),
      stablePerfEvidence(oracleSummary.perf),
      "the same store must recover after registry restoration",
    );
  } finally {
    archived.close();
    oracle.close();
    fixture.close();
  }
});
