const TABLE = "usage_rollup_daily";
const DAY_TABLE = "usage_rollup_days";
const MODEL_TABLE = "usage_rollup_models";
const SESSION_TABLE = "usage_rollup_sessions";
const FORMAT_TABLE = "usage_rollup_format";
const DIRTY_TABLE = "usage_rollup_dirty_days";
const EVENT_TABLE = "events";
const COMPLETE_EVENT_TABLE = "usage_rollup_complete_events";
const COMPLETE_EVENT_SOURCE = `temp.${COMPLETE_EVENT_TABLE}`;
const FORMAT_VERSION = 7;
const DAY_MS = 86_400_000;
const INSERT_TRIGGER = "usage_rollup_invalidate_insert";
const UPDATE_TRIGGER = "usage_rollup_invalidate_update";
const DELETE_TRIGGER = "usage_rollup_invalidate_delete";
const WRITE_SAVEPOINT = "usage_rollups_write";
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

function dropRollupCache(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS ${INSERT_TRIGGER};
    DROP TRIGGER IF EXISTS ${UPDATE_TRIGGER};
    DROP TRIGGER IF EXISTS ${DELETE_TRIGGER};
    DROP TABLE IF EXISTS ${MODEL_TABLE};
    DROP TABLE IF EXISTS ${TABLE};
    DROP TABLE IF EXISTS ${SESSION_TABLE};
    DROP TABLE IF EXISTS ${DIRTY_TABLE};
    DROP TABLE IF EXISTS ${DAY_TABLE};
    DROP TABLE IF EXISTS ${FORMAT_TABLE}
  `);
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
      SELECT DISTINCT ${utcDirtyDaySql("timestamp_ms")} FROM events;
    CREATE TRIGGER IF NOT EXISTS ${INSERT_TRIGGER}
    AFTER INSERT ON events
    BEGIN
      INSERT OR IGNORE INTO ${DIRTY_TABLE} (day_key)
        VALUES (${utcDirtyDaySql("NEW.timestamp_ms")});
      DELETE FROM ${DAY_TABLE}
      WHERE NEW.timestamp_ms >= start_ms AND NEW.timestamp_ms < end_ms;
    END;
    CREATE TRIGGER IF NOT EXISTS ${UPDATE_TRIGGER}
    AFTER UPDATE ON events
    BEGIN
      INSERT OR IGNORE INTO ${DIRTY_TABLE} (day_key)
        VALUES (${utcDirtyDaySql("OLD.timestamp_ms")});
      INSERT OR IGNORE INTO ${DIRTY_TABLE} (day_key)
        VALUES (${utcDirtyDaySql("NEW.timestamp_ms")});
      DELETE FROM ${DAY_TABLE}
      WHERE (OLD.timestamp_ms >= start_ms AND OLD.timestamp_ms < end_ms)
         OR (NEW.timestamp_ms >= start_ms AND NEW.timestamp_ms < end_ms);
    END;
    CREATE TRIGGER IF NOT EXISTS ${DELETE_TRIGGER}
    AFTER DELETE ON events
    BEGIN
      INSERT OR IGNORE INTO ${DIRTY_TABLE} (day_key)
        VALUES (${utcDirtyDaySql("OLD.timestamp_ms")});
      DELETE FROM ${DAY_TABLE}
      WHERE OLD.timestamp_ms >= start_ms AND OLD.timestamp_ms < end_ms;
    END
  `);
}

export function createUsageRollups(db) {
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
    // Model rows store the 16 periodAggregate fields; input/cached/output/reasoning are known-only.
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
    const deleteDay = db.prepare(`DELETE FROM ${TABLE} WHERE calendar_zone = ? AND day_key = ?`);
    const deleteModels = db.prepare(`DELETE FROM ${MODEL_TABLE} WHERE calendar_zone = ? AND day_key = ?`);
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
      deleteSessions.run(zone, day);
      markDay.run(zone, day, start, end);
      insertDay.run(zone, day, start, end);
      insertModels.run(zone, day, start, end);
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
        timestamp_ms, session_id, home_id, model, detail_mask,
        reconciliation_gap, total, input, cached, output, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const event of events) {
      const timestampMs = Date.parse(event.timestamp);
      if (!Number.isFinite(timestampMs)) throw new TypeError(`invalid event timestamp: ${String(event.timestamp)}`);
      const usage = event.total;
      if (!usage || typeof usage !== "object") throw new TypeError("event.total must be an object");
      insert.run(
        timestampMs,
        event.sessionId ?? null,
        String(event.homeId),
        String(event.model),
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
    const firstFullDayStart = Math.ceil(startMs / DAY_MS) * DAY_MS;
    const lastFullDayEnd = Math.floor(endMs / DAY_MS) * DAY_MS;
    if (firstFullDayStart >= lastFullDayEnd) {
      return queryRawModelRollupRows(db, startMs, endMs, excludeHomes, canonicalModels);
    }

    const startDay = new Date(firstFullDayStart).toISOString().slice(0, 10);
    const endDay = new Date(lastFullDayEnd - 1).toISOString().slice(0, 10);
    const days = calendarDays(startDay, endDay, "utc");
    const rows = queryUsageRollupModelsRangeWithinSnapshot(db, {
      startDay,
      endDay,
      days,
      excludeHomes,
      calendarZone: "utc",
      canonicalModels,
    });
    if (startMs < firstFullDayStart) {
      rows.push(...queryRawModelRollupRows(db, startMs, firstFullDayStart, excludeHomes, canonicalModels));
    }
    if (lastFullDayEnd < endMs) {
      rows.push(...queryRawModelRollupRows(db, lastFullDayEnd, endMs, excludeHomes, canonicalModels));
    }
    return mergeModelRollupRows(rows);
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
