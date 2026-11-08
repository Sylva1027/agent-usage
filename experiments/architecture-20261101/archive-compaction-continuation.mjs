import assert from "node:assert/strict";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ROOT, read, save } from "./c1-datasets.mjs";
import { hashFile } from "./remaining-harness-delivery-prepare.mjs";
import { verifyEntries } from "./persistent-history-prepare.mjs";

export const ACCEPTED_NAMES = ["append-dsh", "append-claude", "append-workbuddy", "append-zcode", "revision-zcode"];
const resultRoot = path.join(ROOT, "output/archive-compaction-20261108");
const receiptFile = path.join(resultRoot, "continuation/receipt.json");
const revisedReceiptFile = path.join(resultRoot, "continuation/receipt-v2.json");

function selectedReceipt() {
  const selected = path.resolve(process.env.C1_COMPACTION_CONTINUATION || receiptFile);
  assert.ok([receiptFile, revisedReceiptFile].includes(selected), "unknown continuation receipt");
  return selected;
}

export function acceptedCurrentIssues(analysis) {
  assert.equal(analysis.stage, "current");
  assert.equal(analysis.passed, false);
  assert.equal(analysis.groups.length, 4);
  assert.equal(analysis.upgrades.length, 1);
  assert.equal(analysis.upgrades[0].passed, true);
  assert.equal(analysis.issues.length, 1);
  const issue = analysis.issues[0];
  assert.equal(issue.group, "current/mixed/candidate");
  assert.equal(issue.gate, "latency");
  const rows = analysis.groups.find(row => row.id === issue.group).latencies.filter(row => !row.passed);
  assert.deepEqual(rows.map(row => row.name), ACCEPTED_NAMES);
  assert.deepEqual(JSON.parse(issue.message), rows);
  return analysis.issues;
}

export function classifyIssues(issues, accepted) {
  const inherited = issues.filter(issue => issue.group === "current/mixed/candidate" && issue.gate === "latency");
  assert.deepEqual(inherited, accepted, "accepted current deviations changed");
  return { acceptedIssues: inherited, newIssues: issues.filter(issue => !inherited.includes(issue)) };
}

export async function continuation(manifest, manifestFile) {
  if (!process.env.C1_COMPACTION_CONTINUATION) return null;
  const receipt = await read(selectedReceipt());
  assert.equal(receipt.kind, "archive-compaction-continuation");
  assert.equal(receipt.candidateFingerprint, manifest.candidateFingerprint);
  assert.equal(receipt.manifest.file, path.resolve(manifestFile));
  assert.equal(receipt.manifest.sha256, await hashFile(manifestFile));
  assert.equal(receipt.current.file, path.join(resultRoot, "analysis-current.json"));
  assert.deepEqual(receipt.dependencies.map(row => row.file), [path.join(manifest.dataRoot, "analysis-delivery.json"),
    path.join(ROOT, "experiments/architecture-20261101/archive-verification-analyze.mjs"),
    path.join(ROOT, "experiments/architecture-20261101/resource-identity-analysis.mjs")]);
  await verifyEntries([receipt.current, ...receipt.originalTools, ...receipt.tools, ...receipt.extraTools, ...receipt.dependencies]);
  assert.deepEqual(receipt.originalTools.map(({ originalFile, sha256 }) => ({ file: originalFile, sha256 })), manifest.tools);
  assert.deepEqual(receipt.tools.map(row => row.file), manifest.tools.map(row => row.file));
  for (let i = 0; i < manifest.tools.length; i++) if (receipt.tools[i].sha256 !== manifest.tools[i].sha256)
    assert.ok(["archive-compaction-prepare.mjs", "archive-compaction-run.mjs", "archive-compaction-upgrade.mjs", "c1-run.mjs"].includes(path.basename(receipt.tools[i].file)), "unexpected changed measurement tool");
  assert.deepEqual(receipt.extraTools.map(row => row.file), [fileURLToPath(import.meta.url),
    path.join(ROOT, "experiments/architecture-20261101/archive-compaction-analyze.mjs"),
    path.join(ROOT, "experiments/architecture-20261101/archive-compaction-continuation.test.mjs")]);
  const current = await read(receipt.current.file);
  assert.equal(current.candidateFingerprint, manifest.candidateFingerprint);
  assert.equal(current.manifestSha256, receipt.manifest.sha256);
  assert.deepEqual(receipt.acceptedIssues, acceptedCurrentIssues(current));
  return receipt;
}

export async function frontGate(front, manifest, manifestFile) {
  const receipt = await continuation(manifest, manifestFile);
  if (!receipt) return assert.equal(front.passed, true, "previous scale must pass before advancing");
  assert.equal(front.candidateFingerprint, receipt.candidateFingerprint);
  assert.equal(front.manifestSha256, receipt.manifest.sha256);
  if (front.stage === "current") assert.deepEqual(front, await read(receipt.current.file));
  else {
    assert.equal(front.stage, "year");
    assert.equal(front.groups.length, 8); assert.equal(front.upgrades.length, 2);
    assert.ok(front.upgrades.every(row => row.passed));
    assert.deepEqual(classifyIssues(front.issues, receipt.acceptedIssues).newIssues, []);
    assert.equal(front.continuationPassed, true);
    assert.equal(front.continuationReceiptSha256, await hashFile(selectedReceipt()));
  }
}

async function prepare(output = receiptFile) {
  await assert.rejects(stat(output), { code: "ENOENT" }, "preserve continuation receipt");
  const manifestFile = path.join(resultRoot, "manifest.json"), manifest = await read(manifestFile);
  const originalTools = manifest.tools.map(row => ({ originalFile: row.file, sha256: row.sha256,
    file: path.join(resultRoot, "continuation/original-tools", path.basename(row.file)) }));
  await verifyEntries(originalTools);
  const tools = await Promise.all(manifest.tools.map(async row => ({ file: row.file, sha256: await hashFile(row.file) })));
  const extraTools = await Promise.all([fileURLToPath(import.meta.url),
    path.join(ROOT, "experiments/architecture-20261101/archive-compaction-analyze.mjs"),
    path.join(ROOT, "experiments/architecture-20261101/archive-compaction-continuation.test.mjs")]
    .map(async file => ({ file, sha256: await hashFile(file) })));
  const currentFile = path.join(resultRoot, "analysis-current.json"), current = await read(currentFile);
  const dependencies = await Promise.all([path.join(manifest.dataRoot, "analysis-delivery.json"),
    path.join(ROOT, "experiments/architecture-20261101/archive-verification-analyze.mjs"),
    path.join(ROOT, "experiments/architecture-20261101/resource-identity-analysis.mjs")]
    .map(async file => ({ file, sha256: await hashFile(file) })));
  const c1 = await read(path.join(manifest.dataRoot, "analysis-delivery.json"));
  const { latencies } = await import("./persistent-history-analyze.mjs");
  const yearLimitsMs = Object.fromEntries(Object.entries(latencies(c1.datasets.find(row => row.label === "year").scenes.find(row => row.layout === "mixed")))
    .filter(([name]) => name === "reopen" || name.startsWith("append-") || name === "revision-zcode" || name.startsWith("scope-"))
    .map(([name, ms]) => [name, ms * 0.2]));
  await mkdir(path.dirname(receiptFile), { recursive: true });
  await save(output, { kind: "archive-compaction-continuation", createdAt: new Date().toISOString(),
    authorization: "User accepted precisely the five current mixed latency deviations and authorized six remaining page groups and two upgrades.",
    candidateFingerprint: manifest.candidateFingerprint, manifest: { file: manifestFile, sha256: await hashFile(manifestFile) },
    current: { file: currentFile, sha256: await hashFile(currentFile) }, acceptedIssues: acceptedCurrentIssues(current), yearLimitsMs, originalTools, tools, extraTools, dependencies });
  console.log(output);
}

async function pair(id) {
  const [label, layout] = id.split("/");
  assert.ok(["year/hot", "year/mixed", "two-years/mixed"].includes(id));
  const { verifyManifest } = await import("./archive-compaction-prepare.mjs");
  const { COMPACTION } = await import("./archive-compaction-analyze.mjs");
  const { latencyGates, timings, verificationGate, verificationRows } = await import("./archive-verification-analyze.mjs");
  const { CASES, exactParity, resources, workGate, latencies } = await import("./persistent-history-analyze.mjs");
  const { deriveResources, withDerivedResources } = await import("./resource-identity-analysis.mjs");
  const manifestFile = path.join(resultRoot, "manifest.json"), manifest = await verifyManifest(manifestFile);
  const output = path.join(resultRoot, "continuation", `pair-${label}-${layout}.json`);
  await assert.rejects(stat(output), { code: "ENOENT" });
  const receipt = await deriveResources(resultRoot, ["datasets", "upgrades"]);
  const result = { id, passed: false, issues: [], latencies: [] };
  try {
    await withDerivedResources(receipt, async () => {
      const scenes = {}, roots = {};
      for (const variant of ["baseline", "candidate"]) {
        const root = path.join(resultRoot, "datasets", label, `scene-${layout}-${variant}`);
        roots[variant] = root;
        const scene = scenes[variant] = await read(path.join(root, "result.json"));
        assert.equal(scene.passed, true); assert.equal(scene.rawRestored, true); assert.deepEqual(scene.errors, []);
        const measured = await resources(root, scene); assert.equal(measured.memory.passed, true);
        assert.equal(measured.archiveProof.failedCalls, 0);
        if (variant === "candidate") assert.equal(workGate(scene, measured).passed, true);
        const rows = await verificationRows(root);
        verificationGate(scene, measured, rows, timings(scene, rows, measured), { ...COMPACTION, packages: manifest.compactPackages, variant });
      }
      for (const name of CASES) exactParity(await read(path.join(roots.candidate, `${name}.json`)), await read(path.join(roots.baseline, `${name}.json`)), false, true);
      const c1 = await read(path.join(manifest.dataRoot, "analysis-delivery.json"));
      const original = c1.datasets.find(row => row.label === "year").scenes.find(row => row.layout === layout);
      result.latencies = latencyGates(label, layout, scenes.baseline, scenes.candidate, latencies(original), {}, COMPACTION);
      assert.ok(result.latencies.every(row => row.passed), JSON.stringify(result.latencies.filter(row => !row.passed)));
      result.passed = true;
    });
  } catch (error) { result.issues.push(error.message); }
  await save(output, result);
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === "prepare") await prepare();
  else if (process.argv[2] === "prepare-v2") await prepare(revisedReceiptFile);
  // Finish module evaluation before pair imports the prepare module, which imports this module.
  else { assert.equal(process.argv[2], "pair"); setImmediate(() => pair(process.argv[3]).catch(error => { console.error(error); process.exitCode = 1; })); }
}
