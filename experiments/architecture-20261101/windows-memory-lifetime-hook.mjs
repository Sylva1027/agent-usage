import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import path from "node:path";

// Diagnostic only: explicit --import survives the runner's removal of NODE_OPTIONS.
const directory = process.env.WINDOWS_MEMORY_DIAGNOSTIC_DIR;
const role = process.env.CODEX_USAGE_EXECUTOR_CHILD === "1" ? "executor" :
  /windows-stability-server\.mjs$/.test(process.argv[1] ?? "") ? "gateway" : "runner";
const startedAtMs = Date.now() - process.uptime() * 1000;
let sequence = 0;

export function memoryMark(event, details = {}) {
  if (!directory) return;
  appendFileSync(path.join(directory, `memory-${process.pid}.ndjson`), JSON.stringify({
    event, pid: process.pid, ppid: process.ppid, role, startedAtMs, atMs: Date.now(),
    ...details, memory: process.memoryUsage(), usage: process.resourceUsage(),
  }) + "\n");
}

export function memoryScopeId() { return `${process.pid}:${++sequence}`; }

export function instrumentMemory(url, input) {
  if (!/\/src\/history-backup\.js$/.test(url)) return input;
  let source = String(input).replaceAll("\r\n", "\n");
  const replace = (from, to) => {
    assert.equal(source.split(from).length, 2, `Memory diagnostic anchor changed: ${from}`);
    source = source.replace(from, to);
  };
  replace("  let resolveClose;", "  const memoryScope = wmScopeId(); wmMark('scope-open', {scopeId:memoryScope});\n  let resolveClose;");
  replace("Promise.allSettled(closing).then(() => resolveClose());",
    "Promise.allSettled(closing).then(() => {wmMark('scope-released',{scopeId:memoryScope,readers:closing.length});resolveClose();});");
  replace("  const close = () => {\n    if (!state.closed) {",
    "  const close = () => {\n    if (!state.closed) {\n      wmMark('scope-close-requested',{scopeId:memoryScope,active:state.active,readers:state.entries.size});");
  return source + `\nimport {memoryMark as wmMark,memoryScopeId as wmScopeId} from ${JSON.stringify(import.meta.url)};\n`;
}

if (directory) {
  assert.ok(path.isAbsolute(directory), "Memory diagnostic directory must be absolute");
  mkdirSync(directory, { recursive: true });
  memoryMark("process-start");
  process.once("exit", code => memoryMark("process-exit", { code }));
  if (role !== "runner") setInterval(() => memoryMark("tick"), 500).unref();
  registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    return { ...result, source: instrumentMemory(url, result.source) };
  } });
  if (role === "runner") {
    const spawn = childProcess.spawn;
    childProcess.spawn = function (command, args, options) {
      if (Array.isArray(args) && args.some(arg => /(?:^|[\\/])windows-stability-server\.mjs$/.test(arg))) {
        args = ["--import", import.meta.url, ...args];
      }
      return spawn.call(this, command, args, options);
    };
    syncBuiltinESMExports();
  }
}
