import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";

import { buildTimelineRows, generateQuotaTimelineSlots } from "../public/timeline-utils.js";
import { estimateCostForEvents, estimateEventCost } from "../src/pricing.js";

const dateAt = (year, month, day, hour = 0) => new Date(year, month - 1, day, hour);
const range = (preset, start, end) => ({ preset, start, end });
const event = (timestamp, total, model = "gpt-6-sol", extra = {}) => ({
  timestamp,
  sessionId: `session-${timestamp}`,
  channel: "CLI",
  model,
  total,
  ...extra,
});

test("today fills 24 local hour slots without adding future usage to totals", () => {
  const start = dateAt(2026, 9, 23);
  const end = new Date(2026, 8, 23, 23, 59, 59, 999);
  const rows = buildTimelineRows([
    event(new Date(2026, 8, 23, 8).toISOString(), { total: 12, input: 10, cached: 2, output: 2 }),
  ], range("today", start, end), "hour");
  assert.equal(rows.length, 24);
  assert.equal(rows[0].key, "2026-09-23 00:00");
  assert.equal(rows[23].key, "2026-09-23 23:00");
  assert.equal(rows[8].total.total, 12);
  assert.equal(rows[9].count, 0);
  assert.equal(rows[9].pricingStatus, "no-data");
  assert.equal(rows.reduce((sum, row) => sum + row.total.total, 0), 12);
});

test("week fills Monday through Sunday and leaves future days empty", () => {
  const start = dateAt(2026, 5, 4);
  const end = new Date(2026, 4, 5, 23, 59, 59, 999);
  const rows = buildTimelineRows([
    event(new Date(2026, 4, 4, 10).toISOString(), { total: 5 }),
    event(new Date(2026, 4, 5, 10).toISOString(), { total: 7 }),
  ], range("week", start, end), "day");
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.map((row) => row.key), [
    "2026-05-04", "2026-05-05", "2026-05-06", "2026-05-07", "2026-05-08", "2026-05-09", "2026-05-10",
  ]);
  assert.deepEqual(rows.map((row) => row.total.total), [5, 7, 0, 0, 0, 0, 0]);
  assert.equal(rows.reduce((sum, row) => sum + row.total.total, 0), 12);
});

test("month fills every day, including leap February and 30/31-day month ends", () => {
  for (const [year, month, days] of [[2024, 2, 29], [2026, 4, 30], [2026, 1, 31]]) {
    const start = dateAt(year, month, 1);
    const end = dateAt(year, month, 12);
    const rows = buildTimelineRows([], range("month", start, end), "day");
    assert.equal(rows.length, days);
    assert.equal(rows[0].key, `${year}-${String(month).padStart(2, "0")}-01`);
    assert.equal(rows.at(-1).key, `${year}-${String(month).padStart(2, "0")}-${String(days).padStart(2, "0")}`);
    assert.ok(rows.every((row) => row.pricingStatus === "no-data"));
  }
});

test("custom daily ranges fill only their own dates, including cross-year boundaries", () => {
  const rows = buildTimelineRows([], range("custom", dateAt(2025, 12, 31), dateAt(2026, 1, 2)), "day");
  assert.deepEqual(rows.map((row) => row.key), ["2025-12-31", "2026-01-01", "2026-01-02"]);
});

test("daily slots use local calendar arithmetic across daylight-saving transitions", () => {
  const script = `
    import { buildTimelineRows } from ${JSON.stringify(new URL("../public/timeline-utils.js", import.meta.url).href)};
    const range = { preset: "week", start: new Date(2025, 2, 3).toISOString(), end: new Date(2025, 2, 9, 23, 59, 59, 999).toISOString() };
    const keys = buildTimelineRows([], range, "day").map(row => row.key);
    process.stdout.write(JSON.stringify(keys));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, TZ: "America/New_York" },
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [
    "2025-03-03", "2025-03-04", "2025-03-05", "2025-03-06", "2025-03-07", "2025-03-08", "2025-03-09",
  ]);
});

test("each slot preserves channel/model token totals and aggregates event-level costs", () => {
  const first = event("2026-07-01T10:00:00", { total: 110, input: 100, cached: 20, output: 10 }, "gpt-6-sol", {
    detailMask: 15, cacheWriteTokens: 10, cacheWriteKnown: true, contextLevel: "short", serviceTier: "standard",
  });
  const second = event("2026-07-01T11:00:00", { total: 110, input: 100, cached: 0, output: 10 }, "gpt-6-luna", {
    detailMask: 15, cacheWriteTokens: 0, cacheWriteKnown: true, contextLevel: "short", serviceTier: "standard",
  });
  const unpriced = event("2026-07-01T12:00:00", { total: 10, input: 10, cached: 0, output: 0 }, "custom-model", {
    detailMask: 15, cacheWriteTokens: 0, cacheWriteKnown: true, contextLevel: "short", serviceTier: "standard",
  });
  const events = [first, second, unpriced];
  const rows = buildTimelineRows(events, {}, "day", { estimateCost: estimateEventCost });
  const expected = estimateCostForEvents(events);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.total.total, 230);
  assert.equal(row.channels.reduce((sum, channel) => sum + channel.total.total, 0), row.total.total);
  assert.equal(row.models.reduce((sum, model) => sum + model.total.total, 0), row.total.total);
  assert.equal(Object.values(row.costByModel).reduce((sum, model) => sum + model.totalUsd, 0), expected.totalUsd);
  assert.equal(row.unpricedTokens, 0);
  assert.equal(row.minimumEstimatedTokens, 10);
  assert.equal(row.pricingStatus, "minimum-estimate");
  assert.equal(row.costByModel["custom-model"].pricingStatus, "minimum-estimate");
});

test("quota_30m uses ten fixed half-hour slots and excludes future and boundary events", () => {
  const startMs = Date.parse("2026-09-25T23:37:00.000Z");
  const asOfMs = Date.parse("2026-09-26T00:20:00.000Z");
  const endMs = startMs + 5 * 60 * 60 * 1000;
  const range = {
    preset: "quota_5h",
    start: new Date(startMs),
    end: new Date(asOfMs - 1),
    windowStart: new Date(startMs),
    windowEndExclusive: new Date(endMs),
    asOf: new Date(asOfMs),
  };
  const rows = buildTimelineRows([
    event(new Date(startMs).toISOString(), { total: 5 }),
    event(new Date(startMs + 30 * 60 * 1000).toISOString(), { total: 7 }),
    event(new Date(asOfMs).toISOString(), { total: 11 }),
    event(new Date(endMs).toISOString(), { total: 13 }),
    event(new Date(startMs - 1).toISOString(), { total: 17 }),
  ], range, "quota_30m", { estimateCost: (item) => ({ totalUsd: item.total.total / 10, currency: "USD" }) });

  assert.equal(rows.length, 10);
  assert.deepEqual(rows.slice(0, 2).map((row) => [row.slotStartMs, row.total.total]), [
    [startMs, 5], [startMs + 30 * 60 * 1000, 7],
  ]);
  assert.equal(rows[0].slotEndExclusiveMs, startMs + 30 * 60 * 1000);
  assert.equal(rows[2].future, true);
  assert.equal(rows[2].total.total, 0);
  assert.deepEqual(rows[2].channels, []);
  assert.deepEqual(rows[2].models, []);
  assert.deepEqual(rows[2].costByModel, {});
  assert.equal(rows.reduce((sum, row) => sum + row.total.total, 0), 12);
});

test("quota_24h uses seven Unix-time days across a daylight-saving transition", () => {
  const startMs = Date.parse("2025-03-08T19:20:00.000Z");
  const asOfMs = startMs + 24 * 60 * 60 * 1000 + 1_000;
  const slots = generateQuotaTimelineSlots({
    preset: "quota_week",
    start: new Date(startMs),
    windowStart: new Date(startMs),
    windowEndExclusive: new Date(startMs + 7 * 24 * 60 * 60 * 1000),
    asOf: new Date(asOfMs),
  }, "quota_24h");
  const rows = buildTimelineRows([
    event(new Date(startMs + 24 * 60 * 60 * 1000 - 1).toISOString(), { total: 10 }),
    event(new Date(startMs + 24 * 60 * 60 * 1000).toISOString(), { total: 20 }),
    event(new Date(asOfMs).toISOString(), { total: 30 }),
  ], {
    preset: "quota_week",
    start: new Date(startMs),
    end: new Date(asOfMs - 1),
    windowStart: new Date(startMs),
    windowEndExclusive: new Date(startMs + 7 * 24 * 60 * 60 * 1000),
    asOf: new Date(asOfMs),
  }, "quota_24h");

  assert.equal(slots.length, 7);
  assert.ok(slots.every((slot, index) => slot.slotStartMs === startMs + index * 24 * 60 * 60 * 1000));
  assert.equal(rows[0].total.total, 10);
  assert.equal(rows[1].total.total, 20);
  assert.equal(rows[2].future, true);
});
