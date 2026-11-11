import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {transformHistory} from "./history-build.mjs";
import {transformSource as transformSummary} from "./summary-build.mjs";
import {rebuildContentSource} from "./content-build.mjs";

const config = JSON.parse(fs.readFileSync("output/node-startup-20261030/experiment.json", "utf8"));
assert(path.resolve(config.candidateRoot).startsWith(path.resolve(config.work) + path.sep));
fs.cpSync(config.baselineRoot, config.candidateRoot, {recursive: true});
const store = fs.readFileSync(path.join(config.baselineRoot, "src/usage-store.js"), "utf8");
assert.equal(transformHistory(transformSummary(store)), transformSummary(transformHistory(store)), "Shared-file transforms must commute");
fs.writeFileSync(path.join(config.candidateRoot, "src/usage-store.js"), transformSummary(transformHistory(store)));
fs.writeFileSync(path.join(config.candidateRoot, "src/usage-core.js"), rebuildContentSource(fs.readFileSync(path.join(config.baselineRoot, "src/usage-core.js"), "utf8")));
console.log(JSON.stringify(Object.fromEntries(["usage-core.js", "usage-store.js"].map(file => [file,
  createHash("sha256").update(fs.readFileSync(path.join(config.candidateRoot, "src", file))).digest("hex")]))));
