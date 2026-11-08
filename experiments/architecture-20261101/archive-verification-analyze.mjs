import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { ROOT, KINDS, read, save } from "./c1-datasets.mjs";
import { fingerprint, verifyEntries, replayMutationTimes } from "./persistent-history-prepare.mjs";
import { CASES, VALIDATION_CHECKS, resources, workGate, exactParity, executorReuseParity, regressionPassed,
  latencies, clockReplayGate } from "./persistent-history-analyze.mjs";
import { RESULT_ROOT, GROUPS, verifyManifest } from "./archive-verification-prepare.mjs";
import { hashFile } from "./remaining-harness-delivery-prepare.mjs";

export const FAULT_CHECKS = ["archive-operation-scope", "archive-same-size-mtime", "archive-manifest-replacement", "archive-wal",
  "archive-binding-revision-source", "archive-concurrent-append", "archive-replace-during-verification", "archive-cancel",
  "archive-kill-during-verification", "archive-proof-corrupt-missing", "archive-old-writer", "archive-version-upgrade"];
export async function validationGate(file, manifest) {
  const validation = await read(file); assert.equal(validation.candidateFingerprint, manifest.candidateFingerprint);
  for (const name of [...VALIDATION_CHECKS, ...FAULT_CHECKS]) {
    const row = validation.checks.find(row => row.name === name);
    assert.ok(row?.command && row.log && row.sha256, `missing validation: ${name}`);
    assert.equal(row.exitCode, 0, `failed validation: ${name}`); await verifyEntries([{ file: row.log, sha256: row.sha256 }]);
  }
  return validation;
}
export async function verificationRows(directory) {
  const rows = [];
  for (const file of await readdir(path.join(directory, "nodes"))) if (/^verification-.*\.ndjson$/.test(file)) {
    for await (const line of createInterface({ input: createReadStream(path.join(directory, "nodes", file)), crlfDelay: Infinity })) {
      if (line.trim()) rows.push(JSON.parse(line));
    }
  }
  return rows;
}
export function summarize(rows) {
  const stages = new Map();
  for (const row of rows.filter(row => row.id)) {
    assert.ok(Number.isFinite(row.durationMs) && row.durationMs >= 0 && row.stack, "incomplete verification timing");
    const stage = stages.get(row.stage) || { stage: row.stage, calls: 0, durationMs: 0, bytes: 0, tableRows: 0, rows: 0, failures: 0 };
    stage.calls++; stage.durationMs += row.durationMs; stage.bytes += row.bytes || 0; stage.rows += row.rows || 0;
    stage.tableRows += Object.values(row.tableRows || {}).reduce((sum, n) => sum + n, 0); stage.failures += row.error ? 1 : 0;
    stages.set(row.stage, stage);
  }
  return [...stages.values()];
}
export function windows(scene, diagnostic = false) {
  const result = [{ name: "startup", start: scene.serviceStartedAtMs, end: scene.initialAll.endedAtMs },
    ...scene.changes.map(row => ({ name: row.name, start: row.landedAtMs, end: row.endedAtMs })),
    { name: "reopen", start: scene.reopen.serviceStartedAtMs, end: scene.reopen.endedAtMs }];
  if (!diagnostic) result.push(...scene.scopes.map(row => ({ name: `scope-${row.preset}`, start: row.startedAtMs, end: row.endedAtMs })),
    ...["repeat", "afterExit"].map(name => ({ name, start: scene.reuseChecks[name].startedAtMs, end: scene.reuseChecks[name].endedAtMs })));
  return result;
}
const VERIFICATION_STAGES = new Set(["sha-before-lock", "sha-inside-lock", "databaseEvidence", "eventEvidence", "sourceEvidence", "candidate.range"]);
export function timings(scene, rows, measured, diagnostic = false) {
  const verification = rows.filter(row => VERIFICATION_STAGES.has(row.stage));
  assert.ok(verification.every(row => row.id && Number.isFinite(row.startedAtMs) && Number.isFinite(row.endedAtMs) && row.endedAtMs >= row.startedAtMs),
    "incomplete verification span interval");
  return windows(scene, diagnostic).map(window => {
    const spans = rows.filter(row => row.id && row.startedAtMs >= Math.floor(window.start) && row.startedAtMs <= window.end);
    const boundarySpans = verification.filter(row => row.startedAtMs <= window.end && row.endedAtMs >= Math.floor(window.start) &&
      !(row.startedAtMs >= Math.floor(window.start) && row.endedAtMs <= window.end));
    const processIds = [...new Set(spans.map(row => row.pid))];
    return { ...window, wallMs: window.end - window.start, stages: summarize(spans), spans, boundarySpans,
      transactions: rows.filter(row => row.stage.startsWith("read-transaction-") && row.atMs >= Math.floor(window.start) && row.atMs <= window.end),
      executors: measured.nodes.filter(row => row.role === "executor" && processIds.includes(row.pid)),
      executorSpawns: rows.filter(row => row.stage.startsWith("executor-spawn") && row.atMs >= Math.floor(window.start) && row.atMs <= window.end),
      history: measured.history.filter(row => row.startedAtMs >= Math.floor(window.start) && row.startedAtMs <= window.end),
      sync: measured.sync.filter(row => row.start >= Math.floor(window.start) && row.start <= window.end),
      publications: measured.publications.filter(row => row.startedAtMs >= Math.floor(window.start) && row.startedAtMs <= window.end) };
  });
}
export function allLatencies(scene) {
  return { ...latencies(scene), ...Object.fromEntries(["repeat", "afterExit"].map(name => [`reuse-${name}`, scene.reuseChecks?.[name]?.wallMs])) };
}
const ABSOLUTE = { "append-codex": 45000, "append-dsh": 45000, "append-claude": 45000, "append-workbuddy": 45000,
  "append-zcode": 90000, "append-opencode": 80000, reopen: 90000, "revision-zcode": 100000 };
export function latencyGates(label, layout, before, after, c1 = {}, v14 = {}, compaction = null) {
  const old = allLatencies(before), now = allLatencies(after);
  return Object.entries(now).map(([name, candidateMs]) => {
    const baselineMs = old[name], relativePassed = regressionPassed(baselineMs, candidateMs);
    const yearLimitMs = label === "year" && layout === "mixed" && (name === "reopen" || name.startsWith("append-") || name === "revision-zcode" || name.startsWith("scope-"))
      ? c1[name] * 0.2 : null;
    if (yearLimitMs !== null) assert.ok(Number.isFinite(yearLimitMs), `missing original year absolute gate: ${name}`);
    const absoluteLimitMs = label === "two-years" ? (compaction?.twoYearLimitsMs ?? ABSOLUTE)[name] ?? null : yearLimitMs;
    const improved = !compaction || label !== "two-years" || !compaction.improve.includes(name) || candidateMs < baselineMs;
    return { name, v14Ms: v14[name] ?? null, baselineMs, candidateMs, relativePassed, absoluteLimitMs,
      ...(compaction ? { improved } : {}),
      passed: relativePassed && improved && (absoluteLimitMs === null || candidateMs <= absoluteLimitMs) };
  });
}
export function verificationGate(scene, measured, rows, operations = timings(scene, rows, measured), compaction = null) {
  assert.ok(rows.some(row => row.stage === "process-born") && rows.some(row => row.stage === "process-exit"), "missing executor lifetime trace");
  assert.ok(rows.filter(row => row.id).every(row => !row.error), "failed verification spans");
  for (const operation of operations) assert.equal(operation.boundarySpans.length, 0,
    `${operation.name}: ambiguous cross-window SHA/semantic attribution`);
  if (scene.layout !== "mixed" || (!compaction && scene.label !== "two-years")) return operations;
  const planned = compaction?.packages.filter(row => row.label === scene.label);
  const expectedCount = compaction ? { current: 1, year: 4, "two-years": 8 }[scene.label] : 8;
  if (compaction) assert.equal(planned.length, expectedCount, "missing compaction package mapping");
  const originals = compaction ? new Map(planned.map(row => {
    const entry = row[compaction.variant === "baseline" ? "previous" : "next"];
    return [entry.databaseFile, [entry.bytes, entry.sha256]];
  })) : new Map(measured.archiveProofs.filter(row => !row.error && row.endedAtMs <= scene.initialAll.endedAtMs)
    .map(row => [row.file, [row.bytes, row.sha256]]));
  assert.equal(originals.size, expectedCount, "startup must identify every expected archive");
  if (!compaction) assert.equal([...originals.values()].reduce((sum, [bytes]) => sum + bytes, 0), 28761260032, "original uncompressed packages required");
  else {
    const startup = new Set();
    for (const row of measured.archiveProofs) {
      assert.ok(!row.error, "failed archive hash");
      assert.deepEqual([row.bytes, row.sha256], originals.get(row.file), `unexpected archive identity: ${row.file}`);
      if (row.endedAtMs <= scene.initialAll.endedAtMs) startup.add(row.file);
    }
    assert.equal(startup.size, expectedCount, "startup omits a mapped archive");
    for (const row of rows.filter(row => ["sha-before-lock", "sha-inside-lock"].includes(row.stage)))
      assert.deepEqual([row.bytes, row.sha256], originals.get(row.file), `unexpected SHA span identity: ${row.file}`);
    if (scene.label === "two-years") assert.ok(planned.reduce((sum, row) => sum + row.next.bytes, 0) <=
      planned.reduce((sum, row) => sum + row.previous.bytes, 0) * compaction.maximumByteRatio, "compact packages exceed 55% of original bytes");
  }
  const checkHashes = (operation, reopen = false) => {
    const before = operation.spans.filter(row => row.stage === "sha-before-lock"), inside = operation.spans.filter(row => row.stage === "sha-inside-lock");
    if (reopen) {
      assert.ok(before.length >= expectedCount, "reopen must hash every archive before its SQLite lock");
      assert.equal(inside.length, before.length, "reopen before/inside SHA counts must match");
    } else {
      assert.equal(before.length, expectedCount, `${operation.name}: exactly one before-lock SHA per archive`);
      assert.equal(inside.length, expectedCount, `${operation.name}: exactly one inside-lock SHA per archive`);
    }
    const identity = list => list.map(row => JSON.stringify([row.file, row.bytes, row.sha256])).sort();
    assert.deepEqual(identity(before), identity(inside));
    assert.equal(new Set(before.map(row => row.file)).size, expectedCount, "every expected archive must be checked");
    for (const row of before) assert.deepEqual([row.bytes, row.sha256], originals.get(row.file), `${operation.name}: original archive identity changed: ${row.file}`);
  };
  for (const operation of operations.filter(row => row.name.startsWith("append-"))) checkHashes(operation);
  for (const operation of operations.filter(row => row.name !== "startup")) {
    if (!compaction || compaction.variant === "candidate") assert.equal(operation.spans.filter(row => ["databaseEvidence", "eventEvidence", "sourceEvidence", "candidate.range"].includes(row.stage)).length, 0,
      `${operation.name}: verified unchanged archives must not repeat full semantic scans`);
    if (operation.name === "reopen") {
      checkHashes(operation, true);
      assert.ok(operation.executors.length > 0, "reopen needs fresh executor evidence");
    }
  }
  return operations;
}

export async function diagnosticReport() {
  const manifestFile = path.join(RESULT_ROOT, "diagnostic/manifest.json"), manifest = await verifyManifest(manifestFile);
  const directory = path.join(manifest.resultRoot, "datasets/two-years/scene-mixed-diagnostic"), scene = await read(path.join(directory, "result.json"));
  assert.equal(scene.profile, "diagnostic"); assert.equal(scene.passed, true); assert.equal(scene.rawRestored, true);
  assert.deepEqual(scene.changes.map(row => row.name), ["append-codex", "append-zcode"]); assert.deepEqual(scene.scopes, []);
  const measured = await resources(directory, scene), rows = await verificationRows(directory);
  assert.equal(measured.memory.passed, true); assert.ok(rows.some(row => row.stage === "databaseEvidence"), "missing static semantics timings");
  assert.ok(rows.some(row => row.stage === "sourceEvidence"), "missing candidate source timings");
  const result = { diagnostic: true, passed: true, manifestFile, scene, measured,
    timingCoverage: "Inclusive nested spans; SHA, table and candidate timings are children of verification/prepare, never additive. Raw spans retain caller stacks and parent IDs. Startup is setup, followed by exactly Codex, ZCode, reopen.",
    operations: timings(scene, rows, measured, true), processEvents: rows.filter(row => row.stage.startsWith("process-")) };
  await save(path.join(manifest.resultRoot, "analysis.json"), result); return result;
}

export async function analyze(manifestFile, validationFile, outputFile, stage = "all", compaction = null) {
  const manifest = await (compaction?.verifyManifest ?? verifyManifest)(manifestFile);
  if (!compaction) assert.equal(manifest.diagnostic, false);
  const validation = await (compaction?.validationGate ?? validationGate)(validationFile, manifest), issues = [], groups = [];
  const count = { current: 4, year: 8, all: 10 }[stage]; assert.ok(count, "stage current|year|all");
  const check = async (group, gate, action) => { try { return await action(); } catch (error) { issues.push({ group, gate, message: error.message }); } };
  for (const group of GROUPS.slice(0, count)) {
    const id = `${group.label}/${group.layout}/${group.variant}`;
    await check(id, "evidence", async () => {
      const directory = path.join(manifest.resultRoot, "datasets", group.label, `scene-${group.name}`), scene = await read(path.join(directory, "result.json"));
      assert.equal(scene.label, group.label); assert.equal(scene.layout, group.layout); assert.equal(scene.passed, true);
      assert.equal(scene.rawRestored, true); assert.deepEqual(scene.errors, []);
      assert.equal(scene.evidence.variant, group.variant); assert.equal(scene.evidence.manifestSha256, await hashFile(manifestFile));
      assert.equal(scene.evidence.runtimeFingerprint, manifest[`${group.variant}Fingerprint`]);
      assert.equal(scene.evidence.inputFingerprint, manifest.datasets.find(row => row.label === group.label).fingerprint);
      assert.deepEqual(scene.evidence.conditions, manifest.conditions); allLatencies(scene);
      const measured = await resources(directory, scene), rows = await verificationRows(directory), item = { ...group, id, directory, scene, measured };
      groups.push(item);
      await check(id, "memory", () => assert.equal(measured.memory.passed, true));
      await check(id, "hashes", () => { assert.equal(measured.archiveProof.failedCalls, 0); if (group.layout === "mixed") assert.ok(measured.archiveProof.successfulCalls > 0); });
      if (compaction) {
        item.operations = timings(scene, rows, measured);
        await check(id, "compaction-verification", () => verificationGate(scene, measured, rows, item.operations,
          { ...compaction, packages: manifest.compactPackages, variant: group.variant }));
      }
      if (group.variant === "candidate") {
        item.work = workGate(scene, measured);
        await check(id, "work/storage", () => assert.equal(item.work.passed, true));
        item.operations = timings(scene, rows, measured);
        if (!compaction) await check(id, "verification-reuse", () => verificationGate(scene, measured, rows, item.operations));
        await check(id, "paired-clock", async () => {
          const replay = scene.evidence.clockReplay, reference = { clockReplay: replay, clockReplayFingerprint: scene.evidence.clockReplayFingerprint };
          clockReplayGate(scene, reference, measured.businessClocks, await read(path.join(directory, "mutation-plans.json")));
          const old = await read(replay.resultFile), plans = await read(replay.plansFile);
          const final = path.join(manifest.resultRoot, "datasets", group.label, `state-scene-${group.name}`, "usage-index.sqlite");
          const actual = replayMutationTimes(final, replay.seedFile, plans, old.changes);
          assert.deepEqual(actual, replay.mutations);
        });
      } else await check(id, "real-clock", () => { assert.equal(scene.clockReplay, undefined); assert.equal(measured.businessClocks.length, 0); });
      await check(id, "repeat/exit", async () => {
        const initial = await read(path.join(directory, "initial-all.json"));
        exactParity(await read(path.join(directory, "repeat-all.json")), initial);
        executorReuseParity(await read(path.join(directory, "after-executor-exit-all.json")), initial, group.variant === "candidate");
      });
    });
  }
  const v14 = compaction ? { groups: [] } : await read(path.join(ROOT, "output/persistent-mixed-history-20261107/analysis-final-v14.json"));
  const c1File = path.join(manifest.dataRoot, "analysis-delivery.json");
  const c1 = compaction ? await check("references", "year-c1", () => read(c1File)) ?? { datasets: [] } : await read(c1File);
  const referenceLatencies = (label, layout) => {
    const row = v14.groups.find(row => row.label === label && row.layout === layout && row.variant === "candidate");
    return row?.scene ? allLatencies(row.scene) : {};
  };
  for (const item of groups.filter(row => row.variant === "candidate")) {
    const before = groups.find(row => row.label === item.label && row.layout === item.layout && row.variant === "baseline");
    await check(item.id, "paired-baseline", () => assert.ok(before)); if (!before) continue;
    await check(item.id, "source-reset", () => {
      const reset = rows => rows.map(({ kind, sha256, mtimeMs }) => ({ kind, sha256, mtimeMs }));
      assert.deepEqual(reset(item.scene.sourceReset), reset(before.scene.sourceReset));
      for (const scene of [before.scene, item.scene]) assert.deepEqual(reset(scene.restoredSources), reset(scene.sourceReset));
    });
    await check(item.id, "latency", () => {
      const original = c1.datasets.find(row => row.label === "year")?.scenes.find(row => row.layout === item.layout);
      item.latencies = latencyGates(item.label, item.layout, before.scene, item.scene, original ? latencies(original) : {}, referenceLatencies(item.label, item.layout), compaction);
      assert.ok(item.latencies.every(row => row.passed), JSON.stringify(item.latencies.filter(row => !row.passed)));
    });
    for (const name of CASES) await check(item.id, `exact/${name}`, async () => exactParity(await read(path.join(item.directory, `${name}.json`)),
      await read(path.join(before.directory, `${name}.json`)), false, true));
  }
  for (const label of ["current", "year"]) for (const variant of ["baseline", "candidate"]) {
    const hot = groups.find(row => row.label === label && row.variant === variant && row.layout === "hot"), mixed = groups.find(row => row.label === label && row.variant === variant && row.layout === "mixed");
    if (hot && mixed) for (const name of CASES) await check(`${label}/${variant}`, `hot-cold/${name}`, async () => exactParity(
      await read(path.join(mixed.directory, `${name}.json`)), await read(path.join(hot.directory, `${name}.json`)), true));
  }
  if (stage === "all") await check("two-years/mixed/candidate", "bounded-delta", () => {
    const year = groups.find(row => row.label === "year" && row.layout === "mixed" && row.variant === "candidate");
    const two = groups.find(row => row.label === "two-years" && row.variant === "candidate"); assert.ok(year?.work && two?.work);
    for (const row of two.work.operations.filter(row => row.name.startsWith("append-"))) {
      const old = year.work.operations.find(previous => previous.name === row.name); assert.ok(old);
      assert.equal(row.hotCopied, 0); assert.equal(row.coldCopied, 0);
      for (const counter of ["added", "removed", "scanned", "sorted"]) assert.ok(row.netChanges[counter] <= old.netChanges[counter], `${row.name}/${counter}`);
    }
  });
  // Admission also checks immutable raw/seeds/archives after each completed stage.
  for (const input of manifest.datasets) {
    if (compaction) await check(input.label, "immutable-inputs", () => verifyEntries(input.entries));
    else await verifyEntries(input.entries);
  }
  for (const group of groups) group.passed = !issues.some(issue => issue.group === group.id || issue.group === `${group.label}/${group.variant}`);
  const result = { version: 1, manifestFile: path.resolve(manifestFile), manifestSha256: await hashFile(manifestFile),
    candidateFingerprint: manifest.candidateFingerprint, stage, validationFile, validation, groups, issues,
    standards: { maximumGroups: 10, pairedAllLayouts: true, amountTolerance: 0, serviceEnvelopeBytes: 512 * 1048576,
      regression: ">10% AND >100ms fails each operation", twoYearLimitsMs: compaction?.twoYearLimitsMs ?? ABSOLUTE, yearMixedRatio: 0.2,
      timing: "Inclusive nested spans; do not sum child SHA/semantics with parent verification/prepare" },
    passed: groups.length === count && issues.length === 0, createdAt: new Date().toISOString() };
  if (compaction?.saveResult !== false) await save(outputFile, result);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const diagnostic = process.argv[2] === "diagnostic";
  const result = diagnostic ? await diagnosticReport() : await analyze(path.join(RESULT_ROOT, "manifest.json"), process.argv[3], process.argv[4], process.argv[2]);
  console.log(JSON.stringify({ passed: result.passed, stage: result.stage, issues: result.issues })); if (!result.passed) process.exitCode = 1;
}
