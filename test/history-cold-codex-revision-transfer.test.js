import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createHistoryArchiveCandidate,
  loadHistoryArchiveImport,
  publishHistoryArchiveBundle,
  publishHistoryArchiveImport,
} from "../src/history-archive.js";
import { PERF_METHOD_VERSION } from "../src/perf-stats.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const COLD_END_MS = Date.parse("2026-10-04T12:02:00.000Z");
const EVENT_AUTHORITY_KEY = "history_archive_event_authority";
const PERF_AUTHORITY_KEY = "history_archive_perf_authority";
const PERF_REVISIONS_KEY = "history_archive_perf_revisions";
const FILTERS = { preset: "all", now: "2026-10-04T13:00:00.000Z", calendarZone: "utc" };

function fileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function writeMeta(database, key, value) {
  database
    .prepare(
      `INSERT INTO store_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, JSON.stringify(value));
}

function stablePerfEvidence(perf) {
  const evidence = structuredClone(perf);
  evidence.indexedAt = null;
  evidence.meta.indexedAt = null;
  return evidence;
}

function codexRequestFacts(database) {
  const rows = database
    .prepare("SELECT key, value FROM store_meta WHERE key GLOB 'history_archive_codex_*_v1' ORDER BY key")
    .all()
    .map((row) => ({ key: String(row.key), value: String(row.value) }));
  assert.equal(rows.length, 1, "the candidate must expose one minimal Codex request-facts component");
  return rows[0];
}

function perfRecoveryRows(database) {
  return database
    .prepare(
      `SELECT fact_table, source_path, payload_digest, occurrence_count, payload, recorded_at
       FROM history_replaced_facts
       WHERE fact_table IN ('perf_samples', 'perf_sample_sources')
       ORDER BY fact_table, source_path, payload_digest`,
    )
    .all()
    .map((row) => ({ ...row }));
}

function codexHomeId(store, codexHome) {
  const home = store.homes.find((candidate) => path.resolve(candidate.path) === path.resolve(codexHome));
  assert.ok(home, "fixture must discover the Codex home");
  return String(home.id);
}

test("an evicted Codex sample revision survives complete bundle import and reopen after source removal", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const sourceRoot = fixture.serverOptions.homeDir;
  const importRoot = mkdtempSync(path.join(tmpdir(), "cold-codex-revision-transfer-"));
  const candidateFile = path.join(sourceRoot, "cold-codex-revision-transfer-candidate.sqlite");
  const candidateManifest = path.join(sourceRoot, "cold-codex-revision-transfer-candidate.manifest.json");
  const bundleDirectory = path.join(sourceRoot, "published");
  const importDirectory = path.join(importRoot, "imported");
  let archived;
  let oracle;
  let runtime;
  try {
    archived = new UsageStore({
      ...fixture.serverOptions,
      databaseFile: path.join(sourceRoot, "cold-codex-revision-transfer-archived.sqlite"),
    });
    oracle = new UsageStore({
      ...fixture.serverOptions,
      databaseFile: path.join(sourceRoot, "cold-codex-revision-transfer-oracle.sqlite"),
    });
    await archived.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(archived);
    await oracle.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(oracle);

    const coldStartMs = Number(archived.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    const coldSample = archived
      .perfCandidatesForRange({ startMs: coldStartMs, endMs: COLD_END_MS })
      .find((sample) => sample.status === "completed" && sample.outputTokens > 0 && sample.durationMs > 0);
    assert.ok(coldSample, "fixture must expose a computable cold Codex perf sample");
    const [, , , turnId] = JSON.parse(coldSample.sampleKey);
    const turnNumber = Number(/^turn-(\d+)$/.exec(String(turnId))?.[1]);
    assert.ok(Number.isSafeInteger(turnNumber));
    const responseId = `response-${turnNumber}-1`;
    const baseTiming = fixture.timingRecords.find((record) => record.responseId === responseId);
    assert.ok(baseTiming, "the selected cold sample must have native timing evidence");

    await createHistoryArchiveCandidate(archived.database, candidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });
    const candidateDigest = fileSha256(candidateFile);
    const candidateDatabase = new DatabaseSync(candidateFile, { readOnly: true });
    let candidateRequestFacts;
    try {
      candidateRequestFacts = codexRequestFacts(candidateDatabase);
    } finally {
      candidateDatabase.close();
    }
    const registered = await archived.registerHistoryArchiveCandidate(candidateFile);
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
            sourceKinds: ["codex"],
            methodVersions: [PERF_METHOD_VERSION],
          },
        ],
      });
      archived.database.prepare("DELETE FROM events WHERE timestamp_ms < ?").run(COLD_END_MS);
      assert.equal(
        Number(
          archived.database.prepare("DELETE FROM perf_samples WHERE sample_key = ?").run(coldSample.sampleKey).changes,
        ),
        1,
      );
      archived.database.exec("COMMIT");
    } catch (error) {
      archived.database.exec("ROLLBACK");
      throw error;
    }

    const lateTiming = { ...baseTiming, durationMs: baseTiming.durationMs + 500 };
    const archivedTimingImport = archived.importRequestTimingEvidence({
      homeId: codexHomeId(archived, fixture.codexHome),
      records: [lateTiming],
      reviewedOrigins: [lateTiming.evidenceOrigin],
    });
    oracle.importRequestTimingEvidence({
      homeId: codexHomeId(oracle, fixture.codexHome),
      records: [lateTiming],
      reviewedOrigins: [lateTiming.evidenceOrigin],
    });
    await archived.sync({ options: fixture.reportOptions });
    await oracle.sync({ options: fixture.reportOptions });

    const oracleSummary = await oracle.summarizeHistory(FILTERS);
    const oraclePerf = stablePerfEvidence(oracleSummary.perf);
    const oracleEvents = await oracle.publishedHistoryUsageEvents();
    assert.deepEqual(await archived.publishedHistoryUsageEvents(), oracleEvents);
    const revisedSummary = await archived.summarizeHistory(FILTERS);
    assert.deepEqual(revisedSummary.totals, oracleSummary.totals);
    assert.deepEqual(revisedSummary.costEstimate, oracleSummary.costEstimate);
    const revisionMetadata = archived.readMetaRaw(PERF_REVISIONS_KEY);
    assert.equal(typeof revisionMetadata, "string");
    const revisionFactTables = new Set(JSON.parse(revisionMetadata).revisions.map((entry) => entry.factTable));
    assert.ok(revisionFactTables.has("perf_request_timing_evidence"));
    assert.ok(revisionFactTables.has("perf_samples"));
    const recoveryRows = perfRecoveryRows(archived.database);
    assert.ok(recoveryRows.length > 0, "the late revision must retain recovery facts");
    assert.equal(fileSha256(candidateFile), candidateDigest);

    await publishHistoryArchiveBundle(archived.database, bundleDirectory);
    await publishHistoryArchiveImport(bundleDirectory, importDirectory);
    archived.close();
    archived = undefined;
    oracle.close();
    oracle = undefined;
    fixture.close();
    assert.equal(existsSync(sourceRoot), false);
    assert.equal(existsSync(candidateFile), false);
    assert.equal(existsSync(candidateManifest), false);

    const loaded = await loadHistoryArchiveImport(importDirectory);
    runtime = new UsageStore({
      homeDir: importRoot,
      env: {},
      importDirs: [],
      automaticDiscoveryEnabled: false,
      databaseFile: loaded.runtimeFile,
    });
    await runtime.open();
    const segment = runtime.database
      .prepare("SELECT database_path, database_sha256 FROM archive_segments WHERE segment_id = ?")
      .get(registered.segmentId);
    assert.ok(segment);
    const segmentFile = String(segment.database_path);
    assert.equal(String(segment.database_sha256), candidateDigest);
    assert.equal(fileSha256(segmentFile), candidateDigest);

    const segmentDatabase = new DatabaseSync(segmentFile, { readOnly: true });
    try {
      assert.deepEqual(codexRequestFacts(segmentDatabase), candidateRequestFacts);
    } finally {
      segmentDatabase.close();
    }
    assert.deepEqual(
      {
        importChanged: archivedTimingImport.changed,
        revisionMetadata: runtime.readMetaRaw(PERF_REVISIONS_KEY),
        recoveryRows: perfRecoveryRows(runtime.database),
        perf: stablePerfEvidence((await runtime.summarizeHistory(FILTERS)).perf),
      },
      {
        importChanged: true,
        revisionMetadata,
        recoveryRows,
        perf: oraclePerf,
      },
      "the imported runtime must preserve the typed revision, recovery facts, and unarchived perf oracle",
    );
    const runtimeOptions = {
      homeDir: importRoot,
      env: {},
      importDirs: [],
      automaticDiscoveryEnabled: false,
      databaseFile: loaded.runtimeFile,
    };
    for (let reopen = 0; reopen < 2; reopen += 1) {
      if (reopen) {
        runtime.close();
        runtime = new UsageStore(runtimeOptions);
        await runtime.open();
      }
      const importedSummary = await runtime.summarizeHistory(FILTERS);
      assert.deepEqual(await runtime.publishedHistoryUsageEvents(), oracleEvents);
      assert.deepEqual(importedSummary.totals, oracleSummary.totals);
      assert.deepEqual(importedSummary.costEstimate, oracleSummary.costEstimate);
      assert.deepEqual(stablePerfEvidence(importedSummary.perf), oraclePerf);
      assert.deepEqual(perfRecoveryRows(runtime.database), recoveryRows);
      assert.equal(runtime.readMetaRaw(PERF_REVISIONS_KEY), revisionMetadata);
    }
  } finally {
    runtime?.close();
    archived?.close();
    oracle?.close();
    fixture.close();
    rmSync(importRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
