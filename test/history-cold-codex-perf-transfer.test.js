import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createHistoryArchiveCandidate,
  loadHistoryArchiveImport,
  publishHistoryArchiveBundle,
  publishHistoryArchiveImport,
  verifyHistoryArchiveCandidate,
} from "../src/history-archive.js";
import { PERF_METHOD_VERSION } from "../src/perf-stats.js";
import { PERF_SAMPLE_FIELDS, UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const COLD_END_MS = Date.parse("2026-10-04T12:02:00.000Z");
const EVENT_AUTHORITY_KEY = "history_archive_event_authority";
const PERF_AUTHORITY_KEY = "history_archive_perf_authority";
const PERF_COMPONENT_KEYS = [
  "history_archive_perf_sources_v1",
  "history_archive_perf_samples_v1",
  "history_archive_perf_index_v1",
  "history_archive_perf_timing_v1",
];
const PERF_COLUMNS = PERF_SAMPLE_FIELDS.map((entry) => entry.column);
const FILTERS = { preset: "all", now: "2026-10-04T13:00:00.000Z", calendarZone: "utc" };

function fileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

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

function stablePerfEvidence(perf) {
  const evidence = structuredClone(perf);
  evidence.indexedAt = null;
  evidence.meta.indexedAt = null;
  return evidence;
}

function rawPerfRows(database, where, ...params) {
  return database
    .prepare(`SELECT ${PERF_COLUMNS.join(", ")} FROM perf_samples WHERE ${where} ORDER BY sample_key`)
    .all(...params)
    .map((row) => ({ ...row }));
}

function perfMetaBytes(filePath) {
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    const rows = database
      .prepare(`SELECT key, value FROM store_meta WHERE key IN (${PERF_COMPONENT_KEYS.map(() => "?").join(",")})`)
      .all(...PERF_COMPONENT_KEYS);
    assert.equal(rows.length, PERF_COMPONENT_KEYS.length);
    return Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]));
  } finally {
    database.close();
  }
}

function nativeSampleEvidence(database, sampleKey) {
  const dependencies = database
    .prepare(
      `SELECT source_path, role FROM perf_sample_sources
       WHERE sample_key = ? ORDER BY source_path, role`,
    )
    .all(sampleKey)
    .map((row) => ({ ...row }));
  assert.ok(dependencies.length > 0);

  const owners = database
    .prepare(
      `SELECT DISTINCT owners.home_id, owners.thread_id
       FROM perf_sample_sources AS dependencies
       JOIN perf_rollout_threads AS owners ON owners.source_path = dependencies.source_path
       WHERE dependencies.sample_key = ? ORDER BY owners.home_id, owners.thread_id`,
    )
    .all(sampleKey)
    .map((row) => ({ ...row }));
  assert.equal(owners.length, 1, "the cold sample must have one native owner");

  const [, , threadId, turnId, responseId] = JSON.parse(String(sampleKey));
  assert.equal(typeof turnId, "string", "the cold sample key must retain its native turn");
  assert.equal(typeof responseId, "string", "the v3 cold sample key must retain its native response");
  const timing = database
    .prepare(
      `SELECT links.home_id, links.thread_id, links.response_id,
              evidence.reported_output_tokens, evidence.duration_ms
       FROM perf_request_timing_threads AS links
       JOIN perf_request_timing_evidence AS evidence
         ON evidence.home_id = links.home_id AND evidence.response_id = links.response_id
       WHERE links.home_id = ? AND links.thread_id = ? AND links.response_id = ?`,
    )
    .all(owners[0].home_id, threadId, responseId)
    .map((row) => ({ ...row }));
  assert.equal(timing.length, 1, "the native owner must have one timing record for the cold sample");
  return { dependencies, owners, timing };
}

test("Codex cold perf authority survives complete bundle import after source removal", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const sourceRoot = fixture.serverOptions.homeDir;
  const importRoot = mkdtempSync(path.join(tmpdir(), "cold-codex-perf-transfer-"));
  const candidateFile = path.join(sourceRoot, "cold-codex-perf-transfer-candidate.sqlite");
  const candidateManifest = manifestPathFor(candidateFile);
  const bundleDirectory = path.join(importRoot, "published");
  const importDirectory = path.join(importRoot, "imported");
  let store;
  let runtime;
  try {
    appendFileSync(
      fixture.rolloutFiles[0],
      `${JSON.stringify({
        timestamp: "2026-10-04T12:00:05.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { total_tokens: 100, input_tokens: 80, output_tokens: 20 } },
        },
      })}\n`,
    );
    store = new UsageStore({
      ...fixture.serverOptions,
      databaseFile: path.join(sourceRoot, "cold-codex-perf-transfer.sqlite"),
    });
    await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(store);
    const oraclePerf = stablePerfEvidence((await store.summarizeHistory(FILTERS)).perf);

    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    const coldSample = store
      .perfCandidatesForRange({ startMs: coldStartMs, endMs: COLD_END_MS - 1 })
      .find((sample) => sample.status === "completed" && sample.outputTokens > 0 && sample.durationMs > 0);
    assert.ok(coldSample, "fixture must expose a computable cold Codex perf sample");
    assert.equal(coldSample.sourceKind, "codex");
    assert.equal(coldSample.methodVersion, PERF_METHOD_VERSION);
    const sourceEvidence = nativeSampleEvidence(store.database, coldSample.sampleKey);
    const hotRows = rawPerfRows(store.database, "ts_ms >= ?", COLD_END_MS);
    const unplacedRows = rawPerfRows(store.database, "ts_ms IS NULL");
    assert.ok(hotRows.length > 0, "fixture must retain hot Codex perf rows");

    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });
    const candidateDigest = fileSha256(candidateFile);
    const verified = await verifyHistoryArchiveCandidate(candidateFile);
    assert.equal(verified.ok, true);
    const candidateMeta = perfMetaBytes(candidateFile);
    const candidate = new DatabaseSync(candidateFile, { readOnly: true });
    let candidateHasSample;
    let candidateEvidence;
    try {
      candidateHasSample = candidate
        .prepare("SELECT 1 AS present FROM perf_samples WHERE sample_key = ?")
        .get(coldSample.sampleKey);
      candidateEvidence = nativeSampleEvidence(candidate, coldSample.sampleKey);
    } finally {
      candidate.close();
    }
    assert.ok(candidateHasSample);
    assert.deepEqual(candidateEvidence, sourceEvidence);

    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    assert.equal(registered.databaseSha256, candidateDigest);
    store.database.exec("BEGIN IMMEDIATE");
    try {
      writeMeta(store.database, EVENT_AUTHORITY_KEY, {
        formatVersion: 1,
        segmentIds: [registered.segmentId],
      });
      writeMeta(store.database, PERF_AUTHORITY_KEY, {
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
      store.database.prepare("DELETE FROM events WHERE timestamp_ms < ?").run(COLD_END_MS);
      const deleted = store.database.prepare("DELETE FROM perf_samples WHERE sample_key = ?").run(coldSample.sampleKey);
      assert.equal(Number(deleted.changes), 1, "the chosen cold sample must be absent from hot perf");
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }
    assert.equal(store.perfSampleByKey(coldSample.sampleKey), null);

    await publishHistoryArchiveBundle(store.database, bundleDirectory);
    await publishHistoryArchiveImport(bundleDirectory, importDirectory);
    store.close();
    store = undefined;
    fixture.close();
    assert.equal(existsSync(candidateFile), false);
    assert.equal(existsSync(candidateManifest), false);
    assert.equal(existsSync(sourceRoot), false);

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
      .prepare(
        `SELECT database_path, database_sha256 FROM archive_segments
         WHERE segment_id = ?`,
      )
      .get(registered.segmentId);
    assert.ok(segment);
    const segmentFile = String(segment.database_path);
    assert.equal(String(segment.database_sha256), candidateDigest);
    assert.equal(fileSha256(segmentFile), candidateDigest);
    assert.deepEqual(perfMetaBytes(segmentFile), candidateMeta);

    const segmentDatabase = new DatabaseSync(segmentFile, { readOnly: true });
    try {
      assert.deepEqual(nativeSampleEvidence(segmentDatabase, coldSample.sampleKey), sourceEvidence);
    } finally {
      segmentDatabase.close();
    }
    assert.deepEqual(rawPerfRows(runtime.database, "ts_ms >= ?", COLD_END_MS), hotRows);
    assert.deepEqual(rawPerfRows(runtime.database, "ts_ms IS NULL"), unplacedRows);

    const actual = await runtime.summarizeHistory(FILTERS);
    assert.deepEqual(stablePerfEvidence(actual.perf), oraclePerf);
  } finally {
    runtime?.close();
    store?.close();
    fixture.close();
    rmSync(importRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
