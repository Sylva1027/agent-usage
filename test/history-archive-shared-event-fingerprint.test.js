import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createHistoryArchiveCandidate, verifyHistoryArchiveCandidate } from "../src/history-archive.js";
import { verifyHistoryBackup } from "../src/history-backup.js";
import { UsageStore } from "../src/usage-store.js";

test("first candidate verification shares the backup event scan without changing legacy fingerprints", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ret-shared-event-sha-"));
  const store = new UsageStore({
    databaseFile: path.join(root, "usage.sqlite"),
    homeDir: root,
    env: {},
    importDirs: [],
  });
  const file = path.join(root, "candidate.sqlite");
  const startMs = Date.parse("2026-01-02T00:00:00Z"),
    endMs = startMs + 86400000;
  const prepare = DatabaseSync.prototype.prepare;
  let backupScans = 0,
    archiveScans = 0,
    reverseBackupScan = false;
  try {
    await store.open();
    store.database
      .prepare("INSERT INTO source_files VALUES(?,?,?,?,?,?,?,?)")
      .run("/fixture/source", "codex", "home", "Home", root, 1, 1, "now");
    for (const [offset, total] of [
      [0, 100],
      [1, -5],
      [2, 20],
    ])
      store.database
        .prepare(`INSERT INTO events(
      source_path,timestamp_ms,session_id,home_id,home_label,channel,project,model,
      hour_key,day_key,week_key,month_key,total,input,cached,output,reasoning
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          "/fixture/source",
          startMs + offset,
          `s-${offset}`,
          "home",
          "Home",
          "CLI",
          "fixture",
          "gpt-6-sol",
          "2026-01-02 00",
          "2026-01-02",
          "2025-12-29",
          "2026-01",
          total,
          total,
          0,
          0,
          0,
        );
    await createHistoryArchiveCandidate(store.database, file, { startMs, endMs });
    const db = new DatabaseSync(file, { readOnly: true });
    let expected;
    try {
      const hash = createHash("sha256").update(`${JSON.stringify({ startMs, endMs })}\n`);
      for (const row of db.prepare("SELECT * FROM events ORDER BY id").all()) hash.update(`${JSON.stringify(row)}\n`);
      expected = hash.digest("hex");
    } finally {
      db.close();
    }
    DatabaseSync.prototype.prepare = function (sql, ...args) {
      if (sql === 'SELECT * FROM "events"') {
        backupScans++;
        if (reverseBackupScan) return prepare.call(this, `${sql} ORDER BY id DESC`, ...args);
      }
      if (sql === "SELECT * FROM events ORDER BY id") archiveScans++;
      return prepare.call(this, sql, ...args);
    };
    const verified = await verifyHistoryArchiveCandidate(file);
    assert.equal(verified.candidate.events.sha256, expected, "range-prefixed legacy SHA is unchanged");
    assert.deepEqual(Object.keys(verified.manifest.tables.events), ["rows", "sha256"], "manifest format is unchanged");
    assert.equal(backupScans, 1, "the complete backup still fingerprints the actual events");
    assert.equal(archiveScans, 0, "candidate verification reuses that exact row stream");
    await verifyHistoryArchiveCandidate(file);
    assert.equal(backupScans, 1, "warm semantic proof remains bounded and reusable");
    assert.equal(archiveScans, 0);

    const backupFirstFile = path.join(root, "backup-first.sqlite");
    await createHistoryArchiveCandidate(store.database, backupFirstFile, { startMs, endMs });
    await verifyHistoryBackup(backupFirstFile);
    backupScans = archiveScans = 0;
    assert.equal((await verifyHistoryArchiveCandidate(backupFirstFile)).candidate.events.sha256, expected);
    assert.equal(backupScans, 0);
    assert.equal(archiveScans, 1, "a backup-only cached proof falls back to the independent archive scan");

    reverseBackupScan = true;
    const reversedFile = path.join(root, "reversed-scan.sqlite");
    await createHistoryArchiveCandidate(store.database, reversedFile, { startMs, endMs });
    backupScans = archiveScans = 0;
    assert.equal((await verifyHistoryArchiveCandidate(reversedFile)).candidate.events.sha256, expected);
    assert.equal(backupScans, 1);
    assert.equal(archiveScans, 1, "a valid backup with another row order cannot substitute its archive fingerprint");
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
