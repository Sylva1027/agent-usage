import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "compaction-continuation-"));
const previousEnv = process.env.C1_COMPACTION_CONTINUATION;
after(async () => {
  if (previousEnv === undefined) delete process.env.C1_COMPACTION_CONTINUATION;
  else process.env.C1_COMPACTION_CONTINUATION = previousEnv;
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(root, { recursive: true, force: true });
});

// Relocate ROOT only; keep the helper, hashing, verification and wx save unchanged.
const hooks = registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  if (url !== new URL("./c1-datasets.mjs", import.meta.url).href) return loaded;
  const source = String(loaded.source), expression = 'fileURLToPath(new URL("../../",import.meta.url))';
  assert.ok(source.includes(expression));
  return { ...loaded, source: source.replace(expression, JSON.stringify(root)) };
} });
let helper, save, hashFile;
try {
  helper = await import("./archive-compaction-continuation.mjs");
  ({ save } = await import("./c1-datasets.mjs"));
  ({ hashFile } = await import("./remaining-harness-delivery-prepare.mjs"));
} finally { hooks.deregister(); }
const { ACCEPTED_NAMES, acceptedCurrentIssues, classifyIssues, continuation, frontGate } = helper;
const expectedNames = ["append-dsh", "append-claude", "append-workbuddy", "append-zcode", "revision-zcode"];
const resultRoot = path.join(root, "output/archive-compaction-20261108");
const manifestFile = path.join(resultRoot, "manifest.json");
const currentFile = path.join(resultRoot, "analysis-current.json");
const receiptFile = path.join(resultRoot, "continuation/receipt.json");
let manifest, current, receipt;

const write = async (file, bytes) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes, { flag: "wx" });
};
// Deliberate corruption is confined to temporary fixtures and restored after each assertion.
async function changedFile(file, bytes, action) {
  assert.ok(file.startsWith(root + path.sep));
  const original = await fs.readFile(file);
  await fs.writeFile(file, bytes);
  try { return await action(); } finally { await fs.writeFile(file, original); }
}
const changedJson = (file, value, action) => changedFile(file, JSON.stringify(value), action);
async function env(value, action) {
  const previous = process.env.C1_COMPACTION_CONTINUATION;
  if (value === undefined) delete process.env.C1_COMPACTION_CONTINUATION;
  else process.env.C1_COMPACTION_CONTINUATION = value;
  try { return await action(); } finally {
    if (previous === undefined) delete process.env.C1_COMPACTION_CONTINUATION;
    else process.env.C1_COMPACTION_CONTINUATION = previous;
  }
}
function currentAnalysis() {
  const names = ["default", "startup-all", "first-all", "reopen",
    ...["codex", "dsh", "claude", "workbuddy", "zcode", "opencode"].map(kind => `append-${kind}`),
    "revision-zcode", ...["today", "week", "custom", "all"].map(scope => `scope-${scope}`), "reuse-repeat", "reuse-afterExit"];
  const latencies = names.map(name => ({ name, baselineMs: 1000, candidateMs: expectedNames.includes(name) ? 1200 : 1000,
    passed: !expectedNames.includes(name) }));
  return { stage: "current", passed: false,
    groups: ["hot/baseline", "hot/candidate", "mixed/baseline", "mixed/candidate"].map(id => ({
      id: `current/${id}`, passed: id !== "mixed/candidate", ...(id === "mixed/candidate" ? { latencies } : {}) })),
    upgrades: [{ label: "current", passed: true }],
    issues: [{ group: "current/mixed/candidate", gate: "latency", message: JSON.stringify(latencies.filter(row => !row.passed)) }] };
}
async function yearFront() {
  return { ...structuredClone(current), stage: "year", continuationPassed: true,
    continuationReceiptSha256: await hashFile(receiptFile),
    groups: [...structuredClone(current.groups), ...["hot/baseline", "hot/candidate", "mixed/baseline", "mixed/candidate"]
      .map(id => ({ id: `year/${id}`, passed: true }))],
    upgrades: [{ label: "current", passed: true }, { label: "year", passed: true }] };
}

before(async () => {
  const toolsRoot = path.join(root, "experiments/architecture-20261101"), originalTools = [], tools = [];
  for (const name of ["archive-compaction-prepare.mjs", "archive-compaction-run.mjs", "archive-compaction-upgrade.mjs", "c1-run.mjs", "archive-verification-run.mjs"]) {
    const file = path.join(toolsRoot, name), original = path.join(resultRoot, "continuation/original-tools", name);
    await write(original, `original ${name}`);
    await write(file, name === "archive-verification-run.mjs" ? `original ${name}` : `continued ${name}`);
    originalTools.push({ originalFile: file, file: original, sha256: await hashFile(original) });
    tools.push({ file, sha256: await hashFile(file) });
  }
  manifest = { kind: "archive-compaction", candidateFingerprint: "a".repeat(64), dataRoot: path.join(root, "output/c1-long-history-20261107"),
    tools: originalTools.map(({ originalFile, sha256 }) => ({ file: originalFile, sha256 })) };
  await save(manifestFile, manifest);
  current = { ...currentAnalysis(), candidateFingerprint: manifest.candidateFingerprint, manifestSha256: await hashFile(manifestFile) };
  await save(currentFile, current);
  const extraFiles = [fileURLToPath(new URL("./archive-compaction-continuation.mjs", import.meta.url)),
    path.join(toolsRoot, "archive-compaction-analyze.mjs"), path.join(toolsRoot, "archive-compaction-continuation.test.mjs")];
  for (const file of extraFiles.slice(1)) await write(file, `fixture ${path.basename(file)}`);
  const extraTools = await Promise.all(extraFiles.map(async file => ({ file, sha256: await hashFile(file) })));
  const dependencyFiles = [path.join(manifest.dataRoot, "analysis-delivery.json"),
    path.join(toolsRoot, "archive-verification-analyze.mjs"), path.join(toolsRoot, "resource-identity-analysis.mjs")];
  await save(dependencyFiles[0], { datasets: [] });
  for (const file of dependencyFiles.slice(1)) await write(file, `fixture ${path.basename(file)}`);
  const dependencies = await Promise.all(dependencyFiles.map(async file => ({ file, sha256: await hashFile(file) })));
  receipt = { kind: "archive-compaction-continuation", candidateFingerprint: manifest.candidateFingerprint,
    manifest: { file: manifestFile, sha256: await hashFile(manifestFile) },
    current: { file: currentFile, sha256: await hashFile(currentFile) }, acceptedIssues: structuredClone(current.issues),
    originalTools, tools, extraTools, dependencies };
  await save(receiptFile, receipt);
  process.env.C1_COMPACTION_CONTINUATION = receiptFile;
});

test("acceptedCurrentIssues accepts exactly the original five failed latencies without changing their verdict", () => {
  assert.deepEqual(ACCEPTED_NAMES, expectedNames);
  const analysis = currentAnalysis(), original = structuredClone(analysis);
  assert.deepEqual(acceptedCurrentIssues(analysis), analysis.issues);
  assert.deepEqual(analysis, original);
  assert.equal(analysis.passed, false);
});

test("acceptedCurrentIssues rejects missing, added, duplicate and substituted latency failures", () => {
  for (const change of [
    rows => { rows.find(row => row.name === "append-dsh").passed = true; },
    rows => { rows.find(row => row.name === "append-codex").passed = false; },
    rows => { rows.push(structuredClone(rows.find(row => row.name === "append-dsh"))); },
    rows => { rows.find(row => row.name === "append-dsh").name = "append-codex"; },
  ]) {
    const analysis = currentAnalysis(), rows = analysis.groups[3].latencies;
    change(rows); analysis.issues[0].message = JSON.stringify(rows.filter(row => !row.passed));
    assert.throws(() => acceptedCurrentIssues(analysis));
  }
});

test("acceptedCurrentIssues rejects other current gates, failed upgrades and mismatched issue details", () => {
  for (const change of [
    a => { a.stage = "year"; }, a => { a.passed = true; }, a => { a.groups.pop(); },
    a => { a.upgrades = []; }, a => { a.upgrades[0].passed = false; },
    a => { a.issues.push({ group: "current/hot/candidate", gate: "memory", message: "over budget" }); },
    a => { a.issues[0].group = "year/mixed/candidate"; }, a => { a.issues[0].gate = "work/storage"; },
    a => { a.issues[0].message = "[]"; }, a => { a.groups[3].latencies[5].candidateMs++; },
  ]) { const analysis = currentAnalysis(); change(analysis); assert.throws(() => acceptedCurrentIssues(analysis)); }
});

test("classifyIssues preserves every new failure including the same five names at year scale", () => {
  const accepted = currentAnalysis().issues;
  const added = [{ ...accepted[0], group: "year/mixed/candidate" },
    { group: "current/mixed/candidate", gate: "memory", message: "over budget" },
    { group: "year/hot/candidate", gate: "exact/initial-all", message: "different cost" },
    { group: "upgrade/year", gate: "existing-projection", message: "rebuilt" }];
  const issues = [...structuredClone(accepted), ...added], original = structuredClone(issues);
  assert.deepEqual(classifyIssues(issues, accepted), { acceptedIssues: accepted, newIssues: added });
  assert.deepEqual(issues, original);
  assert.deepEqual(classifyIssues(structuredClone(accepted), accepted).newIssues, []);
  for (const changed of [[], [...accepted, ...structuredClone(accepted)], [{ ...accepted[0], message: "[]" }]])
    assert.throws(() => classifyIssues(changed, accepted), /accepted current deviations changed/);
});

test("continuation is opt-in, binds real hashes and permits only the four named timed-tool changes", async () => {
  await env(undefined, async () => assert.equal(await continuation(manifest, manifestFile), null));
  await env(path.join(root, "other-receipt.json"), async () => assert.rejects(continuation(manifest, manifestFile)));
  const before = await fs.readFile(receiptFile);
  assert.deepEqual(await continuation(manifest, manifestFile), receipt);
  assert.equal(receipt.tools.filter((row, i) => row.sha256 !== manifest.tools[i].sha256).length, 4);
  assert.deepEqual(await fs.readFile(receiptFile), before);
});

test("continuation rejects receipt manifest/current/runtime/inventory mismatches", async () => {
  for (const change of [
    r => { r.kind = "another-card"; }, r => { r.candidateFingerprint = "b".repeat(64); },
    r => { r.manifest.file = currentFile; }, r => { r.manifest.sha256 = "0".repeat(64); },
    r => { r.current.file = manifestFile; }, r => { r.current.sha256 = "0".repeat(64); },
    r => { r.acceptedIssues[0].message = "[]"; }, r => { r.originalTools.pop(); },
    r => { r.originalTools[0].originalFile = currentFile; }, r => { r.tools.reverse(); },
    r => { r.extraTools.pop(); }, r => { r.extraTools[1].sha256 = "0".repeat(64); },
  ]) {
    const altered = structuredClone(receipt); change(altered);
    await changedJson(receiptFile, altered, () => assert.rejects(continuation(manifest, manifestFile)));
  }
  await assert.rejects(continuation({ ...manifest, candidateFingerprint: "b".repeat(64) }, manifestFile));
  assert.deepEqual(await continuation(manifest, manifestFile), receipt);
});

test("continuation detects changed bytes in manifest/current, old originals, timed and extra tools", async () => {
  for (const file of [manifestFile, currentFile, receipt.originalTools[0].file, receipt.tools[0].file,
    receipt.extraTools[1].file, receipt.extraTools[2].file])
    await changedFile(file, "changed fixture bytes", () => assert.rejects(continuation(manifest, manifestFile)));
  const stable = receipt.tools.at(-1);
  await changedFile(stable.file, "changed non-allowlisted tool", async () => {
    const altered = structuredClone(receipt); altered.tools.at(-1).sha256 = await hashFile(stable.file);
    await changedJson(receiptFile, altered, () => assert.rejects(continuation(manifest, manifestFile), /unexpected changed measurement tool/));
  });
});

test("continuation checks the current analysis runtime and manifest even with a matching current file hash", async () => {
  for (const field of ["candidateFingerprint", "manifestSha256"]) {
    const altered = structuredClone(current); altered[field] = "b".repeat(64);
    await changedJson(currentFile, altered, async () => {
      const nextReceipt = structuredClone(receipt); nextReceipt.current.sha256 = await hashFile(currentFile);
      await changedJson(receiptFile, nextReceipt, () => assert.rejects(continuation(manifest, manifestFile)));
    });
  }
});

test("continuation rejects changed bytes in each frozen C1/analyzer dependency", async () => {
  for (const { file } of receipt.dependencies)
    await changedFile(file, "changed dependency bytes", () => assert.rejects(continuation(manifest, manifestFile), /input\/runtime drift/));
  assert.deepEqual(await continuation(manifest, manifestFile), receipt);
});

test("frontGate keeps ordinary admission strict and accepts only the bound original current analysis", async () => {
  await env(undefined, async () => {
    await assert.rejects(frontGate(current, manifest, manifestFile), /previous scale/);
    await frontGate({ passed: true }, manifest, manifestFile);
  });
  await frontGate(structuredClone(current), manifest, manifestFile);
  for (const change of [f => { f.passed = true; }, f => { f.extra = true; }, f => { f.issues = []; }]) {
    const front = structuredClone(current); change(front);
    await assert.rejects(frontGate(front, manifest, manifestFile));
  }
});

test("frontGate year permits inherited failures with both upgrades and a matching continuation receipt", async () => {
  const front = await yearFront(), original = structuredClone(front);
  assert.equal(front.passed, false);
  await frontGate(front, manifest, manifestFile);
  assert.deepEqual(front, original);
  for (const change of [
    f => { f.stage = "all"; }, f => { f.groups.pop(); }, f => { f.upgrades.pop(); },
    f => { f.upgrades[1].passed = false; }, f => { f.continuationPassed = false; },
    f => { f.continuationReceiptSha256 = "0".repeat(64); },
    f => { f.manifestSha256 = "0".repeat(64); }, f => { f.candidateFingerprint = "0".repeat(64); },
  ]) { const altered = structuredClone(front); change(altered); await assert.rejects(frontGate(altered, manifest, manifestFile)); }
});

test("frontGate year rejects new failures even when passed/continuationPassed and newIssues claim success", async () => {
  for (const issue of [{ ...current.issues[0], group: "year/mixed/candidate" },
    { group: "year/hot/candidate", gate: "memory", message: "over budget" },
    { group: "upgrade/year", gate: "existing-projection", message: "cold copy" }]) {
    const front = await yearFront(); front.issues.push(issue);
    front.passed = true; front.newIssues = [];
    await assert.rejects(frontGate(front, manifest, manifestFile));
  }
});

test("wx saves preserve existing manifest, current analysis and continuation receipt", async () => {
  for (const file of [manifestFile, currentFile, receiptFile]) {
    const before = await fs.readFile(file);
    await assert.rejects(save(file, { replaced: true }), { code: "EEXIST" });
    assert.deepEqual(await fs.readFile(file), before);
  }
});
