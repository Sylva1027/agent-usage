import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setSummaryFilters, summarize, rangeLabel } from "../public/app.js";
import { canonicalRecentValue, displayRecentValue, localizeText } from "../public/i18n.js";
import {
  buildTimelineRows,
  completedQuotaWindows,
  deriveTimelineBucket,
  quotaRecordsForRange,
} from "../public/timeline-utils.js";
import {
  buildUsageIndex,
  buildUsageReport,
  resolveDateRange,
  selectQuotaWindows,
  summarizeUsage,
  summarizeUsageIndex,
} from "../src/usage-core.js";
import { UsageStore } from "../src/usage-store.js";
import { pricedReport } from "../test-support/report-projection.js";

const duration = 10080 * 60000;
const stamp = (value) => Date.parse(value);
const iso = (value) => new Date(value).toISOString();
const observation = (start, observed = start, usedPercent = 1, offset = 0) => ({
  sourcePath: "limits",
  lineNumber: observed,
  role: "secondary",
  limitId: "codex",
  windowMinutes: 10080,
  observedAtMs: stamp(observed),
  resetsAtMs: stamp(start) + duration + offset,
  usedPercent,
});
const first = "2026-10-03T09:12:32+08:00";
const second = "2026-10-07T13:18:18+08:00";
const third = "2026-10-11T12:15:18+08:00";
const asOf = "2026-10-12T22:10:00+08:00";
const observations = [observation(first), observation(second), observation(third)];
const rangeFor = (rows = observations, now = asOf) =>
  resolveDateRange({
    preset: "recent",
    recentValue: "上周",
    calendarZone: "utc",
    now,
    quota: selectQuotaWindows(rows, now),
  });

test("previous 7d follows actual replacements and retains its planned reset and minute duration", () => {
  const range = rangeFor();
  assert.equal(iso(range.start), iso(second));
  assert.equal(iso(range.windowEndExclusive), iso(third));
  assert.equal(range.durationMinutes, 5697);
  assert.equal(range.plannedResetAt, iso(stamp(second) + duration));
  assert.equal(range.bucket, "day");
  assert.match(rangeLabel({ range }), /仅显示有用量的日期/);
});

test("unused allowance and a delayed restart extend the interval without requiring a zero percent observation", () => {
  const start = "2026-10-05T08:00:00+08:00",
    next = "2026-10-13T08:00:00+08:00";
  const range = rangeFor([observation(start, start, 1), observation(next, next, 4)], next);
  assert.equal(range.durationMinutes, 8 * 24 * 60);
  assert.equal(iso(range.windowEndExclusive), iso(next));
});

test("expiry without another start does not make the latest cycle the previous cycle", () => {
  assert.equal(
    selectQuotaWindows([observation(second)], "2026-10-20T00:00:00Z").previousWindows.quota_week.state,
    "missing",
  );
  const quota = selectQuotaWindows(observations, "2026-10-25T00:00:00Z");
  assert.equal(quota.windows.quota_week.state, "waiting");
  assert.equal(quota.previousWindows.quota_week.windowStart, iso(second));
  assert.equal(quota.previousWindows.quota_week.windowEndExclusive, iso(third));
});

test("jitter, duplicate observations, later writes of old snapshots and future observations do not add cycles", () => {
  const rows = [
    ...observations,
    observation(second, "2026-10-10T10:00:00+08:00", 95, 1000),
    observation(second, "2026-10-10T11:00:00+08:00", 96),
    observation(second, "2026-10-11T12:16:00+08:00", 96),
    observation("2026-10-20T08:00:00+08:00"),
  ];
  rows.push(rows[1]);
  const completed = completedQuotaWindows(rows, "codex", stamp(asOf), 10080);
  assert.equal(completed.length, 2);
  assert.equal(completed.at(-1).windowStart, iso(second));
  assert.equal(completed.at(-1).windowEndExclusive, iso(third));
});

test("conflicting snapshots do not silently produce certain weekly boundaries", () => {
  const rows = [...observations, { ...observation("2026-10-10T12:00:00+08:00", third), sourcePath: "conflict" }];
  assert.equal(selectQuotaWindows(rows, asOf).previousWindows.quota_week.state, "ambiguous");
});

test("a year-long interval produces only usage dates and respects both exact boundaries", () => {
  const start = "2025-10-07T08:00:00Z",
    next = "2026-10-07T08:00:00Z";
  const range = rangeFor([observation(start), observation(next)], next);
  const event = (timestamp, total) => ({ timestamp, total: { total, input: total }, model: "free", channel: "CLI" });
  const rows = buildTimelineRows(
    [
      event(iso(stamp(start) - 1), 999),
      event(start, 10),
      event("2026-10-06T10:00:00Z", 20),
      event("2026-03-01T00:00:00Z", 0),
      event(next, 999),
    ],
    range,
    deriveTimelineBucket(range, "month"),
    { estimateCost: () => ({ totalUsd: 0, currency: "USD" }) },
  );
  assert.equal(range.durationMinutes, 365 * 24 * 60);
  assert.deepEqual(
    rows.map((row) => row.key),
    ["2025-10-07", "2026-10-06"],
  );
  assert.equal(
    rows.reduce((sum, row) => sum + row.total.total, 0),
    30,
  );
  assert.equal(rows[0].costByModel.free.totalUsd, 0);
});

test("weekly record badges compare actual completed intervals, including early replacements", () => {
  const range = rangeFor();
  const seen = [];
  const records = quotaRecordsForRange(range, selectQuotaWindows(observations, asOf), observations, (window) => {
    seen.push([iso(window.start), iso(window.end)]);
    return { eventCount: 1, values: { totalTokens: stamp(window.start) === stamp(second) ? 100 : 10 } };
  });
  assert.equal(records.totalTokens.comparedWindowCount, 1);
  assert.deepEqual(seen[0], [iso(first), iso(stamp(second) - 1)]);
});

test("previous 5h retains the full interval until its replacement starts", () => {
  const row = (start) => ({
    ...observation(start),
    role: "primary",
    windowMinutes: 300,
    resetsAtMs: stamp(start) + 300 * 60000,
  });
  const quota = selectQuotaWindows(
    [row("2026-10-10T00:04:21+08:00"), row("2026-10-10T12:51:01+08:00")],
    "2026-10-10T13:00:00+08:00",
  );
  assert.equal(
    stamp(quota.previousWindows.quota_5h.windowEndExclusive) - stamp(quota.previousWindows.quota_5h.windowStart),
    (12 * 60 + 46 + 40 / 60) * 60000,
  );
});

test("menu and selected weekly labels match in both languages while legacy values remain supported", () => {
  assert.equal(canonicalRecentValue("上一个7d"), "上周");
  assert.equal(canonicalRecentValue("上一个 7d"), "上周");
  assert.equal(canonicalRecentValue("Last 7d"), "上周");
  assert.equal(displayRecentValue("上周", "zh-CN"), "上一个7d");
  assert.equal(displayRecentValue("上周", "en-US"), "Last 7d");
  assert.equal(localizeText("上周", "en-US"), "Last Week");
});

for (const [minutes, recentValue, bucket] of [
  [10080, "上周", "day"],
  [300, "上一个5h", "quota_30m"],
]) {
  test(`SQLite, memory and browser summaries agree on ${minutes}-minute quota bounds, usage slots, prices and exclusions`, async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "previous-weekly-"));
    const sessions = path.join(homeDir, ".codex", "sessions");
    const store = new UsageStore({ homeDir, databaseFile: path.join(homeDir, "index.sqlite") });
    try {
      await mkdir(sessions, { recursive: true });
      for (const [index, [time, total, model]] of [
        [first, 10, "gpt-6-sol"],
        [second, 20, "gpt-6-sol"],
        ["2026-10-10T20:00:00+08:00", 30, "gpt-6-sol"],
        [third, 999, "gpt-6-sol"],
        ["2026-10-09T10:00:00+08:00", 500, "codex-auto-review"],
      ].entries()) {
        await writeFile(
          path.join(sessions, `${index}.jsonl`),
          [
            { type: "session_meta", timestamp: time, payload: { id: `s${index}`, source: "cli", cwd: homeDir } },
            { type: "turn_context", timestamp: time, payload: { model } },
            {
              type: "event_msg",
              timestamp: time,
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
            .map(JSON.stringify)
            .join("\n"),
        );
      }
      await writeFile(
        path.join(sessions, "limits.jsonl"),
        observations
          .map((row) =>
            JSON.stringify({
              type: "event_msg",
              timestamp: iso(row.observedAtMs),
              payload: {
                type: "token_count",
                rate_limits: {
                  limit_id: "codex",
                  [minutes === 300 ? "primary" : "secondary"]: {
                    window_minutes: minutes,
                    resets_at: (row.resetsAtMs - duration + minutes * 60000) / 1000,
                    used_percent: row.usedPercent,
                  },
                },
              },
            }),
          )
          .join("\n"),
      );
      await store.sync();
      const filters = {
        preset: "recent",
        recentValue,
        now: asOf,
        calendarZone: "utc",
        bucket,
        excludeHomes: [],
      };
      const report = await buildUsageReport({ homeDir });
      setSummaryFilters(filters);
      const index = await buildUsageIndex({ homeDir });
      const summaries = [
        store.summarize(filters),
        summarizeUsage(report, filters),
        summarizeUsageIndex(index, filters),
        summarize(pricedReport(report, asOf)),
      ];
      for (const summary of summaries) {
        assert.equal(iso(summary.range.start), iso(second));
        assert.equal(iso(summary.range.windowEndExclusive), iso(third));
        assert.equal(summary.range.durationMinutes, 5697);
        assert.equal(summary.range.bucket, bucket);
        assert.equal(summary.totals.total, 50);
        assert.equal(summary.sessionCount, 2);
        assert.deepEqual(
          summary.timeline.map((row) => row.key),
          minutes === 10080
            ? ["2026-10-07", "2026-10-10"]
            : [
                String(stamp(second)),
                String(
                  stamp(second) + Math.floor((stamp("2026-10-10T20:00:00+08:00") - stamp(second)) / 1800000) * 1800000,
                ),
              ],
        );
        assert.ok(summary.costEstimate.totalUsd > 0);
        assert.equal(
          summary.timeline.reduce((sum, row) => sum + row.total.total, 0),
          summary.totals.total,
        );
      }
      assert.deepEqual(
        summaries.map((summary) => summary.costEstimate.totalUsd),
        Array(4).fill(summaries[0].costEstimate.totalUsd),
      );
      assert.deepEqual(store.summarize({ ...filters, excludeHomes: store.homes.map((home) => home.id) }).timeline, []);
    } finally {
      store.close();
      setSummaryFilters({ preset: "today", recentValue: "上个月", now: null, calendarZone: "local", excludeHomes: [] });
      assert.equal(path.dirname(path.resolve(homeDir)), path.resolve(tmpdir()));
      await rm(homeDir, { recursive: true, force: true });
    }
  });
}

test("5h expiry, early replacement, timestamp jitter and late old snapshots share the cycle rules", () => {
  const start = "2026-09-30T10:49:27+08:00",
    next = "2026-09-30T15:08:20+08:00";
  const row = (time, observed = time, offset = 0) => ({
    ...observation(time, observed),
    role: "primary",
    windowMinutes: 300,
    resetsAtMs: stamp(time) + 300 * 60000 + offset,
  });
  const rows = [
    row(start),
    row(next),
    row(start, "2026-09-30T15:08:20.044+08:00"),
    row(next, "2026-09-30T15:09:00+08:00", -5000),
    row(next, "2026-09-30T15:10:00+08:00"),
  ];
  const quota = selectQuotaWindows(rows, "2026-10-02T00:00:00Z");
  assert.equal(quota.previousWindows.quota_5h.windowStart, iso(start));
  assert.equal(quota.previousWindows.quota_5h.windowEndExclusive, iso(next));
  assert.equal(quota.windows.quota_5h.state, "waiting");
  assert.equal(selectQuotaWindows([row(start)], "2026-10-02T00:00:00Z").previousWindows.quota_5h.state, "missing");
});

test("5h sparse half-hours preserve exact final boundaries across a year-long rest", () => {
  const start = stamp("2025-10-10T23:49:27Z"),
    end = stamp("2026-10-11T00:08:20Z");
  const range = {
    preset: "recent",
    quotaWindow: true,
    quotaPreset: "quota_5h",
    quotaState: "available",
    start: new Date(start),
    end: new Date(end - 1),
    windowStart: new Date(start),
    windowEndExclusive: new Date(end),
    asOf: new Date(end),
    calendarZone: "utc",
  };
  const events = [start - 1, start, start + 1800000, end - 1, end].map((timestamp, i) => ({
    timestamp,
    sessionId: String(i),
    model: "test",
    total: { total: i === 2 ? 0 : 10 },
  }));
  const rows = buildTimelineRows(events, range, "quota_30m");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].slotStartMs, start);
  assert.equal(rows[1].slotEndExclusiveMs, end);
  assert.equal(
    rows.reduce((n, row) => n + row.total.total, 0),
    20,
  );
  assert.equal(deriveTimelineBucket(range, "month"), "quota_30m");
  assert.match(rangeLabel({ range }), /2025-10-10 23:49.*2026-10-11 00:08.*仅显示有用量的半小时/);
});
