/**
 * M0.1 探测外壳与来源模块的契约测试。
 *
 * 覆盖三件外壳职责：参数与目录守卫、来源结果的形状/脱敏校验、告警计数与投影。
 * 夹具一律使用**人工构造**的来源结果，不读取任何真实源；`test/perf-probe-sources/`
 * 下的合成模块只在进程内被动态 import，绝不写入仓库的 `scripts/perf-probe-sources/`。
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  DEFAULT_MAX_FILES,
  createRejectionCollector,
  DEFAULT_MAX_ROWS,
  FULL_SCAN_DISCOVERED_KEYS,
  FULL_SCAN_SCANNED_KEYS,
  RESERVED_DECISION_KEYS,
  METHOD_VERSION,
  PROBE_EXIT_CODES,
  PROBE_SOURCES,
  PROBE_VERSION,
  createWarningCollector,
  normalizeWarnings,
  parseProbeArgs,
  projectFingerprint,
  resolveRunOutputDirectory,
  runPerfProbe,
  scannedLooksEmpty,
  usageText,
  validateScanned,
  validateScalarMap,
} from "../scripts/perf-probe.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROBE_SCRIPT = path.join(REPO_ROOT, "scripts", "perf-probe.mjs");
const HEX = "a".repeat(64);

function makeRunDirectory() {
  const root = mkdtempSync(path.join(os.tmpdir(), "perf-probe-test-"));
  const runDirectory = path.join(root, "2026-10-04-perf-metrics", "testrun");
  mkdirSync(runDirectory, { recursive: true });
  return { root, runDirectory };
}

/** 在仓库外建一个合成来源模块，并把 `perf-probe-sources/` 目录接到该处。 */
function makeSyntheticRun({ source = PROBE_SOURCES[0], moduleSource = "", withModule = true } = {}) {
  const { root, runDirectory } = makeRunDirectory();
  const moduleDirectory = path.join(root, "perf-probe-sources");
  mkdirSync(moduleDirectory, { recursive: true });
  const modulePath = path.join(moduleDirectory, `${source}.mjs`);
  if (withModule) writeFileSync(modulePath, moduleSource, "utf8");
  return {
    root,
    runDirectory,
    modulePath,
    source,
    // 来源模块目录与输出根都必须落在**系统临时目录**内：产品守卫只允许把结果写进仓库的
    // docs/validation，所以测试直接调用 runPerfProbe 并同时覆盖 outputRoot 与 sourceModuleRoot，
    // 而不是复刻一份守卫逻辑。
    validationRoot: root,
    sourceModuleRoot: pathToFileURL(`${moduleDirectory}${path.sep}`),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function makeValidResult(overrides = {}) {
  return {
    scanned: { files: 2, rowsScanned: 40 },
    fields: { columns: { status: "present", output_tokens: "present" } },
    decisions: { schemaKind: "zcode-sqlite" },
    sourceFingerprintBefore: { fingerprint: HEX, fileCount: 2 },
    sourceFingerprintAfter: { fingerprint: HEX, fileCount: 2 },
    warnings: [{ code: "MALFORMED_JSON", count: 1 }],
    liveSourceChanged: false,
    ...overrides,
  };
}

function syntheticModule(resultExpression, { exportProbe = true } = {}) {
  const exportLine = exportProbe
    ? `export async function probe() { return ${resultExpression}; }`
    : "export const other = 1;";
  return `${exportLine}\n`;
}

async function runSynthetic(resultExpression, { source, exportProbe, argvExtra = [], withModule = true } = {}) {
  const workspace = makeSyntheticRun({
    source,
    withModule,
    moduleSource: withModule ? syntheticModule(resultExpression, { exportProbe }) : "",
  });
  try {
    const lines = [];
    const exitCode = await runPerfProbe(
      ["--source", workspace.source, "--output", workspace.runDirectory, ...argvExtra],
      {
        log: (line) => lines.push(line),
        outputRoot: workspace.validationRoot,
        sourceModuleRoot: workspace.sourceModuleRoot,
      },
    );
    const outputFile = path.join(workspace.runDirectory, `${workspace.source}-probe.json`);
    const envelope = existsSync(outputFile) ? JSON.parse(readFileSync(outputFile, "utf8")) : null;
    return { exitCode, envelope, lines, workspace };
  } finally {
    workspace.cleanup();
  }
}

// ---------------------------------------------------------------- 参数与目录守卫

test("PROBE_SOURCES 与默认有界参数符合卡约定", () => {
  assert.deepEqual([...PROBE_SOURCES], ["zcode", "dsh", "opencode", "codex"]);
  assert.equal(DEFAULT_MAX_FILES, 4);
  assert.equal(DEFAULT_MAX_ROWS, 200);
  assert.equal(PROBE_VERSION, "1");
  assert.equal(METHOD_VERSION, "tps-v1");
  assert.deepEqual([...RESERVED_DECISION_KEYS], ["full", "maxFiles", "maxRows"]);
  // 全量按"已发现文件是否全部扫描"判定，不得存在固定数量门槛。
  assert.deepEqual([...FULL_SCAN_DISCOVERED_KEYS], ["filesDiscovered", "discoveredFiles"]);
  assert.deepEqual([...FULL_SCAN_SCANNED_KEYS], ["filesScanned", "scannedFiles"]);
  assert.equal(RESERVED_DECISION_KEYS.includes("filesDiscovered"), false, "全量计数不是外壳独占的参数键");
});

test("parseProbeArgs 接受长参数与 = 内联形式，并记录是否显式给出上限", () => {
  const separate = parseProbeArgs(["--source", "zcode", "--output", "out", "--max-rows", "7"]);
  assert.deepEqual(
    { source: separate.source, maxRows: separate.maxRows, maxFiles: separate.maxFiles, full: separate.full },
    { source: "zcode", maxRows: 7, maxFiles: DEFAULT_MAX_FILES, full: false },
  );
  assert.equal(separate.maxRowsExplicit, true);
  assert.equal(separate.maxFilesExplicit, false);

  const inline = parseProbeArgs(["--source=dsh", "--output=out", "--max-files=3"]);
  assert.equal(inline.source, "dsh");
  assert.equal(inline.output, "out");
  assert.equal(inline.maxFiles, 3);

  assert.equal(parseProbeArgs(["--help"]).help, true);
});

test("parseProbeArgs 拒绝未知选项、缺取值、非法上限与 --full 互斥", () => {
  const cases = [
    [["--bogus"], "UNKNOWN_OPTION"],
    [["--source"], "MISSING_OPTION_VALUE"],
    [["--source", "zcode", "--max-rows", "0"], "INVALID_MAX_ROWS"],
    [["--source", "zcode", "--max-files", "1.5"], "INVALID_MAX_FILES"],
    [["--source", "zcode", "--max-rows", "9007199254740992"], "INVALID_MAX_ROWS"],
    [["--source", "zcode", "--full", "--max-rows", "5"], "CONFLICTING_LIMITS"],
    [["--source", "zcode", "--full", "--max-files", "5"], "CONFLICTING_LIMITS"],
  ];
  for (const [argv, code] of cases) {
    assert.throws(
      () => parseProbeArgs(argv),
      (error) => error.code === code && error.exitCode === PROBE_EXIT_CODES.usage,
      `期望 ${code}`,
    );
  }
});

test("resolveRunOutputDirectory 只接受 <日期>-perf-metrics/<runId> 之内", () => {
  const validationRoot = path.join(REPO_ROOT, "docs", "validation");
  const accepted = resolveRunOutputDirectory(path.join(validationRoot, "2026-10-04-perf-metrics", "20261004T035100"), {
    validationRoot,
  });
  assert.equal(accepted, path.join(validationRoot, "2026-10-04-perf-metrics", "20261004T035100"));
  // 子目录仍在该 run 之内
  assert.ok(
    resolveRunOutputDirectory(path.join(validationRoot, "2026-10-04-perf-metrics", "r", "sub"), { validationRoot }),
  );

  const rejected = [
    [path.join(validationRoot, "..", "plans"), "OUTPUT_OUTSIDE_VALIDATION"],
    [validationRoot, "OUTPUT_OUTSIDE_VALIDATION"],
    [path.join(validationRoot, "2026-10-03-other-run"), "OUTPUT_NOT_PERF_METRICS_RUN"],
    ["", "MISSING_OUTPUT"],
  ];
  for (const [value, code] of rejected) {
    assert.throws(
      () => resolveRunOutputDirectory(value, { validationRoot }),
      (error) => error.code === code,
      `期望 ${code} for ${value}`,
    );
  }
});

test("usageText 覆盖四来源、退出码表与结果校验说明", () => {
  const text = usageText();
  for (const source of PROBE_SOURCES) assert.match(text, new RegExp(source));
  for (const code of Object.values(PROBE_EXIT_CODES)) assert.match(text, new RegExp(` ${code} `));
  assert.match(text, /PROBE_RESULT_INVALID/);
  assert.match(text, /fieldRejections/);
  assert.match(text, /不输出源路径/);
});

// ---------------------------------------------------------------- 告警计数与溢出

test("createWarningCollector 拒绝单次非法计数", () => {
  const collector = createWarningCollector();
  assert.equal(collector.warn("MALFORMED_JSON", 3), true);
  assert.equal(collector.warn("malformed_json", 1), false);
  assert.equal(collector.warn("HAS SPACE", 1), false);
  assert.equal(collector.warn("OK_CODE", 0), false);
  assert.equal(collector.warn("OK_CODE", -1), false);
  assert.equal(collector.warn("OK_CODE", 1.5), false);
  assert.equal(collector.warn("OK_CODE", Number.MAX_SAFE_INTEGER + 1), false);
  assert.deepEqual(collector.list(), [{ code: "MALFORMED_JSON", count: 3 }]);
});

test("createWarningCollector 拒绝累加后的非安全整数（审核复现项）", () => {
  const collector = createWarningCollector();
  const half = Number.MAX_SAFE_INTEGER - 1;
  assert.equal(collector.warn("AGGREGATE_OVERFLOW", half), true);
  assert.equal(collector.warn("AGGREGATE_OVERFLOW", 2), false, "累加越过最大安全整数必须被拒绝");
  const [entry] = collector.list();
  assert.equal(Number.isSafeInteger(entry.count), true);
  assert.equal(entry.count, half);

  // 恰好累加到最大安全整数仍然允许
  const exact = createWarningCollector();
  assert.equal(exact.warn("EDGE", 1), true);
  assert.equal(exact.warn("EDGE", Number.MAX_SAFE_INTEGER - 1), true);
  assert.equal(exact.list()[0].count, Number.MAX_SAFE_INTEGER);
});

test("normalizeWarnings 丢弃非法项、计数丢弃数，且不泄漏原文", () => {
  const { warnings, dropped } = normalizeWarnings([
    { code: "MALFORMED_JSON", count: 3 },
    { code: "MALFORMED_JSON", count: 2 },
    { code: "bad code", count: 1 },
    { code: "TRAILING_PATH", count: 0 },
    "C:/Users/someone/.codex/sessions/rollout.jsonl",
    { count: 5 },
    { code: "MAXED", count: Number.MAX_SAFE_INTEGER },
    { code: "MAXED", count: 1 },
  ]);
  assert.deepEqual(warnings, [
    { code: "MALFORMED_JSON", count: 5 },
    { code: "MAXED", count: Number.MAX_SAFE_INTEGER },
  ]);
  assert.equal(dropped, 5, "越界累加与非法项都算丢弃");
  assert.doesNotMatch(JSON.stringify({ warnings, dropped }), /Users|sessions|jsonl/);
});

// ---------------------------------------------------------------- 脱敏投影

test("projectFingerprint 只放行摘要与计数，路径与原始 ID 被拒绝", () => {
  const rejections = createRejectionCollector();
  const projected = projectFingerprint(
    {
      fingerprint: HEX,
      pathFingerprint: "/home/u/.codex/sessions/a.jsonl",
      contentFingerprint: "synthetic:rollout-a",
      fileCount: 12,
      homeCount: 1,
      checkedAt: "2026-10-04T03:51:00.000Z",
      extra: "ignored",
    },
    {},
    rejections,
  );
  assert.deepEqual(projected, {
    fingerprint: HEX,
    contentFingerprint: "synthetic:rollout-a",
    fileCount: 12,
    homeCount: 1,
    checkedAt: "2026-10-04T03:51:00.000Z",
  });
  assert.deepEqual(rejections.list(), [{ category: "fingerprint-value-rejected", count: 1 }]);
  assert.doesNotMatch(JSON.stringify(projected), /\.codex|sessions|jsonl|\/home/);
});

test("validateScanned 的计数键只接受非负安全整数，布尔不得冒充计数（本轮审核复现项）", () => {
  const rejections = createRejectionCollector();
  const scanned = validateScanned(
    { files: true, rowsScanned: false, filesDiscovered: true, truncated: true },
    {},
    rejections,
  );
  // 布尔冒充计数一律拒绝；truncated 是真布尔键，照常放行。
  assert.deepEqual(scanned, { truncated: true });
  assert.deepEqual(rejections.list(), [{ category: "scanned-value-rejected", count: 3 }]);

  const strict = createRejectionCollector();
  const other = validateScanned(
    { files: 1, rowsScanned: 2, filesDiscovered: 0, filesScanned: -1, rows: "10", homes: 1.5 },
    {},
    strict,
  );
  // 非整数（1.5）、负数、字符串计数全部拒绝。
  assert.deepEqual(other, { files: 1, rowsScanned: 2, filesDiscovered: 0 });
  assert.deepEqual(strict.list(), [{ category: "scanned-value-rejected", count: 3 }]);
});

test("计数键喂布尔时探测不得记为 ok（端到端）", async () => {
  const { exitCode, envelope } = await runSynthetic(
    JSON.stringify(makeValidResult({ scanned: { files: true, rowsScanned: false } })),
    { source: "zcode" },
  );
  assert.equal(exitCode, PROBE_EXIT_CODES.failed, "布尔计数被拒后 scanned 为空，不得记为 ok");
  assert.equal(envelope.status, "failed");
  assert.equal(envelope.errorCode, "PROBE_RESULT_INVALID");
  assert.equal(envelope.decisions.invalidReason, "scanned-missing");
  assert.deepEqual(envelope.scanned, {});
});

test("validateScanned 只接受白名单字段名、计数、布尔与 sources 映射", () => {
  const rejections = createRejectionCollector();
  const scanned = validateScanned(
    {
      files: 3,
      rowsScanned: 30,
      truncated: true,
      sources: { zcode: 1, "bad kind": 2, dsh: 3 },
      alice123: 1,
      filesScannedPath: "/tmp/x",
      rows: [1, 2, 3],
      negative: -1,
      nested: { deeper: 1 },
    },
    {},
    rejections,
  );
  assert.deepEqual(scanned, {
    files: 3,
    rowsScanned: 30,
    truncated: true,
    sources: { zcode: 1, dsh: 3 },
  });
  assert.deepEqual(rejections.list(), [
    { category: "scanned-sources-rejected", count: 1 },
    { category: "scanned-unknown-field-rejected", count: 4 },
    { category: "scanned-value-rejected", count: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(scanned), /tmp\/x|alice123/);
  // 拒绝项里绝不能出现来源提供的键名。
  assert.doesNotMatch(JSON.stringify(rejections.list()), /filesScannedPath|bad kind|nested|negative|rows|alice123/);
});

test("validateScanned 拒绝非白名单字段名，短 ID 也不行（审核复现项）", () => {
  const rejections = createRejectionCollector();
  const scanned = validateScanned(
    { files: 1, alice123: 1, "0193f0c2-1234-7000-8000-abcdefabcdef": 1, userId: 7 },
    {},
    rejections,
  );
  assert.deepEqual(scanned, { files: 1 });
  assert.deepEqual(rejections.list(), [{ category: "scanned-unknown-field-rejected", count: 3 }]);
  assert.doesNotMatch(JSON.stringify(rejections.list()), /alice123|0193f0c2|userId/);
});

test("validateScalarMap 按字段名白名单放行，未知字段一律拒绝（审核复现项）", () => {
  const rejections = createRejectionCollector();
  const values = validateScalarMap(
    {
      timingKind: "request_e2e",
      tokenScope: "reported_output_unspecified",
      // 审核复现：短 ID 完全符合任何合理的形状正则，仍必须被拒。
      agent: "alice123",
      runner: "alice123",
      userId: 42,
      sessionId: "abc",
    },
    {},
    "fields",
    rejections,
  );
  assert.deepEqual(values, {
    timingKind: "request_e2e",
    tokenScope: "reported_output_unspecified",
  });
  assert.deepEqual(rejections.list(), [{ category: "fields-unknown-field-rejected", count: 4 }]);
  assert.doesNotMatch(JSON.stringify(rejections.list()), /agent|runner|userId|sessionId|alice123/);
});

test("validateScalarMap 对穷举枚举键拒绝白名单外的值，UUID 与路径被拒", () => {
  const rejections = createRejectionCollector();
  const values = validateScalarMap(
    {
      timingKind: "item_span_estimate",
      tokenScope: "reported_output_unspecified",
      maxRows: 200,
      // 穷举枚举键喂自造值 → 值被拒
      backend: "sqlite-custom",
      // 计数键喂字符串 → 值被拒
      sampleCount: "12",
      // 未知字段名 + 各种载体
      sessionId: "C:/Users/someone/.codex/sessions/2026/rollout-abc.jsonl",
      threadId: "0193f0c2-1234-7000-8000-abcdefabcdef",
      hexDigest: "c72ecc613f21c1226bd2d44e85cd0310cade166885407deb91d3ea8b5b0cc978",
      list: ["a"],
    },
    {},
    "fields",
    rejections,
  );
  assert.deepEqual(values, {
    timingKind: "item_span_estimate",
    tokenScope: "reported_output_unspecified",
    maxRows: 200,
  });
  assert.deepEqual(rejections.list(), [
    { category: "fields-unknown-field-rejected", count: 4 },
    { category: "fields-value-rejected", count: 2 },
  ]);
  assert.doesNotMatch(JSON.stringify(values), /Users|sessions|rollout|0193f0c2|c72ecc61/);
});

test("validateScalarMap 拒绝非标识符键名，且不把键名写进拒绝项", () => {
  const rejections = createRejectionCollector();
  const values = validateScalarMap(
    {
      timingKind: "request_e2e",
      "/home/u/.codex/sessions/a.jsonl": "present",
      "0193f0c2-1234-7000-8000-abcdefabcdef": 1,
      "Key With Spaces": "present",
    },
    {},
    "fields",
    rejections,
  );
  assert.deepEqual(values, { timingKind: "request_e2e" });
  assert.deepEqual(rejections.list(), [{ category: "fields-key-rejected", count: 3 }]);
  assert.doesNotMatch(JSON.stringify(rejections.list()), /home|codex|sessions|0193f0c2|Spaces/);
});

test("validateScalarMap 支持结构化容器：逐列存在性只接受已知列名与三态值", () => {
  const rejections = createRejectionCollector();
  const values = validateScalarMap(
    {
      columns: {
        status: "present",
        output_tokens: "present",
        duration_ms: "absent",
        // 未知列名 —— 可能是路径或 ID 的载体
        "/home/u/.codex/a.jsonl": "present",
        alice123: "present",
        // 已知列名但值非法
        id: "C:/Users/someone/.codex/sessions/a.jsonl",
        session_id: "unknown", // 合法
      },
      columnStates: { present: 3, absent: 1, unknown: 1, total: 5 },
    },
    {},
    "fields",
    rejections,
  );
  assert.deepEqual(values, {
    columns: { status: "present", output_tokens: "present", duration_ms: "absent", session_id: "unknown" },
    columnStates: { present: 3, absent: 1, unknown: 1, total: 5 },
  });
  assert.deepEqual(rejections.list(), [{ category: "fields-unknown-field-rejected", count: 3 }]);
  const evidence = JSON.stringify(values);
  assert.doesNotMatch(evidence, /home|codex|Users|alice123|jsonl/);
});

test("validateScalarMap 拒绝结构化容器的非法子键与非法类型", () => {
  const rejections = createRejectionCollector();
  const values = validateScalarMap(
    {
      columnStates: { present: 1, evilKey: 2, absent: true, unknown: -1 },
      requiredColumns: { status: "present", timestamp: "present" }, // timestamp 不在已知列名内
    },
    {},
    "fields",
    rejections,
  );
  assert.deepEqual(values, {
    columnStates: { present: 1 },
    requiredColumns: { status: "present" },
  });
  assert.deepEqual(rejections.list(), [{ category: "fields-unknown-field-rejected", count: 4 }]);

  // 容器本身不是对象时整块拒绝，不写空对象。
  const empty = createRejectionCollector();
  const none = validateScalarMap({ columns: "present", columnStates: [] }, {}, "fields", empty);
  assert.deepEqual(none, {});
  assert.deepEqual(empty.list(), [{ category: "fields-unknown-field-rejected", count: 2 }]);

  // 子键全部被拒时也不留空对象。
  const allBad = createRejectionCollector();
  const dropped = validateScalarMap({ columns: { bogus: "present" } }, {}, "fields", allBad);
  assert.deepEqual(dropped, {});
  assert.deepEqual(allBad.list(), [{ category: "fields-unknown-field-rejected", count: 1 }]);
});

test("validateScalarMap 的 decisions 结构化容器只接受 §3 告警码与 §17.4 flag", () => {
  const rejections = createRejectionCollector();
  const values = validateScalarMap(
    {
      warningCounts: { MALFORMED_JSON: 3, UNKEYABLE_RECORD: 1, "/home/u/a": 9, bogusCode: 2 },
      flagCounts: { OUTPUT_ZERO: 4, RECORD_CONFLICT: 2, NOT_A_FLAG: 1 },
      schemaKind: "codex-jsonl",
    },
    {},
    "decisions",
    rejections,
  );
  assert.deepEqual(values, {
    warningCounts: { MALFORMED_JSON: 3, UNKEYABLE_RECORD: 1 },
    flagCounts: { OUTPUT_ZERO: 4, RECORD_CONFLICT: 2 },
    schemaKind: "codex-jsonl",
  });
  assert.deepEqual(rejections.list(), [{ category: "decisions-unknown-field-rejected", count: 3 }]);
  assert.doesNotMatch(JSON.stringify(values), /home|bogusCode|NOT_A_FLAG/);
});

test("四源实际需要的契约取值全部放行（开放并行前的冻结校验）", () => {
  // 方案 §17.1:220 的 tokenScope 三值——Codex 与 OpenCode 要用的值必须在册，
  // 否则 M0.4/M0.5 无法落盘 tokenScope 决议。
  for (const value of ["reported_output_includes_reasoning", "visible_plus_reasoning", "reported_output_unspecified"]) {
    const rejections = createRejectionCollector();
    assert.equal(validateScalarMap({ tokenScope: value }, {}, "fields", rejections).tokenScope, value, value);
    assert.deepEqual(rejections.list(), [], value);
  }
  // methodVersion 含连字符，不能走只认下划线的自由枚举。
  const version = createRejectionCollector();
  assert.deepEqual(validateScalarMap({ methodVersion: METHOD_VERSION }, {}, "fields", version), {
    methodVersion: METHOD_VERSION,
  });
  assert.deepEqual(version.list(), []);
  // 方案 §17.4 的 flag 与 §3 的告警码都含下划线/大写，必须能被容器承载。
  const structured = createRejectionCollector();
  assert.deepEqual(
    validateScalarMap(
      {
        warningCounts: { MALFORMED_JSON: 3, UNKEYABLE_RECORD: 1 },
        flagCounts: { OUTPUT_ZERO: 1, PARTIAL_ITEM_SPAN: 2 },
      },
      {},
      "decisions",
      structured,
    ),
    {
      warningCounts: { MALFORMED_JSON: 3, UNKEYABLE_RECORD: 1 },
      flagCounts: { OUTPUT_ZERO: 1, PARTIAL_ITEM_SPAN: 2 },
    },
  );
  assert.deepEqual(structured.list(), []);
  // M0.5 的三选一决议。
  const verdict = createRejectionCollector();
  assert.equal(
    validateScalarMap({ sourceVerdict: "OPTIONAL_SQLITE_WORTHWHILE" }, {}, "decisions", verdict).sourceVerdict,
    "OPTIONAL_SQLITE_WORTHWHILE",
  );
  assert.deepEqual(verdict.list(), []);
});

test("ZCode 的 19 个点名列都能进逐列存在性容器", () => {
  const rejections = createRejectionCollector();
  const zcodeColumns = [
    "id",
    "session_id",
    "model_id",
    "provider_id",
    "variant",
    "agent",
    "query_source",
    "task_type",
    "status",
    "attempt_index",
    "retry_count",
    "retryable",
    "cancelled_by_user",
    "started_at",
    "completed_at",
    "duration_ms",
    "input_tokens",
    "output_tokens",
    "logical_request_id",
  ];
  const values = validateScalarMap(
    { columns: Object.fromEntries(zcodeColumns.map((name) => [name, "present"])) },
    {},
    "fields",
    rejections,
  );
  assert.deepEqual(Object.keys(values.columns).sort(), [...zcodeColumns].sort());
  assert.deepEqual(rejections.list(), [], "M0.2 点名的列一个都不能被拒");
});

test("decisions 的外壳独占键被来源改写时拒绝", () => {
  const rejections = createRejectionCollector();
  const values = validateScalarMap(
    { full: true, maxFiles: 999, maxRows: 99999, filesDiscovered: 4, filesScanned: 4, schemaKind: "codex-jsonl" },
    {},
    "decisions",
    rejections,
    { reservedKeys: RESERVED_DECISION_KEYS },
  );
  assert.deepEqual(values, { filesDiscovered: 4, filesScanned: 4, schemaKind: "codex-jsonl" });
  assert.deepEqual(rejections.list(), [{ category: "decisions-reserved-key-rejected", count: 3 }]);
});

test("scannedLooksEmpty 把空对象与数组判为无效形状", () => {
  assert.equal(scannedLooksEmpty({}), true);
  assert.equal(scannedLooksEmpty(undefined), true);
  assert.equal(scannedLooksEmpty([]), true);
  assert.equal(scannedLooksEmpty({ files: 0 }), false);
});

// ---------------------------------------------------------------- 端到端 exit 与结果校验

test("缺少来源模块时 exit 3 且仍写结果文件", async () => {
  const { exitCode, envelope } = await runSynthetic("null", { source: "zcode", withModule: false });
  assert.equal(exitCode, PROBE_EXIT_CODES.unavailable);
  assert.equal(envelope.status, "failed");
  assert.equal(envelope.errorCode, "SOURCE_MODULE_MISSING");
  assert.equal(envelope.exitCode, PROBE_EXIT_CODES.unavailable);
});

test("来源模块缺少 probe() 导出时 exit 4", async () => {
  const { exitCode, envelope } = await runSynthetic("null", { source: "dsh", exportProbe: false });
  assert.equal(exitCode, PROBE_EXIT_CODES.failed);
  assert.equal(envelope.errorCode, "PROBE_EXPORT_MISSING");
});

test("有效来源结果被记为 ok 并保留形状", async () => {
  const { exitCode, envelope } = await runSynthetic(JSON.stringify(makeValidResult()), { source: "zcode" });
  assert.equal(exitCode, PROBE_EXIT_CODES.ok);
  assert.equal(envelope.status, "ok");
  assert.deepEqual(envelope.scanned, { files: 2, rowsScanned: 40 });
  assert.deepEqual(envelope.fields, { columns: { status: "present", output_tokens: "present" } });
  assert.equal(envelope.decisions.schemaKind, "zcode-sqlite");
  assert.equal(envelope.decisions.full, false);
  assert.equal(envelope.sourceFingerprintBefore.fingerprint, HEX);
  assert.equal(envelope.liveSourceChanged, false);
  assert.deepEqual(envelope.fieldRejections, []);
  assert.deepEqual(envelope.warnings, [{ code: "MALFORMED_JSON", count: 1 }]);
});

test("空 scanned 不得记为 ok（审核复现项）", async () => {
  const { exitCode, envelope } = await runSynthetic(JSON.stringify(makeValidResult({ scanned: {} })), {
    source: "zcode",
  });
  assert.equal(exitCode, PROBE_EXIT_CODES.failed);
  assert.equal(envelope.status, "failed");
  assert.equal(envelope.errorCode, "PROBE_RESULT_INVALID");
  assert.equal(envelope.decisions.invalidReason, "scanned-missing");
});

test("缺 rowsScanned 不得记为 ok", async () => {
  const { exitCode, envelope } = await runSynthetic(JSON.stringify(makeValidResult({ scanned: { files: 2 } })), {
    source: "zcode",
  });
  assert.equal(exitCode, PROBE_EXIT_CODES.failed);
  assert.equal(envelope.decisions.invalidReason, "scanned-rows-missing");
});

test("files=0 必须带编码原因，否则不合格", async () => {
  const silent = await runSynthetic(
    JSON.stringify(makeValidResult({ scanned: { files: 0, rowsScanned: 0 }, warnings: [] })),
    { source: "zcode" },
  );
  assert.equal(silent.exitCode, PROBE_EXIT_CODES.failed);
  assert.equal(silent.envelope.decisions.invalidReason, "scanned-files-zero-without-reason");

  const explained = await runSynthetic(
    JSON.stringify(
      makeValidResult({
        scanned: { files: 0, rowsScanned: 0 },
        warnings: [{ code: "SOURCE_UNAVAILABLE", count: 1 }],
      }),
    ),
    { source: "zcode" },
  );
  assert.equal(explained.exitCode, PROBE_EXIT_CODES.ok);
  assert.equal(explained.envelope.status, "ok");
});

test("--full 按已发现文件是否全部扫描判定，不用固定数量门槛", async () => {
  // 246 个文件的小来源也能全量：只要发现多少就扫多少。
  const complete = await runSynthetic(
    JSON.stringify(
      makeValidResult({
        scanned: { files: 246, rowsScanned: 2460, filesDiscovered: 246, filesScanned: 246 },
      }),
    ),
    { source: "zcode", argvExtra: ["--full"] },
  );
  assert.equal(complete.exitCode, PROBE_EXIT_CODES.ok, JSON.stringify(complete.envelope.decisions));
  assert.equal(complete.envelope.status, "ok");
  assert.equal(complete.envelope.decisions.full, true);
  assert.equal(complete.envelope.decisions.maxFiles, null);

  const partial = await runSynthetic(
    JSON.stringify(
      makeValidResult({
        // scanned.files 与 filesDiscovered 同为"已发现文件总数"，必须相等；
        // filesScanned 更小才是"没扫完"。
        scanned: { files: 246, rowsScanned: 400, filesDiscovered: 246, filesScanned: 40 },
      }),
    ),
    { source: "zcode", argvExtra: ["--full"] },
  );
  assert.equal(partial.exitCode, PROBE_EXIT_CODES.failed);
  assert.equal(partial.envelope.decisions.invalidReason, "full-scan-incomplete");
  assert.equal(partial.envelope.decisions.full, true);
  assert.equal(partial.envelope.decisions.maxFiles, null);

  // 计数缺失时不能默认放行。
  const silent = await runSynthetic(JSON.stringify(makeValidResult({ scanned: { files: 2, rowsScanned: 40 } })), {
    source: "zcode",
    argvExtra: ["--full"],
  });
  assert.equal(silent.exitCode, PROBE_EXIT_CODES.failed);
  assert.equal(silent.envelope.decisions.invalidReason, "full-scan-counts-missing");
});

test("全量计数必须彼此一致，否则不合格（本轮审核复现项）", async () => {
  // 审核复现：files=10 / filesDiscovered=0 / filesScanned=0 曾被判为成功。
  const shown = await runSynthetic(
    JSON.stringify(makeValidResult({ scanned: { files: 10, rowsScanned: 100, filesDiscovered: 0, filesScanned: 0 } })),
    { source: "zcode", argvExtra: ["--full"] },
  );
  assert.equal(shown.exitCode, PROBE_EXIT_CODES.failed, "自相矛盾的计数不得记为 ok");
  assert.equal(shown.envelope.status, "failed");
  assert.equal(shown.envelope.decisions.invalidReason, "full-scan-counts-inconsistent");

  const cases = [
    // filesScanned > filesDiscovered
    { files: 4, rowsScanned: 40, filesDiscovered: 2, filesScanned: 4 },
    // filesDiscovered 与 scanned.files 不一致（9 !== 2）
    { files: 2, rowsScanned: 40, filesDiscovered: 9, filesScanned: 2 },
  ];
  for (const scanned of cases) {
    const { exitCode, envelope } = await runSynthetic(JSON.stringify(makeValidResult({ scanned })), {
      source: "zcode",
      argvExtra: ["--full"],
    });
    assert.equal(exitCode, PROBE_EXIT_CODES.failed, JSON.stringify(scanned));
    assert.equal(envelope.decisions.invalidReason, "full-scan-counts-inconsistent", JSON.stringify(scanned));
  }

  // 有界探测同样要自洽：矛盾证据即使不报 --full 也不能算 ok。
  const bounded = await runSynthetic(
    JSON.stringify(
      makeValidResult({ scanned: { files: 10, rowsScanned: 100, filesDiscovered: 10, filesScanned: 99 } }),
    ),
    { source: "zcode" },
  );
  assert.equal(bounded.exitCode, PROBE_EXIT_CODES.failed);
  assert.equal(bounded.envelope.decisions.invalidReason, "full-scan-counts-inconsistent");

  // 一致时照常通过。
  const consistent = await runSynthetic(
    JSON.stringify(makeValidResult({ scanned: { files: 6, rowsScanned: 60, filesDiscovered: 6, filesScanned: 6 } })),
    { source: "zcode", argvExtra: ["--full"] },
  );
  assert.equal(consistent.exitCode, PROBE_EXIT_CODES.ok, JSON.stringify(consistent.envelope.decisions));
});

test("--full 也可从 decisions 读全量计数，且来源不得改写外壳参数", async () => {
  const { exitCode, envelope } = await runSynthetic(
    JSON.stringify(
      makeValidResult({
        scanned: { files: 12, rowsScanned: 120 },
        decisions: { filesDiscovered: 12, filesScanned: 12, full: false, maxFiles: 999 },
      }),
    ),
    { source: "zcode", argvExtra: ["--full"] },
  );
  assert.equal(exitCode, PROBE_EXIT_CODES.ok, JSON.stringify(envelope.decisions));
  assert.equal(envelope.decisions.full, true, "来源不得把 full 改回 false");
  assert.equal(envelope.decisions.maxFiles, null, "来源不得改写 maxFiles");
  assert.deepEqual(envelope.fieldRejections, [{ category: "decisions-reserved-key-rejected", count: 2 }]);
});

test("来源返回被拒字段时只记类别与计数，不落盘键名与值", async () => {
  const { exitCode, envelope } = await runSynthetic(
    JSON.stringify(
      makeValidResult({
        fields: {
          timingKind: "request_e2e",
          sessionId: "C:/Users/someone/.codex/sessions/2026/rollout-abc.jsonl",
          threadId: "0193f0c2-1234-7000-8000-abcdefabcdef",
        },
      }),
    ),
    { source: "zcode" },
  );
  assert.equal(exitCode, PROBE_EXIT_CODES.ok);
  assert.deepEqual(envelope.fields, { timingKind: "request_e2e" });
  // 未知字段名（无论值长什么样）都走 unknown-field 类别。
  assert.deepEqual(envelope.fieldRejections, [{ category: "fields-unknown-field-rejected", count: 2 }]);

  const evidence = JSON.stringify(envelope);
  assert.doesNotMatch(evidence, /Users|sessions|rollout|0193f0c2/);
  assert.doesNotMatch(evidence, /sessionId|threadId/, "拒绝项不得包含来源提供的键名");
});

test("路径型键名被拒绝后，键名本身也不进入证据", async () => {
  const { exitCode, envelope } = await runSynthetic(
    JSON.stringify(
      makeValidResult({
        fields: {
          timingKind: "request_e2e",
          "/home/u/.codex/sessions/rollout-a.jsonl": "present",
          "0193f0c2-1234-7000-8000-abcdefabcdef": 3,
        },
      }),
    ),
    { source: "zcode" },
  );
  assert.equal(exitCode, PROBE_EXIT_CODES.ok);
  // 路径型键名先被键名白名单拒绝（fields-key-rejected），不进入"未知字段"判定。
  assert.deepEqual(envelope.fieldRejections, [{ category: "fields-key-rejected", count: 2 }]);
  const evidence = JSON.stringify(envelope);
  assert.doesNotMatch(evidence, /home|codex|sessions|rollout|0193f0c2/);
});

test("liveSourceChanged=true 必须有前后指纹", async () => {
  const { exitCode, envelope } = await runSynthetic(
    JSON.stringify(
      makeValidResult({ liveSourceChanged: true, sourceFingerprintBefore: null, sourceFingerprintAfter: null }),
    ),
    { source: "zcode" },
  );
  assert.equal(exitCode, PROBE_EXIT_CODES.failed);
  assert.equal(envelope.errorCode, "PROBE_RESULT_INVALID");
  assert.equal(envelope.decisions.invalidReason, "live-source-changed-without-fingerprints");
});

test("来源返回路径或正文时被丢弃并记入 fieldRejections，产物内无泄漏", async () => {
  const result = makeValidResult({
    scanned: { files: 2, rowsScanned: 40, firstFile: "/Users/someone/.codex/sessions/rollout.jsonl" },
    fields: { samplePath: "/Users/someone/.codex/sessions/rollout.jsonl", note: "x".repeat(80) },
    sourceFingerprintBefore: { pathFingerprint: "/Users/someone/.codex/sessions/rollout.jsonl" },
  });
  const { exitCode, envelope } = await runSynthetic(JSON.stringify(result), { source: "zcode" });
  assert.equal(exitCode, PROBE_EXIT_CODES.ok, "可恢复的字段拒绝不应让整次探测失败");
  assert.equal(envelope.status, "ok");
  // 拒绝项只记固定类别与计数：既不落盘来源键名，也不落盘其值。
  assert.deepEqual(envelope.fieldRejections, [
    { category: "fields-unknown-field-rejected", count: 2 },
    { category: "fingerprint-value-rejected", count: 1 },
    { category: "scanned-unknown-field-rejected", count: 1 },
  ]);
  const evidence = JSON.stringify(envelope);
  assert.doesNotMatch(evidence, /Users|sessions|rollout|xxxx/);
  assert.doesNotMatch(evidence, /firstFile|samplePath|note|pathFingerprint/, "拒绝项不得含来源键名");
});

test("前后指纹不同且来源未显式声明时自动判定 liveSourceChanged", async () => {
  const result = makeValidResult({
    liveSourceChanged: undefined,
    sourceFingerprintBefore: { fingerprint: HEX },
    sourceFingerprintAfter: { fingerprint: "b".repeat(64) },
  });
  const { exitCode, envelope } = await runSynthetic(JSON.stringify(result), { source: "zcode" });
  assert.equal(exitCode, PROBE_EXIT_CODES.ok);
  assert.equal(envelope.status, "ok");
  assert.equal(envelope.liveSourceChanged, true);
});

// ---------------------------------------------------------------- 真实 CLI 接线

/**
 * 在临时目录里以进程内方式驱动导出函数，并把 stdout / stderr 落到文件。
 * 产品 CLI 的输出守卫只允许写仓库的 docs/validation，所以临时 fixture 必须
 * 传导出函数的输出根；这是产品的同一份守卫，不是测试复刻。
 */
function runDriveScript(root, validationRoot, argv, { sourceModuleRoot = null } = {}) {
  // 缺源用例必须注入一个**空的**来源模块目录：仓库里的 scripts/perf-probe-sources/
  // 会随 M0.2–M0.5 陆续落地真实模块，靠"仓库恰好为空"来断言缺源是不可靠的。
  const sourceOption = sourceModuleRoot
    ? `, sourceModuleRoot: ${JSON.stringify(pathToFileURL(sourceModuleRoot).href)}`
    : "";
  const script = [
    // Windows 下 ESM 只认 file:// URL，裸盘符路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME。
    `import { runPerfProbe } from ${JSON.stringify(pathToFileURL(PROBE_SCRIPT).href)};`,
    `process.exitCode = await runPerfProbe(${JSON.stringify(argv)}, { outputRoot: ${JSON.stringify(validationRoot)}${sourceOption} });`,
  ].join("\n");
  const scriptFile = path.join(root, "drive.mjs");
  writeFileSync(scriptFile, `${script}\n`, "utf8");

  // spawnSync 与 execFileSync 不同：它在非零退出下仍然返回 stdout 与 status，
  // 因此不需要 shell 重定向，也就避开了 cmd 引号/编码的坑。
  const result = spawnSync(process.execPath, [scriptFile], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status === PROBE_EXIT_CODES.usage) {
    throw new Error(
      `drive 脚本参数错误：${String(result.stdout || "")}${String(result.stderr || "")}\n--- 脚本 ---\n${readFileSync(scriptFile, "utf8")}`,
    );
  }
  return { exitCode: result.status ?? 1, stdout: String(result.stdout || "") };
}

test("真实 CLI：帮助 / 无参 / 非法来源 / 非法输出目录 / 缺源模块", () => {
  const run = (args) => {
    try {
      const stdout = execFileSync(process.execPath, [PROBE_SCRIPT, ...args], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { exitCode: 0, stdout };
    } catch (error) {
      return { exitCode: error.status, stdout: String(error.stdout || "") };
    }
  };

  const help = run(["--help"]);
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /--source/);

  assert.equal(run([]).exitCode, PROBE_EXIT_CODES.usage);
  assert.equal(run(["--source", "nope", "--output", "x"]).exitCode, PROBE_EXIT_CODES.usage);
  assert.match(run(["--source", "zcode", "--output", path.join(REPO_ROOT, ".tmp-probe")]).stdout, /OUTPUT_OUTSIDE/);

  const { runDirectory, root } = makeRunDirectory();
  try {
    // 缺源必须走缺源路径而不是伪造 0 样本。这里**注入一个空的临时来源模块目录**，
    // 因为仓库内的 scripts/perf-probe-sources/ 会随 M0.2–M0.5 陆续落地真实模块；
    // 若靠"仓库恰好为空"来断言，任何一张来源卡交付都会让本用例变红。
    // 注意不能直接跑 CLI —— 真实 CLI 的输出守卫只认仓库的 docs/validation，
    // 临时目录会被正确地以 OUTPUT_OUTSIDE_VALIDATION 拒绝。这里用进程内驱动脚本，
    // 传导出函数的输出根（守卫逻辑本身仍由产品实现，测试未复制它）。
    const emptySources = path.join(root, "empty-sources");
    mkdirSync(emptySources, { recursive: true });
    const result = runDriveScript(root, root, ["--source", "codex", "--output", runDirectory], {
      sourceModuleRoot: emptySources,
    });
    assert.equal(result.exitCode, PROBE_EXIT_CODES.unavailable);
    assert.match(result.stdout, /SOURCE_MODULE_MISSING/);
    const envelope = JSON.parse(readFileSync(path.join(runDirectory, "codex-probe.json"), "utf8"));
    assert.equal(envelope.errorCode, "SOURCE_MODULE_MISSING");
    assert.equal(envelope.status, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("真实 CLI 产物的固定形状字段齐全", () => {
  const { runDirectory, root } = makeRunDirectory();
  try {
    // 用空来源目录取"缺源"信封：形状（含 errorCode）与成功信封同构，
    // 且不依赖仓库里是否恰好已有 zcode.mjs。
    const emptySources = path.join(root, "empty-sources");
    mkdirSync(emptySources, { recursive: true });
    const result = runDriveScript(root, root, ["--source", "zcode", "--output", runDirectory], {
      sourceModuleRoot: emptySources,
    });
    assert.equal(result.exitCode, PROBE_EXIT_CODES.unavailable);
    assert.match(result.stdout, /SOURCE_MODULE_MISSING/);
    const envelope = JSON.parse(readFileSync(path.join(runDirectory, "zcode-probe.json"), "utf8"));
    for (const key of [
      "probeVersion",
      "methodVersion",
      "source",
      "status",
      "startedAt",
      "endedAt",
      "nodeVersion",
      "gitRevision",
      "dirtyState",
      "sourceFingerprintBefore",
      "sourceFingerprintAfter",
      "liveSourceChanged",
      "scanned",
      "fields",
      "decisions",
      "warnings",
      "fieldRejections",
      "exitCode",
      "errorCode",
    ]) {
      assert.ok(key in envelope, `缺少字段 ${key}`);
    }
    assert.equal(envelope.probeVersion, PROBE_VERSION);
    assert.equal(envelope.methodVersion, METHOD_VERSION);
    assert.equal(envelope.gitRevision.length, 40);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
