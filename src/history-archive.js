import { createHash } from "node:crypto";
import { constants as fsConstants, existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import {
  createHistoryBackup,
  loadHistoryBackupContext,
  restoreHistoryBackup,
  verifyHistoryBackup,
  withVerifiedHistoryBackup,
} from "./history-backup.js";
import { PERF_SUPPORTED_METHOD_VERSIONS, isGenerationPerfMethod } from "./perf-stats.js";
import { generationPerfValues, mergeRequestTimingEvidence } from "./perf-request-timing.js";
import { lookupRequestTiming, validateStoredEvidence } from "./perf-request-timing-store.js";
import { foldCodexRolloutMetadata } from "./perf-sources/codex-fold.js";
import { resolveCodexRequestTiming, resolveCodexTurnRequestTiming } from "./perf-sources/codex-request-timing.js";
import { getPricingCatalog } from "./pricing.js";
import { serviceTierEvidenceFromSnapshot, serviceTierEvidenceSnapshot } from "./service-tier-evidence.js";

const ARCHIVE_EVENT_THRESHOLD = 400_000;
const COLD_HISTORY_DAYS = 180;
const verifiedCandidateEvidence = new Set();
const HISTORY_ARCHIVE_CANDIDATE_FORMAT_VERSION = 1;
const HISTORY_ARCHIVE_CANDIDATE_META_KEY = "history_archive_candidate";
const HISTORY_ARCHIVE_PERF_SOURCES_FORMAT_VERSION = 1;
const HISTORY_ARCHIVE_PERF_SOURCES_META_KEY = "history_archive_perf_sources_v1";
const HISTORY_ARCHIVE_PERF_SAMPLES_FORMAT_VERSION = 1;
const HISTORY_ARCHIVE_PERF_SAMPLES_META_KEY = "history_archive_perf_samples_v1";
const HISTORY_ARCHIVE_PERF_INDEX_FORMAT_VERSION = 1;
const HISTORY_ARCHIVE_PERF_INDEX_META_KEY = "history_archive_perf_index_v1";
const HISTORY_ARCHIVE_PERF_TIMING_FORMAT_VERSION = 1;
const HISTORY_ARCHIVE_PERF_TIMING_META_KEY = "history_archive_perf_timing_v1";
const HISTORY_ARCHIVE_PERF_COMPONENT_META_KEYS = Object.freeze([
  HISTORY_ARCHIVE_PERF_SOURCES_META_KEY,
  HISTORY_ARCHIVE_PERF_SAMPLES_META_KEY,
  HISTORY_ARCHIVE_PERF_INDEX_META_KEY,
  HISTORY_ARCHIVE_PERF_TIMING_META_KEY,
]);
const HISTORY_ARCHIVE_CODEX_REQUESTS_FORMAT_VERSION = 1;
export const HISTORY_ARCHIVE_CODEX_REQUESTS_META_KEY = `history_archive_${"codex_requests"}_v1`;
const HISTORY_ARCHIVE_WORKBUDDY_OBSERVATIONS_FORMAT_VERSION = 1;
const HISTORY_ARCHIVE_WORKBUDDY_OBSERVATIONS_META_KEY = "history_archive_workbuddy_observations_v1";
const HISTORY_ARCHIVE_WORKBUDDY_OBSERVATIONS_SCOPE = "referenced-homes";
const HISTORY_ARCHIVE_PERF_SAMPLE_COLUMNS = Object.freeze([
  "sample_key",
  "source_path",
  "source_kind",
  "home_id",
  "channel",
  "agent_kind",
  "agent",
  "session_id",
  "turn_key",
  "model",
  "model_provider",
  "reasoning_effort",
  "model_evidence",
  "window",
  "timing_kind",
  "timing_source",
  "token_scope",
  "status",
  "ts_ms",
  "window_start_ms",
  "window_end_ms",
  "duration_ms",
  "output_tokens",
  "input_tokens",
  "request_count",
  "item_count",
  "timed_item_count",
  "sample_flags",
  "diagnostic_reason",
  "diagnostic_reason_chain",
  "method_version",
]);
const HISTORY_ARCHIVE_PERF_INDEX_TABLE_NAMES = Object.freeze([
  "perf_sample_sources",
  "perf_rollout_threads",
  "source_files",
]);
const HISTORY_ARCHIVE_PERF_SAMPLE_SOURCE_COLUMNS = Object.freeze(["sample_key", "source_path", "role"]);
const HISTORY_ARCHIVE_PERF_ROLLOUT_COLUMNS = Object.freeze(["source_path", "home_id", "thread_id"]);
const HISTORY_ARCHIVE_SOURCE_IDENTITY_COLUMNS = Object.freeze(["path", "kind", "home_id", "home_label", "home_path"]);
const HISTORY_ARCHIVE_PERF_TIMING_TABLE_NAMES = Object.freeze([
  "perf_request_timing_threads",
  "perf_request_timing_evidence",
]);
const HISTORY_ARCHIVE_PERF_TIMING_THREAD_COLUMNS = Object.freeze(["home_id", "response_id", "thread_id"]);
const HISTORY_ARCHIVE_PERF_TIMING_EVIDENCE_COLUMNS = Object.freeze([
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
const HISTORY_ARCHIVE_SUPPORTED_PERF_METHOD_VERSIONS = PERF_SUPPORTED_METHOD_VERSIONS;
const HISTORY_ARCHIVE_WORKBUDDY_OBSERVATIONS_TABLE_NAMES = Object.freeze([
  "workbuddy_generation_duration_observations",
  "source_files",
]);
const HISTORY_ARCHIVE_WORKBUDDY_OBSERVATION_COLUMNS = Object.freeze([
  "home_id",
  "message_id",
  "duration_ms",
  "ended_at_ms",
  "capture_version",
  "captured_at",
]);
const HISTORY_ARCHIVE_PERF_INDEX_REFERENCED_PATHS_CTE = `
  WITH referenced(path) AS (
    SELECT source_path FROM perf_samples WHERE ts_ms >= ? AND ts_ms < ?
    UNION
    SELECT dependencies.source_path
    FROM perf_samples AS samples
    JOIN perf_sample_sources AS dependencies ON dependencies.sample_key = samples.sample_key
    WHERE samples.ts_ms >= ? AND samples.ts_ms < ?
  )
`;
const HISTORY_ARCHIVE_PERF_TIMING_OWNERS_CTE = `
  WITH owners(home_id, thread_id) AS (
    SELECT DISTINCT rollouts.home_id, rollouts.thread_id
    FROM (
      SELECT source_path FROM perf_samples WHERE ts_ms >= ? AND ts_ms < ?
      UNION
      SELECT dependencies.source_path
      FROM perf_samples AS samples
      JOIN perf_sample_sources AS dependencies ON dependencies.sample_key = samples.sample_key
      WHERE samples.ts_ms >= ? AND samples.ts_ms < ?
    ) AS referenced
    JOIN perf_rollout_threads AS rollouts ON rollouts.source_path = referenced.source_path
  )
`;
const HISTORY_ARCHIVE_PERF_TIMING_LINKS_CTE = `
  WITH owners(home_id, thread_id) AS (
    SELECT DISTINCT rollouts.home_id, rollouts.thread_id
    FROM (
      SELECT source_path FROM perf_samples WHERE ts_ms >= ? AND ts_ms < ?
      UNION
      SELECT dependencies.source_path
      FROM perf_samples AS samples
      JOIN perf_sample_sources AS dependencies ON dependencies.sample_key = samples.sample_key
      WHERE samples.ts_ms >= ? AND samples.ts_ms < ?
    ) AS referenced
    JOIN perf_rollout_threads AS rollouts ON rollouts.source_path = referenced.source_path
  ),
  links(home_id, response_id) AS (
    SELECT DISTINCT timing.home_id, timing.response_id
    FROM perf_request_timing_threads AS timing
    JOIN owners ON owners.home_id = timing.home_id AND owners.thread_id = timing.thread_id
  )
`;
// Select WorkBuddy sources first so unrelated cold events do not become the outer loop.
const HISTORY_ARCHIVE_WORKBUDDY_REFERENCED_HOMES_CTE = `
  WITH referenced_homes(home_id) AS (
    SELECT DISTINCT events.home_id
    FROM source_files
    CROSS JOIN events ON events.source_path = source_files.path
    WHERE events.timestamp_ms >= ? AND events.timestamp_ms < ?
      AND source_files.kind = 'workbuddy'
    UNION
    SELECT DISTINCT home_id
    FROM perf_samples
    WHERE ts_ms >= ? AND ts_ms < ? AND source_kind = 'workbuddy'
  )
`;
const HISTORY_ARCHIVE_BUNDLE_FORMAT_VERSION = 1;
const HISTORY_ARCHIVE_BUNDLE_MANIFEST_FILE = "bundle.manifest.json";
const HISTORY_ARCHIVE_BUNDLE_ANCHOR_META_KEY = "history_archive_bundle_segments_v1";
const HISTORY_ARCHIVE_BUNDLE_ANCHOR_FORMAT_VERSION = 1;
const HISTORY_ARCHIVE_BUNDLE_COMPLETE_FILE = "bundle.complete.json";
const HISTORY_ARCHIVE_BUNDLE_COMPLETE_FORMAT_VERSION = 1;
const HISTORY_ARCHIVE_IMPORT_COMPLETE_FILE = "import.complete.json";
const HISTORY_ARCHIVE_IMPORT_COMPLETE_FORMAT_VERSION = 1;

function archiveError(code, message) {
  return Object.assign(new Error(message), { code });
}

function canonicalArchivePath(value) {
  const resolved = path.resolve(String(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function compareArchiveText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bundleError(code, message) {
  return archiveError(`HISTORY_ARCHIVE_BUNDLE_${code}`, message);
}

function importError(code, message) {
  return archiveError(`HISTORY_ARCHIVE_IMPORT_${code}`, message);
}

function assertBundleKeys(value, expected, label, code = "BAD_MANIFEST") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw bundleError(code, `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw bundleError(code, `${label} must contain exactly ${wanted.join(", ")}`);
  }
}

function assertBundleRelativePath(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw bundleError("BAD_MANIFEST", `${label} must be a non-empty path`);
  }
  if (
    value.includes("\0") ||
    path.isAbsolute(value) ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.split(/[\\/]+/).includes("..")
  ) {
    throw bundleError("PATH_ESCAPE", `${label} must stay inside the bundle`);
  }
}

function bundleContains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveBundlePath(directory, relativePath, label) {
  assertBundleRelativePath(relativePath, label);
  const candidate = path.resolve(directory, relativePath);
  if (!bundleContains(directory, candidate)) {
    throw bundleError("PATH_ESCAPE", `${label} must stay inside the bundle`);
  }
  return candidate;
}

async function resolveBundleDirectory(directory) {
  if (typeof directory !== "string" || directory.trim() === "") {
    throw new TypeError("directory must be a non-empty path");
  }
  const requestedDirectory = path.resolve(directory);
  let realDirectory;
  try {
    realDirectory = await realpath(requestedDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw bundleError("NOT_FOUND", `bundle directory is missing: ${requestedDirectory}`);
    }
    throw error;
  }
  return { requestedDirectory, realDirectory };
}

async function resolveBundleFile(directory, realDirectory, relativePath, label) {
  const candidate = resolveBundlePath(directory, relativePath, label);
  let resolved;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw bundleError("NOT_FOUND", `${label} is missing`);
    }
    throw error;
  }
  if (!bundleContains(realDirectory, resolved)) {
    throw bundleError("PATH_ESCAPE", `${label} resolves outside the bundle`);
  }
  return resolved;
}

function validateBundleSegments(segments) {
  if (!Array.isArray(segments)) {
    throw bundleError("BAD_MANIFEST", "bundle segments must be an array");
  }
  for (const [index, segment] of segments.entries()) {
    assertBundleKeys(
      segment,
      [
        "segmentId",
        "databaseFile",
        "manifestFile",
        "databaseSha256",
        "startMs",
        "endMs",
        "eventCount",
        "registeredAtMs",
      ],
      `bundle segment ${index}`,
    );
    if (
      typeof segment.segmentId !== "string" ||
      !/^[a-f0-9]{64}$/.test(segment.segmentId) ||
      typeof segment.databaseSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(segment.databaseSha256) ||
      typeof segment.databaseFile !== "string" ||
      typeof segment.manifestFile !== "string"
    ) {
      throw bundleError("BAD_MANIFEST", `bundle segment ${index} id, SHA-256, or paths are invalid`);
    }
    try {
      assertArchiveRange(segment.startMs, segment.endMs);
    } catch (error) {
      throw bundleError("BAD_MANIFEST", `bundle segment ${index} range is invalid: ${error.message}`);
    }
    if (!Number.isSafeInteger(segment.eventCount) || segment.eventCount < 0) {
      throw bundleError("BAD_MANIFEST", `bundle segment ${index} eventCount is invalid`);
    }
    assertBundleRelativePath(segment.databaseFile, `bundle segment ${index} databaseFile`);
    assertBundleRelativePath(segment.manifestFile, `bundle segment ${index} manifestFile`);
    if (
      !Number.isSafeInteger(segment.registeredAtMs) ||
      segment.registeredAtMs < 0 ||
      Number.isNaN(new Date(segment.registeredAtMs).getTime())
    ) {
      throw bundleError("BAD_MANIFEST", `bundle segment ${index} registeredAtMs is invalid`);
    }
  }

  const segmentIds = new Set();
  for (const segment of segments) {
    if (segmentIds.has(segment.segmentId)) {
      throw bundleError("SEGMENT_CONFLICT", `duplicate archive segment ${segment.segmentId}`);
    }
    segmentIds.add(segment.segmentId);
  }
  const ranges = [...segments].sort((left, right) => left.startMs - right.startMs);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].startMs < ranges[index - 1].endMs) {
      throw bundleError(
        "SEGMENT_CONFLICT",
        `archive segments ${ranges[index - 1].segmentId} and ${ranges[index].segmentId} overlap`,
      );
    }
  }
}

function normalizeBundleSegments(segments) {
  return segments
    .map((segment) => ({
      segmentId: segment.segmentId,
      databaseFile: segment.databaseFile,
      manifestFile: segment.manifestFile,
      databaseSha256: segment.databaseSha256,
      startMs: segment.startMs,
      endMs: segment.endMs,
      eventCount: segment.eventCount,
      registeredAtMs: segment.registeredAtMs,
    }))
    .sort((left, right) => left.segmentId.localeCompare(right.segmentId));
}

function validateBundleManifest(manifest) {
  assertBundleKeys(manifest, ["formatVersion", "main", "segments"], "bundle manifest");
  if (manifest.formatVersion !== HISTORY_ARCHIVE_BUNDLE_FORMAT_VERSION) {
    throw bundleError("BAD_MANIFEST", "unsupported bundle manifest format");
  }
  assertBundleKeys(manifest.main, ["databaseFile", "manifestFile"], "bundle main");
  if (typeof manifest.main.databaseFile !== "string" || typeof manifest.main.manifestFile !== "string") {
    throw bundleError("BAD_MANIFEST", "bundle main paths must be strings");
  }
  validateBundleSegments(manifest.segments);
}

function validateBundleMarker(marker) {
  assertBundleKeys(
    marker,
    ["formatVersion", "bundleFormatVersion", "bundleManifestSha256", "completedAt"],
    "bundle completion marker",
    "BAD_MARKER",
  );
  if (
    marker.formatVersion !== HISTORY_ARCHIVE_BUNDLE_COMPLETE_FORMAT_VERSION ||
    marker.bundleFormatVersion !== HISTORY_ARCHIVE_BUNDLE_FORMAT_VERSION
  ) {
    throw bundleError("BAD_MARKER", "unsupported bundle completion marker format");
  }
  if (typeof marker.bundleManifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(marker.bundleManifestSha256)) {
    throw bundleError("BAD_MARKER", "bundle completion marker manifest SHA-256 is invalid");
  }
  const parsedCompletedAt = typeof marker.completedAt === "string" ? Date.parse(marker.completedAt) : Number.NaN;
  if (Number.isNaN(parsedCompletedAt) || new Date(parsedCompletedAt).toISOString() !== marker.completedAt) {
    throw bundleError("BAD_MARKER", "bundle completion marker completedAt is invalid");
  }
}

function validateImportMarker(marker) {
  const expected = ["formatVersion", "bundleManifestSha256", "runtimeFile", "completedAt"];
  if (
    !marker ||
    typeof marker !== "object" ||
    Array.isArray(marker) ||
    JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify([...expected].sort())
  ) {
    throw importError("BAD_MARKER", "import completion marker must contain exactly four fields");
  }
  if (marker.formatVersion !== HISTORY_ARCHIVE_IMPORT_COMPLETE_FORMAT_VERSION) {
    throw importError("BAD_MARKER", "unsupported import completion marker format");
  }
  if (typeof marker.bundleManifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(marker.bundleManifestSha256)) {
    throw importError("BAD_MARKER", "import completion marker bundle manifest SHA-256 is invalid");
  }
  if (typeof marker.runtimeFile !== "string" || marker.runtimeFile.trim() === "") {
    throw importError("BAD_MARKER", "import completion marker runtimeFile must be a non-empty path");
  }
  assertBundleRelativePath(marker.runtimeFile, "import completion marker runtimeFile");
  const parsedCompletedAt = typeof marker.completedAt === "string" ? Date.parse(marker.completedAt) : Number.NaN;
  if (Number.isNaN(parsedCompletedAt) || new Date(parsedCompletedAt).toISOString() !== marker.completedAt) {
    throw importError("BAD_MARKER", "import completion marker completedAt is invalid");
  }
}

function bundleAnchor(database) {
  const row = database
    .prepare("SELECT value FROM store_meta WHERE key = ?")
    .get(HISTORY_ARCHIVE_BUNDLE_ANCHOR_META_KEY);
  if (!row) {
    throw bundleError("MISMATCH", "bundle main has no archive segment anchor");
  }
  let anchor;
  try {
    anchor = JSON.parse(String(row.value));
  } catch {
    throw bundleError("BAD_MANIFEST", "bundle main archive segment anchor is not valid JSON");
  }
  assertBundleKeys(anchor, ["formatVersion", "segments"], "bundle archive segment anchor");
  if (anchor.formatVersion !== HISTORY_ARCHIVE_BUNDLE_ANCHOR_FORMAT_VERSION) {
    throw bundleError("BAD_MANIFEST", "unsupported bundle archive segment anchor format");
  }
  validateBundleSegments(anchor.segments);
  return normalizeBundleSegments(anchor.segments);
}

function archiveCutoffMs(asOf) {
  if (typeof asOf !== "number" || !Number.isSafeInteger(asOf)) {
    throw new TypeError("asOf must be a valid epoch millisecond timestamp");
  }
  const cutoff = new Date(asOf);
  if (Number.isNaN(cutoff.getTime())) {
    throw new TypeError("asOf must be a valid epoch millisecond timestamp");
  }
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - COLD_HISTORY_DAYS);
  return cutoff.getTime();
}

/**
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {{asOf?: number}} [options]
 */
export function planHistoryArchive(database, { asOf } = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("planHistoryArchive requires an open SQLite connection");
  }
  const cutoffMs = archiveCutoffMs(asOf);
  const counts = database
    .prepare(
      `SELECT COUNT(*) AS eventCount,
              COUNT(CASE WHEN timestamp_ms < ? THEN 1 END) AS coldEventCount
       FROM events`,
    )
    .get(cutoffMs);
  const eventCount = Number(counts.eventCount);
  const coldEventCount = Number(counts.coldEventCount);
  const reason =
    eventCount < ARCHIVE_EVENT_THRESHOLD
      ? "below-event-threshold"
      : coldEventCount === 0
        ? "no-complete-cold-day"
        : "eligible";
  return {
    eligible: reason === "eligible",
    reason,
    eventCount,
    coldEventCount,
    cutoffMs,
  };
}

function assertArchiveRange(startMs, endMs) {
  const validTimestamp = (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && !Number.isNaN(new Date(value).getTime());
  if (!validTimestamp(startMs) || !validTimestamp(endMs) || startMs >= endMs) {
    throw new TypeError("startMs and endMs must be valid epoch millisecond integers with startMs < endMs");
  }
}

function assertArchiveRegistryEmpty(database) {
  const table = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'archive_segments'")
    .get();
  if (!table) return;
  const archiveRows = Number(database.prepare("SELECT COUNT(*) AS count FROM archive_segments").get().count);
  if (archiveRows > 0) {
    throw archiveError(
      "HISTORY_BACKUP_ARCHIVES_UNSUPPORTED",
      `schema 21 archive_segments contains ${archiveRows} row(s); external archive files are not packaged`,
    );
  }
}

function eventEvidence(database, startMs, endMs, ranged = false) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ startMs, endMs }));
  hash.update("\n");
  let rows = 0;
  const iterator = ranged
    ? database
        .prepare("SELECT * FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ? ORDER BY id")
        .iterate(startMs, endMs)
    : database.prepare("SELECT * FROM events ORDER BY id").iterate();
  for (const row of iterator) {
    hash.update(JSON.stringify(row));
    hash.update("\n");
    rows += 1;
  }
  return { rows, sha256: hash.digest("hex") };
}

function sourceIdentityIterator(database, startMs, endMs) {
  return database
    .prepare(
      `SELECT sf.path, sf.kind, sf.home_id, sf.home_label, sf.home_path
       FROM source_files sf
       WHERE EXISTS (
         SELECT 1 FROM events e
         WHERE e.source_path = sf.path AND e.timestamp_ms >= ? AND e.timestamp_ms < ?
       )
       ORDER BY sf.path`,
    )
    .iterate(startMs, endMs);
}

function sourceEvidence(database, startMs, endMs) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ startMs, endMs }));
  hash.update("\n");
  let rows = 0;
  const iterator = sourceIdentityIterator(database, startMs, endMs);
  for (const row of iterator) {
    hash.update(
      JSON.stringify({
        path: row.path,
        kind: row.kind,
        home_id: row.home_id,
        home_label: row.home_label,
        home_path: row.home_path,
      }),
    );
    hash.update("\n");
    rows += 1;
  }
  return { rows, sha256: hash.digest("hex") };
}

function sourceIdentityRows(database, startMs, endMs) {
  return Array.from(sourceIdentityIterator(database, startMs, endMs), (row) => ({
    path: row.path,
    kind: row.kind,
    home_id: row.home_id,
    home_label: row.home_label,
    home_path: row.home_path,
  }));
}

function canonicalPersistentDatabaseFile(database) {
  const main = database
    .prepare("PRAGMA database_list")
    .all()
    .find((row) => row.name === "main");
  if (!main || typeof main.file !== "string" || main.file.length === 0) {
    throw archiveError(
      "HISTORY_ARCHIVE_COMMIT_DATABASE_UNSUPPORTED",
      "in-memory SQLite databases cannot be prepared for an archive commit",
    );
  }
  return realpathSync.native(path.resolve(main.file));
}

function perfSourceInventory(database, startMs, endMs) {
  const byPath = new Map();
  const rows = database
    .prepare(
      `SELECT p.source_path, p.sample_key, p.method_version,
              sf.kind, sf.home_id, sf.home_label, sf.home_path
       FROM perf_samples p
       LEFT JOIN source_files sf ON sf.path = p.source_path
       WHERE p.ts_ms >= ? AND p.ts_ms < ?
       ORDER BY p.source_path, p.sample_key`,
    )
    .iterate(startMs, endMs);
  for (const row of rows) {
    const sourcePath = String(row.source_path);
    let source = byPath.get(sourcePath);
    if (!source) {
      if (
        typeof row.kind !== "string" ||
        typeof row.home_id !== "string" ||
        typeof row.home_label !== "string" ||
        typeof row.home_path !== "string"
      ) {
        throw archiveError(
          "HISTORY_ARCHIVE_CANDIDATE_PERF_SOURCE_MISSING",
          `perf source ${sourcePath} has no source_files identity`,
        );
      }
      source = {
        path: sourcePath,
        kind: row.kind,
        homeId: row.home_id,
        homeLabel: row.home_label,
        homePath: row.home_path,
        sampleKeys: [],
        methodVersions: new Set(),
      };
      byPath.set(sourcePath, source);
    }
    source.sampleKeys.push(String(row.sample_key));
    source.methodVersions.add(String(row.method_version));
  }
  return {
    formatVersion: HISTORY_ARCHIVE_PERF_SOURCES_FORMAT_VERSION,
    sources: [...byPath.values()].map((source) => ({
      path: source.path,
      kind: source.kind,
      homeId: source.homeId,
      homeLabel: source.homeLabel,
      homePath: source.homePath,
      sampleCount: source.sampleKeys.length,
      sampleKeysSha256: createHash("sha256").update(JSON.stringify(source.sampleKeys)).digest("hex"),
      methodVersions: [...source.methodVersions].sort(),
    })),
  };
}

function perfSampleEvidence(database, startMs, endMs) {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      table: "perf_samples",
      startMs,
      endMs,
      columns: HISTORY_ARCHIVE_PERF_SAMPLE_COLUMNS,
    }),
  );
  hash.update("\n");
  let rows = 0;
  const iterator = database
    .prepare(
      `SELECT ${HISTORY_ARCHIVE_PERF_SAMPLE_COLUMNS.join(", ")} FROM perf_samples
       WHERE ts_ms >= ? AND ts_ms < ?
       ORDER BY sample_key`,
    )
    .iterate(startMs, endMs);
  for (const row of iterator) {
    hash.update(
      JSON.stringify(Object.fromEntries(HISTORY_ARCHIVE_PERF_SAMPLE_COLUMNS.map((column) => [column, row[column]]))),
    );
    hash.update("\n");
    rows += 1;
  }
  return {
    formatVersion: HISTORY_ARCHIVE_PERF_SAMPLES_FORMAT_VERSION,
    startMs,
    endMs,
    rows,
    sha256: hash.digest("hex"),
  };
}

/**
 * Return the exact perf rows safe to move with an archive commit.
 * Dependencies stay hot because perf_sample_sources cascades from perf_samples.
 */
export function historyArchivePerfDeletion(database, startMs, endMs, { requireComponents = false } = {}) {
  if (requireComponents) {
    const present = Number(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM store_meta
           WHERE key IN (?, ?, ?, ?)`,
        )
        .get(...HISTORY_ARCHIVE_PERF_COMPONENT_META_KEYS).count,
    );
    if (present !== HISTORY_ARCHIVE_PERF_COMPONENT_META_KEYS.length) return undefined;
  }
  const rows = database
    .prepare(
      `SELECT samples.sample_key, samples.source_kind, samples.method_version,
              samples.status, samples.timing_kind, samples.timing_source,
              samples.window, samples.token_scope, samples.output_tokens, samples.duration_ms,
              EXISTS (
                SELECT 1 FROM perf_sample_sources AS dependencies
                WHERE dependencies.sample_key = samples.sample_key
              ) AS has_dependency
       FROM perf_samples AS samples
       WHERE samples.ts_ms >= ? AND samples.ts_ms < ?
       ORDER BY samples.sample_key`,
    )
    .all(startMs, endMs);
  if (rows.length === 0) return undefined;
  const methodVersions = new Set(rows.map((row) => String(row.method_version)));
  if (methodVersions.size !== 1) return undefined;
  const [methodVersion] = methodVersions;
  if (!HISTORY_ARCHIVE_SUPPORTED_PERF_METHOD_VERSIONS.includes(methodVersion)) return undefined;
  const sourceKinds = new Set(rows.map((row) => row.source_kind));
  if (sourceKinds.size !== 1) return undefined;
  const [sourceKind] = sourceKinds;
  const generationWindow = (row) =>
    isGenerationPerfMethod(methodVersion) &&
    row.timing_kind === "generation" &&
    row.window === "request" &&
    row.token_scope === "non_reasoning_output";
  const supported =
    sourceKind === "zcode"
      ? rows.every((row) => Number(row.has_dependency) === 0)
      : sourceKind === "workbuddy"
        ? rows.every(
            (row) =>
              Number(row.has_dependency) === 0 &&
              row.status === "completed" &&
              row.timing_source === "explicit" &&
              generationWindow(row) &&
              Number(row.output_tokens) > 0 &&
              Number(row.duration_ms) > 0,
          )
        : sourceKind === "codex" &&
          rows.every(
            (row) =>
              Number(row.has_dependency) === 1 &&
              row.status === "completed" &&
              row.timing_source === "explicit" &&
              (isGenerationPerfMethod(methodVersion) ? generationWindow(row) : row.timing_kind === "request_e2e"),
          );
  if (!supported) return undefined;
  if (sourceKind === "codex" && requireComponents) {
    const codexRequestsRow = database
      .prepare("SELECT value FROM store_meta WHERE key = ?")
      .get(HISTORY_ARCHIVE_CODEX_REQUESTS_META_KEY);
    if (!codexRequestsRow) return undefined;
    let codexRequests;
    try {
      codexRequests = JSON.parse(String(codexRequestsRow.value));
    } catch {
      throw archiveError(
        "HISTORY_ARCHIVE_CANDIDATE_CODEX_REQUESTS_BAD_METADATA",
        "Codex request facts are not valid JSON",
      );
    }
    validateCodexRequestEvidence(database, codexRequests, startMs, endMs);
  }
  return {
    table: "perf_samples",
    sampleKeys: rows.map((row) => String(row.sample_key)),
    sha256: perfSampleEvidence(database, startMs, endMs).sha256,
    sourceKind,
    methodVersion,
  };
}

function perfTableEvidence(table, columns, startMs, endMs, iterator, requireSourceIdentity = false) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ table, startMs, endMs, columns }));
  hash.update("\n");
  let rows = 0;
  for (const row of iterator) {
    if (requireSourceIdentity && row.path === null) {
      throw archiveError(
        "HISTORY_ARCHIVE_CANDIDATE_PERF_DEPENDENCIES_MISSING",
        `perf dependency ${String(row.referenced_path)} has no source_files identity`,
      );
    }
    hash.update(JSON.stringify(Object.fromEntries(columns.map((column) => [column, row[column]]))));
    hash.update("\n");
    rows += 1;
  }
  return { rows, sha256: hash.digest("hex") };
}

function perfIndexEvidence(database, startMs, endMs) {
  const sampleSources = perfTableEvidence(
    "perf_sample_sources",
    HISTORY_ARCHIVE_PERF_SAMPLE_SOURCE_COLUMNS,
    startMs,
    endMs,
    database
      .prepare(
        `SELECT dependencies.sample_key, dependencies.source_path, dependencies.role
         FROM perf_samples AS samples
         JOIN perf_sample_sources AS dependencies ON dependencies.sample_key = samples.sample_key
         WHERE samples.ts_ms >= ? AND samples.ts_ms < ?
         ORDER BY dependencies.sample_key, dependencies.source_path`,
      )
      .iterate(startMs, endMs),
  );
  const rolloutThreads = perfTableEvidence(
    "perf_rollout_threads",
    HISTORY_ARCHIVE_PERF_ROLLOUT_COLUMNS,
    startMs,
    endMs,
    database
      .prepare(
        `${HISTORY_ARCHIVE_PERF_INDEX_REFERENCED_PATHS_CTE}
         SELECT rollouts.source_path, rollouts.home_id, rollouts.thread_id
         FROM perf_rollout_threads AS rollouts
         JOIN referenced ON referenced.path = rollouts.source_path
         ORDER BY rollouts.source_path`,
      )
      .iterate(startMs, endMs, startMs, endMs),
  );
  const sourceFiles = perfTableEvidence(
    "source_files",
    HISTORY_ARCHIVE_SOURCE_IDENTITY_COLUMNS,
    startMs,
    endMs,
    database
      .prepare(
        `${HISTORY_ARCHIVE_PERF_INDEX_REFERENCED_PATHS_CTE}
         SELECT referenced.path AS referenced_path,
                source_files.path, source_files.kind, source_files.home_id,
                source_files.home_label, source_files.home_path
         FROM referenced
         LEFT JOIN source_files ON source_files.path = referenced.path
         ORDER BY referenced.path`,
      )
      .iterate(startMs, endMs, startMs, endMs),
    true,
  );
  return {
    formatVersion: HISTORY_ARCHIVE_PERF_INDEX_FORMAT_VERSION,
    startMs,
    endMs,
    tables: {
      perf_sample_sources: sampleSources,
      perf_rollout_threads: rolloutThreads,
      source_files: sourceFiles,
    },
  };
}

function assertExplicitCodexTimingEvidence(database, startMs, endMs) {
  const samples = codexBoundedExplicitSamples(database, startMs, endMs);
  const legacyThreads = new Map();
  const missing = (sampleKey) =>
    archiveError(
      "HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_DEPENDENCIES_MISSING",
      `bounded explicit Codex perf sample ${String(sampleKey)} has no native request-timing evidence`,
    );

  for (const sample of samples) {
    const identity = parseCodexRequestSampleKey(sample);
    try {
      codexRequestSampleGraph(database, sample, identity.threadId);
    } catch {
      throw missing(sample.sample_key);
    }
    if (identity.responseId === undefined) {
      legacyThreads.set(JSON.stringify([identity.homeId, identity.threadId]), identity);
      continue;
    }
    const evidence = database
      .prepare(
        `SELECT
           (
             SELECT COUNT(*)
             FROM perf_request_timing_threads AS timing
             WHERE timing.home_id = ? AND timing.thread_id = ? AND timing.response_id = ?
           ) AS link_count,
           (
             SELECT COUNT(*)
             FROM perf_request_timing_evidence AS evidence
             WHERE evidence.home_id = ? AND evidence.response_id = ?
           ) AS evidence_count`,
      )
      .get(identity.homeId, identity.threadId, identity.responseId, identity.homeId, identity.responseId);
    if (Number(evidence.link_count) !== 1 || Number(evidence.evidence_count) < 1) {
      throw missing(sample.sample_key);
    }
  }

  for (const identity of legacyThreads.values()) {
    const orphan = database
      .prepare(
        `SELECT samples.sample_key
         FROM perf_samples AS samples
         WHERE samples.ts_ms >= ? AND samples.ts_ms < ?
           AND samples.source_kind = 'codex'
           AND samples.status = 'completed'
           AND samples.timing_kind = 'request_e2e'
           AND samples.timing_source = 'explicit'
           AND (
             NOT EXISTS (
               SELECT 1
               FROM perf_sample_sources AS dependencies
               JOIN perf_rollout_threads AS owners ON owners.source_path = dependencies.source_path
               JOIN perf_request_timing_threads AS timing
                 ON timing.home_id = owners.home_id AND timing.thread_id = owners.thread_id
               JOIN perf_request_timing_evidence AS evidence
                 ON evidence.home_id = timing.home_id AND evidence.response_id = timing.response_id
               WHERE dependencies.sample_key = samples.sample_key
                 AND owners.home_id = ? AND owners.thread_id = ?
             )
             OR EXISTS (
               SELECT 1
               FROM perf_sample_sources AS dependencies
               JOIN perf_rollout_threads AS owners ON owners.source_path = dependencies.source_path
               JOIN perf_request_timing_threads AS timing
                 ON timing.home_id = owners.home_id AND timing.thread_id = owners.thread_id
               LEFT JOIN perf_request_timing_evidence AS evidence
                 ON evidence.home_id = timing.home_id AND evidence.response_id = timing.response_id
               WHERE dependencies.sample_key = samples.sample_key
                 AND owners.home_id = ? AND owners.thread_id = ?
                 AND evidence.response_id IS NULL
             )
           )
         ORDER BY samples.ts_ms, samples.sample_key
         LIMIT 1`,
      )
      .get(startMs, endMs, identity.homeId, identity.threadId, identity.homeId, identity.threadId);
    if (orphan) throw missing(orphan.sample_key);
  }
}

function perfTimingEvidence(database, startMs, endMs) {
  try {
    assertExplicitCodexTimingEvidence(database, startMs, endMs);
    const availableEvidenceColumns = database
      .prepare("PRAGMA table_info(perf_request_timing_evidence)")
      .all()
      .map((row) => String(row.name));
    const evidenceColumns = availableEvidenceColumns.includes("generation_json")
      ? [...HISTORY_ARCHIVE_PERF_TIMING_EVIDENCE_COLUMNS, "generation_json"]
      : [...HISTORY_ARCHIVE_PERF_TIMING_EVIDENCE_COLUMNS];
    const threads = perfTableEvidence(
      "perf_request_timing_threads",
      HISTORY_ARCHIVE_PERF_TIMING_THREAD_COLUMNS,
      startMs,
      endMs,
      database
        .prepare(
          `${HISTORY_ARCHIVE_PERF_TIMING_OWNERS_CTE}
           SELECT timing.home_id, timing.response_id, timing.thread_id
           FROM perf_request_timing_threads AS timing
           JOIN owners ON owners.home_id = timing.home_id AND owners.thread_id = timing.thread_id
           ORDER BY timing.home_id, timing.response_id, timing.thread_id`,
        )
        .iterate(startMs, endMs, startMs, endMs),
    );
    const evidence = perfTableEvidence(
      "perf_request_timing_evidence",
      evidenceColumns,
      startMs,
      endMs,
      database
        .prepare(
          `${HISTORY_ARCHIVE_PERF_TIMING_LINKS_CTE}
           SELECT ${evidenceColumns.map((column) => `evidence.${column}`).join(", ")}
           FROM perf_request_timing_evidence AS evidence
           JOIN links ON links.home_id = evidence.home_id AND links.response_id = evidence.response_id
           ORDER BY evidence.home_id, evidence.evidence_origin, evidence.response_id, evidence.variant_key`,
        )
        .iterate(startMs, endMs, startMs, endMs),
    );
    return {
      formatVersion: HISTORY_ARCHIVE_PERF_TIMING_FORMAT_VERSION,
      startMs,
      endMs,
      tables: {
        perf_request_timing_threads: threads,
        perf_request_timing_evidence: evidence,
      },
    };
  } catch (error) {
    if (
      error?.code === "HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_MISMATCH" ||
      error?.code === "HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_DEPENDENCIES_MISSING"
    ) {
      throw error;
    }
    throw archiveError(
      "HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_MISMATCH",
      `perf request timing graph is invalid: ${error.message}`,
    );
  }
}

function codexRequestTimingMismatch(message) {
  return archiveError("HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_MISMATCH", message);
}

function codexBoundedExplicitSamples(database, startMs, endMs) {
  return database
    .prepare(
      `SELECT sample_key, source_path, source_kind, home_id, model, output_tokens, duration_ms,
              request_count, method_version, timing_kind, window, token_scope
       FROM perf_samples
       WHERE ts_ms >= ? AND ts_ms < ?
         AND source_kind = 'codex'
         AND status = 'completed'
         AND timing_kind IN ('request_e2e', 'generation')
         AND timing_source = 'explicit'
       ORDER BY sample_key`,
    )
    .all(startMs, endMs)
    .map((row) => ({ ...row }));
}

function effectiveCodexRequestSamples(samples, turns) {
  const samplesByKey = new Map(samples.map((sample) => [String(sample.sample_key), sample]));
  return turns.map((turn) => {
    const sample = samplesByKey.get(turn.sampleKey);
    if (!sample) {
      throw codexRequestTimingMismatch(`Codex request facts reference a missing effective sample ${turn.sampleKey}`);
    }
    return sample;
  });
}

function effectiveCodexRequestTiming(database, timingEvidence, query) {
  const homeId = String(query.homeId);
  const responseId = String(query.responseId);
  const rows = timingEvidence.filter((row) => String(row.home_id) === homeId && String(row.response_id) === responseId);
  if (rows.length === 0) {
    return {
      state: "missing",
      durationMs: null,
      reportedOutputTokens: null,
      requestedModel: "",
      generation: null,
    };
  }

  const links = database
    .prepare(
      `SELECT thread_id
       FROM perf_request_timing_threads
       WHERE home_id = ? AND response_id = ?
       ORDER BY thread_id`,
    )
    .all(homeId, responseId);
  if (links.length !== 1) {
    throw codexRequestTimingMismatch(`native request timing link for response ${responseId} is not unique`);
  }
  if (query.threadId !== undefined && query.threadId !== "" && String(links[0].thread_id) !== String(query.threadId)) {
    return {
      state: "missing",
      durationMs: null,
      reportedOutputTokens: null,
      requestedModel: "",
      generation: null,
    };
  }
  const variants = rows.map((row) => {
    const variant = validateStoredEvidence(row);
    const schemaVersion = Number(row.schema_version);
    return {
      schemaVersion,
      evidenceOrigin: String(row.evidence_origin),
      responseId,
      requestedModel: variant.requestedModel,
      reportedOutputTokens: variant.reportedOutputTokens,
      durationMs: variant.durationMs,
      status: "completed",
      completedAtMs: row.completed_at_ms === null ? null : Number(row.completed_at_ms),
      ...(schemaVersion === 2 ? { generation: variant.generation } : {}),
    };
  });
  const merged = mergeRequestTimingEvidence(variants);
  if (merged.state !== "available" || merged.evidence === null) {
    return {
      state: "conflict",
      durationMs: null,
      reportedOutputTokens: null,
      requestedModel: "",
      generation: null,
    };
  }
  return {
    state: "available",
    durationMs: merged.evidence.durationMs,
    reportedOutputTokens: merged.evidence.reportedOutputTokens,
    requestedModel: merged.evidence.requestedModel,
    generation: merged.evidence.generation ?? null,
  };
}

function parseCodexRequestSampleKey(sample) {
  let parsed;
  try {
    parsed = JSON.parse(String(sample.sample_key));
  } catch {
    throw codexRequestTimingMismatch(`bounded Codex sample ${String(sample.sample_key)} has an invalid sample_key`);
  }
  if (
    !Array.isArray(parsed) ||
    (parsed.length !== 4 && parsed.length !== 5) ||
    parsed.some((part) => typeof part !== "string" || part === "")
  ) {
    throw codexRequestTimingMismatch(`bounded Codex sample ${String(sample.sample_key)} has an invalid sample_key`);
  }
  const [sourceKind, homeId, threadId, turnId, responseId] = parsed;
  if (sourceKind !== String(sample.source_kind) || homeId !== String(sample.home_id)) {
    throw codexRequestTimingMismatch(`bounded Codex sample ${String(sample.sample_key)} disagrees with its identity`);
  }
  const current = isGenerationPerfMethod(String(sample.method_version));
  if ((current && parsed.length !== 5) || (!current && parsed.length !== 4)) {
    throw codexRequestTimingMismatch(
      `bounded Codex sample ${String(sample.sample_key)} has an unsupported key shape for its method version`,
    );
  }
  return {
    sourceKind,
    homeId,
    threadId,
    turnId,
    ...(responseId === undefined ? {} : { responseId }),
  };
}

function codexRequestSampleGraph(database, sample, threadId) {
  const dependencies = database
    .prepare(
      `SELECT source_path
       FROM perf_sample_sources
       WHERE sample_key = ?
       ORDER BY source_path`,
    )
    .all(String(sample.sample_key))
    .map((row) => String(row.source_path));
  if (dependencies.length === 0) {
    throw codexRequestTimingMismatch(
      `bounded Codex sample ${String(sample.sample_key)} has no perf source dependencies`,
    );
  }
  if (!dependencies.includes(String(sample.source_path))) {
    throw codexRequestTimingMismatch(`bounded Codex sample ${String(sample.sample_key)} source is not a dependency`);
  }

  const identities = database
    .prepare(
      `SELECT path, home_id
       FROM source_files
       WHERE path IN (${dependencies.map(() => "?").join(",")})
       ORDER BY path`,
    )
    .all(...dependencies);
  if (
    identities.length !== dependencies.length ||
    identities.some((row) => String(row.home_id) !== String(sample.home_id))
  ) {
    throw codexRequestTimingMismatch(
      `bounded Codex sample ${String(sample.sample_key)} has an incomplete source identity`,
    );
  }

  const owners = database
    .prepare(
      `SELECT source_path
       FROM perf_rollout_threads
       WHERE home_id = ? AND thread_id = ?
       ORDER BY source_path`,
    )
    .all(String(sample.home_id), threadId)
    .map((row) => String(row.source_path));
  if (owners.length === 0 || dependencies.some((sourcePath) => !owners.includes(sourcePath))) {
    throw codexRequestTimingMismatch(
      `bounded Codex sample ${String(sample.sample_key)} has an incomplete native rollout owner`,
    );
  }
  return owners;
}

function codexTurnRequestFacts(database, sample, identity, ownerPaths, foldedByThread) {
  const cacheKey = JSON.stringify([identity.homeId, identity.threadId]);
  let folded = foldedByThread.get(cacheKey);
  if (!folded) {
    const projectionsByPath = new Map(
      database
        .prepare(
          `SELECT path, projection
           FROM perf_codex_projections
           WHERE home_id = ?`,
        )
        .all(identity.homeId)
        .map((row) => [canonicalArchivePath(row.path), String(row.projection)]),
    );
    const projections = ownerPaths.map((sourcePath) => {
      const serialized = projectionsByPath.get(canonicalArchivePath(sourcePath));
      if (serialized === undefined) {
        throw codexRequestTimingMismatch(
          `bounded Codex sample ${String(sample.sample_key)} is missing native projection ${sourcePath}`,
        );
      }
      let projection;
      try {
        projection = JSON.parse(serialized);
      } catch {
        throw codexRequestTimingMismatch(
          `bounded Codex sample ${String(sample.sample_key)} has an invalid native projection`,
        );
      }
      if (!projection || typeof projection !== "object" || !Array.isArray(projection.records)) {
        throw codexRequestTimingMismatch(
          `bounded Codex sample ${String(sample.sample_key)} has an invalid native projection`,
        );
      }
      return projection;
    });
    folded = foldCodexRolloutMetadata(identity.homeId, projections);
    foldedByThread.set(cacheKey, folded);
  }

  const turn = folded.turns.find(
    (candidate) => candidate.threadId === identity.threadId && candidate.turnId === identity.turnId,
  );
  if (!turn) {
    throw codexRequestTimingMismatch(`bounded Codex sample ${String(sample.sample_key)} has no native request turn`);
  }
  const response =
    identity.responseId === undefined
      ? null
      : (Array.isArray(turn.responses) ? turn.responses : []).filter(
          (candidate) => candidate.responseId === identity.responseId,
        );
  if (
    typeof turn.model !== "string" ||
    turn.model === "" ||
    (identity.responseId === undefined
      ? turn.requestSetComplete !== true || turn.recordConflictCount !== 0
      : response.length !== 1 || response[0].conflict === true)
  ) {
    throw codexRequestTimingMismatch(
      `bounded Codex sample ${String(sample.sample_key)} has incomplete native request facts`,
    );
  }

  const turnRequests =
    identity.responseId === undefined
      ? turn.requests
      : turn.requests.filter((request) => request.responseId === identity.responseId);
  if (identity.responseId !== undefined && turnRequests.length !== 1) {
    throw codexRequestTimingMismatch(
      `bounded Codex sample ${String(sample.sample_key)} has no unique native response request`,
    );
  }
  const requests = turnRequests
    .map((request) => ({
      responseId: request.responseId,
      outputTokens: request.outputTokens,
    }))
    .sort((left, right) => compareArchiveText(String(left.responseId), String(right.responseId)));
  if (
    requests.length === 0 ||
    requests.some(
      (request) =>
        typeof request.responseId !== "string" ||
        request.responseId === "" ||
        !Number.isSafeInteger(request.outputTokens) ||
        request.outputTokens < 0,
    ) ||
    new Set(requests.map((request) => request.responseId)).size !== requests.length
  ) {
    throw codexRequestTimingMismatch(
      `bounded Codex sample ${String(sample.sample_key)} has invalid native request facts`,
    );
  }

  return {
    sampleKey: String(sample.sample_key),
    sourceKind: identity.sourceKind,
    homeId: identity.homeId,
    sourcePath: String(sample.source_path),
    threadId: identity.threadId,
    turnId: identity.turnId,
    model: turn.model,
    requestSetComplete: true,
    requests,
  };
}

function normalizeCodexRequestEvidence(evidence, startMs, endMs) {
  const bad = (message) => archiveError("HISTORY_ARCHIVE_CANDIDATE_CODEX_REQUESTS_BAD_METADATA", message);
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(",") !== "endMs,formatVersion,startMs,turns"
  ) {
    throw bad("Codex request facts must contain exactly formatVersion, startMs, endMs, and turns");
  }
  if (evidence.formatVersion !== HISTORY_ARCHIVE_CODEX_REQUESTS_FORMAT_VERSION) {
    throw bad("Codex request facts format version is unsupported");
  }
  if (evidence.startMs !== startMs || evidence.endMs !== endMs) {
    throw bad("Codex request facts range does not match the archive candidate");
  }
  if (!Array.isArray(evidence.turns)) throw bad("Codex request facts turns must be an array");

  const sampleKeys = new Set();
  const turns = evidence.turns.map((turn, turnIndex) => {
    if (
      turn === null ||
      typeof turn !== "object" ||
      Array.isArray(turn) ||
      Object.keys(turn).sort().join(",") !==
        "homeId,model,requestSetComplete,requests,sampleKey,sourceKind,sourcePath,threadId,turnId"
    ) {
      throw bad(`Codex request facts turn ${turnIndex} has an invalid shape`);
    }
    for (const field of ["sampleKey", "sourceKind", "homeId", "sourcePath", "threadId", "turnId", "model"]) {
      if (typeof turn[field] !== "string" || turn[field] === "") {
        throw bad(`Codex request facts turn ${turnIndex} ${field} must be a non-empty string`);
      }
    }
    if (turn.sourceKind !== "codex") {
      throw archiveError(
        "HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_MISMATCH",
        `Codex request facts turn ${turnIndex} has an unsupported source kind`,
      );
    }
    if (typeof turn.requestSetComplete !== "boolean") {
      throw bad(`Codex request facts turn ${turnIndex} requestSetComplete must be boolean`);
    }
    if (sampleKeys.has(turn.sampleKey)) {
      throw bad(`Codex request facts contain duplicate sample ${turn.sampleKey}`);
    }
    sampleKeys.add(turn.sampleKey);
    if (!Array.isArray(turn.requests) || turn.requests.length === 0) {
      throw bad(`Codex request facts turn ${turnIndex} requests must be a non-empty array`);
    }

    const responseIds = new Set();
    const requests = turn.requests.map((request, requestIndex) => {
      if (
        request === null ||
        typeof request !== "object" ||
        Array.isArray(request) ||
        Object.keys(request).sort().join(",") !== "outputTokens,responseId"
      ) {
        throw bad(`Codex request facts turn ${turnIndex} request ${requestIndex} has an invalid shape`);
      }
      if (typeof request.responseId !== "string" || request.responseId === "") {
        throw bad(`Codex request facts turn ${turnIndex} request ${requestIndex} responseId is invalid`);
      }
      if (!Number.isSafeInteger(request.outputTokens) || request.outputTokens < 0) {
        throw bad(`Codex request facts turn ${turnIndex} request ${requestIndex} outputTokens is invalid`);
      }
      if (responseIds.has(request.responseId)) {
        throw bad(`Codex request facts turn ${turnIndex} contains duplicate response ${request.responseId}`);
      }
      responseIds.add(request.responseId);
      return { responseId: request.responseId, outputTokens: request.outputTokens };
    });
    requests.sort((left, right) => compareArchiveText(left.responseId, right.responseId));
    return {
      sampleKey: turn.sampleKey,
      sourceKind: turn.sourceKind,
      homeId: turn.homeId,
      sourcePath: turn.sourcePath,
      threadId: turn.threadId,
      turnId: turn.turnId,
      model: turn.model,
      requestSetComplete: turn.requestSetComplete,
      requests,
    };
  });
  turns.sort((left, right) => compareArchiveText(left.sampleKey, right.sampleKey));
  return {
    formatVersion: HISTORY_ARCHIVE_CODEX_REQUESTS_FORMAT_VERSION,
    startMs,
    endMs,
    turns,
  };
}

export function validateCodexRequestEvidence(database, evidence, startMs, endMs, effective = undefined) {
  const normalized = normalizeCodexRequestEvidence(evidence, startMs, endMs);
  const samples = effective
    ? effectiveCodexRequestSamples(effective.samples, normalized.turns)
    : codexBoundedExplicitSamples(database, startMs, endMs);
  const samplesByKey = new Map(samples.map((sample) => [String(sample.sample_key), sample]));
  if (!effective && normalized.turns.length !== samples.length) {
    throw codexRequestTimingMismatch("Codex request facts do not cover exactly the bounded samples");
  }

  for (const turn of normalized.turns) {
    const sample = samplesByKey.get(turn.sampleKey);
    if (!sample) {
      throw codexRequestTimingMismatch(`Codex request facts reference an unbounded sample ${turn.sampleKey}`);
    }
    samplesByKey.delete(turn.sampleKey);
    const identity = parseCodexRequestSampleKey(sample);
    const currentMethod = isGenerationPerfMethod(String(sample.method_version));
    if (
      turn.sourceKind !== identity.sourceKind ||
      turn.homeId !== identity.homeId ||
      turn.threadId !== identity.threadId ||
      turn.turnId !== identity.turnId ||
      turn.sourcePath !== String(sample.source_path) ||
      turn.model !== String(sample.model) ||
      turn.requestSetComplete !== true ||
      turn.requests.length !== Number(sample.request_count) ||
      (currentMethod
        ? turn.requests.length !== 1 ||
          sample.timing_kind !== "generation" ||
          sample.window !== "request" ||
          sample.token_scope !== "non_reasoning_output"
        : sample.timing_kind !== "request_e2e")
    ) {
      throw codexRequestTimingMismatch(`Codex request facts disagree with bounded sample ${turn.sampleKey}`);
    }
    codexRequestSampleGraph(database, sample, identity.threadId);

    const lookup = (query) =>
      effective
        ? effectiveCodexRequestTiming(database, effective.timingEvidence, query)
        : lookupRequestTiming(database, {
            homeId: query.homeId,
            threadId: query.threadId,
            turnId: query.turnId,
            responseId: query.responseId,
            model: query.model,
            outputTokens: typeof query.outputTokens === "number" ? query.outputTokens : undefined,
            reasoningOutputTokens:
              typeof query.reasoningOutputTokens === "number" ? query.reasoningOutputTokens : undefined,
          });
    if (currentMethod) {
      let timing;
      try {
        timing = resolveCodexRequestTiming(
          identity.homeId,
          { threadId: identity.threadId, turnId: identity.turnId, model: turn.model },
          turn.requests[0],
          lookup,
        );
      } catch (error) {
        throw codexRequestTimingMismatch(
          `bounded Codex sample ${turn.sampleKey} native timing lookup failed: ${error.message}`,
        );
      }
      const generation = generationPerfValues(timing.generation);
      if (
        timing.state !== "available" ||
        timing.reportedOutputTokens !== turn.requests[0].outputTokens ||
        generation === null ||
        Number(sample.output_tokens) !== generation.outputTokens ||
        Number(sample.duration_ms) !== generation.durationMs ||
        Number(sample.request_count) !== 1
      ) {
        throw codexRequestTimingMismatch(
          `bounded Codex sample ${turn.sampleKey} raw output, duration, or generation window contradicts native timing facts`,
        );
      }
    } else {
      let timing;
      try {
        timing = resolveCodexTurnRequestTiming(
          identity.homeId,
          {
            threadId: identity.threadId,
            turnId: identity.turnId,
            model: turn.model,
            requests: turn.requests,
            requestSetComplete: turn.requestSetComplete,
          },
          lookup,
        );
      } catch (error) {
        throw codexRequestTimingMismatch(
          `bounded Codex sample ${turn.sampleKey} native timing lookup failed: ${error.message}`,
        );
      }
      const effectiveTimingSource = timing.state === "complete" ? "explicit" : "unknown";
      const effectiveDurationMs = timing.state === "complete" ? timing.durationMs : null;
      if (
        effective
          ? sample.timing_source !== effectiveTimingSource ||
            sample.duration_ms !== effectiveDurationMs ||
            Number(sample.request_count) !== timing.requestCount
          : timing.state !== "complete" ||
            timing.timedRequestCount !== Number(sample.request_count) ||
            timing.requestCount !== Number(sample.request_count) ||
            timing.durationMs !== Number(sample.duration_ms)
      ) {
        throw codexRequestTimingMismatch(
          `bounded Codex sample ${turn.sampleKey} duration or request count contradicts native timing facts`,
        );
      }
    }
  }
  return normalized;
}

function codexRequestEvidence(database, startMs, endMs) {
  const samples = codexBoundedExplicitSamples(database, startMs, endMs);
  const foldedByThread = new Map();
  const turns = samples.map((sample) => {
    const identity = parseCodexRequestSampleKey(sample);
    const ownerPaths = codexRequestSampleGraph(database, sample, identity.threadId);
    return codexTurnRequestFacts(database, sample, identity, ownerPaths, foldedByThread);
  });
  const evidence = normalizeCodexRequestEvidence(
    {
      formatVersion: HISTORY_ARCHIVE_CODEX_REQUESTS_FORMAT_VERSION,
      startMs,
      endMs,
      turns,
    },
    startMs,
    endMs,
  );
  return validateCodexRequestEvidence(database, evidence, startMs, endMs);
}

function workbuddyObservationEvidence(database, startMs, endMs) {
  const observations = perfTableEvidence(
    "workbuddy_generation_duration_observations",
    HISTORY_ARCHIVE_WORKBUDDY_OBSERVATION_COLUMNS,
    startMs,
    endMs,
    database
      .prepare(
        `${HISTORY_ARCHIVE_WORKBUDDY_REFERENCED_HOMES_CTE}
         SELECT observations.home_id, observations.message_id, observations.duration_ms,
                observations.ended_at_ms, observations.capture_version, observations.captured_at
         FROM workbuddy_generation_duration_observations AS observations
         JOIN referenced_homes ON referenced_homes.home_id = observations.home_id
         ORDER BY observations.home_id, observations.message_id, observations.duration_ms`,
      )
      .iterate(startMs, endMs, startMs, endMs),
  );
  const sourceFiles = perfTableEvidence(
    "source_files",
    HISTORY_ARCHIVE_SOURCE_IDENTITY_COLUMNS,
    startMs,
    endMs,
    database
      .prepare(
        `${HISTORY_ARCHIVE_WORKBUDDY_REFERENCED_HOMES_CTE}
         SELECT source_files.path, source_files.kind, source_files.home_id,
                source_files.home_label, source_files.home_path
         FROM source_files
         JOIN referenced_homes ON referenced_homes.home_id = source_files.home_id
         WHERE source_files.kind = 'workbuddy'
         ORDER BY source_files.path`,
      )
      .iterate(startMs, endMs, startMs, endMs),
  );
  return {
    formatVersion: HISTORY_ARCHIVE_WORKBUDDY_OBSERVATIONS_FORMAT_VERSION,
    startMs,
    endMs,
    scope: HISTORY_ARCHIVE_WORKBUDDY_OBSERVATIONS_SCOPE,
    tables: {
      workbuddy_generation_duration_observations: observations,
      source_files: sourceFiles,
    },
  };
}

function normalizePerfSourceInventory(inventory) {
  const bad = (message) => archiveError("HISTORY_ARCHIVE_CANDIDATE_PERF_SOURCES_BAD_METADATA", message);
  if (
    inventory === null ||
    typeof inventory !== "object" ||
    Array.isArray(inventory) ||
    Object.keys(inventory).sort().join(",") !== "formatVersion,sources"
  ) {
    throw bad("perf source inventory must contain exactly formatVersion and sources");
  }
  if (inventory.formatVersion !== HISTORY_ARCHIVE_PERF_SOURCES_FORMAT_VERSION) {
    throw bad("perf source inventory format version is unsupported");
  }
  if (!Array.isArray(inventory.sources)) {
    throw bad("perf source inventory sources must be an array");
  }
  const paths = new Set();
  return {
    formatVersion: HISTORY_ARCHIVE_PERF_SOURCES_FORMAT_VERSION,
    sources: inventory.sources.map((source, index) => {
      if (
        source === null ||
        typeof source !== "object" ||
        Array.isArray(source) ||
        Object.keys(source).sort().join(",") !==
          "homeId,homeLabel,homePath,kind,methodVersions,path,sampleCount,sampleKeysSha256"
      ) {
        throw bad(`perf source inventory entry ${index} has an invalid shape`);
      }
      for (const field of ["path", "kind", "homeId", "homeLabel", "homePath"]) {
        if (typeof source[field] !== "string") {
          throw bad(`perf source inventory entry ${index} ${field} must be a string`);
        }
      }
      if (source.path === "") {
        throw bad(`perf source inventory entry ${index} path must be non-empty`);
      }
      if (paths.has(source.path)) {
        throw bad(`perf source inventory contains duplicate source ${source.path}`);
      }
      paths.add(source.path);
      if (!Number.isSafeInteger(source.sampleCount) || source.sampleCount <= 0) {
        throw bad(`perf source inventory entry ${index} sampleCount must be a positive integer`);
      }
      if (typeof source.sampleKeysSha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sampleKeysSha256)) {
        throw bad(`perf source inventory entry ${index} sampleKeysSha256 is invalid`);
      }
      if (
        !Array.isArray(source.methodVersions) ||
        source.methodVersions.length === 0 ||
        !source.methodVersions.every((version) => typeof version === "string" && version !== "") ||
        JSON.stringify([...new Set(source.methodVersions)].sort()) !== JSON.stringify(source.methodVersions)
      ) {
        throw bad(`perf source inventory entry ${index} methodVersions must be a sorted unique string array`);
      }
      return {
        path: source.path,
        kind: source.kind,
        homeId: source.homeId,
        homeLabel: source.homeLabel,
        homePath: source.homePath,
        sampleCount: source.sampleCount,
        sampleKeysSha256: source.sampleKeysSha256,
        methodVersions: [...source.methodVersions],
      };
    }),
  };
}

function normalizePerfSampleEvidence(evidence, startMs, endMs) {
  const bad = (message) => archiveError("HISTORY_ARCHIVE_CANDIDATE_PERF_SAMPLES_BAD_METADATA", message);
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(",") !== "endMs,formatVersion,rows,sha256,startMs"
  ) {
    throw bad("perf sample evidence must contain exactly formatVersion, startMs, endMs, rows, and sha256");
  }
  if (evidence.formatVersion !== HISTORY_ARCHIVE_PERF_SAMPLES_FORMAT_VERSION) {
    throw bad("perf sample evidence format version is unsupported");
  }
  if (evidence.startMs !== startMs || evidence.endMs !== endMs) {
    throw bad("perf sample evidence range does not match the archive candidate");
  }
  if (!Number.isSafeInteger(evidence.rows) || evidence.rows < 0) {
    throw bad("perf sample evidence rows must be a non-negative integer");
  }
  if (typeof evidence.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(evidence.sha256)) {
    throw bad("perf sample evidence sha256 is invalid");
  }
  return {
    formatVersion: HISTORY_ARCHIVE_PERF_SAMPLES_FORMAT_VERSION,
    startMs,
    endMs,
    rows: evidence.rows,
    sha256: evidence.sha256,
  };
}

function normalizePerfIndexEvidence(evidence, startMs, endMs) {
  const bad = (message) => archiveError("HISTORY_ARCHIVE_CANDIDATE_PERF_DEPENDENCIES_BAD_METADATA", message);
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(",") !== "endMs,formatVersion,startMs,tables"
  ) {
    throw bad("perf index evidence must contain exactly formatVersion, startMs, endMs, and tables");
  }
  if (evidence.formatVersion !== HISTORY_ARCHIVE_PERF_INDEX_FORMAT_VERSION) {
    throw bad("perf index evidence format version is unsupported");
  }
  if (evidence.startMs !== startMs || evidence.endMs !== endMs) {
    throw bad("perf index evidence range does not match the archive candidate");
  }
  if (
    evidence.tables === null ||
    typeof evidence.tables !== "object" ||
    Array.isArray(evidence.tables) ||
    Object.keys(evidence.tables).sort().join(",") !== [...HISTORY_ARCHIVE_PERF_INDEX_TABLE_NAMES].sort().join(",")
  ) {
    throw bad(`perf index evidence must contain exactly ${HISTORY_ARCHIVE_PERF_INDEX_TABLE_NAMES.join(", ")}`);
  }
  const tables = {};
  for (const table of HISTORY_ARCHIVE_PERF_INDEX_TABLE_NAMES) {
    const tableEvidence = evidence.tables[table];
    if (
      tableEvidence === null ||
      typeof tableEvidence !== "object" ||
      Array.isArray(tableEvidence) ||
      Object.keys(tableEvidence).sort().join(",") !== "rows,sha256"
    ) {
      throw bad(`perf index evidence table ${table} must contain exactly rows and sha256`);
    }
    if (!Number.isSafeInteger(tableEvidence.rows) || tableEvidence.rows < 0) {
      throw bad(`perf index evidence table ${table} rows must be a non-negative integer`);
    }
    if (typeof tableEvidence.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(tableEvidence.sha256)) {
      throw bad(`perf index evidence table ${table} sha256 is invalid`);
    }
    tables[table] = { rows: tableEvidence.rows, sha256: tableEvidence.sha256 };
  }
  return {
    formatVersion: HISTORY_ARCHIVE_PERF_INDEX_FORMAT_VERSION,
    startMs,
    endMs,
    tables,
  };
}

function normalizePerfTimingEvidence(evidence, startMs, endMs) {
  const bad = (message) => archiveError("HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_BAD_METADATA", message);
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(",") !== "endMs,formatVersion,startMs,tables"
  ) {
    throw bad("perf timing evidence must contain exactly formatVersion, startMs, endMs, and tables");
  }
  if (evidence.formatVersion !== HISTORY_ARCHIVE_PERF_TIMING_FORMAT_VERSION) {
    throw bad("perf timing evidence format version is unsupported");
  }
  if (evidence.startMs !== startMs || evidence.endMs !== endMs) {
    throw bad("perf timing evidence range does not match the archive candidate");
  }
  if (
    evidence.tables === null ||
    typeof evidence.tables !== "object" ||
    Array.isArray(evidence.tables) ||
    Object.keys(evidence.tables).sort().join(",") !== [...HISTORY_ARCHIVE_PERF_TIMING_TABLE_NAMES].sort().join(",")
  ) {
    throw bad(`perf timing evidence must contain exactly ${HISTORY_ARCHIVE_PERF_TIMING_TABLE_NAMES.join(", ")}`);
  }
  const tables = {};
  for (const table of HISTORY_ARCHIVE_PERF_TIMING_TABLE_NAMES) {
    const tableEvidence = evidence.tables[table];
    if (
      tableEvidence === null ||
      typeof tableEvidence !== "object" ||
      Array.isArray(tableEvidence) ||
      Object.keys(tableEvidence).sort().join(",") !== "rows,sha256"
    ) {
      throw bad(`perf timing evidence table ${table} must contain exactly rows and sha256`);
    }
    if (!Number.isSafeInteger(tableEvidence.rows) || tableEvidence.rows < 0) {
      throw bad(`perf timing evidence table ${table} rows must be a non-negative integer`);
    }
    if (typeof tableEvidence.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(tableEvidence.sha256)) {
      throw bad(`perf timing evidence table ${table} sha256 is invalid`);
    }
    tables[table] = { rows: tableEvidence.rows, sha256: tableEvidence.sha256 };
  }
  return {
    formatVersion: HISTORY_ARCHIVE_PERF_TIMING_FORMAT_VERSION,
    startMs,
    endMs,
    tables,
  };
}

function normalizeWorkbuddyObservationEvidence(evidence, startMs, endMs) {
  const bad = (message) => archiveError("HISTORY_ARCHIVE_CANDIDATE_WORKBUDDY_BAD_METADATA", message);
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(",") !== "endMs,formatVersion,scope,startMs,tables"
  ) {
    throw bad("WorkBuddy observation evidence must contain exactly formatVersion, startMs, endMs, scope, and tables");
  }
  if (evidence.formatVersion !== HISTORY_ARCHIVE_WORKBUDDY_OBSERVATIONS_FORMAT_VERSION) {
    throw bad("WorkBuddy observation evidence format version is unsupported");
  }
  if (evidence.startMs !== startMs || evidence.endMs !== endMs) {
    throw bad("WorkBuddy observation evidence range does not match the archive candidate");
  }
  if (evidence.scope !== HISTORY_ARCHIVE_WORKBUDDY_OBSERVATIONS_SCOPE) {
    throw bad("WorkBuddy observation evidence scope is unsupported");
  }
  if (
    evidence.tables === null ||
    typeof evidence.tables !== "object" ||
    Array.isArray(evidence.tables) ||
    Object.keys(evidence.tables).sort().join(",") !==
      [...HISTORY_ARCHIVE_WORKBUDDY_OBSERVATIONS_TABLE_NAMES].sort().join(",")
  ) {
    throw bad(
      `WorkBuddy observation evidence must contain exactly ${HISTORY_ARCHIVE_WORKBUDDY_OBSERVATIONS_TABLE_NAMES.join(", ")}`,
    );
  }
  const tables = {};
  for (const table of HISTORY_ARCHIVE_WORKBUDDY_OBSERVATIONS_TABLE_NAMES) {
    const tableEvidence = evidence.tables[table];
    if (
      tableEvidence === null ||
      typeof tableEvidence !== "object" ||
      Array.isArray(tableEvidence) ||
      Object.keys(tableEvidence).sort().join(",") !== "rows,sha256"
    ) {
      throw bad(`WorkBuddy observation evidence table ${table} must contain exactly rows and sha256`);
    }
    if (!Number.isSafeInteger(tableEvidence.rows) || tableEvidence.rows < 0) {
      throw bad(`WorkBuddy observation evidence table ${table} rows must be a non-negative integer`);
    }
    if (typeof tableEvidence.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(tableEvidence.sha256)) {
      throw bad(`WorkBuddy observation evidence table ${table} sha256 is invalid`);
    }
    tables[table] = { rows: tableEvidence.rows, sha256: tableEvidence.sha256 };
  }
  return {
    formatVersion: HISTORY_ARCHIVE_WORKBUDDY_OBSERVATIONS_FORMAT_VERSION,
    startMs,
    endMs,
    scope: HISTORY_ARCHIVE_WORKBUDDY_OBSERVATIONS_SCOPE,
    tables,
  };
}

function validateEvidence(evidence, label) {
  if (
    !evidence ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(",") !== "rows,sha256" ||
    !Number.isSafeInteger(evidence.rows) ||
    evidence.rows < 0 ||
    typeof evidence.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(evidence.sha256)
  ) {
    throw archiveError("HISTORY_ARCHIVE_CANDIDATE_BAD_METADATA", `archive candidate ${label} evidence is invalid`);
  }
  return evidence;
}

function validateCandidateMetadata(metadata) {
  const keys = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? Object.keys(metadata).sort() : [];
  if (keys.join(",") !== "endMs,events,formatVersion,sources,startMs,state") {
    throw archiveError("HISTORY_ARCHIVE_CANDIDATE_BAD_METADATA", "archive candidate metadata shape is invalid");
  }
  if (metadata.formatVersion !== HISTORY_ARCHIVE_CANDIDATE_FORMAT_VERSION || metadata.state !== "unregistered") {
    throw archiveError("HISTORY_ARCHIVE_CANDIDATE_BAD_METADATA", "archive candidate format or state is invalid");
  }
  try {
    assertArchiveRange(metadata.startMs, metadata.endMs);
  } catch (error) {
    throw archiveError("HISTORY_ARCHIVE_CANDIDATE_BAD_METADATA", error.message);
  }
  validateEvidence(metadata.events, "event");
  validateEvidence(metadata.sources, "source");
  return metadata;
}

function candidateMetadata(database) {
  const row = database.prepare("SELECT value FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_CANDIDATE_META_KEY);
  if (!row) {
    throw archiveError("HISTORY_ARCHIVE_CANDIDATE_BAD_METADATA", "archive candidate metadata is missing");
  }
  let metadata;
  try {
    metadata = JSON.parse(row.value);
  } catch {
    throw archiveError("HISTORY_ARCHIVE_CANDIDATE_BAD_METADATA", "archive candidate metadata is not valid JSON");
  }
  return validateCandidateMetadata(metadata);
}

/**
 * Build an unregistered archive candidate from a private filtered database copy.
 * @param {{startMs?: number, endMs?: number, serviceTierEvidence?: ReturnType<typeof import("./service-tier-evidence.js").serviceTierEvidenceFromSnapshot> | null}} [options]
 */
export async function createHistoryArchiveCandidate(database, destinationFile, options = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("createHistoryArchiveCandidate requires an open SQLite connection");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("createHistoryArchiveCandidate options must be an object");
  }
  const { startMs, endMs, serviceTierEvidence = null } = options;
  assertArchiveRange(startMs, endMs);
  assertArchiveRegistryEmpty(database);

  const workDirectory = await mkdtemp(path.join(tmpdir(), "codex-usage-archive-"));
  let working;
  try {
    const workFile = path.join(workDirectory, "candidate.sqlite");
    await backup(database, workFile);
    working = new DatabaseSync(workFile);
    working.exec("BEGIN IMMEDIATE");
    working.prepare("DELETE FROM events WHERE timestamp_ms < ? OR timestamp_ms >= ?").run(startMs, endMs);
    const events = eventEvidence(working, startMs, endMs);
    const sources = sourceEvidence(working, startMs, endMs);
    const perfSources = perfSourceInventory(working, startMs, endMs);
    const perfSamples = perfSampleEvidence(working, startMs, endMs);
    const perfIndex = perfIndexEvidence(working, startMs, endMs);
    const perfTiming = perfTimingEvidence(working, startMs, endMs);
    const codexRequests = codexRequestEvidence(working, startMs, endMs);
    const workbuddyObservations = workbuddyObservationEvidence(working, startMs, endMs);
    working
      .prepare(
        `INSERT INTO store_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(
        HISTORY_ARCHIVE_CANDIDATE_META_KEY,
        JSON.stringify({
          formatVersion: HISTORY_ARCHIVE_CANDIDATE_FORMAT_VERSION,
          startMs,
          endMs,
          state: "unregistered",
          events,
          sources,
        }),
      );
    working
      .prepare(
        `INSERT INTO store_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(HISTORY_ARCHIVE_PERF_SOURCES_META_KEY, JSON.stringify(perfSources));
    working
      .prepare(
        `INSERT INTO store_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(HISTORY_ARCHIVE_PERF_SAMPLES_META_KEY, JSON.stringify(perfSamples));
    working
      .prepare(
        `INSERT INTO store_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(HISTORY_ARCHIVE_PERF_INDEX_META_KEY, JSON.stringify(perfIndex));
    working
      .prepare(
        `INSERT INTO store_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(HISTORY_ARCHIVE_PERF_TIMING_META_KEY, JSON.stringify(perfTiming));
    working
      .prepare(
        `INSERT INTO store_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(HISTORY_ARCHIVE_CODEX_REQUESTS_META_KEY, JSON.stringify(codexRequests));
    working
      .prepare(
        `INSERT INTO store_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(HISTORY_ARCHIVE_WORKBUDDY_OBSERVATIONS_META_KEY, JSON.stringify(workbuddyObservations));
    working.exec("COMMIT");
    return await createHistoryBackup(working, destinationFile, { serviceTierEvidence });
  } finally {
    try {
      working?.close();
    } finally {
      await rm(workDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
}

/**
 * Verify a candidate package and independently validate its archive metadata.
 */
export async function verifyHistoryArchiveCandidate(databaseFile, manifestFile = undefined) {
  return verifyHistoryArchiveCandidateWithReader(databaseFile, manifestFile, null);
}

/** Verify and read a candidate within its one pinned SQLite transaction. */
export async function withVerifiedHistoryArchiveCandidate(databaseFile, manifestFile, reader) {
  if (typeof reader !== "function") {
    throw new TypeError("withVerifiedHistoryArchiveCandidate requires a synchronous reader function");
  }
  return verifyHistoryArchiveCandidateWithReader(databaseFile, manifestFile, reader);
}

async function verifyHistoryArchiveCandidateWithReader(databaseFile, manifestFile, reader) {
  return withVerifiedHistoryBackup(
    databaseFile,
    manifestFile,
    (database, verified, sharedEvents) => {
      const metadata = candidateMetadata(database);
      const read = () => {
        const verifiedCandidate = { ...verified, candidate: metadata };
        if (!reader) return verifiedCandidate;
        const result = reader(database, verifiedCandidate);
        if (
          result !== null &&
          (typeof result === "object" || typeof result === "function") &&
          typeof result.then === "function"
        ) {
          throw archiveError("HISTORY_ARCHIVE_CANDIDATE_READER_ASYNC", "archive candidate reader must be synchronous");
        }
        return result;
      };
      const reusable = database.prepare("PRAGMA journal_mode").get().journal_mode === "delete";
      const proof = createHash("sha256").update(JSON.stringify(verified.manifest)).digest("hex");
      // The backup reader freshly checked every byte under this same SQLite read lock; WAL cannot reuse proofs.
      if (reusable && verifiedCandidateEvidence.has(proof)) return read();
      const outside = Number(
        database
          .prepare("SELECT COUNT(*) AS count FROM events WHERE timestamp_ms < ? OR timestamp_ms >= ?")
          .get(metadata.startMs, metadata.endMs).count,
      );
      if (outside !== 0) {
        throw archiveError(
          "HISTORY_ARCHIVE_CANDIDATE_RANGE_MISMATCH",
          `${outside} event(s) fall outside the candidate range`,
        );
      }
      const actual = sharedEvents ?? eventEvidence(database, metadata.startMs, metadata.endMs);
      if (actual.rows !== metadata.events.rows || actual.sha256 !== metadata.events.sha256) {
        throw archiveError(
          "HISTORY_ARCHIVE_CANDIDATE_FINGERPRINT_MISMATCH",
          "candidate event fingerprint does not match metadata",
        );
      }
      const actualSources = sourceEvidence(database, metadata.startMs, metadata.endMs);
      if (actualSources.rows !== metadata.sources.rows || actualSources.sha256 !== metadata.sources.sha256) {
        throw archiveError(
          "HISTORY_ARCHIVE_CANDIDATE_SOURCE_MISMATCH",
          "candidate source identity fingerprint does not match metadata",
        );
      }
      const perfSourcesRow = database
        .prepare("SELECT value FROM store_meta WHERE key = ?")
        .get(HISTORY_ARCHIVE_PERF_SOURCES_META_KEY);
      if (perfSourcesRow) {
        let perfSources;
        try {
          perfSources = JSON.parse(String(perfSourcesRow.value));
        } catch {
          throw archiveError(
            "HISTORY_ARCHIVE_CANDIDATE_PERF_SOURCES_BAD_METADATA",
            "perf source inventory is not valid JSON",
          );
        }
        const actualPerfSources = normalizePerfSourceInventory(perfSources);
        const expectedPerfSources = perfSourceInventory(database, metadata.startMs, metadata.endMs);
        if (JSON.stringify(actualPerfSources) !== JSON.stringify(expectedPerfSources)) {
          throw archiveError(
            "HISTORY_ARCHIVE_CANDIDATE_PERF_SOURCES_MISMATCH",
            "perf source inventory does not match candidate perf samples",
          );
        }
      }
      const perfSamplesRow = database
        .prepare("SELECT value FROM store_meta WHERE key = ?")
        .get(HISTORY_ARCHIVE_PERF_SAMPLES_META_KEY);
      if (perfSamplesRow) {
        let perfSamples;
        try {
          perfSamples = JSON.parse(String(perfSamplesRow.value));
        } catch {
          throw archiveError(
            "HISTORY_ARCHIVE_CANDIDATE_PERF_SAMPLES_BAD_METADATA",
            "perf sample evidence is not valid JSON",
          );
        }
        const actualPerfSamples = normalizePerfSampleEvidence(perfSamples, metadata.startMs, metadata.endMs);
        const expectedPerfSamples = perfSampleEvidence(database, metadata.startMs, metadata.endMs);
        if (
          actualPerfSamples.rows !== expectedPerfSamples.rows ||
          actualPerfSamples.sha256 !== expectedPerfSamples.sha256
        ) {
          throw archiveError(
            "HISTORY_ARCHIVE_CANDIDATE_PERF_SAMPLES_MISMATCH",
            "perf sample evidence does not match candidate perf samples",
          );
        }
      }
      const perfIndexRow = database
        .prepare("SELECT value FROM store_meta WHERE key = ?")
        .get(HISTORY_ARCHIVE_PERF_INDEX_META_KEY);
      if (perfIndexRow) {
        let perfIndex;
        try {
          perfIndex = JSON.parse(String(perfIndexRow.value));
        } catch {
          throw archiveError(
            "HISTORY_ARCHIVE_CANDIDATE_PERF_DEPENDENCIES_BAD_METADATA",
            "perf index evidence is not valid JSON",
          );
        }
        const actualPerfIndex = normalizePerfIndexEvidence(perfIndex, metadata.startMs, metadata.endMs);
        const expectedPerfIndex = perfIndexEvidence(database, metadata.startMs, metadata.endMs);
        if (JSON.stringify(actualPerfIndex.tables) !== JSON.stringify(expectedPerfIndex.tables)) {
          throw archiveError(
            "HISTORY_ARCHIVE_CANDIDATE_PERF_DEPENDENCIES_MISMATCH",
            "perf index evidence does not match candidate dependency relations",
          );
        }
      }
      const perfTimingRow = database
        .prepare("SELECT value FROM store_meta WHERE key = ?")
        .get(HISTORY_ARCHIVE_PERF_TIMING_META_KEY);
      if (perfTimingRow) {
        let perfTiming;
        try {
          perfTiming = JSON.parse(String(perfTimingRow.value));
        } catch {
          throw archiveError(
            "HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_BAD_METADATA",
            "perf timing evidence is not valid JSON",
          );
        }
        const actualPerfTiming = normalizePerfTimingEvidence(perfTiming, metadata.startMs, metadata.endMs);
        const expectedPerfTiming = perfTimingEvidence(database, metadata.startMs, metadata.endMs);
        if (JSON.stringify(actualPerfTiming.tables) !== JSON.stringify(expectedPerfTiming.tables)) {
          throw archiveError(
            "HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_MISMATCH",
            "perf timing evidence does not match candidate request timing graph",
          );
        }
      }
      const codexRequestsRow = database
        .prepare("SELECT value FROM store_meta WHERE key = ?")
        .get(HISTORY_ARCHIVE_CODEX_REQUESTS_META_KEY);
      if (codexRequestsRow) {
        let codexRequests;
        try {
          codexRequests = JSON.parse(String(codexRequestsRow.value));
        } catch {
          throw archiveError(
            "HISTORY_ARCHIVE_CANDIDATE_CODEX_REQUESTS_BAD_METADATA",
            "Codex request facts are not valid JSON",
          );
        }
        validateCodexRequestEvidence(database, codexRequests, metadata.startMs, metadata.endMs);
      }
      const workbuddyObservationsRow = database
        .prepare("SELECT value FROM store_meta WHERE key = ?")
        .get(HISTORY_ARCHIVE_WORKBUDDY_OBSERVATIONS_META_KEY);
      if (workbuddyObservationsRow) {
        let workbuddyObservations;
        try {
          workbuddyObservations = JSON.parse(String(workbuddyObservationsRow.value));
        } catch {
          throw archiveError(
            "HISTORY_ARCHIVE_CANDIDATE_WORKBUDDY_BAD_METADATA",
            "WorkBuddy observation evidence is not valid JSON",
          );
        }
        const actualWorkbuddyObservations = normalizeWorkbuddyObservationEvidence(
          workbuddyObservations,
          metadata.startMs,
          metadata.endMs,
        );
        const expectedWorkbuddyObservations = workbuddyObservationEvidence(database, metadata.startMs, metadata.endMs);
        if (
          JSON.stringify(actualWorkbuddyObservations.tables) !== JSON.stringify(expectedWorkbuddyObservations.tables)
        ) {
          throw archiveError(
            "HISTORY_ARCHIVE_CANDIDATE_WORKBUDDY_MISMATCH",
            "WorkBuddy observation evidence does not match candidate native observations",
          );
        }
      }
      if (reusable) {
        if (verifiedCandidateEvidence.size >= 8) {
          verifiedCandidateEvidence.delete(verifiedCandidateEvidence.values().next().value);
        }
        verifiedCandidateEvidence.add(proof);
      }
      return read();
    },
    (database) => {
      const { startMs, endMs } = candidateMetadata(database);
      return `${JSON.stringify({ startMs, endMs })}\n`;
    },
  );
}

/**
 * Recheck one prepared archive commit while the caller holds BEGIN IMMEDIATE.
 * This compares the fresh preparation with the supplied plan; it does not
 * verify candidate files or gate on the prepare-time connection counters.
 */
export function assertHistoryArchiveCommitPlan(prepared, plan) {
  if (
    !prepared ||
    typeof prepared !== "object" ||
    Array.isArray(prepared) ||
    !plan ||
    typeof plan !== "object" ||
    Array.isArray(plan) ||
    plan.formatVersion !== 1 ||
    plan.scope !== "events" ||
    !plan.candidate ||
    !plan.source ||
    !plan.deletion
  ) {
    throw archiveError("HISTORY_ARCHIVE_COMMIT_PLAN_INVALID", "archive commit plan is malformed");
  }
  if (Object.hasOwn(plan, "perfDeletion")) {
    const perfDeletion = plan.perfDeletion;
    if (
      !perfDeletion ||
      typeof perfDeletion !== "object" ||
      Array.isArray(perfDeletion) ||
      Object.keys(perfDeletion).sort().join(",") !== "methodVersion,sampleKeys,sha256,sourceKind,table" ||
      perfDeletion.table !== "perf_samples" ||
      !["zcode", "codex", "workbuddy"].includes(perfDeletion.sourceKind) ||
      (perfDeletion.sourceKind === "workbuddy" && !isGenerationPerfMethod(perfDeletion.methodVersion)) ||
      !HISTORY_ARCHIVE_SUPPORTED_PERF_METHOD_VERSIONS.includes(perfDeletion.methodVersion) ||
      !/^[a-f0-9]{64}$/.test(perfDeletion.sha256) ||
      !Array.isArray(perfDeletion.sampleKeys) ||
      perfDeletion.sampleKeys.length === 0 ||
      perfDeletion.sampleKeys.some((sampleKey) => typeof sampleKey !== "string") ||
      new Set(perfDeletion.sampleKeys).size !== perfDeletion.sampleKeys.length
    ) {
      throw archiveError("HISTORY_ARCHIVE_COMMIT_PLAN_INVALID", "archive commit perf deletion is malformed");
    }
  }
  if (prepared.source?.databaseFile !== plan.source.databaseFile) {
    throw archiveError(
      "HISTORY_ARCHIVE_COMMIT_SOURCE_MISMATCH",
      "archive commit plan was prepared for a different source database",
    );
  }
  if (
    JSON.stringify(prepared.candidate) !== JSON.stringify(plan.candidate) ||
    JSON.stringify(prepared.deletion) !== JSON.stringify(plan.deletion) ||
    JSON.stringify(prepared.perfDeletion ?? null) !== JSON.stringify(plan.perfDeletion ?? null)
  ) {
    throw archiveError(
      "HISTORY_ARCHIVE_COMMIT_CANDIDATE_MISMATCH",
      "archive candidate or deletion set no longer matches the prepared plan",
    );
  }
  if (
    JSON.stringify(prepared.source.events) !== JSON.stringify(plan.source.events) ||
    JSON.stringify(prepared.source.sources) !== JSON.stringify(plan.source.sources)
  ) {
    throw archiveError(
      "HISTORY_ARCHIVE_COMMIT_SOURCE_CHANGED",
      "source event or identity evidence changed after archive commit preparation",
    );
  }
  return prepared;
}

function historyArchiveReplayCandidate(database, verified) {
  const metadata = verified.candidate;
  const segmentId = verified.manifest.database.sha256;
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'archive_segments'").get()) {
    return false;
  }
  const registered = database
    .prepare(
      `SELECT database_path, database_sha256, start_ms, end_ms, event_count
       FROM archive_segments WHERE segment_id = ?`,
    )
    .get(segmentId);
  if (!registered) return false;
  if (
    String(registered.database_path) !== path.resolve(verified.databaseFile) ||
    String(registered.database_sha256) !== segmentId ||
    Number(registered.start_ms) !== metadata.startMs ||
    Number(registered.end_ms) !== metadata.endMs ||
    Number(registered.event_count) !== metadata.events.rows
  ) {
    throw archiveError(
      "HISTORY_ARCHIVE_COMMIT_CANDIDATE_MISMATCH",
      "registered archive segment does not match the verified candidate",
    );
  }
  const authorityValue = database
    .prepare("SELECT value FROM store_meta WHERE key = ?")
    .get("history_archive_event_authority")?.value;
  if (authorityValue === undefined) return false;
  let authority;
  try {
    authority = JSON.parse(String(authorityValue));
  } catch {
    throw archiveError("HISTORY_ARCHIVE_AUTHORITY_INVALID", "history archive event authority is not valid JSON");
  }
  if (
    !authority ||
    typeof authority !== "object" ||
    Array.isArray(authority) ||
    authority.formatVersion !== 1 ||
    !Array.isArray(authority.segmentIds)
  ) {
    throw archiveError(
      "HISTORY_ARCHIVE_AUTHORITY_INVALID",
      "history archive event authority is not a version-1 segment id list",
    );
  }
  if (!authority.segmentIds.includes(segmentId)) return false;
  return (
    Number(
      database
        .prepare("SELECT COUNT(*) AS count FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ?")
        .get(metadata.startMs, metadata.endMs).count,
    ) === 0
  );
}

function assertHistoryArchiveReplayPerfDeletion(database, segmentId, perfDeletion) {
  const row = database.prepare("SELECT value FROM store_meta WHERE key = ?").get("history_archive_perf_authority");
  if (!row) {
    throw archiveError(
      "HISTORY_ARCHIVE_PERF_AUTHORITY_MISMATCH",
      `archive segment ${segmentId} is missing its perf authority`,
    );
  }
  let authority;
  try {
    authority = JSON.parse(String(row.value));
  } catch {
    throw archiveError("HISTORY_ARCHIVE_PERF_AUTHORITY_INVALID", "history archive perf authority is not valid JSON");
  }
  const segment = authority?.segments?.find?.((entry) => entry?.segmentId === segmentId);
  if (
    !segment ||
    segment.databaseSha256 !== segmentId ||
    JSON.stringify(segment.sourceKinds) !== JSON.stringify([perfDeletion.sourceKind]) ||
    JSON.stringify(segment.methodVersions) !== JSON.stringify([perfDeletion.methodVersion])
  ) {
    throw archiveError(
      "HISTORY_ARCHIVE_PERF_AUTHORITY_MISMATCH",
      `archive segment ${segmentId} does not have matching ${perfDeletion.sourceKind} perf authority`,
    );
  }
  const remaining = Number(
    database
      .prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE ts_ms >= ? AND ts_ms < ?")
      .get(perfDeletion.startMs, perfDeletion.endMs).count,
  );
  if (remaining !== 0) {
    throw archiveError(
      "HISTORY_ARCHIVE_COMMIT_SOURCE_CHANGED",
      `archive replay left ${remaining} hot perf sample(s) in the sealed range`,
    );
  }
  return perfDeletion;
}

/**
 * Capture the read-only source facts needed by a later single-candidate commit.
 */
export async function prepareHistoryArchiveCommit(database, candidateFile) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("prepareHistoryArchiveCommit requires an open SQLite connection");
  }
  const verified = await verifyHistoryArchiveCandidate(candidateFile);
  const metadata = verified.candidate;
  const inputRevision = () => ({
    dataVersion: Number(database.prepare("PRAGMA data_version").get().data_version),
    totalChanges: Number(database.prepare("SELECT total_changes() AS value").get().value),
  });
  const before = inputRevision();
  let began = false;
  try {
    database.exec("SAVEPOINT history_archive_commit_prepare");
    began = true;
    const sourceDatabaseFile = canonicalPersistentDatabaseFile(database);
    const replay = historyArchiveReplayCandidate(database, verified);
    if (!replay) assertHistoryArchiveSourceMatches(database, verified);
    const candidateDatabase = new DatabaseSync(verified.databaseFile, { readOnly: true });
    let candidatePerfDeletion;
    let candidateCodexRequests;
    try {
      candidateDatabase.exec("BEGIN");
      candidatePerfDeletion = historyArchivePerfDeletion(candidateDatabase, metadata.startMs, metadata.endMs, {
        requireComponents: true,
      });
      if (candidatePerfDeletion?.sourceKind === "codex") {
        candidateCodexRequests = codexRequestEvidence(candidateDatabase, metadata.startMs, metadata.endMs);
      }
    } finally {
      try {
        candidateDatabase.exec("ROLLBACK");
      } finally {
        candidateDatabase.close();
      }
    }
    const sourcePerfDeletion = historyArchivePerfDeletion(database, metadata.startMs, metadata.endMs);
    if (replay) {
      if (candidatePerfDeletion) {
        assertHistoryArchiveReplayPerfDeletion(database, verified.manifest.database.sha256, {
          ...candidatePerfDeletion,
          startMs: metadata.startMs,
          endMs: metadata.endMs,
        });
      }
    } else {
      if (candidatePerfDeletion && JSON.stringify(sourcePerfDeletion) !== JSON.stringify(candidatePerfDeletion)) {
        throw archiveError(
          "HISTORY_ARCHIVE_COMMIT_CANDIDATE_MISMATCH",
          "source perf samples do not match the verified archive candidate",
        );
      }
      if (
        candidatePerfDeletion?.sourceKind === "codex" &&
        JSON.stringify(codexRequestEvidence(database, metadata.startMs, metadata.endMs)) !==
          JSON.stringify(candidateCodexRequests)
      ) {
        throw archiveError(
          "HISTORY_ARCHIVE_COMMIT_CANDIDATE_MISMATCH",
          "source Codex perf graph or timing evidence does not match the verified archive candidate",
        );
      }
    }
    const events = eventEvidence(database, metadata.startMs, metadata.endMs, true);
    const ids = replay
      ? []
      : database
          .prepare("SELECT id FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ? ORDER BY id")
          .all(metadata.startMs, metadata.endMs)
          .map((row) => Number(row.id));
    const sources = replay ? [] : sourceIdentityRows(database, metadata.startMs, metadata.endMs);
    if (JSON.stringify(inputRevision()) !== JSON.stringify(before)) {
      throw archiveError(
        "HISTORY_ARCHIVE_COMMIT_INPUT_CHANGED",
        "source connection changed while preparing the archive commit",
      );
    }
    return {
      formatVersion: 1,
      scope: "events",
      candidate: {
        databaseFile: verified.databaseFile,
        manifestFile: verified.manifestFile,
        databaseSha256: verified.manifest.database.sha256,
        startMs: metadata.startMs,
        endMs: metadata.endMs,
        events: metadata.events,
        sources: metadata.sources,
      },
      source: {
        databaseFile: sourceDatabaseFile,
        events,
        sources,
        inputRevision: before,
      },
      deletion: { table: "events", ids },
      ...(candidatePerfDeletion ? { perfDeletion: candidatePerfDeletion } : {}),
    };
  } finally {
    if (began) {
      try {
        database.exec("ROLLBACK TO history_archive_commit_prepare");
      } finally {
        database.exec("RELEASE history_archive_commit_prepare");
      }
    }
  }
}

/**
 * Verify every registered archive segment without copying or activating it.
 */
export async function inventoryHistoryArchiveSegments(database) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("inventoryHistoryArchiveSegments requires an open SQLite connection");
  }
  const table = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'archive_segments'")
    .get();
  if (!table) {
    throw archiveError("HISTORY_ARCHIVE_SEGMENT_INVENTORY_UNAVAILABLE", "archive_segments table is missing");
  }
  const records = database
    .prepare(
      `SELECT segment_id, database_path, database_sha256, start_ms, end_ms, event_count
       FROM archive_segments ORDER BY segment_id`,
    )
    .all();
  const segments = [];
  for (const record of records) {
    const segmentId = String(record.segment_id);
    const databaseFile = path.resolve(String(record.database_path));
    const parsed = path.parse(databaseFile);
    const manifestFile = path.join(parsed.dir, `${parsed.name}.manifest.json`);
    if (!existsSync(databaseFile) || !existsSync(manifestFile)) {
      throw archiveError(
        "HISTORY_ARCHIVE_SEGMENT_NOT_FOUND",
        `archive segment ${segmentId} is missing its database or manifest`,
      );
    }
    const verified = await verifyHistoryArchiveCandidate(databaseFile, manifestFile);
    const databaseSha256 = String(record.database_sha256);
    const startMs = Number(record.start_ms);
    const endMs = Number(record.end_ms);
    const eventCount = Number(record.event_count);
    if (
      segmentId !== databaseSha256 ||
      verified.manifest.database.sha256 !== databaseSha256 ||
      verified.candidate.startMs !== startMs ||
      verified.candidate.endMs !== endMs ||
      verified.candidate.events.rows !== eventCount
    ) {
      throw archiveError(
        "HISTORY_ARCHIVE_SEGMENT_MISMATCH",
        `archive segment ${segmentId} does not match its registered metadata`,
      );
    }
    segments.push({
      segmentId,
      databaseFile: verified.databaseFile,
      manifestFile: verified.manifestFile,
      databaseSha256,
      startMs,
      endMs,
      eventCount,
    });
  }
  return { segments };
}

/**
 * Copy verified registered segments into a new portable staging directory.
 */
export async function stageHistoryArchiveSegments(database, stagingDirectory) {
  if (typeof stagingDirectory !== "string" || stagingDirectory.trim() === "") {
    throw new TypeError("stagingDirectory must be a non-empty path");
  }
  const destination = path.resolve(stagingDirectory);
  let created = false;
  try {
    try {
      await mkdir(destination);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw archiveError(
          "HISTORY_ARCHIVE_STAGING_DESTINATION_EXISTS",
          `staging directory already exists: ${destination}`,
        );
      }
      throw error;
    }
    created = true;
    const inventory = await inventoryHistoryArchiveSegments(database);
    const segments = [];
    for (const segment of inventory.segments) {
      const databaseName = `${segment.segmentId}.sqlite`;
      const manifestName = `${segment.segmentId}.manifest.json`;
      const stagedDatabase = path.join(destination, "segments", databaseName);
      const restored = await restoreHistoryBackup(segment.databaseFile, stagedDatabase, segment.manifestFile);
      const verified = await verifyHistoryArchiveCandidate(stagedDatabase, restored.manifestFile);
      if (
        verified.manifest.database.sha256 !== segment.databaseSha256 ||
        verified.candidate.startMs !== segment.startMs ||
        verified.candidate.endMs !== segment.endMs ||
        verified.candidate.events.rows !== segment.eventCount
      ) {
        throw archiveError(
          "HISTORY_ARCHIVE_STAGING_MISMATCH",
          `staged archive segment ${segment.segmentId} does not match its inventory entry`,
        );
      }
      segments.push({
        segmentId: segment.segmentId,
        databaseFile: `segments/${databaseName}`,
        manifestFile: `segments/${manifestName}`,
        databaseSha256: segment.databaseSha256,
        startMs: segment.startMs,
        endMs: segment.endMs,
        eventCount: segment.eventCount,
      });
    }
    return { segments };
  } catch (error) {
    if (created) {
      await rm(destination, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
    throw error;
  }
}

/**
 * Stage a complete bundle from one private snapshot of the online source.
 * @param {{serviceTierEvidence?: ReturnType<typeof import("./service-tier-evidence.js").serviceTierEvidenceFromSnapshot> | null}} [options]
 */
export async function stageHistoryArchiveBundle(database, stagingDirectory, options = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("stageHistoryArchiveBundle requires an open SQLite connection");
  }
  if (typeof stagingDirectory !== "string" || stagingDirectory.trim() === "") {
    throw new TypeError("stagingDirectory must be a non-empty path");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("stageHistoryArchiveBundle options must be an object");
  }
  const { serviceTierEvidence = null } = options;
  const pricingCatalog = getPricingCatalog();
  const serviceTierSnapshot = serviceTierEvidence === null ? null : serviceTierEvidenceSnapshot(serviceTierEvidence);
  const destination = path.resolve(stagingDirectory);
  const workDirectory = await mkdtemp(path.join(tmpdir(), "codex-usage-archive-"));
  let working;
  let staged = false;
  try {
    const workFile = path.join(workDirectory, "bundle-source.sqlite");
    await backup(database, workFile);
    working = new DatabaseSync(workFile);
    const stagedSegments = await stageHistoryArchiveSegments(working, destination);
    staged = true;
    const registry = working
      .prepare(
        `SELECT segment_id, database_sha256, start_ms, end_ms, event_count, registered_at_ms
         FROM archive_segments ORDER BY segment_id`,
      )
      .all()
      .map((record) => ({
        segmentId: String(record.segment_id),
        databaseSha256: String(record.database_sha256),
        startMs: Number(record.start_ms),
        endMs: Number(record.end_ms),
        eventCount: Number(record.event_count),
        registeredAtMs: Number(record.registered_at_ms),
      }));
    const registeredById = new Map(registry.map((record) => [record.segmentId, record]));
    const segments = stagedSegments.segments.map((segment) => {
      const registered = registeredById.get(segment.segmentId);
      if (
        !registered ||
        registered.databaseSha256 !== segment.databaseSha256 ||
        registered.startMs !== segment.startMs ||
        registered.endMs !== segment.endMs ||
        registered.eventCount !== segment.eventCount
      ) {
        throw archiveError(
          "HISTORY_ARCHIVE_STAGING_MISMATCH",
          `staged archive segment ${segment.segmentId} does not match its registry entry`,
        );
      }
      return { ...segment, registeredAtMs: registered.registeredAtMs };
    });

    working
      .prepare(
        `INSERT INTO store_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(
        HISTORY_ARCHIVE_BUNDLE_ANCHOR_META_KEY,
        JSON.stringify({
          formatVersion: HISTORY_ARCHIVE_BUNDLE_ANCHOR_FORMAT_VERSION,
          segments,
        }),
      );
    working.exec("DELETE FROM archive_segments");
    await createHistoryBackup(working, path.join(destination, "main.sqlite"), {
      pricingCatalog,
      serviceTierEvidence: serviceTierSnapshot === null ? null : serviceTierEvidenceFromSnapshot(serviceTierSnapshot),
    });
    const manifest = {
      formatVersion: HISTORY_ARCHIVE_BUNDLE_FORMAT_VERSION,
      main: {
        databaseFile: "main.sqlite",
        manifestFile: "main.manifest.json",
      },
      segments,
    };
    await writeFile(path.join(destination, "bundle.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  } catch (error) {
    if (staged) {
      await rm(destination, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
    throw error;
  } finally {
    try {
      working?.close();
    } finally {
      await rm(workDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
}

/**
 * Verify a staged bundle without publishing, importing, or modifying it.
 */
export async function verifyHistoryArchiveBundle(directory) {
  const { requestedDirectory, realDirectory } = await resolveBundleDirectory(directory);

  const manifestFile = await resolveBundleFile(
    requestedDirectory,
    realDirectory,
    HISTORY_ARCHIVE_BUNDLE_MANIFEST_FILE,
    "bundle manifest",
  );
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  } catch (error) {
    throw bundleError("BAD_MANIFEST", `cannot read bundle manifest: ${error?.message ?? String(error)}`);
  }
  validateBundleManifest(manifest);

  assertBundleRelativePath(manifest.main.databaseFile, "bundle main databaseFile");
  assertBundleRelativePath(manifest.main.manifestFile, "bundle main manifestFile");
  const mainDatabaseFile = await resolveBundleFile(
    requestedDirectory,
    realDirectory,
    manifest.main.databaseFile,
    "bundle main databaseFile",
  );
  const mainManifestFile = await resolveBundleFile(
    requestedDirectory,
    realDirectory,
    manifest.main.manifestFile,
    "bundle main manifestFile",
  );
  const segmentFiles = [];
  for (const segment of manifest.segments) {
    segmentFiles.push({
      databaseFile: await resolveBundleFile(
        requestedDirectory,
        realDirectory,
        segment.databaseFile,
        `bundle segment ${segment.segmentId} databaseFile`,
      ),
      manifestFile: await resolveBundleFile(
        requestedDirectory,
        realDirectory,
        segment.manifestFile,
        `bundle segment ${segment.segmentId} manifestFile`,
      ),
    });
  }

  await verifyHistoryBackup(mainDatabaseFile, mainManifestFile);
  const mainDatabase = new DatabaseSync(mainDatabaseFile, { readOnly: true });
  try {
    const registry = mainDatabase
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'archive_segments'")
      .get();
    if (!registry) {
      throw bundleError("MISMATCH", "bundle main database has no archive_segments registry");
    }
    const archived = Number(mainDatabase.prepare("SELECT COUNT(*) AS count FROM archive_segments").get().count);
    if (archived !== 0) {
      throw bundleError("MISMATCH", `bundle main archive_segments contains ${archived} row(s)`);
    }
    const anchored = bundleAnchor(mainDatabase);
    if (JSON.stringify(anchored) !== JSON.stringify(normalizeBundleSegments(manifest.segments))) {
      throw bundleError("MISMATCH", "bundle manifest segments do not match the main database anchor");
    }
  } finally {
    mainDatabase.close();
  }

  for (const [index, segment] of manifest.segments.entries()) {
    const verified = await verifyHistoryArchiveCandidate(
      segmentFiles[index].databaseFile,
      segmentFiles[index].manifestFile,
    );
    if (
      segment.segmentId !== segment.databaseSha256 ||
      verified.manifest.database.sha256 !== segment.databaseSha256 ||
      verified.candidate.startMs !== segment.startMs ||
      verified.candidate.endMs !== segment.endMs ||
      verified.candidate.events.rows !== segment.eventCount
    ) {
      throw bundleError("MISMATCH", `archive segment ${segment.segmentId} does not match its bundle manifest`);
    }
  }

  return {
    ok: true,
    directory: realDirectory,
    manifestFile,
    manifest,
  };
}

/**
 * Publish a verified bundle by adding the completion marker last.
 * The marker is the import commit gate; this does not claim atomic directory rename.
 */
export async function publishHistoryArchiveBundle(database, destinationDirectory, options = {}) {
  if (typeof destinationDirectory !== "string" || destinationDirectory.trim() === "") {
    throw new TypeError("destinationDirectory must be a non-empty path");
  }
  const destination = path.resolve(destinationDirectory);
  let created = false;
  try {
    const manifest = await stageHistoryArchiveBundle(database, destination, options);
    created = true;
    await verifyHistoryArchiveBundle(destination);
    const manifestFile = path.join(destination, HISTORY_ARCHIVE_BUNDLE_MANIFEST_FILE);
    const markerFile = path.join(destination, HISTORY_ARCHIVE_BUNDLE_COMPLETE_FILE);
    const marker = {
      formatVersion: HISTORY_ARCHIVE_BUNDLE_COMPLETE_FORMAT_VERSION,
      bundleFormatVersion: manifest.formatVersion,
      bundleManifestSha256: createHash("sha256")
        .update(await readFile(manifestFile))
        .digest("hex"),
      completedAt: new Date().toISOString(),
    };
    await writeFile(markerFile, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return { directory: destination, manifestFile, markerFile, marker, manifest };
  } catch (error) {
    if (created) {
      await rm(destination, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
    throw error;
  }
}

/**
 * Verify a published bundle, including its completion marker, for later import.
 */
export async function verifyPublishedHistoryArchiveBundle(directory) {
  const { requestedDirectory, realDirectory } = await resolveBundleDirectory(directory);
  const markerFile = await resolveBundleFile(
    requestedDirectory,
    realDirectory,
    HISTORY_ARCHIVE_BUNDLE_COMPLETE_FILE,
    "bundle completion marker",
  );
  const manifestFile = await resolveBundleFile(
    requestedDirectory,
    realDirectory,
    HISTORY_ARCHIVE_BUNDLE_MANIFEST_FILE,
    "bundle manifest",
  );
  let marker;
  try {
    marker = JSON.parse(await readFile(markerFile, "utf8"));
  } catch (error) {
    throw bundleError("BAD_MARKER", `cannot read bundle completion marker: ${error?.message ?? String(error)}`);
  }
  validateBundleMarker(marker);
  const manifestSha256 = createHash("sha256")
    .update(await readFile(manifestFile))
    .digest("hex");
  if (marker.bundleManifestSha256 !== manifestSha256) {
    throw bundleError("MARKER_MISMATCH", "bundle completion marker does not match the bundle manifest");
  }

  const verified = await verifyHistoryArchiveBundle(realDirectory);
  if (verified.manifestFile !== manifestFile) {
    throw bundleError("MARKER_MISMATCH", "bundle manifest changed during verification");
  }
  const verifiedManifestSha256 = createHash("sha256")
    .update(await readFile(verified.manifestFile))
    .digest("hex");
  if (marker.bundleManifestSha256 !== verifiedManifestSha256) {
    throw bundleError("MARKER_MISMATCH", "bundle completion marker no longer matches the bundle manifest");
  }
  return { ...verified, markerFile, marker };
}

/**
 * Copy one published bundle into a new directory without importing or modifying it.
 */
export async function stagePublishedHistoryArchiveBundle(sourceDirectory, destinationDirectory) {
  if (typeof destinationDirectory !== "string" || destinationDirectory.trim() === "") {
    throw new TypeError("destinationDirectory must be a non-empty path");
  }
  const verifiedSource = await verifyPublishedHistoryArchiveBundle(sourceDirectory);
  const sourceRoot = verifiedSource.directory;
  const destination = path.resolve(destinationDirectory);
  let created = false;
  try {
    try {
      await mkdir(destination);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw archiveError(
          "HISTORY_ARCHIVE_STAGING_DESTINATION_EXISTS",
          `staging directory already exists: ${destination}`,
        );
      }
      throw error;
    }
    created = true;

    const files = [
      {
        relativePath: verifiedSource.manifest.main.databaseFile,
        label: "bundle main databaseFile",
      },
      {
        relativePath: verifiedSource.manifest.main.manifestFile,
        label: "bundle main manifestFile",
      },
      ...verifiedSource.manifest.segments.flatMap((segment) => [
        {
          relativePath: segment.databaseFile,
          label: `bundle segment ${segment.segmentId} databaseFile`,
        },
        {
          relativePath: segment.manifestFile,
          label: `bundle segment ${segment.segmentId} manifestFile`,
        },
      ]),
      {
        relativePath: HISTORY_ARCHIVE_BUNDLE_MANIFEST_FILE,
        label: "bundle manifest",
      },
    ];
    for (const file of files) {
      const sourceFile = await resolveBundleFile(sourceRoot, sourceRoot, file.relativePath, file.label);
      const destinationFile = resolveBundlePath(destination, file.relativePath, file.label);
      await mkdir(path.dirname(destinationFile), { recursive: true });
      await copyFile(sourceFile, destinationFile, fsConstants.COPYFILE_EXCL);
    }

    await verifyHistoryArchiveBundle(destination);
    const sourceMarker = await resolveBundleFile(
      sourceRoot,
      sourceRoot,
      HISTORY_ARCHIVE_BUNDLE_COMPLETE_FILE,
      "bundle completion marker",
    );
    const destinationMarker = resolveBundlePath(
      destination,
      HISTORY_ARCHIVE_BUNDLE_COMPLETE_FILE,
      "bundle completion marker",
    );
    await copyFile(sourceMarker, destinationMarker, fsConstants.COPYFILE_EXCL);
    return await verifyPublishedHistoryArchiveBundle(destination);
  } catch (error) {
    if (created) {
      await rm(destination, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
    throw error;
  }
}

function verifyMaterializedHistoryArchiveRuntime(databaseFile, bundleDirectory, segments, authorityValue) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const quickCheck = database.prepare("PRAGMA quick_check").all();
    if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok") {
      throw archiveError("HISTORY_ARCHIVE_IMPORT_RUNTIME_INVALID", "runtime SQLite quick_check failed");
    }
    const records = database
      .prepare(
        `SELECT segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms
         FROM archive_segments ORDER BY segment_id`,
      )
      .all();
    if (records.length !== segments.length) {
      throw archiveError("HISTORY_ARCHIVE_IMPORT_RUNTIME_MISMATCH", "runtime registry count does not match bundle");
    }
    const recordsById = new Map(records.map((record) => [String(record.segment_id), record]));
    for (const segment of segments) {
      const record = recordsById.get(segment.segmentId);
      if (
        !record ||
        !bundleContains(bundleDirectory, String(record.database_path)) ||
        String(record.database_path) !== segment.databasePath ||
        String(record.database_sha256) !== segment.databaseSha256 ||
        Number(record.start_ms) !== segment.startMs ||
        Number(record.end_ms) !== segment.endMs ||
        Number(record.event_count) !== segment.eventCount ||
        Number(record.registered_at_ms) !== segment.registeredAtMs
      ) {
        throw archiveError(
          "HISTORY_ARCHIVE_IMPORT_RUNTIME_MISMATCH",
          `runtime registry does not match bundle segment ${segment.segmentId}`,
        );
      }
    }
    const authority = database
      .prepare("SELECT value FROM store_meta WHERE key = ?")
      .get("history_archive_event_authority")?.value;
    if (authority !== authorityValue) {
      throw archiveError(
        "HISTORY_ARCHIVE_IMPORT_RUNTIME_MISMATCH",
        "runtime changed the existing archive event authority",
      );
    }
  } finally {
    database.close();
  }
}

async function runtimeSegmentsForBundle(bundleDirectory, verifiedBundle) {
  const segments = [];
  for (const segment of verifiedBundle.manifest.segments) {
    segments.push({
      ...segment,
      databasePath: await resolveBundleFile(
        bundleDirectory,
        verifiedBundle.directory,
        segment.databaseFile,
        `bundle segment ${segment.segmentId} databaseFile`,
      ),
    });
  }
  return segments;
}

/**
 * Materialize one published bundle into a new import directory with an
 * independent runtime database whose registry points at the frozen copy.
 */
export async function materializePublishedHistoryArchiveRuntime(sourceDirectory, importDirectory) {
  if (typeof importDirectory !== "string" || importDirectory.trim() === "") {
    throw new TypeError("importDirectory must be a non-empty path");
  }
  const destination = path.resolve(importDirectory);
  let created = false;
  let runtimeDatabase;
  try {
    try {
      await mkdir(destination);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw archiveError(
          "HISTORY_ARCHIVE_IMPORT_DESTINATION_EXISTS",
          `import directory already exists: ${destination}`,
        );
      }
      throw error;
    }
    created = true;

    const bundleDirectory = path.join(destination, "bundle");
    await stagePublishedHistoryArchiveBundle(sourceDirectory, bundleDirectory);
    const initialSource = await verifyPublishedHistoryArchiveBundle(sourceDirectory);
    const initialBundle = await verifyPublishedHistoryArchiveBundle(bundleDirectory);
    if (initialSource.marker.bundleManifestSha256 !== initialBundle.marker.bundleManifestSha256) {
      throw bundleError("MISMATCH", "source bundle changed while it was being materialized");
    }

    const segments = await runtimeSegmentsForBundle(bundleDirectory, initialBundle);

    const bundleMainFile = await resolveBundleFile(
      bundleDirectory,
      initialBundle.directory,
      initialBundle.manifest.main.databaseFile,
      "bundle main databaseFile",
    );
    const sourceDatabase = new DatabaseSync(bundleMainFile, { readOnly: true });
    const runtimeFile = path.join(destination, "runtime.sqlite");
    let authorityValue;
    try {
      authorityValue = sourceDatabase
        .prepare("SELECT value FROM store_meta WHERE key = ?")
        .get("history_archive_event_authority")?.value;
      await backup(sourceDatabase, runtimeFile);
    } finally {
      sourceDatabase.close();
    }

    runtimeDatabase = new DatabaseSync(runtimeFile);
    runtimeDatabase.exec("BEGIN IMMEDIATE");
    try {
      runtimeDatabase.exec("DELETE FROM archive_segments");
      const insert = runtimeDatabase.prepare(
        `INSERT INTO archive_segments (
           segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const segment of segments) {
        insert.run(
          segment.segmentId,
          segment.databasePath,
          segment.databaseSha256,
          segment.startMs,
          segment.endMs,
          segment.eventCount,
          segment.registeredAtMs,
        );
      }
      runtimeDatabase.exec("COMMIT");
    } catch (error) {
      try {
        runtimeDatabase.exec("ROLLBACK");
      } catch {
        // Preserve the original registry write failure.
      }
      throw error;
    } finally {
      runtimeDatabase.close();
      runtimeDatabase = undefined;
    }

    const finalSource = await verifyPublishedHistoryArchiveBundle(sourceDirectory);
    const finalBundle = await verifyPublishedHistoryArchiveBundle(bundleDirectory);
    if (
      finalSource.marker.bundleManifestSha256 !== initialBundle.marker.bundleManifestSha256 ||
      finalBundle.marker.bundleManifestSha256 !== initialBundle.marker.bundleManifestSha256
    ) {
      throw bundleError("MISMATCH", "source or frozen bundle changed during materialization");
    }
    verifyMaterializedHistoryArchiveRuntime(runtimeFile, finalBundle.directory, segments, authorityValue);

    const loadBundleContext = async () => {
      const verifiedBundle = await verifyPublishedHistoryArchiveBundle(bundleDirectory);
      if (verifiedBundle.marker.bundleManifestSha256 !== initialBundle.marker.bundleManifestSha256) {
        throw bundleError("MISMATCH", "frozen bundle changed after materialization");
      }
      return loadHistoryBackupContext(
        await resolveBundleFile(
          bundleDirectory,
          verifiedBundle.directory,
          verifiedBundle.manifest.main.databaseFile,
          "bundle main databaseFile",
        ),
        await resolveBundleFile(
          bundleDirectory,
          verifiedBundle.directory,
          verifiedBundle.manifest.main.manifestFile,
          "bundle main manifestFile",
        ),
      );
    };

    return { runtimeFile, bundleDirectory, loadBundleContext };
  } catch (error) {
    if (runtimeDatabase) {
      try {
        runtimeDatabase.close();
      } catch {
        // Cleanup must not hide the original failure.
      }
    }
    if (created) {
      await rm(destination, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
    throw error;
  }
}

/**
 * Finalize a new import after re-verifying its frozen bundle and closed runtime.
 * The marker is written last and is not a durability or runtime-digest claim.
 */
export async function publishHistoryArchiveImport(sourceDirectory, importDirectory) {
  if (typeof importDirectory !== "string" || importDirectory.trim() === "") {
    throw new TypeError("importDirectory must be a non-empty path");
  }
  const destination = path.resolve(importDirectory);
  let materialized;
  try {
    materialized = await materializePublishedHistoryArchiveRuntime(sourceDirectory, destination);
    const verifiedBundle = await verifyPublishedHistoryArchiveBundle(materialized.bundleDirectory);
    const bundleMainFile = await resolveBundleFile(
      materialized.bundleDirectory,
      verifiedBundle.directory,
      verifiedBundle.manifest.main.databaseFile,
      "bundle main databaseFile",
    );
    const runtimeSegments = await runtimeSegmentsForBundle(materialized.bundleDirectory, verifiedBundle);
    const bundleMain = new DatabaseSync(bundleMainFile, { readOnly: true });
    let authorityValue;
    try {
      authorityValue = bundleMain
        .prepare("SELECT value FROM store_meta WHERE key = ?")
        .get("history_archive_event_authority")?.value;
    } finally {
      bundleMain.close();
    }
    verifyMaterializedHistoryArchiveRuntime(
      materialized.runtimeFile,
      verifiedBundle.directory,
      runtimeSegments,
      authorityValue,
    );

    const runtimeFile = path.relative(destination, materialized.runtimeFile);
    if (!runtimeFile || runtimeFile.startsWith(`..${path.sep}`) || path.isAbsolute(runtimeFile)) {
      throw archiveError("HISTORY_ARCHIVE_IMPORT_RUNTIME_MISMATCH", "runtime file is outside the import directory");
    }
    const markerFile = path.join(destination, HISTORY_ARCHIVE_IMPORT_COMPLETE_FILE);
    const marker = {
      formatVersion: HISTORY_ARCHIVE_IMPORT_COMPLETE_FORMAT_VERSION,
      bundleManifestSha256: verifiedBundle.marker.bundleManifestSha256,
      runtimeFile,
      completedAt: new Date().toISOString(),
    };
    await writeFile(markerFile, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return { ...materialized, markerFile, marker };
  } catch (error) {
    if (materialized) {
      await rm(destination, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
    throw error;
  }
}

/**
 * Open a completed import read-only after verifying its marker, frozen bundle,
 * runtime registry, and immutable bundle context.
 */
export async function loadHistoryArchiveImport(directory) {
  const { requestedDirectory, realDirectory } = await resolveBundleDirectory(directory);
  const markerFile = await resolveBundleFile(
    requestedDirectory,
    realDirectory,
    HISTORY_ARCHIVE_IMPORT_COMPLETE_FILE,
    "import completion marker",
  );
  let marker;
  try {
    marker = JSON.parse(await readFile(markerFile, "utf8"));
  } catch (error) {
    throw importError("BAD_MARKER", `cannot read import completion marker: ${error?.message ?? String(error)}`);
  }
  validateImportMarker(marker);

  // Resolve the bundle root before verification so a junction cannot move it outside the import root.
  const bundleDirectory = await resolveBundleFile(
    requestedDirectory,
    realDirectory,
    "bundle",
    "import bundle directory",
  );
  const verifiedBundle = await verifyPublishedHistoryArchiveBundle(bundleDirectory);
  if (!bundleContains(realDirectory, verifiedBundle.directory)) {
    throw importError("PATH_ESCAPE", "import bundle resolves outside the import directory");
  }
  if (marker.bundleManifestSha256 !== verifiedBundle.marker.bundleManifestSha256) {
    throw importError("MARKER_MISMATCH", "import completion marker does not match the frozen bundle");
  }

  const runtimeFile = await resolveBundleFile(
    requestedDirectory,
    realDirectory,
    marker.runtimeFile,
    "import completion marker runtimeFile",
  );
  const runtimeSegments = await runtimeSegmentsForBundle(bundleDirectory, verifiedBundle);
  const bundleMainFile = await resolveBundleFile(
    bundleDirectory,
    verifiedBundle.directory,
    verifiedBundle.manifest.main.databaseFile,
    "bundle main databaseFile",
  );
  const bundleMainManifestFile = await resolveBundleFile(
    bundleDirectory,
    verifiedBundle.directory,
    verifiedBundle.manifest.main.manifestFile,
    "bundle main manifestFile",
  );
  const bundleMain = new DatabaseSync(bundleMainFile, { readOnly: true });
  let authorityValue;
  try {
    authorityValue = bundleMain
      .prepare("SELECT value FROM store_meta WHERE key = ?")
      .get("history_archive_event_authority")?.value;
  } finally {
    bundleMain.close();
  }
  verifyMaterializedHistoryArchiveRuntime(runtimeFile, verifiedBundle.directory, runtimeSegments, authorityValue);

  return {
    ok: true,
    directory: realDirectory,
    markerFile,
    marker,
    bundleDirectory: verifiedBundle.directory,
    runtimeFile,
    manifest: verifiedBundle.manifest,
    context: await loadHistoryBackupContext(bundleMainFile, bundleMainManifestFile),
  };
}

/**
 * Assert that the source currently has exactly the candidate's in-range events.
 */
export function assertHistoryArchiveSourceMatches(sourceDatabase, verifiedCandidate) {
  if (!sourceDatabase || typeof sourceDatabase.prepare !== "function") {
    throw new TypeError("assertHistoryArchiveSourceMatches requires an open SQLite connection");
  }
  if (
    !verifiedCandidate ||
    typeof verifiedCandidate !== "object" ||
    Array.isArray(verifiedCandidate) ||
    verifiedCandidate.ok !== true ||
    !verifiedCandidate.candidate
  ) {
    throw new TypeError("verifiedCandidate must be the result of verifyHistoryArchiveCandidate");
  }
  let metadata;
  try {
    metadata = validateCandidateMetadata(verifiedCandidate.candidate);
  } catch (error) {
    throw new TypeError(`verifiedCandidate is invalid: ${error.message}`);
  }
  const actual = eventEvidence(sourceDatabase, metadata.startMs, metadata.endMs, true);
  if (actual.rows !== metadata.events.rows || actual.sha256 !== metadata.events.sha256) {
    throw archiveError(
      "HISTORY_ARCHIVE_SOURCE_CHANGED",
      "source events in the candidate range do not match the candidate fingerprint",
    );
  }
  const actualSources = sourceEvidence(sourceDatabase, metadata.startMs, metadata.endMs);
  if (actualSources.rows !== metadata.sources.rows || actualSources.sha256 !== metadata.sources.sha256) {
    throw archiveError(
      "HISTORY_ARCHIVE_SOURCE_CHANGED",
      "source identities for the candidate range do not match the candidate fingerprint",
    );
  }
}
