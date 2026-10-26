import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { rebuildUsageRollups } from "../src/usage-rollups.js";
import { UsageStore } from "../src/usage-store.js";

const DAY_ONE = Date.parse("2026-07-12T00:00:00.000Z");
const DAY_TWO = Date.parse("2026-07-13T00:00:00.000Z");

function insertSource(database, homeId) {
  database
    .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      `/fixture/${homeId}.jsonl`,
      "zcode",
      homeId,
      "Same Home",
      `/fixture/${homeId}`,
      1,
      1,
      "2026-07-14T00:00:00.000Z",
    );
}

function insertEvent(database, { homeId, timestampMs, sessionId }) {
  const day = new Date(timestampMs).toISOString().slice(0, 10);
  database
    .prepare(`
      INSERT INTO events (
        source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
        hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      `/fixture/${homeId}.jsonl`,
      timestampMs,
      sessionId,
      homeId,
      "Same Home",
      "zcode",
      "fixture",
      "gpt-6-luna",
      `${new Date(timestampMs).toISOString().slice(0, 13).replace("T", " ")}:00`,
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

function rawCounts(database) {
  const totals = database
    .prepare("SELECT COUNT(*) AS event_count, COUNT(DISTINCT session_id) AS session_count FROM events")
    .get();
  const homes = database
    .prepare(`
      SELECT home_id, COUNT(*) AS event_count, COUNT(DISTINCT session_id) AS session_count
      FROM events GROUP BY home_id ORDER BY home_id
    `)
    .all();
  return {
    eventCount: Number(totals.event_count),
    sessionCount: Number(totals.session_count),
    homes: Object.fromEntries(
      homes.map((row) => [
        row.home_id,
        { eventCount: Number(row.event_count), sessionCount: Number(row.session_count) },
      ]),
    ),
  };
}

function metadataCounts(metadata) {
  return {
    eventCount: metadata.eventCount,
    sessionCount: metadata.sessionCount,
    homes: Object.fromEntries(
      metadata.homes.map((home) => [home.id, { eventCount: home.eventCount, sessionCount: home.sessionCount }]),
    ),
  };
}

function guardCountQueries(store) {
  const original = store.database.prepare;
  const counts = { rollupHomes: 0, fallbackHomes: 0, markerChecks: 0 };
  store.database.prepare = function guardedPrepare(sql) {
    const text = String(sql).replace(/\s+/g, " ").trim();
    if (text.includes("FROM usage_rollup_days")) counts.markerChecks += 1;
    if (text.includes("FROM usage_rollup_daily") && text.includes("GROUP BY home_id")) counts.rollupHomes += 1;
    if (text.includes("SELECT home_id, COUNT(*) AS event_count, COUNT(DISTINCT session_id) AS session_count")) {
      counts.fallbackHomes += 1;
    }
    return original.call(this, sql);
  };
  counts.reset = () => {
    counts.rollupHomes = 0;
    counts.fallbackHomes = 0;
    counts.markerChecks = 0;
  };
  counts.restore = () => {
    store.database.prepare = original;
  };
  return counts;
}

test("metadata counts use complete UTC rollups and fall back on a dirty day", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "metadata-rollup-counts-"));
  const databaseFile = path.join(root, "usage.sqlite");
  const store = new UsageStore({ homeDir: root, databaseFile, importDirs: [] });
  let guard;
  try {
    await store.open();
    store.database.exec("BEGIN");
    try {
      insertSource(store.database, "home-a");
      insertSource(store.database, "home-b");
      insertEvent(store.database, { homeId: "home-a", timestampMs: DAY_ONE + 1_000, sessionId: "shared" });
      insertEvent(store.database, { homeId: "home-a", timestampMs: DAY_TWO + 1_000, sessionId: "shared" });
      insertEvent(store.database, { homeId: "home-b", timestampMs: DAY_ONE + 2_000, sessionId: "shared" });
      insertEvent(store.database, { homeId: "home-b", timestampMs: DAY_ONE + 3_000, sessionId: "b-only" });
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }
    store.homes = store.publishedUsageHomes();
    rebuildUsageRollups(store.database, { days: ["2026-07-12", "2026-07-13"] });

    const asOf = new Date("2026-07-14T00:00:00.000Z");
    const expected = rawCounts(store.database);
    guard = guardCountQueries(store);
    assert.deepEqual(metadataCounts(store.metadata(asOf)), expected);
    assert.ok(guard.rollupHomes > 0 && guard.markerChecks > 0 && guard.fallbackHomes === 0);

    const writer = new DatabaseSync(databaseFile);
    try {
      writer.exec("BEGIN");
      insertEvent(writer, { homeId: "home-a", timestampMs: DAY_ONE + 4_000, sessionId: "new-session" });
      writer.exec("COMMIT");
    } finally {
      writer.close();
    }
    const changedExpected = rawCounts(store.database);
    guard.reset();
    assert.deepEqual(metadataCounts(store.metadata(asOf)), changedExpected);
    assert.ok(guard.markerChecks > 0 && guard.fallbackHomes > 0 && guard.rollupHomes === 0);
  } finally {
    guard?.restore();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("authority keeps metadata hot-only even when complete rollups include the cold tail", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "metadata-rollup-authority-"));
  const databaseFile = path.join(root, "usage.sqlite");
  const candidateFile = path.join(root, "candidate.sqlite");
  const store = new UsageStore({ homeDir: root, databaseFile, importDirs: [] });
  try {
    await store.open();
    store.database.exec("BEGIN");
    try {
      insertSource(store.database, "home-a");
      for (let index = 0; index < 3; index += 1) {
        insertEvent(store.database, {
          homeId: "home-a",
          timestampMs: DAY_ONE + 1_000 + index,
          sessionId: "cold-session",
        });
      }
      for (let index = 0; index < 2; index += 1) {
        insertEvent(store.database, {
          homeId: "home-a",
          timestampMs: DAY_ONE + 12 * 60 * 60 * 1_000 + index,
          sessionId: "hot-session",
        });
      }
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }
    store.homes = store.publishedUsageHomes();

    const cutMs = DAY_ONE + 12 * 60 * 60 * 1_000;
    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: DAY_ONE,
      endMs: cutMs,
    });
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    store.database.exec("BEGIN IMMEDIATE");
    try {
      store.database
        .prepare("INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)")
        .run(
          "history_archive_event_authority",
          JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }),
        );
      store.database.prepare("DELETE FROM events WHERE timestamp_ms < ?").run(cutMs);
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }

    await store.rebuildHistoryRollups();
    const asOf = new Date("2026-07-14T00:00:00.000Z");
    const hot = store.metadata(asOf);
    const complete = await store.metadataHistory(asOf);
    assert.equal(
      Number(
        store.database
          .prepare("SELECT SUM(event_count) AS count FROM usage_rollup_daily WHERE calendar_zone = 'utc'")
          .get().count,
      ),
      5,
    );
    assert.deepEqual(metadataCounts(hot), rawCounts(store.database));
    assert.equal(complete.eventCount, 5);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
