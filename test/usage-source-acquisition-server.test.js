import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createUsageServer } from "../src/server.js";

const enabled = Boolean(process.env.Q6_TEST_HELPER && process.env.Q6_TEST_TRACE);
const jsonl = (total, time) => `${JSON.stringify({ type: "event_msg", timestamp: new Date(time).toISOString(),
  payload: { type: "token_count", info: { total_token_usage: { input_tokens: total, total_tokens: total } } } })}\n`;

test("one certified result drives concurrent requests, notifications, scope changes and a complete server reopen", { skip: !enabled }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-acquisition-server-"));
  const trace = process.env.Q6_TEST_TRACE;
  const forbid = path.join(trace, "forbid");
  const file = path.join(root, ".codex", "sessions", "source.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  const start = Date.now() - 1000;
  await writeFile(file, `${JSON.stringify({ type: "session_meta", timestamp: new Date(start).toISOString(),
    payload: { id: "server", source: "cli", originator: "codex-tui", cwd: root } })}\n` +
    `${JSON.stringify({ type: "turn_context", payload: { model: "gpt-5" } })}\n` + jsonl(10, start));
  const options = { homeDir: root, env: {}, importDirs: [], databaseFile: path.join(root, "index.sqlite"),
    importStoreFile: path.join(root, "imports.json"), automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false };
  let server, stream;
  const query = "/api/usage?preset=all&view=dashboard&bucket=day&calendarZone=utc";
  async function listen() {
    server = createUsageServer(options);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(49152 + process.pid % 8192, "127.0.0.1", resolve);
    });
    return `http://127.0.0.1:${server.address().port}`;
  }
  async function get(base, url) {
    const response = await fetch(base + url);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  }
  function ready() {
    const db = new DatabaseSync(options.databaseFile, { readOnly: true });
    try { return db.prepare("SELECT ready FROM usage_source_catalog WHERE path=''").get()?.ready; }
    finally { db.close(); }
  }
  try {
    let base = await listen();
    const initial = await get(base, query);
    assert.equal(initial.summary.totals.total, 10);
    assert.equal(ready(), 1, "the complete initialization must publish a reusable catalog");
    await writeFile(forbid, "discovery and historical enumeration must not run");
    await appendFile(file, jsonl(20, start + 10));
    const concurrent = await Promise.all([get(base, query), get(base, `${query}&skipCheck=1`)]);
    for (const result of concurrent) assert.equal(result.summary.totals.total, 20);
    assert.equal(concurrent[0].fingerprint, concurrent[1].fingerprint);
    for (const preset of ["today", "week", "all"])
      assert.equal((await get(base, `/api/usage?preset=${preset}&view=dashboard&bucket=day&skipCheck=1`)).summary.totals.total, 20);
    stream = new AbortController();
    const response = await fetch(`${base}/api/usage-events`, { signal: stream.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    async function until(predicate) {
      const timeout = setTimeout(() => stream.abort(), 8000);
      try {
        while (!predicate(text)) {
          const chunk = await reader.read();
          assert.equal(chunk.done, false);
          text += decoder.decode(chunk.value, { stream: true });
        }
      } finally { clearTimeout(timeout); }
    }
    await until((value) => value.includes("event: ready"));
    await appendFile(file, jsonl(30, start + 20));
    await until((value) => value.includes("event: usage-synced"));
    assert.equal((await get(base, `${query}&skipCheck=1`)).summary.totals.total, 30);
    stream.abort();
    await reader.cancel().catch(() => {});
    await server.close();
    server = null;
    base = await listen();
    assert.equal((await get(base, query)).summary.totals.total, 30);
    assert.equal(ready(), 1);
  } finally {
    stream?.abort();
    await server?.close();
    await rm(forbid, { force: true });
    assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    assert.ok(path.basename(root).startsWith("usage-acquisition-server-"));
    await rm(root, { recursive: true, force: true });
  }
});
