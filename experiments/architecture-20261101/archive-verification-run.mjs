import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, read } from "./c1-datasets.mjs";
import { RESULT_ROOT } from "./archive-verification-prepare.mjs";

export async function admission(manifest, group, manifestFile, validationFile) {
  if (manifest.diagnostic) return;
  const { validationGate } = await import("./archive-verification-analyze.mjs");
  await validationGate(validationFile, manifest);
  const index = manifest.groups.indexOf(group);
  for (const previous of manifest.groups.slice(0, index)) {
    const result = await read(path.join(manifest.resultRoot, "datasets", previous.label, `scene-${previous.name}/result.json`));
    assert.equal(result.passed, true, `prior group failed: ${previous.label}/${previous.name}`);
    assert.equal(result.rawRestored, true, "source restore must finish before another group");
  }
  if (group.label !== "current") {
    const stage = group.label === "year" ? "current" : "year";
    const front = await read(path.join(manifest.resultRoot, `analysis-${stage}.json`));
    assert.equal(front.stage, stage); assert.equal(front.passed, true, "front gate must pass before larger datasets");
    assert.equal(front.candidateFingerprint, manifest.candidateFingerprint);
    const { hashFile } = await import("./remaining-harness-delivery-prepare.mjs");
    assert.equal(front.manifestSha256, await hashFile(manifestFile));
  }
}

export function command(manifest, group, manifestFile) {
  return { executable: process.execPath, args: [path.join(ROOT, "experiments/architecture-20261101/c1-run.mjs"),
    "scene", group.label, group.layout, group.name], env: { ...process.env,
    C1_MANIFEST: path.resolve(manifestFile), C1_RESULT_ROOT: manifest.resultRoot,
    C1_RUNTIME_SPEC: manifest[`${group.variant}File`], C1_ARCHIVE_PROFILE: manifest.diagnostic ? "diagnostic" : "formal",
    C1_ARCHIVE_TRACE: "1", C1_METHOD_DIAGNOSTIC: "1" } };
}
export async function run(manifestFile, id, validationFile = path.join(RESULT_ROOT, "validation.json")) {
  const manifest = await read(manifestFile);
  const group = manifest.groups.find(row => `${row.label}/${row.layout}/${row.variant}` === id); assert.ok(group, "unknown fixed group");
  await admission(manifest, group, manifestFile, validationFile);
  const spec = command(manifest, group, manifestFile);
  spec.env.C1_ARCHIVE_VALIDATION = validationFile;
  const child = spawn(spec.executable, spec.args, { env: spec.env, cwd: ROOT, windowsHide: true, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, `retained failure for ${id}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const diagnostic = process.argv[2] === "diagnostic";
  assert.ok(diagnostic || process.argv[2] === "formal", "run diagnostic | formal <current|year|two-years>/<hot|mixed>/<baseline|candidate>");
  await run(path.join(RESULT_ROOT, diagnostic ? "diagnostic/manifest.json" : "manifest.json"), diagnostic ? "two-years/mixed/baseline" : process.argv[3], process.argv[4]);
}
