import assert from "node:assert/strict";
import { copyFile, cp, mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, hashFile, inside, read, save, verifyRuntime } from "./remaining-harness-delivery-prepare.mjs";

const base = path.resolve(process.env.REMAINING_DELIVERY_ROOT || path.join(ROOT, "output/opencode-regression-20261106"));
assert.ok(inside(path.join(ROOT, "output"), base));
await assert.rejects(stat(path.join(base, "matrix.json")), { code: "ENOENT" });
const prior = path.join(ROOT, "output/zcode-first-prefix-20261106");
const previous = await read(path.join(prior, "matrix.json"));
const versions = {}, manifest = [];
for (const variant of ["baseline", "current", "candidate"]) {
  const reference = previous.versions[variant === "baseline" ? "baseline" : "candidate"];
  const directory = path.join(base, "versions", variant), hashes = {};
  for (const relative of Object.keys(reference.hashes)) {
    const production = /^(src|public)[\\/]/.test(relative);
    const original = variant === "candidate" && production ? path.join(ROOT, relative) : path.join(reference.directory, relative);
    hashes[relative] = await hashFile(original);
    if (variant !== "candidate" || !production)
      assert.equal(hashes[relative], reference.hashes[relative], "control runtime changed");
    const target = path.join(directory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(original, target);
    if (variant === "current" && production) {
      const frozen = path.join(base, "baseline", relative);
      await mkdir(path.dirname(frozen), { recursive: true });
      await copyFile(original, frozen);
      manifest.push({ path: relative, sha256: hashes[relative] });
    }
  }
  versions[variant] = { directory, hashes, commit: variant === "baseline" ? "56e5805"
    : variant === "current" ? "799d83e" : "candidate from 799d83e" };
  await verifyRuntime(versions[variant]);
}
for (const file of previous.files) {
  assert.equal(await hashFile(file.original), file.sha256);
  if (!Object.values(previous.selected).some((selected) => selected.filePath === file.filePath))
    assert.equal(await hashFile(file.filePath), file.sha256);
}
await save(path.join(base, "baseline-hashes.json"), manifest);
await cp(path.join(prior, "seed-state"), path.join(base, "seed-state"), { recursive: true, errorOnExist: true, force: false });
await mkdir(path.join(base, "working-state"));
await mkdir(path.join(base, "seed"));
await copyFile(path.join(prior, "seed/result.json"), path.join(base, "seed/result.json"));
await save(path.join(base, "matrix.json"), { ...previous, versions, opencodeRegression: true,
  baselines: { claude: "baseline", opencode: "baseline", zcode: "current", workbuddy: "current" },
  telemetryModule: fileURLToPath(new URL("opencode-regression-trace.mjs", import.meta.url)),
  createdAt: new Date().toISOString() });
await save(path.join(base, "environment.json"), { node: process.version, executable: process.execPath,
  versions: process.versions, os: { platform: os.platform(), release: os.release(), arch: os.arch(), cpus: os.cpus().length },
  browser: previous.runtime, native: Object.fromEntries(Object.entries(versions.current.hashes).filter(([name]) => name.includes("bin"))),
  memoryBudgetsMiB: { gateway: 512, executor: 224, semiSpace: 4 }, at: new Date().toISOString() });
console.log(JSON.stringify({ prepared: true, frozenProductionFiles: manifest.length, versions: Object.keys(versions) }));
