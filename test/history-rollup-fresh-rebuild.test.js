import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverUsageSources } from "../src/usage-core.js";
import { createUsageRollups, queryUsageRollups } from "../src/usage-rollups.js";
import { UsageStore } from "../src/usage-store.js";

function projectEvent(timestamp, total) {
  return {
    schema_version: "codex-usage.project-log.v1",
    timestamp,
    source: "test",
    channel: "Test",
    project_root: "/work/fresh-rollup",
    cwd: "/work/fresh-rollup",
    session_id: "fresh-rollup-session",
    model: "gpt-6-sol",
    usage: { total, input: total - 3, cached: 0, output: 3, reasoning: 0 },
  };
}

function localDayKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function tableExists(store, table) {
  return Boolean(store.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

async function openFreshStore(events) {
  const homeDir = await mkdtemp(path.join(tmpdir(), "history-rollup-fresh-"));
  const projectRoot = path.join(homeDir, "log-project");
  const usageFile = path.join(projectRoot, ".codex-usage", "usage.jsonl");
  await mkdir(path.dirname(usageFile), { recursive: true });
  await writeFile(usageFile, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const options = { homeDir, databaseFile: path.join(homeDir, "usage-index.sqlite"), importDirs: [projectRoot] };
  return { homeDir, options, projectRoot, store: new UsageStore(options) };
}

async function ingestWithoutRollupRebuild(store, options) {
  const homes = await discoverUsageSources(options);
  const { files } = await store.usageFiles(homes);
  assert.equal(files.length, 1);
  createUsageRollups(store.database);
  await store.replaceFile(files[0]);
}

test("fresh full rebuild creates rollups when the optional model table does not exist", async () => {
  const timestamp = "2026-07-12T02:00:00.000Z";
  const { homeDir, options, store } = await openFreshStore([projectEvent(timestamp, 10)]);
  try {
    await store.open();
    await ingestWithoutRollupRebuild(store, options);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM events").get().count, 1);
    assert.equal(tableExists(store, "usage_rollup_models"), false);

    await store.rebuildHistoryRollups();

    assert.equal(queryUsageRollups(store.database, { day: "2026-07-12", calendarZone: "utc" }).total, 10);
    assert.equal(queryUsageRollups(store.database, { day: localDayKey(timestamp), calendarZone: "local" }).total, 10);
    assert.equal(tableExists(store, "usage_rollup_models"), true);
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("fresh full rebuild accepts an empty store without the optional model table", async () => {
  const { homeDir, store } = await openFreshStore([]);
  try {
    await store.open();
    assert.equal(tableExists(store, "usage_rollup_models"), false);

    await store.rebuildHistoryRollups();

    assert.equal(tableExists(store, "usage_rollup_models"), false);
    for (const table of ["usage_rollup_days", "usage_rollup_daily", "usage_rollup_sessions"]) {
      assert.equal(store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    }
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("fresh full rebuild still clears stale model-only days", async () => {
  const timestamp = "2026-07-12T02:00:00.000Z";
  const { homeDir, options, store } = await openFreshStore([projectEvent(timestamp, 10)]);
  try {
    await store.open();
    await ingestWithoutRollupRebuild(store, options);
    await store.rebuildHistoryRollups();
    store.database.prepare("UPDATE usage_rollup_models SET day_key = '2026-07-11'").run();

    await store.rebuildHistoryRollups();

    const modelDays = store.database
      .prepare("SELECT DISTINCT day_key FROM usage_rollup_models ORDER BY day_key")
      .all()
      .map((row) => String(row.day_key));
    assert.deepEqual(modelDays, ["2026-07-12"]);
    assert.equal(queryUsageRollups(store.database, { day: localDayKey(timestamp), calendarZone: "local" }).total, 10);
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
