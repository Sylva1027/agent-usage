import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {pathToFileURL} from "node:url";
import {
  buildRustEnvironment,
  canonical,
  comparable,
  compareComparable,
  hashValue,
  newChildStartPids,
  parseBenchmarkArgs,
  pollPidWatch,
  sequenceForOperation,
  summarizeMemory,
} from "./benchmark.mjs";

const expectPath = (value) => path.resolve(value);

test("canonical sorts object keys but preserves array order", () => {
  const value = canonical({z: 1, a: [{y: 2, x: 3}, "second"], m: null});
  assert.deepEqual(Object.keys(value), ["a", "m", "z"]);
  assert.deepEqual(Object.keys(value.a[0]), ["x", "y"]);
  assert.deepEqual(value.a.slice(1), ["second"]);
});

test("comparison reports each aggregate field without dropping business data", () => {
  const left = {
    summary: {total: 7, nested: {value: 1}},
    metadata: {events: 2},
    periodComparison: {current: 1},
    pricingCatalog: {version: "v1"},
    quota: null,
  };
  const right = structuredClone(left);
  right.summary.nested.value = 2;
  const payload = comparable(left);
  assert.deepEqual(Object.keys(payload), [
    "summary",
    "metadata",
    "periodComparison",
    "pricingCatalog",
    "quota",
  ]);
  const result = compareComparable(left, right);
  assert.equal(result.equal, false);
  assert.equal(result.fields.summary, false);
  assert.equal(result.fields.metadata, true);
  assert.equal(result.differences[0].path, "$.summary.nested.value");
});

test("hash uses canonical object order", () => {
  assert.equal(hashValue({b: 2, a: {d: 4, c: 3}}), hashValue({a: {c: 3, d: 4}, b: 2}));
});

test("child starts use newly observed PIDs and ignore duplicate events", () => {
  const before = [
    {action: "start", kind: "service", pid: 10},
    {action: "start", kind: "calculator", pid: 11},
  ];
  const after = [
    ...before,
    {action: "start", kind: "calculator", pid: 11},
    {action: "start", kind: "calculator", pid: 12},
    {action: "end", kind: "calculator", pid: 12},
  ];
  assert.deepEqual(newChildStartPids(before, after), [12]);
});

test("CLI supports sources and operations", () => {
  assert.deepEqual(
    parseBenchmarkArgs([
      "--source",
      "candidate",
      "--operation",
      "warm",
      "--rust-perf-bin",
      "native-perf.exe",
    ]),
    {
      configPath: parseBenchmarkArgs([]).configPath,
      source: "candidate",
      operation: "warm",
      name: null,
      rustPerfBin: expectPath("native-perf.exe"),
      rustDshBin: null,
      help: false,
    },
  );
  assert.throws(() => parseBenchmarkArgs(["--source", "other", "--operation", "smoke"]));
  assert.equal(parseBenchmarkArgs(["--source", "compact", "--operation", "warm"]).source, "compact");
  assert.deepEqual(sequenceForOperation("smoke"), ["today", "all", "today-hit"]);
  assert.deepEqual(sequenceForOperation("cold"), ["today", "today-hit", "all"]);
  assert.deepEqual(sequenceForOperation("migration"), ["today", "today-hit", "all"]);
  assert(sequenceForOperation("warm").includes("restart-hit"));
});

test("Rust binaries and PID files are injected independently", () => {
  const result = buildRustEnvironment({
    rustPerfBin: expectPath("native-perf.exe"),
    rustDshBin: expectPath("rust-dsh.exe"),
    pidDirectory: expectPath("trial"),
  });
  assert.equal(result.env.RUST_PERF_BIN, expectPath("native-perf.exe"));
  assert.equal(result.env.RUST_DSH_BIN, expectPath("rust-dsh.exe"));
  assert.equal(result.env.DSH_RUST_HELPER, expectPath("rust-dsh.exe"));
  assert.equal(result.env.RUST_PERF_PID_FILE, expectPath("trial/native-perf.pid"));
  assert.equal(result.env.RUST_DSH_PID_FILE, expectPath("trial/rust-dsh.pid"));
});

test("memory summary includes every tracked descendant PID", () => {
  const events = [
    {action: "start", pid: 10, kind: "service"},
    {action: "start", pid: 11, kind: "calculator"},
    {action: "start", pid: 12, kind: "helper"},
    {action: "end", pid: 12, kind: "helper"},
    {action: "end", pid: 11, kind: "calculator"},
    {action: "end", pid: 10, kind: "service"},
  ];
  const rows = [
    {at: 1, rss: 100, private: 80, processes: 1, pids: [10]},
    {at: 101, rss: 300, private: 250, processes: 3, pids: [10, 11, 12]},
    {at: 201, rss: 120, private: 90, processes: 1, pids: [10]},
  ];
  const summary = summarizeMemory(rows, events);
  assert.equal(summary.peakProcesses, 3);
  assert.deepEqual(summary.sampledPids, [10, 11, 12]);
  assert.deepEqual(summary.unknownSampledPids, []);
  assert.equal(summary.trackedByKind.helper, 1);
  assert.equal(summary.openPids.length, 0);
  assert.equal(summary.byPhase.unknown.peakProcesses, 3);
});

test("PID-file watcher observes and retires a short-lived helper", () => {
  const watch = {kind: "rust-perf", file: "unused", current: null};
  const events = [];
  let pid = 1234;
  let alive = true;
  const options = {
    readPid: () => pid,
    isAlive: () => alive,
    onStart: (value) => events.push(["start", value]),
    onEnd: (value, details) => events.push(["end", value, details.signal]),
  };
  pollPidWatch(watch, options);
  assert.deepEqual(events, [["start", 1234]]);
  alive = false;
  pollPidWatch(watch, options);
  assert.deepEqual(events, [
    ["start", 1234],
    ["end", 1234, null],
  ]);
  pid = null;
  pollPidWatch(watch, options);
  assert.equal(watch.current, null);
});

test("runtime hook captures calculator stderr despite official ignore stdio", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rust-harness-stderr-"));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const originalHookFile = path.join(directory, "original-hook.mjs");
  const calculatorFile = path.join(directory, "usage-executor.js");
  const parentFile = path.join(directory, "parent.mjs");
  const configFile = path.join(directory, "config.json");
  const eventFile = path.join(directory, "events.jsonl");
  const calculatorStderrFile = path.join(directory, "calculator-stderr.log");
  await fs.writeFile(originalHookFile, "export {};\n");
  await fs.writeFile(
    calculatorFile,
    'process.stderr.write("fatal calculator fixture\\n"); process.exit(134);\n',
  );
  await fs.writeFile(
    parentFile,
    [
      'import {fork} from "node:child_process";',
      `const child = fork(${JSON.stringify(calculatorFile)}, [], {stdio: ["ignore", "ignore", "ignore", "ipc"]});`,
      'child.once("exit", (code) => process.exit(code === 134 ? 0 : 1));',
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    configFile,
    JSON.stringify({
      originalHookFile,
      options: {databaseFile: path.join(directory, "index.sqlite")},
      processEventFile: eventFile,
      calculatorStderrFile,
    }),
  );
  const runtimeHookUrl = pathToFileURL(path.resolve(import.meta.dirname, "runtime-hook.mjs")).href;
  const child = spawn(
    process.execPath,
    ["--import", runtimeHookUrl, parentFile],
    {
      env: {...process.env, LOCAL_SUMMARY_CASE_CONFIG: configFile},
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0, stderr);
  assert.match(await fs.readFile(calculatorStderrFile, "utf8"), /fatal calculator fixture/);
  const events = (await fs.readFile(eventFile, "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert(events.some((event) => event.kind === "calculator" && event.action === "end" && event.exitCode === 134));
});
