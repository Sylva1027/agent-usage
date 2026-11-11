import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createUsageRollups,
  listDirtyUsageRollupDays,
  queryUsageRollupRepositoriesWindow,
  rebuildUsageRollups,
  rebuildUsageRollupsFromEvents,
} from "../src/usage-rollups.js";
import { UsageStore } from "../src/usage-store.js";

const REPOSITORY_COLUMNS = `
  cwd TEXT NOT NULL DEFAULT '',
  repository_key TEXT NOT NULL DEFAULT 'unknown:cwd',
  repository_path TEXT NOT NULL DEFAULT 'Unknown cwd',
  repository_kind TEXT NOT NULL DEFAULT 'unknown'
`;

function openDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), "usage-repository-rollups-"));
  const db = new DatabaseSync(path.join(directory, "index.sqlite"));
  db.exec(`
    CREATE TABLE events (
      timestamp_ms INTEGER NOT NULL,
      home_id TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'gpt-6-sol',
      session_id TEXT,
      ${REPOSITORY_COLUMNS},
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

function insertEvent(
  db,
  {
    timestamp,
    homeId,
    sessionId,
    cwd,
    key,
    name,
    kind,
    detailMask = 15,
    gap = 0,
    total,
    input = 0,
    cached = 0,
    output = 0,
    reasoning = 0,
  },
) {
  db.prepare(`
    INSERT INTO events (
      timestamp_ms, home_id, session_id, cwd, repository_key, repository_path, repository_kind,
      detail_mask, reconciliation_gap, total, input, cached, output, reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Date.parse(timestamp),
    homeId,
    sessionId,
    cwd,
    key,
    name,
    kind,
    detailMask,
    gap,
    total,
    input,
    cached,
    output,
    reasoning,
  );
}

function expectedRepositoryPeriods(store, periods, excludeHomes = []) {
  const homeFilter = excludeHomes.length > 0 ? `AND home_id NOT IN (${excludeHomes.map(() => "?").join(", ")})` : "";
  const expressions = [
    ["total", "COALESCE(SUM(total), 0)"],
    ["input", "COALESCE(SUM(CASE WHEN (detail_mask & 1) != 0 THEN input ELSE 0 END), 0)"],
    ["inputUnavailableTokens", "COALESCE(SUM(CASE WHEN (detail_mask & 1) = 0 THEN total ELSE 0 END), 0)"],
    ["cached", "COALESCE(SUM(CASE WHEN (detail_mask & 2) != 0 THEN cached ELSE 0 END), 0)"],
    ["cachedUnavailableTokens", "COALESCE(SUM(CASE WHEN (detail_mask & 2) = 0 THEN total ELSE 0 END), 0)"],
    ["uncachedInput", "COALESCE(SUM(CASE WHEN (detail_mask & 3) = 3 THEN MAX(input - cached, 0) ELSE 0 END), 0)"],
    ["uncachedInputUnavailableTokens", "COALESCE(SUM(CASE WHEN (detail_mask & 3) != 3 THEN total ELSE 0 END), 0)"],
    ["cacheRateInput", "COALESCE(SUM(CASE WHEN (detail_mask & 3) = 3 THEN input ELSE 0 END), 0)"],
    ["cacheRateCached", "COALESCE(SUM(CASE WHEN (detail_mask & 3) = 3 THEN cached ELSE 0 END), 0)"],
    ["output", "COALESCE(SUM(CASE WHEN (detail_mask & 4) != 0 THEN output ELSE 0 END), 0)"],
    ["outputUnavailableTokens", "COALESCE(SUM(CASE WHEN (detail_mask & 4) = 0 THEN total ELSE 0 END), 0)"],
    ["reasoning", "COALESCE(SUM(CASE WHEN (detail_mask & 8) != 0 THEN reasoning ELSE 0 END), 0)"],
    ["reasoningUnavailableTokens", "COALESCE(SUM(CASE WHEN (detail_mask & 8) = 0 THEN total ELSE 0 END), 0)"],
    ["unattributedDetailTokens", "COALESCE(SUM(CASE WHEN (detail_mask & 15) != 15 THEN total ELSE 0 END), 0)"],
    ["inconsistentTokens", "COALESCE(SUM(CASE WHEN (detail_mask & 16) != 0 THEN total ELSE 0 END), 0)"],
    ["reconciliationGap", "COALESCE(SUM(reconciliation_gap), 0)"],
  ];
  const attributes = store.database
    .prepare(`
      SELECT
        repository_key AS key,
        MIN(repository_path) AS name,
        MIN(repository_kind) AS kind,
        COUNT(DISTINCT NULLIF(cwd, '')) AS path_count
      FROM events
      WHERE 1 = 1 ${homeFilter}
      GROUP BY repository_key
    `)
    .all(...excludeHomes);
  const rows = new Map(
    attributes.map((row) => [
      row.key,
      {
        key: String(row.key),
        name: String(row.name),
        kind: String(row.kind),
        pathCount: Number(row.path_count),
        periods: Object.fromEntries(
          periods.map(({ key }) => [key, Object.fromEntries(expressions.map(([field]) => [field, 0]))]),
        ),
      },
    ]),
  );
  for (const period of periods) {
    const predicates = [];
    const params = [];
    if (period.start !== null) {
      predicates.push("timestamp_ms >= ?");
      params.push(Date.parse(period.start));
    }
    if (period.end !== null) {
      predicates.push("timestamp_ms <= ?");
      params.push(Date.parse(period.end));
    }
    params.push(...excludeHomes);
    const periodRows = store.database
      .prepare(`
        SELECT repository_key, ${expressions.map(([field, expression]) => `${expression} AS ${field}`).join(", ")}
        FROM events
        WHERE ${predicates.length > 0 ? predicates.join(" AND ") : "1 = 1"} ${homeFilter}
        GROUP BY repository_key
      `)
      .all(...params);
    for (const row of periodRows) {
      rows.get(row.repository_key).periods[period.key] = Object.fromEntries(
        expressions.map(([field]) => [field, Number(row[field])]),
      );
    }
  }
  return [...rows.values()].sort(
    (left, right) =>
      right.periods.all.total - left.periods.all.total ||
      (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  );
}

function insertUsageStoreEvent(
  store,
  {
    timestamp,
    homeId,
    sessionId,
    cwd,
    key,
    name,
    kind,
    detailMask = 15,
    gap = 0,
    total,
    input = 0,
    cached = 0,
    output = 0,
    reasoning = 0,
  },
) {
  const date = new Date(timestamp);
  const day = date.toISOString().slice(0, 10);
  store.database
    .prepare(`
    INSERT INTO events (
      source_path, timestamp_ms, session_id, home_id, home_label, channel, project, cwd, model,
      hour_key, day_key, week_key, month_key, repository_key, repository_path, repository_kind,
      detail_mask, reconciliation_gap, total, input, cached, output, reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .run(
      `/fixture/${homeId === "home-a" ? "a" : "b"}`,
      Date.parse(timestamp),
      sessionId,
      homeId,
      homeId === "home-a" ? "Home A" : "Home B",
      "CLI",
      name,
      cwd,
      "gpt-6-sol",
      `${day} ${String(date.getUTCHours()).padStart(2, "0")}`,
      day,
      day,
      day.slice(0, 7),
      key,
      name,
      kind,
      detailMask,
      gap,
      total,
      input,
      cached,
      output,
      reasoning,
    );
}

test("aggregates the 16 repository fields with window-wide cwd and MIN metadata semantics", () => {
  const { db, directory } = openDatabase();
  try {
    insertEvent(db, {
      timestamp: "2026-07-12T01:00:00.000Z",
      homeId: "home-a",
      sessionId: "one",
      cwd: "/repo/a",
      key: "git:repo-a",
      name: "repo/z",
      kind: "git",
      total: 10,
      input: 8,
      cached: 2,
      output: 2,
      reasoning: 1,
    });
    insertEvent(db, {
      timestamp: "2026-07-12T02:00:00.000Z",
      homeId: "home-a",
      sessionId: "two",
      cwd: "/repo/a",
      key: "git:repo-a",
      name: "repo/a",
      kind: "directory",
      detailMask: 0,
      gap: 2,
      total: 5,
    });
    insertEvent(db, {
      timestamp: "2026-07-13T01:00:00.000Z",
      homeId: "home-b",
      sessionId: "three",
      cwd: "/repo/a",
      key: "git:repo-a",
      name: "repo/a",
      kind: "directory",
      gap: 1,
      total: 20,
      input: 15,
      cached: 5,
      output: 5,
      reasoning: 2,
    });
    insertEvent(db, {
      timestamp: "2026-07-13T02:00:00.000Z",
      homeId: "home-b",
      sessionId: "four",
      cwd: "/repo/b",
      key: "git:repo-a",
      name: "repo/a",
      kind: "git",
      detailMask: 16,
      total: 1,
    });
    insertEvent(db, {
      timestamp: "2026-07-13T03:00:00.000Z",
      homeId: "home-a",
      sessionId: "five",
      cwd: "/repo/b",
      key: "git:repo-a",
      name: "repo/b",
      kind: "git",
      detailMask: 3,
      total: 2,
      input: 1,
      cached: 1,
    });
    insertEvent(db, {
      timestamp: "2026-07-13T04:00:00.000Z",
      homeId: "home-b",
      sessionId: "six",
      cwd: "",
      key: "unknown:cwd",
      name: "Unknown cwd",
      kind: "unknown",
      detailMask: 0,
      total: 4,
    });
    rebuildUsageRollups(db, { days: ["2026-07-12", "2026-07-13"] });

    assert.deepEqual(
      queryUsageRollupRepositoriesWindow(db, {
        startMs: Date.parse("2026-07-12T00:00:00.000Z"),
        endMs: Date.parse("2026-07-14T00:00:00.000Z"),
      }),
      [
        {
          key: "git:repo-a",
          name: "repo/a",
          kind: "directory",
          pathCount: 2,
          total: 38,
          input: 24,
          inputUnavailableTokens: 6,
          cached: 8,
          cachedUnavailableTokens: 6,
          uncachedInput: 16,
          uncachedInputUnavailableTokens: 6,
          cacheRateInput: 24,
          cacheRateCached: 8,
          output: 7,
          outputUnavailableTokens: 8,
          reasoning: 3,
          reasoningUnavailableTokens: 8,
          unattributedDetailTokens: 8,
          inconsistentTokens: 1,
          reconciliationGap: 3,
        },
        {
          key: "unknown:cwd",
          name: "Unknown cwd",
          kind: "unknown",
          pathCount: 0,
          total: 4,
          input: 0,
          inputUnavailableTokens: 4,
          cached: 0,
          cachedUnavailableTokens: 4,
          uncachedInput: 0,
          uncachedInputUnavailableTokens: 4,
          cacheRateInput: 0,
          cacheRateCached: 0,
          output: 0,
          outputUnavailableTokens: 4,
          reasoning: 0,
          reasoningUnavailableTokens: 4,
          unattributedDetailTokens: 4,
          inconsistentTokens: 0,
          reconciliationGap: 0,
        },
      ],
    );

    assert.deepEqual(
      queryUsageRollupRepositoriesWindow(db, {
        startMs: Date.parse("2026-07-12T00:00:00.000Z"),
        endMs: Date.parse("2026-07-14T00:00:00.000Z"),
        excludeHomes: ["home-a"],
      }),
      [
        {
          key: "git:repo-a",
          name: "repo/a",
          kind: "directory",
          pathCount: 2,
          total: 21,
          input: 15,
          inputUnavailableTokens: 1,
          cached: 5,
          cachedUnavailableTokens: 1,
          uncachedInput: 10,
          uncachedInputUnavailableTokens: 1,
          cacheRateInput: 15,
          cacheRateCached: 5,
          output: 5,
          outputUnavailableTokens: 1,
          reasoning: 2,
          reasoningUnavailableTokens: 1,
          unattributedDetailTokens: 1,
          inconsistentTokens: 1,
          reconciliationGap: 1,
        },
        {
          key: "unknown:cwd",
          name: "Unknown cwd",
          kind: "unknown",
          pathCount: 0,
          total: 4,
          input: 0,
          inputUnavailableTokens: 4,
          cached: 0,
          cachedUnavailableTokens: 4,
          uncachedInput: 0,
          uncachedInputUnavailableTokens: 4,
          cacheRateInput: 0,
          cacheRateCached: 0,
          output: 0,
          outputUnavailableTokens: 4,
          reasoning: 0,
          reasoningUnavailableTokens: 4,
          unattributedDetailTokens: 4,
          inconsistentTokens: 0,
          reconciliationGap: 0,
        },
      ],
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("UsageStore periodComparison repository rollups match raw aggregate SQL and fail closed without repo columns", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "usage-store-repository-periods-"));
  const store = new UsageStore({
    homeDir: directory,
    databaseFile: path.join(directory, "usage-index.sqlite"),
    env: {},
    importDirs: [],
  });
  try {
    await store.open();
    const insertSource = store.database.prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    insertSource.run("/fixture/a", "main", "home-a", "Home A", "/fixture/home-a", 1, 1, "now");
    insertSource.run("/fixture/b", "main", "home-b", "Home B", "/fixture/home-b", 1, 1, "now");
    const events = [
      {
        timestamp: "2026-06-15T02:00:00.000Z",
        homeId: "home-a",
        sessionId: "old",
        cwd: "/repo/old",
        key: "git:repo-a",
        name: "repo/z",
        kind: "git",
        total: 10,
        input: 7,
        cached: 2,
        output: 3,
        reasoning: 1,
      },
      {
        timestamp: "2026-07-10T02:00:00.000Z",
        homeId: "home-b",
        sessionId: "month-a",
        cwd: "/repo/month",
        key: "git:repo-a",
        name: "repo/a",
        kind: "directory",
        detailMask: 0,
        total: 20,
      },
      {
        timestamp: "2026-07-10T03:00:00.000Z",
        homeId: "home-b",
        sessionId: "month-b",
        cwd: "/repo/b",
        key: "git:repo-b",
        name: "beta",
        kind: "git",
        detailMask: 16,
        total: 5,
      },
      {
        timestamp: "2026-07-20T02:00:00.000Z",
        homeId: "home-a",
        sessionId: "today-a",
        cwd: "/repo/today",
        key: "git:repo-a",
        name: "repo/z",
        kind: "git",
        gap: 2,
        total: 30,
        input: 22,
        cached: 5,
        output: 8,
        reasoning: 2,
      },
      {
        timestamp: "2026-07-20T03:00:00.000Z",
        homeId: "home-b",
        sessionId: "today-c",
        cwd: "/repo/c",
        key: "git:repo-c",
        name: "gamma",
        kind: "git",
        detailMask: 3,
        total: 7,
        input: 5,
        cached: 2,
      },
      {
        timestamp: "2026-07-21T03:00:00.000Z",
        homeId: "home-b",
        sessionId: "future-b",
        cwd: "/repo/future",
        key: "git:repo-b",
        name: "beta",
        kind: "git",
        total: 40,
        input: 30,
        cached: 10,
        output: 10,
      },
    ];
    for (const event of events) insertUsageStoreEvent(store, event);
    store.homes = ["a", "b"].map((suffix) => ({
      id: `home-${suffix}`,
      label: `Home ${suffix.toUpperCase()}`,
      path: `/fixture/home-${suffix}`,
      kind: "main",
    }));
    await store.rebuildHistoryRollups();

    const options = {
      now: new Date("2026-07-20T12:00:00.000Z"),
    };
    const cases = [
      { ...options, calendarZone: "utc", excludeHomes: [] },
      { ...options, calendarZone: "utc", excludeHomes: ["home-b"] },
      { ...options, calendarZone: "local", excludeHomes: [] },
    ];
    for (const periodOptions of cases) {
      store.periodComparisonCache.clear();
      const prepare = store.database.prepare;
      const counts = { rollup: 0, rawRepositoryPeriod: 0 };
      store.database.prepare = function (sql) {
        const text = String(sql);
        if (text.includes("FROM usage_rollup_repositories")) counts.rollup += 1;
        if (text.includes("repository_key AS dimension_key")) counts.rawRepositoryPeriod += 1;
        return prepare.call(this, sql);
      };
      let actual;
      try {
        actual = store.periodComparison(periodOptions);
      } finally {
        store.database.prepare = prepare;
      }
      assert.deepEqual(
        actual.repositories,
        expectedRepositoryPeriods(store, actual.periods, periodOptions.excludeHomes),
      );
      assert.ok(counts.rollup > 0, "repository periods must read the repository rollup");
      assert.equal(counts.rawRepositoryPeriod, 0, "complete rollups must avoid the original repository period SQL");
    }

    store.periodComparisonCache.clear();
    const all = store.periodComparison(options);
    const repoA = all.repositories.find((row) => row.key === "git:repo-a");
    assert.deepEqual(
      { name: repoA.name, kind: repoA.kind, pathCount: repoA.pathCount },
      { name: "repo/a", kind: "directory", pathCount: 3 },
      "repository attributes and pathCount must come from the full scope",
    );
    assert.equal(repoA.periods.today.total, 30);
    assert.equal(repoA.periods.month.total, 50);

    store.periodComparisonCache.clear();
    store.verifiedHistorySqlRead = true;
    store.database.exec(`
      CREATE TEMP VIEW events AS
      SELECT timestamp_ms, home_id, model, detail_mask, reconciliation_gap, total, input, cached, output, reasoning
      FROM main.events
    `);
    try {
      assert.throws(
        () => store.periodComparison({ ...options, excludeHomes: ["not-a-home"] }),
        /no such column: repository_key/,
        "a cold TEMP events shape without repository columns must not silently return empty repositories",
      );
    } finally {
      store.database.exec("DROP VIEW temp.events");
      store.verifiedHistorySqlRead = false;
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reads complete days from repository rollups and partial edges from indexed events", () => {
  const { db, directory } = openDatabase();
  try {
    const insert = (timestamp, cwd, total) =>
      insertEvent(db, {
        timestamp,
        homeId: "home-a",
        sessionId: timestamp,
        cwd,
        key: "git:bounded",
        name: "bounded",
        kind: "git",
        total,
        input: total - 1,
        cached: 1,
        output: 1,
      });
    insert("2026-07-12T11:00:00.000Z", "/outside", 100);
    insert("2026-07-12T13:00:00.000Z", "/repo/a", 3);
    insert("2026-07-13T02:00:00.000Z", "/repo/a", 5);
    insert("2026-07-13T03:00:00.000Z", "/repo/b", 7);
    insert("2026-07-14T11:00:00.000Z", "/repo/a", 11);
    insert("2026-07-14T12:00:00.000Z", "/outside", 200);
    rebuildUsageRollups(db, { days: ["2026-07-12", "2026-07-13", "2026-07-14"] });

    const observed = [];
    const prepare = db.prepare;
    db.prepare = function (sql) {
      if (sql.includes("FROM usage_rollup_repositories")) observed.push("rollup");
      if (sql.includes("FROM events")) observed.push("events");
      return prepare.call(this, sql);
    };
    try {
      assert.deepEqual(
        queryUsageRollupRepositoriesWindow(db, {
          startMs: Date.parse("2026-07-12T12:00:00.000Z"),
          endMs: Date.parse("2026-07-14T12:00:00.000Z"),
        }),
        [
          {
            key: "git:bounded",
            name: "bounded",
            kind: "git",
            pathCount: 2,
            total: 26,
            input: 22,
            inputUnavailableTokens: 0,
            cached: 4,
            cachedUnavailableTokens: 0,
            uncachedInput: 18,
            uncachedInputUnavailableTokens: 0,
            cacheRateInput: 22,
            cacheRateCached: 4,
            output: 4,
            outputUnavailableTokens: 0,
            reasoning: 0,
            reasoningUnavailableTokens: 0,
            unattributedDetailTokens: 0,
            inconsistentTokens: 0,
            reconciliationGap: 0,
          },
        ],
      );
    } finally {
      db.prepare = prepare;
    }
    assert.deepEqual(observed.sort(), ["events", "rollup"]);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("handles downward revisions, empty days, and unknown detail masks without stale totals", () => {
  const { db, directory } = openDatabase();
  try {
    insertEvent(db, {
      timestamp: "2026-07-12T02:00:00.000Z",
      homeId: "home-a",
      sessionId: "revision",
      cwd: "/repo",
      key: "git:revision",
      name: "revision",
      kind: "git",
      total: 10,
      input: 7,
      cached: 2,
      output: 3,
      reasoning: 1,
    });
    rebuildUsageRollups(db, { days: ["2026-07-12"] });
    db.prepare(`
      UPDATE events
      SET total = 4, input = 0, cached = 0, output = 0, reasoning = 0, detail_mask = 0
      WHERE session_id = 'revision'
    `).run();
    assert.deepEqual(listDirtyUsageRollupDays(db), ["2026-07-12"]);

    const window = {
      startMs: Date.parse("2026-07-12T00:00:00.000Z"),
      endMs: Date.parse("2026-07-13T00:00:00.000Z"),
    };
    assert.deepEqual(queryUsageRollupRepositoriesWindow(db, window), [
      {
        key: "git:revision",
        name: "revision",
        kind: "git",
        pathCount: 1,
        total: 4,
        input: 0,
        inputUnavailableTokens: 4,
        cached: 0,
        cachedUnavailableTokens: 4,
        uncachedInput: 0,
        uncachedInputUnavailableTokens: 4,
        cacheRateInput: 0,
        cacheRateCached: 0,
        output: 0,
        outputUnavailableTokens: 4,
        reasoning: 0,
        reasoningUnavailableTokens: 4,
        unattributedDetailTokens: 4,
        inconsistentTokens: 0,
        reconciliationGap: 0,
      },
    ]);

    rebuildUsageRollups(db, { days: ["2026-07-12", "2026-07-13"] });
    assert.deepEqual(listDirtyUsageRollupDays(db), []);
    assert.equal(queryUsageRollupRepositoriesWindow(db, window)[0].total, 4);
    assert.deepEqual(
      queryUsageRollupRepositoriesWindow(db, {
        startMs: Date.parse("2026-07-13T00:00:00.000Z"),
        endMs: Date.parse("2026-07-14T00:00:00.000Z"),
      }),
      [],
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("upgrades an old rollup format transactionally without reimporting facts", () => {
  const { db, directory } = openDatabase();
  try {
    insertEvent(db, {
      timestamp: "2026-07-12T02:00:00.000Z",
      homeId: "home-a",
      sessionId: "upgrade",
      cwd: "/repo",
      key: "git:upgrade",
      name: "upgrade",
      kind: "git",
      total: 9,
      input: 6,
      cached: 2,
      output: 2,
      reasoning: 1,
    });
    db.exec(`
      CREATE TABLE usage_rollup_format (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        format_version INTEGER NOT NULL
      ) STRICT;
      INSERT INTO usage_rollup_format VALUES (1, 7);
      CREATE TABLE usage_rollup_days (
        calendar_zone TEXT NOT NULL,
        day_key TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        PRIMARY KEY (calendar_zone, day_key)
      ) STRICT;
      INSERT INTO usage_rollup_days VALUES (
        'utc', '2026-07-12', ${Date.UTC(2026, 6, 12)}, ${Date.UTC(2026, 6, 13)}
      );
      CREATE TABLE usage_rollup_repositories (stale TEXT) STRICT;
    `);
    const facts = db.prepare("SELECT * FROM events").all();

    createUsageRollups(db);

    assert.equal(db.prepare("SELECT format_version FROM usage_rollup_format").get().format_version, 8);
    assert.deepEqual(listDirtyUsageRollupDays(db), ["2026-07-12"]);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM usage_rollup_repositories").get().count, 0);
    assert.deepEqual(db.prepare("SELECT * FROM events").all(), facts);

    rebuildUsageRollups(db, { days: ["2026-07-12"] });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM usage_rollup_repositories").get().count, 1);
    assert.equal(
      queryUsageRollupRepositoriesWindow(db, {
        startMs: Date.parse("2026-07-12T00:00:00.000Z"),
        endMs: Date.parse("2026-07-13T00:00:00.000Z"),
      })[0].total,
      9,
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("falls back to cwd repository identity when complete cold events omit repository fields", () => {
  const { db, directory } = openDatabase();
  try {
    rebuildUsageRollupsFromEvents(db, {
      days: ["2026-07-12"],
      events: [
        {
          timestamp: "2026-07-12T02:00:00.000Z",
          sessionId: "cold-cwd",
          homeId: "home-a",
          model: "gpt-6-sol",
          cwd: "/cold/project",
          detailMask: 15,
          total: { total: 6, input: 4, cached: 1, output: 2, reasoning: 1 },
        },
        {
          timestamp: "2026-07-12T03:00:00.000Z",
          sessionId: "cold-unknown",
          homeId: "home-a",
          project: "Unknown cwd",
          model: "gpt-6-sol",
          detailMask: 0,
          total: { total: 2, input: 0, cached: 0, output: 0, reasoning: 0 },
        },
      ],
    });

    assert.deepEqual(
      queryUsageRollupRepositoriesWindow(db, {
        startMs: Date.parse("2026-07-12T00:00:00.000Z"),
        endMs: Date.parse("2026-07-13T00:00:00.000Z"),
      }),
      [
        {
          key: "directory:/cold/project",
          name: "/cold/project",
          kind: "directory",
          pathCount: 1,
          total: 6,
          input: 4,
          inputUnavailableTokens: 0,
          cached: 1,
          cachedUnavailableTokens: 0,
          uncachedInput: 3,
          uncachedInputUnavailableTokens: 0,
          cacheRateInput: 4,
          cacheRateCached: 1,
          output: 2,
          outputUnavailableTokens: 0,
          reasoning: 1,
          reasoningUnavailableTokens: 0,
          unattributedDetailTokens: 0,
          inconsistentTokens: 0,
          reconciliationGap: 0,
        },
        {
          key: "directory:Unknown cwd",
          name: "Unknown cwd",
          kind: "directory",
          pathCount: 1,
          total: 2,
          input: 0,
          inputUnavailableTokens: 2,
          cached: 0,
          cachedUnavailableTokens: 2,
          uncachedInput: 0,
          uncachedInputUnavailableTokens: 2,
          cacheRateInput: 0,
          cacheRateCached: 0,
          output: 0,
          outputUnavailableTokens: 2,
          reasoning: 0,
          reasoningUnavailableTokens: 2,
          unattributedDetailTokens: 2,
          inconsistentTokens: 0,
          reconciliationGap: 0,
        },
      ],
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("uses local rollup markers across DST transitions", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "usage-repository-dst-"));
  const script = `
    import { DatabaseSync } from "node:sqlite";
    import {
      queryUsageRollupRepositoriesWindow,
      rebuildUsageRollupsFromEvents,
    } from "./src/usage-rollups.js";

    const db = new DatabaseSync(process.env.ROLLUP_DB);
    db.exec("CREATE TABLE events (timestamp_ms INTEGER NOT NULL) STRICT");
    const event = (timestamp, homeId, total) => ({
      timestamp,
      sessionId: timestamp,
      homeId,
      model: "gpt-6-sol",
      cwd: "/repo",
      repositoryKey: "git:repo",
      repositoryPath: "repo",
      repositoryKind: "git",
      detailMask: 15,
      total: { total, input: total - 1, cached: 1, output: 1, reasoning: 0 },
    });
    const cases = [
      { day: "2026-03-08", year: 2026, month: 2, date: 8, next: 9, values: [10, 20] },
      { day: "2026-11-01", year: 2026, month: 10, date: 1, next: 2, values: [15, 25] },
    ];
    const result = [];
    for (const item of cases) {
      const start = new Date(item.year, item.month, item.date).getTime();
      const end = new Date(item.year, item.month, item.next).getTime();
      const events = [
        event(new Date(start - 1).toISOString(), "home-a", 999),
        event(new Date(start + 1).toISOString(), "home-a", item.values[0]),
        event(new Date(end - 1).toISOString(), "home-b", item.values[1]),
        event(new Date(end).toISOString(), "home-a", 888),
      ];
      rebuildUsageRollupsFromEvents(db, { days: [item.day], events, calendarZone: "local" });
      const marker = db.prepare(
        "SELECT start_ms, end_ms FROM usage_rollup_days WHERE calendar_zone = 'local' AND day_key = ?",
      ).get(item.day);
      const rows = queryUsageRollupRepositoriesWindow(db, { startMs: start, endMs: end });
      result.push({
        hours: (Number(marker.end_ms) - Number(marker.start_ms)) / 3_600_000,
        total: rows[0].total,
        pathCount: rows[0].pathCount,
      });
    }
    db.close();
    console.log(JSON.stringify(result));
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        TZ: "America/New_York",
        ROLLUP_DB: path.join(directory, "index.sqlite"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [
      { hours: 23, total: 30, pathCount: 1 },
      { hours: 25, total: 40, pathCount: 1 },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
