#!/usr/bin/env node
/**
 * M0.1 性能探测外壳（只读）。
 *
 * 职责边界：解析参数、校验输出目录、按来源动态 import `perf-probe-sources/<source>.mjs`、
 * 把固定形状 JSON 写入本次 validation 运行目录。本文件不读取任何上游数据，也不包含
 * 来源字段解析——那是 M0.2–M0.5 各自来源模块的职责。
 *
 * 用法：node scripts/perf-probe.mjs --source <zcode|dsh|opencode|codex> --output <运行目录>
 * 详见 --help。日志只输出编码告警与计数，不输出源路径、原始 ID 或正文。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const PROBE_VERSION = "1";
export const METHOD_VERSION = "tps-v1";
export const PROBE_SOURCES = Object.freeze(["zcode", "dsh", "opencode", "codex"]);
export const DEFAULT_MAX_FILES = 4;
export const DEFAULT_MAX_ROWS = 200;

/** 外壳自身的退出码契约；来源模块不直接决定退出码。 */
export const PROBE_EXIT_CODES = Object.freeze({
  ok: 0,
  internal: 1,
  usage: 2,
  unavailable: 3,
  failed: 4,
});

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VALIDATION_ROOT = path.join(REPO_ROOT, "docs", "validation");
const SOURCE_MODULE_ROOT = new URL("./perf-probe-sources/", import.meta.url);
const WARNING_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const SAFE_DETAIL_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
/** 字段名白名单：短 camelCase / snake_case 标识符。键名本身不能承载路径或 ID。 */
const FIELD_NAME_PATTERN = /^[a-z][A-Za-z0-9_]{0,31}$/;
/**
 * 枚举值白名单：短的小写单词或 snake_case 常量（`present` / `request_e2e`）。
 *
 * 关键约束是"低熵且像枚举"。原始身份的典型形态都被挡住：
 * - UUID 含 `-`；十六进制摘要、`req_<32位十六进制>` 命中高熵片段规则；
 * - 路径含 `.` / `/` / `\`；正文通常超长。
 * 允许短单词（如 `present`）是必要的——来源会用它们描述列状态。
 */
const ENUM_VALUE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const ENUM_VALUE_MAX_LENGTH = 40;
/**
 * 连续十六进制/字母数字片段达到该长度即视为载体标识，而非枚举。
 * `8` 位十六进制足以覆盖会话 ID 片段与摘要前缀；`24` 位纯字母数字覆盖随机 token，
 * 同时给 `reported_output_unspecified`（26 字符但含下划线分段）留出空间。
 */
const HIGH_ENTROPY_RUN_PATTERN = /[0-9a-f]{8,}|[a-z0-9]{24,}/;

/** 参数/环境错误：只带编码，不携带可能含路径的原始 message。 */
class ProbeCliError extends Error {
  constructor(code, exitCode, hint = "") {
    super(code);
    this.code = code;
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export function usageText() {
  const implemented = listImplementedSources();
  return [
    "用法：node scripts/perf-probe.mjs --source <kind> --output <本次 validation 运行目录> [选项]",
    "",
    "只读有界探测外壳（M0.1）。默认有界：按规范排序后取首尾文件、每源最多 N 行。",
    "",
    "选项：",
    `  --source <kind>   必填；可选 ${PROBE_SOURCES.join(" | ")}`,
    "  --output <dir>    必填；必须位于 docs/validation/<日期>-perf-metrics/<runId>/ 之内",
    `  --max-files <n>   有界探测最多文件数（默认 ${DEFAULT_MAX_FILES}）`,
    `  --max-rows <n>    有界探测每源最多行数（默认 ${DEFAULT_MAX_ROWS}）`,
    "  --full            显式全量；与 --max-files/--max-rows 互斥，必须显式指定",
    "  --help            显示本帮助",
    "",
    `已实现来源模块：${implemented.length ? implemented.join(", ") : "（无）"}`,
    "未实现的来源在运行时以 SOURCE_MODULE_MISSING 写入结果文件，不伪造 0 样本。",
    "",
    `退出码：${PROBE_EXIT_CODES.ok} 成功 / ${PROBE_EXIT_CODES.internal} 内部错误 / ${PROBE_EXIT_CODES.usage} 参数错误 / ${PROBE_EXIT_CODES.unavailable} 来源不可用 / ${PROBE_EXIT_CODES.failed} 探测失败`,
    "输出：<output>/<source>-probe.json（失败时仍写入退出原因）",
    "",
    "来源模块契约（M0.2–M0.5 实现）：",
    "  export async function probe({ maxFiles, maxRows, full, outputDir })",
    "    => { scanned, fields, decisions, warnings, sourceFingerprintBefore, sourceFingerprintAfter, liveSourceChanged }",
    "  warnings 为 [{ code, count }]；code 需为契约内大写下划线编码，非法项被外壳丢弃并计数。",
    "",
    "结果校验（外壳强制，不合格记 PROBE_RESULT_INVALID / exit 4，不得记为 ok）：",
    "  scanned.files     必填且为安全整数",
    `  scanned.files=0   仅当 warnings 含 ${NO_FILE_CODES.join(" | ")} 之一才允许`,
    "  scanned.rowsScanned 必填且为安全整数",
    "  full 判定         已发现文件是否全部扫描：需给出 filesDiscovered 与 filesScanned",
    "                    （可置于 scanned 或 decisions），filesScanned < filesDiscovered 记 full-scan-incomplete；",
    "                    缺少这两个计数记 full-scan-counts-missing。不使用任何固定数量门槛。",
    "  计数一致性        filesScanned <= filesDiscovered === scanned.files，违者记 full-scan-counts-inconsistent",
    "  liveSourceChanged=true 必须同时给出前后指纹",
    "  外壳独占键        decisions.full / maxFiles / maxRows 由外壳写入，来源模块的同名键一律被拒绝",
    "",
    "证据容器（四源共用；子键也是白名单，键名不可能成为路径或 ID 的载体）：",
    "  fields.columns          {已知列名: present|absent|unknown}  逐列存在性（M0.2/M0.4/M0.5）",
    "  fields.requiredColumns  同上，仅必填列",
    "  fields.columnStates     {present,absent,unknown,total} 计数",
    "  decisions.warningCounts {§3 告警码: 计数}，如 MALFORMED_JSON / UNKEYABLE_RECORD",
    "  decisions.flagCounts    {§17.4 flag 名: 计数}，如 OUTPUT_ZERO / PARTIAL_ITEM_SPAN",
    "",
    "脱敏投影（越界字段被丢弃并记入 fieldRejections，原文不落盘）：",
    "  fields/decisions **按字段名走显式白名单**，未知字段一律拒绝——不按值的字符形状判断，",
    "                   因为 alice123 这类短标识完全符合任何形状正则，却正是要拦的原始 ID",
    "  scanned          仅接受逐名列出的键（files / rowsScanned / eligible / flagCount …）与 sources{来源名:计数}",
    "  fields 已知键     timingKind/tokenScope/windowKind/agentKind/timingSource/sourceVerdict/versionGuard …",
    "  decisions 已知键  filesDiscovered/filesScanned/schemaKind/sourceVerdict/durationMs …",
    "  值校验            计数键只接受非负安全整数（布尔不得冒充计数）、布尔键为布尔、",
    "                    穷举枚举键须精确命中；自由枚举键仍拒绝 UUID、摘要、路径与超长串",
    "  fingerprint(s)   仅 [0-9a-f]{16,128}、id 为 synthetic:<短标识>、fileCount/homeCount 计数、checkedAt ISO",
    "  fieldRejections  只记固定类别与拒绝计数（如 {category,count}），不保存来源提供的键名或值",
    "",
    "冻结说明：本契约由 M0.1 一次交付，M0.2–M0.5 **不需要也不允许**修改本文件。",
    "四源所需的证据结构（逐列存在性、状态分层计数、配对结果、来源决议、flag/warning 计数）",
    "已全部落在上述容器与键内；新增契约需走 M0.6 的 source-contract.md 并同步修订本文件与测试。",
    "",
    "日志只输出编码告警与计数，不输出源路径、原始 ID 或正文。",
  ].join("\n");
}

function listImplementedSources() {
  try {
    return readdirSync(fileURLToPath(SOURCE_MODULE_ROOT))
      .filter((name) => name.endsWith(".mjs"))
      .map((name) => name.slice(0, -".mjs".length))
      .sort();
  } catch {
    return [];
  }
}

function parsePositiveInteger(value, code) {
  if (!/^\d+$/.test(String(value))) {
    throw new ProbeCliError(code, PROBE_EXIT_CODES.usage, `${code}：需要正整数。`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ProbeCliError(code, PROBE_EXIT_CODES.usage, `${code}：需要正安全整数。`);
  }
  return parsed;
}

export function parseProbeArgs(argv = []) {
  const options = {
    source: "",
    output: "",
    maxFiles: DEFAULT_MAX_FILES,
    maxRows: DEFAULT_MAX_ROWS,
    full: false,
    help: false,
    maxFilesExplicit: false,
    maxRowsExplicit: false,
  };
  const takeValue = (name, index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ProbeCliError("MISSING_OPTION_VALUE", PROBE_EXIT_CODES.usage, `${name} 缺少取值。`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [name, inlineValue] =
      argument.startsWith("--") && argument.includes("=")
        ? [argument.slice(0, argument.indexOf("=")), argument.slice(argument.indexOf("=") + 1)]
        : [argument, undefined];
    const readValue = (label) => {
      if (inlineValue !== undefined) return inlineValue;
      const value = takeValue(label, index);
      index += 1;
      return value;
    };

    switch (name) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--source":
        options.source = readValue("--source");
        break;
      case "--output":
        options.output = readValue("--output");
        break;
      case "--max-files":
        options.maxFiles = parsePositiveInteger(readValue("--max-files"), "INVALID_MAX_FILES");
        options.maxFilesExplicit = true;
        break;
      case "--max-rows":
        options.maxRows = parsePositiveInteger(readValue("--max-rows"), "INVALID_MAX_ROWS");
        options.maxRowsExplicit = true;
        break;
      case "--full":
        options.full = true;
        break;
      default:
        throw new ProbeCliError("UNKNOWN_OPTION", PROBE_EXIT_CODES.usage, `未知选项：${name}`);
    }
  }

  if (options.full && (options.maxFilesExplicit || options.maxRowsExplicit)) {
    throw new ProbeCliError(
      "CONFLICTING_LIMITS",
      PROBE_EXIT_CODES.usage,
      "--full 不能与 --max-files/--max-rows 同时使用。",
    );
  }
  return options;
}

/** 输出目录必须落在本次 `docs/validation/<日期>-perf-metrics/<runId>/` 之内。 */
export function resolveRunOutputDirectory(outputValue, { validationRoot = VALIDATION_ROOT } = {}) {
  if (!outputValue) {
    throw new ProbeCliError("MISSING_OUTPUT", PROBE_EXIT_CODES.usage, "--output 必填。");
  }
  const resolved = path.resolve(outputValue);
  const root = path.resolve(validationRoot);
  // Windows 路径大小写不敏感，必须先折叠再比较，否则同一目录会被误判为"在外面"。
  const fold = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  const relative = path.relative(fold(root), fold(resolved));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ProbeCliError(
      "OUTPUT_OUTSIDE_VALIDATION",
      PROBE_EXIT_CODES.usage,
      "输出目录必须位于 docs/validation/ 之内。",
    );
  }
  const segments = relative.split(path.sep).filter(Boolean);
  if (segments.length < 2 || !/-perf-metrics$/.test(segments[0])) {
    throw new ProbeCliError(
      "OUTPUT_NOT_PERF_METRICS_RUN",
      PROBE_EXIT_CODES.usage,
      "输出目录必须是 docs/validation/<日期>-perf-metrics/<runId>/。",
    );
  }
  return resolved;
}

/**
 * 编码告警收集器：来源模块用它只产出 `{ code, count }`，不产出正文或路径。
 * 单次合法但累加后越过安全整数的调用被拒绝，避免证据出现 9007199254740992 这类伪精确计数。
 */
export function createWarningCollector() {
  const counts = new Map();
  return {
    warn(code, count = 1) {
      const numeric = Number(count);
      if (!WARNING_CODE_PATTERN.test(String(code)) || !Number.isSafeInteger(numeric) || numeric <= 0) return false;
      const current = counts.get(String(code)) || 0;
      const next = current + numeric;
      if (!Number.isSafeInteger(next)) return false;
      counts.set(String(code), next);
      return true;
    },
    list() {
      return [...counts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([code, count]) => ({ code, count }));
    },
  };
}

/** 归一化来源返回的告警：非法项丢弃并计数，绝不写入原文。 */
export function normalizeWarnings(value) {
  const collector = createWarningCollector();
  let dropped = 0;
  for (const entry of Array.isArray(value) ? value : []) {
    // 累加越界时该条未被计入，算作丢弃而不是静默少计
    if (!collector.warn(entry?.code, entry?.count)) dropped += 1;
  }
  return { warnings: collector.list(), dropped };
}

function gitState() {
  const run = (args) =>
    execFileSync("git", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  try {
    const revision = run(["rev-parse", "HEAD"]).trim();
    const status = run(["status", "--porcelain"]);
    const entries = status.split("\n").filter((line) => line.trim().length > 0).length;
    return { revision: revision || null, dirtyState: { dirty: entries > 0, entries } };
  } catch {
    return { revision: null, dirtyState: null };
  }
}

function safeErrorDetail(error) {
  const candidate = error?.code ?? error?.name;
  return typeof candidate === "string" && SAFE_DETAIL_PATTERN.test(candidate) ? candidate : null;
}

const FINGERPRINT_KEYS = [
  "fingerprint",
  "pathFingerprint",
  "contentFingerprint",
  "fileCount",
  "homeCount",
  "checkedAt",
];

/**
 * 允许的指纹键类型。`fingerprint` 等必须是 hex 摘要 —— 这一约束同时是脱敏防线：
 * 路径/ID 无法满足 `^[0-9a-f]{16,128}$`，因而写不进持久证据。
 */
const FINGERPRINT_KEY_KINDS = Object.freeze({
  fingerprint: "hex",
  pathFingerprint: "hex",
  contentFingerprint: "hex",
  fileCount: "count",
  homeCount: "count",
  checkedAt: "isostamp",
});

const FINGERPRINT_HEX_PATTERN = /^[0-9a-f]{16,128}$/;
const SYNTHETIC_FINGERPRINT_PATTERN = /^synthetic:[a-z0-9][a-z0-9:_-]{0,63}$/;
const ISO_STAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const MAX_COUNT = 100_000_000;
/** 探测从未定位到文件时允许的退避码。 */
export const NO_FILE_CODES = Object.freeze(["SOURCE_UNAVAILABLE", "NO_SOURCE_FILES", "UNSUPPORTED_SCHEMA"]);
/**
 * 探测未能完成时的**失败码域**（M0.6 决议 K）。
 *
 * 与 `SOURCE_WARNING_CODES` 分开：后者是**来源警告**（写入 `decisions.warningCounts`，
 * 表示"读到了一些东西但质量降级"）；这里是**外壳自身的失败编码**，
 * 只出现在结果文件的顶层 `status=error` + `code` 上，且各自绑定固定退出码。
 * 两者语义不同，因此不并入同一枚举域；本常量把它们**显式登记为一个域**，
 * 供下游按码而非按字符串匹配。
 */
export const PROBE_FAILURE_CODES = Object.freeze([
  // exit 2（usage）
  "MISSING_SOURCE",
  "MISSING_OUTPUT",
  "MISSING_OPTION_VALUE",
  "UNKNOWN_OPTION",
  "INVALID_SOURCE",
  "INVALID_MAX_FILES",
  "INVALID_MAX_ROWS",
  "CONFLICTING_LIMITS",
  "OUTPUT_OUTSIDE_VALIDATION",
  "OUTPUT_NOT_PERF_METRICS_RUN",
  // exit 3（unavailable / 来源不可用）
  "SOURCE_UNAVAILABLE",
  "NO_SOURCE_FILES",
  "UNSUPPORTED_SCHEMA",
  "SOURCE_MODULE_MISSING",
  "SOURCE_MODULE_LOAD_FAILED",
  // exit 4（failed）
  "PROBE_RESULT_INVALID",
  "PROBE_EXPORT_MISSING",
  "PROBE_FAILED",
]);
/**
 * `--full` 的判定依据由来源模块通过 `decisions.filesDiscovered / filesScanned` 或
 * `scanned.filesDiscovered / scanned.filesScanned` 提供：**已发现文件是否全部扫描**，
 * 而不是任何固定数量门槛（各来源物理文件数从 1 到数百不等，数量门槛既过严也无意义）。
 */
export const FULL_SCAN_DISCOVERED_KEYS = Object.freeze(["filesDiscovered", "discoveredFiles"]);
export const FULL_SCAN_SCANNED_KEYS = Object.freeze(["filesScanned", "scannedFiles"]);
/**
 * 外壳独占的 decisions 键：来源模块不得改写，否则结果文件记录的探测参数
 * 会与实际执行的参数不一致，证据即失真。
 */
export const RESERVED_DECISION_KEYS = Object.freeze(["full", "maxFiles", "maxRows"]);
/**
 * `fieldRejections` 只记录**固定的字段类别 + 拒绝计数**。
 * 绝不落盘来源提供的键名或值：键名本身可能就是原始路径/会话 ID，
 * 而值更可能直接是正文。
 */
export const REJECTION_CATEGORIES = Object.freeze({
  scannedValue: "scanned-value-rejected",
  scannedSources: "scanned-sources-rejected",
  scannedUnknownField: "scanned-unknown-field-rejected",
  fieldsKey: "fields-key-rejected",
  fieldsValue: "fields-value-rejected",
  fieldsUnknownField: "fields-unknown-field-rejected",
  decisionsKey: "decisions-key-rejected",
  decisionsValue: "decisions-value-rejected",
  decisionsUnknownField: "decisions-unknown-field-rejected",
  decisionsReserved: "decisions-reserved-key-rejected",
  fingerprintKey: "fingerprint-key-rejected",
  fingerprintValue: "fingerprint-value-rejected",
  decisionsNonObject: "decisions-not-object",
  fieldsNonObject: "fields-not-object",
  scannedNonObject: "scanned-not-object",
  fingerprintNonObject: "fingerprint-not-object",
});

/**
 * 计数类字段名白名单（用于 `scanned`）。
 *
 * 按**字段名**而非字符形状放行：`alice123` 这类短标识完全符合任何合理的
 * 字符形状正则，却正是要拦住的原始 ID。因此这里改为穷举允许的键。
 * 字段分三档：
 * - `count`：非负安全整数计数；
 * - `flag`：布尔；
 * - `countOrFlag`：来源可能用 `0/1` 或 `true/false` 表达，两者都接受。
 */
export const SCANNED_COUNT_KEYS = Object.freeze([
  // 文件/行/会话规模（四源通用）
  "files",
  "filesDiscovered",
  "filesScanned",
  "rows",
  "rowsScanned",
  "rowsTotal",
  "rowsRead",
  "rowsSkipped",
  "sessions",
  "sessionsScanned",
  "events",
  "items",
  "homes",
  "bytes",
  "errors",
  "skipped",
  "truncatedCount",
  "unparsedLines",
  // M0.5 Codex：raw / positive / full-span / finalized 分层（§17.5 的 eligible 家族）
  "eligible",
  "positiveOutput",
  "timedPositiveOutput",
  "completeTimedPositiveOutput",
  "sampled",
  "dropped",
  "pending",
  "unplaced",
  "dedupedRequests",
  "dedupedItems",
  "collapsedRecords",
  "conflictingRecords",
  "partialItems",
  "legacyRecords",
  "recentRecords",
  // M0.3 DSH 配对结果
  "pairedCandidates",
  "unpairedCandidates",
  "duplicateStartFrames",
  "duplicateMessageFrames",
  "stepReuseAcrossTurns",
  "headerChanges",
  "badFrames",
  "missingSessionHeader",
  "missingStart",
  "missingUsage",
  "negativeDurations",
  // M0.4 OpenCode 版本分层
  "supportedVersions",
  "legacyVersions",
  "unknownVersions",
  "badJsonRows",
  "missingCompleted",
  "missingTokens",
  "streamedRows",
  // M0.2 ZCode 分层
  "completedRows",
  "errorRows",
  "cancelledRows",
  "retryRows",
  "positiveDurationRows",
  "positiveOutputRows",
  "uniqueIdentities",
  "duplicateIdentities",
  // 缺失/单位/时间诊断（四源通用）
  "missingTimestampCount",
  "durationFallbackCount",
  "durationMismatchCount",
  "identityDuplicateCount",
  "identityDuplicateGroupCount",
  "walOnlyChangedCount",
  "versionNonV4Count",
  "malformedFrameCount",
  "malformedJsonCount",
  "assistantMessageCount",
  "requestHeaderCount",
  "sessionHeaderCount",
  "stepStartCount",
  "multipleStartCount",
  "multipleMessageCount",
  "consistentDuplicateCount",
  "turnContextCount",
  "tokenUsageRecordCount",
  "itemCompletedCount",
  "taskCompleteCount",
  "otherEventCount",
  "agentMessageItemCount",
  "reasoningItemCount",
  "targetItemCount",
  "crossRolloutDuplicateCount",
  "requestSumMismatchCount",
  "effortConflictCount",
  "terminalMissingCount",
  "secondUnitCount",
  "milliSecondUnitCount",
  "missingItemSpanCount",
  "overflowingSpanCount",
  "requestCount",
  "unsupportedVersionCount",
  "badJsonCount",
  "assistantRowCount",
  "outputMissingCount",
  "outputZeroCount",
  "reasoningMissingCount",
  "reasoningZeroCount",
  "cancelledCount",
  "terminalUnverifiedCount",
  "tooFastSampleCount",
  "rawCount",
  "positiveCount",
  "afterFilterCount",
  "positiveDurationCount",
  "attemptIndexNonZeroCount",
  "retryableCount",
  "cancelledByUserCount",
  "statusCompletedCount",
  "statusErrorCount",
  "statusCancelledCount",
  "statusOtherCount",
  "logicalRequestIdDuplicateGroupCount",
  "timeUnitMatchedCount",
  "timeUnitCheckedCount",
  "sqliteCandidateCount",
  "jsonlCandidateTurnCount",
  // §17.4 flag 计数（byFlag 形状，可重叠，不相加当 dropped）
  "flagCount",
  "flagMaskTotal",
  // ===== M0.6 契约冻结新增（来源卡受阻项，白名单容量缺口） =====
  // A：Codex 三态交叉校验专用键。停用被借用的 `requestHeaderCount`/`identityDuplicateCount`
  //    的交叉校验语义（它们回到字面含义）。
  "crossCheckAvailableCount",
  "crossCheckMatchedCount",
  "crossCheckUnavailableCount",
  "crossCheckConflictCount",
  // B：agent 角色分层计数。`agent_kind` 的三分结论必须有数字证据，不能只有枚举。
  "subagentRows",
  "mainRows",
  "unknownAgentRows",
  // C：TTFT 列的逐列存在性计数（列名本身也已进 KNOWN_COLUMN_NAMES）。
  "ttftColumnCount",
  // D：Codex 结构名的逐类计数。
  "responseItemCount",
  "worldStateCount",
  "tokenCountEventCount",
  "taskStartedCount",
  "turnAbortedCount",
  "customToolCallCount",
  "threadItemsTableCount",
  "threadTurnsTableCount",
  "threadTurnsCompletedCount",
  "threadTurnsFailedCount",
  "threadTurnsInterruptedCount",
  "threadTurnsInProgressCount",
  // E/F/G：终态证据与判据的可观测计量。
  "completeEvidenceCount",
  "stepEndFrames",
  "stepEndUnkeyable",
  "terminalEvidenceAvailableCount",
  "terminalEvidenceMissingCount",
  // H：决议的证据强度（"证据不足 ≠ 反证"的机器可读落点）。
  "verdictEvidenceStrength",
  // I：预算截断与"进入统计"的文件粒度。
  "filesEnteredStats",
  "filesUnopenedByBudget",
  "rowsUnreadByBudget",
  // M：`rowsTotal` 的已打开文件口径显式化（不再依赖命名推断）。
  "rowsTotalOpened",
]);

/**
 * §17.4 的 18 位持久标志名（位 2/3 保留，不置位）。
 * M0.2–M0.5 用它们上报 flag 计数，因此逐名列进白名单。
 */
export const PERF_FLAG_NAMES = Object.freeze([
  "OUTPUT_ZERO",
  "DURATION_NONPOSITIVE",
  "LONG_WINDOW",
  "MULTI_REQUEST_TURN",
  "PARTIAL_ITEM_SPAN",
  "MISSING_DURATION",
  "MISSING_OUTPUT",
  "MODEL_AMBIGUOUS",
  "TERMINAL_UNVERIFIED",
  "SOURCE_FILTERED",
  "RECORD_CONFLICT",
  "OVERLAPPING_ITEM_SPAN",
  "TIME_INVALID",
  "TIME_UNPLACED",
  "METHOD_ESTIMATE",
  "TOKEN_INVALID",
]);

/**
 * §3 固定的 `sourceWarnings.code` 全集；来源只能上报这些码。
 * M0.6 若在 `source-contract.md` 冻结细项，须同步扩展这里。
 */
export const SOURCE_WARNING_CODES = Object.freeze([
  "UNKEYABLE_RECORD",
  "READ_ONLY_OPEN_FAILED",
  "UNSUPPORTED_SCHEMA",
  "MALFORMED_JSON",
  "MALFORMED_FRAME",
  "LIVE_SOURCE_CHANGED",
  "OPTIONAL_SOURCE_UNAVAILABLE",
  "AGGREGATE_OVERFLOW",
]);

export const SCANNED_BOOLEAN_KEYS = Object.freeze([
  "truncated",
  "bounded",
  "complete",
  "capped",
  "hasMore",
  "indexPresent",
  "walPresent",
  "readOnly",
  "projectionReady",
  "optionalSourceUsed",
]);
/** `scanned` 上允许的键名 -> 类型。 */
export const SCANNED_FIELD_KINDS = Object.freeze(
  Object.fromEntries([
    ...SCANNED_COUNT_KEYS.map((key) => [key, "count"]),
    ...SCANNED_BOOLEAN_KEYS.map((key) => [key, "flag"]),
  ]),
);

/** 逐列/逐字段存在性的三态取值："存在 / 缺失 / 未知"。 */
export const PRESENCE_STATES = Object.freeze(["present", "absent", "unknown"]);

/**
 * `fields` 的字段名 -> 允许取值白名单。
 *
 * 数组表示**穷举**，值必须精确命中；未列出的键一律拒绝——
 * 这是"不保存原始 ID"的唯一可靠保证（形状判断永远不充分）。
 */
export const FIELDS_ENUM_VALUES = Object.freeze({
  // 指标口径
  timingKind: ["request_e2e", "item_span_estimate"],
  tokenScope: ["reported_output_includes_reasoning", "visible_plus_reasoning", "reported_output_unspecified"],
  windowKind: ["request", "step", "turn", "message"],
  statusKind: ["completed", "failed", "cancelled", "in_progress", "unverified"],
  agentKind: ["main", "subagent", "unknown"],
  timingSource: ["explicit", "derived", "mixed", "estimated", "none"],
  modelEvidence: ["turn_context", "request_scope", "session_meta", "unknown"],
  durationBasis: [
    "explicit_ms",
    "epoch_diff",
    "message_minus_start",
    "item_span_sum",
    "completed_minus_created",
    "none",
  ],
  unitKind: ["ms", "s", "s_or_ms", "unknown"],
  schemaKind: ["zcode-sqlite", "dsh-jsonl", "opencode-sqlite", "codex-jsonl", "unknown"],
  backend: ["sqlite", "jsonl", "mixed", "unknown"],
  // 证据完备性（"存在 / 缺失 / 未知"三态，缺列不能默认空值等于 0）
  columnState: ["present", "absent", "unknown"],
  fieldState: ["present", "absent", "unknown"],
  // M0.5 Codex 来源决议（§M0.5-3）
  sourceVerdict: ["JSONL_ONLY", "OPTIONAL_SQLITE_WORTHWHILE", "UNSUPPORTED"],
  // M0.6-H：来源决议的**证据强度**。`not_observed_insufficient_evidence` 表示
  // "在可比身份上未观察到增益"（证据不足），绝不等价于"已证明无增益"（反证）。
  verdictEvidenceStrength: [
    "source_absent",
    "optional_source_absent",
    "not_observed_insufficient_evidence",
    "observed_over_comparable_identities",
    "unknown",
    "none",
  ],
  // M0.6-A：Codex 累计输出交叉校验三态（每个可校验轮恰好一态）。
  crossCheckState: ["matched", "conflict", "unavailable", "none"],
  // M0.4 OpenCode v2 guard
  versionGuard: ["supported", "legacy", "unknown"],
  // M0.2 ZCode 重试/取消证据
  retryEvidence: ["retry_count", "attempt_index", "absent", "unknown"],
  cancelledEvidence: ["cancelled_by_user", "status", "absent", "unknown"],
  // 来源过滤主原因（§17.5 的 droppedByReason 优先级）
  diagnosticReason: [
    "record_conflict",
    "model_ambiguous",
    "terminal_unverified",
    "source_filtered",
    "output_missing_zero_invalid",
    "duration_missing_nonpositive_invalid",
    "partial_item_span",
    "overlapping_item_span",
    "none",
  ],
  // 覆盖率状态（§17.5 meta.state）
  coverageState: ["rebuilding", "ready", "degraded"],
  // 聚类
  eraBucket: ["recent", "legacy", "none"],
  itemType: ["agentMessage", "reasoning", "other", "none"],
  // 方法版本：含连字符，不能走只认下划线的自由枚举，必须穷举。
  methodVersion: [METHOD_VERSION],
  itemTypeCase: ["pascal_case", "camel_case", "mixed", "unknown"],
  // 身份与映射结论（四源各自的 agent/provider/effort 决议形态）
  agentKindMapping: ["explicit_subagent_flag", "verified_main", "unknown_default", "none"],
  agentNameEvidence: ["agent_preset", "agent_field", "query_source", "task_type", "session_meta", "none"],
  agentRoleProvenance: ["delegation_depth", "explicit_flag", "none"],
  providerMapping: ["provider_id", "message_json", "request_header", "session_meta", "unknown", "none"],
  effortMapping: ["turn_context", "request_header", "unknown", "none"],
  modelEvidenceDecision: ["turn_context", "request_scope", "session_meta", "unknown", "none"],
  providerScope: ["provider_id", "request_header", "message_json", "unknown", "none"],
  effortScope: ["turn_context", "request_header", "unknown", "none"],
  modelScope: ["model_id", "request_header", "message_json", "turn_context", "unknown", "none"],
  // 身份与时长证据
  databaseIdentityKind: ["path", "device_inode", "canonical_path", "home_alias", "unknown", "none"],
  identityScheme: ["row_id", "turn_step", "message_id", "request_item", "unknown", "none"],
  durationProvenance: ["explicit", "timestamp_fallback", "mixed", "unknown", "none"],
  timeUnit: ["milliseconds", "seconds", "unknown", "none"],
  // 结构关系结论
  reasoningRelation: ["parallel_additive", "included_in_output", "separate_unknown", "none"],
  terminalFieldKind: ["status_column", "task_complete", "cancelled_flag", "absent", "unknown", "step_end_frame"],
  terminalEvidenceDecision: ["proven_completed", "proven_failed", "proven_cancelled", "unverified", "pending", "none"],
  itemAlignmentDecision: ["request_output_aligned", "cannot_prove", "none"],
  optionalSqliteRole: ["verification", "gap_fill", "none"],
  itemContentCase: ["pascal_case", "camel_case", "mixed", "unknown", "none"],
  // 只读策略

  readOnlyStrategy: ["database_sync_readonly", "file_read_only", "dry_run", "unknown", "none"],
  unsupportedVersionPolicy: ["pass_with_warning", "exclude_and_warn", "unknown", "none"],
  // OpenCode JSON 路径存在性
  timeCreatedPath: PRESENCE_STATES,
  timeCompletedPath: PRESENCE_STATES,
  tokensOutputPath: PRESENCE_STATES,
  tokensReasoningPath: PRESENCE_STATES,
  modelIdPath: PRESENCE_STATES,
  providerIdPath: PRESENCE_STATES,
  agentPath: PRESENCE_STATES,
  terminalFieldPath: PRESENCE_STATES,
  versionColumn: PRESENCE_STATES,
});
/**
 * `fields` 上允许"任意低熵枚举串"的键（值受 ENUM_VALUE_PATTERN 约束）。
 * 用于契约里会继续扩展、无法穷举的开放枚举。
 * 注意 `ENUM_VALUE_PATTERN` 只认小写字母/数字/下划线，**不接受连字符**；
 * 含连字符的值（如 `tps-v1`）必须改为穷举枚举，不能放在这里。
 */
export const FIELDS_FREE_ENUM_KEYS = Object.freeze([
  "unit",
  "basis",
  "modelFamily",
  "effortLevel",
  "sourceVersion",
  "tableName",
  "columnName",
  "modelIdShape",
  "providerShape",
  "durationUnit",
  "timestampUnit",
  "sessionV2Version",
]);
/** `fields` 上允许安全整数的键。 */
export const FIELDS_COUNT_KEYS = Object.freeze([
  "maxFiles",
  "maxRows",
  "sampleCount",
  "windowCount",
  "columnCount",
  "presentColumnCount",
  "absentColumnCount",
  "unknownColumnCount",
  "flagCount",
  "distinctModels",
  "distinctProviders",
  "distinctAgents",
  "distinctSessions",
  "distinctHomes",
  "turnCount",
  "requestCount",
  "itemCount",
  "timedItemCount",
]);
/** `fields` 上允许布尔的键。 */
export const FIELDS_BOOLEAN_KEYS = Object.freeze([
  "sampled",
  "limited",
  "encrypted",
  "allColumnsPresent",
  "identityUnique",
  "pairingConsistent",
  "streamAccessed",
  "contentAccessed",
  "ttftRead",
  "readOnly",
  "walPresent",
  "projectionReady",
  "optionalSourceWorthwhile",
  "duplicateCollapsed",
  "conflictDetected",
  "stepResetObserved",
  "modelChangedMidSession",
  "unitAmbiguous",
  "completedExplicit",
  "outputExplicit",
  "reasoningSeparate",
  "agentRoleProven",
  "mainProven",
  "streamAccessed",
  "contentAccessed",
  "stepEndAccessed",
  "itemContentAccessed",
  "lastAgentMessageAccessed",
  "ttftAccessed",
  "ttftColumnPresent",
  "bodySentinelFound",
  "writableFallbackUsed",
  "streamedDenominatorUsed",
  "walOnlyChanged",
  "archivedSessionsPresent",
  "statePresent",
  "historyPresent",
  "databaseIdentityStable",
  "sourceChangedDuringScan",
  "terminalFieldPresent",
  "reasoningRelationKnown",
  "timestampFallbackUsed",
  "explicitDurationUsed",
]);

/**
 * 逐列/逐字段存在性证据。
 *
 * `fields.<name>` 只能承载**标量**；四源需要逐列报告"存在/缺失/未知"，
 * 而列数可达数十个（ZCode 的 `model_usage` 就有 19 列）。
 * 因此外壳提供固定容器：
 * - `fields.columns` / `fields.requiredColumns`：`{列名: columnState}` 映射，**键名必须是
 *   白名单内的已知列名**（见 `KNOWN_COLUMN_NAMES`），值必须是三态枚举；
 * - `fields.columnStates`：`{present, absent, unknown}` 计数。
 *
 * 键名白名单由 `KNOWN_COLUMN_NAMES` 给出：这些是四份任务卡明确点名的列/字段，
 * 不含自由文本，因此不会成为路径或 ID 的载体。
 */
export const KNOWN_COLUMN_NAMES = Object.freeze([
  // M0.2 ZCode `model_usage`（§17.1 与 M0.2-1 点名的列）
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
  // M0.4 OpenCode
  "session_message",
  "session_v2",
  "version",
  "data",
  "json_valid",
  "message_id",
  "time_created",
  "time_completed",
  "tokens_output",
  "tokens_reasoning",
  "model_id_provider",
  "agent_name",
  // M0.5 Codex JSONL / SQLite
  "thread_id",
  "turn_id",
  "item_type",
  "item_id",
  "started_at_ms",
  "completed_at_ms",
  "response_id",
  "turn_context",
  "event_msg",
  "token_usage_record",
  "item_completed",
  "task_complete",
  "turn_token_usage",
  "archived_sessions",
  "sessions_meta",
  "thread_source",
  "source_kind",
  // M0.3 DSH JSONL 帧类型
  "session",
  "request",
  "header",
  "context",
  "step_start",
  "step_end",
  "assistant_message",
  "agent_preset",
  "delegation_depth",
  "output_tokens_usage",
  // ===== M0.6 契约冻结新增 =====
  // A：Codex 三态交叉校验（每个参与校验的轮恰好落入且只落入一个状态）。
  "crossCheckState",
  // B：agent 角色分层。
  "subagent",
  "main",
  // C：ZCode 的 TTFT 两列 —— **只用于存在性**，不读取值、不进任何 TPS/时长公式。
  "first_token_at",
  "time_to_first_token_ms",
  // D：Codex 真实结构名（实测存在但原白名单未收录）。
  "response_item",
  "world_state",
  "token_count",
  "task_started",
  "turn_aborted",
  "custom_tool_call",
  "thread_items",
  "thread_turns",
  "item_json",
  "turn_status",
  // J：Codex provider 的真实来源。
  "session_meta",
  // OpenCode 扫描所需的 SQL 列（原先只能靠整库 UNSUPPORTED_SCHEMA 间接表达）。
  "type",
  "seq",
  "time_updated",
  // L：方案 §5 的漂移锚点整改后不得再被当成"未收录列"。
  "usage_detail_mask",
]);
/**
 * `{列名: columnState}` 形式的结构化容器白名单。
 * 值为 `{容器键: {子白名单}}`：子白名单为 `null` 表示允许任意已知列名。
 */
export const STRUCTURED_FIELDS = Object.freeze({
  columns: { subKeys: KNOWN_COLUMN_NAMES, valueKind: "enum", enumValues: ["present", "absent", "unknown"] },
  requiredColumns: { subKeys: KNOWN_COLUMN_NAMES, valueKind: "enum", enumValues: ["present", "absent", "unknown"] },
  columnStates: {
    subKeys: ["present", "absent", "unknown", "total"],
    valueKind: "count",
  },
});

/**
 * `decisions` 的字段名 -> 允许取值形状。
 * `filesDiscovered` / `filesScanned` 是 `--full` 判定的输入；`droppedWarnings` 由外壳写入。
 */
export const DECISIONS_COUNT_KEYS = Object.freeze([
  "filesDiscovered",
  "filesScanned",
  "discoveredFiles",
  "scannedFiles",
  "droppedWarnings",
  "droppedFields",
  "droppedFlags",
  "rejectedColumns",
  "homeCount",
  "sourceCount",
  "durationMs",
  "openedDatabaseCount",
  "checkedRowCount",
  "identityDuplicateGroupCount",
]);
export const DECISIONS_BOOLEAN_KEYS = Object.freeze([
  "indexPresent",
  "walPresent",
  "schemaDetected",
  "fallbackUsed",
  "readOnly",
  "projectionReady",
  "optionalSourceUsed",
  "liveSourceChanged",
  "optionalSourcePresent",
  "readOnlyEnforced",
  "identityUnique",
  "fullScanRequested",
  "identitySchemeStable",
]);
export const DECISIONS_ENUM_VALUES = Object.freeze({
  schemaKind: ["zcode-sqlite", "dsh-jsonl", "opencode-sqlite", "codex-jsonl", "unknown"],
  backend: ["sqlite", "jsonl", "mixed", "unknown"],
  sourceVerdict: ["JSONL_ONLY", "OPTIONAL_SQLITE_WORTHWHILE", "UNSUPPORTED"],
  versionGuard: ["supported", "legacy", "unknown"],
  coverageState: ["rebuilding", "ready", "degraded"],
  timingKind: ["request_e2e", "item_span_estimate"],
  tokenScope: ["reported_output_includes_reasoning", "visible_plus_reasoning", "reported_output_unspecified"],
  invalidReason: [
    "scanned-missing",
    "scanned-files-missing",
    "scanned-files-zero-without-reason",
    "full-scan-incomplete",
    "full-scan-counts-missing",
    "full-scan-counts-inconsistent",
    "scanned-rows-missing",
    "field-rejections-missing",
    "live-source-changed-without-fingerprints",
  ],
});
/** `decisions` 允许承载 warning 计数与 flag 计数的结构化容器。 */
export const STRUCTURED_DECISIONS = Object.freeze({
  warningCounts: { subKeys: SOURCE_WARNING_CODES, valueKind: "count" },
  flagCounts: { subKeys: PERF_FLAG_NAMES, valueKind: "count" },
});

function isHexOrSyntheticFingerprint(value) {
  return (
    typeof value === "string" && (FINGERPRINT_HEX_PATTERN.test(value) || SYNTHETIC_FINGERPRINT_PATTERN.test(value))
  );
}

/**
 * 只保留指纹的聚合形状，避免来源模块顺手把原始路径写进持久产物。
 * 指纹键名是固定白名单，因此不存在"键名泄漏"；值被拒绝时只记固定类别。
 */
export function projectFingerprint(value, target = {}, rejections = null) {
  if (!value || typeof value !== "object") {
    recordRejection(rejections, REJECTION_CATEGORIES.fingerprintNonObject);
    return target;
  }
  const record = (category) => recordRejection(rejections, category);
  for (const key of FINGERPRINT_KEYS) {
    const entry = value[key];
    if (entry === undefined || entry === null) continue;
    const kind = FINGERPRINT_KEY_KINDS[key];
    if (kind === "hex") {
      if (!isHexOrSyntheticFingerprint(entry)) {
        record(REJECTION_CATEGORIES.fingerprintValue);
        continue;
      }
    } else if (kind === "count") {
      if (!Number.isSafeInteger(entry) || entry < 0) {
        record(REJECTION_CATEGORIES.fingerprintValue);
        continue;
      }
    } else if (kind === "isostamp") {
      if (typeof entry !== "string" || !ISO_STAMP_PATTERN.test(entry)) {
        record(REJECTION_CATEGORIES.fingerprintValue);
        continue;
      }
    }
    target[key] = entry;
  }
  return target;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 拒绝计数收集器。**只记固定的类别字符串与计数**，来源提供的键名与值一律不进产物。
 * 类别可带 `:before` / `:after` 之类的固定后缀，后缀同样是外壳常量。
 */
export function createRejectionCollector() {
  const counts = new Map();
  return {
    record(category) {
      if (typeof category !== "string" || !/^[a-z][a-z0-9-]*(?::[a-z]+)?$/.test(category)) return false;
      counts.set(category, (counts.get(category) || 0) + 1);
      return true;
    },
    list() {
      return [...counts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([category, count]) => ({ category, count }));
    },
    get size() {
      return counts.size;
    },
  };
}

function recordRejection(collector, category) {
  collector?.record?.(category);
}

/**
 * 校验 `fields` / `decisions` 上的**结构化容器**（如逐列存在性、flag 计数）。
 *
 * 容器本身是固定白名单（见 `STRUCTURED_FIELDS` / `STRUCTURED_DECISIONS`），
 * 子键也必须命中各自的子白名单，因此键名永远不可能成为路径或原始 ID 的载体。
 * 子键非法或被拒的值只记请求类别，不落盘键名。
 *
 * @param {object} value 来源提供的容器
 * @param {object} spec 容器规格 `{ subKeys, valueKind, enumValues? }`
 * @returns {object|null} 投影后的容器；完全为空时返回 null（不写空对象）
 */
export function validateStructuredMap(value, spec, collector = null, category = null) {
  if (!isPlainObject(value)) {
    recordRejection(collector, category);
    return null;
  }
  const allowedSubKeys = new Set(spec.subKeys);
  const projected = {};
  for (const [subKey, entry] of Object.entries(value)) {
    if (!allowedSubKeys.has(subKey)) {
      recordRejection(collector, category);
      continue;
    }
    if (spec.valueKind === "count") {
      if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0 || entry > MAX_COUNT) {
        recordRejection(collector, category);
        continue;
      }
      projected[subKey] = entry;
      continue;
    }
    if (typeof entry !== "string" || !spec.enumValues?.includes(entry)) {
      recordRejection(collector, category);
      continue;
    }
    projected[subKey] = entry;
  }
  return Object.keys(projected).length > 0 ? projected : null;
}

/**
 * 校验并投影来源返回的 `scanned`。
 *
 * 只接受 `SCANNED_FIELD_KINDS` 里**逐名列出**的键，未知键一律拒绝——
 * 不按字符形状放行，因为 `alice123` 这类短标识符完全符合任何合理的形状正则。
 * `sources` 为 `来源名 -> 计数` 的映射，来源名限四来源枚举。
 */
export function validateScanned(value, target = {}, collector = null) {
  if (!isPlainObject(value)) {
    recordRejection(collector, REJECTION_CATEGORIES.scannedNonObject);
    return target;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "sources") {
      if (!isPlainObject(entry)) {
        recordRejection(collector, REJECTION_CATEGORIES.scannedSources);
        continue;
      }
      const sources = {};
      for (const [kind, count] of Object.entries(entry)) {
        if (!PROBE_SOURCES.includes(kind)) {
          recordRejection(collector, REJECTION_CATEGORIES.scannedSources);
          continue;
        }
        if (!Number.isSafeInteger(count) || count < 0 || count > MAX_COUNT) {
          recordRejection(collector, REJECTION_CATEGORIES.scannedValue);
          continue;
        }
        sources[kind] = count;
      }
      target[key] = sources;
      continue;
    }
    const kind = SCANNED_FIELD_KINDS[key];
    if (!kind) {
      recordRejection(collector, REJECTION_CATEGORIES.scannedUnknownField);
      continue;
    }
    if (kind === "flag") {
      if (typeof entry !== "boolean") {
        recordRejection(collector, REJECTION_CATEGORIES.scannedValue);
        continue;
      }
      target[key] = entry;
      continue;
    }
    // kind 为 count：只接受非负安全整数。早先这里还有一个 boolean 分支，
    // 会把 files: true / rowsScanned: false 当成合法计数放行——那是类型漏洞，已删除。
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0 || entry > MAX_COUNT) {
      recordRejection(collector, REJECTION_CATEGORIES.scannedValue);
      continue;
    }
    target[key] = entry;
  }
  return target;
}

/**
 * 校验并投影来源返回的 `fields` 与 `decisions`。
 *
 * **按字段名走显式白名单**，而不是按值的字符形状放行。原因：形状判据永远不充分——
 * `alice123`、`runner01` 这类短标识完全符合任何合理的正则，却正是要拦住的原始 ID。
 * 因此这里穷举允许的键，未知键一律拒绝（`*-unknown-field-rejected`）。
 *
 * 值只在字段已知时才被接受，并按字段的声明类型校验：
 * - 计数键：非负安全整数；
 * - 布尔键：布尔；
 * - 穷举枚举键：必须精确命中允许值之一；
 * - 自由枚举键：低熵枚举串（仍拒绝 UUID / 摘要 / 路径 / 超长串）。
 *
 * `scope` 只用于把拒绝项归入固定类别（`fields-*` / `decisions-*`），
 * 来源提供的键名与值一律不写进产物。
 */
export function validateScalarMap(
  value,
  target = {},
  scope = "fields",
  collector = null,
  { reservedKeys = null } = {},
) {
  const record = (category) => recordRejection(collector, category);
  const isDecisions = scope === "decisions";
  if (!isPlainObject(value)) {
    record(isDecisions ? REJECTION_CATEGORIES.decisionsNonObject : REJECTION_CATEGORIES.fieldsNonObject);
    return target;
  }
  const keyCategory = isDecisions ? REJECTION_CATEGORIES.decisionsKey : REJECTION_CATEGORIES.fieldsKey;
  const valueCategory = isDecisions ? REJECTION_CATEGORIES.decisionsValue : REJECTION_CATEGORIES.fieldsValue;
  const unknownCategory = isDecisions
    ? REJECTION_CATEGORIES.decisionsUnknownField
    : REJECTION_CATEGORIES.fieldsUnknownField;
  const countKeys = isDecisions ? DECISIONS_COUNT_KEYS : FIELDS_COUNT_KEYS;
  const booleanKeys = isDecisions ? DECISIONS_BOOLEAN_KEYS : FIELDS_BOOLEAN_KEYS;
  const enumValues = isDecisions ? DECISIONS_ENUM_VALUES : FIELDS_ENUM_VALUES;
  const freeEnumKeys = isDecisions ? [] : FIELDS_FREE_ENUM_KEYS;
  const structuredSpecs = isDecisions ? STRUCTURED_DECISIONS : STRUCTURED_FIELDS;

  for (const [key, entry] of Object.entries(value)) {
    if (!FIELD_NAME_PATTERN.test(key)) {
      record(keyCategory);
      continue;
    }
    if (reservedKeys?.includes(key)) {
      record(REJECTION_CATEGORIES.decisionsReserved);
      continue;
    }
    // 结构化容器：固定容器名 + 固定子键白名单，用于逐列存在性、flag/warning 计数。
    const structured = structuredSpecs?.[key];
    if (structured) {
      const projected = validateStructuredMap(entry, structured, collector, unknownCategory);
      if (projected) target[key] = projected;
      continue;
    }
    const known =
      countKeys.includes(key) || booleanKeys.includes(key) || key in enumValues || freeEnumKeys.includes(key);
    if (!known) {
      // 未知字段名：来源可能正试图携带会话 ID、路径或正文。
      record(unknownCategory);
      continue;
    }
    if (countKeys.includes(key)) {
      if (!Number.isSafeInteger(entry) || entry < 0 || entry > MAX_COUNT) {
        record(valueCategory);
        continue;
      }
      target[key] = entry;
      continue;
    }
    if (booleanKeys.includes(key)) {
      if (typeof entry !== "boolean") {
        record(valueCategory);
        continue;
      }
      target[key] = entry;
      continue;
    }
    if (typeof entry !== "string") {
      record(valueCategory);
      continue;
    }
    const allowed = enumValues[key];
    if (Array.isArray(allowed)) {
      if (!allowed.includes(entry)) {
        record(valueCategory);
        continue;
      }
      target[key] = entry;
      continue;
    }
    // 自由枚举键：仍需低熵，避免把 UUID/摘要当成枚举塞进来。
    const isEnum =
      entry.length <= ENUM_VALUE_MAX_LENGTH && ENUM_VALUE_PATTERN.test(entry) && !HIGH_ENTROPY_RUN_PATTERN.test(entry);
    if (!isEnum) {
      record(valueCategory);
      continue;
    }
    target[key] = entry;
  }
  return target;
}

/** scanned 至少要有实际扫描范围；完全空的对象不是有效探测产物。 */
export function scannedLooksEmpty(scanned) {
  return !isPlainObject(scanned) || Object.keys(scanned).length === 0;
}

/**
 * 有效性判定：不合格的来源结果不能被记为 ok，否则无效探测会冒充成功证据。
 * 不合格统一走 `PROBE_RESULT_INVALID`（退出码 4）。
 */
export function assertProbeResultValid(envelope, { full = false } = {}) {
  const invalid = (reason) => {
    const error = new ProbeCliError("PROBE_RESULT_INVALID", PROBE_EXIT_CODES.failed, `探测结果不合格：${reason}`);
    error.reason = reason;
    throw error;
  };

  if (scannedLooksEmpty(envelope.scanned)) invalid("scanned-missing");
  const fileCount = envelope.scanned.files;
  if (fileCount === undefined) invalid("scanned-files-missing");
  if (fileCount === 0) {
    const warnings = envelope.warnings.map((entry) => entry.code);
    if (!warnings.some((code) => NO_FILE_CODES.includes(code))) invalid("scanned-files-zero-without-reason");
  }
  // 全量计数一致性：无论是否 --full 都要校验。来源可能给出
  // files=10 / filesDiscovered=0 / filesScanned=0 这种自相矛盾的组合，
  // 若只看大小关系就会放行一份内部矛盾的证据。
  //
  // 语义：`scanned.files` 是**已发现的来源文件总数**（对齐方案的文件规模口径），
  // `filesDiscovered` 是同一口径的显式声明，`filesScanned` 是本次实际扫描数。
  // 因此恒有 filesScanned <= filesDiscovered == scanned.files。
  const declared = readFullScanCounts(envelope);
  if (declared) {
    if (declared.scanned > declared.discovered) invalid("full-scan-counts-inconsistent");
    if (declared.discovered !== fileCount) invalid("full-scan-counts-inconsistent");
  }
  if (full) {
    // 全量的定义是"已发现的文件是否全部扫描"，不是固定数量门槛。
    if (!declared) invalid("full-scan-counts-missing");
    if (declared && declared.scanned < declared.discovered) invalid("full-scan-incomplete");
  }

  const counts = envelope.scanned.rowsScanned ?? envelope.scanned.rows;
  if (counts === undefined) invalid("scanned-rows-missing");
  if (counts > 0 && !Array.isArray(envelope.fieldRejections)) invalid("field-rejections-missing");

  // 指纹投影可能把整个对象清空（例如来源只给了被拒绝的路径指纹），
  // 因此“有指纹”指的是对象里至少还留有一个聚合键。
  const hasFingerprint = (value) => Boolean(value) && Object.keys(value).length > 0;
  if (
    envelope.liveSourceChanged &&
    !(hasFingerprint(envelope.sourceFingerprintBefore) && hasFingerprint(envelope.sourceFingerprintAfter))
  ) {
    invalid("live-source-changed-without-fingerprints");
  }
  return envelope;
}

/**
 * 读取全量扫描的两个计数。来源模块可放在 `scanned` 或 `decisions` 的任一别名下；
 * 两者都缺失时无法判定全量，视为不合格（而不是放行）。
 * @returns {{discovered:number, scanned:number}|null}
 */
export function readFullScanCounts(envelope) {
  const find = (keys) => {
    for (const source of [envelope.scanned, envelope.decisions]) {
      for (const key of keys) {
        const entry = source?.[key];
        if (Number.isSafeInteger(entry) && entry >= 0) return entry;
      }
    }
    return undefined;
  };
  const discovered = find(FULL_SCAN_DISCOVERED_KEYS);
  const scanned = find(FULL_SCAN_SCANNED_KEYS);
  if (discovered === undefined || scanned === undefined) return null;
  return { discovered, scanned };
}

function countSummary(value) {
  if (!value || typeof value !== "object") return "none";
  const parts = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number" && Number.isFinite(entry)) parts.push(`${key}=${entry}`);
  }
  return parts.length ? parts.join(" ") : "none";
}

async function loadSourceModule(source, sourceModuleRoot = SOURCE_MODULE_ROOT) {
  const modulePath = new URL(`${source}.mjs`, sourceModuleRoot);
  const moduleFile = fileURLToPath(modulePath);
  if (!existsSync(moduleFile)) {
    throw new ProbeCliError(
      "SOURCE_MODULE_MISSING",
      PROBE_EXIT_CODES.unavailable,
      `来源模块 scripts/perf-probe-sources/${source}.mjs 尚不存在（对应来源卡未交付）。`,
    );
  }
  try {
    return await import(modulePath.href);
  } catch (error) {
    const detail = safeErrorDetail(error);
    throw new ProbeCliError(
      "SOURCE_MODULE_LOAD_FAILED",
      PROBE_EXIT_CODES.unavailable,
      detail ? `来源模块加载失败（${detail}）。` : "来源模块加载失败。",
    );
  }
}

/**
 * 运行一次探测。返回 exit code；失败时结果文件仍写入退出原因。
 * @returns {Promise<number>}
 */
export async function runPerfProbe(
  argv,
  { log = (line) => console.log(line), outputRoot = VALIDATION_ROOT, sourceModuleRoot = SOURCE_MODULE_ROOT } = {},
) {
  const startedAt = new Date().toISOString();
  let options;
  try {
    options = parseProbeArgs(argv);
  } catch (error) {
    if (!(error instanceof ProbeCliError)) throw error;
    log(`perf-probe status=usage-error code=${error.code}`);
    if (error.hint) log(error.hint);
    return error.exitCode;
  }

  if (options.help) {
    log(usageText());
    return PROBE_EXIT_CODES.ok;
  }

  let outputDir;
  try {
    if (!options.source) {
      throw new ProbeCliError("MISSING_SOURCE", PROBE_EXIT_CODES.usage, "--source 必填；--help 查看用法。");
    }
    if (!PROBE_SOURCES.includes(options.source)) {
      throw new ProbeCliError(
        "INVALID_SOURCE",
        PROBE_EXIT_CODES.usage,
        `--source 只接受 ${PROBE_SOURCES.join(" | ")}。`,
      );
    }
    outputDir = resolveRunOutputDirectory(options.output, { validationRoot: outputRoot });
  } catch (error) {
    if (!(error instanceof ProbeCliError)) throw error;
    log(`perf-probe status=usage-error code=${error.code}`);
    if (error.hint) log(error.hint);
    return error.exitCode;
  }

  const { revision: gitRevision, dirtyState } = gitState();
  const envelope = {
    probeVersion: PROBE_VERSION,
    methodVersion: METHOD_VERSION,
    source: options.source,
    status: "ok",
    startedAt,
    endedAt: startedAt,
    nodeVersion: process.version,
    gitRevision,
    dirtyState,
    sourceFingerprintBefore: null,
    sourceFingerprintAfter: null,
    liveSourceChanged: false,
    scanned: {},
    fields: {},
    decisions: {
      full: options.full,
      maxFiles: options.full ? null : options.maxFiles,
      maxRows: options.full ? null : options.maxRows,
    },
    warnings: [],
    fieldRejections: [],
    exitCode: PROBE_EXIT_CODES.ok,
  };

  try {
    const module = await loadSourceModule(options.source, sourceModuleRoot);
    if (typeof module.probe !== "function") {
      throw new ProbeCliError("PROBE_EXPORT_MISSING", PROBE_EXIT_CODES.failed, "来源模块缺少 probe() 导出。");
    }
    const result =
      (await module.probe({
        maxFiles: envelope.decisions.maxFiles,
        maxRows: envelope.decisions.maxRows,
        full: options.full,
        outputDir,
      })) || {};
    const rejections = createRejectionCollector();
    envelope.scanned = validateScanned(result.scanned, {}, rejections);
    envelope.fields = validateScalarMap(result.fields, {}, "fields", rejections);
    if (isPlainObject(result.decisions)) {
      // `full / maxFiles / maxRows` 是外壳独占字段：来源模块的同名键被拒绝，
      // 否则结果文件记录的探测参数会与实际执行的参数不一致。
      const decisions = validateScalarMap(result.decisions, {}, "decisions", rejections, {
        reservedKeys: RESERVED_DECISION_KEYS,
      });
      Object.assign(envelope.decisions, decisions);
    } else if (result.decisions !== undefined) {
      rejections.record(REJECTION_CATEGORIES.decisionsNonObject);
    }
    envelope.sourceFingerprintBefore = projectFingerprint(result.sourceFingerprintBefore, {}, rejections);
    envelope.sourceFingerprintAfter = projectFingerprint(result.sourceFingerprintAfter, {}, rejections);
    const normalized = normalizeWarnings(result.warnings);
    envelope.warnings = normalized.warnings;
    if (normalized.dropped) envelope.decisions.droppedWarnings = normalized.dropped;
    envelope.fieldRejections = rejections.list();
    const beforePrint = envelope.sourceFingerprintBefore?.fingerprint;
    const afterPrint = envelope.sourceFingerprintAfter?.fingerprint;
    envelope.liveSourceChanged =
      typeof result.liveSourceChanged === "boolean"
        ? result.liveSourceChanged
        : Boolean(beforePrint && afterPrint && beforePrint !== afterPrint);
    assertProbeResultValid(envelope, { full: options.full });
    envelope.status = "ok";
  } catch (thrown) {
    let failure = thrown;
    if (!(failure instanceof ProbeCliError)) {
      const detail = safeErrorDetail(failure);
      failure = new ProbeCliError(
        "PROBE_FAILED",
        PROBE_EXIT_CODES.failed,
        detail ? `探测失败（${detail}）。` : "探测失败。",
      );
      failure.cause = { name: detail ?? undefined };
    }
    envelope.status = "failed";
    envelope.errorCode = failure.code;
    envelope.exitCode = failure.exitCode;
    if (failure.code === "PROBE_FAILED") {
      const detail = safeErrorDetail(failure.cause ?? null);
      if (detail) envelope.decisions.failureName = detail;
    }
    if (failure.code === "PROBE_RESULT_INVALID" && failure.reason) {
      envelope.decisions.invalidReason = failure.reason;
    }
  }

  envelope.endedAt = new Date().toISOString();
  const outputFile = path.join(outputDir, `${options.source}-probe.json`);
  try {
    await mkdir(outputDir, { recursive: true });
    await writeFile(outputFile, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  } catch (error) {
    const detail = safeErrorDetail(error);
    log(`perf-probe status=internal-error code=OUTPUT_WRITE_FAILED${detail ? ` detail=${detail}` : ""}`);
    return PROBE_EXIT_CODES.internal;
  }

  log(`perf-probe source=${options.source} status=${envelope.status} exit=${envelope.exitCode}`);
  log(`scanned: ${countSummary(envelope.scanned)}`);
  log(
    `warnings: ${envelope.warnings.length ? envelope.warnings.map((entry) => `${entry.code}=${entry.count}`).join(" ") : "none"}`,
  );
  if (envelope.fieldRejections?.length) log(`field-rejections: ${envelope.fieldRejections.length}`);
  if (envelope.errorCode) log(`error-code: ${envelope.errorCode}`);
  return envelope.exitCode;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    process.exitCode = await runPerfProbe(process.argv.slice(2));
  } catch {
    console.error("perf-probe status=internal-error");
    process.exitCode = PROBE_EXIT_CODES.internal;
  }
}
