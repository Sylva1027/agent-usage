import { mkdir, stat } from "node:fs/promises";
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { plainRolloutPath } from "./codex-rollout.js";
import { createUsageInsertBatch } from "./usage-insert-batch.js";
import { UsageSourceAcquisition, ensureUsageSourceCatalog, USAGE_SOURCE_CATALOG_TABLE } from "./usage-source-acquisition.js";
import {
  ensureUsageMetadataSchema,
  prepareStoredMetadata,
  readStoredMetadata,
  USAGE_METADATA_TABLE_NAMES,
} from "./usage-metadata-store.js";

import {
  COMPARISON_PERIOD_KEYS,
  buildUsageFingerprint,
  discoverSessionFiles,
  discoverUsageSources,
  isQuotaPreset,
  previousUsageRange,
  resolveDateRange,
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
  queryUsageRollupRepositoriesWindow,
  queryUsageRollupsRange,
  rebuildUsageRollups,
  rebuildUsageRollupsFromEvents,
  tryAppendUsageRollups,
  tryInitializeUsageRollups,
  checkpointUsageRollups,
  USAGE_ROLLUP_PROGRESS_TABLES,
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
import { createStoredQuotaSourceResolver } from "./usage-quota-source-store.js";
import { readCodexQuotaObservations } from "./codex-quota-cache.js";
import { isQuotaUsage } from "../public/quota-usage.js";
import { HistoryQuoteInputs } from "./history-quote-inputs.js";
import { UsageSessionMembers } from "./usage-session-members.js";
import { UsageHistoryQuery } from "./usage-history-query.js";
import {
  ensureUsageAllSummarySchema,
  buildStoredAllSummary,
  readStoredAllSummary,
  USAGE_ALL_SUMMARY_TABLE_NAMES,
} from "./usage-all-summary-store.js";
import { UsageSourceProof, usageSourceIdentity, USAGE_SOURCE_SHA_KIND } from "./usage-source-proof.js";
import {
  ensureUsageSourceProgressSchema,
  markUsageSourceDependents,
  readUsageSourceBaseline,
  readUsageSourceProgress,
  UsageSourceChangeBounds,
  writeUsageSourceBaseline,
  writeUsageSourceProgress,
  USAGE_SOURCE_PROGRESS_TABLE_NAMES,
} from "./usage-source-progress.js";
import {
  ensureUsageQuotaSchema,
  iterateStoredQuotaWindows,
  selectStoredQuotaWindows,
  quotaProjectionWork,
  USAGE_QUOTA_TABLE_NAMES,
} from "./usage-quota-store.js";
import {
  buildStoredRecordChampions,
  ensureUsageRecordSchema,
  readStoredRecordChampions,
  USAGE_RECORD_TABLE_NAMES,
} from "./usage-record-store.js";
import { buildModelActivity, canonicalModelName } from "../public/pricing-models.js";
import { addPeriodEvent, emptyPeriodMetrics, summarizePeriodComparison } from "../public/period-comparison.js";
import { zcodeSourceStat } from "./zcode-usage.js";
import { dshSessionFiles } from "./dsh-usage.js";
import { opencodeDatabaseFiles, opencodeSourceStat } from "./opencode-usage.js";
import { claudeSessionFiles } from "./claude-code-usage.js";
import { workbuddySessionFiles } from "./workbuddy-usage.js";
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

export const STORE_SCHEMA_VERSION = 24;

const QUOTA_SOURCES_DDL = `CREATE TABLE IF NOT EXISTS quota_usage_sources (
  source_path TEXT NOT NULL, home_id TEXT NOT NULL, session_id TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL, quota_source TEXT NOT NULL, until_ms INTEGER NOT NULL,
  PRIMARY KEY (source_path, session_id, timestamp_ms)
) STRICT;`;

const USAGE_PROJECTION_IGNORED_TABLES = [
  USAGE_SOURCE_CATALOG_TABLE,
  "history_replaced_facts",
  "usage_business_revision",
  ...USAGE_RECORD_TABLE_NAMES,
  ...USAGE_QUOTA_TABLE_NAMES,
  ...USAGE_SOURCE_PROGRESS_TABLE_NAMES,
  ...USAGE_ALL_SUMMARY_TABLE_NAMES,
  ...USAGE_METADATA_TABLE_NAMES,
  ...USAGE_ROLLUP_PROGRESS_TABLES,
];
const USAGE_PROJECTION_IGNORED_META = [
  "generated_at",
  "fingerprint",
  "usage_file_fingerprints",
  "perf_file_warnings",
  "perf_missing_sources",
];
const MISSING_SOURCES_META = "perf_missing_sources";
const LOCAL_ROLLUP_ZONE_META = "usage_rollup_local_zone_identity";
const DEFERRED_METADATA_INDEX_META = "usage_metadata_initial_index_pending";
const HISTORY_ARCHIVE_EVENT_AUTHORITY_META = "history_archive_event_authority";
const HISTORY_ARCHIVE_EVENT_REVISIONS_META = "history_archive_event_revisions";
const PROJECT_LOG_TRUNCATION_WARNING_CODE = "PROJECT_LOG_TRUNCATED";
const PROJECT_LOG_MALFORMED_LINE_WARNING_CODE = "PROJECT_LOG_MALFORMED_JSONL";

function currentLocalRollupZoneIdentity() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || `offset:${new Date().getTimezoneOffset()}`;
}

function historyArchiveError(code, message) {
  return Object.assign(new Error(message), { code });
}

function schemaMismatchError(code, message) {
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
    throw schemaMismatchError(
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
      throw schemaMismatchError(
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
    throw schemaMismatchError("ARCHIVE_SEGMENTS_SCHEMA_MISMATCH", "archive_segments 不是带冻结 CHECK 的 STRICT 表");
  }
}

function assertHistoryReplacedFactsSchema(database) {
  const actualColumns = database.prepare("PRAGMA table_info(history_replaced_facts)").all();
  if (actualColumns.length !== HISTORY_REPLACED_FACT_COLUMNS.length) {
    throw schemaMismatchError(
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
      throw schemaMismatchError(
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
    throw schemaMismatchError("HISTORY_REPLACED_FACTS_SCHEMA_MISMATCH", "history_replaced_facts 不是 STRICT 表");
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
  const payloadFor = (row) => historyArchiveRevisionPayload(canonicalFactPayload(row, ["id"]), prefix.sourceIdentity);
  // An unchanged prefix may contain several legitimate events in the same millisecond.
  if (
    prefix.effectiveRows.length === prefix.observedRows.length &&
    prefix.effectiveRows.every(
      (row, index) =>
        historyArchiveRevisionPayloadKey(payloadFor(row)) ===
        historyArchiveRevisionPayloadKey(payloadFor(prefix.observedRows[index])),
    )
  ) {
    return null;
  }
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
    const removedCounts = new Map();
    for (const removed of revision.removed) {
      const key = historyArchiveRevisionPayloadKey(removed.payload);
      const count = (removedCounts.get(key) || 0) + removed.count;
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
    if ([...remainingRemovals.values()].some((count) => count > 0)) {
      throw historyArchiveRevisionError(
        `archive revision removes more payloads than segment ${segment.segment_id} contains`,
      );
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

function validateHistoryArchiveSourceRevisions(database, segmentId, sourceIdentities, revisions) {
  if (!revisions?.length) return;
  const matches = database.prepare(
    `SELECT * FROM events WHERE ${EVENT_INSERT_COLUMNS.map((column) => `${column} = ?`).join(" AND ")}`,
  );
  for (const revision of revisions) {
    if (!sourceIdentities.some((identity) => sameHistoryArchiveSourceIdentity(identity, revision.sourceIdentity))) {
      throw historyArchiveRevisionError(`archive revision source binding does not match segment ${segmentId}`);
    }
    const removals = new Map();
    for (const removed of revision.removed) {
      const key = historyArchiveRevisionPayloadKey(removed.payload);
      let count = removals.get(key);
      if (!count) {
        count = { needed: 0, available: 0 };
        for (const row of matches.iterate(...EVENT_INSERT_COLUMNS.map((column) => removed.payload[column]))) {
          // Preserve the original JS payload equality across SQLite string binding.
          if (historyArchiveRevisionPayloadKey(row) === key) count.available++;
        }
        removals.set(key, count);
      }
      count.needed += removed.count;
      if (count.needed > count.available) {
        throw historyArchiveRevisionError(`archive revision removes more payloads than segment ${segmentId} contains`);
      }
    }
  }
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
    ...(canonicalizeKind(String(sourceKind)) === "codex"
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

/** Source replacement retains an exact multiset on disk instead of two event arrays and JS maps. */
class UsageReplacementFacts {
  constructor(sourceDatabase) {
    this.sourceDatabase = sourceDatabase;
    this.database = null;
  }

  capture(table, sourcePath) {
    for (const row of this.sourceDatabase.prepare(`SELECT * FROM ${table} WHERE source_path=?`).iterate(sourcePath)) {
      if (!this.database) {
        this.database = new DatabaseSync("");
        this.database.exec(`PRAGMA cache_size=-1024; PRAGMA temp_store=FILE;
          CREATE TABLE facts(fact_table TEXT,source_path TEXT,digest TEXT,payload TEXT,
            previous_count INTEGER,current_count INTEGER DEFAULT 0,
            PRIMARY KEY(fact_table,source_path,digest)) WITHOUT ROWID; BEGIN`);
      }
      const payload = JSON.stringify(canonicalFactPayload(row, table === "events" ? ["id"] : []));
      const digest = createHash("sha256").update(payload).digest("hex");
      this.database
        .prepare(`INSERT INTO facts(fact_table,source_path,digest,payload,previous_count)
        VALUES (?,?,?,?,1) ON CONFLICT(fact_table,source_path,digest)
        DO UPDATE SET previous_count=previous_count+1`)
        .run(table, sourcePath, digest, payload);
    }
  }

  save(insert, table, source, methodVersion) {
    if (!this.database) return { previousCount: 0, currentCount: 0 };
    const previousCount = Number(
      this.database
        .prepare(`SELECT COALESCE(SUM(previous_count),0) AS n
      FROM facts WHERE fact_table=? AND source_path=?`)
        .get(table, source.path).n,
    );
    if (!previousCount) return { previousCount: 0, currentCount: 0 };
    const update = this.database.prepare(`UPDATE facts SET current_count=current_count+1
      WHERE fact_table=? AND source_path=? AND digest=?`);
    let currentCount = 0;
    for (const row of this.sourceDatabase.prepare(`SELECT * FROM ${table} WHERE source_path=?`).iterate(source.path)) {
      const payload = canonicalFactPayload(row, table === "events" ? ["id"] : []);
      update.run(table, source.path, historyPayloadDigest(payload));
      currentCount += 1;
    }
    const at = new Date().toISOString();
    for (const row of this.database
      .prepare(`SELECT digest,payload,previous_count-current_count AS missing
      FROM facts WHERE fact_table=? AND source_path=? AND previous_count>current_count`)
      .iterate(table, source.path)) {
      insert.run(
        table,
        String(source.kind),
        String(source.home_id),
        String(source.path),
        row.digest,
        Number(row.missing),
        row.payload,
        String(source.home_label),
        String(source.home_path),
        methodVersion,
        "reparse_replaced",
        at,
      );
    }
    return { previousCount, currentCount };
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}

/**
 * W4-b1 / D1：`buildRecordChampions` 的**默认**逐行计价函数（= 模块级的 `estimateEventCost`）。
 *
 * 存在的理由：该方法的源码里有一行 `const estimate = estimateEventCost({…})`，被共享门禁
 * （`tools/lib/instrument.mjs` 的 `fullHistoryPricingRows` 锚点）**逐字节**锚定。为了在不改锚点的
 * 前提下让它走 memo，把计价函数作为**末位参数注入**（默认值就是这个别名）。
 */
const DEFAULT_EVENT_COST_ESTIMATOR = estimateEventCost;

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

function sourceEventRow(filePath, event) {
  const date = new Date(event.timestampMs);
  return {
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
}

function addCumulativeFingerprint(hash, row) {
  hash.update(
    JSON.stringify([
      row.home_id,
      row.session_id,
      row.timestamp_ms,
      row.total,
      row.input,
      row.cached,
      row.output,
      row.reasoning,
      Number(row.detail_mask) & 15,
      row.cache_write_tokens,
      row.cache_write_known,
    ]),
  );
  hash.update("\n");
}

function sourceSessionId(checkpoint, filePath) {
  return checkpoint.adapter === "codex-jsonl"
    ? checkpoint.state.meta.id
    : checkpoint.state.header.id || path.basename(path.dirname(filePath));
}

function sameSourceBinding(existing, source) {
  return (
    existing &&
    existing.kind === (source.kind || "codex") &&
    existing.home_id === source.id &&
    existing.home_label === source.label &&
    existing.home_path === source.path
  );
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
  let memberBytes = 0;
  let active = true;
  const groupsByDimension = {
    channels: new Map(),
    models: new Map(),
    homes: new Map(),
    projects: new Map(),
  };
  const add = (groups, key, event) => {
    if (!active) return;
    const name = String(key);
    const group = groups.get(name) || {
      key: name,
      name,
      count: 0,
      sessions: new Set(),
      total: { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 },
    };
    group.count += 1;
    if (!group.sessions.has(event.sessionId)) {
      memberBytes += 160 + String(event.sessionId).length * 2;
      if (memberBytes > 1024 * 1024) {
        active = false;
        for (const dimension of Object.values(groupsByDimension)) dimension.clear();
        return;
      }
      group.sessions.add(event.sessionId);
    }
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
      if (!active) return null;
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

function periodRollupWindow(startMs, endMs, minimum, maximum) {
  if (startMs >= endMs || startMs > maximum || endMs <= minimum) return null;
  const dayMs = 86_400_000;
  // Outside the scoped fact bounds these prefixes and suffixes are empty.
  return {
    startMs: startMs <= minimum ? Math.floor(minimum / dayMs) * dayMs : startMs,
    endMs: endMs > maximum ? (Math.floor(maximum / dayMs) + 1) * dayMs : endMs,
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

function canonicalizeKind(kindRaw) {
  if (typeof kindRaw !== "string") return "unsupported";
  const kind = kindRaw.trim().toLowerCase();
  if (["main", "jetbrains", "extra", "codex"].includes(kind)) return "codex";
  return ["zcode", "dsh", "opencode", "claude", "workbuddy"].includes(kind) ? kind : "unsupported";
}

// Bound the probe as before; use it for usage-file stability and rename identity.
function usageSourceFingerprint(filePath) {
  let handle;
  try {
    const info = statSync(filePath);
    const wal = statSync(`${filePath}-wal`, { throwIfNoEntry: false });
    const hash = createHash("sha256");
    handle = openSync(filePath, "r");
    const length = Math.min(info.size, 64 * 1024);
    for (const offset of info.size > length ? [0, info.size - length] : [0]) {
      const bytes = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const count = readSync(handle, bytes, read, length - read, offset + read);
        if (!count) return null;
        read += count;
      }
      hash.update(bytes);
    }
    return `${info.size + (wal?.size || 0)}:${Math.max(info.mtimeMs, wal?.size ? wal.mtimeMs : 0)}:${hash.digest("hex")}`;
  } catch {
    return null;
  } finally {
    if (handle !== undefined) closeSync(handle);
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

function normalizePublishedFileWarnings(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (
      entry?.sourceKind !== "project-log" ||
      ![PROJECT_LOG_TRUNCATION_WARNING_CODE, PROJECT_LOG_MALFORMED_LINE_WARNING_CODE].includes(entry?.code)
    )
      return [];
    const normalized = {
      sourceKind: String(entry?.sourceKind ?? "").trim(),
      homeId: String(entry?.homeId ?? "").trim(),
      code: String(entry?.code ?? "").trim(),
      count: Number.isFinite(Number(entry?.count)) ? Number(entry?.count) : 0,
    };
    if (normalized.sourceKind === "" && normalized.homeId === "" && normalized.code === "") return [];
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

export class UsageStore {
  constructor(options = {}) {
    this.options = options;
    this.metadataCache = null;
    this.businessProjectionIgnoredChanges = 0;
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
    this.sourceProof = new UsageSourceProof();
    this.sourceAcquisition = null;
    this.lastSyncSourceWork = null;
    this.serviceTierEvidence = null;
    this.quotaSourceEvidence = null;
    /** @type {ReturnType<typeof createStoredQuotaSourceResolver> | null} */
    this.quotaSourceLookup = null;
    this.quotaSourceDatabase = null;
    this.quotaSourceRevision = -1;
    /**
     * Per-sync cache of the ordinary project-log diagnostics sidecar.
     * @type {{ warnings: Record<string, {sourceKind: string, homeId: string, code: string, count: number, lineNumbers?: number[]}[]> | null } | null}
     */
    this.publishedFileWarningsView = null;
    // ── D1 卡：实例修订 + 外部提交检测 ────────────────────────────────────────────────────────
    /**
     * D1：**实例修订号** —— "这个实例看到的、**已提交的**库内容"的版本。
     *
     * 只在**成功的提交**上 +1（见 {@link UsageStore#commitStoreRevision} 的各调用点）：
     *   * **用量**：`replaceFile` 的 `COMMIT`（`source_files` + `events`，以及同一事务里的
     *     `rate_limit_observations` ⇒ **quota** 观测行）；
     *   * **真删除**：codex 发布事务里的 `DELETE FROM source_files`、非 codex 来源的真实删除；
     *   * **读取窗口内变化**：置脏 `UPDATE source_files SET size = -1, mtime_ms = -1`；
     *   * **home**：home 集合形状变化（`homeSetChanged`）；
     *   * **service-tier evidence**：证据**输入**签名变化（见 {@link UsageStore#serviceTierEvidenceSignature}）。
     *
     * ⚠️ **例行时刻元数据不作为用量变化**（卡面明文）：`generated_at` /
     * `checkedAt` 都**不**推进修订 —— 否则每个 no-op 轮都会
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
     * timeline/cost and grouped detail rows. Dynamic range/quota/clock/status
     * remain outside this slot.
     * @type {{ key: string, factsKey: string, publicationKey?: string, contextKey?: string, context?: any, guard?: any, evidence?: any, projection: object, quoteInputs: HistoryQuoteInputs | null } | null}
     */
    this.summaryProjectionCache = null;
    /** @type {{ database: DatabaseSync, owned: boolean, mainSchema: number, tempSchema: number, tempCatalog: string } | null} */
    this.usageProjectionTracker = null;
    this.observedUsageProjectionChanges = "";
    this.observedPublicationChanges = -1;
    this.summaryProjectionTransferableRead = false;
    this.openedUsageProjectionIdentity = null;
    this.openedUsageProjectionChanges = -1;
    /** SQL history projections stay separate from every hot-only public reader. */
    this.historySqlDashboardCache = null;
    this.verifiedHistorySqlRead = false;
    this.historyDiskRead = false;
    this.historySourceKinds = null;
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
    this.sourceProof ||= new UsageSourceProof();
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
    if (version >= 11 && version < 15) {
      // Skip the retired TPS tables while retaining the subsequent Claude usage migration.
      migrate("SELECT 1;", 15);
      version = 15;
    }
    if (version === 15) {
      // v16: Claude usage events use the served model rather than the requested alias.
      migrate("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE kind = 'claude';", 16);
      version = 16;
    }
    if (version >= 16 && version < 20) {
      // v17-v19 retired TPS migrations are skipped.
      migrate(HISTORY_REPLACED_FACTS_DDL, 20, () => assertHistoryReplacedFactsSchema(this.database));
      version = 20;
    }
    if (version === 20) {
      migrate(ARCHIVE_SEGMENTS_DDL, 21, () => assertArchiveSegmentsSchema(this.database));
      version = 21;
    }
    if (version === 21) {
      // v22 previously rebuilt a TPS table. Keep its rows untouched.
      migrate("SELECT 1;", 22);
      version = 22;
    }
    if (version === 22) {
      migrate(
        `${QUOTA_SOURCES_DDL}
        UPDATE source_files SET size = -1, mtime_ms = -1 WHERE kind IN ('main', 'jetbrains', 'extra', 'codex');`,
        23,
      );
      version = 23;
    }
    if (version === 23) {
      // schema 24 removes TPS from the runtime schema without rewriting legacy tables.
      migrate("SELECT 1;", 24);
      version = 24;
    }
    if (version !== 0 && version !== STORE_SCHEMA_VERSION) {
      this.database.close();
      this.database = null;
      throw new Error(`不支持的用量索引版本：${version}`);
    }
    if (version === 0) {
      this.database.exec(`${QUOTA_SOURCES_DDL}\n${HISTORY_REPLACED_FACTS_DDL}\n${ARCHIVE_SEGMENTS_DDL}`);
      assertHistoryReplacedFactsSchema(this.database);
      assertArchiveSegmentsSchema(this.database);
      this.database.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`);
    }
    this.database.exec(`${QUOTA_SOURCES_DDL}\n${HISTORY_REPLACED_FACTS_DDL}\n${ARCHIVE_SEGMENTS_DDL}`);
    assertHistoryReplacedFactsSchema(this.database);
    assertArchiveSegmentsSchema(this.database);
    this.database.exec("CREATE INDEX IF NOT EXISTS events_repository_idx ON events(repository_key)");
    this.database.exec("CREATE INDEX IF NOT EXISTS events_source_path_idx ON events(source_path)");
    this.database.exec(`CREATE INDEX IF NOT EXISTS quota_sources_thread_time_idx
      ON quota_usage_sources(home_id, session_id, timestamp_ms)`);
    this.database.exec(`CREATE INDEX IF NOT EXISTS quota_sources_account_time_idx
      ON quota_usage_sources(home_id, timestamp_ms) WHERE quota_source IN ('credits', 'plan')`);
    this.database.exec(
      "CREATE INDEX IF NOT EXISTS events_session_home_time_idx ON events(session_id, home_id, timestamp_ms)",
    );
    createUsageRollups(this.database);
    ensureUsageRecordSchema(this.database);
    ensureUsageQuotaSchema(this.database);
    ensureUsageSourceProgressSchema(this.database);
    ensureUsageSourceCatalog(this.database);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS usage_business_revision (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL
      ) STRICT;
    `);
    if (!this.database.prepare("SELECT 1 FROM usage_business_revision WHERE singleton = 1").get()) {
      this.database.exec("INSERT INTO usage_business_revision VALUES (1, 0)");
    }
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      this.database.exec(`CREATE TRIGGER IF NOT EXISTS usage_business_events_${operation}
        AFTER ${operation} ON events BEGIN
          UPDATE usage_business_revision SET revision = revision + 1 WHERE singleton = 1;
        END`);
    }
    ensureUsageAllSummarySchema(this.database);
    this.deferredMetadataIndex = this.readMetaRaw(DEFERRED_METADATA_INDEX_META) === "1";
    if (
      !this.deferredMetadataIndex &&
      !this.database.prepare("SELECT 1 FROM events LIMIT 1").get() &&
      !this.database.prepare("SELECT 1 FROM source_files LIMIT 1").get() &&
      !this.database.prepare("SELECT 1 FROM sqlite_master WHERE name='events_metadata_group_time_idx'").get() &&
      !this.database.prepare("SELECT 1 FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META)
    ) {
      this.writeMeta(DEFERRED_METADATA_INDEX_META, "1");
      this.deferredMetadataIndex = true;
    }
    ensureUsageMetadataSchema(this.database, { deferIndex: this.deferredMetadataIndex });
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
    // ── D1 卡：外部提交检测的**基准** ──────────────────────────────────────────────────────────
    // 必须在**所有迁移/建表之后**取：上面那些 `BEGIN IMMEDIATE … COMMIT` 是**本连接**的提交，
    // `PRAGMA data_version` 不会因它们而变；而基准取早了会把"自己迁移"误判成"外部提交"。
    this.observedDataVersion = this.readDataVersion();
    // 两个派生缓存刚在上面清空 ⇒ 它们与当前修订是**对齐**的（`open()` 不是一次提交）。
    this.derivedRevision = this.storeRevision;
    this.observedUsageProjectionChanges = this.usageProjectionChangeKey();
    this.openedUsageProjectionIdentity = this.usageProjectionDatabaseIdentity();
    this.openedUsageProjectionChanges = Number(this.database.prepare("SELECT total_changes() AS value").get().value);
    this.observedPublicationChanges = this.openedUsageProjectionChanges;
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
      if (this.database.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META))
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
    this.database.exec(`CREATE TEMP TABLE usage_projection_ignored_rows (value INTEGER NOT NULL, owned INTEGER NOT NULL) STRICT;
      INSERT INTO usage_projection_ignored_rows VALUES (0, 0);`);
    const keys = USAGE_PROJECTION_IGNORED_META.map((key) => `'${key}'`).join(",");
    for (const table of [...USAGE_PROJECTION_IGNORED_TABLES, "store_meta"]) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        // REPLACE can silently remove an unrelated metadata row through its hidden rowid.
        if (table === "store_meta" && operation === "INSERT") continue;
        const references = operation === "INSERT" ? ["NEW"] : operation === "DELETE" ? ["OLD"] : ["OLD", "NEW"];
        const metadata =
          table === "store_meta" ? references.map((row) => `${row}.key IN (${keys})`).join(" AND ") : "1";
        const rowid = table === "store_meta" && operation === "UPDATE" ? " AND OLD.rowid = NEW.rowid" : "";
        const when = `(SELECT owned FROM usage_projection_ignored_rows) = 0
          AND (SELECT recursive_triggers FROM pragma_recursive_triggers) = 0 AND ${metadata}${rowid}`;
        this.database.exec(`CREATE TEMP TRIGGER usage_projection_${table}_${operation}
          AFTER ${operation} ON main.${table} WHEN ${when}
          BEGIN UPDATE usage_projection_ignored_rows SET value = value + 1; END;`);
      }
    }
    this.usageProjectionTracker = {
      database: this.database,
      owned: false,
      mainSchema: Number(this.database.prepare("PRAGMA main.schema_version").get().schema_version),
      tempSchema: Number(this.database.prepare("PRAGMA temp.schema_version").get().schema_version),
      tempCatalog: JSON.stringify(
        this.database.prepare("SELECT type, name, tbl_name, sql FROM temp.sqlite_master ORDER BY type, name").all(),
      ),
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
    if (this.database.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META))
      return fallback;
    const ignored = Number(this.database.prepare("SELECT value FROM usage_projection_ignored_rows").get()?.value);
    const changes = totalChanges - 2 * ignored - this.businessProjectionIgnoredChanges;
    return Number.isSafeInteger(ignored) && ignored >= 0 && Number.isSafeInteger(changes) && changes >= 0
      ? `usage:${changes}:${Number(this.database.prepare("SELECT revision FROM usage_business_revision WHERE singleton=1").get().revision)}`
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
   * @param {string} reason 提交类别（诊断用：`usage` / `usage+quota` / `usage-delete` /
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
    if (this.publishedFileWarningsView) this.publishedFileWarningsView.warnings = null;
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
    const totalChanges = Number(this.database.prepare("SELECT total_changes() AS value").get().value);
    if (this.observedPublicationChanges !== totalChanges) {
      this.generatedAt = this.readMeta("generated_at");
      this.fingerprint = this.readMeta("fingerprint");
      this.observedPublicationChanges = totalChanges;
    }
    const usageChanges = this.usageProjectionChangeKey(totalChanges);
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

  writeMeta(key, value) {
    this.database
      .prepare(
        "INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, String(value));
  }

  /** Read the diagnostics committed with the current source representations. */
  readPublishedFileWarnings() {
    const raw = this.readMetaRaw("perf_file_warnings");
    if (typeof raw !== "string" || raw === "") return {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      /** @type {Record<string, {sourceKind: string, homeId: string, code: string, count: number, lineNumbers?: number[]}[]>} */
      const out = {};
      for (const [filePath, warnings] of Object.entries(parsed)) {
        const entries = normalizePublishedFileWarnings(warnings);
        if (entries.length > 0) out[filePath] = entries;
      }
      return out;
    } catch {
      return {};
    }
  }

  publishedFileWarningsForRound() {
    const view = this.publishedFileWarningsView;
    if (view === null) return this.readPublishedFileWarnings();
    if (view.warnings === null) view.warnings = this.readPublishedFileWarnings();
    return { ...view.warnings };
  }

  sourceState() {
    return {
      missingSources: decodeMissingSources(this.readMetaRaw(MISSING_SOURCES_META)),
    };
  }
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
   * Atomically publish one prepared archive segment and remove its hot events.
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
    const { assertHistoryArchiveCommitPlan, prepareHistoryArchiveCommit, verifyHistoryArchiveCandidate } = await import(
      "./history-archive.js"
    );
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
   * Read one captured registry record and its source identities from one
   * verified cold snapshot. Internal to archived range reads.
   * @param {Record<string, unknown>} record
   * @param {{startMs: number, endMs: number, afterId: number, limit: number} | null} [page]
   * @param {{path: string, revisions: any[]} | null} [sourceScope]
   * @returns {Promise<{
   *   rows: Array<Record<string, unknown>>,
   *   sourceIdentities: Array<Record<string, unknown>>,
   *   nextAfterId?: number | null
   * }>}
   */
  async readHistoryArchiveSnapshot(record, page = null, sourceScope = null) {
    const { withVerifiedHistoryArchiveCandidate } = await import("./history-archive.js");
    const eventCount = Number(record.event_count);
    return withVerifiedHistoryArchiveCandidate(String(record.database_path), undefined, (database, verified) => {
      const segmentId = assertHistoryArchiveRecordMatches(record, verified);
      if (sourceScope) {
        const total = Number(database.prepare("SELECT COUNT(*) AS count FROM events").get().count);
        if (total !== eventCount) {
          throw historyArchiveError(
            "HISTORY_ARCHIVE_SEGMENT_MISMATCH",
            `archive segment ${segmentId} contains ${total} event(s), expected ${eventCount}`,
          );
        }
        const sourceIdentities = historyArchiveSourceIdentities(database, Number(record.start_ms), Number(record.end_ms));
        validateHistoryArchiveSourceRevisions(database, segmentId, sourceIdentities, sourceScope.revisions);
        return {
          rows: historyArchiveStatementRows(
            database.prepare("SELECT * FROM events WHERE source_path = ? ORDER BY id"),
            [sourceScope.path],
          ),
          sourceIdentities,
        };
      }
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
      const revisions = revisionsBySegment.get(String(record.segment_id)) || [];
      const snapshot = await this.readHistoryArchiveSnapshot(record, null, { path: filePath, revisions });
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
        revisions.filter((revision) => revision.sourceIdentity.path === filePath),
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
   * @param {{completeHistory?: boolean, includeUsageCarrier?: boolean, includeMetadataCarrier?: boolean}} [options]
   * @returns {Promise<{
   *   rows: Array<Record<string, unknown>>,
   *   sourceKinds: Map<string, string>,
   *   homes?: Array<{ id: string, label: string, path: string, kind: string }>,
   *   rateLimitObservations?: import("./usage-types.js").RateLimitObservation[],
   *   metadataCarrier?: {generatedAt: string, homes: any[], warnings: string[]}
   * }>}
   */
  async historyArchiveEventUnionForRange(
    range,
    { completeHistory = false, includeUsageCarrier = false, includeMetadataCarrier = false } = {},
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
    this.assertSourceRepairsComplete();
    this.database.exec("SAVEPOINT history_archive_union_read");
    try {
      const usageCarrier = includeUsageCarrier
        ? {
            homes: publishedUsageHomesFromDatabase(this.database),
            rateLimitObservations: quotaObservationsFromDatabase(this.database),
          }
        : {};
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
      const eventRevisions = historyArchiveEventRevisions(revisionRawValue, revisionSegmentsById);
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
      ...(snapshot.metadataCarrier === undefined ? {} : { metadataCarrier: snapshot.metadataCarrier }),
    };
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
          // WorkBuddy 同样是逐会话转录；会话文件是普通 jsonl。
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
   * Reuse an unchanged source tail only when replacement preserves IDs and order.
   * @param {any} file
   * @param {{ onWarning?: (warning: string) => void }} [options]
   */
  async reuseSourcePrefix({ filePath, source, info }, { onWarning } = {}) {
    const database = this.database;
    if (
      !["claude", "workbuddy", "zcode", "opencode"].includes(source.kind) ||
      typeof database?.isTransaction !== "boolean" ||
      database.isTransaction ||
      this.writeTransactionDepth
    )
      return null;
    const last = database.prepare("SELECT source_path FROM events ORDER BY id DESC LIMIT 1").get();
    const present = database.prepare("SELECT 1 FROM events WHERE source_path=? LIMIT 1").get(filePath);
    if (present && last?.source_path !== filePath) return null;

    const mismatch = new Error("Source facts require complete replacement");
    let previous;
    const closePrevious = () => {
      previous?.return?.();
      previous = null;
    };
    const warnings = [];
    let warningsPublished = false;
    const publishWarnings = () => {
      warningsPublished = true;
      for (const warning of warnings) onWarning?.(warning);
    };
    let reusedEvents = 0,
      insertedEvents = 0;
    database.exec("BEGIN IMMEDIATE");
    this.writeTransactionDepth += 1;
    try {
      const binding = database
        .prepare("SELECT kind,home_id,home_label,home_path FROM source_files WHERE path=?")
        .get(filePath);
      if (
        !sameSourceBinding(binding, source) ||
        database.prepare("SELECT 1 FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META) ||
        database.prepare("SELECT 1 FROM archive_segments LIMIT 1").get() ||
        database.prepare("SELECT 1 FROM temp.sqlite_schema WHERE name IN ('events','source_files') LIMIT 1").get() ||
        database.prepare("PRAGMA main.table_xinfo(events)").all().map((column) => column.name).join(",") !==
          ["id", ...EVENT_INSERT_COLUMNS].join(",") ||
        database.prepare(`SELECT 1 FROM main.sqlite_schema WHERE type='trigger' AND tbl_name='source_files'
          AND name NOT IN ('usage_source_progress_source_update',
            'usage_source_catalog_source_files_INSERT','usage_source_catalog_source_files_UPDATE',
            'usage_source_catalog_source_files_DELETE','usage_all_source_insert',
            'usage_all_source_update','usage_all_source_delete') LIMIT 1`).get() ||
        /\bAUTOINCREMENT\b/i.test(
          String(database.prepare("SELECT sql FROM main.sqlite_schema WHERE name='events'").get()?.sql),
        )
      )
        throw mismatch;
      for (const table of [
        "rate_limit_observations",
        "quota_usage_sources",
        "usage_source_progress",
        "usage_source_baselines",
        "usage_source_reparse",
      ]) {
        if (database.prepare(`SELECT 1 FROM ${table} WHERE source_path=? LIMIT 1`).get(filePath)) throw mismatch;
      }
      const tail = database
        .prepare("SELECT COUNT(*) n,MIN(id) first,MAX(id) last FROM events WHERE source_path=?")
        .get(filePath);
      if (Number(tail.n) > 0) {
        const maximum = database.prepare("SELECT id FROM events ORDER BY id DESC LIMIT 1").get();
        const earlier = database.prepare("SELECT id FROM events WHERE id<? ORDER BY id DESC LIMIT 1").get(tail.first);
        if (
          tail.last !== maximum?.id ||
          Number(tail.last) - Number(tail.first) + 1 !== Number(tail.n) ||
          Number(tail.first) !== Number(earlier?.id ?? 0) + 1
        )
          throw mismatch;
      }
      const statement = database.prepare(
        `SELECT ${EVENT_INSERT_COLUMNS.join(",")} FROM events WHERE source_path=? ORDER BY id`,
      );
      statement.setReturnArrays(true);
      previous = statement.iterate(filePath);
      let exhausted = false;
      const insert = createUsageInsertBatch(database, {
        sqlPrefix: `INSERT INTO events (${EVENT_INSERT_COLUMNS.join(",")}) VALUES`,
        columns: EVENT_INSERT_COLUMNS.length,
      });
      await streamUsageFileEvents(
        filePath,
        source,
        (event) => {
          const row = sourceEventRow(filePath, event),
            values = EVENT_INSERT_COLUMNS.map((column) => row[column]);
          const old = exhausted ? null : previous.next();
          if (old && !old.done) {
            if (values.some((value, index) => value !== old.value[index])) throw mismatch;
            reusedEvents += 1;
          } else {
            exhausted = true;
            insert.add(values);
            insertedEvents += 1;
          }
        },
        { repositoryResolver: this.repositoryResolver, onWarning: (warning) => warnings.push(String(warning)) },
      );
      if (!exhausted && !previous.next().done) throw mismatch;
      closePrevious();
      insert.flush();
      database
        .prepare("UPDATE source_files SET size=?,mtime_ms=?,indexed_at=? WHERE path=?")
        .run(info.size, info.mtimeMs, new Date().toISOString(), filePath);
      const nextFileWarnings = this.publishedFileWarningsForRound();
      delete nextFileWarnings[filePath];
      this.writeMeta("perf_file_warnings", JSON.stringify(nextFileWarnings));
      publishWarnings();
      database.exec("COMMIT");
      this.writeTransactionDepth -= 1;
      if (this.publishedFileWarningsView) this.publishedFileWarningsView.warnings = { ...nextFileWarnings };
      return {
        committed: true,
        appended: false,
        quotaWritten: false,
        reusedPrefix: true,
        reusedEvents,
        insertedEvents,
        checkedEvents: reusedEvents + insertedEvents,
        parsedBytes: info.size,
        prefixBytesRead: 0,
        journalBytes: 0,
      };
    } catch (error) {
      closePrevious();
      database.exec("ROLLBACK");
      this.rollbackReplaceFileTransaction();
      if (error === mismatch) return null;
      if (!warningsPublished) publishWarnings();
      throw error;
    } finally {
      closePrevious();
    }
  }

  /**
   * Replace one discovered source file's ordinary usage facts atomically.
   * @param {any} file
   * @param {{ onWarning?: (warning: string) => void, progress?: boolean }} [options]
   */
  async replaceFile({ filePath, source, info }, { onWarning, progress = true } = {}) {
    const reused = await this.reuseSourcePrefix({ filePath, source, info }, { onWarning });
    if (reused) return reused;
    const database = this.database;
    const codexThreaded = canonicalizeKind(source.kind || "codex") === "codex";
    const hot = !database.prepare("SELECT 1 FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META);
    const proofEligible =
      hot &&
      typeof database.isTransaction === "boolean" &&
      ((codexThreaded && filePath.endsWith(".jsonl")) || source.kind === "dsh");
    const progressEligible = progress && proofEligible;
    const sourceFence = proofEligible ? await this.sourceProof.begin(filePath, info) : null;
    const parsedHash = progressEligible && !sourceFence ? createHash("sha256") : null;
    let parsedOffset = 0;
    /** @type {any} */
    let checkpoint = null;
    let sourceBaseline = null;
    let proofWork = null;
    const sourceBounds = new UsageSourceChangeBounds();
    const replacementFacts = new UsageReplacementFacts(database);
    const oldCumulative = createHash("sha256"),
      nextCumulative = createHash("sha256");
    const parserWarnings = [];
    const siblingPath = filePath.endsWith(".jsonl.zst") ? plainRolloutPath(filePath) : `${filePath}.zst`;
    const representationFingerprint = codexThreaded ? usageSourceFingerprint(filePath) : undefined;
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
    const insertEvent = createUsageInsertBatch(database, {
      sqlPrefix: `INSERT INTO events (${EVENT_INSERT_COLUMNS.join(",")}) VALUES`,
      columns: EVENT_INSERT_COLUMNS.length,
    });
    const insertRateLimitObservation = createUsageInsertBatch(database, {
      sqlPrefix: `
      INSERT INTO rate_limit_observations (
        source_path, line_number, role, observed_at_ms, limit_id, limit_name,
        plan_type, window_minutes, resets_at_ms, used_percent
      ) VALUES`,
      columns: 10,
    });
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
      insertEvent.flush();
      sourceBaseline = { homeId: source.id, sessionId: String(sessionId), beforeMs: timestampMs };
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
    let quotaWritten = false;
    let truncationWarning;
    let truncationEventCount = 0;
    let coldRemovedEventCount = 0;
    const projectLogWarnings = [];
    const projectLogMalformedLines = new Set();
    database.exec("BEGIN IMMEDIATE");
    this.writeTransactionDepth += 1;
    try {
      const previousSource = database
        .prepare("SELECT path, kind, home_id, home_label, home_path, size FROM source_files WHERE path = ?")
        .get(filePath);
      const coldReparse = await this.historyArchiveReparsePrefixes(filePath, source);
      const coldReparsePrefixes = coldReparse.prefixes;
      replacementFacts.capture("events", filePath);
      replacementFacts.capture("rate_limit_observations", filePath);
      const previousSiblingSource = codexThreaded
        ? database
            .prepare(
              "SELECT path, kind, home_id, home_label, home_path FROM source_files WHERE path = ? AND home_id = ?",
            )
            .get(siblingPath, source.id)
        : null;
      if (previousSiblingSource) {
        replacementFacts.capture("events", previousSiblingSource.path);
        replacementFacts.capture("rate_limit_observations", previousSiblingSource.path);
      }
      if (hot && codexThreaded) {
        for (const row of database
          .prepare("SELECT * FROM events WHERE source_path IN (?,?) ORDER BY source_path,id")
          .iterate(filePath, previousSiblingSource?.path || filePath)) {
          addCumulativeFingerprint(oldCumulative, row);
          sourceBounds.add(row.home_id, row.session_id, Number(row.timestamp_ms));
        }
      }
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
      if (previousSiblingSource) {
        database.prepare("DELETE FROM events WHERE source_path = ?").run(previousSiblingSource.path);
        database.prepare("DELETE FROM rate_limit_observations WHERE source_path = ?").run(previousSiblingSource.path);
        database.prepare("DELETE FROM quota_usage_sources WHERE source_path = ?").run(previousSiblingSource.path);
        database.prepare("DELETE FROM source_files WHERE path = ?").run(previousSiblingSource.path);
      }
      await streamUsageFileEvents(
        filePath,
        source,
        (event) => {
          rememberQuotaSource(event);
          const row = sourceEventRow(filePath, event);
          const coldPrefix = coldReparsePrefixes.find(
            (prefix) => row.timestamp_ms >= prefix.startMs && row.timestamp_ms < prefix.endMs,
          );
          if (coldPrefix) {
            coldPrefix.observedRows.push({ ...row });
            return;
          }
          insertEvent.add(EVENT_INSERT_COLUMNS.map((column) => row[column]));
          if (hot && codexThreaded) {
            addCumulativeFingerprint(nextCumulative, row);
            sourceBounds.add(row.home_id, row.session_id, Number(row.timestamp_ms));
          }
        },
        {
          repositoryResolver: this.repositoryResolver,
          previousCumulativeForSession,
          ...(progressEligible
            ? {
                endOffset: info.size,
                onSourceBytes: parsedHash
                  ? (bytes) => {
                      parsedHash.update(bytes);
                      parsedOffset += bytes.length;
                    }
                  : undefined,
                onProgress: (value) => {
                  checkpoint = value;
                },
              }
            : {}),
          onQuotaSource: rememberQuotaSource,
          onRateLimit: ["main", "jetbrains", "extra", "codex"].includes(source.kind)
            ? (observation) => {
                insertRateLimitObservation.add([
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
                ]);
                quotaWritten = true;
              }
            : undefined,
          onWarning:
            String(source.kind ?? "") === "project-log"
              ? (warning, details) => {
                  projectLogWarnings.push(String(warning));
                  const lineNumber = Number(details?.lineNumber);
                  if (Number.isSafeInteger(lineNumber) && lineNumber > 0) {
                    projectLogMalformedLines.add(lineNumber);
                  }
                }
              : progressEligible
                ? (warning) => parserWarnings.push(String(warning))
                : onWarning,
        },
      );
      insertEvent.flush();
      insertRateLimitObservation.flush();
      let coldRevisionStateChanged = false;
      for (const prefix of coldReparsePrefixes) {
        const revision = historyArchiveColdRevisionForRows(prefix);
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
      if (previousSource) {
        const counts = replacementFacts.save(
          insertReplacedFact,
          "events",
          previousSource,
          HISTORY_REPLACED_FACT_METHOD_VERSION,
        );
        if (
          String(previousSource.kind ?? "") === "project-log" &&
          String(source.kind ?? "") === "project-log" &&
          info.size < Number(previousSource.size) &&
          counts.currentCount < counts.previousCount
        ) {
          truncationEventCount = counts.previousCount - counts.currentCount;
        }
      }
      if (String(source.kind ?? "") === "project-log") {
        truncationEventCount += coldRemovedEventCount;
        if (truncationEventCount > 0) {
          truncationWarning = formatProjectLogTruncationWarning(filePath, truncationEventCount);
        }
      }
      if (previousSiblingSource) {
        replacementFacts.save(
          insertReplacedFact,
          "events",
          previousSiblingSource,
          HISTORY_REPLACED_FACT_METHOD_VERSION,
        );
        replacementFacts.save(
          insertReplacedFact,
          "rate_limit_observations",
          previousSiblingSource,
          HISTORY_REPLACED_QUOTA_METHOD_VERSION,
        );
      }
      if (previousSource) {
        replacementFacts.save(
          insertReplacedFact,
          "rate_limit_observations",
          previousSource,
          HISTORY_REPLACED_QUOTA_METHOD_VERSION,
        );
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
      } else {
        delete nextFileWarnings[filePath];
      }
      this.writeMeta("perf_file_warnings", JSON.stringify(nextFileWarnings));
      if (hot && codexThreaded && typeof database.isTransaction === "boolean") {
        writeUsageSourceBaseline(database, filePath, sourceBaseline);
        if (oldCumulative.digest("hex") !== nextCumulative.digest("hex")) {
          markUsageSourceDependents(database, filePath, sourceBounds);
        }
      }
      if (progressEligible && checkpoint) {
        const sessionId = sourceSessionId(checkpoint, filePath);
        if (
          !codexThreaded ||
          (previousQuotaSources.size <= 1 && (!previousQuotaSources.size || previousQuotaSources.has(sessionId)))
        ) {
          checkpoint = {
            ...checkpoint,
            store: { format: 1, sessionId, lastQuotaSource: previousQuotaSources.get(sessionId) ?? null },
          };
          proofWork = await this.sourceProof.capture(
            filePath,
            checkpoint.offset,
            info,
            sourceFence,
            parsedHash ? { offset: parsedOffset, digest: parsedHash.copy().digest("hex") } : null,
          );
          writeUsageSourceProgress(database, filePath, checkpoint, proofWork.validation);
        } else checkpoint = null;
      }
      if (!checkpoint) {
        database.prepare("DELETE FROM usage_source_progress WHERE source_path=?").run(filePath);
        if (sourceFence || parsedHash)
          proofWork = await this.sourceProof.capture(
            filePath,
            0,
            info,
            sourceFence,
            parsedHash ? { offset: parsedOffset, digest: parsedHash.copy().digest("hex") } : null,
          );
      }
      if (hot && (codexThreaded || source.kind === "dsh")) {
        const after = await stat(filePath);
        if (
          after.size !== info.size ||
          after.mtimeMs !== info.mtimeMs ||
          after.ctimeMs !== info.ctimeMs ||
          usageSourceIdentity(after) !== usageSourceIdentity(info)
        ) {
          throw Object.assign(new Error("Source changed while indexing"), { code: "LIVE_SOURCE_CHANGED" });
        }
      }
      if (
        representationFingerprint !== undefined &&
        (representationFingerprint === null || usageSourceFingerprint(filePath) !== representationFingerprint)
      ) {
        throw Object.assign(new Error("Codex rollout changed during representation indexing"), {
          code: "LIVE_SOURCE_CHANGED",
        });
      }
      database.prepare("DELETE FROM usage_source_reparse WHERE source_path=?").run(filePath);
      for (const warning of parserWarnings) onWarning?.(warning);
      database.exec("COMMIT");
      if (this.writeTransactionDepth > 0) this.writeTransactionDepth -= 1;
      if (this.publishedFileWarningsView) {
        this.publishedFileWarningsView.warnings = { ...nextFileWarnings };
      }
      return {
        committed: true,
        quotaWritten,
        truncationWarning,
        projectLogWarnings,
        appended: false,
        parsedBytes: info.size,
        sourceValidation: proofWork?.validation,
        prefixBytesRead: proofWork?.readBytes || 0,
        journalBytes: (sourceFence?.journalBytes || 0) + (proofWork?.journalBytes || 0),
      };
    } catch (error) {
      database.exec("ROLLBACK");
      this.rollbackReplaceFileTransaction();
      if (progressEligible && error.code === "SOURCE_PROGRESS_UNSUPPORTED") {
        return this.replaceFile({ filePath, source, info }, { onWarning, progress: false });
      }
      throw error;
    } finally {
      sourceBounds.close();
      replacementFacts.close();
    }
  }

  /**
   * Return null when an exact append cannot be proved; the caller then replaces the source.
   * @param {any} file
   * @param {{ onWarning?: (warning: string) => void }} [options]
   */
  async appendFile({ filePath, source, info }, { onWarning } = {}) {
    const database = this.database;
    if (
      typeof database.isTransaction !== "boolean" ||
      database.prepare("SELECT 1 FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META) ||
      database.prepare("SELECT 1 FROM usage_source_reparse WHERE source_path=?").get(filePath)
    )
      return null;
    const existing = database.prepare("SELECT * FROM source_files WHERE path=?").get(filePath);
    const saved = readUsageSourceProgress(database, filePath);
    if (
      !sameSourceBinding(existing, source) ||
      !saved ||
      info.size < Number(existing.size) ||
      saved.checkpoint.store?.format !== 1
    )
      return null;
    const verified = await this.sourceProof.verify(filePath, saved.validation, saved.checkpoint.offset, info);
    if (!verified) return null;
    const parsedHash = verified.hash && !verified.nativeFence ? verified.hash.copy() : null;
    let parsedOffset = verified.offset;
    const codex = saved.checkpoint.adapter === "codex-jsonl";
    const sessionId = saved.checkpoint.store.sessionId;
    let baseline = readUsageSourceBaseline(database, filePath);
    let lastQuotaSource = saved.checkpoint.store.lastQuotaSource;
    /** @type {any} */
    let checkpoint = null;
    let quotaWritten = false;
    const warnings = [];
    const bounds = new UsageSourceChangeBounds();
    const unsupported = () =>
      Object.assign(new Error("Source requires complete parsing"), { code: "SOURCE_PROGRESS_UNSUPPORTED" });
    const eventInsert = database.prepare(`INSERT INTO events (${EVENT_INSERT_COLUMNS.join(",")})
      VALUES (${EVENT_INSERT_COLUMNS.map(() => "?").join(",")})`);
    const quotaInsert = database.prepare(`INSERT OR REPLACE INTO quota_usage_sources
      (source_path,home_id,session_id,timestamp_ms,quota_source,until_ms) VALUES (?,?,?,?,?,?)`);
    const rateInsert = database.prepare(`INSERT INTO rate_limit_observations
      (source_path,line_number,role,observed_at_ms,limit_id,limit_name,plan_type,window_minutes,resets_at_ms,used_percent)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const rememberQuotaSource = (event) => {
      if (!codex || !Number.isFinite(event.timestampMs)) return;
      if (event.sessionId !== sessionId) throw unsupported();
      const value = `${event.quotaSource || "unknown"}:${event.quotaSourceUntil || 0}`;
      if (value === lastQuotaSource) return;
      quotaInsert.run(
        filePath,
        event.homeId,
        event.sessionId,
        event.timestampMs,
        event.quotaSource || "unknown",
        event.quotaSourceUntil || 0,
      );
      lastQuotaSource = value;
    };
    database.exec("BEGIN IMMEDIATE");
    this.writeTransactionDepth += 1;
    try {
      // Verification awaited filesystem I/O: another connection may have replaced the cursor meanwhile.
      if (
        JSON.stringify(readUsageSourceProgress(database, filePath)) !== JSON.stringify(saved) ||
        database.prepare("SELECT 1 FROM usage_source_reparse WHERE source_path=?").get(filePath)
      )
        throw unsupported();
      await streamUsageFileEvents(
        filePath,
        source,
        (event) => {
          if (codex && event.sessionId !== sessionId) throw unsupported();
          rememberQuotaSource(event);
          const row = sourceEventRow(filePath, event);
          eventInsert.run(...EVENT_INSERT_COLUMNS.map((column) => row[column]));
          if (codex) bounds.add(row.home_id, row.session_id, Number(row.timestamp_ms));
        },
        {
          repositoryResolver: this.repositoryResolver,
          resume: saved.checkpoint,
          endOffset: info.size,
          onSourceBytes: parsedHash
            ? (bytes) => {
                parsedHash.update(bytes);
                parsedOffset += bytes.length;
              }
            : undefined,
          onProgress: (value) => {
            checkpoint = value;
          },
          onWarning: (warning) => warnings.push(String(warning)),
          onQuotaSource: rememberQuotaSource,
          onRateLimit: codex
            ? (row) => {
                rateInsert.run(
                  filePath,
                  row.lineNumber,
                  row.role,
                  row.observedAtMs,
                  row.limitId,
                  row.limitName,
                  row.planType,
                  row.windowMinutes,
                  row.resetsAtMs,
                  row.usedPercent,
                );
                quotaWritten = true;
              }
            : undefined,
          previousCumulativeForSession: (id, timestamp) => {
            const beforeMs = Date.parse(timestamp);
            if (!Number.isSafeInteger(beforeMs)) return null;
            baseline = { homeId: source.id, sessionId: String(id), beforeMs };
            const row = database
              .prepare(`SELECT COUNT(*) AS count,SUM(total) AS total,SUM(input) AS input,
            SUM(cached) AS cached,SUM(output) AS output,SUM(reasoning) AS reasoning,
            MIN(detail_mask & 1) AS i,MIN(detail_mask & 2) AS c,MIN(detail_mask & 4) AS o,
            MIN(detail_mask & 8) AS r,SUM(cache_write_tokens) AS writes,MIN(cache_write_known) AS known
            FROM events WHERE session_id=? AND home_id=? AND source_path<>? AND timestamp_ms<?`)
              .get(id, source.id, filePath, beforeMs);
            return row.count
              ? {
                  usage: usageFromRow(row),
                  detailMask: Number(row.i || 0) | Number(row.c || 0) | Number(row.o || 0) | Number(row.r || 0),
                  cacheWrite: { tokens: Number(row.writes || 0), known: Boolean(row.known) },
                }
              : null;
          },
        },
      );
      if (!checkpoint || sourceSessionId(checkpoint, filePath) !== sessionId) throw unsupported();
      checkpoint = { ...checkpoint, store: { format: 1, sessionId, lastQuotaSource } };
      const proof = await this.sourceProof.capture(
        filePath,
        checkpoint.offset,
        info,
        verified,
        parsedHash ? { offset: parsedOffset, digest: parsedHash.copy().digest("hex") } : null,
      );
      database
        .prepare("UPDATE source_files SET size=?,mtime_ms=?,indexed_at=? WHERE path=?")
        .run(info.size, info.mtimeMs, new Date().toISOString(), filePath);
      if (codex) {
        writeUsageSourceBaseline(database, filePath, baseline);
        markUsageSourceDependents(database, filePath, bounds);
      }
      if (!writeUsageSourceProgress(database, filePath, checkpoint, proof.validation)) throw unsupported();
      for (const warning of warnings) onWarning?.(warning);
      database.exec("COMMIT");
      this.writeTransactionDepth -= 1;
      return {
        committed: true,
        quotaWritten,
        appended: true,
        sessionId,
        parsedBytes: info.size - saved.checkpoint.offset,
        prefixBytesRead: (verified.readBytes || 0) + (proof.readBytes || 0),
        journalBytes: (verified.journalBytes || 0) + (proof.journalBytes || 0),
      };
    } catch (error) {
      database.exec("ROLLBACK");
      this.rollbackReplaceFileTransaction();
      if (error.code === "SOURCE_PROGRESS_UNSUPPORTED") return null;
      throw error;
    } finally {
      bounds.close();
    }
  }

  async recertifyUnchangedFile({ filePath, info }, saved) {
    if (!saved || saved.checkpoint.offset !== info.size) return false;
    // A returned file may have a new inode. An identical full certified prefix preserves the existing facts.
    const validation =
      saved.validation.kind === USAGE_SOURCE_SHA_KIND
        ? { ...saved.validation, identity: usageSourceIdentity(info) }
        : saved.validation;
    const verified = await this.sourceProof.verify(filePath, validation, saved.checkpoint.offset, info);
    if (!verified) return false;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (JSON.stringify(readUsageSourceProgress(this.database, filePath)) !== JSON.stringify(saved)) {
        this.database.exec("ROLLBACK");
        return false;
      }
      const proof = await this.sourceProof.capture(filePath, saved.checkpoint.offset, info, verified);
      writeUsageSourceProgress(this.database, filePath, saved.checkpoint, proof.validation);
      this.database.exec("COMMIT");
      this.lastSyncSourceWork.prefixBytesRead += (verified.readBytes || 0) + (proof.readBytes || 0);
      this.lastSyncSourceWork.journalBytes += (verified.journalBytes || 0) + (proof.journalBytes || 0);
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  async checkSources(options = this.options) {
    await this.open();
    this.sourceAcquisition ||= new UsageSourceAcquisition(this);
    const status = await this.sourceAcquisition.checkUnchanged(options);
    this.lastAcquisitionWork = this.sourceAcquisition.work;
    return status;
  }

  async sync(args = {}) {
    const view = { warnings: null };
    this.publishedFileWarningsView = view;
    try {
      await this.open();
      this.sourceAcquisition ||= new UsageSourceAcquisition(this);
      const acquisition = this.sourceAcquisition;
      const options = args.options || this.options;
      const plan = args.forceFull ? null : await acquisition.prepare(options, args.sourceHints);
      if (!plan && args.certifiedOnly) {
        this.lastAcquisitionWork = acquisition.work;
        return null;
      }
      let bootstrap = null;
      if (!plan) {
        try { bootstrap = await acquisition.beginFull(options); }
        catch (error) {
          if (!["ENOENT", "EACCES", "EPERM"].includes(error.code)) throw error;
          acquisition.work = { mode: "fallback", reason: error.code };
        }
      }
      try {
        const result = await this.syncRound({ ...args, acquisitionPlan: plan });
        const receipt = await acquisition.complete(options, plan || bootstrap, this.acquisitionFiles || [], result, !plan);
        this.lastAcquisitionWork = acquisition.work;
        if (plan && !receipt) {
          // Facts may have committed. A full retry reuses their parser checkpoints.
          return await this.sync({ ...args, certifiedOnly: false, forceFull: true });
        }
        return { ...result, ...(receipt ? { acquisition: receipt } : {}) };
      } catch (error) {
        acquisition.invalidate();
        if (plan && error.code === "SOURCE_COVERAGE_UNAVAILABLE")
          return await this.sync({ ...args, certifiedOnly: false, forceFull: true });
        throw error;
      }
    } finally {
      if (this.publishedFileWarningsView === view) this.publishedFileWarningsView = null;
      this.acquisitionFiles = null;
    }
  }

  assertSourceRepairsComplete() {
    if (this.database.prepare("SELECT 1 FROM usage_source_reparse LIMIT 1").get()) {
      throw Object.assign(
        new Error("Source dependency repair is incomplete; retry when the affected source is available"),
        {
          code: "SOURCE_DEPENDENCY_PENDING",
        },
      );
    }
  }

  /**
   * Discover sources, replace changed usage files, refresh missing-source state,
   * and rebuild ordinary usage projections and rollups.
   * @param {{ options?: any, acquisitionPlan?: any }} [args]
   */
  async syncRound({ options, acquisitionPlan: plan } = {}) {
    await this.open();
    this.syncDerivedRevision();
    createUsageRollups(this.database);
    const syncOptions = options || this.options;
    this.options = syncOptions;
    const homes = plan?.homes || await discoverUsageSources(syncOptions);
    const quotaObservations = readCodexQuotaObservations({ ...syncOptions, homes });
    if (quotaObservations.length) {
      const saved = JSON.stringify(quotaObservations);
      if (this.readMetaRaw("official_quota_observations") !== saved) {
        this.writeMeta("official_quota_observations", saved);
        this.commitStoreRevision("quota");
      }
    }

    const { files, warnings, failedHomes = [] } = plan
      ? { files: plan.files, warnings: [...plan.warnings] }
      : await this.usageFiles(homes);
    this.acquisitionFiles = files;
    const status = plan ? {
      fingerprint: files.length ? createHash("sha256").update(plan.fingerprint).update(JSON.stringify(plan.volumes)).digest("hex") : plan.fingerprint,
      checkedAt: new Date().toISOString(), fileCount: plan.fileCount,
    } : await buildUsageFingerprint({ ...syncOptions, homes, scannedFiles: files, failedHomes });
    const knownFiles = new Set(files.map((file) => file.filePath));
    const failedHomeIds = new Set(failedHomes.map((home) => home.id));
    const failedHomePaths = new Set(failedHomes.map((home) => home.path));
    const sourceRowsBefore = plan ? [] : this.database.prepare("SELECT * FROM source_files").all();
    let publishedFingerprints = {};
    try {
      publishedFingerprints = plan ? {} : JSON.parse(this.readMetaRaw("usage_file_fingerprints") || "{}");
      if (!publishedFingerprints || typeof publishedFingerprints !== "object" || Array.isArray(publishedFingerprints))
        publishedFingerprints = {};
    } catch {
      // The committed usage rows remain authoritative if this small scan cache is unavailable.
    }
    if (!plan) {
      for (const row of this.database.prepare("SELECT payload FROM usage_source_catalog WHERE role='file'").iterate()) {
        try {
          const saved = JSON.parse(String(row.payload));
          if (saved.fingerprint) publishedFingerprints[saved.filePath] = saved.fingerprint;
        } catch { /* Rebuildable catalog; full source verification remains authoritative. */ }
      }
    }
    const nextFingerprints = { ...publishedFingerprints };
    const currentFingerprints = new Map(files.map((file) => [file.filePath, usageSourceFingerprint(file.filePath)]));
    const committedPaths = new Set();
    const changedSessions = new Set();
    let updatedFileCount = 0;
    let usageDerivedChanged = false;
    const sourceWork = { appendedFiles: 0, replacedFiles: 0, parsedBytes: 0, prefixBytesRead: 0, journalBytes: 0 };
    this.lastSyncSourceWork = sourceWork;
    const acceptSource = (file, outcome) => {
      updatedFileCount += 1;
      committedPaths.add(file.filePath);
      nextFingerprints[file.filePath] = usageSourceFingerprint(file.filePath);
      file.sourceValidation = outcome.sourceValidation;
      sourceWork[outcome.appended ? "appendedFiles" : "replacedFiles"] += 1;
      for (const key of ["parsedBytes", "prefixBytesRead", "journalBytes"]) sourceWork[key] += outcome[key] || 0;
      if (outcome.appended) changedSessions.add(outcome.sessionId);
      else
        for (const row of this.database
          .prepare("SELECT DISTINCT session_id FROM events WHERE source_path=?")
          .all(file.filePath))
          changedSessions.add(row.session_id);
      usageDerivedChanged = true;
      if (outcome.truncationWarning) warnings.push(outcome.truncationWarning);
      for (const warning of outcome.projectLogWarnings || []) warnings.push(warning);
      this.commitStoreRevision(outcome.quotaWritten ? "usage+quota" : "usage");
    };

    for (const file of files) {
      const existing = this.database
        .prepare("SELECT size, mtime_ms, kind, home_id, home_label, home_path FROM source_files WHERE path = ?")
        .get(file.filePath);
      const savedProgress = existing ? readUsageSourceProgress(this.database, file.filePath) : null;
      const unchanged =
        existing &&
        Number(existing.size) === file.info.size &&
        Number(existing.mtime_ms) === file.info.mtimeMs &&
        existing.kind === (file.source.kind || "codex") &&
        existing.home_id === file.source.id &&
        existing.home_label === file.source.label &&
        existing.home_path === file.source.path &&
        (publishedFingerprints[file.filePath] === undefined ||
          publishedFingerprints[file.filePath] === currentFingerprints.get(file.filePath));
      const earlierFileChanged =
        existing &&
        changedSessions.size > 0 &&
        this.database
          .prepare("SELECT DISTINCT session_id FROM events WHERE source_path = ?")
          .all(file.filePath)
          .some((row) => changedSessions.has(row.session_id));
      const needsReparse = Boolean(
        this.database.prepare("SELECT 1 FROM usage_source_reparse WHERE source_path=?").get(file.filePath),
      );
      if (!file.force && unchanged && !earlierFileChanged && !needsReparse) {
        const proofCurrent =
          !savedProgress ||
          ([USAGE_SOURCE_SHA_KIND, "ntfs-usn-v1"].includes(savedProgress.validation.kind) &&
            savedProgress.validation.identity === usageSourceIdentity(file.info) &&
            savedProgress.validation.ctimeMs === file.info.ctimeMs);
        if (proofCurrent || (await this.recertifyUnchangedFile(file, savedProgress))) {
          nextFingerprints[file.filePath] = currentFingerprints.get(file.filePath);
          continue;
        }
      }
      try {
        const callbacks = { onWarning: (warning) => warnings.push(String(warning)), progress: file.readMode !== "full" };
        const outcome =
          (!earlierFileChanged && !needsReparse && file.readMode !== "full" ? await this.appendFile(file, callbacks) : null) ||
          (await this.replaceFile(file, callbacks));
        if (!outcome?.committed) {
          if (plan) throw Object.assign(new Error("Selected source did not commit"), { code: "LIVE_SOURCE_CHANGED" });
          continue;
        }
        acceptSource(file, outcome);
      } catch (error) {
        if (plan) throw error;
        if (needsReparse || error.code === "LIVE_SOURCE_CHANGED") throw error;
        if (canonicalizeKind(file.source.kind) === "codex" && (Number(error?.errcode) & 0xff) === 19) throw error;
        warnings.push(`无法索引 ${file.filePath}: ${error.message}`);
      }
    }

    // Dependencies may precede their changed producer in discovery order, or survive a process crash.
    const availableFiles = new Map(files.map((file) => [file.filePath, file]));
    while (true) {
      const pending = this.database.prepare(`SELECT source_path FROM usage_source_reparse ORDER BY source_path${plan ? " LIMIT 2049" : ""}`).all();
      if (plan && pending.length > 2048)
        throw Object.assign(new Error("Source dependency budget exceeded"), { code: "SOURCE_COVERAGE_UNAVAILABLE" });
      const available = [];
      for (const row of pending) {
        const file = availableFiles.get(String(row.source_path)) || (plan ? await this.sourceAcquisition.file(String(row.source_path)) : null);
        if (file) {
          available.push(file);
          if (!availableFiles.has(file.filePath)) {
            if (plan && availableFiles.size >= 2048)
              throw Object.assign(new Error("Source dependency budget exceeded"), { code: "SOURCE_COVERAGE_UNAVAILABLE" });
            availableFiles.set(file.filePath, file);
            files.push(file);
          }
        }
      }
      if (!available.length) break;
      for (const file of available) {
        const outcome = await this.replaceFile(
          { ...file, info: await stat(file.filePath) },
          {
            onWarning: (warning) => warnings.push(String(warning)),
            progress: file.readMode !== "full",
          },
        );
        acceptSource(file, outcome);
      }
    }
    this.assertSourceRepairsComplete();

    for (const old of sourceRowsBefore) {
      if (knownFiles.has(old.path) || failedHomeIds.has(old.home_id) || failedHomePaths.has(old.home_path)) continue;
      const fingerprint = publishedFingerprints[old.path];
      const matchingOldPaths = sourceRowsBefore.filter(
        (row) =>
          !knownFiles.has(row.path) &&
          row.home_id === old.home_id &&
          canonicalizeKind(row.kind) === canonicalizeKind(old.kind) &&
          publishedFingerprints[row.path] === fingerprint,
      );
      if (matchingOldPaths.length !== 1) continue;
      const replacements = files.filter(
        (file) =>
          committedPaths.has(file.filePath) &&
          file.source.id === old.home_id &&
          canonicalizeKind(file.source.kind) === canonicalizeKind(old.kind) &&
          typeof fingerprint === "string" &&
          nextFingerprints[file.filePath] === fingerprint,
      );
      if (replacements.length !== 1) continue;
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.prepare("DELETE FROM quota_usage_sources WHERE source_path = ?").run(old.path);
        this.database.prepare("DELETE FROM source_files WHERE path = ?").run(old.path);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
      delete nextFingerprints[String(old.path)];
      usageDerivedChanged = true;
      this.commitStoreRevision("usage-delete");
    }

    const publishedFileWarnings = this.publishedFileWarningsForRound();
    if (!plan) {
    const activeSourcePaths = new Set(
      this.database
        .prepare("SELECT path FROM source_files")
        .all()
        .map((row) => String(row.path)),
    );
    for (const filePath of Object.keys(publishedFileWarnings)) {
      if (!activeSourcePaths.has(filePath)) delete publishedFileWarnings[filePath];
    }
    for (const filePath of Object.keys(nextFingerprints)) {
      if (!activeSourcePaths.has(filePath)) delete nextFingerprints[filePath];
    }
    }
    for (const [filePath, fileWarnings] of Object.entries(publishedFileWarnings)) {
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
    if (this.publishedFileWarningsView) {
      this.publishedFileWarningsView.warnings = { ...publishedFileWarnings };
    }
    const publishedFileWarningsSnapshot = JSON.stringify(publishedFileWarnings);

    const previousMissingSources = decodeMissingSources(this.readMetaRaw(MISSING_SOURCES_META));
    const previousMissingByPath = new Map(previousMissingSources.map((source) => [source.path, source]));
    const missingSinceMs = Date.now();
    const missingSources = plan ? plan.missingSources : this.database
      .prepare("SELECT path, kind, home_id, home_label, home_path FROM source_files ORDER BY path")
      .all()
      .filter(
        (row) =>
          !knownFiles.has(String(row.path)) && !failedHomeIds.has(row.home_id) && !failedHomePaths.has(row.home_path),
      )
      .map((row) => {
        const previous = previousMissingByPath.get(String(row.path));
        const kind = String(row.kind ?? "");
        const homeId = String(row.home_id ?? "");
        return {
          path: String(row.path),
          kind,
          homeId,
          homeLabel: String(row.home_label ?? ""),
          homePath: String(row.home_path ?? ""),
          missingSinceMs:
            previous?.kind === kind && previous?.homeId === homeId ? previous.missingSinceMs : missingSinceMs,
        };
      });

    const nextServiceTierEvidence = loadServiceTierEvidence(homes);
    const nextQuotaEvidence = loadQuotaSourceEvidence(
      homes,
      this.quotaSourceEvidence && quotaSourceEvidenceSnapshot(this.quotaSourceEvidence),
    );
    const quotaEvidenceSnapshot = JSON.stringify(quotaSourceEvidenceSnapshot(nextQuotaEvidence));
    const previousQuotaEvidence = this.readMetaRaw("quota_source_log_evidence");
    if (quotaEvidenceSnapshot !== previousQuotaEvidence) {
      this.writeMeta("quota_source_log_evidence", quotaEvidenceSnapshot);
      if (previousQuotaEvidence !== undefined || quotaSourceEvidenceSnapshot(nextQuotaEvidence).entries.length) {
        this.commitStoreRevision("quota-source");
      }
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
        // Custom resolvers cannot be compared safely; replacing them is conservative.
      }
    }
    if (!sameServiceTierEvidence) this.serviceTierEvidence = nextServiceTierEvidence;
    const serviceTierSignature = this.serviceTierEvidenceSignature(homes);
    if (
      this.serviceTierEvidenceInput !== null &&
      (serviceTierSignature !== this.serviceTierEvidenceInput || !sameServiceTierEvidence)
    ) {
      this.commitStoreRevision("service-tier");
    }
    this.serviceTierEvidenceInput = serviceTierSignature;

    const previousHomeShape = this.homes
      .map((home) => `${home?.kind}\u0000${home?.id}\u0000${home?.label}\u0000${home?.path}`)
      .join("\n");
    const nextHomeShape = homes
      .map((home) => `${home?.kind}\u0000${home?.id}\u0000${home?.label}\u0000${home?.path}`)
      .join("\n");
    const homeSetChanged = previousHomeShape !== nextHomeShape;
    if (homeSetChanged && !usageDerivedChanged) this.commitStoreRevision("home");

    this.homes = homes;
    this.generatedAt = new Date().toISOString();
    this.fingerprint = status.fingerprint;
    this.checkedAt = status.checkedAt;
    this.warnings = warnings;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.writeMeta("generated_at", this.generatedAt);
      this.writeMeta("fingerprint", this.fingerprint);
      if (!plan) this.writeMeta("usage_file_fingerprints", JSON.stringify(nextFingerprints));
      if (this.readMetaRaw("perf_file_warnings") !== publishedFileWarningsSnapshot) {
        this.writeMeta("perf_file_warnings", publishedFileWarningsSnapshot);
      }
      this.writeMeta(MISSING_SOURCES_META, JSON.stringify(missingSources));
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    if (usageDerivedChanged || homeSetChanged || this.storeRevision !== this.derivedRevision) {
      this.metadataCache = null;
      this.periodComparisonCache.clear();
      this.metadataObservationCache = null;
      this.summaryProjectionCache = null;
      this.quotaObservationCache = null;
    } else if (this.metadataCache !== null) {
      this.metadataCache.generatedAt = this.generatedAt;
      this.metadataCache.warnings = this.warnings;
    }
    this.derivedRevision = this.storeRevision;

    for (const file of files) file.acquisitionFingerprint = nextFingerprints[file.filePath];

    const dirtyRollupDays = listDirtyUsageRollupDays(this.database);
    const localRollupZone = currentLocalRollupZoneIdentity();
    const localRollupZoneChanged = this.readMetaRaw(LOCAL_ROLLUP_ZONE_META) !== localRollupZone;
    this.lastSyncRollupWork = null;
    if (
      dirtyRollupDays.length > 0 &&
      !localRollupZoneChanged &&
      historyArchiveAuthorizedSegmentIds(this.database).size === 0
    ) {
      this.lastSyncRollupWork = this.withBusinessProjection(() =>
        tryAppendUsageRollups(this.database, { zoneIdentity: localRollupZone }),
      );
    }
    if ((dirtyRollupDays.length > 0 && !this.lastSyncRollupWork?.applied) || localRollupZoneChanged) {
      if (historyArchiveAuthorizedSegmentIds(this.database).size > 0) {
        this.database.exec("BEGIN IMMEDIATE");
        this.writeTransactionDepth += 1;
        try {
          const roundDirtyDays = listDirtyUsageRollupDays(this.database);
          await this.withSqlHistoryReader((reader) => {
            function* eventsFor(days, calendarZone) {
              if (days.length === 0) return;
              const ordered = [...days].sort();
              const range = resolveDateRange({ preset: "custom", startDate: ordered[0], endDate: ordered.at(-1), calendarZone });
              const statement = reader.database.prepare(
                "SELECT * FROM events WHERE timestamp_ms >= ? AND timestamp_ms <= ? ORDER BY id",
              );
              for (const row of statement.iterate(range.start.getTime(), range.end.getTime())) {
                yield publishedUsageEventFromRow(row, "unknown", null);
              }
            }
            if (roundDirtyDays.length > 0) {
              rebuildUsageRollupsFromEvents(this.database, { days: roundDirtyDays, events: eventsFor(roundDirtyDays, "utc") });
            }
            const localDays = new Set(localUsageRollupDaysForUtcDays(roundDirtyDays));
            if (localRollupZoneChanged) {
              const eventUtcDays = reader.database
                .prepare("SELECT DISTINCT date(timestamp_ms / 1000.0, 'unixepoch') AS day_key FROM events")
                .all()
                .map((row) => {
                  if (row.day_key === null) throw new TypeError("complete history contains an invalid event timestamp");
                  return String(row.day_key);
                });
              for (const day of localUsageRollupDaysForUtcDays(eventUtcDays)) localDays.add(day);
              for (const row of this.database
                .prepare("SELECT day_key FROM usage_rollup_days WHERE calendar_zone = 'local'")
                .all()) {
                localDays.add(String(row.day_key));
              }
            }
            const days = [...localDays].sort();
            rebuildUsageRollupsFromEvents(this.database, {
              days,
              events: eventsFor(days, "local"),
              calendarZone: "local",
            });
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
        this.database.exec("SAVEPOINT usage_rollup_sync");
        try {
          const initial = tryInitializeUsageRollups(this.database, { zoneIdentity: localRollupZone });
          if (!initial.applied && dirtyRollupDays.length > 0) {
            rebuildUsageRollups(this.database, { days: dirtyRollupDays, calendarZone: "utc" });
          }
          const localDays = new Set(localUsageRollupDaysForUtcDays(dirtyRollupDays));
          if (!initial.applied && localRollupZoneChanged) {
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
          if (!initial.applied)
            rebuildUsageRollups(this.database, { days: [...localDays].sort(), calendarZone: "local" });
          this.writeMeta(LOCAL_ROLLUP_ZONE_META, localRollupZone);
          const checkpoint = initial.applied
            ? initial.checkpoint
            : checkpointUsageRollups(this.database, { zoneIdentity: localRollupZone });
          this.lastSyncRollupWork = initial.applied
            ? initial
            : { ...this.lastSyncRollupWork, fallbackDays: dirtyRollupDays.length, checkpoint };
          this.database.exec("RELEASE usage_rollup_sync");
        } catch (error) {
          this.database.exec("ROLLBACK TO usage_rollup_sync");
          this.database.exec("RELEASE usage_rollup_sync");
          throw error;
        }
      }
    }

    if (this.deferredMetadataIndex && this.database.prepare("SELECT 1 FROM events LIMIT 1").get()) {
      this.database.exec("SAVEPOINT initial_metadata_index");
      try {
        ensureUsageMetadataSchema(this.database);
        this.database.prepare("DELETE FROM store_meta WHERE key=?").run(DEFERRED_METADATA_INDEX_META);
        this.database.exec("RELEASE initial_metadata_index");
        this.deferredMetadataIndex = false;
      } catch (error) {
        this.database.exec("ROLLBACK TO initial_metadata_index; RELEASE initial_metadata_index");
        throw error;
      }
    }

    if (
      !this.usageProjectionTracker &&
      !this.database.isTransaction &&
      !this.database.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META)
    ) {
      this.syncDerivedRevision();
      this.installUsageProjectionTracker();
      this.observedUsageProjectionChanges = this.usageProjectionChangeKey();
    }
    return {
      ...status,
      updatedFileCount,
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
    const rows = quotaObservationsFromDatabase(this.database, this.verifiedHistorySqlRead && !this.historyDiskRead);
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

  /** @param {Date | number} [asOf] */
  storedMetadata(asOf = new Date()) {
    if (
      this.writeTransactionDepth > 0 ||
      this.verifiedHistorySqlRead ||
      this.database.prepare("SELECT 1 FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META) ||
      this.database
        .prepare("PRAGMA index_list(events)")
        .all()
        .some((row) => Number(row.unique) !== 0)
    )
      return null;
    this.database.exec("SAVEPOINT metadata_projection_read");
    try {
      return readStoredMetadata(this.database, typeof asOf === "number" ? asOf : asOf.getTime());
    } finally {
      this.database.exec("RELEASE metadata_projection_read");
    }
  }

  prepareMetadataProjection() {
    if (this.deferredMetadataIndex || this.database.isTransaction || this.writeTransactionDepth > 0) return;
    if (this.storedMetadata(Number.MAX_SAFE_INTEGER)) {
      this.lastMetadataWork = { readEvents: 0, rebuilt: false, reused: true };
      return;
    }
    if (
      this.verifiedHistorySqlRead ||
      this.database.prepare("SELECT 1 FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META) ||
      this.database
        .prepare("PRAGMA index_list(events)")
        .all()
        .some((row) => Number(row.unique) !== 0)
    )
      return;
    if (!this.usageProjectionTracker) {
      this.installUsageProjectionTracker();
      this.observedUsageProjectionChanges = this.usageProjectionChangeKey();
    }
    this.lastMetadataWork = this.withBusinessProjection(() => prepareStoredMetadata(this.database));
  }

  metadata(asOf = new Date()) {
    this.assertSourceRepairsComplete();
    // D1：读路径先对齐修订（外部提交在这里被检出 ⇒ 缓存失效 + 必要元数据重载）。
    if (!this.metadataSnapshotRead) this.syncDerivedRevision();
    // D1：写事务内读到的是**未提交**状态 ⇒ 这一轮**不落**共享缓存（验收："事务内已读的派生缓存
    // 被安全清理" —— 预防 + 回滚时再清一次，见 `rollbackReplaceFileTransaction`）。
    const cacheable = this.writeTransactionDepth === 0;
    let persistedMetadata = null;
    if (cacheable && (!this.metadataCache || this.metadataObservationCache?.revision !== this.storeRevision)) {
      this.prepareMetadataProjection();
      if (!this.metadataSnapshotRead) this.syncDerivedRevision();
      persistedMetadata = this.storedMetadata(Number.MAX_SAFE_INTEGER);
      if (persistedMetadata) {
        const rows = persistedMetadata.observationRows;
        this.metadataObservationCache = {
          revision: this.storeRevision,
          rows,
          maxTimestampMs: rows.reduce((n, row) => Math.max(n, Number(row.last_seen)), -Infinity),
        };
      }
    }
    /** D1：不可缓存时（写事务内）用的**本次调用**快照；绝不写回 `this.metadataCache`。 */
    let builtMetadata = null;
    if (!this.metadataCache) {
      const counts =
        persistedMetadata ??
        readMetadataUsageCounts(this.database, this.verifiedHistorySqlRead ? this.eventBounds() : null);
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
        persistedMetadata?.modelRows ??
        (cacheable && this.metadataObservationCache?.revision === this.storeRevision
          ? this.metadataObservationCache.rows
          : this.database.prepare("SELECT DISTINCT channel, model FROM events").all());
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
      observationRows =
        asOfMs >= memo.maxTimestampMs
          ? memo.rows
          : (this.storedMetadata(asOf)?.observationRows ?? queryObservationRows(asOfMs));
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
      generatedAt: this.generatedAt,
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
    this.assertSourceRepairsComplete();
    this.syncDerivedRevision();
    this.prepareMetadataProjection();
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

    return this.withSqlHistoryReader((reader) => reader.metadata(asOf));
  }

  eventBounds(excludeHomes = []) {
    if (this.verifiedHistorySqlRead && !this.historyDiskRead && excludeHomes.length === 0) {
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
    if (excludeHomes.length === 0) {
      return this.database
        .prepare(`SELECT
        (SELECT MIN(timestamp_ms) FROM events) AS minimum,
        (SELECT MAX(timestamp_ms) FROM events) AS maximum`)
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
    this.assertSourceRepairsComplete();
    this.quotaSourceLookup?.clearCache();
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
    this.quotaSourceLookup?.clearCache();
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
   * @returns {Promise<{
   *   events: import("./usage-types.js").UsageEvent[],
   *   homes: Array<{ id: string, label: string, path: string, kind: string }>,
   *   sessions: ReturnType<UsageStore["publishedUsageSessions"]>,
   *   rateLimitObservations: import("./usage-types.js").RateLimitObservation[]
   * }>}
   */
  async publishedHistoryUsageReport() {
    const union = await this.historyArchiveEventUnionForRange(undefined, {
      completeHistory: true,
      includeUsageCarrier: true,
    });
    this.quotaSourceLookup?.clearCache();
    const events = publishedUsageEventsFromUnion(union, this.serviceTierEvidence, this.quotaSourceFor.bind(this));
    const homes = union.homes ?? [];
    return {
      events,
      homes,
      sessions: publishedUsageSessionsFromEvents(events, homes),
      rateLimitObservations: union.rateLimitObservations ?? [],
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
    const statement = this.database.prepare(
      `SELECT ${columns} FROM events WHERE ${where.sql}${this.historyDiskRead ? " ORDER BY id" : ""}`,
    );
    const sourceKinds = this.historySourceKinds ?? homeSourceKinds(this.homes);
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
    const members = new UsageSessionMembers();
    try {
      return this.withEventCostMemoRound(() =>
        buildTimelineRows(
          quoteInputs ? quoteInputs.events() : this.costEventsForRange(range, excludeHomes, includeRepositories),
          range,
          bucket,
          {
            sourceKinds: this.historySourceKinds ?? homeSourceKinds(this.homes),
            pricingModels,
            factRows,
            eventBucketKey: quoteInputs ? (event) => event.quoteBucketKey : undefined,
            modelName: pricing?.modelName,
            estimateCost: pricing?.estimate ?? estimateEventCost,
            onEstimate,
            createSessionSet: () => members.createSet(),
          },
        ),
      );
    } finally {
      members.close();
    }
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
    if (this.historyDiskRead) {
      const sessions = new Map();
      for (const row of this.database.prepare(`SELECT repository_key,session_id,MIN(id) AS first_id
        FROM events WHERE ${where.sql} GROUP BY repository_key,session_id ORDER BY repository_key,first_id`).iterate(...where.params)) {
        const values = sessions.get(row.repository_key) ?? [];
        values.push(row.session_id);
        sessions.set(row.repository_key, values);
      }
      return sessions;
    }
    firsts ??= this.database
      .prepare(`
      SELECT repository_key, session_id, MIN(timestamp_ms) AS first_ms FROM events
      WHERE ${where.sql} GROUP BY repository_key, session_id ORDER BY repository_key, first_ms
    `)
      .all(...where.params);
    const tieRows = this.database.prepare(`
      SELECT * FROM ${this.historyDiskRead ? "events" : "(SELECT * FROM history_hot.events UNION ALL SELECT * FROM main.events)"}
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
    this.database.exec("SAVEPOINT period_aggregate_read");
    try {
      return this.periodAggregateCore(groupColumn, nameColumn, _now, ranges, options);
    } finally {
      this.database.exec("RELEASE period_aggregate_read");
      this.readPricingModels = previousPricingModels;
    }
  }

  periodAggregateCore(groupColumn, nameColumn, _now, ranges, { includeKind = false, excludeHomes = [] } = {}) {
    // Published cold rollups contain the complete history, not the hot-only table.
    const hotAuthority =
      !this.verifiedHistorySqlRead &&
      Boolean(this.database.prepare("SELECT 1 FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META));
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
    if (
      groupColumn === "repository_key" &&
      nameColumn === "repository_path" &&
      includeKind &&
      !hotAuthority &&
      !this.verifiedHistorySqlRead
    ) {
      this.database.exec("SAVEPOINT period_repository_rollup");
      try {
        const bounds = this.eventBounds(excludeHomes);
        if (bounds.minimum !== null && bounds.maximum !== null) {
          const minimum = Number(bounds.minimum);
          const endMs = Number(bounds.maximum) + 1;
          const complete = periodRollupWindow(minimum, endMs, minimum, endMs - 1);
          const repositories = new Map(
            queryUsageRollupRepositoriesWindow(this.database, { ...complete, excludeHomes }).map((row) => [
              row.key,
              {
                key: row.key,
                name: row.name,
                kind: row.kind,
                pathCount: row.pathCount,
                periods: Object.fromEntries(
                  COMPARISON_PERIOD_KEYS.map((period) => [
                    period,
                    Object.fromEntries(fields.map(([field]) => [field, 0])),
                  ]),
                ),
              },
            ]),
          );
          for (const period of COMPARISON_PERIOD_KEYS) {
            const range = ranges[period] || {};
            const window = periodRollupWindow(
              range.start == null ? minimum : new Date(range.start).getTime(),
              range.end == null ? endMs : new Date(range.end).getTime() + 1,
              minimum,
              endMs - 1,
            );
            if (!window) continue;
            for (const row of queryUsageRollupRepositoriesWindow(this.database, {
              ...window,
              excludeHomes,
            })) {
              const entry = repositories.get(row.key);
              entry.periods[period] = Object.fromEntries(fields.map(([field]) => [field, Number(row[field] || 0)]));
            }
          }
          return [...repositories.values()].sort(
            (left, right) =>
              right.periods.all.total - left.periods.all.total || compareSqliteText(left.name, right.name),
          );
        }
        return [];
      } catch (error) {
        if (error?.code !== "ROLLUP_DAYS_MISSING") throw error;
      } finally {
        this.database.exec("RELEASE period_repository_rollup");
      }
    }
    if (modelDimension && !hotAuthority) {
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
          windows[period] = periodRollupWindow(startMs, endExclusiveMs, minimum, maximum);
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
              ...periodRollupWindow(minimum, sourceEndMs, minimum, maximum),
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
    this.assertSourceRepairsComplete();
    // D1：读路径先对齐修订（外部提交在这里被检出 ⇒ 缓存失效 + 必要元数据重载）。
    const snapshotRead = this.periodComparisonSnapshotRead;
    if (!snapshotRead) this.syncDerivedRevision();
    this.prepareHotRollups();
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
    this.prepareHotRollups();
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
    return this.withSqlHistoryReader((reader) => reader.periodComparison(options));
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
        if (!this.verifiedHistorySqlRead || this.historyDiskRead) {
          const projection = this.recordProjectionOptions(zone, excludeHomes);
          const stored = readStoredRecordChampions(projection);
          if (stored) return stored;
          if (this.database.isTransaction || this.writeTransactionDepth > 0) {
            const temporary = new DatabaseSync("");
            try {
              temporary.exec("PRAGMA cache_size = -2048");
              return buildStoredRecordChampions({ ...projection, database: temporary, sourceDatabase: this.database });
            } finally {
              temporary.close();
            }
          }
          return buildStoredRecordChampions(projection);
        }
        const eventPricing = createEventPricing();
        return this.buildRecordChampions(zone, where, scope.params, usdToCnyRate, (event) =>
          eventPricing.estimate(event),
        );
      })();
    if (cacheable && memoized === null) this.recordChampionCache = { key: memoKey, champions };
    return this.recordsWithinRange(champions, range, zone);
  }

  recordProjectionOptions(calendarZone, excludeHomes = []) {
    const zone = calendarZone === "utc" ? "utc" : "local";
    const scope = scopeFilterSql(excludeHomes);
    const catalog = getPricingCatalog();
    const rate = Number(catalog.usdToCnyRate);
    const usdToCnyRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    const sourceKinds = this.historySourceKinds ?? homeSourceKinds(this.homes);
    const pricing = createEventPricing();
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          "record-view-v1",
          catalog.version,
          usdToCnyRate,
          this.serviceTierEvidenceInput,
          zone,
          currentLocalRollupZoneIdentity(),
          [...sourceKinds].sort(),
          [...new Set(excludeHomes.map(String))].sort(),
        ]),
      )
      .digest("hex");
    return {
      database: this.database,
      key,
      factsKey: String(
        this.database.prepare("SELECT revision FROM usage_business_revision WHERE singleton = 1").get().revision,
      ),
      zone,
      where: scope.sql ? `WHERE ${scope.sql}` : "",
      params: scope.params,
      usdToCnyRate,
      estimateRow: (row) =>
        pricing.estimate(costEventFromRow(row, this.serviceTierEvidence, sourceKinds.get(String(row.home_id)))),
    };
  }

  prepareRecordProjection(filters) {
    if (
      this.database.isTransaction ||
      this.writeTransactionDepth > 0 ||
      this.verifiedHistorySqlRead ||
      filters.preset === "all" ||
      isQuotaPreset(filters.preset) ||
      filters.quotaWindow ||
      this.database.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META)
    )
      return;
    buildStoredRecordChampions(this.recordProjectionOptions(filters.calendarZone, filters.excludeHomes || []));
  }

  prepareQuotaProjection(filters) {
    if (this.database.isTransaction || this.writeTransactionDepth > 0 || this.verifiedHistorySqlRead) return;
    if (
      !this.usageProjectionTracker &&
      !this.database.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META)
    ) {
      this.installUsageProjectionTracker();
      this.observedUsageProjectionChanges = this.usageProjectionChangeKey();
    }
    const official = JSON.parse(this.readMetaRaw("official_quota_observations") || "[]");
    this.withBusinessProjection(() =>
      selectStoredQuotaWindows(this.database, filters.now ? new Date(filters.now) : new Date(), official),
    );
    this.lastQuotaWork = quotaProjectionWork(this.database);
  }

  withBusinessProjection(work) {
    const tracker = this.usageProjectionTracker;
    if (!tracker || tracker.database !== this.database) return work();
    if (tracker.owned) return work();
    if (tracker.mainSchema !== Number(this.database.prepare("PRAGMA main.schema_version").get().schema_version))
      return work();
    const tempSchema = Number(this.database.prepare("PRAGMA temp.schema_version").get().schema_version);
    if (tracker.tempSchema !== tempSchema) {
      // ROLLBACK can restore the TEMP schema version; certify its actual catalog before reuse.
      const catalog = JSON.stringify(
        this.database.prepare("SELECT type, name, tbl_name, sql FROM temp.sqlite_master ORDER BY type, name").all(),
      );
      if (catalog !== tracker.tempCatalog) return work();
      tracker.tempSchema = tempSchema;
    }
    const observe = () => ({
      changes: Number(this.database.prepare("SELECT total_changes() AS value").get().value),
      ignored: Number(this.database.prepare("SELECT value FROM usage_projection_ignored_rows").get().value),
    });
    // The enclosing scope accounts for its writes once; row triggers stay active for all other callers.
    this.database.exec("UPDATE usage_projection_ignored_rows SET owned = 1");
    tracker.owned = true;
    const before = observe();
    try {
      return work();
    } finally {
      try {
        const after = observe();
        this.database.exec("UPDATE usage_projection_ignored_rows SET owned = 0");
        // Owned TEMP work changes neither source facts nor their publication identity.
        this.businessProjectionIgnoredChanges +=
          2 + after.changes - before.changes - 2 * (after.ignored - before.ignored);
        tracker.tempSchema = Number(this.database.prepare("PRAGMA temp.schema_version").get().schema_version);
      } finally {
        tracker.owned = false;
      }
    }
  }

  prepareHotRollups() {
    if (
      this.database.isTransaction ||
      this.writeTransactionDepth > 0 ||
      this.verifiedHistorySqlRead ||
      this.database.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META)
    )
      return;
    if (!this.usageProjectionTracker) {
      this.installUsageProjectionTracker();
      this.observedUsageProjectionChanges = this.usageProjectionChangeKey();
    }
    return this.withBusinessProjection(() => {
      const zoneIdentity = currentLocalRollupZoneIdentity();
      const work = tryAppendUsageRollups(this.database, { zoneIdentity });
      this.lastRollupWork = work;
      if (work.applied) return;
      const dirtyDays = listDirtyUsageRollupDays(this.database);
      for (const day of dirtyDays) {
        this.database.exec("SAVEPOINT business_rollup_day");
        try {
          rebuildUsageRollups(this.database, { days: [day], calendarZone: "utc" });
          rebuildUsageRollups(this.database, {
            days: localUsageRollupDaysForUtcDays([day]),
            calendarZone: "local",
          });
          this.database.exec("RELEASE business_rollup_day");
        } catch (error) {
          this.database.exec("ROLLBACK TO business_rollup_day; RELEASE business_rollup_day");
          throw error;
        }
      }
      const checkpoint = checkpointUsageRollups(this.database, { zoneIdentity });
      this.lastRollupWork = { ...work, fallbackDays: dirtyDays.length, checkpoint };
    });
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
    this.assertSourceRepairsComplete();
    this.syncDerivedRevision();
    this.prepareHotRollups();
    this.prepareQuotaProjection(filters);
    this.prepareRecordProjection(filters);
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
    this.registeredReadDatabase = this.database;
  }

  quotaSourceFor(homeId, sessionId, time) {
    if (
      this.quotaSourceDatabase !== this.database ||
      this.quotaSourceRevision !== this.storeRevision ||
      !this.quotaSourceLookup
    ) {
      this.quotaSourceLookup = createStoredQuotaSourceResolver(this.database, this.quotaSourceEvidence);
      this.quotaSourceDatabase = this.database;
      this.quotaSourceRevision = this.storeRevision;
    }
    const writing = this.writeTransactionDepth > 0;
    if (writing) this.quotaSourceLookup.clearCache();
    try {
      return this.quotaSourceLookup(homeId, sessionId, time);
    } finally {
      if (writing) this.quotaSourceLookup.clearCache();
    }
  }

  /** Capture hot facts once, releasing their WAL reader before package verification. */
  async withSqlHistoryReader(read) {
    const started = performance.now();
    const context = {
      homes: structuredClone(this.homes),
      warnings: [...this.warnings],
      generatedAt: this.generatedAt,
      serviceTierEvidence: this.serviceTierEvidence,
      quotaSourceEvidence: this.quotaSourceEvidence,
      serviceTierEvidenceInput: this.serviceTierEvidenceInput,
      revision: this.storeRevision,
    };
    const query = new UsageHistoryQuery(this.database, canonicalFactPayload);
    const database = query.database;
    let verifiedMs = 0;
    try {
      const records = database.prepare("SELECT * FROM archive_segments ORDER BY start_ms,segment_id").all();
      const authorized = historyArchiveAuthorizedSegmentIds(database);
      const revisions = historyArchiveEventRevisions(
        database.prepare("SELECT value FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_REVISIONS_META)?.value,
        new Map(records.map((record) => [String(record.segment_id), record])),
      );
      const liveSource = database.prepare(
        "SELECT path,kind,home_id,home_label,home_path FROM source_files WHERE path=?",
      );
      const { withVerifiedHistoryArchiveCandidate } = await import("./history-archive.js");
      for (const record of records) {
        const id = String(record.segment_id);
        const before = performance.now();
        await withVerifiedHistoryArchiveCandidate(String(record.database_path), undefined, (cold, verified) => {
          assertHistoryArchiveRecordMatches(record, verified);
          const sources = historyArchiveSourceIdentities(cold, Number(record.start_ms), Number(record.end_ms));
          if (Number(cold.prepare("SELECT COUNT(*) AS n FROM events").get().n) !== Number(record.event_count))
            throw historyArchiveError("HISTORY_ARCHIVE_SEGMENT_MISMATCH", "archive event count changed");
          const isAuthority = authorized.has(id);
          if (isAuthority) {
            if (
              database
                .prepare(
                  "SELECT 1 FROM history_query_rows WHERE segment_id='hot' AND timestamp_ms>=? AND timestamp_ms<? LIMIT 1",
                )
                .get(record.start_ms, record.end_ms)
            )
              throw historyArchiveError("HISTORY_ARCHIVE_HOT_COLD_CONFLICT", "authorized archive still has hot facts");
            if (Number(cold.prepare("SELECT COUNT(DISTINCT source_path) AS n FROM events").get().n) !== sources.length)
              throw historyArchiveError(
                "HISTORY_ARCHIVE_HOT_COLD_CONFLICT",
                "archive source identities are incomplete",
              );
            for (const source of sources) {
              const live = liveSource.get(source.path);
              if (!live || !sameHistoryArchiveSourceIdentity(live, source))
                throw historyArchiveError("HISTORY_ARCHIVE_HOT_COLD_CONFLICT", "live archive source identity changed");
            }
          }
          database.exec("BEGIN");
          try {
            query.add(cold.prepare("SELECT * FROM events ORDER BY id").iterate(), id);
            if (!isAuthority) {
              const differences = database
                .prepare(`SELECT payload, SUM(n) AS n FROM (
                SELECT payload, 1 AS n FROM history_query_rows WHERE segment_id=?
                UNION ALL SELECT payload,-1 FROM history_query_rows
                  WHERE segment_id='hot' AND timestamp_ms>=? AND timestamp_ms<?
              ) GROUP BY payload HAVING SUM(n)<>0 LIMIT 1`)
                .get(id, record.start_ms, record.end_ms);
              if (
                differences ||
                JSON.stringify(sources) !==
                  JSON.stringify(
                    historyArchiveSourceIdentities(database, Number(record.start_ms), Number(record.end_ms)),
                  )
              )
                throw historyArchiveError("HISTORY_ARCHIVE_HOT_COLD_CONFLICT", "hot facts do not mirror archive");
              database.prepare("DELETE FROM history_query_rows WHERE segment_id=?").run(id);
            } else {
              for (const revision of revisions.get(id) ?? []) {
                if (!sources.some((source) => sameHistoryArchiveSourceIdentity(source, revision.sourceIdentity)))
                  throw historyArchiveRevisionError("archive revision source binding does not match segment");
                // Remove originals before replacements, so duplicate removals cannot consume additions.
                for (const removed of revision.removed) {
                  if (query.remove(id, removed.payload, removed.count) !== removed.count)
                    throw historyArchiveRevisionError("archive revision removes more payloads than segment contains");
                }
                for (const added of revision.added) {
                  for (let i = 0; i < added.count; i++) query.add([added.payload], id);
                }
              }
            }
            database.exec("COMMIT");
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        });
        verifiedMs += performance.now() - before;
      }
      query.finish(EVENT_INSERT_COLUMNS, (row) => {
        // The carrier derives display/calendar fields at query time, after raw-payload ordering and validation.
        const date = new Date(Number(row.timestamp_ms));
        const day = localDateKey(date);
        return { ...row, project: row.cwd === "" ? "Unknown cwd" : row.cwd,
          hour_key: localHourKey(date), day_key: day,
          week_key: localDateKey(startOfLocalWeek(date)), month_key: day.slice(0,7) };
      });
      if (
        database
          .prepare(
            "SELECT 1 FROM events e WHERE NOT EXISTS (SELECT 1 FROM source_files sf WHERE sf.path=e.source_path) LIMIT 1",
          )
          .get()
      )
        throw historyArchiveError("HISTORY_ARCHIVE_SOURCE_CHANGED", "published event has no verified source identity");
      const reader = new UsageStore({ databaseFile: this.databaseFile });
      reader.database = database;
      reader.homes = context.homes;
      reader.warnings = context.warnings;
      reader.generatedAt = context.generatedAt;
      reader.serviceTierEvidence = context.serviceTierEvidence;
      reader.quotaSourceEvidence = context.quotaSourceEvidence;
      reader.serviceTierEvidenceInput = context.serviceTierEvidenceInput;
      reader.storeRevision = reader.derivedRevision = context.revision;
      reader.summarySnapshotRead = reader.metadataSnapshotRead = reader.periodComparisonSnapshotRead = true;
      reader.verifiedHistorySqlRead = reader.historyDiskRead = true;
      reader.historySourceKinds = homeSourceKinds(reader.publishedUsageHomes());
      reader.registerReadFunctions();
      const prepared = performance.now();
      try {
        const result = read(reader);
        this.lastHistoryQueryWork = {
          rows: query.rows,
          archiveCount: records.length,
          verifiedAndMergeMs: verifiedMs,
          prepareMs: prepared - started,
          queryMs: performance.now() - prepared,
          scratchBytes: query.bytes,
          sort: query.sortStats,
        };
        return result;
      } finally {
        reader.database = null;
        reader.close();
      }
    } finally {
      query.close();
    }
  }

  async trySqlHistoryDashboard(filters, options, periodOptions) {
    const single = await this.trySingleSqlHistoryDashboard(filters, options, periodOptions);
    if (single) return single;
    return this.withSqlHistoryReader((reader) => ({
      summary: reader.summarizeInReadTransaction(filters, options),
      metadata: reader.metadata(filters.now ?? new Date()),
      periodComparison: reader.periodComparison(periodOptions),
    }));
  }

  /** Preserve the established bounded single-package projection and repricing cache. */
  async trySingleSqlHistoryDashboard(filters, options, periodOptions) {
    const hot = this.database;
    // Other shapes are handled by the disposable disk reader.
    if (filters.preset !== "all" || hot.isTransaction !== false || this.writeTransactionDepth > 0) return null;
    const records = hot.prepare("SELECT * FROM archive_segments").all();
    const authorized = historyArchiveAuthorizedSegmentIds(hot);
    if (records.length !== 1 || authorized.size !== 1 || !authorized.has(String(records[0].segment_id))) return null;
    if (hot.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_REVISIONS_META)) return null;
    const record = records[0];
    const dataVersion = this.readDataVersion();
    const totalChanges = Number(hot.prepare("SELECT total_changes() AS value").get().value);
    const input = JSON.stringify([record, dataVersion, totalChanges]);
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
        this.readDataVersion() !== dataVersion ||
        Number(hot.prepare("SELECT total_changes() AS value").get().value) !== totalChanges
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
          const selection = name === "quota_usage_sources" ? "rowid, *" : "*";
          database.exec(`CREATE TEMP VIEW ${quote(name)} AS SELECT ${selection} FROM history_hot.${quote(name)}`);
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
      reader.quotaSourceLookup = null;
      reader.quotaSourceDatabase = null;
      reader.quotaSourceRevision = -1;
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
    this.assertSourceRepairsComplete();
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
    this.assertSourceRepairsComplete();
    this.syncDerivedRevision();
    this.prepareHotRollups();
    this.prepareQuotaProjection(filters);
    this.prepareRecordProjection(filters);
    this.prepareAllSummaryProjection(filters, options);
    let hasAuthority = false;
    const previousTransferable = this.summaryProjectionTransferableRead;
    const ownTransaction = !this.database.isTransaction;
    this.database.exec("SAVEPOINT summary_history_read");
    this.summaryProjectionTransferableRead = ownTransaction;
    try {
      hasAuthority = Boolean(
        this.database.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META),
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

    return this.withSqlHistoryReader((reader) => reader.summarizeInReadTransaction(filters, options));
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
    if (range.preset === "all") {
      summaryWithRecords.records = {};
    } else if (range.quotaWindow) {
      const excludedHomeIds = new Set(
        (scoped.homes || []).filter((home) => canonicalizeKind(home.kind) !== "codex").map((home) => String(home.id)),
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
    if (options.includeDetails === false) {
      delete summary.homes;
      delete summary.projects;
      delete summary.repositories;
    }
    return summary;
  }

  /** The first persistent path serves the hot, all-source dashboard only. @returns {any} */
  allSummaryOptions(filters = {}, options = {}, range = null, bucket = null) {
    if (
      this.deferredMetadataIndex ||
      filters.preset !== "all" ||
      options.includeDetails !== false ||
      (filters.excludeHomes || []).length ||
      this.writeTransactionDepth > 0 ||
      this.verifiedHistorySqlRead ||
      this.serviceTierEvidenceInput === null ||
      this.database.prepare("SELECT 1 FROM store_meta WHERE key=?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META) ||
      Number(this.database.prepare("PRAGMA reverse_unordered_selects").get().reverse_unordered_selects) !== 0 ||
      this.database
        .prepare("PRAGMA index_list(events)")
        .all()
        .some((row) => Number(row.unique) !== 0)
    )
      return null;
    let evidence;
    try {
      evidence = this.serviceTierEvidence ? serviceTierEvidenceSnapshot(this.serviceTierEvidence) : null;
    } catch {
      return null;
    }
    const sourceKinds = homeSourceKinds(this.homes);
    const sources = this.database.prepare("SELECT home_id,kind FROM source_files").all();
    if (
      sources.some((row) => sourceGroup("", String(row.kind)) !== sourceGroup("", sourceKinds.get(String(row.home_id))))
    )
      return null;
    if (!range) {
      const bounds = this.eventBounds();
      const events = [bounds.minimum, bounds.maximum]
        .filter((value) => value !== null)
        .map((value) => ({ timestamp: new Date(Number(value)).toISOString() }));
      range = resolveDateRange(filters, events);
    }
    bucket ||= deriveTimelineBucket(range, range.bucket || filters.bucket || "day");
    if (!["day", "week", "month"].includes(bucket)) return null;
    // Preserve the legacy rowid accumulation order, including floating-point tails.
    const legacyWhere = eventRangeScope(range, scopeFilterSql([]));
    const legacyPlan = this.database
      .prepare(`EXPLAIN QUERY PLAN SELECT ${COST_EVENT_COLUMNS} FROM events WHERE ${legacyWhere.sql}`)
      .all(...legacyWhere.params);
    if (legacyPlan.length !== 1 || legacyPlan[0].detail !== "SCAN events") return null;
    const catalog = getPricingCatalog();
    const pricingModels = filters.pricingModels ?? catalog.models;
    const schema = Number(this.database.prepare("PRAGMA main.schema_version").get().schema_version);
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          "all-summary-v3",
          schema,
          bucket,
          range.calendarZone || "local",
          currentLocalRollupZoneIdentity(),
          catalog.version,
          catalog.models,
          catalog.usdToCnyRate,
          pricingModels,
          this.serviceTierEvidenceInput,
          evidence,
          this.homes,
        ]),
      )
      .digest("hex");
    const store = this;
    return {
      database: this.database,
      key,
      range,
      bucket,
      requestedBucket: filters.bucket || "day",
      sourceKinds,
      pricingModels,
      pricing: createEventPricing(pricingModels),
      *eventsAfter(position, limit) {
        const query = store.database.prepare(`SELECT id,${COST_EVENT_COLUMNS} FROM events
          WHERE id>? ORDER BY id LIMIT ?`);
        query.setReturnArrays(true);
        for (const value of query.iterate(position.id, limit)) {
          const row = /** @type {any[]} */ (/** @type {unknown} */ (value));
          const event = costEventFromRowArray(row.slice(1), store.serviceTierEvidence, sourceKinds.get(String(row[3])));
          yield { ...event, id: Number(row[0]) };
        }
      },
    };
  }

  prepareAllSummaryProjection(filters, options) {
    if (this.database.isTransaction || this.writeTransactionDepth > 0) return;
    const input = this.allSummaryOptions(filters, options);
    if (!input) return;
    input.contextKey = () => this.allSummaryOptions(filters, options)?.key;
    try {
      this.lastAllSummaryWork = this.withBusinessProjection(() => buildStoredAllSummary(input));
    } catch (error) {
      if (error.code !== "TIMELINE_RANGE_TOO_LARGE") throw error;
      this.lastAllSummaryWork = { fallbackReason: error.code };
    }
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
      contextKey: `${contextKey}\u0001${pricingKey}`,
      publicationKey: `${this.storeRevision}:${this.derivedRevision}:${totalChanges}:${this.readDataVersion()}`,
    };
  }

  summarizeInReadTransaction(filters = {}, options = {}) {
    if (this.registeredReadDatabase !== this.database) this.registerReadFunctions();
    this.syncDerivedRevision();
    this.quotaSourceLookup?.clearCache();
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
    const officialQuota = JSON.parse(this.readMetaRaw("official_quota_observations") || "[]");
    const quota = this.withBusinessProjection(() => selectStoredQuotaWindows(this.database, asOf, officialQuota));
    const quotaObservations = {
      completedQuotaWindows: (limitId, time, minutes) => {
        const windows = this.withBusinessProjection(() =>
          iterateStoredQuotaWindows(this.database, limitId, time, minutes, officialQuota),
        );
        if (windows === null) return null;
        const iterator = windows[Symbol.iterator]();
        return {
          [Symbol.iterator]() {
            return this;
          },
          next: () => this.withBusinessProjection(() => iterator.next()),
          return: () => this.withBusinessProjection(() => iterator.return?.() ?? { done: true }),
        };
      },
    };
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
        !this.database.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META));
    const persistentOptions = this.allSummaryOptions(filters, { includeDetails }, range, bucket);
    const persistentProjection = persistentOptions ? readStoredAllSummary(persistentOptions) : null;
    if (persistentProjection && this.summaryProjectionCache?.quoteInputs) {
      this.summaryProjectionCache.quoteInputs.discard();
      this.summaryProjectionCache.quoteInputs = null;
    }
    const projectionCacheable =
      range.preset === "all" && groupingEligible && !persistentProjection && !this.historyDiskRead;
    const projectionKeys = projectionCacheable
      ? this.summaryProjectionKeys(range, bucket, scopeExclusions, includeDetails, pricingModels)
      : null;
    const factProjection =
      projectionKeys &&
      this.summaryProjectionCache?.factsKey === projectionKeys.factsKey &&
      this.summaryProjectionCache.evidence === this.serviceTierEvidence
        ? structuredClone(this.summaryProjectionCache.projection)
        : null;
    const projection =
      persistentProjection ||
      (factProjection && this.summaryProjectionCache.key === projectionKeys.key ? factProjection : null);
    let quoteInputs = factProjection ? this.summaryProjectionCache.quoteInputs : null;
    if (projectionCacheable && !factProjection && this.summaryProjectionCache?.quoteInputs) {
      this.summaryProjectionCache.quoteInputs.discard();
      this.summaryProjectionCache.quoteInputs = null;
    }
    const aggregate = persistentProjection?.aggregate ?? this.aggregateRange(range, scopeExclusions);
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
    let fusedGroups = persistentProjection;
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
    if (projectionCacheable && !projection) {
      const cachedProjection = {
        timeline,
        timelineError,
        costEstimate,
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
    if (projectionKeys && projection && this.summaryProjectionCache.publicationKey !== projectionKeys.publicationKey) {
      this.summaryProjectionCache = { ...this.summaryProjectionCache, publicationKey: projectionKeys.publicationKey };
    }
    return summary;
  }

  close() {
    this.sourceProof?.close();
    this.sourceProof = null;
    this.historySqlDashboardCache?.store.close();
    this.historySqlDashboardCache = null;
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
    this.quotaSourceLookup = null;
    this.quotaSourceDatabase = null;
    this.quotaSourceRevision = -1;
    this.summaryProjectionCache = null;
    this.usageProjectionTracker = null;
    this.businessProjectionIgnoredChanges = 0;
    this.observedUsageProjectionChanges = "";
    this.publishedFileWarningsView = null;
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
