import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createUsageExecutor } from "../src/usage-executor.js";
import { UsageStore } from "../src/usage-store.js";

function isolatedOptions(root) {
  return {
    homeDir: root,
    env: {},
    databaseFile: path.join(root, "usage-index.sqlite"),
    importStoreFile: path.join(root, "imports.json"),
    importDirs: [],
    automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false,
  };
}

async function seedEmptyStore(options) {
  const store = new UsageStore(options);
  try {
    await store.open();
  } finally {
    store.close();
  }
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const tierSnapshot = {
  formatVersion: 1,
  threads: [{ threadId: "thread-a", turns: [{ time: 1, tier: "fast" }] }],
};

const quotaSnapshot = {
  formatVersion: 1,
  entries: [],
};

test("restored light state survives idle exit and respawn without a sync", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "local-summary-state-"));
  const options = isolatedOptions(root);
  await seedEmptyStore(options);
  const metadata = { harnessModels: { codex: ["gpt-5"] }, homes: [] };
  const status = {
    fingerprint: "persisted-fingerprint",
    generatedAt: "2026-10-29T00:00:00.000Z",
    checkedAt: "2026-10-29T00:01:00.000Z",
    missingSources: [],
  };
  const executor = createUsageExecutor(options, { idleTimeoutMs: 25 });
  try {
    executor.restoreState({
      status,
      metadata,
      homes: [{ id: "home-a", label: "Home A", path: root, kind: "main" }],
      warnings: [{ sourceKind: "codex", code: "WARNING_A" }],
      serviceTierEvidence: tierSnapshot,
      quotaSourceEvidenceSnapshot: quotaSnapshot,
      checkedAt: status.checkedAt,
      perfIndexVersion: "index-a",
      perfTimingRevision: "",
      lastCheckpoint: null,
    });

    assert.equal(executor.pid, null, "restoreState must not start a child");
    assert.equal(executor.alive, false);
    assert.equal(executor.restarts, 0);
    assert.deepEqual(executor.status, status);
    assert.deepEqual(executor.metadata(), metadata);
    assert.equal(executor.serviceTierEvidence.resolve("thread-a", 2), "fast");
    assert.doesNotThrow(() => JSON.stringify(executor.state));
    assert.deepEqual(executor.stateSnapshot().serviceTierEvidence, tierSnapshot);

    const first = await executor.summarize({ preset: "all", now: new Date("2026-10-29T00:02:00Z") });
    assert.equal(first.totals.total, 0, "the read request must work from the opened local database");
    const firstPid = executor.pid;
    assert.ok(firstPid);

    await waitFor(() => executor.pid === null && !executor.alive);
    assert.equal(executor.restarts, 0, "normal idle exit is not a restart");
    assert.deepEqual(executor.status, status);
    assert.deepEqual(executor.metadata(), metadata);
    assert.equal(executor.serviceTierEvidence.resolve("thread-a", 2), "fast");
    assert.deepEqual(executor.quotaSourceEvidenceSnapshot, quotaSnapshot);

    const second = await executor.summarize({ preset: "all", now: new Date("2026-10-29T00:03:00Z") });
    assert.equal(second.totals.total, 0);
    assert.notEqual(executor.pid, firstPid);
    assert.equal(executor.restarts, 0, "idle respawn is not a crash restart");
    assert.deepEqual(executor.status, status);
    assert.deepEqual(executor.metadata(), metadata);
  } finally {
    await executor.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("frozen snapshot records restore query state without reading live sources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "local-summary-frozen-"));
  const options = isolatedOptions(root);
  await seedEmptyStore(options);
  const snapshotFile = path.join(root, "frozen.sqlite");
  const live = createUsageExecutor(options, { idleTimeoutMs: 60_000 });
  let frozenExecutor;
  try {
    live.restoreState({
      status: {
        fingerprint: "frozen-fingerprint",
        generatedAt: "2026-10-29T01:00:00.000Z",
        checkedAt: "2026-10-29T01:01:00.000Z",
        missingSources: [],
      },
      metadata: { harnessModels: { codex: ["gpt-5"] }, homes: [] },
      homes: [{ id: "home-a", label: "Home A", path: root, kind: "main" }],
      warnings: [{ sourceKind: "codex", code: "FROZEN_WARNING" }],
      serviceTierEvidence: tierSnapshot,
      quotaSourceEvidenceSnapshot: quotaSnapshot,
      checkedAt: "2026-10-29T01:01:00.000Z",
    });
    const frozen = await live.snapshot({ databaseFile: snapshotFile, asOf: Date.parse("2026-10-29T01:02:00Z") });
    assert.equal(typeof frozen.serviceTierEvidence.resolve, "function");
    assert.ok(Object.hasOwn(frozen, "quotaSourceEvidenceSnapshot"));
    assert.deepEqual(frozen.quotaSourceEvidenceSnapshot, quotaSnapshot);
    await live.close();

    frozenExecutor = createUsageExecutor({ ...options, databaseFile: snapshotFile }, { idleTimeoutMs: 60_000 });
    const opened = await frozenExecutor.open({ frozen });
    assert.equal(opened.fingerprint, "frozen-fingerprint");
    assert.equal(opened.checkedAt, "2026-10-29T01:01:00.000Z");
    assert.equal(frozenExecutor.homes.length, 1);
    assert.equal(frozenExecutor.warnings[0].code, "FROZEN_WARNING");
    assert.equal(frozenExecutor.checkedAt, "2026-10-29T01:01:00.000Z");
    assert.equal(frozenExecutor.serviceTierEvidence.resolve("thread-a", 2), "fast");
    assert.deepEqual(frozenExecutor.quotaSourceEvidenceSnapshot, quotaSnapshot);
    assert.doesNotThrow(() => JSON.stringify(frozenExecutor.state));
    assert.equal((await frozenExecutor.summarize({ preset: "all" })).totals.total, 0);
  } finally {
    await live.close();
    await frozenExecutor?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("crash recovery, idempotent close, and post-close requests keep existing diagnostics", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "local-summary-crash-"));
  const options = isolatedOptions(root);
  await seedEmptyStore(options);
  const executor = createUsageExecutor(options, { idleTimeoutMs: 60_000 });
  const persistedStatus = {
    fingerprint: "persisted-before-crash",
    generatedAt: "2026-10-29T02:00:00.000Z",
    checkedAt: "2026-10-29T02:01:00.000Z",
    missingSources: [],
  };
  executor.restoreState({
    status: persistedStatus,
    metadata: { harnessModels: { codex: ["gpt-5"] }, homes: [] },
    homes: [{ id: "home-a", label: "Home A", path: root, kind: "main" }],
    warnings: [{ sourceKind: "codex", code: "BEFORE_CRASH" }],
    serviceTierEvidence: tierSnapshot,
    quotaSourceEvidenceSnapshot: quotaSnapshot,
    checkedAt: persistedStatus.checkedAt,
  });
  await executor.open();
  assert.equal(executor.alive, true);
  assert.deepEqual(executor.status, persistedStatus);
  assert.equal(await executor.crashWorkerForTest(), true);
  assert.equal(executor.alive, false);
  assert.equal(executor.status, null);
  assert.equal(executor.metadata(), null);
  assert.deepEqual(executor.homes, []);
  assert.deepEqual(executor.warnings, []);
  assert.equal(executor.serviceTierEvidence, null);
  assert.equal(executor.quotaSourceEvidenceSnapshot, null);
  assert.equal(executor.restarts, 0);

  await executor.open();
  assert.equal(executor.alive, true);
  assert.equal(executor.restarts, 1);
  assert.equal(executor.status, null);

  const firstClose = executor.close();
  const secondClose = executor.close();
  assert.equal(secondClose, firstClose);
  await firstClose;
  assert.equal(executor.alive, false);
  await assert.rejects(executor.open(), (error) => error.code === "EXECUTOR_UNAVAILABLE");
  await rm(root, { recursive: true, force: true });
});

test("request timeout terminates the stuck child before close settles", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "local-summary-timeout-"));
  const options = isolatedOptions(root);
  await seedEmptyStore(options);
  const executor = createUsageExecutor(options, { requestTimeoutMs: 1, idleTimeoutMs: 60_000 });
  try {
    await assert.rejects(executor.open(), (error) => error.code === "EXECUTOR_TIMEOUT" && error.retryable === true);
    await waitFor(() => !executor.alive);
    assert.equal(executor.pid, null);
  } finally {
    await executor.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("parent disconnect closes the executor child and releases the database", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "local-summary-parent-exit-"));
  const options = isolatedOptions(root);
  await seedEmptyStore(options);
  const marker = path.join(root, "child.json");
  const scriptFile = path.join(root, "parent.mjs");
  const executorUrl = pathToFileURL(path.resolve("src/usage-executor.js")).href;
  await mkdir(root, { recursive: true });
  await writeFile(
    scriptFile,
    `import { writeFileSync } from "node:fs";
import { createUsageExecutor } from ${JSON.stringify(executorUrl)};
const executor = createUsageExecutor(${JSON.stringify(options)}, { idleTimeoutMs: 60000 });
await executor.open();
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ childPid: executor.pid }));
setInterval(() => {}, 1000);
`,
  );
  const parent = spawn(process.execPath, [scriptFile], { stdio: "ignore", windowsHide: true });
  let childPid = null;
  try {
    await waitFor(() => existsSync(marker), 10_000);
    childPid = JSON.parse(await readFile(marker, "utf8")).childPid;
    assert.ok(Number.isSafeInteger(childPid));
    assert.equal(processAlive(childPid), true);
    parent.kill("SIGKILL");
    await new Promise((resolve) => parent.once("exit", resolve));
    await waitFor(() => !processAlive(childPid), 10_000);
    await rm(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
    if (childPid && processAlive(childPid)) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
