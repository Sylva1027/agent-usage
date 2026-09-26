import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { UsageStore } from "../src/usage-store.js";
import { API_PRICING_VERSION } from "../src/pricing.js";
import { buildUsageIndex, summarizeUsageIndex } from "../src/usage-core.js";

function jsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
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

    await appendFile(sessionFile, JSON.stringify(tokenRow("2026-07-12T01:02:00.000Z", 200, 160, 30, 40, 7)) + "\n");

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
  for (const [day, total, name] of [["10", 300, "a"], ["11", 100, "b"], ["12", 500, "c"]]) {
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
    const recordRange = store.summarize({ preset: "custom", startDate: "2026-07-12", endDate: "2026-07-12", bucket: "day" });
    assert.equal(recordRange.records.totalTokens.title, "总 tokens 最高的一日");
    assert.equal(recordRange.records.totalTokens.period, "2026-07-12");
    assert.equal(recordRange.records.totalCost.title, "总花销最高的一日");
    // 三天会话数并列（1:1:1），不构成严格新高，不点亮。
    assert.equal(recordRange.records.sessionCount, undefined);

    // 纪录期不在所选范围内时不应点亮。
    const earlierRange = store.summarize({ preset: "custom", startDate: "2026-07-10", endDate: "2026-07-10", bucket: "day" });
    assert.equal(earlierRange.records.totalTokens, undefined);

    // All Time 包含历史纪录期，但不属于创纪录的比较范围，也不需要扫描纪录。
    store.recordsForRange = () => { throw new Error("All Time must skip record scans"); };
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
    "price_version", "service_tier", "context_level", "request_input_tokens", "cache_write_known", "cache_write_tokens",
  ]) {
    database.exec(`ALTER TABLE events DROP COLUMN ${column}`);
  }
  database.close();

  const migrated = new UsageStore({ homeDir, databaseFile });
  try {
    const result = await migrated.sync();
    const event = migrated.database.prepare(
      "SELECT cache_write_known, context_level, service_tier, price_version FROM events",
    ).get();
    assert.equal(result.updatedFileCount, 1);
    assert.equal(Number(migrated.database.prepare("PRAGMA user_version").get().user_version), 7);
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
    jsonl([{
      schema_version: "codex-usage.project-log.v1",
      timestamp: "2026-07-12T02:00:00.000Z",
      source: "test",
      channel: "Test",
      project_root: "/work/log",
      cwd: "/work/log",
      session_id: "log-session",
      model: "gpt-6-luna",
      usage: { total: 70, input: 50, cached: 10, output: 20, reasoning: 2 },
    }]),
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
    assert.deepEqual(filtered.homes.map((home) => home.name), ["Main Codex"]);
    assert.deepEqual(filtered.models.map((model) => model.name), ["gpt-6-sol"]);

    const comparison = store.periodComparison({ now: "2026-07-12T12:00:00.000Z", excludeHomes: [projectHome.id] });
    assert.deepEqual(comparison.models.map((model) => model.key), ["gpt-6-sol"]);
  } finally {
    store.close();
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
  await writeFile(quotaFile, jsonl([
    { type: "session_meta", timestamp: "2026-09-25T11:00:00.000Z", payload: { id: "quota-observation" } },
    quotaTokenRow("2026-09-25T11:59:00.000Z", "2026-09-25T14:37:00.000Z"),
  ]));
  await writeFile(startFile, jsonl([
    { type: "session_meta", timestamp: "2026-09-25T09:37:00.000Z", payload: { id: "at-start" } },
    tokenRow("2026-09-25T09:37:00.000Z", 50, 40, 5, 10, 0),
  ]));
  await writeFile(asOfFile, jsonl([
    { type: "session_meta", timestamp: "2026-09-25T12:00:00.000Z", payload: { id: "at-as-of" } },
    tokenRow("2026-09-25T12:00:00.000Z", 100, 80, 10, 20, 0),
  ]));
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    await store.sync();
    store.recordsForRange = () => { throw new Error("quota summaries must skip New Record history scans"); };
    const indexedSnapshots = store.database.prepare(
      "SELECT line_number, role, limit_id, window_minutes, used_percent FROM rate_limit_observations WHERE source_path = ?",
    ).all(quotaFile);
    const summary = store.summarize({ preset: "quota_5h", bucket: "month", now: "2026-09-25T12:00:00.000Z" });
    const quotaLookupPlan = store.database.prepare(`
      EXPLAIN QUERY PLAN SELECT source_path, line_number, role, observed_at_ms, limit_id,
        limit_name, plan_type, window_minutes, resets_at_ms, used_percent
      FROM rate_limit_observations INDEXED BY rate_limit_window_lookup_idx
      ORDER BY limit_id ASC, window_minutes ASC, observed_at_ms DESC
    `).all();
    const eventRangePlan = store.database.prepare(`
      EXPLAIN QUERY PLAN SELECT COUNT(*) FROM events WHERE timestamp_ms >= ? AND timestamp_ms <= ?
    `).all(Date.parse(summary.range.start), Date.parse(summary.range.end));
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
    assert.equal(summary.timeline.reduce((sum, slot) => sum + slot.total.total, 0), summary.totals.total);
    assert.ok(summary.timeline.slice(5).every((slot) => slot.future));
    assert.equal(summary.comparison, null);
    assert.deepEqual(summary.records, {});
    assert.equal(excluded.quota.windows.quota_5h.state, "available");
    assert.equal(excluded.totals.total, 0);
    assert.equal(Number(store.database.prepare("SELECT COUNT(*) AS count FROM events WHERE source_path = ?").get(quotaFile).count), 0);

    await store.sync();
    assert.equal(Number(store.database.prepare("SELECT COUNT(*) AS count FROM rate_limit_observations WHERE source_path = ?").get(quotaFile).count), 1);
    await writeFile(quotaFile, jsonl([
      { type: "session_meta", timestamp: "2026-09-25T11:00:00.000Z", payload: { id: "quota-observation" } },
      quotaTokenRow("2026-09-25T12:01:00.000Z", "2026-09-25T14:38:00.000Z"),
    ]) + "\n");
    await store.sync();
    const replaced = store.database.prepare("SELECT COUNT(*) AS count, MAX(resets_at_ms) AS reset FROM rate_limit_observations WHERE source_path = ?").get(quotaFile);
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
  await writeFile(quotaFile, jsonl([
    { type: "session_meta", timestamp: "2026-07-12T01:00:00.000Z", payload: { id: "migration-quota" } },
    quotaTokenRow("2026-07-12T01:02:00.000Z", "2026-07-12T06:02:00.000Z"),
  ]));
  const initial = new UsageStore({ homeDir, databaseFile });
  await initial.sync();
  initial.close();

  const legacy = new DatabaseSync(databaseFile);
  legacy.exec("PRAGMA user_version = 5; DROP TABLE rate_limit_observations;");
  for (const [pathName, kind, homeId] of [
    ["zcode.jsonl", "zcode", "zcode-home"],
    ["project-log.jsonl", "project-log", "project-home"],
  ]) {
    legacy.prepare(`
      INSERT INTO source_files (path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?, 123, 456, ?)
    `).run(pathName, kind, homeId, homeId, path.dirname(pathName), new Date().toISOString());
  }
  legacy.close();

  const migrated = new UsageStore({ homeDir, databaseFile });
  try {
    await migrated.open();
    const sourceState = (filePath) => migrated.database.prepare("SELECT size, mtime_ms FROM source_files WHERE path = ?").get(filePath);
    assert.equal(Number(sourceState(sessionFile).size), -1);
    assert.equal(Number(sourceState(sessionFile).mtime_ms), -1);
    assert.equal(Number(sourceState("zcode.jsonl").size), 123);
    assert.equal(Number(sourceState("zcode.jsonl").mtime_ms), 456);
    assert.equal(Number(sourceState("project-log.jsonl").size), 123);
    assert.equal(Number(sourceState("project-log.jsonl").mtime_ms), 456);

    const replaceFile = migrated.replaceFile.bind(migrated);
    migrated.replaceFile = async () => { throw new Error("simulated reindex failure"); };
    const failed = await migrated.sync();
    assert.equal(failed.updatedFileCount, 0);
    assert.equal(Number(sourceState(sessionFile).size), -1);
    assert.match(migrated.warnings.join(" "), /simulated reindex failure/);

    migrated.replaceFile = replaceFile;
    const retried = await migrated.sync();
    assert.equal(retried.updatedFileCount, 2);
    assert.equal(Number(migrated.database.prepare("SELECT COUNT(*) AS count FROM rate_limit_observations").get().count), 1);
    assert.equal(Number(migrated.database.prepare("PRAGMA user_version").get().user_version), 7);
  } finally {
    migrated.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
