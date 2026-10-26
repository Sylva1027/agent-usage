import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { createUsageExecutor } from "../src/usage-executor.js";
import { UsageStore } from "../src/usage-store.js";

const COLD_TIME = "2026-07-12T02:00:00.000Z";
const HOT_TIME = "2026-07-12T02:01:00.000Z";
const AS_OF = "2026-07-15T12:00:00.000Z";
const COLD_MS = Date.parse(COLD_TIME);
const HOT_MS = Date.parse(HOT_TIME);
const SESSION_ID = "cold-snapshot-executor-session";

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

function sessionPrefix(codexHome) {
  return [
    JSON.stringify({
      type: "session_meta",
      payload: { id: SESSION_ID, source: "cli", cwd: codexHome },
    }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-sol" } }),
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

function liveRegistry(databaseFile) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return {
      segments: database
        .prepare("SELECT segment_id, database_path FROM archive_segments ORDER BY segment_id")
        .all()
        .map((row) => ({ ...row })),
      authority:
        database.prepare("SELECT value FROM store_meta WHERE key = ?").get("history_archive_event_authority")?.value ??
        null,
    };
  } finally {
    database.close();
  }
}

async function createArchivedFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "cold-snapshot-executor-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-cold-snapshot.jsonl");
  const databaseFile = path.join(root, "usage-index.sqlite");
  const segmentFile = path.join(root, "cold-segment.sqlite");
  const source = sourceOptions(root, codexHome);
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(
      usageFile,
      `${sessionPrefix(codexHome)}\n${tokenLine(COLD_TIME, 100, 100)}\n${tokenLine(HOT_TIME, 130, 30)}\n`,
    );
    const store = new UsageStore({ ...source, databaseFile });
    try {
      await store.sync({ options: source });
      await createHistoryArchiveCandidate(store.database, segmentFile, {
        startMs: COLD_MS,
        endMs: HOT_MS,
      });
      const registered = await store.registerHistoryArchiveCandidate(segmentFile);
      store.database
        .prepare("INSERT INTO store_meta (key, value) VALUES (?, ?)")
        .run(
          "history_archive_event_authority",
          JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }),
        );
      store.database.exec("BEGIN IMMEDIATE");
      try {
        store.database.prepare("DELETE FROM events WHERE source_path = ?").run(usageFile);
        store.database.exec("COMMIT");
      } catch (error) {
        store.database.exec("ROLLBACK");
        throw error;
      }
      store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(usageFile);
      await store.sync({ options: source });
    } finally {
      store.close();
    }
    return {
      root,
      databaseFile,
      segmentFile,
      executorOptions: { ...source, databaseFile, importStoreFile: path.join(root, "imports.json") },
      close() {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    throw error;
  }
}

test("executor snapshot keeps verified cold segments in a private self-contained copy", async () => {
  const fixture = await createArchivedFixture();
  const snapshotFile = path.join(fixture.root, "snapshot.sqlite");
  let executor;
  try {
    executor = createUsageExecutor(fixture.executorOptions);
    await executor.sync({ options: fixture.executorOptions });
    const before = liveRegistry(fixture.databaseFile);
    const frozen = await executor.snapshot({ databaseFile: snapshotFile, asOf: Date.parse(AS_OF) });
    assert.equal(frozen.metadata.eventCount, 2);
    assert.equal(frozen.cleanupDirectory, `${snapshotFile}.segments`);
    assert.deepEqual(liveRegistry(fixture.databaseFile), before);

    const snapshotDatabase = new DatabaseSync(snapshotFile, { readOnly: true });
    let copiedSegments;
    try {
      copiedSegments = snapshotDatabase
        .prepare("SELECT database_path FROM archive_segments ORDER BY segment_id")
        .all()
        .map((row) => path.resolve(String(row.database_path)));
    } finally {
      snapshotDatabase.close();
    }
    assert.equal(copiedSegments.length, 1);
    assert.notEqual(copiedSegments[0], path.resolve(fixture.segmentFile));
    assert.equal(path.dirname(copiedSegments[0]), path.join(frozen.cleanupDirectory, "segments"));

    renameSync(fixture.segmentFile, `${fixture.segmentFile}.moved`);
    const snapshot = new UsageStore({ databaseFile: snapshotFile });
    try {
      await snapshot.open();
      const summary = await snapshot.summarizeHistory({
        preset: "all",
        now: AS_OF,
        calendarZone: "utc",
      });
      const metadata = await snapshot.metadataHistory(new Date(AS_OF));
      assert.equal(summary.totals.total, 130);
      assert.equal(summary.eventCount, 2);
      assert.equal(metadata.eventCount, 2);
    } finally {
      snapshot.close();
    }
  } finally {
    await executor?.close();
    fixture.close();
  }
});

test("executor snapshot rejects a missing cold segment without leaving a partial product", async () => {
  const fixture = await createArchivedFixture();
  const snapshotFile = path.join(fixture.root, "missing-snapshot.sqlite");
  let executor;
  try {
    rmSync(fixture.segmentFile);
    executor = createUsageExecutor(fixture.executorOptions);
    await executor.open();
    await assert.rejects(
      executor.snapshot({ databaseFile: snapshotFile, asOf: Date.parse(AS_OF) }),
      (error) => error.code === "HISTORY_ARCHIVE_SEGMENT_NOT_FOUND",
    );
    assert.equal(existsSync(snapshotFile), false);
    assert.equal(existsSync(`${snapshotFile}-wal`), false);
    assert.equal(existsSync(`${snapshotFile}-shm`), false);
    assert.equal(existsSync(`${snapshotFile}.segments`), false);
  } finally {
    await executor?.close();
    fixture.close();
  }
});
