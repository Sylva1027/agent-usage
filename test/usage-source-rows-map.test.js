import assert from "node:assert/strict";
import test from "node:test";

import { UsageSourceRows } from "../src/usage-source-rows.js";

const keys = [
  "",
  " spaced ",
  "10",
  "2",
  "02",
  "é",
  "e\u0301",
  "中",
  "𐐀",
  "a",
  "A",
  "\ud800",
  "\ud801",
  "\udc00",
  "�",
  "\\ud800",
  "\0",
  "nul",
  "nul\0",
  "nul\0key",
  "\\u0000",
  '"\\\n',
];

for (const maxBytes of [undefined, 0, 1024]) {
  const storage = maxBytes === undefined ? "memory" : `spill budget=${maxBytes}`;

  test(`${storage}: has, keys and entries match Map identities, values and overwrite order`, () => {
    const rows = new UsageSourceRows(maxBytes);
    const expected = new Map();
    try {
      assert.equal(rows.has("absent"), false);
      assert.equal(rows.size, 0);
      assert.deepEqual([...rows.keys()], []);
      assert.deepEqual([...rows.entries()], []);
      assert.equal(rows.stats.spilled, false);
      for (const [index, key] of keys.entries()) {
        const value = { key, index, zero: -0 };
        assert.equal(rows.set(key, value), rows);
        expected.set(key, value);
      }
      for (const key of [keys[5], keys[0], keys.at(-1)]) {
        const value = { key, updated: true, zero: -0 };
        rows.set(key, value);
        expected.set(key, value);
      }
      for (const key of [...keys, "absent", "NUL", "nul\0other"]) {
        assert.equal(rows.has(key), expected.has(key));
        assert.deepEqual(rows.get(key), expected.get(key));
      }
      for (let pass = 0; pass < 2; pass += 1) {
        assert.deepEqual([...rows.keys()], [...expected.keys()]);
        assert.deepEqual([...rows.entries()], [...expected.entries()]);
        assert.deepEqual([...rows.values()], [...expected.values()]);
      }
      assert.equal(rows.size, expected.size);
      assert.equal(rows.stats.spilled, maxBytes !== undefined);
      if (maxBytes === undefined) assert.equal(rows.entries().next().value[1], expected.get(keys[0]));
    } finally {
      rows.close();
    }
  });

  test(`${storage}: pending inserts and repeated updates include undefined and falsy values`, () => {
    const rows = new UsageSourceRows(maxBytes);
    const expected = new Map();
    try {
      for (const [index, value] of [undefined, null, false, 0, "", -0].entries()) {
        const key = String(index);
        rows.set(key, value);
        expected.set(key, value);
        assert.equal(rows.has(key), true);
        assert.deepEqual(rows.get(key), value);
        assert.equal(rows.has("absent"), false);
      }
      assert.deepEqual([...rows.keys()], [...expected.keys()]);
      assert.deepEqual([...rows.values()], [...expected.values()]);
      for (const value of [null, false, undefined]) {
        rows.set("0", value);
        expected.set("0", value);
        assert.equal(rows.has("0"), true);
        assert.equal(rows.get("0"), value);
      }
      assert.deepEqual([...rows.entries()], [...expected.entries()]);
      rows.set("1", { updated: true });
      expected.set("1", { updated: true });
      assert.deepEqual([...rows.keys()], [...expected.keys()]);
      assert.deepEqual([...rows.values()], [...expected.values()]);
      rows.set("tail", undefined);
      expected.set("tail", undefined);
      assert.equal(rows.has("tail"), true);
      assert.deepEqual([...rows.entries()], [...expected.entries()]);
      assert.equal(rows.size, expected.size);
    } finally {
      rows.close();
    }
  });

  test(`${storage}: independent iterators survive early return, consumer failure and repeated consumption`, () => {
    const rows = new UsageSourceRows(maxBytes);
    const expected = new Map(keys.slice(0, 4).map((key, index) => [key, { index }]));
    try {
      for (const [key, value] of expected) rows.set(key, value);
      for (const method of ["keys", "entries"]) {
        const first = rows[method]();
        const second = rows[method]();
        const reference = expected[method]();
        const head = reference.next();
        assert.equal(first[Symbol.iterator](), first);
        assert.deepEqual(first.next(), head);
        assert.deepEqual(second.next(), head);
        assert.deepEqual([...rows[method]()], [...expected[method]()]);
        second.return();
        assert.deepEqual([...second], []);
        assert.deepEqual([...first], [...reference]);
        assert.deepEqual([...first], []);
        assert.deepEqual(first.next(), { done: true, value: undefined });
        for (const _row of rows[method]()) break;
        const failure = new Error("consumer failed");
        assert.throws(
          () => {
            for (const _row of rows[method]()) throw failure;
          },
          (error) => error === failure,
        );
        assert.deepEqual([...rows[method]()], [...expected[method]()]);
      }
      rows.set("after-return", { updated: true });
      expected.set("after-return", { updated: true });
      assert.deepEqual([...rows.entries()], [...expected.entries()]);
    } finally {
      rows.close();
    }
  });

  test(`${storage}: empty and closed containers retain existing read and close behavior`, () => {
    const rows = new UsageSourceRows(maxBytes);
    try {
      for (const method of ["keys", "entries", "values"]) {
        const iterator = rows[method]();
        assert.deepEqual([...iterator], []);
        assert.deepEqual([...iterator], []);
      }
      rows.set("first", { index: 0 }).set("pending", { index: 1 });
      const lazy = [rows.keys(), rows.entries(), rows.values()];
      rows.close();
      rows.close();
      assert.equal(rows.size, 0);
      for (const key of ["first", "pending", "absent"]) {
        assert.equal(rows.has(key), false);
        assert.equal(rows.get(key), undefined);
      }
      for (const iterator of [...lazy, rows.keys(), rows.entries(), rows.values(), rows.ordered(() => 0)]) {
        assert.deepEqual([...iterator], []);
      }
      assert.throws(() => rows.set("closed", {}), /Source rows are closed/);
    } finally {
      rows.close();
    }
  });
}
