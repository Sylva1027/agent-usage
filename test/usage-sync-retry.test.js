import assert from "node:assert/strict";
import test from "node:test";
import { syncUsageStore } from "../src/usage-executor.js";

const live = { sourceKind: "codex", code: "LIVE_SOURCE_CHANGED" };

test("executor revalidates a transient Codex source change once and returns the newly validated status", async () => {
  const options = { homeDir: "fixture" };
  const statuses = [{ fingerprint: "failed-window" }, { fingerprint: "complete-window" }];
  let calls = 0;
  const store = {
    async sync(args) {
      assert.strictEqual(args.options, options);
      return statuses[calls++];
    },
    perfState: () => ({ sourceWarnings: [live] }),
  };
  assert.strictEqual(await syncUsageStore(store, options), statuses[1]);
  assert.equal(calls, 2);
});

test("executor does not retry clean, deterministic, other-source, or mixed failures", async () => {
  for (const warnings of [
    [],
    [{ ...live, code: "UNSUPPORTED_SCHEMA" }],
    [{ ...live, sourceKind: "dsh" }],
    [live, { ...live, code: "UNKEYABLE_RECORD" }],
  ]) {
    let calls = 0;
    const status = {};
    const store = {
      async sync() {
        calls += 1;
        return status;
      },
      perfState: () => ({ sourceWarnings: warnings }),
    };
    assert.strictEqual(await syncUsageStore(store, {}), status);
    assert.equal(calls, 1);
  }
});

test("continuous writes stay bounded at two attempts and exceptions remain failures", async () => {
  let calls = 0;
  const store = {
    async sync() {
      calls += 1;
      return { state: "degraded" };
    },
    perfState: () => ({ sourceWarnings: [live] }),
  };
  assert.deepEqual(await syncUsageStore(store, {}), { state: "degraded" });
  assert.equal(calls, 2);
  for (const failAt of [1, 2]) {
    calls = 0;
    const error = new Error("sync failed");
    store.sync = async () => {
      if (++calls === failAt) throw error;
      return { state: "degraded" };
    };
    await assert.rejects(syncUsageStore(store, {}), error);
    assert.equal(calls, failAt);
  }
});
