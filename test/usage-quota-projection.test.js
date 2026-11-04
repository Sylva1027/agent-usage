import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { completedQuotaWindows } from "../public/timeline-utils.js";
import { selectQuotaWindows } from "../src/usage-core.js";
import {
  ensureUsageQuotaSchema,
  iterateStoredQuotaWindows,
  quotaProjectionWork,
  selectStoredQuotaWindows,
} from "../src/usage-quota-store.js";

const MINUTE = 60_000;
const NOW = Date.parse("2026-11-04T12:00:00Z");
const TABLE = "rate_limit_observations";
const PREFIX = "usage_quota_projection_";

function fixture(t, disk = false) {
  const directory = disk ? mkdtempSync(path.join(tmpdir(), "quota-projection-")) : null;
  const file = directory ? path.join(directory, "usage.sqlite") : ":memory:";
  const connections = [];
  function open(options = {}) {
    const database = new DatabaseSync(file, options);
    connections.push(database);
    database.exec("PRAGMA recursive_triggers=OFF; PRAGMA busy_timeout=1000");
    return database;
  }
  const database = open();
  database.exec(`CREATE TABLE ${TABLE} (
    source_path TEXT NOT NULL, line_number INTEGER NOT NULL, role TEXT NOT NULL,
    observed_at_ms INTEGER NOT NULL, limit_id TEXT NOT NULL, limit_name TEXT, plan_type TEXT,
    window_minutes REAL NOT NULL, resets_at_ms INTEGER NOT NULL, used_percent REAL,
    PRIMARY KEY(source_path,line_number,role)
  ) STRICT`);
  if (disk) database.exec("PRAGMA journal_mode=WAL");
  assert.equal(ensureUsageQuotaSchema(database), true);
  t.after(() => {
    for (const connection of connections.toReversed()) if (connection.isOpen) connection.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  return { database, open };
}

function row(lineNumber, overrides = {}) {
  return {
    sourcePath: "raw",
    lineNumber,
    role: "primary",
    limitId: "codex",
    observedAtMs: NOW - MINUTE,
    windowMinutes: 300,
    resetsAtMs: NOW + 240 * MINUTE,
    usedPercent: 20,
    ...overrides,
  };
}

function put(database, observation, { replace = false, rowid } = {}) {
  return database
    .prepare(`INSERT ${replace ? "OR REPLACE " : ""}INTO ${TABLE}
    (${rowid === undefined ? "" : "rowid,"}source_path,line_number,role,observed_at_ms,limit_id,
      window_minutes,resets_at_ms,used_percent) VALUES (${rowid === undefined ? "" : "?,"}?,?,?,?,?,?,?,?)`)
    .run(
      ...(rowid === undefined ? [] : [rowid]),
      observation.sourcePath,
      observation.lineNumber,
      observation.role,
      observation.observedAtMs,
      observation.limitId,
      observation.windowMinutes,
      observation.resetsAtMs,
      observation.usedPercent ?? null,
    );
}

function remove(database, lineNumber, sourcePath = "raw") {
  database.prepare(`DELETE FROM ${TABLE} WHERE source_path=? AND line_number=?`).run(sourcePath, lineNumber);
}

function rawRows(database) {
  return database.prepare(`SELECT * FROM ${TABLE} ORDER BY limit_id,window_minutes,observed_at_ms DESC`).all();
}

// Identity wins before validation: an invalid raw/first official row still shadows its duplicates.
function oracleRows(database, officials) {
  const seen = new Set();
  return [...rawRows(database), ...officials].filter((observation, index) => {
    const source = observation.sourcePath ?? observation.source_path;
    const line = observation.lineNumber ?? observation.line_number;
    const key =
      source !== undefined && line !== undefined && observation.role
        ? `${source}\0${line}\0${observation.role}`
        : `unkeyed\0${index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parity(database, { asOf = NOW, officials = [], label = "", fast = true } = {}) {
  const observations = oracleRows(database, officials);
  const expected = selectQuotaWindows(observations, asOf);
  const actual = selectStoredQuotaWindows(database, asOf, officials);
  assert.deepEqual(actual, expected, `${label}: all current/previous window fields`);
  const work = { ...quotaProjectionWork(database) };
  if (fast) assert.notEqual(work.fallback, true, `${label}: projection must execute`);
  const limits = new Set(["codex", "other", ...observations.map((x) => x.limitId ?? x.limit_id)]);
  for (const limit of limits) {
    if (typeof limit !== "string" || !limit.trim()) continue;
    for (const minutes of [300, 10_080]) {
      const expectedCompleted = completedQuotaWindows(observations, limit, asOf, minutes);
      const iterable = iterateStoredQuotaWindows(database, limit, asOf, minutes, officials);
      assert.deepEqual(
        iterable === null ? null : [...iterable],
        expectedCompleted,
        `${label}: full completed list ${limit}/${minutes}`,
      );
    }
  }
  return { actual, work };
}

function incremental(work, changes) {
  assert.equal(work.rebuilt, false, "ordinary mutation must not rebuild all observations");
  assert.equal(work.changes, changes);
}

function history(database) {
  let line = 1;
  for (const minutes of [300, 10_080]) {
    for (let cycle = -4; cycle <= 0; cycle += 1) {
      const reset = NOW + (cycle * minutes + 240) * MINUTE;
      put(
        database,
        row(line++, { windowMinutes: minutes, resetsAtMs: reset, observedAtMs: reset - (minutes - 5) * MINUTE }),
      );
    }
  }
}

test("projection: append, durable no-change reopen, clock promotion and old-asOf fallback", (t) => {
  let { database, open } = fixture(t, true);
  history(database);
  assert.equal(parity(database).work.rebuilt, true);
  put(database, row(20, { observedAtMs: NOW, usedPercent: 31 }));
  const appended = parity(database, { label: "normal append" });
  incremental(appended.work, 1);
  assert.ok(appended.work.endpoints > 0 && appended.work.endpoints <= 1);
  assert.equal(appended.actual.windows.quota_5h.usedPercent, 31);
  put(database, row(21, { observedAtMs: NOW + 3 * MINUTE, usedPercent: 42 }));
  incremental(parity(database, { label: "future append" }).work, 1);
  database.close();
  database = open();
  const reused = parity(database, { asOf: NOW + MINUTE, label: "reopen" }).work;
  assert.equal(reused.reused, true);
  incremental(reused, 0);
  assert.equal(reused.cycles, 0);
  parity(database, { asOf: NOW + 3 * MINUTE - 1, label: "before future observation" });
  const promoted = parity(database, { asOf: NOW + 3 * MINUTE, label: "at future observation" });
  incremental(promoted.work, 0);
  assert.equal(promoted.work.promotedTimes, 1);
  assert.equal(promoted.actual.windows.quota_5h.usedPercent, 42);
  for (const offset of [13 * MINUTE, 13 * MINUTE + 1, 240 * MINUTE - 1, 240 * MINUTE])
    parity(database, { asOf: NOW + offset, label: `clock +${offset}` });
  const old = parity(database, { asOf: NOW - 2 * MINUTE, label: "old asOf", fast: false });
  assert.equal(old.work.fallback, true);
  incremental(parity(database, { asOf: NOW + 240 * MINUTE, label: "latest survives old query" }).work, 0);
});

test("projection: distinct endpoint time support, percent changes and deleting old points", (t) => {
  const { database } = fixture(t);
  const end = NOW - 600 * MINUTE;
  for (let line = 1; line <= 4; line += 1)
    put(database, row(line, { observedAtMs: end - 100 * MINUTE, resetsAtMs: end }));
  for (let line = 5; line <= 6; line += 1)
    put(database, row(line, { observedAtMs: end - (100 - line) * MINUTE, resetsAtMs: end + MINUTE }));
  const first = parity(database);
  assert.equal(first.actual.previousWindows.quota_5h.plannedResetAt, new Date(end + MINUTE).toISOString());
  remove(database, 1);
  const duplicateRemoved = parity(database, { label: "one duplicate time removed" }).work;
  incremental(duplicateRemoved, 1);
  assert.equal(duplicateRemoved.endpoints, 0);
  database.prepare(`UPDATE ${TABLE} SET used_percent=93 WHERE line_number=2`).run();
  const percentChanged = parity(database, { label: "percent only" }).work;
  incremental(percentChanged, 2);
  assert.equal(percentChanged.endpoints, 0);
  for (let line = 2; line <= 4; line += 1) {
    database.prepare(`UPDATE ${TABLE} SET observed_at_ms=? WHERE line_number=?`).run(end - (110 - line) * MINUTE, line);
    incremental(parity(database, { label: `new distinct support ${line}` }).work, 2);
  }
  assert.equal(parity(database).actual.previousWindows.quota_5h.plannedResetAt, new Date(end).toISOString());
  for (const line of [2, 5, 6, 3, 4]) {
    remove(database, line);
    incremental(parity(database, { label: `delete support ${line}` }).work, 1);
  }
  assert.equal(parity(database).actual.limitId, null);
});

test("projection: deleting/inserting an old anchor propagates non-transitive cluster regrouping", (t) => {
  const { database } = fixture(t);
  const end = NOW - 900 * MINUTE;
  for (let line = 1; line <= 7; line += 1) {
    const reset = end + (line - 1) * 90_000;
    put(database, row(line, { resetsAtMs: reset, observedAtMs: reset - 299 * MINUTE }));
  }
  parity(database);
  remove(database, 1);
  const removed = parity(database, { label: "delete first anchor" }).work;
  incremental(removed, 1);
  assert.ok(removed.endpoints >= 5, "regrouping reaches later anchors");
  put(database, row(1, { resetsAtMs: end, observedAtMs: end - 299 * MINUTE }));
  incremental(parity(database, { label: "restore earlier anchor" }).work, 1);
  remove(database, 3);
  incremental(parity(database, { label: "delete middle anchor" }).work, 1);
  put(database, row(8, { resetsAtMs: end + 150_000, observedAtMs: end - 298 * MINUTE }));
  incremental(parity(database, { label: "insert between anchors" }).work, 1);
});

test("projection: same-timestamp conflicts and delayed old snapshots clear after deletion", (t) => {
  const { database } = fixture(t);
  history(database);
  parity(database);
  put(database, row(20, { observedAtMs: NOW - MINUTE, resetsAtMs: NOW + 200 * MINUTE }));
  put(database, row(21, { observedAtMs: NOW - MINUTE, resetsAtMs: NOW + 240 * MINUTE }));
  const conflict = parity(database, { label: "same timestamp conflicting reset" });
  incremental(conflict.work, 2);
  assert.equal(conflict.actual.windows.quota_5h.state, "ambiguous");
  assert.equal(conflict.actual.previousWindows.quota_5h.state, "ambiguous");
  remove(database, 20);
  incremental(parity(database, { label: "conflict removed" }).work, 1);
  // This old snapshot's first observation overlaps the following cycle's start.
  put(database, row(22, { observedAtMs: NOW - 59 * MINUTE, resetsAtMs: NOW - 2 * MINUTE }));
  assert.equal(parity(database, { label: "delayed snapshot" }).actual.previousWindows.quota_5h.state, "ambiguous");
  remove(database, 22);
  const recovered = parity(database, { label: "delayed snapshot removed" });
  incremental(recovered.work, 1);
  assert.equal(recovered.actual.previousWindows.quota_5h.state, "available");
});

test("projection: first official wins including invalid placeholders, raw shadows and deletion restores", (t) => {
  const { database } = fixture(t);
  const officials = [
    row(1, { sourcePath: "official", usedPercent: 11 }),
    row(1, { sourcePath: "official", usedPercent: 99, limitId: "other" }),
    row(2, { sourcePath: "official", windowMinutes: -1 }),
    row(2, { sourcePath: "official", usedPercent: 100, limitId: "other" }),
  ];
  assert.equal(parity(database, { officials }).actual.windows.quota_5h.usedPercent, 11);
  put(database, row(1, { sourcePath: "official", limitId: "" }));
  const shadowed = parity(database, { officials, label: "invalid raw shadows official" });
  incremental(shadowed.work, 1);
  assert.equal(shadowed.actual.limitId, null);
  remove(database, 1, "official");
  assert.equal(
    parity(database, { officials, label: "raw deletion restores first official" }).actual.windows.quota_5h.usedPercent,
    11,
  );
  officials[0] = row(1, { sourcePath: "official", usedPercent: 73 });
  incremental(parity(database, { officials, label: "official revision" }).work, 0);
  officials.splice(0, 1);
  assert.equal(parity(database, { officials, label: "first official deleted" }).actual.limitId, "other");
  officials.splice(0, 1);
  assert.equal(parity(database, { officials, label: "only invalid placeholder remains" }).actual.limitId, null);
});

test("projection: bucket ties, latest timestamp retraction and invalid-to-valid changes", (t) => {
  const { database } = fixture(t);
  put(database, row(1));
  parity(database);
  put(database, row(2, { limitId: "other" }));
  assert.equal(parity(database).actual.windows.quota_5h.state, "ambiguous");
  put(database, row(3, { observedAtMs: NOW }));
  assert.equal(parity(database).actual.limitId, "codex");
  put(database, row(4, { limitId: "other", observedAtMs: NOW }));
  assert.equal(parity(database).actual.windows.quota_5h.state, "ambiguous");
  database.prepare(`UPDATE ${TABLE} SET observed_at_ms=? WHERE line_number=4`).run(NOW - 2 * MINUTE);
  assert.equal(parity(database, { label: "latest timestamp retracted" }).actual.limitId, "codex");
  database.prepare(`UPDATE ${TABLE} SET window_minutes=0 WHERE limit_id='codex'`).run();
  assert.equal(parity(database, { label: "bucket becomes invalid" }).actual.limitId, "other");
  database.prepare(`UPDATE ${TABLE} SET window_minutes=300,limit_id='other' WHERE window_minutes=0`).run();
  incremental(parity(database, { label: "valid again in another bucket" }).work, 4);
});

test("projection: rowid and primary-key REPLACE retract victims across identities", (t) => {
  const { database } = fixture(t);
  const officials = [row(1, { usedPercent: 7 })];
  put(database, row(1, { usedPercent: 10 }), { rowid: 10 });
  put(database, row(2, { limitId: "other", usedPercent: 20 }), { rowid: 20 });
  parity(database, { officials });
  put(database, row(2, { observedAtMs: NOW, usedPercent: 30 }), { replace: true, rowid: 10 });
  const doubleVictim = parity(database, { officials, label: "rowid and PK delete different victims" });
  incremental(doubleVictim.work, 3);
  assert.equal(rawRows(database).length, 1);
  put(database, row(3, { limitId: "other", usedPercent: 40 }), { replace: true, rowid: 10 });
  incremental(parity(database, { officials, label: "explicit rowid cross identity" }).work, 2);
  put(database, row(3, { usedPercent: 50 }), { replace: true });
  incremental(parity(database, { officials, label: "implicit rowid primary-key replacement" }).work, 2);
  put(database, row(4, { usedPercent: 60 }), { rowid: -1 });
  parity(database, { officials });
  put(database, row(5, { usedPercent: 70 }), { replace: true, rowid: -1 });
  assert.equal(parity(database, { officials, label: "explicit minus-one rowid fallback" }).work.rebuilt, true);
});

test("projection: recursive trigger writes remain invalidated after ON then OFF", (t) => {
  const { database } = fixture(t);
  put(database, row(1));
  parity(database);
  database.exec("PRAGMA recursive_triggers=ON");
  put(database, row(2, { observedAtMs: NOW, usedPercent: 80 }), { replace: true, rowid: 1 });
  database.exec("PRAGMA recursive_triggers=OFF");
  const recovered = parity(database, { label: "ON write OFF read" });
  assert.equal(recovered.work.rebuilt, true);
  assert.equal(recovered.actual.windows.quota_5h.usedPercent, 80);
  put(database, row(3, { usedPercent: 81 }));
  incremental(parity(database, { label: "incremental after recursive recovery" }).work, 1);
});

test("projection: custom unique REPLACE fallback survives removing the index", (t) => {
  const { database } = fixture(t);
  put(database, row(1));
  parity(database);
  database.exec(`CREATE UNIQUE INDEX custom_quota_unique ON ${TABLE}(observed_at_ms)`);
  put(database, row(2, { limitId: "other", usedPercent: 82 }), { replace: true });
  const fallback = parity(database, { label: "custom unique eligible fallback", fast: false });
  assert.equal(fallback.work.fallback, true);
  assert.equal(fallback.actual.limitId, "other");
  database.exec("DROP INDEX custom_quota_unique");
  const recovered = parity(database, { label: "custom unique removed" });
  assert.equal(recovered.work.rebuilt, true);
  put(database, row(3, { limitId: "other", observedAtMs: NOW }));
  incremental(parity(database).work, 1);
  database.exec(`CREATE UNIQUE INDEX custom_quota_unique ON ${TABLE}(observed_at_ms)`);
  put(database, row(4, { limitId: "codex", observedAtMs: NOW, usedPercent: 83 }), { replace: true });
  database.exec("DROP INDEX custom_quota_unique");
  assert.equal(parity(database, { label: "create REPLACE drop without an intermediate read" }).work.rebuilt, true);
});

test("projection: more than 4096 queued changes rebuild correctly then resume incremental work", (t) => {
  const { database } = fixture(t);
  put(database, row(1));
  parity(database);
  database.exec("BEGIN");
  for (let line = 2; line <= 4100; line += 1) put(database, row(line));
  database.exec("COMMIT");
  const state = database.prepare(`SELECT rebuild,queued FROM ${PREFIX}state`).get();
  assert.equal(Number(state.rebuild), 1);
  assert.ok(Number(state.queued) <= 4096, "queue remains bounded");
  const rebuilt = parity(database, { label: "overflow rebuild" });
  assert.equal(rebuilt.work.rebuilt, true);
  assert.equal(Number(database.prepare(`SELECT COUNT(*) n FROM ${PREFIX}changes`).get().n), 0);
  put(database, row(4101, { usedPercent: 90 }));
  incremental(parity(database, { label: "after overflow" }).work, 1);
});

test("projection: rollback restores queued contributions and published state", (t) => {
  const { database } = fixture(t);
  history(database);
  parity(database);
  const before = database.prepare(`SELECT * FROM ${PREFIX}state`).get();
  database.exec("BEGIN");
  database.prepare(`UPDATE ${TABLE} SET used_percent=99 WHERE line_number=5`).run();
  remove(database, 1);
  put(database, row(30, { observedAtMs: NOW }));
  const during = parity(database, { label: "transaction local", fast: false });
  assert.equal(during.work.fallback, true);
  assert.equal(during.actual.windows.quota_5h.usedPercent, 20);
  database.exec("ROLLBACK");
  assert.deepEqual(database.prepare(`SELECT * FROM ${PREFIX}state`).get(), before);
  assert.equal(Number(database.prepare(`SELECT COUNT(*) n FROM ${PREFIX}changes`).get().n), 0);
  incremental(parity(database, { label: "after rollback" }).work, 0);
  put(database, row(31, { observedAtMs: NOW, usedPercent: 91 }));
  incremental(parity(database).work, 1);
});

test("projection: WAL pinned reader keeps old windows while writer publishes new projection", (t) => {
  const { database: writer, open } = fixture(t, true);
  history(writer);
  parity(writer);
  const reader = open();
  assert.equal(ensureUsageQuotaSchema(reader), true);
  reader.exec(`BEGIN; SELECT COUNT(*) FROM ${TABLE}`);
  const pinned = oracleRows(reader, []);
  const oldState = reader.prepare(`SELECT * FROM ${PREFIX}state`).get();
  writer.prepare(`UPDATE ${TABLE} SET used_percent=95 WHERE line_number=5`).run();
  put(writer, row(40, { observedAtMs: NOW, usedPercent: 96 }));
  parity(writer, { label: "writer committed while reader pinned" });
  assert.deepEqual(oracleRows(reader, []), pinned);
  parity(reader, { label: "pinned matching cache" });
  const oldClock = parity(reader, { asOf: NOW + 300 * MINUTE, label: "pinned clock crosses reset" });
  incremental(oldClock.work, 0);
  assert.deepEqual(reader.prepare(`SELECT * FROM ${PREFIX}state`).get(), oldState);
  reader.exec("ROLLBACK");
  const fresh = parity(reader, { label: "reader released snapshot" });
  assert.equal(fresh.actual.windows.quota_5h.usedPercent, 96);
});

test("projection: 320 deterministic mutations match both independent algorithms after every step", (t) => {
  const { database } = fixture(t);
  history(database);
  parity(database);
  let seed = 0x713ac09;
  const random = (n) => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return Math.floor((seed / 0x1_0000_0000) * n);
  };
  let asOf = NOW;
  const officials = [];
  const operations = Array(8).fill(0);
  for (let step = 0; step < 320; step += 1) {
    const line = 50 + random(40);
    const minutes = random(4) ? 300 : 10_080;
    const reset = NOW + (random(7) - 4) * minutes * MINUTE + random(7) * 60_000;
    const observation = row(line, {
      limitId: random(5) ? "codex" : "other",
      windowMinutes: minutes,
      resetsAtMs: reset,
      observedAtMs: reset - (minutes - random(20)) * MINUTE,
      usedPercent: random(5) ? random(101) : null,
    });
    const operation = random(8);
    operations[operation] += 1;
    if (operation <= 2) put(database, observation, { replace: true });
    else if (operation === 3) remove(database, line);
    else if (operation === 4)
      database
        .prepare(`UPDATE ${TABLE} SET used_percent=?,observed_at_ms=? WHERE source_path='raw' AND line_number=?`)
        .run(observation.usedPercent, observation.observedAtMs, line);
    else if (operation === 5) {
      officials.length = 0;
      officials.push(
        row(1, { ...observation, sourcePath: "official", lineNumber: 1 }),
        row(1, { sourcePath: "official", limitId: "other" }),
      );
    } else if (operation === 6) asOf += (1 + random(15)) * MINUTE;
    else {
      database.exec("BEGIN");
      put(database, observation, { replace: true });
      database.exec("ROLLBACK");
    }
    const result = parity(database, { asOf, officials, label: `seed 0x713ac09 step ${step} op ${operation}` });
    assert.equal(result.work.rebuilt, false, `seed step ${step}: bounded mutations stay incremental`);
  }
  assert.ok(
    operations.every((count) => count >= 15),
    `all mutation classes exercised: ${operations}`,
  );
});

test("projection review: missing queued contribution rebuilds instead of publishing stale values", (t) => {
  const { database } = fixture(t);
  put(database, row(1));
  selectStoredQuotaWindows(database, NOW);
  put(database, row(2, { observedAtMs: NOW, usedPercent: 80 }));
  database.exec(`DELETE FROM ${PREFIX}changes`);
  parity(database, { label: "queued=1 but its row is missing" });
});

test("projection review: ordinary append must not inspect every historical cycle for order conflicts", (t) => {
  const { database } = fixture(t);
  for (let cycle = 0; cycle < 32; cycle += 1) {
    const observed = NOW - (32 - cycle) * 300 * MINUTE;
    put(database, row(cycle + 1, { observedAtMs: observed, resetsAtMs: observed + 240 * MINUTE }));
  }
  let visits = 0;
  database.function("quota_review_visit", () => {
    visits += 1;
    return 1;
  });
  const observedDatabase = {
    get isTransaction() {
      return database.isTransaction;
    },
    exec(sql) {
      return database.exec(sql);
    },
    prepare(sql) {
      // A true predicate counts visited rows without changing the returned windows.
      return database.prepare(
        sql.includes("order_conflict=1 LIMIT 1")
          ? sql.replace("AND order_conflict=1", "AND quota_review_visit() AND order_conflict=1")
          : sql,
      );
    },
  };
  selectStoredQuotaWindows(observedDatabase, NOW);
  visits = 0;
  put(database, row(40, { observedAtMs: NOW, usedPercent: 80 }));
  const actual = selectStoredQuotaWindows(observedDatabase, NOW);
  assert.deepEqual(actual, selectQuotaWindows(oracleRows(database, []), NOW));
  incremental(quotaProjectionWork(observedDatabase), 1);
  assert.ok(quotaProjectionWork(observedDatabase).cycles <= 2);
  assert.ok(visits <= 2, `ordinary append visited ${visits} historical cycles for order_conflict=1`);
});

test("projection review: readonly missing derived index uses the original SQL fallback", (t) => {
  const { database, open } = fixture(t, true);
  put(database, row(1));
  selectStoredQuotaWindows(database, NOW);
  database.exec(`DROP INDEX ${PREFIX}point_time_idx`);
  const readOnly = open({ readOnly: true });
  parity(readOnly, { label: "readonly index repair unavailable", fast: false });
});

test("current expired windows seek by reset time instead of inspecting historical observations", (t) => {
  const { database } = fixture(t);
  for (let index = 1; index <= 64; index += 1) {
    const reset = NOW - index * 300 * MINUTE;
    put(database, row(index, { observedAtMs: reset - MINUTE, resetsAtMs: reset }));
  }
  selectStoredQuotaWindows(database, NOW);
  put(database, row(100, { observedAtMs: NOW - 2 * MINUTE, resetsAtMs: NOW - MINUTE }));
  let visits = 0;
  database.function("quota_current_visit", (value) => {
    visits += 1;
    return value;
  });
  const observed = {
    get isTransaction() {
      return database.isTransaction;
    },
    exec(sql) {
      return database.exec(sql);
    },
    prepare(sql) {
      return database.prepare(
        sql.replace(
          "AND resets_at_ms - window_minutes * ?",
          "AND quota_current_visit(resets_at_ms) - window_minutes * ?",
        ),
      );
    },
  };
  assert.deepEqual(selectStoredQuotaWindows(observed, NOW), selectQuotaWindows(rawRows(database), NOW));
  assert.equal(quotaProjectionWork(observed).rebuilt, false);
  assert.ok(visits <= 2, `expired current-window query visited ${visits} historical observations`);
});

test("current windows skip historical observations whose resets are far in the future", (t) => {
  const { database } = fixture(t);
  for (let index = 1; index <= 64; index += 1)
    put(database, row(index, { observedAtMs: NOW - index * MINUTE, resetsAtMs: NOW + (1000 + index) * MINUTE }));
  selectStoredQuotaWindows(database, NOW);
  put(database, row(100, { observedAtMs: NOW, resetsAtMs: NOW + 2000 * MINUTE }));
  let visits = 0;
  database.function("quota_future_visit", (value) => {
    visits += 1;
    return value;
  });
  const observed = {
    get isTransaction() {
      return database.isTransaction;
    },
    exec(sql) {
      return database.exec(sql);
    },
    prepare(sql) {
      return database.prepare(
        sql.replace(
          "AND resets_at_ms - window_minutes * ?",
          "AND quota_future_visit(resets_at_ms) - window_minutes * ?",
        ),
      );
    },
  };
  assert.deepEqual(selectStoredQuotaWindows(observed, NOW), selectQuotaWindows(rawRows(database), NOW));
  assert.equal(quotaProjectionWork(observed).rebuilt, false);
  assert.ok(visits <= 2, `current-window query visited ${visits} irrelevant future-reset observations`);
});

test("the current reset seek preserves exact boundary arithmetic, including fractional resets and large dates", (t) => {
  for (const asOf of [-8_000_000_000_000_000, -1, 0, NOW, 8_000_000_000_000_000]) {
    const { database } = fixture(t);
    for (const minutes of [300, 10_080])
      for (const offset of [-2, -0.25, 0, 0.25, 2]) {
        const official = [
          row(1, { observedAtMs: asOf, resetsAtMs: asOf + minutes * MINUTE + offset, windowMinutes: minutes }),
        ];
        assert.deepEqual(selectStoredQuotaWindows(database, asOf, official), selectQuotaWindows(official, asOf));
      }
  }
});

test("projection review: unexpected install SQL errors must escape the legacy schema catch", (t) => {
  const { database } = fixture(t);
  database.exec(`DROP INDEX ${PREFIX}point_time_idx`);
  const observedDatabase = {
    get isTransaction() {
      return database.isTransaction;
    },
    prepare(sql) {
      return database.prepare(sql);
    },
    exec(sql) {
      if (sql.includes(`CREATE TABLE ${PREFIX}points`)) throw new Error("injected quota schema SQL error");
      return database.exec(sql);
    },
  };
  assert.throws(() => ensureUsageQuotaSchema(observedDatabase), /injected quota schema SQL error/);
});

test("projection review: unrelated source schema changes do not rebuild the quota projection", (t) => {
  const { database } = fixture(t);
  history(database);
  parity(database);
  database.exec("CREATE TABLE source_review_metadata(path TEXT PRIMARY KEY, revision INTEGER)");
  database.exec("CREATE INDEX source_review_revision_idx ON source_review_metadata(revision)");
  put(database, row(50, { observedAtMs: NOW, usedPercent: 80 }));
  incremental(parity(database, { label: "unrelated source DDL" }).work, 1);
  database.exec("ALTER TABLE source_review_metadata ADD COLUMN mtime REAL");
  database.exec("DROP INDEX source_review_revision_idx");
  incremental(parity(database, { asOf: NOW + MINUTE, label: "more unrelated source DDL" }).work, 0);
});

test("projection review: noncanonical official line identities remain distinct and NUL falls back correctly", (t) => {
  const { database } = fixture(t);
  put(database, row(1));
  const officials = ["01", "+1", "1.0", "1e0", " 1 "].map((line) => row(line, { usedPercent: 80 }));
  assert.equal(parity(database, { officials, label: "noncanonical lines" }).actual.windows.quota_5h.usedPercent, null);
  const nul = row(1, { sourcePath: "official\0suffix", usedPercent: 40 });
  officials.push(nul, { ...nul, usedPercent: 99 });
  parity(database, { officials, label: "NUL official first identity wins", fast: false });
  put(database, row(1, { sourcePath: "official\0suffix", limitId: "" }));
  parity(database, { officials, label: "NUL invalid raw placeholder", fast: false });
  remove(database, 1, "official\0suffix");
  parity(database, { officials, label: "NUL raw removed", fast: false });
});

test("projection review: missing state, table or index can be rebuilt from facts", (t) => {
  const { database } = fixture(t);
  put(database, row(1));
  parity(database);
  database.exec(`DELETE FROM ${PREFIX}state`);
  put(database, row(2, { observedAtMs: NOW, usedPercent: 80 }));
  assert.equal(parity(database, { label: "missing state" }).work.rebuilt, true);
  database.exec(`DROP TABLE ${PREFIX}buckets`);
  assert.equal(parity(database, { label: "missing table" }).work.rebuilt, true);
  database.exec(`DROP INDEX ${PREFIX}point_time_idx`);
  assert.equal(parity(database, { label: "missing index" }).work.rebuilt, true);
});
