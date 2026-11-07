import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import {
  HistoryProjectionStore,
  readHistoryProjectionStamp,
  recordHistoryProjectionBatch,
} from "../src/usage-history-projection-store.js";
import { UsageStore } from "../src/usage-store.js";

const DAY = 86400000,
  START = Date.parse("2026-01-01T00:00:00Z");
const FILTERS = { preset: "all", calendarZone: "utc", now: new Date("2026-01-05T12:00:00Z") };
const OPTIONS = { includeDetails: false };
const clean = (value) => JSON.parse(JSON.stringify(value, (key, item) => (key === "generatedAt" ? undefined : item)));

async function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "history-projection-store-"));
  const file = path.join(directory, "source.sqlite"),
    sourcePath = path.join(directory, "missing.jsonl");
  const open = async (oracle = false) => {
    const store = new UsageStore({ databaseFile: file, homeDir: directory, env: {}, importDirs: [] });
    await store.open();
    store.serviceTierEvidenceInput = "projection-fixture";
    store.homes = [{ id: "home", label: "Home", path: directory, kind: "codex" }];
    if (oracle) store.usageProjectionDatabaseIdentity = () => null;
    return store;
  };
  let store = await open();
  store.database
    .prepare("INSERT INTO source_files VALUES(?,?,?,?,?,?,?,?)")
    .run(sourcePath, "codex", "home", "Home", directory, 1, 1, "fixture");
  const insert = (db, time, total) =>
    db
      .prepare(`INSERT INTO events(
    source_path,timestamp_ms,session_id,home_id,home_label,channel,project,model,
    hour_key,day_key,week_key,month_key,total,input,cached,output,reasoning)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        sourcePath,
        time,
        "shared-session",
        "home",
        "Home",
        "CLI",
        "fixture",
        "gpt-6-sol",
        "2026-01-01 00",
        "2026-01-01",
        "2025-12-29",
        "2026-01",
        total,
        total - 3,
        1,
        3,
        0,
      );
  for (let day = 0; day < 3; day++) insert(store.database, START + day * DAY + 1000, 10 + day);
  await store.rebuildHistoryRollups();
  const packages = [];
  for (let day = 0; day < 3; day++) {
    const candidate = path.join(directory, `segment-${day}.sqlite`);
    await createHistoryArchiveCandidate(store.database, candidate, {
      startMs: START + day * DAY,
      endMs: START + (day + 1) * DAY,
    });
    packages.push(candidate);
  }
  for (const candidate of packages.slice(0, 2))
    await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, candidate));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    file,
    directory,
    sourcePath,
    packages,
    insert,
    get store() {
      return store;
    },
    async reopen() {
      store.close();
      store = await open();
      return store;
    },
    async oracle(filters = FILTERS) {
      const other = await open(true);
      try {
        return await other.dashboardHistory(filters, OPTIONS);
      } finally {
        other.close();
      }
    },
  };
}

test("unchanged multi-package reads and real service-store reopen reuse completed disk facts", async (t) => {
  const f = await fixture(t),
    cursorTransactions = [],
    prepare = DatabaseSync.prototype.prepare;
  const publish = HistoryProjectionStore.prototype.publish;
  const execute = DatabaseSync.prototype.exec;
  let metadataIndexes = 0;
  t.mock.method(DatabaseSync.prototype, "exec", function (sql) {
    metadataIndexes += [...sql.matchAll(/CREATE INDEX events_metadata_group_time_idx\b/g)].length;
    return execute.call(this, sql);
  });
  await f.store.rebuildHistoryRollups();
  let copiedRollups,
    projectionDatabase,
    rollupFactRebuilds = 0;
  t.mock.method(HistoryProjectionStore.prototype, "publish", function (source, prepared, ...args) {
    projectionDatabase = prepared.query.database;
    copiedRollups = {
      daily: Number(prepared.query.database.prepare("SELECT COUNT(*) n FROM usage_rollup_daily").get().n),
      sourceDaily: Number(source.prepare("SELECT COUNT(*) n FROM usage_rollup_daily").get().n),
      source: Number(source.prepare("SELECT COUNT(*) n FROM usage_rollup_models").get().n),
      derived: Number(prepared.query.database.prepare("SELECT COUNT(*) n FROM usage_rollup_models").get().n),
      progress: prepared.query.database.prepare("SELECT * FROM usage_rollup_progress").get(),
      progressDays: Number(
        prepared.query.database.prepare("SELECT COUNT(*) n FROM usage_rollup_progress_days").get().n,
      ),
    };
    return publish.call(this, source, prepared, ...args);
  });
  t.mock.method(DatabaseSync.prototype, "prepare", function (sql) {
    if (this === projectionDatabase && /INSERT INTO usage_rollup_daily/.test(sql) && /FROM events/.test(sql))
      rollupFactRebuilds++;
    const statement = prepare.call(this, sql);
    if (sql.startsWith("INSERT INTO usage_history_projection_sources ")) {
      const database = this,
        run = statement.run;
      statement.run = function (...args) {
        cursorTransactions.push(database.isTransaction);
        return run.apply(this, args);
      };
    }
    return statement;
  });
  const first = await f.store.dashboardHistory(FILTERS, OPTIONS);
  assert.equal(metadataIndexes, 1, "fresh metadata retains its one bulk-built lookup index");
  assert.ok(copiedRollups.source > 0);
  assert.ok(copiedRollups.sourceDaily > 0);
  assert.equal(copiedRollups.daily, copiedRollups.sourceDaily);
  assert.equal(copiedRollups.derived, copiedRollups.source, "existing complete rollups precede business preparation");
  assert.equal(
    copiedRollups.progress.certified,
    0,
    "physical event-id progress must be certified against the new projection",
  );
  assert.equal(copiedRollups.progress.last_id, 0);
  assert.equal(copiedRollups.progressDays, 0);
  assert.equal(rollupFactRebuilds, 0, "complete copied rollups must survive initial maintenance");
  assert.ok(cursorTransactions.length > 0);
  assert.ok(cursorTransactions.every(Boolean), "source cursors must share the initialization transaction");
  assert.equal(f.store.lastHistoryQueryWork.projection.rebuilt, true);
  const second = await f.store.dashboardHistory(FILTERS, OPTIONS);
  assert.equal(f.store.lastHistoryQueryWork.projection.reused, true);
  assert.equal(f.store.lastHistoryQueryWork.projection.coldCopied, 0);
  assert.equal(f.store.lastHistoryQueryWork.views.all.readEvents, 0);
  assert.equal(f.store.lastHistoryQueryWork.views.all.pricedEvents, 0);
  assert.equal(f.store.lastHistoryQueryWork.views.metadata.readEvents, 0);
  assert.deepEqual(clean(second), clean(first));
  await f.reopen();
  assert.deepEqual(clean(await f.store.dashboardHistory(FILTERS, OPTIONS)), clean(first));
  assert.equal(f.store.lastHistoryQueryWork.projection.reused, true);
  assert.equal(f.store.lastHistoryQueryWork.views.all.readEvents, 0);
  assert.equal(f.store.lastHistoryQueryWork.views.metadata.readEvents, 0);
});

test("known source append and late insert preserve complete anonymous-reader parity without cold copying", async (t) => {
  const f = await fixture(t);
  await f.store.dashboardHistory(FILTERS, OPTIONS);
  for (const time of [START + 4 * DAY + 1000, START + 3 * DAY + 1000]) {
    const before = readHistoryProjectionStamp(f.store.database);
    f.store.database.exec("BEGIN IMMEDIATE");
    f.insert(f.store.database, time, 17);
    recordHistoryProjectionBatch(f.store.database, before, { sources: [f.sourcePath], mode: "append" });
    f.store.database.exec("COMMIT");
    const result = await f.store.dashboardHistory(FILTERS, OPTIONS);
    assert.equal(f.store.lastHistoryQueryWork.projection.rebuilt, false);
    assert.equal(f.store.lastHistoryQueryWork.projection.coldCopied, 0);
    assert.equal(f.store.lastHistoryQueryWork.projection.delta.added, 1);
    assert.deepEqual(clean(result), clean(await f.oracle()));
  }
});

test("a cold value revision changes only that source payload and matches the anonymous oracle", async (t) => {
  const f = await fixture(t);
  await f.store.dashboardHistory(FILTERS, OPTIONS);
  const cold = new DatabaseSync(f.packages[0], { readOnly: true });
  const row = { ...cold.prepare("SELECT * FROM events LIMIT 1").get() };
  cold.close();
  delete row.id;
  const changed = { ...row, total: Number(row.total) + 7, output: Number(row.output) + 7 };
  const segment = f.store.database.prepare("SELECT * FROM archive_segments ORDER BY start_ms LIMIT 1").get();
  const source = {
    ...f.store.database
      .prepare("SELECT path,kind,home_id,home_label,home_path FROM source_files WHERE path=?")
      .get(f.sourcePath),
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
          sourceIdentity: source,
          removed: [{ payload: row, count: 1 }],
          added: [{ payload: changed, count: 1 }],
        },
      ],
    }),
  );
  recordHistoryProjectionBatch(f.store.database, before, { sources: [f.sourcePath], mode: "replace" });
  f.store.database.exec("COMMIT");
  const result = await f.store.dashboardHistory(FILTERS, OPTIONS);
  assert.equal(f.store.lastHistoryQueryWork.projection.rebuilt, false);
  assert.equal(f.store.lastHistoryQueryWork.projection.delta.added, 1);
  assert.equal(f.store.lastHistoryQueryWork.projection.delta.removed, 1);
  assert.deepEqual(clean(result), clean(await f.oracle()));
});

test("unknown writer gaps rebuild once and an owned cache corruption never corrupts source facts", async (t) => {
  const f = await fixture(t);
  await f.store.dashboardHistory(FILTERS, OPTIONS);
  f.insert(f.store.database, START + 4 * DAY + 2000, 17);
  const value = await f.store.dashboardHistory(FILTERS, OPTIONS);
  assert.equal(f.store.lastHistoryQueryWork.projection.rebuilt, true);
  const directory = `${path.resolve(f.file)}.history-cache`;
  f.store.close();
  const pointer = JSON.parse(readFileSync(path.join(directory, "current.json"), "utf8"));
  writeFileSync(path.join(directory, pointer.file), "broken derived cache");
  await f.reopen();
  assert.deepEqual(clean(await f.store.dashboardHistory(FILTERS, OPTIONS)), clean(value));
  assert.equal(f.store.lastHistoryQueryWork.projection.rebuilt, true);
  assert.equal(f.store.database.prepare("PRAGMA quick_check").get().quick_check, "ok");
});

test("published mixed reader pins only derived WAL and keeps the exact old version during acquisition", async (t) => {
  const f = await fixture(t),
    first = await f.store.dashboardHistory(FILTERS, OPTIONS);
  const published = await f.store.acquirePublishedHistoryReader();
  assert.ok(published?.publishedHistoryProjection);
  try {
    assert.notEqual(published.databaseFile, f.file);
    const before = readHistoryProjectionStamp(f.store.database);
    f.store.database.exec("BEGIN IMMEDIATE");
    f.insert(f.store.database, START + 4 * DAY + 1000, 17);
    recordHistoryProjectionBatch(f.store.database, before, { sources: [f.sourcePath], mode: "append" });
    f.store.database.exec("COMMIT");
    assert.equal(f.store.database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get().busy, 0);
    assert.deepEqual(clean(await published.dashboardHistory(FILTERS, OPTIONS)), clean(first));
    const latest = await f.store.dashboardHistory(FILTERS, OPTIONS);
    assert.equal(latest.summary.eventCount, first.summary.eventCount + 1);
    assert.deepEqual(clean(await published.dashboardHistory(FILTERS, OPTIONS)), clean(first));
  } finally {
    published.close();
  }
  assert.equal(f.store.historyProjectionStore.query.database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get().busy, 0);
});

test("a ready published lease defers full archive proof until consumption", async (t) => {
  const f = await fixture(t);
  await f.store.dashboardHistory(FILTERS, OPTIONS);
  t.mock.method(f.store, "withSqlHistoryReader", () => {
    assert.fail("a matching published lease must not rebuild or verify unused archives");
  });
  const published = await f.store.acquirePublishedHistoryReader();
  assert.ok(published?.publishedHistoryProjection);
  const missing = `${f.packages[0]}.missing`;
  try {
    renameSync(f.packages[0], missing);
    await assert.rejects(published.dashboardHistory(FILTERS, OPTIONS), /ENOENT|archive|missing/i);
  } finally {
    renameSync(missing, f.packages[0]);
    published.close();
  }
});

test("a changed source stamp rejects the ready lease and takes the verified fallback", async (t) => {
  const f = await fixture(t);
  await f.store.dashboardHistory(FILTERS, OPTIONS);
  f.insert(f.store.database, START + 4 * DAY + 2000, 17);
  const original = f.store.withSqlHistoryReader;
  let verified = 0;
  t.mock.method(f.store, "withSqlHistoryReader", function (...args) {
    verified++;
    return original.apply(this, args);
  });
  const published = await f.store.acquirePublishedHistoryReader();
  try {
    assert.ok(verified > 0);
    assert.ok(published?.publishedHistoryProjection);
    const result = await published.dashboardHistory(FILTERS, OPTIONS);
    assert.equal(result.summary.eventCount, 4);
  } finally {
    published?.close();
  }
});

test("the first mixed all prepares records for the following nonempty range", async (t) => {
  const f = await fixture(t);
  await f.store.dashboardHistory(FILTERS, OPTIONS);
  assert.equal(f.store.lastHistoryQueryWork.views.records.pricedEvents, 3);
  const filters = { ...FILTERS, preset: "custom", startDate: "2026-01-02", endDate: "2026-01-03" };
  const result = await f.store.dashboardHistory(filters, OPTIONS);
  assert.ok(result.summary.eventCount > 0);
  assert.equal(f.store.lastHistoryQueryWork.views.records.pricedEvents, 0);
  assert.deepEqual(clean(result), clean(await f.oracle(filters)));
});

test("a known archive authority transfer imports the new package while retaining existing cold facts", async (t) => {
  const f = await fixture(t),
    first = await f.store.dashboardHistory(FILTERS, OPTIONS);
  const candidate = f.packages[2];
  await f.store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(f.store.database, candidate));
  const result = await f.store.dashboardHistory(FILTERS, OPTIONS);
  assert.deepEqual(clean(result), clean(first));
  assert.equal(f.store.lastHistoryQueryWork.projection.rebuilt, false);
  assert.equal(f.store.lastHistoryQueryWork.projection.coldCopied, 1);
  assert.equal(f.store.lastHistoryQueryWork.projection.delta.added, 1);
  assert.equal(f.store.lastHistoryQueryWork.projection.delta.removed, 1);
});

test("registering a mirror retains existing cold facts and rejects a later mismatching hot revision", async (t) => {
  const f = await fixture(t),
    first = await f.store.dashboardHistory(FILTERS, OPTIONS);
  await f.store.registerHistoryArchiveCandidate(f.packages[2]);
  assert.deepEqual(clean(await f.store.dashboardHistory(FILTERS, OPTIONS)), clean(first));
  assert.equal(f.store.lastHistoryQueryWork.projection.rebuilt, false);
  assert.equal(f.store.lastHistoryQueryWork.projection.coldCopied, 0);
  const before = readHistoryProjectionStamp(f.store.database);
  f.store.database.exec("BEGIN IMMEDIATE");
  f.store.database.exec("UPDATE events SET total=total+1");
  recordHistoryProjectionBatch(f.store.database, before, { sources: [f.sourcePath], mode: "replace" });
  f.store.database.exec("COMMIT");
  await assert.rejects(f.store.dashboardHistory(FILTERS, OPTIONS), { code: "HISTORY_ARCHIVE_HOT_COLD_CONFLICT" });
});

test("an empty selected period cannot contain a record champion and prices no history", async (t) => {
  const f = await fixture(t);
  const filters = { ...FILTERS, preset: "today" };
  const result = await f.store.dashboardHistory(filters, OPTIONS);
  assert.equal(result.summary.eventCount, 0);
  assert.deepEqual(result.summary.records, {});
  assert.equal(f.store.lastHistoryQueryWork.views.records.pricedEvents, 0);
  assert.equal(f.store.lastHistoryQueryWork.views.records.emptyRange, true);
  const oracle = new UsageStore({ databaseFile: f.file, homeDir: f.directory, env: {}, importDirs: [] });
  await oracle.open();
  oracle.homes = f.store.homes;
  oracle.serviceTierEvidenceInput = "projection-fixture";
  oracle.usageProjectionDatabaseIdentity = () => null;
  try {
    assert.deepEqual(clean(result), clean(await oracle.dashboardHistory(filters, OPTIONS)));
  } finally {
    oracle.close();
  }
});
