import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const previous = JSON.parse(fs.readFileSync("output/rust-integration-20261030/experiment.json", "utf8"));
const work = path.resolve(".codex-usage/node-index-20261030");
const evidence = path.resolve("output/node-index-20261030");
assert(!fs.existsSync(work), "Experiment already prepared");
fs.mkdirSync(evidence, { recursive: true });
const roots = Object.fromEntries(["baseline", "profile", "candidate", "dsh", "combined"].map(name => [name, path.join(work, name)]));
for (const root of Object.values(roots)) fs.cpSync(previous.compactRoot, root, { recursive: true });
const files = previous.files.map(row => ({
  file: row.file,
  hash: createHash("sha256").update(fs.readFileSync(path.join(roots.baseline, "src", row.file))).digest("hex"),
}));
const experiment = {
  ...previous, work, evidence, files,
  probes: path.resolve("experiments/node-index-20261030"),
  baselineRoot: roots.baseline, profileRoot: roots.profile, candidateRoot: roots.candidate,
  compactRoot: roots.dsh, combinedRoot: roots.combined,
  nodeCompactBaseline: previous.compactRoot,
  stageFile: path.join(evidence, "profile-stages.jsonl"),
  originalHookFile: path.resolve("experiments/node-index-20261030/index-hook.mjs"),
  createdAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(evidence, "experiment.json"), JSON.stringify(experiment, null, 2));
console.log(JSON.stringify({ work, evidence, roots }));
