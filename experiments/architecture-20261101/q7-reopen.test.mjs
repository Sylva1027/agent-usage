import assert from "node:assert/strict";
import test from "node:test";
import { sampledWindow } from "./q7-reopen-analyze.mjs";

test("reopen resources exclude preparation and subsequent appends", () => {
  const sample = (atUnixMs, mib, cpu) => ({ atUnixMs, service: {
    workingSetBytes: mib * 2 ** 20, cpuSecondsIncrement: cpu,
    logicalReadBytesIncrement: mib * 2 ** 20, logicalWriteBytesIncrement: 2 ** 20,
  } });
  assert.deepEqual(sampledWindow([
    sample(9, 500, 100), sample(10, 100, 0.1), sample(20, 120, 0.2), sample(21, 400, 50),
  ], 10, 20), {
    samples: 2, peakServiceMiB: 120, sampledCpuSeconds: 0.1 + 0.2,
    sampledReadMiB: 220, sampledWriteMiB: 2,
  });
  assert.deepEqual(sampledWindow([], 10, 20), {
    samples: 0, peakServiceMiB: null, sampledCpuSeconds: 0,
    sampledReadMiB: 0, sampledWriteMiB: 0,
  });
});
