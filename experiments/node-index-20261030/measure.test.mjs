import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import {
  expandCases,
  makeCaseConfig,
  parseMeasureArgs,
  runCase,
  runSerial,
} from "./measure.mjs";

const samplerFile = path.join(import.meta.dirname, "sample-processes.ps1");

test("scenario configs inject the old runner source root", () => {
  const experiment = {
    baselineRoot: "baseline-root",
    candidateRoot: "candidate-root",
    compactRoot: "dsh-root",
    combinedRoot: "combined-root",
    profileRoot: "profile-root",
    originalHookFile: "index-hook.mjs",
  };
  const expected = {
    baseline: ["baseline", "baselineRoot", "baseline-root"],
    index: ["candidate", "candidateRoot", "candidate-root"],
    dsh: ["compact", "compactRoot", "dsh-root"],
    combined: ["candidate", "candidateRoot", "combined-root"],
    profile: ["profile", "profileRoot", "profile-root"],
  };
  for (const [scenario, [source, runnerRootField, sourceRoot]] of Object.entries(expected)) {
    const config = makeCaseConfig(experiment, {scenario, temperature: "warm", runId: scenario});
    assert.equal(config.source, source);
    assert.equal(config.sourceRoot, sourceRoot);
    assert.equal(config[runnerRootField], sourceRoot);
    assert.equal(config.originalHookFile, experiment.originalHookFile);
    assert.equal(config.sampler, samplerFile);
  }
  assert.equal(experiment.candidateRoot, "candidate-root");
});

test("CLI expands explicit serial cases", () => {
  const options = parseMeasureArgs([
    "run",
    "--scenario",
    "baseline,index,dsh,combined",
    "--temperature",
    "warm,cold",
    "--name",
    "main",
  ]);
  assert.deepEqual(expandCases(options.scenarios, options.temperatures, {name: options.name}), [
    {scenario: "baseline", temperature: "warm", name: "main-baseline-warm"},
    {scenario: "baseline", temperature: "cold", name: "main-baseline-cold"},
    {scenario: "index", temperature: "warm", name: "main-index-warm"},
    {scenario: "index", temperature: "cold", name: "main-index-cold"},
    {scenario: "dsh", temperature: "warm", name: "main-dsh-warm"},
    {scenario: "dsh", temperature: "cold", name: "main-dsh-cold"},
    {scenario: "combined", temperature: "warm", name: "main-combined-warm"},
    {scenario: "combined", temperature: "cold", name: "main-combined-cold"},
  ]);
});

test("serial runner never overlaps cases", async () => {
  let active = 0;
  let peak = 0;
  const order = [];
  await runSerial(expandCases(["baseline", "index", "dsh"], ["warm"]), {
    runner: async (testCase) => {
      active += 1;
      peak = Math.max(peak, active);
      order.push(testCase.scenario);
      await delay(5);
      active -= 1;
      return testCase;
    },
  });
  assert.equal(peak, 1);
  assert.deepEqual(order, ["baseline", "index", "dsh"]);
});

test("runCase sends index warm to the old runner", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "node-index-run-case-"));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const configFile = path.join(directory, "experiment.json");
  await fs.writeFile(
    configFile,
    JSON.stringify({
      evidence: directory,
      candidateRoot: path.join(directory, "candidate"),
      originalHookFile: path.join(directory, "index-hook.mjs"),
    }),
  );
  let received = null;
  await runCase(
    {configPath: configFile, scenario: "index", temperature: "warm", name: "synthetic-index-warm"},
    {
      benchmark: async (options) => {
        received = {
          options,
          config: JSON.parse(await fs.readFile(options.configPath, "utf8")),
        };
        return {runId: options.name, passed: true, resultFile: path.join(directory, "result.json")};
      },
    },
  );
  assert.equal(received.options.source, "candidate");
  assert.equal(received.options.operation, "warm");
  assert.equal(received.config.candidateRoot, path.join(directory, "candidate"));
  assert.equal(received.config.sampler, samplerFile);
});

test("sampler records 20ms target, actual intervals and the parent process", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "node-index-sampler-"));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const stateFile = path.join(directory, "state.json");
  const outputFile = path.join(directory, "memory.jsonl");
  const stopFile = path.join(directory, "stop");
  await fs.writeFile(
    stateFile,
    JSON.stringify({case: "synthetic", phase: "today", pids: [process.pid]}),
  );
  const child = spawn(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      samplerFile,
      "-StateFile",
      stateFile,
      "-OutputFile",
      outputFile,
      "-StopFile",
      stopFile,
      "-IntervalMilliseconds",
      "20",
    ],
    {windowsHide: true, stdio: ["ignore", "ignore", "pipe"]},
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const size = await fs.stat(outputFile).then((info) => info.size).catch(() => 0);
    if (size > 0) break;
    await delay(10);
  }
  assert((await fs.stat(outputFile)).size > 0, `sampler did not write output: ${stderr}`);
  await fs.writeFile(stateFile, "");
  await delay(90);
  await fs.writeFile(stateFile, JSON.stringify({case: "synthetic", phase: "today", pids: [null, 0, process.pid]}));
  await delay(90);
  await fs.writeFile(stopFile, "stop");
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0, stderr);
  const rows = (await fs.readFile(outputFile, "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert(rows.length >= 2);
  assert(rows.every((row) => row.targetIntervalMs === 20));
  assert(rows.every((row) => row.processes === 1 && row.nodeProcesses === 1));
  assert(rows.every((row) => row.pids.length === 1 && row.pids[0] === process.pid));
  assert(rows.slice(1).every((row) => row.intervalMs >= 0));
});
