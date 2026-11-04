import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const WORKSPACE_ROOT = path.resolve(path.dirname(SCRIPT_FILE), "../..");
export const DEFAULT_OUTPUT_ROOT = path.join(
  WORKSPACE_ROOT,
  "output",
  "architecture-20261103",
  "b1-derived-growth",
);
const SOURCE_FILE = path.join(
  WORKSPACE_ROOT,
  "output/architecture-20261102/full-startup/growth-standard-light-1-1x/state/usage-index.sqlite",
);
const DAY_MS = 86_400_000;
const PROFILE_DAYS = 90;
const CALENDAR_ZONE = "Asia/Shanghai";
export const NODE_FLAGS = Object.freeze(["--max-old-space-size=224", "--max-semi-space-size=4"]);
const TOKEN_FIELDS = ["total", "input", "cached", "output", "reasoning"];
const CLEARED_FACT_TABLES = [
  "archive_segments",
  "history_replaced_facts",
  "quota_usage_sources",
  "usage_rollup_daily",
  "usage_rollup_days",
  "usage_rollup_dirty_days",
  "usage_rollup_models",
  "usage_rollup_sessions",
];
const STALE_META_KEYS = ["official_quota_observations", "quota_source_log_evidence", "usage_file_fingerprints"];
const RUN_EVIDENCE_FILES = ["measurement-child.json", "restart-child.json", "result.json"];
const REQUIRED_EVENT_COLUMNS = [
  "id",
  "source_path",
  "timestamp_ms",
  "session_id",
  "hour_key",
  "day_key",
  "week_key",
  "month_key",
  ...TOKEN_FIELDS,
];

const SOURCE_EXPECTED = Object.freeze({
  events: 146_412,
  sessions: 1_729,
  quota: 71_153,
  minMs: Date.parse("2026-08-01T00:00:00.000Z"),
  maxMs: Date.parse("2026-10-30T00:00:00.000Z"),
  totals: Object.freeze({
    total: 2_196_180,
    input: 1_464_120,
    cached: 292_824,
    output: 732_060,
    reasoning: 117_309,
  }),
});

export const CASES = Object.freeze([
  Object.freeze({
    id: "01-session-growth-1729",
    label: "90-day 1729-session facts-DB derived diagnostic",
    mode: "session-growth",
    days: 90,
    expectedEvents: 146_412,
    expectedSessions: 1_729,
    expectedQuota: 71_153,
  }),
  Object.freeze({
    id: "02-session-growth-8645",
    label: "90-day 8645-session facts-DB derived diagnostic",
    mode: "session-growth",
    days: 90,
    expectedEvents: 146_412,
    expectedSessions: 8_645,
    expectedQuota: 71_153,
  }),
  Object.freeze({
    id: "03-session-growth-17290",
    label: "90-day 17290-session facts-DB derived diagnostic",
    mode: "session-growth",
    days: 90,
    expectedEvents: 146_412,
    expectedSessions: 17_290,
    expectedQuota: 71_153,
  }),
  Object.freeze({
    id: "04-12mo-facts-derived",
    label: "12-month daily-density facts-DB derived diagnostic",
    mode: "calendar-density",
    days: 365,
    expectedEvents: 593_782,
    expectedSessions: roundRatio(SOURCE_EXPECTED.sessions, 365, PROFILE_DAYS),
    expectedQuota: roundRatio(SOURCE_EXPECTED.quota, 365, PROFILE_DAYS),
  }),
  Object.freeze({
    id: "05-24mo-facts-derived",
    label: "24-month daily-density facts-DB derived diagnostic",
    mode: "calendar-density",
    days: 730,
    expectedEvents: 1_187_564,
    expectedSessions: roundRatio(SOURCE_EXPECTED.sessions, 730, PROFILE_DAYS),
    expectedQuota: roundRatio(SOURCE_EXPECTED.quota, 730, PROFILE_DAYS),
  }),
]);

function roundRatio(value, numerator, denominator) {
  const scaled = value * numerator;
  assert.ok(Number.isSafeInteger(scaled), "ratio input exceeds safe integer range");
  return Math.round(scaled / denominator);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function resolveOutputRoot(env = process.env) {
  const label = env.B1_DERIVED_LABEL;
  if (label === undefined) return DEFAULT_OUTPUT_ROOT;
  if (typeof label !== "string" || !/^[a-z0-9-]+$/.test(label)) {
    throw new TypeError("B1_DERIVED_LABEL must match [a-z0-9-]+");
  }
  return path.join(DEFAULT_OUTPUT_ROOT, label);
}

async function fileExists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function assertPrepareDestinationFresh(outputRoot) {
  const manifestFile = path.join(outputRoot, "manifest.json");
  if (await fileExists(manifestFile)) {
    throw new Error("prepared manifest already exists; choose a new B1_DERIVED_LABEL");
  }
}

export async function assertRunDestinationFresh(caseDirectory) {
  for (const name of RUN_EVIDENCE_FILES) {
    if (await fileExists(path.join(caseDirectory, name))) {
      throw new Error("run evidence already exists; choose a new B1_DERIVED_LABEL");
    }
  }
}

function relativeOutputPath(filePath, outputRoot) {
  return path.relative(outputRoot, filePath).split(path.sep).join("/");
}

function assertSafeCase(caseId) {
  const item = CASES.find((entry) => entry.id === caseId);
  if (!item) {
    throw new TypeError(`unknown case: ${String(caseId)}; choose one of ${CASES.map((entry) => entry.id).join(", ")}`);
  }
  return item;
}

function normalizeTotals(row) {
  const totals = {};
  for (const field of TOKEN_FIELDS) {
    const value = Number(row?.[field] ?? 0);
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`token sum ${field} is not a safe integer`);
    }
    totals[field] = value;
  }
  return totals;
}

function addTotals(left, right, multiplier = 1) {
  const result = {};
  for (const field of TOKEN_FIELDS) {
    const value = left[field] * multiplier + right[field];
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`expanded token sum ${field} is not a safe integer`);
    }
    result[field] = value;
  }
  return result;
}

function rowTotals(row) {
  return normalizeTotals(row);
}

function eventColumns(database) {
  const columns = database
    .prepare("PRAGMA main.table_info(events)")
    .all()
    .map((row) => String(row.name));
  for (const required of REQUIRED_EVENT_COLUMNS) {
    if (!columns.includes(required)) {
      throw new Error(`events schema cannot be copied safely: missing column ${required}`);
    }
  }
  return columns;
}

function tableExists(database, name) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(String(name)));
}

function factStats(database, { startMs = null, endMs = null } = {}) {
  const params = [];
  let where = "";
  if (startMs !== null || endMs !== null) {
    const clauses = [];
    if (startMs !== null) {
      clauses.push("timestamp_ms >= ?");
      params.push(startMs);
    }
    if (endMs !== null) {
      clauses.push("timestamp_ms <= ?");
      params.push(endMs);
    }
    where = ` WHERE ${clauses.join(" AND ")}`;
  }
  const row = database
    .prepare(
      `SELECT
         COUNT(*) AS events,
         COUNT(DISTINCT home_id || char(0) || session_id) AS sessions,
         COUNT(DISTINCT session_id) AS distinct_session_ids,
         COUNT(DISTINCT home_id) AS homes,
         MIN(timestamp_ms) AS min_ms,
         MAX(timestamp_ms) AS max_ms,
         COALESCE(SUM(total), 0) AS total,
         COALESCE(SUM(input), 0) AS input,
         COALESCE(SUM(cached), 0) AS cached,
         COALESCE(SUM(output), 0) AS output,
         COALESCE(SUM(reasoning), 0) AS reasoning
       FROM events${where}`,
    )
    .get(...params);
  return {
    events: Number(row.events),
    sessions: Number(row.sessions),
    distinctSessionIds: Number(row.distinct_session_ids),
    homes: Number(row.homes),
    minMs: row.min_ms === null ? null : Number(row.min_ms),
    maxMs: row.max_ms === null ? null : Number(row.max_ms),
    totals: rowTotals(row),
  };
}

function assertHomeSessionContracts(database, homes) {
  const statement = database.prepare(
    `SELECT
       COUNT(*) AS event_count,
       COUNT(DISTINCT home_id || char(0) || session_id) AS session_count,
       COUNT(DISTINCT session_id) AS distinct_session_ids
     FROM events
     WHERE home_id = ?`,
  );
  let totalSessions = 0;
  for (const home of homes) {
    const observed = statement.get(home.homeId);
    assert.equal(Number(observed.event_count), home.eventCount, `${home.homeId} event count mismatch`);
    assert.equal(Number(observed.session_count), home.targetSessions, `${home.homeId} session count mismatch`);
    assert.equal(Number(observed.distinct_session_ids), home.targetSessions, `${home.homeId} session ids collide`);
    totalSessions += Number(observed.session_count);
  }
  assert.equal(totalSessions, factStats(database).sessions, "home session allocations do not sum to the target");
}

function partialStats(database, limit) {
  if (limit === 0) {
    return { totals: Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0])) };
  }
  const row = database
    .prepare(
      `WITH source AS (
         SELECT session_id, ${TOKEN_FIELDS.join(", ")}
         FROM events
         ORDER BY id
         LIMIT ?
       )
       SELECT
         COALESCE(SUM(total), 0) AS total,
         COALESCE(SUM(input), 0) AS input,
         COALESCE(SUM(cached), 0) AS cached,
         COALESCE(SUM(output), 0) AS output,
         COALESCE(SUM(reasoning), 0) AS reasoning
       FROM source`,
    )
    .get(limit);
  return { totals: rowTotals(row) };
}

function quotaCount(database) {
  if (!tableExists(database, "rate_limit_observations")) {
    return 0;
  }
  return Number(database.prepare("SELECT COUNT(*) AS value FROM rate_limit_observations").get().value);
}

function utcDate(dateMs) {
  return new Date(dateMs).toISOString().slice(0, 10);
}

function shanghaiDate(dateMs) {
  return new Date(dateMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function shanghaiDayBounds(dateKey) {
  assert.match(dateKey, /^\d{4}-\d{2}-\d{2}$/);
  const startMs = Date.parse(`${dateKey}T00:00:00.000+08:00`);
  if (!Number.isFinite(startMs)) {
    throw new TypeError(`invalid date: ${dateKey}`);
  }
  return { startMs, endMs: startMs + DAY_MS - 1 };
}

function utcDayBounds(dateKey) {
  assert.match(dateKey, /^\d{4}-\d{2}-\d{2}$/);
  const startMs = Date.parse(`${dateKey}T00:00:00.000Z`);
  if (!Number.isFinite(startMs)) {
    throw new TypeError(`invalid date: ${dateKey}`);
  }
  return { startMs, endMs: startMs + DAY_MS - 1 };
}

export function homeFactStats(database) {
  return database
    .prepare(
      `SELECT
         home_id,
         COUNT(*) AS event_count,
         COUNT(DISTINCT session_id) AS session_count
       FROM events
       GROUP BY home_id
       ORDER BY home_id`,
    )
    .all()
    .map((row) => ({
      homeId: String(row.home_id),
      eventCount: Number(row.event_count),
      sessionCount: Number(row.session_count),
    }));
}

function generatedHomeEventCounts(database, plan) {
  if (plan.mode === "session-growth") {
    return new Map(homeFactStats(database).map((home) => [home.homeId, home.eventCount]));
  }
  const partial = database
    .prepare(
      `SELECT home_id, COUNT(*) AS event_count
       FROM (SELECT home_id FROM events ORDER BY id LIMIT ?)
       GROUP BY home_id`,
    )
    .all(plan.remainder);
  const partialCounts = new Map(partial.map((row) => [String(row.home_id), Number(row.event_count)]));
  return new Map(
    homeFactStats(database).map((home) => [
      home.homeId,
      home.eventCount * plan.fullCopies + (partialCounts.get(home.homeId) || 0),
    ]),
  );
}

export function allocateHomeSessions(homes, targetSessions) {
  if (!Number.isSafeInteger(targetSessions) || targetSessions <= 0) {
    throw new RangeError("targetSessions must be a positive safe integer");
  }
  const sourceSessions = homes.reduce((sum, home) => sum + home.sessionCount, 0);
  const capacity = homes.reduce((sum, home) => sum + home.eventCount, 0);
  if (targetSessions > capacity) {
    throw new RangeError(`targetSessions ${targetSessions} exceeds event capacity ${capacity}`);
  }
  const allocation = homes.map((home) => {
    const ideal = (targetSessions * home.sessionCount) / sourceSessions;
    return {
      ...home,
      ideal,
      targetSessions: Math.min(home.eventCount, Math.floor(ideal)),
    };
  });
  let remaining = targetSessions - allocation.reduce((sum, home) => sum + home.targetSessions, 0);
  while (remaining > 0) {
    const candidates = allocation.filter((home) => home.targetSessions < home.eventCount);
    if (candidates.length === 0) {
      throw new RangeError(`unable to allocate ${remaining} remaining sessions`);
    }
    candidates.sort(
      (left, right) =>
        right.ideal - right.targetSessions - (left.ideal - left.targetSessions) ||
        right.sessionCount - left.sessionCount ||
        left.homeId.localeCompare(right.homeId),
    );
    candidates[0].targetSessions += 1;
    remaining -= 1;
  }
  assert.equal(
    allocation.reduce((sum, home) => sum + home.targetSessions, 0),
    targetSessions,
    "home session allocation did not reach the target",
  );
  return allocation;
}

function buildPlan(base, spec) {
  if (spec.mode !== "session-growth" && spec.mode !== "calendar-density") {
    throw new TypeError(`invalid case mode: ${String(spec.mode)}`);
  }
  const calendarDensity = spec.mode === "calendar-density";
  const targetEvents = calendarDensity ? roundRatio(base.events, spec.days, PROFILE_DAYS) : base.events;
  const targetQuota = calendarDensity ? roundRatio(base.quota, spec.days, PROFILE_DAYS) : base.quota;
  const targetSessions = spec.expectedSessions;
  if (!Number.isSafeInteger(targetEvents) || targetEvents <= 0) {
    throw new RangeError(`invalid target event count for ${spec.id}`);
  }
  if (!Number.isSafeInteger(targetQuota) || targetQuota < 0) {
    throw new RangeError(`invalid target quota count for ${spec.id}`);
  }
  if (!Number.isSafeInteger(targetSessions) || targetSessions <= 0) {
    throw new RangeError(`invalid target session count for ${spec.id}`);
  }

  const fullCopies = Math.floor(targetEvents / base.events);
  const remainder = targetEvents % base.events;
  return {
    mode: spec.mode,
    fullCopies,
    remainder,
    targetEvents,
    targetQuota,
    targetSessions,
    startMs: calendarDensity ? base.maxMs - spec.days * DAY_MS : base.minMs,
    endMs: base.maxMs,
  };
}

function createScaledRows(database, plan, columns) {
  const timestampValue = "derived.timestamp_ms";
  const localTimestamp = `${timestampValue} / 1000, 'unixepoch', '+8 hours'`;
  const homeRowNumber = `ROW_NUMBER() OVER (PARTITION BY src.home_id ORDER BY derived.n)`;
  const homeEventCount = `COUNT(*) OVER (PARTITION BY src.home_id)`;
  const expressions = columns.map((column) => {
    if (column === "id") return "CAST(n + 1 AS INTEGER)";
    if (column === "timestamp_ms") return timestampValue;
    if (column === "session_id") {
      return `printf('b1:%s:%06d', src.home_id,
        CAST((${homeRowNumber} - 1) * target.target_sessions / ${homeEventCount} AS INTEGER))`;
    }
    if (column === "hour_key") return `strftime('%Y-%m-%d %H', ${localTimestamp})`;
    if (column === "day_key") return `strftime('%Y-%m-%d', ${localTimestamp})`;
    if (column === "week_key") {
      return `date(${localTimestamp},
        '-' || ((CAST(strftime('%w', ${localTimestamp}) AS INTEGER) + 6) % 7) || ' days')`;
    }
    if (column === "month_key") return `strftime('%Y-%m', ${localTimestamp})`;
    return `src.${quoteIdentifier(column)}`;
  });
  const insertColumns = columns.map(quoteIdentifier).join(", ");
  const parameters = [plan.targetEvents, plan.startMs, plan.endMs, plan.startMs];
  const cte = `WITH RECURSIVE n(value) AS (
      SELECT 0
      UNION ALL
      SELECT value + 1 FROM n WHERE value + 1 < ?1
    ),
    derived AS (
      SELECT
        n.value AS n,
        CAST(?2 + ROUND(n.value * (?3 - ?4) * 1.0 / (?1 - 1)) AS INTEGER) AS timestamp_ms
      FROM n
    )
    INSERT INTO events (${insertColumns})
    SELECT ${expressions.join(", ")}
    FROM derived
    JOIN b1_event_source src
      ON src.b1_rank = (derived.n % (SELECT COUNT(*) FROM b1_event_source)) + 1
    JOIN b1_home_session_targets target ON target.home_id = src.home_id`;
  database.prepare(cte).run(...parameters);
}

function createHomeSessionTargets(database, plan) {
  const generatedCounts = generatedHomeEventCounts(database, plan);
  const allocation = allocateHomeSessions(
    homeFactStats(database).map((home) => ({
      ...home,
      eventCount: generatedCounts.get(home.homeId) || 0,
    })),
    plan.targetSessions,
  );
  database.exec(`
    DROP TABLE IF EXISTS b1_home_session_targets;
    CREATE TEMP TABLE b1_home_session_targets (
      home_id TEXT PRIMARY KEY,
      event_count INTEGER NOT NULL,
      target_sessions INTEGER NOT NULL
    ) STRICT;
  `);
  const insert = database.prepare(
    "INSERT INTO b1_home_session_targets (home_id, event_count, target_sessions) VALUES (?, ?, ?)",
  );
  for (const home of allocation) {
    insert.run(home.homeId, home.eventCount, home.targetSessions);
  }
  return allocation.map(({ homeId, eventCount, targetSessions, sessionCount }) => ({
    homeId,
    eventCount,
    sourceSessions: sessionCount,
    targetSessions,
  }));
}

function remapExistingSessions(database) {
  database.exec(`
    CREATE TEMP TABLE b1_session_map AS
    WITH ranked AS (
      SELECT
        id,
        home_id,
        ROW_NUMBER() OVER (PARTITION BY home_id ORDER BY timestamp_ms, id) AS home_row_number,
        COUNT(*) OVER (PARTITION BY home_id) AS home_event_count
      FROM main.events
    )
    SELECT
      ranked.id AS event_id,
      printf(
        'b1:%s:%06d',
        ranked.home_id,
        CAST(
          (ranked.home_row_number - 1) * target.target_sessions / ranked.home_event_count
          AS INTEGER
        )
      ) AS session_id
    FROM ranked
    JOIN b1_home_session_targets target ON target.home_id = ranked.home_id;

    CREATE UNIQUE INDEX b1_session_map_event_idx ON b1_session_map(event_id);

    UPDATE main.events
    SET
      session_id = (SELECT session_id FROM b1_session_map WHERE event_id = events.id),
      hour_key = strftime('%Y-%m-%d %H', timestamp_ms / 1000, 'unixepoch', '+8 hours'),
      day_key = strftime('%Y-%m-%d', timestamp_ms / 1000, 'unixepoch', '+8 hours'),
      week_key = date(
        timestamp_ms / 1000,
        'unixepoch',
        '+8 hours',
        '-' || (
          (CAST(strftime('%w', timestamp_ms / 1000, 'unixepoch', '+8 hours') AS INTEGER) + 6) % 7
        ) || ' days'
      ),
      month_key = strftime('%Y-%m', timestamp_ms / 1000, 'unixepoch', '+8 hours');

    DROP TABLE b1_session_map;
  `);
}

function createScaledQuota(database, baseQuota, targetQuota, startMs, endMs) {
  if (baseQuota === 0 || targetQuota === 0) {
    return;
  }
  database.exec(`
    CREATE TEMP TABLE b1_quota_source AS
    SELECT ROW_NUMBER() OVER (ORDER BY source_path, line_number, role) AS b1_rank, *
    FROM main.rate_limit_observations;
    DELETE FROM main.rate_limit_observations;
  `);
  database
    .prepare(
      `WITH RECURSIVE n(value) AS (
         SELECT 0
         UNION ALL
         SELECT value + 1 FROM n WHERE value + 1 < ?1
       ),
       derived AS (
         SELECT
           n.value AS n,
           CAST(?2 + ROUND(n.value * (?3 - ?4) * 1.0 / (?1 - 1)) AS INTEGER) AS observed_at_ms
         FROM n
       )
       INSERT INTO rate_limit_observations (
         source_path, line_number, role, observed_at_ms, limit_id, limit_name,
         plan_type, window_minutes, resets_at_ms, used_percent
       )
       SELECT
         src.source_path,
         derived.n + 1,
         src.role,
         derived.observed_at_ms,
         src.limit_id,
         src.limit_name,
         src.plan_type,
         src.window_minutes,
         src.resets_at_ms + (derived.observed_at_ms - src.observed_at_ms),
         src.used_percent
       FROM derived
       JOIN b1_quota_source src
         ON src.b1_rank = (derived.n % ?5) + 1`,
    )
    .run(targetQuota, startMs, endMs, startMs, baseQuota);
  database.exec("DROP TABLE b1_quota_source");
}

function clearDerivedState(database) {
  for (const table of CLEARED_FACT_TABLES) {
    if (tableExists(database, table)) {
      database.exec(`DELETE FROM ${quoteIdentifier(table)};`);
    }
  }
  const deleteMeta = database.prepare("DELETE FROM store_meta WHERE key = ?");
  for (const key of STALE_META_KEYS) {
    deleteMeta.run(key);
  }
}

function ensureExpectedSource(stats) {
  assert.equal(stats.events, SOURCE_EXPECTED.events, "source event count drifted");
  assert.equal(stats.sessions, SOURCE_EXPECTED.sessions, "source session count drifted");
  assert.equal(stats.distinctSessionIds, SOURCE_EXPECTED.sessions, "source session ids are not globally unique");
  assert.equal(stats.quota, SOURCE_EXPECTED.quota, "source quota count drifted");
  assert.equal(stats.minMs, SOURCE_EXPECTED.minMs, "source minimum date drifted");
  assert.equal(stats.maxMs, SOURCE_EXPECTED.maxMs, "source maximum date drifted");
  assert.deepEqual(stats.totals, SOURCE_EXPECTED.totals, "source token sums drifted");
}

async function sqliteCopy(sourceFile, targetFile) {
  await rm(targetFile, { force: true });
  await mkdir(path.dirname(targetFile), { recursive: true });
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  try {
    await backup(source, targetFile);
  } finally {
    source.close();
  }
}

function readPreparedStats(database, plan) {
  const observed = factStats(database);
  const endDate = utcDate(plan.endMs);
  const localToday = shanghaiDayBounds(endDate);
  const utcToday = utcDayBounds(endDate);
  const localTodayStats = factStats(database, localToday);
  const utcTodayStats = factStats(database, utcToday);
  return {
    observed: { ...observed, quota: quotaCount(database) },
    scopes: {
      "today-local": localTodayStats,
      "all-local": observed,
      "calendar-local": observed,
      "today-utc": utcTodayStats,
      "all-utc": observed,
      "calendar-utc": observed,
    },
    todayBounds: { local: localToday, utc: utcToday },
  };
}

async function replacePreparedFile(temporary, target) {
  await rm(target, { force: true });
  await copyFile(temporary, target);
  await rm(temporary, { force: true });
}

function applyCasePlan(database, plan) {
  const columns = eventColumns(database);
  const base = factStats(database);
  const baseQuota = quotaCount(database);
  const partial = partialStats(database, plan.remainder);
  const expectedTotals =
    plan.mode === "calendar-density" ? addTotals(base.totals, partial.totals, plan.fullCopies) : base.totals;
  const expectedSessions = plan.targetSessions;

  database.exec("PRAGMA foreign_keys = OFF;");
  database.exec("BEGIN IMMEDIATE");
  try {
    const homeSessions = createHomeSessionTargets(database, plan);
    if (plan.mode === "calendar-density") {
      database.exec(`
        CREATE TEMP TABLE b1_event_source AS
        SELECT ROW_NUMBER() OVER (ORDER BY id) AS b1_rank, *
        FROM main.events;
        DELETE FROM main.events;
      `);
      createScaledRows(database, plan, columns);
      createScaledQuota(database, baseQuota, plan.targetQuota, plan.startMs, plan.endMs);
    } else {
      remapExistingSessions(database);
      assert.equal(quotaCount(database), plan.targetQuota, "session growth changed quota rows");
    }
    clearDerivedState(database);
    database
      .prepare("INSERT OR REPLACE INTO store_meta (key, value) VALUES ('generated_at', ?)")
      .run(new Date(plan.endMs + DAY_MS - 1).toISOString());
    database.exec("DROP TABLE IF EXISTS b1_event_source; DROP TABLE b1_home_session_targets;");
    const observed = factStats(database);
    assert.equal(observed.events, plan.targetEvents, "expanded event count mismatch");
    assert.equal(
      observed.sessions,
      plan.targetSessions,
      `expanded session count mismatch: ${JSON.stringify(
        database
          .prepare("SELECT session_id, COUNT(*) AS events FROM events GROUP BY session_id ORDER BY session_id")
          .all(),
      )}`,
    );
    assert.equal(observed.distinctSessionIds, plan.targetSessions, "home-prefixed session ids are not globally unique");
    assertHomeSessionContracts(database, homeSessions);
    assert.equal(observed.minMs, plan.startMs, "expanded minimum date mismatch");
    assert.equal(observed.maxMs, plan.endMs, "expanded maximum date mismatch");
    assert.deepEqual(observed.totals, expectedTotals, "expanded token sums mismatch");
    assert.equal(quotaCount(database), plan.targetQuota, "expanded quota count mismatch");
    assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok");
    database.exec("COMMIT");
    return { expectedTotals, expectedSessions, homeSessions };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.exec("PRAGMA foreign_keys = ON;");
  }
}

export function buildCasePlan(baseStats, caseId, caseSpec = null) {
  const spec = caseSpec ? normalizeCustomSpec(caseSpec) : assertSafeCase(caseId);
  return buildPlan(baseStats, spec);
}

function normalizeCustomSpec(spec) {
  if (!spec || typeof spec !== "object") {
    throw new TypeError("caseSpec must be an object");
  }
  for (const field of ["id", "days"]) {
    if (typeof spec[field] !== "string" && typeof spec[field] !== "number") {
      throw new TypeError(`caseSpec.${field} is required`);
    }
  }
  return {
    id: String(spec.id),
    label: String(spec.label || spec.id),
    mode: String(spec.mode),
    days: Number(spec.days),
    expectedEvents: Number(spec.expectedEvents),
    expectedSessions: Number(spec.expectedSessions),
    expectedQuota: Number(spec.expectedQuota),
  };
}

export async function buildDerivedCase({ sourceFile, outputFile, caseId, caseSpec = null }) {
  const spec = caseSpec ? normalizeCustomSpec(caseSpec) : assertSafeCase(caseId);
  const temporary = `${outputFile}.tmp`;
  await sqliteCopy(sourceFile, temporary);
  let database;
  try {
    database = new DatabaseSync(temporary);
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
    `);
    const base = factStats(database);
    const plan = buildPlan({ ...base, quota: quotaCount(database) }, spec);
    if (!caseSpec) {
      ensureExpectedSource({ ...base, quota: quotaCount(database) });
    }
    const application = applyCasePlan(database, plan);
    assert.equal(plan.targetEvents, spec.expectedEvents, `${spec.id} target event count drifted`);
    assert.equal(plan.targetSessions, spec.expectedSessions, `${spec.id} target session count drifted`);
    assert.equal(plan.targetQuota, spec.expectedQuota, `${spec.id} target quota count drifted`);
    if (!caseSpec && plan.mode === "session-growth") {
      assert.deepEqual(application.expectedTotals, SOURCE_EXPECTED.totals, "session growth changed token totals");
      assert.equal(plan.targetEvents, SOURCE_EXPECTED.events, "session growth changed event count");
      assert.equal(plan.targetQuota, SOURCE_EXPECTED.quota, "session growth changed quota");
      assert.equal(plan.startMs, SOURCE_EXPECTED.minMs, "session growth changed minimum date");
      assert.equal(plan.endMs, SOURCE_EXPECTED.maxMs, "session growth changed maximum date");
    }
    const stats = readPreparedStats(database, plan);
    assert.equal(stats.observed.events, spec.expectedEvents);
    assert.equal(stats.observed.sessions, spec.expectedSessions);
    assert.equal(stats.observed.distinctSessionIds, spec.expectedSessions);
    assert.equal(stats.observed.quota, plan.targetQuota);
    assert.equal(stats.observed.minMs, plan.startMs);
    assert.equal(stats.observed.maxMs, plan.endMs);
    assert.deepEqual(stats.observed.totals, application.expectedTotals);
    assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok");
    database.close();
    database = null;
    await replacePreparedFile(temporary, outputFile);
    return {
      spec,
      plan,
      expectedTotals: application.expectedTotals,
      homeSessions: application.homeSessions,
      expected: {
        label: spec.label,
        mode: spec.mode,
        measurementScope: "facts-db-derived-only",
        endToEnd: false,
        events: spec.expectedEvents,
        sessions: spec.expectedSessions,
        quota: plan.targetQuota,
        minMs: plan.startMs,
        maxMs: plan.endMs,
        dateStart: utcDate(plan.startMs),
        dateEnd: utcDate(plan.endMs),
        localDateStart: shanghaiDate(plan.startMs),
        localDateEnd: shanghaiDate(plan.endMs),
        totals: application.expectedTotals,
      },
      observed: stats.observed,
      todayBounds: stats.todayBounds,
      scopeExpected: Object.fromEntries(
        Object.entries(stats.scopes).map(([scope, value]) => [
          scope,
          {
            events: value.events,
            sessions: value.sessions,
            distinctSessionIds: value.distinctSessionIds,
            homes: value.homes,
            totals: value.totals,
          },
        ]),
      ),
      bytes: Number((await stat(outputFile)).size),
    };
  } catch (error) {
    database?.close();
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function prepare() {
  const outputRoot = resolveOutputRoot();
  await assertPrepareDestinationFresh(outputRoot);
  const sourceBefore = await stat(SOURCE_FILE);
  const source = new DatabaseSync(SOURCE_FILE, { readOnly: true });
  let sourceStats;
  try {
    sourceStats = factStats(source);
    sourceStats.quota = quotaCount(source);
    ensureExpectedSource(sourceStats);
  } finally {
    source.close();
  }

  await mkdir(outputRoot, { recursive: true });
  const baseDirectory = path.join(outputRoot, "base");
  const baseFile = path.join(baseDirectory, "usage-index.sqlite");
  await mkdir(baseDirectory, { recursive: true });
  const baseTemporary = `${baseFile}.tmp`;
  await sqliteCopy(SOURCE_FILE, baseTemporary);
  await replacePreparedFile(baseTemporary, baseFile);

  const entries = [];
  for (const spec of CASES) {
    const caseDirectory = path.join(outputRoot, "cases", spec.id);
    const databaseFile = path.join(caseDirectory, "usage-index.sqlite");
    const built = await buildDerivedCase({ sourceFile: baseFile, outputFile: databaseFile, caseId: spec.id });
    await rm(path.join(caseDirectory, "result.json"), { force: true });
    await rm(path.join(caseDirectory, "measurement-child.json"), { force: true });
    await rm(path.join(caseDirectory, "restart-child.json"), { force: true });
    entries.push({
      id: spec.id,
      label: spec.label,
      mode: spec.mode,
      days: spec.days,
      measurementScope: "facts-db-derived-only",
      endToEnd: false,
      database: relativeOutputPath(databaseFile, outputRoot),
      bytes: built.bytes,
      expected: built.expected,
      observed: built.observed,
      homeSessions: built.homeSessions,
      todayBounds: built.todayBounds,
      scopeExpected: built.scopeExpected,
    });
    process.stdout.write(`${JSON.stringify({ stage: "prepared", case: spec.id })}\n`);
  }

  const sourceAfter = await stat(SOURCE_FILE);
  assert.equal(sourceAfter.size, sourceBefore.size, "source database size changed");
  assert.equal(sourceAfter.mtimeMs, sourceBefore.mtimeMs, "source database mtime changed");
  const manifest = {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      path: path.relative(WORKSPACE_ROOT, SOURCE_FILE).split(path.sep).join("/"),
      readOnly: true,
      before: { size: sourceBefore.size, mtimeMs: sourceBefore.mtimeMs },
      after: { size: sourceAfter.size, mtimeMs: sourceAfter.mtimeMs },
      stats: sourceStats,
    },
    profile: {
      days: PROFILE_DAYS,
      events: SOURCE_EXPECTED.events,
      sessions: SOURCE_EXPECTED.sessions,
      quota: SOURCE_EXPECTED.quota,
      totals: SOURCE_EXPECTED.totals,
    },
    calendarZone: CALENDAR_ZONE,
    cases: entries,
  };
  const manifestFile = path.join(outputRoot, "manifest.json");
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify({ stage: "prepare-complete", cases: entries.length })}\n`);
  return manifest;
}

function dashboardFilters(entry, scope) {
  const [range, zone] = scope.split("-");
  if (zone !== "local" && zone !== "utc") {
    throw new TypeError(`unknown scope: ${scope}`);
  }
  const now = new Date(entry.todayBounds[zone].endMs);
  const common = { calendarZone: zone, now };
  if (range === "today") return { ...common, preset: "today", bucket: "hour" };
  if (range === "all") return { ...common, preset: "all", bucket: "day" };
  if (range === "calendar") {
    return {
      ...common,
      preset: "custom",
      startDate: zone === "local" ? entry.expected.localDateStart : entry.expected.dateStart,
      endDate: zone === "local" ? entry.expected.localDateEnd : entry.expected.dateEnd,
      bucket: entry.days > 180 ? "week" : "day",
    };
  }
  throw new TypeError(`unknown scope: ${scope}`);
}

function assertFiniteTree(value, at = "$", seen = new Set()) {
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${at} is not finite`);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (let index = 0; index < Math.min(value.length, 32); index += 1) {
      assertFiniteTree(value[index], `${at}[${index}]`, seen);
    }
    return;
  }
  assert.ok(!seen.has(value), `${at} contains a cycle`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    assertFiniteTree(child, `${at}.${key}`, seen);
  }
  seen.delete(value);
}

function assertCompleteDashboard(value) {
  assert.ok(value && typeof value === "object", "dashboard result is not an object");
  for (const key of ["summary", "metadata", "periodComparison"]) {
    assert.ok(value[key] && typeof value[key] === "object", `dashboard result missing ${key}`);
  }
  for (const key of [
    "range",
    "totals",
    "comparison",
    "costEstimate",
    "records",
    "timeline",
    "timelineError",
    "channels",
    "models",
    "homes",
    "projects",
    "repositories",
  ]) {
    assert.ok(Object.hasOwn(value.summary, key), `summary missing ${key}`);
  }
  for (const key of ["eventCount", "sessionCount", "homeCount"]) {
    assert.ok(Number.isSafeInteger(value.summary[key]), `summary.${key} is not an integer`);
    assert.ok(Number.isSafeInteger(value.metadata[key]), `metadata.${key} is not an integer`);
  }
  for (const key of ["timeline", "channels", "models", "homes", "projects", "repositories"]) {
    assert.ok(Array.isArray(value.summary[key]), `summary.${key} is not an array`);
  }
  assertFiniteTree(value);
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function dashboardEvidence(result, scope) {
  return {
    scope,
    range: result.summary.range,
    eventCount: result.summary.eventCount,
    sessionCount: result.summary.sessionCount,
    homeCount: result.summary.homeCount,
    totals: result.summary.totals,
    metadataEventCount: result.metadata.eventCount,
    metadataSessionCount: result.metadata.sessionCount,
    digest: digest(result),
  };
}

function cpuMilliseconds(usage) {
  return {
    userMs: usage.user / 1000,
    systemMs: usage.system / 1000,
    totalMs: (usage.user + usage.system) / 1000,
  };
}

function resourceSnapshot() {
  const usage = process.resourceUsage();
  return {
    rssBytes: process.memoryUsage().rss,
    osMaxRssBytes: usage.maxRSS * 1024,
  };
}

async function executeScopes(databaseFile, entry) {
  const totalStarted = performance.now();
  const totalCpuStarted = process.cpuUsage();
  const resourcesStarted = resourceSnapshot();
  const importsStarted = performance.now();
  const { UsageStore } = await import("../../src/usage-store.js");
  const importMs = performance.now() - importsStarted;
  const store = new UsageStore({
    databaseFile,
    env: {},
    importDirs: [],
    pricingRefreshSchedulerEnabled: false,
  });
  let homesMs = 0;
  try {
    const openStarted = performance.now();
    await store.open();
    const openMs = performance.now() - openStarted;
    const homesStarted = performance.now();
    store.homes = store.database
      .prepare(
        `SELECT
           home_id AS id,
           MAX(home_label) AS label,
           MAX(home_path) AS path,
           CASE
             WHEN kind IN ('main', 'jetbrains', 'extra', 'codex') THEN 'codex'
             ELSE kind
           END AS kind
         FROM source_files
         GROUP BY home_id, CASE
           WHEN kind IN ('main', 'jetbrains', 'extra', 'codex') THEN 'codex'
           ELSE kind
         END
         ORDER BY id, kind`,
      )
      .all();
    homesMs = performance.now() - homesStarted;
    assert.ok(store.homes.length > 0, "source_files produced no homes");

    const scopes = {};
    const scopesToRun = ["today-local", "all-local", "calendar-local", "today-utc", "all-utc", "calendar-utc"];
    for (const scope of scopesToRun) {
      const scopeCpuStarted = process.cpuUsage();
      const scopeResourcesStarted = resourceSnapshot();
      const scopeStarted = performance.now();
      const result = await store.dashboardHistory(dashboardFilters(entry, scope));
      const elapsedMs = performance.now() - scopeStarted;
      assertCompleteDashboard(result);
      const expected = entry.scopeExpected[scope];
      assert.equal(result.summary.range.calendarZone, scope.endsWith("-utc") ? "utc" : "local");
      assert.equal(result.summary.eventCount, expected.events, `${scope} event count mismatch`);
      assert.equal(result.summary.sessionCount, expected.sessions, `${scope} session count mismatch`);
      assert.equal(result.summary.homeCount, expected.homes, `${scope} home count mismatch`);
      assert.deepEqual(result.summary.totals, expected.totals, `${scope} token totals mismatch`);
      assert.equal(result.metadata.eventCount, entry.expected.events, `${scope} metadata event inventory mismatch`);
      assert.equal(
        result.metadata.sessionCount,
        entry.expected.sessions,
        `${scope} metadata session inventory mismatch`,
      );
      assert.equal(result.metadata.homeCount, entry.observed.homes, `${scope} metadata home inventory mismatch`);
      const resourcesNow = resourceSnapshot();
      scopes[scope] = {
        elapsedMs,
        cpu: cpuMilliseconds(process.cpuUsage(scopeCpuStarted)),
        rss: {
          start: scopeResourcesStarted.rssBytes,
          current: resourcesNow.rssBytes,
          osPeakBytes: resourcesNow.osMaxRssBytes,
        },
        evidence: dashboardEvidence(result, scope),
      };
    }
    return {
      importMs,
      openMs,
      homesMs,
      homes: store.homes,
      elapsedMs: performance.now() - totalStarted,
      cpu: cpuMilliseconds(process.cpuUsage(totalCpuStarted)),
      rss: {
        start: resourcesStarted.rssBytes,
        end: process.memoryUsage().rss,
        osPeakBytes: process.resourceUsage().maxRSS * 1024,
      },
      scopes,
    };
  } finally {
    store.close();
  }
}

async function childMain(caseId, phase, resultFile) {
  const startedAt = new Date().toISOString();
  let payload;
  try {
    const outputRoot = resolveOutputRoot();
    const manifest = JSON.parse(await readFile(path.join(outputRoot, "manifest.json"), "utf8"));
    const entry = manifest.cases.find((item) => item.id === caseId);
    if (!entry) throw new Error(`case ${caseId} is absent from manifest`);
    const databaseFile = path.join(outputRoot, entry.database);
    const database = new DatabaseSync(databaseFile, { readOnly: true });
    let observed;
    try {
      observed = factStats(database);
      observed.quota = quotaCount(database);
      assertHomeSessionContracts(database, entry.homeSessions);
      assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok");
    } finally {
      database.close();
    }
    assert.equal(observed.events, entry.expected.events);
    assert.equal(observed.sessions, entry.expected.sessions);
    assert.equal(observed.distinctSessionIds, entry.expected.sessions);
    assert.equal(observed.quota, entry.expected.quota);
    assert.equal(observed.minMs, entry.expected.minMs);
    assert.equal(observed.maxMs, entry.expected.maxMs);
    assert.deepEqual(observed.totals, entry.expected.totals);
    const run = await executeScopes(databaseFile, entry);
    payload = {
      passed: true,
      caseId,
      phase,
      startedAt,
      finishedAt: new Date().toISOString(),
      node: {
        version: process.version,
        execArgv: process.execArgv,
        pid: process.pid,
      },
      limits: {
        maxOldSpaceMiB: 224,
        maxSemiSpaceMiB: 4,
        oneActiveChild: true,
      },
      run,
    };
  } catch (error) {
    payload = {
      passed: false,
      caseId,
      phase,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: { name: error?.name, message: error?.message, stack: error?.stack },
    };
  }
  await writeFile(resultFile, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx" });
  if (!payload.passed) process.exitCode = 1;
}

async function spawnChild(caseId, phase, resultFile) {
  const env = { ...process.env, TZ: CALENDAR_ZONE };
  delete env.NODE_OPTIONS;
  const child = spawn(
    process.execPath,
    [...NODE_FLAGS, "--disable-warning=ExperimentalWarning", SCRIPT_FILE, "__run-child", caseId, phase, resultFile],
    {
      cwd: WORKSPACE_ROOT,
      env,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 262_144) stderr += chunk;
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let payload;
  try {
    payload = JSON.parse(await readFile(resultFile, "utf8"));
  } catch {
    payload = {
      passed: false,
      caseId,
      phase,
      error: { message: `child exited without a result (${exitCode.code}, ${exitCode.signal})`, stderr },
    };
  }
  return { exitCode, payload };
}

function comparableScopes(run) {
  return Object.fromEntries(Object.entries(run.scopes).map(([scope, value]) => [scope, value.evidence]));
}

async function run(caseId) {
  const spec = assertSafeCase(caseId);
  const outputRoot = resolveOutputRoot();
  const manifest = JSON.parse(await readFile(path.join(outputRoot, "manifest.json"), "utf8"));
  const entry = manifest.cases.find((item) => item.id === spec.id);
  if (!entry) throw new Error(`case ${spec.id} is absent from prepared manifest`);
  const caseDirectory = path.join(outputRoot, "cases", spec.id);
  await assertRunDestinationFresh(caseDirectory);
  await mkdir(caseDirectory, { recursive: true });
  const measurementFile = path.join(caseDirectory, "measurement-child.json");
  const restartFile = path.join(caseDirectory, "restart-child.json");
  const resultFile = path.join(caseDirectory, "result.json");

  process.stdout.write(`${JSON.stringify({ stage: "run-start", case: spec.id })}\n`);
  const measurement = await spawnChild(spec.id, "measurement", measurementFile);
  if (measurement.exitCode.code !== 0 || !measurement.payload.passed) {
    await writeFile(
      resultFile,
      `${JSON.stringify({ passed: false, caseId: spec.id, phase: "measurement", measurement }, null, 2)}\n`,
      { flag: "wx" },
    );
    process.stdout.write(`${JSON.stringify({ stage: "run-failed", case: spec.id, phase: "measurement" })}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({ stage: "restart", case: spec.id })}\n`);
  const restart = await spawnChild(spec.id, "restart", restartFile);
  const before = comparableScopes(measurement.payload.run);
  const after = restart.payload.passed ? comparableScopes(restart.payload.run) : null;
  const reuse = {
    identical: Boolean(after) && JSON.stringify(before) === JSON.stringify(after),
    scopes: before,
  };
  if (restart.exitCode.code !== 0 || !restart.payload.passed || !reuse.identical) {
    await writeFile(
      resultFile,
      `${JSON.stringify(
        {
          passed: false,
          caseId: spec.id,
          phase: "restart",
          measurement: measurement.payload,
          restart: restart.payload,
          reuse,
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    process.stdout.write(`${JSON.stringify({ stage: "run-failed", case: spec.id, phase: "restart" })}\n`);
    process.exitCode = 1;
    return;
  }
  await writeFile(
    resultFile,
    `${JSON.stringify(
      {
        passed: true,
        caseId: spec.id,
        createdAt: new Date().toISOString(),
        nodeFlags: NODE_FLAGS,
        singleChild: true,
        measurement: measurement.payload,
        restart: restart.payload,
        reuse,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  process.stdout.write(`${JSON.stringify({ stage: "run-complete", case: spec.id, passed: true })}\n`);
}

function usage() {
  process.stderr.write(
    "Usage:\n" +
      "  node experiments/architecture-20261101/b1-derived-growth.mjs prepare\n" +
      `  node experiments/architecture-20261101/b1-derived-growth.mjs run <${CASES.map((entry) => entry.id).join("|")}>\n`,
  );
}

async function main() {
  const [command, caseId, phase, resultFile] = process.argv.slice(2);
  if (command === "prepare") {
    await prepare();
    return;
  }
  if (command === "run" && caseId) {
    await run(caseId);
    return;
  }
  if (command === "__run-child" && caseId && phase && resultFile) {
    await childMain(caseId, phase, path.resolve(resultFile));
    return;
  }
  usage();
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
