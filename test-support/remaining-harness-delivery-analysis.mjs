import assert from "node:assert/strict";

export const regressed = (before, after) => after > before * 1.1 && after - before > 100;
const pct = (current, previous) => previous ? Math.round((current - previous) / previous * 10000) / 100 : null;

export function business(body, referenceMs) {
  const value = structuredClone(body), summary = value.summary, comparison = summary.comparison;
  assert.equal(value.quota.asOf, summary.quota.asOf);
  if (comparison.previousRange) {
    const duration = Date.parse(comparison.previousRange.end) - Date.parse(comparison.previousRange.start) + 1;
    const average = (now) => Math.round(comparison.previousTotals.total * Math.max(0,
      Math.min(Date.parse(summary.range.end), Math.max(Date.parse(summary.range.start), now)) - Date.parse(summary.range.start) + 1) / duration);
    // Validate live values exactly before aligning only the three elapsed-time trend fields.
    assert.equal(comparison.averageBaselineTotal, average(Date.parse(summary.quota.asOf)));
    assert.equal(comparison.averageDelta, summary.totals.total - comparison.averageBaselineTotal);
    assert.equal(comparison.averagePercentChange, pct(summary.totals.total, comparison.averageBaselineTotal));
    comparison.averageBaselineTotal = average(referenceMs);
    comparison.averageDelta = summary.totals.total - comparison.averageBaselineTotal;
    comparison.averagePercentChange = pct(summary.totals.total, comparison.averageBaselineTotal);
  }
  for (const key of ["fingerprint", "checkedAt", "snapshotId"]) delete value[key];
  delete summary.generatedAt; delete value.metadata.generatedAt; delete value.metadata.modelUsageAsOf;
  for (const timed of [value.quota, summary.quota, value.periodComparison]) delete timed.asOf;
  return value;
}
