/**
 * M0.2 ZCode 来源模块的契约测试（只读探测）。
 *
 * 夹具一律是**临时 fixture SQLite 库**：不读取本机真实 ZCode 库，也不把本机样本数写进断言。
 * 驱动方式是把一个 shim 模块写进临时 `perf-probe-sources/`，再用冻结外壳的
 * `runPerfProbe(argv, { outputRoot, sourceModuleRoot })` 注入临时根目录——不复刻外壳的目录守卫。
 * shim 只注入 fixture home，真实实现（含逐列存在性、分层计数、只读策略）全部照原样执行。
 * Windows 下跨进程 import 用 `pathToFileURL()` 的 `file://` URL；非零退出取 stdout 用 `spawnSync`。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  KNOWN_COLUMN_NAMES,
  PERF_FLAG_NAMES,
  PROBE_EXIT_CODES,
  SOURCE_WARNING_CODES,
  runPerfProbe,
} from "../scripts/perf-probe.mjs";
import {
  ZCODE_FLAG_NAMES,
  ZCODE_REQUIRED_COLUMNS,
  ZCODE_TTFT_COLUMNS,
  ZCODE_WARNING_CODES,
  buildSelectSql,
  selectBoundedFiles,
} from "../scripts/perf-probe-sources/zcode.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROBE_SCRIPT = path.join(REPO_ROOT, "scripts", "perf-probe.mjs");
const ZCODE_MODULE_FILE = fileURLToPath(new URL("../scripts/perf-probe-sources/zcode.mjs", import.meta.url));
const BASE_TS = 1_700_000_000_000;
const TTFT_SENTINEL = "TTFT_SENTINEL_MUST_NOT_LEAK";
const BODY_SENTINEL = "BODY_SENTINEL_MUST_NOT_LEAK";

const COLUMN_TYPES = Object.freeze({
  attempt_index: "INTEGER",
  retry_count: "INTEGER",
  retryable: "INTEGER",
  cancelled_by_user: "INTEGER",
  started_at: "INTEGER",
  completed_at: "INTEGER",
  duration_ms: "INTEGER",
  input_tokens: "INTEGER",
  output_tokens: "INTEGER",
  first_token_at: "INTEGER",
  time_to_first_token_ms: "INTEGER",
});

let rowSerial = 0;

function quote(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

/**
 * 造一行 `model_usage`：时间戳默认与 `duration_ms` 自洽，只在显式覆盖时才制造时长不一致。
 */
function fixtureRow(overrides = {}) {
  rowSerial += 1;
  const durationMs = Object.hasOwn(overrides, "duration_ms") ? overrides.duration_ms : 1000;
  const startedAt = overrides.started_at ?? BASE_TS;
  const completedAt =
    overrides.completed_at ?? (typeof durationMs === "number" ? startedAt + durationMs : startedAt + 1000);
  return {
    id: `fixture-row-${rowSerial}`,
    session_id: "fixture-session",
    model_id: "fixture-model",
    provider_id: "fixture-provider",
    variant: "max",
    agent: "fixture-agent",
    query_source: "main_turn",
    task_type: "interactive",
    status: "completed",
    attempt_index: 0,
    retry_count: 0,
    retryable: 0,
    cancelled_by_user: 0,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: durationMs,
    input_tokens: 10,
    output_tokens: 20,
    logical_request_id: "fixture-logical-request",
    ...overrides,
  };
}

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "perf-zcode-"));
  const runDirectory = path.join(root, "2026-10-04-perf-metrics", "testrun");
  const sourceDirectory = path.join(root, "perf-probe-sources");
  const homePath = path.join(root, "zcode-home");
  const dbDirectory = path.join(homePath, "cli", "db");
  mkdirSync(runDirectory, { recursive: true });
  mkdirSync(sourceDirectory, { recursive: true });
  mkdirSync(dbDirectory, { recursive: true });
  return {
    root,
    runDirectory,
    sourceDirectory,
    homePath,
    dbFile: path.join(dbDirectory, "db.sqlite"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function createFixtureDatabase(dbFile, { columns, rows = [] } = {}) {
  const database = new DatabaseSync(dbFile);
  try {
    const names = columns ?? [...ZCODE_REQUIRED_COLUMNS, ...ZCODE_TTFT_COLUMNS];
    const definitions = names.map((name) => `${quote(name)} ${COLUMN_TYPES[name] ?? "TEXT"}`);
    database.exec(`CREATE TABLE ${quote("model_usage")} (${definitions.join(", ")})`);
    for (const row of rows) {
      const keys = names.filter((name) => Object.hasOwn(row, name));
      database
        .prepare(
          `INSERT INTO ${quote("model_usage")} (${keys.map(quote).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
        )
        .run(...keys.map((key) => row[key]));
    }
  } finally {
    database.close();
  }
}

function homesFor(fixture, dbFile = fixture.dbFile) {
  return [{ id: "fixture-home", path: fixture.homePath, dbFile }];
}

/** shim 只做 home 注入；被探测的实现仍是仓库里的 zcode.mjs。 */
function writeZcodeShim(sourceDirectory, homes) {
  const source = [
    `import { createZcodeProbe } from ${JSON.stringify(pathToFileURL(ZCODE_MODULE_FILE).href)};`,
    `export const probe = createZcodeProbe({ homes: ${JSON.stringify(homes)} }).probe;`,
  ].join("\n");
  writeFileSync(path.join(sourceDirectory, "zcode.mjs"), `${source}\n`, "utf8");
}

async function runFixtureProbe(fixture, { argvExtra = [], homes } = {}) {
  writeZcodeShim(fixture.sourceDirectory, homes ?? homesFor(fixture));
  const lines = [];
  const exitCode = await runPerfProbe(["--source", "zcode", "--output", fixture.runDirectory, ...argvExtra], {
    log: (line) => lines.push(line),
    outputRoot: fixture.root,
    sourceModuleRoot: pathToFileURL(`${fixture.sourceDirectory}${path.sep}`),
  });
  const artifactFile = path.join(fixture.runDirectory, "zcode-probe.json");
  const text = existsSync(artifactFile) ? readFileSync(artifactFile, "utf8") : "";
  return { exitCode, text, envelope: text ? JSON.parse(text) : null, lines };
}

async function withFixture(run) {
  const fixture = makeFixture();
  try {
    return await run(fixture);
  } finally {
    fixture.cleanup();
  }
}

// ---------------------------------------------------------------- 白名单与纯函数

test("ZCode 的列/flag/告警常量都在外壳白名单内，TTFT 列已在册但读取路径被结构性拦死", () => {
  assert.equal(ZCODE_REQUIRED_COLUMNS.length, 19);
  for (const name of ZCODE_REQUIRED_COLUMNS) {
    assert.ok(KNOWN_COLUMN_NAMES.includes(name), `列 ${name} 不在外壳 KNOWN_COLUMN_NAMES 内`);
  }
  assert.deepEqual([...ZCODE_FLAG_NAMES], [...PERF_FLAG_NAMES]);
  assert.deepEqual([...ZCODE_WARNING_CODES], [...SOURCE_WARNING_CODES]);
  // M0.6 决议 C：TTFT 两列现已进 KNOWN_COLUMN_NAMES，用于**逐列存在性**上报。
  // 这只放宽了"上报存在性"的能力，**没有**放宽读取路径——
  // 真正的防线见下一条用例：列名永远无法进入 buildSelectSql()。
  assert.deepEqual([...ZCODE_TTFT_COLUMNS], ["first_token_at", "time_to_first_token_ms"]);
  for (const name of ZCODE_TTFT_COLUMNS) {
    assert.ok(KNOWN_COLUMN_NAMES.includes(name), `TTFT 列 ${name} 应已在外壳 KNOWN_COLUMN_NAMES 内`);
  }
});

test("SELECT 列表只可能包含 19 个必需列，TTFT 列名永不进入 SQL", () => {
  const sql = buildSelectSql([...ZCODE_REQUIRED_COLUMNS, ...ZCODE_TTFT_COLUMNS], 25);
  for (const name of ZCODE_REQUIRED_COLUMNS) assert.ok(sql.includes(quote(name)), `SQL 缺少列 ${name}`);
  for (const name of ZCODE_TTFT_COLUMNS) assert.ok(!sql.includes(name), `SQL 意外读取 TTFT 列 ${name}`);
  assert.match(sql, /LIMIT \?$/);
  assert.equal(buildSelectSql([]), "");
});

test("有界文件选择取规范排序后的首尾文件", () => {
  const files = ["a", "b", "c", "d", "e", "f"];
  assert.deepEqual(selectBoundedFiles(files, 4), ["a", "b", "e", "f"]);
  assert.deepEqual(selectBoundedFiles(files, 6), files);
  assert.deepEqual(selectBoundedFiles(files, 1), ["a"]);
});

// ---------------------------------------------------------------- 状态 / 重试 / 取消矩阵

test("状态、重试与取消分层：completed/error/cancelled/retry 各有编码计数", async () => {
  await withFixture(async (fixture) => {
    createFixtureDatabase(fixture.dbFile, {
      rows: [
        fixtureRow({ output_tokens: 20, duration_ms: 1000 }),
        fixtureRow({ status: "error", output_tokens: 5, duration_ms: 500, retry_count: 2 }),
        fixtureRow({ status: "cancelled", output_tokens: 0, duration_ms: 800, cancelled_by_user: 1 }),
        fixtureRow({ output_tokens: 5, duration_ms: 2000, retry_count: 1, retryable: 1 }),
        fixtureRow({ output_tokens: 7, duration_ms: 3000, attempt_index: 1 }),
        fixtureRow({ output_tokens: 0, duration_ms: 1200 }),
        fixtureRow({ output_tokens: 9, duration_ms: 0 }),
        fixtureRow({ output_tokens: 11, duration_ms: null, completed_at: BASE_TS + 5000 }),
        fixtureRow({ output_tokens: 13, duration_ms: 1500 }),
      ],
    });
    const { exitCode, envelope } = await runFixtureProbe(fixture);
    assert.equal(exitCode, PROBE_EXIT_CODES.ok);
    assert.equal(envelope.status, "ok");
    const scanned = envelope.scanned;
    assert.equal(scanned.files, 1);
    assert.equal(scanned.filesScanned, 1);
    assert.equal(scanned.rowsTotal, 9);
    assert.equal(scanned.rowsScanned, 9);
    assert.equal(scanned.rawCount, 9);

    assert.equal(scanned.completedRows, 7);
    assert.equal(scanned.errorRows, 1);
    assert.equal(scanned.cancelledRows, 1);
    assert.equal(scanned.statusOtherCount, 0);
    assert.equal(scanned.retryRows, 3);
    assert.equal(scanned.attemptIndexNonZeroCount, 1);
    assert.equal(scanned.retryableCount, 1);
    assert.equal(scanned.cancelledByUserCount, 1);

    // all / positive / filtered 三档分母
    assert.equal(scanned.uniqueIdentities, 9);
    assert.equal(scanned.eligible, 9);
    assert.equal(scanned.positiveOutput, 7);
    assert.equal(scanned.positiveCount, 7);
    assert.equal(scanned.outputZeroCount, 2);
    assert.equal(scanned.timedPositiveOutput, 6);
    assert.equal(scanned.sampled, 3);
    assert.equal(scanned.afterFilterCount, 3);
    assert.equal(scanned.pending, 0);
    assert.equal(scanned.unplaced, 0);
    assert.equal(scanned.dropped, 6);

    // §17.5 恒等式与单调链
    assert.equal(scanned.eligible, scanned.sampled + scanned.dropped + scanned.pending);
    assert.ok(scanned.sampled <= scanned.completeTimedPositiveOutput);
    assert.ok(scanned.completeTimedPositiveOutput <= scanned.timedPositiveOutput);
    assert.ok(scanned.timedPositiveOutput <= scanned.positiveOutput);
    assert.ok(scanned.positiveOutput <= scanned.eligible);

    const flags = envelope.decisions.flagCounts;
    assert.deepEqual(Object.keys(flags).sort(), [...PERF_FLAG_NAMES].sort());
    assert.equal(flags.OUTPUT_ZERO, 2);
    assert.equal(flags.DURATION_NONPOSITIVE, 1);
    assert.equal(flags.SOURCE_FILTERED, 4);
    assert.equal(flags.MISSING_DURATION, 0);
    assert.equal(flags.MISSING_OUTPUT, 0);
    assert.equal(flags.TIME_INVALID, 0);
    assert.equal(flags.TIME_UNPLACED, 0);
    assert.equal(flags.RECORD_CONFLICT, 0);
    assert.equal(flags.TOKEN_INVALID, 0);
    assert.equal(flags.MODEL_AMBIGUOUS, 0);

    assert.equal(envelope.fields.retryEvidence, "retry_count");
    assert.equal(envelope.fields.cancelledEvidence, "cancelled_by_user");
    assert.equal(envelope.fields.durationBasis, "explicit_ms");
    assert.equal(envelope.fields.durationProvenance, "mixed");
    assert.equal(envelope.fields.unitKind, "ms");
    assert.equal(envelope.fields.timeUnit, "milliseconds");
    assert.equal(envelope.fields.tokenScope, "reported_output_unspecified");
    assert.equal(envelope.fields.windowKind, "request");
    assert.equal(envelope.fields.timingKind, "request_e2e");
    assert.equal(envelope.fields.agentKind, "unknown");
    assert.equal(envelope.fields.agentKindMapping, "explicit_subagent_flag");
    assert.equal(envelope.fields.mainProven, false);
    assert.equal(envelope.fields.coverageState, "ready");
    assert.equal(envelope.fields.diagnosticReason, "source_filtered");
    assert.equal(envelope.decisions.checkedRowCount, 8);
    assert.equal(envelope.decisions.fallbackUsed, true);
    assert.deepEqual(envelope.fieldRejections, []);
  });
});

// ---------------------------------------------------------------- duration fallback

test("显式 duration 为真 0/负数时不得暗中回退到时间戳差", async () => {
  await withFixture(async (fixture) => {
    createFixtureDatabase(fixture.dbFile, {
      rows: [
        fixtureRow({ duration_ms: 0, completed_at: BASE_TS + 5000 }),
        fixtureRow({ duration_ms: -5 }),
        fixtureRow({ duration_ms: null, completed_at: BASE_TS + 5000 }),
        fixtureRow({ duration_ms: 1000, completed_at: BASE_TS + 5000 }),
      ],
    });
    const { exitCode, envelope } = await runFixtureProbe(fixture);
    assert.equal(exitCode, PROBE_EXIT_CODES.ok);
    const scanned = envelope.scanned;
    // b1/b2 是显式 0/负：只记 DURATION_NONPOSITIVE，绝不拿到 5000 的正时长。
    assert.equal(scanned.durationFallbackCount, 1);
    assert.equal(scanned.positiveDurationRows, 2);
    assert.equal(envelope.decisions.flagCounts.DURATION_NONPOSITIVE, 2);
    assert.equal(envelope.decisions.flagCounts.MISSING_DURATION, 0);
    assert.equal(scanned.durationMismatchCount, 2);
    assert.equal(envelope.decisions.checkedRowCount, 3);
    assert.equal(envelope.fields.explicitDurationUsed, true);
    assert.equal(envelope.fields.timestampFallbackUsed, true);
    assert.equal(envelope.fields.durationProvenance, "mixed");
    assert.equal(scanned.timedPositiveOutput, 2);
  });
});

test("duration 列缺失时回退 epoch 差，并把 basis/provenance 标成回退路径", async () => {
  await withFixture(async (fixture) => {
    const columns = ZCODE_REQUIRED_COLUMNS.filter((name) => name !== "duration_ms");
    createFixtureDatabase(fixture.dbFile, {
      columns,
      rows: [
        fixtureRow({ duration_ms: null, completed_at: BASE_TS + 7000 }),
        fixtureRow({ duration_ms: null, completed_at: BASE_TS + 3000 }),
      ],
    });
    const { exitCode, envelope } = await runFixtureProbe(fixture);
    assert.equal(exitCode, PROBE_EXIT_CODES.ok);
    assert.equal(envelope.fields.columns.duration_ms, "absent");
    assert.equal(envelope.fields.durationBasis, "epoch_diff");
    assert.equal(envelope.fields.durationProvenance, "timestamp_fallback");
    assert.equal(envelope.fields.explicitDurationUsed, false);
    assert.equal(envelope.scanned.durationFallbackCount, 2);
    assert.equal(envelope.scanned.positiveDurationRows, 2);
    assert.equal(envelope.scanned.timedPositiveOutput, 2);
  });
});

// ---------------------------------------------------------------- 缺列

test("缺列逐项记 absent/unknown，不把缺失默认成 0", async () => {
  await withFixture(async (fixture) => {
    const columns = ["id", "session_id", "status", "output_tokens", "started_at"];
    createFixtureDatabase(fixture.dbFile, {
      columns,
      rows: [fixtureRow({ output_tokens: 10 }), fixtureRow({ output_tokens: 0 }), fixtureRow({ output_tokens: 5 })],
    });
    const { exitCode, envelope } = await runFixtureProbe(fixture);
    assert.equal(exitCode, PROBE_EXIT_CODES.ok);
    const fields = envelope.fields;
    assert.deepEqual(Object.keys(fields.columns), [...ZCODE_REQUIRED_COLUMNS]);
    assert.equal(fields.columns.id, "present");
    assert.equal(fields.columns.completed_at, "absent");
    assert.equal(fields.columns.duration_ms, "absent");
    assert.equal(fields.absentColumnCount, 14);
    assert.equal(fields.presentColumnCount, 5);
    assert.equal(fields.unknownColumnCount, 0);
    assert.deepEqual(fields.columnStates, { present: 5, absent: 14, unknown: 0, total: 19 });
    assert.equal(fields.allColumnsPresent, false);
    assert.equal(fields.durationBasis, "epoch_diff");
    assert.equal(fields.retryEvidence, "absent");
    assert.equal(fields.cancelledEvidence, "status");
    // 缺 completed_at 时无法回退：三行都记 MISSING_DURATION，而不是 0 时长。
    assert.equal(envelope.decisions.flagCounts.MISSING_DURATION, 3);
    assert.equal(envelope.scanned.positiveDurationRows, 0);
    assert.equal(envelope.scanned.outputZeroCount, 1);
    assert.ok(!("outputPositive" in envelope.scanned), "scanned 不得出现白名单外的自造键名");
    assert.equal(envelope.scanned.positiveOutput, 2);
    assert.equal(envelope.scanned.timedPositiveOutput, 0);
  });
});

test("model_usage 表缺失只记 UNSUPPORTED_SCHEMA，列存在性保持 unknown", async () => {
  await withFixture(async (fixture) => {
    const database = new DatabaseSync(fixture.dbFile);
    database.exec('CREATE TABLE "other_table" ("id" TEXT)');
    database.close();
    const { exitCode, envelope } = await runFixtureProbe(fixture);
    assert.equal(exitCode, PROBE_EXIT_CODES.ok);
    assert.equal(envelope.status, "ok");
    assert.equal(envelope.scanned.files, 1);
    assert.equal(envelope.scanned.filesScanned, 1);
    assert.equal(envelope.scanned.rowsScanned, 0);
    assert.equal(envelope.fields.unknownColumnCount, 19);
    assert.equal(envelope.fields.presentColumnCount, 0);
    assert.equal(envelope.fields.allColumnsPresent, false);
    assert.equal(envelope.decisions.schemaDetected, false);
    assert.equal(envelope.decisions.warningCounts.UNSUPPORTED_SCHEMA, 1);
    assert.ok(envelope.warnings.some((entry) => entry.code === "UNSUPPORTED_SCHEMA"));
    assert.equal(envelope.fields.coverageState, "degraded");
  });
});

// ---------------------------------------------------------------- 只读失败

test("只读打开失败只记编码告警，绝不回退可写", async () => {
  await withFixture(async (fixture) => {
    const { exitCode, envelope } = await runFixtureProbe(fixture, {
      homes: [{ id: "fixture-home", path: fixture.homePath, dbFile: fixture.dbFile }],
    });
    assert.equal(exitCode, PROBE_EXIT_CODES.ok);
    assert.equal(envelope.scanned.files, 1);
    assert.equal(envelope.scanned.filesScanned, 0);
    assert.equal(envelope.scanned.rowsScanned, 0);
    assert.equal(envelope.scanned.errors, 1);
    assert.equal(envelope.decisions.openedDatabaseCount, 0);
    assert.equal(envelope.decisions.warningCounts.READ_ONLY_OPEN_FAILED, 1);
    assert.ok(envelope.warnings.some((entry) => entry.code === "READ_ONLY_OPEN_FAILED"));
    assert.equal(envelope.fields.writableFallbackUsed, false);
    assert.equal(envelope.fields.coverageState, "degraded");
    // 可写回退会创建这个文件；它必须仍然不存在。
    assert.equal(existsSync(fixture.dbFile), false);
  });
});

test("非 SQLite 文件只读打开失败，且原始字节不被改写", async () => {
  await withFixture(async (fixture) => {
    const bytes = Buffer.from("not a sqlite database \u0000\u0001\u0002", "utf8");
    writeFileSync(fixture.dbFile, bytes);
    const { exitCode, envelope } = await runFixtureProbe(fixture);
    assert.equal(exitCode, PROBE_EXIT_CODES.ok);
    assert.equal(envelope.scanned.filesScanned, 0);
    assert.equal(envelope.decisions.warningCounts.READ_ONLY_OPEN_FAILED, 1);
    assert.deepEqual(readFileSync(fixture.dbFile), bytes);
    assert.equal(envelope.fields.writableFallbackUsed, false);
  });
});

// ---------------------------------------------------------------- 身份唯一性

test("身份 (home_id,row.id) 重复一致则折叠，冲突则记 RECORD_CONFLICT 并撤回 sampled", async () => {
  await withFixture(async (fixture) => {
    const shared = {
      session_id: "fixture-session",
      status: "completed",
      duration_ms: 1000,
      started_at: BASE_TS,
      completed_at: BASE_TS + 1000,
      model_id: "fixture-model",
      provider_id: "fixture-provider",
    };
    createFixtureDatabase(fixture.dbFile, {
      rows: [
        fixtureRow({ ...shared, id: "dup-1", output_tokens: 10 }),
        fixtureRow({ ...shared, id: "dup-1", output_tokens: 10 }),
        fixtureRow({ ...shared, id: "dup-2", output_tokens: 10 }),
        fixtureRow({ ...shared, id: "dup-3", output_tokens: 10 }),
        fixtureRow({ ...shared, id: "dup-3", output_tokens: 99 }),
      ],
    });
    const { exitCode, envelope } = await runFixtureProbe(fixture);
    assert.equal(exitCode, PROBE_EXIT_CODES.ok);
    const scanned = envelope.scanned;
    assert.equal(scanned.rawCount, 5);
    assert.equal(scanned.uniqueIdentities, 3);
    assert.equal(scanned.duplicateIdentities, 2);
    assert.equal(scanned.identityDuplicateCount, 2);
    assert.equal(scanned.identityDuplicateGroupCount, 2);
    assert.equal(scanned.collapsedRecords, 1);
    assert.equal(scanned.conflictingRecords, 1);
    assert.ok(!("identityUnique" in scanned), "identityUnique 不在外壳 scanned 白名单内，不得上报");
    assert.equal(envelope.fields.identityUnique, false);
    assert.equal(envelope.decisions.identityUnique, false);
    assert.equal(envelope.decisions.identityDuplicateGroupCount, 2);
    assert.equal(envelope.decisions.flagCounts.RECORD_CONFLICT, 1);
    assert.equal(scanned.sampled, 2);
    assert.equal(scanned.eligible, 3);
    assert.equal(scanned.dropped, 1);
    assert.equal(scanned.eligible, scanned.sampled + scanned.dropped + scanned.pending);
  });
});

test("缺 id 的行记 UNKEYABLE_RECORD，不进入可去重候选", async () => {
  await withFixture(async (fixture) => {
    createFixtureDatabase(fixture.dbFile, {
      rows: [fixtureRow({ id: "" }), fixtureRow({ id: "  " }), fixtureRow({ id: "valid-1" })],
    });
    const { exitCode, envelope } = await runFixtureProbe(fixture);
    assert.equal(exitCode, PROBE_EXIT_CODES.ok);
    assert.equal(envelope.scanned.rawCount, 3);
    assert.equal(envelope.scanned.rowsSkipped, 2);
    assert.equal(envelope.scanned.uniqueIdentities, 1);
    assert.equal(envelope.decisions.warningCounts.UNKEYABLE_RECORD, 2);
  });
});

// ---------------------------------------------------------------- 返工2：session 归属冲突维度

test("同 id 不同 session_id 记归属冲突：身份不增加、不静默折叠", async () => {
  await withFixture(async (fixture) => {
    const shared = {
      status: "completed",
      duration_ms: 1000,
      started_at: BASE_TS,
      completed_at: BASE_TS + 1000,
      output_tokens: 10,
      model_id: "fixture-model",
      provider_id: "fixture-provider",
    };
    createFixtureDatabase(fixture.dbFile, {
      rows: [
        // 11 字段签名完全一致，**只有 session_id 不同** —— 缺陷 5 的复现形态。
        fixtureRow({ ...shared, id: "cross-session-1", session_id: "session-A" }),
        fixtureRow({ ...shared, id: "cross-session-1", session_id: "session-B" }),
      ],
    });
    const { exitCode, envelope } = await runFixtureProbe(fixture);
    assert.equal(exitCode, PROBE_EXIT_CODES.ok);
    const scanned = envelope.scanned;

    // 身份构成不变：方案 §17.1:197 的 `(home_id, row.id)` 才是身份，session_id 不在其中。
    assert.equal(scanned.uniqueIdentities, 1, "session_id 不同不得产生第二个身份");
    assert.equal(scanned.duplicateIdentities, 1);
    assert.equal(scanned.identityDuplicateGroupCount, 1);
    // 缺陷修复的核心：必须记冲突诊断，而不是静默一致折叠。
    assert.equal(scanned.conflictingRecords, 1, "同 id 异 session 必须记冲突");
    assert.equal(scanned.collapsedRecords, 0, "同 id 异 session 不得算一致折叠");
    assert.equal(scanned.consistentDuplicateCount, 0);
    assert.equal(envelope.decisions.flagCounts.RECORD_CONFLICT, 1);
    assert.equal(envelope.fields.identityUnique, false);
    // 冲突候选撤回 sampled，落 dropped 并满足 §17.5 恒等式。
    assert.equal(scanned.sampled, 0);
    assert.equal(scanned.eligible, 1);
    assert.equal(scanned.dropped, 1);
    assert.equal(scanned.eligible, scanned.sampled + scanned.dropped + scanned.pending);
  });
});

test("同 id 同 session_id 且其余签名一致 → 仍折叠为一致重复（既有行为不破坏）", async () => {
  await withFixture(async (fixture) => {
    const shared = {
      status: "completed",
      duration_ms: 1000,
      started_at: BASE_TS,
      completed_at: BASE_TS + 1000,
      output_tokens: 10,
      model_id: "fixture-model",
      provider_id: "fixture-provider",
      session_id: "session-A",
    };
    createFixtureDatabase(fixture.dbFile, {
      rows: [fixtureRow({ ...shared, id: "same-session-1" }), fixtureRow({ ...shared, id: "same-session-1" })],
    });
    const { exitCode, envelope } = await runFixtureProbe(fixture);
    assert.equal(exitCode, PROBE_EXIT_CODES.ok);
    const scanned = envelope.scanned;
    assert.equal(scanned.uniqueIdentities, 1);
    assert.equal(scanned.collapsedRecords, 1);
    assert.equal(scanned.consistentDuplicateCount, 1);
    assert.equal(scanned.conflictingRecords, 0);
    assert.equal(envelope.decisions.flagCounts.RECORD_CONFLICT, 0);
    // "已验证无冲突"：有重复行被核对过（consistentDuplicateCount > 0）且零冲突。
    assert.ok(scanned.consistentDuplicateCount > 0 && scanned.conflictingRecords === 0);
  });
});

test("同 id 同 session_id 但其余字段冲突 → 仍按 conflictingRecords 记录（既有行为）", async () => {
  await withFixture(async (fixture) => {
    const shared = {
      status: "completed",
      duration_ms: 1000,
      started_at: BASE_TS,
      completed_at: BASE_TS + 1000,
      model_id: "fixture-model",
      provider_id: "fixture-provider",
      session_id: "session-A",
    };
    createFixtureDatabase(fixture.dbFile, {
      rows: [
        fixtureRow({ ...shared, id: "field-conflict-1", output_tokens: 10 }),
        fixtureRow({ ...shared, id: "field-conflict-1", output_tokens: 99 }),
      ],
    });
    const { exitCode, envelope } = await runFixtureProbe(fixture);
    assert.equal(exitCode, PROBE_EXIT_CODES.ok);
    const scanned = envelope.scanned;
    assert.equal(scanned.uniqueIdentities, 1);
    assert.equal(scanned.conflictingRecords, 1);
    assert.equal(scanned.collapsedRecords, 0);
    assert.equal(envelope.decisions.flagCounts.RECORD_CONFLICT, 1);
  });
});

test("session 归属维度可被机器读取：有重复可查 vs 无重复可查不得都读成 0", async () => {
  // 这是缺陷 5 的元问题：`conflictingRecords=0` 必须能区分
  // "已验证无冲突"（有重复行被核对）与 "未检查/无可查"（没有重复行）。
  await withFixture(async (fixture) => {
    createFixtureDatabase(fixture.dbFile, {
      rows: [
        fixtureRow({ id: "checked-1", session_id: "session-A" }),
        fixtureRow({ id: "checked-1", session_id: "session-A" }),
      ],
    });
    const checked = await runFixtureProbe(fixture);
    assert.equal(checked.envelope.scanned.conflictingRecords, 0);
    assert.equal(checked.envelope.scanned.consistentDuplicateCount, 1, "该维度确实被核对过");

    // 反例：库里根本没有重复 id ⇒ 该维度没有任何可比对的对象。
    const fixture2 = makeFixture();
    try {
      createFixtureDatabase(fixture2.dbFile, { rows: [fixtureRow({ id: "only-1", session_id: "session-A" })] });
      const unchecked = await runFixtureProbe(fixture2);
      assert.equal(unchecked.envelope.scanned.conflictingRecords, 0);
      assert.equal(unchecked.envelope.scanned.consistentDuplicateCount, 0);
      assert.equal(unchecked.envelope.scanned.duplicateIdentities, 0);
      // 两种情形的 (conflictingRecords, consistentDuplicateCount) 组合不同 ⇒ 机器可读区分成立。
      assert.notDeepEqual(
        [checked.envelope.scanned.conflictingRecords, checked.envelope.scanned.consistentDuplicateCount],
        [unchecked.envelope.scanned.conflictingRecords, unchecked.envelope.scanned.consistentDuplicateCount],
      );
    } finally {
      fixture2.cleanup();
    }
  });
});

// ---------------------------------------------------------------- pending / unplaced

test("进行中的候选归 pending，缺 ts 的候选归 unplaced 且不进 eligible", async () => {
  await withFixture(async (fixture) => {
    createFixtureDatabase(fixture.dbFile, {
      rows: [
        fixtureRow({ status: "in_progress", output_tokens: 10, duration_ms: 1000 }),
        fixtureRow({ status: "completed", output_tokens: 10, duration_ms: 1000, started_at: null, completed_at: null }),
        fixtureRow({ status: "completed", output_tokens: 10, duration_ms: 1000 }),
      ],
    });
    const { exitCode, envelope } = await runFixtureProbe(fixture);
    assert.equal(exitCode, PROBE_EXIT_CODES.ok);
    const scanned = envelope.scanned;
    assert.equal(scanned.uniqueIdentities, 3);
    assert.equal(scanned.unplaced, 1);
    assert.equal(scanned.missingTimestampCount, 1);
    assert.equal(scanned.eligible, 2);
    assert.equal(scanned.pending, 1);
    assert.equal(scanned.sampled, 1);
    assert.equal(scanned.dropped, 0);
    assert.equal(scanned.eligible, scanned.sampled + scanned.dropped + scanned.pending);
    assert.equal(envelope.decisions.flagCounts.TIME_UNPLACED, 1);
    // 进行中不等于失败，也不等于“无终态证据”：只有缺 ts 的那一行记 TERMINAL_UNVERIFIED。
    assert.equal(envelope.decisions.flagCounts.TERMINAL_UNVERIFIED, 1);
    assert.equal(envelope.decisions.flagCounts.SOURCE_FILTERED, 0);
    assert.equal(envelope.fields.diagnosticReason, "terminal_unverified");
  });
});

// ---------------------------------------------------------------- TTFT / 脱敏

test("TTFT 只报存在性；产物不含 TTFT 值与正文/身份哨兵", async () => {
  await withFixture(async (fixture) => {
    createFixtureDatabase(fixture.dbFile, {
      columns: [...ZCODE_REQUIRED_COLUMNS, ...ZCODE_TTFT_COLUMNS, "raw_usage_json", "error_message"],
      rows: [
        fixtureRow({
          id: "ID_SENTINEL_1234",
          session_id: "SESSION_SENTINEL_5678",
          first_token_at: TTFT_SENTINEL,
          time_to_first_token_ms: TTFT_SENTINEL,
          raw_usage_json: BODY_SENTINEL,
          error_message: BODY_SENTINEL,
        }),
      ],
    });
    const { exitCode, envelope, text } = await runFixtureProbe(fixture);
    assert.equal(exitCode, PROBE_EXIT_CODES.ok);
    assert.equal(envelope.fields.ttftColumnPresent, true);
    assert.equal(envelope.fields.ttftRead, false);
    // M0.6 决议 C：逐列存在性现在可数（两列都在 → 2），但**取值仍然不读**。
    assert.equal(envelope.scanned.ttftColumnCount, 2);
    assert.equal(envelope.scanned.streamAccessed, undefined, "scanned 不承载访问证明键");
    assert.equal(envelope.fields.streamAccessed, false);
    assert.equal(envelope.fields.contentAccessed, false);
    assert.ok(!text.includes(TTFT_SENTINEL), "TTFT 值泄漏到产物");
    assert.ok(!text.includes(BODY_SENTINEL), "非白名单列正文泄漏到产物");
    assert.ok(!text.includes("ID_SENTINEL_1234"), "原始 id 泄漏到产物");
    assert.ok(!text.includes("SESSION_SENTINEL_5678"), "session_id 泄漏到产物");
    assert.ok(!text.includes(fixture.root), "临时根路径泄漏到产物");
    assert.deepEqual(envelope.fieldRejections, []);
  });
});

test("M0.6-B：agent 角色分层必须有行级数字证据，且没有主代理证据时 mainRows 必须为 0", async () => {
  await withFixture(async (fixture) => {
    createFixtureDatabase(fixture.dbFile, {
      rows: [
        fixtureRow({ query_source: "subagent", task_type: "subagent_child" }),
        fixtureRow({ query_source: "main_turn", task_type: "interactive" }),
        fixtureRow({ query_source: "main_turn", task_type: "interactive" }),
      ],
    });
    const { exitCode, envelope } = await runFixtureProbe(fixture);
    assert.equal(exitCode, PROBE_EXIT_CODES.ok);
    assert.deepEqual(envelope.fieldRejections, []);
    const scanned = envelope.scanned;
    // 三分结论现在有数字：1 个显式 subagent 标记行 + 2 个无角色证据行。
    assert.equal(scanned.subagentRows, 1);
    assert.equal(scanned.unknownAgentRows, 2);
    assert.equal(scanned.mainRows, 0, "没有已核实的主代理证据时，绝不反推 main");
    assert.equal(
      scanned.subagentRows + scanned.mainRows + scanned.unknownAgentRows,
      scanned.uniqueIdentities,
      "角色分层必须完整覆盖全部候选行",
    );
    assert.equal(envelope.fields.agentKind, "unknown", "名称/单行标记不足以给全源 agent_kind");
    assert.equal(envelope.fields.mainProven, false);
  });
});

test("前后指纹与源变更标记：产物只含摘要与计数", async () => {
  await withFixture(async (fixture) => {
    createFixtureDatabase(fixture.dbFile, { rows: [fixtureRow()] });
    const { exitCode, envelope } = await runFixtureProbe(fixture);
    assert.equal(exitCode, PROBE_EXIT_CODES.ok);
    for (const fingerprint of [envelope.sourceFingerprintBefore, envelope.sourceFingerprintAfter]) {
      assert.match(fingerprint.contentFingerprint, /^[0-9a-f]{64}$/);
      assert.equal(fingerprint.fileCount, 1);
      assert.equal(fingerprint.homeCount, 1);
    }
    assert.equal(envelope.liveSourceChanged, false);
    assert.equal(envelope.decisions.liveSourceChanged, false);
    assert.equal(envelope.decisions.filesDiscovered, envelope.scanned.files);
    assert.equal(envelope.decisions.filesDiscovered, 1);
    assert.equal(envelope.decisions.filesScanned, 1);
  });
});

test("零来源时给出 SOURCE_UNAVAILABLE，而不是伪造 0 样本成功", async () => {
  await withFixture(async (fixture) => {
    const { exitCode, envelope } = await runFixtureProbe(fixture, { homes: [] });
    assert.equal(exitCode, PROBE_EXIT_CODES.ok);
    assert.equal(envelope.scanned.files, 0);
    assert.equal(envelope.scanned.filesScanned, 0);
    assert.equal(envelope.scanned.rowsScanned, 0);
    assert.ok(envelope.warnings.some((entry) => entry.code === "SOURCE_UNAVAILABLE"));
    assert.equal(envelope.fields.coverageState, "degraded");
  });
});

// ---------------------------------------------------------------- 返工：默认筛选的一致性

test("终态未验证的候选不得同时进 sampled（completed + 缺 completed_at + 正输出 + 显式时长）", async () => {
  await withFixture(async (fixture) => {
    createFixtureDatabase(fixture.dbFile, {
      rows: [
        // 审核复现行：status=completed、completed_at 缺失、正输出、显式正时长。
        fixtureRow({ status: "completed", completed_at: null, output_tokens: 30, duration_ms: 900 }),
        fixtureRow({ status: "completed", output_tokens: 30, duration_ms: 900 }),
      ],
    });
    const { exitCode, envelope } = await runFixtureProbe(fixture);
    assert.equal(exitCode, PROBE_EXIT_CODES.ok);
    const scanned = envelope.scanned;

    assert.equal(envelope.decisions.flagCounts.TERMINAL_UNVERIFIED, 1);
    // 关键断言：被标为终态未验证的候选必须落 dropped，不能同时出现在 sampled 里。
    assert.equal(scanned.sampled, 1, "终态未验证候选不得计入 sampled");
    assert.equal(scanned.eligible, 2);
    assert.equal(scanned.dropped, 1);
    assert.equal(scanned.pending, 0);
    assert.equal(scanned.eligible, scanned.sampled + scanned.dropped + scanned.pending);
    // 单调链不受影响：未验证候选仍留在 timedPositive 层，只是不进 sampled。
    assert.ok(scanned.sampled <= scanned.completeTimedPositiveOutput);
    assert.equal(scanned.timedPositiveOutput, 2);
    assert.equal(scanned.completeTimedPositiveOutput, 2);
    assert.equal(scanned.positiveOutput, 2);
    assert.ok(scanned.timedPositiveOutput <= scanned.positiveOutput);
    assert.ok(scanned.positiveOutput <= scanned.eligible);
    // 主原因优先级：该 dropped 的主原因是 terminal_unverified（不是 source_filtered/output）。
    assert.equal(envelope.fields.diagnosticReason, "terminal_unverified");
  });
});

// ---------------------------------------------------------------- 返工：全源共享预算

test("有界预算是全源共享的：跨文件累计，filesScanned 只报实际扫描过的文件", async () => {
  await withFixture(async (fixture) => {
    const homes = [];
    for (const index of [0, 1, 2]) {
      const homePath = path.join(fixture.root, `home-${index}`);
      const dbDirectory = path.join(homePath, "cli", "db");
      mkdirSync(dbDirectory, { recursive: true });
      const dbFile = path.join(dbDirectory, "db.sqlite");
      createFixtureDatabase(dbFile, {
        rows: [
          fixtureRow({ completed_at: BASE_TS + index * 10 + 1 }),
          fixtureRow({ completed_at: BASE_TS + index * 10 + 2 }),
          fixtureRow({ completed_at: BASE_TS + index * 10 + 3 }),
        ],
      });
      homes.push({ id: `fixture-home-${index}`, path: homePath, dbFile });
    }

    const bounded = await runFixtureProbe(fixture, { argvExtra: ["--max-rows", "4"], homes });
    assert.equal(bounded.exitCode, PROBE_EXIT_CODES.ok);
    const scanned = bounded.envelope.scanned;
    // 3 个库各 3 行：共享预算 4 → 只读 4 行，绝不允许 3 × 4 = 12 行。
    assert.equal(scanned.files, 3);
    assert.equal(scanned.filesDiscovered, 3);
    // 预算耗尽后不再打开第三个库，因此它既不进 filesScanned，也不进 rowsTotal ——
    // 分母只覆盖"实际读取范围"，不能被未读文件的行数污染。
    assert.equal(scanned.rowsTotal, 6);
    assert.equal(scanned.rowsScanned, 4, "有界预算必须跨文件共享");
    assert.equal(scanned.rawCount, 4);
    assert.equal(scanned.rowsRead, 4);
    // 第 3 个文件没有被扫描，filesScanned 只报前两个。
    assert.equal(scanned.filesScanned, 2, "filesScanned 必须是实际扫描过的文件数");
    assert.ok(scanned.filesScanned <= scanned.filesDiscovered);
    assert.equal(scanned.filesDiscovered, scanned.files);
    assert.equal(scanned.capped, true);
    assert.equal(scanned.hasMore, true);
    assert.equal(scanned.bounded, true);
    assert.equal(scanned.complete, false);
    // 进入统计的范围来自实际读取的 4 行（不是三个库的全部 9 行）。
    assert.equal(scanned.uniqueIdentities, 4);
    assert.equal(scanned.eligible, 4);

    // 预算恰好覆盖全部文件时，filesScanned 回到选中数。
    const exact = await runFixtureProbe(fixture, { argvExtra: ["--max-rows", "9"], homes });
    assert.equal(exact.exitCode, PROBE_EXIT_CODES.ok);
    assert.equal(exact.envelope.scanned.rowsScanned, 9);
    assert.equal(exact.envelope.scanned.rowsTotal, 9);
    assert.equal(exact.envelope.scanned.filesScanned, 3);
    assert.equal(exact.envelope.scanned.complete, false);

    // --full 不受预算限制，行为不变。
    const full = await runFixtureProbe(fixture, { argvExtra: ["--full"], homes });
    assert.equal(full.exitCode, PROBE_EXIT_CODES.ok);
    assert.equal(full.envelope.scanned.rowsScanned, 9);
    assert.equal(full.envelope.scanned.rowsTotal, 9);
    assert.equal(full.envelope.scanned.filesScanned, 3);
    assert.equal(full.envelope.scanned.filesDiscovered, 3);
    assert.equal(full.envelope.scanned.complete, true);
    assert.equal(full.envelope.scanned.bounded, false);
  });
});

// ---------------------------------------------------------------- 有界 vs 全量

test("有界探测报告实际范围；--full 只在文件全扫时才标 complete", async () => {
  await withFixture(async (fixture) => {
    createFixtureDatabase(fixture.dbFile, {
      rows: [
        fixtureRow({ completed_at: BASE_TS + 1000 }),
        fixtureRow({ completed_at: BASE_TS + 2000 }),
        fixtureRow({ completed_at: BASE_TS + 3000 }),
        fixtureRow({ completed_at: BASE_TS + 4000 }),
      ],
    });

    const bounded = await runFixtureProbe(fixture, { argvExtra: ["--max-rows", "2"] });
    assert.equal(bounded.exitCode, PROBE_EXIT_CODES.ok);
    assert.equal(bounded.envelope.decisions.full, false);
    assert.equal(bounded.envelope.decisions.maxRows, 2);
    assert.equal(bounded.envelope.scanned.files, 1);
    assert.equal(bounded.envelope.scanned.rowsTotal, 4);
    assert.equal(bounded.envelope.scanned.rowsScanned, 2);
    assert.equal(bounded.envelope.scanned.bounded, true);
    assert.equal(bounded.envelope.scanned.capped, true);
    assert.equal(bounded.envelope.scanned.hasMore, true);
    assert.equal(bounded.envelope.scanned.truncated, true);
    assert.equal(bounded.envelope.scanned.complete, false);
    assert.equal(bounded.envelope.fields.maxRows, 2);

    const full = await runFixtureProbe(fixture, { argvExtra: ["--full"] });
    assert.equal(full.exitCode, PROBE_EXIT_CODES.ok);
    assert.equal(full.envelope.decisions.full, true);
    assert.equal(full.envelope.decisions.maxFiles, null);
    assert.equal(full.envelope.decisions.maxRows, null);
    assert.equal(full.envelope.scanned.rowsScanned, 4);
    assert.equal(full.envelope.scanned.filesScanned, 1);
    assert.equal(full.envelope.scanned.filesDiscovered, 1);
    assert.equal(full.envelope.scanned.complete, true);
    assert.equal(full.envelope.scanned.bounded, false);
    assert.ok(!("maxRows" in full.envelope.fields), "全量探测不应报有界上限");
  });
});

// ---------------------------------------------------------------- 跨进程驱动

test("跨进程驱动：pathToFileURL 的 file:// 模块与 spawnSync 非零退出 stdout", () => {
  const fixture = makeFixture();
  try {
    createFixtureDatabase(fixture.dbFile, { rows: [fixtureRow()] });
    writeZcodeShim(fixture.sourceDirectory, homesFor(fixture));
    const sourceModuleRoot = pathToFileURL(`${fixture.sourceDirectory}${path.sep}`).href;
    const scriptFile = path.join(fixture.root, "drive.mjs");
    const drive = (argv) =>
      [
        `import { runPerfProbe } from ${JSON.stringify(pathToFileURL(PROBE_SCRIPT).href)};`,
        `const argv = ${JSON.stringify(argv)};`,
        `process.exitCode = await runPerfProbe(argv, { outputRoot: ${JSON.stringify(fixture.root)}, sourceModuleRoot: ${JSON.stringify(sourceModuleRoot)} });`,
      ].join("\n");

    writeFileSync(
      scriptFile,
      `${drive(["--source", "zcode", "--output", fixture.runDirectory, "--max-rows", "5"])}\n`,
      "utf8",
    );
    const okRun = spawnSync(process.execPath, [scriptFile], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(okRun.status, PROBE_EXIT_CODES.ok, String(okRun.stderr));
    const envelope = JSON.parse(readFileSync(path.join(fixture.runDirectory, "zcode-probe.json"), "utf8"));
    assert.equal(envelope.status, "ok");
    assert.equal(envelope.scanned.rowsScanned, 1);
    assert.equal(envelope.source, "zcode");

    writeFileSync(scriptFile, `${drive(["--source", "zcode"])}\n`, "utf8");
    const badRun = spawnSync(process.execPath, [scriptFile], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(badRun.status, PROBE_EXIT_CODES.usage);
    assert.match(String(badRun.stdout), /MISSING_OUTPUT/);
  } finally {
    fixture.cleanup();
  }
});
