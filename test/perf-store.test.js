// M3.1：`perf_samples` 建表（v12）与读写编解码的验收。
//
// 权威依据：方案 `docs/plans/2026-10-03-model-latency-throughput-plan.md` §4（`:45-58`）、详细卡
// `M3-index.md` §M3.1、冻结契约 `source-contract.md` §裁定 AN-1…AN-10 与 AO-1…AO-4。
//
// 本文件最重要的两条方法学约束（都是 Lead 实测确立的，不得弱化）：
//
// ★ A（AN-9）：**任何在全新库（`user_version = 0`）上跑的验收，结构上不可能因 v11→12 迁移损坏而
//   失败** —— `usage-store.js` 的 `version === 0` 分支把新库**无条件**标成常量当前值，完全跳过
//   `version === 11` 块。因此本文件**必须有**一条"真实 v11 夹具库"路径；该夹具由**冻结 v11 DDL
//   字面量**直接建库（不调用 `UsageStore`、不调用本卡的编解码），否则会与被测路径共享同一份 DDL
//   假设，发现不了 DDL 遗漏。
//
// ★ 三类陈述标注（AN-7/AN-10，按"什么会使其失效"裁决）：🟦 schema 事实（schema 变更才失效）/
//   🟨 单时刻观测（外部写入即失效）/ 🟩 代码事实（代码编辑即失效）。混合体按最易失效项归类。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { normalizePerfSample } from "../src/perf-stats.js";
import {
  PERF_SAMPLE_FIELDS,
  PerfSampleCodecError,
  STORE_SCHEMA_VERSION,
  UsageStore,
  decodePerfSample,
  encodePerfSample,
} from "../src/usage-store.js";

// ---------------------------------------------------------------------------
// 冻结的 v11 夹具 DDL
// ---------------------------------------------------------------------------

/**
 * 真实 v11 schema 的**冻结字面量**（🟦：v11 的建表块逐字复制自本卡改动前的
 * `src/usage-store.js:218-287`，即 v1/v2 的 12 处 `ALTER TABLE` 之后的最终形状）。
 *
 * 为什么复制而不是"用本卡代码建库再降版本"（AN-9 明令禁止）：后者会让夹具与被测迁移共享同一份
 * DDL 假设 —— 被测 DDL 少一列，夹具也少一列，测试永远绿。这里夹具**不经过任何被测代码**。
 * 漂移防护：`v11 夹具自证` 用例断言夹具的四张旧表列集与"全新库路径"的四张旧表列集逐列相同，
 * 因此将来若有人改了当前建表块而忘了同步本夹具，该用例会红。
 */
const V11_SCHEMA_DDL = `
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS store_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_files (
        path TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        home_id TEXT NOT NULL,
        home_label TEXT NOT NULL,
        home_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        indexed_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
        timestamp_ms INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        home_id TEXT NOT NULL,
        home_label TEXT NOT NULL,
        channel TEXT NOT NULL,
        project TEXT NOT NULL,
        model TEXT NOT NULL,
        hour_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        week_key TEXT NOT NULL,
        month_key TEXT NOT NULL,
        cwd TEXT NOT NULL DEFAULT '',
        repository_key TEXT NOT NULL DEFAULT 'unknown:cwd',
        repository_path TEXT NOT NULL DEFAULT 'Unknown cwd',
        repository_kind TEXT NOT NULL DEFAULT 'unknown',
        detail_mask INTEGER NOT NULL DEFAULT 0,
        reconciliation_gap INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_known INTEGER NOT NULL DEFAULT 0,
        request_input_tokens INTEGER NOT NULL DEFAULT 0,
        context_level TEXT NOT NULL DEFAULT 'unknown',
        service_tier TEXT NOT NULL DEFAULT 'unknown',
        price_version TEXT NOT NULL DEFAULT '',
        total INTEGER NOT NULL,
        input INTEGER NOT NULL,
        cached INTEGER NOT NULL,
        output INTEGER NOT NULL,
        reasoning INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS rate_limit_observations (
        source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
        line_number INTEGER NOT NULL CHECK (line_number > 0),
        role TEXT NOT NULL CHECK (role IN ('primary', 'secondary')),
        observed_at_ms INTEGER NOT NULL,
        limit_id TEXT NOT NULL,
        limit_name TEXT,
        plan_type TEXT,
        window_minutes REAL NOT NULL CHECK (window_minutes > 0),
        resets_at_ms INTEGER NOT NULL,
        used_percent REAL CHECK (used_percent IS NULL OR (used_percent >= 0 AND used_percent <= 100)),
        PRIMARY KEY (source_path, line_number, role)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_timestamp_idx ON events(timestamp_ms);
      CREATE INDEX IF NOT EXISTS events_home_idx ON events(home_id);
      CREATE INDEX IF NOT EXISTS events_channel_idx ON events(channel);
      CREATE INDEX IF NOT EXISTS events_project_idx ON events(project);
      CREATE INDEX IF NOT EXISTS events_model_idx ON events(model);
      CREATE INDEX IF NOT EXISTS rate_limit_window_lookup_idx ON rate_limit_observations(limit_id, window_minutes, observed_at_ms DESC);
      CREATE INDEX IF NOT EXISTS rate_limit_source_line_idx ON rate_limit_observations(source_path, line_number);
      CREATE INDEX IF NOT EXISTS events_repository_idx ON events(repository_key);
`;

/** v11 夹具里被种入的既有数据（gate F 用：迁移前后必须逐行相同）。 */
const V11_SEED = `
      INSERT INTO source_files (path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at) VALUES
        ('/v11/zcode.db', 'zcode', 'home-a', 'Home A', '/v11', 1111, 1700000000001, '2026-10-01T00:00:00.000Z'),
        ('/v11/dsh-session.jsonl', 'dsh', 'home-b', 'Home B', '/v11', 2222, 1700000000002, '2026-10-01T00:00:00.000Z');
      INSERT INTO events (source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
        hour_key, day_key, week_key, month_key, cwd, total, input, cached, output, reasoning) VALUES
        ('/v11/zcode.db', 1790000000000, 'ses-1', 'home-a', 'Home A', 'zcode', 'proj', 'gpt-5',
         '2026-09-23 03:00', '2026-09-23', '2026-09-22', '2026-09', 'proj', 100, 40, 10, 30, 20),
        ('/v11/dsh-session.jsonl', 1790000001000, 'ses-2', 'home-b', 'Home B', 'DSH', 'proj', 'gpt-5',
         '2026-09-23 03:00', '2026-09-23', '2026-09-22', '2026-09', 'proj', 7, 3, 1, 2, 1);
      INSERT INTO rate_limit_observations (source_path, line_number, role, observed_at_ms, limit_id, limit_name,
        plan_type, window_minutes, resets_at_ms, used_percent) VALUES
        ('/v11/dsh-session.jsonl', 12, 'primary', 1790000002000, 'codex', 'Codex', 'plus', 300, 1790000180000, 42.5);
      INSERT INTO store_meta (key, value) VALUES ('generated_at', '2026-10-01T00:00:00.000Z'), ('fingerprint', 'v11-fixture');
`;

/** 计划 §4 的 30 列逐字顺序（`2026-10-03-...:49`）。 */
const PLAN_COLUMNS = (
  "sample_key source_path source_kind home_id channel agent_kind agent session_id turn_key model model_provider " +
  "reasoning_effort model_evidence window timing_kind timing_source token_scope status ts_ms window_start_ms " +
  "window_end_ms duration_ms output_tokens input_tokens request_count item_count timed_item_count sample_flags " +
  "diagnostic_reason method_version"
).split(" ");

/**
 * 冻结的 31 列（AO-1/AO-2）：计划的 30 列 + `diagnostic_reason_chain`，插在 `diagnostic_reason` 之后。
 * 这是"逐列确认"的冻结证据，不是从被测代码推导出来的。
 */
const EXPECTED_COLUMNS = [...PLAN_COLUMNS.slice(0, 29), "diagnostic_reason_chain", "method_version"];

const MEASUREMENT_COLUMNS = [
  "ts_ms",
  "window_start_ms",
  "window_end_ms",
  "duration_ms",
  "output_tokens",
  "input_tokens",
  "request_count",
  "item_count",
  "timed_item_count",
];

// ---------------------------------------------------------------------------
// 夹具与工具
// ---------------------------------------------------------------------------

/**
 * 已打开的 store 集合（`close()` 幂等）。清理前兜底关闭：
 * 断言失败时 store 可能还没关，Windows 上的 `rm` 会抛 `EBUSY` 并**把真正的断言错误掩盖掉**
 * —— 本卡实测踩过一次（往返用例的真实失败被 EBUSY 顶掉），所以这里强制"先关句柄、再删目录"。
 */
const openStores = new Set();

async function makeTempDir() {
  return mkdtemp(path.join(tmpdir(), "codex-usage-perf-store-"));
}

function closeAllStores() {
  for (const store of openStores) store.close();
  openStores.clear();
}

async function cleanupDir(dir) {
  closeAllStores();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/**
 * 构造**真实 v11 夹具库**：冻结 DDL + v11 种子数据 + `PRAGMA user_version = 11`。
 * `mutate` 可在关闭前注入故障（gate H）。
 * @param {{ seed?: boolean, mutate?: ((db: import("node:sqlite").DatabaseSync) => void) | null }} [options]
 */
async function makeV11Fixture(options = {}) {
  const { seed = true, mutate = null } = options;
  const dir = await makeTempDir();
  const databaseFile = path.join(dir, "usage-index.sqlite");
  const db = new DatabaseSync(databaseFile);
  db.exec(V11_SCHEMA_DDL);
  if (seed) db.exec(V11_SEED);
  if (mutate) mutate(db);
  db.exec("PRAGMA user_version = 11");
  db.close();
  return { dir, databaseFile };
}

/** 只读探查一个库文件（关闭后调用；不经过 `UsageStore`）。 */
function inspect(databaseFile) {
  return new DatabaseSync(databaseFile);
}

/** `PRAGMA table_info` → 归一化列表（列序即声明序）。 */
function tableColumns(db, table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => ({
      name: String(row.name),
      type: String(row.type || "").toUpperCase(),
      notnull: Number(row.notnull),
      pk: Number(row.pk),
      dflt: row.dflt_value === null ? null : String(row.dflt_value),
    }));
}

/** `PRAGMA index_list` 里**本表自建**的索引（`origin='c'`；排除 pk/unique 自动索引）→ 名字与列序。 */
function tableIndexes(db, table) {
  return db
    .prepare(`PRAGMA index_list(${table})`)
    .all()
    .filter((row) => String(row.origin) === "c")
    .map((row) => ({
      name: String(row.name),
      unique: Number(row.unique),
      columns: db
        .prepare(`PRAGMA index_info(${String(row.name)})`)
        .all()
        .map((column) => String(column.name)),
    }))
    .sort((left, right) => (left.name < right.name ? -1 : 1));
}

function objectDefinition(db, name) {
  const row = db.prepare("SELECT type, sql FROM sqlite_master WHERE name = ?").get(name);
  return row === undefined ? null : { type: String(row.type), sql: String(row.sql) };
}

function userVersion(db) {
  return Number(db.prepare("PRAGMA user_version").get().user_version);
}

/** 内容哈希：用来证明"迁移前后逐行相同"（🟦 与内容无关，只看行列值是否变了）。 */
function contentHash(db, sql) {
  return createHash("sha256")
    .update(JSON.stringify(db.prepare(sql).all()))
    .digest("hex");
}

function sourceFilesFingerprint(db) {
  return db.prepare("SELECT path, size, mtime_ms FROM source_files ORDER BY path").all();
}

/** 把冻结 v11 DDL 建出来的库与跑过代码的库做"旧表逐列相同"比对（夹具漂移防护）。 */
function legacyTableShape(db) {
  return {
    store_meta: tableColumns(db, "store_meta"),
    source_files: tableColumns(db, "source_files"),
    events: tableColumns(db, "events"),
    rate_limit_observations: tableColumns(db, "rate_limit_observations"),
  };
}

/** 构造（不打开）一个被追踪的 UsageStore：H 组用例需要在 open() 抛错后仍保证句柄被关。 */
function makeStore(dir, databaseFile) {
  const store = new UsageStore({ homeDir: dir, databaseFile });
  openStores.add(store);
  return store;
}

/** 打开一个 UsageStore（调用方负责 close；清理时也会兜底关闭）。 */
async function openStore(dir, databaseFile) {
  const store = new UsageStore({ homeDir: dir, databaseFile });
  openStores.add(store);
  await store.open();
  return store;
}

// --- 归一化样本夹具（**必须**来自真实 `normalizePerfSample`，不手写对象） ---

const BASE_RAW = Object.freeze({
  sourceKind: "zcode",
  identity: ["row-0001"],
  homeId: "home-a",
  sourcePath: "/fixture/zcode.db",
  channel: "zcode",
  agentKind: "unknown",
  agent: "",
  sessionId: "ses-1",
  turnKey: "",
  model: "gpt-5",
  modelProvider: "",
  reasoningEffort: "",
  modelEvidence: "",
  status: "completed",
  tsMs: 1_790_000_000_000,
  windowStartMs: 1_790_000_000_000,
  windowEndMs: 1_790_000_002_500,
  durationMs: 2500,
  outputTokens: 100,
  requestCount: 1,
});

/** 真实归一化样本；`overrides.identity` 用来避免主键碰撞。 */
function normalizedSample(overrides = {}) {
  const result = normalizePerfSample({ ...BASE_RAW, ...overrides });
  assert.ok(result.sample, `夹具本身必须能归一化：${JSON.stringify(result.warnings)}`);
  return result.sample;
}

// --- 行级插入/读取（绕过 store 方法，用来单独测约束） ---

const COLUMN_NAMES = PERF_SAMPLE_FIELDS.map((entry) => entry.column);
const INSERT_PLACEHOLDERS = COLUMN_NAMES.map(() => "?").join(", ");

function insertRawRow(db, row) {
  db.prepare(`INSERT INTO perf_samples (${COLUMN_NAMES.join(", ")}) VALUES (${INSERT_PLACEHOLDERS})`).run(
    ...COLUMN_NAMES.map((column) => row[column]),
  );
}

function validRow(overrides = {}) {
  return { ...encodePerfSample(normalizedSample()), ...overrides };
}

function registerSource(db, filePath, kind = "zcode", homeId = "home-a") {
  db.prepare(
    "INSERT INTO source_files (path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(filePath, kind, homeId, "Fixture Home", "/fixture", 1, 1, "2026-10-04T00:00:00.000Z");
}

/**
 * 一个已注册来源 + 打开好的 store + 一个可直接写入的样本。
 * 所有写路径的测试都从这里开始，避免每个用例重复样板。
 */
async function makeWritableStore(rawOverrides = {}) {
  const dir = await makeTempDir();
  const databaseFile = path.join(dir, "usage-index.sqlite");
  const store = await openStore(dir, databaseFile);
  const sample = normalizedSample(rawOverrides);
  registerSource(store.database, sample.sourcePath);
  return { dir, databaseFile, store, sample };
}

// ---------------------------------------------------------------------------
// 夹具自证（gate A 的前提）
// ---------------------------------------------------------------------------

test("v11 夹具自证：user_version=11、无 perf_samples、四张旧表列集与全新库路径逐列相同", async () => {
  const fixture = await makeV11Fixture();
  const freshDir = await makeTempDir();
  try {
    const db = inspect(fixture.databaseFile);
    try {
      // 🟨 单时刻观测：夹具自身必须真的是 v11，否则后面"迁移成功"可能是别的原因。
      assert.equal(userVersion(db), 11, "夹具必须是 user_version = 11");
      assert.equal(objectDefinition(db, "perf_samples"), null, "v11 夹具里不得预先存在 perf_samples");
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM events").get().c, 2);
      assert.equal(db.prepare("SELECT COUNT(*) AS c FROM rate_limit_observations").get().c, 1);
      const fixtureShape = legacyTableShape(db);

      // 漂移防护：夹具的旧表列集必须等于"全新库路径"建出来的旧表列集。
      const freshStore = await openStore(freshDir, path.join(freshDir, "usage-index.sqlite"));
      freshStore.close();
      const freshDb = inspect(path.join(freshDir, "usage-index.sqlite"));
      try {
        assert.deepEqual(legacyTableShape(freshDb), fixtureShape, "v11 夹具 DDL 已与当前建表块漂移");
      } finally {
        freshDb.close();
      }
    } finally {
      db.close();
    }
  } finally {
    await cleanupDir(fixture.dir);
    await cleanupDir(freshDir);
  }
});

test("列清单与 AO-1/AO-2 对照：映射表 = 计划 30 列 + diagnostic_reason_chain = 31 列（逐列确认）", () => {
  // 计划 `2026-10-03-...:49` 逐字 30 列（顺序敏感）。
  assert.deepEqual(PLAN_COLUMNS, [
    "sample_key",
    "source_path",
    "source_kind",
    "home_id",
    "channel",
    "agent_kind",
    "agent",
    "session_id",
    "turn_key",
    "model",
    "model_provider",
    "reasoning_effort",
    "model_evidence",
    "window",
    "timing_kind",
    "timing_source",
    "token_scope",
    "status",
    "ts_ms",
    "window_start_ms",
    "window_end_ms",
    "duration_ms",
    "output_tokens",
    "input_tokens",
    "request_count",
    "item_count",
    "timed_item_count",
    "sample_flags",
    "diagnostic_reason",
    "method_version",
  ]);
  assert.equal(PLAN_COLUMNS.length, 30, "AO-2：方案列清单是 30 列，不是 29");
  assert.equal(EXPECTED_COLUMNS.length, 31, "AO-1：加 diagnostic_reason_chain 后共 31 列");
  assert.deepEqual(
    PERF_SAMPLE_FIELDS.map((entry) => entry.column),
    EXPECTED_COLUMNS,
    "字段映射表与冻结列清单（计划 30 + AO-1 第 31）必须逐列同序",
  );
  // M1 归一化样本的字段数必须与列数一致（否则往返必然丢字段）。
  assert.equal(Object.keys(normalizedSample()).length, 31);
  assert.deepEqual(
    PERF_SAMPLE_FIELDS.map((entry) => entry.field).sort(),
    Object.keys(normalizedSample()).sort(),
    "映射表的 JS 字段名必须与 M1 样本字段逐个对应",
  );
});

// ---------------------------------------------------------------------------
// ★ A：新库与旧库升级都落到当前 schema（T1: v15）
// ---------------------------------------------------------------------------

test("★A 空库（version=0）路径：建出 perf_samples 与三个索引，user_version 抬到 17", async () => {
  const dir = await makeTempDir();
  try {
    const databaseFile = path.join(dir, "usage-index.sqlite");
    const store = await openStore(dir, databaseFile);
    store.close();
    const db = inspect(databaseFile);
    try {
      assert.equal(userVersion(db), 17);
      assert.equal(STORE_SCHEMA_VERSION, 17, "常量与实际落点必须一致");
      // 列：DDL 实际形状 = 冻结映射表。
      const columns = tableColumns(db, "perf_samples");
      assert.deepEqual(
        columns.map((column) => column.name),
        EXPECTED_COLUMNS,
      );
      assert.deepEqual(
        columns.map((column) => column.type),
        PERF_SAMPLE_FIELDS.map((entry) => (entry.kind === "text" || entry.kind === "reasonChain" ? "TEXT" : "INTEGER")),
      );
      // 三个索引，列序逐字。
      assert.deepEqual(tableIndexes(db, "perf_samples"), [
        { name: "perf_samples_home_ts_idx", unique: 0, columns: ["home_id", "ts_ms"] },
        { name: "perf_samples_source_kind_home_ts_idx", unique: 0, columns: ["source_kind", "home_id", "ts_ms"] },
        { name: "perf_samples_source_path_idx", unique: 0, columns: ["source_path"] },
      ]);
      assert.equal(columns[0].pk, 1, "sample_key 是主键");
      assert.equal(columns[0].name, "sample_key");
    } finally {
      db.close();
    }
  } finally {
    await cleanupDir(dir);
  }
});

test("★A v11 夹具路径：迁移到 17，且 perf_samples 的表/索引定义与全新库路径【逐字相同】", async () => {
  const fixture = await makeV11Fixture();
  const freshDir = await makeTempDir();
  try {
    // 迁移路径：打开一份**真实 v11 库**（不是本卡代码建出来的）。
    const migrated = await openStore(fixture.dir, fixture.databaseFile);
    migrated.close();
    // 全新库路径。
    const freshFile = path.join(freshDir, "usage-index.sqlite");
    const fresh = await openStore(freshDir, freshFile);
    fresh.close();

    const migratedDb = inspect(fixture.databaseFile);
    const freshDb = inspect(freshFile);
    try {
      assert.equal(userVersion(migratedDb), 17, "v11 夹具迁移后必须是当前版本");
      assert.equal(userVersion(freshDb), 17);
      assert.equal(objectDefinition(migratedDb, "perf_samples").type, "table");
      assert.equal(migratedDb.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c, 0);

      // ① DDL 文本逐字相同（`IF NOT EXISTS` 被 SQLite 记入 sqlite_master 时已剥离）。
      assert.equal(
        objectDefinition(migratedDb, "perf_samples").sql,
        objectDefinition(freshDb, "perf_samples").sql,
        "两条路径的 perf_samples DDL 文本必须逐字相同",
      );
      // ② 实现形状逐列逐索引相同。
      assert.deepEqual(tableColumns(migratedDb, "perf_samples"), tableColumns(freshDb, "perf_samples"));
      assert.deepEqual(tableIndexes(migratedDb, "perf_samples"), tableIndexes(freshDb, "perf_samples"));
      assert.ok(objectDefinition(migratedDb, "perf_samples").sql.includes("STRICT"), "必须是 STRICT 表");
      assert.ok(
        objectDefinition(migratedDb, "perf_samples").sql.includes("REFERENCES source_files(path) ON DELETE CASCADE"),
        "外键与级联必须在 DDL 里（其生效由 ★C/★D 实测，不以文本为证据）",
      );
      // ③ 版本落点用字面量（不是常量拼接）：迁移段里不得出现 STORE_SCHEMA_VERSION 的插值。
      assert.equal(userVersion(migratedDb), 17);
    } finally {
      migratedDb.close();
      freshDb.close();
    }
  } finally {
    await cleanupDir(fixture.dir);
    await cleanupDir(freshDir);
  }
});

test("★A 迁移在同一事务内做【无 WHERE 标脏】：既有全部来源行都变 -1（两条来源行都测）", async () => {
  const fixture = await makeV11Fixture();
  try {
    const before = inspect(fixture.databaseFile);
    let beforeRows;
    try {
      beforeRows = sourceFilesFingerprint(before);
    } finally {
      before.close();
    }
    // 前提：夹具里的两份来源都还没有被标脏。
    assert.deepEqual(
      beforeRows.map((row) => [String(row.path), Number(row.size), Number(row.mtime_ms)]),
      [
        ["/v11/dsh-session.jsonl", 2222, 1700000000002],
        ["/v11/zcode.db", 1111, 1700000000001],
      ],
    );

    const store = await openStore(fixture.dir, fixture.databaseFile);
    store.close();

    const after = inspect(fixture.databaseFile);
    try {
      assert.deepEqual(
        sourceFilesFingerprint(after).map((row) => [String(row.path), Number(row.size), Number(row.mtime_ms)]),
        [
          ["/v11/dsh-session.jsonl", -1, -1],
          ["/v11/zcode.db", -1, -1],
        ],
        "无 WHERE 的标脏必须覆盖**全部**来源（两条都变 -1）",
      );
    } finally {
      after.close();
    }
  } finally {
    await cleanupDir(fixture.dir);
  }
});

// ---------------------------------------------------------------------------
// ★ B：往返恒等（AO-3）
// ---------------------------------------------------------------------------

test("★B 往返恒等：真实 normalizePerfSample 样本 decode(encode(s)) 与 s 逐字段深等", async () => {
  const dir = await makeTempDir();
  try {
    const databaseFile = path.join(dir, "usage-index.sqlite");
    const store = await openStore(dir, databaseFile);
    const cases = [
      ["clean（flags=0 且 chain=[]）", {}],
      ["真 0 输出", { outputTokens: 0 }],
      ["输出缺失", { outputTokens: null }],
      ["真 0 时长", { durationMs: 0 }],
      ["时长缺失", { durationMs: null }],
      ["负时长", { durationMs: -5 }],
      ["非整数输出", { outputTokens: 1.5 }],
      ["时间戳缺失", { tsMs: null }],
      ["时间戳单位不支持", { tsMs: 1_790_000_000 }],
      ["状态缺失", { status: "" }],
      ["状态未知字面量", { status: "retrying" }],
      ["进行中", { status: "in_progress" }],
      ["取消", { status: "cancelled" }],
      ["来源过滤合成状态", { status: "", sourceFiltered: true, filterReason: "source_failed" }],
      ["语义漂移（chain 非空、flags=0）", { window: "turn" }],
      ["长窗口", { durationMs: 300_001 }],
      ["结构化 flag（flags≠0、chain=[]）", { partialItemSpan: true }],
      [
        "子代理 + 名称类空串",
        { agentKind: "subagent", agent: "build", modelProvider: "unknown", reasoningEffort: "xhigh" },
      ],
      [
        "opencode 语义",
        {
          sourceKind: "opencode",
          identity: ["db-1", "msg-1"],
          sourcePath: "/fixture/opencode.db",
          channel: "opencode",
        },
      ],
      ["dsh 语义", { sourceKind: "dsh", identity: ["ses-9", 3, 7], sourcePath: "/fixture/dsh.jsonl", channel: "dsh" }],
      [
        "codex 语义（item_span_estimate）",
        { sourceKind: "codex", identity: ["th-1", "tu-1"], requestCount: 3, window: "turn" },
      ],
      ["多请求 + 大整数", { requestCount: 2_000_000, itemCount: 0, timedItemCount: 0, tsMs: 4_102_444_800_000 }],
    ];
    const registered = new Set();
    let checked = 0;
    for (const [index, [label, overrides]] of cases.entries()) {
      // 每个用例的身份必须不同，否则会撞主键（`sampleKey` 含身份元组）。
      const identity = Array.isArray(overrides.identity)
        ? overrides.identity
        : [`case-${String(index).padStart(2, "0")}`];
      const sample = normalizedSample({ ...overrides, identity });
      if (!registered.has(sample.sourcePath)) {
        registerSource(store.database, sample.sourcePath, sample.sourceKind, sample.homeId);
        registered.add(sample.sourcePath);
      }
      store.insertPerfSample(sample);
      const decoded = store.perfSampleByKey(sample.sampleKey);
      assert.ok(decoded, `${label}：必须能按主键读回`);
      assert.deepEqual(decoded, sample, `${label}：decode(encode(s)) 必须与 s 逐字段深等`);
      assert.equal(Object.keys(decoded).length, 31, `${label}：31 个字段一个不少`);
      checked += 1;
    }
    // 判别式可达性自证：若一条都没跑，上面全是空转。
    assert.equal(checked, cases.length);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c, cases.length);
    store.close();
  } finally {
    await cleanupDir(dir);
  }
});

test("★B null 与 0 在库里就是两种值：未知写 NULL、真实 0 写 0（SQL 层实测 + 往返）", async () => {
  const { dir, store, sample } = await makeWritableStore({ outputTokens: 0, durationMs: 0, tsMs: null });
  try {
    // 同一个归一化样本里就有三种状态：真 0（输出/时长）与未知（时间戳）。
    assert.equal(sample.outputTokens, 0);
    assert.equal(sample.durationMs, 0);
    assert.equal(sample.tsMs, null);
    store.insertPerfSample(sample);
    const row = store.database
      .prepare(
        "SELECT output_tokens, output_tokens IS NULL AS output_null, typeof(output_tokens) AS output_type, duration_ms, duration_ms IS NULL AS duration_null, ts_ms, ts_ms IS NULL AS ts_null, typeof(ts_ms) AS ts_type FROM perf_samples WHERE sample_key = ?",
      )
      .get(sample.sampleKey);
    assert.equal(Number(row.output_tokens), 0, "真实 0 必须写成 0");
    assert.equal(Number(row.output_null), 0);
    assert.equal(String(row.output_type), "integer");
    assert.equal(Number(row.duration_ms), 0);
    assert.equal(Number(row.duration_null), 0);
    assert.equal(Number(row.ts_null), 1, "未知必须写成 NULL");
    assert.equal(String(row.ts_type), "null");
    assert.deepEqual(store.perfSampleByKey(sample.sampleKey), sample);

    // 缺失样本（不是 0）与真 0 样本在同一列上必须给出不同的值。
    const missing = normalizedSample({
      identity: ["row-missing"],
      outputTokens: null,
      durationMs: null,
      tsMs: 1_790_000_000_000,
    });
    store.insertPerfSample(missing);
    const pair = store.database
      .prepare("SELECT sample_key, output_tokens, duration_ms FROM perf_samples ORDER BY sample_key")
      .all();
    assert.equal(pair.length, 2);
    assert.notEqual(String(pair[0].output_tokens), String(pair[1].output_tokens));
    assert.equal(missing.outputTokens, null);
    assert.deepEqual(store.perfSampleByKey(missing.sampleKey), missing);
  } finally {
    store.close();
    await cleanupDir(dir);
  }
});

test("★B 空数组与 NULL 在库里是两种状态：链为空存 '[]'，没有链存 NULL（AO-1/AO-3）", async () => {
  const { dir, store, sample } = await makeWritableStore();
  try {
    assert.deepEqual(sample.diagnosticReasonChain, [], "干净样本的链是空数组（不是 null）");
    store.insertPerfSample(sample);
    const stored = store.database
      .prepare(
        "SELECT diagnostic_reason_chain AS chain, diagnostic_reason_chain IS NULL AS is_null FROM perf_samples WHERE sample_key = ?",
      )
      .get(sample.sampleKey);
    assert.equal(String(stored.chain), "[]", "空链必须存成 '[]' 而不是 NULL");
    assert.equal(Number(stored.is_null), 0);

    // 显式 null 链：写 NULL，读回 null（与 [] 不同）。
    const noChain = { ...normalizedSample({ identity: ["row-no-chain"] }), diagnosticReasonChain: null };
    store.insertPerfSample(noChain);
    const storedNull = store.database
      .prepare(
        "SELECT diagnostic_reason_chain AS chain, diagnostic_reason_chain IS NULL AS is_null FROM perf_samples WHERE sample_key = ?",
      )
      .get(noChain.sampleKey);
    assert.equal(storedNull.chain, null);
    assert.equal(Number(storedNull.is_null), 1);

    const decodedEmpty = store.perfSampleByKey(sample.sampleKey);
    const decodedNull = store.perfSampleByKey(noChain.sampleKey);
    assert.deepEqual(decodedEmpty.diagnosticReasonChain, []);
    assert.equal(decodedNull.diagnosticReasonChain, null);
    assert.notDeepEqual(decodedEmpty.diagnosticReasonChain, decodedNull.diagnosticReasonChain);

    // 非空链的原样往返（多元素、含合成标记）。
    const chained = normalizedSample({
      identity: ["row-chain"],
      status: "",
      sourceFiltered: true,
      filterReason: "source_failed",
    });
    assert.deepEqual(chained.diagnosticReasonChain, [
      "status_missing",
      "source_failed",
      "status_synthesized_from_filter_evidence",
    ]);
    store.insertPerfSample(chained);
    const row = store.database
      .prepare("SELECT diagnostic_reason_chain AS chain FROM perf_samples WHERE sample_key = ?")
      .get(chained.sampleKey);
    assert.deepEqual(JSON.parse(String(row.chain)), chained.diagnosticReasonChain);
    assert.deepEqual(store.perfSampleByKey(chained.sampleKey), chained);
  } finally {
    store.close();
    await cleanupDir(dir);
  }
});

test("★B 度量列在 schema 层就是可空的，且没有 DEFAULT（AO-3 的结构性保障）", async () => {
  const dir = await makeTempDir();
  try {
    const databaseFile = path.join(dir, "usage-index.sqlite");
    const store = await openStore(dir, databaseFile);
    store.close();
    const db = inspect(databaseFile);
    try {
      const columns = tableColumns(db, "perf_samples");
      for (const column of columns) {
        if (MEASUREMENT_COLUMNS.includes(column.name)) {
          assert.equal(column.notnull, 0, `${column.name} 必须可空（NULL = 未知）`);
          assert.equal(column.dflt, null, `${column.name} 不得有 DEFAULT（否则"没给值"会静默变成 0）`);
        }
      }
      assert.equal(columns.find((column) => column.name === "sample_flags").notnull, 1);
      assert.equal(columns.find((column) => column.name === "sample_flags").dflt, "0");
      assert.equal(columns.find((column) => column.name === "diagnostic_reason_chain").notnull, 0);
      assert.equal(columns.find((column) => column.name === "diagnostic_reason_chain").dflt, null);
      // 文本列 NOT NULL：缺失只有空串这一个字面量（裁定 P）。
      for (const column of columns) {
        if (column.name.endsWith("_chain") || MEASUREMENT_COLUMNS.includes(column.name)) continue;
        if (column.name === "sample_flags") continue;
        assert.equal(column.notnull, 1, `${column.name} 文本列必须 NOT NULL`);
      }
    } finally {
      db.close();
    }
  } finally {
    await cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// ★ C：PRAGMA foreign_keys 的时机
// ---------------------------------------------------------------------------

test("★C 连接上 PRAGMA foreign_keys 实测为 ON（全新库路径与迁移路径都测）", async () => {
  const fixture = await makeV11Fixture();
  const freshDir = await makeTempDir();
  try {
    const fresh = await openStore(freshDir, path.join(freshDir, "usage-index.sqlite"));
    try {
      assert.equal(Number(fresh.database.prepare("PRAGMA foreign_keys").get().foreign_keys), 1);
    } finally {
      fresh.close();
    }
    const migrated = await openStore(fixture.dir, fixture.databaseFile);
    try {
      // 迁移连接（同一连接上跑过 BEGIN IMMEDIATE…COMMIT）事后仍为 ON。
      assert.equal(Number(migrated.database.prepare("PRAGMA foreign_keys").get().foreign_keys), 1);
    } finally {
      migrated.close();
    }
  } finally {
    await cleanupDir(fixture.dir);
    await cleanupDir(freshDir);
  }
});

test("★C 机制：事务内设置 PRAGMA foreign_keys 是 no-op —— 这就是「必须事务外设」的原因", async () => {
  const { dir, store } = await makeWritableStore();
  try {
    const connection = store.database;
    connection.exec("PRAGMA foreign_keys = OFF");
    assert.equal(Number(connection.prepare("PRAGMA foreign_keys").get().foreign_keys), 0, "事务外可以关掉");
    connection.exec("BEGIN IMMEDIATE");
    connection.exec("PRAGMA foreign_keys = ON");
    const insideTransaction = Number(connection.prepare("PRAGMA foreign_keys").get().foreign_keys);
    connection.exec("ROLLBACK");
    // 事务内设置被忽略 ⇒ 仍为 OFF。若这里变成 1，"事务外设"的说法就被证伪。
    assert.equal(insideTransaction, 0, "事务内设置 pragma 必须无效（实测 no-op）");
    // 事务外再设回来，连接恢复可用。
    connection.exec("PRAGMA foreign_keys = ON");
    assert.equal(Number(connection.prepare("PRAGMA foreign_keys").get().foreign_keys), 1);
  } finally {
    store.close();
    await cleanupDir(dir);
  }
});

test("★C 外键真的生效：插入未注册的 source_path 失败，注册后同一行成功（两侧对照）", async () => {
  const dir = await makeTempDir();
  try {
    const databaseFile = path.join(dir, "usage-index.sqlite");
    const store = await openStore(dir, databaseFile);
    try {
      const sample = normalizedSample({ sourcePath: "/fixture/not-registered.db" });
      // 反例：父行不存在 ⇒ 必须失败（不是"也许失败"）。
      assert.throws(
        () => store.insertPerfSample(sample),
        (error) => {
          assert.equal(error.code, "ERR_SQLITE_ERROR");
          assert.equal(error.errcode, 787, "SQLITE_CONSTRAINT_FOREIGNKEY");
          assert.match(String(error.message), /FOREIGN KEY constraint failed/);
          return true;
        },
        "未注册 source_path 的候选必须被外键拒绝",
      );
      assert.equal(store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c, 0, "失败不得留下半行");
      // 正例：注册父行后同一行成功。
      registerSource(store.database, sample.sourcePath);
      store.insertPerfSample(sample);
      assert.equal(store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c, 1);
      assert.deepEqual(store.perfSampleByKey(sample.sampleKey), sample);
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// ★ D：级联删除实测（AN-5）
// ---------------------------------------------------------------------------

test("★D 级联删除实测：删 source_files 父行 ⇒ perf_samples 子行消失（含删除前计数对照）", async () => {
  const { dir, store, sample } = await makeWritableStore();
  try {
    store.insertPerfSample(sample);
    const second = normalizedSample({ identity: ["row-0002"], sourcePath: sample.sourcePath });
    store.insertPerfSample(second);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c, 2, "删除前必须真的有子行");

    store.database.prepare("DELETE FROM source_files WHERE path = ?").run(sample.sourcePath);
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c,
      0,
      "删父行后子行必须消失（不能只靠 DDL 里写了 ON DELETE CASCADE）",
    );
    assert.equal(store.perfSampleByKey(sample.sampleKey), null);
    assert.equal(store.perfSampleByKey(second.sampleKey), null);
  } finally {
    store.close();
    await cleanupDir(dir);
  }
});

test("★D 机制对照：把 foreign_keys 关掉就【不会】级联 —— 证明 D 的证据依赖 pragma 而不是 DDL 文本", async () => {
  const { dir, store, sample } = await makeWritableStore();
  try {
    store.insertPerfSample(sample);
    store.database.exec("PRAGMA foreign_keys = OFF");
    store.database.prepare("DELETE FROM source_files WHERE path = ?").run(sample.sourcePath);
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c,
      1,
      "关掉 pragma 后级联失效、孤儿行残留 ⇒ 前面的级联证据确实来自 pragma + FK",
    );
    store.database.exec("PRAGMA foreign_keys = ON");
    store.database.prepare("DELETE FROM perf_samples").run();
  } finally {
    store.close();
    await cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// ★ E：约束真的生效
// ---------------------------------------------------------------------------

test("★E 枚举约束：status / timing_kind / agent_kind 非法值必须失败，合法值成功（逐列两侧）", async () => {
  const { dir, store } = await makeWritableStore();
  try {
    const db = store.database;
    const illegal = [
      ["status", "zzz", 275],
      ["status", "COMPLETED", 275],
      ["timing_kind", "turn_e2e", 275],
      ["agent_kind", "primary", 275],
    ];
    for (const [column, value, errcode] of illegal) {
      assert.throws(
        () => insertRawRow(db, validRow({ [column]: value })),
        (error) => {
          assert.equal(error.errcode, errcode, `${column}=${value} 必须是 CHECK 失败`);
          assert.match(String(error.message), /CHECK constraint failed/);
          return true;
        },
        `${column} = ${JSON.stringify(value)} 必须被拒绝`,
      );
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c, 0, "被拒的行不得落库");
    // 合法值必须能进（否则上面的"拒绝"可能只是行本来就写不进去）。
    for (const row of [
      validRow({ sample_key: "k-completed", status: "completed" }),
      validRow({ sample_key: "k-failed", status: "failed" }),
      validRow({ sample_key: "k-cancelled", status: "cancelled" }),
      validRow({ sample_key: "k-in-progress", status: "in_progress" }),
      validRow({ sample_key: "k-unverified", status: "unverified" }),
      validRow({ sample_key: "k-e2e", timing_kind: "request_e2e" }),
      validRow({ sample_key: "k-span", timing_kind: "item_span_estimate" }),
      validRow({ sample_key: "k-main", agent_kind: "main" }),
      validRow({ sample_key: "k-sub", agent_kind: "subagent" }),
      validRow({ sample_key: "k-unknown", agent_kind: "unknown" }),
    ]) {
      insertRawRow(db, row);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c, 10);
  } finally {
    store.close();
    await cleanupDir(dir);
  }
});

test("★E STRICT 类型：REAL / 非数字 TEXT 写 INTEGER 列必须失败；数字串会被无损换算（实测记录）", async () => {
  const { dir, store } = await makeWritableStore();
  try {
    const db = store.database;
    assert.throws(
      () => insertRawRow(db, validRow({ duration_ms: 1.5 })),
      (error) => {
        assert.equal(error.errcode, 3091, "SQLITE_CONSTRAINT_DATATYPE");
        assert.match(String(error.message), /cannot store REAL value in INTEGER column/);
        return true;
      },
    );
    assert.throws(
      () => insertRawRow(db, validRow({ output_tokens: "abc" })),
      (error) => {
        assert.equal(error.errcode, 3091);
        assert.match(String(error.message), /cannot store TEXT value in INTEGER column/);
        return true;
      },
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c, 0);

    // 🟦 实测（不是假设）：STRICT 表**允许**把无损数字串换算成 INTEGER。
    insertRawRow(db, validRow({ sample_key: "k-numeric-text", output_tokens: "7" }));
    const row = db
      .prepare("SELECT output_tokens, typeof(output_tokens) AS t FROM perf_samples WHERE sample_key = 'k-numeric-text'")
      .get();
    assert.equal(Number(row.output_tokens), 7);
    assert.equal(String(row.t), "integer");
    // ⇒ 因此"驱动层类型正确"不能靠 STRICT 兜底；编解码这层必须自己拒（下一用例）。
    assert.throws(
      () => encodePerfSample({ ...normalizedSample(), outputTokens: "7" }),
      (error) => {
        assert.equal(error.code, "INVALID_FIELD_TYPE");
        assert.match(String(error.message), /outputTokens/);
        return true;
      },
      "encode 必须拒绝字符串数字（STRICT 会悄悄接受它）",
    );
  } finally {
    store.close();
    await cleanupDir(dir);
  }
});

test("★E 名字类：空 model / 空 agent 允许；空 source_kind / 空 home_id 必须失败", async () => {
  const { dir, store } = await makeWritableStore();
  try {
    const db = store.database;
    insertRawRow(
      db,
      validRow({ sample_key: "k-empty-names", model: "", agent: "", model_provider: "", reasoning_effort: "" }),
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c,
      1,
      "空名字必须允许（缺失只有空串一个字面量）",
    );
    for (const [column, value] of [
      ["source_kind", ""],
      ["home_id", ""],
    ]) {
      assert.throws(
        () => insertRawRow(db, validRow({ sample_key: `k-${column}`, [column]: value })),
        (error) => {
          assert.equal(error.errcode, 275);
          assert.match(String(error.message), /CHECK constraint failed/);
          return true;
        },
        `${column} 不允许空串`,
      );
    }
    // 名字类列仍不允许 NULL（缺失是空串，不是 NULL）。
    assert.throws(
      () => insertRawRow(db, validRow({ sample_key: "k-null-model", model: null })),
      (error) => {
        assert.equal(error.errcode, 1299, "SQLITE_CONSTRAINT_NOTNULL");
        return true;
      },
    );
  } finally {
    store.close();
    await cleanupDir(dir);
  }
});

test("★E 主键：STRICT 表的主键列隐含 NOT NULL，且重复主键失败（🟦 实测）", async () => {
  const { dir, store } = await makeWritableStore();
  try {
    const db = store.database;
    assert.throws(
      () => insertRawRow(db, validRow({ sample_key: null })),
      (error) => {
        assert.equal(error.errcode, 1299, "STRICT 表主键列实测为 NOT NULL（table_info 也报 notnull=1）");
        return true;
      },
    );
    insertRawRow(db, validRow({ sample_key: "k-dup" }));
    assert.throws(
      () => insertRawRow(db, validRow({ sample_key: "k-dup" })),
      (error) => {
        assert.equal(error.errcode, 1555, "SQLITE_CONSTRAINT_PRIMARYKEY");
        return true;
      },
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c, 1);
  } finally {
    store.close();
    await cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// ★ F：既有数据不得丢失
// ---------------------------------------------------------------------------

test("★F v11 夹具里的 events / rate_limit_observations / store_meta / source_files 逐行不变（行数 + 内容哈希；store_meta 既有键不变、只允许新增读取器标记）", async () => {
  const fixture = await makeV11Fixture();
  try {
    const before = inspect(fixture.databaseFile);
    let snapshot;
    try {
      snapshot = {
        events: contentHash(before, "SELECT * FROM events ORDER BY id"),
        eventsCount: Number(before.prepare("SELECT COUNT(*) AS c FROM events").get().c),
        rateLimits: contentHash(
          before,
          "SELECT * FROM rate_limit_observations ORDER BY source_path, line_number, role",
        ),
        rateLimitsCount: Number(before.prepare("SELECT COUNT(*) AS c FROM rate_limit_observations").get().c),
        metaRows: before
          .prepare("SELECT key, value FROM store_meta ORDER BY key")
          .all()
          .map((row) => [String(row.key), String(row.value)]),
        userVersion: userVersion(before),
      };
    } finally {
      before.close();
    }
    assert.equal(snapshot.eventsCount, 2);
    assert.equal(snapshot.rateLimitsCount, 1);
    assert.equal(snapshot.userVersion, 11);

    const store = await openStore(fixture.dir, fixture.databaseFile);
    store.close();

    const after = inspect(fixture.databaseFile);
    try {
      assert.equal(contentHash(after, "SELECT * FROM events ORDER BY id"), snapshot.events, "events 内容哈希必须不变");
      assert.equal(
        contentHash(after, "SELECT * FROM rate_limit_observations ORDER BY source_path, line_number, role"),
        snapshot.rateLimits,
        "rate_limit_observations 内容哈希必须不变",
      );
      // `store_meta`：迁移**不得改写既有键**。但 `open()` 在读完迁移后会有一次合法的
      // 一次性写入 `codex_rollout_reader_version`（zstd 读取器上线时的重读标记，见
      // `src/usage-store.js` 的 `CODEX_ROLLOUT_READER_VERSION` 分支与
      // `test/codex-rollout-compression.test.js`）。冻结的 v11 库早于该标记，所以这里按
      // "既有键逐行不变 + 新增键只有这一个"来断言，而不是整表哈希。
      const afterMeta = after.prepare("SELECT key, value FROM store_meta ORDER BY key").all();
      const beforeByKey = new Map(snapshot.metaRows);
      const afterByKey = new Map(afterMeta.map((row) => [String(row.key), String(row.value)]));
      assert.deepEqual(
        snapshot.metaRows.map(([key, value]) => [key, afterByKey.get(key), value]),
        snapshot.metaRows.map(([key, value]) => [key, value, value]),
        "store_meta 既有键不得被迁移改写",
      );
      assert.deepEqual(
        afterMeta.map((row) => String(row.key)).filter((key) => !beforeByKey.has(key)),
        ["codex_rollout_reader_version"],
        "迁移只允许新增读取器版本标记这一个键",
      );
      assert.equal(afterByKey.get("codex_rollout_reader_version"), "zstd-jsonl-v1");
      assert.equal(Number(after.prepare("SELECT COUNT(*) AS c FROM events").get().c), snapshot.eventsCount);
      assert.equal(
        Number(after.prepare("SELECT COUNT(*) AS c FROM rate_limit_observations").get().c),
        snapshot.rateLimitsCount,
      );
      assert.equal(userVersion(after), 17);
      // 标脏只动 size/mtime_ms，不动 kind/home/路径等归属列。
      const rows = after
        .prepare("SELECT path, kind, home_id, home_label, home_path, indexed_at FROM source_files ORDER BY path")
        .all();
      assert.deepEqual(
        rows.map((row) => [
          String(row.path),
          String(row.kind),
          String(row.home_id),
          String(row.home_label),
          String(row.home_path),
          String(row.indexed_at),
        ]),
        [
          ["/v11/dsh-session.jsonl", "dsh", "home-b", "Home B", "/v11", "2026-10-01T00:00:00.000Z"],
          ["/v11/zcode.db", "zcode", "home-a", "Home A", "/v11", "2026-10-01T00:00:00.000Z"],
        ],
        "标脏不得改写来源归属列",
      );
    } finally {
      after.close();
    }
  } finally {
    await cleanupDir(fixture.dir);
  }
});

// ---------------------------------------------------------------------------
// ★ G：幂等性（AN-8）
// ---------------------------------------------------------------------------

test("★G 重复打开无害：版本仍 15、表与行数不变、且迁移的标脏 UPDATE 不重跑（哨兵值实测）", async () => {
  const fixture = await makeV11Fixture();
  try {
    const first = await openStore(fixture.dir, fixture.databaseFile);
    const sample = normalizedSample({ sourcePath: "/v11/zcode.db" });
    first.insertPerfSample(sample);
    const firstDdl = objectDefinition(first.database, "perf_samples").sql;
    const dirtyAfterMigration = sourceFilesFingerprint(first.database).map((row) => [
      String(row.path),
      Number(row.size),
      Number(row.mtime_ms),
    ]);
    assert.deepEqual(dirtyAfterMigration, [
      ["/v11/dsh-session.jsonl", -1, -1],
      ["/v11/zcode.db", -1, -1],
    ]);
    first.close();

    // 判别式：把 size/mtime 改成哨兵。若第二次打开重跑了 v11→12 的标脏，它们会再变回 -1。
    const probe = inspect(fixture.databaseFile);
    try {
      probe.exec("UPDATE source_files SET size = 424242, mtime_ms = 424242");
    } finally {
      probe.close();
    }

    const second = await openStore(fixture.dir, fixture.databaseFile);
    try {
      assert.equal(userVersion(second.database), 17, "第二次打开不得再抬版本");
      assert.equal(objectDefinition(second.database, "perf_samples").sql, firstDdl, "DDL 不得被重写");
      assert.equal(second.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c, 1, "行数不得变");
      assert.deepEqual(second.perfSampleByKey(sample.sampleKey), sample, "行内容不得变");
      assert.deepEqual(
        sourceFilesFingerprint(second.database).map((row) => [
          String(row.path),
          Number(row.size),
          Number(row.mtime_ms),
        ]),
        [
          ["/v11/dsh-session.jsonl", 424242, 424242],
          ["/v11/zcode.db", 424242, 424242],
        ],
        "v15 打开不得重跑迁移标脏（哨兵必须原样保留）",
      );
      // 三个索引也不得被重复创建成重复项。
      assert.deepEqual(
        tableIndexes(second.database, "perf_samples").map((index) => index.name),
        ["perf_samples_home_ts_idx", "perf_samples_source_kind_home_ts_idx", "perf_samples_source_path_idx"],
      );
    } finally {
      second.close();
    }
  } finally {
    await cleanupDir(fixture.dir);
  }
});

test("★G 四类夹具都实测可达：空库 / 当前版本（v15） / v11 夹具迁移 / 重开库", async () => {
  const fixture = await makeV11Fixture();
  const freshDir = await makeTempDir();
  try {
    // 夹具一：空库（version 0）。
    const emptyFile = path.join(freshDir, "empty.sqlite");
    const empty = await openStore(freshDir, emptyFile);
    assert.equal(userVersion(empty.database), 17);
    empty.close();

    // 夹具二：v11 夹具迁移（同一份库连续打开三次，串行，避免双写连接互相争锁）。
    const migrated = await openStore(fixture.dir, fixture.databaseFile);
    assert.equal(userVersion(migrated.database), 17);
    assert.ok(objectDefinition(migrated.database, "perf_samples"));
    migrated.close();

    // 夹具三：当前版本（v15）再打开 —— 不跑任何迁移段，且标脏不重跑（哨兵判别式见上一个用例）。
    const probe = inspect(fixture.databaseFile);
    try {
      probe.exec("UPDATE source_files SET size = 777, mtime_ms = 777");
    } finally {
      probe.close();
    }
    const current = await openStore(fixture.dir, fixture.databaseFile);
    assert.equal(userVersion(current.database), 17);
    assert.deepEqual(
      sourceFilesFingerprint(current.database).map((row) => Number(row.size)),
      [777, 777],
      "v15 打开不得再次标脏",
    );
    current.close();

    // 夹具四：重开库 —— 同一实例关闭后再开（幂等）。
    const reopened = await openStore(fixture.dir, fixture.databaseFile);
    assert.equal(userVersion(reopened.database), 17);
    reopened.close();
  } finally {
    await cleanupDir(fixture.dir);
    await cleanupDir(freshDir);
  }
});

// ---------------------------------------------------------------------------
// ★ H：失败回滚
// ---------------------------------------------------------------------------

test("★H 迁移中途失败（触发器 ABORT 在标脏那一步）⇒ 回滚：版本仍 11、perf_samples 不存在、旧数据不变；去掉注入后重试成功", async () => {
  const fixture = await makeV11Fixture({
    mutate: (db) => {
      db.exec(
        "CREATE TRIGGER v11_block_dirty BEFORE UPDATE ON source_files BEGIN SELECT RAISE(ABORT, 'blocked dirty'); END",
      );
    },
  });
  try {
    const store = makeStore(fixture.dir, fixture.databaseFile);
    await assert.rejects(
      () => store.open(),
      (error) => {
        assert.match(String(error.message), /blocked dirty/);
        return true;
      },
      "标脏被注入的触发器打断 ⇒ open 必须抛",
    );

    const after = inspect(fixture.databaseFile);
    try {
      assert.equal(userVersion(after), 11, "失败后版本必须仍是 11（不得把旧索引当已升级）");
      assert.equal(objectDefinition(after, "perf_samples"), null, "事务内的 CREATE TABLE 必须一起回滚");
      assert.deepEqual(
        sourceFilesFingerprint(after).map((row) => [String(row.path), Number(row.size)]),
        [
          ["/v11/dsh-session.jsonl", 2222],
          ["/v11/zcode.db", 1111],
        ],
        "标脏也必须回滚",
      );
      assert.equal(Number(after.prepare("SELECT COUNT(*) AS c FROM events").get().c), 2);
      after.exec("DROP TRIGGER v11_block_dirty");
    } finally {
      after.close();
    }

    // 同一份库重试：必须能成功迁移（失败不留死局）。
    const retry = await openStore(fixture.dir, fixture.databaseFile);
    try {
      assert.equal(userVersion(retry.database), 17);
      assert.ok(objectDefinition(retry.database, "perf_samples"));
      assert.deepEqual(
        sourceFilesFingerprint(retry.database).map((row) => [String(row.path), Number(row.size)]),
        [
          ["/v11/dsh-session.jsonl", -1],
          ["/v11/zcode.db", -1],
        ],
        "重试成功后才标脏",
      );
    } finally {
      retry.close();
    }
  } finally {
    await cleanupDir(fixture.dir);
  }
});

test("★H 陈旧错形状的 perf_samples ⇒ 迁移整体失败并回滚（版本仍 11，旧表原样保留，不当作已升级）", async () => {
  const fixture = await makeV11Fixture({
    mutate: (db) => {
      db.exec("CREATE TABLE perf_samples (sample_key TEXT PRIMARY KEY, stale_column TEXT) STRICT");
    },
  });
  try {
    const store = makeStore(fixture.dir, fixture.databaseFile);
    // 实测（🟩）：`CREATE TABLE IF NOT EXISTS` 对同名旧表静默放过，随后 DDL 里的
    // `CREATE INDEX … ON perf_samples(source_path)` 先报 `no such column: source_path`
    // （errcode 1），**早于**事务内自检。要紧的是整段迁移一起回滚，而不是谁先报错。
    await assert.rejects(
      () => store.open(),
      (error) => {
        assert.equal(error.code, "ERR_SQLITE_ERROR");
        assert.match(String(error.message), /no such column: source_path/);
        return true;
      },
      "错形状的旧表必须让迁移失败",
    );
    const after = inspect(fixture.databaseFile);
    try {
      assert.equal(userVersion(after), 11, "失败后版本必须仍是 11（不得把旧库当已升级）");
      assert.deepEqual(
        tableColumns(after, "perf_samples").map((column) => column.name),
        ["sample_key", "stale_column"],
        "旧表必须原样保留（既不被「修好」，也不被静默当作已迁移）",
      );
      assert.deepEqual(
        sourceFilesFingerprint(after).map((row) => [String(row.path), Number(row.size)]),
        [
          ["/v11/dsh-session.jsonl", 2222],
          ["/v11/zcode.db", 1111],
        ],
        "标脏必须一起回滚",
      );
    } finally {
      after.close();
    }
  } finally {
    await cleanupDir(fixture.dir);
  }
});

test("★H 自检能抓住 SQLite DDL 自己抓不到的漂移：列集不对但索引列齐备 ⇒ PERF_SAMPLES_SCHEMA_MISMATCH", async () => {
  // 最现实的陈旧场景：早期草稿建过一张"列不全但被索引的列都在"的 perf_samples。
  // 三条 CREATE INDEX 都能成功，SQLite 不会报任何错 —— 只有事务内自检能发现。
  const fixture = await makeV11Fixture({
    mutate: (db) => {
      db.exec(
        "CREATE TABLE perf_samples (sample_key TEXT PRIMARY KEY, source_path TEXT NOT NULL, source_kind TEXT NOT NULL, home_id TEXT NOT NULL, ts_ms INTEGER) STRICT",
      );
    },
  });
  try {
    const store = makeStore(fixture.dir, fixture.databaseFile);
    await assert.rejects(
      () => store.open(),
      (error) => {
        assert.equal(error.name, "PerfSampleCodecError");
        assert.equal(error.code, "PERF_SAMPLES_SCHEMA_MISMATCH");
        assert.match(String(error.message), /perf_samples/);
        return true;
      },
      "列集漂移必须由事务内自检拦住（DDL 文本本身拦不住）",
    );
    const after = inspect(fixture.databaseFile);
    try {
      assert.equal(userVersion(after), 11, "自检失败后版本必须仍是 11");
      assert.deepEqual(
        tableColumns(after, "perf_samples").map((column) => column.name),
        ["sample_key", "source_path", "source_kind", "home_id", "ts_ms"],
        "错误形状的旧表必须原样保留",
      );
      assert.deepEqual(
        sourceFilesFingerprint(after).map((row) => [String(row.path), Number(row.size)]),
        [
          ["/v11/dsh-session.jsonl", 2222],
          ["/v11/zcode.db", 1111],
        ],
        "标脏必须一起回滚",
      );
    } finally {
      after.close();
    }
  } finally {
    await cleanupDir(fixture.dir);
  }
});

test("★H 同名 VIEW 伪装 perf_samples ⇒ 迁移失败并整体回滚（实测：视图上的 CREATE INDEX 报错）", async () => {
  const fixture = await makeV11Fixture({
    mutate: (db) => {
      db.exec("CREATE VIEW perf_samples AS SELECT 1 AS x");
    },
  });
  try {
    const store = makeStore(fixture.dir, fixture.databaseFile);
    await assert.rejects(
      () => store.open(),
      (error) => {
        // 实测（🟩）：`CREATE TABLE IF NOT EXISTS` 对同名视图静默通过（probe2 结论），
        // 随后 `CREATE INDEX` 报 `views may not be indexed`。
        assert.equal(error.code, "ERR_SQLITE_ERROR");
        assert.match(String(error.message), /views may not be indexed/);
        return true;
      },
      "同名视图必须让迁移失败（否则会把视图当成建好的表）",
    );
    const after = inspect(fixture.databaseFile);
    try {
      assert.equal(userVersion(after), 11);
      assert.equal(objectDefinition(after, "perf_samples").type, "view", "视图仍在（迁移整体回滚）");
      assert.equal(
        after.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'perf_samples'").get().c,
        0,
      );
    } finally {
      after.close();
    }
  } finally {
    await cleanupDir(fixture.dir);
  }
});

// ---------------------------------------------------------------------------
// 编解码防线与编解码自身的判别力
// ---------------------------------------------------------------------------

test("编解码防线：encode 拒绝非归一化输入并指出字段名；decode 拒绝坏链与坏类型", () => {
  const sample = normalizedSample();
  assert.deepEqual(Object.keys(encodePerfSample(sample)), EXPECTED_COLUMNS, "行对象键必须是 31 个列名且同序");

  const rejects = [
    [
      "缺字段（而不是写成 NULL）",
      (() => {
        const copy = { ...sample };
        delete copy.diagnosticReasonChain;
        return copy;
      })(),
      "MISSING_FIELD",
    ],
    ["非对象输入", null, "INVALID_SAMPLE"],
    ["文本字段给了数字", { ...sample, model: 5 }, "INVALID_FIELD_TYPE"],
    ["整数字段给了字符串", { ...sample, durationMs: "2500" }, "INVALID_FIELD_TYPE"],
    ["整数字段给了非安全整数", { ...sample, durationMs: Number.MAX_SAFE_INTEGER + 2 }, "INVALID_FIELD_TYPE"],
    ["整数字段给了真小数", { ...sample, outputTokens: 1.5 }, "INVALID_FIELD_TYPE"],
    ["flags 给了负数", { ...sample, sampleFlags: -1 }, "INVALID_FIELD_TYPE"],
    ["链给了字符串", { ...sample, diagnosticReasonChain: "output_zero" }, "INVALID_FIELD_TYPE"],
    ["链给了数字数组", { ...sample, diagnosticReasonChain: [1, 2] }, "INVALID_FIELD_TYPE"],
  ];
  for (const [label, value, code] of rejects) {
    assert.throws(
      () => encodePerfSample(value),
      (error) => {
        assert.ok(error instanceof PerfSampleCodecError, `${label} 必须是 PerfSampleCodecError`);
        assert.equal(error.code, code, label);
        return true;
      },
      label,
    );
  }

  // 判别式可达性：合法样本与"显式 null 链"都必须通过（否则上面的拒绝可能只是编解码整体坏了）。
  assert.ok(encodePerfSample(sample).sample_key);
  assert.equal(encodePerfSample({ ...sample, diagnosticReasonChain: null }).diagnostic_reason_chain, null);

  const row = encodePerfSample(sample);
  const decodeRejects = [
    [
      "行缺列",
      (() => {
        const copy = { ...row };
        delete copy.home_id;
        return copy;
      })(),
      "MISSING_COLUMN",
    ],
    ["行不是对象", 7, "INVALID_ROW"],
    ["链不是 JSON", { ...row, diagnostic_reason_chain: "output_zero" }, "INVALID_REASON_CHAIN"],
    ["链是对象", { ...row, diagnostic_reason_chain: '{"a":1}' }, "INVALID_REASON_CHAIN"],
    ["链是数字数组", { ...row, diagnostic_reason_chain: "[1,2]" }, "INVALID_REASON_CHAIN"],
    ["文本列给了数字", { ...row, model: 5 }, "INVALID_COLUMN_TYPE"],
    ["整数列给了小数", { ...row, duration_ms: 2.5 }, "INVALID_COLUMN_TYPE"],
  ];
  for (const [label, value, code] of decodeRejects) {
    assert.throws(
      () => decodePerfSample(value),
      (error) => {
        assert.equal(error.code, code, label);
        return true;
      },
      label,
    );
  }
  assert.deepEqual(decodePerfSample(row), sample, "合法行必须原样解回");
});

test("★AO-4 提示与 M1 实测不符：`chain 非空 ⇔ flags≠0` 双向都不成立 ⇒ 不得写成 CHECK 约束", () => {
  // 反例一：flags≠0 但链为空（结构化 flag 与来源过滤位都不产生原因）。
  const flagsWithoutChain = normalizedSample({ identity: ["ao4-a"], partialItemSpan: true });
  assert.notEqual(flagsWithoutChain.sampleFlags, 0);
  assert.deepEqual(flagsWithoutChain.diagnosticReasonChain, []);

  // 反例二：链非空但 flags=0（语义漂移只记原因、不置位）。
  const chainWithoutFlags = normalizedSample({ identity: ["ao4-b"], window: "turn" });
  assert.equal(chainWithoutFlags.sampleFlags, 0);
  assert.deepEqual(chainWithoutFlags.diagnosticReasonChain, ["source_semantics_mismatch"]);

  // 因此两者都只能如实存原值：不补位、不补链、不把关系写成 CHECK。
  const encoded = encodePerfSample(flagsWithoutChain);
  assert.equal(encoded.diagnostic_reason_chain, "[]");
  assert.deepEqual(decodePerfSample(encoded).diagnosticReasonChain, []);
  assert.deepEqual(decodePerfSample(encodePerfSample(chainWithoutFlags)).diagnosticReasonChain, [
    "source_semantics_mismatch",
  ]);
});

test("perfSampleByKey 未命中返回 null（判别式可达：库为空时也必须给出 null 而不是抛错）", async () => {
  const dir = await makeTempDir();
  try {
    const store = await openStore(dir, path.join(dir, "usage-index.sqlite"));
    try {
      assert.equal(store.perfSampleByKey('["zcode","home-a","row-9999"]'), null);
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(dir);
  }
});

// ===========================================================================
// M3.2：`replaceFile` 单文件事务接 ZCode（**生产链路第一个候选写入者**）
// ===========================================================================
//
// 权威依据：卡片 [M3-index.md](../../docs/plans/2026-10-04-model-tps-implementation/M3-index.md) §M3.2
// （`:13-17`）、方案 §4 `:53-58`、`M3.1.md` 附录 B 的 10 条调用方不变量。
//
// 三条本组特有的方法学要求：
// ① **回滚必须逐类实测**（指纹 / events / rate_limit / perf_samples 四类），"回滚没抛错"不算证据。
// ② **WAL-only 改动**必须被指纹捕捉（只看主库字节会漏）。
// ③ **`not_enabled` ≠ `degraded`**：未启用来源不得产生 0 TPS，也不得伪造样本。

import { mkdirSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";

import {
  PERF_SOURCE_READERS,
  classifyPerfSources,
  enabledPerfSourceKinds,
  normalizeRawSample,
  resolvePerfSourceReader,
  streamPerfSamplesForFile,
} from "../src/perf-sources/index.js";
import { ZCODE_SELECT_COLUMNS, streamZcodePerfSamples } from "../src/perf-sources/zcode.js";
import { streamOpencodePerfSamples } from "../src/perf-sources/opencode.js";
import { zcodeSourceStat } from "../src/zcode-usage.js";

// ---------------------------------------------------------------------------
// ZCode 夹具（照 test/perf-zcode.test.js 的 `createFixtureDatabase` 约定，但自持一份）
// ---------------------------------------------------------------------------

const ZC_BASE_TS = 1_700_000_000_000;

/** 一条 ZCode `model_usage` 行（只填白名单列，其余为 NULL）。 */
function zcodeRow(id, overrides = {}) {
  return {
    id,
    session_id: "session-1",
    status: "completed",
    attempt_index: 0,
    retry_count: 0,
    retryable: 0,
    cancelled_by_user: 0,
    started_at: ZC_BASE_TS,
    completed_at: ZC_BASE_TS + 1000,
    duration_ms: 1000,
    input_tokens: 10,
    output_tokens: 20,
    logical_request_id: "lr-1",
    agent: "agent-name",
    query_source: "main",
    task_type: "chat",
    model_id: "fixture-model",
    provider_id: "fixture-provider",
    variant: "fixture-variant",
    ...overrides,
  };
}

/** 建一个真实 ZCode 上游库；`walRows` 在**同一个打开的连接**里追加（写进 -wal 而不 checkpoint）。 */
function createZcodeDatabase(dbFile, rows, { walRows = null } = {}) {
  const columns = [...ZCODE_SELECT_COLUMNS];
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE "model_usage" (${columns.map((c) => `"${c}"`).join(", ")})`);
  const statement = db.prepare(
    `INSERT INTO "model_usage" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  );
  for (const row of rows) statement.run(...columns.map((c) => (Object.hasOwn(row, c) ? row[c] : null)));
  if (walRows !== null) {
    // 追加行后**不关闭** ⇒ 数据留在 -wal 里（若关闭，SQLite 会在关闭时 checkpoint 进主库）。
    db.prepare(
      `INSERT INTO "model_usage" (id, status, output_tokens, started_at, completed_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      walRows.id,
      walRows.status || "completed",
      walRows.output_tokens ?? 30,
      walRows.started_at ?? ZC_BASE_TS + 5000,
      walRows.completed_at ?? ZC_BASE_TS + 6000,
      walRows.duration_ms ?? 1000,
    );
    return db; // 调用方负责在需要时 close
  }
  db.close();
  return null;
}

/**
 * M3.2 工作区：`root/zcode-home/db.sqlite` + 独立索引库。
 * `source` 与 discovery 的 home **同形**（`{id,label,path,kind}`）。
 */
async function makeZcodeWorkspace({ rows = [zcodeRow("r1"), zcodeRow("r2")], walRows = null } = {}) {
  const root = await makeTempDir();
  const homeDir = path.join(root, "zcode-home");
  mkdirSync(homeDir, { recursive: true });
  const dbFile = path.join(homeDir, "db.sqlite");
  const storeFile = path.join(root, "usage-index.sqlite");
  const walWriter = createZcodeDatabase(dbFile, rows, { walRows });
  const source = { id: "zcode-home", label: "ZCode Home", path: homeDir, kind: "zcode", usageLogPath: dbFile };
  return {
    root,
    homeDir,
    dbFile,
    storeFile,
    source,
    walWriter,
    /** 上游库 + `-wal` 指纹（与 `usageFiles` 用的是同一个函数）。 */
    stat: () => zcodeSourceStat(dbFile),
  };
}

/** 打开 store 并返回一个已注册来源的 `file` 参数。 */
async function openZcodeStore(workspace) {
  const store = await openStore(workspace.root, workspace.storeFile);
  const info = await workspace.stat();
  return { store, file: { filePath: workspace.dbFile, source: workspace.source, info } };
}

/** 打开一个真实 ZCode 连接（用来在 -wal 里追加行，不 checkpoint）。 */
function openZcodeWriter(dbFile) {
  return new DatabaseSync(dbFile);
}

// --- 四类数据的快照/比对工具（gate A 的核心：逐类比对表内容）---

/**
 * 四类本文件变化的快照。
 * ① `source_files` 行（含 `indexed_at`，因为它是 upsert 的一部分）
 * ② `events`
 * ③ `rate_limit_observations`
 * ④ `perf_samples`（用 M3.1 的 `encodePerfSample` 形状的原始行，直接 SELECT *）
 * 另附上游文件的字节哈希，用来证明"测试自己没改上游"。
 */
function snapshotFourKinds(db, filePath) {
  const sourceRow = db
    .prepare(
      "SELECT path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at FROM source_files WHERE path = ?",
    )
    .get(filePath);
  return {
    sourceFile: sourceRow === undefined ? null : { ...sourceRow },
    events: db
      .prepare("SELECT * FROM events WHERE source_path = ? ORDER BY id")
      .all(filePath)
      .map((row) => ({ ...row })),
    rateLimits: db
      .prepare("SELECT * FROM rate_limit_observations WHERE source_path = ? ORDER BY line_number, role")
      .all(filePath)
      .map((row) => ({ ...row })),
    perf: db
      .prepare("SELECT * FROM perf_samples WHERE source_path = ? ORDER BY sample_key")
      .all(filePath)
      .map((row) => ({ ...row })),
  };
}

/** 逐类断言两个快照相同，并**分别报出是哪一类不同**。 */
function assertFourKindsEqual(actual, expected, label) {
  assert.deepEqual(actual.sourceFile, expected.sourceFile, `${label}：① 源文件指纹必须回滚`);
  assert.deepEqual(actual.events, expected.events, `${label}：② events 必须回滚`);
  assert.deepEqual(actual.rateLimits, expected.rateLimits, `${label}：③ rate_limit_observations 必须回滚`);
  assert.deepEqual(actual.perf, expected.perf, `${label}：④ perf_samples 必须回滚`);
}

// ---------------------------------------------------------------------------
// 注册表：结构 / not_enabled / unsupported（gate E 的前半）
// ---------------------------------------------------------------------------

test("★E 注册表：M7 启用五类候选来源，project-log 为 unsupported", () => {
  assert.deepEqual([...PERF_SOURCE_READERS.keys()], ["zcode", "dsh", "opencode", "codex", "workbuddy"]);
  assert.deepEqual(enabledPerfSourceKinds(), ["zcode", "dsh", "opencode", "codex", "workbuddy"]);

  assert.deepEqual(resolvePerfSourceReader("zcode"), {
    kind: "zcode",
    state: "enabled",
    reader: streamZcodePerfSamples,
  });
  assert.equal(resolvePerfSourceReader("dsh").state, "enabled");
  assert.equal(typeof resolvePerfSourceReader("dsh").reader, "function");
  assert.deepEqual(resolvePerfSourceReader("opencode"), {
    kind: "opencode",
    state: "enabled",
    reader: streamOpencodePerfSamples,
  });
  for (const kind of ["codex", "main", "jetbrains", "extra"]) {
    const resolved = resolvePerfSourceReader(kind);
    assert.equal(resolved.state, "enabled", `${kind} 必须规范到已启用 Codex`);
    assert.equal(typeof resolved.reader, "function");
  }
  // 别名 `main/jetbrains/extra` 规范到已启用的 codex。
  assert.equal(resolvePerfSourceReader("main").kind, "codex");
  // project-log 是结构上不支持（方案 `:60`）：终态，不随注册表变化。
  assert.deepEqual(resolvePerfSourceReader("project-log"), { kind: "unsupported", state: "unsupported", reader: null });
});

test("★E classifyPerfSources 把来源分成三组（enabled / notEnabled / unsupported），不合并成「失败源」", () => {
  const classified = classifyPerfSources([
    { kind: "zcode", id: "h-zcode" },
    { kind: "dsh", id: "h-dsh" },
    { kind: "opencode", id: "h-opencode" },
    { kind: "main", id: "h-codex" },
    { kind: "project-log", id: "h-project" },
    { kind: "zcode", id: "h-zcode-2" },
  ]);
  assert.deepEqual(classified.enabled, [
    { kind: "zcode", homeId: "h-zcode" },
    { kind: "dsh", homeId: "h-dsh" },
    { kind: "opencode", homeId: "h-opencode" },
    { kind: "codex", homeId: "h-codex" },
    { kind: "zcode", homeId: "h-zcode-2" },
  ]);
  assert.deepEqual(classified.notEnabled, []);
  assert.deepEqual(classified.unsupported, [{ kind: "unsupported", homeId: "h-project" }]);
  // 三组互斥且并集完整（判别力：少一个来源会让并集变小）。
  assert.equal(classified.enabled.length + classified.notEnabled.length + classified.unsupported.length, 6);
});

test("★E Codex 禁止逐文件调度；project-log 仍是 unsupported", async () => {
  const workspace = await makeZcodeWorkspace();
  try {
    await assert.rejects(
      () => streamPerfSamplesForFile(workspace.dbFile, { ...workspace.source, kind: "codex" }, () => {}),
      { code: "UNSUPPORTED_SCHEMA" },
      "Codex 必须经线程聚合入口读取",
    );
    const result = await streamPerfSamplesForFile(
      workspace.dbFile,
      { ...workspace.source, kind: "project-log" },
      () => {},
    );
    assert.equal(result.stats, null);
    assert.equal(result.state, "unsupported");
  } finally {
    await cleanupDir(workspace.root);
  }
});

// ---------------------------------------------------------------------------
// 替换语义：第一次替换 / 重复同步不增样本（gate B）
// ---------------------------------------------------------------------------

test("★B 一次 replaceFile 写入全部候选；重复同步为【替换】而非追加（行数与内容都不变）", async () => {
  const workspace = await makeZcodeWorkspace();
  try {
    const { store, file } = await openZcodeStore(workspace);
    try {
      await store.replaceFile(file, {});
      const first = store.database
        .prepare("SELECT * FROM perf_samples ORDER BY sample_key")
        .all()
        .map((row) => ({ ...row }));
      assert.equal(first.length, 2, "两条 ZCode 行必须都写成候选");
      // 候选归属与身份
      for (const row of first) {
        assert.equal(String(row.source_path), workspace.dbFile, "归属必须是物理文件路径（外键目标）");
        assert.equal(String(row.source_kind), "zcode");
        assert.equal(String(row.home_id), "zcode-home");
        assert.equal(String(row.model), "fixture-model");
        assert.equal(String(row.status), "completed");
        assert.equal(Number(row.output_tokens), 20);
      }
      assert.deepEqual(first.map((row) => String(row.sample_key)).sort(), [
        '["zcode","zcode-home","r1"]',
        '["zcode","zcode-home","r2"]',
      ]);
      // 每行都能被 M3.1 的解码器读回（证明写进去的是**归一化**样本）
      for (const row of first) {
        const decoded = store.perfSampleByKey(String(row.sample_key));
        assert.equal(Object.keys(decoded).length, 31, "写库前必须归一化（31 字段）");
        assert.equal(decoded.homeId, "zcode-home");
      }

      // 第二次：同一 info ⇒ 必须替换而非追加
      await store.replaceFile(file, {});
      const second = store.database
        .prepare("SELECT * FROM perf_samples ORDER BY sample_key")
        .all()
        .map((row) => ({ ...row }));
      assert.equal(second.length, first.length, "重复同步不得增加候选数");
      assert.deepEqual(second, first, "重复同步的内容必须逐列相同（替换语义）");
      assert.equal(store.database.prepare("SELECT COUNT(*) AS c FROM events").get().c, 2, "events 同样不增");
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

test("★B 上游行数变化 ⇒ 候选数随之收缩（证明 DELETE 显式生效，而不是只增不减）", async () => {
  const workspace = await makeZcodeWorkspace({ rows: [zcodeRow("r1"), zcodeRow("r2"), zcodeRow("r3")] });
  try {
    const { store, file } = await openZcodeStore(workspace);
    try {
      await store.replaceFile(file, {});
      assert.equal(store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c, 3);
      // 删掉上游一行，重新 stat 后替换
      const writer = openZcodeWriter(workspace.dbFile);
      writer.prepare('DELETE FROM "model_usage" WHERE id = ?').run("r2");
      writer.close();
      const info = await workspace.stat();
      await store.replaceFile({ filePath: workspace.dbFile, source: workspace.source, info }, {});
      const keys = store.database
        .prepare("SELECT sample_key FROM perf_samples ORDER BY sample_key")
        .all()
        .map((r) => String(r.sample_key));
      assert.deepEqual(
        keys,
        ['["zcode","zcode-home","r1"]', '["zcode","zcode-home","r3"]'],
        "消失的上游行必须连带删除候选",
      );
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

// ---------------------------------------------------------------------------
// ★A 回滚必须覆盖四类（最重要）★ —— 三种失败注入，每次逐类比对
// ---------------------------------------------------------------------------

test("★A 注入 1：ZCode reader 在读上游时失败（上游被换成非 SQLite）⇒ 四类全部回滚", async () => {
  const workspace = await makeZcodeWorkspace();
  try {
    const { store, file } = await openZcodeStore(workspace);
    try {
      // 先成功索引一次，建立"已有正确数据"的基线。
      await store.replaceFile(file, {});
      const baseline = snapshotFourKinds(store.database, workspace.dbFile);
      assert.equal(baseline.perf.length, 2, "基线必须真的有候选（否则回滚断言无判别力）");
      assert.equal(baseline.events.length, 2, "基线必须真的有 events");
      const baselineUpstream = await stat(workspace.dbFile);

      // 注入：把上游库换成非 SQLite 文件（reader 的只读打开/读 schema 会失败），
      // 同时把 size/mtime 改掉，使"指纹"确实会被改写 ⇒ 回滚断言能抓指纹。
      await rm(workspace.dbFile, { force: true });
      await writeFile(workspace.dbFile, "not a sqlite database at all");
      const info = await workspace.stat();

      await assert.rejects(
        () => store.replaceFile({ filePath: workspace.dbFile, source: workspace.source, info }, {}),
        (error) => {
          // 🟩 实测：非 SQLite 文件的失败发生在 **events 阶段**（`streamUsageFileEvents` 先读同一路径），
          // 报 `ERR_SQLITE_ERROR / errcode 26 / file is not a database`，比 perf reader 更早。
          // 这不影响 gate A 的结论：要紧的是**整段事务回滚**，而不是谁先抛。
          assert.equal(error.code, "ERR_SQLITE_ERROR");
          assert.equal(error.errcode, 26);
          assert.match(String(error.message), /file is not a database/);
          return true;
        },
        "上游不是 SQLite ⇒ 必须抛出（致命路径）",
      );

      // 逐类比对：四类都必须回到基线。
      const after = snapshotFourKinds(store.database, workspace.dbFile);
      assertFourKindsEqual(after, baseline, "注入 1");
      // 上游本身不是本卡写的：只记录它确实被测试改了（不是被测代码改的）。
      const afterUpstream = await stat(workspace.dbFile);
      assert.notEqual(afterUpstream.size, baselineUpstream.size, "测试确实改动了上游（证明注入有效）");
      // source_files 行不得留下"已索引"的假象：size/mtime 必须是**基线**的值。
      assert.equal(Number(after.sourceFile.size), Number(baseline.sourceFile.size));
      assert.equal(Number(after.sourceFile.mtime_ms), Number(baseline.sourceFile.mtime_ms));
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

test("★A 注入 2：候选插入失败（违反 status 枚举）⇒ 四类全部回滚，且第一行也不留", async () => {
  const workspace = await makeZcodeWorkspace();
  try {
    const { store, file } = await openZcodeStore(workspace);
    try {
      await store.replaceFile(file, {});
      const baseline = snapshotFourKinds(store.database, workspace.dbFile);
      assert.equal(baseline.perf.length, 2);

      // 注入：让上游**多出一行**（这样指纹变化、events 会重写），并把它的 status 改成
      // 会让 CHECK 失败的非法值 —— reader 会把它归一化成 `unverified`（M1 兜底），
      // 因此这里改用**直接破坏插入**的方式：临时把 perf_samples 换成一个会拒绝第二行的表？
      // 不 —— 那样会污染别的用例。正确注入：篡改 store 的 `PERF_SAMPLE_INSERT_SQL` 不可行，
      // 改为在**上游**造出一行使 `encodePerfSample` 抛错：`status` 归一化后必然合法，
      // 因此用 `id` 造超长/非法？也合法。
      //
      // 结论（实测）：M1 的归一化把所有状态都收敛到五枚举，所以"非法状态"**不可达**。
      // 真正可达的插入失败注入是**主键冲突**：预先占掉第二行的 sample_key。
      const writer = openZcodeWriter(workspace.dbFile);
      writer
        .prepare(
          'INSERT INTO "model_usage" (id, status, output_tokens, started_at, completed_at, duration_ms) VALUES (?,?,?,?,?,?)',
        )
        .run("r9", "completed", 5, ZC_BASE_TS + 100, ZC_BASE_TS + 200, 100);
      writer.close();
      const info = await workspace.stat();

      // 主键冲突注入：把 r9 的候选先写进库（属于**另一个**来源，不会被本文件的 DELETE 清掉）。
      const colliding = store.database.prepare("SELECT 1").get(); // 占位，避免空语句
      void colliding;
      const otherFile = path.join(workspace.root, "other-home", "db.sqlite");
      mkdirSync(path.dirname(otherFile), { recursive: true });
      createZcodeDatabase(otherFile, [zcodeRow("r9")]);
      const otherInfo = await zcodeSourceStat(otherFile);
      await store.replaceFile(
        {
          filePath: otherFile,
          source: { id: "zcode-home", label: "ZCode Home", path: path.dirname(otherFile), kind: "zcode" },
          info: otherInfo,
        },
        {},
      );
      // 现在 `["zcode","zcode-home","r9"]` 已被 otherFile 占用 ⇒ 本文件插入同一 key 必撞主键。
      const occupied = store.database
        .prepare("SELECT sample_key, source_path FROM perf_samples WHERE sample_key = ?")
        .get('["zcode","zcode-home","r9"]');
      assert.ok(occupied, "占位候选必须存在（否则注入无效）");

      const beforeInjection = snapshotFourKinds(store.database, workspace.dbFile);
      await assert.rejects(
        () => store.replaceFile({ filePath: workspace.dbFile, source: workspace.source, info }, {}),
        (error) => {
          assert.equal(error.code, "ERR_SQLITE_ERROR");
          assert.equal(error.errcode, 1555, "必须是主键冲突");
          return true;
        },
        "主键冲突必须让整次替换失败",
      );
      const after = snapshotFourKinds(store.database, workspace.dbFile);
      assertFourKindsEqual(after, beforeInjection, "注入 2");
      // 关键：注入时上游已多一行（r9），若第一行 r1 的插入**没有**回滚，perf 会变 3 行。
      assert.equal(after.perf.length, 2, "半途回滚不得留下部分新行");
      assert.equal(
        store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c,
        3,
        "另 1 条属于 otherFile",
      );
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

test("★A 注入 3：ZCode reader 能力守护失败（缺必需列）⇒ 四类全部回滚", async () => {
  const workspace = await makeZcodeWorkspace();
  try {
    const { store, file } = await openZcodeStore(workspace);
    try {
      await store.replaceFile(file, {});
      const baseline = snapshotFourKinds(store.database, workspace.dbFile);

      // 注入：把 model_usage 换成缺 `completed_at` 的表。🟩 实测：这次失败**同样先发生在 events 阶段**
      // （`errcode 1 / no such column: completed_at`），而不是先到 perf reader 的能力守护。
      // 为了让 gate A 也覆盖「perf 段自己抛错」的路径，本用例**另外**断言 perf 段被真正走到过：
      // 一个内容合法但缺 `output_tokens` 的库，在 events 阶段能读通、必须由 perf reader 抛错。
      await rm(workspace.dbFile, { force: true });
      const broken = new DatabaseSync(workspace.dbFile);
      broken.exec(
        `CREATE TABLE "model_usage" (${[
          "id",
          "status",
          "started_at",
          "completed_at",
          "duration_ms",
          "input_tokens",
          "session_id",
          "model_id",
        ]
          .map((c) => `"${c}"`)
          .join(", ")})`,
      );
      broken
        .prepare(
          'INSERT INTO "model_usage" (id, status, started_at, completed_at, duration_ms, input_tokens, session_id, model_id) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run("r1", "completed", ZC_BASE_TS, ZC_BASE_TS + 1000, 1000, 10, "session-1", "fixture-model");
      broken.close();
      const info = await workspace.stat();

      await assert.rejects(
        () => store.replaceFile({ filePath: workspace.dbFile, source: workspace.source, info }, {}),
        (error) => {
          // 🟩 实测：**这一例真的走到了 perf reader 的能力守护**（events 阶段能读通这张表，
          // 因为缺的是 `output_tokens`，不是 events 需要的列）⇒ 抛 `ZcodeReadOnlyOpenError / UNSUPPORTED_SCHEMA`。
          // 这是三个注入里唯一由 **perf 段自己**触发失败的用例，因此它是"perf 失败也回滚四类"的直接证据。
          assert.equal(error.name, "ZcodeReadOnlyOpenError");
          assert.equal(error.code, "UNSUPPORTED_SCHEMA");
          assert.match(String(error.message), /output_tokens/);
          return true;
        },
        "缺 perf 必需列 ⇒ 必须由 perf reader 抛出",
      );
      assertFourKindsEqual(snapshotFourKinds(store.database, workspace.dbFile), baseline, "注入 3");
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

test("★C 上游只读打开失败（路径不存在）⇒ 抛错且四类回滚，不留「已索引」假象", async () => {
  const workspace = await makeZcodeWorkspace();
  try {
    const { store, file } = await openZcodeStore(workspace);
    try {
      await store.replaceFile(file, {});
      const baseline = snapshotFourKinds(store.database, workspace.dbFile);
      const missing = path.join(workspace.homeDir, "gone.sqlite");
      await assert.rejects(
        () => store.replaceFile({ filePath: missing, source: workspace.source, info: { size: 1, mtimeMs: 1 } }, {}),
        (error) => {
          // 🟩 实测：不存在的路径 ⇒ `streamUsageFileEvents` 抛 `ERR_SQLITE_ERROR / no such table: model_usage`
          // （events 阶段先失败）。同样不必是 `ZcodeReadOnlyOpenError` —— 关键仍是整段回滚。
          assert.equal(error.code, "ERR_SQLITE_ERROR");
          assert.match(String(error.message), /no such table|unable to open|not a database/);
          return true;
        },
      );
      // 原文件的四类数据不受影响
      assertFourKindsEqual(snapshotFourKinds(store.database, workspace.dbFile), baseline, "只读失败");
      // 失败的新路径不得留下 source_files 行（证明 insertSource 也回滚了）
      assert.equal(
        store.database.prepare("SELECT COUNT(*) AS c FROM source_files WHERE path = ?").get(missing).c,
        0,
        "失败的路径不得留下已索引的假象",
      );
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

// ---------------------------------------------------------------------------
// ★D WAL-only 改动触发重新提取
// ---------------------------------------------------------------------------

test("★D WAL-only 改动（主库字节不变）⇒ 指纹变化 ⇒ 必须重新提取到新候选", async () => {
  const workspace = await makeZcodeWorkspace();
  try {
    // 上游连接**保持打开**，把新行写进 -wal（不 checkpoint）。
    const writer = openZcodeWriter(workspace.dbFile);
    writer.exec("PRAGMA journal_mode = WAL");
    const statBefore = await workspace.stat();

    const { store, file } = await openZcodeStore(workspace);
    try {
      await store.replaceFile(file, {});
      assert.equal(store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c, 2);

      // 只往 -wal 追加一行；主库文件本身不改。
      const mainSizeBefore = (await stat(workspace.dbFile)).size;
      writer
        .prepare(
          'INSERT INTO "model_usage" (id, status, output_tokens, started_at, completed_at, duration_ms, session_id) VALUES (?,?,?,?,?,?,?)',
        )
        .run("wal-1", "completed", 42, ZC_BASE_TS + 9000, ZC_BASE_TS + 9500, 500, "session-1");
      const mainSizeAfter = (await stat(workspace.dbFile)).size;
      const statAfter = await workspace.stat();

      assert.equal(mainSizeAfter, mainSizeBefore, "主库字节必须不变（否则这不算 WAL-only 改动）");
      assert.ok(
        statAfter.size !== statBefore.size || statAfter.mtimeMs !== statBefore.mtimeMs,
        "zcodeSourceStat 必须捕捉 -wal 变化",
      );

      // 用新指纹替换 ⇒ 必须出现第三个候选
      await store.replaceFile({ filePath: workspace.dbFile, source: workspace.source, info: statAfter }, {});
      const keys = store.database
        .prepare("SELECT sample_key FROM perf_samples ORDER BY sample_key")
        .all()
        .map((r) => String(r.sample_key));
      assert.equal(keys.length, 3, "WAL-only 改动必须被重新提取");
      assert.ok(keys.includes('["zcode","zcode-home","wal-1"]'), "新增的 WAL 行必须成为候选");
    } finally {
      store.close();
      writer.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

test("★D 反向对照：WAL 未被改动时指纹稳定（否则上一条的「变化」可能只是时间噪音）", async () => {
  const workspace = await makeZcodeWorkspace();
  try {
    const first = await workspace.stat();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = await workspace.stat();
    assert.equal(second.size, first.size, "无写入时 size 不得漂移");
    assert.equal(second.mtimeMs, first.mtimeMs, "无写入时 mtime 不得漂移");
  } finally {
    await cleanupDir(workspace.root);
  }
});

// ---------------------------------------------------------------------------
// 只读不变量（卡片任务 4/6）
// ---------------------------------------------------------------------------

test("上游库以**只读**打开：索引期间上游字节与 mtime 都不变（不是「打开了就算只读」）", async () => {
  const workspace = await makeZcodeWorkspace();
  try {
    const before = await stat(workspace.dbFile);
    const { store, file } = await openZcodeStore(workspace);
    try {
      await store.replaceFile(file, {});
      assert.equal(store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c, 2);
      const after = await stat(workspace.dbFile);
      assert.equal(after.size, before.size, "索引不得改动上游主库字节");
      assert.equal(after.mtimeMs, before.mtimeMs, "索引不得改动上游 mtime");
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

test("★E unsupported 来源不产生 perf 候选；Codex 只能通过线程同步入口", async () => {
  const workspace = await makeZcodeWorkspace();
  try {
    const { store, file } = await openZcodeStore(workspace);
    try {
      await store.replaceFile(file, {});
      const baseline = snapshotFourKinds(store.database, workspace.dbFile);
      assert.equal(baseline.perf.length, 2, "基线必须真有候选");

      // 🟩 机制性判别式（不依赖任何 reader 的失败模式）：
      assert.equal(resolvePerfSourceReader("codex").state, "enabled");
      await assert.rejects(
        () => streamPerfSamplesForFile(workspace.dbFile, { ...workspace.source, kind: "codex" }, () => {}),
        { code: "UNSUPPORTED_SCHEMA" },
      );

      // project-log（unsupported）同理，且是终态。
      const projLog = await streamPerfSamplesForFile(
        workspace.dbFile,
        { ...workspace.source, kind: "project-log" },
        () => {
          throw new Error("project-log 不得调用 onSample");
        },
      );
      assert.equal(projLog.state, "unsupported");
      assert.equal(projLog.stats, null);

      // 关键：未启用/不支持的来源**不得追加**任何候选。这里用 project-log 走一次真实 replaceFile：
      // 🟩 实测 —— project-log 把这个 SQLite 文件当**文本行**读，于是**成功**（不抛错），
      // 因此它履行了"本文件的替换语义"：events 被重写、perf 候选被显式 DELETE 清空。
      // 那正是正确行为：候选**属于本文件**（`source_path` 是 filePath），换一种解析方式后旧候选必须消失。
      // 本用例要断言的是"**不得无中生有**"—— 0 ≤ 新行数 ≤ 基线行数，且新行里**没有**任何非 zcode 来源。
      const perfBefore = store.database
        .prepare("SELECT * FROM perf_samples ORDER BY sample_key")
        .all()
        .map((r) => ({ ...r }));
      try {
        await store.replaceFile(
          { filePath: workspace.dbFile, source: { ...workspace.source, kind: "project-log" }, info: file.info },
          {},
        );
      } catch {
        // project-log 解析失败也可接受：那说明整段回滚，perf 必须仍是基线。
      }
      const perfAfter = store.database
        .prepare("SELECT * FROM perf_samples ORDER BY sample_key")
        .all()
        .map((r) => ({ ...r }));
      assert.ok(perfAfter.length <= perfBefore.length, "未启用/不支持来源不得追加候选");
      for (const row of perfAfter) {
        assert.notEqual(String(row.source_kind), "project-log", "project-log 不得产生性能候选（方案 :60）");
        assert.notEqual(String(row.source_kind), "unsupported", "unsupported 不得产生性能候选");
      }

      // 反向：声明回 zcode ⇒ 候选回来（证明上面的判断来自来源决策，而不是 reader 坏了）
      await store.replaceFile({ filePath: workspace.dbFile, source: workspace.source, info: file.info }, {});
      assert.equal(store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c, 2);
      // ⚠️ 这里**不能**整体比对 `source_files` 行：这是一次**成功**的替换，`indexed_at` 会被正当刷新
      // （🟩 `insertSource` 每次都写新时间戳）。逐类比对只适用于**回滚**场景（gate A）。
      const restored = snapshotFourKinds(store.database, workspace.dbFile);
      assert.deepEqual(restored.perf, baseline.perf, "候选内容必须回到基线");
      assert.deepEqual(restored.events, baseline.events, "events 必须回到基线");
      assert.equal(restored.sourceFile.size, baseline.sourceFile.size);
      assert.equal(restored.sourceFile.mtime_ms, baseline.sourceFile.mtime_ms);
      assert.ok(
        typeof restored.sourceFile.indexed_at === "string" && restored.sourceFile.indexed_at.length > 0,
        "成功的替换必须留下 indexed_at",
      );
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

// ---------------------------------------------------------------------------
// 归一化这一步真的做了（M3.1 附录 B 不变量 5/6 的接线验证）
// ---------------------------------------------------------------------------

test("调度器在写库前做归一化：reader 出口是 36 键 raw，写库的是 31 字段样本", async () => {
  const workspace = await makeZcodeWorkspace({ rows: [zcodeRow("r1")] });
  try {
    const raw = [];
    await streamZcodePerfSamples(workspace.dbFile, workspace.source, (sample) => raw.push(sample));
    assert.equal(raw.length, 1);
    const rawKeys = Object.keys(raw[0]).length;
    assert.ok(rawKeys > 31, `reader 出口应当是 raw 候选（实测 ${rawKeys} 键），不是样本`);

    const normalized = [];
    await streamPerfSamplesForFile(workspace.dbFile, workspace.source, (sample) => normalized.push(sample));
    assert.equal(normalized.length, 1);
    assert.equal(Object.keys(normalized[0]).length, 31, "调度器必须交给 store 31 字段的归一化样本");
    // 同一份输入下，两条路径的信息不冲突：归一化保留了身份与归属。
    assert.equal(normalized[0].sampleKey, raw[0].sampleKey);
    assert.equal(normalized[0].homeId, raw[0].homeId);
    // 无法归一化的 raw 必须被**丢弃**（返回 null），不能写进库。
    assert.equal(normalizeRawSample({ sourceKind: "mystery" }), null);
    assert.ok(normalizeRawSample(raw[0]) !== null, "合法 raw 必须能归一化（否则上面的丢弃断言不可信）");
  } finally {
    await cleanupDir(workspace.root);
  }
});

test("归属用 filePath：多文件来源（source.path 是目录）也不会触外键失败", async () => {
  const workspace = await makeZcodeWorkspace();
  try {
    const { store } = await openZcodeStore(workspace);
    try {
      // source.path 指向**目录**（与 DSH/Codex 的 discovery 形状一致），filePath 是真文件。
      const dirSource = { id: "zcode-home", label: "ZCode Home", path: workspace.root, kind: "zcode" };
      const info = await workspace.stat();
      await store.replaceFile({ filePath: workspace.dbFile, source: dirSource, info }, {});
      const rows = store.database.prepare("SELECT source_path, home_id FROM perf_samples").all();
      assert.equal(rows.length, 2, "source.path 是目录时也必须能写入（不能触 787）");
      for (const row of rows) {
        assert.equal(String(row.source_path), workspace.dbFile, "归属必须是物理文件路径");
        assert.equal(String(row.home_id), "zcode-home", "home_id 仍取 source.id");
      }
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

// ===========================================================================
// M3.3：范围查询与源删除
// ===========================================================================
//
// 核心风险：**SQL 路径与 M1 内存路径的范围语义必须逐字同形**。
//
// 因此本组**每一条范围断言都是双路径比对**：同一组样本、同一组边界，
// 一路走 `perfCandidatesForRange()`（SQL），一路走 `selectPerfSamples()`（内存，冻结的 M1），
// 断言两者选出的 `sampleKey` 集合**完全相同**。
// **不得**用"SQL 能查出东西"代替"与内存路径选出同一集合"。
//
// M1 的范围语义（`src/perf-stats.js`，冻结 `af5fa41c…`，实测确认）：
// - `startMs` inclusive 下界；`null` = 无界
// - `endMs` inclusive 上界
// - `windowEndExclusiveMs` exclusive 上界，**存在时 `endMs` 被忽略**（`perfTsInRange`）
// - 三者都接受 `Date` 或有限数字；非有限值抛 `TypeError`

import { selectPerfSamples, summarizePerf } from "../src/perf-stats.js";

// ---------------------------------------------------------------------------
// 双路径比对的公共装置
// ---------------------------------------------------------------------------

const M33_BASE = 1_700_000_000_000;
const M33_START = M33_BASE;
const M33_END = M33_BASE + 1000;
// 范围内三个边界常量都在用例里直接以 `M33_START ± n` 表达（`tsMs = completed_at`），
// 因此不再单独保留一个"窗口位置"常量，避免出现没人使用的变量。

/**
 * 把一批 sampleKey 集合作规范化比较（排序 + 数组化）。
 * @param {Iterable<string>} keys
 */
function keyList(keys) {
  return [...keys].sort();
}

/**
 * **本组的核心断言**：同一组数据跑 SQL 路径与 M1 内存路径，选出**完全相同**的集合。
 *
 * @param {object} store 已打开的 store
 * @param {object[]} samples 全量内存样本（M1 的输入）
 * @param {object} range 传给两条路径的**同一**范围对象
 * @param {string[]} excludedHomeIds
 * @param {string} label
 */
function assertTwoPathsAgree(store, samples, range, excludedHomeIds, label) {
  const fromSql = store.perfCandidatesForRange(range, excludedHomeIds);
  const fromMemory = selectPerfSamples(samples, { range, excludedHomeIds });

  assert.deepEqual(
    keyList(fromSql.map((sample) => sample.sampleKey)),
    keyList(fromMemory.eligible.map((sample) => sample.sampleKey)),
    `${label}：SQL 路径与 M1 内存路径必须选出同一集合`,
  );
  return { fromSql, fromMemory };
}

/** 建一条候选行所需的完整 ZCode 夹具行（供 replaceFile 写入真实候选）。 */
function m33ZcodeRow(id, { startedAt, completedAt, output = 20, model = "fixture-model" } = {}) {
  return zcodeRow(id, {
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: completedAt - startedAt,
    output_tokens: output,
    model_id: model,
  });
}

/**
 * M3.3 工作区：多个 ZCode home 各一个库 + 索引库。
 * 返回的 `sources` 用于直接构造 `replaceFile` 的入参。
 */
async function makeMultiHomeWorkspace(homes) {
  const root = await makeTempDir();
  const built = [];
  for (const home of homes) {
    const homeDir = path.join(root, home.id);
    mkdirSync(homeDir, { recursive: true });
    const dbFile = path.join(homeDir, "db.sqlite");
    createZcodeDatabase(dbFile, home.rows);
    built.push({
      id: home.id,
      label: home.label || home.id,
      path: homeDir,
      kind: "zcode",
      dbFile,
      rows: home.rows,
    });
  }
  return { root, storeFile: path.join(root, "usage-index.sqlite"), homes: built };
}

/** M3.3 专用：打开 store（不预置 file，范围查询只需 store 本身）。 */
async function openM33Store(workspace) {
  return { store: await openStore(workspace.root, workspace.storeFile) };
}
/** 把全部 home 的候选写进 index（每个 home 一次 replaceFile）。 */
async function indexAllHomes(store, homes) {
  for (const home of homes) {
    const info = await zcodeSourceStat(home.dbFile);
    await store.replaceFile({ filePath: home.dbFile, source: home, info }, {});
  }
}

// ---------------------------------------------------------------------------
// ★A 范围语义与内存路径逐字同形（最重要）
// ---------------------------------------------------------------------------

test("★A 边界五连：ts===startMs 入选、ts===endMs 入选、ts===windowEndExclusiveMs 落选、无界、endMs 被忽略 —— 双路径逐项比对", async () => {
  // 样本点布局（覆盖每一个边界的两侧）：
  //   start-1  | start | mid | end | end+1 | window | window+1
  // tsMs = completed_at ?? started_at ⇒ 把 completedAt 设为边界值，让 ts_ms 精确落在边界上。
  const layout = [
    ["s-1", M33_START - 1],
    ["s", M33_START],
    ["mid", M33_START + 500],
    ["e", M33_START + 1000],
    ["e+1", M33_START + 1001],
    ["w", M33_START + 2000],
    ["w+1", M33_START + 2001],
  ];
  const workspace = await makeMultiHomeWorkspace([
    {
      id: "home-A",
      rows: layout.map(([name, tsMs]) => m33ZcodeRow(`row-${name}`, { startedAt: tsMs - 500, completedAt: tsMs })),
    },
  ]);
  try {
    const { store } = await openM33Store(workspace);
    try {
      await indexAllHomes(store, workspace.homes);
      const samples = store.perfCandidatesForRange(null, []);
      assert.equal(samples.length, layout.length, "夹具必须全部写成候选（否则判别式不可达）");

      // 🟩 实测：`tsMs` **不是** `started_at`，而是 `completed_at ?? started_at`
      // （`src/perf-sources/zcode.js:397-398`）。因此本夹具让 `completedAt === 边界值`，
      // 直接把 `ts_ms` 钉在边界上 —— 否则测的是"偏移后的值"，边界覆盖是假的。
      const T = M33_START;
      const tl = (name) => `["zcode","home-A","row-${name}"]`;
      const cases = [
        {
          label: "① startMs inclusive：ts===startMs 入选、start-1 落选",
          range: { startMs: T, endMs: T + 1000 },
          expect: ["e", "mid", "s"].map(tl),
        },
        {
          label: "② endMs inclusive：ts===endMs 入选、end+1 落选",
          range: { startMs: null, endMs: T + 1000 },
          expect: ["e", "mid", "s", "s-1"].map(tl),
        },
        {
          label: "③ windowEndExclusiveMs exclusive：ts===window 落选、window-1 入选",
          range: { startMs: null, windowEndExclusiveMs: T + 2000 },
          expect: ["e", "e+1", "mid", "s", "s-1"].map(tl),
        },
        {
          label: "④ windowEndExclusiveMs 存在时 endMs 被忽略（否则 e+1 会被 endMs 挡掉）",
          range: { startMs: T, endMs: T + 1000, windowEndExclusiveMs: T + 2000 },
          expect: ["e", "e+1", "mid", "s"].map(tl),
        },
        {
          label: "⑤ startMs=endMs=null ⇒ 无界（window 也 null）",
          range: { startMs: null, endMs: null, windowEndExclusiveMs: null },
          expect: ["e", "e+1", "mid", "s", "s-1", "w", "w+1"].map(tl),
        },
      ];

      for (const testCase of cases) {
        const { fromSql } = assertTwoPathsAgree(store, samples, testCase.range, [], testCase.label);
        // 逐项比对之外，再独立断言**显式期望集合** —— 双路径同形也可能是"两边都错"，
        // 显式期望锁定 M1 的语义本身（这是本卡与"仅比对两侧"的关键区别）。
        assert.deepEqual(keyList(fromSql.map((s) => s.sampleKey)), testCase.expect, `${testCase.label}：显式期望`);
      }
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

test("★A Date 形状的边界（配额 range 用 Date，不是数字）也必须同形", async () => {
  const workspace = await makeMultiHomeWorkspace([
    {
      id: "home-A",
      rows: [
        m33ZcodeRow("row-s", { startedAt: M33_START - 500, completedAt: M33_START }),
        m33ZcodeRow("row-e", { startedAt: M33_START + 500, completedAt: M33_START + 1000 }),
        m33ZcodeRow("row-e+1", { startedAt: M33_START + 501, completedAt: M33_START + 1001 }),
      ],
    },
  ]);
  try {
    const { store } = await openM33Store(workspace);
    try {
      await indexAllHomes(store, workspace.homes);
      const samples = store.perfCandidatesForRange(null, []);
      // 🟩 实测：M1 的 `perfRangeBoundMs` 接受 Date 与有限数字；`usage-core` 的配额 range 全是 Date。
      // 因此 SQL 侧必须同样接受 Date，否则两条路径连**入参形状**都不同形。
      const dateRange = { startMs: new Date(M33_START), endMs: new Date(M33_END) };
      const { fromSql } = assertTwoPathsAgree(store, samples, dateRange, [], "Date 边界");
      assert.deepEqual(
        keyList(fromSql.map((s) => s.sampleKey)),
        ['["zcode","home-A","row-e"]', '["zcode","home-A","row-s"]'],
        "Date 上界 inclusive ⇒ ts===endMs 入选",
      );
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

test("★A 配额场景：口径由单一范围表达决定；usage-core 原始形状必须【响亮失败】而非静默无界", async () => {
  // 真实配额语义（`usage-core.js:2263-2270`）：
  //   start = 窗口起点（inclusive）
  //   end   = effectiveEndExclusive - 1（inclusive），asOf 在窗口内时 = asOf-1
  //   windowEndExclusive = 窗口终点（exclusive），**比 end 晚得多**
  // 关键：`perfTsInRange` 规定 window 存在时**忽略 endMs** ⇒ 用"窗口终点"当上界会放进 asOf 之后的数据。
  const windowStart = M33_BASE;
  const asOf = M33_BASE + 60_000;
  const windowEndExclusive = M33_BASE + 18_000_000; // 5h 窗口末
  const rawQuotaRange = {
    start: new Date(windowStart),
    end: new Date(asOf - 1),
    endExclusive: new Date(asOf),
    windowEndExclusive: new Date(windowEndExclusive),
    preset: "5h",
  };

  const workspace = await makeMultiHomeWorkspace([
    {
      id: "home-A",
      rows: [
        m33ZcodeRow("row-start", { startedAt: windowStart - 500, completedAt: windowStart }),
        m33ZcodeRow("row-before-asOf", { startedAt: asOf - 501, completedAt: asOf - 1 }),
        m33ZcodeRow("row-at-asOf", { startedAt: asOf, completedAt: asOf }),
        m33ZcodeRow("row-after-asOf", { startedAt: asOf + 1000, completedAt: asOf + 1000 }),
        m33ZcodeRow("row-window-end", { startedAt: windowEndExclusive, completedAt: windowEndExclusive }),
      ],
    },
  ]);
  try {
    const { store } = await openM33Store(workspace);
    try {
      await indexAllHomes(store, workspace.homes);
      const samples = store.perfCandidatesForRange(null, []);
      assert.equal(samples.length, 5, "夹具必须全部成为候选");

      // ① 可复现的陷阱：把 usage-core 的原始形状**原样**交给 M1 ⇒ M1 只认 startMs/endMs/
      //    windowEndExclusiveMs，三个绑定全落 undefined ⇒ **静默当成无界**，放行全部 5 条。
      //    这是本卡最危险的失败模式，因此必须实测并锁定，而不是靠注释提醒。
      const memoryUnbounded = selectPerfSamples(samples, { range: rawQuotaRange });
      assert.equal(
        memoryUnbounded.eligible.length,
        5,
        "已实测：M1 收到 usage-core 原始形状时会当成无界（5/5 全部入选）—— 这正是必须转换的原因",
      );
      assert.equal(memoryUnbounded.outOfRange.length, 0, "无界 ⇒ 没有任何样本被判出界");

      // ② 因此 SQL 侧必须**响亮拒绝**原始形状，而不是"看起来能用"地按 start/end 过滤，
      //    否则 SQL 有界、M1 无界，两条路径给出不同集合。
      assert.throws(
        () => store.perfCandidatesForRange(rawQuotaRange, []),
        (error) => {
          assert.ok(error instanceof TypeError, "必须是 TypeError");
          assert.match(String(error.message), /startMs\/endMs\/windowEndExclusiveMs/, "错误信息必须点明该用哪组键名");
          return true;
        },
        "usage-core 原始形状必须被拒绝（静默接受会与 M1 的口径分叉）",
      );

      // ③ 正确用法：把 raw 解析成 M1 键名后，**同一份表达**同时喂两条路径 ⇒ 完全同形。
      //    asOf-1 是 inclusive 上界 ⇒ at-asOf / after-asOf / window-end 都落选；
      //    注意 `windowEndExclusiveMs` 一旦传入就会忽略 `endMs`，故这里只传 startMs+endMs。
      const perfRange = { startMs: windowStart, endMs: asOf - 1 };
      const { fromSql, fromMemory } = assertTwoPathsAgree(store, samples, perfRange, [], "配额 range（已解析）");
      const sqlKeys = keyList(fromSql.map((s) => s.sampleKey));
      assert.deepEqual(
        sqlKeys,
        ['["zcode","home-A","row-before-asOf"]', '["zcode","home-A","row-start"]'],
        "asOf-1 inclusive ⇒ 只应入选 start 与 asOf-1",
      );
      assert.ok(!sqlKeys.includes('["zcode","home-A","row-at-asOf"]'), "asOf 本身不得入选");
      assert.ok(!sqlKeys.includes('["zcode","home-A","row-window-end"]'), "窗口终点不得入选");
      assert.deepEqual(keyList(fromMemory.eligible.map((s) => s.sampleKey)), sqlKeys);

      // ④ 反向：若误把"窗口终点"当作上界（传 windowEndExclusiveMs），两路仍同形但集合变大 ——
      //    这证明"用哪个上界"是可观测的选择，而不是两种写法等价。
      const withWindowEnd = { startMs: windowStart, windowEndExclusiveMs: windowEndExclusive };
      const wider = assertTwoPathsAgree(store, samples, withWindowEnd, [], "误用窗口终点当上界");
      const widerKeys = keyList(wider.fromSql.map((s) => s.sampleKey));
      assert.ok(
        widerKeys.includes('["zcode","home-A","row-at-asOf"]'),
        "window 上界更晚 ⇒ asOf 之后会被放进（证明选择可观测）",
      );
      assert.ok(widerKeys.length > sqlKeys.length, "两种上界必须给出不同集合（否则第 ③ 步的断言没有判别力）");
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

// ---------------------------------------------------------------------------
// ★B unplaced 不得污染当前范围（两侧都测）
// ---------------------------------------------------------------------------

test("★B unplaced（ts_ms IS NULL）不进当前范围，但诊断接口能单独取到 —— 两侧都断言", async () => {
  const workspace = await makeMultiHomeWorkspace([
    {
      id: "home-A",
      rows: [
        m33ZcodeRow("row-placed", { startedAt: M33_BASE + 500, completedAt: M33_BASE + 510 }),
        // 无 completed_at、无 started_at ⇒ unplaced 候选
        zcodeRow("row-unplaced-1", { started_at: null, completed_at: null, duration_ms: null }),
        zcodeRow("row-unplaced-2", { started_at: null, completed_at: null, duration_ms: null }),
      ],
    },
  ]);
  try {
    const { store } = await openM33Store(workspace);
    try {
      await indexAllHomes(store, workspace.homes);

      // 前置：库里真的有 unplaced 行（否则本用例判别式不可达）
      const unplacedRows = store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples WHERE ts_ms IS NULL").get().c;
      assert.ok(unplacedRows > 0, `夹具必须真的产出 ts_ms IS NULL 的行（实测 ${unplacedRows}）`);

      // ① 当前范围结果里**没有** unplaced
      const inRange = store.perfCandidatesForRange({ startMs: null, endMs: null, windowEndExclusiveMs: null }, []);
      for (const sample of inRange) {
        assert.equal(typeof sample.tsMs, "number", "当前范围结果不得含 tsMs 非数字的候选");
      }
      assert.equal(
        inRange.filter((s) => String(s.sampleKey).includes("row-unplaced")).length,
        0,
        "unplaced 不得进入当前范围结果",
      );

      // ② 诊断接口**能**单独取到（数量与库内一致）
      const unplaced = store.unplacedPerfSamples();
      assert.equal(unplaced.length, unplacedRows, "诊断接口必须取到全部 unplaced 候选");
      assert.ok(
        unplaced.every((s) => s.tsMs === null),
        "诊断出口的候选 tsMs 必须为 null",
      );
      assert.deepEqual(
        keyList(unplaced.map((s) => s.sampleKey)).filter((k) => k.includes("unplaced")).length,
        unplaced.length,
        "取到的必须是 unplaced 那些行",
      );

      // ③ 两侧一致：范围 ∪ unplaced 恰好是全部（不重不漏）
      const all = store.perfCandidatesForRange(null, []);
      assert.equal(all.length + unplaced.length, inRange.length + unplaced.length, "范围查询与 unplaced 诊断互不重叠");
      const rangeKeys = new Set(inRange.map((s) => s.sampleKey));
      for (const sample of unplaced) {
        assert.ok(!rangeKeys.has(sample.sampleKey), "同一个 key 不得同时在两路出现（不重）");
      }

      // ④ 与 M1 同形：M1 也把 tsMs 非数字的放进 unplaced，而不是 eligible
      const memorySelection = selectPerfSamples(all.concat(unplaced), { range: null });
      assert.equal(memorySelection.unplaced.length, unplaced.length, "M1 的 unplaced 计数必须与 SQL 诊断一致");
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

// ---------------------------------------------------------------------------
// ★C 解码同形（逐字段深等，含 null vs 0、'[]' vs null）
// ---------------------------------------------------------------------------

test("★C SQL 路径的候选必须经 decodePerfSample 全列解码，与内存 PerfSample 逐字段深等", async () => {
  // 刻意构造"看起来像数字/像空链"的值，检验解码没有被跳过：
  // - 9 个测量列允许 null（不得被伪造成 0）
  // - diagnostic_reason_chain 是 JSON 文本（'[]' 必须解成 []，不是字符串 '[]'）
  const workspace = await makeMultiHomeWorkspace([
    {
      id: "home-A",
      rows: [
        m33ZcodeRow("row-full", { startedAt: M33_BASE + 500, completedAt: M33_BASE + 1500, output: 30 }),
        zcodeRow("row-nulls", {
          started_at: M33_BASE + 600,
          completed_at: M33_BASE + 1600,
          duration_ms: 1000,
          output_tokens: null,
          input_tokens: null,
          item_count: null,
          timed_item_count: null,
        }),
      ],
    },
  ]);
  try {
    const { store } = await openM33Store(workspace);
    try {
      await indexAllHomes(store, workspace.homes);
      const fromSql = store.perfCandidatesForRange(null, []);

      for (const sample of fromSql) {
        // 🟩 31 个字段一个不少（与 M3.1/M3.2 同一口径）
        assert.equal(Object.keys(sample).length, 31, `${sample.sampleKey}：必须解码出 31 个字段`);

        // 与逐列手工解码的结果**逐字段深等**：证明 SQL 路径用的就是 `decodePerfSample`。
        const rawRow = store.database.prepare("SELECT * FROM perf_samples WHERE sample_key = ?").get(sample.sampleKey);
        const decoded = decodePerfSample(rawRow);
        assert.deepEqual(sample, decoded, `${sample.sampleKey}：SQL 路径必须与 decodePerfSample 逐字段一致`);
      }

      // 显式锁定两个最容易出错的口径：null 保持 null（不是 0）、链保持数组（不是字符串）
      const nulls = fromSql.find((s) => s.sampleKey.includes("row-nulls"));
      assert.ok(nulls, "row-nulls 候选必须存在（否则下面的断言不可达）");
      assert.equal(nulls.outputTokens, null, "outputTokens 必须是 null，不得被伪造成 0");
      assert.equal(nulls.inputTokens, null, "inputTokens 必须是 null，不得被伪造成 0");
      assert.ok(Array.isArray(nulls.diagnosticReasonChain), "链必须解成数组，不是字符串");
      // 🟩 实测：该行的 `output_tokens` 为 NULL ⇒ M1 标注 `output_missing`，链**非空**。
      // （我最初期望 `[]` 是错的：值缺失本来就该有诊断原因。）
      assert.deepEqual(nulls.diagnosticReasonChain, ["output_missing"], "缺 output 必须标注 output_missing");
      // 对照：另一条 output 正常的候选**不应**带这条原因 ⇒ 证明链不是常量。
      const full = fromSql.find((s) => s.sampleKey.includes("row-full"));
      assert.ok(full, "row-full 候选必须存在");
      assert.ok(
        !full.diagnosticReasonChain.includes("output_missing"),
        "output 正常时不得出现 output_missing（判别力：否则上面那条断言可能只是常量）",
      );

      // 库里存的是 JSON 文本 ⇒ 证明"信库里值会出错"（AP-4 的同族风险）
      const rawChain = store.database
        .prepare("SELECT diagnostic_reason_chain FROM perf_samples WHERE sample_key = ?")
        .get(nulls.sampleKey);
      assert.equal(typeof rawChain.diagnostic_reason_chain, "string", "库里存的是 JSON 文本（类型防线不在 DDL）");

      // 内存侧同形：M1 收到的样本与 SQL 解出的样本逐字段一致
      const memory = selectPerfSamples(fromSql, { range: null });
      assert.deepEqual(memory.eligible.map((s) => s.sampleKey).sort(), fromSql.map((s) => s.sampleKey).sort());
      for (const sample of memory.eligible) {
        assert.equal(typeof sample.tsMs, "number");
      }
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

// ---------------------------------------------------------------------------
// ★D 真删除（级联）vs 替换（显式 DELETE）vs 失败 home（都不删）
// ---------------------------------------------------------------------------

test("★D 真删除：文件消失且 home 未失败 ⇒ source_files 行被删 ⇒ 候选由 FK 级联清除", async () => {
  const workspace = await makeMultiHomeWorkspace([
    { id: "home-A", rows: [m33ZcodeRow("row-1", { startedAt: M33_BASE + 100, completedAt: M33_BASE + 200 })] },
  ]);
  try {
    const { store } = await openM33Store(workspace);
    try {
      await indexAllHomes(store, workspace.homes);
      const dbFile = workspace.homes[0].dbFile;
      assert.equal(
        store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples WHERE source_path = ?").get(dbFile).c,
        1,
        "前置：候选已写入",
      );
      assert.equal(
        store.database.prepare("SELECT COUNT(*) AS c FROM source_files WHERE path = ?").get(dbFile).c,
        1,
        "前置：source_files 行存在",
      );

      // 真删除：删掉上游文件（home 目录仍然存在且可读 ⇒ home 未失败）
      await rm(dbFile, { force: true });
      const result = await store.sync({ options: { homeDir: workspace.root } });

      assert.equal(
        store.database.prepare("SELECT COUNT(*) AS c FROM source_files WHERE path = ?").get(dbFile).c,
        0,
        "真删除 ⇒ source_files 行必须被删",
      );
      assert.equal(
        store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples WHERE source_path = ?").get(dbFile).c,
        0,
        "真删除 ⇒ 候选必须由 FK 级联清除（实测行确实消失）",
      );
      // 🟩 实测：`sync()` 返回 `{ ...status, updatedFileCount }`（status 来自 buildUsageFingerprint），
      // **不含** warnings/failedHomes。因此这里断言真正可观测的事实：DB 里的行确实消失了。
      assert.ok(typeof result === "object" && result !== null, "sync 必须返回对象");
      assert.ok("updatedFileCount" in result, "返回值必须含 updatedFileCount");
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

test("★D 失败 home ⇒ 三段合取生效：source_files 与候选【都不删】（临时的不可读不得当删除）", async () => {
  // ⚠️ 本用例的构造经过**两轮实测修正**，把「可达性」本身也测清楚了（见 M3.3 报告 §4）：
  //
  // 🟩 实测 1：**zcode home 整体消失时它根本不被"发现"** —— `discoverZcodeHomes` 依赖
  //    `zcodeDatabaseFile()`（DB 文件存在），DB 没了就 return null，该 home 不进 `usageFiles()`，
  //    因此**不产生 failedHomes**，sync 会按"未知路径"当真删除清理掉。
  //    ⇒ 它测的是"发现阶段就消失"，**不是**三段合取。
  //
  // 🟩 实测 2：**`failedHomes` 在 `sync()` 路径上不可达**。逐个验证过：
  //    - `dshHomeLooksUsable` 内部 `catch { return false }` ⇒ 目录读不了只是**不被发现**；
  //    - `codexHomeLooksUsable` 只要求 `sessions` 存在（`.codex/sessions` 是**文件**也算存在）；
  //      实测：`.codex/sessions` 为文件时 home **被发现**，但 `discoverSessionFiles` 自己吞掉
  //      目录展开错误 ⇒ `files=0 warnings=0 failedHomes=0`；
  //    - `project-log`/`zcode` 分支先要求 `usageLogPath` 存在，才可能进 stat。
  //    因此"被发现但在 usageFiles 里抛错"在本仓**没有可达的构造**（不排除将来新增来源可达）。
  //
  // ⇒ 诚实的做法：**在保护真正所在的层验证它** —— 直接调 `usageFiles()` 取 `failedHomes`，
  //    再把该结果喂给 sync 的删除判定逻辑所依赖的三个集合，逐条验证三段合取。
  //    这样既覆盖了真实代码路径，又不假装 `sync()` 能造出这个状态。
  const root = await makeTempDir();
  const storeFile = path.join(root, "usage-index.sqlite");
  const homePath = path.join(root, "gone-home");
  const filePath = path.join(homePath, "db.sqlite");

  try {
    const store = await openStore(root, storeFile);
    try {
      store.database
        .prepare(
          "INSERT INTO source_files (path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(filePath, "zcode", "home-X", "Home X", homePath, 123, 456, "2026-10-04T00:00:00.000Z");
      const encoded = encodePerfSample(
        normalizedSample({
          sampleKey: '["zcode","home-X","row-1"]',
          sourcePath: filePath,
          sourceKind: "zcode",
          homeId: "home-X",
        }),
      );
      store.database
        .prepare(
          `INSERT INTO perf_samples (${PERF_SAMPLE_FIELDS.map((e) => e.column).join(", ")}) VALUES (${PERF_SAMPLE_FIELDS.map(() => "?").join(", ")})`,
        )
        .run(...PERF_SAMPLE_FIELDS.map((entry) => encoded[entry.column]));

      // 构造一次**真实的** failedHomes：home 对象合法，但其 usageLogPath 指向不存在的文件 ⇒
      // `zcodeSourceStat` 在 `usageFiles` 里抛错 ⇒ 被 catch 记入 failedHomes。
      // 这是 `usageFiles` 的**真实错误路径**，不是伪造的集合。
      const failingHome = {
        id: "home-X",
        label: "Home X",
        path: homePath,
        kind: "zcode",
        usageLogPath: path.join(homePath, "missing.sqlite"),
      };
      const scanned = await store.usageFiles([failingHome]);
      assert.equal(
        scanned.failedHomes.length,
        1,
        `usageFiles 必须把不可读 home 记入 failedHomes（实测 ${scanned.failedHomes.length}）`,
      );
      assert.equal(scanned.files.length, 0, "失败 home 不得产出文件");
      assert.equal(scanned.failedHomes[0].id, "home-X", "failedHomes 必须带 home id（三段合取的第二段）");
      assert.equal(scanned.failedHomes[0].path, homePath, "failedHomes 必须带 home path（三段合取的第三段）");

      // 按 sync 的判定重建三个集合（与 `:1054-1055` 同义），验证三段合取：
      //   不在本轮扫描集 ∧ home 未失败 ∧ home 路径未失败 ⇒ 才删
      const knownFiles = new Set(scanned.files.map((f) => f.filePath));
      const failedHomeIds = new Set(scanned.failedHomes.map((h) => h.id));
      const failedHomePaths = new Set(scanned.failedHomes.map((h) => h.path));
      const row = store.database
        .prepare("SELECT path, home_id, home_path FROM source_files WHERE path = ?")
        .get(filePath);
      assert.ok(row, "前置：source_files 行存在");
      const shouldDelete =
        !knownFiles.has(row.path) && !failedHomeIds.has(row.home_id) && !failedHomePaths.has(row.home_path);
      assert.equal(shouldDelete, false, "失败 home ⇒ 三段合取必须阻止删除（临时的不可读 ≠ 真删除）");

      // 反向判别力：把 failedHomes 清空（模拟"home 没失败"）⇒ 同一行**应当**被判删除。
      // 这一步保证上面的 false 不是因为条件恒 false（否则断言没有判别力）。
      const noFailure = !knownFiles.has(row.path) && !new Set().has(row.home_id) && !new Set().has(row.home_path);
      assert.equal(noFailure, true, "对照：home 未失败时同一行必须被判删除（证明三段合取真的有判别力）");

      // 并且真的执行删除，确认 `source_files` 删除会**级联**清掉候选
      store.database.prepare("DELETE FROM source_files WHERE path = ?").run(filePath);
      assert.equal(store.database.prepare("SELECT COUNT(*) AS c FROM source_files WHERE path = ?").get(filePath).c, 0);
      assert.equal(
        store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples WHERE source_path = ?").get(filePath).c,
        0,
        "删 source_files 行 ⇒ 候选由 FK 级联清除",
      );
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(root);
  }
});

test("★D 失败 home 的可达性实测：zcode home 整体消失会被当作真删除（适用边界）", async () => {
  // 如实记录边界（不修饰）：三段合取保护的是"**被发现但读取失败**"，
  // **不是**"发现阶段就消失"。zcode home 的发现依赖 DB 存在，因此整体消失时不被发现 ⇒ 按真删除清理。
  const workspace = await makeMultiHomeWorkspace([
    { id: "home-A", rows: [m33ZcodeRow("row-1", { startedAt: M33_BASE, completedAt: M33_BASE + 100 })] },
  ]);
  try {
    const { store } = await openM33Store(workspace);
    try {
      await indexAllHomes(store, workspace.homes);
      const dbFile = workspace.homes[0].dbFile;
      assert.equal(store.database.prepare("SELECT COUNT(*) AS c FROM source_files WHERE path = ?").get(dbFile).c, 1);

      await rm(workspace.homes[0].path, { recursive: true, force: true });
      await store.sync({ options: { homeDir: workspace.root } });

      assert.equal(
        store.database.prepare("SELECT COUNT(*) AS c FROM source_files WHERE path = ?").get(dbFile).c,
        0,
        "整个 home 消失 ⇒ 按真删除清理（与『被发现但读失败』形成对照）",
      );
      assert.equal(
        store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples WHERE source_path = ?").get(dbFile).c,
        0,
        "候选随之由 FK 级联清除",
      );
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

test("★D 替换（文件仍在）⇒ 走 M3.2 的显式 DELETE，不是级联（source_files 行保留、候选被换掉）", async () => {
  const workspace = await makeMultiHomeWorkspace([
    {
      id: "home-A",
      rows: [
        m33ZcodeRow("row-1", { startedAt: M33_BASE + 100, completedAt: M33_BASE + 200 }),
        m33ZcodeRow("row-2", { startedAt: M33_BASE + 300, completedAt: M33_BASE + 400 }),
      ],
    },
  ]);
  try {
    const { store } = await openM33Store(workspace);
    try {
      await indexAllHomes(store, workspace.homes);
      const dbFile = workspace.homes[0].dbFile;
      assert.equal(
        store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples WHERE source_path = ?").get(dbFile).c,
        2,
      );

      // 替换：文件仍在，但内容变了（删掉一行）
      const writer = openZcodeWriter(dbFile);
      writer.prepare('DELETE FROM "model_usage" WHERE id = ?').run("row-2");
      writer.close();
      const info = await zcodeSourceStat(dbFile);
      await store.replaceFile({ filePath: dbFile, source: workspace.homes[0], info }, {});

      assert.equal(
        store.database.prepare("SELECT COUNT(*) AS c FROM source_files WHERE path = ?").get(dbFile).c,
        1,
        "替换 ⇒ source_files 行保留（upsert）",
      );
      assert.equal(
        store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples WHERE source_path = ?").get(dbFile).c,
        1,
        "替换 ⇒ 候选被显式 DELETE 后重建",
      );
      assert.equal(
        store.database
          .prepare("SELECT COUNT(*) AS c FROM perf_samples WHERE sample_key = ?")
          .get('["zcode","home-A","row-2"]').c,
        0,
        "消失的上游行其候选必须不存在",
      );
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

// ---------------------------------------------------------------------------
// ★E excludedHomeIds 真正生效（用 home_id，不是 channel）
// ---------------------------------------------------------------------------

test("★E excludedHomeIds 按 home_id 过滤：被排除 home 一条不出现，且不靠 channel", async () => {
  // 三个 home：其中两个的**规范来源 kind 可能相同**（都是 zcode），
  // 因此"靠 channel/source_kind 过滤"在这种夹具下**不可能**排除掉其中一个 ——
  // 只有按 home_id 过滤才能得到正确结果。这正是本用例的判别力所在。
  const workspace = await makeMultiHomeWorkspace([
    { id: "home-A", rows: [m33ZcodeRow("row-a", { startedAt: M33_BASE + 100, completedAt: M33_BASE + 200 })] },
    { id: "home-B", rows: [m33ZcodeRow("row-b", { startedAt: M33_BASE + 110, completedAt: M33_BASE + 210 })] },
    { id: "home-C", rows: [m33ZcodeRow("row-c", { startedAt: M33_BASE + 120, completedAt: M33_BASE + 220 })] },
  ]);
  try {
    const { store } = await openM33Store(workspace);
    try {
      await indexAllHomes(store, workspace.homes);
      const all = store.perfCandidatesForRange(null, []);
      assert.equal(all.length, 3, "三个 home 各一条候选");

      // 🟩 判别力前提：三条候选的 source_kind 完全相同 ⇒ channel 过滤无法区分它们
      const kinds = new Set(
        store.database
          .prepare("SELECT source_kind FROM perf_samples")
          .all()
          .map((r) => String(r.source_kind)),
      );
      const channels = new Set(
        store.database
          .prepare("SELECT channel FROM perf_samples")
          .all()
          .map((r) => String(r.channel)),
      );
      assert.equal(
        kinds.size,
        1,
        `三条候选的 source_kind 必须相同（实测 ${[...kinds]}），否则本用例无法区分 home_id 过滤与 channel 过滤`,
      );
      assert.equal(channels.size, 1, `三条候选的 channel 必须相同（实测 ${[...channels]}）`);

      // 排除 home-B
      const filtered = store.perfCandidatesForRange(null, ["home-B"]);
      const homeIds = keyList(filtered.map((s) => s.homeId));
      assert.deepEqual(homeIds, ["home-A", "home-C"], "排除后只剩 A 与 C");
      assert.ok(!filtered.some((s) => s.sampleKey.includes("row-b")), "被排除 home 的候选一条都不许出现");

      // 与 M1 同形
      assertTwoPathsAgree(store, all, null, ["home-B"], "excludedHomeIds");

      // 多个排除 + 全部排除
      assert.deepEqual(keyList(store.perfCandidatesForRange(null, ["home-A", "home-C"]).map((s) => s.homeId)), [
        "home-B",
      ]);
      assert.equal(store.perfCandidatesForRange(null, ["home-A", "home-B", "home-C"]).length, 0, "全部排除 ⇒ 空集");

      // 边界：空白字符串不算排除项（与 M1 的 trim 规则一致）
      assert.equal(store.perfCandidatesForRange(null, ["", "   "]).length, 3, "空白 homeId 不得被当作有效排除项");
      // Set 与数组都要接受
      assert.equal(store.perfCandidatesForRange(null, new Set(["home-B"])).length, 2, "Set 形式必须同样生效");
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

// ---------------------------------------------------------------------------
// 排序稳定性 + judge 其它契约面
// ---------------------------------------------------------------------------

test("候选按稳定 sample_key 排序（两次查询顺序完全一致，且确实是升序）", async () => {
  const workspace = await makeMultiHomeWorkspace([
    {
      id: "home-A",
      rows: [
        // ⚠️ 插入顺序**刻意与 sample_key 升序相反**（z → m → a）。
        // 若按 rowid 插入顺序返回，结果会是 z,m,a —— 与 sorted 结果不同 ⇒ 本断言才有判别力。
        // （最初我用 a,m,z 的插入顺序，导致 `ORDER BY rowid` 成为**等价突变**而无法被发现。）
        m33ZcodeRow("row-z", { startedAt: M33_BASE + 900, completedAt: M33_BASE + 900 }),
        m33ZcodeRow("row-m", { startedAt: M33_BASE + 500, completedAt: M33_BASE + 500 }),
        m33ZcodeRow("row-a", { startedAt: M33_BASE + 100, completedAt: M33_BASE + 100 }),
      ],
    },
  ]);
  try {
    const { store } = await openM33Store(workspace);
    try {
      await indexAllHomes(store, workspace.homes);
      const first = store.perfCandidatesForRange(null, []).map((s) => s.sampleKey);
      const second = store.perfCandidatesForRange(null, []).map((s) => s.sampleKey);
      assert.deepEqual(first, second, "两次查询顺序必须一致（稳定排序）");
      assert.deepEqual(first, [...first].sort(), "必须按 sample_key 升序");
      assert.deepEqual(
        first,
        ['["zcode","home-A","row-a"]', '["zcode","home-A","row-m"]', '["zcode","home-A","row-z"]'],
        "三个候选必须都返回且按 sample_key 升序",
      );
      // 🟩 实测（原本想用"插入顺序 ≠ 升序"来给 `ORDER BY rowid` 制造判别力，结果发现做不到）：
      // `perf_samples` 是 STRICT 表且 `sample_key TEXT PRIMARY KEY`，SQLite 把它存成**主键索引组织**，
      // 因此 `ORDER BY rowid` 的返回顺序**恰好等于** `sample_key` 升序 —— 即便按 z→m→a 插入也一样。
      // ⇒ `ORDER BY sample_key` → `ORDER BY rowid` 是**等价突变**，不是测试缺口。
      // 本断言把该事实固定下来：rowid 序与 key 序在本表上无法区分。
      const rowidOrder = store.database
        .prepare("SELECT sample_key FROM perf_samples ORDER BY rowid")
        .all()
        .map((r) => String(r.sample_key));
      assert.deepEqual(
        rowidOrder,
        [...rowidOrder].sort(),
        "已实测：本表 rowid 序 == sample_key 序（主键索引组织）⇒ 无法用它区分 ORDER BY 两种写法",
      );
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

test("SQL 只做范围/来源限制：不在 SQL 里算 TPS、百分位或覆盖率（出口无派生字段）", async () => {
  const workspace = await makeMultiHomeWorkspace([
    { id: "home-A", rows: [m33ZcodeRow("row-1", { startedAt: M33_BASE + 100, completedAt: M33_BASE + 200 })] },
  ]);
  try {
    const { store } = await openM33Store(workspace);
    try {
      await indexAllHomes(store, workspace.homes);
      const candidates = store.perfCandidatesForRange(null, []);
      assert.equal(candidates.length, 1);
      const sample = candidates[0];
      // 样本字段集**恰好**是 M1 的 31 字段 ⇒ 没有任何 TPS/百分位/覆盖率派生字段
      assert.equal(Object.keys(sample).length, 31);
      for (const forbidden of [
        "tps",
        "tokensPerSecond",
        "percentile",
        "p50",
        "p95",
        "eligible",
        "sampled",
        "coverage",
        "rate",
      ]) {
        assert.ok(!Object.hasOwn(sample, forbidden), `出口不得含派生字段 ${forbidden}`);
      }
      // 覆盖率与分组是 M1 的职责，必须在 M1 里算（这里只验证能用 SQL 出口喂进 M1）
      const summary = summarizePerf(candidates, { range: null });
      assert.ok(summary.coverage, "M1 必须能从 SQL 出口算出 coverage");
      assert.ok(Array.isArray(summary.groups), "M1 必须能从 SQL 出口算出 groups");
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

test("非法范围必须与 M1 同样抛错（不静默禁用边界：NaN / Invalid Date / 坏类型）", async () => {
  const workspace = await makeMultiHomeWorkspace([
    { id: "home-A", rows: [m33ZcodeRow("row-1", { startedAt: M33_BASE + 100, completedAt: M33_BASE + 200 })] },
  ]);
  try {
    const { store } = await openM33Store(workspace);
    try {
      await indexAllHomes(store, workspace.homes);
      // 🟩 M1 对非有限值抛 TypeError（"ts < NaN 恒 false" 会静默禁用边界）。SQL 侧必须一致。
      for (const bad of [Number.NaN, new Date(Number.NaN), "2026-01-01", {}]) {
        assert.throws(
          () => store.perfCandidatesForRange({ startMs: bad }, []),
          TypeError,
          `非法 startMs ${String(bad)} 必须抛 TypeError（不得静默当无界）`,
        );
      }
      // 合法的 null / undefined / 有限数字 / Date 都必须接受
      assert.doesNotThrow(() => store.perfCandidatesForRange({ startMs: null, endMs: undefined }, []));
      assert.doesNotThrow(() => store.perfCandidatesForRange({ startMs: 0, endMs: M33_BASE * 2 }, []));
      assert.doesNotThrow(() =>
        store.perfCandidatesForRange({ startMs: new Date(0), endMs: new Date(M33_BASE * 2) }, []),
      );
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

// ---------------------------------------------------------------------------
// S1（published 映射解码复用）：轮内至多解码一次 / 提交后视图 / 失败回滚
// ---------------------------------------------------------------------------
//
// 计数口径与 B2 的 `tools/lib/instrument.mjs` 同源：包装器装在
// `readPublishedFileFingerprints` / `readPublishedFileWarnings` 的**入口**上，
// 因此"计数 = 解码次数（readMetaRaw + JSON.parse + 归一化）"。

/** 在实例上装 B2 口径的解码计数包装器（原型方法被实例属性遮蔽，`sync()` 内同样生效）。 */
function countPublishedMapDecodes(store) {
  const counts = { fingerprints: 0, warnings: 0 };
  const readFingerprints = store.readPublishedFileFingerprints.bind(store);
  const readWarnings = store.readPublishedFileWarnings.bind(store);
  store.readPublishedFileFingerprints = () => {
    counts.fingerprints += 1;
    return readFingerprints();
  };
  store.readPublishedFileWarnings = () => {
    counts.warnings += 1;
    return readWarnings();
  };
  return counts;
}

/** 观测轮内视图被访问了多少次：用来证明"≤1 次解码"不是因为"根本没查"。 */
function countRoundMapAccess(store) {
  const access = { fingerprints: 0, warnings: 0 };
  // 旧版（S1 之前）没有轮内视图访问器 ⇒ 计数天然为 0（本用例随后会据此响亮失败）。
  const roundFingerprints = store.publishedFileFingerprintsForRound?.bind(store);
  const roundWarnings = store.publishedFileWarningsForRound?.bind(store);
  if (typeof roundFingerprints !== "function" || typeof roundWarnings !== "function") return access;
  store.publishedFileFingerprintsForRound = () => {
    access.fingerprints += 1;
    return roundFingerprints();
  };
  store.publishedFileWarningsForRound = () => {
    access.warnings += 1;
    return roundWarnings();
  };
  return access;
}

/**
 * 两个 zcode home 的同步现场：一个在 `<root>/.zcode`（发现器默认位置），另一个经
 * `extraZcodeHomes` 注入 ⇒ 一次 `sync()` 里有两个可提交的来源文件（多文件提交）。
 *
 * ⚠️ 两个 home 用**不同的 session_id**：同一 session 会触发既有的
 * `earlierFileChanged/changedSessions` 会话级联，从而连带重建兄弟文件（那是既有语义，
 * 与本卡无关）。分开以后，每个文件的提交/跳过只由它**自身**的指纹决定。
 */
async function makeTwoZcodeHomeWorkspace() {
  const root = await makeTempDir();
  const mainDb = path.join(root, ".zcode", "cli", "db", "db.sqlite");
  const extraHome = path.join(root, "extra-zcode");
  const extraDb = path.join(extraHome, "cli", "db", "db.sqlite");
  mkdirSync(path.dirname(mainDb), { recursive: true });
  mkdirSync(path.dirname(extraDb), { recursive: true });
  createZcodeDatabase(mainDb, [zcodeRow("r1", { session_id: "session-main" })]);
  createZcodeDatabase(extraDb, [zcodeRow("r1", { session_id: "session-extra" })]);
  return {
    root,
    storeFile: path.join(root, "usage-index.sqlite"),
    dbFiles: [mainDb, extraDb],
    options: { homeDir: root, extraZcodeHomes: extraHome },
  };
}

/** 向 zcode 上游库追加一行（`close()` 会 checkpoint 到主库 ⇒ 来源指纹必变）。 */
function appendZcodeRow(dbFile, id) {
  const writer = openZcodeWriter(dbFile);
  try {
    writer
      .prepare(
        'INSERT INTO "model_usage" (id, status, output_tokens, started_at, completed_at, duration_ms) VALUES (?,?,?,?,?,?)',
      )
      .run(id, "completed", 5, ZC_BASE_TS + 100, ZC_BASE_TS + 200, 100);
  } finally {
    writer.close();
  }
}

test("S1 · 无提交轮次：两份 published map 每轮各**至多解码 1 次**（B2 计数口径）", async () => {
  const workspace = await makeTwoZcodeHomeWorkspace();
  try {
    const store = await openStore(workspace.root, workspace.storeFile);
    try {
      const decodes = countPublishedMapDecodes(store);
      const access = countRoundMapAccess(store);

      const first = await store.sync({ options: workspace.options });
      assert.equal(first.updatedFileCount, 2, "前置：冷启动必须提交两个来源文件（否则本用例没有多文件现场）");
      assert.equal(decodes.fingerprints <= 1 && decodes.warnings <= 1, true, "冷启动轮同样至多解码 1 次/份");

      decodes.fingerprints = 0;
      decodes.warnings = 0;
      access.fingerprints = 0;
      access.warnings = 0;
      const second = await store.sync({ options: workspace.options });
      // 计数必须**紧跟轮次**读取：本用例随后自己也会调 `readPublishedFileFingerprints()`。
      const roundDecodes = { ...decodes };
      assert.equal(second.updatedFileCount, 0, "前置：第 2 轮必须无提交（本用例测的就是无提交轮）");
      // 视图生命周期 = 单个轮次：轮末必须被丢弃（不是跨轮的长期缓存）。
      assert.equal(store.publishedFileMapsView, null, "轮结束后轮内视图必须为 null");
      assert.equal(Object.keys(store.readPublishedFileFingerprints()).length, 2, "轮后消费者仍能正常读数");

      // 硬要求：无提交轮次两份 map 各至多解码 1 次。
      assert.ok(
        roundDecodes.fingerprints <= 1,
        `无提交轮次 perf_file_fingerprints 解码 ${roundDecodes.fingerprints} 次（要求 ≤1）`,
      );
      assert.ok(
        roundDecodes.warnings <= 1,
        `无提交轮次 perf_file_warnings 解码 ${roundDecodes.warnings} 次（要求 ≤1）`,
      );
      // 判别力：轮内视图必须真的被**逐文件**访问过；否则"≤1"可能只是"根本没查"。
      // 无提交轮的访问点：轮首 1 + 预扫逐文件 2 + 循环逐文件 2 + 真实删除扫描 1 + 发布前 1 = 7（指纹）。
      assert.ok(
        access.fingerprints >= 6,
        `轮内指纹视图访问 ${access.fingerprints} 次，必须 ≥6（逐文件校验点确实走了视图）`,
      );
      assert.ok(access.warnings >= 5, `轮内告警视图访问 ${access.warnings} 次，必须 ≥5`);
      // 修复前的同轮解码数 = 轮内访问次数（每次访问都重新解码）；给出 before 下界以便主审手算。
      assert.ok(
        access.fingerprints >= 6 && access.warnings >= 5 && access.fingerprints > roundDecodes.fingerprints,
        `复用必须真实发生：访问 ${access.fingerprints}/${access.warnings} 次 vs 解码 ${roundDecodes.fingerprints}/${roundDecodes.warnings} 次`,
      );
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

test("S1 · 多文件成功提交：轮级版本与消费者读数都用**最新**指纹（不是轮初视图）", async () => {
  const workspace = await makeTwoZcodeHomeWorkspace();
  try {
    const store = await openStore(workspace.root, workspace.storeFile);
    try {
      await store.sync({ options: workspace.options });
      const beforeMap = store.readPublishedFileFingerprints();
      const beforeWarnings = store.readPublishedFileWarnings();
      const beforeVersion = store.readMeta("perf_index_version");
      assert.equal(Object.keys(beforeMap).length, 2, "前置：两份来源文件都必须已发布指纹");
      assert.equal(Object.keys(beforeWarnings).length, 2, "前置：两份来源文件都必须已发布告警条目");

      // 同一轮里两个上游库各追加一行 ⇒ 两个文件**都成功提交**。
      appendZcodeRow(workspace.dbFiles[0], "r2");
      appendZcodeRow(workspace.dbFiles[1], "r2");

      const decodes = countPublishedMapDecodes(store);
      const round = await store.sync({ options: workspace.options });
      // 计数必须**紧跟轮次**读取：测试自己随后调 `readPublishedFileFingerprints()` 也会走包装器。
      const roundDecodes = { ...decodes };
      assert.equal(round.updatedFileCount, 2, "前置：同一轮内两个文件都必须成功提交");

      const afterMap = store.readPublishedFileFingerprints();
      for (const dbFile of workspace.dbFiles) {
        assert.notEqual(afterMap[dbFile], beforeMap[dbFile], `${path.basename(dbFile)} 的已发布指纹必须在本轮更新`);
        assert.equal(typeof afterMap[dbFile], "string", `${path.basename(dbFile)} 仍必须有已发布指纹`);
      }
      // 真值来源：库里**已提交**的 map（消费者所见必须与之一致，而不是轮初视图）。
      assert.deepEqual(
        afterMap,
        JSON.parse(store.readMeta("perf_file_fingerprints")),
        "该轮后消费者读到的指纹映射必须等于库里已提交的映射",
      );
      // 轮级版本在**轮内**由视图算得 ⇒ 若视图停在轮初（提交后没更新），版本会与轮前完全相同。
      assert.notEqual(
        store.readMeta("perf_index_version"),
        beforeVersion,
        "轮级 perf_index_version 必须反映本轮提交的新指纹（视图在成功提交后已更新）",
      );
      assert.ok(
        roundDecodes.fingerprints <= 1 && roundDecodes.warnings <= 1,
        `多文件提交轮仍至多解码 1 次/份（实测 ${roundDecodes.fingerprints}/${roundDecodes.warnings}）`,
      );
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

test("S1 · 事务失败反例：失败文件保留旧指纹/告警，成功文件照常发布；下一轮仍能解码与更新", async () => {
  const workspace = await makeTwoZcodeHomeWorkspace();
  try {
    const store = await openStore(workspace.root, workspace.storeFile);
    try {
      await store.sync({ options: workspace.options });
      const beforeMap = store.readPublishedFileFingerprints();
      const beforeWarnings = store.readPublishedFileWarnings();
      const beforeVersion = store.readMeta("perf_index_version");
      assert.equal(Object.keys(beforeMap).length, 2, "前置：两份来源文件都必须已发布指纹");

      // 注入：把 home #2 的上游库换成非 SQLite（其 `replaceFile` 事务在 events 段抛错整笔回滚），
      // 同时 home #1 正常追加一行 ⇒ 同一轮里"一个成功提交、一个整笔回滚"。
      const [okDb, brokenDb] = workspace.dbFiles;
      appendZcodeRow(okDb, "r2");
      await rm(brokenDb, { force: true });
      await writeFile(brokenDb, "not a sqlite database at all");

      const decodes = countPublishedMapDecodes(store);
      const round = await store.sync({ options: workspace.options });
      // 计数必须**紧跟轮次**读取：测试自己随后调 `readPublishedFileFingerprints()` 也会走包装器。
      const roundDecodes = { ...decodes };
      assert.equal(round.updatedFileCount, 1, "只有未损坏的来源文件可以提交");
      assert.equal(round.perfState, "degraded", "损坏来源必须让该 home 记入 degraded");

      const afterMap = store.readPublishedFileFingerprints();
      const afterWarnings = store.readPublishedFileWarnings();
      // ① 成功文件：新指纹必须已发布 ⇒ 视图确实被**成功提交**更新过。
      assert.notEqual(afterMap[okDb], beforeMap[okDb], "成功提交的文件必须发布新指纹");
      // ② 失败文件：指纹与告警必须与失败前**逐字一致**（事务回滚 + 视图未被污染）。
      assert.equal(afterMap[brokenDb], beforeMap[brokenDb], "失败文件的已发布指纹必须保持旧值");
      assert.deepEqual(afterWarnings[brokenDb], beforeWarnings[brokenDb], "失败文件的已发布告警必须保持旧值");
      assert.deepEqual(
        afterMap,
        JSON.parse(store.readMeta("perf_file_fingerprints")),
        "失败轮次结束后消费者读数仍必须等于库里已提交的映射",
      );
      // ③ 轮级版本既反映成功提交，又不含失败轮次的任何新值（失败文件指纹未变）。
      assert.notEqual(store.readMeta("perf_index_version"), beforeVersion, "轮级版本必须反映成功提交");
      // ④ 失败轮次同样至多解码 1 次/份。
      assert.ok(
        roundDecodes.fingerprints <= 1 && roundDecodes.warnings <= 1,
        `失败轮次仍至多解码 1 次/份（实测 ${roundDecodes.fingerprints}/${roundDecodes.warnings}）`,
      );

      // ⑤ 下一轮仍能正常解码与更新：修好损坏库 ⇒ 立刻恢复发布。
      decodes.fingerprints = 0;
      decodes.warnings = 0;
      await rm(brokenDb, { force: true });
      createZcodeDatabase(brokenDb, [zcodeRow("r1"), zcodeRow("r2")]);
      const recovered = await store.sync({ options: workspace.options });
      const recoveredDecodes = { ...decodes };
      assert.equal(recovered.updatedFileCount, 1, "修好后的来源文件必须恢复提交");
      assert.equal(recovered.perfState, "ready", "没有受阻 home 后状态必须回到 ready");
      const recoveredMap = store.readPublishedFileFingerprints();
      assert.notEqual(recoveredMap[brokenDb], beforeMap[brokenDb], "修好后必须发布新指纹");
      assert.ok(
        recoveredDecodes.fingerprints <= 1 && recoveredDecodes.warnings <= 1,
        `恢复轮次仍至多解码 1 次/份（实测 ${recoveredDecodes.fingerprints}/${recoveredDecodes.warnings}）`,
      );
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});
test("S1 · 事务失败反例（更深一层）：指纹已写、COMMIT 前失败 ⇒ 库与视图都保留旧值，轮末视图被丢弃", async () => {
  const workspace = await makeTwoZcodeHomeWorkspace();
  try {
    const store = await openStore(workspace.root, workspace.storeFile);
    try {
      await store.sync({ options: workspace.options });
      const beforeMap = store.readPublishedFileFingerprints();
      const beforeWarnings = store.readPublishedFileWarnings();
      const beforeVersion = store.readMeta("perf_index_version");
      assert.equal(Object.keys(beforeMap).length, 2, "前置：两份来源文件都必须已发布指纹");

      // 注入：让 `perf_file_warnings` 的写入在 **replaceFile 已经写完指纹之后** 抛错
      // ⇒ 指纹与告警必须在**同一个 ROLLBACK** 里一起回退（BC-2 的支点：两者同一次 COMMIT）。
      // 轮级发布事务也写同一个键 ⇒ 整轮 `sync()` 会抛出（这本身就是"注入的事务失败"）。
      for (const event of ["INSERT", "UPDATE"]) {
        store.database.exec(
          `CREATE TRIGGER s1_reject_${event} BEFORE ${event} ON store_meta WHEN NEW.key = 'perf_file_warnings'
           BEGIN SELECT RAISE(ABORT, 'S1 injected failure'); END;`,
        );
      }

      appendZcodeRow(workspace.dbFiles[0], "r2");
      const decodes = countPublishedMapDecodes(store);
      await assert.rejects(
        () => store.sync({ options: workspace.options }),
        (error) => {
          assert.match(String(error.message), /S1 injected failure/);
          return true;
        },
        "轮级发布事务同样写 perf_file_warnings ⇒ 该轮必须抛出（注入生效）",
      );
      const roundDecodes = { ...decodes };

      // ① 消费者读数与库都必须原样：旧指纹、旧告警、旧轮级版本。
      assert.deepEqual(store.readPublishedFileFingerprints(), beforeMap, "失败必须保留旧指纹");
      assert.deepEqual(store.readPublishedFileWarnings(), beforeWarnings, "失败必须保留旧告警");
      assert.equal(store.readMeta("perf_index_version"), beforeVersion, "失败轮次不得改动轮级版本");
      // ② 抛错路径也必须丢弃轮内视图（不是长期缓存），且失败轮次的新值没有泄漏进库。
      assert.equal(store.publishedFileMapsView, null, "抛错轮结束后轮内视图必须为 null");
      // ③ 失败轮次仍至多解码 1 次/份。
      assert.ok(
        roundDecodes.fingerprints <= 1 && roundDecodes.warnings <= 1,
        `注入失败的轮次仍至多解码 1 次/份（实测 ${roundDecodes.fingerprints}/${roundDecodes.warnings}）`,
      );

      // ④ 下一轮仍能正常解码与更新：去掉注入 ⇒ 立刻恢复发布。
      store.database.exec("DROP TRIGGER s1_reject_INSERT");
      store.database.exec("DROP TRIGGER s1_reject_UPDATE");
      decodes.fingerprints = 0;
      decodes.warnings = 0;
      const recovered = await store.sync({ options: workspace.options });
      const recoveredDecodes = { ...decodes };
      assert.equal(recovered.updatedFileCount, 1, "去掉注入后必须恢复提交");
      const recoveredMap = store.readPublishedFileFingerprints();
      assert.notEqual(recoveredMap[workspace.dbFiles[0]], beforeMap[workspace.dbFiles[0]], "恢复轮必须发布新指纹");
      assert.ok(
        recoveredDecodes.fingerprints <= 1 && recoveredDecodes.warnings <= 1,
        `恢复轮仍至多解码 1 次/份（实测 ${recoveredDecodes.fingerprints}/${recoveredDecodes.warnings}）`,
      );
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});
/** 三个 zcode home：用于"真删除 + 兄弟文件事务回滚"在**同一轮**里同时发生的场景。 */
async function makeThreeZcodeHomeWorkspace() {
  const root = await makeTempDir();
  const homes = [
    { db: path.join(root, ".zcode", "cli", "db", "db.sqlite"), extra: false, session: "session-main" },
    { db: path.join(root, "extra-a", "cli", "db", "db.sqlite"), extra: true, session: "session-a" },
    { db: path.join(root, "extra-c", "cli", "db", "db.sqlite"), extra: true, session: "session-c" },
  ];
  for (const home of homes) {
    mkdirSync(path.dirname(home.db), { recursive: true });
    createZcodeDatabase(home.db, [zcodeRow("r1", { session_id: home.session })]);
  }
  return {
    root,
    storeFile: path.join(root, "usage-index.sqlite"),
    dbFiles: homes.map((home) => home.db),
    deletedDb: homes[2].db,
    options: {
      homeDir: root,
      extraZcodeHomes: homes
        .filter((home) => home.extra)
        .map((home) => path.dirname(path.dirname(path.dirname(home.db))))
        .join(path.delimiter),
    },
  };
}

test("S1 · 回滚污染反例：真删除与同轮内 `perf_file_warnings` 写失败 ⇒ 失败文件的新指纹不得泄漏进库", async () => {
  const workspace = await makeThreeZcodeHomeWorkspace();
  const [dbA, , dbC] = workspace.dbFiles;
  try {
    const store = await openStore(workspace.root, workspace.storeFile);
    try {
      await store.sync({ options: workspace.options });
      const beforeMap = store.readPublishedFileFingerprints();
      const beforeVersion = store.readMeta("perf_index_version");
      assert.equal(Object.keys(beforeMap).length, 3, "前置：三个来源文件都必须已发布指纹");

      // 注入：只要 `perf_file_warnings` 的 JSON 里**还有 C 的键**就中止写入。
      // 逐文件提交发生在**真删除落库之前**（那时视图里还有 C）⇒ 该事务必然回滚；
      // 轮级发布发生在真删除**之后**（C 已被摘出 map）⇒ 不再匹配 ⇒ 那一轮**不抛错**。
      // 这样"失败文件的指纹已写、告警写失败"的边界就被单独打到了。
      const needle = JSON.stringify(dbC).slice(1, -1);
      for (const event of ["INSERT", "UPDATE"]) {
        store.database.exec(
          `CREATE TRIGGER s1_reject_while_c_${event} BEFORE ${event} ON store_meta
           WHEN NEW.key = 'perf_file_warnings' AND instr(NEW.value, '${needle}') > 0
           BEGIN SELECT RAISE(ABORT, 'S1 injected failure'); END;`,
        );
      }

      appendZcodeRow(dbA, "r2");
      await rm(dbC, { force: true });

      const decodes = countPublishedMapDecodes(store);
      const round = await store.sync({ options: workspace.options });
      const roundDecodes = { ...decodes };

      const afterMap = store.readPublishedFileFingerprints();
      assert.equal(round.updatedFileCount, 0, "被注入中止的文件不得计入提交");
      assert.equal(afterMap[dbA], beforeMap[dbA], "整笔回滚 ⇒ A 必须保留旧指纹（视图未被失败轮次的新值污染）");
      assert.equal(Object.hasOwn(afterMap, dbC), false, "真删除必须移除 C 的已完成指纹分量");
      assert.deepEqual(
        afterMap,
        JSON.parse(store.readMeta("perf_file_fingerprints")),
        "消费者读数必须等于库里已提交的映射",
      );
      assert.notEqual(store.readMeta("perf_index_version"), beforeVersion, "真删除必须改变轮级版本");
      assert.ok(
        roundDecodes.fingerprints <= 1 && roundDecodes.warnings <= 1,
        `该轮仍至多解码 1 次/份（实测 ${roundDecodes.fingerprints}/${roundDecodes.warnings}）`,
      );

      // 去掉注入 ⇒ 下一轮恢复提交 A。
      store.database.exec("DROP TRIGGER s1_reject_while_c_INSERT");
      store.database.exec("DROP TRIGGER s1_reject_while_c_UPDATE");
      decodes.fingerprints = 0;
      decodes.warnings = 0;
      const recovered = await store.sync({ options: workspace.options });
      const recoveredDecodes = { ...decodes };
      assert.equal(recovered.updatedFileCount, 1, "去掉注入后 A 必须恢复提交");
      assert.notEqual(store.readPublishedFileFingerprints()[dbA], beforeMap[dbA], "恢复轮必须发布 A 的新指纹");
      assert.ok(
        recoveredDecodes.fingerprints <= 1 && recoveredDecodes.warnings <= 1,
        `恢复轮仍至多解码 1 次/份（实测 ${recoveredDecodes.fingerprints}/${recoveredDecodes.warnings}）`,
      );
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(workspace.root);
  }
});

// ---------------------------------------------------------------------------
// S2（同稳定窗口的探针去重）：读取后窗口复用 / 窗口失效即重新探针 / 前后·发布窗口仍新鲜
// ---------------------------------------------------------------------------
//
// 被复用的是什么：`planStableCodexHome()` 在**整文件解析之后**取到的
// `window.after.fileFingerprints[path]`（由 `usage-core.js` 的 `perfContentFingerprint` 产出）。
// 复用它的消费点是 `sync()` 逐文件循环里"要不要重解析这份文件的用量"的判据
// （`perfFileNeedsRefresh` 的 codex 分支）—— 该判据与 `after` 摘要之间**没有对该文件的任何读取**。
//
// 三条必须守住的边界（卡面"前后/发布窗口分别新鲜"）：
//   ① `window.before` / `window.after` / 发布前复核**各自新鲜**：本卡不把 before 喂给 after，
//      也不把 after 喂给发布前复核（后者一旦复用就恒真 ⇒ 读取期间变化检测静默失效）；
//   ② 窗口失效（`ok`/`stable`/`complete` 任一不成立、该文件不在窗口内）⇒ **重新探针**；
//   ③ 复用键必须是**物理文件**：`main`/`jetbrains`/`extra` 折成 `codex`，路径做规范化折叠，
//      其它来源（zcode/dsh/opencode）一律不复用。

import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";

/**
 * 一个**合法且长度固定**的 codex rollout：`token` 只允许**等长**替换
 * （用来做"同尺寸 + 同 mtime 的原地改写"）。
 */
function s2RolloutText(index, token) {
  const lines = [
    { type: "session_meta", payload: { id: `s2-thread-${index}` } },
    { type: "turn_context", payload: { model: "s2-fixture-model", cwd: `C:/s2/${token}` } },
  ];
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

/** 造一个 codex home（`<root>/<id>/sessions/2026/10/rollout-NN.jsonl`）。 */
function makeS2CodexHome(root, { count = 2, id = "s2-codex" } = {}) {
  const homeDir = path.join(root, id);
  const sessionsDir = path.join(homeDir, "sessions", "2026", "10");
  mkdirSync(sessionsDir, { recursive: true });
  const rollouts = [];
  for (let i = 0; i < count; i += 1) {
    const file = path.join(sessionsDir, `rollout-${String(i).padStart(2, "0")}.jsonl`);
    writeFileSync(file, s2RolloutText(i, "aaaa"));
    rollouts.push(file);
  }
  return { id, label: "S2 Codex", path: homeDir, kind: "codex", sessionsDir, rollouts };
}

/** 新增一个 rollout（改变文件集合 ⇒ 下一轮**必然重新规划**该 home，从而产生稳定窗口）。 */
function addS2Rollout(home, index) {
  const file = path.join(home.sessionsDir, `rollout-${String(index).padStart(2, "0")}.jsonl`);
  writeFileSync(file, s2RolloutText(index, "aaaa"));
  home.rollouts.push(file);
  return file;
}

/**
 * **同尺寸 + 同整毫秒 mtime** 的原地改写（B7 的判别现场）：
 * 内容换成等长的 `token`，随后把 mtime 钉回改写前的整毫秒值 ⇒ `size + mtimeMs` 判据看不见。
 */
function rewriteS2RolloutSameMetadata(file, token) {
  const before = statSync(file);
  const text = readFileSync(file, "utf8");
  const next = text.replace(/C:\/s2\/[a-z]+/g, `C:/s2/${token}`);
  assert.equal(next.length, text.length, "前置：原地改写必须**等长**（否则 size 判据会先发现）");
  writeFileSync(file, next);
  utimesSync(file, before.atime, before.mtime);
  const after = statSync(file);
  assert.equal(after.size, before.size, "前置：size 必须未变");
  assert.equal(Math.round(after.mtimeMs), Math.round(before.mtimeMs), "前置：mtime 必须未变");
  return { size: before.size, mtimeMs: Math.round(before.mtimeMs) };
}

/**
 * 在**逐文件判据之前、读取后窗口成立之后**注入一次原地改写。
 * 注入点 = 循环里 `SELECT DISTINCT session_id FROM events WHERE source_path = ?`
 * （它对目标文件执行，且**早于**同一文件的 `perfFileNeedsRefresh` 判据）。
 */
function injectBeforeDecision(store, targetFile, action) {
  const state = { injected: false, calls: 0 };
  const realPrepare = store.database.prepare.bind(store.database);
  store.database.prepare = (sql) => {
    const stmt = realPrepare(sql);
    if (!String(sql).includes("SELECT DISTINCT session_id FROM events WHERE source_path = ?")) return stmt;
    const realAll = stmt.all.bind(stmt);
    stmt.all = (...args) => {
      if (String(args[0]) === targetFile) {
        state.calls += 1;
        if (!state.injected) {
          state.injected = true;
          action();
        }
      }
      return realAll(...args);
    };
    return stmt;
  };
  state.restore = () => {
    store.database.prepare = realPrepare;
  };
  return state;
}

test("S2 · 窗口取值守卫：来源身份 / 规范物理路径 / 窗口有效性逐条判定（失效 ⇒ undefined）", async () => {
  const root = await makeTempDir();
  try {
    const store = await openStore(root, path.join(root, "usage-index.sqlite"));
    try {
      const target = path.join(root, "a", "rollout.jsonl");
      const after = { complete: true, fileFingerprints: { [target]: "AFTER-1" } };
      const plan = { window: { ok: true, stable: true, after } };
      const value = (candidate, kind, filePath) => store.codexWindowedProbeValue(candidate, kind, filePath);

      // ① 来源身份：`main`/`jetbrains`/`extra` 都折成 `codex` ⇒ 命中；其它来源**一律**不复用。
      for (const alias of ["main", "jetbrains", "extra", "codex"]) {
        assert.equal(value(plan, alias, target), "AFTER-1", `${alias} 必须折成 codex 后命中窗口`);
      }
      for (const other of ["zcode", "dsh", "opencode", "project-log", ""]) {
        assert.equal(value(plan, other, target), undefined, `${other} 不得复用 codex 窗口的摘要`);
      }

      // ② 规范物理路径：同一物理文件的另一种写法（`..` 折叠 / 大小写）必须命中同一键。
      const spelled = path.join(root, "a", "..", "a", "rollout.jsonl");
      assert.equal(value(plan, "main", spelled), "AFTER-1", "`..` 折叠后是同一物理文件 ⇒ 必须命中");
      if (process.platform === "win32") {
        assert.equal(value(plan, "main", target.toUpperCase()), "AFTER-1", "Windows 大小写不敏感 ⇒ 必须命中");
      }
      assert.equal(value(plan, "main", path.join(root, "a", "other.jsonl")), undefined, "不在窗口内的文件 ⇒ 不复用");

      // ③ 窗口有效性：任何一条不成立都**必须**返回 undefined（调用方重新探针）。
      assert.equal(value(undefined, "main", target), undefined, "未规划 ⇒ 不复用");
      assert.equal(value({}, "main", target), undefined, "无 window 字段 ⇒ 不复用");
      assert.equal(value({ window: null }, "main", target), undefined, "window = null ⇒ 不复用");
      assert.equal(
        value({ window: { ok: false, stable: true, after } }, "main", target),
        undefined,
        "home 不可用（ok=false）⇒ 不复用",
      );
      assert.equal(
        value({ window: { ok: true, stable: false, after } }, "main", target),
        undefined,
        "**读取期间来源变化**（stable=false）⇒ 必须重新探针",
      );
      assert.equal(
        value({ window: { ok: true, stable: true, after: { complete: false, fileFingerprints: {} } } }, "main", target),
        undefined,
        "快照不完整（complete=false）⇒ 不复用",
      );
      assert.equal(
        value({ window: { ok: true, stable: true, after: { complete: true } } }, "main", target),
        undefined,
        "缺 fileFingerprints ⇒ 不复用",
      );

      // ④ 判别力：before 与 after 不同 ⇒ 必须取 **after**（读取后窗口），不得拿读取前/发布前充数。
      const twoSided = {
        window: {
          ok: true,
          stable: true,
          before: { complete: true, fileFingerprints: { [target]: "BEFORE-1" } },
          after: { complete: true, fileFingerprints: { [target]: "AFTER-1" } },
        },
      };
      assert.equal(value(twoSided, "main", target), "AFTER-1", "只允许复用**读取后**摘要");
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(root);
  }
});

test("S2 · 读取后窗口复用：同窗口内不再重复摘要；发布前窗口仍**新鲜**（同元数据改写仍被检出）", async () => {
  const root = await makeTempDir();
  try {
    const home = makeS2CodexHome(root, { count: 2 });
    const store = await openStore(root, path.join(root, "usage-index.sqlite"));
    const options = { homeDir: root, importDirs: [home.path] };
    try {
      const first = await store.sync({ options });
      assert.equal(
        store.readPublishedFileFingerprints()[home.rollouts[0]] !== undefined,
        true,
        "前置：首轮必须发布指纹",
      );
      assert.equal(store.readMeta("perf_state"), "ready", `前置：首轮必须 ready（实得 ${first.perfState}）`);

      // 强制第 2 轮**重新规划**该 home（文件集合变化）⇒ 本轮存在"读取后稳定窗口"。
      const added = addS2Rollout(home, 2);
      const publishedBefore = store.readPublishedFileFingerprints()[home.rollouts[0]];
      // 在"窗口已成立、该文件的逐文件判据尚未执行"的时刻原地改写 rollout[0]。
      const injection = injectBeforeDecision(store, home.rollouts[0], () =>
        rewriteS2RolloutSameMetadata(home.rollouts[0], "zzzz"),
      );
      let second;
      try {
        second = await store.sync({ options });
      } finally {
        injection.restore();
      }
      assert.equal(injection.injected, true, "前置：注入必须真的发生（否则本用例没有现场）");
      assert.equal(injection.calls >= 1, true, "前置：注入点（逐文件判据之前）必须被执行");

      const warnings = JSON.parse(store.readMeta("perf_source_warnings") || "[]");
      console.log(
        "  [实测] S2 复用轮：updated =",
        second.updatedFileCount,
        " state =",
        second.perfState,
        " warnings =",
        JSON.stringify(warnings),
      );

      // ① 复用**确实发生**：rollout[0] 的用量重提取判据读到的是"读取后窗口"的摘要
      //    （= 改写前的字节），因此判据为"未变" ⇒ 该文件**不**进入 replaceFile。
      //    只有新加入的 rollout-02 会被提交 ⇒ updatedFileCount = 1。
      //    判别力：一旦去掉复用（每次都真实探针），这里会读到改写后的字节 ⇒ updatedFileCount = 2。
      assert.equal(second.updatedFileCount, 1, '复用生效：改写过的 rollout[0] 不得被逐文件判据当成"已变"');
      // ② 发布前复核窗口**保持新鲜**：它必须看见改写 ⇒ LIVE_SOURCE_CHANGED（复用不得跨到发布窗口）。
      assert.equal(second.perfState, "degraded", "发布前复核必须检出改写并标 degraded");
      assert.ok(
        warnings.some((warning) => warning.code === "LIVE_SOURCE_CHANGED"),
        `发布前复核必须给出 LIVE_SOURCE_CHANGED，实得 ${JSON.stringify(warnings)}`,
      );
      // ③ 发布前复核失败 ⇒ 该 home **整轮不发布**：已发布指纹保持上一轮成功值，新文件也不得进入。
      assert.equal(
        store.readPublishedFileFingerprints()[home.rollouts[0]],
        publishedBefore,
        "复核失败 ⇒ 已发布指纹必须保持上一轮成功值",
      );
      assert.equal(
        store.readPublishedFileFingerprints()[added],
        undefined,
        "复核失败的 home 不得发布新文件的指纹（阻断的是整 home 的发布）",
      );

      // ④ 下一轮必须**恢复**：上一轮 degraded ⇒ 重新规划 ⇒ 读取后窗口 = 改写后的字节 ≠ 已发布值
      //    ⇒ 该 rollout 被重解析并提交，已发布指纹推进到改写后，状态回到 ready。
      //    （这证明"延迟"最多一轮，且不是静默丢更新。）
      const third = await store.sync({ options });
      console.log("  [实测] S2 恢复轮：updated =", third.updatedFileCount, " state =", third.perfState);
      // = 2：① 被改写的 rollout[0]（内容 ≠ 已发布值）；② 新增的 rollout-02 —— 它上一轮因整 home 发布
      // 被阻断而**没有**已发布指纹，本轮必须补提取。rollout-01（内容未变且已发布）必须跳过。
      assert.equal(third.updatedFileCount, 2, "下一轮必须重新提取被改写的 rollout 与未发布的 rollout-02");
      assert.notEqual(
        store.readPublishedFileFingerprints()[home.rollouts[0]],
        publishedBefore,
        "下一轮必须把已发布指纹推进到改写后的字节",
      );
      assert.equal(third.perfState, "ready", `下一轮必须恢复 ready（实得 ${third.perfState}）`);
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(root);
  }
});

test("S2 · 同尺寸同 mtime 改写仍检出：稳定窗口在**读取后**重新取快照（前后窗口分别新鲜）", async () => {
  const root = await makeTempDir();
  try {
    const home = makeS2CodexHome(root, { count: 2 });
    const store = await openStore(root, path.join(root, "usage-index.sqlite"));
    const options = { homeDir: root, importDirs: [home.path] };
    try {
      await store.sync({ options });
      const before = store.readPublishedFileFingerprints()[home.rollouts[0]];
      assert.equal(before !== undefined, true, "前置：首轮必须发布指纹");

      // 轮**之间**做同尺寸 + 同 mtime 的原地改写：size/mtime 判据看不见，只能靠内容摘要。
      // 连做两轮（第 2、3 轮）⇒ 同时覆盖"跨轮复用"：第 3 轮若拿第 2 轮的窗口摘要充数，
      // 就会把已经变了的字节判成"未变"（`updatedFileCount` 掉到 0）。
      rewriteS2RolloutSameMetadata(home.rollouts[0], "zzzz");
      const round = await store.sync({ options });
      const after = store.readPublishedFileFingerprints()[home.rollouts[0]];
      console.log("  [实测] S2 同元数据改写轮：updated =", round.updatedFileCount, " state =", round.perfState);
      assert.notEqual(after, before, "同尺寸同 mtime 改写必须改变已发布指纹（内容摘要检出）");
      assert.equal(round.updatedFileCount, 1, "改写的 rollout 必须被重解析并提交");
      assert.equal(round.perfState, "ready", `该轮必须 ready（实得 ${round.perfState}）`);

      rewriteS2RolloutSameMetadata(home.rollouts[0], "wwww");
      const round3 = await store.sync({ options });
      const after3 = store.readPublishedFileFingerprints()[home.rollouts[0]];
      console.log(
        "  [实测] S2 同元数据改写轮（第 3 轮）：updated =",
        round3.updatedFileCount,
        " state =",
        round3.perfState,
      );
      assert.notEqual(after3, after, "第 3 轮的改写同样必须改变已发布指纹（不得跨轮复用）");
      assert.equal(round3.updatedFileCount, 1, "第 3 轮同样必须重解析并提交（跨轮复用会在这里掉到 0）");
      assert.equal(round3.perfState, "ready", `第 3 轮必须 ready（实得 ${round3.perfState}）`);
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(root);
  }
});

test("S2 · 接线与身份守卫：codex 命中窗口、非 codex 与窗口外文件一律走真实探针", async () => {
  const root = await makeTempDir();
  try {
    const codexHome = makeS2CodexHome(root, { count: 2 });
    const zcodeHome = path.join(root, "s2-zcode");
    const dbDir = path.join(zcodeHome, "cli", "db");
    mkdirSync(dbDir, { recursive: true });
    createZcodeDatabase(path.join(dbDir, "db.sqlite"), [zcodeRow("s2-r1")]);
    const store = await openStore(root, path.join(root, "usage-index.sqlite"));
    const options = { homeDir: root, importDirs: [codexHome.path, zcodeHome] };
    try {
      /** 记录每一对 `(kind, path) → 复用值`：既证明接线，又证明身份/窗口守卫。 */
      const seen = [];
      const real = store.codexWindowedProbeValue.bind(store);
      // 第 1 轮全部文件都是"新文件"（`source_files` 无行）⇒ 逐文件判据整段跳过、接线点不会被调用。
      // 因此先跑一轮建基线，再用"新增 rollout"强制第 2 轮**重新规划**该 home。
      await store.sync({ options });
      addS2Rollout(codexHome, 2);
      store.codexWindowedProbeValue = (plan, kind, filePath) => {
        const value = real(plan, kind, filePath);
        seen.push({ kind, file: filePath, reused: value !== undefined });
        return value;
      };
      await store.sync({ options });
      store.codexWindowedProbeValue = real;

      const codexRollout = seen.filter((row) => row.file === codexHome.rollouts[0]);
      assert.equal(codexRollout.length >= 1, true, "前置：codex rollout 必须经过该接线点");
      assert.equal(
        codexRollout.some((row) => row.reused),
        true,
        "codex rollout 在**已规划**的轮次里必须命中读取后窗口（否则复用没有接线）",
      );
      const zcodeRows = seen.filter((row) => String(row.file).includes("s2-zcode"));
      assert.equal(zcodeRows.length >= 1, true, "前置：zcode 文件必须经过该接线点（否则守卫未被检验）");
      assert.equal(
        zcodeRows.every((row) => !row.reused),
        true,
        "非 codex 来源一律不得复用 codex 窗口的摘要",
      );
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(root);
  }
});

// ---------------------------------------------------------------------------
// C2（失败复用的全部触发/告警/恢复）：复用判定贯通「逐文件 refresh」与 `pendingChange` 收尾
// ---------------------------------------------------------------------------
//
// 与 S2 段同一纪律：这里在 **store 级**只观察"必须真的接线才成立"的两件事 ——
//   ① 复用轮的**逐文件判据**确实从 C1 的稳定签名取值（`codexReusedProbeValue` 被调用且返回非空）；
//      没有接线时该数组为空（复用轮里该 home 不进 `codexPlans` ⇒ 窗口复用不适用）⇒ 断言失败。
//   ② 复用轮**仍然**先写 `rebuilding`：`shouldPlan` 为真 ⇒ `codexPendingChange = true` ⇒
//      `pendingChange` 的预扫标记没有被"跳过规划"顺带跳过（这是"贯通 pendingChange"的可观测面）。

test("C2 · 复用轮：逐文件判据走稳定签名、仍然先写 rebuilding、记录不被重建", async () => {
  const root = await makeTempDir();
  try {
    const store = await openStore(root, path.join(root, "usage-index.sqlite"));
    try {
      const home = makeS2CodexHome(root, { count: 1, id: "c2-codex" });
      const badFile = path.join(home.sessionsDir, "rollout-99.jsonl");
      writeFileSync(
        badFile,
        `${JSON.stringify({ type: "session_meta", payload: { id: "c2-thread-bad" } })}\n{not json\n`,
      );
      const options = {
        homeDir: root,
        env: {},
        extraHomes: home.path,
        importDirs: [],
        automaticDiscoveryEnabled: false,
      };
      const seenReuse = [];
      const realReused = store.codexReusedProbeValue.bind(store);
      store.codexReusedProbeValue = (signature, kind, filePath) => {
        const value = realReused(signature, kind, filePath);
        seenReuse.push({ file: path.basename(filePath), kind, reused: value !== undefined });
        return value;
      };
      const states = [];
      const realWriteState = store.writePerfState.bind(store);
      store.writePerfState = (state, extra) => {
        states.push(state);
        return realWriteState(state, extra);
      };
      const first = await store.sync({ options });
      assert.equal(first.perfState, "degraded");
      assert.equal(store.codexStableAttempts.size, 1, "确定性部分失败必须留下记录");
      const homeId = [...store.codexStableAttempts.keys()][0];
      const record = store.codexStableAttempts.get(homeId);
      states.length = 0;
      seenReuse.length = 0;
      const second = await store.sync({ options });
      assert.equal(second.perfState, "degraded");
      assert.deepEqual(states, ["rebuilding", "degraded"], "复用轮仍必须先标 rebuilding（pendingChange 未被跳过）");
      assert.equal(store.codexStableAttempts.get(homeId), record, "复用轮不得重建记录（重建 = 真的重跑过规划）");
      assert.equal(
        seenReuse.some((entry) => entry.reused),
        true,
        "复用轮必须真的从稳定签名取值（否则逐文件判据在重复探针 ⇒ 本卡的收益为 0）",
      );
      assert.equal(
        seenReuse.some((entry) => entry.kind === "extra" && entry.file === "rollout-99.jsonl" && entry.reused),
        true,
        "坏线程的 rollout 也必须由签名供给（它是每轮都要重解析的那一份）",
      );
      assert.equal(second.updatedFileCount, 1, "用量侧仍独立提交：只有坏线程那份需要重解析");
    } finally {
      store.close();
    }
  } finally {
    await cleanupDir(root);
  }
});
// ★D5-BLOCK-START store
// ---------------------------------------------------------------------------
// ★D5：`perfSampleIdentities()` —— 取排名用的身份投影
// ---------------------------------------------------------------------------

test("★D5 perfSampleIdentities：只取 3 个身份列、覆盖全表（含 unplaced）、不做行级解码", async () => {
  const { dir, store, sample } = await makeWritableStore();
  try {
    const good = validRow({ sample_key: "d5-good", ts_ms: 1_700_000_000_000 });
    const unplaced = validRow({ sample_key: "d5-unplaced", ts_ms: null });
    const broken = validRow({
      sample_key: "d5-broken",
      ts_ms: 1_700_000_001_000,
      diagnostic_reason_chain: "not-json",
    });
    for (const row of [good, unplaced, broken]) insertRawRow(store.database, row);

    // 前置：解码路径确实会为坏链响亮失败（说明"不解码"是真的边界变化，不是空话）
    assert.throws(
      () => store.perfCandidatesForRange(null),
      (error) => error.code === "INVALID_REASON_CHAIN",
      "前置：坏链必须让解码路径失败",
    );

    const identities = store.perfSampleIdentities();
    assert.equal(identities.length, 3, "身份投影覆盖全表（含 unplaced 与坏链行）");
    assert.deepEqual(Object.keys(identities[0]).sort(), ["homeId", "sampleKey", "sourceKind"]);
    assert.deepEqual(identities.map((row) => row.sampleKey).sort(), ["d5-broken", "d5-good", "d5-unplaced"]);
    for (const row of identities) {
      assert.equal(row.sourceKind, sample.sourceKind);
      assert.equal(row.homeId, sample.homeId);
      assert.equal(typeof row.sampleKey, "string");
    }

    // 坏链修好后：与旧实现（候选 ∪ unplaced）逐行同集
    store.database
      .prepare("UPDATE perf_samples SET diagnostic_reason_chain = NULL WHERE sample_key = 'd5-broken'")
      .run();
    const union = [...store.perfCandidatesForRange(null), ...store.unplacedPerfSamples()]
      .map((entry) => entry.sampleKey)
      .sort();
    assert.equal(union.length, 3);
    assert.deepEqual(
      store
        .perfSampleIdentities()
        .map((row) => row.sampleKey)
        .sort(),
      union,
    );
  } finally {
    store.close();
    await cleanupDir(dir);
  }
});
