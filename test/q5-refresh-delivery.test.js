import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { ServerResponse } from "node:http";
import path from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

import { createUsageServer } from "../src/server.js";
import { UsageSummaryCache } from "../src/usage-summary-cache.js";
import { createUsageSourceWatcher } from "../src/usage-source-watch.js";
import { createCodexIntegrationFixture } from "../test-support/usage-fixture.mjs";

process.env.U4_HARNESS_ONLY = "1";
const app = await import("./app-autorefresh.test.js");
delete process.env.U4_HARNESS_ONLY;

const QUERY = "preset=all&view=dashboard&bucket=hour&calendarZone=local";
const deferred = () => Promise.withResolvers();

function usageLine(total) {
  return `${JSON.stringify({
    type: "event_msg",
    timestamp: "2026-10-04T13:00:00.000Z",
    payload: { type: "token_count", info: { last_token_usage: { total_tokens: total, input_tokens: total } } },
  })}\n`;
}

async function json(base, query) {
  const response = await fetch(`${base}${query}`);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

test("Q5 cache miss cannot label a newer dashboard with the previous source fingerprint", async () => {
  const fixture = createCodexIntegrationFixture();
  const server = createUsageServer({ ...fixture.serverOptions, pricingRefreshSchedulerEnabled: false });
  const original = UsageSummaryCache.prototype.get;
  const entered = deferred();
  const release = deferred();
  let held = false;
  let reading;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const before = await json(base, `/api/usage?${QUERY}`);
    UsageSummaryCache.prototype.get = async function (...args) {
      if (!held) {
        held = true;
        entered.resolve();
        await release.promise;
        return null;
      }
      return original.apply(this, args);
    };
    reading = json(base, `/api/usage?${QUERY}&skipCheck=1`);
    await entered.promise;
    await appendFile(fixture.rolloutFiles[0], usageLine(100));
    const fresh = await json(base, `/api/usage?${QUERY}`);
    assert.equal(fresh.summary.totals.total, 100);
    release.resolve();
    const raced = await reading;
    assert.equal(raced.summary.totals.total, 100);
    assert.equal(raced.fingerprint, fresh.fingerprint, "dashboard and source must name the same publication");
    assert.notEqual(raced.fingerprint, before.fingerprint);
    assert.equal((await json(base, `/api/status?since=${raced.fingerprint}`)).changed, false);
  } finally {
    release.resolve();
    await reading?.catch(() => {});
    UsageSummaryCache.prototype.get = original;
    await server.close();
    fixture.close();
  }
});

for (const check of ["status", "unchanged-sync", "unchanged-sync-miss", "append"]) {
  test(`Q5 a read finishes without chasing repeated ${check} checks`, async () => {
    const fixture = createCodexIntegrationFixture();
    const server = createUsageServer(fixture.serverOptions);
    const original = UsageSummaryCache.prototype.get;
    let targetKey;
    let checking = false;
    let reads = 0;
    const signatures = new Set();
    try {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      await json(base, `/api/usage?${QUERY}`);
      await json(base, `/api/usage?${QUERY}&skipCheck=1`);
      const before = await json(base, `/api/usage?${QUERY}&skipCheck=1`);
      UsageSummaryCache.prototype.get = async function (key, source, now) {
        const result = await original.call(this, key, source, now);
        if (!checking && (!targetKey || key === targetKey)) {
          targetKey = key;
          reads++;
          signatures.add(source.signature);
          if (reads === 1) assert.ok(result, "the target read must already own a complete cached publication");
          if (reads <= 6) {
            checking = true;
            try {
              if (check === "append") await appendFile(fixture.rolloutFiles[0], usageLine(10));
              const checked = await json(
                base,
                check === "status" ? `/api/status?since=${before.fingerprint}` : "/api/usage?preset=all&bucket=day",
              );
              if (check !== "append") assert.equal(checked.fingerprint, before.fingerprint);
            } finally {
              checking = false;
            }
          }
        }
        return check === "unchanged-sync-miss" ? null : result;
      };
      const read = await json(base, `/api/usage?${QUERY}&skipCheck=1`);
      if (check !== "append") assert.equal(signatures.size, 1, "no-data checks keep the same publication");
      assert.equal(reads, 1, "an already captured coherent result must not chase the check stream");
      assert.equal(read.fingerprint, before.fingerprint);
      assert.equal(read.summary.totals.total, 0);
      if (check === "append") {
        const latest = await json(base, "/api/usage?preset=all&bucket=day&skipCheck=1");
        assert.equal(latest.summary.totals.total, 10);
        assert.notEqual(latest.fingerprint, read.fingerprint);
      }
    } finally {
      UsageSummaryCache.prototype.get = original;
      await server.close();
      fixture.close();
    }
  });
}

for (const stage of ["cache", "dashboard"]) {
  test(`Q5 a cache miss has a bounded retry while commits overlap every ${stage} await`, async (t) => {
    const fixture = createCodexIntegrationFixture();
    const dshHome = path.join(path.dirname(fixture.serverOptions.databaseFile), "dsh-continuous");
    const dshFile = path.join(dshHome, "sessions", "fixture", "continuous", "session.v4.jsonl.zstd");
    const dshFrame = (rows) => zstdCompressSync(Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`));
    await mkdir(path.dirname(dshFile), { recursive: true });
    await writeFile(
      dshFile,
      dshFrame([
        {
          type: "session",
          version: 4,
          id: "continuous",
          createdAt: Date.parse("2026-10-04T12:00:00Z"),
          cwd: "/fixture/dsh",
        },
        {
          type: "request/header",
          time: Date.parse("2026-10-04T12:00:00Z"),
          data: { header: { config: { model: "dsh-model" } } },
        },
      ]),
    );
    fixture.serverOptions.extraDshHomes = dshHome;
    const server = createUsageServer(fixture.serverOptions);
    const originalGet = UsageSummaryCache.prototype.get;
    const originalPublish = UsageSummaryCache.prototype.publish;
    let targetKey;
    let checking = false;
    let reads = 0;
    let publications = 0;
    const delayed = [];
    let deliveryError;
    try {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      await json(base, `/api/usage?${QUERY}`);
      const appendBoth = async () => {
        if (reads <= 6) {
          checking = true;
          try {
            await appendFile(fixture.rolloutFiles[0], usageLine(10));
            const time = Date.parse("2026-10-04T13:00:00Z") + reads * 1000;
            await appendFile(
              dshFile,
              dshFrame([
                { type: "step/start", time, data: { turn: reads, step: 1 } },
                {
                  type: "assistant/message",
                  time: time + 100,
                  data: {
                    turn: reads,
                    step: 1,
                    usage: { inputTokens: 3, outputTokens: 2 },
                    message: { content: "fixture" },
                  },
                },
              ]),
            );
            await json(base, "/api/usage?preset=all&bucket=day");
          } finally {
            checking = false;
          }
        }
      };
      if (stage === "dashboard") {
        const emit = ChildProcess.prototype.emit;
        t.mock.method(ChildProcess.prototype, "emit", function (event, ...args) {
          const message = args[0];
          if (event === "message" && message.type === "response" && message.result?.summary?.range?.bucket === "hour") {
            delayed.push(
              appendBoth()
                .catch((error) => {
                  deliveryError = error;
                })
                .finally(() => emit.call(this, event, ...args)),
            );
            return true;
          }
          return emit.call(this, event, ...args);
        });
      }
      UsageSummaryCache.prototype.get = async function (key, ...args) {
        if (checking || (targetKey && key !== targetKey)) return originalGet.call(this, key, ...args);
        targetKey = key;
        reads++;
        if (stage === "cache") await appendBoth();
        return null;
      };
      UsageSummaryCache.prototype.publish = async function (key, ...args) {
        if (key === targetKey) publications++;
        return originalPublish.call(this, key, ...args);
      };
      const read = await json(base, `/api/usage?${QUERY}&skipCheck=1`);
      assert.ifError(deliveryError);
      assert.equal(reads, 2, "a miss may retry once, even if every await overlaps another commit");
      assert.equal(read.summary.totals.total, stage === "cache" ? 30 : 15);
      assert.equal(publications, 0, "a raced dashboard must not be cached with an older source");
      assert.equal((await json(base, `/api/status?since=${read.fingerprint}`)).changed, true);
      UsageSummaryCache.prototype.get = originalGet;
      t.mock.restoreAll();
      const followUp = await json(base, `/api/usage?${QUERY}&skipCheck=1`);
      assert.equal(followUp.summary.totals.total, 30);
      assert.equal((await json(base, `/api/status?since=${followUp.fingerprint}`)).changed, false);
    } finally {
      UsageSummaryCache.prototype.get = originalGet;
      UsageSummaryCache.prototype.publish = originalPublish;
      await Promise.allSettled(delayed);
      t.mock.restoreAll();
      await server.close();
      fixture.close();
    }
  });
}

test("Q5 poll collision and append during sync converge before the SSE wake is delivered", async (t) => {
  const fixture = createCodexIntegrationFixture();
  const callbacks = [];
  const hints = [];
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(fs, "watch", (_root, _options, callback) => {
    callbacks.push(callback);
    return { on() {}, unref() {}, close() {} };
  });
  syncBuiltinESMExports();
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
    if (ms !== 75) return originalTimeout(callback, ms, ...args);
    hints.push(callback);
    return { unref() {} };
  });
  const server = createUsageServer({ ...fixture.serverOptions, pricingRefreshSchedulerEnabled: false });
  const originalRead = UsageSummaryCache.prototype.readSourceState;
  const entered = deferred();
  const release = deferred();
  let reads = 0;
  let reader;
  let poll;
  let skipped;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const initial = await json(base, `/api/usage?${QUERY}`);
    const stream = await fetch(`${base}/api/usage-events`);
    reader = stream.body.getReader();
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
    await next("ready");
    UsageSummaryCache.prototype.readSourceState = async function (...args) {
      const source = await originalRead.apply(this, args);
      if (++reads === 2) {
        entered.resolve();
        await release.promise;
      }
      return source;
    };
    const hint = () => {
      callbacks[0]("change", "rollout.jsonl");
      assert.equal(hints.length, 1);
      hints.shift()();
    };
    await appendFile(fixture.rolloutFiles[0], usageLine(100));
    poll = json(base, `/api/usage?${QUERY}`);
    await entered.promise;
    hint();
    await appendFile(fixture.rolloutFiles[0], usageLine(200));
    hint();
    assert.equal((await json(base, `/api/status?since=${initial.fingerprint}`)).changed, true);
    skipped = json(base, `/api/usage?${QUERY}&skipCheck=1`);
    release.resolve();
    const notification = await next("usage-synced");
    assert.ok(notification.fingerprint);
    assert.equal((await poll).summary.totals.total, 300);
    assert.equal((await skipped).summary.totals.total, 300);
    const latest = await json(base, `/api/usage?${QUERY}&skipCheck=1`);
    assert.equal(latest.summary.totals.total, 300);
    assert.equal((await json(base, `/api/status?since=${latest.fingerprint}`)).changed, false);
  } finally {
    release.resolve();
    await Promise.allSettled([poll, skipped]);
    UsageSummaryCache.prototype.readSourceState = originalRead;
    await reader?.cancel();
    await server.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fixture.close();
  }
});

test("Q5 continuous hints deliver each changed commit before a quiet round and deduplicate unchanged rounds", async (t) => {
  const fixture = createCodexIntegrationFixture();
  const callbacks = [];
  const hints = [];
  const sent = [];
  const expected = [];
  const ready = deferred();
  const entered = deferred();
  const release = deferred();
  const originalTimeout = globalThis.setTimeout;
  const write = ServerResponse.prototype.write;
  t.mock.method(fs, "watch", (_root, _options, callback) => {
    callbacks.push(callback);
    return { on() {}, unref() {}, close() {} };
  });
  syncBuiltinESMExports();
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
    if (ms !== 75) return originalTimeout(callback, ms, ...args);
    hints.push(callback);
    return { unref() {} };
  });
  t.mock.method(ServerResponse.prototype, "write", function (chunk, ...args) {
    const text = String(chunk);
    if (text.startsWith("event: ready\n")) ready.resolve();
    if (text.startsWith("event: usage-synced\n")) sent.push(JSON.parse(text.split("\ndata: ")[1]));
    return write.call(this, chunk, ...args);
  });
  const server = createUsageServer(fixture.serverOptions);
  const originalRead = UsageSummaryCache.prototype.readSourceState;
  let reads = 0;
  let completed = 0;
  let reader;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    await json(base, `/api/usage?${QUERY}`);
    reader = (await fetch(`${base}/api/usage-events`)).body.getReader();
    await ready.promise;
    const hint = () => {
      callbacks[0]("change", "rollout.jsonl");
      assert.equal(hints.length, 1);
      hints.shift()();
    };
    UsageSummaryCache.prototype.readSourceState = async function (...args) {
      const source = await originalRead.apply(this, args);
      reads++;
      if (reads === 21) {
        entered.resolve();
        await release.promise;
      } else if (reads % 2 === 0 && reads <= 20) {
        completed++;
        if (expected.at(-1) !== source.fingerprint) expected.push(source.fingerprint);
        if (completed < 8) await appendFile(fixture.rolloutFiles[0], usageLine(1));
        hint();
      }
      return source;
    };
    await appendFile(fixture.rolloutFiles[0], usageLine(1));
    hint();
    await entered.promise;
    assert.equal(completed, 10, "eight changed and two unchanged syncs completed with a pending hint every round");
    assert.equal(expected.length, 8);
    assert.deepEqual(
      sent.map((event) => event.fingerprint),
      expected,
      "no completed change may wait for quiet",
    );
    assert.ok(sent.every((event) => typeof event.checkedAt === "string"));
  } finally {
    release.resolve();
    UsageSummaryCache.prototype.readSourceState = originalRead;
    await reader?.cancel();
    await server.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fixture.close();
  }
});

class EventSource {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }
  emit(type) {
    this.listeners.get(type)?.({ type, data: "{}" });
  }
  close() {}
}

async function browser(response) {
  const payloads = await app.loadRecordedPayloads();
  payloads.today.snapshotId = null;
  const harness = await app.createCycleHarness({
    response: (request) => response(request, payloads) ?? { payload: payloads.today },
    initial: { preset: "today", usageEventsSource: null },
    storage: { codexUsageAutoRefresh: "on" },
  });
  await harness.settle();
  harness.context.window.EventSource = EventSource;
  harness.api.startAutoRefresh();
  harness.resetCounts();
  return harness;
}

test("Q5 SSE during a checked load cannot supersede its fresh response with an older skipCheck read", async () => {
  const release = deferred();
  let checking = false;
  let committed = false;
  let payload;
  const harness = await browser((request, payloads) => {
    payload = app.clone(payloads.today);
    if (request.path === "/api/status") return { payload: { changed: true } };
    if (checking && request.path === "/api/usage" && !request.params.skipCheck) return release.promise;
    if (committed) return { payload: { ...payload, fingerprint: "fresh-publication" } };
  });
  try {
    checking = true;
    const poll = harness.api.checkForUpdates();
    await harness.flush();
    harness.state.usageEventsSource.emit("usage-synced");
    await harness.flush();
    const fresh = app.clone(payload);
    fresh.fingerprint = "fresh-publication";
    committed = true;
    release.resolve({ payload: fresh });
    await poll;
    await harness.settle();
    assert.equal(harness.state.fingerprint, "fresh-publication");
  } finally {
    release.resolve({ payload });
    await harness.settle();
    harness.dispose();
  }
});

test("Q5 reconnect during an old status poll queues a new full check", async () => {
  const release = deferred();
  let hold = false;
  const harness = await browser((request) => {
    if (request.path === "/api/status") return hold ? release.promise : { payload: { changed: false } };
  });
  try {
    hold = true;
    const poll = harness.api.checkForUpdates();
    await harness.flush();
    harness.state.usageEventsSource.onopen();
    hold = false;
    release.resolve({ payload: { changed: false } });
    await poll;
    await harness.settle();
    assert.equal(harness.counts.statusChecks, 2, "reconnect must check after the pre-reconnect observation");
  } finally {
    release.resolve({ payload: { changed: false } });
    await harness.settle();
    harness.dispose();
  }
});

test("Q5 ready checks the gap between transport open and watcher installation", async () => {
  let changed = false;
  const harness = await browser((request, payloads) => {
    if (request.path === "/api/status") return { payload: { changed } };
    if (changed && request.path === "/api/usage") {
      return { payload: { ...payloads.today, fingerprint: "after-watch-installation" } };
    }
  });
  try {
    const source = harness.state.usageEventsSource;
    source.onopen();
    await harness.settle();
    changed = true;
    source.emit("ready");
    await harness.settle();
    assert.equal(harness.state.fingerprint, "after-watch-installation");
  } finally {
    harness.dispose();
  }
});

for (const overlap of [false, true]) {
  for (const changed of [false, true]) {
    test(`Q5 open plus ready settles after two checks: overlap=${overlap}, changed=${changed}`, async () => {
      const release = deferred();
      let checks = 0;
      const harness = await browser((request) => {
        if (request.path === "/api/status") {
          checks++;
          if (overlap && checks === 1) return release.promise;
          return { payload: { changed } };
        }
      });
      try {
        const source = harness.state.usageEventsSource;
        source.onopen();
        if (overlap) await harness.flush();
        else await harness.settle();
        source.emit("ready");
        release.resolve({ payload: { changed } });
        await harness.settle();
        await harness.flush(20);
        assert.equal(harness.counts.statusChecks, 2);
        assert.equal(harness.counts.usageSyncs, changed ? 2 : 0);
        assert.equal(harness.state.autoRefreshCheckInFlight, false);
        assert.equal(harness.pendingFetches, 0);
      } finally {
        release.resolve({ payload: { changed } });
        await harness.settle();
        harness.dispose();
      }
    });
  }
}

test("Q5 a burst of notifications queues one follow-up for the latest scope", async () => {
  const first = deferred();
  const second = deferred();
  let hold = false;
  let reads = 0;
  let payload;
  const harness = await browser((request, payloads) => {
    payload = app.clone(payloads.today);
    payload.summary.range.preset = request.params.preset || "today";
    if (hold && request.path === "/api/usage") return ++reads === 1 ? first.promise : second.promise;
    return { payload };
  });
  try {
    hold = true;
    const source = harness.state.usageEventsSource;
    source.emit("usage-synced");
    await harness.flush();
    const previous = app.clone(payload);
    const paints = [];
    const render = harness.context.render;
    harness.context.render = (...args) => {
      paints.push(harness.state.summary.range.preset);
      return render(...args);
    };
    harness.state.preset = "month";
    harness.api.refreshViewForFilters();
    for (let i = 0; i < 10; i++) source.emit("usage-synced");
    assert.equal(harness.counts.usageSyncs, 2, "a burst must not launch ten overlapping reads");
    hold = false;
    second.resolve({ payload });
    await harness.flush();
    first.resolve({ payload: previous });
    await harness.settle();
    assert.equal(harness.counts.usageSyncs, 3);
    assert.deepEqual(paints, ["month", "month"], "the superseded scope must never paint");
    assert.equal(harness.state.summary.range.preset, "month");
    assert.equal(harness.fetchLog.at(-1).params.skipCheck, "1");
  } finally {
    hold = false;
    first.resolve({ payload });
    second.resolve({ payload });
    await harness.settle();
    harness.dispose();
  }
});

for (const holdCurrent of [false, true]) {
  test(`Q5 an unresolved superseded scope cannot block the current SSE read: holdCurrent=${holdCurrent}`, async () => {
    const old = deferred();
    const current = deferred();
    let active = false;
    let reads = 0;
    let oldPayload;
    let currentPayload;
    const harness = await browser((request, payloads) => {
      if (request.path !== "/api/usage" || !active) return;
      const payload = app.clone(payloads.today);
      payload.summary.range.preset = request.params.preset;
      payload.fingerprint = `scope-read-${++reads}`;
      if (reads === 1) {
        oldPayload = payload;
        return old.promise;
      }
      if (reads === 3 && holdCurrent) {
        currentPayload = payload;
        return current.promise;
      }
      return { payload };
    });
    try {
      active = true;
      const loadingOld = harness.api.loadUsage({ skipCheck: true });
      await harness.flush();
      harness.state.preset = "month";
      await harness.api.loadUsage({ skipCheck: true });
      assert.equal(harness.state.fingerprint, "scope-read-2", "the new scope has painted while A is unresolved");
      assert.equal(harness.pendingFetches, 1);
      harness.state.usageEventsSource.emit("usage-synced");
      await harness.flush();
      assert.equal(harness.counts.usageSyncs, 3, "the latest scope must refresh before A is released");
      assert.equal(harness.fetchLog.at(-1).params.preset, "month");
      if (holdCurrent) {
        harness.state.usageEventsSource.emit("usage-synced");
        old.resolve({ payload: oldPayload });
        await loadingOld;
        await harness.flush();
        assert.equal(
          harness.counts.usageSyncs,
          3,
          "A's cleanup must not clear the current load or drain its pending wake",
        );
        assert.equal(harness.pendingFetches, 1);
        current.resolve({ payload: currentPayload });
      } else {
        assert.equal(harness.state.fingerprint, "scope-read-3", "the SSE response paints before A is released");
        assert.equal(harness.pendingFetches, 1);
        old.resolve({ payload: oldPayload });
        await loadingOld;
      }
      await harness.settle();
      assert.equal(harness.state.summary.range.preset, "month");
      assert.equal(harness.state.fingerprint, holdCurrent ? "scope-read-4" : "scope-read-3");
      assert.equal(harness.counts.usageSyncs, holdCurrent ? 4 : 3);
    } finally {
      old.resolve({ payload: oldPayload });
      current.resolve({ payload: currentPayload });
      await harness.settle();
      harness.dispose();
    }
  });
}

for (const holdCurrent of [false, true]) {
  test(`Q5 held optional pricing cannot block usage notifications: holdCurrent=${holdCurrent}`, async () => {
    const pricing = deferred();
    const current = deferred();
    let active = false;
    let reads = 0;
    let currentPayload;
    let loading;
    const harness = await browser((request, payloads) => {
      if (!active) return;
      if (request.path === "/api/pricing") return pricing.promise;
      if (request.path !== "/api/usage") return;
      const payload = app.clone(payloads.today);
      payload.fingerprint = `pricing-usage-${++reads}`;
      if (holdCurrent && reads === 2) {
        currentPayload = payload;
        return current.promise;
      }
      return { payload };
    });
    try {
      active = true;
      harness.dom.byId.get("pricingDialog").hidden = false;
      loading = harness.api.loadUsage({ skipCheck: true });
      await harness.flush();
      assert.equal(harness.state.fingerprint, "pricing-usage-1", "usage already painted before pricing returned");
      assert.equal(harness.fetchLog.at(-1).path, "/api/pricing");
      assert.equal(harness.pendingFetches, 1);
      harness.state.usageEventsSource.emit("usage-synced");
      await harness.flush();
      assert.equal(harness.counts.usageSyncs, 2, "SSE must refresh usage while optional pricing remains unresolved");
      if (holdCurrent) {
        harness.state.usageEventsSource.emit("usage-synced");
        pricing.resolve({ status: 500 });
        await loading;
        await harness.flush();
        assert.equal(harness.counts.usageSyncs, 2, "old pricing cleanup must not clear the newer active usage load");
        current.resolve({ payload: currentPayload });
      } else {
        assert.equal(harness.state.fingerprint, "pricing-usage-2", "SSE paints while pricing is still unresolved");
        assert.equal(harness.pendingFetches, 2);
        pricing.resolve({ status: 500 });
        await loading;
      }
      await harness.settle();
      assert.equal(harness.state.fingerprint, holdCurrent ? "pricing-usage-3" : "pricing-usage-2");
      assert.equal(harness.counts.usageSyncs, holdCurrent ? 3 : 2);
    } finally {
      harness.dom.byId.get("pricingDialog").hidden = true;
      pricing.resolve({ status: 500 });
      current.resolve({ payload: currentPayload });
      await loading;
      await harness.settle();
      harness.dispose();
    }
  });
}

test("Q5 callbacks from a replaced SSE stream cannot trigger live refreshes", async () => {
  const harness = await browser(() => undefined);
  try {
    const old = harness.state.usageEventsSource;
    harness.api.setAutoRefreshEnabled(false);
    await harness.settle();
    harness.api.setAutoRefreshEnabled(true);
    await harness.settle();
    harness.resetCounts();
    old.onopen();
    old.emit("usage-synced");
    await harness.settle();
    assert.equal(harness.counts.statusChecks, 0);
    assert.equal(harness.counts.usageSyncs, 0);
  } finally {
    harness.dispose();
  }
});

test("Q5 watcher errors wake verification so a broken subscription can be replaced", async () => {
  const timers = [];
  const errors = [];
  let hints = 0;
  const watcher = createUsageSourceWatcher({
    discoverRoots: async () => [{ path: process.cwd() }],
    watchFile: () => ({ on: (_type, handler) => errors.push(handler), close() {}, unref() {} }),
    schedule: (callback) => {
      timers.push(callback);
      return { unref() {} };
    },
    cancel() {},
    onHint: async () => {
      hints++;
      await watcher.refresh();
    },
  });
  try {
    await watcher.start();
    errors[0](new Error("subscription lost"));
    assert.equal(watcher.rootCount, 0);
    assert.equal(timers.length, 1, "watch failure must schedule verification without another file event");
    timers[0]();
    await watcher.refresh();
    assert.equal(hints, 1);
    assert.equal(watcher.rootCount, 1);
  } finally {
    await watcher.stop();
  }
});
