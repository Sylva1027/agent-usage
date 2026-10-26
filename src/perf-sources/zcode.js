// M2.1 ZCode 请求尝试行 reader（只读）。
//
// 职责边界：读**一个**物理 `db.sqlite`，把 `model_usage` 的每条**尝试行**变成一个 raw 候选，
// 用回调逐条输出。本模块**不做**规范化、不做统计、不做去重：`normalizePerfSample`
// （`src/perf-stats.js`）由集成层调用。这里只保证字段名与枚举值与 M1.1 的输入契约自洽。
//
// 冻结依据：
// - 实施总计划:66 的固定签名 `streamZcodePerfSamples(filePath, source, onSample, { onWarning })`
// - 方案 §17.1:197 身份元组 `(home_id, row.id)`；§17.1:198-205 的 ZCode 取值/单位/代理/模型证据
// - `source-contract.md` §1.1（ZCode 已确认事实）、§2-E（sampled 扣除集）、§2-F（终态未验证判据）、
//   §2-O（`session_id` 纳入冲突检测、不纳入身份）、§3（跨源共性口径 10 条）、
//   裁定 P（名字类字段用 `""`、枚举用 `unknown`）、裁定 R（`diagnosticReason` 是来源侧词表）、
//   裁定 T（`PERF_EPOCH_MS_MIN = 1e12` 秒/毫秒判据）
//
// 三条不容妥协的规则（M0 裁定 + M2 卡明文）：
// 1. **显式真 0/负数不暗中回退**：`duration_ms` 列存在且为安全整数时**一律**采用原值
//    （含 0 与负数），只有该列为 NULL/缺失/非整数时才用两个 epoch-ms 时间戳之差。
// 2. **只读打开失败不回退普通打开**：本文件只有一个 `readOnly: true` 构造点。
// 3. **被过滤的候选仍要交给集成层**（覆盖率要用它算 drained 原因）：过滤只体现为
//    `overlay` 字段（status/retryCount/cancelledByUser/sourceFiltered/filterReason），
//    绝不在这里 `continue` 掉有身份的候选。
//
// 不复用也不 import 任何其他 reader（M2 卡明文）；不 import `src/perf-stats.js`
// （由集成层做规范化，reader 保持纯读取）。`localeCompare` 全程禁止（契约 AE-2）：
// 迭代顺序由 SQL 的 `ORDER BY id` 决定，代码内的比较一律用代码单元 `<` / `>`。

import { DatabaseSync } from "node:sqlite";

/** §17.1:197 的身份元组只含 `id`；这是**唯一**参与身份键的 ZCode 列。 */
export const ZCODE_IDENTITY_COLUMNS = Object.freeze(["id"]);

/**
 * SQL 字段白名单（M2.1 卡第 2 条）。
 * 身份 / 状态 / 计数 / 时长 / 代理 / 模型 六类必需列，一个不多一个不少。
 * **TTFT 两列不在其中**：方案 §17.1:202 与 `source-contract.md` §1.1 要求只验存在性、
 * 永不读取取值，因此它们**永远不可能**进入 SELECT 列表。
 */
export const ZCODE_SELECT_COLUMNS = Object.freeze([
  "id",
  "session_id",
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
  "agent",
  "query_source",
  "task_type",
  "model_id",
  "provider_id",
  "variant",
]);

/** 能力守护：表名与必需列缺失时的编码原因（契约 §3；`UNSUPPORTED_SCHEMA` 在册）。 */
export const ZCODE_TABLE_NAME = "model_usage";
export const ZCODE_MINIMUM_COLUMNS = Object.freeze(["id", "status", "output_tokens"]);

/** 本 reader 可以发出的 warning 编码；**全部**取自 `PERF_SOURCE_WARNING_CODES`（裁定 Q）。 */
export const ZCODE_READER_WARNING_CODES = Object.freeze([
  "READ_ONLY_OPEN_FAILED",
  "UNSUPPORTED_SCHEMA",
  "UNKEYABLE_RECORD",
]);

/**
 * §17.1 的 `status` 枚举（`PERF_STATUSES`）。
 * ZCode 来源列的字面值 → 规范枚举的映射；别名与 `PERF_STATUS_ALIASES` 一致
 * （`error` → `failed`、`canceled` → `cancelled`）。**未识别的字面值给 `unverified`，不猜 completed。**
 */
const ZCODE_STATUS_LITERALS = Object.freeze({
  completed: "completed",
  success: "completed",
  succeeded: "completed",
  error: "failed",
  failed: "failed",
  failure: "failed",
  cancelled: "cancelled",
  canceled: "cancelled",
  in_progress: "in_progress",
  pending: "in_progress",
  running: "in_progress",
  queued: "in_progress",
});

/** 明确进行中：只有这些字面值配 `inProgress`（契约 §6.3 的"明确进行中"纪律）。 */
const ZCODE_IN_PROGRESS_LITERALS = Object.freeze(new Set(["in_progress", "pending", "running", "queued"]));

/** 名字类字段的 trim 口径见下；此处先定义整数载体的共用常量。 */
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
/**
 * 字符串载体的**十进制整数文本**判据（返工 2）。
 * 刻意**不**接受：十六进制 `0x`、二进制 `0b`、八进制 `0o`、科学计数法 `e/E`、
 * 小数点、下划线分隔、`Infinity`/`NaN`。这些都不是"十进制整数文本"。
 * 接受：可选正负号 + 至少一位十进制数字（`"+5"`/`"-5"`/`"007"`/`"42"`）。
 */
const ZCODE_DECIMAL_INTEGER_TEXT = /^[+-]?\d+$/;

/**
 * 名字类字段的 reader 侧处理：**只 trim，不归一 `unknown`**。
 *
 * 裁定 P 的 `unknown` → `""` 归一是 `normalizePerfSample` 的**权威职责**（`nameOrEmpty`）。
 * reader 若提前归一，raw 候选里"来源真的写了一个叫 unknown 的值"这一事实就消失了，
 * 属于 reader 越权，也会让下游无法区分"来源没给"与"来源给了 unknown 字面量"。
 */
function nameValue(value) {
  return trimmed(value);
}

function trimmed(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/**
 * 安全整数分类，与 M1 的 `classifyInteger` 同构（reader 侧独立实现，不 import 内核）。
 *
 * **类别名必须与内核一致**，否则集成层按类别分派时会漏掉一支。
 *
 * `bigint` 的取舍（本卡返工裁定）：**安全 bigint 按值分派 positive/zero/negative，
 * 不安全 bigint 判 unsafe** —— 即"与 number 路径同语义（同值同类别）"。
 * 理由：
 * 1. 若"bigint 一律 unsafe"，则 `0n`（来源用 bigint 传字面真 0）会被当成越界值而**回退**，
 *    正好绕过本卡最不容妥协的"显式真 0 不得暗中回退"规则。语义上 `0n` 就是零，
 *    它的类型不该改变它的含义。
 * 2. "同值同类别"是可断言的强性质：`classify(x) === classify(x)` 对两种载体成立，
 *    集成层不必为 bigint 单独分支。
 *
 * **精度安全**：`Number(9007199254740993n)` 会**静默丢失精度**（实测得 `9007199254740992`），
 * 因此**绝不**先转再判 —— 必须先做范围安全检查，只有确认在安全整数范围内才允许转。
 * 注意判据是 `2n**53n` 而非十进制直觉：`MAX_SAFE_INTEGER = 2n**53n - 1n` 安全，
 * `2n**53n` 不安全。
 *
 * 关于"先判后转"的**理由订正**（Lead 实测反馈，返工 2）：把 `2**53`/`2**60`/`2**64` 附近
 * ±1000 共 10005 个值穷举，**"先判范围再转"与"先转再判"分歧数为 0** —— 因为
 * `Number.isSafeInteger(2**53) === false`，两者判据是**同一个边界**（`2**53 - 1`）。
 * 所以"不先转"的收益**不是分类差异**（该差异目前不存在），而是：
 * ① 不依赖 `Number(bigint)` 的舍入行为（隐晦、易被误读）；
 * ② 将来若有人改动边界常量（例如改用 `2n**64n` 或自定义上限），两者**才会真正分歧**。
 * **不得**写成"不先转否则会分错" —— 那句话当前无法被测试证伪。
 *
 * **`string` 载体（返工 2 修正）**：字符串**不**走 `Number()` 直转。JS 的 `Number()`
 * 会把纯空白当 `0`（`Number(" ") === 0`）、把十六进制当数值（`Number("0x10") === 16`）、
 * 接受科学计数法（`Number("1e3") === 1000`）与二进制/八进制（`Number("0b101") === 5`）。
 * 若直转，`duration_ms = " "` 会被判 `explicit` 并产出 `durationMs = 0` ——
 * 即**把空白当成"真实的 0 毫秒"**，违反契约 §3 第 5 条"缺字段 ≠ 0"与裁定 N"0 不得冒充真值"。
 *
 * 因此字符串的先置判据是"**十进制整数文本**"：先 `trim()`（`trim()` 实测能去掉
 * NBSP/U+3000 等 Unicode 空白），trim 后为空 ⇒ `missing`；否则必须整体匹配
 * `ZCODE_DECIMAL_INTEGER_TEXT`（`/^[+-]?\d+$/`）才继续按十进制解析。
 * **`"+5"` 的取舍：判 `positive`** —— SQLite 自身把 `"+5"` 按 INTEGER 亲和转成整数 `5`
 * （实测），故 `+` 前缀是 SQLite 认可的合法十进制整数文本；拒绝它会与"来源是 SQLite"
 * 这一事实相冲突。负号同理（`"-5"` ⇒ `negative`）。
 *
 * **可达性（如实标注）**：**真实库当前该列全为 `integer`、TEXT 行为 0** —— 即
 * **未在真实数据观测到**。但本分支**不是纯防御性**：SQLite 的类型宽容性允许 TEXT 落库
 * （实测：列声明 `INTEGER` 时 `' '`/`'0x10'`/`'abc'` 均**保留为 `typeof='text'`**），
 * 且本函数是导出符号。**不得**写成"已在真实数据观测"。
 * @returns {"missing" | "zero" | "positive" | "negative" | "non_integer" | "unsafe" | "not_a_number"}
 */
export function classifyZcodeInteger(value) {
  if (value === null || value === undefined || value === "") return "missing";
  if (typeof value === "boolean") return "not_a_number";
  if (typeof value === "bigint") {
    // 先判范围再转数（理由见函数注释：不依赖 Number(bigint) 的舍入行为，
    // 且边界常量变动时才与"先转后判"分歧 —— 当前两者是同一判据，差异不存在）。
    if (value > MAX_SAFE_BIGINT || value < -MAX_SAFE_BIGINT) return "unsafe";
    const exact = Number(value);
    if (exact === 0) return "zero";
    return exact > 0 ? "positive" : "negative";
  }
  if (typeof value === "string") {
    // 纯空白（含 NBSP/U+3000）trim 后为空 ⇒ 缺失，**绝不是 0**（契约 §3 第 5 条）。
    const text = value.trim();
    if (text === "") return "missing";
    // 只接受十进制整数文本：`0x`/`0b`/`0o`/`e`/小数点一律 not_a_number。
    if (!ZCODE_DECIMAL_INTEGER_TEXT.test(text)) return "not_a_number";
    const parsed = Number(text);
    if (!Number.isSafeInteger(parsed)) return "unsafe";
    if (parsed === 0) return "zero";
    return parsed > 0 ? "positive" : "negative";
  }
  if (typeof value !== "number") return "not_a_number";
  const number = value;
  if (!Number.isFinite(number)) return "not_a_number";
  if (!Number.isInteger(number)) return "non_integer";
  if (!Number.isSafeInteger(number)) return "unsafe";
  if (number === 0) return "zero";
  return number > 0 ? "positive" : "negative";
}

/** 安全整数原值，或 `null`（**只有**该路径允许把不可用值变成 `null`）。 */
function safeIntegerOrNull(value) {
  const state = classifyZcodeInteger(value);
  if (state === "zero" || state === "positive" || state === "negative") return Number(value);
  return null;
}

/** 真值判定：0/空/`false`/`"false"`/`"0"` 都是假，只有明确的正值/`true` 为真。 */
function isTruthyFlag(value) {
  if (value === true) return true;
  const state = classifyZcodeInteger(value);
  return state === "positive";
}

/**
 * 裁定 T：纪元毫秒判据。返回 `{ ok, unitKnown }`。
 * `PERF_EPOCH_MS_MIN = 1e12` 与 M1 一致；秒级时间戳必须先转毫秒（契约 §3 第 7 条）。
 */
export const ZCODE_EPOCH_MS_MIN = 1_000_000_000_000;
const ZCODE_EPOCH_SECONDS_MAX = 10_000_000_000;

/**
 * 把一个时间列的值规范成 epoch 毫秒。
 * - 缺失 → `{ ms: null, unitKnown: true }`（不是 0）
 * - 秒级（<= 1e10）→ **转成毫秒**（契约 §3 第 7 条强制），`unitKnown: true`
 * - 毫秒级（>= 1e12）→ 原值
 * - 介于两者之间 → 单位无法判定：`unitKnown: false`，**不猜单位**，值不参与时长计算
 * - 0 / 负数 → 越界，不参与
 * @returns {{ ms: number | null, unitKnown: boolean }}
 */
export function normalizeZcodeTimestamp(value) {
  const state = classifyZcodeInteger(value);
  if (state === "missing") return { ms: null, unitKnown: true };
  if (state !== "zero" && state !== "positive") return { ms: null, unitKnown: true };
  const number = Number(value);
  if (number === 0) return { ms: null, unitKnown: true };
  if (number >= ZCODE_EPOCH_MS_MIN) return { ms: number, unitKnown: true };
  if (number <= ZCODE_EPOCH_SECONDS_MAX) return { ms: number * 1000, unitKnown: true };
  return { ms: null, unitKnown: false };
}

/**
 * 只读打开。**唯一**的构造点；失败抛 `ZcodeReadOnlyOpenError`，绝不回退普通打开。
 * 之所以能这样收口：SQLite 对非数据库文件是**延迟读文件头**的，构造可能成功而第一次
 * 读 schema 才失败，因此能力守护也一并归入本错误类型。
 */
export class ZcodeReadOnlyOpenError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "ZcodeReadOnlyOpenError";
    this.code = code;
  }
}

function openReadOnly(filePath) {
  try {
    // 冻结要求：只读；这里**没有**任何可写回退分支。
    return new DatabaseSync(filePath, { readOnly: true });
  } catch {
    throw new ZcodeReadOnlyOpenError("READ_ONLY_OPEN_FAILED", "zcode read-only open failed");
  }
}

function readAvailableColumns(database) {
  try {
    const rows = database.prepare(`SELECT name FROM pragma_table_info('${ZCODE_TABLE_NAME}')`).all();
    if (!rows.length) return null;
    return new Set(rows.map((row) => trimmed(row.name)));
  } catch {
    // 延迟读文件头：非 SQLite 文件在这里才暴露。
    throw new ZcodeReadOnlyOpenError("READ_ONLY_OPEN_FAILED", "zcode schema read failed on read-only handle");
  }
}

/**
 * 构造 SELECT 语句。只从 `ZCODE_SELECT_COLUMNS` 取列并与实际可用列求交，
 * 因此 **TTFT 列名在结构上不可能进入 SQL**。`ORDER BY id` 保证稳定迭代。
 * @param {Set<string>} available
 */
export function buildZcodeSelectSql(available) {
  const columns = ZCODE_SELECT_COLUMNS.filter((name) => available.has(name));
  if (columns.length === 0) return "";
  const quoted = columns.map((name) => `"${name}"`);
  const order = available.has("id") ? ' ORDER BY "id"' : "";
  return `SELECT ${quoted.join(", ")} FROM "${ZCODE_TABLE_NAME}"${order}`;
}

function selectableColumn(available, name) {
  return available.has(name);
}

/**
 * 把一行映射成 raw 候选的**覆盖层**：状态、重试、取消、来源过滤与诊断原因。
 * 过滤**只标记不丢弃**（M2.1 卡第 8 条）：集成层需要这些候选算覆盖率与 drained 原因。
 * @returns {{ status: string, inProgress: boolean, terminalVerified: boolean, cancelledByUser: boolean,
 *             retryCount: number | null, sourceFiltered: boolean, filterReason: string,
 *             flags: string[] }}
 */
export function classifyZcodeRow(row, available) {
  const rawStatus = selectableColumn(available, "status") ? trimmed(row.status).toLowerCase() : "";
  const status = Object.hasOwn(ZCODE_STATUS_LITERALS, rawStatus) ? ZCODE_STATUS_LITERALS[rawStatus] : "unverified";
  const inProgress = ZCODE_IN_PROGRESS_LITERALS.has(rawStatus);

  const completedState = selectableColumn(available, "completed_at")
    ? classifyZcodeInteger(row.completed_at)
    : "missing";
  const completedPresent = completedState === "zero" || completedState === "positive";

  // 裁定 F：`statusKind === "other"`，或 `completed` 但 `completed_at === null`。
  // `unverified` 字面值在这里天然命中第一支（未识别状态 → unverified → 终态未验证）。
  const terminalVerified = !(status === "unverified" || (status === "completed" && !completedPresent));

  const cancelledByUser = selectableColumn(available, "cancelled_by_user") && isTruthyFlag(row.cancelled_by_user);
  const retryCount = selectableColumn(available, "retry_count") ? safeIntegerOrNull(row.retry_count) : null;
  const attemptIndex = selectableColumn(available, "attempt_index") ? safeIntegerOrNull(row.attempt_index) : null;
  const retryable = selectableColumn(available, "retryable") && isTruthyFlag(row.retryable);
  const retry = (retryCount !== null && retryCount > 0) || (attemptIndex !== null && attemptIndex > 0);

  // 来源过滤：状态属失败/取消、用户取消、或重试尝试，都只标记不丢弃。
  // 主原因按固定优先级取一个（`source_*` 是来源侧 `filterReason` 词表，不是 droppedByReason）。
  let filterReason = "";
  if (status === "failed") filterReason = "source_failed";
  else if (status === "cancelled" || cancelledByUser) filterReason = "source_cancelled";
  else if (retry) filterReason = "source_retry";
  else if (status === "unverified") filterReason = "source_terminal_unverified";
  const sourceFiltered = filterReason !== "";

  /** @type {string[]} */
  const flags = [];
  if (sourceFiltered) flags.push("SOURCE_FILTERED");
  if (!terminalVerified) flags.push("TERMINAL_UNVERIFIED");
  if (retryable && !sourceFiltered) flags.push("SOURCE_FILTERED");

  return {
    status,
    inProgress,
    terminalVerified,
    cancelledByUser,
    retryCount: retryCount === null ? (attemptIndex === null ? null : 0) : retryCount,
    sourceFiltered,
    filterReason,
    flags,
  };
}

/**
 * 时长解析：**显式优先，缺失才回退**。
 *
 * 这是本 reader 最不容妥协的一条：M0 裁定 E 与 fixture-cases 明文要求
 * "显式真 0/负数**不得**暗中回退到时间戳差"。因此判据是**列可用性**而不是**值是否为正**：
 * - `duration_ms` 列存在且值为安全整数（含 0、含负数）→ `timingSource = "explicit"`，原值直出
 * - `duration_ms` 列不存在，或该行值为 NULL/非整数/超安全整数 → 回退 `completed_at - started_at`
 *   （两者都已规范成 epoch 毫秒、且差值 >= 0），`timingSource = "timestamp_fallback"`
 * - 两侧都不可用 → `durationMs = null`（缺失，**不是 0**）
 * @returns {{ durationMs: number | null, timingSource: string }}
 */
export function resolveZcodeDuration(row, available) {
  if (selectableColumn(available, "duration_ms")) {
    const state = classifyZcodeInteger(row.duration_ms);
    if (state === "zero" || state === "positive" || state === "negative") {
      // 显式原值：0 就是 0，负数就是负数，都不许回退。
      return { durationMs: Number(row.duration_ms), timingSource: "explicit" };
    }
  }
  const started = selectableColumn(available, "started_at") ? normalizeZcodeTimestamp(row.started_at) : { ms: null };
  const completed = selectableColumn(available, "completed_at")
    ? normalizeZcodeTimestamp(row.completed_at)
    : { ms: null };
  if (started.ms === null || completed.ms === null) return { durationMs: null, timingSource: "unknown" };
  const difference = completed.ms - started.ms;
  if (difference < 0) return { durationMs: null, timingSource: "timestamp_fallback" };
  return { durationMs: difference, timingSource: "timestamp_fallback" };
}

/**
 * 把一行变成 raw 候选（`PerfSampleRaw` 形状，供集成层喂 `normalizePerfSample`）。
 *
 * 产出的字段全部是 M1.1 认识的输入名；语义字段（window/timingKind/tokenScope）**不在此处**
 * 提供 ZCode 之外的任何值——由集成层按 `PERF_SOURCE_SEMANTICS` 权威赋值，reader 显式传
 * 与 `PERF_SOURCE_SEMANTICS.zcode` 完全一致的值只是为了早期暴露不一致。
 *
 * @param {Record<string, unknown>} row
 * @param {Set<string>} available
 * @param {{ homeId: string, sourcePath: string }} context
 * @returns {Record<string, unknown> | null} `null` 表示无稳定身份（进 `UNKEYABLE_RECORD`）
 */
export function zcodeRowToRawSample(row, available, context) {
  const rowId = selectableColumn(available, "id") ? trimmed(row.id) : "";
  // §17.1:205：不能形成稳定身份的原始行不写候选表，只累计编码 sourceWarnings。
  // 时间戳**绝不**用来临时冒充稳定 id。
  if (rowId === "") return null;

  const classification = classifyZcodeRow(row, available);
  const { durationMs, timingSource } = resolveZcodeDuration(row, available);

  const started = selectableColumn(available, "started_at") ? normalizeZcodeTimestamp(row.started_at) : { ms: null };
  const completed = selectableColumn(available, "completed_at")
    ? normalizeZcodeTimestamp(row.completed_at)
    : { ms: null };
  // tsMs 优先 completed_at，缺失回退 started_at（M2.1 卡第 5 条）。两者皆缺 → null（unplaced 候选保留）。
  const tsMs = completed.ms !== null ? completed.ms : started.ms;

  const outputState = selectableColumn(available, "output_tokens")
    ? classifyZcodeInteger(row.output_tokens)
    : "missing";
  let outputTokens = null;
  if (outputState === "zero" || outputState === "positive" || outputState === "negative") {
    outputTokens = Number(row.output_tokens);
  }

  const inputTokens = selectableColumn(available, "input_tokens") ? safeIntegerOrNull(row.input_tokens) : null;

  const querySource = selectableColumn(available, "query_source") ? trimmed(row.query_source) : "";
  const taskType = selectableColumn(available, "task_type") ? trimmed(row.task_type) : "";
  // M2.1 卡第 9 条：`query_source`/`task_type` 的明确 subagent 标志优先；
  // 裁定 B/§3 第 4 条：**main 不反推** —— 非 subagent 一律 `unknown`。
  const subagentFlagged = querySource === "subagent" || taskType === "subagent_child";
  const agent = nameValue(selectableColumn(available, "agent") ? row.agent : "");
  // 名称只作展示/分组维度；kind 只由明确标志决定，永远不给 main。
  const agentKind = subagentFlagged ? "subagent" : "unknown";

  const model = nameValue(selectableColumn(available, "model_id") ? row.model_id : "");
  const provider = nameValue(selectableColumn(available, "provider_id") ? row.provider_id : "");
  const variant = selectableColumn(available, "variant") ? trimmed(row.variant) : "";

  const logicalRequestId = selectableColumn(available, "logical_request_id") ? trimmed(row.logical_request_id) : "";

  return {
    sourceKind: "zcode",
    homeId: context.homeId,
    sourcePath: context.sourcePath,
    sampleKey: JSON.stringify(["zcode", context.homeId, rowId]),
    identity: [rowId],
    rowId,
    sessionId: selectableColumn(available, "session_id") ? trimmed(row.session_id) : "",
    channel: subagentFlagged ? "zcode-subagent" : "zcode",
    agentKind,
    agent,
    model,
    modelProvider: provider,
    reasoningEffort: variant,
    // §17.1:203：model_id/provider_id/variant 是请求作用域列，不是轮上下文。
    modelEvidence: "request_scope",
    // 显式传与 PERF_SOURCE_SEMANTICS.zcode 相同的值；不一致会得 SOURCE_SEMANTICS_MISMATCH。
    window: "request",
    timingKind: "request_e2e",
    // 2026-10-21 evidence: output_tokens and reasoning_tokens are separate columns, but their inclusion relation is unproven.
    tokenScope: "reported_output_unspecified",
    status: classification.status,
    terminalVerified: classification.terminalVerified,
    inProgress: classification.inProgress,
    cancelledByUser: classification.cancelledByUser,
    retryCount: classification.retryCount,
    sourceFiltered: classification.sourceFiltered,
    filterReason: classification.filterReason,
    tsMs,
    startedAtMs: started.ms,
    completedAtMs: completed.ms,
    windowStartMs: started.ms,
    windowEndMs: completed.ms,
    durationMs,
    timingSource,
    outputTokens,
    inputTokens,
    requestCount: 1,
    // `logical_request_id` **只辅助重试过滤**（§17.1:205 明文"不作唯一键"）：
    // 它只作为诊断维度携带，不参与 sampleKey、不参与身份。
    turnKey: logicalRequestId,
    sampleFlags: classification.flags,
  };
}

/**
 * 读一个 ZCode 数据库文件，逐条输出 raw 候选（M2.1 固定签名）。
 *
 * @param {string} filePath `db.sqlite` 的路径
 * @param {{ id?: unknown, path?: unknown, label?: unknown }} source 发现到的来源（提供 `homeId`）
 * @param {(sample: Record<string, unknown>) => void} onSample 每条候选调用一次（**含被过滤的候选**）
 * @param {{ onWarning?: (warning: { sourceKind: string, homeId: string, code: string, count: number }) => void }} [options]
 *   非致命问题通过编码 warning 上报；致命（只读打开/能力守护失败）**抛出**，由集成层标 degraded。
 * @returns {Promise<{ rowsScanned: number, samples: number, unkeyable: number }>}
 */
export async function streamZcodePerfSamples(filePath, source, onSample, options = {}) {
  const onWarning = typeof options.onWarning === "function" ? options.onWarning : () => {};
  const homeId = trimmed(source?.id) || trimmed(source?.path);
  const sourcePath = trimmed(source?.path) || trimmed(filePath);
  const stats = { rowsScanned: 0, samples: 0, unkeyable: 0 };

  // 致命路径：只读打开失败与能力守护失败都抛出（集成层据此标 degraded），
  // 与"非致命走 onWarning"分工明确。
  const database = openReadOnly(filePath);
  try {
    const available = readAvailableColumns(database);
    if (available === null) {
      throw new ZcodeReadOnlyOpenError("UNSUPPORTED_SCHEMA", "zcode model_usage table missing");
    }
    for (const name of ZCODE_MINIMUM_COLUMNS) {
      if (!available.has(name)) {
        throw new ZcodeReadOnlyOpenError("UNSUPPORTED_SCHEMA", `zcode model_usage missing required column ${name}`);
      }
    }

    const sql = buildZcodeSelectSql(available);
    if (sql === "") {
      throw new ZcodeReadOnlyOpenError("UNSUPPORTED_SCHEMA", "zcode has no selectable column");
    }

    for (const row of database.prepare(sql).iterate()) {
      stats.rowsScanned += 1;
      const sample = zcodeRowToRawSample(row, available, { homeId, sourcePath });
      if (sample === null) {
        // 无稳定身份：不写候选表，只累计编码 warning（§17.1:205）。
        stats.unkeyable += 1;
        continue;
      }
      stats.samples += 1;
      onSample(sample);
    }
  } finally {
    try {
      database.close();
    } catch {
      // 关闭失败不影响已输出的候选。
    }
  }

  if (stats.unkeyable > 0) {
    onWarning({ sourceKind: "zcode", homeId, code: "UNKEYABLE_RECORD", count: stats.unkeyable });
  }
  return stats;
}
