import { DatabaseSync } from "node:sqlite";
import { deserialize, serialize } from "node:v8";

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

// Include decoded objects and Map/array entries, not just the serialized disk bytes.
function estimatedBytes(key, value) {
  return 384 + key.length * 2 + (JSON.stringify(value)?.length || 0) * 2;
}

/** A byte-budgeted insertion-ordered map of string keys and JSON records. */
export class UsageSourceRows {
  constructor(maxBytes = DEFAULT_MAX_BYTES) {
    if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new RangeError("Invalid source rows byte budget");
    this.maxBytes = maxBytes;
    this.entries = new Map();
    this.bytes = 0;
    this.count = 0;
    this.database = null;
    this.read = null;
    this.write = null;
    this.closed = false;
    this.peakMemoryBytes = 0;
    this.peakScratchBytes = 0;
    this.spilled = false;
    this.sortRuns = 0;
    this.mergePasses = 0;
    this.pending = null;
  }

  get stats() {
    return {
      peakMemoryBytes: this.peakMemoryBytes,
      peakScratchBytes: this.peakScratchBytes,
      spilled: this.spilled,
      sortRuns: this.sortRuns,
      mergePasses: this.mergePasses,
    };
  }

  get size() {
    this.flushPending();
    return this.count;
  }

  get(key) {
    if (!this.database) return this.entries.get(key)?.value;
    if (this.pending?.key === key) return this.pending.value;
    const payload = this.read.get(JSON.stringify(key))?.payload;
    return payload === undefined ? undefined : deserialize(/** @type {Uint8Array} */ (payload));
  }

  set(key, value) {
    if (this.closed) throw new Error("Source rows are closed");
    const bytes = estimatedBytes(key, value);
    this.peakMemoryBytes = Math.max(this.peakMemoryBytes, this.bytes + bytes);
    if (!this.database) {
      const previous = this.entries.get(key);
      const nextBytes = this.bytes + bytes - (previous?.bytes || 0);
      if (nextBytes <= this.maxBytes) {
        this.entries.set(key, { value, bytes });
        this.bytes = nextBytes;
        this.count = this.entries.size;
        return this;
      }
      this.spill();
    }
    if (this.pending?.key !== key) this.flushPending();
    this.pending = { key, value };
    return this;
  }

  flushPending() {
    if (!this.pending) return;
    const { key, value } = this.pending;
    const row = this.write.get(this.count, JSON.stringify(key), serialize(value));
    if (row.ordinal === this.count) this.count += 1;
    this.pending = null;
  }

  spill() {
    this.database = new DatabaseSync("");
    this.spilled = true;
    try {
      // Journaling/durability are unnecessary for anonymous, disposable data rebuilt from the source.
      this.database.exec(`PRAGMA cache_size=-256; PRAGMA temp_store=FILE;
        PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
        CREATE TABLE source_rows(ordinal INTEGER PRIMARY KEY, key TEXT UNIQUE NOT NULL, payload BLOB NOT NULL);
        CREATE TABLE sort_runs(pass INTEGER, run INTEGER, position INTEGER, ordinal INTEGER, sort_key BLOB,
          PRIMARY KEY(pass,run,position)) WITHOUT ROWID;
        BEGIN`);
      this.read = this.database.prepare("SELECT payload FROM source_rows WHERE key=?");
      this.write = this.database.prepare(`INSERT INTO source_rows VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET payload=excluded.payload RETURNING ordinal`);
      let ordinal = 0;
      for (const [key, entry] of this.entries) this.write.get(ordinal++, JSON.stringify(key), serialize(entry.value));
      this.entries.clear();
      this.bytes = 0;
      this.sampleScratch();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  sampleScratch() {
    const pages = Number(this.database.prepare("PRAGMA page_count").get().page_count);
    const pageSize = Number(this.database.prepare("PRAGMA page_size").get().page_size);
    this.peakScratchBytes = Math.max(this.peakScratchBytes, pages * pageSize);
  }

  *values() {
    this.flushPending();
    if (this.database) {
      for (const row of this.database.prepare("SELECT payload FROM source_rows ORDER BY ordinal").iterate()) {
        yield deserialize(/** @type {Uint8Array} */ (row.payload));
      }
    } else {
      for (const entry of this.entries.values()) yield entry.value;
    }
  }

  /** Stable JavaScript comparison; SQLite only stores runs and insertion ordinals. */
  *ordered(compare, keyFor = (value) => value) {
    this.flushPending();
    const stableCompare = (left, right) => compare(left.value, right.value) || left.ordinal - right.ordinal;
    if (!this.database) {
      const chunk = [];
      let ordinal = 0;
      for (const entry of this.entries.values())
        chunk.push({ ordinal: ordinal++, value: keyFor(entry.value), event: entry.value });
      this.peakMemoryBytes = Math.max(this.peakMemoryBytes, this.bytes * 2);
      chunk.sort(stableCompare);
      for (const row of chunk) yield row.event;
      return;
    }

    this.sampleScratch();
    this.database.exec("DELETE FROM sort_runs");
    const insert = this.database.prepare("INSERT INTO sort_runs VALUES (?,?,?,?,?)");
    const readRunSql = "SELECT ordinal,sort_key FROM sort_runs WHERE pass=? AND run=? ORDER BY position";
    // Concurrent SQLite iterators need separate statements; reusing one invalidates the first cursor.
    const readLeft = this.database.prepare(readRunSql),
      readRight = this.database.prepare(readRunSql);
    let chunk = [],
      chunkBytes = 0,
      runCount = 0;
    const flush = () => {
      chunk.sort(stableCompare);
      for (let position = 0; position < chunk.length; position += 1) {
        insert.run(0, runCount, position, chunk[position].ordinal, serialize(chunk[position].value));
      }
      runCount += 1;
      chunk = [];
      chunkBytes = 0;
    };
    try {
      for (const row of this.database.prepare("SELECT ordinal,payload FROM source_rows ORDER BY ordinal").iterate()) {
        const value = keyFor(deserialize(/** @type {Uint8Array} */ (row.payload)));
        const bytes = estimatedBytes("", value) - 256;
        this.peakMemoryBytes = Math.max(this.peakMemoryBytes, chunkBytes + bytes);
        if (chunk.length && chunkBytes + bytes > this.maxBytes) flush();
        chunk.push({ ordinal: row.ordinal, value });
        chunkBytes += bytes;
        this.peakMemoryBytes = Math.max(this.peakMemoryBytes, chunkBytes);
      }
      if (chunk.length) flush();
      this.sortRuns = Math.max(this.sortRuns, runCount);
      this.sampleScratch();
      let pass = 0;
      while (runCount > 1) {
        for (let run = 0; run < runCount; run += 2) {
          const left = readLeft.iterate(pass, run),
            right = readRight.iterate(pass, run + 1);
          const take = (iterator) => {
            const next = iterator.next();
            if (next.done) return null;
            const value = deserialize(/** @type {Uint8Array} */ (next.value.sort_key));
            return {
              ordinal: next.value.ordinal,
              value,
              payload: next.value.sort_key,
              bytes: estimatedBytes("", value) - 256,
            };
          };
          try {
            let a = take(left),
              b = take(right),
              position = 0;
            while (a || b) {
              this.peakMemoryBytes = Math.max(this.peakMemoryBytes, (a?.bytes || 0) + (b?.bytes || 0));
              if (!b || (a && stableCompare(a, b) <= 0)) {
                insert.run(1 - pass, run / 2, position++, a.ordinal, a.payload);
                a = take(left);
              } else {
                insert.run(1 - pass, run / 2, position++, b.ordinal, b.payload);
                b = take(right);
              }
            }
          } finally {
            left.return?.();
            right.return?.();
          }
        }
        // Sample before deleting the input runs: both sides of the merge consume scratch space.
        this.sampleScratch();
        this.database.prepare("DELETE FROM sort_runs WHERE pass=?").run(pass);
        pass = 1 - pass;
        runCount = Math.ceil(runCount / 2);
        this.mergePasses += 1;
      }
      for (const row of this.database
        .prepare(`SELECT s.payload FROM sort_runs r
        JOIN source_rows s ON s.ordinal=r.ordinal WHERE r.pass=? AND r.run=0 ORDER BY r.position`)
        .iterate(pass)) {
        yield deserialize(/** @type {Uint8Array} */ (row.payload));
      }
    } finally {
      this.sampleScratch();
      this.database.exec("DELETE FROM sort_runs");
    }
  }

  close() {
    if (this.closed) return;
    try {
      if (this.database) {
        try {
          this.sampleScratch();
        } finally {
          this.database.close();
        }
      }
    } finally {
      this.database = null;
      this.read = null;
      this.write = null;
      this.entries.clear();
      this.bytes = 0;
      this.count = 0;
      this.closed = true;
      this.pending = null;
    }
  }
}

/** Use an upstream binary TEXT key when it has exactly the same identity semantics as Map. */
export function indexedSourceSessions(database, table, columns) {
  const key = database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .filter((column) => Number(column.pk));
  if (key.length !== 1 || key[0].name !== "id" || String(key[0].type).toUpperCase() !== "TEXT") return null;
  const primary = database
    .prepare(`PRAGMA index_list(${table})`)
    .all()
    .find((index) => index.origin === "pk");
  if (!primary) return null;
  const indexed = database.prepare("SELECT name,coll FROM pragma_index_xinfo(?) WHERE key=1").all(primary.name);
  if (indexed.length !== 1 || indexed[0].name !== "id" || indexed[0].coll !== "BINARY") return null;
  // SQLite can store NULL/BLOB even in a TEXT primary key; the legacy map coerces these keys.
  if (database.prepare(`SELECT 1 FROM ${table} WHERE typeof(id)<>'text' LIMIT 1`).get()) return null;
  const read = database.prepare(`SELECT ${columns} FROM ${table} WHERE id=? COLLATE BINARY`);
  const size = database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() ? 1 : 0;
  let lastKey, lastRow;
  return {
    size,
    get(id) {
      if (id !== lastKey) {
        lastRow = read.get(id);
        lastKey = id;
      }
      return lastRow;
    },
    close() {},
  };
}
