import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { runCell } from "./q6-performance-run.mjs";

const base = path.resolve(process.env.Q7_REOPEN_ROOT || "output/architecture-20261105/q7/reopen-a");
const read = async (file) => JSON.parse(await readFile(file, "utf8"));
async function prepare() {
  const receipt = await read(path.join(base, "baseline-receipt.json"));
  const previous = await read(receipt.originalMatrix);
  const matrix = { ...receipt, generation: "q7", cells: [], hookModule: path.resolve("experiments/architecture-20261101/q7-reopen-hook.mjs"), appendTimeMs: Date.now() - 60000 };
  for (const proofMode of ["native", "sha"]) {
    const template = previous.cells.find((cell) => cell.id === `10x-${proofMode}` && cell.variant === "candidate");
    const prior = {};
    for (const [kind, selected] of Object.entries(template.prepared.selected)) {
      const file = path.join(base, "prior-inputs", proofMode, kind);
      await mkdir(path.dirname(file), { recursive: true });
      const info = await stat(selected.targetPath); assert.equal(info.nlink, 1);
      await copyFile(selected.targetPath, file);
      prior[kind] = { file, path: selected.targetPath, size: info.size, mtimeMs: info.mtimeMs };
    }
    for (const [phase, variants] of [["diagnostic", ["q6"]], ["formal", ["q5", "q6", "candidate"]]]) {
      for (const variant of variants) {
        const directory = path.join(base, phase, proofMode, variant), stateDirectory = path.join(directory, "state");
        const auxiliary = proofMode === "native" ? path.join(os.tmpdir(), "codex-q7-reopen-a", phase, variant) : stateDirectory;
        await mkdir(stateDirectory, { recursive: true }); await mkdir(auxiliary, { recursive: true });
        const prepared = { ...template.prepared, stateDirectory, databaseFile: path.join(stateDirectory, "usage-index.sqlite"),
          importStoreFile: path.join(auxiliary, "imports.json"), pricingFile: path.join(auxiliary, "pricing.json"),
          automaticPricingFile: path.join(auxiliary, "pricing-auto.json") };
        await copyFile(template.prepared.automaticPricingFile, prepared.automaticPricingFile);
        try { await copyFile(template.prepared.pricingFile, prepared.pricingFile); } catch (error) { if (error.code !== "ENOENT") throw error; }
        matrix.cells.push({ id: `10x-${proofMode}`, proofMode, phase, variant, directory, prepared, prior,
          diagnostic: phase === "diagnostic", reopenCard: true, fixtureVariant: variant === "q5" ? "baseline" : "candidate",
          rounds: variant === "candidate" ? 2 : 0 });
      }
    }
  }
  await writeFile(path.join(base, "matrix.json"), JSON.stringify(matrix, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ prepared: true, cells: matrix.cells.length }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "prepare") await prepare();
  else {
    const matrix = await read(path.join(base, "matrix.json"));
    const cell = matrix.cells.find((row) => row.phase === process.argv[2] && row.proofMode === process.argv[3] && row.variant === process.argv[4]);
    assert.ok(cell, "Specify phase, proof mode, and variant");
    await runCell(cell, matrix);
  }
}
