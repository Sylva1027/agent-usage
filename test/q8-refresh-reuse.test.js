import assert from "node:assert/strict";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import childProcess from "node:child_process";
import fs from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { ServerResponse } from "node:http";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createUsageServer } from "../src/server.js";
import { UsageSummaryCache } from "../src/usage-summary-cache.js";
import { createCodexIntegrationFixture } from "../test-support/usage-fixture.mjs";

const query = "/api/usage?preset=all&view=dashboard&bucket=day&calendarZone=utc";
const line = (total) =>
  `${JSON.stringify({
    type: "event_msg",
    timestamp: "2026-10-04T13:00:00Z",
    payload: { type: "token_count", info: { last_token_usage: { total_tokens: total, input_tokens: total } } },
  })}\n`;

// Exercise the SHA fallback even on machines with an installed native helper.
const loader = `import { registerHooks } from 'node:module'; registerHooks({load(url,ctx,next){
 const value=next(url,ctx); return url.endsWith('/src/usage-source-proof.js')
 ? {...value,source:value.source+'\\nUsageSourceProof.prototype.provider=async()=>null;'} : value; }});`;

async function fixture(t) {
  const input = createCodexIntegrationFixture();
  const argv = [...process.execArgv];
  process.execArgv.push("--import", `data:text/javascript,${encodeURIComponent(loader)}`);
  const sent = [];
  const fork = childProcess.fork;
  t.mock.method(childProcess, "fork", (...args) => {
    const child = fork(...args);
    const send = child.send;
    t.mock.method(child, "send", function (message, ...rest) {
      if (message.type === "sync" && !message.certifiedOnly) sent.push(message);
      return send.call(this, message, ...rest);
    });
    return child;
  });
  syncBuiltinESMExports();
  // A missing/failed response publication must not force a second acquisition.
  t.mock.method(UsageSummaryCache.prototype, "publish", async () => {});
  let server;
  async function start() {
    server = createUsageServer(input.serverOptions);
    await listenOnFetchPort(server);
    return `http://127.0.0.1:${server.address().port}`;
  }
  let base = await start();
  const get = async (url = query) => {
    const response = await fetch(base + url);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  await get();
  t.after(async () => {
    await server.close();
    process.execArgv.splice(0, process.execArgv.length, ...argv);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    input.close();
  });
  return {
    input,
    sent,
    get,
    append: (total) => appendFile(input.rolloutFiles[0], line(total)),
    base: () => base,
    restart: async () => {
      await server.close();
      base = await start();
    },
  };
}

function holdNextRead(t) {
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
  t.after(() => released.resolve());
  return { entered: entered.promise, release: () => released.resolve() };
}

test("Q8 concurrent duplicate checks reuse completed acquisition before response publication", async (t) => {
  const f = await fixture(t);
  const gate = holdNextRead(t);
  f.sent.length = 0;
  await f.append(100);
  const first = f.get();
  try {
    await gate.entered;
    const duplicate = await Promise.all([f.get(), f.get()]);
    for (const value of duplicate) assert.equal(value.summary.totals.total, 100);
    assert.equal(f.sent.length, 1, "identical checked sources must not trigger a second sync");
  } finally {
    gate.release();
    await first;
  }
});

test("Q8 a late duplicate watcher hint verifies sources without syncing them again", async (t) => {
  const watchers = [],
    timers = [];
  const timeout = globalThis.setTimeout;
  t.mock.method(fs, "watch", (_root, _options, callback) => {
    watchers.push(callback);
    return { on() {}, unref() {}, close() {} };
  });
  syncBuiltinESMExports();
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
    if (ms !== 75) return timeout(callback, ms, ...args);
    timers.push(callback);
    return { unref() {} };
  });
  const f = await fixture(t);
  const ready = Promise.withResolvers(),
    changed = Promise.withResolvers();
  const write = ServerResponse.prototype.write;
  t.mock.method(ServerResponse.prototype, "write", function (chunk, ...args) {
    if (String(chunk).startsWith("event: ready\n")) ready.resolve();
    if (String(chunk).startsWith("event: usage-synced\n")) changed.resolve();
    return write.call(this, chunk, ...args);
  });
  const reader = (await fetch(`${f.base()}/api/usage-events`)).body.getReader();
  try {
    await ready.promise;
    const hint = () => {
      watchers[0]("change", "rollout-1.jsonl");
      timers.shift()();
    };
    f.sent.length = 0;
    await f.append(100);
    hint();
    await changed.promise;
    hint();
    assert.equal((await f.get()).summary.totals.total, 100);
    assert.equal(f.sent.length, 1, "the late hint may check again, but facts are already synchronized");
  } finally {
    await reader.cancel();
  }
});

test("Q8 a write during the post-sync source check remains pending for the next check", async (t) => {
  const f = await fixture(t);
  const original = UsageSummaryCache.prototype.readSourceState;
  let reads = 0;
  t.mock.method(UsageSummaryCache.prototype, "readSourceState", async function (...args) {
    const source = await original.apply(this, args);
    if (++reads === 2) {
      await f.append(200);
      return original.apply(this, args);
    }
    return source;
  });
  f.sent.length = 0;
  await f.append(100);
  await f.get();
  assert.equal((await f.get()).summary.totals.total, 300);
  assert.equal(f.sent.length, 2);
});

test("Q8 a second write after commit cannot reuse the first acquisition", async (t) => {
  const f = await fixture(t);
  const gate = holdNextRead(t);
  f.sent.length = 0;
  await f.append(100);
  const first = f.get();
  try {
    await gate.entered;
    await f.append(200);
    assert.equal((await f.get()).summary.totals.total, 300);
    assert.equal(f.sent.length, 2);
  } finally {
    gate.release();
    await first;
  }
});

test("Q8 external database and auxiliary changes revoke acquisition reuse", async (t) => {
  const f = await fixture(t);
  // Finish initial derived writes before testing a quiet matching publication.
  await f.append(100);
  await f.get();
  await f.get();
  f.sent.length = 0;
  const db = new DatabaseSync(f.input.serverOptions.databaseFile);
  try {
    db.prepare("UPDATE events SET total=total+50,input=input+50").run();
  } finally {
    db.close();
  }
  assert.equal((await f.get(`${query}&skipCheck=1`)).summary.totals.total, 150);
  await f.get(`${query}&skipCheck=1`);
  assert.equal((await f.get()).summary.totals.total, 150);
  assert.equal(f.sent.length, 1, "external commit must invalidate even unchanged raw sources");
  await writeFile(path.join(f.input.codexHome, "config.toml"), 'model = "new-q8-model"');
  await f.get();
  assert.equal(f.sent.length, 2, "auxiliary input changes must be processed");
});

test("Q8 restart without a published response verifies and synchronizes sources", async (t) => {
  const f = await fixture(t);
  await f.append(100);
  await f.get();
  await f.restart();
  f.sent.length = 0;
  assert.equal((await f.get()).summary.totals.total, 100);
  assert.equal(f.sent.length, 1, "process-local reuse must not become a trusted startup snapshot");
  assert.equal((await f.get()).summary.totals.total, 100);
  assert.equal(f.sent.length, 1, "the new process can reuse its own checked acquisition");
});
