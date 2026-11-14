import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import { UsageHistoryQuery } from "./usage-history-query.js";
import { ensureUsageAllSummarySchema, markStoredHistoryAllSummaryDirty } from "./usage-all-summary-store.js";
import { ensureUsageRecordSchema, markStoredHistoryRecordsDirty } from "./usage-record-store.js";

const FORMAT = 1;
const STATE = "usage_history_projection_inputs";
const BATCHES = "usage_history_projection_batches";
const META_KEYS = [
  "history_archive_event_authority",
  "history_archive_event_revisions",
  "official_quota_observations",
  "quota_source_log_evidence",
];
const INPUT_TABLES = ["source_files", "archive_segments", "rate_limit_observations", "quota_usage_sources"];
const TRIGGERS = INPUT_TABLES.flatMap((table) =>
  ["INSERT", "UPDATE", "DELETE"].map((op) => [`usage_history_input_${table}_${op}`, `AFTER ${op} ON ${table}`]),
);
for (const op of ["INSERT", "UPDATE", "DELETE"]) {
  const refs = op === "UPDATE" ? ["OLD", "NEW"] : [op === "DELETE" ? "OLD" : "NEW"];
  TRIGGERS.push([
    `usage_history_input_store_meta_${op}`,
    `AFTER ${op} ON store_meta WHEN ${refs
      .map((ref) => `${ref}.key IN (${META_KEYS.map((key) => `'${key}'`).join(",")})`)
      .join(" OR ")}`,
  ]);
}

function transaction(database, work) {
  database.exec("SAVEPOINT history_projection_inputs");
  try {
    const result = work();
    database.exec("RELEASE history_projection_inputs");
    return result;
  } catch (error) {
    database.exec("ROLLBACK TO history_projection_inputs; RELEASE history_projection_inputs");
    throw error;
  }
}

/** Installed only for authorized cold history; hot ingestion pays no extra event trigger. */
export function ensureHistoryProjectionTracking(database) {
  const existing = database
    .prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN (?,?)")
    .all(STATE, BATCHES);
  const known = new Map(
    database
      .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'usage_history_input_%'")
      .all()
      .map((row) => [String(row.name), String(row.sql)]),
  );
  const definitions = TRIGGERS.map(([name, suffix]) => [
    name,
    `CREATE TRIGGER ${name} ${suffix} BEGIN UPDATE ${STATE} SET aux_revision=aux_revision+1 WHERE singleton=1; END`,
  ]);
  if (existing.length === 2 && definitions.every(([name, sql]) => known.get(name) === sql)) {
    const row = database.prepare(`SELECT format FROM ${STATE} WHERE singleton=1`).get();
    if (row?.format === FORMAT) return;
  }
  transaction(database, () => {
    for (const [name] of definitions) database.exec(`DROP TRIGGER IF EXISTS ${name}`);
    database.exec(`DROP TABLE IF EXISTS ${BATCHES}; DROP TABLE IF EXISTS ${STATE};
      CREATE TABLE ${STATE}(singleton INTEGER PRIMARY KEY CHECK(singleton=1),format INTEGER NOT NULL,
        instance TEXT NOT NULL,token TEXT NOT NULL,aux_revision INTEGER NOT NULL,sequence INTEGER NOT NULL) STRICT;
      CREATE TABLE ${BATCHES}(sequence INTEGER PRIMARY KEY,base_token TEXT NOT NULL,token TEXT NOT NULL,
        base_fact_revision INTEGER NOT NULL,fact_revision INTEGER NOT NULL,
        base_aux_revision INTEGER NOT NULL,aux_revision INTEGER NOT NULL,
        mode TEXT NOT NULL,sources_json TEXT NOT NULL) STRICT;`);
    database.prepare(`INSERT INTO ${STATE} VALUES(1,?,?,?,?,0)`).run(FORMAT, randomUUID(), randomUUID(), 0);
    for (const [, sql] of definitions) database.exec(sql);
  });
}

/** Durable inputs, never connection-local total_changes/data_version as a restart cursor. */
export function readHistoryProjectionStamp(database) {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(STATE)) return null;
  const row = database.prepare(`SELECT * FROM ${STATE} WHERE singleton=1`).get();
  const fact = database.prepare("SELECT revision FROM usage_business_revision WHERE singleton=1").get();
  if (
    row?.format !== FORMAT ||
    !fact ||
    typeof row.instance !== "string" ||
    typeof row.token !== "string" ||
    ![row.sequence, row.aux_revision, fact.revision].every((value) => Number.isSafeInteger(value) && value >= 0)
  )
    throw new Error("Invalid history projection input state");
  return {
    instance: row.instance,
    token: row.token,
    sequence: Number(row.sequence),
    facts: Number(fact.revision),
    auxiliary: Number(row.aux_revision),
    schema: Number(database.prepare("PRAGMA main.schema_version").get().schema_version),
    userVersion: Number(database.prepare("PRAGMA main.user_version").get().user_version),
  };
}

export function sameHistoryProjectionStamp(left, right) {
  return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right);
}

/** Call before COMMIT of the facts transaction, after all its source/auxiliary writes. */
export function recordHistoryProjectionBatch(
  database,
  before,
  { sources = [], mode = "replace", rebindings = [] } = {},
) {
  if (!before) return null;
  if (!database.isTransaction) throw new Error("History input batch needs the facts transaction");
  if (
    !["append", "replace", "inputs", "archive", "baseline", "rebind"].includes(mode) ||
    !Array.isArray(sources) ||
    sources.some((source) => typeof source !== "string" || source === "")
  )
    throw new TypeError("Invalid history projection batch");
  if (mode === "rebind" && !validRebindings(rebindings)) throw new TypeError("Invalid archive identity mapping");
  const after = readHistoryProjectionStamp(database);
  if (after.instance !== before.instance || after.token !== before.token || after.sequence !== before.sequence)
    throw new Error("History projection batch overlaps another input version");
  if (after.facts === before.facts && after.auxiliary === before.auxiliary && mode !== "baseline") return after;
  const token = randomUUID(),
    sequence = after.sequence + 1;
  database
    .prepare(`INSERT INTO ${BATCHES} VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(
      sequence,
      before.token,
      token,
      before.facts,
      after.facts,
      before.auxiliary,
      after.auxiliary,
      mode,
      JSON.stringify(mode === "rebind" ? rebindings : [...new Set(sources)]),
    );
  database.prepare(`UPDATE ${STATE} SET token=?,sequence=? WHERE singleton=1`).run(token, sequence);
  // A long-unread cache may rebuild; the authoritative store never retains an unbounded change log.
  database.prepare(`DELETE FROM ${BATCHES} WHERE sequence<?`).run(sequence - 1023);
  return readHistoryProjectionStamp(database);
}

function validRebindings(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        pair.every((id) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id)) &&
        pair[0] !== pair[1],
    ) &&
    new Set(value.map((pair) => pair[0])).size === value.length &&
    new Set(value.map((pair) => pair[1])).size === value.length
  );
}

/** Missing coverage means a conservative rebuild, including old/external writer commits. */
export function historyProjectionBatches(database, from, target = readHistoryProjectionStamp(database)) {
  if (
    !from ||
    !target ||
    from.instance !== target.instance ||
    from.schema !== target.schema ||
    from.userVersion !== target.userVersion ||
    from.sequence > target.sequence
  )
    return null;
  if (sameHistoryProjectionStamp(from, target)) return [];
  let cursor = from;
  const batches = [];
  for (const row of database
    .prepare(`SELECT * FROM ${BATCHES} WHERE sequence>? AND sequence<=? ORDER BY sequence`)
    .iterate(from.sequence, target.sequence)) {
    if (
      row.sequence !== cursor.sequence + 1 ||
      row.base_token !== cursor.token ||
      row.base_fact_revision !== cursor.facts ||
      row.base_aux_revision !== cursor.auxiliary
    )
      return null;
    const sources = JSON.parse(String(row.sources_json));
    if (
      row.mode === "rebind"
        ? !validRebindings(sources)
        : !Array.isArray(sources) || sources.some((source) => typeof source !== "string")
    )
      return null;
    if (row.mode === "baseline") return null;
    batches.push(
      row.mode === "rebind"
        ? { mode: String(row.mode), sources: [], rebindings: sources }
        : { mode: String(row.mode), sources },
    );
    cursor = {
      ...cursor,
      token: String(row.token),
      sequence: Number(row.sequence),
      facts: Number(row.fact_revision),
      auxiliary: Number(row.aux_revision),
    };
  }
  return sameHistoryProjectionStamp(cursor, target) ? batches : null;
}

/** A full capture gets a new durable identity, including after an untracked writer. */
export function certifyHistoryProjectionBaseline(database, expected) {
  return transaction(database, () => {
    const current = readHistoryProjectionStamp(database);
    if (!sameHistoryProjectionStamp(current, expected)) return null;
    return recordHistoryProjectionBatch(database, current, { mode: "baseline" });
  });
}

const CACHE_STATE = "usage_history_projection_cache";
const IMPORTED = "usage_history_projection_imports";
const CACHE_FORMAT = 1;
const SOURCE_CURSORS = "usage_history_projection_sources";
const AUX_TABLES = ["store_meta", "source_files", "archive_segments", "rate_limit_observations", "quota_usage_sources"];
const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;

function copyRows(source, destination, table, where = "", params = []) {
  const preserveRowid = ["rate_limit_observations", "quota_usage_sources"].includes(table);
  const statement = source.prepare(`SELECT ${preserveRowid ? "rowid,*" : "*"} FROM ${quote(table)} ${where}`);
  const columns = statement.columns().map((column) => quote(column.name));
  statement.setReturnArrays(true);
  const insert = destination.prepare(`INSERT INTO ${quote(table)} (${columns}) VALUES(${columns.map(() => "?")})`);
  for (const row of statement.iterate(...params)) insert.run(...row);
}

function captureDelta(source, query, before, identity, calendar) {
  let capture;
  source.exec("SAVEPOINT history_projection_delta_capture");
  try {
    const stamp = readHistoryProjectionStamp(source),
      batches = historyProjectionBatches(source, before, stamp);
    if (!batches) return null;
    capture = new DatabaseSync("");
    capture.exec(
      "PRAGMA cache_size=-256; PRAGMA temp_store=FILE; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA foreign_keys=OFF",
    );
    for (const table of [...AUX_TABLES, "events"])
      capture.exec(
        String(source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql),
      );
    capture.exec(`CREATE TABLE changed_sources(path TEXT PRIMARY KEY,mode TEXT NOT NULL,last_id INTEGER NOT NULL) STRICT;
      CREATE TABLE changed_cold_sources(segment_id TEXT NOT NULL,source_path TEXT NOT NULL,
        PRIMARY KEY(segment_id,source_path)) WITHOUT ROWID;
      CREATE TABLE cold_rows(segment_id TEXT NOT NULL,source_path TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX cold_rows_source ON cold_rows(segment_id,source_path);
      CREATE TABLE hot_conflicts(segment_id TEXT PRIMARY KEY);
      CREATE TABLE mirror_counts(segment_id TEXT,payload TEXT,n INTEGER NOT NULL,
        PRIMARY KEY(segment_id,payload)) WITHOUT ROWID;
      CREATE TABLE mirror_sources(segment_id TEXT PRIMARY KEY,sources_json TEXT NOT NULL);`);
    const conflict = capture.prepare("INSERT INTO hot_conflicts VALUES(?)");
    for (const row of source
      .prepare(`SELECT a.segment_id FROM archive_segments a WHERE EXISTS (
      SELECT 1 FROM events e WHERE e.timestamp_ms>=a.start_ms AND e.timestamp_ms<a.end_ms)`)
      .iterate())
      conflict.run(row.segment_id);
    const sources = new Map();
    const rebound = new Map();
    for (const batch of batches)
      for (const [from, to] of batch.rebindings || []) {
        const prior = [...rebound].find(([, current]) => current === from);
        rebound.set(prior ? prior[0] : from, to);
      }
    const rebindings = [...rebound].filter(([from, to]) => from !== to);
    for (const batch of batches)
      for (const file of batch.sources) {
        sources.set(file, sources.has(file) && sources.get(file) !== "append" ? "replace" : batch.mode);
      }
    const cursor = query.database.prepare(`SELECT last_id FROM ${SOURCE_CURSORS} WHERE source_path=?`);
    const current = source.prepare("SELECT MAX(id) n FROM events WHERE source_path=?");
    const save = capture.prepare("INSERT INTO changed_sources VALUES(?,?,?)");
    for (const [file, mode] of sources) {
      const afterId =
        mode === "append" ? Number(cursor.get(file)?.last_id ?? Number.MIN_SAFE_INTEGER) : Number.MIN_SAFE_INTEGER;
      copyRows(source, capture, "events", "WHERE source_path=? AND id>? ORDER BY id", [file, afterId]);
      save.run(file, mode, Number(current.get(file).n ?? Number.MIN_SAFE_INTEGER));
    }
    const fullAuxiliary = batches.some((batch) => batch.mode === "inputs");
    for (const table of AUX_TABLES) {
      const scoped = ["rate_limit_observations", "quota_usage_sources"].includes(table);
      if (scoped && !fullAuxiliary)
        for (const file of sources.keys()) copyRows(source, capture, table, "WHERE source_path=?", [file]);
      else copyRows(source, capture, table);
    }
    const authority = source.prepare("SELECT value FROM store_meta WHERE key='history_archive_event_authority'").get();
    const authorized = new Set(authority ? JSON.parse(String(authority.value)).segmentIds : []);
    const saveMirror = capture.prepare(`INSERT INTO mirror_counts VALUES(?,?,1)
      ON CONFLICT(segment_id,payload) DO UPDATE SET n=n+1`);
    const rangeRows = source.prepare("SELECT * FROM events WHERE timestamp_ms>=? AND timestamp_ms<? ORDER BY id");
    for (const segment of source.prepare("SELECT * FROM archive_segments").iterate()) {
      if (authorized.has(String(segment.segment_id))) continue;
      for (const row of rangeRows.iterate(segment.start_ms, segment.end_ms))
        saveMirror.run(segment.segment_id, JSON.stringify(query.canonicalPayload(row, ["id"])));
      const identities = source
        .prepare(`SELECT sf.path,sf.kind,sf.home_id,sf.home_label,sf.home_path FROM source_files sf
        WHERE EXISTS(SELECT 1 FROM events e WHERE e.source_path=sf.path AND e.timestamp_ms>=? AND e.timestamp_ms<?)
        ORDER BY sf.path,sf.kind,sf.home_id,sf.home_label,sf.home_path`)
        .all(segment.start_ms, segment.end_ms);
      capture.prepare("INSERT INTO mirror_sources VALUES(?,?)").run(segment.segment_id, JSON.stringify(identities));
    }
    return { database: capture, stamp, identity, calendar, sources, fullAuxiliary, rebindings };
  } catch (error) {
    capture?.close();
    throw error;
  } finally {
    source.exec("RELEASE history_projection_delta_capture");
  }
}

function replaceAuxiliary(captured, destination, fullAuxiliary) {
  for (const table of ["store_meta", "archive_segments"]) {
    destination.exec(`DELETE FROM ${table}`);
    copyRows(captured, destination, table);
  }
  const files = captured.prepare("SELECT * FROM source_files"),
    columns = files.columns().map((column) => column.name);
  files.setReturnArrays(true);
  const update = destination.prepare(`INSERT INTO source_files(${columns.map(quote)}) VALUES(${columns.map(() => "?")})
    ON CONFLICT(path) DO UPDATE SET ${columns
      .filter((name) => name !== "path")
      .map((name) => `${quote(name)}=excluded.${quote(name)}`)
      .join(",")}
    WHERE ${columns
      .filter((name) => name !== "path")
      .map((name) => `${quote(name)} IS NOT excluded.${quote(name)}`)
      .join(" OR ")}`);
  for (const row of files.iterate()) update.run(...row);
  const existing = captured.prepare("SELECT path FROM changed_sources"),
    present = captured.prepare("SELECT 1 FROM source_files WHERE path=?");
  const removed = destination.prepare("DELETE FROM source_files WHERE path=?");
  for (const row of existing.iterate()) if (!present.get(row.path)) removed.run(row.path);
  for (const table of ["rate_limit_observations", "quota_usage_sources"]) {
    const clear = destination.prepare(`DELETE FROM ${table} WHERE source_path=?`);
    if (fullAuxiliary) destination.exec(`DELETE FROM ${table}`);
    else for (const row of captured.prepare("SELECT path FROM changed_sources").iterate()) clear.run(row.path);
    copyRows(captured, destination, table);
  }
}

function readPointer(directory, name) {
  const file = path.join(directory, name);
  if (!existsSync(file)) return null;
  let pointer;
  try {
    pointer = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
  return pointer?.format === CACHE_FORMAT &&
    typeof pointer.file === "string" &&
    /^projection-[a-f0-9-]{36}\.sqlite$/.test(pointer.file)
    ? pointer.file
    : null;
}

function writePointer(directory, name, file) {
  const destination = path.join(directory, name),
    temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ format: CACHE_FORMAT, file })}\n`, { flag: "wx", flush: true });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function removeCacheFile(file) {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(file + suffix, { force: true });
}

function header(query) {
  const row = query.database.prepare(`SELECT * FROM ${CACHE_STATE} WHERE singleton=1`).get();
  if (row?.format !== CACHE_FORMAT || !["building", "ready"].includes(String(row.status))) return null;
  return {
    identity: String(row.source_identity),
    stamp: JSON.parse(String(row.inputs_json)),
    calendar: String(row.calendar_zone),
    ready: row.status === "ready",
  };
}

function saveHeader(query, identity, stamp, calendar, status) {
  query.database
    .prepare(`INSERT INTO ${CACHE_STATE} VALUES(1,?,?,?,?,?)
    ON CONFLICT(singleton) DO UPDATE SET format=excluded.format,source_identity=excluded.source_identity,
    inputs_json=excluded.inputs_json,calendar_zone=excluded.calendar_zone,status=excluded.status`)
    .run(CACHE_FORMAT, identity, JSON.stringify(stamp), calendar, status);
}

/** One owned derived database survives executor lifetime; source/package files remain authoritative. */
export class HistoryProjectionStore {
  constructor(databaseFile, canonicalPayload) {
    this.directory = `${path.resolve(databaseFile)}.history-cache`;
    this.canonicalPayload = canonicalPayload;
    this.query = null;
    this.file = null;
    this.candidateFile = null;
    this.work = null;
    this.verificationDatabase = null;
  }

  /** Only completed content-bound proofs live here; package bytes are checked on every operation. */
  verificationReceipts() {
    const table = "usage_history_verification_receipts";
    const schema = `CREATE TABLE ${table}(proof TEXT PRIMARY KEY) STRICT`;
    const read = (database, key) => {
      if (database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql !== schema)
        return false;
      return Boolean(database.prepare(`SELECT 1 FROM ${table} WHERE proof=?`).get(key));
    };
    return {
      has: (key) => {
        let owned;
        try {
          const current = this.verificationDatabase || this.query?.database;
          if (current) return read(current, key);
          const file = readPointer(this.directory, "current.json");
          if (!file) return false;
          owned = new DatabaseSync(path.toNamespacedPath(path.join(this.directory, file)), { readOnly: true });
          return read(owned, key);
        } catch {
          // An unavailable derived receipt requires full verification of the authoritative package.
          return false;
        } finally {
          owned?.close();
        }
      },
      add: (key) => {
        const database = this.verificationDatabase || this.query?.database;
        if (!database || database.isTransaction) return;
        transaction(database, () => {
          if (
            database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql !== schema
          ) {
            database.exec(`DROP TABLE IF EXISTS ${table}`);
            database.exec(schema);
          }
          database.prepare(`INSERT OR IGNORE INTO ${table} VALUES(?)`).run(key);
          database.exec(`DELETE FROM ${table} WHERE rowid IN
            (SELECT rowid FROM ${table} ORDER BY rowid DESC LIMIT -1 OFFSET 256)`);
        });
      },
    };
  }

  /** SQLite releases this cross-process maintenance lock even after forced termination. */
  async lock() {
    mkdirSync(this.directory, { recursive: true });
    const database = new DatabaseSync(path.toNamespacedPath(path.join(this.directory, "maintenance.lock")));
    try {
      database.exec("PRAGMA busy_timeout=0");
      for (;;) {
        try {
          database.exec("BEGIN IMMEDIATE");
          break;
        } catch (error) {
          if (error.errcode !== 5 && error.errcode !== 6) throw error;
          await setTimeout(100);
        }
      }
      return () => database.close();
    } catch (error) {
      database.close();
      throw error;
    }
  }

  load(file) {
    if (!file || !existsSync(path.join(this.directory, file))) return null;
    let query;
    try {
      query = new UsageHistoryQuery(null, this.canonicalPayload, {
        databaseFile: path.join(this.directory, file),
        existing: true,
      });
      const state = header(query);
      if (!state) {
        query.close();
        return null;
      }
      return { query, state, file };
    } catch (error) {
      query?.close();
      if (
        error instanceof SyntaxError ||
        /SQLITE_(?:CORRUPT|NOTADB)|not a database|no such table|malformed/i.test(`${error.code} ${error.message}`)
      )
        return null;
      throw error;
    }
  }

  /** Pin an already published version; its consumer still verifies every archive before reading. */
  openPublished(source, identity, calendar) {
    const file = readPointer(this.directory, "current.json");
    if (!file) return null;
    let database;
    try {
      database = new DatabaseSync(path.toNamespacedPath(path.join(this.directory, file)), { readOnly: true });
      database.exec("PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; BEGIN");
      const state = header({ database });
      const stamp = readHistoryProjectionStamp(source);
      if (
        !state?.ready ||
        state.identity !== identity ||
        state.calendar !== calendar ||
        !sameHistoryProjectionStamp(state.stamp, stamp)
      ) {
        database.close();
        return null;
      }
      return { database, file: path.join(this.directory, file), stamp };
    } catch (error) {
      database?.close();
      if (
        !existsSync(path.join(this.directory, file)) ||
        error instanceof SyntaxError ||
        /SQLITE_(?:CORRUPT|NOTADB)|not a database|no such table|malformed/i.test(`${error.code} ${error.message}`)
      )
        return null;
      throw error;
    }
  }

  /** Capture the main database before asynchronous package verification starts. */
  prepare(source, identity, calendar) {
    ensureHistoryProjectionTracking(source);
    mkdirSync(this.directory, { recursive: true });
    const currentFile = readPointer(this.directory, "current.json");
    if (!this.query || currentFile !== this.file) {
      const current = this.load(currentFile);
      if (current?.state.ready) {
        this.query?.close();
        this.query = current.query;
        this.file = current.file;
      } else current?.query.close();
    }
    const stamp = readHistoryProjectionStamp(source),
      previous = this.query ? header(this.query) : null;
    if (
      previous?.identity === identity &&
      previous.calendar === calendar &&
      sameHistoryProjectionStamp(previous.stamp, stamp)
    ) {
      this.work = { rebuilt: false, reused: true, resumed: false, hotCopied: 0, coldCopied: 0 };
      return { query: this.query, stamp, reused: true, rebuilding: false };
    }
    if (previous?.identity === identity) {
      const delta = captureDelta(source, this.query, previous.stamp, identity, calendar);
      if (delta) {
        delta.recalendar = previous.calendar !== calendar;
        this.work = { rebuilt: false, reused: false, resumed: false, hotCopied: 0, coldCopied: 0 };
        return { query: this.query, stamp: delta.stamp, reused: false, rebuilding: false, delta };
      }
    }
    const pending = this.load(readPointer(this.directory, "candidate.json"));
    if (pending?.state.identity === identity && pending.state.ready) {
      const delta = captureDelta(source, pending.query, pending.state.stamp, identity, calendar);
      if (delta) {
        delta.recalendar = pending.state.calendar !== calendar;
        this.candidateFile = pending.file;
        this.work = { rebuilt: true, reused: false, resumed: true, hotCopied: 0, coldCopied: 0 };
        return { query: pending.query, stamp: delta.stamp, reused: false, rebuilding: true, delta };
      }
    }
    if (
      pending?.state.identity === identity &&
      pending.state.calendar === calendar &&
      sameHistoryProjectionStamp(pending.state.stamp, stamp)
    ) {
      this.candidateFile = pending.file;
      this.work = { rebuilt: true, reused: false, resumed: true, hotCopied: 0, coldCopied: 0 };
      return { query: pending.query, stamp, reused: false, rebuilding: true };
    }
    pending?.query.close();
    if (pending) removeCacheFile(path.join(this.directory, pending.file));
    const file = `projection-${randomUUID()}.sqlite`;
    let query, captured;
    source.exec("SAVEPOINT history_projection_capture");
    try {
      captured = readHistoryProjectionStamp(source);
      query = new UsageHistoryQuery(source, this.canonicalPayload, {
        databaseFile: path.join(this.directory, file),
        calendar,
      });
      query.database.exec(`BEGIN IMMEDIATE;
        CREATE TABLE ${CACHE_STATE}(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        format INTEGER NOT NULL,source_identity TEXT NOT NULL,inputs_json TEXT NOT NULL,
        calendar_zone TEXT NOT NULL,status TEXT NOT NULL) STRICT;
        CREATE TABLE ${IMPORTED}(segment_id TEXT PRIMARY KEY) STRICT;
        CREATE TABLE ${SOURCE_CURSORS}(source_path TEXT PRIMARY KEY,last_id INTEGER NOT NULL) STRICT;`);
      const saveCursor = query.database.prepare(`INSERT INTO ${SOURCE_CURSORS} VALUES(?,?)`);
      for (const row of source
        .prepare(`SELECT sf.path,MAX(e.id) last_id FROM source_files sf
        LEFT JOIN events e ON e.source_path=sf.path GROUP BY sf.path`)
        .iterate()) {
        saveCursor.run(row.path, Number(row.last_id ?? Number.MIN_SAFE_INTEGER));
      }
      saveHeader(query, identity, captured, calendar, "building");
      query.database.exec("COMMIT");
    } catch (error) {
      query?.close();
      removeCacheFile(path.join(this.directory, file));
      throw error;
    } finally {
      source.exec("RELEASE history_projection_capture");
    }
    this.candidateFile = file;
    writePointer(this.directory, "candidate.json", file);
    this.work = { rebuilt: true, reused: false, resumed: false, hotCopied: query.rows, coldCopied: 0 };
    return { query, stamp: captured, reused: false, rebuilding: true };
  }

  imported(query, segmentId) {
    return Boolean(query.database.prepare(`SELECT 1 FROM ${IMPORTED} WHERE segment_id=?`).get(segmentId));
  }

  markImported(query, segmentId) {
    query.database.prepare(`INSERT INTO ${IMPORTED} VALUES(?)`).run(segmentId);
  }

  captureColdSource(prepared, segmentId, sourcePath, rows) {
    const database = prepared.delta.database;
    database.prepare("INSERT INTO changed_cold_sources VALUES(?,?)").run(segmentId, sourcePath);
    const insert = database.prepare("INSERT INTO cold_rows VALUES(?,?,?)");
    for (const row of rows) insert.run(segmentId, sourcePath, JSON.stringify(this.canonicalPayload(row, ["id"])));
  }

  applyDelta(prepared, columns, project) {
    const { query, delta } = prepared,
      database = query.database,
      captured = delta.database;
    ensureUsageAllSummarySchema(database, { mode: "history" });
    ensureUsageRecordSchema(database, { mode: "history" });
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const [from, to] of delta.rebindings) {
        if (!this.imported(query, from) || this.imported(query, to))
          throw new Error("Archive projection identity mapping is stale");
        database.prepare("UPDATE history_query_rows SET segment_id=? WHERE segment_id=?").run(to, from);
        database.prepare(`UPDATE ${IMPORTED} SET segment_id=? WHERE segment_id=?`).run(to, from);
      }
      for (const row of captured.prepare("SELECT * FROM changed_sources").iterate()) {
        const rows = captured.prepare("SELECT * FROM events WHERE source_path=? ORDER BY id").iterate(row.path);
        if (row.mode === "append") query.add(rows, "hot");
        else query.replaceRows("hot", String(row.path), rows);
        database
          .prepare(`INSERT INTO ${SOURCE_CURSORS} VALUES(?,?)
          ON CONFLICT(source_path) DO UPDATE SET last_id=excluded.last_id`)
          .run(row.path, row.last_id);
      }
      for (const row of captured.prepare("SELECT * FROM changed_cold_sources").iterate()) {
        const rows = captured
          .prepare("SELECT payload FROM cold_rows WHERE segment_id=? AND source_path=?")
          .iterate(row.segment_id, row.source_path);
        function* decoded() {
          for (const value of rows) yield JSON.parse(String(value.payload));
        }
        query.replaceRows(String(row.segment_id), String(row.source_path), decoded());
      }
      replaceAuxiliary(captured, database, delta.fullAuxiliary);
      database.exec(`CREATE TEMP TABLE IF NOT EXISTS history_projection_dirty_times(timestamp_ms INTEGER PRIMARY KEY);
        DELETE FROM history_projection_dirty_times;
        INSERT INTO history_projection_dirty_times SELECT timestamp_ms FROM history_query_changes WHERE added<>0 OR removed<>0`);
      const work = query.finishChanges(columns, project);
      if (delta.recalendar) {
        const write = database.prepare(
          "UPDATE events SET project=?,hour_key=?,day_key=?,week_key=?,month_key=? WHERE id=?",
        );
        for (const row of database
          .prepare("SELECT event_id,payload FROM history_query_rows ORDER BY rowid")
          .iterate()) {
          const event = project(JSON.parse(String(row.payload)));
          write.run(event.project, event.hour_key, event.day_key, event.week_key, event.month_key, row.event_id);
        }
        // Existing calendar proofs and derived memberships must be re-certified from retained facts.
        database.exec("DELETE FROM usage_rollup_days; DELETE FROM usage_rollup_dirty_days");
        database.prepare("DELETE FROM store_meta WHERE key='usage_rollup_local_zone_identity'").run();
        const first = database.prepare("SELECT MIN(timestamp_ms) AS ms FROM events").get();
        if (first.ms !== null) work.dirty = { ms: Number(first.ms), id: Number.MIN_SAFE_INTEGER };
        this.work.recalendar = true;
      }
      if (work?.dirty) {
        database.prepare("UPDATE usage_business_revision SET revision=revision+1 WHERE singleton=1").run();
        markStoredHistoryAllSummaryDirty(database, work.dirty);
        for (const row of database.prepare("SELECT timestamp_ms FROM history_projection_dirty_times").iterate()) {
          markStoredHistoryRecordsDirty(database, { ms: Number(row.timestamp_ms), id: Number.MIN_SAFE_INTEGER });
        }
      }
      database.exec("DELETE FROM history_projection_dirty_times");
      saveHeader(query, delta.identity, delta.stamp, delta.calendar, "ready");
      database.exec("COMMIT");
      this.work.delta = work;
      return work;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      captured.close();
      delta.database = null;
    }
  }

  publish(source, prepared, identity, calendar) {
    ensureUsageAllSummarySchema(prepared.query.database, { mode: "history" });
    ensureUsageRecordSchema(prepared.query.database, { mode: "history" });
    if (!sameHistoryProjectionStamp(readHistoryProjectionStamp(source), prepared.stamp)) {
      if (prepared.rebuilding) saveHeader(prepared.query, identity, prepared.stamp, calendar, "ready");
      this.work.superseded = true;
      return prepared.query;
    }
    if (prepared.reused) return prepared.query;
    if (prepared.delta && !prepared.rebuilding) return prepared.query;
    const certified = certifyHistoryProjectionBaseline(source, prepared.stamp);
    if (!certified)
      throw Object.assign(new Error("History inputs changed before projection publication"), {
        code: "HISTORY_PROJECTION_INPUT_CHANGED",
      });
    prepared.query.database.exec("BEGIN IMMEDIATE");
    try {
      saveHeader(prepared.query, identity, certified, calendar, "ready");
      prepared.query.database.exec("COMMIT");
    } catch (error) {
      prepared.query.database.exec("ROLLBACK");
      throw error;
    }
    const file = this.candidateFile;
    writePointer(this.directory, "current.json", file);
    rmSync(path.join(this.directory, "candidate.json"), { force: true });
    this.query?.close();
    this.query = prepared.query;
    this.file = file;
    this.candidateFile = null;
    prepared.stamp = certified;
    this.cleanup();
    return this.query;
  }

  cleanup() {
    const keep = new Set([this.file, this.candidateFile]);
    for (const file of readdirSync(this.directory)) {
      if (/^projection-[a-f0-9-]{36}\.sqlite$/.test(file) && !keep.has(file)) {
        try {
          removeCacheFile(path.join(this.directory, file));
        } catch (error) {
          if (!["EBUSY", "EPERM", "EACCES"].includes(error.code)) throw error;
        }
      }
    }
  }

  close() {
    this.query?.close();
    this.query = null;
    this.file = null;
    this.verificationDatabase = null;
  }
}
