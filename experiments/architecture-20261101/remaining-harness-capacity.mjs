import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REMAINING_HARNESSES, createRemainingHarnessFixture } from "../../test-support/remaining-harness-fixture.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = path.join(root, "output/remaining-harnesses-20261105");
const modules = {
  claude: ["claude-code-usage.js", "streamClaudeSessionEvents"],
  workbuddy: ["workbuddy-usage.js", "streamWorkbuddySessionEvents"],
  zcode: ["zcode-usage.js", "streamZcodeDbEvents"],
  opencode: ["opencode-usage.js", "streamOpencodeDbEvents"],
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
function sha(file) {
  const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024), fd = openSync(file, "r");
  try {
    let bytes;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes));
    return hash.digest("hex");
  } finally { closeSync(fd); }
}
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

async function childRun(directory, kind, variant) {
  const fixture = readJson(path.join(directory, "fixture.json"));
  const sourceRoot = variant === "baseline" ? path.join(output, "baseline/src") : path.join(root, "src");
  const scratch = [];
  if (variant === "candidate") {
    const { UsageSourceRows } = await import(pathToFileURL(path.join(sourceRoot, "usage-source-rows.js")));
    const original = UsageSourceRows.prototype.close;
    UsageSourceRows.prototype.close = function () {
      if (this.database) this.sampleScratch();
      scratch.push({ ...this.stats });
      return original.call(this);
    };
  }
  const [module, method] = modules[kind];
  const stream = (await import(pathToFileURL(path.join(sourceRoot, module))))[method];
  process.send({ ready: true });
  await new Promise((resolve) => process.once("message", resolve));
  const hash = createHash("sha256");
  let eventCount = 0, warningCount = 0, total = 0, peakHeap = 0;
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  await stream(fixture.filePath, fixture.source, (event) => {
    hash.update(JSON.stringify(event)); hash.update("\n");
    eventCount++; total += event.usage.total;
    if (!(eventCount % 1024)) peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }, {
    repositoryResolver: (cwd) => ({ key: `fixture:${cwd}`, path: cwd, kind: "directory" }),
    onWarning: (warning) => { warningCount++; hash.update(warning); },
  });
  const elapsedMs = performance.now() - start;
  assert.equal(eventCount, fixture.count);
  const remainder = fixture.count % 7;
  const expectedTotal = fixture.count * (kind === "claude" ? 165 : 160) + Math.floor(fixture.count / 7) * 21 + remainder * (remainder - 1) / 2;
  assert.equal(total, expectedTotal, "independent literal token total");
  const cpu = process.cpuUsage(cpuStart);
  const result = { kind, variant, count: fixture.count, eventCount, total, warningCount,
    digest: hash.digest("hex"), elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000,
    maxRssKiB: process.resourceUsage().maxRSS, peakHeapBytes: peakHeap,
    scratch, sourceBytes: fixture.bytes };
  json(path.join(directory, variant, "result.json"), result);
  process.send({ done: true });
  // Keep the process alive until the resource observer has captured final I/O counters.
  await new Promise((resolve) => process.once("message", resolve));
  process.disconnect();
}

function onceMessage(child, predicate) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => { if (predicate(message)) { cleanup(); resolve(message); } };
    const onExit = (code) => { cleanup(); reject(new Error(`child exited early: ${code}`)); };
    const cleanup = () => { child.off("message", onMessage); child.off("exit", onExit); clearTimeout(timeout); };
    const timeout = setTimeout(() => { cleanup(); child.kill(); reject(new Error("capacity trial timed out")); }, 600000);
    child.on("message", onMessage); child.once("exit", onExit);
  });
}

async function runTrial(directory, kind, variant) {
  const trial = path.join(directory, variant);
  mkdirSync(trial);
  const child = spawn(process.execPath, ["--max-old-space-size=224", "--max-semi-space-size=4", fileURLToPath(import.meta.url), "child", directory, kind, variant],
    { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, TMP: trial, TEMP: trial } });
  child.stdout.on("data", (chunk) => writeFileSync(path.join(trial, "stdout.log"), chunk, { flag: "a" }));
  child.stderr.on("data", (chunk) => writeFileSync(path.join(trial, "stderr.log"), chunk, { flag: "a" }));
  const childExit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let sampler, samplerExit, error, exit;
  try {
    await onceMessage(child, (message) => message.ready);
    sampler = spawn("pwsh", ["-NoProfile", "-File", path.join(root, "experiments/architecture-20261101/b2-attribution-resource.ps1"),
      "-ResultDir", trial, "-ServicePid", String(child.pid), "-RunnerPid", String(process.pid),
      "-StateDir", trial, "-TempDir", trial, "-StopFile", path.join(trial, "resource-stop"), "-SampleIntervalMilliseconds", "250"],
      { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    sampler.stdout.on("data", (chunk) => writeFileSync(path.join(trial, "sampler.log"), chunk, { flag: "a" }));
    sampler.stderr.on("data", (chunk) => writeFileSync(path.join(trial, "sampler.log"), chunk, { flag: "a" }));
    samplerExit = new Promise((resolve) => sampler.once("exit", (code) => resolve(code)));
    const deadline = Date.now() + 30000;
    while (!existsSync(path.join(trial, "resources.ndjson")) || !statSync(path.join(trial, "resources.ndjson")).size) {
      if (sampler.exitCode !== null || Date.now() > deadline) throw new Error("resource observer did not start");
      await sleep(100);
    }
    const done = onceMessage(child, (message) => message.done);
    child.send("go");
    await done;
    await sleep(500);
  } catch (caught) { error = String(caught.stack || caught); }
  finally {
    if (sampler) {
      writeFileSync(path.join(trial, "resource-stop"), "stop");
      const timer = setTimeout(() => sampler.kill(), 30000);
      const code = await samplerExit;
      clearTimeout(timer);
      if (code !== 0) error = `${error || ""}\nresource observer exit ${code}`;
    }
    if (child.exitCode === null && child.connected) child.send("stop");
    const timer = setTimeout(() => child.kill(), 30000);
    exit = await childExit;
    clearTimeout(timer);
  }
  const resultFile = path.join(trial, "result.json");
  const result = { ...(existsSync(resultFile) ? readJson(resultFile) : {}), exit, error };
  json(path.join(trial, "receipt.json"), result);
  return result;
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "child") await childRun(...args);
else if (mode === "prepare") {
  for (const count of [10000, 100000]) for (const kind of REMAINING_HARNESSES) {
    const directory = path.join(output, "fixtures", `${kind}-${count}`);
    assert.ok(!existsSync(directory), `refuse fixture overwrite: ${directory}`);
    const fixture = createRemainingHarnessFixture(directory, kind, count);
    json(path.join(directory, "fixture.json"), { ...fixture, count, bytes: statSync(fixture.filePath).size, sha256: sha(fixture.filePath) });
    console.log(`prepared ${kind} ${count}`);
  }
} else if (mode === "stress") {
  const stressRoot = path.join(output, "stress-final");
  assert.ok(!existsSync(stressRoot), "refuse stress overwrite");
  mkdirSync(stressRoot);
  for (const kind of ["claude", "workbuddy"]) {
    const directory = path.join(stressRoot, kind);
    const fixture = createRemainingHarnessFixture(directory, kind, 300000);
    json(path.join(directory, "fixture.json"), { ...fixture, count: 300000, bytes: statSync(fixture.filePath).size, sha256: sha(fixture.filePath) });
    console.log(`stress ${kind}`);
    const result = await runTrial(directory, kind, "candidate");
    assert.equal(result.exit.code, 0, result.error);
    assert.ok(result.scratch.some((entry) => entry.spilled), "actual default-budget spill required");
    assert.equal(sha(fixture.filePath), readJson(path.join(directory, "fixture.json")).sha256);
    console.log(JSON.stringify(result));
  }
} else if (mode === "run" || mode === "refine") {
  const label = args[0];
  assert.match(label || "", /^[a-z0-9-]+$/);
  const runRoot = path.join(output, label);
  assert.ok(!existsSync(runRoot), "refuse result overwrite");
  mkdirSync(runRoot);
  json(path.join(runRoot, "environment.json"), {
    baselineCommit: "3f0c7b237517c7b6ca8761a06141bd6055626ba8", node: process.version,
    platform: process.platform, release: os.release(), cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length, memoryBytes: os.totalmem(),
    heaps: { oldSpaceMiB: 224, semiSpaceMiB: 4 }, scope: "isolated adapter extraction; not full service/page latency",
  });
  for (const entry of readJson(path.join(output, "baseline-hashes.json"))) {
    assert.equal(sha(path.join(output, "baseline", entry.path)), entry.sha256);
  }
  const candidateFiles = [...readJson(path.join(output, "baseline-hashes.json")).map((entry) => entry.path), "src/usage-source-rows.js"];
  const candidateHashes = candidateFiles.map((file) => ({ file, hash: sha(path.join(root, file)) }));
  json(path.join(runRoot, "candidate-hashes.json"), candidateHashes);
  const results = [];
  for (const count of [10000, 100000]) for (const kind of REMAINING_HARNESSES) {
    const original = path.join(output, "fixtures", `${kind}-${count}`);
    const fixture = readJson(path.join(original, "fixture.json"));
    const directory = path.join(runRoot, `${kind}-${count}`);
    mkdirSync(directory);
    json(path.join(directory, "fixture.json"), fixture);
    const variants = mode === "refine" ? ["candidate"] : (count === 10000 ? ["baseline", "candidate"] : ["candidate", "baseline"]);
    const pair = {};
    if (mode === "refine") {
      assert.match(args[1] || "", /^[a-z0-9-]+$/);
      pair.baseline = readJson(path.join(output, args[1], `${kind}-${count}`, "baseline/receipt.json"));
      pair.baselineControl = args[1];
    }
    for (const variant of variants) {
      console.log(`running ${kind} ${count} ${variant}`);
      pair[variant] = await runTrial(directory, kind, variant);
      console.log(JSON.stringify({ kind, count, variant, elapsedMs: pair[variant].elapsedMs, exit: pair[variant].exit, error: pair[variant].error }));
    }
    const bothComplete = !pair.baseline.error && !pair.candidate.error && pair.baseline.exit.code === 0 && pair.candidate.exit.code === 0;
    if (bothComplete) assert.equal(pair.candidate.digest, pair.baseline.digest, `${kind} ${count} event/warning parity`);
    assert.equal(sha(fixture.filePath), fixture.sha256, "raw fixture unchanged");
    results.push({ kind, count, parity: bothComplete ? "exact" : "incomplete", ...pair });
    json(path.join(runRoot, "matrix.json"), results);
  }
  for (const entry of candidateHashes) assert.equal(sha(path.join(root, entry.file)), entry.hash, "candidate runtime changed during measurement");
  console.log(`completed ${results.length * (mode === "refine" ? 1 : 2)} trials`);
} else throw new Error("use prepare | run <new-label>");
