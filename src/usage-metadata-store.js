const FORMAT_VERSION = 2;
const DEFAULT_BATCH_SIZE = 1024;
const MAX_BATCH_SIZE = 10_000;
const FORMAT_TABLE = "usage_metadata_format";
const STATE_TABLE = "usage_metadata_state";
const HOMES_TABLE = "usage_metadata_homes";
const SESSIONS_TABLE = "usage_metadata_sessions";
const HOME_SESSIONS_TABLE = "usage_metadata_home_sessions";
const MODELS_TABLE = "usage_metadata_models";
const OBSERVATIONS_TABLE = "usage_metadata_observations";
const DIRTY_TABLE = "usage_metadata_dirty";
const GROUP_TIME_INDEX = "events_metadata_group_time_idx";
const SCHEMA_SAVEPOINT = "usage_metadata_schema_setup";
const INITIAL_EVENT_ID = Number.MIN_SAFE_INTEGER;
const TRIGGERS = [
  "usage_metadata_dirty_insert_before",
  "usage_metadata_dirty_insert_after",
  "usage_metadata_dirty_update",
  "usage_metadata_dirty_delete",
];
const GROUP_TIME_INDEX_SQL = `CREATE INDEX ${GROUP_TIME_INDEX}
  ON events(home_id, channel, model, timestamp_ms)`;
const TRIGGER_SQL = [
  `CREATE TRIGGER ${TRIGGERS[0]}
  BEFORE INSERT ON events
  WHEN EXISTS (
    SELECT 1 FROM ${STATE_TABLE}
    WHERE singleton = 1 AND EXISTS (SELECT 1 FROM events WHERE id = NEW.id)
  )
  BEGIN
    INSERT OR IGNORE INTO ${DIRTY_TABLE} VALUES (1);
  END`,
  `CREATE TRIGGER ${TRIGGERS[1]}
  AFTER INSERT ON events
  WHEN EXISTS (
    SELECT 1 FROM ${STATE_TABLE}
    WHERE singleton = 1 AND NEW.id <= last_event_id
  )
  BEGIN
    INSERT OR IGNORE INTO ${DIRTY_TABLE} VALUES (1);
  END`,
  `CREATE TRIGGER ${TRIGGERS[2]}
  AFTER UPDATE ON events
  WHEN EXISTS (SELECT 1 FROM ${STATE_TABLE} WHERE singleton = 1)
  BEGIN
    INSERT OR IGNORE INTO ${DIRTY_TABLE} VALUES (1);
  END`,
  `CREATE TRIGGER ${TRIGGERS[3]}
  AFTER DELETE ON events
  WHEN EXISTS (SELECT 1 FROM ${STATE_TABLE} WHERE singleton = 1)
  BEGIN
    INSERT OR IGNORE INTO ${DIRTY_TABLE} VALUES (1);
  END`,
];
const TABLE_DEFINITIONS = new Map([
  [FORMAT_TABLE, { columns: ["singleton", "version", "schema_version"], primaryKey: ["singleton"] }],
  [
    STATE_TABLE,
    {
      columns: [
        "singleton",
        "status",
        "target_revision",
        "published_revision",
        "last_event_id",
        "event_count",
        "session_count",
        "max_timestamp_ms",
      ],
      primaryKey: ["singleton"],
    },
  ],
  [HOMES_TABLE, { columns: ["home_id", "event_count", "session_count"], primaryKey: ["home_id"] }],
  [SESSIONS_TABLE, { columns: ["session_id"], primaryKey: ["session_id"] }],
  [HOME_SESSIONS_TABLE, { columns: ["home_id", "session_id"], primaryKey: ["home_id", "session_id"] }],
  [MODELS_TABLE, { columns: ["channel", "model"], primaryKey: ["channel", "model"] }],
  [
    OBSERVATIONS_TABLE,
    {
      columns: ["channel", "model", "home_id", "last_seen"],
      primaryKey: ["channel", "model", "home_id"],
    },
  ],
  [DIRTY_TABLE, { columns: ["singleton"], primaryKey: ["singleton"] }],
]);
const EVENT_COLUMNS = ["id", "timestamp_ms", "session_id", "home_id", "channel", "model"];

export const USAGE_METADATA_TABLE_NAMES = Object.freeze([
  FORMAT_TABLE,
  STATE_TABLE,
  HOMES_TABLE,
  SESSIONS_TABLE,
  HOME_SESSIONS_TABLE,
  MODELS_TABLE,
  OBSERVATIONS_TABLE,
  DIRTY_TABLE,
]);

function assertDatabase(database) {
  if (!database || typeof database.prepare !== "function" || typeof database.exec !== "function") {
    throw new TypeError("database must be a node:sqlite DatabaseSync");
  }
}

function transaction(database, work) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function atomically(database, work) {
  if (!database.isTransaction) return transaction(database, work);
  database.exec(`SAVEPOINT ${SCHEMA_SAVEPOINT}`);
  try {
    const result = work();
    database.exec(`RELEASE ${SCHEMA_SAVEPOINT}`);
    return result;
  } catch (error) {
    database.exec(`ROLLBACK TO ${SCHEMA_SAVEPOINT}`);
    database.exec(`RELEASE ${SCHEMA_SAVEPOINT}`);
    throw error;
  }
}

function tableDefinitionReady(database, table, definition) {
  const rows = database.prepare(`SELECT name, pk FROM pragma_table_info('${table}') ORDER BY cid`).all();
  if (rows.length !== definition.columns.length) return false;
  if (rows.some((row, index) => String(row.name) !== definition.columns[index])) return false;
  const primaryKey = rows
    .filter((row) => Number(row.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((row) => String(row.name));
  return (
    primaryKey.length === definition.primaryKey.length &&
    primaryKey.every((column, index) => column === definition.primaryKey[index])
  );
}

function eventDefinitionReady(database) {
  const columns = new Map(
    database
      .prepare("SELECT name, pk FROM pragma_table_info('events')")
      .all()
      .map((row) => [String(row.name), row]),
  );
  return EVENT_COLUMNS.every((column) => columns.has(column)) && Number(columns.get("id").pk) > 0;
}

function schemaVersion(database) {
  const version = Number(database.prepare("PRAGMA schema_version").get()?.schema_version);
  if (!Number.isSafeInteger(version)) throw new Error("Invalid SQLite schema version");
  return version;
}

function normalizeSql(sql) {
  return String(sql ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function schemaIsCurrent(database) {
  const placeholders = USAGE_METADATA_TABLE_NAMES.map(() => "?").join(", ");
  const count = Number(
    database
      .prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
      .get(...USAGE_METADATA_TABLE_NAMES).count,
  );
  if (count !== USAGE_METADATA_TABLE_NAMES.length) return false;
  if (!eventDefinitionReady(database)) return false;
  for (const [table, definition] of TABLE_DEFINITIONS) {
    if (!tableDefinitionReady(database, table, definition)) return false;
  }
  return (
    Number(database.prepare(`SELECT version FROM ${FORMAT_TABLE} WHERE singleton = 1`).get()?.version) ===
    FORMAT_VERSION
  );
}

function triggerSql(database) {
  if (!database.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name='history_ordinal'").get())
    return TRIGGER_SQL;
  return TRIGGER_SQL.map((sql, index) =>
    index === 2
      ? sql.replace(
          "\n  BEGIN",
          `
    AND (OLD.id IS NOT NEW.id OR OLD.timestamp_ms IS NOT NEW.timestamp_ms
      OR OLD.session_id IS NOT NEW.session_id OR OLD.home_id IS NOT NEW.home_id
      OR OLD.channel IS NOT NEW.channel OR OLD.model IS NOT NEW.model)
  BEGIN`,
        )
      : sql,
  );
}

function triggersReady(database) {
  const rows = database
    .prepare(
      `SELECT name, tbl_name, sql FROM sqlite_master
       WHERE type = 'trigger' AND name IN (${TRIGGERS.map(() => "?").join(", ")})`,
    )
    .all(...TRIGGERS);
  const expected = new Map(
    triggerSql(database).map((sql) => [sql.match(/^CREATE TRIGGER\s+(\S+)/i)?.[1], normalizeSql(sql)]),
  );
  return (
    rows.length === TRIGGERS.length &&
    rows.every((row) => String(row.tbl_name) === "events" && expected.get(String(row.name)) === normalizeSql(row.sql))
  );
}

function schemaIsReady(database, deferIndex = false) {
  const index = database
    .prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(GROUP_TIME_INDEX);
  return (
    schemaIsCurrent(database) &&
    Number(database.prepare(`SELECT schema_version FROM ${FORMAT_TABLE} WHERE singleton = 1`).get()?.schema_version) ===
      schemaVersion(database) &&
    triggersReady(database) &&
    (deferIndex ||
      (String(index?.tbl_name) === "events" && normalizeSql(index?.sql) === normalizeSql(GROUP_TIME_INDEX_SQL)))
  );
}

function recreateSchema(database, deferIndex) {
  for (const trigger of TRIGGERS) database.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  for (const table of [...USAGE_METADATA_TABLE_NAMES].reverse()) database.exec(`DROP TABLE IF EXISTS ${table}`);
  if (!deferIndex) database.exec(`DROP INDEX IF EXISTS ${GROUP_TIME_INDEX}`);
  database.exec(`
    CREATE TABLE ${FORMAT_TABLE} (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      version INTEGER NOT NULL,
      schema_version INTEGER NOT NULL
    ) STRICT;
    INSERT INTO ${FORMAT_TABLE} VALUES (1, ${FORMAT_VERSION}, 0);

    CREATE TABLE ${STATE_TABLE} (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      status TEXT NOT NULL CHECK (status IN ('building', 'ready')),
      target_revision INTEGER NOT NULL,
      published_revision INTEGER NOT NULL,
      last_event_id INTEGER NOT NULL,
      event_count INTEGER NOT NULL CHECK (event_count >= 0),
      session_count INTEGER NOT NULL CHECK (session_count >= 0),
      max_timestamp_ms INTEGER
    ) STRICT;

    CREATE TABLE ${HOMES_TABLE} (
      home_id TEXT PRIMARY KEY,
      event_count INTEGER NOT NULL CHECK (event_count >= 0),
      session_count INTEGER NOT NULL CHECK (session_count >= 0)
    ) WITHOUT ROWID;

    CREATE TABLE ${SESSIONS_TABLE} (
      session_id TEXT PRIMARY KEY
    ) WITHOUT ROWID;

    CREATE TABLE ${HOME_SESSIONS_TABLE} (
      home_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      PRIMARY KEY (home_id, session_id)
    ) WITHOUT ROWID;

    CREATE TABLE ${MODELS_TABLE} (
      channel TEXT NOT NULL,
      model TEXT NOT NULL,
      PRIMARY KEY (channel, model)
    ) WITHOUT ROWID;

    CREATE TABLE ${OBSERVATIONS_TABLE} (
      channel TEXT NOT NULL,
      model TEXT NOT NULL,
      home_id TEXT NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (channel, model, home_id)
    ) WITHOUT ROWID;

    CREATE TABLE ${DIRTY_TABLE} (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
    ) STRICT;
  `);
}

function createTriggers(database) {
  database.exec(
    triggerSql(database)
      .map((sql) => `${sql};`)
      .join("\n"),
  );
}

function createGroupTimeIndex(database) {
  database.exec(`DROP INDEX IF EXISTS ${GROUP_TIME_INDEX}; ${GROUP_TIME_INDEX_SQL}`);
}

function hasUniqueEventIndex(database) {
  return database
    .prepare("PRAGMA index_list(events)")
    .all()
    .some((row) => Number(row.unique) !== 0);
}

/**
 * Install the rebuildable metadata projection schema and event invalidation triggers.
 *
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {{ deferIndex?: boolean }} [options] Defer the query index until metadata preparation.
 * @returns {boolean}
 */
export function ensureUsageMetadataSchema(database, { deferIndex = false } = {}) {
  assertDatabase(database);
  if (schemaIsReady(database, deferIndex)) return true;
  atomically(database, () => {
    let invalidate = false;
    if (!schemaIsCurrent(database)) {
      recreateSchema(database, deferIndex);
    } else {
      const format = database.prepare(`SELECT schema_version FROM ${FORMAT_TABLE} WHERE singleton = 1`).get();
      invalidate = Number(format?.schema_version) !== schemaVersion(database);
    }
    if (!triggersReady(database)) {
      for (const trigger of TRIGGERS) database.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
      createTriggers(database);
      invalidate = true;
    }
    if (
      !deferIndex &&
      normalizeSql(
        database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(GROUP_TIME_INDEX)?.sql,
      ) !== normalizeSql(GROUP_TIME_INDEX_SQL)
    ) {
      createGroupTimeIndex(database);
      invalidate = true;
    }
    if (invalidate && stateRow(database)) {
      database.exec(`INSERT OR IGNORE INTO ${DIRTY_TABLE} VALUES (1)`);
    }
    database.prepare(`UPDATE ${FORMAT_TABLE} SET schema_version = ? WHERE singleton = 1`).run(schemaVersion(database));
  });
  if (!schemaIsReady(database, deferIndex)) throw new Error("Unable to install metadata schema");
  return true;
}

function currentRevision(database) {
  const table = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_business_revision'")
    .get();
  if (!table) return 0;
  const value = Number(
    database.prepare("SELECT revision FROM usage_business_revision WHERE singleton = 1").get()?.revision,
  );
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid usage business revision");
  }
  return value;
}

function stateRow(database) {
  return database.prepare(`SELECT * FROM ${STATE_TABLE} WHERE singleton = 1`).get();
}

function dirty(database) {
  return Boolean(database.prepare(`SELECT 1 FROM ${DIRTY_TABLE} WHERE singleton = 1`).get());
}

function reset(database, targetRevision) {
  for (const table of [
    OBSERVATIONS_TABLE,
    MODELS_TABLE,
    HOME_SESSIONS_TABLE,
    SESSIONS_TABLE,
    HOMES_TABLE,
    DIRTY_TABLE,
    STATE_TABLE,
  ]) {
    database.exec(`DELETE FROM ${table}`);
  }
  database
    .prepare(`INSERT INTO ${STATE_TABLE} VALUES (1, 'building', ?, -1, ?, 0, 0, NULL)`)
    .run(targetRevision, INITIAL_EVENT_ID);
}

function eventBatch(database, state, batchSize) {
  return database
    .prepare(
      `SELECT id, timestamp_ms
       FROM events
       WHERE id >= ?
       ORDER BY id
       LIMIT ?`,
    )
    .all(Number(state.last_event_id) + (Number(state.event_count) === 0 ? 0 : 1), batchSize);
}

function applyBatch(database, state, rows) {
  let lastEventId = Number(state.event_count) === 0 ? -Infinity : Number(state.last_event_id);
  let maxTimestampMs = state.max_timestamp_ms === null ? -Infinity : Number(state.max_timestamp_ms);
  for (const row of rows) {
    const id = Number(row.id);
    const timestampMs = Number(row.timestamp_ms);
    if (!Number.isSafeInteger(id) || id <= lastEventId || !Number.isSafeInteger(timestampMs)) {
      throw new Error("Invalid event row in metadata projection");
    }
    lastEventId = id;
    maxTimestampMs = Math.max(maxTimestampMs, timestampMs);
  }

  const firstEventId = Number(rows[0].id);
  // Keep every GROUP BY on this id range, even when a grouping index exists.
  const batch = "FROM events NOT INDEXED WHERE id >= ? AND id <= ?";
  database
    .prepare(
      `INSERT INTO ${HOMES_TABLE}(home_id, event_count, session_count)
       SELECT home_id, COUNT(*), COUNT(DISTINCT CASE WHEN NOT EXISTS (
         SELECT 1 FROM ${HOME_SESSIONS_TABLE} AS member
         WHERE member.home_id = events.home_id AND member.session_id = events.session_id
       ) THEN session_id END)
       ${batch} GROUP BY home_id
       ON CONFLICT(home_id) DO UPDATE SET
         event_count = event_count + excluded.event_count,
         session_count = session_count + excluded.session_count`,
    )
    .run(firstEventId, lastEventId);
  const newSessions = database
    .prepare(`INSERT OR IGNORE INTO ${SESSIONS_TABLE}(session_id) SELECT session_id ${batch} GROUP BY session_id`)
    .run(firstEventId, lastEventId).changes;
  // Count missing home members above before inserting them here.
  database
    .prepare(
      `INSERT OR IGNORE INTO ${HOME_SESSIONS_TABLE}(home_id, session_id)
       SELECT home_id, session_id ${batch} GROUP BY home_id, session_id`,
    )
    .run(firstEventId, lastEventId);
  database
    .prepare(
      `INSERT OR IGNORE INTO ${MODELS_TABLE}(channel, model)
       SELECT channel, model ${batch} GROUP BY channel, model`,
    )
    .run(firstEventId, lastEventId);
  database
    .prepare(
      `INSERT INTO ${OBSERVATIONS_TABLE}(channel, model, home_id, last_seen)
       SELECT channel, model, home_id, MAX(timestamp_ms) ${batch} GROUP BY channel, model, home_id
       ON CONFLICT(channel, model, home_id) DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen)`,
    )
    .run(firstEventId, lastEventId);
  return {
    eventCount: Number(state.event_count) + rows.length,
    sessionCount: Number(state.session_count) + Number(newSessions),
    lastEventId,
    maxTimestampMs,
  };
}

function saveProgress(database, state, progress, targetRevision, complete) {
  database
    .prepare(
      `UPDATE ${STATE_TABLE}
       SET status = ?, target_revision = ?, published_revision = ?, last_event_id = ?,
         event_count = ?, session_count = ?, max_timestamp_ms = ?
       WHERE singleton = 1`,
    )
    .run(
      complete ? "ready" : "building",
      targetRevision,
      complete ? targetRevision : Number(state.published_revision),
      progress.lastEventId,
      progress.eventCount,
      progress.sessionCount,
      Number.isFinite(progress.maxTimestampMs) ? progress.maxTimestampMs : null,
    );
}

/**
 * Incrementally prepare the stored metadata projection.
 *
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {{ batchSize?: number, afterBatch?: (work: { processed: number, readEvents: number }) => void }} [options]
 * @returns {{ readEvents: number, rebuilt: boolean, reused: boolean }}
 */
export function prepareStoredMetadata(database, options = {}) {
  assertDatabase(database);
  if (database.isTransaction) throw new Error("Metadata preparation needs an unpinned writer");
  ensureUsageMetadataSchema(database);
  if (!schemaIsReady(database)) throw new Error("Metadata schema is missing");
  if (hasUniqueEventIndex(database)) throw new Error("Metadata preparation does not support unique event indexes");
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new TypeError("Invalid metadata batch size");
  }
  if (options.afterBatch !== undefined && typeof options.afterBatch !== "function") {
    throw new TypeError("afterBatch must be a function");
  }

  const work = { readEvents: 0, rebuilt: false, reused: false };
  for (;;) {
    const step = transaction(database, () => {
      const targetRevision = currentRevision(database);
      let state = stateRow(database);
      if (
        !state ||
        dirty(database) ||
        !["building", "ready"].includes(String(state.status)) ||
        Number(state.target_revision) > targetRevision ||
        Number(state.published_revision) > targetRevision ||
        (state.status === "ready" && Number(state.published_revision) !== Number(state.target_revision))
      ) {
        reset(database, targetRevision);
        state = stateRow(database);
        work.rebuilt = true;
      }

      let rows = eventBatch(database, state, batchSize);
      if (rows.length === 0 && Number(state.target_revision) !== targetRevision) {
        // A revision change with no new ids is not a safe append classification.
        reset(database, targetRevision);
        state = stateRow(database);
        rows = eventBatch(database, state, batchSize);
        work.rebuilt = true;
      }
      if (rows.length === 0) {
        if (state.status === "ready" && Number(state.published_revision) === targetRevision) {
          work.reused = true;
          return { done: true, processed: 0 };
        }
        saveProgress(
          database,
          state,
          {
            eventCount: Number(state.event_count),
            sessionCount: Number(state.session_count),
            lastEventId: Number(state.last_event_id),
            maxTimestampMs: state.max_timestamp_ms === null ? Number.NEGATIVE_INFINITY : Number(state.max_timestamp_ms),
          },
          targetRevision,
          true,
        );
        return { done: true, processed: 0 };
      }

      const progress = applyBatch(database, state, rows);
      const done = rows.length < batchSize;
      saveProgress(database, state, progress, targetRevision, done);
      return { done, processed: rows.length };
    });

    work.readEvents += step.processed;
    if (step.processed > 0 && step.done) work.reused = false;
    if (step.processed > 0) {
      options.afterBatch?.({ processed: step.processed, readEvents: work.readEvents });
    }
    if (step.done) break;
  }
  return work;
}

function observationRowsAt(database, rows, asOfMs, maxTimestampMs) {
  if (maxTimestampMs <= asOfMs) {
    return rows.map((row) => ({
      channel: String(row.channel),
      model: String(row.model),
      home_id: String(row.home_id),
      last_seen: Number(row.last_seen),
    }));
  }

  const boundary = database.prepare(
    `SELECT timestamp_ms
     FROM events INDEXED BY ${GROUP_TIME_INDEX}
     WHERE home_id = ? AND channel = ? AND model = ? AND timestamp_ms <= ?
     ORDER BY home_id, channel, model, timestamp_ms DESC
     LIMIT 1`,
  );
  const result = [];
  for (const row of rows) {
    const lastSeen = Number(row.last_seen);
    const at =
      lastSeen <= asOfMs ? { timestamp_ms: lastSeen } : boundary.get(row.home_id, row.channel, row.model, asOfMs);
    if (!at) continue;
    result.push({
      channel: String(row.channel),
      model: String(row.model),
      home_id: String(row.home_id),
      last_seen: Number(at.timestamp_ms),
    });
  }
  return result;
}

/**
 * Read a complete published metadata projection. Existing fixed read snapshots
 * are supported; the caller decides whether a write transaction is usable.
 *
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {number} asOfMs
 * @returns {{
 *   eventCount: number,
 *   sessionCount: number,
 *   homeRows: Map<string, { event_count: number, session_count: number }>,
 *   modelRows: { channel: string, model: string }[],
 *   observationRows: { channel: string, model: string, home_id: string, last_seen: number }[]
 * } | null}
 */
export function readStoredMetadata(database, asOfMs) {
  assertDatabase(database);
  if (!Number.isSafeInteger(asOfMs)) throw new TypeError("asOfMs must be a safe integer");

  let state;
  let revision;
  try {
    if (!schemaIsReady(database) || hasUniqueEventIndex(database)) return null;
    state = stateRow(database);
    revision = currentRevision(database);
  } catch {
    return null;
  }
  if (state?.status !== "ready" || Number(state.published_revision) !== revision || dirty(database)) {
    return null;
  }

  const eventCount = Number(state.event_count);
  const sessionCount = Number(state.session_count);
  const maxTimestampMs = state.max_timestamp_ms === null ? Number.NEGATIVE_INFINITY : Number(state.max_timestamp_ms);
  if (
    !Number.isSafeInteger(eventCount) ||
    eventCount < 0 ||
    !Number.isSafeInteger(sessionCount) ||
    sessionCount < 0 ||
    (!Number.isFinite(maxTimestampMs) && maxTimestampMs !== Number.NEGATIVE_INFINITY)
  ) {
    return null;
  }

  const homeRows = new Map();
  for (const row of database
    .prepare(`SELECT home_id, event_count, session_count FROM ${HOMES_TABLE} ORDER BY home_id`)
    .all()) {
    const homeEventCount = Number(row.event_count);
    const homeSessionCount = Number(row.session_count);
    if (
      !Number.isSafeInteger(homeEventCount) ||
      homeEventCount < 0 ||
      !Number.isSafeInteger(homeSessionCount) ||
      homeSessionCount < 0
    ) {
      return null;
    }
    homeRows.set(String(row.home_id), {
      event_count: homeEventCount,
      session_count: homeSessionCount,
    });
  }

  const modelRows = database
    .prepare(`SELECT channel, model FROM ${MODELS_TABLE} ORDER BY channel, model`)
    .all()
    .map((row) => ({ channel: String(row.channel), model: String(row.model) }));
  const observations = database
    .prepare(
      `SELECT channel, model, home_id, last_seen
       FROM ${OBSERVATIONS_TABLE}
       ORDER BY channel, model, home_id`,
    )
    .all();
  if (observations.some((row) => !Number.isSafeInteger(Number(row.last_seen)))) return null;

  return {
    eventCount,
    sessionCount,
    homeRows,
    modelRows,
    observationRows: observationRowsAt(database, observations, asOfMs, maxTimestampMs),
  };
}
