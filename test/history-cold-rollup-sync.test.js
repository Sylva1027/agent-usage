import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";

const AUTHORITY_META = "history_archive_event_authority";
const ROLLUP_TABLES = [
  ["usage_rollup_daily", "day_key, home_id"],
  ["usage_rollup_models", "day_key, home_id, model"],
  ["usage_rollup_sessions", "day_key, home_id, session_id"],
  ["usage_rollup_days", "day_key"],
];

function tokenLine(timestamp, total, lastTotal) {
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

function sourcePrefix(codexHome, timestamp) {
  return [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "cold-rollup-sync-session", source: "cli", cwd: codexHome },
    }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-luna" } }),
    tokenLine(timestamp, 100, 100),
  ].join("\n");
}

function invalidateSource(store, sourcePath) {
  store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(sourcePath);
}

function rollupSnapshot(database) {
  return Object.fromEntries(
    ["utc", "local"].map((zone) => [
      zone,
      Object.fromEntries(
        ROLLUP_TABLES.map(([table, orderBy]) => [
          table,
          database
            .prepare(`SELECT * FROM ${table} WHERE calendar_zone = ? ORDER BY ${orderBy}`)
            .all(zone)
            .map((row) => ({ ...row })),
        ]),
      ),
    ]),
  );
}

function rollupAggregateSnapshot(snapshot) {
  snapshot = structuredClone(snapshot);
  for (const zone of ["utc", "local"]) delete snapshot[zone].usage_rollup_days;
  return snapshot;
}

function dirtyRollupDays(database) {
  return database
    .prepare("SELECT day_key FROM usage_rollup_dirty_days ORDER BY day_key")
    .all()
    .map((row) => String(row.day_key));
}

test("ordinary sync keeps cold contribution in same-day UTC and local rollups", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-cold-rollup-sync-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-cold-rollup-sync.jsonl");
  const candidateFile = path.join(root, "cold-prefix.sqlite");
  const coldTimestamp = "2026-07-12T02:00:00.000Z";
  const hotTimestamp = "2026-07-12T23:01:00.000Z";
  const options = { homeDir: root, env: {}, extraHomes: codexHome, importDirs: [] };
  const archived = new UsageStore({ ...options, databaseFile: path.join(root, "archived.sqlite") });
  const oracle = new UsageStore({ ...options, databaseFile: path.join(root, "oracle.sqlite") });
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    const prefix = sourcePrefix(codexHome, coldTimestamp);
    writeFileSync(usageFile, `${prefix}\n`);
    await archived.sync({ options });

    await createHistoryArchiveCandidate(archived.database, candidateFile, {
      startMs: Date.parse(coldTimestamp),
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
        .run(AUTHORITY_META, JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }));
      archived.database.prepare("DELETE FROM events WHERE source_path = ?").run(usageFile);
      archived.database.exec("COMMIT");
    } catch (error) {
      archived.database.exec("ROLLBACK");
      throw error;
    }

    writeFileSync(usageFile, `${prefix}\n${tokenLine(hotTimestamp, 130, 30)}\n`);
    invalidateSource(archived, usageFile);
    await archived.sync({ options });
    await oracle.sync({ options });
    await archived.rebuildHistoryRollups();
    assert.deepEqual(rollupSnapshot(archived.database), rollupSnapshot(oracle.database));

    writeFileSync(usageFile, `${prefix}\n${tokenLine(hotTimestamp, 140, 40)}\n`);
    invalidateSource(archived, usageFile);
    invalidateSource(oracle, usageFile);
    await archived.sync({ options });
    await oracle.sync({ options });

    assert.deepEqual(
      archived.database
        .prepare("SELECT total FROM events ORDER BY timestamp_ms")
        .all()
        .map((row) => Number(row.total)),
      [40],
    );
    const actualRollups = rollupSnapshot(archived.database);
    const expectedRollups = rollupSnapshot(oracle.database);
    const differences = [];
    for (const zone of ["utc", "local"]) {
      for (const [table] of ROLLUP_TABLES) {
        try {
          assert.deepEqual(actualRollups[zone][table], expectedRollups[zone][table]);
        } catch {
          differences.push({
            zone,
            table,
            actual: actualRollups[zone][table],
            expected: expectedRollups[zone][table],
          });
        }
      }
    }
    assert.deepEqual(differences, [], JSON.stringify(differences, null, 2));

    const rollups140 = rollupSnapshot(archived.database);
    writeFileSync(usageFile, `${prefix}\n${tokenLine(hotTimestamp, 150, 50)}\n`);
    invalidateSource(archived, usageFile);
    archived.database.exec(`
      CREATE TRIGGER injected_local_rollup_failure
      BEFORE INSERT ON usage_rollup_daily
      WHEN NEW.calendar_zone = 'local'
       AND NEW.day_key = '2026-07-12'
       AND (
         SELECT total FROM usage_rollup_daily
         WHERE calendar_zone = 'utc' AND day_key = '2026-07-12'
       ) = 150
      BEGIN
        SELECT RAISE(ABORT, 'INJECTED_LOCAL_ROLLUP_INSERT_FAILURE');
      END
    `);
    try {
      await assert.rejects(archived.sync({ options }), /INJECTED_LOCAL_ROLLUP_INSERT_FAILURE/);
    } finally {
      archived.database.exec("DROP TRIGGER IF EXISTS injected_local_rollup_failure");
    }

    assert.deepEqual(
      archived.database
        .prepare("SELECT total FROM events ORDER BY timestamp_ms")
        .all()
        .map((row) => Number(row.total)),
      [50],
    );
    assert.deepEqual(rollupAggregateSnapshot(rollupSnapshot(archived.database)), rollupAggregateSnapshot(rollups140));
    assert.deepEqual(dirtyRollupDays(archived.database), ["2026-07-12"]);

    invalidateSource(oracle, usageFile);
    await oracle.sync({ options });
    await archived.sync({ options });
    assert.deepEqual(rollupSnapshot(archived.database), rollupSnapshot(oracle.database));
    assert.deepEqual(dirtyRollupDays(archived.database), []);

    const rollups150 = rollupSnapshot(archived.database);
    const missingCandidate = `${candidateFile}.missing`;
    writeFileSync(usageFile, `${prefix}\n${tokenLine(hotTimestamp, 160, 60)}\n`);
    invalidateSource(archived, usageFile);
    const originalPublishedHistoryUsageEvents = archived.publishedHistoryUsageEvents;
    archived.publishedHistoryUsageEvents = async function (...args) {
      renameSync(candidateFile, missingCandidate);
      return originalPublishedHistoryUsageEvents.call(this, ...args);
    };
    try {
      await assert.rejects(archived.sync({ options }), (error) => error?.code === "ENOENT");
    } finally {
      archived.publishedHistoryUsageEvents = originalPublishedHistoryUsageEvents;
    }

    assert.deepEqual(
      archived.database
        .prepare("SELECT total FROM events ORDER BY timestamp_ms")
        .all()
        .map((row) => Number(row.total)),
      [60],
    );
    // The committed event update invalidated day markers; the three aggregate
    // tables and dirty queue remain the retry evidence.
    assert.deepEqual(rollupAggregateSnapshot(rollupSnapshot(archived.database)), rollupAggregateSnapshot(rollups150));
    assert.deepEqual(dirtyRollupDays(archived.database), ["2026-07-12"]);

    renameSync(missingCandidate, candidateFile);
    invalidateSource(oracle, usageFile);
    await oracle.sync({ options });
    await archived.sync({ options });
    assert.deepEqual(rollupSnapshot(archived.database), rollupSnapshot(oracle.database));
    assert.deepEqual(dirtyRollupDays(archived.database), []);
  } finally {
    archived.close();
    oracle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
