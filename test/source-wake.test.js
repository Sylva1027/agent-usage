import assert from "node:assert/strict";
import { appendFile, rm, writeFile } from "node:fs/promises";
import { ServerResponse } from "node:http";
import path from "node:path";
import test from "node:test";

import { createUsageServer } from "../src/server.js";
import { createUsageSourceWatcher } from "../src/usage-source-watch.js";
import { createCodexIntegrationFixture } from "../test-support/usage-fixture.mjs";

process.env.U4_HARNESS_ONLY = "1";
const appHarness = await import("./app-autorefresh.test.js");
delete process.env.U4_HARNESS_ONLY;

const USAGE_QUERY = "preset=all&bucket=hour&calendarZone=local&view=dashboard";

test("HTTP reads cannot publish a partial cumulative repair and recover when its source returns", async () => {
  const fixture = createCodexIntegrationFixture();
  const server = createUsageServer(fixtureServerOptions(fixture));
  const [upstream, downstream] = fixture.rolloutFiles;
  const text = (total, minute) =>
    `${[
      {
        type: "session_meta",
        timestamp: "2026-10-04T12:00:00Z",
        payload: { id: "http-dependency", source: "cli", cwd: "" },
      },
      { type: "turn_context", payload: { model: "gpt-6-sol" } },
      {
        type: "event_msg",
        timestamp: `2026-10-04T12:0${minute}:00Z`,
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              total_tokens: total,
              input_tokens: total,
              cached_input_tokens: 0,
              output_tokens: 0,
              reasoning_output_tokens: 0,
            },
          },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n")}\n`;
  try {
    await writeFile(upstream, text(100, 1));
    const original = text(200, 2);
    await writeFile(downstream, original);
    const baseUrl = await listen(server);
    assert.equal((await getJson(baseUrl, `/api/usage?${USAGE_QUERY}`)).summary.totals.total, 200);
    await rm(downstream);
    await writeFile(upstream, text(150, 1));
    for (const query of [USAGE_QUERY, "preset=all&bucket=day&calendarZone=utc&skipCheck=1"]) {
      const response = await fetch(`${baseUrl}/api/usage?${query}`);
      const body = await response.json();
      assert.equal(response.status, 500);
      assert.equal(body.code, "SOURCE_DEPENDENCY_PENDING");
      assert.equal(body.summary, undefined);
    }
    await writeFile(downstream, original);
    assert.equal((await getJson(baseUrl, `/api/usage?${USAGE_QUERY}`)).summary.totals.total, 200);
  } finally {
    await server.close();
    fixture.close();
  }
});

function usageLine(timestamp, total) {
  return `${JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          total_tokens: total,
          input_tokens: Math.max(0, total - 20),
          cached_input_tokens: 0,
          output_tokens: Math.min(20, total),
          reasoning_output_tokens: 0,
        },
      },
    },
  })}\n`;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function getJson(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

function sseClient(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  let ended = false;

  async function readMore() {
    if (ended) throw new Error("SSE stream ended");
    let next;
    try {
      next = await reader.read();
    } catch (error) {
      ended = true;
      throw error;
    }
    if (next.done) {
      ended = true;
      throw new Error("SSE stream ended");
    }
    buffer += decoder.decode(next.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) events.push({ event, data: JSON.parse(data) });
      boundary = buffer.indexOf("\n\n");
    }
  }

  async function next(eventName, timeoutMs = 5_000) {
    const started = Date.now();
    while (true) {
      const index = events.findIndex((entry) => entry.event === eventName);
      if (index >= 0) return events.splice(index, 1)[0].data;
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for SSE ${eventName}`);
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for SSE ${eventName}`)), timeoutMs);
      });
      try {
        await Promise.race([readMore(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async function waitForClose(timeoutMs = 5_000) {
    if (ended) return;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out waiting for SSE close")), timeoutMs);
    });
    try {
      await Promise.race([
        (async () => {
          while (!ended) {
            try {
              await readMore();
            } catch (error) {
              if (ended) return;
              throw error;
            }
          }
        })(),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    next,
    waitForClose,
    eventCount(eventName) {
      return events.filter((entry) => entry.event === eventName).length;
    },
    async close() {
      await reader.cancel().catch(() => {});
    },
  };
}

async function openSse(baseUrl) {
  const response = await fetch(`${baseUrl}/api/usage-events`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^text\/event-stream/);
  const client = sseClient(response);
  await client.next("ready");
  return client;
}

async function waitUntil(check, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition timed out");
}

function fixtureServerOptions(fixture) {
  return {
    ...fixture.serverOptions,
    pricingRefreshSchedulerEnabled: false,
    automaticDiscoveryEnabled: false,
  };
}

test("source watcher keeps a fixed coalescing window under continuous hints", async () => {
  const listeners = [];
  const timers = [];
  let hints = 0;
  const watcher = createUsageSourceWatcher({
    discoverRoots: async () => [{ path: process.cwd(), recursive: true }],
    onHint: () => {
      hints += 1;
    },
    watchFile: (_root, _options, listener) => {
      listeners.push(listener);
      return { on() {}, unref() {}, close() {} };
    },
    schedule: (callback) => {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    cancel() {},
  });
  await watcher.start();
  listeners[0]("change", "rollout.jsonl");
  listeners[0]("change", "session.jsonl");
  assert.equal(timers.length, 1);
  timers[0].callback();
  assert.equal(hints, 1);
  listeners[0]("change", "rollout.jsonl-wal");
  listeners[0]("change", "rollout.jsonl-journal");
  assert.equal(timers.length, 2);
  timers[1].callback();
  assert.equal(hints, 2);
  await watcher.stop();
});

test("source watcher accepts SQLite sidecars but excludes explicit runtime artifacts", async () => {
  const listeners = [];
  const timers = [];
  let hints = 0;
  const watcher = createUsageSourceWatcher({
    discoverRoots: async () => [{ path: process.cwd(), recursive: true }],
    onHint: () => {
      hints += 1;
    },
    ignorePath: (filename) => filename === path.join(process.cwd(), ".codex-usage", "usage-index.sqlite-wal"),
    watchFile: (_root, _options, listener) => {
      listeners.push(listener);
      return { on() {}, unref() {}, close() {} };
    },
    schedule: (callback) => {
      const timer = { callback, unref() {} };
      timers.push(timer);
      return timer;
    },
    cancel() {},
  });
  await watcher.start();
  listeners[0]("change", ".codex-usage/usage-index.sqlite-wal");
  assert.equal(timers.length, 0);
  listeners[0]("change", "logs_2.sqlite-wal");
  listeners[0]("change", "logs_2.sqlite-journal");
  assert.equal(timers.length, 1);
  timers[0].callback();
  assert.equal(hints, 1);
  await watcher.stop();
});

test("source watcher stop prevents discovery from installing watchers afterward", async () => {
  let releaseDiscovery;
  const installed = [];
  const watcher = createUsageSourceWatcher({
    discoverRoots: () =>
      new Promise((resolve) => {
        releaseDiscovery = () => resolve([{ path: process.cwd(), recursive: true }]);
      }),
    watchFile: () => {
      installed.push(true);
      return { on() {}, unref() {}, close() {} };
    },
  });

  const starting = watcher.start();
  await waitUntil(() => typeof releaseDiscovery === "function");
  const stopping = watcher.stop();
  releaseDiscovery();
  await Promise.all([starting, stopping]);
  assert.equal(installed.length, 0);
  assert.equal(watcher.rootCount, 0);
});

test("real server coalesces source wake into a committed notification and correct scoped read", async () => {
  const fixture = createCodexIntegrationFixture();
  const server = createUsageServer(fixtureServerOptions(fixture));
  let sse;
  try {
    const baseUrl = await listen(server);
    const initial = await getJson(baseUrl, `/api/usage?${USAGE_QUERY}&skipCheck=1`);
    assert.equal(initial.summary.totals.total, 0);
    sse = await openSse(baseUrl);

    await appendFile(fixture.rolloutFiles[0], usageLine("2026-10-04T13:00:00.000Z", 100));
    const first = await sse.next("usage-synced");
    assert.equal(typeof first.checkedAt, "string");
    assert.equal((await getJson(baseUrl, `/api/usage?${USAGE_QUERY}&skipCheck=1`)).summary.totals.total, 100);

    await appendFile(fixture.rolloutFiles[0], usageLine("2026-10-04T13:01:00.000Z", 100));
    await appendFile(fixture.rolloutFiles[0], usageLine("2026-10-04T13:02:00.000Z", 100));
    await sse.next("usage-synced");
    assert.equal((await getJson(baseUrl, `/api/usage?${USAGE_QUERY}&skipCheck=1`)).summary.totals.total, 300);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(sse.eventCount("usage-synced"), 0, "one burst must produce one completed notification");
  } finally {
    await sse?.close();
    await server.close();
    fixture.close();
  }
});

test("imported runtime rejects the live stream without starting source sync", async () => {
  const fixture = createCodexIntegrationFixture();
  let server;
  try {
    const options = fixtureServerOptions(fixture);
    server = createUsageServer(options);
    let baseUrl = await listen(server);
    const initial = await getJson(baseUrl, `/api/usage?${USAGE_QUERY}`);
    await server.close();
    server = null;

    server = createUsageServer({
      ...options,
      importContext: {
        pricingCatalog: initial.pricingCatalog,
        serviceTierEvidenceSnapshot: null,
      },
    });
    baseUrl = await listen(server);
    const events = await fetch(`${baseUrl}/api/usage-events`);
    assert.equal(events.status, 204);
    assert.equal((await events.arrayBuffer()).byteLength, 0);

    await appendFile(fixture.rolloutFiles[0], usageLine("2026-10-04T13:06:00.000Z", 120));
    await new Promise((resolve) => setTimeout(resolve, 350));
    const usage = await getJson(baseUrl, `/api/usage?${USAGE_QUERY}&skipCheck=1`);
    assert.equal(usage.summary.totals.total, 0);
  } finally {
    await server?.close();
    fixture.close();
  }
});

test("a slow SSE client is disconnected when response buffering applies backpressure", async () => {
  const fixture = createCodexIntegrationFixture();
  const server = createUsageServer(fixtureServerOptions(fixture));
  const originalWrite = ServerResponse.prototype.write;
  let sse;
  try {
    const baseUrl = await listen(server);
    sse = await openSse(baseUrl);
    ServerResponse.prototype.write = function (chunk) {
      if (String(chunk).includes("event: usage-synced")) return false;
      return originalWrite.call(this, chunk);
    };

    await appendFile(fixture.rolloutFiles[0], usageLine("2026-10-04T13:07:00.000Z", 100));
    await sse.waitForClose();
  } finally {
    ServerResponse.prototype.write = originalWrite;
    await sse?.close();
    await server.close();
    fixture.close();
  }
});

test("frozen snapshots stay isolated while the live SSE notification carries the committed value", async () => {
  const fixture = createCodexIntegrationFixture();
  const server = createUsageServer(fixtureServerOptions(fixture));
  let sse;
  try {
    const baseUrl = await listen(server);
    await getJson(baseUrl, `/api/usage?${USAGE_QUERY}`);
    const frozen = await getJson(baseUrl, `/api/usage?${USAGE_QUERY}&freeze=1&skipCheck=1`);
    assert.equal(frozen.summary.totals.total, 0);
    sse = await openSse(baseUrl);

    await appendFile(fixture.rolloutFiles[1], usageLine("2026-10-04T13:03:00.000Z", 140));
    await sse.next("usage-synced");
    assert.equal((await getJson(baseUrl, `/api/usage?${USAGE_QUERY}&skipCheck=1`)).summary.totals.total, 140);
    const replay = await getJson(
      baseUrl,
      `/api/usage?${USAGE_QUERY}&snapshot=${encodeURIComponent(frozen.snapshotId)}`,
    );
    assert.equal(replay.summary.totals.total, 0);
  } finally {
    await sse?.close();
    await server.close();
    fixture.close();
  }
});

test("a missed wake remains recoverable by the existing checked sync path", async () => {
  const fixture = createCodexIntegrationFixture();
  const server = createUsageServer(fixtureServerOptions(fixture));
  try {
    const baseUrl = await listen(server);
    await getJson(baseUrl, `/api/usage?${USAGE_QUERY}`);
    const sse = await openSse(baseUrl);
    await sse.close();

    await appendFile(fixture.rolloutFiles[2], usageLine("2026-10-04T13:04:00.000Z", 80));
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal((await getJson(baseUrl, `/api/usage?${USAGE_QUERY}&skipCheck=1`)).summary.totals.total, 0);
    assert.equal((await getJson(baseUrl, `/api/usage?${USAGE_QUERY}`)).summary.totals.total, 80);
  } finally {
    await server.close();
    fixture.close();
  }
});

test("server close ends a live SSE connection instead of waiting forever", async () => {
  const fixture = createCodexIntegrationFixture();
  const server = createUsageServer(fixtureServerOptions(fixture));
  let sse;
  try {
    const baseUrl = await listen(server);
    sse = await openSse(baseUrl);
    const closed = server.close();
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("server close hung on live SSE")), 3_000)),
    ]);
  } finally {
    await sse?.close();
    if (server.listening) await server.close();
    fixture.close();
  }
});

test("browser auto-refresh reconnects through the full check and reloads only the current live scope", async () => {
  const payloads = await appHarness.loadRecordedPayloads();
  const month = appHarness.clone(payloads.today);
  month.summary.range.preset = "month";
  const router = appHarness.createRouter({
    payloads,
    status: () => ({ payload: { changed: false, fingerprint: payloads.today.fingerprint } }),
    usage: ({ request }) => ({
      payload:
        request.params.freeze === "1"
          ? { ...payloads.today, snapshotId: "frozen-snapshot" }
          : request.params.preset === "month"
            ? month
            : payloads.today,
    }),
  });
  const harness = await appHarness.createCycleHarness({
    response: router,
    storage: { codexUsageAutoRefresh: "on" },
    initial: { preset: "today" },
  });
  class FakeEventSource {
    static instances = [];
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.listeners = new Map();
      FakeEventSource.instances.push(this);
    }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    emit(type) {
      for (const listener of this.listeners.get(type) || []) listener({ type, data: "{}" });
    }
    close() {
      this.closed = true;
    }
  }

  try {
    await harness.settle();
    harness.context.window.EventSource = FakeEventSource;
    harness.api.startAutoRefresh();
    const source = FakeEventSource.instances.at(-1);
    assert.equal(source.url, "/api/usage-events");
    const statusBefore = harness.counts.statusChecks;
    source.onopen?.();
    await harness.settle();
    assert.ok(harness.counts.statusChecks > statusBefore, "connection recovery must run the full source check");

    harness.state.preset = "month";
    source.emit("usage-synced");
    await harness.settle();
    const usage = harness.fetchLog.filter((entry) => entry.path === "/api/usage").at(-1);
    assert.equal(usage.params.preset, "month");
    assert.equal(usage.params.skipCheck, "1");
    assert.equal(harness.state.summary.range.preset, "month");

    harness.api.setAutoRefreshEnabled(false);
    await harness.settle();
    assert.equal(source.closed, true);
    const usageBefore = harness.counts.usageSyncs;
    source.emit("usage-synced");
    await harness.flush();
    assert.equal(harness.counts.usageSyncs, usageBefore, "closed/frozen auto-refresh ignores late SSE events");
    assert.equal(harness.activeIntervals(60_000).length, 0);
  } finally {
    harness.dispose();
  }
});
