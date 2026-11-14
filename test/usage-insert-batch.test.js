import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createUsageInsertBatch } from "../src/usage-insert-batch.js";

function openDatabase(t, schema = "CREATE TABLE events(value)") {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec(schema);
  return database;
}

function observeInserts(database, compileOptions) {
  const prepare = database.prepare.bind(database);
  const observed = { compileReads: 0, prepared: [], batches: [] };
  database.prepare = (sql) => {
    if (sql === "PRAGMA compile_options") {
      observed.compileReads += 1;
      if (compileOptions) return { all: compileOptions };
    }
    const statement = prepare(sql);
    if (/^INSERT\b/.test(sql)) {
      observed.prepared.push(sql);
      const run = statement.run.bind(statement);
      statement.run = (...parameters) => {
        observed.batches.push(parameters.length);
        return run(...parameters);
      };
    }
    return statement;
  };
  return observed;
}

function eventValues(database) {
  return database
    .prepare("SELECT value FROM events ORDER BY rowid")
    .all()
    .map((row) => row.value);
}

test("mixed scalars, bigint, null, and binary views retain their values and input order", (t) => {
  const database = openDatabase(
    t,
    "CREATE TABLE events(ordinal INTEGER PRIMARY KEY, text, real, integer, optional, bytes)",
  );
  const storage = new Uint8Array([99, 0, 255, 128, 99]);
  const words = new Uint16Array([0x1234, 0xabcd]);
  const inputs = [
    [1, "你好 😀 '); --\0", 1.25, 9223372036854775807n, null, Buffer.from([0, 255, 1])],
    [2, "", -2.5, -9223372036854775808n, "present", storage.subarray(1, 4)],
    [3, "view", 0, 0n, null, new DataView(storage.buffer, 2, 2)],
    [4, "words", Number.POSITIVE_INFINITY, 42n, null, words],
    [5, "empty", Number.NaN, 1n, null, new Uint8Array()],
  ];
  const batch = createUsageInsertBatch(database, {
    sqlPrefix: "INSERT INTO events(ordinal, text, real, integer, optional, bytes) VALUES",
    columns: 6,
    maxRows: 2,
  });
  for (const row of inputs) batch.add(row);
  batch.flush();
  batch.flush();
  const select = database.prepare("SELECT * FROM events ORDER BY rowid");
  select.setReadBigInts(true);
  assert.deepEqual(
    select.all().map((row) => Object.values(row)),
    inputs.map(([ordinal, text, real, integer, optional, bytes]) => [
      BigInt(ordinal),
      text,
      Number.isNaN(real) ? null : real,
      integer,
      optional,
      new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    ]),
  );
  assert.equal(database.isTransaction, false);
});

test("default row limit spans batches without reordering and copies the input array", (t) => {
  const database = openDatabase(t);
  const observed = observeInserts(database);
  const batch = createUsageInsertBatch(database, { sqlPrefix: "INSERT INTO events VALUES", columns: 1 });
  const values = [0];
  for (let index = 0; index < 261; index += 1) {
    values[0] = index;
    batch.add(values);
  }
  values[0] = -1;
  batch.flush();
  assert.deepEqual(observed.batches, [128, 128, 5]);
  assert.deepEqual(
    eventValues(database),
    Array.from({ length: 261 }, (_, index) => index),
  );
});

test("OR REPLACE matches scalar insertion order, including insert and delete triggers", (t) => {
  const database = openDatabase(t, "PRAGMA recursive_triggers = ON");
  for (const table of ["scalar", "batched"]) {
    database.exec(`
      CREATE TABLE ${table}(key TEXT UNIQUE, value TEXT);
      CREATE TABLE ${table}_audit(sequence INTEGER PRIMARY KEY, operation, key, value);
      CREATE TRIGGER ${table}_insert AFTER INSERT ON ${table} BEGIN
        INSERT INTO ${table}_audit(operation, key, value) VALUES ('insert', NEW.key, NEW.value);
      END;
      CREATE TRIGGER ${table}_delete AFTER DELETE ON ${table} BEGIN
        INSERT INTO ${table}_audit(operation, key, value) VALUES ('delete', OLD.key, OLD.value);
      END;
    `);
  }
  const scalar = database.prepare("INSERT OR REPLACE INTO scalar VALUES (?, ?)");
  const batch = createUsageInsertBatch(database, {
    sqlPrefix: "INSERT OR REPLACE INTO batched(key, value) VALUES",
    columns: 2,
    maxRows: 3,
  });
  const inputs = [
    ["a", "1"],
    ["b", "1"],
    ["a", "2"],
    ["c", "1"],
    ["b", "2"],
    ["b", "3"],
    ["a", "3"],
  ];
  for (const row of inputs) {
    scalar.run(...row);
    batch.add(row);
  }
  batch.flush();
  assert.deepEqual(
    database.prepare("SELECT rowid, * FROM batched ORDER BY rowid").all(),
    database.prepare("SELECT rowid, * FROM scalar ORDER BY rowid").all(),
  );
  assert.deepEqual(
    database.prepare("SELECT * FROM batched_audit ORDER BY sequence").all(),
    database.prepare("SELECT * FROM scalar_audit ORDER BY sequence").all(),
  );
});

test("byte bounds count UTF-8 and binary view lengths", (t) => {
  const database = openDatabase(t);
  const observed = observeInserts(database);
  const batch = createUsageInsertBatch(database, { sqlPrefix: "INSERT INTO events VALUES", columns: 1, maxBytes: 8 });
  const storage = new Uint8Array(100);
  for (const value of ["😀", "😀", "字", storage.subarray(2, 5), "abc"]) batch.add([value]);
  batch.flush();
  assert.deepEqual(observed.batches, [2, 2, 1]);
  assert.deepEqual(eventValues(database), ["😀", "😀", "字", new Uint8Array(3), "abc"]);
});

test("default byte bound splits below the row limit", (t) => {
  const database = openDatabase(t);
  const observed = observeInserts(database);
  const batch = createUsageInsertBatch(database, { sqlPrefix: "INSERT INTO events VALUES", columns: 1 });
  for (let index = 0; index < 4; index += 1) batch.add(["x".repeat(70 * 1024)]);
  batch.flush();
  assert.deepEqual(observed.batches, [3, 1]);
  assert.equal(eventValues(database).length, 4);
});

test("oversized text and blob rows flush alone immediately without losing data", (t) => {
  const database = openDatabase(t);
  const observed = observeInserts(database);
  const batch = createUsageInsertBatch(database, { sqlPrefix: "INSERT INTO events VALUES", columns: 1 });
  const text = "界".repeat(100_000);
  const blob = Buffer.alloc(300_000, 0xad);
  batch.add(["before"]);
  batch.add([text]);
  assert.deepEqual(observed.batches, [1, 1]);
  batch.add(["between"]);
  batch.add([blob]);
  assert.deepEqual(observed.batches, [1, 1, 1, 1]);
  batch.add(["after"]);
  batch.flush();
  assert.deepEqual(eventValues(database), ["before", text, "between", new Uint8Array(blob), "after"]);
});

test("variable limit is rounded down by columns and discovered once per connection", (t) => {
  const database = openDatabase(t, "CREATE TABLE events(a, b, c)");
  const observed = observeInserts(database, () => [{ compile_options: "MAX_VARIABLE_NUMBER=7" }]);
  for (let pass = 0; pass < 2; pass += 1) {
    const batch = createUsageInsertBatch(database, {
      sqlPrefix: "INSERT INTO events VALUES",
      columns: 3,
      maxRows: 128,
    });
    for (let index = 0; index < 5; index += 1) batch.add([pass, index, null]);
    batch.flush();
  }
  assert.equal(observed.compileReads, 1);
  assert.deepEqual(observed.batches, [6, 6, 3, 6, 6, 3]);
  assert.deepEqual(
    database
      .prepare("SELECT a, b FROM events ORDER BY rowid")
      .all()
      .map((row) => [row.a, row.b]),
    [
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4],
      [1, 0],
      [1, 1],
      [1, 2],
      [1, 3],
      [1, 4],
    ],
  );
  assert.throws(
    () => createUsageInsertBatch(database, { sqlPrefix: "INSERT INTO events VALUES", columns: 8 }),
    /bind parameter limit/,
  );
});

test("batches also respect the real connection's compiled variable limit", (t) => {
  const columns = Array.from({ length: 29 }, (_, index) => `column_${index}`);
  const database = openDatabase(t, `CREATE TABLE events(${columns.join(",")})`);
  const option = database
    .prepare("PRAGMA compile_options")
    .all()
    .map((row) => /^MAX_VARIABLE_NUMBER=(\d+)$/.exec(String(row.compile_options)))
    .find(Boolean);
  const limit = option ? Number(option[1]) : 999;
  const rows = Math.floor(limit / columns.length);
  const observed = observeInserts(database);
  const batch = createUsageInsertBatch(database, {
    sqlPrefix: "INSERT INTO events VALUES",
    columns: columns.length,
    maxRows: rows + 1,
    maxBytes: limit * 16,
  });
  for (let index = 0; index <= rows; index += 1) batch.add(Array(columns.length).fill(index));
  batch.flush();
  assert.equal(
    observed.batches.reduce((sum, count) => sum + count, 0),
    (rows + 1) * columns.length,
  );
  assert.ok(observed.batches.length > 1 && observed.batches.every((count) => count <= limit));
  assert.deepEqual(
    database
      .prepare("SELECT column_0 FROM events ORDER BY rowid")
      .all()
      .map((row) => row.column_0),
    Array.from({ length: rows + 1 }, (_, index) => index),
  );
});

test("large SQLite limits do not exceed JavaScript's argument capacity", (t) => {
  const database = openDatabase(t);
  const observed = observeInserts(database, () => [{ compile_options: "MAX_VARIABLE_NUMBER=250000" }]);
  const batch = createUsageInsertBatch(database, {
    sqlPrefix: "INSERT INTO events VALUES",
    columns: 1,
    maxRows: 100_000,
    maxBytes: 1_000_000,
  });
  for (let index = 0; index < 100_000; index += 1) batch.add([index]);
  batch.flush();
  assert.ok(observed.batches.length > 1);
  assert.deepEqual(
    { ...database.prepare("SELECT COUNT(*) AS count, SUM(value) AS total FROM events").get() },
    { count: 100_000, total: 4_999_950_000 },
  );
});

test("missing, invalid, or unavailable compile options fall back to 999 and are cached", (t) => {
  for (const compileOptions of [
    () => [],
    () => [{ compile_options: "MAX_VARIABLE_NUMBER=0" }, { compile_options: "MAX_VARIABLE_NUMBER=NaN" }],
    () => {
      throw new Error("compile options unavailable");
    },
  ]) {
    const database = openDatabase(t, "CREATE TABLE events(a, b)");
    const observed = observeInserts(database, compileOptions);
    for (let pass = 0; pass < 2; pass += 1) {
      const batch = createUsageInsertBatch(database, {
        sqlPrefix: "INSERT INTO events VALUES",
        columns: 2,
        maxRows: 1000,
      });
      for (let index = 0; index < 500; index += 1) batch.add([pass, index]);
      batch.flush();
    }
    assert.equal(observed.compileReads, 1);
    assert.deepEqual(observed.batches, [998, 2, 998, 2]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM events").get().count, 1000);
  }
});

test("only the full statement and most recent partial row count are cached", (t) => {
  const database = openDatabase(t);
  const observed = observeInserts(database);
  const batch = createUsageInsertBatch(database, { sqlPrefix: "INSERT INTO events VALUES", columns: 1, maxRows: 5 });
  batch.flush();
  assert.equal(observed.prepared.length, 0);
  for (const rows of [5, 5, 2, 2, 1, 2]) {
    for (let index = 0; index < rows; index += 1) batch.add([index]);
    batch.flush();
  }
  assert.deepEqual(observed.batches, [5, 5, 2, 2, 1, 2]);
  assert.deepEqual(
    observed.prepared.map((sql) => sql.match(/\?/g).length),
    [5, 2, 1, 2],
  );
});

test("a failing batch ABORTs as one statement and the caller can roll back earlier batches", (t) => {
  for (const prefix of ["INSERT", "INSERT OR REPLACE"]) {
    for (const explicitFlush of [false, true]) {
      const database = openDatabase(t, "CREATE TABLE events(value INTEGER UNIQUE CHECK(value >= 0))");
      database.exec("INSERT INTO events VALUES (99)");
      const batch = createUsageInsertBatch(database, {
        sqlPrefix: `${prefix} INTO events VALUES`,
        columns: 1,
        maxRows: explicitFlush ? 3 : 2,
      });
      database.exec("BEGIN IMMEDIATE; DELETE FROM events");
      batch.add([1]);
      batch.add([2]);
      batch.flush();
      batch.add([3]);
      if (explicitFlush) batch.add([-1]);
      assert.throws(() => (explicitFlush ? batch.flush() : batch.add([-1])), /CHECK constraint failed/);
      assert.equal(database.isTransaction, true);
      assert.deepEqual(eventValues(database), [1, 2]);
      database.exec("ROLLBACK");
      assert.deepEqual(eventValues(database), [99]);
      assert.equal(database.isTransaction, false);
    }
  }
});

test("invalid bounds and row shapes fail before flushing buffered rows", (t) => {
  const database = openDatabase(t);
  for (const key of ["columns", "maxRows", "maxBytes"]) {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => createUsageInsertBatch(database, { sqlPrefix: "INSERT INTO events VALUES", columns: 1, [key]: value }),
        RangeError,
      );
    }
  }
  assert.throws(() => createUsageInsertBatch(database, { sqlPrefix: " ", columns: 1 }), TypeError);
  assert.throws(() => createUsageInsertBatch(null, { sqlPrefix: "INSERT INTO events VALUES", columns: 1 }), TypeError);
  const batch = createUsageInsertBatch(database, { sqlPrefix: "INSERT INTO events VALUES", columns: 1, maxBytes: 8 });
  batch.add(["ok"]);
  for (const values of [[], [1, 2], null, [undefined], [true], [{}], [new ArrayBuffer(4)]]) {
    assert.throws(() => batch.add(values), TypeError);
  }
  assert.deepEqual(eventValues(database), []);
  batch.flush();
  assert.deepEqual(eventValues(database), ["ok"]);
});
