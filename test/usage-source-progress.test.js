import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

function fixture(run, databaseFile = ":memory:") {
  const db = new DatabaseSync(databaseFile);
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
  fixture((db) => {
    assert.throws(() => save(db), /facts write transaction/);
    db.exec("BEGIN; INSERT INTO events(source_path,value) VALUES ('a',42)");
    assert.ok(save(db));
    assert.deepEqual(readUsageSourceProgress(db, "a"), { checkpoint: cursor, validation: proof });
    db.exec("ROLLBACK");
    assert.equal(readUsageSourceProgress(db, "a"), null);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events").get().n, 0);
  });
});

test("source progress reuses three statements per database without retaining rows or returned objects", () => {
  fixture((db) =>
    fixture((other) => {
      let prepares = 0;
      const database = {
        prepare(sql) {
          prepares++;
          return db.prepare(sql);
        },
      };
      assert.equal(readUsageSourceProgress(database, "a"), null);
      db.exec("BEGIN");
      save(db);
      save(db, "b", { ...cursor, adapter: "dsh-v4-zstd" });
      db.exec("COMMIT");
      other.exec("BEGIN");
      save(other, "a", { ...cursor, offset: 80 });
      other.exec("COMMIT");
      const result = readUsageSourceProgress(database, "a");
      assert.deepEqual(result, { checkpoint: cursor, validation: proof });
      result.checkpoint.state.cumulative = -1;
      result.validation.prefixBytes = -1;
      assert.deepEqual(readUsageSourceProgress(database, "a"), { checkpoint: cursor, validation: proof });
      assert.equal(readUsageSourceProgress(database, "b").checkpoint.adapter, "dsh-v4-zstd");
      assert.equal(readUsageSourceProgress(other, "a").checkpoint.offset, 80);
      assert.equal(prepares, 3);
    }),
  );
});

test("cached progress observes checkpoint changes and pending/clear changes through rollback", () => {
  fixture((db) => {
    db.exec("BEGIN");
    save(db);
    db.exec("COMMIT");
    assert.deepEqual(readUsageSourceProgress(db, "a"), { checkpoint: cursor, validation: proof });
    const checkpoint = { ...cursor, offset: 95 };
    db.exec("BEGIN");
    save(db, "a", checkpoint);
    assert.deepEqual(readUsageSourceProgress(db, "a"), { checkpoint, validation: proof });
    db.exec("INSERT INTO usage_source_reparse VALUES ('a')");
    assert.equal(readUsageSourceProgress(db, "a"), null);
    db.exec("DELETE FROM usage_source_reparse WHERE source_path='a'");
    assert.deepEqual(readUsageSourceProgress(db, "a"), { checkpoint, validation: proof });
    db.exec("ROLLBACK");
    assert.deepEqual(readUsageSourceProgress(db, "a"), { checkpoint: cursor, validation: proof });
    db.exec("INSERT INTO usage_source_reparse VALUES ('a'); BEGIN; DELETE FROM usage_source_reparse");
    assert.ok(readUsageSourceProgress(db, "a"));
    db.exec("ROLLBACK");
    assert.equal(readUsageSourceProgress(db, "a"), null);
    db.exec("DELETE FROM usage_source_reparse");
    assert.ok(readUsageSourceProgress(db, "a"));
  });
});

test("cached progress rejects changed bindings and invalid persisted JSON shapes on every read", () => {
  fixture((db) => {
    db.exec("BEGIN");
    save(db);
    assert.ok(readUsageSourceProgress(db, "a"));
    for (const [column, value] of [
      ["source_binding", "wrong"],
      ["checkpoint_json", "broken"],
      ["checkpoint_json", JSON.stringify({ ...cursor, offset: 101 })],
      ["checkpoint_json", JSON.stringify({ ...cursor, adapter: "dsh-v4-zstd" })],
      ["checkpoint_json", JSON.stringify({ ...cursor, state: [] })],
      ["validation_json", "broken"],
      ["validation_json", "null"],
      ["validation_json", "[]"],
      ["validation_json", "42"],
    ]) {
      db.prepare(`UPDATE usage_source_progress SET ${column}=? WHERE source_path='a'`).run(value);
      assert.equal(readUsageSourceProgress(db, "a"), null, `${column}=${value}`);
      save(db);
      assert.deepEqual(readUsageSourceProgress(db, "a"), { checkpoint: cursor, validation: proof });
    }
    db.exec("ROLLBACK");
  });
});

test("cached progress reads external commits within the current SQLite snapshot", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "usage-source-progress-snapshot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "index.sqlite");
  fixture((db) => {
    db.exec("PRAGMA journal_mode=WAL; BEGIN");
    save(db);
    db.exec("COMMIT");
    const writer = new DatabaseSync(file);
    try {
      assert.deepEqual(readUsageSourceProgress(db, "a"), { checkpoint: cursor, validation: proof });
      const checkpoint = { ...cursor, offset: 95 };
      const validation = { ...proof, prefixBytes: 95 };
      writer.exec("BEGIN");
      writeUsageSourceProgress(writer, "a", checkpoint, validation);
      writer.exec("COMMIT");
      assert.deepEqual(readUsageSourceProgress(db, "a"), { checkpoint, validation });
      db.exec("BEGIN");
      assert.deepEqual(readUsageSourceProgress(db, "a"), { checkpoint, validation });
      writer.exec("INSERT INTO usage_source_reparse VALUES ('a')");
      assert.deepEqual(readUsageSourceProgress(db, "a"), { checkpoint, validation });
      db.exec("ROLLBACK");
      assert.equal(readUsageSourceProgress(db, "a"), null);
      writer.exec("DELETE FROM usage_source_reparse");
      assert.deepEqual(readUsageSourceProgress(db, "a"), { checkpoint, validation });
      writer.exec("UPDATE usage_source_progress SET source_binding='wrong'");
      assert.equal(readUsageSourceProgress(db, "a"), null);
      writer.exec("BEGIN");
      save(writer);
      writer.exec("COMMIT; INSERT INTO events(source_path,value) VALUES ('a',1)");
      assert.equal(readUsageSourceProgress(db, "a"), null);
    } finally {
      writer.close();
    }
  }, file);
});

test("cached progress recovers a finalized statement after reopening the same database object", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "usage-source-progress-reopen-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  fixture(
    (db) => {
      db.exec("BEGIN");
      save(db);
      db.exec("COMMIT");
      assert.deepEqual(readUsageSourceProgress(db, "a"), { checkpoint: cursor, validation: proof });
      db.close();
      db.open();
      assert.deepEqual(readUsageSourceProgress(db, "a"), { checkpoint: cursor, validation: proof });
      db.close();
      try {
        assert.throws(() => readUsageSourceProgress(db, "a"), {
          code: "ERR_INVALID_STATE",
          message: "database is not open",
        });
      } finally {
        db.open();
      }
      assert.deepEqual(readUsageSourceProgress(db, "a"), { checkpoint: cursor, validation: proof });
    },
    path.join(root, "index.sqlite"),
  );
});

test("cached progress only retries a finalized cache hit once and preserves other database errors", () => {
  const finalized = Object.assign(new Error("statement has been finalized"), { code: "ERR_INVALID_STATE" });
  fixture((db) => {
    db.exec("BEGIN");
    save(db);
    db.exec("COMMIT");
    for (const error of [
      Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 }),
      Object.assign(new Error("other invalid state"), { code: "ERR_INVALID_STATE" }),
      finalized,
    ]) {
      for (let failedStatement = 0; failedStatement < 3; failedStatement++) {
        let prepares = 0,
          gets = 0,
          fail = false;
        const database = {
          prepare(sql) {
            const index = prepares++ % 3;
            const statement = db.prepare(sql);
            return {
              get(...parameters) {
                gets++;
                if (fail && index === failedStatement) throw error;
                return statement.get(...parameters);
              },
            };
          },
        };
        assert.deepEqual(readUsageSourceProgress(database, "a"), { checkpoint: cursor, validation: proof });
        fail = true;
        assert.throws(
          () => readUsageSourceProgress(database, "a"),
          (caught) => caught === error,
        );
        assert.equal(prepares, error === finalized ? 6 : 3);
        assert.equal(gets, 3 + (failedStatement + 1) * (error === finalized ? 2 : 1));
      }
    }
  });
});

test("a writer that knows nothing about cursors invalidates only the affected source", () => {
  fixture((db) => {
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
    assert.deepEqual(
      db
        .prepare("SELECT source_path FROM usage_source_reparse ORDER BY source_path")
        .all()
        .map((r) => r.source_path),
      ["c", "e"],
    );
    assert.equal(readUsageSourceProgress(db, "c"), null);
    assert.ok(readUsageSourceProgress(db, "d"));
    assert.deepEqual({ ...readUsageSourceBaseline(db, "c") }, { homeId: "home", sessionId: "shared", beforeMs: 10 });
    db.exec("BEGIN; DELETE FROM usage_source_reparse WHERE source_path='c'; ROLLBACK");
    assert.ok(db.prepare("SELECT 1 FROM usage_source_reparse WHERE source_path='c'").get());
  });
});

test("only a matching recorded baseline can exclude equal-time or mixed-session dependencies", () => {
  fixture((db) => {
    const paths = ["known-equal", "known-later", "legacy-equal", "mixed", "other-home"];
    for (const source of paths) {
      db.prepare("INSERT INTO source_files VALUES (?,'codex','home','label','/home',100,1)").run(source);
      db.prepare("INSERT INTO events VALUES (?,1,'home','shared',?)").run(source, source === "legacy-equal" ? 5 : 1);
    }
    db.exec("INSERT INTO events VALUES ('mixed',1,'home','other',2); BEGIN");
    writeUsageSourceBaseline(db, "known-equal", { homeId: "home", sessionId: "shared", beforeMs: 5 });
    writeUsageSourceBaseline(db, "known-later", { homeId: "home", sessionId: "shared", beforeMs: 10 });
    writeUsageSourceBaseline(db, "mixed", { homeId: "home", sessionId: "other", beforeMs: 2 });
    writeUsageSourceBaseline(db, "other-home", { homeId: "other", sessionId: "shared", beforeMs: 2 });
    for (const source of paths) save(db, source);
    markUsageSourceDependents(db, "a", [{ homeId: "home", sessionId: "shared", minimumMs: 5 }]);
    db.exec("COMMIT");
    assert.deepEqual(
      db
        .prepare("SELECT source_path FROM usage_source_reparse ORDER BY source_path")
        .all()
        .map((row) => row.source_path),
      ["known-later", "legacy-equal", "mixed", "other-home"],
    );
    assert.ok(readUsageSourceProgress(db, "known-equal"), "timestamp < beforeMs excludes an equal-time change");
    for (const source of paths.filter((source) => source !== "known-equal")) {
      assert.equal(readUsageSourceProgress(db, source), null);
    }
  });
});

test("a legacy fact writer invalidates the recorded baseline in the same transaction", () => {
  fixture((db) => {
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
    for (let i = 0; i < 2_000; i++)
      assert.deepEqual({ ...observed[i] }, { homeId: "home", sessionId: `session-${i}`, minimumMs: i });
  } finally {
    bounds.close();
  }
});

test("quota-only facts, source rebinding and source deletion invalidate checkpoints", () => {
  fixture((db) => {
    for (const sql of [
      "INSERT INTO rate_limit_observations VALUES ('a',1)",
      "INSERT INTO quota_usage_sources VALUES ('a',1)",
      "UPDATE source_files SET home_label='renamed' WHERE path='a'",
    ]) {
      db.exec("BEGIN");
      save(db);
      db.exec("COMMIT");
      db.exec(sql);
      assert.equal(readUsageSourceProgress(db, "a"), null, sql);
    }
    db.exec("BEGIN");
    save(db);
    db.exec("COMMIT; DELETE FROM source_files WHERE path='a'");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM usage_source_progress").get().n, 0);
  });
});

test("invalid, oversized and incompatible cursor states cannot advance progress", () => {
  fixture((db) => {
    db.exec("BEGIN");
    for (const checkpoint of [
      null,
      { ...cursor, offset: 101 },
      { ...cursor, lineNumber: -1 },
      { ...cursor, format: 2 },
      { ...cursor, adapter: "dsh-v4-zstd" },
      { ...cursor, state: { huge: "x".repeat(65_536) } },
    ]) {
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
