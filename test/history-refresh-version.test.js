import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createUsageServer } from "../src/server.js";
import { getPricingCatalog, runWithPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { buildUsageFingerprint } from "../src/usage-core.js";
import { UsageSummaryCache } from "../src/usage-summary-cache.js";
import { UsageStore } from "../src/usage-store.js";
import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { createCodexIntegrationFixture, createUsageIntegrationFixture } from "../test-support/usage-fixture.mjs";

process.env.U4_HARNESS_ONLY = "1";
const app = await import("./app-autorefresh.test.js");
delete process.env.U4_HARNESS_ONLY;

class EventSource {
  listeners = new Map();
  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }
  emit(usageVersion) {
    this.listeners.get("usage-synced")?.({ data: JSON.stringify({ usageVersion }) });
  }
  close() {}
}

async function browser(t, response = () => undefined, preset = "today") {
  const payloads = await app.loadRecordedPayloads();
  const payload = { ...payloads[preset], snapshotId: null, usageVersion: "F0" };
  const harness = await app.createCycleHarness({
    response: (request) => response(request, payload) ?? { payload },
    initial: { preset, usageEventsSource: null },
    storage: { codexUsageAutoRefresh: "on" },
  });
  t.after(() => harness.dispose());
  await harness.settle();
  harness.context.window.EventSource = EventSource;
  harness.api.startAutoRefresh();
  harness.resetCounts();
  return harness;
}

for (const { name, notices, returned, expected } of [
  { name: "F1 already returned", notices: ["F1"], returned: "F1", expected: 1 },
  { name: "F1 still pending", notices: ["F1"], returned: "F0", expected: 2 },
  { name: "newer F2 pending", notices: ["F1", "F2"], returned: "F1", expected: 2 },
  { name: "latest F2 already returned", notices: ["F1", "F2"], returned: "F2", expected: 1 },
  { name: "unknown dominates a later known version", notices: [null, "F1"], returned: "F1", expected: 2 },
  { name: "missing notification version", notices: [undefined], returned: "F1", expected: 2 },
  { name: "missing response version", notices: ["F1"], returned: undefined, expected: 2 },
]) {
  test(`history refresh coalesces ${name}`, async (t) => {
    const gate = Promise.withResolvers();
    let held = false;
    let payload;
    const harness = await browser(t, (request, value) => {
      payload = value;
      if (held && request.path === "/api/usage") return gate.promise;
    });
    try {
      held = true;
      const loading = harness.api.loadUsage();
      await harness.flush();
      for (const version of notices) harness.state.usageEventsSource.emit(version);
      await harness.flush();
      assert.equal(harness.counts.usageSyncs, 1, "notifications must not supersede the active request");
      held = false;
      gate.resolve({ payload: { ...payload, usageVersion: returned } });
      await loading;
      await harness.settle();
      assert.equal(harness.counts.usageSyncs, expected);
      if (expected === 2) assert.equal(harness.fetchLog.at(-1).params.skipCheck, "1");
    } finally {
      held = false;
      gate.resolve({ payload });
      await harness.settle();
    }
  });
}

test("status polling joins an active same-scope load and awaits its render", async (t) => {
  const gate = Promise.withResolvers();
  let held = false;
  let payload;
  const harness = await browser(t, (request, value) => {
    payload = value;
    if (request.path === "/api/status") return { payload: { changed: true, usageVersion: "F1" } };
    if (held && request.path === "/api/usage") return gate.promise;
  });
  try {
    held = true;
    const loading = harness.api.loadUsage();
    await harness.flush();
    const loadId = harness.state.usageLoadId;
    let checked = false;
    const checking = harness.api.checkForUpdates().then(() => {
      checked = true;
    });
    await harness.flush();
    assert.equal(harness.state.usageLoadId, loadId);
    assert.equal(harness.counts.usageSyncs, 1);
    assert.equal(checked, false);
    held = false;
    gate.resolve({ payload: { ...payload, usageVersion: "F1" } });
    await Promise.all([loading, checking]);
    await harness.settle();
    assert.equal(harness.counts.usageSyncs, 1);
    assert.equal(harness.counts.renders, 1);
  } finally {
    held = false;
    gate.resolve({ payload });
    await harness.settle();
  }
});

test("an uncertain status version forces the legacy unchanged-fingerprint fallback", async (t) => {
  const harness = await browser(t, (request) =>
    request.path === "/api/status" ? { payload: { changed: false, usageVersion: null } } : undefined,
  );
  await harness.api.checkForUpdates();
  assert.equal(harness.counts.usageSyncs, 1);
  assert.equal(harness.fetchLog.at(-1).params.skipCheck, undefined);
});

for (const dependency of ["price", "evidence", "external correction"]) {
  test(`status refreshes ${dependency} even when the legacy fingerprint is unchanged`, async (t) => {
    let version = "F0";
    const harness = await browser(t, (request, payload) =>
      request.path === "/api/status"
        ? { payload: { changed: false, fingerprint: payload.fingerprint, usageVersion: version } }
        : { payload: { ...payload, usageVersion: version } },
    );
    version = dependency;
    await harness.api.checkForUpdates();
    assert.equal(harness.counts.usageSyncs, 1);
    await harness.api.checkForUpdates();
    assert.equal(harness.counts.usageSyncs, 1, "the applied version satisfies another observation");
    await harness.api.loadUsage();
    assert.equal(harness.counts.usageSyncs, 2, "manual refresh must remain explicit");
  });
}

for (const inFlight of [false, true]) {
  test(`quota clock refresh forces an equal version: inFlight=${inFlight}`, async (t) => {
    const gate = Promise.withResolvers();
    let held = false;
    let payload;
    const harness = await browser(
      t,
      (request, value) => {
        payload = value;
        if (request.path === "/api/status") return { payload: { changed: false, usageVersion: "F0" } };
        if (held && request.path === "/api/usage") return gate.promise;
      },
      "quota_5h",
    );
    try {
      held = inFlight;
      const loading = inFlight ? harness.api.loadUsage() : null;
      await harness.flush();
      const checking = harness.api.checkForUpdates();
      await harness.flush();
      assert.equal(harness.counts.usageSyncs, 1);
      held = false;
      gate.resolve({ payload });
      await Promise.all([loading, checking]);
      await harness.settle();
      assert.equal(harness.counts.usageSyncs, inFlight ? 2 : 1);
      assert.equal(harness.fetchLog.at(-1).params.skipCheck, undefined);
    } finally {
      held = false;
      gate.resolve({ payload });
      await harness.settle();
    }
  });
}

test("failed loads retry equal versions and callbacks from old streams stay ignored", async (t) => {
  let fail = false;
  const harness = await browser(t, (request, payload) => {
    if (request.path === "/api/status") return { payload: { changed: true, usageVersion: "F0" } };
    if (fail && request.path === "/api/usage") return { status: 500, payload: { error: "retry me" } };
    return { payload };
  });
  fail = true;
  await harness.api.loadUsage();
  fail = false;
  await harness.api.checkForUpdates();
  assert.equal(harness.counts.usageSyncs, 2);
  const old = harness.state.usageEventsSource;
  harness.api.setAutoRefreshEnabled(false);
  await harness.settle();
  harness.api.setAutoRefreshEnabled(true);
  await harness.settle();
  harness.resetCounts();
  old.emit("new-version");
  old.onopen();
  await harness.settle();
  assert.equal(harness.counts.usageSyncs, 0);
  assert.equal(harness.counts.statusChecks, 0);
});

const query = "/api/usage?preset=all&view=dashboard&bucket=hour&calendarZone=local";
const line = (total) =>
  `${JSON.stringify({
    type: "event_msg",
    timestamp: "2026-10-04T13:00:00Z",
    payload: { type: "token_count", info: { last_token_usage: { total_tokens: total, input_tokens: total } } },
  })}\n`;

async function serverFixture(t) {
  const input = createCodexIntegrationFixture();
  const catalog = getPricingCatalog();
  const server = createUsageServer(input.serverOptions);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await server.close();
    setPricingCatalog(catalog);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    input.close();
  });
  const get = async (url = query) => {
    const response = await fetch(base + url);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  await appendFile(input.rolloutFiles[0], line(100));
  await get();
  await get();
  const initial = await get();
  assert.equal(typeof initial.usageVersion, "string");
  return { input, base, get, initial };
}

test("API and status versions cover prices, evidence and same-source external corrections", async (t) => {
  const { input, get, initial } = await serverFixture(t);
  assert.equal((await get("/api/status")).usageVersion, initial.usageVersion);
  const db = new DatabaseSync(input.serverOptions.databaseFile);
  try {
    db.exec("UPDATE events SET total=total+50,input=input+50");
  } finally {
    db.close();
  }
  const external = await get("/api/status");
  assert.equal(external.fingerprint, initial.fingerprint, "raw sources and legacy version are unchanged");
  assert.notEqual(external.usageVersion, initial.usageVersion);
  await get();
  const corrected = await get();
  assert.equal(corrected.summary.totals.total, 150);
  assert.equal(corrected.usageVersion, (await get("/api/status")).usageVersion);
  setPricingCatalog({ ...getPricingCatalog(), usdToCnyRate: 7.123456 });
  const priced = await get("/api/status");
  assert.notEqual(priced.usageVersion, corrected.usageVersion);
  assert.equal((await get()).usageVersion, priced.usageVersion);
  await writeFile(path.join(input.codexHome, "config.toml"), 'model_provider = "api"\n');
  const evidence = await get("/api/status");
  assert.notEqual(evidence.usageVersion, priced.usageVersion);
  await get();
  assert.equal((await get()).usageVersion, (await get("/api/status")).usageVersion);
});

for (const change of ["append", "pricing"]) {
  test(`a captured old cache hit keeps its own version during ${change}`, async (t) => {
    const { input, get, initial } = await serverFixture(t);
    const original = UsageSummaryCache.prototype.get;
    let held = false;
    let latest;
    t.mock.method(UsageSummaryCache.prototype, "get", async function (...args) {
      const result = await original.apply(this, args);
      if (!held) {
        held = true;
        assert.ok(result);
        if (change === "append") await appendFile(input.rolloutFiles[0], line(200));
        else setPricingCatalog({ ...getPricingCatalog(), usdToCnyRate: 7.654321 });
        latest = await get();
      }
      return result;
    });
    const old = await get(`${query}&skipCheck=1`);
    assert.equal(old.summary.totals.total, initial.summary.totals.total);
    assert.equal(old.usageVersion, initial.usageVersion);
    assert.notEqual(old.usageVersion, latest.usageVersion);
    assert.equal((await get("/api/status")).usageVersion, latest.usageVersion);
  });
}

test("same-version model repricing changes status identity while an old cache hit keeps its captured prices", async (t) => {
  const catalog = getPricingCatalog();
  catalog.models["codex-fixture-model"] = {
    currency: "USD",
    short: { input: 1, cachedInput: 0, cacheWrite: 0, output: 2 },
  };
  await runWithPricingCatalog(catalog, async () => {
    const { get, initial } = await serverFixture(t);
    const original = UsageSummaryCache.prototype.get;
    let held = false;
    let latest;
    t.mock.method(UsageSummaryCache.prototype, "get", async function (...args) {
      const result = await original.apply(this, args);
      if (!held) {
        held = true;
        assert.ok(result);
        catalog.models["codex-fixture-model"].short.input = 3;
        latest = await get();
      }
      return result;
    });
    const old = await get(`${query}&skipCheck=1`);
    assert.equal(old.pricingCatalog.version, latest.pricingCatalog.version);
    assert.equal(old.fingerprint, latest.fingerprint);
    assert.equal(old.pricingCatalog.models["codex-fixture-model"].short.input, 1);
    assert.equal(latest.pricingCatalog.models["codex-fixture-model"].short.input, 3);
    assert.equal(old.usageVersion, initial.usageVersion);
    assert.notEqual(latest.usageVersion, old.usageVersion);
    assert.equal((await get("/api/status")).usageVersion, latest.usageVersion);
  });
});

test("a raced cache miss binds its actual result and uncertain publications return null", async (t) => {
  const { input, get, initial } = await serverFixture(t);
  const original = UsageSummaryCache.prototype.get;
  let held = false;
  let latest;
  t.mock.method(UsageSummaryCache.prototype, "get", async function (...args) {
    if (!held) {
      held = true;
      await appendFile(input.rolloutFiles[0], line(200));
      latest = await get();
      return null;
    }
    return original.apply(this, args);
  });
  const raced = await get(`${query}&skipCheck=1`);
  assert.equal(raced.summary.totals.total, 300);
  assert.notEqual(raced.usageVersion, initial.usageVersion);
  assert.equal(raced.usageVersion, latest.usageVersion);
  t.mock.method(UsageSummaryCache.prototype, "readPublication", async () => null);
  assert.equal((await get("/api/status")).usageVersion, null);
  assert.equal((await get()).usageVersion, null);
});

test("SSE, API and status name the same completed publication", async (t) => {
  const callbacks = [];
  t.mock.method(fs, "watch", (_root, _options, callback) => {
    callbacks.push(callback);
    return { on() {}, unref() {}, close() {} };
  });
  syncBuiltinESMExports();
  const { input, base, get } = await serverFixture(t);
  const reader = (await fetch(`${base}/api/usage-events`)).body.getReader();
  let buffer = "";
  const next = async (name) => {
    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        buffer += new TextDecoder().decode(chunk.value);
        continue;
      }
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (block.startsWith(`event: ${name}\n`)) return JSON.parse(block.split("\ndata: ")[1]);
    }
  };
  try {
    await next("ready");
    await appendFile(input.rolloutFiles[0], line(200));
    callbacks[0]("change", "rollout.jsonl");
    const notification = await next("usage-synced");
    const status = await get("/api/status");
    const result = await get();
    assert.equal(typeof notification.usageVersion, "string");
    assert.equal(notification.usageVersion, status.usageVersion);
    assert.equal(result.usageVersion, notification.usageVersion);
    const rawBeforeCorrection = await buildUsageFingerprint(input.serverOptions);
    const db = new DatabaseSync(input.serverOptions.databaseFile);
    try {
      db.exec("UPDATE events SET total=total+50,input=input+50");
    } finally {
      db.close();
    }
    callbacks[0]("change", "rollout.jsonl");
    const correction = await next("usage-synced");
    // A certified journal identity can switch to a full-scan identity after an external commit.
    assert.equal((await buildUsageFingerprint(input.serverOptions)).fingerprint, rawBeforeCorrection.fingerprint,
      "external corrections keep the raw sources unchanged");
    assert.notEqual(
      correction.usageVersion,
      notification.usageVersion,
      "SSE deduplication includes publication identity",
    );
    assert.equal((await get("/api/status")).usageVersion, correction.usageVersion);
    const corrected = await get();
    assert.equal(corrected.summary.totals.total, 400);
    assert.equal(corrected.usageVersion, correction.usageVersion);
  } finally {
    await reader.cancel();
  }
});

for (const change of [
  "none",
  "price status",
  "price status plus state publication",
  "price status plus status refresh",
  "price status plus repricing",
  "price status plus external commit",
]) {
  test(`fresh multi-archive today after idle exit: ${change}`, async (t) => {
    const input = createUsageIntegrationFixture();
    const options = {
      ...input.serverOptions,
      executorIdleTimeoutMs: 61_347,
      pricingFetcher: async () => {
        throw new Error("controlled offline price check");
      },
    };
    const store = new UsageStore(options);
    const argv = [...process.execArgv];
    const children = [],
      replies = [],
      sources = [],
      idleTimers = [];
    const catalog = getPricingCatalog();
    let observing = false,
      captured,
      publications = 0,
      refreshed = false;
    let server;
    t.after(async () => {
      await server?.close();
      store.close();
      process.execArgv.splice(0, process.execArgv.length, ...argv);
      setPricingCatalog(catalog);
      t.mock.restoreAll();
      syncBuiltinESMExports();
      input.close();
    });
    await store.sync();
    const archives = [];
    for (const day of ["2026-10-03", "2026-10-04"]) {
      const archive = path.join(path.dirname(options.databaseFile), `${day}.sqlite`);
      const startMs = Date.parse(`${day}T00:00:00Z`);
      await createHistoryArchiveCandidate(store.database, archive, { startMs, endMs: startMs + 86_400_000 });
      archives.push(archive);
    }
    for (const archive of archives)
      await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, archive));
    await store.ensureHistoryProjectionTracking();
    store.close();
    const loader = `import {registerHooks} from 'node:module';registerHooks({load(url,ctx,next){
    const value=next(url,ctx);return url.endsWith('/src/usage-source-proof.js')
    ? {...value,source:value.source+'\\nUsageSourceProof.prototype.provider=async()=>null;'}:value;}});`;
    process.execArgv.push("--import", `data:text/javascript,${encodeURIComponent(loader)}`);
    const fork = childProcess.fork;
    t.mock.method(childProcess, "fork", (...args) => {
      const child = fork(...args);
      children.push(child);
      const send = child.send;
      const pending = new Map();
      t.mock.method(child, "send", function (message, ...rest) {
        pending.set(message.id, message.type);
        return send.call(this, message, ...rest);
      });
      child.on("message", (message) => {
        if (message.type === "response") {
          replies.push({ type: pending.get(message.id), result: message.result });
          if (
            observing &&
            change === "price status plus state publication" &&
            pending.get(message.id) === "dashboard"
          ) {
            child.emit("message", { type: "state", state: { status: structuredClone(message.result.status) } });
          }
        }
      });
      return child;
    });
    syncBuiltinESMExports();
    const timeout = globalThis.setTimeout;
    t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
      if (ms !== options.executorIdleTimeoutMs) return timeout(callback, ms, ...args);
      idleTimers.push(callback);
      return { unref() {} };
    });
    const readSource = UsageSummaryCache.prototype.readSourceState;
    t.mock.method(UsageSummaryCache.prototype, "readSourceState", async function (...args) {
      const source = await readSource.apply(this, args);
      sources.push({
        inputs: source.inputs,
        fingerprint: source.fingerprint,
        routingFingerprint: source.routingFingerprint,
        publication: source.publication,
      });
      if (
        change === "price status plus status refresh" &&
        observing &&
        !refreshed &&
        replies.some((reply) => reply.type === "dashboard")
      ) {
        refreshed = true;
        const checked = await fetch(`${base}/api/status`);
        assert.equal(checked.status, 200);
        await checked.json();
      }
      return source;
    });
    const readCache = UsageSummaryCache.prototype.get;
    t.mock.method(UsageSummaryCache.prototype, "get", async function (...args) {
      if (observing && !captured) {
        captured = args[1];
        if (change !== "none") {
          const beforePrice = getPricingCatalog().version;
          const response = await fetch(`${base}/api/pricing/refresh`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ force: true }),
          });
          const result = await response.json();
          assert.equal(response.status, 200, JSON.stringify(result));
          assert.equal(result.changed, false);
          assert.equal(getPricingCatalog().version, beforePrice);
        }
        if (change === "price status plus repricing") {
          setPricingCatalog({ ...getPricingCatalog(), usdToCnyRate: getPricingCatalog().usdToCnyRate + 0.1 });
        }
        if (change === "price status plus external commit") {
          const external = new DatabaseSync(options.databaseFile);
          try {
            external.exec("INSERT OR REPLACE INTO store_meta VALUES('unknown-version-input','external')");
          } finally {
            external.close();
          }
        }
      }
      return readCache.apply(this, args);
    });
    const publish = UsageSummaryCache.prototype.publish;
    t.mock.method(UsageSummaryCache.prototype, "publish", async function (...args) {
      if (observing) publications++;
      return publish.apply(this, args);
    });
    server = createUsageServer(options);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (url) => {
      const response = await fetch(base + url);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      if (url.startsWith("/api/usage?")) assert.equal(response.headers.get("x-summary-cache"), "miss");
      return body;
    };
    await get("/api/usage?preset=today&view=dashboard&calendarZone=utc");
    await get("/api/usage?preset=all&view=dashboard&calendarZone=utc&skipCheck=1");
    const before = await get("/api/status");
    const responsePrices = getPricingCatalog();
    const exited = once(children.at(-1), "exit");
    idleTimers.at(-1)();
    await exited;
    sources.length = 0;
    replies.length = 0;
    observing = true;
    const fresh = await get("/api/usage?preset=today&view=dashboard&calendarZone=utc&skipCheck=1");
    if (change === "price status plus status refresh")
      assert.equal(replies.filter((reply) => reply.type === "dashboard").length, 1);
    assert.equal(children.length, 2, "the fresh query must reopen the actual idle executor");
    assert.equal(sources[0].routingFingerprint, captured.routingFingerprint);
    assert.equal(replies.find((r) => r.type === "dashboard").result.status.fingerprint, captured.fingerprint);
    if (change === "none") assert.equal(sources[0].inputs, captured.inputs);
    else {
      assert.notEqual(sources[0].inputs, captured.inputs, "the failed price check changes cache inputs");
      assert.equal(publications, 0, "changed cache inputs must still prevent HTTP cache publication");
    }
    if (change === "price status plus external commit") {
      assert.notEqual(sources[0].publication.signature, captured.publication.signature);
      assert.equal(fresh.usageVersion, null, "an unknown outside commit must not receive a new version label");
      return;
    }
    assert.equal(sources[0].publication.signature, captured.publication.signature);
    assert.equal(typeof fresh.usageVersion, "string");
    const status = await get("/api/status");
    if (change === "price status plus repricing") {
      assert.equal(fresh.pricingCatalog.version, responsePrices.version);
      assert.equal(fresh.pricingCatalog.usdToCnyRate, responsePrices.usdToCnyRate);
      assert.equal(fresh.usageVersion, before.usageVersion, "a coherent old-price query retains its own version");
      assert.notEqual(fresh.usageVersion, status.usageVersion, "new prices must still require another read");
      return;
    }
    assert.equal(fresh.usageVersion, status.usageVersion);
    if (change !== "price status") return;
    const gate = Promise.withResolvers();
    let loading = false;
    const harness = await browser(t, (request) => {
      if (request.path === "/api/status") return { payload: status };
      if (request.path === "/api/usage") return loading ? gate.promise : { payload: { ...fresh, usageVersion: null } };
    });
    try {
      loading = true;
      const reading = harness.api.loadUsage({ skipCheck: true });
      await harness.flush();
      const checking = harness.api.checkForUpdates();
      await harness.flush();
      assert.equal(harness.counts.usageSyncs, 1);
      gate.resolve({ payload: fresh });
      await Promise.all([reading, checking]);
      await harness.settle();
      assert.equal(harness.counts.usageSyncs, 1, "the completed fresh version must absorb the queued status check");
    } finally {
      gate.resolve({ payload: fresh });
      await harness.settle();
    }
  });
}
