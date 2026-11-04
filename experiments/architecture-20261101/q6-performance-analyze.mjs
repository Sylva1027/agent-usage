import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUSINESS_FIELDS, normalizeBody } from "./q3-benchmark-support.mjs";
import { BASE } from "./q6-performance-prepare.mjs";

export function directionGate(appends) {
  const valid = appends.filter((row) => row.responseStatus === 200 && row.responseTotal === row.expectedTotal &&
    row.automaticSseObserved === true && Number.isFinite(row.actualPaintMs));
  const fallback = valid.filter((row) => row.fullFallback).length;
  return { validAppends: valid.length, fullFallbacks: fallback, fraction: valid.length ? fallback / valid.length : null,
    stop: valid.length > 0 && fallback / valid.length > 0.5 };
}
export function stats(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return { n: sorted.length, min: sorted[0], median: sorted.length % 2 ? sorted[sorted.length >> 1]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2, max: sorted.at(-1) };
}
async function main() {
  const read = async (file) => JSON.parse(await readFile(file, "utf8"));
  const matrix = await read(path.join(BASE, "matrix.json"));
  const runs = [];
  for (const variant of ["baseline", "candidate"]) {
    const directory = path.join(BASE, "page/1x-native", variant);
    const run = await read(path.join(directory, "result.json"));
    const resource = await read(path.join(directory, "resources/resources.json"));
    runs.push({ ...run, directory, resource });
  }
  const [baseline, candidate] = runs;
  const a = normalizeBody(baseline.first.all.body, baseline, false);
  const b = normalizeBody(candidate.first.all.body, candidate, false);
  for (const field of [...BUSINESS_FIELDS, "records"]) assert.deepEqual(a.summary[field], b.summary[field], `Initial ${field} parity`);
  assert.deepEqual(a.metadata, b.metadata, "Initial metadata parity");
  assert.deepEqual(a.periodComparison, b.periodComparison, "Initial period parity");
  const gate = directionGate(candidate.appends);
  assert.equal(gate.stop, true, "This partial matrix must have a recorded stop reason");
  const groups = runs.map((run) => ({ variant: run.variant, complete: run.passed,
    observedAppends: run.appends.length, validAppends: directionGate(run.appends).validAppends,
    appends: Object.fromEntries(["codex", "dsh"].map((kind) => [kind, stats(run.appends.filter((row) => row.kind === kind).map((row) => row.actualPaintMs))])),
    initialThroughAllMs: run.first.endedAtMs - run.first.startedAtMs,
    reopenThroughAllMs: run.reopen ? run.reopen.endedAtMs - run.reopen.startedAtMs : null,
    initialCatalog: run.initialStorage.catalog,
    peakSampledServiceMiB: run.resource.service.peakSampledWorkingSetBytes / 1048576,
    peakSampledBrowserMiB: run.resource.browser.peakSampledWorkingSetBytes / 1048576,
    sampledCpuSeconds: run.resource.service.sampledCpuSecondsIncrement,
    sampledLogicalReadBytes: run.resource.service.sampledLogicalReadBytesIncrement,
    sampledLogicalWriteBytes: run.resource.service.sampledLogicalWriteBytesIncrement,
    sourceChecks: run.appends.map((row) => ({ kind: row.kind, syncs: row.syncs?.map((sync) => ({
      ms: sync.duration, work: sync.work, delta: sync.delta, sourceWork: sync.sourceWork })) })),
    samplerCoverage: "initial opening through completed operations; group action counts differ, not equal-load resource ranking",
    toolFailure: run.failure?.message }));
  const summary = { generation: "q6", stageStatus: "stopped-at-direction-gate", planned: matrix.planned,
    actual: { appends: runs.reduce((n, run) => n + run.appends.length, 0),
      explicitSwitches: runs.reduce((n, run) => n + run.scopes.filter((row) => !row.mode).length, 0),
      reopens: runs.filter((run) => run.reopen).length, completeGroups: runs.filter((run) => run.passed).length,
      emptyRealHistoryRebuilds: 0 },
    initialParity: true, completeMatrixParity: false, gate, groups,
    diagnostic: await read(path.join(BASE, "diagnostic.json")),
    remainingGroups: "not run: candidate cell finalization, 10x, SHA, and independent file-count groups",
    measuredRuntimeModified: false };
  await writeFile(path.join(BASE, "analysis.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ status: summary.stageStatus, actual: summary.actual, gate, initialParity: true,
    groups: groups.map(({ variant, appends, initialThroughAllMs, peakSampledServiceMiB }) => ({ variant, appends, initialThroughAllMs, peakSampledServiceMiB })) }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
