import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUSINESS_FIELDS, normalizeBody } from "./q3-benchmark-support.mjs";
import { stats } from "./q6-performance-analyze.mjs";

const root = path.resolve("output/architecture-20261105/q7");
const read = async (file) => JSON.parse(await readFile(file, "utf8"));
async function ndjson(file) {
  return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
}

export function sampledWindow(samples, start, end) {
  const rows = samples.filter((sample) => sample.atUnixMs >= start && sample.atUnixMs <= end);
  const sum = (name) => rows.reduce((n, row) => n + (row.service[name] || 0), 0);
  return { samples: rows.length, peakServiceMiB: rows.length ? Math.max(...rows.map((row) => row.service.workingSetBytes)) / 2 ** 20 : null,
    sampledCpuSeconds: sum("cpuSecondsIncrement"), sampledReadMiB: sum("logicalReadBytesIncrement") / 2 ** 20,
    sampledWriteMiB: sum("logicalWriteBytesIncrement") / 2 ** 20 };
}

async function main() {
  const matrixA = await read(path.join(root, "reopen-a/matrix.json"));
  const matrixB = await read(path.join(root, "reopen-b/matrix.json"));
  const selection = [];
  for (const proofMode of ["native", "sha"]) for (const variant of ["q5", "q6", "candidate"]) {
    const matrix = proofMode === "sha" && variant === "q5" ? matrixA : matrixB;
    selection.push(matrix.cells.find((cell) => cell.phase === "formal" && cell.proofMode === proofMode && cell.variant === variant));
  }
  assert.ok(selection.every(Boolean));
  const groups = [];
  for (const cell of selection) {
    const run = await read(path.join(cell.directory, "result.json"));
    assert.ok(run.passed, `${cell.proofMode}/${cell.variant}: ${run.failure?.message}`);
    assert.ok(run.fixture.factsIdentical);
    assert.equal(run.reopen.all.total, run.first.all.total);
    assert.ok(run.preparedResponses.filter((_, n) => n % 2 === 1).every((row) => row.cache === "hit"));
    const resourceReports = await Promise.all(run.resourceSpans.map((span) => read(path.join(span.directory, "resources.json"))));
    const reopenSpan = run.resourceSpans.find((span) => span.phase === "reopen");
    const reopenSamples = await ndjson(path.join(reopenSpan.directory, "resources.ndjson"));
    const resources = sampledWindow(reopenSamples, run.reopen.startedAtMs, run.reopen.endedAtMs);
    groups.push({ mode: cell.proofMode, variant: cell.variant, directory: cell.directory,
      reopenMs: run.reopen.endedAtMs - run.reopen.startedAtMs, responseCache: run.reopen.all.cache,
      preparationMs: run.reopen.startedAtMs - run.fixture.endedAtMs,
      peakWholeTrialServiceMiB: Math.max(...resourceReports.map((r) => r.service.peakSampledWorkingSetBytes)) / 2 ** 20,
      peakWholeTrialBrowserMiB: Math.max(...resourceReports.map((r) => r.browser.peakSampledWorkingSetBytes)) / 2 ** 20,
      fullTrialCpu: resourceReports.reduce((n, r) => n + r.service.sampledCpuSecondsIncrement, 0),
      fullTrialReadGiB: resourceReports.reduce((n, r) => n + r.service.sampledLogicalReadBytesIncrement, 0) / 2 ** 30,
      fullTrialWriteGiB: resourceReports.reduce((n, r) => n + r.service.sampledLogicalWriteBytesIncrement, 0) / 2 ** 30,
      reopenResources: resources,
      appends: Object.fromEntries(["codex", "dsh"].map((kind) => [kind,
        stats(run.appends.filter((append) => append.kind === kind).map((append) => append.actualPaintMs))])),
      appendChecks: run.appends.map((append) => ({ kind: append.kind, paintMs: append.actualPaintMs,
        correct: append.responseStatus === 200 && append.responseTotal === append.expectedTotal && append.automaticSseObserved,
        fullFallback: append.fullFallback, nativeAppend: append.nativeAppend, nativeReparse: append.nativeReparse,
        syncs: append.syncs.map((sync) => ({ duration: sync.duration, work: sync.sourceWork })) })),
      body: run.reopen.all.body, run });
  }
  const parity = [];
  for (const mode of ["native", "sha"]) {
    const pair = groups.filter((group) => group.mode === mode);
    const reference = normalizeBody(pair[0].body, pair[0].run);
    for (const group of pair.slice(1)) {
      const value = normalizeBody(group.body, group.run);
      for (const field of [...BUSINESS_FIELDS, "records"]) assert.deepEqual(value.summary[field], reference.summary[field], `${mode}/${group.variant}: ${field}`);
      assert.deepEqual(value.metadata, reference.metadata, `${mode}/${group.variant}: metadata`);
      assert.deepEqual(value.periodComparison, reference.periodComparison, `${mode}/${group.variant}: periods`);
      parity.push({ mode, variant: group.variant, passed: true });
    }
  }
  const gates = [];
  const historical = await read(path.resolve("output/architecture-20261105/q6/q6-20261105-d/analysis.json"));
  for (const mode of ["native", "sha"]) {
    const group = groups.find((row) => row.mode === mode && row.variant === "candidate");
    const q5 = groups.find((row) => row.mode === mode && row.variant === "q5");
    gates.push({ metric: "reopen", mode, actualMs: group.reopenMs, maximumMs: q5.reopenMs * 1.1, passed: group.reopenMs <= q5.reopenMs * 1.1 });
    const reference = historical.groups.find((row) => row.cell === `10x-${mode}` && row.variant === "candidate");
    const historicalQ5 = historical.groups.find((row) => row.cell === `10x-${mode}` && row.variant === "baseline");
    for (const kind of ["codex", "dsh"]) {
      const actualMs = group.appends[kind].median, oldMs = reference.appends[kind].median;
      gates.push({ metric: "refresh", mode, kind, actualMs, referenceMs: oldMs, maximumMs: oldMs * 1.1,
        passed: actualMs <= oldMs * 1.1, referenceScope: "prior Q6 experiment; not simultaneous paired refresh samples" });
      if (mode === "sha") {
        const control = groups.find((row) => row.mode === mode && row.variant === "q6").appends[kind];
        gates.push({ metric: "refresh-current-control", mode, kind, actualMs, referenceMs: control.median,
          referenceSamples: control.n, candidateSamples: group.appends[kind].n, maximumMs: control.median * 1.1,
          passed: actualMs <= control.median * 1.1, referenceScope: "one unchanged Q6 control; candidate samples retained without resampling" });
      }
      if (mode === "native") gates.push({ metric: "native-refresh-original-gate", kind, actualMs,
        maximumMs: Math.min(1500, historicalQ5.appends[kind].median * .7),
        passed: actualMs <= 1500 && actualMs <= historicalQ5.appends[kind].median * .7,
        referenceScope: "prior Q5 experiment; not simultaneous paired refresh samples" });
    }
    assert.ok(group.appendChecks.every((check) => check.correct));
  }
  const strip = ({ body: _body, run: _run, ...row }) => row;
  const result = { status: "measured", parity, groups: groups.map(strip), gates,
    finalSelectedSamples: { reopens: 6, appends: groups.reduce((n, row) => n + row.appendChecks.length, 0) },
    allAttemptedSamples: { diagnosticReopens: 2, formalReopens: 11, appends: 18 },
    excluded: "three native trials used ephemeral auxiliary directories; initial candidate only fixed the first startup check; SHA Q6 control replaced by current calibration; raw results retained in reopen-a",
    limitations: ["one reopen per cell; two append samples per source; no p95", "SHA controls retained from the earlier stable E: setup",
      "refresh <=10% references prior Q6; timing differences alone do not establish a software regression", "CPU/IO are sampled and can miss short-lived processes"] };
  await writeFile(path.join(root, "reopen-b/analysis.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ parity, gates, groups: groups.map(({ mode, variant, reopenMs, responseCache, appends }) => ({ mode, variant, reopenMs, responseCache, appends })) }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
