import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { BUSINESS_FIELDS, normalizeBody } from "./q3-benchmark-support.mjs";
import { stats } from "./q6-performance-analyze.mjs";
import { sampledWindow } from "./q7-reopen-analyze.mjs";
import { BASE, PLANNED, assertMatrix, hashFile, read } from "./q8-refresh-run.mjs";

const ndjson = async (file) => (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const sum = (rows, field) => rows.reduce((n, row) => n + (row[field] || 0), 0);
const startOf = (row) => row.start ?? row.at;

export function compareBodies(a, b, phase) {
  const bodies = [a, b].map((run) => phase === "initial" ? run.first.all.body : phase === "reopen" ? run.reopen.all.body : run.final);
  for (const body of bodies) {
    assert.ok(body?.summary && body.metadata && body.periodComparison, `${phase}: complete business/metadata/period bodies required`);
    for (const field of [...BUSINESS_FIELDS, "records"]) assert.ok(Object.hasOwn(body.summary, field), `${phase}: missing ${field}`);
  }
  const [x, y] = bodies.map((body, index) => normalizeBody(body, [a, b][index], phase === "final"));
  for (const field of [...BUSINESS_FIELDS, "records"])
    assert.ok(isDeepStrictEqual(x.summary[field], y.summary[field]), `${phase}: exact normalized summary.${field} differs`);
  for (const field of ["metadata", "periodComparison"])
    assert.ok(isDeepStrictEqual(x[field], y[field]), `${phase}: exact normalized ${field} differs`);
  return { phase, passed: true, businessFields: [...BUSINESS_FIELDS, "records"], sections: ["metadata", "periodComparison"],
    normalization: "existing normalizeBody, including its final modelLastSeen/activeHarnessModels exclusion",
    clockDependentSummaryFields: ["range", "comparison", "quota (fixed-asOf semantic tests belong to Main)"] };
}

function workTotals(rows) {
  const work = rows.map((row) => row.sourceWork || {}), delta = rows.map((row) => row.delta || {});
  return { parsedBytes: sum(work, "parsedBytes"), prefixBytesRead: sum(work, "prefixBytesRead"), journalBytes: sum(work, "journalBytes"),
    appendedFiles: sum(work, "appendedFiles"), replacedFiles: sum(work, "replacedFiles"),
    proofReadBytes: sum(delta, "proofReads"), nativeJournalBytes: sum(delta, "nativeJournalBytes"),
    discoveries: sum(delta, "discoveries"), enumerations: sum(delta, "enumerations"), fingerprints: sum(delta, "fingerprints") };
}

export function appendWork(run, traces, samples) {
  return run.appends.map((append, index) => {
    const end = run.appends[index + 1]?.appendStartedAtMs ?? Date.parse(run.finishedAt);
    const owned = traces.filter((row) => startOf(row) >= append.appendStartedAtMs && startOf(row) < end);
    const syncs = owned.filter((row) => row.label === "store.sync"), checks = owned.filter((row) => row.label === "store.checkSources");
    const paintSyncs = syncs.filter((row) => startOf(row) <= append.actualPaintAtMs);
    return { id: append.id, kind: append.kind, actualPaintMs: append.actualPaintMs, actualPaintAtMs: append.actualPaintAtMs,
      appendStartedAtMs: append.appendStartedAtMs, appendLandedAtMs: append.appendLandedAtMs, attributionEndMs: end,
      responseStatus: append.responseStatus, responseTotal: append.responseTotal, expectedTotal: append.expectedTotal,
      responseEventCount: append.responseEventCount, automaticSseObserved: append.automaticSseObserved,
      syncCount: syncs.length, syncsStartedThroughPaint: paintSyncs.length, checkCount: checks.length,
      syncTotals: workTotals(syncs), checkTotals: workTotals(checks), syncs, checks,
      acquisition: owned.filter((row) => row.label === "acquisition.prepare"),
      proofs: owned.filter((row) => row.label?.startsWith("proof.")),
      resources: sampledWindow(samples, append.appendStartedAtMs, end),
      paintResources: sampledWindow(samples, append.appendLandedAtMs, append.actualPaintAtMs),
      proofKind: append.proofKind, nativeAppend: append.nativeAppend, nativeReparse: append.nativeReparse,
      fullFallback: append.fullFallback };
  });
}

export function timeGates(groups, limits) {
  const gates = [];
  const gate = (metric, group, actualMs, maximumMs, extra = {}) => gates.push({ metric, mode: group.mode, variant: group.variant,
    actualMs, maximumMs, ...extra, passed: Number.isFinite(actualMs) && Number.isFinite(maximumMs) && actualMs <= maximumMs });
  for (const mode of ["native", "sha"]) {
    const baseline = groups.find((group) => group.mode === mode && group.variant === "q7");
    const candidate = groups.find((group) => group.mode === mode && group.variant === "candidate");
    if (!baseline || !candidate) continue;
    gate("same-mode-reopen", candidate, candidate.reopenMs, baseline.reopenMs * (1 + limits.sameModeMaximumRegression), { referenceMs: baseline.reopenMs });
    for (const kind of ["codex", "dsh"]) {
      const a = baseline.paint[kind]?.median, b = candidate.paint[kind]?.median;
      gate("same-mode-refresh-median", candidate, b, a * (1 + limits.sameModeMaximumRegression), { kind, referenceMs: a });
      if (mode === "native") for (const point of candidate.appends.filter((row) => row.kind === kind))
        gate("native-refresh-absolute", candidate, point.actualPaintMs, limits.nativeRefreshMaximumMs, { kind, append: point.id });
      if (mode === "sha" && kind === "codex") gate("old-sha-codex-debt", candidate, b, limits.oldShaCodexMaximumMs,
        { kind, previousQ7Ms: limits.previousShaCodexMs, previousQ7Passed: false, resetsPriorFailure: false });
    }
  }
  return gates;
}

export async function analyze() {
  const matrix = await read(path.join(BASE, "matrix.json")); assertMatrix(matrix);
  const checks = [], groups = [], runs = new Map();
  const check = (name, action) => {
    try { action(); checks.push({ name, passed: true }); }
    catch (error) { checks.push({ name, passed: false, error: error.message }); }
  };
  const load = async (file) => {
    try { return await read(file); }
    catch (error) { checks.push({ name: file, passed: false, error: error.message }); return null; }
  };
  for (const cell of matrix.cells) {
    const name = `${cell.proofMode}/${cell.variant}`, file = path.join(cell.directory, "result.json");
    const attempt = await load(path.join(cell.directory, "attempt.json")), run = await load(file);
    if (!run) { groups.push({ mode: cell.proofMode, variant: cell.variant, directory: cell.directory, missing: true, attempt }); continue; }
    runs.set(name, run);
    check(`${name}: run`, () => {
      assert.equal(run.passed, true, run.failure?.message); assert.equal(attempt?.status, "passed");
      assert.equal(run.generation, "q8"); assert.equal(run.variant, cell.variant); assert.equal(run.proofMode, cell.proofMode);
      assert.deepEqual(run.prepared, cell.prepared);
      assert.equal(run.fixture?.factsIdentical, true); assert.ok(run.fixture.rawFacts);
      assert.equal(run.fixture.sourceDatabaseFile, cell.prepared.seedDatabaseFile);
      assert.equal(run.appends.length, 4);
      assert.deepEqual(run.appends.map((row) => row.kind), ["codex", "codex", "dsh", "dsh"]);
      assert.equal(run.finalStorage.integrity, "ok");
      assert.equal(run.finalStorage.events.n, run.initialStorage.events.n + 4);
      assert.equal(run.finalStorage.events.total, run.initialStorage.events.total + 5800);
      assert.equal(run.reopen.all.cache, "hit", "Saved all response must be a cache hit after restart");
      assert.ok(run.preparedResponses.length >= 4);
      for (const row of run.preparedResponses.filter((_, index) => index % 2 === 1)) {
        assert.equal(row.status, 200); assert.equal(row.cache, "hit");
      }
      assert.ok(attempt.restoration?.length === 2 && attempt.restoration.every((row) => row.restored));
      assert.ok(run.inputRestoration?.length === 2 && run.inputRestoration.every((row) => row.restored));
      for (const row of run.inputRestoration) assert.equal(row.sha256, Object.values(cell.prior).find((prior) => prior.path === row.path)?.sha256);
      for (const [index, row] of run.appends.entries()) {
        assert.equal(row.status, "passed"); assert.equal(row.responseStatus, 200); assert.equal(row.responseTotal, row.expectedTotal);
        assert.equal(row.responseEventCount, run.first.all.eventCount + index + 1);
        assert.equal(row.automaticSseObserved, true); assert.ok(row.actualPaintMs >= 0 && Number.isFinite(row.actualPaintMs));
        assert.equal(row.inputGrowthBytes, row.appendedBytes);
        assert.equal(row.actualPaintMs, row.actualPaintAtMs - row.appendLandedAtMs);
        if (cell.proofMode === "sha") assert.equal(row.proofKind, "sha256-prefix-v2");
        else assert.ok(row.nativeAppend || row.nativeReparse);
      }
    });
    const reports = [], samples = [], traces = [];
    for (const span of run.resourceSpans || []) {
      const report = await load(path.join(span.directory, "resources.json")); if (report) reports.push({ phase: span.phase, ...report });
      try { samples.push(...await ndjson(path.join(span.directory, "resources.ndjson"))); }
      catch (error) { checks.push({ name: `${name}: raw resource samples`, passed: false, error: error.message }); }
    }
    try {
      for (const entry of await readdir(path.join(cell.directory, "components"))) if (/^trace-.*\.ndjson$/.test(entry))
        traces.push(...await ndjson(path.join(cell.directory, "components", entry)));
    } catch (error) { checks.push({ name: `${name}: raw traces`, passed: false, error: error.message }); }
    traces.sort((a, b) => startOf(a) - startOf(b));
    check(`${name}: resource/heap coverage`, () => {
      assert.deepEqual(reports.map((row) => row.phase), ["initial", "reopen"]);
      assert.ok(samples.length > 0 && traces.some((row) => row.label === "store.sync"));
      for (const report of reports) {
        assert.ok(!report.failure && report.sampleCount > 0);
        assert.ok(Number.isFinite(report.service?.peakSampledWorkingSetBytes));
        assert.ok(Number.isFinite(report.service?.sampledCpuSecondsIncrement));
        assert.ok(Number.isFinite(report.service?.sampledLogicalReadBytesIncrement));
        assert.ok(Number.isFinite(report.service?.sampledLogicalWriteBytesIncrement));
        assert.equal(report.state?.latestComplete, true);
      }
      const heaps = traces.filter((row) => row.label === "hook-start").map((row) => row.heap);
      assert.ok(heaps.some((args) => args.includes("--max-old-space-size=512")));
      assert.ok(heaps.some((args) => args.includes("--max-old-space-size=224") && args.includes("--max-semi-space-size=4")));
    });
    const appends = appendWork(run, traces, samples);
    for (const row of appends) check(`${name}/${row.id}: complete sync byte counters`, () => {
      assert.ok(row.syncCount > 0);
      for (const sync of row.syncs) {
        assert.ok(sync.sourceWork && sync.delta);
        for (const field of ["parsedBytes", "prefixBytesRead", "journalBytes"]) assert.ok(Number.isFinite(sync.sourceWork[field]));
      }
      if (cell.variant === "candidate") assert.equal(row.syncCount, 1, "One controlled append must cause one actual synchronization");
    });
    const peak = reports.length ? Math.max(...reports.map((row) => row.service?.peakSampledWorkingSetBytes ?? NaN)) / 2 ** 20 : null;
    const peakWal = reports.length ? Math.max(...reports.map((row) => row.state?.peakCategoryBytes?.wal ?? 0)) : null;
    const group = { mode: cell.proofMode, variant: cell.variant, directory: cell.directory, passed: run.passed, failure: run.failure,
      resultFile: file, attempt, fixture: run.fixture, initialStorage: run.initialStorage, finalStorage: run.finalStorage,
      preparedResponses: run.preparedResponses, reopenedCache: run.reopen?.all.cache,
      reopenMs: run.reopen ? run.reopen.endedAtMs - run.reopen.startedAtMs : null,
      paint: Object.fromEntries(["codex", "dsh"].map((kind) => [kind, stats(appends.filter((row) => row.kind === kind).map((row) => row.actualPaintMs))])),
      appends, serviceTree: { peakSampledMiB: peak, sampledCpuSeconds: sum(reports.map((row) => row.service || {}), "sampledCpuSecondsIncrement"),
        sampledLogicalReadBytes: sum(reports.map((row) => row.service || {}), "sampledLogicalReadBytesIncrement"),
        sampledLogicalWriteBytes: sum(reports.map((row) => row.service || {}), "sampledLogicalWriteBytesIncrement"), peakSampledWalBytes: peakWal },
      resourceFiles: reports.map((row) => ({ phase: row.phase, samplesFile: row.samplesFile, summaryFile: row.summaryFile })),
      reopenResources: run.reopen ? sampledWindow(samples, run.reopen.startedAtMs, run.reopen.endedAtMs) : null,
      wholeRunSyncCount: traces.filter((row) => row.label === "store.sync").length,
      syncsBeforeFirstAppend: traces.filter((row) => row.label === "store.sync" && startOf(row) < run.appends[0]?.appendStartedAtMs),
      resourceReports: reports.map((row) => ({ phase: row.phase, service: row.service, browser: row.browser, state: row.state, temp: row.temp, warnings: row.warnings })) };
    check(`${name}: service tree <=512 MiB`, () => assert.ok(Number.isFinite(peak) && peak <= matrix.gates.serviceTreeMaximumMiB));
    groups.push(group);
  }
  const parity = [];
  for (const mode of ["native", "sha"]) {
    const a = runs.get(`${mode}/q7`), b = runs.get(`${mode}/candidate`);
    if (!a || !b) continue;
    check(`${mode}: identical seed facts`, () => assert.deepEqual(a.fixture?.rawFacts, b.fixture?.rawFacts));
    for (const phase of ["initial", "reopen", "final"]) check(`${mode}: ${phase} parity`, () => parity.push({ mode, ...compareBodies(a, b, phase) }));
  }
  for (const [file, expected] of Object.entries(matrix.inputHashes)) {
    try { const actual = await hashFile(file); check(`input unchanged: ${file}`, () => assert.equal(actual, expected)); }
    catch (error) { checks.push({ name: `input unchanged: ${file}`, passed: false, error: error.message }); }
  }
  const completeGroups = groups.filter((group) => !group.missing), gates = timeGates(completeGroups, matrix.gates);
  const actual = { groups: completeGroups.length, reopens: completeGroups.filter((row) => row.reopenMs !== null).length,
    appends: completeGroups.reduce((n, group) => n + group.appends.length, 0), emptyImports: 0 };
  check("fixed matrix count", () => assert.deepEqual(actual, PLANNED));
  const result = { generation: "q8", status: checks.every((row) => row.passed) && gates.length === 11 && gates.every((row) => row.passed)
    ? "passed" : "failed-or-incomplete", createdAt: new Date().toISOString(), planned: PLANNED, actual,
    versions: matrix.versions, runtime: matrix.runtime, checks, parity, gates, groups,
    preservedDebt: { maximumMs: 4718, previousQ7Ms: 4852, previousQ7Passed: false, reset: false },
    limitations: ["Two appends per kind and one reopen per cell; no p95 or resampling.",
      "Actual paint uses the existing double-requestAnimationFrame observer; reopen includes startup, sampler preparation and browser opening.",
      "Append trace attribution uses start time until the next append/service close, including syncs finishing after paint; raw traces remain unchanged.",
      "Sync sourceWork and proof deltas/check deltas overlap; do not add these byte counters together.",
      "CPU, logical I/O, RSS and WAL use 500 ms samples; short-lived processes/peaks can be missed. Browser is separate.",
      "Root-cause/second-write/external-input/recovery correctness is verified separately by Main, not inferred from timings."] };
  await writeFile(path.join(BASE, "analysis.json"), JSON.stringify(result, null, 2) + "\n", { flush: true });
  console.log(JSON.stringify({ status: result.status, actual, failedChecks: checks.filter((row) => !row.passed), gates }, null, 2));
  if (result.status !== "passed") process.exitCode = 1;
  return result;
}

function selfcheck() {
  const first = { metadata: { homes: [] }, summary: Object.fromEntries([...BUSINESS_FIELDS, "records"].map((key) => [key, {}])), periodComparison: {} };
  const fixture = () => ({ prepared: { home: "C:/fixture" }, first: { all: { body: structuredClone(first) } },
    reopen: { all: { body: structuredClone(first) } }, final: structuredClone(first) });
  const a = fixture(), b = fixture();
  for (const phase of ["initial", "reopen", "final"]) assert.equal(compareBodies(a, b, phase).passed, true);
  b.final.metadata.eventCount = 1; assert.throws(() => compareBodies(a, b, "final"));
  b.final = structuredClone(a.final); b.final.summary.totals = { value: 1 }; assert.throws(() => compareBodies(a, b, "final"));
  b.final = structuredClone(a.final); b.final.summary.quota = { asOf: "different" }; assert.equal(compareBodies(a, b, "final").passed, true);
  b.final = structuredClone(a.final); delete b.final.periodComparison; assert.throws(() => compareBodies(a, b, "final"));
  const sync = (start, end, bytes) => ({ label: "store.sync", start, at: end, sourceWork: { parsedBytes: bytes } });
  const run = { appends: [{ id: "codex-1", kind: "codex", appendStartedAtMs: 100, appendLandedAtMs: 101, actualPaintAtMs: 150 },
    { id: "dsh-2", kind: "dsh", appendStartedAtMs: 200, appendLandedAtMs: 201, actualPaintAtMs: 250 }], finishedAt: new Date(400).toISOString() };
  const points = appendWork(run, [sync(90, 95, 999), sync(110, 170, 3), sync(180, 199, 5), sync(210, 280, 7)], []);
  assert.deepEqual(points.map((row) => [row.syncCount, row.syncsStartedThroughPaint, row.syncTotals.parsedBytes]), [[2, 1, 8], [1, 1, 7]]);
  const groups = ["native", "sha"].flatMap((mode) => ["q7", "candidate"].map((variant) => ({ mode, variant,
    reopenMs: 100, paint: { codex: { median: mode === "sha" ? 4800 : 100 }, dsh: { median: 100 } },
    appends: [{ id: "a", kind: "codex", actualPaintMs: 100 }, { id: "b", kind: "codex", actualPaintMs: 100 },
      { id: "c", kind: "dsh", actualPaintMs: 100 }, { id: "d", kind: "dsh", actualPaintMs: 100 }] })));
  const gates = timeGates(groups, { sameModeMaximumRegression: .1, nativeRefreshMaximumMs: 1500, oldShaCodexMaximumMs: 4718, previousShaCodexMs: 4852 });
  assert.equal(gates.length, 11);
  assert.equal(gates.find((row) => row.metric === "old-sha-codex-debt").passed, false);
  assert.equal(gates.find((row) => row.metric === "same-mode-refresh-median" && row.mode === "sha" && row.kind === "codex").passed, true);
  console.log(JSON.stringify({ selfcheck: "passed", servicesStarted: 0, writes: 0 }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "selfcheck") selfcheck(); else { assert.equal(process.argv.length, 2); await analyze(); }
}
