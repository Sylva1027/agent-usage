import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createHistoryArchiveCandidate,
  loadHistoryArchiveImport,
  publishHistoryArchiveBundle,
} from "../src/history-archive.js";
import { PERF_METHOD_VERSION, PERF_TOKEN_SCOPE } from "../src/perf-stats.js";
import { createUsageExecutor } from "../src/usage-executor.js";
import { UsageStore } from "../src/usage-store.js";

const START_MS = Date.parse("2026-07-12T02:00:00.000Z");
const END_MS = Date.parse("2026-07-12T02:01:00.000Z");
const SESSION_ID = "archive-import-executor-session";
const TOKENIZER = "o200k_base";

function fileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function usageLine(timestamp, total, lastTotal) {
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

function writeMeta(database, key, value) {
  database
    .prepare(
      `INSERT INTO store_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, JSON.stringify(value));
}

function rolloutContents(codexHome) {
  return [
    JSON.stringify({
      type: "session_meta",
      payload: { id: SESSION_ID, source: "cli", cwd: codexHome },
    }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-sol" } }),
    usageLine("2026-07-12T02:00:00.000Z", 100, 100),
  ].join("\n");
}

function schema4RolloutContents(codexHome) {
  return [
    JSON.stringify({
      type: "session_meta",
      payload: { id: SESSION_ID, source: "cli", cwd: codexHome },
    }),
    JSON.stringify({
      type: "turn_context",
      payload: { thread_id: SESSION_ID, turn_id: "turn-schema4", model: "gpt-6-sol" },
    }),
    JSON.stringify({
      timestamp: "2026-07-12T02:00:10.000Z",
      type: "token_usage_record",
      payload: {
        thread_id: SESSION_ID,
        turn_id: "turn-schema4",
        response_id: "response-schema4",
        usage: { output_tokens: 10, reasoning_output_tokens: 0 },
        turn_token_usage: { output_tokens: 10 },
        generation_timing: {
          schema_version: 4,
          tokenizer: TOKENIZER,
          clock: "transport_receive",
          output_tokens: 42,
          observed_duration_ms: 1_000,
          windows: [{ start_ms: 0, end_ms: 1_000, output_tokens: 42 }],
        },
      },
    }),
    JSON.stringify({
      timestamp: "2026-07-12T02:00:11.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        thread_id: SESSION_ID,
        turn_id: "turn-schema4",
        started_at: Math.floor(START_MS / 1000),
        completed_at: Math.floor(START_MS / 1000) + 1,
        duration_ms: 1_000,
      },
    }),
  ].join("\n");
}

function optionsFor(root, codexHome) {
  return {
    homeDir: root,
    env: {},
    extraHomes: codexHome,
    importDirs: [],
    automaticDiscoveryEnabled: false,
  };
}

function stableCarrier(report) {
  return {
    events: report.events.map((event) => ({
      timestamp: event.timestamp,
      sessionId: event.sessionId,
      total: event.total,
    })),
    sessions: report.sessions.map((session) => ({
      id: session.id,
      homeId: session.homeId,
      eventCount: session.eventCount,
      total: session.total,
    })),
    homes: report.homes.map((home) => ({ id: home.id, kind: home.kind, path: home.path })),
    rateLimitObservations: report.rateLimitObservations,
  };
}

async function createPublishedFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-import-executor-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-import-executor.jsonl");
  const sourceOptions = optionsFor(root, codexHome);
  const databaseFile = path.join(root, "active.sqlite");
  const candidateFile = path.join(root, "candidate.sqlite");
  const bundleDirectory = path.join(root, "published");
  const store = new UsageStore({ ...sourceOptions, databaseFile });
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(usageFile, `${rolloutContents(codexHome)}\n`);
    await store.sync({ options: sourceOptions });
    const expected = stableCarrier(store.publishedUsageReport());
    await createHistoryArchiveCandidate(store.database, candidateFile, { startMs: START_MS, endMs: END_MS });
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    store.database
      .prepare(
        `INSERT INTO store_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run("history_archive_event_authority", JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }));
    store.database.prepare("DELETE FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ?").run(START_MS, END_MS);
    await publishHistoryArchiveBundle(store.database, bundleDirectory);
    return {
      root,
      databaseFile,
      bundleDirectory,
      expected,
      executorOptions: {
        ...sourceOptions,
        databaseFile,
        importStoreFile: path.join(root, "imports.json"),
      },
      close() {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      },
    };
  } catch (error) {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    throw error;
  } finally {
    store.close();
  }
}

test("executor imports a complete bundle into a new independently readable runtime", async () => {
  const fixture = await createPublishedFixture();
  const importDirectory = path.join(fixture.root, "imported");
  const executor = createUsageExecutor(fixture.executorOptions);
  let runtime;
  try {
    const result = await executor.historyArchiveImport({
      sourceDirectory: fixture.bundleDirectory,
      importDirectory,
    });
    assert.deepEqual(Object.keys(result).sort(), ["bundleDirectory", "marker", "markerFile", "runtimeFile"]);
    assert.equal(result.runtimeFile, path.join(path.resolve(importDirectory), "runtime.sqlite"));
    assert.equal(result.bundleDirectory, path.join(path.resolve(importDirectory), "bundle"));
    assert.equal(result.markerFile, path.join(path.resolve(importDirectory), "import.complete.json"));

    const loaded = await loadHistoryArchiveImport(importDirectory);
    assert.equal(loaded.ok, true);
    assert.deepEqual(loaded.marker, result.marker);
    runtime = new UsageStore({
      homeDir: fixture.root,
      env: {},
      importDirs: [],
      automaticDiscoveryEnabled: false,
      databaseFile: result.runtimeFile,
    });
    await runtime.open();
    assert.deepEqual(stableCarrier(await runtime.publishedHistoryUsageReport()), fixture.expected);
    assert.equal(fileSha256(result.runtimeFile), fileSha256(loaded.runtimeFile));
  } finally {
    runtime?.close();
    await executor.close();
    fixture.close();
  }
});

test("executor import refuses an existing destination and leaves it untouched", async () => {
  const fixture = await createPublishedFixture();
  const importDirectory = path.join(fixture.root, "existing-import");
  const sentinel = path.join(importDirectory, "keep.txt");
  mkdirSync(importDirectory);
  writeFileSync(sentinel, "keep");
  const executor = createUsageExecutor(fixture.executorOptions);
  try {
    await assert.rejects(executor.historyArchiveImport({ sourceDirectory: fixture.bundleDirectory, importDirectory }), {
      code: "HISTORY_ARCHIVE_IMPORT_DESTINATION_EXISTS",
    });
    assert.deepEqual(readFileSync(sentinel, "utf8"), "keep");
    assert.deepEqual((await executor.publishedUsageReport()).events.length, fixture.expected.events.length);
  } finally {
    await executor.close();
    fixture.close();
  }
});

test("executor rejects an invalid bundle without changing the active store", async () => {
  const fixture = await createPublishedFixture();
  const invalidBundle = path.join(fixture.root, "invalid-bundle");
  const importDirectory = path.join(fixture.root, "invalid-import");
  mkdirSync(invalidBundle);
  const executor = createUsageExecutor(fixture.executorOptions);
  try {
    await executor.sync({ options: { ...fixture.executorOptions, force: true } });
    const activeBefore = fileSha256(fixture.databaseFile);
    const publishedBefore = await executor.publishedUsageReport();
    await assert.rejects(executor.historyArchiveImport({ sourceDirectory: invalidBundle, importDirectory }), {
      code: "HISTORY_ARCHIVE_BUNDLE_NOT_FOUND",
    });
    assert.equal(existsSync(importDirectory), false);
    assert.equal(fileSha256(fixture.databaseFile), activeBefore);
    assert.deepEqual(await executor.publishedUsageReport(), publishedBefore);
  } finally {
    await executor.close();
    fixture.close();
  }
});

test("executor imports schema4 Codex v6 perf into an independently readable runtime", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-import-perf-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-schema4.jsonl");
  const sourceOptions = optionsFor(root, codexHome);
  const databaseFile = path.join(root, "active.sqlite");
  const candidateFile = path.join(root, "candidate.sqlite");
  const bundleDirectory = path.join(root, "published");
  const store = new UsageStore({ ...sourceOptions, databaseFile });
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(usageFile, `${schema4RolloutContents(codexHome)}\n`);
    await store.sync({ options: sourceOptions });
    const sample = {
      ...store.database
        .prepare(
          `SELECT sample_key, method_version, token_scope, output_tokens, duration_ms
           FROM perf_samples WHERE source_kind = 'codex'`,
        )
        .get(),
    };
    assert.deepEqual(sample, {
      sample_key: JSON.stringify(["codex", store.homes[0].id, SESSION_ID, "turn-schema4", "response-schema4"]),
      method_version: PERF_METHOD_VERSION,
      token_scope: PERF_TOKEN_SCOPE,
      output_tokens: 42,
      duration_ms: 1_000,
    });

    await createHistoryArchiveCandidate(store.database, candidateFile, { startMs: START_MS, endMs: END_MS });
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    writeMeta(store.database, "history_archive_event_authority", {
      formatVersion: 1,
      segmentIds: [registered.segmentId],
    });
    writeMeta(store.database, "history_archive_perf_authority", {
      formatVersion: 1,
      segments: [
        {
          segmentId: registered.segmentId,
          databaseSha256: registered.databaseSha256,
          sourceKinds: ["codex"],
          methodVersions: [PERF_METHOD_VERSION],
        },
      ],
    });
    store.database.prepare("DELETE FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ?").run(START_MS, END_MS);
    assert.equal(
      Number(store.database.prepare("DELETE FROM perf_samples WHERE sample_key = ?").run(sample.sample_key).changes),
      1,
    );
    await publishHistoryArchiveBundle(store.database, bundleDirectory);
  } catch (error) {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    throw error;
  } finally {
    store.close();
  }

  const importDirectory = path.join(root, "imported");
  const executor = createUsageExecutor({
    ...sourceOptions,
    databaseFile,
    importStoreFile: path.join(root, "imports.json"),
  });
  let runtime;
  try {
    const result = await executor.historyArchiveImport({ sourceDirectory: bundleDirectory, importDirectory });
    runtime = new UsageStore({
      ...sourceOptions,
      databaseFile: result.runtimeFile,
    });
    await runtime.open();
    const summary = await runtime.summarizeHistory({
      preset: "all",
      now: "2026-07-12T02:02:00.000Z",
      calendarZone: "utc",
    });
    assert.equal(summary.perf.meta.methodVersion, PERF_METHOD_VERSION);
    assert.equal(summary.perf.groups.length, 1);
    assert.equal(summary.perf.groups[0].tokenScope, PERF_TOKEN_SCOPE);
    assert.equal(summary.perf.groups[0].n, 1);
    assert.equal(summary.perf.groups[0].tps.pooled, 42);
  } finally {
    runtime?.close();
    await executor.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
