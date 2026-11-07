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
import { getPricingCatalog } from "./pricing.js";
import { serviceTierEvidenceFromSnapshot, serviceTierEvidenceSnapshot } from "./service-tier-evidence.js";

const ARCHIVE_EVENT_THRESHOLD = 400_000;
const COLD_HISTORY_DAYS = 180;
const verifiedCandidateEvidence = new Set();
const CANDIDATE_VALIDATION_VERSION = 1;
const HISTORY_ARCHIVE_CANDIDATE_FORMAT_VERSION = 1;
const HISTORY_ARCHIVE_CANDIDATE_META_KEY = "history_archive_candidate";
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
    (database, verified, sharedEvents, verifyEvidence) => {
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
      verifyEvidence(
        "candidate",
        CANDIDATE_VALIDATION_VERSION,
        verifiedCandidateEvidence,
        () => {
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
        },
        HISTORY_ARCHIVE_CANDIDATE_FORMAT_VERSION,
      );
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
  if (prepared.source?.databaseFile !== plan.source.databaseFile) {
    throw archiveError(
      "HISTORY_ARCHIVE_COMMIT_SOURCE_MISMATCH",
      "archive commit plan was prepared for a different source database",
    );
  }
  if (
    JSON.stringify(prepared.candidate) !== JSON.stringify(plan.candidate) ||
    JSON.stringify(prepared.deletion) !== JSON.stringify(plan.deletion)
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
