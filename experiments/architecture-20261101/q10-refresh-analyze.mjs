import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { BASE, PLANNED } from "./q10-refresh-run.mjs";
import { ROOT, HERE, hashFile, read, save } from "./q9-benchmark.mjs";
import { totals, assertSyncWork } from "./q9-analyze.mjs";

const median = (values) => { const a = [...values].sort((x, y) => x - y); return (a[Math.floor((a.length - 1) / 2)] + a[Math.ceil((a.length - 1) / 2)]) / 2; };
export function limits(mode, kind) { return mode === "native" ? (kind === "codex" ? 970.9699462890626 : 1054.4598388671875) : (kind === "codex" ? 5289.130053710938 : 2444.640161132813); }
async function analyze() {
  const matrix = await read(path.join(BASE, "matrix.json")), checks = [], gates = [], groups = [];
  const check = (name, fn) => { try { fn(); checks.push({ name, passed: true }); } catch (error) { checks.push({ name, passed: false, error: error.message }); } };
  const gate = (name, actual, maximum, details) => gates.push({ name, actual, maximum, ...details, passed: Number.isFinite(actual) && actual <= maximum });
  const { BUSINESS_FIELDS, normalizeBody } = await import(pathToFileURL(path.join(ROOT, "output/architecture-20261105/q9/versions/q8", HERE, "q3-benchmark-support.mjs")).href);
  for (const cell of matrix.cells) {
    const run = await read(path.join(cell.directory, "result.json")), attempt = await read(path.join(cell.directory, "attempt.json"));
    const traces = [];
    for (const file of await readdir(path.join(cell.directory, "components"))) if (/^(trace|q9|q10)-.*\.ndjson$/.test(file))
      traces.push(...(await readFile(path.join(cell.directory, "components", file), "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse));
    const resources = await Promise.all(run.resourceSpans.map((r) => read(path.join(r.directory, "resources.json"))));
    const points = (run.newSessions || run.appends).map((p) => {
      const start = p.startedAtMs ?? p.appendStartedAtMs, end = p.endedAtMs;
      const owned = traces.filter((r) => (r.start ?? r.at) >= start && (r.start ?? r.at) <= end), syncs = owned.filter((r) => r.label === "store.sync");
      return { id: p.id, kind: p.kind, paintMs: p.createToPaintMs ?? p.actualPaintMs, syncs, work: totals(syncs),
        parse: ((run.appendDelivery || run.delivery)?.rows || []).filter((r) => r.kind === "json-consumed" && r.clock >= start && r.clock <= end),
        syncMs: syncs.reduce((n, r) => n + r.duration, 0) };
    });
    const group = { id: cell.id, mode: cell.proofMode, variant: cell.variant, suite: cell.suite, points, run, resources,
      peakMiB: Math.max(...resources.map((r) => r.service.peakSampledWorkingSetBytes)) / 2 ** 20,
      reopens: (run.reopens || []).map((r) => ({ ms: r.endedAtMs - r.startedAtMs, cache: r.all.cache })),
      nativeFailures: traces.filter((r) => r.label === "native-directory" && !r.ok) };
    groups.push(group);
    check(`${cell.id}: source/new-value/recovery contract`, () => {
      assert.equal(run.passed, true, run.failure?.message); assert.equal(attempt.status, "passed");
      assert.equal(run.generation, "q10"); assert.equal(run.fixture.factsIdentical, true);
      assert.equal(run.finalStorage.integrity, "ok"); assert.equal(run.delivery.dropped, 0);
      assert.ok(attempt.restoration.every((r) => r.restored)); assert.equal(attempt.inventory.identical, true);
      assert.ok(run.inputRestoration.every((r) => r.restored));
      assert.equal(run.finalStorage.events.n, run.initialStorage.events.n + 4);
      assert.equal(run.finalStorage.events.total, run.initialStorage.events.total + 5800);
      assert.ok(resources.every((r) => !r.failure && r.sampleCount > 0 && r.state.latestComplete));
      assert.equal(resources.length, cell.suite === "new" ? 1 : 3);
      if (cell.suite === "refresh") { assert.equal(run.appends.length, 4); assert.equal(run.reopens.length, 2); }
      else assert.equal(run.newSessions.length, 4);
      for (const p of run.newSessions || run.appends) {
        assert.equal(p.status, "passed"); assert.equal(p.automaticSseObserved, true); assert.equal(p.responseStatus, 200);
        if (cell.suite === "refresh") {
          if (cell.proofMode === "sha") assert.equal(p.proofKind, "sha256-prefix-v2"); else assert.ok(p.nativeAppend || p.nativeReparse);
        }
      }
      for (const point of points) { assert.ok(point.syncs.length > 0); point.syncs.forEach(assertSyncWork); }
    });
    gate("service-MiB", group.peakMiB, 512, { id: cell.id });
    if (cell.suite === "new") check("four bounded additions", () => {
      for (const p of points) {
        for (const key of ["discoveries", "enumerations", "catalogClearStatements", "wholeInventoryReads", "inventoryDirectoryCalls"]) assert.equal(p.work[key], 0);
        assert.equal(p.work.replacedFiles, 1); assert.equal(p.work.capturedFiles, 1);
        assert.equal(p.work.parsedBytes, run.newSessions.find((r) => r.id === p.id).bytes);
        gate("new-session-ms", p.paintMs, 1500, { point: p.id });
      }
    });
    if (cell.variant === "candidate" && cell.suite === "refresh") {
      for (const point of points) gate("original-Q8-refresh-ms", point.paintMs, limits(cell.proofMode, point.kind), { mode: cell.proofMode, point: point.id });
      for (const [index, reopen] of group.reopens.entries()) {
        gate("original-Q8-reopen-ms", reopen.ms, cell.proofMode === "native" ? 3887.4 : 3190, { mode: cell.proofMode, index });
        check(`${cell.id}: reopen ${index} reusable`, () => assert.equal(reopen.cache, "hit"));
      }
    }
  }
  let businessComparisons = 0;
  for (const mode of ["native", "sha"]) {
    const pair = ["q9", "candidate"].map((variant) => groups.find((g) => g.mode === mode && g.variant === variant && g.suite === "refresh"));
    const runs = pair.map((g) => g.run);
    check(`${mode}: same starting facts`, () => assert.deepEqual(runs[0].fixture.rawFacts, runs[1].fixture.rawFacts));
    const bodies = [runs.map((r) => r.first.all.body), runs.map((r) => r.final),
      ...[0, 1].map((i) => runs.map((r) => r.reopens[i].all.body)), ...[0, 1, 2, 3].map((i) => runs.map((r) => r.appends[i].body))];
    for (let i = 0; i < bodies.length; i++) check(`${mode}: exact business ${i}`, () => {
      const normalized = bodies[i].map((body, j) => normalizeBody(body, runs[j], false));
      for (const field of [...BUSINESS_FIELDS, "records"]) { assert.deepEqual(normalized[0].summary[field], normalized[1].summary[field]); businessComparisons++; }
      assert.deepEqual(normalized[0].metadata, normalized[1].metadata); businessComparisons++;
      assert.deepEqual(normalized[0].periodComparison, normalized[1].periodComparison); businessComparisons++;
    });
    for (const kind of ["codex", "dsh"]) gate("same-round-refresh-median-ms", median(pair[1].points.filter((p) => p.kind === kind).map((p) => p.paintMs)),
      median(pair[0].points.filter((p) => p.kind === kind).map((p) => p.paintMs)) * 1.1, { mode, kind });
    for (let index = 0; index < 2; index++) gate("same-phase-reopen-ms", pair[1].reopens[index].ms, pair[0].reopens[index].ms * 1.1, { mode, index });
  }
  const actual = { groups: groups.filter((g) => g.suite === "refresh").length,
    appends: groups.filter((g) => g.suite === "refresh").reduce((n, g) => n + g.points.length, 0),
    reopens: groups.reduce((n, g) => n + g.reopens.length, 0),
    newSessions: groups.filter((g) => g.suite === "new").reduce((n, g) => n + g.points.length, 0), emptyImports: 0 };
  check("fixed matrix counts", () => assert.deepEqual(actual, PLANNED));
  for (const [file, hash] of Object.entries(matrix.inputHashes)) {
    const actualHash = await hashFile(file); check(`unchanged input ${file}`, () => assert.equal(actualHash, hash));
  }
  const result = { actual, checks, gates, groups, businessComparisons, createdAt: new Date().toISOString(),
    status: checks.every((c) => c.passed) && gates.every((g) => g.passed) ? "passed" : "failed" };
  await save(path.join(BASE, "analysis.json"), result);
  console.log(JSON.stringify({ status: result.status, actual, businessComparisons, failures: checks.filter((c) => !c.passed), failedGates: gates.filter((g) => !g.passed) }));
  if (result.status !== "passed") process.exitCode = 1;
}
export function selfcheck() {
  assert.equal(median([100, 200]), 150); assert.equal(median([200]), 200);
  assert.ok(limits("native", "codex") < 1500 && limits("sha", "codex") < 5610);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "selfcheck") { selfcheck(); console.log("Q10 analyzer selfcheck passed"); } else await analyze();
}
