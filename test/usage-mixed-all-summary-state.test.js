import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { buildTimelineRows, sourceGroup } from "../public/timeline-utils.js";
import { createCostEstimateAccumulator } from "../src/pricing.js";
import {
  buildStoredAllSummary,
  ensureUsageAllSummarySchema,
  markStoredHistoryAllSummaryDirty,
  readStoredAllSummary,
  USAGE_HISTORY_ALL_SUMMARY_TABLE_NAMES,
} from "../src/usage-all-summary-store.js";

const BASE = Date.parse("2026-07-01T02:00:00Z");
const DAY = 86400_000;
const START = { ms: Number.MIN_SAFE_INTEGER, id: Number.MIN_SAFE_INTEGER };
const FIELDS = ["total", "input", "cached", "output", "reasoning"];
const pricing = {
  modelName: String,
  costModelName: String,
  estimate(event) {
    return {
      model: event.model,
      currency: event.sourceKind === "zcode" ? "CNY" : "USD",
      priceVersion: "fixture-v1",
      priceSource: "fixture",
      inputUsd: event.amount,
      cachedInputUsd: 0,
      cacheWriteInputUsd: 0,
      outputUsd: 0,
      totalUsd: event.amount,
      pricedTokens: event.total.total,
      unpricedTokens: 0,
      minimumEstimatedTokens: 0,
      minimumRateModels: [],
      unpricedModels: [],
      unpricedReasons: [],
      serviceTierUnknownTokens: 0,
      contextUnknownTokens: 0,
      cacheWriteUnknownTokens: 0,
      pricingStatus: "estimated",
    };
  },
};

function fact(physicalId, timestamp, id, overrides = {}) {
  return {
    physicalId,
    event: {
      id,
      timestamp,
      sessionId: "共享会话🚀",
      homeId: "home-中文",
      sourceKind: "main",
      channel: "CLI",
      model: "模型α",
      amount: 0.1,
      total: { total: 10, input: 7, cached: 1, output: 2, reasoning: 0 },
      ...overrides,
    },
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-mixed-all-"));
  const file = path.join(root, "projection.sqlite");
  const value = { file, database: new DatabaseSync(file) };
  t.after(async () => {
    value.database.close();
    await rm(root, { recursive: true, force: true });
  });
  value.database.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE usage_business_revision(singleton INTEGER PRIMARY KEY,revision INTEGER NOT NULL) STRICT;
    INSERT INTO usage_business_revision VALUES(1,0);
    CREATE TABLE facts(physical_id INTEGER PRIMARY KEY,timestamp_ms INTEGER NOT NULL,tie INTEGER NOT NULL,
      event_json TEXT NOT NULL,UNIQUE(timestamp_ms,tie)) STRICT;`);
  ensureUsageAllSummarySchema(value.database, { mode: "history" });
  return value;
}

function reopen(value) {
  value.database.close();
  value.database = new DatabaseSync(value.file);
}

function change(
  value,
  rows = [],
  removed = [],
  dirty = rows.map(({ event }) => ({ ms: event.timestamp, id: event.id })),
) {
  const db = value.database;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const id of removed) db.prepare("DELETE FROM facts WHERE physical_id=?").run(id);
    for (const { physicalId, event } of rows)
      db.prepare("INSERT OR REPLACE INTO facts VALUES(?,?,?,?)").run(
        physicalId,
        event.timestamp,
        event.id,
        JSON.stringify(event),
      );
    for (const at of dirty) markStoredHistoryAllSummaryDirty(db, at);
    db.exec("UPDATE usage_business_revision SET revision=revision+1; COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function events(value, at = START, limit = 100_000) {
  return value.database
    .prepare("SELECT event_json FROM facts WHERE (timestamp_ms,tie)>(?,?) ORDER BY timestamp_ms,tie LIMIT ?")
    .all(at.ms, at.id, limit)
    .map((row) => JSON.parse(row.event_json));
}

function options(value, extra = {}) {
  return {
    database: value.database,
    mode: "history",
    key: "mixed-fixture-v1",
    range: {
      preset: "all",
      start: new Date(BASE - 2 * DAY),
      end: new Date(BASE + 5 * DAY),
      calendarZone: "utc",
    },
    bucket: "day",
    pricing,
    pricingModels: {},
    sourceKinds: new Map([
      ["home-中文", "main"],
      ["冷家🏠", "zcode"],
    ]),
    eventsAfter: (at, limit) => events(value, at, limit),
    ...extra,
  };
}

function assertOracle(value, input = options(value)) {
  const rows = events(value);
  const result = readStoredAllSummary(input);
  assert.ok(result);
  const cost = createCostEstimateAccumulator({ modelName: pricing.costModelName });
  for (const event of rows) cost.add(event, pricing.estimate(event));
  assert.deepEqual(result.costEstimate, cost.result());
  assert.deepEqual(
    result.timeline,
    buildTimelineRows(rows, input.range, input.bucket, {
      ...input,
      modelName: pricing.modelName,
      estimateCost: pricing.estimate,
    }),
  );
  assert.deepEqual(result.aggregate, {
    event_count: rows.length,
    session_count: new Set(rows.map((x) => x.sessionId)).size,
    home_count: new Set(rows.map((x) => x.homeId)).size,
    ...Object.fromEntries(FIELDS.map((field) => [field, rows.reduce((sum, x) => sum + x.total[field], 0)])),
  });
  for (const [groups, nameOf] of [
    [result.channels, (event) => sourceGroup(event.channel, event.sourceKind)],
    [result.models, (event) => event.model],
  ]) {
    assert.equal(groups.length, new Set(rows.map(nameOf)).size);
    for (const group of groups) {
      const members = rows.filter((event) => nameOf(event) === group.name);
      assert.equal(group.count, members.length);
      assert.equal(group.sessions, new Set(members.map((x) => x.sessionId)).size);
      assert.deepEqual(
        group.total,
        Object.fromEntries(FIELDS.map((field) => [field, members.reduce((sum, x) => sum + x.total[field], 0)])),
      );
    }
  }
  return result;
}

function changes(db) {
  return db.prepare("SELECT total_changes() n").get().n;
}

test("history append and reopen reuse logical ties, Unicode members and exact floating order", async (t) => {
  const value = await fixture(t);
  change(value, [
    fact(30, BASE, 0),
    fact(5, BASE, 1, { amount: 0.2, model: "模型😀" }),
    fact(10, BASE + DAY, 0, { amount: 0.3 }),
  ]);
  assert.deepEqual(
    value.database
      .prepare("SELECT physical_id FROM facts ORDER BY physical_id")
      .all()
      .map((x) => x.physical_id),
    [5, 10, 30],
  );
  assert.equal(buildStoredAllSummary(options(value, { batchSize: 2 })).readEvents, 3);
  assert.equal(assertOracle(value).costEstimate.totalUsd, 0.1 + 0.2 + 0.3);

  change(value, [fact(1, BASE + 2 * DAY, 0, { amount: 0.4, homeId: "冷家🏠", sourceKind: "zcode" })]);
  const reads = [];
  const input = options(value, {
    eventsAfter(at, limit) {
      reads.push(at);
      return events(value, at, limit);
    },
  });
  const work = buildStoredAllSummary(input);
  assert.equal(work.readEvents, 1);
  assert.equal(work.rewinds, 1);
  assert.deepEqual(reads[0], { ms: BASE + DAY, id: 0 });
  const result = assertOracle(value, input);
  assert.equal(result.aggregate.session_count, 1);
  assert.equal(result.aggregate.home_count, 2);

  reopen(value);
  const schema = value.database.prepare("PRAGMA schema_version").get().schema_version;
  ensureUsageAllSummarySchema(value.database, { mode: "history" });
  const reopened = options(value, {
    eventsAfter() {
      throw new Error("ready history reread");
    },
  });
  assert.equal(buildStoredAllSummary(reopened).reused, true);
  assert.deepEqual(readStoredAllSummary(reopened), result);
  assert.equal(changes(value.database), 0);
  assert.equal(value.database.prepare("PRAGMA schema_version").get().schema_version, schema);
  assert.deepEqual(
    value.database
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'usage_%all_%' ORDER BY name")
      .all()
      .map((x) => x.name),
    [...USAGE_HISTORY_ALL_SUMMARY_TABLE_NAMES].sort(),
  );
  assert.equal(value.database.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger'").get().n, 0);
});

test("history checkpoints allow repeated ids and rewind only the timestamp suffix", async (t) => {
  const value = await fixture(t);
  change(
    value,
    Array.from({ length: 2051 }, (_, i) =>
      fact(3000 - i, BASE + i, 0, {
        sessionId: i < 1024 ? "prefix" : "suffix",
        amount: [0.1, 0.2, 0.3][i % 3],
      }),
    ),
  );
  buildStoredAllSummary(options(value));
  assert.equal(
    value.database.prepare("SELECT COUNT(*) n FROM usage_history_all_summary_checkpoints WHERE event_id=0").get().n,
    3,
  );
  change(
    value,
    [fact(5000, BASE + 1500, 1, { sessionId: "迟到🚀", amount: 0.4 })],
    [],
    [
      { ms: BASE + 1800, id: 0 },
      { ms: BASE + 1500, id: 2 },
      { ms: BASE + 1500, id: 1 },
    ],
  );
  const reads = [];
  const input = options(value, {
    eventsAfter(at, limit) {
      reads.push(at);
      return events(value, at, limit);
    },
  });
  assert.equal(buildStoredAllSummary(input).readEvents, 1028);
  assert.deepEqual(reads[0], { ms: BASE + 1023, id: 0 });
  assert.equal(assertOracle(value, input).aggregate.session_count, 3);
  const first = value.database
    .prepare("SELECT first_ms,first_id FROM usage_history_all_summary_members WHERE scope=? AND member=?")
    .get('["all","sessions"]', "suffix");
  assert.deepEqual({ ...first }, { first_ms: BASE + 1024, first_id: 0 });

  // Moving a fact must withdraw its old position even when its tie decreases.
  change(
    value,
    [fact(5000, BASE - 1, 0, { sessionId: "移位", amount: 0.2 })],
    [5000],
    [
      { ms: BASE + 1500, id: 1 },
      { ms: BASE - 1, id: 0 },
    ],
  );
  assert.equal(buildStoredAllSummary(options(value)).readEvents, 2052);
  assertOracle(value);
  change(value, [], [5000], [{ ms: BASE - 1, id: 0 }]);
  assert.equal(buildStoredAllSummary(options(value)).readEvents, 2051);
  assert.equal(assertOracle(value).aggregate.session_count, 2);
});

test("history tie corrections use a strict preceding checkpoint and group reorder starts before the group", async (t) => {
  const value = await fixture(t);
  change(
    value,
    Array.from({ length: 2051 }, (_, i) =>
      fact(i + 1, BASE, i, {
        sessionId: i < 1024 ? "prefix" : "suffix",
      }),
    ),
  );
  buildStoredAllSummary(options(value));
  change(value, [fact(1025, BASE, 1024, { sessionId: "修订", amount: 0.3 })]);
  const reads = [];
  const input = options(value, {
    eventsAfter(at, limit) {
      reads.push(at);
      return events(value, at, limit);
    },
  });
  assert.equal(buildStoredAllSummary(input).readEvents, 1027);
  assert.deepEqual(reads[0], { ms: BASE, id: 1023 });
  assert.equal(assertOracle(value, input).aggregate.session_count, 3);

  change(value, [fact(1024, BASE, 1023, { sessionId: "checkpoint changed" })]);
  reads.length = 0;
  assert.equal(buildStoredAllSummary(input).readEvents, 2051);
  assert.deepEqual(reads[0], START);
  assertOracle(value, input);

  change(value, [fact(1, BASE, 1, { amount: 0.2 }), fact(2, BASE, 0, { amount: 0.3 })], [1, 2], [{ ms: BASE, id: 0 }]);
  reads.length = 0;
  assert.equal(buildStoredAllSummary(input).readEvents, 2051);
  assert.deepEqual(reads[0], START);
  assertOracle(value, input);
});

test("history dirty merges the minimum logical position in the caller transaction without advancing revision", async (t) => {
  const value = await fixture(t);
  const db = value.database;
  const revision = () => db.prepare("SELECT revision FROM usage_business_revision").get().revision;
  db.exec("BEGIN IMMEDIATE");
  for (const at of [
    { ms: BASE + 1, id: 0 },
    { ms: BASE, id: 8 },
    { ms: BASE, id: 3 },
    { ms: BASE + 2, id: -1 },
  ])
    markStoredHistoryAllSummaryDirty(db, at);
  assert.deepEqual(
    { ...db.prepare("SELECT timestamp_ms,event_id FROM usage_history_all_summary_dirty").get() },
    { timestamp_ms: BASE, event_id: 3 },
  );
  assert.equal(revision(), 0);
  db.exec("ROLLBACK");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM usage_history_all_summary_dirty").get().n, 0);
  for (const at of [
    { ms: NaN, id: 0 },
    { ms: BASE, id: 0.5 },
  ])
    assert.throws(() => markStoredHistoryAllSummaryDirty(db, at), /dirty position/);
  change(value, [fact(1, BASE, 0)]);
  buildStoredAllSummary(options(value));
  markStoredHistoryAllSummaryDirty(db, { ms: BASE, id: 0 });
  assert.equal(readStoredAllSummary(options(value)), null);
  assert.equal(buildStoredAllSummary(options(value)).readEvents, 1);
  db.exec("UPDATE usage_business_revision SET revision=revision+1");
  assert.equal(readStoredAllSummary(options(value)), null);
  assert.equal(buildStoredAllSummary(options(value)).readEvents, 1);
  assertOracle(value);
});

test("history resumes a committed afterBatch interruption and converges with a second writer", async (t) => {
  const value = await fixture(t);
  change(value, [fact(9, BASE, 0), fact(3, BASE + DAY, 0), fact(7, BASE + 2 * DAY, 0)]);
  const interrupted = options(value, {
    batchSize: 1,
    afterBatch() {
      throw new Error("interrupted batch");
    },
  });
  assert.throws(() => buildStoredAllSummary(interrupted), /interrupted batch/);
  assert.equal(readStoredAllSummary(interrupted), null);
  reopen(value);
  const writer = new DatabaseSync(value.file);
  try {
    const reads = [];
    let written = false;
    const input = options(value, {
      batchSize: 1,
      eventsAfter(at, limit) {
        reads.push(at);
        return events(value, at, limit);
      },
      afterBatch() {
        if (written) return;
        written = true;
        change({ database: writer }, [fact(1, BASE, 1, { sessionId: "late", amount: 0.2 })]);
        assert.equal(readStoredAllSummary(input), null);
      },
    });
    const work = buildStoredAllSummary(input);
    assert.deepEqual(reads[0], { ms: BASE, id: 0 });
    assert.equal(work.readEvents, 5);
    assert.equal(work.rewinds, 1);
    assertOracle(value, input);
  } finally {
    writer.close();
  }
});

test("history rejects invalid input order atomically and restarts after a pricing failure", async (t) => {
  const value = await fixture(t);
  change(value, [fact(3, BASE, 0), fact(1, BASE, 1), fact(2, BASE + DAY, 0)]);
  const rows = events(value);
  for (const invalid of [
    [rows[1], rows[0]],
    [rows[0], rows[0]],
    [rows[2], rows[1]],
  ]) {
    assert.throws(() => buildStoredAllSummary(options(value, { eventsAfter: () => invalid })), /input order/);
    assert.equal(readStoredAllSummary(options(value)), null);
  }
  const input = options(value, {
    batchSize: 1,
    pricing: {
      ...pricing,
      estimate(event) {
        if (event.id === 1) throw new Error("pricing failure");
        return pricing.estimate(event);
      },
    },
  });
  assert.throws(() => buildStoredAllSummary(input), /pricing failure/);
  reopen(value);
  assert.equal(buildStoredAllSummary(options(value)).readEvents, 2);
  assertOracle(value);
});

test("history damaged checkpoints self-heal without changing the fact revision", async (t) => {
  for (const damage of [
    "DELETE FROM usage_history_all_summary_checkpoints",
    "UPDATE usage_history_all_summary_checkpoints SET state_json='{broken'",
    "UPDATE usage_history_all_summary_checkpoints SET state_json='{}'",
    "UPDATE usage_history_all_summary_checkpoints SET state_json=json_remove(state_json,'$.cost')",
    "UPDATE usage_history_all_summary_checkpoints SET state_json=json_remove(state_json,'$.timeline')",
  ]) {
    await t.test(damage, async (child) => {
      const value = await fixture(child);
      change(value, [fact(2, BASE, 0), fact(1, BASE, 1)]);
      buildStoredAllSummary(options(value));
      value.database.exec(damage);
      assert.equal(readStoredAllSummary(options(value)), null);
      reopen(value);
      assert.equal(buildStoredAllSummary(options(value)).rebuilt, true);
      assert.equal(value.database.prepare("SELECT revision FROM usage_business_revision").get().revision, 1);
      assertOracle(value);
    });
  }
});

test("FORMAT=3 hot cache retains its schema and ready reuse performs no writes", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,timestamp_ms INTEGER NOT NULL);
      CREATE TABLE source_files(path TEXT PRIMARY KEY,kind TEXT,home_id TEXT,home_label TEXT,home_path TEXT);
      CREATE TABLE usage_business_revision(singleton INTEGER PRIMARY KEY,revision INTEGER NOT NULL);
      INSERT INTO usage_business_revision VALUES(1,0);`);
    ensureUsageAllSummarySchema(db);
    const rows = [fact(1, BASE + DAY, 1).event, fact(2, BASE, 2).event];
    const input = {
      ...options({ database: db }),
      mode: "hot",
      eventsAfter: (at) => rows.filter((event) => event.id > at.id),
    };
    delete input.mode;
    buildStoredAllSummary(input);
    const result = readStoredAllSummary(input);
    const snapshot = () => db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
    const schema = snapshot();
    const writes = changes(db);
    ensureUsageAllSummarySchema(db);
    const reused = {
      ...input,
      eventsAfter() {
        throw new Error("ready hot reread");
      },
    };
    assert.equal(buildStoredAllSummary(reused).reused, true);
    assert.deepEqual(readStoredAllSummary(reused), result);
    assert.deepEqual(snapshot(), schema);
    assert.equal(changes(db), writes);
    assert.equal(db.prepare("SELECT version FROM usage_all_summary_format").get().version, 3);
    assert.deepEqual(
      db
        .prepare("PRAGMA table_info(usage_all_summary_checkpoints)")
        .all()
        .filter((x) => x.pk)
        .map((x) => x.name),
      ["event_id"],
    );
    assert.equal(schema.filter((x) => x.type === "trigger").length, 7);
    assert.equal(
      schema.some((x) => x.name.startsWith("usage_history_all_")),
      false,
    );
  } finally {
    db.close();
  }
});
