import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";

import { STORE_SCHEMA_VERSION, UsageStore } from "../src/usage-store.js";
import { API_PRICING_VERSION } from "../src/pricing.js";
import { buildUsageIndex, buildUsageReport, summarizeUsageIndex } from "../src/usage-core.js";

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

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

function quotaTokenRow(timestamp, resetsAt, { limitId = "codex", windowMinutes = 300, usedPercent = 42.5 } = {}) {
  const row = tokenRow(timestamp, 0, 0, 0, 0, 0);
  row.payload.rate_limits = {
    limit_id: limitId,
    primary: {
      window_minutes: windowMinutes,
      resets_at: Date.parse(resetsAt) / 1000,
      used_percent: usedPercent,
    },
  };
  return row;
}

async function makeStoreFixture() {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-usage-store-"));
  const sessionDir = path.join(homeDir, ".codex", "sessions", "2026", "07", "12");
  const sessionFile = path.join(sessionDir, "rollout.jsonl");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    sessionFile,
    jsonl([
      {
        timestamp: "2026-07-12T01:00:00.000Z",
        type: "session_meta",
        payload: { id: "store-session", source: "cli", originator: "codex-tui", cwd: "/work/store" },
      },
      { type: "turn_context", payload: { model: "gpt-6-sol" } },
      tokenRow("2026-07-12T01:01:00.000Z", 123, 100, 20, 23, 5),
    ]),
  );
  return {
    homeDir,
    sessionFile,
    databaseFile: path.join(homeDir, ".codex-usage", "usage-index.sqlite"),
  };
}

test("UsageStore 首次同步并只重建变化文件", async () => {
  const { homeDir, sessionFile, databaseFile } = await makeStoreFixture();
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    const first = await store.sync();
    const firstMetadata = store.metadata();
    const firstSummary = store.summarize({ preset: "all", bucket: "day" });

    assert.equal(first.updatedFileCount, 1);
    assert.equal(firstMetadata.eventCount, 1);
    assert.equal(firstMetadata.sessionCount, 1);
    assert.equal(firstSummary.totals.total, 123);
    assert.ok(Math.abs(firstSummary.costEstimate.totalUsd - 0.000394) < 1e-12);
    assert.equal(firstSummary.costEstimate.modelCount, 1);

    await appendFile(sessionFile, `${JSON.stringify(tokenRow("2026-07-12T01:02:00.000Z", 200, 160, 30, 40, 7))}\n`);

    const refreshed = await store.sync();
    const refreshedSummary = store.summarize({ preset: "all", bucket: "day" });
    const unchanged = await store.sync();

    assert.equal(refreshed.updatedFileCount, 1);
    assert.equal(refreshedSummary.eventCount, 2);
    assert.equal(refreshedSummary.totals.total, 200);
    assert.ok(Math.abs(refreshedSummary.costEstimate.totalUsd - 0.000666) < 1e-12);
    assert.equal(unchanged.updatedFileCount, 0);
  } finally {
    store.close();
  }
});

test("inherited rollout counters do not inflate gpt-6-sol usage or cost", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-inherited-usage-"));
  const codexHome = path.join(homeDir, ".codex");
  const sessionDir = path.join(codexHome, "sessions", "2026", "09", "26");
  const databaseFile = path.join(homeDir, "usage-index.sqlite");
  const store = new UsageStore({ homeDir, databaseFile });
  try {
    await mkdir(sessionDir, { recursive: true });
    const first = tokenRow("2026-09-26T15:44:48.880Z", 38_745_826, 38_577_419, 37_199_360, 168_407, 58_944);
    first.payload.info.last_token_usage = {
      total_tokens: 141_769,
      input_tokens: 141_470,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 299,
      reasoning_output_tokens: 102,
    };
    const second = tokenRow("2026-09-26T15:45:06.867Z", 38_891_734, 38_722_820, 37_340_672, 168_914, 59_244);
    second.payload.info.last_token_usage = {
      total_tokens: 145_908,
      input_tokens: 145_401,
      cached_input_tokens: 141_312,
      cache_write_input_tokens: 0,
      output_tokens: 507,
      reasoning_output_tokens: 300,
    };
    const meta = {
      timestamp: "2026-09-26T15:38:34.000Z",
      type: "session_meta",
      payload: { id: "inherited", source: "cli", originator: "codex-tui", cwd: homeDir },
    };
    const context = { type: "turn_context", payload: { model: "gpt-6-sol" } };
    await writeFile(path.join(sessionDir, "rollout-inherited-a.jsonl"), jsonl([meta, context, first]));
    await writeFile(path.join(sessionDir, "rollout-inherited-b.jsonl"), jsonl([meta, context, second]));

    const report = await buildUsageReport({ homes: [{ id: "main", label: "Codex", path: codexHome, kind: "main" }] });
    assert.deepEqual(
      report.events.map((event) => event.total.total),
      [141_769, 145_908],
    );
    assert.deepEqual(
      report.sessions.map((session) => session.total.total),
      [141_769, 145_908],
    );
    assert.deepEqual(
      report.events.map((event) => event.contextLevel),
      ["short", "short"],
    );

    await store.sync();
    const summary = store.summarize({ preset: "all", bucket: "day" });
    assert.equal(summary.totals.total, 287_677);
    assert.ok(summary.costEstimate.totalUsd > 0 && summary.costEstimate.totalUsd < 1);

    store.close();
    const legacy = new DatabaseSync(databaseFile);
    legacy.exec("PRAGMA user_version = 7; UPDATE events SET total = total + 38000000 WHERE total = 141769");
    legacy.close();
    const migrated = new UsageStore({ homeDir, databaseFile });
    try {
      const result = await migrated.sync();
      assert.equal(result.updatedFileCount, 2);
      assert.equal(migrated.summarize({ preset: "all", bucket: "day" }).totals.total, 287_677);
    } finally {
      migrated.close();
    }
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("UsageStore 将非 Git 仓库比较项按工作目录归组", async () => {
  const { homeDir, databaseFile } = await makeStoreFixture();
  const sessionIndexPath = path.join(homeDir, ".codex", "session_index.jsonl");
  await writeFile(sessionIndexPath, jsonl([{ id: "store-session", thread_name: "修复用量表格" }]));
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    await store.sync();
    const comparison = store.periodComparison({ now: "2026-07-12T12:00:00.000Z" });
    const directory = comparison.repositories.find((row) => row.key === "directory:/work/store");
    const selectedRangeRepository = store.summarize({ preset: "all", bucket: "day" }).repositories[0];

    assert.equal(directory.name, "/work/store");
    assert.equal(directory.kind, "directory");
    assert.equal(comparison.repositories.length, 1);
    assert.deepEqual(selectedRangeRepository.sessionIds, ["store-session"]);
  } finally {
    store.close();
  }
});

test("UsageStore 汇总结果与内存索引保持一致", async () => {
  const { homeDir, databaseFile } = await makeStoreFixture();
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    await store.sync();
    const index = await buildUsageIndex({ homeDir });
    const filtersList = [
      { preset: "all", bucket: "day", now: "2026-09-25T12:00:00.000Z" },
      { preset: "today", bucket: "hour", now: "2026-09-25T12:00:00.000Z" },
    ];

    for (const filters of filtersList) {
      const actual = store.summarize(filters);
      const expected = summarizeUsageIndex(index, filters);
      // records（New Record）是磁盘索引侧的新特性，内存索引不产出该字段。
      const { records: _records, ...actualRest } = actual;
      assert.deepEqual({ ...actualRest, generatedAt: "" }, { ...expected, generatedAt: "" });
    }
  } finally {
    store.close();
  }
});

test("New Record 点亮所选范围内的纪录期指标", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-usage-records-"));
  const sessionDir = path.join(homeDir, ".codex", "sessions", "2026", "07");
  await mkdir(sessionDir, { recursive: true });
  // 三天数据：7-10 共 300、7-11 共 100、7-12 共 500（严格新高）。
  for (const [day, total, name] of [
    ["10", 300, "a"],
    ["11", 100, "b"],
    ["12", 500, "c"],
  ]) {
    await writeFile(
      path.join(sessionDir, `rollout-${name}.jsonl`),
      jsonl([
        {
          timestamp: `2026-07-${day}T01:00:00.000Z`,
          type: "session_meta",
          payload: { id: `record-${name}`, source: "cli", originator: "codex-tui", cwd: "/work/records" },
        },
        { type: "turn_context", payload: { model: "gpt-6-sol" } },
        tokenRow(`2026-07-${day}T01:01:00.000Z`, total, total - 10, 5, 10, 0),
      ]),
    );
  }
  const store = new UsageStore({ homeDir, databaseFile: path.join(homeDir, "usage-index.sqlite") });

  try {
    await store.sync();
    const recordRange = store.summarize({
      preset: "custom",
      startDate: "2026-07-12",
      endDate: "2026-07-12",
      bucket: "day",
    });
    assert.equal(recordRange.records.totalTokens.title, "总 tokens 最高的一日");
    assert.equal(recordRange.records.totalTokens.period, "2026-07-12");
    assert.equal(recordRange.records.totalCost.title, "估算花销最高的一日");
    // 三天会话数并列（1:1:1），不构成严格新高，不点亮。
    assert.equal(recordRange.records.sessionCount, undefined);

    // 纪录期不在所选范围内时不应点亮。
    const earlierRange = store.summarize({
      preset: "custom",
      startDate: "2026-07-10",
      endDate: "2026-07-10",
      bucket: "day",
    });
    assert.equal(earlierRange.records.totalTokens, undefined);

    // All Time 包含历史纪录期，但不属于创纪录的比较范围，也不需要扫描纪录。
    store.recordsForRange = () => {
      throw new Error("All Time must skip record scans");
    };
    const allTime = store.summarize({ preset: "all", bucket: "day" });
    assert.deepEqual(allTime.records, {});
    assert.equal(allTime.totals.total, 900);
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("UsageStore reindexes a file when its source identity changes", async () => {
  const { homeDir, databaseFile } = await makeStoreFixture();
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    await store.sync();
    store.database.prepare("UPDATE source_files SET home_id = ?").run("legacy-order-based-id");

    const result = await store.sync();
    const source = store.database.prepare("SELECT home_id FROM source_files").get();
    const activeHome = store.homes.find((home) => home.kind === "main");

    assert.equal(result.updatedFileCount, 1);
    assert.equal(source.home_id, activeHome.id);
    assert.equal(store.metadata().eventCount, 1);
  } finally {
    store.close();
  }
});

test("UsageStore preserves indexed data when a source scan fails", async () => {
  const { homeDir, databaseFile } = await makeStoreFixture();
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    await store.sync();
    store.usageFiles = async (homes) => ({
      files: [],
      warnings: ["simulated source scan failure"],
      failedHomes: homes.map(({ id, path }) => ({ id, path })),
    });

    const result = await store.sync();

    assert.equal(result.updatedFileCount, 0);
    assert.equal(store.metadata().eventCount, 1);
    assert.match(store.warnings[0], /simulated source scan failure/);
  } finally {
    store.close();
  }
});

test("UsageStore upgrades schema v2 and reindexes old source files with unknown billing fields", async () => {
  const { homeDir, databaseFile } = await makeStoreFixture();
  const initial = new UsageStore({ homeDir, databaseFile });
  await initial.sync();
  initial.close();

  const database = new DatabaseSync(databaseFile);
  database.exec("PRAGMA user_version = 2");
  for (const column of [
    "price_version",
    "service_tier",
    "context_level",
    "request_input_tokens",
    "cache_write_known",
    "cache_write_tokens",
  ]) {
    database.exec(`ALTER TABLE events DROP COLUMN ${column}`);
  }
  database.close();

  const migrated = new UsageStore({ homeDir, databaseFile });
  try {
    const result = await migrated.sync();
    const event = migrated.database
      .prepare("SELECT cache_write_known, context_level, service_tier, price_version FROM events")
      .get();
    assert.equal(result.updatedFileCount, 1);
    assert.equal(Number(migrated.database.prepare("PRAGMA user_version").get().user_version), STORE_SCHEMA_VERSION);
    assert.equal(event.cache_write_known, 0);
    assert.equal(event.context_level, "unknown");
    assert.equal(event.service_tier, "unknown");
    assert.equal(event.price_version, API_PRICING_VERSION);
  } finally {
    migrated.close();
  }
});

test("UsageStore 按来源排除过滤统计与对比", async () => {
  const { homeDir, databaseFile } = await makeStoreFixture();
  const projectRoot = path.join(homeDir, "log-project");
  await mkdir(path.join(projectRoot, ".codex-usage"), { recursive: true });
  await writeFile(
    path.join(projectRoot, ".codex-usage", "usage.jsonl"),
    jsonl([
      {
        schema_version: "codex-usage.project-log.v1",
        timestamp: "2026-07-12T02:00:00.000Z",
        source: "test",
        channel: "Test",
        project_root: "/work/log",
        cwd: "/work/log",
        session_id: "log-session",
        model: "gpt-6-luna",
        usage: { total: 70, input: 50, cached: 10, output: 20, reasoning: 2 },
      },
    ]),
  );
  const store = new UsageStore({ homeDir, databaseFile, importDirs: [projectRoot] });

  try {
    await store.sync();
    const projectHome = store.metadata().homes.find((home) => home.kind === "project-log");
    assert.ok(projectHome);

    const all = store.summarize({ preset: "all", bucket: "day" });
    assert.equal(all.totals.total, 193);
    assert.equal(all.homes.length, 2);

    const filtered = store.summarize({ preset: "all", bucket: "day", excludeHomes: [projectHome.id] });
    assert.equal(filtered.totals.total, 123);
    assert.deepEqual(
      filtered.homes.map((home) => home.name),
      ["Main Codex"],
    );
    assert.deepEqual(
      filtered.models.map((model) => model.name),
      ["gpt-6-sol"],
    );

    const comparison = store.periodComparison({ now: "2026-07-12T12:00:00.000Z", excludeHomes: [projectHome.id] });
    assert.deepEqual(
      comparison.models.map((model) => model.key),
      ["gpt-6-sol"],
    );
  } finally {
    store.close();
  }
});

test("previous quota cost records compare earlier reset windows and honor source exclusions", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "usage-quota-record-"));
  const sessionsDir = path.join(homeDir, ".codex", "sessions");
  await mkdir(sessionsDir, { recursive: true });
  for (const [day, tokens] of [
    [24, 100],
    [25, 200],
    [26, 500],
  ]) {
    const stamp = `2026-09-${day}T10:00:00Z`;
    await writeFile(
      path.join(sessionsDir, `${day}.jsonl`),
      jsonl([
        { type: "session_meta", timestamp: stamp, payload: { id: `s-${day}` } },
        { type: "turn_context", timestamp: stamp, payload: { model: "gpt-6-sol" } },
        quotaTokenRow(stamp, `2026-09-${day}T14:00:00Z`),
        tokenRow(stamp, tokens, tokens, 0, 0, 0),
      ]),
    );
  }
  const store = new UsageStore({ homeDir, databaseFile: path.join(homeDir, "index.sqlite") });
  try {
    await store.sync();
    const filters = { preset: "recent", recentValue: "上一个5h", now: "2026-09-26T12:00:00Z" };
    const result = store.summarize(filters);
    assert.equal(result.totals.total, 200);
    assert.equal(result.records.totalCost.unit, "5-hour window");
    assert.equal(result.records.totalTokens.value, 200);
    assert.match(result.records.totalCost.title, /估算花销/);
    assert.deepEqual(store.summarize({ ...filters, excludeHomes: store.homes.map((home) => home.id) }).records, {});
    assert.deepEqual(store.summarize({ preset: "all", now: filters.now }).records, {});
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("UsageStore 限额窗口只统计 Codex 来源，普通范围不受影响", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "usage-quota-codex-only-"));
  const sessionsDir = path.join(homeDir, ".codex", "sessions", "2026", "09", "25");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    path.join(sessionsDir, "codex.jsonl"),
    jsonl([
      {
        type: "session_meta",
        timestamp: "2026-09-25T11:00:00.000Z",
        payload: { id: "codex-session", source: "cli", originator: "codex-tui", cwd: "/work/codex" },
      },
      { type: "turn_context", timestamp: "2026-09-25T11:00:00.000Z", payload: { model: "gpt-6-sol" } },
      quotaTokenRow("2026-09-25T11:59:00.000Z", "2026-09-25T14:37:00.000Z"),
      tokenRow("2026-09-25T11:30:00.000Z", 100, 80, 10, 20, 0),
    ]),
  );
  // 项目日志（project-log）来源在同一个限额窗口内贡献用量：它不能进入限额统计。
  const projectRoot = path.join(homeDir, "log-project");
  await mkdir(path.join(projectRoot, ".codex-usage"), { recursive: true });
  await writeFile(
    path.join(projectRoot, ".codex-usage", "usage.jsonl"),
    jsonl([
      {
        schema_version: "codex-usage.project-log.v1",
        timestamp: "2026-09-25T11:45:00.000Z",
        source: "test",
        channel: "Test",
        project_root: "/work/log",
        cwd: "/work/log",
        session_id: "log-session",
        model: "gpt-6-luna",
        usage: { total: 70, input: 50, cached: 10, output: 20, reasoning: 2 },
      },
    ]),
  );
  const store = new UsageStore({
    homeDir,
    databaseFile: path.join(homeDir, "index.sqlite"),
    importDirs: [projectRoot],
  });

  try {
    await store.sync();
    const filters = { preset: "quota_5h", now: "2026-09-25T12:00:00.000Z" };
    const quotaSummary = store.summarize(filters);
    assert.equal(quotaSummary.range.quotaWindow, true);
    // 11:45Z 的项目日志事件在窗口内，但限额窗口只衡量 Codex 用量。
    assert.equal(quotaSummary.totals.total, 100);
    assert.deepEqual(
      quotaSummary.channels.map((channel) => channel.name),
      ["CLI"],
    );

    const all = store.summarize({ preset: "all", bucket: "day", now: filters.now });
    assert.equal(all.totals.total, 170);
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("UsageStore indexes quota observations from zero-token files and uses the half-open event range", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-usage-quota-store-"));
  const sessionsDir = path.join(homeDir, ".codex", "sessions", "2026", "09", "25");
  const databaseFile = path.join(homeDir, ".codex-usage", "usage-index.sqlite");
  const quotaFile = path.join(sessionsDir, "quota.jsonl");
  const startFile = path.join(sessionsDir, "start.jsonl");
  const asOfFile = path.join(sessionsDir, "as-of.jsonl");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    quotaFile,
    jsonl([
      { type: "session_meta", timestamp: "2026-09-25T11:00:00.000Z", payload: { id: "quota-observation" } },
      quotaTokenRow("2026-09-25T11:59:00.000Z", "2026-09-25T14:37:00.000Z"),
    ]),
  );
  await writeFile(
    startFile,
    jsonl([
      { type: "session_meta", timestamp: "2026-09-25T09:37:00.000Z", payload: { id: "at-start" } },
      tokenRow("2026-09-25T09:37:00.000Z", 50, 40, 5, 10, 0),
    ]),
  );
  await writeFile(
    asOfFile,
    jsonl([
      { type: "session_meta", timestamp: "2026-09-25T12:00:00.000Z", payload: { id: "at-as-of" } },
      tokenRow("2026-09-25T12:00:00.000Z", 100, 80, 10, 20, 0),
    ]),
  );
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    await store.sync();
    store.recordsForRange = () => {
      throw new Error("quota summaries must skip New Record history scans");
    };
    const indexedSnapshots = store.database
      .prepare(
        "SELECT line_number, role, limit_id, window_minutes, used_percent FROM rate_limit_observations WHERE source_path = ?",
      )
      .all(quotaFile);
    const summary = store.summarize({ preset: "quota_5h", bucket: "month", now: "2026-09-25T12:00:00.000Z" });
    const quotaLookupPlan = store.database
      .prepare(`
      EXPLAIN QUERY PLAN SELECT source_path, line_number, role, observed_at_ms, limit_id,
        limit_name, plan_type, window_minutes, resets_at_ms, used_percent
      FROM rate_limit_observations INDEXED BY rate_limit_window_lookup_idx
      ORDER BY limit_id ASC, window_minutes ASC, observed_at_ms DESC
    `)
      .all();
    const eventRangePlan = store.database
      .prepare(`
      EXPLAIN QUERY PLAN SELECT COUNT(*) FROM events WHERE timestamp_ms >= ? AND timestamp_ms <= ?
    `)
      .all(Date.parse(summary.range.start), Date.parse(summary.range.end));
    const excluded = store.summarize({
      preset: "quota_5h",
      now: "2026-09-25T12:00:00.000Z",
      excludeHomes: [store.homes[0].id],
    });

    assert.equal(indexedSnapshots.length, 1);
    assert.equal(Number(indexedSnapshots[0].line_number), 2);
    assert.equal(indexedSnapshots[0].role, "primary");
    assert.equal(indexedSnapshots[0].limit_id, "codex");
    assert.equal(summary.range.bucket, "quota_30m");
    assert.equal(summary.range.quotaState, "available");
    assert.equal(summary.range.quotaReason, null);
    assert.ok(quotaLookupPlan.some((row) => row.detail.includes("rate_limit_window_lookup_idx")));
    assert.ok(eventRangePlan.some((row) => row.detail.includes("events_timestamp_idx")));
    assert.equal(summary.range.windowStart, "2026-09-25T09:37:00.000Z");
    assert.equal(summary.quota.windows.quota_week.state, "missing");
    assert.equal(summary.totals.total, 50);
    assert.equal(summary.eventCount, 1);
    assert.equal(summary.timeline.length, 10);
    assert.equal(summary.timeline[0].total.total, 50);
    assert.equal(
      summary.timeline.reduce((sum, slot) => sum + slot.total.total, 0),
      summary.totals.total,
    );
    assert.ok(summary.timeline.slice(5).every((slot) => slot.future));
    assert.equal(summary.comparison, null);
    assert.deepEqual(summary.records, {});
    assert.equal(excluded.quota.windows.quota_5h.state, "available");
    assert.equal(excluded.totals.total, 0);
    assert.equal(
      Number(store.database.prepare("SELECT COUNT(*) AS count FROM events WHERE source_path = ?").get(quotaFile).count),
      0,
    );

    await store.sync();
    assert.equal(
      Number(
        store.database
          .prepare("SELECT COUNT(*) AS count FROM rate_limit_observations WHERE source_path = ?")
          .get(quotaFile).count,
      ),
      1,
    );
    await writeFile(
      quotaFile,
      `${jsonl([
        { type: "session_meta", timestamp: "2026-09-25T11:00:00.000Z", payload: { id: "quota-observation" } },
        quotaTokenRow("2026-09-25T12:01:00.000Z", "2026-09-25T14:38:00.000Z"),
      ])}\n`,
    );
    await store.sync();
    const replaced = store.database
      .prepare(
        "SELECT COUNT(*) AS count, MAX(resets_at_ms) AS reset FROM rate_limit_observations WHERE source_path = ?",
      )
      .get(quotaFile);
    assert.equal(Number(replaced.count), 1);
    assert.equal(Number(replaced.reset), Date.parse("2026-09-25T14:38:00.000Z"));
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("UsageStore v5 migration marks only Codex JSONL for retryable automatic reindex", async () => {
  const { homeDir, sessionFile, databaseFile } = await makeStoreFixture();
  const quotaFile = path.join(path.dirname(sessionFile), "quota.jsonl");
  await writeFile(
    quotaFile,
    jsonl([
      { type: "session_meta", timestamp: "2026-07-12T01:00:00.000Z", payload: { id: "migration-quota" } },
      quotaTokenRow("2026-07-12T01:02:00.000Z", "2026-07-12T06:02:00.000Z"),
    ]),
  );
  const initial = new UsageStore({ homeDir, databaseFile });
  await initial.sync();
  initial.close();

  const legacy = new DatabaseSync(databaseFile);
  legacy.exec("PRAGMA user_version = 5; DROP TABLE rate_limit_observations;");
  for (const [pathName, kind, homeId] of [
    ["zcode.jsonl", "zcode", "zcode-home"],
    ["project-log.jsonl", "project-log", "project-home"],
  ]) {
    legacy
      .prepare(`
      INSERT INTO source_files (path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?, 123, 456, ?)
    `)
      .run(pathName, kind, homeId, homeId, path.dirname(pathName), new Date().toISOString());
  }
  legacy.close();

  const migrated = new UsageStore({ homeDir, databaseFile });
  try {
    await migrated.open();
    const sourceState = (filePath) =>
      migrated.database.prepare("SELECT size, mtime_ms FROM source_files WHERE path = ?").get(filePath);
    assert.equal(Number(sourceState(sessionFile).size), -1);
    assert.equal(Number(sourceState(sessionFile).mtime_ms), -1);
    assert.equal(Number(sourceState("zcode.jsonl").size), 123);
    assert.equal(Number(sourceState("zcode.jsonl").mtime_ms), 456);
    assert.equal(Number(sourceState("project-log.jsonl").size), 123);
    assert.equal(Number(sourceState("project-log.jsonl").mtime_ms), 456);

    const replaceFile = migrated.replaceFile.bind(migrated);
    migrated.replaceFile = async () => {
      throw new Error("simulated reindex failure");
    };
    const failed = await migrated.sync();
    assert.equal(failed.updatedFileCount, 0);
    assert.equal(Number(sourceState(sessionFile).size), -1);
    assert.match(migrated.warnings.join(" "), /simulated reindex failure/);

    migrated.replaceFile = replaceFile;
    const retried = await migrated.sync();
    assert.equal(retried.updatedFileCount, 2);
    assert.equal(
      Number(migrated.database.prepare("SELECT COUNT(*) AS count FROM rate_limit_observations").get().count),
      1,
    );
    assert.equal(Number(migrated.database.prepare("PRAGMA user_version").get().user_version), STORE_SCHEMA_VERSION);
  } finally {
    migrated.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- DSH 数据源

/** 造一个同时含 Codex 与 DSH 的 homeDir，DSH 用量用真实样本数字。 */
async function makeDshStoreFixture() {
  const { homeDir, sessionFile } = await makeStoreFixture();
  const dshSessionDir = path.join(homeDir, ".dsh", "sessions", "--work-dshproj--", "session-dsh-1");
  await mkdir(dshSessionDir, { recursive: true });
  const dshFile = path.join(dshSessionDir, "session.v4.jsonl.zstd");

  const frames = [
    [
      {
        type: "session",
        version: 4,
        id: "session-dsh-1",
        createdAt: Date.parse("2026-07-12T02:00:00.000Z"),
        cwd: "/work/dshproj",
        isSeeded: false,
        delegationDepth: 0,
        agentPreset: "standard",
      },
    ],
    [
      {
        type: "request/header",
        seq: 2,
        time: Date.parse("2026-07-12T02:00:01.000Z"),
        data: { header: { config: { provider: "deepseek-account", model: "deepseek-flash" } } },
      },
      {
        type: "assistant/message",
        seq: 3,
        time: Date.parse("2026-07-12T02:01:00.000Z"),
        data: {
          turn: 1,
          step: 1,
          usage: {
            inputTokens: 1614,
            outputTokens: 127,
            cacheReadTokens: 6784,
            cacheWriteTokens: 0,
            totalTokens: 8525,
          },
        },
      },
    ],
  ];
  await writeFile(
    dshFile,
    Buffer.concat(
      frames.map((rows) =>
        zstdCompressSync(Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8")),
      ),
    ),
  );

  return { homeDir, sessionFile, dshFile, databaseFile: path.join(homeDir, ".codex-usage", "usage-index.sqlite") };
}

test("DSH 事件不进 Codex 限额窗口聚合", async () => {
  const { homeDir, sessionFile, databaseFile } = await makeDshStoreFixture();
  // 补一条 Codex 限额观察值，否则限额范围会因「没有可用窗口」拿不到窗口，
  // 断言就永远跑不到（会假绿）。窗口取 [01:00, 06:00)，把 Codex 用量事件
  // （01:01）和测试用的 now（02:00）都包在里面。
  await appendFile(sessionFile, jsonl([quotaTokenRow("2026-07-12T01:00:00.000Z", "2026-07-12T06:00:00.000Z")]));
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    await store.sync();
    const metadata = store.metadata();
    const dshHome = metadata.homes.find((home) => home.kind === "dsh");

    // 限额窗口只衡量 Codex 用量，DSH home 必须被排除在外。
    assert.ok(store.nonCodexHomeIds().includes(dshHome.id));

    // now 必须显式给定：限额窗口取「已结束的窗口」，默认用真实当前时间会
    // 与 fixture 的 2026-07-12 观察值对不上，从而拿不到窗口。
    const quota = store.summarize({ preset: "quota_5h", bucket: "quota_30m", now: "2026-07-12T02:00:00.000Z" });
    assert.ok(quota.channels.length > 0, "限额窗口应至少有 Codex 渠道");
    assert.ok(!quota.channels.some((channel) => channel.name.startsWith("DSH")), "限额窗口里不应出现 DSH 渠道");
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("UsageStore 索引 DSH 会话日志并只在变化后重建", async () => {
  const { homeDir, dshFile, databaseFile } = await makeDshStoreFixture();
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    const first = await store.sync();
    assert.equal(first.updatedFileCount, 2, "Codex 与 DSH 各一个文件");

    const summary = store.summarize({ preset: "all", bucket: "day" });
    const dsh = summary.channels.find((channel) => channel.name === "DSH");
    assert.ok(dsh, "摘要里应出现 DSH 渠道");
    // 未命中 8398 = 1614 + 6784，命中 6784。
    assert.deepEqual(dsh.total, { total: 8525, input: 8398, cached: 6784, output: 127, reasoning: 0 });

    // DSH 的用量按会话目录归组仓库。
    const repository = summary.repositories.find((row) => row.key === "directory:/work/dshproj");
    assert.ok(repository, "DSH 会话应归到 cwd 对应的仓库");
    assert.equal(repository.total.total, 8525);

    // 文件未变化时不应重建。
    const second = await store.sync();
    assert.equal(second.updatedFileCount, 0);

    // 追加新帧后应重建，且不产生重复事件。
    const appended = zstdCompressSync(
      Buffer.from(
        `${JSON.stringify({
          type: "assistant/message",
          seq: 4,
          time: Date.parse("2026-07-12T02:02:00.000Z"),
          data: {
            turn: 1,
            step: 2,
            usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 },
          },
        })}\n`,
        "utf8",
      ),
    );
    await appendFile(dshFile, appended);
    const third = await store.sync();
    assert.equal(third.updatedFileCount, 1, "只有 DSH 文件变化");

    const after = store.summarize({ preset: "all", bucket: "day" });
    const dshAfter = after.channels.find((channel) => channel.name === "DSH");
    assert.deepEqual(dshAfter.total, { total: 8540, input: 8408, cached: 6784, output: 132, reasoning: 0 });
    assert.equal(
      Number(store.database.prepare("SELECT COUNT(*) AS count FROM events WHERE home_id LIKE 'dsh%'").get().count),
      2,
      "重解析后不应残留重复事件",
    );
  } finally {
    store.close();
  }
});

test("UsageStore metadata 把 DSH 用量归入 harnessModels.DSH", async () => {
  const { homeDir, databaseFile } = await makeDshStoreFixture();
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    await store.sync();
    const metadata = store.metadata();
    assert.deepEqual(metadata.harnessModels.DSH, ["deepseek-flash"]);
    // Codex 的模型不能被算进 DSH。
    assert.ok(!metadata.harnessModels.DSH.includes("gpt-6-sol"));
    assert.ok(metadata.harnessModels.Codex.includes("gpt-6-sol"));

    const dshHome = metadata.homes.find((home) => home.kind === "dsh");
    assert.equal(dshHome.status, "active");
    assert.equal(dshHome.eventCount, 1);
    assert.equal(dshHome.sessionCount, 1);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------- OpenCode 数据源

/** 造一个同时含 Codex 与 OpenCode 的 homeDir。 */
async function makeOpencodeStoreFixture() {
  const { homeDir, sessionFile } = await makeStoreFixture();
  const dataDir = path.join(homeDir, ".local", "share", "opencode");
  await mkdir(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, "opencode.db");
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, version TEXT, agent TEXT, model TEXT);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    db.prepare("INSERT INTO session_v2 (id, directory, title, version, agent, model) VALUES (?, ?, ?, ?, ?, ?)").run(
      "session-oc-1",
      "/work/ocproj",
      "oc title",
      "2.0.19",
      "build",
      null,
    );
    db.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "msg-oc-1",
      "session-oc-1",
      "assistant",
      0,
      Date.parse("2026-07-12T02:01:00.000Z"),
      Date.parse("2026-07-12T02:01:00.000Z"),
      JSON.stringify({
        time: { created: Date.parse("2026-07-12T02:01:00.000Z"), completed: Date.parse("2026-07-12T02:01:01.000Z") },
        model: { id: "test-model", providerID: "opencode" },
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 0 } },
      }),
    );
  } finally {
    db.close();
  }

  return { homeDir, sessionFile, dbFile, databaseFile: path.join(homeDir, ".codex-usage", "usage-index.sqlite") };
}

function appendOpencodeMessage(
  dbFile,
  { sessionId = "session-oc-1", seq = 1, time = "2026-07-12T02:02:00.000Z" } = {},
) {
  const db = new DatabaseSync(dbFile);
  try {
    db.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      `msg-oc-${seq + 1}`,
      sessionId,
      "assistant",
      seq,
      Date.parse(time),
      Date.parse(time),
      JSON.stringify({
        time: { created: Date.parse(time), completed: Date.parse(time) + 1000 },
        model: { id: "test-model", providerID: "opencode" },
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
  } finally {
    db.close();
  }
}

test("OpenCode 事件不进 Codex 限额窗口聚合", async () => {
  const { homeDir, sessionFile, databaseFile } = await makeOpencodeStoreFixture();
  await appendFile(sessionFile, jsonl([quotaTokenRow("2026-07-12T01:00:00.000Z", "2026-07-12T06:00:00.000Z")]));
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    await store.sync();
    const metadata = store.metadata();
    const opencodeHome = metadata.homes.find((home) => home.kind === "opencode");

    assert.ok(opencodeHome, "应发现 OpenCode 来源");
    assert.ok(store.nonCodexHomeIds().includes(opencodeHome.id));

    const quota = store.summarize({ preset: "quota_5h", bucket: "quota_30m", now: "2026-07-12T02:00:00.000Z" });
    assert.ok(quota.channels.length > 0, "限额窗口应至少有 Codex 渠道");
    assert.ok(
      !quota.channels.some((channel) => channel.name.startsWith("OpenCode")),
      "限额窗口里不应出现 OpenCode 渠道",
    );
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("UsageStore 索引 OpenCode 数据库并只在变化后重建", async () => {
  const { homeDir, dbFile, databaseFile } = await makeOpencodeStoreFixture();
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    const first = await store.sync();
    assert.equal(first.updatedFileCount, 2, "Codex 与 OpenCode 各一个文件");

    const summary = store.summarize({ preset: "all", bucket: "day" });
    const opencode = summary.channels.find((channel) => channel.name === "OpenCode");
    assert.ok(opencode, "摘要里应出现 OpenCode 渠道");
    assert.deepEqual(opencode.total, { total: 135, input: 110, cached: 10, output: 25, reasoning: 5 });

    const repository = summary.repositories.find((row) => row.key === "directory:/work/ocproj");
    assert.ok(repository, "OpenCode 会话应归到 cwd 对应的仓库");
    assert.equal(repository.total.total, 135);

    const second = await store.sync();
    assert.equal(second.updatedFileCount, 0, "文件未变化时不应重建");

    appendOpencodeMessage(dbFile);
    const third = await store.sync();
    assert.equal(third.updatedFileCount, 1, "只有 OpenCode 数据库变化");

    const after = store.summarize({ preset: "all", bucket: "day" });
    const opencodeAfter = after.channels.find((channel) => channel.name === "OpenCode");
    assert.deepEqual(opencodeAfter.total, { total: 150, input: 120, cached: 10, output: 30, reasoning: 5 });
    assert.equal(
      Number(store.database.prepare("SELECT COUNT(*) AS count FROM events WHERE home_id LIKE 'opencode%'").get().count),
      2,
      "重解析后不应残留重复事件",
    );
  } finally {
    store.close();
  }
});

test("UsageStore metadata 把 OpenCode 用量归入 harnessModels.OpenCode", async () => {
  const { homeDir, databaseFile } = await makeOpencodeStoreFixture();
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    await store.sync();
    const metadata = store.metadata();
    assert.deepEqual(metadata.harnessModels.OpenCode, ["test-model"]);
    assert.ok(!metadata.harnessModels.OpenCode.includes("gpt-6-sol"));
    assert.ok(metadata.harnessModels.Codex.includes("gpt-6-sol"));

    const opencodeHome = metadata.homes.find((home) => home.kind === "opencode");
    assert.equal(opencodeHome.status, "active");
    assert.equal(opencodeHome.eventCount, 1);
    assert.equal(opencodeHome.sessionCount, 1);
  } finally {
    store.close();
  }
});
