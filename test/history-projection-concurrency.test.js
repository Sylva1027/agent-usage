import assert from "node:assert/strict";
import { fork } from "node:child_process";
import {
  constants as fsConstants,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { copyFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import test from "node:test";

import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { readHistoryProjectionStamp, recordHistoryProjectionBatch } from "../src/usage-history-projection-store.js";
import { UsageStore } from "../src/usage-store.js";

const DAY = 86400_000;
const START = Date.parse("2026-01-01T00:00:00Z");
const FILTERS = { preset: "all", calendarZone: "utc", bucket: "day", now: "2026-01-08T12:00:00Z" };
const clean = (value) => JSON.parse(JSON.stringify(value, (key, item) => (key === "generatedAt" ? undefined : item)));
const plainRows = (statement) => statement.all().map((row) => ({ ...row }));

async function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "history-projection-concurrency-"));
  const file = path.join(root, "source.sqlite"),
    sourcePath = path.join(root, "missing.jsonl");
  const cache = `${path.resolve(file)}.history-cache`;
  const children = [];
  const stores = [];
  t.after(async () => {
    for (const child of children) {
      if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill("SIGKILL");
      await child.exited;
    }
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  async function open(anonymous = false) {
    const store = new UsageStore({
      databaseFile: file,
      homeDir: root,
      env: {},
      importDirs: [],
      automaticDiscoveryEnabled: false,
    });
    stores.push(store);
    await store.open();
    store.homes = [{ id: "home", label: "Home", path: root, kind: "codex" }];
    store.serviceTierEvidenceInput = "concurrency-fixture";
    if (anonymous) store.usageProjectionDatabaseIdentity = () => null;
    return store;
  }
  const source = await open();
  source.database
    .prepare("INSERT INTO source_files VALUES(?,?,?,?,?,?,?,?)")
    .run(sourcePath, "codex", "home", "Home", root, 1, 1, "fixture");
  function insert(database, id) {
    const timestamp = START + (id <= 2 ? (id - 1) * DAY : (id === 101 ? 3 : 2) * DAY) + id * 1000;
    const day = new Date(timestamp).toISOString().slice(0, 10);
    database
      .prepare(`INSERT INTO events(
      id,source_path,timestamp_ms,session_id,home_id,home_label,channel,project,cwd,model,
      hour_key,day_key,week_key,month_key,detail_mask,total,input,cached,output,reasoning)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        id,
        sourcePath,
        timestamp,
        "shared-session",
        "home",
        "Home",
        "CLI",
        "fixture",
        "/fixture/project",
        "gpt-6-sol",
        `${day} 00:00`,
        day,
        "2025-12-29",
        day.slice(0, 7),
        15,
        id + 10,
        id,
        5,
        10,
        0,
      );
  }
  source.database.exec("BEGIN");
  for (let id = 1; id <= 100; id++) insert(source.database, id);
  source.database.exec("COMMIT");
  // Match the recovery fixtures' exclusive-copy fallback on Windows test hosts.
  const fsPromises = process.getBuiltinModule("fs/promises"),
    originalLink = fsPromises.link;
  fsPromises.link = (from, to) => copyFile(from, to, fsConstants.COPYFILE_EXCL);
  syncBuiltinESMExports();
  try {
    const archives = [];
    for (let day = 0; day < 2; day++) {
      const archive = path.join(root, `segment-${day}.sqlite`);
      await createHistoryArchiveCandidate(source.database, archive, {
        startMs: START + day * DAY,
        endMs: START + (day + 1) * DAY,
      });
      archives.push(archive);
    }
    for (const archive of archives)
      await source.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(source.database, archive));
  } finally {
    fsPromises.link = originalLink;
    syncBuiltinESMExports();
  }
  const filters = { ...FILTERS, now: new Date(FILTERS.now) };
  assert.equal((await source.dashboardHistory(filters, { includeDetails: false })).summary.eventCount, 100);
  const current = () => path.join(cache, JSON.parse(readFileSync(path.join(cache, "current.json"), "utf8")).file);
  const originalFile = current();
  const baseline = plainRows(
    source.historyProjectionStore.query.database.prepare(
      "SELECT rowid AS raw_id,* FROM history_query_rows ORDER BY rowid",
    ),
  );
  source.close();
  function child(options = {}) {
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const config = { root, file, filters: FILTERS, ...options };
    const processChild = fork(
      new URL("./fixtures/history-projection-concurrency-child.mjs", import.meta.url),
      [JSON.stringify(config)],
      {
        env: environment,
        execArgv: [],
        windowsHide: true,
        serialization: "advanced",
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    const messages = [];
    let errors = "",
      failure;
    processChild.stderr.on("data", (chunk) => {
      errors = (errors + chunk).slice(-8192);
    });
    processChild.on("error", (error) => {
      failure = error;
    });
    processChild.on("message", (message) => {
      messages.push(message);
      if (message.stage === "failed") failure = new Error(message.message);
    });
    const exited = new Promise((resolve) => processChild.once("exit", (code, signal) => resolve({ code, signal })));
    const result = {
      process: processChild,
      messages,
      exited,
      async wait(stage, count = 1) {
        const deadline = Date.now() + 15000;
        for (;;) {
          if (failure) throw failure;
          const found = messages.filter(
            (message) =>
              message.stage === stage &&
              message.phase === (options.holdLock ? "hold" : stage === "ready" ? "warm" : "read"),
          );
          if (found.length >= count) return found[count - 1];
          if (processChild.exitCode !== null || processChild.signalCode !== null)
            throw new Error(`Child exited waiting for ${stage}: ${errors}`);
          if (Date.now() > deadline) throw new Error(`Child timed out waiting for ${stage}: ${errors}`);
          await setTimeout(10);
        }
      },
      read() {
        processChild.send({ command: "read" });
      },
    };
    children.push(result);
    return result;
  }
  async function append() {
    const writer = await open();
    try {
      const before = readHistoryProjectionStamp(writer.database);
      writer.database.exec("BEGIN IMMEDIATE");
      insert(writer.database, 101);
      recordHistoryProjectionBatch(writer.database, before, { sources: [sourcePath], mode: "append" });
      writer.database.exec("COMMIT");
    } finally {
      writer.close();
    }
    const oracle = await open(true);
    try {
      return clean(await oracle.dashboardHistory(filters, { includeDetails: false }));
    } finally {
      oracle.close();
    }
  }
  function checkFacts() {
    assert.equal(current(), originalFile, "append must update the existing published cache");
    const database = new DatabaseSync(current(), { readOnly: true });
    const primary = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = plainRows(database.prepare("SELECT rowid AS raw_id,* FROM history_query_rows ORDER BY rowid"));
      assert.equal(rows.length, 101);
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM events").get().n, 101);
      assert.equal(database.prepare("SELECT COUNT(DISTINCT event_id) AS n FROM history_query_rows").get().n, 101);
      assert.deepEqual(
        database.prepare("SELECT payload FROM history_query_rows GROUP BY payload HAVING COUNT(*)>1").all(),
        [],
      );
      const appended = rows.filter((row) => JSON.parse(row.payload).total === 111);
      assert.equal(appended.length, 1, "both readers must apply the same append exactly once");
      assert.deepEqual(
        rows.filter((row) => row.raw_id !== appended[0].raw_id),
        baseline,
      );
      assert.deepEqual(
        JSON.parse(database.prepare("SELECT inputs_json FROM usage_history_projection_cache").get().inputs_json),
        readHistoryProjectionStamp(primary),
      );
      assert.equal(primary.prepare("SELECT COUNT(*) AS n FROM events").get().n, 99);
      assert.equal(existsSync(path.join(cache, "candidate.json")), false);
      assert.equal(readdirSync(cache).filter((name) => /^projection-.*\.sqlite$/.test(name)).length, 1);
    } finally {
      database.close();
      primary.close();
    }
  }
  function checkpoint() {
    const database = new DatabaseSync(file);
    try {
      database.exec("PRAGMA busy_timeout=0");
      assert.equal(database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get().busy, 0);
    } finally {
      database.close();
    }
  }
  return { root, child, append, checkFacts, checkpoint };
}

test("two processes read the same append from an existing cache without duplicate facts or competing prepare", {
  timeout: 30000,
}, async (t) => {
  const f = await fixture(t),
    releaseFile = path.join(f.root, "release-apply");
  const first = f.child({ holdBeforeApply: true, releaseFile });
  await first.wait("ready");
  const second = f.child();
  await second.wait("ready");
  assert.notEqual(first.process.pid, second.process.pid);
  const expected = await f.append();
  first.read();
  assert.equal((await first.wait("before-apply")).primaryTransaction, false);
  second.read();
  assert.equal((await second.wait("lock-wait")).primaryTransaction, false);
  await second.wait("heartbeat", 3);
  assert.equal(
    second.messages.some((message) => message.phase === "read" && message.stage === "prepared"),
    false,
  );
  f.checkpoint();
  writeFileSync(releaseFile, "release");
  const [a, b] = await Promise.all([first.wait("done"), second.wait("done")]);
  assert.deepEqual(clean(a.result), expected);
  assert.deepEqual(clean(b.result), expected);
  assert.equal(a.work.delta.added, 1);
  assert.equal(b.work.reused, true, "the waiter must re-read the committed projection header");
  for (const result of await Promise.all([first.exited, second.exited]))
    assert.deepEqual(result, { code: 0, signal: null });
  f.checkFacts();
});

test("killing a maintenance lock owner lets the waiting process finish without blocking the primary WAL", {
  timeout: 30000,
}, async (t) => {
  const f = await fixture(t);
  const waiting = f.child();
  await waiting.wait("ready");
  const owner = f.child({ holdLock: true });
  assert.equal((await owner.wait("held")).primaryTransaction, false);
  const expected = await f.append();
  waiting.read();
  assert.equal((await waiting.wait("lock-wait")).primaryTransaction, false);
  await waiting.wait("heartbeat", 3);
  assert.equal(
    waiting.messages.some((message) => message.phase === "read" && message.stage === "prepared"),
    false,
  );
  f.checkpoint();
  assert.equal(owner.process.kill("SIGKILL"), true);
  assert.deepEqual(await owner.exited, { code: null, signal: "SIGKILL" });
  const result = await waiting.wait("done");
  assert.deepEqual(clean(result.result), expected);
  assert.equal(result.work.delta.added, 1);
  assert.deepEqual(await waiting.exited, { code: 0, signal: null });
  f.checkFacts();
  f.checkpoint();
});
