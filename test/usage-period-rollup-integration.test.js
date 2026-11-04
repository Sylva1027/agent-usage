import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { summarizePeriodComparison } from "../public/period-comparison.js";
import { UsageStore } from "../src/usage-store.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "period-rollup-integration-"));
  const options = {
    homeDir: root,
    databaseFile: path.join(root, "usage.sqlite"),
    env: {},
    importDirs: [],
    automaticDiscoveryEnabled: false,
  };
  const store = new UsageStore(options);
  await store.open();
  const kinds = ["main", "dsh", "zcode", "opencode", "claude", "workbuddy"];
  for (const [index, kind] of kinds.entries()) {
    store.database
      .prepare("INSERT INTO source_files VALUES(?,?,?,?,?,?,?,?)")
      .run(`/fixture/${kind}`, kind, kind, kind, `/homes/${kind}`, 1, 1, "fixture");
    for (const timestamp of [
      "2026-10-30T21:00:00Z",
      "2026-11-01T23:30:00Z",
      "2026-11-02T01:00:00Z",
      "2026-12-01T01:00:00Z",
    ])
      insert(store.database, kind, timestamp, index + 1, index % 2 ? 3 : 15);
  }
  store.homes = store.publishedUsageHomes();
  return { root, store, options };
}

function insert(database, home, timestamp, weight = 1, mask = 15) {
  const ms = Date.parse(timestamp),
    day = timestamp.slice(0, 10);
  database
    .prepare(`INSERT INTO events(
    source_path,timestamp_ms,session_id,home_id,home_label,channel,project,model,
    hour_key,day_key,week_key,month_key,cwd,repository_key,repository_path,repository_kind,
    detail_mask,reconciliation_gap,total,input,cached,output,reasoning
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      `/fixture/${home}`,
      ms,
      "shared-session",
      home,
      home,
      home,
      "fixture",
      weight % 2 ? "gpt-6-sol" : "gpt-6-mini",
      `${day} 00`,
      day,
      day,
      day.slice(0, 7),
      `/work/${home}`,
      `repo:${weight % 3}`,
      `/repo/${weight % 3}`,
      "git",
      mask,
      weight,
      weight * 100,
      weight * 50,
      weight * 10,
      weight * 40,
      weight * 5,
    );
}

async function parity(store, options) {
  const actual = await store.periodComparisonHistory(options);
  const events = store.publishedUsageEvents().filter((event) => !(options.excludeHomes || []).includes(event.homeId));
  const expected = summarizePeriodComparison(events, options);
  assert.deepEqual(actual, expected);
  return actual;
}

test("periods reuse persistent days across six harnesses, time boundaries, append, and reopen", async () => {
  const f = await fixture();
  let store = f.store;
  try {
    for (const calendarZone of ["utc", "local"])
      for (const now of ["2026-11-01T12:00:00Z", "2026-11-02T12:00:00Z", "2026-12-01T12:00:00Z"])
        await parity(store, { now: new Date(now), calendarZone });
    const options = { now: new Date("2026-12-01T12:00:00Z"), calendarZone: "utc" };
    insert(store.database, "dsh", "2026-11-02T02:00:00Z", 7, 19);
    await parity(store, options);
    assert.equal(store.lastRollupWork.applied, true);
    assert.equal(store.lastRollupWork.readEvents, 1, "late timestamps with a new id update only their delta");
    await parity(store, { ...options, excludeHomes: ["main", "claude"] });
    store.close();
    store = new UsageStore(f.options);
    await store.open();
    store.homes = store.publishedUsageHomes();
    await parity(store, options);
    assert.equal(store.lastRollupWork.applied, true);
    assert.equal(store.lastRollupWork.readEvents, 0);
  } finally {
    store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("periods retract old facts and preserve an already pinned WAL snapshot", async () => {
  const f = await fixture(),
    store = f.store;
  const options = { now: new Date("2026-12-01T12:00:00Z"), calendarZone: "utc" };
  let external;
  try {
    await parity(store, options);
    store.database.exec("UPDATE events SET total=total+17,detail_mask=0 WHERE id=1");
    await parity(store, options);
    assert.ok(store.lastRollupWork.fallbackDays > 0);
    store.database.exec("DELETE FROM events WHERE id=2");
    const before = await parity(store, options);
    external = new DatabaseSync(f.options.databaseFile);
    external.exec("PRAGMA busy_timeout=5000");
    store.database.exec("SAVEPOINT pinned_period");
    try {
      store.database.prepare("SELECT id FROM events LIMIT 1").get();
      insert(external, "workbuddy", "2026-12-01T02:00:00Z", 9, 31);
      assert.deepEqual(await store.periodComparisonHistory(options), before);
    } finally {
      store.database.exec("RELEASE pinned_period");
    }
    const after = await parity(store, options);
    assert.equal(after.totals.all.total, before.totals.all.total + 900);
    assert.equal(store.lastRollupWork.readEvents, 1);
  } finally {
    external?.close();
    store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("projection preparation cannot hide an external commit behind warmed response caches", async () => {
  const f = await fixture(), store = f.store;
  const now = new Date("2026-12-01T12:00:00Z");
  const external = new DatabaseSync(f.options.databaseFile);
  try {
    const before = store.metadata(now);
    const prepareMetadata = store.prepareMetadataProjection.bind(store);
    let injected = false;
    store.prepareMetadataProjection = () => {
      if (!injected) {
        injected = true;
        insert(external, "main", "2026-11-02T03:00:00Z", 13);
      }
      return prepareMetadata();
    };
    assert.equal((await store.metadataHistory(now)).eventCount, before.eventCount + 1);
    const options = { now, calendarZone: "utc" };
    const period = await parity(store, options);
    const prepareRollups = store.prepareHotRollups.bind(store);
    injected = false;
    store.prepareHotRollups = () => {
      if (!injected) {
        injected = true;
        insert(external, "dsh", "2026-11-02T04:00:00Z", 17);
      }
      return prepareRollups();
    };
    const after = await parity(store, options);
    assert.equal(after.totals.all.total, period.totals.all.total + 1700);
  } finally {
    external.close();
    store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
