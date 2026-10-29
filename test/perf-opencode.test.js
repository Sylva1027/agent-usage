// OpenCode generation TPS reader 专项测试。
//
// 纪律（M1/M2.1 教训固化）：
// - **只测一侧 = 没测规则**：每条规则都测正例与反例（v1 排除 vs v2 放行；坏 JSON 中断 vs 不中断；
//   reasoning 已折叠 vs 分列；`finish` 已识别 vs 未识别；只读成功 vs 只读失败）。
// - **不写死期望值**：断言恒等式与判别式，不硬编码本机行数；期望值全部手算写进注释。
// - **遇 0 先问"判别式可达吗"**：凡断言 `0`/`null` 的地方，都另有一条用例证明该分支确实可达。
// - 夹具全部是临时目录里的合成 SQLite，绝不触碰本机真实库（`~/.local/share/opencode/opencode.db`）。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  normalizePerfSample,
  PERF_METHOD_VERSION,
  perfFlagNamesOf,
  perfGroupKey,
  perfSampleKey,
} from "../src/perf-stats.js";
import {
  buildOpencodeMalformedCountSql,
  buildOpencodePerfSql,
  canonicalOpencodeDatabaseIdentity,
  classifyOpencodeTerminal,
  combineOpencodeOutputTokens,
  OPENCODE_CHANNEL,
  OPENCODE_FINISH_COMPLETED,
  OPENCODE_FINISH_FAILED,
  OPENCODE_MINIMUM_COLUMNS,
  OPENCODE_PERF_JSON_PATHS,
  OpencodePerfReadError,
  resolveOpencodeDuration,
  resolveOpencodeTsMs,
  sessionVersionMajor,
  streamOpencodePerfSamples,
} from "../src/perf-sources/opencode.js";

// ---------------------------------------------------------------- 夹具

const BASE_TS = 1_790_000_000_000;
/** 正文哨兵：`data.content` 里塞正文时**绝不能**出现在任何产出里。 */
const BODY_SENTINEL = "BODY_SENTINEL_MUST_NEVER_BE_READ_7f3ac1";
/** 与真实库一致的列类型（`~/.local/share/opencode/opencode.db` 实测）。 */
const COLUMN_TYPES = {
  id: "TEXT PRIMARY KEY",
  session_id: "TEXT NOT NULL",
  type: "TEXT NOT NULL",
  seq: "INTEGER NOT NULL",
  time_created: "INTEGER NOT NULL",
  time_updated: "INTEGER NOT NULL",
  data: "TEXT NOT NULL",
};
const MESSAGE_COLUMNS = ["id", "session_id", "type", "seq", "time_created", "time_updated", "data"];

/**
 * 构造一条 assistant 消息的 `data` JSON。
 *
 * 默认值刻意"完整且正常"：`drop` 用来表达**键缺失**，直接传 `null` 表达**键在但值为 JSON null**
 * ——两者在本投影里必须等价（非标量闸门 → NULL），测试两侧都断言。
 */
function messageData(options = {}) {
  const { drop = [], includeTokens = true, finish = "stop", error, extra, ...values } = options;
  /** @type {Record<string, unknown>} */
  const data = {
    time: {
      created: values.created === undefined ? BASE_TS : values.created,
      streamed: values.streamed === undefined ? BASE_TS + 1000 : values.streamed,
      // completed 是工具执行后的 step-ended 时间：故意晚 1 小时，误用它会立刻变红。
      completed: values.completed === undefined ? BASE_TS + 3_600_000 : values.completed,
    },
    model: {
      id: values.modelId === undefined ? "fixture-model" : values.modelId,
      providerID: values.providerId === undefined ? "fixture-provider" : values.providerId,
      variant: values.variant === undefined ? "xhigh" : values.variant,
    },
    agent: values.agent === undefined ? "fixture-agent" : values.agent,
    content: [{ type: "text", text: BODY_SENTINEL }],
    ...extra,
  };
  if (finish !== null) data.finish = finish;
  if (error !== undefined) data.error = error;
  if (includeTokens) {
    data.tokens = {
      output: values.output === undefined ? 100 : values.output,
      reasoning: values.reasoning === undefined ? 0 : values.reasoning,
      input: values.input === undefined ? 10 : values.input,
      cache: {
        read: values.cacheRead === undefined ? 0 : values.cacheRead,
        write: values.cacheWrite === undefined ? 0 : values.cacheWrite,
      },
    };
  }
  for (const jsonPath of drop) {
    const parts = jsonPath.split(".");
    let cursor = data;
    for (const part of parts.slice(0, -1)) {
      if (cursor === null || typeof cursor !== "object") break;
      cursor = /** @type {Record<string, unknown>} */ (cursor)[part];
    }
    if (cursor !== null && typeof cursor === "object")
      delete (/** @type {Record<string, unknown>} */ (cursor)[parts.at(-1)]);
  }
  return data;
}

/** 默认消息行：正常完成、非推理 output 100、reasoning 真 0、请求诊断时长 1000ms。 */
function message(overrides = {}) {
  return {
    id: "msg-1",
    session_id: "ses-1",
    seq: 1,
    time_created: BASE_TS,
    data: messageData(),
    ...overrides,
  };
}

/**
 * 建夹具库：`session_message`（列可裁剪）+ 可选的 `session_v2`（可裁掉 `version` 列）。
 * @param {string} dbFile
 * @param {{messages?: object[], sessions?: object[], messageColumns?: string[], sessionTable?: boolean,
 *   versionColumn?: boolean, journalMode?: string|null, dataNullable?: boolean}} [options]
 */
function createFixtureDb(dbFile, options = {}) {
  const {
    messages = [],
    sessions = [],
    messageColumns = MESSAGE_COLUMNS,
    sessionTable = true,
    versionColumn = true,
    journalMode = null,
    dataNullable = false,
  } = options;
  const db = new DatabaseSync(dbFile);
  try {
    installFixtureSchema(db, { messageColumns, sessionTable, versionColumn, journalMode, dataNullable });
    insertFixtureMessages(db, messageColumns, messages);
    for (const session of sessions) {
      db.prepare("INSERT INTO session_v2 (id, version) VALUES (?, ?)").run(session.id, session.version);
    }
  } finally {
    db.close();
  }
  return dbFile;
}

/** 只建表（供需要保持写者句柄打开的用例复用）。 */
function installFixtureSchema(db, options = {}) {
  const {
    messageColumns = MESSAGE_COLUMNS,
    sessionTable = true,
    versionColumn = true,
    journalMode = null,
    dataNullable = false,
  } = options;
  if (journalMode) db.exec(`PRAGMA journal_mode=${journalMode}`);
  const types = dataNullable ? { ...COLUMN_TYPES, data: "TEXT" } : COLUMN_TYPES;
  db.exec(`CREATE TABLE session_message (${messageColumns.map((column) => `${column} ${types[column]}`).join(", ")})`);
  if (sessionTable) {
    db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY${versionColumn ? ", version TEXT" : ""})`);
  }
}

/** 只插行（供需要保持写者句柄打开的用例复用）。 */
function insertFixtureMessages(db, messageColumns, messages) {
  const columns = MESSAGE_COLUMNS.filter((column) => messageColumns.includes(column));
  const statement = db.prepare(
    `INSERT INTO session_message (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  );
  for (const entry of messages) {
    const row = {
      id: entry.id,
      session_id: entry.session_id,
      type: entry.type === undefined ? "assistant" : entry.type,
      seq: entry.seq,
      time_created: entry.time_created === undefined ? BASE_TS : entry.time_created,
      time_updated: entry.time_updated === undefined ? (entry.time_created ?? BASE_TS) : entry.time_updated,
      data: typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data),
    };
    statement.run(...columns.map((column) => (row[column] === undefined ? null : row[column])));
  }
}

/** 临时工作区：`root/<home>/opencode.db`。 */
function makeWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), "m23-opencode-"));
  const homeDir = path.join(root, "home");
  mkdirSync(homeDir, { recursive: true });
  return {
    root,
    homeDir,
    dbFile: path.join(homeDir, "opencode.db"),
    source: { id: "home-1", path: homeDir },
    otherDbFile: path.join(homeDir, "opencode-extra.db"),
    cleanup() {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

/** 收集候选与警告（reader 是 async：`onSample` 允许返回 Promise 并被 await）。 */
async function collect(dbFile, source, options = {}) {
  const samples = [];
  const warnings = [];
  const stats = await streamOpencodePerfSamples(dbFile, source, (sample) => samples.push(sample), {
    onWarning: (warning) => warnings.push(warning),
    ...options,
  });
  return { samples, warnings, stats };
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** 库 + `-wal`/`-shm` 的哈希/大小快照（存在才记）。 */
function snapshotFiles(dbFile) {
  const snapshot = {};
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${dbFile}${suffix}`;
    if (existsSync(file)) snapshot[suffix] = { hash: sha256(file), size: statSync(file).size };
  }
  return snapshot;
}

function byMessageId(samples) {
  return new Map(samples.map((sample) => [sample.messageId, sample]));
}

function flagNamesOf(sample) {
  return perfFlagNamesOf(normalizePerfSample(sample).sample.sampleFlags);
}

function warningCount(warnings, code) {
  return warnings.filter((warning) => warning.code === code).reduce((total, warning) => total + warning.count, 0);
}

// ---------------------------------------------------------------- 1. SQL 白名单（只投影 JSON 标量）

const SELECT_ALIASES = [
  "message_id",
  "session_id",
  "seq",
  "created_ms",
  "streamed_ms",
  "completed_ms",
  "output_tokens",
  "reasoning_tokens",
  "model_id",
  "provider_id",
  "agent_name",
  "finish_text",
  "error_type",
];

test("SQL 只投影白名单别名，且 m.data 只作为 json 函数实参出现（绝不 SELECT data 整串）", () => {
  const sql = buildOpencodePerfSql();

  // 正向：SELECT 区的别名序列与白名单逐字一致（顺序也锁：顺序变了必须显式处理）。
  const selectRegion = sql.slice(sql.indexOf("SELECT"), sql.indexOf("FROM session_message"));
  const aliases = [...selectRegion.matchAll(/\sAS\s+([a-z_][a-z0-9_]*)/g)].map((match) => match[1]);
  assert.deepEqual(aliases, SELECT_ALIASES);

  // 反向：SQL 里出现的 `m.<列>` 只有这 6 个（`type` 只用于 WHERE）。
  const referencedColumns = new Set([...sql.matchAll(/m\.([a-z_][a-z0-9_]*)/g)].map((match) => match[1]));
  assert.deepEqual([...referencedColumns].sort(), ["data", "id", "seq", "session_id", "time_created", "type"]);

  // `m.data` 每一次出现都必须是 json_valid/json_type/json_extract 的实参。
  const occurrences = [...sql.matchAll(/m\.data/g)];
  assert.ok(occurrences.length > 0, "投影必须经过 json 函数");
  for (const occurrence of occurrences) {
    const before = sql.slice(Math.max(0, occurrence.index - 14), occurrence.index);
    assert.match(before, /json_(valid|type|extract)\($/, `m.data 只能作为 json 函数实参，实际前文：${before}`);
  }
});

/** 冻结的投影路径全集：M0 已验证的路径 + 终态 + `$.error`（仅类型）。三方锁定（测试字面量 / 导出 / SQL 文本）。 */
const EXPECTED_JSON_PATHS = [
  "$.time.created",
  "$.time.streamed",
  "$.time.completed",
  "$.tokens.output",
  "$.tokens.reasoning",
  "$.model.id",
  "$.model.providerID",
  "$.agent",
  "$.finish",
  "$.error",
];

test("SQL 的 JSON 路径集合与冻结白名单双向一致；variant/content/item_json 永不进入", () => {
  const sql = buildOpencodePerfSql();
  /** @type {Map<string, number>} */
  const pathCounts = new Map();
  for (const match of sql.matchAll(/'(\$\.[A-Za-z.]+)'/g)) {
    pathCounts.set(match[1], (pathCounts.get(match[1]) ?? 0) + 1);
  }

  // 三方锁定：测试字面量 === 导出白名单 === SQL 文本里真实出现的路径。
  assert.deepEqual([...OPENCODE_PERF_JSON_PATHS].sort(), [...EXPECTED_JSON_PATHS].sort(), "导出白名单漂移");
  assert.deepEqual([...pathCounts.keys()].sort(), [...EXPECTED_JSON_PATHS].sort(), "SQL 文本漂移");

  // 裁定 AL-4：输入侧三路径**必须不存在**——它们未经 M0 验证，且 `inputTokens` 不被 M1 消费。
  // （反向锁：把它们加回白名单或 SQL 的任何一侧，本用例即红。）
  for (const removed of ["$.tokens.input", "$.tokens.cache.read", "$.tokens.cache.write"]) {
    assert.ok(!EXPECTED_JSON_PATHS.includes(removed));
    assert.ok(!pathCounts.has(removed), `${removed} 不得出现在 SQL 里（裁定 AL-4）`);
  }
  assert.ok(!sql.includes("cache"), "SQL 不得出现任何 cache 路径");
  assert.ok(!sql.includes("input_tokens"), "SQL 不得投影 input 诊断别名");

  for (const [jsonPath, count] of pathCounts) {
    if (jsonPath === "$.error") {
      assert.equal(count, 1, "$.error 只允许出现在 json_type 里（存在性与类型，绝不读值）");
    } else {
      // 每个标量路径必须恰好两次：类型闸门 + json_extract。少一次说明闸门被绕过，多一次说明重复投影。
      assert.equal(count, 2, `${jsonPath} 必须恰好出现两次（类型闸门 + json_extract）`);
    }
  }
  for (const jsonPath of EXPECTED_JSON_PATHS) {
    if (jsonPath === "$.error") continue;
    assert.ok(sql.includes(`json_type(m.data, '${jsonPath}') IN ('text','integer','real')`), `缺类型闸门：${jsonPath}`);
    assert.ok(sql.includes(`json_extract(m.data, '${jsonPath}')`), `缺取值：${jsonPath}`);
  }

  // variant（effort 不能回填）、content（正文）与整串读取必须永不出现。
  for (const forbidden of ["variant", "content", "item_json", "SELECT *", "data AS"]) {
    assert.ok(!sql.includes(forbidden), `SQL 不得包含 ${forbidden}`);
  }
  // `$.error` 只取类型，绝不取它的值。
  assert.ok(sql.includes("json_type(m.data, '$.error') END AS error_type"));
  assert.ok(!sql.includes("json_extract(m.data, '$.error')"));

  // 稳定迭代：seq 只用于排序（§17.1:205 明文：不能只靠全局 seq）。
  assert.match(sql, /WHERE m\.type = 'assistant' AND json_valid\(m\.data\) = 1/);
  assert.match(sql, /ORDER BY m\.time_created, m\.seq, m\.id/);
});

test("坏 JSON 计数 SQL 用 `IS NOT 1`（NULL 也要计入）且只查 assistant 行", () => {
  const sql = buildOpencodeMalformedCountSql();
  assert.match(sql, /count\(\*\)/);
  assert.match(
    sql,
    /json_valid\(data\) IS NOT 1/,
    "NULL 的 data 在 `<> 1` 下会被漏计（实测 json_valid(NULL) 返回 NULL）",
  );
  assert.match(sql, /type = 'assistant'/);
  assert.ok(!sql.includes("m."), "计数查询不参与投影");
});

// ---------------------------------------------------------------- 2. 能力守护与致命错误（每个必需列都可缺）

test("缺任一必需列 → 致命 UNSUPPORTED_SCHEMA 抛出（6 列逐个可达），不回退、不产出 0 样本", async () => {
  for (const missingColumn of OPENCODE_MINIMUM_COLUMNS) {
    const workspace = makeWorkspace();
    try {
      const columns = MESSAGE_COLUMNS.filter((column) => column !== missingColumn);
      createFixtureDb(workspace.dbFile, { messageColumns: columns, messages: [message()] });
      await assert.rejects(
        () => streamOpencodePerfSamples(workspace.dbFile, workspace.source, () => {}),
        (error) => {
          assert.ok(error instanceof OpencodePerfReadError);
          assert.equal(error.code, "UNSUPPORTED_SCHEMA", `缺 ${missingColumn} 应报 UNSUPPORTED_SCHEMA`);
          assert.equal(error.sourceKind, "opencode");
          assert.equal(error.homeId, "home-1");
          return true;
        },
      );
    } finally {
      workspace.cleanup();
    }
  }
});

test("非必需列（time_updated）缺失不影响读取：白名单只认 6 个必需列", async () => {
  const workspace = makeWorkspace();
  try {
    const columns = MESSAGE_COLUMNS.filter((column) => column !== "time_updated");
    createFixtureDb(workspace.dbFile, {
      messageColumns: columns,
      messages: [message()],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const { samples, stats } = await collect(workspace.dbFile, workspace.source);
    assert.equal(stats.rowsScanned, 1);
    assert.equal(samples.length, 1);
    assert.equal(samples[0].durationMs, null);
    assert.equal(samples[0].reportedDurationMs, 1000);
  } finally {
    workspace.cleanup();
  }
});

test("只读打开/读取失败 → 致命 READ_ONLY_OPEN_FAILED，且绝不回退可写、字节不变、消息不含路径", async () => {
  const workspace = makeWorkspace();
  try {
    // 形态 A：非 SQLite 文件（打开是惰性的，错误在第一条语句才出现）。
    writeFileSync(workspace.dbFile, Buffer.from("not a sqlite database, padding padding padding padding"));
    const before = sha256(workspace.dbFile);
    const sizeBefore = statSync(workspace.dbFile).size;
    await assert.rejects(
      () => streamOpencodePerfSamples(workspace.dbFile, workspace.source, () => {}),
      (error) => {
        assert.ok(error instanceof OpencodePerfReadError);
        assert.equal(error.code, "READ_ONLY_OPEN_FAILED");
        assert.equal(error.homeId, "home-1");
        // 脱敏：驱动消息里的原始库路径必须被剔除（§3 第 10 条）。
        assert.ok(!error.message.includes(workspace.root), "错误消息不得含原始路径");
        assert.ok(!error.message.includes(BODY_SENTINEL));
        return true;
      },
    );
    assert.equal(sha256(workspace.dbFile), before, "只读失败绝不触碰源库字节");
    assert.equal(statSync(workspace.dbFile).size, sizeBefore);

    // 形态 B：文件不存在（打开即失败）。
    await assert.rejects(
      () => streamOpencodePerfSamples(path.join(workspace.homeDir, "missing.db"), workspace.source, () => {}),
      (error) => {
        assert.equal(error.code, "READ_ONLY_OPEN_FAILED");
        return true;
      },
    );

    // 形态 C：空路径（调用方错误，也归只读失败）。
    await assert.rejects(
      () => streamOpencodePerfSamples("", workspace.source, () => {}),
      (error) => {
        assert.equal(error.code, "READ_ONLY_OPEN_FAILED");
        return true;
      },
    );
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------- 3. 只读性证明（哈希实测）

test("只读性：reader 前后主库与 -wal 的哈希/字节数不变（实测哈希，不是声明）", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [message({ id: "m-1" }), message({ id: "m-2", seq: 2 })],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const before = snapshotFiles(workspace.dbFile);
    const { samples } = await collect(workspace.dbFile, workspace.source);
    const after = snapshotFiles(workspace.dbFile);
    assert.equal(samples.length, 2);
    assert.equal(after[""].hash, before[""].hash);
    assert.equal(after[""].size, before[""].size);
    if (before["-wal"]) {
      assert.equal(after["-wal"].hash, before["-wal"].hash);
      assert.equal(after["-wal"].size, before["-wal"].size);
    }
  } finally {
    workspace.cleanup();
  }
});

test("WAL 模式（无写者持有）：只读 reader 仍可读，且主库/WAL 不变", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      journalMode: "wal",
      messages: [message({ id: "m-1" })],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const before = snapshotFiles(workspace.dbFile);
    const { samples } = await collect(workspace.dbFile, workspace.source);
    const after = snapshotFiles(workspace.dbFile);
    assert.equal(samples.length, 1);
    assert.equal(after[""].hash, before[""].hash);
  } finally {
    workspace.cleanup();
  }
});

test("WAL-only 变化：写者仍持有 WAL 时新行可见，主库与 -wal 字节不变（不被 reader 触碰）", async () => {
  const workspace = makeWorkspace();
  const writer = new DatabaseSync(workspace.dbFile);
  try {
    installFixtureSchema(writer, { journalMode: "wal" });
    writer.exec("PRAGMA wal_autocheckpoint=0");
    insertFixtureMessages(writer, MESSAGE_COLUMNS, [message({ id: "wal-1" }), message({ id: "wal-2", seq: 2 })]);
    writer.prepare("INSERT INTO session_v2 (id, version) VALUES (?, ?)").run("ses-1", "2.0.20");

    // 判别式：行确实还在 WAL 里（主库尚未收编）。
    assert.ok(existsSync(`${workspace.dbFile}-wal`));
    assert.ok(statSync(`${workspace.dbFile}-wal`).size > 0, "WAL 必须非空，否则本用例没测到 WAL-only 路径");

    const before = snapshotFiles(workspace.dbFile);
    const { samples } = await collect(workspace.dbFile, workspace.source);
    const after = snapshotFiles(workspace.dbFile);

    assert.equal(samples.length, 2, "WAL 里的行必须可见");
    assert.deepEqual([...byMessageId(samples).keys()].sort(), ["wal-1", "wal-2"]);
    assert.equal(after[""].hash, before[""].hash);
    assert.equal(after["-wal"].hash, before["-wal"].hash, "reader 不得改写源库的 WAL");
    assert.equal(after["-wal"].size, before["-wal"].size);
  } finally {
    writer.close();
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------- 4. 坏 JSON 不中断整库

test("坏 JSON 行不中断整库：坏行只计数告警，其余行照常产出（两侧都测）", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [
        message({ id: "good-1" }),
        message({ id: "bad-1", seq: 2, data: '{"time":{"created":1,' }),
        message({ id: "good-2", seq: 3 }),
        // `"null"` 是**合法 JSON**（`json_valid('null')` 返回 1）：它会成为候选但所有字段缺失。
        // 这正是"合法 JSON 但无证据"与"坏 JSON"必须区分的判别式。
        message({ id: "json-null", seq: 4, data: "null" }),
      ],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const { samples, warnings, stats } = await collect(workspace.dbFile, workspace.source);

    assert.equal(samples.length, 3, "坏行不得中断整库");
    assert.deepEqual([...byMessageId(samples).keys()].sort(), ["good-1", "good-2", "json-null"]);
    assert.equal(stats.malformedJsonRows, 1);
    assert.equal(warningCount(warnings, "MALFORMED_JSON"), 1);
    // 恒等式：投影读取行数 + 坏行 = 全部 assistant 行（坏行确实被读到过，只是没进投影）。
    assert.equal(stats.rowsScanned + stats.malformedJsonRows, 4);

    // 合法 JSON 的 `null` 行所有证据都缺失，但**不是**坏行、也不冒充 0。
    const empty = byMessageId(samples).get("json-null");
    assert.equal(empty.outputTokens, null);
    assert.equal(empty.durationMs, null);
    assert.equal(empty.tsMs, null);
    assert.equal(empty.model, "");
    assert.deepEqual(
      flagNamesOf(empty).sort(),
      ["MISSING_DURATION", "MISSING_OUTPUT", "TERMINAL_UNVERIFIED", "TIME_UNPLACED"],
      "合法 JSON 但所有证据缺失：既不冒充 0，也没有终态证据",
    );
  } finally {
    workspace.cleanup();
  }
});

test("SQL NULL 的 data 也计入坏行（`IS NOT 1` 判别式可达）：绝不因 NULL 静默漏计", async () => {
  const workspace = makeWorkspace();
  try {
    // 真实 schema 的 data 是 NOT NULL，所以 NULL 分支只能由"schema 退化"的夹具触发；
    // 本用例同时锁定：`json_valid(NULL)` 返回 NULL（不是 0），`<> 1` 会漏计，`IS NOT 1` 不会。
    createFixtureDb(workspace.dbFile, {
      dataNullable: true,
      messages: [message({ id: "sql-null", data: "null" }), message({ id: "key-missing", seq: 2 })],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const db = new DatabaseSync(workspace.dbFile);
    try {
      db.prepare("UPDATE session_message SET data = NULL WHERE id = ?").run("sql-null");
      assert.equal(db.prepare("SELECT json_valid(NULL) AS v").get().v, null, "json_valid(NULL) 必须是 NULL");
      assert.equal(
        db.prepare("SELECT count(*) AS n FROM session_message WHERE json_valid(data) <> 1").get().n,
        0,
        "`<> 1` 会漏计 NULL（这正是必须用 IS NOT 1 的原因）",
      );
    } finally {
      db.close();
    }

    const { samples, warnings, stats } = await collect(workspace.dbFile, workspace.source);
    assert.deepEqual(
      samples.map((sample) => sample.messageId),
      ["key-missing"],
    );
    assert.equal(stats.malformedJsonRows, 1, "SQL NULL 必须计入坏行");
    assert.equal(warningCount(warnings, "MALFORMED_JSON"), 1);
    assert.equal(stats.rowsScanned, 1);
  } finally {
    workspace.cleanup();
  }
});

test("整库只有坏 JSON 行：0 候选、不抛错、坏行计数可达（0 不是「没测到」）", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [message({ id: "bad-1", data: "{" }), message({ id: "bad-2", seq: 2, data: "" })],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const { samples, warnings, stats } = await collect(workspace.dbFile, workspace.source);
    assert.equal(samples.length, 0);
    assert.equal(stats.rowsScanned, 0);
    assert.equal(stats.malformedJsonRows, 2);
    assert.equal(warningCount(warnings, "MALFORMED_JSON"), 2);
  } finally {
    workspace.cleanup();
  }
});

test("非 assistant 行不参与：user/idle/坏 JSON 的 user 行都不产出候选也不计坏行", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [
        message({ id: "assistant-1" }),
        message({ id: "user-1", seq: 2, type: "user", data: "{broken" }),
        message({ id: "idle-1", seq: 3, type: "idle", data: messageData() }),
      ],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const { samples, stats } = await collect(workspace.dbFile, workspace.source);
    assert.deepEqual(
      samples.map((sample) => sample.messageId),
      ["assistant-1"],
    );
    assert.equal(stats.malformedJsonRows, 0, "坏 JSON 的 user 行与本投影无关");
    assert.equal(stats.rowsScanned, 1);
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------- 5. 版本三档

test("v1 明确排除并告警；同库 v2 会话照常放行（两侧对照）", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [
        message({ id: "v1-row", session_id: "ses-old", data: messageData({ output: 999 }) }),
        message({ id: "v2-row", session_id: "ses-new", seq: 2 }),
      ],
      sessions: [
        { id: "ses-old", version: "1.4.2" },
        { id: "ses-new", version: "2.0.20" },
      ],
    });
    const { samples, warnings, stats } = await collect(workspace.dbFile, workspace.source);

    // 被排除的行**读到了**（rowsScanned 计它），但不产出候选。
    assert.equal(stats.rowsScanned, 2);
    assert.deepEqual(
      samples.map((sample) => sample.messageId),
      ["v2-row"],
    );
    assert.equal(stats.legacyRows, 1);
    assert.equal(stats.supportedRows, 1);
    assert.equal(warningCount(warnings, "UNSUPPORTED_SCHEMA"), 1);
  } finally {
    workspace.cleanup();
  }
});

test("版本缺失/不可解析 → 放行 + 告警（现行 adapter 策略），三档各自可达且互不重叠", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [
        message({ id: "supported" }),
        message({ id: "no-session-row", session_id: "ses-ghost", seq: 2 }),
        message({ id: "unparsable", session_id: "ses-weird", seq: 3 }),
        message({ id: "v0", session_id: "ses-zero", seq: 4 }),
      ],
      sessions: [
        { id: "ses-1", version: "2.0.20" },
        { id: "ses-weird", version: "not-a-version" },
        { id: "ses-zero", version: "0.9" },
      ],
    });
    const { samples, warnings, stats } = await collect(workspace.dbFile, workspace.source);

    // v0 属 legacy 档（major 0 < 2）→ 排除；其余三行放行。
    assert.deepEqual([...byMessageId(samples).keys()].sort(), ["no-session-row", "supported", "unparsable"]);
    assert.equal(stats.supportedRows, 1);
    assert.equal(stats.legacyRows, 1);
    assert.equal(stats.unknownVersionRows, 2);
    assert.equal(stats.rowsScanned, 4);
    assert.equal(stats.versionEvidenceAvailable, true);
    // UNSUPPORTED_SCHEMA 承载"legacy 排除 + 未知版本放行"两类（码域只有一个码）。
    assert.equal(warningCount(warnings, "UNSUPPORTED_SCHEMA"), 3);
  } finally {
    workspace.cleanup();
  }
});

test("session_v2 整表缺失 或 缺 version 列 → 非致命：全部按未知版本放行 + 告警", async () => {
  for (const variant of ["no-table", "no-version-column"]) {
    const workspace = makeWorkspace();
    try {
      createFixtureDb(workspace.dbFile, {
        messages: [message({ id: "m-1" })],
        sessionTable: variant !== "no-table",
        versionColumn: variant !== "no-version-column",
        sessions: [],
      });
      if (variant === "no-version-column") {
        const db = new DatabaseSync(workspace.dbFile);
        try {
          db.prepare("INSERT INTO session_v2 (id) VALUES (?)").run("ses-1");
        } finally {
          db.close();
        }
      }
      const { samples, warnings, stats } = await collect(workspace.dbFile, workspace.source);
      assert.equal(samples.length, 1, `${variant}: 版本证据缺失不得丢弃候选`);
      assert.equal(stats.unknownVersionRows, 1);
      assert.equal(stats.versionEvidenceAvailable, false);
      assert.equal(warningCount(warnings, "UNSUPPORTED_SCHEMA"), 1);
      // 语义不确定时**仍按已证终态**给状态（不因版本未知就把终态降级）。
      assert.equal(samples[0].status, "completed");
    } finally {
      workspace.cleanup();
    }
  }
});

// ---------------------------------------------------------------- 6. v3 原始 output 与非推理分子

test("v3 直接使用原始 output：reasoning 正值 / 真 0 / 字段缺失都不参与折叠", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [
        // v2 原始 tokens.output 已是非推理输出：保留 100。
        message({ id: "reasoning-positive", data: messageData({ output: 100, reasoning: 40 }) }),
        // reasoning 真 0 同样不改变分子。
        message({ id: "reasoning-zero", seq: 2, data: messageData({ output: 100, reasoning: 0 }) }),
        // reasoning 缺失不影响已经单列的非推理 output。
        message({ id: "reasoning-missing", seq: 3, data: messageData({ output: 100, drop: ["tokens.reasoning"] }) }),
        // 反向：output 缺失时不能用 reasoning 顶替。
        message({ id: "output-missing", seq: 4, data: messageData({ drop: ["tokens.output"], reasoning: 7 }) }),
        // reasoning JSON null 同样不影响原始 output。
        message({ id: "reasoning-null", seq: 5, data: messageData({ output: 100, reasoning: null }) }),
      ],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const { samples } = await collect(workspace.dbFile, workspace.source);
    const rows = byMessageId(samples);

    assert.equal(rows.get("reasoning-positive").outputTokens, 100);
    assert.equal(rows.get("reasoning-positive").reportedReasoningTokens, 40);
    assert.equal(rows.get("reasoning-zero").outputTokens, 100);
    assert.equal(rows.get("reasoning-missing").outputTokens, 100);
    assert.equal(rows.get("reasoning-missing").reportedReasoningTokens, null);
    assert.equal(rows.get("output-missing").outputTokens, null);
    assert.equal(rows.get("reasoning-null").outputTokens, 100);

    // 生成时长缺失仍是共同扣除位；只有 output 本身缺失才增加 MISSING_OUTPUT。
    assert.deepEqual(flagNamesOf(rows.get("reasoning-zero")), ["MISSING_DURATION"]);
    assert.deepEqual(flagNamesOf(rows.get("reasoning-missing")), ["MISSING_DURATION"]);
    assert.deepEqual(flagNamesOf(rows.get("output-missing")), ["MISSING_DURATION", "MISSING_OUTPUT"]);
  } finally {
    workspace.cleanup();
  }
});

test("`$.tokens` 整体缺失（本机 3 条 error 行的真实形态）→ outputTokens null，与真 0 区分", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [
        message({
          id: "no-tokens",
          data: messageData({ includeTokens: false, finish: "error", error: { name: "fixture" } }),
        }),
        message({ id: "zero-tokens", seq: 2, data: messageData({ output: 0, reasoning: 0 }) }),
      ],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const { samples } = await collect(workspace.dbFile, workspace.source);
    const rows = byMessageId(samples);

    assert.equal(rows.get("no-tokens").outputTokens, null);
    assert.notEqual(rows.get("no-tokens").outputTokens, 0);
    assert.deepEqual(flagNamesOf(rows.get("no-tokens")), ["MISSING_DURATION", "MISSING_OUTPUT", "SOURCE_FILTERED"]);
    assert.equal(rows.get("zero-tokens").outputTokens, 0);
    assert.deepEqual(flagNamesOf(rows.get("zero-tokens")), ["OUTPUT_ZERO", "MISSING_DURATION"]);
  } finally {
    workspace.cleanup();
  }
});

test("反洗白：boolean/null/object 形式的 token 值不得被 json_extract 洗成 1/0（实测 true→1）", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [
        message({ id: "bool-output", data: messageData({ output: true, reasoning: 0 }) }),
        message({ id: "bool-reasoning", seq: 2, data: messageData({ output: 100, reasoning: true }) }),
        message({ id: "text-output", seq: 3, data: messageData({ output: "7", reasoning: 0 }) }),
        message({ id: "object-output", seq: 4, data: messageData({ output: { nested: 1 }, reasoning: 0 }) }),
        message({ id: "float-output", seq: 5, data: messageData({ output: 1.5, reasoning: 2 }) }),
        message({ id: "negative-output", seq: 6, data: messageData({ output: -5, reasoning: 3 }) }),
      ],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const { samples } = await collect(workspace.dbFile, workspace.source);
    const rows = byMessageId(samples);

    // 非标量一律被闸门变成"缺失"，绝不冒充 1/0。
    assert.equal(rows.get("bool-output").outputTokens, null);
    assert.notEqual(rows.get("bool-output").outputTokens, 1);
    assert.equal(rows.get("bool-reasoning").outputTokens, 100, "非推理 output 已单列，非法 reasoning 不污染分子");
    assert.equal(rows.get("text-output").outputTokens, null);
    assert.equal(rows.get("object-output").outputTokens, null);
    // 非法分量**原样**交给内核归类：既不参与相加（避免抵消/凑整），也不伪装成缺失。
    assert.equal(rows.get("float-output").outputTokens, 1.5, "小数分量原样保留，不得与 2 凑成 3.5");
    assert.equal(rows.get("negative-output").outputTokens, -5, "负分量原样保留，不得与 3 抵消成 -2");
    assert.deepEqual(flagNamesOf(rows.get("float-output")), ["MISSING_DURATION", "TOKEN_INVALID"]);
    assert.deepEqual(flagNamesOf(rows.get("negative-output")), ["MISSING_DURATION", "TOKEN_INVALID"]);
  } finally {
    workspace.cleanup();
  }
});

test("裁定 AL-4：输入侧未验证路径不投影 —— inputTokens 恒 null，且源里的 input/cache 值绝不进入候选", async () => {
  const workspace = makeWorkspace();
  try {
    // 判别式设计：把输入侧三路径塞成**哨兵数值**。若实现偷偷读它们，哨兵会出现在候选或 stats 里。
    const INPUT_SENTINEL = 987_654_321;
    const CACHE_SENTINEL = 123_456_789;
    createFixtureDb(workspace.dbFile, {
      messages: [
        // 输出侧必须照旧可用（证明删除只影响输入侧）。
        message({
          id: "full",
          data: messageData({
            output: 100,
            reasoning: 40,
            input: INPUT_SENTINEL,
            cacheRead: CACHE_SENTINEL,
            cacheWrite: 3,
          }),
        }),
        // 输入侧缺失的行：inputTokens 也必须同为 null（两侧都测 ⇒ "恒 null" 不是"恰好缺失"）。
        message({ id: "no-input", seq: 2, data: messageData({ output: 100, reasoning: 40, drop: ["tokens.input"] }) }),
        // 输入侧只有一个字段（历史行形态）：仍为 null。
        message({
          id: "partial-input",
          seq: 3,
          data: messageData({ output: 100, reasoning: 40, cacheRead: CACHE_SENTINEL, drop: ["tokens.input"] }),
        }),
      ],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const { samples, stats } = await collect(workspace.dbFile, workspace.source);
    const rows = byMessageId(samples);

    assert.equal(rows.size, 3);
    for (const [id, sample] of rows) {
      assert.equal(sample.inputTokens, null, `${id}: inputTokens 必须恒为 null（裁定 AL-4）`);
    }
    // 输出侧使用原始非推理 output 100；唯一扣除位来自尚缺的生成时长。
    for (const [id, sample] of rows) {
      assert.equal(sample.outputTokens, 100, `${id}: 原始 output 口径不受输入侧删除影响`);
      assert.deepEqual(flagNamesOf(sample), ["MISSING_DURATION"], `${id}: 输入侧不投影不得增加扣除位`);
    }
    // 哨兵绝不出现在候选/警告/stats 的序列化结果里（= 真的没有读那些路径）。
    const serialized = JSON.stringify({ samples, warnings: stats.warnings, stats });
    assert.ok(!serialized.includes(String(INPUT_SENTINEL)), "input 哨兵出现在产出里 = 偷读了未验证路径");
    assert.ok(!serialized.includes(String(CACHE_SENTINEL)), "cache 哨兵出现在产出里 = 偷读了未验证路径");
    assert.ok(!serialized.includes("cache"), "产出里不得出现 cache 字样");
    // 两个"待裁定"计数器在健康夹具上必须为 0（非 0 的判别式由上文两条用例锁定）。
    assert.equal(stats.completedMissingRows, 0);
    assert.equal(stats.unrecognizedTerminalRows, 0);
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------- 7. 请求诊断时窗与生成时长缺失

test("streamed − created 只进入 reportedDurationMs；生成 durationMs 恒缺失", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [
        // 请求诊断值：BASE_TS+1000 − BASE_TS = 1000。completed 故意晚 1 小时。
        message({ id: "normal" }),
        message({ id: "no-streamed", seq: 2, data: messageData({ drop: ["time.streamed"] }) }),
        message({ id: "no-created", seq: 3, data: messageData({ drop: ["time.created"] }) }),
        message({ id: "streamed-null", seq: 4, data: messageData({ streamed: null }) }),
        message({ id: "no-completed", seq: 5, data: messageData({ drop: ["time.completed"] }) }),
      ],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const { samples, stats } = await collect(workspace.dbFile, workspace.source);
    const rows = byMessageId(samples);

    assert.equal(rows.get("normal").durationMs, null);
    assert.equal(rows.get("normal").reportedDurationMs, 1000);
    assert.equal(rows.get("normal").windowEndMs, null, "请求诊断终点不得进入生成窗口");
    assert.equal(rows.get("normal").tsMs, BASE_TS + 3_600_000, "日历归属仍取 completed");
    assert.notEqual(rows.get("normal").reportedDurationMs, 3_600_000, "completed 在工具结束后，不能当诊断时长终点");
    assert.equal(rows.get("no-streamed").durationMs, null);
    assert.notEqual(rows.get("no-streamed").durationMs, 0, "缺失不得变成 0");
    assert.equal(rows.get("no-streamed").reportedDurationMs, null);
    assert.equal(rows.get("no-created").durationMs, null);
    assert.equal(rows.get("no-created").reportedDurationMs, null);
    assert.equal(rows.get("streamed-null").durationMs, null, "JSON null 与键缺失等价");
    assert.equal(rows.get("streamed-null").reportedDurationMs, null, "JSON null 与键缺失等价");
    assert.equal(rows.get("no-completed").reportedDurationMs, 1000, "completed 缺失不影响请求诊断时长");

    // 缺 streamed 不影响日历归属：completed 仍优先于 created。
    assert.equal(rows.get("no-streamed").tsMs, BASE_TS + 3_600_000);
    assert.equal(rows.get("no-streamed").windowStartMs, null);
    assert.equal(rows.get("no-streamed").windowEndMs, null);
    assert.deepEqual(flagNamesOf(rows.get("no-streamed")), ["MISSING_DURATION"]);
    assert.deepEqual(flagNamesOf(rows.get("normal")), ["MISSING_DURATION"]);
    assert.equal(stats.completedMissingRows, 1, "step-ended 诊断仍独立计数");
    assert.equal(rows.get("no-streamed").terminalVerified, true, "finish 仍在 ⇒ 不因缺 streamed 降级终态");
    assert.deepEqual(flagNamesOf(rows.get("no-completed")), ["MISSING_DURATION"]);
  } finally {
    workspace.cleanup();
  }
});

test("请求时窗负值/真 0 只保留在诊断字段，不进入生成 TPS 时长", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [
        // 手算：BASE_TS − (BASE_TS+500) = −500。
        message({ id: "inverted", data: messageData({ created: BASE_TS, streamed: BASE_TS - 500 }) }),
        // 手算：真 0 跨度（同一时刻结束）。
        message({ id: "zero-span", seq: 2, data: messageData({ created: BASE_TS, streamed: BASE_TS }) }),
        // 秒级时间戳（1.79e9 < 1e12 阈值）→ 单位不可支持，绝不乘 1000。
        message({
          id: "seconds",
          seq: 3,
          data: messageData({ created: 1_790_000_000, streamed: 1_790_000_001, completed: null }),
        }),
      ],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const { samples } = await collect(workspace.dbFile, workspace.source);
    const rows = byMessageId(samples);

    assert.equal(rows.get("inverted").durationMs, null);
    assert.equal(rows.get("inverted").reportedDurationMs, -500);
    assert.equal(rows.get("zero-span").durationMs, null);
    assert.equal(rows.get("zero-span").reportedDurationMs, 0);
    assert.ok(!flagNamesOf(rows.get("inverted")).includes("DURATION_NONPOSITIVE"));
    assert.ok(!flagNamesOf(rows.get("inverted")).includes("TIME_INVALID"));
    assert.ok(!flagNamesOf(rows.get("zero-span")).includes("DURATION_NONPOSITIVE"));
    assert.equal(rows.get("seconds").durationMs, null);
    assert.equal(rows.get("seconds").reportedDurationMs, 1);
    assert.ok(flagNamesOf(rows.get("seconds")).includes("TIME_INVALID"), "秒级时间戳必须判单位不支持");
    assert.ok(rows.get("seconds").tsMs < 1e12, "绝不把秒级时间戳乘 1000 冒充毫秒");
  } finally {
    workspace.cleanup();
  }
});

test("超长请求诊断时窗不产生生成 LONG_WINDOW，候选仍保留", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [
        // 手算：300000ms 恰好等于阈值（`>` 才置位 → 恰好等于不置位）。
        message({ id: "exactly-threshold", data: messageData({ created: BASE_TS, streamed: BASE_TS + 300_000 }) }),
        message({
          id: "over-threshold",
          seq: 2,
          data: messageData({ created: BASE_TS, streamed: BASE_TS + 300_001 }),
        }),
      ],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const { samples, stats } = await collect(workspace.dbFile, workspace.source);
    const rows = byMessageId(samples);
    assert.equal(stats.samples, 2, "长窗口绝不是剔除理由");
    assert.equal(rows.get("exactly-threshold").durationMs, null);
    assert.equal(rows.get("exactly-threshold").reportedDurationMs, 300_000);
    assert.equal(rows.get("over-threshold").durationMs, null);
    assert.equal(rows.get("over-threshold").reportedDurationMs, 300_001);
    assert.ok(!flagNamesOf(rows.get("exactly-threshold")).includes("LONG_WINDOW"));
    assert.ok(!flagNamesOf(rows.get("over-threshold")).includes("LONG_WINDOW"));
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------- 8. 终态（每个分支都要有触发用例）

test("终态字面量：stop/tool-calls → completed；error → failed + SOURCE_FILTERED（两侧都测）", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [
        message({ id: "stop" }),
        message({ id: "tool-calls", seq: 2, data: messageData({ finish: "tool-calls" }) }),
        message({ id: "error", seq: 3, data: messageData({ finish: "error", error: { name: "fixture" } }) }),
      ],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const { samples, warnings } = await collect(workspace.dbFile, workspace.source);
    const rows = byMessageId(samples);

    for (const id of ["stop", "tool-calls"]) {
      assert.equal(rows.get(id).status, "completed", id);
      assert.equal(rows.get(id).terminalVerified, true);
      assert.equal(rows.get(id).sourceFiltered, false);
      assert.equal(rows.get(id).filterReason, "");
      assert.ok(!flagNamesOf(rows.get(id)).includes("TERMINAL_UNVERIFIED"));
    }
    assert.equal(rows.get("error").status, "failed");
    assert.equal(rows.get("error").sourceFiltered, true);
    assert.equal(rows.get("error").filterReason, "source_failed");
    assert.deepEqual(flagNamesOf(rows.get("error")).sort(), ["MISSING_DURATION", "SOURCE_FILTERED"]);
    // 三个已识别字面量都不得触发 schema 漂移告警。
    assert.equal(warningCount(warnings, "UNSUPPORTED_SCHEMA"), 0);
  } finally {
    workspace.cleanup();
  }
});

test("finish 缺失但存在 error 对象 → failed（第二个失败判据单独可达）", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [
        message({ id: "error-object-only", data: messageData({ finish: null, error: { name: "fixture" } }) }),
        message({ id: "error-json-null", seq: 2, data: messageData({ finish: null, error: null }) }),
      ],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const { samples } = await collect(workspace.dbFile, workspace.source);
    const rows = byMessageId(samples);
    assert.equal(rows.get("error-object-only").status, "failed");
    assert.equal(rows.get("error-object-only").sourceFiltered, true);
    // `$.error` 为 JSON null 时**不算**错误证据：无终态证据 → unverified。
    assert.equal(rows.get("error-json-null").status, "unverified");
    assert.equal(rows.get("error-json-null").terminalVerified, false);
    assert.ok(flagNamesOf(rows.get("error-json-null")).includes("TERMINAL_UNVERIFIED"));
  } finally {
    workspace.cleanup();
  }
});

test("无终态证据（finish 缺失）→ unverified + TERMINAL_UNVERIFIED，且**不**报 schema 漂移", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [
        message({ id: "no-finish", data: messageData({ finish: null }) }),
        message({ id: "empty-finish", seq: 2, data: messageData({ finish: "   " }) }),
      ],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const { samples, warnings, stats } = await collect(workspace.dbFile, workspace.source);
    assert.deepEqual([...byMessageId(samples).keys()].sort(), ["empty-finish", "no-finish"]);
    for (const sample of samples) {
      assert.equal(sample.status, "unverified");
      assert.equal(sample.terminalVerified, false);
      assert.equal(sample.inProgress, false, "没有明确进行中的证据，绝不进 pending");
      assert.ok(flagNamesOf(sample).includes("TERMINAL_UNVERIFIED"));
    }
    assert.equal(warningCount(warnings, "UNSUPPORTED_SCHEMA"), 0, "缺 finish 是数据事实，不是 schema 漂移");
    assert.equal(stats.unrecognizedTerminalRows, 0, "缺失 ≠ 未识别：两者必须分开计数（规则两侧都测）");
  } finally {
    workspace.cleanup();
  }
});

test("未识别 finish 字面量 → 绝不伪造终态：标 unverified 并报 schema 漂移（含 cancelled 反例）", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [
        message({ id: "cancelled-ish", data: messageData({ finish: "cancelled" }) }),
        message({ id: "aborted-ish", seq: 2, data: messageData({ finish: "aborted" }) }),
        message({ id: "unknown-ish", seq: 3, data: messageData({ finish: "some-new-code" }) }),
      ],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const { samples, warnings, stats } = await collect(workspace.dbFile, workspace.source);
    for (const sample of samples) {
      assert.equal(sample.status, "unverified", "本来源没有取消证据 → 不得把 cancelled 当结论");
      assert.notEqual(sample.status, "cancelled");
      assert.equal(sample.cancelledByUser, false);
      assert.equal(sample.sourceFiltered, false);
      assert.ok(flagNamesOf(sample).includes("TERMINAL_UNVERIFIED"));
    }
    assert.equal(stats.unrecognizedTerminalRows, 3, "未识别字面量行数必须独立可见（告警聚合后仍可裁定）");
    assert.equal(stats.completedMissingRows, 0, "这些行的 completed 都是正常的：漂移在终态字面量，不在时间面");
    assert.equal(warningCount(warnings, "UNSUPPORTED_SCHEMA"), 3, "字面量漂移必须告警（语义不确定不得给精确排名）");
  } finally {
    workspace.cleanup();
  }
});

test("classifyOpencodeTerminal 覆盖每个分支（判别式可达性自证，含两侧对照）", () => {
  for (const finish of OPENCODE_FINISH_COMPLETED) {
    const result = classifyOpencodeTerminal(finish, null);
    assert.deepEqual(result, {
      status: "completed",
      terminalVerified: true,
      sourceFiltered: false,
      filterReason: "",
      recognized: true,
    });
  }
  for (const finish of OPENCODE_FINISH_FAILED) {
    assert.equal(classifyOpencodeTerminal(finish, "object").status, "failed");
  }
  assert.equal(classifyOpencodeTerminal("stop", "object").status, "failed", "error 对象是独立的失败证据");
  assert.equal(classifyOpencodeTerminal("", null).status, "unverified");
  assert.equal(classifyOpencodeTerminal("", null).recognized, true, "缺失不是漂移");
  assert.equal(classifyOpencodeTerminal("  ", "null").recognized, true);
  assert.equal(classifyOpencodeTerminal("cancelled", null).status, "unverified");
  assert.equal(classifyOpencodeTerminal("cancelled", null).recognized, false);
  assert.equal(classifyOpencodeTerminal("ERROR", null).recognized, false, "大小写敏感：不做模糊匹配");
  assert.equal(classifyOpencodeTerminal(null, null).status, "unverified");
});

// ---------------------------------------------------------------- 9. 身份（数据库身份参与元组）

test("身份 = (homeId, 规范数据库身份, message.id)：两个库同 message.id 是两条独立身份", async () => {
  const workspace = makeWorkspace();
  try {
    const sessions = [{ id: "ses-1", version: "2.0.20" }];
    createFixtureDb(workspace.dbFile, { messages: [message({ id: "same-id" })], sessions });
    createFixtureDb(workspace.otherDbFile, { messages: [message({ id: "same-id" })], sessions });

    const first = await collect(workspace.dbFile, workspace.source);
    const second = await collect(workspace.otherDbFile, workspace.source);

    assert.equal(first.samples.length, 1);
    assert.equal(second.samples.length, 1);
    assert.equal(first.samples[0].messageId, second.samples[0].messageId);
    assert.notEqual(first.samples[0].sampleKey, second.samples[0].sampleKey, "database_identity 必须参与身份");
    // 手算：身份元组 = ["opencode", "home-1", <规范化库路径>, "same-id"]。
    assert.deepEqual(first.samples[0].identity, [canonicalOpencodeDatabaseIdentity(workspace.dbFile), "same-id"]);
    assert.equal(
      first.samples[0].sampleKey,
      perfSampleKey("opencode", "home-1", canonicalOpencodeDatabaseIdentity(workspace.dbFile), "same-id"),
    );
  } finally {
    workspace.cleanup();
  }
});

test("seq 只用于排序，绝不进入身份：同 seq 不同 message.id → 两个身份；同库重复读取 → 同一身份", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [
        message({ id: "id-a", seq: 7 }),
        // 同一个 session 里 seq 可复用（真实库有 UNIQUE(session_id,seq)，但本投影不得把 seq 当身份）。
        message({ id: "id-b", seq: 7 }),
      ],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const first = await collect(workspace.dbFile, workspace.source);
    const second = await collect(workspace.dbFile, workspace.source);

    const keys = first.samples.map((sample) => sample.sampleKey);
    assert.equal(new Set(keys).size, 2, "seq 相同不是同一身份");
    for (const key of keys) assert.ok(!key.includes('"7"') && !key.includes(",7]"), `seq 不得进入身份键：${key}`);
    assert.deepEqual(
      first.samples.map((sample) => sample.sampleKey),
      second.samples.map((sample) => sample.sampleKey),
      "同一物理库重复读取必须给出同一身份",
    );
    // 稳定迭代：seq 相同时按 id 的代码单元序。
    assert.deepEqual(
      first.samples.map((sample) => sample.messageId),
      ["id-a", "id-b"],
    );
  } finally {
    workspace.cleanup();
  }
});

test("无法成形身份的行不写候选表：只累计 UNKEYABLE_RECORD（含两侧对照）", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [message({ id: "keyed-1" }), message({ id: "", seq: 2 }), message({ id: "   ", seq: 3 })],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const { samples, warnings, stats } = await collect(workspace.dbFile, workspace.source);
    assert.deepEqual(
      samples.map((sample) => sample.messageId),
      ["keyed-1"],
    );
    assert.equal(stats.rowsScanned, 3, "无身份的行仍被读到（只是不写候选表）");
    assert.equal(stats.unkeyable, 2);
    assert.equal(warningCount(warnings, "UNKEYABLE_RECORD"), 2);
    assert.equal(stats.samples, 1);
  } finally {
    workspace.cleanup();
  }
});

test("source 缺 id → 全部行无身份：只告警不抛错，且不算 schema 漂移", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, { messages: [message()], sessions: [{ id: "ses-1", version: "2.0.20" }] });
    const { samples, warnings, stats } = await collect(workspace.dbFile, { path: workspace.homeDir });
    assert.equal(samples.length, 0);
    assert.equal(stats.unkeyable, 1);
    assert.equal(warningCount(warnings, "UNKEYABLE_RECORD"), 1);
    assert.equal(warningCount(warnings, "UNSUPPORTED_SCHEMA"), 0);
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------- 10. 缺生成窗口时不伪算 TPS

test("大 output 与短请求诊断时窗不组成伪 TPS：候选保留且 durationMs 缺失", async () => {
  const workspace = makeWorkspace();
  try {
    // 原始非推理 output 200000；请求诊断跨度 100ms，但没有首/末有效输出边界。
    createFixtureDb(workspace.dbFile, {
      messages: [
        message({
          id: "absurd-speed",
          data: messageData({ created: BASE_TS, streamed: BASE_TS + 100, output: 200_000, reasoning: 0 }),
        }),
      ],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const { samples, stats } = await collect(workspace.dbFile, workspace.source);
    assert.equal(stats.samples, 1, "缺生成边界不是剔除理由");
    const sample = samples[0];
    assert.equal(sample.outputTokens, 200_000);
    assert.equal(sample.durationMs, null);
    assert.equal(sample.reportedDurationMs, 100);
    assert.deepEqual(flagNamesOf(sample), ["MISSING_DURATION"]);
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------- 11. provider / variant / effort 不回填

test("provider/model 取自消息证据；variant/effort 绝不从当前配置回填（含反例）", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [
        // variant=xhigh 极像 effort 标签：仍必须为空串（无消息级 effort 证据，§6.1-B4）。
        message({
          id: "with-variant",
          data: messageData({ variant: "xhigh", modelId: "model-x", providerId: "provider-y" }),
        }),
        // 模型/provider 缺失 → 空串（裁定 P：名字类缺失只有一种字面量）。
        message({ id: "no-model", seq: 2, data: messageData({ drop: ["model"] }) }),
      ],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const { samples } = await collect(workspace.dbFile, workspace.source);
    const rows = byMessageId(samples);

    assert.equal(rows.get("with-variant").model, "model-x");
    assert.equal(rows.get("with-variant").modelProvider, "provider-y");
    assert.equal(rows.get("with-variant").reasoningEffort, "");
    assert.equal(rows.get("with-variant").modelEvidence, "");
    assert.ok(!("variant" in rows.get("with-variant")), "不得凭空产出 variant 字段");
    assert.ok(!JSON.stringify(rows.get("with-variant")).includes("xhigh"), "variant 不得泄漏进候选");

    assert.equal(rows.get("no-model").model, "");
    assert.equal(rows.get("no-model").modelProvider, "");
    assert.equal(rows.get("no-model").modelEvidence, "");
  } finally {
    workspace.cleanup();
  }
});

test("agent：只证明名称，agentKind 恒为 unknown；缺名称用空串（裁定 P）", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [
        message({ id: "named", data: messageData({ agent: "build" }) }),
        message({ id: "missing-agent", seq: 2, data: messageData({ drop: ["agent"] }) }),
        message({ id: "main-ish", seq: 3, data: messageData({ agent: "main" }) }),
      ],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const { samples } = await collect(workspace.dbFile, workspace.source);
    const rows = byMessageId(samples);
    assert.equal(rows.get("named").agent, "build");
    assert.equal(rows.get("missing-agent").agent, "");
    assert.equal(rows.get("main-ish").agent, "main");
    for (const sample of samples) {
      assert.equal(sample.agentKind, "unknown", "四源 mainProven 全 false：名字像 main 不是证据");
    }
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------- 12. 与 M1 内核的接口自洽

test("raw 候选与 v3 内核输入契约自洽：零警告，语义三件套与来源表一致", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [message({ id: "m-1", data: messageData({ output: 100, reasoning: 40 }) })],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const { samples } = await collect(workspace.dbFile, workspace.source);
    const raw = samples[0];

    const { sample, warnings } = normalizePerfSample(raw);
    assert.deepEqual(warnings, [], "reader 的字段名/枚举必须完全被内核接受");
    assert.equal(sample.sampleKey, perfSampleKey("opencode", "home-1", raw.databaseIdentity, "m-1"));
    assert.equal(sample.sourceKind, "opencode");
    assert.equal(sample.homeId, "home-1");
    assert.equal(sample.window, "request");
    assert.equal(sample.timingKind, "generation");
    assert.equal(sample.tokenScope, "non_reasoning_output");
    assert.equal(sample.outputTokens, 100);
    assert.equal(sample.durationMs, null);
    assert.equal(sample.status, "completed");
    assert.equal(sample.timingSource, "unknown");
    assert.equal(sample.methodVersion, PERF_METHOD_VERSION);
    assert.deepEqual(flagNamesOf(sample), ["MISSING_DURATION"]);
  } finally {
    workspace.cleanup();
  }
});

test("sourcePath 是索引归属文件；channel 默认小写 kebab-case（裁定 AL-5），且仍可被 source.channel 覆盖", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, { messages: [message()], sessions: [{ id: "ses-1", version: "2.0.20" }] });
    const defaulted = await collect(workspace.dbFile, workspace.source);
    assert.equal(defaulted.samples[0].sourcePath, workspace.dbFile);
    // 冻结字面量：`channel` 是 `perfGroupKey` 第 3 分量（`src/perf-stats.js:364-382`），必须与 sourceKind 同风格。
    assert.equal(defaulted.samples[0].channel, "opencode");
    assert.equal(defaulted.samples[0].channel, OPENCODE_CHANNEL);
    assert.match(
      defaulted.samples[0].channel,
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
      "channel 必须是小写 kebab-case（大小写不同会把同一来源拆成两组）",
    );
    assert.notEqual(defaulted.samples[0].channel, "OpenCode", "不得沿用产品/看板展示层口径");
    assert.equal(defaulted.stats.sourcePath, workspace.dbFile);
    assert.equal(defaulted.stats.databaseIdentity, canonicalOpencodeDatabaseIdentity(workspace.dbFile));

    // 覆盖能力保留：集成层可传子代理形态（同一约定的小写 kebab）。
    const overridden = await collect(workspace.dbFile, { id: "home-1", channel: "opencode-subagent" });
    assert.equal(overridden.samples[0].channel, "opencode-subagent");
    // 覆盖值确实参与分组：两个 channel 的分组键不同（证明它不是一个"被忽略的展示字段"）。
    assert.notEqual(
      perfGroupKey(normalizePerfSample(defaulted.samples[0]).sample),
      perfGroupKey(normalizePerfSample(overridden.samples[0]).sample),
    );
  } finally {
    workspace.cleanup();
  }
});

test("警告形状冻结为 {sourceKind,homeId,code,count} 四键，且 onWarning 与 stats.warnings 同源同序", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [
        message({ id: "bad", data: "{" }),
        message({ id: "", seq: 2 }),
        message({ id: "legacy", seq: 3, session_id: "ses-old" }),
      ],
      sessions: [{ id: "ses-old", version: "1.0.0" }],
    });
    const { warnings, stats } = await collect(workspace.dbFile, workspace.source);

    // 三个码同时可达：MALFORMED_JSON / UNKEYABLE_RECORD / UNSUPPORTED_SCHEMA。
    assert.deepEqual(
      warnings.map((warning) => warning.code),
      ["MALFORMED_JSON", "UNKEYABLE_RECORD", "UNSUPPORTED_SCHEMA"],
      "警告必须按码的代码单元序确定性输出",
    );
    assert.deepEqual(warnings, stats.warnings);
    for (const warning of warnings) {
      assert.deepEqual(Object.keys(warning).sort(), ["code", "count", "homeId", "sourceKind"]);
      assert.equal(warning.sourceKind, "opencode");
      assert.equal(warning.homeId, "home-1");
      assert.ok(Number.isSafeInteger(warning.count) && warning.count > 0);
    }
  } finally {
    workspace.cleanup();
  }
});

test("正文哨兵：content 正文绝不进入候选、警告或 stats（也不影响读取）", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [message({ id: "m-1" }), message({ id: "m-2", seq: 2, data: messageData({ output: 5 }) })],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const { samples, warnings, stats } = await collect(workspace.dbFile, workspace.source);
    assert.equal(samples.length, 2);
    const serialized = JSON.stringify({ samples, warnings, stats });
    assert.ok(!serialized.includes(BODY_SENTINEL), "正文哨兵出现在产出里 = 读到了正文");
    assert.ok(!serialized.includes("content"), "候选里不得出现 content 字段");
  } finally {
    workspace.cleanup();
  }
});

test("空表 / 无 assistant 行：0 候选 0 告警（判别式可达：确有合法的空库）", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, { messages: [], sessions: [{ id: "ses-1", version: "2.0.20" }] });
    const { samples, warnings, stats } = await collect(workspace.dbFile, workspace.source);
    assert.equal(stats.rowsScanned, 0);
    assert.equal(stats.samples, 0);
    assert.equal(stats.malformedJsonRows, 0);
    assert.equal(stats.unkeyable, 0);
    assert.deepEqual(samples, []);
    assert.deepEqual(warnings, []);
  } finally {
    workspace.cleanup();
  }
});

test("onSample 允许返回 Promise（reader 会 await）：异步集成不会乱序", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [message({ id: "m-1" }), message({ id: "m-2", seq: 2 }), message({ id: "m-3", seq: 3 })],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const order = [];
    await streamOpencodePerfSamples(workspace.dbFile, workspace.source, async (sample) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      order.push(sample.messageId);
    });
    assert.deepEqual(order, ["m-1", "m-2", "m-3"]);
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------- 13. 纯函数判别式（每个 null/0 分支的可达性）

test("resolveOpencodeDuration / resolveOpencodeTsMs 的每个分支都可达", () => {
  assert.equal(resolveOpencodeDuration(BASE_TS, BASE_TS + 1000), 1000);
  assert.equal(resolveOpencodeDuration(null, BASE_TS + 1000), null);
  assert.equal(resolveOpencodeDuration(BASE_TS, null), null);
  assert.equal(resolveOpencodeDuration(BASE_TS, undefined), null);
  assert.equal(resolveOpencodeDuration("x", BASE_TS), null);
  assert.equal(resolveOpencodeDuration(Number.NaN, BASE_TS), null);
  assert.equal(resolveOpencodeDuration(Number.POSITIVE_INFINITY, BASE_TS), null);
  // 反例：真 0 跨度保留 0，不因"假值"被判缺失。
  assert.equal(resolveOpencodeDuration(BASE_TS, BASE_TS), 0);

  assert.equal(resolveOpencodeTsMs(BASE_TS, BASE_TS + 1000), BASE_TS + 1000, "优先 completed");
  assert.equal(resolveOpencodeTsMs(BASE_TS, null), BASE_TS, "completed 缺失才用 created");
  assert.equal(resolveOpencodeTsMs(BASE_TS, 0), BASE_TS, "0 不是可用定位值");
  assert.equal(resolveOpencodeTsMs(null, null), null);
  assert.equal(resolveOpencodeTsMs("x", "y"), null);
});

test("combineOpencodeOutputTokens 的每个分支都可达（缺项绝不当 0）", () => {
  assert.equal(combineOpencodeOutputTokens(10, 5), 15);
  assert.equal(combineOpencodeOutputTokens(10, 0), 10, "真 0 参与相加");
  assert.equal(combineOpencodeOutputTokens(0, 0), 0, "两个真 0 合计仍是真 0");
  assert.equal(combineOpencodeOutputTokens(10, null), null);
  assert.equal(combineOpencodeOutputTokens(null, 5), null);
  assert.equal(combineOpencodeOutputTokens(true, 5), null, "布尔不得洗成 1");
  // P1-1：**先校验、后相加** —— 非法分量原样返回，绝不借相加洗白。
  assert.equal(combineOpencodeOutputTokens(1.5, 2), 1.5, "小数不得与 2 凑成 3.5");
  assert.equal(combineOpencodeOutputTokens(2, 1.5), 1.5, "反序同样返回非法的那一个");
  assert.equal(combineOpencodeOutputTokens(10, -1), -1, "10 + (−1) 不得洗成 9");
  assert.equal(combineOpencodeOutputTokens(-5, 5), -5, "(−5) + 5 绝不洗成『真 0』");
  assert.equal(combineOpencodeOutputTokens(5, -5), -5, "反序同样不得抵消成 0");
  assert.equal(combineOpencodeOutputTokens(-1, -2), -1, "两个都非法时返回第一个");
});

test("sessionVersionMajor：只解析主版本，无法解析一律 null（不做数字/字典序比较）", () => {
  assert.equal(sessionVersionMajor("2.0.20"), 2);
  assert.equal(sessionVersionMajor("10.1"), 10, "主版本按数值解析，不是字典序（'10' < '2' 会错）");
  assert.equal(sessionVersionMajor("1.4.2"), 1);
  assert.equal(sessionVersionMajor(2), 2);
  assert.equal(sessionVersionMajor("0"), 0);
  assert.equal(sessionVersionMajor(""), null);
  assert.equal(sessionVersionMajor(null), null);
  assert.equal(sessionVersionMajor(undefined), null);
  assert.equal(sessionVersionMajor("not-a-version"), null);
  assert.equal(sessionVersionMajor("-1"), null);
});

test("canonicalOpencodeDatabaseIdentity：解析为绝对路径并规范化（Windows 折叠大小写）", () => {
  const identity = canonicalOpencodeDatabaseIdentity("relative/opencode.db");
  assert.ok(path.isAbsolute(identity));
  assert.equal(canonicalOpencodeDatabaseIdentity(""), "");
  assert.equal(canonicalOpencodeDatabaseIdentity(null), "");
  if (process.platform === "win32") {
    assert.equal(
      canonicalOpencodeDatabaseIdentity("C:\\Temp\\MixedCase\\OpenCode.DB"),
      canonicalOpencodeDatabaseIdentity("c:\\temp\\mixedcase\\opencode.db"),
    );
  }
});

test("警告码域：只可能产出冻结 8 码里的三个（READ_ONLY_OPEN_FAILED 只作为抛出的 code）", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [message({ id: "bad", data: "{" }), message({ id: "", seq: 2 }), message({ id: "m-3", seq: 3 })],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const { warnings } = await collect(workspace.dbFile, workspace.source);
    const allowed = new Set(["UNKEYABLE_RECORD", "READ_ONLY_OPEN_FAILED", "UNSUPPORTED_SCHEMA", "MALFORMED_JSON"]);
    for (const warning of warnings) assert.ok(allowed.has(warning.code), `越界码：${warning.code}`);
  } finally {
    workspace.cleanup();
  }
});

test("确定性：同一夹具连续两次读取给出完全相同的候选序列与 stats 计数", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDb(workspace.dbFile, {
      messages: [message({ id: "m-b", seq: 2 }), message({ id: "m-a", seq: 2 }), message({ id: "m-c", seq: 1 })],
      sessions: [{ id: "ses-1", version: "2.0.20" }],
    });
    const first = await collect(workspace.dbFile, workspace.source);
    const second = await collect(workspace.dbFile, workspace.source);
    assert.deepEqual(JSON.parse(JSON.stringify(first.samples)), JSON.parse(JSON.stringify(second.samples)));
    assert.deepEqual(first.stats, second.stats);
    // 同一 time_created、同一 seq 时退化为 id 的代码单元序（"m-a" < "m-b"）。
    assert.deepEqual(
      first.samples.map((sample) => sample.messageId),
      ["m-c", "m-a", "m-b"],
    );
  } finally {
    workspace.cleanup();
  }
});

// ===========================================================================
// 兼容辅助函数：旧版 output + reasoning 合计的非法分量守卫
// ===========================================================================
//
// 回归的事故（用户独立夹具复现、Lead 核实、我复现）：
//   `combineOpencodeOutputTokens` 先 `output + reasoning` 再交给 M1 ⇒ **非法性在相加时被销毁**：
//     10 + (-1)  = 9  ⇒ M1 flags=[]（无标记，进 TPS）
//     1.5 + 0.5  = 2  ⇒ M1 flags=[]（小数凑成合法整数）
//     -5 + 5     = 0  ⇒ M1 flags=["OUTPUT_ZERO"] ← **非法输入冒用了"真 0"的诊断**
//     9e15 * 2        ⇒ 被 M1 拦（唯一被拦住的）
//
// 两条**硬要求**（本组用例的核心）：
//   ① 非法分量必须**保留候选**并产生 `TOKEN_INVALID` —— 不得靠相加抵消。
//   ② 非法**不得**伪装成字段缺失（`null`）：`null` 在本来源的既有语义是
//      "`$.tokens` 整体缺失"（`MISSING_OUTPUT`，合法诊断）。把非法分量也返回 `null`，
//      就把"缺失"与"非法"两种事实压成同一个值 —— 与 M1.3 的 `unplaced` 归因丢失同类。
//   ③ `reasoning` 真 0 必须仍被当作**已知的 0**，不得当缺失。

// P1-1 段复用文件顶部的既有 import（`combineOpencodeOutputTokens` / `normalizePerfSample` / `perfFlagNamesOf`）

/** 用真实 M1 归一化，回读输出侧的分类结果。 */
function classify(output, reasoning) {
  const combined = combineOpencodeOutputTokens(output, reasoning);
  const raw = {
    sourceKind: "opencode",
    homeId: "home-p11",
    sessionId: "session-p11",
    tsMs: 1_700_000_000_000,
    windowStartMs: 1_700_000_000_000,
    windowEndMs: 1_700_000_001_000,
    durationMs: 1000,
    outputTokens: combined,
    inputTokens: 10,
    status: "completed",
    agentKind: "main",
    identity: ["row-p11"],
  };
  const { sample } = normalizePerfSample(raw);
  return { combined, sample, flags: perfFlagNamesOf(sample.sampleFlags), reasons: sample.diagnosticReasonChain };
}

// ---------------------------------------------------------------------------
// ★ 非法分量必须被拒（三个事故形态）
// ---------------------------------------------------------------------------

test("★P1-1 负数分量不得被相加抵消：10 + (-1) 必须 TOKEN_INVALID，不得无标记进 TPS", () => {
  const c = classify(10, -1);
  // 修复前：combined=9、flags=[]（非法被销毁）
  assert.ok(
    c.flags.includes("TOKEN_INVALID"),
    `负数分量必须被判非法；实测 flags=${JSON.stringify(c.flags)} combined=${c.combined}`,
  );
  assert.ok(!c.flags.includes("MISSING_OUTPUT"), "非法分量不得被归类成『字段缺失』（两种事实必须可区分）");
  assert.equal(c.combined === 9, false, "不得把 10+(-1) 当成合法的 9");
});

test("★P1-1 小数分量不得凑成合法整数：1.5 + 0.5 必须 TOKEN_INVALID", () => {
  const c = classify(1.5, 0.5);
  assert.ok(
    c.flags.includes("TOKEN_INVALID"),
    `小数分量必须被判非法；实测 flags=${JSON.stringify(c.flags)} combined=${c.combined}`,
  );
  assert.equal(c.combined === 2, false, "不得把 1.5+0.5 当成合法的 2");
});

test("★P1-1 两个非法分量不得抵消成『真 0』：-5 + 5 不得冒用 OUTPUT_ZERO", () => {
  const c = classify(-5, 5);
  // 修复前：combined=0 ⇒ M1 给 OUTPUT_ZERO/["output_zero"] —— 冒用了合法数据的诊断。
  assert.ok(
    c.flags.includes("TOKEN_INVALID"),
    `两个非法分量必须被判非法；实测 flags=${JSON.stringify(c.flags)} combined=${c.combined}`,
  );
  assert.ok(
    !c.flags.includes("OUTPUT_ZERO"),
    "非法输入不得借道 OUTPUT_ZERO —— 该标记是**合法 0** 的诊断，被冒用即『0 的判别式失效』",
  );
  assert.ok(!c.reasons.includes("output_zero"), "diagnosticReasonChain 同样不得出现 output_zero");
});

test("★P1-1 反向对照：合法 0 + 0 仍必须 OUTPUT_ZERO（证明上面不是在禁掉 OUTPUT_ZERO 本身）", () => {
  const c = classify(0, 0);
  assert.deepEqual(c.combined, 0, "两个真 0 的合计就是真 0");
  assert.ok(c.flags.includes("OUTPUT_ZERO"), `合法 0 必须仍标 OUTPUT_ZERO；实测 ${JSON.stringify(c.flags)}`);
  assert.ok(!c.flags.includes("TOKEN_INVALID"), "合法 0 不得被判非法");
});

// ---------------------------------------------------------------------------
// ★ P1-1 核心：**返回值本身**必须是"相加前的判定"
// ---------------------------------------------------------------------------
//
// 上面那组用例断言的是"非法输入最终会被 M1 标记"—— 但那证明不了 reader 做了工作：
// **任何**非法值交给 M1 都会得到 `TOKEN_INVALID`。真正要钉的是**reader 在相加【之前】**就
// 拒绝，并把**违规分量原样**交出（而不是先加起来、再期望 M1 事后发现问题）。
// 若实现退回 `return output + reasoning`，上面那组**仍会绿**（M1 照样标记），
// 但下面这组会**立刻转红** —— 这才是 P1-1 的判别力所在。

test("★P1-1 返回值必须**等于违规分量本身**（钉住『相加前拒绝』，而非『相加后侥幸被 M1 拦下』）", () => {
  // 负数分量：返回**那个负数**，不是相加后的 9
  assert.equal(combineOpencodeOutputTokens(10, -1), -1, "必须返回违规的 reasoning(-1)，而不是相加得到的 9");
  assert.notEqual(combineOpencodeOutputTokens(10, -1), 9, "10+(-1) 绝不得被清洗成合法整数 9");
  // 小数分量：返回**那个小数**
  assert.equal(combineOpencodeOutputTokens(1.5, 0.5), 1.5, "必须返回违规的 output(1.5)，而不是相加得到的 2");
  assert.notEqual(combineOpencodeOutputTokens(1.5, 0.5), 2, "1.5+0.5 绝不得凑成合法整数 2");
  // 抵消形态：返回**先出现的违规分量**，不是抵消后的 0
  assert.equal(combineOpencodeOutputTokens(-5, 5), -5, "必须返回违规的 output(-5)，而不是抵消后的 0");
  assert.notEqual(combineOpencodeOutputTokens(-5, 5), 0, "(-5)+5 绝不得抵消成『真 0』");
  // 反序同样返回**第一个**违规分量（顺序敏感，不得任选）
  assert.equal(combineOpencodeOutputTokens(5, -5), -5, "反序时返回违规的 reasoning(-5)");
  assert.equal(combineOpencodeOutputTokens(-1, -2), -1, "两个都违规时返回**第一个**违规分量");
});

test("★P1-1 合计越界：两个**合法**分量之和越界时，返回值必须是越界合计（:282 曾为 no-op）", () => {
  // 两个分量各自都是合法非负安全整数，但**和**越界。这是 `:282` 那个分支唯一可达的输入形态。
  const sumUnsafe = combineOpencodeOutputTokens(9e15, 9e15);
  assert.equal(sumUnsafe, 1.8e16, "越界合计必须原样返回（M1 会据它给 output_not_safe_integer）");
  assert.equal(Number.isSafeInteger(sumUnsafe), false, "该合计确实不是安全整数（否则本用例测的不是这个分支）");

  const maxSafe = Number.MAX_SAFE_INTEGER;
  assert.equal(combineOpencodeOutputTokens(maxSafe, maxSafe), maxSafe * 2, "MAX_SAFE 之和越界，原样返回");
  assert.equal(combineOpencodeOutputTokens(maxSafe, 1), maxSafe + 1, "MAX_SAFE+1 越界，原样返回");

  // 判别力前置：这两个分量**各自**必须合法 —— 否则走的是上面那条"违规分量"分支，测不到 :282。
  assert.ok(Number.isSafeInteger(9e15) && 9e15 >= 0, "前置：9e15 本身必须是合法非负安全整数");
  assert.ok(
    Number.isSafeInteger(Number.MAX_SAFE_INTEGER) && Number.MAX_SAFE_INTEGER >= 0,
    "前置：MAX_SAFE_INTEGER 本身合法",
  );
  assert.equal(Number.isSafeInteger(9e15 + 9e15), false, "前置：9e15+9e15 确实越界（本用例验证的是合计检查）");
  assert.equal(Number.isSafeInteger(Number.MAX_SAFE_INTEGER + 1), false, "前置：MAX_SAFE+1 确实越界");
  // 反向判别力：若把分量校验误放宽（例如漏掉 safe 判定），下面这条会先转红。
  assert.equal(combineOpencodeOutputTokens(9e15, 1), 9e15 + 1, "9e15+1 仍是安全整数 ⇒ 必须正常相加，不得被误判越界");
  // 并且 M1 必须把越界合计归成 TOKEN_INVALID（证明原样返回是**有诊断出口**的，不是丢弃）
  const over = classify(9e15, 9e15);
  assert.equal(over.combined, 1.8e16);
  assert.ok(over.flags.includes("TOKEN_INVALID"), `越界合计必须被 M1 判非法；实测 ${JSON.stringify(over.flags)}`);
  assert.ok(
    over.reasons.includes("output_not_safe_integer"),
    `诊断原因应为 output_not_safe_integer；实测 ${JSON.stringify(over.reasons)}`,
  );
});

test("★P1-1 边界：合法分量的极值仍必须正常相加（证明上面的检查没有过宽）", () => {
  assert.equal(combineOpencodeOutputTokens(0, 0), 0, "0+0 合法");
  assert.equal(combineOpencodeOutputTokens(Number.MAX_SAFE_INTEGER, 0), Number.MAX_SAFE_INTEGER, "MAX_SAFE+0 合法");
  assert.equal(combineOpencodeOutputTokens(1, 2), 3, "小整数正常");
  const half = Number.MAX_SAFE_INTEGER - 1;
  assert.equal(
    combineOpencodeOutputTokens(1, half),
    Number.MAX_SAFE_INTEGER,
    "和恰为 MAX_SAFE 仍合法（上界 inclusive）",
  );
});

// ---------------------------------------------------------------------------
// ★ reasoning 真 0 的判别力证据（最容易被修复搞坏的地方）
// ---------------------------------------------------------------------------

test("★P1-1 `reasoning` 真 0 必须仍可解析：10 + 0 是合法合计 10（不得当缺失）", () => {
  const c = classify(10, 0);
  assert.equal(c.combined, 10, "reasoning=0 是**已知的 0**，合计必须是 10");
  assert.deepEqual(c.flags, [], `10+0 必须是干净合法候选；实测 ${JSON.stringify(c.flags)}`);
  assert.equal(c.sample.outputTokens, 10, "outputTokens 必须是 10");
  assert.ok(!c.flags.includes("MISSING_OUTPUT"), "reasoning=0 绝不能被当缺失");
  assert.ok(!c.flags.includes("TOKEN_INVALID"), "reasoning=0 绝不能被当非法");
});

test("★P1-1 `output` 真 0 / 两者皆 0 的判别力（0 不得被 `!value` 式判断吞掉）", () => {
  const a = classify(0, 5);
  assert.equal(a.combined, 5, "output=0 是已知的 0，合计必须是 5");
  assert.deepEqual(a.flags, [], "0+5 必须是干净合法候选");

  const b = classify(0, 0);
  assert.equal(b.combined, 0, "0+0 = 0");
  assert.ok(b.flags.includes("OUTPUT_ZERO"), "0+0 是合法的真 0");

  // 判别力证明：若实现写成 `if (!output || !reasoning) return null`，则 10+0 与 0+5 都会
  // 掉进 MISSING_OUTPUT。下面两条断言专门盯这个错误写法。
  assert.notEqual(a.combined, null, "output=0 不得返回 null（`!0` 为真 ⇒ 会被误当缺失）");
  assert.notEqual(classify(10, 0).combined, null, "reasoning=0 不得返回 null");
});

// ---------------------------------------------------------------------------
// ★ 超安全整数 + 缺失语义不得被压缩
// ---------------------------------------------------------------------------

test("★P1-1 超安全整数：9e15 + 9e15 与单个超安全分量都必须 TOKEN_INVALID", () => {
  const sumUnsafe = classify(9e15, 9e15);
  assert.ok(
    sumUnsafe.flags.includes("TOKEN_INVALID"),
    `合计超安全整数必须非法；实测 ${JSON.stringify(sumUnsafe.flags)}`,
  );

  // 分量各自超安全整数（单个即非法）—— 修复后应在**相加前**就判定非法
  const partUnsafe = classify(Number.MAX_SAFE_INTEGER + 2, 0);
  assert.ok(
    partUnsafe.flags.includes("TOKEN_INVALID"),
    `单个超安全整数的分量必须判非法；实测 ${JSON.stringify(partUnsafe.flags)}`,
  );
});

test("★P1-1 非法分量**不得**伪装成缺失：非法与 `$.tokens` 整体缺失必须可区分", () => {
  const invalid = classify(-1, 3);
  const missing = classify(undefined, 3);
  const missingBoth = classify(undefined, undefined);

  // 缺失：null ⇒ MISSING_OUTPUT（合法诊断，保持原语义）
  assert.equal(missing.combined, null, "任一侧非数值 ⇒ 合计未知");
  assert.ok(missing.flags.includes("MISSING_OUTPUT"), "缺失必须仍是 MISSING_OUTPUT");
  assert.equal(missingBoth.combined, null);

  // 非法：**不得**也是 null —— 否则两种事实同值，下游再也分不开
  assert.notEqual(
    invalid.combined,
    null,
    "非法分量绝不得返回 null：null 已被『$.tokens 整体缺失』占用，两者同值即归因丢失",
  );
  assert.ok(invalid.flags.includes("TOKEN_INVALID"), "非法分量必须 TOKEN_INVALID");
  assert.ok(!invalid.flags.includes("MISSING_OUTPUT"), "非法不得被归成缺失");

  // 同值压缩的反向检查：两条路径的 flags 必须不同
  assert.notDeepEqual(invalid.flags, missing.flags, "非法与缺失的诊断必须可区分（不得同值）");
});

test("★P1-1 正常正整数仍必须干净通过（双向证据的『合法仍通过』一侧）", () => {
  const c = classify(10, 5);
  assert.equal(c.combined, 15);
  assert.deepEqual(c.flags, [], "正常输入不得带任何标记");
  assert.equal(c.sample.outputTokens, 15);
  assert.equal(c.sample.status, "completed");
  assert.equal(c.sample.timingKind, "generation");
});

test("★P1-1 非数值/NaN/Infinity 的既有语义保持不变（缺失 ⇒ null，不进 TPS 分子）", () => {
  for (const [o, r, label] of [
    [Number.NaN, 5, "NaN output"],
    [10, Number.NaN, "NaN reasoning"],
    ["5", 5, "字符串"],
    [Infinity, 5, "Infinity"],
  ]) {
    const c = classify(o, r);
    assert.equal(c.combined, null, `${label} ⇒ 合计未知`);
    assert.ok(c.flags.includes("MISSING_OUTPUT"), `${label} 应归 MISSING_OUTPUT；实测 ${JSON.stringify(c.flags)}`);
  }
});
