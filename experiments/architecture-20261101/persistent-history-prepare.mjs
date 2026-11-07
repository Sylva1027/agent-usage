import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, rename, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as replayPause } from "node:timers/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, BASE, KINDS, inside, read, save } from "./c1-datasets.mjs";
import { hashFile, verifyRuntime } from "./remaining-harness-delivery-prepare.mjs";

export const RESULT_ROOT = path.resolve(process.env.C1_RESULT_ROOT || path.join(ROOT, "output/persistent-mixed-history-20261107"));
export const fingerprint = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const CONDITIONS = { heapsMiB: { gateway: 512, executor: 224, semiSpace: 4 },
  pricingDelayMs: 1100, pricing: "controlled unchanged-price failure", archiveVerification: "SHA with real validation",
  calendar: "utc", sourceReset: "existing six-source mutations restore; fixed seed mtime; changed ctime", samples: 1 };
export const REPLAY_PHASES = ["default", "initial-all", "today", "week", "custom", "back-all",
  ...KINDS.map(kind => `append-${kind}`), "revision-zcode", "reopen-all"];
export const GROUPS = [
  ...["hot", "mixed"].flatMap(layout => ["baseline", "candidate"].map(variant => ({ label: "current", layout, variant, name: `${layout}-${variant}` }))),
  ...["hot", "mixed"].map(layout => ({ label: "year", layout, variant: "candidate", name: `${layout}-candidate` })),
];
const TWO_YEAR_GROUPS = ["hot", "mixed"].map(layout => ({ label: "two-years", layout, variant: "candidate", name: `${layout}-candidate` }));
export function assertMatrix(groups) {
  assert.ok([6, 8].includes(groups.length), "only six front groups and two deferred groups are permitted");
  assert.deepEqual(groups, groups.length === 6 ? GROUPS : [...GROUPS, ...TWO_YEAR_GROUPS]);
}
const HERE = path.join(ROOT, "experiments/architecture-20261101");
const TOOL_FILES = ["c1-run.mjs", "c1-telemetry.mjs", "c1-datasets.mjs", "c1-source-mutations.mjs", "persistent-history-tools.test.mjs",
  "persistent-history-prepare.mjs", "persistent-history-analyze.mjs", "b2-attribution-resource.ps1",
  "b2-page-diagnostic.mjs", "q5-summary-hook.mjs", "first-update-telemetry.mjs", "source-prefix-publish-telemetry.mjs",
  "remaining-harness-delivery-telemetry.mjs", "remaining-harness-delivery-fixture.mjs", "remaining-harness-delivery-prepare.mjs",
  "growth-line-inputs.mjs", "growth-sqlite-inputs.mjs", "q3-benchmark-support.mjs"];

export async function toolReceipt() {
  const entries = await hashEntries(TOOL_FILES.map(file => path.join(HERE, file)));
  return { entries, sha256: fingerprint(entries) };
}

export async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), `unexpected link: ${directory}/${entry.name}`);
    if (entry.isDirectory()) files.push(...(await filesUnder(path.join(directory, entry.name))).map(file => path.join(entry.name, file)));
    else if (entry.isFile()) files.push(entry.name);
  }
  return files.sort();
}

export async function hashEntries(files) {
  const entries = [];
  for (const file of files) entries.push({ file: path.resolve(file), sha256: await hashFile(file) });
  return entries;
}
export async function verifyEntries(entries) {
  assert.ok(entries.length, "missing hash evidence");
  for (const { file, sha256 } of entries) assert.equal(await hashFile(file), sha256, `input/runtime drift: ${file}`);
}

export async function verifyFrozenRuntime(spec) {
  await verifyRuntime(spec);
  const actual = await filesUnder(spec.directory);
  assert.deepEqual(actual.map(file => file.replaceAll("\\", "/")).sort(),
    Object.keys(spec.hashes).map(file => file.replaceAll("\\", "/")).sort(), "unrecorded runtime files");
}

export function scenePaths(dataset, layout, name, resultRoot = process.env.C1_RESULT_ROOT) {
  assert.ok(["hot", "mixed"].includes(layout));
  assert.match(name, /^[a-z0-9-]+$/);
  const root = resultRoot ? path.join(path.resolve(resultRoot), "datasets", dataset.label) : dataset.root;
  assert.ok(inside(path.join(BASE, "datasets"), dataset.root), "dataset.root must remain in the original C1 tree");
  return { directory: path.join(root, `scene-${name}`), state: path.join(root, `state-scene-${name}`),
    seed: path.join(dataset.root, layout === "hot" ? "seed-state" : "seed-mixed") };
}

async function freezeInputs(label) {
  const file = path.join(BASE, "datasets", label, "dataset.json"), dataset = await read(file);
  assert.equal(path.resolve(dataset.root), path.dirname(file));
  const homeFiles = (await filesUnder(dataset.home)).map(file => path.join(dataset.home, file));
  assert.deepEqual(homeFiles.sort(), dataset.files.map(source => source.path).sort(), "unrecorded source files");
  const entries = await hashEntries([file]);
  for (const source of dataset.files) {
    assert.ok(inside(dataset.home, source.path));
    assert.equal(await hashFile(source.path), source.sha256, `original input changed: ${source.path}`);
    entries.push({ file: source.path, sha256: source.sha256 });
  }
  // The existing seeds and archive packages are read-only inputs; never re-import them.
  for (const folder of ["seed-state", "seed-mixed", "archive-build"]) {
    const directory = path.join(dataset.root, folder);
    const files = (await filesUnder(directory)).map(relative => path.join(directory, relative));
    assert.ok(files.length, `missing ${folder}`);
    assert.ok(!files.some(file => /history-cache/i.test(file)), "seed already contains a new projection");
    entries.push(...await hashEntries(files));
  }
  return { label, root: dataset.root, home: dataset.home, homeFiles, entries, fingerprint: fingerprint(entries) };
}

async function environment() {
  const { runtime } = await read(path.join(ROOT, "output/b3-mixed-history-20261107/matrix.json"));
  assert.equal(process.platform, runtime.platform); assert.equal(process.arch, runtime.arch);
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, runtime.timezone);
  assert.equal(process.versions.node, runtime.node.versions.node);
  assert.equal(await hashFile(process.execPath), runtime.node.sha256);
  for (const name of ["node", "playwright", "chromium"]) {
    assert.equal(await hashFile(runtime[name].file || runtime[name].path), runtime[name].sha256, `${name} changed`);
  }
  assert.equal(await hashFile(path.join(path.dirname(runtime.playwright.file), "package.json")), runtime.playwright.packageSha256);
  const pwsh = { ...runtime.pwsh, sha256: await hashFile(runtime.pwsh.path),
    version: execFileSync(runtime.pwsh.path, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", windowsHide: true }).trim() };
  assert.match(pwsh.version, /^7\./, "resource collection requires PowerShell 7");
  return { ...runtime, pwsh, referencePwsh: runtime.pwsh,
    samplerCondition: pwsh.sha256 === runtime.pwsh.sha256 ? "same binary as C1" :
      `C1 PowerShell ${runtime.pwsh.version} -> current ${pwsh.version}; all new groups share this sampler; year remains a historical comparison` };
}

export function replayMutationTimes(finalFile, seedFile, plans, changes) {
  assert.deepEqual(plans.map(plan => plan.kind), KINDS);
  const final = new DatabaseSync(finalFile, { readOnly: true }), seed = new DatabaseSync(seedFile, { readOnly: true });
  try {
    const columns = database => database.prepare("PRAGMA table_info(events)").all().map(row => row.name).filter(name => name !== "id");
    const names = columns(final); assert.deepEqual(names, columns(seed), "C1 final/seed event schema mismatch");
    const quote = name => `"${name.replaceAll('"', '""')}"`;
    const select = names.map(quote).join(","), match = names.map(name => `${quote(name)} IS ?`).join(" AND ");
    const finalCount = final.prepare(`SELECT COUNT(*) n FROM events WHERE ${match}`), seedCount = seed.prepare(`SELECT COUNT(*) n FROM events WHERE ${match}`);
    const result = [];
    for (const plan of plans) {
      const change = changes.find(row => row.name === `append-${plan.kind}`); assert.ok(change);
      const reasoning = ["codex", "zcode", "opencode", "workbuddy"].includes(plan.kind) ? 5 : 0;
      // Full normalized row difference excludes physical ids and preserves duplicate multiplicity.
      const candidates = new Map();
      for (const row of final.prepare(`SELECT ${select} FROM events WHERE source_path=? AND total=160 AND input=140 AND cached=30 AND output=20 AND reasoning=?`)
        .iterate(plan.filePath, reasoning)) {
        const values = names.map(name => row[name]), added = Number(finalCount.get(...values).n) - Number(seedCount.get(...values).n);
        if (added > 0) candidates.set(fingerprint(values), { row: { ...row }, added });
      }
      // The four delivery payloads use an exact planned time; revisions keep their old timestamp.
      const expected = plan.kind === "codex" ? change.startedAtMs : plan.deliveryPlan ? plan.deliveryPlan.appendTimeMs + 1000 : null;
      const added = [...candidates.values()].filter(({ row }) => expected === null || row.timestamp_ms === expected);
      assert.equal(added.length, 1, `expected exactly one new ${plan.kind} payload in its original source`);
      assert.equal(added[0].added, 1, `${plan.kind} append multiplicity must be one`);
      const row = added[0].row, timestampMs = Number(row.timestamp_ms);
      assert.ok(Number.isSafeInteger(timestampMs) && timestampMs > 1000);
      if (plan.deliveryPlan) assert.ok(timestampMs > plan.deliveryPlan.original.timestampMs, "revision cannot be mistaken for append");
      result.push({ kind: plan.kind, filePath: plan.filePath, timestampMs, rowFingerprint: fingerprint(row), added: 1,
        receiptStartedAtMs: change.startedAtMs, receiptLandedAtMs: change.landedAtMs });
    }
    return result;
  } finally { final.close(); seed.close(); }
}

export async function buildClockReplay(reference, seedFile) {
  const phases = [];
  for (const phase of REPLAY_PHASES) {
    const query = ["today", "week", "custom", "back-all"].includes(phase);
    const file = path.join(query ? reference.queryDirectory : reference.directory, `${phase}.json`), body = await read(file);
    const asOf = body.metadata.modelUsageAsOf;
    assert.equal(new Date(asOf).toISOString(), asOf, `invalid C1 response asOf: ${file}`);
    assert.equal(body.summary.range.calendarZone, "utc");
    phases.push({ phase, asOf, file, sha256: await hashFile(file) });
  }
  const plansFile = path.join(reference.directory, "mutation-plans.json"), resultFile = path.join(reference.directory, "result.json");
  const plans = await read(plansFile), result = await read(resultFile); assert.equal(result.passed, true);
  const mutations = replayMutationTimes(reference.finalStateFile, seedFile, plans, result.changes);
  return { mode: "year-historical-business-asOf", phases, mutations, seedFile, finalStateFile: reference.finalStateFile,
    plansFile, resultFile, boundary: "only /api/usage business asOf and six added payload timestamps replay; OS/Date.now/mtime/receipts/notification/paint clocks remain real; background requests use the current phase" };
}

export async function writeReplayClock(file, replay, phase) {
  const startedAtMs = Date.now();
  const referencePhase = ["repeat-all", "after-executor-exit-all"].includes(phase) ? "initial-all" : phase;
  const entry = replay.phases.find(row => row.phase === referencePhase); assert.ok(entry, `missing replay phase: ${phase}`);
  assert.equal(new Date(entry.asOf).toISOString(), entry.asOf);
  const next = { phase, referencePhase, asOf: entry.asOf, referenceFile: entry.file, referenceSha256: entry.sha256 };
  await save(`${file}.next`, next);
  const deadline = Date.now() + 1000;
  for (;;) {
    try { await rename(`${file}.next`, file); break; }
    catch (error) {
      // Windows readers can briefly hold the destination; retain the complete old clock while retrying.
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || Date.now() >= deadline) throw error;
      await replayPause(10);
    }
  }
  return { ...next, startedAtMs, writtenAtMs: Date.now() };
}

async function yearReferences(baseline) {
  const file = path.join(BASE, "analysis-delivery.json"), analysis = await read(file);
  const chosen = analysis.selection.datasets.find(row => row.label === "year");
  const record = analysis.datasets.find(row => row.label === "year");
  assert.ok(chosen && record);
  const references = [];
  for (const layout of ["hot", "mixed"]) {
    const scene = record.scenes.find(row => row.layout === layout);
    assert.equal(scene.passed, true);
    const spec = await read(path.join(BASE, `${path.basename(scene.runtime)}.json`));
    await verifyFrozenRuntime(spec);
    assert.deepEqual(spec.hashes, baseline.hashes, "C1 year code does not match c91b2b5; a replacement group must be explicitly agreed");
    const directory = path.join(BASE, "datasets/year", `scene-${chosen[layout]}`);
    const queryDirectory = scene.reusedQueryScopesFrom ? path.join(BASE, "datasets/year", `scene-${scene.reusedQueryScopesFrom}`) : directory;
    references.push({ layout, directory, queryDirectory, runtime: spec.directory,
      finalStateFile: path.join(BASE, "datasets/year", `state-scene-${chosen[layout]}`, "usage-index.sqlite") });
  }
  const year = { file, sha256: await hashFile(file), references,
    condition: "historical C1 comparison, not a same-round pair; mixed range scopes explicitly reused from mixed-streamed" };
  for (const reference of references) {
    const { directory, queryDirectory } = reference;
    reference.clockReplay = await buildClockReplay(reference, path.join(BASE, "datasets/year", reference.layout === "hot" ? "seed-state" : "seed-mixed", "usage-index.sqlite"));
    reference.clockReplayFingerprint = fingerprint(reference.clockReplay);
    reference.entries = await hashEntries([...(await filesUnder(directory)).map(file => path.join(directory, file)),
      ...(queryDirectory === directory ? [] : (await filesUnder(queryDirectory)).map(file => path.join(queryDirectory, file))), reference.finalStateFile]);
  }
  return year;
}

export async function freezeCandidate() {
  assert.ok(inside(path.join(ROOT, "output"), RESULT_ROOT));
  await assert.rejects(stat(path.join(RESULT_ROOT, "candidate.json")), { code: "ENOENT" });
  const baselineFile = path.join(RESULT_ROOT, "baseline.json"), baseline = await read(baselineFile);
  assert.ok(baseline.commit?.startsWith("c91b2b5")); await verifyFrozenRuntime(baseline);
  const runtime = await environment(), year = await yearReferences(baseline);
  const datasets = []; for (const label of ["current", "year"]) datasets.push(await freezeInputs(label));
  const directory = path.join(RESULT_ROOT, "versions/candidate"), hashes = {};
  const entries = [...(await filesUnder(path.join(ROOT, "src"))).map(file => path.join("src", file)),
    ...(await filesUnder(path.join(ROOT, "public"))).map(file => path.join("public", file)), "package.json", "package-lock.json"];
  const workspace = await hashEntries(entries.map(file => path.join(ROOT, file)));
  const native = Object.keys(baseline.hashes).filter(file => /^native[\\/]/.test(file));
  await mkdir(directory); // Exclusive: failed freezes remain inspectable and are never silently overwritten.
  for (const relative of [...entries, ...native]) {
    const source = path.join(native.includes(relative) ? baseline.directory : ROOT, relative);
    const target = path.join(directory, relative); await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target); hashes[relative] = await hashFile(target);
  }
  await verifyEntries(workspace);
  for (const { file, sha256 } of workspace) assert.equal(hashes[path.relative(ROOT, file)], sha256);
  const candidate = { directory, hashes, commit: "workspace-explicit-freeze", frozenAt: new Date().toISOString() };
  const { entries: tools, sha256: toolsFingerprint } = await toolReceipt();
  await save(path.join(RESULT_ROOT, "candidate.json"), candidate);
  const manifest = { version: 1, resultRoot: RESULT_ROOT, dataRoot: BASE, baselineFile,
    baselineFingerprint: fingerprint(baseline.hashes), candidateFile: path.join(RESULT_ROOT, "candidate.json"),
    candidateFingerprint: fingerprint(hashes), workspace, tools, toolsFingerprint, conditions: CONDITIONS, runtime, year, datasets, groups: GROUPS,
    deferred: ["two-years/hot/candidate", "two-years/mixed/candidate"], maximumGroups: 8 };
  await save(path.join(RESULT_ROOT, "manifest.json"), manifest);
  return manifest;
}

export async function verifyScene(manifestFile, label, layout, name, specFile) {
  const manifest = await read(manifestFile), spec = await read(specFile);
  assertMatrix(manifest.groups);
  assert.equal(manifest.dataRoot, BASE); assert.equal(path.resolve(process.env.C1_RESULT_ROOT), manifest.resultRoot);
  assert.deepEqual(manifest.conditions, CONDITIONS);
  const group = manifest.groups.find(row => row.label === label && row.layout === layout &&
    (row.name === name || new RegExp(`^${row.name}-retry-[1-9][0-9]*$`).test(name)));
  assert.ok(group, "scene is not in the fixed authorized matrix");
  let retryOf = null;
  if (name !== group.name) {
    assert.match(process.env.C1_RETRY_OF || "", new RegExp(`^${group.name}(?:-retry-[1-9][0-9]*)?$`));
    assert.notEqual(name, process.env.C1_RETRY_OF);
    retryOf = path.join(manifest.resultRoot, "datasets", label, `scene-${process.env.C1_RETRY_OF}`, "result.json");
    const previous = await read(retryOf);
    const runtimeCorrection = group.variant === "candidate" && process.env.C1_RETRY_REASON === "runtime-correction" &&
      previous.evidence?.runtimeFingerprint !== manifest.candidateFingerprint;
    if (runtimeCorrection) {
      assert.match(previous.evidence?.runtimeFingerprint || "", /^[a-f0-9]{64}$/);
      await verifyFrozenRuntime(await read(previous.evidence.variant === "candidate" ?
        (await read(previous.evidence.manifestFile)).candidateFile : manifest.baselineFile));
    } else if (previous.passed) {
      assert.ok(process.env.C1_RETRY_ANALYSIS, "passed page run requires a retained failed gate analysis for retry");
      const failed = await read(process.env.C1_RETRY_ANALYSIS);
      assert.equal(failed.candidateFingerprint, previous.evidence.candidateFingerprint);
      assert.ok(failed.groups.some(row => row.label === label && row.layout === layout && row.variant === group.variant &&
        row.name === process.env.C1_RETRY_OF && !row.passed), "retry requires an actual failure of this group");
    } else assert.equal(previous.passed, false);
  }
  assert.equal(path.resolve(specFile), group.variant === "baseline" ? manifest.baselineFile : manifest.candidateFile);
  assert.equal(fingerprint(spec.hashes), manifest[`${group.variant}Fingerprint`]);
  await verifyFrozenRuntime(spec); await verifyEntries(manifest.tools); await verifyEntries(manifest.workspace);
  assert.equal(fingerprint(manifest.tools), manifest.toolsFingerprint);
  assert.deepEqual(await environment(), manifest.runtime);
  let clockReplay = null, clockReplayFingerprint = null;
  if (label === "year") {
    const reference = manifest.year.references.find(row => row.layout === layout); assert.ok(reference);
    assert.equal(fingerprint(reference.clockReplay), reference.clockReplayFingerprint);
    await verifyEntries(reference.entries);
    clockReplay = reference.clockReplay; clockReplayFingerprint = reference.clockReplayFingerprint;
  }
  const input = manifest.datasets.find(row => row.label === label); assert.ok(input);
  assert.equal(fingerprint(input.entries), input.fingerprint); await verifyEntries(input.entries);
  assert.deepEqual((await filesUnder(input.home)).map(file => path.join(input.home, file)).sort(), input.homeFiles);
  if (label === "two-years") {
    const front = await read(manifest.frontGate.file);
    assert.equal(await hashFile(manifest.frontGate.file), manifest.frontGate.sha256);
    assert.equal(front.frontGatePassed, true); assert.equal(front.candidateFingerprint, manifest.candidateFingerprint);
  }
  return { manifestFile, manifestSha256: await hashFile(manifestFile), variant: group.variant,
    candidateFingerprint: manifest.candidateFingerprint, runtimeFingerprint: fingerprint(spec.hashes),
    inputFingerprint: input.fingerprint, conditions: manifest.conditions, retryOf,
    retryReason: retryOf ? process.env.C1_RETRY_REASON || "retained-failure" : null, clockReplay, clockReplayFingerprint };
}

export async function extendTwoYears(frontFile) {
  const front = await read(frontFile);
  assert.equal(path.dirname(path.resolve(front.manifestFile)), RESULT_ROOT);
  const manifest = await read(front.manifestFile);
  assert.equal(front.frontGatePassed, true); assert.equal(front.candidateFingerprint, manifest.candidateFingerprint);
  assert.equal(front.passed, true); assert.equal(front.groups.length, 6); assert.ok(front.groups.every(row => row.passed));
  assert.equal(front.manifestSha256, await hashFile(front.manifestFile));
  assert.equal(manifest.groups.length, 6);
  const input = await freezeInputs("two-years"); // Explicitly prepare its one-time input/seeds only after the front gate.
  const extended = { ...manifest, datasets: [...manifest.datasets, input], deferred: [],
    frontGate: { file: path.resolve(frontFile), sha256: await hashFile(frontFile) },
    groups: [...manifest.groups, ...TWO_YEAR_GROUPS] };
  await save(path.join(RESULT_ROOT, "manifest-two-years.json"), extended); return extended;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const command = process.argv[2];
  if (command === "freeze-candidate") { await freezeCandidate(); console.log("candidate and six-group manifest frozen; no scenes started"); }
  else if (command === "extend-two-years" && process.argv[3]) { await extendTwoYears(process.argv[3]); console.log("two deferred groups enabled; no scenes started"); }
  else throw Error("freeze-candidate | extend-two-years <passed-front-analysis.json> (explicit operations only)");
}
