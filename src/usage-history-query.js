import { DatabaseSync } from "node:sqlite";
import { UsageSourceRows } from "./usage-source-rows.js";

const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;
const COPIED_TABLES = new Set([
  "store_meta",
  "source_files",
  "archive_segments",
  "rate_limit_observations",
  "quota_usage_sources",
  "usage_business_revision",
]);

/** Disposable disk facts; neither source database nor sealed packages are modified. */
export class UsageHistoryQuery {
  constructor(source, canonicalPayload) {
    this.database = new DatabaseSync("");
    this.canonicalPayload = canonicalPayload;
    this.rows = 0;
    try {
      this.database.exec(
        "PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF",
      );
      source.exec("SAVEPOINT history_query_capture");
      try {
        const tables = source
          .prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all();
        for (const { name, sql } of tables) {
          this.database.exec(String(sql));
          if (!COPIED_TABLES.has(String(name))) continue;
          // Quota classification resolves equal timestamps by rowid, including gaps and negative ids.
          const read = source.prepare(`SELECT ${name === "quota_usage_sources" ? "rowid,*" : "*"} FROM ${quote(name)}`);
          const columns = read.columns().map(({ name }) => quote(name));
          read.setReturnArrays(true);
          const write = this.database.prepare(
            `INSERT INTO ${quote(name)} (${columns}) VALUES (${columns.map(() => "?")})`,
          );
          this.database.exec("BEGIN");
          for (const row of read.iterate()) write.run(...row);
          this.database.exec("COMMIT");
        }
        this.database.exec(`CREATE TABLE history_query_rows (
          timestamp_ms INTEGER NOT NULL, payload TEXT NOT NULL, segment_id TEXT NOT NULL
        ); CREATE INDEX history_query_segment ON history_query_rows(segment_id)`);
        this.insert = this.database.prepare("INSERT INTO history_query_rows VALUES (?,?,?)");
        this.database.exec("BEGIN");
        this.add(source.prepare("SELECT * FROM events ORDER BY id").iterate(), "hot");
        this.database.exec("COMMIT");
        const indexes = source.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all();
        for (const { sql } of indexes) this.database.exec(String(sql));
      } finally {
        source.exec("RELEASE history_query_capture");
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  add(rows, segmentId) {
    for (const row of rows) {
      const payload = JSON.stringify(this.canonicalPayload(row, ["id"]));
      this.insert.run(Number(row.timestamp_ms), payload, segmentId);
      this.rows++;
    }
  }

  remove(segmentId, payload, count) {
    const removed = this.database
      .prepare(`DELETE FROM history_query_rows WHERE rowid IN (
      SELECT rowid FROM history_query_rows WHERE segment_id=? AND payload=? LIMIT ?
    )`)
      .run(segmentId, JSON.stringify(this.canonicalPayload(payload, ["id"])), count);
    return Number(removed.changes);
  }

  finish(columns, project = (row) => row) {
    const write = this.database.prepare(
      `INSERT INTO events (${columns.map(quote)}) VALUES (${columns.map(() => "?")})`,
    );
    this.sortStats = { peakMemoryBytes: 0, peakScratchBytes: 0, spilled: false, sortRuns: 0, mergePasses: 0 };
    let group = new UsageSourceRows(2 * 1024 * 1024);
    const flush = () => {
      try {
        for (const payload of group.ordered((a,b) => a<b?-1:a>b?1:0)) {
          const row = project(JSON.parse(payload));
          write.run(...columns.map((name) => row[name]));
        }
      } finally {
        group.close();
        const stats = group.stats;
        this.sortStats.peakMemoryBytes = Math.max(this.sortStats.peakMemoryBytes,stats.peakMemoryBytes);
        this.sortStats.peakScratchBytes = Math.max(this.sortStats.peakScratchBytes,stats.peakScratchBytes);
        this.sortStats.spilled ||= stats.spilled;
        this.sortStats.sortRuns += stats.sortRuns;
        this.sortStats.mergePasses += stats.mergePasses;
      }
    };
    try {
      // Numeric timestamp order needs only a small index; full payload comparison is necessary only within ties.
      this.database.exec("CREATE INDEX history_query_time ON history_query_rows(timestamp_ms); BEGIN");
      let time;
      for (const row of this.database.prepare("SELECT rowid,timestamp_ms,payload FROM history_query_rows ORDER BY timestamp_ms,rowid").iterate()) {
        if (time !== undefined && time !== row.timestamp_ms) { flush(); group = new UsageSourceRows(2 * 1024 * 1024); }
        time = row.timestamp_ms;
        group.set(String(row.rowid),String(row.payload));
      }
      flush();
      this.database.exec("DROP TABLE history_query_rows; COMMIT");
    } finally { group.close(); }
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
