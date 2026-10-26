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
import { createUsageExecutor } from "../src/usage-executor.js";
import { UsageStore } from "../src/usage-store.js";

const START_MS = Date.parse("2026-07-12T02:00:00.000Z");
const END_MS = Date.parse("2026-07-12T02:01:00.000Z");
const SESSION_ID = "archive-import-executor-session";

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
