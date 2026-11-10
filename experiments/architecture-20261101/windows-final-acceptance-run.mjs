import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { files, facts, verify, restore } from "./source-snapshot-memory-run.mjs";
import { retainedLedger } from "./windows-stability-run.mjs";
import { restoreStabilityMutations } from "./windows-stability-mutations.mjs";
import { analyzeWindowsCloseout } from "./windows-stability-recovery-analyze.mjs";
import { protectionPassed } from "./windows-stability-schedule.mjs";

const root = path.resolve("output/windows-final-acceptance-20261110");
const previous = path.resolve("output/archive-memory-budget-20261110");
const read = async file => JSON.parse(await fs.readFile(file, "utf8"));
const save = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", flush: true });
};
const hash = async file => createHash("sha256").update(await fs.readFile(file)).digest("hex");
async function checkRuntime() {
  const runtime = await read(path.join(root, "final-runtime.json")).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return read(path.join(previous, "runtimes.json")).then(rows => rows.find(row => row.variant === "candidate"));
  });
  for (const entry of runtime.files) {
    assert.equal(await hash(path.join(runtime.directory, entry.relative)), entry.sha256);
    assert.equal(await hash(path.resolve(entry.relative)), entry.sha256, "Production changed after accepted measurements");
  }
  return runtime;
}
async function freezeRepair() {
  const old = (await read(path.join(previous, "runtimes.json"))).find(row => row.variant === "candidate");
  const directory = path.join(root, "candidate-runtime"), entries = [];
  await fs.mkdir(directory);
  for (const entry of old.files) {
    const source = path.resolve(entry.relative), destination = path.join(directory, entry.relative);
    const sha256 = await hash(source);
    if (!["src/server.js", "src/usage-summary-cache.js"].includes(entry.relative.replaceAll("\\", "/")))
      assert.equal(sha256, entry.sha256, "Repair expanded beyond source identity");
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination); entries.push({ relative: entry.relative, sha256 });
  }
  await save(path.join(root, "final-runtime.json"), { directory, files: entries });
  await checkRuntime();
}
async function config() {
  const old = await read(path.join(previous, "configs/two-years-candidate.json"));
  assert.equal(old.state, path.resolve("output/archive-request-lifetime-20261110/two-years/state"));
  assert.equal(await fs.realpath(old.state), old.state);
  return { ...old, startState: path.join(root, "snapshot"), runtime: (await checkRuntime()).directory };
}
async function prepare() {
  const own = await config();
  const expected = await verify(own, "initial", undefined, root);
  await fs.cp(own.state, own.startState, { recursive: true, force: false, errorOnExist: true });
  assert.deepEqual(facts(own.startState), expected);
  await save(path.join(root, "preparation.json"), { config: own, facts: expected, runtime: await checkRuntime(),
    snapshotFiles: await files(own.startState), productionCommit: "d696737", rawCopyBytes: 0, archiveCopyBytes: 0 });
}
async function run(mode) {
  assert.ok(["closeout-short", "closeout-soak"].includes(mode));
  const prepared = await read(path.join(root, "preparation.json")), own = await config();
  if (mode === "closeout-soak") {
    const repaired = await fs.stat(path.join(root, "final-runtime.json")).then(() => true, () => false);
    const short = await read(path.join(root, repaired ? "short-fixed/analysis.json" : "short/analysis.json"));
    assert.equal(short.reliability.passed, true, "Correctness must pass before soak");
    assert.equal(short.resource.passed, true, "Resource gates must pass before soak");
    const reliability = await read(path.join(root, repaired ? "reliability/acceptance-fixed.json" : "reliability/acceptance.json"));
    assert.equal(reliability.passed, true, "Reliability review must complete before soak");
  }
  const name = mode === "closeout-soak" ? "soak" : process.argv[3] || "short";
  assert.ok(["soak", "short", "short-fixed"].includes(name));
  await restore(own, root);
  await verify(own, `before-${name}`, prepared.facts, root);
  const group = { ...own, mode, directory: path.join(root, name) };
  const configFile = path.join(root, "configs", name + ".json");
  await save(configFile, group);
  const output = await fs.open(path.join(root, name + ".log"), "wx");
  let code;
  try {
    const child = spawn(process.execPath, ["experiments/architecture-20261101/windows-stability-run.mjs", "closeout-run", configFile],
      { env: process.env, windowsHide: true, stdio: ["ignore", output.fd, output.fd] });
    code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  } finally { await output.close(); }
  const result = await analyzeWindowsCloseout(group.directory);
  await save(path.join(group.directory, "analysis.json"), result);
  console.log(JSON.stringify({ mode, code, reliability: result.reliability.status, resource: result.resource.status, performance: result.performance.status }));
  // A failed run keeps its original verdict, but disposable raw mirrors must still be restored.
  const closed = await read(path.join(group.directory, "closed.json"));
  if (!closed.rawRestored) {
    const ledger = await retainedLedger(path.join(group.directory, "base-ledger.json"), path.join(group.directory, "mutations/mutations.ndjson"));
    await restoreStabilityMutations(ledger);
    await save(path.join(group.directory, "failure-source-restoration.json"), { restored: true, atMs: Date.now() });
  }
  await restore(own, root);
  await verify(own, `after-${name}`, prepared.facts, root);
  await checkRuntime();
  process.exitCode = code === 0 && result.reliability.passed && result.resource.passed ? 0 : 1;
}
async function cleanup() {
  const prepared = await read(path.join(root, "preparation.json")), own = await config();
  assert.deepEqual(facts(own.state), prepared.facts, "Retained state must be restored before deleting its snapshot");
  const target = await fs.realpath(own.startState);
  assert.equal(target, path.join(root, "snapshot"));
  const entries = await files(target);
  const bytes = (await Promise.all(entries.map(file => fs.stat(path.join(target, file))))).reduce((n, row) => n + row.size, 0);
  await save(path.join(root, "cleanup/snapshot.json"), { target, bytes, retainedState: own.state, facts: prepared.facts });
  await fs.rm(target, { recursive: true });
  console.log(JSON.stringify({ removedSnapshotBytes: bytes }));
}
async function guard(label) {
  assert.ok(["current", "year"].includes(label));
  const old = await read(path.join(previous, "configs", `${label}-candidate.json`));
  const own = { ...old, runtime: (await checkRuntime()).directory, startState: path.join(root, "guard-snapshots", label),
    directory: path.join(root, "guards", label), mode: "closeout-memory" };
  assert.ok(path.resolve(own.state).startsWith(path.resolve("output/archive-request-lifetime-20261110") + path.sep));
  assert.equal(await fs.realpath(own.state), own.state);
  const expected = await verify(own, "before-guard", undefined, root);
  await fs.cp(own.state, own.startState, { recursive: true, force: false, errorOnExist: true });
  const configFile = path.join(root, "configs", `guard-${label}.json`);
  await save(configFile, own); await fs.mkdir(path.dirname(own.directory), { recursive: true });
  const output = await fs.open(path.join(root, `guard-${label}.log`), "wx");
  let code;
  try {
    const child = spawn(process.execPath, ["experiments/architecture-20261101/windows-stability-run.mjs", "closeout-run", configFile],
      { env: process.env, windowsHide: true, stdio: ["ignore", output.fd, output.fd] });
    code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  } finally { await output.close(); }
  const result = await analyzeWindowsCloseout(own.directory);
  await save(path.join(own.directory, "analysis.json"), result);
  const reference = await read(path.join(previous, "short", label, "candidate", "analysis.json"));
  const protection = Object.entries(reference.metrics).map(([name, beforeMs]) => ({ name, beforeMs, afterMs: result.metrics[name],
    passed: Number.isFinite(result.metrics[name]) && protectionPassed(beforeMs, result.metrics[name]) }));
  await save(path.join(own.directory, "protection.json"), { reference: "accepted d696737 same-layout historical measurement, not a same-round pair", protection });
  const closed = await read(path.join(own.directory, "closed.json"));
  if (!closed.rawRestored) {
    await restoreStabilityMutations(await retainedLedger(path.join(own.directory, "base-ledger.json"), path.join(own.directory, "mutations/mutations.ndjson")));
    await save(path.join(own.directory, "failure-source-restoration.json"), { restored: true });
  }
  await restore(own, root); await verify(own, "after-guard", expected, root);
  const target = await fs.realpath(own.startState);
  assert.equal(target, path.join(root, "guard-snapshots", label));
  const rows = await files(target), bytes = (await Promise.all(rows.map(file => fs.stat(path.join(target, file))))).reduce((n, row) => n + row.size, 0);
  await save(path.join(root, "cleanup", `${label}-snapshot.json`), { target, bytes, facts: expected, retainedState: own.state });
  await fs.rm(target, { recursive: true });
  console.log(JSON.stringify({ label, code, reliability: result.reliability.status, resource: result.resource.status, protection }));
  process.exitCode = code === 0 && result.reliability.passed && result.resource.passed ? 0 : 1;
}
assert.equal(path.resolve(process.env.WINDOWS_CLOSEOUT_ROOT || ""), root);
const command = process.argv[2];
assert.ok(["prepare", "short", "soak", "cleanup", "check", "freeze-repair", "guard"].includes(command));
if (command === "prepare") await prepare();
else if (command === "short" || command === "soak") await run(`closeout-${command}`);
else if (command === "cleanup") await cleanup();
else if (command === "freeze-repair") await freezeRepair();
else if (command === "guard") await guard(process.argv[3]);
else console.log(JSON.stringify({ runtime: await checkRuntime(), config: await config() }));
