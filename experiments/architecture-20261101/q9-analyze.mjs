import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BASE, HERE, PLANNED, assertMatrix, hashFile, read, save } from "./q9-benchmark.mjs";
import { CASES } from "./q9-sessions.mjs";

const ndjson = async (file) => (await readFile(file, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const start = (row) => row.start ?? row.at;
const sum = (rows, key) => rows.reduce((n, row) => n + (row[key] || 0), 0);
const COUNTS = ["discoveries", "enumerations", "fingerprints", "catalogDeleteStatements", "catalogClearStatements",
  "wholeInventoryReads", "fullInventoryPasses", "inventoryDirectoryCalls", "capturedFiles", "proofReads", "nativeJournalBytes"];
export function totals(syncs) {
  return { ...Object.fromEntries(COUNTS.map((key) => [key, sum(syncs.map((s) => s.delta || {}), key)])),
    ...Object.fromEntries(["appendedFiles", "replacedFiles", "parsedBytes", "prefixBytesRead", "journalBytes"]
      .map((key) => [key, sum(syncs.map((s) => s.sourceWork || {}), key)])) };
}
export function assertSyncWork(sync) {
  assert.ok(sync.delta);
  for (const key of COUNTS) assert.ok(Number.isFinite(sync.delta[key]), `Missing counter ${key}`);
  if (sync.sourceWork) {
    for (const key of ["parsedBytes", "prefixBytesRead", "journalBytes"]) assert.ok(Number.isFinite(sync.sourceWork[key]));
  } else {
    // A refused certified-only probe has not started parsing; the full sync follows.
    assert.equal(sync.certifiedOnly, true); assert.equal(sync.returned, false); assert.equal(sync.receipt, false);
    assert.equal(sync.work?.mode, "fallback"); assert.ok(!sync.error);
    for (const key of COUNTS) assert.equal(sync.delta[key], 0, `Refused probe performed ${key}`);
  }
}
export function pointsFor(run, traces) {
  const rows = run.newSessions || run.appends;
  return rows.map((point, index) => {
    const begin = point.startedAtMs ?? point.appendStartedAtMs;
    const end = rows[index + 1]?.startedAtMs ?? Date.parse(run.finishedAt);
    const owned = traces.filter((r) => start(r) >= begin && start(r) < end);
    const syncs = owned.filter((r) => r.label === "store.sync");
    return { ...point, attributionEndMs: end, syncCount: syncs.length, syncs,
      syncTotals: totals(syncs), checkTotals: totals(owned.filter((r) => r.label === "store.checkSources")),
      sql: owned.filter((r) => r.label === "sql-inventory"),
      acquisition: owned.filter((r) => r.label === "acquisition.prepare"),
      sseSends: owned.filter((r) => r.label === "sse-send"),
      paintMs: point.createToPaintMs ?? point.actualPaintMs };
  });
}
export function gatesFor(groups, limits) {
  const gates = [];
  const gate = (name, actual, maximum, details) => gates.push({ name, actual, maximum, ...details,
    passed: Number.isFinite(actual) && Number.isFinite(maximum) && actual <= maximum });
  for (const g of groups) {
    gate("service-tree-MiB", g.peakMiB, limits.serviceTreeMaximumMiB, { id: g.id });
    if (g.suite === "new" && g.variant === "candidate") for (const p of g.points)
      gate("new-session-create-to-paint-ms", p.paintMs, limits.newSessionMaximumMs, { id: g.id, point: p.id });
  }
  for (const variant of ["q8", "candidate"]) for (const id of CASES) {
    const small = groups.find((g) => g.suite === "new" && g.variant === variant && g.fileCount === 2000)?.points.find((p) => p.id === id);
    const large = groups.find((g) => g.suite === "new" && g.variant === variant && g.fileCount === 20000)?.points.find((p) => p.id === id);
    // The Q8 ratio is retained as evidence; Q9 acceptance applies to the candidate.
    if (variant === "candidate") gate("2k-to-20k-ratio", large?.paintMs / small?.paintMs, limits.fileCountMaximumRatio, { variant, point: id });
  }
  for (const mode of ["native", "sha"]) {
    const a = groups.find((g) => g.suite === "refresh" && g.mode === mode && g.variant === "q8");
    const b = groups.find((g) => g.suite === "refresh" && g.mode === mode && g.variant === "candidate");
    gate("same-mode-reopen-ms", b?.reopenMs, a?.reopenMs * (1 + limits.sameModeMaximumRegression), { mode });
    for (const kind of ["codex", "dsh"]) gate("same-mode-refresh-ms", b?.points.find((p) => p.kind === kind)?.paintMs,
      a?.points.find((p) => p.kind === kind)?.paintMs * (1 + limits.sameModeMaximumRegression), { mode, kind });
  }
  return gates;
}

async function analyze() {
  const matrix = await read(path.join(BASE, "matrix.json")); assertMatrix(matrix);
  const { BUSINESS_FIELDS, normalizeBody } = await import(pathToFileURL(path.join(BASE, "versions/q8", HERE, "q3-benchmark-support.mjs")).href);
  const checks = [], groups = [], runs = new Map(), parity = [], ratios = [];
  const check = (name, fn) => { try { fn(); checks.push({ name, passed: true }); }
    catch (e) { checks.push({ name, passed: false, error: e.message }); } };
  for (const cell of matrix.cells) {
    let run, attempt;
    try { run = await read(path.join(cell.directory, "result.json")); attempt = await read(path.join(cell.directory, "attempt.json")); }
    catch (e) { checks.push({ name: cell.id, passed: false, error: e.message }); continue; }
    runs.set(cell.id, run);
    const traces = [], reports = [];
    try {
      for (const file of await readdir(path.join(cell.directory, "components"))) if (/^(trace|q9)-.*\.ndjson$/.test(file))
        traces.push(...await ndjson(path.join(cell.directory, "components", file)));
      for (const span of run.resourceSpans) reports.push({ phase: span.phase, ...await read(path.join(span.directory, "resources.json")) });
    } catch (e) { checks.push({ name: `${cell.id}: traces/resources`, passed: false, error: e.message }); }
    const points = pointsFor(run, traces), group = { id: cell.id, suite: cell.suite, variant: cell.variant, mode: cell.proofMode,
      fileCount: cell.fileCount, points, reopenMs: run.reopen ? run.reopen.endedAtMs - run.reopen.startedAtMs : null,
      initialStorage: run.initialStorage, finalStorage: run.finalStorage, setup: run.q9Setup, fixture: run.fixture, attempt,
      peakMiB: reports.length ? Math.max(...reports.map((r) => r.service?.peakSampledWorkingSetBytes ?? NaN)) / 2 ** 20 : NaN,
      resources: reports, setupCounters: totals(traces.filter((r) => r.label === "store.sync" && start(r) < (points[0]?.startedAtMs ?? Infinity))) };
    groups.push(group);
    check(`${cell.id}: exact observation/restoration contract`, () => {
      assert.equal(run.passed, true, run.failure?.message); assert.equal(attempt.status, "passed");
      assert.equal(run.generation, "q9"); assert.deepEqual(run.prepared, cell.prepared);
      assert.equal(run.fixture?.factsIdentical, true); assert.ok(run.fixture.rawFacts);
      assert.equal(run.fixture.sourceDatabaseFile, cell.prepared.seedDatabaseFile);
      assert.equal(attempt.restoration?.length, 2); assert.ok(attempt.restoration.every((r) => r.restored));
      assert.equal(attempt.sourceInventoryRestoration?.identical, true);
      assert.equal(run.inputRestoration?.length, 2); assert.ok(run.inputRestoration.every((r) => r.restored));
      assert.equal(run.finalStorage.integrity, "ok"); assert.equal(run.delivery?.dropped, 0);
      assert.equal(run.finalStorage.events.n, run.initialStorage.events.n + (cell.suite === "new" ? 4 : 2));
      assert.equal(run.finalStorage.events.total, run.initialStorage.events.total + (cell.suite === "new" ? 5800 : 2900));
      if (cell.suite === "new") {
        assert.deepEqual(run.newSessions?.map((p) => p.id), CASES); assert.equal(run.appends.length, 0); assert.ok(!run.reopen);
        assert.equal(run.q9Setup.sourceFiles, cell.fileCount);
      } else {
        assert.deepEqual(run.appends.map((p) => p.kind), ["codex", "dsh"]); assert.ok(!run.newSessions);
        assert.equal(run.reopen.all.total, run.first.all.total);
      }
      assert.equal(reports.length, cell.suite === "new" ? 1 : 2);
      for (const report of reports) assert.ok(!report.failure && report.sampleCount > 0 && report.state?.latestComplete);
      const heaps = traces.filter((r) => r.label === "hook-start").map((r) => r.heap);
      assert.ok(heaps.some((args) => args.includes("--max-old-space-size=512")));
      assert.ok(heaps.some((args) => args.includes("--max-old-space-size=224") && args.includes("--max-semi-space-size=4")));
      for (const [index, p] of points.entries()) {
        assert.equal(p.status, "passed"); assert.equal(p.automaticSseObserved, true); assert.equal(p.responseStatus, 200);
        assert.ok(p.body?.summary && p.body.metadata && p.body.periodComparison, "Original page body incomplete");
        assert.equal(p.body.summary.eventCount, run.first.all.eventCount + index + 1);
        assert.ok(p.paintMs >= 0 && Number.isFinite(p.paintMs)); assert.ok(p.syncCount > 0);
        assert.ok(p.sseSends.some((s) => s.event === "usage-synced"));
        for (const s of p.syncs) assertSyncWork(s);
        if (cell.suite === "refresh") {
          if (cell.proofMode === "sha") assert.equal(p.proofKind, "sha256-prefix-v2");
          else assert.ok(p.nativeAppend || p.nativeReparse);
        }
      }
    });
    if (cell.suite === "refresh") check(`${cell.id}: reopen cached state reuse`, () => assert.equal(run.reopen.all.cache, "hit"));
    if (cell.suite === "new" && cell.variant === "candidate") check(`${cell.id}: bounded acquisition`, () => {
      for (const p of points) {
        assert.equal(p.syncCount, 1);
        for (const key of ["discoveries", "enumerations", "catalogDeleteStatements", "catalogClearStatements", "wholeInventoryReads", "fullInventoryPasses", "inventoryDirectoryCalls"])
          assert.equal(p.syncTotals[key], 0, `${p.id}: unexpected ${key}`);
        assert.equal(p.syncTotals.replacedFiles, 1); assert.equal(p.syncTotals.appendedFiles, 0);
        assert.equal(p.syncTotals.parsedBytes, p.bytes, "New session must directly parse exactly its own bytes");
      }
    });
  }
  for (const suite of ["new", "refresh"]) for (const context of suite === "new" ? [2000, 20000] : ["native", "sha"]) {
    const pair = ["q8", "candidate"].map((variant) => {
      const cell = matrix.cells.find((c) => c.suite === suite && c.variant === variant && (suite === "new" ? c.fileCount === context : c.proofMode === context));
      return runs.get(cell.id);
    });
    if (pair.some((r) => !r)) continue;
    check(`${suite}/${context}: identical seed facts`, () => assert.deepEqual(pair[0].fixture.rawFacts, pair[1].fixture.rawFacts));
    const bodyPairs = [["initial", ...pair.map((r) => r.first.all.body)], ["final", ...pair.map((r) => r.final)]];
    if (suite === "refresh") bodyPairs.push(["reopen", ...pair.map((r) => r.reopen?.all.body)]);
    const points = pair.map((r) => r.newSessions || r.appends);
    for (let i = 0; i < points[0].length; i++) bodyPairs.push([points[0][i].id, points[0][i].body, points[1][i]?.body]);
    for (const [phase, a, b] of bodyPairs) check(`${suite}/${context}/${phase}: exact business/meta/period parity`, () => {
      const normalized = [a, b].map((body, i) => {
        assert.ok(body?.summary && body.metadata && body.periodComparison);
        return normalizeBody(body, pair[i], false);
      });
      for (const key of [...BUSINESS_FIELDS, "records"]) {
        assert.ok(Object.hasOwn(normalized[0].summary, key) && Object.hasOwn(normalized[1].summary, key));
        assert.deepEqual(normalized[0].summary[key], normalized[1].summary[key], key);
      }
      assert.deepEqual(normalized[0].metadata, normalized[1].metadata);
      assert.deepEqual(normalized[0].periodComparison, normalized[1].periodComparison);
      parity.push({ suite, context, phase, passed: true, fields: [...BUSINESS_FIELDS, "records", "metadata", "periodComparison"] });
    });
  }
  for (const variant of ["q8", "candidate"]) for (const id of CASES) {
    const pair = [2000, 20000].map((size) => groups.find((g) => g.suite === "new" && g.variant === variant && g.fileCount === size)?.points.find((p) => p.id === id));
    if (pair.some((p) => !p)) continue;
    check(`${variant}/${id}: same parse path at 2k and 20k`, () => {
      assert.equal(pair[0].sha256, pair[1].sha256); assert.equal(pair[0].bytes, pair[1].bytes);
      for (const key of ["replacedFiles", "appendedFiles", "parsedBytes"]) assert.equal(pair[0].syncTotals[key], pair[1].syncTotals[key], key);
    });
    ratios.push({ variant, point: id, ratio: pair[1].paintMs / pair[0].paintMs, smallMs: pair[0].paintMs, largeMs: pair[1].paintMs });
  }
  for (const [file, hash] of Object.entries(matrix.inputHashes)) {
    try { const actual = await hashFile(file); check(`input unchanged: ${file}`, () => assert.equal(actual, hash)); }
    catch (e) { checks.push({ name: file, passed: false, error: e.message }); }
  }
  const actual = { services: groups.length, newSessions: groups.filter((g) => g.suite === "new").reduce((n, g) => n + g.points.length, 0),
    appends: groups.filter((g) => g.suite === "refresh").reduce((n, g) => n + g.points.length, 0),
    reopens: groups.filter((g) => g.reopenMs !== null).length, emptyImports: 0 };
  check("exact matrix", () => assert.deepEqual(actual, PLANNED));
  const gates = gatesFor(groups, matrix.gates), result = { generation: "q9", planned: PLANNED, actual, checks, gates, groups, ratios, parity,
    status: checks.every((c) => c.passed) && gates.length === 26 && gates.every((g) => g.passed) ? "passed" : "failed-or-incomplete",
    createdAt: new Date().toISOString(),
    accounting: { initialBrowserOpenIsReopen: false, initAndCatalogExcludedFromDeltas: true,
      newSessionClock: "before mkdir/write through original-page double-rAF paint; landed-to-paint retained too",
      syncVsCheckCountersOverlap: true, setup: matrix.setup, heaps: matrix.heaps },
    limitations: ["One observation per matrix point; every raw attempt is retained and slow points are not resampled.",
      "500ms resource samples may miss brief peaks; browser memory is reported separately from the service tree.",
      "Exact parity uses Q8 business fields plus records, metadata and periodComparison with existing volatile-clock normalization."] };
  await save(path.join(BASE, "analysis.json"), result);
  console.log(JSON.stringify({ status: result.status, actual, failures: checks.filter((c) => !c.passed), gates }, null, 2));
  if (result.status !== "passed") process.exitCode = 1;
}

export function selfcheck() {
  const probe = { certifiedOnly: true, returned: false, receipt: false, work: { mode: "fallback" },
    delta: Object.fromEntries(COUNTS.map((key) => [key, 0])) };
  assertSyncWork(probe);
  assert.throws(() => assertSyncWork({ ...probe, returned: true }));
  assert.throws(() => assertSyncWork({ ...probe, delta: { ...probe.delta, parsedBytes: 1, capturedFiles: 1 } }));
  assertSyncWork({ ...probe, sourceWork: { parsedBytes: 1, prefixBytesRead: 0, journalBytes: 0 } });
  const run = { appends: [{ startedAtMs: 100, actualPaintMs: 20 }, { startedAtMs: 200, actualPaintMs: 30 }], finishedAt: new Date(400).toISOString() };
  const points = pointsFor(run, [90, 110, 180, 210].map((at) => ({ label: "store.sync", start: at, at: at + 30,
    sourceWork: { parsedBytes: 1 }, delta: { catalogClearStatements: 1 } })));
  assert.deepEqual(points.map((p) => [p.syncCount, p.syncTotals.parsedBytes, p.syncTotals.catalogClearStatements]), [[2, 2, 2], [1, 1, 1]]);
  const groups = [2000, 20000].flatMap((fileCount) => ["q8", "candidate"].map((variant) => ({ id: `${fileCount}/${variant}`, suite: "new", fileCount, variant,
    peakMiB: 100, points: CASES.map((id) => ({ id, paintMs: 100 })) }))).concat(["native", "sha"].flatMap((mode) => ["q8", "candidate"].map((variant) =>
    ({ id: `${mode}/${variant}`, suite: "refresh", mode, variant, peakMiB: 100, reopenMs: 100, points: ["codex", "dsh"].map((kind) => ({ kind, paintMs: 100 })) }))));
  const limits = { serviceTreeMaximumMiB: 512, newSessionMaximumMs: 1500, fileCountMaximumRatio: 1.3, sameModeMaximumRegression: .1 };
  assert.equal(gatesFor(groups, limits).length, 26); assert.ok(gatesFor(groups, limits).every((g) => g.passed));
  groups[3].points[0].paintMs = 140;
  assert.ok(gatesFor(groups, limits).some((g) => g.name === "2k-to-20k-ratio" && !g.passed));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "selfcheck") { selfcheck(); console.log(JSON.stringify({ selfcheck: "passed", servicesStarted: 0 })); }
  else { assert.equal(process.argv.length, 2); await analyze(); }
}
