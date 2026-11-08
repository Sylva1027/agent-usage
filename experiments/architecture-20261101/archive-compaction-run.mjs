import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, read } from "./c1-datasets.mjs";
import { command as verificationCommand } from "./archive-verification-run.mjs";
import { verifyEntries } from "./persistent-history-prepare.mjs";
import { hashFile } from "./remaining-harness-delivery-prepare.mjs";
import { RESULT_ROOT, assertMatrix, verifyManifest } from "./archive-compaction-prepare.mjs";

export async function validationGate(file, manifest) {
  const receipt = await read(file);
  assert.equal(receipt.passed, true, "B validation must pass before C");
  assert.equal(receipt.runtimeFingerprint, manifest.candidateFingerprint, "B validation belongs to another runtime");
  assert.ok(Array.isArray(receipt.checks) && receipt.checks.length, "missing B validation checks");
  const names = new Set();
  for (const row of receipt.checks) {
    assert.ok(row.name && !names.has(row.name) && row.command, "missing or duplicate validation check"); names.add(row.name);
    assert.equal(row.exitCode, 0, `failed validation: ${row.name}`);
    assert.ok(path.isAbsolute(row.log)); assert.match(row.sha256, /^[a-f0-9]{64}$/);
    await verifyEntries([{ file: row.log, sha256: row.sha256 }]);
  }
  return receipt;
}

export async function admission(manifest, group, manifestFile, validationFile = manifest.validationFile) {
  assert.equal(manifest.kind, "archive-compaction"); assertMatrix(manifest.groups);
  const index = manifest.groups.findIndex(row => row.label === group.label && row.layout === group.layout && row.variant === group.variant && row.name === group.name);
  assert.ok(index >= 0, "scene is outside the fixed matrix");
  await validationGate(validationFile, manifest);
  const manifestSha256 = await hashFile(manifestFile);
  for (const previous of manifest.groups.slice(0, index)) {
    const result = await read(path.join(manifest.resultRoot, "datasets", previous.label, `scene-${previous.name}/result.json`));
    assert.equal(result.passed, true, `prior group failed: ${previous.label}/${previous.name}`);
    assert.equal(result.rawRestored, true, "source restore must finish before the next group");
    assert.equal(result.evidence.manifestSha256, manifestSha256);
    assert.equal(result.evidence.runtimeFingerprint, manifest[`${previous.variant}Fingerprint`]);
    assert.equal(result.evidence.candidateFingerprint, manifest.candidateFingerprint);
  }
  if (group.label !== "current") {
    const stage = group.label === "year" ? "current" : "year";
    const front = await read(path.join(manifest.resultRoot, `analysis-${stage}.json`));
    assert.equal(front.stage, stage); assert.equal(front.passed, true, "previous scale must pass before advancing");
    assert.equal(front.candidateFingerprint, manifest.candidateFingerprint);
    assert.equal(front.manifestSha256, manifestSha256);
  }
}

export function command(manifest, group, manifestFile) {
  const spec = verificationCommand(manifest, group, manifestFile);
  spec.env.C1_ARCHIVE_PROFILE = "compaction";
  spec.env.C1_ARCHIVE_VALIDATION = manifest.validationFile;
  return spec;
}

export async function run(manifestFile, id, validationFile) {
  const manifest = await verifyManifest(manifestFile);
  const group = manifest.groups.find(row => `${row.label}/${row.layout}/${row.variant}` === id);
  assert.ok(group, "unknown fixed group");
  validationFile ||= manifest.validationFile;
  await admission(manifest, group, manifestFile, validationFile);
  await assert.rejects(stat(path.join(manifest.resultRoot, "datasets", group.label, `scene-${group.name}`)), { code: "ENOENT" });
  const spec = command(manifest, group, manifestFile); spec.env.C1_ARCHIVE_VALIDATION = validationFile;
  const child = spawn(spec.executable, spec.args, { cwd: ROOT, env: spec.env, windowsHide: true, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, `retained failure for ${id}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv[2], "run", "run <current|year|two-years>/<hot|mixed>/<baseline|candidate> [validation.json]");
  await run(path.join(RESULT_ROOT, "manifest.json"), process.argv[3], process.argv[4]);
}
