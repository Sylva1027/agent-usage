import assert from "node:assert/strict";
import test from "node:test";
import { resolveDateRange, selectQuotaWindows, summarizeUsage } from "../src/usage-core.js";
import { resolveNamedRecentRange, hasSelectedCodexSource } from "../public/timeline-utils.js";
import { setSummaryFilters, summarize, nextRecentState } from "../public/app.js";

const now = new Date("2026-09-26T12:00:00Z");
const observation = (observed, end, minutes = 300, line = 1) => ({
  sourcePath: "fixture.jsonl", lineNumber: line, role: minutes === 300 ? "primary" : "secondary",
  limitId: "codex", windowMinutes: minutes, observedAtMs: Date.parse(observed), resetsAtMs: Date.parse(end), usedPercent: 10,
});
const observations = [
  observation("2026-09-25T04:00:00Z", "2026-09-25T07:00:00Z"),
  observation("2026-09-26T10:00:00Z", "2026-09-26T14:00:00Z", 300, 2),
  observation("2026-09-19T10:00:00Z", "2026-09-20T14:00:00Z", 10080, 3),
  observation("2026-09-26T10:00:00Z", "2026-09-27T14:00:00Z", 10080, 4),
];

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
  assert.equal(resolveNamedRecentRange("上一个5h", now, selectQuotaWindows([observations[1]], now)).quotaState, "missing");
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
  const events = ["2026-09-25T01:59:59.999Z", "2026-09-25T02:00:00Z", "2026-09-25T06:59:59.999Z", "2026-09-25T07:00:00Z"].map((timestamp, index) => ({
    timestamp, sessionId: "s", homeId: "codex", homeLabel: "Codex", channel: "CLI", model: "gpt-6-sol", cwd: "/work",
    total: { total: index + 1, input: index + 1, cached: 0, output: 0, reasoning: 0 },
  }));
  const report = { events, homes: [], sessions: [], warnings: [], rateLimitObservations: observations, quota, asOf: now.toISOString() };
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
  } finally { setSummaryFilters({ preset: "today", recentValue: "上个月", now: null, bucket: "hour" }); }
});

test("Codex availability follows selected source kinds, not model or source display names", () => {
  const homes = [{ id: "c", kind: "main", label: "Personal" }, { id: "z", kind: "zcode", label: "Codex" }];
  assert.equal(hasSelectedCodexSource(homes), true);
  assert.equal(hasSelectedCodexSource(homes, ["c"]), false);
  assert.equal(hasSelectedCodexSource(homes, ["z"]), true);
  assert.equal(hasSelectedCodexSource([], []), false);
});
