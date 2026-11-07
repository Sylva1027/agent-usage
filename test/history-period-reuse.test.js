import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { getPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { readHistoryProjectionStamp, recordHistoryProjectionBatch } from "../src/usage-history-projection-store.js";
import { UsageStore } from "../src/usage-store.js";

const DAY = 86_400_000;
const START = Date.parse("2026-11-01T00:00:00Z");
const FILTERS = { preset: "today", calendarZone: "utc", now: new Date("2026-11-07T12:00:00Z") };
const OPTIONS = { includeDetails: false };

async function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "history-period-reuse-"));
  const databaseFile = path.join(directory, "usage.sqlite");
  const store = new UsageStore({ databaseFile, homeDir: directory, env: {}, importDirs: [] });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await store.open();
  store.serviceTierEvidenceInput = "period-reuse-fixture";
  store.homes = ["a", "b"].map((id) => ({ id, label: id, path: directory, kind: "codex" }));
  const sources = ["a", "b"].map((id) => path.join(directory, `${id}.jsonl`));
  for (const [index, source] of sources.entries())
    store.database
      .prepare("INSERT INTO source_files VALUES(?,?,?,?,?,?,?,?)")
      .run(source, "codex", store.homes[index].id, store.homes[index].label, directory, 1, 1, "fixture");
  const insert = (database, day, total, sourceIndex = 0) =>
    database
      .prepare(`INSERT INTO events(
    source_path,timestamp_ms,session_id,home_id,home_label,channel,project,model,cwd,
    hour_key,day_key,week_key,month_key,total,input,cached,output,reasoning,detail_mask)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        sources[sourceIndex],
        START + day * DAY + 1000,
        "shared-session",
        store.homes[sourceIndex].id,
        store.homes[sourceIndex].label,
        "CLI",
        "fixture",
        sourceIndex ? "Period-Reuse-Future" : "gpt-6-sol",
        path.join(directory, `project-${sourceIndex}`),
        "2026-11-01 00",
        "2026-11-01",
        "2026-10-26",
        "2026-11",
        total,
        total - 3,
        1,
        3,
        0,
        15,
      );
  for (const day of [0, 1, 6]) for (const index of [0, 1]) insert(store.database, day, 10 + day + index, index);
  const packages = [];
  for (const day of [0, 1]) {
    const file = path.join(directory, `archive-${day}.sqlite`);
    await createHistoryArchiveCandidate(store.database, file, {
      startMs: START + day * DAY,
      endMs: START + (day + 1) * DAY,
    });
    packages.push(file);
  }
  for (const file of packages)
    await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, file));
  let aggregations = 0;
  const aggregate = UsageStore.prototype.periodAggregate;
  t.mock.method(UsageStore.prototype, "periodAggregate", function (...args) {
    if (this.historyPersistentRead && args[0] === "model") aggregations++;
    return aggregate.apply(this, args);
  });
  const oracle = async (filters = FILTERS, dashboard = false) => {
    const other = new UsageStore({ databaseFile, homeDir: directory, env: {}, importDirs: [] });
    other.database = new DatabaseSync(databaseFile, { readOnly: true });
    other.registerReadFunctions();
    other.homes = structuredClone(store.homes);
    other.serviceTierEvidenceInput = store.serviceTierEvidenceInput;
    other.usageProjectionDatabaseIdentity = () => null;
    try {
      return dashboard ? await other.dashboardHistory(filters, OPTIONS) : await other.periodComparisonHistory(filters);
    } finally {
      other.close();
    }
  };
  return {
    store,
    sources,
    packages,
    insert,
    oracle,
    get aggregations() {
      return aggregations;
    },
  };
}

test("two real archives reuse one period aggregation from today to all with exact dashboard parity", async (t) => {
  const f = await fixture(t);
  const today = await f.store.dashboardHistory(FILTERS, OPTIONS);
  assert.deepEqual(today, await f.oracle(FILTERS, true));
  assert.equal(today.summary.totals.total, 33);
  assert.equal(today.periodComparison.totals.all.total, 77);
  assert.equal(f.aggregations, 1);
  const retained = f.store.historyPeriodComparisonCache;
  assert.equal(retained.cache.size, 1);
  const allFilters = { ...FILTERS, preset: "all", now: new Date("2026-11-07T23:00:00Z") };
  const all = await f.store.dashboardHistory(allFilters, OPTIONS);
  assert.deepEqual(all, await f.oracle(allFilters, true));
  assert.equal(f.store.lastHistoryQueryWork.projection.reused, true);
  assert.equal(f.aggregations, 1, "switching presets on the same business day must not aggregate again");
  assert.equal(f.store.historyPeriodComparisonCache.cache, retained.cache, "retain the original Map without copying");
  assert.equal(all.periodComparison.asOf, "2026-11-07T23:00:00.000Z");
  all.periodComparison.totals.all.total = -1;
  assert.deepEqual(await f.store.periodComparisonHistory(allFilters), await f.oracle(allFilters));
  assert.equal(f.aggregations, 1, "returned values cannot mutate the retained scope");
  assert.equal(f.store.periodComparison(FILTERS).totals.all.total, 33, "hot-only cache stays independent");
});

test("a certified append and unknown external writes invalidate period facts", async (t) => {
  const f = await fixture(t);
  await f.store.periodComparisonHistory(FILTERS);
  const original = f.store.historyPeriodComparisonCache;
  const before = readHistoryProjectionStamp(f.store.database);
  f.store.database.exec("BEGIN IMMEDIATE");
  f.insert(f.store.database, 6, 19);
  recordHistoryProjectionBatch(f.store.database, before, { sources: [f.sources[0]], mode: "append" });
  f.store.database.exec("COMMIT");
  const appended = await f.store.periodComparisonHistory(FILTERS);
  assert.equal(f.aggregations, 2);
  assert.equal(f.store.lastHistoryQueryWork.projection.reused, false);
  assert.equal(f.store.lastHistoryQueryWork.projection.delta.added, 1);
  assert.equal(original.cache.size, 0);
  assert.equal(f.store.historyPeriodComparisonCache.query, original.query, "delta can keep the same query object");
  assert.equal(appended.totals.all.total, 96);
  assert.deepEqual(appended, await f.oracle());
  await f.store.periodComparisonHistory(FILTERS);
  assert.equal(f.aggregations, 2);

  const external = new DatabaseSync(f.store.databaseFile);
  try {
    external.exec("UPDATE events SET total=total+1,input=input+1");
    assert.deepEqual(await f.store.periodComparisonHistory(FILTERS), await f.oracle());
    assert.equal(f.aggregations, 3);
    assert.equal(f.store.lastHistoryQueryWork.projection.rebuilt, true, "unknown fact writes still rebuild");
    const stamp = readHistoryProjectionStamp(f.store.database);
    external.exec("INSERT INTO store_meta VALUES('unknown-external-period-input','changed')");
    assert.deepEqual(readHistoryProjectionStamp(f.store.database), stamp);
    assert.deepEqual(await f.store.periodComparisonHistory(FILTERS), await f.oracle());
    assert.equal(f.store.lastHistoryQueryWork.projection.reused, true);
    assert.equal(f.aggregations, 4, "an external commit invalidates even when its tracked stamp is unchanged");
  } finally {
    external.close();
  }
});

test("replacing the query and closing the store discard the retained period scope", async (t) => {
  const f = await fixture(t);
  const expected = await f.store.periodComparisonHistory(FILTERS);
  const original = f.store.historyPeriodComparisonCache;
  f.store.historyProjectionStore.close();
  assert.deepEqual(await f.store.periodComparisonHistory(FILTERS), expected);
  assert.equal(f.store.lastHistoryQueryWork.projection.reused, true);
  assert.notEqual(f.store.historyPeriodComparisonCache.query, original.query);
  assert.equal(original.cache.size, 0);
  assert.equal(f.aggregations, 2);
  const retained = f.store.historyPeriodComparisonCache;
  f.store.close();
  assert.equal(f.store.historyPeriodComparisonCache, null);
  assert.equal(retained.cache.size, 0);
  assert.deepEqual(await f.store.periodComparisonHistory(FILTERS), await f.oracle());
  assert.equal(f.store.lastHistoryQueryWork.projection.reused, true);
  assert.equal(f.aggregations, 3, "disk facts survive close, the period cache does not");
});

test("model catalog, exclusions, business date and zone keep one scope and invalidate by dependency", async (t) => {
  const f = await fixture(t);
  const catalog = getPricingCatalog();
  t.after(() => setPricingCatalog(catalog));
  const first = await f.store.periodComparisonHistory(FILTERS);
  const rates = structuredClone(catalog);
  rates.models["gpt-6-sol"].short.input *= 4;
  rates.usdToCnyRate *= 2;
  setPricingCatalog(rates);
  assert.deepEqual(await f.store.periodComparisonHistory(FILTERS), first);
  assert.equal(f.aggregations, 1, "period facts contain no prices or FX amounts");
  rates.models["period-reuse-future"] = structuredClone(rates.models["gpt-6-sol"]);
  setPricingCatalog(rates);
  const mapped = await f.store.periodComparisonHistory(FILTERS);
  assert.deepEqual(mapped, await f.oracle());
  assert.ok(mapped.models.some((model) => model.name === "period-reuse-future"));
  assert.equal(f.aggregations, 2, "model normalization depends on the catalog keys");
  for (const filters of [
    { ...FILTERS, excludeHomes: ["b"] },
    FILTERS,
    { ...FILTERS, now: "2026-11-08T12:00:00Z" },
    { ...FILTERS, now: "2026-11-08T12:00:00Z", calendarZone: "local" },
  ]) {
    const calls = f.aggregations;
    assert.deepEqual(await f.store.periodComparisonHistory(filters), await f.oracle(filters));
    assert.equal(f.aggregations, calls + 1);
    assert.equal(f.store.historyPeriodComparisonCache.cache.size, 1);
  }
});

test("a local calendar change invalidates the same query and recalendars its projection", async (t) => {
  const previousZone = process.env.TZ;
  t.after(() => {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  });
  process.env.TZ = "Etc/UTC";
  const f = await fixture(t);
  const filters = { ...FILTERS, calendarZone: "local" };
  await f.store.periodComparisonHistory(filters);
  const original = f.store.historyPeriodComparisonCache;
  process.env.TZ = "Pacific/Honolulu";
  assert.deepEqual(await f.store.periodComparisonHistory(filters), await f.oracle(filters));
  assert.equal(f.store.historyPeriodComparisonCache.query, original.query);
  assert.equal(f.store.lastHistoryQueryWork.projection.recalendar, true);
  assert.equal(original.cache.size, 0);
  assert.equal(f.aggregations, 2);
});

test("archive revisions invalidate cached periods and source identity conflicts still reject", async (t) => {
  const f = await fixture(t);
  await f.store.periodComparisonHistory(FILTERS);
  const original = f.store.historyPeriodComparisonCache;
  const cold = new DatabaseSync(f.packages[0], { readOnly: true });
  const { id: _id, ...payload } = cold.prepare("SELECT * FROM events ORDER BY id LIMIT 1").get();
  cold.close();
  const segment = f.store.database.prepare("SELECT * FROM archive_segments ORDER BY start_ms LIMIT 1").get();
  const sourceIdentity = {
    ...f.store.database
      .prepare("SELECT path,kind,home_id,home_label,home_path FROM source_files WHERE path=?")
      .get(payload.source_path),
  };
  const before = readHistoryProjectionStamp(f.store.database);
  f.store.database.exec("BEGIN IMMEDIATE");
  f.store.writeMeta(
    "history_archive_event_revisions",
    JSON.stringify({
      formatVersion: 1,
      revisions: [
        {
          segmentId: segment.segment_id,
          databaseSha256: segment.database_sha256,
          sourceIdentity,
          removed: [{ payload, count: 1 }],
          added: [
            { payload: { ...payload, total: Number(payload.total) + 7, input: Number(payload.input) + 7 }, count: 1 },
          ],
        },
      ],
    }),
  );
  recordHistoryProjectionBatch(f.store.database, before, { sources: [payload.source_path], mode: "replace" });
  f.store.database.exec("COMMIT");
  assert.deepEqual(await f.store.periodComparisonHistory(FILTERS), await f.oracle());
  assert.equal(f.aggregations, 2);
  assert.equal(original.cache.size, 0);
  assert.equal(f.store.historyPeriodComparisonCache.query, original.query);
  const retained = f.store.historyPeriodComparisonCache;
  f.store.database.prepare("UPDATE source_files SET home_label='wrong identity' WHERE path=?").run(payload.source_path);
  await assert.rejects(f.store.periodComparisonHistory(FILTERS), { code: "HISTORY_ARCHIVE_HOT_COLD_CONFLICT" });
  assert.equal(f.store.historyPeriodComparisonCache, null);
  assert.equal(retained.cache.size, 0);
});

test("warm period hits still verify missing and changed archive bytes and discard failures", async (t) => {
  const f = await fixture(t);
  const expected = await f.store.periodComparisonHistory(FILTERS);
  const file = f.packages[0];
  const retained = f.store.historyPeriodComparisonCache;
  renameSync(file, `${file}.missing`);
  try {
    await assert.rejects(f.store.periodComparisonHistory(FILTERS), /ENOENT/);
    assert.equal(retained.cache.size, 0);
    assert.equal(f.store.historyPeriodComparisonCache, null);
  } finally {
    renameSync(`${file}.missing`, file);
  }
  assert.deepEqual(await f.store.periodComparisonHistory(FILTERS), expected);
  const bytes = readFileSync(file);
  try {
    const changed = Buffer.from(bytes);
    changed[changed.length - 1] ^= 1;
    writeFileSync(file, changed);
    await assert.rejects(f.store.periodComparisonHistory(FILTERS));
    assert.equal(f.store.historyPeriodComparisonCache, null);
  } finally {
    writeFileSync(file, bytes);
  }
  assert.deepEqual(await f.store.periodComparisonHistory(FILTERS), expected);
  assert.equal(f.aggregations, 3, "failed verification cannot preserve a warm period result");
});

test("the complete orphan check accepts repeated source paths and rejects a missing path on reuse", async (t) => {
  const f = await fixture(t);
  await f.store.periodComparisonHistory(FILTERS);
  const retained = f.store.historyPeriodComparisonCache;
  const database = retained.query.database;
  assert.equal(database.prepare("SELECT COUNT(*) n FROM events").get().n, 6);
  assert.equal(database.prepare("SELECT COUNT(DISTINCT source_path) n FROM events").get().n, 2);
  const sql =
    "SELECT 1 FROM (SELECT DISTINCT source_path FROM events) e WHERE NOT EXISTS (SELECT 1 FROM source_files sf WHERE sf.path=e.source_path) LIMIT 1";
  assert.equal(database.prepare(sql).get(), undefined);
  database.exec(`PRAGMA foreign_keys=OFF;
    UPDATE events SET source_path='missing-source' WHERE id=(SELECT MAX(id) FROM events);
    PRAGMA foreign_keys=ON`);
  assert.ok(database.prepare(sql).get());
  await assert.rejects(f.store.periodComparisonHistory(FILTERS), { code: "HISTORY_ARCHIVE_SOURCE_CHANGED" });
  assert.equal(f.store.historyPeriodComparisonCache, null);
  assert.equal(retained.cache.size, 0);
  assert.equal(f.aggregations, 1, "orphan rejection precedes a cached business read");
});
