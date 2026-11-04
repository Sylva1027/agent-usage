import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { buildTimelineRows } from "../public/timeline-utils.js";
import { createCostEstimateAccumulator } from "../src/pricing.js";
import {
  buildStoredAllSummary,
  ensureUsageAllSummarySchema,
  readStoredAllSummary,
} from "../src/usage-all-summary-store.js";
import { UsageStore } from "../src/usage-store.js";

const SOURCES = [
  {
    path: "/fixture/main",
    kind: "main",
    homeId: "home-main",
    homeLabel: "Main",
    homePath: "/fixture/home-main",
  },
  {
    path: "/fixture/zcode",
    kind: "zcode",
    homeId: "home-zcode",
    homeLabel: "ZCode",
    homePath: "/fixture/home-zcode",
  },
];

const SOURCE_BY_KIND = new Map(SOURCES.map((source) => [source.kind, source]));
const SOURCE_KINDS = new Map(SOURCES.map((source) => [source.homeId, source.kind]));
const RANGE = {
  preset: "all",
  start: new Date("2026-07-01T00:00:00.000Z"),
  end: new Date("2026-07-06T23:59:59.999Z"),
  calendarZone: "utc",
};

function openDatabase(file) {
  const database = new DatabaseSync(file);
  database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
  ensureUsageAllSummarySchema(database);
  return database;
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-all-summary-state-"));
  if (!root) throw new Error("Failed to create test directory");
  const file = path.join(root, "usage.sqlite");
  const store = new UsageStore({
    homeDir: root,
    databaseFile: file,
    importDirs: [],
    automaticDiscoveryEnabled: false,
  });
  await store.open();
  for (const source of SOURCES) {
    store.database
      .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(source.path, source.kind, source.homeId, source.homeLabel, source.homePath, 1, 1, "fixture");
  }
  store.close();
  return {
    root,
    file,
    database: openDatabase(file),
    sourceKinds: SOURCE_KINDS,
  };
}

async function closeFixture(fixture) {
  try {
    fixture.database?.close();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

function reopen(fixture) {
  fixture.database.close();
  fixture.database = openDatabase(fixture.file);
  return fixture.database;
}

function insertEvent(
  database,
  {
    id,
    timestamp = "2026-07-02T02:00:00.000Z",
    source = "main",
    session = "session",
    channel,
    model = "gpt-6-sol",
    total = 10,
  },
) {
  const sourceRow = SOURCE_BY_KIND.get(source);
  if (!sourceRow) throw new Error(`Unknown fixture source: ${source}`);
  const timestampMs = Date.parse(timestamp);
  const day = timestamp.slice(0, 10);
  const values = {
    source_path: sourceRow.path,
    timestamp_ms: timestampMs,
    session_id: session,
    home_id: sourceRow.homeId,
    home_label: sourceRow.homeLabel,
    channel: channel || (source === "zcode" ? "ZCode" : "CLI"),
    project: "/fixture/project",
    model,
    hour_key: `${day} ${timestamp.slice(11, 16)}`,
    day_key: day,
    week_key: day,
    month_key: day.slice(0, 7),
    cwd: "/fixture/project",
    detail_mask: 15,
    cache_write_tokens: 0,
    cache_write_known: 1,
    request_input_tokens: total - 1,
    context_level: "short",
    service_tier: "standard",
    price_version: "fixture-v1",
    total,
    input: total - 1,
    cached: 0,
    output: 1,
    reasoning: 0,
  };
  if (id !== undefined) values.id = id;
  const columns = Object.keys(values);
  const result = database
    .prepare(`INSERT OR REPLACE INTO events (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
    .run(...Object.values(values));
  return { id: Number(id ?? result.lastInsertRowid), timestamp: timestampMs };
}

function insertEventBlock(database, { startId, count }) {
  const source = SOURCE_BY_KIND.get("main");
  const columns = [
    "id",
    "source_path",
    "timestamp_ms",
    "session_id",
    "home_id",
    "home_label",
    "channel",
    "project",
    "model",
    "hour_key",
    "day_key",
    "week_key",
    "month_key",
    "cwd",
    "detail_mask",
    "cache_write_tokens",
    "cache_write_known",
    "request_input_tokens",
    "context_level",
    "service_tier",
    "price_version",
    "total",
    "input",
    "cached",
    "output",
    "reasoning",
  ];
  const rowsPerStatement = 512;
  const valuesSql = `(${columns.map(() => "?").join(",")})`;
  const fullSql = `INSERT INTO events(${columns.join(",")}) VALUES ${Array.from(
    { length: rowsPerStatement },
    () => valuesSql,
  ).join(",")}`;
  const fullStatement = database.prepare(fullSql);
  database.exec("BEGIN IMMEDIATE");
  try {
    for (let offset = 0; offset < count; offset += rowsPerStatement) {
      const rows = Math.min(rowsPerStatement, count - offset);
      const statement =
        rows === rowsPerStatement
          ? fullStatement
          : database.prepare(
              `INSERT INTO events(${columns.join(",")}) VALUES ${Array.from({ length: rows }, () => valuesSql).join(",")}`,
            );
      const params = [];
      for (let index = 0; index < rows; index += 1) {
        const id = startId + offset + index;
        params.push(
          id,
          source.path,
          Date.parse("2026-07-02T02:00:00.000Z") + id,
          "bulk-shared",
          source.homeId,
          source.homeLabel,
          "CLI",
          "/fixture/project",
          "gpt-6-sol",
          "2026-07-02 02",
          "2026-07-02",
          "2026-06-29",
          "2026-07",
          "/fixture/project",
          15,
          0,
          1,
          9,
          "short",
          "standard",
          "fixture-v1",
          10,
          9,
          0,
          1,
          0,
        );
      }
      statement.run(...params);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function decodeEvent(row) {
  return {
    id: Number(row.id),
    timestamp: Number(row.timestamp_ms),
    sessionId: String(row.session_id),
    homeId: String(row.home_id),
    homeLabel: String(row.home_label),
    sourceKind: String(row.source_kind),
    channel: String(row.channel),
    project: String(row.project),
    model: String(row.model),
    cwd: String(row.cwd),
    repositoryKey: String(row.repository_key),
    repositoryPath: String(row.repository_path),
    repositoryKind: String(row.repository_kind),
    detailMask: Number(row.detail_mask),
    reconciliationGap: Number(row.reconciliation_gap),
    cacheWriteTokens: Number(row.cache_write_tokens),
    cacheWriteKnown: Boolean(row.cache_write_known),
    requestInputTokens: Number(row.request_input_tokens),
    contextLevel: String(row.context_level),
    serviceTier: String(row.service_tier),
    priceVersion: String(row.price_version),
    total: {
      total: Number(row.total),
      input: Number(row.input),
      cached: Number(row.cached),
      output: Number(row.output),
      reasoning: Number(row.reasoning),
    },
  };
}

function queryEvents(database, position = null, limit = 10_000) {
  const rows = position
    ? database
        .prepare(
          `SELECT e.*, sf.kind AS source_kind
           FROM events e JOIN source_files sf ON sf.path=e.source_path
           WHERE e.id>?
           ORDER BY e.id LIMIT ?`,
        )
        .all(position.id, limit)
    : database
        .prepare(
          `SELECT e.*, sf.kind AS source_kind
           FROM events e JOIN source_files sf ON sf.path=e.source_path
           ORDER BY e.id`,
        )
        .all();
  return rows.map(decodeEvent);
}

function fixturePricing(amount = (event) => event.total.total / 100) {
  return {
    modelName: (value) => String(value),
    costModelName: (value) => String(value),
    estimate(event) {
      const totalUsd = amount(event);
      return {
        model: event.model,
        currency: event.sourceKind === "zcode" ? "CNY" : "USD",
        priceVersion: "fixture-v1",
        priceSource: "fixture",
        inputUsd: totalUsd,
        cachedInputUsd: 0,
        cacheWriteInputUsd: 0,
        outputUsd: 0,
        totalUsd,
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
}

function makeOptions(fixture, { pricing = fixturePricing(), batchSize = 1024, eventsAfter } = {}) {
  return {
    database: fixture.database,
    key: "q1-v-all-summary",
    range: {
      preset: "all",
      start: new Date(RANGE.start),
      end: new Date(RANGE.end),
      calendarZone: "utc",
    },
    bucket: "day",
    requestedBucket: "day",
    pricing,
    sourceKinds: fixture.sourceKinds,
    pricingModels: {},
    batchSize,
    eventsAfter: eventsAfter || ((position, limit) => queryEvents(fixture.database, position, limit)),
  };
}

function oracle(fixture, options) {
  const events = queryEvents(fixture.database);
  const cost = createCostEstimateAccumulator({ modelName: options.pricing.costModelName });
  for (const event of events) cost.add(event, options.pricing.estimate(event));
  const timeline = buildTimelineRows(events, options.range, options.bucket, {
    sourceKinds: options.sourceKinds,
    pricingModels: options.pricingModels,
    modelName: options.pricing.modelName,
    estimateCost: options.pricing.estimate,
  });
  return { events, cost: cost.result(), timeline };
}

function assertMatchesOracle(fixture, options, result) {
  const expected = oracle(fixture, options);
  assert.deepEqual(result.costEstimate, expected.cost);
  assert.deepEqual(result.timeline, expected.timeline);
  assert.equal(result.timelineError, null);
  assert.equal(result.aggregate.event_count, expected.events.length);
  assert.equal(
    result.aggregate.total,
    expected.events.reduce((sum, event) => sum + event.total.total, 0),
  );
  return expected;
}

test("ready all-summary survives close and reopen without reading events", async () => {
  const fixture = await createFixture();
  try {
    insertEvent(fixture.database, { timestamp: "2026-07-01T02:00:00.000Z", session: "one", total: 11 });
    insertEvent(fixture.database, {
      timestamp: "2026-07-03T02:00:00.000Z",
      source: "zcode",
      session: "two",
      total: 13,
    });
    const initialReads = [];
    const options = makeOptions(fixture, {
      eventsAfter(position, limit) {
        const events = queryEvents(fixture.database, position, limit);
        initialReads.push(events.length);
        return events;
      },
    });
    const work = buildStoredAllSummary(options);
    assert.equal(work.rebuilt, true);
    assert.equal(work.readEvents, 2);
    const initial = readStoredAllSummary(options);
    const expected = assertMatchesOracle(fixture, options, initial);
    assert.deepEqual(initial.channels.map((row) => row.name).sort(), ["Codex", "ZCode"]);
    assert.equal(expected.events.length, 2);

    reopen(fixture);
    let reopenedReads = 0;
    const reopenedOptions = makeOptions(fixture, {
      eventsAfter() {
        reopenedReads += 1;
        throw new Error("ready state must not reread events");
      },
    });
    const reused = buildStoredAllSummary(reopenedOptions);
    assert.equal(reused.reused, true);
    assert.equal(reused.readEvents, 0);
    assert.equal(reopenedReads, 0);
    assert.deepEqual(readStoredAllSummary(reopenedOptions), initial);
  } finally {
    await closeFixture(fixture);
  }
});

test("monotonic append rewinds only the new event tail", async () => {
  const fixture = await createFixture();
  try {
    const first = insertEvent(fixture.database, {
      timestamp: "2026-07-01T02:00:00.000Z",
      session: "one",
      total: 7,
    });
    const second = insertEvent(fixture.database, {
      timestamp: "2026-07-02T02:00:00.000Z",
      session: "two",
      total: 11,
    });
    const options = makeOptions(fixture);
    buildStoredAllSummary(options);

    insertEvent(fixture.database, {
      timestamp: "2026-07-03T02:00:00.000Z",
      session: "three",
      total: 13,
    });
    const reads = [];
    const appendOptions = makeOptions(fixture, {
      eventsAfter(position, limit) {
        const events = queryEvents(fixture.database, position, limit);
        reads.push({ position, ids: events.map((event) => event.id) });
        return events;
      },
    });
    const work = buildStoredAllSummary(appendOptions);
    assert.equal(work.rewinds, 1);
    assert.equal(work.readEvents, 1);
    assert.equal(reads[0].position.id, second.id);
    assert.notEqual(reads[0].position.id, first.id);
    const result = readStoredAllSummary(appendOptions);
    assertMatchesOracle(fixture, appendOptions, result);
    assert.equal(result.aggregate.event_count, 3);
  } finally {
    await closeFixture(fixture);
  }
});

test("a late timestamp with a new id reads one tail event", async () => {
  const fixture = await createFixture();
  try {
    insertEvent(fixture.database, {
      timestamp: "2026-07-03T02:00:00.000Z",
      session: "shared",
      total: 10,
    });
    insertEvent(fixture.database, {
      timestamp: "2026-07-04T02:00:00.000Z",
      session: "shared",
      total: 20,
    });
    buildStoredAllSummary(makeOptions(fixture));

    insertEvent(fixture.database, {
      timestamp: "2026-07-02T02:00:00.000Z",
      session: "shared",
      total: 30,
    });
    const reads = [];
    const options = makeOptions(fixture, {
      eventsAfter(position, limit) {
        const events = queryEvents(fixture.database, position, limit);
        reads.push(events.length);
        return events;
      },
    });
    const work = buildStoredAllSummary(options);
    assert.equal(work.readEvents, 1);
    assert.ok(reads.includes(1));
    const result = readStoredAllSummary(options);
    assertMatchesOracle(fixture, options, result);
    assert.equal(result.aggregate.session_count, 1);
    assert.deepEqual(
      result.timeline.filter((row) => row.count > 0).map((row) => [row.key, row.sessions]),
      [
        ["2026-07-02", 1],
        ["2026-07-03", 1],
        ["2026-07-04", 1],
      ],
    );
    const timelineSessions = fixture.database
      .prepare("SELECT scope, COUNT(*) AS count FROM usage_all_summary_members GROUP BY scope")
      .all()
      .filter((row) => JSON.parse(row.scope)[0] === "timeline" && JSON.parse(row.scope).at(-1) === "sessions");
    assert.ok(timelineSessions.length >= 3);
    assert.ok(timelineSessions.every((row) => row.count === 1));
  } finally {
    await closeFixture(fixture);
  }
});

test("update, delete, and REPLACE withdraw old timestamp positions", async () => {
  const fixture = await createFixture();
  try {
    insertEvent(fixture.database, {
      id: 1,
      timestamp: "2026-07-02T02:00:00.000Z",
      session: "first",
      total: 10,
    });
    insertEvent(fixture.database, {
      id: 2,
      timestamp: "2026-07-03T02:00:00.000Z",
      session: "second",
      total: 20,
    });
    buildStoredAllSummary(makeOptions(fixture));

    fixture.database
      .prepare("UPDATE events SET timestamp_ms=?, total=?, input=? WHERE id=1")
      .run(Date.parse("2026-07-04T02:00:00.000Z"), 11, 10);
    let options = makeOptions(fixture);
    buildStoredAllSummary(options);
    let result = readStoredAllSummary(options);
    assertMatchesOracle(fixture, options, result);
    assert.deepEqual(
      result.timeline.filter((row) => row.total.total > 0).map((row) => [row.key, row.total.total]),
      [
        ["2026-07-03", 20],
        ["2026-07-04", 11],
      ],
    );

    fixture.database.prepare("DELETE FROM events WHERE id=1").run();
    options = makeOptions(fixture);
    buildStoredAllSummary(options);
    result = readStoredAllSummary(options);
    assertMatchesOracle(fixture, options, result);
    assert.equal(result.aggregate.event_count, 1);
    assert.equal(result.aggregate.total, 20);

    insertEvent(fixture.database, {
      id: 2,
      timestamp: "2026-07-01T02:00:00.000Z",
      session: "second",
      total: 5,
    });
    options = makeOptions(fixture);
    buildStoredAllSummary(options);
    result = readStoredAllSummary(options);
    assertMatchesOracle(fixture, options, result);
    assert.deepEqual(
      result.timeline.filter((row) => row.total.total > 0).map((row) => [row.key, row.total.total]),
      [["2026-07-01", 5]],
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("a batch callback failure leaves an unready checkpoint that resumes", async () => {
  const fixture = await createFixture();
  try {
    for (let day = 1; day <= 3; day += 1) {
      insertEvent(fixture.database, {
        timestamp: `2026-07-0${day}T02:00:00.000Z`,
        session: `session-${day}`,
        total: day * 10,
      });
    }
    const interrupted = makeOptions(fixture, {
      batchSize: 1,
      afterBatch: undefined,
    });
    interrupted.afterBatch = () => {
      throw new Error("fixture batch interruption");
    };
    assert.throws(() => buildStoredAllSummary(interrupted), /fixture batch interruption/);
    assert.equal(readStoredAllSummary(interrupted), null);
    assert.equal(
      fixture.database.prepare("SELECT status FROM usage_all_summary_state WHERE singleton=1").get().status,
      "building",
    );

    const resumedReads = [];
    const resumed = makeOptions(fixture, {
      batchSize: 1,
      eventsAfter(position, limit) {
        const events = queryEvents(fixture.database, position, limit);
        resumedReads.push(events.length);
        return events;
      },
    });
    const work = buildStoredAllSummary(resumed);
    assert.equal(work.reused, false);
    assert.equal(
      resumedReads.reduce((sum, count) => sum + count, 0),
      2,
    );
    const result = readStoredAllSummary(resumed);
    assertMatchesOracle(fixture, resumed, result);
    assert.equal(result.aggregate.event_count, 3);
  } finally {
    await closeFixture(fixture);
  }
});

test("checkpoint restore keeps strict floating order and stores no event history", async () => {
  const fixture = await createFixture();
  try {
    const amounts = [0.1, 0.2, 0.3, 0.4];
    for (let index = 0; index < amounts.length; index += 1) {
      insertEvent(fixture.database, {
        timestamp: `2026-07-0${index + 1}T02:00:00.000Z`,
        session: `float-${index}`,
        total: 100 + index,
      });
    }
    const pricing = fixturePricing((event) => amounts[event.id - 1]);
    const options = makeOptions(fixture, { pricing, batchSize: 1 });
    buildStoredAllSummary(options);
    const result = readStoredAllSummary(options);
    const expected = assertMatchesOracle(fixture, options, result);
    assert.equal(result.costEstimate.totalUsd, 0.1 + 0.2 + 0.3 + 0.4);
    assert.ok(Object.is(result.costEstimate.totalUsd, expected.cost.totalUsd));

    const checkpoint = fixture.database
      .prepare("SELECT state_json FROM usage_all_summary_checkpoints ORDER BY event_id DESC LIMIT 1")
      .get();
    const state = JSON.parse(checkpoint.state_json);
    assert.equal(Object.hasOwn(state, "events"), false);
    assert.equal(Object.hasOwn(state, "history"), false);
    assert.equal(checkpoint.state_json.includes('"sessionId"'), false);
  } finally {
    await closeFixture(fixture);
  }
});

test("damaged checkpoints are unreadable and self-heal without a fact revision", async () => {
  const variants = [
    {
      name: "deleted checkpoint",
      damage(database) {
        database.prepare("DELETE FROM usage_all_summary_checkpoints").run();
      },
    },
    {
      name: "invalid JSON",
      damage(database) {
        database.prepare("UPDATE usage_all_summary_checkpoints SET state_json='{broken'").run();
      },
    },
    {
      name: "missing aggregate",
      damage(_database, mutateState) {
        mutateState((state) => delete state.aggregate);
      },
    },
    {
      name: "missing cost",
      damage(_database, mutateState) {
        mutateState((state) => delete state.cost);
      },
    },
    {
      name: "missing timeline",
      damage(_database, mutateState) {
        mutateState((state) => delete state.timeline);
      },
    },
    {
      name: "invalid group",
      damage(_database, mutateState) {
        mutateState((state) => {
          state.channels = [null];
        });
      },
    },
  ];
  for (const variant of variants) {
    const fixture = await createFixture();
    try {
      insertEvent(fixture.database, {
        timestamp: "2026-07-01T02:00:00.000Z",
        session: "one",
        total: 10,
      });
      insertEvent(fixture.database, {
        timestamp: "2026-07-02T02:00:00.000Z",
        session: "two",
        total: 20,
      });
      const options = makeOptions(fixture);
      buildStoredAllSummary(options);
      const mutateState = (change) => {
        const row = fixture.database.prepare("SELECT state_json FROM usage_all_summary_checkpoints").get();
        const state = JSON.parse(row.state_json);
        change(state);
        fixture.database.prepare("UPDATE usage_all_summary_checkpoints SET state_json=?").run(JSON.stringify(state));
      };
      const revisionBefore = Number(
        fixture.database.prepare("SELECT revision FROM usage_business_revision WHERE singleton=1").get().revision,
      );
      variant.damage(fixture.database, mutateState);
      const revisionAfter = Number(
        fixture.database.prepare("SELECT revision FROM usage_business_revision WHERE singleton=1").get().revision,
      );
      assert.equal(revisionAfter, revisionBefore, `${variant.name}: fact revision must stay unchanged`);
      assert.equal(readStoredAllSummary(options), null, `${variant.name}: damaged cache must reject reads`);

      const work = buildStoredAllSummary(options);
      assert.equal(work.rebuilt, true, `${variant.name}: unchanged facts must self-heal the cache`);
      const repaired = readStoredAllSummary(options);
      assertMatchesOracle(fixture, options, repaired);
      assert.equal(repaired.aggregate.event_count, 2);
      const checkpoint = fixture.database
        .prepare("SELECT state_json FROM usage_all_summary_checkpoints ORDER BY event_id DESC LIMIT 1")
        .get();
      assert.doesNotThrow(() => JSON.parse(checkpoint.state_json), variant.name);
    } finally {
      await closeFixture(fixture);
    }
  }
});

test("afterBatch writes from a second WAL connection converge with the oracle", async () => {
  const fixture = await createFixture();
  let writer = null;
  try {
    insertEvent(fixture.database, {
      id: 1,
      timestamp: "2026-07-02T02:00:00.000Z",
      session: "one",
      total: 10,
    });
    insertEvent(fixture.database, {
      id: 2,
      timestamp: "2026-07-03T02:00:00.000Z",
      session: "two",
      total: 20,
    });
    insertEvent(fixture.database, {
      id: 3,
      timestamp: "2026-07-04T02:00:00.000Z",
      session: "three",
      total: 30,
    });
    insertEvent(fixture.database, {
      id: 4,
      timestamp: "2026-07-05T02:00:00.000Z",
      session: "four",
      total: 40,
    });
    writer = new DatabaseSync(fixture.file);
    writer.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
    assert.equal(String(writer.prepare("PRAGMA journal_mode").get().journal_mode), "wal");

    let changed = false;
    const options = makeOptions(fixture, { batchSize: 2 });
    options.afterBatch = ({ batches }) => {
      if (batches !== 1 || changed) return;
      changed = true;
      writer.exec("BEGIN IMMEDIATE");
      try {
        insertEvent(writer, {
          timestamp: "2026-07-01T02:00:00.000Z",
          session: "late",
          total: 5,
        });
        writer.exec("COMMIT");
      } catch (error) {
        writer.exec("ROLLBACK");
        throw error;
      }
      writer.exec("BEGIN IMMEDIATE");
      try {
        writer.prepare("UPDATE events SET total=?,input=? WHERE id=3").run(31, 30);
        writer.exec("COMMIT");
      } catch (error) {
        writer.exec("ROLLBACK");
        throw error;
      }
      writer.exec("BEGIN IMMEDIATE");
      try {
        insertEvent(writer, {
          timestamp: "2026-07-06T02:00:00.000Z",
          session: "tail",
          total: 50,
        });
        writer.exec("COMMIT");
      } catch (error) {
        writer.exec("ROLLBACK");
        throw error;
      }
    };

    const work = buildStoredAllSummary(options);
    assert.equal(changed, true);
    assert.ok(work.rewinds >= 1);
    const result = readStoredAllSummary(options);
    assertMatchesOracle(fixture, options, result);
    assert.equal(result.aggregate.event_count, 6);
    assert.deepEqual(
      result.timeline.filter((row) => row.total.total > 0).map((row) => [row.key, row.total.total]),
      [
        ["2026-07-01", 5],
        ["2026-07-02", 10],
        ["2026-07-03", 20],
        ["2026-07-04", 31],
        ["2026-07-05", 40],
        ["2026-07-06", 50],
      ],
    );
  } finally {
    writer?.close();
    await closeFixture(fixture);
  }
});

test("checkpoint retention keeps 32 blocks and replays early revisions from START", { timeout: 60_000 }, async () => {
  const fixture = await createFixture();
  try {
    const checkpointInterval = 1024;
    const checkpointLimit = 32;
    const initialEvents = 34 * checkpointInterval + 300;
    insertEventBlock(fixture.database, { startId: 1, count: initialEvents });

    let options = makeOptions(fixture);
    let work = buildStoredAllSummary(options);
    assert.equal(work.readEvents, initialEvents);
    const checkpointBlocks = () =>
      fixture.database
        .prepare("SELECT block FROM usage_all_summary_checkpoints ORDER BY block")
        .all()
        .map((row) => Number(row.block));
    const retainedBlocks = [-1, ...Array.from({ length: checkpointLimit }, (_, index) => index + 3)];
    assert.deepEqual(checkpointBlocks(), retainedBlocks);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM events").get().count, initialEvents);

    let eventCount = initialEvents;
    for (let batch = 0; batch < 3; batch += 1) {
      insertEventBlock(fixture.database, { startId: eventCount + 1, count: 20 });
      eventCount += 20;
      options = makeOptions(fixture);
      work = buildStoredAllSummary(options);
      assert.equal(work.readEvents, 20);
      assert.deepEqual(checkpointBlocks(), retainedBlocks);
      assert.equal(
        fixture.database.prepare("SELECT COUNT(*) AS count FROM usage_all_summary_checkpoints WHERE block=34").get()
          .count,
        1,
      );
    }

    fixture.database
      .prepare("UPDATE events SET session_id=?,total=?,input=? WHERE id=10")
      .run("early-revision", 77, 76);
    const reads = [];
    options = makeOptions(fixture, {
      eventsAfter(position, limit) {
        const events = queryEvents(fixture.database, position, limit);
        reads.push({ position, count: events.length });
        return events;
      },
    });
    work = buildStoredAllSummary(options);
    assert.deepEqual(reads[0].position, { ms: Number.MIN_SAFE_INTEGER, id: Number.MIN_SAFE_INTEGER });
    assert.equal(work.readEvents, eventCount);
    assert.deepEqual(checkpointBlocks(), retainedBlocks);
    assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM events").get().count, eventCount);
    const result = readStoredAllSummary(options);
    assertMatchesOracle(fixture, options, result);
    assert.equal(result.aggregate.event_count, eventCount);
    assert.equal(result.aggregate.session_count, 2);
    assert.equal(
      Number(
        fixture.database
          .prepare("SELECT first_id FROM usage_all_summary_members WHERE scope=? AND member=?")
          .get('["all","sessions"]', "early-revision").first_id,
      ),
      10,
    );
  } finally {
    await closeFixture(fixture);
  }
});
