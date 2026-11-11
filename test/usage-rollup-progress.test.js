import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  USAGE_ROLLUP_PROGRESS_TABLES,
  checkpointUsageRollups,
  createUsageRollups,
  ensureUsageRollupProgressSchema,
  listDirtyUsageRollupDays,
  localUsageRollupDaysForUtcDays,
  queryUsageRollupModelsWindow,
  queryUsageRollupRepositoriesWindow,
  queryUsageRollupsRange,
  rebuildUsageRollups,
  tryAppendUsageRollups,
} from "../src/usage-rollups.js";

const CURRENT_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || `offset:${new Date().getTimezoneOffset()}`;

function openDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), "usage-rollup-progress-"));
  const db = new DatabaseSync(path.join(directory, "index.sqlite"));
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY,
      timestamp_ms INTEGER NOT NULL,
      day_key TEXT NOT NULL,
      home_id TEXT NOT NULL,
      model TEXT NOT NULL,
      session_id TEXT,
      cwd TEXT NOT NULL DEFAULT '',
      repository_key TEXT NOT NULL DEFAULT 'unknown:cwd',
      repository_path TEXT NOT NULL DEFAULT 'Unknown cwd',
      repository_kind TEXT NOT NULL DEFAULT 'unknown',
      detail_mask INTEGER NOT NULL DEFAULT 0,
      reconciliation_gap INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL,
      input INTEGER NOT NULL,
      cached INTEGER NOT NULL,
      output INTEGER NOT NULL,
      reasoning INTEGER NOT NULL
    ) STRICT
  `);
  return { db, directory };
}

function insertEvent(db, event, id) {
  const timestampMs = Date.parse(event.timestamp);
  const result = db
    .prepare(`
    INSERT INTO events (
      ${id === undefined ? "" : "id,"}
      timestamp_ms, day_key, home_id, model, session_id, cwd, repository_key, repository_path, repository_kind,
      detail_mask, reconciliation_gap, total, input, cached, output, reasoning
    ) VALUES (
      ${id === undefined ? "" : "?,"}
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `)
    .run(
      ...(id === undefined ? [] : [id]),
      timestampMs,
      new Date(timestampMs).toISOString().slice(0, 10),
      event.homeId || "home-a",
      event.model || "gpt-6-sol",
      event.sessionId ?? null,
      event.cwd || "",
      event.repositoryKey || "unknown:cwd",
      event.repositoryPath || "Unknown cwd",
      event.repositoryKind || "unknown",
      event.detailMask ?? 0,
      event.reconciliationGap || 0,
      event.total,
      event.input || 0,
      event.cached || 0,
      event.output || 0,
      event.reasoning || 0,
    );
  return Number(result.lastInsertRowid);
}

function repairDirty(db) {
  const dirty = listDirtyUsageRollupDays(db);
  if (dirty.length > 0) rebuildUsageRollups(db, { days: dirty, calendarZone: "utc" });
  const localDays = localUsageRollupDaysForUtcDays(dirty);
  if (localDays.length > 0) rebuildUsageRollups(db, { days: localDays, calendarZone: "local" });
}

function seedAndCertify(db, events) {
  for (const event of events) insertEvent(db, event);
  createUsageRollups(db);
  repairDirty(db);
  const checkpoint = checkpointUsageRollups(db, { zoneIdentity: CURRENT_ZONE });
  assert.equal(checkpoint.certified, true);
  return checkpoint;
}

function snapshotRollups(db) {
  return Object.fromEntries(
    [
      "usage_rollup_days",
      "usage_rollup_daily",
      "usage_rollup_models",
      "usage_rollup_repositories",
      "usage_rollup_sessions",
    ].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2, 3`).all()]),
  );
}

function snapshotProgress(db) {
  return {
    progress: db.prepare("SELECT * FROM usage_rollup_progress ORDER BY singleton").all(),
    days: db.prepare("SELECT * FROM usage_rollup_progress_days ORDER BY calendar_zone, day_key").all(),
    dirty: db.prepare("SELECT * FROM usage_rollup_dirty_days ORDER BY day_key").all(),
  };
}

function seedDetailEvent(timestamp, overrides = {}) {
  return {
    timestamp,
    homeId: "home-a",
    model: "gpt-6-sol",
    sessionId: `session-${timestamp}`,
    cwd: "/repo/z",
    repositoryKey: "git:repo",
    repositoryPath: "repo/z",
    repositoryKind: "git",
    detailMask: 15,
    reconciliationGap: 0,
    total: 10,
    input: 7,
    cached: 2,
    output: 3,
    reasoning: 1,
    ...overrides,
  };
}

test("model and repository windows reuse every certified run and read only uncovered gaps", () => {
  const { db, directory } = openDatabase();
  try {
    seedAndCertify(
      db,
      [12, 14, 20].map((day) => seedDetailEvent(`2026-07-${day}T01:00:00.000Z`)),
    );
    db.exec("DELETE FROM usage_rollup_days WHERE day_key NOT IN ('2026-07-12','2026-07-14','2026-07-20')");
    const original = db.prepare.bind(db),
      rawModels = [],
      rawRepositories = [];
    db.prepare = (sql) => {
      const statement = original(sql);
      const text = String(sql);
      if (!text.includes("FROM events") || !text.includes("GROUP BY")) return statement;
      return {
        all(...params) {
          if (text.includes("WITH parts")) rawRepositories.push(params.filter(Number.isSafeInteger));
          else rawModels.push(params);
          return statement.all(...params);
        },
      };
    };
    const window = { startMs: Date.parse("2026-07-12T00:00:00Z"), endMs: Date.parse("2026-07-21T00:00:00Z") };
    try {
      assert.equal(queryUsageRollupModelsWindow(db, window)[0].total, 30);
      assert.equal(queryUsageRollupRepositoriesWindow(db, window)[0].total, 30);
    } finally {
      db.prepare = original;
    }
    const gaps = [
      [13, 14],
      [15, 20],
    ].map((days) => days.map((day) => Date.parse(`2026-07-${day}T00:00:00Z`)));
    assert.deepEqual(rawModels, gaps);
    assert.deepEqual(rawRepositories, [gaps.flat()]);
    db.exec("UPDATE events SET total=50 WHERE id=2");
    assert.equal(queryUsageRollupModelsWindow(db, window)[0].total, 70);
    assert.equal(queryUsageRollupRepositoriesWindow(db, window)[0].total, 70);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ordinary append consumes one id and updates all rollup tables without deleting a day", () => {
  const { db, directory } = openDatabase();
  try {
    seedAndCertify(db, [
      seedDetailEvent("2026-07-12T01:00:00.000Z", { sessionId: "seed-a" }),
      seedDetailEvent("2026-07-12T02:00:00.000Z", {
        homeId: "home-b",
        sessionId: "seed-b",
        cwd: "/repo/a",
        repositoryPath: "repo/a",
        repositoryKind: "directory",
        detailMask: 0,
        reconciliationGap: 2,
      }),
    ]);
    insertEvent(
      db,
      seedDetailEvent("2026-07-12T03:00:00.000Z", {
        model: "gpt-6-luna",
        sessionId: "append",
        cwd: "/repo/a",
        repositoryPath: "repo/aa",
        repositoryKind: "git",
        total: 20,
        input: 12,
        cached: 4,
        output: 8,
        reasoning: 2,
      }),
    );

    for (const table of [
      "usage_rollup_daily",
      "usage_rollup_models",
      "usage_rollup_repositories",
      "usage_rollup_sessions",
    ]) {
      db.exec(`
        CREATE TEMP TRIGGER reject_${table}_delete
        BEFORE DELETE ON ${table}
        BEGIN
          SELECT RAISE(ABORT, 'incremental append must not rebuild ${table}');
        END
      `);
    }
    const prepare = db.prepare;
    let fullDayReads = 0;
    db.prepare = function (sql) {
      const text = String(sql);
      if (text.includes("FROM events") && text.includes("timestamp_ms >=") && !text.includes("id <=")) {
        fullDayReads += 1;
      }
      return prepare.call(this, sql);
    };
    let append;
    try {
      append = tryAppendUsageRollups(db, { zoneIdentity: CURRENT_ZONE });
    } finally {
      db.prepare = prepare;
    }
    assert.deepEqual(append, { applied: true, readEvents: 1, lastId: append.lastId });
    assert.equal(fullDayReads, 0, "an existing complete day must use progress rows instead of scanning the day");
    assert.deepEqual(listDirtyUsageRollupDays(db), []);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM usage_rollup_days WHERE day_key = '2026-07-12'").get().count,
      2,
    );

    const actual = snapshotRollups(db);
    for (const table of [
      "usage_rollup_daily",
      "usage_rollup_models",
      "usage_rollup_repositories",
      "usage_rollup_sessions",
    ]) {
      db.exec(`DROP TRIGGER reject_${table}_delete`);
    }
    rebuildUsageRollups(db, { days: ["2026-07-12"], calendarZone: "utc" });
    rebuildUsageRollups(db, {
      days: localUsageRollupDaysForUtcDays(["2026-07-12"]),
      calendarZone: "local",
    });
    assert.deepEqual(actual, snapshotRollups(db), "incremental rows must match full-day repair");
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("update, delete, and REPLACE revoke certification and return to dirty-day repair", () => {
  const { db, directory } = openDatabase();
  try {
    const firstId = seedAndCertify(db, [
      seedDetailEvent("2026-07-12T01:00:00.000Z", { sessionId: "revise-a" }),
      seedDetailEvent("2026-07-12T02:00:00.000Z", { sessionId: "revise-b", total: 20 }),
    ]).lastId;
    assert.equal(firstId, 2);

    db.prepare("UPDATE events SET total = 50, input = 40 WHERE id = 1").run();
    assert.deepEqual(tryAppendUsageRollups(db, { zoneIdentity: CURRENT_ZONE }), {
      applied: false,
      readEvents: 0,
      reason: "ROLLUP_PROGRESS_NOT_CERTIFIED",
    });
    assert.deepEqual(listDirtyUsageRollupDays(db), ["2026-07-12"]);
    repairDirty(db);
    assert.equal(checkpointUsageRollups(db, { zoneIdentity: CURRENT_ZONE }).certified, true);
    assert.equal(queryUsageRollupsRange(db, { startDay: "2026-07-12", endDay: "2026-07-12" }).total, 70);

    db.prepare("DELETE FROM events WHERE id = 2").run();
    assert.equal(tryAppendUsageRollups(db, { zoneIdentity: CURRENT_ZONE }).applied, false);
    repairDirty(db);
    assert.equal(checkpointUsageRollups(db, { zoneIdentity: CURRENT_ZONE }).certified, true);
    assert.equal(queryUsageRollupsRange(db, { startDay: "2026-07-12", endDay: "2026-07-12" }).eventCount, 1);

    insertEvent(
      db,
      seedDetailEvent("2026-07-12T03:00:00.000Z", {
        sessionId: "replace-seed",
        total: 20,
      }),
      2,
    );
    assert.equal(tryAppendUsageRollups(db, { zoneIdentity: CURRENT_ZONE }).applied, true);

    db.prepare(`
      INSERT OR REPLACE INTO events (
        id, timestamp_ms, day_key, home_id, model, session_id, cwd, repository_key, repository_path,
        repository_kind, detail_mask, reconciliation_gap, total, input, cached, output, reasoning
      ) VALUES (2, ?, '2026-07-12', 'home-a', 'gpt-6-sol', 'replace', '/repo', 'git:replace',
        'repo/replace', 'git', 15, 0, 30, 20, 5, 10, 5)
    `).run(Date.parse("2026-07-12T04:00:00.000Z"));
    assert.equal(tryAppendUsageRollups(db, { zoneIdentity: CURRENT_ZONE }).applied, false);
    repairDirty(db);
    assert.equal(checkpointUsageRollups(db, { zoneIdentity: CURRENT_ZONE }).certified, true);
    assert.deepEqual(
      (() => {
        const row = queryUsageRollupsRange(db, { startDay: "2026-07-12", endDay: "2026-07-12" });
        return { eventCount: row.eventCount, total: row.total };
      })(),
      { eventCount: 2, total: 80 },
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cross-day explicit-id REPLACE dirties the old UTC day and does not double count", () => {
  const { db, directory } = openDatabase();
  try {
    seedAndCertify(db, [seedDetailEvent("2026-07-12T23:30:00.000Z", { sessionId: "cross-day", total: 10 })]);
    db.exec("PRAGMA recursive_triggers = OFF");
    db.prepare(`
      INSERT OR REPLACE INTO events (
        id, timestamp_ms, day_key, home_id, model, session_id, cwd, repository_key, repository_path,
        repository_kind, detail_mask, reconciliation_gap, total, input, cached, output, reasoning
      ) VALUES (1, ?, '2026-07-13', 'home-a', 'gpt-6-sol', 'cross-day', '/repo/z', 'git:repo',
        'repo/z', 'git', 15, 0, 30, 21, 6, 9, 3)
    `).run(Date.parse("2026-07-13T01:30:00.000Z"));

    assert.deepEqual(listDirtyUsageRollupDays(db), ["2026-07-12", "2026-07-13"]);
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM usage_rollup_days WHERE calendar_zone = 'utc' AND day_key IN ('2026-07-12', '2026-07-13')",
        )
        .get().count,
      0,
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM usage_rollup_days WHERE calendar_zone = 'local' AND day_key = '2026-07-13'",
        )
        .get().count,
      0,
    );
    assert.equal(tryAppendUsageRollups(db, { zoneIdentity: CURRENT_ZONE }).applied, false);
    repairDirty(db);
    assert.equal(checkpointUsageRollups(db, { zoneIdentity: CURRENT_ZONE }).certified, true);
    assert.deepEqual(
      (() => {
        const row = queryUsageRollupsRange(db, { startDay: "2026-07-12", endDay: "2026-07-13" });
        return { eventCount: row.eventCount, total: row.total };
      })(),
      { eventCount: 1, total: 30 },
    );
    assert.equal(queryUsageRollupsRange(db, { startDay: "2026-07-12", endDay: "2026-07-12" }).eventCount, 0);
    assert.equal(queryUsageRollupsRange(db, { startDay: "2026-07-13", endDay: "2026-07-13" }).total, 30);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a local proof failure leaves every rollup, progress row, progress day, and dirty day unchanged", () => {
  const { db, directory } = openDatabase();
  try {
    seedAndCertify(db, [seedDetailEvent("2026-07-12T01:00:00.000Z", { sessionId: "seed" })]);
    insertEvent(db, seedDetailEvent("2026-07-12T03:00:00.000Z", { sessionId: "append" }));
    db.prepare("DELETE FROM usage_rollup_progress_days WHERE calendar_zone = 'local'").run();
    const rollupsBefore = snapshotRollups(db);
    const progressBefore = snapshotProgress(db);

    assert.deepEqual(tryAppendUsageRollups(db, { zoneIdentity: CURRENT_ZONE }), {
      applied: false,
      readEvents: 1,
      reason: "ROLLUP_DAY_INCOMPLETE",
    });
    assert.deepEqual(snapshotRollups(db), rollupsBefore);
    assert.deepEqual(snapshotProgress(db), progressBefore);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an explicit old-id gap insert is rejected only after SQLite resolves NEW.id", () => {
  const { db, directory } = openDatabase();
  try {
    insertEvent(db, seedDetailEvent("2026-07-12T01:00:00.000Z", { sessionId: "id-one" }), 1);
    insertEvent(db, seedDetailEvent("2026-07-12T03:00:00.000Z", { sessionId: "id-three" }), 3);
    createUsageRollups(db);
    repairDirty(db);
    assert.equal(checkpointUsageRollups(db, { zoneIdentity: CURRENT_ZONE }).lastId, 3);

    insertEvent(db, seedDetailEvent("2026-07-12T02:00:00.000Z", { sessionId: "backfilled-id" }), 2);
    assert.deepEqual(tryAppendUsageRollups(db, { zoneIdentity: CURRENT_ZONE }), {
      applied: false,
      readEvents: 0,
      reason: "ROLLUP_PROGRESS_NOT_CERTIFIED",
    });
    assert.deepEqual(listDirtyUsageRollupDays(db), ["2026-07-12"]);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("checkpoint recovers missing and wrong core invalidation triggers from current facts", () => {
  for (const corrupt of [
    (db) => db.exec("DROP TRIGGER usage_rollup_invalidate_update"),
    (db) =>
      db.exec(`
        DROP TRIGGER usage_rollup_invalidate_update;
        CREATE TRIGGER usage_rollup_invalidate_update
        AFTER UPDATE ON events
        BEGIN
          SELECT 1;
        END;
      `),
  ]) {
    const { db, directory } = openDatabase();
    try {
      seedAndCertify(db, [seedDetailEvent("2026-07-12T01:00:00.000Z", { sessionId: "trigger-loss", total: 10 })]);
      corrupt(db);
      db.prepare("UPDATE events SET total = 99, input = 70 WHERE id = 1").run();

      assert.deepEqual(checkpointUsageRollups(db, { zoneIdentity: CURRENT_ZONE }), {
        applied: false,
        certified: false,
        reason: "ROLLUP_DIRTY_DAYS",
      });
      assert.deepEqual(listDirtyUsageRollupDays(db), ["2026-07-12"]);
      assert.equal(Number(db.prepare("SELECT certified FROM usage_rollup_progress").get().certified), 0);
      assert.equal(Number(db.prepare("SELECT last_id FROM usage_rollup_progress").get().last_id), 0);

      repairDirty(db);
      assert.equal(checkpointUsageRollups(db, { zoneIdentity: CURRENT_ZONE }).certified, true);
      assert.equal(queryUsageRollupsRange(db, { startDay: "2026-07-12", endDay: "2026-07-12" }).total, 99);
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("checkpoint repairs markers and empty gaps, append survives marker deletion and restart", () => {
  const { db, directory } = openDatabase();
  const databaseFile = path.join(directory, "index.sqlite");
  try {
    seedAndCertify(db, [seedDetailEvent("2026-07-12T01:00:00.000Z"), seedDetailEvent("2026-07-14T01:00:00.000Z")]);
    assert.deepEqual(USAGE_ROLLUP_PROGRESS_TABLES, ["usage_rollup_progress", "usage_rollup_progress_days"]);
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM usage_rollup_progress_days WHERE calendar_zone = 'utc' AND day_key = '2026-07-13'",
        )
        .get().count,
      1,
    );

    db.prepare("DELETE FROM usage_rollup_days WHERE calendar_zone = 'utc' AND day_key = '2026-07-12'").run();
    const checkpoint = checkpointUsageRollups(db, { zoneIdentity: CURRENT_ZONE });
    assert.ok(checkpoint.repairedDays.includes("utc\u00002026-07-12"));
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM usage_rollup_days WHERE calendar_zone = 'utc' AND day_key = '2026-07-12'",
        )
        .get().count,
      1,
    );
    db.prepare(
      "UPDATE usage_rollup_days SET start_ms = start_ms - 1 WHERE calendar_zone = 'utc' AND day_key = '2026-07-12'",
    ).run();
    assert.ok(
      checkpointUsageRollups(db, { zoneIdentity: CURRENT_ZONE }).repairedDays.includes("utc\u00002026-07-12"),
      "an incomplete marker must be repaired before certification",
    );

    db.prepare("DELETE FROM usage_rollup_days WHERE calendar_zone = 'utc' AND day_key = '2026-07-12'").run();
    insertEvent(db, seedDetailEvent("2026-07-12T03:00:00.000Z", { sessionId: "marker-deleted" }));
    assert.equal(tryAppendUsageRollups(db, { zoneIdentity: CURRENT_ZONE }).applied, true);
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM usage_rollup_days WHERE calendar_zone = 'utc' AND day_key = '2026-07-12'",
        )
        .get().count,
      1,
    );

    const writer = new DatabaseSync(databaseFile);
    try {
      insertEvent(writer, seedDetailEvent("2026-07-12T03:30:00.000Z", { sessionId: "other-connection" }));
    } finally {
      writer.close();
    }
    assert.deepEqual(listDirtyUsageRollupDays(db), ["2026-07-12"]);
    assert.equal(tryAppendUsageRollups(db, { zoneIdentity: CURRENT_ZONE }).applied, true);

    db.close();
    const reopened = new DatabaseSync(databaseFile);
    try {
      insertEvent(reopened, seedDetailEvent("2026-07-12T04:00:00.000Z", { sessionId: "after-restart" }));
      assert.equal(tryAppendUsageRollups(reopened, { zoneIdentity: CURRENT_ZONE }).applied, true);
      reopened.prepare("UPDATE usage_rollup_format SET format_version = 7").run();
      assert.deepEqual(tryAppendUsageRollups(reopened, { zoneIdentity: CURRENT_ZONE }), {
        applied: false,
        readEvents: 0,
        reason: "ROLLUP_FORMAT",
      });
    } finally {
      reopened.close();
    }
  } finally {
    try {
      db.close();
    } catch {
      // Already closed for the restart phase.
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("append failure rolls back every rollup, marker, dirty clear, and progress advance", () => {
  const { db, directory } = openDatabase();
  try {
    seedAndCertify(db, [seedDetailEvent("2026-07-12T01:00:00.000Z")]);
    const before = snapshotRollups(db);
    delete before.usage_rollup_days;
    const lastId = Number(db.prepare("SELECT last_id FROM usage_rollup_progress").get().last_id);

    db.exec("BEGIN");
    insertEvent(db, seedDetailEvent("2026-07-12T01:30:00.000Z", { sessionId: "outer-rollback" }));
    assert.equal(tryAppendUsageRollups(db, { zoneIdentity: CURRENT_ZONE }).applied, true);
    assert.deepEqual(listDirtyUsageRollupDays(db), []);
    db.exec("ROLLBACK");
    const afterOuterRollback = snapshotRollups(db);
    delete afterOuterRollback.usage_rollup_days;
    assert.deepEqual(afterOuterRollback, before);
    assert.equal(Number(db.prepare("SELECT last_id FROM usage_rollup_progress").get().last_id), lastId);
    assert.deepEqual(listDirtyUsageRollupDays(db), []);

    insertEvent(db, seedDetailEvent("2026-07-12T02:00:00.000Z", { sessionId: "failing-append" }));
    db.exec(`
      CREATE TEMP TRIGGER fail_incremental_model
      BEFORE INSERT ON usage_rollup_models
      BEGIN
        SELECT RAISE(ABORT, 'injected incremental failure');
      END
    `);
    assert.throws(() => tryAppendUsageRollups(db, { zoneIdentity: CURRENT_ZONE }), /injected incremental failure/);
    const after = snapshotRollups(db);
    delete after.usage_rollup_days;
    assert.deepEqual(after, before);
    assert.equal(Number(db.prepare("SELECT last_id FROM usage_rollup_progress").get().last_id), lastId);
    assert.deepEqual(listDirtyUsageRollupDays(db), ["2026-07-12"]);

    db.exec("DROP TRIGGER fail_incremental_model");
    assert.equal(tryAppendUsageRollups(db, { zoneIdentity: CURRENT_ZONE }).applied, true);
    assert.deepEqual(listDirtyUsageRollupDays(db), []);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("progress schema readiness is read-only and partial triggers recover atomically", () => {
  const { db, directory } = openDatabase();
  const databaseFile = path.join(directory, "index.sqlite");
  let reader;
  let writer;
  try {
    seedAndCertify(db, [seedDetailEvent("2026-07-12T01:00:00.000Z")]);
    const staleCursor = Number(db.prepare("SELECT last_id FROM usage_rollup_progress").get().last_id);
    insertEvent(db, seedDetailEvent("2026-07-12T02:00:00.000Z", { sessionId: "repaired-after-fallback" }));
    repairDirty(db);
    assert.equal(Number(db.prepare("SELECT last_id FROM usage_rollup_progress").get().last_id), staleCursor);
    assert.equal(Number(db.prepare("SELECT certified FROM usage_rollup_progress").get().certified), 1);
    const schemaVersion = Number(db.prepare("PRAGMA schema_version").get().schema_version);
    assert.equal(ensureUsageRollupProgressSchema(db), true);
    createUsageRollups(db);
    assert.equal(ensureUsageRollupProgressSchema(db), true);
    assert.equal(Number(db.prepare("PRAGMA schema_version").get().schema_version), schemaVersion);

    writer = new DatabaseSync(databaseFile);
    writer.exec("BEGIN IMMEDIATE");
    reader = new DatabaseSync(databaseFile);
    assert.doesNotThrow(
      () => createUsageRollups(reader),
      "a fixed reader must open while another connection holds BEGIN IMMEDIATE",
    );
    reader.close();
    reader = null;
    writer.exec("ROLLBACK");
    writer.close();
    writer = null;

    db.exec("DROP TRIGGER usage_rollup_progress_invalidate_insert");
    assert.equal(ensureUsageRollupProgressSchema(db), true);
    assert.equal(
      Number(
        db
          .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'usage_rollup_%'")
          .get().count,
      ),
      8,
    );
    assert.deepEqual(listDirtyUsageRollupDays(db), ["2026-07-12"]);
    assert.equal(
      Number(db.prepare("SELECT certified FROM usage_rollup_progress WHERE singleton = 1").get().certified),
      0,
    );
    assert.equal(Number(db.prepare("SELECT last_id FROM usage_rollup_progress WHERE singleton = 1").get().last_id), 0);
    assert.deepEqual(tryAppendUsageRollups(db, { zoneIdentity: CURRENT_ZONE }), {
      applied: false,
      readEvents: 0,
      reason: "ROLLUP_PROGRESS_NOT_CERTIFIED",
    });
    assert.deepEqual(checkpointUsageRollups(db, { zoneIdentity: CURRENT_ZONE }), {
      applied: false,
      certified: false,
      reason: "ROLLUP_DIRTY_DAYS",
    });
    assert.equal(
      Number(db.prepare("SELECT certified FROM usage_rollup_progress WHERE singleton = 1").get().certified),
      0,
      "a failed checkpoint must not leave an older cursor certified",
    );
    assert.equal(Number(db.prepare("SELECT last_id FROM usage_rollup_progress").get().last_id), 0);

    repairDirty(db);
    assert.equal(checkpointUsageRollups(db, { zoneIdentity: CURRENT_ZONE }).certified, true);
    assert.equal(
      queryUsageRollupsRange(db, { startDay: "2026-07-12", endDay: "2026-07-12" }).eventCount,
      2,
      "schema recovery must preserve every current fact",
    );
  } finally {
    try {
      reader?.close();
    } catch {
      // Optional reader.
    }
    try {
      writer?.exec("ROLLBACK");
    } catch {
      // Optional writer transaction.
    }
    try {
      writer?.close();
    } catch {
      // Optional writer connection.
    }
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("partial core and progress tables recover atomically instead of failing or permanently falling back", () => {
  const { db, directory } = openDatabase();
  try {
    seedAndCertify(db, [seedDetailEvent("2026-07-12T01:00:00.000Z", { sessionId: "partial", total: 10 })]);
    db.exec("DROP TABLE usage_rollup_models; DROP TABLE usage_rollup_progress_days");

    assert.equal(ensureUsageRollupProgressSchema(db), true);
    assert.deepEqual(listDirtyUsageRollupDays(db), ["2026-07-12"]);
    assert.equal(Number(db.prepare("SELECT certified FROM usage_rollup_progress").get().certified), 0);
    assert.equal(Number(db.prepare("SELECT last_id FROM usage_rollup_progress").get().last_id), 0);
    assert.doesNotThrow(() =>
      insertEvent(db, seedDetailEvent("2026-07-12T02:00:00.000Z", { sessionId: "after-recovery", total: 20 })),
    );

    repairDirty(db);
    assert.equal(checkpointUsageRollups(db, { zoneIdentity: CURRENT_ZONE }).certified, true);
    assert.deepEqual(
      (() => {
        const row = queryUsageRollupsRange(db, { startDay: "2026-07-12", endDay: "2026-07-12" });
        return { eventCount: row.eventCount, total: row.total };
      })(),
      { eventCount: 2, total: 30 },
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("local append crosses a DST day without leaking or reading the complete day", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-concurrency=1",
      "--test-name-pattern=DST append child",
      path.join(import.meta.dirname, "usage-rollup-progress.test.js"),
    ],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: { ...process.env, TZ: "America/New_York" },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("DST append child", { skip: process.env.TZ !== "America/New_York" }, () => {
  const { db, directory } = openDatabase();
  try {
    seedAndCertify(db, [
      seedDetailEvent("2026-03-08T06:00:00.000Z", { sessionId: "dst-early" }),
      seedDetailEvent("2026-03-08T20:00:00.000Z", { sessionId: "dst-late" }),
    ]);
    insertEvent(db, seedDetailEvent("2026-03-09T03:59:59.999Z", { sessionId: "dst-last" }));
    insertEvent(db, seedDetailEvent("2026-03-09T04:00:00.000Z", { sessionId: "dst-next" }));
    assert.equal(tryAppendUsageRollups(db, { zoneIdentity: CURRENT_ZONE }).applied, true);
    const marker = db
      .prepare(
        "SELECT start_ms, end_ms FROM usage_rollup_days WHERE calendar_zone = 'local' AND day_key = '2026-03-08'",
      )
      .get();
    assert.equal((Number(marker.end_ms) - Number(marker.start_ms)) / 3_600_000, 23);
    assert.equal(
      queryUsageRollupsRange(db, {
        startDay: "2026-03-08",
        endDay: "2026-03-08",
        calendarZone: "local",
      }).eventCount,
      3,
    );
    assert.equal(
      queryUsageRollupsRange(db, {
        startDay: "2026-03-09",
        endDay: "2026-03-09",
        calendarZone: "local",
      }).eventCount,
      1,
    );

    const prepare = db.prepare;
    let rawModelReads = 0;
    db.prepare = function (sql) {
      if (String(sql).includes("FROM events") && String(sql).includes("GROUP BY model")) rawModelReads += 1;
      return prepare.call(this, sql);
    };
    try {
      queryUsageRollupModelsWindow(db, {
        startMs: Number(marker.start_ms),
        endMs: Number(marker.end_ms),
      });
    } finally {
      db.prepare = prepare;
    }
    assert.equal(rawModelReads, 0, "a complete local DST day must be read from local model rollups");
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
