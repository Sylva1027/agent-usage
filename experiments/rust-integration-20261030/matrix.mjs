import fs from "node:fs";
import path from "node:path";
import { runBenchmark } from "./benchmark.mjs";
import { verifyResults } from "./verify.mjs";

const exp = JSON.parse(fs.readFileSync("output/rust-integration-20261030/experiment.json", "utf8"));
const rustPerfBin = path.join(exp.work, "perf-target/release/native-perf.exe");
const rustDshBin = path.join(exp.work, "rust-target/release/dsh-rust-helper.exe");
const variants = [
  { source: "baseline", label: "baseline" },
  { source: "compact", label: "compact" },
  { source: "candidate", label: "rust", rustPerfBin, rustDshBin },
];
const results = [];
for (let round = 0; round < 3; round += 1) {
  for (let offset = 0; offset < variants.length; offset += 1) {
    const variant = variants[(round + offset) % variants.length];
    const result = await runBenchmark({ ...variant, operation: "warm", name: `${variant.label}-warm-${round + 1}` });
    results.push({ ...result, variant: variant.label, round: round + 1 });
  }
}
const comparisons = [];
for (let round = 1; round <= 3; round += 1) {
  const baseline = results.find(result => result.round === round && result.variant === "baseline");
  for (const variant of ["compact", "rust"]) {
    const candidate = results.find(result => result.round === round && result.variant === variant);
    const comparison = await verifyResults(baseline.resultFile, candidate.resultFile);
    comparisons.push({ round, variant, ...comparison });
  }
}
fs.writeFileSync(path.join(exp.evidence, "warm-matrix.json"), JSON.stringify({
  passed: results.every(result => result.passed) && comparisons.every(comparison => comparison.equal),
  runs: results.map(({ runId, variant, round, passed, memory, responses, resultFile }) => ({ runId, variant, round, passed, memory, responses, resultFile })),
  comparisons,
}, null, 2));
if (results.some(result => !result.passed) || comparisons.some(comparison => !comparison.equal)) process.exitCode = 1;
