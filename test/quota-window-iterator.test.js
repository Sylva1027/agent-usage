import assert from "node:assert/strict";
import test from "node:test";
import { selectQuotaWindows, resolveDateRange } from "../src/usage-core.js";
import { completedQuotaWindows, previousQuotaRange, quotaRecordsForRange } from "../public/timeline-utils.js";

test("quota consumers preserve array results with a single-pass window source", () => {
  const asOf = new Date("2026-10-03T03:00:00Z");
  const observations = [1, 2, 3].map((day) => ({
    sourcePath: "quota",
    lineNumber: day,
    role: "primary",
    limitId: "codex",
    windowMinutes: 300,
    observedAtMs: Date.parse(`2026-10-0${day}T01:00:00Z`),
    resetsAtMs: Date.parse(`2026-10-0${day}T06:00:00Z`),
    usedPercent: day,
  }));
  const quota = selectQuotaWindows(observations, asOf);
  const range = resolveDateRange({ preset: "quota_5h", quota, now: asOf });
  let calls = 0;
  const source = {
    completedQuotaWindows(...args) {
      calls += 1;
      const windows = completedQuotaWindows(observations, ...args);
      return (function* () {
        yield* windows;
      })();
    },
  };
  assert.deepEqual(previousQuotaRange(range, quota, source), previousQuotaRange(range, quota, observations));
  const summarize = (window) => ({
    eventCount: 1,
    values: { totalTokens: window === range ? 100 : 10, totalCost: window === range ? 1 : Number.NaN },
  });
  assert.deepEqual(
    quotaRecordsForRange(range, quota, source, summarize),
    quotaRecordsForRange(range, quota, observations, summarize),
  );
  assert.equal(calls, 2);
  const conflicting = { completedQuotaWindows: () => null };
  assert.equal(previousQuotaRange(range, quota, conflicting), null);
  assert.deepEqual(quotaRecordsForRange(range, quota, conflicting, summarize), {});
});
