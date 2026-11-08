import assert from "node:assert/strict";
import { mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createStoredQuotaSourceResolver } from "../../src/usage-quota-source-store.js";
import { compactHistoryDatabase } from "./archive-compact-copy.mjs";

const MAX_INT64 = 9223372036854775807n;
const FIXTURE = `
  PRAGMA encoding='UTF-16le';
  PRAGMA user_version=24;
  PRAGMA application_id=12345;
  CREATE TABLE typed_rows (
    name TEXT PRIMARY KEY, payload ANY, whole INTEGER,
    doubled INTEGER GENERATED ALWAYS AS (whole * 2) STORED,
    label TEXT GENERATED ALWAYS AS ('tag:' || name) VIRTUAL
  ) STRICT;
  INSERT INTO typed_rows(rowid,name,payload,whole) VALUES
    (-17,'blob',X'00FF807F',3), (0,'null',NULL,NULL),
    (42,'real',1.0,-2), (101,'fraction',0.1,0),
    (9007199254740993,'integer',9223372036854775807,4),
    (9223372036854775807,'text','中文😀' || char(0) || '001',5);
  CREATE INDEX typed_expression_idx ON typed_rows(lower(name)) WHERE payload IS NOT NULL;
  CREATE TABLE keyed (
    account TEXT COLLATE NOCASE, ordinal INTEGER, payload BLOB,
    PRIMARY KEY(account,ordinal DESC)
  ) WITHOUT ROWID;
  INSERT INTO keyed VALUES ('甲',9,X'00FF'),('a',-3,NULL),('a',7,X'');
  CREATE TABLE "odd"" table" (rowid TEXT, _ROWID_ INTEGER, payload TEXT);
  INSERT INTO "odd"" table"(oid,rowid,_ROWID_,payload)
    VALUES (-501,'ordinary-column',13,'负值'),(77,'other',-4,'gap');
  CREATE TABLE serial (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT UNIQUE);
  INSERT INTO serial VALUES (-5,'negative'),(4,'keep'),(6000,'deleted-high');
  DELETE FROM serial WHERE id=6000;
  CREATE TABLE serial_empty (id INTEGER PRIMARY KEY AUTOINCREMENT);
  INSERT INTO serial_empty VALUES (91);
  DELETE FROM serial_empty;
  UPDATE sqlite_sequence SET rowid=-8 WHERE name='serial';
  UPDATE sqlite_sequence SET rowid=70 WHERE name='serial_empty';
  CREATE TABLE audit_count (id INTEGER PRIMARY KEY, hits INTEGER NOT NULL);
  INSERT INTO audit_count VALUES (1,0);
  CREATE TABLE events (id INTEGER PRIMARY KEY, timestamp_ms INTEGER, amount REAL NOT NULL);
  CREATE TRIGGER count_events AFTER INSERT ON events
    BEGIN UPDATE audit_count SET hits=hits+1 WHERE id=1; END;
  INSERT INTO events VALUES (40,30,1.0),(9223372036854775807,20,-1.0e16),(-7,10,1.0e16);
  CREATE VIEW event_view AS SELECT id,amount FROM events WHERE timestamp_ms>=20;
  CREATE TABLE quota_usage_sources (
    source_path TEXT, home_id TEXT, session_id TEXT, timestamp_ms INTEGER,
    quota_source TEXT, until_ms INTEGER,
    PRIMARY KEY(source_path,session_id,timestamp_ms)
  ) STRICT;
  INSERT INTO quota_usage_sources(rowid,source_path,home_id,session_id,timestamp_ms,quota_source,until_ms)
    VALUES (100,'a-plan','home','session',10,'plan',0),
           (7,'z-credits','home','session',10,'credits',100),
           (-11,'old','home','session',5,'external',0),
           (9223372036854775807,'other','other-home','session',10,'api',0);
  PRAGMA schema_version=73;
`;

const ROW_QUERIES = [
  "SELECT rowid,*,typeof(payload) AS storage,hex(payload) AS bytes FROM typed_rows ORDER BY rowid",
  "SELECT *,typeof(payload) AS storage FROM keyed ORDER BY account,ordinal",
  'SELECT oid AS hidden_rowid,* FROM "odd"" table" ORDER BY oid',
  "SELECT rowid,* FROM serial ORDER BY rowid",
  "SELECT rowid,* FROM serial_empty ORDER BY rowid",
  "SELECT rowid,* FROM sqlite_sequence ORDER BY rowid",
  "SELECT rowid,* FROM audit_count ORDER BY rowid",
  "SELECT rowid,*,typeof(amount) AS storage FROM events ORDER BY id",
  "SELECT rowid,* FROM quota_usage_sources ORDER BY rowid",
  "SELECT * FROM event_view ORDER BY id",
];

function rows(database, sql) {
  const statement = database.prepare(sql);
  statement.setReadBigInts(true);
  return statement.all();
}

async function fixture(t, sql = FIXTURE) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "archive-compact-copy-test-"));
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  const sourceFile = path.join(directory, "source #1.sqlite");
  const destinationFile = path.join(directory, "copy.sqlite");
  const database = new DatabaseSync(sourceFile);
  try { database.exec(sql); } finally { database.close(); }
  return { directory, sourceFile, destinationFile, bytes: await readFile(sourceFile), mtimeMs: (await stat(sourceFile)).mtimeMs };
}

async function unchanged(source, names = ["source #1.sqlite", "copy.sqlite"]) {
  assert.deepEqual(await readFile(source.sourceFile), source.bytes, "source bytes changed");
  assert.equal((await stat(source.sourceFile)).mtimeMs, source.mtimeMs, "source was rewritten");
  assert.deepEqual((await readdir(source.directory)).sort(), [...names].sort(), "unexpected temporary/journal files");
}

test("exact SQL values, all row identities, generated columns and schema survive compaction", async (t) => {
  const source = await fixture(t);
  await compactHistoryDatabase(source.sourceFile, source.destinationFile);
  const before = new DatabaseSync(source.sourceFile, { readOnly: true });
  const after = new DatabaseSync(source.destinationFile, { readOnly: true });
  try {
    assert.deepEqual(rows(before, "SELECT rowid FROM typed_rows ORDER BY rowid").map((row) => row.rowid),
      [-17n, 0n, 42n, 101n, 9007199254740993n, MAX_INT64]);
    assert.deepEqual(rows(before, "SELECT typeof(payload) AS storage FROM typed_rows ORDER BY rowid").map((row) => row.storage),
      ["blob", "null", "real", "real", "integer", "text"]);
    for (const sql of ROW_QUERIES) assert.deepEqual(rows(after, sql), rows(before, sql), sql);
    const schema = "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name";
    assert.deepEqual(rows(after, schema), rows(before, schema));
    for (const sql of ["PRAGMA table_xinfo(typed_rows)", "PRAGMA table_xinfo(keyed)", "PRAGMA index_list(typed_rows)",
      "PRAGMA index_xinfo(typed_expression_idx)", "PRAGMA user_version", "PRAGMA application_id", "PRAGMA encoding"]) {
      assert.deepEqual(rows(after, sql), rows(before, sql), sql);
    }
    assert.equal(after.prepare("PRAGMA journal_mode").get().journal_mode, "delete");
    assert.equal(after.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(rows(after, "PRAGMA schema_version"), rows(before, "PRAGMA schema_version"), "schema cookie changed");
  } finally {
    before.close(); after.close();
    await unchanged(source);
  }
});

test("quota ties, original event-id float accumulation, triggers and deleted sequence maxima retain behavior", async (t) => {
  const source = await fixture(t);
  await compactHistoryDatabase(source.sourceFile, source.destinationFile);
  const before = new DatabaseSync(source.sourceFile, { readOnly: true });
  const after = new DatabaseSync(source.destinationFile);
  try {
    for (const database of [before, after]) {
      const resolve = createStoredQuotaSourceResolver(database, null);
      assert.equal(resolve("home", "session", 20), "plan");
      assert.equal(resolve("home", "another-session", 20), "unknown");
      assert.deepEqual(rows(database, "SELECT rowid FROM quota_usage_sources WHERE home_id='home' ORDER BY timestamp_ms DESC,rowid DESC")
        .map((row) => row.rowid), [100n, 7n, -11n]);
      const byId = rows(database, "SELECT id,amount FROM events ORDER BY id");
      assert.deepEqual(byId.map((row) => row.id), [-7n, 40n, MAX_INT64]);
      assert.equal(byId.reduce((total, row) => total + row.amount, 0), 0);
      // Reordering these same amounts changes the exact JS total, making this fixture discriminating.
      assert.equal(rows(database, "SELECT amount FROM events ORDER BY timestamp_ms,id")
        .reduce((total, row) => total + row.amount, 0), 1);
      assert.equal(database.prepare("SELECT hits FROM audit_count").get().hits, 3, "load replayed the user trigger");
    }
    after.exec("INSERT INTO events VALUES (41,40,2.0)");
    assert.equal(after.prepare("SELECT hits FROM audit_count").get().hits, 4, "copied trigger no longer works");
    assert.equal(after.prepare("INSERT INTO serial(value) VALUES ('next') RETURNING id").get().id, 6001);
    assert.equal(after.prepare("INSERT INTO serial_empty DEFAULT VALUES RETURNING id").get().id, 92);
  } finally {
    before.close(); after.close();
    await unchanged(source);
  }
});

test("existing destination and source-as-destination are rejected without changing either file", async (t) => {
  const source = await fixture(t, "CREATE TABLE facts(value TEXT); INSERT INTO facts VALUES ('source');");
  const sentinel = Buffer.from("existing destination must survive\0", "utf8");
  await writeFile(source.destinationFile, sentinel);
  await assert.rejects(() => compactHistoryDatabase(source.sourceFile, source.destinationFile));
  assert.deepEqual(await readFile(source.destinationFile), sentinel);
  await assert.rejects(() => compactHistoryDatabase(source.sourceFile, source.sourceFile));
  await unchanged(source);
});

test("virtual, inaccessible-rowid and unsupported internal tables fail explicitly without publishing", async (t) => {
  for (const [name, sql, error] of [
    ["virtual", "CREATE VIRTUAL TABLE documents USING fts5(body); INSERT INTO documents VALUES ('tiny');", /virtual|shadow/i],
    ["hidden rowid", "CREATE TABLE hidden(rowid TEXT,_ROWID_ TEXT,OID TEXT); INSERT INTO hidden VALUES ('a','b','c');", /rowid/i],
    ["internal", "ANALYZE;", /internal|sqlite_stat/i],
  ]) {
    await t.test(name, async (t) => {
      const source = await fixture(t, `CREATE TABLE facts(value TEXT); INSERT INTO facts VALUES ('kept'); ${sql}`);
      await assert.rejects(() => compactHistoryDatabase(source.sourceFile, source.destinationFile), error);
      await unchanged(source, ["source #1.sqlite"]);
    });
  }
});

test("fsync precedes publication; sync failure and a competing destination preserve source and target", async (t) => {
  for (const fault of ["none", "sync", "destination-race"]) {
    await t.test(fault, async (t) => {
      const source = await fixture(t, "CREATE TABLE facts(value TEXT); INSERT INTO facts VALUES ('kept');");
      const probe = await open(source.sourceFile, "r");
      const prototype = Object.getPrototypeOf(probe);
      const originalSync = prototype.sync;
      await probe.close();
      const failure = new Error("injected fsync failure");
      const sentinel = Buffer.from("concurrent destination");
      let syncs = 0;
      const mock = t.mock.method(prototype, "sync", async function () {
        syncs++;
        await assert.rejects(() => stat(source.destinationFile), { code: "ENOENT" });
        if (fault === "sync") throw failure;
        await originalSync.call(this);
        if (fault === "destination-race") await writeFile(source.destinationFile, sentinel, { flag: "wx" });
      });
      try {
        if (fault === "none") await compactHistoryDatabase(source.sourceFile, source.destinationFile);
        else await assert.rejects(() => compactHistoryDatabase(source.sourceFile, source.destinationFile),
          fault === "sync" ? (error) => error === failure : { code: "EEXIST" });
        assert.equal(syncs, 1, "successful publication must await a file fsync");
        if (fault === "destination-race") assert.deepEqual(await readFile(source.destinationFile), sentinel);
        await unchanged(source, fault === "sync" ? ["source #1.sqlite"] : ["source #1.sqlite", "copy.sqlite"]);
      } finally { mock.mock.restore(); }
    });
  }
});
