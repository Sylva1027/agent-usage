import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { createUsageExecutor } from "../src/usage-executor.js";
import { UsageStore } from "../src/usage-store.js";
import { createUsageRollups } from "../src/usage-rollups.js";

const START_MS = Date.parse("2026-01-02T03:04:05.000Z");
const END_MS = START_MS + 60_000;

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-commit-executor-"));
  const databaseFile = path.join(root, "active.sqlite");
  const candidateFile = path.join(root, "candidate.sqlite");
  const sourcePath = path.join(root, "source.jsonl");
  const store = new UsageStore({ homeDir: root, env: {}, importDirs: [], databaseFile });
  let succeeded = false;
  try {
    await store.open();
    await store.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    store.database
      .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sourcePath, "codex", "home", "Home", root, 1, 1, "2026-01-02T03:05:00.000Z");
    const insertEvent = store.database.prepare(`
      INSERT INTO events (
        source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
        hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [offset, sessionId, total] of [
      [0, "in-range-a", 20],
      [1, "in-range-b", 10],
      [60_000, "outside", 5],
    ]) {
      insertEvent.run(
        sourcePath,
        START_MS + offset,
        sessionId,
        "home",
        "Home",
        "main",
        "project",
        "gpt-6-luna",
        "hour",
        "day",
        "week",
        "month",
        total,
        total,
        0,
        0,
        0,
      );
    }
    createUsageRollups(store.database);
    await createHistoryArchiveCandidate(store.database, candidateFile, { startMs: START_MS, endMs: END_MS });
    const plan = JSON.parse(JSON.stringify(await prepareHistoryArchiveCommit(store.database, candidateFile)));
    const expectedEvents = JSON.parse(JSON.stringify(await store.publishedHistoryUsageEvents()));
    const changedEvent = store.database.prepare("SELECT id, total FROM events WHERE timestamp_ms = ?").get(START_MS);
    succeeded = true;
    return {
      root,
      databaseFile,
      plan,
      expectedEvents,
      changedEvent,
      executorOptions: { homeDir: root, env: {}, importDirs: [], databaseFile },
    };
  } finally {
    store.close();
    if (!succeeded) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("executor serializes archive commit and replay after a real source-change rejection", async () => {
  const fixture = await createFixture();
  const executor = createUsageExecutor(fixture.executorOptions);
  let writer = null;
  try {
    await executor.open();
    const before = (await executor.publishedUsageReport()).events;
    assert.deepEqual(before, fixture.expectedEvents);

    writer = new DatabaseSync(fixture.databaseFile);
    writer.exec("PRAGMA busy_timeout = 5000");
    writer.prepare("UPDATE events SET total = total + 1 WHERE id = ?").run(fixture.changedEvent.id);
    writer.close();
    writer = null;
    await assert.rejects(
      executor.commitHistoryArchiveEvents(fixture.plan),
      (error) => error?.code === "HISTORY_ARCHIVE_SOURCE_CHANGED",
    );
    assert.notDeepEqual(
      (await executor.publishedUsageReport()).events,
      before,
      "the queued read must observe the real source mutation",
    );

    writer = new DatabaseSync(fixture.databaseFile);
    writer.exec("PRAGMA busy_timeout = 5000");
    writer.prepare("UPDATE events SET total = ? WHERE id = ?").run(fixture.changedEvent.total, fixture.changedEvent.id);
    writer.close();
    writer = null;
    assert.deepEqual((await executor.publishedUsageReport()).events, before);

    const [committed, replayed] = await Promise.all([
      executor.commitHistoryArchiveEvents(fixture.plan),
      executor.commitHistoryArchiveEvents(fixture.plan),
    ]);
    assert.equal(committed.inserted, true);
    assert.equal(committed.replay, false);
    assert.equal(committed.deletedEventCount, 2);
    assert.equal(replayed.inserted, false);
    assert.equal(replayed.replay, true);
    assert.equal(replayed.deletedEventCount, 0);
    assert.deepEqual((await executor.publishedUsageReport()).events, before);
  } finally {
    writer?.close();
    await executor.close();
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
