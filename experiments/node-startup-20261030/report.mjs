import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const directory = path.resolve("output/node-startup-20261030");
const json = async file => JSON.parse(await fs.readFile(file, "utf8"));
const jsonl = async file => (await fs.readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
function stats(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  assert(sorted.length > 0);
  const middle = Math.floor(sorted.length / 2);
  return {min: sorted[0], median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, max: sorted.at(-1)};
}
const output = {};
for (const operation of ["warm", "cold"]) {
  const matrix = await json(path.join(directory, `matrix-${operation}.json`));
  assert(matrix.comparisons.every(item => item.equal));
  const groups = {};
  for (const variant of ["baseline", "candidate"]) {
    const runs = await Promise.all(matrix.results.filter(item => item.variant === variant).map(item => json(item.resultFile)));
    assert(runs.every(run => run.passed && run.memory.within512MiB && run.memory.openPids.length === 0));
    const response = (run, label) => run.responses.find(item => item.label === label);
    const group = {
      runs: runs.length,
      peakWorkingSetMiB: stats(runs.map(run => run.memory.peakWorkingSetMiB)),
      peakPrivateMiB: stats(runs.map(run => run.memory.peakPrivateMiB)),
      firstResponseMs: stats(runs.map(run => response(run, "today").ms)),
      firstWorkingSetMiB: stats(runs.map(run => run.memory.byPhase.today.peakWorkingSetMiB)),
      firstCalculatorStarts: runs.map(run => response(run, "today").childStarts),
      allResponseMs: stats(runs.map(run => response(run, "all").ms)),
      allWorkingSetMiB: stats(runs.map(run => run.memory.byPhase.all.peakWorkingSetMiB)),
      sampleIntervalsMs: runs.map(run => run.memory.sampleIntervalMs),
      unsampledStartedPids: runs.map(run => [...new Set(run.processEvents.filter(e => e.action === "start").map(e => e.pid))].filter(pid => !run.memory.sampledPids.includes(pid))),
    };
    if (operation === "warm") {
      const hits = runs.flatMap(run => run.responses.filter(item => item.label.startsWith("no-new-hit-")));
      assert(hits.every(item => item.cache === "hit" && item.childStarts === 0));
      group.noNewHitMs = stats(hits.map(item => item.ms));
      group.noNewHitCount = hits.length;
      group.restartHitMs = stats(runs.map(run => response(run, "restart-hit").ms));
    }
    if (matrix.results.some(item => item.variant === variant && item.referenceOnly)) group.referenceOnly = true;
    groups[variant] = group;
  }
  output[operation] = {equal: true, pairedLatency: matrix.pairedLatency ?? true, groups};
}
const stages = await jsonl(path.join(directory, "profile-stages.jsonl"));
output.profiles = {};
for (const name of ["startup-profile-baseline-profile-warm", "profile-candidate"]) {
  const run = await json(path.join(directory, `${name}-result.json`));
  const pids = new Set(run.responses[0].childStartPids);
  const samples = await jsonl(run.memoryFile);
  const today = samples.filter(row => row.phase === "today");
  const end = samples.find(row => row.at > today[0].at && row.phase !== "today")?.at ?? today.at(-1).at;
  const selected = stages.filter(row => pids.has(row.pid) && row.at <= end && (row.threadId ?? 0) === 0);
  const durations = {};
  const starts = new Map();
  for (const row of selected) {
    const match = /^(.*)\.(start|done)$/.exec(row.stage);
    if (!match) continue;
    const [, method, state] = match;
    const key = `${row.pid}:${method}`;
    if (state === "start") starts.set(key, row);
    else if (starts.has(key)) {
      const start = starts.get(key);
      (durations[method] ||= []).push(row.at - start.at);
      starts.delete(key);
    }
  }
  const point = name => selected.find(row => row.stage === name);
  const interval = (from, to) => {
    const start = point(from), end = point(to);
    assert(start && end && end.at >= start.at, `Invalid profile interval: ${from} -> ${to}`);
    return end.at - start.at;
  };
  const prefixStart = point("plan.prefix.start"), prefixDone = point("plan.prefix.done");
  const delta = Object.fromEntries(Object.keys(prefixStart.io).map(key => [key, prefixDone.io[key] - prefixStart.io[key]]));
  output.profiles[name] = {
    firstResponseMs: run.responses[0].ms, firstCalculatorPids: [...pids],
    durationsMs: durations, prefixIO: delta,
    intervalsMs: {
      discovery: interval("sync.discover.start", "sync.discover.done"),
      usageFilesAndFingerprints: interval("sync.discover.done", "sync.fingerprint.done"),
      completePrefix: interval("plan.prefix.start", "plan.prefix.done"),
      ownershipProof: interval("plan.prefix.done", "plan.proof.done"),
      afterProbe: interval("plan.proof.done", "plan.afterProbe.done"),
    },
    buildReasons: selected.filter(row => row.stage === "history.build.reason").map(({reason, oldCount, currentCount}) => ({reason, oldCount, currentCount})),
    stagedThreads: point("syncRound.done")?.stagedThreads,
    retainedThreads: point("syncRound.done")?.retainedThreads,
  };
}
await fs.writeFile(path.join(directory, "comparison-summary.json"), JSON.stringify(output, null, 2));
console.log(JSON.stringify({warm: output.warm, cold: output.cold}, null, 2));
