import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { rebuildUsageRollupsFromEvents } from "../src/usage-rollups.js";

const TEMP_EVENT_TABLE = "usage_rollup_complete_events";
const EVENTS = Object.freeze([
  {
    timestamp: "2026-07-12T00:30:00.000Z",
    sessionId: "shared-session",
    homeId: "home-a",
    model: "gpt-6-sol",
    cwd: "/repo/alpha",
    repositoryKey: "git:alpha",
    repositoryPath: "alpha",
    repositoryKind: "git",
    detailMask: 15,
    reconciliationGap: 0,
    total: { total: 20, input: 12, cached: 4, output: 6, reasoning: 1 },
  },
  {
    timestamp: "2026-07-12T02:00:00.000Z",
    sessionId: "shared-session",
    homeId: "home-a",
    model: "gpt-6-sol",
    cwd: "/repo/alpha",
    detailMask: 0,
    total: { total: 8, input: 5, cached: 2, output: 2, reasoning: 0 },
  },
  {
    timestamp: "2026-07-12T23:30:00.000Z",
    sessionId: "shared-session",
    homeId: "home-b",
    model: "deepseek-chat",
    project: "",
    detailMask: 18,
    reconciliationGap: 3,
    total: { total: 13, input: 7, cached: 1, output: 4, reasoning: 2 },
  },
  {
    timestamp: "2026-07-13T02:00:00.000Z",
    sessionId: "shared-session",
    homeId: "home-b",
    model: "deepseek-chat",
    cwd: "/repo/beta",
    detailMask: 31,
    total: { total: 11, input: 6, cached: 2, output: 3, reasoning: 1 },
  },
]);

function openDatabase() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "usage-rollup-iterator-"));
  const db = new DatabaseSync(path.join(directory, "index.sqlite"));
  db.exec(`
    CREATE TABLE events (
      timestamp_ms INTEGER NOT NULL,
      home_id TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'gpt-6-sol',
      session_id TEXT,
      cwd TEXT NOT NULL DEFAULT '',
      repository_key TEXT NOT NULL DEFAULT 'unknown:cwd',
      repository_path TEXT NOT NULL DEFAULT 'Unknown cwd',
      repository_kind TEXT NOT NULL DEFAULT 'unknown',
      detail_mask INTEGER NOT NULL DEFAULT 0,
      reconciliation_gap INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL,
      input INTEGER NOT NULL,
      cached INTEGER NOT NULL,
      output INTEGER NOT NULL,
      reasoning INTEGER NOT NULL
    ) STRICT
  `);
  return { db, directory };
}

function closeDatabase(database) {
  database.db.close();
  rmSync(database.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function* eventGenerator(events) {
  yield* events;
}

function localDayKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function eventDays(events, zone) {
  return [
    ...new Set(events.map((event) => (zone === "utc" ? event.timestamp.slice(0, 10) : localDayKey(event.timestamp)))),
  ].sort();
}

function rows(db, table, orderBy) {
  return db
    .prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`)
    .all()
    .map((row) => ({ ...row }));
}

function rollupSnapshot(db) {
  return {
    days: rows(db, "usage_rollup_days", "calendar_zone, day_key"),
    daily: rows(db, "usage_rollup_daily", "calendar_zone, day_key, home_id"),
    models: rows(db, "usage_rollup_models", "calendar_zone, day_key, home_id, model"),
    repositories: rows(db, "usage_rollup_repositories", "calendar_zone, day_key, home_id, repository_key, cwd"),
    sessions: rows(db, "usage_rollup_sessions", "calendar_zone, day_key, home_id, session_id"),
  };
}

function tempTableExists(db) {
  return Boolean(
    db.prepare("SELECT 1 FROM temp.sqlite_master WHERE type = 'table' AND name = ?").get(TEMP_EVENT_TABLE),
  );
}

test("single-use generator and array produce identical full UTC and local rollups", () => {
  for (const calendarZone of ["utc", "local"]) {
    const expectedDatabase = openDatabase();
    const iteratorDatabase = openDatabase();
    try {
      const days = eventDays(EVENTS, calendarZone);
      rebuildUsageRollupsFromEvents(expectedDatabase.db, {
        days,
        events: EVENTS.slice(),
        calendarZone,
      });
      rebuildUsageRollupsFromEvents(iteratorDatabase.db, {
        days,
        events: eventGenerator(EVENTS),
        calendarZone,
      });

      const expected = rollupSnapshot(expectedDatabase.db);
      assert.deepEqual(rollupSnapshot(iteratorDatabase.db), expected, calendarZone);
      assert.equal(
        expected.days.every((row) => row.calendar_zone === calendarZone),
        true,
      );
      assert.equal(
        expected.sessions.some((row) => row.session_id === "shared-session") &&
          expected.sessions.some((row) => row.home_id === "home-a") &&
          expected.sessions.some((row) => row.home_id === "home-b"),
        true,
      );
      assert.equal(
        expected.repositories.some((row) => row.repository_key === "directory:/repo/alpha"),
        true,
      );
      assert.equal(
        expected.repositories.some((row) => row.repository_key === "unknown:cwd"),
        true,
      );
      assert.equal(
        expected.daily.some((row) => row.input_unavailable_tokens > 0),
        true,
      );
    } finally {
      closeDatabase(expectedDatabase);
      closeDatabase(iteratorDatabase);
    }
  }
});

test("iterator failure preserves existing aggregates, closes the iterator, and removes the temp table", () => {
  const database = openDatabase();
  try {
    const days = eventDays(EVENTS, "utc");
    rebuildUsageRollupsFromEvents(database.db, {
      days,
      events: EVENTS.slice(0, 2),
      calendarZone: "utc",
    });
    const before = rollupSnapshot(database.db);
    assert.equal(tempTableExists(database.db), false);

    let returned = false;
    const failingEvents = {
      [Symbol.iterator]() {
        let index = 0;
        return {
          next() {
            if (index++ === 0) return { value: EVENTS[0], done: false };
            throw Object.assign(new Error("iterator boom"), { code: "ITERATOR_BOOM" });
          },
          return() {
            returned = true;
            return { value: undefined, done: true };
          },
        };
      },
    };

    assert.throws(
      () =>
        rebuildUsageRollupsFromEvents(database.db, {
          days,
          events: failingEvents,
          calendarZone: "utc",
        }),
      (error) => error.code === "ITERATOR_BOOM",
    );
    assert.equal(returned, true);
    assert.deepEqual(rollupSnapshot(database.db), before);
    assert.equal(tempTableExists(database.db), false);
  } finally {
    closeDatabase(database);
  }
});

test("null, string, non-iterable, and async-only events are rejected without temp state", () => {
  const database = openDatabase();
  try {
    const asyncOnly = {
      [Symbol.asyncIterator]: async function* () {
        yield EVENTS[0];
      },
    };
    for (const events of [null, "not an iterable", {}, asyncOnly]) {
      assert.throws(
        () => rebuildUsageRollupsFromEvents(database.db, { days: ["2026-07-12"], events }),
        (error) => error instanceof TypeError && /synchronous iterable/.test(error.message),
      );
      assert.equal(tempTableExists(database.db), false);
    }
  } finally {
    closeDatabase(database);
  }
});
