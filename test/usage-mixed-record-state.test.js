import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  buildStoredRecordChampions,
  ensureUsageRecordSchema,
  markStoredHistoryRecordsDirty,
  readStoredRecordChampions,
  USAGE_HISTORY_RECORD_TABLE_NAMES,
} from "../src/usage-record-store.js";

const BASE = Date.parse("2026-07-01T01:00:00Z");
const DAY = 86400_000;
const SCALARS = [
  "total_tokens",
  "input_tokens",
  "cached_tokens",
  "output_tokens",
  "reasoning_tokens",
  "total_cost",
  "input_cost",
  "cached_cost",
  "output_cost",
];
const METRICS = {
  totalTokens: "total_tokens",
  inputTokens: "input_tokens",
  cachedTokens: "cached_tokens",
  outputTokens: "output_tokens",
  reasoningTokens: "reasoning_tokens",
  sessionCount: "session_count",
  modelCount: "model_count",
  totalCost: "total_cost",
  inputCost: "input_cost",
  cachedCost: "cached_cost",
  outputCost: "output_cost",
  cacheHitRate: "cache_hit_rate",
};

function createEvents(db) {
  db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,history_ordinal INTEGER NOT NULL,
    timestamp_ms INTEGER NOT NULL,session_id TEXT NOT NULL,model TEXT NOT NULL,channel TEXT NOT NULL,
    home_id TEXT NOT NULL,day_key TEXT NOT NULL,week_key TEXT NOT NULL,month_key TEXT NOT NULL,
    total REAL NOT NULL,input REAL NOT NULL,cached REAL NOT NULL,output REAL NOT NULL,reasoning REAL NOT NULL,
    detail_mask INTEGER DEFAULT 0,cache_write_tokens INTEGER DEFAULT 0,cache_write_known INTEGER DEFAULT 1,
    request_input_tokens INTEGER DEFAULT 0,context_level TEXT DEFAULT 'short',service_tier TEXT DEFAULT 'standard',
    UNIQUE(timestamp_ms,history_ordinal)) STRICT;`);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-mixed-record-"));
  const file = path.join(root, "projection.sqlite");
  const value = { file, database: new DatabaseSync(file), revision: 0 };
  t.after(async () => {
    if (value.database.isTransaction) value.database.exec("ROLLBACK");
    value.database.close();
    await rm(root, { recursive: true, force: true });
  });
  value.database.exec("PRAGMA journal_mode=WAL");
  createEvents(value.database);
  ensureUsageRecordSchema(value.database, { mode: "history" });
  return value;
}

function row(id, timestamp_ms, history_ordinal = 0, extra = {}) {
  const day = new Date(timestamp_ms).toISOString().slice(0, 10);
  const date = new Date(timestamp_ms);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() || 7) - 1));
  return {
    id,
    timestamp_ms,
    history_ordinal,
    session_id: "共享会话🚀",
    model: "模型α",
    channel: "CLI",
    home_id: "hot",
    day_key: day,
    week_key: date.toISOString().slice(0, 10),
    month_key: day.slice(0, 7),
    total: 100,
    input: 60,
    cached: 10,
    output: 40,
    reasoning: 1,
    ...extra,
  };
}

function change(
  value,
  added = [],
  removed = [],
  marks = added.map((x) => ({ ms: x.timestamp_ms, id: x.history_ordinal })),
) {
  const db = value.database;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const id of removed) db.prepare("DELETE FROM events WHERE id=?").run(id);
    for (const item of added) {
      const columns = Object.keys(item);
      db.prepare(`INSERT OR REPLACE INTO events(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(
        ...Object.values(item),
      );
    }
    for (const mark of marks) markStoredHistoryRecordsDirty(db, mark);
    db.exec("COMMIT");
    value.revision++;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function reopen(value) {
  value.database.close();
  value.database = new DatabaseSync(value.file);
}

function estimate(row) {
  assert.ok(Object.hasOwn(row, "fact_id"));
  return {
    currency: row.home_id === "cold" ? "CNY" : "USD",
    totalUsd: Number(row.total) / 1000,
    inputUsd: Number(row.input) / 1000,
    cachedInputUsd: Number(row.cached) / 1000,
    outputUsd: Number(row.output) / 1000,
  };
}

function options(value, extra = {}) {
  return {
    database: value.database,
    mode: "history",
    key: "records-v1",
    factsKey: String(value.revision),
    zone: "utc",
    estimateRow: estimate,
    usdToCnyRate: 7.3,
    batchSize: 2,
    ...extra,
  };
}

function oracle(value, input) {
  const groups = new Map();
  const rows = (input.sourceDatabase || value.database)
    .prepare(`SELECT * FROM events ${input.where || ""}
    ORDER BY timestamp_ms,history_ordinal`)
    .all(...(input.params || []));
  for (const item of rows) {
    const keys = input.zone === "local" ? item : row(item.id, Number(item.timestamp_ms));
    const priced = estimate({ ...item, fact_id: item.id, id: item.history_ordinal });
    const rate = priced.currency === "CNY" ? 1 : input.usdToCnyRate;
    for (const unit of ["day", "week", "month"]) {
      const key = `${unit}:${keys[`${unit}_key`]}`;
      let state = groups.get(key);
      if (!state) {
        state = {
          unit,
          period_key: keys[`${unit}_key`],
          ...Object.fromEntries(SCALARS.map((x) => [x, 0])),
          sessions: new Set(),
          models: new Set(),
        };
        groups.set(key, state);
      }
      for (const field of ["total", "input", "cached", "output", "reasoning"])
        state[`${field}_tokens`] += Number(item[field]);
      state.total_cost += priced.totalUsd * rate;
      state.input_cost += priced.inputUsd * rate;
      state.cached_cost += priced.cachedInputUsd * rate;
      state.output_cost += priced.outputUsd * rate;
      state.sessions.add(JSON.stringify([item.home_id, item.session_id]));
      state.models.add(item.model);
    }
  }
  const periods = [...groups.values()]
    .map(({ sessions, models, ...state }) => ({ ...state, session_count: sessions.size, model_count: models.size }))
    .sort((a, b) => a.unit.localeCompare(b.unit) || a.period_key.localeCompare(b.period_key));
  const champions = { day: {}, week: {}, month: {} };
  for (const unit of Object.keys(champions)) {
    for (const [metric, column] of Object.entries(METRICS)) {
      const ranked = periods
        .filter((x) => x.unit === unit)
        .map((x) => ({
          period: x.period_key,
          value: column === "cache_hit_rate" ? (x.input_tokens > 0 ? x.cached_tokens / x.input_tokens : 0) : x[column],
        }))
        .filter((x) => x.value > 0)
        .sort((a, b) => b.value - a.value);
      if (ranked.length >= 2 && ranked[0].value > ranked[1].value) champions[unit][metric] = ranked[0];
    }
  }
  return { periods, champions };
}

function assertOracle(value, input = options(value)) {
  const expected = oracle(value, input);
  const actual = buildStoredRecordChampions(input);
  assert.deepEqual(actual, expected.champions);
  assert.deepEqual(readStoredRecordChampions(input), actual);
  const periods = input.database
    .prepare(`SELECT unit,period_key,${SCALARS.join(",")},session_count,model_count
    FROM usage_history_record_cache_periods ORDER BY unit,period_key`)
    .all()
    .map((x) => ({ ...x }));
  assert.deepEqual(periods, expected.periods);
  return actual;
}

test("history uses logical order and fact aliases, keeps currency floats exact, and reopens with no writes", async (t) => {
  const value = await fixture(t);
  change(value, [
    row(30, BASE),
    row(5, BASE + DAY, 0, { total: 200 }),
    row(10, BASE + DAY, 1, { total: 300, model: "模型😀" }),
  ]);
  const priced = [];
  const input = options(value, {
    usdToCnyRate: 1,
    estimateRow(item) {
      priced.push([item.fact_id, item.id, item.timestamp_ms]);
      return estimate(item);
    },
  });
  assertOracle(value, input);
  assert.deepEqual(priced, [
    [30, 0, BASE],
    [5, 0, BASE + DAY],
    [10, 1, BASE + DAY],
  ]);
  assert.equal(
    value.database.prepare("SELECT total_cost FROM usage_history_record_cache_periods WHERE unit='week'").get()
      .total_cost,
    0.1 + 0.2 + 0.3,
  );
  change(value, [row(1, BASE + 2 * DAY, 0, { home_id: "cold", total: 400 })]);
  const result = assertOracle(value, options(value, { usdToCnyRate: 1 }));
  reopen(value);
  const schema = value.database.prepare("PRAGMA schema_version").get().schema_version;
  ensureUsageRecordSchema(value.database, { mode: "history" });
  const reopened = options(value, {
    usdToCnyRate: 1,
    estimateRow() {
      throw new Error("ready projection priced events");
    },
  });
  assert.deepEqual(buildStoredRecordChampions(reopened), result);
  assert.deepEqual(readStoredRecordChampions(reopened), result);
  assert.equal(value.database.prepare("SELECT total_changes() n").get().n, 0);
  assert.equal(value.database.prepare("PRAGMA schema_version").get().schema_version, schema);
  assert.deepEqual(
    value.database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'usage_%record_%' ORDER BY name")
      .all()
      .map((x) => x.name),
    [...USAGE_HISTORY_RECORD_TABLE_NAMES].sort(),
  );
  assert.equal(value.database.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger'").get().n, 0);
});

test("late history facts rebuild only affected periods rather than following physical ids", async (t) => {
  const value = await fixture(t);
  const old = Date.parse("2026-05-01T01:00:00Z");
  change(value, [row(1, old), row(50, BASE), row(10, BASE + DAY)]);
  assertOracle(value);
  change(value, [row(100, BASE - 1, 0, { session_id: "迟到", total: 200 })]);
  const priced = [];
  assertOracle(
    value,
    options(value, {
      estimateRow(item) {
        priced.push(item.fact_id);
        return estimate(item);
      },
    }),
  );
  assert.ok(priced.length > 0);
  assert.equal(priced.includes(1), false, "unaffected May is never priced during July repair");
  assert.equal(priced.filter((id) => id === 100).length, 3, "each affected unit accumulates its original event stream");
});

test("history same-timestamp reorder and dirty resume preserve compound positions and floating tails", async (t) => {
  const value = await fixture(t);
  change(value, [
    row(30, BASE, 0),
    row(5, BASE, 1, { total: 200 }),
    row(10, BASE, 2, { total: 300 }),
    row(1, BASE + DAY),
  ]);
  assertOracle(value, options(value, { usdToCnyRate: 1 }));
  change(
    value,
    [row(30, BASE, 2), row(5, BASE, 1, { total: 200 }), row(10, BASE, 0, { total: 300 })],
    [30, 5, 10],
    [{ ms: BASE, id: 0 }],
  );
  const input = options(value, {
    usdToCnyRate: 1,
    batchSize: 1,
    afterBatch() {
      throw new Error("stop dirty");
    },
  });
  assert.throws(() => buildStoredRecordChampions(input), /stop dirty/);
  const progress = value.database
    .prepare(
      "SELECT last_ms,last_event_id FROM usage_history_record_cache_work WHERE unit='day' AND period_key='2026-07-01'",
    )
    .get();
  assert.deepEqual({ ...progress }, { last_ms: BASE, last_event_id: 0 });
  assert.equal(readStoredRecordChampions(input), null);
  reopen(value);
  const priced = [];
  assertOracle(
    value,
    options(value, {
      usdToCnyRate: 1,
      batchSize: 1,
      estimateRow(item) {
        priced.push(item.fact_id);
        return estimate(item);
      },
    }),
  );
  assert.deepEqual(priced.slice(0, 2), [5, 30]);
  assert.equal(
    value.database
      .prepare("SELECT total_cost FROM usage_history_record_cache_periods WHERE unit='day' AND period_key='2026-07-01'")
      .get().total_cost,
    0.3 + 0.2 + 0.1,
  );
  assert.notEqual(0.1 + 0.2 + 0.3, 0.3 + 0.2 + 0.1);
});

test("history merges source contributions before ranking, lowers old winners, and suppresses champion ties", async (t) => {
  const value = await fixture(t);
  change(value, [
    row(9, BASE, 0, { total: 100 }),
    row(3, BASE + DAY, 0, { home_id: "cold", total: 100 }),
    row(7, BASE + 2 * DAY, 0, { total: 70 }),
    row(1, BASE + 2 * DAY, 1, { home_id: "cold", total: 70 }),
  ]);
  const result = assertOracle(value);
  assert.deepEqual(result.day.totalTokens, { period: "2026-07-03", value: 140 });
  for (const home of ["hot", "cold"]) {
    const own = oracle(value, options(value, { where: "WHERE home_id=?", params: [home] })).champions;
    assert.notEqual(own.day.totalTokens.period, "2026-07-03");
  }
  assert.equal(
    value.database
      .prepare(
        "SELECT session_count FROM usage_history_record_cache_periods WHERE unit='day' AND period_key='2026-07-03'",
      )
      .get().session_count,
    2,
  );
  change(value, [row(7, BASE + 2 * DAY, 0, { total: 10, session_id: "修订" })]);
  assert.equal(assertOracle(value).day.totalTokens, undefined);
  change(value, [], [9], [{ ms: BASE, id: 0 }]);
  assert.deepEqual(assertOracle(value).day.totalTokens, { period: "2026-07-02", value: 100 });
});

test("history dirty marking finds deleted local keys from published bounds and rolls back with facts", async (t) => {
  const value = await fixture(t);
  const original = row(1, BASE, 0, { day_key: "2026-06-30", week_key: "2026-06-29", month_key: "2026-06" });
  change(value, [original, row(2, BASE + 2 * DAY)]);
  assertOracle(value, options(value, { zone: "local" }));
  value.database.exec("BEGIN IMMEDIATE");
  value.database.prepare("DELETE FROM events WHERE id=1").run();
  markStoredHistoryRecordsDirty(value.database, { ms: BASE, id: 0 });
  assert.equal(
    value.database
      .prepare(
        "SELECT COUNT(*) n FROM usage_history_record_cache_dirty WHERE calendar_zone='local' AND period_key='2026-06'",
      )
      .get().n,
    1,
  );
  value.database.exec("ROLLBACK");
  assert.equal(value.database.prepare("SELECT COUNT(*) n FROM usage_history_record_cache_dirty").get().n, 0);
  change(
    value,
    [row(1, BASE + 3 * DAY)],
    [1],
    [
      { ms: BASE, id: 0 },
      { ms: BASE + 3 * DAY, id: 0 },
    ],
  );
  assertOracle(value, options(value, { zone: "local" }));
  assert.equal(
    value.database
      .prepare("SELECT COUNT(*) n FROM usage_history_record_cache_periods WHERE period_key IN ('2026-06-30','2026-06')")
      .get().n,
    0,
  );
  assert.throws(() => markStoredHistoryRecordsDirty(value.database, { ms: BASE, id: 0.5 }), /dirty position/);
});

test("history full builds reopen after a committed batch with repeated ordinals and resume after the logical tuple", async (t) => {
  const value = await fixture(t);
  change(value, [row(100, BASE), row(1, BASE + 1), row(50, BASE + 1, 1), row(2, BASE + DAY)]);
  assert.throws(
    () =>
      buildStoredRecordChampions(
        options(value, {
          batchSize: 2,
          afterBatch() {
            throw new Error("stop full");
          },
        }),
      ),
    /stop full/,
  );
  assert.deepEqual(
    { ...value.database.prepare("SELECT last_ms,last_event_id FROM usage_history_record_cache").get() },
    { last_ms: BASE + 1, last_event_id: 0 },
  );
  reopen(value);
  const priced = [];
  assertOracle(
    value,
    options(value, {
      estimateRow(item) {
        priced.push(item.fact_id);
        return estimate(item);
      },
    }),
  );
  assert.deepEqual(priced, [50, 2]);
});

test("history supports a separate frozen source and destination without events", async (t) => {
  const value = await fixture(t);
  change(value, [
    row(30, BASE),
    row(1, BASE, 1, { total: 200 }),
    row(2, BASE + DAY, 0, { total: 500, home_id: "cold" }),
  ]);
  const destination = new DatabaseSync(":memory:");
  try {
    value.database.exec("BEGIN");
    value.database.prepare("SELECT COUNT(*) FROM events").get();
    const input = options(value, {
      database: destination,
      sourceDatabase: value.database,
      where: "WHERE home_id=?",
      params: ["hot"],
    });
    assertOracle(value, input);
    assert.equal(value.database.isTransaction, true);
    assert.equal(destination.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger'").get().n, 0);
    assert.equal(destination.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='events'").get().n, 0);
    value.database.exec("ROLLBACK");
  } finally {
    destination.close();
  }
});

test("hot FORMAT=10 and cached reuse retain their schema, physical id order and writes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    createEvents(db);
    ensureUsageRecordSchema(db);
    const value = { database: db, revision: 0 };
    change(value, [row(30, BASE), row(5, BASE, 1, { total: 200 }), row(10, BASE, 2, { total: 300 })], [], []);
    const priced = [];
    const input = options(value, {
      mode: "hot",
      usdToCnyRate: 1,
      estimateRow(item) {
        priced.push(item.id);
        return estimate({ ...item, fact_id: item.id });
      },
    });
    const first = buildStoredRecordChampions(input);
    assert.deepEqual(priced, [5, 10, 30]);
    const schema = db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
    const writes = db.prepare("SELECT total_changes() n").get().n;
    ensureUsageRecordSchema(db);
    assert.deepEqual(
      buildStoredRecordChampions({
        ...input,
        estimateRow() {
          throw new Error("hot cache priced events");
        },
      }),
      first,
    );
    assert.deepEqual(readStoredRecordChampions(input), first);
    assert.deepEqual(db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all(), schema);
    assert.equal(db.prepare("SELECT total_changes() n").get().n, writes);
    assert.equal(db.prepare("SELECT format_version FROM usage_record_cache_format").get().format_version, 10);
    assert.equal(
      db
        .prepare("PRAGMA table_info(usage_record_cache)")
        .all()
        .some((x) => x.name === "last_ms"),
      false,
    );
    assert.equal(
      schema.some((x) => x.name.startsWith("usage_history_record_")),
      false,
    );
  } finally {
    db.close();
  }
});
