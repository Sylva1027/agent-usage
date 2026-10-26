import assert from "node:assert/strict";
import test from "node:test";
import { summarizeUsage } from "../src/usage-core.js";

test("memory summary preserves missing source identities and filters only the home scope", () => {
  const missingSources = ["a", "b"].map((id) => ({
    path: `/fixture/${id}/source.jsonl`,
    kind: "project-log",
    homeId: id,
    homeLabel: id,
    homePath: `/fixture/${id}`,
    missingSinceMs: Date.parse("2026-01-01T00:00:00Z"),
  }));
  const report = {
    homes: [],
    events: [],
    sessions: [],
    perfSamples: [],
    perfMeta: { state: "ready", missingSources },
  };
  const filters = { preset: "custom", startDate: "2026-07-12", endDate: "2026-07-12" };
  assert.deepEqual(summarizeUsage(report, filters).perf.missingSources, missingSources);
  assert.deepEqual(summarizeUsage(report, { ...filters, excludeHomes: ["a"] }).perf.missingSources, [
    missingSources[1],
  ]);
  assert.equal(report.perfMeta.missingSources.length, 2);
  assert.deepEqual(summarizeUsage({ ...report, perfMeta: { state: "ready" } }, filters).perf.missingSources, []);
});
