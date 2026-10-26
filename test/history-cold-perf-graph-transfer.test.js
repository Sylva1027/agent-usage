import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createHistoryArchiveCandidate,
  loadHistoryArchiveImport,
  publishHistoryArchiveBundle,
  publishHistoryArchiveImport,
} from "../src/history-archive.js";
import { PERF_SAMPLE_FIELDS, UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const COLD_END_MS = Date.parse("2026-10-04T12:02:00.000Z");
const PERF_COLUMNS = PERF_SAMPLE_FIELDS.map((entry) => entry.column);
const PERF_META_KEYS = [
  "history_archive_perf_sources_v1",
  "history_archive_perf_samples_v1",
  "history_archive_perf_index_v1",
  "history_archive_perf_timing_v1",
];

function fileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function manifestPathFor(databaseFile) {
  const parsed = path.parse(databaseFile);
  return path.join(parsed.dir, `${parsed.name}.manifest.json`);
}

function decodedSampleAsSourceColumns(sample) {
  return Object.fromEntries(
    PERF_SAMPLE_FIELDS.map((entry) => [
      entry.column,
      entry.kind === "reasonChain" && sample[entry.field] !== null
        ? JSON.stringify(sample[entry.field])
        : sample[entry.field],
    ]),
  );
}

function perfMetaBytes(filePath) {
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    const rows = database
      .prepare(`SELECT key, value FROM store_meta WHERE key IN (${PERF_META_KEYS.map(() => "?").join(",")})`)
      .all(...PERF_META_KEYS);
    assert.equal(rows.length, PERF_META_KEYS.length);
    return Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]));
  } finally {
    database.close();
  }
}

function timingGraph(database, startMs, endMs) {
  const coldSample = database
    .prepare(
      `SELECT sample_key FROM perf_samples
       WHERE ts_ms >= ? AND ts_ms < ? ORDER BY ts_ms, sample_key LIMIT 1`,
    )
    .get(startMs, endMs);
  assert.ok(coldSample, "fixture must have a bounded cold perf sample");

  const owners = database
    .prepare(
      `SELECT DISTINCT owners.home_id, owners.thread_id
       FROM perf_sample_sources AS dependencies
       JOIN perf_rollout_threads AS owners ON owners.source_path = dependencies.source_path
       WHERE dependencies.sample_key = ?
       ORDER BY owners.home_id, owners.thread_id`,
    )
    .all(String(coldSample.sample_key));
  assert.equal(owners.length, 1, "the cold sample must belong to exactly one native thread");
  const homeId = String(owners[0].home_id);
  const threadId = String(owners[0].thread_id);

  const samples = database
    .prepare(
      `SELECT samples.*
       FROM perf_samples AS samples
       WHERE EXISTS (
         SELECT 1
         FROM perf_sample_sources AS dependencies
         JOIN perf_rollout_threads AS owners ON owners.source_path = dependencies.source_path
         WHERE dependencies.sample_key = samples.sample_key
           AND owners.home_id = ? AND owners.thread_id = ?
       )
       ORDER BY samples.ts_ms, samples.sample_key`,
    )
    .all(homeId, threadId)
    .map((row) => ({ ...row }));
  const sampleSources = database
    .prepare(
      `SELECT dependencies.*
       FROM perf_sample_sources AS dependencies
       WHERE EXISTS (
         SELECT 1
         FROM perf_sample_sources AS related
         JOIN perf_rollout_threads AS owners ON owners.source_path = related.source_path
         WHERE related.sample_key = dependencies.sample_key
           AND owners.home_id = ? AND owners.thread_id = ?
       )
       ORDER BY dependencies.sample_key, dependencies.source_path`,
    )
    .all(homeId, threadId)
    .map((row) => ({ ...row }));
  const rolloutThreads = database
    .prepare(
      `SELECT * FROM perf_rollout_threads
       WHERE home_id = ? AND thread_id = ? ORDER BY source_path`,
    )
    .all(homeId, threadId)
    .map((row) => ({ ...row }));
  const sourcePaths = [...new Set([...sampleSources, ...rolloutThreads].map((row) => String(row.source_path)))].sort();
  const sourceFiles = database
    .prepare(
      `SELECT path, kind, home_id, home_label, home_path
       FROM source_files WHERE path IN (${sourcePaths.map(() => "?").join(",")})
       ORDER BY path`,
    )
    .all(...sourcePaths)
    .map((row) => ({ ...row }));
  const timingThreads = database
    .prepare(
      `SELECT * FROM perf_request_timing_threads
       WHERE home_id = ? AND thread_id = ? ORDER BY response_id, thread_id`,
    )
    .all(homeId, threadId)
    .map((row) => ({ ...row }));
  const timingEvidence = database
    .prepare(
      `SELECT evidence.*
       FROM perf_request_timing_evidence AS evidence
       JOIN perf_request_timing_threads AS links
         ON links.home_id = evidence.home_id AND links.response_id = evidence.response_id
       WHERE links.home_id = ? AND links.thread_id = ?
       ORDER BY evidence.evidence_origin, evidence.response_id, evidence.variant_key`,
    )
    .all(homeId, threadId)
    .map((row) => ({ ...row }));

  return {
    homeId,
    threadId,
    selectedColdSampleKey: String(coldSample.sample_key),
    samples,
    sampleSources,
    rolloutThreads,
    sourceFiles,
    timingThreads,
    timingEvidence,
  };
}

test("cold perf native graph survives complete bundle import after source removal", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const importRoot = await mkdtemp(path.join(os.tmpdir(), "cold-perf-graph-transfer-"));
  const candidateFile = path.join(fixture.serverOptions.homeDir, "cold-perf-graph-transfer-candidate.sqlite");
  const candidateManifest = manifestPathFor(candidateFile);
  const bundleDirectory = path.join(importRoot, "published");
  const importDirectory = path.join(importRoot, "imported");
  let store;
  let runtime;
  try {
    store = new UsageStore(fixture.serverOptions);
    await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(store);
    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    const sourceRows = store.database
      .prepare(
        `SELECT ${PERF_COLUMNS.join(", ")} FROM perf_samples
         WHERE ts_ms >= ? AND ts_ms < ? ORDER BY sample_key`,
      )
      .all(coldStartMs, COLD_END_MS)
      .map((row) => ({ ...row }));
    const sourceGraph = timingGraph(store.database, coldStartMs, COLD_END_MS);
    assert.ok(sourceRows.length > 0, "source SQL must freeze bounded perf samples");
    assert.ok(sourceGraph.samples.some((row) => Number(row.ts_ms) < COLD_END_MS));
    assert.ok(sourceGraph.samples.some((row) => Number(row.ts_ms) >= COLD_END_MS));
    assert.ok(sourceGraph.sampleSources.some((row) => row.role === "dependency"));
    assert.equal(sourceGraph.sourceFiles.length, 3, "the native thread graph must span three rollout identities");
    assert.equal(sourceGraph.timingEvidence.length, fixture.timingRecords.length);
    assert.equal(sourceGraph.timingThreads.length, sourceGraph.timingEvidence.length);

    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });
    const candidateMetaBytes = perfMetaBytes(candidateFile);
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    await publishHistoryArchiveBundle(store.database, bundleDirectory);
    await publishHistoryArchiveImport(bundleDirectory, importDirectory);

    store.close();
    store = undefined;
    rmSync(candidateFile, { force: true });
    rmSync(candidateManifest, { force: true });
    fixture.close();
    assert.equal(existsSync(candidateFile), false);
    assert.equal(existsSync(candidateManifest), false);
    for (const source of sourceGraph.sourceFiles) {
      assert.equal(existsSync(String(source.path)), false, `original source ${source.path} must be gone`);
    }

    const loaded = await loadHistoryArchiveImport(importDirectory);
    const runtimeRegistry = new DatabaseSync(loaded.runtimeFile, { readOnly: true });
    let segmentFile;
    try {
      const segment = runtimeRegistry
        .prepare(
          `SELECT database_path, database_sha256 FROM archive_segments
           WHERE segment_id = ?`,
        )
        .get(registered.segmentId);
      assert.ok(segment);
      segmentFile = String(segment.database_path);
      assert.equal(fileSha256(segmentFile), String(segment.database_sha256));
    } finally {
      runtimeRegistry.close();
    }
    const segmentDigest = fileSha256(segmentFile);

    const segmentDatabase = new DatabaseSync(segmentFile, { readOnly: true });
    let importedGraph;
    try {
      importedGraph = timingGraph(segmentDatabase, coldStartMs, COLD_END_MS);
    } finally {
      segmentDatabase.close();
    }
    assert.deepEqual(importedGraph, sourceGraph, "the imported native timing graph must match source SQL");
    assert.deepEqual(perfMetaBytes(segmentFile), candidateMetaBytes, "all four perf metadata payloads must survive");

    runtime = new UsageStore({
      homeDir: importRoot,
      env: {},
      importDirs: [],
      automaticDiscoveryEnabled: false,
      databaseFile: loaded.runtimeFile,
    });
    const actualRows = (await runtime.readHistoryArchivePerfSamples(registered.segmentId)).map(
      decodedSampleAsSourceColumns,
    );
    assert.deepEqual(actualRows, sourceRows, "every imported cold perf column must match source SQL");
    assert.equal(fileSha256(segmentFile), segmentDigest, "graph and perf reads must not modify the segment");
  } finally {
    runtime?.close();
    store?.close();
    fixture.close();
    await rm(importRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
