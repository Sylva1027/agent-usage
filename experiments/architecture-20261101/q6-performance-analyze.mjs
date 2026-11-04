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
  for (const cell of matrix.cells) {
    let run;
    try { run = await read(path.join(cell.directory, "result.json")); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    const resources = await Promise.all(run.resourceSpans.map((span) => read(path.join(span.directory, "resources.json"))));
    runs.push({ ...run, directory: cell.directory, resources });
  }
  const parity = [];
  for (const id of new Set(runs.map((run) => run.cell))) {
    const pair = ["baseline", "candidate"].map((variant) => runs.find((run) => run.cell === id && run.variant === variant));
    if (pair.some((run) => !run)) continue;
    const [baseline, candidate] = pair;
    for (const phase of ["initial", "final"]) {
      if (phase === "final" && (!baseline.passed || !candidate.passed)) continue;
      const [a, b] = pair.map((run) => normalizeBody(phase === "initial" ? run.first.all.body : run.final, run, phase === "final"));
      for (const field of [...BUSINESS_FIELDS, "records"]) assert.deepEqual(a.summary[field], b.summary[field], `${id} ${phase} ${field} parity`);
      assert.deepEqual(a.metadata, b.metadata, `${id} ${phase} metadata parity`);
      assert.deepEqual(a.periodComparison, b.periodComparison, `${id} ${phase} period parity`);
      parity.push({ id, phase, passed: true });
    }
  }
  const candidates = runs.filter((run) => run.variant === "candidate");
  const gate = directionGate(candidates.filter((run) => run.proofMode === "native").flatMap((run) => run.appends));
  const groups = runs.map((run) => ({ cell: run.cell, variant: run.variant, complete: run.passed,
    observedAppends: run.appends.length, validAppends: directionGate(run.appends).validAppends,
    appends: Object.fromEntries(["codex", "dsh"].map((kind) => [kind, stats(run.appends.filter((row) => row.kind === kind).map((row) => row.actualPaintMs))])),
    explicitSwitchMs: stats(run.scopes.filter((row) => !row.mode).map((row) => row.wallMs)),
    initialThroughAllMs: run.first.endedAtMs - run.first.startedAtMs,
    reopenThroughAllMs: run.reopen ? run.reopen.endedAtMs - run.reopen.startedAtMs : null,
    initialCatalog: run.initialStorage.catalog,
    peakSampledServiceMiB: Math.max(...run.resources.map((resource) => resource.service.peakSampledWorkingSetBytes)) / 1048576,
    peakSampledBrowserMiB: Math.max(...run.resources.map((resource) => resource.browser.peakSampledWorkingSetBytes)) / 1048576,
    sampledCpuSeconds: run.resources.reduce((n, resource) => n + resource.service.sampledCpuSecondsIncrement, 0),
    sampledLogicalReadBytes: run.resources.reduce((n, resource) => n + resource.service.sampledLogicalReadBytesIncrement, 0),
    sampledLogicalWriteBytes: run.resources.reduce((n, resource) => n + resource.service.sampledLogicalWriteBytesIncrement, 0),
    finalCatalog: run.finalStorage?.catalog,
    sourceChecks: run.appends.map((row) => ({ kind: row.kind, syncs: row.syncs?.map((sync) => ({
      ms: sync.duration, work: sync.work, delta: sync.delta, sourceWork: sync.sourceWork })) })),
    samplerCoverage: "initial opening and separate service reopen spans; sampled logical IO and CPU may miss short-lived processes",
    toolFailure: run.failure?.message }));
  const native10 = ["baseline", "candidate"].map((variant) => groups.find((group) => group.cell === "10x-native" && group.variant === variant));
  const improvement = native10.every(Boolean) ? Object.fromEntries(["codex", "dsh"].map((kind) =>
    [kind, 1 - native10[1].appends[kind].median / native10[0].appends[kind].median])) : null;
  const stop = gate.stop || (improvement && Object.values(improvement).some((value) => value < matrix.earlyStop.minimum10xImprovement));
  const complete = runs.length === matrix.cells.length && runs.every((run) => run.passed);
  const summary = { generation: "q6", stageStatus: stop ? "stopped-at-direction-gate" : complete ? "matrix-complete" : "in-progress", planned: matrix.planned,
    actual: { appends: runs.reduce((n, run) => n + run.appends.length, 0),
      explicitSwitches: runs.reduce((n, run) => n + run.scopes.filter((row) => !row.mode).length, 0),
      reopens: runs.filter((run) => run.reopen).length, completeGroups: runs.filter((run) => run.passed).length,
      emptyRealHistoryRebuilds: 0 },
    parity, completeMatrixParity: complete && parity.length === matrix.cells.length, gate, improvement10xNative: improvement, groups,
    remainingGroups: matrix.cells.filter((cell) => !runs.some((run) => run.cell === cell.id && run.variant === cell.variant && run.passed))
      .map(({ id, variant }) => ({ id, variant })),
    measuredRuntimeModified: false };
  await writeFile(path.join(BASE, "analysis.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ status: summary.stageStatus, actual: summary.actual, gate, parity, improvement10xNative: improvement,
    groups: groups.map(({ cell, variant, appends, initialThroughAllMs, peakSampledServiceMiB }) => ({ cell, variant, appends, initialThroughAllMs, peakSampledServiceMiB })) }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
