import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";
import { UsageStore } from "../src/usage-store.js";
import { createUsageServer } from "../src/server.js";
import { getPricingCatalog } from "../src/pricing.js";
import { refreshSummaryClock, summaryCacheKey, UsageSummaryCache } from "../src/usage-summary-cache.js";

test("cached aggregates update trend, quota flags and model activity with the clock", () => {
  const payload = {
    summary: {
      range: {
        preset: "quota_5h",
        quotaWindow: true,
        start: "2026-01-02T00:00:00Z",
        end: "2026-01-02T23:59:59.999Z",
        windowEndExclusive: "2026-01-03T00:00:00Z",
        observedAt: "2026-01-02T11:55:00Z",
      },
      totals: { total: 50 },
      comparison: {
        previousRange: { start: "2026-01-01T00:00:00Z", end: "2026-01-01T23:59:59.999Z" },
        previousTotals: { total: 86400 },
        previousEventCount: 2,
        previousSessionCount: 1,
      },
      quota: { windows: { quota_week: { state: "available", observedAt: "2026-01-02T11:55:00Z" } } },
      timeline: [{ slotStartMs: Date.parse("2026-01-02T12:30:00Z"), future: true }],
    },
    metadata: { modelLastSeen: { Codex: { "gpt-6": Date.parse("2025-12-02T12:30:00Z") } } },
    periodComparison: {},
  };
  refreshSummaryClock(payload, new Date("2026-01-02T12:00:00Z"));
  assert.equal(payload.summary.comparison.averageBaselineTotal, 43200);
  assert.equal(payload.summary.quota.windows.quota_week.percentStale, false);
  assert.deepEqual(payload.metadata.activeHarnessModels.Codex, ["gpt-6"]);
  refreshSummaryClock(payload, new Date("2026-01-02T13:00:00Z"));
  assert.equal(payload.summary.comparison.averageBaselineTotal, 46800);
  assert.equal(payload.summary.comparison.averageDelta, -46750);
  assert.equal(payload.summary.quota.windows.quota_week.percentStale, true);
  assert.equal(payload.summary.timeline[0].future, false);
  assert.equal(payload.summary.range.end, "2026-01-02T12:59:59.999Z");
  assert.deepEqual(payload.metadata.activeHarnessModels.Codex, []);
});

test("rolling day bypasses summaries; obsolete state and malformed payload rebuild", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  let cache = new UsageSummaryCache(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.serverOptions });
    const now = new Date("2026-10-04T13:00:00Z");
    const filters = { preset: "all", bucket: "day", calendarZone: "utc", now };
    const payload = await store.dashboardHistory(filters, { includeDetails: false });
    const source = await cache.readSourceState();
    const key = summaryCacheKey(filters, false, getPricingCatalog());
    assert.equal(
      summaryCacheKey({ ...filters, preset: "recent", recentValue: "1 天" }, false, getPricingCatalog()),
      null,
    );
    await cache.publish(key, payload, {}, source, now);
    cache.database.prepare("UPDATE summaries SET payload = 'broken'").run();
    assert.equal(await cache.get(key, source, now), null);
    await cache.publish(key, payload, {}, source, now);
    cache.database.prepare("UPDATE summary_state SET state = ?").run(JSON.stringify({ version: -1, executor: {} }));
    cache.close();
    cache = new UsageSummaryCache(fixture.serverOptions);
    const reopened = await cache.readSourceState();
    assert.equal(await cache.get(key, reopened, now), null);
    assert.equal(await cache.stateFor(reopened), null);
  } finally {
    cache.close();
    store.close();
    fixture.close();
  }
});

test("publication changed during a request is never attached to its cached result", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  const originalGet = UsageSummaryCache.prototype.get;
  const originalPublish = UsageSummaryCache.prototype.publish;
  let server;
  let changed = false;
  let publications = 0;
  try {
    await store.sync({ options: fixture.serverOptions });
    UsageSummaryCache.prototype.get = async function (...args) {
      const result = await originalGet.apply(this, args);
      if (!changed) {
        changed = true;
        store.database
          .prepare("INSERT OR REPLACE INTO store_meta (key,value) VALUES ('cache-race-fixture','new')")
          .run();
      }
      return result;
    };
    UsageSummaryCache.prototype.publish = async function (...args) {
      publications += 1;
      return originalPublish.apply(this, args);
    };
    server = createUsageServer({ ...fixture.serverOptions, pricingRefreshSchedulerEnabled: false });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/usage?preset=all&view=dashboard`;
    const first = await fetch(url);
    assert.equal(first.status, 200);
    await first.json();
    assert.equal(publications, 0);
    const second = await fetch(url);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("x-summary-cache"), "miss");
    await second.json();
    assert.equal(publications, 1);
    const third = await fetch(url);
    assert.equal(third.headers.get("x-summary-cache"), "hit");
    await third.json();
  } finally {
    UsageSummaryCache.prototype.get = originalGet;
    UsageSummaryCache.prototype.publish = originalPublish;
    await server?.close();
    store.close();
    fixture.close();
  }
});

test("persisted dashboard matches a fresh query as time advances and survives restart", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const options = fixture.serverOptions;
  const store = new UsageStore(options);
  let cache = new UsageSummaryCache(options);
  try {
    await store.sync({ options });
    await fixture.seedRequestTiming(store);
    const now = new Date("2026-10-04T13:00:00Z");
    const filters = { preset: "today", bucket: "hour", calendarZone: "utc", now };
    const payload = {
      ...(await store.dashboardHistory(filters, { includeDetails: false })),
      pricingCatalog: getPricingCatalog(),
    };
    const source = await cache.readSourceState(options);
    const key = summaryCacheKey(filters, false, getPricingCatalog());
    await cache.publish(key, payload, { status: { fingerprint: store.fingerprint } }, source, now);
    const later = new Date("2026-10-04T14:00:00Z");
    const fresh = {
      ...(await store.dashboardHistory({ ...filters, now: later }, { includeDetails: false })),
      pricingCatalog: getPricingCatalog(),
    };
    assert.deepEqual(await cache.get(key, await cache.readSourceState(options), later), fresh);
    cache.close();
    cache = new UsageSummaryCache(options);
    const reopened = await cache.readSourceState(options);
    assert.deepEqual(await cache.get(key, reopened, later), fresh);
    assert.equal((await cache.stateFor(reopened)).status.fingerprint, store.fingerprint);
    assert.equal(await cache.get(key, reopened, new Date("2026-10-05T00:00:00Z")), null);
    assert.notEqual(
      summaryCacheKey({ ...filters, now: new Date("2026-10-05T00:00:00Z") }, false, getPricingCatalog()),
      key,
    );
    assert.notEqual(summaryCacheKey({ ...filters, excludeHomes: ["other-home"] }, false, getPricingCatalog()), key);
    await writeFile(path.join(fixture.codexHome, "config.toml"), 'model_provider = "api"\n');
    assert.equal(await cache.get(key, await cache.readSourceState(options), later), null);
  } finally {
    cache.close();
    store.close();
    fixture.close();
  }
});

test("new future facts expire cached results at the correct instant", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  const cache = new UsageSummaryCache(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.serverOptions });
    const now = new Date("2026-10-04T12:00:00Z");
    const filters = { preset: "all", now, bucket: "day", calendarZone: "utc" };
    const payload = await store.dashboardHistory(filters, { includeDetails: false });
    const source = await cache.readSourceState();
    const key = summaryCacheKey(filters, false, getPricingCatalog());
    await cache.publish(key, payload, {}, source, now);
    assert(await cache.get(key, source, new Date("2026-10-04T12:00:01Z")));
    assert.equal(await cache.get(key, source, new Date("2026-10-04T12:00:12.500Z")), null);
  } finally {
    cache.close();
    store.close();
    fixture.close();
  }
});

test("recovered quota metadata expires summaries at reset without a rollout row", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  const cache = new UsageSummaryCache(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.serverOptions });
    const now = new Date("2026-10-04T12:00:00Z");
    const filters = { preset: "all", now, bucket: "day", calendarZone: "utc" };
    const payload = await store.dashboardHistory(filters, { includeDetails: false });
    payload.summary.quota.windows.quota_week = {
      state: "available",
      observedAt: now.toISOString(),
      windowEndExclusive: "2026-10-04T12:00:05Z",
    };
    const source = await cache.readSourceState();
    const key = summaryCacheKey(filters, false, getPricingCatalog());
    await cache.publish(key, payload, {}, source, now);
    assert(await cache.get(key, source, new Date("2026-10-04T12:00:04.999Z")));
    assert.equal(await cache.get(key, source, new Date("2026-10-04T12:00:05Z")), null);
  } finally {
    cache.close();
    store.close();
    fixture.close();
  }
});
