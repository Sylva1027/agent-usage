import fs from "node:fs";
import path from "node:path";
import { runBenchmark, compareComparable } from "./benchmark.mjs";

const exp = JSON.parse(fs.readFileSync("output/rust-integration-20261030/experiment.json", "utf8"));
const rustPerfBin = path.join(exp.work, "perf-target/release/native-perf.exe");
const rustDshBin = path.join(exp.work, "rust-target/release/dsh-rust-helper.exe");
const results = [];
results.push(await runBenchmark({ source: "baseline", operation: "cold", name: "baseline-cold" }));
results.push(await runBenchmark({ source: "compact", operation: "cold", name: "compact-cold" }));
results.push(await runBenchmark({ source: "candidate", rustDshBin, operation: "cold", name: "dsh-cold" }));
results.push(await runBenchmark({ source: "candidate", rustPerfBin, rustDshBin, operation: "cold", name: "rust-cold" }));
const byName = Object.fromEntries(results.map(result => [result.runId, result]));
const comparisons = [];
const originalToday = JSON.parse(fs.readFileSync(byName["baseline-cold"].responses.find(row => row.label === "today").payloadFile));
const compactToday = JSON.parse(fs.readFileSync(byName["compact-cold"].responses.find(row => row.label === "today").payloadFile));
comparisons.push({ name: "original-cold", label: "today", ...compareComparable(originalToday, compactToday) });
for (const name of ["dsh-cold", "rust-cold"]) {
  for (const label of ["today", "today-hit", "all"]) {
    const left = byName["compact-cold"].responses.find(row => row.label === label);
    const right = byName[name].responses.find(row => row.label === label);
    if (left?.status !== 200 || right?.status !== 200) continue;
    comparisons.push({ name, label, ...compareComparable(JSON.parse(fs.readFileSync(left.payloadFile)), JSON.parse(fs.readFileSync(right.payloadFile))) });
  }
}
fs.writeFileSync(path.join(exp.evidence, "cold-matrix.json"), JSON.stringify({
  results: results.map(({ runId, passed, error, responses, memory, resultFile }) => ({ runId, passed, error, responses, memory, resultFile })),
  comparisons,
}, null, 2));
// The unmodified baseline is expected to retain its documented failure; do not hide it.
process.exitCode = comparisons.some(row => !row.equal) || !byName["rust-cold"].passed || !byName["compact-cold"].passed ? 1 : 0;
