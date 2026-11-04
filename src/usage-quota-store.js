import { createHash } from "node:crypto";
import {
  USAGE_QUOTA_PROJECTION_TABLE_NAMES,
  ensureQuotaProjectionSchema,
  prepareQuotaProjection,
  readQuotaProjection,
  quotaProjectionBounds,
  quotaProjectionCacheUsable,
  quotaProjectionWork,
  resetQuotaProjectionWork,
} from "./usage-quota-projection.js";
export { quotaProjectionWork };

const MS_PER_MINUTE = 60_000;
const ENDPOINT_TOLERANCE_MS = 2 * MS_PER_MINUTE;
const PERCENT_STALE_AFTER_MS = 10 * MS_PER_MINUTE;
const CACHE_FORMAT_VERSION = 1;
const MIN_CACHE_BOUNDARY = Number.MIN_SAFE_INTEGER;
const MAX_CACHE_BOUNDARY = Number.MAX_SAFE_INTEGER;
const QUOTA_WINDOW_MINUTES = Object.freeze({
  quota_5h: 300,
  quota_week: 10_080,
});

export const USAGE_QUOTA_TABLE_NAMES = Object.freeze([
  "quota_revision",
  "usage_quota_window_cache",
  ...USAGE_QUOTA_PROJECTION_TABLE_NAMES,
]);

let tempSequence = 0;
const schemaReady = new WeakMap();
function installProjection(database) {
  if (database.isTransaction) return;
  try {
    ensureQuotaProjectionSchema(database);
  } catch (error) {
    if (!/readonly|locked|busy/i.test(String(error.message))) throw error;
  }
}

/**
 * Install the quota-owned revision and cache tables plus source revision triggers.
 *
 * @param {any} database
 * @returns {boolean} whether the persistent schema is available
 */
export function ensureUsageQuotaSchema(database) {
  if (schemaReady.get(database) === true) {
    installProjection(database);
    return true;
  }
  if (database.isTransaction) return false;
  try {
    const existing = database
      .prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE
      (type = 'table' AND name IN ('quota_revision', 'usage_quota_window_cache')) OR
      (type = 'trigger' AND name IN ('quota_revision_rate_limit_insert',
        'quota_revision_rate_limit_update', 'quota_revision_rate_limit_delete'))`)
      .get();
    if (Number(existing.count) === 5 && database.prepare("SELECT 1 FROM quota_revision WHERE singleton = 1").get()) {
      schemaReady.set(database, true);
      installProjection(database);
      return true;
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS quota_revision (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO quota_revision (singleton, revision) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS usage_quota_window_cache (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        format_version INTEGER NOT NULL,
        quota_revision INTEGER NOT NULL,
        official_signature TEXT NOT NULL,
        valid_from_ms REAL NOT NULL,
        valid_to_ms REAL NOT NULL,
        result_json TEXT NOT NULL
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS quota_revision_rate_limit_insert
      AFTER INSERT ON rate_limit_observations
      BEGIN
        UPDATE quota_revision SET revision = revision + 1 WHERE singleton = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS quota_revision_rate_limit_update
      AFTER UPDATE ON rate_limit_observations
      BEGIN
        UPDATE quota_revision SET revision = revision + 1 WHERE singleton = 1;
      END;
      CREATE TRIGGER IF NOT EXISTS quota_revision_rate_limit_delete
      AFTER DELETE ON rate_limit_observations
      BEGIN
        UPDATE quota_revision SET revision = revision + 1 WHERE singleton = 1;
      END;
    `);
    schemaReady.set(database, true);
    installProjection(database);
    return true;
  } catch (error) {
    schemaReady.delete(database);
    if (!/readonly|locked|busy/i.test(String(error.message))) throw error;
    return false;
  }
}

function tempName(prefix) {
  tempSequence += 1;
  return `"codex_usage_quota_${prefix}_${process.pid}_${tempSequence}"`;
}

function observationValue(observation, camelName, snakeName) {
  return observation?.[camelName] ?? observation?.[snakeName];
}

function observationIdentity(observation, index) {
  const sourcePath = observation.sourcePath ?? observation.source_path;
  const lineNumber = observation.lineNumber ?? observation.line_number;
  const role = observation.role;
  return sourcePath !== undefined && lineNumber !== undefined && role
    ? `${sourcePath}\u0000${lineNumber}\u0000${role}`
    : `unkeyed\u0000${index}`;
}

function normalizedPercent(raw) {
  if (raw === null || raw === undefined) return { kind: "null", value: null };
  const value = Number(raw);
  if (Number.isNaN(value)) return { kind: "nan", value: null };
  if (value === Number.POSITIVE_INFINITY) return { kind: "positive-infinity", value: null };
  if (value === Number.NEGATIVE_INFINITY) return { kind: "negative-infinity", value: null };
  return { kind: "number", value };
}

function officialStageRow(observation, index) {
  const limitId = observationValue(observation, "limitId", "limit_id");
  const observedAtMs = Number(observationValue(observation, "observedAtMs", "observed_at_ms"));
  const windowMinutes = Number(observation.windowMinutes ?? observation.window_minutes);
  const resetsAtMs = Number(observationValue(observation, "resetsAtMs", "resets_at_ms"));
  const valid =
    typeof limitId === "string" &&
    Boolean(limitId.trim()) &&
    Number.isFinite(observedAtMs) &&
    Number.isFinite(windowMinutes) &&
    windowMinutes > 0 &&
    Number.isFinite(resetsAtMs);
  const percent = valid
    ? normalizedPercent(observationValue(observation, "usedPercent", "used_percent"))
    : { kind: "invalid", value: null };
  return {
    identity: observationIdentity(observation, index),
    valid,
    limitId: valid ? limitId : null,
    observedAtMs: valid ? observedAtMs : null,
    windowMinutes: valid ? windowMinutes : null,
    resetsAtMs: valid ? resetsAtMs : null,
    usedPercent: percent.value,
    percentKind: percent.kind,
  };
}

function dropTemp(database, table) {
  try {
    database.exec(`DROP TABLE IF EXISTS ${table}`);
  } catch {
    // Preserve the operation error; closing the connection also drops TEMP state.
  }
}

function createObservationSource(database, officialObservations) {
  const officials = tempName("official_observations");
  const view = tempName("observation_view");
  database.exec(`
    CREATE TEMP TABLE ${officials} (
      identity_key TEXT PRIMARY KEY,
      is_valid INTEGER NOT NULL CHECK (is_valid IN (0, 1)),
      limit_id TEXT,
      observed_at_ms REAL,
      window_minutes REAL,
      resets_at_ms REAL,
      used_percent REAL,
      percent_kind TEXT NOT NULL
    ) STRICT;
  `);
  try {
    const insert = database.prepare(`
      INSERT OR IGNORE INTO ${officials} (
        identity_key, is_valid, limit_id, observed_at_ms, window_minutes,
        resets_at_ms, used_percent, percent_kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let index = 0;
    for (const observation of officialObservations ?? []) {
      const row = officialStageRow(observation, index);
      insert.run(
        row.identity,
        row.valid ? 1 : 0,
        row.limitId,
        row.observedAtMs,
        row.windowMinutes,
        row.resetsAtMs,
        row.usedPercent,
        row.percentKind,
      );
      index += 1;
    }
    database.exec(`
      CREATE TEMP VIEW ${view} AS
      SELECT
        source_path || char(0) || CAST(line_number AS TEXT) || char(0) || role AS identity_key,
        CASE
          WHEN typeof(limit_id) = 'text'
            AND trim(limit_id) <> ''
            AND typeof(observed_at_ms) IN ('integer', 'real')
            AND abs(observed_at_ms) <= 1.7976931348623157e308
            AND typeof(window_minutes) IN ('integer', 'real')
            AND abs(window_minutes) <= 1.7976931348623157e308
            AND window_minutes > 0
            AND typeof(resets_at_ms) IN ('integer', 'real')
            AND abs(resets_at_ms) <= 1.7976931348623157e308
          THEN 1 ELSE 0
        END AS is_valid,
        CASE WHEN typeof(limit_id) = 'text' THEN limit_id END AS limit_id,
        observed_at_ms,
        window_minutes,
        resets_at_ms,
        used_percent,
        CASE WHEN used_percent IS NULL THEN 'null' ELSE 'number' END AS percent_kind
      FROM rate_limit_observations
      UNION ALL
      SELECT
        official.identity_key,
        official.is_valid,
        official.limit_id,
        official.observed_at_ms,
        official.window_minutes,
        official.resets_at_ms,
        official.used_percent,
        official.percent_kind
      FROM ${officials} AS official
      WHERE NOT EXISTS (
        SELECT 1
        FROM rate_limit_observations AS persisted
        WHERE persisted.source_path || char(0) || CAST(persisted.line_number AS TEXT) || char(0) || persisted.role
          = official.identity_key
      );
    `);
    return { view, officials };
  } catch (error) {
    dropTemp(database, officials);
    throw error;
  }
}

function dropObservationSource(database, source) {
  if (source.projection) return;
  try {
    database.exec(`DROP VIEW IF EXISTS ${source.view}`);
  } catch {
    // Closing the connection also drops TEMP state.
  }
  dropTemp(database, source.officials);
}

function unavailableQuotaWindow(state, reason) {
  const reasonCode =
    new Map([
      ["存在多个无法区分的 Codex 限额桶。", "multiple-buckets"],
      ["尚未发现 Codex 限额记录。", "no-records"],
      ["同一观察时刻存在相互冲突的限额重置时间。", "conflicting-reset"],
      ["等待新的限额记录", "waiting"],
      ["尚未发现当前限额窗口的 Codex 记录。", "missing-window"],
      ["限额窗口边界无效。", "invalid-boundaries"],
    ]).get(reason) || state;
  return {
    state,
    reason,
    reasonCode,
    windowStart: null,
    windowEndExclusive: null,
    observedAt: null,
    usedPercent: null,
    percentStale: null,
  };
}

function chooseLimit(database, table, aggregated = false) {
  const buckets = aggregated
    ? table
    : `(SELECT limit_id,COUNT(*) AS observation_count,MAX(observed_at_ms) AS latest_observed_at_ms
    FROM ${table} WHERE is_valid=1 GROUP BY limit_id)`;
  const totals = database
    .prepare(`
      SELECT
        COUNT(*) AS bucket_count,
        COALESCE(SUM(observation_count > 1), 0) AS repeated_bucket_count
      FROM ${buckets}
    `)
    .get();
  const bucketCount = Number(totals.bucket_count);
  const repeatedBucketCount = Number(totals.repeated_bucket_count);
  if (bucketCount === 0) {
    return { limitId: null, ignoredBucketCount: 0, ambiguous: false };
  }
  if (bucketCount === 1) {
    const row = database
      .prepare(`
        SELECT limit_id
        FROM ${buckets}
      `)
      .get();
    return { limitId: String(row.limit_id), ignoredBucketCount: 0, ambiguous: false };
  }
  if (repeatedBucketCount === 0) {
    return { limitId: null, ignoredBucketCount: 0, ambiguous: true };
  }
  const candidates = database
    .prepare(`
      SELECT limit_id, observation_count, latest_observed_at_ms
      FROM ${buckets}
      WHERE observation_count > 1
      ORDER BY observation_count DESC, latest_observed_at_ms DESC
      LIMIT 2
    `)
    .all();
  if (
    candidates.length > 1 &&
    Number(candidates[0].observation_count) === Number(candidates[1].observation_count) &&
    Number(candidates[0].latest_observed_at_ms) === Number(candidates[1].latest_observed_at_ms)
  ) {
    return { limitId: null, ignoredBucketCount: 0, ambiguous: true };
  }
  return {
    limitId: String(candidates[0].limit_id),
    ignoredBucketCount: bucketCount - repeatedBucketCount,
    ambiguous: false,
  };
}

function signatureValue(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "number:NaN";
    if (value === Number.POSITIVE_INFINITY) return "number:Infinity";
    if (value === Number.NEGATIVE_INFINITY) return "number:-Infinity";
    return `number:${Object.is(value, -0) ? "0" : String(value)}`;
  }
  return `${typeof value}:${String(value)}`;
}

function updateSignature(hash, value) {
  const text = signatureValue(value);
  hash.update(`${text.length}:${text}\u0000`);
}

function officialSignature(officialObservations) {
  const hash = createHash("sha256");
  updateSignature(hash, CACHE_FORMAT_VERSION);
  let index = 0;
  for (const observation of officialObservations) {
    const row = officialStageRow(observation, index);
    updateSignature(hash, row.identity);
    updateSignature(hash, row.valid);
    updateSignature(hash, row.limitId);
    updateSignature(hash, row.observedAtMs);
    updateSignature(hash, row.windowMinutes);
    updateSignature(hash, row.resetsAtMs);
    updateSignature(hash, row.usedPercent);
    updateSignature(hash, row.percentKind);
    index += 1;
  }
  return hash.digest("hex");
}

function projectedSource(database, officialObservations, asOfMs, revision = null, signature = null) {
  if (!Array.isArray(officialObservations)) return null;
  if (revision === null) {
    if (!database.isTransaction && !ensureUsageQuotaSchema(database)) return null;
    try {
      revision = quotaRevision(database);
    } catch {
      return null;
    }
  }
  if (revision === null) return null;
  signature ??= officialSignature(officialObservations);
  const options = {
    revision,
    signature,
    asOf: asOfMs,
    officialRows: function* () {
      for (let index = 0; index < officialObservations.length; index += 1)
        yield officialStageRow(officialObservations[index], index);
    },
  };
  let projection = readQuotaProjection(database, options);
  if (!projection && Number.isFinite(asOfMs) && !database.isTransaction) {
    try {
      projection = prepareQuotaProjection(database, options);
    } catch (error) {
      if (/readonly|locked|busy/i.test(String(error.message))) return null;
      if (error.code !== "QUOTA_PROJECTION_INVALID") throw error;
      projection = prepareQuotaProjection(database, options);
    }
  }
  return projection ? { view: projection.observations, projection } : null;
}

function quotaRevision(database) {
  const row = database.prepare("SELECT revision FROM quota_revision WHERE singleton = 1").get();
  const revision = Number(row?.revision);
  return Number.isFinite(revision) ? revision : null;
}

function staticSelectionResult(result) {
  return {
    asOf: null,
    limitId: result.limitId,
    ignoredBucketCount: result.ignoredBucketCount,
    windows: Object.fromEntries(
      Object.entries(result.windows).map(([preset, window]) => [preset, { ...window, percentStale: null }]),
    ),
    previousWindows: result.previousWindows,
  };
}

function hydrateCachedResult(result, asOfMs, asOf) {
  const windows = {};
  for (const [preset, window] of Object.entries(result.windows || {})) {
    const observedAtMs = window?.observedAt ? Date.parse(window.observedAt) : Number.NaN;
    windows[preset] =
      window?.state === "available" && Number.isFinite(observedAtMs)
        ? { ...window, percentStale: asOfMs - observedAtMs > PERCENT_STALE_AFTER_MS }
        : { ...window, percentStale: null };
  }
  return {
    asOf,
    limitId: result.limitId,
    ignoredBucketCount: result.ignoredBucketCount,
    windows,
    previousWindows: result.previousWindows,
  };
}

function readCachedSelection(database, revision, signature, asOfMs, asOf) {
  try {
    if (!quotaProjectionCacheUsable(database)) return null;
    const row = database
      .prepare(`
        SELECT format_version, quota_revision, official_signature, valid_from_ms, valid_to_ms, result_json
        FROM usage_quota_window_cache
        WHERE singleton = 1
      `)
      .get();
    if (
      Number(row?.format_version) !== CACHE_FORMAT_VERSION ||
      Number(row?.quota_revision) !== revision ||
      row?.official_signature !== signature ||
      asOfMs < Number(row.valid_from_ms) ||
      asOfMs >= Number(row.valid_to_ms)
    ) {
      return null;
    }
    return hydrateCachedResult(JSON.parse(String(row.result_json)), asOfMs, asOf);
  } catch {
    schemaReady.delete(database);
    return null;
  }
}

function quotaAsOfBounds(database, table, asOfMs) {
  const row = database
    .prepare(`
      WITH boundaries AS (
        SELECT observed_at_ms AS boundary
        FROM ${table}
        WHERE is_valid = 1
        UNION ALL
        SELECT resets_at_ms AS boundary
        FROM ${table}
        WHERE is_valid = 1
        UNION ALL
        SELECT resets_at_ms - window_minutes * ? AS boundary
        FROM ${table}
        WHERE is_valid = 1
      )
      SELECT
        COALESCE(MAX(CASE WHEN boundary <= ? THEN boundary END), ?) AS valid_from_ms,
        COALESCE(MIN(CASE WHEN boundary > ? THEN boundary END), ?) AS valid_to_ms
      FROM boundaries
    `)
    .get(MS_PER_MINUTE, asOfMs, MIN_CACHE_BOUNDARY, asOfMs, MAX_CACHE_BOUNDARY);
  return {
    validFromMs: Number(row.valid_from_ms),
    validToMs: Number(row.valid_to_ms),
  };
}

function writeCachedSelection(database, table, revision, signature, asOfMs, result, projection = null) {
  try {
    const bounds = projection ? quotaProjectionBounds(database, asOfMs) : quotaAsOfBounds(database, table, asOfMs);
    if (
      !Number.isFinite(bounds.validFromMs) ||
      !Number.isFinite(bounds.validToMs) ||
      bounds.validFromMs >= bounds.validToMs
    ) {
      return false;
    }
    const existing = database.prepare("SELECT valid_from_ms FROM usage_quota_window_cache WHERE singleton = 1").get();
    if (existing && asOfMs < Number(existing.valid_from_ms)) return false;
    database
      .prepare(`
        INSERT INTO usage_quota_window_cache (
          singleton, format_version, quota_revision, official_signature,
          valid_from_ms, valid_to_ms, result_json
        ) VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          format_version = excluded.format_version,
          quota_revision = excluded.quota_revision,
          official_signature = excluded.official_signature,
          valid_from_ms = excluded.valid_from_ms,
          valid_to_ms = excluded.valid_to_ms,
          result_json = excluded.result_json
      `)
      .run(
        CACHE_FORMAT_VERSION,
        revision,
        signature,
        bounds.validFromMs,
        bounds.validToMs,
        JSON.stringify(staticSelectionResult(result)),
      );
    return true;
  } catch {
    schemaReady.delete(database);
    return false;
  }
}

function currentStoredWindow(database, table, limitId, asOfMs, minutes) {
  const row = database
    .prepare(`
      WITH candidates AS (
        SELECT observed_at_ms, resets_at_ms, used_percent, percent_kind
        FROM ${table}
        WHERE is_valid = 1
          AND limit_id = ?
          AND window_minutes = ?
          AND observed_at_ms <= ?
          AND resets_at_ms - window_minutes * ? <= ?
          AND resets_at_ms <= ?
          AND ? < resets_at_ms
      ),
      latest AS (
        SELECT MAX(observed_at_ms) AS observed_at_ms
        FROM candidates
      )
      SELECT
        COUNT(candidates.observed_at_ms) AS row_count,
        COUNT(DISTINCT candidates.resets_at_ms) AS endpoint_count,
        COUNT(DISTINCT CASE WHEN candidates.percent_kind = 'number' THEN candidates.used_percent END)
          AS percent_number_count,
        COUNT(DISTINCT CASE WHEN candidates.percent_kind <> 'number' THEN candidates.percent_kind END)
          AS percent_other_count,
        MAX(candidates.used_percent) AS used_percent,
        MAX(candidates.resets_at_ms) AS window_end_ms,
        latest.observed_at_ms
      FROM latest
      LEFT JOIN candidates ON candidates.observed_at_ms = latest.observed_at_ms
    `)
    // The 2 ms halo preserves subtraction rounding at Date's largest valid magnitudes.
    .get(limitId, minutes, asOfMs, MS_PER_MINUTE, asOfMs, Math.ceil(asOfMs) + minutes * MS_PER_MINUTE + 2, asOfMs);
  if (!Number(row.row_count)) {
    const expired = database
      .prepare(`
        SELECT 1 AS found
        FROM ${table}
        WHERE is_valid = 1
          AND limit_id = ?
          AND window_minutes = ?
          AND observed_at_ms <= ?
          AND resets_at_ms <= ?
        LIMIT 1
      `)
      .get(limitId, minutes, asOfMs, asOfMs);
    return expired
      ? unavailableQuotaWindow("waiting", "等待新的限额记录")
      : unavailableQuotaWindow("missing", "尚未发现当前限额窗口的 Codex 记录。");
  }
  if (Number(row.endpoint_count) > 1) {
    return unavailableQuotaWindow("ambiguous", "同一观察时刻存在相互冲突的限额重置时间。");
  }
  const windowEndMs = Number(row.window_end_ms);
  const observedAtMs = Number(row.observed_at_ms);
  const percent =
    Number(row.percent_number_count) === 1 && Number(row.percent_other_count) === 0 && row.used_percent !== null
      ? Number(row.used_percent)
      : null;
  if (!Number.isFinite(windowEndMs) || !Number.isFinite(observedAtMs)) {
    return unavailableQuotaWindow("ambiguous", "限额窗口边界无效。");
  }
  return {
    state: "available",
    reason: null,
    windowStart: new Date(windowEndMs - minutes * MS_PER_MINUTE).toISOString(),
    windowEndExclusive: new Date(windowEndMs).toISOString(),
    observedAt: new Date(observedAtMs).toISOString(),
    usedPercent: Number.isFinite(percent) ? percent : null,
    percentStale: asOfMs - observedAtMs > PERCENT_STALE_AFTER_MS,
  };
}

function createCycleTable(database, table, limitId, asOfMs, minutes) {
  const asOfNumber = Number(asOfMs);
  const unboundedAsOf = Number.isNaN(asOfNumber) || asOfNumber === Number.POSITIVE_INFINITY;
  const durationMs = minutes * MS_PER_MINUTE;
  const timeClause = unboundedAsOf ? "" : "AND observed_at_ms <= ?";
  const endpointParams = unboundedAsOf
    ? [limitId, minutes, durationMs, ENDPOINT_TOLERANCE_MS]
    : [limitId, minutes, asOfNumber, durationMs, ENDPOINT_TOLERANCE_MS];
  const anchors = tempName("endpoint_anchors");
  const cycles = tempName("cycles");
  database.exec(`
    CREATE TEMP TABLE ${anchors} (
      ordinal INTEGER PRIMARY KEY,
      cluster_id INTEGER NOT NULL,
      planned_reset REAL NOT NULL,
      support_count INTEGER NOT NULL,
      first_observed REAL NOT NULL
    ) STRICT;
    CREATE TEMP TABLE ${cycles} (
      ordinal INTEGER PRIMARY KEY,
      cluster_id INTEGER NOT NULL,
      window_start REAL NOT NULL,
      planned_reset REAL NOT NULL,
      first_observed REAL NOT NULL
    ) STRICT;
  `);
  try {
    const anchorInsert = database.prepare(`
      INSERT INTO ${anchors} (ordinal, cluster_id, planned_reset, support_count, first_observed)
      VALUES (?, ?, ?, ?, ?)
    `);
    const supportRows = database
      .prepare(`
        WITH
        unique_endpoints AS (
          SELECT DISTINCT observed_at_ms, resets_at_ms
          FROM ${table}
          WHERE is_valid = 1
            AND limit_id = ?
            AND window_minutes = ?
            ${timeClause}
            AND observed_at_ms >= resets_at_ms - ? - ?
            AND observed_at_ms < resets_at_ms
        )
        SELECT resets_at_ms AS planned_reset, COUNT(*) AS support_count, MIN(observed_at_ms) AS first_observed
        FROM unique_endpoints
        GROUP BY resets_at_ms
        ORDER BY resets_at_ms
      `)
      .iterate(...endpointParams);
    let anchor = null;
    let clusterId = -1;
    let ordinal = 0;
    for (const support of supportRows) {
      const plannedReset = Number(support.planned_reset);
      if (anchor === null || plannedReset - anchor > ENDPOINT_TOLERANCE_MS) {
        clusterId += 1;
        anchor = plannedReset;
      }
      anchorInsert.run(ordinal, clusterId, plannedReset, Number(support.support_count), Number(support.first_observed));
      ordinal += 1;
    }
    database
      .prepare(`
        INSERT INTO ${cycles} (ordinal, cluster_id, window_start, planned_reset, first_observed)
        WITH
        ranked AS (
          SELECT
            planned_reset,
            first_observed,
            cluster_id,
            MIN(first_observed) OVER (PARTITION BY cluster_id) AS cluster_first_observed,
            ROW_NUMBER() OVER (
              PARTITION BY cluster_id
              ORDER BY support_count DESC, planned_reset DESC
            ) AS position
          FROM ${anchors}
        ),
        selected AS (
          SELECT
            cluster_id,
            planned_reset - ? AS window_start,
            planned_reset,
          cluster_first_observed AS first_observed
          FROM ranked
          WHERE position = 1
        )
        SELECT
          ROW_NUMBER() OVER (ORDER BY planned_reset) - 1,
          cluster_id,
          window_start,
          planned_reset,
          first_observed
        FROM selected
        ORDER BY planned_reset
      `)
      .run(durationMs);
    dropTemp(database, anchors);
    const endpointConflict = database
      .prepare(`
        SELECT 1 AS found
        FROM (
          SELECT observed_at_ms
          FROM ${table}
          WHERE is_valid = 1
            AND limit_id = ?
            AND window_minutes = ?
            ${timeClause}
            AND observed_at_ms >= resets_at_ms - ? - ?
            AND observed_at_ms < resets_at_ms
          GROUP BY observed_at_ms
          HAVING MAX(resets_at_ms) - MIN(resets_at_ms) > ?
          LIMIT 1
        )
      `)
      .get(...endpointParams, ENDPOINT_TOLERANCE_MS);
    const orderConflict = database
      .prepare(`
        SELECT 1 AS found
        FROM (
          SELECT
            window_start,
            first_observed,
            LAG(first_observed) OVER (ORDER BY planned_reset) AS previous_first
          FROM ${cycles}
        )
        WHERE previous_first >= window_start
        LIMIT 1
      `)
      .get();
    if (endpointConflict || orderConflict) {
      dropTemp(database, cycles);
      return null;
    }
    return cycles;
  } catch (error) {
    dropTemp(database, anchors);
    dropTemp(database, cycles);
    throw error;
  }
}

function cycleSource(database, source, limitId, asOfMs, minutes) {
  const projection = source.projection;
  if (projection) {
    if (
      database
        .prepare(`SELECT 1 FROM ${projection.conflicts} WHERE limit_id=? AND window_minutes=? LIMIT 1`)
        .get(limitId, minutes) ||
      database
        .prepare(
          `SELECT 1 FROM ${projection.cycles} WHERE limit_id=? AND window_minutes=? AND order_conflict=1 LIMIT 1`,
        )
        .get(limitId, minutes)
    )
      return null;
    return {
      sql: `(SELECT window_start,planned_reset,first_observed FROM ${projection.cycles} WHERE limit_id=? AND window_minutes=?)`,
      params: [limitId, minutes],
      table: null,
    };
  }
  const table = createCycleTable(database, source.view, limitId, asOfMs, minutes);
  return table === null ? null : { sql: table, params: [], table };
}

function* completedWindowIterable(database, source, cycles, asOfMs) {
  try {
    const asOfNumber = Number(asOfMs);
    const unboundedAsOf = Number.isNaN(asOfNumber) || asOfNumber === Number.POSITIVE_INFINITY;
    const completedWhere = unboundedAsOf ? "" : "WHERE ? >= window_end_exclusive";
    const rows = database
      .prepare(`
        SELECT window_start, planned_reset, window_end_exclusive, first_observed
        FROM (
          SELECT
            window_start,
            planned_reset,
            first_observed,
            MIN(
              planned_reset,
              COALESCE(
                LEAD(window_start) OVER (ORDER BY planned_reset),
                planned_reset
              )
            ) AS window_end_exclusive
          FROM ${cycles.sql}
        )
        ${completedWhere}
        ORDER BY planned_reset
      `)
      .iterate(...cycles.params, ...(unboundedAsOf ? [] : [asOfNumber]));
    for (const row of rows) {
      yield {
        state: "available",
        reason: null,
        windowStart: new Date(Number(row.window_start)).toISOString(),
        windowEndExclusive: new Date(Number(row.window_end_exclusive)).toISOString(),
        plannedResetAt: new Date(Number(row.planned_reset)).toISOString(),
        observedAt: new Date(Number(row.first_observed)).toISOString(),
        durationMinutes: (Number(row.window_end_exclusive) - Number(row.window_start)) / MS_PER_MINUTE,
      };
    }
  } finally {
    if (cycles.table) dropTemp(database, cycles.table);
    dropObservationSource(database, source);
  }
}

/**
 * Return completed quota windows as an iterable, or `null` when boundary
 * conflicts are detected. Conflict checks finish before this function returns.
 *
 * @param {any} database
 * @param {string} limitId
 * @param {number} asOfMs
 * @param {number} minutes
 * @param {Iterable<any>} [officialObservations]
 * @returns {Iterable<object> | null}
 */
export function iterateStoredQuotaWindows(database, limitId, asOfMs, minutes, officialObservations = []) {
  let source = null;
  try {
    source =
      projectedSource(database, officialObservations, asOfMs) ??
      createObservationSource(database, officialObservations);
    if (typeof limitId !== "string" || typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) {
      dropObservationSource(database, source);
      return [][Symbol.iterator]();
    }
    const cycles = cycleSource(database, source, limitId, asOfMs, minutes);
    if (cycles === null) {
      dropObservationSource(database, source);
      return null;
    }
    return completedWindowIterable(database, source, cycles, asOfMs);
  } catch (error) {
    if (source) dropObservationSource(database, source);
    throw error;
  }
}

function lastCompletedWindow(database, source, limitId, asOfMs, minutes) {
  const cycles = cycleSource(database, source, limitId, asOfMs, minutes);
  if (cycles === null) return null;
  let last;
  try {
    const asOfNumber = Number(asOfMs);
    const unboundedAsOf = Number.isNaN(asOfNumber) || asOfNumber === Number.POSITIVE_INFINITY;
    const completedWhere = unboundedAsOf ? "" : "WHERE ? >= window_end_exclusive";
    const row = source.projection
      ? database
          .prepare(`SELECT window_start,planned_reset,first_observed,
      MIN(planned_reset,COALESCE((SELECT next.window_start FROM ${source.projection.cycles} AS next
        WHERE next.limit_id=current.limit_id AND next.window_minutes=current.window_minutes AND next.planned_reset>current.planned_reset
        ORDER BY next.planned_reset LIMIT 1),planned_reset)) window_end_exclusive
      FROM ${source.projection.cycles} AS current WHERE limit_id=? AND window_minutes=?
        AND ? >= MIN(planned_reset,COALESCE((SELECT next.window_start FROM ${source.projection.cycles} AS next
          WHERE next.limit_id=current.limit_id AND next.window_minutes=current.window_minutes AND next.planned_reset>current.planned_reset
          ORDER BY next.planned_reset LIMIT 1),planned_reset))
      ORDER BY planned_reset DESC LIMIT 1`)
          .get(limitId, minutes, asOfNumber)
      : database
          .prepare(`
        SELECT window_start, planned_reset, window_end_exclusive, first_observed
        FROM (
          SELECT
            window_start,
            planned_reset,
            first_observed,
            MIN(
              planned_reset,
              COALESCE(
                LEAD(window_start) OVER (ORDER BY planned_reset),
                planned_reset
              )
            ) AS window_end_exclusive
          FROM ${cycles.sql}
        )
        ${completedWhere}
        ORDER BY planned_reset DESC
        LIMIT 1
      `)
          .get(...cycles.params, ...(unboundedAsOf ? [] : [asOfNumber]));
    if (row) {
      last = {
        state: "available",
        reason: null,
        windowStart: new Date(Number(row.window_start)).toISOString(),
        windowEndExclusive: new Date(Number(row.window_end_exclusive)).toISOString(),
        plannedResetAt: new Date(Number(row.planned_reset)).toISOString(),
        observedAt: new Date(Number(row.first_observed)).toISOString(),
        durationMinutes: (Number(row.window_end_exclusive) - Number(row.window_start)) / MS_PER_MINUTE,
      };
    }
  } finally {
    if (cycles.table) dropTemp(database, cycles.table);
  }
  return last;
}

/**
 * Select current and previous quota windows without materializing observations in JS.
 *
 * @param {any} database
 * @param {Date | number | string} [asOfValue]
 * @param {Iterable<any>} [officialObservations]
 */
export function selectStoredQuotaWindows(database, asOfValue = new Date(), officialObservations = []) {
  const work = resetQuotaProjectionWork(database);
  const asOfMs =
    asOfValue instanceof Date ? asOfValue.getTime() : typeof asOfValue === "number" ? asOfValue : Date.parse(asOfValue);
  if (!Number.isFinite(asOfMs)) throw new RangeError("asOf must be a valid date.");
  const asOf = new Date(asOfMs).toISOString();
  let revision = null;
  let signature = null;
  const schemaAvailable =
    schemaReady.get(database) === true || (!database.isTransaction && ensureUsageQuotaSchema(database));
  if (Array.isArray(officialObservations) && schemaAvailable) {
    try {
      revision = quotaRevision(database);
      if (revision !== null) {
        signature = officialSignature(officialObservations);
        const cached = readCachedSelection(database, revision, signature, asOfMs, asOf);
        if (cached) {
          work.reused = true;
          return cached;
        }
      }
    } catch {
      schemaReady.delete(database);
      revision = null;
      signature = null;
    }
  }
  const source =
    projectedSource(database, officialObservations, asOfMs, revision, signature) ??
    createObservationSource(database, officialObservations);
  if (!source.projection) work.fallback = true;
  try {
    const bucket = chooseLimit(database, source.projection?.buckets ?? source.view, Boolean(source.projection));
    const windows = {};
    for (const [preset, minutes] of Object.entries(QUOTA_WINDOW_MINUTES)) {
      windows[preset] = bucket.ambiguous
        ? unavailableQuotaWindow("ambiguous", "存在多个无法区分的 Codex 限额桶。")
        : bucket.limitId
          ? currentStoredWindow(database, source.view, bucket.limitId, asOfMs, minutes)
          : unavailableQuotaWindow("missing", "尚未发现 Codex 限额记录。");
    }
    const previousWindows = {};
    for (const [preset, minutes] of Object.entries(QUOTA_WINDOW_MINUTES)) {
      if (bucket.ambiguous) {
        previousWindows[preset] = unavailableQuotaWindow(
          "ambiguous",
          preset === "quota_week"
            ? "上一周限额记录存在冲突，无法确认周期边界。"
            : "同一观察时刻存在相互冲突的限额重置时间。",
        );
      } else if (!bucket.limitId) {
        previousWindows[preset] = unavailableQuotaWindow("missing", "尚未发现上一限额窗口的 Codex 记录。");
      } else {
        const completed = lastCompletedWindow(database, source, bucket.limitId, asOfMs, minutes);
        previousWindows[preset] =
          completed === null
            ? unavailableQuotaWindow(
                "ambiguous",
                preset === "quota_week"
                  ? "上一周限额记录存在冲突，无法确认周期边界。"
                  : "同一观察时刻存在相互冲突的限额重置时间。",
              )
            : completed || unavailableQuotaWindow("missing", "尚未发现上一限额窗口的 Codex 记录。");
      }
    }
    const result = {
      asOf,
      limitId: bucket.limitId,
      ignoredBucketCount: bucket.ignoredBucketCount,
      windows,
      previousWindows,
    };
    if (revision !== null && signature !== null && !database.isTransaction) {
      writeCachedSelection(database, source.view, revision, signature, asOfMs, result, source.projection);
    }
    return result;
  } finally {
    dropObservationSource(database, source);
  }
}
