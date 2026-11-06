import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BASE, KINDS, read, verifyRuntime } from "./remaining-harness-delivery-prepare.mjs";

export const regressed = (before, after) => after > before * 1.1 && after - before > 100;
const median = (values) => [...values].sort((a, b) => a - b).reduce((sum, value, index, sorted) =>
  sum + ((index === Math.floor((sorted.length - 1) / 2) || index === Math.floor(sorted.length / 2)) ? value / (sorted.length % 2 ? 1 : 2) : 0), 0);
const pct = (current, previous) => previous ? Math.round((current - previous) / previous * 10000) / 100 : null;

export function business(body, referenceMs) {
  const value = structuredClone(body), summary = value.summary, comparison = summary.comparison;
  assert.equal(value.quota.asOf, summary.quota.asOf);
  if (comparison.previousRange) {
    const duration = Date.parse(comparison.previousRange.end) - Date.parse(comparison.previousRange.start) + 1;
    const average = (now) => Math.round(comparison.previousTotals.total * Math.max(0,
      Math.min(Date.parse(summary.range.end), Math.max(Date.parse(summary.range.start), now)) - Date.parse(summary.range.start) + 1) / duration);
    // Validate live values exactly before aligning only the three elapsed-time trend fields.
    assert.equal(comparison.averageBaselineTotal, average(Date.parse(summary.quota.asOf)));
    assert.equal(comparison.averageDelta, summary.totals.total - comparison.averageBaselineTotal);
    assert.equal(comparison.averagePercentChange, pct(summary.totals.total, comparison.averageBaselineTotal));
    comparison.averageBaselineTotal = average(referenceMs);
    comparison.averageDelta = summary.totals.total - comparison.averageBaselineTotal;
    comparison.averagePercentChange = pct(summary.totals.total, comparison.averageBaselineTotal);
  }
  for (const key of ["fingerprint", "checkedAt", "snapshotId"]) delete value[key];
  delete summary.generatedAt; delete value.metadata.generatedAt; delete value.metadata.modelUsageAsOf;
  for (const timed of [value.quota, summary.quota, value.periodComparison]) delete timed.asOf;
  return value;
}

function numericCount(value) {
  if (typeof value === "number") return 1;
  if (!value || typeof value !== "object") return 0;
  return Object.values(value).reduce((sum, child) => sum + numericCount(child), 0);
}

async function nodeRows(directory) {
  const names = (await readdir(path.join(directory, "nodes"))).filter((name) => name.endsWith(".jsonl"));
  return (await Promise.all(names.map(async (name) => (await readFile(path.join(directory, "nodes", name), "utf8"))
    .trim().split("\n").filter(Boolean).map(JSON.parse)))).flat();
}

export async function resources(directory) {
  const nodes = await nodeRows(directory);
  const ids = new Set(nodes.map((node) => node.pid));
  const events = [];
  for (const node of nodes) {
    assert.equal(node.code, 0, "node process did not close cleanly"); assert.ok(node.usage.maxRSS > 0);
    const oldSpace = node.execArgv.filter((value) => value.startsWith("--max-old-space-size=")).at(-1);
    assert.equal(oldSpace, `--max-old-space-size=${node.role === "executor" ? 224 : 512}`);
    if (node.role === "executor") assert.ok(node.execArgv.includes("--max-semi-space-size=4"));
    events.push({ at: node.startedAtMs, bytes: node.usage.maxRSS * 1024 });
    events.push({ at: node.endedAtMs, bytes: -node.usage.maxRSS * 1024 });
  }
  events.sort((a, b) => a.at - b.at || b.bytes - a.bytes);
  let active = 0, nodeUpper = 0;
  for (const event of events) { active += event.bytes; nodeUpper = Math.max(nodeUpper, active); }
  let sampledPeak = 0, browserPeak = 0, otherPeak = 0, readBytes = 0, writeBytes = 0, walPeak = 0, statePeak = 0;
  const ioProcesses = new Map();
  for (const phase of ["initial", "reopen"]) {
    const resourceDirectory = path.join(directory, `resources-${phase}`), report = await read(path.join(resourceDirectory, "resources.json"));
    assert.equal(report.stopReason, "stop-file"); assert.ok(report.sampleCount >= 2);
    sampledPeak = Math.max(sampledPeak, report.service.peakSampledWorkingSetBytes);
    browserPeak = Math.max(browserPeak, report.browser.peakSampledWorkingSetBytes);
    walPeak = Math.max(walPeak, report.state.peakCategoryBytes?.wal || 0); statePeak = Math.max(statePeak, report.state.peakTotalBytes || 0);
    for (const line of (await readFile(path.join(resourceDirectory, "resources.ndjson"), "utf8")).trim().split("\n")) {
      const sample = JSON.parse(line); let other = 0;
      for (const process of sample.processes.filter((process) => process.role === "service")) {
        if (/^node(?:\.exe)?$/i.test(process.name)) assert.ok(ids.has(process.pid), "observed Node lacks exit high-water telemetry");
        else other += process.reportedPeakWorkingSetBytes;
        if (process.ioAvailable) {
          const key = `${process.pid}|${process.startTimeUtc}`;
          const previous = ioProcesses.get(key) || { pid: process.pid, read: 0, write: 0 };
          previous.read = Math.max(previous.read, process.logicalReadBytes);
          previous.write = Math.max(previous.write, process.logicalWriteBytes);
          ioProcesses.set(key, previous);
        }
      }
      otherPeak = Math.max(otherPeak, other);
    }
  }
  const upper = Math.max(sampledPeak, nodeUpper + otherPeak);
  const ioRows = [...ioProcesses.values()];
  readBytes = ioRows.reduce((sum, row) => sum + row.read, 0);
  writeBytes = ioRows.reduce((sum, row) => sum + row.write, 0);
  return { sampledTreePeakMiB: sampledPeak / 1048576, observedPeakUpperMiB: upper / 1048576,
    nodeConcurrencyUpperMiB: nodeUpper / 1048576, otherObservedPeakMiB: otherPeak / 1048576,
    browserSampledPeakMiB: browserPeak / 1048576, cpuSeconds: nodes.reduce((sum, node) => sum + (node.usage.userCPUTime + node.usage.systemCPUTime) / 1000000, 0),
    logicalReadMiB: readBytes / 1048576, logicalWriteMiB: writeBytes / 1048576,
    ioScope: "Sum of per-process observed cumulative high-water counters; a lower bound, not physical disk traffic.",
    nodeProcessesMissingIo: nodes.filter((node) => !ioRows.some((row) => row.pid === node.pid)).length,
    walPeakMiB: walPeak / 1048576, statePeakMiB: statePeak / 1048576, nodeProcesses: nodes.length, budgetPassed: upper <= 512 * 1048576 };
}

export async function analyze() {
  const matrix = await read(path.join(BASE, "matrix.json"));
  for (const version of Object.values(matrix.versions)) await verifyRuntime(version);
  const rows = [], triggers = [];
  let numericChecks = 0, responses = 0, changes = 0;
  for (const kind of KINDS) {
    const pair = {};
    for (const variant of ["baseline", "candidate"]) {
      const directory = path.join(BASE, "formal", `${kind}-${variant}`), result = await read(path.join(directory, "result.json"));
      if (matrix.opencodeRegression) assert.equal(result.runtimeCommit,
        matrix.versions[variant === "baseline" ? matrix.baselines[kind] : variant].commit, "wrong per-source control version");
      assert.equal(result.passed, true); assert.deepEqual(result.errors, []); assert.equal(result.changes.length, 3);
      const fingerprints = [];
      for (const change of result.changes) {
        const receipts = result.deliveryInitial.rows.filter((row) => row.kind === "page-receipt" && row.event === "usage-synced"
          && row.clock >= change.landedAtMs && row.clock <= change.endedAtMs);
        assert.ok(receipts.length, "no post-commit source notification"); fingerprints.push(receipts.at(-1).fingerprint);
        assert.ok(change.actualPaintMs >= 0); changes++;
      }
      assert.equal(new Set(fingerprints).size, 3, "changed source version was reused");
      pair[variant] = { result, directory, resources: await resources(directory) };
    }
    const referenceMs = (await read(path.join(BASE, `plan-${kind}.json`))).appendTimeMs;
    for (const stage of ["initial", "append-1", "append-2", "revision", "scope-today", "scope-week", "scope-all", "reopen"]) {
      const baseline = await read(path.join(pair.baseline.directory, `${stage}.json`));
      const candidate = await read(path.join(pair.candidate.directory, `${stage}.json`));
      const left = business(baseline, referenceMs), right = business(candidate, referenceMs);
      assert.deepEqual(right, left, `${kind}/${stage} business mismatch`);
      if (stage === "initial" || stage.startsWith("append") || stage === "revision" || stage === "reopen") {
        for (const body of [baseline, candidate]) {
          assert.equal(body.summary.eventCount, body.metadata.eventCount);
          assert.equal(body.summary.sessionCount, body.metadata.sessionCount);
          assert.equal(body.summary.totals.total, body.periodComparison.totals.all.total);
        }
      }
      responses++; numericChecks += numericCount(left);
    }
    const latency = {};
    for (const name of ["append-1", "append-2", "revision", "reopen", "today", "week", "all"]) {
      const metric = (variant) => name === "reopen" ? pair[variant].result.reopen.wallMs
        : ["today", "week", "all"].includes(name) ? pair[variant].result.scopes.find((scope) => scope.preset === name).wallMs
        : pair[variant].result.changes.find((change) => change.label === name).actualPaintMs;
      const before = metric("baseline"), after = metric("candidate");
      latency[name] = { baselineMs: before, candidateMs: after, deltaMs: after - before, ratio: after / before, trigger: regressed(before, after) };
      if (latency[name].trigger) triggers.push({ kind, name, ...latency[name] });
    }
    const appendMedian = Object.fromEntries(["baseline", "candidate"].map((variant) => [variant, median(pair[variant].result.changes.slice(0, 2).map((change) => change.actualPaintMs))]));
    rows.push({ kind, baselineCommit: pair.baseline.result.runtimeCommit || matrix.versions.baseline.commit,
      appendMedian, latency, resources: { baseline: pair.baseline.resources, candidate: pair.candidate.resources } });
  }
  const analysis = { rows, triggers, pairedResponses: responses, numericChecks, observedChanges: changes,
    resourcePassed: rows.every((row) => row.resources.candidate.budgetPassed), planned: matrix.planned,
    clockAlignment: "Each live trend validated at its own quota.asOf; three elapsed-time trend fields recalculated at paired reference time. No other numeric tolerance." };
  await writeFile(path.join(BASE, "analysis.json"), `${JSON.stringify(analysis, null, 2)}\n`);
  console.log(JSON.stringify(analysis, null, 2)); return analysis;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await analyze();
