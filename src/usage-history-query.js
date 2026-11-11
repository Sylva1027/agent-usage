import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { UsageSourceRows } from "./usage-source-rows.js";
import { createUsageRollups, USAGE_ROLLUP_PROGRESS_TABLES } from "./usage-rollups.js";

const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;
const COPIED_TABLES = new Set([
  "store_meta",
  "source_files",
  "archive_segments",
  "rate_limit_observations",
  "quota_usage_sources",
  "usage_business_revision",
  // Its validated table format lets metadata retain the bulk-built event index.
  "usage_metadata_format",
]);
const ROLLUP_TABLES = new Set([
  "usage_rollup_daily",
  "usage_rollup_models",
  "usage_rollup_repositories",
  "usage_rollup_sessions",
  "usage_rollup_days",
  "usage_rollup_dirty_days",
  "usage_rollup_format",
]);
const ROLLUP_SCHEMA_TABLES = new Set([...ROLLUP_TABLES, ...USAGE_ROLLUP_PROGRESS_TABLES]);

/** Disposable disk facts; neither source database nor sealed packages are modified. */
export class UsageHistoryQuery {
  /** @param {{databaseFile?: string, existing?: boolean, calendar?: string}} [options] */
  constructor(source, canonicalPayload, options = {}) {
    this.persistent = Boolean(options.databaseFile);
    if (options.existing && (!this.persistent || !existsSync(options.databaseFile)))
      throw new Error("Existing history query file is missing");
    this.database = new DatabaseSync(options.databaseFile || "");
    this.canonicalPayload = canonicalPayload;
    this.rows = 0;
    try {
      this.database.exec(
        `PRAGMA busy_timeout=5000; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE;
        PRAGMA journal_mode=${this.persistent ? "WAL" : "OFF"};
        PRAGMA synchronous=${this.persistent ? "FULL" : "OFF"}`,
      );
      // Keep FULL WAL durability while checkpointing the unpublished bulk build only once.
      if (this.persistent && (!options.existing || this.pendingIndexes()))
        this.database.exec("PRAGMA wal_autocheckpoint=0");
      if (options.existing) {
        this.prepareWrites();
        return;
      }
      source.exec("SAVEPOINT history_query_capture");
      try {
        this.database.exec("BEGIN IMMEDIATE");
        const copyRollups = this.persistent && Boolean(options.calendar);
        const copyLocal =
          copyRollups &&
          source.prepare("SELECT value FROM store_meta WHERE key=?").get("usage_rollup_local_zone_identity")?.value ===
            options.calendar;
        const tables = source
          .prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all();
        for (const { name, sql } of tables) {
          if (copyRollups && ROLLUP_SCHEMA_TABLES.has(String(name))) continue;
          this.database.exec(String(sql));
        }
        let rollupTriggers = [];
        if (copyRollups) {
          createUsageRollups(this.database);
          rollupTriggers = this.database
            .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'usage_rollup_%'")
            .all();
          for (const { name } of rollupTriggers) this.database.exec(`DROP TRIGGER ${quote(name)}`);
        }
        for (const { name } of tables) {
          const rollup = copyRollups && ROLLUP_TABLES.has(String(name));
          if (rollup && name === "usage_rollup_format") continue;
          if (!COPIED_TABLES.has(String(name)) && !rollup) continue;
          // Quota classification resolves equal timestamps by rowid, including gaps and negative ids.
          const scoped =
            rollup && !copyLocal && !["usage_rollup_dirty_days", "usage_rollup_format"].includes(String(name));
          const read = source.prepare(
            `SELECT ${name === "quota_usage_sources" ? "rowid,*" : "*"} FROM ${quote(name)}${scoped ? " WHERE calendar_zone='utc'" : ""}`,
          );
          const columns = read.columns().map(({ name }) => quote(name));
          read.setReturnArrays(true);
          const write = this.database.prepare(
            `INSERT INTO ${quote(name)} (${columns}) VALUES (${columns.map(() => "?")})`,
          );
          for (const row of read.iterate()) write.run(...row);
        }
        if (this.persistent)
          this.database.exec("ALTER TABLE events ADD COLUMN history_ordinal INTEGER NOT NULL DEFAULT 0");
        this.database.exec(`CREATE TABLE history_query_rows (
          timestamp_ms INTEGER NOT NULL, payload TEXT NOT NULL, segment_id TEXT NOT NULL
          ${this.persistent ? ", source_path TEXT NOT NULL, event_id INTEGER" : ""}
        ); CREATE INDEX history_query_segment ON history_query_rows(segment_id)`);
        if (this.persistent)
          this.database.exec(`CREATE INDEX history_query_source ON history_query_rows(segment_id,source_path);
            CREATE INDEX history_query_time ON history_query_rows(timestamp_ms);
            CREATE TABLE history_query_pending_indexes(sql TEXT PRIMARY KEY) STRICT;
            CREATE TABLE history_query_changes (
              timestamp_ms INTEGER PRIMARY KEY, added INTEGER NOT NULL, removed INTEGER NOT NULL, scanned INTEGER NOT NULL
            )`);
        this.prepareWrites();
        for (const { sql } of rollupTriggers)
          this.database.prepare("INSERT INTO history_query_pending_indexes VALUES(?)").run(String(sql));
        this.add(source.prepare("SELECT * FROM events ORDER BY id").iterate(), "hot");
        const indexes = source
          .prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
          .all();
        for (const { name, sql } of indexes) {
          if (this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name)) continue;
          if (this.persistent && /\bON\s+"?events"?\s*\(/i.test(String(sql)))
            this.database.prepare("INSERT INTO history_query_pending_indexes VALUES(?)").run(String(sql));
          else this.database.exec(String(sql));
        }
        if (this.persistent)
          this.database
            .prepare("INSERT INTO history_query_pending_indexes VALUES(?)")
            .run("CREATE INDEX history_query_order ON events(timestamp_ms,history_ordinal)");
        this.database.exec("COMMIT");
      } finally {
        source.exec("RELEASE history_query_capture");
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  prepareWrites() {
    this.insert = this.database.prepare(
      this.persistent
        ? "INSERT INTO history_query_rows(timestamp_ms,payload,segment_id,source_path) VALUES (?,?,?,?)"
        : "INSERT INTO history_query_rows VALUES (?,?,?)",
    );
    if (this.persistent)
      this.recordChange = this.database.prepare(`INSERT INTO history_query_changes VALUES (?,?,?,?)
        ON CONFLICT(timestamp_ms) DO UPDATE SET added=added+excluded.added,
          removed=removed+excluded.removed, scanned=scanned+excluded.scanned`);
  }

  add(rows, segmentId) {
    const initial = this.persistent && this.pendingIndexes();
    for (const row of rows) {
      const payload = JSON.stringify(this.canonicalPayload(row, this.persistent ? ["id", "history_ordinal"] : ["id"]));
      const ms = Number(row.timestamp_ms);
      if (this.persistent) {
        this.insert.run(ms, payload, segmentId, String(row.source_path));
        if (!initial) this.recordChange.run(ms, 1, 0, 1);
      } else this.insert.run(ms, payload, segmentId);
      this.rows++;
    }
  }

  remove(segmentId, payload, count) {
    if (this.persistent) {
      if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("Invalid history removal count");
      this.database.exec("SAVEPOINT history_query_remove");
      try {
        this.database.exec("CREATE TEMP TABLE history_query_removed(raw_id INTEGER PRIMARY KEY)");
        this.database
          .prepare(`INSERT INTO history_query_removed SELECT rowid FROM history_query_rows
            WHERE segment_id=? AND payload=? ORDER BY rowid LIMIT ?`)
          .run(segmentId, JSON.stringify(this.canonicalPayload(payload, ["id", "history_ordinal"])), count);
        const removed = this.removeStaged();
        this.database.exec("DROP TABLE history_query_removed; RELEASE history_query_remove");
        return removed;
      } catch (error) {
        this.database.exec("ROLLBACK TO history_query_remove; RELEASE history_query_remove");
        throw error;
      }
    }
    const removed = this.database
      .prepare(`DELETE FROM history_query_rows WHERE rowid IN (
      SELECT rowid FROM history_query_rows WHERE segment_id=? AND payload=? LIMIT ?
    )`)
      .run(segmentId, JSON.stringify(this.canonicalPayload(payload, ["id"])), count);
    return Number(removed.changes);
  }

  removeStaged() {
    this.database.exec(`INSERT INTO history_query_changes
      SELECT timestamp_ms,0,COUNT(*),COUNT(*) FROM history_query_rows
      WHERE rowid IN (SELECT raw_id FROM history_query_removed) GROUP BY timestamp_ms
      ON CONFLICT(timestamp_ms) DO UPDATE SET removed=removed+excluded.removed, scanned=scanned+excluded.scanned;
      DELETE FROM events WHERE id IN (
        SELECT event_id FROM history_query_rows WHERE rowid IN (SELECT raw_id FROM history_query_removed)
      )`);
    return Number(
      this.database
        .prepare("DELETE FROM history_query_rows WHERE rowid IN (SELECT raw_id FROM history_query_removed)")
        .run().changes,
    );
  }

  /** Exact source multiset difference; scratch tables and change markers follow the caller's transaction. */
  replaceRows(segmentId, sourcePath, rows) {
    if (!this.persistent) throw new Error("Replacing history rows requires a persistent query");
    this.database.exec("SAVEPOINT history_query_replace");
    try {
      this.database.exec(`CREATE TEMP TABLE history_query_incoming (
        payload TEXT PRIMARY KEY, timestamp_ms INTEGER NOT NULL, remaining INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TEMP TABLE history_query_removed(raw_id INTEGER PRIMARY KEY)`);
      const stage = this.database.prepare(`INSERT INTO history_query_incoming VALUES (?,?,1)
        ON CONFLICT(payload) DO UPDATE SET remaining=remaining+1`);
      let scanned = 0,
        firstMs = Infinity;
      for (const row of rows) {
        if (row.source_path !== sourcePath) throw new Error("History replacement source does not match");
        const ms = Number(row.timestamp_ms);
        stage.run(JSON.stringify(this.canonicalPayload(row, ["id", "history_ordinal"])), ms);
        scanned++;
        firstMs = Math.min(firstMs, ms);
      }
      const match = this.database.prepare(
        "UPDATE history_query_incoming SET remaining=remaining-1 WHERE payload=? AND remaining>0",
      );
      const discard = this.database.prepare("INSERT INTO history_query_removed VALUES (?)");
      for (const row of this.database
        .prepare(
          "SELECT rowid,timestamp_ms,payload FROM history_query_rows WHERE segment_id=? AND source_path=? ORDER BY rowid",
        )
        .iterate(segmentId, sourcePath)) {
        if (!match.run(row.payload).changes) discard.run(row.rowid);
        scanned++;
        firstMs = Math.min(firstMs, Number(row.timestamp_ms));
      }
      const removed = this.removeStaged();
      let added = 0;
      for (const row of this.database
        .prepare("SELECT payload,timestamp_ms,remaining FROM history_query_incoming WHERE remaining>0")
        .iterate()) {
        for (let index = 0; index < Number(row.remaining); index++) {
          this.insert.run(row.timestamp_ms, row.payload, segmentId, sourcePath);
          this.recordChange.run(row.timestamp_ms, 1, 0, 1);
          added++;
        }
      }
      // Matched input/raw pairs count as scans without marking their timestamp dirty.
      if (scanned > added + removed) this.recordChange.run(firstMs, 0, 0, scanned - added - removed);
      this.database.exec(
        "DROP TABLE history_query_incoming; DROP TABLE history_query_removed; RELEASE history_query_replace",
      );
      return { added, removed, scanned };
    } catch (error) {
      this.database.exec("ROLLBACK TO history_query_replace; RELEASE history_query_replace");
      throw error;
    }
  }

  /** scanned counts input/raw candidates; sorted counts retained rows in changed timestamp groups. */
  finishChanges(columns, project = (row) => row) {
    if (!this.persistent) throw new Error("Finishing history changes requires a persistent query");
    this.database.exec("SAVEPOINT history_query_finish");
    this.sortStats = { peakMemoryBytes: 0, peakScratchBytes: 0, spilled: false, sortRuns: 0, mergePasses: 0 };
    let released = false;
    try {
      const initial = this.pendingIndexes();
      if (initial)
        this.database.exec(`DELETE FROM history_query_changes;
        INSERT INTO history_query_changes SELECT timestamp_ms,COUNT(*),0,COUNT(*)
        FROM history_query_rows GROUP BY timestamp_ms`);
      const counts = this.database
        .prepare(
          "SELECT SUM(added) AS added,SUM(removed) AS removed,SUM(scanned) AS scanned FROM history_query_changes",
        )
        .get();
      const write = this.database.prepare(
        `INSERT INTO events (${[...columns, "history_ordinal"].map(quote)}) VALUES (${[...columns, "history_ordinal"].map(() => "?")})`,
      );
      const link = this.database.prepare("UPDATE history_query_rows SET event_id=? WHERE rowid=?");
      const reorder = this.database.prepare("UPDATE events SET history_ordinal=? WHERE id=? AND history_ordinal<>?");
      let dirty = null,
        sorted = 0,
        time,
        first = null,
        group = null;
      const materialize = (item, ordinal) => {
        if (item.eventId === null) {
          const row = project(JSON.parse(item.payload));
          const event = write.run(...columns.map((name) => row[name]), ordinal);
          link.run(event.lastInsertRowid, item.rawId);
        } else reorder.run(ordinal, item.eventId, ordinal);
      };
      const flush = () => {
        if (!group) {
          if (first) materialize(first, 0);
          first = null;
          return;
        }
        try {
          let ordinal = 0;
          for (const item of group.ordered(
            (a, b) => (a < b ? -1 : a > b ? 1 : 0),
            (item) => item.payload,
          )) {
            materialize(item, ordinal);
            ordinal++;
          }
        } finally {
          group.close();
          const stats = group.stats;
          this.sortStats.peakMemoryBytes = Math.max(this.sortStats.peakMemoryBytes, stats.peakMemoryBytes);
          this.sortStats.peakScratchBytes = Math.max(this.sortStats.peakScratchBytes, stats.peakScratchBytes);
          this.sortStats.spilled ||= stats.spilled;
          this.sortStats.sortRuns += stats.sortRuns;
          this.sortStats.mergePasses += stats.mergePasses;
          group = null;
          first = null;
        }
      };
      try {
        // One ordered cursor avoids a separate SQL lookup for every timestamp on initial construction.
        for (const row of this.database
          .prepare(`SELECT rowid,timestamp_ms,payload,event_id FROM history_query_rows
          WHERE timestamp_ms IN (SELECT timestamp_ms FROM history_query_changes WHERE added<>0 OR removed<>0)
          ORDER BY timestamp_ms,rowid`)
          .iterate()) {
          if (time !== undefined && time !== row.timestamp_ms) {
            flush();
          }
          time = row.timestamp_ms;
          dirty ??= { ms: Number(time), id: Number.MIN_SAFE_INTEGER };
          const item = { rawId: row.rowid, payload: String(row.payload), eventId: row.event_id };
          this.sortStats.peakMemoryBytes = Math.max(this.sortStats.peakMemoryBytes, 384 + item.payload.length * 2);
          if (!first) first = item;
          else {
            if (!group) {
              group = new UsageSourceRows(2 * 1024 * 1024);
              group.set(String(first.rawId), first);
            }
            group.set(String(row.rowid), item);
          }
          sorted++;
        }
        flush();
      } finally {
        group?.close();
      }
      const firstChange = this.database
        .prepare("SELECT MIN(timestamp_ms) AS ms FROM history_query_changes WHERE added<>0 OR removed<>0")
        .get();
      if (firstChange.ms !== null && (!dirty || Number(firstChange.ms) < dirty.ms))
        dirty = { ms: Number(firstChange.ms), id: Number.MIN_SAFE_INTEGER };
      if (initial) {
        // Restore schema after bulk loading; fresh progress is certified against these physical event ids.
        for (const { sql } of this.database.prepare("SELECT sql FROM history_query_pending_indexes ORDER BY sql").all())
          this.database.exec(String(sql));
        this.database.exec("DROP TABLE history_query_pending_indexes");
      }
      this.database.exec("DELETE FROM history_query_changes; RELEASE history_query_finish");
      released = true;
      if (initial) {
        if (!this.database.isTransaction) this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        this.database.exec("PRAGMA wal_autocheckpoint=1000");
      }
      return {
        added: Number(counts.added),
        removed: Number(counts.removed),
        scanned: Number(counts.scanned),
        sorted,
        dirty,
      };
    } catch (error) {
      if (!released) this.database.exec("ROLLBACK TO history_query_finish; RELEASE history_query_finish");
      throw error;
    }
  }

  pendingIndexes() {
    return Boolean(
      this.database.prepare("SELECT 1 FROM sqlite_master WHERE name='history_query_pending_indexes'").get(),
    );
  }

  finish(columns, project = (row) => row) {
    if (this.persistent) {
      // Mappings and dirty markers commit together; retrying a completed initial build does no event writes.
      this.finishChanges(columns, project);
      return this.database;
    }
    const write = this.database.prepare(
      `INSERT INTO events (${columns.map(quote)}) VALUES (${columns.map(() => "?")})`,
    );
    this.sortStats = { peakMemoryBytes: 0, peakScratchBytes: 0, spilled: false, sortRuns: 0, mergePasses: 0 };
    let group = new UsageSourceRows(2 * 1024 * 1024);
    const flush = () => {
      try {
        for (const payload of group.ordered((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
          const row = project(JSON.parse(payload));
          write.run(...columns.map((name) => row[name]));
        }
      } finally {
        group.close();
        const stats = group.stats;
        this.sortStats.peakMemoryBytes = Math.max(this.sortStats.peakMemoryBytes, stats.peakMemoryBytes);
        this.sortStats.peakScratchBytes = Math.max(this.sortStats.peakScratchBytes, stats.peakScratchBytes);
        this.sortStats.spilled ||= stats.spilled;
        this.sortStats.sortRuns += stats.sortRuns;
        this.sortStats.mergePasses += stats.mergePasses;
      }
    };
    try {
      // Numeric timestamp order needs only a small index; full payload comparison is necessary only within ties.
      this.database.exec("CREATE INDEX history_query_time ON history_query_rows(timestamp_ms); BEGIN");
      let time;
      for (const row of this.database
        .prepare("SELECT rowid,timestamp_ms,payload FROM history_query_rows ORDER BY timestamp_ms,rowid")
        .iterate()) {
        if (time !== undefined && time !== row.timestamp_ms) {
          flush();
          group = new UsageSourceRows(2 * 1024 * 1024);
        }
        time = row.timestamp_ms;
        group.set(String(row.rowid), String(row.payload));
      }
      flush();
      this.database.exec("DROP TABLE history_query_rows; COMMIT");
    } finally {
      group.close();
    }
    return this.database;
  }

  get bytes() {
    return (
      Number(this.database.prepare("PRAGMA page_count").get().page_count) *
      Number(this.database.prepare("PRAGMA page_size").get().page_size)
    );
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}
