import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { analyzeWithResourceIdentity, correctResourceIdentity, parseResourceSample, resourceSnapshotRows } from "./resource-identity-analysis.mjs";

const process = (pid, parentPid, time, role = "service") => ({ pid, parentPid, role, name: "fixture.exe", startTimeUtc: time,
  workingSetBytes: 10, privateBytes: 20, reportedPeakWorkingSetBytes: 30, cpuAvailable: true, cpuSeconds: 4,
  ioAvailable: true, logicalReadBytes: 5, logicalWriteBytes: 6, cpuSecondsIncrement: 1, logicalReadBytesIncrement: 2, logicalWriteBytesIncrement: 3 });
const time = "2026-11-08T01:00:00.1234567Z";

test("exited native snapshots preserve historical costs without pretending the process is live", () => {
  const original = process(1, 0, time), captured = process(2, 1, time);
  const sample = { processes: [original], tombstones: [{ pid: 2, role: "service", name: "node.exe", reason: "exited",
    identityEvidence: { pid: 2, startTimeUtcTicks: "639296804262091236" }, resourceSnapshot: captured }] };
  const rows = resourceSnapshotRows(sample);
  assert.equal(sample.processes.length, 1); assert.equal(rows.length, 2);
  assert.equal(rows[1].liveness, "exited"); assert.equal(rows[1].reportedPeakWorkingSetBytes, 30);
  assert.equal(rows[1].cpuSeconds, 4); assert.equal(rows[1].logicalReadBytes, 5);
  assert.equal(rows[1].identityEvidence.startTimeUtcTicks, "639296804262091236");
  assert.throws(() => resourceSnapshotRows({ processes: [], tombstones: [{ ...sample.tombstones[0], identityEvidence: { pid: 3 } }] }));
});

test("derived JSON preserves exact Windows Int64 process identities for cleanup", () => {
  const sample = parseResourceSample('{"processes":[{"pid":1,"startTimeUtcTicks":639296804262091236},{"pid":2,"startTimeUtcTicks":null}]}');
  const roundtrip = JSON.parse(JSON.stringify(sample));
  assert.equal(BigInt(roundtrip.processes[0].startTimeUtcTicks), 639296804262091236n);
  assert.equal(roundtrip.processes[1].startTimeUtcTicks, null);
});

test("PID reuse cannot turn an older external process and its descendants into service memory", () => {
  const rows = [process(99, 0, time, "runner"), process(1, 99, time), process(2, 1, "2026-11-04T01:00:00Z"),
    process(3, 2, time), process(4, 1, "2026-11-08T01:00:01Z")];
  const input = { processes: rows, service: { workingSetBytes: 40 }, state: { unchanged: true } };
  const result = correctResourceIdentity(input);
  assert.deepEqual(result.sample.processes.map(row => row.pid), [99, 1, 4]);
  assert.equal(result.sample.service.workingSetBytes, 20);
  assert.equal(result.sample.service.reportedPeakWorkingSetBytes, 60);
  assert.equal(result.sample.service.cpuSecondsIncrement, 2);
  assert.equal(result.sample.service.logicalReadBytesIncrement, 4);
  assert.equal(result.excluded.length, 2);
  assert.equal(input.processes.length, 5); assert.equal(input.service.workingSetBytes, 40);
  assert.equal(result.sample.state, input.state);
});

test("valid children, equal timestamps and missing parent evidence are preserved", () => {
  const sample = { processes: [process(1, 0, time), process(2, 1, time), process(3, 999, "2020-01-01T00:00:00Z")] };
  assert.equal(correctResourceIdentity(sample).sample, sample);
  const uncertain = { processes: [process(1, 0, time), process(2, 1, null)] };
  assert.equal(correctResourceIdentity(uncertain).sample, uncertain);
});

test("100ns creation-time differences are not lost to JSON Int64 rounding", () => {
  const sample = { processes: [process(99, 0, time, "runner"), process(1, 99, time), process(2, 1, "2026-11-08T01:00:00.1234566Z")] };
  assert.deepEqual(correctResourceIdentity(sample).sample.processes.map(row => row.pid), [99, 1]);
});

test("browser PID contamination is corrected without removing valid browser processes", () => {
  const sample = { processes: [process(99, 0, time, "runner"), process(1, 99, time), process(2, 1, time, "browser"),
    process(3, 2, "2026-11-07T00:00:00Z", "browser")] };
  const result = correctResourceIdentity(sample);
  assert.equal(result.sample.service.processCount, 1);
  assert.equal(result.sample.browser.processCount, 1);
  assert.equal(result.sample.browser.reportedPeakWorkingSetBytes, 30);
});

test("a possible task-owned orphan and a missing runner identity remain counted", () => {
  const orphan = { processes: [process(99, 0, "2026-11-07T00:00:00Z", "runner"),
    process(1, 99, time), process(2, 1, "2026-11-08T00:00:00Z")] };
  assert.equal(correctResourceIdentity(orphan).sample, orphan);
  const unknown = { processes: orphan.processes.slice(1) };
  assert.equal(correctResourceIdentity(unknown).sample, unknown);
});

test("a demonstrated pre-runner outsider stays excluded after its recycled parent exits", () => {
  const sample = { processes: [process(99, 0, time, "runner"), process(2, 123, "2026-11-07T00:00:00Z")] };
  assert.deepEqual(correctResourceIdentity(sample).sample.processes.map(row => row.pid), [99]);
});

test("existing analysis is rejected before any costly verification or resource derivation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "resource-identity-"));
  try {
    const output = path.join(directory, "result.json");
    await writeFile(output, "retained");
    await assert.rejects(analyzeWithResourceIdentity("year", "unused-validation.json", output), /analysis output must be new/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
