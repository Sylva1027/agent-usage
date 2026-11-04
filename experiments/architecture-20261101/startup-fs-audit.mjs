import fs from "node:fs";
import fsp from "node:fs/promises";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import sqlite from "node:sqlite";
import { fileURLToPath } from "node:url";

const AUDIT_DIRECTORY = process.env.ARCH_STARTUP_FS_AUDIT_DIR
  ? path.resolve(process.env.ARCH_STARTUP_FS_AUDIT_DIR)
  : "";
const FLUSH_INTERVAL_MS = 250;
const STATE_SYMBOL = Symbol.for("architecture.startup.state");
const FILE_OPERATIONS = Object.freeze([
  { name: "stat", callback: "fs.stat", promise: "fs/promises.stat", sync: "fs.statSync" },
  { name: "readdir", callback: "fs.readdir", promise: "fs/promises.readdir", sync: "fs.readdirSync" },
  { name: "readFile", callback: "fs.readFile", promise: "fs/promises.readFile", sync: "fs.readFileSync" },
  { name: "open", callback: "fs.open", promise: "fs/promises.open", sync: "fs.openSync" },
]);

const seen = new Set();
const pending = [];
const auditedStreams = new WeakSet();
let auditFile = "";
let auditFd = null;
let auditInterval = null;
let closed = false;
let enabled = Boolean(AUDIT_DIRECTORY);

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizePath(value) {
  try {
    if (value instanceof URL) {
      return value.protocol === "file:" ? path.resolve(fileURLToPath(value)) : "";
    }
    if (Buffer.isBuffer(value)) value = value.toString();
    if (typeof value !== "string" || value === "" || value === ":memory:") return "";
    return path.resolve(value);
  } catch {
    return "";
  }
}

function logicalPathFor(filePath) {
  const state = globalThis[STATE_SYMBOL];
  if (!state?.logicalRoot || !state?.physicalRoot || !isWithin(state.physicalRoot, filePath)) return null;
  if (path.resolve(state.logicalRoot) === path.resolve(state.physicalRoot)) return null;
  return path.join(state.logicalRoot, path.relative(state.physicalRoot, filePath));
}

function errorCode(error) {
  return String(error?.code || error?.name || "ERROR");
}

function record(operation, target, status, error = null) {
  if (!enabled || closed) return;
  const filePath = normalizePath(target);
  if (!filePath) return;
  const logicalPath = logicalPathFor(filePath);
  const entry = {
    pid: process.pid,
    path: filePath,
    operation,
    status,
    ...(logicalPath && logicalPath !== filePath ? { logicalPath } : {}),
    ...(error ? { errorCode: errorCode(error) } : {}),
  };
  const key = `${operation}\0${status}\0${process.platform === "win32" ? filePath.toLowerCase() : filePath}`;
  if (seen.has(key)) return;
  seen.add(key);
  pending.push(`${JSON.stringify(entry)}\n`);
}

export function flushStartupFsAudit() {
  if (!enabled || auditFd === null || pending.length === 0) return;
  const payload = Buffer.from(pending.join(""));
  let offset = 0;
  try {
    while (offset < payload.length) {
      offset += writeSync(auditFd, payload, offset, payload.length - offset);
    }
    pending.length = 0;
  } catch {
    if (offset > 0) pending.splice(0, pending.length, payload.subarray(offset).toString());
  }
}

export function closeStartupFsAudit() {
  if (!enabled || closed) return auditFile;
  flushStartupFsAudit();
  closed = true;
  if (auditInterval) clearInterval(auditInterval);
  auditInterval = null;
  if (auditFd !== null) {
    try {
      closeSync(auditFd);
    } catch {
      // Audit write failures must not change application behavior.
    }
  }
  auditFd = null;
  return auditFile;
}

function getStartupFsAuditFile() {
  return auditFile;
}

function copyFunctionProperties(wrapped, original) {
  for (const key of Reflect.ownKeys(original)) {
    if (key === "name" || key === "length" || key === "prototype") continue;
    try {
      Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(original, key));
    } catch {
      // Preserve the callable even if a non-essential property cannot be copied.
    }
  }
  return wrapped;
}

function wrapPromise(original, operation) {
  const wrapped = function auditedPromiseOperation(...args) {
    try {
      const result = Reflect.apply(original, this, args);
      Promise.prototype.then.call(
        result,
        () => record(operation, args[0], "ok"),
        (error) => record(operation, args[0], "error", error),
      );
      return result;
    } catch (error) {
      record(operation, args[0], "error", error);
      throw error;
    }
  };
  return copyFunctionProperties(wrapped, original);
}

function wrapCallback(original, operation) {
  const wrapped = function auditedCallbackOperation(...args) {
    let callbackIndex = -1;
    for (let index = args.length - 1; index >= 0; index -= 1) {
      if (typeof args[index] === "function") {
        callbackIndex = index;
        break;
      }
    }
    if (callbackIndex === -1) {
      try {
        return Reflect.apply(original, this, args);
      } catch (error) {
        record(operation, args[0], "error", error);
        throw error;
      }
    }

    const callback = args[callbackIndex];
    const forwarded = args.slice();
    forwarded[callbackIndex] = function auditedCallback(...callbackArgs) {
      const error = callbackArgs[0];
      record(operation, args[0], error ? "error" : "ok", error);
      return Reflect.apply(callback, this, callbackArgs);
    };
    try {
      return Reflect.apply(original, this, forwarded);
    } catch (error) {
      record(operation, args[0], "error", error);
      throw error;
    }
  };
  return copyFunctionProperties(wrapped, original);
}

function wrapSync(original, operation) {
  const wrapped = function auditedSyncOperation(...args) {
    try {
      const result = Reflect.apply(original, this, args);
      record(operation, args[0], "ok");
      return result;
    } catch (error) {
      record(operation, args[0], "error", error);
      throw error;
    }
  };
  return copyFunctionProperties(wrapped, original);
}

function observeReadStream(stream, file) {
  if (!stream || typeof stream.emit !== "function" || auditedStreams.has(stream)) return stream;
  auditedStreams.add(stream);
  const originalEmit = stream.emit;
  stream.emit = function auditedReadStreamEmit(event, ...args) {
    if (event === "open") record("fs.createReadStream", file, "ok");
    if (event === "error") record("fs.createReadStream", file, "error", args[0]);
    return Reflect.apply(originalEmit, this, [event, ...args]);
  };
  return stream;
}

function wrapReadStream(original) {
  const wrapped = function auditedCreateReadStream(...args) {
    try {
      return observeReadStream(Reflect.apply(original, this, args), args[0]);
    } catch (error) {
      record("fs.createReadStream", args[0], "error", error);
      throw error;
    }
  };
  return copyFunctionProperties(wrapped, original);
}

function replaceFunction(target, name, wrapper) {
  if (!target || typeof target[name] !== "function") return;
  target[name] = wrapper(target[name]);
}

function installSqliteAudit() {
  const OriginalDatabaseSync = sqlite.DatabaseSync;
  const AuditedDatabaseSync = new Proxy(OriginalDatabaseSync, {
    construct(target, args, newTarget) {
      try {
        const database = Reflect.construct(target, args, newTarget);
        record("sqlite.DatabaseSync", args[0], "ok");
        return database;
      } catch (error) {
        record("sqlite.DatabaseSync", args[0], "error", error);
        throw error;
      }
    },
  });
  sqlite.DatabaseSync = AuditedDatabaseSync;

  // node:sqlite named exports do not follow syncBuiltinESMExports mutations.
  const shimSource = [
    'import sqlite from "node:sqlite";',
    "export const DatabaseSync = sqlite.DatabaseSync;",
    "export const StatementSync = sqlite.StatementSync;",
    "export const backup = sqlite.backup;",
    "export const constants = sqlite.constants;",
    "export default sqlite;",
  ].join("\n");
  const shimUrl = `data:text/javascript,${encodeURIComponent(shimSource)}`;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "node:sqlite" && context.parentURL !== shimUrl) {
        return { url: shimUrl, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}

function installFileAudit() {
  for (const operation of FILE_OPERATIONS) {
    replaceFunction(fs, operation.name, (original) => wrapCallback(original, operation.callback));
    replaceFunction(fs, `${operation.name}Sync`, (original) => wrapSync(original, operation.sync));
    replaceFunction(fsp, operation.name, (original) => wrapPromise(original, operation.promise));
    if (fs.promises !== fsp) {
      replaceFunction(fs.promises, operation.name, (original) => wrapPromise(original, operation.promise));
    }
  }
  replaceFunction(fs, "createReadStream", wrapReadStream);
  syncBuiltinESMExports();
}

if (enabled) {
  try {
    mkdirSync(AUDIT_DIRECTORY, { recursive: true, mode: 0o700 });
    auditFile = path.join(AUDIT_DIRECTORY, `startup-fs-audit-${process.pid}.ndjson`);
    auditFd = openSync(auditFile, "w", 0o600);
    installFileAudit();
    installSqliteAudit();
    auditInterval = setInterval(flushStartupFsAudit, FLUSH_INTERVAL_MS);
    auditInterval.unref();
    process.once("beforeExit", flushStartupFsAudit);
    process.once("exit", closeStartupFsAudit);
  } catch {
    enabled = false;
    if (auditFd !== null) {
      try {
        closeSync(auditFd);
      } catch {
        // Best-effort cleanup when audit initialization fails.
      }
    }
    auditFd = null;
  }
}

export { getStartupFsAuditFile };
