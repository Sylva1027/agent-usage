import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { UsageStore } from "../src/usage-store.js";

const OLD = { fingerprint: "old", generatedAt: "2026-07-12T12:00:00.000Z", checkedAt: "2026-07-12T12:00:00.000Z" };
const NEXT = { fingerprint: "new", generatedAt: "2026-07-13T12:00:00.000Z", checkedAt: "2026-07-13T12:00:00.000Z" };
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

async function waitFor(check) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("executor fixture timed out");
    await pause();
  }
}

async function mockChild() {
  const root = process.env.HISTORY_PROJECTION_EXECUTOR_ROOT;
  const mode = process.env.HISTORY_PROJECTION_EXECUTOR_MODE;
  const file = (name) => path.join(root, name);
  UsageStore.prototype.captureUsageProjection = () => {
    appendFileSync(file("captures"), "capture\n");
    return null;
  };
  UsageStore.prototype.acquirePublishedHistoryReader = async function () {
    appendFileSync(file("acquires"), "acquire\n");
    assert.equal(this.database.isTransaction, false);
    if (mode === "unavailable") return null;
    if (mode === "missing") throw Object.assign(new Error("archive missing"), { code: "ENOENT" });
    const reader = new UsageStore({ databaseFile: file("side.sqlite") });
    reader.database = new DatabaseSync(reader.databaseFile, { readOnly: true });
    reader.database.exec("BEGIN");
    reader.database.prepare("SELECT total FROM events").get();
    reader.publishedHistoryProjection = true;
    const close = reader.close;
    reader.close = function () {
      close.call(this);
      appendFileSync(file("closes"), "close\n");
    };
    return reader;
  };
  UsageStore.prototype.sync = async function () {
    if (mode !== "sync-failure") {
      this.database.exec("BEGIN IMMEDIATE; UPDATE events SET total=200,input=180 WHERE id=1; COMMIT");
      const side = new DatabaseSync(file("side.sqlite"));
      try {
        side.exec("UPDATE events SET total=200");
      } finally {
        side.close();
      }
    }
    writeFileSync(file("sync-ready"), "ready");
    await waitFor(() => existsSync(file("sync-release")));
    if (mode === "sync-failure") throw Object.assign(new Error("sync failed"), { code: "SYNC_FAILED" });
    return NEXT;
  };
  UsageStore.prototype.prepareMetadataProjection = () => {};
  UsageStore.prototype.metadata = function () {
    return { eventCount: Number(this.database.prepare("SELECT COUNT(*) AS n FROM events").get().n) };
  };
  UsageStore.prototype.dashboardHistory = async function (filters) {
    if (this.publishedHistoryProjection) {
      appendFileSync(file("verifications"), "verify\n");
      if (filters.fail) throw Object.assign(new Error("archive changed"), { code: "HISTORY_ARCHIVE_SEGMENT_MISMATCH" });
      if (filters.hold) {
        writeFileSync(file("read-ready"), "ready");
        await waitFor(() => existsSync(file("read-release")));
      }
    }
    return {
      summary: { totals: { total: Number(this.database.prepare("SELECT SUM(total) AS n FROM events").get().n) } },
    };
  };
  await import("../src/usage-executor.js");
}

async function fixture(t, { cold = true, mode = "side" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "history-projection-executor-"));
  const databaseFile = path.join(root, "usage.sqlite");
  const source = new UsageStore({ homeDir: root, env: {}, databaseFile, importDirs: [] });
  await source.open();
  try {
    source.database
      .prepare("INSERT INTO source_files VALUES (?,?,?,?,?,?,?,?)")
      .run("source", "main", "home", "Home", root, 1, 1, OLD.generatedAt);
    source.database.exec(`INSERT INTO events (
      id,source_path,timestamp_ms,session_id,home_id,home_label,channel,project,model,
      hour_key,day_key,week_key,month_key,total,input,cached,output,reasoning
    ) VALUES (1,'source',10,'session','home','Home','Codex','project','model',
      '2026-07-12 00:00','2026-07-12','2026-07-06','2026-07',100,80,0,20,0)`);
    if (cold) {
      source.database
        .prepare("INSERT INTO archive_segments VALUES (?,?,?,?,?,?,?)")
        .run("a".repeat(64), path.join(root, "archive.sqlite"), "b".repeat(64), 0, 5, 1, 1);
      source.writeMeta(
        "history_archive_event_authority",
        JSON.stringify({ formatVersion: 1, segmentIds: ["a".repeat(64)] }),
      );
    }
  } finally {
    source.close();
  }
  const side = new DatabaseSync(path.join(root, "side.sqlite"));
  side.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE events(id INTEGER PRIMARY KEY,total INTEGER); INSERT INTO events VALUES(1,100)",
  );
  side.close();
  const children = [];
  t.after(async () => {
    writeFileSync(path.join(root, "sync-release"), "release");
    writeFileSync(path.join(root, "read-release"), "release");
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  async function start(status = OLD) {
    const environment = {
      ...process.env,
      CODEX_USAGE_EXECUTOR_CHILD: "1",
      HISTORY_PROJECTION_EXECUTOR_ROOT: root,
      HISTORY_PROJECTION_EXECUTOR_MODE: mode,
    };
    delete environment.NODE_TEST_CONTEXT;
    const child = fork(fileURLToPath(import.meta.url), ["--fixture-child"], {
      execArgv: [],
      env: environment,
      serialization: "advanced",
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(child);
    const pending = new Map();
    const states = [];
    let ready = false,
      nextId = 0,
      errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    child.on("message", (message) => {
      if (message.type === "ready") ready = true;
      if (message.type === "state") states.push(message.state);
      if (message.type !== "response") return;
      const operation = pending.get(message.id);
      if (!operation) return;
      pending.delete(message.id);
      clearTimeout(operation.timer);
      if (message.ok) operation.resolve(message.result);
      else operation.reject(Object.assign(new Error(message.error.message), message.error));
    });
    child.on("exit", () => {
      for (const operation of pending.values()) {
        clearTimeout(operation.timer);
        operation.reject(new Error(`executor fixture exited: ${errors}`));
      }
      pending.clear();
    });
    child.send({ type: "init", options: { homeDir: root, env: {}, databaseFile, importDirs: [] }, state: { status } });
    await waitFor(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(errors);
      return ready;
    });
    return {
      child,
      states,
      request(type, payload = {}) {
        return new Promise((resolve, reject) => {
          const id = ++nextId;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`${type} fixture timed out: ${errors}`));
          }, 10000);
          pending.set(id, { resolve, reject, timer });
          child.send({ type, id, ...payload });
        });
      },
    };
  }
  return {
    root,
    databaseFile,
    start,
    file: (name) => path.join(root, name),
    checkpoint(file = databaseFile) {
      const database = new DatabaseSync(file);
      try {
        database.exec("PRAGMA busy_timeout=0");
        return database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      } finally {
        database.close();
      }
    },
  };
}

if (process.argv.includes("--fixture-child")) {
  await mockChild();
} else {
  test("mixed sync pins the old side version, releases the primary WAL and publishes only complete status", async (t) => {
    const input = await fixture(t);
    const worker = await input.start();
    const sync = worker.request("sync");
    await waitFor(() => existsSync(input.file("sync-ready")));
    assert.equal(input.checkpoint().busy, 0);
    for (let round = 0; round < 2; round++) {
      const old = await worker.request("dashboard");
      assert.deepEqual(old.status, OLD);
      assert.equal(old.summary.totals.total, 100);
    }
    assert.equal(
      worker.states.some((state) => state.status?.fingerprint === NEXT.fingerprint),
      false,
    );
    assert.equal(existsSync(input.file("captures")), false);
    assert.equal(readFileSync(input.file("verifications"), "utf8").trim().split("\n").length, 2);
    writeFileSync(input.file("sync-release"), "release");
    assert.deepEqual(await sync, NEXT);
    assert.equal(readFileSync(input.file("closes"), "utf8"), "close\n");
    const fresh = await worker.request("dashboard");
    assert.deepEqual(fresh.status, NEXT);
    assert.equal(fresh.summary.totals.total, 200);
    assert.equal(input.checkpoint().busy, 0);
    await worker.request("close");
  });

  test("a side lease outlives an in-flight old dashboard after sync publishes the next version", async (t) => {
    const input = await fixture(t);
    const worker = await input.start();
    const sync = worker.request("sync");
    await waitFor(() => existsSync(input.file("sync-ready")));
    const old = worker.request("dashboard", { filters: { hold: true } });
    await waitFor(() => existsSync(input.file("read-ready")));
    writeFileSync(input.file("sync-release"), "release");
    await sync;
    assert.equal(existsSync(input.file("closes")), false);
    const fresh = await worker.request("dashboard");
    assert.equal(fresh.status.fingerprint, NEXT.fingerprint);
    assert.equal(fresh.summary.totals.total, 200);
    writeFileSync(input.file("read-release"), "release");
    const result = await old;
    assert.deepEqual(result.status, OLD);
    assert.equal(result.summary.totals.total, 100);
    assert.equal(readFileSync(input.file("closes"), "utf8"), "close\n");
    assert.equal(input.checkpoint(input.file("side.sqlite")).busy, 0);
    await worker.request("close");
  });

  test("full-hot sync retains the established primary BEGIN path without acquiring a side lease", async (t) => {
    const input = await fixture(t, { cold: false });
    const worker = await input.start();
    const sync = worker.request("sync");
    await waitFor(() => existsSync(input.file("sync-ready")));
    assert.equal(existsSync(input.file("acquires")), false);
    assert.equal(input.checkpoint().busy, 1);
    const old = await worker.request("dashboard");
    assert.deepEqual(old.status, OLD);
    assert.equal(old.summary.totals.total, 100);
    writeFileSync(input.file("sync-release"), "release");
    await sync;
    assert.equal(input.checkpoint().busy, 0);
    await worker.request("close");
  });

  for (const [mode, code] of [
    ["unavailable", "HISTORY_PROJECTION_UNAVAILABLE"],
    ["missing", "ENOENT"],
  ]) {
    test(`mixed ${mode} acquisition cannot fall back to a primary reader or begin sync`, async (t) => {
      const input = await fixture(t, { mode });
      const worker = await input.start();
      await assert.rejects(worker.request("sync"), { code });
      assert.equal(existsSync(input.file("sync-ready")), false);
      assert.equal(existsSync(input.file("captures")), false);
      assert.equal(input.checkpoint().busy, 0);
      assert.equal(
        worker.states.some((state) => state.status?.fingerprint === NEXT.fingerprint),
        false,
      );
      await worker.request("close");
    });
  }

  test("verification and sync failures release the lease and retain the last published status", async (t) => {
    const input = await fixture(t, { mode: "sync-failure" });
    const worker = await input.start();
    const sync = worker.request("sync");
    const failed = assert.rejects(sync, { code: "SYNC_FAILED" });
    await waitFor(() => existsSync(input.file("sync-ready")));
    await assert.rejects(worker.request("dashboard", { filters: { fail: true } }), {
      code: "HISTORY_ARCHIVE_SEGMENT_MISMATCH",
    });
    writeFileSync(input.file("sync-release"), "release");
    await failed;
    assert.equal(readFileSync(input.file("closes"), "utf8"), "close\n");
    const old = await worker.request("dashboard");
    assert.deepEqual(old.status, OLD);
    assert.equal(old.summary.totals.total, 100);
    assert.equal(input.checkpoint().busy, 0);
    await worker.request("close");
  });

  test("a killed executor releases the side lease and a new process recovers from isolated committed databases", async (t) => {
    const input = await fixture(t);
    const first = await input.start();
    const sync = first.request("sync").catch((error) => error);
    await waitFor(() => existsSync(input.file("sync-ready")));
    const exited = once(first.child, "exit");
    first.child.kill("SIGKILL");
    await exited;
    assert.ok((await sync) instanceof Error);
    assert.equal(input.checkpoint().busy, 0);
    assert.equal(input.checkpoint(input.file("side.sqlite")).busy, 0);
    writeFileSync(input.file("sync-release"), "release");
    const second = await input.start(null);
    assert.notEqual(first.child.pid, second.child.pid);
    await second.request("sync");
    const fresh = await second.request("dashboard");
    assert.deepEqual(fresh.status, NEXT);
    assert.equal(fresh.summary.totals.total, 200);
    await second.request("close");
  });
}
