import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { normalizePerfSample, PERF_METHOD_VERSION } from "../src/perf-stats.js";
import { createUsageExecutor } from "../src/usage-executor.js";
import { UsageStore } from "../src/usage-store.js";

const AUTHORITY_KEY = "history_archive_event_authority";

function newStore(root, databaseFile) {
  return new UsageStore({ homeDir: root, databaseFile, importDirs: [] });
}

function seedEvents(database, sourcePath, root) {
  database
    .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(sourcePath, "zcode", "home", "Home", root, 1, 1, "2026-07-17T12:00:00.000Z");
  const insert = database.prepare(`
    INSERT INTO events (
      source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
      hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [day, total] of [
    ["2026-07-12", 10],
    ["2026-07-13", 20],
    ["2026-07-14", 25],
    ["2026-07-15", 20],
    ["2026-07-16", 25],
    ["2026-07-17", 30],
  ]) {
    const date = new Date(`${day}T02:00:00.000Z`);
    const weekStart = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((date.getUTCDay() || 7) - 1)),
    );
    insert.run(
      sourcePath,
      date.getTime(),
      `session-${day}`,
      "home",
      "Home",
      "main",
      "project",
      "gpt-6-sol",
      `${day} 02:00`,
      day,
      weekStart.toISOString().slice(0, 10),
      day.slice(0, 7),
      total,
      total - 1,
      0,
      1,
      0,
    );
  }
}

function seedPerf(store, sourcePath) {
  const normalized = normalizePerfSample({
    sourceKind: "zcode",
    identity: ["summary-perf"],
    homeId: "home",
    sourcePath,
    channel: "zcode",
    agentKind: "unknown",
    agent: "",
    sessionId: "perf-session",
    turnKey: "",
    model: "gpt-6-sol",
    modelProvider: "",
    reasoningEffort: "",
    modelEvidence: "",
    status: "completed",
    tsMs: Date.parse("2026-07-14T02:00:00.000Z"),
    windowStartMs: Date.parse("2026-07-14T02:00:00.000Z"),
    windowEndMs: Date.parse("2026-07-14T02:00:01.000Z"),
    durationMs: 1_000,
    outputTokens: 100,
    requestCount: 1,
  });
  assert.ok(normalized.sample, JSON.stringify(normalized.warnings));
  store.insertPerfSample(normalized.sample);
  store.writePerfState("ready");
  store.writeMeta("perf_method_version", PERF_METHOD_VERSION);
  store.writeMeta("perf_index_version", "summary-perf-index");
  store.writeMeta("perf_indexed_at", "2026-07-17T12:00:00.000Z");
}

function writeAuthority(database, segmentId) {
  database
    .prepare("INSERT INTO store_meta (key, value) VALUES (?, ?)")
    .run(AUTHORITY_KEY, JSON.stringify({ formatVersion: 1, segmentIds: [segmentId] }));
}

test("executor summary uses cold history while preserving perf and records", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-summary-executor-"));
  const sourcePath = path.join(root, "summary-source.jsonl");
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
    seedPerf(store, sourcePath);
    seedPerf(oracle, sourcePath);

    const coldStartMs = Date.parse("2026-07-12T00:00:00.000Z");
    const hotStartMs = Date.parse("2026-07-17T00:00:00.000Z");
    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: coldStartMs,
      endMs: hotStartMs,
    });
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    store.database.exec("BEGIN IMMEDIATE");
    try {
      writeAuthority(store.database, registered.segmentId);
      store.database.prepare("DELETE FROM events WHERE timestamp_ms < ?").run(hotStartMs);
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }
    store.close();
    oracle.close();
    store = null;
    oracle = null;

    const filters = {
      preset: "custom",
      startDate: "2026-07-12",
      endDate: "2026-07-17",
      now: "2026-07-17T12:00:00.000Z",
      calendarZone: "utc",
    };
    const expected = newStore(root, oracleFile);
    await expected.open();
    const oracleSummary = expected.summarize(filters);
    expected.close();

    executor = createUsageExecutor({ homeDir: root, databaseFile, importDirs: [] });
    const direct = await executor.summarize(filters);
    const dashboard = await executor.dashboard(filters);
    const directPeriod = await executor.periodComparison({
      now: filters.now,
      calendarZone: filters.calendarZone,
    });

    assert.equal(direct.totals.total, 130);
    assert.equal(dashboard.summary.totals.total, 130);
    assert.equal(dashboard.metadata.eventCount, 6);
    assert.equal(dashboard.periodComparison.totals.all.total, 130);
    assert.equal(directPeriod.totals.all.total, 130);
    assert.deepEqual(direct.perf, oracleSummary.perf);
    assert.deepEqual(direct.records, oracleSummary.records);
    assert.equal(direct.perf.state, "ready");
    assert.ok(Object.keys(direct.records).length > 0);

    rmSync(candidateFile);
    await assert.rejects(executor.summarize(filters), (error) => error.code === "ENOENT");
    await assert.rejects(executor.dashboard(filters), (error) => error.code === "ENOENT");
  } finally {
    store?.close();
    oracle?.close();
    await executor?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
