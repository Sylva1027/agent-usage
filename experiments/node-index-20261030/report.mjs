import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const directory = path.resolve("output/node-index-20261030");
const read = async file => JSON.parse(await fs.readFile(file, "utf8"));
function stats(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  assert(sorted.length > 0);
  const middle = Math.floor(sorted.length / 2);
  return {min: sorted[0], median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, max: sorted.at(-1)};
}
const output = {};
for (const temperature of ["warm", "cold"]) {
  const matrix = await read(path.join(directory, `matrix-${temperature}.json`));
  assert(matrix.comparisons.every(row => row.equal));
  const groups = {};
  for (const scenario of ["baseline", "combined"]) {
    const cases = matrix.results.filter(row => row.scenario === scenario);
    const runs = await Promise.all(cases.map(row => read(row.resultFile)));
    assert(runs.every(run => run.passed && run.memory.within512MiB && run.memory.openPids.length === 0));
    const response = (run, label) => run.responses.find(row => row.label === label);
    groups[scenario] = {
      runs: runs.length,
      peakWorkingSetMiB: stats(runs.map(run => run.memory.peakWorkingSetMiB)),
      peakPrivateMiB: stats(runs.map(run => run.memory.peakPrivateMiB)),
      firstResponseMs: stats(runs.map(run => response(run, "today").ms)),
      firstWorkingSetMiB: stats(runs.map(run => run.memory.byPhase.today.peakWorkingSetMiB)),
      allResponseMs: stats(runs.map(run => response(run, "all").ms)),
      allWorkingSetMiB: stats(runs.map(run => run.memory.byPhase.all.peakWorkingSetMiB)),
      samplingIntervalMs: runs.map(run => run.memory.sampleIntervalMs),
      unsampledStartedPids: runs.map(run => [...new Set(run.processEvents.filter(e => e.action === "start").map(e => e.pid))].filter(pid => !run.memory.sampledPids.includes(pid))),
    };
    if (temperature === "warm") {
      const hits = runs.flatMap(run => run.responses.filter(row => row.label.startsWith("no-new-hit-")));
      assert(hits.every(row => row.cache === "hit" && row.childStarts === 0));
      groups[scenario].noNewHitMs = stats(hits.map(row => row.ms));
      groups[scenario].noNewHitCount = hits.length;
      groups[scenario].noNewWorkingSetMiB = stats(runs.flatMap(run => Object.entries(run.memory.byPhase).filter(([label]) => label.startsWith("no-new-hit-")).map(([, value]) => value.peakWorkingSetMiB)));
      groups[scenario].restartHitMs = stats(runs.map(run => response(run, "restart-hit").ms));
    }
  }
  output[temperature] = {equal: true, groups};
}
const stages = (await fs.readFile(path.join(directory, "profile-stages.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
output.profile = [...new Set(stages.filter(row => row.stage === "syncRound.start").map(row => row.pid))].map(pid => {
  const main = stages.filter(row => row.pid === pid && (row.threadId ?? 0) === 0);
  const start = main.find(row => row.stage === "syncRound.start");
  return {
    pid,
    stages: main.filter(row => /^(sync\.|plan\.|syncRound\.)/.test(row.stage)).map(row => ({
      name: row.stage, ms: row.at - start.at, rssMiB: row.rss / 2 ** 20,
      heapUsedMiB: row.heapUsed / 2 ** 20, updatedFiles: row.updatedFileCount,
      stagedThreads: row.stagedThreads, retainedThreads: row.retainedThreads,
    })),
    largeMaterializations: main.filter(row => row.stage === "sql.all" && row.rows > 4000).map(row => ({sql: row.sql, rows: row.rows, ms: row.ms, heapDeltaMiB: row.heapDelta / 2 ** 20})),
  };
});
await fs.writeFile(path.join(directory, "comparison-summary.json"), JSON.stringify(output, null, 2));
console.log(JSON.stringify({warm: output.warm, cold: output.cold}, null, 2));
