import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze, COMPACTION, STAGES, maintenanceGate, packageGate, upgradeGate } from "./archive-compaction-analyze.mjs";
import { analyze as analyzeVerification, latencyGates, timings, verificationGate } from "./archive-verification-analyze.mjs";
import { save } from "./c1-datasets.mjs";
import { deriveResources, withDerivedResources } from "./resource-identity-analysis.mjs";

const hash = text => createHash("sha256").update(text).digest("hex");
const packages = () => Object.entries({ current: 1, year: 4, "two-years": 8 }).flatMap(([label, count]) =>
  Array.from({ length: count }, (_, index) => ({ label, index,
    previous: { databaseFile: path.resolve("fixture", label, `old-${index}.sqlite`), sha256: hash(`${label}-old-${index}`), bytes: 10000 },
    next: { databaseFile: path.resolve("fixture", label, `new-${index}.sqlite`), sha256: hash(`${label}-new-${index}`), bytes: 5500 } })));
const scene = ms => ({ defaultPaintWallMs: ms, initialServiceWallMs: ms, initialAll: { wallMs: ms }, reopen: { wallMs: ms },
  changes: ["codex", "dsh", "claude", "workbuddy", "zcode", "opencode"].map(kind => ({ name: `append-${kind}`, actualPaintMs: ms })).concat({ name: "revision-zcode", actualPaintMs: ms }),
  scopes: ["today", "week", "custom", "all"].map(preset => ({ preset, wallMs: ms })), reuseChecks: { repeat: { wallMs: ms }, afterExit: { wallMs: ms } } });

test("Gate C exact latency boundaries, improvement and original year gates leave the legacy defaults intact", () => {
  assert.deepEqual(STAGES, { current: 4, year: 8, all: 10 });
  for (const [name, limit] of Object.entries(COMPACTION.twoYearLimitsMs)) {
    const gates = value => latencyGates("two-years", "mixed", scene(100000), scene(value), {}, {}, COMPACTION).find(row => row.name === name);
    assert.equal(gates(limit).passed, true, name);
    assert.equal(gates(limit + 0.01).passed, false, name);
  }
  for (const name of COMPACTION.improve) {
    const gates = latencyGates("two-years", "mixed", scene(34000), scene(34000), {}, {}, COMPACTION);
    assert.equal(gates.find(row => row.name === name).passed, false, `${name}: must improve in the same run`);
  }
  for (const [baseline, candidate, pass] of [[1000, 1100, true], [1000, 1100.01, false], [100, 199, true]])
    assert.ok(latencyGates("current", "hot", scene(baseline), scene(candidate), {}, {}, COMPACTION).every(row => row.passed === pass));
  assert.throws(() => latencyGates("year", "mixed", scene(1000), scene(900), {}, {}, COMPACTION), /missing original year/);
  const c1 = Object.fromEntries(latencyGates("current", "hot", scene(1000), scene(1000)).map(row => [row.name, 5000]));
  assert.ok(latencyGates("year", "mixed", scene(1000), scene(1000), c1, {}, COMPACTION).every(row => row.passed));
  assert.equal(latencyGates("year", "mixed", scene(1000), scene(1001), c1, {}, COMPACTION).find(row => row.name === "append-codex").passed, false);
  assert.equal(latencyGates("two-years", "mixed", scene(100000), scene(44000)).find(row => row.name === "append-codex").passed, true);
  assert.equal(latencyGates("two-years", "mixed", scene(100000), scene(44000), {}, {}, COMPACTION).find(row => row.name === "append-codex").passed, false);
});

test("stage packages cover 1/4/8 identities and the two-year 55% byte limit is inclusive", () => {
  const rows = packages();
  assert.deepEqual(packageGate(rows, "current").map(row => row.packages), [1]);
  assert.deepEqual(packageGate(rows, "year").map(row => row.packages), [1, 4]);
  assert.deepEqual(packageGate(rows, "all").map(row => row.packages), [1, 4, 8]);
  rows.at(-1).next.bytes++;
  assert.throws(() => packageGate(rows, "all"), /55%/);
  assert.doesNotThrow(() => packageGate(rows, "year"));
  assert.throws(() => packageGate(rows.slice(1), "current"), /package coverage/);
  assert.throws(() => packageGate(packages(), "other"), /stage/);
});

function verificationFixture(variant = "candidate", label = "two-years") {
  const all = packages(), selected = all.filter(row => row.label === label), rows = [];
  let sequence = 0;
  const hashes = start => selected.flatMap((row, index) => ["sha-before-lock", "sha-inside-lock"].map((stage, phase) => {
    const entry = row[variant === "baseline" ? "previous" : "next"];
    return { id: `span-${++sequence}`, pid: 7, stage, startedAtMs: start + index * 2 + phase,
      endedAtMs: start + index * 2 + phase + 1, durationMs: 1, stack: "fixture", file: entry.databaseFile, bytes: entry.bytes, sha256: entry.sha256 };
  }));
  const startup = hashes(10);
  rows.push({ stage: "process-born" }, ...startup, ...hashes(220), ...hashes(720), { stage: "process-exit" });
  const value = { label, layout: "mixed", serviceStartedAtMs: 0, initialAll: { endedAtMs: 100 },
    changes: [{ name: "append-codex", landedAtMs: 200, endedAtMs: 300 }], scopes: [],
    reuseChecks: { repeat: { startedAtMs: 450, endedAtMs: 500 }, afterExit: { startedAtMs: 550, endedAtMs: 600 } },
    reopen: { serviceStartedAtMs: 700, endedAtMs: 900 } };
  const measured = { nodes: [{ pid: 7, role: "executor" }], history: [], sync: [], publications: [], archiveProofs: rows.filter(row => row.id) };
  return { scene: value, measured, rows, options: { ...COMPACTION, packages: all, variant } };
}
const verify = f => verificationGate(f.scene, f.measured, f.rows, timings(f.scene, f.rows, f.measured), f.options);

test("candidate hashes all new bytes twice per package and baseline retains the frozen originals", () => {
  for (const label of ["current", "year", "two-years"]) for (const variant of ["baseline", "candidate"]) {
    const f = verificationFixture(variant, label), append = verify(f).find(row => row.name === "append-codex");
    assert.equal(append.spans.length, { current: 2, year: 8, "two-years": 16 }[label]);
    const expected = f.options.packages.filter(row => row.label === label).reduce((n, row) => n + row[variant === "baseline" ? "previous" : "next"].bytes, 0) * 2;
    assert.equal(append.stages.reduce((n, row) => n + row.bytes, 0), expected);
  }
  for (const damage of ["old-path", "old-bytes", "digest", "missing", "duplicate", "rescan", "boundary"]) {
    const f = verificationFixture();
    const row = f.rows.find(row => row.startedAtMs === 220), pair = f.options.packages.find(row => row.label === "two-years");
    if (damage === "old-path") row.file = pair.previous.databaseFile;
    if (damage === "old-bytes") row.bytes = pair.previous.bytes;
    if (damage === "digest") row.sha256 = pair.previous.sha256;
    if (damage === "missing") f.rows = f.rows.filter(value => value !== row);
    if (damage === "duplicate") f.rows.push({ ...row, id: "extra" });
    if (damage === "rescan") f.rows.push({ ...row, id: "semantic", stage: "databaseEvidence" });
    if (damage === "boundary") row.endedAtMs = 301;
    assert.throws(() => verify(f), undefined, damage);
  }
});

function upgradeFixture() {
  const clock = { asOf: "2026-11-08T12:00:00.000Z", phase: "upgrade", referencePhase: "upgrade" };
  const entries = packages().filter(row => row.label === "current");
  const phase = start => ({ startedAtMs: start, endedAtMs: start + 1000, wallMs: 1000, defaultMs: 200 });
  const window = { first: phase(0), reopen: phase(2000), passed: true };
  const result = { passed: true, setup: { first: phase(0), passed: true }, baseline: structuredClone(window), candidate: structuredClone(window),
    maintenance: { result: { switched: 1 } }, latencies: ["first", "reopen"].map(name => ({ name, baselineMs: 1000, candidateMs: 1000, passed: true })) };
  const body = { summary: { totals: { total: 10 }, costEstimate: { totalUsd: 0.1 } },
    metadata: { modelUsageAsOf: clock.asOf, modelLastSeen: {}, activeHarnessModels: {} }, periodComparison: { asOf: clock.asOf } };
  const responses = Object.fromEntries(["baseline", "candidate"].map(variant => [variant, { first: structuredClone(body), reopen: structuredClone(body) }]));
  const measured = { setup: { memory: { passed: true } } };
  for (const variant of ["baseline", "candidate"]) {
    const entry = entries[0][variant === "baseline" ? "previous" : "next"];
    measured[variant] = { memory: { passed: true }, verification: [{ stage: "process-born" }, { stage: "process-exit" }],
      businessClocks: [100, 2100].map(readAtMs => ({ ...clock, readAtMs })),
      archiveProofs: [100, 2100].map(startedAtMs => ({ file: entry.databaseFile, bytes: entry.bytes, sha256: entry.sha256, startedAtMs, endedAtMs: startedAtMs + 1 })),
      history: [100, 2100].map(startedAtMs => ({ startedAtMs, endedAtMs: startedAtMs + 1, work: { projection: { coldCopied: 0, rebuilt: false } },
        inputVersion: { version: 1 }, publishedVersion: { status: "ready", inputs_json: '{"version":1}' } })) };
  }
  return { result, measured, responses, clock, entries };
}
const upgrade = f => upgradeGate(f.result, f.measured, f.responses, f.clock, f.entries);

test("upgrade requires exact amounts, retained first-open facts, a frozen clock and bounded resources", () => {
  assert.ok(upgrade(upgradeFixture()).every(row => row.passed));
  const damage = {
    amount: f => { f.responses.candidate.first.summary.costEstimate.totalUsd += Number.EPSILON; },
    copy: f => { f.measured.candidate.history[0].work.projection.coldCopied = 1; },
    rebuild: f => { f.measured.candidate.history[0].work.projection.rebuilt = true; },
    noEvidence: f => { f.measured.candidate.history = []; },
    noTrace: f => { f.measured.candidate.verification = []; },
    noSetup: f => { delete f.result.setup.first; },
    input: f => { f.measured.candidate.history[0].inputVersion.version = 2; },
    clock: f => { f.measured.candidate.businessClocks[0].asOf = "2026-11-09T12:00:00.000Z"; },
    memory: f => { f.measured.candidate.memory.passed = false; },
    semantic: f => { f.measured.candidate.verification.push({ stage: "sourceEvidence", startedAtMs: 1, endedAtMs: 2 }); },
    oldPackage: f => { f.measured.candidate.archiveProofs[0].sha256 = f.entries[0].previous.sha256; },
    receipt: f => { f.result.latencies[0].candidateMs = 900; },
    extraSetup: f => { f.result.setup.reopen = f.result.setup.first; },
  };
  for (const [name, change] of Object.entries(damage)) {
    const f = upgradeFixture(); change(f); assert.throws(() => upgrade(f), undefined, name);
  }
});

test("upgrade accepts the existing verified single-archive fast path only with its executor and exact package", () => {
  const f = upgradeFixture();
  f.measured.candidate.history = [];
  f.measured.candidate.nodes = [{ pid: 7, role: "executor", startedAtMs: 0, endedAtMs: 3000 }];
  f.measured.candidate.fastHistory = [100, 2100].map(startedAtMs => ({ success: true, path: "single-archive-all",
    requestedPreset: "all", preset: "all", bucket: "day", segmentId: f.entries[0].next.sha256,
    summaryProjectionCacheReused: true, startedAtMs, endedAtMs: startedAtMs + 1, pid: 7 }));
  assert.ok(upgrade(f).every(row => row.passed));
  for (const change of [value => { value.measured.candidate.nodes = []; },
    value => { value.measured.candidate.fastHistory[0].segmentId = value.entries[0].previous.sha256; },
    value => { value.measured.candidate.fastHistory[0].summaryProjectionCacheReused = undefined; }]) {
    const value = structuredClone(f); change(value); assert.throws(() => upgrade(value), /missing projection/);
  }
});

test("maintenance enforces zero cold copying/rebuilds and the 512 MiB inclusive process envelope", () => {
  const bytes = 512 * 1048576;
  const maintenance = { passed: true, wallMs: 1, result: { projection: { coldCopied: 0, rebuilt: false } },
    resourceUsage: { maxRSS: bytes / 1024 }, observed: { peakBytes: bytes } };
  const samples = [{ service: { processCount: 1, memoryAvailableProcessCount: 1, workingSetBytes: bytes, reportedPeakWorkingSetBytes: bytes } }];
  assert.equal(maintenanceGate(maintenance, samples).peakBytes, bytes);
  assert.throws(() => maintenanceGate(maintenance, []), /no resource samples/);
  for (const change of [m => { m.result.projection.coldCopied = 1; }, m => { m.result.projection.rebuilt = true; },
    m => { m.resourceUsage.maxRSS++; m.observed.peakBytes += 1024; }]) {
    const damaged = structuredClone(maintenance); change(damaged); assert.throws(() => maintenanceGate(damaged, samples));
  }
});

test("PID-derived ledgers include datasets and nested upgrades while raw evidence and stream bindings survive failures", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "compaction-resource-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sample = { processes: [{ pid: 1, role: "runner", startTimeUtc: "2026-11-08T00:00:00Z" },
    { pid: 2, parentPid: 1, name: "old.exe", role: "service", startTimeUtc: "2026-11-07T00:00:00Z", workingSetBytes: 999 }],
    service: { processCount: 1, workingSetBytes: 999 } };
  const raw = `${JSON.stringify(sample)}\n`;
  const files = ["datasets/current/scene-mixed-candidate/resources/resources.ndjson", "upgrades/current/candidate/resources-reopen/resources.ndjson", "upgrades/current/maintenance/resources.ndjson"];
  for (const file of files) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), raw); }
  const receipt = await deriveResources(root, ["datasets", "upgrades"]);
  assert.equal(receipt.files.length, 3);
  for (const row of receipt.files) {
    assert.equal(await readFile(row.source, "utf8"), raw);
    assert.equal(JSON.parse(await readFile(row.target, "utf8")).service.workingSetBytes, 0);
    assert.equal(row.correctedSamples, 1);
  }
  const original = createReadStream;
  await assert.rejects(withDerivedResources(receipt, async () => {
    let text = ""; for await (const chunk of createReadStream(receipt.files[0].source)) text += chunk;
    assert.equal(JSON.parse(text).service.workingSetBytes, 0);
    throw new Error("expected analysis failure");
  }), /expected analysis failure/);
  assert.equal(createReadStream, original);
});

test("every stage saves issues on admission failure and never overwrites an existing analysis", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "compaction-analysis-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const stage of Object.keys(STAGES)) {
    const output = path.join(root, `${stage}.json`);
    const result = await analyze(path.join(root, "missing-manifest.json"), path.join(root, "validation.json"), output, stage);
    assert.equal(result.passed, false);
    assert.equal(result.stage, stage);
    assert.equal(result.standards.requiredGroups, STAGES[stage]);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].group, "admission");
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), result);
    const before = await readFile(output, "utf8");
    await assert.rejects(analyze("unused", "unused", output, stage), /analysis output must be new/);
    assert.equal(await readFile(output, "utf8"), before);
  }
});

test("shared analysis writes by default and defers its only wx save when the compaction wrapper owns output", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "compaction-save-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "manifest.json"), manifest = { resultRoot: root, dataRoot: root, datasets: [], candidateFingerprint: "fixture" };
  await writeFile(file, JSON.stringify(manifest));
  await writeFile(path.join(root, "analysis-delivery.json"), '{"datasets":[]}');
  const options = { ...COMPACTION, verifyManifest: async () => manifest, validationGate: async () => ({ passed: true }) };
  const output = path.join(root, "wrapper.json");
  const result = await analyzeVerification(file, "fixture-validation", output, "current", { ...options, saveResult: false });
  assert.equal(result.issues.length, 4, "missing group evidence remains a reported failure");
  await assert.rejects(readFile(output), { code: "ENOENT" });
  await save(output, result);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), result);
  const standalone = path.join(root, "standalone.json");
  const saved = await analyzeVerification(file, "fixture-validation", standalone, "current", options);
  assert.deepEqual(JSON.parse(await readFile(standalone, "utf8")), saved);
});
