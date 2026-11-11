import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const root = path.resolve(".codex-usage/node-startup-20261030");
const fixedNow = new Date("2026-10-30T12:00:00.000Z");
const fixedGeneratedAt = "2026-10-30T12:00:00.000Z";
const eventCount = Number(process.argv[2] || 2_400);
const todayEventCount = Number(process.argv[3] || 120);
assert.ok(Number.isSafeInteger(eventCount) && eventCount >= 240);
assert.ok(Number.isSafeInteger(todayEventCount) && todayEventCount >= 1 && todayEventCount < eventCount);

async function loadVariant(variant) {
  const variantRoot = path.join(root, variant);
  const usageStore = await import(pathToFileURL(path.join(variantRoot, "src", "usage-store.js")).href);
  const pricing = await import(pathToFileURL(path.join(variantRoot, "src", "pricing.js")).href);
  const usageCore = await import(pathToFileURL(path.join(variantRoot, "src", "usage-core.js")).href);
  return { ...usageStore, pricing, usageCore };
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function startOfLocalWeek(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - ((start.getDay() || 7) - 1));
  return start;
}

function timestampFor(sequence) {
  if (sequence < todayEventCount) return fixedNow.getTime() - sequence * 60_000;
  const historySequence = sequence - todayEventCount;
  const perDay = 24;
  const day = Math.floor(historySequence / perDay) + 1;
  const slot = historySequence % perDay;
  return fixedNow.getTime() - day * 86_400_000 + (slot - 12) * 3_600_000;
}

function configuredCatalog(catalog) {
  const changed = structuredClone(catalog);
  const model = changed.models["gpt-6-sol"];
  assert.ok(model, "parity fixture requires gpt-6-sol pricing");
  for (const rates of [model.short, model.long, model.fast?.short, model.fast?.long]) {
    if (!rates) continue;
    for (const field of ["input", "cachedInput", "cacheWrite", "output"]) {
      if (typeof rates[field] === "number") rates[field] *= 1.000000000123;
    }
  }
  changed.usdToCnyRate = 7.123456789;
  return changed;
}

function seedFixture(store, catalog) {
  const mainHome = { id: "home-main", label: "Main", path: "/fixture/main", kind: "main" };
  const zcodeHome = { id: "home-zcode", label: "ZCode", path: "/fixture/zcode", kind: "zcode" };
  const mainSource = "/fixture/main.jsonl";
  const zcodeSource = "/fixture/zcode.jsonl";
  const insertSource = store.database.prepare(`
    INSERT INTO source_files
      (path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertSource.run(
    mainSource,
    mainHome.kind,
    mainHome.id,
    mainHome.label,
    mainHome.path,
    1,
    1,
    fixedGeneratedAt,
  );
  insertSource.run(
    zcodeSource,
    zcodeHome.kind,
    zcodeHome.id,
    zcodeHome.label,
    zcodeHome.path,
    1,
    1,
    fixedGeneratedAt,
  );

  const insertEvent = store.database.prepare(`
    INSERT INTO events (
      source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
      hour_key, day_key, week_key, month_key, cwd, repository_key, repository_path,
      repository_kind, detail_mask, reconciliation_gap, cache_write_tokens, cache_write_known,
      request_input_tokens, context_level, service_tier, price_version,
      total, input, cached, output, reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const knownModels = Object.keys(catalog.models).filter((model) => model && model !== "Unknown model");
  assert.ok(knownModels.length > 0);
  store.database.exec("BEGIN");
  try {
    for (let index = 0; index < eventCount; index += 1) {
      const timestampMs = timestampFor(index);
      const date = new Date(timestampMs);
      const dayKey = localDateKey(date);
      const weekKey = localDateKey(startOfLocalWeek(date));
      const zcode = index % 9 === 0;
      const home = zcode ? zcodeHome : mainHome;
      const source = zcode ? zcodeSource : mainSource;
      const model = index % 11 === 0 ? "future-unknown-model" : knownModels[index % knownModels.length];
      const input = 1_000 + ((index * 37) % 8_000);
      const cached = Math.floor(input * (index % 4 === 0 ? 0.2 : 0.55));
      const output = 200 + ((index * 19) % 1_500);
      const reasoning = index % 5 === 0 ? 17 : 0;
      const detailMask = [15, 14, 13, 31, 47, 16][index % 6];
      const inconsistent = Boolean(detailMask & 16);
      const total = inconsistent ? input + output - 1 : input + output;
      const serviceTier = ["standard", "fast", "mystery"][index % 3];
      const contextLevel = ["short", "long", "unknown"][index % 3];
      const cacheWriteKnown = Boolean(detailMask & 32);
      const cacheWriteTokens = cacheWriteKnown ? index % 97 : 0;
      insertEvent.run(
        source,
        timestampMs,
        `session-${index % 31}`,
        home.id,
        home.label,
        zcode ? "zcode" : "codex",
        `/fixture/project-${index % 7}`,
        model,
        `${dayKey} ${String(date.getHours()).padStart(2, "0")}:00`,
        dayKey,
        weekKey,
        dayKey.slice(0, 7),
        `/fixture/project-${index % 7}`,
        `repo-${index % 7}`,
        `/fixture/project-${index % 7}`,
        "git",
        detailMask,
        index % 23 === 0 ? 3 : 0,
        cacheWriteTokens,
        cacheWriteKnown ? 1 : 0,
        index % 13 === 0 ? 150_000 : input,
        contextLevel,
        serviceTier,
        "fixture-recorded-price-version",
        total,
        input,
        cached,
        output,
        reasoning,
      );
    }

    const insertObservation = store.database.prepare(`
      INSERT INTO rate_limit_observations (
        source_path, line_number, role, observed_at_ms, limit_id, limit_name,
        plan_type, window_minutes, resets_at_ms, used_percent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const nowMs = fixedNow.getTime();
    insertObservation.run(mainSource, 1, "primary", nowMs - 60_000, "codex", "Codex", "pro", 300, nowMs + 1_800_000, 42.5);
    insertObservation.run(
      mainSource,
      1,
      "secondary",
      nowMs - 60_000,
      "codex",
      "Codex",
      "pro",
      10_080,
      nowMs + 172_800_000,
      61.25,
    );
    insertObservation.run(
      mainSource,
      2,
      "primary",
      nowMs - 18_060_000,
      "codex",
      "Codex",
      "pro",
      300,
      nowMs - 60_000,
      39.75,
    );
    store.database.exec("COMMIT");
  } catch (error) {
    store.database.exec("ROLLBACK");
    throw error;
  }

  store.homes = [mainHome, zcodeHome];
  store.warnings = [];
  store.generatedAt = fixedGeneratedAt;
  store.storeRevision = 1;
  store.derivedRevision = store.storeRevision;
  store.observedUsageProjectionChanges = store.usageProjectionChangeKey();
  store.readPricingModels = catalog.models;
  store.quotaObservationCache = null;
  store.recordChampionCache = null;
  store.summaryProjectionCache = null;
  store.metadataObservationCache = null;
  store.eventCostMemo.clear("summary-parity-seed");
}

function instrument(store) {
  const counters = { quotaObservations: 0, aggregateRange: 0 };
  for (const method of Object.keys(counters)) {
    const original = store[method];
    assert.equal(typeof original, "function", `${method} must be callable`);
    store[method] = function instrumentedMethod(...args) {
      counters[method] += 1;
      return original.apply(this, args);
    };
  }
  const sql = [];
  const originalPrepare = store.database.prepare.bind(store.database);
  store.database.prepare = (text) => {
    if (typeof text === "string") sql.push(text.replace(/\s+/g, " ").trim());
    return originalPrepare(text);
  };
  return { counters, sql };
}

function resetCaseCaches(store, label) {
  store.recordChampionCache = null;
  store.quotaObservationCache = null;
  store.summaryProjectionCache = null;
  store.metadataObservationCache = null;
  store.eventCostMemo.clear(`summary-parity-${label}`);
  store.observedUsageProjectionChanges = store.usageProjectionChangeKey();
}

const baselineModule = await loadVariant("baseline");
const summaryModule = await loadVariant("summary");
const originalCatalog = baselineModule.pricing.getPricingCatalog();
const catalog = configuredCatalog(originalCatalog);
const baselineVersion = baselineModule.pricing.setPricingCatalog(structuredClone(catalog)).version;
const summaryVersion = summaryModule.pricing.setPricingCatalog(structuredClone(catalog)).version;
assert.equal(baselineVersion, summaryVersion, "both variants must run against the same pricing catalog");

const quotaPresets = baselineModule.usageCore.USAGE_PRESETS.filter((preset) =>
  baselineModule.usageCore.isQuotaPreset(preset),
);
assert.equal(quotaPresets.length, 2, "quota fixture requires both supported quota presets");

const cases = [
  {
    label: "today-local-details",
    filters: { preset: "today", bucket: "hour", now: fixedNow, calendarZone: "local" },
    options: { includeDetails: true },
  },
  {
    label: "week-utc-no-details",
    filters: { preset: "week", bucket: "day", now: fixedNow, calendarZone: "utc" },
    options: { includeDetails: false },
  },
  {
    label: "month-local",
    filters: { preset: "month", bucket: "day", now: fixedNow, calendarZone: "local" },
    options: { includeDetails: true },
  },
  {
    label: "custom-range",
    filters: {
      preset: "custom",
      startDate: "2026-10-01",
      endDate: "2026-10-15",
      bucket: "day",
      now: fixedNow,
      calendarZone: "utc",
    },
    options: { includeDetails: true },
  },
  {
    label: "quota-primary",
    filters: { preset: quotaPresets[0], bucket: "quota_30m", now: fixedNow, calendarZone: "local" },
    options: { includeDetails: true },
  },
  {
    label: "quota-secondary",
    filters: { preset: quotaPresets[1], bucket: "quota_24h", now: fixedNow, calendarZone: "utc" },
    options: { includeDetails: false },
  },
  {
    label: "all-local",
    filters: { preset: "all", bucket: "day", now: fixedNow, calendarZone: "local" },
    options: { includeDetails: true },
  },
];

async function runVariant(module, variant) {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), `codex-summary-parity-${variant}-`));
  const store = new module.UsageStore({
    homeDir: fixtureRoot,
    databaseFile: path.join(fixtureRoot, "usage-index.sqlite"),
    importDirs: [],
    automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false,
  });
  const results = [];
  try {
    await store.open();
    seedFixture(store, catalog);
    const trace = instrument(store);
    for (const entry of cases) {
      resetCaseCaches(store, entry.label);
      const before = { ...trace.counters };
      const sqlBefore = trace.sql.length;
      const started = performance.now();
      const output = store.summarize(entry.filters, entry.options);
      const elapsedMs = performance.now() - started;
      results.push({
        label: entry.label,
        output,
        elapsedMs,
        quotaCalls: trace.counters.quotaObservations - before.quotaObservations,
        aggregateCalls: trace.counters.aggregateRange - before.aggregateRange,
        sqlCount: trace.sql.length - sqlBefore,
        memo: store.eventCostMemo.stats(),
      });
    }
    return results;
  } finally {
    store.close();
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

let baselineResults;
let summaryResults;
try {
  baselineResults = await runVariant(baselineModule, "baseline");
  summaryResults = await runVariant(summaryModule, "summary");
} finally {
  baselineModule.pricing.setPricingCatalog(originalCatalog);
  summaryModule.pricing.resetPricingCatalog();
}

for (let index = 0; index < cases.length; index += 1) {
  const baseline = baselineResults[index];
  const summary = summaryResults[index];
  assert.deepEqual(summary.output, baseline.output, `${cases[index].label}: complete summary output must match`);
  assert.ok(summary.sqlCount <= baseline.sqlCount, `${cases[index].label}: candidate must not add SQL reads`);
  assert.equal(
    summary.aggregateCalls,
    baseline.aggregateCalls,
    `${cases[index].label}: aggregate call count must remain unchanged`,
  );
  assert.equal(summary.quotaCalls, 1, `${cases[index].label}: quota observations must be read once per summary`);
  if (cases[index].label.startsWith("quota-")) {
    assert.ok(
      summary.quotaCalls < baseline.quotaCalls,
      `${cases[index].label}: baseline must expose the repeated quota-observation method calls`,
    );
  }
  if (cases[index].label !== "all-local") {
    assert.equal(
      summary.memo.entries,
      0,
      `${cases[index].label}: record-scan pricing must not add a long-lived per-event cache`,
    );
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      eventCount,
      todayEventCount,
      pricingVersion: baselineVersion,
      cases: cases.map((entry, index) => ({
        label: entry.label,
        baselineMs: baselineResults[index].elapsedMs,
        summaryMs: summaryResults[index].elapsedMs,
        baselineQuotaCalls: baselineResults[index].quotaCalls,
        summaryQuotaCalls: summaryResults[index].quotaCalls,
        baselineAggregateCalls: baselineResults[index].aggregateCalls,
        summaryAggregateCalls: summaryResults[index].aggregateCalls,
        baselineSqlCount: baselineResults[index].sqlCount,
        summarySqlCount: summaryResults[index].sqlCount,
        baselineMemoEntries: baselineResults[index].memo.entries,
        summaryMemoEntries: summaryResults[index].memo.entries,
        outputEventCount: baselineResults[index].output.eventCount,
      })),
    },
    null,
    2,
  )}\n`,
);
