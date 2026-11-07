import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ensureHistoryProjectionTracking,
  readHistoryProjectionStamp,
  sameHistoryProjectionStamp,
  recordHistoryProjectionBatch,
  historyProjectionBatches,
  certifyHistoryProjectionBaseline,
} from "../src/usage-history-projection-store.js";

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "history-projection-inputs-"));
  const file = path.join(directory, "source.sqlite"),
    db = new DatabaseSync(file);
  db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,source_path TEXT NOT NULL);
    CREATE TABLE usage_business_revision(singleton INTEGER PRIMARY KEY,revision INTEGER NOT NULL);
    INSERT INTO usage_business_revision VALUES(1,0);
    CREATE TRIGGER fact_revision AFTER INSERT ON events BEGIN UPDATE usage_business_revision SET revision=revision+1; END;
    CREATE TABLE source_files(path TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE archive_segments(segment_id TEXT PRIMARY KEY);
    CREATE TABLE rate_limit_observations(source_path TEXT);
    CREATE TABLE quota_usage_sources(source_path TEXT);
    CREATE TABLE store_meta(key TEXT PRIMARY KEY,value TEXT);`);
  ensureHistoryProjectionTracking(db);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { db, file };
}

test("completed setup is read-only and a source receipt commits or rolls back with facts", (t) => {
  const { db } = fixture(t),
    before = readHistoryProjectionStamp(db);
  const changes = db.prepare("SELECT total_changes() n").get().n;
  ensureHistoryProjectionTracking(db);
  assert.equal(db.prepare("SELECT total_changes() n").get().n, changes);
  assert.ok(sameHistoryProjectionStamp(before, readHistoryProjectionStamp(db)));
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO events VALUES(1,?)").run("source-a");
  const next = recordHistoryProjectionBatch(db, before, { sources: ["source-a", "source-a"], mode: "append" });
  assert.equal(historyProjectionBatches(db, before, next).length, 1);
  db.exec("ROLLBACK");
  assert.ok(sameHistoryProjectionStamp(before, readHistoryProjectionStamp(db)));
  assert.deepEqual(historyProjectionBatches(db, before), []);
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO events VALUES(1,?)").run("source-a");
  recordHistoryProjectionBatch(db, before, { sources: ["source-a", "source-a"], mode: "append" });
  db.exec("COMMIT");
  assert.deepEqual(historyProjectionBatches(db, before), [{ mode: "append", sources: ["source-a"] }]);
  assert.throws(() => recordHistoryProjectionBatch(db, before), /facts transaction/);
});

test("external fact and auxiliary commits leave a detectable gap, including after reopen", (t) => {
  const { db, file } = fixture(t),
    before = readHistoryProjectionStamp(db);
  const external = new DatabaseSync(file);
  try {
    external.exec("INSERT INTO events VALUES(1,'external'); INSERT INTO rate_limit_observations VALUES('external')");
    assert.equal(historyProjectionBatches(db, before), null);
    const stale = readHistoryProjectionStamp(db);
    db.exec("BEGIN");
    db.exec("INSERT INTO source_files VALUES('known','next')");
    recordHistoryProjectionBatch(db, stale, { sources: ["known"], mode: "replace" });
    db.exec("COMMIT");
    assert.equal(
      historyProjectionBatches(external, before),
      null,
      "a later known commit must not cover an earlier gap",
    );
    const captured = readHistoryProjectionStamp(db);
    const certified = certifyHistoryProjectionBaseline(db, captured);
    assert.notEqual(certified.token, captured.token);
    assert.equal(historyProjectionBatches(db, captured), null);
    assert.deepEqual(historyProjectionBatches(external, certified), []);
    external.exec("UPDATE source_files SET value='old-client-change' WHERE path='known'");
    assert.equal(historyProjectionBatches(db, certified), null);
    assert.equal(certifyHistoryProjectionBaseline(db, certified), null, "cannot certify a stale capture");
  } finally {
    external.close();
  }
});

test("repaired tracking revokes old certificates and irrelevant status metadata causes no batch", (t) => {
  const { db } = fixture(t),
    before = readHistoryProjectionStamp(db);
  db.exec("INSERT INTO store_meta VALUES('generated_at','now')");
  assert.ok(sameHistoryProjectionStamp(before, readHistoryProjectionStamp(db)));
  db.exec("DROP TRIGGER usage_history_input_source_files_UPDATE");
  ensureHistoryProjectionTracking(db);
  const repaired = readHistoryProjectionStamp(db);
  assert.notEqual(repaired.instance, before.instance);
  assert.equal(historyProjectionBatches(db, before), null);
  db.exec("INSERT INTO store_meta VALUES('history_archive_event_authority','changed')");
  assert.equal(historyProjectionBatches(db, repaired), null);
});

test("an unread change log stays bounded and falls back when its coverage was pruned", (t) => {
  const { db } = fixture(t),
    first = readHistoryProjectionStamp(db);
  db.exec("BEGIN");
  let recent;
  for (let index = 0; index < 1030; index++) {
    const before = readHistoryProjectionStamp(db);
    db.prepare("INSERT INTO events VALUES(?,?)").run(index, "source-a");
    const next = recordHistoryProjectionBatch(db, before, { sources: ["source-a"], mode: "append" });
    if (index === 1028) recent = next;
  }
  db.exec("COMMIT");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM usage_history_projection_batches").get().n, 1024);
  assert.equal(historyProjectionBatches(db, first), null);
  assert.deepEqual(historyProjectionBatches(db, recent), [{ mode: "append", sources: ["source-a"] }]);
});
