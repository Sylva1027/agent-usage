import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";

import { setSummaryFilters, summarize } from "../public/app.js";
import { getPricingCatalog, resetPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { renderStaticDashboardHtml } from "../src/static-export.js";
import { buildUsageReport, summarizePeriodComparison, summarizeUsage } from "../src/usage-core.js";
import { UsageStore } from "../src/usage-store.js";

const AS_OF = "2026-07-12T12:00:00.000Z";

function tokenRow(timestamp, total, input, cached, output, reasoning) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: total,
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: reasoning,
        },
      },
    },
  };
}

function quotaRow(timestamp, resetsAt) {
  const row = tokenRow(timestamp, 0, 0, 0, 0, 0);
  row.payload.rate_limits = {
    limit_id: "codex",
    primary: { window_minutes: 300, resets_at: Date.parse(resetsAt) / 1000, used_percent: 42.5 },
  };
  return row;
}

async function writeSession(root, name, model, cwd, rows) {
  const [year, month, day] = rows[0].timestamp.slice(0, 10).split("-");
  const sessionDir = path.join(root, ".codex", "sessions", year, month, day);
  await mkdir(sessionDir, { recursive: true });
  const lines = [
    { timestamp: rows[0].timestamp, type: "session_meta", payload: { id: name, source: "cli", originator: "codex-tui", cwd } },
    { type: "turn_context", payload: { model } },
    ...rows,
  ];
  await writeFile(path.join(sessionDir, `rollout-${name}.jsonl`), lines.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

async function writeZcodeUsage(root, timestamp) {
  const dbDir = path.join(root, ".zcode", "cli", "db");
  await mkdir(dbDir, { recursive: true });
  const db = new DatabaseSync(path.join(dbDir, "db.sqlite"));
  try {
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, path TEXT, title TEXT);
      CREATE TABLE model_usage (
        id TEXT PRIMARY KEY, session_id TEXT, turn_id TEXT, query_source TEXT, task_type TEXT,
        provider_id TEXT, model_id TEXT, variant TEXT, agent TEXT, mode TEXT, status TEXT,
        started_at INTEGER, completed_at INTEGER, input_tokens INTEGER, output_tokens INTEGER,
        reasoning_tokens INTEGER, cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
        provider_total_tokens INTEGER, computed_total_tokens INTEGER
      );
    `);
    db.prepare("INSERT INTO session (id, parent_id, directory, path, title) VALUES (?, ?, ?, ?, ?)")
      .run("zcode-session", null, "/work/zcode", "/work/zcode", "ZCode fixture");
    db.prepare(`INSERT INTO model_usage VALUES (${Array(20).fill("?").join(", ")})`).run(
      "zcode-usage", "zcode-session", "zcode-turn", "main_turn", "interactive",
      "test-provider", "test-model", "enabled", "zcode-agent", "build", "completed",
      Date.parse(timestamp) - 1000, Date.parse(timestamp), 100, 20, 5, 0, 10, 120, 120,
    );
  } finally {
    db.close();
  }
}

function embeddedSnapshot(html) {
  const dataScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .find((script) => script.includes("window.__CODEX_USAGE_REPORT__ ="));
  assert.ok(dataScript, "static export must embed a data script");
  const sandbox = { window: {} };
  runInNewContext(dataScript, sandbox);
  return JSON.parse(JSON.stringify(sandbox.window));
}

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

function groups(rows = []) {
  return rows.map((row) => ({ key: row.key, total: row.total })).sort((a, b) => a.key.localeCompare(b.key));
}

function summaryFields(summary) {
  return {
    range: {
      preset: summary.range.preset,
      start: iso(summary.range.start),
      end: iso(summary.range.end),
      bucket: summary.range.bucket,
      calendarZone: summary.range.calendarZone,
    },
    totals: summary.totals,
    quota: {
      state: summary.quota?.windows?.quota_5h?.state,
      usedPercent: summary.quota?.windows?.quota_5h?.usedPercent,
    },
    costEstimate: summary.costEstimate && {
      totalUsd: summary.costEstimate.totalUsd,
      pricedTokens: summary.costEstimate.pricedTokens,
      unpricedTokens: summary.costEstimate.unpricedTokens,
    },
    eventCount: summary.eventCount,
    sessionCount: summary.sessionCount,
    channels: groups(summary.channels),
    models: groups(summary.models),
    timeline: summary.timeline.map((row) => ({ key: row.key, total: row.total })),
    comparison: summary.comparison && {
      previousTotals: summary.comparison.previousTotals,
      totalDelta: summary.comparison.totalDelta,
      percentChange: summary.comparison.percentChange,
    },
  };
}

function comparisonFields(comparison) {
  return {
    periods: comparison.periods,
    totals: comparison.totals,
    models: comparison.models.map((row) => ({ key: row.key, periods: row.periods })).sort((a, b) => a.key.localeCompare(b.key)),
    repositories: comparison.repositories.map((row) => ({ key: row.key, periods: row.periods })).sort((a, b) => a.key.localeCompare(b.key)),
  };
}

test("memory, SQLite, and exported snapshot agree for local and UTC usage", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-three-path-parity-"));
  const store = new UsageStore({ homeDir, databaseFile: path.join(homeDir, "usage-index.sqlite") });
  try {
    await writeSession(homeDir, "alpha", "gpt-6-sol", "/work/alpha", [
      tokenRow("2026-07-11T23:30:00.000Z", 120, 100, 20, 20, 4),
      tokenRow("2026-07-12T00:30:00.000Z", 200, 160, 30, 40, 7),
    ]);
    await writeSession(homeDir, "beta", "gpt-6-luna", "/work/beta", [
      tokenRow("2026-07-12T11:30:00.000Z", 75, 60, 10, 15, 2),
      quotaRow("2026-07-12T11:59:00.000Z", "2026-07-12T14:37:00.000Z"),
    ]);

    await store.sync();
    const report = await buildUsageReport({ homeDir });
    assert.equal(report.events.length, 3);
    assert.equal(report.rateLimitObservations.length, 1);
    const snapshot = embeddedSnapshot(renderStaticDashboardHtml({ ...report, asOf: AS_OF }));
    assert.equal(snapshot.__CODEX_USAGE_REPORT__.events.length, report.events.length);

    for (const calendarZone of ["local", "utc"]) {
      const periodOptions = { now: AS_OF, calendarZone };
      const memoryComparison = summarizePeriodComparison(report.events, periodOptions);
      const indexedComparison = store.periodComparison(periodOptions);
      const snapshotComparison = calendarZone === "utc"
        ? snapshot.__CODEX_USAGE_PERIOD_COMPARISON_UTC__
        : snapshot.__CODEX_USAGE_PERIOD_COMPARISON__;
      assert.deepEqual(comparisonFields(indexedComparison), comparisonFields(memoryComparison), `${calendarZone} SQLite period comparison`);
      assert.deepEqual(comparisonFields(snapshotComparison), comparisonFields(memoryComparison), `${calendarZone} snapshot period comparison`);

      for (const preset of ["today", "all", "quota_5h"]) {
        const filters = { preset, bucket: preset === "quota_5h" ? "quota_30m" : "day", now: AS_OF, calendarZone };
        const memorySummary = summarizeUsage(report, filters);
        const indexedSummary = store.summarize(filters);
        setSummaryFilters({ ...filters, excludedHomes: [], startDate: "", endDate: "", recentValue: "" });
        const snapshotSummary = summarize(snapshot.__CODEX_USAGE_REPORT__);
        if (preset === "all") assert.equal(memorySummary.totals.total, 275);
        if (preset === "quota_5h") assert.equal(memorySummary.totals.total, 75);
        if (calendarZone === "utc" && preset === "today") assert.equal(memorySummary.totals.total, 155);
        assert.deepEqual(summaryFields(indexedSummary), summaryFields(memorySummary), `${calendarZone}/${preset} SQLite summary`);
        assert.deepEqual(summaryFields(snapshotSummary), summaryFields(memorySummary), `${calendarZone}/${preset} snapshot summary`);
      }
    }
  } finally {
    setSummaryFilters({ preset: "today", bucket: "hour", calendarZone: "local", now: null, excludedHomes: [], startDate: "", endDate: "", recentValue: "上个月" });
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("three paths agree across week/month boundaries, ZCode, source exclusion, and custom pricing", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-three-path-boundaries-"));
  const store = new UsageStore({ homeDir, databaseFile: path.join(homeDir, "usage-index.sqlite") });
  const asOf = "2026-09-01T12:00:00.000Z";
  try {
    const catalog = getPricingCatalog();
    catalog.checkedAt = "2026-09-01";
    catalog.models["gpt-6-sol"].short.output = 20;
    catalog.models["gpt-6-sol"].long.output = 30;
    setPricingCatalog(catalog);

    await writeSession(homeDir, "sunday", "gpt-6-sol", "/work/codex", [
      tokenRow("2026-08-30T23:30:00.000Z", 40, 30, 0, 10, 2),
    ]);
    await writeSession(homeDir, "monday", "gpt-6-sol", "/work/codex", [
      tokenRow("2026-08-31T00:30:00.000Z", 60, 40, 0, 20, 3),
    ]);
    await writeSession(homeDir, "tuesday", "gpt-6-sol", "/work/codex", [
      tokenRow("2026-09-01T00:30:00.000Z", 80, 60, 0, 20, 4),
    ]);
    await writeZcodeUsage(homeDir, "2026-09-01T10:00:00.000Z");

    await store.sync();
    const report = await buildUsageReport({ homeDir, env: {} });
    assert.equal(report.events.length, 4);
    const zcodeHome = report.homes.find((home) => home.kind === "zcode");
    assert.ok(zcodeHome);
    assert.equal(report.events.filter((event) => event.channel === "ZCode").length, 1);
    const snapshot = embeddedSnapshot(renderStaticDashboardHtml({ ...report, asOf }));
    assert.equal(snapshot.__CODEX_USAGE_REPORT__.pricing.checkedAt, "2026-09-01");
    assert.equal(snapshot.__CODEX_USAGE_REPORT__.events.length, 4);
    const pricedCodexEvent = snapshot.__CODEX_USAGE_REPORT__.events.find((event) => event.sessionId === "tuesday");
    assert.ok(pricedCodexEvent);
    assert.ok(Math.abs(pricedCodexEvent.costEstimate.outputUsd - 0.0004) < 1e-12, JSON.stringify(pricedCodexEvent.costEstimate));

    const recordDay = store.summarize({
      preset: "custom", startDate: "2026-09-01", endDate: "2026-09-01", bucket: "day",
      calendarZone: "utc", now: asOf, excludeHomes: [zcodeHome.id],
    });
    assert.equal(recordDay.records.totalCost.period, "2026-09-01");
    assert.ok(Math.abs(recordDay.records.totalCost.value -
      recordDay.costEstimate.totalUsd * getPricingCatalog().usdToCnyRate) < 1e-12);

    for (const calendarZone of ["local", "utc"]) {
      const periodOptions = { now: asOf, calendarZone };
      const memoryComparison = summarizePeriodComparison(report.events, periodOptions);
      const indexedComparison = store.periodComparison(periodOptions);
      const snapshotComparison = calendarZone === "utc"
        ? snapshot.__CODEX_USAGE_PERIOD_COMPARISON_UTC__
        : snapshot.__CODEX_USAGE_PERIOD_COMPARISON__;
      assert.deepEqual(comparisonFields(indexedComparison), comparisonFields(memoryComparison), `${calendarZone} SQLite period comparison`);
      assert.deepEqual(comparisonFields(snapshotComparison), comparisonFields(memoryComparison), `${calendarZone} snapshot period comparison`);

      for (const excludedHomes of [[], [zcodeHome.id]]) {
        const scope = excludedHomes.length ? "without ZCode" : "all sources";
        const filteredReport = excludedHomes.length
          ? { ...report, events: report.events.filter((event) => !excludedHomes.includes(event.homeId)) }
          : report;
        if (excludedHomes.length) {
          const filteredComparison = summarizePeriodComparison(filteredReport.events, periodOptions);
          assert.deepEqual(
            comparisonFields(store.periodComparison({ ...periodOptions, excludeHomes: excludedHomes })),
            comparisonFields(filteredComparison),
            `${calendarZone}/${scope} SQLite period comparison`,
          );
        }

        for (const preset of ["all", "week", "month"]) {
          const filters = { preset, bucket: "day", now: asOf, calendarZone };
          const memorySummary = summarizeUsage(filteredReport, filters);
          const indexedSummary = store.summarize({ ...filters, excludeHomes: excludedHomes });
          setSummaryFilters({ ...filters, excludedHomes, startDate: "", endDate: "", recentValue: "" });
          const snapshotSummary = summarize(snapshot.__CODEX_USAGE_REPORT__);
          if (calendarZone === "utc") {
            const expected = excludedHomes.length
              ? { all: 180, week: 140, month: 80 }
              : { all: 300, week: 260, month: 200 };
            assert.equal(memorySummary.totals.total, expected[preset], `${scope}/${preset} UTC fixture total`);
          }
          assert.deepEqual(summaryFields(indexedSummary), summaryFields(memorySummary), `${calendarZone}/${scope}/${preset} SQLite summary`);
          assert.deepEqual(summaryFields(snapshotSummary), summaryFields(memorySummary), `${calendarZone}/${scope}/${preset} snapshot summary`);
        }
      }
    }
  } finally {
    setSummaryFilters({ preset: "today", bucket: "hour", calendarZone: "local", now: null, excludedHomes: [], startDate: "", endDate: "", recentValue: "上个月" });
    resetPricingCatalog();
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
