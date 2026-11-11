import assert from "node:assert/strict";
import {fork, spawn} from "node:child_process";
import {createHash, randomBytes} from "node:crypto";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import path from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {parseArgs} from "node:util";
import {fileURLToPath, pathToFileURL} from "node:url";

export const COMPARABLE_FIELDS = Object.freeze([
  "summary",
  "metadata",
  "periodComparison",
  "pricingCatalog",
  "quota",
]);

const SOURCES = new Set(["baseline", "candidate", "profile", "compact"]);
const OPERATIONS = new Set(["smoke", "warm", "all-cold", "warm-all", "cold", "migration"]);
const DEFAULT_CONFIG = path.resolve("output/rust-integration-20261030/experiment.json");
const MODULE_FILE = fileURLToPath(import.meta.url);
const SERVICE_FILE = path.join(import.meta.dirname, "service.mjs");
const RUNTIME_HOOK_FILE = path.join(import.meta.dirname, "runtime-hook.mjs");

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

export function comparable(value) {
  return Object.fromEntries(COMPARABLE_FIELDS.map((field) => [field, value?.[field]]));
}

export function hashValue(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function collectDifferences(left, right, at = "$", output = [], limit = 100) {
  if (output.length >= limit) return output;
  if (Object.is(left, right)) return output;
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    output.push({path: at, left, right});
    return output;
  }
  if (Array.isArray(left)) {
    if (left.length !== right.length) output.push({path: `${at}.length`, left: left.length, right: right.length});
    for (let index = 0; index < Math.min(left.length, right.length) && output.length < limit; index += 1) {
      collectDifferences(left[index], right[index], `${at}[${index}]`, output, limit);
    }
    return output;
  }
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  for (const key of keys) {
    if (output.length >= limit) break;
    const next = `${at}.${key}`;
    if (!Object.hasOwn(left, key)) output.push({path: next, left: "<missing>", right: right[key]});
    else if (!Object.hasOwn(right, key)) output.push({path: next, left: left[key], right: "<missing>"});
    else collectDifferences(left[key], right[key], next, output, limit);
  }
  return output;
}

export function compareComparable(left, right) {
  const fields = {};
  const differences = [];
  for (const field of COMPARABLE_FIELDS) {
    const fieldDifferences = collectDifferences(left?.[field], right?.[field], `$.${field}`);
    fields[field] = fieldDifferences.length === 0;
    differences.push(...fieldDifferences);
  }
  return {equal: differences.length === 0, fields, differences};
}

function numericStats(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    n: sorted.length,
    min: sorted[0],
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    max: sorted.at(-1),
  };
}

const mib = (bytes) => Math.round((bytes / 2 ** 20) * 100) / 100;

export function summarizeMemory(rows, events) {
  const active = rows.filter((row) => Number(row.processes) > 0);
  const starts = events.filter((event) => event.action === "start");
  const ends = new Set(events.filter((event) => event.action === "end").map((event) => Number(event.pid)));
  const startsByPid = new Map(starts.map((event) => [Number(event.pid), event]));
  const kinds = {};
  for (const event of startsByPid.values()) kinds[event.kind || "unknown"] = (kinds[event.kind || "unknown"] || 0) + 1;
  const intervals = active.slice(1).map((row, index) => row.at - active[index].at).filter((value) => value >= 0);
  const sampledPids = [...new Set(active.flatMap((row) => row.pids || []).map(Number))].sort((a, b) => a - b);
  const unknownSampledPids = sampledPids.filter((pid) => !startsByPid.has(pid));
  const byPhase = {};
  for (const row of active) {
    const phase = row.phase || "unknown";
    const current = (byPhase[phase] ||= {
      samples: 0,
      peakWorkingSetBytes: 0,
      peakPrivateBytes: 0,
      peakProcesses: 0,
    });
    current.samples += 1;
    current.peakWorkingSetBytes = Math.max(current.peakWorkingSetBytes, Number(row.rss));
    current.peakPrivateBytes = Math.max(current.peakPrivateBytes, Number(row.private));
    current.peakProcesses = Math.max(current.peakProcesses, Number(row.processes));
  }
  for (const row of Object.values(byPhase)) {
    row.peakWorkingSetMiB = mib(row.peakWorkingSetBytes);
    row.peakPrivateMiB = mib(row.peakPrivateBytes);
  }
  return {
    samples: active.length,
    totalSamples: rows.length,
    peakWorkingSetBytes: active.length ? Math.max(...active.map((row) => Number(row.rss))) : 0,
    peakPrivateBytes: active.length ? Math.max(...active.map((row) => Number(row.private))) : 0,
    peakWorkingSetMiB: active.length ? mib(Math.max(...active.map((row) => Number(row.rss)))) : 0,
    peakPrivateMiB: active.length ? mib(Math.max(...active.map((row) => Number(row.private)))) : 0,
    peakProcesses: active.length ? Math.max(...active.map((row) => Number(row.processes))) : 0,
    within512MiB: active.every((row) => Number(row.rss) <= 512 * 2 ** 20 && Number(row.private) <= 512 * 2 ** 20),
    sampleIntervalMs: numericStats(intervals),
    trackedProcesses: startsByPid.size,
    trackedByKind: kinds,
    openPids: [...startsByPid.keys()].filter((pid) => !ends.has(pid)),
    sampledPids,
    unknownSampledPids,
    allSampledProcessesTracked: unknownSampledPids.length === 0,
    byPhase,
  };
}

export function newChildStartPids(beforeEvents, afterEvents) {
  const before = new Set(
    beforeEvents
      .filter((event) => event.action === "start" && event.kind !== "service")
      .map((event) => Number(event.pid)),
  );
  return [
    ...new Set(
      afterEvents
        .filter((event) => event.action === "start" && event.kind !== "service")
        .map((event) => Number(event.pid))
        .filter((pid) => !before.has(pid)),
    ),
  ].sort((left, right) => left - right);
}

export function selectSourceRoot(experiment, source) {
  if (!SOURCES.has(source)) throw new Error(`Unknown source: ${source}`);
  const key = `${source}Root`;
  if (!experiment[key]) throw new Error(`Experiment config has no ${key}`);
  return experiment[key];
}

export function buildRustEnvironment({rustPerfBin = null, rustDshBin = null, pidDirectory}) {
  const env = {};
  const pidFiles = {};
  if (rustPerfBin) {
    pidFiles.perf = path.join(pidDirectory, "native-perf.pid");
    env.RUST_PERF_BIN = rustPerfBin;
    env.RUST_PERF_PID_FILE = pidFiles.perf;
  }
  if (rustDshBin) {
    pidFiles.dsh = path.join(pidDirectory, "rust-dsh.pid");
    env.RUST_DSH_BIN = rustDshBin;
    env.DSH_RUST_HELPER = rustDshBin;
    env.RUST_DSH_PID_FILE = pidFiles.dsh;
  }
  return {env, pidFiles};
}

export function sequenceForOperation(operation) {
  if (!OPERATIONS.has(operation)) throw new Error(`Unknown operation: ${operation}`);
  if (operation === "smoke") return ["today", "all", "today-hit"];
  if (operation === "all-cold" || operation === "warm-all") return ["all", "all-hit"];
  if (operation === "cold" || operation === "migration") return ["today", "today-hit", "all"];
  return [
    "today",
    "today-hit",
    "month",
    "all",
    "7d",
    "freeze",
    "frozen",
    "no-new-hit-1",
    "no-new-hit-2",
    "no-new-hit-3",
    "no-new-hit-4",
    "no-new-hit-5",
    "restart-hit",
  ];
}

export function parseBenchmarkArgs(args = process.argv.slice(2)) {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: {type: "string", default: DEFAULT_CONFIG},
      source: {type: "string"},
      operation: {type: "string"},
      name: {type: "string"},
      "rust-perf-bin": {type: "string"},
      "rust-dsh-bin": {type: "string"},
      help: {type: "boolean", default: false},
    },
    strict: true,
  });
  const source = parsed.values.source || parsed.positionals[0] || "baseline";
  const operation = parsed.values.operation || parsed.positionals[1] || "smoke";
  if (!SOURCES.has(source)) throw new Error(`source must be baseline, candidate, profile or compact`);
  if (!OPERATIONS.has(operation)) {
    throw new Error(`operation must be smoke, warm, all-cold, cold or migration`);
  }
  if (parsed.positionals.length > 2) throw new Error("Too many positional arguments");
  return {
    configPath: path.resolve(parsed.values.config),
    source,
    operation,
    name: parsed.values.name || null,
    rustPerfBin: parsed.values["rust-perf-bin"] ? path.resolve(parsed.values["rust-perf-bin"]) : null,
    rustDshBin: parsed.values["rust-dsh-bin"] ? path.resolve(parsed.values["rust-dsh-bin"]) : null,
    help: parsed.values.help,
  };
}

export function pollPidWatch(watch, {readPid, isAlive, onStart, onEnd}) {
  const pid = readPid();
  if (watch.current !== null && !isAlive(watch.current)) {
    onEnd(watch.current, {exitCode: null, signal: null});
    watch.current = null;
  }
  if (pid !== null && pid !== watch.current && isAlive(pid)) {
    if (watch.current !== null) onEnd(watch.current, {exitCode: null, signal: "REPLACED"});
    watch.current = pid;
    onStart(pid);
  }
  return watch.current;
}

async function readJsonLines(file) {
  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function hashFile(file) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function filesBelow(root) {
  const result = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, {withFileTypes: true});
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.push(absolute);
    }
  }
  await visit(root);
  return result.sort();
}

async function sourceInventory(root) {
  const files = await filesBelow(path.join(root, "src"));
  const hashes = {};
  for (const file of files) {
    hashes[path.relative(root, file).replaceAll(path.sep, "/")] = await hashFile(file);
  }
  try {
    hashes["package.json"] = await hashFile(path.join(root, "package.json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return hashes;
}

function makeState(file, name) {
  const pids = new Set();
  let phase = "startup";
  const save = () => {
    syncFs.writeFileSync(
      file,
      JSON.stringify({case: name, phase, pids: [...pids].sort((left, right) => left - right)}),
    );
  };
  save();
  return {
    pids,
    setPhase(value) {
      phase = value;
      save();
    },
    add(pid) {
      if (!Number.isInteger(pid)) return;
      pids.add(pid);
      save();
    },
    remove(pid) {
      pids.delete(Number(pid));
      save();
    },
    clear() {
      pids.clear();
      save();
    },
  };
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function seedForOperation(experiment, operation) {
  if (operation === "warm" || operation === "warm-all") return experiment.warmDatabase;
  if (operation === "migration") return experiment.legacyDatabase;
  return null;
}

function queryFor(label) {
  const base = {calendarZone: "local", view: "dashboard"};
  if (label === "all" || label === "all-hit") return {...base, preset: "all", bucket: "day"};
  if (label === "month") return {...base, preset: "month", bucket: "day"};
  if (label === "7d") return {...base, preset: "quota_week", bucket: "quota_24h"};
  return {...base, preset: "today", bucket: "hour"};
}

export async function runBenchmark({
  configPath = DEFAULT_CONFIG,
  source = "baseline",
  operation = "smoke",
  name = null,
  rustPerfBin = null,
  rustDshBin = null,
} = {}) {
  const experiment = JSON.parse(await fs.readFile(configPath, "utf8"));
  const sourceRoot = selectSourceRoot(experiment, source);
  if (rustPerfBin && source !== "candidate") throw new Error("RUST_PERF_BIN is only supported with source=candidate");
  for (const [label, binary] of [
    ["rustPerfBin", rustPerfBin],
    ["rustDshBin", rustDshBin],
  ]) {
    if (!binary) continue;
    const info = await fs.stat(binary).catch(() => null);
    if (!info?.isFile()) throw new Error(`${label} is not a file: ${binary}`);
  }
  const sourceHashes = await sourceInventory(sourceRoot);
  if (source === "baseline") {
    for (const row of experiment.files || []) {
      const relative = `src/${String(row.file).replaceAll("\\", "/")}`;
      assert.equal(sourceHashes[relative], row.hash, `Baseline source hash changed: ${relative}`);
    }
  }

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const rustVariant = `${rustDshBin ? "rust-dsh" : "node-dsh"}+${rustPerfBin ? "native-perf" : "node-perf"}`;
  const runId = safeName(
    name || `${source}-${operation}-${rustVariant}-${stamp}-${randomBytes(3).toString("hex")}`,
  );
  const evidence = path.resolve(experiment.evidence);
  const trialDirectory = path.join(path.resolve(experiment.work), "trials", runId);
  const payloadDirectory = path.join(evidence, `${runId}-payloads`);
  await fs.mkdir(path.dirname(trialDirectory), {recursive: true});
  await fs.mkdir(trialDirectory, {recursive: false});
  await fs.mkdir(payloadDirectory, {recursive: true});

  const databaseFile = path.join(trialDirectory, "index.sqlite");
  const summaryCacheFile = `${databaseFile}.summaries.sqlite`;
  for (const file of [databaseFile, summaryCacheFile]) {
    for (const suffix of ["", "-wal", "-shm"]) await fs.rm(`${file}${suffix}`, {force: true});
  }
  const seed = seedForOperation(experiment, operation);
  if (seed) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await fs.copyFile(`${seed}${suffix}`, `${databaseFile}${suffix}`);
      } catch (error) {
        if (suffix === "" || error.code !== "ENOENT") {
          if (suffix !== "" && error.code === "ENOENT") continue;
          if (suffix === "" || error.code !== "ENOENT") throw error;
        }
      }
    }
  }

  const configFile = path.join(trialDirectory, "config.json");
  const stateFile = path.join(trialDirectory, "state.json");
  const stopFile = path.join(trialDirectory, "stop");
  const memoryFile = path.join(evidence, `${runId}-memory.jsonl`);
  const eventFile = path.join(evidence, `${runId}-events.jsonl`);
  const stderrFile = path.join(evidence, `${runId}-stderr.log`);
  const calculatorStderrFile = path.join(evidence, `${runId}-calculator-stderr.log`);
  const rustEnvironment = buildRustEnvironment({
    rustPerfBin,
    rustDshBin,
    pidDirectory: trialDirectory,
  });
  await fs.rm(stopFile, {force: true});
  await fs.rm(eventFile, {force: true});
  await fs.rm(memoryFile, {force: true});
  await fs.writeFile(stderrFile, "");
  await fs.writeFile(calculatorStderrFile, "");

  const config = {
    ...experiment,
    source,
    sourceRoot,
    seed,
    operation,
    runId,
    trialDirectory,
    processEventFile: eventFile,
    calculatorStderrFile,
    fixedNow: experiment.fixedNow,
    options: {
      ...experiment.options,
      databaseFile,
      env: {...experiment.options.env, ...rustEnvironment.env},
    },
  };
  await writeJson(configFile, config);
  const state = makeState(stateFile, runId);
  const sampler = spawn(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      experiment.sampler,
      "-StateFile",
      stateFile,
      "-OutputFile",
      memoryFile,
      "-StopFile",
      stopFile,
    ],
    {windowsHide: true, stdio: ["ignore", "ignore", "pipe"]},
  );
  let samplerStderr = "";
  sampler.stderr.on("data", (chunk) => {
    samplerStderr += chunk;
  });

  const appendEvent = (event) => {
    syncFs.appendFileSync(eventFile, `${JSON.stringify({at: Date.now(), ...event})}\n`);
  };
  const responses = [];
  const runtimeEvents = [];
  const stderrChunks = [];
  let service = null;
  let base = null;
  let failure = null;
  let startedAt = null;
  let result = null;

  async function waitForFile(file, timeoutMs = 5000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (syncFs.existsSync(file) && syncFs.statSync(file).size > 0) return;
      await delay(50);
    }
    throw new Error(`Timed out waiting for ${file}`);
  }

  async function startService() {
    const child = fork(SERVICE_FILE, [configFile], {
      execArgv: ["--max-old-space-size=128", "--import", pathToFileURL(RUNTIME_HOOK_FILE).href],
      env: {...process.env, ...config.options.env, LOCAL_SUMMARY_CASE_CONFIG: configFile},
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    service = child;
    state.add(child.pid);
    appendEvent({
      action: "start",
      pid: child.pid,
      parentPid: process.pid,
      kind: "service",
      executable: process.execPath,
      argv: child.spawnargs,
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
      syncFs.appendFileSync(stderrFile, chunk);
    });
    child.on("message", (message) => {
      if (message?.type === "process-event") {
        runtimeEvents.push(message);
        if (message.action === "start") state.add(message.pid);
        if (message.action === "end") state.remove(message.pid);
      }
    });
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Service ready timeout")), 30_000);
      const onMessage = (message) => {
        if (message?.type === "ready") {
          clearTimeout(timer);
          child.off("message", onMessage);
          resolve(message);
        } else if (message?.type === "fatal") {
          clearTimeout(timer);
          child.off("message", onMessage);
          reject(new Error(message.error?.message || "Service failed"));
        }
      };
      child.on("message", onMessage);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Service exited before ready: ${code}`));
      });
    });
    base = `http://127.0.0.1:${ready.port}`;
  }

  const pidWatches = [
    ...(rustEnvironment.pidFiles.perf
      ? [{kind: "rust-perf", file: rustEnvironment.pidFiles.perf, current: null}]
      : []),
    ...(rustEnvironment.pidFiles.dsh
      ? [{kind: "rust-dsh", file: rustEnvironment.pidFiles.dsh, current: null}]
      : []),
  ];

  function isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  }

  function emitPidFileEvent(watch, action, pid, extra = {}) {
    const event = {
      at: Date.now(),
      action,
      pid,
      parentPid: null,
      kind: watch.kind,
      source: "pid-file",
      pidFile: watch.file,
      ...extra,
    };
    appendEvent(event);
    runtimeEvents.push({type: "process-event", ...event});
    if (action === "start") state.add(pid);
    else state.remove(pid);
  }

  function pollPidFiles() {
    for (const watch of pidWatches) {
      pollPidWatch(watch, {
        readPid() {
          try {
            const value = Number(syncFs.readFileSync(watch.file, "utf8").trim());
            return Number.isInteger(value) && value > 0 ? value : null;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            return null;
          }
        },
        isAlive,
        onStart(pid) {
          emitPidFileEvent(watch, "start", pid);
        },
        onEnd(pid, details) {
          emitPidFileEvent(watch, "end", pid, details);
        },
      });
    }
  }
  const pidPollTimer = setInterval(() => {
    try {
      pollPidFiles();
    } catch (error) {
      stderrChunks.push(Buffer.from(`PID-file watcher: ${error.message}\n`));
    }
  }, 20);

  async function waitIdle(timeoutMs = 20_000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const serviceAlive = service && service.exitCode === null ? 1 : 0;
      if (state.pids.size <= serviceAlive) return;
      await delay(50);
    }
    throw new Error(`Descendant process did not retire: ${[...state.pids].join(",")}`);
  }

  async function stopService() {
    const child = service;
    if (!child) return;
    if (child.exitCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
          resolve();
        }, 15_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          child.send({type: "close"}, () => {});
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      });
    }
    appendEvent({
      action: "end",
      pid: child.pid,
      parentPid: process.pid,
      kind: "service",
      exitCode: child.exitCode,
      signal: child.signalCode,
    });
    state.remove(child.pid);
    service = null;
    base = null;
  }

  async function request(label, query, expectedCache = null) {
    assert(base, "Service is not running");
    state.setPhase(label);
    const beforeEvents = runtimeEvents.slice();
    const started = performance.now();
    const response = await fetch(`${base}/api/usage?${new URLSearchParams(query)}`, {
      signal: AbortSignal.timeout(900_000),
    });
    const body = await response.json();
    const ms = performance.now() - started;
    await waitIdle();
    const childStartPids = newChildStartPids(beforeEvents, runtimeEvents);
    const row = {
      label,
      status: response.status,
      ms,
      cache: response.headers.get("x-summary-cache"),
      childStarts: childStartPids.length,
      childStartPids,
      hash: null,
      payloadFile: null,
      asOf: body?.summary?.range?.asOf || body?.quota?.asOf || null,
    };
    if (response.ok) {
      const payload = canonical(comparable(body));
      for (const field of COMPARABLE_FIELDS) {
        if (!Object.hasOwn(body, field)) throw new Error(`${label} response is missing ${field}`);
      }
      row.hash = hashValue(payload);
      row.payloadFile = path.join(payloadDirectory, `${safeName(label)}.json`);
      await writeJson(row.payloadFile, payload);
    } else {
      row.payloadFile = path.join(payloadDirectory, `${safeName(label)}-error.json`);
      await writeJson(row.payloadFile, body);
    }
    responses.push(row);
    console.log(JSON.stringify(row));
    assert.equal(response.status, 200, `${label} failed: ${JSON.stringify(body)}`);
    if (expectedCache) assert.equal(row.cache, expectedCache, `${label} cache expectation`);
    if (expectedCache === "hit") assert.equal(row.childStarts, 0, `${label} started a calculator`);
    return {body, payload: response.ok ? canonical(comparable(body)) : null, row};
  }

  function assertEqual(label, left, right) {
    const comparison = compareComparable(left, right);
    assert(comparison.equal, `${label} differs: ${JSON.stringify(comparison.differences.slice(0, 10))}`);
  }

  try {
    startedAt = new Date().toISOString();
    await waitForFile(memoryFile);
    await startService();
    if (operation === "smoke") {
      const today = await request("today", queryFor("today"), "miss");
      const all = await request("all", queryFor("all"), "miss");
      assert.notEqual(all.row.hash, today.row.hash, "all and today unexpectedly have the same payload");
      const hit = await request("today-hit", queryFor("today"), "hit");
      assertEqual("today-hit", hit.payload, today.payload);
    } else if (operation === "all-cold" || operation === "warm-all") {
      const all = await request("all", queryFor("all"), "miss");
      const hit = await request("all-hit", queryFor("all"), "hit");
      assertEqual("all-hit", hit.payload, all.payload);
    } else if (operation === "cold" || operation === "migration") {
      const today = await request("today", queryFor("today"), "miss");
      const hit = await request("today-hit", queryFor("today"), "hit");
      assertEqual("today-hit", hit.payload, today.payload);
      await request("all", queryFor("all"), "miss");
    } else {
      const today = await request("today", queryFor("today"), "miss");
      const todayHit = await request("today-hit", queryFor("today"), "hit");
      assertEqual("today-hit", todayHit.payload, today.payload);
      await request("month", queryFor("month"), "miss");
      await request("all", queryFor("all"), "miss");
      await request("7d", queryFor("7d"), "miss");
      const freeze = await request("freeze", {...queryFor("today"), freeze: "1"});
      const snapshotId = freeze.body.snapshotId;
      assert(snapshotId, "freeze did not return snapshotId");
      assertEqual("freeze", freeze.payload, today.payload);
      const frozen = await request("frozen", {...queryFor("today"), snapshot: snapshotId});
      assertEqual("frozen", frozen.payload, today.payload);
      for (let index = 1; index <= 5; index += 1) {
        const unchanged = await request(`no-new-hit-${index}`, queryFor("today"), "hit");
        assertEqual(`no-new-hit-${index}`, unchanged.payload, today.payload);
      }
      await waitIdle();
      await stopService();
      state.setPhase("restart");
      await startService();
      const restarted = await request("restart-hit", queryFor("today"), "hit");
      assertEqual("restart-hit", restarted.payload, today.payload);
    }
    await waitIdle();
  } catch (error) {
    failure = {message: error.message, stack: error.stack};
    process.exitCode = 1;
  } finally {
    try {
      await stopService();
    } catch (error) {
      failure ||= {message: error.message, stack: error.stack};
    }
    clearInterval(pidPollTimer);
    for (const watch of pidWatches) {
      if (watch.current === null) continue;
      try {
        process.kill(watch.current, "SIGKILL");
      } catch {}
      emitPidFileEvent(watch, "end", watch.current, {exitCode: null, signal: "BENCHMARK_CLEANUP"});
      watch.current = null;
    }
    state.clear();
    await fs.writeFile(stopFile, "stop");
    await new Promise((resolve) => {
      if (sampler.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        try {
          sampler.kill("SIGKILL");
        } catch {}
        resolve();
      }, 5000);
      sampler.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    const memoryRows = await readJsonLines(memoryFile);
    const events = await readJsonLines(eventFile);
    const memory = summarizeMemory(memoryRows, events);
    if (!memory.within512MiB && !failure) {
      failure = {message: `Target memory exceeded 512 MiB: ${JSON.stringify(memory)}`};
      process.exitCode = 1;
    }
    if (!memory.allSampledProcessesTracked && !failure) {
      failure = {message: `Sampler observed untracked PIDs: ${memory.unknownSampledPids.join(",")}`};
      process.exitCode = 1;
    }
    const calculatorStarts = events.filter((event) => event.action === "start" && event.kind === "calculator");
    if (calculatorStarts.length) {
      for (const event of calculatorStarts) {
        assert(event.argv.includes("--max-old-space-size=224"), "Calculator old-space is not 224 MiB");
        assert(event.argv.includes("--max-semi-space-size=4"), "Calculator semi-space is not 4 MiB");
      }
    }
    const manifest = JSON.parse(await fs.readFile(experiment.manifestPath, "utf8"));
    result = {
      runId,
      source,
      operation,
      rustVariant,
      rustPerfBin,
      rustDshBin,
      rustEnvironment,
      sourceRoot,
      fixedNow: experiment.fixedNow,
      seed,
      trialDirectory,
      databaseFile,
      summaryCacheFile,
      configFile,
      memoryFile,
      eventFile,
      stderrFile,
      calculatorStderrFile,
      payloadDirectory,
      startedAt,
      finishedAt: new Date().toISOString(),
      passed: !failure,
      error: failure,
      fields: COMPARABLE_FIELDS,
      responses,
      memory,
      processEvents: events,
      sourceHashes,
      rustBinaryHashes: Object.fromEntries(
        await Promise.all(
          [rustPerfBin, rustDshBin].filter(Boolean).map(async (file) => [file, await hashFile(file)]),
        ),
      ),
      manifest: {
        path: experiment.manifestPath,
        sha256: await hashFile(experiment.manifestPath),
        bytes: manifest.copied.reduce((total, row) => total + Number(row.size || 0), 0),
        files: manifest.copied.length,
        counts: manifest.counts,
      },
      samplerStderr,
      serviceStderr: Buffer.concat(stderrChunks).toString("utf8"),
      calculatorStderr: await fs.readFile(calculatorStderrFile, "utf8"),
    };
    const resultFile = path.join(evidence, `${runId}-result.json`);
    await writeJson(resultFile, result);
    result.resultFile = resultFile;
    console.log(JSON.stringify({runId, passed: result.passed, memory, resultFile}));
  }
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(MODULE_FILE);
if (isMain) {
  try {
    const options = parseBenchmarkArgs();
    if (options.help) {
      console.log(
        "Usage: node experiments/rust-integration-20261030/benchmark.mjs --source baseline|candidate|profile|compact --operation smoke|warm|all-cold|cold|migration [--name NAME] [--rust-dsh-bin FILE] [--rust-perf-bin FILE]",
      );
    } else {
      await runBenchmark(options);
    }
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
