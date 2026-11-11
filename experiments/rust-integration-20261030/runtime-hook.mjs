import childProcess from "node:child_process";
import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";

const config = JSON.parse(fs.readFileSync(process.env.LOCAL_SUMMARY_CASE_CONFIG, "utf8"));
const now = () => Math.round(performance.timeOrigin + performance.now());
const tracked = new WeakSet();
const active = new Map();

if (!globalThis.__rustIntegrationHarnessHook) {
  if (!config.originalHookFile) {
    throw new Error("Experiment config must provide originalHookFile");
  }
  // The endurance hook supplies input/stat mapping, DatabaseSync interception,
  // fixed clock and loopback-only fetch behavior.
  await import(pathToFileURL(config.originalHookFile).href);

  const scratch = path.join(path.dirname(config.options.databaseFile), "snapshot-temp");
  fs.mkdirSync(scratch, {recursive: true});
  os.tmpdir = () => scratch;
  syncBuiltinESMExports();

  const eventFile = config.processEventFile;
  fs.mkdirSync(path.dirname(eventFile), {recursive: true});

  function append(event) {
    fs.appendFileSync(eventFile, `${JSON.stringify({at: now(), ownerPid: process.pid, ...event})}\n`);
  }

  function forward(event) {
    if (!process.connected || typeof process.send !== "function") return;
    try {
      process.send({type: "process-event", ...event}, () => {});
    } catch {
      // The lifecycle event is already durable in the shared append-only file.
    }
  }

  function classify(child) {
    const args = Array.isArray(child.spawnargs) ? child.spawnargs.map(String) : [];
    const executable = String(child.spawnfile || args[0] || "");
    if (args.some((arg) => /(?:^|[\\/])usage-executor\.js$/i.test(arg))) return "calculator";
    if (/node(?:\.exe)?$/i.test(executable) && args.some((arg) => /service\.mjs$/i.test(arg))) return "service";
    return "helper";
  }

  function isCalculatorSpawn(options) {
    const args = Array.isArray(options?.args) ? options.args.map(String) : [];
    return args.some((arg) => /(?:^|[\\/])usage-executor\.js$/i.test(arg));
  }

  function captureCalculatorStderr(options) {
    if (!config.calculatorStderrFile || !Array.isArray(options?.stdio) || !isCalculatorSpawn(options)) {
      return null;
    }
    const stdio = options.stdio.slice();
    if (stdio[2] !== "ignore") return null;
    stdio[2] = "pipe";
    return {...options, stdio};
  }

  function track(child) {
    if (!child || typeof child !== "object" || tracked.has(child)) return;
    tracked.add(child);
    active.set(child, true);

    let started = false;
    let ended = false;
    const start = () => {
      if (started || !Number.isInteger(child.pid)) return;
      started = true;
      const event = {
        action: "start",
        pid: child.pid,
        parentPid: process.pid,
        kind: classify(child),
        executable: child.spawnfile || child.spawnargs?.[0] || null,
        argv: Array.isArray(child.spawnargs) ? child.spawnargs : [],
      };
      append(event);
      forward(event);
    };
    const end = (code = null, signal = null) => {
      start();
      if (ended || !started) return;
      ended = true;
      active.delete(child);
      const event = {
        action: "end",
        pid: child.pid,
        parentPid: process.pid,
        kind: classify(child),
        exitCode: code,
        signal,
      };
      append(event);
      forward(event);
    };

    child.once("spawn", start);
    child.once("error", (error) => end(null, error?.code || "ERROR"));
    child.once("exit", (code, signal) => end(code, signal));
    child.once("close", (code, signal) => end(code, signal));
    child.on("message", (message) => {
      if (message?.type === "process-event") forward(message);
    });
    if (Number.isInteger(child.pid)) start();
  }

  // ChildProcess#spawn is the common path used by fork, spawn, exec and
  // execFile, so a helper spawned from the calculator is visible here.
  const nativeChildSpawn = childProcess.ChildProcess.prototype.spawn;
  childProcess.ChildProcess.prototype.spawn = function spawnWithTracking(options) {
    const capturedOptions = captureCalculatorStderr(options);
    const child = Reflect.apply(nativeChildSpawn, this, [capturedOptions || options]);
    track(this);
    if (capturedOptions) {
      fs.mkdirSync(path.dirname(config.calculatorStderrFile), {recursive: true});
      this.stderr?.on("data", (chunk) => {
        fs.appendFileSync(config.calculatorStderrFile, chunk);
        process.stderr.write(chunk);
      });
    }
    return child;
  };

  // Keep explicit wrappers as a fallback for Node variants that bypass the
  // prototype path. WeakSet deduplication prevents duplicate lifecycle rows.
  for (const name of ["fork", "spawn", "exec", "execFile"]) {
    const original = childProcess[name];
    childProcess[name] = function trackedChildProcess(...args) {
      const handlesBefore = new Set(process._getActiveHandles?.() || []);
      const result = Reflect.apply(original, this, args);
      for (const handle of process._getActiveHandles?.() || []) {
        if (!handlesBefore.has(handle) && handle?.constructor?.name === "ChildProcess") track(handle);
      }
      if (result?.constructor?.name === "ChildProcess") track(result);
      return result;
    };
  }
  syncBuiltinESMExports();

  process.once("exit", () => {
    for (const child of active.keys()) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Best effort when the owning process is already exiting.
      }
    }
  });
  globalThis.__rustIntegrationHarnessHook = true;
}
