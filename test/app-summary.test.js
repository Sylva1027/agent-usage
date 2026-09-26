import assert from "node:assert/strict";
import test from "node:test";

import {
  formatTimelineTooltip,
  nextQuotaPresetState,
  nextPresetState,
  nextRecentState,
  normalizeRecentValue,
  rangeLabel,
  setSummaryFilters,
  summarize,
  timelineChannelSegments,
} from "../public/app.js";
import { API_PRICING_CHECKED_AT, API_PRICING_MODE, estimateEventCost } from "../src/pricing.js";
import { selectQuotaWindows } from "../src/usage-core.js";

test("summarize includes channel breakdowns for timeline buckets", () => {
  setSummaryFilters({ preset: "all", bucket: "day", now: null, startDate: "", endDate: "" });
  try {
    const summary = summarize({
      events: [
        {
          timestamp: "2026-05-26T01:00:00.000Z",
          sessionId: "desktop-1",
          channel: "Codex Desktop",
          total: { total: 200, input: 170, cached: 50, output: 30, reasoning: 5 },
        },
        {
          timestamp: "2026-05-26T02:00:00.000Z",
          sessionId: "cli-1",
          channel: "CLI",
          total: { total: 100, input: 80, cached: 20, output: 20, reasoning: 2 },
        },
      ],
    });

    assert.deepEqual(
      summary.timeline[0].channels.map((channel) => [channel.name, channel.total.total]),
      [
        ["Codex Desktop", 200],
        ["CLI", 100],
      ],
    );
  } finally {
    setSummaryFilters({ preset: "today", bucket: "hour", now: null, startDate: "", endDate: "" });
  }
});

test("summarize fills a single local day with 24 hourly timeline rows", () => {
  // Single-day hourly views need empty rows so the chart spans midnight through 24:00.
  setSummaryFilters({
    preset: "all",
    bucket: "hour",
    now: null,
    startDate: "",
    endDate: "",
  });

  try {
    const summary = summarize({
      events: [
        {
          timestamp: "2026-05-26T01:15:00",
          sessionId: "first",
          channel: "CLI",
          total: { total: 100, input: 100, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-05-26T01:45:00",
          sessionId: "second",
          channel: "CLI",
          total: { total: 200, input: 200, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-05-26T02:05:00",
          sessionId: "third",
          channel: "CLI",
          total: { total: 300, input: 300, cached: 0, output: 0, reasoning: 0 },
        },
      ],
    });

    assert.deepEqual(
      [summary.timeline[0], summary.timeline[1], summary.timeline[2], summary.timeline[23]].map((row) => [
        row.key,
        row.total.total,
      ]),
      [
        ["2026-05-26 00:00", 0],
        ["2026-05-26 01:00", 300],
        ["2026-05-26 02:00", 300],
        ["2026-05-26 23:00", 0],
      ],
    );
    assert.equal(summary.timeline.length, 24);
    assert.equal(rangeLabel(summary), "2026-05-26 至 2026-05-26");
  } finally {
    setSummaryFilters({
      preset: "all",
      recentValue: "1个月",
      bucket: "day",
      now: null,
      startDate: "",
      endDate: "",
    });
  }
});

test("static quota summary stays at export asOf and applies source exclusions to embedded events", () => {
  const asOf = "2026-09-25T12:00:00.000Z";
  const start = "2026-09-25T09:37:00.000Z";
  const end = "2026-09-25T14:37:00.000Z";
  const quota = selectQuotaWindows([{
    sourcePath: "codex.jsonl",
    lineNumber: 4,
    role: "primary",
    observedAtMs: Date.parse("2026-09-25T11:59:00.000Z"),
    limitId: "codex",
    windowMinutes: 300,
    resetsAtMs: Date.parse(end),
    usedPercent: null,
  }], asOf);
  const events = [
    { timestamp: start, sessionId: "included", homeId: "keep", channel: "CLI", total: { total: 5 } },
    { timestamp: "2026-09-25T10:07:00.000Z", sessionId: "excluded", homeId: "drop", channel: "ZCode", total: { total: 7 } },
    { timestamp: asOf, sessionId: "at-as-of", homeId: "keep", channel: "CLI", total: { total: 11 } },
  ];

  setSummaryFilters({ preset: "quota_5h", bucket: "month", now: asOf, excludedHomes: ["drop"] });
  try {
    const summary = summarize({ asOf, generatedAt: asOf, quota, events });
    assert.equal(summary.range.bucket, "quota_30m");
    assert.equal(summary.range.windowStart.toISOString(), start);
    assert.equal(summary.range.windowEndExclusive.toISOString(), end);
    assert.equal(summary.totals.total, 5);
    assert.equal(summary.comparison, null);
    assert.equal(summary.timeline.length, 10);
    assert.equal(summary.timeline[0].total.total, 5);
    assert.ok(summary.timeline.slice(5).every((row) => row.future));
  } finally {
    setSummaryFilters({ preset: "today", bucket: "hour", now: null, excludedHomes: [], startDate: "", endDate: "" });
  }
});

test("static summarize totals embedded API cost estimates for the selected events", () => {
  const costEvent = {
    timestamp: "2026-05-26T01:00:00.000Z",
    sessionId: "cost-session",
    channel: "CLI",
    model: "gpt-6-sol",
    detailMask: 15,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    contextLevel: "short",
    serviceTier: "standard",
    total: { total: 110, input: 100, cached: 20, output: 10, reasoning: 4 },
  };
  costEvent.costEstimate = estimateEventCost(costEvent);

  setSummaryFilters({ preset: "all", bucket: "day", now: null, startDate: "", endDate: "" });
  try {
    const summary = summarize({
      pricing: { checkedAt: API_PRICING_CHECKED_AT, mode: API_PRICING_MODE },
      events: [costEvent],
    });

    assert.equal(summary.costEstimate.totalUsd, 0.000264);
    assert.equal(summary.costEstimate.inputUsd, 0.00016);
    assert.equal(summary.costEstimate.cachedInputUsd, 0.000004);
    assert.equal(summary.costEstimate.outputUsd, 0.0001);
    assert.equal(summary.costEstimate.cacheHitRate, 0.2);
    assert.equal(summary.costEstimate.modelCount, 1);
    assert.equal(summary.costEstimate.priceCheckedAt, API_PRICING_CHECKED_AT);
    assert.equal(summary.timeline.reduce((sum, row) => sum + Object.values(row.costByModel).reduce((subtotal, model) => subtotal + model.totalUsd, 0), 0), summary.costEstimate.totalUsd);
  } finally {
    setSummaryFilters({ preset: "all", bucket: "day", now: null, startDate: "", endDate: "" });
  }
});

test("today preset defaults the next dashboard bucket to hour", () => {
  // Range presets reset to their default granularity so stale manual bucket choices do not leak.
  assert.deepEqual(nextPresetState({ bucket: "month" }, "today"), { preset: "today", bucket: "hour" });
  assert.deepEqual(nextPresetState({ bucket: "hour" }, "week"), { preset: "week", bucket: "day" });
  assert.deepEqual(nextPresetState({ bucket: "hour" }, "month"), { preset: "month", bucket: "day" });
  assert.deepEqual(nextPresetState({ bucket: "hour" }, "all"), { preset: "all", bucket: "day" });
  assert.deepEqual(nextPresetState({ bucket: "hour" }, "custom"), { preset: "custom", bucket: "day" });
});

test("quota preset toggle remembers the last mode independently of availability", () => {
  const bothAvailable = {
    windows: {
      quota_5h: { state: "available" },
      quota_week: { state: "available" },
    },
  };
  const onlyWeekAvailable = {
    windows: {
      quota_5h: { state: "waiting", reason: "等待新的限额记录" },
      quota_week: { state: "available" },
    },
  };
  const restored = nextQuotaPresetState({ preset: "today", lastQuotaPreset: "quota_week" }, bothAvailable);
  assert.equal(restored.preset, "quota_week");
  assert.equal(restored.bucket, "quota_24h");

  const retained = nextQuotaPresetState({ preset: "today", lastQuotaPreset: "quota_5h" }, onlyWeekAvailable);
  assert.equal(retained.preset, "quota_5h");
  assert.equal(nextQuotaPresetState({ preset: "quota_5h" }, onlyWeekAvailable).preset, "quota_week");
  assert.equal(nextQuotaPresetState({ preset: "quota_week" }, onlyWeekAvailable).preset, "quota_5h");

  const bothUnavailable = nextQuotaPresetState({ preset: "today", lastQuotaPreset: "quota_5h" }, {
    windows: {
      quota_5h: { state: "missing", reason: "无 5h 快照" },
      quota_week: { state: "missing", reason: "无 Week 快照" },
    },
  });
  assert.equal(bothUnavailable.changed, true);
  assert.equal(bothUnavailable.preset, "quota_5h");
  assert.equal(bothUnavailable.reason, "");
  assert.deepEqual(nextPresetState({ preset: "quota_week", bucket: "quota_24h" }, "today"), {
    preset: "today",
    bucket: "hour",
    lastQuotaPreset: "quota_week",
  });
});

test("quota headings show local window boundaries and tooltip intervals include timezone", () => {
  const start = new Date(2026, 8, 25, 22, 0, 0);
  const fiveHourEnd = new Date(2026, 8, 26, 3, 0, 0);
  const fiveHour = {
    range: {
      preset: "quota_5h",
      quotaState: "available",
      windowStart: start,
      windowEndExclusive: fiveHourEnd,
      asOf: new Date(2026, 8, 25, 22, 15, 0),
    },
  };
  assert.equal(rangeLabel(fiveHour), "09-25 22:00–09-26 03:00");
  const sameDayFiveHour = {
    range: {
      ...fiveHour.range,
      windowStart: new Date(2026, 8, 25, 10, 0, 0),
      windowEndExclusive: new Date(2026, 8, 25, 15, 0, 0),
    },
  };
  assert.equal(rangeLabel(sameDayFiveHour), "09-25 10:00–15:00");

  const weekStart = new Date(2026, 8, 21, 10, 0, 0);
  const weekEnd = new Date(2026, 8, 28, 10, 0, 0);
  assert.equal(rangeLabel({ range: {
    preset: "quota_week",
    quotaState: "available",
    windowStart: weekStart,
    windowEndExclusive: weekEnd,
  } }), `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, "0")}-${String(weekStart.getDate()).padStart(2, "0")} 至 ${weekEnd.getFullYear()}-${String(weekEnd.getMonth() + 1).padStart(2, "0")}-${String(weekEnd.getDate()).padStart(2, "0")}`);

  const partialAsOf = new Date(weekStart.getTime() + 30 * 60 * 1000);
  setSummaryFilters({ preset: "quota_week", quotaSnapshot: { asOf: partialAsOf.toISOString() }, summary: null, report: null });
  try {
    const startMs = weekStart.getTime();
    const tooltip = formatTimelineTooltip({
      key: String(startMs),
      slotStartMs: startMs,
      slotEndExclusiveMs: startMs + 24 * 60 * 60 * 1000,
      name: weekStart.toISOString(),
      total: { total: 1 },
      channels: [],
    }, "channel");
    assert.match(tooltip, /时间槽区间 \[2026-/);
    assert.match(tooltip, /Asia|UTC/);
    assert.match(tooltip, /连续 24 小时/);
    assert.match(tooltip, /当前时间槽仅统计至/);
  } finally {
    setSummaryFilters({ preset: "all", bucket: "day", now: null, startDate: "", endDate: "", quotaSnapshot: null, summary: null, report: null });
  }
});

test("recent one-day range defaults to hour and longer recent ranges default to day", () => {
  // Recent values use the normalized text so manual "1" behaves the same as selecting "1天".
  assert.deepEqual(nextRecentState({ bucket: "day" }, "1天"), {
    preset: "recent",
    recentValue: "1天",
    bucket: "hour",
  });
  assert.deepEqual(nextRecentState({ bucket: "day" }, "1"), {
    preset: "recent",
    recentValue: "1天",
    bucket: "hour",
  });
  assert.deepEqual(nextRecentState({ bucket: "hour" }, "1周"), {
    preset: "recent",
    recentValue: "1周",
    bucket: "day",
  });
  assert.deepEqual(nextRecentState({ bucket: "hour" }, "1个月"), {
    preset: "recent",
    recentValue: "1个月",
    bucket: "day",
  });
});

test("summarize filters recent natural-day month ranges", () => {
  setSummaryFilters({
    preset: "recent",
    recentValue: "1个月",
    bucket: "day",
    now: "2026-06-03T12:00:00",
  });

  try {
    const summary = summarize({
      events: [
        {
          timestamp: "2026-05-02T12:00:00",
          sessionId: "old",
          channel: "CLI",
          total: { total: 100, input: 100, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-05-03T00:00:00",
          sessionId: "boundary",
          channel: "CLI",
          total: { total: 200, input: 200, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-06-03T12:00:00",
          sessionId: "current",
          channel: "CLI",
          total: { total: 300, input: 300, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-06-03T23:59:59",
          sessionId: "same-day-late",
          channel: "CLI",
          total: { total: 400, input: 400, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-06-04T00:00:00",
          sessionId: "next-day",
          channel: "CLI",
          total: { total: 500, input: 500, cached: 0, output: 0, reasoning: 0 },
        },
      ],
    });

    assert.equal(summary.totals.total, 900);
  } finally {
    setSummaryFilters({
      preset: "all",
      recentValue: "1个月",
      bucket: "day",
      now: null,
      startDate: "",
      endDate: "",
    });
  }
});

test("summarize fills recent two-day hourly ranges on natural-day boundaries", () => {
  setSummaryFilters({
    preset: "recent",
    recentValue: "2天",
    bucket: "hour",
    now: "2026-06-23T10:45:00",
  });

  try {
    const summary = summarize({
      events: [
        {
          timestamp: "2026-06-21T23:59:59",
          sessionId: "old",
          channel: "CLI",
          total: { total: 100, input: 100, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-06-22T00:00:00",
          sessionId: "start",
          channel: "CLI",
          total: { total: 200, input: 200, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-06-23T23:59:59",
          sessionId: "end",
          channel: "CLI",
          total: { total: 300, input: 300, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-06-24T00:00:00",
          sessionId: "next-day",
          channel: "CLI",
          total: { total: 400, input: 400, cached: 0, output: 0, reasoning: 0 },
        },
      ],
    });

    assert.equal(summary.totals.total, 500);
    assert.equal(summary.timeline[0].key, "2026-06-22 00:00");
    assert.equal(summary.timeline.at(-1).key, "2026-06-23 23:00");
    assert.equal(summary.timeline.length, 48);
    assert.equal(rangeLabel(summary), "2026-06-22 至 2026-06-23");
  } finally {
    setSummaryFilters({
      preset: "all",
      recentValue: "1个月",
      bucket: "day",
      now: null,
      startDate: "",
      endDate: "",
    });
  }
});

test("summarize uses rolling recent day ranges", () => {
  setSummaryFilters({
    preset: "recent",
    recentValue: "1天",
    bucket: "hour",
    now: "2026-06-23T10:45:00",
  });

  try {
    const summary = summarize({
      events: [
        {
          timestamp: "2026-06-22T10:44:59",
          sessionId: "old",
          channel: "CLI",
          total: { total: 100, input: 100, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-06-22T10:45:00",
          sessionId: "start",
          channel: "CLI",
          total: { total: 200, input: 200, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-06-23T10:45:00",
          sessionId: "end",
          channel: "CLI",
          total: { total: 300, input: 300, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-06-23T10:45:01",
          sessionId: "future",
          channel: "CLI",
          total: { total: 400, input: 400, cached: 0, output: 0, reasoning: 0 },
        },
      ],
    });

    assert.equal(summary.totals.total, 500);
    assert.equal(summary.timeline[0].key, "2026-06-22 10:00");
    assert.equal(summary.timeline.at(-1).key, "2026-06-23 10:00");
    assert.equal(summary.timeline.length, 25);
    assert.equal(rangeLabel(summary), "2026-06-22 至 2026-06-23");
  } finally {
    setSummaryFilters({
      preset: "all",
      recentValue: "1个月",
      bucket: "day",
      now: null,
      startDate: "",
      endDate: "",
    });
  }
});

test("summarize includes previous-period comparison totals", () => {
  setSummaryFilters({
    preset: "today",
    bucket: "day",
    now: "2026-06-03T12:00:00",
  });

  try {
    const summary = summarize({
      events: [
        {
          timestamp: "2026-06-02T09:00:00",
          sessionId: "previous",
          channel: "CLI",
          total: { total: 100, input: 100, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-06-03T09:00:00",
          sessionId: "current",
          channel: "CLI",
          total: { total: 300, input: 300, cached: 0, output: 0, reasoning: 0 },
        },
      ],
    });

    assert.equal(summary.comparison.previousTotals.total, 100);
    assert.equal(summary.comparison.totalDelta, 200);
    assert.equal(summary.comparison.percentChange, 200);
    assert.equal(summary.comparison.averageBaselineTotal, 50);
    assert.equal(summary.comparison.averageDelta, 250);
    assert.equal(summary.comparison.averagePercentChange, 500);
  } finally {
    setSummaryFilters({
      preset: "all",
      recentValue: "1个月",
      bucket: "day",
      now: null,
      startDate: "",
      endDate: "",
    });
  }
});

test("summarize compares week preset with the full previous natural week", () => {
  setSummaryFilters({
    preset: "week",
    bucket: "day",
    now: "2026-06-22T12:00:00",
  });

  try {
    const summary = summarize({
      events: [
        {
          timestamp: "2026-06-15T09:00:00",
          sessionId: "previous-a",
          channel: "CLI",
          total: { total: 500, input: 500, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-06-21T09:00:00",
          sessionId: "previous-b",
          channel: "CLI",
          total: { total: 200, input: 200, cached: 0, output: 0, reasoning: 0 },
        },
        {
          timestamp: "2026-06-22T09:00:00",
          sessionId: "current",
          channel: "CLI",
          total: { total: 300, input: 300, cached: 0, output: 0, reasoning: 0 },
        },
      ],
    });

    assert.equal(summary.totals.total, 300);
    assert.equal(summary.comparison.previousTotals.total, 700);
    assert.equal(summary.comparison.totalDelta, -400);
    assert.equal(summary.comparison.percentChange, -57.14);
    assert.equal(summary.comparison.averageBaselineTotal, 50);
    assert.equal(summary.comparison.averageDelta, 250);
    assert.equal(summary.comparison.averagePercentChange, 500);
  } finally {
    setSummaryFilters({
      preset: "all",
      recentValue: "1个月",
      bucket: "day",
      now: null,
      startDate: "",
      endDate: "",
    });
  }
});

test("normalizeRecentValue defaults bare numbers to days", () => {
  assert.equal(normalizeRecentValue("7"), "7天");
  assert.equal(normalizeRecentValue(" 14 "), "14天");
  assert.equal(normalizeRecentValue("1个月"), "1个月");
  assert.equal(normalizeRecentValue("半年"), "半年");
});

test("timelineChannelSegments follows global channel order", () => {
  const segments = timelineChannelSegments(
    {
      channels: [
        { name: "CLI", total: { total: 100 } },
        { name: "Codex Desktop", total: { total: 200 } },
      ],
    },
    [{ name: "Codex Desktop" }, { name: "CLI" }],
  );

  assert.deepEqual(
    segments.map((segment) => segment.name),
    ["Codex Desktop", "CLI"],
  );
});

test("natural week and month slots include future positions without changing range totals", () => {
  const events = [
    { timestamp: "2026-05-04T12:00:00", sessionId: "mon", channel: "CLI", total: { total: 100, input: 100, cached: 0, output: 0 } },
    { timestamp: "2026-05-05T12:00:00", sessionId: "tue", channel: "CLI", total: { total: 200, input: 200, cached: 0, output: 0 } },
    { timestamp: "2026-05-06T12:00:00", sessionId: "future-week", channel: "CLI", total: { total: 300, input: 300, cached: 0, output: 0 } },
    { timestamp: "2026-05-31T12:00:00", sessionId: "future-month", channel: "CLI", total: { total: 400, input: 400, cached: 0, output: 0 } },
  ];
  try {
    setSummaryFilters({ preset: "week", bucket: "day", now: "2026-05-05T13:00:00", startDate: "", endDate: "" });
    const week = summarize({ events });
    assert.equal(week.timeline.length, 7);
    assert.equal(week.timeline[0].key, "2026-05-04");
    assert.equal(week.timeline.at(-1).key, "2026-05-10");
    assert.equal(week.totals.total, 300);
    assert.equal(rangeLabel(week), "2026-05-04 至 2026-05-05");

    setSummaryFilters({ preset: "month", bucket: "day", now: "2026-05-05T13:00:00" });
    const month = summarize({ events });
    assert.equal(month.timeline.length, 31);
    assert.equal(month.timeline[0].key, "2026-05-01");
    assert.equal(month.timeline.at(-1).key, "2026-05-31");
    assert.equal(month.totals.total, 300);
  } finally {
    setSummaryFilters({ preset: "today", recentValue: "1个月", bucket: "hour", now: null, startDate: "", endDate: "" });
  }
});
