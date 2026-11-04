import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const label = process.env.Q6_PERFORMANCE_LABEL || "q6-20261105-b";
assert.match(label, /^q6-[a-z0-9-]+$/);
export const BASE = path.join(ROOT, "output/architecture-20261105/q6", label);
const read = async (file) => JSON.parse(await readFile(file, "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function prepare() {
  await mkdir(BASE, { recursive: false });
  const implementation = path.join(ROOT, "output/architecture-20261104/q6-implementation");
  const baselineHashes = await read(path.join(implementation, "baseline-hashes.json"));
  const candidateHashes = await read(path.join(implementation, "runtime-final-hashes.json"));
  const versions = [];
  for (const [variant, source, expected] of [["baseline", path.join(implementation, "baseline"), baselineHashes], ["candidate", ROOT, candidateHashes]]) {
    const directory = path.join(BASE, "versions", variant);
    const hashes = {};
    for (const [relative, hash] of Object.entries(expected)) {
      const normalized = relative.replaceAll("\\", "/");
      const bytes = await readFile(path.join(source, relative));
      assert.equal(sha(bytes), hash, `Frozen ${variant} mismatch: ${relative}`);
      const file = path.join(directory, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes, { flag: "wx" }); hashes[normalized] = hash;
    }
    const binary = variant === "baseline" ? path.join(ROOT, "native/windows-source-proof/bin/windows-source-proof.exe")
      : path.join(implementation, "native-target/release/windows-source-proof.exe");
    const nativeBinary = path.join(directory, "native/windows-source-proof/bin/windows-source-proof.exe");
    await mkdir(path.dirname(nativeBinary), { recursive: true });
    await copyFile(binary, nativeBinary);
    hashes["native/windows-source-proof/bin/windows-source-proof.exe"] = sha(await readFile(nativeBinary));
    const hashesFile = path.join(BASE, `${variant}-hashes.json`);
    await writeFile(hashesFile, JSON.stringify(hashes, null, 2));
    versions.push({ variant, directory, nativeBinary, hashesFile });
  }
  const previous = await read(path.join(ROOT, "output/architecture-20261104/q5/q5-20261104-a/matrix.json"));
  const pricingFile = path.join(BASE, "captured-pricing.json");
  await copyFile(previous.pricing.file, pricingFile);
  const matrix = { generation: "q6", base: BASE, versions, createdAt: new Date().toISOString(),
    pricing: { ...previous.pricing, file: pricingFile }, appendTimeMs: Date.now() - 60_000,
    heaps: { gateway: 512, executor: 224, semi: 4 }, planned: { appends: 40, switches: 24, reopens: 8, emptyRealHistoryRebuilds: 0 },
    earlyStop: { maximumFullFallbackFraction: 0.5, minimum10xImprovement: 0.15 },
    cells: [], originalMatrix: path.join(ROOT, "output/architecture-20261104/q5/q5-20261104-a/matrix.json") };
  // The old canonical homes are mutable test fixtures. Preserve and restore their previous bytes.
  for (const canonical of previous.canonical) {
    const home = canonical.prepared.home;
    const prior = {};
    for (const [kind, selected] of Object.entries(canonical.prepared.selected)) {
      const info = await stat(selected.targetPath);
      assert.equal(info.nlink, 1);
      const file = path.join(BASE, "prior-inputs", canonical.id, kind);
      await mkdir(path.dirname(file), { recursive: true });
      await copyFile(selected.targetPath, file);
      prior[kind] = { file, path: selected.targetPath, size: info.size, mtimeMs: info.mtimeMs };
    }
    for (const variant of ["baseline", "candidate"]) {
      const directory = path.join(BASE, "page", canonical.id, variant);
      const stateDirectory = path.join(directory, "state");
      await mkdir(stateDirectory, { recursive: true });
      const auxiliaryDirectory = canonical.proofMode === "native"
        ? path.join(os.tmpdir(), "codex-q6-20261105-a", "auxiliary", canonical.id, variant) : stateDirectory;
      await mkdir(auxiliaryDirectory, { recursive: true });
      for (const name of ["pricing.json", "pricing-auto.json", "codex-quota.json"]) {
        const from = path.join(canonical.prepared.stateDirectory, name);
        try { await copyFile(from, path.join(auxiliaryDirectory, name)); }
        catch (error) { if (error.code !== "ENOENT" || name !== "pricing.json") throw error; }
      }
      const prepared = { ...canonical.prepared, stateDirectory, databaseFile: path.join(stateDirectory, "usage-index.sqlite"),
        pricingFile: path.join(auxiliaryDirectory, "pricing.json"), automaticPricingFile: path.join(auxiliaryDirectory, "pricing-auto.json"),
        importStoreFile: path.join(auxiliaryDirectory, "imports.json") };
      await writeFile(path.join(directory, "prepared.json"), JSON.stringify(prepared, null, 2));
      matrix.cells.push({ id: canonical.id, variant, rounds: 2, directory, prepared, prior, proofMode: canonical.proofMode });
    }
  }
  await writeFile(path.join(BASE, "matrix.json"), JSON.stringify(matrix, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ base: BASE, cells: matrix.cells.length, prepared: true }));
  return matrix;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepare();
