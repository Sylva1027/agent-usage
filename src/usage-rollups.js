const TABLE = "usage_rollup_daily";
const DAY_TABLE = "usage_rollup_days";
const MODEL_TABLE = "usage_rollup_models";
const REPOSITORY_TABLE = "usage_rollup_repositories";
const SESSION_TABLE = "usage_rollup_sessions";
const FORMAT_TABLE = "usage_rollup_format";
const DIRTY_TABLE = "usage_rollup_dirty_days";
const EVENT_TABLE = "events";
const PROGRESS_TABLE = "usage_rollup_progress";
const PROGRESS_DAY_TABLE = "usage_rollup_progress_days";
const COMPLETE_EVENT_TABLE = "usage_rollup_complete_events";
const COMPLETE_EVENT_SOURCE = `temp.${COMPLETE_EVENT_TABLE}`;
const FORMAT_VERSION = 8;
const PROGRESS_FORMAT_VERSION = 1;
const DAY_MS = 86_400_000;
const INSERT_TRIGGER = "usage_rollup_invalidate_insert";
const UPDATE_TRIGGER = "usage_rollup_invalidate_update";
const DELETE_TRIGGER = "usage_rollup_invalidate_delete";
const PROGRESS_REPLACE_TRIGGER = "usage_rollup_progress_invalidate_replace";
const PROGRESS_INSERT_TRIGGER = "usage_rollup_progress_invalidate_insert";
const PROGRESS_UPDATE_TRIGGER = "usage_rollup_progress_invalidate_update";
const PROGRESS_DELETE_TRIGGER = "usage_rollup_progress_invalidate_delete";
const PROGRESS_DAY_INSERT_TRIGGER = "usage_rollup_progress_day_insert";
const WRITE_SAVEPOINT = "usage_rollups_write";
export const USAGE_ROLLUP_PROGRESS_TABLES = Object.freeze([PROGRESS_TABLE, PROGRESS_DAY_TABLE]);
const modelGroupSql = (canonicalModels) => (canonicalModels ? "usage_model_group(model)" : "model");
const utcDirtyDaySql = (timestamp) => `date(${timestamp} / 1000.0, 'unixepoch')`;
const detailSum = (expression) => `COALESCE(SUM(${expression}), 0)`;
const DETAIL_SUM = {
  total: detailSum("total"),
  input: detailSum("input"),
  cached: detailSum("cached"),
  output: detailSum("output"),
  reasoning: detailSum("reasoning"),
  inputKnownTokens: detailSum("CASE WHEN (detail_mask & 1) != 0 THEN input ELSE 0 END"),
  inputUnavailableTokens: detailSum("CASE WHEN (detail_mask & 1) = 0 THEN total ELSE 0 END"),
  outputKnownTokens: detailSum("CASE WHEN (detail_mask & 4) != 0 THEN output ELSE 0 END"),
  outputUnavailableTokens: detailSum("CASE WHEN (detail_mask & 4) = 0 THEN total ELSE 0 END"),
  cachedKnownTokens: detailSum("CASE WHEN (detail_mask & 2) != 0 THEN cached ELSE 0 END"),
  cachedUnavailableTokens: detailSum("CASE WHEN (detail_mask & 2) = 0 THEN total ELSE 0 END"),
  reasoningKnownTokens: detailSum("CASE WHEN (detail_mask & 8) != 0 THEN reasoning ELSE 0 END"),
  reasoningUnavailableTokens: detailSum("CASE WHEN (detail_mask & 8) = 0 THEN total ELSE 0 END"),
  uncachedInput: detailSum("CASE WHEN (detail_mask & 3) = 3 THEN MAX(input - cached, 0) ELSE 0 END"),
  uncachedInputUnavailableTokens: detailSum("CASE WHEN (detail_mask & 3) != 3 THEN total ELSE 0 END"),
  cacheRateInput: detailSum("CASE WHEN (detail_mask & 3) = 3 THEN input ELSE 0 END"),
  cacheRateCached: detailSum("CASE WHEN (detail_mask & 3) = 3 THEN cached ELSE 0 END"),
  unattributedDetailTokens: detailSum("CASE WHEN (detail_mask & 15) != 15 THEN total ELSE 0 END"),
  inconsistentTokens: detailSum("CASE WHEN (detail_mask & 16) != 0 THEN total ELSE 0 END"),
  reconciliationGap: detailSum("reconciliation_gap"),
};
const MODEL_DETAIL_FIELDS = [
  ["total", DETAIL_SUM.total],
  ["input", DETAIL_SUM.inputKnownTokens],
  ["input_unavailable_tokens", DETAIL_SUM.inputUnavailableTokens],
  ["cached", DETAIL_SUM.cachedKnownTokens],
  ["cached_unavailable_tokens", DETAIL_SUM.cachedUnavailableTokens],
  ["uncached_input_tokens", DETAIL_SUM.uncachedInput],
  ["uncached_input_unavailable_tokens", DETAIL_SUM.uncachedInputUnavailableTokens],
  ["cache_rate_input_tokens", DETAIL_SUM.cacheRateInput],
  ["cache_rate_cached_tokens", DETAIL_SUM.cacheRateCached],
  ["output", DETAIL_SUM.outputKnownTokens],
  ["output_unavailable_tokens", DETAIL_SUM.outputUnavailableTokens],
  ["reasoning", DETAIL_SUM.reasoningKnownTokens],
  ["reasoning_unavailable_tokens", DETAIL_SUM.reasoningUnavailableTokens],
  ["unattributed_detail_tokens", DETAIL_SUM.unattributedDetailTokens],
  ["inconsistent_tokens", DETAIL_SUM.inconsistentTokens],
  ["reconciliation_gap_tokens", DETAIL_SUM.reconciliationGap],
];
const MODEL_DETAIL_COLUMNS = MODEL_DETAIL_FIELDS.map(([column]) => column).join(", ");
const MODEL_DETAIL_SELECT = MODEL_DETAIL_FIELDS.map(([, expression]) => expression).join(", ");
const MODEL_TOTAL_SELECT = MODEL_DETAIL_FIELDS.map(([column]) => `COALESCE(SUM(${column}), 0) AS ${column}`).join(", ");
const MODEL_DETAIL_ALIASED_SELECT = MODEL_DETAIL_FIELDS.map(
  ([column, expression]) => `${expression} AS ${column}`,
).join(", ");
const MODEL_VALUE_FIELDS = [
  "total",
  "input",
  "inputUnavailableTokens",
  "cached",
  "cachedUnavailableTokens",
  "uncachedInput",
  "uncachedInputUnavailableTokens",
  "cacheRateInput",
  "cacheRateCached",
  "output",
  "outputUnavailableTokens",
  "reasoning",
  "reasoningUnavailableTokens",
  "unattributedDetailTokens",
  "inconsistentTokens",
  "reconciliationGap",
];
const modelRollupRow = (row) => ({
  model: String(row.model),
  total: Number(row.total),
  input: Number(row.input),
  inputUnavailableTokens: Number(row.input_unavailable_tokens),
  cached: Number(row.cached),
  cachedUnavailableTokens: Number(row.cached_unavailable_tokens),
  uncachedInput: Number(row.uncached_input_tokens),
  uncachedInputUnavailableTokens: Number(row.uncached_input_unavailable_tokens),
  cacheRateInput: Number(row.cache_rate_input_tokens),
  cacheRateCached: Number(row.cache_rate_cached_tokens),
  output: Number(row.output),
  outputUnavailableTokens: Number(row.output_unavailable_tokens),
  reasoning: Number(row.reasoning),
  reasoningUnavailableTokens: Number(row.reasoning_unavailable_tokens),
  unattributedDetailTokens: Number(row.unattributed_detail_tokens),
  inconsistentTokens: Number(row.inconsistent_tokens),
  reconciliationGap: Number(row.reconciliation_gap_tokens),
});

function mergeModelRollupRows(rows) {
  const merged = new Map();
  for (const row of rows) {
    let target = merged.get(row.model);
    if (!target) {
      target = { model: row.model };
      for (const field of MODEL_VALUE_FIELDS) target[field] = 0;
      merged.set(row.model, target);
    }
    for (const field of MODEL_VALUE_FIELDS) target[field] += row[field];
  }
  return [...merged.values()].sort((left, right) => (left.model < right.model ? -1 : left.model > right.model ? 1 : 0));
}

function repositoryRollupRow(row) {
  return {
    key: String(row.key),
    name: String(row.name),
    kind: String(row.kind),
    pathCount: Number(row.path_count),
    ...Object.fromEntries(
      MODEL_VALUE_FIELDS.map((field, index) => [field, Number(row[MODEL_DETAIL_FIELDS[index][0]])]),
    ),
  };
}

function queryRawModelRollupRows(db, startMs, endMs, excludeHomes, canonicalModels) {
  const homeFilter = excludeHomes.length > 0 ? `AND home_id NOT IN (${excludeHomes.map(() => "?").join(", ")})` : "";
  const groupSql = modelGroupSql(canonicalModels);
  return db
    .prepare(`
      SELECT ${groupSql} AS model, ${MODEL_DETAIL_ALIASED_SELECT}
      FROM events
      WHERE timestamp_ms >= ? AND timestamp_ms < ? ${homeFilter}
      GROUP BY ${groupSql}
      ORDER BY model ASC
    `)
    .all(startMs, endMs, ...excludeHomes)
    .map(modelRollupRow);
}

function calendarZone(zone = "utc") {
  if (zone !== "utc" && zone !== "local") {
    throw new TypeError(`calendarZone must be "utc" or "local": ${String(zone)}`);
  }
  return zone;
}

function dayParts(day) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new TypeError(`day must be a YYYY-MM-DD string: ${String(day)}`);
  }
  const [year, month, date] = day.split("-").map(Number);
  return { year, month, date };
}

function localDayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayBounds(day, zone = "utc") {
  zone = calendarZone(zone);
  const { year, month, date } = dayParts(day);
  const start = zone === "utc" ? Date.UTC(year, month - 1, date) : new Date(year, month - 1, date).getTime();
  const next = zone === "utc" ? Date.UTC(year, month - 1, date + 1) : new Date(year, month - 1, date + 1).getTime();
  const startDate = new Date(start);
  const actualDay = zone === "utc" ? startDate.toISOString().slice(0, 10) : localDayKey(startDate);
  if (!Number.isFinite(start) || actualDay !== day) {
    throw new RangeError(`invalid ${zone} day: ${day}`);
  }
  return { start, end: next };
}

function calendarDays(startDay, endDay, zone = "utc") {
  const start = dayBounds(startDay, zone);
  const end = dayBounds(endDay, zone);
  if (start.start > end.start) {
    throw new RangeError(`startDay must not be after endDay: ${startDay} > ${endDay}`);
  }
  const days = [];
  for (let cursor = new Date(start.start); cursor.getTime() <= end.start; ) {
    days.push(zone === "utc" ? cursor.toISOString().slice(0, 10) : localDayKey(cursor));
    if (zone === "utc") cursor = new Date(cursor.getTime() + DAY_MS);
    else cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
  }
  return days;
}

function missingRollupDaysError(days) {
  return Object.assign(new Error(`usage rollups missing for day(s): ${days.join(", ")}`), {
    code: "ROLLUP_DAYS_MISSING",
    missingDays: days,
  });
}

function missingRollupCacheError() {
  return Object.assign(new Error("usage rollups cache missing"), {
    code: "ROLLUP_CACHE_MISSING",
  });
}

function withReadSnapshot(db, read) {
  db.exec("SAVEPOINT usage_rollups_read");
  try {
    const result = read();
    db.exec("RELEASE usage_rollups_read");
    return result;
  } catch (error) {
    db.exec("ROLLBACK TO usage_rollups_read");
    db.exec("RELEASE usage_rollups_read");
    throw error;
  }
}

function withWriteTransaction(db, write) {
  db.exec(`SAVEPOINT ${WRITE_SAVEPOINT}`);
  try {
    const result = write();
    db.exec(`RELEASE ${WRITE_SAVEPOINT}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO ${WRITE_SAVEPOINT}`);
    db.exec(`RELEASE ${WRITE_SAVEPOINT}`);
    throw error;
  }
}

function rollupFormatVersion(db) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(FORMAT_TABLE);
  if (!exists) return null;
  const row = db.prepare(`SELECT format_version FROM ${FORMAT_TABLE} WHERE id = 1`).get();
  return row ? Number(row.format_version) : null;
}

function hasCurrentRollupFormat(db) {
  return rollupFormatVersion(db) === FORMAT_VERSION;
}

function normalizeTriggerSql(sql) {
  return String(sql ?? "")
    .replace(/;+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function coreTriggerDefinitions() {
  return [
    {
      name: INSERT_TRIGGER,
      table: EVENT_TABLE,
      sql: `CREATE TRIGGER ${INSERT_TRIGGER}
        AFTER INSERT ON events
        BEGIN
          INSERT INTO ${DIRTY_TABLE} (day_key)
            VALUES (${utcDirtyDaySql("NEW.timestamp_ms")}) ON CONFLICT(day_key) DO NOTHING;
          DELETE FROM ${DAY_TABLE}
          WHERE NEW.timestamp_ms >= start_ms AND NEW.timestamp_ms < end_ms;
        END`,
    },
    {
      name: UPDATE_TRIGGER,
      table: EVENT_TABLE,
      sql: `CREATE TRIGGER ${UPDATE_TRIGGER}
        AFTER UPDATE ON events
        BEGIN
          INSERT INTO ${DIRTY_TABLE} (day_key)
            VALUES (${utcDirtyDaySql("OLD.timestamp_ms")}) ON CONFLICT(day_key) DO NOTHING;
          INSERT INTO ${DIRTY_TABLE} (day_key)
            VALUES (${utcDirtyDaySql("NEW.timestamp_ms")}) ON CONFLICT(day_key) DO NOTHING;
          DELETE FROM ${DAY_TABLE}
          WHERE (OLD.timestamp_ms >= start_ms AND OLD.timestamp_ms < end_ms)
             OR (NEW.timestamp_ms >= start_ms AND NEW.timestamp_ms < end_ms);
        END`,
    },
    {
      name: DELETE_TRIGGER,
      table: EVENT_TABLE,
      sql: `CREATE TRIGGER ${DELETE_TRIGGER}
        AFTER DELETE ON events
        BEGIN
          INSERT INTO ${DIRTY_TABLE} (day_key)
            VALUES (${utcDirtyDaySql("OLD.timestamp_ms")}) ON CONFLICT(day_key) DO NOTHING;
          DELETE FROM ${DAY_TABLE}
          WHERE OLD.timestamp_ms >= start_ms AND OLD.timestamp_ms < end_ms;
        END`,
    },
  ];
}

function progressTriggerDefinitions(hasEventId) {
  const definitions = [
    {
      name: PROGRESS_UPDATE_TRIGGER,
      table: EVENT_TABLE,
      sql: `CREATE TRIGGER ${PROGRESS_UPDATE_TRIGGER}
        AFTER UPDATE ON events
        BEGIN
          UPDATE ${PROGRESS_TABLE} SET certified = 0 WHERE singleton = 1;
        END`,
    },
    {
      name: PROGRESS_DELETE_TRIGGER,
      table: EVENT_TABLE,
      sql: `CREATE TRIGGER ${PROGRESS_DELETE_TRIGGER}
        AFTER DELETE ON events
        BEGIN
          UPDATE ${PROGRESS_TABLE} SET certified = 0 WHERE singleton = 1;
        END`,
    },
    {
      name: PROGRESS_DAY_INSERT_TRIGGER,
      table: DAY_TABLE,
      sql: `CREATE TRIGGER ${PROGRESS_DAY_INSERT_TRIGGER}
        AFTER INSERT ON ${DAY_TABLE}
        BEGIN
          INSERT INTO ${PROGRESS_DAY_TABLE} (calendar_zone, day_key, start_ms, end_ms)
            VALUES (NEW.calendar_zone, NEW.day_key, NEW.start_ms, NEW.end_ms)
            ON CONFLICT(calendar_zone, day_key) DO UPDATE SET
              start_ms = excluded.start_ms,
              end_ms = excluded.end_ms;
        END`,
    },
  ];
  if (hasEventId) {
    definitions.push(
      {
        name: PROGRESS_REPLACE_TRIGGER,
        table: EVENT_TABLE,
        sql: `CREATE TRIGGER ${PROGRESS_REPLACE_TRIGGER}
          BEFORE INSERT ON events
          WHEN NEW.id >= 0 AND EXISTS (SELECT 1 FROM events WHERE id = NEW.id)
          BEGIN
            UPDATE ${PROGRESS_TABLE} SET certified = 0 WHERE singleton = 1;
            INSERT INTO ${DIRTY_TABLE} (day_key)
              SELECT ${utcDirtyDaySql("timestamp_ms")}
              FROM events
              WHERE id = NEW.id
              ON CONFLICT(day_key) DO NOTHING;
            DELETE FROM ${DAY_TABLE}
            WHERE EXISTS (
              SELECT 1
              FROM events
              WHERE events.id = NEW.id
                AND events.timestamp_ms >= ${DAY_TABLE}.start_ms
                AND events.timestamp_ms < ${DAY_TABLE}.end_ms
            );
          END`,
      },
      {
        name: PROGRESS_INSERT_TRIGGER,
        table: EVENT_TABLE,
        sql: `CREATE TRIGGER ${PROGRESS_INSERT_TRIGGER}
          AFTER INSERT ON events
          BEGIN
            UPDATE ${PROGRESS_TABLE}
            SET certified = 0
            WHERE singleton = 1 AND NEW.id <= last_id;
          END`,
      },
    );
  }
  return definitions;
}

function createTriggerDefinitions(db, definitions) {
  for (const definition of definitions) db.exec(definition.sql);
}

function tablesHaveColumns(db, requiredTables) {
  for (const [table, columns] of requiredTables) {
    if (!tableExists(db, table)) return false;
    try {
      const actual = new Set(
        db
          .prepare(`SELECT name FROM pragma_table_info('${table}')`)
          .all()
          .map((row) => String(row.name)),
      );
      if (columns.some((column) => !actual.has(column))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function triggersAreReady(db, definitions) {
  try {
    const placeholders = definitions.map(() => "?").join(", ");
    const rows = db
      .prepare(`
        SELECT name, tbl_name, sql FROM sqlite_master
        WHERE type = 'trigger' AND name IN (${placeholders})
      `)
      .all(...definitions.map(({ name }) => name));
    const actual = new Map(rows.map((row) => [String(row.name), row]));
    return definitions.every(({ name, table, sql }) => {
      const row = actual.get(name);
      return row && String(row.tbl_name) === table && normalizeTriggerSql(row.sql) === normalizeTriggerSql(sql);
    });
  } catch {
    return false;
  }
}

const CORE_TABLE_COLUMNS = new Map([
  [FORMAT_TABLE, ["id", "format_version"]],
  [DAY_TABLE, ["calendar_zone", "day_key", "start_ms", "end_ms"]],
  [
    TABLE,
    [
      "calendar_zone",
      "day_key",
      "home_id",
      "event_count",
      "total",
      "input",
      "cached",
      "output",
      "reasoning",
      "input_known_tokens",
      "input_unavailable_tokens",
      "output_known_tokens",
      "output_unavailable_tokens",
      "cached_known_tokens",
      "cached_unavailable_tokens",
      "reasoning_known_tokens",
      "reasoning_unavailable_tokens",
      "uncached_input_tokens",
      "uncached_input_unavailable_tokens",
      "cache_rate_input_tokens",
      "cache_rate_cached_tokens",
      "unattributed_detail_tokens",
      "inconsistent_tokens",
      "reconciliation_gap_tokens",
      "input_known_count",
      "cached_known_count",
      "output_known_count",
      "reasoning_known_count",
      "reconciliation_gap_count",
    ],
  ],
  [MODEL_TABLE, ["calendar_zone", "day_key", "home_id", "model", ...MODEL_DETAIL_FIELDS.map(([column]) => column)]],
  [
    REPOSITORY_TABLE,
    [
      "calendar_zone",
      "day_key",
      "home_id",
      "repository_key",
      "cwd",
      "repository_path",
      "repository_kind",
      ...MODEL_DETAIL_FIELDS.map(([column]) => column),
    ],
  ],
  [SESSION_TABLE, ["calendar_zone", "day_key", "home_id", "session_id"]],
  [DIRTY_TABLE, ["day_key"]],
]);

const PROGRESS_TABLE_COLUMNS = new Map([
  [
    PROGRESS_TABLE,
    ["singleton", "format_version", "rollup_format_version", "last_id", "certified", "local_zone_identity"],
  ],
  [PROGRESS_DAY_TABLE, ["calendar_zone", "day_key", "start_ms", "end_ms"]],
]);

function dropRollupCache(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS ${INSERT_TRIGGER};
    DROP TRIGGER IF EXISTS ${UPDATE_TRIGGER};
    DROP TRIGGER IF EXISTS ${DELETE_TRIGGER};
    DROP TRIGGER IF EXISTS ${PROGRESS_REPLACE_TRIGGER};
    DROP TRIGGER IF EXISTS ${PROGRESS_INSERT_TRIGGER};
    DROP TRIGGER IF EXISTS ${PROGRESS_UPDATE_TRIGGER};
    DROP TRIGGER IF EXISTS ${PROGRESS_DELETE_TRIGGER};
    DROP TRIGGER IF EXISTS ${PROGRESS_DAY_INSERT_TRIGGER};
    DROP TABLE IF EXISTS ${MODEL_TABLE};
    DROP TABLE IF EXISTS ${REPOSITORY_TABLE};
    DROP TABLE IF EXISTS ${TABLE};
    DROP TABLE IF EXISTS ${SESSION_TABLE};
    DROP TABLE IF EXISTS ${DIRTY_TABLE};
    DROP TABLE IF EXISTS ${PROGRESS_DAY_TABLE};
    DROP TABLE IF EXISTS ${PROGRESS_TABLE};
    DROP TABLE IF EXISTS ${DAY_TABLE};
    DROP TABLE IF EXISTS ${FORMAT_TABLE}
  `);
}

function ensureModelRollupSchema(db) {
  db.exec(`
      CREATE TABLE IF NOT EXISTS ${MODEL_TABLE} (
        calendar_zone TEXT NOT NULL,
        day_key TEXT NOT NULL,
        home_id TEXT NOT NULL,
        model TEXT NOT NULL,
        total INTEGER NOT NULL,
        input INTEGER NOT NULL,
        input_unavailable_tokens INTEGER NOT NULL,
        cached INTEGER NOT NULL,
        cached_unavailable_tokens INTEGER NOT NULL,
        uncached_input_tokens INTEGER NOT NULL,
        uncached_input_unavailable_tokens INTEGER NOT NULL,
        cache_rate_input_tokens INTEGER NOT NULL,
        cache_rate_cached_tokens INTEGER NOT NULL,
        output INTEGER NOT NULL,
        output_unavailable_tokens INTEGER NOT NULL,
        reasoning INTEGER NOT NULL,
        reasoning_unavailable_tokens INTEGER NOT NULL,
        unattributed_detail_tokens INTEGER NOT NULL,
        inconsistent_tokens INTEGER NOT NULL,
        reconciliation_gap_tokens INTEGER NOT NULL,
        PRIMARY KEY (calendar_zone, day_key, home_id, model)
      ) STRICT
    `);
}

function progressSchemaState(db) {
  const hasEventId = eventHasId(db);
  const coreTablesReady = tablesHaveColumns(db, CORE_TABLE_COLUMNS);
  const coreTriggersReady = triggersAreReady(db, coreTriggerDefinitions());
  const coreReady = coreTablesReady && coreTriggersReady;
  const progressTablesReady = tablesHaveColumns(db, PROGRESS_TABLE_COLUMNS);
  const progressTriggersReady = triggersAreReady(db, progressTriggerDefinitions(hasEventId));
  const rowReady =
    progressTablesReady &&
    (() => {
      try {
        const row = db.prepare(`SELECT format_version, rollup_format_version FROM ${PROGRESS_TABLE}`).get();
        return (
          row &&
          Number(row.format_version) === PROGRESS_FORMAT_VERSION &&
          Number(row.rollup_format_version) === FORMAT_VERSION
        );
      } catch {
        return false;
      }
    })();
  const progressReady = rowReady && progressTriggersReady;
  if (coreReady && progressReady) return "ready";

  const progressTriggerNames = progressTriggerDefinitions(true).map(({ name }) => name);
  const progressObjectsPresent =
    tableExists(db, PROGRESS_TABLE) ||
    tableExists(db, PROGRESS_DAY_TABLE) ||
    Boolean(
      db
        .prepare(`
          SELECT 1 FROM sqlite_master
          WHERE type = 'trigger' AND name IN (${progressTriggerNames.map(() => "?").join(", ")})
          LIMIT 1
        `)
        .get(...progressTriggerNames),
    );
  return coreReady && !progressObjectsPresent ? "missing" : "partial";
}

function createProgressSchema(db) {
  db.exec(`
    CREATE TABLE ${PROGRESS_TABLE} (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      format_version INTEGER NOT NULL,
      rollup_format_version INTEGER NOT NULL,
      last_id INTEGER NOT NULL,
      certified INTEGER NOT NULL CHECK (certified IN (0, 1)),
      local_zone_identity TEXT NOT NULL
    ) STRICT;
    INSERT INTO ${PROGRESS_TABLE}
      (singleton, format_version, rollup_format_version, last_id, certified, local_zone_identity)
      VALUES (1, ${PROGRESS_FORMAT_VERSION}, ${FORMAT_VERSION}, 0, 0, '');
    CREATE TABLE ${PROGRESS_DAY_TABLE} (
      calendar_zone TEXT NOT NULL,
      day_key TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      PRIMARY KEY (calendar_zone, day_key)
    ) STRICT;
  `);
  createTriggerDefinitions(db, progressTriggerDefinitions(eventHasId(db)));
}

export function ensureUsageRollupProgressSchema(db) {
  const state = progressSchemaState(db);
  if (state === "ready") return true;
  return withWriteTransaction(db, () => {
    const current = progressSchemaState(db);
    if (current === "ready") return true;
    if (current === "missing") {
      createProgressSchema(db);
    } else {
      dropRollupCache(db);
      ensureCurrentRollupFormat(db);
    }
    return progressSchemaState(db) === "ready";
  });
}

function ensureCurrentRollupFormat(db) {
  if (hasCurrentRollupFormat(db)) return;
  dropRollupCache(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${FORMAT_TABLE} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      format_version INTEGER NOT NULL
    ) STRICT;
    INSERT OR IGNORE INTO ${FORMAT_TABLE} (id, format_version) VALUES (1, ${FORMAT_VERSION});
    CREATE TABLE IF NOT EXISTS ${DAY_TABLE} (
      calendar_zone TEXT NOT NULL,
      day_key TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      PRIMARY KEY (calendar_zone, day_key)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      calendar_zone TEXT NOT NULL,
      day_key TEXT NOT NULL,
      home_id TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      total INTEGER NOT NULL,
      input INTEGER NOT NULL,
      cached INTEGER NOT NULL,
      output INTEGER NOT NULL,
      reasoning INTEGER NOT NULL,
      input_known_tokens INTEGER NOT NULL,
      input_unavailable_tokens INTEGER NOT NULL,
      output_known_tokens INTEGER NOT NULL,
      output_unavailable_tokens INTEGER NOT NULL,
      cached_known_tokens INTEGER NOT NULL,
      cached_unavailable_tokens INTEGER NOT NULL,
      reasoning_known_tokens INTEGER NOT NULL,
      reasoning_unavailable_tokens INTEGER NOT NULL,
      uncached_input_tokens INTEGER NOT NULL,
      uncached_input_unavailable_tokens INTEGER NOT NULL,
      cache_rate_input_tokens INTEGER NOT NULL,
      cache_rate_cached_tokens INTEGER NOT NULL,
      unattributed_detail_tokens INTEGER NOT NULL,
      inconsistent_tokens INTEGER NOT NULL,
      reconciliation_gap_tokens INTEGER NOT NULL,
      input_known_count INTEGER NOT NULL,
      cached_known_count INTEGER NOT NULL,
      output_known_count INTEGER NOT NULL,
      reasoning_known_count INTEGER NOT NULL,
      reconciliation_gap_count INTEGER NOT NULL,
      PRIMARY KEY (calendar_zone, day_key, home_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS ${REPOSITORY_TABLE} (
      calendar_zone TEXT NOT NULL,
      day_key TEXT NOT NULL,
      home_id TEXT NOT NULL,
      repository_key TEXT NOT NULL,
      cwd TEXT NOT NULL,
      repository_path TEXT NOT NULL,
      repository_kind TEXT NOT NULL,
      ${MODEL_DETAIL_FIELDS.map(([column]) => `${column} INTEGER NOT NULL`).join(",\n      ")},
      PRIMARY KEY (calendar_zone, day_key, home_id, repository_key, cwd)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS ${SESSION_TABLE} (
      calendar_zone TEXT NOT NULL,
      day_key TEXT NOT NULL,
      home_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      PRIMARY KEY (calendar_zone, day_key, home_id, session_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS ${DIRTY_TABLE} (
      day_key TEXT NOT NULL PRIMARY KEY
    ) STRICT;
    INSERT OR IGNORE INTO ${DIRTY_TABLE} (day_key)
      SELECT DISTINCT ${utcDirtyDaySql("timestamp_ms")} FROM events
  `);
  createTriggerDefinitions(db, coreTriggerDefinitions());
  ensureModelRollupSchema(db);
  ensureUsageRollupProgressSchema(db);
}

export function createUsageRollups(db) {
  if (hasCurrentRollupFormat(db)) {
    ensureModelRollupSchema(db);
    ensureUsageRollupProgressSchema(db);
    return;
  }
  withWriteTransaction(db, () => ensureCurrentRollupFormat(db));
}

export function rebuildUsageRollups(db, args) {
  return rebuildUsageRollupsFromSource(db, args, EVENT_TABLE);
}

function rebuildUsageRollupsFromSource(db, { days, calendarZone: zone = "utc" }, sourceTable) {
  if (!Array.isArray(days)) {
    throw new TypeError("days must be an array of YYYY-MM-DD strings");
  }
  zone = calendarZone(zone);
  const targets = [...new Set(days)].map((day) => ({ day, ...dayBounds(day, zone) }));
  withWriteTransaction(db, () => {
    ensureCurrentRollupFormat(db);
    if (targets.length === 0) return;
    const repositoryColumns =
      sourceTable === COMPLETE_EVENT_SOURCE
        ? 4
        : Number(
            db
              .prepare(`
                SELECT COUNT(*) AS count
                FROM pragma_table_info('events')
                WHERE name IN ('cwd', 'repository_key', 'repository_path', 'repository_kind')
              `)
              .get().count,
          );
    const canStoreRepositories = repositoryColumns === 4;
    // Model and repository rows store the 16 periodAggregate fields; detail values are known-only.
    ensureModelRollupSchema(db);
    const deleteDay = db.prepare(`DELETE FROM ${TABLE} WHERE calendar_zone = ? AND day_key = ?`);
    const deleteModels = db.prepare(`DELETE FROM ${MODEL_TABLE} WHERE calendar_zone = ? AND day_key = ?`);
    const deleteRepositories = db.prepare(`DELETE FROM ${REPOSITORY_TABLE} WHERE calendar_zone = ? AND day_key = ?`);
    const deleteSessions = db.prepare(`DELETE FROM ${SESSION_TABLE} WHERE calendar_zone = ? AND day_key = ?`);
    const markDay = db.prepare(
      `INSERT OR REPLACE INTO ${DAY_TABLE} (calendar_zone, day_key, start_ms, end_ms) VALUES (?, ?, ?, ?)`,
    );
    const insertDay = db.prepare(`
      INSERT INTO ${TABLE} (
        calendar_zone, day_key, home_id, event_count, total, input, cached, output, reasoning,
        input_known_tokens, input_unavailable_tokens, output_known_tokens, output_unavailable_tokens,
        cached_known_tokens, cached_unavailable_tokens, reasoning_known_tokens, reasoning_unavailable_tokens,
        uncached_input_tokens, uncached_input_unavailable_tokens,
        cache_rate_input_tokens, cache_rate_cached_tokens,
        unattributed_detail_tokens, inconsistent_tokens, reconciliation_gap_tokens,
        input_known_count, cached_known_count, output_known_count, reasoning_known_count,
        reconciliation_gap_count
      )
      SELECT
        ?,
        ?,
        home_id,
        COUNT(*),
        ${DETAIL_SUM.total},
        ${DETAIL_SUM.input},
        ${DETAIL_SUM.cached},
        ${DETAIL_SUM.output},
        ${DETAIL_SUM.reasoning},
        ${DETAIL_SUM.inputKnownTokens},
        ${DETAIL_SUM.inputUnavailableTokens},
        ${DETAIL_SUM.outputKnownTokens},
        ${DETAIL_SUM.outputUnavailableTokens},
        ${DETAIL_SUM.cachedKnownTokens},
        ${DETAIL_SUM.cachedUnavailableTokens},
        ${DETAIL_SUM.reasoningKnownTokens},
        ${DETAIL_SUM.reasoningUnavailableTokens},
        ${DETAIL_SUM.uncachedInput},
        ${DETAIL_SUM.uncachedInputUnavailableTokens},
        ${DETAIL_SUM.cacheRateInput},
        ${DETAIL_SUM.cacheRateCached},
        ${DETAIL_SUM.unattributedDetailTokens},
        ${DETAIL_SUM.inconsistentTokens},
        ${DETAIL_SUM.reconciliationGap},
        COUNT(CASE WHEN (detail_mask & 1) != 0 THEN 1 END),
        COUNT(CASE WHEN (detail_mask & 2) != 0 THEN 1 END),
        COUNT(CASE WHEN (detail_mask & 4) != 0 THEN 1 END),
        COUNT(CASE WHEN (detail_mask & 8) != 0 THEN 1 END),
        COUNT(CASE WHEN reconciliation_gap != 0 THEN 1 END)
      FROM ${sourceTable}
      WHERE timestamp_ms >= ? AND timestamp_ms < ?
      GROUP BY home_id
    `);
    const insertModels = db.prepare(`
      INSERT INTO ${MODEL_TABLE} (
        calendar_zone, day_key, home_id, model, ${MODEL_DETAIL_COLUMNS}
      )
      SELECT ?, ?, home_id, model, ${MODEL_DETAIL_SELECT}
      FROM ${sourceTable}
      WHERE timestamp_ms >= ? AND timestamp_ms < ?
      GROUP BY home_id, model
    `);
    const insertRepositories = canStoreRepositories
      ? db.prepare(`
          INSERT INTO ${REPOSITORY_TABLE} (
            calendar_zone, day_key, home_id, repository_key, cwd, repository_path, repository_kind,
            ${MODEL_DETAIL_COLUMNS}
          )
          SELECT
            ?, ?, home_id, repository_key, cwd, MIN(repository_path), MIN(repository_kind),
            ${MODEL_DETAIL_SELECT}
          FROM ${sourceTable}
          WHERE timestamp_ms >= ? AND timestamp_ms < ?
          GROUP BY home_id, repository_key, cwd
        `)
      : null;
    const insertSessions = db.prepare(`
      INSERT INTO ${SESSION_TABLE} (calendar_zone, day_key, home_id, session_id)
      SELECT DISTINCT ?, ?, home_id, session_id
      FROM ${sourceTable}
      WHERE timestamp_ms >= ? AND timestamp_ms < ? AND session_id IS NOT NULL
    `);
    const clearDirty = db.prepare(`DELETE FROM ${DIRTY_TABLE} WHERE day_key = ?`);
    for (const { day, start, end } of targets) {
      deleteDay.run(zone, day);
      deleteModels.run(zone, day);
      deleteRepositories.run(zone, day);
      deleteSessions.run(zone, day);
      markDay.run(zone, day, start, end);
      insertDay.run(zone, day, start, end);
      insertModels.run(zone, day, start, end);
      insertRepositories?.run(zone, day, start, end);
      insertSessions.run(zone, day, start, end);
      if (zone === "utc") clearDirty.run(day);
    }
  });
}

export function rebuildUsageRollupsFromEvents(db, { days, events, calendarZone = "utc" }) {
  if (!Array.isArray(days)) throw new TypeError("days must be an array of YYYY-MM-DD strings");
  if (!Array.isArray(events)) throw new TypeError("events must be an array");
  db.exec(`
    DROP TABLE IF EXISTS temp.${COMPLETE_EVENT_TABLE};
    CREATE TEMP TABLE ${COMPLETE_EVENT_TABLE} (
      timestamp_ms INTEGER NOT NULL,
      session_id TEXT,
      home_id TEXT NOT NULL,
      model TEXT NOT NULL,
      cwd TEXT NOT NULL,
      repository_key TEXT NOT NULL,
      repository_path TEXT NOT NULL,
      repository_kind TEXT NOT NULL,
      detail_mask INTEGER NOT NULL,
      reconciliation_gap INTEGER NOT NULL,
      total INTEGER NOT NULL,
      input INTEGER NOT NULL,
      cached INTEGER NOT NULL,
      output INTEGER NOT NULL,
      reasoning INTEGER NOT NULL
    ) STRICT
  `);
  try {
    const insert = db.prepare(`
      INSERT INTO temp.${COMPLETE_EVENT_TABLE} (
        timestamp_ms, session_id, home_id, model, cwd, repository_key, repository_path, repository_kind, detail_mask,
        reconciliation_gap, total, input, cached, output, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const event of events) {
      const timestampMs = Date.parse(event.timestamp);
      if (!Number.isFinite(timestampMs)) throw new TypeError(`invalid event timestamp: ${String(event.timestamp)}`);
      const usage = event.total;
      if (!usage || typeof usage !== "object") throw new TypeError("event.total must be an object");
      const cwd = String(event.cwd || event.project || "");
      insert.run(
        timestampMs,
        event.sessionId ?? null,
        String(event.homeId),
        String(event.model),
        cwd,
        String(event.repositoryKey || (cwd ? `directory:${cwd}` : "unknown:cwd")),
        String(event.repositoryPath || cwd || "Unknown cwd"),
        String(event.repositoryKind || (cwd ? "directory" : "unknown")),
        Number(event.detailMask || 0),
        Number(event.reconciliationGap || 0),
        Number(usage.total),
        Number(usage.input),
        Number(usage.cached),
        Number(usage.output),
        Number(usage.reasoning),
      );
    }
    return rebuildUsageRollupsFromSource(db, { days, calendarZone }, COMPLETE_EVENT_SOURCE);
  } finally {
    db.exec(`DROP TABLE IF EXISTS temp.${COMPLETE_EVENT_TABLE}`);
  }
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function eventHasId(db) {
  return Boolean(db.prepare("SELECT 1 FROM pragma_table_info('events') WHERE name = 'id'").get());
}

function eventSupportsRollupAppend(db) {
  const required = new Set([
    "id",
    "timestamp_ms",
    "session_id",
    "home_id",
    "model",
    "cwd",
    "repository_key",
    "repository_path",
    "repository_kind",
    "detail_mask",
    "reconciliation_gap",
    "total",
    "input",
    "cached",
    "output",
    "reasoning",
  ]);
  for (const row of db.prepare("SELECT name FROM pragma_table_info('events')").all()) required.delete(String(row.name));
  return required.size === 0;
}

function usageEventDayKeySql(zone) {
  return zone === "utc"
    ? "date(timestamp_ms / 1000.0, 'unixepoch')"
    : "date(timestamp_ms / 1000.0, 'unixepoch', 'localtime')";
}

function progressState(db, zoneIdentity) {
  try {
    if (!hasCurrentRollupFormat(db) || !eventHasId(db) || !eventSupportsRollupAppend(db)) return null;
    const required = [DAY_TABLE, TABLE, MODEL_TABLE, REPOSITORY_TABLE, SESSION_TABLE, DIRTY_TABLE, PROGRESS_TABLE];
    if (required.some((table) => !tableExists(db, table))) return null;
    const progress = db.prepare(`SELECT * FROM ${PROGRESS_TABLE} WHERE singleton = 1`).get();
    if (
      !progress ||
      Number(progress.format_version) !== PROGRESS_FORMAT_VERSION ||
      Number(progress.rollup_format_version) !== FORMAT_VERSION ||
      Number(progress.certified) !== 1 ||
      !Number.isSafeInteger(Number(progress.last_id)) ||
      Number(progress.last_id) < 0 ||
      String(progress.local_zone_identity) !== zoneIdentity
    ) {
      return null;
    }
    return { lastId: Number(progress.last_id) };
  } catch {
    return null;
  }
}

function fallbackResult(reason, readEvents = 0) {
  return { applied: false, readEvents, reason };
}

function checkpointFallback(db, reason) {
  if (tableExists(db, PROGRESS_TABLE)) {
    const columns = new Set(
      db
        .prepare(`SELECT name FROM pragma_table_info('${PROGRESS_TABLE}')`)
        .all()
        .map((row) => String(row.name)),
    );
    if (columns.has("certified")) {
      db.prepare(`UPDATE ${PROGRESS_TABLE} SET certified = 0 WHERE singleton = 1`).run();
    }
  }
  return { applied: false, certified: false, reason };
}

function isSqliteBusy(error) {
  return error?.code === "ERR_SQLITE_ERROR" && /busy|locked/i.test(String(error.message));
}

function eventBatch(db, lastId) {
  const row = db
    .prepare(`
      SELECT COUNT(*) AS read_events, MIN(id) AS first_id, MAX(id) AS last_id
      FROM ${EVENT_TABLE}
      WHERE id > ?
    `)
    .get(lastId);
  return {
    readEvents: Number(row.read_events),
    firstId: row.first_id === null ? null : Number(row.first_id),
    lastId: row.last_id === null ? lastId : Number(row.last_id),
  };
}

function eventDaysInBatch(db, zone, lastId, targetId) {
  const expression = usageEventDayKeySql(zone);
  try {
    return db
      .prepare(`
        SELECT ${expression} AS day_key, COUNT(*) AS event_count
        FROM ${EVENT_TABLE}
        WHERE id > ? AND id <= ?
        GROUP BY ${expression}
        ORDER BY day_key
      `)
      .all(lastId, targetId)
      .map((row) => {
        const day = String(row.day_key);
        return { day, ...dayBounds(day, zone), eventCount: Number(row.event_count) };
      });
  } catch {
    return null;
  }
}

function dirtyDaySet(db) {
  return new Set(
    db
      .prepare(`SELECT day_key FROM ${DIRTY_TABLE}`)
      .all()
      .map((row) => String(row.day_key)),
  );
}

function sameStringSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function dayRollupShape(db, zone, day) {
  const exists = (table) =>
    Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE calendar_zone = ? AND day_key = ? LIMIT 1`).get(zone, day));
  const daily = exists(TABLE);
  const models = exists(MODEL_TABLE);
  const repositories = exists(REPOSITORY_TABLE);
  if (!daily && !models && !repositories) return "empty";
  return daily && models && repositories ? "complete" : "partial";
}

function dayNeedsAppendProof(db, zone, day, bounds, lastId) {
  try {
    const progress = db
      .prepare(`
        SELECT start_ms, end_ms FROM ${PROGRESS_DAY_TABLE}
        WHERE calendar_zone = ? AND day_key = ?
      `)
      .get(zone, day);
    if (progress) {
      return (
        Number(progress.start_ms) === bounds.start &&
        Number(progress.end_ms) === bounds.end &&
        dayRollupShape(db, zone, day) !== "partial"
      );
    }
    const olderFact = db
      .prepare(`
        SELECT 1 FROM ${EVENT_TABLE}
        WHERE timestamp_ms >= ? AND timestamp_ms < ? AND id <= ?
        LIMIT 1
      `)
      .get(bounds.start, bounds.end, lastId);
    return !olderFact && dayRollupShape(db, zone, day) === "empty";
  } catch {
    return false;
  }
}

function applyAppendForZone(db, { zone, lastId, targetId, days }) {
  const dayExpression = usageEventDayKeySql(zone);
  const dailyFields = [
    ["event_count", "COUNT(*)"],
    ["total", DETAIL_SUM.total],
    ["input", DETAIL_SUM.input],
    ["cached", DETAIL_SUM.cached],
    ["output", DETAIL_SUM.output],
    ["reasoning", DETAIL_SUM.reasoning],
    ["input_known_tokens", DETAIL_SUM.inputKnownTokens],
    ["input_unavailable_tokens", DETAIL_SUM.inputUnavailableTokens],
    ["output_known_tokens", DETAIL_SUM.outputKnownTokens],
    ["output_unavailable_tokens", DETAIL_SUM.outputUnavailableTokens],
    ["cached_known_tokens", DETAIL_SUM.cachedKnownTokens],
    ["cached_unavailable_tokens", DETAIL_SUM.cachedUnavailableTokens],
    ["reasoning_known_tokens", DETAIL_SUM.reasoningKnownTokens],
    ["reasoning_unavailable_tokens", DETAIL_SUM.reasoningUnavailableTokens],
    ["uncached_input_tokens", DETAIL_SUM.uncachedInput],
    ["uncached_input_unavailable_tokens", DETAIL_SUM.uncachedInputUnavailableTokens],
    ["cache_rate_input_tokens", DETAIL_SUM.cacheRateInput],
    ["cache_rate_cached_tokens", DETAIL_SUM.cacheRateCached],
    ["unattributed_detail_tokens", DETAIL_SUM.unattributedDetailTokens],
    ["inconsistent_tokens", DETAIL_SUM.inconsistentTokens],
    ["reconciliation_gap_tokens", DETAIL_SUM.reconciliationGap],
    ["input_known_count", "COUNT(CASE WHEN (detail_mask & 1) != 0 THEN 1 END)"],
    ["cached_known_count", "COUNT(CASE WHEN (detail_mask & 2) != 0 THEN 1 END)"],
    ["output_known_count", "COUNT(CASE WHEN (detail_mask & 4) != 0 THEN 1 END)"],
    ["reasoning_known_count", "COUNT(CASE WHEN (detail_mask & 8) != 0 THEN 1 END)"],
    ["reconciliation_gap_count", "COUNT(CASE WHEN reconciliation_gap != 0 THEN 1 END)"],
  ];
  const dailyColumns = dailyFields.map(([column]) => column).join(", ");
  const dailySelect = dailyFields.map(([, expression]) => expression).join(", ");
  const dailyUpdate = dailyFields
    .map(([column]) => `${column} = ${TABLE}.${column} + excluded.${column}`)
    .join(",\n          ");
  db.prepare(`
    INSERT INTO ${TABLE} (calendar_zone, day_key, home_id, ${dailyColumns})
    SELECT ?, ${dayExpression}, home_id, ${dailySelect}
    FROM ${EVENT_TABLE}
    WHERE id > ? AND id <= ?
    GROUP BY ${dayExpression}, home_id
    ON CONFLICT(calendar_zone, day_key, home_id) DO UPDATE SET
          ${dailyUpdate}
  `).run(zone, lastId, targetId);
  db.prepare(`
    INSERT INTO ${MODEL_TABLE} (
      calendar_zone, day_key, home_id, model, ${MODEL_DETAIL_COLUMNS}
    )
    SELECT ?, ${dayExpression}, home_id, model, ${MODEL_DETAIL_SELECT}
    FROM ${EVENT_TABLE}
    WHERE id > ? AND id <= ?
    GROUP BY ${dayExpression}, home_id, model
    ON CONFLICT(calendar_zone, day_key, home_id, model) DO UPDATE SET
      ${MODEL_DETAIL_FIELDS.map(([column]) => `${column} = ${MODEL_TABLE}.${column} + excluded.${column}`).join(
        ",\n      ",
      )}
  `).run(zone, lastId, targetId);
  db.prepare(`
    INSERT INTO ${REPOSITORY_TABLE} (
      calendar_zone, day_key, home_id, repository_key, cwd, repository_path, repository_kind,
      ${MODEL_DETAIL_COLUMNS}
    )
    SELECT
      ?, ${dayExpression}, home_id, repository_key, cwd, MIN(repository_path), MIN(repository_kind),
      ${MODEL_DETAIL_SELECT}
    FROM ${EVENT_TABLE}
    WHERE id > ? AND id <= ?
    GROUP BY ${dayExpression}, home_id, repository_key, cwd
    ON CONFLICT(calendar_zone, day_key, home_id, repository_key, cwd) DO UPDATE SET
      repository_path = MIN(${REPOSITORY_TABLE}.repository_path, excluded.repository_path),
      repository_kind = MIN(${REPOSITORY_TABLE}.repository_kind, excluded.repository_kind),
      ${MODEL_DETAIL_FIELDS.map(
        ([column]) => `${column} = ${REPOSITORY_TABLE}.${column} + excluded.${column}`,
      ).join(",\n      ")}
  `).run(zone, lastId, targetId);
  db.prepare(`
    INSERT OR IGNORE INTO ${SESSION_TABLE} (calendar_zone, day_key, home_id, session_id)
    SELECT ?, ${dayExpression}, home_id, session_id
    FROM ${EVENT_TABLE}
    WHERE id > ? AND id <= ? AND session_id IS NOT NULL
    GROUP BY ${dayExpression}, home_id, session_id
  `).run(zone, lastId, targetId);
  const markDay = db.prepare(`
    INSERT OR REPLACE INTO ${DAY_TABLE} (calendar_zone, day_key, start_ms, end_ms)
    VALUES (?, ?, ?, ?)
  `);
  for (const day of days) markDay.run(zone, day.day, day.start, day.end);
}

/**
 * Consume one contiguous committed append batch. A false result means the
 * caller must use the existing full-day repair path before checkpointing.
 */
export function tryAppendUsageRollups(db, { zoneIdentity }) {
  if (typeof zoneIdentity !== "string" || zoneIdentity === "") {
    throw new TypeError("zoneIdentity must be a non-empty string");
  }
  try {
    return withWriteTransaction(db, () => {
      if (!ensureUsageRollupProgressSchema(db)) return fallbackResult("ROLLUP_PROGRESS_SCHEMA");
      if (!hasCurrentRollupFormat(db)) return fallbackResult("ROLLUP_FORMAT");
      const state = progressState(db, zoneIdentity);
      if (!state) return fallbackResult("ROLLUP_PROGRESS_NOT_CERTIFIED");
      const batch = eventBatch(db, state.lastId);
      const dirtyDays = dirtyDaySet(db);
      if (batch.readEvents === 0) {
        return dirtyDays.size === 0
          ? { applied: true, readEvents: 0, lastId: state.lastId }
          : fallbackResult("ROLLUP_DIRTY_DAYS", 0);
      }
      if (!Number.isSafeInteger(batch.lastId) || !Number.isSafeInteger(batch.firstId)) {
        return fallbackResult("ROLLUP_EVENT_ID", batch.readEvents);
      }

      const utcDays = eventDaysInBatch(db, "utc", state.lastId, batch.lastId);
      const localDays = eventDaysInBatch(db, "local", state.lastId, batch.lastId);
      if (!utcDays || !localDays) return fallbackResult("ROLLUP_EVENT_DAY", batch.readEvents);
      const batchUtcDays = new Set(utcDays.map((day) => day.day));
      if (!sameStringSet(dirtyDays, batchUtcDays)) return fallbackResult("ROLLUP_DIRTY_DAYS", batch.readEvents);

      const appendDays = [
        { zone: "utc", days: utcDays },
        { zone: "local", days: localDays },
      ];
      for (const { zone, days } of appendDays) {
        for (const day of days) {
          if (!dayNeedsAppendProof(db, zone, day.day, day, state.lastId)) {
            return fallbackResult("ROLLUP_DAY_INCOMPLETE", batch.readEvents);
          }
        }
      }
      for (const { zone, days } of appendDays) {
        applyAppendForZone(db, { zone, lastId: state.lastId, targetId: batch.lastId, days });
      }
      const clearDirty = db.prepare(`DELETE FROM ${DIRTY_TABLE} WHERE day_key = ?`);
      for (const day of batchUtcDays) clearDirty.run(day);
      db.prepare(`UPDATE ${PROGRESS_TABLE} SET last_id = ? WHERE singleton = 1`).run(batch.lastId);
      return { applied: true, readEvents: batch.readEvents, lastId: batch.lastId };
    });
  } catch (error) {
    if (isSqliteBusy(error)) return fallbackResult("ROLLUP_BUSY");
    throw error;
  }
}

function factDays(db, zone) {
  const expression = usageEventDayKeySql(zone);
  return db
    .prepare(`
      SELECT DISTINCT ${expression} AS day_key
      FROM ${EVENT_TABLE}
      WHERE timestamp_ms IS NOT NULL
      ORDER BY day_key
    `)
    .all()
    .map((row) => String(row.day_key));
}

function factBounds(db) {
  const row = db.prepare(`SELECT MIN(timestamp_ms) AS minimum, MAX(timestamp_ms) AS maximum FROM ${EVENT_TABLE}`).get();
  return {
    minimum: row.minimum === null ? null : Number(row.minimum),
    maximum: row.maximum === null ? null : Number(row.maximum),
  };
}

function validRollupDayMarkers(db) {
  const markers = new Map();
  for (const row of db.prepare(`SELECT calendar_zone, day_key, start_ms, end_ms FROM ${DAY_TABLE}`).all()) {
    const zone = String(row.calendar_zone);
    const day = String(row.day_key);
    if (zone !== "utc" && zone !== "local") continue;
    try {
      const bounds = dayBounds(day, zone);
      if (Number(row.start_ms) === bounds.start && Number(row.end_ms) === bounds.end) {
        markers.set(`${zone}\u0000${day}`, { zone, day, ...bounds });
      }
    } catch {
      // Invalid markers are repaired below.
    }
  }
  return markers;
}

function invalidRollupDayMarkers(db) {
  const invalid = new Set();
  for (const row of db.prepare(`SELECT calendar_zone, day_key, start_ms, end_ms FROM ${DAY_TABLE}`).all()) {
    const zone = String(row.calendar_zone);
    const day = String(row.day_key);
    try {
      const bounds = dayBounds(day, zone);
      if (Number(row.start_ms) !== bounds.start || Number(row.end_ms) !== bounds.end) {
        invalid.add(`${zone}\u0000${day}`);
      }
    } catch {
      invalid.add(`${zone}\u0000${day}`);
    }
  }
  return invalid;
}

function seedProgressDays(db, markers) {
  db.exec(`DELETE FROM ${PROGRESS_DAY_TABLE}`);
  const insert = db.prepare(`
    INSERT INTO ${PROGRESS_DAY_TABLE} (calendar_zone, day_key, start_ms, end_ms)
    VALUES (?, ?, ?, ?)
  `);
  for (const marker of markers.values()) insert.run(marker.zone, marker.day, marker.start, marker.end);
}

/**
 * Certify the committed fact high-water only after both calendars have a
 * complete marker for every represented day. Missing event days are repaired;
 * empty calendar gaps receive an empty marker so later windows remain fused.
 */
export function checkpointUsageRollups(db, { zoneIdentity }) {
  if (typeof zoneIdentity !== "string" || zoneIdentity === "") {
    throw new TypeError("zoneIdentity must be a non-empty string");
  }
  return withWriteTransaction(db, () => {
    if (!ensureUsageRollupProgressSchema(db)) return checkpointFallback(db, "ROLLUP_PROGRESS_SCHEMA");
    if (!hasCurrentRollupFormat(db) || !eventHasId(db)) return checkpointFallback(db, "ROLLUP_FORMAT");
    if (dirtyDaySet(db).size > 0) return checkpointFallback(db, "ROLLUP_DIRTY_DAYS");
    const bounds = factBounds(db);
    const repairedDays = new Set();
    const emptyDays = new Set();
    if (bounds.minimum !== null && bounds.maximum !== null) {
      for (const zone of ["utc", "local"]) {
        const days = new Set(factDays(db, zone));
        const minimum = new Date(bounds.minimum);
        const maximum = new Date(bounds.maximum);
        const firstDay = zone === "utc" ? minimum.toISOString().slice(0, 10) : localDayKey(minimum);
        const lastDay = zone === "utc" ? maximum.toISOString().slice(0, 10) : localDayKey(maximum);
        const rangeDays = calendarDays(firstDay, lastDay, zone);
        let markers = validRollupDayMarkers(db);
        for (const day of days) {
          const marker = markers.get(`${zone}\u0000${day}`);
          if (!marker || dayRollupShape(db, zone, day) !== "complete") repairedDays.add(`${zone}\u0000${day}`);
        }
        for (const key of invalidRollupDayMarkers(db)) {
          if (key.startsWith(`${zone}\u0000`)) repairedDays.add(key);
        }
        const repairsByZone = [...repairedDays]
          .filter((key) => key.startsWith(`${zone}\u0000`))
          .map((key) => key.slice(zone.length + 1));
        if (repairsByZone.length > 0) rebuildUsageRollups(db, { days: repairsByZone, calendarZone: zone });
        markers = validRollupDayMarkers(db);
        const clearZone = [TABLE, MODEL_TABLE, REPOSITORY_TABLE, SESSION_TABLE].map((table) =>
          db.prepare(`DELETE FROM ${table} WHERE calendar_zone = ? AND day_key = ?`),
        );
        const markDay = db.prepare(`
          INSERT OR REPLACE INTO ${DAY_TABLE} (calendar_zone, day_key, start_ms, end_ms)
          VALUES (?, ?, ?, ?)
        `);
        for (const day of rangeDays) {
          if (markers.has(`${zone}\u0000${day}`)) continue;
          const dayBound = dayBounds(day, zone);
          for (const clear of clearZone) clear.run(zone, day);
          markDay.run(zone, day, dayBound.start, dayBound.end);
          emptyDays.add(`${zone}\u0000${day}`);
        }
      }
    }
    const markers = validRollupDayMarkers(db);
    seedProgressDays(db, markers);
    const maxId = Number(db.prepare(`SELECT COALESCE(MAX(id), 0) AS last_id FROM ${EVENT_TABLE}`).get().last_id);
    db.prepare(`
      UPDATE ${PROGRESS_TABLE}
      SET format_version = ?, rollup_format_version = ?, last_id = ?, certified = 1, local_zone_identity = ?
      WHERE singleton = 1
    `).run(PROGRESS_FORMAT_VERSION, FORMAT_VERSION, maxId, zoneIdentity);
    return {
      applied: true,
      certified: true,
      lastId: maxId,
      repairedDays: [...repairedDays].sort(),
      emptyDays: [...emptyDays].sort(),
    };
  });
}

export function listDirtyUsageRollupDays(db) {
  return withReadSnapshot(db, () => {
    if (!hasCurrentRollupFormat(db)) throw missingRollupCacheError();
    return db
      .prepare(`SELECT day_key FROM ${DIRTY_TABLE} ORDER BY day_key`)
      .all()
      .map((row) => row.day_key);
  });
}

export function localUsageRollupDaysForUtcDays(days) {
  if (!Array.isArray(days)) {
    throw new TypeError("days must be an array of YYYY-MM-DD strings");
  }
  const localDays = new Set();
  for (const day of new Set(days)) {
    const { start, end } = dayBounds(day, "utc");
    const firstLocalDay = localDayKey(new Date(start));
    const lastLocalDay = localDayKey(new Date(end - 1));
    for (const localDay of calendarDays(firstLocalDay, lastLocalDay, "local")) {
      localDays.add(localDay);
    }
  }
  return [...localDays].sort();
}

export function queryUsageRollups(db, { day, calendarZone: zone = "utc" }) {
  zone = calendarZone(zone);
  const bounds = dayBounds(day, zone);
  return withReadSnapshot(db, () => {
    if (!hasCurrentRollupFormat(db)) return null;
    const built = db
      .prepare(`SELECT start_ms, end_ms FROM ${DAY_TABLE} WHERE calendar_zone = ? AND day_key = ?`)
      .get(zone, day);
    if (!built || Number(built.start_ms) !== bounds.start || Number(built.end_ms) !== bounds.end) return null;
    const rows = db
      .prepare(`
        SELECT day_key, event_count, total, input, cached, output, reasoning,
          input_known_tokens, input_unavailable_tokens, output_known_tokens, output_unavailable_tokens,
          cached_known_tokens, cached_unavailable_tokens, reasoning_known_tokens, reasoning_unavailable_tokens,
          uncached_input_tokens, uncached_input_unavailable_tokens,
          cache_rate_input_tokens, cache_rate_cached_tokens,
          unattributed_detail_tokens, inconsistent_tokens, reconciliation_gap_tokens,
          input_known_count, cached_known_count, output_known_count, reasoning_known_count,
          reconciliation_gap_count
        FROM ${TABLE}
        WHERE calendar_zone = ? AND day_key = ?
      `)
      .all(zone, day);
    const { session_count: sessionCount } = db
      .prepare(`
        SELECT COUNT(DISTINCT session_id) AS session_count
        FROM ${SESSION_TABLE}
        WHERE calendar_zone = ? AND day_key = ?
      `)
      .get(zone, day);
    const { home_count: homeCount } = db
      .prepare(`
        SELECT COUNT(DISTINCT home_id) AS home_count
        FROM ${TABLE}
        WHERE calendar_zone = ? AND day_key = ? AND event_count > 0
      `)
      .get(zone, day);
    return sumRollupRows(day, rows, sessionCount, homeCount);
  });
}

export function queryUsageRollupModels(
  db,
  { day, excludeHomes = [], calendarZone: zone = "utc", canonicalModels = false },
) {
  if (!Array.isArray(excludeHomes)) {
    throw new TypeError("excludeHomes must be an array of home ids");
  }
  zone = calendarZone(zone);
  const bounds = dayBounds(day, zone);
  return withReadSnapshot(db, () => {
    if (!hasCurrentRollupFormat(db)) return null;
    const hasModelTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(MODEL_TABLE);
    if (!hasModelTable) return null;
    const built = db
      .prepare(`SELECT start_ms, end_ms FROM ${DAY_TABLE} WHERE calendar_zone = ? AND day_key = ?`)
      .get(zone, day);
    if (!built || Number(built.start_ms) !== bounds.start || Number(built.end_ms) !== bounds.end) return null;
    const homeFilter = excludeHomes.length > 0 ? `AND home_id NOT IN (${excludeHomes.map(() => "?").join(", ")})` : "";
    const groupSql = modelGroupSql(canonicalModels);
    const rows = db
      .prepare(`
        SELECT ${groupSql} AS model, ${MODEL_TOTAL_SELECT}
        FROM ${MODEL_TABLE}
        WHERE calendar_zone = ? AND day_key = ? ${homeFilter}
        GROUP BY ${groupSql}
        ORDER BY model ASC
      `)
      .all(zone, day, ...excludeHomes);
    return rows.map(modelRollupRow);
  });
}

export function queryUsageRollupModelsRange(
  db,
  { startDay, endDay, excludeHomes = [], calendarZone: zone = "utc", canonicalModels = false },
) {
  zone = calendarZone(zone);
  const days = calendarDays(startDay, endDay, zone);
  if (!Array.isArray(excludeHomes)) {
    throw new TypeError("excludeHomes must be an array of home ids");
  }
  return withReadSnapshot(db, () =>
    queryUsageRollupModelsRangeWithinSnapshot(db, {
      startDay,
      endDay,
      days,
      excludeHomes,
      calendarZone: zone,
      canonicalModels,
    }),
  );
}

function queryUsageRollupModelsRangeWithinSnapshot(
  db,
  { startDay, endDay, days, excludeHomes, calendarZone: zone = "utc", canonicalModels = false },
) {
  if (!hasCurrentRollupFormat(db)) throw missingRollupDaysError(days);
  const hasDayTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(DAY_TABLE);
  const hasModelTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(MODEL_TABLE);
  if (!hasDayTable || !hasModelTable) throw missingRollupDaysError(days);
  const builtDays = new Set(
    db
      .prepare(`
        SELECT day_key, start_ms, end_ms FROM ${DAY_TABLE}
        WHERE calendar_zone = ? AND day_key >= ? AND day_key <= ?
      `)
      .all(zone, startDay, endDay)
      .filter((row) => {
        const bounds = dayBounds(row.day_key, zone);
        return Number(row.start_ms) === bounds.start && Number(row.end_ms) === bounds.end;
      })
      .map((row) => row.day_key),
  );
  const missingDays = days.filter((day) => !builtDays.has(day));
  if (missingDays.length > 0) throw missingRollupDaysError(missingDays);

  const homeFilter = excludeHomes.length > 0 ? `AND home_id NOT IN (${excludeHomes.map(() => "?").join(", ")})` : "";
  const groupSql = modelGroupSql(canonicalModels);
  const rows = db
    .prepare(`
      SELECT ${groupSql} AS model, ${MODEL_TOTAL_SELECT}
      FROM ${MODEL_TABLE}
      WHERE calendar_zone = ? AND day_key >= ? AND day_key <= ? ${homeFilter}
      GROUP BY ${groupSql}
      ORDER BY model ASC
    `)
    .all(zone, startDay, endDay, ...excludeHomes);
  return rows.map(modelRollupRow);
}

export function queryUsageRollupModelsWindow(db, { startMs, endMs, excludeHomes = [], canonicalModels = false }) {
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)) {
    throw new TypeError("startMs and endMs must be safe integers");
  }
  if (startMs > endMs) {
    throw new RangeError("startMs must not be after endMs");
  }
  if (!Array.isArray(excludeHomes)) {
    throw new TypeError("excludeHomes must be an array of home ids");
  }

  return withReadSnapshot(db, () => {
    if (startMs === endMs) return [];
    const runs = usageRollupDayRuns(db, startMs, endMs);
    const rows = [];
    for (const run of runs) {
      rows.push(...queryUsageRollupModelsRangeWithinSnapshot(db, {
        startDay: run.startDay, endDay: run.endDay,
        days: calendarDays(run.startDay, run.endDay, run.zone),
        excludeHomes, calendarZone: run.zone, canonicalModels,
      }));
    }
    for (const [start, end] of rawWindowIntervals(startMs, endMs, runs)) {
      rows.push(...queryRawModelRollupRows(db, start, end, excludeHomes, canonicalModels));
    }
    return mergeModelRollupRows(rows);
  });
}

function usageRollupDayRuns(db, startMs, endMs) {
  if (!hasCurrentRollupFormat(db) || !tableExists(db, DAY_TABLE)) return [];
  const rows = db
    .prepare(`
      SELECT calendar_zone, day_key, start_ms, end_ms
      FROM ${DAY_TABLE}
      WHERE start_ms >= ? AND end_ms <= ?
      ORDER BY start_ms
    `)
    .all(startMs, endMs);
  const runsByZone = new Map([["utc", []], ["local", []]]);
  for (const row of rows) {
    const zone = String(row.calendar_zone);
    if (zone !== "utc" && zone !== "local") continue;
    const day = String(row.day_key);
    const bounds = dayBounds(day, zone);
    if (Number(row.start_ms) !== bounds.start || Number(row.end_ms) !== bounds.end) continue;
    const runs = runsByZone.get(zone);
    const current = runs.at(-1);
    if (current && current.endMs === bounds.start) {
      current.endMs = bounds.end;
      current.endDay = day;
    } else {
      const next = { zone, startMs: bounds.start, endMs: bounds.end, startDay: day, endDay: day };
      runs.push(next);
    }
  }
  let best = [], covered = 0;
  for (const runs of runsByZone.values()) {
    const duration = runs.reduce((sum, run) => sum + run.endMs - run.startMs, 0);
    if (duration > covered) { best = runs; covered = duration; }
  }
  return best;
}

function rawWindowIntervals(startMs, endMs, runs) {
  const intervals = [];
  let cursor = startMs;
  for (const run of runs) {
    if (cursor < run.startMs) intervals.push([cursor, run.startMs]);
    cursor = run.endMs;
  }
  if (cursor < endMs) intervals.push([cursor, endMs]);
  return intervals;
}

function queryRepositoryWindowRows(db, { startMs, endMs, excludeHomes }) {
  const runs = usageRollupDayRuns(db, startMs, endMs);
  if (runs.length > 0) {
    if (!hasCurrentRollupFormat(db)) {
      throw missingRollupDaysError(runs.flatMap(run => calendarDays(run.startDay, run.endDay, run.zone)));
    }
    const hasRepositoryTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(REPOSITORY_TABLE);
    if (!hasRepositoryTable) {
      throw missingRollupDaysError(runs.flatMap(run => calendarDays(run.startDay, run.endDay, run.zone)));
    }
  }

  const parts = [];
  const params = [];
  const homeFilter = excludeHomes.length > 0 ? `AND home_id NOT IN (${excludeHomes.map(() => "?").join(", ")})` : "";
  for (const run of runs) {
    parts.push(`
      SELECT repository_key, repository_path, repository_kind, cwd, ${MODEL_DETAIL_COLUMNS}
      FROM ${REPOSITORY_TABLE}
      WHERE calendar_zone = ? AND day_key >= ? AND day_key <= ? ${homeFilter}
    `);
    params.push(run.zone, run.startDay, run.endDay, ...excludeHomes);
  }

  const intervals = rawWindowIntervals(startMs, endMs, runs);
  if (intervals.length > 0) {
    const predicates = intervals.map(() => "(timestamp_ms >= ? AND timestamp_ms < ?)").join(" OR ");
    parts.push(`
      SELECT
        repository_key,
        MIN(repository_path) AS repository_path,
        MIN(repository_kind) AS repository_kind,
        cwd,
        ${MODEL_DETAIL_ALIASED_SELECT}
      FROM ${EVENT_TABLE}
      WHERE (${predicates}) ${homeFilter}
      GROUP BY repository_key, cwd
    `);
    for (const [start, end] of intervals) params.push(start, end);
    params.push(...excludeHomes);
  }

  const sums = MODEL_DETAIL_FIELDS.map(([column]) => `COALESCE(SUM(${column}), 0) AS ${column}`).join(", ");
  return db
    .prepare(`
      WITH parts AS (
        ${parts.join("\nUNION ALL\n")}
      )
      SELECT
        repository_key AS key,
        MIN(repository_path) AS name,
        MIN(repository_kind) AS kind,
        COUNT(DISTINCT NULLIF(cwd, '')) AS path_count,
        ${sums}
      FROM parts
      GROUP BY repository_key
      ORDER BY total DESC, name ASC
    `)
    .all(...params)
    .map(repositoryRollupRow);
}

export function queryUsageRollupRepositoriesWindow(db, { startMs, endMs, excludeHomes = [] }) {
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)) {
    throw new TypeError("startMs and endMs must be safe integers");
  }
  if (startMs > endMs) {
    throw new RangeError("startMs must not be after endMs");
  }
  if (!Array.isArray(excludeHomes)) {
    throw new TypeError("excludeHomes must be an array of home ids");
  }
  return withReadSnapshot(db, () => {
    if (startMs === endMs) return [];
    return queryRepositoryWindowRows(db, { startMs, endMs, excludeHomes });
  });
}

export function queryUsageRollupsRange(
  db,
  { startDay, endDay, excludeHomes = [], calendarZone: zone = "utc", includeHomeCounts = false },
) {
  zone = calendarZone(zone);
  const days = calendarDays(startDay, endDay, zone);
  if (!Array.isArray(excludeHomes)) {
    throw new TypeError("excludeHomes must be an array of home ids");
  }
  return withReadSnapshot(db, () => {
    if (!hasCurrentRollupFormat(db)) throw missingRollupDaysError(days);
    const hasDayTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(DAY_TABLE);
    if (!hasDayTable) throw missingRollupDaysError(days);
    const builtDays = new Set(
      db
        .prepare(`
        SELECT day_key, start_ms, end_ms FROM ${DAY_TABLE}
        WHERE calendar_zone = ? AND day_key >= ? AND day_key <= ?
      `)
        .all(zone, startDay, endDay)
        .filter((row) => {
          const bounds = dayBounds(row.day_key, zone);
          return Number(row.start_ms) === bounds.start && Number(row.end_ms) === bounds.end;
        })
        .map((row) => row.day_key),
    );
    const missingDays = days.filter((day) => !builtDays.has(day));
    if (missingDays.length > 0) throw missingRollupDaysError(missingDays);

    const homeFilter = excludeHomes.length > 0 ? `AND home_id NOT IN (${excludeHomes.map(() => "?").join(", ")})` : "";
    const rows = db
      .prepare(`
        SELECT day_key, event_count, total, input, cached, output, reasoning,
          input_known_tokens, input_unavailable_tokens, output_known_tokens, output_unavailable_tokens,
          cached_known_tokens, cached_unavailable_tokens, reasoning_known_tokens, reasoning_unavailable_tokens,
          uncached_input_tokens, uncached_input_unavailable_tokens,
          cache_rate_input_tokens, cache_rate_cached_tokens,
          unattributed_detail_tokens, inconsistent_tokens, reconciliation_gap_tokens,
          input_known_count, cached_known_count, output_known_count, reasoning_known_count,
          reconciliation_gap_count
        FROM ${TABLE}
        WHERE calendar_zone = ? AND day_key >= ? AND day_key <= ?
          ${homeFilter}
      `)
      .all(zone, startDay, endDay, ...excludeHomes);
    const { session_count: sessionCount } = db
      .prepare(`
        SELECT COUNT(DISTINCT session_id) AS session_count
        FROM ${SESSION_TABLE}
        WHERE calendar_zone = ? AND day_key >= ? AND day_key <= ?
          ${homeFilter}
      `)
      .get(zone, startDay, endDay, ...excludeHomes);
    const { home_count: homeCount } = db
      .prepare(`
        SELECT COUNT(DISTINCT home_id) AS home_count
        FROM ${TABLE}
        WHERE calendar_zone = ? AND day_key >= ? AND day_key <= ? AND event_count > 0
          ${homeFilter}
      `)
      .get(zone, startDay, endDay, ...excludeHomes);
    const homeCounts = includeHomeCounts
      ? (() => {
          const sessionRows = db
            .prepare(`
              SELECT home_id, COUNT(DISTINCT session_id) AS session_count
              FROM ${SESSION_TABLE}
              WHERE calendar_zone = ? AND day_key >= ? AND day_key <= ?
                ${homeFilter}
              GROUP BY home_id
            `)
            .all(zone, startDay, endDay, ...excludeHomes);
          const sessionByHome = new Map(sessionRows.map((row) => [row.home_id, Number(row.session_count)]));
          return db
            .prepare(`
              SELECT home_id, SUM(event_count) AS event_count
              FROM ${TABLE}
              WHERE calendar_zone = ? AND day_key >= ? AND day_key <= ?
                ${homeFilter}
              GROUP BY home_id
            `)
            .all(zone, startDay, endDay, ...excludeHomes)
            .map((row) => ({
              homeId: row.home_id,
              eventCount: Number(row.event_count),
              sessionCount: sessionByHome.get(row.home_id) || 0,
            }));
        })()
      : undefined;
    const totals = {
      startDay,
      endDay,
      eventCount: 0,
      sessionCount: Number(sessionCount),
      homeCount: Number(homeCount),
      total: 0,
      input: 0,
      cached: 0,
      output: 0,
      reasoning: 0,
      inputKnownTokens: 0,
      inputUnavailableTokens: 0,
      outputKnownTokens: 0,
      outputUnavailableTokens: 0,
      cachedKnownTokens: 0,
      cachedUnavailableTokens: 0,
      reasoningKnownTokens: 0,
      reasoningUnavailableTokens: 0,
      uncachedInput: 0,
      uncachedInputUnavailableTokens: 0,
      cacheRateInput: 0,
      cacheRateCached: 0,
      unattributedDetailTokens: 0,
      inconsistentTokens: 0,
      reconciliationGap: 0,
      inputKnownCount: 0,
      cachedKnownCount: 0,
      outputKnownCount: 0,
      reasoningKnownCount: 0,
      reconciliationGapCount: 0,
      ...(homeCounts === undefined ? {} : { homeCounts }),
    };
    for (const row of rows) {
      totals.eventCount += Number(row.event_count);
      totals.total += Number(row.total);
      totals.input += Number(row.input);
      totals.cached += Number(row.cached);
      totals.output += Number(row.output);
      totals.reasoning += Number(row.reasoning);
      totals.inputKnownTokens += Number(row.input_known_tokens);
      totals.inputUnavailableTokens += Number(row.input_unavailable_tokens);
      totals.outputKnownTokens += Number(row.output_known_tokens);
      totals.outputUnavailableTokens += Number(row.output_unavailable_tokens);
      totals.cachedKnownTokens += Number(row.cached_known_tokens);
      totals.cachedUnavailableTokens += Number(row.cached_unavailable_tokens);
      totals.reasoningKnownTokens += Number(row.reasoning_known_tokens);
      totals.reasoningUnavailableTokens += Number(row.reasoning_unavailable_tokens);
      totals.uncachedInput += Number(row.uncached_input_tokens);
      totals.uncachedInputUnavailableTokens += Number(row.uncached_input_unavailable_tokens);
      totals.cacheRateInput += Number(row.cache_rate_input_tokens);
      totals.cacheRateCached += Number(row.cache_rate_cached_tokens);
      totals.unattributedDetailTokens += Number(row.unattributed_detail_tokens);
      totals.inconsistentTokens += Number(row.inconsistent_tokens);
      totals.reconciliationGap += Number(row.reconciliation_gap_tokens);
      totals.inputKnownCount += Number(row.input_known_count);
      totals.cachedKnownCount += Number(row.cached_known_count);
      totals.outputKnownCount += Number(row.output_known_count);
      totals.reasoningKnownCount += Number(row.reasoning_known_count);
      totals.reconciliationGapCount += Number(row.reconciliation_gap_count);
    }
    return totals;
  });
}

function sumRollupRows(day, rows, sessionCount, homeCount) {
  const totals = {
    day,
    eventCount: 0,
    sessionCount: Number(sessionCount),
    homeCount: Number(homeCount),
    total: 0,
    input: 0,
    cached: 0,
    output: 0,
    reasoning: 0,
    inputKnownTokens: 0,
    inputUnavailableTokens: 0,
    outputKnownTokens: 0,
    outputUnavailableTokens: 0,
    cachedKnownTokens: 0,
    cachedUnavailableTokens: 0,
    reasoningKnownTokens: 0,
    reasoningUnavailableTokens: 0,
    uncachedInput: 0,
    uncachedInputUnavailableTokens: 0,
    cacheRateInput: 0,
    cacheRateCached: 0,
    unattributedDetailTokens: 0,
    inconsistentTokens: 0,
    reconciliationGap: 0,
    inputKnownCount: 0,
    cachedKnownCount: 0,
    outputKnownCount: 0,
    reasoningKnownCount: 0,
    reconciliationGapCount: 0,
  };
  for (const row of rows) {
    totals.eventCount += Number(row.event_count);
    totals.total += Number(row.total);
    totals.input += Number(row.input);
    totals.cached += Number(row.cached);
    totals.output += Number(row.output);
    totals.reasoning += Number(row.reasoning);
    totals.inputKnownTokens += Number(row.input_known_tokens);
    totals.inputUnavailableTokens += Number(row.input_unavailable_tokens);
    totals.outputKnownTokens += Number(row.output_known_tokens);
    totals.outputUnavailableTokens += Number(row.output_unavailable_tokens);
    totals.cachedKnownTokens += Number(row.cached_known_tokens);
    totals.cachedUnavailableTokens += Number(row.cached_unavailable_tokens);
    totals.reasoningKnownTokens += Number(row.reasoning_known_tokens);
    totals.reasoningUnavailableTokens += Number(row.reasoning_unavailable_tokens);
    totals.uncachedInput += Number(row.uncached_input_tokens);
    totals.uncachedInputUnavailableTokens += Number(row.uncached_input_unavailable_tokens);
    totals.cacheRateInput += Number(row.cache_rate_input_tokens);
    totals.cacheRateCached += Number(row.cache_rate_cached_tokens);
    totals.unattributedDetailTokens += Number(row.unattributed_detail_tokens);
    totals.inconsistentTokens += Number(row.inconsistent_tokens);
    totals.reconciliationGap += Number(row.reconciliation_gap_tokens);
    totals.inputKnownCount += Number(row.input_known_count);
    totals.cachedKnownCount += Number(row.cached_known_count);
    totals.outputKnownCount += Number(row.output_known_count);
    totals.reasoningKnownCount += Number(row.reasoning_known_count);
    totals.reconciliationGapCount += Number(row.reconciliation_gap_count);
  }
  return totals;
}
