import assert from "node:assert/strict";
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { createUsageExecutor, readHistoryArchiveDays } from "../src/usage-executor.js";
import { UsageStore } from "../src/usage-store.js";

const RANGE_START_MS = Date.parse("2026-07-12T23:00:00.000Z");
const RANGE_END_MS = Date.parse("2026-07-14T00:00:00.000Z");
const EVENTS = [
  [Date.parse("2026-07-12T23:50:00.000Z"), 13, 8, 2, 3, 1],
  [Date.parse("2026-07-13T00:10:00.000Z"), 21, 10, 4, 5, 2],
  [Date.parse("2026-07-13T23:50:00.000Z"), 34, 20, 8, 5, 1],
  [RANGE_END_MS, 1_000, 900, 0, 100, 0],
];

function dayAndKeys(timestampMs) {
  const day = new Date(timestampMs).toISOString().slice(0, 10);
  return [`${day.slice(0, 7)}`, day];
}

function seedEvents(database, sourcePath, root) {
  database
    .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(sourcePath, "codex", "home", "Home", root, 1, 1, "2026-07-14T00:00:00.000Z");
  const insert = database.prepare(`
    INSERT INTO events (
      source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
      hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [timestampMs, total, input, cached, output, reasoning] of EVENTS) {
    const [month, day] = dayAndKeys(timestampMs);
    insert.run(
      sourcePath,
      timestampMs,
      "archive-days-session",
      "home",
      "Home",
      "codex",
      "project",
      "gpt-6-sol",
      `${day} 00:00`,
      day,
      day,
      month,
      total,
      input,
      cached,
      output,
      reasoning,
    );
  }
}

async function createFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-days-executor-"));
  const databaseFile = path.join(root, "usage-index.sqlite");
  const candidateFile = path.join(root, "candidate.sqlite");
  const sourcePath = path.join(root, "rollout.jsonl");
  const options = {
    homeDir: root,
    env: {},
    databaseFile,
    importStoreFile: path.join(root, "imports.json"),
    importDirs: [],
    automaticDiscoveryEnabled: false,
  };
  try {
    const store = new UsageStore(options);
    let segmentId;
    try {
      await store.open();
      seedEvents(store.database, sourcePath, root);
      await createHistoryArchiveCandidate(store.database, candidateFile, {
        startMs: RANGE_START_MS,
        endMs: RANGE_END_MS,
      });
      segmentId = (await store.registerHistoryArchiveCandidate(candidateFile)).segmentId;
    } finally {
      store.close();
    }
    return {
      root,
      databaseFile,
      candidateFile,
      options,
      segmentId,
      close() {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    throw error;
  }
}

function sourceSqlOracle(databaseFile, startMs, endMs) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT date(timestamp_ms / 1000, 'unixepoch') AS day,
                COUNT(*) AS eventCount,
                SUM(total) AS total,
                SUM(input) AS input,
                SUM(cached) AS cached,
                SUM(output) AS output,
                SUM(reasoning) AS reasoning
         FROM events
         WHERE timestamp_ms >= ? AND timestamp_ms < ?
         GROUP BY day
         ORDER BY day`,
      )
      .all(startMs, endMs)
      .map((row) => ({
        day: String(row.day),
        eventCount: Number(row.eventCount),
        totals: {
          total: Number(row.total),
          input: Number(row.input),
          cached: Number(row.cached),
          output: Number(row.output),
          reasoning: Number(row.reasoning),
        },
      }));
  } finally {
    database.close();
  }
}

test("sealed archive day view matches source SQL and excludes hot rows", async () => {
  const fixture = await createFixture();
  const store = new UsageStore(fixture.options);
  const executor = createUsageExecutor(fixture.options);
  try {
    const expectedDays = sourceSqlOracle(fixture.databaseFile, RANGE_START_MS, RANGE_END_MS);
    const helperResult = await readHistoryArchiveDays(store, fixture.segmentId);
    const executorResult = await executor.historyArchiveDays(fixture.segmentId);

    assert.deepEqual(helperResult, {
      segmentId: fixture.segmentId,
      calendarZone: "utc",
      view: "sealed",
      days: expectedDays,
    });
    assert.deepEqual(executorResult, helperResult);
    assert.equal(
      helperResult.days.reduce((sum, day) => sum + day.eventCount, 0),
      3,
    );
    assert.equal(
      helperResult.days.reduce((sum, day) => sum + day.totals.total, 0),
      68,
    );

    const allSourceDays = sourceSqlOracle(fixture.databaseFile, RANGE_START_MS, RANGE_END_MS + 1);
    assert.equal(allSourceDays.find((day) => day.day === "2026-07-14").eventCount, 1);
    assert.equal(
      helperResult.days.some((day) => day.day === "2026-07-14"),
      false,
    );
  } finally {
    store.close();
    await executor.close();
    fixture.close();
  }
});

test("day view rejects a missing sealed file and recovers after restore", async () => {
  const fixture = await createFixture();
  const movedFile = `${fixture.candidateFile}.moved`;
  const store = new UsageStore(fixture.options);
  const executor = createUsageExecutor(fixture.options);
  try {
    const expected = await readHistoryArchiveDays(store, fixture.segmentId);
    renameSync(fixture.candidateFile, movedFile);
    await assert.rejects(readHistoryArchiveDays(store, fixture.segmentId), (error) => error.code === "ENOENT");
    await assert.rejects(executor.historyArchiveDays(fixture.segmentId), (error) => error.code === "ENOENT");

    renameSync(movedFile, fixture.candidateFile);
    assert.deepEqual(await readHistoryArchiveDays(store, fixture.segmentId), expected);
    assert.deepEqual(await executor.historyArchiveDays(fixture.segmentId), expected);
  } finally {
    if (existsSync(movedFile)) renameSync(movedFile, fixture.candidateFile);
    store.close();
    await executor.close();
    fixture.close();
  }
});

test("day view preserves the store rejection for an unknown segment id", async () => {
  const fixture = await createFixture();
  const store = new UsageStore(fixture.options);
  const executor = createUsageExecutor(fixture.options);
  const unknownId = "0".repeat(64);
  try {
    await assert.rejects(
      readHistoryArchiveDays(store, unknownId),
      (error) => error.code === "HISTORY_ARCHIVE_SEGMENT_NOT_FOUND",
    );
    await assert.rejects(
      executor.historyArchiveDays(unknownId),
      (error) => error.code === "HISTORY_ARCHIVE_SEGMENT_NOT_FOUND",
    );
  } finally {
    store.close();
    await executor.close();
    fixture.close();
  }
});
