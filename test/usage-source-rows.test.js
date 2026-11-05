import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { UsageSourceRows, indexedSourceSessions } from "../src/usage-source-rows.js";

const compare = (a, b) => a.timestampMs - b.timestampMs || a.id.localeCompare(b.id);
const ids = ["é", "e\u0301", "Å", "A\u030a", "10", "2", "02", "a-b", "a_b", "a.b", "!", "中", "𐐀", "a", "A"];

test("indexed sessions require a unique binary TEXT identity with no coerced keys", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const schema of [
      "id TEXT PRIMARY KEY",
      "id TEXT PRIMARY KEY COLLATE NOCASE",
      "id INTEGER PRIMARY KEY",
      "id TEXT",
    ]) {
      db.exec(`CREATE TABLE sessions(${schema},title TEXT); INSERT INTO sessions VALUES ('7','title')`);
      const source = indexedSourceSessions(db, "sessions", "id,title");
      if (schema === "id TEXT PRIMARY KEY") {
        assert.equal(source.size, 1);
        assert.equal(source.get("7").title, "title");
        assert.equal(source.get(" 7 "), undefined);
        assert.equal(source.get("7").title, "title");
        db.exec("INSERT INTO sessions VALUES (NULL,'null')");
        assert.equal(indexedSourceSessions(db, "sessions", "id,title"), null);
        db.exec("DELETE FROM sessions WHERE id IS NULL; INSERT INTO sessions VALUES (x'37','blob')");
        assert.equal(indexedSourceSessions(db, "sessions", "id,title"), null);
      } else assert.equal(source, null);
      db.exec("DROP TABLE sessions");
    }
  } finally {
    db.close();
  }
});

test("small rows stay in memory; reads retain Map references, overwrite order and negative zero", () => {
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = () => assert.fail("Small rows must not open SQLite");
  const rows = new UsageSourceRows();
  try {
    assert.equal(rows.get("absent"), undefined);
    const value = { id: "first", nested: { zero: -0 } };
    rows.set("first", value).set("second", { id: "second" });
    assert.equal(rows.get("first"), value);
    assert.equal(rows.get("first").id, "first");
    rows.set("first", { id: "overwritten", zero: -0 });
    assert.deepEqual([...rows.values()], [{ id: "overwritten", zero: -0 }, { id: "second" }]);
    assert.deepEqual([...rows.ordered(() => 0)], [...rows.values()]);
    assert.equal(rows.size, 2);
    assert.equal(rows.stats.spilled, false);
    assert.equal(rows.stats.peakScratchBytes, 0);
    assert.ok(rows.stats.peakMemoryBytes > 0);
  } finally {
    rows.close();
    rows.close();
    DatabaseSync.prototype.prepare = prepare;
  }
});

test("spilled ordering compares compact keys and returns complete original values", () => {
  const rows = new UsageSourceRows(2000);
  const expected = [];
  try {
    for (let i = 0; i < 120; i++) {
      const event = { id: ids[i % ids.length], timestampMs: i % 5, index: i, body: "x".repeat(2000) };
      rows.set(String(i), event);
      expected.push(event);
    }
    assert.deepEqual(
      [...rows.ordered(compare, ({ timestampMs, id }) => ({ timestampMs, id }))],
      expected.sort(compare),
    );
    assert.ok(rows.stats.mergePasses > 1);
  } finally {
    rows.close();
  }
});

for (const timestampTies of [true, false]) {
  test(`spilled pairwise merge exactly matches stable localeCompare sort (all ties=${timestampTies})`, () => {
    const rows = new UsageSourceRows(1800);
    const expected = new Map();
    try {
      for (let i = 0; i < 180; i += 1) {
        const key = `key-${i}`;
        const value = { id: ids[i % ids.length], timestampMs: timestampTies ? 1 : (i * 17) % 7, index: i, zero: -0 };
        rows.set(key, value);
        expected.set(key, value);
      }
      // Updates on disk neither allocate new identities nor move the original insertion ordinal.
      for (const index of [0, 5, 83, 179]) {
        const key = `key-${index}`;
        const value = { ...expected.get(key), updated: true };
        rows.set(key, value);
        expected.set(key, value);
        assert.deepEqual(rows.get(key), value);
      }
      rows.set("nul\0key", { id: "é", timestampMs: 1, index: 180 });
      expected.set("nul\0key", { id: "é", timestampMs: 1, index: 180 });
      for (const key of ["\ud800", "\ud801", "�"]) {
        rows.set(key, { id: key, timestampMs: 1 });
        expected.set(key, { id: key, timestampMs: 1 });
      }
      assert.equal(rows.size, expected.size);
      assert.equal(rows.get("absent"), undefined);
      assert.deepEqual([...rows.values()], [...expected.values()]);
      assert.deepEqual([...rows.ordered(compare)], [...expected.values()].sort(compare));
      assert.ok(rows.stats.sortRuns > 2);
      assert.ok(rows.stats.mergePasses > 1);
      assert.ok(rows.stats.peakScratchBytes >= 4096);
      assert.ok(rows.stats.peakMemoryBytes <= rows.maxBytes * 3);
      assert.equal(rows.entries.size, 0, "no disk identity history may remain in JS");
      assert.equal(rows.bytes, 0);
      assert.deepEqual([...rows.ordered(compare)], [...expected.values()].sort(compare));
    } finally {
      rows.close();
      rows.close();
    }
    assert.ok(rows.stats.spilled, "stats survive close for benchmark sampling");
  });
}

test("byte budget allows one oversized legal row and observes merge intermediate disk space", () => {
  const rows = new UsageSourceRows(512);
  try {
    const huge = { id: "large", timestampMs: 0, title: "x".repeat(80 * 1024), zero: -0 };
    rows.set("large", huge);
    for (let i = 0; i < 500; i += 1) rows.set(`key-${i}`, { id: `id-${i}`, timestampMs: 1 });
    const samples = [];
    const sample = rows.sampleScratch;
    rows.sampleScratch = function () {
      sample.call(this);
      samples.push(this.stats.peakScratchBytes);
    };
    const ordered = rows.ordered(compare);
    assert.deepEqual(ordered.next().value, huge);
    ordered.return();
    assert.ok(samples.at(-1) > samples[0], "peak includes run and merge storage");
    assert.ok(rows.stats.peakMemoryBytes >= huge.title.length);
    assert.equal(rows.database.prepare("SELECT count(*) AS n FROM sort_runs").get().n, 0);
    assert.equal(rows.size, 501);
  } finally {
    rows.close();
  }
});

test("comparison failures and early consumer exit clean sorted runs without losing candidates", () => {
  const rows = new UsageSourceRows(1600);
  try {
    for (let i = 0; i < 80; i += 1) rows.set(String(i), { id: String(i), timestampMs: 0 });
    let comparisons = 0;
    const fail = new Error("comparison failed");
    assert.throws(
      () => [
        ...rows.ordered((a, b) => {
          if (++comparisons > 100) throw fail;
          return compare(a, b);
        }),
      ],
      (error) => error === fail,
    );
    assert.equal(rows.database.prepare("SELECT count(*) AS n FROM sort_runs").get().n, 0);
    const failConsumer = new Error("consumer failed");
    assert.throws(
      () => {
        for (const _row of rows.ordered(compare)) throw failConsumer;
      },
      (error) => error === failConsumer,
    );
    assert.equal(rows.database.prepare("SELECT count(*) AS n FROM sort_runs").get().n, 0);
    assert.equal([...rows.values()].length, 80);
    assert.equal([...rows.ordered(compare)].length, 80);
  } finally {
    rows.close();
  }
});
