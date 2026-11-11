import fs from "node:fs";
import path from "node:path";
const directory = path.resolve("output/rust-integration-20261030");
const read = file => JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
const stats = values => {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return { min: values[0], median: values[Math.floor(values.length / 2)], max: values.at(-1) };
};
const result = {};
for (const variant of ["baseline", "compact", "rust"]) {
  const runs = [1, 2, 3].map(round => read(`${variant}-warm-${round}-result.json`));
  result[variant] = {
    passed: runs.every(run => run.passed),
    peakWorkingSetMiB: stats(runs.map(run => run.memory.peakWorkingSetMiB)),
    peakPrivateMiB: stats(runs.map(run => run.memory.peakPrivateMiB)),
    queries: Object.fromEntries(["today", "month", "all", "7d", "today-hit", "restart-hit"].map(label => [label, {
      ms: stats(runs.map(run => run.responses.find(row => row.label === label).ms)),
      peakWorkingSetMiB: stats(runs.flatMap(run => run.memory.byPhase[label] ? [run.memory.byPhase[label].peakWorkingSetMiB] : [])),
    }])),
    noNewChildStarts: runs.flatMap(run => run.responses.filter(row => row.label.startsWith("no-new-hit"))).map(row => row.childStarts),
    trackedByKind: runs.map(run => run.memory.trackedByKind),
  };
}
const natural = fs.readFileSync(path.join(directory, "profile-1-stages.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
const allPid = natural.find(row => row.stage === "perf.selection.done" && row.eligible > 70000)?.pid;
result.profile = natural.filter(row => row.pid === allPid && !row.stage.includes("row")).map(row => ({ ...row, rssMiB: row.rss / 2 ** 20, heapUsedMiB: row.heapUsed / 2 ** 20 }));
result.parity = read("warm-matrix.json").passed;
fs.writeFileSync(path.join(directory, "comparison-summary.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
