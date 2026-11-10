import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createUsageExecutor } from "../src/usage-executor.js";
import { createCodexIntegrationFixture } from "../test-support/usage-fixture.mjs";

const HOOK = new URL("../test-support/live-source-recovery-hook.mjs", import.meta.url).href;
const FILTERS = { preset: "all", bucket: "day", calendarZone: "utc", now: new Date("2026-10-04T14:00:00Z") };
const line = (total) =>
  `${JSON.stringify({
    type: "event_msg",
    timestamp: "2026-10-04T13:00:00Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          total_tokens: total,
          input_tokens: total,
          cached_input_tokens: 0,
          output_tokens: 0,
        },
      },
    },
  })}\n`;

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Handoff did not reach ${label}`)), 8_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(t) {
  const input = createCodexIntegrationFixture(),
    points = new EventEmitter(),
    trace = [],
    holds = [],
    sockets = new Set(),
    children = [];
  const work = new Set();
  let client, releaseWorker;
  const control = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", (error) => {
      if (error.code !== "ECONNRESET") points.emit("failure", error);
    });
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"),
          event = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        trace.push(event);
        points.emit("point", event);
        const hold = holds.find((row) => !row.event && row.stage === event.stage && row.matches(event));
        if (hold) {
          hold.event = event;
          hold.entered.resolve(event);
        }
        void (hold?.released.promise ?? Promise.resolve()).then(() => {
          if (!socket.destroyed) socket.write(`${JSON.stringify({ id: event.id })}\n`);
        });
      }
    });
  });
  t.after(async () => {
    for (const hold of holds) hold.released.resolve();
    releaseWorker?.();
    try {
      await client?.close();
      await Promise.allSettled(work);
      for (const child of children) await bounded(child.exited, "executor exit");
      assert.ok(
        children.every((child) => child.exitCode === 0 && child.signalCode === null),
        "normal close must release the executor",
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => control.close(resolve));
      t.mock.restoreAll();
      syncBuiltinESMExports();
      input.close();
    }
  });
  await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve));
  const fork = childProcess.fork;
  t.mock.method(childProcess, "fork", (file, args, options) => {
    const child = fork(file, args, {
      ...options,
      execArgv: [...options.execArgv, "--import", HOOK],
      env: { ...options.env, LIVE_RECOVERY_CONTROL_PORT: String(control.address().port), LIVE_RECOVERY_HANDOFF: "1" },
    });
    child.exited = new Promise((resolve) => child.once("exit", resolve));
    children.push(child);
    return child;
  });
  syncBuiltinESMExports();
  client = createUsageExecutor(input.serverOptions);
  releaseWorker = client.retainWorker();
  const track = (promise) => {
    work.add(promise);
    void promise.then(
      () => work.delete(promise),
      () => work.delete(promise),
    );
    return promise;
  };
  const read = () => track(client.dashboard(FILTERS, { includeDetails: false }));
  const sync = () => track(client.sync({ options: input.serverOptions }));
  const append = (total) => appendFile(input.rolloutFiles[0], line(total));
  await append(100);
  const status = await sync(),
    initial = await read();
  assert.ok(status.completion);
  assert.equal(initial.completion, status.completion);
  assert.equal(initial.summary.totals.total, 100);
  assert.equal(initial.metadata.eventCount, 1);
  trace.length = 0;
  return {
    client,
    trace,
    initial,
    read,
    sync,
    append,
    input,
    hold(stage, matches = () => true) {
      const entered = Promise.withResolvers(),
        released = Promise.withResolvers();
      holds.push({ stage, matches, entered, released });
      return { wait: () => bounded(entered.promise, stage), release: () => released.resolve() };
    },
    async wait(stage, matches = () => true) {
      const found = trace.find((row) => row.stage === stage && matches(row));
      if (found) return found;
      const arrival = Promise.withResolvers();
      const listener = (row) => {
        if (row.stage === stage && matches(row)) arrival.resolve(row);
      };
      points.on("point", listener);
      points.on("failure", arrival.reject);
      try {
        return await bounded(arrival.promise, stage);
      } finally {
        points.off("point", listener);
        points.off("failure", arrival.reject);
      }
    },
  };
}

function assertOld(result, initial) {
  for (const field of ["status", "completion", "summary", "metadata", "periodComparison", "pricingCatalog"])
    assert.deepEqual(result[field], initial[field], `pinned ${field} belongs entirely to the prior generation`);
}

async function assertNew(f, status) {
  const result = await f.read();
  assert.ok(status.completion);
  assert.notEqual(status.completion, f.initial.completion);
  assert.equal(result.completion, status.completion);
  assert.equal(result.status.fingerprint, status.fingerprint);
  assert.notEqual(result.status.fingerprint, f.initial.status.fingerprint);
  assert.equal(result.summary.totals.total, 137);
  assert.equal(result.summary.eventCount, 2);
  assert.equal(result.metadata.eventCount, 2);
  assert.equal(result.metadata.sessionCount, 1);
  assert.equal(result.periodComparison.totals.all.total, 137);
  const db = new DatabaseSync(f.input.serverOptions.databaseFile);
  try {
    assert.equal(db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get().busy, 0, "retired pin was released");
  } finally {
    db.close();
  }
}

test("sync waits for an admitted direct reader; later readers pin a whole generation across the next commit", {
  timeout: 20_000,
}, async (t) => {
  const f = await fixture(t),
    directGate = f.hold("reader-enter");
  const direct = f.read(),
    directEntry = await directGate.wait();
  assert.equal(directEntry.pinned, false);
  assert.equal(directEntry.liveReaders, 1);
  await f.append(37);
  const syncGate = f.hold("sync-start"),
    syncing = f.sync();
  const waiting = await f.wait("sync-wait");
  assert.equal(waiting.liveReaders, 1);
  const pinGate = f.hold("reader-enter"),
    later = f.read();
  await f.wait("reader-wait", (row) => row.requestId !== directEntry.requestId);
  assert.equal(
    f.trace.some((row) => row.stage === "sync-start"),
    false,
  );
  directGate.release();
  assertOld(await direct, f.initial);
  const started = await syncGate.wait(),
    pinned = await pinGate.wait();
  assert.equal(started.liveReaders, 0);
  assert.equal(started.pinned, true);
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.liveReaders, 0);
  assert.ok(
    f.trace.findIndex((row) => row.stage === "reader-result" && row.requestId === directEntry.requestId) <
      f.trace.indexOf(started),
    "sync must not pass the still-entered direct reader",
  );
  syncGate.release();
  const status = await syncing;
  pinGate.release();
  assertOld(await later, f.initial);
  await assertNew(f, status);
});

test("a reader resumed from the old barrier rechecks identity and waits for the new barrier before taking its pin", {
  timeout: 20_000,
}, async (t) => {
  const f = await fixture(t),
    oldBarrier = f.hold("reader-wait");
  const reading = f.read(),
    old = await oldBarrier.wait();
  await f.append(37);
  const newBarrier = f.hold("sync-wait"),
    syncing = f.sync();
  assert.equal((await newBarrier.wait()).liveReaders, 0);
  const recheck = f.hold("reader-wait", (row) => row.requestId === old.requestId);
  oldBarrier.release();
  await recheck.wait();
  assert.equal(f.trace.filter((row) => row.stage === "reader-wait" && row.requestId === old.requestId).length, 2);
  assert.equal(
    f.trace.some((row) => row.stage === "reader-enter"),
    false,
    "old barrier cannot admit a direct reader",
  );
  const pinGate = f.hold("reader-enter"),
    syncGate = f.hold("sync-start");
  recheck.release();
  newBarrier.release();
  await syncGate.wait();
  const pinned = await pinGate.wait();
  assert.equal(pinned.requestId, old.requestId);
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.liveReaders, 0);
  syncGate.release();
  const status = await syncing;
  pinGate.release();
  assertOld(await reading, f.initial);
  await assertNew(f, status);
});
