/**
 * M4.1：内存报告的 perf 候选载体（`buildUsageReport().perfSamples / .perfMeta`）
 *
 * ---------------------------------------------------------------------------
 * 本文件验收卡片 `M4-summary-and-api.md:7,9` 的六条硬约束：
 *   ① 与用量事件同一份 `homes`、沿用既有发现逻辑（**不发明新 home**）；
 *   ② dispatcher enables ZCode, DSH, OpenCode, and Codex thread aggregation;
 *   ③ 某 home 报错**只**标该 home degraded，**其他来源继续**；
 *   ④ `report.events` 与旧字段**不变**（用"清空 reader 注册表的对照报告"逐字段比对）；
 *   ⑤ 读取前后指纹相同才当 `indexVersion`；不同 ⇒ `degraded` + `LIVE_SOURCE_CHANGED`；
 *   ⑥ `perfSamples.sourcePath` 只用于归属（**只读 reader，不带正文/工具内容**）。
 *
 * ⚠️ 夹具手法说明（可达性，不是被测逻辑的性质）：
 *  - 本文件**直接给 `options.homes`**（不依赖 discovery），以精确控制不同来源 home 的并存。
 *  - `perfSamples` 的 `sourcePath` 必须是**物理文件路径**：M4.2 的跨路径 parity 依赖它与
 *    SQLite 路径的 `perf_samples.source_path` 逐字一致（`source.path` 对多文件来源是**目录**）。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import test from "node:test";

import { PERF_METHOD_VERSION, perfFlagNamesOf } from "../src/perf-stats.js";
import { encodeCodexPublicationPolicy } from "../src/perf-sources/codex-thread.js";
import { PERF_SOURCE_READERS, streamPerfSamplesForFile } from "../src/perf-sources/index.js";
import { streamZcodePerfSamples, ZCODE_SELECT_COLUMNS } from "../src/perf-sources/zcode.js";
import { buildUsageReport, discoverUsageSources, perfStatsRangeBounds, summarizeUsage } from "../src/usage-core.js";
import { PERF_SAMPLE_FIELDS, UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture, createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

const BASE = 1_700_000_000_000;
/** M4.2：两路径共用同一个 `now`（否则 `asOf` 不同会让范围/比较段不可比）。 */
const FIXED_NOW = new Date(BASE + 3_600_000).toISOString();
const ROW_FIELDS = [...ZCODE_SELECT_COLUMNS];

/**
 * 建一个 ZCode 物理库（`<home>/cli/db/db.sqlite`，与 M3.2 夹具同形）。
 * @param {string} root
 * @param {string} id
 */
function makeZcodeDb(root, id, { rows = 3, keepWalOpen = false, spacingMs = 1000, baseMs = BASE } = {}) {
  const homeDir = path.join(root, id);
  const dbDir = path.join(homeDir, "cli", "db");
  mkdirSync(dbDir, { recursive: true });
  const dbFile = path.join(dbDir, "db.sqlite");
  const db = new DatabaseSync(dbFile);
  // ⚠️ 必须**先**设 WAL 再建表/插入，并**保持连接打开**：SQLite 在**最后一个连接关闭**时
  //    会 checkpoint 并把 `-wal` 删掉 ⇒ 想测"仅 -wal 变化"就必须留一个句柄（M3.4 实测确认）。
  if (keepWalOpen) db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE "model_usage" (${ROW_FIELDS.map((c) => `"${c}"`).join(", ")})`);
  const insert = db.prepare(
    `INSERT INTO "model_usage" (${ROW_FIELDS.map((c) => `"${c}"`).join(", ")}) VALUES (${ROW_FIELDS.map(() => "?").join(", ")})`,
  );
  for (let i = 0; i < rows; i += 1) insertZcodeRow(insert, id, i, { spacingMs, baseMs });
  // ⚠️ 显式传 `options.homes` 时**没有 discovery 来补** `usageLogPath`；而
  //    `buildUsageReport`/`buildUsageFingerprint` 的 zcode 分支都**只看** `home.usageLogPath`
  //    （不设 ⇒ 该 home 既不出候选、指纹也走错分支）。这是夹具可达性要求。
  const home = { id, path: homeDir, dbFile, kind: "zcode", label: `ZCode ${id}`, usageLogPath: dbFile };
  if (keepWalOpen) {
    // 返回**未关闭**的句柄，由用例负责关闭（从而把 `-wal` 留住）。
    return { ...home, walHandle: db };
  }
  db.close();
  return home;
}

/** 插入一行（`i` 决定时间戳/输出量）。`spacingMs` 用于把行铺到不同的 UTC 日。 */
function insertZcodeRow(insert, id, i, { output = null, spacingMs = 1000, baseMs = BASE } = {}) {
  const row = {
    id: `${id}-row-${i}`,
    session_id: `${id}-session`,
    status: "completed",
    started_at: baseMs + i * spacingMs,
    completed_at: baseMs + i * spacingMs + 500,
    duration_ms: 500,
    input_tokens: 10,
    output_tokens: output === null ? 100 + i : output,
    model_id: "fixture-model",
    provider_id: "fixture-provider",
  };
  insert.run(...ROW_FIELDS.map((c) => (Object.hasOwn(row, c) ? row[c] : null)));
}

/** 往已有库追加一行（制造"读取期间上游变化"）。 */
function appendZcodeRow(dbFile, id, i, options) {
  const db = new DatabaseSync(dbFile);
  try {
    insertZcodeRow(
      db.prepare(
        `INSERT INTO "model_usage" (${ROW_FIELDS.map((c) => `"${c}"`).join(", ")}) VALUES (${ROW_FIELDS.map(() => "?").join(", ")})`,
      ),
      id,
      i,
      options,
    );
  } finally {
    db.close();
  }
}

/** 一个 Codex home（`kind: "main"` ⇒ 规范 kind `codex`）。 */
function makeCodexHome(root, id, { rollouts = 0 } = {}) {
  const homeDir = path.join(root, id);
  const sessionsDir = path.join(homeDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  /** @type {string[]} */
  const files = [];
  for (let i = 0; i < rollouts; i += 1) {
    const file = path.join(sessionsDir, `rollout-${i}.jsonl`);
    writeFileSync(file, `${JSON.stringify(codexRolloutLine(`c-${i}`))}\n`);
    files.push(file);
  }
  return { id, label: `Codex ${id}`, path: homeDir, kind: "main", files };
}

/** 一行最小可用的 Codex rollout 记录（`sessions/` 是 `SESSION_DIRS` 之一 ⇒ 计入用量全局指纹）。 */
function codexRolloutLine(sessionId, at = BASE) {
  return { type: "session_meta", timestamp: new Date(at).toISOString(), payload: { id: sessionId } };
}

/** 把 mtime **钉到整秒**（消除亚秒抖动；"同尺寸 + 同 mtime 原地改写"必须能被检出）。 */
function pinMtime(file, ms) {
  utimesSync(file, new Date(ms), new Date(ms));
}

/** 原地 UPDATE 一行输出量 —— **不改变文件长度**（同尺寸改写的前提）。 */
function updateZcodeOutput(dbFile, rowId, output) {
  const db = new DatabaseSync(dbFile);
  try {
    db.prepare('UPDATE "model_usage" SET "output_tokens" = ? WHERE "id" = ?').run(output, rowId);
  } finally {
    db.close();
  }
}

/** 经**已打开的 WAL 句柄**追加一行（写进 `-wal`，主库字节不变）。 */
function insertZcodeRowViaHandle(handle, id, i, { output = 999 } = {}) {
  const insert = handle.prepare(
    `INSERT INTO "model_usage" (${ROW_FIELDS.map((c) => `"${c}"`).join(", ")}) VALUES (${ROW_FIELDS.map(() => "?").join(", ")})`,
  );
  insertZcodeRow(insert, id, i, { output });
}

/** 往 Codex rollout **追加**一行，使单文件的 session_meta 身份冲突。 */
function appendCodexRollout(file, sessionId, at = BASE + 60_000) {
  appendFileSync(file, `${JSON.stringify(codexRolloutLine(sessionId, at))}\n`);
}

/** 一个 `project-log` home（**结构上不支持**性能观测的终态）。 */
function makeProjectLogHome(root, id) {
  const homeDir = path.join(root, id);
  mkdirSync(homeDir, { recursive: true });
  return {
    id,
    label: `Project ${id}`,
    path: homeDir,
    kind: "project-log",
    usageLogPath: path.join(homeDir, "usage.jsonl"),
  };
}

/** 旧字段（M4.1 之前 `buildUsageReport` 的全部出口键），顺序无关。 */
const LEGACY_REPORT_KEYS = ["events", "generatedAt", "homes", "rateLimitObservations", "sessions", "warnings"];

// ---------------------------------------------------------------------------
// ★M4.1-a 载体形状：Codex 无可统计轮时不伪造候选，且来源仍正确分类
// ---------------------------------------------------------------------------

test("★M4.1-a 内存载体：无候选的 Codex home 不伪造样本，且 unsupported 来源单列", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m41-a-"));
  try {
    const homeA = makeZcodeDb(root, "zcode-A", { rows: 3 });
    const homeB = makeCodexHome(root, "codex-B");
    const homeC = makeProjectLogHome(root, "proj-C");
    const homes = [homeA, homeB, homeC];

    const report = await buildUsageReport({ homes });
    const { perfSamples, perfMeta } = report;

    console.log(
      "  [实测] 样本数 =",
      perfSamples.length,
      " state =",
      perfMeta.state,
      " indexVersion =",
      perfMeta.indexVersion,
      " unsupported =",
      JSON.stringify(perfMeta.unsupportedSources),
    );

    // ① 出口形状：旧六个字段 + 恰好两个新字段（旧字段一个都没少、没改名）
    assert.deepEqual(
      Object.keys(report).sort(),
      [...LEGACY_REPORT_KEYS, "perfMeta", "perfSamples"].sort(),
      "UsageReport 只允许【新增】perfSamples/perfMeta",
    );
    for (const key of LEGACY_REPORT_KEYS) {
      assert.ok(Object.hasOwn(report, key), `旧字段 ${key} 必须仍在`);
    }

    // ② Codex rollout 只有 session_meta，没有完整候选；不能伪造 TPS=0 样本。
    assert.equal(perfSamples.length, 3, "ZCode 3 行 ⇒ 3 条候选");
    for (const sample of perfSamples) {
      assert.equal(sample.sourceKind, "zcode");
      assert.equal(sample.homeId, "zcode-A");
      // ③ 归属是**物理文件路径**（不是 home 目录、更不是正文）
      assert.equal(sample.sourcePath, homeA.dbFile, "sourcePath 必须是物理文件路径");
    }

    // ④ 元数据齐备
    assert.equal(perfMeta.state, "ready");
    assert.equal(perfMeta.ready, true);
    assert.equal(perfMeta.methodVersion, PERF_METHOD_VERSION);
    assert.match(String(perfMeta.indexVersion), /^[0-9a-f]{64}$/, "indexVersion 必须是 sha256 十六进制");
    assert.equal(perfMeta.indexedAt, new Date(perfMeta.indexedAt).toISOString(), "indexedAt 必须是 ISO 时间");
    assert.deepEqual(perfMeta.degradedHomeIds, [], "无失败 ⇒ 不得有退化 home");
    assert.deepEqual(perfMeta.sourceWarnings, [], "无失败 ⇒ 不得有源告警");
    assert.deepEqual(perfMeta.rankedHomeIds, ["zcode-A"], "默认排名集合 = 载体里出现过且未受阻的 home");

    // ⑤ 已启用 Codex 进入 knownSources；结构上不支持的 project-log 单列。
    assert.deepEqual(
      perfMeta.unsupportedSources,
      [{ kind: "unsupported", homeId: "proj-C" }],
      "只有结构上不支持的来源进入 unsupportedSources",
    );
    assert.deepEqual(
      perfMeta.knownSources,
      [
        { kind: "zcode", homeId: "zcode-A" },
        { kind: "codex", homeId: "codex-B" },
        { kind: "unsupported", homeId: "proj-C" },
      ],
      "knownSources 必须是 {kind,homeId}[]（AH-5），供 M4.2 直接传给 summarizePerf",
    );

    // ⑥ 样本里不得夹带正文/工具内容：只允许 M1 的归一化字段（31 键），且无长文本
    const sampleKeys = Object.keys(perfSamples[0]);
    assert.ok(sampleKeys.includes("sourcePath"), "sourcePath 是内部归属字段");
    assert.ok(
      sampleKeys.every((key) => typeof perfSamples[0][key] !== "string" || perfSamples[0][key].length < 200),
      "样本字段不得承载正文（无超长字符串）",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ★M4.1-b 单 home 失败：只退化该 home，其他来源继续，且不整报告失败
// ---------------------------------------------------------------------------

test("★M4.1-b 一个 home 读失败：只标该 home degraded，其他来源继续出候选", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m41-b-"));
  try {
    const good = makeZcodeDb(root, "zcode-good", { rows: 3 });
    const broken = makeZcodeDb(root, "zcode-broken", { rows: 1 });
    // 破坏物理库：仍是**已发现**的文件，但 reader 只读打开必然失败。
    writeFileSync(broken.dbFile, "this is not a sqlite database");

    const report = await buildUsageReport({ homes: [good, broken] });
    const { perfSamples, perfMeta } = report;
    console.log(
      "  [实测] 样本数 =",
      perfSamples.length,
      " state =",
      perfMeta.state,
      " degraded =",
      JSON.stringify(perfMeta.degradedHomeIds),
      " warnings =",
      JSON.stringify(perfMeta.sourceWarnings),
      " ranked =",
      JSON.stringify(perfMeta.rankedHomeIds),
    );

    assert.equal(perfMeta.state, "degraded", "有 home 读失败 ⇒ degraded");
    assert.equal(perfMeta.ready, false);
    assert.deepEqual(perfMeta.degradedHomeIds, ["zcode-broken"], "只标记失败的那个 home");
    // ⚠️ 语义分辨（本卡裁定）：**"读失败"与"上游在读取期间变动"是两件事** ——
    //   - 读失败 ⇒ `state=degraded` + 受阻 home（**完整性**受损，D4 排除其排名）；
    //   - 上游变动 ⇒ 版本**不可发布**（`indexVersion=null`，**provenance** 不可证）。
    //   本例上游**稳定**（前后指纹相同）⇒ 版本仍描述真实的上游快照，**照发**；
    //   与 M3.4 BC-2 一致（那里的版本也只描述**已成功发布**的数据，失败不使版本消失）。
    assert.match(
      String(perfMeta.indexVersion),
      /^[0-9a-f]{64}$/,
      "上游稳定 ⇒ 即使有 home 读失败也必须发布版本（版本描述上游快照，非完整性）",
    );
    // 告警只允许四要素，且用 reader 自带的冻结码
    assert.deepEqual(perfMeta.sourceWarnings, [
      { sourceKind: "zcode", homeId: "zcode-broken", code: "READ_ONLY_OPEN_FAILED", count: 1 },
    ]);
    for (const warning of perfMeta.sourceWarnings) {
      assert.deepEqual(Object.keys(warning).sort(), ["code", "count", "homeId", "sourceKind"]);
    }
    // 其他来源继续：好 home 的 3 条候选仍在
    assert.equal(perfSamples.length, 3, "坏 home 不得影响好 home 的候选");
    assert.ok(
      perfSamples.every((sample) => sample.homeId === "zcode-good"),
      "候选只能来自未受阻的 home",
    );
    const summary = summarizeUsage(report, { preset: "all", now: FIXED_NOW }).perf;
    assert.equal(summary.state, "degraded");
    assert.equal(summary.models.length, 1, "健康来源仍须保留模型速度行");
    assert.equal(summary.models[0].n, 3, "失败 home 的候选不得混入健康来源的速度行");
    assert.deepEqual(perfMeta.rankedHomeIds, ["zcode-good"], "受阻 home 必须排除出默认排名（D4）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ★M4.1-c 读取期间上游变化：degraded + LIVE_SOURCE_CHANGED，且**不得**把指纹当版本
// ---------------------------------------------------------------------------

test("★M4.1-c 读取期间追加：degraded + LIVE_SOURCE_CHANGED 且 indexVersion 必须为 null", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m41-c-"));
  const savedReaders = new Map(PERF_SOURCE_READERS);
  try {
    const homeA = makeZcodeDb(root, "zcode-A", { rows: 3 });

    // 手法：包装注册表里的 ZCode reader（`streamPerfSamplesForFile` 每次调用都查表）
    // ⇒ 在"前置指纹之后、reader 读取之前"真实追加一行。
    let injected = false;
    PERF_SOURCE_READERS.set("zcode", async (filePath, source, onSample, options) => {
      if (!injected) {
        injected = true;
        appendZcodeRow(homeA.dbFile, "sneaky", 9, { output: 777 });
      }
      return await streamZcodePerfSamples(filePath, source, onSample, options);
    });

    const report = await buildUsageReport({ homes: [homeA] });
    const { perfSamples, perfMeta } = report;
    console.log(
      "  [实测] 注入 =",
      injected,
      " 样本数 =",
      perfSamples.length,
      " state =",
      perfMeta.state,
      " indexVersion =",
      perfMeta.indexVersion,
      " warnings =",
      JSON.stringify(perfMeta.sourceWarnings),
    );

    assert.equal(injected, true, "前置：注入必须发生");
    assert.equal(perfMeta.state, "degraded", "读取期间上游变化 ⇒ degraded");
    assert.deepEqual(perfMeta.degradedHomeIds, ["zcode-A"]);
    assert.deepEqual(perfMeta.sourceWarnings, [
      { sourceKind: "zcode", homeId: "zcode-A", code: "LIVE_SOURCE_CHANGED", count: 1 },
    ]);
    // 卡片明文：指纹**不同**时不得把它当 indexVersion（元数据不得描述不了所载候选）
    assert.equal(perfMeta.indexVersion, null, "读取期间变化 ⇒ indexVersion 必须为 null");
    // 候选确实读到了 4 条（含注入行）—— 这正是"候选可能不完整/不可信"的体现，
    // 因此**不能**用一个"读后指纹"去给它背书。
    assert.equal(perfSamples.length, 4, "reader 读到 4 条（3 + 注入）");
  } finally {
    PERF_SOURCE_READERS.clear();
    for (const [key, value] of savedReaders) PERF_SOURCE_READERS.set(key, value);
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ★M4.1-d 旧字段不变 + 指纹确定性（同夹具两次构建完全一致）
// ---------------------------------------------------------------------------

test("★M4.1-d 载体不得改动旧字段；同夹具两次构建的指纹与候选完全一致", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m41-d-"));
  const savedReaders = new Map(PERF_SOURCE_READERS);
  try {
    const homeA = makeZcodeDb(root, "zcode-A", { rows: 3 });
    const homeB = makeCodexHome(root, "codex-B");
    const homes = [homeA, homeB];

    const withPerf = await buildUsageReport({ homes });
    const again = await buildUsageReport({ homes });

    // ① 确定性：同一份未变夹具 ⇒ 同一指纹、同样本（指纹不得含易变分量）
    assert.equal(again.perfMeta.indexVersion, withPerf.perfMeta.indexVersion, "未变化时指纹必须稳定");
    assert.equal(again.perfSamples.length, withPerf.perfSamples.length);
    // `indexedAt` 是**采集时刻**，两次调用必然不同 ⇒ 只比较其余字段（并单独锁 ISO 形状）。
    assert.deepEqual(
      { ...again.perfMeta, indexedAt: null },
      { ...withPerf.perfMeta, indexedAt: null },
      "除采集时刻外，元数据必须逐字段确定",
    );
    assert.equal(again.perfMeta.indexedAt, new Date(again.perfMeta.indexedAt).toISOString());

    // ② 旧字段不变：清空 reader 注册表（⇒ 该来源 not_enabled，一条候选都不产生）后，
    //    用量侧的 events/sessions/warnings 必须与开启载体时**逐字相同**。
    PERF_SOURCE_READERS.clear();
    const control = await buildUsageReport({ homes });
    assert.deepEqual(control.events, withPerf.events, "perf 载体不得改动 events");
    assert.deepEqual(control.sessions, withPerf.sessions, "perf 载体不得改动 sessions");
    assert.deepEqual(control.warnings, withPerf.warnings, "perf 载体不得改动 warnings");
    assert.deepEqual(control.rateLimitObservations, withPerf.rateLimitObservations);
    assert.deepEqual(control.homes, withPerf.homes);
    assert.equal(control.perfSamples.length, 0, "对照：来源未启用 ⇒ 不产生候选（不伪造 0）");
    assert.equal(control.perfMeta.state, "ready", "未启用来源不是失败 ⇒ 不退化（not_enabled ≠ degraded）");
  } finally {
    PERF_SOURCE_READERS.clear();
    for (const [key, value] of savedReaders) PERF_SOURCE_READERS.set(key, value);
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ★M4.1-e（返工1 · 复核 P2）内容指纹镜像必须与 M3 已发布映射同源 —— 防漂移对拍
// ---------------------------------------------------------------------------

test("★M4.1-e 内存版本必须由与 M3 同源的内容指纹构造（与 store 已发布映射对拍）", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m41-e-"));
  try {
    const homeA = makeZcodeDb(root, "zcode-A", { rows: 2 });
    pinMtime(homeA.dbFile, BASE);

    // ① 内存链路：版本 = 已启用来源内容指纹的两层聚合
    const report = await buildUsageReport({ homes: [homeA] });
    const memoryVersion = report.perfMeta.indexVersion;

    // ② 索引链路：同一个物理文件经 M3 的 `replaceFile` 发布出**权威**逐文件内容指纹
    const store = new UsageStore({ homeDir: root, databaseFile: path.join(root, "index.sqlite") });
    await store.open();
    let canonical;
    try {
      await store.sync({ options: { homeDir: root, importDirs: [homeA.path] } });
      const row = store.database.prepare("SELECT value FROM store_meta WHERE key = ?").get("perf_file_fingerprints");
      canonical = JSON.parse(String(row.value))[homeA.dbFile];
    } finally {
      store.close();
    }

    console.log("  [实测] M3 已发布逐文件指纹 =", canonical);
    console.log("  [实测] 内存 indexVersion =", memoryVersion);

    assert.match(
      String(canonical),
      /^\d+:\d+:[0-9a-f]{32}$/,
      "M3 的逐文件指纹串形 = size:mtimeMs:sha256(首尾 64KiB) 前 32 位",
    );
    // ③ **独立复算**（不复用被测实现）：按公开的"两层聚合"口径重算期望版本。
    //    若本地镜像与 M3 的算法出现任何漂移（探测宽度、`-wal` 折叠、摘要截断长度…），
    //    内存版本就不会等于这个期望值 ⇒ 本用例转红。
    const homeAggregate = createHash("sha256").update(`${homeA.dbFile}\t${canonical}\n`).digest("hex");
    const expected = createHash("sha256").update(`${homeA.id}\tzcode\t${homeAggregate}\n`).digest("hex");
    assert.equal(memoryVersion, expected, "内存版本必须由【与 M3 相同的逐文件内容指纹】构造 —— 镜像一旦漂移即转红");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ★M4.1-f（返工1 · 复核 P1）未启用来源变化**不得**被归因给稳定的已启用来源
// ---------------------------------------------------------------------------

test("★M7 Codex rollout 变成多 session_meta 时只阻断 Codex，稳定 ZCode 仍排名", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m41-f-"));
  const savedReaders = new Map(PERF_SOURCE_READERS);
  try {
    const homeZ = makeZcodeDb(root, "z", { rows: 1 });
    const homeC = makeCodexHome(root, "c", { rollouts: 1 });
    const rollout = homeC.files[0];

    let injected = false;
    PERF_SOURCE_READERS.set("zcode", async (filePath, source, onSample, options) => {
      const result = await streamZcodePerfSamples(filePath, source, onSample, options);
      if (!injected) {
        injected = true;
        // ZCode 读**完成之后**追加另一个 session_meta，使 Codex 线程身份变得含糊。
        appendCodexRollout(rollout, "c-extra");
      }
      return result;
    });

    const report = await buildUsageReport({ homes: [homeZ, homeC] });
    const { perfSamples, perfMeta } = report;
    console.log(
      "  [实测] 注入 =",
      injected,
      " 样本数 =",
      perfSamples.length,
      " state =",
      perfMeta.state,
      " degraded =",
      JSON.stringify(perfMeta.degradedHomeIds),
      " ranked =",
      JSON.stringify(perfMeta.rankedHomeIds),
      " usageStable =",
      perfMeta.usageFingerprintStable,
      " perfStable =",
      perfMeta.perfFingerprintStable,
    );

    assert.equal(injected, true, "前置：注入必须发生");
    assert.equal(perfSamples.length, 1, "坏 Codex home 不得吞掉 ZCode 候选");
    assert.equal(perfMeta.state, "degraded");
    assert.deepEqual(perfMeta.degradedHomeIds, ["c"], "只阻断有损坏证据的 Codex home");
    assert.ok(perfMeta.sourceWarnings.some((warning) => warning.homeId === "c"));
    assert.ok(!perfMeta.degradedHomeIds.includes("z"), "稳定 ZCode 不得被连坐");
    // 排名保留：正常 ZCode 继续进入默认集合。
    assert.deepEqual(perfMeta.rankedHomeIds, ["z"], "正常 ZCode 排名必须保留");
    // 两个指纹都检测到 Codex rollout 已变化，版本不能声称稳定。
    assert.equal(perfMeta.usageFingerprintStable, false, "用量全局指纹覆盖全部 homes ⇒ 确实变了");
    assert.equal(perfMeta.perfFingerprintStable, false, "启用后的 Codex 内容指纹已变化");
    assert.equal(perfMeta.indexVersion, null);
  } finally {
    PERF_SOURCE_READERS.clear();
    for (const [key, value] of savedReaders) PERF_SOURCE_READERS.set(key, value);
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ★M4.1-g（返工1 · 复核 P2）同尺寸 + 同 mtime 的原地改写必须被检出
// ---------------------------------------------------------------------------

test("★M4.1-g 同尺寸同 mtime 原地改写：必须检出、不得 ready、不得复用版本", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m41-g-"));
  const savedReaders = new Map(PERF_SOURCE_READERS);
  try {
    const homeA = makeZcodeDb(root, "zcode-A", { rows: 1 });
    pinMtime(homeA.dbFile, BASE);

    // 基线（干净读取：输出 100）—— 这是"旧内容"的版本号
    const baseline = await buildUsageReport({ homes: [homeA] });
    const v1 = baseline.perfMeta.indexVersion;
    assert.equal(baseline.perfMeta.state, "ready");
    assert.match(String(v1), /^[0-9a-f]{64}$/, "基线版本必须可发布");

    const statBefore = statSync(homeA.dbFile);

    let injected = false;
    PERF_SOURCE_READERS.set("zcode", async (filePath, source, onSample, options) => {
      const result = await streamZcodePerfSamples(filePath, source, onSample, options);
      if (!injected) {
        injected = true;
        // 复核探针同一手法：读**完成之后**把上游原地改写为 200，并把 mtime 钉回原值。
        updateZcodeOutput(homeA.dbFile, "zcode-A-row-0", 200);
        pinMtime(homeA.dbFile, BASE);
      }
      return result;
    });

    const live = await buildUsageReport({ homes: [homeA] });
    const statAfter = statSync(homeA.dbFile);
    console.log(
      "  [实测] sameSize =",
      statAfter.size === statBefore.size,
      " sameMtime =",
      statAfter.mtimeMs === statBefore.mtimeMs,
      " state =",
      live.perfMeta.state,
      " indexVersion =",
      live.perfMeta.indexVersion,
    );

    // 前提必须**实测**（不是假定）：尺寸与 mtime 完全相等
    assert.equal(statAfter.size, statBefore.size, "前提：UPDATE 不改变文件尺寸");
    assert.equal(statAfter.mtimeMs, statBefore.mtimeMs, "前提：mtime 已钉回原值");
    // 检出：不得 ready、不得复用版本（旧实现在这里 ready 且版本与 v1 相同）
    assert.equal(live.perfMeta.state, "degraded", "同尺寸同 mtime 的内容改写必须被检出");
    assert.deepEqual(live.perfMeta.degradedHomeIds, ["zcode-A"]);
    assert.deepEqual(live.perfMeta.sourceWarnings, [
      { sourceKind: "zcode", homeId: "zcode-A", code: "LIVE_SOURCE_CHANGED", count: 1 },
    ]);
    assert.equal(live.perfMeta.indexVersion, null, "内容变化 ⇒ 版本不可发布");
    assert.equal(live.perfMeta.perfFingerprintStable, false);

    // 恢复：稳定完整读取 ⇒ 版本必须与新内容对应（≠ 旧内容版本）且可复现
    PERF_SOURCE_READERS.clear();
    for (const [key, value] of savedReaders) PERF_SOURCE_READERS.set(key, value);
    const recovered = await buildUsageReport({ homes: [homeA] });
    const recoveredAgain = await buildUsageReport({ homes: [homeA] });
    console.log(
      "  [实测] recoveredOutput =",
      recovered.perfSamples[0].outputTokens,
      " v1 =",
      String(v1).slice(0, 12),
      " v3 =",
      String(recovered.perfMeta.indexVersion).slice(0, 12),
    );

    assert.equal(recovered.perfMeta.state, "ready", "稳定完整读取必须恢复 ready");
    assert.equal(recovered.perfSamples[0].outputTokens, 200, "恢复后读到的是**新**内容");
    assert.notEqual(recovered.perfMeta.indexVersion, v1, "版本必须随内容变化（旧实现复用同一版本号）");
    assert.match(String(recovered.perfMeta.indexVersion), /^[0-9a-f]{64}$/);
    assert.equal(recoveredAgain.perfMeta.indexVersion, recovered.perfMeta.indexVersion, "稳定读取的版本必须可复现");
  } finally {
    PERF_SOURCE_READERS.clear();
    for (const [key, value] of savedReaders) PERF_SOURCE_READERS.set(key, value);
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ★M4.1-h（返工1 · 复核 P1/P2）已启用与未启用来源**同时**变化：两个轴各自独立表达
// ---------------------------------------------------------------------------

test("★M7 Codex 与 ZCode 同时变化时分别归因，各自影响排名", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m41-h-"));
  const savedReaders = new Map(PERF_SOURCE_READERS);
  try {
    const homeZ = makeZcodeDb(root, "z", { rows: 1 });
    const homeC = makeCodexHome(root, "c", { rollouts: 1 });
    pinMtime(homeZ.dbFile, BASE);

    let injected = false;
    PERF_SOURCE_READERS.set("zcode", async (filePath, source, onSample, options) => {
      const result = await streamZcodePerfSamples(filePath, source, onSample, options);
      if (!injected) {
        injected = true;
        updateZcodeOutput(homeZ.dbFile, "z-row-0", 250); // 已启用来源：同尺寸原地改写
        pinMtime(homeZ.dbFile, BASE);
        appendCodexRollout(homeC.files[0], "c-extra"); // Codex 线程身份变含糊
      }
      return result;
    });

    const report = await buildUsageReport({ homes: [homeZ, homeC] });
    const { perfMeta } = report;
    console.log(
      "  [实测] state =",
      perfMeta.state,
      " degraded =",
      JSON.stringify(perfMeta.degradedHomeIds),
      " usageStable =",
      perfMeta.usageFingerprintStable,
      " perfStable =",
      perfMeta.perfFingerprintStable,
    );

    assert.equal(injected, true);
    // 两个来源各有自己的变化证据 ⇒ 都单独归因。
    assert.equal(perfMeta.state, "degraded");
    assert.deepEqual(perfMeta.degradedHomeIds, ["c", "z"]);
    assert.ok(
      perfMeta.sourceWarnings.some((warning) => warning.homeId === "z" && warning.code === "LIVE_SOURCE_CHANGED"),
    );
    assert.ok(perfMeta.sourceWarnings.some((warning) => warning.homeId === "c"));
    // 两个源的 live 变化使版本不可发布。
    assert.equal(perfMeta.usageFingerprintStable, false);
    assert.equal(perfMeta.perfFingerprintStable, false);
    assert.equal(perfMeta.indexVersion, null);
    assert.deepEqual(perfMeta.rankedHomeIds, [], "两个受阻 home 都排除出默认排名（D4）");
  } finally {
    PERF_SOURCE_READERS.clear();
    for (const [key, value] of savedReaders) PERF_SOURCE_READERS.set(key, value);
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ★M4.1-i（返工1 · 复核 P1）多 home 归因：稳定 / 变化 / 读失败三类各自精确归因
// ---------------------------------------------------------------------------

test("★M4.1-i 多 ZCode home：稳定者照常排名，变化者与读失败者各自归因", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m41-i-"));
  const savedReaders = new Map(PERF_SOURCE_READERS);
  try {
    const stable = makeZcodeDb(root, "z-stable", { rows: 2 });
    const changed = makeZcodeDb(root, "z-changed", { rows: 1 });
    const broken = makeZcodeDb(root, "z-broken", { rows: 1 });
    writeFileSync(broken.dbFile, "this is not a sqlite database");
    pinMtime(changed.dbFile, BASE);

    let injected = false;
    PERF_SOURCE_READERS.set("zcode", async (filePath, source, onSample, options) => {
      const result = await streamZcodePerfSamples(filePath, source, onSample, options);
      if (!injected && filePath === changed.dbFile) {
        injected = true;
        updateZcodeOutput(changed.dbFile, "z-changed-row-0", 321);
        pinMtime(changed.dbFile, BASE);
      }
      return result;
    });

    const report = await buildUsageReport({ homes: [stable, changed, broken] });
    const { perfSamples, perfMeta } = report;
    console.log(
      "  [实测] 样本 =",
      perfSamples.length,
      " degraded =",
      JSON.stringify(perfMeta.degradedHomeIds),
      " ranked =",
      JSON.stringify(perfMeta.rankedHomeIds),
      " warnings =",
      JSON.stringify(perfMeta.sourceWarnings),
    );

    assert.equal(injected, true);
    assert.equal(perfMeta.state, "degraded");
    assert.deepEqual(
      perfMeta.degradedHomeIds,
      ["z-broken", "z-changed"],
      "受阻集合 = 读失败者 + 变化者（排序），稳定者不得混入",
    );
    assert.deepEqual(
      perfMeta.sourceWarnings,
      [
        { sourceKind: "zcode", homeId: "z-broken", code: "READ_ONLY_OPEN_FAILED", count: 1 },
        { sourceKind: "zcode", homeId: "z-changed", code: "LIVE_SOURCE_CHANGED", count: 1 },
      ],
      "每个 home 的告警必须来自它自己的证据",
    );
    assert.deepEqual(perfMeta.rankedHomeIds, ["z-stable"], "只有稳定者进入默认排名");
    assert.equal(perfMeta.perfFingerprintStable, false, "有变化者 ⇒ 性能版本不可发布");
    assert.equal(perfMeta.indexVersion, null);
    // 候选口径：稳定者完好；读失败者一条都不贡献；**变化者已读到的候选仍会入载体**
    // （与 ★M4.1-c 同理：候选是否完整不由"读到几条"决定），但必须被排除出默认排名。
    const countFor = (homeId) => perfSamples.filter((sample) => sample.homeId === homeId).length;
    assert.equal(countFor("z-stable"), 2, "稳定者的候选必须完好");
    assert.equal(countFor("z-broken"), 0, "读失败者不得贡献候选");
    assert.equal(countFor("z-changed"), 1, "变化者的候选仍入载体，但被排除出排名");
    assert.equal(perfSamples.length, 3);
  } finally {
    PERF_SOURCE_READERS.clear();
    for (const [key, value] of savedReaders) PERF_SOURCE_READERS.set(key, value);
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ★M4.1-k（返工2 · 复核2 P2）跨 home 读取窗口：A 读完后在读取 B 期间改写 A
// ---------------------------------------------------------------------------

test("★M4.1-k 跨 home 窗口：读取 B 期间改写已读完的 A，整轮结束核对必须检出 A", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m41-k-"));
  const savedReaders = new Map(PERF_SOURCE_READERS);
  try {
    const homeA = makeZcodeDb(root, "z-a", { rows: 1 });
    const homeB = makeZcodeDb(root, "z-b", { rows: 1 });
    pinMtime(homeA.dbFile, BASE);
    const homes = [homeA, homeB];

    // ① 稳定 A/B：两个 home 都 ready、都进排名、版本可发布（顺序与基线）
    const stable = await buildUsageReport({ homes });
    const stableVersion = stable.perfMeta.indexVersion;
    console.log(
      "  [实测·稳定] state =",
      stable.perfMeta.state,
      " ranked =",
      JSON.stringify(stable.perfMeta.rankedHomeIds),
      " usageStable =",
      stable.perfMeta.usageFingerprintStable,
    );
    assert.equal(stable.perfMeta.state, "ready");
    assert.deepEqual(stable.perfMeta.degradedHomeIds, []);
    assert.deepEqual(stable.perfMeta.rankedHomeIds, ["z-a", "z-b"]);
    assert.equal(stable.perfMeta.usageFingerprintStable, true);
    assert.match(String(stableVersion), /^[0-9a-f]{64}$/);

    // ② 复核2 的复现手法：仅在 **B 的真实 reader 完成后** UPDATE A 的 output_tokens 100→200。
    //    此时 A 的**局部后置**指纹早已取完 ⇒ 只有"整轮结束核对"能发现。
    /** @type {string[]} */
    const readOrder = [];
    let injectedAfter = null;
    PERF_SOURCE_READERS.set("zcode", async (filePath, source, onSample, options) => {
      const result = await streamZcodePerfSamples(filePath, source, onSample, options);
      readOrder.push(filePath);
      if (filePath === homeB.dbFile && injectedAfter === null) {
        injectedAfter = filePath;
        updateZcodeOutput(homeA.dbFile, "z-a-row-0", 200);
        pinMtime(homeA.dbFile, BASE);
      }
      return result;
    });

    const live = await buildUsageReport({ homes });
    const { perfSamples, perfMeta } = live;
    console.log(
      "  [实测·注入] 读取顺序 =",
      JSON.stringify(readOrder.map((file) => (file === homeA.dbFile ? "A" : "B"))),
      " 注入于 =",
      injectedAfter === homeB.dbFile ? "B 读完后" : injectedAfter,
      " state =",
      perfMeta.state,
      " degraded =",
      JSON.stringify(perfMeta.degradedHomeIds),
      " ranked =",
      JSON.stringify(perfMeta.rankedHomeIds),
      " version =",
      perfMeta.indexVersion,
    );

    // 注入与顺序必须**实测**：A 先读完，注入发生在 B 读完之后
    assert.deepEqual(readOrder, [homeA.dbFile, homeB.dbFile], "顺序：先读 A 再读 B");
    assert.equal(injectedAfter, homeB.dbFile, "注入发生在 B 的 reader 完成之后");
    // A 的候选是**改写前**读到的 100（这正是"候选与上游已不一致"的体现）
    const sampleA = perfSamples.find((sample) => sample.homeId === "z-a");
    assert.equal(sampleA?.outputTokens, 100, "A 的候选是改写前读到的值");

    // 归因：**只有 A** 被阻断并告警；B 稳定、保留排名；版本不可发布
    assert.equal(perfMeta.state, "degraded", "整轮结束核对必须发现 A 变了");
    assert.deepEqual(perfMeta.degradedHomeIds, ["z-a"], "只阻断实际变化的 home");
    assert.deepEqual(perfMeta.sourceWarnings, [
      { sourceKind: "zcode", homeId: "z-a", code: "LIVE_SOURCE_CHANGED", count: 1 },
    ]);
    assert.deepEqual(perfMeta.rankedHomeIds, ["z-b"], "稳定 home 保留排名");
    assert.equal(perfMeta.perfFingerprintStable, false);
    assert.equal(perfMeta.indexVersion, null, "任一启用来源变化 ⇒ 版本 null");
    // ⚠️ 本例把 mtime 钉回原值 ⇒ **用量全局指纹（size/mtime 型）看不见这次改写**，
    //    `usageFingerprintStable` 仍为 true —— 这正说明它只是**诊断轴**，
    //    "用量诊断不能替代性能来源的整轮验证"（复核2 §1 原话）；检测必须由内容指纹完成。
    assert.equal(perfMeta.usageFingerprintStable, true, "size/mtime 型用量指纹对同尺寸同 mtime 改写是盲的");

    // ③ 恢复：稳定完整读取 ⇒ 读到 A=200、两个 home 都 ready、版本与旧内容版本不同
    PERF_SOURCE_READERS.clear();
    for (const [key, value] of savedReaders) PERF_SOURCE_READERS.set(key, value);
    const recovered = await buildUsageReport({ homes });
    console.log(
      "  [实测·恢复] A 输出 =",
      recovered.perfSamples.find((sample) => sample.homeId === "z-a")?.outputTokens,
      " state =",
      recovered.perfMeta.state,
      " version ≠ 旧 =",
      recovered.perfMeta.indexVersion !== stableVersion,
    );
    assert.equal(recovered.perfMeta.state, "ready");
    assert.equal(recovered.perfSamples.find((sample) => sample.homeId === "z-a")?.outputTokens, 200);
    assert.deepEqual(recovered.perfMeta.rankedHomeIds, ["z-a", "z-b"]);
    assert.match(String(recovered.perfMeta.indexVersion), /^[0-9a-f]{64}$/);
    assert.notEqual(recovered.perfMeta.indexVersion, stableVersion, "版本必须随内容变化");
  } finally {
    PERF_SOURCE_READERS.clear();
    for (const [key, value] of savedReaders) PERF_SOURCE_READERS.set(key, value);
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// M4.2：两条生产汇总路径的 `summary.perf` parity（卡片明文"调用同一函数"）
// ===========================================================================
//
// 核心风险：内存路径（`buildUsageReport` → `summarizeUsage`）与索引路径
//（`UsageStore.replaceFile` → `summarize`）**各自**取候选，但必须过**同一个** `summarizePerf`，
// 且收到**同一个范围表达**（M1 键名）与**同一组排除**。任何一处不同都会让计数/分位分叉。
//
// 因此本组每一条都是**双路径比对**：同一批真实 ZCode SQLite 行、同一个 `filters`，
// 断言 `groups`/`models`/`coverage`/`meta.methodVersion` 与所有计数**完全相同**。
// **不得**用"两边都有 groups"代替"两边 groups 逐字相同"。

/** 打开一个隔离的索引库（与本用例的 ZCode home 同处一个临时根）。 */
async function openParityStore(root) {
  const store = new UsageStore({ homeDir: root, databaseFile: path.join(root, "usage-index.sqlite") });
  await store.open();
  return store;
}

/**
 * 建一个"真实可达"的 ZCode home：`<root>/<name>/cli/db/db.sqlite`，并**通过真实 discovery**
 * 取回 home 对象（这样两条路径拿到**同一批** home，`homeId` 也逐字相同）。
 *
 * ⚠️ 索引路径必须走真实 `store.sync()`：`perf_state`/`perf_method_version` 是 sync 的**收尾步骤**
 * 写的（`replaceFile` 不写）⇒ 只调 `replaceFile` 会停在 `uninitialized`，两端不可比。
 * @param {string} root
 * @param {{ name: string, rows?: number, spacingMs?: number }[]} specs
 */
async function parityHomes(root, specs) {
  const dirs = [];
  for (const spec of specs) {
    const dbFile = path.join(root, spec.name, "cli", "db", "db.sqlite");
    // 同一个 root 上允许重复取（例如"全量 vs 排除"两次比对）：已建好就**原样复用**，
    // 否则第二次 `CREATE TABLE` 会撞车。
    if (!existsSync(dbFile)) {
      makeZcodeDb(root, spec.name, {
        rows: spec.rows ?? 25,
        spacingMs: spec.spacingMs,
        baseMs: spec.baseMs,
      });
    }
    dirs.push(path.join(root, spec.name));
  }
  // 用 `extraZcodeHomes` 让真实 discovery 发现它们（`Main ZCode` = `<root>/.zcode` 不存在 ⇒ 跳过）。
  const options = { homeDir: root, extraZcodeHomes: dirs.join(path.delimiter) };
  const homes = await discoverUsageSources(options);
  // `>=`：夹具里可能**另有**真实的 `.codex` home（配额用例需要它提供 rate-limit 观测），
  // 它同样是两端共用的来源，不该被排除。
  assert.ok(
    homes.length >= specs.length,
    `前置：真实 discovery 至少发现这些 home（实得 ${homes.length}，期望 ≥ ${specs.length}）`,
  );
  return { homes, options };
}

/**
 * 双路径取 `summary.perf`：**同一批真实 home**、同一 `filters`；索引侧走真实 `sync()`。
 * @param {string} root
 * @param {{ name: string, rows?: number, spacingMs?: number }[]} specs
 * @param {object} filters
 * @param {{ includeDetails?: boolean }} [options]
 */
async function bothPerfBlocks(root, specs, filters = {}, options = {}) {
  const { homes, options: discovery } = await parityHomes(root, specs);
  // 供用例在"建好 home、还没读"的时点改上游（例如把某行时间戳清空造 unplaced）。
  if (typeof options.beforeReport === "function") await options.beforeReport(homes);
  const report = await buildUsageReport({ homes });
  const memory = summarizeUsage(report, filters).perf;
  const store = await openParityStore(root);
  try {
    await store.sync({ options: discovery });
    const indexed = store.summarize(filters, options).perf;
    return { memory, indexed, homes, discovery };
  } finally {
    store.close();
  }
}

/** 卡片要求的 parity 面：`groups` / `models` / `coverage` / `methodVersion` + 所有计数。 */
function assertStatsParity(memory, indexed, label) {
  assert.deepEqual(indexed.groups, memory.groups, `${label}：groups 必须逐字相同`);
  assert.deepEqual(indexed.models, memory.models, `${label}：models 必须逐字相同`);
  assert.deepEqual(indexed.coverage, memory.coverage, `${label}：coverage 必须逐字相同`);
  assert.ok(Object.hasOwn(memory, "codexTimingCoverage"), `${label}：内存路径必须公开当前方法覆盖字段`);
  assert.ok(Object.hasOwn(indexed, "codexTimingCoverage"), `${label}：索引路径必须公开当前方法覆盖字段`);
  assert.deepEqual(indexed.codexTimingCoverage, memory.codexTimingCoverage, `${label}：Codex 当前方法覆盖相同`);
  assert.equal(indexed.meta.methodVersion, memory.meta.methodVersion, `${label}：methodVersion`);
  assert.equal(indexed.meta.minSamples, memory.meta.minSamples, `${label}：minSamples`);
  assert.equal(indexed.meta.longWindowMs, memory.meta.longWindowMs, `${label}：longWindowMs`);
  assert.equal(indexed.meta.eraCutoffMs, memory.meta.eraCutoffMs, `${label}：eraCutoffMs`);
  // "所有计数"逐项（deepEqual 已覆盖，这里显式再列一遍，失败时定位更快）
  for (const key of [
    "eligible",
    "positiveOutput",
    "timedPositiveOutput",
    "completeTimedPositiveOutput",
    "sampled",
    "dropped",
    "pending",
    "unplaced",
  ]) {
    assert.equal(indexed.coverage[key], memory.coverage[key], `${label}：coverage.${key}`);
  }
}

test("★M4.2-a 普通范围：两端 groups/coverage/methodVersion 与计数逐字相同（诊断统计保留、未获统一排名）", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m42-a-"));
  try {
    const { memory, indexed } = await bothPerfBlocks(root, [{ name: "z-a", rows: 25 }], {
      preset: "all",
      now: FIXED_NOW,
    });
    console.log(
      "  [实测] memory groups =",
      memory.groups.length,
      "n =",
      memory.groups[0]?.n,
      "rank =",
      memory.groups[0]?.rank,
      "coverage.eligible =",
      memory.coverage.eligible,
    );
    assert.equal(memory.groups.length, 1, "前置：恰好一个组（否则 parity 无判别力）");
    assert.equal(memory.groups[0].n, 25);
    assert.equal(memory.groups[0].rank, null, "ZCode 输出范围未知 ⇒ 保留诊断统计但不进入统一排名");
    // 判别力前置：行 id 必须是真的，否则『两端相同』可能只是『两端都空/都错』
    assert.equal(memory.groups[0].sums.outputTokens, 2800, "前置：确实读到了 25 行 fixture 输出");
    assert.equal(memory.groups[0].insufficientSamples, false);
    assert.equal(memory.models.length, 1);
    assert.equal(memory.models[0].n, 25);
    assert.equal(memory.models[0].rank, null);
    assert.equal(memory.models[0].modelProvider, "fixture-provider");
    assert.equal(memory.models[0].window, "request");
    assert.equal(memory.models[0].rankState, "unverified");
    assert.equal(memory.models[0].firstSampleAtMs, BASE + 500);
    assert.equal(memory.models[0].lastSampleAtMs, BASE + 24_500);
    assert.deepEqual(
      Object.keys(memory.models[0]).sort(),
      [
        "averageTps",
        "firstSampleAtMs",
        "key",
        "lastSampleAtMs",
        "model",
        "modelProvider",
        "n",
        "p10",
        "p90",
        "rank",
        "rankState",
        "reasoningEffort",
        "sourceKind",
        "state",
        "window",
      ].sort(),
    );
    assert.equal(memory.codexTimingCoverage, null, "没有 Codex 来源，不伪造零覆盖统计");
    assert.equal(memory.coverage.eligible, 25);
    assert.equal(memory.coverage.sampled, 25);
    assertStatsParity(memory, indexed, "普通范围");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★M4.2-b 自定义范围：只有范围内样本进入两端，且两端逐字相同", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m42-b-"));
  try {
    // 行 i 落在 UTC 日 2023-11-14 + i 天（`BASE` = 2023-11-14T22:13:20Z）⇒ 自定义范围可精确截断
    const filters = {
      preset: "custom",
      startDate: "2023-11-14",
      endDate: "2023-11-16",
      calendarZone: "utc",
      now: FIXED_NOW,
    };
    const { memory, indexed } = await bothPerfBlocks(root, [{ name: "z-b", rows: 25, spacingMs: 86_400_000 }], filters);
    console.log("  [实测] 范围内 eligible =", memory.coverage.eligible, " groups =", memory.groups.length);
    assert.equal(memory.coverage.eligible, 3, "前置：范围真的截断了样本（否则无判别力）");
    assertStatsParity(memory, indexed, "自定义范围");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★M4.2-c UTC 时区范围：两端使用同一日历换算", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m42-c-"));
  try {
    const filters = {
      preset: "custom",
      startDate: "2023-11-15",
      endDate: "2023-11-15",
      calendarZone: "utc",
      now: FIXED_NOW,
    };
    const { memory, indexed } = await bothPerfBlocks(root, [{ name: "z-c", rows: 25, spacingMs: 86_400_000 }], filters);
    console.log(
      "  [实测] UTC 单日范围内 eligible =",
      memory.coverage.eligible,
      " insufficient =",
      memory.groups[0]?.insufficientSamples,
    );
    assert.equal(memory.coverage.eligible, 1, "前置：UTC 单日窗口只含一行");
    assert.equal(memory.groups[0]?.insufficientSamples, true, "n=1 < minSamples ⇒ 保留但不得排名");
    assertStatsParity(memory, indexed, "UTC 范围");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★M4.2-d 排除 home：两端排除同一 home，且排除真的生效", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m42-d-"));
  try {
    const all = await bothPerfBlocks(
      root,
      [
        { name: "z-d1", rows: 25 },
        { name: "z-d2", rows: 25 },
      ],
      {
        preset: "all",
        now: FIXED_NOW,
      },
    );
    const excluded = await bothPerfBlocks(
      root,
      [
        { name: "z-d1", rows: 25 },
        { name: "z-d2", rows: 25 },
      ],
      {
        preset: "all",
        now: FIXED_NOW,
        excludeHomes: [all.homes.find((home) => home.path.endsWith("z-d2"))?.id],
      },
    );
    console.log(
      "  [实测] 全部 eligible =",
      all.memory.coverage.eligible,
      " 排除 z-d2 后 =",
      excluded.memory.coverage.eligible,
    );
    assert.equal(all.memory.coverage.eligible, 50);
    assert.equal(excluded.memory.coverage.eligible, 25, "前置：排除真的生效");
    assertStatsParity(all.memory, all.indexed, "不排除");
    assertStatsParity(excluded.memory, excluded.indexed, "排除 z-d2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★M4.2-e n=0：无候选时两端都只给 coverage/诊断，不给任何组", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m42-e-"));
  try {
    const { memory, indexed } = await bothPerfBlocks(root, [{ name: "z-e", rows: 0 }], {
      preset: "all",
      now: FIXED_NOW,
    });
    console.log("  [实测] n=0 时 groups =", JSON.stringify(memory.groups), " eligible =", memory.coverage.eligible);
    assert.deepEqual(memory.groups, [], "n=0 不得造出统计组");
    assert.deepEqual(memory.models, [], "n=0 不得造出模型速度行");
    assert.equal(memory.coverage.eligible, 0);
    assertStatsParity(memory, indexed, "n=0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★M4.2-f unplaced：无时间位置的候选在两端都进 coverage.unplaced（索引侧必须并入）", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m42-f-"));
  try {
    const { memory, indexed } = await bothPerfBlocks(
      root,
      [{ name: "z-f", rows: 3 }],
      { preset: "all", now: FIXED_NOW },
      {
        // 把一行的时间戳清空 ⇒ tsMs 缺失 ⇒ M1 归入 unplaced（而不是 eligible）
        beforeReport: async (homes) => {
          const db = new DatabaseSync(homes[0].usageLogPath);
          try {
            db.prepare('UPDATE "model_usage" SET started_at = NULL, completed_at = NULL WHERE id = ?').run("z-f-row-1");
          } finally {
            db.close();
          }
        },
      },
    );
    console.log(
      "  [实测] unplaced =",
      memory.coverage.unplaced,
      " eligible =",
      memory.coverage.eligible,
      " indexed.unplaced =",
      indexed.coverage.unplaced,
    );
    assert.equal(memory.coverage.unplaced, 1, "前置：确实有一行没有时间位置");
    assert.equal(memory.coverage.eligible, 2);
    assertStatsParity(memory, indexed, "unplaced");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★M4.2-g includeDetails=false：只门控原有重详情，不删 perf 组或覆盖率", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m42-g-"));
  try {
    const filters = { preset: "all", now: FIXED_NOW };
    const full = await bothPerfBlocks(root, [{ name: "z-g", rows: 25 }], filters, { includeDetails: true });
    const lean = await bothPerfBlocks(root, [{ name: "z-g", rows: 25 }], filters, { includeDetails: false });
    assertStatsParity(full.memory, full.indexed, "includeDetails=true");
    assertStatsParity(lean.memory, lean.indexed, "includeDetails=false");
    assert.deepEqual(lean.indexed.groups, full.indexed.groups, "perf 组不得被详情门控删掉");
    assert.deepEqual(lean.indexed.models, full.indexed.models, "perf 模型速度行不得被详情门控删掉");
    assert.deepEqual(lean.indexed.coverage, full.indexed.coverage, "覆盖率不得被详情门控删掉");
    // 反向判别力：重详情**确实**被门控掉了（否则上面的断言可能只是常量）
    const store = await openParityStore(root);
    try {
      await store.sync({ options: full.discovery });
      const withDetails = store.summarize(filters, { includeDetails: true });
      const without = store.summarize(filters, { includeDetails: false });
      assert.ok(withDetails.homes !== undefined, "前置：includeDetails=true 时有 homes 段");
      assert.equal(without.homes, undefined, "includeDetails=false 必须门控掉 homes");
      assert.equal(without.projects, undefined);
      assert.equal(without.repositories, undefined);
      assert.deepEqual(without.perf.groups, withDetails.perf.groups, "perf 组不受详情门控影响");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★M4.2-h rebuilding/uninitialized：不返回部分排名，也不因状态取值抛错", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m42-h-"));
  try {
    const { homes, options: discovery } = await parityHomes(root, [{ name: "z-h", rows: 5 }]);
    const store = await openParityStore(root);
    try {
      // 未 sync ⇒ `perf_state` 键缺失 ⇒ 读取投影给 `uninitialized`（**不是** M1 的三态之一）
      const summary = store.summarize({ preset: "all", now: FIXED_NOW }, {});
      console.log(
        "  [实测] 未 sync：state =",
        summary.perf.state,
        " groups =",
        summary.perf.groups.length,
        " meta.state =",
        summary.perf.meta.state,
      );
      assert.equal(summary.perf.state, "uninitialized", "M3.4 的读取投影语义保持不变");
      assert.deepEqual(summary.perf.groups, [], "未就绪时不得返回部分排名");
      assert.deepEqual(summary.perf.models, [], "未就绪时不得返回部分模型速度行");
      assert.equal(summary.perf.codexTimingCoverage, null, "未就绪不能宣称零计时覆盖");
      assert.equal(summary.perf.meta.state, "rebuilding", "M1 只接受 rebuilding/ready/degraded");
      assert.ok(summary.perf.coverage, "诊断用的 coverage 仍应存在");
      // ⚠️ 上一条 `groups` 断言必须**有判别力**：先把真实候选写进库（`replaceFile` 只写候选、
      //    **不**写 `perf_state`），此时 `groups` 若非空就说明"rebuilding 不返回部分排名"漏了。
      //    注意 `coverage.eligible` 与状态无关（它描述候选、不描述排名）⇒ 不能用它代替判别力。
      const probe = await openParityStore(root);
      try {
        await probe.replaceFile(
          { filePath: homes[0].usageLogPath, source: homes[0], info: statSync(homes[0].usageLogPath) },
          {},
        );
        const rebuilding = probe.summarize({ preset: "all", now: FIXED_NOW }, {});
        console.log(
          "  [实测] 有候选但仍未就绪：state =",
          rebuilding.perf.state,
          " eligible =",
          rebuilding.perf.coverage.eligible,
          " groups =",
          rebuilding.perf.groups.length,
        );
        assert.equal(rebuilding.perf.coverage.eligible, 5, "前置：候选已在库里（否则空组不构成证据）");
        assert.deepEqual(rebuilding.perf.groups, [], "候选就绪但状态未就绪 ⇒ 仍不得返回部分排名");
        assert.deepEqual(rebuilding.perf.models, [], "候选就绪但状态未就绪 ⇒ 仍不得返回模型速度行");
        assert.equal(rebuilding.perf.codexTimingCoverage, null);
      } finally {
        probe.close();
      }
      // 真实 sync 后立刻变 ready 且有组（证明空组只来自"未就绪"，不是被永久屏蔽）
      await store.sync({ options: discovery });
      const ready = store.summarize({ preset: "all", now: FIXED_NOW }, {});
      console.log("  [实测] sync 后：state =", ready.perf.state, " groups =", ready.perf.groups.length);
      assert.equal(ready.perf.state, "ready", "sync 收尾写入 ready");
      assert.equal(ready.perf.meta.state, "ready");
      assert.ok(ready.perf.groups.length > 0, "ready 后必须给出组");
      assert.equal(ready.perf.models.length, 1);
      assert.equal(ready.perf.models[0].n, 5);
      assert.equal(ready.perf.coverage.eligible, 5);
      assert.equal(homes.length, 1, "前置：真实 discovery 发现一个 home");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★M4.2-i 范围转换：`perfStatsRangeBounds` 的键名/取值语义（两路径共用同一个转换）", () => {
  assert.deepEqual(perfStatsRangeBounds(null), { startMs: null, endMs: null, windowEndExclusiveMs: null });
  assert.deepEqual(perfStatsRangeBounds({ start: new Date(10), end: new Date(20) }), {
    startMs: 10,
    endMs: 20,
    windowEndExclusiveMs: null,
  });
  // 配额范围同时带 end 与更晚的 windowEndExclusive ⇒ 两个键都要转出来（M1 里后者优先）
  assert.deepEqual(perfStatsRangeBounds({ start: new Date(10), end: new Date(20), windowEndExclusive: new Date(30) }), {
    startMs: 10,
    endMs: 20,
    windowEndExclusiveMs: 30,
  });
  // 已是 M1 键名时**原样通过**（幂等）
  assert.deepEqual(perfStatsRangeBounds({ startMs: 1, endMs: 2, windowEndExclusiveMs: 3 }), {
    startMs: 1,
    endMs: 2,
    windowEndExclusiveMs: 3,
  });
  assert.throws(() => perfStatsRangeBounds({ start: Number.NaN }), TypeError, "非有限值必须响亮失败");
  assert.throws(() => perfStatsRangeBounds("nope"), TypeError);
});

test("★M4.2-j 状态投影字段与冻结三件套共存：既有键一个不改，两端键集相同", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m42-j-"));
  try {
    const { memory, indexed, homes } = await bothPerfBlocks(root, [{ name: "z-j", rows: 3 }], {
      preset: "all",
      now: FIXED_NOW,
    });
    const expectedKeys = [
      "state",
      "ready",
      "methodVersion",
      "indexVersion",
      "indexedAt",
      "degradedHomeIds",
      "missingSources",
      "sourceWarnings",
      "unsupportedSources",
      "rankedHomeIds",
      "groups",
      "models",
      "coverage",
      "codexTimingCoverage",
      "meta",
    ];
    assert.deepEqual(Object.keys(memory).sort(), [...expectedKeys].sort(), "内存路径键集");
    assert.deepEqual(Object.keys(indexed).sort(), [...expectedKeys].sort(), "索引路径键集");
    // M3.4 的既有语义不得被改动：`state`/`rankedHomeIds`/`degradedHomeIds` 原样保留
    console.log("  [实测] memory.state =", memory.state, " ranked =", JSON.stringify(memory.rankedHomeIds));
    assert.equal(memory.state, "ready");
    assert.equal(memory.rankedHomeIds.length, 1, "默认排名含该 home（id 由真实 discovery 生成）");
    assert.equal(homes.length, 1);
    assert.deepEqual(memory.degradedHomeIds, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★M4.2-k 受阻 home：degraded 时两端都排除该 home 的候选（不得让陈旧候选进统计）", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m42-k-"));
  try {
    const { homes, options: discovery } = await parityHomes(root, [
      { name: "z-k1", rows: 25 },
      { name: "z-k2", rows: 25 },
    ]);
    const [homeK1, homeK2] = homes;
    const store = await openParityStore(root);
    try {
      await store.sync({ options: discovery });
      // 用 M3.4 的真实状态机把 k2 标为受阻（其陈旧候选**仍在库里**，这正是要防的场景）
      store.writePerfState("degraded", {
        degradedHomeIds: [homeK2.id],
        sourceWarnings: [{ sourceKind: "zcode", homeId: homeK2.id, code: "LIVE_SOURCE_CHANGED", count: 1 }],
      });
      const summary = store.summarize({ preset: "all", now: FIXED_NOW }, {});
      console.log(
        "  [实测] degraded：eligible =",
        summary.perf.coverage.eligible,
        " ranked =",
        JSON.stringify(summary.perf.rankedHomeIds),
        " groups.homeId =",
        JSON.stringify(summary.perf.groups.map((group) => group.homeId)),
      );
      assert.deepEqual(summary.perf.degradedHomeIds, [homeK2.id]);
      assert.deepEqual(summary.perf.rankedHomeIds, [homeK1.id], "受阻 home 不得进默认排名");
      assert.equal(summary.perf.coverage.eligible, 25, "受阻 home 的陈旧候选不得进统计");
      assert.deepEqual(
        summary.perf.groups.map((group) => group.homeId),
        [homeK1.id],
      );

      // 内存路径：把**同一个**受阻集合交给它（生产里由 M4.1 的 `perfMeta.degradedHomeIds` 提供）
      const report = await buildUsageReport({ homes });
      /** @type {any} */ (report).perfMeta.degradedHomeIds = [homeK2.id];
      const memory = summarizeUsage(report, { preset: "all", now: FIXED_NOW }).perf;
      assert.equal(memory.coverage.eligible, 25, "内存路径同样必须排除受阻 home");
      assert.deepEqual(
        memory.groups.map((group) => group.homeId),
        [homeK1.id],
      );
      assertStatsParity(memory, summary.perf, "受阻 home 排除后");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ★M4.2-l 配额范围：真实 rate-limit 观测 ⇒ 两端同一窗口 + 同一"非 Codex home 排除"
// ---------------------------------------------------------------------------

const QUOTA_AS_OF = "2026-07-12T12:00:00.000Z";
const QUOTA_RESETS_AT = "2026-07-12T14:37:00.000Z";
/**
 * 用量行必须**严格早于** `QUOTA_AS_OF`：配额范围的 `end` 是 `min(asOf, 窗口结束) - 1ms`，
 * 落在 `asOf` 当刻的行会被排除（这是既有语义，不是本卡要改的东西）。
 */
const QUOTA_EVENT_AT = "2026-07-12T11:30:00.000Z";
/** `window_minutes: 300` ⇒ 窗口 = [09:37, 14:37)（UTC），`QUOTA_AS_OF` 落在其中。 */
const QUOTA_WINDOW_START_MS = Date.parse("2026-07-12T09:37:00.000Z");

/**
 * 造一个**真实** Codex home：`.codex/sessions/<Y>/<M>/<D>/rollout-quota.jsonl`，含
 * `session_meta` + `turn_context` + 一条带 `payload.rate_limits.primary` 的 `token_count`
 *（`window_minutes: 300` ⇒ `quota_5h`）。这是两端**共同**的配额观测来源。
 */
function writeCodexQuotaHome(root) {
  const dir = path.join(root, ".codex", "sessions", "2026", "07", "12");
  mkdirSync(dir, { recursive: true });
  const tokenRow = {
    timestamp: QUOTA_EVENT_AT,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: 100,
          input_tokens: 80,
          cached_input_tokens: 0,
          output_tokens: 20,
          reasoning_output_tokens: 0,
        },
      },
      rate_limits: {
        limit_id: "codex",
        primary: { window_minutes: 300, resets_at: Date.parse(QUOTA_RESETS_AT) / 1000, used_percent: 42.5 },
      },
    },
  };
  const lines = [
    {
      timestamp: QUOTA_EVENT_AT,
      type: "session_meta",
      payload: { id: "quota-session", source: "cli", originator: "codex-tui", cwd: "/work/quota" },
    },
    { type: "turn_context", payload: { model: "gpt-6-quota" } },
    tokenRow,
  ];
  writeFileSync(path.join(dir, "rollout-quota.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

test("★M4.2-l 配额范围：同一 quota_5h 窗口下两端排除同一批非 Codex home，且与全量形成对照", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m42-l-"));
  try {
    writeCodexQuotaHome(root);
    // ZCode 候选行落在配额窗口内（09:37–14:37 UTC），否则"窗口生效"不可证
    const specs = [{ name: "z-l", rows: 25, baseMs: QUOTA_WINDOW_START_MS + 60_000 }];
    const { homes, options: discovery } = await parityHomes(root, specs);
    const store = await openParityStore(root);
    try {
      await store.sync({ options: discovery });
      const quotaFilters = { preset: "quota_5h", now: QUOTA_AS_OF };
      const indexed = store.summarize(quotaFilters, {}).perf;
      const report = await buildUsageReport({ homes });
      const memory = summarizeUsage(report, quotaFilters).perf;
      console.log(
        "  [实测] 配额窗口：memory.eligible =",
        memory.coverage.eligible,
        " indexed.eligible =",
        indexed.coverage.eligible,
        " memory.state =",
        memory.state,
        " codex 观测数 =",
        report.rateLimitObservations.length,
      );
      assert.equal(report.rateLimitObservations.length, 1, "前置：真实 rate-limit 观测被读到");
      assertStatsParity(memory, indexed, "quota_5h");
      // 卡片明文："限额筛选继续使用现有 quotaPreset 判定与**非 Codex home 排除**"
      // ⇒ 该 fixture 里唯一的性能来源是 ZCode（非 Codex）⇒ 配额窗口下两端都应为空。
      assert.equal(memory.coverage.eligible, 0, "配额窗口必须排除非 Codex home 的候选");
      assert.deepEqual(memory.groups, []);
      assert.deepEqual(memory.models, []);
      // 对照：同一 fixture 的非配额范围**有**候选 ⇒ 上面的 0 是"排除"造成的，不是数据为空
      // 对照必须与配额范围**同时刻**，否则两次调用默认 `now` 略有差异，比较不可信
      const all = await bothPerfBlocks(root, specs, { preset: "all", now: QUOTA_AS_OF });
      console.log("  [实测] 对照 all：eligible =", all.memory.coverage.eligible);
      assert.equal(all.memory.coverage.eligible, 25, "对照：非配额范围含全部 ZCode 候选");
      assertStatsParity(all.memory, all.indexed, "对照 all");
      // 卡片明文：`summary.perf` 不影响既有用量段
      const storeAgain = await openParityStore(root);
      try {
        await storeAgain.sync({ options: discovery });
        const withPerf = storeAgain.summarize(quotaFilters, {});
        assert.ok(withPerf.eventCount >= 1, "配额窗口内的 Codex 用量事件仍在（perf 不吞掉用量）");
        assert.ok(withPerf.totals.total > 0, "用量总量必须不受 perf 排除影响");
      } finally {
        storeAgain.close();
      }
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ★M4.1-j（返工1 · 复核 P2）仅 `-wal` 变化也必须被检出（主库字节不变）
// ---------------------------------------------------------------------------

test("★M4.1-j 仅 -wal 变化：主库 size/mtime 不变也必须检出并令版本不可证", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m41-j-"));
  const savedReaders = new Map(PERF_SOURCE_READERS);
  let walHome = null;
  try {
    walHome = makeZcodeDb(root, "z-wal", { rows: 1, keepWalOpen: true });
    const statBefore = statSync(walHome.dbFile);

    let injected = false;
    PERF_SOURCE_READERS.set("zcode", async (filePath, source, onSample, options) => {
      const result = await streamZcodePerfSamples(filePath, source, onSample, options);
      if (!injected) {
        injected = true;
        // 经**保持打开**的连接追加 ⇒ 数据先落 `-wal`（主库在 checkpoint 前不变）
        insertZcodeRowViaHandle(walHome.walHandle, "z-wal-row-9", 9, { output: 888 });
      }
      return result;
    });

    const report = await buildUsageReport({ homes: [walHome] });
    const statAfter = statSync(walHome.dbFile);
    console.log(
      "  [实测] 主库 size/mtime 不变 =",
      statAfter.size === statBefore.size && statAfter.mtimeMs === statBefore.mtimeMs,
      " state =",
      report.perfMeta.state,
      " indexVersion =",
      report.perfMeta.indexVersion,
    );

    assert.equal(injected, true);
    assert.equal(statAfter.size, statBefore.size, "前提：仅 -wal 变化时主库尺寸不变");
    assert.equal(statAfter.mtimeMs, statBefore.mtimeMs, "前提：仅 -wal 变化时主库 mtime 不变");
    assert.equal(report.perfMeta.state, "degraded", "仅 -wal 变化也必须被检出（这正是折叠 -wal 的理由）");
    assert.deepEqual(report.perfMeta.degradedHomeIds, ["z-wal"]);
    assert.deepEqual(report.perfMeta.sourceWarnings, [
      { sourceKind: "zcode", homeId: "z-wal", code: "LIVE_SOURCE_CHANGED", count: 1 },
    ]);
    assert.equal(report.perfMeta.indexVersion, null);
  } finally {
    if (walHome?.walHandle) walHome.walHandle.close();
    PERF_SOURCE_READERS.clear();
    for (const [key, value] of savedReaders) PERF_SOURCE_READERS.set(key, value);
    rmSync(root, { recursive: true, force: true });
  }
});

test("M4.4 shared ZCode fixture: literal hand oracle across memory/index and filters", async () => {
  const fixture = createPerfIntegrationFixture();
  const store = new UsageStore({
    ...fixture.reportOptions,
    databaseFile: path.join(fixture.reportOptions.homeDir, "memory-parity-index.sqlite"),
  });
  try {
    const report = await buildUsageReport(fixture.reportOptions);
    assert.equal(report.homes.length, 2, "isolated discovery must not read ambient homes");
    assert.equal(report.perfSamples.length, fixture.expected.candidates);
    assert.ok(report.perfSamples.every((sample) => sample.agentKind !== "main"));
    for (const home of report.homes) {
      const db = new DatabaseSync(home.usageLogPath, { readOnly: true });
      try {
        const columns = db
          .prepare("PRAGMA table_info(model_usage)")
          .all()
          .map((column) => column.name);
        const hasTtft = home.path.endsWith("zcode-ranked");
        assert.equal(columns.includes("first_token_at"), hasTtft);
        assert.equal(columns.includes("time_to_first_token_ms"), hasTtft);
        if (hasTtft) {
          assert.equal(
            db
              .prepare(
                "SELECT count(*) AS n FROM model_usage WHERE first_token_at IS NOT NULL OR time_to_first_token_ms IS NOT NULL",
              )
              .get().n,
            0,
          );
        }
      } finally {
        db.close();
      }
    }
    await store.open();
    await store.sync({ options: fixture.reportOptions });
    const rankedHome = report.homes.find((home) => home.path.endsWith("zcode-ranked"));
    const variants = [
      ["all", { preset: "all" }],
      ["smallOnly", { preset: "all", excludeHomes: [rankedHome.id] }],
      ["dayB", { preset: "custom", calendarZone: "utc", startDate: "2026-10-04", endDate: "2026-10-04" }],
    ];
    for (const [name, filters] of variants) {
      filters.now = new Date(fixture.expected.now);
      const memory = summarizeUsage(report, filters).perf;
      const indexed = store.summarize(filters).perf;
      assertStatsParity(memory, indexed, `M4.4 ${name}`);
      for (const actual of [memory, indexed]) {
        assert.equal(actual.state, "ready");
        assert.deepEqual(actual.sourceWarnings, []);
        assert.equal(actual.groups.length, fixture.expected[name].groups.length);
        fixture.expected[name].groups.forEach((expected, i) => {
          for (const [key, value] of Object.entries(expected))
            assert.deepEqual(actual.groups[i][key], value, `${name}.${key}`);
        });
        for (const [key, value] of Object.entries(fixture.expected[name].coverage)) {
          assert.deepEqual(actual.coverage[key], value, `${name}.coverage.${key}`);
        }
        const c = actual.coverage;
        assert.equal(c.eligible, c.sampled + c.dropped + c.pending);
        assert.equal(
          Object.values(c.droppedByReason).reduce((sum, n) => sum + n, 0),
          c.dropped,
        );
        assert.deepEqual(
          c.bySource.zcode,
          Object.fromEntries(Object.entries(c).filter(([key]) => !["bySource", "byGroup"].includes(key))),
        );
        assert.equal(
          Object.values(c.byGroup).reduce((sum, group) => sum + group.eligible, 0),
          c.eligible,
        );
      }
    }
    const small = fixture.expected.smallOnly.groups[0];
    assert.notEqual(small.tps.pooled, 3, "unequal durations must distinguish pooled from mean TPS");
    console.log(`M4.4 fixtureHash=${fixture.fixtureHash}; candidates=35; all=34/30/3/1+unplaced1`);
  } finally {
    store.close();
    fixture.close();
    fixture.close();
  }
});

test("M4.4 fixture is deterministic, isolated and close is idempotent", () => {
  assert.throws(() => createPerfIntegrationFixture({ sources: ["zcode", "opencode"] }), /Supported fixture sources/);
  const a = createPerfIntegrationFixture();
  const b = createPerfIntegrationFixture();
  try {
    assert.notEqual(a.reportOptions.homeDir, b.reportOptions.homeDir);
    assert.equal(a.fixtureHash, b.fixtureHash);
    assert.match(a.fixtureHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(a.expected, b.expected);
    a.close();
    a.close();
    assert.equal(existsSync(a.reportOptions.homeDir), false);
    assert.equal(existsSync(b.reportOptions.homeDir), true);
  } finally {
    a.close();
    b.close();
  }
});

test("M4.4 close refuses a fixture root replaced with a junction", () => {
  const fixture = createPerfIntegrationFixture();
  const other = createPerfIntegrationFixture();
  const root = fixture.reportOptions.homeDir;
  const saved = `${root}-saved`;
  const parent = realpathSync(tmpdir());
  assert.equal(path.dirname(root), parent);
  assert.equal(path.dirname(saved), parent);
  assert.equal(existsSync(saved), false);
  let moved = false;
  let linked = false;
  try {
    renameSync(root, saved);
    moved = true;
    symlinkSync(other.reportOptions.homeDir, root, "junction");
    linked = true;
    assert.throws(() => fixture.close(), /refuse cleanup/);
    assert.equal(existsSync(path.join(other.reportOptions.homeDir, "zcode-small", "cli", "db", "db.sqlite")), true);
  } finally {
    if (linked) unlinkSync(root);
    if (moved) renameSync(saved, root);
    fixture.close();
    other.close();
  }
});

function assertM45Expected(perf, expected) {
  assert.equal(perf.groups.length, expected.groups.length);
  expected.groups.forEach((group, i) => {
    for (const [key, value] of Object.entries(group)) assert.deepEqual(perf.groups[i][key], value, key);
  });
  for (const [key, value] of Object.entries(expected.coverage)) assert.deepEqual(perf.coverage[key], value, key);
}

test("M4.5 DSH multiframe identity and literal oracle: memory/index/all/date/exclude", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode", "dsh"] });
  const second = createPerfIntegrationFixture({ sources: ["zcode", "dsh"] });
  const store = new UsageStore({ ...fixture.serverOptions });
  try {
    assert.equal(fixture.fixtureHash, second.fixtureHash);
    assert.deepEqual(fixture.expected, second.expected);
    const report = await buildUsageReport(fixture.reportOptions);
    assert.equal(report.homes.length, 3);
    assert.equal(report.perfSamples.length, 39);
    let frames = 0;
    for (const id of ["fixture-session-a", "fixture-session-b"]) {
      const bytes = readFileSync(
        path.join(fixture.reportOptions.homeDir, "dsh-fixture", "sessions", "fixture", id, "session.v4.jsonl.zstd"),
      );
      let offset = 0;
      while (true) {
        const found = bytes.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), offset);
        if (found === -1) break;
        frames++;
        offset = found + 4;
      }
    }
    assert.equal(frames, fixture.expected.dsh.frames, "exercise actual concatenated zstd frames");
    const samples = report.perfSamples.filter((sample) => sample.sourceKind === "dsh");
    assert.equal(samples.length, 4, "consistent repeated start/message must fold");
    const dshHome = report.homes.find((home) => home.kind === "dsh");
    assert.deepEqual(samples.map((sample) => JSON.parse(sample.sampleKey)).sort(), [
      ["dsh", dshHome.id, "fixture-session-a", 1, 1],
      ["dsh", dshHome.id, "fixture-session-a", 2, 1],
      ["dsh", dshHome.id, "fixture-session-b", 1, 1],
      ["dsh", dshHome.id, "fixture-session-b", 2, 1],
    ]);
    assert.equal(JSON.stringify(samples).includes("SENTINEL"), false);
    await store.open();
    await store.sync({ options: fixture.reportOptions });
    for (const [expected, filters] of [
      [fixture.expected.all, { preset: "all" }],
      [fixture.expected.zcodeOnly, { preset: "all", excludeHomes: [dshHome.id] }],
      [
        fixture.expected.dayB,
        { preset: "custom", calendarZone: "utc", startDate: "2026-10-04", endDate: "2026-10-04" },
      ],
    ]) {
      const memory = summarizeUsage(report, filters).perf;
      const indexed = store.summarize(filters).perf;
      assertStatsParity(memory, indexed, "M4.5");
      for (const perf of [memory, indexed]) {
        assert.equal(perf.state, "ready");
        assertM45Expected(perf, expected);
        assert.equal(perf.coverage.eligible, perf.coverage.sampled + perf.coverage.dropped + perf.coverage.pending);
      }
    }
    const rows = store.database
      .prepare("SELECT sample_key FROM perf_samples WHERE source_kind='dsh' ORDER BY sample_key")
      .all();
    assert.equal(rows.length, 4);
    await store.sync({ options: fixture.reportOptions });
    assert.deepEqual(
      store.database.prepare("SELECT sample_key FROM perf_samples WHERE source_kind='dsh' ORDER BY sample_key").all(),
      rows,
    );
    console.log(`M4.5 fixtureHash=${fixture.fixtureHash}; DSH TPS=10/20/40, pooled=30; identity count=4`);
  } finally {
    store.close();
    fixture.close();
    second.close();
  }
});

test("M4.5 DSH integrity failures isolate home, rollback all file data and recover", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode", "dsh"] });
  const store = new UsageStore({ ...fixture.serverOptions });
  const file = path.join(
    fixture.reportOptions.homeDir,
    "dsh-fixture",
    "sessions",
    "fixture",
    "fixture-session-a",
    "session.v4.jsonl.zstd",
  );
  const original = readFileSync(file);
  try {
    await store.open();
    await store.sync({ options: fixture.reportOptions });
    const report = await buildUsageReport(fixture.reportOptions);
    const homeId = report.homes.find((home) => home.kind === "dsh").id;
    const fileSnapshot = () =>
      Object.fromEntries(
        ["source_files", "events", "rate_limit_observations", "perf_samples"].map((table) => [
          table,
          store.database
            .prepare(`SELECT * FROM ${table} WHERE ${table === "source_files" ? "path" : "source_path"}=?`)
            .all(file),
        ]),
      );
    const before = fileSnapshot();
    assert.equal(before.perf_samples.length, 2);
    assert.ok(before.events.length > 0, "rollback must have actual usage rows to protect");

    for (const [code, bytes] of [
      ["MALFORMED_FRAME", Buffer.concat([original, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 1, 2, 3, 4, 5, 6, 7, 8])])],
      ["MALFORMED_JSON", Buffer.concat([original, zstdCompressSync(Buffer.from("{bad-json}\n"))])],
      [
        "UNSUPPORTED_SCHEMA",
        zstdCompressSync(Buffer.from(`${JSON.stringify({ type: "session", version: 3, id: "fixture-session-a" })}\n`)),
      ],
    ]) {
      const before = fileSnapshot();
      const fingerprints = store.database
        .prepare("SELECT value FROM store_meta WHERE key='perf_file_fingerprints'")
        .get().value;
      const indexVersion = store.summarize({ preset: "all" }).perf.indexVersion;
      writeFileSync(file, bytes);
      const brokenReport = await buildUsageReport(fixture.reportOptions);
      await store.sync({ options: fixture.reportOptions });
      const memory = summarizeUsage(brokenReport, { preset: "all" }).perf;
      const indexed = store.summarize({ preset: "all" }).perf;
      assertStatsParity(memory, indexed, code);
      for (const perf of [memory, indexed]) {
        assert.equal(perf.state, "degraded");
        assert.deepEqual(perf.degradedHomeIds, [homeId]);
        assert.deepEqual(perf.sourceWarnings, [{ sourceKind: "dsh", homeId, code, count: 1 }]);
        assertM45Expected(perf, fixture.expected.zcodeOnly);
        assert.ok(!perf.rankedHomeIds.includes(homeId));
      }
      assert.deepEqual(fileSnapshot(), before, "failed file replacement must rollback usage and perf together");
      assert.equal(
        store.database.prepare("SELECT value FROM store_meta WHERE key='perf_file_fingerprints'").get().value,
        fingerprints,
      );
      assert.equal(
        store.summarize({ preset: "all" }).perf.indexVersion,
        indexVersion,
        "failed file publication must keep the prior public version",
      );
      assert.equal(
        store.database.prepare("SELECT count(*) AS n FROM perf_samples WHERE source_kind='dsh'").get().n,
        4,
        "prior successful DSH candidates retained diagnostically, even though excluded from summary",
      );
      writeFileSync(file, original);
      await store.sync({ options: fixture.reportOptions });
      assert.equal(store.summarize({ preset: "all" }).perf.state, "ready");
      assertM45Expected(store.summarize({ preset: "all" }).perf, fixture.expected.all);
    }
  } finally {
    store.close();
    fixture.close();
  }
});

test("M4.5 published indexVersion tracks committed DSH files, including partial success and deletion", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode", "dsh"] });
  const store = new UsageStore({ ...fixture.serverOptions });
  const dshDirectory = path.join(fixture.reportOptions.homeDir, "dsh-fixture", "sessions", "fixture");
  const fileA = path.join(dshDirectory, "fixture-session-a", "session.v4.jsonl.zstd");
  const fileB = path.join(dshDirectory, "fixture-session-b", "session.v4.jsonl.zstd");
  const originalA = readFileSync(fileA);
  const fileC = path.join(dshDirectory, "fixture-session-c", "session.v4.jsonl.zstd");
  const appendedSession = [
    { type: "session", version: 4, id: "fixture-session-c", delegationDepth: 1, agentPreset: "fixture-worker" },
    {
      type: "request/header",
      time: 1_800_000_000_000,
      data: { header: { config: { model: "dsh-model", provider: "fixture-provider" } } },
    },
    { type: "step/start", time: 1_800_000_000_001, data: { turn: 1, step: 1 } },
    {
      type: "assistant/message",
      time: 1_800_000_001_001,
      data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 50 }, message: { content: "new-session" } },
    },
    { type: "step/end", time: 1_800_000_002_000, data: { turn: 1, step: 1 } },
  ];
  const pack = (rows) => Buffer.concat(rows.map((row) => zstdCompressSync(Buffer.from(`${JSON.stringify(row)}\n`))));
  try {
    await store.open();
    await store.sync({ options: fixture.reportOptions });
    const initialVersion = store.summarize({ preset: "all" }).perf.indexVersion;
    assert.match(initialVersion, /^[0-9a-f]{64}$/);

    // One file fails its transaction while a newly discovered sibling succeeds.
    appendFileSync(fileA, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 1, 2, 3, 4, 5, 6, 7, 8]));
    mkdirSync(path.dirname(fileC), { recursive: true });
    writeFileSync(fileC, pack(appendedSession));
    const partial = await store.sync({ options: fixture.reportOptions });
    const partialVersion = store.summarize({ preset: "all" }).perf.indexVersion;
    assert.equal(partial.perfState, "degraded");
    assert.notEqual(partialVersion, initialVersion, "successful sibling publication must enter the version");
    assert.equal(store.readPublishedFileFingerprints()[fileA] !== undefined, true, "failed file keeps old fingerprint");
    assert.equal(store.readPublishedFileFingerprints()[fileC] !== undefined, true, "new successful file is published");

    // Restore the failed file and remove the added file: both committed changes must alter the version.
    writeFileSync(fileA, originalA);
    await store.sync({ options: fixture.reportOptions });
    const recoveredVersion = store.summarize({ preset: "all" }).perf.indexVersion;
    assert.notEqual(recoveredVersion, partialVersion, "recovery publishes the repaired file content");
    unlinkSync(fileC);
    await store.sync({ options: fixture.reportOptions });
    const afterDeleteC = store.summarize({ preset: "all" }).perf.indexVersion;
    assert.notEqual(afterDeleteC, recoveredVersion, "missing-source diagnosis changes the published index version");
    assert.ok(
      store
        .summarize({ preset: "all" })
        .perf.missingSources.some((source) => source.path === fileC && source.kind === "dsh"),
      "deleted DSH file remains diagnosed as a missing source",
    );

    // DSH is multi-file: append one valid new turn to a single file and then delete the other.
    appendFileSync(
      fileA,
      pack([
        {
          type: "request/header",
          time: 1_800_000_010_000,
          data: { header: { config: { model: "dsh-model", provider: "fixture-provider" } } },
        },
        { type: "step/start", time: 1_800_000_010_001, data: { turn: 3, step: 1 } },
        {
          type: "assistant/message",
          time: 1_800_000_015_001,
          data: {
            turn: 3,
            step: 1,
            usage: { inputTokens: 10, outputTokens: 50 },
            message: { content: "new-turn" },
          },
        },
        { type: "step/end", time: 1_800_000_016_000, data: { turn: 3, step: 1 } },
      ]),
    );
    await store.sync({ options: fixture.reportOptions });
    const afterUpdateA = store.summarize({ preset: "all" }).perf.indexVersion;
    assert.notEqual(afterUpdateA, afterDeleteC, "successful update of one DSH file changes indexVersion");
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS n FROM perf_samples WHERE source_kind='dsh'").get().n,
      6,
      "source deletion retains its published perf samples",
    );
    unlinkSync(fileB);
    await store.sync({ options: fixture.reportOptions });
    const afterDeleteB = store.summarize({ preset: "all" }).perf.indexVersion;
    assert.notEqual(afterDeleteB, afterUpdateA, "deleting a different DSH file changes indexVersion");
    assert.ok(
      store
        .summarize({ preset: "all" })
        .perf.missingSources.some((source) => source.path === fileB && source.kind === "dsh"),
      "second deleted DSH file also remains diagnosed as missing",
    );
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS n FROM perf_samples WHERE source_kind='dsh'").get().n,
      6,
      "deleting another source keeps all published perf samples",
    );
    assert.equal((await store.sync({ options: fixture.reportOptions })).updatedFileCount, 0);
    assert.equal(store.summarize({ preset: "all" }).perf.indexVersion, afterDeleteB, "published version is stable");
  } finally {
    store.close();
    fixture.close();
  }
});

test("M4.5 nonfatal DSH warnings persist per file, clear on repair, and survive source deletion", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode", "dsh"] });
  const store = new UsageStore({ ...fixture.serverOptions });
  const files = ["fixture-session-a", "fixture-session-b"].map((id) =>
    path.join(fixture.reportOptions.homeDir, "dsh-fixture", "sessions", "fixture", id, "session.v4.jsonl.zstd"),
  );
  const originals = files.map((file) => readFileSync(file));
  const invalidIdentityFrame = zstdCompressSync(
    Buffer.from(`${JSON.stringify({ type: "step/start", time: BASE, data: { turn: "invalid", step: 1 } })}\n`),
  );
  try {
    for (const file of files) appendFileSync(file, invalidIdentityFrame);
    const warningBytes = files.map((file) => readFileSync(file));
    const report = await buildUsageReport(fixture.reportOptions);
    const memory = summarizeUsage(report, { preset: "all" }).perf;
    const reportHomeId = report.homes.find((home) => home.kind === "dsh").id;
    const expected = [{ sourceKind: "dsh", homeId: reportHomeId, code: "UNKEYABLE_RECORD", count: 2 }];
    assert.deepEqual(memory.sourceWarnings, expected);

    await store.open();
    await store.sync({ options: fixture.reportOptions });
    assert.deepEqual(store.summarize({ preset: "all" }).perf.sourceWarnings, expected);
    assert.equal(store.summarize({ preset: "all" }).perf.state, "ready", "identity diagnostics stay nonfatal");
    assert.deepEqual(store.readPublishedFileWarnings()[files[0]], [
      { sourceKind: "dsh", homeId: reportHomeId, code: "UNKEYABLE_RECORD", count: 1 },
    ]);
    assert.equal((await store.sync({ options: fixture.reportOptions })).updatedFileCount, 0);
    assert.deepEqual(
      store.summarize({ preset: "all" }).perf.sourceWarnings,
      expected,
      "repeat sync does not double count",
    );

    store.close();
    const reopened = new UsageStore({ ...fixture.serverOptions });
    try {
      await reopened.open();
      await reopened.sync({ options: fixture.reportOptions });
      assert.deepEqual(reopened.summarize({ preset: "all" }).perf.sourceWarnings, expected);
    } finally {
      reopened.close();
    }

    await store.open();
    const publishedWarningsA = store.readPublishedFileWarnings()[files[0]];
    appendFileSync(files[0], Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 1, 2, 3, 4, 5, 6, 7, 8]));
    await store.sync({ options: fixture.reportOptions });
    assert.deepEqual(
      store.readPublishedFileWarnings()[files[0]],
      publishedWarningsA,
      "failed replacement rolls diagnostics back",
    );
    assert.deepEqual(store.summarize({ preset: "all" }).perf.sourceWarnings, [
      { sourceKind: "dsh", homeId: reportHomeId, code: "MALFORMED_FRAME", count: 1 },
      { sourceKind: "dsh", homeId: reportHomeId, code: "UNKEYABLE_RECORD", count: 2 },
    ]);

    writeFileSync(files[0], warningBytes[0]);
    await store.sync({ options: fixture.reportOptions });
    assert.deepEqual(
      store.summarize({ preset: "all" }).perf.sourceWarnings,
      expected,
      "recovery retains reader counts",
    );
    writeFileSync(files[0], originals[0]);
    await store.sync({ options: fixture.reportOptions });
    const oneFileWarning = [{ sourceKind: "dsh", homeId: reportHomeId, code: "UNKEYABLE_RECORD", count: 1 }];
    assert.deepEqual(
      store.summarize({ preset: "all" }).perf.sourceWarnings,
      oneFileWarning,
      "repair clears only that file",
    );
    unlinkSync(files[1]);
    await store.sync({ options: fixture.reportOptions });
    const deleted = store.summarize({ preset: "all" }).perf;
    assert.ok(
      deleted.missingSources.some((source) => source.path === files[1] && source.kind === "dsh"),
      "deleted DSH file remains diagnosed as missing",
    );
    assert.deepEqual(deleted.sourceWarnings, oneFileWarning, "source deletion retains its warning component");

    writeFileSync(files[1], warningBytes[1]);
    await store.sync({ options: fixture.reportOptions });
    const restored = store.summarize({ preset: "all" }).perf;
    assert.equal(
      restored.missingSources.some((source) => source.path === files[1]),
      false,
      "restored DSH file clears its missing-source diagnosis",
    );
    assert.deepEqual(
      restored.sourceWarnings,
      oneFileWarning,
      "restoration keeps the reader warning without duplication",
    );
  } finally {
    store.close();
    fixture.close();
  }
});

test("M4.5 upgrades legacy indexes by backfilling missing per-file warning entries", async () => {
  for (const missingSidecar of ["global", "partial"]) {
    const fixture = createPerfIntegrationFixture({ sources: ["zcode", "dsh"] });
    let store = new UsageStore({ ...fixture.serverOptions });
    const files = ["fixture-session-a", "fixture-session-b"].map((id) =>
      path.join(fixture.reportOptions.homeDir, "dsh-fixture", "sessions", "fixture", id, "session.v4.jsonl.zstd"),
    );
    const invalidIdentityFrame = zstdCompressSync(
      Buffer.from(`${JSON.stringify({ type: "step/start", time: BASE, data: { turn: "invalid", step: 1 } })}\n`),
    );
    appendFileSync(files[0], invalidIdentityFrame);
    utimesSync(files[0], BASE / 1000, BASE / 1000);
    const sourceBytes = readFileSync(files[0]);
    const originalStat = statSync(files[0]);
    try {
      await store.open();
      await store.sync({ options: fixture.reportOptions });
      const expectedWarnings = store.summarize({ preset: "all" }).perf.sourceWarnings;
      assert.equal(expectedWarnings.length, 1);
      assert.equal(expectedWarnings[0].code, "UNKEYABLE_RECORD");

      const sourceRowsBefore = store.database
        .prepare("SELECT path,size,mtime_ms FROM source_files ORDER BY path")
        .all();
      assert.equal(sourceRowsBefore.length, 4, "fixture has two ZCode and two DSH physical files");
      const fingerprintsBefore = store.readPublishedFileFingerprints();
      const sampleKeysBefore = store.database.prepare("SELECT sample_key FROM perf_samples ORDER BY sample_key").all();
      const warningMap = store.readPublishedFileWarnings();
      assert.deepEqual(warningMap[files[0]], [
        {
          sourceKind: "dsh",
          homeId: expectedWarnings[0].homeId,
          code: "UNKEYABLE_RECORD",
          count: 1,
        },
      ]);

      if (missingSidecar === "global") {
        store.database.prepare("DELETE FROM store_meta WHERE key='perf_file_warnings'").run();
      } else {
        delete warningMap[files[0]];
        store.writeMeta("perf_file_warnings", JSON.stringify(warningMap));
      }
      store.writeMeta("perf_source_warnings", "[]");
      assert.equal(Object.hasOwn(store.readPublishedFileWarnings(), files[0]), false);

      store.close();
      store = new UsageStore({ ...fixture.serverOptions });
      await store.open();

      if (missingSidecar === "partial") {
        // A failed repair must leave this file's legacy diagnostic entry absent,
        // allowing recovery to retry even after its original bytes are restored.
        appendFileSync(files[0], Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 1, 2, 3, 4, 5, 6, 7, 8]));
        const failed = await store.sync({ options: fixture.reportOptions });
        assert.equal(failed.updatedFileCount, 0);
        assert.equal(Object.hasOwn(store.readPublishedFileWarnings(), files[0]), false);
        assert.deepEqual(
          store.database.prepare("SELECT sample_key FROM perf_samples ORDER BY sample_key").all(),
          sampleKeysBefore,
          "failed extraction keeps the last committed candidates",
        );

        writeFileSync(files[0], sourceBytes);
        utimesSync(files[0], originalStat.atimeMs / 1000, originalStat.mtimeMs / 1000);
        assert.equal(statSync(files[0]).mtimeMs, originalStat.mtimeMs, "restore the exact published source mtime");
        assert.deepEqual(readFileSync(files[0]), sourceBytes);
        assert.deepEqual(store.readPublishedFileFingerprints(), fingerprintsBefore);
      }

      const repaired = await store.sync({ options: fixture.reportOptions });
      assert.equal(repaired.updatedFileCount, missingSidecar === "global" ? 4 : 1);
      assert.deepEqual(
        store.readPublishedFileFingerprints(),
        fingerprintsBefore,
        "unchanged bytes retain fingerprints",
      );
      assert.deepEqual(
        store.database.prepare("SELECT path,size,mtime_ms FROM source_files ORDER BY path").all(),
        sourceRowsBefore,
        "diagnostic backfill does not alter usage source size/mtime rows",
      );
      assert.deepEqual(
        store.database.prepare("SELECT sample_key FROM perf_samples ORDER BY sample_key").all(),
        sampleKeysBefore,
      );
      assert.equal(Object.hasOwn(store.readPublishedFileWarnings(), files[0]), true);
      assert.deepEqual(store.summarize({ preset: "all" }).perf.sourceWarnings, expectedWarnings);
      assert.equal((await store.sync({ options: fixture.reportOptions })).updatedFileCount, 0);
      assert.deepEqual(store.summarize({ preset: "all" }).perf.sourceWarnings, expectedWarnings);
      console.log(
        `M4.5 legacy warning backfill=${missingSidecar}; updated=${repaired.updatedFileCount}; stable fingerprints/candidates and diagnostics`,
      );
    } finally {
      store.close();
      fixture.close();
    }
  }
});

test("M4.5 enabling DSH backfills unchanged files already indexed for usage exactly once", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode", "dsh"] });
  const store = new UsageStore({ ...fixture.serverOptions });
  const reader = PERF_SOURCE_READERS.get("dsh");
  try {
    await store.open();
    PERF_SOURCE_READERS.delete("dsh");
    try {
      await store.sync({ options: fixture.reportOptions });
    } finally {
      PERF_SOURCE_READERS.set("dsh", reader);
    }
    const paths = store.database
      .prepare("SELECT path,size,mtime_ms FROM source_files WHERE kind='dsh' ORDER BY path")
      .all();
    const disabledVersion = store.summarize({ preset: "all" }).perf.indexVersion;
    assert.equal(paths.length, 2);
    assert.equal(store.database.prepare("SELECT count(*) AS n FROM perf_samples WHERE source_kind='dsh'").get().n, 0);
    appendFileSync(
      paths[0].path,
      zstdCompressSync(
        Buffer.from(`${JSON.stringify({ type: "step/start", time: BASE, data: { turn: "invalid", step: 1 } })}\n`),
      ),
    );
    PERF_SOURCE_READERS.delete("dsh");
    try {
      await store.sync({ options: fixture.reportOptions });
      assert.equal(
        store.summarize({ preset: "all" }).perf.indexVersion,
        disabledVersion,
        "changed DSH files must not affect indexVersion while its reader is disabled",
      );
    } finally {
      PERF_SOURCE_READERS.set("dsh", reader);
    }
    const pathsBeforeBackfill = store.database
      .prepare("SELECT path,size,mtime_ms FROM source_files WHERE kind='dsh' ORDER BY path")
      .all();
    const result = await store.sync({ options: fixture.reportOptions });
    assert.equal(result.updatedFileCount, 2, "registering DSH must re-extract both unchanged files");
    assert.notEqual(store.summarize({ preset: "all" }).perf.indexVersion, disabledVersion);
    assertM45Expected(store.summarize({ preset: "all" }).perf, fixture.expected.all);
    assert.deepEqual(
      store.database.prepare("SELECT path,size,mtime_ms FROM source_files WHERE kind='dsh' ORDER BY path").all(),
      pathsBeforeBackfill,
    );
    assert.equal(
      (await store.sync({ options: fixture.reportOptions })).updatedFileCount,
      0,
      "successful empty/sampled extraction must not repeat",
    );
  } finally {
    PERF_SOURCE_READERS.set("dsh", reader);
    store.close();
    fixture.close();
  }
});

test("M4.5 successful zero-sample DSH backfill is not repeated; ordinary identity warning is nonfatal", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode", "dsh"] });
  const store = new UsageStore({ ...fixture.serverOptions });
  const reader = PERF_SOURCE_READERS.get("dsh");
  try {
    const files = ["fixture-session-a", "fixture-session-b"].map((id) =>
      path.join(fixture.reportOptions.homeDir, "dsh-fixture", "sessions", "fixture", id, "session.v4.jsonl.zstd"),
    );
    files.forEach((file, i) => {
      writeFileSync(
        file,
        zstdCompressSync(
          Buffer.from(
            `${JSON.stringify({
              type: "session",
              version: 4,
              id: `empty-${i}`,
              delegationDepth: 0,
            })}\n`,
          ),
        ),
      );
    });
    await store.open();
    PERF_SOURCE_READERS.delete("dsh");
    try {
      await store.sync({ options: fixture.reportOptions });
    } finally {
      PERF_SOURCE_READERS.set("dsh", reader);
    }
    const disabledVersion = store.summarize({ preset: "all" }).perf.indexVersion;
    assert.equal((await store.sync({ options: fixture.reportOptions })).updatedFileCount, 2);
    const zeroSampleVersion = store.summarize({ preset: "all" }).perf.indexVersion;
    assert.notEqual(zeroSampleVersion, disabledVersion, "zero-sample files still publish file fingerprints");
    assert.equal(store.database.prepare("SELECT count(*) AS n FROM perf_samples WHERE source_kind='dsh'").get().n, 0);
    for (const file of files) {
      assert.equal(
        Object.hasOwn(store.readPublishedFileWarnings(), file),
        true,
        "successful empty diagnostics publish []",
      );
      assert.deepEqual(store.readPublishedFileWarnings()[file], []);
    }
    assert.equal((await store.sync({ options: fixture.reportOptions })).updatedFileCount, 0);
    assert.equal(store.summarize({ preset: "all" }).perf.indexVersion, zeroSampleVersion);
    assert.equal(store.summarize({ preset: "all" }).perf.state, "ready");
    assertM45Expected(store.summarize({ preset: "all" }).perf, fixture.expected.zcodeOnly);
    const file = files[0];
    appendFileSync(
      file,
      zstdCompressSync(
        Buffer.from(
          `${JSON.stringify({ type: "step/start", time: 1791115200000, data: { turn: "invalid", step: 1 } })}\n`,
        ),
      ),
    );
    const warnings = [];
    const result = await streamPerfSamplesForFile(
      file,
      { id: "fixture-home", kind: "dsh", path: file },
      () => assert.fail("unkeyable step cannot be a sample"),
      { onWarning: (warning) => warnings.push(warning) },
    );
    assert.equal(result.state, "enabled");
    assert.deepEqual(warnings, [{ sourceKind: "dsh", homeId: "fixture-home", code: "UNKEYABLE_RECORD", count: 1 }]);
  } finally {
    PERF_SOURCE_READERS.set("dsh", reader);
    store.close();
    fixture.close();
  }
});

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sqliteFileSnapshot(file) {
  return ["", "-wal", "-shm"].map((suffix) => {
    const candidate = file + suffix;
    return existsSync(candidate)
      ? { suffix, hash: sha256File(candidate), size: statSync(candidate).size }
      : { suffix, absent: true };
  });
}

test("M4.6 OpenCode multi-database fixture has independent literal parity and collision-free identity", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode", "dsh", "opencode"] });
  const second = createPerfIntegrationFixture({ sources: ["zcode", "dsh", "opencode"] });
  const store = new UsageStore({ ...fixture.serverOptions });
  try {
    assert.equal(fixture.fixtureHash, second.fixtureHash);
    assert.deepEqual(fixture.expected, second.expected);
    const report = await buildUsageReport(fixture.reportOptions);
    assert.equal(report.homes.length, 4);
    assert.equal(report.perfSamples.length, fixture.expected.candidates);
    const opencodeHome = report.homes.find((home) => home.kind === "opencode");
    assert.ok(opencodeHome);
    const files = ["opencode.db", "opencode-extra.db"].map((name) => path.join(opencodeHome.path, name));
    const beforeRead = files.map((file) => sqliteFileSnapshot(file));
    const directSamples = [];
    const directWarnings = [];
    for (const file of files) {
      const result = await streamPerfSamplesForFile(file, opencodeHome, (sample) => directSamples.push(sample), {
        onWarning: (warning) => directWarnings.push(warning),
      });
      assert.equal(result.state, "enabled");
    }
    assert.deepEqual(
      files.map((file) => sqliteFileSnapshot(file)),
      beforeRead,
      "OpenCode perf reads do not mutate source bytes",
    );
    assert.equal(directSamples.length, fixture.expected.opencode.candidates);
    assert.equal(
      directWarnings.reduce((sum, warning) => sum + warning.count, 0),
      2,
    );
    assert.deepEqual(
      directWarnings.map(({ code, count }) => ({ code, count })),
      [{ code: "UNSUPPORTED_SCHEMA", count: 2 }],
    );
    const directIds = directSamples.map((sample) => JSON.parse(sample.sampleKey).at(-1));
    assert.ok(!directIds.includes("legacy-only"), "v1 rows are excluded");
    assert.ok(directIds.includes("unknown-version"), "unknown version remains a candidate");
    assert.equal(JSON.stringify(directSamples).includes("OPENCODE-INTEGRATION-BODY-SENTINEL"), false);

    const openSamples = report.perfSamples.filter((sample) => sample.sourceKind === "opencode");
    assert.equal(openSamples.length, 4);
    const identityOf = (sample) => JSON.parse(sample.sampleKey);
    const duplicates = openSamples.filter((sample) => identityOf(sample).at(-1) === "same-message");
    assert.equal(duplicates.length, 2, "same message id in separate databases remains two candidates");
    assert.notEqual(duplicates[0].sampleKey, duplicates[1].sampleKey);
    assert.notEqual(identityOf(duplicates[0]).at(-2), identityOf(duplicates[1]).at(-2));
    assert.ok(openSamples.every((sample) => sample.agentKind === "unknown"));
    assert.equal(
      openSamples.find((sample) => identityOf(sample).at(-1) === "legacy-only"),
      undefined,
    );
    const missingStreamed = openSamples.find((sample) => identityOf(sample).at(-1) === "missing-streamed");
    assert.ok(missingStreamed);
    assert.equal(missingStreamed.durationMs, null);
    assert.equal(missingStreamed.status, "completed");
    assert.ok(!perfFlagNamesOf(missingStreamed.sampleFlags).includes("TERMINAL_UNVERIFIED"));

    await store.open();
    await store.sync({ options: fixture.reportOptions });
    const reportPerf = (filters) => summarizeUsage(report, filters).perf;
    const indexedPerf = (filters) => store.summarize(filters).perf;
    const variants = [
      [fixture.expected.all, { preset: "all", now: new Date(fixture.expected.now) }],
      [
        fixture.expected.zcodeDshOnly,
        { preset: "all", now: new Date(fixture.expected.now), excludeHomes: [opencodeHome.id] },
      ],
      [
        fixture.expected.dayB,
        {
          preset: "custom",
          calendarZone: "utc",
          startDate: "2026-10-04",
          endDate: "2026-10-04",
          now: new Date(fixture.expected.now),
        },
      ],
    ];
    for (const [expected, filters] of variants) {
      const memory = reportPerf(filters);
      const indexed = indexedPerf(filters);
      assertStatsParity(memory, indexed, "M4.6 memory/index");
      for (const perf of [memory, indexed]) {
        assert.equal(perf.state, "ready");
        assertM45Expected(perf, expected);
        assert.equal(perf.coverage.eligible, perf.coverage.sampled + perf.coverage.dropped + perf.coverage.pending);
      }
    }
    const warnings = reportPerf({ preset: "all", now: new Date(fixture.expected.now) }).sourceWarnings;
    assert.deepEqual(warnings, [
      { sourceKind: "opencode", homeId: opencodeHome.id, code: "UNSUPPORTED_SCHEMA", count: 2 },
    ]);
    assert.equal(
      reportPerf({ preset: "all", now: new Date(fixture.expected.now) }).coverage.droppedByReason
        .duration_missing_nonpositive_invalid,
      2,
      "missing completed is a duration drop, not a terminal warning",
    );
    assert.equal(
      store.database.prepare("SELECT count(*) AS n FROM perf_samples WHERE source_kind='opencode'").get().n,
      4,
    );
    console.log(
      "M4.6 fixtureHash=" +
        fixture.fixtureHash +
        "; OpenCode DBs=2, physicalRows=5, candidates=4, duplicate message IDs stay distinct",
    );
  } finally {
    store.close();
    fixture.close();
    second.close();
  }
});

test("M4.6 OpenCode WAL-only changes publish once; read failure degrades only its home and rolls back", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode", "dsh", "opencode"] });
  const store = new UsageStore({ ...fixture.serverOptions });
  const realReader = PERF_SOURCE_READERS.get("opencode");
  let writer;
  try {
    await store.open();
    await store.sync({ options: fixture.reportOptions });
    const baselineVersion = store.summarize({ preset: "all" }).perf.indexVersion;
    const report = await buildUsageReport(fixture.reportOptions);
    const opencodeHome = report.homes.find((home) => home.kind === "opencode");
    const file = path.join(opencodeHome.path, "opencode-extra.db");
    const mainHashBefore = sha256File(file);
    writer = new DatabaseSync(file);
    writer.exec("PRAGMA journal_mode=WAL");
    writer.exec("PRAGMA wal_autocheckpoint=0");
    const walPath = `${file}-wal`;
    const walBefore = existsSync(walPath) ? sha256File(walPath) : null;
    const row = writer
      .prepare("SELECT data FROM session_message WHERE id=? AND session_id=?")
      .get("same-message", "oc-v2-second");
    const changedData = JSON.parse(row.data);
    changedData.tokens.output = 250;
    assert.equal(
      writer
        .prepare("UPDATE session_message SET data=? WHERE id=? AND session_id=?")
        .run(JSON.stringify(changedData), "same-message", "oc-v2-second").changes,
      1,
    );
    assert.equal(sha256File(file), mainHashBefore, "fixture WAL update leaves main database bytes unchanged");
    assert.ok(existsSync(walPath));
    const walHashAfter = sha256File(walPath);
    assert.notEqual(walHashAfter, walBefore, "WAL content changed");

    const failedFileBefore = {
      source: store.database.prepare("SELECT * FROM source_files WHERE path=?").get(file),
      samples: store.database
        .prepare(
          "SELECT sample_key, output_tokens, duration_ms FROM perf_samples WHERE source_path=? ORDER BY sample_key",
        )
        .all(file),
      fingerprint: store.readPublishedFileFingerprints()[file],
    };
    PERF_SOURCE_READERS.set("opencode", async (filePath, source, onSample, options) => {
      if (path.resolve(filePath) === path.resolve(file)) {
        const error = new Error("injected read-only open failure");
        error.code = "READ_ONLY_OPEN_FAILED";
        throw error;
      }
      return realReader(filePath, source, onSample, options);
    });
    const failedReport = await buildUsageReport(fixture.reportOptions);
    await store.sync({ options: fixture.reportOptions });
    const failedMemory = summarizeUsage(failedReport, { preset: "all", now: new Date(fixture.expected.now) }).perf;
    const failedIndex = store.summarize({ preset: "all", now: new Date(fixture.expected.now) }).perf;
    assertStatsParity(failedMemory, failedIndex, "M4.6 failed OpenCode file");
    for (const perf of [failedMemory, failedIndex]) {
      assert.equal(perf.state, "degraded");
      assert.deepEqual(perf.degradedHomeIds, [opencodeHome.id]);
      assert.deepEqual(perf.sourceWarnings, [
        { sourceKind: "opencode", homeId: opencodeHome.id, code: "READ_ONLY_OPEN_FAILED", count: 1 },
        { sourceKind: "opencode", homeId: opencodeHome.id, code: "UNSUPPORTED_SCHEMA", count: 2 },
      ]);
      assertM45Expected(perf, fixture.expected.zcodeDshOnly);
    }
    assert.deepEqual(
      store.database.prepare("SELECT * FROM source_files WHERE path=?").get(file),
      failedFileBefore.source,
    );
    assert.deepEqual(
      store.database
        .prepare(
          "SELECT sample_key, output_tokens, duration_ms FROM perf_samples WHERE source_path=? ORDER BY sample_key",
        )
        .all(file),
      failedFileBefore.samples,
      "failed physical-file replacement retains previously committed candidates",
    );
    assert.equal(store.readPublishedFileFingerprints()[file], failedFileBefore.fingerprint);
    assert.equal(store.summarize({ preset: "all" }).perf.indexVersion, baselineVersion);

    PERF_SOURCE_READERS.set("opencode", realReader);
    const recovered = await store.sync({ options: fixture.reportOptions });
    assert.equal(recovered.updatedFileCount, 1, "retry extracts only the WAL-changed physical database");
    const recoveredReport = await buildUsageReport(fixture.reportOptions);
    const memory = summarizeUsage(recoveredReport, { preset: "all", now: new Date(fixture.expected.now) }).perf;
    const indexed = store.summarize({ preset: "all", now: new Date(fixture.expected.now) }).perf;
    assertStatsParity(memory, indexed, "M4.6 recovered OpenCode file");
    assert.equal(memory.state, "ready");
    assert.notEqual(indexed.indexVersion, baselineVersion);
    assert.deepEqual(memory.sourceWarnings, [
      { sourceKind: "opencode", homeId: opencodeHome.id, code: "UNSUPPORTED_SCHEMA", count: 2 },
    ]);
    const changedGroup = memory.groups.find((group) => group.sourceKind === "opencode");
    assert.deepEqual(changedGroup.tps, { p10: 100 / 3, p50: 120, p90: 125, pooled: (470 * 1000) / 6000 });
    assert.deepEqual(changedGroup.sums, { outputTokens: 470, durationMs: 6000 });
    assert.equal(
      sha256File(file),
      mainHashBefore,
      "committed live candidate was read from WAL without main-file rewrite",
    );
    assert.equal(sha256File(walPath), walHashAfter, "committing the index does not checkpoint source WAL");
  } finally {
    PERF_SOURCE_READERS.set("opencode", realReader);
    writer?.close();
    store.close();
    fixture.close();
  }
});
// ★D5-BLOCK-START parity
// ---------------------------------------------------------------------------
// ★D5：`rankedHomeIds` 只读必要身份列（全局 vs 今日 + 陈旧候选 + 读路径阶段预算）
// ---------------------------------------------------------------------------

/** 夹具样本日（`createPerfCodexIntegrationFixture` 的 base = 2026-10-04T12:00:00Z + turn*10s）。 */
const D5_FIXED_NOW = "2026-10-04T13:00:00.000Z";
/** 样本日**之后**的一天 ⇒ "全局有可信样本、今日无样本" 的专用时点。 */
const D5_NEXT_DAY = "2026-10-05T12:00:00.000Z";
const D5_FULL_PREFIX = `SELECT ${PERF_SAMPLE_FIELDS.map((entry) => entry.column).join(", ")} FROM perf_samples`;
const D5_IDENTITY_SQL = "SELECT sample_key, source_kind, home_id FROM perf_samples";

/**
 * D5：把读路径的 `prepare` 按**阶段**计数（与 `D5/measure-d5.mjs` 同一手法）。
 * 归因依据是调用参数个数（取排名的调用不带界参数，统计块带）——不是行号、不是 SQL 内容猜测。
 */
function d5Instrument(store) {
  const phases = {
    ranking: {
      executions: 0,
      fullSampleExecutions: 0,
      identityExecutions: 0,
      decodedSamples: 0,
      decodedBytes: 0,
      identityRows: 0,
      identitySqls: [],
      fullSampleSqls: [],
    },
    stats: { executions: 0, fullSampleExecutions: 0, decodedSamples: 0, decodedBytes: 0 },
    other: { executions: 0 },
  };
  let phase = "other";
  const originalPrepare = store.database.prepare.bind(store.database);
  const bytesOf = (rows) =>
    rows.reduce(
      (total, row) =>
        total +
        (row === null || typeof row !== "object"
          ? 0
          : Object.values(row).reduce(
              (sum, value) => sum + (value === null || value === undefined ? 0 : Buffer.byteLength(String(value))),
              0,
            )),
      0,
    );
  const record = (sql, rows, executed = true) => {
    const bucket = phases[phase];
    if (executed) bucket.executions += 1;
    if (sql.startsWith(D5_FULL_PREFIX)) {
      if (executed) bucket.fullSampleExecutions += 1;
      bucket.decodedSamples += rows.length;
      bucket.decodedBytes += bytesOf(rows);
      if (executed && bucket.fullSampleSqls) bucket.fullSampleSqls.push(sql);
    } else if (sql === D5_IDENTITY_SQL) {
      if (executed) bucket.identityExecutions += 1;
      bucket.identityRows += rows.length;
      if (executed && bucket.identitySqls) bucket.identitySqls.push(sql);
    }
  };
  store.database.prepare = (sql) => {
    const text = String(sql);
    const statement = originalPrepare(sql);
    return {
      all: (...args) => {
        const rows = statement.all(...args);
        record(text, rows);
        return rows;
      },
      get: (...args) => {
        const row = statement.get(...args);
        record(text, row === undefined ? [] : [row]);
        return row;
      },
      run: (...args) => {
        const result = statement.run(...args);
        record(text, []);
        return result;
      },
      iterate: (...args) => {
        const iterator = statement.iterate(...args);
        return (function* iterateWrapped() {
          record(text, []);
          for (const row of iterator) {
            record(text, [row], false);
            yield row;
          }
        })();
      },
    };
  };
  const wrap = (name, phaseFor) => {
    if (typeof store[name] !== "function") return;
    const original = store[name].bind(store);
    store[name] = (...args) => {
      const previous = phase;
      phase = phaseFor(args);
      try {
        return original(...args);
      } finally {
        phase = previous;
      }
    };
  };
  wrap("perfCandidatesForRange", (args) => (args.length >= 2 ? "stats" : "ranking"));
  wrap("unplacedPerfSamples", (args) => (args.length >= 1 ? "stats" : "ranking"));
  wrap("perfSampleIdentities", () => "ranking");
  return phases;
}

/** D5 夹具：一个真实 Codex home（25 turn，样本全部落在 2026-10-04，线程身份 = fixture-codex-thread）。 */
async function d5CodexHomes(fixture) {
  const homes = await discoverUsageSources(fixture.reportOptions);
  assert.equal(homes.length, 1, "夹具只有一个 Codex home");
  return homes;
}

test("★D5-a 全局有可信样本、今日无样本：该 home 仍在默认排名里，两路径逐字一致", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  try {
    const homes = await d5CodexHomes(fixture);
    const homeId = homes[0].id;
    const report = await buildUsageReport({ ...fixture.reportOptions, homes });

    const memoryToday = summarizeUsage(report, { preset: "today", now: D5_NEXT_DAY }).perf;
    // 前置：今天**真的**没有样本（否则这个用例什么都没测到）
    assert.equal(memoryToday.coverage.eligible, 0, "今日范围内必须没有样本");
    assert.deepEqual(memoryToday.groups, [], "今日无样本 ⇒ 不给统计组");
    // 核心语义：排名是**全局**的 ⇒ 今日无样本的 home 不得从排名里消失
    assert.deepEqual(memoryToday.rankedHomeIds, [homeId], "全局有可信样本 ⇒ 排名仍含该 home");

    // 对照：换成样本当天 ⇒ 确实有排名与组（证明上面的 0 不是夹具坏了）
    const memoryAll = summarizeUsage(report, { preset: "all", now: D5_FIXED_NOW }).perf;
    assert.equal(memoryAll.coverage.eligible, 25);
    assert.equal(memoryAll.groups.length, 1);
    assert.deepEqual(memoryAll.rankedHomeIds, [homeId]);

    const store = new UsageStore({
      ...fixture.reportOptions,
      databaseFile: path.join(fixture.reportOptions.homeDir, "d5-a.sqlite"),
    });
    await store.open();
    try {
      await store.sync({ options: fixture.reportOptions });
      await fixture.seedRequestTiming(store);
      const indexedToday = store.summarize({ preset: "today", now: D5_NEXT_DAY }, {}).perf;
      assert.equal(indexedToday.coverage.eligible, 0, "索引路径：今日同样没有样本");
      assert.deepEqual(indexedToday.rankedHomeIds, [homeId], "索引路径：全局排名保留该 home");
      assert.deepEqual(indexedToday.rankedHomeIds, memoryToday.rankedHomeIds, "两路径 rankedHomeIds 逐字相同");
      assertStatsParity(memoryToday, indexedToday, "全局有样本、今日无样本");

      const indexedAll = store.summarize({ preset: "all", now: D5_FIXED_NOW }, {}).perf;
      assert.deepEqual(indexedAll.rankedHomeIds, memoryAll.rankedHomeIds);
      assertStatsParity(memoryAll, indexedAll, "样本当天");
    } finally {
      store.close();
    }
  } finally {
    fixture.close();
  }
});

test("★D5-b 失败 home 的陈旧候选：既不排名也不进可信统计（对照：只封别的线程 ⇒ 仍排名）", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  try {
    const homes = await d5CodexHomes(fixture);
    const homeId = homes[0].id;
    const store = new UsageStore({
      ...fixture.reportOptions,
      databaseFile: path.join(fixture.reportOptions.homeDir, "d5-b.sqlite"),
    });
    await store.open();
    try {
      await store.sync({ options: fixture.reportOptions });
      await fixture.seedRequestTiming(store);
      const baseline = store.summarize({ preset: "all", now: D5_FIXED_NOW }, {}).perf;
      assert.deepEqual(baseline.rankedHomeIds, [homeId], "前置：未受阻时该 home 在排名里");
      assert.equal(baseline.coverage.eligible, 25);
      const firstKey = store.database
        .prepare("SELECT sample_key FROM perf_samples WHERE source_kind = 'codex' LIMIT 1")
        .get().sample_key;
      const threadId = JSON.parse(String(firstKey))[2];
      assert.equal(threadId, "fixture-codex-thread", "夹具线程身份（排名过滤按它工作）");

      // ① 标退化 + 封住它**唯一的**线程 ⇒ 陈旧候选不得进入可信统计，也不得排名
      store.writePerfState("degraded", {
        degradedHomeIds: [homeId],
        sourceWarnings: [{ sourceKind: "codex", homeId, code: "LIVE_SOURCE_CHANGED", count: 1 }],
      });
      store.writeMeta(
        "perf_codex_publication_policy",
        encodeCodexPublicationPolicy([{ homeId, blockedThreadIds: [threadId] }]),
      );
      const blocked = store.summarize({ preset: "all", now: D5_FIXED_NOW }, {}).perf;
      assert.deepEqual(blocked.degradedHomeIds, [homeId]);
      assert.deepEqual(blocked.rankedHomeIds, [], "受阻 home 不得进默认排名");
      assert.equal(blocked.coverage.eligible, 0, "陈旧候选不得进可信统计");
      assert.deepEqual(blocked.groups, [], "陈旧候选不得成组");

      // ② 对照：部分许可只封**别的**线程 ⇒ 未被封的线程仍可排名/入统计
      store.writeMeta(
        "perf_codex_publication_policy",
        encodeCodexPublicationPolicy([{ homeId, blockedThreadIds: ["another-thread"] }]),
      );
      const permitted = store.summarize({ preset: "all", now: D5_FIXED_NOW }, {}).perf;
      assert.deepEqual(permitted.rankedHomeIds, [homeId], "部分许可：未被封的线程仍可排名");
      assert.equal(permitted.coverage.eligible, 25, "部分许可：未被封的候选仍进统计");

      // ③ 恢复 ready ⇒ 排名与统计回到基线
      store.writePerfState("ready", { degradedHomeIds: [] });
      store.writeMeta("perf_codex_publication_policy", "");
      const restored = store.summarize({ preset: "all", now: D5_FIXED_NOW }, {}).perf;
      assert.deepEqual(restored.rankedHomeIds, [homeId]);
      assert.equal(restored.coverage.eligible, 25);
    } finally {
      store.close();
    }
  } finally {
    fixture.close();
  }
});

test("★D5-c 读路径阶段预算：取排名只读身份列（0 次全列解码），统计块照旧解码", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  try {
    const homes = await d5CodexHomes(fixture);
    const homeId = homes[0].id;
    const store = new UsageStore({
      ...fixture.reportOptions,
      databaseFile: path.join(fixture.reportOptions.homeDir, "d5-c.sqlite"),
    });
    await store.open();
    try {
      await store.sync({ options: fixture.reportOptions });
      await fixture.seedRequestTiming(store);
      const total = store.database.prepare("SELECT COUNT(*) AS n FROM perf_samples").get().n;
      assert.equal(total, 25, "前置：25 个 Codex 样本");

      const phases = d5Instrument(store);
      const summary = store.summarize({ preset: "all", now: D5_FIXED_NOW }, {});
      assert.deepEqual(summary.perf.rankedHomeIds, [homeId]);

      const ranking = phases.ranking;
      assert.equal(ranking.executions, 1, "取排名只用 1 条语句");
      assert.equal(ranking.fullSampleExecutions, 0, "取排名不得执行全列样本查询（= 不得解码全量 sample JSON）");
      assert.equal(ranking.decodedSamples, 0);
      assert.equal(ranking.decodedBytes, 0);
      assert.equal(ranking.identityExecutions, 1);
      assert.deepEqual(ranking.identitySqls, [D5_IDENTITY_SQL], "身份查询就是那 3 列");
      assert.equal(ranking.identityRows, total, "身份查询覆盖全表（与旧实现 候选∪unplaced 同集）");

      const stats = phases.stats;
      assert.ok(stats.fullSampleExecutions >= 1, "统计块照旧走全列解码（采样集不变）");
      assert.ok(stats.decodedSamples >= total, `统计块解码行数 ${stats.decodedSamples} 应 ≥ 样本数 ${total}`);
      assert.ok(stats.decodedBytes > 0);

      // 身份投影与"候选 ∪ unplaced"逐行同集（这是"同一样本集"的直接证据）
      const identities = store.perfSampleIdentities();
      const union = [...store.perfCandidatesForRange(null), ...store.unplacedPerfSamples()]
        .map((sample) => sample.sampleKey)
        .sort();
      assert.deepEqual(
        identities.map((row) => row.sampleKey).sort(),
        union,
        "perfSampleIdentities 与旧实现的行集逐行相同",
      );
      assert.deepEqual(Object.keys(identities[0]).sort(), ["homeId", "sampleKey", "sourceKind"]);
    } finally {
      store.close();
    }
  } finally {
    fixture.close();
  }
});

test("C2 WorkBuddy：同值样本与异值冲突在 memory/index 两条路径一致", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "c2-workbuddy-parity-"));
  const homePath = path.join(root, ".workbuddy-ai");
  const projectDir = path.join(homePath, "projects", "fixture");
  const traceDir = path.join(homePath, "traces", "102284");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(traceDir, { recursive: true });
  const timestamp = Date.parse("2026-10-21T00:08:41.249Z");
  const usageRecord = (messageId) => ({
    timestamp,
    type: "function_call",
    providerData: {
      messageId,
      model: "deepseek-v4.1-flash",
      usage: {
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
        inputTokensDetails: [{ cached_tokens: 0 }],
        outputTokensDetails: [{ reasoning_tokens: 10 }],
      },
    },
    sessionId: "c2-session",
    cwd: "/work/c2",
  });
  const traceRow = (messageId, duration) => ({
    type: "span_end",
    span: {
      traceId: "trace_1",
      spanId: `span-${messageId}-${duration}`,
      name: "generation",
      type: "generation",
      endedAt: "2026-10-21T00:08:56.704Z",
      duration,
      status: "ok",
      toolOutput: JSON.stringify([{ id: messageId }]),
    },
  });
  const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

  try {
    writeFileSync(
      path.join(projectDir, "c2-session.jsonl"),
      jsonl([usageRecord("msg-same"), usageRecord("msg-conflict")]),
    );
    writeFileSync(
      path.join(traceDir, "trace_c2.jsonl"),
      jsonl([
        traceRow("msg-same", 900),
        traceRow("msg-same", 900),
        traceRow("msg-conflict", 800),
        traceRow("msg-conflict", 850),
      ]),
    );

    const options = { homeDir: root, env: {} };
    const homes = await discoverUsageSources(options);
    const workbuddyHome = homes.find((home) => home.kind === "workbuddy");
    assert.ok(workbuddyHome, "真实 discovery 必须发现 WorkBuddy home");
    const filters = { preset: "all", now: new Date("2026-10-21T01:00:00.000Z") };

    const report = await buildUsageReport({ homes: [workbuddyHome] });
    assert.equal(report.perfSamples.length, 1, "冲突 messageId 在内存路径不得产生候选");
    assert.match(report.perfSamples[0].sampleKey, /msg-same/);
    const memory = summarizeUsage(report, filters).perf;

    const store = new UsageStore({ homeDir: root, databaseFile: path.join(root, "usage-index.sqlite") });
    await store.open();
    try {
      await store.sync({ options });
      const indexed = store.summarize(filters).perf;
      assert.deepEqual(
        store.database
          .prepare("SELECT duration_ms FROM workbuddy_generation_duration_observations ORDER BY duration_ms")
          .all()
          .map((row) => row.duration_ms),
        [800, 850, 900],
      );
      assert.equal(
        Number(
          store.database.prepare("SELECT COUNT(*) AS n FROM perf_samples WHERE source_kind = 'workbuddy'").get().n,
        ),
        1,
      );
      assert.equal(memory.coverage.eligible, 1);
      assertStatsParity(memory, indexed, "C2 WorkBuddy same/conflict");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("C2 WorkBuddy：trace-only duration change moves memory candidates and indexVersion", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "c2-workbuddy-version-"));
  const homePath = path.join(root, ".workbuddy-ai");
  const projectDir = path.join(homePath, "projects", "fixture");
  const traceDir = path.join(homePath, "traces", "102284");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(traceDir, { recursive: true });
  const tracePath = path.join(traceDir, "trace_c2.jsonl");
  const timestamp = Date.parse("2026-10-21T00:08:41.249Z");
  const usageRecord = {
    timestamp,
    type: "function_call",
    providerData: {
      messageId: "msg-version",
      model: "deepseek-v4.1-flash",
      usage: {
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
        inputTokensDetails: [{ cached_tokens: 0 }],
        outputTokensDetails: [{ reasoning_tokens: 10 }],
      },
    },
    sessionId: "c2-version-session",
    cwd: "/work/c2-version",
  };
  const traceRow = (duration) => ({
    type: "span_end",
    span: {
      type: "generation",
      status: "ok",
      duration,
      endedAt: "2026-10-21T00:08:56.704Z",
      toolOutput: JSON.stringify([{ id: "msg-version" }]),
    },
  });

  try {
    writeFileSync(path.join(projectDir, "c2-version-session.jsonl"), `${JSON.stringify(usageRecord)}\n`);
    writeFileSync(tracePath, `${JSON.stringify(traceRow(800))}\n`);
    const options = { homeDir: root, env: {} };
    const workbuddyHome = (await discoverUsageSources(options)).find((home) => home.kind === "workbuddy");
    assert.ok(workbuddyHome);
    const filters = { preset: "all", now: new Date("2026-10-21T01:00:00.000Z") };

    const firstReport = await buildUsageReport({ homes: [workbuddyHome] });
    const first = summarizeUsage(firstReport, filters).perf;
    assert.equal(firstReport.perfSamples[0].durationMs, 800);
    assert.equal(first.state, "ready");
    assert.equal(first.coverage.eligible, 1);
    assert.match(String(first.indexVersion), /^[0-9a-f]{64}$/);

    writeFileSync(tracePath, `${JSON.stringify(traceRow(900))}\n`);
    const changedReport = await buildUsageReport({ homes: [workbuddyHome] });
    const changed = summarizeUsage(changedReport, filters).perf;
    assert.equal(changedReport.perfSamples[0].durationMs, 900);
    assert.equal(changed.state, "ready");
    assert.equal(changed.coverage.eligible, 1);
    assert.notEqual(changed.indexVersion, first.indexVersion);

    const repeated = summarizeUsage(await buildUsageReport({ homes: [workbuddyHome] }), filters).perf;
    assert.equal(repeated.indexVersion, changed.indexVersion);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
