import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { createUsageServer } from "../src/server.js";
import { UsageStore } from "../src/usage-store.js";

const COLD_TIME = "2026-07-12T02:00:00.000Z";
const HOT_TIME = "2026-07-12T02:01:00.000Z";
const COLD_MS = Date.parse(COLD_TIME);
const HOT_MS = Date.parse(HOT_TIME);
const SESSION_ID = "cold-snapshot-cleanup-session";

function tokenLine(timestamp, total, lastTotal) {
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

function sessionPrefix(codexHome) {
  return [
    JSON.stringify({
      type: "session_meta",
      payload: { id: SESSION_ID, source: "cli", cwd: codexHome },
    }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-sol" } }),
  ].join("\n");
}

function sourceOptions(root, codexHome) {
  return {
    homeDir: root,
    env: {},
    extraHomes: codexHome,
    importDirs: [],
    automaticDiscoveryEnabled: false,
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function snapshotDirectories() {
  return new Set(
    readdirSync(os.tmpdir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("codex-usage-snapshot-"))
      .map((entry) => path.join(os.tmpdir(), entry.name)),
  );
}

function newSnapshotDirectory(before, snapshotId) {
  const created = [...snapshotDirectories()].filter(
    (directory) => !before.has(directory) && existsSync(path.join(directory, `${snapshotId}.sqlite`)),
  );
  assert.equal(created.length, 1, "one private snapshot directory");
  return created[0];
}

async function freeze(baseUrl) {
  const response = await fetch(`${baseUrl}/api/summary?preset=all&calendarZone=utc&freeze=1&skipCheck=1`);
  const text = await response.text();
  return { response, body: JSON.parse(text), text };
}

async function createArchivedFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "cold-snapshot-cleanup-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-cold-snapshot-cleanup.jsonl");
  const source = sourceOptions(root, codexHome);
  const segmentFile = path.join(root, "cold-segment.sqlite");
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(
      usageFile,
      `${sessionPrefix(codexHome)}\n${tokenLine(COLD_TIME, 100, 100)}\n${tokenLine(HOT_TIME, 130, 30)}\n`,
    );

    const databaseFile = path.join(root, "usage-index.sqlite");
    const store = new UsageStore({ ...source, databaseFile });
    try {
      await store.sync({ options: source });
      await createHistoryArchiveCandidate(store.database, segmentFile, {
        startMs: COLD_MS,
        endMs: HOT_MS,
      });
      const registered = await store.registerHistoryArchiveCandidate(segmentFile);
      store.database
        .prepare("INSERT INTO store_meta (key, value) VALUES (?, ?)")
        .run(
          "history_archive_event_authority",
          JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }),
        );
      store.database.exec("BEGIN IMMEDIATE");
      try {
        store.database.prepare("DELETE FROM events WHERE source_path = ?").run(usageFile);
        store.database.exec("COMMIT");
      } catch (error) {
        store.database.exec("ROLLBACK");
        throw error;
      }
      store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(usageFile);
      await store.sync({ options: source });
    } finally {
      store.close();
    }

    return {
      root,
      serverOptions: {
        ...source,
        databaseFile,
        importStoreFile: path.join(root, "imports.json"),
        heapSizeLimitBytes: 4 * 1024 * 1024 * 1024,
        pricingRefreshSchedulerEnabled: false,
      },
      close() {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    throw error;
  }
}

test("ninth cold freeze closes and removes the evicted snapshot including staged segments", async () => {
  const fixture = await createArchivedFixture();
  let server;
  try {
    const beforeDirectories = snapshotDirectories();
    server = createUsageServer(fixture.serverOptions);
    const baseUrl = await listen(server);
    const first = await freeze(baseUrl);
    assert.equal(first.response.status, 200, first.text);
    const snapshotDirectory = newSnapshotDirectory(beforeDirectories, first.body.snapshotId);
    const firstDatabase = path.join(snapshotDirectory, `${first.body.snapshotId}.sqlite`);
    assert.equal(existsSync(firstDatabase), true);
    assert.equal(existsSync(`${firstDatabase}.segments`), true);

    let ninth;
    for (let index = 0; index < 8; index += 1) {
      ninth = await freeze(baseUrl);
      assert.equal(ninth.response.status, 200, ninth.text);
    }
    assert.equal(ninth.body.summary.totals.total, 130);

    const expired = await fetch(`${baseUrl}/api/summary?preset=all&calendarZone=utc&snapshot=${first.body.snapshotId}`);
    const expiredBody = await expired.json();
    assert.equal(expired.status, 410);
    assert.equal(expiredBody.code, "SNAPSHOT_EXPIRED");
    for (const artifact of [
      firstDatabase,
      `${firstDatabase}-wal`,
      `${firstDatabase}-shm`,
      `${firstDatabase}.segments`,
    ]) {
      assert.equal(existsSync(artifact), false, artifact);
    }
  } finally {
    if (server) await server.close();
    fixture.close();
  }
});

test("post-create snapshot failure removes its artifacts and preserves the previous snapshot", async () => {
  const fixture = await createArchivedFixture();
  let server;
  try {
    const beforeDirectories = snapshotDirectories();
    server = createUsageServer(fixture.serverOptions);
    const baseUrl = await listen(server);
    const first = await freeze(baseUrl);
    assert.equal(first.response.status, 200, first.text);
    const snapshotDirectory = newSnapshotDirectory(beforeDirectories, first.body.snapshotId);
    const firstDatabase = path.join(snapshotDirectory, `${first.body.snapshotId}.sqlite`);

    const flagFile = path.join(fixture.root, "inject-snapshot.json");
    const resultFile = path.join(fixture.root, "injected.json");
    const preloadFile = path.join(fixture.root, "inject-snapshot.mjs");
    writeFileSync(flagFile, JSON.stringify({ snapshotDirectory, firstDatabase }));
    writeFileSync(
      preloadFile,
      `
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { UsageStore } from ${JSON.stringify(new URL("../src/usage-store.js", import.meta.url).href)};
if (process.env.CODEX_USAGE_EXECUTOR_CHILD === "1") {
  const original = UsageStore.prototype.open;
  UsageStore.prototype.open = async function (...args) {
    const result = await original.apply(this, args);
    const flagFile = ${JSON.stringify(flagFile)};
    if (!existsSync(flagFile)) return result;
    const { snapshotDirectory, firstDatabase } = JSON.parse(readFileSync(flagFile, "utf8"));
    const databaseFile = path.resolve(this.databaseFile);
    if (path.dirname(databaseFile) === path.resolve(snapshotDirectory) && databaseFile !== path.resolve(firstDatabase) && existsSync(databaseFile + ".segments")) {
      writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ databaseFile, databaseExists: existsSync(databaseFile), segmentsExist: true }));
      unlinkSync(flagFile);
      throw new Error("INJECTED_SNAPSHOT_POST_CREATE_FAILURE");
    }
    return result;
  };
}
`,
    );
    const oldArgv = [...process.execArgv];
    let failed;
    try {
      process.execArgv.push("--import", pathToFileURL(preloadFile).href);
      await new Promise((resolve) => setTimeout(resolve, 400));
      failed = await freeze(baseUrl);
    } finally {
      process.execArgv.splice(0, process.execArgv.length, ...oldArgv);
    }
    const injected = JSON.parse(readFileSync(resultFile, "utf8"));
    assert.equal(failed.response.status, 500, failed.text);
    assert.equal(failed.body.error, "INJECTED_SNAPSHOT_POST_CREATE_FAILURE");
    assert.ok(injected);
    assert.equal(injected.databaseExists, true);
    assert.equal(injected.segmentsExist, true);
    assert.equal(path.dirname(injected.databaseFile), path.resolve(snapshotDirectory));
    assert.notEqual(injected.databaseFile, path.resolve(firstDatabase));
    for (const artifact of [
      injected.databaseFile,
      `${injected.databaseFile}-wal`,
      `${injected.databaseFile}-shm`,
      `${injected.databaseFile}.segments`,
    ]) {
      assert.equal(existsSync(artifact), false, artifact);
    }

    const entries = readdirSync(snapshotDirectory);
    assert.deepEqual(
      entries.filter((entry) => entry.endsWith(".sqlite")),
      [`${first.body.snapshotId}.sqlite`],
    );
    assert.deepEqual(
      entries.filter((entry) => entry.endsWith(".segments")),
      [`${first.body.snapshotId}.sqlite.segments`],
    );
    assert.deepEqual(
      entries.filter((entry) => !entry.startsWith(`${first.body.snapshotId}.sqlite`)),
      [],
    );

    const preserved = await fetch(
      `${baseUrl}/api/summary?preset=all&calendarZone=utc&snapshot=${first.body.snapshotId}`,
    );
    const preservedBody = await preserved.json();
    assert.equal(preserved.status, 200);
    assert.equal(preservedBody.summary.totals.total, 130);
    assert.equal(existsSync(firstDatabase), true);
  } finally {
    if (server) await server.close();
    fixture.close();
  }
});

test("server close removes the private snapshot directory including staged segments", async () => {
  const fixture = await createArchivedFixture();
  let server;
  try {
    const beforeDirectories = snapshotDirectories();
    server = createUsageServer(fixture.serverOptions);
    const baseUrl = await listen(server);
    const frozen = await freeze(baseUrl);
    assert.equal(frozen.response.status, 200, frozen.text);
    const snapshotDirectory = newSnapshotDirectory(beforeDirectories, frozen.body.snapshotId);
    const databaseFile = path.join(snapshotDirectory, `${frozen.body.snapshotId}.sqlite`);
    assert.equal(existsSync(`${databaseFile}.segments`), true);

    await server.close();
    server = null;
    assert.equal(existsSync(snapshotDirectory), false);
  } finally {
    if (server) await server.close();
    fixture.close();
  }
});
