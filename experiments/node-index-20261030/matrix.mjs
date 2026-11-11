import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {runCase} from "./measure.mjs";
import {verifyResults} from "../rust-integration-20261030/verify.mjs";

const temperature = process.argv[2];
assert(["warm", "cold"].includes(temperature), "Usage: node matrix.mjs warm|cold");
const directory = path.resolve("output/node-index-20261030");
const results = [];
const comparisons = [];
const orders = temperature === "warm"
  ? [["baseline", "combined"], ["combined", "baseline"], ["baseline", "combined"]]
  : [["baseline", "combined"]];
for (const [round, order] of orders.entries()) {
  const pair = {};
  for (const scenario of order) {
    const result = await runCase({
      scenario, temperature, name: `matrix-${temperature}-${round + 1}-${scenario}`,
    });
    results.push({scenario, round: round + 1, resultFile: result.resultFile, passed: result.passed});
    assert(result.passed, `${scenario} failed: ${result.resultFile}`);
    pair[scenario] = result.resultFile;
  }
  const comparison = await verifyResults(pair.baseline, pair.combined);
  const reportFile = path.join(directory, `matrix-${temperature}-${round + 1}-verify.json`);
  await fs.writeFile(reportFile, JSON.stringify(comparison, null, 2));
  comparisons.push({round: round + 1, equal: comparison.equal, reportFile});
  assert(comparison.equal, `Business output changed: ${reportFile}`);
}
const report = {temperature, results, comparisons};
await fs.writeFile(path.join(directory, `matrix-${temperature}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
