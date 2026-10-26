import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { createUsageExecutor } from "../src/usage-executor.js";
import { UsageStore } from "../src/usage-store.js";

const AUTHORITY_META = "history_archive_event_authority";
const COLD_TIME = "2026-07-12T02:00:00.000Z";
const HOT_TIME = "2026-07-13T23:01:00.000Z";
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

function sourcePrefix(codexHome) {
  return [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "executor-rollup-rebuild-session", source: "cli", cwd: codexHome },
    }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-luna" } }),
  ].join("\n");
}

function sourceOptions(root, codexHome) {
  return {
    homeDir: root,
    env: {},
    extraHomes: codexHome,
    importDirs: [],
    automaticDiscoveryEnabled: false,
  };
}

function rollupRows(database, table, orderBy, zone) {
  return database
    .prepare(`SELECT * FROM ${table} WHERE calendar_zone = ? ORDER BY ${orderBy}`)
    .all(zone)
    .map((row) => ({ ...row }));
}

function rollupSnapshot(databaseFile) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return Object.fromEntries(
      ["utc", "local"].map((zone) => [
        zone,
        Object.fromEntries(
          ROLLUP_TABLES.map(([table, orderBy]) => [table, rollupRows(database, table, orderBy, zone)]),
        ),
      ]),
    );
  } finally {
    database.close();
  }
}

function factsSnapshot(databaseFile) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return database
      .prepare("SELECT timestamp_ms, total FROM events ORDER BY timestamp_ms")
      .all()
      .map((row) => ({ ...row }));
  } finally {
    database.close();
  }
}

async function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-rollup-executor-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-rollup-rebuild.jsonl");
  const databaseFile = path.join(root, "usage.sqlite");
  const oracleFile = path.join(root, "oracle.sqlite");
  const segmentFile = path.join(root, "cold.sqlite");
  const options = sourceOptions(root, codexHome);
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    const prefix = sourcePrefix(codexHome);
    writeFileSync(usageFile, `${prefix}\n${tokenLine(COLD_TIME, 100, 100)}\n`);

    const source = new UsageStore({ ...options, databaseFile });
    try {
      await source.sync({ options });
      await createHistoryArchiveCandidate(source.database, segmentFile, {
        startMs: Date.parse(COLD_TIME),
        endMs: Date.parse(HOT_TIME),
      });
      const registered = await source.registerHistoryArchiveCandidate(segmentFile);
      source.database
        .prepare("INSERT INTO store_meta (key, value) VALUES (?, ?)")
        .run(AUTHORITY_META, JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }));
      source.database.exec("BEGIN IMMEDIATE");
      try {
        source.database.prepare("DELETE FROM events WHERE source_path = ?").run(usageFile);
        source.database.exec("COMMIT");
      } catch (error) {
        source.database.exec("ROLLBACK");
        throw error;
      }
      writeFileSync(usageFile, `${prefix}\n${tokenLine(COLD_TIME, 100, 100)}\n${tokenLine(HOT_TIME, 130, 30)}\n`);
      source.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(usageFile);
      await source.sync({ options });
    } finally {
      source.close();
    }

    const oracle = new UsageStore({ ...options, databaseFile: oracleFile });
    try {
      await oracle.sync({ options });
    } finally {
      oracle.close();
    }

    const writable = new DatabaseSync(databaseFile);
    try {
      for (const [table] of ROLLUP_TABLES) writable.exec(`DELETE FROM ${table}`);
    } finally {
      writable.close();
    }

    return {
      root,
      databaseFile,
      oracleFile,
      segmentFile,
      executorOptions: { ...options, databaseFile, importStoreFile: path.join(root, "imports.json") },
      close() {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    throw error;
  }
}

test("executor rebuilds dual-zone history rollups and preserves them on missing segments", async () => {
  const fixture = await createFixture();
  let executor;
  try {
    const factsBefore = factsSnapshot(fixture.databaseFile);
    executor = createUsageExecutor(fixture.executorOptions);
    assert.deepEqual(await executor.rebuildHistoryRollups(), { rebuilt: true });
    assert.equal(executor.metadata()?.eventCount, 1);

    const rebuilt = rollupSnapshot(fixture.databaseFile);
    assert.deepEqual(rebuilt, rollupSnapshot(fixture.oracleFile));
    assert.deepEqual(factsSnapshot(fixture.databaseFile), factsBefore);
    assert.deepEqual(
      rebuilt.utc.usage_rollup_daily.map(({ day_key, total }) => ({ day_key, total })),
      [
        { day_key: "2026-07-12", total: 100 },
        { day_key: "2026-07-13", total: 30 },
      ],
    );

    const missing = `${fixture.segmentFile}.missing`;
    renameSync(fixture.segmentFile, missing);
    try {
      await assert.rejects(executor.rebuildHistoryRollups(), (error) => error?.code === "ENOENT");
      assert.deepEqual(rollupSnapshot(fixture.databaseFile), rebuilt);
      assert.equal((await executor.historyArchives()).counts.segments, 1);
    } finally {
      renameSync(missing, fixture.segmentFile);
    }

    const summary = await executor.summarize({
      preset: "all",
      now: "2026-07-14T12:00:00.000Z",
      calendarZone: "utc",
    });
    assert.equal(summary.totals.total, 130);
    assert.equal(summary.eventCount, 2);
  } finally {
    await executor?.close();
    fixture.close();
  }
});
