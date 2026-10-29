import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkpointUsageStore, createUsageExecutor } from "../src/usage-executor.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

function isolatedOptions(root, fixture) {
  return {
    homeDir: root,
    env: {},
    databaseFile: path.join(root, "usage-index.sqlite"),
    importStoreFile: path.join(root, "imports.json"),
    importDirs: [fixture.codexHome],
    automaticDiscoveryEnabled: false,
  };
}

function appendTurn(fixture, turn) {
  const turnId = `wal-turn-${String(turn).padStart(2, "0")}`;
  const responseId = `wal-response-${String(turn).padStart(2, "0")}`;
  const timestamp = new Date(Date.parse("2026-10-04T12:00:00.000Z") + 1_000_000 + turn * 10_000).toISOString();
  const rows = [
    {
      type: "turn_context",
      payload: { thread_id: "fixture-codex-thread", turn_id: turnId, model: fixture.expected.model, effort: "high" },
    },
    {
      type: "event_msg",
      timestamp,
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            total_tokens: 10,
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 10,
            reasoning_output_tokens: 0,
          },
        },
      },
    },
  ];
  appendFileSync(fixture.rolloutFiles[0], `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return { turnId, responseId, outputTokens: 10 };
}

test("first sync checkpoints without a published reader and exposes the diagnostic", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-wal-first-"));
  const fixture = createPerfCodexIntegrationFixture();
  const executor = createUsageExecutor(isolatedOptions(root, fixture));
  try {
    await executor.sync({ options: { ...fixture.reportOptions, force: true } });
    assert.ok(executor.lastCheckpoint, "first sync must publish lastCheckpoint");
    assert.equal(executor.lastCheckpoint.mode, "truncate");
    assert.ok(Number.isFinite(executor.lastCheckpoint.elapsedMs));
    assert.equal(executor.lastCheckpoint.busy, 0);
    assert.equal(executor.lastCheckpoint.log, 0);
    assert.equal(executor.lastCheckpoint.checkpointed, 0);
    assert.equal(executor.lastCheckpoint.error, null);
  } finally {
    await executor.close();
    fixture.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("three write/checkpoint rounds converge instead of growing WAL monotonically", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-wal-rounds-"));
  const fixture = createPerfCodexIntegrationFixture();
  const options = isolatedOptions(root, fixture);
  const executor = createUsageExecutor(options);
  const sizes = [];
  try {
    await executor.sync({ options: { ...fixture.reportOptions, force: true } });
    for (let round = 1; round <= 3; round += 1) {
      appendTurn(fixture, round);
      await executor.sync({ options: { ...fixture.reportOptions, force: true } });
      const checkpoint = executor.lastCheckpoint;
      assert.equal(checkpoint?.error, null);
      assert.equal(checkpoint?.busy, 0);
      sizes.push(statSync(`${options.databaseFile}-wal`, { throwIfNoEntry: false })?.size ?? 0);
    }
    assert.ok(executor.lastCheckpoint, "last round must publish a checkpoint");
    assert.deepEqual(sizes, [0, 0, 0], `TRUNCATE must leave no growing WAL: ${sizes.join(", ")}`);
  } finally {
    await executor.close();
    fixture.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("an external reader makes TRUNCATE return busy immediately; releasing it recovers", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-wal-reader-"));
  const fixture = createPerfCodexIntegrationFixture();
  const options = isolatedOptions(root, fixture);
  const executor = createUsageExecutor(options);
  let reader;
  try {
    await executor.sync({ options: { ...fixture.reportOptions, force: true } });
    appendTurn(fixture, 1);
    await executor.sync({ options: { ...fixture.reportOptions, force: true } });

    reader = new DatabaseSync(options.databaseFile);
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) AS n FROM events").get();
    const started = performance.now();
    appendTurn(fixture, 2);
    await executor.sync({ options: { ...fixture.reportOptions, force: true } });
    const elapsedMs = performance.now() - started;
    assert.equal(executor.lastCheckpoint?.busy, 1);
    assert.ok(elapsedMs < 1000, `busy checkpoint must not wait for the reader (${elapsedMs.toFixed(1)} ms)`);
    reader.close();
    reader = undefined;
    await executor.sync({ options: { ...fixture.reportOptions, force: true } });
    assert.equal(executor.lastCheckpoint?.busy, 0);
    assert.equal(executor.lastCheckpoint?.log, 0);
    assert.equal(statSync(`${options.databaseFile}-wal`, { throwIfNoEntry: false })?.size ?? 0, 0);
  } finally {
    try {
      reader?.close();
    } catch {
      // already closed
    }
    await executor.close();
    fixture.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("dashboard serves the previously published snapshot while a sync is in flight", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-wal-dashboard-"));
  const fixture = createPerfCodexIntegrationFixture();
  const options = isolatedOptions(root, fixture);
  const executor = createUsageExecutor(options);
  try {
    await executor.sync({ options: { ...fixture.reportOptions, force: true } });
    const before = await executor.dashboard({ preset: "all", now: new Date() });
    appendTurn(fixture, 1);
    const syncing = executor.sync({ options: { ...fixture.reportOptions, force: true } });
    const during = await executor.dashboard({ preset: "all", now: new Date() });
    assert.deepEqual(during.summary.totals, before.summary.totals);
    await syncing;
    const after = await executor.dashboard({ preset: "all", now: new Date() });
    assert.notDeepEqual(after.summary.totals, before.summary.totals);
  } finally {
    await executor.close();
    fixture.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("checkpoint failures are diagnostic-only", () => {
  const result = checkpointUsageStore({
    prepare() {
      throw new Error("prepare failed");
    },
    exec() {
      throw new Error("exec failed");
    },
  });
  assert.equal(result.mode, "truncate");
  assert.equal(result.busy, null);
  assert.equal(result.log, null);
  assert.equal(result.checkpointed, null);
  assert.equal(result.error.stage, "checkpoint");
  assert.match(result.error.message, /prepare failed/);
});

test("checkpoint reports a non-WAL database as a no-op and restores busy_timeout", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA busy_timeout = 4321");
    const result = checkpointUsageStore(database);
    assert.equal(result.busy, 0);
    assert.equal(result.log, -1);
    assert.equal(result.checkpointed, -1);
    assert.equal(result.error, null);
    assert.equal(Number(database.prepare("PRAGMA busy_timeout").get().timeout), 4321);
  } finally {
    database.close();
  }
});

test("a failed sync publishes its checkpoint diagnostic without masking the original error", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-wal-sync-error-"));
  const storeUrl = new URL("../src/usage-store.js", import.meta.url).href;
  const preload = `data:text/javascript,${encodeURIComponent(`
    import { UsageStore } from ${JSON.stringify(storeUrl)};
    UsageStore.prototype.sync = async function () {
      this.database.close();
      const error = new Error("injected sync failure");
      error.code = "INJECTED_SYNC";
      throw error;
    };
  `)}`;
  const options = {
    homeDir: root,
    env: {},
    databaseFile: path.join(root, "usage-index.sqlite"),
    importStoreFile: path.join(root, "imports.json"),
    importDirs: [],
    automaticDiscoveryEnabled: false,
  };
  const child = fork(fileURLToPath(new URL("../src/usage-executor.js", import.meta.url)), [], {
    env: { ...process.env, CODEX_USAGE_EXECUTOR_CHILD: "1" },
    execArgv: ["--import", preload],
    serialization: "advanced",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  try {
    const messages = [];
    let resolveDiagnostic;
    const diagnosticReady = new Promise((resolve) => {
      resolveDiagnostic = resolve;
    });
    const response = await new Promise((resolve, reject) => {
      child.on("message", (message) => {
        if (message.type === "ready") {
          child.send({ type: "sync", id: 1, options: { force: true } }, (error) => {
            if (error) reject(error);
          });
        } else if (message.type === "state") {
          messages.push(message.state);
          if (message.state?.lastCheckpoint?.error?.stage) resolveDiagnostic(message.state.lastCheckpoint);
        } else if (message.type === "response" && message.id === 1) {
          resolve(message);
        } else if (message.type === "fatal") {
          reject(new Error(message.error?.message ?? "executor initialization failed"));
        }
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`executor child exited before responding: ${code}`)));
      child.send({ type: "init", options, state: {} }, (error) => {
        if (error) reject(error);
      });
    });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "INJECTED_SYNC");
    assert.match(response.error.message, /injected sync failure/);
    let diagnosticTimer;
    const diagnostic = await Promise.race([
      diagnosticReady,
      new Promise((_, reject) => {
        diagnosticTimer = setTimeout(
          () => reject(new Error(`checkpoint diagnostic state did not arrive: ${JSON.stringify(messages)}`)),
          5_000,
        );
        diagnosticTimer.unref?.();
      }),
    ]);
    clearTimeout(diagnosticTimer);
    assert.equal(diagnostic?.error?.stage, "checkpoint");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    assert.equal(stopped, true, "executor child must exit before cleanup");
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
