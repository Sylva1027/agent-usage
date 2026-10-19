// M2.1 ZCode reader 专项测试。
//
// 纪律（M1 教训固化）：
// - **只测一侧 = 没测规则**：每条规则都测正例与反例（显式真 0 vs 字段缺失回退；只读成功 vs 只读失败；
//   有身份 vs 无身份；subagent 标志 vs 无标志）。
// - **不写死期望值**：断言恒等式与判别式，不硬编码本机行数。
// - **遇 0 先问"判别式可达吗"**：凡是断言 `0`/`null` 的地方，都另有一条用例证明该分支确实可达。
//
// 夹具全部是临时目录里的合成 SQLite，绝不触碰本机真实库。

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  buildZcodeSelectSql,
  classifyZcodeInteger,
  classifyZcodeRow,
  normalizeZcodeTimestamp,
  resolveZcodeDuration,
  streamZcodePerfSamples,
  ZCODE_MINIMUM_COLUMNS,
  ZCODE_SELECT_COLUMNS,
  ZcodeReadOnlyOpenError,
} from "../src/perf-sources/zcode.js";

// ---------------------------------------------------------------- 夹具

const BASE_TS = 1_700_000_000_000;
const TTFT_SENTINEL = "TTFT_SENTINEL_MUST_NEVER_BE_READ";
const BODY_SENTINEL = "BODY_SENTINEL_MUST_NEVER_BE_READ";

/** 全部 19 个白名单列 + TTFT 两列 + 正文/错误哨兵列（哨兵列**不在**白名单，永不 SELECT）。 */
const ALL_COLUMNS = [
  ...ZCODE_SELECT_COLUMNS,
  "first_token_at",
  "time_to_first_token_ms",
  "raw_usage_json",
  "error_message",
];

function defaultRow(overrides = {}) {
  return {
    id: "row-1",
    session_id: "session-1",
    status: "completed",
    attempt_index: 0,
    retry_count: 0,
    retryable: 0,
    cancelled_by_user: 0,
    started_at: BASE_TS,
    completed_at: BASE_TS + 1000,
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
    first_token_at: TTFT_SENTINEL,
    time_to_first_token_ms: TTFT_SENTINEL,
    raw_usage_json: BODY_SENTINEL,
    error_message: BODY_SENTINEL,
    ...overrides,
  };
}

/** 建库：只建传入的列；`columns` 缺省为全部列。 */
function createFixtureDatabase(dbFile, { columns = ALL_COLUMNS, rows = [], tableName = null } = {}) {
  const db = new DatabaseSync(dbFile);
  try {
    const name = tableName || "model_usage";
    db.exec(`CREATE TABLE "${name}" (${columns.map((column) => `"${column}"`).join(", ")})`);
    if (rows.length > 0) {
      const placeholders = columns.map(() => "?").join(", ");
      const statement = db.prepare(
        `INSERT INTO "${name}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${placeholders})`,
      );
      for (const row of rows) {
        statement.run(...columns.map((column) => (Object.hasOwn(row, column) ? row[column] : null)));
      }
    }
  } finally {
    db.close();
  }
  return dbFile;
}

/** 临时工作区：`root/<homeId>/db.sqlite`，并允许在关闭前用 WAL 追加行。 */
function makeWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), "m21-zcode-"));
  const homeDir = path.join(root, "home");
  mkdirSync(homeDir, { recursive: true });
  const dbFile = path.join(homeDir, "db.sqlite");
  return {
    root,
    homeDir,
    dbFile,
    source: { id: "home-1", path: homeDir },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 收集候选与警告。 */
async function collect(dbFile, source, options = {}) {
  const samples = [];
  const warnings = [];
  const stats = await streamZcodePerfSamples(dbFile, source, (sample) => samples.push(sample), {
    onWarning: (warning) => warnings.push(warning),
    ...options,
  });
  return { samples, warnings, stats };
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** 库 + `-wal`/`-shm` 的哈希快照（存在才记）。 */
function snapshotFiles(dbFile) {
  const snapshot = {};
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${dbFile}${suffix}`;
    if (existsSync(file)) {
      snapshot[suffix] = { hash: sha256(file), size: statSync(file).size };
    }
  }
  return snapshot;
}

// ---------------------------------------------------------------- 1. 导出面与 SQL 白名单

test("SELECT 语句只可能包含 19 个白名单列，TTFT 与正文列名永不进入 SQL", () => {
  const available = new Set(ALL_COLUMNS);
  const sql = buildZcodeSelectSql(available);

  // 正向：白名单列全在。
  for (const column of ZCODE_SELECT_COLUMNS) {
    assert.ok(sql.includes(`"${column}"`), `白名单列应进入 SQL: ${column}`);
  }
  // 反向：白名单**之外**的列一个都不能出现。这条断言让"漏加列"和"多加列"都必须被显式处理。
  for (const column of ALL_COLUMNS) {
    if (ZCODE_SELECT_COLUMNS.includes(column)) continue;
    assert.ok(!sql.includes(`"${column}"`), `非白名单列不得进入 SQL: ${column}`);
  }
  // TTFT 与正文列是最敏感的三类，单独再锁一次。
  for (const forbidden of ["first_token_at", "time_to_first_token_ms", "raw_usage_json", "error_message"]) {
    assert.ok(!sql.includes(forbidden), `永不可读的列进入了 SQL: ${forbidden}`);
  }
  assert.match(sql, /ORDER BY "id"/, "必须按 id 稳定迭代");
  assert.match(sql, /FROM "model_usage"/);
});

test("缺列时 SELECT 自动收缩到可用列；无任何可读列时返回空串", () => {
  // 收缩是可达的：只给最小必需列。
  const minimal = buildZcodeSelectSql(new Set(["id", "status", "output_tokens"]));
  assert.ok(minimal.includes('"id"'));
  assert.ok(!minimal.includes('"session_id"'), "不可用列不得出现在 SQL 中");
  assert.ok(!minimal.includes('"duration_ms"'));

  // 空集分支可达：判别式返回 ""，调用方据此抛 UNSUPPORTED_SCHEMA。
  assert.equal(buildZcodeSelectSql(new Set()), "");
});

// ---------------------------------------------------------------- 2. 显式真 0 / 负数不回退（两侧都测）

test("显式 duration_ms 为真 0 → 原样保留 0，timingSource=explicit，绝不回退时间戳差", () => {
  const available = new Set(ZCODE_SELECT_COLUMNS);
  // 时间戳差是 1000ms：如果实现偷偷回退，durationMs 会变成 1000 而不是 0。
  const row = defaultRow({ duration_ms: 0, started_at: BASE_TS, completed_at: BASE_TS + 1000 });
  const { durationMs, timingSource } = resolveZcodeDuration(row, available);
  assert.equal(durationMs, 0, "显式真 0 必须保留 0");
  assert.notEqual(durationMs, 1000, "绝不能在真 0 时回退到时间戳差");
  assert.equal(timingSource, "explicit");
});

test("显式 duration_ms 为负数 → 原样保留负数（不暗中回退、不取绝对值）", () => {
  const available = new Set(ZCODE_SELECT_COLUMNS);
  const row = defaultRow({ duration_ms: -500, started_at: BASE_TS, completed_at: BASE_TS + 1000 });
  const { durationMs, timingSource } = resolveZcodeDuration(row, available);
  assert.equal(durationMs, -500);
  assert.notEqual(durationMs, 1000, "负数不得回退");
  assert.notEqual(durationMs, 500, "负数不得取绝对值");
  assert.equal(timingSource, "explicit");
});

test("反例：duration_ms 字段缺失 / NULL 才回退时间戳差；两侧都缺 → null 而非 0", () => {
  const available = new Set(ZCODE_SELECT_COLUMNS);

  // 反例 A：NULL（列在、值缺）→ 回退。
  const nulled = resolveZcodeDuration(defaultRow({ duration_ms: null }), available);
  assert.equal(nulled.durationMs, 1000);
  assert.equal(nulled.timingSource, "timestamp_fallback");

  // 反例 B：列整个不存在 → 回退（判别式确实可达，不是只在 A 生效）。
  const withoutDurationColumn = new Set(ZCODE_SELECT_COLUMNS.filter((column) => column !== "duration_ms"));
  const missingColumn = resolveZcodeDuration(defaultRow({ duration_ms: 1000 }), withoutDurationColumn);
  assert.equal(missingColumn.durationMs, 1000);
  assert.equal(missingColumn.timingSource, "timestamp_fallback");

  // 反例 C：显式与两个时间戳全缺 → null（**不是 0**：缺字段不等于 0，契约 §3 第 5 条）。
  const nothing = resolveZcodeDuration(
    defaultRow({ duration_ms: null, started_at: null, completed_at: null }),
    available,
  );
  assert.equal(nothing.durationMs, null);
  assert.notEqual(nothing.durationMs, 0, "缺失不得变成 0");
  assert.equal(nothing.timingSource, "unknown");

  // 反例 D：时间戳差为负（completed < started）→ 不产出负的"回退时长"，记 null。
  const inverted = resolveZcodeDuration(
    defaultRow({ duration_ms: null, started_at: BASE_TS + 5000, completed_at: BASE_TS }),
    available,
  );
  assert.equal(inverted.durationMs, null);
});

test("非整数/超安全整数的显式时长不回退也不透传（TIME_INVALID 输入面）", () => {
  const available = new Set(ZCODE_SELECT_COLUMNS);
  for (const bad of [1.5, Number.MAX_SAFE_INTEGER + 2, "not-a-number"]) {
    const { durationMs } = resolveZcodeDuration(defaultRow({ duration_ms: bad }), available);
    // 这些不是安全整数 → 走回退（时间戳差 1000），而不是把坏值当显式值透传。
    assert.equal(durationMs, 1000, `坏值 ${String(bad)} 应走回退而不是透传`);
    assert.notEqual(durationMs, bad);
  }
});

// ---------------------------------------------------------------- 3. 秒/毫秒单位（裁定 T，契约 §3 第 7 条）

test("秒级时间戳先转毫秒；毫秒级原样；无法判定单位时既不转也不猜", () => {
  const asSeconds = normalizeZcodeTimestamp(1_700_000_000);
  assert.equal(asSeconds.unitKnown, true);
  assert.equal(asSeconds.ms, 1_700_000_000_000, "秒级必须转成毫秒");

  const asMillis = normalizeZcodeTimestamp(BASE_TS);
  assert.equal(asMillis.unitKnown, true);
  assert.equal(asMillis.ms, BASE_TS, "毫秒级不得再乘 1000");

  // 判别式可达的"单位不可判定"档：1e10 < v < 1e12。
  const ambiguous = normalizeZcodeTimestamp(500_000_000_000);
  assert.equal(ambiguous.unitKnown, false);
  assert.equal(ambiguous.ms, null, "单位不可判定时不猜单位，值不参与时长计算");

  // 0/负数越界 → null，不是 0。
  assert.equal(normalizeZcodeTimestamp(0).ms, null);
  assert.equal(normalizeZcodeTimestamp(-1).ms, null);
  assert.equal(normalizeZcodeTimestamp(null).ms, null);
});

// ---------------------------------------------------------------- 4. status / 过滤 / 不丢弃

test("status 字面值映射到 §17.1 枚举；未识别值给 unverified 而不是默默 completed", () => {
  const available = new Set(ZCODE_SELECT_COLUMNS);
  const cases = [
    ["completed", "completed"],
    ["success", "completed"],
    ["error", "failed"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["canceled", "cancelled"],
    ["in_progress", "in_progress"],
    ["running", "in_progress"],
  ];
  for (const [literal, expected] of cases) {
    assert.equal(classifyZcodeRow(defaultRow({ status: literal }), available).status, expected, literal);
  }
  // 判别式可达：未识别字面值 → unverified（不是 completed）。
  const unknown = classifyZcodeRow(defaultRow({ status: "who_knows" }), available);
  assert.equal(unknown.status, "unverified");
  assert.equal(unknown.terminalVerified, false);
  assert.ok(unknown.flags.includes("TERMINAL_UNVERIFIED"));
});

test("裁定 F：completed 但 completed_at 缺失 → 终态未验证（两侧都测）", () => {
  const available = new Set(ZCODE_SELECT_COLUMNS);
  // 正例：completed 且有 completed_at → 已验证。
  const verified = classifyZcodeRow(defaultRow({ status: "completed", completed_at: BASE_TS + 1000 }), available);
  assert.equal(verified.terminalVerified, true);
  assert.ok(!verified.flags.includes("TERMINAL_UNVERIFIED"));
  // 反例：completed 但 completed_at NULL → 未验证。
  const unverified = classifyZcodeRow(defaultRow({ status: "completed", completed_at: null }), available);
  assert.equal(unverified.terminalVerified, false);
  assert.ok(unverified.flags.includes("TERMINAL_UNVERIFIED"));
});

test("被过滤的候选仍被输出（覆盖率要用它算 drained 原因），只标记不丢弃", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDatabase(workspace.dbFile, {
      rows: [
        defaultRow({ id: "ok-1", status: "completed" }),
        defaultRow({ id: "err-1", status: "error" }),
        defaultRow({ id: "cancel-1", status: "cancelled" }),
        defaultRow({ id: "retry-1", attempt_index: 2 }),
        defaultRow({ id: "prog-1", status: "in_progress" }),
      ],
    });
    const { samples, stats } = await collect(workspace.dbFile, workspace.source);

    // 关键：5 行全部产出候选，一条都没在 reader 里被丢掉。
    assert.equal(stats.rowsScanned, 5);
    assert.equal(samples.length, 5, "被过滤的候选必须保留给覆盖率");
    const byId = new Map(samples.map((sample) => [sample.rowId, sample]));

    assert.equal(byId.get("err-1").status, "failed");
    assert.equal(byId.get("err-1").sourceFiltered, true);
    assert.equal(byId.get("err-1").filterReason, "source_failed");

    assert.equal(byId.get("cancel-1").status, "cancelled");
    assert.equal(byId.get("cancel-1").filterReason, "source_cancelled");

    assert.equal(byId.get("retry-1").sourceFiltered, true);
    assert.equal(byId.get("retry-1").filterReason, "source_retry");
    assert.equal(byId.get("retry-1").retryCount, 0, "retry_count=0 但 attempt_index=2 也算重试");
    assert.equal(byId.get("retry-1").status, "completed", "重试不等于失败：状态仍是来源状态");

    assert.equal(byId.get("prog-1").status, "in_progress");
    assert.equal(byId.get("prog-1").inProgress, true);

    // 反例：正常完成的行**不**被过滤（证明 sourceFiltered=true 不是恒真）。
    assert.equal(byId.get("ok-1").sourceFiltered, false);
    assert.equal(byId.get("ok-1").filterReason, "");
    assert.equal(byId.get("ok-1").status, "completed");
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------- 5. main 不反推 / agent

test("main 绝不反推：无明确 subagent 标志一律 unknown，即使 agent 名像主代理", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDatabase(workspace.dbFile, {
      rows: [
        // 名字极像主代理、且 query_source/task_type 都不是 subagent。
        defaultRow({ id: "main-ish", agent: "main", query_source: "main", task_type: "chat" }),
        defaultRow({ id: "sub-qs", agent: "a", query_source: "subagent", task_type: "chat" }),
        defaultRow({ id: "sub-tt", agent: "a", query_source: "main", task_type: "subagent_child" }),
        defaultRow({ id: "unknown-1", agent: "some-name", query_source: "", task_type: "" }),
      ],
    });
    const { samples } = await collect(workspace.dbFile, workspace.source);
    const byId = new Map(samples.map((sample) => [sample.rowId, sample]));

    assert.equal(byId.get("main-ish").agentKind, "unknown", "名字像 main 不是 main 证据");
    for (const sample of samples) {
      assert.notEqual(sample.agentKind, "main", "四源 mainProven 全 false，reader 不得产出 main");
      assert.ok(["subagent", "unknown"].includes(sample.agentKind));
    }
    // 两个明确标志各自单独可达（不是只认一个）。
    assert.equal(byId.get("sub-qs").agentKind, "subagent");
    assert.equal(byId.get("sub-tt").agentKind, "subagent");
    assert.equal(byId.get("unknown-1").agentKind, "unknown");

    // 裁定 P：名字保留原值（名字类字段空 = ""）；kind 与名字分离记录。
    assert.equal(byId.get("main-ish").agent, "main");
    assert.equal(byId.get("sub-qs").agent, "a");
  } finally {
    workspace.cleanup();
  }
});

test("裁定 P：variant 作为 effort 类证据保留原值；model/provider 的 unknown 字面量不在此处归一", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDatabase(workspace.dbFile, {
      rows: [defaultRow({ id: "u-1", model_id: "unknown", provider_id: "unknown", variant: "unknown" })],
    });
    const { samples } = await collect(workspace.dbFile, workspace.source);
    // reader 只做**取值**，不做 `unknown` → `""` 的归一：那是 `normalizePerfSample` 的
    // 权威职责（裁定 P 的 nameOrEmpty）。reader 提前归一会让"来源真有这个字面值"这一事实
    // 在 raw 候选里消失，属于 reader 越权。
    assert.equal(samples[0].modelProvider, "unknown", "reader 不归一 name 类字段，交给内核");
    assert.equal(samples[0].model, "unknown");
    // variant 是 effort 类证据，保留原值（同样不在此处归一）。
    assert.equal(samples[0].reasoningEffort, "unknown");
    // 但**真名的空值**必须保持空串（reader 侧确实做了 trim）。
    const emptyWorkspace = makeWorkspace();
    try {
      createFixtureDatabase(emptyWorkspace.dbFile, {
        rows: [defaultRow({ id: "u-2", model_id: "", provider_id: "  ", variant: "" })],
      });
      const second = await collect(emptyWorkspace.dbFile, emptyWorkspace.source);
      assert.equal(second.samples[0].model, "");
      assert.equal(second.samples[0].modelProvider, "", "纯空白 trim 成空串");
      assert.equal(second.samples[0].reasoningEffort, "");
    } finally {
      emptyWorkspace.cleanup();
    }
  } finally {
    workspace.cleanup();
  }
});

test("断言：集成层调用 normalizePerfSample 后 unknown 归一到空串（reader 与内核分工自洽）", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDatabase(workspace.dbFile, {
      rows: [defaultRow({ id: "u-1", model_id: "unknown", provider_id: "unknown", variant: "unknown" })],
    });
    const { samples } = await collect(workspace.dbFile, workspace.source);
    const { normalizePerfSample } = await import("../src/perf-stats.js");
    const { sample, warnings } = normalizePerfSample(samples[0]);
    assert.equal(sample.modelProvider, "", "内核把字面 unknown 归一到空串（裁定 P）");
    assert.equal(sample.model, "unknown", "model 是名字类但内核只对 provider/effort/evidence 归一");
    assert.deepEqual(warnings, [], "可信候选不应产生归一化警告");
    // 语义字段必须与内核权威值一致，否则会得 SOURCE_SEMANTICS_MISMATCH。
    assert.equal(sample.window, "request");
    assert.equal(sample.timingKind, "request_e2e");
    assert.equal(sample.tokenScope, "reported_output_unspecified");
    assert.equal(sample.sampleKey, JSON.stringify(["zcode", "home-1", "u-1"]));
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------- 6. 语义字段自洽

test("window/timingKind/tokenScope 与 sourceKind=zcode 自洽（防 SOURCE_SEMANTICS_MISMATCH）", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDatabase(workspace.dbFile, { rows: [defaultRow()] });
    const { samples } = await collect(workspace.dbFile, workspace.source);
    assert.equal(samples[0].window, "request");
    assert.equal(samples[0].timingKind, "request_e2e");
    assert.equal(samples[0].tokenScope, "reported_output_unspecified");
    assert.equal(samples[0].sourceKind, "zcode");
  } finally {
    workspace.cleanup();
  }
});

test("sampleKey 与 §17.1 身份元组一致：只有 (homeId, row.id)，session_id 不参与", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDatabase(workspace.dbFile, {
      rows: [defaultRow({ id: "same", session_id: "session-A" }), defaultRow({ id: "same", session_id: "session-B" })],
    });
    const { samples } = await collect(workspace.dbFile, workspace.source);
    const expected = JSON.stringify(["zcode", "home-1", "same"]);
    assert.equal(samples[0].sampleKey, expected);
    // 裁定 O：session_id 不一致**不**产生第二个身份 —— 两行的 key 必须完全相同。
    assert.equal(samples[1].sampleKey, expected, "session_id 不参与身份键");
    assert.deepEqual(samples[0].identity, ["same"]);
    // session_id 仍被记录，只是不参与身份。
    assert.equal(samples[0].sessionId, "session-A");
    assert.equal(samples[1].sessionId, "session-B");
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------- 7. 缺身份 / TTFT / 哨兵

test("缺 id 的行进 UNKEYABLE_RECORD 且不产出候选；有 id 的行照常产出（两侧都测）", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDatabase(workspace.dbFile, {
      rows: [defaultRow({ id: "" }), defaultRow({ id: "   " }), defaultRow({ id: "valid-1" })],
    });
    const { samples, warnings, stats } = await collect(workspace.dbFile, workspace.source);
    assert.equal(stats.rowsScanned, 3);
    assert.equal(stats.unkeyable, 2);
    assert.equal(samples.length, 1, "只有有身份的行产出候选");
    const warning = warnings.find((entry) => entry.code === "UNKEYABLE_RECORD");
    assert.ok(warning, "无身份行必须记编码 warning");
    assert.equal(warning.count, 2);
    assert.equal(warning.sourceKind, "zcode");
    assert.equal(warning.homeId, "home-1");
  } finally {
    workspace.cleanup();
  }
});

test("无 UNKEYABLE 行时不发该 warning（证明 warning 不是恒发）", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDatabase(workspace.dbFile, { rows: [defaultRow()] });
    const { warnings } = await collect(workspace.dbFile, workspace.source);
    assert.deepEqual(warnings, []);
  } finally {
    workspace.cleanup();
  }
});

test("TTFT 与正文字段即使有值也永不读取；同 logical_request_id 的两个尝试各自成候选", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDatabase(workspace.dbFile, {
      rows: [
        // TTFT 列与正文列都塞哨兵值：任何读取都会把它们带进候选。
        defaultRow({ id: "attempt-1", logical_request_id: "same-lr", attempt_index: 0, first_token_at: 1 }),
        defaultRow({ id: "attempt-2", logical_request_id: "same-lr", attempt_index: 1, first_token_at: 1 }),
      ],
    });
    const { samples } = await collect(workspace.dbFile, workspace.source);

    // logical_request_id 只辅助重试过滤、不作唯一键：两个尝试是两个候选、两个不同 key。
    assert.equal(samples.length, 2, "同 logical_request_id 不得折叠成一个候选");
    assert.notEqual(samples[0].sampleKey, samples[1].sampleKey);
    assert.equal(samples[0].turnKey, "same-lr");
    assert.ok(samples.every((sample) => sample.turnKey === "same-lr"));
    assert.ok(!samples[0].sampleKey.includes("same-lr"), "logical_request_id 不得进入身份键");

    // 哨兵绝不出现在任何候选的任何值里。
    const serialized = JSON.stringify(samples);
    assert.ok(!serialized.includes(TTFT_SENTINEL), "TTFT 哨兵泄漏进候选");
    assert.ok(!serialized.includes(BODY_SENTINEL), "正文哨兵泄漏进候选");
    assert.ok(!("ttftMs" in samples[0]), "候选不得含 TTFT 字段");
  } finally {
    workspace.cleanup();
  }
});

test("缺 TTFT 不剔除候选；超长时长只记录不剔除（LONG_WINDOW 由内核判）", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDatabase(workspace.dbFile, {
      rows: [
        // TTFT 两列为 NULL（缺 TTFT）。
        defaultRow({ id: "no-ttft", first_token_at: null, time_to_first_token_ms: null }),
        // 约 20 分钟的请求（超长窗口），reader 必须原样输出，不自行剔除。
        defaultRow({ id: "long", duration_ms: 1_200_000, started_at: BASE_TS, completed_at: BASE_TS + 1_200_000 }),
      ],
    });
    const { samples } = await collect(workspace.dbFile, workspace.source);
    assert.equal(samples.length, 2, "缺 TTFT 与超长时长都不得自动剔除");
    const long = samples.find((sample) => sample.rowId === "long");
    assert.equal(long.durationMs, 1_200_000);
    assert.equal(long.timingSource, "explicit");
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------- 8. 只读性（哈希实测）

test("只读性证明：reader 前后主库与 WAL/SHM 字节哈希完全不变", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDatabase(workspace.dbFile, {
      rows: [defaultRow({ id: "a" }), defaultRow({ id: "b" })],
    });

    const before = snapshotFiles(workspace.dbFile);
    const mainBefore = sha256(workspace.dbFile);

    const { samples } = await collect(workspace.dbFile, workspace.source);
    assert.equal(samples.length, 2, "reader 确实读到了数据（否则哈希不变是空洞的）");

    const after = snapshotFiles(workspace.dbFile);
    const mainAfter = sha256(workspace.dbFile);

    assert.equal(mainAfter, mainBefore, "主库哈希必须不变（只读性证明）");
    assert.deepEqual(after, before, "库与附属文件集合必须逐字节不变");
  } finally {
    workspace.cleanup();
  }
});

test("WAL 仅更新：未 checkpoint 的 WAL 中数据可被读出，且 reader 不改动主库字节", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDatabase(workspace.dbFile, { rows: [defaultRow({ id: "base-1" })] });

    // 开启 WAL 并追加一行，让新行留在 -wal 里而不写回主库。
    const writer = new DatabaseSync(workspace.dbFile);
    try {
      writer.exec("PRAGMA journal_mode = WAL");
      writer.exec("PRAGMA wal_autocheckpoint = 0");
      writer
        .prepare('INSERT INTO "model_usage" ("id", "status", "output_tokens") VALUES (?, ?, ?)')
        .run("wal-only-1", "completed", 20);
    } finally {
      // close 时 SQLite 可能自动 checkpoint，所以顺序是"先关 writer 再取快照"。
      writer.close();
    }

    // 先做一次只读探查，让 SQLite 建立它的 read-only 共享内存索引文件。
    // 这一步是**必要的**：`-wal`/`-shm` 是 WAL 模式的派生索引，即使**纯粹只读**的打开也会
    // 创建它们（实测：只读打开 + 一次 SELECT 即产生 `-wal`=0B、`-shm`=32768B）。若不先建立，
    // "快照差异"测的就是 SQLite 的 sidecar 建立时机，而不是本质库的只读性 —— 那是**假阳性**。
    await collect(workspace.dbFile, workspace.source);

    const before = snapshotFiles(workspace.dbFile);
    const mainBefore = sha256(workspace.dbFile);
    const walBefore = existsSync(`${workspace.dbFile}-wal`) ? sha256(`${workspace.dbFile}-wal`) : null;

    const { samples } = await collect(workspace.dbFile, workspace.source);
    const after = snapshotFiles(workspace.dbFile);

    // 两条都要读到：WAL 中的数据必须对只读读者可见。
    const ids = samples.map((sample) => sample.rowId).sort();
    assert.ok(ids.includes("base-1"), "主库行应可读");
    assert.ok(ids.includes("wal-only-1"), "WAL 中的行应可读");

    // 本质只读性：主库字节、WAL 内容与全部 sidecar 逐字节不变。
    assert.equal(sha256(workspace.dbFile), mainBefore, "主库字节必须不变");
    if (walBefore !== null) {
      assert.equal(sha256(`${workspace.dbFile}-wal`), walBefore, "WAL 内容必须不变");
    }
    assert.deepEqual(after, before, "reader 不得改动主库、WAL 或 SHM 的任何字节");
  } finally {
    workspace.cleanup();
  }
});

test("只读打开不新建 WAL/SHM sidecar（区分源码只读与 SQLite 派生索引）", async () => {
  // 锁定上一条测试的前提假设：非 WAL 库在只读打开后**不**会产生 `-wal`/`-shm`。
  // 若这条失败，说明 sidecar 的产生时机变了，上一条的"先探查再快照"步骤需要重新审视。
  const workspace = makeWorkspace();
  try {
    createFixtureDatabase(workspace.dbFile, { rows: [defaultRow({ id: "a" })] });
    assert.ok(!existsSync(`${workspace.dbFile}-wal`), "非 WAL 库初始不应有 -wal");
    await collect(workspace.dbFile, workspace.source);
    assert.ok(!existsSync(`${workspace.dbFile}-wal`), "非 WAL 库只读读取后仍不应有 -wal");
    assert.ok(!existsSync(`${workspace.dbFile}-shm`), "非 WAL 库只读读取后仍不应有 -shm");
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------- 9. 只读失败（致命路径，编码可达）

test("只读打开失败抛出编码原因 READ_ONLY_OPEN_FAILED，且不回退普通打开", async () => {
  const workspace = makeWorkspace();
  try {
    // 判别式可达：写一个**不是** SQLite 的文件。
    // SQLite 对非数据库文件是延迟读文件头，构造可能成功、读 schema 才失败 —— 两条路径都必须归入同一编码。
    writeFileSync(workspace.dbFile, "this is definitely not a sqlite database", "utf8");

    const before = sha256(workspace.dbFile);
    await assert.rejects(
      () => streamZcodePerfSamples(workspace.dbFile, workspace.source, () => {}),
      (error) => {
        assert.ok(error instanceof ZcodeReadOnlyOpenError, "必须是编码错误类型");
        assert.equal(error.code, "READ_ONLY_OPEN_FAILED");
        return true;
      },
    );
    // 失败路径也不得写源文件。
    assert.equal(sha256(workspace.dbFile), before, "打开失败路径不得写入源文件");
  } finally {
    workspace.cleanup();
  }
});

test("路径不存在 → 只读打开失败（编码原因），不是静默空结果", async () => {
  const workspace = makeWorkspace();
  try {
    const missing = path.join(workspace.homeDir, "nope.sqlite");
    await assert.rejects(
      () => streamZcodePerfSamples(missing, workspace.source, () => {}),
      (error) => {
        assert.equal(error.code, "READ_ONLY_OPEN_FAILED");
        return true;
      },
    );
  } finally {
    workspace.cleanup();
  }
});

test("能力守护：缺 model_usage 表 → UNSUPPORTED_SCHEMA；缺必需列 → UNSUPPORTED_SCHEMA", async () => {
  const workspace = makeWorkspace();
  try {
    // 分支 A：表不存在。
    createFixtureDatabase(workspace.dbFile, { tableName: "some_other_table", rows: [] });
    await assert.rejects(
      () => streamZcodePerfSamples(workspace.dbFile, workspace.source, () => {}),
      (error) => {
        assert.equal(error.code, "UNSUPPORTED_SCHEMA");
        return true;
      },
    );
  } finally {
    workspace.cleanup();
  }

  // 分支 B：表在、但缺必需列（可达性：逐个必需列都试一遍）。
  for (const missingColumn of ZCODE_MINIMUM_COLUMNS) {
    const workspace2 = makeWorkspace();
    try {
      const columns = ALL_COLUMNS.filter((column) => column !== missingColumn);
      createFixtureDatabase(workspace2.dbFile, { columns, rows: [] });
      await assert.rejects(
        () => streamZcodePerfSamples(workspace2.dbFile, workspace2.source, () => {}),
        (error) => {
          assert.equal(error.code, "UNSUPPORTED_SCHEMA", `缺 ${missingColumn} 应报 UNSUPPORTED_SCHEMA`);
          return true;
        },
      );
    } finally {
      workspace2.cleanup();
    }
  }
});

// ---------------------------------------------------------------- 10. 字段可用性退化（每一列都可缺）

test("逐列缺失退化：任一白名单列缺失都不崩，且不把缺值当 0", async () => {
  // 对**每一**个可选列做一次"删掉它"的实验；只要必需列还在，reader 必须仍能跑通。
  const optionalColumns = ALL_COLUMNS.filter((column) => !ZCODE_MINIMUM_COLUMNS.includes(column));
  for (const dropped of optionalColumns) {
    const workspace = makeWorkspace();
    try {
      const columns = ALL_COLUMNS.filter((column) => column !== dropped);
      createFixtureDatabase(workspace.dbFile, { columns, rows: [defaultRow()] });
      const { samples } = await collect(workspace.dbFile, workspace.source);
      assert.equal(samples.length, 1, `缺列 ${dropped} 时仍应产出候选`);
      const sample = samples[0];
      // 缺 duration_ms → 走回退（本例时间戳齐备）→ 1000；绝不变成 0。
      if (dropped === "duration_ms") {
        assert.equal(sample.durationMs, 1000);
        assert.equal(sample.timingSource, "timestamp_fallback");
      }
      // 缺 output_tokens → null，不是 0。
      if (dropped === "output_tokens") {
        assert.equal(sample.outputTokens, null);
        assert.notEqual(sample.outputTokens, 0, "缺字段不得变成 0");
      }
      // 缺 input_tokens → null。
      if (dropped === "input_tokens") {
        assert.equal(sample.inputTokens, null);
      }
      // 缺 session_id → 空串（名字类字段口径），身份不受影响。
      if (dropped === "session_id") {
        assert.equal(sample.sessionId, "");
        assert.equal(sample.sampleKey, JSON.stringify(["zcode", "home-1", "row-1"]));
      }
      // 缺 status → 未识别 → unverified（不是 completed）。
      if (dropped === "status") {
        assert.equal(sample.status, "unverified");
        assert.equal(sample.terminalVerified, false);
      }
    } finally {
      workspace.cleanup();
    }
  }
});

// ---------------------------------------------------------------- 11. 整数分类判别式自身

test("classifyZcodeInteger 覆盖每个分支（0/null 分支的判别式可达性）", () => {
  assert.equal(classifyZcodeInteger(null), "missing");
  assert.equal(classifyZcodeInteger(undefined), "missing");
  assert.equal(classifyZcodeInteger(""), "missing");
  assert.equal(classifyZcodeInteger(0), "zero");
  assert.equal(classifyZcodeInteger(5), "positive");
  assert.equal(classifyZcodeInteger(-5), "negative");
  assert.equal(classifyZcodeInteger(1.5), "non_integer");
  assert.equal(classifyZcodeInteger(Number.MAX_SAFE_INTEGER + 2), "unsafe");
  assert.equal(classifyZcodeInteger("abc"), "not_a_number");
  assert.equal(classifyZcodeInteger(true), "not_a_number");
  assert.equal(classifyZcodeInteger(Number.NaN), "not_a_number");
  assert.equal(classifyZcodeInteger(Number.POSITIVE_INFINITY), "not_a_number");
  // 数字字符串按整数处理（SQLite 列可能是 TEXT 亲和）。
  assert.equal(classifyZcodeInteger("42"), "positive");
});

// ---------------------------------------------------------------- 12. 返工1：bigint 分支

test("bigint 三态与 number 路径同语义（同值同类别）", () => {
  // 安全 bigint 必须按值分派，而不是一律 unsafe。
  assert.equal(classifyZcodeInteger(1000n), "positive");
  assert.equal(classifyZcodeInteger(0n), "zero");
  assert.equal(classifyZcodeInteger(-5n), "negative");
  assert.equal(classifyZcodeInteger(1n), "positive");

  // 强性质断言：同值同类别，两种载体必须一致（这比逐值断言更难被局部补丁骗过）。
  for (const value of [0, 1, -1, 42, -42, 9007199254740991, -9007199254740991]) {
    assert.equal(
      classifyZcodeInteger(BigInt(value)),
      classifyZcodeInteger(value),
      `bigint 与 number 对 ${value} 的类别必须一致`,
    );
  }
});

test("bigint 安全边界用 2n**53n 判据（不是十进制直觉）：2n**53n-1n 安全、2n**53n 不安全", () => {
  // 边界事实自检：MAX_SAFE_INTEGER 恰好是 2n**53n - 1n。
  assert.equal(BigInt(Number.MAX_SAFE_INTEGER), 2n ** 53n - 1n, "MAX_SAFE_INTEGER 应等于 2n**53n - 1n");

  // 边界内侧：安全 → 参与判定（正/负都测）。
  assert.equal(classifyZcodeInteger(2n ** 53n - 1n), "positive");
  assert.equal(classifyZcodeInteger(-(2n ** 53n - 1n)), "negative");
  // 边界外侧：不安全 → unsafe（**不是** not_a_number）。
  assert.equal(classifyZcodeInteger(2n ** 53n), "unsafe");
  assert.equal(classifyZcodeInteger(-(2n ** 53n)), "unsafe");
  // 远超范围的大 bigint 同样归 unsafe。
  assert.equal(classifyZcodeInteger(2n ** 64n), "unsafe");
  assert.equal(classifyZcodeInteger(-(2n ** 64n)), "unsafe");
});

test("不安全的 bigint 不参与判定，且绝不因先转 Number 而丢失精度", () => {
  // 精度陷阱实证：9007199254740993n 转 Number 会静默变成 ...992（偶数）。
  // 若实现"先转再判"，这个值会被误判成安全整数。
  const trap = 9007199254740993n;
  assert.equal(Number(trap), 9007199254740992, "该值转 Number 丢精度（前提自检）");
  assert.notEqual(BigInt(Number(trap)), trap, "转 Number 后已无法还原原 bigint（丢精度确证）");
  assert.equal(classifyZcodeInteger(trap), "unsafe", "先判范围才能挡住精度陷阱");
  assert.equal(classifyZcodeInteger(-trap), "unsafe");
});

test("返工1 核心：resolveZcodeDuration 收到 0n 必须保留真 0，不得回退时间戳差", () => {
  const available = new Set(["duration_ms", "started_at", "completed_at"]);
  // 时间戳差刻意设成明显不同的值：任何回退都会被断言抓住。
  const zeroBigint = resolveZcodeDuration(
    { duration_ms: 0n, started_at: BASE_TS, completed_at: BASE_TS + 5000 },
    available,
  );
  assert.equal(zeroBigint.durationMs, 0, "0n 必须保留 0（这正是本卡最不容妥协的规则）");
  assert.notEqual(zeroBigint.durationMs, 5000, "0n 不得被暗中回退成时间戳差");
  assert.equal(zeroBigint.timingSource, "explicit");

  // 正 bigint 同样走 explicit，而不是回退。
  const positiveBigint = resolveZcodeDuration(
    { duration_ms: 1000n, started_at: BASE_TS, completed_at: BASE_TS + 5000 },
    available,
  );
  assert.equal(positiveBigint.durationMs, 1000);
  assert.notEqual(positiveBigint.durationMs, 5000);
  assert.equal(positiveBigint.timingSource, "explicit");

  // 负 bigint 保留负值、不取绝对值（与 number 路径同一规则）。
  const negativeBigint = resolveZcodeDuration(
    { duration_ms: -7n, started_at: BASE_TS, completed_at: BASE_TS + 5000 },
    available,
  );
  assert.equal(negativeBigint.durationMs, -7);
  assert.notEqual(negativeBigint.durationMs, 7, "不得取绝对值");
  assert.equal(negativeBigint.timingSource, "explicit");

  // 不安全 bigint 不进入 explicit：走回退（与 number 路径的越界行为一致）。
  const unsafeBigint = resolveZcodeDuration(
    { duration_ms: 2n ** 64n, started_at: BASE_TS, completed_at: BASE_TS + 5000 },
    available,
  );
  assert.equal(unsafeBigint.durationMs, 5000, "不安全 bigint 应与 number 越界同样走回退");
  assert.equal(unsafeBigint.timingSource, "timestamp_fallback");
});

test("bigint 与 number 在 resolveZcodeDuration 上逐值等价（同值同结果）", () => {
  const available = new Set(["duration_ms", "started_at", "completed_at"]);
  const timestamps = { started_at: BASE_TS, completed_at: BASE_TS + 5000 };
  for (const value of [0, 1, -1, 42, -42, 9007199254740991]) {
    const asNumber = resolveZcodeDuration({ duration_ms: value, ...timestamps }, available);
    const asBigint = resolveZcodeDuration({ duration_ms: BigInt(value), ...timestamps }, available);
    assert.deepEqual(asBigint, asNumber, `duration_ms=${value} 的两种载体结果必须一致`);
  }
});

test("可达性如实标注：DatabaseSync 默认返回 number，bigint 分支当前不可达（防御性）", async () => {
  // 这条**不是**在证明 bigint 路径被生产覆盖 —— 恰恰相反，它固化"当前不可达"这一事实，
  // 使将来若有人开启 readBigInts，本断言会变红从而提醒复核。
  const workspace = makeWorkspace();
  try {
    createFixtureDatabase(workspace.dbFile, { rows: [defaultRow({ id: "n-1", duration_ms: 1000 })] });
    const database = new DatabaseSync(workspace.dbFile, { readOnly: true });
    try {
      const row = database.prepare('SELECT "duration_ms" FROM "model_usage" LIMIT 1').get();
      assert.equal(typeof row.duration_ms, "number", "未开 readBigInts 时读回 number");
      assert.notEqual(typeof row.duration_ms, "bigint", "若变红：有人开了 readBigInts，需重评可达性");
    } finally {
      database.close();
    }
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------- 13. 返工2：字符串载体

test("返工2 核心：纯空白字符串判 missing，绝不判 zero（含 NBSP/U+3000）", () => {
  // 正侧：各种"Number() 会当 0"的空白形态都必须判缺失。
  for (const blank of [" ", "\t", "\n", "  ", "\u00a0", "\u3000", "\r\n", " \t ", "\u00a0\u3000"]) {
    assert.equal(classifyZcodeInteger(blank), "missing", `${JSON.stringify(blank)} 必须判 missing`);
    assert.notEqual(classifyZcodeInteger(blank), "zero", `${JSON.stringify(blank)} 不得判 zero`);
  }
  // 反侧（关键）：真正的零必须仍是 zero，证明不是"把空白和零一起误杀"。
  assert.equal(classifyZcodeInteger("0"), "zero", "字符串真零必须保留 zero");
  assert.equal(classifyZcodeInteger("-0"), "zero");
  assert.equal(classifyZcodeInteger("+0"), "zero");
  assert.equal(classifyZcodeInteger("00"), "zero");
  // "0 " trim 后是 "0"（真零），不是空白 —— 不能误判成 missing。
  assert.equal(classifyZcodeInteger("0 "), "zero", "trim 后非空的仍是真零");
  assert.equal(classifyZcodeInteger(" 42 "), "positive", "前后空白但内容合法的仍按数值判定");
});

test("返工2：非十进制整数文本一律 not_a_number（十六/二/八进制、科学计数法、小数点）", () => {
  const rejected = [
    "0x10", // 十六进制：Number() 会给 16
    "0X10",
    "0b101", // 二进制：Number() 会给 5
    "0o17", // 八进制：Number() 会给 15
    "1e3", // 科学计数法：Number() 会给 1000
    "1E3",
    "1e-3",
    "1.0", // 小数点：Number() 会给 1
    "0.",
    ".5",
    "1.5", // 非整数
    "1_000", // 数字分隔符
    "Infinity",
    "-Infinity",
    "NaN",
    "abc",
    "5n",
    "1,000",
    "0x",
  ];
  for (const text of rejected) {
    assert.equal(classifyZcodeInteger(text), "not_a_number", `${JSON.stringify(text)} 必须判 not_a_number`);
  }
  // 合法十进制整数文本仍被接受（证明判据不是"一律拒绝字符串"）。
  assert.equal(classifyZcodeInteger("42"), "positive");
  assert.equal(classifyZcodeInteger("007"), "positive", "前导零仍是合法十进制整数文本");
  assert.equal(classifyZcodeInteger("-5"), "negative");
});

test("返工2 裁定的 +5：判 positive（依据 SQLite 自身 INTEGER 亲和把 +5 转成 5）", () => {
  // 依据在测试里可复现：SQLite 对声明 INTEGER 的列把 "+5" 存成整数 5。
  const workspace = makeWorkspace();
  try {
    const db = new DatabaseSync(workspace.dbFile);
    try {
      db.exec('CREATE TABLE "affinity_probe" ("v" INTEGER)');
      db.prepare('INSERT INTO "affinity_probe" ("v") VALUES (?)').run("+5");
      db.prepare('INSERT INTO "affinity_probe" ("v") VALUES (?)').run("-5");
      db.prepare('INSERT INTO "affinity_probe" ("v") VALUES (?)').run("0x10");
      const rows = db.prepare('SELECT "v", typeof("v") AS t FROM "affinity_probe"').all();
      // "+5"/"-5" 是 SQLite 认可的合法十进制整数文本 ⇒ 被转成 integer。
      assert.equal(rows[0].t, "integer", "+5 应被 SQLite 按 INTEGER 亲和转成整数");
      assert.equal(rows[0].v, 5);
      assert.equal(rows[1].t, "integer", "-5 同理");
      // "0x10" 不是 SQLite 的整数文本 ⇒ 保留 TEXT（这正是它必须判 not_a_number 的原因）。
      assert.equal(rows[2].t, "text", "0x10 不被 SQLite 当整数，保留 TEXT");
      assert.equal(rows[2].v, "0x10");
    } finally {
      db.close();
    }
  } finally {
    workspace.cleanup();
  }
  // 与上述 SQLite 事实一致：带符号十进制文本按数值分派。
  assert.equal(classifyZcodeInteger("+5"), "positive");
  assert.equal(classifyZcodeInteger("-5"), "negative");
  assert.equal(classifyZcodeInteger("+0"), "zero");
});

test("返工2 危害消除：resolveZcodeDuration 对空白字符串判缺失，不得产出 durationMs=0", () => {
  const available = new Set(["duration_ms", "started_at", "completed_at"]);
  const timestamps = { started_at: BASE_TS, completed_at: BASE_TS + 5000 };

  // 空白 ⇒ 走回退（而不是被当成"真实的 0 毫秒"）。
  const blank = resolveZcodeDuration({ duration_ms: " ", ...timestamps }, available);
  assert.notEqual(blank.durationMs, 0, "空白不得被当成真 0（契约 §3 第 5 条 / 裁定 N）");
  assert.equal(blank.durationMs, 5000, "空白应走时间戳回退");
  assert.equal(blank.timingSource, "timestamp_fallback");

  // 反侧：字符串真 "0" 必须保留 explicit 0（不能因为修空白而误伤真零）。
  const realZero = resolveZcodeDuration({ duration_ms: "0", ...timestamps }, available);
  assert.equal(realZero.durationMs, 0, "字符串真零必须保留 0");
  assert.equal(realZero.timingSource, "explicit");

  // 十六进制字符串同样不得被当数值。
  const hex = resolveZcodeDuration({ duration_ms: "0x10", ...timestamps }, available);
  assert.equal(hex.durationMs, 5000);
  assert.equal(hex.timingSource, "timestamp_fallback");
});

test("返工2：number / bigint / string 三载体对同一数值语义类别一致", () => {
  // 三载体必须同类别（要求 5 的强性质断言）。
  const triples = [0, 1, -1, 42, -42, 9007199254740991, -9007199254740991];
  for (const value of triples) {
    const asNumber = classifyZcodeInteger(value);
    const asBigint = classifyZcodeInteger(BigInt(value));
    const asString = classifyZcodeInteger(String(value));
    assert.equal(asBigint, asNumber, `bigint 与 number 对 ${value} 必须同类别`);
    assert.equal(asString, asNumber, `string 与 number 对 ${value} 必须同类别`);
  }

  // resolveZcodeDuration 层也逐值等价（三载体同结果）。
  const available = new Set(["duration_ms", "started_at", "completed_at"]);
  const timestamps = { started_at: BASE_TS, completed_at: BASE_TS + 5000 };
  for (const value of triples) {
    const asNumber = resolveZcodeDuration({ duration_ms: value, ...timestamps }, available);
    const asBigint = resolveZcodeDuration({ duration_ms: BigInt(value), ...timestamps }, available);
    const asString = resolveZcodeDuration({ duration_ms: String(value), ...timestamps }, available);
    assert.deepEqual(asBigint, asNumber, `duration_ms=${value} bigint 载体结果必须一致`);
    assert.deepEqual(asString, asNumber, `duration_ms=${value} string 载体结果必须一致`);
  }
});

test("返工2 可达性如实标注：SQLite 类型宽容使 TEXT 载体可达（但真实库当前为 0 行）", () => {
  // 这条把"可达性"从散文变成可复现事实：列声明 INTEGER 时，SQLite 仍**保留**非整数文本为 TEXT。
  // 注意：这**不是**"已在真实数据观测到" —— 真实库当前该列全为 integer、TEXT 行为 0。
  const workspace = makeWorkspace();
  try {
    const db = new DatabaseSync(workspace.dbFile);
    try {
      db.exec('CREATE TABLE "t" ("v" INTEGER)');
      const insert = db.prepare('INSERT INTO "t" ("v") VALUES (?)');
      for (const v of [" ", "0x10", "abc"]) insert.run(v);
      const rows = db.prepare('SELECT typeof("v") AS t FROM "t"').all();
      assert.deepEqual(
        rows.map((row) => row.t),
        ["text", "text", "text"],
        "SQLite 允许非整数文本落进 INTEGER 列并保留 TEXT ⇒ string 分支非纯防御性",
      );
    } finally {
      db.close();
    }
  } finally {
    workspace.cleanup();
  }
});

test("输出 tokens 直接取原值：不叠 reasoning；input 不叠缓存（真 0 保留 0）", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDatabase(workspace.dbFile, {
      rows: [
        defaultRow({ id: "z-1", output_tokens: 0, input_tokens: 0 }),
        defaultRow({ id: "p-1", output_tokens: 123, input_tokens: 456 }),
      ],
    });
    const { samples } = await collect(workspace.dbFile, workspace.source);
    const byId = new Map(samples.map((sample) => [sample.rowId, sample]));
    // 真 0 保留 0（不是 null，也不是"缺失"）。
    assert.equal(byId.get("z-1").outputTokens, 0);
    assert.equal(byId.get("z-1").inputTokens, 0);
    assert.equal(byId.get("p-1").outputTokens, 123);
    assert.equal(byId.get("p-1").inputTokens, 456);
    // 不得出现任何"叠加"字段（reasoning/cache 不是本 reader 的概念）。
    assert.ok(!("reasoningTokens" in byId.get("p-1")));
    assert.ok(!("cacheTokens" in byId.get("p-1")));
  } finally {
    workspace.cleanup();
  }
});

test("无 id 列时所有行都无身份（UNSUPPORTED_SCHEMA 先拦，不会走到这里）—— 守护顺序可测", async () => {
  // 这条锁定"能力守护先于迭代"：id 是必需列，缺它在守护处就抛，不会产出无身份候选。
  const workspace = makeWorkspace();
  try {
    const columns = ALL_COLUMNS.filter((column) => column !== "id");
    createFixtureDatabase(workspace.dbFile, { columns, rows: [] });
    await assert.rejects(
      () => streamZcodePerfSamples(workspace.dbFile, workspace.source, () => {}),
      (error) => {
        assert.equal(error.code, "UNSUPPORTED_SCHEMA");
        return true;
      },
    );
  } finally {
    workspace.cleanup();
  }
});

test("空表：0 行 0 候选（判别式可达：确有合法的空库）", async () => {
  const workspace = makeWorkspace();
  try {
    createFixtureDatabase(workspace.dbFile, { rows: [] });
    const { samples, warnings, stats } = await collect(workspace.dbFile, workspace.source);
    assert.equal(stats.rowsScanned, 0);
    assert.equal(samples.length, 0);
    assert.deepEqual(warnings, []);
  } finally {
    workspace.cleanup();
  }
});
