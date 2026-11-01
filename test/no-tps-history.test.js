import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import * as historyArchive from "../src/history-archive.js";
import {
  assertHistoryArchiveCommitPlan,
  createHistoryArchiveCandidate,
  prepareHistoryArchiveCommit,
  verifyHistoryArchiveCandidate,
} from "../src/history-archive.js";
import { createHistoryBackup, verifyHistoryBackup } from "../src/history-backup.js";

const CORE_HISTORY_DDL = `
  CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE source_files (
    path TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    home_id TEXT NOT NULL,
    home_label TEXT NOT NULL,
    home_path TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    indexed_at TEXT NOT NULL
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
    timestamp_ms INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    project TEXT NOT NULL,
    model TEXT NOT NULL,
    total INTEGER NOT NULL,
    input INTEGER NOT NULL,
    cached INTEGER NOT NULL,
    output INTEGER NOT NULL
  );
  CREATE TABLE rate_limit_observations (
    source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
    line_number INTEGER NOT NULL,
    observed_at_ms INTEGER NOT NULL,
    PRIMARY KEY (source_path, line_number)
  );
  CREATE TABLE history_replaced_facts (
    fact_table TEXT NOT NULL,
    source_path TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE TABLE archive_segments (
    segment_id TEXT PRIMARY KEY,
    database_path TEXT NOT NULL,
    database_sha256 TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    event_count INTEGER NOT NULL,
    registered_at_ms INTEGER NOT NULL
  );
  CREATE TABLE quota_usage_sources (
    source_path TEXT PRIMARY KEY REFERENCES source_files(path) ON DELETE CASCADE,
    used_percent REAL
  );
`;

const CORE_SCHEMA_24_TABLES = Object.freeze([
  "archive_segments",
  "events",
  "history_replaced_facts",
  "quota_usage_sources",
  "rate_limit_observations",
  "source_files",
  "store_meta",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function withTempRoot(prefix) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

function createHistoryDatabase(root, { schemaVersion = 24, extraTps = false } = {}) {
  const file = path.join(root, "history.sqlite");
  const sourcePath = path.join(root, "source.jsonl");
  const database = new DatabaseSync(file);
  database.exec(CORE_HISTORY_DDL);
  if (extraTps) {
    database.exec(`
      CREATE TABLE perf_samples (
        sample_key TEXT PRIMARY KEY,
        source_path TEXT NOT NULL REFERENCES source_files(path)
      );
      CREATE TABLE perf_request_timing_meta (
        singleton INTEGER PRIMARY KEY,
        revision INTEGER NOT NULL
      );
    `);
  }
  database.exec(`PRAGMA user_version = ${schemaVersion};`);
  database.prepare("INSERT INTO store_meta (key, value) VALUES ('fixture', ?)").run(`schema${schemaVersion}`);
  database
    .prepare("INSERT INTO source_files VALUES (?, 'codex', 'home', 'Home', ?, 1, 1, 'now')")
    .run(sourcePath, root);
  const startMs = new Date("2026-01-02T03:04:05.000Z").getTime();
  const endMs = startMs + 60_000;
  const insertEvent = database.prepare(
    `INSERT INTO events
      (source_path, timestamp_ms, session_id, project, model, total, input, cached, output)
     VALUES (?, ?, ?, 'project', 'gpt-6-sol', ?, ?, 0, ?)`,
  );
  insertEvent.run(sourcePath, startMs, "in-range", 20, 18, 2);
  insertEvent.run(sourcePath, endMs, "outside-range", 10, 9, 1);
  database.prepare("INSERT INTO quota_usage_sources (source_path, used_percent) VALUES (?, 42)").run(sourcePath);
  if (extraTps) {
    database.prepare("INSERT INTO perf_samples (sample_key, source_path) VALUES ('opaque', ?)").run(sourcePath);
    database.prepare("INSERT INTO perf_request_timing_meta VALUES (1, 7)").run();
    database.prepare("INSERT INTO store_meta (key, value) VALUES ('perf_method_version', 'opaque-v8')").run();
  }
  return { database, file, startMs, endMs, sourcePath };
}

test("history modules no longer export TPS evidence, graph, or timing APIs", () => {
  for (const name of [
    "historyArchivePerfDeletion",
    "readCodexNativeMeasurements",
    "validateCodexRequestEvidence",
    "HISTORY_ARCHIVE_CODEX_REQUESTS_META_KEY",
  ]) {
    assert.equal(Object.hasOwn(historyArchive, name), false, name);
  }
});

test("fresh schema 24 backups and archive candidates contain only ordinary history evidence", async () => {
  const box = withTempRoot("no-tps-history-fresh-");
  const source = createHistoryDatabase(box.root);
  try {
    const backupFile = path.join(box.root, "backup", "history.sqlite");
    const manifest = await createHistoryBackup(source.database, backupFile);
    assert.deepEqual(Object.keys(manifest.tables).sort(), CORE_SCHEMA_24_TABLES);
    assert.equal(Object.hasOwn(manifest, "perfMethodVersion"), false);
    await verifyHistoryBackup(backupFile);

    const candidateFile = path.join(box.root, "candidate", "candidate.sqlite");
    await createHistoryArchiveCandidate(source.database, candidateFile, {
      startMs: source.startMs,
      endMs: source.endMs,
    });
    const verifiedCandidate = await verifyHistoryArchiveCandidate(candidateFile);
    assert.deepEqual(Object.keys(verifiedCandidate.candidate).sort(), [
      "endMs",
      "events",
      "formatVersion",
      "sources",
      "startMs",
      "state",
    ]);
    const prepared = await prepareHistoryArchiveCommit(source.database, candidateFile);
    assert.equal(Object.hasOwn(prepared, "perfDeletion"), false);
    assert.deepEqual(prepared.deletion, {
      table: "events",
      ids: [source.database.prepare("SELECT id FROM events WHERE session_id = 'in-range'").get().id],
    });
    assert.equal(assertHistoryArchiveCommitPlan(prepared, structuredClone(prepared)), prepared);
    assert.equal(source.database.prepare("SELECT COUNT(*) AS count FROM quota_usage_sources").get().count, 1);
    assert.equal(source.database.prepare("SELECT COUNT(*) AS count FROM history_replaced_facts").get().count, 0);
  } finally {
    source.database.close();
    box.cleanup();
  }
});

test("legacy schema 23 TPS tables and metadata remain opaque to core backup verification", async () => {
  const box = withTempRoot("no-tps-history-legacy-");
  const source = createHistoryDatabase(box.root, { schemaVersion: 23, extraTps: true });
  try {
    source.database.exec("PRAGMA foreign_keys = OFF");
    source.database
      .prepare("INSERT INTO perf_samples (sample_key, source_path) VALUES ('opaque-orphan', ?)")
      .run(path.join(box.root, "missing-tps-source.jsonl"));
    source.database.exec("PRAGMA foreign_keys = ON");
    assert.ok(
      source.database
        .prepare("PRAGMA foreign_key_check")
        .all()
        .some((violation) => violation.table === "perf_samples"),
      "fixture must contain an orphaned legacy TPS foreign key",
    );

    const backupFile = path.join(box.root, "backup", "history.sqlite");
    const manifestFile = path.join(box.root, "backup", "history.manifest.json");
    const manifest = await createHistoryBackup(source.database, backupFile);
    assert.deepEqual(Object.keys(manifest.tables).sort(), CORE_SCHEMA_24_TABLES);
    assert.equal(Object.hasOwn(manifest, "perfMethodVersion"), false);
    assert.equal(Object.hasOwn(manifest.tables, "perf_samples"), false);
    assert.equal(Object.hasOwn(manifest.tables, "perf_request_timing_meta"), false);
    await verifyHistoryBackup(backupFile);

    const opaque = new DatabaseSync(backupFile);
    try {
      opaque.prepare("DELETE FROM perf_samples").run();
    } finally {
      opaque.close();
    }
    const bytes = readFileSync(backupFile);
    const rehashed = structuredClone(manifest);
    rehashed.database.bytes = bytes.byteLength;
    rehashed.database.sha256 = sha256(bytes);
    writeFileSync(manifestFile, `${JSON.stringify(rehashed, null, 2)}\n`);

    const verified = await verifyHistoryBackup(backupFile);
    assert.equal(verified.ok, true);
    const inspected = new DatabaseSync(backupFile, { readOnly: true });
    try {
      assert.equal(inspected.prepare("SELECT COUNT(*) AS count FROM perf_samples").get().count, 0);
      assert.equal(
        inspected.prepare("SELECT revision FROM perf_request_timing_meta WHERE singleton = 1").get().revision,
        7,
      );
    } finally {
      inspected.close();
    }
  } finally {
    source.database.close();
    box.cleanup();
  }
});

test("core foreign-key orphans still reject a history backup", async () => {
  const box = withTempRoot("no-tps-history-core-fk-");
  const source = createHistoryDatabase(box.root);
  try {
    source.database.exec("PRAGMA foreign_keys = OFF");
    source.database
      .prepare(
        `INSERT INTO rate_limit_observations
          (source_path, line_number, observed_at_ms)
         VALUES (?, 1, 1)`,
      )
      .run(path.join(box.root, "missing-core-source.jsonl"));
    source.database.exec("PRAGMA foreign_keys = ON");
    assert.ok(
      source.database
        .prepare("PRAGMA foreign_key_check")
        .all()
        .some((violation) => violation.table === "rate_limit_observations"),
      "fixture must contain an orphaned core foreign key",
    );

    await assert.rejects(createHistoryBackup(source.database, path.join(box.root, "backup", "history.sqlite")), {
      code: "HISTORY_BACKUP_FOREIGN_KEY",
    });
  } finally {
    source.database.close();
    box.cleanup();
  }
});
