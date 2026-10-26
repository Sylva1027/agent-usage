import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { createUsageExecutor } from "../src/usage-executor.js";
import { UsageStore } from "../src/usage-store.js";

const AUTHORITY_KEY = "history_archive_event_authority";
const COLD_START_MS = Date.parse("2026-07-12T00:00:00.000Z");
const HOT_START_MS = Date.parse("2026-07-15T00:00:00.000Z");
const COLD_EVENTS = 100;
const HOT_EVENTS = 30;

function newStore(root, databaseFile) {
  return new UsageStore({ homeDir: root, databaseFile, importDirs: [] });
}

function seedEvents(database, sourcePath, root) {
  database
    .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(sourcePath, "zcode", "home", "Home", root, 1, 1, "2026-07-15T00:00:00.000Z");
  const insert = database.prepare(`
    INSERT INTO events (
      source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
      hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRange = (startMs, count, sessionId) => {
    for (let index = 0; index < count; index += 1) {
      const timestampMs = startMs + index * 1_000;
      const iso = new Date(timestampMs).toISOString();
      const day = iso.slice(0, 10);
      insert.run(
        sourcePath,
        timestampMs,
        sessionId,
        "home",
        "Home",
        "zcode",
        "project",
        "gpt-6-luna",
        `${iso.slice(0, 13).replace("T", " ")}:00`,
        day,
        day,
        day.slice(0, 7),
        1,
        1,
        0,
        0,
        0,
      );
    }
  };
  insertRange(COLD_START_MS, COLD_EVENTS, "cold-session");
  insertRange(HOT_START_MS, HOT_EVENTS, "hot-session");
}

function writeAuthority(database, segmentId) {
  database
    .prepare("INSERT INTO store_meta (key, value) VALUES (?, ?)")
    .run(AUTHORITY_KEY, JSON.stringify({ formatVersion: 1, segmentIds: [segmentId] }));
}

test("executor metadata and dashboard include authorized cold history", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-metadata-executor-"));
  const sourcePath = path.join(root, "metadata-source.jsonl");
  const candidateFile = path.join(root, "candidate.sqlite");
  const databaseFile = path.join(root, "usage-index.sqlite");
  const oracleFile = path.join(root, "oracle.sqlite");
  let store = newStore(root, databaseFile);
  let oracle = newStore(root, oracleFile);
  let executor;
  try {
    await store.open();
    await oracle.open();
    seedEvents(store.database, sourcePath, root);
    seedEvents(oracle.database, sourcePath, root);

    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: COLD_START_MS,
      endMs: HOT_START_MS,
    });
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    store.database.exec("BEGIN IMMEDIATE");
    try {
      writeAuthority(store.database, registered.segmentId);
      store.database.prepare("DELETE FROM events WHERE timestamp_ms < ?").run(HOT_START_MS);
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }

    const coldStart = new Date(COLD_START_MS);
    const oracleMetadata = oracle.metadata(coldStart);
    store.close();
    oracle.close();
    store = null;
    oracle = null;

    const filters = {
      preset: "custom",
      startDate: "2026-07-12",
      endDate: "2026-07-16",
      now: "2026-07-15T12:00:00.000Z",
      calendarZone: "utc",
    };
    executor = createUsageExecutor({ homeDir: root, databaseFile, importDirs: [] });
    const metadata = await executor.metadataFor(coldStart);
    assert.equal(metadata.eventCount, COLD_EVENTS + HOT_EVENTS);
    assert.equal(metadata.modelLastSeen.ZCode["gpt-6-luna"], COLD_START_MS);
    assert.deepEqual({ ...metadata, generatedAt: "" }, { ...oracleMetadata, generatedAt: "" });

    const dashboard = await executor.dashboard(filters);
    assert.equal(dashboard.metadata.eventCount, COLD_EVENTS + HOT_EVENTS);
    assert.equal(dashboard.summary.totals.total, COLD_EVENTS + HOT_EVENTS);
    assert.equal(dashboard.periodComparison.totals.all.total, dashboard.summary.totals.total);

    rmSync(candidateFile);
    await assert.rejects(executor.metadataFor(coldStart), (error) => error.code === "ENOENT");
    await assert.rejects(executor.dashboard(filters), (error) => error.code === "ENOENT");
  } finally {
    store?.close();
    oracle?.close();
    await executor?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
