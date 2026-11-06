import assert from "node:assert/strict";
import test from "node:test";
import { createUsageExecutor } from "../src/usage-executor.js";
import { createUsageSourceWatcher } from "../src/usage-source-watch.js";
import { createCodexIntegrationFixture } from "../test-support/usage-fixture.mjs";

test("a pending source hint retains the existing worker through debounce and verification, then allows idle exit", async (t) => {
  const input = createCodexIntegrationFixture();
  const idleTimeoutMs = 61_347,
    idle = [],
    timeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
    if (ms !== idleTimeoutMs) return timeout(callback, ms, ...args);
    idle.push(callback);
    return { unref() {} };
  });
  const client = createUsageExecutor(input.serverOptions, { idleTimeoutMs });
  const verification = Promise.withResolvers();
  let hint, debounce, watcher;
  t.after(async () => {
    verification.resolve();
    await watcher?.stop();
    await client.close();
    input.close();
  });
  await client.sync({ options: input.serverOptions });
  const pid = client.pid,
    fingerprint = client.status.fingerprint,
    staleIdle = idle.at(-1);
  watcher = createUsageSourceWatcher({
    discoverRoots: async () => [{ path: input.codexHome, recursive: true }],
    watchFile: (_root, _options, callback) => {
      hint = callback;
      return { on() {}, unref() {}, close() {} };
    },
    schedule: (callback) => {
      debounce = callback;
      return { unref() {} };
    },
    cancel() {},
    retainPending: () => client.retainWorker(),
    onHint: () => verification.promise,
  });
  await watcher.start();
  hint("change", "rollout.jsonl");
  staleIdle();
  assert.equal(await client.validateAcquisition(fingerprint), true, "known pending work cannot retire its executor");
  assert.equal(client.pid, pid);
  debounce();
  staleIdle();
  assert.equal(await client.validateAcquisition(fingerprint), true, "verification still owns its worker lease");
  const scheduled = idle.length;
  verification.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(idle.length > scheduled, "verification completion restores the existing idle policy");
  idle.at(-1)();
  assert.equal(await client.validateAcquisition(fingerprint), false);
});

test("watcher bursts, overlapping verification and stop release each pending lease once", async () => {
  let hint,
    held = 0,
    acquired = 0,
    released = 0;
  const timers = [],
    gates = [];
  const watcher = createUsageSourceWatcher({
    discoverRoots: async () => [{ path: "." }],
    watchFile: (_root, _options, callback) => {
      hint = callback;
      return { on() {}, unref() {}, close() {} };
    },
    schedule: (callback) => {
      timers.push(callback);
      return { unref() {} };
    },
    cancel() {},
    retainPending: () => {
      held++;
      acquired++;
      return () => {
        held--;
        released++;
      };
    },
    onHint: () => {
      const gate = Promise.withResolvers();
      gates.push(gate);
      return gate.promise;
    },
  });
  try {
    await watcher.start();
    hint("change", "one");
    hint("change", "two");
    assert.equal(acquired, 1);
    timers[0]();
    await Promise.resolve();
    assert.equal(gates.length, 1);
    hint("change", "three");
    assert.equal(held, 2);
    await watcher.stop();
    assert.equal(held, 1, "stop cancels pending debounce, not active verification");
    timers[1]();
    assert.equal(gates.length, 1, "a canceled callback cannot start verification");
    gates[0].resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(held, 0);
    assert.equal(released, acquired);
    await watcher.stop();
    assert.equal(released, acquired);
  } finally {
    for (const gate of gates) gate.resolve();
    await watcher.stop();
  }
});

for (const failure of ["throw", "reject"]) {
  test(`watcher ${failure} during verification releases its lease`, async () => {
    let hint,
      timer,
      released = 0;
    const watcher = createUsageSourceWatcher({
      discoverRoots: async () => [{ path: "." }],
      watchFile: (_root, _options, callback) => {
        hint = callback;
        return { on() {}, unref() {}, close() {} };
      },
      schedule: (callback) => {
        timer = callback;
        return { unref() {} };
      },
      cancel() {},
      retainPending: () => () => {
        released++;
      },
      onHint: () => {
        if (failure === "throw") throw new Error("verification failed");
        return Promise.reject(new Error("verification failed"));
      },
    });
    try {
      await watcher.start();
      hint("change", "one");
      timer();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(released, 1);
      await watcher.stop();
      assert.equal(released, 1);
    } finally {
      await watcher.stop();
    }
  });
}
