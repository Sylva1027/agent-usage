import assert from "node:assert/strict";
import test from "node:test";
import { business, regressed } from "../test-support/remaining-harness-delivery-analysis.mjs";

function body(asOf) {
  const now = new Date(asOf).toISOString();
  const average = Math.round((1000 * (asOf + 1)) / 1000);
  return {
    fingerprint: now,
    checkedAt: now,
    snapshotId: null,
    summary: {
      generatedAt: now,
      range: { start: new Date(0).toISOString(), end: new Date(999).toISOString() },
      totals: { total: 600 },
      costEstimate: { totalUsd: 0.125 },
      quota: { asOf: now },
      comparison: {
        previousRange: { start: new Date(-1000).toISOString(), end: new Date(-1).toISOString() },
        previousTotals: { total: 1000 },
        averageBaselineTotal: average,
        averageDelta: 600 - average,
        averagePercentChange: Math.round(((600 - average) / average) * 10000) / 100,
      },
    },
    quota: { asOf: now },
    metadata: { generatedAt: now, modelUsageAsOf: now, eventCount: 2 },
    periodComparison: { asOf: now },
  };
}

test("latency guard requires both the relative and absolute regression", () => {
  assert.equal(regressed(1000, 1100), false);
  assert.equal(regressed(100, 190), false);
  assert.equal(regressed(1000, 1101), true);
  assert.equal(regressed(5000, 5450), false);
});

test("live trends are validated before aligning clocks; money and counts remain exact", () => {
  assert.deepEqual(business(body(399), 500), business(body(699), 500));
  const wrongTrend = body(399);
  wrongTrend.summary.comparison.averageBaselineTotal++;
  assert.throws(() => business(wrongTrend, 500));
  const wrongMoney = body(699);
  wrongMoney.summary.costEstimate.totalUsd = 0.12500000000000003;
  assert.notDeepEqual(business(body(399), 500), business(wrongMoney, 500));
});
