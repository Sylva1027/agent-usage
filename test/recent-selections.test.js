import assert from "node:assert/strict";
import test from "node:test";
import { resolveDateRange, selectQuotaWindows, summarizeUsage } from "../src/usage-core.js";
import {
  resolveNamedRecentRange,
  hasSelectedCodexSource,
  quotaRecordsForRange,
  quotaRecordValues,
} from "../public/timeline-utils.js";
import { setSummaryFilters, summarize, nextRecentState } from "../public/app.js";

const now = new Date("2026-09-26T12:00:00Z");
const observation = (observed, end, minutes = 300, line = 1) => ({
  sourcePath: "fixture.jsonl",
  lineNumber: line,
  role: minutes === 300 ? "primary" : "secondary",
  limitId: "codex",
  windowMinutes: minutes,
  observedAtMs: Date.parse(observed),
  resetsAtMs: Date.parse(end),
  usedPercent: 10,
});
const observations = [
  observation("2026-09-25T04:00:00Z", "2026-09-25T07:00:00Z"),
  observation("2026-09-26T10:00:00Z", "2026-09-26T14:00:00Z", 300, 2),
  observation("2026-09-19T10:00:00Z", "2026-09-20T14:00:00Z", 10080, 3),
  observation("2026-09-26T10:00:00Z", "2026-09-27T14:00:00Z", 10080, 4),
];

test("quota records reject ties, missing history and conflicting observations, with comparable currencies", () => {
  const quota = selectQuotaWindows(observations, now);
  const range = { ...resolveNamedRecentRange("上一个5h", now, quota), asOf: now };
  const earlier = observation("2026-09-24T04:00:00Z", "2026-09-24T07:00:00Z", 300, 8);
  const summary = (value) => ({ eventCount: 1, values: { totalCost: value } });
  assert.deepEqual(
    quotaRecordsForRange(range, quota, observations, () => summary(2)),
    {},
  );
  assert.deepEqual(
    quotaRecordsForRange(range, quota, [...observations, earlier], () => summary(2)),
    {},
  );
  const records = quotaRecordsForRange(range, quota, [...observations, earlier], (window) =>
    summary(window === range ? 3 : 2),
  );
  assert.equal(records.totalCost.value, 3);
  const conflict = { ...earlier, resetsAtMs: earlier.resetsAtMs + 60000, lineNumber: 9 };
  assert.deepEqual(
    quotaRecordsForRange(range, quota, [...observations, earlier, conflict], (window) =>
      summary(window === range ? 3 : 2),
    ),
    {},
  );
  assert.equal(quotaRecordValues({}, { totalUsd: 2, totalCny: 14 }, 1, 7).totalCost, 4);
});

test("quota records retain historical windows with small reset-time drift", () => {
  const range = {
    quotaWindow: true,
    quotaState: "available",
    preset: "quota_5h",
    start: new Date("2026-09-26T09:00:00Z"),
    end: new Date("2026-09-26T11:00:00Z"),
    asOf: new Date("2026-09-26T11:00:00Z"),
  };
  const quota = { limitId: "codex" };
  const history = [
    observation("2026-09-24T10:00:00Z", "2026-09-24T14:00:00Z", 300, 1),
    observation("2026-09-25T10:01:00Z", "2026-09-25T14:00:00Z", 300, 2),
    observation("2026-09-25T10:02:00Z", "2026-09-25T14:00:00Z", 300, 3),
    observation("2026-09-25T10:03:00Z", "2026-09-25T14:00:10Z", 300, 4),
    observation("2026-09-25T10:04:00Z", "2026-09-25T14:30:00Z", 300, 5),
  ];
  const summarize = (current) => (window) => ({
    eventCount: 1,
    values: {
      totalTokens: window === range ? current : window.end.getUTCDate() === 24 ? 10 : 100,
      totalCost: window === range ? current / 10 : window.end.getUTCDate() === 24 ? 1 : 10,
    },
  });
  assert.deepEqual(quotaRecordsForRange(range, quota, history, summarize(50)), {});
  const records = quotaRecordsForRange(range, quota, history, summarize(120));
  assert.equal(records.totalTokens.value, 120);
  assert.equal(records.totalTokens.comparedWindowCount, 2);
  assert.equal(records.totalCost.value, 12);
});

test("previous reset selections use observed completed windows, including gaps between sessions", () => {
  const quota = selectQuotaWindows(observations, now);
  const five = resolveNamedRecentRange("上一个5h", now, quota);
  assert.equal(five.start.toISOString(), "2026-09-25T02:00:00.000Z");
  assert.equal(five.end.toISOString(), "2026-09-25T06:59:59.999Z");
  assert.equal(five.bucket, "quota_30m");
  const week = resolveNamedRecentRange("上周", now, quota);
  assert.equal(week.start.toISOString(), "2026-09-13T14:00:00.000Z");
  assert.equal(week.windowEndExclusive.toISOString(), "2026-09-20T14:00:00.000Z");
  assert.equal(week.bucket, "quota_24h");
  assert.equal(
    resolveNamedRecentRange("上一个5h", now, selectQuotaWindows([observations[1]], now)).quotaState,
    "missing",
  );
});

test("calendar selections respect month/year boundaries and leap years", () => {
  const clock = new Date(2024, 2, 15, 12);
  const month = resolveDateRange({ preset: "recent", recentValue: "上个月", now: clock });
  assert.equal(month.start.getTime(), new Date(2024, 1, 1).getTime());
  assert.equal(month.end.getTime(), new Date(2024, 2, 1).getTime() - 1);
  const january = resolveDateRange({ preset: "recent", recentValue: "上个月", now: new Date(2026, 0, 4) });
  assert.equal(january.start.getTime(), new Date(2025, 11, 1).getTime());
  const year = resolveDateRange({ preset: "recent", recentValue: "今年", now: clock });
  assert.equal(year.start.getTime(), new Date(2024, 0, 1).getTime());
  assert.equal(year.end.getTime(), new Date(2024, 2, 15, 23, 59, 59, 999).getTime());
  assert.equal(nextRecentState({}, "This Year").bucket, "month");
});

test("live and static previous-window summaries agree and exclude the reset endpoint", () => {
  const quota = selectQuotaWindows(observations, now);
  const events = [
    "2026-09-25T01:59:59.999Z",
    "2026-09-25T02:00:00Z",
    "2026-09-25T06:59:59.999Z",
    "2026-09-25T07:00:00Z",
  ].map((timestamp, index) => ({
    timestamp,
    sessionId: "s",
    homeId: "codex",
    homeLabel: "Codex",
    channel: "CLI",
    model: "gpt-6-sol",
    cwd: "/work",
    total: { total: index + 1, input: index + 1, cached: 0, output: 0, reasoning: 0 },
  }));
  const report = {
    events,
    // 限额窗口只统计 Codex 来源：homeId "codex" 是 main home。
    homes: [{ id: "codex", label: "Codex", kind: "main" }],
    sessions: [],
    warnings: [],
    rateLimitObservations: observations,
    quota,
    asOf: now.toISOString(),
  };
  const filters = { preset: "recent", recentValue: "上一个5h", now, bucket: "day" };
  const live = summarizeUsage(report, filters);
  setSummaryFilters({ ...filters, excludedHomes: [] });
  try {
    const snapshot = summarize(report);
    assert.equal(live.totals.total, 5);
    assert.equal(snapshot.totals.total, 5);
    assert.equal(live.timeline.length, 10);
    assert.equal(snapshot.timeline.length, 10);
    assert.equal(live.comparison, null);
    assert.equal(snapshot.comparison, null);
  } finally {
    setSummaryFilters({ preset: "today", recentValue: "上个月", now: null, bucket: "hour" });
  }
});

test("Codex availability follows selected source kinds, not model or source display names", () => {
  const homes = [
    { id: "c", kind: "main", label: "Personal" },
    { id: "z", kind: "zcode", label: "Codex" },
    // DSH、OpenCode 与项目日志同样没有 Codex 限额数据，且 label 里带 "Codex" 也不能算数。
    { id: "d", kind: "dsh", label: "Codex" },
    { id: "o", kind: "opencode", label: "Codex" },
    { id: "p", kind: "project-log", label: "Codex OAuth" },
  ];
  assert.equal(hasSelectedCodexSource(homes), true);
  assert.equal(hasSelectedCodexSource(homes, ["c"]), false);
  assert.equal(hasSelectedCodexSource(homes, ["z"]), true);
  // 只选中 DSH / OpenCode / 项目日志时不应点亮限额按钮。
  assert.equal(hasSelectedCodexSource(homes, ["c", "z", "p"]), false);
  assert.equal(hasSelectedCodexSource([{ id: "d", kind: "dsh", status: "active" }]), false);
  assert.equal(hasSelectedCodexSource([{ id: "o", kind: "opencode", status: "active" }]), false);
  assert.equal(hasSelectedCodexSource([{ id: "p", kind: "project-log", status: "active" }]), false);
  assert.equal(hasSelectedCodexSource([{ id: "u", kind: "unsupported", status: "unsupported" }]), false);
  assert.equal(hasSelectedCodexSource([], []), false);
});
