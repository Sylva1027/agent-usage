import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { correctResourceIdentity, parseResourceSample } from "./resource-identity-analysis.mjs";
import { createResourceCostLedger } from "./resource-cost-accounting.mjs";

export const ROOT = path.resolve("output/windows-closeout-short-20261111");
const SELF = fileURLToPath(import.meta.url), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = (file, value) => fsp.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", flush: true });
export async function costFile(file) {
  const ledger = createResourceCostLedger(), hash = createHash("sha256");
  let boundaryNulls = 0, unexplainedNulls = 0, index = 0;
  for await (const line of createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
    hash.update(line + "\n"); if (!line.trim()) continue;
    const sample = correctResourceIdentity(parseResourceSample(line)).sample;
    if (!Number.isFinite(sample.service.cpuSecondsIncrement)) {
      if (index === 0 || sample.service.processCount === 0) boundaryNulls++; else unexplainedNulls++;
    }
    ledger.add(sample); index++;
  }
  return { file, normalizedLineSha256: hash.digest("hex"), boundaryNulls, unexplainedNulls, ...ledger.result({ closed: true }) };
}
async function audit() {
  const files = [];
  async function walk(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !/runtime|snapshots/.test(entry.name)) await walk(path.join(directory, entry.name));
      else if (entry.name === "resources.ndjson") files.push(path.join(directory, entry.name));
    }
  }
  await walk(path.resolve("output/committed-publication-20261110"));
  const reports = []; for (const file of files) reports.push(await costFile(file));
  assert.equal(reports.length, 15);
  await save(path.join(ROOT, "counter-correction.json"), { reports, originalEvidenceModified: false,
    note: "Boundary delta nulls are explainable; missing final lifetime counters remain unknown in old evidence." });
  console.log(JSON.stringify({ reports: reports.length, boundaryNulls: reports.reduce((n, row) => n + row.boundaryNulls, 0),
    unexplainedNulls: reports.reduce((n, row) => n + row.unexplainedNulls, 0), missingFinal: reports.reduce((n, row) => n + row.missingFinal.length, 0) }));
}
function fixtureWrite(file) {
  const bytes = Buffer.alloc(1024 * 1024, 19); fs.writeFileSync(file, bytes); fs.readFileSync(file);
  const until = performance.now() + 30; while (performance.now() < until) Math.sqrt(Math.random());
}
async function fixture(mode, directory) {
  if (mode === "fixture-child") {
    await pause(1800); fixtureWrite(path.join(directory, "child.bin"));
    process.send?.({ type: "final", pid: process.pid, cpu: process.cpuUsage() }); return;
  }
  process.send?.({ type: "ready", pid: process.pid });
  await pause(5000);
  const child = fork(SELF, ["fixture-child", directory], { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  process.send?.({ type: "child", pid: child.pid }); child.on("message", value => process.send?.(value));
  await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(Error(`Fixture child exited ${code}`))); });
  await pause(Math.max(0, 27_000 - (performance.now() - fixtureStarted)));
  fixtureWrite(path.join(directory, "parent.bin")); process.send?.({ type: "final", pid: process.pid, cpu: process.cpuUsage() });
}
const fixtureStarted = performance.now();
async function calibrate(label = "cost-calibration") {
  assert.match(label, /^cost-calibration(?:-v\d+)?$/);
  const directory = path.join(ROOT, label); await fsp.mkdir(directory);
  const state = path.join(directory, "state"), temp = path.join(directory, "temp"), stop = path.join(directory, "stop");
  await fsp.mkdir(state); await fsp.mkdir(temp);
  const messages = [], child = fork(SELF, ["fixture", directory], { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let childError = ""; child.stderr.on("data", bytes => childError += bytes);
  child.on("message", value => messages.push(value));
  const childEnded = new Promise(resolve => child.once("exit", resolve));
  const sampler = spawn("pwsh", ["-NoProfile", "-File", path.resolve("experiments/architecture-20261101/windows-stability-resource.ps1"),
    "-ResultDir", directory, "-ServicePid", String(child.pid), "-RunnerPid", String(process.pid), "-StateDir", state,
    "-TempDir", temp, "-StopFile", stop, "-SampleIntervalMilliseconds", "250"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let samplerError = ""; sampler.stderr.on("data", bytes => samplerError += bytes);
  const samplerEnded = new Promise(resolve => sampler.once("exit", resolve));
  try {
    await pause(30_000); await fsp.writeFile(stop, "stop");
    assert.equal(await childEnded, 0, childError); assert.equal(await samplerEnded, 0, samplerError);
    const costs = await costFile(path.join(directory, "resources.ndjson"));
    const expected = messages.filter(row => row.type === "final"); assert.equal(expected.length, 2);
    assert.equal(costs.complete, true, JSON.stringify(costs.missingFinal));
    for (const final of expected) {
      const member = costs.processes.find(row => row.pid === final.pid); assert.ok(member?.final);
      assert.ok(member.values.logicalWriteBytes >= 1024 * 1024);
      assert.ok(member.values.cpuSeconds >= (final.cpu.user + final.cpu.system) / 1e6 - 0.02);
    }
    await save(path.join(ROOT, `${label}.json`), { passed: true, durationMs: 30_000, messages, costs });
    console.log(JSON.stringify({ passed: true, processes: costs.processes.length, totals: costs.totals }));
  } finally {
    await fsp.writeFile(stop, "stop");
    if (child.exitCode === null) child.kill();
    if (sampler.exitCode === null) sampler.kill();
    for (const name of ["child.bin", "parent.bin"]) await fsp.unlink(path.join(directory, name)).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  await fsp.mkdir(ROOT, { recursive: true });
  if (process.argv[2]?.startsWith("fixture")) await fixture(process.argv[2], process.argv[3]);
  else if (process.argv[2] === "audit") await audit();
  else if (process.argv[2] === "calibrate") await calibrate(process.argv[3]);
  else throw Error("Expected audit or calibrate");
}
