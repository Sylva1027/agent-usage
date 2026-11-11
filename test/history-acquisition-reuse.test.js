import assert from "node:assert/strict";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import childProcess from "node:child_process";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { certifyHistoryProjectionBaseline, readHistoryProjectionStamp } from "../src/usage-history-projection-store.js";
import { createUsageServer } from "../src/server.js";
import { createUsageExecutor } from "../src/usage-executor.js";
import { UsageStore } from "../src/usage-store.js";
import { UsageSummaryCache } from "../src/usage-summary-cache.js";
import { createUsageIntegrationFixture } from "../test-support/usage-fixture.mjs";

const query = "/api/usage?preset=custom&startDate=2026-10-03&endDate=2026-10-03&view=dashboard&calendarZone=utc";

async function fixture(t, { direct = false, server: serve = false, probe = "", idleTimeoutMs = 60_000 } = {}) {
  const input = createUsageIntegrationFixture();
  const options = { ...input.serverOptions, executorIdleTimeoutMs: idleTimeoutMs };
  const store = new UsageStore(options);
  const argv = [...process.execArgv],
    children = [],
    sent = [],
    validations = [],
    idleTimers = [];
  let client, server, base;
  t.after(async () => {
    await server?.close();
    await client?.close();
    store.close();
    process.execArgv.splice(0, process.execArgv.length, ...argv);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    input.close();
  });
  await store.sync();
  const segment = path.join(path.dirname(options.databaseFile), "cold.sqlite");
  await createHistoryArchiveCandidate(store.database, segment, {
    startMs: Date.parse("2026-10-03T00:00:00Z"),
    endMs: Date.parse("2026-10-04T00:00:00Z"),
  });
  await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, segment));
  await store.ensureHistoryProjectionTracking();
  store.close();

  const mutation =
    probe === "certify"
      ? "this.historyProjectionModule.certifyHistoryProjectionBaseline(this.database,this.historyProjectionModule.readHistoryProjectionStamp(this.database));"
      : "this.serviceTierEvidence={resolve(){return 'unknown';}};";
  const loader = `import {registerHooks} from 'node:module'; registerHooks({load(url,ctx,next){
    const value=next(url,ctx);
    if(url.endsWith('/src/usage-source-proof.js'))return {...value,source:value.source+'\\nUsageSourceProof.prototype.provider=async()=>null;'};
    if(${Boolean(probe)}&&url.endsWith('/src/usage-store.js'))return {...value,source:value.source+${JSON.stringify(`\nUsageStore.prototype.publishedUsageEvents=function(){${mutation}return [];};`)}};
    return value;}});`;
  process.execArgv.push("--import", `data:text/javascript,${encodeURIComponent(loader)}`);
  const fork = childProcess.fork;
  t.mock.method(childProcess, "fork", (...args) => {
    const child = fork(...args),
      requests = new Map();
    children.push(child);
    const send = child.send;
    t.mock.method(child, "send", function (message, ...rest) {
      requests.set(message.id, message.type);
      sent.push(message);
      return send.call(this, message, ...rest);
    });
    child.on("message", (message) => {
      if (message.type !== "response") return;
      if (requests.get(message.id) === "validateAcquisition") validations.push(message.result);
      requests.delete(message.id);
    });
    return child;
  });
  syncBuiltinESMExports();
  if (serve) {
    const timeout = globalThis.setTimeout;
    t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
      if (ms !== idleTimeoutMs) return timeout(callback, ms, ...args);
      idleTimers.push(callback);
      return { unref() {} };
    });
    t.mock.method(UsageSummaryCache.prototype, "publish", async () => {});
    server = createUsageServer(options);
    await listenOnFetchPort(server);
    base = `http://127.0.0.1:${server.address().port}`;
  } else if (direct) {
    client = createUsageExecutor(options);
    await client.sync({ options });
  } else {
    await store.open();
    store.installUsageProjectionTracker();
  }
  return {
    store,
    client,
    options,
    sent,
    children,
    validations,
    idleTimers,
    async get() {
      const response = await fetch(base + query),
        body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    },
  };
}

test("cold acquisition tracks only owned derivations and keeps default snapshot guards closed", async (t) => {
  const { store, options } = await fixture(t);
  const key = () => store.usageProjectionChangeKey(undefined, true);
  const guard = () => store.usageProjectionGuard({ includeHistory: true });
  assert.equal(store.usageProjectionGuard(), null);
  assert.equal(store.captureUsageProjection(), null);
  assert.ok(guard());
  const before = key(),
    beforeGuard = guard();
  certifyHistoryProjectionBaseline(store.database, readHistoryProjectionStamp(store.database));
  assert.equal(key(), before);
  assert.deepEqual(guard(), beforeGuard);

  for (const [name, sql] of [
    ["facts", "UPDATE events SET total=total+1 WHERE id=(SELECT MIN(id) FROM events)"],
    ["fact revision", "UPDATE usage_business_revision SET revision=revision+1 WHERE singleton=1"],
    ["source", "UPDATE source_files SET indexed_at='receipt-test'"],
    [
      "quota",
      "INSERT INTO rate_limit_observations(source_path,line_number,role,observed_at_ms,limit_id,window_minutes,resets_at_ms,used_percent) SELECT path,777,'primary',0,'codex',300,18000000,20 FROM source_files LIMIT 1",
    ],
    ["metadata", "INSERT OR REPLACE INTO store_meta VALUES('receipt-business-input','changed')"],
    ["auxiliary input", "INSERT OR REPLACE INTO store_meta VALUES('official_quota_observations','[]')"],
    ["main schema", "CREATE TABLE receipt_main(value INTEGER)"],
    ["TEMP schema", "CREATE TEMP TABLE receipt_temp(value INTEGER)"],
  ]) {
    const prior = key();
    store.database.exec("SAVEPOINT receipt_mutation");
    try {
      store.database.exec(sql);
      assert.notEqual(key(), prior, name);
      if (name.endsWith("schema")) assert.equal(guard(), null, name);
    } finally {
      store.database.exec("ROLLBACK TO receipt_mutation; RELEASE receipt_mutation");
    }
  }
  const priorIdentity = store.openedUsageProjectionIdentity;
  store.openedUsageProjectionIdentity = "different-file";
  assert.equal(guard(), null, "a different database identity cannot reuse acquisition");
  store.openedUsageProjectionIdentity = priorIdentity;
  const priorKey = key(),
    priorVersion = guard().dataVersion;
  const external = new DatabaseSync(options.databaseFile);
  try {
    external.prepare("UPDATE usage_history_projection_inputs SET token=? WHERE singleton=1").run("external-write");
  } finally {
    external.close();
  }
  assert.equal(key(), priorKey, "the external write touches only an ignored derivation table");
  assert.notEqual(guard().dataVersion, priorVersion, "external commits still revoke acquisition");
});

test("IPC cold acquisition acknowledges its own baseline certification but rejects external commits", async (t) => {
  const f = await fixture(t, { direct: true, probe: "certify" });
  const fingerprint = f.client.status.fingerprint;
  assert.equal(await f.client.validateAcquisition(fingerprint), true);
  assert.equal(await f.client.validateAcquisition(`${fingerprint}-wrong`), false);
  const observer = new DatabaseSync(f.options.databaseFile, { readOnly: true });
  try {
    const version = observer.prepare("PRAGMA data_version").get().data_version;
    const sequence = readHistoryProjectionStamp(observer).sequence;
    await f.client.publishedUsageEvents();
    assert.equal(readHistoryProjectionStamp(observer).sequence, sequence + 1);
    assert.notEqual(observer.prepare("PRAGMA data_version").get().data_version, version);
    assert.equal(await f.client.validateAcquisition(fingerprint), true);
  } finally {
    observer.close();
  }
  const external = new DatabaseSync(f.options.databaseFile);
  try {
    external.prepare("UPDATE usage_history_projection_inputs SET token=? WHERE singleton=1").run("external-write");
  } finally {
    external.close();
  }
  assert.equal(await f.client.validateAcquisition(fingerprint), false);
});

test("IPC cold acquisition rejects changed evidence even with unchanged database inputs", async (t) => {
  const f = await fixture(t, { direct: true, probe: "evidence" });
  const fingerprint = f.client.status.fingerprint;
  assert.equal(await f.client.validateAcquisition(fingerprint), true);
  await f.client.publishedUsageEvents();
  assert.equal(await f.client.validateAcquisition(fingerprint), false);
});

test("cold server query after idle exit does not synchronize unchanged sources again", async (t) => {
  const f = await fixture(t, { server: true, idleTimeoutMs: 61_347 });
  const first = await f.get();
  assert.ok(first.summary.eventCount > 0);
  assert.ok(f.validations.includes(true), "the live worker must acknowledge its derived baseline commit");
  const synchronizations = f.sent.filter((message) => message.type === "sync").length;
  assert.equal(f.children.length, 1);
  assert.ok(f.idleTimers.length);
  const exited = once(f.children[0], "exit");
  f.idleTimers.at(-1)();
  const [code, signal] = await exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
  const after = await f.get();
  assert.deepEqual(after.summary.totals, first.summary.totals);
  assert.equal(after.summary.eventCount, first.summary.eventCount);
  assert.equal(f.children.length, 2, "the uncached query must reach the replacement executor");
  assert.equal(f.sent.filter((message) => message.type === "sync").length, synchronizations);
});
