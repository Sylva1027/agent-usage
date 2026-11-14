import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createUsageServer } from "../src/server.js";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";

test("Hermes dashboard detects equal-size database replacement, WAL rewrites and server reopen", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "hermes-refresh-"));
  const file = path.join(root, "state.db");
  const replacement = path.join(root, "replacement.db");
  const stamp = new Date("2026-11-01T00:00:00Z");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, started_at REAL,
    input_tokens INTEGER, output_tokens INTEGER);
    CREATE TABLE session_model_usage (session_id TEXT, model TEXT, billing_provider TEXT, billing_base_url TEXT,
    billing_mode TEXT, task TEXT, input_tokens INTEGER, output_tokens INTEGER, last_seen REAL,
    PRIMARY KEY(session_id,model,billing_provider,billing_base_url,billing_mode,task));
    INSERT INTO sessions VALUES ('s','cli',1793491200,200,40);
    INSERT INTO session_model_usage VALUES ('s','glm-5.1','p','','api','',200,40,1793491200);`);
  db.close();
  copyFileSync(file, replacement);
  const first = new DatabaseSync(file);
  first.exec("UPDATE session_model_usage SET input_tokens=100; UPDATE sessions SET input_tokens=100");
  first.close();
  for (const target of [file, replacement]) utimesSync(target, stamp, stamp);
  const options = {
    homeDir: root,
    env: {},
    extraHermesHomes: root,
    importDirs: [],
    databaseFile: path.join(root, "index.sqlite"),
    importStoreFile: path.join(root, "imports.json"),
    automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false,
    pricingFetcher: async () => {
      throw new Error("Offline fixture");
    },
  };
  let server;
  let writer;
  t.after(async () => {
    await server?.close();
    writer?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  async function start() {
    server = createUsageServer(options);
    await listenOnFetchPort(server);
  }
  async function read(route) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`);
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  }
  const query = "/api/usage?preset=all&view=dashboard&calendarZone=utc";
  await start();
  assert.equal((await read(query)).summary.totals.total, 140);
  let status = await read("/api/status");
  const before = statSync(file);
  renameSync(file, path.join(root, "old.db"));
  renameSync(replacement, file);
  assert.equal(statSync(file).size, before.size);
  assert.equal(statSync(file).mtimeMs, before.mtimeMs);
  assert.notEqual(statSync(file).ino, before.ino);
  assert.equal((await read(`/api/status?since=${status.fingerprint}`)).changed, true);
  assert.equal((await read(query)).summary.totals.total, 240);
  await server.close();
  await start();
  assert.equal((await read(query)).summary.totals.total, 240);

  writer = new DatabaseSync(file);
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  let walSize;
  for (const input of [300, 400]) {
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    writer.prepare("UPDATE session_model_usage SET input_tokens=?").run(input);
    utimesSync(file, stamp, stamp);
    utimesSync(`${file}-wal`, stamp, stamp);
    const wal = statSync(`${file}-wal`);
    if (input === 300) {
      assert.equal((await read(query)).summary.totals.total, 340);
      status = await read("/api/status");
      t.diagnostic(`WAL rewrite fixture size=${wal.size}`);
      walSize = wal.size;
    } else {
      assert.equal(wal.size, walSize);
      assert.equal((await read(`/api/status?since=${status.fingerprint}`)).changed, true);
      assert.equal((await read(query)).summary.totals.total, 440);
    }
  }
});
