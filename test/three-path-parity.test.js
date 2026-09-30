import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import { zstdCompressSync } from "node:zlib";

import { setSummaryFilters, staticPeriodComparison, summarize } from "../public/app.js";
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
    {
      timestamp: rows[0].timestamp,
      type: "session_meta",
      payload: { id: name, source: "cli", originator: "codex-tui", cwd },
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
    models: comparison.models
      .map((row) => ({ key: row.key, periods: row.periods }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    repositories: comparison.repositories
      .map((row) => ({ key: row.key, periods: row.periods }))
      .sort((a, b) => a.key.localeCompare(b.key)),
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
      const snapshotComparison = staticPeriodComparison(snapshot.__CODEX_USAGE_REPORT__, calendarZone);
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
        const snapshotSummary = summarize(snapshot.__CODEX_USAGE_REPORT__);
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
    const snapshot = embeddedSnapshot(renderStaticDashboardHtml({ ...report, asOf }));
    assert.equal(snapshot.__CODEX_USAGE_REPORT__.pricing.checkedAt, "2026-09-01");
    assert.equal(snapshot.__CODEX_USAGE_REPORT__.events.length, 4);
    const pricedCodexEvent = snapshot.__CODEX_USAGE_REPORT__.events.find((event) => event.sessionId === "tuesday");
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
          comparisonFields(staticPeriodComparison(snapshot.__CODEX_USAGE_REPORT__, calendarZone)),
          comparisonFields(expectedComparison),
          `${calendarZone}/${scope} snapshot period comparison`,
        );

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

    const snapshot = embeddedSnapshot(renderStaticDashboardHtml({ ...report, asOf }));
    assert.equal(snapshot.__CODEX_USAGE_REPORT__.events.length, report.events.length);

    for (const calendarZone of ["local", "utc"]) {
      const periodOptions = { now: asOf, calendarZone };
      const memoryComparison = summarizePeriodComparison(report.events, periodOptions);
      const indexedComparison = store.periodComparison(periodOptions);
      const snapshotComparison = staticPeriodComparison(snapshot.__CODEX_USAGE_REPORT__, calendarZone);
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
        const snapshotSummary = summarize(snapshot.__CODEX_USAGE_REPORT__);

        if (preset === "all") {
          // 8525 + 160 + 45
          assert.equal(memorySummary.totals.total, 8730, `${calendarZone} all-time total`);
          assert.deepEqual(
            memorySummary.channels
              .map((channel) => [channel.name, channel.total.total])
              .sort((a, b) => a[0].localeCompare(b[0])),
            [
              ["CLI", 45],
              ["DSH", 8525],
              ["DSH Subagent", 160],
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

    const snapshot = embeddedSnapshot(renderStaticDashboardHtml({ ...report, asOf }));
    assert.equal(snapshot.__CODEX_USAGE_REPORT__.events.length, report.events.length);

    for (const calendarZone of ["local", "utc"]) {
      const periodOptions = { now: asOf, calendarZone };
      const memoryComparison = summarizePeriodComparison(report.events, periodOptions);
      const indexedComparison = store.periodComparison(periodOptions);
      const snapshotComparison = staticPeriodComparison(snapshot.__CODEX_USAGE_REPORT__, calendarZone);
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
        const snapshotSummary = summarize(snapshot.__CODEX_USAGE_REPORT__);

        if (preset === "all") {
          // 8310 + 45
          assert.equal(memorySummary.totals.total, 8355, `${calendarZone} all-time total`);
          assert.deepEqual(
            memorySummary.channels
              .map((channel) => [channel.name, channel.total.total])
              .sort((a, b) => a[0].localeCompare(b[0])),
            [
              ["CLI", 45],
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
    const snapshot = embeddedSnapshot(renderStaticDashboardHtml({ ...report, asOf }));
    assert.equal(snapshot.__CODEX_USAGE_REPORT__.events.length, 2);

    for (const calendarZone of ["local", "utc"]) {
      const filters = { preset: "all", bucket: "day", now: asOf, calendarZone };
      const memorySummary = summarizeUsage(report, filters);
      const indexedSummary = store.summarize(filters);
      setSummaryFilters({ ...filters, excludedHomes: [], startDate: "", endDate: "", recentValue: "" });
      const snapshotSummary = summarize(snapshot.__CODEX_USAGE_REPORT__);

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
    const snapshot = embeddedSnapshot(renderStaticDashboardHtml({ ...report, asOf }));
    const filters = { preset: "all", bucket: "day", now: asOf, calendarZone: "utc" };
    const memorySummary = summarizeUsage(report, filters);
    const indexedSummary = store.summarize(filters);
    setSummaryFilters({ ...filters, excludedHomes: [], startDate: "", endDate: "", recentValue: "" });
    const snapshotSummary = summarize(snapshot.__CODEX_USAGE_REPORT__);

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
