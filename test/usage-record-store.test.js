import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  USAGE_RECORD_TABLE_NAMES,
  buildStoredRecordChampions,
  ensureUsageRecordSchema,
  readStoredRecordChampions,
} from "../src/usage-record-store.js";

function createEventsTable(database) {
  database.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      source_path TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      home_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      model TEXT NOT NULL,
      day_key TEXT NOT NULL,
      week_key TEXT NOT NULL,
      month_key TEXT NOT NULL,
      detail_mask INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_known INTEGER NOT NULL DEFAULT 0,
      request_input_tokens INTEGER NOT NULL DEFAULT 0,
      context_level TEXT NOT NULL DEFAULT "unknown",
      service_tier TEXT NOT NULL DEFAULT "unknown",
      total REAL NOT NULL,
      input REAL NOT NULL,
      cached REAL NOT NULL,
      output REAL NOT NULL,
      reasoning REAL NOT NULL
    ) STRICT;
  `);
}

async function withDatabase(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "usage-record-store-"));
  const databaseFile = path.join(directory, "usage.sqlite");
  const database = new DatabaseSync(databaseFile);
  try {
    createEventsTable(database);
    ensureUsageRecordSchema(database);
    await run({ database, databaseFile, directory });
  } finally {
    if (database.isTransaction) database.exec("ROLLBACK");
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function event({
  id,
  timestamp = "2026-07-10T01:00:00.000Z",
  sourcePath = "/sessions/a.jsonl",
  sessionId = `session-${id}`,
  homeId = "home",
  model = "gpt-6-sol",
  total,
  input = total - 10,
  cached = 5,
  output = 10,
  reasoning = 0,
  day,
  week,
  month,
}) {
  const date = new Date(timestamp);
  return {
    id,
    source_path: sourcePath,
    timestamp_ms: date.getTime(),
    session_id: sessionId,
    home_id: homeId,
    channel: "CLI",
    model,
    day_key: day ?? date.toISOString().slice(0, 10),
    week_key: week ?? "2026-07-06",
    month_key: month ?? date.toISOString().slice(0, 7),
    total,
    input,
    cached,
    output,
    reasoning,
  };
}

function insertEvent(database, row) {
  database
    .prepare(
      `INSERT INTO events (
        id, source_path, timestamp_ms, session_id, home_id, channel, model, day_key, week_key,
        month_key, total, input, cached, output, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.source_path,
      row.timestamp_ms,
      row.session_id,
      row.home_id,
      row.channel,
      row.model,
      row.day_key,
      row.week_key,
      row.month_key,
      row.total,
      row.input,
      row.cached,
      row.output,
      row.reasoning,
    );
}

function watchEventCursors(database) {
  const originalPrepare = database.prepare.bind(database);
  const stats = { prepares: 0, iterations: 0, returns: 0, rowsRead: 0, ids: [], sql: [] };
  database.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (String(sql).includes("ORDER BY id ASC") && String(sql).includes("id > ?")) {
      stats.prepares += 1;
      stats.sql.push(String(sql));
      const originalIterate = statement.iterate.bind(statement);
      statement.iterate = (...args) => {
        stats.iterations += 1;
        const iterator = originalIterate(...args);
        const originalNext = iterator.next.bind(iterator);
        iterator.next = () => {
          const next = originalNext();
          if (!next.done) {
            stats.rowsRead += 1;
            stats.ids.push(Number(next.value.id));
          }
          return next;
        };
        const originalReturn = iterator.return.bind(iterator);
        iterator.return = () => {
          stats.returns += 1;
          return originalReturn();
        };
        return iterator;
      };
    }
    return statement;
  };
  return {
    stats,
    restore() {
      database.prepare = originalPrepare;
    },
  };
}

function projectionSnapshot(database) {
  return {
    periods: database
      .prepare(
        `SELECT unit, period_key, total_tokens, input_tokens, cached_tokens, output_tokens,
           reasoning_tokens, total_cost, input_cost, cached_cost, output_cost,
           session_count, model_count, minimum_ms, maximum_ms
         FROM usage_record_cache_periods ORDER BY unit, period_key`,
      )
      .all()
      .map((row) => Object.fromEntries(Object.entries(row))),
    members: database
      .prepare(
        `SELECT unit, period_key, kind, member
         FROM usage_record_cache_members ORDER BY unit, period_key, kind, member`,
      )
      .all()
      .map((row) => Object.fromEntries(Object.entries(row))),
  };
}

function estimateRow(row) {
  return {
    currency: String(row.home_id) === "cny-home" ? "CNY" : "USD",
    totalUsd: Number(row.total) / 1000,
    inputUsd: Number(row.input) / 1000,
    cachedInputUsd: Number(row.cached) / 1000,
    outputUsd: Number(row.output) / 1000,
  };
}

function originalChampions(rows, zone, rate, estimate) {
  const periods = { day: new Map(), week: new Map(), month: new Map() };
  for (const row of [...rows].sort((left, right) => left.id - right.id)) {
    const date = new Date(row.timestamp_ms);
    const utcDay = date.toISOString().slice(0, 10);
    const utcWeek = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((date.getUTCDay() || 7) - 1)),
    )
      .toISOString()
      .slice(0, 10);
    const keys =
      zone === "utc"
        ? { day: utcDay, week: utcWeek, month: utcDay.slice(0, 7) }
        : { day: row.day_key, week: row.week_key, month: row.month_key };
    const priced = estimate(row);
    const scale = priced.currency === "CNY" ? 1 : rate;
    for (const unit of ["day", "week", "month"]) {
      const period = keys[unit];
      const slot = periods[unit].get(period) || {
        period,
        total: 0,
        input: 0,
        cached: 0,
        output: 0,
        reasoning: 0,
        sessions: new Set(),
        models: new Set(),
        cost: { total: 0, input: 0, cached: 0, output: 0 },
      };
      slot.total += row.total;
      slot.input += row.input;
      slot.cached += row.cached;
      slot.output += row.output;
      slot.reasoning += row.reasoning;
      slot.sessions.add(JSON.stringify([row.home_id, row.session_id]));
      slot.models.add(row.model);
      slot.cost.total += priced.totalUsd * scale;
      slot.cost.input += priced.inputUsd * scale;
      slot.cost.cached += priced.cachedInputUsd * scale;
      slot.cost.output += priced.outputUsd * scale;
      periods[unit].set(period, slot);
    }
  }
  const result = { day: {}, week: {}, month: {} };
  for (const metric of [
    "totalTokens",
    "inputTokens",
    "cachedTokens",
    "outputTokens",
    "reasoningTokens",
    "sessionCount",
    "modelCount",
    "cacheHitRate",
    "totalCost",
    "inputCost",
    "cachedCost",
    "outputCost",
  ]) {
    for (const unit of ["day", "week", "month"]) {
      const ranked = [...periods[unit].values()]
        .map((slot) => ({
          period: slot.period,
          value:
            metric === "totalTokens"
              ? slot.total
              : metric === "inputTokens"
                ? slot.input
                : metric === "cachedTokens"
                  ? slot.cached
                  : metric === "outputTokens"
                    ? slot.output
                    : metric === "reasoningTokens"
                      ? slot.reasoning
                      : metric === "sessionCount"
                        ? slot.sessions.size
                        : metric === "modelCount"
                          ? slot.models.size
                          : metric === "cacheHitRate"
                            ? slot.input > 0
                              ? slot.cached / slot.input
                              : null
                            : metric === "totalCost"
                              ? slot.cost.total
                              : metric === "inputCost"
                                ? slot.cost.input
                                : metric === "cachedCost"
                                  ? slot.cost.cached
                                  : slot.cost.output,
        }))
        .filter((entry) => Number.isFinite(entry.value) && entry.value > 0)
        .sort((left, right) => right.value - left.value);
      if (ranked.length >= 2 && ranked[0].value > ranked[1].value) {
        result[unit][metric] = { period: ranked[0].period, value: ranked[0].value };
      }
    }
  }
  return result;
}

test("stored champions preserve hand-calculated strict winners, ties, CNY conversion, and period depth", async () => {
  await withDatabase(async ({ database }) => {
    const rows = [
      event({
        id: 1,
        timestamp: "2026-07-10T01:00:00.000Z",
        sessionId: "session-a",
        model: "model-a",
        total: 300,
        input: 280,
        cached: 100,
        output: 20,
      }),
      event({
        id: 2,
        timestamp: "2026-07-10T02:00:00.000Z",
        sessionId: "session-b",
        model: "model-b",
        total: 100,
        input: 90,
        cached: 80,
        output: 10,
      }),
      event({
        id: 3,
        timestamp: "2026-07-11T01:00:00.000Z",
        total: 200,
        input: 190,
        cached: 120,
        output: 10,
      }),
      event({
        id: 4,
        timestamp: "2026-07-12T01:00:00.000Z",
        homeId: "cny-home",
        total: 500,
        input: 450,
        cached: 200,
        output: 50,
      }),
    ];
    rows.forEach((row) => {
      insertEvent(database, row);
    });

    const champions = buildStoredRecordChampions({
      database,
      key: "facts-a|pricing-a|evidence-a|zone-utc|scope-all",
      factsKey: "events-1",
      zone: "utc",
      estimateRow,
      usdToCnyRate: 7.2,
    });

    assert.deepEqual(champions.day.totalTokens, { period: "2026-07-12", value: 500 });
    assert.deepEqual(champions.day.sessionCount, { period: "2026-07-10", value: 2 });
    assert.deepEqual(champions.day.modelCount, { period: "2026-07-10", value: 2 });
    assert.equal(champions.day.cacheHitRate.period, "2026-07-11");
    assert.ok(Math.abs(champions.day.cacheHitRate.value - 120 / 190) < 1e-12);
    assert.equal(champions.day.totalCost.period, "2026-07-10");
    assert.ok(Math.abs(champions.day.totalCost.value - (400 / 1000) * 7.2) < 1e-12);
    assert.deepEqual(champions.week, {}, "one comparable week must not create a record");
    assert.deepEqual(champions.month, {}, "one comparable month must not create a record");
  });
});

test("record schema can be prepared during open and creates only the declared internal tables", async () => {
  await withDatabase(async ({ database }) => {
    database.exec("CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT");
    database.prepare("INSERT INTO store_meta VALUES (?, ?)").run("fingerprint", "source-v1");
    ensureUsageRecordSchema(database);
    ensureUsageRecordSchema(database);
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String(row.name));
    for (const table of USAGE_RECORD_TABLE_NAMES) assert.ok(tables.includes(table));
    assert.equal(database.prepare("SELECT value FROM store_meta WHERE key = 'fingerprint'").get().value, "source-v1");
  });
});

test("a format-7 derived schema is replaced without touching retained event or authority facts", async () => {
  await withDatabase(async ({ database }) => {
    insertEvent(database, event({ id: 1, total: 100 }));
    database.exec(`
      CREATE TABLE usage_business_revision (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL
      ) STRICT;
      INSERT INTO usage_business_revision VALUES (1, 42);
      UPDATE usage_record_cache_format SET format_version = 7 WHERE slot = 1;
    `);

    ensureUsageRecordSchema(database);

    assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM events").get().count), 1);
    assert.equal(
      Number(database.prepare("SELECT revision FROM usage_business_revision WHERE singleton = 1").get().revision),
      42,
    );
    assert.equal(
      Number(
        database.prepare("SELECT format_version FROM usage_record_cache_format WHERE slot = 1").get().format_version,
      ),
      10,
    );
    assert.ok(
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_record_cache_append_members'")
        .get(),
    );
  });
});

test("event dirty triggers skip imports before publication and activate after a result exists", async () => {
  await withDatabase(async ({ database }) => {
    for (let id = 1; id <= 3; id += 1) {
      insertEvent(
        database,
        event({
          id,
          timestamp: `2026-07-${String(9 + id).padStart(2, "0")}T01:00:00.000Z`,
          total: id * 100,
        }),
      );
    }
    const dirtyCount = () =>
      Number(database.prepare("SELECT COUNT(*) AS count FROM usage_record_cache_dirty").get().count);
    assert.equal(dirtyCount(), 0, "initial import has no published cache to invalidate");

    const options = {
      database,
      key: "dirty-gate|pricing|evidence|utc|all",
      factsKey: "events-1",
      zone: "utc",
      estimateRow,
    };
    buildStoredRecordChampions(options);
    assert.equal(dirtyCount(), 0);

    insertEvent(
      database,
      event({
        id: 4,
        timestamp: "2026-07-20T01:00:00.000Z",
        total: 400,
      }),
    );
    assert.equal(dirtyCount(), 6, "published cache activates local/utc day/week/month markers");

    buildStoredRecordChampions({ ...options, factsKey: "events-2" });
    assert.equal(dirtyCount(), 0, "successful publication consumes all dirty partitions");
    database.prepare("UPDATE events SET total = 350 WHERE id = 4").run();
    assert.equal(dirtyCount(), 6);
    database.prepare("DELETE FROM events WHERE id = 4").run();
    assert.equal(dirtyCount(), 6);
  });
});

test("UTC dirty periods preserve the day before epoch for fractional negative seconds", async () => {
  await withDatabase(async ({ database }) => {
    insertEvent(database, event({ id: 1, timestamp: "1969-12-31T23:59:59.999Z", week: "1969-12-29", total: 100 }));
    insertEvent(database, event({ id: 2, timestamp: "1970-01-01T00:00:00.000Z", week: "1969-12-29", total: 200 }));
    const options = { database, key: "epoch|utc", factsKey: "1", zone: "utc", estimateRow };
    buildStoredRecordChampions(options);
    database.prepare("UPDATE events SET total = 300 WHERE id = 1").run();
    assert.deepEqual(
      database
        .prepare("SELECT period_key FROM usage_record_cache_dirty WHERE calendar_zone = 'utc' AND unit = 'day'")
        .all()
        .map((row) => row.period_key),
      ["1969-12-31"],
    );
    assert.deepEqual(buildStoredRecordChampions({ ...options, factsKey: "2" }).day.totalTokens, {
      period: "1969-12-31",
      value: 300,
    });
  });
});

test("append preserves an epoch-zero minimum for later local dirty rebuilds", async () => {
  const previousZone = process.env.TZ;
  process.env.TZ = "Asia/Shanghai";
  try {
    await withDatabase(async ({ database }) => {
      insertEvent(
        database,
        event({
          id: 1,
          timestamp: "1970-01-01T00:00:00.000Z",
          day: "1970-01-01",
          week: "1969-12-29",
          month: "1970-01",
          sessionId: "epoch-zero",
          total: 100,
        }),
      );
      insertEvent(
        database,
        event({
          id: 2,
          timestamp: "1970-01-03T00:00:00.000Z",
          day: "1970-01-03",
          week: "1969-12-29",
          month: "1970-01",
          sessionId: "later-day",
          total: 200,
        }),
      );
      const options = {
        database,
        key: "epoch-zero-append|pricing|evidence|local|all",
        factsKey: "facts-1",
        zone: "local",
        estimateRow,
      };
      buildStoredRecordChampions(options);

      insertEvent(
        database,
        event({
          id: 3,
          timestamp: "1970-01-01T01:00:00.000Z",
          day: "1970-01-01",
          week: "1969-12-29",
          month: "1970-01",
          sessionId: "later-in-day",
          total: 50,
        }),
      );
      buildStoredRecordChampions({ ...options, factsKey: "facts-2" });
      assert.equal(
        database
          .prepare(
            `SELECT minimum_ms FROM usage_record_cache_periods
             WHERE unit = 'day' AND period_key = '1970-01-01'`,
          )
          .get().minimum_ms,
        0,
      );

      database.prepare("UPDATE events SET total = total WHERE id = 3").run();
      buildStoredRecordChampions({ ...options, factsKey: "facts-3" });
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(
            database
              .prepare(
                `SELECT total_tokens, session_count, minimum_ms FROM usage_record_cache_periods
                 WHERE unit = 'day' AND period_key = '1970-01-01'`,
              )
              .get(),
          ),
        ),
        { total_tokens: 150, session_count: 2, minimum_ms: 0 },
      );
    });
  } finally {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  }
});

test("a separate frozen source keeps querying its snapshot while a writer commits", async () => {
  await withDatabase(async ({ directory }) => {
    const sourceFile = path.join(directory, "frozen-source.sqlite");
    const source = new DatabaseSync(sourceFile);
    const writer = new DatabaseSync(sourceFile);
    const derived = new DatabaseSync(":memory:");
    source.exec("PRAGMA journal_mode = WAL");
    createEventsTable(source);
    insertEvent(
      source,
      event({
        id: 1,
        timestamp: "2026-07-10T01:00:00.000Z",
        total: 100,
      }),
    );
    insertEvent(
      source,
      event({
        id: 2,
        timestamp: "2026-07-11T01:00:00.000Z",
        total: 500,
      }),
    );
    try {
      source.exec("BEGIN");
      assert.equal(Number(source.prepare("SELECT COUNT(*) AS count FROM events").get().count), 2);

      insertEvent(
        writer,
        event({
          id: 3,
          timestamp: "2026-07-12T01:00:00.000Z",
          total: 900,
        }),
      );

      const frozen = buildStoredRecordChampions({
        database: derived,
        sourceDatabase: source,
        key: "snapshot|pricing|evidence|utc|all",
        factsKey: "snapshot-revision-1",
        zone: "utc",
        estimateRow,
      });
      assert.deepEqual(frozen.day.totalTokens, { period: "2026-07-11", value: 500 });
      assert.equal(Number(source.prepare("SELECT COUNT(*) AS count FROM events").get().count), 2);
      assert.equal(
        Number(
          derived
            .prepare(
              `SELECT COUNT(*) AS count FROM sqlite_master
               WHERE type = 'trigger' AND name LIKE 'usage_record_dirty_%'`,
            )
            .get().count,
        ),
        0,
        "a destination without events must not receive source dirty triggers",
      );

      source.exec("ROLLBACK");
      const latest = buildStoredRecordChampions({
        database: derived,
        sourceDatabase: source,
        key: "snapshot|pricing|evidence|utc|all",
        factsKey: "snapshot-revision-2",
        zone: "utc",
        estimateRow,
      });
      assert.deepEqual(latest.day.totalTokens, { period: "2026-07-12", value: 900 });
      assert.deepEqual(
        readStoredRecordChampions({
          database: derived,
          key: "snapshot|pricing|evidence|utc|all",
          factsKey: "snapshot-revision-2",
        }),
        latest,
      );
    } finally {
      if (source.isTransaction) source.exec("ROLLBACK");
      derived.close();
      source.close();
      if (!writer.isTransaction) writer.close();
    }
  });
});

test("stored projection matches the original algorithm across files, exclusions, and both calendar zones", async () => {
  await withDatabase(async ({ database }) => {
    const rows = [
      event({
        id: 1,
        sourcePath: "/sessions/a.jsonl",
        timestamp: "2026-07-05T16:30:00.000Z",
        homeId: "keep",
        sessionId: "shared",
        model: "model-a",
        total: 400,
        input: 300,
        cached: 100,
        output: 90,
        day: "2026-07-06",
        week: "2026-07-06",
      }),
      event({
        id: 2,
        sourcePath: "/sessions/b.jsonl",
        timestamp: "2026-07-06T02:00:00.000Z",
        homeId: "drop",
        sessionId: "shared",
        model: "model-b",
        total: 900,
        input: 850,
        cached: 600,
        output: 40,
        day: "2026-07-06",
        week: "2026-07-06",
      }),
      event({
        id: 3,
        sourcePath: "/sessions/c.jsonl",
        timestamp: "2026-07-07T01:00:00.000Z",
        homeId: "keep",
        sessionId: "later",
        model: "model-a",
        total: 350,
        input: 300,
        cached: 150,
        output: 45,
        day: "2026-07-07",
        week: "2026-07-06",
      }),
    ];
    rows.forEach((row) => {
      insertEvent(database, row);
    });

    for (const [zone, excluded] of [
      ["utc", false],
      ["local", false],
      ["utc", true],
    ]) {
      const scopedRows = excluded ? rows.filter((row) => row.home_id !== "drop") : rows;
      const expected = originalChampions(scopedRows, zone, 7.2, estimateRow);
      const actual = buildStoredRecordChampions({
        database,
        key: `facts-${zone}-${excluded}|pricing-a|evidence-a|${zone}|scope`,
        factsKey: `events-${zone}-${excluded}`,
        zone,
        where: excluded ? "WHERE home_id NOT IN (?)" : "",
        params: excluded ? ["drop"] : [],
        estimateRow,
        usdToCnyRate: 7.2,
      });
      assert.deepEqual(actual, expected);
    }
  });
});

test("a factsKey advance appends above the high-water and keeps cross-period session identity exact", async () => {
  await withDatabase(async ({ database }) => {
    const initial = [
      event({
        id: 1,
        timestamp: "2026-07-10T01:00:00.000Z",
        sessionId: "shared-session",
        model: "model-a",
        total: 100,
      }),
      event({
        id: 2,
        timestamp: "2026-08-10T01:00:00.000Z",
        sessionId: "august-a",
        model: "model-b",
        total: 400,
      }),
      event({
        id: 3,
        timestamp: "2026-08-11T01:00:00.000Z",
        sessionId: "august-b",
        model: "model-c",
        total: 500,
      }),
    ];
    initial.forEach((row) => {
      insertEvent(database, row);
    });
    const options = {
      database,
      key: "stable|pricing|evidence|utc|all",
      factsKey: "events-1",
      zone: "utc",
      estimateRow,
    };
    const first = buildStoredRecordChampions(options);
    assert.deepEqual(first.day.totalTokens, { period: "2026-08-11", value: 500 });

    insertEvent(
      database,
      event({
        id: 4,
        timestamp: "2026-07-11T01:00:00.000Z",
        sessionId: "shared-session",
        model: "model-d",
        total: 300,
      }),
    );
    const scanned = [];
    const updated = buildStoredRecordChampions({
      ...options,
      factsKey: "events-2",
      estimateRow(row) {
        scanned.push(Number(row.id));
        return estimateRow(row);
      },
    });
    assert.deepEqual(scanned, [4], "only the appended event is priced");
    assert.deepEqual(updated.day.totalTokens, { period: "2026-08-11", value: 500 });
    assert.deepEqual(readStoredRecordChampions({ database, key: options.key, factsKey: "events-2" }), updated);

    const counts = database
      .prepare(
        `SELECT unit, period_key, session_count, model_count
         FROM usage_record_cache_periods
         WHERE period_key IN ('2026-07-10', '2026-07-11', '2026-07')
         ORDER BY unit, period_key`,
      )
      .all();
    assert.deepEqual(
      counts.map((row) => [row.unit, row.period_key, row.session_count, row.model_count]),
      [
        ["day", "2026-07-10", 1, 1],
        ["day", "2026-07-11", 1, 1],
        ["month", "2026-07", 1, 2],
      ],
    );
  });
});

test("true append matches a complete full oracle for every stored scalar, member, and champion", async () => {
  await withDatabase(async ({ database }) => {
    const initial = [
      event({
        id: 1,
        timestamp: "2026-07-10T01:00:00.000Z",
        sourcePath: "/sessions/a.jsonl",
        sessionId: "shared",
        model: "model-a",
        total: 100,
        input: 90,
        cached: 30,
        output: 10,
      }),
      event({
        id: 2,
        timestamp: "2026-07-11T01:00:00.000Z",
        sourcePath: "/sessions/b.jsonl",
        sessionId: "other",
        model: "model-b",
        total: 200,
        input: 180,
        cached: 120,
        output: 20,
      }),
      event({
        id: 3,
        timestamp: "2026-07-02T01:00:00.000Z",
        sourcePath: "/sessions/c.jsonl",
        sessionId: "third",
        model: "model-c",
        total: 80,
        input: 70,
        cached: 20,
        output: 10,
      }),
    ];
    const appended = [
      event({
        id: 4,
        timestamp: "2026-07-06T01:00:00.000Z",
        sourcePath: "/sessions/d.jsonl",
        sessionId: "shared",
        model: "model-a",
        total: 240,
        input: 220,
        cached: 100,
        output: 20,
      }),
      event({
        id: 5,
        timestamp: "2026-08-02T01:00:00.000Z",
        sourcePath: "/sessions/e.jsonl",
        sessionId: "shared",
        model: "model-c",
        homeId: "cny-home",
        total: 360,
        input: 330,
        cached: 210,
        output: 30,
      }),
    ];
    for (const row of initial) insertEvent(database, row);
    const options = {
      database,
      key: "append-oracle|pricing-a|evidence-a|utc|all",
      factsKey: "events-1",
      zone: "utc",
      estimateRow,
      usdToCnyRate: 7.2,
    };
    buildStoredRecordChampions(options);
    for (const row of appended) insertEvent(database, row);
    const actual = buildStoredRecordChampions({ ...options, factsKey: "events-2" });

    const oracle = new DatabaseSync(":memory:");
    try {
      createEventsTable(oracle);
      ensureUsageRecordSchema(oracle);
      for (const row of [...initial, ...appended]) insertEvent(oracle, row);
      const expected = buildStoredRecordChampions({ ...options, database: oracle, factsKey: "events-2" });
      assert.deepEqual(actual, expected);
      assert.deepEqual(projectionSnapshot(database), projectionSnapshot(oracle));
    } finally {
      oracle.close();
    }
  });
});

test("a small append prices and reads only rows above the published high-water", async () => {
  await withDatabase(async ({ database }) => {
    for (let id = 1; id <= 300; id += 1) {
      insertEvent(
        database,
        event({
          id,
          timestamp: `2026-07-10T${String(Math.floor((id - 1) / 60)).padStart(2, "0")}:${String((id - 1) % 60).padStart(
            2,
            "0",
          )}:00.000Z`,
          sessionId: `bulk-session-${id % 17}`,
          model: `bulk-model-${id % 5}`,
          total: 100 + id,
        }),
      );
    }
    const options = {
      database,
      key: "small-append|pricing|evidence|utc|all",
      factsKey: "events-1",
      zone: "utc",
      batchSize: 2,
      estimateRow,
    };
    buildStoredRecordChampions(options);
    insertEvent(database, event({ id: 301, timestamp: "2026-07-10T06:00:00.000Z", sessionId: "new-a", total: 501 }));
    insertEvent(database, event({ id: 302, timestamp: "2026-07-10T06:01:00.000Z", sessionId: "new-b", total: 502 }));

    const priced = [];
    const cursorWatch = watchEventCursors(database);
    try {
      buildStoredRecordChampions({
        ...options,
        factsKey: "events-2",
        estimateRow(row) {
          priced.push(Number(row.id));
          return estimateRow(row);
        },
      });
      assert.deepEqual(priced, [301, 302]);
      assert.deepEqual(cursorWatch.stats.ids, [301, 302]);
      assert.equal(cursorWatch.stats.rowsRead, 2);
      assert.equal(cursorWatch.stats.iterations, 1);
      assert.match(cursorWatch.stats.sql[0], /id > \? ORDER BY id ASC/);
    } finally {
      cursorWatch.restore();
    }
  });
});

test("pricing, evidence, zone, and filter identity changes take the conservative full path", async () => {
  await withDatabase(async ({ database }) => {
    insertEvent(database, event({ id: 1, homeId: "keep", timestamp: "2026-07-10T01:00:00.000Z", total: 100 }));
    insertEvent(database, event({ id: 2, homeId: "drop", timestamp: "2026-07-11T01:00:00.000Z", total: 200 }));
    const options = {
      database,
      key: "dependency-v1|pricing-a|evidence-a|utc|all",
      factsKey: "facts-1",
      zone: "utc",
      estimateRow,
    };
    buildStoredRecordChampions(options);
    insertEvent(database, event({ id: 3, homeId: "keep", timestamp: "2026-07-12T01:00:00.000Z", total: 300 }));

    const appended = [];
    buildStoredRecordChampions({
      ...options,
      factsKey: "facts-2",
      estimateRow(row) {
        appended.push(Number(row.id));
        return estimateRow(row);
      },
    });
    assert.deepEqual(appended, [3]);

    insertEvent(database, event({ id: 4, homeId: "drop", timestamp: "2026-07-13T01:00:00.000Z", total: 400 }));
    const pricingRepriced = [];
    buildStoredRecordChampions({
      ...options,
      key: "dependency-v2|pricing-b|evidence-b|utc|all",
      factsKey: "facts-3",
      estimateRow(row) {
        pricingRepriced.push(Number(row.id));
        return estimateRow(row);
      },
    });
    assert.deepEqual(pricingRepriced, [1, 2, 3, 4]);

    const zoneRepriced = [];
    buildStoredRecordChampions({
      ...options,
      key: "dependency-v3|pricing-b|evidence-b|local|all",
      factsKey: "facts-4",
      zone: "local",
      estimateRow(row) {
        zoneRepriced.push(Number(row.id));
        return estimateRow(row);
      },
    });
    assert.deepEqual(zoneRepriced, [1, 2, 3, 4]);

    const filterRepriced = [];
    buildStoredRecordChampions({
      ...options,
      key: "dependency-v4|pricing-b|evidence-b|local|keep",
      factsKey: "facts-5",
      zone: "local",
      where: "WHERE home_id = ?",
      params: ["keep"],
      estimateRow(row) {
        filterRepriced.push(Number(row.id));
        return estimateRow(row);
      },
    });
    assert.deepEqual(filterRepriced, [1, 3]);
  });
});

test("local record membership and revisions preserve calendar keys imported in another timezone", async () => {
  const previousZone = process.env.TZ;
  process.env.TZ = "Asia/Shanghai";
  try {
    await withDatabase(async ({ database }) => {
      const rows = [
        event({ id: 1, timestamp: "2026-07-05T23:30:00Z", day: "2026-07-05", week: "2026-06-29", total: 100 }),
        event({ id: 2, timestamp: "2026-07-05T10:00:00Z", day: "2026-07-05", week: "2026-06-29", total: 200 }),
        event({ id: 3, timestamp: "2026-07-06T10:00:00Z", day: "2026-07-06", week: "2026-07-06", total: 100 }),
      ];
      for (const row of rows) insertEvent(database, row);
      const options = { database, key: "imported-zone|local", factsKey: "1", zone: "local", estimateRow };
      assert.deepEqual(buildStoredRecordChampions(options), originalChampions(rows, "local", 1, estimateRow));
      database.prepare("UPDATE events SET day_key = ?, week_key = ? WHERE id = 3").run("2026-07-05", "2026-06-29");
      rows[2].day_key = "2026-07-05";
      rows[2].week_key = "2026-06-29";
      assert.deepEqual(
        buildStoredRecordChampions({ ...options, factsKey: "2" }),
        originalChampions(rows, "local", 1, estimateRow),
      );
      const period = database
        .prepare(
          "SELECT total_tokens, session_count FROM usage_record_cache_periods WHERE unit = 'day' AND period_key = '2026-07-05'",
        )
        .get();
      assert.equal(period.total_tokens, 400);
      assert.equal(period.session_count, 3);
    });
  } finally {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  }
});

test("batched scalar writes preserve the original event-by-event floating sum", async () => {
  await withDatabase(async ({ database }) => {
    const costs = [0.1, 0.2, 0.3, 0.4, 0.5];
    for (let id = 1; id <= 5; id += 1) {
      insertEvent(
        database,
        event({
          id,
          timestamp: "2026-07-10T01:00:00.000Z",
          total: 10,
        }),
      );
    }
    insertEvent(
      database,
      event({
        id: 6,
        timestamp: "2026-07-11T01:00:00.000Z",
        total: 1,
      }),
    );
    const champions = buildStoredRecordChampions({
      database,
      key: "float-order|pricing|evidence|utc|all",
      factsKey: "events-float",
      zone: "utc",
      batchSize: 2,
      estimateRow(row) {
        const id = Number(row.id);
        if (id === 6) return { currency: "USD", totalUsd: 0.25, inputUsd: 0, cachedInputUsd: 0, outputUsd: 0 };
        return { currency: "USD", totalUsd: costs[id - 1], inputUsd: 0, cachedInputUsd: 0, outputUsd: 0 };
      },
    });
    let expected = 0;
    for (const cost of costs) expected += cost;
    assert.equal(
      database
        .prepare(
          `SELECT total_cost FROM usage_record_cache_periods
           WHERE unit = 'day' AND period_key = '2026-07-10'`,
        )
        .get().total_cost,
      expected,
    );
    assert.deepEqual(champions.day.totalCost, { period: "2026-07-10", value: expected });
  });
});

test("a full build prices events once through one ordered cursor across committed batches", async () => {
  await withDatabase(async ({ database }) => {
    const eventCount = 513;
    for (let id = 1; id <= eventCount; id += 1) {
      insertEvent(
        database,
        event({
          id,
          timestamp: `2026-07-10T${String(Math.floor((id - 1) / 60)).padStart(2, "0")}:${String((id - 1) % 60).padStart(
            2,
            "0",
          )}:00.000Z`,
          sessionId: `cursor-session-${id % 9}`,
          model: `cursor-model-${id % 4}`,
          total: 100 + id,
        }),
      );
    }

    const cursorWatch = watchEventCursors(database);
    let committedBatches = 0;
    try {
      const champions = buildStoredRecordChampions({
        database,
        key: "cursor-reuse|pricing|evidence|utc|all",
        factsKey: "events-cursor-reuse",
        zone: "utc",
        batchSize: 37,
        estimateRow,
        afterBatch() {
          committedBatches += 1;
        },
      });

      assert.deepEqual(champions, { day: {}, week: {}, month: {} });
      assert.equal(
        database
          .prepare(
            `SELECT total_tokens FROM usage_record_cache_periods
             WHERE unit = 'day' AND period_key = '2026-07-10'`,
          )
          .get().total_tokens,
        (100 + 1 + 100 + eventCount) * (eventCount / 2),
      );
      assert.ok(committedBatches > 3, "one scan fills all three period units across committed batches");
      assert.equal(cursorWatch.stats.prepares, 1);
      assert.equal(cursorWatch.stats.iterations, 1);
      assert.equal(cursorWatch.stats.returns, 1);
      assert.equal(cursorWatch.stats.sql.length, 1);
      assert.ok(cursorWatch.stats.sql.every((sql) => !/\bLIMIT\b/i.test(sql)));
    } finally {
      cursorWatch.restore();
    }
  });
});

test("event update and delete rebuild their old/new periods and lower the champion", async () => {
  await withDatabase(async ({ database }) => {
    for (const [id, total] of [
      [1, 300],
      [2, 200],
      [3, 100],
    ]) {
      insertEvent(
        database,
        event({
          id,
          timestamp: `2026-07-${String(9 + id).padStart(2, "0")}T01:00:00.000Z`,
          sessionId: `session-${id}`,
          model: `model-${id}`,
          total,
        }),
      );
    }
    const options = {
      database,
      key: "decline|pricing|evidence|utc|all",
      factsKey: "events-1",
      zone: "utc",
      estimateRow,
    };
    assert.deepEqual(buildStoredRecordChampions(options).day.totalTokens, {
      period: "2026-07-10",
      value: 300,
    });

    database
      .prepare(
        `UPDATE events
         SET timestamp_ms = ?, day_key = ?, week_key = ?, month_key = ?, total = 50, input = 40
         WHERE id = 1`,
      )
      .run(Date.parse("2026-08-01T01:00:00.000Z"), "2026-08-01", "2026-07-27", "2026-08");
    const afterUpdate = buildStoredRecordChampions({
      ...options,
      factsKey: "events-2",
    });
    assert.deepEqual(afterUpdate.day.totalTokens, { period: "2026-07-11", value: 200 });
    assert.deepEqual(
      database
        .prepare(
          `SELECT period_key, total_tokens FROM usage_record_cache_periods
           WHERE unit = 'day' AND period_key IN ('2026-07-10', '2026-08-01')
           ORDER BY period_key`,
        )
        .all()
        .map((row) => [row.period_key, row.total_tokens]),
      [["2026-08-01", 50]],
    );

    database.prepare("DELETE FROM events WHERE id = 2").run();
    const afterDelete = buildStoredRecordChampions({
      ...options,
      factsKey: "events-3",
    });
    assert.deepEqual(afterDelete.day.totalTokens, { period: "2026-07-12", value: 100 });
    assert.equal(readStoredRecordChampions({ database, key: options.key, factsKey: "events-2" }), null);
  });
});

test("old-id inserts and external updates/deletes persist a rebuild requirement", async () => {
  await withDatabase(async ({ database, databaseFile }) => {
    for (const [id, day, total] of [
      [10, 10, 300],
      [20, 11, 200],
      [30, 12, 100],
    ]) {
      insertEvent(
        database,
        event({
          id,
          timestamp: `2026-07-${day}T01:00:00.000Z`,
          sessionId: `session-${id}`,
          model: `model-${id}`,
          total,
        }),
      );
    }
    const options = {
      database,
      key: "writer-safety|pricing|evidence|utc|all",
      factsKey: "events-1",
      zone: "utc",
      estimateRow,
    };
    buildStoredRecordChampions(options);
    const operationState = () =>
      Number(
        database.prepare("SELECT rebuild_required FROM usage_record_cache_operations WHERE slot = 1").get()
          .rebuild_required,
      );

    insertEvent(database, event({ id: 15, timestamp: "2026-07-10T02:00:00.000Z", total: 50 }));
    assert.equal(operationState(), 1);
    const oldInsertPriced = [];
    const backdated = buildStoredRecordChampions({
      ...options,
      factsKey: "events-2",
      estimateRow(row) {
        oldInsertPriced.push(Number(row.id));
        return estimateRow(row);
      },
    });
    assert.deepEqual(oldInsertPriced.slice(0, 2), [10, 15], "the affected periods are rebuilt in event-id order");
    assert.ok(oldInsertPriced.length > 2, "the current dirty fallback rescans existing history");
    assert.deepEqual(backdated.day.totalTokens, { period: "2026-07-10", value: 350 });
    assert.equal(operationState(), 0);

    const writer = new DatabaseSync(databaseFile);
    try {
      writer.prepare("UPDATE events SET total = 20, input = 10 WHERE id = 10").run();
      assert.equal(operationState(), 1);
      const afterUpdate = buildStoredRecordChampions({ ...options, factsKey: "events-3" });
      assert.deepEqual(afterUpdate.day.totalTokens, { period: "2026-07-11", value: 200 });
      assert.equal(operationState(), 0);

      writer.prepare("DELETE FROM events WHERE id = 20").run();
      assert.equal(operationState(), 1);
      const afterDelete = buildStoredRecordChampions({ ...options, factsKey: "events-4" });
      assert.deepEqual(afterDelete.day.totalTokens, { period: "2026-07-12", value: 100 });
      assert.equal(operationState(), 0);
    } finally {
      writer.close();
    }
  });
});

test("a high-traffic dirty period persists its last event id and resumes in a new connection", async () => {
  await withDatabase(async ({ database, databaseFile }) => {
    for (let id = 1; id <= 8; id += 1) {
      insertEvent(
        database,
        event({
          id,
          timestamp: "2026-07-10T01:00:00.000Z",
          sessionId: `bulk-${Math.ceil(id / 2)}`,
          model: `model-${id % 2}`,
          total: id * 100,
        }),
      );
    }
    insertEvent(
      database,
      event({
        id: 9,
        timestamp: "2026-08-01T01:00:00.000Z",
        sessionId: "august",
        model: "model-august",
        total: 50,
      }),
    );
    const key = "bulk|pricing|evidence|utc|all";
    buildStoredRecordChampions({ database, key, factsKey: "initial", zone: "utc", estimateRow });
    database.prepare("UPDATE events SET total = total WHERE id = 1").run();
    const factsKey = "events-bulk";
    const firstIds = [];
    const cursorWatch = watchEventCursors(database);
    try {
      assert.throws(
        () =>
          buildStoredRecordChampions({
            database,
            key,
            factsKey,
            zone: "utc",
            batchSize: 3,
            estimateRow(row) {
              firstIds.push(Number(row.id));
              return estimateRow(row);
            },
            afterBatch() {
              throw new Error("stop bulk period");
            },
          }),
        /stop bulk period/,
      );
    } finally {
      cursorWatch.restore();
    }
    assert.equal(cursorWatch.stats.prepares, 1);
    assert.equal(cursorWatch.stats.iterations, 1);
    assert.equal(cursorWatch.stats.returns, 1, "an interrupted build releases its open source cursor");
    assert.deepEqual(firstIds, [1, 2, 3]);
    const progress = database
      .prepare(
        `SELECT last_event_id FROM usage_record_cache_work
         WHERE unit = 'day' AND period_key = '2026-07-10'`,
      )
      .get();
    assert.equal(progress.last_event_id, 3);

    const reopened = new DatabaseSync(databaseFile);
    try {
      const resumedIds = [];
      const champions = buildStoredRecordChampions({
        database: reopened,
        key,
        factsKey,
        zone: "utc",
        batchSize: 3,
        estimateRow(row) {
          resumedIds.push(Number(row.id));
          return estimateRow(row);
        },
      });
      assert.deepEqual(resumedIds.slice(0, 5), [4, 5, 6, 7, 8]);
      assert.deepEqual(champions.day.totalTokens, { period: "2026-07-10", value: 3600 });
    } finally {
      reopened.close();
    }
  });
});

test("an external fact commit stops the build before another batch can mix revisions", async () => {
  await withDatabase(async ({ database, databaseFile }) => {
    database.exec("PRAGMA journal_mode = WAL");
    for (let id = 1; id <= 5; id += 1) {
      insertEvent(
        database,
        event({
          id,
          timestamp: "2026-07-10T01:00:00.000Z",
          total: id * 100,
        }),
      );
    }
    const writer = new DatabaseSync(databaseFile);
    const cursorWatch = watchEventCursors(database);
    let inserted = false;
    try {
      assert.throws(
        () =>
          buildStoredRecordChampions({
            database,
            key: "facts-v1|pricing|evidence|utc|all",
            factsKey: "events-v1",
            zone: "utc",
            estimateRow,
            batchSize: 2,
            afterBatch() {
              if (inserted) return;
              inserted = true;
              insertEvent(
                writer,
                event({
                  id: 6,
                  timestamp: "2026-07-10T01:00:00.000Z",
                  total: 600,
                }),
              );
            },
          }),
        (error) => error?.code === "USAGE_RECORD_FACTS_CHANGED",
      );
      assert.equal(inserted, true);
      const candidate = database
        .prepare("SELECT state, published_facts_key, champion_json FROM usage_record_cache WHERE slot = 1")
        .get();
      assert.equal(candidate.state, "building");
      assert.equal(candidate.published_facts_key, null);
      assert.equal(candidate.champion_json, null);
      assert.equal(cursorWatch.stats.prepares, 1);
      assert.equal(cursorWatch.stats.iterations, 1);
      assert.equal(cursorWatch.stats.returns, 1, "a facts-version abort releases its open source cursor");
    } finally {
      cursorWatch.restore();
      writer.close();
    }
  });
});

test("an interrupted fixed-id build resumes without replaying committed event batches", async () => {
  await withDatabase(async ({ database, databaseFile }) => {
    for (let id = 1; id <= 5; id += 1) {
      insertEvent(
        database,
        event({
          id,
          timestamp: `2026-07-${String(9 + id).padStart(2, "0")}T01:00:00.000Z`,
          total: id * 100,
        }),
      );
    }
    const firstIds = [];
    assert.throws(
      () =>
        buildStoredRecordChampions({
          database,
          key: "interrupt|pricing|evidence|utc|all",
          factsKey: "events-1",
          zone: "utc",
          estimateRow(row) {
            firstIds.push(Number(row.id));
            return estimateRow(row);
          },
          batchSize: 2,
          afterBatch() {
            throw new Error("stop after committed batch");
          },
        }),
      /stop after committed batch/,
    );
    assert.deepEqual(firstIds, [1, 2]);
    const candidate = database
      .prepare("SELECT state, published_facts_key, champion_json FROM usage_record_cache WHERE slot = 1")
      .get();
    assert.equal(candidate.state, "building");
    assert.equal(candidate.published_facts_key, null);
    assert.equal(candidate.champion_json, null);
    assert.equal(
      readStoredRecordChampions({
        database,
        key: "interrupt|pricing|evidence|utc|all",
        factsKey: "events-1",
      }),
      null,
    );

    const reopened = new DatabaseSync(databaseFile);
    try {
      const resumedIds = [];
      const champions = buildStoredRecordChampions({
        database: reopened,
        key: "interrupt|pricing|evidence|utc|all",
        factsKey: "events-1",
        zone: "utc",
        estimateRow(row) {
          resumedIds.push(Number(row.id));
          return estimateRow(row);
        },
        batchSize: 2,
      });
      assert.deepEqual(resumedIds, [3, 4, 5]);
      assert.deepEqual(champions.day.totalTokens, { period: "2026-07-14", value: 500 });
    } finally {
      reopened.close();
    }
  });
});

test("an interrupted append resumes at its persisted batch boundary and keeps old facts published", async () => {
  await withDatabase(async ({ database, databaseFile }) => {
    for (let id = 1; id <= 2; id += 1) {
      insertEvent(
        database,
        event({
          id,
          timestamp: `2026-07-${String(9 + id).padStart(2, "0")}T01:00:00.000Z`,
          total: id * 100,
        }),
      );
    }
    const key = "append-resume|pricing|evidence|utc|all";
    const initial = buildStoredRecordChampions({
      database,
      key,
      factsKey: "facts-1",
      zone: "utc",
      batchSize: 2,
      estimateRow,
    });
    const oldSnapshot = projectionSnapshot(database);
    for (let id = 3; id <= 7; id += 1) {
      insertEvent(
        database,
        event({
          id,
          timestamp: `2026-07-${String(9 + id).padStart(2, "0")}T01:00:00.000Z`,
          total: id * 100,
        }),
      );
    }

    const firstIds = [];
    assert.throws(
      () =>
        buildStoredRecordChampions({
          database,
          key,
          factsKey: "facts-2",
          zone: "utc",
          batchSize: 2,
          estimateRow(row) {
            firstIds.push(Number(row.id));
            return estimateRow(row);
          },
          afterBatch() {
            throw new Error("stop append after committed batch");
          },
        }),
      /stop append after committed batch/,
    );
    assert.deepEqual(firstIds, [3, 4]);
    assert.deepEqual(projectionSnapshot(database), oldSnapshot, "partial append stays in durable staging");
    assert.deepEqual(readStoredRecordChampions({ database, key, factsKey: "facts-1" }), initial);
    assert.equal(readStoredRecordChampions({ database, key, factsKey: "facts-2" }), null);
    const candidate = database
      .prepare("SELECT state, build_mode, target_facts_key, published_facts_key FROM usage_record_cache WHERE slot = 1")
      .get();
    assert.equal(candidate.state, "building");
    assert.equal(candidate.build_mode, "append");
    assert.equal(candidate.target_facts_key, "facts-2");
    assert.equal(candidate.published_facts_key, "facts-1");

    const reopened = new DatabaseSync(databaseFile);
    try {
      const resumedIds = [];
      const champions = buildStoredRecordChampions({
        database: reopened,
        key,
        factsKey: "facts-2",
        zone: "utc",
        batchSize: 2,
        estimateRow(row) {
          resumedIds.push(Number(row.id));
          return estimateRow(row);
        },
      });
      assert.deepEqual(resumedIds, [5, 6, 7]);
      assert.deepEqual(champions.day.totalTokens, { period: "2026-07-16", value: 700 });
      assert.equal(readStoredRecordChampions({ database: reopened, key, factsKey: "facts-1" }), null);
      assert.deepEqual(readStoredRecordChampions({ database: reopened, key, factsKey: "facts-2" }), champions);
      assert.equal(Number(reopened.prepare("SELECT COUNT(*) AS count FROM usage_record_cache_work").get().count), 0);
    } finally {
      reopened.close();
    }
  });
});

test("append ranking preserves ties exactly and a later delete falls back and lowers the winner", async () => {
  await withDatabase(async ({ database }) => {
    for (const [id, total] of [
      [1, 300],
      [2, 200],
      [3, 100],
    ]) {
      insertEvent(
        database,
        event({
          id,
          timestamp: `2026-07-${String(9 + id).padStart(2, "0")}T01:00:00.000Z`,
          total,
        }),
      );
    }
    const options = {
      database,
      key: "append-tie|pricing|evidence|utc|all",
      factsKey: "facts-1",
      zone: "utc",
      estimateRow,
    };
    assert.deepEqual(buildStoredRecordChampions(options).day.totalTokens, {
      period: "2026-07-10",
      value: 300,
    });

    insertEvent(database, event({ id: 4, timestamp: "2026-07-11T01:00:00.000Z", total: 100 }));
    const tied = buildStoredRecordChampions({ ...options, factsKey: "facts-2" });
    assert.equal(tied.day.totalTokens, undefined);

    database.prepare("DELETE FROM events WHERE id = 1").run();
    const lowered = buildStoredRecordChampions({ ...options, factsKey: "facts-3" });
    assert.deepEqual(lowered.day.totalTokens, { period: "2026-07-11", value: 300 });
  });
});

test("append ranking exposes a three-period cache-hit tie after the old leader declines", async () => {
  await withDatabase(async ({ database }) => {
    const rows = [
      event({ id: 1, timestamp: "2026-07-10T01:00:00.000Z", total: 100, input: 100, cached: 95 }),
      event({ id: 2, timestamp: "2026-07-11T01:00:00.000Z", total: 100, input: 100, cached: 90 }),
      event({ id: 3, timestamp: "2026-07-12T01:00:00.000Z", total: 100, input: 100, cached: 90 }),
    ];
    for (const row of rows) insertEvent(database, row);
    const options = {
      database,
      key: "append-hit-tie|pricing|evidence|utc|all",
      factsKey: "facts-1",
      zone: "utc",
      estimateRow,
    };
    assert.deepEqual(buildStoredRecordChampions(options).day.cacheHitRate, {
      period: "2026-07-10",
      value: 0.95,
    });

    const appended = event({
      id: 4,
      timestamp: "2026-07-10T02:00:00.000Z",
      total: 100,
      input: 100,
      cached: 0,
    });
    insertEvent(database, appended);
    rows.push(appended);
    const afterDecline = buildStoredRecordChampions({ ...options, factsKey: "facts-2" });
    assert.equal(afterDecline.day.cacheHitRate, undefined, "the two remaining 0.9 periods tie");
    assert.deepEqual(afterDecline, originalChampions(rows, "utc", 1, estimateRow));
  });
});

test("repeated append declines and negative contributions match the full oracle", async () => {
  await withDatabase(async ({ database }) => {
    const rows = [
      event({ id: 1, timestamp: "2026-07-10T01:00:00.000Z", total: 100, input: 100, cached: 100 }),
      event({ id: 2, timestamp: "2026-07-11T01:00:00.000Z", total: 100, input: 100, cached: 95 }),
      event({ id: 3, timestamp: "2026-07-12T01:00:00.000Z", total: 100, input: 100, cached: 90 }),
      event({ id: 4, timestamp: "2026-07-13T01:00:00.000Z", total: 100, input: 100, cached: 85 }),
    ];
    for (const row of rows) insertEvent(database, row);
    const options = {
      database,
      key: "append-hit-declines|pricing|evidence|utc|all",
      factsKey: "facts-1",
      zone: "utc",
      estimateRow,
    };
    assert.deepEqual(buildStoredRecordChampions(options), originalChampions(rows, "utc", 1, estimateRow));

    const appended = [
      event({ id: 5, timestamp: "2026-07-10T02:00:00.000Z", total: 100, input: 100, cached: 0 }),
      event({ id: 6, timestamp: "2026-07-11T02:00:00.000Z", total: 100, input: 100, cached: 0 }),
      event({ id: 7, timestamp: "2026-07-12T02:00:00.000Z", total: 100, input: 100, cached: 0 }),
      event({
        id: 8,
        timestamp: "2026-07-11T03:00:00.000Z",
        total: -50,
        input: -20,
        cached: -10,
        output: -5,
        reasoning: -5,
      }),
    ];
    for (const [index, row] of appended.entries()) {
      insertEvent(database, row);
      rows.push(row);
      const actual = buildStoredRecordChampions({ ...options, factsKey: `facts-${index + 2}` });
      assert.deepEqual(actual, originalChampions(rows, "utc", 1, estimateRow), `append round ${index + 1}`);
    }
  });
});

test("a complete key is reused after reopen and a lower fact revision invalidates the old winner", async () => {
  await withDatabase(async ({ database, databaseFile }) => {
    for (let id = 1; id <= 3; id += 1) {
      insertEvent(
        database,
        event({
          id,
          timestamp: `2026-07-${String(9 + id).padStart(2, "0")}T01:00:00.000Z`,
          sessionId: `session-${id}`,
          model: `model-${id}`,
          total: id === 3 ? 900 : id * 100,
        }),
      );
    }
    const key = "revision-high|pricing|evidence|utc|all";
    const first = buildStoredRecordChampions({
      database,
      key,
      factsKey: "revision-high",
      zone: "utc",
      estimateRow,
    });
    assert.deepEqual(first.day.totalTokens, { period: "2026-07-12", value: 900 });

    let estimates = 0;
    const cached = buildStoredRecordChampions({
      database,
      key,
      factsKey: "revision-high",
      zone: "utc",
      estimateRow(row) {
        estimates += 1;
        return estimateRow(row);
      },
    });
    assert.deepEqual(cached, first);
    assert.equal(estimates, 0);

    const reopened = new DatabaseSync(databaseFile);
    try {
      const reopenedCached = buildStoredRecordChampions({
        database: reopened,
        key,
        factsKey: "revision-high",
        zone: "utc",
        estimateRow(row) {
          estimates += 1;
          return estimateRow(row);
        },
      });
      assert.deepEqual(reopenedCached, first);
      assert.equal(estimates, 0);

      reopened.prepare("UPDATE events SET total = 50, input = 40 WHERE id = 3").run();
      const lowerRevision = buildStoredRecordChampions({
        database: reopened,
        key: "revision-low|pricing|evidence|utc|all",
        factsKey: "revision-low",
        zone: "utc",
        estimateRow,
      });
      assert.deepEqual(lowerRevision.day.totalTokens, { period: "2026-07-11", value: 200 });
      assert.equal(readStoredRecordChampions({ database: reopened, key, factsKey: "revision-high" }), null);
    } finally {
      reopened.close();
    }
  });
});

test("builds inside a caller transaction keep the caller open and roll back as one bounded savepoint", async () => {
  await withDatabase(async ({ database }) => {
    for (let id = 1; id <= 3; id += 1) {
      insertEvent(
        database,
        event({
          id,
          timestamp: `2026-07-${String(9 + id).padStart(2, "0")}T01:00:00.000Z`,
          total: id * 100,
        }),
      );
    }
    const key = "transaction|pricing|evidence|utc|all";
    database.exec("BEGIN");
    let throwOnce = true;
    assert.throws(
      () =>
        buildStoredRecordChampions({
          database,
          key,
          factsKey: "events-1",
          zone: "utc",
          estimateRow,
          batchSize: 2,
          afterBatch() {
            if (!throwOnce) return;
            throwOnce = false;
            throw new Error("rollback candidate");
          },
        }),
      /rollback candidate/,
    );
    assert.equal(database.isTransaction, true);
    assert.equal(readStoredRecordChampions({ database, key, factsKey: "events-1" }), null);

    const champions = buildStoredRecordChampions({
      database,
      key,
      factsKey: "events-1",
      zone: "utc",
      estimateRow,
      batchSize: 2,
    });
    assert.equal(database.isTransaction, true);
    assert.deepEqual(readStoredRecordChampions({ database, key, factsKey: "events-1" }), champions);
    database.exec("ROLLBACK");
    assert.equal(readStoredRecordChampions({ database, key, factsKey: "events-1" }), null);
    assert.deepEqual(USAGE_RECORD_TABLE_NAMES, [
      "usage_record_cache",
      "usage_record_cache_periods",
      "usage_record_cache_members",
      "usage_record_cache_append_members",
      "usage_record_cache_dirty",
      "usage_record_cache_work",
      "usage_record_cache_operations",
      "usage_record_cache_format",
    ]);
  });
});
