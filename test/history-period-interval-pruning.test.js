import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { UsageStore } from "../src/usage-store.js";

const PERIODS = ["today", "week", "month", "all"];
const FIELDS = [
  ["total", "total"],
  ["input", "CASE WHEN (detail_mask & 1) != 0 THEN input ELSE 0 END"],
  ["inputUnavailableTokens", "CASE WHEN (detail_mask & 1) = 0 THEN total ELSE 0 END"],
  ["cached", "CASE WHEN (detail_mask & 2) != 0 THEN cached ELSE 0 END"],
  ["cachedUnavailableTokens", "CASE WHEN (detail_mask & 2) = 0 THEN total ELSE 0 END"],
  ["uncachedInput", "CASE WHEN (detail_mask & 3) = 3 THEN MAX(input - cached, 0) ELSE 0 END"],
  ["uncachedInputUnavailableTokens", "CASE WHEN (detail_mask & 3) != 3 THEN total ELSE 0 END"],
  ["cacheRateInput", "CASE WHEN (detail_mask & 3) = 3 THEN input ELSE 0 END"],
  ["cacheRateCached", "CASE WHEN (detail_mask & 3) = 3 THEN cached ELSE 0 END"],
  ["output", "CASE WHEN (detail_mask & 4) != 0 THEN output ELSE 0 END"],
  ["outputUnavailableTokens", "CASE WHEN (detail_mask & 4) = 0 THEN total ELSE 0 END"],
  ["reasoning", "CASE WHEN (detail_mask & 8) != 0 THEN reasoning ELSE 0 END"],
  ["reasoningUnavailableTokens", "CASE WHEN (detail_mask & 8) = 0 THEN total ELSE 0 END"],
  ["unattributedDetailTokens", "CASE WHEN (detail_mask & 15) != 15 THEN total ELSE 0 END"],
  ["inconsistentTokens", "CASE WHEN (detail_mask & 16) != 0 THEN total ELSE 0 END"],
  ["reconciliationGap", "reconciliation_gap"],
];

function projectEvent(timestamp, project, session, usage) {
  return {
    schema_version: "codex-usage.project-log.v1",
    timestamp,
    source: "test",
    channel: "Test",
    project_root: project,
    cwd: project,
    session_id: session,
    model: "gpt-6-sol",
    usage,
  };
}

function ranges(values, calendarZone = "utc") {
  return Object.fromEntries(
    PERIODS.map((period) => [
      period,
      {
        preset: period,
        calendarZone,
        start: values[period].start,
        end: values[period].end,
      },
    ]),
  );
}

function originalSqlAggregate(store, periodRanges, excludeHomes = []) {
  const parameters = [];
  const measures = [];
  for (const period of PERIODS) {
    for (const [field, expression] of FIELDS) {
      measures.push(
        `COALESCE(SUM(CASE WHEN (? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?) THEN ${expression} ELSE 0 END), 0) AS "${period}__${field}"`,
      );
      const start = periodRanges[period].start ? periodRanges[period].start.getTime() : null;
      const end = periodRanges[period].end ? periodRanges[period].end.getTime() : null;
      parameters.push(start, start, end, end);
    }
  }
  const ids = excludeHomes.map(String);
  const where = ids.length ? ` WHERE home_id NOT IN (${ids.map(() => "?").join(", ")})` : "";
  const rows = store.database
    .prepare(`
      SELECT
        repository_key AS dimension_key,
        MIN(repository_path) AS dimension_name,
        MIN(repository_kind) AS dimension_kind,
        COUNT(DISTINCT NULLIF(cwd, '')) AS path_count,
        ${measures.join(", ")}
      FROM events${where}
      GROUP BY repository_key
      ORDER BY all__total DESC, dimension_name ASC
    `)
    .all(...parameters, ...ids);
  return rows.map((row) => ({
    key: String(row.dimension_key),
    name: String(row.dimension_name),
    kind: row.dimension_kind,
    pathCount: Number(row.path_count || 0),
    periods: Object.fromEntries(
      PERIODS.map((period) => [
        period,
        Object.fromEntries(FIELDS.map(([field]) => [field, Number(row[`${period}__${field}`] || 0)])),
      ]),
    ),
  }));
}

async function createMultiHomeStore() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "period-interval-pruning-"));
  const roots = [path.join(homeDir, "home-a"), path.join(homeDir, "home-b")];
  const eventsByRoot = [
    [
      projectEvent("2026-07-12T02:00:00.000Z", "/work/alpha", "alpha-a", {
        total: 100,
        input: 80,
        cached: 20,
        output: 20,
        reasoning: 5,
      }),
      projectEvent("2026-07-14T02:00:00.000Z", "/work/alpha", "alpha-future", {
        total: 30,
        input: 12,
        cached: 4,
      }),
      projectEvent("2026-08-05T02:00:00.000Z", "/work/future", "future-only", {
        total: 9,
        input: 9,
      }),
    ],
    [
      projectEvent("2026-07-13T02:00:00.000Z", "/work/beta", "beta-a", {
        total: 40,
        input: 20,
        cached: 10,
        output: 20,
        reasoning: 5,
      }),
      projectEvent("2026-07-13T18:00:00.000Z", "/work/beta", "beta-local", {
        total: 7,
        output: 3,
      }),
    ],
  ];
  for (const [index, root] of roots.entries()) {
    const usageFile = path.join(root, ".codex-usage", "usage.jsonl");
    await mkdir(path.dirname(usageFile), { recursive: true });
    await writeFile(usageFile, `${eventsByRoot[index].map((event) => JSON.stringify(event)).join("\n")}\n`);
  }
  const store = new UsageStore({
    homeDir,
    databaseFile: path.join(homeDir, "usage-index.sqlite"),
    importDirs: roots,
  });
  await store.sync();
  return { homeDir, roots, store, databaseFile: store.databaseFile };
}

function localDayRange(year, month, day) {
  const start = new Date(year, month - 1, day);
  const end = new Date(year, month - 1, day + 1, 0, 0, 0, -1);
  return { start, end };
}

async function closeStore(store) {
  if (!store) return;
  try {
    store.database?.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    store.close();
  }
}

test("raw period aggregate preserves all 16 fields and repository metadata for empty, full, partial, local, and excluded windows", async () => {
  const fixture = await createMultiHomeStore();
  const { store, homeDir, roots } = fixture;
  try {
    const excludedHome = store.homes.find((home) => home.path === roots[0]).id;
    const utcRanges = ranges({
      today: {
        start: new Date("2026-07-01T00:00:00.000Z"),
        end: new Date("2026-07-01T23:59:59.999Z"),
      },
      week: {
        start: new Date("2026-07-01T00:00:00.000Z"),
        end: new Date("2026-09-01T00:00:00.000Z"),
      },
      month: {
        start: new Date("2026-07-13T00:00:00.000Z"),
        end: new Date("2026-07-13T23:59:59.999Z"),
      },
      all: {
        start: new Date("2026-09-01T00:00:00.000Z"),
        end: new Date("2026-09-02T00:00:00.000Z"),
      },
    });
    const local = localDayRange(2026, 7, 13);
    const localRanges = ranges(
      Object.fromEntries(PERIODS.map((period) => [period, { start: local.start, end: local.end }])),
      "local",
    );
    const cases = [
      { ranges: utcRanges, excludeHomes: [] },
      { ranges: utcRanges, excludeHomes: [excludedHome] },
      { ranges: localRanges, excludeHomes: [] },
    ];
    const aggregateSqlByCase = [];

    for (const item of cases) {
      const expected = originalSqlAggregate(store, item.ranges, item.excludeHomes);
      let aggregateSql = "";
      const originalPrepare = store.database.prepare;
      const prepare = originalPrepare.bind(store.database);
      store.database.prepare = (sql) => {
        if (sql.includes("repository_key AS dimension_key") && sql.includes("FROM events")) aggregateSql = sql;
        return prepare(sql);
      };
      let actual;
      try {
        actual = store.periodAggregate("repository_key", "repository_path", new Date(), item.ranges, {
          includeKind: true,
          excludeHomes: item.excludeHomes,
        });
      } finally {
        store.database.prepare = originalPrepare;
      }
      assert.deepEqual(actual, expected);
      aggregateSqlByCase.push(aggregateSql);
    }
    assert.match(aggregateSqlByCase[0], /COALESCE\(SUM\(0\), 0\) AS "today__total"/);
    assert.match(aggregateSqlByCase[0], /COALESCE\(SUM\(total\), 0\) AS "week__total"/);
    assert.match(aggregateSqlByCase[0], /CASE WHEN \(\? IS NULL OR timestamp_ms >= \?\)/);

    const expectedSnapshot = originalSqlAggregate(store, utcRanges);
    const external = new DatabaseSync(fixture.databaseFile);
    let writeDuringProof = false;
    const snapshotPrepare = store.database.prepare;
    try {
      external.exec("PRAGMA busy_timeout = 5000");
      store.database.prepare = (sql) => {
        const statement = snapshotPrepare.call(store.database, sql);
        if (!sql.startsWith("SELECT MIN(timestamp_ms) AS minimum") || !sql.includes("FROM events")) return statement;
        return new Proxy(statement, {
          get(target, property) {
            if (property === "get") {
              return (...args) => {
                const result = target.get(...args);
                if (!writeDuringProof) {
                  external.prepare("UPDATE events SET total = 999 WHERE session_id = ?").run("beta-a");
                  writeDuringProof = true;
                }
                return result;
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      };
      const snapshotActual = store.periodAggregate("repository_key", "repository_path", new Date(), utcRanges, {
        includeKind: true,
      });
      assert.equal(writeDuringProof, true);
      assert.deepEqual(snapshotActual, expectedSnapshot, "the aggregate must use the bounds proof's read snapshot");
      assert.equal(
        store.database.prepare("SELECT total FROM events WHERE session_id = ?").get("beta-a").total,
        999,
        "the external write must be committed outside the read snapshot",
      );
    } finally {
      store.database.prepare = snapshotPrepare;
      external.prepare("UPDATE events SET total = 40 WHERE session_id = ?").run("beta-a");
      external.close();
    }

    const rows = originalSqlAggregate(store, utcRanges);
    assert.ok(
      rows.some((row) => row.name === "/work/future"),
      "future-only repository metadata must remain present",
    );
    const futurePeriods = rows.find((row) => row.name === "/work/future")?.periods;
    assert.equal(futurePeriods.today.total, 0);
    assert.equal(futurePeriods.all.total, 0);
    assert.equal(futurePeriods.week.total, 9, "the future-only repository must retain its covered-period value");

    const emptyHome = await mkdtemp(path.join(os.tmpdir(), "period-interval-empty-"));
    const emptyStore = new UsageStore({
      homeDir: emptyHome,
      databaseFile: path.join(emptyHome, "usage-index.sqlite"),
    });
    try {
      await emptyStore.open();
      assert.deepEqual(
        emptyStore.periodAggregate("repository_key", "repository_path", new Date(), utcRanges, {
          includeKind: true,
        }),
        originalSqlAggregate(emptyStore, utcRanges),
      );
    } finally {
      await closeStore(emptyStore);
      await rm(emptyHome, { recursive: true, force: true });
    }
  } finally {
    await closeStore(store);
    await rm(homeDir, { recursive: true, force: true });
  }
});
