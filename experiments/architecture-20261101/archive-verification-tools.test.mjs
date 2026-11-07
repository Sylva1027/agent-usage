import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ROOT, read } from "./c1-datasets.mjs";
import { GROUPS, DIAGNOSTIC, assertMatrix, RESULT_ROOT } from "./archive-verification-prepare.mjs";
import { instrument } from "./archive-verification-telemetry.mjs";
import { command } from "./archive-verification-run.mjs";
import { latencyGates, summarize, FAULT_CHECKS, validationGate, timings, verificationGate } from "./archive-verification-analyze.mjs";
import { VALIDATION_CHECKS } from "./persistent-history-analyze.mjs";
import { hashFile } from "./remaining-harness-delivery-prepare.mjs";

test("exactly ten newly paired formal groups; one fixed two-year diagnostic", () => {
  assertMatrix(GROUPS); assertMatrix([DIAGNOSTIC], true);
  assert.equal(GROUPS.length, 10); assert.equal(GROUPS.filter(row => row.label === "two-years").length, 2);
  assert.ok(GROUPS.filter(row => row.label === "two-years").every(row => row.layout === "mixed"));
  assert.throws(() => assertMatrix([...GROUPS, { ...DIAGNOSTIC, layout: "hot" }]));
  assert.throws(() => assertMatrix([{ ...DIAGNOSTIC, variant: "candidate" }], true));
  const spec = command({ diagnostic: true, resultRoot: "isolated", baselineFile: "frozen-baseline" }, DIAGNOSTIC, "manifest.json");
  assert.deepEqual(spec.args.slice(1), ["scene", "two-years", "mixed", "mixed-diagnostic"]);
  assert.equal(spec.env.C1_RUNTIME_SPEC, "frozen-baseline"); assert.equal(spec.env.C1_ARCHIVE_PROFILE, "diagnostic");
});

test("coarse telemetry compiles frozen production modules and separates SHA phases", async () => {
  const baseline = await read(path.join(RESULT_ROOT, "baseline.json"));
  for (const file of ["history-backup.js", "history-archive.js", "usage-store.js", "usage-history-projection-store.js", "usage-executor.js", "usage-source-native.js"]) {
    const url = pathToFileURL(path.join(baseline.directory, "src", file)).href;
    const source = await readFile(new URL(url), "utf8"), transformed = instrument(url, source);
    const check = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: transformed, encoding: "utf8", windowsHide: true });
    assert.equal(check.status, 0, check.stderr);
    if (file === "history-backup.js") {
      for (const stage of ["sha-before-lock", "sha-inside-lock", "databaseEvidence", "read-transaction-pinned", "read-transaction-released"]) assert.ok(transformed.includes(stage));
      assert.throws(() => instrument(url, source.replace("const pinnedHash = await hashFile(databasePath);", "")), /hash phase changed/);
    }
    if (file === "history-archive.js") for (const stage of ["candidate.range", "sourceEvidence", "eventEvidence"]) assert.ok(transformed.includes(stage));
  }
});

test("current scoped candidate verifier and indented candidate semantics also compile", async () => {
  for (const file of ["history-backup.js", "history-archive.js", "usage-store.js", "usage-history-projection-store.js", "usage-executor.js", "usage-source-native.js"]) {
    const url = pathToFileURL(path.join(ROOT, "src", file)).href, source = await readFile(new URL(url), "utf8");
    const transformed = instrument(url, source);
    const check = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: transformed, encoding: "utf8", windowsHide: true });
    assert.equal(check.status, 0, `${file}: ${check.stderr}`);
    if (file === "history-backup.js" && source.includes("async function verifyHistoryBackupInScope(")) {
      assert.equal(transformed.split("avSpan('sha-before-lock'").length, 2);
      assert.equal(transformed.split("avSpan('sha-inside-lock'").length, 2);
      assert.throws(() => instrument(url, source.replace("assertDatabaseHash(await hashFile(databasePath), manifest.database);", "")), /hash phases changed/);
    }
  }
});

test("span wrappers preserve synchronous returns, promises, failures and caller nesting", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "archive-verification-test-"));
  try {
    const script = path.join(directory, "fixture.mjs");
    await writeFile(script, `import assert from 'node:assert/strict';
import {span,methods} from ${JSON.stringify(new URL("./archive-verification-telemetry.mjs", import.meta.url).href)};
const object={value:3,sync(x){return this.value+x;},async work(){await Promise.resolve();return span('child',()=>7);},fail(){throw new Error('kept');}};
methods(object,['sync','work','fail'],'fixture');
assert.equal(object.sync(4),7);assert.equal(await object.work(),7);assert.throws(()=>object.fail(),/kept/);
assert.equal(await span('async-failure',async()=>{throw new Error('async-kept');}).catch(e=>e.message),'async-kept');
`);
    const result = spawnSync(process.execPath, [script], { env: { ...process.env, C1_ARCHIVE_TRACE: "0", REMAINING_DELIVERY_TRACE: directory }, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const rows = (await readFile(path.join(directory, `verification-${result.pid}.ndjson`), "utf8")).trim().split("\n").map(JSON.parse);
    const child = rows.find(row => row.stage === "child"), parent = rows.find(row => row.stage === "fixture.work");
    assert.equal(child.parentId, parent.id); assert.ok(rows.every(row => row.durationMs >= 0 && row.stack));
    assert.match(rows.find(row => row.stage === "fixture.fail").error, /kept/);
    assert.match(rows.find(row => row.stage === "async-failure").error, /async-kept/);
  } finally { const resolved = path.resolve(directory); assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(resolved, { recursive: true, force: true }); }
});

test("latency gates retain each paired threshold, two-year limits and year absolute limits", () => {
  const scene = ms => ({ defaultPaintWallMs: ms, initialServiceWallMs: ms, initialAll: { wallMs: ms }, reopen: { wallMs: ms },
    changes: ["codex", "dsh", "claude", "workbuddy", "zcode", "opencode"].map(kind => ({ name: `append-${kind}`, actualPaintMs: ms })).concat({ name: "revision-zcode", actualPaintMs: ms }),
    scopes: ["today", "week", "custom", "all"].map(preset => ({ preset, wallMs: ms })), reuseChecks: { repeat: { wallMs: ms }, afterExit: { wallMs: ms } } });
  assert.ok(latencyGates("current", "hot", scene(1000), scene(1100)).every(row => row.passed));
  assert.ok(latencyGates("current", "hot", scene(1000), scene(1100.01)).every(row => !row.passed));
  const two = latencyGates("two-years", "mixed", scene(90000), scene(46000));
  assert.equal(two.find(row => row.name === "append-codex").passed, false);
  assert.equal(two.find(row => row.name === "append-zcode").passed, true);
  assert.throws(() => latencyGates("year", "mixed", scene(1000), scene(900)), /missing original year/);
  const stages = summarize([{ id: "a", stage: "databaseEvidence", durationMs: 5, stack: "caller", tableRows: { events: 4, sources: 2 } }]);
  assert.equal(stages[0].tableRows, 6); assert.equal(stages[0].durationMs, 5);
  assert.throws(() => summarize([{ id: "b", stage: "missing", durationMs: 1 }]), /incomplete/);
});

function verificationFixture(rounds = 1) {
  let sequence = 0;
  const span = (stage, start, end, details = {}) => ({ id: `span-${++sequence}`, pid: 7, stage, startedAtMs: start,
    endedAtMs: end, durationMs: end - start, stack: "fixture caller", ...details });
  const hashes = (start, count) => Array.from({ length: count }, (_, round) => Array.from({ length: 8 }, (_, file) =>
    ["sha-before-lock", "sha-inside-lock"].map((stage, phase) => span(stage, start + round * 30 + file * 2 + phase,
      start + round * 30 + file * 2 + phase + 1, { file: `/original/segment-${file}.sqlite`, bytes: 3595157504, sha256: `original-sha-${file}` })))).flat(2);
  const startup = hashes(10, 1);
  return { span, scene: { label: "two-years", layout: "mixed", serviceStartedAtMs: 0, initialAll: { endedAtMs: 100 },
    changes: [{ name: "append-codex", landedAtMs: 200, endedAtMs: 300 }], scopes: [{ preset: "today", startedAtMs: 350, endedAtMs: 400 }],
    reuseChecks: { repeat: { startedAtMs: 450, endedAtMs: 500 }, afterExit: { startedAtMs: 550, endedAtMs: 600 } },
    reopen: { serviceStartedAtMs: 700, endedAtMs: 900 } },
    measured: { nodes: [{ pid: 7, role: "executor" }], history: [], sync: [], publications: [], archiveProofs: startup },
    rows: [{ stage: "process-born" }, ...startup, ...hashes(220, 1), ...hashes(720, rounds), { stage: "process-exit" }] };
}

test("each window retains raw SHA/semantic boundary spans and candidate counts reject ambiguous attribution", () => {
  for (const stage of ["sha-before-lock", "sha-inside-lock", "databaseEvidence", "eventEvidence", "sourceEvidence", "candidate.range"]) {
    const fixture = verificationFixture(), { scene, measured, rows, span } = fixture;
    const left = span(stage, 190, 210), right = span(stage, 290, 310), covering = span(stage, 190, 310),
      contained = span(stage, 200, 300), outside = span(stage, 180, 199);
    rows.push(left, right, covering, contained, outside);
    const operations = timings(scene, rows, measured), append = operations.find(row => row.name === "append-codex");
    assert.deepEqual(append.boundarySpans, [left, right, covering]);
    assert.equal(append.boundarySpans[0], left, "retain original span including caller details");
    assert.equal(append.spans.includes(left), false); assert.equal(append.spans.includes(right), true);
    assert.throws(() => verificationGate(scene, measured, rows, operations), /ambiguous cross-window/);
    assert.deepEqual(append.boundarySpans, [left, right, covering], "rejected gate must not consume raw evidence");
    assert.throws(() => verificationGate({ ...scene, label: "year" }, measured, rows), /ambiguous cross-window/);
  }
  const fixture = verificationFixture();
  fixture.rows.push(fixture.span("sourceEvidence", 190, 189));
  assert.throws(() => timings(fixture.scene, fixture.rows, fixture.measured), /incomplete verification span interval/);
});

test("reopen matches eight original archive identities across one or multiple independent SHA rounds", () => {
  for (const rounds of [1, 2]) {
    const { scene, measured, rows } = verificationFixture(rounds);
    const reopen = verificationGate(scene, measured, rows).find(row => row.name === "reopen");
    assert.equal(reopen.spans.filter(row => row.stage === "sha-before-lock").length, 8 * rounds);
  }
  const { scene, measured, rows, span } = verificationFixture();
  for (const [index, stage] of ["sha-before-lock", "sha-inside-lock"].entries()) {
    const original = rows.find(row => row.stage === stage && row.startedAtMs >= 700);
    rows.push(span(stage, 810 + index, 811 + index, { file: original.file, bytes: original.bytes, sha256: original.sha256 }));
  }
  assert.doesNotThrow(() => verificationGate(scene, measured, rows), "paired extra work need not be a complete eight-file round");
});

test("reopen rejects missing, duplicate, unmatched or changed originals without relaxing append counts", () => {
  for (const damage of ["missing", "duplicate", "unmatched", "digest", "bytes", "replacement"]) {
    const fixture = verificationFixture(), reopen = fixture.rows.filter(row => row.startedAtMs >= 700 && row.file);
    if (damage === "missing") fixture.rows = fixture.rows.filter(row => !reopen.slice(-2).includes(row));
    if (damage === "unmatched") fixture.rows = fixture.rows.filter(row => row !== reopen[0]);
    if (damage === "duplicate") for (const row of reopen.slice(-2)) { row.file = reopen[0].file; row.sha256 = reopen[0].sha256; }
    if (damage === "digest") reopen[1].sha256 = "changed";
    if (damage === "bytes") for (const row of reopen.slice(0, 2)) row.bytes++;
    if (damage === "replacement") for (const row of reopen.slice(0, 2)) row.file = "/replacement.sqlite";
    assert.throws(() => verificationGate(fixture.scene, fixture.measured, fixture.rows), undefined, damage);
  }
  const fixture = verificationFixture();
  fixture.rows.push(...fixture.rows.filter(row => row.startedAtMs >= 200 && row.startedAtMs < 300).map(row => ({ ...row, id: `extra-${row.id}` })));
  assert.throws(() => verificationGate(fixture.scene, fixture.measured, fixture.rows), /exactly one before-lock SHA/);
});

test("fault admission requires every existing and new gate and verifies retained logs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "archive-verification-admission-"));
  try {
    const log = path.join(directory, "check.log"), file = path.join(directory, "validation.json");
    await writeFile(log, "passed\n");
    const checks = [...VALIDATION_CHECKS, ...FAULT_CHECKS].map(name => ({ name, command: "node --test fixture", exitCode: 0, log, sha256: "" }));
    for (const row of checks) row.sha256 = await hashFile(log);
    await writeFile(file, JSON.stringify({ candidateFingerprint: "candidate", checks }));
    await validationGate(file, { candidateFingerprint: "candidate" });
    await assert.rejects(validationGate(file, { candidateFingerprint: "other" }));
    await writeFile(file, JSON.stringify({ candidateFingerprint: "candidate", checks: checks.slice(1) }));
    await assert.rejects(validationGate(file, { candidateFingerprint: "candidate" }), /missing validation/);
    await writeFile(file, JSON.stringify({ candidateFingerprint: "candidate", checks }));
    await writeFile(log, "changed\n");
    await assert.rejects(validationGate(file, { candidateFingerprint: "candidate" }), /drift/);
  } finally { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(directory, { recursive: true, force: true }); }
});

test("actual C1 preload imports frozen baseline modules without creating a service or database", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "archive-verification-preload-"));
  try {
    const baseline = await read(path.join(RESULT_ROOT, "baseline.json")), script = path.join(directory, "imports.mjs");
    await writeFile(script, ["history-backup.js", "history-archive.js", "usage-store.js", "usage-history-projection-store.js", "usage-executor.js", "usage-source-native.js"].map(file =>
      `await import(${JSON.stringify(pathToFileURL(path.join(baseline.directory, "src", file)).href)});`).join("\n"));
    const result = spawnSync(process.execPath, ["--import", new URL("./c1-telemetry.mjs", import.meta.url).href, script], {
      env: { ...process.env, C1_ARCHIVE_TRACE: "1", C1_METHOD_DIAGNOSTIC: "1", REMAINING_DELIVERY_TRACE: directory }, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  } finally { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await rm(directory, { recursive: true, force: true }); }
});
