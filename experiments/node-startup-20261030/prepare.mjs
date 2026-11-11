import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const previous = JSON.parse(fs.readFileSync("output/node-index-20261030/experiment.json", "utf8"));
const work = path.resolve(".codex-usage/node-startup-20261030");
const evidence = path.resolve("output/node-startup-20261030");
assert(!fs.existsSync(work), "Startup experiment already exists");
fs.mkdirSync(evidence, {recursive: true});
const roots = Object.fromEntries(["baseline", "profile", "content", "history", "summary", "candidate"].map(name => [name, path.join(work, name)]));
for (const root of Object.values(roots)) fs.cpSync(previous.combinedRoot, root, {recursive: true});
const config = {
  ...previous, work, evidence,
  baselineRoot: roots.baseline, profileRoot: roots.profile, candidateRoot: roots.candidate,
  contentRoot: roots.content, historyRoot: roots.history, summaryRoot: roots.summary,
  combinedRoot: roots.candidate,
  stageFile: path.join(evidence, "profile-stages.jsonl"),
  originalHookFile: path.resolve("experiments/node-startup-20261030/profile-hook.mjs"),
  files: previous.files.map(row => ({file: row.file, hash: createHash("sha256").update(fs.readFileSync(path.join(roots.baseline, "src", row.file))).digest("hex")})),
};
fs.writeFileSync(path.join(evidence, "experiment.json"), JSON.stringify(config, null, 2));
console.log(JSON.stringify({work, evidence, roots}));
