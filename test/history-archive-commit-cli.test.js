import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate, verifyPublishedHistoryArchiveBundle } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";
import { createUsageRollups } from "../src/usage-rollups.js";

const START_MS = Date.parse("2026-01-02T03:04:05.000Z");
const END_MS = START_MS + 60_000;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function runCli(args, homeDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/cli.js", ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
  });
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-commit-cli-"));
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
    const expectedEvents = JSON.parse(JSON.stringify(await store.publishedHistoryUsageEvents()));
    succeeded = true;
    return { root, databaseFile, candidateFile, expectedEvents };
  } finally {
    store.close();
    if (!succeeded) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function snapshotSource(databaseFile) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return JSON.parse(
      JSON.stringify({
        events: database.prepare("SELECT * FROM events ORDER BY id").all(),
        segments: database.prepare("SELECT * FROM archive_segments ORDER BY segment_id").all(),
        metadata: database.prepare("SELECT * FROM store_meta ORDER BY key").all(),
      }),
    );
  } finally {
    database.close();
  }
}

test("history archive explicit commit backs up, commits, and replays the prepared segment", async () => {
  const fixture = await createFixture();
  const bundleDirectory = path.join(fixture.root, "bundle");
  const replayBundleDirectory = path.join(fixture.root, "replay-bundle");
  let store;
  try {
    const result = await runCli(
      ["history", "archive", fixture.databaseFile, "--commit", fixture.candidateFile, "--backup", bundleDirectory],
      fixture.root,
    );
    assert.equal(result.code, 0, result.output);
    await verifyPublishedHistoryArchiveBundle(bundleDirectory);

    store = new UsageStore({
      homeDir: fixture.root,
      env: {},
      importDirs: [],
      databaseFile: fixture.databaseFile,
    });
    await store.open();
    const hotEventsInRange = Number(
      store.database
        .prepare("SELECT COUNT(*) AS count FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ?")
        .get(START_MS, END_MS).count,
    );
    const publishedEvents = await store.publishedHistoryUsageEvents();
    const segmentCount = Number(store.database.prepare("SELECT COUNT(*) AS count FROM archive_segments").get().count);

    assert.equal(hotEventsInRange, 0);
    assert.deepEqual(publishedEvents, fixture.expectedEvents);
    assert.equal(segmentCount, 1);
    store.close();
    store = null;
    const committedSource = snapshotSource(fixture.databaseFile);

    const replay = await runCli(
      [
        "history",
        "archive",
        fixture.databaseFile,
        "--commit",
        fixture.candidateFile,
        "--backup",
        replayBundleDirectory,
      ],
      fixture.root,
    );
    assert.equal(replay.code, 0, replay.output);
    assert.match(replay.output, /Deleted events: 0\b/);
    assert.match(replay.output, /Replay: yes\b/);
    await verifyPublishedHistoryArchiveBundle(replayBundleDirectory);

    store = new UsageStore({
      homeDir: fixture.root,
      env: {},
      importDirs: [],
      databaseFile: fixture.databaseFile,
    });
    await store.open();
    assert.deepEqual(await store.publishedHistoryUsageEvents(), fixture.expectedEvents);
    assert.deepEqual(snapshotSource(fixture.databaseFile), committedSource);
  } finally {
    store?.close();
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("history archive explicit commit rejects a bad candidate or existing backup without source writes", async () => {
  const fixture = await createFixture();
  const badBundleDirectory = path.join(fixture.root, "bad-bundle");
  const existingBundleDirectory = path.join(fixture.root, "existing-bundle");
  try {
    const originalCandidate = await readFile(fixture.candidateFile);
    await appendFile(fixture.candidateFile, Buffer.from([0]));
    const beforeBadCandidate = snapshotSource(fixture.databaseFile);
    const badCandidate = await runCli(
      ["history", "archive", fixture.databaseFile, "--commit", fixture.candidateFile, "--backup", badBundleDirectory],
      fixture.root,
    );
    await writeFile(fixture.candidateFile, originalCandidate);
    assert.notEqual(badCandidate.code, 0, badCandidate.output);
    assert.match(badCandidate.output, /\bHISTORY_BACKUP_SIZE_MISMATCH\b/);
    assert.deepEqual(snapshotSource(fixture.databaseFile), beforeBadCandidate);

    await mkdir(existingBundleDirectory);
    await writeFile(path.join(existingBundleDirectory, "sentinel"), "keep");
    const beforeExistingBackup = snapshotSource(fixture.databaseFile);
    const existingBackup = await runCli(
      [
        "history",
        "archive",
        fixture.databaseFile,
        "--commit",
        fixture.candidateFile,
        "--backup",
        existingBundleDirectory,
      ],
      fixture.root,
    );
    assert.notEqual(existingBackup.code, 0, existingBackup.output);
    assert.match(existingBackup.output, /\bHISTORY_ARCHIVE_STAGING_DESTINATION_EXISTS\b/);
    assert.deepEqual(snapshotSource(fixture.databaseFile), beforeExistingBackup);
    assert.equal(await readFile(path.join(existingBundleDirectory, "sentinel"), "utf8"), "keep");
  } finally {
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
