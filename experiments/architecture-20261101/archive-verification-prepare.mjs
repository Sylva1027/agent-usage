import assert from "node:assert/strict";
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, BASE, inside, read, save } from "./c1-datasets.mjs";
import { CONDITIONS, fingerprint, filesUnder, hashEntries, verifyEntries, verifyFrozenRuntime,
  toolReceipt, environment, buildClockReplay } from "./persistent-history-prepare.mjs";
import { hashFile } from "./remaining-harness-delivery-prepare.mjs";

export const RESULT_ROOT = path.join(ROOT, "output/archive-verification-reuse-20261108");
export const REUSED_MANIFEST = path.join(ROOT, "output/persistent-mixed-history-20261107/manifest-two-years-v14.json");
export const GROUPS = [...["current", "year"].flatMap(label => ["hot", "mixed"].flatMap(layout =>
  ["baseline", "candidate"].map(variant => ({ label, layout, variant, name: `${layout}-${variant}` })))),
  ...["baseline", "candidate"].map(variant => ({ label: "two-years", layout: "mixed", variant, name: `mixed-${variant}` }))];
export const DIAGNOSTIC = { label: "two-years", layout: "mixed", variant: "baseline", name: "mixed-diagnostic" };
export function assertMatrix(groups, diagnostic = false) { assert.deepEqual(groups, diagnostic ? [DIAGNOSTIC] : GROUPS); }
export async function tools() {
  const original = await toolReceipt();
  const extra = (await filesUnder(path.join(ROOT, "experiments/architecture-20261101")))
    .filter(file => /^archive-verification-[^\\/]+\.mjs$/.test(file));
  const entries = [...original.entries, ...await hashEntries(extra.map(file => path.join(ROOT, "experiments/architecture-20261101", file)))];
  return { entries, sha256: fingerprint(entries) };
}
export async function prepare(diagnostic = false) {
  const root = diagnostic ? path.join(RESULT_ROOT, "diagnostic") : RESULT_ROOT;
  await assert.rejects(stat(path.join(root, "manifest.json")), { code: "ENOENT" });
  const baselineFile = path.join(RESULT_ROOT, "baseline.json"), baseline = await read(baselineFile);
  assert.equal(baseline.commit, "186b30b"); await verifyFrozenRuntime(baseline);
  assert.equal(Object.keys(baseline.hashes).length, 117, "frozen baseline inventory");
  const nativeInventory = Object.keys(baseline.hashes).filter(file => /^native[\\/]/.test(file));
  assert.equal(nativeInventory.filter(file => !/[\\/]bin[\\/]/.test(file)).length, 7, "seven native source/config entries");
  assert.equal(nativeInventory.filter(file => /[\\/]bin[\\/]/.test(file)).length, 2, "native binary and build receipt");
  const reused = await read(REUSED_MANIFEST), labels = diagnostic ? ["two-years"] : ["current", "year", "two-years"];
  const datasets = labels.map(label => { const input = reused.datasets.find(row => row.label === label); assert.ok(input); return input; });
  // Reuse V14's raw bytes, old indexes and original uncompressed archives; scene admission rehashes them.
  for (const input of datasets) assert.equal(fingerprint(input.entries), input.fingerprint);
  let candidateFile = null, candidateFingerprint = null, workspace = [];
  if (!diagnostic) {
    candidateFile = path.join(root, "candidate.json");
    await assert.rejects(stat(candidateFile), { code: "ENOENT" });
    const nativeRoot = path.join(ROOT, "native/windows-source-proof"), nativeReceipt = await read(path.join(nativeRoot, "bin/windows-source-proof.build.json"));
    assert.equal(nativeReceipt.format, 1); assert.equal(nativeReceipt.artifact, "windows-source-proof.exe");
    assert.ok(nativeReceipt.sourceSha256 && Object.keys(nativeReceipt.sourceSha256).length >= 5, "missing native build source receipt");
    assert.deepEqual(Object.keys(nativeReceipt.sourceSha256).sort(), ["Cargo.toml", "Cargo.lock", "build.ps1",
      ...(await filesUnder(path.join(nativeRoot, "src"))).filter(file => file.endsWith(".rs")).map(file => `src/${file.replaceAll("\\", "/")}`)].sort());
    const nativeEntries = Object.keys(nativeReceipt.sourceSha256).map(file => {
      assert.ok(inside(nativeRoot, path.resolve(nativeRoot, file)), "native receipt path escapes helper root");
      return { file: path.join(nativeRoot, file), sha256: nativeReceipt.sourceSha256[file] };
    });
    await verifyEntries(nativeEntries);
    assert.equal(await hashFile(path.join(nativeRoot, "bin/windows-source-proof.exe")), nativeReceipt.sha256, "current native build drift");
    const nativeFiles = [...new Set([...Object.keys(baseline.hashes).filter(file => /^native[\\/]/.test(file)).map(file => file.replaceAll("\\", "/")),
      ...Object.keys(nativeReceipt.sourceSha256).map(file => `native/windows-source-proof/${file}`)])];
    const entries = [...(await filesUnder(path.join(ROOT, "src"))).map(file => path.join("src", file)),
      ...(await filesUnder(path.join(ROOT, "public"))).map(file => path.join("public", file)), "package.json", "package-lock.json",
      ...nativeFiles.map(file => path.normalize(file))];
    workspace = await hashEntries(entries.map(file => path.join(ROOT, file)));
    const directory = path.join(root, "versions/candidate"), hashes = {};
    await mkdir(directory);
    for (const relative of entries) {
      const source = path.join(ROOT, relative), target = path.join(directory, relative);
      await mkdir(path.dirname(target), { recursive: true }); await copyFile(source, target); hashes[relative] = await hashFile(target);
    }
    await verifyEntries(workspace);
    for (const entry of workspace) assert.equal(hashes[path.relative(ROOT, entry.file)], entry.sha256);
    const candidate = { directory, hashes, commit: "workspace-explicit-freeze", frozenAt: new Date().toISOString() };
    await verifyFrozenRuntime(candidate); await save(candidateFile, candidate); candidateFingerprint = fingerprint(hashes);
  }
  const receipt = await tools(), runtime = await environment();
  const manifest = { version: 1, kind: "archive-verification-reuse", diagnostic, resultRoot: root, dataRoot: BASE,
    baselineFile, baselineFingerprint: fingerprint(baseline.hashes), candidateFile, candidateFingerprint, workspace,
    tools: receipt.entries, toolsFingerprint: receipt.sha256, runtime, conditions: CONDITIONS,
    reusedManifest: { file: REUSED_MANIFEST, sha256: await hashFile(REUSED_MANIFEST) }, datasets,
    groups: diagnostic ? [DIAGNOSTIC] : GROUPS, maximumGroups: diagnostic ? 1 : 10, createdAt: new Date().toISOString() };
  await save(path.join(root, "manifest.json"), manifest); return manifest;
}
export async function verifyManifest(manifestFile) {
  const manifest = await read(manifestFile);
  assert.equal(manifest.kind, "archive-verification-reuse"); assertMatrix(manifest.groups, manifest.diagnostic);
  assert.equal(manifest.dataRoot, BASE); assert.deepEqual(manifest.conditions, CONDITIONS);
  assert.ok(inside(path.join(ROOT, "output"), manifest.resultRoot));
  assert.equal(fingerprint(manifest.tools), manifest.toolsFingerprint); await verifyEntries(manifest.tools);
  if (manifest.workspace.length) await verifyEntries(manifest.workspace);
  for (const variant of manifest.diagnostic ? ["baseline"] : ["baseline", "candidate"]) {
    const spec = await read(manifest[`${variant}File`]); await verifyFrozenRuntime(spec);
    assert.equal(fingerprint(spec.hashes), manifest[`${variant}Fingerprint`]);
  }
  await verifyEntries([manifest.reusedManifest]);
  return manifest;
}
export async function verifyScene(manifestFile, label, layout, name, specFile) {
  const manifest = await verifyManifest(manifestFile), group = manifest.groups.find(row => row.label === label && row.layout === layout && row.name === name);
  assert.ok(group, "scene is outside the fixed matrix");
  if (!manifest.diagnostic) {
    const { admission } = await import("./archive-verification-run.mjs");
    await admission(manifest, group, manifestFile, process.env.C1_ARCHIVE_VALIDATION || path.join(RESULT_ROOT, "validation.json"));
  }
  assert.equal(process.env.C1_ARCHIVE_PROFILE, manifest.diagnostic ? "diagnostic" : "formal");
  assert.equal(path.resolve(process.env.C1_RESULT_ROOT), manifest.resultRoot);
  assert.equal(path.resolve(specFile), manifest[`${group.variant}File`]);
  assert.deepEqual(await environment(), manifest.runtime);
  const input = manifest.datasets.find(row => row.label === label); assert.ok(input);
  assert.equal(fingerprint(input.entries), input.fingerprint); await verifyEntries(input.entries);
  assert.deepEqual((await filesUnder(input.home)).map(file => path.join(input.home, file)).sort(), [...input.homeFiles].sort());
  let clockReplay = null;
  if (!manifest.diagnostic && group.variant === "candidate") {
    const directory = path.join(manifest.resultRoot, "datasets", label, `scene-${layout}-baseline`);
    clockReplay = await buildClockReplay({ directory, queryDirectory: directory,
      finalStateFile: path.join(manifest.resultRoot, "datasets", label, `state-scene-${layout}-baseline`, "usage-index.sqlite") },
    path.join(input.root, "seed-state/usage-index.sqlite"));
  }
  return { manifestFile: path.resolve(manifestFile), manifestSha256: await hashFile(manifestFile), variant: group.variant,
    candidateFingerprint: manifest.candidateFingerprint, runtimeFingerprint: manifest[`${group.variant}Fingerprint`],
    inputFingerprint: input.fingerprint, conditions: manifest.conditions, clockReplay,
    clockReplayFingerprint: clockReplay && fingerprint(clockReplay) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.ok(["diagnostic", "formal"].includes(process.argv[2]), "prepare diagnostic|formal");
  const result = await prepare(process.argv[2] === "diagnostic");
  console.log(JSON.stringify({ manifest: path.join(result.resultRoot, "manifest.json"), groups: result.groups.length }));
}
