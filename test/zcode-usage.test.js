import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { LONG_CONTEXT_INPUT_THRESHOLD } from "../src/pricing.js";
import { UsageStore } from "../src/usage-store.js";
import {
  buildUsageReport,
  classifyImportDirectory,
  discoverUsageSources,
} from "../src/usage-core.js";
import { streamZcodeDbEvents, zcodeDatabaseFile, zcodeSourceStat } from "../src/zcode-usage.js";

const ZCODE_SCHEMA = `
  CREATE TABLE session (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    directory TEXT,
    path TEXT,
    title TEXT
  );
  CREATE TABLE model_usage (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    turn_id TEXT,
    query_source TEXT,
    task_type TEXT,
    provider_id TEXT,
    model_id TEXT,
    variant TEXT,
    agent TEXT,
    mode TEXT,
    status TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    reasoning_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    provider_total_tokens INTEGER,
    computed_total_tokens INTEGER
  );
`;

function usageRow(overrides = {}) {
  return {
    id: "usage_model_main_turn_msg_test_0",
    session_id: "sess_main",
    turn_id: "turn_test",
    query_source: "main_turn",
    task_type: "interactive",
    provider_id: "test-provider",
    model_id: "test-model",
    variant: "enabled",
    agent: "zcode-agent",
    mode: "build",
    status: "completed",
    started_at: Date.parse("2026-09-20T10:00:00.000Z"),
    completed_at: Date.parse("2026-09-20T10:00:05.000Z"),
    input_tokens: 100,
    output_tokens: 20,
    reasoning_tokens: 5,
    cache_creation_input_tokens: 10,
    cache_read_input_tokens: 40,
    provider_total_tokens: 120,
    computed_total_tokens: 120,
    ...overrides,
  };
}

function insertZcodeRows(dbFile, { sessions = [], usageRows = [] }) {
  const db = new DatabaseSync(dbFile);
  try {
    for (const session of sessions) {
      db.prepare("INSERT INTO session (id, parent_id, directory, path, title) VALUES (?, ?, ?, ?, ?)").run(
        session.id,
        session.parent_id ?? null,
        session.directory ?? null,
        session.path ?? null,
        session.title ?? null,
      );
    }
    for (const row of usageRows) {
      db.prepare(`
        INSERT INTO model_usage (
          id, session_id, turn_id, query_source, task_type, provider_id, model_id, variant, agent, mode, status,
          started_at, completed_at, input_tokens, output_tokens, reasoning_tokens,
          cache_creation_input_tokens, cache_read_input_tokens, provider_total_tokens, computed_total_tokens
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id, row.session_id, row.turn_id, row.query_source, row.task_type, row.provider_id, row.model_id,
        row.variant, row.agent, row.mode, row.status, row.started_at, row.completed_at,
        row.input_tokens, row.output_tokens, row.reasoning_tokens,
        row.cache_creation_input_tokens, row.cache_read_input_tokens, row.provider_total_tokens, row.computed_total_tokens,
      );
    }
  } finally {
    db.close();
  }
}

async function makeZcodeHome({ sessions = [], usageRows = [], createSchema = true } = {}) {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-usage-zcode-"));
  const dbDir = path.join(homeDir, ".zcode", "cli", "db");
  await mkdir(dbDir, { recursive: true });
  const dbFile = path.join(dbDir, "db.sqlite");
  const db = new DatabaseSync(dbFile);
  if (createSchema) {
    db.exec(ZCODE_SCHEMA);
  } else {
    db.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
  }
  db.close();
  if (sessions.length || usageRows.length) {
    insertZcodeRows(dbFile, { sessions, usageRows });
  }
  return { homeDir, dbFile };
}

test("discoverUsageSources 同时发现 Codex 与 ZCode home，并可整体关闭 ZCode", async () => {
  const { homeDir, dbFile } = await makeZcodeHome();
  await mkdir(path.join(homeDir, ".codex", "sessions"), { recursive: true });

  const sources = await discoverUsageSources({ homeDir, env: {} });
  const zcodeSource = sources.find((source) => source.kind === "zcode");
  assert.deepEqual(sources.map((source) => source.label), ["Main Codex", "Main ZCode"]);
  assert.equal(zcodeSource.path, path.join(homeDir, ".zcode"));
  assert.equal(zcodeSource.usageLogPath, dbFile);

  const disabled = await discoverUsageSources({ homeDir, env: { CODEX_USAGE_ZCODE: "0" } });
  assert.deepEqual(disabled.map((source) => source.label), ["Main Codex"]);

  const extraHome = await makeZcodeHome();
  const withExtra = await discoverUsageSources({
    homeDir,
    env: { CODEX_USAGE_ZCODE_HOMES: path.join(extraHome.homeDir, ".zcode") },
  });
  assert.ok(withExtra.some((source) => source.path === path.join(extraHome.homeDir, ".zcode")));
});

test("zcodeDatabaseFile 探测 ZCode 数据库位置", async () => {
  const { homeDir, dbFile } = await makeZcodeHome();
  assert.equal(await zcodeDatabaseFile(path.join(homeDir, ".zcode")), dbFile);
  assert.equal(await zcodeDatabaseFile(path.join(homeDir, "missing")), "");
});

test("classifyImportDirectory 识别 ZCode home", async () => {
  const { homeDir, dbFile } = await makeZcodeHome();

  const classified = await classifyImportDirectory(path.join(homeDir, ".zcode"));

  assert.equal(classified.type, "zcode-home");
  assert.equal(classified.path, path.join(homeDir, ".zcode"));
  assert.equal(classified.dbFile, dbFile);
});

test("zcodeSourceStat 把 WAL 文件计入增量检测", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-usage-zcode-stat-"));
  const dbFile = path.join(root, "db.sqlite");
  await writeFile(dbFile, "main");
  const first = await zcodeSourceStat(dbFile);
  await writeFile(`${dbFile}-wal`, "wal-content");
  const second = await zcodeSourceStat(dbFile);

  assert.equal(second.size, first.size + "wal-content".length);
  assert.ok(second.mtimeMs >= first.mtimeMs);
});

test("streamZcodeDbEvents 映射 token 明细、渠道与长上下文", async () => {
  const longInput = LONG_CONTEXT_INPUT_THRESHOLD + 1;
  const { homeDir, dbFile } = await makeZcodeHome({
    sessions: [{ id: "sess_main", directory: "/work/zproj", path: "/work/zproj", title: "重构看板" }],
    usageRows: [usageRow({ input_tokens: longInput, cache_read_input_tokens: 0, computed_total_tokens: longInput + 20, provider_total_tokens: longInput + 20 })],
  });
  const source = {
    id: "zcode-test",
    label: "Main ZCode",
    path: path.join(homeDir, ".zcode"),
    kind: "zcode",
    usageLogPath: dbFile,
  };
  const events = [];
  await streamZcodeDbEvents(dbFile, source, (event) => {
    events.push(event);
  });

  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.channel, "ZCode");
  assert.equal(event.source, "zcode");
  assert.equal(event.model, "test-model");
  assert.equal(event.modelProvider, "test-provider");
  assert.equal(event.conversationName, "重构看板");
  assert.equal(event.project, "/work/zproj");
  assert.equal(event.repositoryKey, "directory:/work/zproj");
  assert.equal(event.timestampMs, Date.parse("2026-09-20T10:00:05.000Z"));
  assert.deepEqual(event.usage, { total: longInput + 20, input: longInput, cached: 0, output: 20, reasoning: 5 });
  assert.equal(event.detailMask, 15);
  assert.equal(event.requestInputTokens, longInput);
  assert.equal(event.contextLevel, "long");
  assert.equal(event.cacheWriteTokens, 10);
  assert.equal(event.cacheWriteKnown, true);
  assert.equal(event.serviceTier, "unknown");
});

test("UsageStore 索引 ZCode 用量并按会话目录归组仓库", async () => {
  const { homeDir, dbFile } = await makeZcodeHome({
    sessions: [
      { id: "sess_main", directory: "/work/zproj", path: "/work/zproj", title: "重构看板" },
      { id: "sess_sub", parent_id: "sess_main", directory: "", path: "", title: "子任务" },
    ],
    usageRows: [
      usageRow(),
      usageRow({
        id: "usage_model_subagent_msg_test_1",
        session_id: "sess_sub",
        query_source: "subagent",
        task_type: "subagent_child",
        model_id: "other-model",
        input_tokens: 60,
        output_tokens: 10,
        reasoning_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 20,
        provider_total_tokens: 70,
        computed_total_tokens: 70,
      }),
      usageRow({
        id: "usage_model_main_turn_msg_test_2",
        status: "cancelled",
        input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        provider_total_tokens: null,
        computed_total_tokens: 0,
      }),
    ],
  });
  const store = new UsageStore({ homeDir, databaseFile: path.join(homeDir, "usage-index.sqlite") });

  try {
    await store.sync();
    const metadata = store.metadata();
    const summary = store.summarize({ preset: "all", bucket: "day" });

    assert.equal(metadata.eventCount, 2);
    assert.equal(metadata.sessionCount, 2);
    assert.deepEqual(summary.totals, { total: 190, input: 160, cached: 60, output: 30, reasoning: 5 });
    assert.deepEqual(
      summary.channels.map((channel) => [channel.name, channel.total.total]),
      [["ZCode", 120], ["ZCode Subagent", 70]],
    );
    assert.deepEqual(
      summary.models.map((model) => [model.name, model.total.total]).sort(),
      [["other-model", 70], ["test-model", 120]],
    );
    assert.equal(summary.repositories.length, 1);
    assert.equal(summary.repositories[0].key, "directory:/work/zproj");
    assert.equal(summary.repositories[0].total.total, 190);
    assert.equal(summary.repositories[0].sessions, 2);
    assert.deepEqual(metadata.harnessModels, { Codex: [], ZCode: ["other-model", "test-model"] });
  } finally {
    store.close();
  }
});

test("UsageStore 只在 ZCode 数据库变化后重建", async () => {
  const { homeDir, dbFile } = await makeZcodeHome({
    sessions: [{ id: "sess_main", directory: "/work/zproj", path: "/work/zproj", title: "重构看板" }],
    usageRows: [usageRow()],
  });
  const store = new UsageStore({ homeDir, databaseFile: path.join(homeDir, "usage-index.sqlite") });

  try {
    const first = await store.sync();
    const unchanged = await store.sync();
    assert.equal(first.updatedFileCount, 1);
    assert.equal(unchanged.updatedFileCount, 0);

    insertZcodeRows(dbFile, {
      usageRows: [usageRow({ id: "usage_model_main_turn_msg_test_3", completed_at: Date.parse("2026-09-20T11:00:00.000Z") })],
    });
    const refreshed = await store.sync();
    assert.equal(refreshed.updatedFileCount, 1);
    assert.equal(store.metadata().eventCount, 2);
  } finally {
    store.close();
  }
});

test("buildUsageReport 汇总 ZCode 会话与事件", async () => {
  const { homeDir, dbFile } = await makeZcodeHome({
    sessions: [{ id: "sess_main", directory: "/work/zproj", path: "/work/zproj", title: "重构看板" }],
    usageRows: [
      usageRow(),
      usageRow({
        id: "usage_model_main_turn_msg_test_4",
        completed_at: Date.parse("2026-09-20T11:00:00.000Z"),
      }),
    ],
  });

  const report = await buildUsageReport({ homeDir, env: {} });

  assert.deepEqual(report.homes.map((home) => home.label), ["Main ZCode"]);
  assert.equal(report.sessions.length, 1);
  const session = report.sessions[0];
  assert.equal(session.id, "sess_main");
  assert.equal(session.conversationName, "重构看板");
  assert.equal(session.eventCount, 2);
  assert.equal(session.total.total, 240);
  assert.equal(session.firstAt, "2026-09-20T10:00:05.000Z");
  assert.equal(session.lastAt, "2026-09-20T11:00:00.000Z");
  assert.equal(report.events.length, 2);
  assert.equal(report.events[0].channel, "ZCode");
  assert.equal(report.events[0].total.total, 120);
});

test("ZCode 数据库异常时仅记录警告，不影响 Codex 用量", async () => {
  const { homeDir } = await makeZcodeHome({ createSchema: false });
  const sessionDir = path.join(homeDir, ".codex", "sessions", "2026", "09", "20");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(sessionDir, "rollout.jsonl"),
    [
      {
        timestamp: "2026-09-20T01:00:00.000Z",
        type: "session_meta",
        payload: { id: "codex-session", source: "cli", originator: "codex-tui", cwd: "/work/codex" },
      },
      { type: "turn_context", payload: { model: "gpt-6-sol" } },
      {
        timestamp: "2026-09-20T01:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              total_tokens: 123,
              input_tokens: 100,
              cached_input_tokens: 20,
              output_tokens: 23,
              reasoning_output_tokens: 5,
            },
          },
        },
      },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const store = new UsageStore({ homeDir, databaseFile: path.join(homeDir, "usage-index.sqlite") });

  try {
    await store.sync();
    const summary = store.summarize({ preset: "all", bucket: "day" });

    assert.equal(summary.totals.total, 123);
    assert.equal(store.metadata().eventCount, 1);
    assert.ok(store.warnings.some((warning) => warning.includes("无法索引")));
  } finally {
    store.close();
  }
});
