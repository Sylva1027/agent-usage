import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { backup, DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";

import { STORE_SCHEMA_VERSION, UsageStore } from "../src/usage-store.js";
import { API_PRICING_VERSION, getPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { buildUsageIndex, buildUsageReport, summarizeUsageIndex } from "../src/usage-core.js";
import { metadataFromReport } from "../public/app.js";

test("model activity ages without file changes, agrees with static metadata, and ignores future maxima", async () => {
  const { homeDir, databaseFile } = await makeStoreFixture();
  const store = new UsageStore({ homeDir, databaseFile });
  try {
    await store.sync();
    const before = new Date("2026-08-12T01:00:59.999Z");
    const boundary = new Date("2026-08-12T01:01:00.000Z");
    assert.deepEqual(store.metadata(before).activeHarnessModels.Codex, ["gpt-6-sol"]);
    const expired = store.metadata(boundary);
    assert.deepEqual(expired.activeHarnessModels.Codex, []);
    assert.deepEqual(expired.harnessModels.Codex, ["gpt-6-sol"]);
    const report = await buildUsageReport({ homeDir });
    const staticMetadata = metadataFromReport({ ...report, asOf: boundary.toISOString() });
    assert.deepEqual(staticMetadata.activeHarnessModels, expired.activeHarnessModels);
    assert.deepEqual(staticMetadata.modelLastSeen, expired.modelLastSeen);
    const columns = store.database
      .prepare("PRAGMA table_info(events)")
      .all()
      .map((row) => row.name)
      .filter((name) => name !== "id");
    store.database.exec(
      `INSERT INTO events (${columns.join(", ")}) SELECT ${columns.map((name) => (name === "timestamp_ms" ? Date.parse("2027-01-01T00:00:00Z") : name)).join(", ")} FROM events LIMIT 1`,
    );
    assert.deepEqual(store.metadata(before).activeHarnessModels.Codex, ["gpt-6-sol"]);
    assert.equal(store.metadata(before).modelLastSeen.Codex["gpt-6-sol"], Date.parse("2026-07-12T01:01:00Z"));
  } finally {
    store.close();
  }
});

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

test("SQLite product grouping deduplicates shared sessions without rewriting raw channels", async () => {
  const { homeDir, databaseFile } = await makeStoreFixture();
  const store = new UsageStore({ homeDir, databaseFile });
  try {
    await store.sync();
    const columns = store.database
      .prepare("PRAGMA table_info(events)")
      .all()
      .map((row) => row.name)
      .filter((name) => name !== "id");
    store.database.exec(
      `INSERT INTO events (${columns.join(", ")}) SELECT ${columns.map((name) => (name === "channel" ? "'Codex Exec'" : name)).join(", ")} FROM events LIMIT 1`,
    );
    const summary = store.summarize({ preset: "all", calendarZone: "utc" });
    assert.equal(summary.channels.length, 1);
    assert.equal(summary.channels[0].name, "Codex");
    assert.equal(summary.channels[0].sessions, 1);
    assert.equal(summary.channels[0].total.total, 246);
    assert.equal(summary.timeline.find((row) => row.total.total > 0).channels[0].sessions, 1);
    assert.deepEqual(
      store.database
        .prepare("SELECT DISTINCT channel FROM events ORDER BY channel")
        .all()
        .map((row) => row.channel),
      ["CLI", "Codex Exec"],
    );
  } finally {
    store.close();
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
      // perf（M3.4）同理：它是 `store_meta` 的**磁盘状态机投影**（状态/指纹/受阻 home），
      // 内存索引（`buildUsageIndex`）里**没有** `store_meta` 这个概念 ⇒ 一并排除。
      // ⚠️ 排除的是"内存侧**结构上不可能**有"的字段；`perf` 自身的语义由
      // `test/perf-state.test.js` 独立验收（17 用例），此处不重复覆盖。
      const { records: _records, perf: _perf, ...actualRest } = actual;
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

test("UsageStore upgrades schema v13 to v14 with the private Codex projection table only (no backfill, no dirtying)", async () => {
  const { homeDir, databaseFile } = await makeStoreFixture();
  const initial = new UsageStore({ homeDir, databaseFile });
  await initial.sync();
  initial.close();

  // 退回**真实 v13 形状**：业务表齐全、只是没有 T1 的私有投影表。
  const legacy = new DatabaseSync(databaseFile);
  legacy.exec("DROP TABLE perf_codex_projections; PRAGMA user_version = 13;");
  assert.equal(Number(legacy.prepare("PRAGMA user_version").get().user_version), 13);
  legacy.close();

  const migrated = new UsageStore({ homeDir, databaseFile });
  try {
    await migrated.open();
    assert.equal(Number(migrated.database.prepare("PRAGMA user_version").get().user_version), STORE_SCHEMA_VERSION);
    assert.equal(
      Number(
        migrated.database
          .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'perf_codex_projections'")
          .get().n,
      ),
      1,
    );
    // **不回填** ⇒ 空表；迁移唯一的 schema 变化就是新表 + 索引。
    assert.equal(Number(migrated.database.prepare("SELECT COUNT(*) AS n FROM perf_codex_projections").get().n), 0);
    // **不**无条件标脏全库（v12 段那种 `UPDATE source_files SET size = -1` 在这里被明确禁止）。
    assert.equal(
      Number(
        migrated.database.prepare("SELECT COUNT(*) AS n FROM source_files WHERE size = -1 OR mtime_ms = -1").get().n,
      ),
      0,
    );
    const result = await migrated.sync();
    assert.equal(result.updatedFileCount, 0, "迁移后第一个 sync 不得重读未变文件");
    assert.ok(Number(migrated.database.prepare("SELECT COUNT(*) AS n FROM events").get().n) >= 1, "业务数据未被触碰");
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

test("UsageStore v5 migration marks all sources for retryable automatic reindex (v12 global dirtying supersedes its selective dirtying)", async () => {
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
  // 反向证据的基线：迁移前把**锚点列**快照下来（标脏只允许改 size/mtime_ms）。
  const anchorColumnsBefore = legacy
    .prepare("SELECT path, kind, home_id, home_label, home_path, indexed_at FROM source_files ORDER BY path")
    .all();
  legacy.close();

  const migrated = new UsageStore({ homeDir, databaseFile });
  try {
    await migrated.open();
    const sourceState = (filePath) =>
      migrated.database.prepare("SELECT size, mtime_ms FROM source_files WHERE path = ?").get(filePath);
    const anchorColumnsAfter = migrated.database
      .prepare("SELECT path, kind, home_id, home_label, home_path, indexed_at FROM source_files ORDER BY path")
      .all();
    assert.ok(anchorColumnsBefore.length >= 4, "基线至少要有既有会话/配额与两条合成来源");

    // 登记（裁定 AP-2）：v5 只标脏 Codex JSONL（选择性），但迁移是 open() 内的**一次性顺序链**，
    // 会一路跑到 STORE_SCHEMA_VERSION；v12 分支的**无 WHERE** 标脏把所有来源都标脏 ⇒
    // 中间版本的选择性语义在当前版本**不再可观测**。本用例守护的是 v12 的全量标脏语义。
    // 正向：**所有**来源（含既有会话文件与两条合成来源）都被标脏。
    for (const row of migrated.database.prepare("SELECT path, size, mtime_ms FROM source_files ORDER BY path").all()) {
      assert.equal(Number(row.size), -1, `${row.path} 必须被 v12 标脏`);
      assert.equal(Number(row.mtime_ms), -1, `${row.path} 的 mtime_ms 必须被 v12 标脏`);
    }
    assert.equal(Number(sourceState(sessionFile).size), -1);
    assert.equal(Number(sourceState(sessionFile).mtime_ms), -1);
    // 反向：标脏**只动 size/mtime_ms** —— 锚点列逐字未动（不是把整行洗了）。
    assert.deepEqual(
      anchorColumnsAfter.map((row) => ({ ...row })),
      anchorColumnsBefore.map((row) => ({ ...row })),
      "v12 标脏不得改写 path/kind/home_id/home_label/home_path/indexed_at",
    );

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

// ═══════════════════════════════════════════════════════════════════════════════
// Claude Code：主转录 + subagents 都进索引，按 message.id 去重，harness 归组独立。
// ═══════════════════════════════════════════════════════════════════════════════

/** @param {Record<string, any>} [usage] */
function claudeAssistantRow({ messageId, model = "claude-sonnet-4-5", timestamp = "2026-07-12T02:01:00.000Z", usage }) {
  return {
    type: "assistant",
    uuid: `uuid-${messageId}`,
    timestamp,
    sessionId: "session-claude-1",
    cwd: "/work/claudeproj",
    requestedModel: model,
    message: {
      id: messageId,
      model,
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
        output_tokens: 20,
        ...(usage || {}),
      },
    },
  };
}

async function makeClaudeStoreFixture() {
  const { homeDir, sessionFile } = await makeStoreFixture();
  const claudeHome = path.join(homeDir, ".claude");
  const projectDir = path.join(claudeHome, "projects", "E--work-claudeproj");
  const subagentsDir = path.join(projectDir, "session-claude-1", "subagents");
  await mkdir(subagentsDir, { recursive: true });
  const mainFile = path.join(projectDir, "session-claude-1.jsonl");
  const subagentFile = path.join(subagentsDir, "agent-a1.jsonl");
  // 主转录：同一 message.id 的两个内容块（只算一次）。
  await writeFile(
    mainFile,
    jsonl([
      { type: "custom-title", customTitle: "Claude 会话", sessionId: "session-claude-1" },
      claudeAssistantRow({ messageId: "msg-claude-main" }),
      claudeAssistantRow({ messageId: "msg-claude-main" }),
    ]),
  );
  // 子代理：零用量占位块 + 真实块（取真实块，并合并到主渠道）。
  await writeFile(
    subagentFile,
    jsonl([
      claudeAssistantRow({
        messageId: "msg-claude-sub",
        usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
      }),
      claudeAssistantRow({
        messageId: "msg-claude-sub",
        timestamp: "2026-07-12T02:02:00.000Z",
        usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 3 },
      }),
    ]),
  );
  return {
    homeDir,
    sessionFile,
    mainFile,
    subagentFile,
    databaseFile: path.join(homeDir, ".codex-usage", "usage-index.sqlite"),
  };
}

test("UsageStore 索引 Claude Code 主转录与子代理，且只在文件变化后重建", async () => {
  const { homeDir, mainFile, databaseFile } = await makeClaudeStoreFixture();
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    const first = await store.sync();
    assert.equal(first.updatedFileCount, 3, "Codex + Claude 主转录 + 子代理");

    const summary = store.summarize({ preset: "all", bucket: "day" });
    const claude = summary.channels.find((channel) => channel.name === "Claude");
    assert.ok(claude, "摘要里应出现 Claude Code 渠道");
    // 主转录 135 + 子代理 8；重复块与零用量占位块都不得计数。
    assert.deepEqual(claude.total, { total: 143, input: 120, cached: 10, output: 23, reasoning: 0 });

    const repository = summary.repositories.find((row) => row.key === "directory:/work/claudeproj");
    assert.ok(repository, "Claude 会话应归到 cwd 对应的仓库");
    assert.equal(repository.total.total, 143);

    const second = await store.sync();
    assert.equal(second.updatedFileCount, 0, "文件未变化时不应重建");

    await appendFile(
      mainFile,
      jsonl([claudeAssistantRow({ messageId: "msg-claude-2", timestamp: "2026-07-12T02:03:00.000Z" })]),
    );
    const third = await store.sync();
    // 主转录变化会按会话级联到子代理文件：子代理事件并入父 `sessionId`（产品口径"合并到主渠道"），
    // 而 C5 的 `earlierFileChanged` 级联规定"同一 session 的较早文件变了 ⇒ 后续文件重提取"。
    // 这是既有语义，不是重复索引 —— 下面的事件计数仍为 3。
    assert.equal(third.updatedFileCount, 2, "主转录变化 + 同会话子代理级联重提取");

    const after = store.summarize({ preset: "all", bucket: "day" });
    assert.equal(after.channels.find((channel) => channel.name === "Claude").total.total, 278);
    assert.equal(
      Number(store.database.prepare("SELECT COUNT(*) AS count FROM events WHERE home_id LIKE 'claude%'").get().count),
      3,
      "重解析后不应残留重复事件",
    );
  } finally {
    store.close();
  }
});

test("UsageStore upgrades v15 → v16 by re-reading Claude sources only", async () => {
  const { homeDir, mainFile, databaseFile } = await makeClaudeStoreFixture();
  const initial = new UsageStore({ homeDir, databaseFile });
  await initial.sync();
  // 模拟 v15 库：Claude 事件带着旧的 requestedModel 身份（测试夹具两者相同，直接改写即可）。
  initial.database.prepare("UPDATE events SET model = 'mythos-magpie-3145220055' WHERE home_id LIKE 'claude%'").run();
  initial.database.exec("PRAGMA user_version = 15");
  initial.close();

  const migrated = new UsageStore({ homeDir, databaseFile });
  try {
    await migrated.open();
    assert.equal(Number(migrated.database.prepare("PRAGMA user_version").get().user_version), STORE_SCHEMA_VERSION);
    const dirty = migrated.database
      .prepare("SELECT path, kind, size, mtime_ms FROM source_files WHERE size = -1 OR mtime_ms = -1 ORDER BY path")
      .all();
    assert.ok(dirty.length > 0, "v16 必须标脏 Claude 来源");
    assert.ok(
      dirty.every((row) => row.kind === "claude"),
      "只标脏 kind='claude'，其它来源不因本次迁移重读",
    );

    const result = await migrated.sync();
    assert.equal(result.updatedFileCount, dirty.length, "首个 sync 重读全部被标脏的 Claude 转录");
    const models = migrated.database
      .prepare("SELECT DISTINCT model FROM events WHERE home_id LIKE 'claude%' ORDER BY model")
      .all()
      .map((row) => row.model);
    assert.deepEqual(models, ["claude-sonnet-4-5"], "重读后事件恢复为线路模型身份");
    assert.equal((await migrated.sync()).updatedFileCount, 0, "重读后文件不再变化");
    assert.ok(mainFile);
  } finally {
    migrated.close();
  }
});

test("UsageStore metadata 把 Claude 用量归入 harnessModels.Claude，且不进 Codex 限额窗口", async () => {
  const { homeDir, sessionFile, databaseFile } = await makeClaudeStoreFixture();
  await appendFile(sessionFile, jsonl([quotaTokenRow("2026-07-12T01:00:00.000Z", "2026-07-12T06:00:00.000Z")]));
  const store = new UsageStore({ homeDir, databaseFile });

  try {
    await store.sync();
    const metadata = store.metadata();
    assert.deepEqual(metadata.harnessModels.Claude, ["claude-sonnet-4-5"]);
    assert.ok(!metadata.harnessModels.Codex.includes("claude-sonnet-4-5"));

    const claudeHome = metadata.homes.find((home) => home.kind === "claude");
    assert.ok(claudeHome, "应发现 Claude Code 来源");
    assert.equal(claudeHome.status, "active");
    assert.equal(claudeHome.eventCount, 2, "主转录 1 + 子代理 1");
    assert.equal(claudeHome.sessionCount, 1, "子代理并入父会话");
    assert.ok(store.nonCodexHomeIds().includes(claudeHome.id));

    const quota = store.summarize({ preset: "quota_5h", bucket: "quota_30m", now: "2026-07-12T02:00:00.000Z" });
    assert.ok(!quota.channels.some((channel) => channel.name.startsWith("Claude")), "限额窗口里不应出现 Claude 渠道");
  } finally {
    store.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// C5 卡：无实际变更的同步轮 —— 不空发布、不改写候选、不无条件清空派生缓存，
// 仍按契约更新检查时刻；`earlierFileChanged/changedSessions` 级联保留；失败提交后可重试。
//
// 计数口径说明（为什么这些断言**不依赖** B2 探针也能判"零发布"）：
//   * `codexThreadBuildPlan` 为空 ⇒ 本轮**没有任何 home 进入规划** ⇒ 全文解析
//     （`readCodexRolloutMetadata`）与候选构建（`buildCodexThreadPerfSamples`）的**唯一**
//     调用点都没被执行（它们在 `planStableCodexHome` 里，规划是它们的唯一入口）；
//   * `perf_samples` / `perf_rollout_threads` 的 **rowid 逐项相同**（STRICT 表 ⇒ delete+insert
//     必然改 rowid）⇒ 候选**没有被改写**；
//   * `perf_index_version` 不变 ⇒ 聚合"已提交指纹 + 来源身份"的版本号不变 ⇒ **没有发布**；
//   * `replaceFile` 调用次数 = 0 ⇒ 用量侧没有重写。
// 探针级计数（`codexParse` / `codexBuild` / `publishCodexThreads`）由 `C5/measure-c5.mjs` 以
// B2 口径给出（本卡不得只凭源指纹判断，故这里同时钉住 rowid 与版本号两个**库内事实**）。
// ═══════════════════════════════════════════════════════════════════════════════

/** 与 `tools/fixture.mjs` 的 `codexRollout` 同形（`token_usage_record` 是 perf 候选的唯一来源）。 */
function c5CodexRollout(threadId, turnId, { ordinalBase = 0, outputTokens = 500, startMs = 1_700_000_000_000 } = {}) {
  return jsonl([
    { type: "session_meta", ordinal: ordinalBase + 0, payload: { id: threadId, session_id: threadId, source: "cli" } },
    {
      type: "turn_context",
      ordinal: ordinalBase + 1,
      payload: { thread_id: threadId, turn_id: turnId, model: "gpt-fixture", effort: "medium" },
    },
    {
      type: "token_usage_record",
      ordinal: ordinalBase + 2,
      timestamp: new Date(startMs).toISOString(),
      payload: {
        thread_id: threadId,
        turn_id: turnId,
        response_id: `resp-${threadId}`,
        usage: { output_tokens: outputTokens },
      },
    },
    {
      type: "event_msg",
      ordinal: ordinalBase + 3,
      payload: {
        type: "item_completed",
        thread_id: threadId,
        turn_id: turnId,
        item: { id: `item-${threadId}`, type: "AgentMessage" },
        started_at_ms: startMs,
        completed_at_ms: startMs + 1500,
      },
    },
    {
      type: "event_msg",
      ordinal: ordinalBase + 4,
      payload: {
        type: "task_complete",
        thread_id: threadId,
        turn_id: turnId,
        started_at: Math.floor(startMs / 1000),
        completed_at: Math.floor(startMs / 1000) + 2,
        duration_ms: 1500,
      },
    },
  ]);
}

function c5TokenUsageFrame(threadId, turnId, ordinal, outputTokens, timestamp) {
  return {
    type: "token_usage_record",
    ordinal,
    timestamp,
    payload: {
      thread_id: threadId,
      turn_id: turnId,
      response_id: `resp-${turnId}`,
      usage: { output_tokens: outputTokens },
    },
  };
}

/** 两个 codex rollout（各自一个线程、各自产生候选）。 */
async function makeC5CodexHome() {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-c5-noop-"));
  const sessionDir = path.join(homeDir, ".codex", "sessions", "2026", "10", "09");
  await mkdir(sessionDir, { recursive: true });
  const codexA = path.join(sessionDir, "rollout-c5-a.jsonl");
  const codexB = path.join(sessionDir, "rollout-c5-b.jsonl");
  await writeFile(codexA, c5CodexRollout("c5-thread-a", "c5-turn-a1"));
  await writeFile(codexB, c5CodexRollout("c5-thread-b", "c5-turn-b1", { ordinalBase: 10, outputTokens: 700 }));
  return {
    homeDir,
    sessionDir,
    codexA,
    codexB,
    databaseFile: path.join(homeDir, ".codex-usage", "usage-index.sqlite"),
  };
}

/** `perf_samples` 的 rowid 按线程分组 —— STRICT 表 ⇒ 一旦 delete+insert，rowid 必变。 */
function c5SampleRowidsByThread(store) {
  const out = {};
  for (const row of store.database
    .prepare("SELECT rowid AS rid, sample_key FROM perf_samples WHERE source_kind = 'codex' ORDER BY sample_key")
    .all()) {
    let threadId = "?";
    try {
      const key = JSON.parse(String(row.sample_key));
      threadId = Array.isArray(key) ? String(key[2] ?? "?") : "?";
    } catch {
      threadId = "?";
    }
    const bucket = out[threadId] || [];
    bucket.push(Number(row.rid));
    out[threadId] = bucket;
  }
  return out;
}

function c5Samples(store) {
  return store.database
    .prepare("SELECT sample_key FROM perf_samples WHERE source_kind = 'codex' ORDER BY sample_key")
    .all()
    .map((row) => String(row.sample_key));
}

function c5Rowids(store, table) {
  return store.database
    .prepare(`SELECT rowid AS rid FROM ${table} ORDER BY rid`)
    .all()
    .map((row) => Number(row.rid));
}

/** 包住 `replaceFile` 数调用次数（用量侧唯一写点）。 */
function c5CountReplaceFile(store) {
  const original = store.replaceFile.bind(store);
  const state = { paths: [] };
  store.replaceFile = async (file, hooks) => {
    state.paths.push(String(file.filePath));
    return original(file, hooks);
  };
  return state;
}

test("C5 · 连续三轮零解析/零构建/零发布，且第四轮写入一个文件立刻生效", async () => {
  const { homeDir, codexA, databaseFile } = await makeC5CodexHome();
  const store = new UsageStore({ homeDir, databaseFile });
  try {
    const first = await store.sync();
    assert.equal(first.updatedFileCount, 2, "C5 r1 冷启动应索引 2 份 rollout");
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS n FROM perf_samples").get().n,
      2,
      "C5 r1 两个线程各 1 条候选",
    );
    assert.deepEqual(c5Rowids(store, "perf_rollout_threads").length, 2, "C5 r1 应有 2 条 (path, thread) 归属行");

    const baseline = {
      sampleKeys: c5Samples(store),
      rowids: c5SampleRowidsByThread(store),
      threadRowids: c5Rowids(store, "perf_rollout_threads"),
      indexVersion: store.readMeta("perf_index_version"),
      fingerprints: store.readMeta("perf_file_fingerprints"),
      eventCount: store.metadata().eventCount,
    };

    // ── 连续三轮（r2/r3/r4）：全文解析 = 候选写入 = 发布 = 0，用量侧 0 次重写 ──────────
    for (const round of [2, 3, 4]) {
      const replace = c5CountReplaceFile(store);
      const status = await store.sync();
      assert.equal(status.updatedFileCount, 0, `C5 r${round} updatedFileCount 必须为 0`);
      assert.equal(replace.paths.length, 0, `C5 r${round} replaceFile 调用次数必须为 0（用量侧零重写）`);
      assert.equal(
        store.codexThreadBuildPlan.size,
        0,
        `C5 r${round} 不得有任何 home 进入规划（⇒ 零全文解析/零候选构建）`,
      );
      assert.deepEqual(
        c5SampleRowidsByThread(store),
        baseline.rowids,
        `C5 r${round} 候选 rowid 必须逐项不变（零改写）`,
      );
      assert.deepEqual(
        c5Rowids(store, "perf_rollout_threads"),
        baseline.threadRowids,
        `C5 r${round} 归属行 rowid 必须逐项不变`,
      );
      assert.equal(
        store.readMeta("perf_index_version"),
        baseline.indexVersion,
        `C5 r${round} perf_index_version 必须不变（零发布）`,
      );
      assert.equal(store.readMeta("perf_file_fingerprints"), baseline.fingerprints, `C5 r${round} 已提交指纹必须不变`);
      assert.equal(store.metadata().eventCount, baseline.eventCount, `C5 r${round} 事件数不得变化`);
    }

    // ── 第四轮之后写一个文件：下一轮必须立刻生效（"跳过"没退化成"永久不更新"）────────
    const before = c5SampleRowidsByThread(store);
    const appended = c5TokenUsageFrame("c5-thread-a", "c5-turn-a2", 5, 321, "2026-10-09T02:30:00.000Z");
    await appendFile(codexA, `${JSON.stringify(appended)}\n`);

    const replace5 = c5CountReplaceFile(store);
    const fifth = await store.sync();
    assert.equal(fifth.updatedFileCount, 1, "C5 r5 只有被追加的那份 rollout 需要重提取");
    assert.deepEqual(replace5.paths, [codexA], "C5 r5 用量侧只应重写被追加的文件");
    const planEntries = [...store.codexThreadBuildPlan.entries()];
    assert.equal(planEntries.length, 1, "C5 r5 应恰好规划 1 个 home");
    assert.deepEqual([...planEntries[0][1].staged].sort(), ["c5-thread-a"], "C5 r5 只有线程 A 需要重建候选");
    assert.deepEqual([...planEntries[0][1].retained].sort(), ["c5-thread-b"], "C5 r5 线程 B 必须原样保留");
    const after = c5SampleRowidsByThread(store);
    assert.equal(after["c5-thread-a"].length, before["c5-thread-a"].length + 1, "C5 r5 线程 A 应多出 1 条候选");
    assert.deepEqual(after["c5-thread-b"], before["c5-thread-b"], "C5 r5 未受影响线程 B 的 rowid 必须逐项不变");
    assert.notEqual(store.readMeta("perf_index_version"), baseline.indexVersion, "C5 r5 真有内容变化 ⇒ 版本必须变化");
    // codex rollout 里的 `token_usage_record` 只产生 perf 候选，不产生用量事件（用量事件来自
    // `token_count` 累计帧）⇒ 因此这里断言"用量侧没有被这次追加牵动"，重复计数由级联用例覆盖。
    assert.equal(store.metadata().eventCount, baseline.eventCount, "C5 r5 本次追加不得改动用量事件数");
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("C5 · checkedAt 每轮按契约更新，generatedAt/perf_indexed_at 保持轮次级语义", async () => {
  const { homeDir, databaseFile } = await makeC5CodexHome();
  const store = new UsageStore({ homeDir, databaseFile });
  try {
    await store.sync();
    const indexVersion = store.readMeta("perf_index_version");
    const generatedAtSeen = [];
    const checkedAtSeen = [];

    for (const round of [2, 3, 4]) {
      const before = Date.now();
      const status = await store.sync();
      const after = Date.now();
      const checkedAtMs = Date.parse(status.checkedAt);
      const generatedAtMs = Date.parse(store.generatedAt);
      // 「按契约更新检查时刻」：本轮的 checkedAt / generatedAt 都必须**落在本轮窗口内**
      //（不依赖"两个时刻必须差 ≥1ms"这种会偶发失败的口径）。
      assert.ok(!Number.isNaN(checkedAtMs), `C5 r${round} checkedAt 必须是合法时刻`);
      assert.ok(checkedAtMs >= before && checkedAtMs <= after, `C5 r${round} checkedAt 必须由本轮更新`);
      assert.ok(!Number.isNaN(generatedAtMs), `C5 r${round} generatedAt 必须是合法时刻`);
      assert.ok(generatedAtMs >= before && generatedAtMs <= after, `C5 r${round} generatedAt 必须由本轮更新`);
      // `generated_at` / `perf_indexed_at` 是**轮次级**时刻（同一来源 `this.generatedAt`）⇒ 每轮写、
      // 且两者逐字相同。它们**不是**"索引内容版本"，内容的版本号是 `perf_index_version`。
      assert.equal(store.readMeta("generated_at"), store.generatedAt, `C5 r${round} generated_at 必须等于本轮时刻`);
      assert.equal(
        store.readMeta("perf_indexed_at"),
        store.generatedAt,
        `C5 r${round} perf_indexed_at 必须等于本轮时刻`,
      );
      assert.equal(
        store.readMeta("perf_index_version"),
        indexVersion,
        `C5 r${round} 例行时刻更新不得改变内容版本号（perf_index_version）`,
      );
      // 读路径上的 `generatedAt` 同样必须是**本轮**的（派生缓存被保留时也不得冻住例行时刻）。
      assert.equal(
        store.metadata().generatedAt,
        store.generatedAt,
        `C5 r${round} metadata().generatedAt 必须等于本轮时刻`,
      );
      generatedAtSeen.push(store.generatedAt);
      checkedAtSeen.push(status.checkedAt);
    }

    assert.equal(new Set(checkedAtSeen).size, checkedAtSeen.length, "三轮 no-op 的 checkedAt 应逐轮不同");
    assert.equal(new Set(generatedAtSeen).size, generatedAtSeen.length, "三轮 no-op 的 generatedAt 应逐轮不同");
    const ordered = [...checkedAtSeen, ...generatedAtSeen].every(
      (value) => Date.parse(value) >= Date.parse(checkedAtSeen[0]),
    );
    assert.ok(ordered, "轮次级时刻不得回退");
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("C5 · 无实际变更的轮次保留派生缓存，真有变更的轮次才失效", async () => {
  const { homeDir, codexA, databaseFile } = await makeC5CodexHome();
  const store = new UsageStore({ homeDir, databaseFile });
  try {
    await store.sync();
    // r1 写了用量数据 ⇒ 两个派生缓存都必须被失效。
    assert.equal(store.metadataCache, null, "C5 r1 有数据变更 ⇒ metadataCache 必须失效");
    assert.equal(store.periodComparisonCache.size, 0, "C5 r1 有数据变更 ⇒ periodComparisonCache 必须清空");

    // 读一次把两个缓存填起来（这就是"派生结构"本身，而不是源指纹）。
    store.metadata(new Date("2026-10-09T03:00:00.000Z"));
    store.periodComparison({ now: "2026-10-09T03:00:00.000Z" });
    const metadataCacheRef = store.metadataCache;
    const comparisonKeys = [...store.periodComparisonCache.keys()];
    const comparisonValue = structuredClone([...store.periodComparisonCache.values()][0]);
    const warmEventCount = metadataCacheRef.eventCount;
    assert.ok(metadataCacheRef !== null, "C5 warm 阶段 metadataCache 必须存在");
    assert.equal(comparisonKeys.length, 1, "C5 warm 阶段 periodComparisonCache 应有 1 条");

    for (const round of [2, 3, 4]) {
      const status = await store.sync();
      assert.equal(status.updatedFileCount, 0, `C5 r${round} 应为 no-op 轮`);
      // ★ 卡面「不无条件清空派生缓存」：no-op 轮**必须**保留同一份派生结构。
      assert.equal(store.metadataCache, metadataCacheRef, `C5 r${round} metadataCache 必须原样保留（同一对象）`);
      assert.deepEqual(
        [...store.periodComparisonCache.keys()],
        comparisonKeys,
        `C5 r${round} periodComparisonCache 必须保留`,
      );
      assert.deepEqual(
        structuredClone([...store.periodComparisonCache.values()][0]),
        comparisonValue,
        `C5 r${round} 保留的是同一份对比结果`,
      );
      // 保留 ≠ 冻住例行时刻：`metadata().generatedAt` 仍必须是本轮的。
      assert.equal(store.metadataCache.generatedAt, store.generatedAt, `C5 r${round} 保留的缓存必须刷新例行时刻`);
      assert.equal(store.metadata().generatedAt, store.generatedAt, `C5 r${round} metadata().generatedAt 必须是本轮`);
      assert.equal(store.metadataCache.eventCount, warmEventCount, `C5 r${round} 缓存的用量计数必须仍然正确`);
    }

    // 真有变更 ⇒ 必须失效（否则会给出过期读数）。
    await appendFile(
      codexA,
      `${JSON.stringify(c5TokenUsageFrame("c5-thread-a", "c5-turn-a2", 5, 321, "2026-10-09T02:30:00.000Z"))}\n`,
    );
    const changed = await store.sync();
    assert.equal(changed.updatedFileCount, 1, "C5 r5 有变更");
    assert.equal(store.metadataCache, null, "C5 r5 有变更 ⇒ metadataCache 必须失效");
    assert.equal(store.periodComparisonCache.size, 0, "C5 r5 有变更 ⇒ periodComparisonCache 必须清空");
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("C5 · 只有早期文件变化时 laterFileChanged 级联仍重提取（不提前跳过用量提取）", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-c5-cascade-"));
  // 三个 project-log 来源：A/B 共享同一 session（用于级联），C 用独立 session（对照组）。
  // 顺序：`importDirs` 数组序与路径字典序一致（log-a < log-b < log-c），A 一定在 B 之前被处理
  // ⇒ "改 A 时 B 被拉进来"只可能来自 `earlierFileChanged/changedSessions` 会话级联。
  const rootA = path.join(homeDir, "log-a");
  const rootB = path.join(homeDir, "log-b");
  const rootC = path.join(homeDir, "log-c");
  const databaseFile = path.join(homeDir, "usage-index.sqlite");
  const projectLog = (sessionId, total, timestamp) => ({
    schema_version: "codex-usage.project-log.v1",
    timestamp,
    source: "test",
    channel: "Test",
    project_root: "/work/c5",
    cwd: "/work/c5",
    session_id: sessionId,
    model: "gpt-6-luna",
    usage: { total, input: Math.max(total - 2, 0), cached: 0, output: 2, reasoning: 0 },
  });
  const fileOf = async (root, rows) => {
    await mkdir(path.join(root, ".codex-usage"), { recursive: true });
    const file = path.join(root, ".codex-usage", "usage.jsonl");
    await writeFile(file, jsonl(rows));
    return file;
  };
  const fileA = await fileOf(rootA, [projectLog("c5-shared-session", 10, "2026-10-09T02:00:00.000Z")]);
  const fileB = await fileOf(rootB, [projectLog("c5-shared-session", 10, "2026-10-09T02:00:30.000Z")]);
  const fileC = await fileOf(rootC, [projectLog("c5-independent-session", 10, "2026-10-09T02:01:00.000Z")]);

  const store = new UsageStore({ homeDir, databaseFile, importDirs: [rootA, rootB, rootC] });
  const eventsOf = (file) =>
    store.database
      .prepare("SELECT rowid AS rid, session_id FROM events WHERE source_path = ? ORDER BY rid")
      .all(file)
      .map((row) => `${Number(row.rid)}:${String(row.session_id)}`);
  try {
    const first = await store.sync();
    assert.equal(first.updatedFileCount, 3, "C5 冷启动应索引三份 project-log");
    assert.equal(store.summarize({ preset: "all", bucket: "day" }).totals.total, 30, "C5 冷启动 10+10+10");
    const cBefore = eventsOf(fileC);

    // 只改 A（session 未变）⇒ 共享同一 session 的 B 必须被**会话级联**拉进来；C 不得受牵连。
    await appendFile(fileA, `${JSON.stringify(projectLog("c5-shared-session", 5, "2026-10-09T02:05:00.000Z"))}\n`);
    const replaceShared = c5CountReplaceFile(store);
    const cascaded = await store.sync();
    assert.equal(cascaded.updatedFileCount, 2, "C5 同一 session 的后续文件必须被级联重提取");
    assert.deepEqual(replaceShared.paths.slice().sort(), [fileA, fileB].sort(), "C5 级联应覆盖 A 与 B 两个文件");
    assert.deepEqual(eventsOf(fileC), cBefore, "C5 级联不得牵连 session 无关的 C");
    assert.equal(
      store.summarize({ preset: "all", bucket: "day" }).totals.total,
      35,
      "C5 级联后用量必须正确（15+10+10）",
    );

    // 对照组：只改 C（独立 session）⇒ A/B 不得被顺带重提取（证明级联是会话驱动，不是"永远全量重读"）。
    await appendFile(fileC, `${JSON.stringify(projectLog("c5-independent-session", 7, "2026-10-09T02:10:00.000Z"))}\n`);
    const replaceIsolated = c5CountReplaceFile(store);
    const isolated = await store.sync();
    assert.equal(isolated.updatedFileCount, 1, "C5 独立 session 不应级联到 A/B");
    assert.deepEqual(replaceIsolated.paths, [fileC], "C5 只应重提取 C");
    assert.equal(
      store.summarize({ preset: "all", bucket: "day" }).totals.total,
      42,
      "C5 对照轮用量必须正确（15+10+17）",
    );
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("C5 · 发布事务失败回滚后，下一轮能重试成功且状态自洽", async () => {
  const { homeDir, codexA, databaseFile } = await makeC5CodexHome();
  const store = new UsageStore({ homeDir, databaseFile });
  try {
    await store.sync();
    const baseline = {
      sampleKeys: c5Samples(store),
      rowids: c5SampleRowidsByThread(store),
      indexVersion: store.readMeta("perf_index_version"),
      fingerprints: store.readMeta("perf_file_fingerprints"),
    };
    assert.equal(baseline.sampleKeys.length, 2, "C5 冷启动应有 2 条候选");

    // 注入一次发布失败：任何 `perf_samples` INSERT 都 ABORT（与 C2/C4 同型手法）。
    store.database.exec(
      "CREATE TRIGGER c5_fail_publish BEFORE INSERT ON perf_samples BEGIN SELECT RAISE(ABORT, 'c5 injected publish failure'); END",
    );
    await appendFile(
      codexA,
      `${JSON.stringify(c5TokenUsageFrame("c5-thread-a", "c5-turn-a2", 5, 321, "2026-10-09T02:30:00.000Z"))}\n`,
    );
    const failed = await store.sync();
    assert.equal(failed.updatedFileCount, 1, "C5 用量侧仍应成功写入（失败只发生在 perf 发布事务内）");
    // 原子性不破：发布事务整体回滚 ⇒ 候选、归属行、已提交指纹与版本号**逐项**不变。
    assert.deepEqual(c5Samples(store), baseline.sampleKeys, "C5 失败的发布不得留下任何候选");
    assert.deepEqual(c5SampleRowidsByThread(store), baseline.rowids, "C5 失败的发布不得改任何 rowid");
    assert.equal(store.readMeta("perf_file_fingerprints"), baseline.fingerprints, "C5 失败的发布不得改已提交指纹");
    assert.equal(store.readMeta("perf_index_version"), baseline.indexVersion, "C5 失败的发布不得改版本号");
    assert.notEqual(failed.perfState, "ready", "C5 失败的发布必须把状态标为受阻");
    const codexHomeIds = store.database
      .prepare("SELECT DISTINCT home_id FROM perf_rollout_threads")
      .all()
      .map((row) => String(row.home_id));
    assert.equal(codexHomeIds.length, 1, "C5 本用例只有一个 codex home");
    assert.ok(
      JSON.parse(String(store.readMeta("perf_degraded_home_ids"))).includes(codexHomeIds[0]),
      "C5 失败的发布必须指名受阻 home（供 D4 排除出排名）",
    );
    assert.equal(store.database.prepare("PRAGMA foreign_key_check").all().length, 0, "C5 回滚后不得留下外键悬挂");

    // 解除注入 ⇒ 下一轮必须重试成功并自洽。
    store.database.exec("DROP TRIGGER c5_fail_publish");
    const retried = await store.sync();
    assert.equal(retried.perfState, "ready", "C5 重试轮必须恢复 ready");
    assert.equal(store.readMeta("perf_degraded_home_ids"), "[]", "C5 重试轮必须清空受阻 home");
    const retriedSamples = c5Samples(store);
    assert.equal(retriedSamples.length, baseline.sampleKeys.length + 1, "C5 重试轮必须真的把被回滚的候选发布出去");
    const retriedByThread = c5SampleRowidsByThread(store);
    assert.equal(
      retriedByThread["c5-thread-a"].length,
      baseline.rowids["c5-thread-a"].length + 1,
      "C5 重试轮线程 A 必须多出被回滚过的那条候选",
    );
    assert.deepEqual(
      retriedByThread["c5-thread-b"],
      baseline.rowids["c5-thread-b"],
      "C5 重试轮线程 B 的 rowid 必须逐项不变",
    );
    assert.notEqual(store.readMeta("perf_index_version"), baseline.indexVersion, "C5 重试成功后版本号必须变化");
    assert.equal(store.database.prepare("PRAGMA foreign_key_check").all().length, 0, "C5 重试轮外键必须干净");
    // 用量侧自洽：本轮 sync 没有重写用量行（`replaceFile` 一次都没跑），`source_files` 也不得多出重复行。
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS n FROM source_files").get().n,
      2,
      "C5 重试轮不得多出重复来源行",
    );
    assert.equal(store.metadata().eventCount, 0, "C5 该 fixture 的 rollout 不含累计用量帧 ⇒ 事件数恒为 0");
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

// ── D1 卡：实例修订（自身提交）/ 外部提交（同连接 `PRAGMA data_version`）/ 回滚 ─────────────────────
// 卡面：`docs/plans/2026-10-09-dashboard-refresh-performance-implementation-plan.md:240-245`。
// 判据全部是**确定性计数/引用**，不用墙钟做判定（时刻字段只用来证明"它确实被每轮写了"）。

function d1ProjectLog(sessionId, total, timestamp) {
  return {
    schema_version: "codex-usage.project-log.v1",
    timestamp,
    source: "test",
    channel: "Test",
    project_root: "/work/d1",
    cwd: "/work/d1",
    session_id: sessionId,
    model: "gpt-6-luna",
    usage: { total, input: Math.max(total - 2, 0), cached: 0, output: 2, reasoning: 0 },
  };
}

/** 一个"真用量"的 project-log 来源（1 行 ⇒ 1 条 events），返回可继续追加的文件路径。 */
async function d1MakeProjectLogHome(prefix) {
  const homeDir = await mkdtemp(path.join(tmpdir(), prefix));
  const importDir = path.join(homeDir, "log-a");
  await mkdir(path.join(importDir, ".codex-usage"), { recursive: true });
  const file = path.join(importDir, ".codex-usage", "usage.jsonl");
  await writeFile(file, jsonl([d1ProjectLog(`${prefix}session`, 10, "2026-07-12T02:00:00.000Z")]));
  const databaseFile = path.join(homeDir, "usage-index.sqlite");
  const options = { homeDir, databaseFile, importDirs: [importDir] };
  return { homeDir, importDir, file, databaseFile, options, reportOptions: { homeDir, importDirs: [importDir] } };
}

function d1DataVersion(store) {
  return Number(store.database.prepare("PRAGMA data_version").get()?.data_version ?? 0) || 0;
}

/** 第二个连接**提交**（外部提交的唯一合法构造）：复制现有 events 行，可选顺手改一个 meta 键。 */
function d1ExternalCommit(databaseFile, { copies = 1, setMeta = null } = {}) {
  const other = new DatabaseSync(databaseFile);
  try {
    const columns = other
      .prepare("PRAGMA table_info(events)")
      .all()
      .map((row) => String(row.name))
      .filter((name) => name !== "id");
    other.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < copies; index += 1) {
      other.exec(`INSERT INTO events (${columns.join(", ")}) SELECT ${columns.join(", ")} FROM events LIMIT 1`);
    }
    if (setMeta) {
      other
        .prepare(
          "INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(setMeta.key, String(setMeta.value));
    }
    other.exec("COMMIT");
  } finally {
    other.close();
  }
}

/** 把两个派生缓存填起来（"派生结构"本身），返回引用/内容用于判定 no-op 轮是否原样保留。 */
function d1WarmCaches(store) {
  const metadata = store.metadata(new Date("2026-07-12T05:00:00.000Z"));
  const comparison = store.periodComparison({ now: "2026-07-12T05:00:00.000Z" });
  return {
    metadata,
    comparison,
    metadataRef: store.metadataCache,
    comparisonKeys: [...store.periodComparisonCache.keys()],
    comparisonValue: structuredClone([...store.periodComparisonCache.values()][0]),
  };
}

test("D1 · 无变化同步保留派生缓存：例行时刻每轮写入但不推进实例修订（卡面「不作为用量变化」）", async () => {
  const fixture = await d1MakeProjectLogHome("codex-d1-noop-");
  const store = new UsageStore(fixture.options);
  try {
    const cold = await store.sync({ options: fixture.reportOptions });
    assert.equal(cold.updatedFileCount, 1, "D1 冷启动索引 1 个来源");
    const revisionAfterCold = store.storeRevision;
    assert.equal(revisionAfterCold, 1, "D1 冷启动恰好 1 次用量提交 ⇒ 修订 1");
    const warm = d1WarmCaches(store);
    assert.ok(warm.metadataRef !== null, "D1 warm 阶段 metadataCache 必须存在");
    assert.equal(warm.comparisonKeys.length, 1, "D1 warm 阶段 periodComparisonCache 恰好 1 条");
    const indexVersion = store.readMeta("perf_index_version");
    const generatedAtSeen = [];

    for (const round of [2, 3, 4]) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const status = await store.sync({ options: fixture.reportOptions });
      assert.equal(status.updatedFileCount, 0, `D1 r${round} 必须是 no-op 轮`);
      // ★ 保留派生结构（与 C5 的接受态一致）……
      assert.equal(store.metadataCache, warm.metadataRef, `D1 r${round} metadataCache 必须原样保留（同一对象）`);
      assert.deepEqual([...store.periodComparisonCache.keys()], warm.comparisonKeys, `D1 r${round} 对比缓存必须保留`);
      // ……但**修订号不得前进**（这是 D1 新增的判据：例行时刻不算用量变化）。
      assert.equal(store.storeRevision, revisionAfterCold, `D1 r${round} 例行时刻刷新不得推进修订`);
      // 例行时刻确实被写了（否则"保留"就变成了"冻住"）。
      assert.equal(store.readMeta("generated_at"), store.generatedAt, `D1 r${round} generated_at 必须每轮写入`);
      assert.equal(store.readMeta("perf_indexed_at"), store.generatedAt, `D1 r${round} perf_indexed_at 必须每轮写入`);
      assert.equal(store.readMeta("perf_index_version"), indexVersion, `D1 r${round} 内容版本号不得变`);
      assert.equal(store.metadata().eventCount, warm.metadata.eventCount, `D1 r${round} 缓存读数仍必须正确`);
      assert.equal(store.metadata().generatedAt, store.generatedAt, `D1 r${round} metadata().generatedAt 必须是本轮`);
      generatedAtSeen.push(store.readMeta("generated_at"));
    }
    assert.ok(new Set(generatedAtSeen).size >= 2, "D1 三轮 no-op 至少写过 2 个不同的例行时刻（证明它每轮都写）");
  } finally {
    store.close();
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("D1 · 自身提交与外部连接提交都必须让结果更新（外部靠同连接 data_version，≥2 次）", async () => {
  const fixture = await d1MakeProjectLogHome("codex-d1-commit-");
  const store = new UsageStore(fixture.options);
  try {
    await store.sync({ options: fixture.reportOptions });
    const warm = d1WarmCaches(store);
    const baseline = {
      eventCount: warm.metadata.eventCount,
      storeRevision: store.storeRevision,
      dataVersion: d1DataVersion(store),
    };

    // ① 自身提交：本实例写入 ⇒ 显式修订 + 结果更新。
    await appendFile(
      fixture.file,
      `${JSON.stringify(d1ProjectLog("codex-d1-commit-session", 7, "2026-07-12T02:05:00.000Z"))}\n`,
    );
    const own = await store.sync({ options: fixture.reportOptions });
    assert.equal(own.updatedFileCount, 1, "D1 自身提交轮 updatedFileCount=1");
    assert.ok(store.storeRevision > baseline.storeRevision, "D1 自身提交必须推进显式修订");
    assert.equal(store.lastCommitReason, "usage", "D1 用量提交的理由");
    assert.equal(store.metadata().eventCount, baseline.eventCount + 1, "D1 自身提交必须让结果更新");
    assert.equal(d1DataVersion(store), baseline.dataVersion, "D1 同连接的自身提交**不得**改变 data_version");

    // ② 外部提交（第二个连接）：同连接 data_version 检出 ⇒ 失效 + 重载必要元数据。
    const revisionBeforeExternal = store.storeRevision;
    d1ExternalCommit(fixture.databaseFile, {
      copies: 1,
      setMeta: { key: "generated_at", value: "2000-01-01T00:00:00.000Z" },
    });
    const dataVersionAfterFirst = d1DataVersion(store);
    assert.notEqual(dataVersionAfterFirst, baseline.dataVersion, "D1 外部提交必须改变同连接的 data_version");
    const afterFirst = store.metadata(new Date("2026-07-12T05:00:00.000Z"));
    assert.equal(afterFirst.eventCount, baseline.eventCount + 2, "D1 外部提交必须让结果更新");
    assert.equal(store.externalCommitCount, 1, "D1 检出 1 次外部提交");
    assert.equal(store.storeRevision, revisionBeforeExternal + 1, "D1 外部提交推进 1 次修订");
    assert.equal(store.generatedAt, "2000-01-01T00:00:00.000Z", "D1 必须重载必要元数据（store_meta.generated_at）");

    // ③ 第二次外部提交：证明不是"只对第一次敏感"。
    d1ExternalCommit(fixture.databaseFile, { copies: 1 });
    const dataVersionAfterSecond = d1DataVersion(store);
    assert.notEqual(dataVersionAfterSecond, dataVersionAfterFirst, "D1 第二次外部提交同样改变 data_version");
    const afterSecond = store.metadata(new Date("2026-07-12T05:00:00.000Z"));
    assert.equal(afterSecond.eventCount, baseline.eventCount + 3, "D1 第二次外部提交同样让结果更新");
    assert.equal(store.externalCommitCount, 2, "D1 检出 2 次外部提交");
    assert.equal(store.derivedRevision, store.storeRevision, "D1 派生缓存必须已按新修订重建");
  } finally {
    store.close();
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("D1 · 回滚不伪造成功变更：失败替换轮修订不动、派生缓存被安全清理、无幻影行", async () => {
  const fixture = await d1MakeProjectLogHome("codex-d1-rollback-");
  const store = new UsageStore(fixture.options);
  try {
    await store.sync({ options: fixture.reportOptions });
    d1WarmCaches(store);
    const before = {
      storeRevision: store.storeRevision,
      eventCount: Number(store.database.prepare("SELECT COUNT(*) AS n FROM events").get().n),
      metadataCacheNonNull: store.metadataCache !== null,
    };

    // 注入：任何 events 插入都 ABORT ⇒ `replaceFile` 整笔 ROLLBACK（该轮唯一的写入被撤销）。
    store.database.exec(
      "CREATE TRIGGER d1_fail_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'd1 injected events failure'); END",
    );
    await appendFile(
      fixture.file,
      `${JSON.stringify(d1ProjectLog("codex-d1-rollback-session", 5, "2026-07-12T02:05:00.000Z"))}\n`,
    );
    const failed = await store.sync({ options: fixture.reportOptions });
    assert.equal(failed.updatedFileCount, 0, "D1 失败轮不得计入 updatedFileCount");
    assert.equal(store.storeRevision, before.storeRevision, "D1 回滚不得推进修订（不伪造成功变更）");
    assert.equal(store.metadataCache, null, "D1 回滚后事务内的派生缓存必须被安全清理");
    assert.equal(store.periodComparisonCache.size, 0, "D1 回滚后对比缓存必须被安全清理");
    assert.equal(store.writeTransactionDepth, 0, "D1 写事务深度不得泄漏");
    assert.equal(
      Number(store.database.prepare("SELECT COUNT(*) AS n FROM events").get().n),
      before.eventCount,
      "D1 回滚不得留下幻影用量行",
    );
    assert.equal(store.database.prepare("PRAGMA foreign_key_check").all().length, 0, "D1 回滚后外键必须干净");
    assert.ok(
      store.warnings.some((warning) => String(warning).includes("d1 injected events failure")),
      "D1 失败必须留下用量侧告警",
    );

    // 事务内已读的派生缓存：深度 > 0 时读路径**不落**缓存（预防），深度归零后恢复。
    store.writeTransactionDepth = 1;
    try {
      store.metadata(new Date("2026-07-12T05:00:00.000Z"));
      store.periodComparison({ now: "2026-07-12T05:00:00.000Z" });
      assert.equal(store.metadataCache, null, "D1 写事务内 metadata() 不得落缓存");
      assert.equal(store.periodComparisonCache.size, 0, "D1 写事务内 periodComparison() 不得落缓存");
    } finally {
      store.writeTransactionDepth = 0;
    }
    assert.ok(d1WarmCaches(store).metadataRef !== null, "D1 深度归零后缓存必须恢复");

    // 解除注入 ⇒ 下一轮必须真的把那次追加写进去（回滚 ≠ 永久丢失）。
    store.database.exec("DROP TRIGGER d1_fail_events");
    const retried = await store.sync({ options: fixture.reportOptions });
    assert.equal(retried.updatedFileCount, 1, "D1 重试轮必须成功写入");
    assert.equal(
      Number(store.database.prepare("SELECT COUNT(*) AS n FROM events").get().n),
      before.eventCount + 1,
      "D1 重试轮必须补上被回滚的那条追加",
    );
    assert.ok(store.storeRevision > before.storeRevision, "D1 重试轮推进修订");
  } finally {
    store.close();
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("D1 · close/open 重取外部提交基准，live 与冻结快照实例互不影响", async () => {
  const fixture = await d1MakeProjectLogHome("codex-d1-frozen-");
  const store = new UsageStore(fixture.options);
  let frozen = null;
  try {
    await store.sync({ options: fixture.reportOptions });
    const warm = d1WarmCaches(store);
    const snapshotFile = path.join(fixture.homeDir, "frozen-snapshot.sqlite");
    await backup(store.database, snapshotFile);
    frozen = new UsageStore({ databaseFile: snapshotFile });
    await frozen.open();
    // 与 `src/server.js` 的 `createSnapshot` 同形：快照实例自持 homes / evidence / warnings。
    frozen.homes = structuredClone(store.homes);
    frozen.serviceTierEvidence = store.serviceTierEvidence;
    frozen.warnings = [...store.warnings];
    const frozenBefore = {
      eventCount: frozen.metadata(new Date("2026-07-12T05:00:00.000Z")).eventCount,
      storeRevision: frozen.storeRevision,
      externalCommitCount: frozen.externalCommitCount,
      generatedAt: frozen.generatedAt,
    };

    // live 侧再提交一次。
    await appendFile(
      fixture.file,
      `${JSON.stringify(d1ProjectLog("codex-d1-frozen-session", 9, "2026-07-12T02:10:00.000Z"))}\n`,
    );
    await store.sync({ options: fixture.reportOptions });
    assert.ok(store.storeRevision > frozenBefore.storeRevision, "D1 live 自身提交推进修订");
    assert.equal(
      frozen.metadata(new Date("2026-07-12T05:00:00.000Z")).eventCount,
      frozenBefore.eventCount,
      "D1 冻结实例读数不得受 live 修订影响",
    );
    assert.equal(frozen.storeRevision, frozenBefore.storeRevision, "D1 冻结实例修订号不变");
    assert.equal(frozen.externalCommitCount, 0, "D1 冻结库上没有外部提交可检");
    assert.equal(frozen.generatedAt, frozenBefore.generatedAt, "D1 冻结实例的例行时刻保持快照值");

    // close/open：缓存清空、外部提交基准重取、实例修订号保留（单调）。
    const versionBeforeReopen = d1DataVersion(store);
    const revisionBeforeReopen = store.storeRevision;
    const eventCountBeforeReopen = store.metadata(new Date("2026-07-12T05:00:00.000Z")).eventCount;
    store.close();
    assert.equal(store.metadataCache, null, "D1 close() 后派生缓存必须清空");
    await store.open();
    assert.equal(store.metadataCache, null, "D1 open() 后派生缓存为空（不跨 close 复用）");
    assert.equal(store.observedDataVersion, versionBeforeReopen, "D1 open() 必须重取外部提交基准");
    assert.equal(store.derivedRevision, store.storeRevision, "D1 open() 后缓存与修订对齐");
    assert.equal(store.storeRevision, revisionBeforeReopen, "D1 实例修订号跨 close/open 保留（单调）");
    assert.equal(
      store.metadata(new Date("2026-07-12T05:00:00.000Z")).eventCount,
      eventCountBeforeReopen,
      "D1 重开后读数仍必须正确",
    );
    void warm;
  } finally {
    frozen?.close();
    store.close();
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

// ── D2 · 历史冠军 memo（完整 scope）与“纪录期是否完整落在范围内”的分离 ──────────────────────────
//
// 判别力要点（**不是**“今日总费用相等”这种无效证据）：
//   * memo 命中的**机械**证据 = `recordsForRange` 的全历史扫描语句被 `prepare` 的次数；
//   * 冠军**身份**（`period` / `unit` / `value`）逐项断言，而不是只比总额；
//   * 六项键**逐项**改变 ⇒ 立即失效；规范排除集合（顺序/重复）改变 ⇒ **不**失效。

/** 一天一个 rollout（一条 token 行 ⇒ `total` 即该日总量），model 固定 `gpt-6-sol`。 */
function d2Rollout(name, total, timestamp, model = "gpt-6-sol") {
  return jsonl([
    { timestamp, type: "session_meta", payload: { id: name, source: "cli", originator: "codex-tui", cwd: "/work/d2" } },
    { type: "turn_context", payload: { model } },
    tokenRow(timestamp, total, Math.max(total - 1, 1), 0, 1, 0),
  ]);
}

/** `[[month, day, total], …]` ⇒ 每项一个 rollout 文件（时间固定 `02:00Z` ⇒ 本地同日）。 */
async function d2MultiDayFixture(prefix, days) {
  const homeDir = await mkdtemp(path.join(tmpdir(), prefix));
  const sessionDir = path.join(homeDir, ".codex", "sessions");
  await mkdir(sessionDir, { recursive: true });
  for (const [month, day, total] of days) {
    await writeFile(
      path.join(sessionDir, `rollout-${month}-${day}.jsonl`),
      d2Rollout(`${prefix}${month}${day}`, total, `2026-${month}-${day}T02:00:00.000Z`),
    );
  }
  return { homeDir, sessionDir, databaseFile: path.join(homeDir, ".codex-usage", "usage-index.sqlite") };
}

/**
 * `recordsForRange` 的全历史扫描语句被 `prepare` 的次数 —— “memo 命中 / 失效”的机械证据。
 *
 * 只匹配**那一条** `SELECT timestamp_ms, day_key, week_key, month_key, session_id, model, channel,`：
 * 同名列也出现在 `replaceFile` 的 INSERT 里（`hour_key, day_key, week_key, month_key, cwd, …`），
 * 粗匹配会把“每个文件一次 INSERT”算进来。计数器可以在 `open()/sync()` **之前**装上：`database`
 * 是构造器里的自有属性，这里把它换成访问器，`open()` 赋进来的连接（以及 `close()` 的 `null`）
 * 都会自动被包一层。
 */
function d2CountRecordScans(store) {
  const counter = { prepares: 0 };
  let current = null;
  const wrap = (database) => {
    if (!database) return database;
    const original = database.prepare.bind(database);
    database.prepare = (sql) => {
      if (typeof sql === "string" && sql.includes("day_key, week_key, month_key, session_id, model, channel,")) {
        counter.prepares += 1;
      }
      return original(sql);
    };
    return database;
  };
  Object.defineProperty(store, "database", {
    configurable: true,
    get: () => current,
    set: (value) => {
      current = value === null ? null : wrap(value);
    },
  });
  current = wrap(store.database);
  return counter;
}

const D2_JULY_START = "2026-07-01T00:00:00";
const D2_JULY_END = "2026-07-31T23:59:59.999";

/** 直接构造 `recordsForRange` 需要的范围（**本地**时区整段；只用于本卡的边界断言）。 */
function d2Range({ zone = "local", start = D2_JULY_START, end = D2_JULY_END } = {}) {
  return { calendarZone: zone, start: new Date(start), end: new Date(end) };
}

/** 把一个模型的所有费率字段翻倍（汇率不动）⇒ 只改“价目目录版本”这一项。 */
function d2DoubleRates(model) {
  const clone = structuredClone(model);
  const double = (rates) =>
    rates
      ? Object.fromEntries(
          Object.entries(rates).map(([key, value]) => [key, typeof value === "number" ? value * 2 : value]),
        )
      : rates;
  for (const field of ["short", "long", "shortLongOutput"]) clone[field] = double(clone[field]);
  if (clone.fast) {
    for (const field of ["short", "long", "shortLongOutput"]) clone.fast[field] = double(clone.fast[field]);
  }
  return clone;
}

test("D2 · 历史冠军 memo 六项键：任一项改变即失效，规范排除集合（顺序/重复）不失效", async () => {
  const fixture = await d2MultiDayFixture("codex-d2-keys-", [
    ["07", "06", 300],
    ["07", "07", 100],
    ["07", "12", 500],
  ]);
  const store = new UsageStore({ homeDir: fixture.homeDir, databaseFile: fixture.databaseFile });
  const scans = d2CountRecordScans(store);
  const baseCatalog = getPricingCatalog();
  const setA = ["home-a", "home-a", "home-b"];
  try {
    await store.sync();
    const first = store.recordsForRange(d2Range(), setA);
    assert.equal(first.totalTokens.period, "2026-07-12");
    assert.equal(first.totalTokens.unit, "day");
    assert.equal(first.totalTokens.value, 500);
    assert.equal(scans.prepares, 1, "冷调用：恰好一次全历史计价扫描");
    const cold = store.recordChampionCache;
    assert.ok(cold, "冷调用后必须落 memo 槽");

    // 命中：规范集合相同（顺序 + 重复不同）⇒ 槽对象不变、零重扫、结果逐字相同。
    assert.deepEqual(store.recordsForRange(d2Range(), ["home-b", "home-a"]), first, "⑥ 顺序/重复无关");
    assert.equal(store.recordChampionCache, cold, "命中时不得重建 memo 槽");
    assert.equal(scans.prepares, 1, "⑥ 集合相同 ⇒ 零重扫");

    // ① 数据修订（D1 的机制）前进 ⇒ 立即失效（结果本身不变）。
    assert.ok(store.commitStoreRevision("d2-probe") > 0);
    const afterRevision = store.recordsForRange(d2Range(), ["home-b", "home-a"]);
    assert.notEqual(store.recordChampionCache, cold, "① 修订前进 ⇒ memo 换新");
    assert.equal(scans.prepares, 2, "① 修订前进 ⇒ 重扫");
    assert.deepEqual(afterRevision, first, "① 只影响新鲜度，不改结果");

    // ② 价目目录版本（只改模型费率，汇率不动）⇒ 立即失效且**成本冠军按新价目重算**。
    const doubled = structuredClone(baseCatalog);
    doubled.models["gpt-6-sol"] = d2DoubleRates(doubled.models["gpt-6-sol"]);
    setPricingCatalog(doubled);
    const afterPrice = store.recordsForRange(d2Range(), ["home-b", "home-a"]);
    assert.equal(scans.prepares, 3, "② 价目版本变化 ⇒ 重扫");
    assert.equal(afterPrice.totalCost.period, first.totalCost.period, "② 冠军期不变（只改价目）");
    assert.ok(
      afterPrice.totalCost.value > first.totalCost.value * 1.5,
      `② 价目立即生效：${first.totalCost.value} → ${afterPrice.totalCost.value}`,
    );

    // ③ 汇率：公开 API 上汇率变化**必然**同时改变 ② 的版本（`setPricingCatalog` 的 hash 覆盖
    // `usdToCnyRate`）⇒ ③ 与 ② 在“输入类别”上掩蔽（见 `handoffs/D2.md` §2 的如实声明）；
    // 这里给“变化 ⇒ 立即失效 + 成本按新汇率重算”的实测。
    const reRated = structuredClone(doubled);
    reRated.usdToCnyRate = Number(baseCatalog.usdToCnyRate) * 3;
    setPricingCatalog(reRated);
    const afterRate = store.recordsForRange(d2Range(), ["home-b", "home-a"]);
    assert.equal(scans.prepares, 4, "③ 汇率变化 ⇒ 立即重扫");
    assert.ok(afterRate.totalCost.value > afterPrice.totalCost.value, "③ 汇率立即生效（不被 memo 冻结）");

    // ④ service-tier evidence 签名：**隔离**只改这一项（修订未动）⇒ 立即失效。
    store.serviceTierEvidenceInput = "d2-probe-tier-signature";
    store.recordsForRange(d2Range(), ["home-b", "home-a"]);
    assert.equal(scans.prepares, 5, "④ evidence 签名变化（隔离：修订未动）⇒ 立即重扫");

    // ⑥ 真的换一个排除集合 ⇒ 立即失效（结果与“同一价目状态下、集合等价”的读数逐字相同）。
    const beforeExtra = store.recordsForRange(d2Range(), ["home-b", "home-a"]);
    assert.equal(scans.prepares, 5, "同一键再次命中（价目改动后仍是同一槽）");
    const other = store.recordsForRange(d2Range(), ["home-a", "home-b", "home-c"]);
    assert.equal(scans.prepares, 6, "⑥ 排除集合变化 ⇒ 重扫");
    assert.deepEqual(other, beforeExtra, "排除不存在的 home ⇒ 与同价目状态下的已有读数逐字相同");
    const again = store.recordsForRange(d2Range(), ["home-a", "home-b", "home-c"]);
    assert.equal(scans.prepares, 6, "换过之后再次命中");
    assert.deepEqual(again, other);
  } finally {
    setPricingCatalog(baseCatalog);
    store.close();
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("D2 · 严格新高 / 并列不点亮 / 至少两期可比 / 新高立即刷新冠军", async () => {
  // (a) 并列冠军：前两名相等 ⇒ 所有指标都不点亮（memo 里也不得留冠军条目）。
  const tie = await d2MultiDayFixture("codex-d2-tie-", [
    ["07", "10", 100],
    ["07", "11", 500],
    ["07", "12", 500],
  ]);
  const tieStore = new UsageStore({ homeDir: tie.homeDir, databaseFile: tie.databaseFile });
  try {
    await tieStore.sync();
    const records = tieStore.recordsForRange(d2Range(), []);
    assert.deepEqual(records, {}, "并列（500/500）不得被当成新高 ⇒ 一条纪录都不点亮");
    assert.deepEqual(
      tieStore.recordChampionCache.champions,
      { day: {}, week: {}, month: {} },
      "并列期的 memo 里不得留冠军（否则后续包含判定会点亮它）",
    );
  } finally {
    tieStore.close();
    await rm(tie.homeDir, { recursive: true, force: true });
  }

  // (b) 至少两期可比：只有一期 ⇒ 哪怕是最大值也不点亮。
  const single = await d2MultiDayFixture("codex-d2-single-", [["07", "12", 500]]);
  const singleStore = new UsageStore({ homeDir: single.homeDir, databaseFile: single.databaseFile });
  try {
    await singleStore.sync();
    assert.deepEqual(singleStore.recordsForRange(d2Range(), []), {}, "只有一期可比 ⇒ 不点亮");
    assert.deepEqual(
      singleStore.recordsForRange(d2Range({ start: "2026-07-12T00:00:00", end: "2026-07-12T23:59:59.999" }), []),
      {},
      "窄范围同样不点亮",
    );
  } finally {
    singleStore.close();
    await rm(single.homeDir, { recursive: true, force: true });
  }

  // (c) 严格新高必须刷新：历史被修正（新增更高峰）后，冠军与**同一范围的结论**都必须立即改变。
  const grow = await d2MultiDayFixture("codex-d2-grow-", [
    ["07", "10", 300],
    ["07", "11", 100],
    ["07", "12", 500],
  ]);
  const growStore = new UsageStore({ homeDir: grow.homeDir, databaseFile: grow.databaseFile });
  const scans = d2CountRecordScans(growStore);
  const day12 = d2Range({ start: "2026-07-12T00:00:00", end: "2026-07-12T23:59:59.999" });
  try {
    await growStore.sync();
    assert.equal(growStore.recordsForRange(day12, []).totalTokens.value, 500, "07-12 是当前严格最高日");
    await writeFile(
      path.join(grow.sessionDir, "rollout-07-14.jsonl"),
      d2Rollout("codex-d2-grow-0714", 950, "2026-07-14T02:00:00.000Z"),
    );
    await growStore.sync();
    const july = growStore.recordsForRange(d2Range(), []);
    assert.equal(scans.prepares, 2, "历史修正（新增文件）⇒ 下一次调用必须重扫，memo 不得冻结历史");
    assert.equal(july.totalTokens.period, "2026-07-14", "严格新高必须刷新冠军");
    assert.equal(july.totalTokens.value, 950);
    assert.equal(
      growStore.recordsForRange(day12, []).totalTokens,
      undefined,
      "冠军期已移到 07-12 之外 ⇒ 同一范围（07-12）的结论必须随之不点亮（不是冻结的旧冠军）",
    );
    assert.equal(scans.prepares, 2, "同一 store 上换了范围（07-12 ↔ 整月）仍命中 memo ⇒ 范围不是键");
  } finally {
    growStore.close();
    await rm(grow.homeDir, { recursive: true, force: true });
  }
});

test("D2 · 时区（local/utc）与跨日边界：同一事件在两个日键下的冠军与包含判定", async () => {
  const fixture = await d2MultiDayFixture("codex-d2-zone-", [["07", "11", 100]]);
  await writeFile(
    path.join(fixture.sessionDir, "rollout-late.jsonl"),
    d2Rollout("codex-d2-zone-late", 500, "2026-07-12T23:30:00.000Z"),
  );
  const store = new UsageStore({ homeDir: fixture.homeDir, databaseFile: fixture.databaseFile });
  const scans = d2CountRecordScans(store);
  try {
    await store.sync();
    const local = store.recordsForRange(d2Range({ zone: "local" }), []);
    const utc = store.recordsForRange(d2Range({ zone: "utc" }), []);
    assert.equal(scans.prepares, 2, "⑤ 时区是键的一项 ⇒ local/utc 各自重扫（不吃对方的 memo）");
    assert.equal(local.totalTokens.period, "2026-07-13", "本地时区：23:30Z 落在次日");
    assert.equal(local.totalTokens.value, 500);
    assert.equal(utc.totalTokens.period, "2026-07-12", "UTC：同一事件仍属 07-12");
    assert.equal(utc.totalTokens.value, 500);
    // 跨日边界（半开区间）：整日窗口包含冠军期；差 1 ms 就不算“完整落在范围内”。
    const wholeDay = store.recordsForRange(
      d2Range({ start: "2026-07-13T00:00:00", end: "2026-07-13T23:59:59.999" }),
      [],
    );
    assert.equal(wholeDay.totalTokens.period, "2026-07-13", "整日窗口完整包含本地冠军期");
    const oneMsShort = store.recordsForRange(
      d2Range({ start: "2026-07-13T00:00:00", end: "2026-07-13T23:59:59.998" }),
      [],
    );
    assert.equal(oneMsShort.totalTokens, undefined, "差 1 ms ⇒ 不完整包含 ⇒ 不得点亮");
  } finally {
    store.close();
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("D2 · 范围边界：日/周/月的包含关系与跨周、跨月边界", async () => {
  // 周级冠军只能在“日冠军与周冠军不同周”时被观察到：
  //   07-12（周一 07-06 那一周的唯一天，900）是日冠军；07-13..19 每天 200 ⇒ 那一周 1400 是周冠军。
  const weekly = await d2MultiDayFixture("codex-d2-bound-", [
    ["07", "12", 900],
    ...["13", "14", "15", "16", "17", "18", "19"].map((day) => ["07", day, 200]),
  ]);
  const weeklyStore = new UsageStore({ homeDir: weekly.homeDir, databaseFile: weekly.databaseFile });
  try {
    await weeklyStore.sync();
    const day = weeklyStore.recordsForRange(
      d2Range({ start: "2026-07-12T00:00:00", end: "2026-07-12T23:59:59.999" }),
      [],
    );
    assert.equal(day.totalTokens.unit, "day", "日冠军完整落在范围内 ⇒ 优先取日");
    assert.equal(day.totalTokens.value, 900);
    const week = weeklyStore.recordsForRange(
      d2Range({ start: "2026-07-13T00:00:00", end: "2026-07-19T23:59:59.999" }),
      [],
    );
    assert.equal(week.totalTokens.unit, "week", "日冠军在范围外 ⇒ 落到完整落在范围内的周冠军");
    assert.equal(week.totalTokens.period, "2026-07-13");
    assert.equal(week.totalTokens.value, 1400);
    const midWeek = weeklyStore.recordsForRange(
      d2Range({ start: "2026-07-14T00:00:00", end: "2026-07-19T23:59:59.999" }),
      [],
    );
    assert.equal(midWeek.totalTokens, undefined, "跨周：范围切掉周冠军的前半 ⇒ 不完整包含 ⇒ 不点亮");
    const notTheWholeWeek = weeklyStore.recordsForRange(
      d2Range({ start: "2026-07-13T00:00:00", end: "2026-07-19T23:59:59.998" }),
      [],
    );
    assert.equal(notTheWholeWeek.totalTokens, undefined, "跨周：范围比整周少 1 ms ⇒ 不点亮");
    const wholeJuly = weeklyStore.recordsForRange(d2Range(), []);
    assert.equal(wholeJuly.totalTokens.unit, "day", "整月范围里有日冠军 ⇒ 仍优先取日（优先级不得被 memo 改动）");
    assert.equal(wholeJuly.totalTokens.value, 900);
  } finally {
    weeklyStore.close();
    await rm(weekly.homeDir, { recursive: true, force: true });
  }

  // 月级冠军：日冠军 / 周冠军都在 8 月（范围外），7 月合计 2100 才是月冠军。
  const monthly = await d2MultiDayFixture("codex-d2-month-", [
    ...["06", "07", "08", "09", "10", "11", "12"].map((day) => ["07", day, 100]),
    ...["13", "14", "15", "16", "17", "18", "19"].map((day) => ["07", day, 100]),
    ...["20", "21", "22", "23", "24", "25", "26"].map((day) => ["07", day, 100]),
    ...["03", "04", "06", "07", "08", "09"].map((day) => ["08", day, 100]),
    ["08", "05", 900],
  ]);
  const monthlyStore = new UsageStore({ homeDir: monthly.homeDir, databaseFile: monthly.databaseFile });
  try {
    await monthlyStore.sync();
    const julyOnly = monthlyStore.recordsForRange(
      d2Range({ start: "2026-07-01T00:00:00", end: "2026-07-31T23:59:59.999" }),
      [],
    );
    assert.equal(julyOnly.totalTokens.unit, "month", "日/周冠军都在 8 月（范围外）⇒ 完整落在 7 月内的月冠军");
    assert.equal(julyOnly.totalTokens.period, "2026-07");
    assert.equal(julyOnly.totalTokens.value, 2100);
    const partialMonth = monthlyStore.recordsForRange(
      d2Range({ start: "2026-07-06T00:00:00", end: "2026-07-12T23:59:59.999" }),
      [],
    );
    assert.equal(partialMonth.totalTokens, undefined, "跨月：只盖住 7 月一部分 ⇒ 月冠军期不完整 ⇒ 不点亮");
    const bothMonths = monthlyStore.recordsForRange(
      d2Range({ start: "2026-07-01T00:00:00", end: "2026-08-31T23:59:59.999" }),
      [],
    );
    assert.equal(bothMonths.totalTokens.unit, "day", "范围跨到 8 月 ⇒ 日冠军（08-05）落在范围内 ⇒ 取日");
    assert.equal(bothMonths.totalTokens.value, 900);
  } finally {
    monthlyStore.close();
    await rm(monthly.homeDir, { recursive: true, force: true });
  }
});

test("D2 · 来源排除集合立刻生效（价目/历史/来源三类立即更新中的“来源开关”）", async () => {
  const fixture = await d1MakeProjectLogHome("codex-d2-exclude-");
  await appendFile(fixture.file, `${JSON.stringify(d1ProjectLog("d2-big", 9999, "2026-07-15T02:00:00.000Z"))}\n`);
  const sessionDir = path.join(fixture.homeDir, ".codex", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(sessionDir, "rollout-07-11.jsonl"),
    d2Rollout("codex-d2-exclude-0711", 100, "2026-07-11T02:00:00.000Z"),
  );
  await writeFile(
    path.join(sessionDir, "rollout-07-12.jsonl"),
    d2Rollout("codex-d2-exclude-0712", 500, "2026-07-12T02:00:00.000Z"),
  );
  const store = new UsageStore(fixture.options);
  const scans = d2CountRecordScans(store);
  try {
    await store.sync({ options: fixture.reportOptions });
    const projectHome = store.homes.find((home) => home.kind === "project-log");
    assert.ok(projectHome, "夹具必须含 project-log 来源");
    const all = store.recordsForRange(d2Range(), []);
    assert.equal(all.totalTokens.period, "2026-07-15", "全来源：project-log 的 9999 是冠军");
    const without = store.recordsForRange(d2Range(), [projectHome.id]);
    assert.equal(without.totalTokens.period, "2026-07-12", "排除该来源 ⇒ 冠军立即换人（不重做历史）");
    assert.equal(without.totalTokens.value, 500);
    const restored = store.recordsForRange(d2Range(), []);
    assert.equal(restored.totalTokens.period, "2026-07-15", "恢复来源 ⇒ 立即换回（集合是有序无关的键项）");
    assert.equal(scans.prepares, 3, "集合每变一次就重扫一次（不是 TTL，是输入身份）");
    assert.deepEqual(
      store.recordsForRange(
        d2Range(),
        store.homes.map((home) => home.id),
      ),
      {},
      "排除全部来源 ⇒ 无冠军",
    );
  } finally {
    store.close();
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("D2 · 写事务内不读也不写 memo（D1 的回滚语义），事务外恢复复用", async () => {
  const fixture = await d2MultiDayFixture("codex-d2-tx-", [
    ["07", "06", 300],
    ["07", "07", 100],
    ["07", "12", 500],
  ]);
  const store = new UsageStore({ homeDir: fixture.homeDir, databaseFile: fixture.databaseFile });
  const scans = d2CountRecordScans(store);
  const filters = { preset: "custom", startDate: "2026-07-12", endDate: "2026-07-12", bucket: "day" };
  try {
    await store.sync();
    store.recordChampionCache = null;
    store.writeTransactionDepth = 1;
    let inTransaction = null;
    try {
      const first = store.summarize(filters);
      assert.equal(store.recordChampionCache, null, "写事务内绝不落 memo（回滚后它会说谎）");
      const second = store.summarize(filters);
      assert.deepEqual(second.records, first.records, "写事务内读数仍必须正确");
      assert.equal(scans.prepares, 2, "写事务内不得吃 memo ⇒ 每次调用都真扫全历史");
      inTransaction = first;
    } finally {
      store.writeTransactionDepth = 0;
    }
    const after = store.summarize(filters);
    assert.ok(store.recordChampionCache !== null, "事务外恢复落 memo");
    assert.equal(scans.prepares, 3);
    assert.deepEqual(after.records, inTransaction.records, "事务外结果与事务内逐字一致");
    assert.equal(store.summarize(filters).records.totalTokens.period, "2026-07-12");
    assert.equal(scans.prepares, 3, "事务外第二次调用吃 memo（不再全历史计价）");
  } finally {
    store.close();
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

// ── D3 · quota 观测的规范映射复用（静态输入）+ 窗口/过期/倒计时按 asOf 每次现算 ────────────────
//
// 判别力要点：
//   * "复用"的机械证据 = `rate_limit_observations` 那条扫描语句被 `prepare` 的次数（改前：一次
//     `summarize` 里 2 次；本卡：1 次，且跨调用按 D1 修订命中）；
//   * "没有冻结时间派生字段"的证据 = **同一份观测**只推进 `now` ⇒ `state` / `percentStale` /
//     `range.end` / `windowStart` 给出**不同值**，而缓存里的**规范行逐字节不变**（10 个静态键）。

const D3_OBSERVATION_SIGNATURE = "FROM rate_limit_observations INDEXED BY rate_limit_window_lookup_idx";
const D3_OBSERVATION_KEYS = [
  "limitId",
  "limitName",
  "lineNumber",
  "observedAtMs",
  "planType",
  "resetsAtMs",
  "role",
  "sourcePath",
  "usedPercent",
  "windowMinutes",
];

/** `rate_limit_observations` 扫描语句被 `prepare` 的次数（"读了几次"）。 */
function d3CountObservationReads(store) {
  const counter = { prepares: 0 };
  let current = null;
  const wrap = (database) => {
    if (!database) return database;
    const original = database.prepare.bind(database);
    database.prepare = (sql) => {
      if (typeof sql === "string" && sql.includes(D3_OBSERVATION_SIGNATURE)) counter.prepares += 1;
      return original(sql);
    };
    return database;
  };
  Object.defineProperty(store, "database", {
    configurable: true,
    get: () => current,
    set: (value) => {
      current = value === null ? null : wrap(value);
    },
  });
  current = wrap(store.database);
  return counter;
}

/** 一份"观测"夹具：`.codex/sessions/.../quota.jsonl` 里 T0 观测、T0+300min 重置、42.5%。 */
async function d3QuotaFixture(prefix, observations) {
  const homeDir = await mkdtemp(path.join(tmpdir(), prefix));
  const sessionsDir = path.join(homeDir, ".codex", "sessions", "2026", "07", "12");
  await mkdir(sessionsDir, { recursive: true });
  const sessionFile = path.join(sessionsDir, "rollout.jsonl");
  const databaseFile = path.join(homeDir, ".codex-usage", "usage-index.sqlite");
  const rows = [
    {
      timestamp: "2026-07-12T00:59:00.000Z",
      type: "session_meta",
      payload: { id: `${prefix}session`, source: "cli", originator: "codex-tui", cwd: "/work/d3" },
    },
    { type: "turn_context", payload: { model: "gpt-6-sol" } },
    tokenRow("2026-07-12T00:59:30.000Z", 40, 30, 0, 10, 0),
  ];
  for (const [index, observation] of observations.entries()) {
    rows.push(quotaTokenRow(observation.observedAt, observation.resetsAt, observation.options));
    rows.push(tokenRow(`2026-07-12T0${index + 1}:30:00.000Z`, 10, 8, 0, 2, 0));
  }
  await writeFile(sessionFile, jsonl(rows));
  return { homeDir, sessionsDir, sessionFile, databaseFile, quotaFile: sessionFile };
}

test("D3 · 规范映射复用：一次 summarize 的两个消费者共用同一份观测映射（D1 修订驱动失效）", async () => {
  const fixture = await d3QuotaFixture("codex-d3-reuse-", [
    { observedAt: "2026-07-12T01:00:00.000Z", resetsAt: "2026-07-12T06:00:00.000Z", options: { usedPercent: 42.5 } },
  ]);
  const store = new UsageStore({ homeDir: fixture.homeDir, databaseFile: fixture.databaseFile });
  const reads = d3CountObservationReads(store);
  const asOf = "2026-07-12T02:00:00.000Z";
  try {
    await store.sync();
    const first = store.quotaObservations();
    assert.equal(reads.prepares, 1, "冷调用：恰好一次观测读取");
    assert.equal(first.length, 1);
    assert.deepEqual(Object.keys(first[0]).sort(), D3_OBSERVATION_KEYS, "规范映射的键就是那 10 个静态输入");
    assert.equal(store.quotaObservations(), first, "复用：**同一份**规范映射（同数组身份，不是重新映射）");
    assert.equal(reads.prepares, 1, "复用 ⇒ 零重读");

    const today = store.summarize({ preset: "today", bucket: "day", now: asOf });
    assert.equal(today.range.preset, "today");
    assert.equal(reads.prepares, 1, "非限额 summarize 也复用同一份映射");
    const quota = store.summarize({ preset: "quota_5h", bucket: "quota_30m", now: asOf });
    assert.equal(quota.quota.windows.quota_5h.state, "available");
    assert.equal(
      reads.prepares,
      1,
      "限额 summarize 的**两个**消费者（选窗口 + 逐范围记录）共用同一份映射（改前这一档是 +2）",
    );

    // 自身新观测 ⇒ D1 修订前进 ⇒ 立即失效 + 立即更新（不得绕过修订机制）。
    await appendFile(
      fixture.quotaFile,
      jsonl([
        quotaTokenRow("2026-07-12T05:00:00.000Z", "2026-07-12T10:00:00.000Z", { usedPercent: 61 }),
        tokenRow("2026-07-12T05:00:30.000Z", 12, 9, 0, 3, 0),
      ]),
    );
    await store.sync();
    const grown = store.quotaObservations();
    assert.equal(reads.prepares, 2, "新观测（自身提交）⇒ 重读一次");
    assert.equal(grown.length, 2, "映射内容随之更新");
    assert.equal(reads.prepares, 2, "更新后再次复用");
    const afterSelf = store.summarize({ preset: "quota_5h", bucket: "quota_30m", now: "2026-07-12T05:30:00.000Z" });
    assert.equal(afterSelf.quota.windows.quota_5h.usedPercent, 61, "新观测立即生效");

    // 外部提交（第二个连接）⇒ `PRAGMA data_version` 检出 ⇒ 立即更新（沿 D1，不自建 TTL）。
    const other = new DatabaseSync(fixture.databaseFile);
    try {
      other
        .prepare(
          `INSERT INTO rate_limit_observations (source_path, line_number, role, observed_at_ms, limit_id, limit_name,
             plan_type, window_minutes, resets_at_ms, used_percent)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          grown[0].sourcePath,
          99,
          "primary",
          Date.parse("2026-07-12T05:30:00.000Z"),
          "codex",
          null,
          null,
          300,
          Date.parse("2026-07-12T10:30:00.000Z"),
          77,
        );
    } finally {
      other.close();
    }
    const external = store.quotaObservations();
    assert.equal(reads.prepares, 3, "外部提交 ⇒ 检出后重读一次");
    assert.equal(external.length, 3, "外部行立即出现在规范映射里");
    const afterExternal = store.summarize({ preset: "quota_5h", bucket: "quota_30m", now: "2026-07-12T06:00:00.000Z" });
    assert.equal(afterExternal.quota.windows.quota_5h.usedPercent, 77, "外部提交立即生效");
    assert.equal(store.externalCommitCount > 0, true, "走的是 D1 的 data_version 路径");

    // 连接级状态：close/open 必须复位（storeRevision 跨 close/open 保留 ⇒ 只靠键不够）。
    store.close();
    await store.open();
    assert.equal(store.quotaObservations().length, 3);
    assert.equal(reads.prepares, 4, "close/open ⇒ 复位后重读一次");
  } finally {
    store.close();
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("D3 · 时钟推进（不改源）：同一份观测跨 reset / 过期给出不同值，缓存里没有时间派生字段", async () => {
  const fixture = await d3QuotaFixture("codex-d3-clock-", [
    { observedAt: "2026-07-12T01:00:00.000Z", resetsAt: "2026-07-12T06:00:00.000Z", options: { usedPercent: 42.5 } },
  ]);
  const store = new UsageStore({ homeDir: fixture.homeDir, databaseFile: fixture.databaseFile });
  const reads = d3CountObservationReads(store);
  const filters = (now) => ({ preset: "quota_5h", bucket: "quota_30m", now });
  try {
    await store.sync();
    const rowsBefore = JSON.stringify(store.quotaObservations());

    // ① 新鲜的 asOf（观测后 5 分钟，仍在窗口内）：可用且**不陈旧**。
    const fresh = store.summarize(filters("2026-07-12T01:05:00.000Z"));
    assert.equal(fresh.quota.windows.quota_5h.state, "available");
    assert.equal(fresh.quota.windows.quota_5h.percentStale, false, "① 观测新鲜 ⇒ percentStale=false");
    assert.equal(fresh.quota.windows.quota_5h.windowStart, "2026-07-12T01:00:00.000Z");
    assert.equal(fresh.quota.windows.quota_5h.windowEndExclusive, "2026-07-12T06:00:00.000Z");
    assert.equal(fresh.range.start, "2026-07-12T01:00:00.000Z");
    assert.equal(fresh.range.end, "2026-07-12T01:04:59.999Z", "① 范围末端 = min(asOf, 窗口末端) − 1ms");
    assert.equal(fresh.range.asOf, "2026-07-12T01:05:00.000Z");
    assert.equal(fresh.quota.windows.quota_week.state, "missing", "只有 5h 观测 ⇒ 周窗口 missing");

    // ② 只推进时钟（源一个字没改）：同一观测变**陈旧**。
    const stale = store.summarize(filters("2026-07-12T05:59:59.000Z"));
    assert.equal(stale.quota.windows.quota_5h.state, "available", "② 仍在同一窗口内 ⇒ 可用");
    assert.equal(
      stale.quota.windows.quota_5h.percentStale,
      true,
      "② 观测超阈值 ⇒ percentStale 翻真（时间派生字段没被冻住）",
    );
    assert.equal(stale.range.end, "2026-07-12T05:59:58.999Z", "② 范围末端随 asOf 前进");
    assert.equal(stale.quota.windows.quota_5h.observedAt, "2026-07-12T01:00:00.000Z", "② 观测时刻本身不变");

    // ③ 跨 reset：窗口不再"当前" ⇒ 契约是在解析范围时**直接拒绝**（`QUOTA_WINDOW_UNAVAILABLE`），
    //    理由随 asOf 现算。**反例探针**：若窗口（时间派生字段）被缓存，这里会静默返回旧 summary。
    for (const now of ["2026-07-12T06:00:00.000Z", "2026-07-12T07:30:00.000Z"]) {
      assert.throws(
        () => store.summarize(filters(now)),
        (error) => {
          assert.equal(error.code, "QUOTA_WINDOW_UNAVAILABLE");
          assert.equal(error.preset, "quota_5h");
          assert.equal(error.state, "waiting");
          assert.equal(error.quota.windows.quota_5h.state, "waiting");
          assert.equal(error.quota.windows.quota_5h.reason, "等待新的限额记录");
          assert.equal(error.quota.asOf, now);
          return true;
        },
        `③ ${now}：跨 reset 必须按该 asOf 判 waiting`,
      );
    }

    // 缓存里只有静态输入：四次时钟推进后规范行**逐字节不变**，键仍是那 10 个。
    assert.equal(reads.prepares, 1, "四次 summarize 全程只读一次观测（映射被复用）");
    assert.equal(JSON.stringify(store.quotaObservations()), rowsBefore, "缓存内容与时钟无关（逐字节相同）");
    assert.deepEqual(Object.keys(store.quotaObservations()[0]).sort(), D3_OBSERVATION_KEYS);
    const serialized = JSON.stringify(store.quotaObservationCache?.rows ?? []);
    for (const forbidden of ["windowStart", "windowEndExclusive", "percentStale", "state", "asOf", "countdown"]) {
      assert.equal(serialized.includes(forbidden), false, `缓存里不得出现时间派生字段 ${forbidden}`);
    }
  } finally {
    store.close();
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("D3 · 写事务门（D1 回滚语义）：写事务内不读也不写观测缓存", async () => {
  const fixture = await d3QuotaFixture("codex-d3-tx-", [
    { observedAt: "2026-07-12T01:00:00.000Z", resetsAt: "2026-07-12T06:00:00.000Z", options: { usedPercent: 42.5 } },
    { observedAt: "2026-07-12T02:00:00.000Z", resetsAt: "2026-07-12T07:00:00.000Z", options: { usedPercent: 55 } },
  ]);
  const store = new UsageStore({ homeDir: fixture.homeDir, databaseFile: fixture.databaseFile });
  const reads = d3CountObservationReads(store);
  try {
    await store.sync();
    const committed = store.quotaObservations();
    assert.equal(committed.length, 2);
    assert.equal(reads.prepares, 1);

    store.database.exec("BEGIN IMMEDIATE");
    try {
      store.database.exec(
        "DELETE FROM rate_limit_observations WHERE line_number = (SELECT MAX(line_number) FROM rate_limit_observations)",
      );
      store.writeTransactionDepth = 1;
      const uncommitted = store.quotaObservations();
      assert.equal(uncommitted.length, 1, "写事务内读到的是**未提交**状态（没有吃共享缓存）");
      assert.notEqual(uncommitted, committed, "事务内不得复用事务外的映射");
      assert.equal(store.quotaObservations() === uncommitted, false, "事务内每次现读（不读也不写）");
      assert.equal(reads.prepares, 3, "事务内两次读取 ⇒ 两次重读");
      assert.equal(store.quotaObservationCache?.rows?.length ?? null, 2, "事务内绝不改写共享缓存");
    } finally {
      store.database.exec("ROLLBACK");
      store.writeTransactionDepth = 0;
    }

    const afterRollback = store.quotaObservations();
    assert.equal(afterRollback.length, 2, "回滚后回到已提交状态");
    assert.equal(reads.prepares, 3, "回滚没有推进修订 ⇒ 事务外仍复用那份**未被污染**的缓存（零重读）");
    assert.equal(store.quotaObservationCache?.rows, afterRollback, "缓存自始至终指向已提交状态");
    assert.equal(store.quotaObservations(), afterRollback, "之后继续复用");
    assert.equal(reads.prepares, 3);
  } finally {
    store.close();
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("D3 · frozen 快照不被 live 新观测改写；同一 asOf 的读数在墙钟前进后仍然稳定", async () => {
  const fixture = await d3QuotaFixture("codex-d3-frozen-", [
    { observedAt: "2026-07-12T01:00:00.000Z", resetsAt: "2026-07-12T06:00:00.000Z", options: { usedPercent: 42.5 } },
  ]);
  const store = new UsageStore({ homeDir: fixture.homeDir, databaseFile: fixture.databaseFile });
  const snapshotFile = path.join(fixture.homeDir, "frozen-snapshot.sqlite");
  const asOf1 = "2026-07-12T02:00:00.000Z";
  let frozen = null;
  try {
    await store.sync();
    const paused = store.summarize({ preset: "quota_5h", bucket: "quota_30m", now: asOf1 });
    assert.equal(paused.quota.windows.quota_5h.usedPercent, 42.5);
    assert.equal(paused.range.asOf, asOf1);

    // 与 `src/server.js` 的 createSnapshot 同形：`backup()` 出的库 + 冻结的 asOf。
    await backup(store.database, snapshotFile);
    frozen = new UsageStore({ databaseFile: snapshotFile });
    await frozen.open();
    const frozenFirst = frozen.summarize({ preset: "quota_5h", bucket: "quota_30m", now: asOf1 });
    assert.deepEqual(frozenFirst.quota, paused.quota, "冻结快照与暂停时刻逐字一致");

    // live 侧出现**新观测**（自身提交）。
    await appendFile(
      fixture.quotaFile,
      jsonl([
        quotaTokenRow("2026-07-12T03:00:00.000Z", "2026-07-12T08:00:00.000Z", { usedPercent: 88 }),
        tokenRow("2026-07-12T03:00:30.000Z", 9, 7, 0, 2, 0),
      ]),
    );
    await store.sync();

    const live = store.summarize({ preset: "quota_5h", bucket: "quota_30m", now: "2026-07-12T03:30:00.000Z" });
    assert.equal(live.quota.windows.quota_5h.usedPercent, 88, "live 读数立即更新");
    assert.notEqual(live.quota.windows.quota_5h.windowEndExclusive, paused.quota.windows.quota_5h.windowEndExclusive);

    const frozenAgain = frozen.summarize({ preset: "quota_5h", bucket: "quota_30m", now: asOf1 });
    assert.deepEqual(frozenAgain.quota, paused.quota, "冻结快照**不被** live 新观测改写（它自己的库 + 自己的 asOf）");
    assert.equal(frozenAgain.range.asOf, asOf1, "冻结的 asOf 保持时刻（没有滑到“现在”）");

    // 暂停/恢复的时刻语义：同一 asOf 反复读稳定；推进到新 asOf 才变。
    const repeated = store.summarize({ preset: "quota_5h", bucket: "quota_30m", now: asOf1 });
    assert.deepEqual(
      repeated.quota.windows.quota_5h,
      frozenFirst.quota.windows.quota_5h,
      "同一 asOf ⇒ 同一时刻语义（暂停保持）",
    );
    const resumed = store.summarize({ preset: "quota_5h", bucket: "quota_30m", now: "2026-07-12T04:00:00.000Z" });
    assert.equal(resumed.quota.windows.quota_5h.percentStale, true, "恢复后按新的 asOf 重新判 stale");
    assert.equal(resumed.range.asOf, "2026-07-12T04:00:00.000Z", "恢复后 asOf 前进");
  } finally {
    frozen?.close();
    store.close();
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

// ── D4 · metadata 观测聚合复用（**只缓存静态输入**）+ periodComparison 命中仍新鲜 ────────────────
//
// 判别力要点：
//   * "复用"的机械证据 = `metadata()` 里那条**未过滤**分组语句被 `prepare` 的次数（稳态：1 → 0），
//     以及 C5 静态块的三条语句在同一轮 no-op sync 之后**不再执行**（"未被回退"的计数证据）；
//   * "未来事件过滤不被缓存吃掉" = 同一份数据、**只推进 `asOf`** ⇒ 某个模型由"未来"变为"非未来"
//     （出现/消失 + `lastSeen` 具体值变化），且该路径**每次现算**（计数每次都增长）；
//   * "命中仍新鲜" = 命中路径返回的 `asOf` 必须是**本次请求**的时刻，静态部分逐字不变。

const D4_UNFILTERED_SIGNATURE = "FROM events GROUP BY channel, model, home_id";
const D4_FILTERED_SIGNATURE = "FROM events WHERE timestamp_ms <= ? GROUP BY channel, model, home_id";
const D4_STATIC_BLOCK_SIGNATURES = [
  "COUNT(DISTINCT session_id) AS session_count FROM events",
  "SELECT home_id, COUNT(*) AS event_count, COUNT(DISTINCT session_id) AS session_count",
  "SELECT DISTINCT channel, model FROM events",
];

/** `metadata()` 的未过滤/过滤分组语句 + C5 静态块三条语句各被 `prepare` 了几次。 */
function d4CountQueries(store) {
  const counter = { unfiltered: 0, filtered: 0, staticBlock: 0, total: 0 };
  let current = null;
  const wrap = (database) => {
    if (!database) return database;
    const original = database.prepare.bind(database);
    database.prepare = (sql) => {
      if (typeof sql === "string") {
        const normalized = sql.replace(/\s+/g, " ").trim();
        counter.total += 1;
        if (normalized.includes(D4_FILTERED_SIGNATURE)) counter.filtered += 1;
        else if (normalized.includes(D4_UNFILTERED_SIGNATURE)) counter.unfiltered += 1;
        if (D4_STATIC_BLOCK_SIGNATURES.some((signature) => normalized.includes(signature))) counter.staticBlock += 1;
      }
      return original(sql);
    };
    return database;
  };
  Object.defineProperty(store, "database", {
    configurable: true,
    get: () => current,
    set: (value) => {
      current = value === null ? null : wrap(value);
    },
  });
  current = wrap(store.database);
  counter.reset = () => {
    counter.unfiltered = 0;
    counter.filtered = 0;
    counter.staticBlock = 0;
    counter.total = 0;
  };
  return counter;
}

/** D4 夹具：`.codex/sessions/2026/07/12/rollout.jsonl`，两个模型、跨日、含一条"未来"事件。 */
async function d4Fixture(prefix) {
  const homeDir = await mkdtemp(path.join(tmpdir(), prefix));
  const sessionsDir = path.join(homeDir, ".codex", "sessions", "2026", "07", "12");
  await mkdir(sessionsDir, { recursive: true });
  const sessionFile = path.join(sessionsDir, "rollout.jsonl");
  const databaseFile = path.join(homeDir, ".codex-usage", "usage-index.sqlite");
  await writeFile(
    sessionFile,
    jsonl([
      {
        timestamp: "2026-07-11T09:00:00.000Z",
        type: "session_meta",
        payload: { id: `${prefix}session`, source: "cli", originator: "codex-tui", cwd: "/work/d4" },
      },
      { type: "turn_context", payload: { model: "gpt-6-sol" } },
      tokenRow("2026-07-11T09:00:30.000Z", 100, 80, 0, 20, 0),
      tokenRow("2026-07-12T05:00:00.000Z", 120, 96, 0, 24, 0),
      { type: "turn_context", payload: { model: "gpt-6-mini" } },
      tokenRow("2026-07-12T07:00:00.000Z", 160, 128, 0, 32, 0),
    ]),
  );
  return { homeDir, sessionsDir, sessionFile, databaseFile };
}

test("D4 · 观测聚合复用：稳态 0 次查询；C5 静态块在无变化轮次零重算（未回退）", async () => {
  const fixture = await d4Fixture("codex-d4-reuse-");
  const store = new UsageStore({ homeDir: fixture.homeDir, databaseFile: fixture.databaseFile });
  const counts = d4CountQueries(store);
  const asOf = "2026-07-12T09:00:00.000Z"; // ≥ 全表最大 07:00Z ⇒ 不存在未来事件
  try {
    await store.open();
    await store.sync();
    counts.reset();
    const cold = store.metadata(new Date(asOf));
    assert.equal(counts.unfiltered, 1, "冷调用：一次未过滤分组（静态输入入缓存）");
    assert.equal(counts.filtered, 0, "无未来事件 ⇒ 不需要按 asOf 现算");
    assert.equal(counts.staticBlock, 3, "冷调用重建 C5 静态块（三条语句）");

    counts.reset();
    const warm = store.metadata(new Date(asOf));
    assert.equal(counts.unfiltered, 0, "稳态：观测聚合零重算");
    assert.equal(counts.filtered, 0, "稳态：没有按 asOf 的现算");
    assert.equal(counts.staticBlock, 0, "C5 静态块零重算（本卡没有回退它）");
    assert.deepEqual(warm, cold, "同一 asOf 的读数逐字相同");
    assert.equal(store.metadataObservationCache.revision, store.storeRevision, "缓存键 = D1 修订");
    assert.deepEqual(
      Object.keys(store.metadataObservationCache.rows[0]).sort(),
      ["channel", "home_id", "last_seen", "model"],
      "缓存里只有**静态输入**（events 原始行），没有任何时间派生字段",
    );
    assert.equal(store.metadataObservationCache.maxTimestampMs, Date.parse("2026-07-12T07:00:00.000Z"));

    // 改数据（自身提交 + sync）⇒ 按**实际变更**失效。
    await appendFile(
      fixture.sessionFile,
      jsonl([
        { type: "turn_context", payload: { model: "gpt-6-sol" } },
        tokenRow("2026-07-12T08:00:00.000Z", 200, 160, 0, 40, 0),
      ]),
    );
    await store.sync();
    counts.reset();
    const grown = store.metadata(new Date(asOf));
    assert.equal(counts.unfiltered, 1, "新事件 ⇒ 观测聚合按实际变更重算一次");
    assert.equal(counts.staticBlock, 3, "新事件 ⇒ C5 静态块一并重建");
    assert.equal(grown.eventCount, cold.eventCount + 1, "身份读数随之更新");
    assert.equal(grown.modelLastSeen.Codex["gpt-6-sol"], Date.parse("2026-07-12T08:00:00.000Z"));

    counts.reset();
    store.metadata(new Date(asOf));
    assert.equal(counts.unfiltered + counts.filtered + counts.staticBlock, 0, "再次稳态：全零重算");
  } finally {
    store.close();
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("D4 · 未来事件不被缓存吃掉：只推进 asOf ⇒ 同一份数据的读数由未来变非未来", async () => {
  const fixture = await d4Fixture("codex-d4-future-");
  const store = new UsageStore({ homeDir: fixture.homeDir, databaseFile: fixture.databaseFile });
  const counts = d4CountQueries(store);
  const early = "2026-07-12T06:00:00.000Z"; // < 07:00Z ⇒ gpt-6-mini 那条是"未来事件"
  const late = "2026-07-12T08:00:00.000Z"; // ≥ 07:00Z ⇒ 不再有未来事件
  try {
    await store.open();
    await store.sync();
    counts.reset();
    const before = store.metadata(new Date(early));
    assert.equal(counts.unfiltered, 1, "冷调用先取静态输入（未过滤分组）");
    assert.equal(counts.filtered, 1, "有未来事件 ⇒ 必须按当前 asOf 现算一次");
    assert.equal(before.modelLastSeen.Codex["gpt-6-sol"], Date.parse("2026-07-12T05:00:00.000Z"), "≤ asOf 的 MAX");
    assert.equal(Object.hasOwn(before.modelLastSeen.Codex, "gpt-6-mini"), false, "只有未来事件的模型不得出现");
    assert.deepEqual(before.activeHarnessModels.Codex, ["gpt-6-sol"]);

    counts.reset();
    const beforeAgain = store.metadata(new Date(early));
    assert.equal(counts.filtered, 1, "同一 asOf 仍**每次现算**（不是把上一次结果缓存住）");
    assert.deepEqual(beforeAgain.modelLastSeen, before.modelLastSeen);

    counts.reset();
    const after = store.metadata(new Date(late));
    assert.equal(counts.filtered, 0, "无未来事件 ⇒ 过滤是恒等 ⇒ 复用静态输入（0 次现算）");
    assert.equal(counts.unfiltered, 0, "静态输入未变 ⇒ 零重读");
    assert.equal(
      after.modelLastSeen.Codex["gpt-6-mini"],
      Date.parse("2026-07-12T07:00:00.000Z"),
      "推进 asOf ⇒ 原本的未来事件按语义计入",
    );
    assert.deepEqual(after.activeHarnessModels.Codex, ["gpt-6-mini", "gpt-6-sol"]);

    counts.reset();
    const back = store.metadata(new Date(early));
    assert.equal(counts.filtered, 1, "退回更早的 asOf ⇒ 再次按当前 asOf 现算");
    assert.equal(Object.hasOwn(back.modelLastSeen.Codex, "gpt-6-mini"), false, "快路径不得把晚 asOf 的结果留成缓存");
    assert.deepEqual(back.modelLastSeen, before.modelLastSeen);
  } finally {
    store.close();
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("D4 · periodComparison 命中仍新鲜：asOf 是本次请求时刻；跨日/跨周/跨月/排除键各自变化", async () => {
  const fixture = await d4Fixture("codex-d4-period-");
  const store = new UsageStore({ homeDir: fixture.homeDir, databaseFile: fixture.databaseFile });
  const counts = d4CountQueries(store);
  const t1 = "2026-07-12T00:00:00.000Z";
  const t2 = "2026-07-12T06:00:00.000Z"; // 同一 UTC 日、同一本地日（+08:00 08:00 → 14:00）
  try {
    await store.open();
    await store.sync();
    counts.reset();
    const miss = store.periodComparison({ now: t1 });
    const missPreparations = counts.total;
    assert.equal(miss.asOf, new Date(t1).toISOString());
    assert.ok(missPreparations >= 2, `冷命中：至少做一次范围聚合（实测 ${missPreparations} 条语句）`);

    counts.reset();
    const hit = store.periodComparison({ now: t2 });
    assert.equal(hit.asOf, new Date(t2).toISOString(), "命中路径的 asOf 必须是**本次请求**的时刻");
    assert.notEqual(hit.asOf, miss.asOf, "asOf 跟着本次请求前进（不是缓存时刻）");
    assert.deepEqual(hit.periods, miss.periods, "同一自然日 ⇒ 日历边界（静态部分）逐字一致");
    assert.deepEqual(hit.totals, miss.totals, "合计同样逐字复用（日历边界不含 now）");
    assert.deepEqual(hit.models, miss.models);
    assert.equal(counts.total, 1, "命中 ⇒ 只剩 1 条连接级语句（PRAGMA data_version）");

    // 跨日 ⇒ 日历边界与命中键都变。
    counts.reset();
    const nextDay = store.periodComparison({ now: "2026-07-13T06:00:00.000Z" });
    assert.notDeepEqual(nextDay.periods, miss.periods, "跨日 ⇒ 日历日边界变化");
    assert.ok(counts.total >= 2, `跨日 ⇒ 未命中（实测 ${counts.total} 条语句）`);
    const nextDayUtc = store.periodComparison({ now: "2026-07-13T06:00:00.000Z", calendarZone: "utc" });
    assert.equal(
      nextDayUtc.periods.find((period) => period.key === "today").start,
      "2026-07-13T00:00:00.000Z",
      "跨日 ⇒ 日历日起点前进（utc 钉死，不依赖宿主机时区）",
    );

    // 跨周 / 跨月：用 utc 把自然周期钉死，避免依赖宿主机时区。
    const weekStart = (value) => value.periods.find((period) => period.key === "week")?.start;
    const monthStart = (value) => value.periods.find((period) => period.key === "month")?.start;
    const week1 = store.periodComparison({ now: t2, calendarZone: "utc" });
    const week2 = store.periodComparison({ now: "2026-07-20T06:00:00.000Z", calendarZone: "utc" });
    assert.notEqual(weekStart(week2), weekStart(week1), "跨周 ⇒ 周起点变化");
    const month1 = store.periodComparison({ now: t2, calendarZone: "utc" });
    const month2 = store.periodComparison({ now: "2026-08-12T06:00:00.000Z", calendarZone: "utc" });
    assert.notEqual(monthStart(month2), monthStart(month1), "跨月 ⇒ 月起点变化");

    // 排除键：不同 excludeHomes ⇒ 不同命中键 ⇒ 重新聚合且结果不同。
    const homeId = store.homes[0].id;
    counts.reset();
    const excluded = store.periodComparison({ now: t2, excludeHomes: [homeId] });
    assert.ok(counts.total >= 2, "排除键变化 ⇒ 未命中（重新聚合）");
    assert.notDeepEqual(excluded.totals, miss.totals, "排除键必须生效");
    assert.equal(excluded.asOf, new Date(t2).toISOString(), "未命中路径的 asOf 同样是本次请求时刻");
  } finally {
    store.close();
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("D4 · metadata 的 warnings 按自身语义更新（静态缓存保留但警告不被冻结）", async () => {
  const fixture = await d4Fixture("codex-d4-warnings-");
  const store = new UsageStore({ homeDir: fixture.homeDir, databaseFile: fixture.databaseFile });
  const counts = d4CountQueries(store);
  const asOf = "2026-07-12T09:00:00.000Z";
  try {
    await store.open();
    await store.sync();
    const cold = store.metadata(new Date(asOf));
    assert.equal(cold.eventCount, 3);
    assert.deepEqual(cold.warnings, []);

    // 一轮**无用量变化**的 sync：只剩警告变化 ⇒ 昂贵的静态块必须保留，但 warnings 必须刷新。
    const realUsageFiles = store.usageFiles;
    store.usageFiles = async (homes) => ({
      files: [],
      warnings: ["D4 simulated source scan warning"],
      failedHomes: homes.map(({ id, path: homePath }) => ({ id, path: homePath })),
    });
    await store.sync();
    counts.reset();
    const warned = store.metadata(new Date(asOf));
    assert.match(store.warnings[0], /D4 simulated source scan warning/);
    assert.match(warned.warnings[0], /D4 simulated source scan warning/, "warnings 按自身语义更新（没有被缓存冻结）");
    assert.equal(warned.eventCount, cold.eventCount, "静态聚合被保留（无用量变化）");
    assert.equal(counts.staticBlock, 0, "保留轮次零重建（计数证据）");
    assert.ok(
      new Date(warned.generatedAt).getTime() >= new Date(cold.generatedAt).getTime(),
      "generatedAt 同样按自身语义刷新",
    );

    // 恢复真实扫描 ⇒ 警告消失，同样零重建（两个方向都按语义更新）。
    store.usageFiles = realUsageFiles;
    await store.sync();
    counts.reset();
    const clear = store.metadata(new Date(asOf));
    assert.deepEqual(store.warnings, []);
    assert.deepEqual(clear.warnings, [], "警告消失同样立即反映");
    assert.equal(clear.eventCount, cold.eventCount);
    assert.equal(counts.staticBlock, 0, "恢复轮次同样零重建");
  } finally {
    store.close();
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("D4 · 冻结快照 vs live：metadata/periodComparison 缓存不共享，冻结不被 live 改写", async () => {
  const fixture = await d4Fixture("codex-d4-frozen-");
  const store = new UsageStore({ homeDir: fixture.homeDir, databaseFile: fixture.databaseFile });
  const snapshotFile = path.join(fixture.homeDir, "d4-frozen-snapshot.sqlite");
  const asOf = "2026-07-12T09:00:00.000Z";
  let frozen = null;
  try {
    await store.sync();
    const liveFirst = store.metadata(new Date(asOf));
    const comparisonFirst = store.periodComparison({ now: asOf });

    // 与 `src/server.js` 的 createSnapshot 同形：`backup()` 出的库 + 冻结实例自持 homes/evidence/warnings。
    await backup(store.database, snapshotFile);
    frozen = new UsageStore({ databaseFile: snapshotFile });
    await frozen.open();
    frozen.homes = structuredClone(store.homes);
    frozen.serviceTierEvidence = store.serviceTierEvidence;
    frozen.warnings = [...store.warnings];
    assert.deepEqual(frozen.metadata(new Date(asOf)), liveFirst, "冻结快照的 metadata 与冻结时刻逐字一致");
    assert.deepEqual(
      frozen.periodComparison({ now: asOf }),
      comparisonFirst,
      "冻结快照的 periodComparison 与冻结时刻逐字一致",
    );

    // live 侧出现新数据（自身提交）⇒ live 立即更新（缓存按实际变更失效），冻结侧逐字不变。
    await appendFile(
      fixture.sessionFile,
      jsonl([
        { type: "turn_context", payload: { model: "gpt-6-sol" } },
        tokenRow("2026-07-12T08:30:00.000Z", 300, 240, 0, 60, 0),
      ]),
    );
    await store.sync();
    const liveSecond = store.metadata(new Date(asOf));
    const comparisonSecond = store.periodComparison({ now: asOf });
    assert.equal(liveSecond.eventCount, liveFirst.eventCount + 1, "live 立即纳入新事件");
    assert.ok(
      comparisonSecond.totals.today.total > comparisonFirst.totals.today.total,
      "live 的合计随新数据增长（周期缓存按实际变更失效、不是按键冻结）",
    );
    assert.deepEqual(frozen.metadata(new Date(asOf)), liveFirst, "冻结快照不被 live 改写（自己的库 + 自己的缓存）");
    assert.deepEqual(frozen.periodComparison({ now: asOf }), comparisonFirst);
  } finally {
    frozen?.close();
    store.close();
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("D4 · 写事务门（D1 回滚语义）：写事务内不读也不写观测聚合缓存", async () => {
  const fixture = await d4Fixture("codex-d4-tx-");
  const store = new UsageStore({ homeDir: fixture.homeDir, databaseFile: fixture.databaseFile });
  const counts = d4CountQueries(store);
  const asOf = "2026-07-12T09:00:00.000Z"; // 无未来事件 ⇒ 事务外走快路径（0 次观测查询）
  try {
    await store.sync();
    const committed = store.metadata(new Date(asOf));
    assert.equal(committed.eventCount, 3);
    assert.equal(committed.modelLastSeen.Codex["gpt-6-mini"], Date.parse("2026-07-12T07:00:00.000Z"));
    /** 缓存里的行数 = `(channel, model, home_id)` 分组数（**不是**事件数）。 */
    const cachedGroups = store.metadataObservationCache.rows.length;

    counts.reset();
    store.metadata(new Date(asOf));
    assert.equal(counts.unfiltered + counts.filtered, 0, "事务外：稳态复用（0 次观测查询）");

    store.database.exec("BEGIN IMMEDIATE");
    try {
      store.database.exec("DELETE FROM events WHERE rowid = (SELECT MAX(rowid) FROM events)");
      store.writeTransactionDepth = 1;
      counts.reset();
      const uncommitted = store.metadata(new Date(asOf));
      assert.equal(
        Object.hasOwn(uncommitted.modelLastSeen.Codex, "gpt-6-mini"),
        false,
        "写事务内观测按**未提交**状态现算（没有吃共享缓存）",
      );
      assert.equal(counts.filtered, 1, "写事务内按当前 asOf 现读");
      assert.equal(store.metadataObservationCache.rows.length, cachedGroups, "事务内绝不改写共享缓存");

      counts.reset();
      store.metadata(new Date(asOf));
      assert.equal(counts.filtered, 1, "事务内每次现读（不读也不写）");
      assert.equal(store.metadataObservationCache.rows.length, cachedGroups);
    } finally {
      store.database.exec("ROLLBACK");
      store.writeTransactionDepth = 0;
    }

    counts.reset();
    const afterRollback = store.metadata(new Date(asOf));
    assert.equal(afterRollback.eventCount, 3, "回滚后回到已提交状态");
    assert.equal(
      afterRollback.modelLastSeen.Codex["gpt-6-mini"],
      Date.parse("2026-07-12T07:00:00.000Z"),
      "回滚后观测恢复（缓存自始至终指向已提交状态）",
    );
    assert.equal(counts.unfiltered + counts.filtered, 0, "回滚没有推进修订 ⇒ 事务外继续复用未被污染的缓存");
    assert.equal(store.metadataObservationCache.rows.length, cachedGroups);
  } finally {
    store.close();
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("D4 · 改来源（新增来源目录）：身份/模型集合按自身语义更新，静态块按实际变更重建", async () => {
  const fixture = await d4Fixture("codex-d4-source-");
  const store = new UsageStore({ homeDir: fixture.homeDir, databaseFile: fixture.databaseFile });
  const counts = d4CountQueries(store);
  const asOf = "2026-07-12T09:00:00.000Z";
  try {
    await store.sync();
    const before = store.metadata(new Date(asOf));
    assert.equal(before.eventCount, 3);
    assert.equal(before.homes.length, 1);
    counts.reset();
    store.metadata(new Date(asOf));
    assert.equal(counts.staticBlock, 0, "稳态：C5 静态块零重算");

    // 运行期**新增一个来源**（第二个 Codex home，经 `options.extraHomes` 注入）⇒ home 集合形状变化
    // （`homeSetChanged`）⇒ 静态块必须按**实际变更**重建（不是每轮都算，也不是永不算）。
    const extraHome = path.join(fixture.homeDir, "extra-codex-home");
    const extraSessions = path.join(extraHome, "sessions", "2026", "07", "12");
    await mkdir(extraSessions, { recursive: true });
    await writeFile(
      path.join(extraSessions, "rollout.jsonl"),
      jsonl([
        {
          timestamp: "2026-07-12T06:00:00.000Z",
          type: "session_meta",
          payload: { id: "d4-extra-source", source: "cli", originator: "codex-tui", cwd: "/work/extra" },
        },
        { type: "turn_context", payload: { model: "gpt-6-sol" } },
        tokenRow("2026-07-12T06:30:00.000Z", 60, 50, 0, 10, 0),
      ]),
    );
    await store.sync({ options: { ...store.options, extraHomes: extraHome } });
    counts.reset();
    const after = store.metadata(new Date(asOf));
    assert.equal(counts.staticBlock, 3, "改来源 ⇒ C5 静态块按实际变更重建");
    assert.equal(after.eventCount, before.eventCount + 1, "新来源的事件立即计入");
    assert.equal(after.homes.length, before.homes.length + 1, "身份（home 集合）立即多出一个来源");
    assert.equal(after.homeCount, before.homeCount + 1);
    assert.ok(
      after.homes.some((home) => home.path === extraHome),
      "新来源以自身身份（path）出现在读数里",
    );

    counts.reset();
    store.metadata(new Date(asOf));
    assert.equal(counts.staticBlock, 0, "再次稳态：零重算");
  } finally {
    store.close();
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});
