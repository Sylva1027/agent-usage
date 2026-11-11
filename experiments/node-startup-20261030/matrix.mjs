import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {runVariant} from "./run.mjs";
import {verifyResults} from "../rust-integration-20261030/verify.mjs";

const operation = process.argv[2];
assert(["warm", "cold"].includes(operation), "Usage: matrix.mjs warm|cold");
const directory = path.resolve("output/node-startup-20261030");
const orders = operation === "warm"
  ? [["baseline", "candidate"], ["candidate", "baseline"], ["baseline", "candidate"]]
  : [["baseline", "candidate"]];
const results = [];
const comparisons = [];
for (const [round, variants] of orders.entries()) {
  const pair = {};
  for (const variant of variants) {
    const result = await runVariant(variant, operation, `matrix-final-${operation}-${round + 1}-${variant}`);
    results.push({variant, round: round + 1, resultFile: result.resultFile, passed: result.passed});
    assert(result.passed, `Run failed: ${result.resultFile}`);
    pair[variant] = result.resultFile;
  }
  const verification = await verifyResults(pair.baseline, pair.candidate);
  const output = path.join(directory, `matrix-${operation}-${round + 1}-verify.json`);
  await fs.writeFile(output, JSON.stringify(verification, null, 2));
  comparisons.push({round: round + 1, equal: verification.equal, output});
  assert(verification.equal, `Business output changed: ${output}`);
}
const report = {operation, results, comparisons};
await fs.writeFile(path.join(directory, `matrix-${operation}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
