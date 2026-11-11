import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {runVariant} from "./run.mjs";
import {verifyResults} from "../rust-integration-20261030/verify.mjs";

const config = JSON.parse(await fs.readFile("output/node-startup-20261030/experiment.json", "utf8"));
const referenceFile = path.resolve("output/node-index-20261030/matrix-cold-1-combined-result.json");
const reference = JSON.parse(await fs.readFile(referenceFile, "utf8"));
assert(reference.passed && reference.operation === "cold" && reference.seed === null);
assert.equal(reference.fixedNow, config.fixedNow);
assert.equal(reference.manifest.sha256, createHash("sha256").update(await fs.readFile(config.manifestPath)).digest("hex"));
for (const [relative, expected] of Object.entries(reference.sourceHashes)) {
  assert.equal(createHash("sha256").update(await fs.readFile(path.join(config.baselineRoot, relative))).digest("hex"),
    expected, `Cold reference source changed: ${relative}`);
}
const candidate = await runVariant("candidate", "cold", "matrix-final-cold-1-candidate");
assert(candidate.passed, candidate.resultFile);
const verification = await verifyResults(referenceFile, candidate.resultFile);
const output = path.join(config.evidence, "matrix-cold-1-verify.json");
await fs.writeFile(output, JSON.stringify(verification, null, 2));
assert(verification.equal, "Cold business output changed");
const report = {
  operation: "cold", pairedLatency: false,
  reference: {reused: true, sourceHashesChecked: Object.keys(reference.sourceHashes).length, sameManifest: true},
  results: [
    {variant: "baseline", round: 1, resultFile: referenceFile, passed: true, referenceOnly: true},
    {variant: "candidate", round: 1, resultFile: candidate.resultFile, passed: candidate.passed},
  ],
  comparisons: [{round: 1, equal: verification.equal, output}],
};
await fs.writeFile(path.join(config.evidence, "matrix-cold.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
