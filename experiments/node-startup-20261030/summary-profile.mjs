import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const root = path.resolve(".codex-usage/node-startup-20261030");
const variant = process.argv[2] || "baseline";
const variantRoot = path.join(root, variant);
const fixedNow = new Date("2026-10-30T12:00:00.000Z");
const eventCount = Number(process.argv[3] || 8_000);
const todayEventCount = Number(process.argv[4] || 160);
assert.ok(["baseline", "summary"].includes(variant), `unknown variant: ${variant}`);
assert.ok(Number.isSafeInteger(eventCount) && eventCount >= 2);
assert.ok(Number.isSafeInteger(todayEventCount) && todayEventCount >= 1 && todayEventCount < eventCount);

const { UsageStore } = await import(pathToFileURL(path.join(variantRoot, "src", "usage-store.js")).href);
const { getPricingCatalog } = await import(pathToFileURL(path.join(variantRoot, "src", "pricing.js")).href);

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function startOfLocalWeek(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - ((start.getDay() || 7) - 1));
  return start;
}

function timestampFor(sequence) {
  if (sequence < todayEventCount) {
    return fixedNow.getTime() - sequence * 60_000;
  }
  const historySequence = sequence - todayEventCount;
  const day = Math.floor(historySequence / 48) + 1;
  const slot = historySequence % 48;
  return fixedNow.getTime() - day * 86_400_000 + (slot - 24) * 1_800_000;
}

function seedFixture(store) {
  const homeId = "fixture-home";
  const homeLabel = "Fixture";
  const sourcePath = "/fixture/rollout.jsonl";
  store.database
    .prepare(`
      INSERT INTO source_files
        (path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(sourcePath, "main", homeId, homeLabel, "/fixture", 1, 1, fixedNow.toISOString());
  const insert = store.database.prepare(`
    INSERT INTO events (
      source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
      hour_key, day_key, week_key, month_key, cwd, repository_key, repository_path,
      repository_kind, detail_mask, reconciliation_gap, cache_write_tokens, cache_write_known,
      request_input_tokens, context_level, service_tier, price_version,
      total, input, cached, output, reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const models = Object.keys(getPricingCatalog().models).filter((model) => model && model !== "Unknown model");
  assert.ok(models.length > 0, "pricing catalog must contain at least one model");
  store.database.exec("BEGIN");
  try {
    for (let index = 0; index < eventCount; index += 1) {
      const timestampMs = timestampFor(index);
      const date = new Date(timestampMs);
      const dayKey = localDateKey(date);
      const weekKey = localDateKey(startOfLocalWeek(date));
      const input = 2_000 + ((index * 37) % 9_000);
      const cached = Math.floor(input * (index % 4 === 0 ? 0.2 : 0.55));
      const output = 300 + ((index * 19) % 2_500);
      const total = input + output;
      insert.run(
        sourcePath,
        timestampMs,
        `session-${index % 97}`,
        homeId,
        homeLabel,
        "codex",
        `/fixture/project-${index % 11}`,
        models[index % models.length],
        `${dayKey} ${String(date.getHours()).padStart(2, "0")}:00`,
        dayKey,
        weekKey,
        dayKey.slice(0, 7),
        `/fixture/project-${index % 11}`,
        `repo-${index % 11}`,
        `/fixture/project-${index % 11}`,
        "git",
        15,
        0,
        0,
        1,
        input,
        input > 8_000 ? "long" : "short",
        index % 17 === 0 ? "fast" : "standard",
        "fixture",
        total,
        input,
        cached,
        output,
        0,
      );
    }
    store.database.exec("COMMIT");
  } catch (error) {
    store.database.exec("ROLLBACK");
    throw error;
  }
  store.homes = [{ id: homeId, label: homeLabel, path: "/fixture", kind: "main" }];
  store.storeRevision = 1;
  store.derivedRevision = store.storeRevision;
  store.observedUsageProjectionChanges = store.usageProjectionChangeKey();
  store.readPricingModels = getPricingCatalog().models;
}

function instrument(store) {
  const methods = [
    "quotaObservations",
    "aggregateRange",
    "timelineRange",
    "recordsForRange",
    "buildRecordChampions",
    "groupedRange",
    "repositoriesRange",
    "perfSummaryForRange",
  ];
  const calls = Object.fromEntries(methods.map((method) => [method, { count: 0, ms: 0 }]));
  for (const method of methods) {
    const original = store[method];
    assert.equal(typeof original, "function", `${method} must be callable`);
    store[method] = function instrumentedMethod(...args) {
      const started = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        calls[method].count += 1;
        calls[method].ms += performance.now() - started;
      }
    };
  }
  const originalEstimate = store.eventCostMemo.estimate;
  const estimate = { count: 0, ms: 0 };
  store.eventCostMemo.estimate = function instrumentedEstimate(...args) {
    const started = performance.now();
    try {
      return originalEstimate.apply(this, args);
    } finally {
      estimate.count += 1;
      estimate.ms += performance.now() - started;
    }
  };
  const sql = [];
  const originalPrepare = store.database.prepare.bind(store.database);
  store.database.prepare = (text) => {
    if (typeof text === "string") sql.push(text.replace(/\s+/g, " ").trim());
    return originalPrepare(text);
  };
  return { calls, estimate, sql };
}

const fixtureRoot = mkdtempSync(path.join(tmpdir(), `codex-summary-profile-${variant}-`));
const databaseFile = path.join(fixtureRoot, "usage-index.sqlite");
const store = new UsageStore({
  homeDir: fixtureRoot,
  databaseFile,
  importDirs: [],
  automaticDiscoveryEnabled: false,
  pricingRefreshSchedulerEnabled: false,
});

try {
  await store.open();
  seedFixture(store);
  const trace = instrument(store);
  const started = performance.now();
  const summary = store.summarize(
    { preset: "today", bucket: "day", now: fixedNow, calendarZone: "local" },
    { includeDetails: false },
  );
  const totalMs = performance.now() - started;
  const sqlCounts = new Map();
  for (const text of trace.sql) sqlCounts.set(text, (sqlCounts.get(text) || 0) + 1);
  const sqlRepeated = [...sqlCounts]
    .filter(([, count]) => count > 1)
    .map(([text, count]) => ({ count, sql: text.slice(0, 240) }));
  const result = {
    variant,
    eventCount,
    todayEventCount,
    totalMs,
    calls: trace.calls,
    estimate: trace.estimate,
    memo: store.eventCostMemo.stats(),
    sqlCount: trace.sql.length,
    sqlRepeated,
    output: {
      eventCount: summary.eventCount,
      sessionCount: summary.sessionCount,
      records: summary.records,
      timelineRows: summary.timeline.length,
      channels: summary.channels.length,
      models: summary.models.length,
    },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  try {
    store.close();
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}
