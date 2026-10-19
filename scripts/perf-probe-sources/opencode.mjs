/**
 * M0.4：OpenCode 有界字段与版本证据（只读探测）。
 *
 * 证据边界：
 * - 只用 `DatabaseSync(dbFile, { readOnly: true })` 打开源库；打开失败即记
 *   `READ_ONLY_OPEN_FAILED`，**不退回可写打开**（生产 `src/opencode-usage.js` 的
 *   `openOpencodeDatabase()` 会退回可写，本探测有意不复用它）。
 * - 只对 `session_message.type='assistant'` 行做窄投影：`json_extract` 取
 *   `data.time.created/completed`、`data.tokens.output/reasoning`、`data.model.id/providerID`、
 *   `data.agent`、终态 `data.finish`；其余 JSON 路径只用 `json_type` 判存在性。
 *   **绝不 `SELECT data` 整串**——那是正文。坏 JSON 行由 `json_valid(data)=0` 单独计数。
 * - 身份 = `(home_id, database_identity, session_message.id)`；`seq` 只用于排序，
 *   **不作身份**（同一 `seq` 只在单个 session 内唯一）。
 * - 版本按 `session_v2.version` 的**语义版本字符串**解析主版本，分 supported/legacy/unknown
 *   三档；legacy 排除并告警，unknown 沿用生产"放行+告警"策略。
 * - 输出 token 口径 = `tokens.output + tokens.reasoning`（`token_scope=visible_plus_reasoning`）；
 *   仅当两者都是已知数值时才构成已知合计，**缺字段不冒充已知 0**。
 * - `data.time.streamed` 只作为"错误分母反例"计数（`streamedRows`），不进入任何 TPS 公式。
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { opencodeDatabaseFiles } from "../../src/opencode-usage.js";
import { discoverOpencodeHomes } from "../../src/usage-core.js";

/** 生产 `src/opencode-usage.js` 认定的 v2 语义主版本。 */
const SUPPORTED_SESSION_MAJOR = 2;
/** §17.4 `LONG_WINDOW` 阈值。 */
const LONG_WINDOW_MS = 300_000;
/** epoch 毫秒的合理区间；用于"秒 vs 毫秒"单位核对。 */
const EPOCH_MS_MIN = 1_000_000_000_000;
const EPOCH_MS_MAX = 1_000_000_000_000_000;
/** 源指纹覆盖主库、WAL 与 SHM：OpenCode 新写入先落 WAL。 */
const DATABASE_SUFFIXES = Object.freeze(["", "-wal", "-shm"]);
/** 生产 `checkMessageTable()` 要求的 `session_message` 必需列（含不可上报的 type/seq）。 */
const REQUIRED_SESSION_MESSAGE_COLUMNS = Object.freeze(["id", "session_id", "type", "seq", "time_created", "data"]);
/**
 * 可在冻结外壳 `KNOWN_COLUMN_NAMES` 内上报的必需项。
 * `type` / `seq` / `time_updated` 也在生产必需列表里，但不在册——见 handoff 受阻项。
 */
const REPORTED_REQUIRED_COLUMNS = Object.freeze([
  "session_message",
  "session_id",
  "message_id",
  "time_created",
  "data",
  "json_valid",
]);
/** `fields.columns` 的上报顺序（键名全部在册）。 */
const REPORTED_COLUMN_KEYS = Object.freeze([
  "session_message",
  "session_v2",
  "version",
  "data",
  "json_valid",
  "message_id",
  "id",
  "session_id",
  "time_created",
  "time_completed",
  "tokens_output",
  "tokens_reasoning",
  "model_id_provider",
  "agent_name",
]);

function hasValue(value) {
  return value !== null && value !== undefined;
}

function toFiniteNumber(value) {
  if (!hasValue(value) || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** 与生产 `knownToken()` 一致：非空、有限、非负才算已知 token 数。 */
function toKnownToken(value) {
  const numeric = toFiniteNumber(value);
  return numeric !== null && numeric >= 0 ? numeric : null;
}

/** 语义版本字符串的主版本；`2.0.19` → 2，空/不可解析 → null。 */
export function sessionVersionMajor(version) {
  const text = String(version ?? "").trim();
  if (!text) return null;
  const major = Number(text.split(".")[0]);
  return Number.isInteger(major) && major >= 0 ? major : null;
}

/** v2 guard 三档。 */
export function classifyVersionMajor(major) {
  if (major === null) return "unknown";
  return major >= SUPPORTED_SESSION_MAJOR ? "supported" : "legacy";
}

/** 有界取样：按规范排序后取首尾文件。 */
export function selectBoundedFiles(files, maxFiles) {
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0 || files.length <= maxFiles) return files.slice();
  const head = Math.ceil(maxFiles / 2);
  const tail = maxFiles - head;
  const selected = files.slice(0, head);
  if (tail > 0) selected.push(...files.slice(files.length - tail));
  return selected;
}

/** 聚合源指纹：只暴露 hex 摘要与计数，路径与原始 ID 不落盘。 */
export function computeSourceFingerprint(files, homeCount, checkedAt = new Date().toISOString()) {
  const hash = createHash("sha256");
  let bytes = 0;
  let walPresent = false;
  for (const entry of files) {
    for (const suffix of DATABASE_SUFFIXES) {
      let info = null;
      try {
        info = statSync(`${entry.filePath}${suffix}`);
      } catch {
        info = null;
      }
      if (!info) {
        hash.update(`${suffix}|absent\n`);
        continue;
      }
      hash.update(`${suffix}|${info.size}|${Math.round(info.mtimeMs)}\n`);
      bytes += info.size;
      if (suffix === "-wal") walPresent = true;
    }
  }
  const digest = hash.digest("hex");
  return {
    bytes,
    walPresent,
    fingerprint: {
      fingerprint: digest,
      contentFingerprint: digest,
      fileCount: files.length,
      homeCount,
      checkedAt,
    },
  };
}

/** 两个指纹是否指向同一源状态（前后指纹的核心比较）。 */
export function fingerprintDigest(entry) {
  return entry?.contentFingerprint ?? entry?.fingerprint ?? null;
}

async function discoverOpencodeDatabases() {
  const homes = await discoverOpencodeHomes();
  const files = [];
  for (const home of homes) {
    for (const filePath of await opencodeDatabaseFiles(home.path)) {
      files.push({ filePath, homeId: String(home.id ?? "") });
    }
  }
  files.sort((left, right) => left.filePath.localeCompare(right.filePath));
  return { homes, files };
}

function tableNames(database) {
  const names = new Set();
  try {
    for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
      names.add(String(row.name));
    }
  } catch {
    // schema 读取失败交由调用方按 UNSUPPORTED_SCHEMA 处理。
  }
  return names;
}

function columnNames(database, table) {
  const names = new Set();
  for (const column of database.prepare(`PRAGMA table_info("${table}")`).all()) {
    names.add(String(column.name));
  }
  return names;
}

function jsonValidUsable(database) {
  try {
    const row = database.prepare("SELECT json_valid('{}') AS ok").get();
    return Number(row?.ok) === 1;
  } catch {
    return false;
  }
}

/**
 * 单文件的窄投影 SQL。
 * `json_extract` 一律包在 `CASE WHEN json_valid(m.data)=1` 里，坏 JSON 行只取判别位，
 * 不把 `data` 整串拉进结果集。
 */
function assistantRowSql({ hasSessionTable, limit }) {
  const versionSelect = hasSessionTable ? "s.version AS session_version" : "NULL AS session_version";
  const join = hasSessionTable ? "LEFT JOIN session_v2 AS s ON s.id = m.session_id" : "";
  const guard = "json_valid(m.data) = 1";
  return [
    "SELECT m.id AS message_id,",
    "m.session_id AS session_id,",
    "json_valid(m.data) AS data_valid,",
    `CASE WHEN ${guard} THEN json_extract(m.data, '$.time.created') END AS created_ms,`,
    `CASE WHEN ${guard} THEN json_extract(m.data, '$.time.completed') END AS completed_ms,`,
    `CASE WHEN ${guard} THEN json_type(m.data, '$.time.streamed') END AS streamed_type,`,
    `CASE WHEN ${guard} THEN json_extract(m.data, '$.tokens.output') END AS output_tokens,`,
    `CASE WHEN ${guard} THEN json_extract(m.data, '$.tokens.reasoning') END AS reasoning_tokens,`,
    `CASE WHEN ${guard} THEN json_type(m.data, '$.tokens') END AS tokens_type,`,
    `CASE WHEN ${guard} THEN json_extract(m.data, '$.model.id') END AS model_id,`,
    `CASE WHEN ${guard} THEN json_extract(m.data, '$.model.providerID') END AS provider_id,`,
    `CASE WHEN ${guard} THEN json_extract(m.data, '$.agent') END AS agent_name,`,
    `CASE WHEN ${guard} THEN json_extract(m.data, '$.finish') END AS finish,`,
    `CASE WHEN ${guard} THEN json_type(m.data, '$.error') END AS error_type,`,
    versionSelect,
    "FROM session_message AS m",
    join,
    "WHERE m.type = 'assistant'",
    "ORDER BY m.time_created, m.seq, m.id",
    limit === null ? "" : "LIMIT ?",
  ]
    .filter(Boolean)
    .join(" ");
}

function presenceRecord(map, key) {
  const record = map.get(key) ?? { checked: 0, present: false };
  map.set(key, record);
  return record;
}

function noteSchemaPresence(map, key, present) {
  const record = presenceRecord(map, key);
  record.checked += 1;
  if (present) record.present = true;
}

function noteValuePresence(map, key, present) {
  const record = presenceRecord(map, key);
  record.checked += 1;
  if (present) record.present = true;
}

function presenceState(record) {
  if (!record || record.checked === 0) return "unknown";
  return record.present ? "present" : "absent";
}

function createAccumulator({ discovered, homeCount }) {
  const counts = {
    filesDiscovered: discovered.length,
    filesScanned: 0,
    errors: 0,
  };
  const bump = (key, amount = 1) => {
    counts[key] = (counts[key] ?? 0) + amount;
  };
  const warningCounts = new Map();
  const warn = (code, amount = 1) => {
    warningCounts.set(code, (warningCounts.get(code) ?? 0) + amount);
  };
  const flagCounts = new Map();
  const addFlag = (name) => {
    flagCounts.set(name, (flagCounts.get(name) ?? 0) + 1);
  };

  const schemaPresence = new Map();
  const valuePresence = new Map();
  const identities = new Map();
  const duplicateGroups = new Set();
  const versionWarnedSessions = new Set();
  const sessions = new Set();
  const models = new Set();
  const providers = new Set();
  const agents = new Set();
  let inspectedFiles = 0;
  let readOnlyFailures = 0;
  let schemaFailures = 0;
  let eligible = 0;
  let positiveOutput = 0;
  let timedPositiveOutput = 0;
  let completeTimedPositiveOutput = 0;
  let sampled = 0;
  let pending = 0;
  let unplaced = 0;

  function inspectSchema(database) {
    const tables = tableNames(database);
    const hasSessionMessage = tables.has("session_message");
    const hasSessionV2 = tables.has("session_v2");
    const messageColumns = hasSessionMessage ? columnNames(database, "session_message") : null;
    const versionColumns = hasSessionV2 ? columnNames(database, "session_v2") : null;
    const jsonValid = hasSessionMessage ? jsonValidUsable(database) : false;
    const missing = messageColumns
      ? REQUIRED_SESSION_MESSAGE_COLUMNS.filter((column) => !messageColumns.has(column))
      : REQUIRED_SESSION_MESSAGE_COLUMNS.slice();
    for (const key of REPORTED_COLUMN_KEYS) {
      if (key === "session_message") {
        noteSchemaPresence(schemaPresence, key, hasSessionMessage);
      } else if (key === "session_v2") {
        noteSchemaPresence(schemaPresence, key, hasSessionV2);
      } else if (key === "version") {
        noteSchemaPresence(schemaPresence, key, Boolean(versionColumns?.has("version")));
      } else if (key === "data" || key === "time_created" || key === "id" || key === "session_id") {
        noteSchemaPresence(schemaPresence, key, Boolean(messageColumns?.has(key)));
      } else if (key === "message_id") {
        noteSchemaPresence(schemaPresence, key, Boolean(messageColumns?.has("id")));
      } else if (key === "json_valid") {
        noteSchemaPresence(schemaPresence, key, jsonValid);
      }
      // 其余四键是 JSON 路径，存在性由扫描行的取值决定（noteValuePresence）。
    }
    return { hasSessionV2, missing };
  }

  function examineRow(row, entry) {
    bump("rowsScanned");
    bump("rowsRead");
    bump("assistantRowCount");
    if (Number(row.data_valid) !== 1) {
      bump("badJsonRows");
      bump("badJsonCount");
      bump("malformedJsonCount");
      bump("rowsSkipped");
      warn("MALFORMED_JSON");
      return;
    }

    const versionMajor = sessionVersionMajor(row.session_version);
    const tier = classifyVersionMajor(versionMajor);
    if (tier === "supported") bump("supportedVersions");
    else {
      if (tier === "legacy") {
        bump("legacyVersions");
        bump("unsupportedVersionCount");
      } else bump("unknownVersions");
      // 协议内没有专用的版本告警码，legacy 排除与版本未知都按会话记一次
      // UNSUPPORTED_SCHEMA（三档计数在 scanned 内保持可见）；详见 handoff 受阻项。
      const versionSession = String(row.session_id ?? row.message_id ?? "").trim();
      if (!versionWarnedSessions.has(versionSession)) {
        versionWarnedSessions.add(versionSession);
        warn("UNSUPPORTED_SCHEMA");
      }
    }

    const createdPresent = hasValue(row.created_ms);
    const completedPresent = hasValue(row.completed_ms);
    const streamedPresent = hasValue(row.streamed_type) && String(row.streamed_type) !== "null";
    const tokensType = hasValue(row.tokens_type) ? String(row.tokens_type) : null;
    const tokensPresent = tokensType === "object";
    const outputPresent = hasValue(row.output_tokens);
    const reasoningPresent = hasValue(row.reasoning_tokens);
    const modelPresent = hasValue(row.model_id) && String(row.model_id).trim() !== "";
    const providerPresent = hasValue(row.provider_id) && String(row.provider_id).trim() !== "";
    const agentPresent = hasValue(row.agent_name);
    const finishPresent = hasValue(row.finish);
    const errorPresent = hasValue(row.error_type) && String(row.error_type) === "object";

    noteValuePresence(valuePresence, "time_created", createdPresent);
    noteValuePresence(valuePresence, "time_completed", completedPresent);
    noteValuePresence(valuePresence, "tokens_output", outputPresent);
    noteValuePresence(valuePresence, "tokens_reasoning", reasoningPresent);
    noteValuePresence(valuePresence, "model_id_provider", modelPresent && providerPresent);
    noteValuePresence(valuePresence, "agent_name", agentPresent);
    noteValuePresence(valuePresence, "terminal", finishPresent);
    if (streamedPresent) bump("streamedRows");

    const outputRaw = toFiniteNumber(row.output_tokens);
    const reasoningRaw = toFiniteNumber(row.reasoning_tokens);
    const outputKnown = toKnownToken(row.output_tokens);
    const reasoningKnown = toKnownToken(row.reasoning_tokens);
    // 缺字段不能冒充已知 0：只有两者都是已知数值时才构成已知合计。
    const combinedKnown = outputKnown !== null && reasoningKnown !== null;
    const combined = combinedKnown ? outputKnown + reasoningKnown : null;

    if (!outputPresent) bump("outputMissingCount");
    if (!reasoningPresent) bump("reasoningMissingCount");
    if (!tokensPresent) {
      bump("missingTokens");
      bump("missingUsage");
    }
    if (!completedPresent || !createdPresent) bump("missingCompleted");
    if (outputPresent && outputRaw === 0) bump("outputZeroCount");
    if (reasoningPresent && reasoningRaw === 0) bump("reasoningZeroCount");
    if (outputPresent && outputRaw !== null && outputRaw > 0) bump("positiveOutputRows");

    const createdMs = toFiniteNumber(row.created_ms);
    const completedMs = toFiniteNumber(row.completed_ms);
    const durationMs =
      createdPresent && completedPresent && createdMs !== null && completedMs !== null ? completedMs - createdMs : null;
    if (durationMs !== null) {
      bump("timeUnitCheckedCount");
      if (durationMs >= 0 && createdMs >= EPOCH_MS_MIN && createdMs < EPOCH_MS_MAX) bump("timeUnitMatchedCount");
      if (durationMs > 0) bump("positiveDurationRows");
      if (durationMs < 0) bump("negativeDurations");
    }

    const finish = finishPresent ? String(row.finish) : null;
    const failed = errorPresent || finish === "error";
    const cancelled = finish === "cancelled";
    const completed = finish === "stop" || finish === "tool-calls";
    const otherTerminal = finishPresent && !failed && !cancelled && !completed;
    if (failed) {
      bump("errorRows");
      bump("statusErrorCount");
    } else if (cancelled) {
      bump("cancelledRows");
      bump("cancelledCount");
      bump("statusCancelledCount");
    } else if (completed) {
      bump("completedRows");
      bump("statusCompletedCount");
    }
    if (otherTerminal) bump("statusOtherCount");
    if (!failed && !cancelled && !completed) bump("terminalUnverifiedCount");

    const sessionId = String(row.session_id ?? "").trim() || String(row.message_id ?? "").trim();
    if (sessionId) sessions.add(sessionId);
    if (modelPresent) models.add(String(row.model_id).trim());
    if (providerPresent) providers.add(String(row.provider_id).trim());
    if (agentPresent && String(row.agent_name).trim()) agents.add(String(row.agent_name).trim());

    const messageId = String(row.message_id ?? "").trim();
    if (!messageId || !sessionId) {
      bump("unkeyableRecordCount");
      warn("UNKEYABLE_RECORD");
      return;
    }
    const identity = [entry.homeId, entry.databaseIdentity, messageId].join("\u0000");
    const signature = JSON.stringify([
      row.created_ms ?? null,
      row.completed_ms ?? null,
      row.output_tokens ?? null,
      row.reasoning_tokens ?? null,
      row.model_id ?? null,
      row.provider_id ?? null,
      row.agent_name ?? null,
      finish,
    ]);
    const previous = identities.get(identity);
    const duplicate = previous !== undefined;
    if (duplicate) {
      if (previous === signature) {
        bump("consistentDuplicateCount");
        addFlag("RECORD_CONFLICT");
        return;
      }
      bump("identityDuplicateCount");
      duplicateGroups.add(identity);
      addFlag("RECORD_CONFLICT");
      return;
    }
    identities.set(identity, signature);

    const tsMs = completedPresent && completedMs !== null ? completedMs : createdMs;
    if (tsMs === null) {
      bump("missingTimestampCount");
      bump("unplaced");
      unplaced += 1;
      addFlag("TIME_UNPLACED");
    }
    if (!completedPresent || !createdPresent) addFlag("MISSING_DURATION");
    if (durationMs !== null && durationMs <= 0) addFlag("DURATION_NONPOSITIVE");
    if (durationMs !== null && durationMs > LONG_WINDOW_MS) addFlag("LONG_WINDOW");
    if ((createdPresent && createdMs === null) || (completedPresent && completedMs === null) || (durationMs ?? 0) < 0) {
      addFlag("TIME_INVALID");
    }
    if (!outputPresent || !reasoningPresent) addFlag("MISSING_OUTPUT");
    if (
      (outputPresent && (outputRaw === null || outputRaw < 0)) ||
      (reasoningPresent && (reasoningRaw === null || reasoningRaw < 0))
    ) {
      addFlag("TOKEN_INVALID");
    }
    if (combinedKnown && combined === 0) addFlag("OUTPUT_ZERO");
    if (failed || cancelled) addFlag("SOURCE_FILTERED");
    if (!failed && !cancelled && !completed) addFlag("TERMINAL_UNVERIFIED");

    const isCandidate = tier !== "legacy";
    if (!isCandidate) {
      addFlag("SOURCE_FILTERED");
      return;
    }
    bump("sqliteCandidateCount");
    eligible += 1;
    if (!failed && !cancelled && !completed) {
      pending += 1;
      return;
    }
    if (combinedKnown && combined > 0) {
      positiveOutput += 1;
      if (durationMs !== null && durationMs > 0) {
        timedPositiveOutput += 1;
        if (completed) completeTimedPositiveOutput += 1;
      }
    }
    if (completed && combinedKnown && combined > 0 && durationMs !== null && durationMs > 0 && modelPresent) {
      sampled += 1;
    }
  }

  function scanFile(entry, budget) {
    let database;
    try {
      database = new DatabaseSync(entry.filePath, { readOnly: true });
      // SQLite 的打开是惰性的：非 SQLite 文件要到第一条语句才报错，
      // 因此这里先做一次可读性探测，把"只读打开/读取失败"和"schema 缺列"分开。
      database.prepare("SELECT count(*) AS n FROM sqlite_master").get();
    } catch {
      readOnlyFailures += 1;
      bump("errors");
      warn("READ_ONLY_OPEN_FAILED");
      try {
        database?.close();
      } catch {
        // 完全打不开时无需关闭。
      }
      return 0;
    }
    counts.openedDatabaseCount = (counts.openedDatabaseCount ?? 0) + 1;
    let consumed = 0;
    try {
      const { hasSessionV2, missing } = inspectSchema(database);
      inspectedFiles += 1;
      if (missing.length > 0) {
        schemaFailures += 1;
        bump("errors");
        warn("UNSUPPORTED_SCHEMA");
        return 0;
      }
      const limit = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : null;
      if (limit === 0) return 0;
      const statement = database.prepare(assistantRowSql({ hasSessionTable: hasSessionV2, limit }));
      const iterator = limit === null ? statement.iterate() : statement.iterate(limit);
      for (const row of iterator) {
        consumed += 1;
        examineRow(row, entry);
      }
    } catch {
      schemaFailures += 1;
      bump("errors");
      warn("UNSUPPORTED_SCHEMA");
    } finally {
      try {
        database.close();
      } catch {
        // 关闭失败不影响已收集的聚合证据。
      }
    }
    return consumed;
  }

  return {
    counts,
    bump,
    addFlag,
    warn,
    scanFile,
    inspectedFiles: () => inspectedFiles,
    readOnlyFailures: () => readOnlyFailures,
    schemaFailures: () => schemaFailures,
    distinctIdentities: () => identities.size,
    schemaPresence,
    valuePresence,
    sessions,
    models,
    providers,
    agents,
    duplicateGroups,
    homeCount,
    eligible: () => eligible,
    positiveOutput: () => positiveOutput,
    timedPositiveOutput: () => timedPositiveOutput,
    completeTimedPositiveOutput: () => completeTimedPositiveOutput,
    sampled: () => sampled,
    pending: () => pending,
    unplaced: () => unplaced,
    warningCounts,
    flagCounts,
  };
}

function countsBy(entries) {
  return Object.fromEntries([...entries.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export async function probe({ maxFiles, maxRows, full }) {
  const bounded = !full;
  const { homes, files } = await discoverOpencodeDatabases();
  const homeCount = homes.length;
  const selected = bounded ? selectBoundedFiles(files, maxFiles) : files.slice();
  const before = computeSourceFingerprint(files, homeCount);
  const accumulator = createAccumulator({ discovered: files, homeCount });

  let budget = bounded ? Math.max(0, Number(maxRows) || 0) : Number.POSITIVE_INFINITY;
  for (const entry of selected) {
    if (budget <= 0) break;
    const databaseIdentity =
      process.platform === "win32" ? path.resolve(entry.filePath).toLowerCase() : path.resolve(entry.filePath);
    const consumed = accumulator.scanFile({ ...entry, databaseIdentity }, budget);
    accumulator.bump("filesScanned");
    if (Number.isFinite(budget)) budget -= consumed;
  }

  const after = computeSourceFingerprint(files, homeCount);
  const liveSourceChanged =
    fingerprintDigest(before.fingerprint) !== fingerprintDigest(after.fingerprint) ||
    before.fingerprint.fileCount !== after.fingerprint.fileCount;
  if (liveSourceChanged) {
    accumulator.warn("LIVE_SOURCE_CHANGED");
  }

  const { counts, schemaPresence, valuePresence } = accumulator;
  const rowsScanned = counts.rowsScanned ?? 0;
  const eligible = accumulator.eligible();
  const sampled = accumulator.sampled();
  const pending = accumulator.pending();
  const dropped = Math.max(0, eligible - sampled - pending);
  const columns = {};
  for (const key of REPORTED_COLUMN_KEYS) {
    if (key === "time_completed" || key === "tokens_output" || key === "tokens_reasoning") {
      columns[key] = presenceState(valuePresence.get(key));
    } else if (key === "model_id_provider") {
      columns[key] = presenceState(valuePresence.get(key));
    } else if (key === "agent_name") {
      columns[key] = presenceState(valuePresence.get(key));
    } else {
      columns[key] = presenceState(schemaPresence.get(key));
    }
  }
  const columnStates = { present: 0, absent: 0, unknown: 0, total: REPORTED_COLUMN_KEYS.length };
  for (const state of Object.values(columns)) columnStates[state] += 1;
  const requiredColumns = {};
  for (const key of REPORTED_REQUIRED_COLUMNS) requiredColumns[key] = columns[key];
  const allColumnsPresent = Object.values(columns).every((state) => state === "present");
  const versionGuard = accumulativeVersionGuard(counts);
  const distinctModels = accumulator.models.size;
  const distinctProviders = accumulator.providers.size;
  const distinctAgents = accumulator.agents.size;

  const scanned = {
    files: files.length,
    filesDiscovered: files.length,
    filesScanned: counts.filesScanned ?? 0,
    rows: rowsScanned,
    rowsScanned,
    rowsRead: counts.rowsRead ?? 0,
    rowsSkipped: counts.rowsSkipped ?? 0,
    homes: homeCount,
    sessions: accumulator.sessions.size,
    sessionsScanned: accumulator.sessions.size,
    assistantRowCount: counts.assistantRowCount ?? 0,
    assistantMessageCount: counts.assistantRowCount ?? 0,
    badJsonRows: counts.badJsonRows ?? 0,
    badJsonCount: counts.badJsonCount ?? 0,
    malformedJsonCount: counts.malformedJsonCount ?? 0,
    streamedRows: counts.streamedRows ?? 0,
    supportedVersions: counts.supportedVersions ?? 0,
    legacyVersions: counts.legacyVersions ?? 0,
    unknownVersions: counts.unknownVersions ?? 0,
    unsupportedVersionCount: counts.unsupportedVersionCount ?? 0,
    missingCompleted: counts.missingCompleted ?? 0,
    missingTokens: counts.missingTokens ?? 0,
    missingUsage: counts.missingUsage ?? 0,
    outputMissingCount: counts.outputMissingCount ?? 0,
    outputZeroCount: counts.outputZeroCount ?? 0,
    reasoningMissingCount: counts.reasoningMissingCount ?? 0,
    reasoningZeroCount: counts.reasoningZeroCount ?? 0,
    completedRows: counts.completedRows ?? 0,
    errorRows: counts.errorRows ?? 0,
    cancelledRows: counts.cancelledRows ?? 0,
    cancelledCount: counts.cancelledCount ?? 0,
    terminalUnverifiedCount: counts.terminalUnverifiedCount ?? 0,
    statusCompletedCount: counts.statusCompletedCount ?? 0,
    statusErrorCount: counts.statusErrorCount ?? 0,
    statusCancelledCount: counts.statusCancelledCount ?? 0,
    statusOtherCount: counts.statusOtherCount ?? 0,
    positiveDurationRows: counts.positiveDurationRows ?? 0,
    positiveOutputRows: counts.positiveOutputRows ?? 0,
    eligible,
    positiveOutput: accumulator.positiveOutput(),
    timedPositiveOutput: accumulator.timedPositiveOutput(),
    completeTimedPositiveOutput: accumulator.completeTimedPositiveOutput(),
    sampled,
    dropped,
    pending,
    unplaced: accumulator.unplaced(),
    uniqueIdentities: accumulator.distinctIdentities(),
    duplicateIdentities: counts.identityDuplicateCount ?? 0,
    identityDuplicateCount: counts.identityDuplicateCount ?? 0,
    identityDuplicateGroupCount: accumulator.duplicateGroups.size,
    consistentDuplicateCount: counts.consistentDuplicateCount ?? 0,
    missingTimestampCount: counts.missingTimestampCount ?? 0,
    negativeDurations: counts.negativeDurations ?? 0,
    timeUnitMatchedCount: counts.timeUnitMatchedCount ?? 0,
    timeUnitCheckedCount: counts.timeUnitCheckedCount ?? 0,
    sqliteCandidateCount: counts.sqliteCandidateCount ?? 0,
    errors: counts.errors ?? 0,
    bytes: before.bytes,
    flagCount: [...accumulator.flagCounts.values()].reduce((total, value) => total + value, 0),
    readOnly: true,
    walPresent: before.walPresent || after.walPresent,
    projectionReady: true,
    bounded,
    capped: bounded,
    hasMore: bounded,
    truncated: bounded,
    complete: full && !liveSourceChanged && accumulator.readOnlyFailures() === 0 && accumulator.schemaFailures() === 0,
  };

  const fields = {
    schemaKind: "opencode-sqlite",
    backend: "sqlite",
    windowKind: "message",
    timingKind: "request_e2e",
    tokenScope: "visible_plus_reasoning",
    timingSource: "explicit",
    durationBasis: "completed_minus_created",
    unitKind: "ms",
    unit: "epoch_milliseconds",
    timeUnit: "milliseconds",
    durationUnit: "milliseconds",
    timestampUnit: "milliseconds",
    sourceVersion: "opencode_v2_message",
    sessionV2Version: versionMajorLabel(counts),
    tableName: "session_message",
    versionGuard,
    unsupportedVersionPolicy: "pass_with_warning",
    readOnlyStrategy: "database_sync_readonly",
    databaseIdentityKind: "path",
    identityScheme: "message_id",
    agentKind: "unknown",
    agentKindMapping: "unknown_default",
    agentNameEvidence: "agent_field",
    agentRoleProven: false,
    providerMapping: "provider_id",
    providerScope: "provider_id",
    modelScope: "model_id",
    effortMapping: "unknown",
    modelEvidenceDecision: "unknown",
    reasoningRelation: "parallel_additive",
    reasoningRelationKnown: true,
    reasoningSeparate: true,
    completedExplicit: presenceState(valuePresence.get("time_completed")) === "present",
    outputExplicit: presenceState(valuePresence.get("tokens_output")) === "present",
    terminalFieldPresent: presenceState(valuePresence.get("terminal")) === "present",
    terminalFieldKind: "unknown",
    terminalFieldPath: presenceState(valuePresence.get("terminal")),
    timeCreatedPath: presenceState(valuePresence.get("time_created")),
    timeCompletedPath: presenceState(valuePresence.get("time_completed")),
    tokensOutputPath: presenceState(valuePresence.get("tokens_output")),
    tokensReasoningPath: presenceState(valuePresence.get("tokens_reasoning")),
    modelIdPath: presenceState(valuePresence.get("model_id_provider")),
    providerIdPath: presenceState(valuePresence.get("model_id_provider")),
    agentPath: presenceState(valuePresence.get("agent_name")),
    versionColumn: presenceState(schemaPresence.get("version")),
    columns,
    requiredColumns,
    columnStates,
    columnCount: REPORTED_COLUMN_KEYS.length,
    presentColumnCount: columnStates.present,
    absentColumnCount: columnStates.absent,
    unknownColumnCount: columnStates.unknown,
    allColumnsPresent,
    distinctModels,
    distinctProviders,
    distinctAgents,
    distinctSessions: accumulator.sessions.size,
    distinctHomes: homeCount,
    sampleCount: rowsScanned,
    windowCount: rowsScanned,
    flagCount: scanned.flagCount,
    readOnly: true,
    walPresent: scanned.walPresent,
    projectionReady: true,
    sampled: bounded,
    limited: bounded,
    contentAccessed: false,
    streamAccessed: false,
    itemContentAccessed: false,
    ttftAccessed: false,
    ttftRead: false,
    timestampFallbackUsed: false,
    explicitDurationUsed: presenceState(valuePresence.get("time_completed")) === "present",
    streamedDenominatorUsed: false,
    writableFallbackUsed: false,
    sourceChangedDuringScan: liveSourceChanged,
    databaseIdentityStable: true,
    identityUnique: (counts.identityDuplicateCount ?? 0) === 0,
    unitAmbiguous:
      (counts.timeUnitCheckedCount ?? 0) > 0 && (counts.timeUnitMatchedCount ?? 0) < (counts.timeUnitCheckedCount ?? 0),
  };

  const decisions = {
    schemaKind: "opencode-sqlite",
    backend: "sqlite",
    versionGuard,
    tokenScope: "visible_plus_reasoning",
    timingKind: "request_e2e",
    coverageState: full && !liveSourceChanged ? "ready" : "degraded",
    filesDiscovered: files.length,
    filesScanned: counts.filesScanned ?? 0,
    openedDatabaseCount: counts.openedDatabaseCount ?? 0,
    checkedRowCount: rowsScanned,
    homeCount,
    readOnly: true,
    readOnlyEnforced: accumulator.readOnlyFailures() === 0,
    walPresent: scanned.walPresent,
    projectionReady: true,
    identityUnique: (counts.identityDuplicateCount ?? 0) === 0,
    identitySchemeStable: true,
    liveSourceChanged,
    warningCounts: countsBy(accumulator.warningCounts),
    flagCounts: countsBy(accumulator.flagCounts),
  };

  const warnings = [...accumulator.warningCounts.entries()]
    .filter(([, count]) => count > 0)
    .map(([code, count]) => ({ code, count }));
  if (files.length === 0) {
    // `NO_SOURCE_FILES` 是外壳的 no-file 退避码（`NO_FILE_CODES`），**不属于** §3 的
    // `SOURCE_WARNING_CODES`，因此只进 `warnings[]`，不进 `decisions.warningCounts`。
    warnings.push({ code: "NO_SOURCE_FILES", count: 1 });
  }

  return {
    scanned,
    fields,
    decisions,
    warnings,
    sourceFingerprintBefore: before.fingerprint,
    sourceFingerprintAfter: after.fingerprint,
    liveSourceChanged,
  };
}

function versionMajorLabel(counts) {
  if ((counts.supportedVersions ?? 0) > 0) return "major_2";
  if ((counts.legacyVersions ?? 0) > 0) return "major_1";
  return "unknown";
}

function accumulativeVersionGuard(counts) {
  if ((counts.supportedVersions ?? 0) > 0) return "supported";
  if ((counts.legacyVersions ?? 0) > 0) return "legacy";
  return "unknown";
}
