import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { createUsageExecutor } from "../src/usage-executor.js";
import { UsageStore } from "../src/usage-store.js";

const AUTHORITY_KEY = "history_archive_event_authority";
const GATE_CHILD = process.env.HISTORY_PERIOD_EXECUTOR_GATE === "1";

function codexTokenLine(timestamp, total, lastTotal) {
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

function codexPrefix(codexHome) {
  return [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "period-executor-session", source: "cli", cwd: codexHome },
    }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-luna" } }),
  ].join("\n");
}

function writeAuthority(database, segmentId) {
  database
    .prepare("INSERT INTO store_meta (key, value) VALUES (?, ?)")
    .run(AUTHORITY_KEY, JSON.stringify({ formatVersion: 1, segmentIds: [segmentId] }));
}

async function waitForFile(filePath) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function seedColdPeriod(root) {
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-cumulative.jsonl");
  const candidateFile = path.join(root, "candidate.sqlite");
  const databaseFile = path.join(root, "usage-index.sqlite");
  const firstTimestamp = "2026-07-12T02:00:00.000Z";
  const secondTimestamp = "2026-07-12T02:01:00.000Z";
  const firstTimestampMs = Date.parse(firstTimestamp);
  const secondTimestampMs = Date.parse(secondTimestamp);
  const options = {
    homeDir: root,
    env: {},
    extraHomes: codexHome,
    databaseFile,
    importStoreFile: path.join(root, "imports.json"),
    automaticDiscoveryEnabled: false,
  };
  const prefix = `${codexPrefix(codexHome)}\n${codexTokenLine(firstTimestamp, 100, 100)}`;
  const store = new UsageStore(options);
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(usageFile, `${prefix}\n`);
    await store.sync({ options });
    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: firstTimestampMs,
      endMs: secondTimestampMs,
    });
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);

    store.database.exec("BEGIN IMMEDIATE");
    try {
      writeAuthority(store.database, registered.segmentId);
      store.database.prepare("DELETE FROM events WHERE source_path = ?").run(usageFile);
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }

    writeFileSync(usageFile, `${prefix}\n${codexTokenLine(secondTimestamp, 130, 30)}\n`);
    store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(usageFile);
    await store.sync({ options });
    assert.deepEqual(
      store.database
        .prepare("SELECT total FROM events ORDER BY timestamp_ms")
        .all()
        .map((row) => Number(row.total)),
      [30],
    );
  } finally {
    store.close();
  }

  return {
    options,
    candidateFile,
    databaseFile,
    externalSource: path.join(root, "external-source.jsonl"),
    filters: { preset: "all", now: "2026-07-15T12:00:00.000Z", calendarZone: "utc" },
    secondTimestampMs,
  };
}

test("executor period comparison and dashboard are cold-aware and reject a missing segment", {
  skip: GATE_CHILD,
}, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-period-executor-"));
  let executor;
  try {
    const { options, candidateFile, filters } = await seedColdPeriod(root);
    executor = createUsageExecutor(options);
    await executor.sync({ options });

    const periodOptions = { now: filters.now, calendarZone: filters.calendarZone };
    const direct = await executor.periodComparison(periodOptions);
    const dashboard = await executor.dashboard(filters);

    assert.equal(direct.totals.month.total, 130);
    assert.equal(direct.totals.all.total, 130);
    assert.equal(dashboard.periodComparison.totals.month.total, 130);
    assert.equal(dashboard.periodComparison.totals.all.total, 130);
    assert.equal(dashboard.summary.totals.total, 130);

    const candidateBackup = path.join(root, "candidate-backup.sqlite");
    copyFileSync(candidateFile, candidateBackup);
    rmSync(candidateFile);
    await assert.rejects(executor.periodComparison(periodOptions), (error) => error.code === "ENOENT");
    await assert.rejects(executor.dashboard(filters), (error) => error.code === "ENOENT");
    copyFileSync(candidateBackup, candidateFile);
  } finally {
    await executor?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("executor keeps the published dashboard pinned until sync publication completes", {
  skip: !GATE_CHILD,
}, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-period-executor-gate-"));
  const { options, databaseFile, externalSource, filters, secondTimestampMs } = await seedColdPeriod(root);
  const periodOptions = { now: filters.now, calendarZone: filters.calendarZone };
  const gateReleaseFile = process.env.HISTORY_PERIOD_EXECUTOR_GATE_RELEASE;
  let executor;
  let external;
  try {
    executor = createUsageExecutor(options);
    await executor.sync({ options });

    external = new DatabaseSync(databaseFile);
    let syncSettled = false;
    external.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
    external
      .prepare(
        `INSERT INTO source_files (path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(externalSource, "extra", "external", "External", root, 0, 0, "2026-07-15T00:00:00.000Z");
    external
      .prepare(
        `INSERT INTO events (
            source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
            hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        externalSource,
        secondTimestampMs + 60_000,
        "external-hot",
        "external",
        "External",
        "main",
        "project",
        "gpt-6-luna",
        "2026-07-12 02:00",
        "2026-07-12",
        "2026-07-12",
        "2026-07",
        200,
        199,
        0,
        1,
        0,
      );
    external.prepare("DELETE FROM store_meta WHERE key = ?").run(AUTHORITY_KEY);

    const pendingSync = executor.sync({ options: { ...options, force: true } }).finally(() => {
      syncSettled = true;
    });
    await waitForFile(process.env.HISTORY_PERIOD_EXECUTOR_GATE_READY);
    external.exec("COMMIT");

    const pinned = await executor.dashboard(filters);
    assert.equal(syncSettled, false);
    assert.equal(pinned.summary.totals.total, 130);
    assert.equal(pinned.periodComparison.totals.all.total, 130);

    const directNext = await executor.periodComparison(periodOptions);
    assert.equal(directNext.totals.month.total, 230);
    assert.equal(directNext.totals.all.total, 230);

    writeFileSync(gateReleaseFile, "release");
    await pendingSync;

    const republished = await executor.dashboard(filters);
    assert.equal(republished.summary.totals.total, 230);
    assert.equal(republished.periodComparison.totals.all.total, 230);
  } catch (error) {
    try {
      external?.exec("ROLLBACK");
    } catch {
      // The transaction may already be committed.
    }
    throw error;
  } finally {
    if (gateReleaseFile) writeFileSync(gateReleaseFile, "release");
    external?.close();
    await executor?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("period executor publication gate runs in a child with NODE_OPTIONS", { skip: GATE_CHILD }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-period-executor-preload-"));
  const preloadFile = path.join(root, "sync-round-gate.mjs");
  const gateReadyFile = path.join(root, "sync-gate-ready");
  const gateReleaseFile = path.join(root, "sync-gate-release");
  const usageStoreUrl = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "usage-store.js"),
  ).href;
  writeFileSync(
    preloadFile,
    `import { existsSync, writeFileSync } from "node:fs";
import { isMainThread } from "node:worker_threads";
import { UsageStore } from ${JSON.stringify(usageStoreUrl)};

if (!isMainThread) {
  const gateReadyFile = process.env.HISTORY_PERIOD_EXECUTOR_GATE_READY;
  const gateReleaseFile = process.env.HISTORY_PERIOD_EXECUTOR_GATE_RELEASE;
  if (!gateReadyFile || !gateReleaseFile) throw new Error("missing executor gate environment");
  const originalSyncRound = UsageStore.prototype.syncRound;
  let rounds = 0;
  UsageStore.prototype.syncRound = async function (...args) {
    rounds += 1;
    if (rounds === 2) {
      writeFileSync(gateReadyFile, "ready");
      while (!existsSync(gateReleaseFile)) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    return Reflect.apply(originalSyncRound, this, args);
  };
}
`,
  );
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preloadFile).href}`.trim(),
      HISTORY_PERIOD_EXECUTOR_GATE: "1",
      HISTORY_PERIOD_EXECUTOR_GATE_READY: gateReadyFile,
      HISTORY_PERIOD_EXECUTOR_GATE_RELEASE: gateReleaseFile,
    },
    timeout: 60_000,
    windowsHide: true,
  });
  try {
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /executor keeps the published dashboard pinned until sync publication completes/);
    assert.match(output, /pass 1/);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
