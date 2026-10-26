import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createHistoryArchiveCandidate,
  verifyHistoryArchiveCandidate,
  withVerifiedHistoryArchiveCandidate,
} from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";
import { withVerifiedHistoryBackup } from "../src/history-backup.js";

test("candidate proof reuse still reads current full bytes and pins its consumer", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ret-candidate-proof-"));
  const file = path.join(dir, "candidate.sqlite");
  const store = new UsageStore({
    homeDir: dir,
    databaseFile: path.join(dir, "source.sqlite"),
    env: {},
    importDirs: [],
  });
  const prepare = DatabaseSync.prototype.prepare,
    createReadStream = fs.createReadStream;
  let scans = 0,
    streams = 0,
    consumed;
  try {
    await store.open();
    store.database
      .prepare("INSERT INTO source_files VALUES(?,?,?,?,?,?,?,?)")
      .run("/fixture/source", "codex", "h", "Home", "/fixture/home", 1, 1, "now");
    const start = Date.parse("2026-01-02T03:04:05Z");
    store.database
      .prepare(`INSERT INTO events(source_path,timestamp_ms,session_id,home_id,home_label,channel,project,model,hour_key,day_key,week_key,month_key,total,input,cached,output,reasoning)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        "/fixture/source",
        start,
        "s",
        "h",
        "Home",
        "CLI",
        "fixture",
        "gpt-6-sol",
        "hour",
        "2026-01-02",
        "week",
        "2026-01",
        20,
        18,
        0,
        2,
        0,
      );
    await createHistoryArchiveCandidate(store.database, file, { startMs: start, endMs: start + 60000 });
    const bytes = fs.readFileSync(file);
    DatabaseSync.prototype.prepare = function (sql, ...args) {
      if (sql === "SELECT * FROM events ORDER BY id" || sql === 'SELECT * FROM "events"') scans++;
      return prepare.call(this, sql, ...args);
    };
    fs.createReadStream = function (name, ...args) {
      if (path.resolve(String(name)) === file) streams++;
      return createReadStream.call(this, name, ...args);
    };
    syncBuiltinESMExports();
    const read = () =>
      withVerifiedHistoryArchiveCandidate(file, undefined, (database) => {
        consumed = database;
        const writer = new DatabaseSync(file);
        try {
          writer.exec("PRAGMA busy_timeout=0");
          assert.throws(
            () => writer.prepare("UPDATE events SET total=total+1").run(),
            (error) => error.errcode === 5,
          );
        } finally {
          writer.close();
        }
        return database.prepare("SELECT total FROM events").get().total;
      });
    assert.equal(await read(), 20);
    assert.equal(scans, 1);
    assert.equal(streams, 2, "fresh file digest is checked before and under the read lock");
    assert.throws(() => consumed.prepare("SELECT 1"), /closed|not open/i);
    assert.equal(await read(), 20);
    assert.equal(scans, 1, "identical verified bytes reuse their completed semantic proof");
    assert.equal(streams, 4, "warm proof still rereads every file byte twice");
    await assert.rejects(
      withVerifiedHistoryArchiveCandidate(file, undefined, () => Promise.resolve(20)),
      { code: "HISTORY_ARCHIVE_CANDIDATE_READER_ASYNC" },
    );
    await assert.rejects(
      withVerifiedHistoryBackup(file, undefined, (database) => {
        consumed = database;
        throw new Error("INJECTED_BACKUP_READER_FAILURE");
      }),
      /INJECTED_BACKUP_READER_FAILURE/,
    );
    assert.throws(() => consumed.prepare("SELECT 1"), /closed|not open/i);
    await assert.rejects(
      withVerifiedHistoryBackup(file, undefined, () => Promise.resolve(20)),
      {
        code: "HISTORY_BACKUP_READER_ASYNC",
      },
    );
    const changed = Buffer.from(bytes);
    changed[changed.length - 1] ^= 1;
    fs.writeFileSync(file, changed);
    await assert.rejects(verifyHistoryArchiveCandidate(file), { code: "HISTORY_BACKUP_DIGEST_MISMATCH" });
    fs.writeFileSync(file, bytes);
    assert.equal(await read(), 20);
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    fs.createReadStream = createReadStream;
    syncBuiltinESMExports();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
