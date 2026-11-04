import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ensureUsageSourceProgressSchema,
  markUsageSourceDependents,
  readUsageSourceBaseline,
  readUsageSourceProgress,
  UsageSourceChangeBounds,
  writeUsageSourceBaseline,
  writeUsageSourceProgress,
} from "../src/usage-source-progress.js";

function fixture(run) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE source_files(path TEXT PRIMARY KEY,kind TEXT,home_id TEXT,home_label TEXT,home_path TEXT,size INTEGER,mtime_ms REAL);
      INSERT INTO source_files VALUES ('a','codex','home','label','/home',100,1),('b','dsh','other','label','/other',200,2);
      CREATE TABLE events(source_path TEXT,value INTEGER,home_id TEXT,session_id TEXT,timestamp_ms INTEGER);
      CREATE TABLE rate_limit_observations(source_path TEXT,value INTEGER);
      CREATE TABLE quota_usage_sources(source_path TEXT,value INTEGER)`);
    ensureUsageSourceProgressSchema(db);
    run(db);
  } finally {
    db.close();
  }
}

const cursor = { format: 1, adapter: "codex-jsonl", offset: 90, lineNumber: 3, state: { cumulative: 42 } };
const proof = { kind: "fixture-only", prefixBytes: 90 };
function save(db, source = "a", checkpoint = cursor) {
  return writeUsageSourceProgress(db, source, checkpoint, proof);
}

test("source progress requires the facts transaction and rolls back with the facts", () => {
  fixture(db => {
    assert.throws(() => save(db), /facts write transaction/);
    db.exec("BEGIN; INSERT INTO events(source_path,value) VALUES ('a',42)");
    assert.ok(save(db));
    assert.deepEqual(readUsageSourceProgress(db, "a"), { checkpoint: cursor, validation: proof });
    db.exec("ROLLBACK");
    assert.equal(readUsageSourceProgress(db, "a"), null);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events").get().n, 0);
  });
});

test("a writer that knows nothing about cursors invalidates only the affected source", () => {
  fixture(db => {
    db.exec("BEGIN");
    assert.ok(save(db));
    assert.ok(save(db, "b", { ...cursor, adapter: "dsh-v4-zstd" }));
    db.exec("COMMIT; INSERT INTO events(source_path,value) VALUES ('a',1)");
    assert.equal(readUsageSourceProgress(db, "a"), null);
    assert.ok(readUsageSourceProgress(db, "b"));
    db.exec("UPDATE events SET source_path='b'");
    assert.equal(readUsageSourceProgress(db, "b"), null);
  });
});

test("known baseline bounds and conservative legacy dependencies survive the upstream commit", () => {
  fixture((db) => {
    db.exec(`INSERT INTO source_files VALUES
      ('c','codex','home','label','/home',100,1),
      ('d','codex','home','label','/home',100,1),
      ('e','codex','home','label','/home',100,1);
      INSERT INTO events VALUES ('c',1,'home','shared',20),('d',1,'home','shared',2),
        ('e',1,'home','shared',1),('b',1,'home','shared',20); BEGIN`);
    writeUsageSourceBaseline(db, "c", { homeId: "home", sessionId: "shared", beforeMs: 10 });
    writeUsageSourceBaseline(db, "d", { homeId: "home", sessionId: "shared", beforeMs: 2 });
    save(db, "c");
    save(db, "d");
    markUsageSourceDependents(db, "a", [{ homeId: "home", sessionId: "shared", minimumMs: 5 }]);
    db.exec("COMMIT");
    assert.deepEqual(db.prepare("SELECT source_path FROM usage_source_reparse ORDER BY source_path").all().map(r => r.source_path), ["c", "e"]);
    assert.equal(readUsageSourceProgress(db, "c"), null);
    assert.ok(readUsageSourceProgress(db, "d"));
    assert.deepEqual({ ...readUsageSourceBaseline(db, "c") }, { homeId: "home", sessionId: "shared", beforeMs: 10 });
    db.exec("BEGIN; DELETE FROM usage_source_reparse WHERE source_path='c'; ROLLBACK");
    assert.ok(db.prepare("SELECT 1 FROM usage_source_reparse WHERE source_path='c'").get());
  });
});

test("a legacy fact writer invalidates the recorded baseline in the same transaction", () => {
  fixture(db => {
    db.exec("BEGIN");
    writeUsageSourceBaseline(db, "a", { homeId: "home", sessionId: "shared", beforeMs: 10 });
    db.exec("COMMIT; BEGIN; INSERT INTO events(source_path,value) VALUES('a',1)");
    assert.equal(readUsageSourceBaseline(db, "a"), null);
    db.exec("ROLLBACK");
    assert.ok(readUsageSourceBaseline(db, "a"));
  });
});

test("many changed sessions spill while retaining exact minimum timestamps", () => {
  const bounds = new UsageSourceChangeBounds();
  try {
    for (let i = 0; i < 2_000; i++) bounds.add("home", `session-${i}`, i + 10);
    for (let i = 0; i < 2_000; i++) bounds.add("home", `session-${i}`, i);
    assert.ok(bounds.database, "the in-memory budget must cause a disk spill");
    assert.equal(bounds.entries.size, 0);
    const observed = [...bounds].sort((a, b) => a.minimumMs - b.minimumMs);
    assert.equal(observed.length, 2_000);
    for (let i = 0; i < 2_000; i++) assert.deepEqual({ ...observed[i] }, { homeId: "home", sessionId: `session-${i}`, minimumMs: i });
  } finally { bounds.close(); }
});

test("quota-only facts, source rebinding and source deletion invalidate checkpoints", () => {
  fixture(db => {
    for (const sql of [
      "INSERT INTO rate_limit_observations VALUES ('a',1)",
      "INSERT INTO quota_usage_sources VALUES ('a',1)",
      "UPDATE source_files SET home_label='renamed' WHERE path='a'",
    ]) {
      db.exec("BEGIN"); save(db); db.exec("COMMIT");
      db.exec(sql);
      assert.equal(readUsageSourceProgress(db, "a"), null, sql);
    }
    db.exec("BEGIN"); save(db); db.exec("COMMIT; DELETE FROM source_files WHERE path='a'");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM usage_source_progress").get().n, 0);
  });
});

test("invalid, oversized and incompatible cursor states cannot advance progress", () => {
  fixture(db => {
    db.exec("BEGIN");
    for (const checkpoint of [null, { ...cursor, offset: 101 }, { ...cursor, lineNumber: -1 },
      { ...cursor, format: 2 }, { ...cursor, adapter: "dsh-v4-zstd" },
      { ...cursor, state: { huge: "x".repeat(65_536) } }]) {
      save(db);
      assert.equal(save(db, "a", checkpoint), false);
      assert.equal(readUsageSourceProgress(db, "a"), null);
    }
    save(db);
    db.exec("UPDATE usage_source_progress SET checkpoint_json='broken'");
    assert.equal(readUsageSourceProgress(db, "a"), null);
    db.exec("ROLLBACK");
  });
});
