import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { copyFile, link, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { getPricingCatalog, validatePricingCatalog } from "./pricing.js";
import { serviceTierEvidenceFromSnapshot, serviceTierEvidenceSnapshot } from "./service-tier-evidence.js";
import { STORE_SCHEMA_VERSION } from "./usage-store.js";

export const HISTORY_BACKUP_FORMAT_VERSION = 1;
export const HISTORY_BACKUP_SCHEMA_VERSION = STORE_SCHEMA_VERSION;

const PROGRAM_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const CORE_TABLES_19 = Object.freeze(["store_meta", "source_files", "events", "rate_limit_observations"]);

const CORE_TABLES_20 = Object.freeze([...CORE_TABLES_19, "history_replaced_facts"]);

const CORE_TABLES_21 = Object.freeze([...CORE_TABLES_20, "archive_segments"]);

const CORE_TABLES_23 = Object.freeze([...CORE_TABLES_21, "quota_usage_sources"]);

const CORE_TABLES_BY_SCHEMA_VERSION = Object.freeze({
  19: CORE_TABLES_19,
  20: CORE_TABLES_20,
  21: CORE_TABLES_21,
  22: CORE_TABLES_21,
  23: CORE_TABLES_23,
  24: CORE_TABLES_23,
});

const verifiedTableEvidence = new Set();
const BACKUP_VALIDATION_VERSION = 1;
const verificationScopes = new AsyncLocalStorage();

/**
 * Enter one operation's verification context; success keeps its readers until close().
 * close() rejects new work immediately and waits for current work before releasing readers.
 * Receipts are synchronous, app-owned completed-proof storage, never archive/config input.
 * Persistent proofs require a lease protecting both files and their complete parent paths.
 * @param {{
 *   receipts?: { has(key: string): boolean, add(key: string): void },
 *   pinFiles?: (paths: string[]) => Promise<null | { check(): Promise<boolean>, close(): Promise<void> }>
 * }} [options]
 */
export function createHistoryVerificationScope({ receipts, pinFiles } = {}) {
  if (receipts && (typeof receipts.has !== "function" || typeof receipts.add !== "function")) {
    throw new TypeError("verification receipts require synchronous has/add functions");
  }
  if (pinFiles !== undefined && typeof pinFiles !== "function") throw new TypeError("pinFiles must be a function");
  const state = { receipts, pinFiles, entries: new Map(), closed: false, active: 0, finish: () => {} };
  let resolveClose;
  const closed = new Promise((resolve) => {
    resolveClose = resolve;
  });
  state.finish = () => {
    state.active--;
    if (state.closed && state.active === 0) {
      const closing = [...state.entries.values()].map((entry) => entry.close());
      state.entries.clear();
      Promise.allSettled(closing).then(() => resolveClose());
    }
  };
  const close = () => {
    if (!state.closed) {
      state.closed = true;
      state.active++;
      state.finish();
    }
    return closed;
  };
  return {
    run(work) {
      assertScopeOpen(state);
      state.active++;
      return verificationScopes.run(state, () => {
        try {
          const result = work();
          if (isThenable(result)) {
            return Promise.resolve(result)
              .catch((error) => {
                close();
                throw error;
              })
              .finally(state.finish);
          }
          state.finish();
          return result;
        } catch (error) {
          close();
          state.finish();
          throw error;
        }
      });
    },
    close,
  };
}

export function hasHistoryVerificationScope() {
  const scope = verificationScopes.getStore();
  return Boolean(scope && !scope.closed);
}

function assertScopeOpen(scope) {
  if (scope?.closed) throw backupError("HISTORY_BACKUP_SCOPE_CLOSED", "history verification scope is closed");
}

function isThenable(value) {
  return (
    value !== null && (typeof value === "object" || typeof value === "function") && typeof value.then === "function"
  );
}

function rememberProof(cache, key) {
  if (!cache.has(key) && cache.size >= 8) cache.delete(cache.values().next().value);
  cache.add(key);
}

function fileIdentity(stats) {
  return [
    stats.dev,
    stats.ino,
    stats.mode,
    stats.nlink,
    stats.size,
    stats.mtimeNs,
    stats.ctimeNs,
    stats.birthtimeNs,
  ].join(":");
}

function assertDatabaseHash(actual, expected) {
  if (actual.bytes !== expected.bytes) {
    throw backupError("HISTORY_BACKUP_SIZE_MISMATCH", "database byte size does not match manifest");
  }
  if (actual.sha256 !== expected.sha256) {
    throw backupError("HISTORY_BACKUP_DIGEST_MISMATCH", "database SHA-256 does not match manifest");
  }
}

function archiveGuard(databasePath, manifestPath, manifestDigest) {
  const files = [];
  const changed = () =>
    backupError("HISTORY_BACKUP_SCOPE_CHANGED", "archive file or manifest changed during verification scope");
  try {
    for (const file of [databasePath, manifestPath]) {
      const descriptor = openSync(file, "r");
      files.push({ file, descriptor, identity: fileIdentity(fstatSync(descriptor, { bigint: true })) });
    }
    const check = () => {
      for (const { file, descriptor, identity } of files) {
        if (
          fileIdentity(statSync(file, { bigint: true })) !== identity ||
          fileIdentity(fstatSync(descriptor, { bigint: true })) !== identity
        )
          throw changed();
      }
      if (sha256(readFileSync(manifestPath)) !== manifestDigest) throw changed();
      for (const { file, descriptor, identity } of files) {
        if (
          fileIdentity(statSync(file, { bigint: true })) !== identity ||
          fileIdentity(fstatSync(descriptor, { bigint: true })) !== identity
        )
          throw changed();
      }
    };
    check();
    return {
      check,
      close: () => {
        for (const { descriptor } of files) closeSync(descriptor);
      },
    };
  } catch (error) {
    for (const { descriptor } of files) closeSync(descriptor);
    throw error;
  }
}

function backupError(code, message) {
  return Object.assign(new Error(message), { code });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashFile(file) {
  const hash = createHash("sha256");
  let bytes = 0;
  const handle = await open(file, "r");
  try {
    // Bounded prefetch overlaps I/O and hashing without retaining stream chunks until GC.
    const buffers = [Buffer.alloc(1024 * 1024), Buffer.alloc(1024 * 1024)];
    let index = 0;
    let { bytesRead } = await handle.read(buffers[index], 0, buffers[index].length, null);
    while (bytesRead) {
      const buffer = buffers[index];
      index ^= 1;
      const pending = handle.read(buffers[index], 0, buffers[index].length, null);
      bytes += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
      ({ bytesRead } = await pending);
    }
  } finally {
    await handle.close();
  }
  return { bytes, sha256: hash.digest("hex") };
}

function databaseSuffix(file) {
  const directory = path.dirname(file);
  const name = path.basename(file);
  return path.join(
    directory,
    `.${name}.history-backup-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
}

function manifestPathFor(databaseFile) {
  const parsed = path.parse(databaseFile);
  return path.join(parsed.dir, `${parsed.name}.manifest.json`);
}

function temporaryManifestPathFor(databaseFile) {
  const parsed = path.parse(databaseFile);
  return path.join(
    parsed.dir,
    `.${parsed.name}.manifest-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
}

function sidecarFiles(databaseFile) {
  return [`${databaseFile}-wal`, `${databaseFile}-shm`, `${databaseFile}-journal`];
}

async function removeFiles(files) {
  await Promise.all(
    files.map(async (file) => {
      try {
        await rm(file, { force: true, maxRetries: 10, retryDelay: 50 });
      } catch {
        // Cleanup must not hide the original failure.
      }
    }),
  );
}

function tableExists(database, table) {
  return (
    database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

function tablesForSchemaVersion(version) {
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    !Object.hasOwn(CORE_TABLES_BY_SCHEMA_VERSION, version)
  ) {
    throw backupError(
      "HISTORY_BACKUP_UNSUPPORTED_SCHEMA",
      `unsupported history backup schema ${version}; supported ${Object.keys(CORE_TABLES_BY_SCHEMA_VERSION).join(", ")}`,
    );
  }
  return CORE_TABLES_BY_SCHEMA_VERSION[version];
}

function assertSupportedSchema(database) {
  const version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  const tables = tablesForSchemaVersion(version);
  const missing = tables.filter((table) => !tableExists(database, table));
  if (missing.length > 0) {
    throw backupError("HISTORY_BACKUP_MISSING_TABLE", `missing required table(s): ${missing.join(", ")}`);
  }
  if (version >= 21) {
    const archiveRows = Number(database.prepare("SELECT COUNT(*) AS count FROM archive_segments").get()?.count ?? 0);
    if (archiveRows > 0) {
      throw backupError(
        "HISTORY_BACKUP_ARCHIVES_UNSUPPORTED",
        `schema ${version} archive_segments contains ${archiveRows} row(s); external archive files are not packaged`,
      );
    }
  }
  return { version, tables };
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function tableFingerprint(database, table, eventPrefix = null) {
  const statement = database.prepare(`SELECT * FROM ${quoteIdentifier(table)}`);
  const arrays = typeof statement.setReturnArrays === "function" && typeof statement.columns === "function";
  const columns = arrays ? statement.columns().map((column) => column.name) : null;
  // Serialization is synchronous; one fixed-shape object preserves the legacy JSON without per-row allocation.
  const reusableRow = arrays ? Object.fromEntries(columns.map((name) => [name, null])) : null;
  if (arrays) statement.setReturnArrays(true);
  let count = 0;
  const hash = createHash("sha256");
  const eventHash = table === "events" && eventPrefix !== null ? createHash("sha256").update(eventPrefix) : null;
  let ordered = true;
  let previousId = null;
  for (const values of statement.iterate()) {
    const row = arrays ? reusableRow : values;
    if (arrays) {
      for (let index = 0; index < columns.length; index += 1) row[columns[index]] = values[index];
    }
    count += 1;
    const json = JSON.stringify(row);
    hash.update(json);
    hash.update("\n");
    if (eventHash) {
      // The archive fingerprint requires id ordering; other scan orders keep their independent check.
      ordered &&= Number.isSafeInteger(row.id) && (previousId === null || row.id > previousId);
      previousId = row.id;
      if (ordered) eventHash.update(json).update("\n");
    }
  }
  return {
    rows: count,
    sha256: hash.digest("hex"),
    ...(eventHash && ordered ? { prefixedSha256: eventHash.digest("hex") } : {}),
  };
}

function databaseEvidence(database, tables, eventPrefix = null) {
  const quickCheck = database.prepare("PRAGMA quick_check").all();
  if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok") {
    throw backupError("HISTORY_BACKUP_QUICK_CHECK", `quick_check failed: ${JSON.stringify(quickCheck)}`);
  }
  const foreignKeyViolations = tables.flatMap((table) =>
    database.prepare(`PRAGMA foreign_key_check(${quoteIdentifier(table)})`).all(),
  );
  if (foreignKeyViolations.length > 0) {
    throw backupError(
      "HISTORY_BACKUP_FOREIGN_KEY",
      `foreign_key_check found ${foreignKeyViolations.length} violation(s)`,
    );
  }
  return {
    quickCheck: "ok",
    foreignKeys: "ok",
    tables: Object.fromEntries(
      tables
        .map(
          (table) =>
            /** @type {[string, ReturnType<typeof tableFingerprint>]} */ ([
              table,
              tableFingerprint(database, table, eventPrefix),
            ]),
        )
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

async function normalizeBackup(databaseFile) {
  const database = new DatabaseSync(databaseFile);
  try {
    database.exec("PRAGMA journal_mode = DELETE");
  } finally {
    database.close();
  }
  await removeFiles(sidecarFiles(databaseFile));
}

async function publishFile(source, destination) {
  try {
    await link(source, destination);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw backupError("HISTORY_BACKUP_DESTINATION_EXISTS", `destination already exists: ${destination}`);
    }
    throw error;
  }
}

function explicitPricingCatalog(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("pricingCatalog must be a complete pricing catalog");
  }
  validatePricingCatalog(value);
  if (typeof value.version !== "string" || value.version.trim() === "") {
    throw new TypeError("pricingCatalog.version must be a non-empty string");
  }
  return structuredClone(value);
}

/**
 * Create a self-contained SQLite backup plus an external manifest.
 * Existing destination files are rejected; partial output is removed.
 * @param {{
 *   pricingCatalog?: ReturnType<typeof getPricingCatalog>,
 *   serviceTierEvidence?: ReturnType<typeof import("./service-tier-evidence.js").serviceTierEvidenceFromSnapshot> | null
 * }} [options]
 */
export async function createHistoryBackup(database, destinationFile, options = {}) {
  if (!database || typeof database.prepare !== "function") {
    throw new TypeError("createHistoryBackup requires an open SQLite connection");
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("createHistoryBackup options must be an object");
  }
  const serviceTierEvidence = options.serviceTierEvidence ?? null;
  const pricingSnapshot =
    options.pricingCatalog === undefined ? getPricingCatalog() : explicitPricingCatalog(options.pricingCatalog);
  const serviceTierEvidenceRecord =
    serviceTierEvidence === null
      ? null
      : (() => {
          const snapshot = serviceTierEvidenceSnapshot(serviceTierEvidence);
          return { snapshot, sha256: sha256(JSON.stringify(snapshot)) };
        })();
  const destination = path.resolve(destinationFile);
  const manifestFile = manifestPathFor(destination);

  await mkdir(path.dirname(destination), { recursive: true });
  const temporaryDatabase = databaseSuffix(destination);
  const temporaryManifest = temporaryManifestPathFor(destination);
  let publishedDatabase = false;
  let publishedManifest = false;
  try {
    await backup(database, temporaryDatabase);
    await normalizeBackup(temporaryDatabase);
    const inspection = new DatabaseSync(temporaryDatabase, { readOnly: true });
    let evidence;
    let schemaVersion;
    try {
      const schema = assertSupportedSchema(inspection);
      evidence = databaseEvidence(inspection, schema.tables);
      schemaVersion = schema.version;
    } finally {
      inspection.close();
    }
    const databaseHash = await hashFile(temporaryDatabase);
    const manifest = {
      formatVersion: HISTORY_BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      database: {
        filename: path.basename(destination),
        bytes: databaseHash.bytes,
        sha256: databaseHash.sha256,
      },
      schemaVersion,
      programVersion: PROGRAM_VERSION,
      pricingVersion: pricingSnapshot.version,
      pricingCheckedAt: pricingSnapshot.checkedAt,
      pricing: {
        sha256: sha256(JSON.stringify(pricingSnapshot)),
        catalog: pricingSnapshot,
      },
      serviceTierEvidence: serviceTierEvidenceRecord,
      tables: evidence.tables,
      quickCheck: evidence.quickCheck,
      foreignKeys: evidence.foreignKeys,
    };
    await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    // Exclusive hard links make the complete temp file visible atomically.
    // Only remove final artifacts whose exclusive creation completed here.
    try {
      await publishFile(temporaryDatabase, destination);
      publishedDatabase = true;
      await publishFile(temporaryManifest, manifestFile);
      publishedManifest = true;
    } catch (error) {
      await removeFiles([...(publishedDatabase ? [destination] : []), ...(publishedManifest ? [manifestFile] : [])]);
      throw error;
    }
    await removeFiles([temporaryDatabase, temporaryManifest]);
    return manifest;
  } catch (error) {
    await removeFiles([temporaryDatabase, temporaryManifest, ...sidecarFiles(temporaryDatabase)]);
    if (error?.code?.startsWith?.("HISTORY_BACKUP_")) throw error;
    throw backupError("HISTORY_BACKUP_FAILED", error?.message ?? String(error));
  }
}

function readManifestShape(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw backupError("HISTORY_BACKUP_BAD_MANIFEST", "manifest must be an object");
  }
  if (manifest.formatVersion !== HISTORY_BACKUP_FORMAT_VERSION) {
    throw backupError("HISTORY_BACKUP_BAD_MANIFEST", "unsupported manifest format");
  }
  if (!manifest.database || typeof manifest.database !== "object") {
    throw backupError("HISTORY_BACKUP_BAD_MANIFEST", "manifest database record is missing");
  }
  if (
    typeof manifest.database.filename !== "string" ||
    !Number.isSafeInteger(manifest.database.bytes) ||
    typeof manifest.database.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.database.sha256)
  ) {
    throw backupError("HISTORY_BACKUP_BAD_MANIFEST", "manifest database digest or byte size is invalid");
  }
  const tables = tablesForSchemaVersion(manifest.schemaVersion);
  if (
    typeof manifest.pricingVersion !== "string" ||
    typeof manifest.pricingCheckedAt !== "string" ||
    !manifest.pricing ||
    typeof manifest.pricing !== "object" ||
    Array.isArray(manifest.pricing) ||
    !manifest.pricing.catalog ||
    typeof manifest.pricing.catalog !== "object" ||
    Array.isArray(manifest.pricing.catalog) ||
    !manifest.pricing.catalog.models ||
    typeof manifest.pricing.catalog.models !== "object" ||
    Array.isArray(manifest.pricing.catalog.models) ||
    typeof manifest.pricing.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.pricing.sha256)
  ) {
    throw backupError("HISTORY_BACKUP_BAD_MANIFEST", "manifest pricing snapshot is invalid");
  }
  if (
    manifest.pricingVersion !== manifest.pricing.catalog.version ||
    manifest.pricingCheckedAt !== manifest.pricing.catalog.checkedAt
  ) {
    throw backupError("HISTORY_BACKUP_BAD_MANIFEST", "manifest pricing version does not match its catalog");
  }
  if (!Object.hasOwn(manifest, "serviceTierEvidence")) {
    throw backupError("HISTORY_BACKUP_BAD_MANIFEST", "manifest service-tier evidence marker is missing");
  }
  if (manifest.serviceTierEvidence !== null) {
    const captured = manifest.serviceTierEvidence;
    if (
      !captured ||
      typeof captured !== "object" ||
      Array.isArray(captured) ||
      !captured.snapshot ||
      typeof captured.snapshot !== "object" ||
      Array.isArray(captured.snapshot) ||
      typeof captured.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(captured.sha256)
    ) {
      throw backupError("HISTORY_BACKUP_BAD_MANIFEST", "manifest service-tier evidence snapshot is invalid");
    }
  }
  if (!manifest.tables || typeof manifest.tables !== "object") {
    throw backupError("HISTORY_BACKUP_BAD_MANIFEST", "manifest table evidence is missing");
  }
  for (const table of tables) {
    const entry = manifest.tables[table];
    if (
      !entry ||
      !Number.isSafeInteger(entry.rows) ||
      entry.rows < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw backupError("HISTORY_BACKUP_BAD_MANIFEST", `manifest table evidence is invalid for ${table}`);
    }
  }
}

/**
 * Verify a database and its adjacent manifest without modifying either file.
 */
export async function verifyHistoryBackup(databaseFile, manifestFile = manifestPathFor(databaseFile)) {
  return verifyHistoryBackupWithReader(databaseFile, manifestFile, null);
}

/** Verify and consume a backup under the same pinned SQLite read transaction. */
export async function withVerifiedHistoryBackup(databaseFile, manifestFile, reader, eventPrefix = undefined) {
  if (typeof reader !== "function") {
    throw new TypeError("withVerifiedHistoryBackup requires a synchronous reader function");
  }
  return verifyHistoryBackupWithReader(
    databaseFile,
    manifestFile ?? manifestPathFor(databaseFile),
    reader,
    eventPrefix,
  );
}

async function verifyHistoryBackupWithReader(databaseFile, manifestFile, reader, eventPrefix = undefined) {
  const scope = verificationScopes.getStore();
  assertScopeOpen(scope);
  if (scope) scope.active++;
  try {
    return await verifyHistoryBackupInScope(databaseFile, manifestFile, reader, eventPrefix, scope);
  } catch (error) {
    if (scope) {
      const entries = [...scope.entries.values()];
      scope.entries.clear();
      await Promise.allSettled(entries.map((entry) => entry.close()));
    }
    throw error;
  } finally {
    scope?.finish();
  }
}

async function verifyHistoryBackupInScope(databaseFile, manifestFile, reader, eventPrefix, scope) {
  const databasePath = path.resolve(databaseFile);
  const manifestPath = path.resolve(manifestFile);
  let manifest, manifestBytes;
  try {
    manifestBytes = await readFile(manifestPath);
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw backupError("HISTORY_BACKUP_BAD_MANIFEST", `cannot read manifest: ${error?.message ?? String(error)}`);
  }
  readManifestShape(manifest);
  if (sha256(JSON.stringify(manifest.pricing.catalog)) !== manifest.pricing.sha256) {
    throw backupError("HISTORY_BACKUP_PRICING_MISMATCH", "pricing catalog SHA-256 does not match manifest");
  }
  if (manifest.serviceTierEvidence !== null) {
    const { snapshot, sha256: expectedSha256 } = manifest.serviceTierEvidence;
    if (sha256(JSON.stringify(snapshot)) !== expectedSha256) {
      throw backupError(
        "HISTORY_BACKUP_SERVICE_TIER_EVIDENCE_MISMATCH",
        "service-tier evidence snapshot SHA-256 does not match manifest",
      );
    }
    try {
      serviceTierEvidenceFromSnapshot(snapshot);
    } catch (error) {
      throw backupError(
        "HISTORY_BACKUP_BAD_MANIFEST",
        `manifest service-tier evidence snapshot is invalid: ${error?.message ?? String(error)}`,
      );
    }
  }

  assertScopeOpen(scope);
  const entryKey = JSON.stringify([databasePath, manifestPath]);
  let entry = scope?.entries.get(entryKey);
  const first = !entry;
  if (!entry) {
    entry = {
      database: null,
      guard: null,
      lease: null,
      reusable: false,
      schema: null,
      closed: false,
      ready: null,
      closing: null,
      consumer: Promise.resolve(),
      manifestDigest: sha256(manifestBytes),
      async close() {
        if (this.closed) return this.closing;
        this.closed = true;
        this.closing = (async () => {
          try {
            await this.ready;
          } catch {
            /* Failed initialization still owns any acquired lease. */
          }
          try {
            if (this.database?.isOpen && this.database.isTransaction) this.database.exec("ROLLBACK");
          } finally {
            try {
              if (this.database?.isOpen) this.database.close();
            } finally {
              try {
                this.guard?.close();
              } finally {
                await this.lease?.close();
              }
            }
          }
        })();
        return this.closing;
      },
    };
    scope?.entries.set(entryKey, entry);
    entry.ready = (async () => {
      entry.lease = (await scope?.pinFiles?.([databasePath, manifestPath])) ?? null;
      assertScopeOpen(scope);
      if (entry.closed) throw backupError("HISTORY_BACKUP_SCOPE_CLOSED", "archive reader was released");
      if (entry.lease) entry.guard = archiveGuard(databasePath, manifestPath, entry.manifestDigest);
      assertDatabaseHash(await hashFile(databasePath), manifest.database);
      assertScopeOpen(scope);
      entry.database = new DatabaseSync(databasePath, { readOnly: true });
      entry.database.exec("BEGIN");
      entry.schema = assertSupportedSchema(entry.database);
      if (manifest.schemaVersion !== entry.schema.version) {
        throw backupError(
          "HISTORY_BACKUP_SCHEMA_MISMATCH",
          `manifest schema ${manifest.schemaVersion} does not match database schema ${entry.schema.version}`,
        );
      }
      // A main-file SHA cannot prove rows supplied by WAL.
      entry.reusable = entry.database.prepare("PRAGMA journal_mode").get().journal_mode === "delete";
      assertDatabaseHash(await hashFile(databasePath), manifest.database);
      entry.guard?.check();
    })();
  }
  let releaseConsumer = () => {};
  try {
    await entry.ready;
    assertScopeOpen(scope);
    if (entry.closed) throw backupError("HISTORY_BACKUP_SCOPE_CHANGED", "archive reader was released");
    if (!first && (!entry.lease || !entry.reusable)) {
      if (scope.entries.get(entryKey) === entry) scope.entries.delete(entryKey);
      return verifyHistoryBackupInScope(databaseFile, manifestFile, reader, eventPrefix, scope);
    }
    if (entry.lease && entry.reusable) {
      const previous = entry.consumer;
      entry.consumer = new Promise((resolve) => {
        releaseConsumer = () => resolve(undefined);
      });
      await previous;
      if (entry.closed) throw backupError("HISTORY_BACKUP_SCOPE_CHANGED", "archive reader was released");
    }
    const { database, schema, reusable } = entry;
    const check = async () => {
      entry.guard?.check();
      if (entry.lease && (await entry.lease.check()) !== true) {
        throw backupError("HISTORY_BACKUP_SCOPE_CHANGED", "archive file lease is no longer valid");
      }
      entry.guard?.check();
    };
    await check();
    if (entry.manifestDigest !== sha256(manifestBytes)) {
      throw backupError("HISTORY_BACKUP_SCOPE_CHANGED", "archive manifest changed during verification scope");
    }
    const proofIdentity = sha256(
      JSON.stringify([
        manifest.formatVersion,
        manifest.schemaVersion,
        sha256(manifestBytes),
        manifest.database.sha256,
        manifest.database.bytes,
      ]),
    );
    const completedProofs = [];
    const persistent = reusable && Boolean(entry.lease);
    // Legacy memory evidence never becomes a proof from the stronger parent-path lock.
    const proofDomain = persistent ? "path-locked-v2" : "legacy-memory";
    // Publication waits for the post-consumer lease check, including when the consumer throws.
    const verifyEvidence = (kind, version, cache, verify, formatVersion = manifest.formatVersion) => {
      const key = `history-verification:${kind}:v${version}:${proofDomain}:${sha256(JSON.stringify([proofIdentity, formatVersion]))}`;
      let completed = cache.has(key);
      if (persistent && !completed) {
        try {
          completed = scope?.receipts?.has(key) === true;
        } catch {
          /* A missing/corrupt derived receipt falls back to complete verification. */
        }
      }
      const evidence = !reusable || !completed ? verify() : undefined;
      if (reusable) completedProofs.push({ cache, key });
      return evidence;
    };
    let result,
      consumerError,
      consumerFailed = false;
    try {
      let eventEvidence;
      verifyEvidence("backup", BACKUP_VALIDATION_VERSION, verifiedTableEvidence, () => {
        const evidence = databaseEvidence(database, schema.tables, eventPrefix?.(database) ?? null);
        if (
          schema.tables.some(
            (table) =>
              evidence.tables[table].rows !== manifest.tables[table].rows ||
              evidence.tables[table].sha256 !== manifest.tables[table].sha256,
          )
        ) {
          throw backupError("HISTORY_BACKUP_TABLE_MISMATCH", "table row counts or hashes do not match manifest");
        }
        if (evidence.tables.events.prefixedSha256) {
          eventEvidence = { rows: evidence.tables.events.rows, sha256: evidence.tables.events.prefixedSha256 };
        }
      });
      const verified = {
        ok: true,
        databaseFile: databasePath,
        manifestFile: manifestPath,
        manifest,
      };
      result = reader ? reader(database, verified, eventEvidence, verifyEvidence) : verified;
      if (isThenable(result)) {
        throw backupError("HISTORY_BACKUP_READER_ASYNC", "history backup reader must be synchronous");
      }
    } catch (error) {
      consumerError = error;
      consumerFailed = true;
    }
    await check();
    if (entry.lease && (!database.isOpen || !database.isTransaction)) {
      throw backupError("HISTORY_BACKUP_SCOPE_CHANGED", "archive reader released its pinned transaction");
    }
    for (const { cache, key } of completedProofs) {
      rememberProof(cache, key);
      if (persistent) {
        try {
          scope?.receipts?.add(key);
        } catch {
          /* Optional derived persistence must not invalidate a completed proof. */
        }
      }
    }
    if (consumerFailed) throw consumerError;
    // Attached hot snapshots and temporary views belong to this consumer, not the next one.
    if (
      scope &&
      (database
        .prepare("PRAGMA database_list")
        .all()
        .some(({ name }) => name !== "main" && name !== "temp") ||
        database.prepare("SELECT 1 FROM sqlite_temp_master LIMIT 1").get())
    ) {
      if (scope.entries.get(entryKey) === entry) scope.entries.delete(entryKey);
      await entry.close();
    }
    return result;
  } catch (error) {
    if (scope?.entries.get(entryKey) === entry) scope.entries.delete(entryKey);
    await entry.close();
    throw error;
  } finally {
    releaseConsumer();
    if (!scope || ((!entry.lease || !entry.reusable) && first)) {
      if (scope?.entries.get(entryKey) === entry) scope.entries.delete(entryKey);
      await entry.close();
    }
  }
}

/**
 * Verify a package and expose its restore-time inputs without activating them.
 */
export async function loadHistoryBackupContext(databaseFile, manifestFile = manifestPathFor(databaseFile)) {
  const verified = await verifyHistoryBackup(databaseFile, manifestFile);
  return {
    databaseFile: verified.databaseFile,
    manifestFile: verified.manifestFile,
    pricingCatalog: verified.manifest.pricing.catalog,
    serviceTierEvidence:
      verified.manifest.serviceTierEvidence === null
        ? null
        : serviceTierEvidenceFromSnapshot(verified.manifest.serviceTierEvidence.snapshot),
  };
}

/**
 * Restore a verified package and its manifest to new paths. Existing files are
 * never overwritten; the restored copy is re-verified before success.
 */
export async function restoreHistoryBackup(backupFile, destinationFile, manifestFile = manifestPathFor(backupFile)) {
  const source = path.resolve(backupFile);
  const destination = path.resolve(destinationFile);
  const manifestPath = path.resolve(manifestFile);
  const verified = await verifyHistoryBackup(source, manifestPath);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = databaseSuffix(destination);
  const temporaryManifest = temporaryManifestPathFor(destination);
  const restoredManifestFile = manifestPathFor(destination);
  const restoredManifest = {
    ...verified.manifest,
    database: { ...verified.manifest.database, filename: path.basename(destination) },
  };
  let publishedDestination = false;
  let publishedManifest = false;
  try {
    await copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
    const copiedHash = await hashFile(temporary);
    if (
      copiedHash.bytes !== verified.manifest.database.bytes ||
      copiedHash.sha256 !== verified.manifest.database.sha256
    ) {
      throw backupError("HISTORY_BACKUP_DIGEST_MISMATCH", "restored copy digest changed during copy");
    }
    const inspection = new DatabaseSync(temporary, { readOnly: true });
    try {
      const schema = assertSupportedSchema(inspection);
      if (schema.version !== restoredManifest.schemaVersion) {
        throw backupError(
          "HISTORY_BACKUP_SCHEMA_MISMATCH",
          `restored schema ${schema.version} does not match manifest schema ${restoredManifest.schemaVersion}`,
        );
      }
      databaseEvidence(inspection, schema.tables);
    } finally {
      inspection.close();
    }
    await writeFile(temporaryManifest, `${JSON.stringify(restoredManifest, null, 2)}\n`, "utf8");
    await publishFile(temporary, destination);
    publishedDestination = true;
    await publishFile(temporaryManifest, restoredManifestFile);
    publishedManifest = true;
    await removeFiles([temporary, temporaryManifest]);
    return {
      restoredTo: destination,
      manifestFile: restoredManifestFile,
      bytes: copiedHash.bytes,
      sha256: verified.manifest.database.sha256,
    };
  } catch (error) {
    await removeFiles([
      temporary,
      temporaryManifest,
      ...sidecarFiles(temporary),
      ...(publishedDestination ? [destination] : []),
      ...(publishedManifest ? [restoredManifestFile] : []),
    ]);
    throw error;
  }
}
