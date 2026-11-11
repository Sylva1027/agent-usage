import assert from "node:assert/strict";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import childProcess from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { automaticPricingFile } from "../src/pricing-store.js";
import { createUsageServer } from "../src/server.js";
import { createUsageExecutor } from "../src/usage-executor.js";
import { UsageSummaryCache } from "../src/usage-summary-cache.js";
import { createCodexIntegrationFixture } from "../test-support/usage-fixture.mjs";

const query = "/api/usage?preset=all&view=dashboard&bucket=day&calendarZone=utc";
const filters = { preset: "all", bucket: "day", calendarZone: "utc" };
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

// Match Q8: force SHA acquisition while keeping the real executor process.
const loader = `import { registerHooks } from 'node:module'; registerHooks({load(url,ctx,next){
 const value=next(url,ctx); return url.endsWith('/src/usage-source-proof.js')
 ? {...value,source:value.source+'\\nUsageSourceProof.prototype.provider=async()=>null;'} : value; }});`;

async function fixture(t, { direct = false, idleTimeoutMs = 60_000 } = {}) {
  const input = createCodexIntegrationFixture();
  const argv = [...process.execArgv],
    pricing = getPricingCatalog();
  const sent = [],
    children = [],
    validations = [];
  let server, client;
  t.after(async () => {
    await server?.close();
    await client?.close();
    process.execArgv.splice(0, process.execArgv.length, ...argv);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    setPricingCatalog(pricing);
    input.close();
  });
  process.execArgv.push("--import", `data:text/javascript,${encodeURIComponent(loader)}`);
  const fork = childProcess.fork;
  t.mock.method(childProcess, "fork", (...args) => {
    const child = fork(...args),
      requests = new Map();
    children.push(child);
    const send = child.send;
    t.mock.method(child, "send", function (message, ...rest) {
      requests.set(message.id, message.type);
      if (message.type === "sync" && !message.certifiedOnly) sent.push(message);
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
  t.mock.method(UsageSummaryCache.prototype, "publish", async () => {});
  const append = (total) => appendFile(input.rolloutFiles[0], line(total));
  const priceStatus = async (value) => {
    const file = automaticPricingFile(input.serverOptions);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ priceAttemptedAt: value, issues: [] }));
  };
  await append(100);
  let base;
  const request = async (url, options) => {
    const response = await fetch(base + url, options);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  if (direct) {
    client = createUsageExecutor(input.serverOptions, { idleTimeoutMs });
    await client.sync({ options: input.serverOptions });
    // The first acquisition creates facts; the next starts with a tracked connection.
    await client.sync({ options: input.serverOptions });
  } else {
    server = createUsageServer(input.serverOptions);
    await listenOnFetchPort(server);
    base = `http://127.0.0.1:${server.address().port}`;
    await request(query);
  }
  sent.length = 0;
  validations.length = 0;
  return {
    input,
    client,
    sent,
    children,
    validations,
    append,
    priceStatus,
    request,
    get: (url = query) => request(url),
  };
}

function holdNextQuery(t) {
  const entered = Promise.withResolvers(),
    released = Promise.withResolvers();
  const original = UsageSummaryCache.prototype.get;
  let held = false;
  t.mock.method(UsageSummaryCache.prototype, "get", async function (...args) {
    if (!held) {
      held = true;
      entered.resolve();
      await released.promise;
    }
    return original.apply(this, args);
  });
  return { entered: entered.promise, release: () => released.resolve() };
}

test("price-status creation during the post-sync check does not reacquire facts", async (t) => {
  const f = await fixture(t);
  const version = getPricingCatalog().version;
  const read = UsageSummaryCache.prototype.readSourceState;
  let injected = false;
  t.mock.method(UsageSummaryCache.prototype, "readSourceState", async function (...args) {
    if (!injected && f.sent.length === 1) {
      injected = true;
      await f.priceStatus("2026-11-06T01:00:00Z");
    }
    return read.apply(this, args);
  });
  await f.append(200);
  assert.equal((await f.get()).summary.totals.total, 300);
  assert.equal((await f.get()).summary.totals.total, 300);
  assert.equal(injected, true);
  assert.equal(getPricingCatalog().version, version);
  assert.equal(f.sent.length, 1);
});

test("price-status update during a paused query does not reacquire facts", async (t) => {
  const f = await fixture(t);
  await f.priceStatus("2026-11-06T01:00:00Z");
  await f.get();
  f.sent.length = 0;
  const gate = holdNextQuery(t);
  await f.append(200);
  const first = f.get();
  try {
    await gate.entered;
    await f.priceStatus("2026-11-06T02:00:00Z");
    assert.equal((await f.get()).summary.totals.total, 300);
    assert.equal(f.sent.length, 1);
  } finally {
    gate.release();
    await first;
  }
});

test("real manual prices and FX change the quote without reacquiring unchanged facts", async (t) => {
  const f = await fixture(t);
  const save = async (inputRate, fx) => {
    const catalog = await f.get("/api/pricing");
    catalog.usdToCnyRate = fx;
    catalog.models["codex-fixture-model"] = {
      currency: "USD",
      short: { input: inputRate, cachedInput: inputRate, cacheWrite: inputRate, output: inputRate },
    };
    await f.request("/api/pricing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(catalog),
    });
    return f.get();
  };
  assert.equal((await save(2, 7)).summary.costEstimate.totalUsd, 0.0002);
  f.sent.length = 0;
  const priced = await save(5, 7);
  assert.equal(priced.summary.costEstimate.totalUsd, 0.0005);
  const exchanged = await save(5, 8);
  assert.equal(exchanged.summary.costEstimate.totalUsd, 0.0005);
  assert.equal(exchanged.summary.costEstimate.usdToCnyRate, 8);
  assert.notEqual(exchanged.pricingCatalog.version, priced.pricingCatalog.version);
  assert.equal(exchanged.summary.totals.total, 100);
  assert.equal(f.sent.length, 0);
});

test("a live executor acknowledges its own derived commits without another sync", async (t) => {
  const f = await fixture(t, { direct: true });
  const fingerprint = f.client.status.fingerprint,
    pid = f.client.pid;
  assert.equal(await f.client.validateAcquisition(fingerprint), true);
  assert.equal(await f.client.validateAcquisition(`${fingerprint}-different`), false);
  const observer = new DatabaseSync(f.input.serverOptions.databaseFile, { readOnly: true });
  try {
    const before = observer.prepare("PRAGMA data_version").get().data_version;
    assert.equal((await f.client.dashboard(filters, { includeDetails: false })).summary.totals.total, 100);
    assert.notEqual(observer.prepare("PRAGMA data_version").get().data_version, before);
    assert.equal(await f.client.validateAcquisition(fingerprint), true);
  } finally {
    observer.close();
  }
  assert.equal(f.client.pid, pid);
  assert.equal(f.sent.length, 0);
});

test("external source metadata and unrelated-table commits reject reuse and synchronize", async (t) => {
  const f = await fixture(t);
  const mutate = (sql) => {
    const db = new DatabaseSync(f.input.serverOptions.databaseFile);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  mutate("CREATE TABLE acquisition_external(value INTEGER)");
  await f.get();
  f.sent.length = 0;
  for (const sql of [
    "UPDATE source_files SET indexed_at='external-acquisition-test'",
    "INSERT INTO acquisition_external VALUES(1)",
  ]) {
    f.validations.length = 0;
    const before = f.sent.length;
    mutate(sql);
    assert.equal((await f.get()).summary.totals.total, 100);
    assert.equal(f.validations[0], false, "external commits cannot be acknowledged as owned projections");
    assert.equal(f.sent.length, before + 1);
  }
});

test("a second source write stays pending even when price status changes in the post-sync check", async (t) => {
  const f = await fixture(t);
  const read = UsageSummaryCache.prototype.readSourceState;
  let injected = false;
  t.mock.method(UsageSummaryCache.prototype, "readSourceState", async function (...args) {
    if (!injected && f.sent.length === 1) {
      injected = true;
      await f.priceStatus("2026-11-06T03:00:00Z");
      await f.append(400);
    }
    return read.apply(this, args);
  });
  await f.append(200);
  assert.equal((await f.get()).summary.totals.total, 300);
  assert.equal(injected, true);
  assert.equal(f.sent.length, 1);
  assert.equal((await f.get()).summary.totals.total, 700);
  assert.equal(f.sent.length, 2);
});

test("a crashed executor loses its receipt and validation never spawns a replacement", async (t) => {
  const f = await fixture(t, { direct: true });
  const fingerprint = f.client.status.fingerprint;
  assert.equal(await f.client.validateAcquisition(fingerprint), true);
  await f.client.crashWorkerForTest();
  assert.equal(await f.client.validateAcquisition(fingerprint), false);
  assert.equal(f.children.length, 1);
  await f.client.sync({ options: f.input.serverOptions });
  assert.equal((await f.client.dashboard(filters, { includeDetails: false })).summary.totals.total, 100);
  assert.equal(f.sent.length, 1);
  assert.equal(f.children.length, 2);
});

test("idle retirement preserves display state but loses the receipt without spawning", async (t) => {
  const idleTimeoutMs = 61_337,
    timers = [];
  const timeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
    if (ms !== idleTimeoutMs) return timeout(callback, ms, ...args);
    timers.push(callback);
    return { unref() {} };
  });
  const f = await fixture(t, { direct: true, idleTimeoutMs });
  const fingerprint = f.client.status.fingerprint;
  assert.equal(await f.client.validateAcquisition(fingerprint), true);
  const exited = once(f.children[0], "exit");
  timers.at(-1)();
  await exited;
  assert.equal(f.client.status.fingerprint, fingerprint);
  assert.equal(await f.client.validateAcquisition(fingerprint), false);
  assert.equal(f.children.length, 1);
  await f.client.sync({ options: f.input.serverOptions });
  assert.equal((await f.client.dashboard(filters, { includeDetails: false })).summary.totals.total, 100);
  assert.equal(f.sent.length, 1);
  assert.equal(f.children.length, 2);
});

test("worker leases nest, release once, never spawn, and cannot block explicit close", async (t) => {
  const idleTimeoutMs = 61_339,
    timers = [];
  const timeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
    if (ms !== idleTimeoutMs) return timeout(callback, ms, ...args);
    timers.push(callback);
    return { unref() {} };
  });
  const f = await fixture(t, { direct: true, idleTimeoutMs });
  const fingerprint = f.client.status.fingerprint,
    pid = f.client.pid;
  const idle = timers.at(-1),
    scheduled = timers.length;
  const outer = f.client.retainWorker(),
    inner = f.client.retainWorker();
  idle();
  assert.equal(await f.client.validateAcquisition(fingerprint), true);
  assert.equal(f.client.pid, pid);
  outer();
  outer();
  assert.equal(timers.length, scheduled, "the inner lease still prevents idle retirement");
  inner();
  assert.equal(timers.length, scheduled + 1);
  inner();
  assert.equal(timers.length, scheduled + 1, "releasing twice must not rearm the timer");
  const exited = once(f.children[0], "exit");
  timers.at(-1)();
  await exited;
  const held = f.client.retainWorker();
  assert.equal(f.client.pid, null);
  assert.equal(await f.client.validateAcquisition(fingerprint), false);
  assert.equal(f.children.length, 1, "retaining an absent worker must not start one");
  await f.client.sync({ options: f.input.serverOptions });
  assert.equal(f.children.length, 2);
  const beforeClose = timers.length;
  await f.client.close();
  assert.equal(f.client.pid, null, "explicit close must finish despite the held lease");
  held();
  held();
  assert.equal(timers.length, beforeClose);
  assert.equal(f.children.length, 2);
});
