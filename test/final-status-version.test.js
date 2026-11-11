import assert from "node:assert/strict";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import { appendFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { createUsageServer } from "../src/server.js";
import { UsageSummaryCache } from "../src/usage-summary-cache.js";
import { createCodexIntegrationFixture } from "../test-support/usage-fixture.mjs";

const enabled = process.platform === "win32" && Boolean(process.env.Q6_TEST_HELPER && process.env.Q6_TEST_TRACE);
const query = "/api/usage?preset=all&view=dashboard&bucket=day&calendarZone=utc";
const line = (total) =>
  `${JSON.stringify({
    type: "event_msg",
    timestamp: "2026-10-04T13:00:00Z",
    payload: { type: "token_count", info: { last_token_usage: { total_tokens: total, input_tokens: total } } },
  })}\n`;

async function fixture(t) {
  const input = createCodexIntegrationFixture();
  const pricing = getPricingCatalog();
  const server = createUsageServer(input.serverOptions);
  let certified;
  let fullReads = 0;
  const readCertified = UsageSummaryCache.prototype.readCertifiedSourceState;
  const readFull = UsageSummaryCache.prototype.readSourceState;
  t.mock.method(UsageSummaryCache.prototype, "readCertifiedSourceState", async function (...args) {
    const result = await readCertified.apply(this, args);
    if (result) certified = result;
    return result;
  });
  t.mock.method(UsageSummaryCache.prototype, "readSourceState", async function (...args) {
    fullReads++;
    return readFull.apply(this, args);
  });
  t.after(async () => {
    await server.close();
    t.mock.restoreAll();
    setPricingCatalog(pricing);
    input.close();
  });
  await listenOnFetchPort(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  async function get(url = query) {
    const response = await fetch(base + url);
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  }
  function facts() {
    const db = new DatabaseSync(input.serverOptions.databaseFile, { readOnly: true });
    try {
      return {
        ...db.prepare("SELECT COUNT(*) count, SUM(total) total FROM events").get(),
        meta: db
          .prepare("SELECT key,value FROM store_meta WHERE key IN ('fingerprint','generated_at') ORDER BY key")
          .all(),
      };
    } finally {
      db.close();
    }
  }
  await appendFile(input.rolloutFiles[0], line(100));
  await get();
  await get();
  const initial = await get();
  assert.equal(certified?.acquisition?.format, 1, "this regression requires actual native certification");
  assert.equal(initial.summary.totals.total, 100);
  assert.equal(typeof initial.usageVersion, "string");
  const statusUrl = `/api/status?since=${encodeURIComponent(initial.fingerprint)}`;
  const quiet = await get(statusUrl);
  assert.equal(quiet.changed, false);
  assert.equal(quiet.usageVersion, initial.usageVersion);
  return { input, get, initial, statusUrl, facts, fullReads: () => fullReads };
}

test("status detects an unsynchronized native append without ingesting it", { skip: !enabled }, async (t) => {
  const f = await fixture(t);
  const before = f.facts();
  await appendFile(f.input.rolloutFiles[0], line(200));
  const status = await f.get(f.statusUrl);
  assert.equal(
    status.changed,
    true,
    "status must detect source bytes before any dashboard sync or watcher notification",
  );
  assert.notEqual(status.usageVersion, f.initial.usageVersion);
  assert.deepEqual(f.facts(), before, "status may check evidence but must not ingest the pending append");
  assert.equal((await f.get()).summary.totals.total, 300);
  const current = await f.get();
  assert.equal(current.usageVersion, (await f.get("/api/status")).usageVersion);
});

test("status falls back when catalog evidence is revoked and exposes the external commit", {
  skip: !enabled,
}, async (t) => {
  const f = await fixture(t);
  const before = f.facts();
  const db = new DatabaseSync(f.input.serverOptions.databaseFile);
  try {
    assert.equal(db.prepare("SELECT ready FROM usage_source_catalog WHERE path=''").get()?.ready, 1);
    db.exec("UPDATE usage_source_catalog SET ready=0 WHERE path=''");
    const fullReads = f.fullReads();
    const status = await f.get(f.statusUrl);
    assert.ok(f.fullReads() > fullReads, "lost catalog evidence must use complete source verification");
    assert.equal(typeof status.usageVersion, "string");
    assert.notEqual(
      status.usageVersion,
      f.initial.usageVersion,
      "an external commit must not reuse the old publication identity",
    );
    assert.deepEqual(f.facts(), before);
    assert.equal(
      db.prepare("SELECT ready FROM usage_source_catalog WHERE path=''").get()?.ready,
      0,
      "status must not rebuild or reseal unavailable source evidence",
    );
  } finally {
    db.close();
  }
});
