import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";

import {
  buildTimelineRows,
  channelForRange,
  deriveTimelineBucket,
  generateQuotaTimelineSlots,
  homeSourceKinds,
  sourceGroup,
} from "../public/timeline-utils.js";
import { estimateCostForEvents, estimateEventCost } from "../src/pricing.js";

const dateAt = (year, month, day, hour = 0) => new Date(year, month - 1, day, hour);

test("product channel groups honor home evidence and preserve quota and custom channels", () => {
  for (const name of ["Codex Desktop", "Editor Integration", "CLI", "Codex Exec", "codex_work_desktop"]) {
    assert.equal(channelForRange(name, { preset: "month" }), "Codex");
    for (const quotaRange of [
      { preset: "quota_5h" },
      { preset: "quota_week" },
      { preset: "recent", quotaWindow: true, quotaPreset: "quota_week" },
    ]) {
      assert.equal(channelForRange(name, quotaRange, "main"), name);
    }
  }
  assert.equal(sourceGroup("ZCode Subagent"), "ZCode");
  assert.equal(sourceGroup("DSH Subagent"), "DSH");
  assert.equal(sourceGroup("unrecognized-client", "main"), "Codex");
  assert.equal(sourceGroup("CLI", "opencode"), "OpenCode");
  assert.equal(sourceGroup("custom-agent", "project-log"), "custom-agent");
  assert.equal(sourceGroup("Unknown"), "Unknown");
  assert.equal(homeSourceKinds([{ id: "one", kind: "dsh" }]).get("one"), "dsh");
});
const range = (preset, start, end) => ({ preset, start, end });

test("channel grouping deduplicates sessions and leaves original pricing events untouched", () => {
  const originals = [
    { timestamp: "2026-09-20T10:00:00Z", sessionId: "shared", channel: "Codex Desktop", total: { total: 10 } },
    { timestamp: "2026-09-20T10:00:00Z", sessionId: "shared", channel: "Codex Exec", total: { total: 20 } },
    { timestamp: "2026-09-20T10:00:00Z", sessionId: "custom", channel: "custom-agent", total: { total: 5 } },
  ];
  const observed = [];
  const rows = buildTimelineRows(originals, { calendarZone: "utc" }, "day", {
    estimateCost: (row) => {
      observed.push(row.channel);
      return null;
    },
  });
  assert.deepEqual(
    rows[0].channels.map((row) => [row.name, row.total.total, row.sessions]),
    [
      ["Codex", 30, 1],
      ["custom-agent", 5, 1],
    ],
  );
  assert.deepEqual(observed, ["Codex Desktop", "Codex Exec", "custom-agent"]);
  assert.equal(rows[0].total.total, 35);
});
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
  const rows = buildTimelineRows(
    [event(new Date(2026, 8, 23, 8).toISOString(), { total: 12, input: 10, cached: 2, output: 2 })],
    range("today", start, end),
    "hour",
  );
  assert.equal(rows.length, 24);
  assert.equal(rows[0].key, "2026-09-23 00:00");
  assert.equal(rows[23].key, "2026-09-23 23:00");
  assert.equal(rows[8].total.total, 12);
  assert.equal(rows[9].count, 0);
  assert.equal(rows[9].pricingStatus, "no-data");
  assert.equal(
    rows.reduce((sum, row) => sum + row.total.total, 0),
    12,
  );
});

test("week fills Monday through Sunday and leaves future days empty", () => {
  const start = dateAt(2026, 5, 4);
  const end = new Date(2026, 4, 5, 23, 59, 59, 999);
  const rows = buildTimelineRows(
    [
      event(new Date(2026, 4, 4, 10).toISOString(), { total: 5 }),
      event(new Date(2026, 4, 5, 10).toISOString(), { total: 7 }),
    ],
    range("week", start, end),
    "day",
  );
  assert.equal(rows.length, 7);
  assert.deepEqual(
    rows.map((row) => row.key),
    ["2026-05-04", "2026-05-05", "2026-05-06", "2026-05-07", "2026-05-08", "2026-05-09", "2026-05-10"],
  );
  assert.deepEqual(
    rows.map((row) => row.total.total),
    [5, 7, 0, 0, 0, 0, 0],
  );
  assert.equal(
    rows.reduce((sum, row) => sum + row.total.total, 0),
    12,
  );
});

test("month fills every day, including leap February and 30/31-day month ends", () => {
  for (const [year, month, days] of [
    [2024, 2, 29],
    [2026, 4, 30],
    [2026, 1, 31],
  ]) {
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
  assert.deepEqual(
    rows.map((row) => row.key),
    ["2025-12-31", "2026-01-01", "2026-01-02"],
  );
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
    "2025-03-03",
    "2025-03-04",
    "2025-03-05",
    "2025-03-06",
    "2025-03-07",
    "2025-03-08",
    "2025-03-09",
  ]);
});

test("each slot preserves channel/model token totals and aggregates event-level costs", () => {
  const first = event("2026-07-01T10:00:00", { total: 110, input: 100, cached: 20, output: 10 }, "gpt-6-sol", {
    detailMask: 15,
    cacheWriteTokens: 10,
    cacheWriteKnown: true,
    contextLevel: "short",
    serviceTier: "standard",
  });
  const second = event("2026-07-01T11:00:00", { total: 110, input: 100, cached: 0, output: 10 }, "gpt-6-luna", {
    detailMask: 15,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    contextLevel: "short",
    serviceTier: "standard",
  });
  const unpriced = event("2026-07-01T12:00:00", { total: 10, input: 10, cached: 0, output: 0 }, "custom-model", {
    detailMask: 15,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    contextLevel: "short",
    serviceTier: "standard",
  });
  const events = [first, second, unpriced];
  const rows = buildTimelineRows(events, {}, "day", { estimateCost: estimateEventCost });
  const expected = estimateCostForEvents(events);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.total.total, 230);
  assert.equal(
    row.channels.reduce((sum, channel) => sum + channel.total.total, 0),
    row.total.total,
  );
  assert.equal(
    row.models.reduce((sum, model) => sum + model.total.total, 0),
    row.total.total,
  );
  assert.equal(
    Object.values(row.costByModel).reduce((sum, model) => sum + model.totalUsd, 0),
    expected.totalUsd,
  );
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
  const rows = buildTimelineRows(
    [
      event(new Date(startMs).toISOString(), { total: 5 }),
      event(new Date(startMs + 30 * 60 * 1000).toISOString(), { total: 7 }),
      event(new Date(asOfMs).toISOString(), { total: 11 }),
      event(new Date(endMs).toISOString(), { total: 13 }),
      event(new Date(startMs - 1).toISOString(), { total: 17 }),
    ],
    range,
    "quota_30m",
    { estimateCost: (item) => ({ totalUsd: item.total.total / 10, currency: "USD" }) },
  );

  assert.equal(rows.length, 10);
  assert.deepEqual(
    rows.slice(0, 2).map((row) => [row.slotStartMs, row.total.total]),
    [
      [startMs, 5],
      [startMs + 30 * 60 * 1000, 7],
    ],
  );
  assert.equal(rows[0].slotEndExclusiveMs, startMs + 30 * 60 * 1000);
  assert.equal(rows[2].future, true);
  assert.equal(rows[2].total.total, 0);
  assert.deepEqual(rows[2].channels, []);
  assert.deepEqual(rows[2].models, []);
  assert.deepEqual(rows[2].costByModel, {});
  assert.equal(
    rows.reduce((sum, row) => sum + row.total.total, 0),
    12,
  );
});

test("quota_24h uses seven Unix-time days across a daylight-saving transition", () => {
  const startMs = Date.parse("2025-03-08T19:20:00.000Z");
  const asOfMs = startMs + 24 * 60 * 60 * 1000 + 1_000;
  const slots = generateQuotaTimelineSlots(
    {
      preset: "quota_week",
      start: new Date(startMs),
      windowStart: new Date(startMs),
      windowEndExclusive: new Date(startMs + 7 * 24 * 60 * 60 * 1000),
      asOf: new Date(asOfMs),
    },
    "quota_24h",
  );
  const rows = buildTimelineRows(
    [
      event(new Date(startMs + 24 * 60 * 60 * 1000 - 1).toISOString(), { total: 10 }),
      event(new Date(startMs + 24 * 60 * 60 * 1000).toISOString(), { total: 20 }),
      event(new Date(asOfMs).toISOString(), { total: 30 }),
    ],
    {
      preset: "quota_week",
      start: new Date(startMs),
      end: new Date(asOfMs - 1),
      windowStart: new Date(startMs),
      windowEndExclusive: new Date(startMs + 7 * 24 * 60 * 60 * 1000),
      asOf: new Date(asOfMs),
    },
    "quota_24h",
  );

  assert.equal(slots.length, 7);
  assert.ok(slots.every((slot, index) => slot.slotStartMs === startMs + index * 24 * 60 * 60 * 1000));
  assert.equal(rows[0].total.total, 10);
  assert.equal(rows[1].total.total, 20);
  assert.equal(rows[2].future, true);
});

test("deriveTimelineBucket keeps explicit non-day buckets pinned regardless of span", () => {
  const long = range("all", dateAt(2020, 1, 1), new Date(2026, 8, 27, 23, 59, 59, 999));
  assert.equal(deriveTimelineBucket(long, "hour"), "hour");
  assert.equal(deriveTimelineBucket(long, "week"), "week");
  assert.equal(deriveTimelineBucket(long, "month"), "month");
  assert.equal(deriveTimelineBucket(long, "quota_30m"), "quota_30m");
  assert.equal(deriveTimelineBucket(long, "quota_24h"), "quota_24h");
});

test("deriveTimelineBucket keeps day and week bucket counts within 31 slots", () => {
  const span = (days) => range("all", dateAt(2026, 1, 1), new Date(2026, 0, days, 23, 59, 59, 999));
  assert.equal(deriveTimelineBucket(span(31), "day"), "day");
  assert.equal(deriveTimelineBucket(span(32), "day"), "week");
  assert.equal(deriveTimelineBucket(span(214), "day"), "week");
  assert.equal(deriveTimelineBucket(span(215), "day"), "month");
  assert.equal(deriveTimelineBucket(span(217), "day"), "month");
  assert.equal(deriveTimelineBucket(span(218), "day"), "month");
  const mondaySpan = (days) => range("all", dateAt(2026, 1, 5), new Date(2026, 0, 4 + days, 23, 59, 59, 999));
  assert.equal(deriveTimelineBucket(mondaySpan(217), "day"), "week");
  assert.equal(buildTimelineRows([], mondaySpan(217), "week").length, 31);
  // 半年（1 月 1 日至 7 月 2 日，183 天）落在周档。
  assert.equal(deriveTimelineBucket(span(183), "day"), "week");
});

test("deriveTimelineBucket falls back to day when the range has no usable bounds", () => {
  assert.equal(deriveTimelineBucket({}, "day"), "day");
  assert.equal(deriveTimelineBucket(range("all", null, null), "day"), "day");
  assert.equal(deriveTimelineBucket(range("custom", dateAt(2026, 1, 1), null), "day"), "day");
});

test("deriveTimelineBucket honors the calendar zone when counting span days", () => {
  const utc = { preset: "all", start: "2026-01-01T00:00:00Z", end: "2026-02-15T23:59:59.999Z", calendarZone: "utc" };
  assert.equal(deriveTimelineBucket(utc, "day"), "week");
  const local = { preset: "all", start: "2026-01-01T00:00:00", end: "2026-02-15T23:59:59.999" };
  assert.equal(deriveTimelineBucket(local, "day"), "week");
});

test("buildTimelineRows with a derived week bucket merges half a year into Monday-keyed weeks", () => {
  const rows = buildTimelineRows(
    [
      event("2026-03-15T10:00:00.000Z", { total: 40, input: 30, cached: 0, output: 10 }),
      event("2026-09-01T10:00:00.000Z", { total: 80, input: 60, cached: 0, output: 20 }),
    ],
    range("all", dateAt(2026, 3, 15), new Date(2026, 8, 1, 23, 59, 59, 999)),
    "week",
  );
  assert.equal(rows.length, 26);
  assert.equal(rows[0].key, "2026-03-09");
  assert.equal(rows.at(-1).key, "2026-08-31");
  assert.equal(rows[0].total.total, 40);
  assert.equal(rows.at(-1).total.total, 80);
  assert.ok(rows.slice(1, -1).every((row) => row.total.total === 0));
});
