import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  ensureUsageMetadataSchema,
  prepareStoredMetadata,
  readStoredMetadata,
  USAGE_METADATA_TABLE_NAMES,
} from "../src/usage-metadata-store.js";

function openDatabase(file = ":memory:", options) {
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      timestamp_ms INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      home_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      model TEXT NOT NULL
    );
  `);
  ensureUsageMetadataSchema(database, options);
  return database;
}

function seedEvents(database, count) {
  database
    .prepare(
      `WITH RECURSIVE sequence(n) AS (
         VALUES (1) UNION ALL SELECT n + 1 FROM sequence WHERE n < ?
       )
       INSERT INTO events
       SELECT n * 3 - 10, (n * 137) % 1000 - 100,
         CASE WHEN n % 7 = 0 THEN '' ELSE 's-' || (n % 113) END,
         CASE WHEN n % 5 = 0 THEN '' ELSE 'home-' || (n % 5) END,
         CASE WHEN n % 3 = 0 THEN ' CLI ' ELSE 'cli' END,
         CASE WHEN n % 11 = 0 THEN '' ELSE ' M-' || (n % 11) || ' ' END
       FROM sequence`,
    )
    .run(count);
}

function compareRows(left, right) {
  for (const column of ["channel", "model", "home_id"]) {
    if (left[column] !== right[column]) return left[column] < right[column] ? -1 : 1;
  }
  return 0;
}

// This small fixture oracle keeps the former per-event semantics independent of the SQL aggregates.
function expectedMetadata(database, asOfMs) {
  const events = database.prepare("SELECT * FROM events ORDER BY id").all();
  const sessions = new Set();
  const homes = new Map();
  const models = new Map();
  const observations = new Map();
  for (const event of events) {
    sessions.add(event.session_id);
    let home = homes.get(event.home_id);
    if (!home) {
      home = { eventCount: 0, sessions: new Set() };
      homes.set(event.home_id, home);
    }
    home.eventCount += 1;
    home.sessions.add(event.session_id);
    models.set(JSON.stringify([event.channel, event.model]), { channel: event.channel, model: event.model });
    if (event.timestamp_ms > asOfMs) continue;
    const key = JSON.stringify([event.channel, event.model, event.home_id]);
    const previous = observations.get(key);
    if (!previous || previous.last_seen < event.timestamp_ms) {
      observations.set(key, {
        channel: event.channel,
        model: event.model,
        home_id: event.home_id,
        last_seen: event.timestamp_ms,
      });
    }
  }
  return {
    eventCount: events.length,
    sessionCount: sessions.size,
    homeRows: new Map(
      [...homes].map(([id, home]) => [id, { event_count: home.eventCount, session_count: home.sessions.size }]),
    ),
    modelRows: [...models.values()].sort(compareRows),
    observationRows: [...observations.values()].sort(compareRows),
  };
}

function assertMetadata(database) {
  for (const asOfMs of [-101, -100, 0, 250, 500, 899, 1_000]) {
    assert.deepEqual(readStoredMetadata(database, asOfMs), expectedMetadata(database, asOfMs), `asOf=${asOfMs}`);
  }
}

function projectionSnapshot(database) {
  return USAGE_METADATA_TABLE_NAMES.map((table) => database.prepare(`SELECT * FROM ${table}`).all());
}

test("deferred schema stays read-only on repeat and default preparation builds its missing query index", () => {
  const database = openDatabase(":memory:", { deferIndex: true });
  const indexSql = "SELECT * FROM sqlite_master WHERE name = 'events_metadata_group_time_idx'";
  try {
    assert.equal(database.prepare(indexSql).get(), undefined);
    assert.equal(readStoredMetadata(database, 1_000), null);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger'").get().count, 4);
    assert.deepEqual(
      USAGE_METADATA_TABLE_NAMES.map((table) => database.prepare(`SELECT * FROM ${table}`).all().length),
      [1, 0, 0, 0, 0, 0, 0, 0],
    );
    const before = projectionSnapshot(database);
    const changes = database.prepare("SELECT total_changes() AS count").get().count;
    const schema = database.prepare("PRAGMA schema_version").get();
    database.exec("PRAGMA query_only = ON");
    assert.equal(ensureUsageMetadataSchema(database, { deferIndex: true }), true);
    assert.equal(ensureUsageMetadataSchema(database, { deferIndex: true }), true);
    assert.equal(readStoredMetadata(database, 1_000), null);
    database.exec("PRAGMA query_only = OFF");
    assert.deepEqual(projectionSnapshot(database), before);
    assert.equal(database.prepare("SELECT total_changes() AS count").get().count, changes);
    assert.deepEqual(database.prepare("PRAGMA schema_version").get(), schema);

    seedEvents(database, 2_050);
    const facts = database.prepare("SELECT * FROM events ORDER BY id").all();
    assert.equal(database.prepare(indexSql).get(), undefined);
    assert.equal(readStoredMetadata(database, 1_000), null);
    assert.deepEqual(prepareStoredMetadata(database), { readEvents: 2_050, rebuilt: true, reused: false });
    assert.equal(database.prepare(indexSql).get().tbl_name, "events");
    assert.deepEqual(
      database
        .prepare("SELECT name FROM pragma_index_info('events_metadata_group_time_idx') ORDER BY seqno")
        .all()
        .map((row) => row.name),
      ["home_id", "channel", "model", "timestamp_ms"],
    );
    assert.deepEqual(database.prepare("SELECT * FROM events ORDER BY id").all(), facts);
    assertMetadata(database);
    const ready = projectionSnapshot(database);
    const readyChanges = database.prepare("SELECT total_changes() AS count").get().count;
    const readySchema = database.prepare("PRAGMA schema_version").get();
    database.exec("PRAGMA query_only = ON");
    assert.equal(ensureUsageMetadataSchema(database), true);
    assert.equal(ensureUsageMetadataSchema(database, { deferIndex: false }), true);
    assert.equal(ensureUsageMetadataSchema(database, { deferIndex: true }), true);
    assertMetadata(database);
    assert.deepEqual(projectionSnapshot(database), ready);
    assert.equal(database.prepare("SELECT total_changes() AS count").get().count, readyChanges);
    assert.deepEqual(database.prepare("PRAGMA schema_version").get(), readySchema);
  } finally {
    database.close();
  }
});

test("deferring preserves existing indexes even when metadata tables need repair", () => {
  for (const wrongIndex of [false, true]) {
    const database = openDatabase();
    const exec = database.exec;
    try {
      seedEvents(database, 83);
      prepareStoredMetadata(database);
      if (wrongIndex) {
        database.exec(`DROP INDEX events_metadata_group_time_idx;
          CREATE INDEX events_metadata_group_time_idx ON events(timestamp_ms)`);
      }
      database.exec("DROP TABLE usage_metadata_format");
      const facts = database.prepare("SELECT * FROM events ORDER BY id").all();
      const indexSql = "SELECT * FROM sqlite_master WHERE name = 'events_metadata_group_time_idx'";
      const index = database.prepare(indexSql).get();
      database.exec = function (sql) {
        assert.doesNotMatch(sql, /(?:CREATE|DROP) INDEX/i);
        return exec.call(this, sql);
      };
      assert.equal(ensureUsageMetadataSchema(database, { deferIndex: true }), true);
      database.exec = exec;
      assert.deepEqual(database.prepare(indexSql).get(), index);
      assert.deepEqual(database.prepare("SELECT * FROM events ORDER BY id").all(), facts);
      assert.equal(readStoredMetadata(database, 1_000), null);
      assert.deepEqual(prepareStoredMetadata(database), { readEvents: 83, rebuilt: true, reused: false });
      assertMetadata(database);
    } finally {
      database.exec = exec;
      database.close();
    }
  }
});

test("failed deferred schema repair and index completion roll back without touching imported facts", () => {
  for (const outerTransaction of [false, true]) {
    for (const failIndex of [false, true]) {
      const database = openDatabase(":memory:", { deferIndex: true });
      const exec = database.exec;
      try {
        if (outerTransaction) database.exec("BEGIN");
        seedEvents(database, 83);
        if (!failIndex) database.exec("DROP TRIGGER usage_metadata_dirty_update");
        const facts = database.prepare("SELECT * FROM events ORDER BY id").all();
        const projection = projectionSnapshot(database);
        const schema = database.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
        const version = database.prepare("PRAGMA schema_version").get();
        database.exec = function (sql) {
          const result = exec.call(this, sql);
          if (failIndex ? /CREATE INDEX events_metadata_group_time_idx/.test(sql) : /^CREATE TRIGGER/.test(sql)) {
            throw new Error("schema setup failure");
          }
          return result;
        };
        assert.throws(() => ensureUsageMetadataSchema(database, { deferIndex: !failIndex }), /schema setup failure/);
        database.exec = exec;
        assert.equal(database.isTransaction, outerTransaction);
        assert.deepEqual(database.prepare("SELECT * FROM events ORDER BY id").all(), facts);
        assert.deepEqual(projectionSnapshot(database), projection);
        assert.deepEqual(database.prepare("SELECT * FROM sqlite_master ORDER BY name").all(), schema);
        assert.deepEqual(database.prepare("PRAGMA schema_version").get(), version);
        assert.equal(readStoredMetadata(database, 1_000), null);
        if (outerTransaction) database.exec("COMMIT");
        assert.deepEqual(prepareStoredMetadata(database), { readEvents: 83, rebuilt: true, reused: false });
        assertMetadata(database);
      } finally {
        database.exec = exec;
        database.close();
      }
    }
  }
});

test("default builds use five bounded SQL writes per batch and preserve exact append members", () => {
  const database = openDatabase();
  const prepare = database.prepare;
  try {
    seedEvents(database, 3_081);
    const reads = [];
    const writes = [];
    database.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      if (/^SELECT id, timestamp_ms\s+FROM events/.test(sql)) {
        const all = statement.all;
        statement.all = function (...args) {
          const rows = all.call(this, ...args);
          reads.push(rows.length);
          assert.ok(rows.length <= 1_024);
          for (const row of rows) assert.deepEqual(Object.keys(row), ["id", "timestamp_ms"]);
          return rows;
        };
      }
      if (/^INSERT(?: OR IGNORE)? INTO usage_metadata_(homes|sessions|home_sessions|models|observations)\b/.test(sql)) {
        const run = statement.run;
        statement.run = function (...args) {
          writes.push({ sql, args });
          return run.call(this, ...args);
        };
      }
      return statement;
    };
    const batches = [];
    assert.deepEqual(prepareStoredMetadata(database, { afterBatch: (batch) => batches.push(batch.processed) }), {
      readEvents: 3_081,
      rebuilt: true,
      reused: false,
    });
    database.prepare = prepare;
    assert.deepEqual(batches, [1_024, 1_024, 1_024, 9]);
    assert.deepEqual(reads, batches);
    assert.equal(writes.length, 20);
    for (const { sql, args } of writes) {
      const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args);
      assert.ok(
        plan.some((row) => /SEARCH events USING INTEGER PRIMARY KEY/.test(row.detail)),
        sql,
      );
      assert.ok(!plan.some((row) => /SCAN events/.test(row.detail)), sql);
    }
    assertMetadata(database);

    // Repeated new members, existing global members in a new home, and a late timestamp.
    database.exec(`
      INSERT INTO events VALUES
        (10000, 50, 'new-session', 'home-1', ' CLI ', ' M-1 '),
        (10001, 60, 'new-session', 'home-1', 'cli', ' M-1 '),
        (10002, 70, 'new-session', 'home-new', 'cli', ' M-1 '),
        (10003, 80, 's-1', 'home-new', 'cli', ' M-1 ');
    `);
    assert.deepEqual(prepareStoredMetadata(database), { readEvents: 4, rebuilt: false, reused: false });
    assert.equal(readStoredMetadata(database, 1_000).sessionCount, 115);
    assert.deepEqual(readStoredMetadata(database, 1_000).homeRows.get("home-new"), {
      event_count: 2,
      session_count: 2,
    });
    assertMetadata(database);
    database.exec("INSERT INTO events VALUES (10004, -90, 'new-session', 'home-new', 'cli', ' M-1 ')");
    assert.deepEqual(prepareStoredMetadata(database), { readEvents: 1, rebuilt: false, reused: false });
    assertMetadata(database);
  } finally {
    database.prepare = prepare;
    database.close();
  }
});

test("member deltas and future observations match the event oracle at different batch boundaries", () => {
  for (const batchSize of [1, 2, 7, 1_024]) {
    const database = openDatabase();
    try {
      seedEvents(database, 83);
      assert.deepEqual(prepareStoredMetadata(database, { batchSize }), {
        readEvents: 83,
        rebuilt: true,
        reused: false,
      });
      assertMetadata(database);
    } finally {
      database.close();
    }
  }
});

test("committed batches survive reopen and a failed bulk write rolls back every member and progress row", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-metadata-bulk-"));
  const file = path.join(root, "usage.sqlite");
  let database = openDatabase(file);
  try {
    seedEvents(database, 2_050);
    assert.throws(
      () =>
        prepareStoredMetadata(database, {
          afterBatch: () => {
            throw new Error("committed interruption");
          },
        }),
      /committed interruption/,
    );
    assert.equal(database.isTransaction, false);
    assert.equal(database.prepare("SELECT event_count FROM usage_metadata_state").get().event_count, 1_024);
    assert.equal(readStoredMetadata(database, 1_000), null);
    database.close();
    database = openDatabase(file);
    const before = projectionSnapshot(database);
    const prepare = database.prepare;
    database.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      if (/^INSERT INTO usage_metadata_observations/.test(sql)) {
        statement.run = () => {
          throw new Error("bulk write failure");
        };
      }
      return statement;
    };
    try {
      assert.throws(() => prepareStoredMetadata(database), /bulk write failure/);
    } finally {
      database.prepare = prepare;
    }
    assert.equal(database.isTransaction, false);
    assert.deepEqual(projectionSnapshot(database), before);
    assert.equal(readStoredMetadata(database, 1_000), null);
    assert.deepEqual(prepareStoredMetadata(database), { readEvents: 1_026, rebuilt: false, reused: false });
    assertMetadata(database);
    database.close();
    database = openDatabase(file);
    assert.deepEqual(prepareStoredMetadata(database), { readEvents: 0, rebuilt: false, reused: true });
    assertMetadata(database);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a mutation of committed history between batches restarts the build and retracts old members", () => {
  const database = openDatabase();
  try {
    seedEvents(database, 2_050);
    let changed = false;
    const work = prepareStoredMetadata(database, {
      afterBatch() {
        if (changed) return;
        changed = true;
        database.exec(`
          INSERT OR REPLACE INTO events VALUES (-7, 2000, 'replacement', 'replacement-home', 'new', 'model');
          UPDATE events SET session_id = 'revised', home_id = 'revised-home' WHERE id = -4;
          DELETE FROM events WHERE id = -1;
        `);
        assert.equal(readStoredMetadata(database, 1_000), null);
      },
    });
    assert.deepEqual(work, { readEvents: 3_073, rebuilt: true, reused: false });
    assertMetadata(database);
    const before = projectionSnapshot(database);
    database.exec("BEGIN; UPDATE events SET session_id = 'rolled-back' WHERE id = -7");
    assert.equal(readStoredMetadata(database, 1_000), null);
    database.exec("ROLLBACK");
    assert.deepEqual(projectionSnapshot(database), before);
    assert.deepEqual(prepareStoredMetadata(database), { readEvents: 0, rebuilt: false, reused: true });
  } finally {
    database.close();
  }
});

test("an invalid timestamp cannot commit a partially aggregated batch", () => {
  const database = openDatabase();
  try {
    seedEvents(database, 2_050);
    database.exec("UPDATE events SET timestamp_ms = 1.5 WHERE id = 5000");
    assert.throws(() => prepareStoredMetadata(database), /Invalid event row in metadata projection/);
    assert.equal(database.isTransaction, false);
    assert.equal(database.prepare("SELECT event_count FROM usage_metadata_state").get().event_count, 1_024);
    assert.equal(database.prepare("SELECT SUM(event_count) AS count FROM usage_metadata_homes").get().count, 1_024);
    assert.equal(readStoredMetadata(database, 1_000), null);
    database.exec("UPDATE events SET timestamp_ms = 50 WHERE id = 5000");
    assert.deepEqual(prepareStoredMetadata(database), { readEvents: 2_050, rebuilt: true, reused: false });
    assertMetadata(database);
  } finally {
    database.close();
  }
});
