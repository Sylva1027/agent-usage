import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { rebuildUsageRollups, rebuildUsageRollupsFromEvents } from "../src/usage-rollups.js";
import { UsageStore } from "../src/usage-store.js";

const ARCHIVE_AUTHORITY_META = "history_archive_event_authority";
const ROLLUP_TABLES = [
  ["usage_rollup_daily", "day_key, home_id"],
  ["usage_rollup_models", "day_key, home_id, model"],
  ["usage_rollup_sessions", "day_key, home_id, session_id"],
  ["usage_rollup_days", "day_key"],
];

function codexTokenLine(timestamp, total, lastTotal) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: total,
          input_tokens: total - 20,
          cached_input_tokens: 0,
          output_tokens: 20,
          reasoning_output_tokens: 0,
        },
        last_token_usage: {
          total_tokens: lastTotal,
          input_tokens: lastTotal - 10,
          cached_input_tokens: 0,
          output_tokens: 10,
          reasoning_output_tokens: 0,
        },
      },
    },
  });
}

function codexCumulativePrefix(codexHome, timestamp, total) {
  return [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "cold-rollup-session", source: "cli", cwd: codexHome },
    }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-luna" } }),
    codexTokenLine(timestamp, total, total),
  ].join("\n");
}

function rollupRows(database, table, orderBy) {
  return database
    .prepare(`SELECT * FROM ${table} WHERE calendar_zone = 'utc' ORDER BY ${orderBy}`)
    .all()
    .map((row) => ({ ...row }));
}

function allRollupRows(database) {
  return Object.fromEntries(ROLLUP_TABLES.map(([table, orderBy]) => [table, rollupRows(database, table, orderBy)]));
}

test("hot-only history rollup rebuilds stay in SQL and publish both zones atomically", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-hot-rollup-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "rollout-hot-rollup.jsonl");
  const options = { homeDir: root, env: {}, extraHomes: codexHome, importDirs: [] };
  const store = new UsageStore({ ...options, databaseFile: path.join(root, "live.sqlite") });
  const oracle = new UsageStore({ ...options, databaseFile: path.join(root, "oracle.sqlite") });
  const snapshot = (database) =>
    Object.fromEntries(
      ROLLUP_TABLES.map(([table, orderBy]) => [
        table,
        database.prepare(`SELECT * FROM ${table} ORDER BY calendar_zone, ${orderBy}`).all(),
      ]),
    );
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(
      usageFile,
      `${codexCumulativePrefix(codexHome, "2026-07-12T12:00:00.000Z", 100)}\n${codexTokenLine("2026-07-14T12:00:00.000Z", 130, 30)}\n`,
    );
    await store.sync({ options });
    await oracle.sync({ options });
    const events = await oracle.publishedHistoryUsageEvents();
    const utcDays = ["2020-01-01", "2026-07-12", "2026-07-13", "2026-07-14"];
    const localDays = ["2020-01-01"];
    const first = new Date(events[0].timestamp);
    const last = new Date(events.at(-1).timestamp);
    for (
      let day = new Date(first.getFullYear(), first.getMonth(), first.getDate());
      day <= last;
      day.setDate(day.getDate() + 1)
    ) {
      localDays.push(
        `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`,
      );
    }
    const staleEvent = { ...events[0], timestamp: "2020-01-01T12:00:00.000Z" };
    for (const zone of ["utc", "local"]) {
      rebuildUsageRollupsFromEvents(store.database, { days: ["2020-01-01"], events: [staleEvent], calendarZone: zone });
      rebuildUsageRollupsFromEvents(oracle.database, {
        days: zone === "utc" ? utcDays : localDays,
        events,
        calendarZone: zone,
      });
    }
    const hotBefore = store.database.prepare("SELECT * FROM events ORDER BY id").all();
    store.publishedHistoryUsageEvents = async () => {
      throw new Error("hot-only rebuild must not materialize events");
    };
    const revision = store.storeRevision;
    await store.rebuildHistoryRollups();
    assert.deepEqual(snapshot(store.database), snapshot(oracle.database));
    assert.deepEqual(store.database.prepare("SELECT * FROM events ORDER BY id").all(), hotBefore);
    assert.equal(store.storeRevision, revision + 1);
    const metaBefore = store.readMetaRaw("usage_rollup_local_zone_identity");
    const before = snapshot(store.database);
    store.database.exec(`
      CREATE TRIGGER fail_hot_local_rollup BEFORE INSERT ON usage_rollup_daily
      WHEN NEW.calendar_zone = 'local'
      BEGIN SELECT RAISE(ABORT, 'HOT_LOCAL_ROLLUP_FAILURE'); END
    `);
    await assert.rejects(store.rebuildHistoryRollups(), /HOT_LOCAL_ROLLUP_FAILURE/);
    assert.deepEqual(snapshot(store.database), before);
    assert.equal(store.readMetaRaw("usage_rollup_local_zone_identity"), metaBefore);
    assert.equal(store.storeRevision, revision + 1);
    store.database.exec("DROP TRIGGER fail_hot_local_rollup");
    await store.rebuildHistoryRollupDay("2026-07-12");
    assert.deepEqual(snapshot(store.database), before);
    assert.equal(store.storeRevision, revision + 2);
  } finally {
    store.close();
    oracle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("store rebuilds one UTC rollup day from authorized cold plus hot facts", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-cold-rollup-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-cold-rollup.jsonl");
  const candidateFile = path.join(root, "cold-prefix.sqlite");
  const firstTimestamp = "2026-07-12T02:00:00.000Z";
  const secondTimestamp = "2026-07-12T02:01:00.000Z";
  const secondTimestampMs = Date.parse(secondTimestamp);
  const day = "2026-07-12";
  const options = { homeDir: root, env: {}, extraHomes: codexHome, importDirs: [] };
  const archived = new UsageStore({ ...options, databaseFile: path.join(root, "archived.sqlite") });
  const oracle = new UsageStore({ ...options, databaseFile: path.join(root, "oracle.sqlite") });
  let writer;
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    const prefix = codexCumulativePrefix(codexHome, firstTimestamp, 100);
    writeFileSync(usageFile, `${prefix}\n`);
    await archived.sync({ options });

    await createHistoryArchiveCandidate(archived.database, candidateFile, {
      startMs: Date.parse(firstTimestamp),
      endMs: Date.parse(secondTimestamp),
    });
    const registered = await archived.registerHistoryArchiveCandidate(candidateFile);
    archived.database.exec("BEGIN IMMEDIATE");
    try {
      archived.database
        .prepare(
          `INSERT INTO store_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(ARCHIVE_AUTHORITY_META, JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }));
      archived.database.prepare("DELETE FROM events WHERE source_path = ?").run(usageFile);
      archived.database.exec("COMMIT");
    } catch (error) {
      archived.database.exec("ROLLBACK");
      throw error;
    }

    writeFileSync(usageFile, `${prefix}\n${codexTokenLine(secondTimestamp, 120, 20)}\n`);
    archived.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(usageFile);
    await archived.sync({ options });
    await oracle.sync({ options });

    const completeEvents = await archived.publishedHistoryUsageEvents();
    assert.deepEqual(
      completeEvents.map((event) => event.total.total),
      [100, 20],
    );

    const revisionBefore = archived.storeRevision;
    archived.periodComparison({ now: "2026-07-12T12:00:00.000Z", calendarZone: "utc" });
    assert.equal(archived.periodComparisonCache.size, 1);
    archived.database.exec(`
      DELETE FROM usage_rollup_models WHERE calendar_zone = 'utc';
      DELETE FROM usage_rollup_daily WHERE calendar_zone = 'utc';
      DELETE FROM usage_rollup_sessions WHERE calendar_zone = 'utc';
      DELETE FROM usage_rollup_days WHERE calendar_zone = 'utc';
    `);
    writer = new DatabaseSync(archived.databaseFile);
    writer.exec("PRAGMA busy_timeout = 0");
    const originalPublishedHistoryUsageEvents = archived.publishedHistoryUsageEvents;
    let writerError;
    let historyReadSettled = false;
    archived.publishedHistoryUsageEvents = async function (...args) {
      const pending = originalPublishedHistoryUsageEvents.call(this, ...args);
      pending.then(
        () => {
          historyReadSettled = true;
        },
        () => {
          historyReadSettled = true;
        },
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(historyReadSettled, false);
      try {
        writer.prepare("UPDATE events SET total = 25, input = 15 WHERE timestamp_ms = ?").run(secondTimestampMs);
      } catch (error) {
        writerError = error;
      }
      return pending;
    };
    try {
      await archived.rebuildHistoryRollupDay(day);
    } finally {
      archived.publishedHistoryUsageEvents = originalPublishedHistoryUsageEvents;
    }

    for (const [table, orderBy] of ROLLUP_TABLES) {
      assert.deepEqual(
        rollupRows(archived.database, table, orderBy),
        rollupRows(oracle.database, table, orderBy),
        table,
      );
    }
    assert.equal(archived.storeRevision, revisionBefore + 1);
    assert.equal(archived.periodComparisonCache.size, 0);
    assert.equal(writerError?.errcode, 5);
    assert.match(writerError?.message ?? "", /busy|locked/i);

    assert.deepEqual(
      archived.database
        .prepare("SELECT timestamp_ms, total FROM events ORDER BY timestamp_ms")
        .all()
        .map((row) => ({ ...row })),
      [{ timestamp_ms: secondTimestampMs, total: 20 }],
    );

    assert.equal(
      Number(
        writer.prepare("UPDATE events SET total = 25, input = 15 WHERE timestamp_ms = ?").run(secondTimestampMs)
          .changes,
      ),
      1,
    );
    oracle.database.prepare("UPDATE events SET total = 25, input = 15 WHERE timestamp_ms = ?").run(secondTimestampMs);
    assert.deepEqual(
      (await archived.publishedHistoryUsageEvents()).map((event) => event.total.total),
      [100, 25],
    );
    rebuildUsageRollups(oracle.database, { days: [day], calendarZone: "utc" });
    await archived.rebuildHistoryRollupDay(day);
    for (const [table, orderBy] of ROLLUP_TABLES) {
      assert.deepEqual(
        rollupRows(archived.database, table, orderBy),
        rollupRows(oracle.database, table, orderBy),
        table,
      );
    }

    const rebuiltRollups = allRollupRows(archived.database);
    const missingCandidate = `${candidateFile}.missing`;
    renameSync(candidateFile, missingCandidate);
    try {
      const revisionBeforeMissing = archived.storeRevision;
      await assert.rejects(archived.rebuildHistoryRollupDay(day), (error) => error?.code === "ENOENT");
      assert.equal(archived.storeRevision, revisionBeforeMissing);
      assert.deepEqual(allRollupRows(archived.database), rebuiltRollups);
    } finally {
      renameSync(missingCandidate, candidateFile);
    }

    archived.database.exec(`
      CREATE TRIGGER usage_rollup_rebuild_injected_failure
      BEFORE INSERT ON usage_rollup_daily
      BEGIN
        SELECT RAISE(ABORT, 'INJECTED_HISTORY_ROLLUP_INSERT_FAILURE');
      END
    `);
    try {
      const revisionBeforeFailure = archived.storeRevision;
      await assert.rejects(archived.rebuildHistoryRollupDay(day), /INJECTED_HISTORY_ROLLUP_INSERT_FAILURE/);
      assert.equal(archived.storeRevision, revisionBeforeFailure);
      assert.deepEqual(allRollupRows(archived.database), rebuiltRollups);
    } finally {
      archived.database.exec("DROP TRIGGER usage_rollup_rebuild_injected_failure");
    }
  } finally {
    writer?.close();
    archived.close();
    oracle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("complete event carrier rebuilds multiple UTC days atomically", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-cold-rollup-multi-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-multi-day.jsonl");
  const candidateFile = path.join(root, "cold-prefix.sqlite");
  const firstTimestamp = "2026-07-12T02:00:00.000Z";
  const secondTimestamp = "2026-07-13T02:01:00.000Z";
  const firstDay = "2026-07-12";
  const secondDay = "2026-07-13";
  const options = { homeDir: root, env: {}, extraHomes: codexHome, importDirs: [] };
  const archived = new UsageStore({ ...options, databaseFile: path.join(root, "archived.sqlite") });
  const oracle = new UsageStore({ ...options, databaseFile: path.join(root, "oracle.sqlite") });
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    const prefix = codexCumulativePrefix(codexHome, firstTimestamp, 100);
    writeFileSync(usageFile, `${prefix}\n`);
    await archived.sync({ options });

    await createHistoryArchiveCandidate(archived.database, candidateFile, {
      startMs: Date.parse(firstTimestamp),
      endMs: Date.parse(secondTimestamp),
    });
    const registered = await archived.registerHistoryArchiveCandidate(candidateFile);
    archived.database.exec("BEGIN IMMEDIATE");
    try {
      archived.database
        .prepare(
          `INSERT INTO store_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(ARCHIVE_AUTHORITY_META, JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }));
      archived.database.prepare("DELETE FROM events WHERE source_path = ?").run(usageFile);
      archived.database.exec("COMMIT");
    } catch (error) {
      archived.database.exec("ROLLBACK");
      throw error;
    }

    writeFileSync(usageFile, `${prefix}\n${codexTokenLine(secondTimestamp, 120, 20)}\n`);
    archived.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(usageFile);
    await archived.sync({ options });
    await oracle.sync({ options });

    const completeEvents = await archived.publishedHistoryUsageEvents();
    assert.deepEqual(
      completeEvents.map((event) => event.total.total),
      [100, 20],
    );
    archived.database.exec(`
      DELETE FROM usage_rollup_models WHERE calendar_zone = 'utc';
      DELETE FROM usage_rollup_daily WHERE calendar_zone = 'utc';
      DELETE FROM usage_rollup_sessions WHERE calendar_zone = 'utc';
      DELETE FROM usage_rollup_days WHERE calendar_zone = 'utc';
    `);
    rebuildUsageRollupsFromEvents(archived.database, {
      days: [firstDay, secondDay],
      events: completeEvents,
    });

    for (const [table, orderBy] of ROLLUP_TABLES) {
      assert.deepEqual(
        rollupRows(archived.database, table, orderBy),
        rollupRows(oracle.database, table, orderBy),
        table,
      );
    }
    assert.deepEqual(
      rollupRows(archived.database, "usage_rollup_days", "day_key").map((row) => row.day_key),
      [firstDay, secondDay],
    );

    const rebuiltRollups = allRollupRows(archived.database);
    archived.database.exec(`
      CREATE TRIGGER usage_rollup_second_day_injected_failure
      BEFORE INSERT ON usage_rollup_daily
      WHEN NEW.day_key = '${secondDay}'
      BEGIN
        SELECT RAISE(ABORT, 'INJECTED_SECOND_DAY_ROLLUP_INSERT_FAILURE');
      END
    `);
    try {
      const changedEvents = structuredClone(completeEvents);
      changedEvents[0].total.total = 150;
      changedEvents[0].total.input = 130;
      assert.equal(changedEvents[0].timestamp.slice(0, 10), firstDay);
      assert.throws(
        () =>
          rebuildUsageRollupsFromEvents(archived.database, {
            days: [firstDay, secondDay],
            events: changedEvents,
          }),
        /INJECTED_SECOND_DAY_ROLLUP_INSERT_FAILURE/,
      );
      assert.deepEqual(allRollupRows(archived.database), rebuiltRollups);
      assert.equal(
        archived.database
          .prepare("SELECT 1 FROM sqlite_temp_master WHERE type = 'table' AND name = 'usage_rollup_complete_events'")
          .get(),
        undefined,
      );
    } finally {
      archived.database.exec("DROP TRIGGER usage_rollup_second_day_injected_failure");
    }

    assert.deepEqual(
      archived.database
        .prepare("SELECT timestamp_ms, total FROM events ORDER BY timestamp_ms")
        .all()
        .map((row) => ({ ...row })),
      [{ timestamp_ms: Date.parse(secondTimestamp), total: 20 }],
    );
  } finally {
    archived.close();
    oracle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("store rebuilds full UTC history across gaps and publishes atomically", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-cold-rollup-full-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-full-history.jsonl");
  const candidateFile = path.join(root, "cold-prefix.sqlite");
  const firstTimestamp = "2026-07-12T02:00:00.000Z";
  const secondTimestamp = "2026-07-13T02:01:00.000Z";
  const lastTimestamp = "2026-07-15T02:01:00.000Z";
  const firstDay = "2026-07-12";
  const secondDay = "2026-07-13";
  const gapDay = "2026-07-14";
  const lastDay = "2026-07-15";
  const staleDay = "2026-07-10";
  const expectedDays = [staleDay, firstDay, secondDay, gapDay, lastDay];
  const options = { homeDir: root, env: {}, extraHomes: codexHome, importDirs: [] };
  const archived = new UsageStore({ ...options, databaseFile: path.join(root, "archived.sqlite") });
  const oracle = new UsageStore({ ...options, databaseFile: path.join(root, "oracle.sqlite") });
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    const prefix = codexCumulativePrefix(codexHome, firstTimestamp, 100);
    writeFileSync(usageFile, `${prefix}\n`);
    await archived.sync({ options });

    await createHistoryArchiveCandidate(archived.database, candidateFile, {
      startMs: Date.parse(firstTimestamp),
      endMs: Date.parse(secondTimestamp),
    });
    const registered = await archived.registerHistoryArchiveCandidate(candidateFile);
    archived.database.exec("BEGIN IMMEDIATE");
    try {
      archived.database
        .prepare(
          `INSERT INTO store_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(ARCHIVE_AUTHORITY_META, JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }));
      archived.database.prepare("DELETE FROM events WHERE source_path = ?").run(usageFile);
      archived.database.exec("COMMIT");
    } catch (error) {
      archived.database.exec("ROLLBACK");
      throw error;
    }

    writeFileSync(
      usageFile,
      `${prefix}\n${codexTokenLine(secondTimestamp, 130, 30)}\n${codexTokenLine(lastTimestamp, 170, 40)}\n`,
    );
    archived.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(usageFile);
    await archived.sync({ options });
    await oracle.sync({ options });

    const completeEvents = await archived.publishedHistoryUsageEvents();
    assert.deepEqual(
      completeEvents.map((event) => event.total.total),
      [100, 30, 40],
    );

    const staleEvent = structuredClone(completeEvents[0]);
    staleEvent.timestamp = "2026-07-10T02:00:00.000Z";
    staleEvent.total.total = 90;
    staleEvent.total.input = 70;
    archived.database.exec(`
      DELETE FROM usage_rollup_models WHERE calendar_zone = 'utc';
      DELETE FROM usage_rollup_daily WHERE calendar_zone = 'utc';
      DELETE FROM usage_rollup_sessions WHERE calendar_zone = 'utc';
      DELETE FROM usage_rollup_days WHERE calendar_zone = 'utc';
    `);
    rebuildUsageRollupsFromEvents(archived.database, { days: [staleDay], events: [staleEvent] });
    oracle.database.exec(`
      DELETE FROM usage_rollup_models WHERE calendar_zone = 'utc';
      DELETE FROM usage_rollup_daily WHERE calendar_zone = 'utc';
      DELETE FROM usage_rollup_sessions WHERE calendar_zone = 'utc';
      DELETE FROM usage_rollup_days WHERE calendar_zone = 'utc';
    `);
    rebuildUsageRollups(oracle.database, { days: expectedDays, calendarZone: "utc" });

    archived.periodComparison({ now: "2026-07-16T12:00:00.000Z", calendarZone: "utc" });
    assert.equal(archived.periodComparisonCache.size, 1);
    const revisionBefore = archived.storeRevision;
    const originalPublishedHistoryUsageEvents = archived.publishedHistoryUsageEvents;
    let historyReads = 0;
    archived.publishedHistoryUsageEvents = async function (...args) {
      historyReads += 1;
      return originalPublishedHistoryUsageEvents.call(this, ...args);
    };
    try {
      await archived.rebuildHistoryRollups();
    } finally {
      archived.publishedHistoryUsageEvents = originalPublishedHistoryUsageEvents;
    }

    assert.equal(archived.storeRevision, revisionBefore + 1);
    assert.equal(historyReads, 1);
    assert.equal(archived.periodComparisonCache.size, 0);
    for (const [table, orderBy] of ROLLUP_TABLES) {
      assert.deepEqual(
        rollupRows(archived.database, table, orderBy),
        rollupRows(oracle.database, table, orderBy),
        table,
      );
    }
    assert.deepEqual(
      rollupRows(archived.database, "usage_rollup_days", "day_key").map((row) => row.day_key),
      expectedDays,
    );
    for (const table of ["usage_rollup_daily", "usage_rollup_models", "usage_rollup_sessions"]) {
      const rows = rollupRows(archived.database, table, "day_key");
      assert.equal(
        rows.some((row) => row.day_key === staleDay),
        false,
        `${table} stale day`,
      );
      assert.equal(
        rows.some((row) => row.day_key === gapDay),
        false,
        `${table} empty gap day`,
      );
    }
    assert.deepEqual(
      archived.database
        .prepare("SELECT timestamp_ms, total FROM events ORDER BY timestamp_ms")
        .all()
        .map((row) => ({ ...row })),
      [
        { timestamp_ms: Date.parse(secondTimestamp), total: 30 },
        { timestamp_ms: Date.parse(lastTimestamp), total: 40 },
      ],
    );

    const successfulRollups = allRollupRows(archived.database);
    const missingCandidate = `${candidateFile}.missing`;
    renameSync(candidateFile, missingCandidate);
    try {
      const revisionBeforeMissing = archived.storeRevision;
      await assert.rejects(archived.rebuildHistoryRollups(), (error) => error?.code === "ENOENT");
      assert.equal(archived.storeRevision, revisionBeforeMissing);
      assert.deepEqual(allRollupRows(archived.database), successfulRollups);
    } finally {
      renameSync(missingCandidate, candidateFile);
    }

    archived.database
      .prepare("UPDATE usage_rollup_daily SET total = 999, input = 888 WHERE calendar_zone = 'utc' AND day_key = ?")
      .run(firstDay);
    const beforeFailure = allRollupRows(archived.database);
    const revisionBeforeFailure = archived.storeRevision;
    archived.database.exec(`
      CREATE TRIGGER usage_rollup_store_injected_failure
      BEFORE INSERT ON usage_rollup_daily
      WHEN NEW.day_key = '${secondDay}'
      BEGIN
        SELECT RAISE(ABORT, 'INJECTED_STORE_ROLLUP_INSERT_FAILURE');
      END
    `);
    try {
      await assert.rejects(archived.rebuildHistoryRollups(), /INJECTED_STORE_ROLLUP_INSERT_FAILURE/);
      assert.equal(archived.storeRevision, revisionBeforeFailure);
      assert.deepEqual(allRollupRows(archived.database), beforeFailure);
      assert.equal(
        rollupRows(archived.database, "usage_rollup_daily", "day_key").find((row) => row.day_key === firstDay).total,
        999,
      );
    } finally {
      archived.database.exec("DROP TRIGGER usage_rollup_store_injected_failure");
    }

    archived.database.exec(`
      DELETE FROM store_meta WHERE key = '${ARCHIVE_AUTHORITY_META}';
      DELETE FROM archive_segments;
      DELETE FROM events;
    `);
    await archived.rebuildHistoryRollups();
    for (const table of ["usage_rollup_daily", "usage_rollup_models", "usage_rollup_sessions"]) {
      assert.deepEqual(rollupRows(archived.database, table, "day_key"), [], table);
    }
    assert.deepEqual(
      rollupRows(archived.database, "usage_rollup_days", "day_key").map((row) => row.day_key),
      expectedDays,
    );
  } finally {
    archived.close();
    oracle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("store rebuilds full dual-zone New York DST history atomically", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-cold-rollup-local-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "03", "08", "rollout-local-dst.jsonl");
  const candidateFile = path.join(root, "cold-prefix.sqlite");
  const archivedFile = path.join(root, "archived.sqlite");
  const oracleFile = path.join(root, "oracle.sqlite");
  const beforeTimestamp = "2026-03-08T04:59:59.999Z";
  const coldTimestamp = "2026-03-08T06:00:00.000Z";
  const hotTimestamp = "2026-03-08T07:00:00.000Z";
  const afterTimestamp = "2026-03-10T04:00:00.000Z";
  const localDay = "2026-03-08";
  const options = { homeDir: root, env: {}, extraHomes: codexHome, importDirs: [] };
  let archived = new UsageStore({ ...options, databaseFile: archivedFile });
  let oracle = new UsageStore({ ...options, databaseFile: oracleFile });
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    const prefix = codexCumulativePrefix(codexHome, beforeTimestamp, 10);
    writeFileSync(usageFile, `${prefix}\n${codexTokenLine(coldTimestamp, 30, 20)}\n`);
    await archived.sync({ options });

    await createHistoryArchiveCandidate(archived.database, candidateFile, {
      startMs: Date.parse(beforeTimestamp),
      endMs: Date.parse(hotTimestamp),
    });
    const registered = await archived.registerHistoryArchiveCandidate(candidateFile);
    archived.database.exec("BEGIN IMMEDIATE");
    try {
      archived.database
        .prepare(
          `INSERT INTO store_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(ARCHIVE_AUTHORITY_META, JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }));
      archived.database.prepare("DELETE FROM events WHERE source_path = ?").run(usageFile);
      archived.database.exec("COMMIT");
    } catch (error) {
      archived.database.exec("ROLLBACK");
      throw error;
    }

    writeFileSync(
      usageFile,
      `${prefix}
${codexTokenLine(coldTimestamp, 30, 20)}
${codexTokenLine(hotTimestamp, 50, 20)}
${codexTokenLine(afterTimestamp, 70, 20)}
`,
    );
    archived.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(usageFile);
    await archived.sync({ options });
    await oracle.sync({ options });
    archived.close();
    archived = null;
    oracle.close();
    oracle = null;

    const script = `
      import assert from "node:assert/strict";
      import { renameSync } from "node:fs";
      import { DatabaseSync } from "node:sqlite";
      import { UsageStore } from "./src/usage-store.js";
      import { rebuildUsageRollups, rebuildUsageRollupsFromEvents } from "./src/usage-rollups.js";

      const day = process.env.LOCAL_DAY;
      const expectedUtcDays = ["2026-03-08", "2026-03-09", "2026-03-10"];
      const expectedLocalDays = ["2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"];
      const staleDay = "2026-03-06";
      const gapDay = "2026-03-09";
      const utcRollupDays = [staleDay, ...expectedUtcDays];
      const localRollupDays = [staleDay, ...expectedLocalDays];
      const store = new UsageStore({
        homeDir: process.env.TEST_ROOT,
        env: {},
        extraHomes: process.env.HISTORY_ROLLUP_TEST_HOME,
        importDirs: [],
        databaseFile: process.env.ARCHIVED_DB,
      });
      await store.open();
      assert.notEqual(store.readMetaRaw("usage_rollup_local_zone_identity"), "America/New_York");
      const events = await store.publishedHistoryUsageEvents();
      assert.deepEqual(
        events.map((event) => event.total.total),
        [10, 20, 20, 20],
      );
      const archivedDb = store.database;
      const oracleDb = new DatabaseSync(process.env.ORACLE_DB);
      const tables = [
        ["usage_rollup_daily", "day_key, home_id"],
        ["usage_rollup_models", "day_key, home_id, model"],
        ["usage_rollup_sessions", "day_key, home_id, session_id"],
        ["usage_rollup_days", "day_key"],
      ];
      for (const db of [archivedDb, oracleDb]) {
        for (const [table] of tables) db.exec("DELETE FROM " + table);
      }

      const rows = (db, table, zone, orderBy) =>
        db.prepare("SELECT * FROM " + table + " WHERE calendar_zone = ? ORDER BY " + orderBy)
          .all(zone)
          .map((row) => ({ ...row }));
      const snapshot = (db, zone) =>
        Object.fromEntries(tables.map(([table, orderBy]) => [table, rows(db, table, zone, orderBy)]));
      const dayKeys = (db, zone) =>
        db.prepare("SELECT day_key FROM usage_rollup_days WHERE calendar_zone = ? ORDER BY day_key")
          .all(zone)
          .map((row) => row.day_key);
      const markerHours = (db, zone) => {
        const marker = db.prepare(
          "SELECT start_ms, end_ms FROM usage_rollup_days WHERE calendar_zone = ? AND day_key = ?",
        ).get(zone, day);
        return (Number(marker.end_ms) - Number(marker.start_ms)) / 3_600_000;
      };
      const daily = (db, zone) =>
        db.prepare("SELECT event_count, total FROM usage_rollup_daily WHERE calendar_zone = ? AND day_key = ?")
          .get(zone, day);

      const staleEvent = structuredClone(events[0]);
      staleEvent.timestamp = "2026-03-06T12:00:00.000Z";
      for (const zone of ["utc", "local"]) {
        rebuildUsageRollupsFromEvents(archivedDb, {
          days: [staleDay],
          events: [staleEvent],
          calendarZone: zone,
        });
        rebuildUsageRollups(oracleDb, {
          days: zone === "utc" ? utcRollupDays : localRollupDays,
          calendarZone: zone,
        });
      }

      const originalHistoryRead = store.publishedHistoryUsageEvents;
      let historyReads = 0;
      store.publishedHistoryUsageEvents = async function (...args) {
        historyReads += 1;
        return originalHistoryRead.call(this, ...args);
      };
      const revisionBefore = store.storeRevision;
      await store.rebuildHistoryRollups();
      assert.equal(historyReads, 1);
      const successfulHistoryReads = historyReads;
      assert.equal(store.storeRevision, revisionBefore + 1);
      assert.equal(store.readMetaRaw("usage_rollup_local_zone_identity"), "America/New_York");

      assert.deepEqual(snapshot(archivedDb, "utc"), snapshot(oracleDb, "utc"));
      assert.deepEqual(snapshot(archivedDb, "local"), snapshot(oracleDb, "local"));
      assert.deepEqual(dayKeys(archivedDb, "utc"), utcRollupDays);
      assert.deepEqual(dayKeys(archivedDb, "local"), localRollupDays);
      for (const zone of ["utc", "local"]) {
        for (const [table] of tables.slice(0, 3)) {
          assert.equal(rows(archivedDb, table, zone, "day_key").some((row) => row.day_key === staleDay), false);
          assert.equal(rows(archivedDb, table, zone, "day_key").some((row) => row.day_key === gapDay), false);
        }
      }
      const successfulLocalDaily = daily(archivedDb, "local");
      const successfulUtcDaily = daily(archivedDb, "utc");

      const newUtcTotal = daily(archivedDb, "utc").total;
      assert.notEqual(newUtcTotal, 999);
      archivedDb
        .prepare(
          "UPDATE usage_rollup_daily SET total = 999, input = 888 WHERE calendar_zone = 'utc' AND day_key = ?",
        )
        .run(day);
      const beforeFailure = {
        utc: snapshot(archivedDb, "utc"),
        local: snapshot(archivedDb, "local"),
      };
      const revisionBeforeFailure = store.storeRevision;
      archivedDb.exec(
        "CREATE TRIGGER usage_rollup_local_injected_failure " +
        "BEFORE INSERT ON usage_rollup_daily " +
        "WHEN NEW.calendar_zone = 'local' AND NEW.day_key = '" + day + "' " +
        "BEGIN SELECT RAISE(ABORT, 'INJECTED_LOCAL_ROLLUP_INSERT_FAILURE'); END",
      );
      try {
        await assert.rejects(store.rebuildHistoryRollups(), /INJECTED_LOCAL_ROLLUP_INSERT_FAILURE/);
        assert.equal(store.storeRevision, revisionBeforeFailure);
        assert.deepEqual(snapshot(archivedDb, "utc"), beforeFailure.utc);
        assert.deepEqual(snapshot(archivedDb, "local"), beforeFailure.local);
        assert.equal(daily(archivedDb, "utc").total, 999);
      } finally {
        archivedDb.exec("DROP TRIGGER usage_rollup_local_injected_failure");
      }

      const missingCandidate = process.env.CANDIDATE_FILE + ".missing";
      renameSync(process.env.CANDIDATE_FILE, missingCandidate);
      try {
        const revisionBeforeMissing = store.storeRevision;
        await assert.rejects(store.rebuildHistoryRollups(), (error) => error?.code === "ENOENT");
        assert.equal(store.storeRevision, revisionBeforeMissing);
        assert.deepEqual(snapshot(archivedDb, "utc"), beforeFailure.utc);
        assert.deepEqual(snapshot(archivedDb, "local"), beforeFailure.local);
      } finally {
        renameSync(missingCandidate, process.env.CANDIDATE_FILE);
      }

      console.log(JSON.stringify({
        historyReads: successfulHistoryReads,
        localMarkerHours: markerHours(archivedDb, "local"),
        utcMarkerHours: markerHours(archivedDb, "utc"),
        localDaily: successfulLocalDaily,
        utcDaily: successfulUtcDaily,
      }));
      store.close();
      oracleDb.close();
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        TZ: "America/New_York",
        TEST_ROOT: root,
        HISTORY_ROLLUP_TEST_HOME: codexHome,
        ARCHIVED_DB: archivedFile,
        ORACLE_DB: oracleFile,
        CANDIDATE_FILE: candidateFile,
        LOCAL_DAY: localDay,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);

    assert.equal(payload.historyReads, 1);
    assert.equal(payload.localMarkerHours, 23);
    assert.equal(payload.utcMarkerHours, 24);
    assert.deepEqual(payload.localDaily, { event_count: 2, total: 40 });
    assert.deepEqual(payload.utcDaily, { event_count: 3, total: 50 });
  } finally {
    archived?.close();
    oracle?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
