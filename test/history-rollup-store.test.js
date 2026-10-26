import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { listDirtyUsageRollupDays, rebuildUsageRollups } from "../src/usage-rollups.js";
import { UsageStore } from "../src/usage-store.js";

const LOCAL_ROLLUP_ZONE_META = "usage_rollup_local_zone_identity";
const COMPARISON_PERIOD_KEYS = ["today", "week", "month", "all"];
const RANGE = {
  preset: "custom",
  calendarZone: "utc",
  start: new Date(Date.UTC(2026, 6, 12)),
  end: new Date(Date.UTC(2026, 6, 14) - 1),
};
const DEFAULT_EVENTS = [
  projectEvent("2026-07-12T02:00:00.000Z", 10, 7, 2, 3, 1),
  projectEvent("2026-07-13T02:00:00.000Z", 20, 15, 5, 5, 2),
];

function projectEvent(timestamp, total, input, cached, output, reasoning) {
  return {
    schema_version: "codex-usage.project-log.v1",
    timestamp,
    source: "test",
    channel: "Test",
    project_root: "/work/rollup",
    cwd: "/work/rollup",
    session_id: "rollup-session",
    model: "gpt-6-sol",
    usage: { total, input, cached, output, reasoning },
  };
}

async function createStore(events = DEFAULT_EVENTS, { sync = true } = {}) {
  const homeDir = await mkdtemp(path.join(tmpdir(), "history-rollup-store-"));
  const projectRoot = path.join(homeDir, "log-project");
  const usageFile = path.join(projectRoot, ".codex-usage", "usage.jsonl");
  await mkdir(path.dirname(usageFile), { recursive: true });
  await writeFile(usageFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const store = new UsageStore({
    homeDir,
    databaseFile: path.join(homeDir, "usage-index.sqlite"),
    importDirs: [projectRoot],
  });
  if (sync) await store.sync();
  return { homeDir, store, usageFile, projectRoot };
}

async function createMultiHomeStore(eventsByRoot, { sync = true } = {}) {
  const homeDir = await mkdtemp(path.join(tmpdir(), "history-rollup-multi-home-"));
  const projectRoots = eventsByRoot.map((_, index) => path.join(homeDir, `log-${index}`));
  for (const [index, projectRoot] of projectRoots.entries()) {
    const usageFile = path.join(projectRoot, ".codex-usage", "usage.jsonl");
    await mkdir(path.dirname(usageFile), { recursive: true });
    await writeFile(usageFile, `${eventsByRoot[index].map((event) => JSON.stringify(event)).join("\n")}\n`);
  }
  const store = new UsageStore({
    homeDir,
    databaseFile: path.join(homeDir, "usage-index.sqlite"),
    importDirs: projectRoots,
  });
  if (sync) await store.sync();
  return { homeDir, projectRoots, store };
}

function aggregateValues(row) {
  return Object.fromEntries(
    ["event_count", "session_count", "home_count", "total", "input", "cached", "output", "reasoning"].map((key) => [
      key,
      Number(row[key]),
    ]),
  );
}

function periodRanges(start, end, calendarZone = "utc") {
  return Object.fromEntries(COMPARISON_PERIOD_KEYS.map((key) => [key, { preset: key, calendarZone, start, end }]));
}

function localDayRange(day) {
  const [year, month, date] = day.split("-").map(Number);
  const next = new Date(year, month - 1, date + 1);
  return {
    preset: "custom",
    calendarZone: "local",
    start: new Date(year, month - 1, date),
    end: new Date(next.getTime() - 1),
  };
}

function localDayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function currentLocalRollupZoneIdentity() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || `offset:${new Date().getTimezoneOffset()}`;
}

function utcDayRange(day) {
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return {
    preset: "custom",
    calendarZone: "utc",
    start: new Date(start),
    end: new Date(start + 86_400_000 - 1),
  };
}

function runZoneReopenPhase(tz, phase, homeDir, projectRoot) {
  const env = {
    ...process.env,
    TZ: tz,
    ROLLUP_ZONE_PHASE: phase,
    ROLLUP_ZONE_HOME_DIR: homeDir,
    ROLLUP_ZONE_PROJECT_ROOT: projectRoot,
  };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(
    process.execPath,
    [
      "--test",
      "--test-concurrency=1",
      "--test-name-pattern=zone reopen subprocess phase",
      path.join(import.meta.dirname, "history-rollup-store.test.js"),
    ],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env,
    },
  );
}

function rollupZoneSnapshot(store, zone) {
  const read = (table, order) =>
    store.database.prepare(`SELECT * FROM ${table} WHERE calendar_zone = ? ORDER BY ${order}`).all(zone);
  return JSON.stringify({
    days: read("usage_rollup_days", "day_key"),
    daily: read("usage_rollup_daily", "day_key, home_id"),
    sessions: read("usage_rollup_sessions", "day_key, home_id"),
  });
}

function guardedAggregateValues(store, range) {
  const guard = guardAggregateQueries(store);
  try {
    return { values: aggregateValues(store.aggregateRange(range)), counts: guard.counts };
  } finally {
    guard.restore();
  }
}

test("zone reopen subprocess phase", { skip: !process.env.ROLLUP_ZONE_PHASE }, async () => {
  const store = new UsageStore({
    homeDir: process.env.ROLLUP_ZONE_HOME_DIR,
    databaseFile: path.join(process.env.ROLLUP_ZONE_HOME_DIR, "usage-index.sqlite"),
    importDirs: [process.env.ROLLUP_ZONE_PROJECT_ROOT],
  });
  try {
    await store.open();
    const phase = process.env.ROLLUP_ZONE_PHASE;
    const markerSql =
      "SELECT start_ms, end_ms FROM usage_rollup_days WHERE calendar_zone = 'local' AND day_key = '2026-07-13'";
    if (phase === "seed") {
      const result = await store.sync();
      assert.equal(result.updatedFileCount, 1);
      assert.equal(store.readMetaRaw(LOCAL_ROLLUP_ZONE_META), "Asia/Shanghai");
      const marker = store.database.prepare(markerSql).get();
      assert.equal(Number(marker.start_ms), Date.UTC(2026, 6, 12, 16));
      assert.equal(Number(marker.end_ms), Date.UTC(2026, 6, 13, 16));
      return;
    }

    assert.equal(phase, "utc");
    const markerBefore = store.database.prepare(markerSql).get();
    assert.equal(Number(markerBefore.start_ms), Date.UTC(2026, 6, 12, 16));
    assert.notEqual(Number(markerBefore.start_ms), new Date(2026, 6, 13).getTime());

    const utcBefore = rollupZoneSnapshot(store, "utc");

    const originalPrepare = store.database.prepare;
    const counts = { rebuildStatements: 0, eventDayScans: 0 };
    store.database.prepare = function guardedPrepare(sql) {
      const text = String(sql);
      if (text.includes("INSERT INTO usage_rollup_daily")) counts.rebuildStatements += 1;
      if (text.includes("SELECT DISTINCT date(timestamp_ms / 1000.0, 'unixepoch') AS day_key FROM events")) {
        counts.eventDayScans += 1;
      }
      return originalPrepare.call(this, sql);
    };
    let result;
    try {
      result = await store.sync();
    } finally {
      store.database.prepare = originalPrepare;
    }

    assert.equal(result.updatedFileCount, 0);
    assert.equal(store.readMetaRaw(LOCAL_ROLLUP_ZONE_META), currentLocalRollupZoneIdentity());
    assert.equal(counts.rebuildStatements, 1, "only the local projection may rebuild");
    assert.equal(counts.eventDayScans, 1, "event days are scanned once on zone change");
    assert.equal(rollupZoneSnapshot(store, "utc"), utcBefore, "the UTC rollup cache must remain unchanged");

    const markerAfter = store.database.prepare(markerSql).get();
    assert.equal(Number(markerAfter.start_ms), Date.UTC(2026, 6, 13));
    assert.equal(Number(markerAfter.end_ms), Date.UTC(2026, 6, 14));
    for (const [day, total] of [
      ["2026-07-12", 10],
      ["2026-07-13", 0],
    ]) {
      const guard = guardAggregateQueries(store);
      let values;
      try {
        values = aggregateValues(store.aggregateRange(localDayRange(day)));
      } finally {
        guard.restore();
      }
      assert.equal(values.total, total);
      assert.ok(guard.counts.rollupQueries > 0, `${day} must use the rebuilt local rollup`);
      assert.equal(guard.counts.fallbackQueries, 0, `${day} must not fall back to event SQL`);
    }
  } finally {
    store.close();
  }
});

function guardAggregateQueries(store) {
  const originalPrepare = store.database.prepare;
  const counts = {
    rollupDayChecks: 0,
    rollupQueries: 0,
    rollupModelQueries: 0,
    fallbackQueries: 0,
    periodAggregateQueries: 0,
    modelPeriodAggregateQueries: 0,
    costEventQueries: 0,
  };
  store.database.prepare = function guardedPrepare(sql) {
    const text = String(sql);
    if (text.includes("FROM usage_rollup_days")) counts.rollupDayChecks += 1;
    if (text.includes("FROM usage_rollup_daily")) counts.rollupQueries += 1;
    if (text.includes("FROM usage_rollup_models")) counts.rollupModelQueries += 1;
    if (text.includes("FROM events") && text.includes("COUNT(*) AS event_count")) counts.fallbackQueries += 1;
    if (text.includes("FROM events") && text.includes('AS "all__total"')) {
      counts.periodAggregateQueries += 1;
      if (text.includes("model AS dimension_key")) counts.modelPeriodAggregateQueries += 1;
    }
    if (text.includes("FROM events") && text.includes("price_version")) counts.costEventQueries += 1;
    return originalPrepare.call(this, sql);
  };
  return {
    counts,
    restore() {
      store.database.prepare = originalPrepare;
    },
  };
}

function rollupDayRows(store) {
  return store.database
    .prepare("SELECT calendar_zone, day_key FROM usage_rollup_days ORDER BY calendar_zone, day_key")
    .all();
}

function rebuildRollupDays(store, rows) {
  for (const zone of ["utc", "local"]) {
    const days = rows.filter((row) => row.calendar_zone === zone).map((row) => String(row.day_key));
    if (days.length > 0) rebuildUsageRollups(store.database, { days, calendarZone: zone });
  }
}

function sourceSqlPeriodAggregate(store, ranges, excludeHomes = []) {
  const rows = rollupDayRows(store);
  store.database.exec("DELETE FROM usage_rollup_days");
  try {
    return store.periodAggregate("model", "model", new Date("2026-07-13T12:00:00.000Z"), ranges, {
      excludeHomes,
    });
  } finally {
    rebuildRollupDays(store, rows);
  }
}

function sourceSqlPeriodComparison(store, options) {
  const rows = rollupDayRows(store);
  store.periodComparisonCache.clear();
  store.database.exec("DELETE FROM usage_rollup_days");
  try {
    return store.periodComparison(options);
  } finally {
    rebuildRollupDays(store, rows);
    store.periodComparisonCache.clear();
  }
}

test("complete UTC day range selects rollups and matches the SQL aggregate", async () => {
  const { homeDir, store } = await createStore();
  try {
    const expected = aggregateValues(store.aggregateRange(RANGE));
    rebuildUsageRollups(store.database, { days: ["2026-07-12", "2026-07-13"] });
    const guard = guardAggregateQueries(store);
    let actual;
    try {
      actual = aggregateValues(store.aggregateRange(RANGE));
    } finally {
      guard.restore();
    }

    assert.deepEqual(actual, expected);
    assert.ok(guard.counts.rollupQueries > 0, "rollup query must be selected");
    assert.equal(guard.counts.fallbackQueries, 0, "event SQL must not run when rollups are complete");
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("periodAggregate routes only the exact model dimension through model rollups", async () => {
  const { homeDir, store } = await createStore([
    ...DEFAULT_EVENTS,
    projectEvent("2026-07-13T23:59:59.999Z", 1, 1, 0, 0, 0),
  ]);
  const ranges = periodRanges(RANGE.start, RANGE.end);
  try {
    const exact = guardAggregateQueries(store);
    try {
      store.periodAggregate("model", "model", new Date(RANGE.start), ranges);
    } finally {
      exact.restore();
    }
    assert.ok(exact.counts.rollupModelQueries > 0, "the exact model branch must read model rollups");
    assert.equal(
      exact.counts.periodAggregateQueries,
      0,
      "the exact model branch must not use original model period aggregate SQL",
    );

    for (const [groupColumn, nameColumn, options] of [
      ["repository_key", "repository_path", { includeKind: true }],
      ["model", "model", { includeKind: true }],
    ]) {
      const guard = guardAggregateQueries(store);
      try {
        store.periodAggregate(groupColumn, nameColumn, new Date(RANGE.start), ranges, options);
      } finally {
        guard.restore();
      }
      assert.equal(guard.counts.rollupModelQueries, 0);
      assert.equal(guard.counts.periodAggregateQueries, 1);
    }
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("model periodAggregate matches source SQL across partial, local, excluded, and empty windows", async () => {
  const base = {
    schema_version: "codex-usage.project-log.v1",
    source: "test",
    channel: "Test",
    project_root: "/work/model-period",
    cwd: "/work/model-period",
  };
  const modelEvent = (timestamp, model, session_id, usage) => ({
    ...base,
    timestamp,
    model,
    session_id,
    usage,
  });
  const { homeDir, projectRoots, store } = await createMultiHomeStore([
    [
      modelEvent("2026-07-12T02:00:00.000Z", "gpt-6-sol", "a-sol", {
        total: 100,
        input: 80,
        cached: 20,
        output: 20,
        reasoning: 5,
      }),
      modelEvent("2026-07-13T00:00:00.000Z", "gpt-6-luna", "a-luna", {
        total: 30,
        input: 12,
        cached: 4,
      }),
    ],
    [
      modelEvent("2026-07-13T12:00:00.000Z", "gpt-6-sol", "b-sol", {
        total: 40,
        input: 20,
        cached: 10,
        output: 20,
        reasoning: 5,
      }),
      modelEvent("2026-07-13T23:59:59.999Z", "gpt-6-luna", "b-luna", {
        total: 20,
        output: 5,
      }),
      modelEvent("2026-07-14T00:00:00.000Z", "gpt-6-sol", "b-sol-next", { total: 10, input: 5 }),
      modelEvent("2026-07-14T01:00:00.000Z", "gpt-outside", "b-outside", { total: 25, input: 15 }),
    ],
  ]);
  const start = new Date(Date.UTC(2026, 6, 12));
  const end = new Date(Date.UTC(2026, 6, 14) - 1);
  const excludedHomeId = store.homes.find((home) => home.path === projectRoots[0]).id;
  const local = localDayRange("2026-07-13");
  try {
    const cases = [
      { ranges: periodRanges(start, end), excludeHomes: [] },
      { ranges: periodRanges(new Date(start.getTime() + 1), end), excludeHomes: [] },
      { ranges: periodRanges(start, new Date(Date.UTC(2026, 6, 14))), excludeHomes: [] },
      { ranges: periodRanges(local.start, local.end, "local"), excludeHomes: [] },
      { ranges: periodRanges(start, end), excludeHomes: [excludedHomeId] },
      { ranges: periodRanges(null, null), excludeHomes: [] },
      {
        ranges: periodRanges(new Date(Date.UTC(2026, 6, 12, 5)), new Date(Date.UTC(2026, 6, 12, 5))),
        excludeHomes: [],
      },
    ];
    const expected = cases.map(({ ranges, excludeHomes }) => sourceSqlPeriodAggregate(store, ranges, excludeHomes));
    const actual = cases.map(({ ranges, excludeHomes }) => {
      const guard = guardAggregateQueries(store);
      try {
        return {
          rows: store.periodAggregate("model", "model", new Date("2026-07-13T12:00:00.000Z"), ranges, {
            excludeHomes,
          }),
          counts: guard.counts,
        };
      } finally {
        guard.restore();
      }
    });

    assert.deepEqual(
      actual.map(({ rows }) => rows),
      expected,
    );
    for (const item of actual) {
      assert.equal(
        item.counts.periodAggregateQueries,
        0,
        "the model branch must not use original period aggregate SQL",
      );
    }
    assert.ok(actual[0].counts.rollupModelQueries > 0, "a fact-covered complete day must read model rollups");
    assert.equal(actual[0].rows.find((row) => row.name === "gpt-outside").periods.all.total, 0);
    assert.deepEqual(
      actual[0].rows.map((row) => [row.name, row.periods.all.total]),
      [
        ["gpt-6-sol", 140],
        ["gpt-6-luna", 50],
        ["gpt-outside", 0],
      ],
    );
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("missing model rollup days fall back to SQL while other model errors propagate", async () => {
  const { homeDir, store } = await createStore([
    ...DEFAULT_EVENTS,
    projectEvent("2026-07-13T23:59:59.999Z", 1, 1, 0, 0, 0),
  ]);
  const ranges = periodRanges(RANGE.start, RANGE.end);
  try {
    const completeRows = rollupDayRows(store);
    const expected = store.periodAggregate("model", "model", new Date(RANGE.start), ranges);
    store.database
      .prepare("DELETE FROM usage_rollup_days WHERE calendar_zone = 'utc' AND day_key = '2026-07-13'")
      .run();
    const guard = guardAggregateQueries(store);
    let fallback;
    try {
      fallback = store.periodAggregate("model", "model", new Date(RANGE.start), ranges);
    } finally {
      guard.restore();
    }
    assert.deepEqual(fallback, expected);
    assert.equal(guard.counts.periodAggregateQueries, 1, "only ROLLUP_DAYS_MISSING may fall back");
    rebuildRollupDays(store, completeRows);

    store.database.exec("SAVEPOINT broken_model_rollup_contract");
    store.database.exec("ALTER TABLE usage_rollup_days RENAME COLUMN start_ms TO broken_start_ms");
    try {
      assert.throws(
        () => store.periodAggregate("model", "model", new Date(RANGE.start), ranges),
        /no such column: start_ms/,
      );
    } finally {
      store.database.exec("ROLLBACK TO broken_model_rollup_contract");
      store.database.exec("RELEASE broken_model_rollup_contract");
    }
    assert.deepEqual(
      store.periodAggregate("model", "model", new Date(RANGE.start), ranges),
      expected,
      "the failed read must leave the rollup contract usable",
    );
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("real periodComparison uses model rollups for distinct period windows", async () => {
  const base = {
    schema_version: "codex-usage.project-log.v1",
    source: "test",
    channel: "Test",
    project_root: "/work/public-model-read",
    cwd: "/work/public-model-read",
  };
  const modelEvent = (timestamp, model, session_id, total) => ({
    ...base,
    timestamp,
    model,
    session_id,
    usage: { total, input: total, output: 0 },
  });
  const { homeDir, projectRoots, store } = await createMultiHomeStore([
    [
      modelEvent("2026-07-12T02:00:00.000Z", "gpt-6-sol", "public-a-sol", 100),
      modelEvent("2026-07-14T02:00:00.000Z", "gpt-6-luna", "public-a-luna", 30),
    ],
    [modelEvent("2026-07-13T02:00:00.000Z", "gpt-6-sol", "public-b-sol", 20)],
  ]);
  const options = { now: "2026-07-15T12:00:00.000Z", calendarZone: "utc" };
  const excludedHomeId = store.homes.find((home) => home.path === projectRoots[0]).id;
  try {
    const expected = sourceSqlPeriodComparison(store, options);
    const expectedExcluded = sourceSqlPeriodComparison(store, {
      ...options,
      excludeHomes: [excludedHomeId],
    });

    const guard = guardAggregateQueries(store);
    let actual;
    try {
      actual = store.periodComparison(options);
    } finally {
      guard.restore();
    }
    assert.deepEqual(actual, expected);
    assert.deepEqual(store.periodComparison({ ...options, excludeHomes: [excludedHomeId] }), expectedExcluded);
    assert.deepEqual(
      actual.models.map((row) => [row.name, row.periods.all.total]),
      [
        ["gpt-6-sol", 120],
        ["gpt-6-luna", 30],
      ],
    );
    assert.deepEqual(
      actual.models.map((row) => [row.name, row.periods.today.total]),
      [
        ["gpt-6-sol", 0],
        ["gpt-6-luna", 0],
      ],
    );
    assert.equal(guard.counts.rollupModelQueries, 3, "the disjoint today window must not query model rollups");
    const diagnosis = {
      windows: actual.periods,
      utcRollupDays: store.database
        .prepare("SELECT day_key FROM usage_rollup_days WHERE calendar_zone = 'utc' ORDER BY day_key")
        .all()
        .map((row) => row.day_key),
      counts: guard.counts,
    };
    assert.equal(guard.counts.modelPeriodAggregateQueries, 0, JSON.stringify(diagnosis));
    assert.ok(guard.counts.rollupModelQueries > 0, JSON.stringify(diagnosis));
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("public summarize uses complete UTC rollups and matches the full SQL summary with excludeHomes", async () => {
  const { homeDir, store } = await createStore();
  const filters = {
    preset: "custom",
    startDate: "2026-07-12",
    endDate: "2026-07-13",
    calendarZone: "utc",
    now: "2026-10-22T00:00:00.000Z",
  };
  const invalidateDays = () =>
    store.database
      .prepare("DELETE FROM usage_rollup_days WHERE calendar_zone = 'utc' AND day_key IN ('2026-07-12', '2026-07-13')")
      .run();
  try {
    rebuildUsageRollups(store.database, { days: ["2026-07-12", "2026-07-13"] });
    const guardedSummary = (summaryFilters) => {
      const guard = guardAggregateQueries(store);
      try {
        return { summary: store.summarize(summaryFilters), counts: guard.counts };
      } finally {
        guard.restore();
      }
    };

    const rollup = guardedSummary(filters);
    assert.ok(rollup.counts.rollupQueries > 0, "public summarize must select the rollup aggregate");
    assert.equal(rollup.counts.fallbackQueries, 1, "only previousUsageRange must remain on event SQL");
    assert.ok(rollup.counts.costEventQueries > 0, "cost estimation must still read events");

    invalidateDays();
    const sql = store.summarize(filters);
    assert.deepEqual(rollup.summary, sql);

    rebuildUsageRollups(store.database, { days: ["2026-07-12", "2026-07-13"] });
    const excludedFilters = { ...filters, excludeHomes: [store.homes[0].id] };
    const excludedRollup = guardedSummary(excludedFilters);
    assert.ok(excludedRollup.counts.rollupQueries > 0, "excludeHomes must still select the rollup aggregate");
    assert.equal(excludedRollup.counts.fallbackQueries, 1, "previousUsageRange remains on event SQL with exclusions");
    assert.equal(excludedRollup.summary.eventCount, 0);
    assert.equal(excludedRollup.summary.totals.total, 0);

    invalidateDays();
    assert.deepEqual(excludedRollup.summary, store.summarize(excludedFilters));
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("local DST rollups under America/New_York", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-concurrency=1",
      "--test-name-pattern=local DST rollup selection",
      path.join(import.meta.dirname, "history-rollup-store.test.js"),
    ],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: { ...process.env, TZ: "America/New_York" },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("local DST rollup selection uses 23h and 25h local days", {
  skip: process.env.TZ !== "America/New_York",
}, async () => {
  const events = [
    projectEvent("2026-03-08T12:00:00.000Z", 10, 7, 2, 3, 1),
    projectEvent("2026-11-01T12:00:00.000Z", 20, 15, 5, 5, 2),
  ];
  const { homeDir, store } = await createStore(events);
  const cases = [
    { day: "2026-03-08", hours: 23 },
    { day: "2026-11-01", hours: 25 },
  ];
  const invalidateDay = (day) =>
    store.database.prepare("DELETE FROM usage_rollup_days WHERE calendar_zone = 'local' AND day_key = ?").run(day);
  const guardedAggregate = (range) => {
    const guard = guardAggregateQueries(store);
    try {
      return { row: store.aggregateRange(range), counts: guard.counts };
    } finally {
      guard.restore();
    }
  };
  try {
    for (const item of cases) {
      const filters = {
        preset: "custom",
        startDate: item.day,
        endDate: item.day,
        calendarZone: "local",
        now: "2026-10-22T00:00:00.000Z",
      };
      rebuildUsageRollups(store.database, { days: [item.day], calendarZone: "local" });

      const guard = guardAggregateQueries(store);
      let rollupSummary;
      try {
        rollupSummary = store.summarize(filters);
      } finally {
        guard.restore();
      }
      assert.ok(guard.counts.rollupQueries > 0, `${item.day} must select the local rollup`);
      assert.equal(
        Date.parse(rollupSummary.range.end) - Date.parse(rollupSummary.range.start) + 1,
        item.hours * 3_600_000,
      );

      invalidateDay(item.day);
      const sqlSummary = store.summarize(filters);
      assert.deepEqual(rollupSummary, sqlSummary);

      rebuildUsageRollups(store.database, { days: [item.day], calendarZone: "local" });
      const range = {
        ...RANGE,
        calendarZone: "local",
        start: new Date(sqlSummary.range.start),
        end: new Date(sqlSummary.range.end),
      };
      for (const partial of [
        { ...range, start: new Date(range.start.getTime() + 1) },
        { ...range, end: new Date(range.end.getTime() + 1) },
      ]) {
        const result = guardedAggregate(partial);
        assert.equal(result.counts.rollupQueries, 0, `${item.day} partial range must not select a rollup`);
        assert.equal(result.counts.fallbackQueries, 1, `${item.day} partial range must use event SQL`);
      }
    }
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("invalid rollup markers fall back to event SQL and other errors propagate", async () => {
  const { homeDir, store, usageFile } = await createStore();
  try {
    rebuildUsageRollups(store.database, { days: ["2026-07-12", "2026-07-13"] });
    await appendFile(usageFile, `${JSON.stringify(projectEvent("2026-07-12T03:00:00.000Z", 5, 4, 1, 1, 0))}\n`);
    await store.sync();
    const refreshed = aggregateValues(store.aggregateRange(RANGE));
    assert.equal(refreshed.event_count, 3);
    assert.equal(refreshed.total, 35);

    // The sync above repaired the trigger-invalidated day; remove its marker to exercise the SQL fallback.
    store.database
      .prepare("DELETE FROM usage_rollup_days WHERE calendar_zone = 'utc' AND day_key = '2026-07-12'")
      .run();

    const guard = guardAggregateQueries(store);
    let actual;
    try {
      actual = aggregateValues(store.aggregateRange(RANGE));
    } finally {
      guard.restore();
    }

    assert.equal(actual.event_count, 3);
    assert.equal(actual.total, 35);
    assert.ok(guard.counts.rollupDayChecks > 0, "invalid marker must be detected through the rollup day check");
    assert.equal(guard.counts.fallbackQueries, 1, "missing rollup days must use the event SQL once");

    store.database.exec(`
      DROP TABLE usage_rollup_days;
      CREATE TABLE usage_rollup_days (
        calendar_zone TEXT NOT NULL,
        day_key TEXT NOT NULL,
        PRIMARY KEY (calendar_zone, day_key)
      ) STRICT;
    `);
    assert.throws(() => store.aggregateRange(RANGE), /no such column: start_ms/);
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("partial UTC day ranges keep the event SQL path", async () => {
  const { homeDir, store } = await createStore();
  try {
    rebuildUsageRollups(store.database, { days: ["2026-07-12", "2026-07-13"] });
    const partialRange = {
      ...RANGE,
      end: new Date(Date.UTC(2026, 6, 13, 12) - 1),
    };
    const guard = guardAggregateQueries(store);
    let actual;
    try {
      actual = aggregateValues(store.aggregateRange(partialRange));
    } finally {
      guard.restore();
    }

    assert.equal(actual.event_count, 2);
    assert.equal(actual.total, 30);
    assert.equal(guard.counts.rollupQueries, 0, "partial day must not query rollups");
    assert.equal(guard.counts.fallbackQueries, 1, "partial day must keep the existing event SQL");
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("first sync builds complete UTC rollup days", async () => {
  const { homeDir, store } = await createStore(DEFAULT_EVENTS, { sync: false });
  try {
    const result = await store.sync();
    assert.equal(result.updatedFileCount, 1);
    const rows = store.database
      .prepare(`
        SELECT d.day_key, d.start_ms, d.end_ms, r.event_count, r.total
        FROM usage_rollup_days d
        LEFT JOIN usage_rollup_daily r
          ON r.calendar_zone = d.calendar_zone AND r.day_key = d.day_key
        WHERE d.calendar_zone = 'utc' AND d.day_key IN ('2026-07-12', '2026-07-13')
        ORDER BY d.day_key
      `)
      .all()
      .map((row) =>
        Object.fromEntries([
          ["day_key", String(row.day_key)],
          ["start_ms", Number(row.start_ms)],
          ["end_ms", Number(row.end_ms)],
          ["event_count", Number(row.event_count)],
          ["total", Number(row.total)],
        ]),
      );
    assert.deepEqual(rows, [
      {
        day_key: "2026-07-12",
        start_ms: Date.UTC(2026, 6, 12),
        end_ms: Date.UTC(2026, 6, 13),
        event_count: 1,
        total: 10,
      },
      {
        day_key: "2026-07-13",
        start_ms: Date.UTC(2026, 6, 13),
        end_ms: Date.UTC(2026, 6, 14),
        event_count: 1,
        total: 20,
      },
    ]);
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("sync rebuilds the old and new UTC days after moving an event", async () => {
  const { homeDir, store, usageFile } = await createStore();
  try {
    const moved = projectEvent("2026-07-14T02:00:00.000Z", 10, 7, 2, 3, 1);
    await writeFile(usageFile, `${[moved, DEFAULT_EVENTS[1]].map((event) => JSON.stringify(event)).join("\n")}\n`);
    const result = await store.sync();
    assert.equal(result.updatedFileCount, 1);
    const rows = store.database
      .prepare(`
        SELECT d.day_key,
          COALESCE(SUM(r.event_count), 0) AS event_count,
          COALESCE(SUM(r.total), 0) AS total
        FROM usage_rollup_days d
        LEFT JOIN usage_rollup_daily r
          ON r.calendar_zone = d.calendar_zone AND r.day_key = d.day_key
        WHERE d.calendar_zone = 'utc' AND d.day_key IN ('2026-07-12', '2026-07-13', '2026-07-14')
        GROUP BY d.day_key
        ORDER BY d.day_key
      `)
      .all()
      .map((row) => ({ ...row, event_count: Number(row.event_count), total: Number(row.total) }));
    assert.deepEqual(rows, [
      { day_key: "2026-07-12", event_count: 0, total: 0 },
      { day_key: "2026-07-13", event_count: 1, total: 20 },
      { day_key: "2026-07-14", event_count: 1, total: 10 },
    ]);
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("no-op sync lists dirty days without rebuilding rollups", async () => {
  const { homeDir, store } = await createStore();
  const originalPrepare = store.database.prepare;
  const counts = { dirtyLists: 0, rebuildStatements: 0, eventDayScans: 0 };
  store.database.prepare = function guardedPrepare(sql) {
    const text = String(sql);
    if (text.includes("FROM usage_rollup_dirty_days")) counts.dirtyLists += 1;
    if (text.includes("INSERT INTO usage_rollup_daily")) counts.rebuildStatements += 1;
    if (text.includes("SELECT DISTINCT date(timestamp_ms / 1000.0, 'unixepoch') AS day_key FROM events")) {
      counts.eventDayScans += 1;
    }
    return originalPrepare.call(this, sql);
  };
  try {
    let result;
    try {
      result = await store.sync();
    } finally {
      store.database.prepare = originalPrepare;
    }
    assert.equal(result.updatedFileCount, 0);
    assert.equal(counts.dirtyLists, 1);
    assert.equal(counts.rebuildStatements, 0);
    assert.equal(counts.eventDayScans, 0);
    assert.equal(store.readMetaRaw(LOCAL_ROLLUP_ZONE_META), currentLocalRollupZoneIdentity());
  } finally {
    store.database.prepare = originalPrepare;
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("cross-zone reopen rebuilds stale local rollups without rebuilding UTC", async () => {
  const { homeDir, store, projectRoot } = await createStore(
    [projectEvent("2026-07-12T23:30:00.000Z", 10, 7, 2, 3, 1)],
    { sync: false },
  );
  store.close();
  try {
    const seed = runZoneReopenPhase("Asia/Shanghai", "seed", homeDir, projectRoot);
    assert.equal(seed.status, 0, seed.stderr || seed.stdout);
    const reopen = runZoneReopenPhase("UTC", "utc", homeDir, projectRoot);
    assert.equal(reopen.status, 0, reopen.stderr || reopen.stdout);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("rollup rebuild failure leaves fact caches invalidated", async () => {
  const { homeDir, store, usageFile } = await createStore();
  try {
    assert.equal(store.metadata().eventCount, 2);
    await appendFile(usageFile, `${JSON.stringify(projectEvent("2026-07-12T03:00:00.000Z", 5, 4, 1, 1, 0))}\n`);
    store.database.exec(`
      CREATE TRIGGER fail_rollup_rebuild
      BEFORE INSERT ON usage_rollup_daily
      BEGIN
        SELECT RAISE(ABORT, 'rollup rebuild failed');
      END;
    `);
    try {
      await assert.rejects(store.sync(), /rollup rebuild failed/);
    } finally {
      store.database.exec("DROP TRIGGER fail_rollup_rebuild");
    }

    assert.equal(store.metadataCache, null);
    assert.equal(store.derivedRevision, store.storeRevision);
    assert.equal(store.metadata().eventCount, 3);
    const retry = await store.sync();
    assert.equal(retry.updatedFileCount, 0);
    assert.equal(store.aggregateRange(RANGE).event_count, 3);
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("zone identity failure stays stale and retries as a local-only no-op", async () => {
  const event = projectEvent("2026-07-12T12:00:00.000Z", 10, 7, 2, 3, 1);
  const day = localDayKey(new Date(event.timestamp));
  const { homeDir, store } = await createStore([event]);
  try {
    const before = rollupZoneSnapshot(store, "local");
    store.writeMeta(LOCAL_ROLLUP_ZONE_META, "stale/zone");
    store.database.exec(`
      CREATE TRIGGER fail_local_zone_identity
      BEFORE INSERT ON usage_rollup_daily
      WHEN NEW.calendar_zone = 'local'
      BEGIN
        SELECT RAISE(ABORT, 'local zone identity failed');
      END;
    `);
    try {
      await assert.rejects(store.sync(), /local zone identity failed/);
    } finally {
      store.database.exec("DROP TRIGGER fail_local_zone_identity");
    }

    assert.equal(store.readMetaRaw(LOCAL_ROLLUP_ZONE_META), "stale/zone");
    assert.equal(rollupZoneSnapshot(store, "local"), before, "failed identity maintenance must fully roll back");
    assert.deepEqual(listDirtyUsageRollupDays(store.database), []);

    const originalPrepare = store.database.prepare;
    const counts = { rebuildStatements: 0 };
    store.database.prepare = function guardedPrepare(sql) {
      if (String(sql).includes("INSERT INTO usage_rollup_daily")) counts.rebuildStatements += 1;
      return originalPrepare.call(this, sql);
    };
    let retry;
    try {
      retry = await store.sync();
    } finally {
      store.database.prepare = originalPrepare;
    }

    assert.equal(retry.updatedFileCount, 0);
    assert.equal(counts.rebuildStatements, 1);
    assert.equal(store.readMetaRaw(LOCAL_ROLLUP_ZONE_META), currentLocalRollupZoneIdentity());
    const aggregate = guardedAggregateValues(store, localDayRange(day));
    assert.equal(aggregate.values.total, 10);
    assert.ok(aggregate.counts.rollupQueries > 0);
    assert.equal(aggregate.counts.fallbackQueries, 0);
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("Shanghai local rollup sync builds and moves local days", {
  skip: process.env.TZ !== "Asia/Shanghai",
}, async () => {
  const events = [
    projectEvent("2026-07-12T23:30:00.000Z", 10, 7, 2, 3, 1),
    projectEvent("2026-07-13T23:30:00.000Z", 20, 15, 5, 5, 2),
  ];
  const { homeDir, store, usageFile } = await createStore(events, { sync: false });
  try {
    await store.sync();
    for (const [day, total] of [
      ["2026-07-13", 10],
      ["2026-07-14", 20],
    ]) {
      const result = guardedAggregateValues(store, localDayRange(day));
      assert.equal(result.values.event_count, 1);
      assert.equal(result.values.total, total);
      assert.ok(result.counts.rollupQueries > 0, `${day} must read the local rollup`);
      assert.equal(result.counts.fallbackQueries, 0, `${day} must not fall back to event SQL`);
    }

    const moved = projectEvent("2026-07-14T23:30:00.000Z", 10, 7, 2, 3, 1);
    await writeFile(usageFile, `${[moved, events[1]].map((event) => JSON.stringify(event)).join("\n")}\n`);
    const result = await store.sync();
    assert.equal(result.updatedFileCount, 1);
    for (const [day, eventCount, total] of [
      ["2026-07-13", 0, 0],
      ["2026-07-14", 1, 20],
      ["2026-07-15", 1, 10],
    ]) {
      const aggregate = guardedAggregateValues(store, localDayRange(day));
      assert.equal(aggregate.values.event_count, eventCount);
      assert.equal(aggregate.values.total, total);
      assert.ok(aggregate.counts.rollupQueries > 0, `${day} must read the rebuilt local rollup`);
      assert.equal(aggregate.counts.fallbackQueries, 0, `${day} must not fall back to event SQL`);
    }
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("Shanghai local rollup sync rolls back both zones after local rebuild failure", {
  skip: process.env.TZ !== "Asia/Shanghai",
}, async () => {
  const events = [
    projectEvent("2026-07-12T23:30:00.000Z", 10, 7, 2, 3, 1),
    projectEvent("2026-07-13T23:30:00.000Z", 20, 15, 5, 5, 2),
  ];
  const { homeDir, store, usageFile } = await createStore(events, { sync: false });
  try {
    await store.sync();
    const before = guardedAggregateValues(store, localDayRange("2026-07-13"));
    assert.equal(before.values.total, 10);

    const changed = projectEvent("2026-07-12T23:30:00.000Z", 50, 7, 2, 3, 1);
    await writeFile(usageFile, `${[changed, events[1]].map((event) => JSON.stringify(event)).join("\n")}\n`);
    store.database.exec(`
        CREATE TRIGGER fail_local_rollup
        BEFORE INSERT ON usage_rollup_daily
        WHEN NEW.calendar_zone = 'local'
        BEGIN
          SELECT RAISE(ABORT, 'local rollup failed');
        END;
      `);
    try {
      await assert.rejects(store.sync(), /local rollup failed/);
    } finally {
      store.database.exec("DROP TRIGGER fail_local_rollup");
    }

    const dirty = listDirtyUsageRollupDays(store.database);
    assert.ok(dirty.includes("2026-07-12"));
    assert.ok(dirty.includes("2026-07-13"));
    assert.equal(store.metadataCache, null);
    const markers = store.database
      .prepare(`
          SELECT COUNT(*) AS count FROM usage_rollup_days
          WHERE (calendar_zone = 'utc' AND day_key = '2026-07-12')
             OR (calendar_zone = 'local' AND day_key = '2026-07-13')
        `)
      .get();
    assert.equal(Number(markers.count), 0, "both zone markers must roll back");
    const rolledBack = store.database
      .prepare(`
          SELECT calendar_zone, day_key, total FROM usage_rollup_daily
          WHERE (calendar_zone = 'utc' AND day_key = '2026-07-12')
             OR (calendar_zone = 'local' AND day_key = '2026-07-13')
          ORDER BY calendar_zone, day_key
        `)
      .all()
      .map((row) => ({ calendar_zone: row.calendar_zone, day_key: row.day_key, total: Number(row.total) }));
    assert.deepEqual(rolledBack, [
      { calendar_zone: "local", day_key: "2026-07-13", total: 10 },
      { calendar_zone: "utc", day_key: "2026-07-12", total: 10 },
    ]);

    const retry = await store.sync();
    assert.equal(retry.updatedFileCount, 0);
    assert.deepEqual(listDirtyUsageRollupDays(store.database), []);
    const utc = guardedAggregateValues(store, utcDayRange("2026-07-12"));
    assert.equal(utc.values.total, 50);
    assert.ok(utc.counts.rollupQueries > 0);
    const local = guardedAggregateValues(store, localDayRange("2026-07-13"));
    assert.equal(local.values.total, 50);
    assert.ok(local.counts.rollupQueries > 0);
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("Asia/Shanghai local rollup subprocess", () => {
  const env = { ...process.env, TZ: "Asia/Shanghai" };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-concurrency=1",
      "--test-name-pattern=Shanghai local rollup sync",
      path.join(import.meta.dirname, "history-rollup-store.test.js"),
    ],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /tests 2[\s\S]*pass 2/);
});
