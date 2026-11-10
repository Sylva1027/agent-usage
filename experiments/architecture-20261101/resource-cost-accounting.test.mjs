import assert from "node:assert/strict";
import test from "node:test";
import { createResourceCostLedger } from "./resource-cost-accounting.mjs";

const row = (values = {}) => ({ pid: 10, role: "service", startTimeUtc: "2026-11-11T00:00:00.0000001Z",
  cpuAvailable: true, ioAvailable: true, cpuSeconds: 2, logicalReadBytes: 100, logicalWriteBytes: 200, ...values });
const sample = (...processes) => ({ atUnixMs: 1000, processes, service: { processCount: processes.length } });

test("first observation counts cumulative values even without deltas", () => {
  const ledger = createResourceCostLedger(); ledger.add(sample(row()));
  assert.deepEqual(ledger.result().totals, { cpuSeconds: 2, logicalReadBytes: 100, logicalWriteBytes: 200 });
  assert.equal(ledger.result().complete, true);
});
test("normal observations accumulate each process once and include final counters", () => {
  const ledger = createResourceCostLedger(); ledger.add(sample(row()));
  const last = sample(row({ cpuSeconds: 2.5, logicalWriteBytes: 400 }));
  last.costFinals = [row({ cpuSeconds: 3, logicalWriteBytes: 500, finalCounters: true })];
  ledger.add(last);
  assert.equal(ledger.result({ closed: true }).complete, true);
  assert.equal(ledger.result().totals.logicalWriteBytes, 500);
});
test("zero-process final samples do not poison complete counters", () => {
  const ledger = createResourceCostLedger(); ledger.add(sample(row({ finalCounters: true }))); ledger.add(sample());
  assert.equal(ledger.result({ closed: true }).complete, true);
  assert.equal(ledger.result().totals.cpuSeconds, 2);
});
test("one member's missing field remains unknown instead of using other members' values", () => {
  const ledger = createResourceCostLedger(); ledger.add(sample(row(), row({ pid: 11, ioAvailable: false, logicalReadBytes: null })));
  assert.equal(ledger.result().complete, false); assert.equal(ledger.result().totals.logicalReadBytes, null);
  ledger.add(sample(row({ pid: 11, finalCounters: true })));
  assert.equal(ledger.result().totals.logicalReadBytes, null);
});
test("short process without final tail remains incomplete after it disappears", () => {
  const ledger = createResourceCostLedger(); ledger.add(sample(row())); ledger.add(sample());
  assert.equal(ledger.result({ closed: true }).complete, false);
  assert.equal(ledger.result({ closed: true }).missingFinal.length, 1);
});
test("reused PID has independent cumulative counters and completion", () => {
  const ledger = createResourceCostLedger(); ledger.add(sample(row({ finalCounters: true })));
  ledger.add(sample(row({ startTimeUtc: "2026-11-11T00:00:00.0000002Z", cpuSeconds: 1, logicalReadBytes: 10, logicalWriteBytes: 20 })));
  assert.equal(ledger.result().totals.cpuSeconds, 3); assert.equal(ledger.result().processes.length, 2);
  assert.equal(ledger.result({ closed: true }).complete, false);
});
