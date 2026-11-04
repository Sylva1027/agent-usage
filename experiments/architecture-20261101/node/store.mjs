import { DatabaseSync } from "node:sqlite";

import {
  AggregateOverflowError,
  aggregateEvents,
  compareNames,
  projectionLabel,
} from "./query.mjs";
import { InputError, USAGE_FIELDS, validateCommitBody } from "./protocol.mjs";

const QUERY_PROJECTION_VERSION = "1";
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export class SnapshotNotFoundError extends Error {
  constructor(revision) {
    super(`Unknown snapshot ${revision}`);
    this.name = "SnapshotNotFoundError";
    this.revision = revision;
  }
}

export class LegacySnapshotError extends Error {
  constructor(revision) {
    super(`Snapshot ${revision} requires reset: legacy snapshot has no source grouping`);
    this.name = "LegacySnapshotError";
    this.revision = revision;
    this.code = "reset-required";
  }
}

export class CursorConflictError extends Error {
  constructor(sourceId) {
    super(`Source cursor conflict for ${sourceId}`);
    this.name = "CursorConflictError";
    this.sourceId = sourceId;
  }
}

function parseJson(value) {
  return JSON.parse(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameCursor(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function safeInteger(value) {
  if (typeof value === "bigint") {
    if (value < 0n || value > MAX_SAFE_BIGINT) {
      throw new AggregateOverflowError();
    }
    return Number(value);
  }
  if (!Number.isSafeInteger(value)) {
    throw new AggregateOverflowError();
  }
  return value;
}

function filterEvents(events, filters = {}) {
  const excluded = new Set(filters.excludeHomes || []);
  return events.filter((event) => {
    if (excluded.has(event.homeId)) {
      return false;
    }
    const timestamp = Date.parse(event.timestamp);
    if (filters.startMs !== undefined && timestamp < filters.startMs) {
      return false;
    }
    if (filters.endMs !== undefined && timestamp > filters.endMs) {
      return false;
    }
    return true;
  });
}

function normalizeSnapshot(state) {
  if (!Array.isArray(state.sources)) {
    return state;
  }
  const sources = state.sources.map((source) => ({
    sourceId: source.sourceId,
    events: source.events,
    cursor: source.cursor,
  }));
  const events = sources
    .flatMap((source) => source.events.map((event) => ({ sourceId: source.sourceId, event })))
    .sort(
      (left, right) =>
        compareNames(left.event.timestamp, right.event.timestamp) ||
        compareNames(left.sourceId, right.sourceId) ||
        compareNames(left.event.eventId, right.event.eventId),
    )
    .map(({ event }) => event);
  return {
    events,
    context: state.context,
    cursors: Object.fromEntries(sources.map((source) => [source.sourceId, source.cursor])),
    sources,
  };
}

function changesSnapshotSources(state, revision) {
  if (Array.isArray(state.sources)) {
    return state.sources;
  }
  const sourceIds = Object.keys(state.cursors || {});
  if (!Array.isArray(state.events) || state.events.length === 0 || sourceIds.length !== 1) {
    throw new LegacySnapshotError(revision);
  }
  const sourceId = sourceIds[0];
  return [{ sourceId, events: state.events, cursor: state.cursors[sourceId] }];
}

export class SqliteStore {
  constructor(databasePath) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS sources (
        source_id TEXT PRIMARY KEY,
        cursor_json TEXT NOT NULL,
        updated_revision INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS events (
        source_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        home_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (source_id, event_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS events_timestamp
        ON events(timestamp_ms, timestamp, source_id, event_id);
      CREATE INDEX IF NOT EXISTS events_home
        ON events(home_id, timestamp_ms);

      CREATE TABLE IF NOT EXISTS event_query (
        source_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        utc_day TEXT NOT NULL,
        session_id TEXT NOT NULL,
        home_id TEXT NOT NULL,
        model TEXT NOT NULL,
        channel TEXT NOT NULL,
        cwd TEXT NOT NULL,
        repository_key TEXT NOT NULL,
        total INTEGER NOT NULL,
        input INTEGER NOT NULL,
        cached INTEGER NOT NULL,
        output INTEGER NOT NULL,
        reasoning INTEGER NOT NULL,
        PRIMARY KEY (source_id, event_id),
        FOREIGN KEY (source_id, event_id)
          REFERENCES events(source_id, event_id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS event_query_timestamp
        ON event_query(timestamp_ms);
      CREATE INDEX IF NOT EXISTS event_query_home
        ON event_query(home_id, timestamp_ms);

      CREATE TABLE IF NOT EXISTS snapshots (
        revision INTEGER PRIMARY KEY,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      INSERT OR IGNORE INTO meta(key, value) VALUES ('revision', '0');
      INSERT OR IGNORE INTO meta(key, value) VALUES ('context', '{}');
      INSERT OR IGNORE INTO meta(key, value)
        SELECT 'context_revision', value FROM meta WHERE key = 'revision';
    `);

    this.insertEvent = this.database.prepare(`
      INSERT INTO events(
        source_id, event_id, timestamp, timestamp_ms, session_id, home_id, event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertQueryEvent = this.database.prepare(`
      INSERT INTO event_query(
        source_id, event_id, timestamp_ms, utc_day, session_id, home_id,
        model, channel, cwd, repository_key, total, input, cached, output, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#ensureQueryProjection();
  }

  #meta(key) {
    return this.database.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;
  }

  #setMeta(key, value) {
    this.database.prepare("UPDATE meta SET value = ? WHERE key = ?").run(value, key);
  }

  #revision() {
    return Number(this.#meta("revision"));
  }

  #context() {
    return parseJson(this.#meta("context"));
  }

  #contextRevision() {
    return Number(this.#meta("context_revision"));
  }

  #eventFilter(filters) {
    const conditions = [];
    const parameters = [];
    if (filters.startMs !== undefined) {
      conditions.push("timestamp_ms >= ?");
      parameters.push(filters.startMs);
    }
    if (filters.endMs !== undefined) {
      conditions.push("timestamp_ms <= ?");
      parameters.push(filters.endMs);
    }
    if (filters.excludeHomes?.length) {
      conditions.push(`home_id NOT IN (${filters.excludeHomes.map(() => "?").join(", ")})`);
      parameters.push(...filters.excludeHomes);
    }
    return {
      where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
      parameters,
    };
  }

  #currentEvents(filters) {
    const { where, parameters } = this.#eventFilter(filters);
    return this.database
      .prepare(
        `SELECT event_json
         FROM events
         ${where}
         ORDER BY timestamp COLLATE BINARY, source_id COLLATE BINARY, event_id COLLATE BINARY`,
      )
      .all(...parameters)
      .map((row) => parseJson(row.event_json));
  }

  #queryProjectionArgs(sourceId, event) {
    const timestampMs = Date.parse(event.timestamp);
    return [
      sourceId,
      event.eventId,
      timestampMs,
      new Date(timestampMs).toISOString().slice(0, 10),
      event.sessionId,
      event.homeId,
      projectionLabel(event.model, "Unknown model"),
      projectionLabel(event.channel, "Unknown channel"),
      projectionLabel(event.cwd, "Unknown cwd"),
      projectionLabel(event.repositoryKey, "Unknown repository"),
      event.total.total,
      event.total.input,
      event.total.cached,
      event.total.output,
      event.total.reasoning,
    ];
  }

  #ensureQueryProjection() {
    const version = this.database
      .prepare("SELECT value FROM meta WHERE key = 'query_projection_version'")
      .get()?.value;
    if (version === QUERY_PROJECTION_VERSION) {
      return;
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const currentVersion = this.database
        .prepare("SELECT value FROM meta WHERE key = 'query_projection_version'")
        .get()?.value;
      if (currentVersion !== QUERY_PROJECTION_VERSION) {
        this.database.exec("DELETE FROM event_query");
        const rows = this.database.prepare("SELECT source_id, event_id, event_json FROM events").all();
        for (const row of rows) {
          const event = parseJson(row.event_json);
          if (event.eventId !== row.event_id) {
            throw new Error(`Stored event identity mismatch for ${row.source_id}/${row.event_id}`);
          }
          this.insertQueryEvent.run(...this.#queryProjectionArgs(row.source_id, event));
        }
        this.database
          .prepare(
            `INSERT INTO meta(key, value) VALUES ('query_projection_version', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          )
          .run(QUERY_PROJECTION_VERSION);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  #readTransaction(callback) {
    this.database.exec("BEGIN");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  #sourceStates(since) {
    const filter = since === undefined ? "" : "WHERE sources.updated_revision > ?";
    const parameters = since === undefined ? [] : [since];
    const sources = this.database
      .prepare(
        `SELECT source_id, cursor_json
         FROM sources
         ${filter}
         ORDER BY source_id COLLATE BINARY`,
      )
      .all(...parameters)
      .map((row) => ({
        sourceId: row.source_id,
        events: [],
        cursor: parseJson(row.cursor_json),
      }));
    const bySource = new Map(sources.map((source) => [source.sourceId, source]));
    const events = this.database
      .prepare(
        `SELECT events.source_id, events.event_json
         FROM events
         JOIN sources ON sources.source_id = events.source_id
         ${filter}
         ORDER BY
           events.timestamp COLLATE BINARY,
           events.source_id COLLATE BINARY,
           events.event_id COLLATE BINARY`,
      )
      .all(...parameters);
    for (const row of events) {
      bySource.get(row.source_id)?.events.push(parseJson(row.event_json));
    }
    return sources;
  }

  status() {
    return {
      revision: this.#revision(),
      eventCount: Number(this.database.prepare("SELECT COUNT(*) AS count FROM events").get().count),
    };
  }

  getCursor(sourceId) {
    const row = this.database.prepare("SELECT cursor_json FROM sources WHERE source_id = ?").get(sourceId);
    return row ? parseJson(row.cursor_json) : null;
  }

  getCursors() {
    const rows = this.database
      .prepare("SELECT source_id, cursor_json FROM sources ORDER BY source_id COLLATE BINARY")
      .all();
    return Object.fromEntries(rows.map((row) => [row.source_id, parseJson(row.cursor_json)]));
  }

  cursorState() {
    return {
      revision: this.#revision(),
      cursors: this.getCursors(),
    };
  }

  changes({ since, snapshot, contextSince } = {}) {
    if (
      since !== undefined &&
      (!Number.isSafeInteger(since) || since < 0)
    ) {
      throw new InputError("since must be a non-negative safe integer");
    }
    if (
      snapshot !== undefined &&
      (!Number.isSafeInteger(snapshot) || snapshot < 0)
    ) {
      throw new InputError("snapshot must be a non-negative safe integer");
    }
    if (since !== undefined && snapshot !== undefined) {
      throw new InputError("since and snapshot cannot be combined");
    }
    if (
      contextSince !== undefined &&
      (!Number.isSafeInteger(contextSince) || contextSince < 0)
    ) {
      throw new InputError("contextSince must be a non-negative safe integer");
    }
    if (contextSince !== undefined && snapshot !== undefined) {
      throw new InputError("contextSince and snapshot cannot be combined");
    }

    if (snapshot !== undefined) {
      return this.#readTransaction(() => {
        const state = this.#snapshot(snapshot);
        if (!state) {
          throw new SnapshotNotFoundError(snapshot);
        }
        return {
          revision: snapshot,
          reset: true,
          sources: changesSnapshotSources(state, snapshot),
          context: state.context,
        };
      });
    }

    return this.#readTransaction(() => {
      const revision = this.#revision();
      if (since !== undefined && since > revision) {
        throw new InputError(`since ${since} is newer than current revision ${revision}`);
      }
      if (contextSince !== undefined && contextSince > revision) {
        throw new InputError(
          `contextSince ${contextSince} is newer than current revision ${revision}`,
        );
      }
      const result = {
        revision,
        reset: since === undefined,
        sources: this.#sourceStates(since),
      };
      if (
        result.reset ||
        contextSince === undefined ||
        this.#contextRevision() > contextSince
      ) {
        result.context = this.#context();
      }
      return result;
    });
  }

  commit(sourceId, events, cursor, context, options = {}) {
    validateCommitBody({ sourceId, events, cursor, ...(context !== undefined ? { context } : {}) });
    const expectedCursorProvided = Object.hasOwn(options, "expectedCursor");
    if (expectedCursorProvided && options.expectedCursor === undefined) {
      throw new InputError("expectedCursor cannot be undefined");
    }
    let nextRevision;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (expectedCursorProvided) {
        const existing = this.database
          .prepare("SELECT cursor_json FROM sources WHERE source_id = ?")
          .get(sourceId);
        const matches =
          options.expectedCursor === null
            ? !existing
            : Boolean(existing) && sameCursor(parseJson(existing.cursor_json), options.expectedCursor);
        if (!matches) {
          throw new CursorConflictError(sourceId);
        }
      }
      nextRevision = this.#revision() + 1;
      const contextJson = context === undefined ? undefined : JSON.stringify(context);
      this.database.prepare("DELETE FROM events WHERE source_id = ?").run(sourceId);
      for (const event of events) {
        this.insertEvent.run(
          sourceId,
          event.eventId,
          event.timestamp,
          Date.parse(event.timestamp),
          event.sessionId,
          event.homeId,
          JSON.stringify(event),
        );
        this.insertQueryEvent.run(...this.#queryProjectionArgs(sourceId, event));
      }
      this.database
        .prepare(
          `INSERT INTO sources(source_id, cursor_json, updated_revision)
           VALUES (?, ?, ?)
           ON CONFLICT(source_id) DO UPDATE SET
             cursor_json = excluded.cursor_json,
             updated_revision = excluded.updated_revision`,
        )
        .run(sourceId, JSON.stringify(cursor), nextRevision);
      if (contextJson !== undefined) {
        this.#setMeta("context", contextJson);
        this.#setMeta("context_revision", String(nextRevision));
      }
      this.#setMeta("revision", String(nextRevision));
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    return {
      revision: nextRevision,
      eventCount: events.length,
    };
  }

  #snapshot(snapshot) {
    const row = this.database.prepare("SELECT state_json FROM snapshots WHERE revision = ?").get(snapshot);
    return row ? normalizeSnapshot(parseJson(row.state_json)) : null;
  }

  #queryTotals(filters) {
    const { where, parameters } = this.#eventFilter(filters);
    const statement = this.database.prepare(`
      SELECT
        COUNT(*) AS event_count,
        COUNT(DISTINCT session_id) AS session_count,
        COUNT(DISTINCT home_id) AS home_count,
        COALESCE(SUM(input), 0) AS input,
        COALESCE(SUM(cached), 0) AS cached,
        COALESCE(SUM(output), 0) AS output,
        COALESCE(SUM(reasoning), 0) AS reasoning,
        COALESCE(SUM(total), 0) AS total
      FROM event_query
      ${where}
    `);
    statement.setReadBigInts(true);
    const row = statement.get(...parameters);
    return {
      eventCount: safeInteger(row.event_count),
      sessionCount: safeInteger(row.session_count),
      homeCount: safeInteger(row.home_count),
      totals: Object.fromEntries(
        USAGE_FIELDS.map((field) => [field, safeInteger(row[field])]),
      ),
    };
  }

  #queryGroups(filters, column) {
    const { where, parameters } = this.#eventFilter(filters);
    const statement = this.database.prepare(`
      SELECT
        ${column} AS name,
        COUNT(*) AS event_count,
        COUNT(DISTINCT session_id) AS session_count,
        COALESCE(SUM(input), 0) AS input,
        COALESCE(SUM(cached), 0) AS cached,
        COALESCE(SUM(output), 0) AS output,
        COALESCE(SUM(reasoning), 0) AS reasoning,
        COALESCE(SUM(total), 0) AS total
      FROM event_query
      ${where}
      GROUP BY ${column}
    `);
    statement.setReadBigInts(true);
    return statement
      .all(...parameters)
      .map((row) => ({
        name: row.name,
        count: safeInteger(row.event_count),
        sessions: safeInteger(row.session_count),
        total: Object.fromEntries(
          USAGE_FIELDS.map((field) => [field, safeInteger(row[field])]),
        ),
      }))
      .sort(
        (left, right) =>
          (left.total.total < right.total.total ? 1 : left.total.total > right.total.total ? -1 : 0) ||
          compareNames(left.name, right.name),
      );
  }

  #queryTimeline(filters) {
    const { where, parameters } = this.#eventFilter(filters);
    const statement = this.database.prepare(`
      SELECT
        utc_day AS name,
        COUNT(*) AS event_count,
        COUNT(DISTINCT session_id) AS session_count,
        COALESCE(SUM(input), 0) AS input,
        COALESCE(SUM(cached), 0) AS cached,
        COALESCE(SUM(output), 0) AS output,
        COALESCE(SUM(reasoning), 0) AS reasoning,
        COALESCE(SUM(total), 0) AS total
      FROM event_query
      ${where}
      GROUP BY utc_day
    `);
    statement.setReadBigInts(true);
    return statement
      .all(...parameters)
      .map((row) => ({
        name: row.name,
        count: safeInteger(row.event_count),
        sessions: safeInteger(row.session_count),
        total: Object.fromEntries(
          USAGE_FIELDS.map((field) => [field, safeInteger(row[field])]),
        ),
      }))
      .sort((left, right) => compareNames(left.name, right.name));
  }

  #typedQuery(filters) {
    try {
      const counts = this.#queryTotals(filters);
      return {
        ...counts,
        models: this.#queryGroups(filters, "model"),
        channels: this.#queryGroups(filters, "channel"),
        projects: this.#queryGroups(filters, "cwd"),
        repositories: this.#queryGroups(filters, "repository_key"),
        timeline: this.#queryTimeline(filters),
      };
    } catch (error) {
      if (error instanceof AggregateOverflowError) {
        throw error;
      }
      if (/integer overflow/i.test(error.message)) {
        throw new AggregateOverflowError();
      }
      throw error;
    }
  }

  report(filters = {}) {
    if (filters.snapshot !== undefined) {
      const state = this.#snapshot(filters.snapshot);
      if (!state) {
        throw new SnapshotNotFoundError(filters.snapshot);
      }
      return {
        revision: filters.snapshot,
        events: filterEvents(state.events, filters),
        context: state.context,
        cursors: state.cursors,
      };
    }

    return {
      revision: this.#revision(),
      events: this.#currentEvents(filters),
      context: this.#context(),
      cursors: this.getCursors(),
    };
  }

  query(filters = {}) {
    if (filters.snapshot !== undefined) {
      const report = this.report(filters);
      return {
        revision: report.revision,
        ...aggregateEvents(report.events),
      };
    }
    return {
      revision: this.#revision(),
      ...this.#typedQuery(filters),
    };
  }

  freeze() {
    let revision;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      revision = this.#revision();
      const state = {
        sources: this.#sourceStates(),
        context: this.#context(),
      };
      this.database
        .prepare(
          `INSERT INTO snapshots(revision, state_json, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT(revision) DO UPDATE SET
             state_json = excluded.state_json,
             created_at = excluded.created_at`,
        )
        .run(revision, JSON.stringify(state), new Date().toISOString());
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return revision;
  }

  close() {
    try {
      this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      this.database.close();
    }
  }
}
