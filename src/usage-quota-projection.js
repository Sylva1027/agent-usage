const MINUTE = 60_000;
const TOLERANCE = 2 * MINUTE;
const VERSION = 1;
const BATCH = 1024;
const QUEUE_LIMIT = 4096;
const PREFIX = "usage_quota_projection_";
const FORMAT = `${PREFIX}format`;
const STATE = `${PREFIX}state`;
const QUEUE = `${PREFIX}changes`;
const POINTS = `${PREFIX}points`;
const BUCKETS = `${PREFIX}buckets`;
const BOUNDS = `${PREFIX}boundaries`;
const TIMES = `${PREFIX}times`;
const ENDPOINTS = `${PREFIX}endpoints`;
const CYCLES = `${PREFIX}cycles`;
const CONFLICTS = `${PREFIX}conflicts`;
const OFFICIALS = `${PREFIX}officials`;
const DIRTY = `${PREFIX}dirty_endpoints`;
const VIEW = `${PREFIX}observations`;

export const USAGE_QUOTA_PROJECTION_TABLE_NAMES = Object.freeze([
  FORMAT,
  STATE,
  QUEUE,
  POINTS,
  BUCKETS,
  BOUNDS,
  TIMES,
  ENDPOINTS,
  CYCLES,
  CONFLICTS,
  OFFICIALS,
  DIRTY,
]);
const workByDatabase = new WeakMap();
export const quotaProjectionWork = (database) => workByDatabase.get(database) ?? null;
export function resetQuotaProjectionWork(database, reused = false) {
  const work = { rebuilt: false, reused, changes: 0, promotedTimes: 0, endpoints: 0, cycles: 0 };
  workByDatabase.set(database, work);
  return work;
}

function valid(row) {
  return `typeof(${row}.limit_id)='text' AND trim(${row}.limit_id)<>''
    AND typeof(${row}.observed_at_ms) IN ('integer','real') AND abs(${row}.observed_at_ms)<=1.7976931348623157e308
    AND typeof(${row}.window_minutes) IN ('integer','real') AND abs(${row}.window_minutes)<=1.7976931348623157e308
    AND ${row}.window_minutes>0 AND typeof(${row}.resets_at_ms) IN ('integer','real')
    AND abs(${row}.resets_at_ms)<=1.7976931348623157e308`;
}
function change(row, delta, from = "", where = "1") {
  return `INSERT INTO ${QUEUE}(delta,source_path,line_number,role,is_valid,limit_id,window_minutes,
      observed_at_ms,resets_at_ms,percent_kind,percent_value)
    SELECT ${delta},${row}.source_path,${row}.line_number,${row}.role,CASE WHEN ${valid(row)} THEN 1 ELSE 0 END,
      ${row}.limit_id,${row}.window_minutes,${row}.observed_at_ms,${row}.resets_at_ms,
      CASE WHEN ${row}.used_percent IS NULL THEN 'null' ELSE 'number' END,COALESCE(${row}.used_percent,0)
    ${from} WHERE (${where}) AND EXISTS(SELECT 1 FROM ${STATE} WHERE singleton=1 AND rebuild=0);`;
}
const invalidateRecursive = `UPDATE ${STATE} SET rebuild=1
  WHERE singleton=1 AND ((SELECT recursive_triggers FROM pragma_recursive_triggers)<>0
    OR EXISTS(SELECT 1 FROM pragma_index_list('rate_limit_observations') WHERE "unique"=1 AND origin<>'pk'));`;
const definitions = [
  [
    FORMAT,
    "table",
    `CREATE TABLE ${FORMAT}(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,schema_version INTEGER NOT NULL,quota_schema TEXT NOT NULL) STRICT`,
  ],
  [
    STATE,
    "table",
    `CREATE TABLE ${STATE}(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,
    official_signature TEXT NOT NULL,as_of_ms REAL NOT NULL,rebuild INTEGER NOT NULL,queued INTEGER NOT NULL) STRICT`,
  ],
  [
    QUEUE,
    "table",
    `CREATE TABLE ${QUEUE}(id INTEGER PRIMARY KEY,delta INTEGER NOT NULL,source_path TEXT NOT NULL,
    line_number INTEGER NOT NULL,role TEXT NOT NULL,is_valid INTEGER NOT NULL,limit_id TEXT,window_minutes REAL,
    observed_at_ms REAL,resets_at_ms REAL,percent_kind TEXT NOT NULL,percent_value REAL NOT NULL) STRICT`,
  ],
  [
    POINTS,
    "table",
    `CREATE TABLE ${POINTS}(limit_id TEXT NOT NULL,window_minutes REAL NOT NULL,observed_at_ms REAL NOT NULL,
    resets_at_ms REAL NOT NULL,percent_kind TEXT NOT NULL,percent_value REAL NOT NULL,refs INTEGER NOT NULL,
    PRIMARY KEY(limit_id,window_minutes,observed_at_ms,resets_at_ms,percent_kind,percent_value)) WITHOUT ROWID`,
  ],
  [
    BUCKETS,
    "table",
    `CREATE TABLE ${BUCKETS}(limit_id TEXT PRIMARY KEY,observation_count INTEGER NOT NULL,
    latest_observed_at_ms REAL NOT NULL) WITHOUT ROWID`,
  ],
  [BOUNDS, "table", `CREATE TABLE ${BOUNDS}(boundary REAL PRIMARY KEY,refs INTEGER NOT NULL) WITHOUT ROWID`],
  [
    TIMES,
    "table",
    `CREATE TABLE ${TIMES}(limit_id TEXT NOT NULL,window_minutes REAL NOT NULL,resets_at_ms REAL NOT NULL,
    observed_at_ms REAL NOT NULL,refs INTEGER NOT NULL,
    PRIMARY KEY(limit_id,window_minutes,resets_at_ms,observed_at_ms)) WITHOUT ROWID`,
  ],
  [
    ENDPOINTS,
    "table",
    `CREATE TABLE ${ENDPOINTS}(limit_id TEXT NOT NULL,window_minutes REAL NOT NULL,resets_at_ms REAL NOT NULL,
    support_count INTEGER NOT NULL,first_observed REAL NOT NULL,anchor_ms REAL,
    PRIMARY KEY(limit_id,window_minutes,resets_at_ms)) WITHOUT ROWID`,
  ],
  [
    CYCLES,
    "table",
    `CREATE TABLE ${CYCLES}(limit_id TEXT NOT NULL,window_minutes REAL NOT NULL,anchor_ms REAL NOT NULL,
    window_start REAL NOT NULL,planned_reset REAL NOT NULL,first_observed REAL NOT NULL,order_conflict INTEGER NOT NULL,
    PRIMARY KEY(limit_id,window_minutes,anchor_ms)) WITHOUT ROWID`,
  ],
  [
    CONFLICTS,
    "table",
    `CREATE TABLE ${CONFLICTS}(limit_id TEXT NOT NULL,window_minutes REAL NOT NULL,observed_at_ms REAL NOT NULL,
    PRIMARY KEY(limit_id,window_minutes,observed_at_ms)) WITHOUT ROWID`,
  ],
  [
    OFFICIALS,
    "table",
    `CREATE TABLE ${OFFICIALS}(identity_key TEXT PRIMARY KEY,source_path TEXT,line_number INTEGER,role TEXT,
    is_valid INTEGER NOT NULL,limit_id TEXT,window_minutes REAL,observed_at_ms REAL,resets_at_ms REAL,
    percent_kind TEXT NOT NULL,percent_value REAL NOT NULL,active INTEGER NOT NULL) WITHOUT ROWID`,
  ],
  [
    DIRTY,
    "table",
    `CREATE TABLE ${DIRTY}(limit_id TEXT NOT NULL,window_minutes REAL NOT NULL,resets_at_ms REAL NOT NULL,
    PRIMARY KEY(limit_id,window_minutes)) WITHOUT ROWID`,
  ],
  [
    `${PREFIX}point_time_idx`,
    "index",
    `CREATE INDEX ${PREFIX}point_time_idx ON ${POINTS}(limit_id,observed_at_ms DESC)`,
  ],
  [
    `${PREFIX}point_reset_idx`,
    "index",
    `CREATE INDEX ${PREFIX}point_reset_idx ON ${POINTS}(limit_id,window_minutes,resets_at_ms,observed_at_ms)`,
  ],
  [
    `${PREFIX}time_observed_idx`,
    "index",
    `CREATE INDEX ${PREFIX}time_observed_idx ON ${TIMES}(observed_at_ms,limit_id,window_minutes,resets_at_ms)`,
  ],
  [
    `${PREFIX}time_conflict_idx`,
    "index",
    `CREATE INDEX ${PREFIX}time_conflict_idx ON ${TIMES}(limit_id,window_minutes,observed_at_ms,resets_at_ms)`,
  ],
  [
    `${PREFIX}endpoint_anchor_idx`,
    "index",
    `CREATE INDEX ${PREFIX}endpoint_anchor_idx ON ${ENDPOINTS}(limit_id,window_minutes,anchor_ms,resets_at_ms)`,
  ],
  [
    `${PREFIX}cycle_reset_idx`,
    "index",
    `CREATE INDEX ${PREFIX}cycle_reset_idx ON ${CYCLES}(limit_id,window_minutes,planned_reset)`,
  ],
  [
    `${PREFIX}official_identity_idx`,
    "index",
    `CREATE INDEX ${PREFIX}official_identity_idx ON ${OFFICIALS}(source_path,line_number,role)`,
  ],
  [
    `${PREFIX}cycle_conflict_idx`,
    "index",
    `CREATE INDEX ${PREFIX}cycle_conflict_idx ON ${CYCLES}(limit_id,window_minutes) WHERE order_conflict=1`,
  ],
  [
    VIEW,
    "view",
    `CREATE VIEW ${VIEW} AS SELECT 1 AS is_valid,limit_id,window_minutes,observed_at_ms,resets_at_ms,
    CASE WHEN percent_kind='number' THEN percent_value END AS used_percent,percent_kind
    FROM ${POINTS} INDEXED BY ${PREFIX}point_reset_idx`,
  ],
  [
    `${PREFIX}queue_limit`,
    "trigger",
    `CREATE TRIGGER ${PREFIX}queue_limit AFTER INSERT ON ${QUEUE} BEGIN
    UPDATE ${STATE} SET queued=queued+1,rebuild=CASE WHEN queued+1>=${QUEUE_LIMIT} THEN 1 ELSE rebuild END WHERE singleton=1; END`,
  ],
  [
    `${PREFIX}insert`,
    "trigger",
    `CREATE TRIGGER ${PREFIX}insert AFTER INSERT ON rate_limit_observations
    WHEN EXISTS(SELECT 1 FROM ${STATE}) BEGIN ${invalidateRecursive}${change("NEW", 1)} END`,
  ],
  [
    `${PREFIX}replace`,
    "trigger",
    `CREATE TRIGGER ${PREFIX}replace BEFORE INSERT ON rate_limit_observations
    WHEN EXISTS(SELECT 1 FROM ${STATE}) BEGIN ${invalidateRecursive}
      UPDATE ${STATE} SET rebuild=1 WHERE NEW.rowid=-1 AND EXISTS(SELECT 1 FROM rate_limit_observations WHERE rowid=-1);
      ${change(
        "previous",
        -1,
        "FROM rate_limit_observations AS previous",
        `(previous.source_path=NEW.source_path AND previous.line_number=NEW.line_number AND previous.role=NEW.role)
        OR (NEW.rowid<>-1 AND previous.rowid=NEW.rowid)`,
      )} END`,
  ],
  [
    `${PREFIX}update`,
    "trigger",
    `CREATE TRIGGER ${PREFIX}update AFTER UPDATE ON rate_limit_observations
    WHEN EXISTS(SELECT 1 FROM ${STATE}) BEGIN ${invalidateRecursive}${change("OLD", -1)}${change("NEW", 1)} END`,
  ],
  [
    `${PREFIX}delete`,
    "trigger",
    `CREATE TRIGGER ${PREFIX}delete AFTER DELETE ON rate_limit_observations
    WHEN EXISTS(SELECT 1 FROM ${STATE}) BEGIN ${invalidateRecursive}${change("OLD", -1)} END`,
  ],
];
const normalize = (sql) =>
  String(sql ?? "")
    .replace(/\s+/g, " ")
    .replace(/;+\s*$/, "")
    .trim()
    .toLowerCase();
function currentSchema(database) {
  return Number(database.prepare("PRAGMA schema_version").get().schema_version);
}
function quotaSchema(database) {
  return JSON.stringify(
    database
      .prepare(`SELECT type,name,sql FROM sqlite_master
    WHERE tbl_name='rate_limit_observations' ORDER BY type,name`)
      .all()
      // Only the canonical history revision counters leave quota semantics unchanged.
      .filter(
        ({ type, name, sql }) =>
          type !== "trigger" ||
          !["INSERT", "UPDATE", "DELETE"].some(
            (operation) =>
              name === `usage_history_input_rate_limit_observations_${operation}` &&
              normalize(sql) ===
                normalize(`CREATE TRIGGER ${name} AFTER ${operation} ON rate_limit_observations
                  BEGIN UPDATE usage_history_projection_inputs SET aux_revision=aux_revision+1 WHERE singleton=1; END`),
          ),
      ),
  );
}
function schemaMatches(database) {
  const actual = new Map(
    database
      .prepare(`SELECT name,type,sql FROM sqlite_master WHERE name LIKE '${PREFIX}%'`)
      .all()
      .map((row) => [String(row.name), row]),
  );
  return definitions.every(
    ([name, type, sql]) => actual.get(name)?.type === type && normalize(actual.get(name)?.sql) === normalize(sql),
  );
}
function schemaReady(database) {
  try {
    const format = database.prepare(`SELECT * FROM ${FORMAT} WHERE singleton=1`).get();
    return (
      Number(format?.version) === VERSION &&
      schemaMatches(database) &&
      (Number(format?.schema_version) === currentSchema(database) || format?.quota_schema === quotaSchema(database))
    );
  } catch {
    return false;
  }
}
export function ensureQuotaProjectionSchema(database) {
  if (schemaReady(database)) return true;
  if (database.isTransaction) return false;
  database.exec("SAVEPOINT quota_projection_schema");
  try {
    if (!schemaMatches(database)) {
      for (const [name, type] of definitions.toReversed())
        database.exec(`DROP ${type.toUpperCase()} IF EXISTS ${name}`);
      for (const [, , sql] of definitions) database.exec(sql);
    } else database.exec(`DELETE FROM ${STATE}; DELETE FROM ${QUEUE}`);
    database
      .prepare(`INSERT OR REPLACE INTO ${FORMAT} VALUES(1,?,?,?)`)
      .run(VERSION, currentSchema(database), quotaSchema(database));
    database.exec("DELETE FROM usage_quota_window_cache; RELEASE quota_projection_schema");
    return true;
  } catch (error) {
    database.exec("ROLLBACK TO quota_projection_schema; RELEASE quota_projection_schema");
    throw error;
  }
}
export function quotaProjectionCacheUsable(database) {
  try {
    if (!schemaReady(database)) return false;
    const state = database.prepare(`SELECT rebuild,queued FROM ${STATE} WHERE singleton=1`).get();
    return !state || (!Number(state.rebuild) && !Number(state.queued));
  } catch {
    return false;
  }
}
function eligible(database) {
  return (
    Number(database.prepare("PRAGMA recursive_triggers").get().recursive_triggers) === 0 &&
    !database
      .prepare("PRAGMA index_list(rate_limit_observations)")
      .all()
      .some((row) => Number(row.unique) !== 0 && row.origin !== "pk")
  );
}
function point(row) {
  return [row.limit_id, row.window_minutes, row.observed_at_ms, row.resets_at_ms, row.percent_kind, row.percent_value];
}
function dirtyEndpoint(dirty, limit, minutes, reset) {
  dirty
    .prepare(`INSERT INTO ${DIRTY} VALUES(?,?,?) ON CONFLICT(limit_id,window_minutes)
    DO UPDATE SET resets_at_ms=MIN(resets_at_ms,excluded.resets_at_ms)`)
    .run(limit, minutes, reset);
}
function updateConflict(database, limit, minutes, observed, asOf) {
  if (observed > asOf) return;
  const values = database
    .prepare(`SELECT MIN(resets_at_ms) minimum,MAX(resets_at_ms) maximum FROM ${TIMES}
    WHERE limit_id=? AND window_minutes=? AND observed_at_ms=?`)
    .get(limit, minutes, observed);
  if (values.minimum !== null && Number(values.maximum) - Number(values.minimum) > TOLERANCE)
    database.prepare(`INSERT OR IGNORE INTO ${CONFLICTS} VALUES(?,?,?)`).run(limit, minutes, observed);
  else
    database
      .prepare(`DELETE FROM ${CONFLICTS} WHERE limit_id=? AND window_minutes=? AND observed_at_ms=?`)
      .run(limit, minutes, observed);
}
function updateVisibleTime(database, limit, minutes, observed, reset, delta, asOf, dirty) {
  if (observed > asOf) return;
  if (delta > 0)
    database
      .prepare(`INSERT INTO ${ENDPOINTS} VALUES(?,?,?,1,?,NULL)
    ON CONFLICT(limit_id,window_minutes,resets_at_ms) DO UPDATE SET support_count=support_count+1,
      first_observed=MIN(first_observed,excluded.first_observed)`)
      .run(limit, minutes, reset, observed);
  else {
    database
      .prepare(
        `UPDATE ${ENDPOINTS} SET support_count=support_count-1 WHERE limit_id=? AND window_minutes=? AND resets_at_ms=?`,
      )
      .run(limit, minutes, reset);
    database
      .prepare(`DELETE FROM ${ENDPOINTS} WHERE limit_id=? AND window_minutes=? AND resets_at_ms=? AND support_count=0`)
      .run(limit, minutes, reset);
    database
      .prepare(`UPDATE ${ENDPOINTS} SET first_observed=(SELECT MIN(observed_at_ms) FROM ${TIMES}
      WHERE limit_id=? AND window_minutes=? AND resets_at_ms=? AND observed_at_ms<=?)
      WHERE limit_id=? AND window_minutes=? AND resets_at_ms=? AND first_observed=?`)
      .run(limit, minutes, reset, asOf, limit, minutes, reset, observed);
  }
  dirtyEndpoint(dirty, limit, minutes, reset);
  updateConflict(database, limit, minutes, observed, asOf);
}
function pointDelta(database, row, delta, asOf, dirty) {
  if (!Number(row.is_valid)) return;
  const values = point(row);
  const prior = database
    .prepare(`SELECT refs FROM ${POINTS} WHERE limit_id=? AND window_minutes=? AND observed_at_ms=?
    AND resets_at_ms=? AND percent_kind=? AND percent_value=?`)
    .get(...values);
  const refs = Number(prior?.refs ?? 0) + delta;
  if (refs < 0)
    throw Object.assign(new Error("Quota projection contribution is missing"), { code: "QUOTA_PROJECTION_INVALID" });
  if (refs === 0)
    database
      .prepare(`DELETE FROM ${POINTS} WHERE limit_id=? AND window_minutes=? AND observed_at_ms=?
    AND resets_at_ms=? AND percent_kind=? AND percent_value=?`)
      .run(...values);
  else
    database
      .prepare(`INSERT INTO ${POINTS} VALUES(?,?,?,?,?,?,?) ON CONFLICT DO UPDATE SET refs=excluded.refs`)
      .run(...values, refs);
  const [limit, minutes, observed, reset] = values;
  database
    .prepare(`INSERT INTO ${BUCKETS} VALUES(?,?,?) ON CONFLICT(limit_id) DO UPDATE SET
    observation_count=observation_count+excluded.observation_count,
    latest_observed_at_ms=MAX(latest_observed_at_ms,excluded.latest_observed_at_ms)`)
    .run(limit, delta, observed);
  database.prepare(`DELETE FROM ${BUCKETS} WHERE limit_id=? AND observation_count=0`).run(limit);
  if (delta < 0)
    database
      .prepare(`UPDATE ${BUCKETS} SET latest_observed_at_ms=(SELECT MAX(observed_at_ms) FROM ${POINTS} WHERE limit_id=?)
    WHERE limit_id=? AND latest_observed_at_ms=?`)
      .run(limit, limit, observed);
  for (const boundary of [observed, reset, reset - minutes * MINUTE]) {
    database
      .prepare(`INSERT INTO ${BOUNDS} VALUES(?,?) ON CONFLICT(boundary) DO UPDATE SET refs=refs+excluded.refs`)
      .run(boundary, delta);
    database.prepare(`DELETE FROM ${BOUNDS} WHERE boundary=? AND refs=0`).run(boundary);
  }
  if (observed >= reset - minutes * MINUTE - TOLERANCE && observed < reset) {
    const time = database
      .prepare(
        `SELECT refs FROM ${TIMES} WHERE limit_id=? AND window_minutes=? AND resets_at_ms=? AND observed_at_ms=?`,
      )
      .get(limit, minutes, reset, observed);
    const remaining = Number(time?.refs ?? 0) + delta;
    if (remaining < 0)
      throw Object.assign(new Error("Quota endpoint contribution is missing"), { code: "QUOTA_PROJECTION_INVALID" });
    if (remaining === 0)
      database
        .prepare(`DELETE FROM ${TIMES} WHERE limit_id=? AND window_minutes=? AND resets_at_ms=? AND observed_at_ms=?`)
        .run(limit, minutes, reset, observed);
    else
      database
        .prepare(`INSERT INTO ${TIMES} VALUES(?,?,?,?,?) ON CONFLICT DO UPDATE SET refs=excluded.refs`)
        .run(limit, minutes, reset, observed, remaining);
    if (!time || !remaining)
      updateVisibleTime(database, limit, minutes, observed, reset, delta > 0 ? 1 : -1, asOf, dirty);
  }
}

function officialRow(row) {
  const parts = row.identity.split("\0");
  if (parts.length > 3) return null;
  const numeric = Number(parts[1]);
  const lookup = parts.length === 3 && Number.isSafeInteger(numeric) && String(numeric) === parts[1];
  return {
    identity_key: row.identity,
    source_path: lookup ? parts[0] : null,
    line_number: lookup ? numeric : null,
    role: lookup ? parts[2] : null,
    is_valid: row.valid ? 1 : 0,
    limit_id: row.limitId,
    window_minutes: row.windowMinutes,
    observed_at_ms: row.observedAtMs,
    resets_at_ms: row.resetsAtMs,
    percent_kind: row.percentKind,
    percent_value: row.usedPercent ?? 0,
  };
}
function isShadowed(database, row) {
  return (
    row.source_path !== null &&
    Boolean(
      database
        .prepare(`SELECT 1 FROM rate_limit_observations
    WHERE source_path=? AND line_number=? AND role=?`)
        .get(row.source_path, row.line_number, row.role),
    )
  );
}
function addOfficials(database, rows, asOf, dirty, initial) {
  for (const input of rows) {
    const row = officialRow(input);
    if (!row) throw Object.assign(new Error("Unsupported quota identity"), { code: "QUOTA_PROJECTION_UNSUPPORTED" });
    const active = isShadowed(database, row) ? 0 : 1;
    const inserted = database
      .prepare(`INSERT OR IGNORE INTO ${OFFICIALS} VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        row.identity_key,
        row.source_path,
        row.line_number,
        row.role,
        row.is_valid,
        row.limit_id,
        row.window_minutes,
        row.observed_at_ms,
        row.resets_at_ms,
        row.percent_kind,
        row.percent_value,
        active,
      );
    if (!Number(inserted.changes) || !active || !row.is_valid) continue;
    if (initial)
      database
        .prepare(`INSERT INTO ${POINTS} VALUES(?,?,?,?,?,?,1) ON CONFLICT DO UPDATE SET refs=refs+1`)
        .run(...point(row));
    else pointDelta(database, row, 1, asOf, dirty);
  }
}
function reconcileOfficial(database, source, line, role, asOf, dirty) {
  for (const row of database
    .prepare(`SELECT * FROM ${OFFICIALS} WHERE source_path=? AND line_number=? AND role=?`)
    .all(source, line, role)) {
    const active = isShadowed(database, row) ? 0 : 1;
    if (active === Number(row.active)) continue;
    pointDelta(database, row, active ? 1 : -1, asOf, dirty);
    database.prepare(`UPDATE ${OFFICIALS} SET active=? WHERE identity_key=?`).run(active, row.identity_key);
  }
}
function initialize(database, signature, revision, asOf, officials, dirty) {
  for (const table of USAGE_QUOTA_PROJECTION_TABLE_NAMES) if (table !== FORMAT) database.exec(`DELETE FROM ${table}`);
  if (
    database
      .prepare(
        "SELECT 1 FROM rate_limit_observations WHERE instr(source_path,char(0))>0 OR instr(role,char(0))>0 LIMIT 1",
      )
      .get()
  )
    throw Object.assign(new Error("Unsupported quota identity"), { code: "QUOTA_PROJECTION_UNSUPPORTED" });
  database.prepare(`INSERT INTO ${STATE} VALUES(1,?,?,?,0,0)`).run(revision, signature, asOf);
  database.exec(`INSERT INTO ${POINTS} SELECT raw.limit_id,raw.window_minutes,raw.observed_at_ms,raw.resets_at_ms,
    CASE WHEN raw.used_percent IS NULL THEN 'null' ELSE 'number' END,COALESCE(raw.used_percent,0),COUNT(*)
    FROM rate_limit_observations AS raw WHERE ${valid("raw")}
    GROUP BY raw.limit_id,raw.window_minutes,raw.observed_at_ms,raw.resets_at_ms,6,5`);
  addOfficials(database, officials, asOf, dirty, true);
  database.exec(`INSERT INTO ${BUCKETS} SELECT limit_id,SUM(refs),MAX(observed_at_ms) FROM ${POINTS} GROUP BY limit_id;
    INSERT INTO ${BOUNDS} SELECT boundary,SUM(refs) FROM (
      SELECT observed_at_ms boundary,refs FROM ${POINTS} UNION ALL SELECT resets_at_ms,refs FROM ${POINTS}
      UNION ALL SELECT resets_at_ms-window_minutes*${MINUTE},refs FROM ${POINTS}) GROUP BY boundary;
    INSERT INTO ${TIMES} SELECT limit_id,window_minutes,resets_at_ms,observed_at_ms,SUM(refs) FROM ${POINTS}
      WHERE observed_at_ms>=resets_at_ms-window_minutes*${MINUTE}-${TOLERANCE} AND observed_at_ms<resets_at_ms
      GROUP BY limit_id,window_minutes,resets_at_ms,observed_at_ms`);
  database
    .prepare(`INSERT INTO ${ENDPOINTS} SELECT limit_id,window_minutes,resets_at_ms,COUNT(*),MIN(observed_at_ms),NULL
    FROM ${TIMES} WHERE observed_at_ms<=? GROUP BY limit_id,window_minutes,resets_at_ms`)
    .run(asOf);
  database
    .prepare(`INSERT INTO ${CONFLICTS} SELECT limit_id,window_minutes,observed_at_ms FROM ${TIMES}
    WHERE observed_at_ms<=? GROUP BY limit_id,window_minutes,observed_at_ms
    HAVING MAX(resets_at_ms)-MIN(resets_at_ms)>?`)
    .run(asOf, TOLERANCE);
  database.exec(
    `INSERT INTO ${DIRTY} SELECT limit_id,window_minutes,MIN(resets_at_ms) FROM ${ENDPOINTS} GROUP BY limit_id,window_minutes`,
  );
}

function rebuildCycles(database, work) {
  const updateAnchor = database.prepare(
    `UPDATE ${ENDPOINTS} SET anchor_ms=? WHERE limit_id=? AND window_minutes=? AND resets_at_ms>=? AND resets_at_ms<=?`,
  );
  const insertCycle = database.prepare(`INSERT INTO ${CYCLES} VALUES(?,?,?,?,?,?,?)`);
  for (;;) {
    const partitions = database
      .prepare(`SELECT limit_id,window_minutes,resets_at_ms FROM ${DIRTY} ORDER BY limit_id,window_minutes LIMIT ?`)
      .all(BATCH);
    if (!partitions.length) break;
    for (const partition of partitions) {
      const limit = String(partition.limit_id),
        minutes = Number(partition.window_minutes),
        reset = Number(partition.resets_at_ms);
      const previous = database
        .prepare(`SELECT anchor_ms FROM ${ENDPOINTS} WHERE limit_id=? AND window_minutes=? AND resets_at_ms<=?
      AND anchor_ms IS NOT NULL ORDER BY resets_at_ms DESC LIMIT 1`)
        .get(limit, minutes, reset);
      const first = previous ? Math.min(Number(previous.anchor_ms), reset) : reset;
      const before = database
        .prepare(`SELECT first_observed FROM ${CYCLES} WHERE limit_id=? AND window_minutes=? AND anchor_ms<?
      ORDER BY anchor_ms DESC LIMIT 1`)
        .get(limit, minutes, first);
      database
        .prepare(`DELETE FROM ${CYCLES} WHERE limit_id=? AND window_minutes=? AND anchor_ms>=?`)
        .run(limit, minutes, first);
      let priorFirst = before ? Number(before.first_observed) : null;
      let cluster = null,
        last = null;
      const publish = () => {
        if (!cluster) return;
        updateAnchor.run(cluster.anchor, limit, minutes, cluster.anchor, cluster.last);
        const start = cluster.selected - minutes * MINUTE;
        insertCycle.run(
          limit,
          minutes,
          cluster.anchor,
          start,
          cluster.selected,
          cluster.first,
          priorFirst !== null && priorFirst >= start ? 1 : 0,
        );
        priorFirst = cluster.first;
        work.cycles += 1;
      };
      for (;;) {
        const rows = database
          .prepare(`SELECT resets_at_ms,support_count,first_observed FROM ${ENDPOINTS}
        WHERE limit_id=? AND window_minutes=? AND resets_at_ms${last === null ? ">=" : ">"}? ORDER BY resets_at_ms LIMIT ?`)
          .all(limit, minutes, last === null ? first : last, BATCH);
        if (!rows.length) break;
        for (const row of rows) {
          const end = Number(row.resets_at_ms),
            count = Number(row.support_count),
            observed = Number(row.first_observed);
          if (!cluster || end - cluster.anchor > TOLERANCE) {
            publish();
            cluster = { anchor: end, last: end, selected: end, count, first: observed };
          } else {
            cluster.last = end;
            cluster.first = Math.min(cluster.first, observed);
            if (count > cluster.count || (count === cluster.count && end > cluster.selected)) {
              cluster.selected = end;
              cluster.count = count;
            }
          }
          last = end;
          work.endpoints += 1;
        }
      }
      publish();
      database.prepare(`DELETE FROM ${DIRTY} WHERE limit_id=? AND window_minutes=?`).run(limit, minutes);
    }
  }
}

/** Publish a quota-owned projection; the caller supplies exactly the legacy official normalization. */
export function prepareQuotaProjection(database, { signature, revision, asOf, officialRows }) {
  const work = workByDatabase.get(database) ?? resetQuotaProjectionWork(database);
  if (database.isTransaction || !eligible(database)) return null;
  if (!ensureQuotaProjectionSchema(database)) return null;
  database.exec("BEGIN IMMEDIATE");
  try {
    const state = database.prepare(`SELECT * FROM ${STATE} WHERE singleton=1`).get();
    if (state && asOf < Number(state.as_of_ms) && !Number(state.rebuild)) {
      database.exec("ROLLBACK");
      return null;
    }
    const dirty = database;
    const queued = Number(database.prepare(`SELECT COUNT(*) n FROM ${QUEUE}`).get().n);
    if (
      !state ||
      Number(state.rebuild) ||
      queued !== Number(state.queued) ||
      (Number(state.revision) !== revision && !queued)
    ) {
      initialize(database, signature, revision, asOf, officialRows(), dirty);
      work.rebuilt = true;
    } else {
      const previousAsOf = Number(state.as_of_ms);
      const changedOfficials = state.official_signature !== signature;
      if (changedOfficials) {
        let after = "";
        for (;;) {
          const rows = database
            .prepare(`SELECT * FROM ${OFFICIALS} WHERE identity_key>? ORDER BY identity_key LIMIT ?`)
            .all(after, BATCH);
          if (!rows.length) break;
          for (const row of rows) {
            if (Number(row.active)) pointDelta(database, row, -1, previousAsOf, dirty);
            after = String(row.identity_key);
          }
        }
        database.exec(`DELETE FROM ${OFFICIALS}`);
      }
      for (;;) {
        const rows = database.prepare(`SELECT * FROM ${QUEUE} ORDER BY id LIMIT ?`).all(BATCH);
        if (!rows.length) break;
        for (const row of rows) {
          if (String(row.source_path).includes("\0") || String(row.role).includes("\0"))
            throw Object.assign(new Error("Unsupported quota identity"), { code: "QUOTA_PROJECTION_UNSUPPORTED" });
          pointDelta(database, row, Number(row.delta), previousAsOf, dirty);
          if (!changedOfficials)
            reconcileOfficial(database, row.source_path, row.line_number, row.role, previousAsOf, dirty);
          work.changes += 1;
        }
        database.prepare(`DELETE FROM ${QUEUE} WHERE id<=?`).run(rows.at(-1).id);
      }
      if (changedOfficials) addOfficials(database, officialRows(), previousAsOf, dirty, false);
      work.promotedTimes += Number(
        database
          .prepare(`SELECT COUNT(*) n FROM ${TIMES}
        WHERE observed_at_ms>? AND observed_at_ms<=?`)
          .get(previousAsOf, asOf).n,
      );
      database
        .prepare(`INSERT INTO ${ENDPOINTS} SELECT limit_id,window_minutes,resets_at_ms,COUNT(*),MIN(observed_at_ms),NULL
        FROM ${TIMES} WHERE observed_at_ms>? AND observed_at_ms<=? GROUP BY limit_id,window_minutes,resets_at_ms
        ON CONFLICT(limit_id,window_minutes,resets_at_ms) DO UPDATE SET support_count=support_count+excluded.support_count,
          first_observed=MIN(first_observed,excluded.first_observed)`)
        .run(previousAsOf, asOf);
      database
        .prepare(`INSERT INTO ${DIRTY} SELECT limit_id,window_minutes,MIN(resets_at_ms) FROM ${TIMES}
        WHERE observed_at_ms>? AND observed_at_ms<=? GROUP BY limit_id,window_minutes
        ON CONFLICT(limit_id,window_minutes) DO UPDATE SET resets_at_ms=MIN(resets_at_ms,excluded.resets_at_ms)`)
        .run(previousAsOf, asOf);
      database
        .prepare(`INSERT OR IGNORE INTO ${CONFLICTS} SELECT limit_id,window_minutes,observed_at_ms FROM ${TIMES}
        WHERE observed_at_ms>? AND observed_at_ms<=? GROUP BY limit_id,window_minutes,observed_at_ms
        HAVING MAX(resets_at_ms)-MIN(resets_at_ms)>?`)
        .run(previousAsOf, asOf, TOLERANCE);
    }
    rebuildCycles(database, work);
    database
      .prepare(`UPDATE ${STATE} SET revision=?,official_signature=?,as_of_ms=?,queued=0,rebuild=0 WHERE singleton=1`)
      .run(revision, signature, asOf);
    database.exec("COMMIT");
    return readQuotaProjection(database, { signature, revision, asOf });
  } catch (error) {
    database.exec("ROLLBACK");
    if (error.code === "QUOTA_PROJECTION_UNSUPPORTED" || /readonly|locked|busy/i.test(String(error.message)))
      return null;
    if (error.code === "QUOTA_PROJECTION_INVALID") {
      database.exec(`UPDATE ${STATE} SET rebuild=1`);
      throw error;
    }
    throw error;
  }
}

export function readQuotaProjection(database, { signature, revision, asOf }) {
  try {
    if (!schemaReady(database) || !eligible(database)) return null;
    const state = database.prepare(`SELECT * FROM ${STATE} WHERE singleton=1`).get();
    if (
      !state ||
      Number(state.rebuild) ||
      Number(state.queued) ||
      Number(state.revision) !== revision ||
      state.official_signature !== signature
    )
      return null;
    const unbounded = Number.isNaN(asOf) || asOf === Infinity;
    if (!unbounded && asOf < Number(state.as_of_ms)) return null;
    const next = database
      .prepare(`SELECT observed_at_ms FROM ${TIMES} WHERE observed_at_ms>? ORDER BY observed_at_ms LIMIT 1`)
      .get(state.as_of_ms);
    if (next && (unbounded || Number(next.observed_at_ms) <= asOf)) return null;
    return { observations: VIEW, buckets: BUCKETS, cycles: CYCLES, conflicts: CONFLICTS, boundaries: BOUNDS };
  } catch {
    return null;
  }
}

export function quotaProjectionBounds(database, asOf) {
  return {
    validFromMs: Number(
      database.prepare(`SELECT MAX(boundary) value FROM ${BOUNDS} WHERE boundary<=?`).get(asOf).value ??
        Number.MIN_SAFE_INTEGER,
    ),
    validToMs: Number(
      database.prepare(`SELECT MIN(boundary) value FROM ${BOUNDS} WHERE boundary>?`).get(asOf).value ??
        Number.MAX_SAFE_INTEGER,
    ),
  };
}
