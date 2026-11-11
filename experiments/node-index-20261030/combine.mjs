import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const config = JSON.parse(fs.readFileSync("output/node-index-20261030/experiment.json", "utf8"));
const root = path.resolve(config.work);
for (const directory of [config.candidateRoot, config.compactRoot, config.combinedRoot]) {
  assert(path.resolve(directory).startsWith(root + path.sep), "Clone escaped experiment root");
}
fs.cpSync(config.candidateRoot, config.combinedRoot, {recursive: true});
for (const relative of ["src/dsh-usage.js", "src/perf-sources/dsh.js"]) {
  fs.copyFileSync(path.join(config.compactRoot, relative), path.join(config.combinedRoot, relative));
}
console.log(JSON.stringify(Object.fromEntries(
  ["src/usage-core.js", "src/usage-store.js", "src/dsh-usage.js", "src/perf-sources/dsh.js"].map(relative => [
    relative, createHash("sha256").update(fs.readFileSync(path.join(config.combinedRoot, relative))).digest("hex"),
  ]),
), null, 2));
