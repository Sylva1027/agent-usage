import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

function creationTime(value) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?Z$/.exec(value || "");
  return match ? BigInt(Date.parse(`${match[1]}Z`)) * 10000n + BigInt((match[2] || "").padEnd(7, "0")) : null;
}

function measure(rows) {
  const sum = (key, eligible = () => true) => rows.filter(eligible).reduce((total, row) => total + (row[key] || 0), 0);
  const count = predicate => rows.filter(predicate).length;
  const memory = row => row.workingSetBytes != null;
  const result = { processCount: rows.length, memoryAvailableProcessCount: count(memory),
    workingSetBytes: sum("workingSetBytes", memory), privateBytes: sum("privateBytes", memory),
    reportedPeakWorkingSetBytes: sum("reportedPeakWorkingSetBytes", memory),
    cpuAvailableProcessCount: count(row => row.cpuAvailable), cpuSeconds: sum("cpuSeconds", row => row.cpuAvailable),
    ioAvailableProcessCount: count(row => row.ioAvailable),
    logicalReadBytes: sum("logicalReadBytes", row => row.ioAvailable),
    logicalWriteBytes: sum("logicalWriteBytes", row => row.ioAvailable) };
  for (const [key, counter] of [["cpuSecondsIncrement", "cpuIncrementObservedProcessCount"],
    ["logicalReadBytesIncrement", "readIncrementObservedProcessCount"], ["logicalWriteBytesIncrement", "writeIncrementObservedProcessCount"]]) {
    result[counter] = count(row => row[key] != null);
    result[key] = result[counter] ? sum(key) : null;
  }
  return result;
}

// Windows retains the original parent PID even after that PID has been reused.
export function correctResourceIdentity(sample) {
  const processes = sample.processes, byPid = new Map(processes.map(row => [row.pid, row]));
  const runners = processes.filter(row => row.role === "runner").map(row => creationTime(row.startTimeUtc)).filter(value => value !== null);
  const runnerTime = runners.length ? runners.reduce((a, b) => a < b ? a : b) : null;
  const excluded = new Map();
  for (const row of processes) {
    if (!["service", "browser"].includes(row.role)) continue;
    const parent = byPid.get(row.parentPid);
    const childTime = creationTime(row.startTimeUtc);
    // An older task-owned orphan may outlive a parent; only pre-runner outsiders are excluded.
    if (childTime !== null && runnerTime !== null && childTime < runnerTime) {
      excluded.set(row.pid, { pid: row.pid, name: row.name, startTimeUtc: row.startTimeUtc,
        parentPid: row.parentPid, parentStartTimeUtc: parent?.startTimeUtc ?? null, reason: "process predates experiment runner" });
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of processes) if (["service", "browser"].includes(row.role) && !excluded.has(row.pid) && excluded.has(row.parentPid)) {
      excluded.set(row.pid, { pid: row.pid, name: row.name, startTimeUtc: row.startTimeUtc,
        parentPid: row.parentPid, reason: "descendant of excluded PID generation" });
      changed = true;
    }
  }
  if (!excluded.size) return { sample, excluded: [] };
  const kept = processes.filter(row => !excluded.has(row.pid));
  return { sample: { ...sample, processes: kept,
    service: measure(kept.filter(row => row.role === "service")), browser: measure(kept.filter(row => row.role === "browser")) },
    excluded: [...excluded.values()] };
}

async function resourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await resourceFiles(target));
    else if (entry.name === "resources.ndjson") files.push(target);
  }
  return files.sort();
}

export function parseResourceSample(line) {
  return JSON.parse(line, (key, value, context) => key === "startTimeUtcTicks" && typeof value === "number" ? context.source : value);
}

export async function deriveResources(root, scopes = ["datasets", "diagnostic/datasets", "retained-year-first"]) {
  root = path.resolve(root);
  const files = [], excludedIdentities = new Map();
  for (const scope of scopes) {
    for (const source of await resourceFiles(path.join(root, scope))) {
      const input = await readFile(source), rows = input.toString("utf8").trim().split(/\r?\n/);
      let correctedSamples = 0;
      const corrected = rows.map(line => {
        const result = correctResourceIdentity(parseResourceSample(line));
        if (result.excluded.length) correctedSamples++;
        for (const row of result.excluded) excludedIdentities.set(`${row.pid}|${row.startTimeUtc}`, row);
        return result.excluded.length ? JSON.stringify(result.sample) : line;
      });
      const target = path.join(root, "resource-identity", path.relative(root, source));
      await mkdir(path.dirname(target), { recursive: true });
      const output = correctedSamples ? Buffer.from(`${corrected.join("\n")}\n`) : input;
      await writeFile(target, output);
      files.push({ source, target, correctedSamples,
        originalSha256: createHash("sha256").update(input).digest("hex"),
        derivedSha256: createHash("sha256").update(output).digest("hex") });
    }
  }
  const receipt = { version: 1, analysisToolSha256: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"),
    rule: "isolated runner spawns all scopes: exclude pre-runner identities and their descendants; preserve uncertain members",
    files, excludedIdentities: [...excludedIdentities.values()], createdAt: new Date().toISOString() };
  await mkdir(path.join(root, "resource-identity"), { recursive: true });
  await writeFile(path.join(root, "resource-identity/receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export async function withDerivedResources(receipt, analyze) {
  const replacements = new Map(receipt.files.map(row => [path.resolve(row.source), row.target]));
  const original = fs.createReadStream;
  // Only offline analysis reads the derived ledger; timed tools and raw evidence stay frozen.
  fs.createReadStream = (file, options) => original(typeof file === "string" ? replacements.get(path.resolve(file)) || file : file, options);
  syncBuiltinESMExports();
  try { return await analyze(); }
  finally { fs.createReadStream = original; syncBuiltinESMExports(); }
}

export async function analyzeWithResourceIdentity(stage, validationFile, outputFile) {
  assert.ok(["current", "year", "all"].includes(stage));
  await assert.rejects(stat(outputFile), { code: "ENOENT" }, "analysis output must be new; preserve previous results");
  const root = path.dirname(path.resolve(validationFile)), receipt = await deriveResources(root);
  return withDerivedResources(receipt, async () => {
    const { analyze } = await import("./archive-verification-analyze.mjs");
    const result = await analyze(path.join(root, "manifest.json"), validationFile, outputFile, stage);
    result.resourceIdentityCorrection = { receipt: path.join(root, "resource-identity/receipt.json"),
      files: receipt.files.length, correctedSamples: receipt.files.reduce((n, row) => n + row.correctedSamples, 0),
      excludedIdentities: receipt.excludedIdentities };
    await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await analyzeWithResourceIdentity(...process.argv.slice(2));
  console.log(JSON.stringify({ stage: result.stage, passed: result.passed, issues: result.issues, resourceIdentityCorrection: result.resourceIdentityCorrection }));
  if (!result.passed) process.exitCode = 1;
}
