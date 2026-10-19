/**
 * M0.4 OpenCode 有界字段与版本证据测试。
 *
 * 夹具全部是**临时构造的 SQLite 库**（系统临时目录），不读取、不引用任何真实来源数据，
 * 因此本文件不含任何本机行数 / 版本分布断言；v1(legacy) 与版本未知两档只能在夹具里造。
 *
 * 探测一律经冻结外壳 `runPerfProbe(argv, { outputRoot })` 驱动（真实 CLI 的输出守卫只认
 * 仓库的 docs/validation，临时目录必须传导出函数的根）；跨进程 import 用 `pathToFileURL()`，
 * 非零退出仍要取 stdout 所以用 `spawnSync`。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  classifyVersionMajor,
  computeSourceFingerprint,
  fingerprintDigest,
  selectBoundedFiles,
  sessionVersionMajor,
} from "../scripts/perf-probe-sources/opencode.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROBE_SCRIPT = path.join(REPO_ROOT, "scripts", "perf-probe.mjs");
const BODY_SENTINEL = "BODY_SENTINEL_MUST_NOT_LEAK_7f3ac1";
const FULL_MESSAGE_SCHEMA =
  "id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT";
const FULL_SESSION_SCHEMA = "id TEXT PRIMARY KEY, directory TEXT, title TEXT, version TEXT";
const BASE_CREATED = 1_700_000_000_000;

/** 建一个"家目录"夹具：OpenCode 数据目录 + 本次 run 的输出目录都在系统临时目录内。 */
function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "perf-probe-opencode-"));
  const home = path.join(root, "home");
  const dataDir = path.join(home, ".local", "share", "opencode");
  mkdirSync(dataDir, { recursive: true });
  const runDir = path.join(root, "2026-10-04-perf-metrics", "run");
  mkdirSync(runDir, { recursive: true });
  const handles = [];
  return {
    root,
    home,
    dataDir,
    runDir,
    track: (database) => {
      handles.push(database);
      return database;
    },
    cleanup: () => {
      for (const database of handles) {
        try {
          database.close();
        } catch {
          // 已关闭的句柄忽略。
        }
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

function createDatabase(
  filePath,
  {
    sessions = [],
    messages = [],
    messageSchema = FULL_MESSAGE_SCHEMA,
    sessionSchema = FULL_SESSION_SCHEMA,
    journalMode = null,
  } = {},
) {
  const database = new DatabaseSync(filePath);
  try {
    if (journalMode) database.exec(`PRAGMA journal_mode = ${journalMode}`);
    database.exec(`CREATE TABLE session_message (${messageSchema})`);
    database.exec(`CREATE TABLE session_v2 (${sessionSchema})`);
    const insertSession = database.prepare("INSERT INTO session_v2 (id, version) VALUES (?, ?)");
    for (const session of sessions) insertSession.run(session.id, session.version ?? null);
    if (messages.length > 0) {
      // 只有真的要插行时才 prepare：schema 缺列夹具（如缺 data）会在这里被 SQLite 拒绝，
      // 早先无条件 prepare 会让夹具在 on-disk 句柄未关闭时就抛错。
      const insertMessage = database.prepare(
        "INSERT INTO session_message (id, session_id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)",
      );
      messages.forEach((message, index) => {
        insertMessage.run(
          message.id,
          message.sessionId,
          message.type ?? "assistant",
          message.seq ?? index + 1,
          message.timeCreated ?? BASE_CREATED,
          message.data === undefined ? null : message.data,
        );
      });
    }
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}

/** 造一条 `session_message.data`；正文里始终带哨兵，用于证明产物不含正文。 */
function assistantData({
  created = BASE_CREATED,
  completed = created + 1_500,
  output = 10,
  reasoning = 2,
  model = "fixture-model",
  provider = "fixture-provider",
  agent = "build",
  finish = "stop",
  includeCompleted = true,
  includeTokens = true,
  includeStreamed = false,
  error = undefined,
  content = BODY_SENTINEL,
} = {}) {
  const time = includeStreamed
    ? { created, completed, streamed: created + 300 }
    : includeCompleted
      ? { created, completed }
      : { created };
  const data = {
    time,
    model: { id: model, providerID: provider, variant: "default" },
    agent,
    finish,
    content: [{ type: "text", text: content }],
  };
  if (includeTokens) data.tokens = { input: 3, output, reasoning, cache: { read: 0, write: 0 } };
  if (error !== undefined) data.error = error;
  return JSON.stringify(data);
}

/** 经冻结外壳驱动一次 opencode 探测；注入临时输出根与临时家目录。 */
function runProbe(fixture, extraArgv = []) {
  const driver = path.join(fixture.root, "drive.mjs");
  const code = [
    `import { runPerfProbe } from ${JSON.stringify(pathToFileURL(PROBE_SCRIPT).href)};`,
    `process.exitCode = await runPerfProbe(${JSON.stringify([
      "--source",
      "opencode",
      "--output",
      fixture.runDir,
      ...extraArgv,
    ])}, { outputRoot: ${JSON.stringify(fixture.root)} });`,
  ].join("\n");
  writeFileSync(driver, `${code}\n`, "utf8");
  const result = spawnSync(process.execPath, [driver], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: fixture.home,
      USERPROFILE: fixture.home,
      APPDATA: path.join(fixture.root, "appdata"),
      LOCALAPPDATA: path.join(fixture.root, "localappdata"),
      CODEX_USAGE_OPENCODE: "1",
      CODEX_USAGE_OPENCODE_HOMES: "",
    },
  });
  if (result.error) throw result.error;
  const stdout = `${String(result.stdout || "")}${String(result.stderr || "")}`;
  const envelope = JSON.parse(readFileSync(path.join(fixture.runDir, "opencode-probe.json"), "utf8"));
  return { exitCode: result.status ?? 1, stdout, envelope, raw: JSON.stringify(envelope) };
}

function assertHealthyShellResult({ exitCode, envelope, raw }) {
  assert.equal(exitCode, 0);
  assert.equal(envelope.status, "ok");
  assert.equal(envelope.source, "opencode");
  // 空数组 = 没有任何来源键被外壳白名单拒绝：键名与值都合规。
  assert.deepEqual(envelope.fieldRejections, []);
  assert.equal(raw.includes(BODY_SENTINEL), false, "产物不得包含正文哨兵");
  assert.equal(envelope.fields.contentAccessed, false);
  assert.equal(envelope.fields.streamAccessed, false);
  assert.equal(envelope.fields.ttftAccessed, false);
}

function assertCountIdentities(scanned) {
  assert.equal(scanned.eligible, scanned.sampled + scanned.dropped + scanned.pending);
  assert.ok(scanned.sampled <= scanned.completeTimedPositiveOutput);
  assert.ok(scanned.completeTimedPositiveOutput <= scanned.timedPositiveOutput);
  assert.ok(scanned.timedPositiveOutput <= scanned.positiveOutput);
  assert.ok(scanned.positiveOutput <= scanned.eligible);
}

// ------------------------------------------------------------------ 三档版本与真 0 / 缺失

test("v2 fixture：窄投影只认 v2，真 0 与缺 fields 分开计数，坏 JSON 单独计数", () => {
  const fixture = makeFixture();
  try {
    createDatabase(path.join(fixture.dataDir, "opencode.db"), {
      sessions: [{ id: "s-v2", version: "2.0.20" }],
      messages: [
        {
          id: "m-normal",
          sessionId: "s-v2",
          data: assistantData({ includeStreamed: true, completed: BASE_CREATED + 1500 }),
        },
        { id: "m-zero", sessionId: "s-v2", data: assistantData({ output: 0, reasoning: 0 }) },
        { id: "m-no-tokens", sessionId: "s-v2", data: assistantData({ includeTokens: false }) },
        { id: "m-no-completed", sessionId: "s-v2", data: assistantData({ includeCompleted: false }) },
        { id: "m-bad-json", sessionId: "s-v2", data: `{ "content": "${BODY_SENTINEL}"` },
        { id: "m-error", sessionId: "s-v2", data: assistantData({ finish: "error", error: { name: "FixtureError" } }) },
      ],
    }).close();

    const result = runProbe(fixture, ["--max-rows", "50"]);
    assertHealthyShellResult(result);
    const { scanned, fields, decisions, warnings } = result.envelope;

    assert.equal(fields.versionGuard, "supported");
    assert.equal(fields.sessionV2Version, "major_2");
    assert.equal(fields.tokenScope, "visible_plus_reasoning");
    assert.equal(fields.windowKind, "message");
    assert.equal(fields.agentKind, "unknown");
    assert.equal(fields.agentRoleProven, false);
    assert.equal(fields.reasoningRelation, "parallel_additive");
    assert.equal(fields.reasoningSeparate, true);
    assert.equal(fields.readOnlyStrategy, "database_sync_readonly");
    assert.equal(fields.streamedDenominatorUsed, false);
    assert.equal(fields.writableFallbackUsed, false);

    assert.equal(scanned.files, 1);
    assert.equal(scanned.filesDiscovered, 1);
    assert.equal(scanned.filesScanned, 1);
    assert.equal(scanned.rowsScanned, 6);
    assert.equal(scanned.supportedVersions, 5);
    assert.equal(scanned.legacyVersions, 0);
    assert.equal(scanned.unknownVersions, 0);
    assert.equal(scanned.badJsonRows, 1);
    assert.equal(scanned.malformedJsonCount, 1);
    assert.equal(decisions.warningCounts.MALFORMED_JSON, 1);

    // 真 0 与缺字段是两件事。
    assert.equal(scanned.outputZeroCount, 1);
    assert.equal(scanned.reasoningZeroCount, 1);
    assert.equal(scanned.outputMissingCount, 1);
    assert.equal(scanned.reasoningMissingCount, 1);
    assert.equal(scanned.missingTokens, 1);
    assert.equal(scanned.missingCompleted, 1);

    assert.equal(scanned.errorRows, 1);
    assert.equal(scanned.statusErrorCount, 1);
    assert.equal(scanned.streamedRows, 1);
    assert.equal(decisions.flagCounts.OUTPUT_ZERO, 1);
    assert.equal(decisions.flagCounts.MISSING_OUTPUT, 1);
    assert.equal(decisions.flagCounts.MISSING_DURATION, 1);
    assert.equal(decisions.flagCounts.SOURCE_FILTERED, 1);
    assert.equal(scanned.eligible, 5);
    assert.equal(scanned.sampled, 1);
    assert.equal(scanned.pending, 0);
    assert.equal(scanned.dropped, 4);
    assertCountIdentities(scanned);
    assert.equal(fields.identityScheme, "message_id");
    assert.equal(fields.databaseIdentityKind, "path");
    assert.equal(decisions.identityUnique, true);
    assert.equal(decisions.readOnlyEnforced, true);
    assert.equal(decisions.liveSourceChanged, false);
    assert.ok(result.envelope.sourceFingerprintBefore?.contentFingerprint);
    assert.ok(result.envelope.sourceFingerprintAfter?.contentFingerprint);
    assert.ok(warnings.some((entry) => entry.code === "MALFORMED_JSON"));
  } finally {
    fixture.cleanup();
  }
});

test("v1 fixture：legacy 档排除并留下候选告警，不产生 eligible", () => {
  const fixture = makeFixture();
  try {
    createDatabase(path.join(fixture.dataDir, "opencode.db"), {
      sessions: [{ id: "s-v1", version: "1.9.0" }],
      messages: [
        { id: "l-1", sessionId: "s-v1", data: assistantData() },
        { id: "l-2", sessionId: "s-v1", data: assistantData() },
        { id: "l-3", sessionId: "s-v1", data: assistantData() },
      ],
    }).close();

    const result = runProbe(fixture, ["--max-rows", "50"]);
    assertHealthyShellResult(result);
    const { scanned, fields, decisions, warnings } = result.envelope;

    assert.equal(fields.versionGuard, "legacy");
    assert.equal(fields.sessionV2Version, "major_1");
    assert.equal(fields.unsupportedVersionPolicy, "pass_with_warning");
    assert.equal(scanned.legacyVersions, 3);
    assert.equal(scanned.supportedVersions, 0);
    assert.equal(scanned.unknownVersions, 0);
    assert.equal(scanned.unsupportedVersionCount, 3);
    assert.equal(scanned.eligible, 0);
    assert.equal(scanned.sampled, 0);
    assert.equal(scanned.dropped, 0);
    assert.equal(scanned.pending, 0);
    assert.equal(decisions.flagCounts.SOURCE_FILTERED, 3);
    // 候选来源告警必须可见；协议内没有专用版本码，本卡用 UNSUPPORTED_SCHEMA 承载。
    assert.equal(decisions.warningCounts.UNSUPPORTED_SCHEMA, 1);
    assert.ok(warnings.some((entry) => entry.code === "UNSUPPORTED_SCHEMA"));
    assertCountIdentities(scanned);
  } finally {
    fixture.cleanup();
  }
});

test("版本未知 fixture：沿用放行 + 告警策略，候选仍可统计", () => {
  const fixture = makeFixture();
  try {
    createDatabase(path.join(fixture.dataDir, "opencode.db"), {
      sessions: [{ id: "s-unknown", version: null }],
      messages: [
        { id: "u-1", sessionId: "s-unknown", data: assistantData() },
        { id: "u-2", sessionId: "s-unknown", data: assistantData() },
      ],
    }).close();

    const result = runProbe(fixture, ["--max-rows", "50"]);
    assertHealthyShellResult(result);
    const { scanned, fields, decisions } = result.envelope;

    assert.equal(fields.versionGuard, "unknown");
    assert.equal(fields.sessionV2Version, "unknown");
    assert.equal(scanned.unknownVersions, 2);
    assert.equal(scanned.supportedVersions, 0);
    assert.equal(scanned.legacyVersions, 0);
    assert.equal(scanned.eligible, 2);
    assert.equal(scanned.sampled, 2);
    assert.equal(decisions.warningCounts.UNSUPPORTED_SCHEMA, 1);
    assertCountIdentities(scanned);
  } finally {
    fixture.cleanup();
  }
});

// ------------------------------------------------------------------ schema / 只读失败

test("缺 schema 列：逐列存在性上报 absent，不伪造 0 样本", () => {
  const fixture = makeFixture();
  try {
    createDatabase(path.join(fixture.dataDir, "opencode.db"), {
      messageSchema: "id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER",
      sessions: [],
      messages: [],
    }).close();

    const result = runProbe(fixture, ["--max-rows", "50"]);
    assertHealthyShellResult(result);
    const { scanned, fields, decisions } = result.envelope;

    assert.equal(fields.columns.data, "absent");
    assert.equal(fields.columns.message_id, "present");
    assert.equal(fields.requiredColumns.data, "absent");
    assert.equal(fields.requiredColumns.session_message, "present");
    assert.equal(fields.allColumnsPresent, false);
    assert.equal(fields.columnStates.absent, 1);
    assert.equal(scanned.files, 1);
    assert.equal(scanned.rowsScanned, 0);
    assert.equal(scanned.errors, 1);
    assert.equal(decisions.warningCounts.UNSUPPORTED_SCHEMA, 1);
    assert.equal(decisions.readOnlyEnforced, true);
    assert.equal(scanned.eligible, 0);
    assertCountIdentities(scanned);
  } finally {
    fixture.cleanup();
  }
});

test("只读打开失败：记录 READ_ONLY_OPEN_FAILED，不回退可写，且继续扫描其他库", () => {
  const fixture = makeFixture();
  try {
    writeFileSync(path.join(fixture.dataDir, "opencode-broken.db"), "not a sqlite database\n".repeat(16), "utf8");
    createDatabase(path.join(fixture.dataDir, "opencode-ok.db"), {
      sessions: [{ id: "s-ok", version: "2.0.6" }],
      messages: [{ id: "ok-1", sessionId: "s-ok", data: assistantData() }],
    }).close();

    const result = runProbe(fixture, ["--max-rows", "50"]);
    assertHealthyShellResult(result);
    const { scanned, fields, decisions, warnings } = result.envelope;

    assert.equal(decisions.warningCounts.READ_ONLY_OPEN_FAILED, 1);
    assert.equal(decisions.readOnlyEnforced, false);
    assert.equal(scanned.readOnly, true);
    assert.equal(fields.writableFallbackUsed, false);
    assert.equal(fields.readOnly, true);
    assert.equal(scanned.errors, 1);
    assert.equal(scanned.filesScanned, 2);
    assert.equal(scanned.sqliteCandidateCount, 1);
    assert.equal(scanned.sampled, 1);
    assert.ok(warnings.some((entry) => entry.code === "READ_ONLY_OPEN_FAILED"));
    assertCountIdentities(scanned);
  } finally {
    fixture.cleanup();
  }
});

test("无来源文件：files=0 必须带 NO_SOURCE_FILES 原因，仍写出结果", () => {
  const fixture = makeFixture();
  try {
    const result = runProbe(fixture, ["--max-rows", "50"]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.envelope.status, "ok");
    assert.deepEqual(result.envelope.fieldRejections, []);
    assert.equal(result.envelope.scanned.files, 0);
    assert.equal(result.envelope.scanned.rowsScanned, 0);
    assert.ok(result.envelope.warnings.some((entry) => entry.code === "NO_SOURCE_FILES"));
  } finally {
    fixture.cleanup();
  }
});

// ------------------------------------------------------------------ 身份 / 有界 / WAL

test("身份用 message.id：重复 id 记为冲突，不靠全局 seq", () => {
  const fixture = makeFixture();
  try {
    createDatabase(path.join(fixture.dataDir, "opencode.db"), {
      messageSchema:
        "id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT",
      sessions: [{ id: "s-dup", version: "2.0.19" }],
      messages: [
        { id: "same-id", sessionId: "s-dup", seq: 1, data: assistantData({ output: 10 }) },
        { id: "same-id", sessionId: "s-dup", seq: 2, data: assistantData({ output: 99 }) },
      ],
    }).close();

    const result = runProbe(fixture, ["--max-rows", "50"]);
    assertHealthyShellResult(result);
    const { scanned, decisions } = result.envelope;
    assert.equal(decisions.identityUnique, false);
    assert.equal(scanned.identityDuplicateCount, 1);
    assert.equal(scanned.identityDuplicateGroupCount, 1);
    assert.equal(scanned.uniqueIdentities, 1);
    assert.equal(scanned.consistentDuplicateCount, 0);
    assert.equal(decisions.flagCounts.RECORD_CONFLICT, 1);
    assertCountIdentities(scanned);
  } finally {
    fixture.cleanup();
  }
});

test("有界取样：--max-files 取首尾文件；--full 时已发现文件全部扫描且计数自洽", () => {
  const fixture = makeFixture();
  try {
    for (const name of ["a", "b", "c", "d"]) {
      createDatabase(path.join(fixture.dataDir, `opencode-${name}.db`), {
        sessions: [{ id: `s-${name}`, version: "2.0.20" }],
        messages: [{ id: `${name}-1`, sessionId: `s-${name}`, data: assistantData() }],
      }).close();
    }

    const bounded = runProbe(fixture, ["--max-files", "3", "--max-rows", "50"]);
    assertHealthyShellResult(bounded);
    assert.equal(bounded.envelope.scanned.files, 4);
    assert.equal(bounded.envelope.scanned.filesDiscovered, 4);
    assert.equal(bounded.envelope.scanned.filesScanned, 3);
    assert.equal(bounded.envelope.scanned.bounded, true);
    assert.equal(bounded.envelope.scanned.complete, false);
    assertCountIdentities(bounded.envelope.scanned);

    const full = runProbe(fixture, ["--full"]);
    assertHealthyShellResult(full);
    assert.equal(full.envelope.scanned.files, 4);
    assert.equal(full.envelope.scanned.filesDiscovered, 4);
    assert.equal(full.envelope.scanned.filesScanned, 4);
    assert.equal(full.envelope.scanned.complete, true);
    assert.equal(full.envelope.scanned.bounded, false);
    assert.equal(full.envelope.decisions.filesScanned, 4);
    assert.equal(full.envelope.decisions.filesDiscovered, 4);
    assertCountIdentities(full.envelope.scanned);
  } finally {
    fixture.cleanup();
  }
});

test("WAL 在场：指纹覆盖主库与 WAL，前后一致则 liveSourceChanged=false", () => {
  const fixture = makeFixture();
  try {
    const handle = createDatabase(path.join(fixture.dataDir, "opencode.db"), {
      journalMode: "WAL",
      sessions: [{ id: "s-wal", version: "2.0.20" }],
      messages: [{ id: "w-1", sessionId: "s-wal", data: assistantData() }],
    });
    fixture.track(handle);

    const result = runProbe(fixture, ["--max-rows", "50"]);
    assertHealthyShellResult(result);
    assert.equal(result.envelope.scanned.walPresent, true);
    assert.equal(result.envelope.decisions.walPresent, true);
    assert.equal(result.envelope.fields.sourceChangedDuringScan, false);
    assert.equal(
      fingerprintDigest(result.envelope.sourceFingerprintBefore),
      fingerprintDigest(result.envelope.sourceFingerprintAfter),
    );
    assert.deepEqual(Object.keys(result.envelope.sourceFingerprintBefore).sort(), [
      "checkedAt",
      "contentFingerprint",
      "fileCount",
      "fingerprint",
      "homeCount",
    ]);
  } finally {
    fixture.cleanup();
  }
});

// ------------------------------------------------------------------ 纯函数

test("版本解析按语义版本字符串取主版本，不做数字比较", () => {
  assert.equal(sessionVersionMajor("2.0.19"), 2);
  assert.equal(sessionVersionMajor("2.0.6"), 2);
  assert.equal(sessionVersionMajor("1.9.0"), 1);
  assert.equal(sessionVersionMajor("0.4"), 0);
  assert.equal(sessionVersionMajor(""), null);
  assert.equal(sessionVersionMajor(null), null);
  assert.equal(sessionVersionMajor("vNext"), null);
  assert.equal(classifyVersionMajor(2), "supported");
  assert.equal(classifyVersionMajor(3), "supported");
  assert.equal(classifyVersionMajor(1), "legacy");
  assert.equal(classifyVersionMajor(null), "unknown");
});

test("首尾文件取样在文件数超过上限时取头尾", () => {
  const files = ["a", "b", "c", "d", "e", "f"].map((name) => ({ filePath: name }));
  assert.deepEqual(
    selectBoundedFiles(files, 3).map((entry) => entry.filePath),
    ["a", "b", "f"],
  );
  assert.deepEqual(
    selectBoundedFiles(files, 1).map((entry) => entry.filePath),
    ["a"],
  );
  assert.equal(selectBoundedFiles(files, 6).length, 6);
  assert.equal(selectBoundedFiles(files, 99).length, 6);
  assert.equal(selectBoundedFiles(files, 0).length, 6);
});

test("源指纹：主库/WAL 任意变化都会改变摘要并触发 liveSourceChanged 判据", () => {
  const fixture = makeFixture();
  try {
    const dbFile = path.join(fixture.dataDir, "opencode.db");
    createDatabase(dbFile, {
      sessions: [{ id: "s-fp", version: "2.0.20" }],
      messages: [{ id: "f-1", sessionId: "s-fp", data: assistantData() }],
    }).close();
    const entries = [{ filePath: dbFile }];

    const before = computeSourceFingerprint(entries, 1);
    const again = computeSourceFingerprint(entries, 1);
    assert.equal(before.fingerprint.contentFingerprint, again.fingerprint.contentFingerprint);
    assert.equal(before.fingerprint.fileCount, 1);
    assert.equal(before.fingerprint.homeCount, 1);
    assert.match(before.fingerprint.contentFingerprint, /^[0-9a-f]{64}$/);

    // 只动 WAL：主库不变，指纹仍必须变化。
    writeFileSync(`${dbFile}-wal`, "wal-change", "utf8");
    const afterWal = computeSourceFingerprint(entries, 1);
    assert.equal(afterWal.walPresent, true);
    assert.notEqual(before.fingerprint.contentFingerprint, afterWal.fingerprint.contentFingerprint);
    assert.notEqual(fingerprintDigest(before.fingerprint), fingerprintDigest(afterWal.fingerprint));
    assert.match(String(fingerprintDigest(afterWal.fingerprint)), /^[0-9a-f]{64}$/);
    assert.equal(fingerprintDigest(null), null);
  } finally {
    fixture.cleanup();
  }
});
