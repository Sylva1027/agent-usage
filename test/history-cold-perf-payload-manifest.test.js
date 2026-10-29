import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryBackup } from "../src/history-backup.js";
import { createHistoryArchiveCandidate, verifyHistoryArchiveCandidate } from "../src/history-archive.js";
import { PERF_SAMPLE_FIELDS, UsageStore } from "../src/usage-store.js";
import { createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

const HOT_START_MS = Date.parse("2026-10-04T12:00:00.000Z");
const PERF_SOURCE_INVENTORY_META_KEY = "history_archive_perf_sources_v1";
const PERF_SAMPLES_META_KEY = "history_archive_perf_samples_v1";
const PERF_COLUMNS = PERF_SAMPLE_FIELDS.map((entry) => entry.column);

function sourcePerfSampleEvidence(rows, startMs, endMs) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ table: "perf_samples", startMs, endMs, columns: PERF_COLUMNS }));
  hash.update("\n");
  for (const row of rows) {
    hash.update(JSON.stringify(Object.fromEntries(PERF_COLUMNS.map((column) => [column, row[column]]))));
    hash.update("\n");
  }
  return {
    formatVersion: 1,
    startMs,
    endMs,
    rows: rows.length,
    sha256: hash.digest("hex"),
  };
}

async function repackCandidate(sourceFile, stagingFile, destinationFile, mutate) {
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  try {
    await backup(source, stagingFile);
  } finally {
    source.close();
  }
  const database = new DatabaseSync(stagingFile);
  try {
    mutate(database);
    await createHistoryBackup(database, destinationFile);
  } finally {
    database.close();
  }
}

function metaValue(file, key) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const row = database.prepare("SELECT value FROM store_meta WHERE key = ?").get(key);
    assert.ok(row, `candidate must contain ${key}`);
    return String(row.value);
  } finally {
    database.close();
  }
}

function expectCode(code) {
  return (error) => {
    assert.equal(error.code, code);
    return true;
  };
}

test("candidate binds complete cold perf payloads and rejects value or format changes", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const homeDir = fixture.serverOptions.homeDir;
  const options = {
    ...fixture.serverOptions,
    databaseFile: path.join(homeDir, "cold-perf-payload-manifest.sqlite"),
  };
  const candidateFile = path.join(homeDir, "cold-perf-payload-manifest-candidate.sqlite");
  const store = new UsageStore(options);
  try {
    await store.sync({ options });
    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    const sourceRows = store.database
      .prepare(
        `SELECT ${PERF_COLUMNS.join(", ")} FROM perf_samples
         WHERE ts_ms >= ? AND ts_ms < ? ORDER BY sample_key`,
      )
      .all(coldStartMs, HOT_START_MS)
      .map((row) => ({ ...row }));
    const sourceSample = sourceRows.find(
      (row) =>
        row.status === "completed" &&
        row.output_tokens === null &&
        row.duration_ms === null &&
        Number(row.request_count) === 1,
    );
    assert.ok(sourceRows.length > 0, "source SQL must find complete cold perf rows");
    assert.ok(sourceSample, "source SQL must expose a missing-generation ZCode candidate");
    assert.equal(sourceSample.timing_kind, "generation");
    assert.equal(sourceSample.token_scope, "non_reasoning_output");
    assert.equal(sourceSample.timing_source, "unknown");
    const expectedPerfSamples = sourcePerfSampleEvidence(sourceRows, coldStartMs, HOT_START_MS);

    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: coldStartMs,
      endMs: HOT_START_MS,
    });
    assert.equal((await verifyHistoryArchiveCandidate(candidateFile)).ok, true);
    assert.deepEqual(JSON.parse(metaValue(candidateFile, PERF_SAMPLES_META_KEY)), expectedPerfSamples);
    const inventoryBefore = metaValue(candidateFile, PERF_SOURCE_INVENTORY_META_KEY);

    const tamperedFile = path.join(homeDir, "cold-perf-payload-manifest-tampered.sqlite");
    await repackCandidate(
      candidateFile,
      path.join(homeDir, "cold-perf-payload-manifest-tampered-staging.sqlite"),
      tamperedFile,
      (database) => {
        database
          .prepare("UPDATE perf_samples SET duration_ms = ? WHERE sample_key = ?")
          .run(Number(sourceSample.duration_ms) + 1, String(sourceSample.sample_key));
      },
    );
    assert.equal(metaValue(tamperedFile, PERF_SOURCE_INVENTORY_META_KEY), inventoryBefore);
    await assert.rejects(
      () => verifyHistoryArchiveCandidate(tamperedFile),
      expectCode("HISTORY_ARCHIVE_CANDIDATE_PERF_SAMPLES_MISMATCH"),
    );

    const badFormatFile = path.join(homeDir, "cold-perf-payload-manifest-bad-format.sqlite");
    await repackCandidate(
      candidateFile,
      path.join(homeDir, "cold-perf-payload-manifest-bad-format-staging.sqlite"),
      badFormatFile,
      (database) => {
        const evidence = JSON.parse(metaValue(candidateFile, PERF_SAMPLES_META_KEY));
        evidence.formatVersion = 2;
        database
          .prepare("UPDATE store_meta SET value = ? WHERE key = ?")
          .run(JSON.stringify(evidence), PERF_SAMPLES_META_KEY);
      },
    );
    await assert.rejects(
      () => verifyHistoryArchiveCandidate(badFormatFile),
      expectCode("HISTORY_ARCHIVE_CANDIDATE_PERF_SAMPLES_BAD_METADATA"),
    );

    const legacyFile = path.join(homeDir, "cold-perf-payload-manifest-legacy.sqlite");
    await repackCandidate(
      candidateFile,
      path.join(homeDir, "cold-perf-payload-manifest-legacy-staging.sqlite"),
      legacyFile,
      (database) => {
        database.prepare("DELETE FROM store_meta WHERE key = ?").run(PERF_SAMPLES_META_KEY);
      },
    );
    assert.equal((await verifyHistoryArchiveCandidate(legacyFile)).ok, true);
  } finally {
    store.close();
    fixture.close();
  }
});
