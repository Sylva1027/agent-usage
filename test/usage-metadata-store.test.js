import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ensureUsageMetadataSchema, prepareStoredMetadata, readStoredMetadata } from "../src/usage-metadata-store.js";

const LEGACY_UPDATE_TRIGGER_SQL = `CREATE TRIGGER usage_metadata_dirty_update
  AFTER UPDATE ON events
  WHEN EXISTS (SELECT 1 FROM usage_metadata_state WHERE singleton = 1)
  BEGIN
    INSERT OR IGNORE INTO usage_metadata_dirty VALUES (1);
  END`;

function createSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      timestamp_ms INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      home_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      model TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS events_timestamp_idx ON events(timestamp_ms);
    CREATE TABLE IF NOT EXISTS usage_business_revision (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL
    ) STRICT;
    INSERT OR IGNORE INTO usage_business_revision VALUES (1, 0);
    CREATE TRIGGER IF NOT EXISTS usage_business_events_INSERT
    AFTER INSERT ON events BEGIN
      UPDATE usage_business_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS usage_business_events_UPDATE
    AFTER UPDATE ON events BEGIN
      UPDATE usage_business_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS usage_business_events_DELETE
    AFTER DELETE ON events BEGIN
      UPDATE usage_business_revision SET revision = revision + 1 WHERE singleton = 1;
    END;
  `);
  ensureUsageMetadataSchema(database);
}

function openDatabase(file) {
  const database = new DatabaseSync(file);
  database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  createSchema(database);
  return database;
}

function insertEvent(database, { id, timestamp, session, home, channel = "CLI", model = "gpt-test" }) {
  database
    .prepare(
      `INSERT INTO events(id, timestamp_ms, session_id, home_id, channel, model)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, timestamp, session, home, channel, model);
}

function insertAutoEvent(database, { timestamp, session, home, channel = "CLI", model = "gpt-test" }) {
  database
    .prepare(
      `INSERT INTO events(timestamp_ms, session_id, home_id, channel, model)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(timestamp, session, home, channel, model);
}

function replaceEvent(database, event) {
  database
    .prepare(
      `INSERT OR REPLACE INTO events(id, timestamp_ms, session_id, home_id, channel, model)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(event.id, event.timestamp, event.session, event.home, event.channel || "CLI", event.model || "gpt-test");
}

function seedEvents(database) {
  insertEvent(database, {
    id: 1,
    timestamp: 100,
    session: "shared",
    home: "home-a",
    channel: "raw-cli",
    model: "Model-A",
  });
  insertEvent(database, {
    id: 2,
    timestamp: 200,
    session: "home-only",
    home: "home-a",
    channel: "ZCode",
    model: " model-b ",
  });
  insertEvent(database, {
    id: 3,
    timestamp: 300,
    session: "shared",
    home: "home-b",
    channel: "raw-cli",
    model: "Model-A",
  });
}

function rawMetadata(database, asOfMs) {
  const rows = (sql, ...params) =>
    database
      .prepare(sql)
      .all(...params)
      .map((row) => ({ ...row }));
  const counts = database
    .prepare("SELECT COUNT(*) eventCount, COUNT(DISTINCT session_id) sessionCount FROM events")
    .get();
  return {
    ...counts,
    homeRows: new Map(
      rows(`SELECT home_id, COUNT(*) event_count, COUNT(DISTINCT session_id) session_count
        FROM events GROUP BY home_id ORDER BY home_id`).map(({ home_id, ...counts }) => [home_id, counts]),
    ),
    modelRows: rows("SELECT DISTINCT channel, model FROM events ORDER BY channel, model"),
    observationRows: rows(
      `SELECT channel, model, home_id, MAX(timestamp_ms) last_seen FROM events WHERE timestamp_ms <= ?
        GROUP BY channel, model, home_id ORDER BY channel, model, home_id`,
      asOfMs,
    ),
  };
}

test("an existing ordinary metadata seed keeps its exact legacy trigger and ensure performs no writes", () => {
  const database = new DatabaseSync(":memory:");
  try {
    createSchema(database);
    seedEvents(database);
    prepareStoredMetadata(database);
    database.exec(`DROP TRIGGER usage_metadata_dirty_update;
      ${LEGACY_UPDATE_TRIGGER_SQL};
      UPDATE usage_metadata_format SET schema_version = (SELECT schema_version FROM pragma_schema_version);
    `);
    const schema = () => database.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
    const beforeSchema = schema();
    const beforeFormat = database.prepare("SELECT * FROM usage_metadata_format").get();
    assert.equal(beforeFormat.version, 2);
    assert.deepEqual(readStoredMetadata(database, 1_000), rawMetadata(database, 1_000));
    const beforeChanges = database.prepare("SELECT total_changes() n").get().n;

    assert.equal(ensureUsageMetadataSchema(database), true);
    assert.equal(ensureUsageMetadataSchema(database, { deferIndex: true }), true);
    assert.equal(database.prepare("SELECT total_changes() n").get().n, beforeChanges);
    assert.deepEqual(schema(), beforeSchema);
    assert.deepEqual(database.prepare("SELECT * FROM usage_metadata_format").get(), beforeFormat);
    assert.deepEqual(prepareStoredMetadata(database), { readEvents: 0, rebuilt: false, reused: true });
    assert.deepEqual(readStoredMetadata(database, 1_000), rawMetadata(database, 1_000));
  } finally {
    database.close();
  }
});

test("ordinal reordering and unchanged metadata fields append only one event after schema recertification", () => {
  const database = new DatabaseSync(":memory:");
  try {
    createSchema(database);
    seedEvents(database);
    prepareStoredMetadata(database);
    assert.equal(
      database.prepare("SELECT sql FROM sqlite_master WHERE name='usage_metadata_dirty_update'").get().sql,
      LEGACY_UPDATE_TRIGGER_SQL,
    );
    database.exec("ALTER TABLE events ADD COLUMN history_ordinal INTEGER NOT NULL DEFAULT 0");
    assert.equal(readStoredMetadata(database, 1_000), null);
    ensureUsageMetadataSchema(database);
    assert.deepEqual(prepareStoredMetadata(database), { readEvents: 3, rebuilt: true, reused: false });

    database.exec(`BEGIN;
      UPDATE events SET history_ordinal = 1 WHERE timestamp_ms = 100;
      UPDATE events SET id=id, timestamp_ms=timestamp_ms, session_id=session_id,
        home_id=home_id, channel=channel, model=model;
    `);
    assert.equal(database.prepare("SELECT 1 FROM usage_metadata_dirty").get(), undefined);
    insertEvent(database, {
      id: 4,
      timestamp: 100,
      session: "shared",
      home: "home-b",
      channel: "raw-cli",
      model: "Model-A",
    });
    database.exec("COMMIT");

    assert.deepEqual(prepareStoredMetadata(database), { readEvents: 1, rebuilt: false, reused: false });
    for (const asOfMs of [50, 100, 200, 300, 1_000]) {
      assert.deepEqual(readStoredMetadata(database, asOfMs), rawMetadata(database, asOfMs));
    }
    assert.deepEqual(prepareStoredMetadata(database), { readEvents: 0, rebuilt: false, reused: true });
  } finally {
    database.close();
  }
});

for (const [column, value] of [
  ["id", 4],
  ["timestamp_ms", 400],
  ["session_id", "revised-session"],
  ["home_id", "revised-home"],
  ["channel", "revised-channel"],
  ["model", "revised-model"],
]) {
  test(`changing metadata field ${column} still dirties and rebuilds the projection`, () => {
    const database = new DatabaseSync(":memory:");
    try {
      createSchema(database);
      database.exec("ALTER TABLE events ADD COLUMN history_ordinal INTEGER NOT NULL DEFAULT 0");
      ensureUsageMetadataSchema(database);
      seedEvents(database);
      prepareStoredMetadata(database);
      database.prepare(`UPDATE events SET ${column}=? WHERE id=1`).run(value);
      assert.ok(database.prepare("SELECT 1 FROM usage_metadata_dirty").get());
      assert.equal(readStoredMetadata(database, 1_000), null);
      assert.deepEqual(prepareStoredMetadata(database), { readEvents: 3, rebuilt: true, reused: false });
      assert.deepEqual(readStoredMetadata(database, 1_000), rawMetadata(database, 1_000));
    } finally {
      database.close();
    }
  });
}

test("a fact revision without new ids retains the conservative metadata rebuild fallback", () => {
  const database = new DatabaseSync(":memory:");
  try {
    createSchema(database);
    database.exec(`ALTER TABLE events ADD COLUMN history_ordinal INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE events ADD COLUMN total INTEGER NOT NULL DEFAULT 0`);
    ensureUsageMetadataSchema(database);
    seedEvents(database);
    prepareStoredMetadata(database);
    database.exec("UPDATE events SET total=1 WHERE id=1");
    assert.equal(database.prepare("SELECT 1 FROM usage_metadata_dirty").get(), undefined);
    assert.equal(readStoredMetadata(database, 1_000), null);
    assert.deepEqual(prepareStoredMetadata(database), { readEvents: 3, rebuilt: true, reused: false });
    assert.deepEqual(readStoredMetadata(database, 1_000), rawMetadata(database, 1_000));
  } finally {
    database.close();
  }
});

test("metadata projection resumes bounded builds, appends one event, and reopens as a no-op", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-metadata-store-"));
  const file = path.join(root, "usage.sqlite");
  let database = openDatabase(file);
  try {
    seedEvents(database);
    assert.throws(
      () =>
        prepareStoredMetadata(database, {
          batchSize: 2,
          afterBatch() {
            throw new Error("stop after first batch");
          },
        }),
      /stop after first batch/,
    );
    assert.equal(Number(database.prepare("SELECT last_event_id FROM usage_metadata_state").get().last_event_id), 2);

    const schemaVersionBeforeReopen = Number(database.prepare("PRAGMA schema_version").get().schema_version);
    database.close();
    database = openDatabase(file);
    assert.equal(
      Number(database.prepare("PRAGMA schema_version").get().schema_version),
      schemaVersionBeforeReopen,
      "a normal reopen must not recreate metadata triggers",
    );
    const changesBeforeReadyEnsure = Number(database.prepare("SELECT total_changes() AS value").get().value);
    assert.equal(ensureUsageMetadataSchema(database), true);
    assert.equal(
      Number(database.prepare("SELECT total_changes() AS value").get().value),
      changesBeforeReadyEnsure,
      "a ready reopen must not perform a write",
    );
    const resumed = prepareStoredMetadata(database, { batchSize: 2 });
    assert.deepEqual(resumed, { readEvents: 1, rebuilt: false, reused: false });

    const built = readStoredMetadata(database, 1_000);
    assert.equal(built.eventCount, 3);
    assert.equal(built.sessionCount, 2);
    assert.deepEqual(Object.fromEntries(built.homeRows), {
      "home-a": { event_count: 2, session_count: 2 },
      "home-b": { event_count: 1, session_count: 1 },
    });
    assert.deepEqual(built.modelRows, [
      { channel: "ZCode", model: " model-b " },
      { channel: "raw-cli", model: "Model-A" },
    ]);

    assert.deepEqual(prepareStoredMetadata(database, { batchSize: 2 }), {
      readEvents: 0,
      rebuilt: false,
      reused: true,
    });

    insertAutoEvent(database, {
      timestamp: 400,
      session: "new-session",
      home: "home-a",
      channel: " MIXED ",
      model: " M ",
    });
    assert.deepEqual(prepareStoredMetadata(database, { batchSize: 2 }), {
      readEvents: 1,
      rebuilt: false,
      reused: false,
    });
    const appended = readStoredMetadata(database, 1_000);
    assert.equal(appended.eventCount, 4);
    assert.equal(appended.sessionCount, 3);
    assert.deepEqual(appended.homeRows.get("home-a"), { event_count: 3, session_count: 3 });
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("initial build includes negative safe event ids", () => {
  const database = new DatabaseSync(":memory:");
  try {
    createSchema(database);
    for (const id of [Number.MIN_SAFE_INTEGER, -100, Number.MAX_SAFE_INTEGER]) {
      insertEvent(database, {
        id,
        timestamp: 50,
        session: "negative",
        home: "home-a",
      });
    }
    assert.deepEqual(prepareStoredMetadata(database, { batchSize: 1 }), {
      readEvents: 3,
      rebuilt: true,
      reused: false,
    });
    assert.equal(readStoredMetadata(database, 1_000).eventCount, 3);
    assert.deepEqual(prepareStoredMetadata(database), { readEvents: 0, rebuilt: false, reused: true });
  } finally {
    database.close();
  }
});

test("ensure stays read-only when a complete schema is behind an external writer lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-metadata-store-"));
  const file = path.join(root, "usage.sqlite");
  const database = openDatabase(file);
  let reader;
  try {
    database.exec("BEGIN IMMEDIATE");
    reader = new DatabaseSync(file);
    reader.exec("PRAGMA busy_timeout = 25");
    assert.doesNotThrow(() => ensureUsageMetadataSchema(reader));
    assert.doesNotThrow(() => ensureUsageMetadataSchema(reader, { deferIndex: true }));
    database.exec("ROLLBACK");
  } finally {
    reader?.close();
    try {
      database.exec("ROLLBACK");
    } catch {
      // The transaction was already committed or rolled back.
    }
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("old-id updates, replacement, deletion, and uncommitted reads invalidate publication", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-metadata-store-"));
  const file = path.join(root, "usage.sqlite");
  const database = openDatabase(file);
  try {
    seedEvents(database);
    prepareStoredMetadata(database);

    database.exec("BEGIN");
    database.prepare("UPDATE events SET model = 'rolled-back' WHERE id = 1").run();
    assert.equal(readStoredMetadata(database, 1_000), null);
    assert.throws(() => prepareStoredMetadata(database), /unpinned writer/);
    database.exec("ROLLBACK");
    assert.ok(readStoredMetadata(database, 1_000));
    database.exec("SAVEPOINT metadata_history_read");
    try {
      assert.ok(readStoredMetadata(database, 1_000));
    } finally {
      database.exec("RELEASE metadata_history_read");
    }

    database.prepare("UPDATE events SET channel = 'changed', model = 'changed-model' WHERE id = 1").run();
    assert.equal(readStoredMetadata(database, 1_000), null);
    assert.deepEqual(prepareStoredMetadata(database), { readEvents: 3, rebuilt: true, reused: false });
    assert.deepEqual(readStoredMetadata(database, 1_000).modelRows, [
      { channel: "ZCode", model: " model-b " },
      { channel: "changed", model: "changed-model" },
      { channel: "raw-cli", model: "Model-A" },
    ]);

    replaceEvent(database, {
      id: 2,
      timestamp: 250,
      session: "replacement",
      home: "home-c",
      channel: "Replacement",
      model: "replacement-model",
    });
    assert.equal(readStoredMetadata(database, 1_000), null);
    assert.deepEqual(prepareStoredMetadata(database), { readEvents: 3, rebuilt: true, reused: false });
    assert.deepEqual(readStoredMetadata(database, 1_000).homeRows.get("home-c"), {
      event_count: 1,
      session_count: 1,
    });
    assert.deepEqual(readStoredMetadata(database, 1_000), rawMetadata(database, 1_000));

    database.prepare("DELETE FROM events WHERE id = 3").run();
    assert.deepEqual(prepareStoredMetadata(database), { readEvents: 2, rebuilt: true, reused: false });
    assert.equal(readStoredMetadata(database, 1_000).eventCount, 2);
    assert.deepEqual(readStoredMetadata(database, 1_000), rawMetadata(database, 1_000));
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("schema-version changes prevent reuse after a unique-index REPLACE loses its guard", () => {
  const database = new DatabaseSync(":memory:");
  try {
    createSchema(database);
    seedEvents(database);
    prepareStoredMetadata(database);

    database.exec("CREATE UNIQUE INDEX metadata_unique_timestamp_idx ON events(timestamp_ms)");
    assert.equal(readStoredMetadata(database, 1_000), null);
    database
      .prepare(
        `INSERT OR REPLACE INTO events(id, timestamp_ms, session_id, home_id, channel, model)
         VALUES (4, 100, 'unique-replacement', 'home-c', 'Replacement', 'replacement-model')`,
      )
      .run();
    database.exec("DROP INDEX metadata_unique_timestamp_idx");

    assert.equal(
      readStoredMetadata(database, 1_000),
      null,
      "removing the guard must not make the pre-REPLACE projection publishable",
    );
    assert.deepEqual(prepareStoredMetadata(database), { readEvents: 3, rebuilt: true, reused: false });
    const rebuilt = readStoredMetadata(database, 1_000);
    assert.equal(rebuilt.eventCount, 3);
    assert.deepEqual(rebuilt.homeRows.get("home-c"), { event_count: 1, session_count: 1 });
    assert.ok(rebuilt.modelRows.some((row) => row.channel === "Replacement" && row.model === "replacement-model"));
  } finally {
    database.close();
  }
});

test("observation rows honor asOf without mutating current maxima", () => {
  const database = new DatabaseSync(":memory:");
  try {
    createSchema(database);
    insertEvent(database, {
      id: 1,
      timestamp: 100,
      session: "s1",
      home: "home-a",
      channel: "same",
      model: "same",
    });
    insertEvent(database, {
      id: 2,
      timestamp: 300,
      session: "s2",
      home: "home-a",
      channel: "same",
      model: "same",
    });
    insertEvent(database, {
      id: 3,
      timestamp: 200,
      session: "s3",
      home: "home-b",
      channel: "other",
      model: "other",
    });
    prepareStoredMetadata(database);

    assert.deepEqual(readStoredMetadata(database, 250).observationRows, [
      { channel: "other", model: "other", home_id: "home-b", last_seen: 200 },
      { channel: "same", model: "same", home_id: "home-a", last_seen: 100 },
    ]);
    assert.deepEqual(readStoredMetadata(database, 50).observationRows, []);
    assert.deepEqual(readStoredMetadata(database, 300).observationRows, [
      { channel: "other", model: "other", home_id: "home-b", last_seen: 200 },
      { channel: "same", model: "same", home_id: "home-a", last_seen: 300 },
    ]);
  } finally {
    database.close();
  }
});

test("append detection does not depend on a legacy writer's revision triggers", () => {
  const database = new DatabaseSync(":memory:");
  try {
    createSchema(database);
    seedEvents(database);
    database.exec(`
      DROP TRIGGER usage_business_events_INSERT;
      DROP TRIGGER usage_business_events_UPDATE;
      DROP TRIGGER usage_business_events_DELETE;
    `);
    prepareStoredMetadata(database);
    const revision = Number(database.prepare("SELECT revision FROM usage_business_revision").get().revision);
    insertEvent(database, {
      id: 4,
      timestamp: 400,
      session: "legacy",
      home: "home-a",
    });
    assert.equal(Number(database.prepare("SELECT revision FROM usage_business_revision").get().revision), revision);
    assert.deepEqual(prepareStoredMetadata(database), { readEvents: 1, rebuilt: false, reused: false });
    assert.equal(readStoredMetadata(database, 1_000).eventCount, 4);
  } finally {
    database.close();
  }
});

test("repairing a missing metadata trigger marks the projection dirty", () => {
  const database = new DatabaseSync(":memory:");
  try {
    createSchema(database);
    seedEvents(database);
    prepareStoredMetadata(database);
    database.exec("DROP TRIGGER usage_metadata_dirty_update");
    ensureUsageMetadataSchema(database);
    assert.ok(database.prepare("SELECT 1 FROM usage_metadata_dirty").get());
    assert.equal(readStoredMetadata(database, 1_000), null);
    assert.deepEqual(prepareStoredMetadata(database), { readEvents: 3, rebuilt: true, reused: false });
    assert.equal(readStoredMetadata(database, 1_000).eventCount, 3);
  } finally {
    database.close();
  }
});

test("same-name no-op triggers and wrong index definitions are repaired", () => {
  const database = new DatabaseSync(":memory:");
  try {
    createSchema(database);
    seedEvents(database);
    prepareStoredMetadata(database);
    database.exec(`
      DROP TRIGGER usage_metadata_dirty_update;
      CREATE TRIGGER usage_metadata_dirty_update
      AFTER UPDATE ON events
      BEGIN
        SELECT 1;
      END;
      DROP INDEX events_metadata_group_time_idx;
      CREATE INDEX events_metadata_group_time_idx ON events(timestamp_ms);
    `);

    assert.equal(readStoredMetadata(database, 1_000), null);
    assert.equal(ensureUsageMetadataSchema(database), true);
    const trigger = database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'usage_metadata_dirty_update'")
      .get();
    assert.match(trigger.sql, /INSERT OR IGNORE INTO usage_metadata_dirty/i);
    assert.deepEqual(
      database
        .prepare("SELECT name FROM pragma_index_info('events_metadata_group_time_idx') ORDER BY seqno")
        .all()
        .map((row) => row.name),
      ["home_id", "channel", "model", "timestamp_ms"],
    );
    assert.ok(database.prepare("SELECT 1 FROM usage_metadata_dirty").get());
    assert.equal(readStoredMetadata(database, 1_000), null);

    prepareStoredMetadata(database);
    database.prepare("UPDATE events SET model = 'after-repair' WHERE id = 1").run();
    assert.equal(readStoredMetadata(database, 1_000), null);
    assert.equal(prepareStoredMetadata(database).rebuilt, true);
    assert.ok(readStoredMetadata(database, 1_000).modelRows.some((row) => row.model === "after-repair"));
  } finally {
    database.close();
  }
});
