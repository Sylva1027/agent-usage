import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { UsageHistoryQuery } from "../src/usage-history-query.js";
import { UsageSourceRows } from "../src/usage-source-rows.js";

const columns = ["timestamp_ms", "source_path", "value", "day_key"];
const canonical = (row, excluded) =>
  Object.fromEntries(
    Object.keys(row)
      .filter((key) => !excluded.includes(key))
      .sort()
      .map((key) => [key, row[key]]),
  );
const fact = (value, ms = 10, source = "source") => ({
  timestamp_ms: ms,
  source_path: source,
  value,
  day_key: "raw-day",
});
const raw = (query) =>
  query.database
    .prepare("SELECT rowid AS raw_id,* FROM history_query_rows ORDER BY rowid")
    .all()
    .map((row) => ({ ...row }));
const events = (query) =>
  query.database
    .prepare("SELECT * FROM events ORDER BY id")
    .all()
    .map((row) => ({ ...row }));
const none = { added: 0, removed: 0, scanned: 0, sorted: 0, dirty: null };
const dirty = (ms) => ({ ms, id: Number.MIN_SAFE_INTEGER });

function fixture(t, hot = []) {
  const root = mkdtempSync(path.join(tmpdir(), "history-query-persistent-"));
  const file = path.join(root, "projection.sqlite");
  const source = new DatabaseSync(":memory:");
  source.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY, timestamp_ms INTEGER NOT NULL, source_path TEXT NOT NULL,
    value TEXT NOT NULL, day_key TEXT NOT NULL
  ) STRICT`);
  const insert = source.prepare(`INSERT INTO events (${columns}) VALUES (?,?,?,?)`);
  for (const row of hot) insert.run(...columns.map((name) => row[name]));
  const result = { root, file, source, query: null };
  t.after(() => {
    result.query?.close();
    source.close();
    rmSync(root, { recursive: true, force: true });
  });
  result.query = new UsageHistoryQuery(source, canonical, { databaseFile: file });
  return result;
}

function audit(query) {
  query.database.exec("CREATE TEMP TABLE writes(table_name TEXT,operation TEXT,id INTEGER)");
  for (const table of ["events", "history_query_rows"]) {
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      query.database.exec(`CREATE TEMP TRIGGER audit_${table}_${operation} AFTER ${operation} ON ${table}
        BEGIN INSERT INTO writes VALUES ('${table}','${operation}',${operation === "DELETE" ? "old" : "new"}.rowid); END`);
    }
  }
  return (table, operation) =>
    query.database
      .prepare("SELECT id FROM writes WHERE table_name=? AND operation=? ORDER BY id")
      .all(table, operation)
      .map((row) => Number(row.id));
}

test("persistent initial finish matches anonymous order and retains exact canonical payloads and mappings", (t) => {
  const { query, source } = fixture(t, [fact("hot", 20)]);
  const anonymous = new UsageHistoryQuery(source, canonical);
  t.after(() => anonymous.close());
  const rows = ["\ue000", "𐀀", "é", "e\u0301", "\ud800", "\ud801", "\udc00", "�", "\0", "\\ud800"].map((value) => ({
    id: 1,
    ...fact(value),
  }));
  rows.push({ id: 1, ...fact("é") }, { id: 1, ...fact("early", 5) });
  query.add(rows, "cold");
  anonymous.add(rows, "cold");
  const project = (row) => ({ ...row, day_key: `display-${row.timestamp_ms}` });
  assert.equal(query.finish(columns, project), query.database);
  anonymous.finish(columns, project);
  const persisted = events(query);
  assert.deepEqual(
    persisted.map(({ history_ordinal, ...row }) => row),
    events(anonymous),
  );
  let ordinal = 0;
  for (const [index, row] of persisted.entries()) {
    if (row.timestamp_ms !== persisted[index - 1]?.timestamp_ms) ordinal = 0;
    assert.equal(row.history_ordinal, ordinal++);
    assert.equal(row.day_key, `display-${row.timestamp_ms}`);
  }
  const original = [...rows, fact("hot", 20)].map((row) => JSON.stringify(canonical(row, ["id"])));
  assert.deepEqual(
    raw(query)
      .map((row) => row.payload)
      .sort(),
    original.sort(),
  );
  const logical = query.database
    .prepare(`SELECT r.payload,r.source_path,e.id FROM events e
    JOIN history_query_rows r ON r.event_id=e.id ORDER BY e.timestamp_ms,e.history_ordinal`)
    .all();
  assert.equal(logical.length, original.length);
  assert.deepEqual(
    logical.map((row) => row.payload),
    original.sort((a, b) => JSON.parse(a).timestamp_ms - JSON.parse(b).timestamp_ms || (a < b ? -1 : a > b ? 1 : 0)),
  );
  assert.ok(logical.every((row) => JSON.parse(row.payload).day_key === "raw-day" && row.source_path === "source"));
  assert.equal(query.database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(query.database.prepare("PRAGMA synchronous").get().synchronous, 2);
  assert.equal(
    anonymous.database
      .prepare("PRAGMA table_info(events)")
      .all()
      .some((row) => row.name === "history_ordinal"),
    false,
  );
  assert.equal(
    anonymous.database.prepare("SELECT 1 FROM sqlite_master WHERE name='history_query_rows'").get(),
    undefined,
  );
  assert.deepEqual(query.finishChanges(columns), none);
});

test("existing mode reopens only a completed file without reading source or creating a missing file", (t) => {
  const input = fixture(t, [fact("hot")]);
  input.query.finish(columns);
  const before = { raw: raw(input.query), events: events(input.query) };
  input.query.close();
  input.source.exec("INSERT INTO events VALUES (99,99,'other','must not capture','raw-day')");
  input.query = new UsageHistoryQuery(null, canonical, { databaseFile: input.file, existing: true });
  assert.deepEqual({ raw: raw(input.query), events: events(input.query) }, before);
  assert.deepEqual(input.query.finishChanges(columns), none);
  const missing = path.join(input.root, "missing.sqlite");
  assert.throws(() => new UsageHistoryQuery(null, canonical, { databaseFile: missing, existing: true }), /missing/);
  assert.equal(existsSync(missing), false);
  assert.throws(() => new UsageHistoryQuery(null, canonical, { existing: true }), /missing/);
});

test("reopening a persistent query waits for another connection's temporary exclusive lock", async (t) => {
  const input = fixture(t, [fact("hot")]);
  input.query.finish(columns);
  const before = events(input.query);
  input.query.close();
  input.query = null;
  const worker = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(workerData);
    database.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
    parentPort.postMessage('locked');
    parentPort.once('message', () => setTimeout(() => {
      database.exec('COMMIT');
      database.close();
      parentPort.close();
    }, 300));`,
    { eval: true, workerData: input.file },
  );
  try {
    const exited = once(worker, "exit");
    assert.deepEqual(await once(worker, "message"), ["locked"]);
    worker.postMessage("release");
    input.query = new UsageHistoryQuery(null, canonical, { databaseFile: input.file, existing: true });
    assert.deepEqual(events(input.query), before);
    assert.equal(input.query.database.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
    assert.deepEqual(await exited, [0]);
  } finally {
    await worker.terminate();
  }
});

test("initial event indexes survive an interrupted bulk build and are installed with its facts", (t) => {
  const input = fixture(t, [fact("hot", 20)]);
  input.query.close();
  input.source.exec("CREATE INDEX events_value_idx ON events(value)");
  const file = path.join(input.root, "bulk.sqlite");
  input.query = new UsageHistoryQuery(input.source, canonical, { databaseFile: file });
  const indexExists = () =>
    Boolean(
      input.query.database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='events_value_idx'").get(),
    );
  assert.equal(indexExists(), false);
  assert.equal(input.query.database.prepare("PRAGMA wal_autocheckpoint").get().wal_autocheckpoint, 0);
  assert.equal(input.query.database.prepare("PRAGMA synchronous").get().synchronous, 2);
  input.query.close();
  input.query = new UsageHistoryQuery(null, canonical, { databaseFile: file, existing: true });
  assert.throws(
    () =>
      input.query.finish(columns, () => {
        throw new Error("interrupted");
      }),
    /interrupted/,
  );
  assert.equal(indexExists(), false);
  assert.equal(events(input.query).length, 0);
  input.query.finish(columns);
  assert.equal(indexExists(), true);
  assert.equal(events(input.query).length, 1);
  assert.equal(input.query.database.prepare("PRAGMA wal_autocheckpoint").get().wal_autocheckpoint, 1000);
  assert.equal(input.query.database.prepare("PRAGMA wal_checkpoint(PASSIVE)").get().busy, 0);
  assert.equal(
    input.query.database.prepare("SELECT 1 FROM sqlite_master WHERE name='history_query_pending_indexes'").get(),
    undefined,
  );
  assert.deepEqual(input.query.finishChanges(columns), none);
});

test("a failed final checkpoint preserves its error and committed mappings recover on reopen", (t) => {
  const input = fixture(t, [fact("hot")]);
  const execute = input.query.database.exec;
  const mocked = t.mock.method(input.query.database, "exec", function (sql) {
    if (sql === "PRAGMA wal_checkpoint(TRUNCATE)") throw new Error("checkpoint disk error");
    return execute.call(this, sql);
  });
  assert.throws(() => input.query.finish(columns), /checkpoint disk error/);
  assert.equal(input.query.database.isTransaction, false);
  assert.equal(events(input.query).length, 1);
  mocked.mock.restore();
  input.query.close();
  input.query = new UsageHistoryQuery(null, canonical, { databaseFile: input.file, existing: true });
  assert.equal(input.query.database.prepare("PRAGMA synchronous").get().synchronous, 2);
  assert.equal(input.query.database.prepare("PRAGMA wal_autocheckpoint").get().wal_autocheckpoint, 1000);
  assert.deepEqual(input.query.finishChanges(columns), none);
  assert.equal(events(input.query).length, 1);
});

test("source multiset replacement preserves matched IDs and writes only exact net changes", (t) => {
  const { query } = fixture(t);
  const a = fact("a"),
    b = fact("b"),
    c = fact("c", 20);
  query.add([a, a, a, b, c], "cold");
  query.add([a], "other-segment");
  query.add([fact("other", 10, "other-source")], "cold");
  query.finish(columns);
  const before = raw(query);
  const writes = audit(query);
  query.database.exec("BEGIN");
  assert.deepEqual(query.replaceRows("cold", "source", [c, b, a, a, a]), { added: 0, removed: 0, scanned: 10 });
  assert.deepEqual(query.finishChanges(columns), { ...none, scanned: 10 });
  assert.deepEqual(raw(query), before);
  for (const table of ["events", "history_query_rows"])
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) assert.deepEqual(writes(table, operation), []);
  assert.deepEqual(query.replaceRows("cold", "source", [a, a, fact("d"), c]), { added: 1, removed: 2, scanned: 9 });
  assert.equal(writes("history_query_rows", "INSERT").length, 1);
  assert.equal(writes("history_query_rows", "DELETE").length, 2);
  assert.equal(writes("events", "DELETE").length, 2);
  const changed = query.finishChanges(columns);
  assert.deepEqual(changed, { added: 1, removed: 2, scanned: 9, sorted: 5, dirty: dirty(10) });
  const retained = before.filter((row) => !writes("history_query_rows", "DELETE").includes(row.raw_id));
  for (const row of retained)
    assert.deepEqual(
      raw(query).find((current) => current.raw_id === row.raw_id),
      row,
    );
  assert.equal(writes("events", "INSERT").length, 1);
  assert.equal(writes("history_query_rows", "UPDATE").length, 1, "only the new raw row receives an event mapping");
  assert.equal(
    query.database.prepare("SELECT COUNT(*) AS n FROM history_query_rows WHERE event_id IS NULL").get().n,
    0,
  );
  query.database.exec("COMMIT");
  assert.deepEqual(query.finishChanges(columns), none);
});

test("exact JSON payload differences retain isolated surrogates, NUL and duplicate multiplicities", (t) => {
  const { query } = fixture(t);
  const a = fact("\ud800\0"),
    b = fact("\ud801\0"),
    replacement = fact("�\0");
  query.add([a, a, b, replacement], "cold");
  query.finish(columns);
  const keep = raw(query).filter((row) => row.payload === JSON.stringify(canonical(b, [])));
  query.database.exec("BEGIN");
  assert.deepEqual(query.replaceRows("cold", "source", [b, a, replacement, replacement]), {
    added: 1,
    removed: 1,
    scanned: 8,
  });
  query.finishChanges(columns);
  assert.deepEqual(
    raw(query).filter((row) => row.payload === keep[0].payload),
    keep,
  );
  const payloads = raw(query)
    .map((row) => row.payload)
    .sort();
  assert.deepEqual(payloads, [b, a, replacement, replacement].map((row) => JSON.stringify(canonical(row, []))).sort());
  assert.equal(query.remove("cold", a, 10), 1);
  assert.equal(query.remove("other-segment", b, 10), 0);
  assert.deepEqual(query.finishChanges(columns), { added: 0, removed: 1, scanned: 1, sorted: 3, dirty: dirty(10) });
  assert.equal(query.remove("cold", a, 1), 0);
  assert.deepEqual(query.finishChanges(columns), none);
  assert.throws(() => query.remove("cold", a, -1), RangeError);
  query.database.exec("COMMIT");
});

test("tail append and late changes sort only affected timestamps without renumbering physical IDs", (t) => {
  const { query } = fixture(t);
  query.add([fact("middle", 20), fact("z", 10), fact("only", 5)], "cold");
  query.finish(columns);
  const initial = events(query);
  const writes = audit(query);
  query.database.exec("BEGIN");
  query.add([fact("tail", 100)], "hot");
  assert.deepEqual(query.finishChanges(columns), { added: 1, removed: 0, scanned: 1, sorted: 1, dirty: dirty(100) });
  let projected = 0;
  query.add([fact("a", 10)], "cold");
  assert.deepEqual(
    query.finishChanges(columns, (row) => {
      projected++;
      return row;
    }),
    { added: 1, removed: 0, scanned: 1, sorted: 2, dirty: dirty(10) },
  );
  assert.equal(projected, 1);
  for (const row of initial)
    assert.equal(
      events(query).find((current) => current.id === row.id).history_ordinal,
      row.timestamp_ms === 10 ? 1 : 0,
    );
  assert.deepEqual(writes("events", "UPDATE"), [initial.find((row) => row.timestamp_ms === 10).id]);
  const values = query.database
    .prepare("SELECT value FROM events ORDER BY timestamp_ms,history_ordinal")
    .all()
    .map((row) => row.value);
  assert.deepEqual(values, ["only", "a", "z", "middle", "tail"]);
  assert.notDeepEqual(
    events(query).map((row) => row.value),
    values,
  );
  assert.equal(query.remove("cold", fact("only", 5), 1), 1);
  assert.deepEqual(query.finishChanges(columns), { added: 0, removed: 1, scanned: 1, sorted: 0, dirty: dirty(5) });
  query.database.exec("COMMIT");
});

test("empty replacements remove just one segment/source and leave no dirty work on repetition", (t) => {
  const { query } = fixture(t);
  query.add([fact("a"), fact("b", 20), fact("other", 30, "other")], "cold");
  query.add([fact("a")], "other-segment");
  query.finish(columns);
  query.database.exec("BEGIN");
  assert.deepEqual(query.replaceRows("cold", "source", []), { added: 0, removed: 2, scanned: 2 });
  assert.deepEqual(query.finishChanges(columns), { added: 0, removed: 2, scanned: 2, sorted: 1, dirty: dirty(10) });
  assert.equal(events(query).length, 2);
  assert.deepEqual(query.replaceRows("cold", "source", []), { added: 0, removed: 0, scanned: 0 });
  assert.deepEqual(query.finishChanges(columns), none);
  query.database.exec("COMMIT");
});

test("iterator failure and caller rollback restore raw rows, events, dirty markers and temporary tables", (t) => {
  const { query } = fixture(t, [fact("original")]);
  query.finish(columns);
  const before = { raw: raw(query), events: events(query) };
  const failure = new Error("input failed");
  function* broken() {
    yield fact("staged");
    throw failure;
  }
  query.database.exec("BEGIN");
  query.add([fact("prior", 20)], "hot");
  assert.throws(
    () => query.replaceRows("hot", "source", broken()),
    (error) => error === failure,
  );
  assert.equal(query.database.isTransaction, true);
  assert.equal(
    query.database.prepare("SELECT COUNT(*) AS n FROM sqlite_temp_master WHERE name LIKE 'history_query_%'").get().n,
    0,
  );
  assert.throws(() => query.replaceRows("hot", "source", [fact("wrong", 10, "wrong")]), /source does not match/);
  assert.deepEqual(query.finishChanges(columns), { added: 1, removed: 0, scanned: 1, sorted: 1, dirty: dirty(20) });
  query.database.exec("ROLLBACK");
  assert.deepEqual({ raw: raw(query), events: events(query) }, before);
  assert.deepEqual(query.finishChanges(columns), none);
});

test("a replacement SQL failure restores deletions inside the caller transaction and cleans scratch tables", (t) => {
  const { query } = fixture(t);
  query.add([fact("a"), fact("b")], "cold");
  query.finish(columns);
  const before = { raw: raw(query), events: events(query) };
  query.database.exec(`CREATE TEMP TRIGGER fail_replacement BEFORE INSERT ON history_query_rows
    WHEN instr(new.payload,'failure')>0 BEGIN SELECT RAISE(ABORT,'replacement failed'); END;
    BEGIN`);
  assert.throws(() => query.replaceRows("cold", "source", [fact("failure")]), /replacement failed/);
  assert.equal(query.database.isTransaction, true);
  assert.deepEqual({ raw: raw(query), events: events(query) }, before);
  assert.equal(query.database.prepare("SELECT COUNT(*) AS n FROM sqlite_temp_master WHERE type='table'").get().n, 0);
  assert.deepEqual(query.finishChanges(columns), none);
  query.database.exec("DROP TRIGGER fail_replacement");
  assert.deepEqual(query.replaceRows("cold", "source", [fact("new")]), { added: 1, removed: 2, scanned: 3 });
  query.finishChanges(columns);
  query.database.exec("ROLLBACK");
  assert.deepEqual({ raw: raw(query), events: events(query) }, before);
});

test("materialization failure rolls back partial mappings and ordinals, closes spilled groups and permits retry", (t) => {
  const { query } = fixture(t, [fact("0000y")]);
  query.finish(columns);
  const before = { raw: raw(query), events: events(query) };
  const close = UsageSourceRows.prototype.close;
  let spilledClosed = 0;
  t.mock.method(UsageSourceRows.prototype, "close", function () {
    const database = this.database;
    close.call(this);
    if (database) {
      assert.equal(database.isOpen, false);
      spilledClosed++;
    }
  });
  function* many() {
    for (let index = 899; index >= 0; index--) yield fact(`${String(index).padStart(4, "0")}${"x".repeat(1500)}`);
  }
  query.database.exec("BEGIN");
  query.add(many(), "cold");
  const pending = raw(query);
  const failure = new Error("project failed");
  let projected = 0;
  assert.throws(
    () =>
      query.finishChanges(columns, (row) => {
        if (++projected === 2) throw failure;
        return row;
      }),
    (error) => error === failure,
  );
  assert.equal(projected, 2);
  assert.equal(query.database.isTransaction, true);
  assert.deepEqual(events(query), before.events);
  assert.deepEqual(raw(query), pending);
  assert.equal(spilledClosed, 1);
  const result = query.finishChanges(columns);
  assert.deepEqual(result, { added: 900, removed: 0, scanned: 900, sorted: 901, dirty: dirty(10) });
  assert.equal(query.sortStats.spilled, true);
  assert.ok(query.sortStats.peakMemoryBytes < 2 * 1024 * 1024 + 16384);
  assert.equal(spilledClosed, 2);
  const ordered = query.database
    .prepare(`SELECT r.payload,e.history_ordinal FROM events e
    JOIN history_query_rows r ON r.event_id=e.id ORDER BY e.timestamp_ms,e.history_ordinal`)
    .all();
  assert.deepEqual(
    ordered.map((row) => row.payload),
    pending.map((row) => row.payload).sort(),
  );
  assert.deepEqual(
    ordered.map((row) => row.history_ordinal),
    Array.from({ length: 901 }, (_, index) => index),
  );
  query.database.exec("ROLLBACK");
  assert.deepEqual({ raw: raw(query), events: events(query) }, before);
  assert.deepEqual(query.finishChanges(columns), none);
});

test("committed raw changes survive reopen and finish only their recorded timestamp groups", (t) => {
  const input = fixture(t, [fact("original")]);
  input.query.finish(columns);
  const firstId = events(input.query)[0].id;
  input.query.database.exec("BEGIN");
  input.query.add([fact("tail", 30)], "hot");
  input.query.database.exec("COMMIT");
  input.query.close();
  input.query = new UsageHistoryQuery(null, canonical, { databaseFile: input.file, existing: true });
  assert.deepEqual(input.query.finishChanges(columns), {
    added: 1,
    removed: 0,
    scanned: 1,
    sorted: 1,
    dirty: dirty(30),
  });
  assert.equal(events(input.query)[0].id, firstId);
  assert.equal(raw(input.query).filter((row) => row.event_id === null).length, 0);
  input.query.database.exec("BEGIN");
  assert.deepEqual(input.query.replaceRows("hot", "source", [fact("original"), fact("revised", 30)]), {
    added: 1,
    removed: 1,
    scanned: 4,
  });
  assert.deepEqual(input.query.finishChanges(columns), {
    added: 1,
    removed: 1,
    scanned: 4,
    sorted: 1,
    dirty: dirty(30),
  });
  input.query.database.exec("COMMIT");
});

test("initial persistent finish resumes imported raw rows and is idempotent before and after reopen", (t) => {
  const input = fixture(t, [fact("hot", 20)]);
  input.query.database.exec("BEGIN");
  input.query.add([fact("cold"), fact("cold"), fact("early", 5)], "imported-segment");
  input.query.database.exec("COMMIT");
  const imported = raw(input.query);
  input.query.close();
  input.query = new UsageHistoryQuery(null, canonical, { databaseFile: input.file, existing: true });
  assert.deepEqual(raw(input.query), imported);
  assert.equal(events(input.query).length, 0);
  input.query.finish(columns, (row) => ({ ...row, day_key: "display-day" }));
  const completed = { raw: raw(input.query), events: events(input.query) };
  assert.equal(completed.events.length, 4);
  const fail = () => assert.fail("a finalized build must not project or insert events again");
  assert.equal(input.query.finish(columns, fail), input.query.database);
  assert.deepEqual({ raw: raw(input.query), events: events(input.query) }, completed);
  input.query.close();
  input.query = new UsageHistoryQuery(null, canonical, { databaseFile: input.file, existing: true });
  const writes = audit(input.query);
  assert.equal(input.query.finish(columns, fail), input.query.database);
  assert.deepEqual({ raw: raw(input.query), events: events(input.query) }, completed);
  for (const table of ["events", "history_query_rows"])
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) assert.deepEqual(writes(table, operation), []);
});
