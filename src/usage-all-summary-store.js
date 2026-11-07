import { createCostEstimateAccumulator } from "./pricing.js";
import { createTimelineAccumulator, sourceGroup } from "../public/timeline-utils.js";

const FORMAT = 3;
const CHECKPOINT_INTERVAL = 1024;
const CHECKPOINT_LIMIT = 32;
const START = { ms: Number.MIN_SAFE_INTEGER, id: Number.MIN_SAFE_INTEGER };
const FIELDS = ["total", "input", "cached", "output", "reasoning"];
const STATE = "usage_all_summary_state";
const CHECKPOINTS = "usage_all_summary_checkpoints";
const MEMBERS = "usage_all_summary_members";
const DIRTY = "usage_all_summary_dirty";
const FORMAT_TABLE = "usage_all_summary_format";
const TRIGGERS = [
  "usage_all_insert_before",
  "usage_all_insert",
  "usage_all_update",
  "usage_all_delete",
  "usage_all_source_insert",
  "usage_all_source_update",
  "usage_all_source_delete",
];
export const USAGE_ALL_SUMMARY_TABLE_NAMES = Object.freeze([STATE, CHECKPOINTS, MEMBERS, DIRTY, FORMAT_TABLE]);

const HOT_TABLES = { STATE, CHECKPOINTS, MEMBERS, DIRTY, FORMAT_TABLE };
const HISTORY_TABLES = {
  STATE: "usage_history_all_summary_state",
  CHECKPOINTS: "usage_history_all_summary_checkpoints",
  MEMBERS: "usage_history_all_summary_members",
  DIRTY: "usage_history_all_summary_dirty",
  FORMAT_TABLE: "usage_history_all_summary_format",
};
export const USAGE_HISTORY_ALL_SUMMARY_TABLE_NAMES = Object.freeze(Object.values(HISTORY_TABLES));
const tables = (options) => (options.mode === "history" ? HISTORY_TABLES : HOT_TABLES);
const before = (a, b, history) => (history ? a.ms < b.ms || (a.ms === b.ms && a.id < b.id) : a.id < b.id);
const position = (row) => ({ ms: Number(row.timestamp_ms), id: Number(row.event_id) });
const revision = (db) =>
  Number(db.prepare("SELECT revision FROM usage_business_revision WHERE singleton=1").get().revision);
const stateRow = (db, state) => db.prepare(`SELECT * FROM ${state} WHERE singleton=1`).get();
const dirtyRow = (db, dirty) => db.prepare(`SELECT timestamp_ms,event_id FROM ${dirty} WHERE singleton=1`).get();
const dirtySql = (ref) => `INSERT INTO ${DIRTY}(singleton,timestamp_ms,event_id) VALUES(1,${ref}.timestamp_ms,${ref}.id)
  ON CONFLICT(singleton) DO UPDATE SET timestamp_ms=excluded.timestamp_ms,event_id=excluded.event_id
  WHERE excluded.event_id < event_id;`;

/** Rebuildable state; history tables belong only in the derived database. */
export function ensureUsageAllSummarySchema(database, options = { mode: "hot" }) {
  const { STATE, CHECKPOINTS, MEMBERS, DIRTY, FORMAT_TABLE } = tables(options);
  const history = options.mode === "history";
  database.exec(
    `CREATE TABLE IF NOT EXISTS ${FORMAT_TABLE}(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL) STRICT;`,
  );
  const format = database.prepare(`SELECT version FROM ${FORMAT_TABLE} WHERE singleton=1`).get();
  const count = Number(
    database
      .prepare(
        `SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN (${[STATE, CHECKPOINTS, MEMBERS, DIRTY].map(() => "?").join(",")})`,
      )
      .get(STATE, CHECKPOINTS, MEMBERS, DIRTY).n,
  );
  if (format?.version !== FORMAT || count !== 4) {
    if (!history) for (const name of TRIGGERS) database.exec(`DROP TRIGGER IF EXISTS ${name}`);
    for (const name of [STATE, CHECKPOINTS, MEMBERS, DIRTY]) database.exec(`DROP TABLE IF EXISTS ${name}`);
    database.exec(`DELETE FROM ${FORMAT_TABLE};INSERT INTO ${FORMAT_TABLE} VALUES(1,${FORMAT});
      CREATE TABLE ${STATE}(singleton INTEGER PRIMARY KEY CHECK(singleton=1),context_key TEXT NOT NULL,
        zone TEXT NOT NULL,requested_bucket TEXT NOT NULL,bucket TEXT NOT NULL,target_revision INTEGER NOT NULL,
        published_revision INTEGER NOT NULL,status TEXT NOT NULL,last_ms INTEGER NOT NULL,last_id INTEGER NOT NULL,
        force_rebuild INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE ${CHECKPOINTS}(timestamp_ms INTEGER NOT NULL,event_id INTEGER NOT NULL,state_json TEXT NOT NULL,block INTEGER NOT NULL UNIQUE,
        PRIMARY KEY(${history ? "timestamp_ms,event_id" : "event_id"})) STRICT;
      CREATE TABLE ${MEMBERS}(scope TEXT NOT NULL,member TEXT NOT NULL,first_ms INTEGER NOT NULL,first_id INTEGER NOT NULL,
        PRIMARY KEY(scope,member)) WITHOUT ROWID;
      CREATE INDEX ${history ? "usage_history_all_members_position_idx" : "usage_all_members_position_idx"}
        ON ${MEMBERS}(${history ? "first_ms,first_id" : "first_id"});
      CREATE TABLE ${DIRTY}(singleton INTEGER PRIMARY KEY CHECK(singleton=1),timestamp_ms INTEGER NOT NULL,event_id INTEGER NOT NULL) STRICT;`);
  }
  if (history) return;
  const enabled = `EXISTS(SELECT 1 FROM ${STATE} WHERE singleton=1)`;
  database.exec(`CREATE TRIGGER IF NOT EXISTS usage_all_insert_before BEFORE INSERT ON events WHEN ${enabled} BEGIN
    INSERT INTO ${DIRTY}(singleton,timestamp_ms,event_id) SELECT 1,timestamp_ms,id FROM events WHERE id=NEW.id
      ON CONFLICT(singleton) DO UPDATE SET timestamp_ms=excluded.timestamp_ms,event_id=excluded.event_id
      WHERE excluded.event_id < event_id;
    END;
    CREATE TRIGGER IF NOT EXISTS usage_all_insert AFTER INSERT ON events WHEN ${enabled} BEGIN ${dirtySql("NEW")} END;
    CREATE TRIGGER IF NOT EXISTS usage_all_update AFTER UPDATE ON events WHEN ${enabled} BEGIN ${dirtySql("OLD")} ${dirtySql("NEW")} END;
    CREATE TRIGGER IF NOT EXISTS usage_all_delete AFTER DELETE ON events WHEN ${enabled} BEGIN ${dirtySql("OLD")} END;
    CREATE TRIGGER IF NOT EXISTS usage_all_source_insert BEFORE INSERT ON source_files WHEN ${enabled}
      AND EXISTS(SELECT 1 FROM source_files WHERE path=NEW.path AND
        (kind IS NOT NEW.kind OR home_id IS NOT NEW.home_id OR home_label IS NOT NEW.home_label OR home_path IS NOT NEW.home_path))
      BEGIN UPDATE ${STATE} SET force_rebuild=1 WHERE singleton=1; END;
    CREATE TRIGGER IF NOT EXISTS usage_all_source_update AFTER UPDATE OF path,kind,home_id,home_label,home_path ON source_files
      WHEN ${enabled} AND (OLD.path IS NOT NEW.path OR OLD.kind IS NOT NEW.kind OR OLD.home_id IS NOT NEW.home_id OR OLD.home_label IS NOT NEW.home_label OR OLD.home_path IS NOT NEW.home_path)
      BEGIN UPDATE ${STATE} SET force_rebuild=1 WHERE singleton=1; END;
    CREATE TRIGGER IF NOT EXISTS usage_all_source_delete AFTER DELETE ON source_files WHEN ${enabled}
      BEGIN UPDATE ${STATE} SET force_rebuild=1 WHERE singleton=1; END;`);
}

/** Mark the earliest changed logical position in the caller's fact-update transaction. */
export function markStoredHistoryAllSummaryDirty(database, { ms, id }) {
  if (!Number.isSafeInteger(ms) || !Number.isSafeInteger(id))
    throw new TypeError("Invalid history all-summary dirty position");
  database
    .prepare(`INSERT INTO ${HISTORY_TABLES.DIRTY}(singleton,timestamp_ms,event_id) VALUES(1,?,?)
      ON CONFLICT(singleton) DO UPDATE SET timestamp_ms=excluded.timestamp_ms,event_id=excluded.event_id
      WHERE (excluded.timestamp_ms,excluded.event_id)<(timestamp_ms,event_id)`)
    .run(ms, id);
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

function totals() {
  return { event_count: 0, session_count: 0, home_count: 0, total: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
}
function numberState(value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== 1 ||
    !value.aggregate ||
    !Array.isArray(value.channels) ||
    !Array.isArray(value.models) ||
    !value.cost ||
    !value.timeline
  )
    throw Object.assign(new TypeError("Invalid stored all-summary state"), { code: "ALL_SUMMARY_STATE_INVALID" });
  const numbers = (object, keys) => {
    if (
      !object ||
      Object.keys(object).length !== keys.length ||
      keys.some((key) => !Number.isSafeInteger(object[key]) || object[key] < 0)
    )
      throw new TypeError("Invalid all-summary integer state");
  };
  numbers(value.aggregate, Object.keys(totals()));
  for (const groups of [value.channels, value.models]) {
    const names = new Set();
    for (const group of groups) {
      if (!group || typeof group.name !== "string" || group.key !== group.name || names.has(group.name))
        throw new TypeError("Invalid all-summary group state");
      names.add(group.name);
      numbers(group.total, FIELDS);
      numbers({ count: group.count, sessions: group.sessions }, ["count", "sessions"]);
    }
  }
  return value;
}

/** One event is live at a time; member identities live in indexed SQLite rows. */
function accumulator(options, saved = null) {
  const { database, range, bucket, pricing, sourceKinds, pricingModels } = options;
  const { MEMBERS } = tables(options);
  if (saved) numberState(saved);
  let current = START;
  const insert = database.prepare(`INSERT OR IGNORE INTO ${MEMBERS}(scope,member,first_ms,first_id) VALUES(?,?,?,?)`);
  const memberSet = (scope, count = 0) => {
    if (!Number.isSafeInteger(count) || count < 0) throw new TypeError("Invalid all-summary member count");
    const key = JSON.stringify(scope);
    let size = count;
    let previousMember;
    return {
      add(member) {
        const value = String(member);
        if (value === previousMember) return this;
        size += Number(insert.run(key, value, current.ms, current.id).changes);
        previousMember = value;
        return this;
      },
      get size() {
        return size;
      },
    };
  };
  const aggregate = saved ? { ...saved.aggregate } : totals();
  const sessions = memberSet(["all", "sessions"], aggregate.session_count),
    homes = memberSet(["all", "homes"], aggregate.home_count);
  const channels = new Map(
    (saved?.channels || []).map((x) => [
      x.name,
      { ...x, total: { ...x.total }, sessionsSet: memberSet(["all", "channel", x.name], x.sessions) },
    ]),
  );
  const models = new Map(
    (saved?.models || []).map((x) => [
      x.name,
      { ...x, total: { ...x.total }, sessionsSet: memberSet(["all", "model", x.name], x.sessions) },
    ]),
  );
  const cost = createCostEstimateAccumulator({ modelName: pricing.costModelName, state: saved?.cost });
  const timeline = createTimelineAccumulator(range, bucket, {
    state: saved?.timeline,
    pricingModels,
    sourceKinds,
    modelName: pricing.modelName,
    createSessionSet: (scope, state) => memberSet(["timeline", ...scope], state || 0),
    snapshotSessionSet: (set) => set.size,
  });
  const addGroup = (groups, kind, name, event) => {
    let group = groups.get(name);
    if (!group) {
      group = {
        key: name,
        name,
        count: 0,
        sessions: 0,
        total: Object.fromEntries(FIELDS.map((k) => [k, 0])),
        sessionsSet: memberSet(["all", kind, name]),
      };
      groups.set(name, group);
    }
    group.count++;
    group.sessionsSet.add(event.sessionId);
    for (const field of FIELDS) group.total[field] += event.total[field];
  };
  const groupState = (groups) =>
    [...groups.values()].map((x) => ({
      key: x.name,
      name: x.name,
      count: x.count,
      sessions: x.sessionsSet.size,
      total: { ...x.total },
    }));
  const orderedGroups = (groups) =>
    groupState(groups).sort(
      (a, b) => b.total.total - a.total.total || Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)),
    );
  return {
    add(event) {
      current = { ms: event.timestamp, id: event.id };
      aggregate.event_count++;
      sessions.add(event.sessionId);
      homes.add(event.homeId);
      for (const field of FIELDS) {
        aggregate[field] += event.total[field];
        if (!Number.isSafeInteger(aggregate[field]))
          throw new RangeError("All-summary integer exceeds the exact range");
      }
      aggregate.session_count = sessions.size;
      aggregate.home_count = homes.size;
      const estimate = pricing.estimate(event);
      cost.add(event, estimate);
      timeline.add(event, estimate);
      addGroup(channels, "channel", sourceGroup(event.channel, event.sourceKind), event);
      addGroup(models, "model", pricing.modelName(event.model), event);
    },
    snapshot() {
      return {
        version: 1,
        aggregate: { ...aggregate },
        channels: groupState(channels),
        models: groupState(models),
        cost: cost.snapshot(),
        timeline: timeline.snapshot(),
      };
    },
    result() {
      return {
        aggregate: { ...aggregate },
        channels: orderedGroups(channels),
        models: orderedGroups(models),
        costEstimate: cost.result(),
        timeline: timeline.result(range),
        timelineError: null,
      };
    },
  };
}

function reset(database, options, target) {
  const { STATE, CHECKPOINTS, MEMBERS, DIRTY } = tables(options);
  for (const table of [CHECKPOINTS, MEMBERS, DIRTY, STATE]) database.exec(`DELETE FROM ${table}`);
  const empty = accumulator(options);
  database
    .prepare(`INSERT INTO ${CHECKPOINTS} VALUES(?,?,?,-1)`)
    .run(START.ms, START.id, JSON.stringify(empty.snapshot()));
  database
    .prepare(`INSERT INTO ${STATE} VALUES(1,?,?,?,?,?,?,'building',?,?,0)`)
    .run(
      options.key,
      options.range.calendarZone || "local",
      options.requestedBucket || "day",
      options.bucket,
      target,
      -1,
      START.ms,
      START.id,
    );
  return stateRow(database, STATE);
}

/**
 * Persist ordered checkpoints, so normal appends never replay unrelated history.
 * Late corrections replay the affected suffix to preserve floating-point order.
 * @param {any} options
 */
export function buildStoredAllSummary(options) {
  const { database, key } = options;
  const { STATE, CHECKPOINTS, MEMBERS, DIRTY } = tables(options);
  const history = options.mode === "history";
  if (database.isTransaction) throw new Error("All-summary build needs an unpinned writer");
  const batchSize = options.batchSize || 1024;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10000)
    throw new TypeError("Invalid all-summary batch size");
  const work = { readEvents: 0, pricedEvents: 0, batches: 0, rewinds: 0, rebuilt: false, reused: false };
  let restored = null,
    state = null;
  for (;;) {
    const step = transaction(database, () => {
      const target = revision(database);
      state = stateRow(database, STATE);
      if (!state || state.context_key !== key || state.force_rebuild) {
        state = reset(database, options, target);
        restored = null;
        work.rebuilt = true;
      }
      const dirty = dirtyRow(database, DIRTY);
      if (state.target_revision !== target || dirty) {
        const cutoff = dirty ? position(dirty) : START;
        let checkpoint;
        if (dirty && before({ ms: state.last_ms, id: state.last_id }, cutoff, history))
          checkpoint = { timestamp_ms: state.last_ms, event_id: state.last_id };
        else
          checkpoint = database
            .prepare(`SELECT timestamp_ms,event_id FROM ${CHECKPOINTS}
          WHERE ${history ? "(timestamp_ms,event_id)<(?,?) ORDER BY timestamp_ms DESC,event_id DESC" : "event_id<? ORDER BY event_id DESC"} LIMIT 1`)
            .get(...(history ? [cutoff.ms, cutoff.id] : [cutoff.id]));
        const at = checkpoint ? position(checkpoint) : START;
        const params = history ? [at.ms, at.id] : [at.id];
        database
          .prepare(`DELETE FROM ${CHECKPOINTS} WHERE ${history ? "(timestamp_ms,event_id)>(?,?)" : "event_id>?"}`)
          .run(...params);
        database
          .prepare(`DELETE FROM ${MEMBERS} WHERE ${history ? "(first_ms,first_id)>(?,?)" : "first_id>?"}`)
          .run(...params);
        database
          .prepare(`UPDATE ${STATE} SET target_revision=?,status='building',last_ms=?,last_id=? WHERE singleton=1`)
          .run(target, at.ms, at.id);
        database.exec(`DELETE FROM ${DIRTY}`);
        state = stateRow(database, STATE);
        restored = null;
        work.rewinds++;
      }
      if (!restored) {
        const row = database
          .prepare(`SELECT state_json FROM ${CHECKPOINTS} WHERE timestamp_ms=? AND event_id=?`)
          .get(state.last_ms, state.last_id);
        try {
          restored = accumulator(options, JSON.parse(String(row?.state_json)));
        } catch (error) {
          if (!(error instanceof TypeError || error instanceof SyntaxError)) throw error;
          state = reset(database, options, target);
          restored = accumulator(options);
          work.rebuilt = true;
        }
      }
      if (state.status === "ready" && state.published_revision === target) {
        work.reused = true;
        return { done: true, processed: 0 };
      }
      let last = { ms: state.last_ms, id: state.last_id },
        processed = 0;
      for (const event of options.eventsAfter(last, batchSize)) {
        if (
          !Number.isSafeInteger(event.id) ||
          !Number.isSafeInteger(event.timestamp) ||
          !before(last, { ms: event.timestamp, id: event.id }, history)
        )
          throw new TypeError("All-summary input order is invalid");
        restored.add(event);
        last = { ms: event.timestamp, id: event.id };
        processed++;
      }
      work.readEvents += processed;
      work.pricedEvents += processed;
      work.batches++;
      if (processed) {
        const snapshot = restored.snapshot();
        const block = Math.floor((snapshot.aggregate.event_count - 1) / CHECKPOINT_INTERVAL);
        database
          .prepare(`INSERT OR REPLACE INTO ${CHECKPOINTS} VALUES(?,?,?,?)`)
          .run(last.ms, last.id, JSON.stringify(snapshot), block);
        // Older corrections can replay from START; checkpoint copies never grow with append count.
        database.prepare(`DELETE FROM ${CHECKPOINTS} WHERE block>=0 AND block<?`).run(block - CHECKPOINT_LIMIT + 1);
        database.prepare(`UPDATE ${STATE} SET last_ms=?,last_id=? WHERE singleton=1`).run(last.ms, last.id);
      }
      const done = processed < batchSize;
      if (done) {
        if (options.contextKey && options.contextKey() !== key)
          throw Object.assign(new Error("All-summary context changed during build"), {
            code: "ALL_SUMMARY_CONTEXT_CHANGED",
          });
        database.prepare(`UPDATE ${STATE} SET status='ready',published_revision=? WHERE singleton=1`).run(target);
      }
      return { done, processed };
    });
    options.afterBatch?.({ ...step, ...work });
    if (step.done) break;
  }
  return work;
}

/** Read only a complete matching view inside the caller's existing read snapshot. @param {any} options */
export function readStoredAllSummary(options) {
  const { STATE, CHECKPOINTS, DIRTY } = tables(options);
  const { database, key } = options,
    state = stateRow(database, STATE);
  if (
    !state ||
    state.context_key !== key ||
    state.force_rebuild ||
    state.status !== "ready" ||
    state.published_revision !== revision(database) ||
    dirtyRow(database, DIRTY)
  )
    return null;
  const row = database
    .prepare(`SELECT state_json FROM ${CHECKPOINTS} WHERE timestamp_ms=? AND event_id=?`)
    .get(state.last_ms, state.last_id);
  if (!row) return null;
  try {
    return accumulator(options, JSON.parse(String(row.state_json))).result();
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError) return null;
    throw error;
  }
}
