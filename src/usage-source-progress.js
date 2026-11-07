import { DatabaseSync } from "node:sqlite";

export const USAGE_SOURCE_PROGRESS_TABLE = "usage_source_progress";
export const USAGE_SOURCE_PROGRESS_TABLE_NAMES = Object.freeze([
  USAGE_SOURCE_PROGRESS_TABLE,
  "usage_source_baselines",
  "usage_source_reparse",
]);
const MAX_PROGRESS_BYTES = 64 * 1024;
const CODEX_KINDS = new Set(["main", "extra", "jetbrains", "codex"]);
const progressStatements = new WeakMap();

function binding(row) {
  return JSON.stringify([row.kind, row.home_id, row.home_label, row.home_path, row.size, row.mtime_ms]);
}

function sourceRow(database, sourcePath) {
  return database
    .prepare("SELECT kind,home_id,home_label,home_path,size,mtime_ms FROM source_files WHERE path = ?")
    .get(sourcePath);
}

function validCheckpoint(checkpoint, row) {
  return (
    checkpoint?.format === 1 &&
    (CODEX_KINDS.has(row.kind)
      ? checkpoint.adapter === "codex-jsonl"
      : row.kind === "dsh" && checkpoint.adapter === "dsh-v4-zstd") &&
    Number.isSafeInteger(checkpoint.offset) &&
    checkpoint.offset >= 0 &&
    checkpoint.offset <= Number(row.size) &&
    Number.isSafeInteger(checkpoint.lineNumber) &&
    checkpoint.lineNumber >= 0 &&
    checkpoint.state !== null &&
    typeof checkpoint.state === "object" &&
    !Array.isArray(checkpoint.state)
  );
}

export function ensureUsageSourceProgressSchema(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS usage_source_progress (
    source_path TEXT PRIMARY KEY REFERENCES source_files(path) ON DELETE CASCADE,
    source_binding TEXT NOT NULL, checkpoint_json TEXT NOT NULL, validation_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS usage_source_baselines (
    source_path TEXT PRIMARY KEY REFERENCES source_files(path) ON DELETE CASCADE,
    home_id TEXT NOT NULL, session_id TEXT NOT NULL, before_ms INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS usage_source_baselines_session_idx
    ON usage_source_baselines(home_id, session_id, before_ms);
  CREATE TABLE IF NOT EXISTS usage_source_reparse (
    source_path TEXT PRIMARY KEY REFERENCES source_files(path) ON DELETE CASCADE
  ) STRICT`);
  // The old reader can still write facts; those writes must invalidate its stale cursor too.
  for (const table of ["events", "rate_limit_observations", "quota_usage_sources"]) {
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      const paths =
        operation === "UPDATE"
          ? "OLD.source_path, NEW.source_path"
          : `${operation === "DELETE" ? "OLD" : "NEW"}.source_path`;
      database.exec(`CREATE TRIGGER IF NOT EXISTS usage_source_progress_${table}_${operation}
        AFTER ${operation} ON ${table} BEGIN
          DELETE FROM usage_source_progress WHERE source_path IN (${paths});
          DELETE FROM usage_source_baselines WHERE source_path IN (${paths});
        END`);
    }
  }
  database.exec(`CREATE TRIGGER IF NOT EXISTS usage_source_progress_source_update
    AFTER UPDATE OF kind,home_id,home_label,home_path,size,mtime_ms ON source_files BEGIN
      DELETE FROM usage_source_progress WHERE source_path = NEW.path;
      DELETE FROM usage_source_baselines WHERE source_path = NEW.path;
    END`);
}

export function readUsageSourceBaseline(database, sourcePath) {
  return (
    database
      .prepare(
        "SELECT home_id AS homeId, session_id AS sessionId, before_ms AS beforeMs FROM usage_source_baselines WHERE source_path=?",
      )
      .get(sourcePath) || null
  );
}

export function writeUsageSourceBaseline(database, sourcePath, baseline) {
  if (!database.isTransaction) throw new Error("Source baseline requires the facts write transaction");
  if (!baseline || !Number.isSafeInteger(baseline.beforeMs)) {
    database.prepare("DELETE FROM usage_source_baselines WHERE source_path=?").run(sourcePath);
    return;
  }
  database
    .prepare(`INSERT INTO usage_source_baselines VALUES (?,?,?,?)
    ON CONFLICT(source_path) DO UPDATE SET home_id=excluded.home_id,
      session_id=excluded.session_id,before_ms=excluded.before_ms`)
    .run(sourcePath, String(baseline.homeId), String(baseline.sessionId), baseline.beforeMs);
}

export function markUsageSourceDependents(database, sourcePath, changes) {
  if (!database.isTransaction) throw new Error("Source dependency changes require the facts write transaction");
  const known = database.prepare(`INSERT OR IGNORE INTO usage_source_reparse
    SELECT source_path FROM usage_source_baselines
    WHERE home_id=? AND session_id=? AND before_ms>? AND source_path<>?`);
  const legacy = database.prepare(`INSERT OR IGNORE INTO usage_source_reparse
    SELECT DISTINCT e.source_path FROM events e JOIN source_files s ON s.path=e.source_path
    WHERE e.home_id=? AND e.session_id=? AND e.source_path<>?
      AND s.kind IN ('main','extra','jetbrains','codex')
      AND NOT EXISTS(SELECT 1 FROM usage_source_baselines b WHERE b.source_path=e.source_path)`);
  for (const change of changes) {
    known.run(change.homeId, change.sessionId, change.minimumMs, sourcePath);
    legacy.run(change.homeId, change.sessionId, sourcePath);
  }
  database.exec(
    "DELETE FROM usage_source_progress WHERE source_path IN (SELECT source_path FROM usage_source_reparse)",
  );
}

/** A single input can contain many session identities; only the small working set stays in JS. */
export class UsageSourceChangeBounds {
  constructor() {
    this.entries = new Map();
    this.bytes = 0;
    this.database = null;
    this.insert = null;
  }

  add(homeId, sessionId, time) {
    if (!Number.isSafeInteger(time)) return;
    const home = String(homeId),
      session = String(sessionId);
    if (this.database) {
      this.insert.run(home, session, time);
      return;
    }
    const key = JSON.stringify([home, session]);
    const previous = this.entries.get(key);
    if (previous) {
      previous.minimumMs = Math.min(previous.minimumMs, time);
      return;
    }
    this.bytes += key.length * 2 + 128;
    this.entries.set(key, { homeId: home, sessionId: session, minimumMs: time });
    if (this.bytes > 64 * 1024) {
      this.database = new DatabaseSync("");
      this.database.exec(`PRAGMA cache_size=-1024;
        CREATE TABLE bounds(home_id TEXT,session_id TEXT,minimum_ms INTEGER,
          PRIMARY KEY(home_id,session_id)) WITHOUT ROWID; BEGIN`);
      this.insert = this.database.prepare(`INSERT INTO bounds VALUES (?,?,?)
        ON CONFLICT(home_id,session_id) DO UPDATE SET minimum_ms=MIN(minimum_ms,excluded.minimum_ms)`);
      for (const entry of this.entries.values()) this.insert.run(entry.homeId, entry.sessionId, entry.minimumMs);
      this.entries.clear();
      this.bytes = 0;
    }
  }

  *[Symbol.iterator]() {
    if (this.database)
      yield* this.database
        .prepare("SELECT home_id AS homeId,session_id AS sessionId,minimum_ms AS minimumMs FROM bounds")
        .iterate();
    else yield* this.entries.values();
  }

  close() {
    this.database?.close();
    this.database = null;
    this.insert = null;
    this.entries.clear();
    this.bytes = 0;
  }
}

/** Returns a candidate only; its persisted validation must be verified against the current source before use. */
export function readUsageSourceProgress(database, sourcePath) {
  const cached = progressStatements.get(database);
  const statements = cached || {
    reparse: database.prepare("SELECT 1 FROM usage_source_reparse WHERE source_path=?"),
    progress: database.prepare("SELECT * FROM usage_source_progress WHERE source_path = ?"),
    source: database.prepare("SELECT kind,home_id,home_label,home_path,size,mtime_ms FROM source_files WHERE path = ?"),
  };
  if (!cached) progressStatements.set(database, statements);
  let saved, row;
  try {
    if (statements.reparse.get(sourcePath)) return null;
    saved = statements.progress.get(sourcePath);
    if (!saved) return null;
    row = statements.source.get(sourcePath);
  } catch (error) {
    if (!cached || error.code !== "ERR_INVALID_STATE" || error.message !== "statement has been finalized") throw error;
    // Reopening the same DatabaseSync object leaves its old statements finalized.
    progressStatements.delete(database);
    return readUsageSourceProgress(database, sourcePath);
  }
  if (!row || saved.source_binding !== binding(row)) return null;
  try {
    const checkpoint = JSON.parse(saved.checkpoint_json);
    const validation = JSON.parse(saved.validation_json);
    if (
      !validCheckpoint(checkpoint, row) ||
      !validation ||
      typeof validation !== "object" ||
      Array.isArray(validation)
    ) {
      return null;
    }
    return { checkpoint, validation };
  } catch {
    return null;
  }
}

/** Facts, source identity and the next cursor share the caller's write transaction. */
export function writeUsageSourceProgress(database, sourcePath, checkpoint, validation) {
  if (!database.isTransaction) throw new Error("Source progress requires the facts write transaction");
  const clear = () => database.prepare("DELETE FROM usage_source_progress WHERE source_path = ?").run(sourcePath);
  const row = sourceRow(database, sourcePath);
  if (
    !row ||
    !validCheckpoint(checkpoint, row) ||
    !validation ||
    typeof validation !== "object" ||
    Array.isArray(validation)
  ) {
    clear();
    return false;
  }
  const state = JSON.stringify(checkpoint);
  const proof = JSON.stringify(validation);
  if (Buffer.byteLength(state) + Buffer.byteLength(proof) > MAX_PROGRESS_BYTES) {
    clear();
    return false;
  }
  database
    .prepare(`INSERT INTO usage_source_progress VALUES (?, ?, ?, ?)
    ON CONFLICT(source_path) DO UPDATE SET source_binding = excluded.source_binding,
      checkpoint_json = excluded.checkpoint_json, validation_json = excluded.validation_json`)
    .run(sourcePath, binding(row), state, proof);
  return true;
}
