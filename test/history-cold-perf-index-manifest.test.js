import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryBackup } from "../src/history-backup.js";
import { createHistoryArchiveCandidate, verifyHistoryArchiveCandidate } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const COLD_END_MS = Date.parse("2026-10-04T12:02:00.000Z");
const PERF_INDEX_META_KEY = "history_archive_perf_index_v1";
const SAMPLE_SOURCE_COLUMNS = ["sample_key", "source_path", "role"];
const ROLLOUT_COLUMNS = ["source_path", "home_id", "thread_id"];
const SOURCE_IDENTITY_COLUMNS = ["path", "kind", "home_id", "home_label", "home_path"];

function tableEvidence(table, columns, rows, startMs, endMs) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ table, startMs, endMs, columns }));
  hash.update("\n");
  for (const row of rows) {
    hash.update(JSON.stringify(Object.fromEntries(columns.map((column) => [column, row[column]]))));
    hash.update("\n");
  }
  return { rows: rows.length, sha256: hash.digest("hex") };
}

function sourcePerfIndex(database, startMs, endMs) {
  const sampleSources = database
    .prepare(
      `SELECT dependencies.sample_key, dependencies.source_path, dependencies.role
       FROM perf_samples AS samples
       JOIN perf_sample_sources AS dependencies ON dependencies.sample_key = samples.sample_key
       WHERE samples.ts_ms >= ? AND samples.ts_ms < ?
       ORDER BY dependencies.sample_key, dependencies.source_path`,
    )
    .all(startMs, endMs)
    .map((row) => ({ ...row }));
  const rolloutThreads = database
    .prepare(
      `SELECT rollouts.source_path, rollouts.home_id, rollouts.thread_id
       FROM perf_rollout_threads AS rollouts
       WHERE rollouts.source_path IN (
         SELECT source_path FROM perf_samples WHERE ts_ms >= ? AND ts_ms < ?
         UNION
         SELECT dependencies.source_path
         FROM perf_samples AS samples
         JOIN perf_sample_sources AS dependencies ON dependencies.sample_key = samples.sample_key
         WHERE samples.ts_ms >= ? AND samples.ts_ms < ?
       )
       ORDER BY rollouts.source_path`,
    )
    .all(startMs, endMs, startMs, endMs)
    .map((row) => ({ ...row }));
  const sourceFiles = database
    .prepare(
      `SELECT paths.path AS referenced_path,
              source_files.path, source_files.kind, source_files.home_id,
              source_files.home_label, source_files.home_path
       FROM (
         SELECT source_path AS path FROM perf_samples WHERE ts_ms >= ? AND ts_ms < ?
         UNION
         SELECT dependencies.source_path
         FROM perf_samples AS samples
         JOIN perf_sample_sources AS dependencies ON dependencies.sample_key = samples.sample_key
         WHERE samples.ts_ms >= ? AND samples.ts_ms < ?
       ) AS paths
       LEFT JOIN source_files ON source_files.path = paths.path
       ORDER BY paths.path`,
    )
    .all(startMs, endMs, startMs, endMs);
  assert.ok(
    sourceFiles.every((row) => row.path !== null),
    "every cold perf source path must retain its source identity",
  );

  return {
    formatVersion: 1,
    startMs,
    endMs,
    tables: {
      perf_sample_sources: tableEvidence("perf_sample_sources", SAMPLE_SOURCE_COLUMNS, sampleSources, startMs, endMs),
      perf_rollout_threads: tableEvidence("perf_rollout_threads", ROLLOUT_COLUMNS, rolloutThreads, startMs, endMs),
      source_files: tableEvidence(
        "source_files",
        SOURCE_IDENTITY_COLUMNS,
        sourceFiles.map((row) => ({ ...row })),
        startMs,
        endMs,
      ),
    },
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

test("candidate indexes cold perf dependencies and rejects relation or format drift", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const homeDir = fixture.serverOptions.homeDir;
  const candidateFile = path.join(homeDir, "cold-perf-index-candidate.sqlite");
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(store);
    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    const expected = sourcePerfIndex(store.database, coldStartMs, COLD_END_MS);
    for (const [table, evidence] of Object.entries(expected.tables)) {
      assert.ok(evidence.rows > 0, `source SQL must expose cold ${table} rows`);
    }

    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });
    assert.equal((await verifyHistoryArchiveCandidate(candidateFile)).ok, true);
    assert.deepEqual(
      JSON.parse(metaValue(candidateFile, PERF_INDEX_META_KEY)),
      expected,
      "candidate index metadata must match the complete source-side cold dependency graph",
    );

    const selectedRelation = store.database
      .prepare(
        `SELECT dependencies.sample_key, dependencies.source_path
         FROM perf_samples AS samples
         JOIN perf_sample_sources AS dependencies ON dependencies.sample_key = samples.sample_key
         WHERE samples.ts_ms >= ? AND samples.ts_ms < ?
         ORDER BY dependencies.sample_key, dependencies.source_path
         LIMIT 1`,
      )
      .get(coldStartMs, COLD_END_MS);
    assert.ok(selectedRelation, "test must select a cold dependency relation from source SQL");

    const relationFile = path.join(homeDir, "cold-perf-index-relation-drift.sqlite");
    await repackCandidate(
      candidateFile,
      path.join(homeDir, "cold-perf-index-relation-drift-staging.sqlite"),
      relationFile,
      (database) => {
        const deleted = database
          .prepare("DELETE FROM perf_sample_sources WHERE sample_key = ? AND source_path = ?")
          .run(selectedRelation.sample_key, selectedRelation.source_path);
        assert.equal(Number(deleted.changes), 1);
      },
    );
    await assert.rejects(
      () => verifyHistoryArchiveCandidate(relationFile),
      expectCode("HISTORY_ARCHIVE_CANDIDATE_PERF_DEPENDENCIES_MISMATCH"),
    );

    const badFormatFile = path.join(homeDir, "cold-perf-index-bad-format.sqlite");
    await repackCandidate(
      candidateFile,
      path.join(homeDir, "cold-perf-index-bad-format-staging.sqlite"),
      badFormatFile,
      (database) => {
        const evidence = JSON.parse(metaValue(candidateFile, PERF_INDEX_META_KEY));
        evidence.formatVersion = 2;
        database
          .prepare("UPDATE store_meta SET value = ? WHERE key = ?")
          .run(JSON.stringify(evidence), PERF_INDEX_META_KEY);
      },
    );
    await assert.rejects(
      () => verifyHistoryArchiveCandidate(badFormatFile),
      expectCode("HISTORY_ARCHIVE_CANDIDATE_PERF_DEPENDENCIES_BAD_METADATA"),
    );

    const legacyFile = path.join(homeDir, "cold-perf-index-legacy.sqlite");
    await repackCandidate(
      candidateFile,
      path.join(homeDir, "cold-perf-index-legacy-staging.sqlite"),
      legacyFile,
      (database) => {
        database.prepare("DELETE FROM store_meta WHERE key = ?").run(PERF_INDEX_META_KEY);
      },
    );
    assert.equal((await verifyHistoryArchiveCandidate(legacyFile)).ok, true);
  } finally {
    store.close();
    fixture.close();
  }
});
