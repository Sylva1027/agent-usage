/**
 * M0.2 ZCode 有界字段与过滤证据（只读）。
 *
 * 契约边界（与冻结外壳 `scripts/perf-probe.mjs` 的 `--help` 一致，本文件不改外壳）：
 * - 只读打开：`new DatabaseSync(dbFile, { readOnly: true })`；打开失败只记 `READ_ONLY_OPEN_FAILED`
 *   编码告警并计数，**不回退可写**（没有普通 `new DatabaseSync(dbFile)` 分支）。
 * - 只 `SELECT` `ZCODE_REQUIRED_COLUMNS`（§17.1 与 M0.2-1 点名的 19 列）。TTFT 相关列
 *   （`first_token_at` / `time_to_first_token_ms`）只通过 `pragma_table_info` 报存在性，
 *   **永不进入 SELECT 列表**，也不参与任何 TPS/时长公式。
 * - 产物只含聚合计数与枚举；home 路径与数据库路径只进入 SHA-256 指纹的**输入**，
 *   摘要落盘、原文不落盘；行值（含 id/session_id/正文列）一律不落盘。
 * - `probe()` 返回 `{scanned, fields, decisions, warnings, sourceFingerprintBefore,
 *   sourceFingerprintAfter, liveSourceChanged}`；`decisions.full / maxFiles / maxRows`
 *   由外壳独占，本文件不返回。
 *
 * 分层口径（写进 `scanned`，见 `docs/plans/2026-10-03-model-latency-throughput-plan.md` §17.5）：
 * - `rawCount = rowsScanned`：原始读取行数（含重复身份与缺身份行）。
 * - `eligible`：去重后、有稳定身份且 ts 可定位的候选（缺 ts 进 `unplaced`，不进 eligible）。
 * - `positiveOutput`：eligible 中 output 已知且 > 0；`timedPositiveOutput`：其中时长观测为正；
 *   `completeTimedPositiveOutput`：其中目标时窗完整（ZCode window=request，行内时窗即完整）。
 * - `sampled`：timedPositiveOutput 中 status=completed 且无取消/重试标记的候选。
 * - `pending`：明确进行中；`dropped = eligible - sampled - pending`（按减法构造，恒等式成立）。
 * - 身份 `(home_id, row.id)`：重复且一致折叠，重复且冲突记 `RECORD_CONFLICT` 并撤回该身份的
 *   sampled（不任选末条、不静默求和）。
 *
 * 受阻项（不在外壳白名单内，未上报，留给 M0.6）：
 * - TTFT 列名 `first_token_at` / `time_to_first_token_ms` 不在 `KNOWN_COLUMN_NAMES`，
 *   只能汇总成 `fields.ttftColumnPresent` 布尔，无法逐列报存在性。
 * - `scanned` 没有 agent 角色分层计数键（`subagentRows` / `mainRows` / `unknownAgentRows`），
 *   因此 agent_kind 的三分结论只有枚举与开关，没有数字证据。
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { discoverZcodeHomes } from "../../src/usage-core.js";
import { zcodeSourceStat } from "../../src/zcode-usage.js";

/** M0.2-1 点名的 19 列；同时是唯一的 SELECT 字段白名单。 */
export const ZCODE_REQUIRED_COLUMNS = Object.freeze([
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
]);

/**
 * TTFT 列候选：只用于 `pragma_table_info` 的存在性判断。
 * 这些列名不在外壳 `KNOWN_COLUMN_NAMES` 里，因此只能汇总成 `fields.ttftColumnPresent`。
 */
export const ZCODE_TTFT_COLUMNS = Object.freeze(["first_token_at", "time_to_first_token_ms"]);

/** §17.4 的 longWindowMs 首版阈值：只提示，不剔除。 */
export const ZCODE_LONG_WINDOW_MS = 300_000;

/** §17.4 的 16 个有效 flag（位 2/3 保留）。测试与外壳 `PERF_FLAG_NAMES` 逐项比对。 */
export const ZCODE_FLAG_NAMES = Object.freeze([
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

/** §3 的 8 个 `sourceWarnings.code`；测试与外壳 `SOURCE_WARNING_CODES` 逐项比对。 */
export const ZCODE_WARNING_CODES = Object.freeze([
  "UNKEYABLE_RECORD",
  "READ_ONLY_OPEN_FAILED",
  "UNSUPPORTED_SCHEMA",
  "MALFORMED_JSON",
  "MALFORMED_FRAME",
  "LIVE_SOURCE_CHANGED",
  "OPTIONAL_SOURCE_UNAVAILABLE",
  "AGGREGATE_OVERFLOW",
]);

/** 秒/毫秒判据：纪元毫秒在 1e11 以上，纪元秒在 1e10 以下。 */
const EPOCH_MS_LOWER_BOUND = 100_000_000_000;
const EPOCH_SECONDS_UPPER_BOUND = 10_000_000_000;

const MODEL_USAGE_TABLE = "model_usage";
const COMPLETED_STATUSES = Object.freeze(["completed", "success", "succeeded"]);
const FAILED_STATUSES = Object.freeze(["error", "failed", "failure"]);
const CANCELLED_STATUSES = Object.freeze(["cancelled", "canceled"]);
const PENDING_STATUSES = Object.freeze(["in_progress", "pending", "running", "queued"]);

function quoteIdentifier(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function canonicalTrim(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  if (typeof value === "bigint") {
    const fromBigInt = Number(value);
    return Number.isFinite(fromBigInt) ? fromBigInt : null;
  }
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTruthyFlag(value) {
  if (value === true) return true;
  if (typeof value === "string" && ["true", "yes"].includes(value.trim().toLowerCase())) return true;
  const parsed = toFiniteNumber(value);
  return parsed !== null && parsed > 0;
}

/**
 * 显式 subagent 标记判据（M0.6 决议 B 的行级分层依据）。
 *
 * `agent` 列只给名称，**不构成角色证据**；`query_source`/`task_type` 的取值里出现
 * `subagent` 这类显式标记时，才给出 `subagent`。没有任何证据时一律 `unknown`，
 * **绝不反推 `main`**（方案 §17.6：不把名称自动映射成角色）。
 */
function hasSubagentFlag(row, available) {
  for (const name of ["query_source", "task_type"]) {
    const value = canonicalTrim(readColumn(row, available, name)).toLowerCase();
    if (value?.includes("subagent")) return true;
  }
  return false;
}

function readColumn(row, available, name) {
  if (!available.has(name)) return undefined;
  return row[name];
}

/**
 * 唯一的 SELECT 列表构造入口：只取 `ZCODE_REQUIRED_COLUMNS` 的成员，
 * 因此 TTFT 列名不可能出现在 SQL 里（回归测试对此断言）。
 */
export function buildSelectSql(columns, limit = null) {
  const allowed = ZCODE_REQUIRED_COLUMNS.filter((name) => columns.includes(name));
  if (allowed.length === 0) return "";
  const order = [];
  if (allowed.includes("completed_at")) order.push(quoteIdentifier("completed_at"));
  if (allowed.includes("id")) order.push(quoteIdentifier("id"));
  const orderClause = order.length ? ` ORDER BY ${order.join(", ")}` : "";
  const limitClause = limit === null ? "" : " LIMIT ?";
  return `SELECT ${allowed.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(MODEL_USAGE_TABLE)}${orderClause}${limitClause}`;
}

/** 有界探测取"首尾文件"：前 ceil(n/2) 与后 floor(n/2)，保持规范排序。 */
export function selectBoundedFiles(files, maxFiles) {
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0 || files.length <= maxFiles) return files.slice();
  const head = Math.ceil(maxFiles / 2);
  const tail = maxFiles - head;
  return [...files.slice(0, head), ...files.slice(files.length - tail)];
}

function collectFiles(homes) {
  const seen = new Set();
  const files = [];
  let homeCount = 0;
  for (const home of homes) {
    const dbFile = typeof home?.dbFile === "string" ? home.dbFile.trim() : "";
    if (!dbFile) continue;
    homeCount += 1;
    const resolved = path.resolve(dbFile);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    files.push({ homeId: canonicalTrim(home.id) || resolved, homePath: canonicalTrim(home.path), resolved });
  }
  files.sort((left, right) => (left.resolved < right.resolved ? -1 : left.resolved > right.resolved ? 1 : 0));
  return { files, homeCount };
}

async function discoverDefaultHomes() {
  const homes = await discoverZcodeHomes();
  return homes.map((home) => ({ id: home.id, path: home.path, dbFile: home.usageLogPath }));
}

/** 指纹只落 SHA-256 摘要与计数；路径与 home 标识仅作为摘要输入。 */
async function buildFingerprint(files) {
  const entries = [];
  for (const file of files) {
    try {
      const stat = await zcodeSourceStat(file.resolved);
      entries.push(`${file.homeId}\u0000${file.resolved}\u0000${stat.size}\u0000${stat.mtimeMs}`);
    } catch {
      entries.push(`${file.homeId}\u0000${file.resolved}\u0000unavailable`);
    }
  }
  return {
    contentFingerprint: createHash("sha256").update(entries.join("\n")).digest("hex"),
    fileCount: files.length,
    homeCount: new Set(files.map((file) => file.homeId)).size,
    checkedAt: new Date().toISOString(),
  };
}

function createCounters(files, homeCount) {
  const flags = {};
  for (const name of ZCODE_FLAG_NAMES) flags[name] = 0;
  const warningCounts = {};
  for (const code of ZCODE_WARNING_CODES) warningCounts[code] = 0;
  return {
    files,
    homeCount,
    filesScanned: 0,
    openFailures: 0,
    schemaMissing: 0,
    errors: 0,
    rowsTotal: 0,
    rowsScanned: 0,
    tablesRead: 0,
    walPresent: false,
    ttftColumnPresent: false,
    ttftColumnCount: 0,
    durationColumnPresent: 0,
    retryCountColumnPresent: 0,
    attemptIndexColumnPresent: 0,
    cancelledByUserColumnPresent: 0,
    statusColumnPresent: 0,
    agentNameColumnPresent: 0,
    subagentFlagColumnPresent: 0,
    // M0.6 决议 B：agent 角色分层的**行级**计数。`agent_kind` 的三分结论必须有数字证据。
    // 判据（与 zcodeChannel() 同一份）：`query_source`/`task_type` 命中 subagent 标记 → subagent；
    // 无该列或值不足以证明角色 → unknownAgentRows；**main 不由本来源赋予**（无已核实的主代理证据）。
    subagentRows: 0,
    mainRows: 0,
    unknownAgentRows: 0,
    unkeyable: 0,
    uniqueIdentities: 0,
    duplicateRows: 0,
    duplicateGroups: 0,
    consistentDuplicates: 0,
    conflictingGroups: 0,
    // session 归属冲突维度：与 11 字段签名并列的独立检查。该维度**已被真正执行**——
    // 每一条重复行都会做一次 `previous.sessionSignature !== sessionSignature` 比对；
    // 发现不一致的行不进 `consistentDuplicates`，而是进 `conflictingGroups` 并置 RECORD_CONFLICT。
    // 这三个计数器是内部核算量（用于断言恒等式），本身不直接上报：
    // 外壳白名单没有本维度的专用上报键，专用键属 M0.6 冻结范围。
    sessionOwnershipCheckedRows: 0,
    sessionOwnershipConflictRows: 0,
    sessionOwnershipConflictGroups: 0,
    statusCompleted: 0,
    statusError: 0,
    statusCancelled: 0,
    statusOther: 0,
    retry: 0,
    attemptNonZero: 0,
    retryable: 0,
    cancelledByUser: 0,
    outputPositive: 0,
    outputZero: 0,
    outputMissing: 0,
    outputInvalid: 0,
    positiveDuration: 0,
    durationFallback: 0,
    durationMissing: 0,
    durationChecked: 0,
    durationMismatch: 0,
    explicitDurationUsed: 0,
    unplaced: 0,
    timedPositive: 0,
    sampled: 0,
    pending: 0,
    tsMin: null,
    tsMax: null,
    flags,
    warningCounts,
    models: new Set(),
    providers: new Set(),
    agents: new Set(),
    sessions: new Set(),
    homes: new Set(),
    logicalRequestIds: new Map(),
    columnPresence: new Map(),
  };
}

function readModelUsageColumns(database) {
  const rows = database.prepare(`SELECT name FROM pragma_table_info('${MODEL_USAGE_TABLE}')`).all();
  if (!rows.length) return null;
  return new Set(rows.map((row) => canonicalTrim(row.name)));
}

function recordColumnPresence(counters, available) {
  for (const name of ZCODE_REQUIRED_COLUMNS) {
    const entry = counters.columnPresence.get(name) ?? { present: 0, absent: 0 };
    if (available.has(name)) entry.present += 1;
    else entry.absent += 1;
    counters.columnPresence.set(name, entry);
  }
  if (ZCODE_TTFT_COLUMNS.some((name) => available.has(name))) counters.ttftColumnPresent = true;
  for (const name of ZCODE_TTFT_COLUMNS) {
    if (available.has(name)) counters.ttftColumnCount += 1;
  }
  if (available.has("duration_ms")) counters.durationColumnPresent += 1;
  if (available.has("retry_count")) counters.retryCountColumnPresent += 1;
  if (available.has("attempt_index")) counters.attemptIndexColumnPresent += 1;
  if (available.has("cancelled_by_user")) counters.cancelledByUserColumnPresent += 1;
  if (available.has("status")) counters.statusColumnPresent += 1;
  if (available.has("agent")) counters.agentNameColumnPresent += 1;
  if (available.has("query_source") || available.has("task_type")) counters.subagentFlagColumnPresent += 1;
}

function classifyStatus(status) {
  if (COMPLETED_STATUSES.includes(status)) return "completed";
  if (FAILED_STATUSES.includes(status)) return "error";
  if (CANCELLED_STATUSES.includes(status)) return "cancelled";
  if (PENDING_STATUSES.includes(status)) return "pending";
  return "other";
}

/**
 * 单行分类：不写日志、不保留原始值，只返回计数用的判定与 flag。
 * 「显式真 0/负数不得暗中回退」：`duration_ms` 存在且 <= 0 时只记 `DURATION_NONPOSITIVE`，
 * 不用 `completed_at - started_at` 覆盖；只有列缺失或值为 NULL 才走 epoch 差回退。
 */
function classifyCandidate(row, available, counters) {
  const flags = [];
  const status = canonicalTrim(readColumn(row, available, "status")).toLowerCase();
  const statusKind = classifyStatus(status);
  const completedAt = toFiniteNumber(readColumn(row, available, "completed_at"));
  const startedAt = toFiniteNumber(readColumn(row, available, "started_at"));
  const explicitDuration = readColumn(row, available, "duration_ms");
  const explicitDurationPresent =
    available.has("duration_ms") &&
    explicitDuration !== null &&
    explicitDuration !== undefined &&
    explicitDuration !== "";

  // ---- 输出：缺失 / 真 0 / 负值与非整数必须分开
  let outputState = "missing";
  const outputRaw = readColumn(row, available, "output_tokens");
  const outputPresent =
    available.has("output_tokens") && outputRaw !== null && outputRaw !== undefined && outputRaw !== "";
  if (!outputPresent) {
    flags.push("MISSING_OUTPUT");
  } else {
    const outputValue = toFiniteNumber(outputRaw);
    if (outputValue === null || !Number.isInteger(outputValue) || outputValue < 0) {
      outputState = "invalid";
      flags.push("TOKEN_INVALID");
    } else if (outputValue === 0) {
      outputState = "zero";
      flags.push("OUTPUT_ZERO");
    } else {
      outputState = "positive";
    }
  }

  // ---- 时长：显式优先，NULL/缺列才回退；显式 0/负不回退
  let durationMs = null;
  let durationSource = "none";
  let durationChecked = false;
  let durationMismatch = false;
  if (explicitDurationPresent) {
    const explicitValue = toFiniteNumber(explicitDuration);
    if (explicitValue === null || !Number.isInteger(explicitValue)) {
      flags.push("TIME_INVALID");
    } else {
      durationMs = explicitValue;
      durationSource = "explicit";
      counters.explicitDurationUsed += 1;
      if (explicitValue <= 0) flags.push("DURATION_NONPOSITIVE");
      if (startedAt !== null && completedAt !== null) {
        durationChecked = true;
        if (completedAt - startedAt !== explicitValue) durationMismatch = true;
      }
    }
  } else if (startedAt !== null && completedAt !== null) {
    const difference = completedAt - startedAt;
    if (difference > 0) {
      durationMs = difference;
      durationSource = "epoch_diff";
    } else {
      flags.push("TIME_INVALID", "MISSING_DURATION");
    }
  } else {
    flags.push("MISSING_DURATION");
  }
  if (durationSource === "none" && !flags.includes("TIME_INVALID") && !flags.includes("MISSING_DURATION")) {
    flags.push("MISSING_DURATION");
  }

  const durationPositive = durationMs !== null && durationMs > 0;
  if (durationPositive && durationMs > ZCODE_LONG_WINDOW_MS) flags.push("LONG_WINDOW");

  // ---- ts_ms：completed_at，缺失回退 started_at；缺 ts 进 unplaced
  const tsMs =
    completedAt !== null && completedAt > 0 ? completedAt : startedAt !== null && startedAt > 0 ? startedAt : null;
  const tsPlaced = tsMs !== null;
  if (!tsPlaced) flags.push("TIME_UNPLACED");

  // ---- 终态与来源过滤标记
  const cancelledByUser = isTruthyFlag(readColumn(row, available, "cancelled_by_user"));
  const retryCount = toFiniteNumber(readColumn(row, available, "retry_count"));
  const attemptIndex = toFiniteNumber(readColumn(row, available, "attempt_index"));
  const retry = (retryCount !== null && retryCount > 0) || (attemptIndex !== null && attemptIndex > 0);
  const terminalUnverified = statusKind === "other" || (statusKind === "completed" && completedAt === null);
  if (statusKind !== "pending") {
    // 明确进行中归 pending：不假装失败，也不加 SOURCE_FILTERED / TERMINAL_UNVERIFIED。
    if (terminalUnverified) flags.push("TERMINAL_UNVERIFIED");
    if (statusKind === "error" || statusKind === "cancelled" || cancelledByUser || retry) {
      flags.push("SOURCE_FILTERED");
    }
  }

  // ---- agent 角色分层（M0.6 决议 B）
  // 判据与 zcodeChannel() 同一份：显式 subagent 标记（`query_source`/`task_type` 命中）优先。
  // `agent` 列只给**名称**，不构成角色证据；`main` 只允许由 P0 核实过的源值赋予。
  // 本来源没有可核实的主代理证据，因此剩余全部计入 unknown —— **绝不反推 main**。
  const subagentFlag = hasSubagentFlag(row, available);
  const agentRole = subagentFlag ? "subagent" : "unknown";

  return {
    statusKind,
    outputState,
    durationSource,
    durationPositive,
    durationChecked,
    durationMismatch,
    tsMs,
    tsPlaced,
    cancelledByUser,
    retry,
    terminalUnverified,
    agentRole,
    attemptIndexNonZero: attemptIndex !== null && attemptIndex > 0,
    retryable: isTruthyFlag(readColumn(row, available, "retryable")),
    flags,
    model: canonicalTrim(readColumn(row, available, "model_id")),
    provider: canonicalTrim(readColumn(row, available, "provider_id")),
    agent: canonicalTrim(readColumn(row, available, "agent")),
    session: canonicalTrim(readColumn(row, available, "session_id")),
    logicalRequestId: canonicalTrim(readColumn(row, available, "logical_request_id")),
  };
}

function aggregateCandidate(candidate, counters) {
  counters.uniqueIdentities += 1;
  for (const flag of candidate.flags) counters.flags[flag] += 1;
  if (candidate.agentRole === "subagent") counters.subagentRows += 1;
  else if (candidate.agentRole === "main") counters.mainRows += 1;
  else counters.unknownAgentRows += 1;

  if (candidate.statusKind === "completed") counters.statusCompleted += 1;
  else if (candidate.statusKind === "error") counters.statusError += 1;
  else if (candidate.statusKind === "cancelled") counters.statusCancelled += 1;
  else if (candidate.statusKind !== "pending") counters.statusOther += 1;
  // pending 单独计数，且必须在 eligible 内（缺 ts 的进 unplaced，不进 pending）。

  if (candidate.statusKind === "pending" && candidate.tsPlaced) counters.pending += 1;
  if (candidate.retry) counters.retry += 1;
  if (candidate.attemptIndexNonZero) counters.attemptNonZero += 1;
  if (candidate.retryable) counters.retryable += 1;
  if (candidate.cancelledByUser) counters.cancelledByUser += 1;

  if (candidate.outputState === "zero") counters.outputZero += 1;
  else if (candidate.outputState === "invalid") counters.outputInvalid += 1;
  else if (candidate.outputState === "missing") counters.outputMissing += 1;
  // positiveOutput 是 eligible 内的分层计数：缺 ts 的候选进 unplaced，不进这一档（§17.5）。
  if (candidate.tsPlaced && candidate.outputState === "positive") counters.outputPositive += 1;

  if (candidate.durationSource === "epoch_diff") counters.durationFallback += 1;
  if (candidate.durationSource === "none") counters.durationMissing += 1;
  if (candidate.durationPositive) counters.positiveDuration += 1;
  if (candidate.durationChecked) counters.durationChecked += 1;
  if (candidate.durationMismatch) counters.durationMismatch += 1;

  if (candidate.tsPlaced) {
    counters.tsMin = counters.tsMin === null ? candidate.tsMs : Math.min(counters.tsMin, candidate.tsMs);
    counters.tsMax = counters.tsMax === null ? candidate.tsMs : Math.max(counters.tsMax, candidate.tsMs);
  } else {
    counters.unplaced += 1;
  }

  if (candidate.tsPlaced && candidate.outputState === "positive" && candidate.durationPositive) {
    counters.timedPositive += 1;
    // §17.5:276 的 `sampled` 是"**通过默认筛选**"的候选；:278 的主原因优先级里
    // `terminal unverified` 是明确的不合格原因。因此终态未验证（缺 completed_at 的
    // completed 行等）必须落 dropped，不能同时计进 sampled。
    if (
      candidate.statusKind === "completed" &&
      !candidate.terminalUnverified &&
      !candidate.cancelledByUser &&
      !candidate.retry
    ) {
      counters.sampled += 1;
    }
  }

  if (candidate.model) counters.models.add(candidate.model);
  if (candidate.provider) counters.providers.add(candidate.provider);
  if (candidate.agent) counters.agents.add(candidate.agent);
  if (candidate.session) counters.sessions.add(candidate.session);
  if (candidate.logicalRequestId) {
    counters.logicalRequestIds.set(
      candidate.logicalRequestId,
      (counters.logicalRequestIds.get(candidate.logicalRequestId) ?? 0) + 1,
    );
  }
}

/**
 * 身份签名用于"重复是否一致"的折叠判定：同一 `(home_id, id)` 的非空计数/归属/起止值
 * 必须一致，否则记 RECORD_CONFLICT，不任选末条、不静默求和。
 *
 * **身份构成不变**：方案 §17.1:197 的身份元组是 `(home_id, row.id)`，`session_id` 不在其中，
 * 因此签名**不参与身份键**。但"同 id 下 `session_id` 不一致"必须被检查出来并记冲突诊断
 * （见 `sessionIdSignature`），否则该维度会静默折叠——`conflictingRecords=0` 就再也
 * 分不清"已验证无冲突"与"从未检查"。
 */
function identitySignature(row, available) {
  const names = [
    "status",
    "output_tokens",
    "duration_ms",
    "started_at",
    "completed_at",
    "attempt_index",
    "retry_count",
    "retryable",
    "cancelled_by_user",
    "model_id",
    "provider_id",
  ];
  return names.map((name) => (available.has(name) ? canonicalTrim(row[name]) : "\u0001absent")).join("\u0000");
}

/**
 * 冲突检测维度：`session_id`。它**不是**身份构成（身份仍是 `(home_id, row.id)`），
 * 而是"同一身份下必须自洽的归属值"之一，与 `identitySignature()` 的同族检查并列，但
 * **单独一个签名**，这样"session 归属冲突"可以被独立识别与上报，而不会被 11 字段签名的
 * 其他差异掩盖。列为独立维度的另一个好处：该维度是否真的被检查过，可以从
 * `sessionIdCheckedCount` 读出来（"已验证无冲突" vs "未检查"不再是同一个 0）。
 */
function sessionIdSignature(row, available) {
  return available.has("session_id") ? canonicalTrim(row.session_id) : "\u0001absent";
}

function consumeRow(row, available, file, counters, identities) {
  const id = canonicalTrim(readColumn(row, available, "id"));
  if (!id) {
    counters.unkeyable += 1;
    return;
  }
  const identityKey = `${file.homeId}\u0000${id}`;
  const signature = identitySignature(row, available);
  const sessionSignature = sessionIdSignature(row, available);
  const previous = identities.get(identityKey);
  if (previous) {
    counters.duplicateRows += 1;
    if (!previous.counted) {
      previous.counted = true;
      counters.duplicateGroups += 1;
    }
    // 先做 session 归属检查：它是否成立与 11 字段签名是否一致**无关**。
    // 同 id 下 session_id 不一致 ⇒ 归属冲突，单独计数并进入同一个冲突组机制，
    // 但**绝不**因此产生第二个身份、也**绝不**静默折叠。
    const sessionOwnershipConflict = previous.sessionSignature !== sessionSignature;
    // "该维度被真正检查过"的机器可读证据：每一条重复行都做过一次 session 归属比对。
    counters.sessionOwnershipCheckedRows += 1;
    if (sessionOwnershipConflict) {
      counters.sessionOwnershipConflictRows += 1;
      if (!previous.sessionConflict) {
        previous.sessionConflict = true;
        counters.sessionOwnershipConflictGroups += 1;
      }
    }
    if (previous.signature === signature && !sessionOwnershipConflict) {
      counters.consistentDuplicates += 1;
      return;
    }
    if (previous.sampled) {
      previous.sampled = false;
      counters.sampled -= 1;
    }
    if (!previous.conflict) {
      previous.conflict = true;
      counters.conflictingGroups += 1;
      counters.flags.RECORD_CONFLICT += 1;
    }
    return;
  }
  const candidate = classifyCandidate(row, available, counters);
  // 与 aggregateCandidate 的 sampled 条件保持同一份判据（终态未验证不得计入 sampled），
  // 否则身份冲突撤回会与 sampled 计数不同步。
  const contributesToSampled =
    candidate.tsPlaced &&
    candidate.outputState === "positive" &&
    candidate.durationPositive &&
    candidate.statusKind === "completed" &&
    !candidate.terminalUnverified &&
    !candidate.cancelledByUser &&
    !candidate.retry;
  identities.set(identityKey, {
    signature,
    sessionSignature,
    conflict: false,
    sessionConflict: false,
    sampled: contributesToSampled,
    counted: false,
  });
  aggregateCandidate(candidate, counters);
}

function scanDatabase(file, { counters, identities, budget }) {
  let database = null;
  try {
    // 只读打开：失败即记录，绝不回退可写。
    database = new DatabaseSync(file.resolved, { readOnly: true });
  } catch {
    counters.openFailures += 1;
    counters.errors += 1;
    return;
  }
  try {
    counters.homes.add(file.homeId);
    if (existsSync(`${file.resolved}-wal`)) counters.walPresent = true;
    // 只读打开可能在构造时失败，也可能在第一次读 schema 时失败（SQLite 延迟读文件头）。
    // 两种都记 READ_ONLY_OPEN_FAILED 且不计入 filesScanned（未真正扫描到内容）。
    let available = null;
    try {
      available = readModelUsageColumns(database);
    } catch {
      counters.openFailures += 1;
      counters.errors += 1;
      return;
    }
    counters.filesScanned += 1;
    if (!available) {
      counters.schemaMissing += 1;
      return;
    }
    counters.tablesRead += 1;
    recordColumnPresence(counters, available);
    const selectColumns = ZCODE_REQUIRED_COLUMNS.filter((name) => available.has(name));
    if (selectColumns.length === 0) return;

    const totalRow = database.prepare(`SELECT COUNT(*) AS total FROM ${quoteIdentifier(MODEL_USAGE_TABLE)}`).get();
    const total = toFiniteNumber(totalRow?.total);
    if (total !== null) counters.rowsTotal += total;

    const remaining = budget === null ? null : budget.remaining(counters.rowsScanned);
    if (remaining !== null && remaining <= 0) return;
    const statement = database.prepare(buildSelectSql(selectColumns, remaining));
    const iterator = remaining === null ? statement.iterate() : statement.iterate(remaining);
    for (const row of iterator) {
      counters.rowsScanned += 1;
      try {
        consumeRow(row, available, file, counters, identities);
      } catch {
        counters.errors += 1;
      }
    }
  } catch {
    counters.errors += 1;
  } finally {
    try {
      database.close();
    } catch {
      // 关闭失败不影响已收集的计数。
    }
  }
}

function buildColumnEvidence(counters) {
  const columns = {};
  let present = 0;
  let absent = 0;
  let unknown = 0;
  for (const name of ZCODE_REQUIRED_COLUMNS) {
    const entry = counters.columnPresence.get(name);
    let state = "unknown";
    if (counters.tablesRead > 0 && entry) {
      if (entry.present === counters.tablesRead) state = "present";
      else if (entry.absent === counters.tablesRead) state = "absent";
    }
    columns[name] = state;
    if (state === "present") present += 1;
    else if (state === "absent") absent += 1;
    else unknown += 1;
  }
  return { columns, present, absent, unknown };
}

function inferTimeUnit(counters) {
  if (counters.tsMin === null || counters.tsMax === null) return "none";
  if (counters.tsMin >= EPOCH_MS_LOWER_BOUND) return "milliseconds";
  if (counters.tsMax <= EPOCH_SECONDS_UPPER_BOUND) return "seconds";
  return "unknown";
}

function inferDurationProvenance(counters) {
  const explicit = counters.explicitDurationUsed;
  const fallback = counters.durationFallback;
  if (explicit > 0 && fallback > 0) return "mixed";
  if (explicit > 0) return "explicit";
  if (fallback > 0) return "timestamp_fallback";
  return "none";
}

/** §17.5 的固定优先级：每个 dropped 只有一个主原因。 */
function inferDiagnosticReason(flags) {
  if (flags.RECORD_CONFLICT > 0) return "record_conflict";
  if (flags.MODEL_AMBIGUOUS > 0) return "model_ambiguous";
  if (flags.TERMINAL_UNVERIFIED > 0) return "terminal_unverified";
  if (flags.SOURCE_FILTERED > 0) return "source_filtered";
  if (flags.MISSING_OUTPUT + flags.OUTPUT_ZERO + flags.TOKEN_INVALID > 0) return "output_missing_zero_invalid";
  if (flags.MISSING_DURATION + flags.DURATION_NONPOSITIVE + flags.TIME_INVALID > 0) {
    return "duration_missing_nonpositive_invalid";
  }
  if (flags.PARTIAL_ITEM_SPAN > 0) return "partial_item_span";
  if (flags.OVERLAPPING_ITEM_SPAN > 0) return "overlapping_item_span";
  return "none";
}

async function runZcodeProbe(options, injectedHomes) {
  const startedMs = Date.now();
  const { maxFiles = null, maxRows = null, full = false } = options ?? {};
  const homes = Array.isArray(injectedHomes) ? injectedHomes : await discoverDefaultHomes();
  const { files, homeCount } = collectFiles(homes);
  const selected = full ? files.slice() : selectBoundedFiles(files, maxFiles);
  const sourceFingerprintBefore = await buildFingerprint(files);

  const counters = createCounters(files.length, homeCount);
  const identities = new Map();
  // 有界预算是**全源共享**的：跨文件累计已扫行数，达到 maxRows 即不再推进后续文件。
  // 预算耗尽时既不再打开、也不计入 filesScanned，因此 filesScanned 反映实际扫描过的文件数，
  // 而不是 selectBoundedFiles() 选中的文件数（保住 filesScanned <= filesDiscovered）。
  const budget = full
    ? null
    : {
        remaining: (scannedSoFar) => maxRows - scannedSoFar,
      };
  for (const file of selected) {
    if (budget && budget.remaining(counters.rowsScanned) <= 0) break;
    scanDatabase(file, { counters, identities, budget });
  }

  const sourceFingerprintAfter = await buildFingerprint(files);
  const liveSourceChanged = sourceFingerprintBefore.contentFingerprint !== sourceFingerprintAfter.contentFingerprint;
  // 告警计数容器由 §3 的 8 个编码组成；值全部来自编码计数，不含路径/正文。
  counters.warningCounts.UNKEYABLE_RECORD = counters.unkeyable;
  counters.warningCounts.READ_ONLY_OPEN_FAILED = counters.openFailures;
  counters.warningCounts.UNSUPPORTED_SCHEMA = counters.schemaMissing;
  counters.warningCounts.LIVE_SOURCE_CHANGED = liveSourceChanged ? 1 : 0;

  const columnEvidence = buildColumnEvidence(counters);
  const eligible = counters.uniqueIdentities - counters.unplaced;
  const dropped = eligible - counters.sampled - counters.pending;
  const rowCapReached = !full && Number.isSafeInteger(maxRows) && counters.rowsScanned >= maxRows;
  const fileScopeIncomplete = counters.filesScanned < files.length;
  const boundedIncomplete = !full && (rowCapReached || fileScopeIncomplete);

  const warningCounts = { ...counters.warningCounts };
  const warnings = Object.entries(warningCounts)
    .filter(([, count]) => count > 0)
    .map(([code, count]) => ({ code, count }));
  if (files.length === 0) warnings.push({ code: "SOURCE_UNAVAILABLE", count: 1 });

  const timeUnit = inferTimeUnit(counters);
  const durationBasis =
    counters.durationColumnPresent > 0 ? "explicit_ms" : counters.tablesRead > 0 ? "epoch_diff" : "none";
  const scanned = {
    files: files.length,
    filesDiscovered: files.length,
    filesScanned: counters.filesScanned,
    rowsTotal: counters.rowsTotal,
    rowsScanned: counters.rowsScanned,
    rowsRead: counters.rowsScanned,
    rowsSkipped: counters.unkeyable,
    errors: counters.errors,
    rawCount: counters.rowsScanned,
    uniqueIdentities: counters.uniqueIdentities,
    // M0.6 决议 B：agent 角色分层的行级数字证据（三分之和 === uniqueIdentities）。
    subagentRows: counters.subagentRows,
    mainRows: counters.mainRows,
    unknownAgentRows: counters.unknownAgentRows,
    // M0.6 决议 C：TTFT 两列的**逐列存在性计数**（0/1/2）。仍不读取任何取值。
    ttftColumnCount: counters.ttftColumnCount,
    duplicateIdentities: counters.duplicateRows,
    identityDuplicateCount: counters.duplicateRows,
    identityDuplicateGroupCount: counters.duplicateGroups,
    eligible,
    positiveOutput: counters.outputPositive,
    positiveCount: counters.outputPositive,
    positiveOutputRows: counters.outputPositive,
    timedPositiveOutput: counters.timedPositive,
    completeTimedPositiveOutput: counters.timedPositive,
    sampled: counters.sampled,
    afterFilterCount: counters.sampled,
    dropped,
    pending: counters.pending,
    unplaced: counters.unplaced,
    completedRows: counters.statusCompleted,
    errorRows: counters.statusError,
    cancelledRows: counters.statusCancelled,
    statusCompletedCount: counters.statusCompleted,
    statusErrorCount: counters.statusError,
    statusCancelledCount: counters.statusCancelled,
    statusOtherCount: counters.statusOther,
    retryRows: counters.retry,
    attemptIndexNonZeroCount: counters.attemptNonZero,
    retryableCount: counters.retryable,
    cancelledByUserCount: counters.cancelledByUser,
    logicalRequestIdDuplicateGroupCount: [...counters.logicalRequestIds.values()].filter((count) => count > 1).length,
    outputMissingCount: counters.outputMissing,
    outputZeroCount: counters.outputZero,
    positiveDurationRows: counters.positiveDuration,
    positiveDurationCount: counters.positiveDuration,
    missingTimestampCount: counters.unplaced,
    durationFallbackCount: counters.durationFallback,
    durationMismatchCount: counters.durationMismatch,
    conflictingRecords: counters.conflictingGroups,
    collapsedRecords: counters.consistentDuplicates,
    // 一致折叠的**字面含义**计数（在外壳白名单内，M0.6 冻结的键）。
    consistentDuplicateCount: counters.consistentDuplicates,
    // —— session 归属冲突维度（独立于 11 字段签名的检查）——
    // 机器可读区分"已验证无冲突"与"未检查"**不靠新键**，而是靠下面这一对的组合：
    //   存在被检查过的重复行 ⇒ `consistentDuplicateCount` 成了"已核对该维度的重复行的
    //     一致折叠数"；而该维度一旦发现不一致，这些行**不会**进 `consistentDuplicateCount`
    //     （见 consumeRow 的 sessionOwnershipConflict 分支），而是进 `conflictingRecords`
    //     并置 RECORD_CONFLICT。
    //   因此：`conflictingRecords === 0 && consistentDuplicateCount > 0` ⇒ 已验证无归属冲突；
    //     两者同为 0 ⇒ **无法区分**"无重复行可查"与"未检查"，此时不冒充 0（见下）。
    // 外壳白名单没有本维度的专用计数键，专用键属 M0.6 冻结范围，来源卡不得自行扩外壳，
    // 故此处不输出 `sessionOwnership*` 系列键（会被脱敏投影丢弃并记 fieldRejections）。
    bounded: !full,
    complete: full && !fileScopeIncomplete,
    capped: rowCapReached,
    hasMore: boundedIncomplete,
    truncated: boundedIncomplete,
    readOnly: true,
    walPresent: counters.walPresent,
    sources: { zcode: files.length },
  };

  const fields = {
    schemaKind: "zcode-sqlite",
    backend: "sqlite",
    tableName: MODEL_USAGE_TABLE,
    readOnlyStrategy: "database_sync_readonly",
    readOnly: true,
    writableFallbackUsed: false,
    timingKind: "request_e2e",
    windowKind: "request",
    tokenScope: "reported_output_unspecified",
    modelEvidence: "request_scope",
    modelScope: "model_id",
    providerMapping: "provider_id",
    providerScope: "provider_id",
    identityScheme: "row_id",
    databaseIdentityKind: "canonical_path",
    unitKind: timeUnit === "milliseconds" ? "ms" : timeUnit === "seconds" ? "s" : "unknown",
    timeUnit,
    durationBasis,
    durationProvenance: inferDurationProvenance(counters),
    explicitDurationUsed: counters.explicitDurationUsed > 0,
    timestampFallbackUsed: counters.durationFallback > 0,
    retryEvidence:
      counters.retryCountColumnPresent > 0
        ? "retry_count"
        : counters.attemptIndexColumnPresent > 0
          ? "attempt_index"
          : counters.tablesRead > 0
            ? "absent"
            : "unknown",
    cancelledEvidence:
      counters.cancelledByUserColumnPresent > 0
        ? "cancelled_by_user"
        : counters.statusColumnPresent > 0
          ? "status"
          : counters.tablesRead > 0
            ? "absent"
            : "unknown",
    agentKind: "unknown",
    agentKindMapping: counters.subagentFlagColumnPresent > 0 ? "explicit_subagent_flag" : "none",
    agentNameEvidence: counters.agentNameColumnPresent > 0 ? "agent_field" : "none",
    mainProven: false,
    agentRoleProven: counters.subagentFlagColumnPresent > 0,
    ttftColumnPresent: counters.ttftColumnPresent,
    ttftRead: false,
    streamAccessed: false,
    contentAccessed: false,
    sampled: !full,
    limited: !full,
    columnCount: ZCODE_REQUIRED_COLUMNS.length,
    presentColumnCount: columnEvidence.present,
    absentColumnCount: columnEvidence.absent,
    unknownColumnCount: columnEvidence.unknown,
    allColumnsPresent: columnEvidence.absent === 0 && columnEvidence.unknown === 0,
    identityUnique: counters.duplicateRows === 0,
    distinctModels: counters.models.size,
    distinctProviders: counters.providers.size,
    distinctAgents: counters.agents.size,
    distinctHomes: counters.homes.size,
    distinctSessions: counters.sessions.size,
    coverageState:
      files.length === 0 ||
      counters.filesScanned < files.length ||
      counters.errors > 0 ||
      counters.openFailures > 0 ||
      counters.schemaMissing > 0
        ? "degraded"
        : "ready",
    diagnosticReason: inferDiagnosticReason(counters.flags),
    columns: { ...columnEvidence.columns },
    requiredColumns: { ...columnEvidence.columns },
    columnStates: {
      present: columnEvidence.present,
      absent: columnEvidence.absent,
      unknown: columnEvidence.unknown,
      total: ZCODE_REQUIRED_COLUMNS.length,
    },
  };
  if (!full && Number.isSafeInteger(maxRows) && maxRows > 0) {
    fields.maxRows = maxRows;
    fields.maxFiles = Number.isSafeInteger(maxFiles) && maxFiles > 0 ? maxFiles : files.length;
  }

  const decisions = {
    filesDiscovered: files.length,
    filesScanned: counters.filesScanned,
    homeCount,
    sourceCount: homes.length,
    openedDatabaseCount: counters.filesScanned,
    checkedRowCount: counters.durationChecked,
    identityDuplicateGroupCount: counters.duplicateGroups,
    durationMs: Date.now() - startedMs,
    schemaKind: "zcode-sqlite",
    readOnly: true,
    readOnlyEnforced: true,
    identityUnique: counters.duplicateRows === 0,
    schemaDetected: counters.tablesRead > 0,
    fallbackUsed: counters.durationFallback > 0,
    liveSourceChanged,
    timingKind: "request_e2e",
    tokenScope: "reported_output_unspecified",
    warningCounts,
    flagCounts: { ...counters.flags },
  };

  return {
    scanned,
    fields,
    decisions,
    warnings,
    sourceFingerprintBefore,
    sourceFingerprintAfter,
    liveSourceChanged,
  };
}

/**
 * 生产入口：默认用 `discoverZcodeHomes()`（`~/.zcode` 与 `CODEX_USAGE_ZCODE_HOMES`）只读发现来源。
 * 测试通过 `createZcodeProbe({ homes })` 注入临时 fixture home，不依赖本机真实库。
 */
export async function probe(options = {}) {
  return runZcodeProbe(options, null);
}

/** 注入式入口：`homes` 为 `[]` 表示"明确的零来源"，`null` 走生产发现。 */
export function createZcodeProbe({ homes = null } = {}) {
  return { probe: (options = {}) => runZcodeProbe(options, homes) };
}
