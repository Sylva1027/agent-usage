import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, hashFile, inside, read, save, verifyRuntime } from "./remaining-harness-delivery-prepare.mjs";

const zcodeFirstPrefix = process.argv.includes("--zcode-first-prefix");
const firstUpdateCache = zcodeFirstPrefix || process.argv.includes("--first-update-cache");
const sqliteStability = firstUpdateCache || process.argv.includes("--sqlite-stability");
const base = path.resolve(process.env.REMAINING_DELIVERY_ROOT || path.join(ROOT, zcodeFirstPrefix
  ? "output/zcode-first-prefix-20261106" : sqliteStability
  ? (firstUpdateCache ? "output/first-update-cache-20261106" : "output/sqlite-refresh-stability-20261106") : "output/source-prefix-publish-20261106"));
const prior = path.join(ROOT, zcodeFirstPrefix ? "output/first-update-cache-20261106" : firstUpdateCache ? "output/sqlite-refresh-stability-20261106" : sqliteStability
  ? "output/source-prefix-publish-20261106" : "output/remaining-harness-delivery-20261105");
await assert.rejects(stat(path.join(base, "matrix.json")), { code: "ENOENT" });
assert.ok(inside(path.join(ROOT, "output"), base));
const previous = await read(path.join(prior, "matrix.json"));
const manifest = await read(path.join(base, "baseline-hashes.json"));
const current = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, windowsHide: true }).toString().trim();
const versions = {};
for (const variant of ["baseline", "candidate"]) {
  const directory = path.join(base, "versions", variant), hashes = {};
  for (const relative of Object.keys(previous.versions.candidate.hashes)) {
    const production = manifest.some((entry) => entry.path === relative);
    const original = production ? path.join(variant === "baseline" ? path.join(base, "baseline") : ROOT, relative)
      : path.join(previous.versions.candidate.directory, relative);
    const target = path.join(directory, relative);
    assert.ok(inside(directory, target));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(original, target);
    hashes[relative] = await hashFile(target);
    if (production && variant === "baseline") {
      assert.equal(hashes[relative], manifest.find((entry) => entry.path === relative).sha256);
      assert.equal(hashes[relative], previous.versions.candidate.hashes[relative], "baseline must retain the preceding completed implementation");
    }
    if (!production && !relative.includes(`${path.sep}bin${path.sep}`)) assert.equal(await hashFile(path.join(ROOT, relative)), hashes[relative]);
  }
  assert.equal(manifest.length, Object.keys(hashes).filter((relative) => /^(src|public)[\\/]/.test(relative)).length);
  versions[variant] = { directory, hashes, commit: variant === "baseline"
    ? (zcodeFirstPrefix ? "56e5805" : firstUpdateCache ? "f8aefe6" : sqliteStability ? "7f95811" : "db5e951") : "working candidate", workspaceCommit: current };
  await verifyRuntime(versions[variant]);
}
for (const file of previous.files) {
  assert.ok(inside(previous.home, file.filePath));
  assert.equal(await hashFile(file.original), file.sha256, "original capture changed");
  if (!Object.values(previous.selected).some((selected) => selected.filePath === file.filePath))
    assert.equal(await hashFile(file.filePath), file.sha256, "unselected mirror changed");
}
const seedTarget = path.join(base, "seed-state");
await assert.rejects(stat(seedTarget), { code: "ENOENT" });
await cp(path.join(prior, "seed-state"), seedTarget, { recursive: true, errorOnExist: true, force: false });
await mkdir(path.join(base, "working-state"));
await mkdir(path.join(base, "seed"));
await copyFile(path.join(prior, "seed/result.json"), path.join(base, "seed/result.json"));
const matrix = { ...previous, versions, prefixPublication: true, ...(sqliteStability ? { sqliteStability: true } : {}),
  ...(firstUpdateCache ? { firstUpdateCache: true } : {}),
  ...(zcodeFirstPrefix ? { zcodeFirstPrefix: true } : {}),
  telemetryModule: fileURLToPath(new URL(firstUpdateCache ? "first-update-telemetry.mjs" : "source-prefix-publish-telemetry.mjs", import.meta.url)),
  reusedSeed: path.join(prior, "seed-state"), createdAt: new Date().toISOString() };
await save(path.join(base, "matrix.json"), matrix);
console.log(JSON.stringify({ prepared: true, files: matrix.files.length, planned: matrix.planned,
  baselineFiles: manifest.length, sourceMirrorsReused: true, seedReused: true }));
