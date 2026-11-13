import assert from "node:assert/strict";
import test from "node:test";
import { createShareCardData, SHARE_METRICS, shareCardFilename } from "../public/share-card-data.js";
import { summarizePeriodComparison } from "../public/period-comparison.js";
import { summarizeUsage } from "../src/usage-core.js";
import { UsageStore } from "../src/usage-store.js";
import { createPricingPolicyFixture } from "../test-support/pricing-official-fixture.mjs";

const now = "2026-11-13T12:00:00.000Z";

function event(total, index = 0, overrides = {}) {
  return {
    timestamp: now,
    model: `model-${index}`,
    sessionId: `private-session-${index}`,
    homeId: "included",
    homeLabel: "Private source",
    channel: "Codex",
    cwd: "C:/private/project",
    sourcePath: "C:/private/session.jsonl",
    detailMask: 15,
    total: { total, input: total * 0.8, cached: total * 0.6, output: total * 0.2, reasoning: 0 },
    ...overrides,
  };
}

function dashboard(events, overrides = {}) {
  const filters = { preset: "week", calendarZone: "utc", now, excludeHomes: ["excluded"], ...overrides };
  return {
    summary: summarizeUsage({ generatedAt: now, events }, filters),
    periodComparison: summarizePeriodComparison(
      events.filter((row) => !filters.excludeHomes.includes(row.homeId)),
      filters,
    ),
  };
}

test("share projection uses the loaded summary's range and source scope, with only five model rows", () => {
  const rows = Array.from({ length: 7 }, (_, index) => event((7 - index) * 1e6, index));
  rows.push(event(999e6, 99, { homeId: "excluded" }));
  rows.push(event(888e6, 88, { timestamp: "2026-11-01T12:00:00.000Z" }));
  const { summary, periodComparison } = dashboard(rows);
  const snapshot = createShareCardData(summary, { preset: "week", periodComparison });

  assert.equal(snapshot.period, "week");
  assert.equal(snapshot.totals.total, 28e6);
  assert.equal(snapshot.sessionCount, 7);
  assert.equal(snapshot.modelCount, 7);
  assert.deepEqual(
    snapshot.models.map((row) => row.total),
    [7e6, 6e6, 5e6, 4e6, 3e6],
  );
  assert.equal(snapshot.filename, "usage_20261109-20261113.png");
  assert.equal(SHARE_METRICS.length, 8);
  assert.doesNotMatch(JSON.stringify(snapshot), /private|sourcePath|sessionId|homeId|cwd|excluded/i);

  summary.totals.total = 1;
  summary.models[0].name = "changed";
  summary.range.end = "2027-01-01T00:00:00.000Z";
  assert.equal(snapshot.totals.total, 28e6);
  assert.equal(snapshot.models[0].name, "model-0");
  assert.equal(snapshot.filename, "usage_20261109-20261113.png");
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.range));
  assert.ok(Object.isFrozen(snapshot.totals));
  assert.ok(Object.isFrozen(snapshot.models));
  assert.ok(Object.isFrozen(snapshot.models[0]));
});

test("known cache data supplies the weighted hit rate and uncached input without fabricating missing details", () => {
  const { summary, periodComparison } = dashboard([
    event(100),
    event(900, 1, {
      detailMask: 1,
      total: { total: 900, input: 900, cached: 0, output: 0, reasoning: 0 },
    }),
  ]);
  const snapshot = createShareCardData(summary, { periodComparison });
  assert.equal(snapshot.cacheHitRate, 0.75);
  assert.equal(snapshot.totals.uncached, 20);
  assert.notEqual(snapshot.totals.uncached, summary.totals.input - summary.totals.cached);
  assert.equal(snapshot.unavailableTokens.uncached, 900);
  assert.equal(createShareCardData(summary).totals.uncached, null);

  const unknown = dashboard([
    event(900, 1, {
      detailMask: 1,
      total: { total: 900, input: 900, cached: 0, output: 0, reasoning: 0 },
    }),
  ]);
  const unknownSnapshot = createShareCardData(unknown.summary, { periodComparison: unknown.periodComparison });
  assert.equal(unknownSnapshot.cacheHitRate, null);
  assert.equal(unknownSnapshot.totals.cached, null);
  assert.equal(unknownSnapshot.totals.uncached, null);
  assert.equal(unknownSnapshot.totals.output, null);
});

test("zero usage is distinct from unknown details, and stale period details are not reused", () => {
  const empty = dashboard([]);
  const snapshot = createShareCardData(empty.summary, { periodComparison: empty.periodComparison });
  assert.equal(snapshot.totals.total, 0);
  assert.equal(snapshot.totals.output, 0);
  assert.equal(snapshot.totals.uncached, 0);
  assert.equal(snapshot.cacheHitRate, null);
  assert.equal(snapshot.cost, null);

  const current = dashboard([event(100)]);
  const previous = dashboard([event(100)], { now: "2026-11-06T12:00:00.000Z" });
  assert.equal(
    createShareCardData(current.summary, { periodComparison: previous.periodComparison }).totals.uncached,
    null,
  );
  assert.equal(
    createShareCardData(current.summary, { periodComparison: empty.periodComparison }).totals.uncached,
    null,
  );
});

test("cost uses the same display currency and FX conversion as the homepage, preserving null versus zero", () => {
  const { summary } = dashboard([event(100)]);
  summary.costEstimate.totalUsd = 12;
  summary.costEstimate.totalCny = 35;
  assert.deepEqual(createShareCardData(summary, { currency: "USD", usdToCnyRate: 7 }).cost, {
    amount: 17,
    currency: "USD",
  });
  assert.deepEqual(createShareCardData(summary, { currency: "CNY", usdToCnyRate: 7 }).cost, {
    amount: 119,
    currency: "CNY",
  });
  summary.costEstimate.totalUsd = null;
  summary.costEstimate.totalCny = 0;
  assert.deepEqual(createShareCardData(summary, { currency: "CNY", usdToCnyRate: 7 }).cost, {
    amount: 0,
    currency: "CNY",
  });
  summary.costEstimate.totalCny = null;
  assert.equal(createShareCardData(summary).cost, null);
});

test("only the loaded today, week, and month selections are shareable", () => {
  for (const preset of ["today", "week", "month"]) {
    const { summary } = dashboard([event(100)], { preset });
    assert.equal(createShareCardData(summary, { preset }).period, preset);
  }
  const { summary } = dashboard([event(100)]);
  for (const preset of ["today", "month", "all", "custom", "recent", "quota_5h", "quota_week"]) {
    assert.equal(createShareCardData(summary, { preset }), null);
  }
  summary.range.preset = "all";
  assert.equal(createShareCardData(summary), null);
  assert.equal(createShareCardData(null), null);
});

test("filenames use captured inclusive calendar dates, including UTC and cross-year ranges", () => {
  const single = dashboard([event(100)], { preset: "today" });
  assert.equal(createShareCardData(single.summary).filename, "usage_20261113.png");
  const yearBoundary = dashboard([], { now: "2027-01-01T12:00:00.000Z" });
  assert.equal(createShareCardData(yearBoundary.summary).filename, "usage_20261228-20270101.png");
  const local = {
    start: new Date(2026, 10, 13, 0, 0, 0),
    end: new Date(2026, 10, 13, 23, 59, 59, 999),
    calendarZone: "local",
  };
  assert.equal(shareCardFilename(local), "usage_20261113.png");
  assert.equal(
    shareCardFilename({ start: "2026-11-12T16:00:00.000Z", end: "2026-11-13T15:59:59.999Z", calendarZone: "utc" }),
    "usage_20261112-20261113.png",
  );
  assert.equal(shareCardFilename({ start: null, end: "invalid" }), null);
});

test("real dashboard payloads preserve canonical model identities and match trusted period details", async () => {
  const fixture = createPricingPolicyFixture();
  const store = new UsageStore(fixture.options);
  try {
    await store.sync();
    for (const calendarZone of ["local", "utc"]) {
      for (const preset of ["today", "week", "month"]) {
        const payload = await store.dashboardHistory(
          { ...fixture.filters, now: new Date(fixture.filters.now), preset, calendarZone },
          { includeDetails: false },
        );
        const snapshot = createShareCardData(payload.summary, {
          preset,
          periodComparison: payload.periodComparison,
        });
        const period = payload.periodComparison.totals[preset];
        assert.equal(snapshot.range.calendarZone, calendarZone);
        assert.equal(snapshot.totals.total, preset === "today" ? 600 : 1200);
        assert.deepEqual(snapshot.models.map((row) => row.name).sort(), ["gemini-4-argon-contributor", "hy4free"]);
        assert.equal(snapshot.models.find((row) => row.name === "hy4free").total, snapshot.totals.total / 2);
        assert.equal(snapshot.totals.uncached, period.uncachedInput);
        assert.equal(snapshot.totals.uncached, preset === "today" ? 240 : 480);
        assert.equal(snapshot.unavailableTokens.uncached, preset === "today" ? 300 : 600);
        assert.equal(snapshot.cacheHitRate, 0);
      }
    }
  } finally {
    store.close();
    fixture.close();
  }
});
