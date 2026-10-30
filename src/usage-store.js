import { mkdir, stat } from "node:fs/promises";
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { plainRolloutPath } from "./codex-rollout.js";
import { outputObservationFile } from "./perf-output-observations.js";
import { normalizeMeasuredOutput } from "./perf-output-tokens.js";

import {
  COMPARISON_PERIOD_KEYS,
  buildPerfStatsBlock,
  buildUsageFingerprint,
  discoverSessionFiles,
  discoverUsageSources,
  isQuotaPreset,
  planStableCodexHome,
  proveCodexLiveAppend,
  perfStatsRangeBounds,
  previousUsageRange,
  resolveDateRange,
  selectQuotaWindows,
  streamUsageFileEvents,
  summarizeUsage,
  usageComparisonFromAggregates,
} from "./usage-core.js";
import { createRepositoryResolver } from "./repository-identity.js";
import {
  createUsageRollups,
  listDirtyUsageRollupDays,
  localUsageRollupDaysForUtcDays,
  queryUsageRollupModelsWindow,
  queryUsageRollupsRange,
  rebuildUsageRollups,
  rebuildUsageRollupsFromEvents,
} from "./usage-rollups.js";
import {
  createCostEstimateAccumulator,
  createEventPricing,
  createEventCostMemo,
  estimateCostForEvents,
  estimateEventCost,
  getPricingCatalog,
} from "./pricing.js";
import { loadServiceTierEvidence, serviceTierEvidenceSnapshot } from "./service-tier-evidence.js";
import {
  loadQuotaSourceEvidence,
  quotaSourceEvidenceSnapshot,
  quotaSourceEvidenceFromSnapshot,
} from "./quota-source-evidence.js";
import { quotaSourceResolver } from "./quota-usage-source.js";
import { readCodexQuotaObservations } from "./codex-quota-cache.js";
import { isQuotaUsage } from "../public/quota-usage.js";
import { HistoryQuoteInputs } from "./history-quote-inputs.js";
import { buildModelActivity, canonicalModelName } from "../public/pricing-models.js";
import { addPeriodEvent, emptyPeriodMetrics, summarizePeriodComparison } from "../public/period-comparison.js";
import { zcodeSourceStat } from "./zcode-usage.js";
import { dshSessionFiles } from "./dsh-usage.js";
import { opencodeDatabaseFiles, opencodeSourceStat } from "./opencode-usage.js";
import { claudeSessionFiles } from "./claude-code-usage.js";
import {
  workbuddySessionFiles,
  workbuddySessionMessageFiles,
  workbuddyTraceFiles,
  workbuddyTraceSpans,
  workbuddyLogSnapshot,
  workbuddyTextTimingSpans,
  createWorkbuddyTextTimingLookup,
} from "./workbuddy-usage.js";
import { isPerfSourceEnabled, streamPerfSamplesForFile, classifyPerfSources } from "./perf-sources/index.js";
import {
  buildCodexThreadPerfSamples,
  codexSampleAllowed,
  codexSampleThreadId,
  createCodexProjectionCache,
  createCodexPublishFilter,
  decodeCodexPublicationPolicy,
  encodeCodexPublicationPolicy,
  rankedCodexHomeIds,
  CODEX_PUBLICATION_POLICY_REVISION,
} from "./perf-sources/codex-thread.js";
import { foldCodexRolloutMetadata } from "./perf-sources/codex-fold.js";
import { normalizeRequestTimingEvidence } from "./perf-request-timing.js";
import {
  importRequestTimingEvidence as importStoredRequestTimingEvidence,
  lookupRequestTiming as lookupStoredRequestTiming,
  validateStoredEvidence,
  readRequestTimingRevision,
} from "./perf-request-timing-store.js";
import {
  PERF_METHOD_VERSION,
  PERF_SUPPORTED_METHOD_VERSIONS,
  PERF_SOURCE_WARNING_CODES,
  canonicalPerfSourceKind,
  isGenerationPerfMethod,
} from "./perf-stats.js";
import { createHash } from "node:crypto";
import {
  buildTimelineRows,
  sourceGroup,
  homeSourceKinds,
  deriveTimelineBucket,
  quotaRecordsForRange,
  quotaRecordValues,
  previousQuotaRange,
} from "../public/timeline-utils.js";

export const STORE_SCHEMA_VERSION = 23;

const QUOTA_SOURCES_DDL = `CREATE TABLE IF NOT EXISTS quota_usage_sources (
  source_path TEXT NOT NULL, home_id TEXT NOT NULL, session_id TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL, quota_source TEXT NOT NULL, until_ms INTEGER NOT NULL,
  PRIMARY KEY (source_path, session_id, timestamp_ms)
) STRICT;`;

const REQUEST_TIMING_PUBLISHED_REVISION_META = "perf_request_timing_published_revision";
const REQUEST_TIMING_PUBLICATION_SEQ_META = "perf_request_timing_publication_seq";
const USAGE_PROJECTION_IGNORED_TABLES = [
  "perf_samples",
  "perf_sample_sources",
  "perf_rollout_threads",
  "perf_codex_projections",
  "perf_request_timing_meta",
  "perf_request_timing_evidence",
  "perf_request_timing_threads",
  "perf_request_timing_dirty_threads",
  "workbuddy_generation_durations",
  "workbuddy_generation_duration_observations",
  "history_replaced_facts",
];
const USAGE_PROJECTION_IGNORED_META = [
  "generated_at",
  "fingerprint",
  "perf_state",
  "perf_degraded_home_ids",
  "perf_source_warnings",
  "perf_missing_sources",
  "perf_file_fingerprints",
  "perf_file_warnings",
  "perf_method_version",
  "perf_index_version",
  "perf_indexed_at",
  "perf_workbuddy_legacy_fallback_allowed",
  "perf_codex_publication_policy",
  "perf_unsupported_sources",
  REQUEST_TIMING_PUBLISHED_REVISION_META,
  REQUEST_TIMING_PUBLICATION_SEQ_META,
];
const MISSING_SOURCES_META = "perf_missing_sources";
const LOCAL_ROLLUP_ZONE_META = "usage_rollup_local_zone_identity";
const HISTORY_ARCHIVE_EVENT_AUTHORITY_META = "history_archive_event_authority";
const HISTORY_ARCHIVE_PERF_AUTHORITY_META = "history_archive_perf_authority";
const HISTORY_ARCHIVE_EVENT_REVISIONS_META = "history_archive_event_revisions";
const HISTORY_ARCHIVE_PERF_REVISIONS_META = "history_archive_perf_revisions";
const HISTORY_ARCHIVE_PERF_COMPONENT_META_KEYS = Object.freeze([
  "history_archive_perf_sources_v1",
  "history_archive_perf_samples_v1",
  "history_archive_perf_index_v1",
  "history_archive_perf_timing_v1",
]);
const HISTORY_ARCHIVE_PERF_REVISION_TABLES = Object.freeze([
  "perf_samples",
  "perf_request_timing_evidence",
  "codex_output_measurements",
]);
const HISTORY_ARCHIVE_TIMING_EVIDENCE_COLUMNS = Object.freeze([
  "home_id",
  "evidence_origin",
  "response_id",
  "variant_key",
  "schema_version",
  "requested_model",
  "reported_output_tokens",
  "duration_ms",
  "status",
  "completed_at_ms",
]);

function historyArchiveTimingEvidenceColumns(database) {
  return database
    .prepare("PRAGMA table_info(perf_request_timing_evidence)")
    .all()
    .some((row) => row.name === "generation_json")
    ? [...HISTORY_ARCHIVE_TIMING_EVIDENCE_COLUMNS, "generation_json"]
    : HISTORY_ARCHIVE_TIMING_EVIDENCE_COLUMNS;
}
const PROJECT_LOG_TRUNCATION_WARNING_CODE = "PROJECT_LOG_TRUNCATED";
const PROJECT_LOG_MALFORMED_LINE_WARNING_CODE = "PROJECT_LOG_MALFORMED_JSONL";

function currentLocalRollupZoneIdentity() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || `offset:${new Date().getTimezoneOffset()}`;
}

function historyArchiveError(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertHistoryArchiveRecordMatches(record, verified) {
  const segmentId = String(record.segment_id);
  if (
    verified.manifest.database.sha256 !== segmentId ||
    verified.manifest.database.sha256 !== String(record.database_sha256) ||
    verified.candidate.startMs !== Number(record.start_ms) ||
    verified.candidate.endMs !== Number(record.end_ms) ||
    verified.candidate.events.rows !== Number(record.event_count)
  ) {
    throw historyArchiveError(
      "HISTORY_ARCHIVE_SEGMENT_MISMATCH",
      `archive segment ${segmentId} does not match its registered metadata`,
    );
  }
  return segmentId;
}

const HARNESS_MODEL_NAMES = ["Codex", "ZCode", "DSH", "OpenCode", "Claude", "WorkBuddy"];

function harnessModelName(channel) {
  const value = String(channel || "").toLowerCase();
  return value.startsWith("zcode")
    ? "ZCode"
    : value.startsWith("dsh")
      ? "DSH"
      : value.startsWith("opencode")
        ? "OpenCode"
        : value.startsWith("claude")
          ? "Claude"
          : value.startsWith("workbuddy")
            ? "WorkBuddy"
            : "Codex";
}

/**
 * v18 request timing tables are created by the adapter's one frozen DDL.
 * The empty import performs CREATE + schema self-check without changing rows.
 * @param {import("node:sqlite").DatabaseSync} database
 */
function initializeRequestTimingSchema(database) {
  importStoredRequestTimingEvidence(database, {
    homeId: "__request_timing_schema__",
    records: [],
    requestLinks: [],
  });
}

/**
 * v17 的表：WorkBuddy 的**响应时长 side table**。
 *
 * 时长只存在于 `<home>/traces/<pid>/trace_*.jsonl` 的 `span_end`（`type = generation`），
 * 会话转录里没有可靠的首末时间戳 ⇒ 会话解析（用量）与 trace 解析（时长）必须分开，
 * 由 `message_id` 在 TPS reader 侧 join。
 *
 * 三条刻意的设计约束（实施计划 §1.5）：
 *   * `INSERT OR IGNORE`：幂等、先到先得，同一 id 多个 span 只留第一条；
 *   * **不建** trace 指纹表、**不设** `home_id` 列：messageId 全局唯一，重复导入同一份数据的
 *     副本时先到先得（已知限制，写进文档）；
 *   * **不主动清理**：10 万条约 10 MB；回收若要做，另开 CLI。
 *
 * 刻意**不加** `STRICT`：本表的写入方只有预扫一处，且 `duration_ms` 已在入口校验为正整数；
 * 与既有 `perf_*` 表的差异按冻结 DDL 保留原样。
 */
const WORKBUDDY_DURATION_DDL = `
  CREATE TABLE IF NOT EXISTS workbuddy_generation_durations (
    message_id TEXT PRIMARY KEY,
    duration_ms INTEGER NOT NULL,
    ended_at_ms INTEGER,
    capture_version TEXT NOT NULL,
    captured_at TEXT NOT NULL
  );
`;

/**
 * v19：按 home 归属、保留异值的 WorkBuddy 时长观测。
 *
 * 旧表继续作为无 home 信息的历史兼容层；新数据只写这里。主键包含时长 ⇒ 同值重复幂等，
 * 异值不会互相覆盖，查询看到多种时长即可判定冲突。
 */
const WORKBUDDY_DURATION_OBSERVATION_DDL = `
  CREATE TABLE IF NOT EXISTS workbuddy_generation_duration_observations (
    home_id TEXT NOT NULL CHECK (home_id <> ''),
    message_id TEXT NOT NULL CHECK (message_id <> ''),
    duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
    ended_at_ms INTEGER,
    capture_version TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    PRIMARY KEY (home_id, message_id, duration_ms)
  ) STRICT;
`;

/** 时长采集方法版本（写进 `capture_version` 列，不参与 perf 的 `methodVersion`）。 */
const WORKBUDDY_CAPTURE_VERSION = "workbuddy.trace.v1";

/** 冻结列序（`name` / `type` / `pk`），逐个核对。 */
const WORKBUDDY_DURATION_COLUMNS = Object.freeze([
  ["message_id", "TEXT", 1],
  ["duration_ms", "INTEGER", 0],
  ["ended_at_ms", "INTEGER", 0],
  ["capture_version", "TEXT", 0],
  ["captured_at", "TEXT", 0],
]);

const WORKBUDDY_DURATION_OBSERVATION_COLUMNS = Object.freeze([
  ["home_id", "TEXT", 1, 1],
  ["message_id", "TEXT", 2, 1],
  ["duration_ms", "INTEGER", 3, 1],
  ["ended_at_ms", "INTEGER", 0, 0],
  ["capture_version", "TEXT", 0, 1],
  ["captured_at", "TEXT", 0, 1],
]);

/**
 * 自检 `workbuddy_generation_durations` 的实际 schema 是否等于冻结 DDL。
 *
 * 与其它表同因：`CREATE TABLE IF NOT EXISTS` 只按**名字**判断存在性 —— 同名 VIEW 会静默通过。
 * 它是 `migrate()` 事务内的最后一步：不符即抛 ⇒ 回滚 ⇒ 版本不动，下次打开重试。
 * @param {import("node:sqlite").DatabaseSync} database
 */
function assertWorkbuddyDurationSchema(database) {
  const actualColumns = database.prepare("PRAGMA table_info(workbuddy_generation_durations)").all();
  if (actualColumns.length !== WORKBUDDY_DURATION_COLUMNS.length) {
    throw new PerfSampleCodecError(
      "WORKBUDDY_DURATION_SCHEMA_MISMATCH",
      `workbuddy_generation_durations 列数 ${actualColumns.length} ≠ 冻结 ${WORKBUDDY_DURATION_COLUMNS.length}`,
    );
  }
  for (const [index, [name, type, pk]] of WORKBUDDY_DURATION_COLUMNS.entries()) {
    const row = actualColumns[index];
    if (String(row.name) !== name || String(row.type || "").toUpperCase() !== type || Number(row.pk) !== pk) {
      throw new PerfSampleCodecError(
        "WORKBUDDY_DURATION_SCHEMA_MISMATCH",
        `workbuddy_generation_durations 列 ${index} 实际 ${String(row.name)}/${String(row.type)}/pk=${Number(row.pk)} ≠ 冻结 ${name}/${type}/pk=${pk}`,
      );
    }
  }
}

function assertWorkbuddyDurationObservationSchema(database) {
  const actualColumns = database.prepare("PRAGMA table_info(workbuddy_generation_duration_observations)").all();
  if (actualColumns.length !== WORKBUDDY_DURATION_OBSERVATION_COLUMNS.length) {
    throw new PerfSampleCodecError(
      "WORKBUDDY_DURATION_SCHEMA_MISMATCH",
      `workbuddy_generation_duration_observations 列数 ${actualColumns.length} ≠ 冻结 ${WORKBUDDY_DURATION_OBSERVATION_COLUMNS.length}`,
    );
  }
  for (const [index, [name, type, pk, notNull]] of WORKBUDDY_DURATION_OBSERVATION_COLUMNS.entries()) {
    const row = actualColumns[index];
    if (
      String(row.name) !== name ||
      String(row.type || "").toUpperCase() !== type ||
      Number(row.pk) !== pk ||
      Number(row.notnull) !== notNull
    ) {
      throw new PerfSampleCodecError(
        "WORKBUDDY_DURATION_SCHEMA_MISMATCH",
        `workbuddy_generation_duration_observations 列 ${index} 实际 ${String(row.name)}/${String(row.type)}/pk=${Number(row.pk)}/notnull=${Number(row.notnull)} ≠ 冻结 ${name}/${type}/pk=${pk}/notnull=${notNull}`,
      );
    }
  }
  const ddl = String(
    database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workbuddy_generation_duration_observations'",
      )
      .get()?.sql ?? "",
  );
  if (!ddl.includes("STRICT")) {
    throw new PerfSampleCodecError(
      "WORKBUDDY_DURATION_SCHEMA_MISMATCH",
      "workbuddy_generation_duration_observations 不是 STRICT 表",
    );
  }
}

/**
 * v20: recoverable old event payloads replaced by a successful reparse.
 * There is deliberately no foreign key to source_files: these facts must
 * outlive the current source identity.
 */
const HISTORY_REPLACED_FACTS_DDL = `
  CREATE TABLE IF NOT EXISTS history_replaced_facts (
    fact_table TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    home_id TEXT NOT NULL,
    source_path TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    occurrence_count INTEGER NOT NULL CHECK (occurrence_count > 0),
    payload TEXT NOT NULL,
    source_home_label TEXT NOT NULL,
    source_home_path TEXT NOT NULL,
    method_version TEXT NOT NULL,
    revision_reason TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (fact_table, source_kind, home_id, source_path, payload_digest)
  ) STRICT;
`;

const HISTORY_REPLACED_FACT_METHOD_VERSION = "events.v1";
const HISTORY_REPLACED_QUOTA_METHOD_VERSION = "rate_limit_observations.v1";
const HISTORY_REPLACED_FACT_INSERT_SQL = `
  INSERT INTO history_replaced_facts (
    fact_table, source_kind, home_id, source_path, payload_digest, occurrence_count, payload,
    source_home_label, source_home_path, method_version, revision_reason, recorded_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(fact_table, source_kind, home_id, source_path, payload_digest) DO UPDATE SET
    occurrence_count = MAX(history_replaced_facts.occurrence_count, excluded.occurrence_count)
`;

const HISTORY_REPLACED_FACT_COLUMNS = Object.freeze([
  ["fact_table", "TEXT", 1, 1],
  ["source_kind", "TEXT", 2, 1],
  ["home_id", "TEXT", 3, 1],
  ["source_path", "TEXT", 4, 1],
  ["payload_digest", "TEXT", 5, 1],
  ["occurrence_count", "INTEGER", 0, 1],
  ["payload", "TEXT", 0, 1],
  ["source_home_label", "TEXT", 0, 1],
  ["source_home_path", "TEXT", 0, 1],
  ["method_version", "TEXT", 0, 1],
  ["revision_reason", "TEXT", 0, 1],
  ["recorded_at", "TEXT", 0, 1],
]);

/** v21 reserves segment metadata only; a row is evidence that a later owner registered it. */
const ARCHIVE_SEGMENTS_DDL = `
  CREATE TABLE IF NOT EXISTS archive_segments (
    segment_id TEXT PRIMARY KEY,
    database_path TEXT NOT NULL,
    database_sha256 TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    event_count INTEGER NOT NULL,
    registered_at_ms INTEGER NOT NULL,
    CHECK (end_ms > start_ms),
    CHECK (event_count >= 0)
  ) STRICT;
`;

const ARCHIVE_SEGMENT_COLUMNS = Object.freeze([
  ["segment_id", "TEXT", 1, 1],
  ["database_path", "TEXT", 0, 1],
  ["database_sha256", "TEXT", 0, 1],
  ["start_ms", "INTEGER", 0, 1],
  ["end_ms", "INTEGER", 0, 1],
  ["event_count", "INTEGER", 0, 1],
  ["registered_at_ms", "INTEGER", 0, 1],
]);

function assertArchiveSegmentsSchema(database) {
  const actualColumns = database.prepare("PRAGMA table_info(archive_segments)").all();
  if (actualColumns.length !== ARCHIVE_SEGMENT_COLUMNS.length) {
    throw new PerfSampleCodecError(
      "ARCHIVE_SEGMENTS_SCHEMA_MISMATCH",
      `archive_segments 列数 ${actualColumns.length} ≠ 冻结 ${ARCHIVE_SEGMENT_COLUMNS.length}`,
    );
  }
  for (const [index, [name, type, pk, notNull]] of ARCHIVE_SEGMENT_COLUMNS.entries()) {
    const row = actualColumns[index];
    if (
      String(row.name) !== name ||
      String(row.type || "").toUpperCase() !== type ||
      Number(row.pk) !== pk ||
      Number(row.notnull) !== notNull
    ) {
      throw new PerfSampleCodecError(
        "ARCHIVE_SEGMENTS_SCHEMA_MISMATCH",
        `archive_segments 列 ${index} 实际 ${String(row.name)}/${String(row.type)}/pk=${Number(row.pk)}/notnull=${Number(row.notnull)} ≠ 冻结 ${name}/${type}/pk=${pk}/notnull=${notNull}`,
      );
    }
  }
  const ddl = String(
    database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'archive_segments'").get()?.sql ??
      "",
  );
  if (
    !ddl.includes("STRICT") ||
    !ddl.includes("CHECK (end_ms > start_ms)") ||
    !ddl.includes("CHECK (event_count >= 0)")
  ) {
    throw new PerfSampleCodecError(
      "ARCHIVE_SEGMENTS_SCHEMA_MISMATCH",
      "archive_segments 不是带冻结 CHECK 的 STRICT 表",
    );
  }
}

function assertHistoryReplacedFactsSchema(database) {
  const actualColumns = database.prepare("PRAGMA table_info(history_replaced_facts)").all();
  if (actualColumns.length !== HISTORY_REPLACED_FACT_COLUMNS.length) {
    throw new PerfSampleCodecError(
      "HISTORY_REPLACED_FACTS_SCHEMA_MISMATCH",
      `history_replaced_facts 列数 ${actualColumns.length} ≠ 冻结 ${HISTORY_REPLACED_FACT_COLUMNS.length}`,
    );
  }
  for (const [index, [name, type, pk, notNull]] of HISTORY_REPLACED_FACT_COLUMNS.entries()) {
    const row = actualColumns[index];
    if (
      String(row.name) !== name ||
      String(row.type || "").toUpperCase() !== type ||
      Number(row.pk) !== pk ||
      Number(row.notnull) !== notNull
    ) {
      throw new PerfSampleCodecError(
        "HISTORY_REPLACED_FACTS_SCHEMA_MISMATCH",
        `history_replaced_facts 列 ${index} 实际 ${String(row.name)}/${String(row.type)}/pk=${Number(row.pk)}/notnull=${Number(row.notnull)} ≠ 冻结 ${name}/${type}/pk=${pk}/notnull=${notNull}`,
      );
    }
  }
  const ddl = String(
    database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'history_replaced_facts'").get()
      ?.sql ?? "",
  );
  if (!ddl.includes("STRICT")) {
    throw new PerfSampleCodecError("HISTORY_REPLACED_FACTS_SCHEMA_MISMATCH", "history_replaced_facts 不是 STRICT 表");
  }
}

function canonicalFactPayload(row, excludedColumns = []) {
  const excluded = new Set(excludedColumns);
  return Object.fromEntries(
    Object.keys(row)
      .filter((key) => !excluded.has(key))
      .sort()
      .map((key) => [key, row[key]]),
  );
}

function historyPayloadDigest(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function historyArchiveStatementRows(statement, parameters = [], plain = false) {
  if (typeof statement.setReturnArrays !== "function" || typeof statement.columns !== "function") {
    const rows = statement.all(...parameters);
    return plain ? rows.map((row) => ({ ...row })) : rows;
  }
  const columns = statement.columns().map((column) => column.name);
  statement.setReturnArrays(true);
  return Array.from(statement.iterate(...parameters), (values) => {
    // Preserve every SQLite field and prototype without retaining dictionary objects.
    const row = Object.fromEntries(columns.map((name, index) => [name, values[index]]));
    return plain ? row : Object.setPrototypeOf(row, null);
  });
}

function historyArchiveEventRows(database, startMs, endMs) {
  return historyArchiveStatementRows(
    database.prepare("SELECT * FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ? ORDER BY id"),
    [startMs, endMs],
    true,
  );
}

function historyArchiveSourceIdentities(database, startMs, endMs) {
  return database
    .prepare(
      `SELECT sf.path, sf.kind, sf.home_id, sf.home_label, sf.home_path
       FROM source_files sf
       WHERE EXISTS (
         SELECT 1 FROM events e
         WHERE e.source_path = sf.path AND e.timestamp_ms >= ? AND e.timestamp_ms < ?
       )
       ORDER BY sf.path, sf.kind, sf.home_id, sf.home_label, sf.home_path`,
    )
    .all(startMs, endMs)
    .map((row) => ({ ...row }));
}

function historyArchiveEventCounts(rows) {
  const counts = new Map();
  for (const row of rows) {
    const payload = JSON.stringify(canonicalFactPayload(row, ["id"]));
    counts.set(payload, (counts.get(payload) || 0) + 1);
  }
  return counts;
}

function historyArchiveEventCountsEqual(left, right) {
  if (left.size !== right.size) return false;
  for (const [payload, count] of left) {
    if (right.get(payload) !== count) return false;
  }
  return true;
}

function historyArchiveRevisionError(message) {
  return historyArchiveError("HISTORY_ARCHIVE_REVISION_INVALID", message);
}

function hasExactObjectKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}

const HISTORY_SOURCE_IDENTITY_COLUMNS = Object.freeze(["path", "kind", "home_id", "home_label", "home_path"]);

function historyArchiveRevisionPayload(payload, sourceIdentity) {
  if (!hasExactObjectKeys(payload, EVENT_INSERT_COLUMNS)) {
    throw historyArchiveRevisionError("archive revision payload must contain exactly the event columns without id");
  }
  if (typeof payload.source_path !== "string" || payload.source_path === "") {
    throw historyArchiveRevisionError("archive revision payload source_path must be a non-empty string");
  }
  if (!Number.isSafeInteger(payload.timestamp_ms)) {
    throw historyArchiveRevisionError("archive revision payload timestamp_ms must be a safe integer");
  }
  for (const column of EVENT_INSERT_COLUMNS) {
    if (EVENT_INTEGER_COLUMNS.includes(column)) {
      if (!Number.isSafeInteger(payload[column])) {
        throw historyArchiveRevisionError(`archive revision payload ${column} must be a safe integer`);
      }
    } else if (typeof payload[column] !== "string") {
      throw historyArchiveRevisionError(`archive revision payload ${column} must be a string`);
    }
  }
  for (const column of ["home_id", "home_label"]) {
    if (payload[column] !== sourceIdentity[column]) {
      throw historyArchiveRevisionError(`archive revision payload ${column} does not match its source binding`);
    }
  }
  return payload;
}

function historyArchiveRevisionPayloadKey(payload) {
  return JSON.stringify(canonicalFactPayload(payload, ["id"]));
}

function sameHistoryArchiveSourceIdentity(left, right) {
  return HISTORY_SOURCE_IDENTITY_COLUMNS.every((column) => left[column] === right[column]);
}

function sameHistoryArchivePerfRevisionInputVersion(left, right) {
  return left.dataVersion === right.dataVersion && left.totalChanges === right.totalChanges;
}

function canonicalHistoryArchiveRevisionDeltas(deltas) {
  return deltas
    .map(({ payload, count }) => ({ payload: canonicalFactPayload(payload, ["id"]), count }))
    .sort((left, right) => {
      const leftKey = historyArchiveRevisionPayloadKey(left.payload);
      const rightKey = historyArchiveRevisionPayloadKey(right.payload);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : left.count - right.count;
    });
}

function canonicalHistoryArchiveRevisionEntry(entry) {
  return {
    sourceIdentity: Object.fromEntries(
      HISTORY_SOURCE_IDENTITY_COLUMNS.map((column) => [column, entry.sourceIdentity[column]]),
    ),
    removed: canonicalHistoryArchiveRevisionDeltas(entry.removed),
    added: canonicalHistoryArchiveRevisionDeltas(entry.added),
  };
}

function historyArchiveRevisionEntryKey(entry) {
  return JSON.stringify(canonicalHistoryArchiveRevisionEntry(entry));
}

function historyArchiveRowsByNativeIdentity(rows, segmentId) {
  const byIdentity = new Map();
  for (const row of rows) {
    const key = JSON.stringify([Number(row.timestamp_ms), String(row.session_id)]);
    if (byIdentity.has(key)) {
      throw historyArchiveError(
        "HISTORY_ARCHIVE_COLD_REPARSE_CHANGED",
        `archive segment ${segmentId} requires one row per timestamp/session for a cold value revision`,
      );
    }
    byIdentity.set(key, row);
  }
  return byIdentity;
}

function historyArchiveColdRevisionForRows(prefix) {
  const originalByIdentity = historyArchiveRowsByNativeIdentity(prefix.originalRows, prefix.segmentId);
  const effectiveByIdentity = historyArchiveRowsByNativeIdentity(prefix.effectiveRows, prefix.segmentId);
  const observedByIdentity = historyArchiveRowsByNativeIdentity(prefix.observedRows, prefix.segmentId);
  const removedIdentities = [...effectiveByIdentity.keys()].filter((identity) => !observedByIdentity.has(identity));
  const addedIdentities = [...observedByIdentity.keys()].filter((identity) => !effectiveByIdentity.has(identity));
  if (
    observedByIdentity.size === 0 ||
    (removedIdentities.length > 0 && addedIdentities.length > 0) ||
    (removedIdentities.length > 0 && prefix.sourceIdentity.kind !== "project-log")
  ) {
    throw historyArchiveError(
      "HISTORY_ARCHIVE_COLD_REPARSE_CHANGED",
      `reparsed source removes or migrates cold events in authorized segment ${prefix.segmentId}`,
    );
  }

  const payloadFor = (row) => historyArchiveRevisionPayload(canonicalFactPayload(row, ["id"]), prefix.sourceIdentity);
  const effectivePayloads = new Map([...effectiveByIdentity].map(([identity, row]) => [identity, payloadFor(row)]));
  const observedPayloads = new Map([...observedByIdentity].map(([identity, row]) => [identity, payloadFor(row)]));
  const removedColdEventCount = removedIdentities.length;
  const changedIdentities = [
    ...[...effectivePayloads.keys()].filter(
      (identity) =>
        !observedPayloads.has(identity) ||
        historyArchiveRevisionPayloadKey(effectivePayloads.get(identity)) !==
          historyArchiveRevisionPayloadKey(observedPayloads.get(identity)),
    ),
    ...addedIdentities,
  ];
  if (changedIdentities.length === 0) return null;

  const originalPayloads = [...originalByIdentity.values()].map(payloadFor);
  const deltas = new Map();
  const addPayload = (payload, side) => {
    const key = historyArchiveRevisionPayloadKey(payload);
    const delta = deltas.get(key) || { payload, originalCount: 0, observedCount: 0 };
    delta[side] += 1;
    deltas.set(key, delta);
  };
  for (const payload of originalPayloads) addPayload(payload, "originalCount");
  for (const payload of observedPayloads.values()) addPayload(payload, "observedCount");

  const removed = [];
  const added = [];
  for (const { payload, originalCount, observedCount } of deltas.values()) {
    if (originalCount > observedCount) removed.push({ payload, count: originalCount - observedCount });
    else if (observedCount > originalCount) added.push({ payload, count: observedCount - originalCount });
  }
  // Keep the effective payload for recovery; the stored delta remains cumulative from the immutable candidate.
  return {
    entry: {
      sourceIdentity: { ...prefix.sourceIdentity },
      removed: canonicalHistoryArchiveRevisionDeltas(removed),
      added: canonicalHistoryArchiveRevisionDeltas(added),
    },
    removedColdEventCount,
    previousChangedRows: changedIdentities
      .map((identity) => effectiveByIdentity.get(identity))
      .filter((row) => row !== undefined),
    currentChangedRows: changedIdentities
      .map((identity) => observedByIdentity.get(identity))
      .filter((row) => row !== undefined),
  };
}

function writeHistoryArchiveEventRevisionState(database, revisionState) {
  const revisions = [];
  for (const [segmentId, entries] of revisionState.revisionsBySegment) {
    const segment = revisionState.segmentsById.get(segmentId);
    for (const entry of entries) {
      revisions.push({
        segmentId,
        databaseSha256: String(segment.database_sha256),
        ...canonicalHistoryArchiveRevisionEntry(entry),
      });
    }
  }
  const statement = database.prepare(
    `INSERT INTO store_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  if (revisions.length === 0) {
    database.prepare("DELETE FROM store_meta WHERE key = ?").run(HISTORY_ARCHIVE_EVENT_REVISIONS_META);
  } else {
    statement.run(HISTORY_ARCHIVE_EVENT_REVISIONS_META, JSON.stringify({ formatVersion: 1, revisions }));
  }
}

function markHistoryArchiveRevisionRollupDays(database, previousRows, currentRows) {
  createUsageRollups(database);
  const insertDirty = database.prepare("INSERT OR IGNORE INTO usage_rollup_dirty_days (day_key) VALUES (?)");
  const deleteCoveringDays = database.prepare("DELETE FROM usage_rollup_days WHERE ? >= start_ms AND ? < end_ms");
  const timestamps = new Set([...previousRows, ...currentRows].map((row) => Number(row.timestamp_ms)));
  for (const timestampMs of timestamps) {
    insertDirty.run(new Date(timestampMs).toISOString().slice(0, 10));
    deleteCoveringDays.run(timestampMs, timestampMs);
  }
}

function historyArchiveEventRevisions(rawValue, segmentsById) {
  if (rawValue === undefined) return new Map();
  let root;
  try {
    root = JSON.parse(String(rawValue));
  } catch {
    throw historyArchiveRevisionError("history archive event revisions are not valid JSON");
  }
  if (!hasExactObjectKeys(root, ["formatVersion", "revisions"]) || root.formatVersion !== 1) {
    throw historyArchiveRevisionError("history archive event revisions must be a version-1 revisions list");
  }
  if (!Array.isArray(root.revisions)) {
    throw historyArchiveRevisionError("history archive event revisions must be an array");
  }

  const revisionsBySegment = new Map();
  const bindings = new Set();
  for (const revision of root.revisions) {
    if (
      !hasExactObjectKeys(revision, ["segmentId", "databaseSha256", "sourceIdentity", "removed", "added"]) ||
      typeof revision.segmentId !== "string" ||
      typeof revision.databaseSha256 !== "string"
    ) {
      throw historyArchiveRevisionError("archive revision entry is malformed");
    }
    const segment = segmentsById.get(revision.segmentId);
    if (!segment) {
      throw historyArchiveRevisionError(`archive revision targets unregistered segment ${revision.segmentId}`);
    }
    if (revision.databaseSha256 !== segment.database_sha256) {
      throw historyArchiveRevisionError(`archive revision digest does not match segment ${revision.segmentId}`);
    }
    const sourceIdentity = revision.sourceIdentity;
    if (
      !hasExactObjectKeys(sourceIdentity, HISTORY_SOURCE_IDENTITY_COLUMNS) ||
      HISTORY_SOURCE_IDENTITY_COLUMNS.some((key) => typeof sourceIdentity[key] !== "string") ||
      sourceIdentity.path === ""
    ) {
      throw historyArchiveRevisionError(
        `archive revision source binding is malformed for segment ${segment.segment_id}`,
      );
    }
    const binding = JSON.stringify([revision.segmentId, sourceIdentity.path]);
    if (bindings.has(binding)) {
      throw historyArchiveRevisionError(
        `archive revision duplicates segment-source binding ${revision.segmentId}:${sourceIdentity.path}`,
      );
    }
    bindings.add(binding);

    const normalizeDeltas = (value, label) => {
      if (!Array.isArray(value)) {
        throw historyArchiveRevisionError(`archive revision ${label} must be an array`);
      }
      return value.map((delta) => {
        if (
          !hasExactObjectKeys(delta, ["payload", "count"]) ||
          !Number.isSafeInteger(delta.count) ||
          delta.count <= 0
        ) {
          throw historyArchiveRevisionError(`archive revision ${label} entries require a positive integer count`);
        }
        const payload = historyArchiveRevisionPayload(delta.payload, sourceIdentity);
        if (payload.source_path !== sourceIdentity.path) {
          throw historyArchiveRevisionError(
            `archive revision ${label} payload source does not match its source binding`,
          );
        }
        if (payload.timestamp_ms < Number(segment.start_ms) || payload.timestamp_ms >= Number(segment.end_ms)) {
          throw historyArchiveRevisionError(
            `archive revision ${label} payload is outside segment ${segment.segment_id}`,
          );
        }
        return { payload, count: delta.count };
      });
    };
    const entry = {
      sourceIdentity: { ...sourceIdentity },
      removed: normalizeDeltas(revision.removed, "removed"),
      added: normalizeDeltas(revision.added, "added"),
    };
    const entries = revisionsBySegment.get(revision.segmentId) || [];
    entries.push(entry);
    revisionsBySegment.set(revision.segmentId, entries);
  }
  return revisionsBySegment;
}

function applyHistoryArchiveEventRevisions(segment, cold, revisions) {
  if (!revisions?.length) return cold.rows;
  let rows = cold.rows;
  for (const revision of revisions) {
    const sourceIdentity = cold.sourceIdentities.find((identity) =>
      sameHistoryArchiveSourceIdentity(identity, revision.sourceIdentity),
    );
    if (!sourceIdentity) {
      throw historyArchiveRevisionError(`archive revision source binding does not match segment ${segment.segment_id}`);
    }
    const sourceRows = rows.filter((row) => String(row.source_path) === sourceIdentity.path);
    const sourceCounts = historyArchiveEventCounts(sourceRows);
    const removedCounts = new Map();
    for (const removed of revision.removed) {
      const key = historyArchiveRevisionPayloadKey(removed.payload);
      const count = (removedCounts.get(key) || 0) + removed.count;
      if (count > (sourceCounts.get(key) || 0)) {
        throw historyArchiveRevisionError(
          `archive revision removes more payloads than segment ${segment.segment_id} contains`,
        );
      }
      removedCounts.set(key, count);
    }

    const remainingRemovals = new Map(removedCounts);
    const revised = [];
    for (const row of rows) {
      if (String(row.source_path) !== sourceIdentity.path) {
        revised.push(row);
        continue;
      }
      const key = historyArchiveRevisionPayloadKey(row);
      const remaining = remainingRemovals.get(key) || 0;
      if (remaining > 0) {
        remainingRemovals.set(key, remaining - 1);
        continue;
      }
      revised.push(row);
    }
    for (const added of revision.added) {
      for (let index = 0; index < added.count; index += 1) {
        revised.push({ id: null, ...added.payload });
      }
    }
    rows = revised;
  }
  return rows;
}

function publishedUsageEventFromRow(row, sourceKind, serviceTierEvidence, resolveQuotaSource) {
  const timestampMs = Number(row.timestamp_ms);
  const sessionId = String(row.session_id);
  return {
    timestamp: new Date(timestampMs).toISOString(),
    sessionId,
    homeId: String(row.home_id),
    homeLabel: String(row.home_label),
    sourceKind: String(sourceKind),
    channel: String(row.channel),
    project: String(row.project),
    model: String(row.model),
    ...(canonicalPerfSourceKind(String(sourceKind)) === "codex"
      ? { quotaSource: resolveQuotaSource?.(String(row.home_id), sessionId, timestampMs) || "unknown" }
      : {}),
    cwd: String(row.cwd),
    repositoryKey: String(row.repository_key),
    repositoryPath: String(row.repository_path),
    repositoryKind: String(row.repository_kind),
    detailMask: Number(row.detail_mask || 0),
    reconciliationGap: Number(row.reconciliation_gap || 0),
    cacheWriteTokens: Number(row.cache_write_tokens || 0),
    cacheWriteKnown: Boolean(row.cache_write_known),
    requestInputTokens: Number(row.request_input_tokens || 0),
    contextLevel: String(row.context_level),
    serviceTier:
      serviceTierEvidence?.resolve(sessionId, timestampMs, String(row.service_tier)) || String(row.service_tier),
    priceVersion: String(row.price_version),
    total: usageFromRow(row),
  };
}

function metadataFromHistoryEvents(events, carrier, asOf) {
  const asOfMs = asOf.getTime();
  const sessions = new Set();
  const homeRows = new Map();
  const harnessModels = Object.fromEntries(HARNESS_MODEL_NAMES.map((name) => [name, new Set()]));
  const observationRows = new Map();
  for (const event of events) {
    const sessionId = String(event.sessionId);
    sessions.add(sessionId);
    const homeId = String(event.homeId);
    const homeRow = homeRows.get(homeId) || { eventCount: 0, sessions: new Set() };
    homeRow.eventCount += 1;
    homeRow.sessions.add(sessionId);
    homeRows.set(homeId, homeRow);

    const model = String(event.model || "").trim();
    if (model && model.toLocaleLowerCase() !== "unknown model") {
      harnessModels[harnessModelName(event.channel)].add(model);
    }

    const timestampMs = Date.parse(event.timestamp);
    if (!Number.isFinite(timestampMs) || timestampMs > asOfMs) continue;
    const key = JSON.stringify([event.channel, event.model, homeId]);
    const observation = observationRows.get(key);
    if (observation) observation.lastSeen = Math.max(observation.lastSeen, timestampMs);
    else observationRows.set(key, { channel: event.channel, model: event.model, homeId, lastSeen: timestampMs });
  }

  const sourceKinds = homeSourceKinds(carrier.homes);
  const observations = [...observationRows.values()].map((row) => {
    const group = sourceGroup(row.channel, sourceKinds.get(row.homeId));
    return {
      model: row.model,
      timestamp: row.lastSeen,
      harness: ["ZCode", "DSH", "OpenCode", "Claude"].includes(group) ? group : "Codex",
    };
  });
  return {
    generatedAt: carrier.generatedAt,
    eventCount: events.length,
    sessionCount: sessions.size,
    homeCount: carrier.homes.length,
    harnessModels: Object.fromEntries(
      HARNESS_MODEL_NAMES.map((name) => [name, [...harnessModels[name]].sort((a, b) => a.localeCompare(b))]),
    ),
    homes: carrier.homes.map((home) => {
      const row = homeRows.get(String(home.id));
      return {
        ...home,
        status: row ? "active" : "no-events",
        eventCount: row?.eventCount || 0,
        sessionCount: row?.sessions.size || 0,
      };
    }),
    warnings: carrier.warnings,
    ...buildModelActivity(observations, asOf),
  };
}

function withoutExcludedHistoryHomes(report, excludeHomes = []) {
  // The server helper cannot be imported here: server -> store would form a cycle.
  const excluded = new Set((excludeHomes || []).map(String));
  if (!excluded.size) return report;
  return {
    ...report,
    events: report.events.filter((event) => !excluded.has(String(event.homeId))),
    sessions: report.sessions.filter((session) => !excluded.has(String(session.homeId))),
    perfSamples: report.perfSamples?.filter((sample) => !excluded.has(String(sample.homeId))),
  };
}

function publishedUsageHomesFromDatabase(database) {
  const rows = database
    .prepare(
      `SELECT DISTINCT home_id, home_label, home_path, kind
       FROM source_files
       ORDER BY home_id, home_label, home_path, kind`,
    )
    .all();
  const homes = [];
  for (const row of rows) {
    const home = {
      id: String(row.home_id),
      label: String(row.home_label),
      path: String(row.home_path),
      kind: String(row.kind),
    };
    const previous = homes[homes.length - 1];
    if (previous?.id === home.id) {
      if (previous.label !== home.label || previous.path !== home.path || previous.kind !== home.kind) {
        throw Object.assign(new Error(`Conflicting published identity for home ${home.id}`), {
          code: "PUBLISHED_HOME_IDENTITY_CONFLICT",
        });
      }
      continue;
    }
    homes.push(home);
  }
  return homes;
}

function quotaObservationsFromDatabase(database, attachedHot = false) {
  const rows = Array.from(
    database
      .prepare(`
      SELECT source_path, line_number, role, observed_at_ms, limit_id, limit_name,
        plan_type, window_minutes, resets_at_ms, used_percent
      FROM ${attachedHot ? "history_hot." : ""}rate_limit_observations INDEXED BY rate_limit_window_lookup_idx
      ORDER BY limit_id ASC, window_minutes ASC, observed_at_ms DESC
    `)
      .iterate(),
    (row) => ({
      sourcePath: row.source_path,
      lineNumber: Number(row.line_number),
      role: row.role,
      observedAtMs: Number(row.observed_at_ms),
      limitId: row.limit_id,
      limitName: row.limit_name,
      planType: row.plan_type,
      windowMinutes: Number(row.window_minutes),
      resetsAtMs: Number(row.resets_at_ms),
      usedPercent: row.used_percent === null ? null : Number(row.used_percent),
    }),
  );
  const saved = database
    .prepare(
      `SELECT value FROM ${attachedHot ? "history_hot." : ""}store_meta WHERE key = 'official_quota_observations'`,
    )
    .get()?.value;
  return saved ? rows.concat(JSON.parse(String(saved))) : rows;
}

function publishedUsageSessionsFromEvents(events, homes) {
  const homesById = new Map(homes.map((home) => [home.id, home]));
  /** @type {Map<string, ReturnType<UsageStore["publishedUsageSessions"]>[number]>} */
  const sessions = new Map();
  for (const event of events) {
    const home = homesById.get(event.homeId);
    if (!home) {
      throw Object.assign(new Error(`Missing published home ${event.homeId}`), {
        code: "PUBLISHED_SESSION_HOME_MISSING",
      });
    }
    const key = JSON.stringify([event.homeId, event.sessionId]);
    const current = sessions.get(key);
    if (!current) {
      sessions.set(key, {
        id: event.sessionId,
        homeId: event.homeId,
        homeLabel: home.label,
        homePath: home.path,
        firstAt: event.timestamp,
        lastAt: event.timestamp,
        eventCount: 1,
        total: { ...event.total },
        channel: event.channel,
        cwd: event.cwd || "",
        model: event.model,
      });
      continue;
    }
    if (event.timestamp < current.firstAt) current.firstAt = event.timestamp;
    if (event.timestamp > current.lastAt) current.lastAt = event.timestamp;
    current.eventCount += 1;
    current.total.total += event.total.total;
    current.total.input += event.total.input;
    current.total.cached += event.total.cached;
    current.total.output += event.total.output;
    current.total.reasoning += event.total.reasoning;
    current.channel = event.channel;
    current.cwd = event.cwd || "";
    current.model = event.model;
  }
  return [...sessions.values()].sort(
    (left, right) =>
      left.lastAt.localeCompare(right.lastAt) ||
      left.homeId.localeCompare(right.homeId) ||
      left.id.localeCompare(right.id),
  );
}

function publishedUsageEventsFromUnion(union, serviceTierEvidence, resolveQuotaSource) {
  // This request owns the rows; release raw facts as their public projection replaces them.
  for (let index = 0; index < union.rows.length; index += 1) {
    const row = union.rows[index];
    const sourceKind = union.sourceKinds.get(String(row.source_path));
    if (sourceKind === undefined) {
      throw historyArchiveError(
        "HISTORY_ARCHIVE_SOURCE_CHANGED",
        `published source ${String(row.source_path)} has no verified source identity`,
      );
    }
    union.rows[index] = publishedUsageEventFromRow(row, sourceKind, serviceTierEvidence, resolveQuotaSource);
  }
  return union.rows;
}

function historyArchiveAuthorizedSegmentIds(database) {
  const authorityValue = database
    .prepare("SELECT value FROM store_meta WHERE key = ?")
    .get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META)?.value;
  if (authorityValue === undefined) return new Set();
  let authority;
  try {
    authority = JSON.parse(String(authorityValue));
  } catch {
    throw historyArchiveError("HISTORY_ARCHIVE_AUTHORITY_INVALID", "history archive event authority is not valid JSON");
  }
  if (
    !authority ||
    typeof authority !== "object" ||
    Array.isArray(authority) ||
    Object.keys(authority).sort().join(",") !== "formatVersion,segmentIds" ||
    authority.formatVersion !== 1 ||
    !Array.isArray(authority.segmentIds) ||
    authority.segmentIds.some((segmentId) => typeof segmentId !== "string" || !/^[a-f0-9]{64}$/.test(segmentId)) ||
    new Set(authority.segmentIds).size !== authority.segmentIds.length
  ) {
    throw historyArchiveError(
      "HISTORY_ARCHIVE_AUTHORITY_INVALID",
      "history archive event authority must be a version-1 unique segment id list",
    );
  }
  const registeredSegmentIds = new Set(
    database
      .prepare("SELECT segment_id FROM archive_segments")
      .all()
      .map((segment) => String(segment.segment_id)),
  );
  for (const segmentId of authority.segmentIds) {
    if (!registeredSegmentIds.has(segmentId)) {
      throw historyArchiveError("HISTORY_ARCHIVE_SEGMENT_NOT_FOUND", `archive segment ${segmentId} is not registered`);
    }
  }
  return new Set(authority.segmentIds);
}

function historyArchivePerfAuthority(database, authorizedSegmentIds, recordsById) {
  const authorityValue = database
    .prepare("SELECT value FROM store_meta WHERE key = ?")
    .get(HISTORY_ARCHIVE_PERF_AUTHORITY_META)?.value;
  if (authorityValue === undefined) return null;

  let authority;
  try {
    authority = JSON.parse(String(authorityValue));
  } catch {
    throw historyArchiveError(
      "HISTORY_ARCHIVE_PERF_AUTHORITY_INVALID",
      "history archive perf authority is not valid JSON",
    );
  }
  const keys = (value) =>
    value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort().join(",") : "";
  if (
    keys(authority) !== "formatVersion,segments" ||
    authority.formatVersion !== 1 ||
    !Array.isArray(authority.segments) ||
    authority.segments.length === 0
  ) {
    throw historyArchiveError(
      "HISTORY_ARCHIVE_PERF_AUTHORITY_INVALID",
      "history archive perf authority must grant one or more supported source segments matching their database digests",
    );
  }

  const segments = [];
  const segmentIds = new Set();
  for (const segment of authority.segments) {
    const segmentId = segment?.segmentId;
    if (
      keys(segment) !== "databaseSha256,methodVersions,segmentId,sourceKinds" ||
      typeof segmentId !== "string" ||
      !/^[a-f0-9]{64}$/.test(segmentId) ||
      segment.databaseSha256 !== segmentId ||
      !Array.isArray(segment.sourceKinds) ||
      segment.sourceKinds.length !== 1 ||
      !["zcode", "codex", "workbuddy"].includes(segment.sourceKinds[0]) ||
      !Array.isArray(segment.methodVersions) ||
      segment.methodVersions.length !== 1 ||
      !PERF_SUPPORTED_METHOD_VERSIONS.includes(segment.methodVersions[0]) ||
      (segment.sourceKinds[0] === "workbuddy" && !isGenerationPerfMethod(segment.methodVersions[0])) ||
      segmentIds.has(segmentId)
    ) {
      throw historyArchiveError(
        "HISTORY_ARCHIVE_PERF_AUTHORITY_INVALID",
        "history archive perf authority must grant unique supported source segments matching their database digests",
      );
    }
    const sourceKind = segment.sourceKinds[0];
    segmentIds.add(segmentId);
    const record = recordsById.get(segmentId);
    if (!authorizedSegmentIds.has(segmentId) || !record || String(record.database_sha256) !== segmentId) {
      throw historyArchiveError(
        "HISTORY_ARCHIVE_PERF_AUTHORITY_MISMATCH",
        `perf authority segment ${segmentId} is not the authorized registered segment`,
      );
    }
    segments.push({ segmentId, record, sourceKind, methodVersion: segment.methodVersions[0] });
  }
  return segments;
}

function historyArchivePerfSamplePayloadKey(sample) {
  return JSON.stringify(PERF_SAMPLE_FIELDS.map((entry) => sample[entry.field]));
}

function mergeHistoryArchivePerfSamples(perfCarrier, coldSamples, sourceKind, revisionsBySampleKey = new Map()) {
  const samples = new Map(perfCarrier.samples.map((sample) => [String(sample.sampleKey), sample]));
  const identities = new Map(perfCarrier.identities.map((identity) => [String(identity.sampleKey), identity]));
  const knownSources = new Map(
    perfCarrier.knownSources.map((source) => [JSON.stringify([String(source.kind), String(source.homeId)]), source]),
  );
  const coldSampleKeys = new Set(coldSamples.map((sample) => String(sample.sampleKey)));
  for (const sample of coldSamples) {
    if (sample.sourceKind !== sourceKind || !PERF_SUPPORTED_METHOD_VERSIONS.includes(sample.methodVersion)) {
      throw historyArchiveError(
        "HISTORY_ARCHIVE_PERF_AUTHORITY_MISMATCH",
        `perf authority declared ${sourceKind} but returned sample ${sample.sampleKey} from ${sample.sourceKind}`,
      );
    }
    const sampleKey = String(sample.sampleKey);
    const existing = samples.get(sampleKey);
    if (existing && JSON.stringify(existing) !== JSON.stringify(sample)) {
      const removedPayloads = revisionsBySampleKey.get(sampleKey)?.removedPayloads;
      if (!removedPayloads?.has(historyArchivePerfSamplePayloadKey(existing))) {
        throw historyArchiveError(
          "HISTORY_ARCHIVE_PERF_SAMPLE_CONFLICT",
          `hot and cold perf sample ${sampleKey} have different payloads`,
        );
      }
    }
    if (!existing) samples.set(sampleKey, sample);
    else if (JSON.stringify(existing) !== JSON.stringify(sample)) samples.set(sampleKey, sample);
    const identity = { sampleKey, sourceKind: sample.sourceKind, homeId: sample.homeId };
    const existingIdentity = identities.get(sampleKey);
    if (
      existingIdentity &&
      (existingIdentity.sourceKind !== identity.sourceKind || existingIdentity.homeId !== identity.homeId)
    ) {
      throw historyArchiveError(
        "HISTORY_ARCHIVE_PERF_SAMPLE_CONFLICT",
        `hot and cold perf sample ${sampleKey} have different identities`,
      );
    }
    if (!existingIdentity) identities.set(sampleKey, identity);
    const sourceKey = JSON.stringify([sample.sourceKind, sample.homeId]);
    if (!knownSources.has(sourceKey)) {
      knownSources.set(sourceKey, { kind: sample.sourceKind, homeId: sample.homeId });
    }
  }
  for (const [sampleKey, revision] of revisionsBySampleKey) {
    if (coldSampleKeys.has(sampleKey)) continue;
    const existing = samples.get(sampleKey);
    if (!existing) continue;
    if (!revision.removedPayloads.has(historyArchivePerfSamplePayloadKey(existing))) {
      throw historyArchiveError(
        "HISTORY_ARCHIVE_PERF_SAMPLE_CONFLICT",
        `hot and cold perf sample ${sampleKey} have different payloads`,
      );
    }
    samples.delete(sampleKey);
    identities.delete(sampleKey);
  }
  return {
    ...perfCarrier,
    samples: [...samples.values()],
    identities: [...identities.values()],
    knownSources: [...knownSources.values()],
  };
}

const EVENT_INSERT_COLUMNS = Object.freeze([
  "source_path",
  "timestamp_ms",
  "session_id",
  "home_id",
  "home_label",
  "channel",
  "project",
  "model",
  "hour_key",
  "day_key",
  "week_key",
  "month_key",
  "cwd",
  "repository_key",
  "repository_path",
  "repository_kind",
  "detail_mask",
  "reconciliation_gap",
  "cache_write_tokens",
  "cache_write_known",
  "request_input_tokens",
  "context_level",
  "service_tier",
  "price_version",
  "total",
  "input",
  "cached",
  "output",
  "reasoning",
]);

const EVENT_INTEGER_COLUMNS = Object.freeze([
  "timestamp_ms",
  "detail_mask",
  "reconciliation_gap",
  "cache_write_tokens",
  "cache_write_known",
  "request_input_tokens",
  "total",
  "input",
  "cached",
  "output",
  "reasoning",
]);

function saveMissingHistoryFacts(
  insertReplacedFact,
  { factTable, source, previousRows, currentRows, methodVersion, excludedColumns = [] },
) {
  const currentCounts = new Map();
  for (const row of currentRows) {
    const payloadDigest = historyPayloadDigest(canonicalFactPayload(row, excludedColumns));
    currentCounts.set(payloadDigest, (currentCounts.get(payloadDigest) || 0) + 1);
  }
  const previousCounts = new Map();
  for (const row of previousRows) {
    const payload = canonicalFactPayload(row, excludedColumns);
    const payloadDigest = historyPayloadDigest(payload);
    const existing = previousCounts.get(payloadDigest);
    previousCounts.set(payloadDigest, {
      payload,
      count: (existing?.count || 0) + 1,
    });
  }
  const recordedAt = new Date().toISOString();
  for (const [payloadDigest, previous] of previousCounts) {
    const missingCount = previous.count - (currentCounts.get(payloadDigest) || 0);
    if (missingCount <= 0) continue;
    insertReplacedFact.run(
      factTable,
      String(source.kind),
      String(source.home_id),
      String(source.path),
      payloadDigest,
      missingCount,
      JSON.stringify(previous.payload),
      String(source.home_label),
      String(source.home_path),
      methodVersion,
      "reparse_replaced",
      recordedAt,
    );
  }
}

const CODEX_ROLLOUT_READER_VERSION = "zstd-jsonl-v1";

/**
 * W4-b1 / D1：`buildRecordChampions` 的**默认**逐行计价函数（= 模块级的 `estimateEventCost`）。
 *
 * 存在的理由：该方法的源码里有一行 `const estimate = estimateEventCost({…})`，被共享门禁
 * （`tools/lib/instrument.mjs` 的 `fullHistoryPricingRows` 锚点）**逐字节**锚定。为了在不改锚点的
 * 前提下让它走 memo，把计价函数作为**末位参数注入**（默认值就是这个别名）。
 */
const DEFAULT_EVENT_COST_ESTIMATOR = estimateEventCost;

/**
 * M3.1：`perf_samples` 的**单一字段映射表** —— 编码、解码、INSERT 列序、SELECT 列序全部由它驱动。
 *
 * `kind` 决定 SQL 类型与 JS 侧取值域：
 * - `text` → `TEXT NOT NULL`：归一化样本里名称/身份/口径类字段**恒为字符串**（缺失是空串，裁定 P），
 *   列声明 `NOT NULL` 是为了不让"缺失"多出第二个字面量 `NULL`。
 * - `integer` → `INTEGER`（**可空**）：度量类字段"未知"是 `NULL`、真实 0 是 `0`。若写成
 *   `NOT NULL DEFAULT 0`，这条规则被**结构性破坏**，而且写入方总会给值，测试不会发现（裁定 AO-3）。
 * - `flags` → `INTEGER NOT NULL DEFAULT 0`：位域不是度量，"没有任何位"本来就等于 0（§17.4）。
 * - `reasonChain` → `TEXT`（**可空**）：JSON 数组文本；`NULL`（没有链）与 `'[]'`（链已算出且为空）
 *   是两种状态，必须可区分（裁定 AO-1/AO-3）。
 *
 * 顺序 = DDL 列顺序 = INSERT/SELECT 参数顺序；测试用 `PRAGMA table_info(perf_samples)` 与之双向锁定。
 * @typedef {{ field: string, column: string, kind: "text" | "integer" | "flags" | "reasonChain", notNull: boolean, primaryKey?: boolean }} PerfSampleFieldSpec
 */

/** @type {ReadonlyArray<PerfSampleFieldSpec>} */
export const PERF_SAMPLE_FIELDS = Object.freeze([
  { field: "sampleKey", column: "sample_key", kind: "text", notNull: true, primaryKey: true },
  { field: "sourcePath", column: "source_path", kind: "text", notNull: true },
  { field: "sourceKind", column: "source_kind", kind: "text", notNull: true },
  { field: "homeId", column: "home_id", kind: "text", notNull: true },
  { field: "channel", column: "channel", kind: "text", notNull: true },
  { field: "agentKind", column: "agent_kind", kind: "text", notNull: true },
  { field: "agent", column: "agent", kind: "text", notNull: true },
  { field: "sessionId", column: "session_id", kind: "text", notNull: true },
  { field: "turnKey", column: "turn_key", kind: "text", notNull: true },
  { field: "model", column: "model", kind: "text", notNull: true },
  { field: "modelProvider", column: "model_provider", kind: "text", notNull: true },
  { field: "reasoningEffort", column: "reasoning_effort", kind: "text", notNull: true },
  { field: "modelEvidence", column: "model_evidence", kind: "text", notNull: true },
  { field: "window", column: "window", kind: "text", notNull: true },
  { field: "timingKind", column: "timing_kind", kind: "text", notNull: true },
  { field: "timingSource", column: "timing_source", kind: "text", notNull: true },
  { field: "tokenScope", column: "token_scope", kind: "text", notNull: true },
  { field: "status", column: "status", kind: "text", notNull: true },
  { field: "tsMs", column: "ts_ms", kind: "integer", notNull: false },
  { field: "windowStartMs", column: "window_start_ms", kind: "integer", notNull: false },
  { field: "windowEndMs", column: "window_end_ms", kind: "integer", notNull: false },
  { field: "durationMs", column: "duration_ms", kind: "integer", notNull: false },
  { field: "outputTokens", column: "output_tokens", kind: "integer", notNull: false },
  { field: "inputTokens", column: "input_tokens", kind: "integer", notNull: false },
  { field: "requestCount", column: "request_count", kind: "integer", notNull: false },
  { field: "itemCount", column: "item_count", kind: "integer", notNull: false },
  { field: "timedItemCount", column: "timed_item_count", kind: "integer", notNull: false },
  { field: "sampleFlags", column: "sample_flags", kind: "flags", notNull: true },
  { field: "diagnosticReason", column: "diagnostic_reason", kind: "text", notNull: true },
  { field: "diagnosticReasonChain", column: "diagnostic_reason_chain", kind: "reasonChain", notNull: false },
  { field: "methodVersion", column: "method_version", kind: "text", notNull: true },
]);

const PERF_SAMPLE_COLUMNS = Object.freeze(PERF_SAMPLE_FIELDS.map((entry) => entry.column));

/**
 * `perf_samples` 的冻结 DDL（**字面量，不从映射表生成**）。
 *
 * 为什么用字面量：若从映射表生成，"改映射表"会顺带改 schema —— 一次看起来无害的编辑就变成
 * 迁移语义变化（AN-9 那类陷阱）。字面量 + 测试断言「`PRAGMA table_info` 与映射表逐列相等」
 * 才能让两侧任何漂移都变红。
 *
 * 这是自 v2 以来**首次真正 `CREATE TABLE` 的迁移**（AN-5）：外键与级联删除在本仓库从未演练，
 * 因此 `STRICT`、`IF NOT EXISTS`、`REFERENCES … ON DELETE CASCADE`、三个索引都必须在测试里
 * **实测**，不得以"写了"当证据。
 *
 * 数值列一律**可空**（AO-3）：`NULL` = 该度量未知，`0` = 真实 0。
 */
const PERF_SAMPLES_DDL = `
      CREATE TABLE IF NOT EXISTS perf_samples (
        sample_key TEXT PRIMARY KEY,
        source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
        source_kind TEXT NOT NULL CHECK (source_kind <> ''),
        home_id TEXT NOT NULL CHECK (home_id <> ''),
        channel TEXT NOT NULL,
        agent_kind TEXT NOT NULL CHECK (agent_kind IN ('main', 'subagent', 'unknown')),
        agent TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_key TEXT NOT NULL,
        model TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        model_evidence TEXT NOT NULL,
        window TEXT NOT NULL,
        timing_kind TEXT NOT NULL CHECK (timing_kind IN ('request_e2e', 'item_span_estimate', 'generation')),
        timing_source TEXT NOT NULL,
        token_scope TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'cancelled', 'in_progress', 'unverified')),
        ts_ms INTEGER,
        window_start_ms INTEGER,
        window_end_ms INTEGER,
        duration_ms INTEGER,
        output_tokens INTEGER,
        input_tokens INTEGER,
        request_count INTEGER,
        item_count INTEGER,
        timed_item_count INTEGER,
        sample_flags INTEGER NOT NULL DEFAULT 0,
        diagnostic_reason TEXT NOT NULL,
        diagnostic_reason_chain TEXT,
        method_version TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS perf_samples_source_path_idx ON perf_samples(source_path);
      CREATE INDEX IF NOT EXISTS perf_samples_home_ts_idx ON perf_samples(home_id, ts_ms);
      CREATE INDEX IF NOT EXISTS perf_samples_source_kind_home_ts_idx ON perf_samples(source_kind, home_id, ts_ms);
`;

/** 冻结的三个索引：名字 → 列顺序。自检要逐个核对 `PRAGMA index_info`（同名索引可能挂在别的表上，被 `IF NOT EXISTS` 静默忽略）。 */
/** @type {ReadonlyArray<[string, ReadonlyArray<string>]>} */
const PERF_SAMPLES_INDEXES = Object.freeze([
  ["perf_samples_source_path_idx", ["source_path"]],
  ["perf_samples_home_ts_idx", ["home_id", "ts_ms"]],
  ["perf_samples_source_kind_home_ts_idx", ["source_kind", "home_id", "ts_ms"]],
]);

const PERF_CODEX_INDEX_DDL = `
  CREATE TABLE IF NOT EXISTS perf_sample_sources (
    sample_key TEXT NOT NULL REFERENCES perf_samples(sample_key) ON DELETE CASCADE,
    source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('primary', 'dependency')),
    PRIMARY KEY (sample_key, source_path)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS perf_sample_sources_path_idx ON perf_sample_sources(source_path);
  CREATE TABLE IF NOT EXISTS perf_rollout_threads (
    source_path TEXT PRIMARY KEY REFERENCES source_files(path) ON DELETE CASCADE,
    home_id TEXT NOT NULL CHECK (home_id <> ''),
    thread_id TEXT NOT NULL CHECK (thread_id <> '')
  ) STRICT;
  CREATE INDEX IF NOT EXISTS perf_rollout_threads_home_thread_idx ON perf_rollout_threads(home_id, thread_id);
`;

/**
 * T1（本计划**首次** schema bump，13 → 14）：Codex 标准化投影的**私有持久表**。**只建表 + 索引，不回填。**
 *
 * 动机是 C6 的实测（不是推测）：`src/perf-sources/codex-thread.js:575` 在"有文件真变"的那一轮逐文件
 * 遍历**全部**路径，而被 LRU 逐出的条目在 `lookup` 处必然 `undefined` ⇒ `:590-592` 直接
 * `readCodexRolloutMetadata()` **全文读**。C6 §3 实测 `r3parse = 1 + 逐出数`（缺省 64 MiB 下
 * 2× ⇒ 84 份 / 893,718,901 B；4× ⇒ 363 份 / 3,766,975,634 B），§3.2 又实测真变后缓存**塌缩**
 * （1,086 → 202 条，逐出 1,246）⇒ 退化会自我放大。本表让被逐出的投影不必重新解析全文。
 *
 * 只存**规范投影**（`readCodexRolloutMetadata()` 返回对象的 JSON 文本），**严禁** raw JSONL；
 * 列定义与不变量逐项见 `handoffs/T1-design.md` §2（含 §0 修订 1 的两处"与内存键同形"）。
 *
 * `STRICT` 与本仓其它新表（`perf_samples`/`perf_sample_sources`/`perf_rollout_threads`）一致：
 * 它不新增列，但把"类型写错"从静默 coerce 变成硬失败。
 */
const PERF_CODEX_PROJECTIONS_DDL = `
  CREATE TABLE IF NOT EXISTS perf_codex_projections (
    path TEXT PRIMARY KEY,
    home_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    method_version TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    projection TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS perf_codex_projections_home_idx ON perf_codex_projections(home_id);
`;

/** 冻结列序（`name` / `type` / `pk` / `notnull`），逐个核对；本机实测 STRICT 表的主键列 `notnull=1`。 */
const PERF_CODEX_PROJECTION_COLUMNS = Object.freeze([
  ["path", "TEXT", 1, 1],
  ["home_id", "TEXT", 0, 1],
  ["kind", "TEXT", 0, 1],
  ["method_version", "TEXT", 0, 1],
  ["fingerprint", "TEXT", 0, 1],
  ["bytes", "INTEGER", 0, 1],
  ["projection", "TEXT", 0, 1],
  ["updated_at", "TEXT", 0, 1],
]);

/** 冻结索引：名字 → 列序。
 * @type {ReadonlyArray<readonly [string, readonly string[]]>}
 */
const PERF_CODEX_PROJECTIONS_INDEXES = Object.freeze([["perf_codex_projections_home_idx", ["home_id"]]]);

/**
 * 自检 `perf_codex_projections` 的**实际** schema 是否等于冻结 DDL（列名/类型/可空性/主键 + 索引列序 + `STRICT`）。
 *
 * 与 `assertPerfSamplesSchema` 同因：`CREATE TABLE IF NOT EXISTS` 只按**名字**判断存在性 ——
 * 同名 VIEW 会静默通过（一列都没建）、同名索引挂错表也会静默通过。没有这道自检，"迁移成功"
 * 可能只是"什么都没建"，而 `user_version` 已经抬到 14。它是 `migrate()` 事务内的最后一步：
 * 不符即抛 ⇒ 回滚 ⇒ 版本保持 13，下次打开重试。
 * @param {import("node:sqlite").DatabaseSync} database
 */
function assertPerfCodexProjectionsSchema(database) {
  const actualColumns = database.prepare("PRAGMA table_info(perf_codex_projections)").all();
  if (actualColumns.length !== PERF_CODEX_PROJECTION_COLUMNS.length) {
    throw new PerfSampleCodecError(
      "PERF_CODEX_PROJECTION_SCHEMA_MISMATCH",
      `perf_codex_projections 列数 ${actualColumns.length} ≠ 冻结 ${PERF_CODEX_PROJECTION_COLUMNS.length}`,
    );
  }
  for (const [index, [name, type, pk, notNull]] of PERF_CODEX_PROJECTION_COLUMNS.entries()) {
    const row = actualColumns[index];
    if (
      String(row.name) !== name ||
      String(row.type || "").toUpperCase() !== type ||
      Number(row.pk) !== pk ||
      Number(row.notnull) !== notNull
    ) {
      throw new PerfSampleCodecError(
        "PERF_CODEX_PROJECTION_SCHEMA_MISMATCH",
        `perf_codex_projections 列 ${index} 实际 ${String(row.name)}/${String(row.type)}/notnull=${Number(row.notnull)}/pk=${Number(row.pk)} ≠ 冻结 ${name}/${type}/notnull=${notNull}/pk=${pk}`,
      );
    }
  }
  const indexNames = new Set(
    database
      .prepare("PRAGMA index_list(perf_codex_projections)")
      .all()
      .map((row) => String(row.name)),
  );
  for (const [indexName, columns] of PERF_CODEX_PROJECTIONS_INDEXES) {
    if (!indexNames.has(indexName)) {
      throw new PerfSampleCodecError(
        "PERF_CODEX_PROJECTION_SCHEMA_MISMATCH",
        `perf_codex_projections 缺少索引 ${indexName}`,
      );
    }
    const actual = database
      .prepare(`PRAGMA index_info(${indexName})`)
      .all()
      .map((row) => String(row.name));
    if (JSON.stringify(actual) !== JSON.stringify(columns)) {
      throw new PerfSampleCodecError(
        "PERF_CODEX_PROJECTION_SCHEMA_MISMATCH",
        `索引 ${indexName} 列序 ${actual.join(",")} ≠ ${columns.join(",")}`,
      );
    }
  }
  const ddl = String(
    database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'perf_codex_projections'").get()
      ?.sql ?? "",
  );
  if (!ddl.includes("STRICT")) {
    throw new PerfSampleCodecError("PERF_CODEX_PROJECTION_SCHEMA_MISMATCH", "perf_codex_projections 不是 STRICT 表");
  }
}

function assertPerfCodexIndexSchema(database) {
  const expected = [
    ["perf_sample_sources", ["sample_key", "source_path", "role"], ["perf_sample_sources_path_idx"]],
    ["perf_rollout_threads", ["source_path", "home_id", "thread_id"], ["perf_rollout_threads_home_thread_idx"]],
  ];
  for (const [table, columns, indexes] of expected) {
    const actual = database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name));
    if (JSON.stringify(actual) !== JSON.stringify(columns)) {
      throw new PerfSampleCodecError("PERF_CODEX_SCHEMA_MISMATCH", `${table} columns do not match the M7 contract`);
    }
    const actualIndexes = new Set(
      database
        .prepare(`PRAGMA index_list(${table})`)
        .all()
        .map((row) => String(row.name)),
    );
    for (const index of indexes) {
      if (!actualIndexes.has(index)) {
        throw new PerfSampleCodecError("PERF_CODEX_SCHEMA_MISMATCH", `${table} is missing index ${index}`);
      }
    }
  }
  const sampleSourceFks = database.prepare("PRAGMA foreign_key_list(perf_sample_sources)").all();
  const rolloutFks = database.prepare("PRAGMA foreign_key_list(perf_rollout_threads)").all();
  if (
    !sampleSourceFks.some(
      (row) => row.table === "perf_samples" && row.from === "sample_key" && row.on_delete === "CASCADE",
    ) ||
    !sampleSourceFks.some(
      (row) => row.table === "source_files" && row.from === "source_path" && row.on_delete === "CASCADE",
    ) ||
    !rolloutFks.some((row) => row.table === "source_files" && row.from === "source_path" && row.on_delete === "CASCADE")
  ) {
    throw new PerfSampleCodecError(
      "PERF_CODEX_SCHEMA_MISMATCH",
      "M7 dependency tables must cascade from their parents",
    );
  }
}

/**
 * 把 reader 的编码 warning（`{ sourceKind, homeId, code, count }`）转成既有 warnings 数组里的字符串。
 * **只输出编码后的四要素**，不含路径与内容（方案 `:62` 的字段取用与持久化限制）。
 * @param {any} warning
 */
function formatPerfWarning(warning) {
  const kind = typeof warning?.sourceKind === "string" ? warning.sourceKind : "unknown";
  const homeId = typeof warning?.homeId === "string" ? warning.homeId : "";
  const code = typeof warning?.code === "string" ? warning.code : "UNKNOWN";
  const count = Number.isFinite(Number(warning?.count)) ? Number(warning.count) : 0;
  return `性能来源告警 ${kind}/${homeId}: ${code} ×${count}`;
}

/** 编解码/自检失败。`code` 属于冻结小集合，`message` 只含列名与字面量，绝不含会话内容或路径。 */ export class PerfSampleCodecError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "PerfSampleCodecError";
    this.code = code;
  }
}

/**
 * 自检 `perf_samples` 的**实际** schema 是否等于冻结 DDL（列名/类型/可空性/主键 + 三个索引及其列序）。
 *
 * 为什么必须自检（本机实测，🟦）：`CREATE TABLE IF NOT EXISTS` 与 `CREATE INDEX IF NOT EXISTS`
 * 只按**名字**判断存在性 ——
 * ① 同名对象是 `VIEW` 时，建表语句**静默通过**（一个字段都没建）；
 * ② 同名索引挂在**别的表**上时，建索引语句也**静默通过**（索引根本没建到本表）；
 * ③ 形状不对的旧 `perf_samples` 更是原样留下。
 * 没有这道自检，"迁移成功"可能只是"什么都没建"，而 `user_version` 已经抬到 12（AN-6：数字
 * 看起来合理，provenance 是假的）。它是 `migrate()` 事务内的最后一步：不符即抛 ⇒ 回滚 ⇒ 版本不动。
 * @param {import("node:sqlite").DatabaseSync} database
 */
function assertPerfSamplesSchema(database) {
  const actualColumns = database.prepare("PRAGMA table_info(perf_samples)").all();
  if (actualColumns.length !== PERF_SAMPLE_FIELDS.length) {
    throw new PerfSampleCodecError(
      "PERF_SAMPLES_SCHEMA_MISMATCH",
      `perf_samples 列数 ${actualColumns.length} ≠ 冻结 ${PERF_SAMPLE_FIELDS.length}`,
    );
  }
  for (const [index, entry] of PERF_SAMPLE_FIELDS.entries()) {
    const row = actualColumns[index];
    const expectedType = entry.kind === "text" || entry.kind === "reasonChain" ? "TEXT" : "INTEGER";
    const actualType = String(row.type || "").toUpperCase();
    const pkMatches = Number(row.pk) === (entry.primaryKey ? 1 : 0);
    // STRICT 表的主键列隐含 NOT NULL（本机实测 `table_info` 报 notnull=1）。这里接受
    // "notnull=1" 与 "pk=1 的主键列 notnull=0" 两种报告，避免把 SQLite 的报告差异当成 schema 漂移；
    // "主键不可为 NULL"仍由 pk 位保证（实测：写 NULL 主键报 NOT NULL constraint failed）。
    const notNullMatches = Number(row.notnull) === (entry.notNull ? 1 : 0) || (entry.primaryKey === true && pkMatches);
    if (String(row.name) !== entry.column || actualType !== expectedType || !pkMatches || !notNullMatches) {
      throw new PerfSampleCodecError(
        "PERF_SAMPLES_SCHEMA_MISMATCH",
        `perf_samples 列 ${index} 实际 ${String(row.name)}/${actualType}/notnull=${Number(row.notnull)}/pk=${Number(row.pk)} ≠ 冻结 ${entry.column}/${expectedType}`,
      );
    }
  }
  const indexNames = new Set(
    database
      .prepare("PRAGMA index_list(perf_samples)")
      .all()
      .map((row) => String(row.name)),
  );
  for (const [name, columns] of PERF_SAMPLES_INDEXES) {
    if (!indexNames.has(name)) {
      throw new PerfSampleCodecError("PERF_SAMPLES_SCHEMA_MISMATCH", `perf_samples 缺少索引 ${name}`);
    }
    const actualColumnsOfIndex = database
      .prepare(`PRAGMA index_info(${name})`)
      .all()
      .map((row) => String(row.name));
    if (JSON.stringify(actualColumnsOfIndex) !== JSON.stringify(columns)) {
      throw new PerfSampleCodecError(
        "PERF_SAMPLES_SCHEMA_MISMATCH",
        `索引 ${name} 实际列 ${actualColumnsOfIndex.join(",")} ≠ 冻结 ${columns.join(",")}`,
      );
    }
  }
}

/** INSERT 列序与占位符都由映射表生成（不手写列名，也不可能与 SELECT 漂移）。 */
const PERF_SAMPLE_INSERT_SQL = `INSERT INTO perf_samples (${PERF_SAMPLE_FIELDS.map((entry) => entry.column).join(", ")}) VALUES (${PERF_SAMPLE_FIELDS.map(() => "?").join(", ")})`;

/** 全列 SELECT（**不用 `SELECT *`**：列序与映射表一致，才是可预测的解码输入）。 */
const PERF_SAMPLE_SELECT_SQL = `SELECT ${PERF_SAMPLE_FIELDS.map((entry) => entry.column).join(", ")} FROM perf_samples`;

/**
 * 归一化样本 → SQLite 行（键为 snake_case 列名，可直接绑定参数）。
 *
 * 校验是**有意的最后一道防线**：M3.2 必须在同一事务里写"已归一化"的样本，但调用点很容易误传
 * reader 的 raw 候选（它也有 `outputTokens` 之类的同名键，但值域不受 M1 保证）。这里的校验让
 * 误传**当场报错并指出字段名**，而不是把 `undefined` 交给驱动（实测驱动抛
 * `Provided value cannot be bound to SQLite parameter 1.`，不含字段名）或让 STRICT 的无损换算
 * 悄悄把 `"7"` 变成 7。
 *
 * 多出的键被忽略（不静默丢数据：`decode(encode(s))` 的逐字段往返测试会因 M1 新增字段而变红）。
 * @param {unknown} sample
 * @returns {Record<string, string | number | null>}
 */
export function encodePerfSample(sample) {
  if (sample === null || typeof sample !== "object") {
    throw new PerfSampleCodecError("INVALID_SAMPLE", "perf 样本必须是对象");
  }
  /** @type {Record<string, string | number | null>} */
  const row = {};
  for (const entry of PERF_SAMPLE_FIELDS) {
    const value = /** @type {Record<string, unknown>} */ (sample)[entry.field];
    if (value === undefined) {
      throw new PerfSampleCodecError("MISSING_FIELD", `perf 样本缺少字段 ${entry.field}（不得用 NULL 代替缺失字段）`);
    }
    if (entry.kind === "text") {
      if (typeof value !== "string") {
        throw new PerfSampleCodecError("INVALID_FIELD_TYPE", `${entry.field} 必须是字符串，收到 ${typeof value}`);
      }
      row[entry.column] = value;
    } else if (entry.kind === "integer") {
      if (value !== null && !Number.isSafeInteger(value)) {
        throw new PerfSampleCodecError("INVALID_FIELD_TYPE", `${entry.field} 必须是安全整数或 null`);
      }
      row[entry.column] = /** @type {number | null} */ (value);
    } else if (entry.kind === "flags") {
      if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0) {
        throw new PerfSampleCodecError("INVALID_FIELD_TYPE", `${entry.field} 必须是非负安全整数`);
      }
      row[entry.column] = /** @type {number} */ (value);
    } else {
      if (value === null) {
        row[entry.column] = null;
      } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
        row[entry.column] = JSON.stringify(value);
      } else {
        throw new PerfSampleCodecError("INVALID_FIELD_TYPE", `${entry.field} 必须是字符串数组或 null`);
      }
    }
  }
  return row;
}

/**
 * SQLite 行 → 归一化样本形状（`decode(encode(s))` 与 `s` 逐字段深等，含 `null`/`0` 与 `[]`/`null` 的区分）。
 *
 * 解码**不做归一化**：不补默认值、不把 `NULL` 折成 0、不把 `'[]'` 折成 `NULL`。读到不符合冻结
 * schema 的值时抛 {@link PerfSampleCodecError}（AN-6：宁可响亮失败，也不写出"看起来合理"的假值）。
 * @param {unknown} row
 * @returns {import("./usage-types.js").PerfSampleRowDecoded}
 */
export function decodePerfSample(row) {
  if (row === null || typeof row !== "object") {
    throw new PerfSampleCodecError("INVALID_ROW", "perf 行必须是对象");
  }
  /** @type {Record<string, unknown>} */
  const sample = {};
  for (const entry of PERF_SAMPLE_FIELDS) {
    const value = /** @type {Record<string, unknown>} */ (row)[entry.column];
    if (value === undefined) {
      throw new PerfSampleCodecError("MISSING_COLUMN", `perf 行缺少列 ${entry.column}`);
    }
    if (entry.kind === "reasonChain") {
      if (value === null) {
        sample[entry.field] = null;
        continue;
      }
      if (typeof value !== "string") {
        throw new PerfSampleCodecError("INVALID_REASON_CHAIN", `${entry.column} 必须是 JSON 数组文本或 NULL`);
      }
      /** @type {unknown} */
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new PerfSampleCodecError("INVALID_REASON_CHAIN", `${entry.column} 不是合法 JSON 文本`);
      }
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
        throw new PerfSampleCodecError("INVALID_REASON_CHAIN", `${entry.column} 不是字符串数组`);
      }
      sample[entry.field] = parsed;
      continue;
    }
    if (entry.kind === "text") {
      if (typeof value !== "string") {
        throw new PerfSampleCodecError("INVALID_COLUMN_TYPE", `${entry.column} 必须是字符串`);
      }
    } else if (entry.kind === "integer") {
      // 度量列**可空**：`NULL` 是"未知"、`0` 是"真实 0"（AO-3）。只有 flags 是 NOT NULL。
      if (value !== null && !Number.isSafeInteger(value)) {
        throw new PerfSampleCodecError("INVALID_COLUMN_TYPE", `${entry.column} 必须是安全整数或 NULL`);
      }
    } else if (!Number.isSafeInteger(value)) {
      throw new PerfSampleCodecError("INVALID_COLUMN_TYPE", `${entry.column} 必须是安全整数`);
    }
    sample[entry.field] = value;
  }
  return /** @type {import("./usage-types.js").PerfSampleRowDecoded} */ (sample);
}

function historyArchiveTimingVariantKey(payload) {
  const values = [
    payload.schema_version,
    payload.requested_model,
    payload.reported_output_tokens,
    payload.duration_ms,
    payload.status,
    payload.completed_at_ms,
  ];
  if (payload.schema_version === 2)
    values.push(payload.generation_json === null ? null : JSON.parse(payload.generation_json));
  return JSON.stringify(values);
}

function historyArchivePerfRevisionPayload(factTable, payload, sourceIdentity, segment) {
  if (factTable === "codex_output_measurements") {
    let key;
    try {
      key = JSON.parse(payload.sample_key);
    } catch {
      key = null;
    }
    const measurement = normalizeMeasuredOutput(payload.measurement);
    if (
      !hasExactObjectKeys(payload, ["sample_key", "source_path", "home_id", "measurement"]) ||
      canonicalPerfSourceKind(sourceIdentity.kind) !== "codex" ||
      payload.source_path !== sourceIdentity.path ||
      payload.home_id !== sourceIdentity.home_id ||
      !Array.isArray(key) ||
      key.length !== 5 ||
      key[0] !== "codex" ||
      key[1] !== payload.home_id ||
      key.some((part) => typeof part !== "string" || part === "") ||
      (payload.measurement !== null &&
        (!measurement ||
          !hasExactObjectKeys(payload.measurement, ["tokenizer", "outputTokens", "durationMs", "windows"]) ||
          payload.measurement.windows.some(
            (window) => !hasExactObjectKeys(window, ["startMs", "endMs", "outputTokens"]),
          )))
    )
      throw historyArchiveRevisionError(
        "archive native output measurement has invalid scalar evidence or source binding",
      );
    return { sample_key: payload.sample_key, source_path: payload.source_path, home_id: payload.home_id, measurement };
  }
  if (factTable === "perf_samples") {
    if (!hasExactObjectKeys(payload, PERF_SAMPLE_COLUMNS)) {
      throw historyArchiveRevisionError("archive perf revision payload must contain exactly the perf_samples columns");
    }
    try {
      decodePerfSample(payload);
    } catch (error) {
      throw historyArchiveRevisionError(`archive perf revision payload is invalid: ${error.message}`);
    }
    if (
      typeof payload.sample_key !== "string" ||
      payload.sample_key === "" ||
      payload.source_path !== sourceIdentity.path ||
      payload.source_kind !== canonicalPerfSourceKind(sourceIdentity.kind) ||
      payload.home_id !== sourceIdentity.home_id ||
      payload.source_kind === "" ||
      payload.home_id === "" ||
      !["main", "subagent", "unknown"].includes(payload.agent_kind) ||
      !["request_e2e", "item_span_estimate", "generation"].includes(payload.timing_kind) ||
      !["completed", "failed", "cancelled", "in_progress", "unverified"].includes(payload.status) ||
      !PERF_SUPPORTED_METHOD_VERSIONS.includes(payload.method_version) ||
      !Number.isSafeInteger(payload.ts_ms) ||
      payload.ts_ms < Number(segment.start_ms) ||
      payload.ts_ms >= Number(segment.end_ms)
    ) {
      throw historyArchiveRevisionError(
        `archive perf revision sample does not match segment ${segment.segment_id} and its source binding`,
      );
    }
    return Object.fromEntries(PERF_SAMPLE_COLUMNS.map((column) => [column, payload[column]]));
  }

  if (factTable === "perf_request_timing_evidence") {
    const columns = Object.hasOwn(payload, "generation_json")
      ? [...HISTORY_ARCHIVE_TIMING_EVIDENCE_COLUMNS, "generation_json"]
      : HISTORY_ARCHIVE_TIMING_EVIDENCE_COLUMNS;
    if (!hasExactObjectKeys(payload, columns)) {
      throw historyArchiveRevisionError(
        "archive timing revision payload must contain exactly the perf_request_timing_evidence columns",
      );
    }
    try {
      validateStoredEvidence(payload);
    } catch (error) {
      throw historyArchiveRevisionError(`archive timing revision payload is invalid: ${error.message}`);
    }
    const textColumns = ["home_id", "evidence_origin", "response_id", "variant_key", "requested_model", "status"];
    if (
      textColumns.some((column) => typeof payload[column] !== "string" || payload[column] === "") ||
      payload.home_id !== sourceIdentity.home_id ||
      ![1, 2].includes(payload.schema_version) ||
      !Number.isSafeInteger(payload.reported_output_tokens) ||
      payload.reported_output_tokens < 0 ||
      !Number.isSafeInteger(payload.duration_ms) ||
      payload.duration_ms <= 0 ||
      payload.status !== "completed" ||
      (payload.completed_at_ms !== null &&
        (!Number.isSafeInteger(payload.completed_at_ms) || payload.completed_at_ms < 0)) ||
      payload.variant_key !== historyArchiveTimingVariantKey(payload)
    ) {
      throw historyArchiveRevisionError("archive timing revision payload is invalid");
    }
    return Object.fromEntries(columns.map((column) => [column, payload[column]]));
  }

  throw historyArchiveRevisionError(`archive perf revision table ${String(factTable)} is unsupported`);
}

function canonicalHistoryArchivePerfRevisionDeltas(deltas) {
  return deltas
    .map(({ payload, count }) => ({ payload, count }))
    .sort((left, right) => {
      const leftKey = historyArchiveRevisionPayloadKey(left.payload);
      const rightKey = historyArchiveRevisionPayloadKey(right.payload);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : left.count - right.count;
    })
    .map((delta) => ({ payload: delta.payload, count: delta.count }));
}

function historyArchivePerfRevisions(rawValue, segmentsById, authorizedSegmentIds, perfSegmentIds) {
  if (rawValue === undefined) return new Map();
  let root;
  try {
    root = JSON.parse(String(rawValue));
  } catch {
    throw historyArchiveRevisionError("history archive perf revisions are not valid JSON");
  }
  if (!hasExactObjectKeys(root, ["formatVersion", "revisions"]) || root.formatVersion !== 1) {
    throw historyArchiveRevisionError("history archive perf revisions must be a version-1 revisions list");
  }
  if (!Array.isArray(root.revisions)) {
    throw historyArchiveRevisionError("history archive perf revisions must be an array");
  }

  const revisionsBySegment = new Map();
  const bindings = new Set();
  for (const revision of root.revisions) {
    if (
      !hasExactObjectKeys(revision, [
        "segmentId",
        "databaseSha256",
        "factTable",
        "sourceIdentity",
        "removed",
        "added",
      ]) ||
      typeof revision.segmentId !== "string" ||
      typeof revision.databaseSha256 !== "string" ||
      !HISTORY_ARCHIVE_PERF_REVISION_TABLES.includes(revision.factTable)
    ) {
      throw historyArchiveRevisionError("archive perf revision entry is malformed");
    }
    const segment = segmentsById.get(revision.segmentId);
    if (!segment) {
      throw historyArchiveRevisionError(`archive perf revision targets unregistered segment ${revision.segmentId}`);
    }
    if (
      revision.databaseSha256 !== segment.database_sha256 ||
      !authorizedSegmentIds.has(revision.segmentId) ||
      !perfSegmentIds.has(revision.segmentId)
    ) {
      throw historyArchiveRevisionError(`archive perf revision does not bind authorized segment ${revision.segmentId}`);
    }
    const sourceIdentity = revision.sourceIdentity;
    if (
      !hasExactObjectKeys(sourceIdentity, HISTORY_SOURCE_IDENTITY_COLUMNS) ||
      HISTORY_SOURCE_IDENTITY_COLUMNS.some((key) => typeof sourceIdentity[key] !== "string") ||
      sourceIdentity.path === ""
    ) {
      throw historyArchiveRevisionError(
        `archive perf revision source binding is malformed for segment ${segment.segment_id}`,
      );
    }
    const binding = JSON.stringify([
      revision.segmentId,
      revision.factTable,
      ...HISTORY_SOURCE_IDENTITY_COLUMNS.map((column) => sourceIdentity[column]),
    ]);
    if (bindings.has(binding)) {
      throw historyArchiveRevisionError(
        `archive perf revision duplicates segment-table-source binding ${revision.segmentId}:${revision.factTable}`,
      );
    }
    bindings.add(binding);

    const normalizeDeltas = (value, label) => {
      if (!Array.isArray(value)) {
        throw historyArchiveRevisionError(`archive perf revision ${label} must be an array`);
      }
      return value.map((delta) => {
        if (
          !hasExactObjectKeys(delta, ["payload", "count"]) ||
          !Number.isSafeInteger(delta.count) ||
          delta.count <= 0
        ) {
          throw historyArchiveRevisionError(`archive perf revision ${label} entries require a positive integer count`);
        }
        return {
          payload: historyArchivePerfRevisionPayload(revision.factTable, delta.payload, sourceIdentity, segment),
          count: delta.count,
        };
      });
    };
    const entry = {
      factTable: revision.factTable,
      sourceIdentity: { ...sourceIdentity },
      removed: canonicalHistoryArchivePerfRevisionDeltas(normalizeDeltas(revision.removed, "removed")),
      added: canonicalHistoryArchivePerfRevisionDeltas(normalizeDeltas(revision.added, "added")),
    };
    const entries = revisionsBySegment.get(revision.segmentId) || [];
    entries.push(entry);
    revisionsBySegment.set(revision.segmentId, entries);
  }
  return revisionsBySegment;
}

function applyHistoryArchivePerfRevisionDeltas(rows, revision, primaryKeyForRow, label) {
  const available = new Map();
  for (const row of rows) {
    const key = historyArchiveRevisionPayloadKey(row);
    available.set(key, (available.get(key) || 0) + 1);
  }
  for (const removed of revision.removed) {
    const key = historyArchiveRevisionPayloadKey(removed.payload);
    const count = available.get(key) || 0;
    if (removed.count > count) {
      throw historyArchiveRevisionError(`archive perf revision removes more ${label} rows than the segment contains`);
    }
    available.set(key, count - removed.count);
  }

  const remaining = new Map();
  for (const removed of revision.removed) {
    const key = historyArchiveRevisionPayloadKey(removed.payload);
    remaining.set(key, (remaining.get(key) || 0) + removed.count);
  }
  const next = [];
  for (const row of rows) {
    const key = historyArchiveRevisionPayloadKey(row);
    const count = remaining.get(key) || 0;
    if (count > 0) remaining.set(key, count - 1);
    else next.push(row);
  }

  const primaryKeys = new Set(next.map(primaryKeyForRow));
  for (const added of revision.added) {
    for (let index = 0; index < added.count; index += 1) {
      const primaryKey = primaryKeyForRow(added.payload);
      if (primaryKeys.has(primaryKey)) {
        throw historyArchiveRevisionError(`archive perf revision adds a duplicate ${label} primary key`);
      }
      primaryKeys.add(primaryKey);
      next.push(added.payload);
    }
  }
  return next;
}

function assertHistoryArchiveRevisionColumns(database, table, expectedColumns) {
  const actual = database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => String(row.name));
  if (JSON.stringify(actual) !== JSON.stringify(expectedColumns)) {
    throw historyArchiveRevisionError(`${table} columns do not match the archive revision contract`);
  }
}

function linkedPerfRequestTimingEvidence(database, sampleKey) {
  const columns = historyArchiveTimingEvidenceColumns(database);
  return database
    .prepare(
      `SELECT DISTINCT ${columns.map((column) => `evidence.${column}`).join(", ")}
       FROM perf_sample_sources AS dependencies
       JOIN perf_rollout_threads AS owners ON owners.source_path = dependencies.source_path
       JOIN perf_request_timing_threads AS timing
         ON timing.home_id = owners.home_id AND timing.thread_id = owners.thread_id
       JOIN perf_request_timing_evidence AS evidence
         ON evidence.home_id = timing.home_id AND evidence.response_id = timing.response_id
       WHERE dependencies.sample_key = ?
       ORDER BY ${columns.map((column) => `evidence.${column}`).join(", ")}`,
    )
    .all(String(sampleKey))
    .map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
}

function assertHistoryArchiveEffectiveTimingEvidence(database, samples, evidence) {
  const required = samples.filter(
    (sample) =>
      sample.source_kind === "codex" &&
      sample.method_version !== PERF_METHOD_VERSION &&
      sample.status === "completed" &&
      ["request_e2e", "generation"].includes(sample.timing_kind) &&
      sample.timing_source === "explicit",
  );
  if (required.length === 0) return;

  const evidenceKeys = new Set(evidence.map((row) => JSON.stringify([String(row.home_id), String(row.response_id)])));
  const linked = database.prepare(
    `SELECT owners.home_id, timing.response_id
     FROM perf_sample_sources AS dependencies
     JOIN perf_rollout_threads AS owners ON owners.source_path = dependencies.source_path
     JOIN perf_request_timing_threads AS timing
       ON timing.home_id = owners.home_id AND timing.thread_id = owners.thread_id
     WHERE dependencies.sample_key = ?`,
  );
  for (const sample of required) {
    const sampleKey = String(sample.sample_key);
    const responseId = isGenerationPerfMethod(sample.method_version) ? JSON.parse(sampleKey)[4] : null;
    const links = linked.all(sampleKey).filter((link) => responseId === null || link.response_id === responseId);
    if (
      links.length === 0 ||
      links.some((link) => !evidenceKeys.has(JSON.stringify([String(link.home_id), String(link.response_id)])))
    ) {
      throw historyArchiveRevisionError(
        `archive perf revision left explicit Codex sample ${sampleKey} without native request-timing evidence`,
      );
    }
  }
}

function historyArchiveNativeMeasurementRow(sample, measurement) {
  return { sample_key: sample.sample_key, source_path: sample.source_path, home_id: sample.home_id, measurement };
}

function applyHistoryArchivePerfRevisions(database, segment, samples, revisions = [], nativeMeasurements = new Map()) {
  const timingColumns = historyArchiveTimingEvidenceColumns(database);
  if (revisions.length === 0) {
    return { samples: samples.map(decodePerfSample), revisionsBySampleKey: new Map() };
  }

  let effectiveSamples = samples;
  let effectiveTimingEvidence;
  let nativeRows = samples
    .filter((sample) => nativeMeasurements.has(String(sample.sample_key)))
    .map((sample) => historyArchiveNativeMeasurementRow(sample, nativeMeasurements.get(String(sample.sample_key))));
  const originalSamplesByKey = new Map(samples.map((sample) => [String(sample.sample_key), sample]));
  const revisionsBySampleKey = new Map();
  for (const revision of revisions) {
    const storedIdentity = database
      .prepare("SELECT path, kind, home_id, home_label, home_path FROM source_files WHERE path = ?")
      .get(revision.sourceIdentity.path);
    if (!storedIdentity || !sameHistoryArchiveSourceIdentity(storedIdentity, revision.sourceIdentity)) {
      throw historyArchiveRevisionError(
        `archive perf revision source binding does not match segment ${segment.segment_id}`,
      );
    }

    if (revision.factTable === "perf_samples") {
      for (const removed of revision.removed) {
        const sampleKey = String(removed.payload.sample_key);
        const state = revisionsBySampleKey.get(sampleKey) || { removedPayloads: new Set() };
        state.removedPayloads.add(historyArchivePerfSamplePayloadKey(decodePerfSample(removed.payload)));
        revisionsBySampleKey.set(sampleKey, state);
      }
      for (const added of revision.added) {
        const sampleKey = String(added.payload.sample_key);
        if (!revisionsBySampleKey.has(sampleKey)) {
          revisionsBySampleKey.set(sampleKey, { removedPayloads: new Set() });
        }
      }
      for (const added of revision.added) {
        if (!originalSamplesByKey.has(String(added.payload.sample_key))) {
          throw historyArchiveRevisionError(
            "archive perf revisions cannot add a sample without an existing dependency graph",
          );
        }
      }
      effectiveSamples = applyHistoryArchivePerfRevisionDeltas(
        effectiveSamples,
        revision,
        (row) => String(row.sample_key),
        "perf sample",
      );
      continue;
    }

    if (revision.factTable === "codex_output_measurements") {
      for (const delta of [...revision.removed, ...revision.added]) {
        const sample = originalSamplesByKey.get(delta.payload.sample_key);
        if (
          sample?.source_kind !== "codex" ||
          sample.home_id !== delta.payload.home_id ||
          sample.source_path !== delta.payload.source_path
        ) {
          throw historyArchiveRevisionError("archive native measurement has no matching immutable sample owner");
        }
      }
      nativeRows = applyHistoryArchivePerfRevisionDeltas(
        nativeRows,
        revision,
        (row) => row.sample_key,
        "native measurement",
      );
      continue;
    }

    assertHistoryArchiveRevisionColumns(database, "perf_request_timing_evidence", timingColumns);
    const linked = database.prepare(
      `SELECT 1 AS present
       FROM perf_request_timing_threads AS timing
       JOIN perf_rollout_threads AS owners
         ON owners.home_id = timing.home_id AND owners.thread_id = timing.thread_id
       WHERE owners.source_path = ? AND timing.home_id = ? AND timing.response_id = ?
       LIMIT 1`,
    );
    for (const delta of [...revision.removed, ...revision.added]) {
      if (!linked.get(revision.sourceIdentity.path, delta.payload.home_id, delta.payload.response_id)) {
        throw historyArchiveRevisionError(
          "archive timing revision evidence is not reachable through its owner's existing response link",
        );
      }
    }
    effectiveTimingEvidence ??= database
      .prepare(
        `SELECT ${timingColumns.join(", ")}
         FROM perf_request_timing_evidence
         ORDER BY home_id, evidence_origin, response_id, variant_key`,
      )
      .all()
      .map((row) => Object.fromEntries(timingColumns.map((column) => [column, row[column]])));
    effectiveTimingEvidence = applyHistoryArchivePerfRevisionDeltas(
      effectiveTimingEvidence,
      revision,
      (row) => JSON.stringify([row.home_id, row.evidence_origin, row.response_id, row.variant_key]),
      "timing evidence",
    );
  }
  effectiveTimingEvidence ??= database
    .prepare(
      `SELECT ${timingColumns.join(", ")}
       FROM perf_request_timing_evidence
       ORDER BY home_id, evidence_origin, response_id, variant_key`,
    )
    .all()
    .map((row) => Object.fromEntries(timingColumns.map((column) => [column, row[column]])));
  assertHistoryArchiveEffectiveTimingEvidence(database, effectiveSamples, effectiveTimingEvidence);
  return {
    samples: effectiveSamples.map(decodePerfSample),
    rawSamples: effectiveSamples,
    timingEvidence: effectiveTimingEvidence,
    nativeMeasurements: new Map(nativeRows.map((row) => [row.sample_key, row.measurement])),
    revisionsBySampleKey,
  };
}

function historyArchivePerfRevisionBindingKey(revision) {
  return JSON.stringify([
    revision.segmentId,
    revision.factTable,
    ...HISTORY_SOURCE_IDENTITY_COLUMNS.map((column) => revision.sourceIdentity[column]),
  ]);
}

function historyArchivePerfRevisionInputVersion(database) {
  return {
    dataVersion: Number(database.prepare("PRAGMA data_version").get().data_version),
    totalChanges: Number(database.prepare("SELECT total_changes() AS value").get().value),
  };
}

function historyArchivePerfRevisionChangesForSamples(database, candidatesBySampleKey, sampleKeys, nativeMeasurements) {
  const changes = new Map();
  const selectSample = database.prepare("SELECT * FROM perf_samples WHERE sample_key = ?");
  const selectSource = database.prepare(
    "SELECT path, kind, home_id, home_label, home_path FROM source_files WHERE path = ?",
  );
  const addDelta = (revision, side, payload, factTable) => {
    const validated = historyArchivePerfRevisionPayload(factTable, payload, revision.sourceIdentity, revision.segment);
    const deltas = revision[side];
    const key = historyArchiveRevisionPayloadKey(validated);
    if (!deltas.has(key)) deltas.set(key, { payload: validated, count: 1 });
  };
  const revisionFor = (candidate, factTable) => {
    const draft = {
      segmentId: candidate.segmentId,
      databaseSha256: candidate.databaseSha256,
      factTable,
      sourceIdentity: candidate.sourceIdentity,
      segment: candidate.segment,
      removed: new Map(),
      added: new Map(),
    };
    const key = historyArchivePerfRevisionBindingKey(draft);
    const existing = changes.get(key);
    if (existing) return existing;
    changes.set(key, draft);
    return draft;
  };

  for (const sampleKey of sampleKeys) {
    const candidate = candidatesBySampleKey.get(String(sampleKey));
    if (!candidate) continue;
    const current = selectSample.get(String(sampleKey));
    if (!current) continue;
    const source = selectSource.get(String(candidate.sample.sourcePath));
    if (!source || !sameHistoryArchiveSourceIdentity(source, candidate.sourceIdentity)) {
      throw historyArchiveRevisionError(
        `archive perf revision source ${candidate.sample.sourcePath} no longer matches the immutable candidate`,
      );
    }
    if (String(current.source_path) !== String(candidate.sample.sourcePath)) {
      throw historyArchiveRevisionError(`archive perf revision cannot move cold sample ${sampleKey} to another source`);
    }
    const currentSample = decodePerfSample(current);
    const sampleRevision = revisionFor(candidate, "perf_samples");
    if (historyArchivePerfSamplePayloadKey(currentSample) !== historyArchivePerfSamplePayloadKey(candidate.sample)) {
      addDelta(sampleRevision, "removed", encodePerfSample(candidate.sample), "perf_samples");
      addDelta(sampleRevision, "added", { ...current }, "perf_samples");
    }

    if (current.method_version === PERF_METHOD_VERSION || candidate.sample.methodVersion === PERF_METHOD_VERSION) {
      const nativeRevision = revisionFor(candidate, "codex_output_measurements");
      const previous = candidate.nativeMeasurement;
      const next = nativeMeasurements.get(String(sampleKey));
      if (
        JSON.stringify(previous ?? null) !== JSON.stringify(next ?? null) ||
        (previous === undefined) !== (next === undefined)
      ) {
        if (previous !== undefined)
          addDelta(
            nativeRevision,
            "removed",
            historyArchiveNativeMeasurementRow(encodePerfSample(candidate.sample), previous),
            "codex_output_measurements",
          );
        if (next !== undefined)
          addDelta(
            nativeRevision,
            "added",
            historyArchiveNativeMeasurementRow(current, next),
            "codex_output_measurements",
          );
      }
    }

    const timingRevision = revisionFor(candidate, "perf_request_timing_evidence");
    const candidateEvidence = new Map(
      candidate.timingEvidence.map((row) => [
        JSON.stringify([row.home_id, row.evidence_origin, row.response_id, row.variant_key]),
        row,
      ]),
    );
    const currentEvidence = new Map(
      linkedPerfRequestTimingEvidence(database, sampleKey).map((row) => [
        JSON.stringify([row.home_id, row.evidence_origin, row.response_id, row.variant_key]),
        row,
      ]),
    );
    for (const [key, row] of candidateEvidence) {
      if (!currentEvidence.has(key)) addDelta(timingRevision, "removed", row, "perf_request_timing_evidence");
    }
    for (const [key, row] of currentEvidence) {
      if (!candidateEvidence.has(key)) addDelta(timingRevision, "added", row, "perf_request_timing_evidence");
    }
  }

  for (const [key, revision] of changes) {
    const removed = canonicalHistoryArchivePerfRevisionDeltas([...revision.removed.values()]);
    const added = canonicalHistoryArchivePerfRevisionDeltas([...revision.added.values()]);
    changes.set(key, { ...revision, removed, added });
  }
  return changes;
}

function writeHistoryArchivePerfRevisionChanges(database, changes) {
  if (changes.size === 0) return;
  const revisionSegmentsById = new Map(
    database
      .prepare(
        `SELECT segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms
         FROM archive_segments`,
      )
      .all()
      .map((segment) => [String(segment.segment_id), { ...segment }]),
  );
  const authorizedSegmentIds = historyArchiveAuthorizedSegmentIds(database);
  const perfAuthority = historyArchivePerfAuthority(database, authorizedSegmentIds, revisionSegmentsById);
  const perfSegmentIds = new Set((perfAuthority || []).map((entry) => String(entry.segmentId)));
  const rawValue = database
    .prepare("SELECT value FROM store_meta WHERE key = ?")
    .get(HISTORY_ARCHIVE_PERF_REVISIONS_META)?.value;
  const revisionsBySegment = historyArchivePerfRevisions(
    rawValue,
    revisionSegmentsById,
    authorizedSegmentIds,
    perfSegmentIds,
  );

  for (const [segmentId, entries] of revisionsBySegment) {
    revisionsBySegment.set(
      segmentId,
      entries.filter((entry) => !changes.has(historyArchivePerfRevisionBindingKey({ segmentId, ...entry }))),
    );
  }
  for (const revision of changes.values()) {
    if (revision.removed.length === 0 && revision.added.length === 0) continue;
    const entries = revisionsBySegment.get(revision.segmentId) || [];
    entries.push({
      factTable: revision.factTable,
      sourceIdentity: { ...revision.sourceIdentity },
      removed: revision.removed,
      added: revision.added,
    });
    revisionsBySegment.set(revision.segmentId, entries);
  }

  const revisions = [];
  for (const [segmentId, entries] of revisionsBySegment) {
    const segment = revisionSegmentsById.get(segmentId);
    for (const entry of entries) {
      revisions.push({
        segmentId,
        databaseSha256: String(segment.database_sha256),
        factTable: entry.factTable,
        sourceIdentity: { ...entry.sourceIdentity },
        removed: entry.removed,
        added: entry.added,
      });
    }
  }
  revisions.sort((left, right) => {
    const leftKey = historyArchivePerfRevisionBindingKey(left);
    const rightKey = historyArchivePerfRevisionBindingKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const value = JSON.stringify({ formatVersion: 1, revisions });
  const statement = database.prepare(
    `INSERT INTO store_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  if (revisions.length === 0) {
    database.prepare("DELETE FROM store_meta WHERE key = ?").run(HISTORY_ARCHIVE_PERF_REVISIONS_META);
  } else if (value !== rawValue) {
    statement.run(HISTORY_ARCHIVE_PERF_REVISIONS_META, value);
  }
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localHourKey(date) {
  const hour = String(date.getHours()).padStart(2, "0");
  return `${localDateKey(date)} ${hour}:00`;
}

function startOfLocalWeek(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return start;
}

/** @returns {import("./usage-types.js").UsageTotals} */
function usageFromRow(row) {
  const values = row || {};
  return {
    total: Number(values.total || 0),
    input: Number(values.input || 0),
    cached: Number(values.cached || 0),
    output: Number(values.output || 0),
    reasoning: Number(values.reasoning || 0),
  };
}

const COST_EVENT_COLUMNS =
  "timestamp_ms, session_id, home_id, home_label, source_path, channel, model, project, detail_mask, cache_write_tokens, cache_write_known, request_input_tokens, context_level, service_tier, price_version, total, input, cached, output, reasoning";

/** @returns {import("./usage-types.js").IndexedCostEvent} */
function costEventFromRow(row, tierEvidence, sourceKind) {
  const timestamp = Number(row.timestamp_ms);
  const sessionId = String(row.session_id);
  return {
    timestamp,
    sessionId,
    homeId: String(row.home_id),
    homeLabel: String(row.home_label),
    sourcePath: String(row.source_path),
    sourceKind,
    channel: String(row.channel),
    model: String(row.model),
    project: String(row.project),
    detailMask: Number(row.detail_mask || 0),
    cacheWriteTokens: Number(row.cache_write_tokens || 0),
    cacheWriteKnown: Boolean(row.cache_write_known),
    requestInputTokens: Number(row.request_input_tokens || 0),
    contextLevel: String(row.context_level),
    serviceTier: tierEvidence?.resolve(sessionId, timestamp, String(row.service_tier)) || String(row.service_tier),
    priceVersion: String(row.price_version),
    total: usageFromRow(row),
  };
}

/** @returns {import("./usage-types.js").IndexedCostEvent} */
function costEventFromRowArray(row, tierEvidence, sourceKind) {
  const timestamp = Number(row[0]);
  const sessionId = String(row[1]);
  return {
    timestamp,
    sessionId,
    homeId: String(row[2]),
    homeLabel: String(row[3]),
    sourcePath: String(row[4]),
    sourceKind,
    channel: String(row[5]),
    model: String(row[6]),
    project: String(row[7]),
    detailMask: Number(row[8] || 0),
    cacheWriteTokens: Number(row[9] || 0),
    cacheWriteKnown: Boolean(row[10]),
    requestInputTokens: Number(row[11] || 0),
    contextLevel: String(row[12]),
    serviceTier: tierEvidence?.resolve(sessionId, timestamp, String(row[13])) || String(row[13]),
    priceVersion: String(row[14]),
    total: {
      total: Number(row[15] || 0),
      input: Number(row[16] || 0),
      cached: Number(row[17] || 0),
      output: Number(row[18] || 0),
      reasoning: Number(row[19] || 0),
    },
  };
}

function createFusedSummaryGroups(sourceKindsByPath, modelNameFor) {
  const groupsByDimension = {
    channels: new Map(),
    models: new Map(),
    homes: new Map(),
    projects: new Map(),
  };
  const add = (groups, key, event) => {
    const name = String(key);
    const group = groups.get(name) || {
      key: name,
      name,
      count: 0,
      sessions: new Set(),
      total: { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 },
    };
    group.count += 1;
    group.sessions.add(event.sessionId);
    group.total.total += event.total.total;
    group.total.input += event.total.input;
    group.total.cached += event.total.cached;
    group.total.output += event.total.output;
    group.total.reasoning += event.total.reasoning;
    groups.set(name, group);
  };
  const materialize = (groups) => {
    const rows = [...groups.values()]
      .map(({ key, name, count, sessions, total }) => ({
        key,
        name,
        count,
        sessions: sessions.size,
        total,
      }))
      .sort((left, right) => right.total.total - left.total.total);
    // SQLite owns tie order, including UTF-8 BINARY collation, so tied dimensions use the old SQL path.
    return rows.some((row, index) => index > 0 && row.total.total === rows[index - 1].total.total) ? null : rows;
  };
  return {
    add(event) {
      add(groupsByDimension.channels, sourceGroup(event.channel, sourceKindsByPath.get(event.sourcePath) ?? ""), event);
      add(groupsByDimension.models, modelNameFor(event.model), event);
      add(groupsByDimension.homes, event.homeLabel, event);
      add(groupsByDimension.projects, event.project, event);
    },
    result() {
      return {
        channels: materialize(groupsByDimension.channels),
        models: materialize(groupsByDimension.models),
        homes: materialize(groupsByDimension.homes),
        projects: materialize(groupsByDimension.projects),
      };
    },
  };
}

function compareSqliteText(left, right) {
  return left === right ? 0 : Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function createFusedMetadataObservations() {
  const channels = new Map();
  return {
    add(event) {
      let models = channels.get(event.channel);
      if (!models) {
        models = new Map();
        channels.set(event.channel, models);
      }
      let homes = models.get(event.model);
      if (!homes) {
        homes = new Map();
        models.set(event.model, homes);
      }
      homes.set(event.homeId, Math.max(homes.get(event.homeId) ?? -Infinity, event.timestamp));
    },
    result() {
      const rows = [];
      for (const [channel, models] of channels) {
        for (const [model, homes] of models) {
          for (const [home_id, last_seen] of homes) rows.push({ channel, model, home_id, last_seen });
        }
      }
      rows.sort(
        (a, b) =>
          compareSqliteText(a.channel, b.channel) ||
          compareSqliteText(a.model, b.model) ||
          compareSqliteText(a.home_id, b.home_id),
      );
      return rows;
    },
  };
}

function createFusedSummaryRepositories(periodRanges) {
  const groups = new Map();
  const windows = Object.entries(periodRanges).map(([key, range]) => [
    key,
    range.start?.getTime() ?? -Infinity,
    range.end?.getTime() ?? Infinity,
  ]);
  let safe = true;
  return {
    add(event) {
      const key = event.repositoryKey;
      const group = groups.get(key) || {
        key,
        name: event.repositoryPath,
        kind: event.repositoryKind,
        minimumKind: event.repositoryKind,
        paths: new Set(),
        firsts: new Map(),
        count: 0,
        magnitude: 0,
        periods: Object.fromEntries(COMPARISON_PERIOD_KEYS.map((key) => [key, emptyPeriodMetrics()])),
        total: { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 },
      };
      if (compareSqliteText(event.repositoryPath, group.name) < 0) group.name = event.repositoryPath;
      if (compareSqliteText(event.repositoryKind, group.kind) > 0) group.kind = event.repositoryKind;
      if (compareSqliteText(event.repositoryKind, group.minimumKind) < 0) group.minimumKind = event.repositoryKind;
      if (event.cwd) group.paths.add(event.cwd);
      const first = group.firsts.get(event.sessionId);
      if (first === undefined || event.timestamp < first) group.firsts.set(event.sessionId, event.timestamp);
      group.count += 1;
      group.total.total += event.total.total;
      group.total.input += event.total.input;
      group.total.cached += event.total.cached;
      group.total.output += event.total.output;
      group.total.reasoning += event.total.reasoning;
      // Bound every subset metric too, so cancellation cannot hide an unsafe intermediate sum.
      group.magnitude +=
        Math.abs(event.total.total) +
        Math.abs(event.total.input) +
        Math.abs(event.total.cached) +
        Math.abs(event.total.output) +
        Math.abs(event.total.reasoning) +
        Math.abs(event.reconciliationGap || 0);
      safe &&= Number.isSafeInteger(group.magnitude);
      if (safe) {
        for (const [key, start, end] of windows) {
          if (event.timestamp >= start && event.timestamp <= end) addPeriodEvent(group.periods[key], event);
        }
      }
      groups.set(key, group);
    },
    result() {
      if (!safe) return null;
      const rows = [];
      const firsts = [];
      for (const { key, name, kind, paths, firsts: sessions, count, total } of groups.values()) {
        rows.push({ key, name, kind, pathCount: paths.size, count, sessions: sessions.size, total });
        for (const [session_id, first_ms] of sessions) firsts.push({ repository_key: key, session_id, first_ms });
      }
      rows.sort(
        (a, b) => b.total.total - a.total.total || compareSqliteText(a.name, b.name) || compareSqliteText(a.key, b.key),
      );
      firsts.sort((a, b) => compareSqliteText(a.repository_key, b.repository_key) || a.first_ms - b.first_ms);
      const periodRepositories = rows.map(({ key, name, pathCount }) => {
        const group = groups.get(key);
        return { key, name, kind: group.minimumKind, pathCount, periods: group.periods };
      });
      return { rows, firsts, periodRepositories };
    },
  };
}

function periodComparisonKey(now, zone, excludeHomes, pricingModels) {
  const modelKeys = Object.keys(pricingModels).sort().join("\u0000");
  return `${modelKeys}|${zone}|${zone === "utc" ? now.toISOString().slice(0, 10) : localDateKey(now)}|${[...excludeHomes].map(String).sort().join(",")}`;
}

function rangeParameters(range) {
  const start = range.start ? range.start.getTime() : null;
  const end = range.end ? range.end.getTime() : null;
  return [start, start, end, end];
}

function completeRollupDays(range) {
  const zone = range?.calendarZone;
  if (
    (zone !== "utc" && zone !== "local") ||
    isQuotaPreset(range?.preset) ||
    range?.quotaWindow ||
    range?.quotaPreset ||
    !(range?.start instanceof Date) ||
    !(range?.end instanceof Date)
  ) {
    return null;
  }
  const startMs = range.start.getTime();
  const endMs = range.end.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  if (zone === "utc") {
    const dayMs = 86_400_000;
    const endExclusiveMs = endMs + 1;
    if (startMs % dayMs !== 0 || endExclusiveMs % dayMs !== 0) return null;
    return {
      calendarZone: zone,
      startDay: new Date(startMs).toISOString().slice(0, 10),
      endDay: new Date(endExclusiveMs - 1).toISOString().slice(0, 10),
    };
  }
  const start = new Date(startMs);
  const end = new Date(endMs);
  const localMidnight = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const nextLocalMidnight = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
  if (localMidnight.getTime() !== startMs || nextLocalMidnight.getTime() - 1 !== endMs) return null;
  return {
    calendarZone: zone,
    startDay: localDateKey(start),
    endDay: localDateKey(end),
  };
}

function readMetadataUsageCounts(database, completeBounds = null) {
  database.exec("SAVEPOINT metadata_usage_counts_read");
  try {
    const hasAuthority = Boolean(
      database.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META),
    );
    const bounds =
      completeBounds ??
      (hasAuthority
        ? { minimum: null, maximum: null }
        : database.prepare("SELECT MIN(timestamp_ms) AS minimum, MAX(timestamp_ms) AS maximum FROM events").get());
    if ((!hasAuthority || completeBounds) && bounds.minimum !== null && bounds.maximum !== null) {
      const startDay = new Date(Number(bounds.minimum)).toISOString().slice(0, 10);
      const endDay = new Date(Number(bounds.maximum)).toISOString().slice(0, 10);
      try {
        const complete = queryUsageRollupsRange(database, {
          startDay,
          endDay,
          calendarZone: "utc",
          includeHomeCounts: true,
        });
        return {
          eventCount: complete.eventCount,
          sessionCount: complete.sessionCount,
          homeRows: new Map(
            (complete.homeCounts ?? []).map((row) => [
              row.homeId,
              { event_count: row.eventCount, session_count: row.sessionCount },
            ]),
          ),
        };
      } catch (error) {
        if (error?.code !== "ROLLUP_DAYS_MISSING") throw error;
      }
    }
    const totals = database
      .prepare("SELECT COUNT(*) AS event_count, COUNT(DISTINCT session_id) AS session_count FROM events")
      .get();
    const homeRows = new Map(
      database
        .prepare(`
          SELECT home_id, COUNT(*) AS event_count, COUNT(DISTINCT session_id) AS session_count
          FROM events GROUP BY home_id
        `)
        .all()
        .map((row) => [row.home_id, row]),
    );
    return {
      eventCount: Number(totals.event_count || 0),
      sessionCount: Number(totals.session_count || 0),
      homeRows,
    };
  } catch (error) {
    database.exec("ROLLBACK TO metadata_usage_counts_read");
    throw error;
  } finally {
    database.exec("RELEASE metadata_usage_counts_read");
  }
}

/**
 * M3.3：单个范围边界 → 毫秒数。**与 M1 `perfRangeBoundMs`（`src/perf-stats.js:1410`）同规则**：
 * `null`/`undefined` ⇒ `null`（无界）；`Date` ⇒ `getTime()`；有限数字 ⇒ 原值；
 * 其余（`NaN`、Invalid Date、字符串、对象）⇒ 抛 `TypeError`。
 *
 * 为什么必须抛而不是当成无界：`ts < NaN` 恒为 `false`，静默接受非法边界会**悄悄取消失效的前提**，
 * 让"范围内"变成一个没人检查过的更大集合。
 * @param {unknown} value
 * @returns {number | null}
 */
function perfRangeBoundMs(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    if (!Number.isFinite(time)) {
      throw new TypeError("perf range bounds must be finite millisecond numbers or Dates");
    }
    return time;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new TypeError("perf range bounds must be finite millisecond numbers or Dates");
}

/**
 * M3.3：把范围对象规范化成三个毫秒边界。
 *
 * **只认 M1 的键名** `{ startMs, endMs, windowEndExclusiveMs }`（值可为数字或 `Date`）。
 * 这是刻意的、而非疏漏：
 *
 * 🟩 实测（M3.3 探针）：`selectPerfSamples` **只读这三个键名**。若把 `usage-core` 的配额形状
 * `{ start, end, windowEndExclusive }` 原样交给 M1，三个绑定全部落成 `undefined` ⇒
 * `perfRangeBoundMs(undefined)` 返回 `null` ⇒ **M1 把它当成无界范围**，静默放行全部样本。
 *
 * 因此本方法**不得**为了"兼容"而额外识别 `start`/`end`/`windowEndExclusive`：那会让 SQL 路径
 * 带边界、而 M1 路径无界，两条路径给出**不同的集合** —— 恰是本卡最难发现的失败模式。
 * `M4-summary-and-api.md:13` 要求 SQLite 与内存两端 `summary.perf` 的计数完全相同，
 * 这只有在两端收到**同一个范围的同一份表达**时才能成立。
 *
 * 于是：范围一律由调用方（M4）解析成 `{ startMs, endMs, windowEndExclusiveMs }` 后**同时**喂给
 * 两条路径。传入 `usage-core` 的原始形状会被显式拒绝（见下），以免"看起来能用"。
 * @param {any} range
 */
function perfRangeBounds(range) {
  if (range === null || range === undefined) {
    return { startMs: null, endMs: null, windowEndExclusiveMs: null };
  }
  if (typeof range !== "object" || range instanceof Date) {
    throw new TypeError("perf range must be an object with startMs/endMs/windowEndExclusiveMs");
  }
  // 拒绝 usage-core 的原始配额形状：它带 start/end/windowEndExclusive 却没有 M1 的键名。
  // 静默接受会让 SQL 有界、M1 无界（实测成因见上），因此这里必须**响亮地**失败。
  const looksLikeRawQuotaRange =
    range.startMs === undefined &&
    range.endMs === undefined &&
    range.windowEndExclusiveMs === undefined &&
    (range.start !== undefined || range.end !== undefined || range.windowEndExclusive !== undefined);
  if (looksLikeRawQuotaRange) {
    throw new TypeError(
      "perf range must use M1 keys (startMs/endMs/windowEndExclusiveMs); " +
        "convert the usage-core range first so both paths share one expression",
    );
  }
  return {
    startMs: perfRangeBoundMs(range.startMs),
    endMs: perfRangeBoundMs(range.endMs),
    windowEndExclusiveMs: perfRangeBoundMs(range.windowEndExclusiveMs),
  };
}

/**
 * M3.3：规范化排除列表。空白字符串**不算**有效排除项（与 M1 的 trim 规则一致），
 * 否则 `[""]` 会让 `home_id <> ''` 意外排掉所有 home。
 * @param {Iterable<unknown> | string | null | undefined} raw
 * @returns {string[]}
 */
function normalizeExcludedHomeIds(raw) {
  if (raw === null || raw === undefined) return [];
  if (typeof raw === "string" || typeof raw[Symbol.iterator] !== "function") {
    throw new TypeError("excludedHomeIds must be an array or Set of home ids");
  }
  const seen = new Set();
  for (const entry of raw) {
    if (typeof entry === "string" && entry.trim() !== "") seen.add(entry.trim());
  }
  return [...seen];
}

function eventRangeFilter(range) {
  if (!isQuotaPreset(range?.preset) && !range?.quotaWindow && !range?.quotaPreset) {
    return {
      sql: "(? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?)",
      params: rangeParameters(range),
    };
  }
  const predicates = ["usage_quota_allowed(model, home_id, session_id, timestamp_ms) = 1"];
  const params = [];
  if (range.start) {
    predicates.push("timestamp_ms >= ?");
    params.push(range.start.getTime());
  }
  if (range.end) {
    predicates.push("timestamp_ms <= ?");
    params.push(range.end.getTime());
  }
  return { sql: predicates.length ? predicates.join(" AND ") : "1 = 1", params };
}

function eventRangeScope(range, scope) {
  const filter = eventRangeFilter(range);
  return {
    sql: withScope(filter.sql, scope),
    params: [...filter.params, ...scope.params],
  };
}

function scopeFilterSql(excludeHomes = []) {
  const ids = (excludeHomes || []).map((value) => String(value)).filter(Boolean);
  if (!ids.length) {
    return { sql: "", params: [] };
  }
  return { sql: `home_id NOT IN (${ids.map(() => "?").join(", ")})`, params: ids };
}

// New Record 系统的指标定义：sum 系按周期求和求最大，ratio 按命中率最大，
// count 按去重数量最大；cost 系按汇率折算后的可比金额最大。
const RECORD_METRICS = Object.freeze({
  totalTokens: { kind: "sum", field: "total", title: "总 tokens 最高" },
  inputTokens: { kind: "sum", field: "input", title: "总输入最高" },
  cachedTokens: { kind: "sum", field: "cached", title: "缓存读取最高" },
  outputTokens: { kind: "sum", field: "output", title: "输出最高" },
  reasoningTokens: { kind: "sum", field: "reasoning", title: "推理输出最高" },
  sessionCount: { kind: "count", field: "sessions", title: "会话最多" },
  modelCount: { kind: "count", field: "models", title: "模型数量最多" },
  cacheHitRate: { kind: "ratio", title: "缓存命中最高" },
  totalCost: { kind: "cost", field: "total", title: "估算花销最高" },
  inputCost: { kind: "cost", field: "input", title: "缓外输入花销最高" },
  cachedCost: { kind: "cost", field: "cached", title: "缓存输入花销最高" },
  outputCost: { kind: "cost", field: "output", title: "输出花销最高" },
});

const RECORD_UNIT_LABELS = Object.freeze({ day: "一日", week: "一周", month: "一个月" });

function emptyRecordPeriods() {
  return { day: new Map(), week: new Map(), month: new Map() };
}

function recordPeriodKeys(timestampMs, zone, storedKeys = null) {
  const date = new Date(timestampMs);
  if (zone === "utc") {
    const day = date.toISOString().slice(0, 10);
    const week = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((date.getUTCDay() || 7) - 1)),
    )
      .toISOString()
      .slice(0, 10);
    return { day, week, month: day.slice(0, 7) };
  }
  if (storedKeys) {
    return {
      day: String(storedKeys.day || ""),
      week: String(storedKeys.week || ""),
      month: String(storedKeys.month || ""),
    };
  }
  const day = localDateKey(date);
  return { day, week: localDateKey(startOfLocalWeek(date)), month: day.slice(0, 7) };
}

function accumulateRecordEstimate(
  periods,
  { timestampMs, sessionId, model, total, estimate, storedKeys = null },
  zone,
  rate,
) {
  const keys = recordPeriodKeys(timestampMs, zone, storedKeys);
  const scale = estimate.currency === "CNY" ? 1 : rate;
  for (const unit of ["day", "week", "month"]) {
    const key = keys[unit];
    let slot = periods[unit].get(key);
    if (!slot) {
      slot = {
        key,
        total: 0,
        input: 0,
        cached: 0,
        output: 0,
        reasoning: 0,
        sessions: new Set(),
        models: new Set(),
        cost: { total: 0, input: 0, cached: 0, output: 0 },
      };
      periods[unit].set(key, slot);
    }
    slot.total += Number(total.total || 0);
    slot.input += Number(total.input || 0);
    slot.cached += Number(total.cached || 0);
    slot.output += Number(total.output || 0);
    slot.reasoning += Number(total.reasoning || 0);
    slot.sessions.add(sessionId);
    slot.models.add(model);
    slot.cost.total += Number(estimate.totalUsd || 0) * scale;
    slot.cost.input += Number(estimate.inputUsd || 0) * scale;
    slot.cost.cached += Number(estimate.cachedInputUsd || 0) * scale;
    slot.cost.output += Number(estimate.outputUsd || 0) * scale;
  }
}

function rankRecordChampions(periods) {
  const slotValues = (slot) => ({
    totalTokens: slot.total,
    inputTokens: slot.input,
    cachedTokens: slot.cached,
    outputTokens: slot.output,
    reasoningTokens: slot.reasoning,
    sessionCount: slot.sessions.size,
    modelCount: slot.models.size,
    cacheHitRate: slot.input > 0 ? slot.cached / slot.input : null,
    totalCost: slot.cost.total,
    inputCost: slot.cost.input,
    cachedCost: slot.cost.cached,
    outputCost: slot.cost.output,
  });

  const champions = { day: {}, week: {}, month: {} };
  for (const metric of Object.keys(RECORD_METRICS)) {
    for (const unit of ["day", "week", "month"]) {
      const ranked = [...periods[unit].values()]
        .map((slot) => ({ key: slot.key, value: slotValues(slot)[metric] }))
        .filter((entry) => Number.isFinite(entry.value) && entry.value > 0)
        .sort((left, right) => right.value - left.value);
      // “至少两期可比”：少于两期无从比较；**并列**（前两名相等）不是新高 ⇒ 不点亮。
      if (ranked.length < 2 || ranked[0].value <= ranked[1].value) continue;
      champions[unit][metric] = { period: ranked[0].key, value: ranked[0].value };
    }
  }
  return champions;
}

function summarizeQuotaRecordWindow(events, window, excludedHomeIds, usdToCnyRate, estimateEventCost) {
  const start = window.start instanceof Date ? window.start.getTime() : Date.parse(window.start);
  const end = window.end instanceof Date ? window.end.getTime() : Date.parse(window.end);
  const scoped = events.filter((event) => {
    const timestamp = Date.parse(event.timestamp);
    return (
      Number.isFinite(timestamp) &&
      timestamp >= start &&
      timestamp <= end &&
      !excludedHomeIds.has(String(event.homeId)) &&
      isQuotaUsage(event)
    );
  });
  const total = { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
  for (const event of scoped) {
    for (const field of Object.keys(total)) {
      total[field] += Number(event.total?.[field] || 0);
    }
  }
  return {
    eventCount: scoped.length,
    values: quotaRecordValues(
      total,
      estimateCostForEvents(scoped, { estimateEventCost }),
      new Set(scoped.map((event) => event.sessionId)).size,
      usdToCnyRate,
    ),
  };
}

/**
 * M3.4：`perf_state` 的**取值域**。
 *
 * - `uninitialized`：`store_meta` 里**没有** `perf_state` 键（从未同步过）。
 *   **它不是持久化取值** —— 只是读取投影对"键缺失"的表达（AN-6：0/空 必须与键缺失可区分）。
 * - `rebuilding`：一次**有变更**的 sync 已经开始、整轮尚未成功结束。
 * - `ready`：整轮已启用来源成功完成。
 * - `degraded`：整轮结束但**部分受限**（主源文件不可读、坏帧/坏行致候选不完整，或单文件替换失败）。
 */
const PERF_STATES = Object.freeze(new Set(["rebuilding", "ready", "degraded"]));

/** 三态的具名常量（避免散落的字符串字面量漂移）。 */
const PERF_STATE_REBUILDING = "rebuilding";
const PERF_STATE_READY = "ready";
const PERF_STATE_DEGRADED = "degraded";

/**
 * 来源指纹的内容探测宽度：**首尾各 64KiB**。
 * 依据（我实测）：`size + mtimeMs` 无法检出"同尺寸 + 同 mtime tick 的原地改写"，
 * 而 SQLite 经常原地改写页面 ⇒ 必须补内容摘要。64KiB 足以覆盖 SQLite 文件头
 * （含 page count / change counter）与尾部新增页，成本固定、不随库大小增长。
 */
const CONTENT_PROBE_BYTES = 64 * 1024;

/**
 * M3.4 返工 **BB-1**：已启用来源的**主库 + WAL** 指纹（同步读取，供"读取前后比较"）。
 *
 * 用户明示"**主库＋WAL**"：ZCode 的新数据先落 `-wal`，**主库可能完全不变** ⇒ 只比主库会漏检。
 *
 * ⚠️ **我实测出 `size + mtimeMs` 本身不足**（这是这次返工中**我自己发现**的第二个缺口）：
 * ```
 * 同尺寸(4096→4096) + 同 mtime tick 的**原地改写** ⇒ size+mtime 指纹完全相同
 * ```
 * SQLite 恰恰**经常原地改写页面**（尺寸不变）⇒ 只靠 `size+mtime` 会漏检用户报告的
 * "追加记录后版本不变"。因此本指纹在 `size:mtime` 之外**再纳入内容摘要**
 * （`sha256` 覆盖主库 + `-wal` 的**首尾各 64KiB**，兼顾成本与灵敏度）。
 *
 * **同步**实现：要在**同一处**取前/后两次快照，因此用 `node:fs` 的**同步** API ——
 * 且**不可能**被 await 让出而被别的写入者插入（那正是本检测要抓的情形）。
 *
 * @param {string} kind 规范来源 kind
 * @param {string} filePath 物理文件路径
 * @returns {string | null} 指纹串；文件不存在/不可 stat ⇒ `null`（**不编造**，AQ-5）
 */
function enabledPerfSourceStat(kind, filePath) {
  if (!isPerfSourceEnabled(kind)) return null;
  try {
    const main = statSync(filePath);
    let size = main.size;
    let mtimeMs = main.mtimeMs;
    const walPath = `${filePath}-wal`;
    const wal = statSync(walPath, { throwIfNoEntry: false });
    const walSize = wal === undefined ? 0 : wal.size;
    if (wal !== undefined) {
      // 与 `zcodeSourceStat` 同一算法：`-wal` 计入大小、mtime 取较大者。
      size += wal.size;
      mtimeMs = Math.max(mtimeMs, wal.mtimeMs);
    }
    // 内容摘要：首尾各 64KiB（SQLite 头 + 追加/改写的尾部页都能覆盖）。
    const digest = createHash("sha256");
    const readerKind = canonicalizeKind(kind);
    if (readerKind === "dsh" || readerKind === "workbuddy") digest.update(`${readerKind}:visible-output-v1`);
    /** @type {[string, number][]} */
    const contentParts = [
      [filePath, main.size],
      [walPath, walSize],
    ];
    if (readerKind === "dsh" || readerKind === "workbuddy") {
      const observationPath = outputObservationFile(filePath, readerKind);
      const observation = statSync(observationPath, { throwIfNoEntry: false });
      if (observation) {
        size += observation.size;
        mtimeMs = Math.max(mtimeMs, observation.mtimeMs);
        contentParts.push([observationPath, observation.size]);
      }
    }
    for (const [file, fileSize] of contentParts) {
      if (fileSize <= 0) continue;
      const headLength = Math.min(fileSize, CONTENT_PROBE_BYTES);
      const head = openSync(file, "r");
      try {
        const buffer = Buffer.alloc(headLength);
        const read = readSync(head, buffer, 0, headLength, 0);
        digest.update(buffer.subarray(0, read));
        if (fileSize > CONTENT_PROBE_BYTES) {
          // 尾部（可能正是新追加的页所在）
          const tailLength = Math.min(fileSize, CONTENT_PROBE_BYTES);
          const tailBuffer = Buffer.alloc(tailLength);
          const tailRead = readSync(head, tailBuffer, 0, tailLength, fileSize - tailLength);
          digest.update(tailBuffer.subarray(0, tailRead));
        }
      } finally {
        closeSync(head);
      }
    }
    return `${size}:${mtimeMs}:${digest.digest("hex").slice(0, 32)}`;
  } catch {
    return null;
  }
}

/**
 * A readable enabled source needs extraction when its published candidates are
 * stale or when this version of the store has never published that file's
 * reader diagnostics. An empty warning array is a completed extraction.
 *
 * S2 卡（同稳定窗口的探针去重）：`reusedCurrent` 是**同一验证窗口**内已经取得的等价内容摘要。
 *
 * 实测口径（`S2\measure-s2-probes.mjs`）：一轮 `sync()` 对同一个 Codex rollout 会做多次
 * "内容是否变了"的判定 ——
 *   ① codex 回路的 `metadataChanged`（是否要重新规划该 home）；
 *   ② `planStableCodexHome` 的**读取前**摘要（`window.before.fileFingerprints`）；
 *   ③ `planStableCodexHome` 的**读取后**摘要（`window.after.fileFingerprints`）；
 *   ④ 逐文件循环的"要不要重解析这份文件的用量"判定；
 *   ⑤ 发布前复核（`windowPublish`）。
 *
 * ③ 与 ④ 之间**没有对该文件的任何读取**：③ 在整文件解析**之后**取，④ 只是决定"要不要再读一次"。
 * 两者属于**同一个"读取后"验证窗口** ⇒ ④ 直接复用 ③ 的摘要，不必再 stat + 读首尾 64KiB + sha256。
 *
 * 卡面边界（"前后/发布窗口分别新鲜"）——本卡**刻意不**做两件事：
 *   * 不把 ① 的摘要喂给 ②：② 是稳定性判据的**前半**，喂给它会把检测区间从"读取期间"放宽到
 *     "上一条判定之后"，把当前能成功发布的轮次误报成 `LIVE_SOURCE_CHANGED`；
 *   * 不把 ③ 的摘要喂给 ⑤：⑤ 的**职责**就是再取一次快照，喂给它会让发布前复核恒真、
 *     读取期间变化检测静默失效。
 *
 * 窗口失效（`plan` 不稳定/不可用、该文件不在窗口内、或来源身份规范后不是 codex）⇒ 调用方拿不到
 * 复用值（`undefined`）⇒ **重新探针**（即修复前行为）。
 *
 * @param {string} kind
 * @param {string} filePath
 * @param {Record<string, string>} publishedFingerprints
 * @param {Record<string, {sourceKind: string, homeId: string, code: string, count: number}[]>} publishedWarnings
 * @param {string | undefined} [reusedCurrent] 复用值；`undefined` ⇒ 真实探针
 */
function perfFileNeedsExtraction(kind, filePath, publishedFingerprints, publishedWarnings, reusedCurrent) {
  const current = reusedCurrent === undefined ? enabledPerfSourceStat(kind, filePath) : reusedCurrent;
  if (current === null) return false;
  return (
    publishedFingerprints[filePath] === undefined ||
    current !== publishedFingerprints[filePath] ||
    !Object.hasOwn(publishedWarnings, filePath)
  );
}

function perfFileNeedsRefresh(kind, filePath, publishedFingerprints, publishedWarnings, reusedCurrent) {
  if (canonicalizeKind(kind) !== "codex") {
    return perfFileNeedsExtraction(kind, filePath, publishedFingerprints, publishedWarnings, reusedCurrent);
  }
  const current = reusedCurrent === undefined ? enabledPerfSourceStat(kind, filePath) : reusedCurrent;
  return (
    current !== null && (publishedFingerprints[filePath] === undefined || current !== publishedFingerprints[filePath])
  );
}

/**
 * S2 卡：**规范物理路径** —— 复用摘要的键必须是物理文件本身，而不是它的某种写法。
 *
 * 只做绝对化 + Windows 大小写折叠。**不做** `realpath`：那会引入额外 I/O，并且会把符号链接与
 * `-wal` 折叠的语义从"路径"改成"目标"，而指纹算法本身要求按**调用方给的路径**读 `-wal`。
 * @param {string} filePath
 */
function canonicalPerfProbePath(filePath) {
  const text = String(filePath ?? "");
  if (text === "") return text;
  const resolved = path.resolve(text);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * C1 卡：**确定性内容失败码** —— 由文件内容本身决定、重试不会自愈的失败。
 *
 * 卡面明文"**仅稳定验证完成的确定性失败可复用**"，因此这里用**允许清单**而不是排除清单：
 * 只有列出的码才可能进入稳定失败尝试记录。**刻意排除**（卡面"`LIVE_SOURCE_CHANGED`、读取失败和
 * 发布失败不缓存为可跳过状态"）：
 *   * `READ_ONLY_OPEN_FAILED`（读取失败：占用/权限/IO ⇒ 瞬态，必须保留恢复路径）；
 *   * `LIVE_SOURCE_CHANGED`（读取期间来源变化 ⇒ 本轮判定"不可证"，绝不缓存）；
 *   * `OPTIONAL_SOURCE_UNAVAILABLE` 与任何未冻结码 —— `perfWarningCodeForError` 会把未冻结码
 *     折成 `READ_ONLY_OPEN_FAILED`，因此"未知原因"天然落在允许清单之外。
 */
const CODEX_DETERMINISTIC_FAILURE_CODES = Object.freeze(
  new Set(["MALFORMED_JSON", "MALFORMED_FRAME", "UNSUPPORTED_SCHEMA", "UNKEYABLE_RECORD", "AGGREGATE_OVERFLOW"]),
);

/**
 * C1 卡：稳定失败记录的**方法版本**（解析方法 + 发布策略）。
 *
 * 卡面"签名包含 home、完整排序路径集、内容指纹和**方法版本**"、"方法版本改变立即重试"：
 * 解析器口径（`PERF_METHOD_VERSION`）或发布策略修订（`CODEX_PUBLICATION_POLICY_REVISION`）任一
 * 变化 ⇒ 旧记录在命中判定里立即失配并被清除。
 */
function codexStableAttemptMethodVersion() {
  return `${PERF_METHOD_VERSION}:${CODEX_PUBLICATION_POLICY_REVISION}`;
}

/**
 * C1 卡：一个 Codex home 的**当前内容签名**（排序后的完整路径集 + 逐文件内容指纹）。
 *
 * 逐文件用 {@link enabledPerfSourceStat} —— 它与 `usage-core.js` 的 `perfContentFingerprint` 是
 * **逐字镜像**（同 `-wal` 折叠、同首尾各 64KiB 摘要、同 `size:mtimeMs:digest.slice(0,32)` 串形，
 * S2 已按同一算法对齐并有对拍测试），因此这里取到的指纹串与 `planStableCodexHome()` 返回的
 * `window.after.fileFingerprints` **可直接逐字比较**，无需再引入共享探针服务或新导出。
 *
 * 内容探针**不是**全文解析：成本固定为首尾各 64KiB（卡面"内容探针字节另计"）。
 * 任一文件取不到指纹（不可读）⇒ 返回 `null`：签名**不可证** ⇒ 调用方必须重新规划。
 *
 * @param {string} kind 发现时给出的原始 kind（`main`/`codex` 等同义别名）
 * @param {string[]} filePaths
 * @returns {{ paths: string[], fileFingerprints: Record<string, string> } | null}
 */
function codexHomeContentSignature(kind, filePaths) {
  const paths = [...filePaths].sort();
  /** @type {Record<string, string>} */
  const fileFingerprints = {};
  for (const filePath of paths) {
    const fingerprint = enabledPerfSourceStat(kind, filePath);
    if (fingerprint === null) return null;
    fileFingerprints[filePath] = fingerprint;
  }
  return { paths, fileFingerprints };
}

/**
 * C4 卡：**"这个线程必须重新构建候选吗？"** —— 这是"只构建/发布受影响线程"的**唯一**判据。
 *
 * 候选是 `(homeId, threadId, 排序后的 rollout 投影集)` 的**纯函数**：`buildCodexThreadPerfSamples()`
 * 只读入参，不读时间、不读全局、不读磁盘（它的入参是 planner 已经证明过的标准化投影）。
 * 因此三个**可判定身份**分量逐字相同 ⇒ 入参逐字相同 ⇒ 候选逐字相同 ⇒ **无需重建**。
 *
 * 身份分量（与 C3 的投影复用同一纪律：可判定、不绑时间、不绑全局、`undefined` 一律当"要建"）：
 *   ① **归属**：`threadId` 必须**已经发布过**（`perf_rollout_threads` / 已发布候选的归属）。
 *      新线程、身份重归属（同一物理文件改挂到另一个 threadId）、跨 home 迁移 ⇒ 未发布过 ⇒ 必建。
 *   ② **依赖集合**：当前**完整** rollout 路径集（含归档片段在内的全部物理 rollout）必须与已发布的
 *      逐字相同；上一轮成功发布已确认缺失、当前仍缺失的旧依赖可保留，不重复复建。
 *   ③ **内容**：每个 rollout 的**本轮读取后**指纹必须与**已提交**指纹（产生当前候选的那一次发布）
 *      逐字相同。已提交指纹只在"该线程被发布"时写入（`replaceFile` 对 codex **不写**指纹）⇒
 *      `undefined` 即"从未发布过" ⇒ 必建。
 *
 * ⚠️ **不得**把任一分量换成"上一轮的结论"（跨轮粘缓存是明确错误）：`afterFingerprints` 是本轮
 * 稳定窗口**刚刚**取得的摘要，`publishedFingerprints` 是库里已提交的事实，二者比较才是判据。
 *
 * @param {{ threadId: string, rolloutFiles: string[] }} thread 当前线程（`rolloutFiles` 已排序、完整）
 * @param {Set<string>} oldThreadIds 已发布过的线程 id
 * @param {Map<string, Set<string>>} oldPathsByThread 已发布线程 → 其完整物理路径集
 * @param {Record<string, string>} afterFingerprints 本轮**读取后**稳定窗口的逐文件指纹
 * @param {Record<string, string>} publishedFingerprints 已提交的逐文件指纹
 * @param {Set<string>} dirtyTimingThreadIds timing evidence changed but not republished
 * @param {Set<string>} acknowledgedMissingPaths Missing dependencies acknowledged by a successful publication.
 * @returns {boolean} `true` = 必须重新构建（`false` = 可原样复用已发布候选）
 */
function codexThreadNeedsBuild(
  thread,
  oldThreadIds,
  oldPathsByThread,
  afterFingerprints,
  publishedFingerprints,
  dirtyTimingThreadIds,
  acknowledgedMissingPaths,
) {
  if (dirtyTimingThreadIds instanceof Set && dirtyTimingThreadIds.has(thread.threadId)) return true;
  if (!(oldThreadIds instanceof Set) || !oldThreadIds.has(thread.threadId)) return true;
  const oldPaths = oldPathsByThread instanceof Map ? oldPathsByThread.get(thread.threadId) : undefined;
  // 有归属却取不到路径集 ⇒ 不可判定 ⇒ 重算（绝不假设"没变"）。
  if (!(oldPaths instanceof Set)) return true;
  if (oldPaths.size !== thread.rolloutFiles.length) {
    let missingCount = 0;
    for (const filePath of oldPaths) if (acknowledgedMissingPaths?.has(filePath)) missingCount++;
    if (oldPaths.size - missingCount !== thread.rolloutFiles.length) return true;
  }
  for (const filePath of thread.rolloutFiles) {
    if (!oldPaths.has(filePath)) return true;
    const after = afterFingerprints?.[filePath];
    if (typeof after !== "string" || after !== publishedFingerprints?.[filePath]) return true;
  }
  return false;
}

/**
 * M3.4 返工 **BB-3** + 返工2 **BC-2**：`perf_index_version` 的取值。
 *
 * **Lead 更正的 D3 定义**：版本号**不得**只是"来源集合标识"，必须纳入**已发布文件指纹**。
 * **用户第二轮复现（BC-2）**："**不要在整轮结束时重新 stat 上游并把它称作发布指纹。**"
 *
 * ⇒ 本函数**不再 stat 上游**。它聚合：
 *   ① 参与性能索引的来源身份；
 *   ② 已提交的物理文件归属；
 *   ③ 已在文件事务内提交的指纹（`perf_file_fingerprints`，随候选 COMMIT/ROLLBACK）。
 * Codex 的 homes/files 由调用方按 `perf_rollout_threads` 过滤，避免把已发现但未发布的 rollout
 * 混入版本；其他来源继续使用 `source_files` 与本轮启用 home 集合。
 *
 * 语义后果（正是卡片要求的四条）：
 * - **失败回滚保留旧指纹**：事务回滚 ⇒ 映射未变 ⇒ 版本不变；
 * - **真实删除移除分量**：`sync()` 删除 `source_files` 行时也从指纹映射清除该文件（见 `sync()`）；
 * - **成功发布 ⇒ 版本变化**：新指纹随同一次 `COMMIT` 生效 ⇒ 版本随内容变；
 * - **未启用来源不影响**：其 `kind` 不满足 `isPerfSourceEnabled` ⇒ 不入聚合。
 *
 * @param {ReadonlyArray<{id?: string, kind?: string, sourceKind?: string, path?: string, usageLogPath?: string}>} homes
 * @param {Record<string, string>} publishedFingerprints 已提交的 `path → 指纹` 映射
 * @param {ReadonlyArray<{path?: string, kind?: string, home_id?: string, home_path?: string}>} publishedFiles
 * @param {number} [requestTimingPublicationSeq] committed count of timing publications
 * @param {ReadonlyMap<string, { fingerprint: string, complete: boolean }>} [traceDependencies]
 * @param {boolean | null} [legacyWorkbuddyFallbackAllowed]
 */
function buildPublishedSourcesFingerprint(
  homes,
  publishedFingerprints,
  publishedFiles = [],
  requestTimingPublicationSeq = 0,
  traceDependencies = new Map(),
  legacyWorkbuddyFallbackAllowed = null,
  missingSources = [],
) {
  const byPath = publishedFingerprints || {};
  const parts = [JSON.stringify(["method", PERF_METHOD_VERSION])];
  const rowsByHome = new Map();
  for (const row of publishedFiles || []) {
    const key = `${canonicalizeKind(row?.kind)}\u0000${String(row?.home_id ?? "")}`;
    const rows = rowsByHome.get(key) || [];
    rows.push(row);
    rowsByHome.set(key, rows);
  }
  for (const home of homes || []) {
    const kind = canonicalizeKind(String(home?.kind ?? home?.sourceKind ?? ""));
    if (!isPerfSourceEnabled(kind)) continue;
    const homeId = String(home?.id ?? "");
    const homePath = typeof home?.path === "string" ? home.path : "";
    // Home identity remains present even when discovery finds zero physical files.
    parts.push(JSON.stringify(["home", kind, homeId]));
    if (kind === "workbuddy") {
      const traceDependency = traceDependencies.get(homeId);
      parts.push(
        JSON.stringify([
          "workbuddy-trace",
          homeId,
          traceDependency?.complete ? traceDependency.fingerprint : "unavailable",
        ]),
      );
      if (legacyWorkbuddyFallbackAllowed !== null) {
        parts.push(
          JSON.stringify(["workbuddy-legacy-fallback", homeId, legacyWorkbuddyFallbackAllowed ? "single" : "multi"]),
        );
      }
    }
    const rows = rowsByHome.get(`${kind}\u0000${homeId}`) || [];
    for (const row of rows) {
      if (homePath !== "" && String(row?.home_path ?? "") !== homePath) continue;
      const filePath = String(row?.path ?? "");
      if (filePath === "") continue;
      // The published fingerprint is written in the same transaction as the
      // candidate rows. Missing means the physical file has not been extracted
      // successfully; never restat upstream while constructing this version.
      parts.push(JSON.stringify(["file", kind, homeId, filePath, byPath[filePath] ?? "unpublished"]));
    }
  }
  if (Number.isSafeInteger(requestTimingPublicationSeq) && requestTimingPublicationSeq > 0) {
    parts.push(JSON.stringify(["request-timing-publication", String(requestTimingPublicationSeq)]));
  }
  for (const source of missingSources) {
    parts.push(JSON.stringify(["missing", source.kind, source.homeId, source.path]));
  }
  const unique = [...new Set(parts)].sort();
  return createHash("sha256").update(unique.join("\n")).digest("hex");
}

/**
 * Trace files are WorkBuddy duration inputs but not session/perf files. Hash the
 * same size+mtime+64KiB content probe used for published file evidence.
 * @param {string} homePath
 */
async function inspectWorkbuddyTrace(homePath) {
  const traceFiles = await workbuddyTraceFiles(homePath);
  const text = await workbuddyLogSnapshot(homePath);
  /** @type {Map<string, string>} */
  const fingerprints = new Map();
  const hash = createHash("sha256");
  let complete = text.complete;
  for (const filePath of [...traceFiles, ...text.files].sort()) {
    const fingerprint = enabledPerfSourceStat("workbuddy", filePath);
    fingerprints.set(filePath, fingerprint);
    if (fingerprint === null) complete = false;
    hash.update(`${filePath}\t${fingerprint ?? "!"}\n`);
  }
  return { traceFiles, textFiles: text.files, fingerprints, fingerprint: hash.digest("hex"), complete };
}

/**
 * M3.4：把**逐文件失败**投影成只含编码后四字段的源告警列表。
 *
 * **卡片明文**："仅 API 投影编码后的 `sourceKind/homeId/code/count`，**不输出路径**"。
 *
 * ⚠️ **必须按失败文件归因，不得按"本轮扫描过的 home"归因** —— 我第一版用后者，
 * 实测出**误归因**：home-A 成功、home-B 失败，结果**两个 home 都被记成 `INDEX_FAILED`**。
 * 这违反 AN-6（"每一个持久化的数字/归因都必须可追溯到一次真实计算"）。⇒ 改为在
 * `sync()` 循环里**只对真正抛错的那个文件**记一条。
 *
 * `count` = **同一 (sourceKind, homeId, code) 的失败文件数**（真实计数，不是常量 1）。
 * 失败文件的**原文告警**（含路径）仍进 `sync()` 的内存 `warnings`（供 CLI 展示），
 * 但**绝不入 `store_meta`**。
 *
 * **BB-4**：`code` 由调用方给出且**必须落在 M1 冻结码域内**（见 `perfWarningCodeForError`）。
 * 归因键包含 `code` ⇒ `LIVE_SOURCE_CHANGED` 与 `READ_ONLY_OPEN_FAILED` 各成一条，不互相覆盖。
 * @param {{sourceKind: string, homeId: string, code?: string, sourcePath?: string}[]} failures
 */
function projectSourceFailures(failures) {
  if (!failures || failures.length === 0) return [];
  const counts = new Map();
  const countedPaths = new Map();
  for (const failure of failures) {
    const homeId = String(failure?.homeId ?? "").trim();
    const sourceKind = String(failure?.sourceKind ?? "").trim();
    const code = String(failure?.code ?? "").trim();
    // 取不到 home 时**不编造**归因（不写空 id 占位），直接跳过 —— 宁缺勿错（AN-6）。
    if (homeId === "") continue;
    // 码缺失时**不猜**（不落一个不在冻结域内的码）⇒ 直接跳过并在下面由断言守住。
    if (code === "") continue;
    const key = `${sourceKind}\u0000${homeId}\u0000${code}`;
    const sourcePath = typeof failure?.sourcePath === "string" ? failure.sourcePath : "";
    if (sourcePath !== "") {
      const paths = countedPaths.get(key) || new Set();
      if (paths.has(sourcePath)) continue;
      paths.add(sourcePath);
      countedPaths.set(key, paths);
    }
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => {
    const [sourceKind, homeId, code] = key.split("\u0000");
    return { sourceKind, homeId, code, count };
  });
}

/**
 * Aggregate persisted reader diagnostics and file failures into the public
 * four-field warning shape. Reader counts are per-file counts and must be
 * summed, while file failures without a count contribute one each.
 * @param {{sourceKind: string, homeId: string, code?: string, count?: number}[]} entries
 */
function projectSourceWarnings(entries) {
  if (!entries || entries.length === 0) return [];
  const counts = new Map();
  for (const entry of entries) {
    const homeId = String(entry?.homeId ?? "").trim();
    const sourceKind = String(entry?.sourceKind ?? "").trim();
    const code = String(entry?.code ?? "").trim();
    if (homeId === "" || sourceKind === "" || code === "") continue;
    const rawCount = Number(entry?.count ?? 1);
    const count = Number.isSafeInteger(rawCount) && rawCount > 0 ? rawCount : 1;
    const key = `${sourceKind}\u0000${homeId}\u0000${code}`;
    counts.set(key, (counts.get(key) || 0) + count);
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [sourceKind, homeId, code] = key.split("\u0000");
      return { sourceKind, homeId, code, count };
    })
    .sort(
      (a, b) =>
        a.sourceKind.localeCompare(b.sourceKind) || a.homeId.localeCompare(b.homeId) || a.code.localeCompare(b.code),
    );
}

/** 读取投影中额外允许的**非持久化**取值（仅表示"键缺失"）。 */
const PERF_STATE_UNINITIALIZED = "uninitialized";

/**
 * M3.4 返工 **BB-4**：把 `replaceFile` 抛出的错误映射到 **M1 冻结告警码**。
 *
 * **用户的复现**：原实现硬写 `INDEX_FAILED`，把它交给**真实 `summarizePerf`** 会直接抛
 * `TypeError: sourceWarnings.code INDEX_FAILED is outside the frozen §3:83 domain`
 * ⇒ **形状一致 ≠ 码域兼容**（Lead 更正 BA-4）。
 *
 * **我实测出的关键事实（这决定了本裁决）**：reader **已经**在自己的错误对象上带了**冻结码**：
 * ```
 * 坏文件（非 SQLite）→ ZcodeReadOnlyOpenError, code = "READ_ONLY_OPEN_FAILED"
 * 缺表（空 SQLite）  → ZcodeReadOnlyOpenError, code = "UNSUPPORTED_SCHEMA"
 * 文件不存在         → ZcodeReadOnlyOpenError, code = "READ_ONLY_OPEN_FAILED"
 * ```
 * ⇒ **无需新增码、无需解冻 M1**：应当**透传 reader 自己的码**（它比本层更懂失败原因），
 * 这也天然满足"按**实际失败原因**使用冻结编码"。
 *
 * **兜底**：非 reader 的失败（如 SQLite 层的 `ERR_SQLITE_ERROR`/FK 787）在冻结域内**最接近**
 * `READ_ONLY_OPEN_FAILED` —— 其语义是"**只读读取该来源失败**"。⚠️ **我登记其中的语义偏差**：
 * FK/约束类错误严格说不是"open failed"，但它是**读该来源文件失败**这一上位概念，
 * 且**八码中无一更贴切**（`UNSUPPORTED_SCHEMA` 专指结构不符、`MALFORMED_*` 专指帧/行解析）。
 * ⇒ 选择"复用 + 显式登记偏差"，**而非自行新增码**（那需要用户批准解冻 M1）。
 * @param {any} error
 */
function perfWarningCodeForError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  // reader 自己的冻结码优先（`ZcodeReadOnlyOpenError.code` / `OpencodePerfReadError.code`）。
  if (PERF_SOURCE_WARNING_CODES.has(code)) return code;
  return "READ_ONLY_OPEN_FAILED";
}

/**
 * 把 discovery 给出的原始 kind 规范化成**规范 perf kind**（`extra`/`main` → `codex`），
 * 与 `classifyPerfSources` 的口径一致，避免 `unsupportedSources` 用 `codex` 而归因用 `extra`。
 * @param {string} kindRaw
 */
function canonicalizeKind(kindRaw) {
  try {
    return canonicalPerfSourceKind(kindRaw);
  } catch {
    return String(kindRaw ?? "");
  }
}

function requestTimingImportError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Enforce the high-level admission boundary for one import batch. Reviewed
 * origins are supplied by the caller and never inferred from record metadata.
 *
 * @param {unknown[]} records
 * @param {unknown} reviewedOrigins
 */
export function assertRequestTimingOriginsReviewed(records, reviewedOrigins) {
  if (!Array.isArray(records)) {
    throw requestTimingImportError("REQUEST_TIMING_INVALID_INPUT", "records must be an array");
  }
  if (records.length === 0) return;
  if (!Array.isArray(reviewedOrigins)) {
    throw requestTimingImportError(
      "REQUEST_TIMING_ORIGIN_UNREVIEWED",
      "reviewedOrigins is required for a non-empty timing batch",
    );
  }
  const reviewed = new Set();
  for (const origin of reviewedOrigins) {
    if (typeof origin !== "string" || origin.trim() === "") {
      throw requestTimingImportError(
        "REQUEST_TIMING_ORIGIN_UNREVIEWED",
        "reviewedOrigins must contain non-empty strings",
      );
    }
    reviewed.add(origin);
  }
  for (const record of records) {
    const origin =
      record !== null && typeof record === "object" && !Array.isArray(record)
        ? /** @type {{evidenceOrigin?: unknown}} */ (record).evidenceOrigin
        : undefined;
    if (typeof origin !== "string" || !reviewed.has(origin)) {
      throw requestTimingImportError(
        "REQUEST_TIMING_ORIGIN_UNREVIEWED",
        `Timing evidence origin ${String(origin)} was not reviewed for this batch`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// T1：Codex 标准化投影的**私有持久化读写接缝**（`handoffs/T1-design.md` §2/§4）。
//
// ⚠️ 本段只**提供**接缝。**T2（2026-10-09）已接线**：接点是 `open()` 尾部的一行
// `this.codexProjections = createPersistentCodexProjectionCache({ … })`（见该行前后注释）
// —— 必须在 `open()` 里而不是构造器里：构造器里 `this.database` 还是 `null`（见 `:1784`），
// 那时接线只会拿到 `database = null` ⇒ 退化成纯内存缓存（缺口一个都不闭合）。`open()` 尾部也是
// **唯一**能保证 `perf_codex_projections` 已存在的位置（v13→14 迁移 / v0 建库都在 `migrate` 段）。
// planner 的调用点一个都没改（`:3022` `retainHomes`、`:3200` 传 `projectionCache`、
// `:3202-3204` `commit/rollback/prune`、`:4684` `clear()`），因此 `planStableCodexHome` 的签名行
// （B2 锚点）逐字节不变。
// ---------------------------------------------------------------------------

/** 私有表名（唯一；写进报告）。 */
export const CODEX_PROJECTION_STORE_TABLE = "perf_codex_projections";

/**
 * T1：`src/perf-sources/codex-thread.js:293-298` 的 `canonicalProjectionPath()` 的**逐字节镜像**。
 *
 * 为什么必须镜像而不是只 `path.resolve()`（设计页 §0 修订 1②）：持久表的 `path` 主键必须
 * **等于内存缓存的键**（`entries()[].path`，见 `codex-thread.js:518`）。只 resolve 的话，同一物理
 * 文件的两种大小写写法会落成**两行**、且 DB 键 ≠ 内存键，而 `prune(homeId, expectedPaths)`
 * （`:481` 用同一个规范化函数）又会按内存键去删 ⇒ 行删不掉。
 *
 * 不能直接 import：该函数未导出，且改 `codex-thread.js` 属 T2 范围；本仓对此有既有惯例
 * ——"镜像 + 对拍测试"（`codex-thread.js:289-290` 的自述）。对拍在
 * `test/perf-projection-store.test.js`：拿真实 `createCodexProjectionCache().entries()` 逐字节比对，
 * **不许**只靠"看起来一样"。
 */
function canonicalProjectionStorePath(filePath) {
  const text = String(filePath ?? "");
  if (text === "") return text;
  const resolved = path.resolve(text);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * T1：`codex-thread.js:352-373`（`indexFor` + `currentFingerprint`）的**逐字节镜像**。
 *
 * 指纹是投影的身份来源，持久行只在"与内存 `lookup()` 收到的同一份指纹逐字节相同"时才可复用。
 * `indexFor` 的**对象身份绑定**必须一并镜像：换指纹对象即重建索引，否则"路径 → 指纹"会停在上一轮
 * 的取值上，让一个**真变了**的文件因旧指纹恰好等于旧条目而被当作未变（那正是 `:347-351` 要防的
 * "粘缓存"错误）。`Object.hasOwn` 快路径也要镜像：它是"发现路径与窗口键逐字相同"的零分配分支，
 * 返回值可能与折叠后的索引取值不同（大小写变体），两条路径必须各自对拍。
 * @returns {(fingerprints: Record<string, string> | null | undefined, filePath: string) => string | undefined}
 */
function createProjectionFingerprintReader() {
  let pathIndex = null;
  return (fingerprints, filePath) => {
    if (!fingerprints || typeof fingerprints !== "object") return undefined;
    if (Object.hasOwn(fingerprints, filePath)) {
      const direct = fingerprints[filePath];
      return typeof direct === "string" && direct !== "" ? direct : undefined;
    }
    if (!pathIndex || pathIndex.forFingerprints !== fingerprints) {
      const byPath = new Map();
      for (const [candidate, fingerprint] of Object.entries(fingerprints)) {
        byPath.set(canonicalProjectionStorePath(candidate), fingerprint);
      }
      pathIndex = { forFingerprints: fingerprints, byPath };
    }
    const value = pathIndex.byPath.get(canonicalProjectionStorePath(filePath));
    return typeof value === "string" && value !== "" ? value : undefined;
  };
}

/**
 * T1：`codex-thread.js:307-313` 的 `projectionByteEstimate()` 的**逐字节镜像**（设计页 §6.2 要求
 * "字节口径与内存同一个函数"必须是被测到的事实，不是声明）。对拍见 `test/perf-projection-store.test.js`
 * （与真实缓存的 `entries()[].bytes` / `stats().bytes` 比对）。
 *
 * 第二个形参只为**避免重复序列化**：`stage()` 必须先把投影序列化成落盘的 `projection` 文本，传入它即可
 * —— `serialized.length` 与 `JSON.stringify(projection).length` 逐字节相同。
 * @param {unknown} projection
 * @param {string} [serialized]
 */
export function projectionStoreByteEstimate(projection, serialized) {
  if (typeof serialized === "string") return serialized.length;
  try {
    return JSON.stringify(projection)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * T1：把内存投影缓存（`createCodexProjectionCache()`，`codex-thread.js:328`）包上**私有持久层**。
 *
 * 与内存缓存**一一对应**（设计页 §4）：
 *   * `lookup` → 内存未命中时查私有表；命中即**水合**（交回内存缓存，等稳定窗口 `commit` 提升）；
 *   * `stage` → 透传内存，并记下"本轮真实读到"的行，**只有 `commit` 才落盘**；
 *   * `commit` → 内存提升 + 该 home 的行在**同一事务**内写库（失败整体回滚 ⇒ 不留半行）；
 *   * `rollback` → 内存丢弃 + **不写库**（失效即重算）；
 *   * `prune(homeId, expectedPaths)` → 删本 home 不在当前路径集的行；
 *   * `retainHomes(ids)` → 删其余 home 的行；**只保留当前版本**（path 是主键，插入即替换）；
 *   * `clear()` → 只清内存侧；**不清表**（跨实例复用正是 T2 的目的）。
 *
 * 失败降级：持久层是**缓存**，来源才是事实 ⇒ 任何读写失败都**不抛**、不打断 sync；blob 损坏即
 * **miss + 删该行**（"失效即重算"）。债以计数器暴露（`stats().persistence`），不静默吞掉。
 *
 * @param {{
 *   database?: import("node:sqlite").DatabaseSync | null,
 *   inner?: ReturnType<typeof createCodexProjectionCache>,
 *   methodVersion?: string,
 *   now?: () => string,
 * }} [options]
 */
export function createPersistentCodexProjectionCache({
  database = null,
  inner = createCodexProjectionCache(),
  methodVersion,
  now = () => new Date().toISOString(),
} = {}) {
  // 缺省取内存缓存**自己**报告的方法版本（`stats().methodVersion` =
  // `${PERF_METHOD_VERSION}:${CODEX_PROJECTION_METHOD_VERSION}`，`codex-thread.js:282-284`）——
  // 它正是 `lookup()` 在 `:418` 比较的、`entries()` 在 `:518` 暴露的**同一个字符串**。
  // 显式传入只为测试能分别 bump 两个组成部分（设计页 §6.2）。
  const currentMethodVersion = String(methodVersion ?? inner.stats().methodVersion);
  const fingerprintOf = createProjectionFingerprintReader();
  /** homeId → Map<规范路径, 待落盘行>：**只**记本轮真实 `stage()` 的条目（水合回来的不重写）。 */
  const freshRows = new Map();
  let savepointCounter = 0;
  const counters = {
    persistedRows: 0,
    hydratedRows: 0,
    prunedRows: 0,
    retainedRows: 0,
    invalidatedRows: 0,
    corruptRows: 0,
    staleFingerprintRows: 0,
    foreignHomeRows: 0,
    kindMismatchRows: 0,
    writeFailures: 0,
    writeTransactions: 0,
  };

  const SELECT_ROW =
    "SELECT home_id, kind, method_version, fingerprint, bytes, projection FROM perf_codex_projections WHERE path = ?";
  const DELETE_ROW = "DELETE FROM perf_codex_projections WHERE path = ?";
  const COUNT_ROWS = "SELECT COUNT(*) AS n FROM perf_codex_projections";
  const UPSERT_ROW = `INSERT INTO perf_codex_projections
      (path, home_id, kind, method_version, fingerprint, bytes, projection, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      home_id = excluded.home_id,
      kind = excluded.kind,
      method_version = excluded.method_version,
      fingerprint = excluded.fingerprint,
      bytes = excluded.bytes,
      projection = excluded.projection,
      updated_at = excluded.updated_at`;

  /**
   * 一批写操作包在**一个事务**里（用 `SAVEPOINT` 而不是 `BEGIN`：`SAVEPOINT` 在"外层已有事务"时
   * 同样正确嵌套、外层没有事务时 `RELEASE` 就是真实提交，因此无论 `UsageStore` 的调用时序如何都
   * 不会出现 "cannot start a transaction within a transaction"）。任何失败 ⇒ 回滚到该保存点 +
   * 计 `writeFailures` + 返回 `false`，**不抛**。
   * @param {() => void} work
   */
  const runInSavepoint = (work) => {
    if (!database) return false;
    savepointCounter += 1;
    const name = `t1_projection_write_${savepointCounter}`;
    let begun = false;
    try {
      database.exec(`SAVEPOINT ${name}`);
      begun = true;
      work();
      database.exec(`RELEASE ${name}`);
      counters.writeTransactions += 1;
      return true;
    } catch {
      if (begun) {
        // 连接已不可用 ⇒ 回滚也会抛；SQLite 在关闭时会丢弃未提交事务（"不留半行"由它兜底）。
        try {
          database.exec(`ROLLBACK TO ${name}`);
        } catch {
          /* 已在上面登记 writeFailures；这里不再二次抛 */
        }
        try {
          database.exec(`RELEASE ${name}`);
        } catch {
          /* 同上 */
        }
      }
      counters.writeFailures += 1;
      return false;
    }
  };

  /** 删单行（定向失效）。失败不抛。 */
  const deleteRow = (canonicalPath) => {
    if (!database) return false;
    try {
      database.prepare(DELETE_ROW).run(canonicalPath);
      return true;
    } catch {
      counters.writeFailures += 1;
      return false;
    }
  };

  /** 只读计数；失败返回 `null`（区别于"0 行"）。 */
  const readRowCount = () => {
    if (!database) return null;
    try {
      return Number(database.prepare(COUNT_ROWS).get()?.n ?? 0);
    } catch {
      counters.writeFailures += 1;
      return null;
    }
  };

  return {
    /** 见 `codex-thread.js:397`：`undefined` = "不可复用" ⇒ 调用方必须走真实全文读。 */
    /**
     * @param {{homeId?: string, kind?: string, filePath?: string, fingerprints?: Record<string, string>, methodVersion?: string, transient?: boolean}} [options={}]
     */
    lookup({ homeId, kind, filePath, fingerprints, methodVersion: requestedMethodVersion, transient = false } = {}) {
      // ① 先走内存（与今日逐字节同一条路径；命中就连指纹都不再算）。
      const memory = transient
        ? undefined
        : inner.lookup({ homeId, kind, filePath, fingerprints, methodVersion: requestedMethodVersion });
      if (memory !== undefined) return memory;
      // ② 只有 codex rollout 才有这张表（与 `:399` 的来源守卫同款）。
      if (canonicalizeKind(kind) !== "codex") return undefined;
      const canonicalPath = canonicalProjectionStorePath(filePath);
      if (canonicalPath === "") return undefined;
      // ③ 本轮窗口必须**已经**取得"读取前"指纹（`:402-404` 同款守卫）：没有 ⇒ 不可复用。
      const fingerprint = fingerprintOf(fingerprints, /** @type {string} */ (filePath));
      if (fingerprint === undefined) return undefined;
      if (!database) return undefined;
      let row;
      try {
        row = database.prepare(SELECT_ROW).get(canonicalPath);
      } catch {
        counters.writeFailures += 1;
        return undefined;
      }
      if (row === undefined) return undefined;
      const expectedMethodVersion = String(requestedMethodVersion ?? currentMethodVersion);
      // ④ 逐条**定向**失效（**绝不**无条件标脏全库）：三类不符各删该行并计数，然后当作 miss。
      if (String(row.method_version) !== expectedMethodVersion) {
        deleteRow(canonicalPath);
        counters.invalidatedRows += 1;
        return undefined;
      }
      if (String(row.fingerprint) !== fingerprint) {
        deleteRow(canonicalPath);
        counters.staleFingerprintRows += 1;
        return undefined;
      }
      if (String(row.home_id) !== String(homeId ?? "")) {
        deleteRow(canonicalPath);
        counters.foreignHomeRows += 1;
        return undefined;
      }
      if (canonicalizeKind(/** @type {string} */ (row.kind)) !== canonicalizeKind(kind)) {
        deleteRow(canonicalPath);
        counters.kindMismatchRows += 1;
        return undefined;
      }
      // ⑤ 损坏 blob ⇒ miss + 删行，**不抛**（`JSON.parse` 抛错会被这里接住，sync 不被打断）。
      let projection;
      try {
        projection = JSON.parse(String(row.projection));
      } catch {
        projection = undefined;
      }
      if (!projection || typeof projection !== "object") {
        deleteRow(canonicalPath);
        counters.corruptRows += 1;
        return undefined;
      }
      // ⑥ 水合：普通调用交回内存缓存（只有稳定窗口的 `commit()` 才会把它提升为可复用条目）。
      // lazy planner 的 transient 调用只返回本次构建所需对象，不把整 home 的 parsed
      // projection 留在内存 cache。**不**记入 `freshRows` ⇒ `commit()` 不会把这些行再写一遍。
      if (!transient) {
        inner.stage({ homeId, kind, filePath, fingerprints, projection, methodVersion: expectedMethodVersion });
      }
      counters.hydratedRows += 1;
      return projection;
    },

    /**
     * 普通调用透传内存 `stage()`；`transient: true` 只记待落盘行，不进入内存投影 cache。
     * lazy thread 在构建前按 thread 提交，使本轮 parsed projection 不会跨 thread 累积。
     */
    stage(args = {}) {
      const transient = args.transient === true;
      if (!transient) {
        const ok = inner.stage(args);
        if (!ok) return false;
      } else {
        if (canonicalizeKind(args.kind) !== "codex") return false;
        if (!args.projection || typeof args.projection !== "object") return false;
        if (canonicalProjectionStorePath(args.filePath) === "") return false;
        if (fingerprintOf(args.fingerprints, args.filePath) === undefined) return false;
      }
      const canonicalPath = canonicalProjectionStorePath(args.filePath);
      const id = String(args.homeId ?? "");
      let text;
      try {
        text = JSON.stringify(args.projection);
      } catch {
        text = undefined;
      }
      // 不可序列化的投影不落盘（内存侧仍然可用）：本函数的返回语义只关于内存暂存是否成功。
      if (canonicalPath === "" || text === undefined) return true;
      let bucket = freshRows.get(id);
      if (bucket === undefined) {
        bucket = new Map();
        freshRows.set(id, bucket);
      }
      bucket.set(canonicalPath, {
        path: canonicalPath,
        home_id: id,
        kind: canonicalizeKind(args.kind),
        method_version: String(args.methodVersion ?? currentMethodVersion),
        fingerprint: fingerprintOf(args.fingerprints, args.filePath),
        bytes: projectionStoreByteEstimate(args.projection, text),
        projection: text,
        updated_at: now(),
      });
      return true;
    },

    /**
     * Remove one path when lazy hydration no longer matches the stable-window proof.
     * @param {{ filePath?: string }} [options]
     */
    invalidate({ filePath } = {}) {
      const canonicalPath = canonicalProjectionStorePath(filePath);
      if (canonicalPath === "") return false;
      inner.discard?.(canonicalPath);
      return deleteRow(canonicalPath);
    },

    /** 稳定窗口（或已证明的 append 子集）⇒ 内存提升 + 本 home 的未排除行**单事务**落盘。 */
    commit(homeId, excludedPaths = []) {
      const excluded = new Set((excludedPaths ?? []).map(canonicalProjectionStorePath));
      const promoted = inner.commit(homeId, excludedPaths);
      const id = String(homeId ?? "");
      const bucket = freshRows.get(id);
      freshRows.delete(id);
      if (bucket === undefined || bucket.size === 0) return promoted;
      const rows = [...bucket.values()].filter((row) => !excluded.has(row.path));
      const ok = runInSavepoint(() => {
        const statement = database.prepare(UPSERT_ROW);
        for (const row of rows) {
          statement.run(
            row.path,
            row.home_id,
            row.kind,
            row.method_version,
            row.fingerprint,
            row.bytes,
            row.projection,
            row.updated_at,
          );
        }
      });
      if (ok) counters.persistedRows += rows.length;
      return promoted;
    },

    /** 窗口不可证/不稳定 ⇒ 内存丢弃 + **不写库**。 */
    rollback(homeId) {
      const had = inner.rollback(homeId);
      freshRows.delete(String(homeId ?? ""));
      return had;
    },

    /** 只保留该 home 当前的物理文件集（替换 / 删除 / 重命名淘汰），内存与库同一条契约。 */
    prune(homeId, filePaths) {
      const dropped = inner.prune(homeId, filePaths);
      const id = String(homeId ?? "");
      const keep = new Set((filePaths ?? []).map(canonicalProjectionStorePath));
      const bucket = freshRows.get(id);
      if (bucket !== undefined) {
        for (const candidate of [...bucket.keys()]) if (!keep.has(candidate)) bucket.delete(candidate);
      }
      if (!database) return dropped;
      let victims;
      try {
        // 先只读选出受害者（**未命中就不开写事务** ⇒ 稳态轮不产生写放大），再单事务删。
        victims = database
          .prepare("SELECT path FROM perf_codex_projections WHERE home_id = ?")
          .all(id)
          .map((row) => String(row.path))
          .filter((candidate) => !keep.has(candidate));
      } catch {
        counters.writeFailures += 1;
        return dropped;
      }
      if (victims.length === 0) return dropped;
      const ok = runInSavepoint(() => {
        const statement = database.prepare(DELETE_ROW);
        for (const victim of victims) statement.run(victim);
      });
      if (ok) counters.prunedRows += victims.length;
      return dropped;
    },

    /** home 整体消失（来源移除 / 归档迁移 / 别名变化）⇒ 淘汰内存与库里它的全部条目。 */
    retainHomes(homeIds) {
      const dropped = inner.retainHomes(homeIds);
      const keep = new Set([...(homeIds ?? [])].map((homeId) => String(homeId)));
      for (const id of [...freshRows.keys()]) if (!keep.has(id)) freshRows.delete(id);
      if (!database) return dropped;
      let victims;
      try {
        if (keep.size === 0) {
          victims = database
            .prepare("SELECT path FROM perf_codex_projections")
            .all()
            .map((row) => String(row.path));
        } else {
          const placeholders = [...keep].map(() => "?").join(", ");
          victims = database
            .prepare(`SELECT path FROM perf_codex_projections WHERE home_id NOT IN (${placeholders})`)
            .all(...keep)
            .map((row) => String(row.path));
        }
      } catch {
        counters.writeFailures += 1;
        return dropped;
      }
      if (victims.length === 0) return dropped;
      const ok = runInSavepoint(() => {
        const statement = database.prepare(DELETE_ROW);
        for (const victim of victims) statement.run(victim);
      });
      if (ok) counters.retainedRows += victims.length;
      return dropped;
    },

    /**
     * 方法版本变更的**定向**失效：只删 `method_version <> 当前值` 的行，返回**前后行数**。
     *
     * 这是"只失效必要行、**严禁**无条件标脏全库"（卡面明文）的显式入口；`lookup()` 里那条同规则的
     * 逐行删除是它的按需版本。**不**动 `source_files` / `events` / `perf_samples` 一个字节。
     * @returns {{ before: number | null, after: number | null, deleted: number, methodVersion: string }}
     */
    invalidateStaleMethodVersions() {
      const before = readRowCount();
      let deleted = 0;
      if (database) {
        const ok = runInSavepoint(() => {
          deleted = Number(
            database.prepare("DELETE FROM perf_codex_projections WHERE method_version <> ?").run(currentMethodVersion)
              .changes ?? 0,
          );
        });
        if (!ok) deleted = 0;
      }
      counters.invalidatedRows += deleted;
      return { before, after: readRowCount(), deleted, methodVersion: currentMethodVersion };
    },

    /** 只清**内存**侧：设计页 §4 明文 `close()` **不清表**（跨实例复用正是 T2 的目的）。 */
    clear() {
      inner.clear();
      freshRows.clear();
    },

    /** 只读视图，透传内存（证据/测试用；调用方不得改写）。 */
    entries() {
      return inner.entries();
    },

    /** 当前生效的复合方法版本（= `entries()[].methodVersion`）。 */
    methodVersion() {
      return currentMethodVersion;
    },

    /**
     * 私有表的行数（诊断用，**另开**：刻意不进 `stats()`）。
     *
     * 为什么必须另开（C3 政策断言会踩到的陷阱）：`stats().entries` 是**纯内存**口径，C3 断言
     * "sync 后 entries === 3"、"close() 后 entries === 0"。持久化存在的意义正是"内存归零但投影不丢"
     * ⇒ 若把持久行也算进 `stats()`，那两条断言会因**表里的行**而虚高/不复零，语义也错。
     * @returns {number | null} `null` = 读不到（连接不可用）
     */
    persistedRowCount() {
      return readRowCount();
    },

    stats() {
      return {
        ...inner.stats(),
        persistence: { table: CODEX_PROJECTION_STORE_TABLE, methodVersion: currentMethodVersion, ...counters },
      };
    },
  };
}

/**
 * @typedef {object} PerfStateProjection
 * @property {"uninitialized" | "rebuilding" | "ready" | "degraded"} state
 * @property {string} indexVersion
 * @property {string} methodVersion
 * @property {string} indexedAt
 * @property {string[]} degradedHomeIds
 * @property {{sourceKind: string, homeId: string, code: string, count: number}[]} sourceWarnings
 * @property {{path: string, kind: string, homeId: string, homeLabel: string, homePath: string, missingSinceMs: number}[]} missingSources
 * @property {string | undefined} codexPublicationPolicy
 */

/** 解码 `store_meta` 里的 JSON 字符串数组；缺键/坏值一律 `[]`（不抛错，读取路径不得因元数据坏掉而失败）。 */
function decodeJsonStringArray(raw) {
  if (raw === undefined || raw === "") return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => typeof entry === "string");
  } catch {
    return [];
  }
}

/**
 * Decode retained-but-missing source identities. Missing sources keep their
 * `source_files` row so facts and native ownership remain queryable; this
 * metadata only adds the current physical-availability state.
 */
function decodeMissingSources(raw) {
  if (raw === undefined || raw === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry) => entry && typeof entry === "object" && typeof entry.path === "string" && entry.path !== "")
    .map((entry) => ({
      path: String(entry.path),
      kind: String(entry.kind ?? ""),
      homeId: String(entry.homeId ?? ""),
      homeLabel: String(entry.homeLabel ?? ""),
      homePath: String(entry.homePath ?? ""),
      missingSinceMs: Number.isSafeInteger(Number(entry.missingSinceMs)) ? Number(entry.missingSinceMs) : 0,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * 解码 `perf_source_warnings`。**只投影编码后的 `sourceKind/homeId/code/count`**，
 * **绝不输出路径**（卡片明文）。形状不符的条目**丢弃**而不是猜测补齐。
 * @returns {{sourceKind: string, homeId: string, code: string, count: number}[]}
 */
function decodeJsonWarnings(raw) {
  if (raw === undefined || raw === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      sourceKind: String(entry.sourceKind ?? ""),
      homeId: String(entry.homeId ?? ""),
      code: String(entry.code ?? ""),
      count: Number.isFinite(Number(entry.count)) ? Number(entry.count) : 0,
    }));
}

/** 退化 home id 规范化：去空白、去空串、去重、稳定排序（保证同输入同持久值）。 */
function normalizeDegradedHomeIds(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((entry) => String(entry).trim()).filter((entry) => entry !== ""))].sort();
}

/**
 * 源告警规范化：**只保留 `sourceKind/homeId/code/count` 四个字段**，
 * 从而在结构上保证**不写出路径**（即使上游多传了 `path` 也会被丢弃）。
 */
function normalizeSourceWarnings(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => ({
      sourceKind: String(entry?.sourceKind ?? "").trim(),
      homeId: String(entry?.homeId ?? "").trim(),
      code: String(entry?.code ?? "").trim(),
      count: Number.isFinite(Number(entry?.count)) ? Number(entry.count) : 0,
    }))
    .filter((entry) => entry.sourceKind !== "" || entry.homeId !== "" || entry.code !== "");
}

function normalizePublishedFileWarnings(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const [normalized] = normalizeSourceWarnings([entry]);
    if (!normalized) return [];
    if (normalized.code !== PROJECT_LOG_MALFORMED_LINE_WARNING_CODE) return [normalized];
    const lineNumbers = Array.isArray(entry?.lineNumbers)
      ? [...new Set(entry.lineNumbers.map(Number).filter((line) => Number.isSafeInteger(line) && line > 0))].sort(
          (left, right) => left - right,
        )
      : [];
    return [{ ...normalized, lineNumbers }];
  });
}

function formatProjectLogTruncationWarning(filePath, lostEvents) {
  return `project-log 来源文件缩短（截断）：${filePath}（丢失 ${Number(lostEvents)} 条事件）`;
}

function formatProjectLogMalformedLineWarning(filePath, lineNumber) {
  return `project-log 来源存在无法解析的 JSONL 行：${filePath}（第 ${Number(lineNumber)} 行）`;
}

function recordUnitBoundaries(key, unit, zone = "local") {
  if (unit === "day") {
    const start = parseDateKey(key, zone);
    return start ? [start.getTime(), addDaysMs(start, 1)] : null;
  }
  if (unit === "week") {
    const start = parseDateKey(key, zone);
    return start ? [start.getTime(), addDaysMs(start, 7)] : null;
  }
  const match = /^(\d{4})-(\d{2})$/.exec(key || "");
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  return zone === "utc"
    ? [Date.UTC(year, month, 1), Date.UTC(year, month + 1, 1)]
    : [new Date(year, month, 1).getTime(), new Date(year, month + 1, 1).getTime()];
}

function parseDateKey(key, zone = "local") {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  return zone === "utc" ? new Date(Date.UTC(year, month, day)) : new Date(year, month, day);
}

function addDaysMs(date, days) {
  return date.getTime() + days * 24 * 60 * 60 * 1000;
}

function completeHistoryRollupDays(database, events, calendarZone = "utc") {
  const days = new Set();
  let firstMs = Infinity;
  let lastMs = -Infinity;
  if (events === null) {
    const bounds = database
      .prepare("SELECT MIN(timestamp_ms) AS first_ms, MAX(timestamp_ms) AS last_ms FROM events")
      .get();
    if (bounds.first_ms !== null) {
      firstMs = Number(bounds.first_ms);
      lastMs = Number(bounds.last_ms);
    }
  } else {
    for (const event of events) {
      const timestamp = Date.parse(event.timestamp);
      if (!Number.isFinite(timestamp)) throw new TypeError("complete history contains an invalid event timestamp");
      firstMs = Math.min(firstMs, timestamp);
      lastMs = Math.max(lastMs, timestamp);
    }
  }
  if (firstMs <= lastMs) {
    const firstUtcDay = new Date(Math.floor(firstMs / 86_400_000) * 86_400_000);
    const lastUtcDay = new Date(Math.floor(lastMs / 86_400_000) * 86_400_000);
    const utcDays = [];
    for (let cursor = firstUtcDay; cursor.getTime() <= lastUtcDay.getTime(); cursor = new Date(addDaysMs(cursor, 1))) {
      utcDays.push(cursor.toISOString().slice(0, 10));
    }
    if (calendarZone === "utc") {
      for (const day of utcDays) days.add(day);
    } else {
      // The module owns local calendar iteration so DST days are not fixed 24h steps.
      const firstLocalDay = localDateKey(new Date(firstMs));
      const lastLocalDay = localDateKey(new Date(lastMs));
      for (const day of localUsageRollupDaysForUtcDays(utcDays)) {
        if (day >= firstLocalDay && day <= lastLocalDay) days.add(day);
      }
    }
  }
  const tables = ["usage_rollup_days", "usage_rollup_daily", "usage_rollup_sessions"];
  // Model rows are lazily created by a non-empty rebuild, so a fresh store may not have this table yet.
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_rollup_models'").get()) {
    tables.splice(2, 0, "usage_rollup_models");
  }
  const sources = tables.map((table) => `SELECT day_key FROM ${table} WHERE calendar_zone = ?`).join(" UNION ");
  for (const row of database.prepare(sources).all(...tables.map(() => calendarZone))) {
    days.add(String(row.day_key));
  }
  return [...days].sort();
}

function withScope(baseSql, scope) {
  return scope.sql ? `${baseSql} AND ${scope.sql}` : baseSql;
}

/**
 * S1（published 映射解码复用）：**同步轮次内**复用的已解码 published 映射视图。
 *
 * 修复前两份 sidecar map（`perf_file_fingerprints` / `perf_file_warnings`）在逐文件校验
 * 循环里被**反复**取串 + `JSON.parse` + 归一化（真实隔离输入单轮实测 453 / 456 次解码）。
 * 本视图让**同一轮**内只解码一次，是全轮唯一的权威取值来源。
 *
 * 语义边界（**不是**通用长期缓存，也不是 `readMetaRaw` 缓存）：
 * - 生命周期 = 单个 `sync()` 调用：`sync()` 建立，轮末（成功/抛错）一律丢弃；
 * - `sync()` 之外 `store.publishedFileMapsView === null` ⇒ 读路径与修复前**逐字相同**；
 * - 两份 map 每轮**至多解码一次**（首次访问才解码）；
 * - **只有成功 `COMMIT` 之后**才用已提交的对象更新视图；事务 `ROLLBACK`/抛错时视图保持旧值
 *   ⇒ 失败轮次的新值**不会**泄漏进视图；
 * - `fingerprintsForRound()` / `warningsForRound()` 返回**新对象**（与
 *   `readPublishedFileFingerprints()` 每次新建对象的既有契约一致）⇒ 调用方的 `delete`/
 *   展开不会污染视图。
 *
 * @param {UsageStore} store
 */
function createPublishedFileMapsView(store) {
  return {
    /** @type {Record<string, string> | null} */
    fingerprints: null,
    /** @type {Record<string, {sourceKind: string, homeId: string, code: string, count: number, lineNumbers?: number[]}[]> | null} */
    warnings: null,
    /** Internal readers must not mutate these committed maps. */
    readFingerprints() {
      if (this.fingerprints === null) this.fingerprints = store.readPublishedFileFingerprints();
      return this.fingerprints;
    },
    readWarnings() {
      if (this.warnings === null) this.warnings = store.readPublishedFileWarnings();
      return this.warnings;
    },
    fingerprintsForRound() {
      return { ...this.readFingerprints() };
    },
    warningsForRound() {
      return { ...this.readWarnings() };
    },
    /**
     * 成功 `COMMIT` 之后写回视图。`null` = 本次提交**没有改**这份 map
     * （Codex 文件事务只写告警；已启用非 Codex 文件事务两份都写）。
     * @param {Record<string, string> | null} fingerprints
     * @param {Record<string, {sourceKind: string, homeId: string, code: string, count: number, lineNumbers?: number[]}[]> | null} warnings
     */
    commit(fingerprints, warnings) {
      if (fingerprints !== null) this.fingerprints = { ...fingerprints };
      if (warnings !== null) this.warnings = { ...warnings };
    },
  };
}

export class UsageStore {
  constructor(options = {}) {
    this.options = options;
    this.nativeTimingThreads = new Map();
    /** Last successfully published live and retained path sets, by Codex home. */
    this.codexPublishedPaths = new Map();
    this.metadataCache = null;
    /**
     * D4：`metadata()` 观测聚合的**静态输入**（`events` 未过滤分组行 + 全表最大 timestamp）。
     *
     * 契约（本卡红线）：缓存里**只有静态输入**——数据库行本身；`asOf` 的**未来事件过滤**与
     * `buildModelActivity` 的时间派生量一律每次现算。命中条件见 {@link UsageStore#metadata}。
     * @type {{ revision: number, rows: object[], maxTimestampMs: number } | null}
     */
    this.metadataObservationCache = null;
    /** Period-comparison results keyed by time scope and the catalog used for model normalization. */
    this.periodComparisonCache = new Map();
    /**
     * W4-b1 / D1：**实例私有**的"事件级计价" memo（跨形状共享）。
     *
     * 键 = `eventCostMemoKey(event)` = 事件**全部计价输入** + `activePricing.version`（`pricing.js`）；
     * 值 = `estimateEventCost(event)` 的返回对象。**不含** `preset`/`bucket`/`calendarZone`/`excludeHomes`/
     * `now` ⇒ 同一份事件在 `today` / `all` 等不同形状间只算一次（R1 "命中也在付" 的止血点）。
     *
     * 有界与失效（卡面红线）：
     *   * **有界**：默认 64 MiB；`beginRound`/`endRound` 期间放宽到 192 MiB（规格 `:159` 的首轮上限），
     *     轮末收敛回 64 MiB；超出按插入顺序逐出最旧条目（逐出只影响**成本**，不影响**正确性**）；
     *   * **失效**：`syncDerivedRevision()`（= `storeRevision` 前进）与 `close()` 清空。由于键里已含
     *     "内容 + 价目版本"，清空**只影响内存**、不会造成陈旧命中 —— 这是**保守**的额外失效，不是
     *     正确性的必要条件（契约见 `pricing.js:createEventCostMemo`）。
     */
    this.eventCostMemo = createEventCostMemo();
    this.databaseFile =
      options.databaseFile || path.join(options.homeDir || os.homedir(), ".codex-usage", "usage-index.sqlite");
    this.database = null;
    /** Per-read model catalog context for the `usage_model_group` UDF. */
    this.readPricingModels = null;
    this.homes = [];
    this.warnings = [];
    this.generatedAt = "";
    this.fingerprint = "";
    this.checkedAt = "";
    this.repositoryResolver = createRepositoryResolver();
    this.serviceTierEvidence = null;
    this.quotaSourceEvidence = null;
    this.quotaSourceLookup = quotaSourceResolver([]);
    this.quotaSourceRevision = -1;
    /** S1：**同步轮次内**已解码的 published 映射视图（轮外恒为 `null`）。 */
    this.publishedFileMapsView = null;
    /**
     * C1 卡：**实例私有**的"稳定失败尝试记录"（`homeId → record`）。
     *
     * 只承载**确定性内容失败**（见 {@link CODEX_DETERMINISTIC_FAILURE_CODES}）的稳定验证结果，
     * 用于在下一轮**跳过整 home 全文规划**。它不是通用缓存、不进 schema、不进公开 report、
     * 不跨实例：`close()` 清空（卡面"实例私有"、"close/open 使记录失效"）。
     */
    this.codexStableAttempts = new Map();
    /**
     * S4：WorkBuddy **trace 文件指纹**（`path → { size, mtimeMs }`）。
     *
     * 刻意是**进程内 Map**（实施计划 §0 第 5/6 条）：跨轮保留、进程重启自然清空 ⇒ 首轮自动全扫，
     * 零 schema 成本，也不建 trace 指纹表。`sync()` **不清空**（否则每轮都会重解析全部 trace）；
     * 只有 `close()` 丢弃。
     * @type {Map<string, string>}
     */
    this.workbuddyTraceFingerprints = new Map();
    this.workbuddyTimingSpans = new Map();
    this.workbuddyTextTimingLookups = new Map();
    this.workbuddyTextMessageIds = new Map();
    /**
     * C3 卡：**实例私有**的"未变文件标准化投影"缓存（`readCodexRolloutMetadata` 的返回对象）。
     *
     * 键 = 规范物理路径，身份 = **本轮读取前的窗口指纹 + 来源 + 方法版本 + home**。
     * 只有**稳定窗口**（读取前/后内容指纹与路径集逐字一致）的投影才会被提升为可复用条目；
     * 替换 / 删除 / home 消失 / `close()` 四条淘汰路径见 `prune` / `retainHomes` / `clear`。
     * 容量（1×/2×/4×）由 C6 裁定；本卡只保证**有界**（每路径至多一条 + 默认 64 MiB LRU 上限）。
     *
     * **T2 卡（2026-10-09）**：这里只是"**未 open** 的缺省值"（纯内存，与 T1 接线前逐字节等价）。
     * 一旦 `open()` 成功，本字段会被换成 T1 的**私有持久投影**包装（`open()` 尾部一行）——内存侧
     * 语义完全不变（同一个 `createCodexProjectionCache()` 作 `inner`），多出来的只是"内存未命中时
     * 再查一次 `perf_codex_projections`"。因此原注释里"不落盘、不跨实例"只对**内存侧**成立：
     * 投影**可以**跨 `close()/open()` 与跨进程复用（这正是 T2 的目的），但**不入** `store_meta`、
     * **不进**公开 report、**不新增** meta 键。
     */
    /** @type {ReturnType<typeof createPersistentCodexProjectionCache>} */
    this.codexProjections = /** @type {any} */ (createCodexProjectionCache());
    /**
     * C4 卡：**最近一轮**的"受影响 / 原样保留"线程集合（`homeId → {staged, retained}`）。
     *
     * 只作**证据与测试**的只读视图：不参与任何产品判定，不进 schema、不进公开 report、不落盘、
     * 不跨实例（`close()` 清空）。每轮在被规划到的 home 上覆盖式写入 ⇒ 无跨轮累积。
     * * `staged` = 本轮**重新构建**候选的线程（`codexThreadNeedsBuild` 判为 true）；
     * * `retained` = 本轮**未受影响**、因此其已发布候选被**原样保留**（不 delete/insert）的线程。
     * 发布阶段"旧线程是否已不存在"用的是同一份当前线程集（见 `plan.threadPaths`）。
     * @type {Map<string, {staged: string[], retained: string[]}>}
     */
    this.codexThreadBuildPlan = new Map();
    // ── D1 卡：实例修订 + 外部提交检测 ────────────────────────────────────────────────────────
    /**
     * D1：**实例修订号** —— "这个实例看到的、**已提交的**库内容"的版本。
     *
     * 只在**成功的提交**上 +1（见 {@link UsageStore#commitStoreRevision} 的各调用点）：
     *   * **用量**：`replaceFile` 的 `COMMIT`（`source_files` + `events`，以及同一事务里的
     *     `rate_limit_observations` ⇒ **quota** 观测行）；
     *   * **perf 发布**：codex 发布事务的 `COMMIT`（staged/replaced 线程写候选）；
     *   * **真删除**：codex 发布事务里的 `DELETE FROM source_files`、非 codex 来源的真实删除；
     *   * **读取窗口内变化**：置脏 `UPDATE source_files SET size = -1, mtime_ms = -1`；
     *   * **home**：home 集合形状变化（`homeSetChanged`）；
     *   * **service-tier evidence**：证据**输入**签名变化（见 {@link UsageStore#serviceTierEvidenceSignature}）。
     *
     * ⚠️ **例行时刻元数据不作为用量变化**（卡面明文）：`generated_at` / `perf_indexed_at` /
     * `checkedAt` / 每轮重写的 `perf_file_fingerprints` 都**不**推进修订 —— 否则每个 no-op 轮都会
     * 失效派生缓存，C5 已接受的"无实际变更保留派生缓存"契约当场被破坏。
     *
     * 另一条腿是**外部提交**（别的连接提交的）：`PRAGMA data_version` 只会因**其他连接**的提交而变，
     * 本连接自己的提交**不**改它 ⇒ 两条腿必须分开，见 {@link UsageStore#detectExternalCommit}。
     */
    this.storeRevision = 0;
    /** D1：派生缓存（`metadataCache` / `periodComparisonCache`）当前对齐到的修订。 */
    this.derivedRevision = 0;
    /** 内部读快照：命中时跳过嵌套修订探测；共享缓存仍按快照前修订读写。 */
    this.periodComparisonSnapshotRead = false;
    /** Metadata history reads pin the marker and synchronous metadata in one savepoint. */
    this.metadataSnapshotRead = false;
    /** Summary history reads use the same guard for their marker + hot-summary savepoint. */
    this.summarySnapshotRead = false;
    /** D1：本连接上一次观察到的 `PRAGMA data_version`（外部提交检测的基准，`open()` 里取初值）。 */
    this.observedDataVersion = 0;
    /** D1：检出过多少次**外部提交**（诊断用；不落盘、不进 report、不建计数表）。 */
    this.externalCommitCount = 0;
    /** D1：最近一次推进修订的理由（诊断用；同上）。 */
    this.lastCommitReason = "";
    /**
     * D1：本连接上**自己开的**写事务深度（只有 `replaceFile` 会跨 `await`，因此只需要它）。
     * `> 0` ⇒ 读路径读到的是**未提交**状态 ⇒ `metadata()` / `periodComparison()` **不落**派生缓存
     * （验收："事务内已读的派生缓存被安全清理"；预防 + 回滚时再清一次，见
     * {@link UsageStore#rollbackReplaceFileTransaction}）。
     */
    this.writeTransactionDepth = 0;
    /** D1：`service-tier evidence` 的输入签名（`null` = 还没算过；见 `serviceTierEvidenceSignature`）。 */
    this.serviceTierEvidenceInput = null;
    /**
     * D2：**完整 scope 的历史冠军** memo（单槽，见 {@link UsageStore#recordsForRange}）。
     *
     * 实例私有、不落盘、不进 schema、不进公开 report：`key` 是六项输入的规范串
     * （数据修订 / 价目版本 / 汇率 / service-tier evidence 签名 / 时区 / 规范排除集合），
     * `champions` 是 `buildRecordChampions()` 的产物。键不等 ⇒ 立即重算；
     * 写事务内（`writeTransactionDepth > 0`）**不读也不写**（D1 的回滚语义）。
     * `close()`/`open()` 一律复位（连接级状态）。
     * @type {{ key: string, champions: Record<string, Record<string, { period: string, value: number }>> } | null}
     */
    this.recordChampionCache = null;
    /**
     * C19 static summary projection: one instance-private all-hot entry for
     * timeline/cost, perf and grouped detail rows. Dynamic range/quota/clock/status
     * remain outside this slot.
     * @type {{ key: string, factsKey: string, perfKey?: string, contextKey?: string, context?: any, guard?: any, evidence?: any, projection: object, quoteInputs: HistoryQuoteInputs | null } | null}
     */
    this.summaryProjectionCache = null;
    /** @type {{ database: DatabaseSync, mainSchema: number, tempSchema: number } | null} */
    this.usageProjectionTracker = null;
    this.observedUsageProjectionChanges = "";
    this.summaryProjectionTransferableRead = false;
    this.openedUsageProjectionIdentity = null;
    this.openedUsageProjectionChanges = -1;
    /** SQL history projections stay separate from every hot-only public reader. */
    this.historySqlDashboardCache = null;
    this.verifiedHistorySqlRead = false;
    /**
     * D3：**已提交 quota 观测的规范映射**（单槽，见 {@link UsageStore#quotaObservations}）。
     *
     * 契约（本卡红线）：缓存里**只有静态输入**——`rate_limit_observations` 已提交行的字段映射。
     * **不含**任何时间派生字段（窗口边界 / `state` / `percentStale` / 倒计时 / reset 语义）：
     * 那些一律由消费者**每次**用当前或冻结的 `asOf` 现算（`selectQuotaWindows(rows, asOf)`、
     * `resolveDateRange({ …filters, now: asOf, quota })`），因此"冻结快照"与"live 读数"各按自己的
     * `asOf` 成立。
     *
     * 键 = D1 的实例修订（`storeRevision`）；`syncDerivedRevision()` / `open()` / `close()` 复位；
     * 写事务内（`writeTransactionDepth > 0`）**不读也不写**（D1 的回滚语义）。
     * @type {{ revision: number, rows: object[] } | null}
     */
    this.quotaObservationCache = null;
  }

  async open() {
    if (this.database) {
      return;
    }
    this.metadataCache = null;
    this.periodComparisonCache.clear();
    // D4：观测聚合缓存同为连接级状态（键含实例修订，但连接/库可能已换）⇒ 重开时一并复位。
    this.metadataObservationCache = null;
    // D2：历史冠军 memo 是**连接级**状态（键含实例修订，但连接/库可能已换）⇒ 重开时一并复位。
    this.recordChampionCache = null;
    this.summaryProjectionCache = null;
    // D3：quota 观测映射同为连接级状态（键含实例修订，但连接/库可能已换）⇒ 重开时一并复位。
    this.quotaObservationCache = null;
    await mkdir(path.dirname(this.databaseFile), { recursive: true });
    this.database = new DatabaseSync(this.databaseFile);
    this.registerReadFunctions();
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA journal_size_limit = 67108864;
      CREATE TABLE IF NOT EXISTS store_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_files (
        path TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        home_id TEXT NOT NULL,
        home_label TEXT NOT NULL,
        home_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        indexed_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
        timestamp_ms INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        home_id TEXT NOT NULL,
        home_label TEXT NOT NULL,
        channel TEXT NOT NULL,
        project TEXT NOT NULL,
        model TEXT NOT NULL,
        hour_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        week_key TEXT NOT NULL,
        month_key TEXT NOT NULL,
        cwd TEXT NOT NULL DEFAULT '',
        repository_key TEXT NOT NULL DEFAULT 'unknown:cwd',
        repository_path TEXT NOT NULL DEFAULT 'Unknown cwd',
        repository_kind TEXT NOT NULL DEFAULT 'unknown',
        detail_mask INTEGER NOT NULL DEFAULT 0,
        reconciliation_gap INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_known INTEGER NOT NULL DEFAULT 0,
        request_input_tokens INTEGER NOT NULL DEFAULT 0,
        context_level TEXT NOT NULL DEFAULT 'unknown',
        service_tier TEXT NOT NULL DEFAULT 'unknown',
        price_version TEXT NOT NULL DEFAULT '',
        total INTEGER NOT NULL,
        input INTEGER NOT NULL,
        cached INTEGER NOT NULL,
        output INTEGER NOT NULL,
        reasoning INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS rate_limit_observations (
        source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
        line_number INTEGER NOT NULL CHECK (line_number > 0),
        role TEXT NOT NULL CHECK (role IN ('primary', 'secondary')),
        observed_at_ms INTEGER NOT NULL,
        limit_id TEXT NOT NULL,
        limit_name TEXT,
        plan_type TEXT,
        window_minutes REAL NOT NULL CHECK (window_minutes > 0),
        resets_at_ms INTEGER NOT NULL,
        used_percent REAL CHECK (used_percent IS NULL OR (used_percent >= 0 AND used_percent <= 100)),
        PRIMARY KEY (source_path, line_number, role)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_timestamp_idx ON events(timestamp_ms);
      CREATE INDEX IF NOT EXISTS events_home_idx ON events(home_id);
      CREATE INDEX IF NOT EXISTS events_channel_idx ON events(channel);
      CREATE INDEX IF NOT EXISTS events_project_idx ON events(project);
      CREATE INDEX IF NOT EXISTS events_model_idx ON events(model);
      CREATE INDEX IF NOT EXISTS rate_limit_window_lookup_idx ON rate_limit_observations(limit_id, window_minutes, observed_at_ms DESC);
      CREATE INDEX IF NOT EXISTS rate_limit_source_line_idx ON rate_limit_observations(source_path, line_number);
    `);
    let version = Number(this.database.prepare("PRAGMA user_version").get().user_version || 0);
    /**
     * 独立事务的迁移段：`BEGIN IMMEDIATE` → SQL → **事务内自检** → 抬版本 → `COMMIT`。
     * `verify` 可选：只在事务内核对"实际 schema 等于冻结 DDL"，不符即抛 ⇒ `ROLLBACK` ⇒
     * 版本保持旧值（不得把旧索引当成已升级；`CREATE TABLE IF NOT EXISTS` 会静默接受错形状的旧表）。
     * @param {string} sql @param {number} nextVersion @param {(() => void) | undefined} [verify]
     */
    const migrate = (sql, nextVersion, verify) => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(sql);
        if (verify) verify();
        this.database.exec(`PRAGMA user_version = ${nextVersion}`);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        this.database.close();
        this.database = null;
        throw error;
      }
    };
    if (version === 1) {
      migrate(
        [
          "ALTER TABLE events ADD COLUMN cwd TEXT NOT NULL DEFAULT '';",
          "ALTER TABLE events ADD COLUMN repository_key TEXT NOT NULL DEFAULT 'unknown:cwd';",
          "ALTER TABLE events ADD COLUMN repository_path TEXT NOT NULL DEFAULT 'Unknown cwd';",
          "ALTER TABLE events ADD COLUMN repository_kind TEXT NOT NULL DEFAULT 'unknown';",
          "ALTER TABLE events ADD COLUMN detail_mask INTEGER NOT NULL DEFAULT 0;",
          "ALTER TABLE events ADD COLUMN reconciliation_gap INTEGER NOT NULL DEFAULT 0;",
          "UPDATE events SET cwd = project;",
          "UPDATE source_files SET size = -1, mtime_ms = -1;",
        ].join("\n"),
        2,
      );
      version = 2;
    }
    if (version === 2) {
      migrate(
        [
          "ALTER TABLE events ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;",
          "ALTER TABLE events ADD COLUMN cache_write_known INTEGER NOT NULL DEFAULT 0;",
          "ALTER TABLE events ADD COLUMN request_input_tokens INTEGER NOT NULL DEFAULT 0;",
          "ALTER TABLE events ADD COLUMN context_level TEXT NOT NULL DEFAULT 'unknown';",
          "ALTER TABLE events ADD COLUMN service_tier TEXT NOT NULL DEFAULT 'unknown';",
          "ALTER TABLE events ADD COLUMN price_version TEXT NOT NULL DEFAULT '';",
          "UPDATE source_files SET size = -1, mtime_ms = -1;",
        ].join("\n"),
        3,
      );
      version = 3;
    }
    if (version === 3) {
      migrate(
        `
        UPDATE source_files SET size = -1, mtime_ms = -1
        WHERE path IN (SELECT DISTINCT source_path FROM events WHERE context_level = 'unknown' AND total > 0);
      `,
        4,
      );
      version = 4;
    }
    if (version === 4) {
      migrate(
        `
        UPDATE source_files SET size = -1, mtime_ms = -1
        WHERE path IN (
          SELECT source_path FROM events WHERE session_id IN (
            SELECT session_id FROM events GROUP BY session_id HAVING COUNT(DISTINCT source_path) > 1
          )
        );
      `,
        5,
      );
      version = 5;
    }
    if (version === 5) {
      migrate(
        `
        UPDATE source_files SET size = -1, mtime_ms = -1
        WHERE kind IN ('main', 'jetbrains', 'extra', 'codex')
          AND lower(path) LIKE '%.jsonl';
      `,
        6,
      );
      version = 6;
    }
    if (version === 6) {
      // Earlier quota parsing looked for limit_id inside primary/secondary.
      // Codex writes it on rate_limits, so unchanged session files need a reindex.
      migrate(
        `
        UPDATE source_files SET size = -1, mtime_ms = -1
        WHERE kind IN ('main', 'jetbrains', 'extra', 'codex')
          AND lower(path) LIKE '%.jsonl';
      `,
        7,
      );
      version = 7;
    }
    if (version === 7) {
      // A new rollout can inherit cumulative token counters from another
      // conversation. Recompute Codex events from their first request usage.
      migrate(
        `
        UPDATE source_files SET size = -1, mtime_ms = -1
        WHERE kind IN ('main', 'jetbrains', 'extra', 'codex')
          AND lower(path) LIKE '%.jsonl';
      `,
        8,
      );
      version = 8;
    }
    if (version === 8) {
      // v9 新增 DSH 数据源。表结构没变，因此无需重扫既有数据；
      // 旧索引里不存在 kind='dsh' 的行，升级后第一次 sync 会直接纳入它们。
      // 这里只抬版本号，为将来真正需要重扫的迁移留出位置。
      // 落点必须用字面量：若用 STORE_SCHEMA_VERSION 常量，后续抬版本会静默跳过新迁移。
      migrate("SELECT 1;", 9);
      version = 9;
    }
    if (version === 9) {
      // v10 新增 OpenCode 数据源。同 v9，表结构没变，只抬版本号；
      // 旧索引里不存在 kind='opencode' 的行，升级后第一次 sync 会直接纳入它们。
      migrate("SELECT 1;", 10);
      version = 10;
    }
    if (version === 10) {
      // DSH v4 input is uncached input. Re-read unchanged source files so
      // nonzero cache writes become part of total input in historical events.
      migrate("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE kind = 'dsh';", 11);
      version = 11;
    }
    if (version === 11) {
      // v12 是自 v2 以来首次真正 CREATE TABLE 的迁移（AN-5）：建 `perf_samples` + 三个索引，
      // 并在**同一事务内**执行无 WHERE 的标脏（让既有三源重新提取候选，方案 §4:58）。
      //
      // ① 落点用**字面量** 12（不用常量）：常量落点会让后续抬版本静默跳过新迁移（`:399` 的既有约定）。
      // ② 自检**必须在事务内**：`CREATE TABLE IF NOT EXISTS` 撞上错形状的旧表 / 同名 VIEW，
      //    或索引名被别的表占用时都会**静默通过**；自检失败即回滚，`user_version` 保持 11，
      //    下次打开重试，不会留下"标了 12 却没有表"的半成品。
      // ③ 这段必须留在**这里**，不得挪进上面那个无条件的建表块：那个块在读取版本号之前执行、
      //    且在事务之外，一旦挪过去，失败的迁移会留下已建的 `perf_samples`（gate H 的实测会变红）。
      //
      // 没有这一支，`STORE_SCHEMA_VERSION = 12` 会让所有既有 v11 真库在下面的守卫处直接抛错（AN-2）。
      migrate(`${PERF_SAMPLES_DDL}\nUPDATE source_files SET size = -1, mtime_ms = -1;`, 12, () =>
        assertPerfSamplesSchema(this.database),
      );
      version = 12;
    }
    if (version === 12) {
      // M7 stores cross-rollout sample dependencies and the stable thread identity
      // of every Codex rollout, including files that currently produce no sample.
      // Re-read Codex JSONL so the new identity table is complete before publication.
      migrate(
        `${PERF_CODEX_INDEX_DDL}\nUPDATE source_files SET size = -1, mtime_ms = -1 WHERE kind IN ('main', 'jetbrains', 'extra', 'codex') AND lower(path) LIKE '%.jsonl';`,
        13,
        () => assertPerfCodexIndexSchema(this.database),
      );
      version = 13;
    }
    if (version === 13) {
      // T1（本计划**首次** schema bump）：只建 Codex 投影私有表 + `(home_id)` 索引，**不回填**。
      //
      // ① 落点用**字面量**（`version === 13` / `migrate(..., 14)`），与上面各段同一约定：
      //    只要用常量落点，后续抬版本就会静默跳过新迁移。
      // ② **不回填**是设计要求（设计页 §3）：空表 ⇒ 迁移后第一次 sync 仍然全文读 ⇒ 与今日
      //    **逐字节等价**。这条有实测（`T1/verify-t1.mjs`：同一夹具上"旧程序 vs 新程序" A/B 对比）。
      // ③ 这里**不**做任何 `UPDATE source_files SET size = -1`（v12 段那种无条件标脏）：否则
      //    "只失效必要行、**不**无条件标脏全库"（卡面明文）当场失效。
      // ④ `IF NOT EXISTS` + 事务内自检 ⇒ 幂等且中断可重入：失败即 ROLLBACK，`user_version` 保持 13，
      //    下次打开重试；不会留下"标了 14 却没有表"的半成品。
      migrate(PERF_CODEX_PROJECTIONS_DDL, 14, () => assertPerfCodexProjectionsSchema(this.database));
      version = 14;
    }
    if (version === 14) {
      // v15 新增 Claude Code 数据源。同 v9（DSH）、v10（OpenCode）：表结构没变，只抬版本号；
      // 旧索引里不存在 kind='claude' 的行，升级后第一次 sync 会直接纳入它们。
      // 落点同样用字面量，避免后续抬版本时静默跳过新迁移。
      migrate("SELECT 1;", 15);
      version = 15;
    }
    if (version === 15) {
      // v16：Claude Code 的模型身份从 requestedModel（harness 别名/网关路由名）改为
      // message.model（API 实际服务的线路模型）。事件表结构没变，但已索引的 Claude 事件
      // 带着旧身份 ⇒ 必须重读这些转录，否则旧行会一直停在别名上。
      // 只标脏 kind = 'claude'：其它来源的解析语义未变，不为其付出全量重读。
      migrate("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE kind = 'claude';", 16);
      version = 16;
    }
    if (version === 16) {
      // v17：新增 WorkBuddy 数据源 + 其响应时长 side table。
      //
      // ① 落点用**字面量** 17（不用常量）：用常量会让后续抬版本静默跳过新迁移。
      // ② **不标脏任何既有文件**：新来源没有旧行，回填由首次 sync 自然触发；
      //    对既有来源做无条件 `UPDATE source_files` 只会白付一次全量重读。
      // ③ 自检必须在事务内：同名 VIEW 会让 `CREATE TABLE IF NOT EXISTS` 静默通过。
      migrate(WORKBUDDY_DURATION_DDL, 17, () => assertWorkbuddyDurationSchema(this.database));
      version = 17;
    }
    if (version === 17) {
      // v18 stores request timing evidence plus the affected-thread dirty set.
      // The adapter owns the only DDL; its empty import also verifies the
      // resulting table shape inside this migration transaction.
      migrate("SELECT 1;", 18, () => initializeRequestTimingSchema(this.database));
      version = 18;
    }
    if (version === 18) {
      // v19 keeps conflicting WorkBuddy trace durations instead of first-wins.
      // The legacy table and its rows stay untouched: without a home_id they
      // cannot be attributed safely, so they remain a read-only fallback.
      migrate(WORKBUDDY_DURATION_OBSERVATION_DDL, 19, () => assertWorkbuddyDurationObservationSchema(this.database));
      version = 19;
    }
    if (version === 19) {
      // v20 stores only event payloads replaced by a successful reparse.
      migrate(HISTORY_REPLACED_FACTS_DDL, 20, () => assertHistoryReplacedFactsSchema(this.database));
      version = 20;
    }
    if (version === 20) {
      // v21 reserves the archive directory. Registration and cold reads are wired by later cards.
      migrate(ARCHIVE_SEGMENTS_DDL, 21, () => assertArchiveSegmentsSchema(this.database));
      version = 21;
    }
    if (version === 21) {
      // Rebuild the CHECK without cascading away the existing dependency graph.
      this.database.exec("PRAGMA foreign_keys = OFF");
      try {
        migrate(
          `CREATE TEMP TABLE perf_samples_v3_migration AS SELECT * FROM perf_samples;
           DROP TABLE perf_samples;
           ${PERF_SAMPLES_DDL}
           INSERT INTO perf_samples SELECT * FROM temp.perf_samples_v3_migration;
           DROP TABLE temp.perf_samples_v3_migration;
           UPDATE source_files SET size = -1, mtime_ms = -1;`,
          22,
          () => {
            assertPerfSamplesSchema(this.database);
            initializeRequestTimingSchema(this.database);
            if (this.database.prepare("PRAGMA foreign_key_check").all().length > 0)
              throw new Error("TPS schema migration changed source dependencies");
          },
        );
        version = 22;
      } finally {
        this.database?.exec("PRAGMA foreign_keys = ON");
      }
    }
    if (version === 22) {
      migrate(
        `${QUOTA_SOURCES_DDL}
        UPDATE source_files SET size = -1, mtime_ms = -1 WHERE kind IN ('main', 'jetbrains', 'extra', 'codex');`,
        23,
      );
      version = 23;
    }
    if (version !== 0 && version !== STORE_SCHEMA_VERSION) {
      this.database.close();
      this.database = null;
      throw new Error(`不支持的用量索引版本：${version}`);
    }
    if (version === 0) {
      this.database.exec(QUOTA_SOURCES_DDL);
      // 全新库：这个分支被**无条件**标成常量当前值（AN-9），因此它**结构上不可能**覆盖
      // v11→12 迁移 —— 建表放在抬版本之前，中途失败留下的库仍是 version 0，下次打开可自愈。
      this.database.exec(PERF_SAMPLES_DDL);
      assertPerfSamplesSchema(this.database);
      this.database.exec(PERF_CODEX_INDEX_DDL);
      assertPerfCodexIndexSchema(this.database);
      // T1：全新库同样无条件建这张表（结构上与 v13→14 迁移不可互相覆盖：建表在抬版本之前，
      // 中途失败留下的库仍是 version 0，下次打开可自愈）。
      this.database.exec(PERF_CODEX_PROJECTIONS_DDL);
      assertPerfCodexProjectionsSchema(this.database);
      // v17：全新库同样无条件建时长表（结构上与 v16→17 迁移不可互相覆盖：建表在抬版本之前，
      // 中途失败留下的库仍是 version 0，下次打开可自愈）。
      this.database.exec(WORKBUDDY_DURATION_DDL);
      assertWorkbuddyDurationSchema(this.database);
      this.database.exec(WORKBUDDY_DURATION_OBSERVATION_DDL);
      assertWorkbuddyDurationObservationSchema(this.database);
      initializeRequestTimingSchema(this.database);
      this.database.exec(HISTORY_REPLACED_FACTS_DDL);
      assertHistoryReplacedFactsSchema(this.database);
      // v21: reserve the empty archive directory for later registration/cold-read cards.
      this.database.exec(ARCHIVE_SEGMENTS_DDL);
      assertArchiveSegmentsSchema(this.database);
      this.database.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`);
    }
    if (this.readMetaRaw(REQUEST_TIMING_PUBLICATION_SEQ_META) === undefined) {
      this.database
        .prepare("INSERT OR IGNORE INTO store_meta (key, value) VALUES (?, '0')")
        .run(REQUEST_TIMING_PUBLICATION_SEQ_META);
    }
    this.database.exec("CREATE INDEX IF NOT EXISTS events_repository_idx ON events(repository_key)");
    this.database.exec("CREATE INDEX IF NOT EXISTS events_source_path_idx ON events(source_path)");
    if (this.readMetaRaw("codex_rollout_reader_version") !== CODEX_ROLLOUT_READER_VERSION) {
      // Re-read existing Codex events once: readline used to split valid Unicode JSON strings.
      this.database.exec("BEGIN");
      try {
        this.database.exec(
          "UPDATE source_files SET size = -1, mtime_ms = -1 WHERE kind IN ('main', 'jetbrains', 'extra', 'codex')",
        );
        this.writeMeta("codex_rollout_reader_version", CODEX_ROLLOUT_READER_VERSION);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    this.generatedAt = this.readMeta("generated_at");
    const quotaEvidence = this.readMetaRaw("quota_source_log_evidence");
    if (quotaEvidence) this.quotaSourceEvidence = quotaSourceEvidenceFromSnapshot(JSON.parse(quotaEvidence));
    this.quotaSourceRevision = -1;
    this.fingerprint = this.readMeta("fingerprint");
    // ── T2 卡：把 T1 的**私有持久投影**接到 planner 实际使用的实例字段 ─────────────────────────
    // 位置必须在这里（`open()` 尾部），两个理由都是硬性的：
    //   ① 构造器里 `this.database` 还是 `null`（见构造函数首行）⇒ 那时接线等于**没有持久层**；
    //   ② 上面 `migrate(...14...)` / `version === 0` 两段已保证 `perf_codex_projections` 存在 ——
    //      提前接线会让每次 `lookup` 都撞 "no such table"（T1 的降级会把它记成 `writeFailures`
    //      并回落全文读：仍然是"正确"的，但那等于持久化没生效，且计数器会常年带噪）。
    // 语义：内存侧仍是同一个 `createCodexProjectionCache()`（缺省 64 MiB LRU，**预算不变**），
    // 只是 `lookup` 在内存未命中时**先查一次持久表**（指纹/方法版本/home/kind 四道守卫 + 损坏即
    // miss+删行），命中就水合返回 ⇒ `planCodexHomeThreads`（`codex-thread.js:583`）**不调用**
    // `readCodexRolloutMetadata()`。`stage/commit/rollback/prune/retainHomes/clear` 的事务与失效
    // 契约全部沿用 T1，一行未改。`close()` 只清内存侧、**不清表**（跨实例/跨进程复用正是本卡目的）。
    this.codexProjections = createPersistentCodexProjectionCache({ database: this.database });
    // ── D1 卡：外部提交检测的**基准** ──────────────────────────────────────────────────────────
    // 必须在**所有迁移/建表之后**取：上面那些 `BEGIN IMMEDIATE … COMMIT` 是**本连接**的提交，
    // `PRAGMA data_version` 不会因它们而变；而基准取早了会把"自己迁移"误判成"外部提交"。
    this.observedDataVersion = this.readDataVersion();
    // 两个派生缓存刚在上面清空 ⇒ 它们与当前修订是**对齐**的（`open()` 不是一次提交）。
    this.derivedRevision = this.storeRevision;
    this.observedUsageProjectionChanges = this.usageProjectionChangeKey();
    this.openedUsageProjectionIdentity = this.usageProjectionDatabaseIdentity();
    this.openedUsageProjectionChanges = Number(this.database.prepare("SELECT total_changes() AS value").get().value);
  }

  usageProjectionDatabaseIdentity() {
    try {
      const file = this.database
        .prepare("PRAGMA database_list")
        .all()
        .find((row) => row.name === "main")?.file;
      if (!file) return null;
      const physical = realpathSync(String(file));
      if (physical !== realpathSync(this.databaseFile)) return null;
      const info = statSync(physical, { bigint: true });
      return `${physical}\u0000${info.dev}\u0000${info.ino}`;
    } catch {
      return null;
    }
  }

  usageProjectionGuard() {
    try {
      if (this.verifiedHistorySqlRead || !this.usageProjectionChangeKey().startsWith("usage:")) return null;
      const identity = this.usageProjectionDatabaseIdentity();
      if (!identity || identity !== this.openedUsageProjectionIdentity) return null;
      // A failed version read cannot certify a transferable snapshot.
      const dataVersion = Number(this.database.prepare("PRAGMA data_version").get().data_version);
      if (!Number.isSafeInteger(dataVersion)) return null;
      return { database: this.database, identity, dataVersion, evidence: this.serviceTierEvidence };
    } catch {
      return null;
    }
  }

  captureUsageProjection() {
    try {
      const slot = this.summaryProjectionCache;
      if (!slot?.context || !slot.guard || !this.database || this.database.isTransaction || this.writeTransactionDepth)
        return null;
      const guard = this.usageProjectionGuard();
      if (!guard || Object.keys(guard).some((key) => guard[key] !== slot.guard[key])) return null;
      const { range, bucket, excludeHomes, includeDetails, pricingModels } = slot.context;
      const keys = this.summaryProjectionKeys(range, bucket, excludeHomes, includeDetails, pricingModels);
      if (keys.key !== slot.key) return null;
      return { source: this, slot, guard };
    } catch {
      return null;
    }
  }

  adoptUsageProjection(snapshot) {
    try {
      if (!snapshot || snapshot.source === this || !this.database?.isTransaction || this.writeTransactionDepth)
        return false;
      // Only a fresh reader may receive the writer's payload; local writes are not a published view.
      const changes = Number(this.database.prepare("SELECT total_changes() AS value").get().value);
      if (changes !== this.openedUsageProjectionChanges + (this.usageProjectionTracker ? 1 : 0)) return false;
      this.database.prepare("SELECT id FROM events LIMIT 1").get();
      const current = snapshot.source.captureUsageProjection();
      if (
        !current ||
        current.slot !== snapshot.slot ||
        Object.keys(current.guard).some((key) => current.guard[key] !== snapshot.guard[key])
      )
        return false;
      if (
        this.usageProjectionDatabaseIdentity() !== snapshot.guard.identity ||
        this.serviceTierEvidence !== snapshot.guard.evidence
      )
        return false;
      if (
        this.database
          .prepare("SELECT 1 FROM store_meta WHERE key IN (?, ?)")
          .get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META, HISTORY_ARCHIVE_PERF_AUTHORITY_META)
      )
        return false;
      const context = structuredClone(snapshot.slot.context);
      const { range, bucket, excludeHomes, includeDetails, pricingModels } = context;
      const keys = this.summaryProjectionKeys(range, bucket, excludeHomes, includeDetails, pricingModels);
      if (keys.contextKey !== snapshot.slot.contextKey) return false;
      const projection = {};
      for (const key of [
        "timeline",
        "timelineError",
        "costEstimate",
        "channels",
        "models",
        "homes",
        "projects",
        "repositories",
      ]) {
        if (Object.hasOwn(snapshot.slot.projection, key)) projection[key] = snapshot.slot.projection[key];
      }
      this.summaryProjectionCache = {
        ...keys,
        perfKey: "",
        context,
        evidence: this.serviceTierEvidence,
        projection: structuredClone(projection),
        quoteInputs: null,
      };
      return true;
    } catch {
      return false;
    }
  }

  installUsageProjectionTracker() {
    this.usageProjectionTracker = null;
    this.database.exec(`CREATE TEMP TABLE usage_projection_ignored_rows (value INTEGER NOT NULL) STRICT;
      INSERT INTO usage_projection_ignored_rows VALUES (0);`);
    const keys = USAGE_PROJECTION_IGNORED_META.map((key) => `'${key}'`).join(",");
    for (const table of [...USAGE_PROJECTION_IGNORED_TABLES, "store_meta"]) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        // REPLACE can silently remove an unrelated metadata row through its hidden rowid.
        if (table === "store_meta" && operation === "INSERT") continue;
        const references = operation === "INSERT" ? ["NEW"] : operation === "DELETE" ? ["OLD"] : ["OLD", "NEW"];
        const metadata =
          table === "store_meta" ? references.map((row) => `${row}.key IN (${keys})`).join(" AND ") : "1";
        const rowid = table === "store_meta" && operation === "UPDATE" ? " AND OLD.rowid = NEW.rowid" : "";
        const when = `(SELECT recursive_triggers FROM pragma_recursive_triggers) = 0 AND ${metadata}${rowid}`;
        this.database.exec(`CREATE TEMP TRIGGER usage_projection_${table}_${operation}
          AFTER ${operation} ON main.${table} WHEN ${when}
          BEGIN UPDATE usage_projection_ignored_rows SET value = value + 1; END;`);
      }
    }
    this.usageProjectionTracker = {
      database: this.database,
      mainSchema: Number(this.database.prepare("PRAGMA main.schema_version").get().schema_version),
      tempSchema: Number(this.database.prepare("PRAGMA temp.schema_version").get().schema_version),
    };
  }

  usageProjectionChangeKey(
    totalChanges = Number(this.database.prepare("SELECT total_changes() AS value").get().value),
  ) {
    const tracker = this.usageProjectionTracker;
    if (!tracker || tracker.database !== this.database) return `full:${totalChanges}`;
    const mainSchema = Number(this.database.prepare("PRAGMA main.schema_version").get().schema_version);
    const tempSchema = Number(this.database.prepare("PRAGMA temp.schema_version").get().schema_version);
    const recursive = Number(this.database.prepare("PRAGMA recursive_triggers").get().recursive_triggers);
    const fallback = `full:${mainSchema}:${tempSchema}:${recursive}:${totalChanges}`;
    // REPLACE's implicit delete is omitted from total_changes even when DELETE triggers fire.
    if (mainSchema !== tracker.mainSchema || tempSchema !== tracker.tempSchema || recursive !== 0) return fallback;
    if (
      this.database
        .prepare("SELECT 1 FROM store_meta WHERE key IN (?, ?)")
        .get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META, HISTORY_ARCHIVE_PERF_AUTHORITY_META)
    )
      return fallback;
    const ignored = Number(this.database.prepare("SELECT value FROM usage_projection_ignored_rows").get()?.value);
    const changes = totalChanges - 2 * ignored;
    return Number.isSafeInteger(ignored) && ignored >= 0 && Number.isSafeInteger(changes) && changes >= 0
      ? `usage:${changes}`
      : fallback;
  }

  // ── D1 卡：实例修订 / 外部提交检测 / 写事务卫生 ────────────────────────────────────────────

  /**
   * D1：读**同连接**的 `PRAGMA data_version`。
   *
   * SQLite 语义（这是本卡成立的前提）：**别的连接**提交过 ⇒ 该值变化；**本连接自己**的提交
   * **不**改它。⇒ 自身提交必须走 {@link UsageStore#commitStoreRevision} 的**显式修订**，
   * 外部提交才走这里的比对（卡面："自身提交仍用显式修订"）。
   *
   * 读不到（未 `open()` / 库刚被关掉）时返回上次观察值 ⇒ **永不抛**（读路径不得因它失败）。
   * @returns {number}
   */
  readDataVersion() {
    if (!this.database) return this.observedDataVersion;
    try {
      return Number(this.database.prepare("PRAGMA data_version").get()?.data_version ?? 0) || 0;
    } catch {
      return this.observedDataVersion;
    }
  }

  /**
   * D1：**自身成功提交** ⇒ 显式修订 +1。
   *
   * ⚠️ 只能在**已经 `COMMIT`** 之后调用；回滚路径一律**不**调用（验收："回滚不伪造成功变更"）。
   * @param {string} reason 提交类别（诊断用：`usage` / `usage+quota` / `perf` / `usage-delete` /
   *   `live-dirty` / `home` / `service-tier`）。
   * @returns {number} 新的修订号
   */
  commitStoreRevision(reason = "commit") {
    this.storeRevision += 1;
    this.lastCommitReason = String(reason);
    return this.storeRevision;
  }

  /**
   * D1：检出**外部提交**（同连接 `PRAGMA data_version` 变化 ⇒ 别的连接提交过）。
   *
   * 命中 ⇒ ① 修订 +1（这是一次**真实的、已提交的**视图变化）② **重载必要元数据**：
   * `generated_at` / `fingerprint` 由**提交方**写进 `store_meta`，本实例内存里的副本已过期。
   * 派生缓存不在这里直接清 —— 统一由 {@link UsageStore#syncDerivedRevision} 按"修订对齐"清。
   * @returns {boolean} 本次是否检出外部提交
   */
  detectExternalCommit() {
    if (!this.database) return false;
    const observed = this.readDataVersion();
    if (observed === this.observedDataVersion) return false;
    this.observedDataVersion = observed;
    this.externalCommitCount += 1;
    this.codexPublishedPaths.clear();
    this.nativeTimingThreads.clear();
    if (this.publishedFileMapsView) {
      this.publishedFileMapsView.fingerprints = null;
      this.publishedFileMapsView.warnings = null;
    }
    this.commitStoreRevision("external");
    try {
      this.generatedAt = this.readMeta("generated_at");
      this.fingerprint = this.readMeta("fingerprint");
      const quotaEvidence = this.readMetaRaw("quota_source_log_evidence");
      if (quotaEvidence) this.quotaSourceEvidence = quotaSourceEvidenceFromSnapshot(JSON.parse(quotaEvidence));
    } catch {
      // 库在两步之间被换掉/关掉 ⇒ 保持原值：读路径不得因为"元数据重载"而抛错。
    }
    return true;
  }

  /**
   * D1：把派生缓存对齐到当前修订（`metadataCache` / `periodComparisonCache` 的**统一**失效入口）。
   *
   * 读路径（`metadata()` / `periodComparison()`）与轮末都必须先过这里：数据修订前进过 ⇒ 两个缓存
   * 一起失效（`events` 聚合 + home 形状 + service-tier evidence）。价目目录不是数据修订的一部分，
   * `periodComparisonCache` 通过缓存键里的目录键集自行隔离。
   * @returns {boolean} 本次是否发生了失效
   */
  syncDerivedRevision() {
    if (this.summarySnapshotRead || this.writeTransactionDepth > 0) return false;
    this.detectExternalCommit();
    const usageChanges = this.usageProjectionChangeKey();
    const localUsageChanged = this.observedUsageProjectionChanges !== usageChanges;
    if (this.derivedRevision === this.storeRevision && !localUsageChanged) return false;
    this.metadataCache = null;
    this.periodComparisonCache.clear();
    // D4：观测聚合缓存同为"用量侧静态输入"派生物 ⇒ 与上面两个缓存同一失效入口。
    this.metadataObservationCache = null;
    // D3：quota 观测的**规范映射**同为"用量侧静态输入"派生物 ⇒ 与上面两个缓存同一失效入口。
    this.quotaObservationCache = null;
    if (localUsageChanged) this.summaryProjectionCache = null;
    this.recordChampionCache = null;
    this.observedUsageProjectionChanges = usageChanges;
    // W4-b1 / D1：事件计价 memo 的输入是"事件内容 + 生效价目"，**不含**修订；这里清空是**保守**的
    // 内存卫生（旧修订的事件可能已被删除/重写），不是正确性的必要条件 —— 键不同就绝不会命中。
    this.eventCostMemo.clear("store-revision");
    this.derivedRevision = this.storeRevision;
    return true;
  }

  /**
   * D1：`service-tier evidence` 的**输入签名**（只读 `statSync`，不落盘、不进 report）。
   *
   * 证据来自各 home 的 `logs_2.sqlite`（`loadServiceTierEvidence`）；这里取主库 **+ `-wal`** 的
   * `size`/`mtimeMs`（与 `opencodeSourceStat` 同一手法：WAL 里的新行也算变化）。
   *
   * 为什么用**输入签名**而不是 resolver 身份：`loadServiceTierEvidence` **每轮**都返回一个新对象，
   * 拿身份当"变化"会让每个 no-op 轮都推进修订（违反卡面"无变化同步保留缓存"）。
   * @param {any[]} homes
   * @returns {string}
   */
  serviceTierEvidenceSignature(homes = []) {
    const files = [
      ...new Set(
        homes
          .filter((home) => home?.path && home.kind !== "project-log" && home.kind !== "zcode")
          .map((home) => path.join(String(home.path), "logs_2.sqlite")),
      ),
    ].sort();
    return files
      .map((filePath) => {
        let size = -1;
        let mtimeMs = -1;
        try {
          const main = statSync(filePath);
          size = main.size;
          mtimeMs = main.mtimeMs;
          try {
            const wal = statSync(`${filePath}-wal`);
            size += wal.size;
            mtimeMs = Math.max(mtimeMs, wal.mtimeMs);
          } catch {
            // 没有 `-wal`（非 WAL 模式 / 已 checkpoint）⇒ 主库指纹即全部输入。
          }
        } catch {
          // 取不到指纹（文件不存在/不可读）同样是一个**输入状态**（用 -1 表示）⇒ 保持确定性。
        }
        return `${filePath}\u0000${size}\u0000${mtimeMs}`;
      })
      .join("\n");
  }

  /**
   * D1：`replaceFile` 的回滚出口（**唯一的跨 `await` 写事务**）。
   *
   * 验收明文："回滚 ⇒ **不伪造成功变更**；事务内已读的派生缓存被**安全清理**"。
   *   * 这里**不**推进修订（那次替换没有提交）；
   *   * 事务内可能被读到的派生缓存**一律清掉**（配合 `writeTransactionDepth > 0` 时的"不落缓存"，
   *     保证不会留下与已提交状态不符的缓存）。
   */
  rollbackReplaceFileTransaction() {
    if (this.writeTransactionDepth > 0) this.writeTransactionDepth -= 1;
    this.metadataCache = null;
    this.periodComparisonCache.clear();
    // D4：回滚后派生缓存一并失效（含观测聚合）。
    this.metadataObservationCache = null;
  }

  readMeta(key) {
    return String(this.database.prepare("SELECT value FROM store_meta WHERE key = ?").get(key)?.value || "");
  }

  /** 与 {@link UsageStore#readMeta} 同义，但**保留 `undefined`** —— 用于区分"键缺失"与"空串"（AN-6）。 */
  readMetaRaw(key) {
    const row = this.database.prepare("SELECT value FROM store_meta WHERE key = ?").get(key);
    return row === undefined ? undefined : String(row.value);
  }

  /** Lightweight publication check for status polling: one index key plus timing revisions. */
  perfPublicationState() {
    const timingRevision = readRequestTimingRevision(this.database);
    const rawPublishedRevision = Number(this.readMetaRaw(REQUEST_TIMING_PUBLISHED_REVISION_META));
    const publishedRevision =
      Number.isSafeInteger(rawPublishedRevision) && rawPublishedRevision >= 0 ? rawPublishedRevision : 0;
    const timingPending = this.requestTimingDirtyThreadCount() > 0 || timingRevision !== publishedRevision;
    return {
      indexVersion: this.readMeta("perf_index_version"),
      timingRevision: timingPending ? String(timingRevision) : "",
    };
  }

  writeMeta(key, value) {
    this.database
      .prepare(
        "INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, String(value));
  }

  /** Reuse folds only while ownership, projection bytes, method and publication agree. */
  requestTimingNativeThreads(homeId, rolloutThreadIds = new Set()) {
    const published = new Map(
      Object.entries(this.publishedFileFingerprintsForRead()).map(([file, fingerprint]) => [
        canonicalProjectionStorePath(file),
        fingerprint,
      ]),
    );
    const projections = new Map(
      this.database
        .prepare("SELECT path, method_version, fingerprint FROM perf_codex_projections WHERE home_id = ?")
        .all(homeId)
        .map((row) => [canonicalProjectionStorePath(String(row.path)), row]),
    );
    const readProjection = this.database.prepare("SELECT projection FROM perf_codex_projections WHERE path = ?");
    const owners = new Map();
    for (const row of this.database
      .prepare(
        "SELECT thread_id, source_path FROM perf_rollout_threads WHERE home_id = ? ORDER BY thread_id, source_path",
      )
      .all(homeId)) {
      const threadId = String(row.thread_id);
      const paths = owners.get(threadId) || [];
      paths.push(String(row.source_path));
      owners.set(threadId, paths);
    }
    const previous = this.nativeTimingThreads.get(homeId) || new Map();
    const threads = new Map();
    const next = new Map();
    const method = this.codexProjections.methodVersion();
    for (const [threadId, paths] of owners) {
      const hash = createHash("sha256").update(method);
      let trusted = true;
      const rows = paths.map((filePath) => {
        const canonical = canonicalProjectionStorePath(filePath);
        const row = projections.get(canonical);
        const fingerprint = published.get(canonical);
        hash.update(JSON.stringify([filePath, fingerprint, row?.method_version, row?.fingerprint]));
        const projection = row === undefined ? "" : String(readProjection.get(row.path)?.projection ?? "");
        hash.update("\0").update(projection).update("\0");
        if (!row || String(row.method_version) !== method || String(row.fingerprint) !== fingerprint) trusted = false;
        return row === undefined ? undefined : { ...row, projection };
      });
      const signature = hash.digest("hex");
      const cached = previous.get(threadId);
      if (cached?.signature === signature && !rolloutThreadIds.has(threadId)) {
        threads.set(threadId, cached);
        next.set(threadId, cached);
        continue;
      }
      const rollouts = [];
      for (const [index, row] of rows.entries()) {
        try {
          const projection = row && JSON.parse(String(row.projection));
          if (!projection || !Array.isArray(projection.records)) {
            trusted = false;
            continue;
          }
          rollouts.push({ filePath: paths[index], threadId, projection });
        } catch {
          trusted = false;
        }
      }
      const entry =
        cached?.signature === signature
          ? cached
          : {
              signature,
              trusted,
              paths,
              turns: foldCodexRolloutMetadata(
                homeId,
                rollouts.map((rollout) => rollout.projection),
              ).turns.map((turn) => ({
                model: turn.model,
                requests: /** @type {Array<Record<string, unknown>>} */ (turn.requests).map((request) => ({
                  responseId: request.responseId,
                  outputTokens: request.outputTokens,
                  reasoningTokens: request.reasoningOutputTokensKnown === true ? request.reasoningOutputTokens : null,
                })),
              })),
            };
      next.set(threadId, entry);
      threads.set(threadId, rolloutThreadIds.has(threadId) ? { ...entry, rollouts } : entry);
    }
    this.nativeTimingThreads.set(homeId, next);
    return threads;
  }

  /**
   * Fold only published Codex rollout projections to recover the native
   * response -> thread identity. A missing, stale, or ambiguous projection is
   * rejected; model names and timestamps are never used as a fallback.
   *
   * @param {string} homeId
   * @param {Set<string>} responseIds
   * @returns {Array<{responseId: string, threadId: string}>}
   */
  requestTimingNativeLinks(homeId, responseIds) {
    if (responseIds.size === 0) return [];

    /** @type {Map<string, string[]>} */
    const storedByResponse = new Map();
    const storedLinks = this.database
      .prepare(`
        SELECT response_id, thread_id
        FROM perf_request_timing_threads
        WHERE home_id = ?
        ORDER BY response_id, thread_id
      `)
      .all(homeId);
    for (const row of storedLinks) {
      const responseId = String(row.response_id);
      if (!responseIds.has(responseId)) continue;
      const threadIds = storedByResponse.get(responseId) ?? [];
      threadIds.push(String(row.thread_id));
      storedByResponse.set(responseId, threadIds);
    }
    for (const [responseId, threadIds] of storedByResponse) {
      if (threadIds.length > 1) {
        throw requestTimingImportError(
          "REQUEST_TIMING_STORE_CORRUPT",
          `Response ${responseId} already has multiple native thread links`,
        );
      }
    }

    const threadsByResponse = new Map();
    for (const [threadId, thread] of this.requestTimingNativeThreads(homeId)) {
      for (const turn of thread.turns) {
        for (const request of turn.requests) {
          const responseId = request.responseId;
          if (typeof responseId !== "string" || !responseIds.has(responseId)) continue;
          const entries = threadsByResponse.get(responseId) || new Map();
          entries.set(threadId, thread.trusted);
          threadsByResponse.set(responseId, entries);
        }
      }
    }
    const requestLinks = [];
    for (const responseId of responseIds) {
      const threads = threadsByResponse.get(responseId);
      const storedThreadId = storedByResponse.get(responseId)?.[0];
      if (!threads || threads.size === 0) {
        if (storedThreadId !== undefined) {
          requestLinks.push({ responseId, threadId: storedThreadId });
          continue;
        }
        throw requestTimingImportError(
          "REQUEST_TIMING_LINK_MISSING",
          `No published native projection contains response ${responseId}`,
        );
      }
      if (threads.size > 1) {
        throw requestTimingImportError(
          "REQUEST_TIMING_THREAD_CONFLICT",
          `Response ${responseId} appears in multiple native threads`,
        );
      }
      const [[threadId, trusted]] = threads;
      if (storedThreadId !== undefined) {
        if (threadId !== storedThreadId) {
          throw requestTimingImportError(
            "REQUEST_TIMING_THREAD_CONFLICT",
            `Response ${responseId} is already linked to another native thread`,
          );
        }
        requestLinks.push({ responseId, threadId });
        continue;
      }
      if (!trusted) {
        throw requestTimingImportError(
          "REQUEST_TIMING_LINK_MISSING",
          `Response ${responseId} is not backed by a current published native projection`,
        );
      }
      requestLinks.push({ responseId, threadId });
    }
    return requestLinks;
  }

  /**
   * Persist one normalized evidence batch, derive native response links from
   * published local projections, and invalidate only the affected threads.
   * The evidence revision, dirty rows, and removed published fingerprints
   * commit atomically.
   *
   * @param {{homeId: string, records: unknown[], reviewedOrigins?: string[]}} input
   * @returns {{revision: number, changed: boolean, affectedThreadIds: string[]}}
   */
  importRequestTimingEvidence(input) {
    if (!this.database) throw new TypeError("UsageStore is not open");
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("Timing import input must be an object");
    }
    const homeId = input.homeId;
    if (typeof homeId !== "string" || homeId.trim() === "") {
      throw requestTimingImportError("REQUEST_TIMING_INVALID_INPUT", "homeId must be a non-empty string");
    }
    if (!Array.isArray(input.records)) {
      throw requestTimingImportError("REQUEST_TIMING_INVALID_INPUT", "records must be an array");
    }
    assertRequestTimingOriginsReviewed(input.records, input.reviewedOrigins);
    const records = input.records.map(normalizeRequestTimingEvidence);
    const responseIds = new Set(records.map((record) => record.responseId));

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const requestLinks = this.requestTimingNativeLinks(homeId, responseIds);
      const result = importStoredRequestTimingEvidence(this.database, {
        homeId,
        records,
        requestLinks,
      });
      if (result.changed) {
        const markDirty = this.database.prepare(`
          INSERT INTO perf_request_timing_dirty_threads (home_id, thread_id)
          VALUES (?, ?)
          ON CONFLICT(home_id, thread_id) DO NOTHING
        `);
        for (const threadId of result.affectedThreadIds) markDirty.run(homeId, threadId);

        this.codexStableAttempts.delete(homeId);
      }
      this.database.exec("COMMIT");
      if (result.changed) this.commitStoreRevision("request-timing");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Register one verified archive package as metadata. This never deletes hot
   * facts or makes the registered segment authoritative.
   * @param {string} candidateFile
   * @param {string} [manifestFile]
   */
  async registerHistoryArchiveCandidate(candidateFile, manifestFile = undefined) {
    await this.open();
    // Dynamic import avoids store -> archive -> backup -> store initialization cycles.
    const { assertHistoryArchiveSourceMatches, verifyHistoryArchiveCandidate } = await import("./history-archive.js");
    const verified = await verifyHistoryArchiveCandidate(candidateFile, manifestFile);
    if (!verified.ok || !verified.candidate) {
      throw new TypeError("verifiedCandidate must be the result of verifyHistoryArchiveCandidate");
    }
    const segmentId = String(verified.manifest.database.sha256);
    const databasePath = path.resolve(verified.databaseFile);
    const { startMs, endMs } = verified.candidate;
    const eventCount = Number(verified.candidate.events.rows);
    const registeredAtMs = Date.now();

    this.database.exec("BEGIN IMMEDIATE");
    try {
      assertHistoryArchiveSourceMatches(this.database, verified);
      const existing = this.database
        .prepare(
          `SELECT segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms
           FROM archive_segments WHERE segment_id = ?`,
        )
        .get(segmentId);
      if (existing) {
        if (
          String(existing.database_sha256) !== segmentId ||
          Number(existing.start_ms) !== startMs ||
          Number(existing.end_ms) !== endMs ||
          Number(existing.event_count) !== eventCount
        ) {
          throw historyArchiveError(
            "HISTORY_ARCHIVE_SEGMENT_CONFLICT",
            `archive segment ${segmentId} is already registered with different metadata`,
          );
        }
        this.database.exec("COMMIT");
        return {
          inserted: false,
          segmentId,
          databasePath: String(existing.database_path),
          databaseSha256: String(existing.database_sha256),
          startMs: Number(existing.start_ms),
          endMs: Number(existing.end_ms),
          eventCount: Number(existing.event_count),
          registeredAtMs: Number(existing.registered_at_ms),
        };
      }

      const overlap = this.database
        .prepare(
          `SELECT segment_id, start_ms, end_ms FROM archive_segments
           WHERE start_ms < ? AND end_ms > ? LIMIT 1`,
        )
        .get(endMs, startMs);
      if (overlap) {
        throw historyArchiveError(
          "HISTORY_ARCHIVE_SEGMENT_OVERLAP",
          `archive range overlaps registered segment ${String(overlap.segment_id)}`,
        );
      }

      this.database
        .prepare(
          `INSERT INTO archive_segments (
             segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(segmentId, databasePath, segmentId, startMs, endMs, eventCount, registeredAtMs);
      this.database.exec("COMMIT");
      return {
        inserted: true,
        segmentId,
        databasePath,
        databaseSha256: segmentId,
        startMs,
        endMs,
        eventCount,
        registeredAtMs,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Atomically publish one prepared archive segment. Supported perf
   * samples move with events; timing, source identities, and native
   * dependencies remain hot.
   * @param {Record<string, any>} plan
   */
  async commitHistoryArchiveEvents(plan) {
    await this.open();
    if (this.database.isTransaction) {
      throw historyArchiveError(
        "HISTORY_ARCHIVE_COMMIT_TRANSACTION_ACTIVE",
        "archive commit requires no active source transaction",
      );
    }
    this.syncDerivedRevision();
    const {
      assertHistoryArchiveCommitPlan,
      historyArchivePerfDeletion,
      prepareHistoryArchiveCommit,
      verifyHistoryArchiveCandidate,
    } = await import("./history-archive.js");
    if (realpathSync.native(path.resolve(this.databaseFile)) !== plan?.source?.databaseFile) {
      throw historyArchiveError(
        "HISTORY_ARCHIVE_COMMIT_SOURCE_MISMATCH",
        "archive commit plan was prepared for a different source database",
      );
    }
    this.database.exec("BEGIN IMMEDIATE");
    this.writeTransactionDepth += 1;
    try {
      const segmentId = String(plan?.candidate?.databaseSha256 ?? "");
      const existing = this.database
        .prepare(
          `SELECT segment_id, database_path, database_sha256, start_ms, end_ms, event_count
           FROM archive_segments WHERE segment_id = ?`,
        )
        .get(segmentId);
      const authorized = historyArchiveAuthorizedSegmentIds(this.database);
      const candidate = plan?.candidate;
      if (existing && authorized.has(segmentId)) {
        const verified = await verifyHistoryArchiveCandidate(
          String(candidate?.databaseFile),
          candidate?.manifestFile === undefined ? undefined : String(candidate.manifestFile),
        );
        if (
          String(existing.database_path) !== path.resolve(verified.databaseFile) ||
          String(existing.database_sha256) !== verified.manifest.database.sha256 ||
          Number(existing.start_ms) !== verified.candidate.startMs ||
          Number(existing.end_ms) !== verified.candidate.endMs ||
          Number(existing.event_count) !== verified.candidate.events.rows ||
          candidate.databaseSha256 !== verified.manifest.database.sha256 ||
          candidate.databaseFile !== verified.databaseFile ||
          candidate.manifestFile !== verified.manifestFile ||
          candidate.startMs !== verified.candidate.startMs ||
          candidate.endMs !== verified.candidate.endMs ||
          JSON.stringify(candidate.events) !== JSON.stringify(verified.candidate.events) ||
          JSON.stringify(candidate.sources) !== JSON.stringify(verified.candidate.sources)
        ) {
          throw historyArchiveError(
            "HISTORY_ARCHIVE_COMMIT_CANDIDATE_MISMATCH",
            "registered archive segment no longer matches the supplied plan",
          );
        }
        const remaining = Number(
          this.database
            .prepare("SELECT COUNT(*) AS count FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ?")
            .get(verified.candidate.startMs, verified.candidate.endMs).count,
        );
        if (remaining !== 0) {
          throw historyArchiveError(
            "HISTORY_ARCHIVE_COMMIT_SOURCE_CHANGED",
            `archive replay left ${remaining} hot event(s) in the sealed range`,
          );
        }
        if (plan.perfDeletion !== undefined) {
          const candidateDatabase = new DatabaseSync(verified.databaseFile, { readOnly: true });
          let candidatePerfDeletion;
          try {
            candidateDatabase.exec("BEGIN");
            candidatePerfDeletion = historyArchivePerfDeletion(
              candidateDatabase,
              verified.candidate.startMs,
              verified.candidate.endMs,
              { requireComponents: true },
            );
          } finally {
            try {
              candidateDatabase.exec("ROLLBACK");
            } finally {
              candidateDatabase.close();
            }
          }
          if (JSON.stringify(candidatePerfDeletion) !== JSON.stringify(plan.perfDeletion)) {
            throw historyArchiveError(
              "HISTORY_ARCHIVE_COMMIT_CANDIDATE_MISMATCH",
              "supplied perf deletion no longer matches the verified archive candidate",
            );
          }
          const recordsById = new Map(
            this.database
              .prepare(
                `SELECT segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms
                 FROM archive_segments`,
              )
              .all()
              .map((record) => [String(record.segment_id), { ...record }]),
          );
          const perfSegment = (historyArchivePerfAuthority(this.database, authorized, recordsById) || []).find(
            (segment) => segment.segmentId === segmentId,
          );
          if (perfSegment?.sourceKind !== plan.perfDeletion.sourceKind) {
            throw historyArchiveError(
              "HISTORY_ARCHIVE_PERF_AUTHORITY_MISMATCH",
              `archive segment ${segmentId} is missing its committed ${plan.perfDeletion.sourceKind} perf authority`,
            );
          }
          const remainingPerf = Number(
            this.database
              .prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE ts_ms >= ? AND ts_ms < ?")
              .get(verified.candidate.startMs, verified.candidate.endMs).count,
          );
          if (remainingPerf !== 0) {
            throw historyArchiveError(
              "HISTORY_ARCHIVE_COMMIT_SOURCE_CHANGED",
              `archive replay left ${remainingPerf} hot perf sample(s) in the sealed range`,
            );
          }
        }
        this.database.exec("ROLLBACK");
        this.writeTransactionDepth -= 1;
        this.syncDerivedRevision();
        return {
          segmentId,
          inserted: false,
          replay: true,
          startMs: verified.candidate.startMs,
          endMs: verified.candidate.endMs,
          deletedEventCount: 0,
          deletedPerfSampleCount: 0,
          eventCount: verified.candidate.events.rows,
        };
      }
      if (existing) {
        throw historyArchiveError(
          "HISTORY_ARCHIVE_COMMIT_CANDIDATE_MISMATCH",
          `archive segment ${segmentId} is registered without authority`,
        );
      }

      const prepared = await prepareHistoryArchiveCommit(this.database, String(candidate?.databaseFile));
      assertHistoryArchiveCommitPlan(prepared, plan);
      const overlap = this.database
        .prepare(
          `SELECT segment_id FROM archive_segments
           WHERE start_ms < ? AND end_ms > ? LIMIT 1`,
        )
        .get(candidate.endMs, candidate.startMs);
      if (overlap) {
        throw historyArchiveError(
          "HISTORY_ARCHIVE_SEGMENT_OVERLAP",
          `archive range overlaps registered segment ${String(overlap.segment_id)}`,
        );
      }
      this.database
        .prepare(
          `INSERT INTO archive_segments (
             segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          segmentId,
          String(candidate.databaseFile),
          segmentId,
          candidate.startMs,
          candidate.endMs,
          candidate.events.rows,
          Date.now(),
        );
      authorized.add(segmentId);
      this.writeMeta(
        HISTORY_ARCHIVE_EVENT_AUTHORITY_META,
        JSON.stringify({ formatVersion: 1, segmentIds: [...authorized].sort() }),
      );

      let deletedPerf = 0;
      if (plan.perfDeletion !== undefined) {
        const recordsById = new Map(
          this.database
            .prepare(
              `SELECT segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms
               FROM archive_segments`,
            )
            .all()
            .map((record) => [String(record.segment_id), { ...record }]),
        );
        const segments = new Map(
          (historyArchivePerfAuthority(this.database, authorized, recordsById) || []).map((segment) => [
            segment.segmentId,
            {
              segmentId: segment.segmentId,
              databaseSha256: segment.segmentId,
              sourceKinds: [segment.sourceKind],
              methodVersions: [segment.methodVersion],
            },
          ]),
        );
        segments.set(segmentId, {
          segmentId,
          databaseSha256: segmentId,
          sourceKinds: [plan.perfDeletion.sourceKind],
          methodVersions: [plan.perfDeletion.methodVersion],
        });
        this.writeMeta(
          HISTORY_ARCHIVE_PERF_AUTHORITY_META,
          JSON.stringify({
            formatVersion: 1,
            segments: [...segments.values()].sort((left, right) => left.segmentId.localeCompare(right.segmentId)),
          }),
        );
      }

      createUsageRollups(this.database);
      const rollupDays = this.database.prepare("SELECT * FROM usage_rollup_days").all();
      const dirtyDays = this.database.prepare("SELECT day_key FROM usage_rollup_dirty_days").all();
      const deleteEvent = this.database.prepare(
        "DELETE FROM events WHERE id = ? AND timestamp_ms >= ? AND timestamp_ms < ?",
      );
      let deleted = 0;
      for (const id of plan.deletion.ids) {
        deleted += Number(deleteEvent.run(id, candidate.startMs, candidate.endMs).changes);
      }
      if (deleted !== plan.deletion.ids.length) {
        throw historyArchiveError(
          "HISTORY_ARCHIVE_COMMIT_SOURCE_CHANGED",
          `archive commit deleted ${deleted} event(s), expected ${plan.deletion.ids.length}`,
        );
      }
      const remaining = Number(
        this.database
          .prepare("SELECT COUNT(*) AS count FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ?")
          .get(candidate.startMs, candidate.endMs).count,
      );
      if (remaining !== 0) {
        throw historyArchiveError(
          "HISTORY_ARCHIVE_COMMIT_SOURCE_CHANGED",
          `archive commit left ${remaining} hot event(s) in the sealed range`,
        );
      }
      if (plan.perfDeletion !== undefined) {
        const deletePerf = this.database.prepare(
          "DELETE FROM perf_samples WHERE sample_key = ? AND ts_ms >= ? AND ts_ms < ?",
        );
        for (const sampleKey of plan.perfDeletion.sampleKeys) {
          deletedPerf += Number(deletePerf.run(sampleKey, candidate.startMs, candidate.endMs).changes);
        }
        if (deletedPerf !== plan.perfDeletion.sampleKeys.length) {
          throw historyArchiveError(
            "HISTORY_ARCHIVE_COMMIT_SOURCE_CHANGED",
            `archive commit deleted ${deletedPerf} perf sample(s), expected ${plan.perfDeletion.sampleKeys.length}`,
          );
        }
        const remainingPerf = Number(
          this.database
            .prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE ts_ms >= ? AND ts_ms < ?")
            .get(candidate.startMs, candidate.endMs).count,
        );
        if (remainingPerf !== 0) {
          throw historyArchiveError(
            "HISTORY_ARCHIVE_COMMIT_SOURCE_CHANGED",
            `archive commit left ${remainingPerf} hot perf sample(s) in the sealed range`,
          );
        }
      }
      // Moving verified, unchanged facts preserves rollups; retain any dirty work that predates the move.
      this.database.exec("DELETE FROM usage_rollup_days; DELETE FROM usage_rollup_dirty_days");
      const restoreDay = this.database.prepare("INSERT INTO usage_rollup_days VALUES (?, ?, ?, ?)");
      for (const day of rollupDays) restoreDay.run(day.calendar_zone, day.day_key, day.start_ms, day.end_ms);
      const restoreDirty = this.database.prepare("INSERT INTO usage_rollup_dirty_days (day_key) VALUES (?)");
      for (const day of dirtyDays) restoreDirty.run(day.day_key);
      this.database.exec("COMMIT");
      this.writeTransactionDepth -= 1;
      this.commitStoreRevision("history-archive-commit");
      this.syncDerivedRevision();
      return {
        segmentId,
        inserted: true,
        replay: false,
        startMs: candidate.startMs,
        endMs: candidate.endMs,
        deletedEventCount: deleted,
        deletedPerfSampleCount: deletedPerf,
        eventCount: candidate.events.rows,
      };
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } finally {
        this.rollbackReplaceFileTransaction();
      }
      throw error;
    }
  }

  /**
   * Read one registered archive segment without merging it into hot facts.
   * @param {string} segmentId
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async readHistoryArchiveEvents(segmentId) {
    if (typeof segmentId !== "string" || segmentId.length === 0) {
      throw historyArchiveError("HISTORY_ARCHIVE_SEGMENT_NOT_FOUND", "archive segment id is required");
    }
    await this.open();
    const record = this.database
      .prepare(
        `SELECT segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms
         FROM archive_segments WHERE segment_id = ?`,
      )
      .get(segmentId);
    if (!record) {
      throw historyArchiveError("HISTORY_ARCHIVE_SEGMENT_NOT_FOUND", `archive segment ${segmentId} is not registered`);
    }

    const snapshot = await this.readHistoryArchiveSnapshot(record);
    return snapshot.rows;
  }

  /**
   * Read one keyset page of original sealed events without hot/overlay data.
   * @param {string} segmentId
   * @param {{startMs: number, endMs: number, afterId?: number, limit?: number} | undefined} range
   */
  async readHistoryArchiveEventPage(segmentId, range) {
    const { startMs, endMs, afterId = 0, limit = 100 } = range ?? {};
    if (typeof segmentId !== "string" || segmentId.length === 0) {
      throw historyArchiveError("HISTORY_ARCHIVE_SEGMENT_NOT_FOUND", "archive segment id is required");
    }
    if (
      !Number.isSafeInteger(startMs) ||
      !Number.isSafeInteger(endMs) ||
      startMs >= endMs ||
      !Number.isSafeInteger(afterId) ||
      afterId < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 500
    ) {
      throw historyArchiveError(
        "HISTORY_ARCHIVE_EVENT_PAGE_INVALID",
        "event page requires safe integer startMs < endMs, afterId >= 0, and limit 1..500",
      );
    }
    await this.open();
    const record = this.database
      .prepare(
        `SELECT segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms
         FROM archive_segments WHERE segment_id = ?`,
      )
      .get(segmentId);
    if (!record) {
      throw historyArchiveError("HISTORY_ARCHIVE_SEGMENT_NOT_FOUND", `archive segment ${segmentId} is not registered`);
    }
    const page = await this.readHistoryArchiveSnapshot(record, { startMs, endMs, afterId, limit });
    return {
      segmentId,
      view: "sealed",
      range: { startMs, endMs },
      events: page.rows,
      nextAfterId: page.nextAfterId,
    };
  }

  /**
   * Read the decoded perf samples stored in one registered cold segment.
   * Samples stay tied to the segment's registered [start_ms, end_ms) range.
   * @param {string} segmentId
   * @returns {Promise<import("./usage-types.js").PerfSampleRowDecoded[]>}
   */
  async readHistoryArchivePerfSamples(segmentId) {
    if (typeof segmentId !== "string" || segmentId.length === 0) {
      throw historyArchiveError("HISTORY_ARCHIVE_SEGMENT_NOT_FOUND", "archive segment id is required");
    }
    await this.open();
    const record = this.database
      .prepare(
        `SELECT segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms
         FROM archive_segments WHERE segment_id = ?`,
      )
      .get(segmentId);
    if (!record) {
      throw historyArchiveError("HISTORY_ARCHIVE_SEGMENT_NOT_FOUND", `archive segment ${segmentId} is not registered`);
    }
    return (await this.#readHistoryArchivePerfRecord(segmentId, record)).samples;
  }

  async #readHistoryArchivePerfRecord(
    segmentId,
    record,
    {
      requirePerfComponents = false,
      sourceKind = null,
      revisions = [],
      includeTimingEvidenceForSampleKeys = [],
      includeSourceIdentityForSampleKeys = [],
    } = {},
  ) {
    const {
      assertHistoryArchiveSourceMatches,
      verifyHistoryArchiveCandidate,
      HISTORY_ARCHIVE_CODEX_REQUESTS_META_KEY,
      validateCodexRequestEvidence,
      readCodexNativeMeasurements,
    } = await import("./history-archive.js");
    const verified = await verifyHistoryArchiveCandidate(String(record.database_path));
    assertHistoryArchiveRecordMatches(record, verified);

    const database = new DatabaseSync(verified.databaseFile, { readOnly: true });
    let began = false;
    try {
      database.exec("BEGIN");
      began = true;
      assertHistoryArchiveSourceMatches(database, verified);
      if (requirePerfComponents) {
        const componentKeys = new Set(
          database
            .prepare(
              `SELECT key FROM store_meta
               WHERE key IN (?, ?, ?, ?)`,
            )
            .all(...HISTORY_ARCHIVE_PERF_COMPONENT_META_KEYS)
            .map((row) => String(row.key)),
        );
        if (componentKeys.size !== HISTORY_ARCHIVE_PERF_COMPONENT_META_KEYS.length) {
          throw historyArchiveError(
            "HISTORY_ARCHIVE_PERF_AUTHORITY_MISMATCH",
            `archive segment ${segmentId} does not contain all verified perf components`,
          );
        }
        if (
          sourceKind === "codex" &&
          !database
            .prepare("SELECT 1 AS present FROM store_meta WHERE key = ?")
            .get(HISTORY_ARCHIVE_CODEX_REQUESTS_META_KEY)
        ) {
          throw historyArchiveError(
            "HISTORY_ARCHIVE_PERF_AUTHORITY_MISMATCH",
            `archive segment ${segmentId} does not contain native Codex request facts`,
          );
        }
      }
      const table = database
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'perf_samples'")
        .get();
      if (!table) {
        throw historyArchiveError(
          "HISTORY_ARCHIVE_PERF_TABLE_MISSING",
          `archive segment ${segmentId} does not contain perf_samples`,
        );
      }
      assertPerfSamplesSchema(database);
      const rows = database
        .prepare(`${PERF_SAMPLE_SELECT_SQL} WHERE ts_ms >= ? AND ts_ms < ? ORDER BY sample_key`)
        .all(Number(record.start_ms), Number(record.end_ms));
      const nativeMeasurements =
        includeSourceIdentityForSampleKeys.length > 0 ||
        revisions.some((revision) => revision.factTable === "codex_output_measurements")
          ? readCodexNativeMeasurements(database, rows)
          : new Map();
      const effective = applyHistoryArchivePerfRevisions(database, record, rows, revisions, nativeMeasurements);
      if (
        revisions.length > 0 &&
        (sourceKind === "codex" || effective.rawSamples.some((sample) => sample.source_kind === "codex"))
      ) {
        const requestFactsRow = database
          .prepare("SELECT value FROM store_meta WHERE key = ?")
          .get(HISTORY_ARCHIVE_CODEX_REQUESTS_META_KEY);
        if (!requestFactsRow) {
          throw historyArchiveError(
            "HISTORY_ARCHIVE_PERF_AUTHORITY_MISMATCH",
            `archive segment ${segmentId} does not contain native Codex request facts`,
          );
        }
        let requestFacts;
        try {
          requestFacts = JSON.parse(String(requestFactsRow.value));
        } catch {
          throw historyArchiveError(
            "HISTORY_ARCHIVE_PERF_AUTHORITY_MISMATCH",
            `archive segment ${segmentId} has invalid native Codex request facts`,
          );
        }
        try {
          validateCodexRequestEvidence(database, requestFacts, Number(record.start_ms), Number(record.end_ms), {
            samples: effective.rawSamples,
            timingEvidence: effective.timingEvidence,
            nativeMeasurements: effective.nativeMeasurements,
          });
        } catch (error) {
          throw historyArchiveRevisionError(
            `effective Codex perf revision contradicts native request timing: ${error.message}`,
          );
        }
      }
      const timingEvidenceBySampleKey = new Map();
      const sourceIdentityBySampleKey = new Map();
      if (includeTimingEvidenceForSampleKeys.length > 0) {
        assertHistoryArchiveRevisionColumns(
          database,
          "perf_request_timing_evidence",
          historyArchiveTimingEvidenceColumns(database),
        );
        for (const sampleKey of includeTimingEvidenceForSampleKeys) {
          timingEvidenceBySampleKey.set(String(sampleKey), linkedPerfRequestTimingEvidence(database, sampleKey));
        }
      }
      if (includeSourceIdentityForSampleKeys.length > 0) {
        const selectSampleSource = database.prepare("SELECT source_path FROM perf_samples WHERE sample_key = ?");
        const selectSourceIdentity = database.prepare(
          `SELECT ${HISTORY_SOURCE_IDENTITY_COLUMNS.join(", ")} FROM source_files WHERE path = ?`,
        );
        const boundedSampleKeys = new Set(rows.map((row) => String(row.sample_key)));
        for (const sampleKey of includeSourceIdentityForSampleKeys) {
          const normalizedSampleKey = String(sampleKey);
          if (!boundedSampleKeys.has(normalizedSampleKey)) continue;
          const sampleSource = selectSampleSource.get(normalizedSampleKey);
          const sourceIdentity = sampleSource ? selectSourceIdentity.get(String(sampleSource.source_path)) : undefined;
          if (!sourceIdentity) {
            throw historyArchiveError(
              "HISTORY_ARCHIVE_PERF_SOURCE_MISSING",
              `archive segment ${segmentId} does not contain the source identity for perf sample ${sampleKey}`,
            );
          }
          sourceIdentityBySampleKey.set(normalizedSampleKey, { ...sourceIdentity });
        }
      }
      return {
        ...effective,
        timingEvidenceBySampleKey,
        sourceIdentityBySampleKey,
        originalNativeMeasurements: nativeMeasurements,
      };
    } finally {
      try {
        if (began) database.exec("ROLLBACK");
      } finally {
        database.close();
      }
    }
  }

  async #captureHistoryArchivePerfRevisionCandidates(sampleKeys) {
    const wanted = new Set([...sampleKeys].map(String));
    if (wanted.size === 0) return new Map();
    const revisionSegmentsById = new Map(
      this.database
        .prepare(
          `SELECT segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms
           FROM archive_segments`,
        )
        .all()
        .map((segment) => [String(segment.segment_id), { ...segment }]),
    );
    const authorizedSegmentIds = historyArchiveAuthorizedSegmentIds(this.database);
    const perfAuthority = historyArchivePerfAuthority(this.database, authorizedSegmentIds, revisionSegmentsById);
    const candidates = new Map();
    for (const { segmentId, record, sourceKind } of perfAuthority || []) {
      const cold = await this.#readHistoryArchivePerfRecord(segmentId, record, {
        requirePerfComponents: true,
        sourceKind,
        includeTimingEvidenceForSampleKeys: [...wanted],
        includeSourceIdentityForSampleKeys: [...wanted],
      });
      for (const sample of cold.samples) {
        const sampleKey = String(sample.sampleKey);
        if (!wanted.has(sampleKey)) continue;
        if (candidates.has(sampleKey)) {
          throw historyArchiveError(
            "HISTORY_ARCHIVE_PERF_SAMPLE_CONFLICT",
            `perf sample ${sampleKey} appears in more than one authorized segment`,
          );
        }
        candidates.set(sampleKey, {
          segmentId,
          databaseSha256: String(record.database_sha256),
          segment: record,
          sample,
          sourceIdentity: cold.sourceIdentityBySampleKey.get(sampleKey),
          timingEvidence: cold.timingEvidenceBySampleKey.get(sampleKey) || [],
          nativeMeasurement: cold.originalNativeMeasurements.get(sampleKey),
        });
      }
    }
    return candidates;
  }

  /**
   * Read one captured registry record and its source identities from one
   * verified cold snapshot. Internal to archived range reads.
   * @param {Record<string, unknown>} record
   * @param {{startMs: number, endMs: number, afterId: number, limit: number} | null} [page]
   * @returns {Promise<{
   *   rows: Array<Record<string, unknown>>,
   *   sourceIdentities: Array<Record<string, unknown>>,
   *   nextAfterId?: number | null
   * }>}
   */
  async readHistoryArchiveSnapshot(record, page = null) {
    const { withVerifiedHistoryArchiveCandidate } = await import("./history-archive.js");
    const eventCount = Number(record.event_count);
    return withVerifiedHistoryArchiveCandidate(String(record.database_path), undefined, (database, verified) => {
      const segmentId = assertHistoryArchiveRecordMatches(record, verified);
      if (page) {
        const total = Number(database.prepare("SELECT COUNT(*) AS count FROM events").get().count);
        if (total !== eventCount) {
          throw historyArchiveError(
            "HISTORY_ARCHIVE_SEGMENT_MISMATCH",
            `archive segment ${segmentId} contains ${total} event(s), expected ${eventCount}`,
          );
        }
        const rows = historyArchiveStatementRows(
          database.prepare(
            `SELECT * FROM events
             WHERE timestamp_ms >= ? AND timestamp_ms < ? AND id > ?
             ORDER BY id LIMIT ?`,
          ),
          [page.startMs, page.endMs, page.afterId, page.limit + 1],
        );
        const hasMore = rows.length > page.limit;
        if (hasMore) rows.pop();
        return {
          rows,
          nextAfterId: hasMore ? Number(rows[rows.length - 1].id) : null,
          sourceIdentities: [],
        };
      }
      const rows = historyArchiveStatementRows(database.prepare("SELECT * FROM events ORDER BY id"));
      if (rows.length !== eventCount) {
        throw historyArchiveError(
          "HISTORY_ARCHIVE_SEGMENT_MISMATCH",
          `archive segment ${segmentId} contains ${rows.length} event(s), expected ${eventCount}`,
        );
      }
      return {
        rows,
        sourceIdentities: historyArchiveSourceIdentities(database, Number(record.start_ms), Number(record.end_ms)),
      };
    });
  }

  /**
   * Load the authorized cold prefixes for one source reparse. The returned
   * rows are the only part of the re-parsed file allowed to stay cold.
   * @param {string} filePath
   * @param {Record<string, unknown>} source
   * @returns {Promise<{prefixes: any[], revisionState: any | null}>}
   */
  async historyArchiveReparsePrefixes(filePath, source) {
    const authorizedSegmentIds = historyArchiveAuthorizedSegmentIds(this.database);
    if (authorizedSegmentIds.size === 0) return { prefixes: [], revisionState: null };
    const allRecords = this.database
      .prepare(
        `SELECT segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms
         FROM archive_segments
         ORDER BY start_ms, segment_id`,
      )
      .all();
    const segmentsById = new Map(allRecords.map((record) => [String(record.segment_id), record]));
    const revisionsBySegment = historyArchiveEventRevisions(
      this.readMetaRaw(HISTORY_ARCHIVE_EVENT_REVISIONS_META),
      segmentsById,
    );
    const records = allRecords.filter((record) => authorizedSegmentIds.has(String(record.segment_id)));
    const prefixes = [];
    for (const record of records) {
      const snapshot = await this.readHistoryArchiveSnapshot(record);
      const coldSource = snapshot.sourceIdentities.find((source) => String(source.path) === filePath);
      if (!coldSource) continue;
      const liveIdentity = {
        path: filePath,
        kind: String(source.kind || "codex"),
        home_id: String(source.id ?? ""),
        home_label: String(source.label ?? ""),
        home_path: String(source.path ?? ""),
      };
      if (!sameHistoryArchiveSourceIdentity(liveIdentity, coldSource)) {
        throw historyArchiveError(
          "HISTORY_ARCHIVE_COLD_REPARSE_CHANGED",
          `live source identity no longer matches authorized archive segment ${String(record.segment_id)}`,
        );
      }
      const startMs = Number(record.start_ms);
      const endMs = Number(record.end_ms);
      const inPrefix = (row) =>
        String(row.source_path) === filePath && Number(row.timestamp_ms) >= startMs && Number(row.timestamp_ms) < endMs;
      const originalRows = snapshot.rows.filter(inPrefix);
      const effectiveRows = applyHistoryArchiveEventRevisions(
        record,
        snapshot,
        revisionsBySegment.get(String(record.segment_id)),
      ).filter(
        (row) =>
          String(row.source_path) === filePath &&
          Number(row.timestamp_ms) >= startMs &&
          Number(row.timestamp_ms) < endMs,
      );
      prefixes.push({
        segmentId: String(record.segment_id),
        startMs,
        endMs,
        sourceIdentity: { ...coldSource },
        originalRows,
        effectiveRows,
        observedRows: [],
      });
    }
    return { prefixes, revisionState: { segmentsById, revisionsBySegment } };
  }

  /**
   * Return raw event rows for a range, using a cold segment only when the
   * committed authority marker explicitly lists it and its hot range is empty.
   * @param {{startMs: number, endMs: number}} range
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async mergeHistoryArchiveEventsForRange(range) {
    return (await this.historyArchiveEventUnionForRange(range)).rows;
  }

  /**
   * Return the range union together with source kinds captured from the same
   * verified snapshot, so callers can project cold rows without a second read.
   * @param {{startMs: number, endMs: number}} range
   * @param {{completeHistory?: boolean, includeUsageCarrier?: boolean, includePerfCarrier?: boolean, includeMetadataCarrier?: boolean}} [options]
   * @returns {Promise<{
   *   rows: Array<Record<string, unknown>>,
   *   sourceKinds: Map<string, string>,
   *   homes?: Array<{ id: string, label: string, path: string, kind: string }>,
   *   rateLimitObservations?: import("./usage-types.js").RateLimitObservation[],
   *   perfCarrier?: any,
   *   metadataCarrier?: {generatedAt: string, homes: any[], warnings: string[]}
   * }>}
   */
  async historyArchiveEventUnionForRange(
    range,
    {
      completeHistory = false,
      includeUsageCarrier = false,
      includePerfCarrier = false,
      includeMetadataCarrier = false,
    } = {},
  ) {
    let startMs;
    let endMs;
    if (!completeHistory) {
      if (
        !range ||
        typeof range !== "object" ||
        Array.isArray(range) ||
        !Number.isSafeInteger(range.startMs) ||
        !Number.isSafeInteger(range.endMs) ||
        range.startMs >= range.endMs
      ) {
        throw new TypeError("startMs and endMs must be safe integer milliseconds with startMs < endMs");
      }
      startMs = range.startMs;
      endMs = range.endMs;
    }
    await this.open();

    let snapshot;
    this.database.exec("SAVEPOINT history_archive_union_read");
    try {
      const usageCarrier = includeUsageCarrier
        ? {
            homes: publishedUsageHomesFromDatabase(this.database),
            rateLimitObservations: quotaObservationsFromDatabase(this.database),
          }
        : {};
      const perfCarrier = includePerfCarrier ? this.capturePerfCarrier() : undefined;
      const metadataCarrier = includeMetadataCarrier
        ? {
            generatedAt: this.generatedAt,
            homes: structuredClone(this.homes),
            warnings: structuredClone(this.warnings),
          }
        : undefined;
      const revisionRawValue = this.database
        .prepare("SELECT value FROM store_meta WHERE key = ?")
        .get(HISTORY_ARCHIVE_EVENT_REVISIONS_META)?.value;
      const perfRevisionRawValue = includePerfCarrier
        ? this.database.prepare("SELECT value FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_PERF_REVISIONS_META)
            ?.value
        : undefined;
      const revisionSegmentsById = new Map(
        this.database
          .prepare(
            `SELECT segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms
             FROM archive_segments`,
          )
          .all()
          .map((segment) => [String(segment.segment_id), { ...segment }]),
      );
      const authorizedSegmentIds = historyArchiveAuthorizedSegmentIds(this.database);
      const perfAuthority = includePerfCarrier
        ? historyArchivePerfAuthority(this.database, authorizedSegmentIds, revisionSegmentsById)
        : null;
      const eventRevisions = historyArchiveEventRevisions(revisionRawValue, revisionSegmentsById);
      const perfRevisions = includePerfCarrier
        ? historyArchivePerfRevisions(
            perfRevisionRawValue,
            revisionSegmentsById,
            authorizedSegmentIds,
            new Set((perfAuthority || []).map((entry) => String(entry.segmentId))),
          )
        : new Map();
      if (completeHistory) {
        const hotBounds = this.database
          .prepare("SELECT MIN(timestamp_ms) AS minimum, MAX(timestamp_ms) AS maximum FROM events")
          .get();
        const archiveBounds = this.database
          .prepare("SELECT MIN(start_ms) AS minimum, MAX(end_ms) AS maximum FROM archive_segments")
          .get();
        const starts = [hotBounds.minimum, archiveBounds.minimum].filter((value) => value !== null).map(Number);
        const ends = [hotBounds.maximum === null ? null : Number(hotBounds.maximum) + 1, archiveBounds.maximum]
          .filter((value) => value !== null)
          .map(Number);
        if (starts.length === 0 || ends.length === 0) {
          this.database.exec("RELEASE history_archive_union_read");
          return {
            rows: [],
            sourceKinds: new Map(),
            ...usageCarrier,
            ...(perfCarrier === undefined ? {} : { perfCarrier }),
            ...(metadataCarrier === undefined ? {} : { metadataCarrier }),
          };
        }
        startMs = Math.min(...starts);
        endMs = Math.max(...ends);
      }
      const hotRows = historyArchiveEventRows(this.database, startMs, endMs);
      const segments = this.database
        .prepare(
          `SELECT segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms
           FROM archive_segments
           WHERE start_ms < ? AND end_ms > ?
           ORDER BY start_ms, segment_id`,
        )
        .all(endMs, startMs)
        .map((segment) => {
          const record = {
            segment_id: String(segment.segment_id),
            database_path: String(segment.database_path),
            database_sha256: String(segment.database_sha256),
            start_ms: Number(segment.start_ms),
            end_ms: Number(segment.end_ms),
            event_count: Number(segment.event_count),
            registered_at_ms: Number(segment.registered_at_ms),
          };
          return {
            segmentId: record.segment_id,
            record,
            hotRows: historyArchiveEventRows(this.database, record.start_ms, record.end_ms),
            sourceIdentities: historyArchiveSourceIdentities(this.database, record.start_ms, record.end_ms),
            authorized: authorizedSegmentIds.has(record.segment_id),
          };
        });
      const liveSourceIdentities = new Map(
        this.database
          .prepare(
            `SELECT path, kind, home_id, home_label, home_path
             FROM source_files
             ORDER BY path, kind, home_id, home_label, home_path`,
          )
          .all()
          .map((row) => [String(row.path), { ...row }]),
      );
      this.database.exec("RELEASE history_archive_union_read");
      snapshot = {
        hotRows,
        segments,
        liveSourceIdentities,
        usageCarrier,
        perfCarrier,
        perfAuthority,
        perfRevisions,
        metadataCarrier,
        eventRevisions,
      };
    } catch (error) {
      this.database.exec("ROLLBACK TO history_archive_union_read");
      this.database.exec("RELEASE history_archive_union_read");
      throw error;
    }

    const rows = snapshot.hotRows;
    for (const segment of snapshot.segments) {
      if (segment.authorized && segment.hotRows.length > 0) {
        throw historyArchiveError(
          "HISTORY_ARCHIVE_HOT_COLD_CONFLICT",
          `authorized archive segment ${segment.segmentId} still has hot facts`,
        );
      }
      const cold = await this.readHistoryArchiveSnapshot(segment.record);
      if (segment.authorized) {
        const coldSourceByPath = new Map(cold.sourceIdentities.map((source) => [String(source.path), source]));
        const coldSourcePaths = new Set(cold.rows.map((row) => String(row.source_path)));
        if (
          coldSourceByPath.size !== coldSourcePaths.size ||
          [...coldSourcePaths].some((sourcePath) => !coldSourceByPath.has(sourcePath))
        ) {
          throw historyArchiveError(
            "HISTORY_ARCHIVE_HOT_COLD_CONFLICT",
            `archive segment ${segment.segmentId} does not contain complete source identities`,
          );
        }
        for (const source of cold.sourceIdentities) {
          const liveSource = snapshot.liveSourceIdentities.get(String(source.path));
          if (!liveSource || JSON.stringify(liveSource) !== JSON.stringify(source)) {
            throw historyArchiveError(
              "HISTORY_ARCHIVE_HOT_COLD_CONFLICT",
              `live source identity no longer matches archive segment ${segment.segmentId}`,
            );
          }
        }
        const revisedColdRows = applyHistoryArchiveEventRevisions(
          segment.record,
          cold,
          snapshot.eventRevisions.get(segment.segmentId),
        );
        for (const row of revisedColdRows) {
          if (Number(row.timestamp_ms) >= startMs && Number(row.timestamp_ms) < endMs) rows.push(row);
        }
        continue;
      }
      const hotCounts = historyArchiveEventCounts(segment.hotRows);
      const coldCounts = historyArchiveEventCounts(cold.rows);
      if (!historyArchiveEventCountsEqual(hotCounts, coldCounts)) {
        throw historyArchiveError(
          "HISTORY_ARCHIVE_HOT_COLD_CONFLICT",
          `hot facts do not mirror archive segment ${segment.segmentId}`,
        );
      }

      if (JSON.stringify(cold.sourceIdentities) !== JSON.stringify(segment.sourceIdentities)) {
        throw historyArchiveError(
          "HISTORY_ARCHIVE_HOT_COLD_CONFLICT",
          `hot source identities do not mirror archive segment ${segment.segmentId}`,
        );
      }
    }

    if (snapshot.perfAuthority) {
      for (const { segmentId, record, sourceKind } of snapshot.perfAuthority) {
        const coldPerf = await this.#readHistoryArchivePerfRecord(segmentId, record, {
          requirePerfComponents: true,
          sourceKind,
          revisions: snapshot.perfRevisions.get(segmentId),
        });
        snapshot.perfCarrier = mergeHistoryArchivePerfSamples(
          snapshot.perfCarrier,
          coldPerf.samples,
          sourceKind,
          coldPerf.revisionsBySampleKey,
        );
      }
    }

    rows.sort((left, right) => {
      const timeDelta = Number(left.timestamp_ms) - Number(right.timestamp_ms);
      if (timeDelta !== 0) return timeDelta;
      const leftPayload = JSON.stringify(canonicalFactPayload(left, ["id"]));
      const rightPayload = JSON.stringify(canonicalFactPayload(right, ["id"]));
      return leftPayload < rightPayload ? -1 : leftPayload > rightPayload ? 1 : 0;
    });
    const sourceKinds = new Map();
    for (const row of rows) {
      const sourcePath = String(row.source_path);
      const source = snapshot.liveSourceIdentities.get(sourcePath);
      if (source) sourceKinds.set(sourcePath, String(source.kind));
    }
    return {
      rows,
      sourceKinds,
      ...snapshot.usageCarrier,
      ...(snapshot.perfCarrier === undefined ? {} : { perfCarrier: snapshot.perfCarrier }),
      ...(snapshot.metadataCarrier === undefined ? {} : { metadataCarrier: snapshot.metadataCarrier }),
    };
  }

  /** Read timing evidence through the store's one SQLite connection. */
  lookupRequestTiming(query) {
    if (!this.database) throw new TypeError("UsageStore is not open");
    return lookupStoredRequestTiming(this.database, query);
  }

  /** @returns {string[]} */
  requestTimingDirtyThreads(homeId) {
    return this.database
      .prepare("SELECT thread_id FROM perf_request_timing_dirty_threads WHERE home_id = ? ORDER BY thread_id")
      .all(homeId)
      .map((row) => String(row.thread_id));
  }

  requestTimingDirtyThreadCount() {
    return Number(
      this.database.prepare("SELECT COUNT(*) AS count FROM perf_request_timing_dirty_threads").get()?.count ?? 0,
    );
  }

  /**
   * M3.4：读出 **perf 状态机**的持久化投影（供 `summarize` 在同一读事务内调用）。
   *
   * ⚠️ 必须在**读事务内**调用：`perf_state` 由 `sync()` 在多处写入（每次 `replaceFile`
   * 之间都会变），事务外读取会拿到**撕裂**的状态与候选。
   *
   * **AN-6**：`perf_state` 键**缺失**（从未同步）与 `"ready"` 是**两件事** ⇒ 分别返回
   * `state: "uninitialized"` 与 `state: "ready"`。`degradedHomeIds`/`sourceWarnings`
   * 缺键时返回 `[]`（那是"没有退化项"的真实含义，与上面的"状态未知"不同）。
   * @returns {PerfStateProjection}
   */
  perfState() {
    const rawState = this.readMetaRaw("perf_state");
    const degradedRaw = this.readMetaRaw("perf_degraded_home_ids");
    const warningsRaw = this.readMetaRaw("perf_source_warnings");
    return {
      // `uninitialized` 是**读取投影专有**的取值（键缺失），不属于持久化三态。
      state: /** @type {PerfStateProjection["state"]} */ (
        rawState === undefined || rawState === "" ? PERF_STATE_UNINITIALIZED : rawState
      ),
      indexVersion: this.readMeta("perf_index_version"),
      methodVersion: this.readMeta("perf_method_version"),
      indexedAt: this.readMeta("perf_indexed_at"),
      degradedHomeIds: decodeJsonStringArray(degradedRaw),
      sourceWarnings: decodeJsonWarnings(warningsRaw),
      missingSources: decodeMissingSources(this.readMetaRaw(MISSING_SOURCES_META)),
      codexPublicationPolicy: this.readMetaRaw("perf_codex_publication_policy"),
    };
  }

  /** M3.4：写入 perf 状态机三态。`state` 必须是已知取值（AN-6：不得写入未定义状态）。 */
  /**
   * M3.4 返工2 **BC-2**：读取**已成功发布**的逐文件指纹映射（`path → 指纹`）。
   *
   * 该映射只能由 `replaceFile` 在**文件替换事务内**写入 ⇒ 它是一份
   * "**与已提交候选同源**"的指纹表，而不是"当前上游的实时状态"。
   * 缺键/坏值一律 `{}`（读取路径不得因元数据坏掉而失败）。
   * @returns {Record<string, string>}
   */
  readPublishedFileFingerprints() {
    const raw = this.readMetaRaw("perf_file_fingerprints");
    if (typeof raw !== "string" || raw === "") return {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      /** @type {Record<string, string>} */
      const out = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * Read the last successfully published file diagnostics.
   * Besides reader warnings, this includes committed project-log truncation
   * and malformed-line markers.
   * The sidecar is committed atomically with that file's candidates, so an
   * interrupted/failed replacement cannot erase diagnostics for old rows.
   * @returns {Record<string, {sourceKind: string, homeId: string, code: string, count: number, lineNumbers?: number[]}[]>}
   */
  readPublishedFileWarnings() {
    const raw = this.readMetaRaw("perf_file_warnings");
    if (typeof raw !== "string" || raw === "") return {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      /** @type {Record<string, {sourceKind: string, homeId: string, code: string, count: number, lineNumbers?: number[]}[]>} */
      const out = {};
      for (const [filePath, warnings] of Object.entries(parsed)) {
        if (Array.isArray(warnings)) out[filePath] = normalizePublishedFileWarnings(warnings);
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * S1：**本轮**（`sync()` 内）已解码的 published 指纹映射 —— 轮内全轮复用同一份，整轮至多
   * 解码一次；`sync()` 之外（视图为 `null`）与 `readPublishedFileFingerprints()` 逐字等价。
   * 返回值是**新对象**，调用方可自由 `delete`/展开。
   * @returns {Record<string, string>}
   */
  publishedFileFingerprintsForRound() {
    const view = this.publishedFileMapsView;
    return view === null ? this.readPublishedFileFingerprints() : view.fingerprintsForRound();
  }

  /**
   * S1：**本轮**（`sync()` 内）已解码的 published 告警映射 —— 轮内全轮复用同一份，整轮至多
   * 解码一次；`sync()` 之外（视图为 `null`）与 `readPublishedFileWarnings()` 逐字等价。
   * 返回值是**新对象**（数组分量共享，读方只做键级改写）。
   * @returns {Record<string, {sourceKind: string, homeId: string, code: string, count: number, lineNumbers?: number[]}[]>}
   */
  publishedFileWarningsForRound() {
    const view = this.publishedFileMapsView;
    return view === null ? this.readPublishedFileWarnings() : view.warningsForRound();
  }

  publishedFileFingerprintsForRead() {
    return this.publishedFileMapsView?.readFingerprints() ?? this.readPublishedFileFingerprints();
  }

  publishedFileWarningsForRead() {
    return this.publishedFileMapsView?.readWarnings() ?? this.readPublishedFileWarnings();
  }

  /**
   * S2 卡：从**已经完成的稳定窗口**里取出该物理文件的等价内容摘要；取不到就返回 `undefined`
   * （调用方必须重新探针）。
   *
   * 窗口身份 = `planStableCodexHome()` 返回的**对象本身**（卡面要求"缓存绑定窗口身份/版本，
   * 而不是绑时间或全局"）。因此：
   *   * 未规划 / 规划失败（`codexPlans` 无该 home 的条目）⇒ 不复用；
   *   * `window.ok !== true`（home 不可用）⇒ 不复用；
   *   * `window.stable !== true`（**读取期间来源变化** / 文件集合变化 / 规划出错）⇒ 不复用；
   *   * `window.after.complete !== true`（有文件不可读 ⇒ 快照不可证）⇒ 不复用；
   *   * 该文件不在 `after.fileFingerprints` 里（**新观测**：新文件或路径变化）⇒ 不复用。
   * 任何一条不满足，调用方走原路径（`enabledPerfSourceStat` 真实探针）。
   *
   * ⚠️ 只对 **Codex rollout** 生效：`main`/`jetbrains`/`extra` 都会被 `canonicalizeKind` 折成
   * `codex`；其它来源（zcode/dsh/opencode）没有这种"整 home 解析前后摘要"的窗口，一律重新探针。
   *
   * @param {any} plan `codexPlans.get(homeId)` 的条目（或 undefined）
   * @param {string} kind 发现时给出的原始 kind（可能是 `main`/`extra` 等别名）
   * @param {string} filePath
   * @returns {string | undefined}
   */
  codexWindowedProbeValue(plan, kind, filePath) {
    if (canonicalizeKind(kind) !== "codex") return undefined;
    const window = plan?.window;
    if (window?.ok !== true || window.stable !== true) return undefined;
    const after = window.after;
    if (after?.complete !== true) return undefined;
    const fileFingerprints = after.fileFingerprints;
    if (!fileFingerprints || typeof fileFingerprints !== "object") return undefined;
    // 快路径：发现路径与窗口键逐字相同（本轮实测 100% 命中，零额外分配）。
    if (Object.hasOwn(fileFingerprints, filePath)) return fileFingerprints[filePath];
    // 慢路径：同一物理文件的另一种写法（大小写/相对路径/分隔符）—— 规范化后查找，索引只建一次。
    let index = plan.probePathIndex;
    if (!index || index.forWindow !== after) {
      index = new Map();
      for (const [candidate, fingerprint] of Object.entries(fileFingerprints)) {
        index.set(canonicalPerfProbePath(candidate), fingerprint);
      }
      index.forWindow = after;
      plan.probePathIndex = index;
    }
    return index.get(canonicalPerfProbePath(filePath));
  }

  /**
   * C2 卡：从**复用轮的稳定失败签名**里取出该物理文件的等价内容摘要；取不到返回 `undefined`
   * （调用方必须走真实探针）。
   *
   * 这是 C1 收益与 S2 收益**不叠加**的补丁：C1 的复用轮**不进入** `codexPlans`，于是 S2 的
   * "读取后稳定窗口"不存在 ⇒ 逐文件判据只能对签名里那 362 个文件**再取一遍**内容摘要
   * （C1 交付态实测：复用轮 `store.decision.loop` 从 88 回到 449，多出 361 次重复探针）。
   * 本方法把**同一次**轮首探针的结果直接供给消费点，于是"同一物理文件在同一轮只取一次摘要"。
   *
   * ⚠️ 与 S2 的 {@link UsageStore#codexWindowedProbeValue} **同型守卫、同三条红线**：
   *   1. 摘要来源 = `codexStableAttemptMatch()` 在**本轮轮首**对完整排序路径集的逐文件
   *      `enabledPerfSourceStat`（首尾各 64KiB，**不是**全文解析）。从取值到消费点之间
   *      **没有对该文件的任何读取**（复用轮不调用 `planStableCodexHome`；整文件用量读取
   *      `usageFiles()` 发生在**签名之前**）⇒ 消费点拿到的是本文件最近一次真实观测。
   *   2. **不喂发布前复核**（`store.windowPrePublish`）：复用轮该 home 不在 `codexPlans`
   *      ⇒ 复核本轮**根本不执行**；本方法只供给逐文件判据。
   *      一旦有人把它接到复核上，`LIVE_SOURCE_CHANGED` 就会静默失效（`mut-publish-reuses-after`）。
   *   3. **不喂 `window.after` / 不把 `window.before` 当 `window.after`**：本方法不引入任何窗口绑定，
   *      它的来源是独立探针，不是任何窗口的 before/after 分量。
   *
   * 守卫（任一条不满足 ⇒ `undefined` ⇒ 真实探针）：
   *   * `canonicalizeKind(kind) !== "codex"`（签名只覆盖 codex rollout 文件集合）；
   *   * 本轮该 home 没有命中记录（签名 `undefined`）；
   *   * 该路径不在签名里（新增/删除/重命名/写法不同且规范化后仍不命中）。
   *
   * @param {{ paths: string[], fileFingerprints: Record<string, string>, probePathIndex?: Map<string, string> & { forSignature?: Record<string, string> } } | undefined} signature
   * @param {string} kind 发现时给出的原始 kind（`main`/`jetbrains`/`extra` 等同义别名）
   * @param {string} filePath
   * @returns {string | undefined}
   */
  codexReusedProbeValue(signature, kind, filePath) {
    if (canonicalizeKind(kind) !== "codex") return undefined;
    const fileFingerprints = signature?.fileFingerprints;
    if (!fileFingerprints || typeof fileFingerprints !== "object") return undefined;
    // 快路径：发现路径与签名键逐字相同（本轮隔离输入 100% 命中，零额外分配）。
    if (Object.hasOwn(fileFingerprints, filePath)) return fileFingerprints[filePath];
    // 慢路径：同一物理文件的另一种写法（大小写/相对路径/分隔符）—— 规范化后查找，索引只建一次。
    // 索引的身份是**签名对象本身**（`forSignature` 绑 `fileFingerprints` 而不是绑时间）：换签名
    // 必须重建，否则调用方会拿到上一个签名的事实（过期摘要 = 静默跳过一次真实变更）。
    let index = signature.probePathIndex;
    if (!index || index.forSignature !== fileFingerprints) {
      index = new Map();
      for (const [candidate, fingerprint] of Object.entries(fileFingerprints)) {
        index.set(canonicalPerfProbePath(candidate), fingerprint);
      }
      index.forSignature = fileFingerprints;
      signature.probePathIndex = index;
    }
    return index.get(canonicalPerfProbePath(filePath));
  }

  /**
   * C1 卡：**稳定失败尝试记录**的命中判定 —— 这是**唯一**允许"跳过整 home 规划"的入口。
   *
   * 命中必须同时满足（任一条不满足 ⇒ **立刻清除**旧记录并返回 `null`，调用方走原规划路径）：
   *   1. **方法版本**相同（`PERF_METHOD_VERSION` + `CODEX_PUBLICATION_POLICY_REVISION`）；
   *   2. **home 身份**相同（id + kind + path —— 跨 home 迁移/别名变化/换 home 目录都失效）；
   *   3. **完整排序路径集**逐字相同（新增/删除/重命名 rollout 立即失效）；
   *   4. **逐文件内容指纹**逐字相同（同尺寸同 mtime 的原地改写、SQLite WAL 改写都失效）；
   *   5. 当前签名**可证**（任一文件取不到指纹 ⇒ `null` ⇒ 不复用）。
   *
   * ⚠️ 与 S2 的范式一致：复用绑定的是**可判定的身份/版本**（home 对象 + 本轮路径集 + 逐文件内容
   * 指纹 + 方法版本），**不绑时间、不绑全局**，也不跨实例。窗口失效 ⇒ 立刻重新计算。
   *
   * ⚠️ 命中判定**只做内容探针**（首尾各 64KiB），不读全文、不调用 `readCodexRolloutMetadata`；
   * 而且只有**该 home 已有记录**时才探针（无记录 ⇒ 直接返回 `null`，零额外 I/O）。
   *
   * @param {string} homeId
   * @param {any} home 本轮 discovery 给出的 home（或旧行重建的等价对象）
   * @param {string[]} expectedPaths 本轮发现到的该 home 完整物理路径集
   * @returns {any | null} 命中的记录（**只读**，调用方不得就地改写）
   */
  codexStableAttemptMatch(homeId, home, expectedPaths) {
    const attempt = this.codexStableAttempts.get(homeId);
    if (attempt === undefined) return null;
    /** 失配 ⇒ 记录已陈旧：**立刻清除**，绝不让它在下一次签名恰好重现时被误用。 */
    const stale = () => {
      this.codexStableAttempts.delete(homeId);
      return null;
    };
    if (attempt.methodVersion !== codexStableAttemptMethodVersion()) return stale();
    if (String(home?.id ?? "") !== attempt.homeId) return stale();
    if (String(home?.kind ?? "") !== attempt.homeKind) return stale();
    if (String(home?.path ?? "") !== attempt.homePath) return stale();
    const expected = [...expectedPaths].sort();
    if (expected.length !== attempt.paths.length) return stale();
    for (const [index, filePath] of expected.entries()) {
      if (filePath !== attempt.paths[index]) return stale();
    }
    const current = codexHomeContentSignature(home?.kind, expected);
    if (current === null) return stale();
    for (const filePath of attempt.paths) {
      if (current.fileFingerprints[filePath] !== attempt.fileFingerprints[filePath]) return stale();
    }
    return attempt;
  }

  writePerfState(state, { degradedHomeIds = [], sourceWarnings = [] } = {}) {
    if (!PERF_STATES.has(state)) {
      throw new TypeError(`perf_state must be one of ${[...PERF_STATES].join("/")}, got ${JSON.stringify(state)}`);
    }
    this.writeMeta("perf_state", state);
    // 两个列表值以**本地 JSON** 存储（`store_meta.value` 是 STRICT TEXT ⇒ 必须自行编码）。
    this.writeMeta("perf_degraded_home_ids", JSON.stringify(normalizeDegradedHomeIds(degradedHomeIds)));
    this.writeMeta("perf_source_warnings", JSON.stringify(normalizeSourceWarnings(sourceWarnings)));
  }

  /**
   * M3.1 写入原语：把一个**已归一化**的 `PerfSample` 写进 `perf_samples`。
   *
   * 只绑定参数、不拼 SQL、不拼身份（列序由 `PERF_SAMPLE_FIELDS` 决定）。身份由
   * `sampleKey` 原样携带（M1 的规范 JSON 元组），这里既不解析也不重建。
   * 外键要求 `source_path` 已存在于 `source_files`（M3.2 在同一事务里先写来源行）。
   * @param {unknown} sample
   */
  insertPerfSample(sample, statement) {
    const row = encodePerfSample(sample);
    return (statement ?? this.database.prepare(PERF_SAMPLE_INSERT_SQL)).run(
      ...PERF_SAMPLE_FIELDS.map((entry) => row[entry.column]),
    );
  }

  /**
   * M3.1 读取原语：按主键读回一个候选并解码（全列，`decode(encode(s))` 与 `s` 同形）。
   * 范围查询属于 M3.3，不在这里实现。
   * @param {unknown} sampleKey
   * @returns {import("./usage-types.js").PerfSampleRowDecoded | null}
   */
  perfSampleByKey(sampleKey) {
    const row = this.database.prepare(`${PERF_SAMPLE_SELECT_SQL} WHERE sample_key = ?`).get(String(sampleKey));
    return row === undefined ? null : decodePerfSample(row);
  }

  /**
   * M3.3：按范围与来源取候选，**只做范围/来源限制**，不做任何统计。
   *
   * 与 M1 内存路径（`selectPerfSamples`）**逐字同形**是硬性要求，因此：
   * - 上下界规则完全照抄 `perfTsInRange`（`src/perf-stats.js:1431`）：`startMs` inclusive、
   *   `endMs` inclusive，且 **`windowEndExclusiveMs` 存在时 `endMs` 被忽略**。后者之所以重要：
   *   配额 range 同时带 `end`（= `effectiveEndExclusive - 1`）与一个**更晚的** `windowEndExclusive`，
   *   若把两者都塞进 SQL，`end` 会把 `windowEndExclusive` 之前、`end` 之后的样本错误地挡掉
   *   （探针实测：实验 A/B 的 eligible 集合确实不同）。
   * - 边界值用 `perfRangeBoundMs` 的同一套校验（Date 或有限数字；非有限值抛 `TypeError`）。
   *   绝不用 `(? IS NULL OR ...)` 那种写法糊弄非法值 —— `ts < NaN` 恒 false 会**静默禁用**边界。
   * - `excludedHomeIds` 按 **`home_id`** 过滤（不是 `channel`/`source_kind`）：同一规范来源下
   *   多个 home 的 `channel` 完全相同，只有 `home_id` 能区分。
   * - `ts_ms IS NULL` 的 unplaced 候选**不进本方法**（它们没有位置，塞进当前范围会污染 eligible）；
   *   用 {@link UsageStore#unplacedPerfSamples} 单独取。
   *
   * @param {{ startMs?: unknown, endMs?: unknown, windowEndExclusiveMs?: unknown } | null} range
   * @param {Iterable<string>} [excludedHomeIds]
   * @returns {import("./usage-types.js").PerfSampleRowDecoded[]} 按 `sample_key` 升序（稳定）
   */
  perfCandidatesForRange(range, excludedHomeIds = [], stream = false) {
    const bounds = perfRangeBounds(range);
    const excluded = normalizeExcludedHomeIds(excludedHomeIds);

    const predicates = ["ts_ms IS NOT NULL"];
    const params = [];
    if (bounds.startMs !== null) {
      predicates.push("ts_ms >= ?");
      params.push(bounds.startMs);
    }
    if (bounds.windowEndExclusiveMs !== null) {
      // 与 `perfTsInRange` 同序：window 存在则**忽略** endMs。
      predicates.push("ts_ms < ?");
      params.push(bounds.windowEndExclusiveMs);
    } else if (bounds.endMs !== null) {
      predicates.push("ts_ms <= ?");
      params.push(bounds.endMs);
    }
    for (const homeId of excluded) {
      predicates.push("home_id <> ?");
      params.push(homeId);
    }

    const sql = `${PERF_SAMPLE_SELECT_SQL} WHERE ${predicates.join(" AND ")} ORDER BY sample_key`;
    // 全列解码，**不得**跳过：AP-4 已实测 STRICT 会把 `'7'` 无损换算成 7 ⇒ 信任库中值会出错。
    // Decode as rows arrive so raw SQL rows and decoded samples never coexist in full.
    const rows = this.database.prepare(sql).iterate(...params);
    if (stream) {
      return /** @type {any} */ (
        (function* () {
          for (const row of rows) yield decodePerfSample(row);
        })()
      );
    }
    return Array.from(rows, decodePerfSample);
  }

  /**
   * M3.3：`ts_ms IS NULL` 的 unplaced 候选，供全历史来源诊断。
   *
   * **刻意与 {@link UsageStore#perfCandidatesForRange} 分开**：unplaced 没有时间位置，
   * 放进当前范围会把"无位置"混成"在范围内"，从而污染 eligible 与分母。
   * @param {Iterable<string>} [excludedHomeIds]
   * @returns {import("./usage-types.js").PerfSampleRowDecoded[]} 按 `sample_key` 升序
   */
  unplacedPerfSamples(excludedHomeIds = [], stream = false) {
    const excluded = normalizeExcludedHomeIds(excludedHomeIds);
    const predicates = ["ts_ms IS NULL"];
    const params = [];
    for (const homeId of excluded) {
      predicates.push("home_id <> ?");
      params.push(homeId);
    }
    const rows = this.database
      .prepare(`${PERF_SAMPLE_SELECT_SQL} WHERE ${predicates.join(" AND ")} ORDER BY sample_key`)
      .iterate(...params);
    if (stream) {
      return /** @type {any} */ (
        (function* () {
          for (const row of rows) yield decodePerfSample(row);
        })()
      );
    }
    return Array.from(rows, decodePerfSample);
  }

  /**
   * D5：`rankedHomeIds` 需要的**必要身份列**投影（`sample_key` / `source_kind` / `home_id`）。
   *
   * 取排名只需要"哪些 home 有候选"与 Codex 候选的线程身份（`sample_key` 里的
   * `["codex", homeId, threadId, turnId]`），**不需要**解码全量样本 JSON
   * （`decodePerfSample` 会逐列校验并 `JSON.parse` 诊断链）。
   *
   * 行集与旧实现 `perfCandidatesForRange(null) ∪ unplacedPerfSamples()` 的并集**逐行同集**：
   * 前者 `ts_ms IS NOT NULL`、后者 `ts_ms IS NULL`，两者都不带 home 排除 ⇒ 并集就是全表；
   * 本方法无 `WHERE`、无 `ORDER BY`（调用方只用集合，最终由 `Set` + 默认排序定序）。
   *
   * ⚠️ 边界（D5 §5 已记录）：本方法**不做**行级解码校验 ⇒ 范围外的坏行不会在这里响亮失败；
   * 范围内的坏行仍由 `perfCandidatesForRange` 的解码路径响亮失败（该路径继续服务统计块）。
   * @param {boolean} [rankedOnly]
   * @returns {ReadonlyArray<{ sampleKey: string, sourceKind: string, homeId: string }> | {
   *   codexThreadsByHome: Map<string, Set<string>>,
   *   otherHomeIds: Set<string>,
   * }}
   */
  perfSampleIdentities(rankedOnly = false) {
    const rows = this.database.prepare("SELECT sample_key, source_kind, home_id FROM perf_samples").iterate();
    if (!rankedOnly) {
      return Array.from(rows, (row) => ({
        sampleKey: String(row.sample_key ?? ""),
        sourceKind: String(row.source_kind ?? ""),
        homeId: String(row.home_id ?? ""),
      }));
    }
    const codexThreadsByHome = new Map();
    const otherHomeIds = new Set();
    for (const row of rows) {
      const sampleKey = String(row.sample_key ?? "");
      const sourceKind = String(row.source_kind ?? "");
      const homeId = String(row.home_id ?? "");
      if (sourceKind === "codex") {
        if (homeId === "") continue;
        const threadId = codexSampleThreadId({ sampleKey, sourceKind, homeId });
        const threadIds = codexThreadsByHome.get(homeId) ?? new Set();
        threadIds.add(threadId);
        codexThreadsByHome.set(homeId, threadIds);
      } else if (homeId !== "") {
        otherHomeIds.add(homeId);
      }
    }
    return { codexThreadsByHome, otherHomeIds };
  }

  async usageFiles(homes) {
    const files = [];
    const warnings = [];
    /** @type {any[]} */
    const failedHomes = [];
    for (const home of homes) {
      try {
        if (home.kind === "project-log" && home.usageLogPath) {
          files.push({ filePath: home.usageLogPath, source: home, info: await stat(home.usageLogPath) });
          continue;
        }
        if (home.kind === "zcode" && home.usageLogPath) {
          files.push({ filePath: home.usageLogPath, source: home, info: await zcodeSourceStat(home.usageLogPath) });
          continue;
        }
        if (home.kind === "dsh") {
          // DSH 的用量按会话分散在多个日志文件里，逐个纳入增量索引
          // （每个文件各自按 size+mtime 判定是否需要重解析）。
          for (const filePath of await dshSessionFiles(home.path)) {
            files.push({ filePath, source: home, info: await stat(filePath) });
          }
          continue;
        }
        if (home.kind === "opencode") {
          // 单个数据目录下可能有多个数据库（opencode.db、opencode-<channel>.db），
          // 逐个纳入增量索引（含 -wal 指纹）。
          for (const filePath of await opencodeDatabaseFiles(home.path)) {
            files.push({ filePath, source: home, info: await opencodeSourceStat(filePath) });
          }
          continue;
        }
        if (home.kind === "claude") {
          // Claude Code 的用量按会话转录分散在 projects/**/*.jsonl（含 subagents），
          // 每个文件各自按 size+mtime 判定是否需要重解析。
          for (const filePath of await claudeSessionFiles(home.path)) {
            files.push({ filePath, source: home, info: await stat(filePath) });
          }
          continue;
        }
        if (home.kind === "workbuddy") {
          // WorkBuddy 同样是逐会话转录；会话文件是普通 jsonl，没有 `-wal`（perf 指纹另由
          // `enabledPerfSourceStat` 统一处理）。
          for (const filePath of await workbuddySessionFiles(home.path)) {
            files.push({ filePath, source: home, info: await stat(filePath) });
          }
          continue;
        }
        for (const filePath of await discoverSessionFiles(home.path)) {
          files.push({ filePath, source: home, info: await stat(filePath) });
        }
      } catch (error) {
        failedHomes.push({ id: home.id, path: home.path });
        warnings.push(`无法读取 ${home.path}: ${error.message}`);
      }
    }
    return { files, warnings, failedHomes };
  }

  /**
   * S4：把 WorkBuddy trace 里的 `generation` 时长同步进按 home 归属的 observation 表。
   *
   * 调用纪律（实施计划 §0 最后一段 + §5 S4）：
   *   * **必须在 `replaceFile` 之外**调用 —— 那里是唯一跨 `await` 的写事务，事务内做文件 I/O
   *     会把读路径钉在快照上；
   *   * 文件 I/O 全部在事务**外**：先把变化的文件读成内存数组，再开一个同步事务批量
   *     `INSERT OR IGNORE`；
   *   * 指纹只在**写成功后**更新；解析失败的文件不更新指纹（下轮重试）并记一条 warning；
   *   * 单文件失败不影响其它文件；目录不存在是正常状态，不告警。
   *
   * @param {string} homePath
   * @param {{ homeId?: string, onWarning?: (warning: string) => void }} [options]
   * @returns {Promise<{
   *   filesScanned: number,
   *   filesParsed: number,
   *   spans: number,
   *   written: boolean,
   *   insertedMessageIds: string[],
   *   traceDependency: string | null,
   *   traceComplete: boolean
   * }>}
   */
  async refreshWorkbuddyDurations(homePath, { homeId, onWarning } = {}) {
    const database = this.database;
    const outcome = {
      filesScanned: 0,
      filesParsed: 0,
      spans: 0,
      written: false,
      insertedMessageIds: [],
      traceDependency: null,
      traceComplete: false,
    };
    if (!database) return outcome;
    const scopedHomeId = String(homeId ?? "").trim() || homePath;
    const previousLookup = this.workbuddyTextTimingLookups.get(scopedHomeId);
    const previousTextIds = this.workbuddyTextMessageIds.get(scopedHomeId) ?? new Set();
    this.workbuddyTextTimingLookups.delete(scopedHomeId);
    this.workbuddyTextMessageIds.delete(scopedHomeId);
    let traceState;
    try {
      traceState = await inspectWorkbuddyTrace(homePath);
    } catch (error) {
      onWarning?.(`无法读取 WorkBuddy trace 目录 ${homePath}: ${error.message}`);
      return outcome;
    }
    outcome.filesScanned = traceState.fingerprints.size;
    outcome.traceComplete = traceState.complete;
    outcome.traceDependency = traceState.complete ? traceState.fingerprint : null;

    const changed = [];
    const changedMessageIds = new Set();
    for (const [filePath, fingerprint] of traceState.fingerprints) {
      if (fingerprint === null) continue;
      const previous = this.workbuddyTraceFingerprints.get(filePath);
      if (previous === fingerprint) continue;
      changed.push({ filePath, fingerprint });
    }
    const removed = [];
    const homePrefix = `${canonicalPerfProbePath(homePath)}${path.sep}`;
    for (const knownPath of this.workbuddyTraceFingerprints.keys()) {
      if (canonicalPerfProbePath(knownPath).startsWith(homePrefix) && !traceState.fingerprints.has(knownPath)) {
        removed.push(knownPath);
      }
    }

    const rows = [];
    const parsed = [];
    const insertedMessageIds = new Set();
    for (const file of changed) {
      try {
        const text = traceState.textFiles.includes(file.filePath);
        let spans;
        if (text) {
          spans = await workbuddyTextTimingSpans(file.filePath, { onWarning });
        } else {
          spans = await workbuddyTraceSpans(file.filePath, { onWarning });
          rows.push(...spans);
        }
        parsed.push({ ...file, spans });
        outcome.filesParsed += 1;
      } catch (error) {
        onWarning?.(`无法解析 WorkBuddy trace ${file.filePath}: ${error.message}`);
      }
    }
    outcome.spans = rows.length;
    if (parsed.length !== changed.length) {
      outcome.traceComplete = false;
      outcome.traceDependency = null;
    }

    if (rows.length > 0) {
      const insert = database.prepare(`
        INSERT OR IGNORE INTO workbuddy_generation_duration_observations
          (home_id, message_id, duration_ms, ended_at_ms, capture_version, captured_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const capturedAt = new Date().toISOString();
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const row of rows) {
          const result = insert.run(
            scopedHomeId,
            row.messageId,
            row.durationMs,
            row.endedAtMs,
            WORKBUDDY_CAPTURE_VERSION,
            capturedAt,
          );
          if (Number(result.changes) > 0) insertedMessageIds.add(row.messageId);
        }
        database.exec("COMMIT");
        outcome.written = true;
      } catch (error) {
        database.exec("ROLLBACK");
        // 写失败 ⇒ 指纹一律不更新（下轮重试），本轮 sync 不因预扫失败而整体失败。
        onWarning?.(`无法写入 WorkBuddy 响应时长: ${error.message}`);
        outcome.traceComplete = false;
        outcome.traceDependency = null;
        return outcome;
      }
    }

    for (const filePath of removed) {
      this.workbuddyTimingSpans.delete(filePath);
      this.workbuddyTraceFingerprints.delete(filePath);
    }
    for (const file of parsed) {
      this.workbuddyTimingSpans.set(file.filePath, file.spans);
      this.workbuddyTraceFingerprints.set(file.filePath, file.fingerprint);
    }
    const textSpans = traceState.textFiles.flatMap((file) => this.workbuddyTimingSpans.get(file) ?? []);
    const generationSpans = traceState.traceFiles.flatMap((file) => this.workbuddyTimingSpans.get(file) ?? []);
    const textMessageIds = new Set(textSpans.map((span) => span.messageId));
    const lookup = outcome.traceComplete ? createWorkbuddyTextTimingLookup(textSpans, generationSpans) : () => null;
    if (parsed.length > 0 || removed.length > 0) {
      // Shared trace graphs can change without changing another response's timing proof.
      for (const id of new Set([...previousTextIds, ...textMessageIds])) {
        if (
          previousTextIds.has(id) !== textMessageIds.has(id) ||
          JSON.stringify(previousLookup?.(id) ?? null) !== JSON.stringify(lookup(id))
        ) {
          changedMessageIds.add(id);
        }
      }
    }
    this.workbuddyTextMessageIds.set(scopedHomeId, textMessageIds);
    this.workbuddyTextTimingLookups.set(scopedHomeId, lookup);
    outcome.insertedMessageIds = [...new Set([...insertedMessageIds, ...changedMessageIds])].sort();
    return outcome;
  }

  /**
   * @param {any} file
   * @param {{
   *   onWarning?: (warning: string) => void,
   *   noteLiveChangeWarning?: (sourceKind: string, homeId: string) => void,
   *   liveChangedPaths?: Set<string>,
   *   blockedHomeIds?: Set<string>,
   *   committedFingerprints?: Map<string, string>,
   *   onPerfWarning?: (warning: any) => void,
   *   onWorkbuddyDurationGap?: (homeLabel: string, count: number) => void,
   *   legacyWorkbuddyFallbackAllowed?: boolean,
   * }} [options]
   */
  async replaceFile(
    { filePath, source, info },
    {
      onWarning,
      noteLiveChangeWarning,
      liveChangedPaths,
      blockedHomeIds,
      committedFingerprints,
      onPerfWarning,
      onWorkbuddyDurationGap,
      legacyWorkbuddyFallbackAllowed = false,
    } = {},
  ) {
    const database = this.database;
    const codexThreaded = canonicalizeKind(source.kind || "codex") === "codex";
    const siblingPath = filePath.endsWith(".jsonl.zst") ? plainRolloutPath(filePath) : `${filePath}.zst`;
    let representationFingerprint;
    const insertSource = database.prepare(`
      INSERT INTO source_files (path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        kind = excluded.kind,
        home_id = excluded.home_id,
        home_label = excluded.home_label,
        home_path = excluded.home_path,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        indexed_at = excluded.indexed_at
    `);
    const insertEvent = database.prepare(`
      INSERT INTO events (
        source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
        hour_key, day_key, week_key, month_key, cwd, repository_key, repository_path, repository_kind,
        detail_mask, reconciliation_gap, cache_write_tokens, cache_write_known, request_input_tokens,
        context_level, service_tier, price_version, total, input, cached, output, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRateLimitObservation = database.prepare(`
      INSERT INTO rate_limit_observations (
        source_path, line_number, role, observed_at_ms, limit_id, limit_name,
        plan_type, window_minutes, resets_at_ms, used_percent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertQuotaSource = database.prepare(`INSERT OR REPLACE INTO quota_usage_sources
      (source_path, home_id, session_id, timestamp_ms, quota_source, until_ms) VALUES (?, ?, ?, ?, ?, ?)`);
    const previousQuotaSources = new Map();
    const rememberQuotaSource = (event) => {
      if (canonicalizeKind(source.kind) !== "codex" || !Number.isFinite(event.timestampMs)) return;
      const value = `${event.quotaSource || "unknown"}:${event.quotaSourceUntil || 0}`;
      if (previousQuotaSources.get(event.sessionId) === value) return;
      insertQuotaSource.run(
        filePath,
        event.homeId,
        event.sessionId,
        event.timestampMs,
        event.quotaSource || "unknown",
        event.quotaSourceUntil || 0,
      );
      previousQuotaSources.set(event.sessionId, value);
    };
    const insertReplacedFact = database.prepare(HISTORY_REPLACED_FACT_INSERT_SQL);
    const previousStatement = database.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS total,
        COALESCE(SUM(input), 0) AS input, COALESCE(SUM(cached), 0) AS cached,
        COALESCE(SUM(output), 0) AS output, COALESCE(SUM(reasoning), 0) AS reasoning,
        MIN(detail_mask & 1) AS input_known, MIN(detail_mask & 2) AS cached_known,
        MIN(detail_mask & 4) AS output_known, MIN(detail_mask & 8) AS reasoning_known,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        MIN(cache_write_known) AS cache_write_known
      FROM events WHERE session_id = ? AND home_id = ? AND source_path <> ? AND timestamp_ms < ?
    `);
    const previousCumulativeForSession = (sessionId, timestamp) => {
      const timestampMs = Date.parse(timestamp);
      if (!Number.isFinite(timestampMs)) return null;
      const earlier = previousStatement.get(sessionId, source.id, filePath, timestampMs);
      if (!earlier.count) return null;
      return {
        usage: usageFromRow(earlier),
        detailMask:
          Number(earlier.input_known || 0) |
          Number(earlier.cached_known || 0) |
          Number(earlier.output_known || 0) |
          Number(earlier.reasoning_known || 0),
        cacheWrite: { tokens: Number(earlier.cache_write_tokens || 0), known: Boolean(earlier.cache_write_known) },
      };
    };
    /** D1：本事务是否真的写入了 **quota 观测行**（`rate_limit_observations`）—— 修订理由用。 */
    let quotaWritten = false;
    let truncationWarning;
    let truncationEventCount = 0;
    let coldRemovedEventCount = 0;
    const filePerfWarnings = [];
    // Stage current-round diagnostics until this replacement commits.
    const projectLogWarnings = [];
    const projectLogMalformedLines = new Set();
    database.exec("BEGIN IMMEDIATE");
    // D1：这是**唯一**跨 `await` 的写事务（下面的 `streamUsageFileEvents` / `streamPerfSamplesForFile`）
    // ⇒ 读路径可能在本事务开着的时候被调用。深度 > 0 时 `metadata()`/`periodComparison()` **不落**缓存。
    this.writeTransactionDepth += 1;
    try {
      const previousSource = database
        .prepare("SELECT path, kind, home_id, home_label, home_path, size FROM source_files WHERE path = ?")
        .get(filePath);
      const coldReparse = await this.historyArchiveReparsePrefixes(filePath, source);
      const coldReparsePrefixes = coldReparse.prefixes;
      const previousEvents = database.prepare("SELECT * FROM events WHERE source_path = ?").all(filePath);
      const previousQuotaRows = database
        .prepare("SELECT * FROM rate_limit_observations WHERE source_path = ?")
        .all(filePath);
      const previousSiblingSource = codexThreaded
        ? database
            .prepare(
              "SELECT path, kind, home_id, home_label, home_path FROM source_files WHERE path = ? AND home_id = ?",
            )
            .get(siblingPath, source.id)
        : null;
      const previousSiblingEvents = previousSiblingSource
        ? database.prepare("SELECT * FROM events WHERE source_path = ?").all(previousSiblingSource.path)
        : [];
      const previousSiblingQuotaRows = previousSiblingSource
        ? database
            .prepare("SELECT * FROM rate_limit_observations WHERE source_path = ?")
            .all(previousSiblingSource.path)
        : [];
      const previousPerfSamples = !codexThreaded
        ? database.prepare("SELECT * FROM perf_samples WHERE source_path = ?").all(filePath)
        : [];
      const previousPerfSampleSources = !codexThreaded
        ? database
            .prepare(
              `SELECT dependencies.*
               FROM perf_sample_sources AS dependencies
               JOIN perf_samples AS samples ON samples.sample_key = dependencies.sample_key
               WHERE samples.source_path = ?`,
            )
            .all(filePath)
        : [];
      representationFingerprint =
        codexThreaded && (filePath.endsWith(".jsonl.zst") || previousSiblingSource)
          ? enabledPerfSourceStat(source.kind, filePath)
          : undefined;
      insertSource.run(
        filePath,
        source.kind || "codex",
        source.id,
        source.label,
        source.path,
        info.size,
        info.mtimeMs,
        new Date().toISOString(),
      );
      database.prepare("DELETE FROM events WHERE source_path = ?").run(filePath);
      database.prepare("DELETE FROM rate_limit_observations WHERE source_path = ?").run(filePath);
      database.prepare("DELETE FROM quota_usage_sources WHERE source_path = ?").run(filePath);
      // Replace the sibling representation's usage rows, but keep its source row
      // until Codex publication has moved the native ownership.
      if (previousSiblingSource) {
        database.prepare("DELETE FROM events WHERE source_path = ?").run(previousSiblingSource.path);
        database.prepare("DELETE FROM rate_limit_observations WHERE source_path = ?").run(previousSiblingSource.path);
        database.prepare("DELETE FROM quota_usage_sources WHERE source_path = ?").run(previousSiblingSource.path);
      }
      // M3.2：性能候选的**显式**替换。必须显式 DELETE —— `source_files` 行是上面的 upsert，
      // **没有**被删除，因此 `ON DELETE CASCADE` 在这条路径上**不会触发**（M3.1 实测级联只在
      // 真删父行时生效）。旧候选保留在同一事务里，任何后续失败都会被 ROLLBACK 一起撤销。
      const previousWorkbuddySamples =
        canonicalizeKind(source.kind) === "workbuddy"
          ? new Map(
              database
                .prepare("SELECT * FROM perf_samples WHERE source_path = ?")
                .all(filePath)
                .map((row) => [String(row.sample_key), row]),
            )
          : new Map();
      if (!codexThreaded) database.prepare("DELETE FROM perf_samples WHERE source_path = ?").run(filePath);
      await streamUsageFileEvents(
        filePath,
        source,
        (event) => {
          const date = new Date(event.timestampMs);
          rememberQuotaSource(event);
          const row = {
            source_path: filePath,
            timestamp_ms: event.timestampMs,
            session_id: event.sessionId,
            home_id: event.homeId,
            home_label: event.homeLabel,
            channel: event.channel,
            project: event.project || "Unknown cwd",
            model: event.model || "Unknown model",
            hour_key: localHourKey(date),
            day_key: localDateKey(date),
            week_key: localDateKey(startOfLocalWeek(date)),
            month_key: localDateKey(date).slice(0, 7),
            cwd: event.project || "",
            repository_key: event.repositoryKey || "unknown:cwd",
            repository_path: event.repositoryPath || "Unknown cwd",
            repository_kind: event.repositoryKind || "unknown",
            detail_mask: Number(event.detailMask || 0),
            reconciliation_gap: Number(event.reconciliationGap || 0),
            cache_write_tokens: Number(event.cacheWriteTokens || 0),
            cache_write_known: event.cacheWriteKnown ? 1 : 0,
            request_input_tokens: Number(event.requestInputTokens || 0),
            context_level: event.contextLevel || "unknown",
            service_tier: event.serviceTier || "unknown",
            price_version: event.priceVersion || "",
            total: event.usage.total,
            input: event.usage.input,
            cached: event.usage.cached,
            output: event.usage.output,
            reasoning: event.usage.reasoning,
          };
          const coldPrefix = coldReparsePrefixes.find(
            (prefix) => row.timestamp_ms >= prefix.startMs && row.timestamp_ms < prefix.endMs,
          );
          if (coldPrefix) {
            coldPrefix.observedRows.push({ ...row });
            return;
          }
          insertEvent.run(...EVENT_INSERT_COLUMNS.map((column) => row[column]));
        },
        {
          repositoryResolver: this.repositoryResolver,
          previousCumulativeForSession,
          onQuotaSource: rememberQuotaSource,
          onRateLimit: ["main", "jetbrains", "extra", "codex"].includes(source.kind)
            ? (observation) => {
                insertRateLimitObservation.run(
                  filePath,
                  observation.lineNumber,
                  observation.role,
                  observation.observedAtMs,
                  observation.limitId,
                  observation.limitName,
                  observation.planType,
                  observation.windowMinutes,
                  observation.resetsAtMs,
                  observation.usedPercent,
                );
                // D1：quota 观测行确实落进**本事务** ⇒ 提交后它也是修订覆盖面的一部分（卡面"quota 发布"）。
                quotaWritten = true;
              }
            : undefined,
          onWarning:
            String(source.kind ?? "") === "project-log"
              ? (warning, details) => {
                  projectLogWarnings.push(String(warning));
                  const lineNumber = Number(details?.lineNumber);
                  if (Number.isSafeInteger(lineNumber) && lineNumber > 0) projectLogMalformedLines.add(lineNumber);
                }
              : onWarning,
        },
      );
      let coldRevisionStateChanged = false;
      for (const prefix of coldReparsePrefixes) {
        const revision = historyArchiveColdRevisionForRows(prefix);
        // Removed cold rows are absent from the hot event tables, so count them explicitly.
        if (revision) coldRemovedEventCount += revision.removedColdEventCount;
        if (!revision || !coldReparse.revisionState) continue;
        const { revisionsBySegment } = coldReparse.revisionState;
        const entries = revisionsBySegment.get(prefix.segmentId) || [];
        const existingIndex = entries.findIndex((entry) =>
          sameHistoryArchiveSourceIdentity(entry.sourceIdentity, revision.entry.sourceIdentity),
        );
        const existing = existingIndex < 0 ? null : entries[existingIndex];
        if (existing && historyArchiveRevisionEntryKey(existing) === historyArchiveRevisionEntryKey(revision.entry)) {
          continue;
        }
        if (existing) {
          saveMissingHistoryFacts(insertReplacedFact, {
            factTable: "events",
            source: prefix.sourceIdentity,
            previousRows: prefix.effectiveRows,
            currentRows: prefix.observedRows,
            methodVersion: HISTORY_REPLACED_FACT_METHOD_VERSION,
            excludedColumns: ["id"],
          });
        }
        if (revision.entry.removed.length === 0 && revision.entry.added.length === 0) {
          if (existingIndex >= 0) entries.splice(existingIndex, 1);
        } else if (existingIndex >= 0) {
          entries[existingIndex] = revision.entry;
        } else {
          entries.push(revision.entry);
        }
        revisionsBySegment.set(prefix.segmentId, entries);
        markHistoryArchiveRevisionRollupDays(database, revision.previousChangedRows, revision.currentChangedRows);
        coldRevisionStateChanged = true;
      }
      if (coldRevisionStateChanged && coldReparse.revisionState) {
        writeHistoryArchiveEventRevisionState(database, coldReparse.revisionState);
      }
      if (previousSource && previousEvents.length > 0) {
        const currentEvents = database.prepare("SELECT * FROM events WHERE source_path = ?").all(filePath);
        saveMissingHistoryFacts(insertReplacedFact, {
          factTable: "events",
          source: previousSource,
          previousRows: previousEvents,
          currentRows: currentEvents,
          methodVersion: HISTORY_REPLACED_FACT_METHOD_VERSION,
          excludedColumns: ["id"],
        });
        if (
          String(previousSource.kind ?? "") === "project-log" &&
          String(source.kind ?? "") === "project-log" &&
          info.size < Number(previousSource.size) &&
          currentEvents.length < previousEvents.length
        ) {
          truncationEventCount = previousEvents.length - currentEvents.length;
        }
      }
      if (String(source.kind ?? "") === "project-log") {
        truncationEventCount += coldRemovedEventCount;
        if (truncationEventCount > 0) {
          truncationWarning = formatProjectLogTruncationWarning(filePath, truncationEventCount);
        }
      }
      if (previousSiblingSource && previousSiblingEvents.length > 0) {
        saveMissingHistoryFacts(insertReplacedFact, {
          factTable: "events",
          source: previousSiblingSource,
          previousRows: previousSiblingEvents,
          currentRows: database.prepare("SELECT * FROM events WHERE source_path = ?").all(previousSiblingSource.path),
          methodVersion: HISTORY_REPLACED_FACT_METHOD_VERSION,
          excludedColumns: ["id"],
        });
      }
      if (previousSiblingSource && previousSiblingQuotaRows.length > 0) {
        saveMissingHistoryFacts(insertReplacedFact, {
          factTable: "rate_limit_observations",
          source: previousSiblingSource,
          previousRows: previousSiblingQuotaRows,
          currentRows: database
            .prepare("SELECT * FROM rate_limit_observations WHERE source_path = ?")
            .all(previousSiblingSource.path),
          methodVersion: HISTORY_REPLACED_QUOTA_METHOD_VERSION,
        });
      }
      if (previousSource && previousQuotaRows.length > 0) {
        saveMissingHistoryFacts(insertReplacedFact, {
          factTable: "rate_limit_observations",
          source: previousSource,
          previousRows: previousQuotaRows,
          currentRows: database.prepare("SELECT * FROM rate_limit_observations WHERE source_path = ?").all(filePath),
          methodVersion: HISTORY_REPLACED_QUOTA_METHOD_VERSION,
        });
      }
      // M3.2：性能候选。位置在 events 之后、COMMIT 之前，与前三类共享**同一个** `BEGIN IMMEDIATE`
      // 事务 ⇒ 任一类失败都会一起回滚（gate A 逐类实测）。
      //
      // Codex 的整线程候选由 M7 sync 阶段发布，不能在单文件事务里拆轮；
      // project-log 结构上不支持性能候选。
      /** S1：本次事务写回的指纹映射（`null` = 本次没改指纹，例如 Codex 文件）。成功 `COMMIT` 后写回轮内视图。 */
      let committedFingerprintMap = null;
      if (isPerfSourceEnabled(source.kind) && canonicalizeKind(source.kind) !== "codex") {
        const insertPerfSample = database.prepare(PERF_SAMPLE_INSERT_SQL);
        // ⚠️ 归属必须是 `filePath`，**不能**用 `source.path`：`perf_samples.source_path` 有外键指向
        // `source_files(path)`，而 `source_files` 的主键是**物理文件路径**。对单文件来源（ZCode 的
        // `db.sqlite`）两者相同，但对**多文件**来源（DSH/Codex 用同一个 home 发现 N 个文件）`source.path`
        // 是**目录**，用它必触 `errcode 787`（本卡冒烟实测）。卡片 `M3-index.md:15` 写的
        // `sourcePath = source.path` 只在单文件来源下成立 —— 已在 M3.2 报告 §6 登记为需裁定项。
        // 覆盖 `sourcePath` **不影响身份**：`sampleKey` 在 reader 里已由原始身份元组算好（M1:340
        // 只用 sourceKind/homeId/identity），本层不重算、也不重建。
        //
        // ── M3.4 返工 BB-1：**读取期间来源变化**检测 ──────────────────────────────
        // 用户在"reader 读完、事务提交前追加一行"时复现了静默 `ready`（索引 3 行 / 上游 4 行）。
        // 根因：本段读完即写、`COMMIT` 之前**没有任何前后比较**。
        //
        // 判据：读取**前后**各取一次来源指纹（**主库 + WAL**，见 `perfSourceStat`），
        // 不等 ⇒ 写入 `degraded` + `LIVE_SOURCE_CHANGED`（冻结码），并**确保下次重新提取**
        // （把 `source_files.size/mtime_ms` 置 `-1` ⇒ 下一轮判据必然认为"已变"）。
        //
        // ⚠️ 比较必须在 **`COMMIT` 之前**进行（此刻本事务尚未提交，但文件指纹是**文件系统**事实，
        // 不受本事务影响）⇒ 一旦检出变化，就**不发布 `ready`**。
        //
        // ── M3.4 返工2 BC-1（用户第二轮复现）：**"指纹取不到"同样是候选不完整的证据** ──
        // 用户复现 `{"case":"source-deleted-after-read","state":"ready","sourceExists":false}`。
        // **根因**：原判据是 `statBefore !== null && statAfter !== null && statBefore !== statAfter`
        // —— **三重合取**把"读后取不到指纹"排除在"变化"之外 ⇒ 文件已消失却仍发布 `ready`。
        //
        // ⇒ **正确判据**：`statBefore` 必须可得（读之前文件必然存在，取不到说明它一开始就不可读，
        // 由 `onWarning`/catch 另路处理）；而 `statAfter` **取不到**（`null`）本身就是
        // "读完之后来源不再可读"的证据 —— 与"指纹变了"同属**候选不完整**，且更强。
        const statBefore = enabledPerfSourceStat(source.kind, filePath);
        // S4/C2：WorkBuddy 的时长来自按 home 归属的 observation 表。只有恰好一种时长时可用；
        // 多种时长必须返回 null，不能按先后、MIN/MAX 或时间相近猜一个。旧表无 home_id，
        // 仅在 observation 为空时兜底，避免升级立即丢掉已持久化的可用值。
        const observationStatement = database.prepare(
          `SELECT duration_ms, ended_at_ms
           FROM workbuddy_generation_duration_observations
           WHERE home_id = ? AND message_id = ?
           ORDER BY duration_ms
           LIMIT 2`,
        );
        const legacyDurationStatement = database.prepare(
          "SELECT duration_ms, ended_at_ms FROM workbuddy_generation_durations WHERE message_id = ?",
        );
        const durationCache = new Map();
        const lookupGenerationDuration = (messageId) => {
          const key = String(messageId ?? "");
          if (key === "") return null;
          if (durationCache.has(key)) return durationCache.get(key);
          const observations = observationStatement.all(String(source.id ?? ""), key);
          const row =
            observations.length <= 1
              ? (observations[0] ?? (legacyWorkbuddyFallbackAllowed ? legacyDurationStatement.get(key) : null))
              : null;
          const value =
            row && observations.length <= 1
              ? {
                  durationMs: Number(row.duration_ms),
                  endedAtMs: row.ended_at_ms === null ? null : Number(row.ended_at_ms),
                }
              : null;
          durationCache.set(key, value);
          return value;
        };
        const perfResult = await streamPerfSamplesForFile(
          filePath,
          { ...source, path: filePath },
          (sample) => {
            let row = encodePerfSample(sample);
            const previous = previousWorkbuddySamples.get(row.sample_key);
            // Log rotation does not erase a verified summary for unchanged response usage.
            if (
              previous &&
              row.duration_ms === null &&
              previous.duration_ms > 0 &&
              previous.sample_flags === 0 &&
              previous.timing_source === "explicit" &&
              previous.timing_kind === "generation" &&
              isGenerationPerfMethod(previous.method_version) &&
              previous.output_tokens + 1 === row.output_tokens &&
              !this.workbuddyTextMessageIds.get(String(source.id ?? ""))?.has(JSON.parse(String(row.sample_key))[2]) &&
              [
                "home_id",
                "source_kind",
                "channel",
                "session_id",
                "turn_key",
                "model",
                "model_provider",
                "reasoning_effort",
                "ts_ms",
                "input_tokens",
                "status",
                "window",
                "token_scope",
              ].every((field) => previous[field] === row[field])
            ) {
              row = previous;
            }
            insertPerfSample.run(...PERF_SAMPLE_FIELDS.map((entry) => row[entry.column]));
          },
          {
            onWarning: (warning) => {
              filePerfWarnings.push(warning);
              onPerfWarning?.(warning);
              onWarning?.(formatPerfWarning(warning));
            },
            lookupGenerationDuration,
            lookupTextTiming: this.workbuddyTextTimingLookups.get(String(source.id ?? "")),
          },
        );
        // S4：缺时长的计数不在码域里，交给调用点合并成"每 home 每轮一条"的普通 warning。
        // ⚠️ 两级 `stats`：reader 按契约返回 `{ state, stats }`，而调度器把**整个返回值**当作
        // 自己的 `stats` 透传（其它 reader 直接返回裸计数对象）⇒ 这里两种形状都要认。
        const readerStats = perfResult?.stats ?? null;
        const skippedNoDuration = Number(readerStats?.skippedNoDuration ?? readerStats?.stats?.skippedNoDuration ?? 0);
        if (skippedNoDuration > 0) onWorkbuddyDurationGap?.(source.label, skippedNoDuration);
        const statAfter = enabledPerfSourceStat(source.kind, filePath);
        // 变化 = ① 指纹不同（读期间被追加/改写），或 ② 读后**取不到**指纹（文件消失/不可读）。
        const fingerprintChanged = statBefore !== null && statAfter !== statBefore;
        if (fingerprintChanged) {
          // 本轮读到的候选**不完整**（上游在读期间又写入了，或读取后来源已被移除）。
          // 记编码告警 + 记受阻 home + 把文件置脏以强制下一轮重提取。
          //
          // **BC-1 裁决（见报告 §2）**：用 `LIVE_SOURCE_CHANGED`。
          // **依据**：该码定义为"live source changed"；文件在 `statBefore` 时**存在**、
          // 到 `statAfter` 时**取不到**，即"来源在**读取窗口内**发生了变化"—— 这是**字面为真**，
          // 不是类比。而 `READ_ONLY_OPEN_FAILED` 已被 reader 自身失败（文件坏/缺表）占用，
          // 复用它会把**两种不同成因**混成一个码，破坏归因（AN-6）。
          noteLiveChangeWarning(canonicalizeKind(source.kind), String(source.id ?? ""));
          // `blockedHomeIds` 由 `sync()` 拥有（本方法不能直接访问其作用域）⇒ 经 options 注入。
          blockedHomeIds?.add(String(source.id ?? ""));
          liveChangedPaths.add(filePath);
          // ── 返工3（第三轮外部复核 P2）：检出读取期间变化 ⇒ **本文件整笔替换回滚** ──────
          // 复核复现：本轮提交 3 行候选、却把**读后（已含新增记录）**的 `statAfter` 记成它们的
          // 已发布指纹 ⇒ 下一轮恢复为 4 行候选、状态回到 `ready`，而**版本完全不变**
          // （`{"degraded":{"rows":3},"recovered":{"rows":4},"versionChanged":false}`）。
          // 根因：把元数据与候选放进**同一个事务**，只保证两者**一起提交**，
          //       **不保证它们描述的是同一份数据** —— 读后的上游可以包含 reader 没读到的新记录。
          //
          // ⇒ 采信"**这份读取不可信**"：整笔回滚本次替换（保留**上一次成功**的候选与指纹），
          //    由上面的 `liveChangedPaths` 置脏保证**下一轮重试**；只有读取前后指纹一致时
          //    才把候选与指纹**一起**发布 ⇒ `perf_index_version` 永远描述已提交的候选。
          //
          // ⚠️ 不得改用 `statBefore` 充当"本次候选的指纹"：追加可能落在 `statBefore` 之后、
          //    reader 读取之前 ⇒ `statBefore` **同样**不保证对应实际解析结果（复核明文警告）。
          database.exec("ROLLBACK");
          // D1：**回滚不得伪造成功变更** —— 这里只复原事务深度并安全清理可能已在事务内被读到的
          // 派生缓存；修订**不**推进（本次替换整体没提交）。置脏由下面的 `liveChangedPaths` 负责。
          this.rollbackReplaceFileTransaction();
          return { committed: false, quotaWritten: false };
        }
        // ── BC-2：把**本次候选对应的**已发布指纹写进**同一个事务** ────────────────
        // 用户复现 `{"case":"failed-publication","state":"degraded","versionChanged":true}`：
        // 索引保留旧成功候选，版本却表征了**没有发布**的上游文件。
        //
        // **我实测的关键机制**（这是本修复的支点）：`store_meta` 的写在
        // `BEGIN IMMEDIATE … COMMIT` 内**随 `ROLLBACK` 一起回滚**（实测：初始 `old` →
        // 事务内读到 `new` → `ROLLBACK` 后回到 `old`）。
        // ⇒ 把**每个文件**的已发布指纹写在这里，就**结构性地**保证了
        // "版本只描述与候选**同一次 COMMIT** 成功发布的数据" —— 不依赖任何事后补算。
        //
        // `statAfter` 为 `null`（读后不可读）时**移除**该文件分量：它已无可用"已发布"状态，
        // 留着会让版本表征一个不再成立的事实。
        // S1：轮内复用已解码视图（整轮至多解码一次）；**成功 `COMMIT` 后**才写回视图。
        const nextFingerprints = this.publishedFileFingerprintsForRound();
        if (statAfter !== null) {
          nextFingerprints[filePath] = statAfter;
        } else {
          delete nextFingerprints[filePath];
        }
        this.writeMeta("perf_file_fingerprints", JSON.stringify(nextFingerprints));
        committedFingerprintMap = nextFingerprints;
        if (committedFingerprints) {
          // 供 `sync()` 在同一轮内聚合（避免再次 stat 上游）。
          for (const [p, fp] of Object.entries(nextFingerprints)) committedFingerprints.set(p, fp);
        }
      }
      if (!codexThreaded && previousSource && previousPerfSamples.length > 0) {
        saveMissingHistoryFacts(insertReplacedFact, {
          factTable: "perf_samples",
          source: previousSource,
          previousRows: previousPerfSamples,
          currentRows: database.prepare("SELECT * FROM perf_samples WHERE source_path = ?").all(filePath),
          methodVersion: PERF_METHOD_VERSION,
        });
      }
      if (!codexThreaded && previousSource && previousPerfSampleSources.length > 0) {
        saveMissingHistoryFacts(insertReplacedFact, {
          factTable: "perf_sample_sources",
          source: previousSource,
          previousRows: previousPerfSampleSources,
          currentRows: database
            .prepare(
              `SELECT dependencies.*
               FROM perf_sample_sources AS dependencies
               JOIN perf_samples AS samples ON samples.sample_key = dependencies.sample_key
               WHERE samples.source_path = ?`,
            )
            .all(filePath),
          methodVersion: PERF_METHOD_VERSION,
        });
      }
      const nextFileWarnings = this.publishedFileWarningsForRound();
      if (String(source.kind ?? "") === "project-log") {
        let projectLogFileWarnings = (nextFileWarnings[filePath] || []).filter(
          (warning) =>
            warning.code === PROJECT_LOG_TRUNCATION_WARNING_CODE ||
            warning.code === PROJECT_LOG_MALFORMED_LINE_WARNING_CODE,
        );
        if (truncationEventCount > 0) {
          projectLogFileWarnings = projectLogFileWarnings.filter(
            (warning) => warning.code !== PROJECT_LOG_TRUNCATION_WARNING_CODE,
          );
          projectLogFileWarnings.push({
            sourceKind: "project-log",
            homeId: String(source.id ?? ""),
            code: PROJECT_LOG_TRUNCATION_WARNING_CODE,
            count: truncationEventCount,
          });
        }
        const malformedLines = [...projectLogMalformedLines].sort((left, right) => left - right);
        projectLogFileWarnings = projectLogFileWarnings.filter(
          (warning) => warning.code !== PROJECT_LOG_MALFORMED_LINE_WARNING_CODE,
        );
        if (malformedLines.length > 0) {
          projectLogFileWarnings.push({
            sourceKind: "project-log",
            homeId: String(source.id ?? ""),
            code: PROJECT_LOG_MALFORMED_LINE_WARNING_CODE,
            count: malformedLines.length,
            lineNumbers: malformedLines,
          });
        }
        if (projectLogFileWarnings.length > 0) nextFileWarnings[filePath] = projectLogFileWarnings;
        else delete nextFileWarnings[filePath];
      } else if (isPerfSourceEnabled(source.kind) && canonicalizeKind(source.kind) !== "codex") {
        nextFileWarnings[filePath] = normalizeSourceWarnings(filePerfWarnings);
      } else if (canonicalizeKind(source.kind) !== "codex") {
        delete nextFileWarnings[filePath];
      }
      this.writeMeta("perf_file_warnings", JSON.stringify(nextFileWarnings));
      if (
        representationFingerprint !== undefined &&
        (representationFingerprint === null ||
          enabledPerfSourceStat(source.kind, filePath) !== representationFingerprint)
      ) {
        throw Object.assign(new Error("Codex rollout changed during representation indexing"), {
          code: "LIVE_SOURCE_CHANGED",
        });
      }
      database.exec("COMMIT");
      // D1：**提交成功** ⇒ 写事务结束（深度复原）。修订的推进放在调用点（`sync()`）：只有调用点
      // 才知道本次替换是"成功的用量提交"还是"回滚后由置脏强制重试"。
      if (this.writeTransactionDepth > 0) this.writeTransactionDepth -= 1;
      // S1：**只有成功提交**才写回轮内视图 —— 上面两个 `ROLLBACK` 分支（读取期间来源变化、
      // 事务内任何抛错）都保留旧值，失败轮次的新值不会泄漏进视图。
      this.publishedFileMapsView?.commit(committedFingerprintMap, nextFileWarnings);
      // D1：告诉调用点"这一次替换真的提交了"（+ 有没有 quota 观测行）⇒ 调用点据此推进修订。
      return { committed: true, quotaWritten, truncationWarning, projectLogWarnings };
    } catch (error) {
      database.exec("ROLLBACK");
      // D1：抛错 ⇒ 整个替换事务回滚 ⇒ **不推进修订**，只复原深度 + 安全清理事务内的派生缓存。
      this.rollbackReplaceFileTransaction();
      throw error;
    }
  }

  /**
   * 同步轮次入口。S1：本轮**私有**的 published 映射视图在这里建立，并在轮末（成功或抛错）
   * 一律丢弃 ⇒ 既保证"整轮至多解码一次"，又保证视图**不会**跨轮变成长期缓存。
   * @param {{ options?: any }} [args]
   */
  async sync(args = {}) {
    const view = createPublishedFileMapsView(this);
    this.publishedFileMapsView = view;
    try {
      return await this.syncRound(args);
    } catch (error) {
      this.codexPublishedPaths.clear();
      throw error;
    } finally {
      if (this.publishedFileMapsView === view) this.publishedFileMapsView = null;
    }
  }

  /**
   * 轮内实现（只由 {@link UsageStore#sync} 调用）：`sync()` 建立的 published 映射视图
   * 在本方法执行期间有效。
   * @param {{ options?: any }} [args]
   */
  async syncRound({ options } = {}) {
    await this.open();
    // D1：轮首先**检出外部提交**（同连接 `PRAGMA data_version`）⇒ 失效派生缓存 + 重载必要元数据，
    // 这样本轮的"要不要保留缓存"判定（轮末守卫）以及随后的读路径都建立在正确的修订上。
    this.syncDerivedRevision();
    // install invalidation triggers before this round writes event facts
    const externalCommitCount = this.externalCommitCount;
    createUsageRollups(this.database);
    const syncOptions = options || this.options;
    this.options = syncOptions;
    const homes = await discoverUsageSources(syncOptions);
    const quotaObservations = readCodexQuotaObservations({ ...syncOptions, homes });
    if (quotaObservations.length) {
      const saved = JSON.stringify(quotaObservations);
      if (this.readMetaRaw("official_quota_observations") !== saved) {
        this.writeMeta("official_quota_observations", saved);
        this.commitStoreRevision("quota");
      }
    }
    const { files, warnings, failedHomes = [] } = await this.usageFiles(homes);
    const status = await buildUsageFingerprint({ ...syncOptions, homes, scannedFiles: files, failedHomes });
    const knownFiles = new Set(files.map((file) => file.filePath));
    const failedHomeIds = new Set(failedHomes.map((home) => home.id));
    const failedHomePaths = new Set(failedHomes.map((home) => home.path));
    let updatedFileCount = 0;
    const sourceRowsBefore = this.database
      .prepare("SELECT path, kind, home_id, home_label, home_path, size, mtime_ms FROM source_files")
      .all();
    const sourceRowsBeforeByPath = new Map(sourceRowsBefore.map((row) => [String(row.path), row]));
    const publishedFingerprintsBefore = this.publishedFileFingerprintsForRound();
    const committedUsagePaths = new Set();
    /** Current paths that were discovered but failed replacement this round. */
    const failedUsagePaths = new Set();

    /**
     * A rename is not a missing source: when one old path disappears and one
     * new path with the same native kind/home/content appears, the old row may
     * be removed only after the new row is successfully published.
     */
    const replacementKey = (kind, homeId, signature) =>
      `${canonicalizeKind(kind)}\u0000${String(homeId ?? "")}\u0000${signature}`;
    const oldByReplacementKey = new Map();
    const newByReplacementKey = new Map();
    const oldCodexRepresentations = new Map();
    const newCodexRepresentations = new Map();
    for (const row of sourceRowsBefore) {
      const filePath = String(row.path);
      if (knownFiles.has(filePath)) continue;
      if (failedHomeIds.has(row.home_id) || failedHomePaths.has(row.home_path)) continue;
      if (canonicalizeKind(String(row.kind ?? "")) === "codex") {
        const logicalPath = canonicalPerfProbePath(plainRolloutPath(filePath));
        const paths = oldCodexRepresentations.get(logicalPath) || [];
        paths.push(filePath);
        oldCodexRepresentations.set(logicalPath, paths);
      }
      const fingerprint = publishedFingerprintsBefore[filePath];
      if (typeof fingerprint !== "string" || fingerprint === "") continue;
      const key = replacementKey(row.kind, row.home_id, `fingerprint:${fingerprint}`);
      const entries = oldByReplacementKey.get(key) || [];
      entries.push(filePath);
      oldByReplacementKey.set(key, entries);
    }
    for (const file of files) {
      if (canonicalizeKind(file.source.kind) === "codex") {
        const logicalPath = canonicalPerfProbePath(plainRolloutPath(file.filePath));
        const paths = newCodexRepresentations.get(logicalPath) || [];
        paths.push(file.filePath);
        newCodexRepresentations.set(logicalPath, paths);
      }
      const fingerprint = enabledPerfSourceStat(file.source.kind, file.filePath);
      if (typeof fingerprint !== "string" || fingerprint === "") continue;
      const key = replacementKey(file.source.kind, file.source.id, `fingerprint:${fingerprint}`);
      const entries = newByReplacementKey.get(key) || [];
      entries.push(file.filePath);
      newByReplacementKey.set(key, entries);
    }
    const replacementTargetByOldPath = new Map();
    for (const [logicalPath, oldPaths] of oldCodexRepresentations) {
      const newPaths = newCodexRepresentations.get(logicalPath);
      if (oldPaths.length !== 1 || newPaths?.length !== 1) continue;
      replacementTargetByOldPath.set(oldPaths[0], newPaths[0]);
    }
    for (const [key, oldPaths] of oldByReplacementKey) {
      const newPaths = newByReplacementKey.get(key);
      if (oldPaths.length !== 1 || newPaths?.length !== 1) continue;
      if (replacementTargetByOldPath.has(oldPaths[0])) continue;
      replacementTargetByOldPath.set(oldPaths[0], newPaths[0]);
    }
    /**
     * C5 卡：**本轮是否真的写了用量数据**（= 派生缓存的输入是否变了）。
     *
     * `this.metadataCache` 与 `this.periodComparisonCache` 的数据输入只有用量侧：
     * `metadata()` 读 `events` + 本轮 home 集合（`metadata()` 里的 `events` 聚合与 `this.homes`），
     * `periodComparison()` 走 `periodAggregate()` —— 原始行仍只读 `events`，但模型行名还会
     * 经过当前价目目录的规范化；缓存键包含目录键集，纯费率变化无需重建事实。
     * 这里不读费率、不用 `source_files`、不用任何 perf 表。
     *
     * 因此"要不要清空派生缓存"必须由**真正的数据变更点**决定，而不是由"源指纹变了""本轮开过
     * 什么事务"决定（卡面："主审检查真正的数据变更点，不只凭源 fingerprint 判断"）。下面每个
     * 真的写了 `events` / `source_files` 的地方都**显式**记一笔 —— 这份清单就是报告里"提交路径
     * 清单"的可执行版本。**perf 侧**（`perf_samples` / `perf_sample_sources` /
     * `perf_rollout_threads` / `perf_file_fingerprints` / `perf_file_warnings` / 策略）与**例行
     * 时刻元数据**（`generated_at` / `perf_indexed_at`）**不在**这两个缓存的输入里 ⇒ 不得让它们
     * 触发失效。
     *
     * ⚠️ 反向红线：**每一次**对 `events` / `source_files` 的写都必须在这里记一笔，漏记会让派生
     * 缓存保留过期结果。写点共 4 处（见 `C5/out/measure-c5.json` 的 `submitPaths` 与报告 §提交路径清单）：
     *   ① `replaceFile` 成功（写 `source_files` + `events`）；
     *   ② codex 发布事务**真实删除**路径（`DELETE FROM source_files`，`events` 经
     *      `ON DELETE CASCADE` 一并消失）；
     *   ③ 非 codex 来源的真实删除（同上）；
     *   ④ `liveChangedPaths` 的置脏 `UPDATE source_files`（强制下一轮重提取）。
     */
    let usageDerivedChanged = false;
    const changedSessions = new Set();
    const workbuddyHomes = homes.filter(
      (home) =>
        canonicalizeKind(String(home?.kind ?? home?.sourceKind ?? "")) === "workbuddy" &&
        isPerfSourceEnabled("workbuddy"),
    );
    /** @type {Map<string, { fingerprint: string | null, complete: boolean }>} */
    const workbuddyTraceDependencies = new Map();
    /** @type {Map<string, Set<string>>} */
    const workbuddyTraceTargets = new Map();
    /**
     * S4：本轮每个 WorkBuddy home 的"缺时长"计数（`homeId → { label, count }`）。
     * 轮末合并成**每 home 一条**普通 warning（走既有字符串通道，不新增告警码域）。
     * @type {Map<string, { label: string, count: number }>}
     */
    const workbuddyDurationGaps = new Map();
    /** M3.4：本轮**受阻**的 home（文件不可读或替换失败）⇒ 计入 `perf_degraded_home_ids`。 */
    const blockedHomeIds = new Set();
    /** M3.4：**逐文件**的失败归因（只记真正抛错的文件，避免误归因到成功的 home）。 */
    const fileFailures = [];
    /** M3.4 返工 **BB-1**：读取期间来源变化的告警（冻结码 `LIVE_SOURCE_CHANGED`）。 */
    const liveChangeWarnings = [];
    const liveChangeWarningKeys = new Set();
    const noteLiveChangeWarning = (sourceKind, homeId) => {
      const key = `${sourceKind}\u0000${homeId}\u0000LIVE_SOURCE_CHANGED`;
      if (liveChangeWarningKeys.has(key)) return;
      liveChangeWarningKeys.add(key);
      liveChangeWarnings.push({ sourceKind, homeId, code: "LIVE_SOURCE_CHANGED", count: 1 });
    };
    /** M3.4 返工 **BB-1**：读取期间变过的文件 ⇒ 必须置脏以强制下一轮重提取。 */
    const liveChangedPaths = new Set();
    /** M3.4 返工2 **BC-2**：因**真实删除**而移除的指纹分量（需写回映射）。 */
    const removedFingerprintPaths = new Set();
    /** Successful physical-file deletion also clears its committed reader diagnostics. */
    const removedSourcePaths = new Set();
    const legacyWorkbuddyFallbackAllowed = workbuddyHomes.length === 1;
    const samplePathForWorkbuddyMessage = this.database.prepare(
      "SELECT source_path FROM perf_samples WHERE sample_key = ?",
    );
    for (const home of workbuddyHomes) {
      const homeId = String(home.id ?? "");
      const outcome = await this.refreshWorkbuddyDurations(home.path, {
        homeId,
        onWarning: (warning) => warnings.push(warning),
      });
      workbuddyTraceDependencies.set(homeId, {
        fingerprint: outcome.traceDependency,
        complete: outcome.traceComplete,
      });
      if (!outcome.traceComplete) {
        blockedHomeIds.add(homeId);
        fileFailures.push({
          sourceKind: "workbuddy",
          homeId,
          code: "READ_ONLY_OPEN_FAILED",
        });
      }
      if (outcome.insertedMessageIds.length === 0) continue;

      const targets = workbuddyTraceTargets.get(homeId) || new Set();
      const unresolved = [];
      for (const messageId of outcome.insertedMessageIds) {
        const sampleKey = JSON.stringify(["workbuddy", homeId, messageId]);
        const sourcePath = samplePathForWorkbuddyMessage.get(sampleKey)?.source_path;
        if (sourcePath) targets.add(String(sourcePath));
        else unresolved.push(messageId);
      }
      if (unresolved.length > 0) {
        try {
          const sessionFilesByMessage = await workbuddySessionMessageFiles(home.path);
          for (const messageId of unresolved) {
            for (const filePath of sessionFilesByMessage.get(messageId) || []) targets.add(filePath);
          }
        } catch (error) {
          blockedHomeIds.add(homeId);
          fileFailures.push({
            sourceKind: "workbuddy",
            homeId,
            code: "READ_ONLY_OPEN_FAILED",
          });
          // The trace rows are already committed. Force every known session file
          // in this home through replaceFile so the next readable pass can recover
          // even when the trace file itself is unchanged.
          const dirty = this.database
            .prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE home_id = ? AND kind = 'workbuddy'")
            .run(homeId);
          if (Number(dirty.changes) > 0) {
            usageDerivedChanged = true;
            this.commitStoreRevision("workbuddy-trace-resolution");
          }
          warnings.push(`无法定位 WorkBuddy 响应所属会话 ${home.path}: ${error.message}`);
        }
      }
      if (targets.size > 0) workbuddyTraceTargets.set(homeId, targets);
    }

    const legacyFallbackModeRaw = this.readMetaRaw("perf_workbuddy_legacy_fallback_allowed");
    const legacyFallbackModeChanged =
      (legacyFallbackModeRaw !== "0" && legacyFallbackModeRaw !== "1") ||
      legacyFallbackModeRaw !== (legacyWorkbuddyFallbackAllowed ? "1" : "0");
    if (legacyFallbackModeChanged) {
      if (!legacyWorkbuddyFallbackAllowed) {
        // A sample without a home-owned observation could only have come from
        // the legacy table. Multi-home mode withdraws that proof.
        const observations = new Set(
          this.database
            .prepare("SELECT home_id, message_id FROM workbuddy_generation_duration_observations")
            .all()
            .map((row) => `${String(row.home_id)}\u0000${String(row.message_id)}`),
        );
        for (const row of this.database
          .prepare("SELECT sample_key, source_path FROM perf_samples WHERE source_kind = 'workbuddy'")
          .all()) {
          /** @type {unknown} */
          let sampleKey;
          try {
            sampleKey = JSON.parse(String(row.sample_key));
          } catch {
            continue;
          }
          if (!Array.isArray(sampleKey) || sampleKey.length < 3) continue;
          const homeId = String(sampleKey[1] ?? "");
          const messageId = String(sampleKey[2] ?? "");
          const sourcePath = String(row.source_path ?? "");
          if (
            homeId === "" ||
            messageId === "" ||
            sourcePath === "" ||
            observations.has(`${homeId}\u0000${messageId}`)
          ) {
            continue;
          }
          const targets = workbuddyTraceTargets.get(homeId) || new Set();
          targets.add(sourcePath);
          workbuddyTraceTargets.set(homeId, targets);
        }
      } else {
        const home = workbuddyHomes[0];
        const homeId = String(home.id ?? "");
        const observations = new Set(
          this.database
            .prepare("SELECT message_id FROM workbuddy_generation_duration_observations WHERE home_id = ?")
            .all(homeId)
            .map((row) => String(row.message_id)),
        );
        const legacyMessageIds = [
          ...new Set(
            this.database
              .prepare("SELECT message_id FROM workbuddy_generation_durations")
              .all()
              .map((row) => String(row.message_id))
              .filter((messageId) => messageId !== "" && !observations.has(messageId)),
          ),
        ];
        if (legacyMessageIds.length > 0) {
          try {
            const sessionFilesByMessage = await workbuddySessionMessageFiles(home.path);
            const targets = workbuddyTraceTargets.get(homeId) || new Set();
            for (const messageId of legacyMessageIds) {
              for (const filePath of sessionFilesByMessage.get(messageId) || []) targets.add(filePath);
            }
            if (targets.size > 0) workbuddyTraceTargets.set(homeId, targets);
          } catch (error) {
            blockedHomeIds.add(homeId);
            fileFailures.push({
              sourceKind: "workbuddy",
              homeId,
              code: "READ_ONLY_OPEN_FAILED",
            });
            const dirty = this.database
              .prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE home_id = ? AND kind = 'workbuddy'")
              .run(homeId);
            if (Number(dirty.changes) > 0) {
              usageDerivedChanged = true;
              this.commitStoreRevision("workbuddy-legacy-scope");
            }
            warnings.push(`无法恢复 WorkBuddy legacy 时长会话 ${home.path}: ${error.message}`);
          }
        }
      }
    }

    const previousCodexThreadsByPath = new Map();
    const addPreviousCodexThread = (sourcePath, homeId, threadId) => {
      const associations = previousCodexThreadsByPath.get(sourcePath) || [];
      if (!associations.some((entry) => entry.homeId === homeId && entry.threadId === threadId)) {
        associations.push({ homeId, threadId });
        previousCodexThreadsByPath.set(sourcePath, associations);
      }
    };
    for (const row of this.database.prepare("SELECT source_path, home_id, thread_id FROM perf_rollout_threads").all()) {
      addPreviousCodexThread(String(row.source_path), String(row.home_id), String(row.thread_id));
    }
    for (const row of this.database
      .prepare(`
      SELECT DISTINCT dependencies.source_path, rollouts.home_id, rollouts.thread_id
      FROM perf_sample_sources AS dependencies
      JOIN perf_rollout_threads AS rollouts ON rollouts.source_path = dependencies.source_path
    `)
      .all()) {
      addPreviousCodexThread(String(row.source_path), String(row.home_id), String(row.thread_id));
    }
    let codexPendingChange = false;
    /**
     * C1 卡：本轮**候选**的稳定失败尝试记录（`homeId → candidate`）。
     *
     * 只在"规划确实完成了一次**稳定验证**、且失败码全属确定性内容码"时写入；是否**提交**到
     * `this.codexStableAttempts` 由轮末的 {@link codexBlockEvents} 快照比对决定 —— 任何**后续**
     * 受阻（读取失败 / 发布前复核 `LIVE_SOURCE_CHANGED` / 发布事务 `ROLLBACK` / 跨 home 冲突 /
     * 用量侧失败 / 策略编码失败）都会让记录作废。
     */
    const codexStableAttemptCandidates = new Map();
    /**
     * C2 卡：**复用轮**里从命中记录取回的逐文件内容签名（`homeId → {paths, fileFingerprints}`）。
     *
     * 只在"该 home 本轮命中稳定失败记录、因此**跳过**整 home 规划"时写入。它是 C1 与 S2 的
     * **收益叠加补丁**：同一批文件在同一轮里只做一次内容摘要（C1 交付态实测复用轮
     * `store.decision.loop` 从 88 回到 449 ⇒ 其中 361 次是对签名里已有文件的重复探针 ⇒ 归零）。
     *
     * 生命周期严格限定在**本轮**：轮内局部 `Map`，**不挂 `this`、不落盘**，`syncRound` 返回即回收
     * （与 S2 的 `plan.probePathIndex` 同一纪律：缓存身份 = 本轮对象本身，不绑时间、不跨轮）。
     * @type {Map<string, {paths: string[], fileFingerprints: Record<string, string>}>}
     */
    const codexReusedSignatures = new Map();
    /**
     * C1 卡：本轮每个 home 被**判为受阻**的次数（**所有**受阻路径统一计数）。
     *
     * 为什么需要它：一条记录只有在"规划那一刻之后**没有**任何新的受阻事件"时才可信。用计数快照
     * 比对（而不是只看 `blockedHomeIds.has`）才能区分两种情况 ——
     *   * 规划本身就**确定性受阻**（`blockCodexHome` 在记录之前调用，计数已含在内）；
     *   * 规划之后**又**受阻（计数变大 ⇒ 记录作废）。
     * @type {Map<string, number>}
     */
    const codexBlockEvents = new Map();
    const bumpCodexBlockEvent = (homeId) => {
      if (!homeId) return;
      codexBlockEvents.set(homeId, (codexBlockEvents.get(homeId) || 0) + 1);
    };
    const addCodexAffectedThread = (homeId, threadId) => {
      if (!homeId || !threadId) return;
      if (!codexOldThreadIdsByHome.has(homeId)) codexOldThreadIdsByHome.set(homeId, new Set());
      codexOldThreadIdsByHome.get(homeId).add(threadId);
    };
    const blockCodexHome = (homeId, error, sourcePath = "") => {
      if (!homeId) return;
      bumpCodexBlockEvent(homeId);
      blockedHomeIds.add(homeId);
      const code = perfWarningCodeForError(error);
      if (code === "LIVE_SOURCE_CHANGED") {
        noteLiveChangeWarning("codex", homeId);
        return;
      }
      fileFailures.push({ sourceKind: "codex", homeId, code, sourcePath });
    };
    const codexFiles = files.filter((file) => canonicalizeKind(file.source?.kind) === "codex");
    const currentCodexPaths = new Set(codexFiles.map((file) => file.filePath));
    const publishedCodexFingerprints = this.publishedFileFingerprintsForRead();
    const publishedCodexWarnings = this.publishedFileWarningsForRead();
    // Missing dependencies already acknowledged by a successful publication stay in history.
    const acknowledgedMissingSources =
      this.readMetaRaw("perf_state") === PERF_STATE_READY &&
      this.readMetaRaw("perf_method_version") === PERF_METHOD_VERSION
        ? decodeMissingSources(this.readMetaRaw(MISSING_SOURCES_META))
        : [];
    const oldCodexRows = this.database
      .prepare("SELECT path, kind, home_id, home_label, home_path, size, mtime_ms FROM source_files")
      .all()
      .filter((row) => canonicalizeKind(String(row.kind ?? "")) === "codex");
    const oldCodexRowsByHome = new Map();
    const oldCodexRowsByPath = new Map();
    for (const row of oldCodexRows) {
      const homeId = String(row.home_id ?? "");
      const rows = oldCodexRowsByHome.get(homeId) || [];
      rows.push(row);
      oldCodexRowsByHome.set(homeId, rows);
      oldCodexRowsByPath.set(String(row.path), row);
    }
    const codexFilesByHome = new Map();
    for (const file of codexFiles) {
      const homeId = String(file.source?.id ?? "");
      const homeFiles = codexFilesByHome.get(homeId) || [];
      homeFiles.push(file);
      codexFilesByHome.set(homeId, homeFiles);
    }

    const codexOldThreadIdsByHome = new Map();
    const codexOldThreadPathsByHome = new Map();
    for (const [sourcePath, associations] of previousCodexThreadsByPath) {
      for (const previous of associations) {
        addCodexAffectedThread(previous.homeId, previous.threadId);
        const byThread = codexOldThreadPathsByHome.get(previous.homeId) || new Map();
        const paths = byThread.get(previous.threadId) || new Set();
        paths.add(sourcePath);
        byThread.set(previous.threadId, paths);
        codexOldThreadPathsByHome.set(previous.homeId, byThread);
      }
    }
    const codexOldSampleKeysByHome = new Map();
    const codexHomesWithUnkeyableOldSamples = new Set();
    for (const row of this.database
      .prepare("SELECT sample_key, home_id FROM perf_samples WHERE source_kind = 'codex'")
      .iterate()) {
      const homeId = String(row.home_id ?? "");
      const sampleKey = String(row.sample_key ?? "");
      const threadId = codexSampleThreadId({ sourceKind: "codex", homeId, sampleKey });
      if (!threadId) {
        codexHomesWithUnkeyableOldSamples.add(homeId);
        continue;
      }
      addCodexAffectedThread(homeId, threadId);
      const byThread = codexOldSampleKeysByHome.get(homeId) || new Map();
      const keys = byThread.get(threadId) || new Set();
      keys.add(sampleKey);
      byThread.set(threadId, keys);
      codexOldSampleKeysByHome.set(homeId, byThread);
    }

    /** @type {Map<string, Set<string>>} */
    const codexDirtyTimingThreadsByHome = new Map();
    for (const row of this.database.prepare("SELECT home_id, thread_id FROM perf_request_timing_dirty_threads").all()) {
      const homeId = String(row.home_id);
      const threadIds = codexDirtyTimingThreadsByHome.get(homeId) || new Set();
      threadIds.add(String(row.thread_id));
      codexDirtyTimingThreadsByHome.set(homeId, threadIds);
    }

    const codexHomeById = new Map(
      homes
        .filter((home) => canonicalizeKind(String(home?.kind ?? home?.sourceKind ?? "")) === "codex")
        .map((home) => [String(home.id ?? ""), home]),
    );
    const priorPolicy = decodeCodexPublicationPolicy(this.readMetaRaw("perf_codex_publication_policy"));
    const policyNeedsUpgrade =
      !priorPolicy.usable ||
      priorPolicy.revision !== CODEX_PUBLICATION_POLICY_REVISION ||
      this.readMeta("perf_method_version") !== PERF_METHOD_VERSION;
    const priorPartialHomeIds = new Set(
      (priorPolicy.usable ? priorPolicy.partialHomes : []).map((entry) => entry.homeId),
    );
    const priorDegradedHomeIds = new Set(decodeJsonStringArray(this.readMetaRaw("perf_degraded_home_ids")));
    const partialHomesById = new Map(
      (priorPolicy.usable ? priorPolicy.partialHomes : []).map((entry) => [
        entry.homeId,
        new Set(entry.blockedThreadIds),
      ]),
    );
    let policyUpgradeComplete = true;
    if (policyNeedsUpgrade) {
      partialHomesById.clear();
      codexPendingChange = true;
    }

    const allCodexHomeIds = new Set([
      ...codexHomeById.keys(),
      ...oldCodexRowsByHome.keys(),
      ...codexOldThreadIdsByHome.keys(),
      ...codexDirtyTimingThreadsByHome.keys(),
      ...priorPartialHomeIds,
    ]);
    // C1 卡：本轮**不再存在**的 home ⇒ 清掉它的稳定失败尝试记录（真实删除 / 归档迁移 / 来源移除）。
    for (const staleHomeId of [...this.codexStableAttempts.keys()]) {
      if (!allCodexHomeIds.has(staleHomeId)) this.codexStableAttempts.delete(staleHomeId);
    }
    // C3 卡：**home 整体消失**（来源移除 / 归档迁移 / 别名变化）⇒ 连带淘汰它的投影条目。
    this.codexProjections.retainHomes(allCodexHomeIds);
    const crossHomeBlockedIds = new Set();
    for (const file of codexFiles) {
      const currentHomeId = String(file.source?.id ?? "");
      const oldRow = oldCodexRowsByPath.get(file.filePath);
      const oldHomeIds = new Set((previousCodexThreadsByPath.get(file.filePath) || []).map((entry) => entry.homeId));
      if (oldRow) oldHomeIds.add(String(oldRow.home_id ?? ""));
      for (const oldHomeId of oldHomeIds) {
        if (oldHomeId === "" || oldHomeId === currentHomeId) continue;
        crossHomeBlockedIds.add(oldHomeId);
        crossHomeBlockedIds.add(currentHomeId);
        blockCodexHome(
          oldHomeId,
          Object.assign(new Error("Codex rollout moved across homes"), { code: "UNKEYABLE_RECORD" }),
          file.filePath,
        );
        blockCodexHome(
          currentHomeId,
          Object.assign(new Error("Codex rollout moved across homes"), { code: "UNKEYABLE_RECORD" }),
          file.filePath,
        );
      }
    }

    const codexPlans = new Map();
    // C4：每轮重建"受影响 / 保留"视图（`syncRound` 每轮进入一次 ⇒ 不跨轮累积）。
    this.codexThreadBuildPlan = new Map();
    for (const homeId of [...allCodexHomeIds].sort()) {
      const currentHome = codexHomeById.get(homeId);
      const oldRows = oldCodexRowsByHome.get(homeId) || [];
      const home =
        currentHome ||
        (oldRows[0]
          ? {
              id: homeId,
              label: String(oldRows[0].home_label ?? "Codex"),
              path: String(oldRows[0].home_path ?? ""),
              kind: "codex",
            }
          : null);
      if (!home) continue;
      if (!currentHome) {
        this.codexPublishedPaths.delete(homeId);
        // A whole Codex home disappearing is retention, not a parse failure.
        // Failed discovery for a home still known this round must stay degraded.
        if (crossHomeBlockedIds.has(homeId)) {
          // The paths are still present under another home. The old failure
          // signature therefore describes an attribution this round disproved.
          this.codexStableAttempts.delete(homeId);
          if (policyNeedsUpgrade) policyUpgradeComplete = false;
        }
        if (failedHomeIds.has(homeId) || failedHomePaths.has(String(home.path ?? ""))) {
          blockCodexHome(
            homeId,
            Object.assign(new Error("Codex home discovery failed"), { code: "READ_ONLY_OPEN_FAILED" }),
          );
        }
        continue;
      }
      const homeFiles = codexFilesByHome.get(homeId) || [];
      const expectedPaths = homeFiles.map((file) => file.filePath).sort();
      const oldPaths = oldRows.map((row) => String(row.path));
      const dirtyTimingThreadIds = codexDirtyTimingThreadsByHome.get(homeId) || new Set();
      const previousPaths = this.codexPublishedPaths.get(homeId);
      const retainedUnchanged =
        previousPaths &&
        oldPaths.length === previousPaths.retained.size &&
        oldPaths.every((filePath) => previousPaths.retained.has(filePath));
      const comparisonPaths = retainedUnchanged ? previousPaths.live : new Set(oldPaths);
      const pathSetChanged =
        comparisonPaths.size !== expectedPaths.length ||
        expectedPaths.some((filePath) => !comparisonPaths.has(filePath));
      const metadataChanged = homeFiles.some((file) => {
        const existing = oldCodexRowsByPath.get(file.filePath);
        const sameMetadata = Boolean(
          existing &&
            Number(existing.size) === file.info.size &&
            Number(existing.mtime_ms) === file.info.mtimeMs &&
            existing.kind === (file.source.kind || "codex") &&
            existing.home_id === file.source.id &&
            existing.home_label === file.source.label &&
            existing.home_path === file.source.path,
        );
        const hasCurrentOwnership = (previousCodexThreadsByPath.get(file.filePath) || []).some(
          (entry) => entry.homeId === homeId,
        );
        return (
          !sameMetadata ||
          perfFileNeedsRefresh(file.source.kind, file.filePath, publishedCodexFingerprints, publishedCodexWarnings) ||
          !hasCurrentOwnership
        );
      });
      const shouldPlan =
        policyNeedsUpgrade ||
        priorDegradedHomeIds.has(homeId) ||
        priorPartialHomeIds.has(homeId) ||
        dirtyTimingThreadIds.size > 0 ||
        pathSetChanged ||
        metadataChanged ||
        codexHomesWithUnkeyableOldSamples.has(homeId);
      if (!shouldPlan) {
        // C1 卡：本轮**无需**规划 ⇒ 旧记录不再适用（该 home 已不处于"稳定失败"状态）。
        // 保留它只会在未来签名恰好重现时误用一条**来自另一个 DB 状态**的受阻投影。
        this.codexStableAttempts.delete(homeId);
        continue;
      }
      codexPendingChange = true;
      partialHomesById.delete(homeId);
      if (crossHomeBlockedIds.has(homeId)) {
        // C1：本轮**新**出现的跨 home 冲突 ⇒ 旧记录（来自另一个归属状态）立即作废。
        this.codexStableAttempts.delete(homeId);
        if (policyNeedsUpgrade) policyUpgradeComplete = false;
        continue;
      }
      if (codexHomesWithUnkeyableOldSamples.has(homeId)) {
        // C1：旧候选身份不可判定 ⇒ 必须重新规划；旧记录作废。
        this.codexStableAttempts.delete(homeId);
        blockCodexHome(
          homeId,
          Object.assign(new Error("Old Codex candidate identity is invalid"), { code: "UNKEYABLE_RECORD" }),
        );
        if (policyNeedsUpgrade) policyUpgradeComplete = false;
        continue;
      }
      if (failedHomeIds.has(homeId) || failedHomePaths.has(String(home.path ?? ""))) {
        // The failedHomes pass below records this once. Adding it here too would
        // inflate the warning count for the same failed discovery.
        // C1：发现阶段失败 ⇒ 旧记录作废（下一轮发现恢复后会重新规划一次）。
        this.codexStableAttempts.delete(homeId);
        if (policyNeedsUpgrade) policyUpgradeComplete = false;
        continue;
      }
      try {
        // ── C1 卡：稳定失败尝试记录命中 ⇒ **跳过整 home 全文规划** ────────────────────────────
        // 位置是刻意的：必须排在 `crossHomeBlockedIds` / `codexHomesWithUnkeyableOldSamples` /
        // `failedHomeIds` 三个守卫**之后** —— 那三条是**本轮**新出现的受阻原因，任何一条成立都
        // 必须重新判断，绝不能被一条旧记录盖住。
        //
        // 命中后的效果（逐条与原路径等价，见报告"实现行为"）：
        //   * **不**调用 `planStableCodexHome` ⇒ 零全文解析、零 `buildCodexThreadPerfSamples`；
        //   * 本 home **不进入** `codexPlans` ⇒ 发布循环不触碰它 ⇒ 已发布候选（健康兄弟线程）
        //     原样保留，不做 delete/insert、不空发布；
        //   * 记录里的 `partialHomes`（被隔离线程）与逐文件告警**原样重新投影** ⇒ 告警既不丢失
        //     也不累加，`perf_degraded_home_ids` / `perf_codex_publication_policy` 与原路径一致。
        const reusedAttempt = this.codexStableAttemptMatch(homeId, home, expectedPaths);
        if (reusedAttempt !== null) {
          // C2 卡：把命中判定**刚刚取到**的逐文件签名留给本轮逐文件判据。
          // 位置就在命中判定内部 —— 签名与消费点之间**没有**对该文件的任何读取（红线 ①，见
          // `codexReusedProbeValue` 的注释与报告「实现行为」的逐条论证）。
          // `paths` 取**副本**、`fileFingerprints` 只读共享：路径索引会挂到这里的包装对象上，
          // 绝不写进 `this.codexStableAttempts` 里的那条记录。
          codexReusedSignatures.set(homeId, {
            paths: [...reusedAttempt.paths],
            fileFingerprints: reusedAttempt.fileFingerprints,
          });
          if (reusedAttempt.blockedHomeWarnings.length > 0) {
            for (const warning of reusedAttempt.blockedHomeWarnings) {
              blockCodexHome(
                homeId,
                Object.assign(new Error("Codex home planning was incomplete"), { code: warning.code }),
                warning.sourcePath,
              );
            }
          } else {
            partialHomesById.set(homeId, new Set(reusedAttempt.blockedThreadIds));
            for (const failure of reusedAttempt.failedThreads) {
              const failedPaths = failure.failedFilePaths || [];
              if (failure.reason === "LIVE_SOURCE_CHANGED") {
                noteLiveChangeWarning("codex", homeId);
              } else if (failedPaths.length === 0) {
                fileFailures.push({ sourceKind: "codex", homeId, code: failure.reason });
              } else {
                fileFailures.push(
                  ...failedPaths.map((sourcePath) => ({
                    sourceKind: "codex",
                    homeId,
                    code: failure.reason,
                    sourcePath,
                  })),
                );
              }
            }
          }
          // C2 卡：**不得**因为"本轮走的是复用"就放弃重建发布策略。
          //
          // C1 在这里写的是 `if (policyNeedsUpgrade) policyUpgradeComplete = false;`。后果：策略键
          // 缺失/损坏/版本不符时，只要记录一直命中，`perf_codex_publication_policy` 就**永远写不
          // 回去**（每轮都判 `needsUpgrade`、每轮都放弃写）。而消费者是按**库里的策略 + 库里的
          // `perf_degraded_home_ids`** 建发布过滤器的（`createCodexPublishFilter`）⇒ 一个"部分受限"
          // 的 home 会被当成**整 home 排除**，它的健康兄弟线程静默掉出排名 —— 与"复用轮告警/排名
          // 与未复用臂逐项相同"的验收直接冲突。
          //
          // 复用重放出的 partial 集合**就是**上一轮写进策略的那份投影，本轮具备把策略重建出来的
          // 全部信息 ⇒ 这里不再放弃重建。写出来只会比"键一直缺失"更保守（缺项 home 仍按整 home
          // 排除），不会放松任何排除。home 级受阻（`blockedHomeWarnings` 非空）本来就**不进入**
          // 策略，它的语义就是整 home 排除。
          continue;
        }
        // ── C3 卡：整 home 规划（含**未变文件标准化投影复用**）────────────────────────────
        // 浅拷贝只为把实例私有投影缓存交给 planner（`planStableCodexHome` 的签名行是 B2 的锚点，
        // 逐字节不可改 ⇒ 缓存挂属性而不是新增形参；`home` 本身不被改写）。
        // `finally` 保证**无论规划是否抛错**都做一次收尾：
        //   * 稳定窗口（`window.stable === true`，即读取前/后内容指纹与路径集逐字一致）⇒ `commit`
        //     （只有这一刻的投影才算"可复用"）；
        //   * 其余（不可证/不稳定/抛错）⇒ `rollback` **丢弃**本轮暂存（失效即重算，绝不粘到下一轮）；
        //   * `prune`：只保留本轮发现到的当前路径（替换/删除/重命名淘汰）。
        let window = null;
        try {
          // A3：planner 仍逐文件完成 ownership proof，但只把轻量
          // `{filePath, threadId}` 索引交给本轮的 affected-thread 判据。需要构建的
          // thread 才经 `loadRollouts()` 逐文件水合；transient 模式避免持久 cache
          // 同时持有整个 home 的 parsed projection。
          const lazyProjectionCache = {
            lazyRollouts: true,
            lookup: (/** @type {any} */ args = {}) => this.codexProjections.lookup({ ...args, transient: true }),
            stage: (/** @type {any} */ args = {}) => this.codexProjections.stage({ ...args, transient: true }),
            invalidate: (args = {}) => this.codexProjections.invalidate(args),
          };
          window = await planStableCodexHome(
            { ...home, projectionCache: lazyProjectionCache, parallelPrefix: true },
            expectedPaths,
          );
        } finally {
          if (window !== null && window.stable === true) this.codexProjections.commit(homeId);
          else if (window !== null && window.partial === true) {
            this.codexProjections.commit(homeId, window.liveChangedPaths);
          } else this.codexProjections.rollback(homeId);
          this.codexProjections.prune(homeId, expectedPaths);
        }
        if (!window.ok || (!window.stable && window.partial !== true) || !window.plan?.ok) {
          const code =
            window.code ??
            window.plan?.homeBlocking?.[0]?.code ??
            window.plan?.unownedFiles?.[0]?.code ??
            "UNKEYABLE_RECORD";
          const failures = [...(window.plan?.homeBlocking ?? []), ...(window.plan?.unownedFiles ?? [])];
          /** C1：本轮**实际写出**的 home 级受阻告警（供稳定失败记录原样重放）。 */
          const blockedHomeWarnings = [];
          if (code === "LIVE_SOURCE_CHANGED" || failures.length === 0) {
            blockedHomeWarnings.push({ code, sourcePath: "" });
            blockCodexHome(homeId, Object.assign(new Error("Codex home planning was incomplete"), { code }));
          } else {
            for (const failure of failures) {
              const failureCode = PERF_SOURCE_WARNING_CODES.has(failure.code) ? failure.code : "READ_ONLY_OPEN_FAILED";
              blockedHomeWarnings.push({ code: failureCode, sourcePath: String(failure.filePath ?? "") });
              blockCodexHome(
                homeId,
                Object.assign(new Error("Codex home planning was incomplete"), { code: failureCode }),
                String(failure.filePath ?? ""),
              );
            }
          }
          // C1：只有"稳定验证已完成（`stable` + 前后快照可证）**且**全部失败码都是确定性内容码"
          // 才允许记录 —— 卡面"仅稳定验证完成的确定性失败可复用"。`LIVE_SOURCE_CHANGED`、
          // `READ_ONLY_OPEN_FAILED` 与任何未冻结码都落在允许清单之外，因此永不进入记录。
          if (
            window.stable === true &&
            window.after?.complete === true &&
            blockedHomeWarnings.length > 0 &&
            blockedHomeWarnings.every((warning) => CODEX_DETERMINISTIC_FAILURE_CODES.has(warning.code))
          ) {
            codexStableAttemptCandidates.set(homeId, {
              home,
              expectedPaths,
              window,
              failedThreads: null,
              blockedHomeWarnings,
              blockEvents: codexBlockEvents.get(homeId) || 0,
            });
          }
          if (policyNeedsUpgrade) policyUpgradeComplete = false;
          continue;
        }
        // ── C4 卡：**只构建受影响线程**（判据见 `codexThreadNeedsBuild` 的注释）────────────
        // 未受影响的线程**根本不调用** `buildCodexThreadPerfSamples()` ⇒ 它们的已发布候选
        // （`perf_samples` / `perf_sample_sources` / `perf_rollout_threads` 行）原样保留，
        // 发布循环既不会 delete 也不会 insert（见「Publish only ...」段的 C4 注释）。
        // ⚠️ 归属证明（`window.plan.threads`）**完全不变**：受影响集合只决定"要不要重跑 builder"，
        // **不**决定"这个文件属于哪个线程"—— 后者仍由 planner 的完整文件集证明。
        const stageOldThreadIds = codexOldThreadIdsByHome.get(homeId) || new Set();
        const stageOldPathsByThread = codexOldThreadPathsByHome.get(homeId) || new Map();
        const stagedThreads = [];
        const retainedThreadIds = [];
        const acknowledgedMissingPaths = new Set(
          (policyNeedsUpgrade ? [] : acknowledgedMissingSources)
            .filter(
              (source) =>
                source.homeId === homeId &&
                canonicalizeKind(source.kind) === "codex" &&
                !currentCodexPaths.has(source.path) &&
                !replacementTargetByOldPath.has(source.path),
            )
            .map((source) => source.path),
        );
        const liveThreadIds = new Set(window.liveChangedThreadIds ?? []);
        for (const thread of window.plan.threads) {
          const rolloutFiles = thread.rollouts.map((rollout) => rollout.filePath).sort();
          if (liveThreadIds.has(thread.threadId)) continue;
          if (
            !codexThreadNeedsBuild(
              { threadId: thread.threadId, rolloutFiles },
              stageOldThreadIds,
              stageOldPathsByThread,
              window.after.fileFingerprints,
              publishedCodexFingerprints,
              dirtyTimingThreadIds,
              acknowledgedMissingPaths,
            )
          ) {
            retainedThreadIds.push(thread.threadId);
            continue;
          }
          let rollouts = thread.rollouts;
          if (typeof thread.loadRollouts === "function") {
            try {
              rollouts = await thread.loadRollouts();
              // Persist only this thread's lazy reads before the next thread
              // replaces its parsed projections. Stable-window guards have
              // already run; the cache write is independent of publication.
              this.codexProjections.commit(homeId);
            } catch (error) {
              this.codexProjections.rollback(homeId);
              if (error?.code === "LIVE_SOURCE_CHANGED") {
                // The stable-window projection identity no longer matches the
                // lazy read. Keep the old publication for this thread and let
                // healthy sibling threads continue through the normal guards.
                liveThreadIds.add(thread.threadId);
                window.liveChangedThreadIds = [...liveThreadIds];
                const changedPath = String(error.filePath ?? "");
                if (changedPath !== "") {
                  window.liveChangedPaths = [...new Set([...(window.liveChangedPaths ?? []), changedPath])];
                  liveChangedPaths.add(changedPath);
                }
                const blockedThreads = partialHomesById.get(homeId) ?? new Set();
                blockedThreads.add(thread.threadId);
                partialHomesById.set(homeId, blockedThreads);
                bumpCodexBlockEvent(homeId);
                noteLiveChangeWarning("codex", homeId);
                continue;
              }
              throw error;
            }
          }
          const built = buildCodexThreadPerfSamples(homeId, thread.threadId, rollouts, {
            lookupRequestTiming: (query) => this.lookupRequestTiming(query),
          });
          stagedThreads.push({
            homeId,
            threadId: thread.threadId,
            rolloutFiles,
            samples: built.samples,
            nativeMeasurements: built.nativeMeasurements,
            warnings: built.warnings,
            fingerprints: Object.fromEntries(
              rollouts.map((rollout) => [rollout.filePath, window.after.fileFingerprints[rollout.filePath]]),
            ),
          });
        }
        codexPlans.set(homeId, {
          home,
          expectedPaths,
          window,
          stagedThreads,
          // C4：全部**当前存在**的线程及其完整路径集 —— 发布阶段判定"旧线程是否已消失"
          // 与"路径转移冲突"都必须看**全部**当前线程，而不是只看本轮重建的那一批。
          threadPaths: window.plan.threads.map((thread) => ({
            threadId: thread.threadId,
            filePaths: thread.rollouts.map((rollout) => rollout.filePath).sort(),
          })),
          retainedThreadIds,
          failedThreads: window.plan.failedThreads,
        });
        // C4：证据/测试用只读视图（覆盖式写入，无跨轮累积）。
        this.codexThreadBuildPlan.set(homeId, {
          staged: stagedThreads.map((staged) => staged.threadId),
          retained: [...retainedThreadIds],
        });
        if (window.plan.failedThreads.length > 0) {
          const blockedThreadIds = new Set(window.plan.failedThreads.map((entry) => entry.threadId));
          partialHomesById.set(homeId, blockedThreadIds);
          for (const failure of window.plan.failedThreads) {
            const failedPaths = failure.failedFilePaths || [];
            if (failure.reason === "LIVE_SOURCE_CHANGED") {
              noteLiveChangeWarning("codex", homeId);
            } else if (failedPaths.length === 0) {
              fileFailures.push({ sourceKind: "codex", homeId, code: failure.reason });
            } else {
              fileFailures.push(
                ...failedPaths.map((sourcePath) => ({ sourceKind: "codex", homeId, code: failure.reason, sourcePath })),
              );
            }
          }
          // C1 卡：一次**稳定验证完成**的"部分失败"（可隔离的确定性坏内容）⇒ 记录候选。
          // 提交与否在轮末按 `codexBlockEvents` 快照比对决定（发布前复核/发布事务/跨 home 冲突
          // 任一后续受阻都会作废它）。`blockedThreadIds` 用轮末的**最终**集合（还会并入
          // `blockedOldThreadIds`），见轮末提交段。
          if (
            window.stable === true &&
            window.after?.complete === true &&
            window.plan.failedThreads.every((entry) => CODEX_DETERMINISTIC_FAILURE_CODES.has(entry.reason))
          ) {
            codexStableAttemptCandidates.set(homeId, {
              home,
              expectedPaths,
              window,
              failedThreads: window.plan.failedThreads,
              blockedHomeWarnings: null,
              blockEvents: codexBlockEvents.get(homeId) || 0,
            });
          }
        }
      } catch (error) {
        blockCodexHome(homeId, error);
        if (policyNeedsUpgrade) policyUpgradeComplete = false;
      }
    }
    for (const homeId of crossHomeBlockedIds) {
      partialHomesById.delete(homeId);
      if (policyNeedsUpgrade) policyUpgradeComplete = false;
    }

    // Structural changes can require publication without replacing a usage file.
    let rebuildingMarked =
      codexPendingChange || [...workbuddyTraceTargets.values()].some((targets) => targets.size > 0);
    if (rebuildingMarked) {
      this.writePerfState(PERF_STATE_REBUILDING, { degradedHomeIds: [], sourceWarnings: [] });
    }
    for (const file of files) {
      const existing = this.database
        .prepare("SELECT size, mtime_ms, kind, home_id, home_label, home_path FROM source_files WHERE path = ?")
        .get(file.filePath);
      const previousSessions =
        existing && changedSessions.size > 0
          ? this.database
              .prepare("SELECT DISTINCT session_id FROM events WHERE source_path = ?")
              .all(file.filePath)
              .map((row) => row.session_id)
          : [];
      const earlierFileChanged = previousSessions.some((sessionId) => changedSessions.has(sessionId));
      let needsRefresh = true;
      if (
        !earlierFileChanged &&
        existing &&
        Number(existing.size) === file.info.size &&
        Number(existing.mtime_ms) === file.info.mtimeMs &&
        existing.kind === (file.source.kind || "codex") &&
        existing.home_id === file.source.id &&
        existing.home_label === file.source.label &&
        existing.home_path === file.source.path
      ) {
        // ── B7（返工2 新发现，逐文件实时内容判据）──
        // `size + mtimeMs` 全同**不蕴含**内容未变（实测：同尺寸 + 同整毫秒 mtime 的原地改写）。
        // M4.5: also extract an enabled source with no published fingerprint
        // or no committed per-file warning entry. Disabled sources still have
        // currentStat=null and are skipped; successful n=0 extraction writes []
        // so it is not repeated.
        const changedKind = String(file.source?.kind ?? "");
        // S2：**读取后稳定窗口**内的等价摘要复用 —— 该 rollout 本轮已在 codex 规划里被整文件解析过，
        // 且此后没有再次读取它；窗口不可用/失效时返回 `undefined` ⇒ 走下面的真实探针。
        const windowedCurrent = this.codexWindowedProbeValue(
          codexPlans.get(String(file.source?.id ?? "")),
          changedKind,
          file.filePath,
        );
        // C2：**复用轮**（C1 稳定失败记录命中 ⇒ 该 home 本轮不在 `codexPlans` 里）改用 C1 的稳定签名。
        // 两者**互斥**且各自有守卫："窗口"只在"本 home 本轮做过规划"时非 `undefined`，"签名"只在
        // "本 home 本轮命中记录"时存在 —— 二者不可能同时成立，故这个优先级顺序不承载语义，
        // 只是把"同一物理文件同一轮只取一次真实摘要"这条纪律落到两个来源上。
        const reusedCurrent =
          windowedCurrent === undefined
            ? this.codexReusedProbeValue(
                codexReusedSignatures.get(String(file.source?.id ?? "")),
                changedKind,
                file.filePath,
              )
            : windowedCurrent;
        needsRefresh = perfFileNeedsRefresh(
          changedKind,
          file.filePath,
          this.publishedFileFingerprintsForRead(),
          this.publishedFileWarningsForRead(),
          reusedCurrent,
        );
      }
      if (
        canonicalizeKind(file.source.kind) === "workbuddy" &&
        workbuddyTraceTargets.get(String(file.source.id))?.has(file.filePath)
      ) {
        needsRefresh = true;
      }
      if (!needsRefresh) continue;
      if (!rebuildingMarked) {
        // Keep the last complete ranking until replacement; marker failures abort the sync.
        this.writePerfState(PERF_STATE_REBUILDING, { degradedHomeIds: [], sourceWarnings: [] });
        rebuildingMarked = true;
      }
      try {
        const replaceOutcome = await this.replaceFile(file, {
          onWarning: (warning) => warnings.push(warning),
          noteLiveChangeWarning,
          liveChangedPaths,
          blockedHomeIds,
          legacyWorkbuddyFallbackAllowed,
          onWorkbuddyDurationGap: (homeLabel, count) => {
            const key = String(file.source.id);
            const entry = workbuddyDurationGaps.get(key) || { label: homeLabel, count: 0 };
            entry.count += count;
            entry.label = homeLabel || entry.label;
            workbuddyDurationGaps.set(key, entry);
          },
        });
        for (const row of this.database
          .prepare("SELECT DISTINCT session_id FROM events WHERE source_path = ?")
          .all(file.filePath)) {
          changedSessions.add(row.session_id);
        }
        updatedFileCount += 1;
        if (replaceOutcome?.committed) committedUsagePaths.add(file.filePath);
        else failedUsagePaths.add(file.filePath);
        // C5 提交点 ①：`replaceFile` 成功 ⇒ `source_files` 与 `events` 都被写过。
        usageDerivedChanged = true;
        // D1：**只有真的 `COMMIT` 了**才推进实例修订 —— 读取窗口内变化那条路径会整笔 `ROLLBACK`
        // 并返回 `committed: false`（那种情况由下面的 `liveChangedPaths` 置脏点推进修订）。
        if (replaceOutcome?.committed) {
          // Malformed-line diagnostics belong only to the committed replacement that parsed them.
          if (replaceOutcome.truncationWarning) warnings.push(replaceOutcome.truncationWarning);
          for (const warning of replaceOutcome.projectLogWarnings || []) warnings.push(warning);
          this.commitStoreRevision(replaceOutcome.quotaWritten ? "usage+quota" : "usage");
        }
      } catch (error) {
        failedUsagePaths.add(file.filePath);
        if (
          canonicalizeKind(file.source.kind) === "workbuddy" &&
          workbuddyTraceTargets.get(String(file.source.id))?.has(file.filePath)
        ) {
          liveChangedPaths.add(file.filePath);
        }
        // ⚠️ **保留原用量告警**（用户明示）：这条字符串带着路径与原因，是**用量侧**的告警，
        // 不因我们另外做 perf 归因而被吞掉。
        warnings.push(`无法索引 ${file.filePath}: ${error.message}`);
        // M3.4: performance failure attribution only applies to enabled sources;
        // usage-side failures from unsupported/unregistered sources stay usage warnings.
        const kindRaw = String(file.source?.kind ?? file.source?.sourceKind ?? "");
        if (file.source?.id && isPerfSourceEnabled(kindRaw)) {
          // C1：用量侧受阻同样算一次"受阻事件" ⇒ 该 home 的稳定失败记录候选作废。
          bumpCodexBlockEvent(String(file.source.id));
          blockedHomeIds.add(String(file.source.id));
          // BB-4：归因码**取 reader 自己带的冻结码**（见 `perfWarningCodeForError`）。
          fileFailures.push({
            sourceKind: canonicalizeKind(kindRaw),
            homeId: String(file.source.id),
            code: perfWarningCodeForError(error),
            sourcePath: file.filePath,
          });
        }
      }
    }

    for (const [homeId, plan] of codexPlans) {
      if (blockedHomeIds.has(homeId)) {
        partialHomesById.delete(homeId);
        if (policyNeedsUpgrade) policyUpgradeComplete = false;
        continue;
      }
      try {
        const discovered = (await discoverSessionFiles(plan.home.path)).sort();
        const pathsStable =
          discovered.length === plan.expectedPaths.length &&
          discovered.every((filePath, index) => filePath === plan.expectedPaths[index]);
        const currentFingerprints = pathsStable
          ? discovered.map((filePath) => enabledPerfSourceStat("codex", filePath))
          : [];
        const unreadable = currentFingerprints.some((fingerprint) => fingerprint === null);
        const liveThreadIds = new Set(plan.window.liveChangedThreadIds ?? []);
        const ownersByPath = new Map();
        for (const thread of plan.threadPaths) {
          for (const filePath of thread.filePaths) {
            const owners = ownersByPath.get(filePath) ?? new Set();
            owners.add(thread.threadId);
            ownersByPath.set(filePath, owners);
          }
        }
        const provenPaths = new Set(plan.window.liveChangedPaths ?? []);
        let contentsStable = pathsStable && !unreadable;
        if (contentsStable) {
          for (const [index, filePath] of discovered.entries()) {
            const current = currentFingerprints[index];
            const expected = plan.window.after.fileFingerprints[filePath];
            if (current !== expected) {
              const owners = ownersByPath.get(filePath);
              const threadId = owners?.size === 1 ? [...owners][0] : "";
              if (
                !threadId ||
                !(await proveCodexLiveAppend(
                  filePath,
                  expected,
                  current,
                  threadId,
                  plan.window.before.filePrefixEvidence?.[filePath],
                ))
              ) {
                contentsStable = false;
                break;
              }
              provenPaths.add(filePath);
              liveThreadIds.add(threadId);
            }
          }
        }
        if (!contentsStable) {
          blockCodexHome(
            homeId,
            Object.assign(new Error("Codex source changed or became unreadable before publication"), {
              code: unreadable ? "READ_ONLY_OPEN_FAILED" : "LIVE_SOURCE_CHANGED",
            }),
          );
          partialHomesById.delete(homeId);
          if (policyNeedsUpgrade) policyUpgradeComplete = false;
        } else if (liveThreadIds.size > 0) {
          // A first append after planning has the same thread boundary as an append during planning.
          plan.window.liveChangedThreadIds = [...liveThreadIds];
          plan.window.liveChangedPaths = [...provenPaths];
          plan.stagedThreads = plan.stagedThreads.filter((thread) => !liveThreadIds.has(thread.threadId));
          plan.retainedThreadIds = plan.retainedThreadIds.filter((threadId) => !liveThreadIds.has(threadId));
          const blockedThreads = partialHomesById.get(homeId) ?? new Set();
          for (const threadId of liveThreadIds) blockedThreads.add(threadId);
          partialHomesById.set(homeId, blockedThreads);
          for (const filePath of provenPaths) liveChangedPaths.add(filePath);
          this.codexProjections.prune(
            homeId,
            plan.expectedPaths.filter((filePath) => !provenPaths.has(filePath)),
          );
          this.codexThreadBuildPlan.set(homeId, {
            staged: plan.stagedThreads.map((thread) => thread.threadId),
            retained: [...plan.retainedThreadIds],
          });
          bumpCodexBlockEvent(homeId);
          noteLiveChangeWarning("codex", homeId);
        }
      } catch (error) {
        blockCodexHome(homeId, error);
        partialHomesById.delete(homeId);
        if (policyNeedsUpgrade) policyUpgradeComplete = false;
      }
    }

    // Publish only fully staged threads. A failed current thread keeps its old
    // publication; a path owned by that retained graph can never be rebound.
    //
    // C4 卡：本段只对**受影响线程**做替换事务 ——
    //   * `stagedThreads` = 本轮**受影响**的当前线程（planner 证明过的新归属 / 路径集变化 / 内容变化）；
    //   * `retainedThreadIds` = 本轮**未受影响**的当前线程 ⇒ 已发布候选**原样保留**：既不
    //     `DELETE FROM perf_samples` / `perf_rollout_threads`，也不重新 `INSERT`，更不空发布；
    //   * 旧线程若**已不存在**（删除 / 归档迁走 / 重归属到别的 threadId）仍必须清掉它的行 ⇒
    //     见下面 `replaceOldThreadIds` 的第二个析取项。
    for (const [homeId, plan] of codexPlans) {
      if (blockedHomeIds.has(homeId)) {
        partialHomesById.delete(homeId);
        if (policyNeedsUpgrade) policyUpgradeComplete = false;
        continue;
      }
      const failedThreadIds = new Set(plan.failedThreads.map((entry) => entry.threadId));
      const failedPaths = new Set(plan.failedThreads.flatMap((entry) => entry.filePaths));
      const oldThreadIds = codexOldThreadIdsByHome.get(homeId) || new Set();
      const oldPathsByThread = codexOldThreadPathsByHome.get(homeId) || new Map();
      const blockedOldThreadIds = new Set();
      const liveThreadIds = new Set(plan.window.liveChangedThreadIds ?? []);
      for (const threadId of oldThreadIds) {
        const oldPaths = oldPathsByThread.get(threadId) || new Set();
        if (
          !liveThreadIds.has(threadId) &&
          (failedThreadIds.has(threadId) || [...oldPaths].some((sourcePath) => failedPaths.has(sourcePath)))
        ) {
          blockedOldThreadIds.add(threadId);
        }
      }
      // C4：冲突检测必须覆盖**全部当前线程**（不只是本轮重建的那一批）—— 一个未受影响、
      // 因此不重建的线程，只要它的某个 rollout 仍被**受阻的旧线程**持有，同样是"路径转移冲突"，
      // 必须整 home 受阻（否则会在保留旧图的同时把同一路径重新绑定给新线程）。
      const pathTransferConflict = plan.threadPaths.some((thread) =>
        thread.filePaths.some((sourcePath) =>
          (previousCodexThreadsByPath.get(sourcePath) || []).some(
            (entry) => entry.homeId === homeId && blockedOldThreadIds.has(entry.threadId),
          ),
        ),
      );
      if (pathTransferConflict) {
        blockCodexHome(
          homeId,
          Object.assign(new Error("A failed old Codex thread still owns a planned rollout"), {
            code: "UNKEYABLE_RECORD",
          }),
        );
        partialHomesById.delete(homeId);
        if (policyNeedsUpgrade) policyUpgradeComplete = false;
        continue;
      }

      // Retained old graphs remain recoverable in storage, but neither identity
      // may contribute to the partial publication while the replacement fails.
      const blockedThreadIds = partialHomesById.get(homeId) || new Set();
      for (const threadId of failedThreadIds) blockedThreadIds.add(threadId);
      for (const threadId of liveThreadIds) blockedThreadIds.add(threadId);
      for (const threadId of blockedOldThreadIds) blockedThreadIds.add(threadId);
      if (blockedThreadIds.size > 0) partialHomesById.set(homeId, blockedThreadIds);

      const stagedThreads = plan.stagedThreads;
      const stagedThreadIds = new Set(stagedThreads.map((staged) => staged.threadId));
      const currentThreadIds = new Set(plan.threadPaths.map((thread) => thread.threadId));
      const currentPathSet = new Set(plan.expectedPaths);
      const replacementCommitted = (sourcePath) => {
        const replacement = replacementTargetByOldPath.get(sourcePath);
        return (
          replacement !== undefined &&
          (committedUsagePaths.has(replacement) ||
            (sourceRowsBeforeByPath.has(replacement) && !failedUsagePaths.has(replacement)))
        );
      };
      const retainedMissingOldPaths = new Set();
      for (const threadId of oldThreadIds) {
        for (const sourcePath of oldPathsByThread.get(threadId) || []) {
          if (!currentPathSet.has(sourcePath) && !replacementCommitted(sourcePath)) {
            retainedMissingOldPaths.add(sourcePath);
          }
        }
      }
      const retainedMissingThreadIds = new Set();
      for (const threadId of oldThreadIds) {
        if ([...(oldPathsByThread.get(threadId) || [])].some((sourcePath) => retainedMissingOldPaths.has(sourcePath))) {
          retainedMissingThreadIds.add(threadId);
        }
      }
      // C4：旧线程要删除+重插 ⟺ （本轮受影响）或（本轮已不存在）。**当前存在且未受影响**的
      // 旧线程不在其中 ⇒ 它的候选与指纹/告警分量原样留在库里。
      const replaceOldThreadIds = [...oldThreadIds].filter(
        (threadId) =>
          !liveThreadIds.has(threadId) &&
          !blockedOldThreadIds.has(threadId) &&
          !retainedMissingThreadIds.has(threadId) &&
          (stagedThreadIds.has(threadId) || !currentThreadIds.has(threadId)),
      );
      const stagedThreadsToReplace = stagedThreads.filter((staged) => !retainedMissingThreadIds.has(staged.threadId));
      const stagedThreadsToMerge = stagedThreads.filter((staged) => retainedMissingThreadIds.has(staged.threadId));
      const nextFingerprints = this.publishedFileFingerprintsForRound();
      const nextWarnings = this.publishedFileWarningsForRound();
      const oldPathsToClear = new Set();
      for (const threadId of replaceOldThreadIds) {
        for (const sourcePath of oldPathsByThread.get(threadId) || []) oldPathsToClear.add(sourcePath);
      }
      for (const row of oldCodexRowsByHome.get(homeId) || []) {
        const sourcePath = String(row.path);
        if (currentPathSet.has(sourcePath)) continue;
        if (retainedMissingOldPaths.has(sourcePath)) continue;
        const retainedOwner = (previousCodexThreadsByPath.get(sourcePath) || []).some(
          (entry) => entry.homeId !== homeId || blockedOldThreadIds.has(entry.threadId),
        );
        if (!retainedOwner && replacementCommitted(sourcePath)) oldPathsToClear.add(sourcePath);
      }
      const deletedCodexPaths = [...oldPathsToClear].filter(
        (sourcePath) => !currentCodexPaths.has(sourcePath) && replacementCommitted(sourcePath),
      );
      // C4 卡：本 home **没有**受影响线程、没有要清掉的旧线程、也没有真实删除 ⇒ **整个替换事务都不开**。
      // 这就是"无关线程复用已发布候选（不 delete/insert、不空发布）"的可执行判据：一个只被
      // 未受影响线程占据的 home，本轮的 `perf_samples` / `perf_sample_sources` /
      // `perf_rollout_threads` 行**一个字节都不动**，也不会留下空发布。
      if (replaceOldThreadIds.length === 0 && stagedThreads.length === 0 && deletedCodexPaths.length === 0) continue;

      const replacedSampleKeys = new Set();
      for (const threadId of replaceOldThreadIds) {
        for (const sampleKey of codexOldSampleKeysByHome.get(homeId)?.get(threadId) || []) {
          replacedSampleKeys.add(sampleKey);
        }
      }
      // An evicted cold sample has no hot row to discover through old keys.
      for (const staged of stagedThreads) {
        for (const sample of staged.samples) replacedSampleKeys.add(String(sample.sampleKey));
      }
      const perfRevisionInputVersion = historyArchivePerfRevisionInputVersion(this.database);
      const perfRevisionCandidates = await this.#captureHistoryArchivePerfRevisionCandidates(replacedSampleKeys);

      // D1：本事务**全同步**（没有 `await`）⇒ 读路径不可能插进来读到未提交状态，因此**不需要**
      // `writeTransactionDepth` 记账（深度只服务 `replaceFile` 那个跨 `await` 的事务）。
      this.database.exec("BEGIN IMMEDIATE");
      try {
        if (
          !sameHistoryArchivePerfRevisionInputVersion(
            perfRevisionInputVersion,
            historyArchivePerfRevisionInputVersion(this.database),
          )
        ) {
          throw historyArchiveError(
            "HISTORY_ARCHIVE_PERF_REVISION_INPUT_CHANGED",
            "archive perf revision inputs changed while candidate facts were read; retry the sync",
          );
        }
        const previousPerfSamplesByPath = new Map();
        const previousPerfSampleSourcesByPath = new Map();
        const selectPerfSample = this.database.prepare("SELECT * FROM perf_samples WHERE sample_key = ?");
        const selectPerfSampleSources = this.database.prepare("SELECT * FROM perf_sample_sources WHERE sample_key = ?");
        // Reuse native statements throughout a bulk publication, rather than waiting for GC per row.
        const insertPerfSample = this.database.prepare(PERF_SAMPLE_INSERT_SQL);
        const insertPerfSource = this.database.prepare(
          "INSERT INTO perf_sample_sources (sample_key, source_path, role) VALUES (?, ?, ?)",
        );
        const deletePerfSample = this.database.prepare("DELETE FROM perf_samples WHERE sample_key = ?");
        const pushByPath = (groups, row) => {
          const sourcePath = String(row.source_path);
          const rows = groups.get(sourcePath) || [];
          rows.push(row);
          groups.set(sourcePath, rows);
        };
        for (const sampleKey of replacedSampleKeys) {
          const sample = selectPerfSample.get(sampleKey);
          if (sample) pushByPath(previousPerfSamplesByPath, sample);
          for (const dependency of selectPerfSampleSources.all(sampleKey)) {
            pushByPath(previousPerfSampleSourcesByPath, dependency);
          }
        }
        const committedDeletedPaths = [];
        for (const threadId of replaceOldThreadIds) {
          for (const sampleKey of codexOldSampleKeysByHome.get(homeId)?.get(threadId) || []) {
            deletePerfSample.run(sampleKey);
          }
        }
        for (const threadId of replaceOldThreadIds) {
          this.database
            .prepare("DELETE FROM perf_rollout_threads WHERE home_id = ? AND thread_id = ?")
            .run(homeId, threadId);
        }
        for (const sourcePath of oldPathsToClear) delete nextWarnings[sourcePath];

        for (const staged of stagedThreadsToReplace) {
          for (const sourcePath of staged.rolloutFiles) {
            this.database
              .prepare("INSERT INTO perf_rollout_threads (source_path, home_id, thread_id) VALUES (?, ?, ?)")
              .run(sourcePath, homeId, staged.threadId);
          }
          for (const sample of staged.samples) {
            this.insertPerfSample(sample, insertPerfSample);
            for (const sourcePath of staged.rolloutFiles) {
              insertPerfSource.run(
                sample.sampleKey,
                sourcePath,
                sourcePath === sample.sourcePath ? "primary" : "dependency",
              );
            }
          }
          if (staged.rolloutFiles.length > 0)
            nextWarnings[staged.rolloutFiles[0]] = normalizeSourceWarnings(staged.warnings);
          Object.assign(nextFingerprints, staged.fingerprints);
        }

        for (const staged of stagedThreadsToMerge) {
          for (const sourcePath of staged.rolloutFiles) {
            this.database
              .prepare("INSERT OR IGNORE INTO perf_rollout_threads (source_path, home_id, thread_id) VALUES (?, ?, ?)")
              .run(sourcePath, homeId, staged.threadId);
          }
          const oldKeys = codexOldSampleKeysByHome.get(homeId)?.get(staged.threadId) || new Set();
          for (const sample of staged.samples) {
            // Keep the last complete publication for an incomplete dependency set;
            // only genuinely new turn identities are added.
            if (oldKeys.has(sample.sampleKey)) continue;
            this.insertPerfSample(sample, insertPerfSample);
            for (const sourcePath of staged.rolloutFiles) {
              insertPerfSource.run(
                sample.sampleKey,
                sourcePath,
                sourcePath === sample.sourcePath ? "primary" : "dependency",
              );
            }
          }
          if (staged.rolloutFiles.length > 0)
            nextWarnings[staged.rolloutFiles[0]] = normalizeSourceWarnings(staged.warnings);
          Object.assign(nextFingerprints, staged.fingerprints);
        }

        const insertReplacedFact = this.database.prepare(HISTORY_REPLACED_FACT_INSERT_SQL);
        const currentPerfSamplesForPath = this.database.prepare("SELECT * FROM perf_samples WHERE source_path = ?");
        const currentPerfSampleSourcesForPath = this.database.prepare(
          "SELECT * FROM perf_sample_sources WHERE source_path = ?",
        );
        const selectHistorySource = this.database.prepare(
          "SELECT path, kind, home_id, home_label, home_path FROM source_files WHERE path = ?",
        );
        const saveReplacedPerfFacts = (factTable, previousByPath, selectCurrent) => {
          for (const [sourcePath, previousRows] of previousByPath) {
            const source = oldCodexRowsByPath.get(sourcePath) ?? selectHistorySource.get(sourcePath);
            if (!source) continue;
            saveMissingHistoryFacts(insertReplacedFact, {
              factTable,
              source,
              previousRows,
              currentRows: selectCurrent.iterate(sourcePath),
              methodVersion: PERF_METHOD_VERSION,
            });
          }
        };
        saveReplacedPerfFacts("perf_samples", previousPerfSamplesByPath, currentPerfSamplesForPath);
        previousPerfSamplesByPath.clear();
        saveReplacedPerfFacts("perf_sample_sources", previousPerfSampleSourcesByPath, currentPerfSampleSourcesForPath);
        previousPerfSampleSourcesByPath.clear();
        writeHistoryArchivePerfRevisionChanges(
          this.database,
          historyArchivePerfRevisionChangesForSamples(
            this.database,
            perfRevisionCandidates,
            replacedSampleKeys,
            new Map(stagedThreadsToReplace.flatMap((staged) => [...staged.nativeMeasurements])),
          ),
        );

        for (const sourcePath of deletedCodexPaths) {
          const retainedOwner = (previousCodexThreadsByPath.get(sourcePath) || []).some(
            (entry) => entry.homeId !== homeId || blockedOldThreadIds.has(entry.threadId),
          );
          if (retainedOwner) continue;
          this.database.prepare("DELETE FROM quota_usage_sources WHERE source_path = ?").run(sourcePath);
          this.database.prepare("DELETE FROM source_files WHERE path = ?").run(sourcePath);
          delete nextFingerprints[sourcePath];
          delete nextWarnings[sourcePath];
          committedDeletedPaths.push(sourcePath);
        }
        this.writeMeta("perf_file_fingerprints", JSON.stringify(nextFingerprints));
        this.writeMeta("perf_file_warnings", JSON.stringify(nextWarnings));
        const clearTimingDirty = this.database.prepare(
          "DELETE FROM perf_request_timing_dirty_threads WHERE home_id = ? AND thread_id = ?",
        );
        const replacedStagedThreadIds = new Set(stagedThreadsToReplace.map((staged) => staged.threadId));
        let clearedTimingDirty = 0;
        for (const threadId of replacedStagedThreadIds) {
          clearedTimingDirty += Number(clearTimingDirty.run(homeId, threadId).changes);
        }
        for (const threadId of replaceOldThreadIds) {
          clearedTimingDirty += Number(clearTimingDirty.run(homeId, threadId).changes);
        }
        if (clearedTimingDirty > 0) {
          const rawPublicationSeq = Number(this.readMetaRaw(REQUEST_TIMING_PUBLICATION_SEQ_META));
          const publicationSeq =
            Number.isSafeInteger(rawPublicationSeq) && rawPublicationSeq >= 0 ? rawPublicationSeq : 0;
          this.writeMeta(REQUEST_TIMING_PUBLICATION_SEQ_META, String(publicationSeq + 1));
        }
        if (this.database.prepare("PRAGMA foreign_key_check").all().length > 0) {
          throw Object.assign(new Error("Codex publication violated a foreign key"), { code: "READ_ONLY_OPEN_FAILED" });
        }
        this.database.exec("COMMIT");
        // S1：成功提交后写回轮内视图；失败（下面的 catch 回滚）时视图保持旧值。
        this.publishedFileMapsView?.commit(nextFingerprints, nextWarnings);
        for (const sourcePath of committedDeletedPaths) {
          removedSourcePaths.add(sourcePath);
          removedFingerprintPaths.add(sourcePath);
        }
        // C5 提交点 ②：发布事务里**真实删除**了 `source_files` 行 ⇒ `events` 经
        // `ON DELETE CASCADE` 一并消失（删的是 codex 路径，但它同样可能有用量行）。
        if (committedDeletedPaths.length > 0) usageDerivedChanged = true;
        // D1：本事务是**成功提交**的 ⇒ 显式修订。两类都要覆盖（卡面"实际用量 / perf 发布"）：
        //   * **perf 候选发布**：本事务真的改写了 `perf_samples` / `perf_rollout_threads`
        //     （`replaceOldThreadIds` = 清掉旧线程的候选，`stagedThreads` = 写入新候选）；
        //   * **用量侧真删**：`committedDeletedPaths` 非空 ⇒ 上面的 `events` 也真的少了行。
        // ⚠️ 卡面明文"**例行时刻元数据不作为用量变化**"：本事务里 `perf_file_fingerprints` /
        // `perf_file_warnings` 的每轮重写**不算**内容变化 —— 它们只在这两类真实变化**同时发生**时
        // 被顺带写，因此上面按 `replaceOldThreadIds`/`stagedThreads`/`committedDeletedPaths` 判定。
        if (replaceOldThreadIds.length > 0 || stagedThreads.length > 0) this.commitStoreRevision("perf");
        if (committedDeletedPaths.length > 0) this.commitStoreRevision("usage-delete");
      } catch (error) {
        this.database.exec("ROLLBACK");
        if (error?.code === "HISTORY_ARCHIVE_PERF_REVISION_INPUT_CHANGED") throw error;
        blockCodexHome(homeId, error);
        partialHomesById.delete(homeId);
        if (policyNeedsUpgrade) policyUpgradeComplete = false;
      }
    }

    // **BC-2 判据（见报告 §3）**：区分"**真实删除**"与"**受阻**"——靠**下一轮 discovery 的事实**：
    //   - **受阻**：文件仍被 discovery 发现（在 `knownFiles` 里）⇒ 只是读不到 ⇒ 保留 `source_files`
    //     行与指纹映射，并计入 `degraded`（候选保留供回滚、但被 D4 排除出排名）；
    //   - **真实删除**：文件**不再**出现在本轮 `files` 里（且其 home 未失败、**未被发现**）⇒
    //     删除 `source_files` 行（候选经 `ON DELETE CASCADE` 一并清除），并**同步删除指纹分量**
    //     ⇒ 版本不再表征一个已不存在的来源。
    //   ⚠️ 这正是 `★4` 已立的区分（"文件整体消失"≠"文件存在但不可读"），本修复**不破坏**它，
    //     只是把**指纹映射**也按同一判据同步。
    for (const row of this.database.prepare("SELECT path, kind, home_id, home_path FROM source_files").all()) {
      if (!knownFiles.has(row.path) && !failedHomeIds.has(row.home_id) && !failedHomePaths.has(row.home_path)) {
        if (canonicalizeKind(String(row.kind)) === "codex") continue;
        const replacement = replacementTargetByOldPath.get(String(row.path));
        if (replacement === undefined || !committedUsagePaths.has(replacement)) continue;
        this.database.prepare("DELETE FROM quota_usage_sources WHERE source_path = ?").run(row.path);
        this.database.prepare("DELETE FROM source_files WHERE path = ?").run(row.path);
        removedSourcePaths.add(String(row.path));
        // C5 提交点 ③：非 codex 来源的真实删除 ⇒ `events` 经 `ON DELETE CASCADE` 一并消失。
        usageDerivedChanged = true;
        // D1：这条 `DELETE` 是一条独立的 autocommit 语句 ⇒ 已经提交，推进修订。
        this.commitStoreRevision("usage-delete");
        // 真实删除 ⇒ 移除该文件的已发布指纹分量（否则版本会表征不存在的来源）。
        const removedPath = String(row.path);
        if (Object.hasOwn(publishedFingerprintsBefore, removedPath)) {
          delete publishedFingerprintsBefore[removedPath];
          removedFingerprintPaths.add(removedPath);
        }
      }
    }

    const previousMissingSources = decodeMissingSources(this.readMetaRaw(MISSING_SOURCES_META));
    const previousMissingByPath = new Map(previousMissingSources.map((source) => [source.path, source]));
    const missingSinceMs = Date.now();
    const missingSources = [];
    for (const row of this.database
      .prepare("SELECT path, kind, home_id, home_label, home_path FROM source_files")
      .all()) {
      const sourcePath = String(row.path);
      if (knownFiles.has(sourcePath)) continue;
      if (failedHomeIds.has(row.home_id) || failedHomePaths.has(row.home_path)) continue;
      const replacement = replacementTargetByOldPath.get(sourcePath);
      if (replacement !== undefined && committedUsagePaths.has(replacement)) continue;
      const previous = previousMissingByPath.get(sourcePath);
      // Missing-source identity is provenance, not the perf-kind projection:
      // keep values such as project-log distinguishable from unsupported.
      const kind = String(row.kind ?? "");
      const homeId = String(row.home_id ?? "");
      missingSources.push({
        path: sourcePath,
        kind,
        homeId,
        homeLabel: String(row.home_label ?? ""),
        homePath: String(row.home_path ?? ""),
        missingSinceMs:
          previous?.kind === kind && previous?.homeId === homeId ? previous.missingSinceMs : missingSinceMs,
      });
    }
    missingSources.sort((left, right) => left.path.localeCompare(right.path));

    // M3.4 返工 **BB-1**：读取期间变过的文件 ⇒ **确保下次重新提取**。
    // 做法：把 `source_files.size/mtime_ms` 置 `-1`（沿用 v12 迁移的同一"置脏"手法）
    // ⇒ 下一轮增量判据（`size===info.size && mtime===info.mtimeMs`）**必然**不成立 ⇒ 重解析。
    // ⚠️ 这**不影响**本轮已写入的候选（它们留在库里供失败回滚），但 `perf_state=degraded`
    // 已把它们**排除出默认排名**（D4）⇒ 陈旧候选绝不会静默参与排名。
    for (const path of liveChangedPaths) {
      this.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(path);
    }
    // C5 提交点 ④：置脏写的就是 `source_files`（下一轮必然重提取 ⇒ 用量行随后必变）。
    if (liveChangedPaths.size > 0) usageDerivedChanged = true;
    // D1：置脏的 `UPDATE` 已提交（autocommit）⇒ 推进修订。注意**不**在这里推进"替换成功"的修订
    // —— 那个文件的替换事务已经整笔 `ROLLBACK` 了（`replaceFile` 返回 `committed: false`）。
    if (liveChangedPaths.size > 0) this.commitStoreRevision("live-dirty");

    for (const home of workbuddyHomes) {
      const homeId = String(home.id ?? "");
      const before = workbuddyTraceDependencies.get(homeId);
      let after = null;
      try {
        after = await inspectWorkbuddyTrace(home.path);
      } catch {
        after = null;
      }
      const changed = before?.complete === true && after?.complete === true && before.fingerprint !== after.fingerprint;
      if (after === null || !after.complete || before?.complete !== true || changed) {
        workbuddyTraceDependencies.set(homeId, {
          fingerprint: after?.fingerprint ?? null,
          complete: false,
        });
        if (!blockedHomeIds.has(homeId)) {
          blockedHomeIds.add(homeId);
          fileFailures.push({
            sourceKind: "workbuddy",
            homeId,
            code: changed ? "LIVE_SOURCE_CHANGED" : "READ_ONLY_OPEN_FAILED",
          });
        }
      }
    }

    // ── M3.4：解析本轮最终状态 ───────────────────────────────────────────────
    //
    // 三类"受阻"来源**必须分开**（卡片明文，不可混淆）：
    //   ① `failedHomes`：home 在**发现阶段**就失败（目录读不了）⇒ 其文件**根本没进本轮扫描**。
    //      这些 home 的旧候选**仍在库里**（三段合取保护），因此属于"当前排名不可信"，
    //      必须计入退化 —— 否则它们的陈旧候选会**悄悄参与排名**（卡片明文禁止）。
    //   ② `blockedHomeIds`：文件被发现、但 `replaceFile` 抛错 ⇒ 该 home 候选**不完整**。
    //   ③ `unsupportedSources`：来源**未启用**（如 `project-log`/未注册 kind）⇒ **不是退化**，
    //      单列即可，**不得令其他来源退化**。
    //
    // ⚠️ **BB-2（用户复现）**：① 与 ② 都**必须先问"该来源是否启用"**。用户注入**未启用
    // Codex 来源**的用量失败后得到 `perf_state=degraded`，且同一 home **同时**出现在
    // `unsupported` 与 `degraded` 两个列表 —— 直接违反上面 ③ 的明文。原代码在 ① 与 ② 处
    // 都**无条件** `blockedHomeIds.add(...)`（注释写了规则、代码没执行）。
    for (const home of failedHomes) {
      const kindRaw = String(home?.kind ?? home?.sourceKind ?? "");
      // 未启用来源的失败与 perf 无关（它根本没有 perf reader）⇒ **不得**计入 perf 退化。
      if (home?.id && isPerfSourceEnabled(kindRaw)) {
        blockedHomeIds.add(String(home.id));
        fileFailures.push({
          sourceKind: canonicalizeKind(kindRaw),
          homeId: String(home.id),
          code: "READ_ONLY_OPEN_FAILED",
        });
      }
    }
    // 三组必须分开：`enabled` 不列入；`notEnabled`/`unsupported` 单列。
    const classified = classifyPerfSources(homes);
    const unsupportedSources = [...classified.notEnabled, ...classified.unsupported];

    let policyRawToWrite;
    if (!policyNeedsUpgrade || policyUpgradeComplete) {
      try {
        policyRawToWrite = encodeCodexPublicationPolicy(
          [...partialHomesById.entries()].map(([homeId, blockedThreadIds]) => ({
            homeId,
            blockedThreadIds: [...blockedThreadIds],
          })),
        );
      } catch (error) {
        for (const homeId of codexPlans.keys()) blockCodexHome(homeId, error);
        // C2 卡：策略编码失败 ⇒ 本轮的 partial 投影**无法持久化**。复用轮里"刚刚重放的那份投影"
        // **不在** `codexPlans` 里，所以它既不会被上面的循环归因，也会在 `partialHomesById.clear()`
        // 之后**从 degraded 里消失** —— 那等于让一个确定性受阻的 home 静默写 `ready`，直接违反
        // `encodeCodexPublicationPolicy` 的契约（"绝不能因此写 `ready`"）。因此：
        //   * 用**同一个** `blockCodexHome` 给它归因（与规划路径同型、倍率相同 ⇒ 下一轮不会膨胀）；
        //   * 丢弃它的稳定失败记录 —— 那份投影没有被持久化，留着只会下一轮再失败（"记录粘住"）。
        // 删记录只是"放弃跳过"，下一轮必然重新规划并重建记录 ⇒ 确定性的自愈路径。
        for (const homeId of partialHomesById.keys()) {
          if (!codexPlans.has(homeId)) blockCodexHome(homeId, error);
          this.codexStableAttempts.delete(homeId);
        }
        partialHomesById.clear();
        policyRawToWrite = "";
        policyUpgradeComplete = false;
      }
    }

    // ── C1 卡：**提交**本轮的稳定失败尝试记录 ───────────────────────────────────────────────
    //
    // 判据是**本轮受阻事件的计数快照比对**，而不是"最终是否 degraded"：
    //   * 规划本身就**确定性受阻**的 home，其 `blockCodexHome` 调用发生在快照**之前**，
    //     计数相等 ⇒ 允许提交（否则 home 级坏内容永远无法复用，正是本卡要打的靶子）；
    //   * 规划之后**又**受阻（发布前复核 `LIVE_SOURCE_CHANGED`、发布事务 `ROLLBACK`、
    //     跨 home 冲突、用量侧失败、策略编码失败）⇒ 计数变大 ⇒ **丢弃**记录
    //     （卡面："发布失败不缓存为可跳过状态"）。
    // 计数相等时还要**清除**该 home 的旧记录，避免"本轮结果不可记录但旧记录仍在"的残留。
    for (const [homeId, candidate] of codexStableAttemptCandidates) {
      const blockEvents = codexBlockEvents.get(homeId) || 0;
      if (blockEvents !== candidate.blockEvents) {
        this.codexStableAttempts.delete(homeId);
        continue;
      }
      const paths = [...candidate.expectedPaths];
      const afterFingerprints = candidate.window?.after?.fileFingerprints ?? {};
      this.codexStableAttempts.set(homeId, {
        homeId,
        homeKind: String(candidate.home?.kind ?? ""),
        homePath: String(candidate.home?.path ?? ""),
        methodVersion: codexStableAttemptMethodVersion(),
        paths,
        fileFingerprints: Object.fromEntries(paths.map((filePath) => [filePath, afterFingerprints[filePath]])),
        // 两种形态：home 级受阻（非空告警列表）与"部分失败"（非空 blockedThreadIds）。
        blockedHomeWarnings: candidate.blockedHomeWarnings ?? [],
        blockedThreadIds: [...(partialHomesById.get(homeId) ?? [])].sort(),
        failedThreads: (candidate.failedThreads ?? []).map((entry) => ({
          threadId: entry.threadId,
          reason: entry.reason,
          failedFilePaths: [...(entry.failedFilePaths || [])],
        })),
      });
    }

    const degradedHomeSet = new Set(blockedHomeIds);
    for (const homeId of partialHomesById.keys()) degradedHomeSet.add(homeId);
    const degradedHomeIds = [...degradedHomeSet].sort();
    const nextState = degradedHomeIds.length > 0 ? PERF_STATE_DEGRADED : PERF_STATE_READY;

    const nextServiceTierEvidence = loadServiceTierEvidence(homes);
    const nextQuotaEvidence = loadQuotaSourceEvidence(
      homes,
      this.quotaSourceEvidence && quotaSourceEvidenceSnapshot(this.quotaSourceEvidence),
    );
    const quotaEvidenceSnapshot = JSON.stringify(quotaSourceEvidenceSnapshot(nextQuotaEvidence));
    const previousQuotaEvidence = this.readMetaRaw("quota_source_log_evidence");
    if (quotaEvidenceSnapshot !== previousQuotaEvidence) {
      this.writeMeta("quota_source_log_evidence", quotaEvidenceSnapshot);
      if (previousQuotaEvidence !== undefined || quotaSourceEvidenceSnapshot(nextQuotaEvidence).entries.length)
        this.commitStoreRevision("quota-source");
    }
    this.quotaSourceEvidence = nextQuotaEvidence;
    this.quotaSourceRevision = -1;
    let sameServiceTierEvidence = false;
    if (this.serviceTierEvidence) {
      try {
        sameServiceTierEvidence =
          JSON.stringify(serviceTierEvidenceSnapshot(this.serviceTierEvidence)) ===
          JSON.stringify(serviceTierEvidenceSnapshot(nextServiceTierEvidence));
      } catch {
        // Custom resolvers have no immutable snapshot; replacing them remains conservative.
      }
    }
    if (!sameServiceTierEvidence) this.serviceTierEvidence = nextServiceTierEvidence;
    // D1：**service-tier evidence 的成功提交**。注意 `loadServiceTierEvidence` **每轮**都返回**新对象**
    // ⇒ 用对象身份当"变化"会让每个 no-op 轮都推进修订（违反卡面"无变化同步保留缓存"），
    // 所以用**输入签名**（各 home 的 `logs_2.sqlite` 主库 + `-wal`）判定，见
    // {@link UsageStore#serviceTierEvidenceSignature}。
    const serviceTierSignature = this.serviceTierEvidenceSignature(homes);
    if (
      this.serviceTierEvidenceInput !== null &&
      (serviceTierSignature !== this.serviceTierEvidenceInput || !sameServiceTierEvidence)
    ) {
      this.commitStoreRevision("service-tier");
    }
    this.serviceTierEvidenceInput = serviceTierSignature;
    // S4：缺 duration 的计数走**普通 warning 字符串**通道（`PERF_SOURCE_WARNING_CODES` 是冻结码域，
    // 不得新增 `MISSING_DURATION`）⇒ 每 home 每轮至多一条。
    for (const { label, count } of workbuddyDurationGaps.values()) {
      if (count > 0) warnings.push(`${label || "WorkBuddy"}：${count} 个响应缺少 generation 时长`);
    }
    this.homes = homes;
    this.generatedAt = new Date().toISOString();
    this.fingerprint = status.fingerprint;
    this.checkedAt = status.checkedAt;
    const publishedFingerprints = this.publishedFileFingerprintsForRound();
    for (const removedPath of removedFingerprintPaths) delete publishedFingerprints[removedPath];
    const publishedWarnings = this.publishedFileWarningsForRound();
    for (const removedPath of removedSourcePaths) delete publishedWarnings[removedPath];
    // Rebuild human-facing warnings from the committed sidecar, not only this round's return values.
    for (const [filePath, fileWarnings] of Object.entries(publishedWarnings)) {
      for (const warning of fileWarnings) {
        if (warning.code === PROJECT_LOG_TRUNCATION_WARNING_CODE) {
          const message = formatProjectLogTruncationWarning(filePath, warning.count);
          if (!warnings.includes(message)) warnings.push(message);
        } else if (warning.code === PROJECT_LOG_MALFORMED_LINE_WARNING_CODE) {
          for (const lineNumber of warning.lineNumbers || []) {
            const message = formatProjectLogMalformedLineWarning(filePath, lineNumber);
            if (!warnings.includes(message)) warnings.push(message);
          }
        }
      }
    }
    this.warnings = warnings;

    // **D3 + BC-2**：`perf_index_version` = **已提交指纹 + 来源身份** 的聚合。
    // ⚠️ **不再**在整轮结束时重新 stat 上游（用户在 BC-2 中复现了由此产生的错误版本）。
    const sourceFileRows = this.database.prepare("SELECT path, kind, home_id, home_path FROM source_files").all();
    const codexHomePaths = new Map(
      homes
        .filter((home) => canonicalizeKind(String(home?.kind ?? home?.sourceKind ?? "")) === "codex")
        .map((home) => [String(home?.id ?? ""), String(home?.path ?? "")]),
    );
    const codexFileRows = this.database
      .prepare(`
        SELECT rollouts.source_path AS path, rollouts.home_id AS home_id
        FROM perf_rollout_threads AS rollouts
        JOIN source_files AS files ON files.path = rollouts.source_path
      `)
      .all();
    const publishedCodexHomeIds = new Set(codexFileRows.map((row) => String(row.home_id)));
    const retainedCodexHomes = [];
    for (const homeId of publishedCodexHomeIds) {
      if (codexHomePaths.has(homeId) || !blockedHomeIds.has(homeId)) continue;
      const oldHome = oldCodexRowsByHome.get(homeId)?.[0];
      if (!oldHome) continue;
      const homePath = String(oldHome.home_path ?? "");
      codexHomePaths.set(homeId, homePath);
      retainedCodexHomes.push({
        id: homeId,
        label: String(oldHome.home_label ?? "Codex"),
        path: homePath,
        kind: "codex",
      });
    }
    const publishedCodexFiles = codexFileRows.map((row) => ({
      path: String(row.path),
      kind: "codex",
      home_id: String(row.home_id),
      home_path: codexHomePaths.get(String(row.home_id)) || "",
    }));
    const fingerprintHomes = [...homes, ...retainedCodexHomes].filter((home) => {
      const kind = canonicalizeKind(String(home?.kind ?? home?.sourceKind ?? ""));
      return kind !== "codex" || publishedCodexHomeIds.has(String(home?.id ?? ""));
    });
    const publishedFiles = sourceFileRows
      .filter((row) => canonicalizeKind(String(row.kind ?? "")) !== "codex")
      .concat(publishedCodexFiles);
    // The publication sequence advances only in the transaction that consumes
    // timing dirt, so a successful home still publishes while another fails.
    const currentRequestTimingRevision = readRequestTimingRevision(this.database);
    const rawPublishedTimingRevision = Number(this.readMetaRaw(REQUEST_TIMING_PUBLISHED_REVISION_META));
    const lastPublishedTimingRevision =
      Number.isSafeInteger(rawPublishedTimingRevision) && rawPublishedTimingRevision >= 0
        ? rawPublishedTimingRevision
        : 0;
    const timingPublicationPending = this.requestTimingDirtyThreadCount() > 0;
    const requestTimingRevision = timingPublicationPending ? lastPublishedTimingRevision : currentRequestTimingRevision;
    const rawTimingPublicationSeq = Number(this.readMetaRaw(REQUEST_TIMING_PUBLICATION_SEQ_META));
    const timingPublicationSeq =
      Number.isSafeInteger(rawTimingPublicationSeq) && rawTimingPublicationSeq >= 0 ? rawTimingPublicationSeq : 0;
    const traceDependencyUnavailable = workbuddyHomes.some(
      (home) => workbuddyTraceDependencies.get(String(home.id ?? ""))?.complete !== true,
    );
    const publishedFingerprint = traceDependencyUnavailable
      ? ""
      : buildPublishedSourcesFingerprint(
          fingerprintHomes,
          publishedFingerprints,
          publishedFiles,
          timingPublicationSeq,
          workbuddyTraceDependencies,
          legacyWorkbuddyFallbackAllowed,
          missingSources,
        );
    // 源告警只投影 {sourceKind, homeId, code, count}（**不含路径**）。
    // Preserve successful per-file reader diagnostics (for example UNKEYABLE_RECORD)
    // alongside current file failures. Sidecar entries describe committed rows;
    // summing their original counts keeps indexed warnings aligned with memory.
    const committedFileWarnings = [];
    const warningsByPath = publishedWarnings;
    for (const row of publishedFiles) {
      if (!isPerfSourceEnabled(String(row.kind ?? ""))) continue;
      committedFileWarnings.push(...(warningsByPath[String(row.path)] || []));
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.writeMeta("generated_at", this.generatedAt);
      this.writeMeta("fingerprint", this.fingerprint);
      this.writeMeta("perf_file_fingerprints", JSON.stringify(publishedFingerprints));
      this.writeMeta("perf_file_warnings", JSON.stringify(publishedWarnings));
      this.writeMeta("perf_method_version", PERF_METHOD_VERSION);
      this.writeMeta("perf_index_version", publishedFingerprint);
      this.writeMeta("perf_workbuddy_legacy_fallback_allowed", legacyWorkbuddyFallbackAllowed ? "1" : "0");
      this.writeMeta(REQUEST_TIMING_PUBLISHED_REVISION_META, String(requestTimingRevision));
      this.writeMeta(MISSING_SOURCES_META, JSON.stringify(missingSources));
      this.writeMeta("perf_indexed_at", this.generatedAt);
      this.writePerfState(nextState, {
        degradedHomeIds,
        sourceWarnings: projectSourceWarnings([
          ...committedFileWarnings,
          ...projectSourceFailures([...fileFailures, ...liveChangeWarnings]),
        ]),
      });
      if (policyRawToWrite !== undefined) this.writeMeta("perf_codex_publication_policy", policyRawToWrite);
      // 未启用来源单列（不改 `perf_state`，**不令其他来源退化**）。
      this.writeMeta("perf_unsupported_sources", JSON.stringify(unsupportedSources));
      this.database.exec("COMMIT");
      // S1：轮级发布成功提交 ⇒ 视图与已提交的库状态对齐（回滚则保持旧值）。
      this.publishedFileMapsView?.commit(publishedFingerprints, publishedWarnings);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    // ── C5：派生缓存**定向失效**（不再"每轮无条件清空"）────────────────────────────────
    // 卡面："无实际变更时……**不无条件清空派生缓存**"。两个缓存都是**用量侧**派生：
    //   * `metadataCache`：`events` 聚合 + `this.homes`（见 `metadata()`）；
    //   * `periodComparisonCache`：`periodAggregate()` 的 `events` 聚合（键已含时区/日期/排除集、
    //     目录键集）。
    // ⇒ 判据只有两条**真实事实**：① 本轮是否写过用量数据（`usageDerivedChanged`，见上面的提交点
    // ①②③④）；② 本轮 home 集合是否变过（缓存里存着建它那一刻的 home 形状）。
    // 无实际变更的轮次**保留**昂贵的派生结构（不清空），只把**按契约每轮更新**的例行时刻字段
    // 刷进去 —— `generatedAt` 的语义是"最近一轮成功 sync 的时刻"（本轮开头重取、
    // `generated_at` / `perf_indexed_at` 在同一轮的末期元数据事务里每轮写入），绝不能因为保留
    // 缓存而被冻住。
    const currentHomeShape = homes
      .map((home) => `${home?.kind}\u0000${home?.id}\u0000${home?.label}\u0000${home?.path}`)
      .join("\n");
    const cachedHomeShape = (this.metadataCache?.homes ?? [])
      .map((home) => `${home?.kind}\u0000${home?.id}\u0000${home?.label}\u0000${home?.path}`)
      .join("\n");
    const homeSetChanged = this.metadataCache !== null && cachedHomeShape !== currentHomeShape;
    // ── D1：实例修订 / 外部提交（**统一**的失效判据；守卫块本身逐字未动，见下）──────────────────
    // D1 ①：home 集合形状变化本身就是一次**成功提交**（读路径的 `metadata().homes` 会变）。
    if (homeSetChanged) this.commitStoreRevision("home");
    // D1 ②：外部提交（同连接 `PRAGMA data_version` 变化）⇒ 修订 +1 + 重载必要元数据。
    this.detectExternalCommit();
    // D1 ③：把 D1 的理由折进 C5 的守卫。⚠️ 下面 6 行是**共享门禁锚点**
    // （`tools/lib/instrument.mjs` 的 usage-store 组 + `C5/mutation-c5.mjs` 的 `C5_TAIL` 都逐字匹配它）
    // ⇒ 一个字节都不能改；这里只把"修订前进过"等价为"派生缓存的输入变了"。
    if (this.storeRevision !== this.derivedRevision) usageDerivedChanged = true;
    if (usageDerivedChanged || homeSetChanged) {
      this.metadataCache = null;
      this.periodComparisonCache.clear();
      this.metadataObservationCache = null;
    } else if (this.metadataCache !== null) {
      this.metadataCache.generatedAt = this.generatedAt;
      this.metadataCache.warnings = this.warnings;
    }
    // D1：轮末把"缓存 ↔ 修订"的对齐落到当前值。不变量：走到这里若缓存被**保留**，则修订必然没前进过
    // （否则上面的折行已把 `usageDerivedChanged` 置真）⇒ 这行对保留分支是恒等赋值、对失效分支是记账。
    this.derivedRevision = this.storeRevision;
    // 缓存失效已完成后才维护 rollup；重建抛错不能让本轮留下可跳过失效的旧缓存。
    const dirtyRollupDays = listDirtyUsageRollupDays(this.database);
    const localRollupZone = currentLocalRollupZoneIdentity();
    const localRollupZoneChanged = this.readMetaRaw(LOCAL_ROLLUP_ZONE_META) !== localRollupZone;
    if (dirtyRollupDays.length > 0 || localRollupZoneChanged) {
      if (historyArchiveAuthorizedSegmentIds(this.database).size > 0) {
        // Hold the write lock while the async complete-history read and both
        // rollup publishes run; otherwise an external commit could mix revisions.
        this.database.exec("BEGIN IMMEDIATE");
        this.writeTransactionDepth += 1;
        try {
          const roundDirtyDays = listDirtyUsageRollupDays(this.database);
          const events = await this.publishedHistoryUsageEvents();
          if (roundDirtyDays.length > 0) {
            rebuildUsageRollupsFromEvents(this.database, { days: roundDirtyDays, events });
          }
          const localDays = new Set(localUsageRollupDaysForUtcDays(roundDirtyDays));
          if (localRollupZoneChanged) {
            const eventUtcDays = new Set();
            for (const event of events) {
              const timestamp = Date.parse(event.timestamp);
              if (!Number.isFinite(timestamp)) {
                throw new TypeError("complete history contains an invalid event timestamp");
              }
              const day = new Date(Math.floor(timestamp / 86_400_000) * 86_400_000).toISOString().slice(0, 10);
              eventUtcDays.add(day);
            }
            for (const day of localUsageRollupDaysForUtcDays([...eventUtcDays])) localDays.add(day);
            for (const row of this.database
              .prepare("SELECT day_key FROM usage_rollup_days WHERE calendar_zone = 'local'")
              .all()) {
              localDays.add(String(row.day_key));
            }
          }
          rebuildUsageRollupsFromEvents(this.database, {
            days: [...localDays].sort(),
            events,
            calendarZone: "local",
          });
          this.writeMeta(LOCAL_ROLLUP_ZONE_META, localRollupZone);
          this.database.exec("COMMIT");
        } catch (error) {
          try {
            this.database.exec("ROLLBACK");
          } finally {
            this.writeTransactionDepth -= 1;
          }
          throw error;
        }
        this.writeTransactionDepth -= 1;
      } else {
        // UTC/local 共用外层 savepoint：任一侧失败都恢复 dirty 队列和两侧缓存。
        this.database.exec("SAVEPOINT usage_rollup_sync");
        try {
          if (dirtyRollupDays.length > 0) {
            rebuildUsageRollups(this.database, { days: dirtyRollupDays, calendarZone: "utc" });
          }
          const localDays = new Set(localUsageRollupDaysForUtcDays(dirtyRollupDays));
          if (localRollupZoneChanged) {
            // Zone changes are rare, so scan event days here instead of on every no-op round.
            const eventUtcDays = this.database
              .prepare("SELECT DISTINCT date(timestamp_ms / 1000.0, 'unixepoch') AS day_key FROM events")
              .all()
              .map((row) => String(row.day_key));
            for (const day of localUsageRollupDaysForUtcDays(eventUtcDays)) localDays.add(day);
            for (const row of this.database
              .prepare("SELECT day_key FROM usage_rollup_days WHERE calendar_zone = 'local'")
              .all()) {
              localDays.add(String(row.day_key));
            }
          }
          rebuildUsageRollups(this.database, { days: [...localDays].sort(), calendarZone: "local" });
          this.writeMeta(LOCAL_ROLLUP_ZONE_META, localRollupZone);
          this.database.exec("RELEASE usage_rollup_sync");
        } catch (error) {
          this.database.exec("ROLLBACK TO usage_rollup_sync");
          this.database.exec("RELEASE usage_rollup_sync");
          throw error;
        }
      }
    }
    if (this.externalCommitCount === externalCommitCount) {
      const retainedByHome = new Map();
      for (const row of sourceFileRows) {
        if (canonicalizeKind(String(row.kind ?? "")) !== "codex") continue;
        const homeId = String(row.home_id);
        const retained = retainedByHome.get(homeId) || new Set();
        retained.add(String(row.path));
        retainedByHome.set(homeId, retained);
      }
      this.codexPublishedPaths.clear();
      for (const homeId of codexHomeById.keys()) {
        if (degradedHomeSet.has(homeId)) continue;
        this.codexPublishedPaths.set(homeId, {
          live: new Set((codexFilesByHome.get(homeId) || []).map((file) => file.filePath)),
          retained: retainedByHome.get(homeId) || new Set(),
        });
      }
    }
    // Track no-op writes before any range is warmed, after sync has initialized its rollup schema.
    if (
      !this.usageProjectionTracker &&
      !this.database.isTransaction &&
      !this.database
        .prepare("SELECT 1 FROM store_meta WHERE key IN (?, ?)")
        .get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META, HISTORY_ARCHIVE_PERF_AUTHORITY_META)
    ) {
      this.syncDerivedRevision();
      this.installUsageProjectionTracker();
      this.observedUsageProjectionChanges = this.usageProjectionChangeKey();
    }
    return {
      ...status,
      updatedFileCount,
      perfState: nextState,
      degradedHomeIds,
      unsupportedSources,
      missingSources,
    };
  }

  /**
   * D3：**已提交 quota 观测的规范映射**（`rate_limit_observations` 行 ⇒ 规范对象，单槽复用）。
   *
   * 契约（本卡红线）：这里**只缓存静态输入**。返回对象里只有"已提交观测行"的字段
   * （`source_path` / `line_number` / `role` / `observed_at_ms` / `limit_id` / `limit_name` /
   * `plan_type` / `window_minutes` / `resets_at_ms` / `used_percent`），**没有任何时间派生字段**：
   * 窗口边界、`state`（available / waiting / missing / ambiguous）、`percentStale`、倒计时、reset
   * 语义一律由消费者**每次**用当前或冻结的 `asOf` 现算（`selectQuotaWindows(rows, asOf)`；
   * `resolveDateRange({ …filters, now: asOf, quota })`）。`resetsAtMs` 是**观测里的原始输入**，
   * 不是"相对现在的重置语义"。
   *
   * 为什么复用：同一次 `summarizeInReadTransaction` 里它被调用**两次**（`:4834` 选窗口 +
   * `:4918` 逐范围记录），而且每次 `summarize` 至少调用一次 ⇒ 缓存后
   * "**一次读取 + 一次规范映射，两个消费者共用**"（`selectQuotaWindows` 与
   * `quotaRecordsForRange` 都只读这份映射，不复制、不改写）。
   *
   * 失效（沿 D1 机制，不自建 TTL / 事件总线 / 计数表）：键 = `this.storeRevision`
   * （自身写入、外部提交 `PRAGMA data_version`、service-tier evidence 都会推进它）；
   * `syncDerivedRevision()` / `open()` / `close()` 复位；写事务内
   * （`writeTransactionDepth > 0`）读到的是**未提交**状态 ⇒ **不读也不写**（D1 的回滚语义）。
   * 调用方自有快照可传 `useCache: false`，复用同一 SELECT/codec 但绕过 memo。
   *
   * @param {{ useCache?: boolean }} [options]
   * @returns {object[]} 规范映射本身（**只读**；调用方不得就地改写）
   */
  quotaObservations({ useCache = true } = {}) {
    // D1：读路径先对齐修订（外部提交在这里被检出 ⇒ 缓存失效 + 必要元数据重载）。
    this.syncDerivedRevision();
    // D1：写事务内**不读也不写**共享缓存（读到的是未提交状态 ⇒ 回滚后它会说谎）。
    const cacheable = useCache && this.writeTransactionDepth === 0;
    if (cacheable && this.quotaObservationCache?.revision === this.storeRevision) {
      return this.quotaObservationCache.rows;
    }
    const rows = quotaObservationsFromDatabase(this.database, Boolean(this.verifiedHistorySqlRead));
    if (cacheable) this.quotaObservationCache = { revision: this.storeRevision, rows };
    return rows;
  }

  nonCodexHomeIds() {
    // 限额窗口只衡量 Codex 用量：main/jetbrains/extra/codex 之外的目录（zcode、dsh、opencode、project-log）
    // 只在普通范围里计入统计，不能进入限额聚合。
    return this.database
      .prepare(
        "SELECT DISTINCT home_id AS id FROM source_files WHERE kind NOT IN ('main', 'jetbrains', 'extra', 'codex')",
      )
      .all()
      .map((row) => row.id)
      .filter((id) => typeof id === "string" && id.length > 0);
  }

  metadata(asOf = new Date()) {
    // D1：读路径先对齐修订（外部提交在这里被检出 ⇒ 缓存失效 + 必要元数据重载）。
    if (!this.metadataSnapshotRead) this.syncDerivedRevision();
    // D1：写事务内读到的是**未提交**状态 ⇒ 这一轮**不落**共享缓存（验收："事务内已读的派生缓存
    // 被安全清理" —— 预防 + 回滚时再清一次，见 `rollbackReplaceFileTransaction`）。
    const cacheable = this.writeTransactionDepth === 0;
    /** D1：不可缓存时（写事务内）用的**本次调用**快照；绝不写回 `this.metadataCache`。 */
    let builtMetadata = null;
    if (!this.metadataCache) {
      const counts = readMetadataUsageCounts(this.database, this.verifiedHistorySqlRead ? this.eventBounds() : null);
      // 按实际使用记录给出各 harness（Codex / ZCode / DSH / OpenCode / Claude / WorkBuddy）用到的模型名称。
      const harnessModels = {
        Codex: new Set(),
        ZCode: new Set(),
        DSH: new Set(),
        OpenCode: new Set(),
        Claude: new Set(),
        WorkBuddy: new Set(),
      };
      const modelRows =
        cacheable && this.metadataObservationCache?.revision === this.storeRevision
          ? this.metadataObservationCache.rows
          : this.database.prepare("SELECT DISTINCT channel, model FROM events").all();
      for (const row of modelRows) {
        const model = String(row.model || "").trim();
        if (!model || model.toLocaleLowerCase() === "unknown model") continue;
        harnessModels[harnessModelName(row.channel)].add(model);
      }
      builtMetadata = {
        generatedAt: this.generatedAt,
        eventCount: counts.eventCount,
        sessionCount: counts.sessionCount,
        homeCount: this.homes.length,
        harnessModels: {
          Codex: [...harnessModels.Codex].sort((a, b) => a.localeCompare(b)),
          ZCode: [...harnessModels.ZCode].sort((a, b) => a.localeCompare(b)),
          DSH: [...harnessModels.DSH].sort((a, b) => a.localeCompare(b)),
          OpenCode: [...harnessModels.OpenCode].sort((a, b) => a.localeCompare(b)),
          Claude: [...harnessModels.Claude].sort((a, b) => a.localeCompare(b)),
          WorkBuddy: [...harnessModels.WorkBuddy].sort((a, b) => a.localeCompare(b)),
        },
        homes: this.homes.map((home) => {
          const row = counts.homeRows.get(home.id);
          return {
            ...home,
            status: row ? "active" : "no-events",
            eventCount: Number(row?.event_count || 0),
            sessionCount: Number(row?.session_count || 0),
          };
        }),
        warnings: this.warnings,
      };
      // D1：写事务内**不落**共享缓存；正常路径（深度 0）才把它提升为实例级派生缓存。
      if (cacheable) this.metadataCache = builtMetadata;
    }
    // Re-evaluate time even without new files; exclude future events before MAX.
    //
    // D4：观测聚合按**实际变更**复用（键 = D1 的 `storeRevision`）。缓存里只有**静态输入**
    // ——`events` 的原始分组行 `{channel, model, home_id, last_seen}`（未过滤）——而 `asOf`
    // 的时间语义仍**每次现算**：
    //   * `asOf >= 全表最大 timestamp`（不存在未来事件）⇒ `timestamp_ms <= asOf` 是**恒等**过滤
    //     ⇒ 直接复用未过滤行（该次请求 0 次查询、0 行映射）；
    //   * `asOf < 全表最大 timestamp`（确有未来事件）⇒ "哪些事件算未来"随 `asOf` 变化 ⇒ **必须**
    //     每次按当前 `asOf` 现算，**绝不**使用缓存（未来事件过滤语义不得被缓存吃掉）。
    const asOfMs = asOf.getTime();
    const sourceKinds = homeSourceKinds(this.homes);
    /** `timestamp_ms <= cutoffMs` 的分组 MAX；`cutoffMs === null` 表示未过滤（用于静态输入）。 */
    const queryObservationRows = (cutoffMs) => {
      const sql = `SELECT channel, model, home_id, MAX(timestamp_ms) AS last_seen FROM events${
        cutoffMs === null ? "" : " WHERE timestamp_ms <= ?"
      } GROUP BY channel, model, home_id`;
      return cutoffMs === null ? this.database.prepare(sql).all() : this.database.prepare(sql).all(cutoffMs);
    };
    let observationRows = null;
    if (cacheable) {
      const cached = this.metadataObservationCache;
      if (!cached || cached.revision !== this.storeRevision) {
        const rows = queryObservationRows(null);
        this.metadataObservationCache = {
          revision: this.storeRevision,
          rows,
          maxTimestampMs: rows.reduce((max, row) => Math.max(max, Number(row.last_seen)), -Infinity),
        };
      }
      const memo = this.metadataObservationCache;
      observationRows = asOfMs >= memo.maxTimestampMs ? memo.rows : queryObservationRows(asOfMs);
    } else {
      // D1：写事务内读到的是**未提交**状态 ⇒ 不读也不写共享缓存，用本次调用快照。
      observationRows = queryObservationRows(asOfMs);
    }
    const observations = observationRows.map((row) => {
      const group = sourceGroup(row.channel, sourceKinds.get(String(row.home_id)));
      return {
        model: row.model,
        timestamp: Number(row.last_seen),
        harness: ["ZCode", "DSH", "OpenCode", "Claude"].includes(group) ? group : "Codex",
      };
    });
    // D1：可缓存时用实例级缓存（同一对象、可被 C5 用例按引用断言）；写事务内用本次快照。
    return {
      ...structuredClone(this.metadataCache ?? builtMetadata),
      ...buildModelActivity(observations, asOf),
    };
  }

  /**
   * Explicit cold-aware metadata. Without authority this preserves the
   * synchronous metadata fast path in one savepoint; with authority it derives
   * every field from the same verified complete event carrier.
   * @param {Date} [asOf]
   */
  async metadataHistory(asOf = new Date()) {
    await this.open();
    this.syncDerivedRevision();
    let hasAuthority = false;
    this.database.exec("SAVEPOINT metadata_history_read");
    try {
      hasAuthority = Boolean(
        this.database.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META),
      );
      if (!hasAuthority) {
        this.metadataSnapshotRead = true;
        try {
          return this.metadata(asOf);
        } finally {
          this.metadataSnapshotRead = false;
        }
      }
    } finally {
      this.database.exec("RELEASE metadata_history_read");
    }

    const union = await this.historyArchiveEventUnionForRange(undefined, {
      completeHistory: true,
      includeMetadataCarrier: true,
    });
    const events = publishedUsageEventsFromUnion(union, this.serviceTierEvidence, this.quotaSourceFor.bind(this));
    return metadataFromHistoryEvents(events, union.metadataCarrier, asOf);
  }

  eventBounds(excludeHomes = []) {
    if (this.verifiedHistorySqlRead && excludeHomes.length === 0) {
      return this.database
        .prepare(`
        SELECT MIN(minimum) AS minimum, MAX(maximum) AS maximum FROM (
          SELECT (SELECT MIN(timestamp_ms) FROM history_hot.events) AS minimum,
                 (SELECT MAX(timestamp_ms) FROM history_hot.events) AS maximum
          UNION ALL
          SELECT (SELECT MIN(timestamp_ms) FROM main.events),
                 (SELECT MAX(timestamp_ms) FROM main.events)
        )
      `)
        .get();
    }
    const scope = scopeFilterSql(excludeHomes);
    return this.database
      .prepare(
        `SELECT MIN(timestamp_ms) AS minimum, MAX(timestamp_ms) AS maximum FROM events${scope.sql ? ` WHERE ${scope.sql}` : ""}`,
      )
      .get(...scope.params);
  }

  aggregateRange(range, excludeHomes = []) {
    const rollupDays = completeRollupDays(range);
    if (rollupDays) {
      try {
        const totals = queryUsageRollupsRange(this.database, {
          ...rollupDays,
          excludeHomes,
        });
        return {
          event_count: totals.eventCount,
          session_count: totals.sessionCount,
          home_count: totals.homeCount,
          total: totals.total,
          input: totals.input,
          cached: totals.cached,
          output: totals.output,
          reasoning: totals.reasoning,
        };
      } catch (error) {
        if (error?.code !== "ROLLUP_DAYS_MISSING") throw error;
      }
    }
    const scope = scopeFilterSql(excludeHomes);
    const where = eventRangeScope(range, scope);
    return this.database
      .prepare(`
        SELECT
          COUNT(*) AS event_count,
          COUNT(DISTINCT session_id) AS session_count,
          COUNT(DISTINCT home_id) AS home_count,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM events
        WHERE ${where.sql}
      `)
      .get(...where.params);
  }

  /**
   * Read every complete published usage event. Source kind comes from the
   * joined source row rather than a caller-supplied home projection.
   * @returns {import("./usage-types.js").UsageEvent[]}
   */
  publishedUsageEvents() {
    if (!this.database) throw new TypeError("UsageStore is not open");
    const rows = this.database
      .prepare(
        `SELECT e.*, sf.kind AS source_kind
         FROM events e
         JOIN source_files sf ON sf.path = e.source_path
         ORDER BY e.timestamp_ms, e.id`,
      )
      .all();
    return rows.map((row) =>
      publishedUsageEventFromRow(row, row.source_kind, this.serviceTierEvidence, this.quotaSourceFor.bind(this)),
    );
  }

  /**
   * Read the complete published event carrier across hot facts and explicitly
   * authorized cold segments. This is async because verified cold packages
   * must be read; the original synchronous hot-only reader stays unchanged.
   * @returns {Promise<import("./usage-types.js").UsageEvent[]>}
   */
  async publishedHistoryUsageEvents() {
    const union = await this.historyArchiveEventUnionForRange(undefined, { completeHistory: true });
    return publishedUsageEventsFromUnion(union, this.serviceTierEvidence, this.quotaSourceFor.bind(this));
  }

  /**
   * Rebuild one UTC day from the complete authorized hot+cold event carrier.
   * BEGIN IMMEDIATE prevents another writer from changing captured facts while
   * verified cold files are awaited and the rollup rows are published.
   * @param {string} day
   */
  async rebuildHistoryRollupDay(day) {
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new TypeError(`day must be a YYYY-MM-DD string: ${String(day)}`);
    }
    const [year, month, date] = day.split("-").map(Number);
    const startMs = Date.UTC(year, month - 1, date);
    if (!Number.isFinite(startMs) || new Date(startMs).toISOString().slice(0, 10) !== day) {
      throw new RangeError(`invalid UTC day: ${day}`);
    }
    await this.open();
    await this.#rebuildHistoryRollupsTransaction("rebuildHistoryRollupDay", (database, events) => {
      if (events === null) rebuildUsageRollups(database, { days: [day] });
      else rebuildUsageRollupsFromEvents(database, { days: [day], events });
    });
  }

  /**
   * Rebuild every UTC and local day covered by the complete authorized
   * hot+cold history. Existing derived dates are included so stale rows and
   * rows from a previous local timezone are cleared, including when empty.
   */
  async rebuildHistoryRollups() {
    await this.open();
    await this.#rebuildHistoryRollupsTransaction("rebuildHistoryRollups", (database, events) => {
      createUsageRollups(database);
      const utcDays = completeHistoryRollupDays(database, events, "utc");
      const localDays = completeHistoryRollupDays(database, events, "local");
      if (events === null) {
        rebuildUsageRollups(database, { days: utcDays });
        rebuildUsageRollups(database, { days: localDays, calendarZone: "local" });
      } else {
        rebuildUsageRollupsFromEvents(database, { days: utcDays, events });
        rebuildUsageRollupsFromEvents(database, { days: localDays, events, calendarZone: "local" });
      }
      this.writeMeta(LOCAL_ROLLUP_ZONE_META, currentLocalRollupZoneIdentity());
    });
  }

  async #rebuildHistoryRollupsTransaction(methodName, publish) {
    if (this.database.isTransaction) {
      throw new Error(`${methodName} requires no active transaction`);
    }
    this.syncDerivedRevision();
    this.database.exec("BEGIN IMMEDIATE");
    this.writeTransactionDepth += 1;
    try {
      // Hot-only rebuilds aggregate in SQLite instead of materializing every event twice.
      const events =
        historyArchiveAuthorizedSegmentIds(this.database).size > 0 ? await this.publishedHistoryUsageEvents() : null;
      publish(this.database, events);
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } finally {
        this.rollbackReplaceFileTransaction();
      }
      throw error;
    }
    if (this.writeTransactionDepth > 0) this.writeTransactionDepth -= 1;
    this.commitStoreRevision("history-rollup");
    this.syncDerivedRevision();
  }

  /**
   * Read the persistent source identity for every published home.
   * @returns {Array<{id: string, label: string, path: string, kind: string}>}
   */
  publishedUsageHomes() {
    if (!this.database) throw new TypeError("UsageStore is not open");
    return publishedUsageHomesFromDatabase(this.database);
  }

  /**
   * Read one session carrier per (home_id, session_id) from published facts.
   * The last event in timestamp/id order supplies channel, cwd, and model.
   * @returns {Array<{
   *   id: string,
   *   homeId: string,
   *   homeLabel: string,
   *   homePath: string,
   *   firstAt: string,
   *   lastAt: string,
   *   eventCount: number,
   *   total: import("./usage-types.js").UsageTotals,
   *   channel: string,
   *   cwd: string,
   *   model: string
   * }>}
   */
  publishedUsageSessions() {
    if (!this.database) throw new TypeError("UsageStore is not open");
    return publishedUsageSessionsFromEvents(this.publishedUsageEvents(), this.publishedUsageHomes());
  }

  /**
   * Read the complete historical report from one hot snapshot plus verified
   * cold segments. Hot homes and quota are captured before cold reads start.
   * @param {{ includePerfCarrier?: boolean }} [options]
   * @returns {Promise<{
   *   events: import("./usage-types.js").UsageEvent[],
   *   homes: Array<{ id: string, label: string, path: string, kind: string }>,
   *   sessions: ReturnType<UsageStore["publishedUsageSessions"]>,
   *   rateLimitObservations: import("./usage-types.js").RateLimitObservation[],
   *   perfCarrier?: any
   * }>}
   */
  async publishedHistoryUsageReport({ includePerfCarrier = false } = {}) {
    const union = await this.historyArchiveEventUnionForRange(undefined, {
      completeHistory: true,
      includeUsageCarrier: true,
      includePerfCarrier,
    });
    const events = publishedUsageEventsFromUnion(union, this.serviceTierEvidence, this.quotaSourceFor.bind(this));
    const homes = union.homes ?? [];
    return {
      events,
      homes,
      sessions: publishedUsageSessionsFromEvents(events, homes),
      rateLimitObservations: union.rateLimitObservations ?? [],
      ...(union.perfCarrier === undefined ? {} : { perfCarrier: union.perfCarrier }),
    };
  }

  /**
   * Read the complete published carrier under one SAVEPOINT snapshot.
   * @returns {{
   *   events: import("./usage-types.js").UsageEvent[],
   *   homes: Array<{ id: string, label: string, path: string, kind: string }>,
   *   sessions: ReturnType<UsageStore["publishedUsageSessions"]>,
   *   rateLimitObservations: import("./usage-types.js").RateLimitObservation[]
   * }}
   */
  publishedUsageReport() {
    if (!this.database) throw new TypeError("UsageStore is not open");
    this.database.exec("SAVEPOINT published_usage_report_read");
    try {
      const report = {
        events: this.publishedUsageEvents(),
        homes: this.publishedUsageHomes(),
        sessions: this.publishedUsageSessions(),
        rateLimitObservations: this.quotaObservations({ useCache: false }),
      };
      this.database.exec("RELEASE published_usage_report_read");
      return report;
    } catch (error) {
      this.database.exec("ROLLBACK TO published_usage_report_read");
      this.database.exec("RELEASE published_usage_report_read");
      throw error;
    }
  }

  groupedRange(column, range, orderBy = "total DESC", excludeHomes = []) {
    const allowedColumns = new Set([
      "channel",
      "home_label",
      "model",
      "project",
      "hour_key",
      "day_key",
      "week_key",
      "month_key",
    ]);
    if (!allowedColumns.has(column)) {
      throw new Error(`不支持的聚合字段：${column}`);
    }
    const dimension =
      column === "model"
        ? "usage_model_group(model)"
        : column === "channel" && !isQuotaPreset(range.preset) && !range.quotaWindow && !range.quotaPreset
          ? "usage_source_group(channel, (SELECT kind FROM source_files WHERE path = events.source_path))"
          : column;
    const scope = scopeFilterSql(excludeHomes);
    const where = eventRangeScope(range, scope);
    const rows = this.database
      .prepare(`
        SELECT
          ${dimension} AS key,
          COUNT(*) AS count,
          COUNT(DISTINCT session_id) AS sessions,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM events
        WHERE ${where.sql}
        GROUP BY ${dimension}
        ORDER BY ${orderBy}
      `)
      .all(...where.params);
    return rows.map((row) => ({
      key: row.key,
      name: row.key,
      count: Number(row.count || 0),
      sessions: Number(row.sessions || 0),
      total: usageFromRow(row),
    }));
  }

  /** @param {import("./usage-types.js").UsageRange} range
   * @returns {Generator<import("./usage-types.js").IndexedCostEvent>}
   */
  *costEventsForRange(range, excludeHomes = [], includeRepositories = false) {
    const scope = scopeFilterSql(excludeHomes);
    const where = eventRangeScope(range, scope);
    const columns = includeRepositories
      ? `${COST_EVENT_COLUMNS}, repository_key, repository_path, repository_kind, cwd, reconciliation_gap`
      : COST_EVENT_COLUMNS;
    const statement = this.database.prepare(`SELECT ${columns} FROM events WHERE ${where.sql}`);
    const sourceKinds = homeSourceKinds(this.homes);
    if (typeof statement.setReturnArrays === "function") {
      statement.setReturnArrays(true);
      for (const row of statement.iterate(...where.params)) {
        const event = costEventFromRowArray(row, this.serviceTierEvidence, sourceKinds.get(String(row[2])));
        if (includeRepositories) {
          event.repositoryKey = String(row[20]);
          event.repositoryPath = String(row[21]);
          event.repositoryKind = String(row[22]);
          event.cwd = String(row[23]);
          event.reconciliationGap = Number(row[24]);
        }
        yield event;
      }
      return;
    }
    for (const row of statement.iterate(...where.params)) {
      const event = costEventFromRow(row, this.serviceTierEvidence, sourceKinds.get(String(row.home_id)));
      if (includeRepositories) {
        event.repositoryKey = String(row.repository_key);
        event.repositoryPath = String(row.repository_path);
        event.repositoryKind = String(row.repository_kind);
        event.cwd = String(row.cwd);
        event.reconciliationGap = Number(row.reconciliation_gap);
      }
      yield event;
    }
  }

  /** @param {import("./usage-types.js").UsageRange} range */
  costEstimateRange(range, excludeHomes = []) {
    return this.withEventCostMemoRound(() =>
      estimateCostForEvents(this.costEventsForRange(range, excludeHomes), {
        estimateEventCost: (event) => this.eventCostMemo.estimate(event),
      }),
    );
  }

  /**
   * W4-b1 / D1：把一段"逐事件计价"包成 memo 的**一轮**。
   *
   * 轮内放宽到 `hardMaxBytes`（192 MiB），保证"本轮的中间结果"不会因为刚好越线而被立刻逐出；
   * 轮末收敛回 `maxBytes`（64 MiB）。可嵌套（深度计数）—— 一次 `summarize` 会同时进入
   * `buildRecordChampions` 与 `timelineRange`。
   * @template T
   * @param {() => T} run
   * @returns {T}
   */
  withEventCostMemoRound(run) {
    this.eventCostMemo.beginRound();
    try {
      return run();
    } finally {
      this.eventCostMemo.endRound();
    }
  }

  /** @param {import("./usage-types.js").UsageRange} range
   * @param {string} bucket
   * @param {{ onEstimate?: (event: any, estimate: any, bucketKey?: string) => void, excludeHomes?: string[], pricingModels?: Record<string, any>, factRows?: any[], includeRepositories?: boolean, pricing?: ReturnType<typeof createEventPricing>, quoteInputs?: HistoryQuoteInputs }} [options]
   */
  timelineRange(
    range,
    bucket,
    { onEstimate, excludeHomes = [], pricingModels, factRows, includeRepositories = false, pricing, quoteInputs } = {},
  ) {
    // Quote replay uses the same price and timeline accumulators as the original streaming read.
    return this.withEventCostMemoRound(() =>
      buildTimelineRows(
        quoteInputs ? quoteInputs.events() : this.costEventsForRange(range, excludeHomes, includeRepositories),
        range,
        bucket,
        {
          sourceKinds: homeSourceKinds(this.homes),
          pricingModels,
          factRows,
          eventBucketKey: quoteInputs ? (event) => event.quoteBucketKey : undefined,
          modelName: pricing?.modelName,
          estimateCost: pricing?.estimate ?? estimateEventCost,
          onEstimate,
        },
      ),
    );
  }

  repositoriesRange(range, excludeHomes = []) {
    const scope = scopeFilterSql(excludeHomes);
    const where = eventRangeScope(range, scope);
    const rows = this.database
      .prepare(`
        SELECT
          repository_key AS key,
          MIN(repository_path) AS name,
          MAX(repository_kind) AS kind,
          COUNT(DISTINCT NULLIF(cwd, '')) AS path_count,
          COUNT(*) AS count,
          COUNT(DISTINCT session_id) AS sessions,
          json_group_array(DISTINCT session_id) AS session_ids,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM events
        WHERE ${where.sql}
        GROUP BY repository_key
        ORDER BY total DESC, name ASC
      `)
      .all(...where.params);
    const orderedSessions = this.verifiedHistorySqlRead ? this.historyRepositorySessionOrder(where) : undefined;
    return rows.map((row) => ({
      key: row.key,
      name: row.name,
      kind: row.kind,
      pathCount: Number(row.path_count || 0),
      count: Number(row.count || 0),
      sessions: Number(row.sessions || 0),
      sessionIds: orderedSessions?.get(row.key) ?? JSON.parse(String(row.session_ids || "[]")),
      total: usageFromRow(row),
    }));
  }

  historyRepositorySessionOrder(where, firsts = null) {
    firsts ??= this.database
      .prepare(`
      SELECT repository_key, session_id, MIN(timestamp_ms) AS first_ms FROM events
      WHERE ${where.sql} GROUP BY repository_key, session_id ORDER BY repository_key, first_ms
    `)
      .all(...where.params);
    const tieRows = this.database.prepare(`
      SELECT * FROM (SELECT * FROM history_hot.events UNION ALL SELECT * FROM main.events)
      WHERE repository_key = ? AND timestamp_ms = ? AND ${where.sql}
    `);
    const orderedSessions = new Map();
    for (let first = 0; first < firsts.length; ) {
      let end = first + 1;
      const row = firsts[first];
      while (
        end < firsts.length &&
        firsts[end].repository_key === row.repository_key &&
        firsts[end].first_ms === row.first_ms
      )
        end++;
      const group = firsts.slice(first, end);
      if (group.length > 1) {
        const payloads = new Map();
        for (const event of tieRows.iterate(row.repository_key, row.first_ms, ...where.params)) {
          const payload = JSON.stringify(canonicalFactPayload(event, ["id"]));
          if (!payloads.has(event.session_id) || payload < payloads.get(event.session_id))
            payloads.set(event.session_id, payload);
        }
        group.sort((left, right) => {
          const a = payloads.get(left.session_id),
            b = payloads.get(right.session_id);
          return a < b ? -1 : a > b ? 1 : 0;
        });
      }
      const sessions = orderedSessions.get(row.repository_key) || [];
      for (const entry of group) sessions.push(entry.session_id);
      orderedSessions.set(row.repository_key, sessions);
      first = end;
    }
    return orderedSessions;
  }

  periodAggregate(groupColumn, nameColumn, _now, ranges, options = {}) {
    const pricingModels = options.pricingModels ?? getPricingCatalog().models;
    const previousPricingModels = this.readPricingModels;
    this.readPricingModels = pricingModels;
    try {
      return this.periodAggregateCore(groupColumn, nameColumn, _now, ranges, options);
    } finally {
      this.readPricingModels = previousPricingModels;
    }
  }

  periodAggregateCore(groupColumn, nameColumn, _now, ranges, { includeKind = false, excludeHomes = [] } = {}) {
    const modelDimension = groupColumn === "model" && nameColumn === "model" && !includeKind;
    const dimensionKey = modelDimension ? "usage_model_group(model)" : groupColumn;
    const dimensionName = modelDimension ? dimensionKey : nameColumn;
    const dimensions = dimensionKey
      ? `${dimensionKey} AS dimension_key, ${includeKind ? `MIN(${nameColumn}) AS dimension_name, MIN(repository_kind) AS dimension_kind, COUNT(DISTINCT NULLIF(cwd, '')) AS path_count` : `${dimensionName} AS dimension_name`},`
      : "";
    const fields = [
      ["total", "total"],
      ["input", "CASE WHEN (detail_mask & 1) != 0 THEN input ELSE 0 END"],
      ["inputUnavailableTokens", "CASE WHEN (detail_mask & 1) = 0 THEN total ELSE 0 END"],
      ["cached", "CASE WHEN (detail_mask & 2) != 0 THEN cached ELSE 0 END"],
      ["cachedUnavailableTokens", "CASE WHEN (detail_mask & 2) = 0 THEN total ELSE 0 END"],
      ["uncachedInput", "CASE WHEN (detail_mask & 3) = 3 THEN MAX(input - cached, 0) ELSE 0 END"],
      ["uncachedInputUnavailableTokens", "CASE WHEN (detail_mask & 3) != 3 THEN total ELSE 0 END"],
      ["cacheRateInput", "CASE WHEN (detail_mask & 3) = 3 THEN input ELSE 0 END"],
      ["cacheRateCached", "CASE WHEN (detail_mask & 3) = 3 THEN cached ELSE 0 END"],
      ["output", "CASE WHEN (detail_mask & 4) != 0 THEN output ELSE 0 END"],
      ["outputUnavailableTokens", "CASE WHEN (detail_mask & 4) = 0 THEN total ELSE 0 END"],
      ["reasoning", "CASE WHEN (detail_mask & 8) != 0 THEN reasoning ELSE 0 END"],
      ["reasoningUnavailableTokens", "CASE WHEN (detail_mask & 8) = 0 THEN total ELSE 0 END"],
      ["unattributedDetailTokens", "CASE WHEN (detail_mask & 15) != 15 THEN total ELSE 0 END"],
      ["inconsistentTokens", "CASE WHEN (detail_mask & 16) != 0 THEN total ELSE 0 END"],
      ["reconciliationGap", "reconciliation_gap"],
    ];
    if (modelDimension) {
      this.database.exec("SAVEPOINT period_model_rollup");
      try {
        const bounds = this.eventBounds(excludeHomes);
        if (bounds.minimum === null) {
          this.database.exec("RELEASE period_model_rollup");
          return [];
        }

        const minimum = Number(bounds.minimum);
        const maximum = Number(bounds.maximum);
        const sourceEndMs = maximum + 1;
        const windows = {};
        let valid = Number.isSafeInteger(sourceEndMs);
        for (const period of COMPARISON_PERIOD_KEYS) {
          const range = ranges[period] || {};
          const startMs = range.start == null ? minimum : range.start instanceof Date ? range.start.getTime() : NaN;
          const endMs = range.end == null ? maximum : range.end instanceof Date ? range.end.getTime() : NaN;
          const endExclusiveMs = endMs + 1;
          if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endExclusiveMs) || startMs > endExclusiveMs) {
            valid = false;
            break;
          }
          // Only complete days inside the scoped fact range may require rollup markers.
          const clampedStartMs = Math.max(startMs, minimum);
          const clampedEndMs = Math.min(endExclusiveMs, sourceEndMs);
          windows[period] = clampedStartMs < clampedEndMs ? { startMs: clampedStartMs, endMs: clampedEndMs } : null;
        }

        if (valid) {
          const models = new Map();
          const emptyPeriod = () => Object.fromEntries(fields.map(([field]) => [field, 0]));
          const modelResult = (model) => {
            let result = models.get(model);
            if (!result) {
              result = {
                key: model,
                name: model,
                periods: Object.fromEntries(COMPARISON_PERIOD_KEYS.map((key) => [key, emptyPeriod()])),
              };
              models.set(model, result);
            }
            return result;
          };
          // Seed models that the requested period windows do not touch.
          if (!windows.all || windows.all.startMs > minimum || windows.all.endMs < sourceEndMs) {
            const sourceRows = queryUsageRollupModelsWindow(this.database, {
              startMs: minimum,
              endMs: sourceEndMs,
              excludeHomes,
              canonicalModels: true,
            });
            for (const row of sourceRows) modelResult(row.model);
          }
          for (const period of COMPARISON_PERIOD_KEYS) {
            const window = windows[period];
            if (!window) continue;
            const rows = queryUsageRollupModelsWindow(this.database, {
              ...window,
              excludeHomes,
              canonicalModels: true,
            });
            for (const row of rows) {
              const result = modelResult(row.model);
              result.periods[period] = Object.fromEntries(fields.map(([field]) => [field, Number(row[field] || 0)]));
            }
          }
          this.database.exec("RELEASE period_model_rollup");
          return [...models.values()].sort(
            (left, right) =>
              right.periods.all.total - left.periods.all.total ||
              (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
          );
        }
        this.database.exec("RELEASE period_model_rollup");
      } catch (error) {
        this.database.exec("ROLLBACK TO period_model_rollup");
        this.database.exec("RELEASE period_model_rollup");
        if (error?.code !== "ROLLUP_DAYS_MISSING") throw error;
      }
    }
    const scope = scopeFilterSql(excludeHomes);
    const where = scope.sql ? ` WHERE ${scope.sql}` : "";
    const groupBy = dimensionKey ? ` GROUP BY ${dimensionKey}` : "";
    const orderBy = dimensionKey ? " ORDER BY all__total DESC, dimension_name ASC" : "";
    let rows;
    this.database.exec("SAVEPOINT period_interval_pruning");
    try {
      const bounds = this.eventBounds(excludeHomes);
      const minimum = bounds.minimum === null ? null : Number(bounds.minimum);
      const maximum = bounds.maximum === null ? null : Number(bounds.maximum);
      const parameters = [];
      const measures = [];
      for (const period of COMPARISON_PERIOD_KEYS) {
        const range = ranges[period] || {};
        const start = range.start == null ? null : range.start instanceof Date ? range.start.getTime() : undefined;
        const end = range.end == null ? null : range.end instanceof Date ? range.end.getTime() : undefined;
        const empty =
          minimum === null ||
          (start !== undefined && end !== undefined && start !== null && end !== null && start > end) ||
          (start !== undefined && start !== null && start > maximum) ||
          (end !== undefined && end !== null && end < minimum);
        const coversAll =
          !empty &&
          start !== undefined &&
          end !== undefined &&
          (start === null || start <= minimum) &&
          (end === null || end >= maximum);
        for (const [field, expression] of fields) {
          if (empty) {
            measures.push(`COALESCE(SUM(0), 0) AS "${period}__${field}"`);
          } else if (coversAll) {
            measures.push(`COALESCE(SUM(${expression}), 0) AS "${period}__${field}"`);
          } else {
            measures.push(
              `COALESCE(SUM(CASE WHEN (? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?) THEN ${expression} ELSE 0 END), 0) AS "${period}__${field}"`,
            );
            parameters.push(...rangeParameters(range));
          }
        }
      }
      const select = `SELECT ${dimensions} ${measures.join(", ")} FROM events`;
      rows = this.database.prepare(`${select}${where}${groupBy}${orderBy}`).all(...parameters, ...scope.params);
      this.database.exec("RELEASE period_interval_pruning");
    } catch (error) {
      this.database.exec("ROLLBACK TO period_interval_pruning");
      this.database.exec("RELEASE period_interval_pruning");
      throw error;
    }
    return rows.map((row) => {
      const result = {
        key: dimensionKey ? String(row.dimension_key) : "all",
        name: dimensionKey ? String(row.dimension_name) : "全部",
        periods: Object.fromEntries(
          COMPARISON_PERIOD_KEYS.map((period) => [
            period,
            Object.fromEntries(fields.map(([field]) => [field, Number(row[`${period}__${field}`] || 0)])),
          ]),
        ),
      };
      if (includeKind) {
        result.kind = row.dimension_kind;
        result.pathCount = Number(row.path_count || 0);
      }

      return result;
    });
  }

  periodComparison(options = {}) {
    // D1：读路径先对齐修订（外部提交在这里被检出 ⇒ 缓存失效 + 必要元数据重载）。
    const snapshotRead = this.periodComparisonSnapshotRead;
    if (!snapshotRead) this.syncDerivedRevision();
    // D1：写事务内**不读也不写**共享缓存（读到的是未提交状态 ⇒ 回滚后它会说谎）。
    const cacheable = this.writeTransactionDepth === 0;
    const now = options.now ? new Date(options.now) : new Date();
    const excludeHomes = options.excludeHomes || [];
    const zone = options.calendarZone === "utc" ? "utc" : "local";
    const pricingModels = options.pricingModels ?? getPricingCatalog().models;
    const cacheKey = periodComparisonKey(now, zone, excludeHomes, pricingModels);
    const cached = cacheable ? this.periodComparisonCache.get(cacheKey) : undefined;
    if (cached) return { ...structuredClone(cached), asOf: now.toISOString() };
    const bounds = this.eventBounds(excludeHomes);
    const timestamps =
      bounds.minimum === null
        ? []
        : [
            { timestamp: new Date(Number(bounds.minimum)).toISOString() },
            { timestamp: new Date(Number(bounds.maximum)).toISOString() },
          ];
    const ranges = Object.fromEntries(
      COMPARISON_PERIOD_KEYS.map((key) => [
        key,
        resolveDateRange({ preset: key, now, calendarZone: zone }, timestamps),
      ]),
    );
    const models = this.periodAggregate("model", "model", now, ranges, { excludeHomes, pricingModels });
    const totals = models.length
      ? Object.fromEntries(
          COMPARISON_PERIOD_KEYS.map((period) => {
            const periodTotals = {};
            for (const model of models) {
              for (const [field, value] of Object.entries(model.periods[period])) {
                periodTotals[field] = (periodTotals[field] || 0) + value;
              }
            }
            return [period, periodTotals];
          }),
        )
      : this.periodAggregate(null, null, now, ranges, { excludeHomes, pricingModels })[0].periods;
    // shortcut: a new calendar scope uses SQL until facts rebuild; fuse it only if that fallback becomes costly.
    const repositoryProjection = cacheable ? this.summaryProjectionCache?.projection.repositoryPeriods : null;
    const value = {
      periods: COMPARISON_PERIOD_KEYS.map((key) => ({
        key,
        start: ranges[key].start?.toISOString() || null,
        end: ranges[key].end?.toISOString() || null,
      })),
      totals,
      models,
      repositories:
        repositoryProjection?.key === cacheKey
          ? repositoryProjection.rows
          : this.periodAggregate("repository_key", "repository_path", now, ranges, {
              includeKind: true,
              excludeHomes,
              pricingModels,
            }),
    };
    // D1：只有**不在写事务里**才写共享缓存（写事务内的结果只用于本次调用）。
    if (cacheable) {
      this.periodComparisonCache.clear();
      this.periodComparisonCache.set(cacheKey, value);
    }
    return { ...structuredClone(value), asOf: now.toISOString() };
  }

  /**
   * Explicit cold-aware period comparison. Without an authority marker this
   * pins the marker and synchronous hot-only cached read in one savepoint; with
   * authority it uses the verified complete event carrier and shared algorithm.
   * @param {{ now?: string | Date, calendarZone?: string, excludeHomes?: string[], pricingModels?: Record<string, any> }} [options]
   */
  async periodComparisonHistory(options = {}) {
    await this.open();
    this.syncDerivedRevision();
    let hasAuthority = false;
    // 无 authority 时，marker 与首次 period 读取必须共享同一 SQLite 读快照。
    // 快照内不再探测外部提交；缓存仍记在快照前的修订上，下一轮会按 data_version 失效。
    this.database.exec("SAVEPOINT period_comparison_history_read");
    try {
      hasAuthority = Boolean(
        this.database.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META),
      );
      if (!hasAuthority) {
        this.periodComparisonSnapshotRead = true;
        try {
          return this.periodComparison(options);
        } finally {
          this.periodComparisonSnapshotRead = false;
        }
      }
    } finally {
      this.database.exec("RELEASE period_comparison_history_read");
    }
    const events = await this.publishedHistoryUsageEvents();
    const excludedHomeIds = new Set((options.excludeHomes || []).map(String));
    const pricingModels = options.pricingModels ?? getPricingCatalog().models;
    return summarizePeriodComparison(
      excludedHomeIds.size === 0 ? events : events.filter((event) => !excludedHomeIds.has(event.homeId)),
      { ...options, pricingModels },
    );
  }

  // New Record：对日/周/月三种自然周期求各指标的历史最高期（严格新高、至少两期可比），
  // 只有纪录期完整落在所选范围内时才计为“在所选时间范围创下”。
  /**
   * D2：**完整 scope 的历史冠军**与“纪录期是否完整落在当前范围”**分离**。
   *
   * 为什么能分离：冠军只在**全历史**上选（SQL 的 `where` 只来自 `excludeHomes`，`range` **从不**
   * 进入 WHERE）⇒ 冠军选择与 `range` 无关；`range` 只参与 `recordsWithinRange()` 里的包含判定。
   *
   * memo = **一条**（单槽，不是 Map、不是框架、不落盘），键是**六项**输入的身份：
   *   ① 数据修订（D1 的 `storeRevision`，由 `syncDerivedRevision()` 对齐）
   *   ② 价目目录版本（`getPricingCatalog().version`）
   *   ③ `usdToCnyRate`
   *   ④ service-tier evidence 的输入签名（与 `serviceTierEvidenceInput` 同口径）
   *   ⑤ 时区（`range.calendarZone`：`local` / `utc`）
   *   ⑥ **规范化后的排除集合**（`excludeHomes` 去重 + 排序）
   * 改变任一项 ⇒ 键不等 ⇒ **立即重算**。失效**不靠 TTL、不靠新事件总线**：数据侧由 D1 的修订
   * 前进驱动，价目 / 汇率由 `getPricingCatalog()` 驱动。
   *
   * ⚠️ **遵守 D1 的写事务门**：`writeTransactionDepth > 0` 时读到的是**未提交**状态 ⇒
   * **不读也不写**这条 memo，只在本次调用内算局部值（与 `metadata()` / `periodComparison()` 同款）。
   * @param {import("./usage-types.js").UsageRange} range
   */
  recordsForRange(range, excludeHomes = []) {
    // D2：读路径先对齐修订（外部提交在这里被检出 ⇒ 数据侧输入立即失效），与 metadata()/periodComparison() 同款。
    this.syncDerivedRevision();
    // D2 复用 D1 的门：写事务内不读也不写共享 memo。
    const cacheable = this.writeTransactionDepth === 0;
    const zone = range.calendarZone === "utc" ? "utc" : "local";
    const scope = scopeFilterSql(excludeHomes);
    const where = scope.sql ? `WHERE ${scope.sql}` : "";
    const catalog = getPricingCatalog();
    const rate = Number(catalog.usdToCnyRate);
    const usdToCnyRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    // ⑥ 规范排除集合：`NOT IN (…)` 与顺序、重复无关 ⇒ 去重 + 排序后作为 memo 键的一部分。
    const canonicalExcludedHomes = [...new Set((excludeHomes || []).map((value) => String(value)).filter(Boolean))]
      .sort()
      .join("\u0000");
    const memoKey = [
      `data-revision\u0000${this.storeRevision}`,
      `pricing-catalog\u0000${String(catalog.version ?? "")}`,
      `usd-to-cny-rate\u0000${usdToCnyRate}`,
      `service-tier-evidence\u0000${this.serviceTierEvidenceInput === null ? "<unsynced>" : this.serviceTierEvidenceInput}`,
      `calendar-zone\u0000${zone}`,
      `excluded-homes\u0000${canonicalExcludedHomes}`,
    ].join("\u0001");
    const memoized = cacheable && this.recordChampionCache?.key === memoKey ? this.recordChampionCache.champions : null;
    // Price the full-history scan through one request-local model dictionary.
    // This keeps the estimator and unknown-value semantics unchanged while
    // avoiding per-row model normalization and event-memo key construction.
    const champions =
      memoized ??
      (() => {
        const eventPricing = createEventPricing();
        return this.buildRecordChampions(zone, where, scope.params, usdToCnyRate, (event) =>
          eventPricing.estimate(event),
        );
      })();
    if (cacheable && memoized === null) this.recordChampionCache = { key: memoKey, champions };
    return this.recordsWithinRange(champions, range, zone);
  }

  /**
   * D2：`recordsForRange` 的**与 `range` 无关**的那一半 —— 全历史扫描（逐事件计价 + 日/周/月
   * 三种自然周期的槽位累加）与**冠军选择**（“至少两期可比” + **严格**新高）。
   *
   * 返回值：`{ day|week|month: { [metric]: { period, value } } }`。某个指标在该周期单位上
   * **没有**严格新高（含**并列**、期数不足两期）时该键**缺失** —— 即“平局不点亮”。
   * 冠军期的**范围包含判定不在这里**（见 `recordsWithinRange`）。
   */
  buildRecordChampions(zone, where, params, usdToCnyRate, estimateEventCost = DEFAULT_EVENT_COST_ESTIMATOR) {
    const periods = emptyRecordPeriods();

    // Record ranking scans the full scoped history. Its pricing projection is
    // intentionally smaller: estimates use the active catalog and do not read
    // stored price_version or repository display fields. session_id remains
    // necessary to resolve service-tier evidence.
    const statement = this.database.prepare(`
      SELECT timestamp_ms, day_key, week_key, month_key, session_id, model, channel, home_id,
        total, input, cached, output, reasoning, detail_mask, cache_write_tokens,
        cache_write_known, request_input_tokens, context_level, service_tier
      FROM events ${where}
    `);
    // W4-b1 / D1：逐行计价走**注入**的 `estimateEventCost`（默认仍是模块函数；`recordsForRange`
    // 注入 memo）。为什么用注入而不是在这里直接写 `this.eventCostMemo.estimate`：**不改变**共享门禁
    // （`tools/lib/instrument.mjs`）锚定的那两行源码形状 —— 锚点是"共享期望值文件"，改它要单列一节
    // 并做双向失败语义证明（见 W4-b1 报告 §共享门禁）；注入式改动**零锚点变更**。
    const sourceKinds = homeSourceKinds(this.homes);
    for (const row of statement.iterate(...params)) {
      const estimate = estimateEventCost({
        timestamp: Number(row.timestamp_ms),
        model: String(row.model),
        sourceKind: sourceKinds.get(String(row.home_id)),
        channel: String(row.channel),
        detailMask: Number(row.detail_mask || 0),
        cacheWriteTokens: Number(row.cache_write_tokens || 0),
        cacheWriteKnown: Boolean(row.cache_write_known),
        requestInputTokens: Number(row.request_input_tokens || 0),
        contextLevel: row.context_level,
        serviceTier:
          this.serviceTierEvidence?.resolve(
            String(row.session_id),
            Number(row.timestamp_ms),
            String(row.service_tier),
          ) || String(row.service_tier),
        total: {
          total: Number(row.total || 0),
          input: Number(row.input || 0),
          cached: Number(row.cached || 0),
          output: Number(row.output || 0),
          reasoning: Number(row.reasoning || 0),
        },
      });
      accumulateRecordEstimate(
        periods,
        {
          timestampMs: Number(row.timestamp_ms),
          sessionId: row.session_id,
          model: row.model,
          total: usageFromRow(row),
          estimate,
          storedKeys: {
            day: row.day_key,
            week: row.week_key,
            month: row.month_key,
          },
        },
        zone,
        usdToCnyRate,
      );
    }

    // ── 冠军选择（**与 `range` 无关**）：严格新高 + 至少两期可比 ─────────────────────────────
    return rankRecordChampions(periods);
  }

  buildRecordChampionsFromEvents(events, zone, usdToCnyRate) {
    const periods = emptyRecordPeriods();
    for (const event of events) {
      const timestampMs = Date.parse(event.timestamp);
      if (!Number.isFinite(timestampMs)) continue;
      accumulateRecordEstimate(
        periods,
        {
          timestampMs,
          sessionId: event.sessionId,
          model: event.model,
          total: event.total,
          estimate: this.eventCostMemo.estimate(event),
        },
        zone,
        usdToCnyRate,
      );
    }
    return rankRecordChampions(periods);
  }

  recordsForHistoryEvents(events, range) {
    const zone = range.calendarZone === "utc" ? "utc" : "local";
    const rate = Number(getPricingCatalog().usdToCnyRate);
    const usdToCnyRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    const champions = this.withEventCostMemoRound(() =>
      this.buildRecordChampionsFromEvents(events, zone, usdToCnyRate),
    );
    return this.recordsWithinRange(champions, range, zone);
  }

  /**
   * D2：`recordsForRange` 的**与 `range` 有关**的那一半 —— 只做“冠军期是否**完整**落在所选
   * 范围内”的包含判定（日/周/月的边界由 `recordUnitBoundaries` 给出），并按
   * `day → week → month` 取**第一个**被包含的单位（逐字保持原先的优先级与 `break`）。
   */
  recordsWithinRange(champions, range, zone) {
    const rangeStartMs = range?.start ? range.start.getTime() : null;
    const rangeEndMs = range?.end ? range.end.getTime() : null;
    const records = {};
    for (const [metric, definition] of Object.entries(RECORD_METRICS)) {
      for (const unit of ["day", "week", "month"]) {
        const champion = champions[unit][metric];
        if (!champion) continue;
        const boundaries = recordUnitBoundaries(champion.period, unit, zone);
        if (!boundaries) continue;
        const [periodStart, periodEnd] = boundaries;
        if (rangeStartMs !== null && periodStart < rangeStartMs) continue;
        if (rangeEndMs !== null && periodEnd - 1 > rangeEndMs) continue;
        records[metric] = {
          title: `${definition.title}的${RECORD_UNIT_LABELS[unit]}`,
          unit,
          period: champion.period,
          value: champion.value,
        };
        break;
      }
    }
    return records;
  }

  summarize(filters = {}, options = {}) {
    this.database.exec("BEGIN");
    const previousTransferable = this.summaryProjectionTransferableRead;
    this.summaryProjectionTransferableRead = true;
    try {
      const summary = this.summarizeInReadTransaction(filters, options);
      this.database.exec("COMMIT");
      return summary;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.summaryProjectionTransferableRead = previousTransferable;
    }
  }

  registerReadFunctions() {
    this.database.function("usage_quota_allowed", (model, homeId, sessionId, time) =>
      Number(
        isQuotaUsage({ model, quotaSource: this.quotaSourceFor(String(homeId), String(sessionId), Number(time)) }),
      ),
    );
    this.database.function("usage_source_group", (channel, kind) => sourceGroup(channel, String(kind ?? "")));
    this.database.function("usage_model_group", (model) =>
      canonicalModelName(String(model ?? ""), this.readPricingModels),
    );
  }

  quotaSourceFor(homeId, sessionId, time) {
    if (this.quotaSourceRevision !== this.storeRevision) {
      const rows = this.database
        .prepare("SELECT home_id, session_id, timestamp_ms, quota_source, until_ms FROM quota_usage_sources")
        .all();
      this.quotaSourceLookup = quotaSourceResolver(
        rows.map((row) => ({
          homeId: String(row.home_id),
          sessionId: String(row.session_id),
          timestampMs: Number(row.timestamp_ms),
          quotaSource: String(row.quota_source),
          quotaSourceUntil: Number(row.until_ms),
        })),
        this.quotaSourceEvidence,
      );
      this.quotaSourceRevision = this.storeRevision;
    }
    return this.quotaSourceLookup(homeId, sessionId, time);
  }

  /** SQL fast path for one unchanged event segment; other scopes retain the complete carrier. */
  async trySqlHistoryDashboard(filters, options, periodOptions) {
    const hot = this.database;
    // shortcut: pinned/writing readers, overlays and multiple segments use the existing carrier until SQL parity covers them.
    if (filters.preset !== "all" || hot.isTransaction !== false || this.writeTransactionDepth > 0) return null;
    const records = hot.prepare("SELECT * FROM archive_segments").all();
    const authorized = historyArchiveAuthorizedSegmentIds(hot);
    if (records.length !== 1 || authorized.size !== 1 || !authorized.has(String(records[0].segment_id))) return null;
    if (
      hot
        .prepare("SELECT 1 FROM store_meta WHERE key IN (?, ?, ?)")
        .get(
          HISTORY_ARCHIVE_EVENT_REVISIONS_META,
          HISTORY_ARCHIVE_PERF_REVISIONS_META,
          HISTORY_ARCHIVE_PERF_AUTHORITY_META,
        )
    )
      return null;
    const input = JSON.stringify(historyArchivePerfRevisionInputVersion(hot));
    const record = records[0];
    const { withVerifiedHistoryArchiveCandidate } = await import("./history-archive.js");
    return withVerifiedHistoryArchiveCandidate(String(record.database_path), undefined, (database, verified) => {
      assertHistoryArchiveRecordMatches(record, verified);
      const coldSources = historyArchiveSourceIdentities(database, Number(record.start_ms), Number(record.end_ms));
      const sourceCount = Number(database.prepare("SELECT COUNT(DISTINCT source_path) AS n FROM events").get().n);
      if (sourceCount !== coldSources.length) {
        throw historyArchiveError("HISTORY_ARCHIVE_HOT_COLD_CONFLICT", "archive source identities are incomplete");
      }
      database.prepare("ATTACH DATABASE ? AS history_hot").run(`${pathToFileURL(this.databaseFile).href}?mode=ro`);
      // Pin the hot revision only for the synchronous SQL consumer, never across file-hash awaits.
      database.prepare("SELECT value FROM history_hot.store_meta LIMIT 1").get();
      if (this.database !== hot) {
        throw historyArchiveError("HISTORY_ARCHIVE_READ_CLOSED", "usage store closed during archive verification");
      }
      if (
        hot.isTransaction !== false ||
        this.writeTransactionDepth > 0 ||
        JSON.stringify(historyArchivePerfRevisionInputVersion(hot)) !== input
      )
        return null;
      if (
        database
          .prepare("SELECT 1 FROM history_hot.events WHERE timestamp_ms >= ? AND timestamp_ms < ? LIMIT 1")
          .get(record.start_ms, record.end_ms)
      ) {
        throw historyArchiveError("HISTORY_ARCHIVE_HOT_COLD_CONFLICT", "authorized archive still has hot facts");
      }
      const liveSource = database.prepare(
        "SELECT path, kind, home_id, home_label, home_path FROM history_hot.source_files WHERE path = ?",
      );
      for (const source of coldSources) {
        const live = liveSource.get(source.path);
        if (!live || JSON.stringify({ ...live }) !== JSON.stringify(source)) {
          throw historyArchiveError("HISTORY_ARCHIVE_HOT_COLD_CONFLICT", "live archive source identity changed");
        }
      }
      const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;
      const columns = database.prepare("PRAGMA history_hot.table_info(events)").all();
      const shape = (rows) => JSON.stringify(rows.map(({ name, type }) => [name, type]));
      if (shape(columns) !== shape(database.prepare("PRAGMA main.table_info(events)").all())) return null;
      const projection = columns
        .map(({ name }) =>
          name === "project" ? "CASE WHEN cwd = '' THEN 'Unknown cwd' ELSE cwd END AS project" : quote(name),
        )
        .join(",");
      for (const { name } of database
        .prepare("SELECT name FROM history_hot.sqlite_master WHERE type = 'table'")
        .all()) {
        if (name !== "events" && !String(name).startsWith("sqlite_")) {
          database.exec(`CREATE TEMP VIEW ${quote(name)} AS SELECT * FROM history_hot.${quote(name)}`);
        }
      }
      database.exec(
        `CREATE TEMP VIEW events AS SELECT ${projection} FROM history_hot.events UNION ALL SELECT ${projection} FROM main.events`,
      );
      const key = JSON.stringify([input, this.storeRevision, record, this.homes, this.warnings, this.generatedAt]);
      let reader = this.historySqlDashboardCache?.store;
      if (this.historySqlDashboardCache?.key !== key || reader?.serviceTierEvidence !== this.serviceTierEvidence) {
        reader?.close();
        reader = new UsageStore({ databaseFile: this.databaseFile });
        this.historySqlDashboardCache = { key, store: reader };
      }
      reader.database = database;
      reader.homes = structuredClone(this.homes);
      reader.warnings = [...this.warnings];
      reader.generatedAt = this.generatedAt;
      reader.serviceTierEvidence = this.serviceTierEvidence;
      reader.quotaSourceEvidence = this.quotaSourceEvidence;
      reader.quotaSourceLookup = this.quotaSourceLookup;
      reader.quotaSourceRevision = this.quotaSourceRevision;
      reader.serviceTierEvidenceInput = this.serviceTierEvidenceInput;
      reader.storeRevision = reader.derivedRevision = this.storeRevision;
      reader.summarySnapshotRead = true;
      reader.verifiedHistorySqlRead = true;
      reader.registerReadFunctions();
      try {
        return {
          summary: reader.summarizeInReadTransaction(filters, options),
          metadata: reader.metadata(filters.now ?? new Date()),
          periodComparison: reader.periodComparison(periodOptions),
        };
      } catch (error) {
        this.historySqlDashboardCache = null;
        throw error;
      } finally {
        reader.database = null;
      }
    });
  }

  /** Build one dashboard from one verified carrier when cold event authority exists.
   * @param {any} [filters]
   * @param {any} [options]
   */
  async dashboardHistory(filters = {}, options = {}) {
    await this.open();
    this.syncDerivedRevision();
    const periodOptions = {
      now: filters.now,
      excludeHomes: filters.excludeHomes,
      calendarZone: filters.calendarZone,
      pricingModels: filters.pricingModels ?? getPricingCatalog().models,
    };
    const hasAuthority = this.database
      .prepare("SELECT 1 FROM store_meta WHERE key = ?")
      .get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META);
    if (!hasAuthority) {
      return {
        summary: await this.summarizeHistory(filters, options),
        metadata: await this.metadataHistory(filters.now),
        periodComparison: await this.periodComparisonHistory(periodOptions),
      };
    }
    const sqlDashboard = await this.trySqlHistoryDashboard(filters, options, periodOptions);
    if (sqlDashboard) return sqlDashboard;
    const union = await this.historyArchiveEventUnionForRange(undefined, {
      completeHistory: true,
      includeUsageCarrier: true,
      includePerfCarrier: true,
      includeMetadataCarrier: true,
    });
    const events = publishedUsageEventsFromUnion(union, this.serviceTierEvidence, this.quotaSourceFor.bind(this));
    const homes = union.homes ?? [];
    const report = {
      events,
      homes,
      // Dashboard session counts come from events; no session detail list is consumed.
      sessions: [],
      rateLimitObservations: union.rateLimitObservations ?? [],
      perfCarrier: union.perfCarrier,
    };
    const excluded = new Set((filters.excludeHomes || []).map(String));
    return {
      summary: this.summarizeHistoryReport(report, filters, options),
      metadata: metadataFromHistoryEvents(events, union.metadataCarrier, filters.now ?? new Date()),
      periodComparison: summarizePeriodComparison(
        excluded.size ? events.filter((event) => !excluded.has(event.homeId)) : events,
        periodOptions,
      ),
    };
  }

  /**
   * Explicit cold-aware summary. Without an authority marker this pins the
   * marker and synchronous hot summary in one savepoint; with authority it
   * summarizes the verified complete event carrier with the shared algorithm.
   * @param {object} [filters]
   * @param {{ includeDetails?: boolean }} [options]
   */
  async summarizeHistory(filters = {}, options = {}) {
    await this.open();
    this.syncDerivedRevision();
    let hasAuthority = false;
    const previousTransferable = this.summaryProjectionTransferableRead;
    const ownTransaction = !this.database.isTransaction;
    this.database.exec("SAVEPOINT summary_history_read");
    this.summaryProjectionTransferableRead = ownTransaction;
    try {
      hasAuthority = Boolean(
        this.database
          .prepare("SELECT 1 FROM store_meta WHERE key IN (?, ?)")
          .get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META, HISTORY_ARCHIVE_PERF_AUTHORITY_META),
      );
      if (!hasAuthority) {
        this.summarySnapshotRead = true;
        try {
          return this.summarizeInReadTransaction(filters, options);
        } finally {
          this.summarySnapshotRead = false;
        }
      }
    } finally {
      this.summaryProjectionTransferableRead = previousTransferable;
      this.database.exec("RELEASE summary_history_read");
    }

    const report = await this.publishedHistoryUsageReport({ includePerfCarrier: true });
    return this.summarizeHistoryReport(report, filters, options);
  }

  /**
   * Build a cold-aware summary synchronously from an already prepared complete report.
   * @param {any} report
   * @param {object} [filters]
   * @param {{ includeDetails?: boolean }} [options]
   */
  summarizeHistoryReport(report, filters = {}, options = {}) {
    let scoped = report;
    if (filters.excludeHomes?.length) {
      scoped = withoutExcludedHistoryHomes(report, filters.excludeHomes);
    }
    const summary = summarizeUsage({ ...scoped, generatedAt: this.generatedAt, warnings: this.warnings }, filters);
    const summaryWithRecords = /** @type {any} */ (summary);
    const range = /** @type {any} */ (summary.range);
    const excludeHomes = filters.excludeHomes || [];
    const quotaPreset = isQuotaPreset(range.preset) || Boolean(range.quotaWindow);
    if (range.preset === "all") {
      summaryWithRecords.records = {};
    } else if (range.quotaWindow) {
      const excludedHomeIds = new Set(
        (scoped.homes || [])
          .filter((home) => canonicalPerfSourceKind(home.kind) !== "codex")
          .map((home) => String(home.id)),
      );
      const rate = Number(getPricingCatalog().usdToCnyRate);
      const usdToCnyRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
      summaryWithRecords.records = this.withEventCostMemoRound(() =>
        quotaRecordsForRange(range, summary.quota, scoped.rateLimitObservations, (window) =>
          summarizeQuotaRecordWindow(scoped.events, window, excludedHomeIds, usdToCnyRate, (event) =>
            this.eventCostMemo.estimate(event),
          ),
        ),
      );
    } else if (!isQuotaPreset(range.preset) && !range.quotaWindow) {
      summaryWithRecords.records = this.recordsForHistoryEvents(scoped.events, {
        ...range,
        start: range.start ? new Date(range.start) : null,
        end: range.end ? new Date(range.end) : null,
      });
    }
    const perfExclusions = quotaPreset
      ? [
          ...new Set([
            ...excludeHomes,
            ...(scoped.homes || [])
              .filter((home) => canonicalPerfSourceKind(home.kind) !== "codex")
              .map((home) => String(home.id)),
          ]),
        ]
      : excludeHomes;
    // The cold awaits have finished; build only from the carrier's perf capture.
    summaryWithRecords.perf = this.buildPerfSummaryForRange(
      {
        ...range,
        start: range.start ? new Date(range.start) : null,
        end: range.end ? new Date(range.end) : null,
        windowEndExclusive: range.windowEndExclusive ? new Date(range.windowEndExclusive) : null,
      },
      perfExclusions,
      quotaPreset,
      /** @type {any} */ (report).perfCarrier,
    );
    if (options.includeDetails === false) {
      delete summary.homes;
      delete summary.projects;
      delete summary.repositories;
    }
    return summary;
  }

  /**
   * Build the indexed perf projection inside the caller's current SQLite read snapshot.
   * This method is synchronous by contract so callers cannot accidentally mix revisions.
   */
  perfSummaryForRange(range, scopeExclusions, quotaPreset) {
    return this.buildPerfSummaryForRange(
      range,
      scopeExclusions,
      quotaPreset,
      this.capturePerfCarrier({ range, scopeExclusions, streamSamples: true }),
    );
  }

  /**
   * Capture every perf input used by a later build. Passing no range captures
   * the full table so cold-aware callers can apply the final carrier range.
   */
  capturePerfCarrier({ range = null, scopeExclusions = [], streamSamples = false } = {}) {
    const perfState = this.perfState();
    const publicationPolicy = decodeCodexPublicationPolicy(perfState.codexPublicationPolicy);
    const partialHomes = publicationPolicy.usable ? publicationPolicy.partialHomes : [];
    const publicationFilter = createCodexPublishFilter(
      perfState.degradedHomeIds,
      partialHomes,
      publicationPolicy.usable ? perfState.sourceWarnings : [],
    );
    const partialHomeIds = new Set(publicationFilter.permittedHomeIds);
    const perfBounds = range === null ? null : perfStatsRangeBounds(range);
    const perfExclusions = [
      ...new Set([...scopeExclusions, ...perfState.degradedHomeIds.filter((homeId) => !partialHomeIds.has(homeId))]),
    ];
    return {
      perfState,
      samples: streamSamples
        ? Object.assign(
            (function* (store) {
              yield* store.perfCandidatesForRange(perfBounds, perfExclusions, true);
              yield* store.unplacedPerfSamples(perfExclusions, true);
            })(this),
            { [Symbol.for("codex-usage.perf.unique-iterable.v1")]: true },
          )
        : [...this.perfCandidatesForRange(perfBounds, perfExclusions), ...this.unplacedPerfSamples(perfExclusions)],
      identities: this.perfSampleIdentities(streamSamples),
      knownSources: (this.homes || []).map((home) => ({
        kind: canonicalPerfSourceKind(home?.kind),
        homeId: String(home?.id ?? ""),
      })),
      unsupportedSources: decodeJsonWarnings(this.readMetaRaw("perf_unsupported_sources")),
    };
  }

  buildPerfSummaryForRange(range, scopeExclusions, quotaPreset, perfCarrier) {
    const perfState = perfCarrier.perfState;
    const degraded = new Set(perfState.degradedHomeIds);
    const publicationPolicy = decodeCodexPublicationPolicy(perfState.codexPublicationPolicy);
    const partialHomes = publicationPolicy.usable ? publicationPolicy.partialHomes : [];
    const publicationFilter = createCodexPublishFilter(
      perfState.degradedHomeIds,
      partialHomes,
      publicationPolicy.usable ? perfState.sourceWarnings : [],
    );
    const partialHomeIds = new Set(publicationFilter.permittedHomeIds);

    // Convert usage range keys once so the shared summary kernel sees the final carrier range.
    const perfBounds = perfStatsRangeBounds(range);
    const perfExclusions = [
      ...new Set([...scopeExclusions, ...perfState.degradedHomeIds.filter((homeId) => !partialHomeIds.has(homeId))]),
    ];
    const publishableInRange = (sample) =>
      codexSampleAllowed(publicationFilter, sample) &&
      (!quotaPreset ||
        isQuotaUsage({ ...sample, quotaSource: this.quotaSourceFor(sample.homeId, sample.sessionId, sample.tsMs) }));
    const identities = perfCarrier.identities;
    let rankedHomeIds;
    if (Array.isArray(identities)) {
      const codexHomeIds = rankedCodexHomeIds(publicationFilter, identities);
      const otherHomeIds = identities
        .filter((sample) => sample.sourceKind !== "codex")
        .filter((sample) => !degraded.has(sample.homeId))
        .map((sample) => sample.homeId)
        .filter(Boolean);
      rankedHomeIds = [...new Set([...codexHomeIds, ...otherHomeIds])].sort();
    } else {
      const homeIds = new Set();
      for (const [homeId, threadIds] of identities?.codexThreadsByHome ?? []) {
        for (const threadId of threadIds) {
          if (!publicationFilter.threadAllowed(homeId, threadId)) continue;
          homeIds.add(homeId);
          break;
        }
      }
      for (const homeId of identities?.otherHomeIds ?? []) {
        if (homeId && !degraded.has(homeId)) homeIds.add(homeId);
      }
      rankedHomeIds = [...homeIds].sort();
    }
    const perfStats = buildPerfStatsBlock({
      samples: /** @type {any} */ (
        (() => {
          const filtered = (function* (samples) {
            for (const sample of samples) if (publishableInRange(sample)) yield sample;
          })(perfCarrier.samples);
          const marker = Symbol.for("codex-usage.perf.unique-iterable.v1");
          if (perfCarrier.samples?.[marker] === true) {
            Object.defineProperty(filtered, marker, { value: true });
          }
          return filtered;
        })()
      ),
      bounds: perfBounds,
      excludedHomeIds: perfExclusions,
      knownSources: perfCarrier.knownSources,
      meta: {
        methodVersion: PERF_METHOD_VERSION,
        state: perfState.state,
        indexVersion: perfState.indexVersion ?? null,
        indexedAt: perfState.indexedAt ?? null,
        sourceWarnings: perfState.sourceWarnings,
      },
    });

    return {
      state: perfState.state,
      ready: perfState.state === PERF_STATE_READY,
      methodVersion: PERF_METHOD_VERSION,
      indexVersion: perfState.indexVersion,
      indexedAt: perfState.indexedAt,
      degradedHomeIds: perfState.degradedHomeIds,
      missingSources: perfState.missingSources.filter((source) => !scopeExclusions.includes(source.homeId)),
      sourceWarnings: perfStats.meta.sourceWarnings,
      unsupportedSources: perfCarrier.unsupportedSources,
      rankedHomeIds,
      groups: perfStats.groups,
      models: perfStats.models,
      coverage: perfStats.coverage,
      codexTimingCoverage: perfStats.codexTimingCoverage,
      meta: perfStats.meta,
    };
  }

  summaryProjectionKeys(range, bucket, excludeHomes, includeDetails, pricingModels) {
    if (!this.usageProjectionTracker && !this.verifiedHistorySqlRead) {
      this.installUsageProjectionTracker();
      this.observedUsageProjectionChanges = this.usageProjectionChangeKey();
    }
    const catalog = getPricingCatalog();
    const rate = Number(catalog.usdToCnyRate);
    const usdToCnyRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    const totalChanges = Number(this.database.prepare("SELECT total_changes() AS value").get()?.value ?? -1);
    const canonicalExcludedHomes = [...new Set((excludeHomes || []).map(String).filter(Boolean))].sort();
    const pricingModelKeys =
      pricingModels && typeof pricingModels === "object" && !Array.isArray(pricingModels)
        ? JSON.stringify(Object.keys(pricingModels).sort())
        : "";
    const revisionKey = [
      `store-revision\u0000${this.storeRevision}`,
      `derived-revision\u0000${this.derivedRevision}`,
      `total-changes\u0000${totalChanges}`,
      `data-version\u0000${this.readDataVersion()}`,
    ].join("\u0001");
    const contextKey = [
      `pricing-model-keys\u0000${pricingModelKeys}`,
      `service-tier-evidence\u0000${this.serviceTierEvidenceInput === null ? "<unsynced>" : this.serviceTierEvidenceInput}`,
      `homes\u0000${JSON.stringify(this.homes)}`,
      `resolved-range\u0000${JSON.stringify(range)}`,
      `bucket\u0000${bucket}`,
      `excluded-homes\u0000${canonicalExcludedHomes.join("\u0000")}`,
      `include-details\u0000${includeDetails ? "1" : "0"}`,
    ].join("\u0001");
    const factsKey = [
      `usage-changes\u0000${this.usageProjectionChangeKey(totalChanges)}`,
      `data-version\u0000${this.readDataVersion()}`,
      contextKey,
    ].join("\u0001");
    const pricingKey = `pricing-catalog\u0000${String(catalog.version ?? "")}\u0001usd-to-cny-rate\u0000${usdToCnyRate}`;
    return {
      factsKey,
      key: `${factsKey}\u0001${pricingKey}`,
      perfKey: `${revisionKey}\u0001${contextKey}\u0001${pricingKey}`,
      contextKey: `${contextKey}\u0001${pricingKey}`,
    };
  }

  summarizeInReadTransaction(filters = {}, options = {}) {
    const previousPricingModels = this.readPricingModels;
    const pricingModels = filters.pricingModels ?? getPricingCatalog().models;
    this.readPricingModels = pricingModels;
    try {
      return this.summarizeInReadTransactionCore(filters, options, pricingModels);
    } finally {
      this.readPricingModels = previousPricingModels;
    }
  }

  summarizeInReadTransactionCore(filters = {}, { includeDetails = true } = {}, pricingModels) {
    const excludeHomes = filters.excludeHomes || [];
    const asOf = filters.now ? new Date(filters.now) : new Date();
    const quotaObservations = this.quotaObservations();
    const quota = selectQuotaWindows(quotaObservations, asOf);
    const bounds = this.eventBounds(excludeHomes);
    const boundaryEvents = [];
    if (bounds.minimum !== null) {
      boundaryEvents.push({ timestamp: new Date(Number(bounds.minimum)).toISOString() });
    }
    if (bounds.maximum !== null) {
      boundaryEvents.push({ timestamp: new Date(Number(bounds.maximum)).toISOString() });
    }
    const range = resolveDateRange({ ...filters, now: asOf, quota }, boundaryEvents);
    const quotaPreset = isQuotaPreset(range.preset) || Boolean(range.quotaWindow);
    const scopeExclusions = quotaPreset ? [...new Set([...excludeHomes, ...this.nonCodexHomeIds()])] : excludeHomes;
    const bucket = deriveTimelineBucket(
      range,
      range.bucket ||
        (quotaPreset ? (range.preset === "quota_5h" ? "quota_30m" : "quota_24h") : filters.bucket || "day"),
    );
    const groupingEligible =
      !quotaPreset &&
      this.writeTransactionDepth === 0 &&
      (this.verifiedHistorySqlRead ||
        !this.database
          .prepare("SELECT 1 FROM store_meta WHERE key IN (?, ?)")
          .get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META, HISTORY_ARCHIVE_PERF_AUTHORITY_META));
    const projectionCacheable = range.preset === "all" && groupingEligible;
    const projectionKeys = projectionCacheable
      ? this.summaryProjectionKeys(range, bucket, scopeExclusions, includeDetails, pricingModels)
      : null;
    const factProjection =
      projectionKeys &&
      this.summaryProjectionCache?.factsKey === projectionKeys.factsKey &&
      this.summaryProjectionCache.evidence === this.serviceTierEvidence
        ? structuredClone(this.summaryProjectionCache.projection)
        : null;
    const projection = factProjection && this.summaryProjectionCache.key === projectionKeys.key ? factProjection : null;
    const perfProjection =
      projection && this.summaryProjectionCache.perfKey === projectionKeys.perfKey ? projection : null;
    let quoteInputs = factProjection ? this.summaryProjectionCache.quoteInputs : null;
    if (projectionCacheable && !factProjection && this.summaryProjectionCache?.quoteInputs) {
      this.summaryProjectionCache.quoteInputs.discard();
      this.summaryProjectionCache.quoteInputs = null;
    }
    const aggregate = this.aggregateRange(range, scopeExclusions);
    const totals = usageFromRow(aggregate);
    const previousRange = quotaPreset ? previousQuotaRange(range, quota, quotaObservations) : previousUsageRange(range);
    const previousAggregate = previousRange ? this.aggregateRange(previousRange, scopeExclusions) : null;
    const comparison = usageComparisonFromAggregates({
      range,
      currentTotals: totals,
      previousRange,
      previousTotals: usageFromRow(previousAggregate),
      previousEventCount: Number(previousAggregate?.event_count || 0),
      previousSessionCount: Number(previousAggregate?.session_count || 0),
      now: asOf,
    });
    let timeline = projection?.timeline ?? [];
    let timelineError = projection?.timelineError ?? null;
    let costEstimate = projection?.costEstimate;
    let fusedGroups = null;
    let fusedRepositories = null;
    if (!projection) {
      const quoteCapture = projectionCacheable && !factProjection ? new HistoryQuoteInputs() : null;
      const pricing = createEventPricing(pricingModels);
      const costAccumulator = createCostEstimateAccumulator({ modelName: pricing.costModelName });
      const sourceKindsByPath =
        groupingEligible && !factProjection
          ? new Map(
              this.database
                .prepare("SELECT path, kind FROM source_files")
                .all()
                .map((row) => [String(row.path), String(row.kind)]),
            )
          : null;
      const groupAccumulator = sourceKindsByPath
        ? createFusedSummaryGroups(sourceKindsByPath, pricing.modelName)
        : null;
      // shortcut: hot-only repository session order stays on SQL; this collector serves the verified cold reader.
      const repositoryAccumulator =
        projectionCacheable && this.verifiedHistorySqlRead && includeDetails && sourceKindsByPath
          ? createFusedSummaryRepositories(
              Object.fromEntries(
                COMPARISON_PERIOD_KEYS.map((key) => [
                  key,
                  resolveDateRange({ preset: key, now: asOf, calendarZone: range.calendarZone }, boundaryEvents),
                ]),
              ),
            )
          : null;
      const observationAccumulator =
        projectionCacheable &&
        this.verifiedHistorySqlRead &&
        scopeExclusions.length === 0 &&
        sourceKindsByPath &&
        this.metadataObservationCache?.revision !== this.storeRevision
          ? createFusedMetadataObservations()
          : null;
      try {
        timeline = this.timelineRange(range, bucket, {
          onEstimate: (event, estimate, bucketKey) => {
            quoteCapture?.append(event, bucketKey);
            costAccumulator.add(event, estimate);
            groupAccumulator?.add(event);
            repositoryAccumulator?.add(event);
            observationAccumulator?.add(event);
          },
          excludeHomes: scopeExclusions,
          pricingModels,
          pricing,
          quoteInputs,
          factRows: factProjection?.timelineError ? undefined : factProjection?.timeline,
          includeRepositories: Boolean(repositoryAccumulator),
        });
        costEstimate = costAccumulator.result();
        quoteInputs = quoteInputs ?? quoteCapture?.finish() ?? null;
        fusedGroups = factProjection ?? groupAccumulator?.result() ?? null;
        fusedRepositories = repositoryAccumulator?.result() ?? null;
        if (observationAccumulator) {
          const rows = observationAccumulator.result();
          this.metadataObservationCache = {
            revision: this.storeRevision,
            rows,
            maxTimestampMs: rows.reduce((max, row) => Math.max(max, row.last_seen), -Infinity),
          };
        }
      } catch (error) {
        quoteCapture?.discard();
        quoteInputs = null;
        fusedGroups = null;
        if (error.code !== "TIMELINE_RANGE_TOO_LARGE") throw error;
        timelineError = error.message;
        costEstimate = this.costEstimateRange(range, scopeExclusions);
      }
    }
    const summary = {
      generatedAt: this.generatedAt,
      range: {
        preset: range.preset,
        start: range.start ? range.start.toISOString() : null,
        end: range.end ? range.end.toISOString() : null,
        bucket,
        calendarZone: range.calendarZone || "local",
        rolling: Boolean(range.rolling),
        ...(quotaPreset
          ? {
              quotaWindow: true,
              recentValue: range.recentValue,
              quotaPreset: range.quotaPreset,
              asOf: range.asOf.toISOString(),
              windowStart: range.start.toISOString(),
              windowEndExclusive: range.windowEndExclusive.toISOString(),
              observedAt: range.observedAt?.toISOString() || null,
              usedPercent: range.usedPercent,
              percentStale: range.percentStale,
              limitId: range.limitId,
              quotaState: range.quotaState,
              quotaReason: range.quotaReason,
              ...(range.durationMinutes === undefined
                ? {}
                : { durationMinutes: range.durationMinutes, plannedResetAt: range.plannedResetAt }),
            }
          : {}),
      },
      totals,
      comparison,
      costEstimate,
      records:
        range.preset === "all"
          ? {}
          : quotaPreset
            ? quotaRecordsForRange(range, quota, quotaObservations, (window) => {
                const row = window === range ? aggregate : this.aggregateRange(window, scopeExclusions);
                const cost = window === range ? costEstimate : this.costEstimateRange(window, scopeExclusions);
                return {
                  eventCount: Number(row.event_count),
                  values: quotaRecordValues(
                    usageFromRow(row),
                    cost,
                    Number(row.session_count),
                    getPricingCatalog().usdToCnyRate,
                  ),
                };
              })
            : this.recordsForRange(range, scopeExclusions),
      eventCount: Number(aggregate.event_count || 0),
      sessionCount: Number(aggregate.session_count || 0),
      homeCount: Number(aggregate.home_count || 0),
      timeline,
      timelineError,
      quota,
      channels:
        projection?.channels ??
        fusedGroups?.channels ??
        this.groupedRange("channel", range, "total DESC", scopeExclusions),
      models:
        projection?.models ?? fusedGroups?.models ?? this.groupedRange("model", range, "total DESC", scopeExclusions),
    };

    summary.perf = perfProjection?.perf ?? this.perfSummaryForRange(range, scopeExclusions, quotaPreset);

    if (includeDetails) {
      summary.homes =
        projection?.homes ??
        fusedGroups?.homes ??
        this.groupedRange("home_label", range, "total DESC", scopeExclusions);
      summary.projects =
        projection?.projects ??
        fusedGroups?.projects ??
        this.groupedRange("project", range, "total DESC", scopeExclusions);
      const repositorySessions = fusedRepositories
        ? this.historyRepositorySessionOrder(
            eventRangeScope(range, scopeFilterSql(scopeExclusions)),
            fusedRepositories.firsts,
          )
        : null;
      summary.repositories =
        factProjection?.repositories ??
        fusedRepositories?.rows.map((row) => ({ ...row, sessionIds: repositorySessions.get(row.key) })) ??
        this.repositoriesRange(range, scopeExclusions);
    }
    if (projectionCacheable && (!projection || !perfProjection)) {
      const cachedProjection = {
        timeline,
        timelineError,
        costEstimate,
        perf: summary.perf,
        channels: summary.channels,
        models: summary.models,
      };
      if (includeDetails) {
        cachedProjection.homes = summary.homes;
        cachedProjection.projects = summary.projects;
        cachedProjection.repositories = summary.repositories;
        const repositoryPeriods =
          factProjection?.repositoryPeriods ??
          (fusedRepositories
            ? {
                key: periodComparisonKey(
                  asOf,
                  range.calendarZone === "utc" ? "utc" : "local",
                  scopeExclusions,
                  pricingModels,
                ),
                rows: fusedRepositories.periodRepositories,
              }
            : null);
        if (repositoryPeriods) cachedProjection.repositoryPeriods = repositoryPeriods;
      }
      this.summaryProjectionCache = {
        ...projectionKeys,
        context: { range, bucket, excludeHomes: scopeExclusions, includeDetails, pricingModels },
        evidence: this.serviceTierEvidence,
        // Reusing facts must retain their original certification, including a refused transaction build.
        guard: factProjection
          ? this.summaryProjectionCache.guard
          : this.summaryProjectionTransferableRead
            ? this.usageProjectionGuard()
            : null,
        projection: structuredClone(cachedProjection),
        quoteInputs,
      };
    }
    return summary;
  }

  close() {
    this.historySqlDashboardCache?.store.close();
    this.historySqlDashboardCache = null;
    this.codexPublishedPaths.clear();
    this.nativeTimingThreads.clear();
    // C1 卡：**实例私有**记录在 `close()` 时清空 —— 卡面/规格明文"close/open、实例销毁和方法变更
    // 使记录失效"。记录不跨实例、不跨 close 存活（重开后重新预热一次规划）。
    this.codexStableAttempts.clear();
    // C3 卡：投影缓存同为**实例私有** ⇒ `close()` 一并清空（重开后重新预热一次；不跨实例）。
    this.codexProjections.clear();
    this.codexThreadBuildPlan.clear();
    // S4：trace 指纹是**进程内**状态（刻意不落盘）⇒ `close()` 丢弃；重开后首轮自然全扫一次。
    this.workbuddyTraceFingerprints.clear();
    this.workbuddyTimingSpans.clear();
    this.workbuddyTextTimingLookups.clear();
    this.workbuddyTextMessageIds.clear();
    // D1：派生缓存与写事务深度都是**连接级**状态 ⇒ `close()` 一并复位；`open()` 会把
    // `observedDataVersion` 重新取基准（外部提交检测在重开后**从零**开始计），
    // 而 `storeRevision` 是这个**实例**的单调修订号，跨 `close()/open()` 保留。
    this.metadataCache = null;
    this.periodComparisonCache.clear();
    // D4：观测聚合缓存同为连接级状态（`storeRevision` 跨 close/open **保留** ⇒ 必须显式复位）。
    this.metadataObservationCache = null;
    // D2：历史冠军 memo 同为连接级状态（且 `storeRevision` 跨 close/open **保留** ⇒ 只靠键
    // 不足以保证"重开后一定重算"，必须显式复位）。
    this.recordChampionCache = null;
    // D3：quota 观测映射同为连接级状态（`storeRevision` 跨 close/open **保留** ⇒ 必须显式复位）。
    this.quotaObservationCache = null;
    this.summaryProjectionCache = null;
    this.usageProjectionTracker = null;
    this.observedUsageProjectionChanges = "";
    this.summaryProjectionTransferableRead = false;
    this.openedUsageProjectionIdentity = null;
    this.openedUsageProjectionChanges = -1;
    // W4-b1 / D1：事件计价 memo 是**实例私有** ⇒ `close()` 一并清空（重开后重新预热一次；
    // 不跨实例）。键里已含内容与价目版本，所以这里同样是内存卫生而非正确性要求。
    this.eventCostMemo.clear("close");
    this.derivedRevision = this.storeRevision;
    this.writeTransactionDepth = 0;
    if (!this.database) {
      return;
    }
    this.database.close();
    this.database = null;
  }
}
