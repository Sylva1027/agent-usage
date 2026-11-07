const CACHE_TABLE = "usage_record_cache";
const PERIOD_TABLE = "usage_record_cache_periods";
const MEMBER_TABLE = "usage_record_cache_members";
const APPEND_MEMBER_TABLE = "usage_record_cache_append_members";
const DIRTY_TABLE = "usage_record_cache_dirty";
const WORK_TABLE = "usage_record_cache_work";
const OPERATION_TABLE = "usage_record_cache_operations";
const FORMAT_TABLE = "usage_record_cache_format";
const BUILD_SAVEPOINT = "usage_record_store_build";
const FORMAT_VERSION = 9;
const DEFAULT_BATCH_SIZE = 1024;

const DIRTY_TRIGGER_NAMES = Object.freeze([
  "usage_record_dirty_insert",
  "usage_record_dirty_update",
  "usage_record_dirty_delete",
]);

export const USAGE_RECORD_TABLE_NAMES = Object.freeze([
  CACHE_TABLE,
  PERIOD_TABLE,
  MEMBER_TABLE,
  APPEND_MEMBER_TABLE,
  DIRTY_TABLE,
  WORK_TABLE,
  OPERATION_TABLE,
  FORMAT_TABLE,
]);

const HOT_TABLES = {
  CACHE_TABLE,
  PERIOD_TABLE,
  MEMBER_TABLE,
  APPEND_MEMBER_TABLE,
  DIRTY_TABLE,
  WORK_TABLE,
  OPERATION_TABLE,
  FORMAT_TABLE,
};
const HISTORY_TABLES = Object.fromEntries(
  Object.entries(HOT_TABLES).map(([key, name]) => [key, name.replace("usage_record_", "usage_history_record_")]),
);
export const USAGE_HISTORY_RECORD_TABLE_NAMES = Object.freeze(Object.values(HISTORY_TABLES));
const recordTables = (mode) => (mode === "history" ? HISTORY_TABLES : HOT_TABLES);
const START_MS = Number.MIN_SAFE_INTEGER;
const eventSql = (mode) =>
  mode === "history"
    ? RECORD_EVENT_SQL.replace("SELECT id,", "SELECT id AS fact_id, history_ordinal AS id,")
    : RECORD_EVENT_SQL;
const cursorSql = (mode) =>
  mode === "history"
    ? "(timestamp_ms,history_ordinal) > (?,?) ORDER BY timestamp_ms ASC,history_ordinal ASC"
    : "id > ? ORDER BY id ASC";
const cursorParams = (row, mode) =>
  mode === "history" ? [Number(row.last_ms), Number(row.last_event_id)] : [Number(row.last_event_id)];

const RECORD_METRICS = Object.freeze({
  totalTokens: "total_tokens",
  inputTokens: "input_tokens",
  cachedTokens: "cached_tokens",
  outputTokens: "output_tokens",
  reasoningTokens: "reasoning_tokens",
  sessionCount: "session_count",
  modelCount: "model_count",
  cacheHitRate: "CASE WHEN input_tokens > 0 THEN cached_tokens * 1.0 / input_tokens END",
  totalCost: "total_cost",
  inputCost: "input_cost",
  cachedCost: "cached_cost",
  outputCost: "output_cost",
});

const RECORD_EVENT_SQL = `
  SELECT id, timestamp_ms, day_key, week_key, month_key, session_id, model, channel, home_id,
    total, input, cached, output, reasoning, detail_mask, cache_write_tokens,
    cache_write_known, request_input_tokens, context_level, service_tier
  FROM events
`;

const PERIOD_VALUE_COLUMNS = `
  total_tokens, input_tokens, cached_tokens, output_tokens, reasoning_tokens,
  total_cost, input_cost, cached_cost, output_cost, session_count, model_count, minimum_ms, maximum_ms
`;

const PERIOD_SCALAR_COLUMNS = Object.freeze([
  "total_tokens",
  "input_tokens",
  "cached_tokens",
  "output_tokens",
  "reasoning_tokens",
  "total_cost",
  "input_cost",
  "cached_cost",
  "output_cost",
]);

const PERIOD_VALUE_SELECT = `
  total_tokens, input_tokens, cached_tokens, output_tokens, reasoning_tokens,
  total_cost, input_cost, cached_cost, output_cost, session_count, model_count, minimum_ms, maximum_ms
`;

function recordError(code, message) {
  return Object.assign(new Error(message), { code });
}

function assertDatabase(database) {
  if (!database || typeof database.prepare !== "function" || typeof database.exec !== "function") {
    throw new TypeError("database must be a node:sqlite DatabaseSync");
  }
}

function normalizeInput({
  database,
  sourceDatabase = database,
  key,
  factsKey,
  zone,
  where = "",
  params = [],
  mode = "hot",
}) {
  assertDatabase(database);
  assertDatabase(sourceDatabase);
  if (typeof key !== "string" || key.length === 0) throw new TypeError("key must be a non-empty string");
  if (typeof factsKey !== "string" || factsKey.length === 0) {
    throw new TypeError("factsKey must be a non-empty string");
  }
  if (zone !== "local" && zone !== "utc") throw new TypeError(`zone must be "local" or "utc": ${String(zone)}`);
  if (typeof where !== "string") throw new TypeError("where must be a string");
  if (where.trim() !== "" && !/^\s*WHERE\b/i.test(where)) {
    throw new TypeError('where must be empty or start with "WHERE"');
  }
  if (!Array.isArray(params)) throw new TypeError("params must be an array");
  return { database, sourceDatabase, key, factsKey, zone, where: where.trim(), params, mode };
}

function schemaReady(database, mode = "hot") {
  const names = Object.values(recordTables(mode));
  const placeholders = names.map(() => "?").join(", ");
  return (
    Number(
      database
        .prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
        .get(...names).count,
    ) === names.length
  );
}

function currentFormatVersion(database, mode = "hot") {
  const { FORMAT_TABLE } = recordTables(mode);
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(FORMAT_TABLE)) {
    return null;
  }
  return Number(database.prepare(`SELECT format_version FROM ${FORMAT_TABLE} WHERE slot = 1`).get()?.format_version);
}

function dropDirtyTriggers(database) {
  database.exec(DIRTY_TRIGGER_NAMES.map((name) => `DROP TRIGGER IF EXISTS ${name};`).join("\n"));
}

function dropSchema(database, mode) {
  const {
    CACHE_TABLE,
    PERIOD_TABLE,
    MEMBER_TABLE,
    APPEND_MEMBER_TABLE,
    DIRTY_TABLE,
    WORK_TABLE,
    OPERATION_TABLE,
    FORMAT_TABLE,
  } = recordTables(mode);
  if (mode !== "history") dropDirtyTriggers(database);
  database.exec(`
    DROP TABLE IF EXISTS ${WORK_TABLE};
    DROP TABLE IF EXISTS ${OPERATION_TABLE};
    DROP TABLE IF EXISTS ${DIRTY_TABLE};
    DROP TABLE IF EXISTS ${APPEND_MEMBER_TABLE};
    DROP TABLE IF EXISTS ${MEMBER_TABLE};
    DROP TABLE IF EXISTS ${PERIOD_TABLE};
    DROP TABLE IF EXISTS ${CACHE_TABLE};
    DROP TABLE IF EXISTS ${FORMAT_TABLE};
  `);
}

function dirtyRowsSql(rowName) {
  const utcDay = `date(${rowName}.timestamp_ms / 1000.0, 'unixepoch')`;
  const utcWeek = `date(${utcDay}, '-' || ((CAST(strftime('%w', ${utcDay}) AS INTEGER) + 6) % 7) || ' days')`;
  return `
    SELECT 'local', 'day', ${rowName}.day_key, ${rowName}.timestamp_ms, ${rowName}.timestamp_ms
    UNION ALL SELECT 'local', 'week', ${rowName}.week_key, ${rowName}.timestamp_ms, ${rowName}.timestamp_ms
    UNION ALL SELECT 'local', 'month', ${rowName}.month_key, ${rowName}.timestamp_ms, ${rowName}.timestamp_ms
    UNION ALL SELECT 'utc', 'day', ${utcDay}, ${rowName}.timestamp_ms, ${rowName}.timestamp_ms
    UNION ALL SELECT 'utc', 'week', ${utcWeek}, ${rowName}.timestamp_ms, ${rowName}.timestamp_ms
    UNION ALL SELECT 'utc', 'month', substr(${utcDay}, 1, 7), ${rowName}.timestamp_ms, ${rowName}.timestamp_ms
  `;
}

function createDirtyTriggers(database) {
  const conflict = `ON CONFLICT(calendar_zone, unit, period_key) DO UPDATE SET
    minimum_ms = MIN(minimum_ms, excluded.minimum_ms), maximum_ms = MAX(maximum_ms, excluded.maximum_ms)`;
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS usage_record_dirty_insert
    AFTER INSERT ON events
    WHEN EXISTS (
      SELECT 1 FROM ${CACHE_TABLE} WHERE slot = 1 AND published_facts_key IS NOT NULL
    )
    BEGIN
      INSERT INTO ${DIRTY_TABLE} (calendar_zone, unit, period_key, minimum_ms, maximum_ms)
      ${dirtyRowsSql("NEW")} ${conflict};
      UPDATE ${OPERATION_TABLE}
      SET rebuild_required = 1
      WHERE slot = 1
        AND NEW.id <= (SELECT last_event_id FROM ${CACHE_TABLE} WHERE slot = 1);
    END;

    CREATE TRIGGER IF NOT EXISTS usage_record_dirty_update
    AFTER UPDATE ON events
    WHEN EXISTS (
      SELECT 1 FROM ${CACHE_TABLE} WHERE slot = 1 AND published_facts_key IS NOT NULL
    )
    BEGIN
      INSERT INTO ${DIRTY_TABLE} (calendar_zone, unit, period_key, minimum_ms, maximum_ms)
      ${dirtyRowsSql("OLD")}
      UNION ALL
      ${dirtyRowsSql("NEW")} ${conflict};
      UPDATE ${OPERATION_TABLE} SET rebuild_required = 1 WHERE slot = 1;
    END;

    CREATE TRIGGER IF NOT EXISTS usage_record_dirty_delete
    AFTER DELETE ON events
    WHEN EXISTS (
      SELECT 1 FROM ${CACHE_TABLE} WHERE slot = 1 AND published_facts_key IS NOT NULL
    )
    BEGIN
      INSERT INTO ${DIRTY_TABLE} (calendar_zone, unit, period_key, minimum_ms, maximum_ms)
      ${dirtyRowsSql("OLD")} ${conflict};
      UPDATE ${OPERATION_TABLE} SET rebuild_required = 1 WHERE slot = 1;
    END;
  `);
}

function ensureSchema(database, installDirtyTriggers = true, mode = "hot") {
  const {
    CACHE_TABLE,
    PERIOD_TABLE,
    MEMBER_TABLE,
    APPEND_MEMBER_TABLE,
    DIRTY_TABLE,
    WORK_TABLE,
    OPERATION_TABLE,
    FORMAT_TABLE,
  } = recordTables(mode);
  const history = mode === "history";
  if (currentFormatVersion(database, mode) !== FORMAT_VERSION || !schemaReady(database, mode)) {
    dropSchema(database, mode);
    database.exec(`
      CREATE TABLE ${FORMAT_TABLE} (
        slot INTEGER PRIMARY KEY CHECK (slot = 1),
        format_version INTEGER NOT NULL
      ) STRICT;
      INSERT INTO ${FORMAT_TABLE} VALUES (1, ${FORMAT_VERSION});

      CREATE TABLE ${CACHE_TABLE} (
        slot INTEGER PRIMARY KEY CHECK (slot = 1),
        stable_key TEXT NOT NULL,
        target_facts_key TEXT NOT NULL,
        published_facts_key TEXT,
        zone TEXT NOT NULL CHECK (zone IN ('local', 'utc')),
        where_sql TEXT NOT NULL,
        params_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('building', 'complete')),
        build_mode TEXT NOT NULL CHECK (build_mode IN ('full', 'dirty', 'append')),
        last_event_id INTEGER NOT NULL DEFAULT -1,
        ${history ? `last_ms INTEGER NOT NULL DEFAULT ${START_MS},` : ""}
        champion_json TEXT
      ) STRICT;

      CREATE TABLE ${PERIOD_TABLE} (
        unit TEXT NOT NULL CHECK (unit IN ('day', 'week', 'month')),
        period_key TEXT NOT NULL,
        total_tokens REAL NOT NULL,
        input_tokens REAL NOT NULL,
        cached_tokens REAL NOT NULL,
        output_tokens REAL NOT NULL,
        reasoning_tokens REAL NOT NULL,
        total_cost REAL NOT NULL,
        input_cost REAL NOT NULL,
        cached_cost REAL NOT NULL,
        output_cost REAL NOT NULL,
        session_count INTEGER NOT NULL DEFAULT 0,
        model_count INTEGER NOT NULL DEFAULT 0,
        minimum_ms INTEGER NOT NULL,
        maximum_ms INTEGER NOT NULL,
        PRIMARY KEY (unit, period_key)
      ) STRICT;

      CREATE TABLE ${MEMBER_TABLE} (
        unit TEXT NOT NULL CHECK (unit IN ('day', 'week', 'month')),
        period_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('session', 'model')),
        member TEXT NOT NULL,
        PRIMARY KEY (unit, period_key, kind, member)
      ) STRICT;

      CREATE TABLE ${APPEND_MEMBER_TABLE} (
        unit TEXT NOT NULL CHECK (unit IN ('day', 'week', 'month')),
        period_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('session', 'model')),
        member TEXT NOT NULL,
        PRIMARY KEY (unit, period_key, kind, member)
      ) STRICT;

      CREATE TABLE ${DIRTY_TABLE} (
        calendar_zone TEXT NOT NULL CHECK (calendar_zone IN ('local', 'utc')),
        unit TEXT NOT NULL CHECK (unit IN ('day', 'week', 'month')),
        period_key TEXT NOT NULL,
        minimum_ms INTEGER NOT NULL,
        maximum_ms INTEGER NOT NULL,
        PRIMARY KEY (calendar_zone, unit, period_key)
      ) STRICT;

      CREATE TABLE ${WORK_TABLE} (
        unit TEXT NOT NULL CHECK (unit IN ('day', 'week', 'month')),
        period_key TEXT NOT NULL,
        last_event_id INTEGER NOT NULL DEFAULT -1,
        ${history ? `last_ms INTEGER NOT NULL DEFAULT ${START_MS},` : ""}
        total_tokens REAL NOT NULL,
        input_tokens REAL NOT NULL,
        cached_tokens REAL NOT NULL,
        output_tokens REAL NOT NULL,
        reasoning_tokens REAL NOT NULL,
        total_cost REAL NOT NULL,
        input_cost REAL NOT NULL,
        cached_cost REAL NOT NULL,
        output_cost REAL NOT NULL,
        session_count INTEGER NOT NULL DEFAULT 0,
        model_count INTEGER NOT NULL DEFAULT 0,
        minimum_ms INTEGER NOT NULL,
        maximum_ms INTEGER NOT NULL,
        PRIMARY KEY (unit, period_key)
      ) STRICT;

      CREATE TABLE ${OPERATION_TABLE} (
        slot INTEGER PRIMARY KEY CHECK (slot = 1),
        rebuild_required INTEGER NOT NULL CHECK (rebuild_required IN (0, 1))
      ) STRICT;
      INSERT INTO ${OPERATION_TABLE} VALUES (1, 0);

    `);
  }
  if (history) return;
  if (installDirtyTriggers) createDirtyTriggers(database);
  else dropDirtyTriggers(database);
}

/**
 * Create record projection tables and event dirty triggers during store open.
 * Call before the shared projection tracker installs its triggers.
 *
 * @param {import("node:sqlite").DatabaseSync} database
 */
export function ensureUsageRecordSchema(database, { mode = "hot" } = {}) {
  assertDatabase(database);
  ensureSchema(database, true, mode);
}

function cacheRow(database, mode = "hot") {
  const { CACHE_TABLE } = recordTables(mode);
  return database
    .prepare(
      `SELECT stable_key, target_facts_key, published_facts_key, zone, where_sql, params_json,
        state, build_mode, last_event_id, ${mode === "history" ? "last_ms," : ""} champion_json
       FROM ${CACHE_TABLE} WHERE slot = 1`,
    )
    .get();
}

function parseChampionJson(raw) {
  try {
    return JSON.parse(String(raw));
  } catch {
    throw recordError("USAGE_RECORD_STATE_INVALID", "stored record champion JSON is invalid");
  }
}

/**
 * Read a complete matching result without creating or changing schema.
 *
 * @param {{ database: import("node:sqlite").DatabaseSync, key: string, factsKey: string, mode?: string }} options
 * @returns {Record<string, Record<string, { period: string, value: number }>> | null}
 */
export function readStoredRecordChampions({ database, key, factsKey, mode = "hot" }) {
  assertDatabase(database);
  if (typeof key !== "string" || key.length === 0) throw new TypeError("key must be a non-empty string");
  if (typeof factsKey !== "string" || factsKey.length === 0) {
    throw new TypeError("factsKey must be a non-empty string");
  }
  if (!schemaReady(database, mode) || currentFormatVersion(database, mode) !== FORMAT_VERSION) return null;
  const row = cacheRow(database, mode);
  if (!row || row.stable_key !== key || row.published_facts_key !== factsKey || row.champion_json === null) return null;
  return parseChampionJson(row.champion_json);
}

function clearPublished(database, mode = "hot") {
  const { MEMBER_TABLE, PERIOD_TABLE } = recordTables(mode);
  database.prepare(`DELETE FROM ${MEMBER_TABLE}`).run();
  database.prepare(`DELETE FROM ${PERIOD_TABLE}`).run();
}

function clearWork(database, mode = "hot") {
  const { WORK_TABLE } = recordTables(mode);
  database.prepare(`DELETE FROM ${WORK_TABLE}`).run();
}

function clearAppendMembers(database, mode = "hot") {
  const { APPEND_MEMBER_TABLE } = recordTables(mode);
  database.prepare(`DELETE FROM ${APPEND_MEMBER_TABLE}`).run();
}

function operationState(database) {
  const row = database.prepare(`SELECT rebuild_required FROM ${OPERATION_TABLE} WHERE slot = 1`).get();
  return row ? Number(row.rebuild_required) : null;
}

function resumableAppendState(database, row) {
  if (!row || row.champion_json === null || operationState(database) !== 0) {
    return false;
  }
  try {
    parseChampionJson(row.champion_json);
    return true;
  } catch {
    return false;
  }
}

function validAppendState(database, row) {
  return row?.state === "complete" && resumableAppendState(database, row);
}

function populateDirtyWork(database, zone, mode = "hot") {
  const { WORK_TABLE, DIRTY_TABLE, PERIOD_TABLE } = recordTables(mode);
  database
    .prepare(
      `INSERT OR IGNORE INTO ${WORK_TABLE} (
         unit, period_key, last_event_id, ${PERIOD_VALUE_COLUMNS}
       )
       SELECT dirty.unit, dirty.period_key, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
         MIN(dirty.minimum_ms, COALESCE(period.minimum_ms, dirty.minimum_ms)),
         MAX(dirty.maximum_ms, COALESCE(period.maximum_ms, dirty.maximum_ms))
       FROM ${DIRTY_TABLE} dirty LEFT JOIN ${PERIOD_TABLE} period
         ON period.unit = dirty.unit AND period.period_key = dirty.period_key
       WHERE dirty.calendar_zone = ?`,
    )
    .run(zone);
}

function prepareCandidate(database, sourceDatabase, input, allowAppend) {
  const { mode } = input;
  const { CACHE_TABLE, DIRTY_TABLE } = recordTables(mode);
  const current = cacheRow(database, mode);
  if (current?.stable_key === input.key) {
    if (
      current.zone !== input.zone ||
      current.where_sql !== input.where ||
      current.params_json !== JSON.stringify(input.params)
    ) {
      throw recordError("USAGE_RECORD_KEY_CONFLICT", "the same stable key was used with a different scope");
    }
    if (current.published_facts_key === input.factsKey && current.champion_json !== null) {
      return parseChampionJson(current.champion_json);
    }
    if (current.target_facts_key === input.factsKey) {
      if (
        current.state === "building" &&
        current.build_mode === "append" &&
        (!allowAppend || !resumableAppendState(database, current))
      ) {
        clearWork(database, mode);
        clearAppendMembers(database, mode);
        database
          .prepare(`UPDATE ${CACHE_TABLE} SET build_mode = 'dirty' WHERE slot = 1 AND stable_key = ?`)
          .run(input.key);
        populateDirtyWork(database, input.zone, mode);
      }
      return null;
    }

    clearWork(database, mode);
    clearAppendMembers(database, mode);
    if (current.published_facts_key === null || sourceDatabase !== database) {
      clearPublished(database, mode);
      database.prepare(`DELETE FROM ${DIRTY_TABLE}`).run();
      database
        .prepare(
          `UPDATE ${CACHE_TABLE}
           SET target_facts_key = ?, state = 'building', build_mode = 'full', last_event_id = -1,
             ${mode === "history" ? `last_ms = ${START_MS},` : ""} champion_json = NULL
           WHERE slot = 1`,
        )
        .run(input.factsKey);
    } else if (allowAppend && validAppendState(database, current)) {
      database
        .prepare(
          `UPDATE ${CACHE_TABLE}
           SET target_facts_key = ?, state = 'building', build_mode = 'append'
           WHERE slot = 1`,
        )
        .run(input.factsKey);
    } else {
      database
        .prepare(
          `UPDATE ${CACHE_TABLE}
           SET target_facts_key = ?, state = 'building', build_mode = 'dirty'
           WHERE slot = 1`,
        )
        .run(input.factsKey);
      populateDirtyWork(database, input.zone, mode);
    }
    return null;
  }

  clearPublished(database, mode);
  clearWork(database, mode);
  clearAppendMembers(database, mode);
  database.prepare(`DELETE FROM ${DIRTY_TABLE}`).run();
  database.prepare(`DELETE FROM ${CACHE_TABLE}`).run();
  database
    .prepare(
      `INSERT INTO ${CACHE_TABLE} (
        slot, stable_key, target_facts_key, published_facts_key, zone, where_sql, params_json,
        state, build_mode, champion_json
      ) VALUES (1, ?, ?, NULL, ?, ?, ?, 'building', 'full', NULL)`,
    )
    .run(input.key, input.factsKey, input.zone, input.where, JSON.stringify(input.params));
  return null;
}

function periodBounds(key, unit) {
  const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (unit === "month") {
    const monthMatch = /^(\d{4})-(\d{2})$/.exec(key);
    if (!monthMatch) throw new RangeError(`invalid ${unit} period: ${key}`);
    const year = Number(monthMatch[1]);
    const month = Number(monthMatch[2]) - 1;
    return [Date.UTC(year, month, 1), Date.UTC(year, month + 1, 1)];
  }
  if (!dayMatch) throw new RangeError(`invalid ${unit} period: ${key}`);
  const year = Number(dayMatch[1]);
  const month = Number(dayMatch[2]) - 1;
  const day = Number(dayMatch[3]);
  const start = new Date(Date.UTC(year, month, day));
  if (start.toISOString().slice(0, 10) !== key) throw new RangeError(`invalid utc ${unit} period: ${key}`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + (unit === "week" ? 7 : 1));
  return [start.getTime(), end.getTime()];
}

function periodPredicate(unit, periodKey, zone, bounds) {
  if (zone === "utc") {
    const [start, end] = periodBounds(periodKey, unit);
    return { sql: "timestamp_ms >= ? AND timestamp_ms < ?", params: [start, end] };
  }
  // Stored local keys can come from another timezone; actual fact bounds remain indexable and exact.
  return {
    sql: `timestamp_ms >= ? AND timestamp_ms <= ? AND ${unit}_key = ?`,
    params: [Number(bounds.minimum_ms), Number(bounds.maximum_ms), periodKey],
  };
}

function accumulateEvent(row, usdToCnyRate, estimate, state) {
  if (!estimate || typeof estimate !== "object" || Array.isArray(estimate)) {
    throw new TypeError(`estimateRow must return an object for event ${String(row.id)}`);
  }
  const scale = estimate.currency === "CNY" ? 1 : usdToCnyRate;
  state.total_tokens += Number(row.total || 0);
  state.input_tokens += Number(row.input || 0);
  state.cached_tokens += Number(row.cached || 0);
  state.output_tokens += Number(row.output || 0);
  state.reasoning_tokens += Number(row.reasoning || 0);
  state.total_cost += Number(estimate.totalUsd || 0) * scale;
  state.input_cost += Number(estimate.inputUsd || 0) * scale;
  state.cached_cost += Number(estimate.cachedInputUsd || 0) * scale;
  state.output_cost += Number(estimate.outputUsd || 0) * scale;
}

function eventPeriodKeys(row, zone) {
  if (zone === "local") {
    return { day: String(row.day_key), week: String(row.week_key), month: String(row.month_key) };
  }
  const date = new Date(Number(row.timestamp_ms));
  const day = date.toISOString().slice(0, 10);
  return {
    day,
    week: new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((date.getUTCDay() || 7) - 1)),
    )
      .toISOString()
      .slice(0, 10),
    month: day.slice(0, 7),
  };
}

/** Mark old and new timestamps in the caller's fact transaction; ordinal changes dirty the same periods. */
export function markStoredHistoryRecordsDirty(database, { ms, id }) {
  assertDatabase(database);
  if (!Number.isSafeInteger(ms) || !Number.isSafeInteger(id))
    throw new TypeError("Invalid history record dirty position");
  const { DIRTY_TABLE, PERIOD_TABLE } = HISTORY_TABLES;
  const insert = database.prepare(`INSERT INTO ${DIRTY_TABLE} VALUES(?,?,?,?,?)
    ON CONFLICT(calendar_zone,unit,period_key) DO UPDATE SET
      minimum_ms=MIN(minimum_ms,excluded.minimum_ms),maximum_ms=MAX(maximum_ms,excluded.maximum_ms)`);
  for (const [unit, key] of Object.entries(eventPeriodKeys({ timestamp_ms: ms }, "utc")))
    insert.run("utc", unit, key, ms, ms);
  // Published bounds retain the local keys of removed facts, including keys from another timezone.
  if (cacheRow(database, "history")?.zone === "local") {
    for (const row of database
      .prepare(`SELECT unit,period_key FROM ${PERIOD_TABLE}
      WHERE minimum_ms<=? AND maximum_ms>=?`)
      .iterate(ms, ms))
      insert.run("local", row.unit, row.period_key, ms, ms);
  }
  for (const row of database
    .prepare("SELECT DISTINCT day_key,week_key,month_key FROM events WHERE timestamp_ms=?")
    .iterate(ms)) {
    for (const unit of ["day", "week", "month"]) insert.run("local", unit, row[`${unit}_key`], ms, ms);
  }
}

function memberSelectSql(where, predicateSql) {
  return `
    WITH scoped AS (
      SELECT session_id, model FROM events
      ${where} ${where ? "AND" : "WHERE"} (${predicateSql})
    )
    SELECT 'session' AS kind, session_id AS member FROM scoped
    UNION
    SELECT 'model', model FROM scoped
  `;
}

function replacePeriodMembers(database, sourceDatabase, input, unit, periodKey, predicate) {
  const { MEMBER_TABLE } = recordTables(input.mode);
  database.prepare(`DELETE FROM ${MEMBER_TABLE} WHERE unit = ? AND period_key = ?`).run(unit, periodKey);
  const params = [...input.params, ...predicate.params];
  const selectSql = memberSelectSql(input.where, predicate.sql);
  if (sourceDatabase === database) {
    database
      .prepare(
        `INSERT INTO ${MEMBER_TABLE} (unit, period_key, kind, member)
         SELECT ?, ?, kind, member FROM (${selectSql})`,
      )
      .run(unit, periodKey, ...params);
    return;
  }
  const insertMember = database.prepare(
    `INSERT OR IGNORE INTO ${MEMBER_TABLE} (unit, period_key, kind, member) VALUES (?, ?, ?, ?)`,
  );
  for (const row of sourceDatabase.prepare(selectSql).iterate(...params)) {
    insertMember.run(unit, periodKey, String(row.kind), String(row.member));
  }
}

function refreshWorkCounts(database, unit, periodKey, mode = "hot") {
  const { WORK_TABLE, MEMBER_TABLE } = recordTables(mode);
  database
    .prepare(
      `UPDATE ${WORK_TABLE}
       SET session_count = (
             SELECT COUNT(*) FROM ${MEMBER_TABLE}
             WHERE unit = ? AND period_key = ? AND kind = 'session'
           ),
           model_count = (
             SELECT COUNT(*) FROM ${MEMBER_TABLE}
             WHERE unit = ? AND period_key = ? AND kind = 'model'
           )
       WHERE unit = ? AND period_key = ?`,
    )
    .run(unit, periodKey, unit, periodKey, unit, periodKey);
}

function mergeWorkPeriod(database, sourceDatabase, input, unit, periodKey, predicate) {
  const { WORK_TABLE, MEMBER_TABLE, PERIOD_TABLE } = recordTables(input.mode);
  replacePeriodMembers(database, sourceDatabase, input, unit, periodKey, predicate);
  refreshWorkCounts(database, unit, periodKey, input.mode);
  const exists = database
    .prepare(
      `SELECT 1
       FROM ${WORK_TABLE} AS work
       WHERE work.unit = ? AND work.period_key = ?
         AND (
           work.total_tokens != 0 OR work.input_tokens != 0 OR work.cached_tokens != 0
           OR work.output_tokens != 0 OR work.reasoning_tokens != 0
           OR work.total_cost != 0 OR work.input_cost != 0
           OR work.cached_cost != 0 OR work.output_cost != 0
           OR EXISTS (
             SELECT 1 FROM ${MEMBER_TABLE} AS members
             WHERE members.unit = work.unit AND members.period_key = work.period_key
           )
         )`,
    )
    .get(unit, periodKey);
  database.prepare(`DELETE FROM ${PERIOD_TABLE} WHERE unit = ? AND period_key = ?`).run(unit, periodKey);
  if (exists) {
    database
      .prepare(
        `INSERT INTO ${PERIOD_TABLE} (unit, period_key, ${PERIOD_VALUE_SELECT})
         SELECT unit, period_key, ${PERIOD_VALUE_SELECT}
         FROM ${WORK_TABLE} WHERE unit = ? AND period_key = ?`,
      )
      .run(unit, periodKey);
  }
  database.prepare(`DELETE FROM ${WORK_TABLE} WHERE unit = ? AND period_key = ?`).run(unit, periodKey);
}

function buildRankState(database, mode = "hot") {
  const { PERIOD_TABLE } = recordTables(mode);
  const rankings = { day: {}, week: {}, month: {} };
  for (const [metric, column] of Object.entries(RECORD_METRICS)) {
    for (const unit of ["day", "week", "month"]) {
      const top = database
        .prepare(
          `SELECT period_key, ${column} AS value
           FROM ${PERIOD_TABLE}
           WHERE unit = ? AND ${column} > 0
           ORDER BY value DESC, period_key ASC
           LIMIT 2`,
        )
        .all(unit);
      rankings[unit][metric] = top.map((row) => ({
        period: String(row.period_key),
        value: Number(row.value),
      }));
    }
  }
  return rankings;
}

function championsFromRankState(rankings) {
  const champions = { day: {}, week: {}, month: {} };
  for (const [metric] of Object.entries(RECORD_METRICS)) {
    for (const unit of ["day", "week", "month"]) {
      const top = rankings[unit][metric];
      if (top.length < 2 || Number(top[0].value) <= Number(top[1].value)) continue;
      champions[unit][metric] = { period: top[0].period, value: Number(top[0].value) };
    }
  }
  return champions;
}

function highWaterEventId(sourceDatabase, input) {
  return Number(
    sourceDatabase
      .prepare(
        `SELECT MAX(id) AS id FROM events
         ${input.where}`,
      )
      .get(...input.params)?.id ?? -1,
  );
}

function finishBuild(database, input, expectedDataVersion, sourceFrozen) {
  const { mode } = input;
  const { WORK_TABLE, CACHE_TABLE, OPERATION_TABLE, DIRTY_TABLE } = recordTables(mode);
  assertDataVersion(input.sourceDatabase, expectedDataVersion, sourceFrozen);
  if (database.prepare(`SELECT 1 FROM ${WORK_TABLE} LIMIT 1`).get()) {
    throw recordError("USAGE_RECORD_STATE_INVALID", "record work remains before publication");
  }
  const rankings = buildRankState(database, mode);
  const champions = championsFromRankState(rankings);
  const last =
    mode === "history"
      ? input.sourceDatabase
          .prepare(`SELECT timestamp_ms,history_ordinal FROM events ${input.where}
        ORDER BY timestamp_ms DESC,history_ordinal DESC LIMIT 1`)
          .get(...input.params)
      : null;
  database
    .prepare(
      `UPDATE ${CACHE_TABLE}
       SET published_facts_key = ?, state = 'complete', last_event_id = ?,
         ${mode === "history" ? "last_ms = ?," : ""} champion_json = ?
       WHERE slot = 1 AND stable_key = ?`,
    )
    .run(
      input.factsKey,
      ...(mode === "history"
        ? [Number(last?.history_ordinal ?? -1), Number(last?.timestamp_ms ?? START_MS)]
        : [highWaterEventId(input.sourceDatabase, input)]),
      JSON.stringify(champions),
      input.key,
    );
  database.prepare(`UPDATE ${OPERATION_TABLE} SET rebuild_required = 0 WHERE slot = 1`).run();
  clearAppendMembers(database, mode);
  database.prepare(`DELETE FROM ${DIRTY_TABLE}`).run();
  return champions;
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

function dataVersion(database) {
  return Number(database.prepare("PRAGMA data_version").get().data_version);
}

function assertDataVersion(database, expected, frozen) {
  if (!frozen && dataVersion(database) !== expected) {
    throw recordError("USAGE_RECORD_FACTS_CHANGED", "events changed while building stored record champions");
  }
}

function isSnapshotLock(error) {
  return /database (?:table )?is locked|SQLITE_BUSY|snapshot/i.test(String(error?.message || ""));
}

function buildFullWork(input, options, rate, batchSize, destinationInTransaction, sourceFrozen, expectedDataVersion) {
  const { database, sourceDatabase, mode } = input;
  const { WORK_TABLE, CACHE_TABLE } = recordTables(mode);
  const cursor = sourceDatabase
    .prepare(`${eventSql(mode)}
    ${input.where} ${input.where ? "AND" : "WHERE"} ${cursorSql(mode)}`)
    .iterate(...input.params, ...cursorParams(cacheRow(database, mode), mode));
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      cursor.return?.();
    }
  };
  const readState = database.prepare(`SELECT * FROM ${WORK_TABLE} WHERE unit = ? AND period_key = ?`);
  const writeState = database.prepare(`INSERT INTO ${WORK_TABLE}
    (unit, period_key, last_event_id, ${PERIOD_VALUE_COLUMNS})
    VALUES (?, ?, -1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
    ON CONFLICT(unit, period_key) DO UPDATE SET
      ${[...PERIOD_SCALAR_COLUMNS, "minimum_ms", "maximum_ms"].map((column) => `${column} = excluded.${column}`).join(", ")}`);
  const saveProgress = database.prepare(`UPDATE ${CACHE_TABLE} SET last_event_id = ?
    ${mode === "history" ? ", last_ms = ?" : ""} WHERE slot = 1`);
  try {
    while (true) {
      assertDataVersion(sourceDatabase, expectedDataVersion, sourceFrozen);
      const step = () => {
        const states = new Map();
        let processed = 0;
        const current = cacheRow(database, mode);
        let lastEventId = Number(current.last_event_id),
          lastMs = Number(current.last_ms);
        while (processed < batchSize) {
          const next = cursor.next();
          if (next.done) break;
          const row = next.value;
          const keys = eventPeriodKeys(row, input.zone);
          const estimate = options.estimateRow(row);
          for (const unit of ["day", "week", "month"]) {
            const periodKey = keys[unit];
            const identity = `${unit}\0${periodKey}`;
            let state = states.get(identity);
            if (!state) {
              state = readState.get(unit, periodKey) ?? {
                unit,
                period_key: periodKey,
                minimum_ms: Number(row.timestamp_ms),
                maximum_ms: Number(row.timestamp_ms),
                ...Object.fromEntries(PERIOD_SCALAR_COLUMNS.map((column) => [column, 0])),
              };
              for (const column of PERIOD_SCALAR_COLUMNS) state[column] = Number(state[column]);
              states.set(identity, state);
            }
            accumulateEvent(row, rate, estimate, state);
            state.minimum_ms = Math.min(Number(state.minimum_ms), Number(row.timestamp_ms));
            state.maximum_ms = Math.max(Number(state.maximum_ms), Number(row.timestamp_ms));
          }
          lastEventId = Number(row.id);
          lastMs = Number(row.timestamp_ms);
          processed += 1;
        }
        for (const state of states.values()) {
          writeState.run(
            state.unit,
            state.period_key,
            ...PERIOD_SCALAR_COLUMNS.map((column) => state[column]),
            state.minimum_ms,
            state.maximum_ms,
          );
        }
        saveProgress.run(lastEventId, ...(mode === "history" ? [lastMs] : []));
        return { unit: "full", periodKey: "", lastEventId, processed, workComplete: processed < batchSize };
      };
      const batch = destinationInTransaction ? step() : transaction(database, step);
      if (batch.processed) options.afterBatch?.(batch);
      if (batch.workComplete) break;
    }
  } catch (error) {
    release();
    if (isSnapshotLock(error)) assertDataVersion(sourceDatabase, expectedDataVersion, sourceFrozen);
    throw error;
  } finally {
    release();
  }
  while (true) {
    const work = nextWork(database, mode);
    if (!work) break;
    const step = () => {
      assertDataVersion(sourceDatabase, expectedDataVersion, sourceFrozen);
      const unit = String(work.unit),
        periodKey = String(work.period_key);
      mergeWorkPeriod(
        database,
        sourceDatabase,
        input,
        unit,
        periodKey,
        periodPredicate(unit, periodKey, input.zone, work),
      );
    };
    if (destinationInTransaction) step();
    else transaction(database, step);
  }
}

function readAppendState(database, unit, periodKey, timestamp) {
  const row =
    database
      .prepare(`SELECT ${PERIOD_VALUE_SELECT} FROM ${WORK_TABLE} WHERE unit = ? AND period_key = ?`)
      .get(unit, periodKey) ??
    database
      .prepare(`SELECT ${PERIOD_VALUE_SELECT} FROM ${PERIOD_TABLE} WHERE unit = ? AND period_key = ?`)
      .get(unit, periodKey);
  const state = row
    ? Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value]))
    : {
        minimum_ms: Number(timestamp),
        maximum_ms: Number(timestamp),
        ...Object.fromEntries(PERIOD_SCALAR_COLUMNS.map((column) => [column, 0])),
      };
  state.unit = unit;
  state.period_key = periodKey;
  for (const column of [...PERIOD_SCALAR_COLUMNS, "session_count", "model_count", "minimum_ms", "maximum_ms"]) {
    state[column] = Number(state[column] || 0);
  }
  state.minimum_ms = Math.min(state.minimum_ms, Number(timestamp));
  state.maximum_ms = Math.max(state.maximum_ms, Number(timestamp));
  return state;
}

function buildAppendWork(input, options, rate, batchSize, expectedDataVersion) {
  const { database, sourceDatabase } = input;
  let lastEventId = Number(cacheRow(database).last_event_id);
  const cursor = sourceDatabase
    .prepare(`${RECORD_EVENT_SQL}
      ${input.where} ${input.where ? "AND" : "WHERE"} id > ? ORDER BY id ASC`)
    .iterate(...input.params, lastEventId);
  const writeWork = database.prepare(`INSERT INTO ${WORK_TABLE}
    (unit, period_key, last_event_id, ${PERIOD_VALUE_COLUMNS})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
    ON CONFLICT(unit, period_key) DO UPDATE SET
      last_event_id = excluded.last_event_id,
      ${[...PERIOD_SCALAR_COLUMNS, "minimum_ms", "maximum_ms"].map((column) => `${column} = excluded.${column}`).join(", ")}`);
  const stageMember = database.prepare(
    `INSERT OR IGNORE INTO ${APPEND_MEMBER_TABLE} (unit, period_key, kind, member) VALUES (?, ?, ?, ?)`,
  );
  const saveProgress = database.prepare(`UPDATE ${CACHE_TABLE} SET last_event_id = ? WHERE slot = 1`);
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      cursor.return?.();
    }
  };
  try {
    while (true) {
      assertDataVersion(sourceDatabase, expectedDataVersion, false);
      const rows = [];
      let cursorDone = false;
      while (rows.length < batchSize && !cursorDone) {
        const next = cursor.next();
        if (next.done) cursorDone = true;
        else rows.push(next.value);
      }
      if (rows.length === 0) break;
      const step = () => {
        assertDataVersion(sourceDatabase, expectedDataVersion, false);
        if (operationState(database) !== 0) {
          throw recordError("USAGE_RECORD_FACTS_CHANGED", "events changed after append classification");
        }
        const states = new Map();
        for (const row of rows) {
          const estimate = options.estimateRow(row);
          const keys = eventPeriodKeys(row, input.zone);
          for (const unit of ["day", "week", "month"]) {
            const periodKey = keys[unit];
            const identity = `${unit}\0${periodKey}`;
            let state = states.get(identity);
            if (!state) {
              state = readAppendState(database, unit, periodKey, row.timestamp_ms);
              states.set(identity, state);
            }
            accumulateEvent(row, rate, estimate, state);
            state.minimum_ms = Math.min(state.minimum_ms, Number(row.timestamp_ms));
            state.maximum_ms = Math.max(state.maximum_ms, Number(row.timestamp_ms));
            stageMember.run(unit, periodKey, "session", String(row.session_id));
            stageMember.run(unit, periodKey, "model", String(row.model));
          }
        }
        const nextLastEventId = Number(rows.at(-1).id);
        for (const state of states.values()) {
          state.last_event_id = nextLastEventId;
          writeWork.run(
            state.unit,
            state.period_key,
            state.last_event_id,
            ...PERIOD_SCALAR_COLUMNS.map((column) => state[column]),
            state.minimum_ms,
            state.maximum_ms,
          );
        }
        saveProgress.run(nextLastEventId);
        return {
          unit: "append",
          periodKey: "",
          lastEventId: nextLastEventId,
          processed: rows.length,
          workComplete: cursorDone,
        };
      };
      const batch = transaction(database, step);
      lastEventId = batch.lastEventId;
      options.afterBatch?.(batch);
      if (batch.workComplete) break;
    }
  } catch (error) {
    release();
    if (isSnapshotLock(error)) assertDataVersion(sourceDatabase, expectedDataVersion, false);
    throw error;
  } finally {
    release();
  }
  return lastEventId;
}

function mergeAppendMembers(database) {
  database
    .prepare(
      `INSERT OR IGNORE INTO ${MEMBER_TABLE} (unit, period_key, kind, member)
       SELECT unit, period_key, kind, member FROM ${APPEND_MEMBER_TABLE}`,
    )
    .run();
  clearAppendMembers(database);
}

function writePublishedPeriod(database, state) {
  database
    .prepare(
      `INSERT INTO ${PERIOD_TABLE} (unit, period_key, ${PERIOD_VALUE_SELECT})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(unit, period_key) DO UPDATE SET
         total_tokens = excluded.total_tokens,
         input_tokens = excluded.input_tokens,
         cached_tokens = excluded.cached_tokens,
         output_tokens = excluded.output_tokens,
         reasoning_tokens = excluded.reasoning_tokens,
         total_cost = excluded.total_cost,
         input_cost = excluded.input_cost,
         cached_cost = excluded.cached_cost,
         output_cost = excluded.output_cost,
         session_count = excluded.session_count,
         model_count = excluded.model_count,
         minimum_ms = excluded.minimum_ms,
         maximum_ms = excluded.maximum_ms`,
    )
    .run(
      state.unit,
      state.period_key,
      ...PERIOD_SCALAR_COLUMNS.map((column) => state[column]),
      state.session_count,
      state.model_count,
      state.minimum_ms,
      state.maximum_ms,
    );
}

function publishAppend(database, input, expectedDataVersion) {
  return transaction(database, () => {
    assertDataVersion(input.sourceDatabase, expectedDataVersion, false);
    if (operationState(database) !== 0) {
      throw recordError("USAGE_RECORD_FACTS_CHANGED", "events changed after append classification");
    }
    mergeAppendMembers(database);
    const workIterator = database
      .prepare(
        `SELECT unit, period_key, ${PERIOD_VALUE_SELECT}
         FROM ${WORK_TABLE}
         ORDER BY CASE unit WHEN 'day' THEN 1 WHEN 'week' THEN 2 ELSE 3 END, period_key`,
      )
      .iterate();
    try {
      while (true) {
        const next = workIterator.next();
        if (next.done) break;
        const state = next.value;
        refreshWorkCounts(database, String(state.unit), String(state.period_key));
        state.session_count = Number(
          database
            .prepare(`SELECT session_count FROM ${WORK_TABLE} WHERE unit = ? AND period_key = ?`)
            .get(state.unit, state.period_key).session_count,
        );
        state.model_count = Number(
          database
            .prepare(`SELECT model_count FROM ${WORK_TABLE} WHERE unit = ? AND period_key = ?`)
            .get(state.unit, state.period_key).model_count,
        );
        writePublishedPeriod(database, state);
      }
    } finally {
      workIterator.return?.();
    }
    const rankings = buildRankState(database);
    const champions = championsFromRankState(rankings);
    database
      .prepare(
        `UPDATE ${CACHE_TABLE}
         SET published_facts_key = ?, state = 'complete', champion_json = ?
         WHERE slot = 1 AND stable_key = ? AND target_facts_key = ?`,
      )
      .run(input.factsKey, JSON.stringify(champions), input.key, input.factsKey);
    database.prepare(`UPDATE ${OPERATION_TABLE} SET rebuild_required = 0 WHERE slot = 1`).run();
    clearWork(database);
    database.prepare(`DELETE FROM ${DIRTY_TABLE}`).run();
    return champions;
  });
}

function nextWork(database, mode = "hot") {
  const { WORK_TABLE } = recordTables(mode);
  return database
    .prepare(
      `SELECT unit, period_key, last_event_id, minimum_ms, maximum_ms
       FROM ${WORK_TABLE}
       ORDER BY CASE unit WHEN 'day' THEN 1 WHEN 'week' THEN 2 ELSE 3 END, period_key
       LIMIT 1`,
    )
    .get();
}

/**
 * Build or incrementally update one bounded, persistent record projection.
 *
 * `key` identifies stable pricing/evidence/zone/scope inputs. `factsKey` identifies only event facts.
 * Event changes mark old and new calendar periods dirty. Only dirty periods are rescanned until all
 * affected periods are complete, then one new facts-key result is published.
 *
 * @param {{
 *   database: import("node:sqlite").DatabaseSync,
 *   sourceDatabase?: import("node:sqlite").DatabaseSync,
 *   mode?: string,
 *   key: string,
 *   factsKey: string,
 *   zone: string,
 *   where?: string,
 *   params?: unknown[],
 *   estimateRow: (row: Record<string, unknown>) => Record<string, unknown>,
 *   usdToCnyRate?: number,
 *   batchSize?: number,
 *   afterBatch?: ((batch: {
 *     unit: string, periodKey: string, lastEventId: number, processed: number,
 *     workComplete: boolean
 *   }) => void) | null,
 * }} options
 * @returns {Record<string, Record<string, { period: string, value: number }>>}
 */
export function buildStoredRecordChampions(options) {
  const input = normalizeInput(options);
  if (typeof options.estimateRow !== "function") throw new TypeError("estimateRow must be a function");
  if (options.afterBatch !== undefined && options.afterBatch !== null && typeof options.afterBatch !== "function") {
    throw new TypeError("afterBatch must be a function when provided");
  }
  const rate = options.usdToCnyRate === undefined ? 1 : Number(options.usdToCnyRate);
  if (!Number.isFinite(rate) || rate <= 0) throw new TypeError("usdToCnyRate must be a positive number");
  const batchSize = options.batchSize === undefined ? DEFAULT_BATCH_SIZE : Number(options.batchSize);
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > 10_000) {
    throw new TypeError("batchSize must be an integer between 1 and 10000");
  }
  const { database, sourceDatabase, mode } = input;
  const { WORK_TABLE } = recordTables(mode);
  const destinationInTransaction = database.isTransaction === true;
  const sourceFrozen = sourceDatabase.isTransaction === true;
  const allowAppend = mode !== "history" && sourceDatabase === database && !destinationInTransaction && !sourceFrozen;

  const run = () => {
    ensureSchema(database, sourceDatabase === database, mode);
    const expectedDataVersion = sourceFrozen ? null : dataVersion(sourceDatabase);
    const published = destinationInTransaction
      ? prepareCandidate(database, sourceDatabase, input, allowAppend)
      : transaction(database, () => prepareCandidate(database, sourceDatabase, input, allowAppend));
    if (published !== null) return published;

    const buildMode = cacheRow(database, mode).build_mode;
    if (buildMode === "full") {
      buildFullWork(input, options, rate, batchSize, destinationInTransaction, sourceFrozen, expectedDataVersion);
    } else if (buildMode === "append") {
      buildAppendWork(input, options, rate, batchSize, expectedDataVersion);
      return publishAppend(database, input, expectedDataVersion);
    }

    while (true) {
      const work = nextWork(database, mode);
      if (!work) break;
      const unit = String(work.unit);
      const periodKey = String(work.period_key);
      const predicate = periodPredicate(unit, periodKey, input.zone, work);
      const selectEvents = sourceDatabase.prepare(`
        ${eventSql(mode)}
        ${input.where} ${input.where ? "AND" : "WHERE"} (${predicate.sql}) AND ${cursorSql(mode)}
      `);
      const initial = database
        .prepare(
          `SELECT last_event_id ${mode === "history" ? ",last_ms" : ""} FROM ${WORK_TABLE} WHERE unit = ? AND period_key = ?`,
        )
        .get(unit, periodKey);
      if (!initial) throw recordError("USAGE_RECORD_STATE_INVALID", "record work item changed while building");
      const iterator = selectEvents.iterate(...input.params, ...predicate.params, ...cursorParams(initial, mode));
      let iteratorReleased = false;
      const releaseIterator = () => {
        if (!iteratorReleased) {
          iteratorReleased = true;
          iterator.return();
        }
      };
      try {
        let cursorDone = false;
        while (true) {
          const rows = [];
          while (rows.length < batchSize && !cursorDone) {
            const next = iterator.next();
            if (next.done) cursorDone = true;
            else rows.push(next.value);
          }
          const workComplete = cursorDone;
          const step = () => {
            const current = database
              .prepare(
                `SELECT last_event_id, ${mode === "history" ? "last_ms," : ""} ${PERIOD_VALUE_COLUMNS}
                 FROM ${WORK_TABLE} WHERE unit = ? AND period_key = ?`,
              )
              .get(unit, periodKey);
            if (!current) throw recordError("USAGE_RECORD_STATE_INVALID", "record work item changed while building");
            current.period_key = periodKey;
            for (const field of PERIOD_SCALAR_COLUMNS) current[field] = Number(current[field]);
            for (const row of rows) {
              accumulateEvent(row, rate, options.estimateRow(row), current);
            }
            const lastEventId = rows.length > 0 ? Number(rows.at(-1).id) : Number(current.last_event_id);
            const lastMs = rows.length > 0 ? Number(rows.at(-1).timestamp_ms) : Number(current.last_ms);
            if (rows.length > 0) {
              database
                .prepare(
                  `UPDATE ${WORK_TABLE}
                   SET last_event_id = ?, ${mode === "history" ? "last_ms = ?," : ""} total_tokens = ?, input_tokens = ?, cached_tokens = ?,
                     output_tokens = ?, reasoning_tokens = ?, total_cost = ?, input_cost = ?,
                     cached_cost = ?, output_cost = ?
                   WHERE unit = ? AND period_key = ?`,
                )
                .run(
                  lastEventId,
                  ...(mode === "history" ? [lastMs] : []),
                  ...PERIOD_SCALAR_COLUMNS.map((field) => current[field]),
                  unit,
                  periodKey,
                );
            }
            if (workComplete) mergeWorkPeriod(database, sourceDatabase, input, unit, periodKey, predicate);
            return { unit, periodKey, lastEventId, processed: rows.length, workComplete };
          };
          assertDataVersion(sourceDatabase, expectedDataVersion, sourceFrozen);
          const batch = destinationInTransaction ? step() : transaction(database, step);
          if (batch.processed > 0) options.afterBatch?.(batch);
          if (batch.workComplete) break;
        }
      } catch (error) {
        releaseIterator();
        if (isSnapshotLock(error)) {
          assertDataVersion(sourceDatabase, expectedDataVersion, sourceFrozen);
        }
        throw error;
      } finally {
        releaseIterator();
      }
    }

    assertDataVersion(sourceDatabase, expectedDataVersion, sourceFrozen);
    if (destinationInTransaction) return finishBuild(database, input, expectedDataVersion, sourceFrozen);
    return transaction(database, () => finishBuild(database, input, expectedDataVersion, sourceFrozen));
  };

  if (!destinationInTransaction) return run();
  database.exec(`SAVEPOINT ${BUILD_SAVEPOINT}`);
  try {
    const result = run();
    database.exec(`RELEASE ${BUILD_SAVEPOINT}`);
    return result;
  } catch (error) {
    database.exec(`ROLLBACK TO ${BUILD_SAVEPOINT}`);
    database.exec(`RELEASE ${BUILD_SAVEPOINT}`);
    throw error;
  }
}
