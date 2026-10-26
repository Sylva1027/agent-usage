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
import { PERF_SAMPLE_FIELDS, UsageStore } from "../src/usage-store.js";
import { createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

const EVENT_AUTHORITY_KEY = "history_archive_event_authority";
const PERF_AUTHORITY_KEY = "history_archive_perf_authority";
const PERF_COMPONENT_KEYS = [
  "history_archive_perf_sources_v1",
  "history_archive_perf_samples_v1",
  "history_archive_perf_index_v1",
  "history_archive_perf_timing_v1",
];
const PERF_COLUMNS = PERF_SAMPLE_FIELDS.map((entry) => entry.column);
const HOT_START_MS = Date.parse("2026-10-04T12:00:00.000Z");

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

function summarizePerfEvidence(summary, models) {
  return {
    coverage: summary.perf.coverage,
    models: models.map((model) => {
      const row = summary.perf.models.find((candidate) => candidate.model === model);
      assert.ok(row, `summary.perf must retain model ${model}`);
      return {
        model,
        n: row.n,
        p10: row.p10,
        p90: row.p90,
        averageTps: row.averageTps,
      };
    }),
  };
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

function rawPerfRows(database, where, ...params) {
  return database
    .prepare(`SELECT ${PERF_COLUMNS.join(", ")} FROM perf_samples WHERE ${where} ORDER BY sample_key`)
    .all(...params)
    .map((row) => ({ ...row }));
}

test("explicit ZCode perf authority survives complete bundle import after source removal", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const sourceRoot = fixture.serverOptions.homeDir;
  const importRoot = mkdtempSync(path.join(tmpdir(), "cold-perf-authority-transfer-"));
  const archivedFile = path.join(sourceRoot, "perf-authority-transfer-archived.sqlite");
  const oracleFile = path.join(sourceRoot, "perf-authority-transfer-oracle.sqlite");
  const candidateFile = path.join(sourceRoot, "perf-authority-transfer-candidate.sqlite");
  const candidateManifest = manifestPathFor(candidateFile);
  const bundleDirectory = path.join(importRoot, "published");
  const importDirectory = path.join(importRoot, "imported");
  const archivedOptions = { ...fixture.serverOptions, databaseFile: archivedFile };
  const oracleOptions = {
    ...fixture.serverOptions,
    databaseFile: oracleFile,
    importStoreFile: path.join(sourceRoot, "perf-authority-transfer-oracle-imports.json"),
  };
  const archived = new UsageStore(archivedOptions);
  const oracle = new UsageStore(oracleOptions);
  let runtime;
  try {
    await archived.sync({ options: archivedOptions });
    await oracle.sync({ options: oracleOptions });
    const filters = { preset: "all", now: "2026-10-04T13:00:00.000Z", calendarZone: "utc" };
    const oracleSummary = await oracle.summarizeHistory(filters);
    const coldStartMs = Number(archived.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    const hotRows = rawPerfRows(archived.database, "ts_ms >= ?", HOT_START_MS);
    const unplacedRows = rawPerfRows(archived.database, "ts_ms IS NULL");
    assert.ok(hotRows.length > 0, "fixture must contain hot perf rows");
    assert.ok(unplacedRows.length > 0, "fixture must contain unplaced perf rows");

    await createHistoryArchiveCandidate(archived.database, candidateFile, {
      startMs: coldStartMs,
      endMs: HOT_START_MS,
    });
    const candidateMetaBytes = perfMetaBytes(candidateFile);
    const candidateDigest = fileSha256(candidateFile);
    const registered = await archived.registerHistoryArchiveCandidate(candidateFile);
    assert.equal(registered.databaseSha256, candidateDigest);

    const coldSamples = archived
      .perfCandidatesForRange({ startMs: coldStartMs, endMs: HOT_START_MS - 1 })
      .sort((left, right) => left.tsMs - right.tsMs || left.sampleKey.localeCompare(right.sampleKey));
    const coldSample = coldSamples.find(
      (sample) => sample.status === "completed" && sample.outputTokens > 0 && sample.durationMs > 0,
    );
    assert.ok(coldSample, "fixture must expose a computable cold ZCode perf sample");
    assert.equal(coldSample.sourceKind, "zcode");
    assert.equal(coldSample.methodVersion, PERF_METHOD_VERSION);
    assert.deepEqual([...new Set(coldSamples.map((sample) => sample.sourceKind))], ["zcode"]);
    assert.deepEqual([...new Set(coldSamples.map((sample) => sample.methodVersion))], [PERF_METHOD_VERSION]);

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
      assert.equal(
        Number(deleted.changes),
        1,
        "test must remove exactly one cold perf sample from the temporary store",
      );
      archived.database.exec("COMMIT");
    } catch (error) {
      archived.database.exec("ROLLBACK");
      throw error;
    }

    await publishHistoryArchiveBundle(archived.database, bundleDirectory);
    await publishHistoryArchiveImport(bundleDirectory, importDirectory);
    const sourcePaths = archived.database
      .prepare("SELECT path FROM source_files WHERE kind = 'zcode' ORDER BY path")
      .all()
      .map((row) => String(row.path));
    archived.close();
    oracle.close();
    fixture.close();
    assert.equal(existsSync(sourceRoot), false, "the original source tree must be removed");
    assert.equal(existsSync(candidateFile), false, "the original candidate must be removed");
    assert.equal(existsSync(candidateManifest), false, "the original candidate manifest must be removed");
    for (const sourcePath of sourcePaths) {
      assert.equal(existsSync(sourcePath), false, `original source ${sourcePath} must be gone`);
    }

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
        `SELECT database_path, database_sha256
         FROM archive_segments
         WHERE segment_id = ?`,
      )
      .get(registered.segmentId);
    assert.ok(segment, "the new runtime must register the transferred ZCode segment");
    const segmentFile = String(segment.database_path);
    assert.equal(path.relative(importRoot, segmentFile).startsWith(".."), false);
    assert.equal(String(segment.database_sha256), candidateDigest);
    assert.equal(fileSha256(segmentFile), candidateDigest);
    const segmentDigest = fileSha256(segmentFile);

    assert.deepEqual(
      rawPerfRows(runtime.database, "ts_ms >= ?", HOT_START_MS),
      hotRows,
      "runtime hot perf rows must remain complete after transfer",
    );
    assert.deepEqual(
      rawPerfRows(runtime.database, "ts_ms IS NULL"),
      unplacedRows,
      "runtime unplaced perf rows must remain complete after transfer",
    );
    assert.deepEqual(perfMetaBytes(segmentFile), candidateMetaBytes, "all four perf component payloads must survive");

    const actualSummary = await runtime.summarizeHistory(filters);
    assert.deepEqual(
      summarizePerfEvidence(actualSummary, [coldSample.model, "ranked-model"]),
      summarizePerfEvidence(oracleSummary, [coldSample.model, "ranked-model"]),
      "imported per-source authority must preserve coverage, n, and quantiles from the unarchived oracle",
    );
    assert.equal(fileSha256(segmentFile), segmentDigest, "summary and row reads must not modify the segment");
  } finally {
    runtime?.close();
    archived.close();
    oracle.close();
    fixture.close();
    rmSync(importRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
