import { existsSync } from "node:fs";

import { HistoryProjectionStore } from "../../src/usage-history-projection-store.js";
import { UsageStore } from "../../src/usage-store.js";

const config = JSON.parse(process.argv[2]);
const store = new UsageStore({
  databaseFile: config.file,
  homeDir: config.root,
  env: {},
  importDirs: [],
  automaticDiscoveryEnabled: false,
});
let phase = "warm";
const send = (message) =>
  new Promise((resolve, reject) => {
    process.send({ ...message, pid: process.pid, phase }, (error) => (error ? reject(error) : resolve()));
  });
const heartbeat = setInterval(() => {
  void send({ stage: "heartbeat" }).catch(() => {});
}, 25);
let release;

try {
  await store.open();
  store.homes = [{ id: "home", label: "Home", path: config.root, kind: "codex" }];
  store.serviceTierEvidenceInput = "concurrency-fixture";
  const lock = HistoryProjectionStore.prototype.lock;
  HistoryProjectionStore.prototype.lock = async function (...args) {
    await send({ stage: "lock-wait", primaryTransaction: store.database.isTransaction });
    const unlock = await lock.apply(this, args);
    await send({ stage: "locked", primaryTransaction: store.database.isTransaction });
    return unlock;
  };
  const prepare = HistoryProjectionStore.prototype.prepare;
  HistoryProjectionStore.prototype.prepare = function (...args) {
    const prepared = prepare.apply(this, args);
    void send({ stage: "prepared", delta: Boolean(prepared.delta), reused: prepared.reused });
    return prepared;
  };
  const apply = HistoryProjectionStore.prototype.applyDelta;
  HistoryProjectionStore.prototype.applyDelta = function (...args) {
    if (config.holdBeforeApply && phase === "read") {
      void send({ stage: "before-apply", primaryTransaction: store.database.isTransaction });
      const deadline = Date.now() + 15000;
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(config.releaseFile)) {
        if (Date.now() > deadline) throw new Error("parent did not release the captured append");
        Atomics.wait(sleeper, 0, 0, 5);
      }
    }
    return apply.apply(this, args);
  };
  if (config.holdLock) {
    phase = "hold";
    release = await new HistoryProjectionStore(config.file, (row) => row).lock();
    await send({ stage: "held", primaryTransaction: store.database.isTransaction });
    await new Promise(() => {});
  } else {
    const filters = { ...config.filters, now: new Date(config.filters.now) };
    await store.dashboardHistory(filters, { includeDetails: false });
    const started = new Promise((resolve) => process.once("message", resolve));
    await send({ stage: "ready" });
    const message = await started;
    if (message.command !== "read") throw new Error("unexpected parent command");
    phase = "read";
    const result = await store.dashboardHistory(filters, { includeDetails: false });
    await send({ stage: "done", result, work: store.lastHistoryQueryWork.projection });
  }
} catch (error) {
  await send({ stage: "failed", message: error.stack, code: error.code });
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  release?.();
  store.close();
  if (process.connected) process.disconnect();
}
