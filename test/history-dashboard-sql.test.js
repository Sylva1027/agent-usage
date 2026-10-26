import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { getPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { checkpointUsageStore } from "../src/usage-executor.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

const filters = { preset: "all", calendarZone: "utc", bucket: "day", now: new Date("2026-02-03T12:00:00Z") };
const sqlSupported = (() => {
  const database = new DatabaseSync(":memory:");
  try {
    return typeof database.isTransaction === "boolean";
  } finally {
    database.close();
  }
})();
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const meta = (db, key, value) =>
  db.prepare("INSERT OR REPLACE INTO store_meta VALUES(?, ?)").run(key, JSON.stringify(value));

async function components(store, scope = filters, options = {}) {
  return {
    summary: await store.summarizeHistory(scope, options),
    metadata: await store.metadataHistory(scope.now),
    periodComparison: await store.periodComparisonHistory(scope),
  };
}

function equivalent(actual, expected, at = "$") {
  if (
    /\.(?:costEstimate|costByModel\..+)\.[^.]+(?:Usd|Cny)$/.test(at) &&
    Number.isFinite(actual) &&
    Number.isFinite(expected)
  ) {
    assert.ok(Math.abs(actual - expected) <= 1e-12, at);
  } else if (actual && expected && typeof actual === "object" && typeof expected === "object") {
    assert.equal(Array.isArray(actual), Array.isArray(expected), at);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), at);
    for (const key of Object.keys(actual)) equivalent(actual[key], expected[key], `${at}.${key}`);
  } else assert.deepEqual(actual, expected, at);
}

async function fixture(buildRollups = false) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "ret-dashboard-sql-"));
  const file = path.join(root, "usage.sqlite"),
    segment = path.join(root, "cold.sqlite");
  const store = new UsageStore({ homeDir: root, databaseFile: file, env: {}, importDirs: [] });
  await store.open();
  const insert = store.database.prepare(`INSERT INTO events(
    source_path,timestamp_ms,session_id,home_id,home_label,channel,project,cwd,model,
    hour_key,day_key,week_key,month_key,total,input,cached,output,reasoning,detail_mask
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const id of ["a", "b"]) {
    store.database
      .prepare("INSERT INTO source_files VALUES(?,?,?,?,?,?,?,?)")
      .run(`/fixture/${id}`, id === "a" ? "codex" : "claude", id, `Home ${id}`, `/fixture/home-${id}`, 1, 1, "now");
  }
  for (const [time, home, total, model, mask, cwd] of [
    ["2026-01-02T03:00:00Z", "a", 100, "gpt-6-sol", 5, ""],
    ["2026-01-03T03:00:00Z", "a", -5, "gpt-6-sol", 0, "/cwd/a"],
    ["2026-01-02T03:00:00Z", "b", 20, "claude-sonnet-4-5", 0, "/cwd/b"],
    ["2026-02-02T03:00:00Z", "a", 30, "gpt-6-sol", 5, "/cwd/a"],
    ["2030-01-02T03:00:00Z", "b", 99, "gpt-6-sol", 0, "/future"],
  ]) {
    const day = time.slice(0, 10);
    insert.run(
      `/fixture/${home}`,
      Date.parse(time),
      time.startsWith("2026-01") ? `session-${home}` : `hot-${home}`,
      home,
      `Home ${home}`,
      "CLI",
      "stored project",
      cwd,
      model,
      `${day} 03`,
      day,
      "2025-12-29",
      day.slice(0, 7),
      total,
      total,
      0,
      0,
      0,
      mask,
    );
  }
  store.homes = ["a", "b"].map((id) => ({
    id,
    label: `Home ${id}`,
    path: `/fixture/home-${id}`,
    kind: id === "a" ? "codex" : "claude",
  }));
  store.generatedAt = "2026-02-03T00:00:00Z";
  if (buildRollups) await store.rebuildHistoryRollups();
  const original = { ...store.database.prepare("SELECT * FROM events WHERE id=1").get() };
  await createHistoryArchiveCandidate(store.database, segment, {
    startMs: Date.parse("2026-01-01T00:00:00Z"),
    endMs: Date.parse("2026-02-01T00:00:00Z"),
  });
  await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, segment));
  return {
    store,
    segment,
    original,
    cleanup() {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("SQL history preserves complete scopes, isolates hot caches, and falls back for revisions", {
  skip: !sqlSupported,
}, async () => {
  const f = await fixture();
  const { store, segment, original } = f;
  try {
    const before = store.database.prepare("SELECT * FROM events ORDER BY id").all();
    const sha = digest(segment);
    for (const scope of [filters, { ...filters, calendarZone: "local" }, { ...filters, excludeHomes: ["a"] }]) {
      const expected = await components(store, scope);
      equivalent(await store.dashboardHistory(scope), expected);
      const projection = store.historySqlDashboardCache.store.summaryProjectionCache;
      assert.ok(projection, "the verified SQL projection is actually cached");
      const hot = store.summarize(scope);
      assert.equal(hot.eventCount, scope.excludeHomes ? 1 : 2, "ordinary summarize remains hot-only");
      equivalent(await store.dashboardHistory(scope), expected);
      assert.equal(
        store.historySqlDashboardCache.store.summaryProjectionCache,
        projection,
        "warm read reuses its separate projection",
      );
    }
    const brief = { includeDetails: false };
    equivalent(await store.dashboardHistory(filters, brief), await components(store, filters, brief));
    assert.deepEqual(store.database.prepare("SELECT * FROM events ORDER BY id").all(), before);
    assert.equal(store.database.prepare("SELECT count(*) AS n FROM temp.sqlite_master").get().n, 0);
    assert.equal(digest(segment), sha);

    const { id: _id, ...payload } = original;
    const record = store.database.prepare("SELECT * FROM archive_segments").get();
    meta(store.database, "history_archive_event_revisions", {
      formatVersion: 1,
      revisions: [
        {
          segmentId: record.segment_id,
          databaseSha256: record.database_sha256,
          sourceIdentity: {
            ...store.database
              .prepare("SELECT path,kind,home_id,home_label,home_path FROM source_files WHERE path=?")
              .get(original.source_path),
          },
          removed: [{ payload, count: 1 }],
          added: [{ payload: { ...payload, total: 90, input: 90 }, count: 1 }],
        },
      ],
    });
    const expected = await components(store);
    assert.equal(expected.summary.totals.total, 234);
    equivalent(await store.dashboardHistory(filters), expected);
  } finally {
    f.cleanup();
  }
});

test("verified metadata shares unexcluded timeline facts while keeping future observations and full inventory", {
  skip: !sqlSupported,
}, async () => {
  const f = await fixture();
  const originalMetadata = UsageStore.prototype.metadata;
  try {
    for (const scope of [
      filters,
      { ...filters, now: new Date("2031-01-01T12:00:00Z") },
      { ...filters, excludeHomes: ["a"] },
    ]) {
      f.store.historySqlDashboardCache?.store.close();
      f.store.historySqlDashboardCache = null;
      const queries = [];
      UsageStore.prototype.metadata = function (...args) {
        const database = this.database;
        const prepare = database.prepare;
        database.prepare = function (sql) {
          if (
            sql === "SELECT DISTINCT channel, model FROM events" ||
            sql.startsWith("SELECT channel, model, home_id, MAX(timestamp_ms)")
          )
            queries.push(sql);
          return prepare.call(this, sql);
        };
        try {
          return originalMetadata.apply(this, args);
        } finally {
          database.prepare = prepare;
        }
      };
      const actual = await f.store.dashboardHistory(scope);
      UsageStore.prototype.metadata = originalMetadata;
      assert.deepEqual(actual.metadata, await f.store.metadataHistory(scope.now));
      assert.equal(queries.filter((sql) => sql.includes("DISTINCT")).length, scope.excludeHomes ? 1 : 0);
      assert.equal(
        queries.filter((sql) => sql.includes("MAX(timestamp_ms)") && !sql.includes("WHERE")).length,
        scope.excludeHomes ? 1 : 0,
      );
      assert.equal(
        queries.filter((sql) => sql.includes("WHERE timestamp_ms <= ?")).length,
        scope.now.getUTCFullYear() < 2030 ? 1 : 0,
      );
      if (scope.excludeHomes) {
        assert.equal(actual.summary.eventCount, 2);
        assert.equal(actual.metadata.eventCount, 5, "metadata inventory retains excluded homes");
      }
    }
  } finally {
    UsageStore.prototype.metadata = originalMetadata;
    f.cleanup();
  }
});

test("verified repository periods share the fact scan and fall back across a calendar and price change", {
  skip: !sqlSupported,
}, async () => {
  const f = await fixture();
  const catalog = getPricingCatalog();
  const originalPeriod = UsageStore.prototype.periodComparison;
  const aggregate = UsageStore.prototype.periodAggregate;
  let repositoryAggregates = 0;
  UsageStore.prototype.periodAggregate = function (...args) {
    if (this.verifiedHistorySqlRead && args[0] === "repository_key") repositoryAggregates += 1;
    return aggregate.apply(this, args);
  };
  UsageStore.prototype.periodComparison = function (options = {}) {
    const result = originalPeriod.call(this, options);
    if (this.verifiedHistorySqlRead) {
      const ranges = Object.fromEntries(
        result.periods.map(({ key, start, end }) => [
          key,
          {
            start: start ? new Date(start) : null,
            end: end ? new Date(end) : null,
          },
        ]),
      );
      assert.deepEqual(
        result.repositories,
        aggregate.call(this, "repository_key", "repository_path", new Date(options.now), ranges, {
          includeKind: true,
          excludeHomes: options.excludeHomes,
          pricingModels: options.pricingModels,
        }),
      );
    }
    return result;
  };
  try {
    f.store.database.exec("UPDATE events SET reconciliation_gap=7,detail_mask=31 WHERE id=4");
    f.store.commitStoreRevision("period-fixture");
    for (const scope of [filters, { ...filters, calendarZone: "local" }, { ...filters, excludeHomes: ["a"] }]) {
      f.store.historySqlDashboardCache?.store.close();
      f.store.historySqlDashboardCache = null;
      repositoryAggregates = 0;
      const result = await f.store.dashboardHistory(scope);
      assert.equal(repositoryAggregates, 0, "first complete scope must reuse repository period facts");
      if (!scope.excludeHomes) assert.equal(result.periodComparison.repositories[0].periods.all.reconciliationGap, 7);
    }
    await f.store.dashboardHistory(filters);
    const rates = structuredClone(catalog);
    rates.models["gpt-6-sol"].short.input *= 2;
    setPricingCatalog(rates);
    const later = { ...filters, now: new Date("2026-03-02T12:00:00Z") };
    repositoryAggregates = 0;
    const after = await f.store.dashboardHistory(later);
    assert.equal(repositoryAggregates, 1, "new calendar bounds must not reuse earlier period buckets");
    assert.equal(after.periodComparison.repositories[0].periods.month.total, 0);
    repositoryAggregates = 0;
    assert.deepEqual(await f.store.dashboardHistory(later), after);
    assert.equal(repositoryAggregates, 0, "the new complete period cache remains reusable");
  } finally {
    UsageStore.prototype.periodComparison = originalPeriod;
    UsageStore.prototype.periodAggregate = aggregate;
    setPricingCatalog(catalog);
    f.cleanup();
  }
});

test("SQL history reprices unchanged facts and still rejects missing or damaged cached segments", {
  skip: !sqlSupported,
}, async () => {
  const f = await fixture();
  const catalog = getPricingCatalog();
  const sha = digest(f.segment);
  try {
    const before = await f.store.dashboardHistory(filters);
    const reader = f.store.historySqlDashboardCache.store;
    let rebuiltFacts = 0;
    let costReads = 0;
    assert.ok(
      reader.summaryProjectionCache.quoteInputs?.complete,
      "first verified read publishes complete quote input",
    );
    const costEvents = reader.costEventsForRange;
    reader.costEventsForRange = function (...args) {
      costReads += 1;
      return costEvents.apply(this, args);
    };
    let rebuiltRepositories = 0;
    const timeline = reader.timelineRange;
    reader.timelineRange = function (...args) {
      if (!args[2]?.factRows) rebuiltFacts += 1;
      return timeline.apply(this, args);
    };
    const repositories = reader.repositoriesRange;
    reader.repositoriesRange = function (...args) {
      rebuiltRepositories += 1;
      return repositories.apply(this, args);
    };
    const changed = structuredClone(catalog);
    changed.models["gpt-6-sol"].currency = "CNY";
    changed.models["gpt-6-sol"].short.input *= 4;
    setPricingCatalog(changed);
    const after = await f.store.dashboardHistory(filters);
    assert.equal(f.store.historySqlDashboardCache.store, reader, "the verified reader survives repricing");
    assert.equal(rebuiltFacts, 0);
    assert.equal(rebuiltRepositories, 0);
    assert.equal(costReads, 0, "verified cold repricing avoids decoding the same SQL facts again");
    assert.deepEqual(after.summary.repositories, before.summary.repositories);
    assert.ok(after.summary.costEstimate.totalCny > 0);
    assert.notDeepEqual(after.summary.costEstimate, before.summary.costEstimate);
    const repricedCache = reader.summaryProjectionCache;
    reader.summaryProjectionCache = null;
    assert.deepEqual(after, await f.store.dashboardHistory(filters), "every repriced field equals a full SQL rebuild");
    reader.summaryProjectionCache = repricedCache;

    fs.renameSync(f.segment, `${f.segment}.moved`);
    await assert.rejects(f.store.dashboardHistory(filters), /ENOENT/);
    fs.renameSync(`${f.segment}.moved`, f.segment);
    assert.deepEqual(await f.store.dashboardHistory(filters), after);
    const sealed = fs.readFileSync(f.segment);
    const damaged = Buffer.from(sealed);
    damaged[damaged.length - 1] ^= 1;
    try {
      fs.writeFileSync(f.segment, damaged);
      await assert.rejects(f.store.dashboardHistory(filters), { code: "HISTORY_BACKUP_DIGEST_MISMATCH" });
    } finally {
      fs.writeFileSync(f.segment, sealed);
    }
    assert.deepEqual(await f.store.dashboardHistory(filters), after);
    assert.equal(digest(f.segment), sha);
  } finally {
    setPricingCatalog(catalog);
    f.cleanup();
  }
});

test("verified SQL uses indexed physical bounds and complete rollups, falling back when markers are missing", {
  skip: !sqlSupported,
}, async () => {
  const f = await fixture(true);
  const prepare = DatabaseSync.prototype.prepare;
  const queries = [];
  const plans = [];
  try {
    f.store.database.exec("DELETE FROM events WHERE timestamp_ms > 1900000000000");
    await f.store.rebuildHistoryRollups();
    const expected = await components(f.store);
    DatabaseSync.prototype.prepare = function (sql, ...args) {
      queries.push(sql.replace(/\s+/g, " ").trim());
      if (sql.includes("SELECT MIN(minimum) AS minimum")) {
        plans.push(...prepare.call(this, `EXPLAIN QUERY PLAN ${sql}`).all());
      }
      return prepare.call(this, sql, ...args);
    };
    equivalent(await f.store.dashboardHistory(filters), expected);
    DatabaseSync.prototype.prepare = prepare;
    assert.equal(
      queries.filter((sql) =>
        sql.startsWith("SELECT MIN(timestamp_ms) AS minimum, MAX(timestamp_ms) AS maximum FROM events"),
      ).length,
      0,
      "the verified union does not rescan full events for each boundary lookup",
    );
    assert.ok(plans.length > 0);
    assert.ok(
      plans.some((row) => /SEARCH .*events.*events_timestamp_idx/.test(row.detail)),
      "physical timestamp indexes serve the bounds",
    );
    assert.ok(
      !queries.some(
        (sql) => sql === "SELECT COUNT(*) AS event_count, COUNT(DISTINCT session_id) AS session_count FROM events",
      ),
      "complete logical rollups serve metadata counts",
    );
    f.store.database.exec("DELETE FROM usage_rollup_days");
    equivalent(await f.store.dashboardHistory(filters), await components(f.store));
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    f.cleanup();
  }
});

test("hot writes during verification and pinned publications retain coherent reads and release WAL", {
  skip: !sqlSupported,
}, async () => {
  const f = await fixture();
  const { store, segment } = f;
  const createReadStream = fs.createReadStream;
  let hook = null;
  try {
    fs.createReadStream = function (file, ...args) {
      if (path.resolve(String(file)) === segment && hook) {
        const once = hook;
        hook = null;
        once();
      }
      return createReadStream.call(this, file, ...args);
    };
    syncBuiltinESMExports();
    await store.dashboardHistory(filters);
    hook = () => store.database.exec("UPDATE events SET total=40,input=40 WHERE id=4");
    const changed = await store.dashboardHistory(filters);
    assert.equal(changed.summary.totals.total, 254);
    equivalent(changed, await components(store));
    equivalent(await store.dashboardHistory(filters), changed);
    store.database.exec("BEGIN");
    store.database.prepare("SELECT id FROM events LIMIT 1").get();
    hook = () => {
      const writer = new DatabaseSync(store.databaseFile);
      try {
        writer.exec("UPDATE events SET total=50,input=50 WHERE id=4");
      } finally {
        writer.close();
      }
    };
    const pinned = await store.dashboardHistory(filters);
    assert.equal(pinned.summary.totals.total, 254, "published reader stays on its earlier revision");
    store.database.exec("ROLLBACK");
    assert.equal((await store.dashboardHistory(filters)).summary.totals.total, 264);
    assert.equal(checkpointUsageStore(store.database).busy, 0, "internal read transactions have all closed");
    fs.renameSync(segment, `${segment}.moved`);
    await assert.rejects(store.dashboardHistory(filters), /ENOENT/);
    fs.renameSync(`${segment}.moved`, segment);
    assert.equal((await store.dashboardHistory(filters)).summary.totals.total, 264);
    const sealed = fs.readFileSync(segment);
    const damaged = Buffer.from(sealed);
    damaged[damaged.length - 1] ^= 1;
    try {
      fs.writeFileSync(segment, damaged);
      await assert.rejects(store.dashboardHistory(filters), { code: "HISTORY_BACKUP_DIGEST_MISMATCH" });
    } finally {
      fs.writeFileSync(segment, sealed);
    }
    assert.equal((await store.dashboardHistory(filters)).summary.totals.total, 264);
  } finally {
    fs.createReadStream = createReadStream;
    syncBuiltinESMExports();
    f.cleanup();
  }
});

test("event-only SQL history keeps live ZCode perf and its full coverage", { skip: !sqlSupported }, async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const options = { ...fixture.serverOptions, databaseFile: path.join(fixture.serverOptions.homeDir, "sql.sqlite") };
  const store = new UsageStore(options);
  const segment = path.join(fixture.serverOptions.homeDir, "sql-cold.sqlite");
  try {
    await store.sync({ options });
    const startMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS n FROM events").get().n);
    const endMs = Date.parse("2026-10-04T12:00:00Z");
    await createHistoryArchiveCandidate(store.database, segment, { startMs, endMs });
    const registered = await store.registerHistoryArchiveCandidate(segment);
    meta(store.database, "history_archive_event_authority", { formatVersion: 1, segmentIds: [registered.segmentId] });
    store.database.prepare("DELETE FROM events WHERE timestamp_ms>=? AND timestamp_ms<?").run(startMs, endMs);
    const scope = { ...filters, now: new Date("2026-10-05T12:00:00Z") };
    const expected = await components(store, scope);
    assert.ok(expected.summary.perf.coverage.sampled > 0);
    equivalent(await store.dashboardHistory(scope), expected);
    equivalent(await store.dashboardHistory(scope), expected);
    assert.ok(store.historySqlDashboardCache, "event-only authority takes the SQL path");
  } finally {
    store.close();
    fixture.close();
  }
});
