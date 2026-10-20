import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { backup, DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";

import { setSummaryFilters, summarize } from "../public/app.js";
import { getPricingCatalog, resetPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { periodComparisonForReport, pricedReport } from "../test-support/report-projection.js";
import {
  buildUsageIndex,
  buildUsageReport,
  summarizePeriodComparison,
  summarizeUsage,
  summarizeUsageIndex,
} from "../src/usage-core.js";
import { UsageStore } from "../src/usage-store.js";

const AS_OF = "2026-07-12T12:00:00.000Z";

test("auto-review stays in activity but is excluded from current and previous quota statistics", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-auto-review-policy-"));
  const store = new UsageStore({ homeDir, databaseFile: path.join(homeDir, "usage-index.sqlite") });
  const asOf = "2026-10-08T04:00:00.000Z";
  try {
    for (const [name, time, total, review] of [
      ["current-main", "2026-10-08T03:00:00Z", 100, false],
      ["current-review", "2026-10-08T03:10:00Z", 1000, true],
      ["previous-main", "2026-10-07T23:00:00Z", 50, false],
      ["previous-review", "2026-10-07T23:10:00Z", 2000, true],
      ["old-main", "2026-10-02T12:00:00Z", 25, false],
      ["old-review", "2026-10-02T12:10:00Z", 3000, true],
    ]) {
      const model = review ? "CODEX-AUTO-REVIEW" : "gpt-6-sol";
      const identity = { thread_id: name, turn_id: `${name}-turn` };
      const completed = Date.parse(time);
      await writeSession(homeDir, name, model, "/work", [
        { type: "turn_context", timestamp: time, payload: { ...identity, model } },
        tokenRow(time, total, total - 10, 0, 10, 2),
        {
          type: "token_usage_record",
          timestamp: time,
          payload: {
            ...identity,
            response_id: `${name}-response`,
            usage: { output_tokens: 10 },
            turn_token_usage: { output_tokens: 10 },
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "item_completed",
            ...identity,
            started_at_ms: completed - 1000,
            completed_at_ms: completed,
            item: { id: `${name}-item`, type: "AgentMessage" },
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "task_complete",
            ...identity,
            started_at: (completed - 1000) / 1000,
            completed_at: completed / 1000,
            duration_ms: 1000,
          },
        },
      ]);
    }
    const current = quotaRow("2026-10-08T03:55:00Z", "2026-10-08T06:00:00Z");
    current.payload.rate_limits.secondary = {
      window_minutes: 10080,
      resets_at: Date.parse("2026-10-12T00:00:00Z") / 1000,
      used_percent: 55,
    };
    const old = quotaRow("2026-10-02T12:55:00Z", "2026-10-02T15:00:00Z");
    old.payload.rate_limits.secondary = {
      window_minutes: 10080,
      resets_at: Date.parse("2026-10-05T00:00:00Z") / 1000,
      used_percent: 80,
    };
    await writeSession(homeDir, "limits", "gpt-6-sol", "/work", [
      old,
      quotaRow("2026-10-07T23:55:00Z", "2026-10-08T01:00:00Z"),
      current,
    ]);
    await store.sync({ env: {} });
    const report = await buildUsageReport({ homeDir, env: {} });
    const index = await buildUsageIndex({ homes: report.homes });
    const snapshot = pricedReport(report, asOf);
    assert.equal(report.perfSamples.length, 6, "real performance candidates include reviewer turns");
    assert.equal(report.events.filter((event) => event.model.toLowerCase() === "codex-auto-review").length, 3);
    for (const [preset, recentValue, expectedTotal, expectedSessions] of [
      ["all", "", 6175, 6],
      ["quota_5h", "", 100, 1],
      ["quota_week", "", 150, 2],
      ["recent", "上一个5h", 50, 1],
      ["recent", "上周", 25, 1],
    ]) {
      const filters = { preset, recentValue, now: asOf, bucket: "day", calendarZone: "utc" };
      const memory = summarizeUsage(report, filters);
      const indexed = store.summarize(filters);
      assert.equal(memory.perf.coverage.eligible, expectedSessions);
      assert.equal(indexed.perf.coverage.eligible, expectedSessions);
      assert.deepEqual(indexed.perf.coverage, memory.perf.coverage);
      const compact = summarizeUsageIndex(index, filters);
      setSummaryFilters({ ...filters, excludedHomes: [], startDate: "", endDate: "" });
      const browser = summarize(snapshot);
      for (const summary of [memory, indexed, compact, browser]) {
        assert.equal(summary.totals.total, expectedTotal, `${preset}/${recentValue}`);
        assert.equal(summary.sessionCount, expectedSessions);
        assert.equal(summary.eventCount, expectedSessions);
        assert.equal(
          summary.timeline.reduce((sum, row) => sum + row.total.total, 0),
          expectedTotal,
        );
        assert.equal(summary.models.length, preset === "all" ? 2 : 1);
        assert.equal(summary.quota.windows.quota_5h.usedPercent, 42.5, "keep observed quota percentage");
        assert.equal(summary.costEstimate.minimumRateModels.length, 0);
      }
      assert.deepEqual(summaryFields(indexed), summaryFields(memory));
      assert.deepEqual(summaryFields(compact), summaryFields(memory));
      assert.deepEqual(summaryFields(browser), summaryFields(memory));
      if (preset.startsWith("quota_")) {
        assert.equal(
          indexed.records.totalTokens.value,
          expectedTotal,
          "previous free tokens cannot inflate record baseline",
        );
        assert.equal(browser.records.totalTokens.value, expectedTotal);
      }
    }
    const reviewOnly = summarizeUsage(
      { ...report, events: report.events.filter((event) => event.model === "CODEX-AUTO-REVIEW") },
      { preset: "all" },
    );
    assert.equal(reviewOnly.costEstimate.totalUsd, 0);
    assert.equal(reviewOnly.costEstimate.minimumEstimatedRecords, 0);
  } finally {
    setSummaryFilters({
      preset: "today",
      bucket: "hour",
      calendarZone: "local",
      now: null,
      excludedHomes: [],
      startDate: "",
      endDate: "",
      recentValue: "上个月",
    });
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

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

async function writeSession(root, name, model, cwd, rows, client = { source: "cli", originator: "codex-tui" }) {
  const [year, month, day] = rows[0].timestamp.slice(0, 10).split("-");
  const sessionDir = path.join(root, ".codex", "sessions", year, month, day);
  await mkdir(sessionDir, { recursive: true });
  const lines = [
    {
      timestamp: rows[0].timestamp,
      type: "session_meta",
      payload: { id: name, ...client, cwd },
    },
    { type: "turn_context", payload: { model } },
    ...rows,
  ];
  await writeFile(
    path.join(sessionDir, `rollout-${name}.jsonl`),
    `${lines.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
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
    db.prepare("INSERT INTO session (id, parent_id, directory, path, title) VALUES (?, ?, ?, ?, ?)").run(
      "zcode-session",
      null,
      "/work/zcode",
      "/work/zcode",
      "ZCode fixture",
    );
    db.prepare(`INSERT INTO model_usage VALUES (${Array(20).fill("?").join(", ")})`).run(
      "zcode-usage",
      "zcode-session",
      "zcode-turn",
      "main_turn",
      "interactive",
      "test-provider",
      "test-model",
      "enabled",
      "zcode-agent",
      "build",
      "completed",
      Date.parse(timestamp) - 1000,
      Date.parse(timestamp),
      100,
      20,
      5,
      0,
      10,
      120,
      120,
    );
  } finally {
    db.close();
  }
}

/**
 * DSH 会话日志 fixture。注意必须写成**多帧拼接**的 zstd：
 * 真实 DSH 是流式追加的，而 zstdDecompressSync 整文件解压只会出第一帧且不报错，
 * 所以单帧 fixture 测不出「只读了第一帧」这类回归。
 */
async function writeDshSession(root, session, usage, timeIso, delegationDepth = 0) {
  const sessionDir = path.join(root, ".dsh", "sessions", "--work-dsh--", `session-${session}`);
  await mkdir(sessionDir, { recursive: true });
  const header = {
    type: "session",
    version: 4,
    id: `session-${session}`,
    createdAt: Date.parse(timeIso) - 1000,
    cwd: "/work/dsh",
    isSeeded: false,
    delegationDepth,
    agentPreset: "standard",
  };
  const request = {
    type: "request/header",
    seq: 2,
    time: Date.parse(timeIso) - 500,
    data: { header: { config: { provider: "test-provider", model: "test-model" } } },
  };
  const message = {
    type: "assistant/message",
    seq: 3,
    time: Date.parse(timeIso),
    data: { turn: 1, step: 1, usage },
  };
  const frames = [[header], [request, message]];
  await writeFile(
    path.join(sessionDir, "session.v4.jsonl.zstd"),
    Buffer.concat(
      frames.map((rows) => zstdCompressSync(Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`))),
    ),
  );
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
    models: comparison.models
      .map((row) => ({ key: row.key, periods: row.periods }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    repositories: comparison.repositories
      .map((row) => ({ key: row.key, periods: row.periods }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
}

test("memory, SQLite, and pure browser statistics agree for local and UTC usage", async () => {
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
    const snapshot = pricedReport(report, AS_OF);
    assert.equal(snapshot.events.length, report.events.length);

    for (const calendarZone of ["local", "utc"]) {
      const periodOptions = { now: AS_OF, calendarZone };
      const memoryComparison = summarizePeriodComparison(report.events, periodOptions);
      const indexedComparison = store.periodComparison(periodOptions);
      const snapshotComparison = periodComparisonForReport(snapshot, calendarZone);
      assert.deepEqual(
        comparisonFields(indexedComparison),
        comparisonFields(memoryComparison),
        `${calendarZone} SQLite period comparison`,
      );
      assert.deepEqual(
        comparisonFields(snapshotComparison),
        comparisonFields(memoryComparison),
        `${calendarZone} snapshot period comparison`,
      );

      for (const preset of ["today", "all", "quota_5h"]) {
        const filters = { preset, bucket: preset === "quota_5h" ? "quota_30m" : "day", now: AS_OF, calendarZone };
        const memorySummary = summarizeUsage(report, filters);
        const indexedSummary = store.summarize(filters);
        setSummaryFilters({ ...filters, excludedHomes: [], startDate: "", endDate: "", recentValue: "" });
        const snapshotSummary = summarize(snapshot);
        if (preset === "all") assert.equal(memorySummary.totals.total, 275);
        if (preset === "quota_5h") assert.equal(memorySummary.totals.total, 75);
        if (calendarZone === "utc" && preset === "today") assert.equal(memorySummary.totals.total, 155);
        assert.deepEqual(
          summaryFields(indexedSummary),
          summaryFields(memorySummary),
          `${calendarZone}/${preset} SQLite summary`,
        );
        assert.deepEqual(
          summaryFields(snapshotSummary),
          summaryFields(memorySummary),
          `${calendarZone}/${preset} snapshot summary`,
        );
      }
    }
  } finally {
    setSummaryFilters({
      preset: "today",
      bucket: "hour",
      calendarZone: "local",
      now: null,
      excludedHomes: [],
      startDate: "",
      endDate: "",
      recentValue: "上个月",
    });
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
    const snapshot = pricedReport(report, asOf);
    assert.equal(snapshot.pricing.checkedAt, "2026-09-01");
    assert.equal(snapshot.events.length, 4);
    const pricedCodexEvent = snapshot.events.find((event) => event.sessionId === "tuesday");
    assert.ok(pricedCodexEvent);
    assert.ok(
      Math.abs(pricedCodexEvent.costEstimate.outputUsd - 0.0004) < 1e-12,
      JSON.stringify(pricedCodexEvent.costEstimate),
    );

    const recordDay = store.summarize({
      preset: "custom",
      startDate: "2026-09-01",
      endDate: "2026-09-01",
      bucket: "day",
      calendarZone: "utc",
      now: asOf,
      excludeHomes: [zcodeHome.id],
    });
    assert.equal(recordDay.records.totalCost.period, "2026-09-01");
    assert.ok(
      Math.abs(recordDay.records.totalCost.value - recordDay.costEstimate.totalUsd * getPricingCatalog().usdToCnyRate) <
        1e-12,
    );

    for (const calendarZone of ["local", "utc"]) {
      const periodOptions = { now: asOf, calendarZone };
      const memoryComparison = summarizePeriodComparison(report.events, periodOptions);
      const indexedComparison = store.periodComparison(periodOptions);
      assert.deepEqual(
        comparisonFields(indexedComparison),
        comparisonFields(memoryComparison),
        `${calendarZone} SQLite period comparison`,
      );

      for (const excludedHomes of [[], [zcodeHome.id]]) {
        const scope = excludedHomes.length ? "without ZCode" : "all sources";
        const filteredReport = excludedHomes.length
          ? { ...report, events: report.events.filter((event) => !excludedHomes.includes(event.homeId)) }
          : report;
        const expectedComparison = summarizePeriodComparison(filteredReport.events, periodOptions);
        assert.deepEqual(
          comparisonFields(store.periodComparison({ ...periodOptions, excludeHomes: excludedHomes })),
          comparisonFields(expectedComparison),
          `${calendarZone}/${scope} SQLite period comparison`,
        );
        setSummaryFilters({
          preset: "all",
          bucket: "day",
          calendarZone,
          now: asOf,
          excludedHomes,
          startDate: "",
          endDate: "",
          recentValue: "",
        });
        assert.deepEqual(
          comparisonFields(periodComparisonForReport(snapshot, calendarZone)),
          comparisonFields(expectedComparison),
          `${calendarZone}/${scope} snapshot period comparison`,
        );

        for (const preset of ["all", "week", "month"]) {
          const filters = { preset, bucket: "day", now: asOf, calendarZone };
          const memorySummary = summarizeUsage(filteredReport, filters);
          const indexedSummary = store.summarize({ ...filters, excludeHomes: excludedHomes });
          setSummaryFilters({ ...filters, excludedHomes, startDate: "", endDate: "", recentValue: "" });
          const snapshotSummary = summarize(snapshot);
          if (calendarZone === "utc") {
            const expected = excludedHomes.length
              ? { all: 180, week: 140, month: 80 }
              : { all: 300, week: 260, month: 200 };
            assert.equal(memorySummary.totals.total, expected[preset], `${scope}/${preset} UTC fixture total`);
          }
          assert.deepEqual(
            summaryFields(indexedSummary),
            summaryFields(memorySummary),
            `${calendarZone}/${scope}/${preset} SQLite summary`,
          );
          assert.deepEqual(
            summaryFields(snapshotSummary),
            summaryFields(memorySummary),
            `${calendarZone}/${scope}/${preset} snapshot summary`,
          );
        }
      }
    }
  } finally {
    setSummaryFilters({
      preset: "today",
      bucket: "hour",
      calendarZone: "local",
      now: null,
      excludedHomes: [],
      startDate: "",
      endDate: "",
      recentValue: "上个月",
    });
    resetPricingCatalog();
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("three paths agree on DSH usage, including the input/cache split and quota exclusion", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-three-path-dsh-"));
  const store = new UsageStore({ homeDir, databaseFile: path.join(homeDir, "usage-index.sqlite") });
  const asOf = "2026-07-12T12:00:00.000Z";
  try {
    // 一个 Codex 会话提供限额窗口（DSH 没有限额数据）。
    await writeSession(homeDir, "codex-quota", "gpt-6-sol", "/work/codex", [
      tokenRow("2026-07-12T11:30:00.000Z", 45, 40, 0, 5, 1),
      quotaRow("2026-07-12T11:59:00.000Z", "2026-07-12T14:37:00.000Z"),
    ]);
    // DSH 主会话：数字取自真实日志实测样本。
    await writeDshSession(
      homeDir,
      "main",
      { inputTokens: 1614, outputTokens: 127, cacheReadTokens: 6784, cacheWriteTokens: 0, totalTokens: 8525 },
      "2026-07-12T10:00:00.000Z",
    );
    // DSH 子代理会话：delegationDepth > 0 应归到 "DSH Subagent" 渠道。
    await writeDshSession(
      homeDir,
      "sub",
      { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 0, totalTokens: 160 },
      "2026-07-12T11:00:00.000Z",
      1,
    );

    await store.sync();
    const report = await buildUsageReport({ homeDir, env: {} });
    assert.equal(report.events.length, 3, "Codex 1 + DSH 2");
    const dshHome = report.homes.find((home) => home.kind === "dsh");
    assert.ok(dshHome, "应发现 DSH 来源");

    // 映射不变量：DSH 的并列计数被重构成 cached <= input 的超集。
    const mainEvent = report.events.find((event) => event.sessionId === "session-main");
    assert.deepEqual(mainEvent.total, { total: 8525, input: 8398, cached: 6784, output: 127, reasoning: 0 });
    assert.equal(mainEvent.requestInputTokens, 8398);
    assert.equal(mainEvent.channel, "DSH");
    assert.equal(mainEvent.repositoryKey, "directory:/work/dsh");
    const subEvent = report.events.find((event) => event.sessionId === "session-sub");
    assert.equal(subEvent.channel, "DSH Subagent");

    const snapshot = pricedReport(report, asOf);
    assert.equal(snapshot.events.length, report.events.length);

    for (const calendarZone of ["local", "utc"]) {
      const periodOptions = { now: asOf, calendarZone };
      const memoryComparison = summarizePeriodComparison(report.events, periodOptions);
      const indexedComparison = store.periodComparison(periodOptions);
      const snapshotComparison = periodComparisonForReport(snapshot, calendarZone);
      assert.deepEqual(
        comparisonFields(indexedComparison),
        comparisonFields(memoryComparison),
        `${calendarZone} SQLite period comparison`,
      );
      assert.deepEqual(
        comparisonFields(snapshotComparison),
        comparisonFields(memoryComparison),
        `${calendarZone} snapshot period comparison`,
      );

      for (const preset of ["today", "all", "quota_5h"]) {
        const filters = { preset, bucket: preset === "quota_5h" ? "quota_30m" : "day", now: asOf, calendarZone };
        // 限额窗口只统计 Codex。store 与快照路径都内建了「排除非 Codex 来源」，
        // 而内存版 summarizeUsage 只按时间过滤，来源范围由调用方负责，
        // 所以这里显式喂给它同一个范围，三条路径才可比。
        const scopedReport =
          preset === "quota_5h"
            ? { ...report, events: report.events.filter((event) => event.homeId !== dshHome.id) }
            : report;
        const memorySummary = summarizeUsage(scopedReport, filters);
        const indexedSummary = store.summarize(filters);
        setSummaryFilters({ ...filters, excludedHomes: [], startDate: "", endDate: "", recentValue: "" });
        const snapshotSummary = summarize(snapshot);

        if (preset === "all") {
          // 8525 + 160 + 45
          assert.equal(memorySummary.totals.total, 8730, `${calendarZone} all-time total`);
          assert.deepEqual(
            memorySummary.channels
              .map((channel) => [channel.name, channel.total.total])
              .sort((a, b) => a[0].localeCompare(b[0])),
            [
              ["Codex", 45],
              ["DSH", 8685],
            ],
            `${calendarZone} DSH channels`,
          );
        }
        if (preset === "quota_5h") {
          assert.equal(memorySummary.totals.total, 45, `${calendarZone} quota window Codex-only total`);
          // 同一窗口若不过滤来源，DSH 的 8525 + 160 会全部漏进来。
          // 这条钉住「排除确实生效」，而不是碰巧窗口为空。
          const unfiltered = summarizeUsage(report, filters);
          assert.equal(unfiltered.totals.total, 8730, `${calendarZone} unfiltered window would include DSH`);
          // store 与快照都必须自己完成这次排除。
          assert.equal(indexedSummary.totals.total, 45, `${calendarZone} store quota must exclude DSH itself`);
          assert.equal(snapshotSummary.totals.total, 45, `${calendarZone} snapshot quota must exclude DSH itself`);
          assert.ok(
            !snapshotSummary.channels.some((channel) => channel.name.startsWith("DSH")),
            `${calendarZone} snapshot quota must not list DSH`,
          );
        }

        assert.deepEqual(
          summaryFields(indexedSummary),
          summaryFields(memorySummary),
          `${calendarZone}/${preset} SQLite summary`,
        );
        assert.deepEqual(
          summaryFields(snapshotSummary),
          summaryFields(memorySummary),
          `${calendarZone}/${preset} snapshot summary`,
        );
      }
    }
  } finally {
    setSummaryFilters({
      preset: "today",
      bucket: "hour",
      calendarZone: "local",
      now: null,
      excludedHomes: [],
      startDate: "",
      endDate: "",
      recentValue: "上个月",
    });
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

/**
 * OpenCode 数据库 fixture。单库单会话，tokens 用"三陷阱齐全"样本
 * （input/cache.read/cache.write 并列 + reasoning 独立），
 * 覆盖 DSH 遇不到的 cache.write 口径。
 */
async function writeOpencodeUsage(root, sessionId, tokens, timeIso) {
  const dataDir = path.join(root, ".local", "share", "opencode");
  await mkdir(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "opencode.db"));
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, version TEXT, agent TEXT, model TEXT);
      CREATE TABLE IF NOT EXISTS session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    db.prepare("INSERT INTO session_v2 (id, directory, title, version, agent, model) VALUES (?, ?, ?, ?, ?, ?)").run(
      sessionId,
      "/work/oc",
      "oc title",
      "2.0.19",
      "build",
      null,
    );
    db.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      `msg-${sessionId}`,
      sessionId,
      "assistant",
      0,
      Date.parse(timeIso),
      Date.parse(timeIso),
      JSON.stringify({
        time: { created: Date.parse(timeIso), completed: Date.parse(timeIso) + 1000 },
        model: { id: "test-model", providerID: "opencode" },
        tokens: {
          input: tokens.input,
          output: tokens.output,
          reasoning: tokens.reasoning,
          cache: { read: tokens.cacheRead, write: tokens.cacheWrite },
        },
      }),
    );
  } finally {
    db.close();
  }
}

test("three paths agree on OpenCode usage, including all three parallel-counter traps and quota exclusion", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-three-path-opencode-"));
  // env: {} 保证只发现 fixture 目录，不撞上本机真实数据目录。
  const store = new UsageStore({ homeDir, env: {}, databaseFile: path.join(homeDir, "usage-index.sqlite") });
  const asOf = "2026-07-12T12:00:00.000Z";
  try {
    // 一个 Codex 会话提供限额窗口（OpenCode 没有限额数据）。
    await writeSession(homeDir, "codex-quota", "gpt-6-sol", "/work/codex", [
      tokenRow("2026-07-12T11:30:00.000Z", 45, 40, 0, 5, 1),
      quotaRow("2026-07-12T11:59:00.000Z", "2026-07-12T14:37:00.000Z"),
    ]);
    // 三陷阱齐全：input 1000 + cache.read 5000 + cache.write 2000 → 总输入 8000；
    // output 10 + reasoning 300 → 总输出 310；总量 8310。
    await writeOpencodeUsage(
      homeDir,
      "session-oc",
      { input: 1000, output: 10, reasoning: 300, cacheRead: 5000, cacheWrite: 2000 },
      "2026-07-12T10:00:00.000Z",
    );

    await store.sync();
    const report = await buildUsageReport({ homeDir, env: {} });
    assert.equal(report.events.length, 2, "Codex 1 + OpenCode 1");
    const opencodeHome = report.homes.find((home) => home.kind === "opencode");
    assert.ok(opencodeHome, "应发现 OpenCode 来源");

    const ocEvent = report.events.find((event) => event.sessionId === "session-oc");
    assert.deepEqual(ocEvent.total, { total: 8310, input: 8000, cached: 5000, output: 310, reasoning: 300 });
    assert.equal(ocEvent.requestInputTokens, 8000);
    assert.equal(ocEvent.channel, "OpenCode");
    assert.equal(ocEvent.repositoryKey, "directory:/work/oc");

    const snapshot = pricedReport(report, asOf);
    assert.equal(snapshot.events.length, report.events.length);

    for (const calendarZone of ["local", "utc"]) {
      const periodOptions = { now: asOf, calendarZone };
      const memoryComparison = summarizePeriodComparison(report.events, periodOptions);
      const indexedComparison = store.periodComparison(periodOptions);
      const snapshotComparison = periodComparisonForReport(snapshot, calendarZone);
      assert.deepEqual(
        comparisonFields(indexedComparison),
        comparisonFields(memoryComparison),
        `${calendarZone} SQLite period comparison`,
      );
      assert.deepEqual(
        comparisonFields(snapshotComparison),
        comparisonFields(memoryComparison),
        `${calendarZone} snapshot period comparison`,
      );

      for (const preset of ["today", "all", "quota_5h"]) {
        const filters = { preset, bucket: preset === "quota_5h" ? "quota_30m" : "day", now: asOf, calendarZone };
        // 限额窗口只统计 Codex，内存版需显式过滤 OpenCode 事件才可比。
        const scopedReport =
          preset === "quota_5h"
            ? { ...report, events: report.events.filter((event) => event.homeId !== opencodeHome.id) }
            : report;
        const memorySummary = summarizeUsage(scopedReport, filters);
        const indexedSummary = store.summarize(filters);
        setSummaryFilters({ ...filters, excludedHomes: [], startDate: "", endDate: "", recentValue: "" });
        const snapshotSummary = summarize(snapshot);

        if (preset === "all") {
          // 8310 + 45
          assert.equal(memorySummary.totals.total, 8355, `${calendarZone} all-time total`);
          assert.deepEqual(
            memorySummary.channels
              .map((channel) => [channel.name, channel.total.total])
              .sort((a, b) => a[0].localeCompare(b[0])),
            [
              ["Codex", 45],
              ["OpenCode", 8310],
            ],
            `${calendarZone} OpenCode channels`,
          );
        }
        if (preset === "quota_5h") {
          assert.equal(memorySummary.totals.total, 45, `${calendarZone} quota window Codex-only total`);
          const unfiltered = summarizeUsage(report, filters);
          assert.equal(unfiltered.totals.total, 8355, `${calendarZone} unfiltered window would include OpenCode`);
          assert.equal(indexedSummary.totals.total, 45, `${calendarZone} store quota must exclude OpenCode itself`);
          assert.equal(snapshotSummary.totals.total, 45, `${calendarZone} snapshot quota must exclude OpenCode itself`);
          assert.ok(
            !snapshotSummary.channels.some((channel) => channel.name.startsWith("OpenCode")),
            `${calendarZone} snapshot quota must not list OpenCode`,
          );
        }

        assert.deepEqual(
          summaryFields(indexedSummary),
          summaryFields(memorySummary),
          `${calendarZone}/${preset} SQLite summary`,
        );
        assert.deepEqual(
          summaryFields(snapshotSummary),
          summaryFields(memorySummary),
          `${calendarZone}/${preset} snapshot summary`,
        );
      }
    }
  } finally {
    setSummaryFilters({
      preset: "today",
      bucket: "hour",
      calendarZone: "local",
      now: null,
      excludedHomes: [],
      startDate: "",
      endDate: "",
      recentValue: "上个月",
    });
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

/**
 * Claude Code 转录 fixture。主转录里同一 `message.id` 写两次（真实格式是"每内容块一行"），
 * 子代理目录里先零用量占位块、再真实块；按产品口径子代理并入主渠道、会话 id 用父会话。
 */
async function writeClaudeSession(root, { sessionId, rows, subagentRows = [] }) {
  const projectDir = path.join(root, ".claude", "projects", "E--work-claude");
  await mkdir(projectDir, { recursive: true });
  const encode = (list) => `${list.map((row) => JSON.stringify(row)).join("\n")}\n`;
  await writeFile(path.join(projectDir, `${sessionId}.jsonl`), encode(rows));
  if (subagentRows.length > 0) {
    const subagentsDir = path.join(projectDir, sessionId, "subagents");
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(path.join(subagentsDir, "agent-a1.jsonl"), encode(subagentRows));
  }
}

/** @param {Record<string, any>} [usage] */
function claudeRow(sessionId, messageId, timeIso, usage, { cwd = "/work/claude", model = "claude-sonnet-4-5" } = {}) {
  return {
    type: "assistant",
    uuid: `uuid-${messageId}`,
    timestamp: timeIso,
    sessionId,
    cwd,
    requestedModel: model,
    message: { id: messageId, model, usage },
  };
}

test("three paths agree on Claude Code usage, including message.id dedup and subagent merge", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-three-path-claude-"));
  // env: {} 保证只发现 fixture 目录，不撞上本机真实的 ~/.claude。
  const store = new UsageStore({ homeDir, env: {}, databaseFile: path.join(homeDir, "usage-index.sqlite") });
  const asOf = "2026-07-12T12:00:00.000Z";
  try {
    // Codex 会话提供限额窗口（Claude 没有限额数据）。
    await writeSession(homeDir, "codex-quota", "gpt-6-sol", "/work/codex", [
      tokenRow("2026-07-12T11:30:00.000Z", 45, 40, 0, 5, 1),
      quotaRow("2026-07-12T11:59:00.000Z", "2026-07-12T14:37:00.000Z"),
    ]);
    // 主转录：100 + 10 cache_read + 5 cache_write = 115 输入，20 输出 ⇒ 135；
    // 同一 message.id 的第二块不得重复计数。
    await writeClaudeSession(homeDir, {
      sessionId: "session-claude",
      rows: [
        { type: "custom-title", customTitle: "Claude 会话", sessionId: "session-claude" },
        claudeRow("session-claude", "msg-main", "2026-07-12T10:00:00.000Z", {
          input_tokens: 100,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
          output_tokens: 20,
        }),
        claudeRow("session-claude", "msg-main", "2026-07-12T10:00:00.000Z", {
          input_tokens: 100,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
          output_tokens: 20,
        }),
      ],
      // 子代理：零用量占位块 + 真实块 5 + 0 + 0 输入、3 输出 ⇒ 8。
      subagentRows: [
        claudeRow("session-claude", "msg-sub", "2026-07-12T10:05:00.000Z", {
          input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 0,
        }),
        claudeRow("session-claude", "msg-sub", "2026-07-12T10:05:00.000Z", {
          input_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 3,
        }),
      ],
    });

    await store.sync();
    const report = await buildUsageReport({ homeDir, env: {} });
    assert.equal(report.events.length, 3, "Codex 1 + Claude 主转录 1 + 子代理 1");
    const claudeHome = report.homes.find((home) => home.kind === "claude");
    assert.ok(claudeHome, "应发现 Claude Code 来源");

    const mainEvent = report.events.find((event) => event.id === "msg-main");
    assert.deepEqual(mainEvent.total, { total: 135, input: 115, cached: 10, output: 20, reasoning: 0 });
    assert.equal(mainEvent.requestInputTokens, 115);
    assert.equal(mainEvent.channel, "Claude Code");
    assert.equal(mainEvent.repositoryKey, "directory:/work/claude");
    assert.equal(mainEvent.conversationName, "Claude 会话");
    // 子代理事件合并到主渠道、父会话 id。
    const subEvent = report.events.find((event) => event.id === "msg-sub");
    assert.equal(subEvent.channel, "Claude Code");
    assert.equal(subEvent.sessionId, "session-claude");

    const snapshot = pricedReport(report, asOf);
    assert.equal(snapshot.events.length, report.events.length);

    for (const calendarZone of ["local", "utc"]) {
      const periodOptions = { now: asOf, calendarZone };
      const memoryComparison = summarizePeriodComparison(report.events, periodOptions);
      const indexedComparison = store.periodComparison(periodOptions);
      const snapshotComparison = periodComparisonForReport(snapshot, calendarZone);
      assert.deepEqual(
        comparisonFields(indexedComparison),
        comparisonFields(memoryComparison),
        `${calendarZone} SQLite period comparison`,
      );
      assert.deepEqual(
        comparisonFields(snapshotComparison),
        comparisonFields(memoryComparison),
        `${calendarZone} snapshot period comparison`,
      );

      for (const preset of ["today", "all", "quota_5h"]) {
        const filters = { preset, bucket: preset === "quota_5h" ? "quota_30m" : "day", now: asOf, calendarZone };
        // 限额窗口只统计 Codex，内存版需显式过滤 Claude 事件才可比。
        const scopedReport =
          preset === "quota_5h"
            ? { ...report, events: report.events.filter((event) => event.homeId !== claudeHome.id) }
            : report;
        const memorySummary = summarizeUsage(scopedReport, filters);
        const indexedSummary = store.summarize(filters);
        setSummaryFilters({ ...filters, excludedHomes: [], startDate: "", endDate: "", recentValue: "" });
        const snapshotSummary = summarize(snapshot);

        if (preset === "all") {
          // 135 + 8 + 45
          assert.equal(memorySummary.totals.total, 188, `${calendarZone} all-time total`);
          assert.deepEqual(
            memorySummary.channels
              .map((channel) => [channel.name, channel.total.total])
              .sort((a, b) => a[0].localeCompare(b[0])),
            [
              ["Claude", 143],
              ["Codex", 45],
            ],
            `${calendarZone} Claude channels`,
          );
          assert.deepEqual(memorySummary.models.map((model) => model.name).sort(), ["claude-sonnet-4-5", "gpt-6-sol"]);
        }
        if (preset === "quota_5h") {
          assert.equal(memorySummary.totals.total, 45, `${calendarZone} quota window Codex-only total`);
          const unfiltered = summarizeUsage(report, filters);
          assert.equal(unfiltered.totals.total, 188, `${calendarZone} unfiltered window would include Claude`);
          assert.equal(indexedSummary.totals.total, 45, `${calendarZone} store quota must exclude Claude itself`);
          assert.equal(snapshotSummary.totals.total, 45, `${calendarZone} snapshot quota must exclude Claude itself`);
          assert.ok(
            !snapshotSummary.channels.some((channel) => channel.name.startsWith("Claude")),
            `${calendarZone} snapshot quota must not list Claude`,
          );
        }

        assert.deepEqual(
          summaryFields(indexedSummary),
          summaryFields(memorySummary),
          `${calendarZone}/${preset} SQLite summary`,
        );
        assert.deepEqual(
          summaryFields(snapshotSummary),
          summaryFields(memorySummary),
          `${calendarZone}/${preset} snapshot summary`,
        );
      }
    }
  } finally {
    setSummaryFilters({
      preset: "today",
      bucket: "hour",
      calendarZone: "local",
      now: null,
      excludedHomes: [],
      startDate: "",
      endDate: "",
      recentValue: "上个月",
    });
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("three paths agree on week-bucket escalation for a half-year all-time range", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-three-path-halfyear-"));
  const store = new UsageStore({ homeDir, databaseFile: path.join(homeDir, "usage-index.sqlite") });
  const asOf = "2026-09-01T12:00:00.000Z";
  try {
    await writeSession(homeDir, "march", "gpt-6-sol", "/work/halfyear", [
      tokenRow("2026-03-15T10:00:00.000Z", 40, 30, 0, 10, 2),
    ]);
    await writeSession(homeDir, "september", "gpt-6-luna", "/work/halfyear", [
      tokenRow("2026-09-01T10:00:00.000Z", 80, 60, 0, 20, 4),
    ]);

    await store.sync();
    const report = await buildUsageReport({ homeDir });
    assert.equal(report.events.length, 2);
    const snapshot = pricedReport(report, asOf);
    assert.equal(snapshot.events.length, 2);

    for (const calendarZone of ["local", "utc"]) {
      const filters = { preset: "all", bucket: "day", now: asOf, calendarZone };
      const memorySummary = summarizeUsage(report, filters);
      const indexedSummary = store.summarize(filters);
      setSummaryFilters({ ...filters, excludedHomes: [], startDate: "", endDate: "", recentValue: "" });
      const snapshotSummary = summarize(snapshot);

      assert.equal(memorySummary.range.bucket, "week", `${calendarZone} span escalation to week`);
      assert.equal(memorySummary.timeline.length, 26, `${calendarZone} week slot count`);
      assert.equal(memorySummary.timeline[0].key, "2026-03-09", `${calendarZone} first Monday key`);
      assert.equal(memorySummary.timeline.at(-1).key, "2026-08-31", `${calendarZone} last Monday key`);
      assert.equal(memorySummary.timeline[0].total.total, 40, `${calendarZone} March week total`);
      assert.equal(memorySummary.timeline.at(-1).total.total, 80, `${calendarZone} September week total`);
      assert.equal(memorySummary.totals.total, 120, `${calendarZone} all-time total`);
      assert.deepEqual(
        summaryFields(indexedSummary),
        summaryFields(memorySummary),
        `${calendarZone} SQLite half-year summary`,
      );
      assert.deepEqual(
        summaryFields(snapshotSummary),
        summaryFields(memorySummary),
        `${calendarZone} snapshot half-year summary`,
      );
    }
  } finally {
    setSummaryFilters({
      preset: "today",
      bucket: "hour",
      calendarZone: "local",
      now: null,
      excludedHomes: [],
      startDate: "",
      endDate: "",
      recentValue: "上个月",
    });
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("three paths use the independent GPT-6.1 Sol catalog entry", async () => {
  resetPricingCatalog();
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-three-path-gpt-61-sol-"));
  const store = new UsageStore({ homeDir, databaseFile: path.join(homeDir, "usage-index.sqlite") });
  const asOf = "2026-09-01T12:00:00.000Z";
  try {
    await writeSession(homeDir, "sol", "gpt-6.1-sol", "/work/sol", [
      tokenRow("2026-09-01T10:00:00.000Z", 11_000, 10_000, 5_000, 1_000, 0),
    ]);
    await store.sync();
    const report = await buildUsageReport({ homeDir });
    const snapshot = pricedReport(report, asOf);
    const filters = { preset: "all", bucket: "day", now: asOf, calendarZone: "utc" };
    const memorySummary = summarizeUsage(report, filters);
    const indexedSummary = store.summarize(filters);
    setSummaryFilters({ ...filters, excludedHomes: [], startDate: "", endDate: "", recentValue: "" });
    const snapshotSummary = summarize(snapshot);

    assert.ok(Math.abs(memorySummary.costEstimate.totalUsd - 0.0205) < 1e-12);
    assert.deepEqual(summaryFields(indexedSummary), summaryFields(memorySummary));
    assert.deepEqual(summaryFields(snapshotSummary), summaryFields(memorySummary));
    assert.deepEqual(memorySummary.costEstimate.minimumRateModels, []);
  } finally {
    resetPricingCatalog();
    setSummaryFilters({
      preset: "today",
      bucket: "hour",
      calendarZone: "local",
      now: null,
      excludedHomes: [],
      startDate: "",
      endDate: "",
      recentValue: "上个月",
    });
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("long GPT-6.1 requests agree across Codex, Work, external imports, compact indexes and frozen stores", async () => {
  resetPricingCatalog();
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-context-policy-"));
  const imported = path.join(homeDir, "external-project");
  const options = { homeDir, env: {}, importDirs: [imported] };
  const store = new UsageStore({ ...options, databaseFile: path.join(homeDir, "index.sqlite") });
  const frozen = new UsageStore({ databaseFile: path.join(homeDir, "frozen.sqlite") });
  const asOf = "2026-10-12T08:00:00Z";
  const filters = { preset: "all", bucket: "day", now: asOf, calendarZone: "utc" };
  const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
  try {
    const native = tokenRow("2026-10-09T10:00:00Z", 300_100, 300_000, 100_000, 100, 0);
    native.payload.service_tier = "standard";
    native.payload.info.total_token_usage.cache_write_input_tokens = 0;
    native.payload.info.last_token_usage = native.payload.info.total_token_usage;
    await writeSession(homeDir, "native", "gpt-6.1-sol", homeDir, [native]);
    const work = tokenRow("2026-10-10T10:00:00Z", 600_100, 600_000, 100_000, 100, 0);
    work.payload.service_tier = "fast";
    work.payload.info.total_token_usage.cache_write_input_tokens = 50_000;
    work.payload.info.last_token_usage = work.payload.info.total_token_usage;
    await writeSession(homeDir, "work", "gpt-6.1-sol", homeDir, [work], {
      source: { subagent: { thread_spawn: { parent_thread_id: "native", depth: 1 } } },
      originator: "codex_work_desktop",
    });
    await mkdir(path.join(imported, ".codex-usage"), { recursive: true });
    await writeFile(
      path.join(imported, ".codex-usage", "usage.jsonl"),
      `${JSON.stringify({
        schema_version: "codex-usage.project-log.v1",
        timestamp: "2026-10-11T10:00:00Z",
        session_id: "external",
        request_id: "external-request",
        project_root: imported,
        cwd: imported,
        source: "codex-oauth",
        channel: "Codex Desktop",
        auth: "codex-oauth",
        model: "gpt-6.1-sol",
        service_tier: "standard",
        usage: { total: 300_100, input: 300_000, cached: 100_000, output: 100, cache_write_input_tokens: 0 },
      })}\n`,
    );
    await store.sync();
    const report = await buildUsageReport(options);
    assert.equal(report.events.length, 3);
    assert.equal(report.events.find((event) => event.sessionId === "work").originator, "codex_work_desktop");
    assert.ok(report.events.every((event) => event.contextLevel === "long"));
    const raw = JSON.stringify(report.events);
    const browserReport = pricedReport(report, asOf);
    closeTo(browserReport.events.find((event) => event.sessionId === "native").costEstimate.totalUsd, 0.411);
    closeTo(browserReport.events.find((event) => event.sessionId === "work").costEstimate.totalUsd, 2.072);
    closeTo(browserReport.events.find((event) => event.sessionId === "external").costEstimate.totalUsd, 0.8215);
    const memory = summarizeUsage(report, filters);
    const indexed = store.summarize(filters);
    const compact = summarizeUsageIndex(await buildUsageIndex(options), filters);
    setSummaryFilters({ ...filters, excludedHomes: [], startDate: "", endDate: "", recentValue: "" });
    for (const summary of [memory, indexed, compact, summarize(browserReport)]) {
      closeTo(summary.costEstimate.totalUsd, 3.3045);
      assert.deepEqual(summaryFields(summary), summaryFields(memory));
    }
    closeTo(store.costEstimateRange({ preset: "all", start: null, end: new Date(asOf) }).totalUsd, 3.3045);
    const champions = store.buildRecordChampions("utc", "", [], 6.72);
    closeTo(champions.day.totalCost.value, 2.072 * 6.72);
    await backup(store.database, frozen.databaseFile);
    await frozen.open();
    frozen.homes = store.homes;
    frozen.serviceTierEvidence = store.serviceTierEvidence;
    assert.deepEqual(summaryFields(frozen.summarize(filters)), summaryFields(indexed));
    assert.equal(JSON.stringify(report.events), raw, "pricing must not mutate original context or token data");
  } finally {
    frozen.close();
    store.close();
    resetPricingCatalog();
    setSummaryFilters({
      preset: "today",
      bucket: "hour",
      calendarZone: "local",
      now: null,
      excludedHomes: [],
      startDate: "",
      endDate: "",
      recentValue: "上个月",
    });
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("D2 · 非限额 New Record 只在 SQLite 路径产生（有意差异不得被抹平）+ 历史冠军 memo 不改变日/周/月包含判定", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-d2-parity-"));
  const store = new UsageStore({ homeDir, databaseFile: path.join(homeDir, "usage-index.sqlite") });
  try {
    // 日冠军 07-12（900）与周冠军 07-13 起的那一周（7×200=1400）**不同周** ⇒ 三个单位都能被观察到。
    const days = [
      ["2026-07-12", 900],
      ...["13", "14", "15", "16", "17", "18", "19"].map((day) => [`2026-07-${day}`, 200]),
    ];
    for (const [date, total] of days) {
      await writeSession(homeDir, `d2-${date}`, "gpt-6-sol", "/work", [
        tokenRow(`${date}T02:00:00.000Z`, total, total - 1, 0, 1, 0),
      ]);
    }
    await store.sync({ env: {} });
    const report = await buildUsageReport({ homeDir, env: {} });
    const index = await buildUsageIndex({ homes: report.homes });
    const snapshot = pricedReport(report, AS_OF);
    for (const [startDate, endDate, expected] of [
      ["2026-07-12", "2026-07-12", { unit: "day", period: "2026-07-12", value: 900 }],
      ["2026-07-13", "2026-07-19", { unit: "week", period: "2026-07-13", value: 1400 }],
      ["2026-07-14", "2026-07-19", null],
    ]) {
      const filters = { preset: "custom", startDate, endDate, bucket: "day", calendarZone: "local", now: AS_OF };
      const indexed = store.summarize(filters).records.totalTokens;
      const memoryRecords = summarizeUsage(report, filters).records;
      const compactRecords = summarizeUsageIndex(index, filters).records;
      setSummaryFilters({
        preset: "custom",
        startDate,
        endDate,
        bucket: "day",
        calendarZone: "local",
        now: AS_OF,
        excludedHomes: [],
        recentValue: "",
      });
      const browserRecords = summarize(snapshot).records;
      const scope = `${startDate}..${endDate}`;
      for (const [label, value] of [
        ["memory", memoryRecords],
        ["compact", compactRecords],
        ["browser", browserRecords],
      ]) {
        assert.deepEqual(value ?? {}, {}, `${label} 路径按设计不产非限额 records（${scope}）`);
      }
      if (expected) {
        assert.equal(indexed.unit, expected.unit, `${scope} 单位`);
        assert.equal(indexed.period, expected.period, `${scope} 冠军期`);
        assert.equal(indexed.value, expected.value, `${scope} 冠军值`);
      } else {
        assert.equal(indexed, undefined, `${scope} 跨周/跨月不完整包含 ⇒ 不点亮`);
      }
      // 同一 store 连续两次（第二次必然吃 D2 的历史冠军 memo）结论必须逐字不变。
      assert.deepEqual(store.summarize(filters).records, store.summarize(filters).records, `${scope} 暖 memo 一致`);
    }
  } finally {
    setSummaryFilters({
      preset: "today",
      bucket: "hour",
      calendarZone: "local",
      now: null,
      excludedHomes: [],
      startDate: "",
      endDate: "",
      recentValue: "上个月",
    });
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
