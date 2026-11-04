import fs from "node:fs";
import fsp from "node:fs/promises";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { Readable } from "node:stream";
import sqlite from "node:sqlite";
import { fileURLToPath } from "node:url";

const REPLAY_FILE = process.env.ARCH_STARTUP_REPLAY_FILE
  ? path.resolve(process.env.ARCH_STARTUP_REPLAY_FILE)
  : "";
const CAPTURE_SCHEMA = "codex-usage.startup-inputs-capture.v1";
const STATE_SYMBOL = Symbol.for("architecture.startup.state");
const reportRecords = [];
const reportSeen = new Set();
let replayModel = null;
let reportFile = "";
let reportClosed = false;

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

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function keyFor(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function errorWithCode(code, syscall, filePath, errorCode, errno = -1) {
  const suffix = filePath ? `, ${code === "ENOENT" ? "open" : syscall} '${filePath}'` : "";
  const error = new Error(`${code}: ${errorCode}${suffix}`);
  Object.assign(error, { code, errno, syscall, path: filePath });
  return error;
}

function enoent(filePath, syscall = "open") {
  return errorWithCode("ENOENT", syscall, filePath, "no such file or directory", -4058);
}

function accessDenied(filePath, syscall = "open") {
  return errorWithCode("EACCES", syscall, filePath, "permission denied", -4092);
}

function invalidEntry(options) {
  return Boolean(options && typeof options === "object" && options.throwIfNoEntry === false);
}

function callbackIndex(args) {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (typeof args[index] === "function") return index;
  }
  return -1;
}

function callbackLater(callback, error, value) {
  queueMicrotask(() => callback(error, value));
}

function promiseError(error) {
  return Promise.reject(error);
}

function copyFunctionProperties(wrapped, original) {
  for (const key of Reflect.ownKeys(original)) {
    if (key === "name" || key === "length" || key === "prototype" || key === "native") continue;
    try {
      Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(original, key));
    } catch {
      // Callable behavior matters more than optional function metadata.
    }
  }
  return wrapped;
}

function loadReplayModel(manifestFile) {
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  if (manifest?.schemaVersion !== CAPTURE_SCHEMA || !Array.isArray(manifest.files)) {
    throw new TypeError(`ARCH_STARTUP_REPLAY_FILE must reference ${CAPTURE_SCHEMA}`);
  }
  const captureDirectory = path.resolve(manifest.captureDirectory);
  const files = new Map();
  const sidecars = new Map();
  const roots = new Set();
  const knownDirectories = new Set();
  const listings = new Map();
  const missingPaths = new Set();
  const directoryStats = new Map();
  const captureDirectoryBase = statRecord(statSync(captureDirectory));

  for (const missingPath of manifest.missingPaths || []) {
    if (typeof missingPath === "string" && missingPath) missingPaths.add(keyFor(missingPath));
  }
  for (const [directoryPath, record] of Object.entries(manifest.directoryStats || {})) {
    if (directoryPath && record && typeof record === "object") {
      directoryStats.set(keyFor(directoryPath), record);
      knownDirectories.add(keyFor(directoryPath));
    }
  }

  for (const root of manifest.logicalRoots || []) {
    if (typeof root.path === "string" && root.path) roots.add(path.resolve(root.path));
  }
  for (const file of manifest.files) {
    const logicalPath = path.resolve(file.logicalPath);
    const capturedPath = path.resolve(captureDirectory, file.capturedPath);
    if (!isWithin(captureDirectory, capturedPath)) {
      throw Object.assign(new Error("capturedPath escapes captureDirectory"), { code: "CAPTURE_PATH_ESCAPE" });
    }
    roots.add(path.resolve(file.sourceHomePath));
    files.set(keyFor(logicalPath), {
      ...file,
      logicalPath,
      capturedPath,
      stat: file.sourceBefore,
    });
    if (file.storageType === "sqlite") {
      for (const suffix of ["-wal", "-shm"]) {
        const snapshot = file.sidecarsBefore?.[suffix.slice(1)];
        if (snapshot && !snapshot.error) {
          sidecars.set(keyFor(`${logicalPath}${suffix}`), {
            logicalPath: `${logicalPath}${suffix}`,
            main: files.get(keyFor(logicalPath)),
            stat: snapshot,
            type: "file",
          });
        }
      }
    }
  }

  function addListings(rows) {
    for (const root of rows || []) {
      for (const directory of root.directories || []) {
        if (typeof directory.logicalPath !== "string" || !Array.isArray(directory.entries)) continue;
        const directoryPath = path.resolve(directory.logicalPath);
        const current = listings.get(keyFor(directoryPath)) || { logicalPath: directoryPath };
        current.entries = directory.entries;
        listings.set(keyFor(directoryPath), current);
      }
    }
  }
  addListings(manifest.directoryListings?.before);
  addListings(manifest.directoryListings?.after);

  for (const file of files.values()) {
    let directory = path.dirname(file.logicalPath);
    while ([...roots].some((root) => isWithin(root, directory))) {
      knownDirectories.add(keyFor(directory));
      if ([...roots].some((root) => keyFor(root) === keyFor(directory))) break;
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  for (const directoryPath of listings.keys()) knownDirectories.add(directoryPath);
  for (const root of roots) knownDirectories.add(keyFor(root));

  const sortedRoots = [...roots].sort((left, right) => right.length - left.length);
  return {
    manifest,
    manifestFile,
    captureDirectory,
    files,
    sidecars,
    roots: sortedRoots,
    listings,
    knownDirectories,
    missingPaths,
    directoryStats,
    captureDirectoryBase,
    homeDir: manifest.discovery?.homeDir ? path.resolve(manifest.discovery.homeDir) : "",
  };
}

function statRecord(info) {
  return {
    size: Number(info.size),
    mtimeMs: Number(info.mtimeMs),
    atimeMs: Number(info.atimeMs),
    ctimeMs: Number(info.ctimeMs),
    birthtimeMs: Number(info.birthtimeMs),
    mode: Number(info.mode),
    dev: String(info.dev),
    ino: String(info.ino),
    nlink: Number(info.nlink),
  };
}

function sourceRootFor(filePath) {
  if (!replayModel) return "";
  return replayModel.roots.find((root) => isWithin(root, filePath)) || "";
}

function capturedFile(filePath) {
  return replayModel?.files.get(keyFor(filePath)) || null;
}

function sidecarFile(filePath) {
  return replayModel?.sidecars.get(keyFor(filePath)) || null;
}

function listingFor(directoryPath) {
  return replayModel?.listings.get(keyFor(directoryPath)) || null;
}

function listedEntry(filePath) {
  const listing = listingFor(path.dirname(filePath));
  if (!listing) return null;
  const name = path.basename(filePath);
  const wanted = process.platform === "win32" ? name.toLowerCase() : name;
  return listing.entries.find(
    (entry) => (process.platform === "win32" ? entry.name.toLowerCase() : entry.name) === wanted,
  ) || null;
}

function knownDirectory(directoryPath) {
  return Boolean(replayModel?.knownDirectories.has(keyFor(directoryPath)));
}

function classifyRead(filePath) {
  if (replayModel?.missingPaths.has(keyFor(filePath))) {
    return { type: "missing", reason: "manifest" };
  }
  const file = capturedFile(filePath);
  if (file) return { type: "captured", file };
  const sidecar = sidecarFile(filePath);
  if (sidecar) return { type: "sidecar", sidecar };
  if (knownDirectory(filePath) || listingFor(filePath)) return { type: "directory" };
  const entry = listedEntry(filePath);
  if (entry?.type === "directory") return { type: "directory", entry };
  if (!sourceRootFor(filePath)) return { type: "passthrough" };
  return { type: "uncaptured", entry };
}

function recordReplay(kind, operation, filePath, status = "ok", extra = {}) {
  if (!replayModel || reportClosed) return;
  const normalized = normalizePath(filePath) || String(filePath || "");
  const key = `${kind}\0${operation}\0${status}\0${pathKeyForRecord(normalized)}`;
  if (reportSeen.has(key)) return;
  reportSeen.add(key);
  reportRecords.push({
    pid: process.pid,
    kind,
    operation,
    path: normalized,
    status,
    ...extra,
  });
}

function recordUnavailable(classification, operation, filePath) {
  if (classification.type === "uncaptured") {
    recordReplay("uncapturedRead", operation, filePath, "error", { errorCode: "ENOENT" });
    if (classification.entry?.type === "symlink") {
      recordReplay("symlinkLimitation", operation, filePath, "warning", { frozenType: "symlink" });
    }
  } else if (classification.type === "missing" && classification.reason === "manifest") {
    recordReplay("manifestMissing", operation, filePath, "error", { errorCode: "ENOENT" });
  }
}

function pathKeyForRecord(filePath) {
  return process.platform === "win32" ? filePath.toLowerCase() : filePath;
}

export function flushStartupReplayReport() {
  if (!replayModel || !reportFile) return;
  const payload = {
    schemaVersion: "codex-usage.startup-replay-report.v1",
    pid: process.pid,
    captureManifest: replayModel.manifestFile,
    records: reportRecords,
  };
  try {
    writeFileSync(reportFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Replay reporting must not change application behavior after the mapping is installed.
  }
}

export function closeStartupReplayReport() {
  if (reportClosed) return reportFile;
  flushStartupReplayReport();
  reportClosed = true;
  return reportFile;
}

export function getStartupReplayReportFile() {
  return reportFile;
}

class ReplayStats {
  constructor(record, type, bigint = false) {
    const number = (value, fallback = 0) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : fallback;
    };
    const integer = (value) => (bigint ? BigInt(Math.trunc(number(value))) : Math.trunc(number(value)));
    this.dev = typeof record?.dev === "string" && bigint ? BigInt(record.dev) : integer(record?.dev);
    this.mode = integer(record?.mode ?? (type === "directory" ? 0o40755 : type === "symlink" ? 0o120777 : 0o100644));
    this.nlink = integer(record?.nlink ?? 1);
    this.uid = integer(record?.uid);
    this.gid = integer(record?.gid);
    this.rdev = integer(record?.rdev);
    this.blksize = integer(record?.blksize);
    this.ino =
      typeof record?.ino === "string" && bigint ? BigInt(record.ino) : integer(record?.ino);
    this.size = integer(record?.size);
    this.blocks = integer(record?.blocks ?? (type === "file" ? Math.ceil(number(record?.size) / 512) : 0));
    const atimeMs = number(record?.atimeMs);
    const mtimeMs = number(record?.mtimeMs);
    const ctimeMs = number(record?.ctimeMs);
    const birthtimeMs = number(record?.birthtimeMs);
    this.atimeMs = bigint ? BigInt(Math.trunc(atimeMs)) : atimeMs;
    this.mtimeMs = bigint ? BigInt(Math.trunc(mtimeMs)) : mtimeMs;
    this.ctimeMs = bigint ? BigInt(Math.trunc(ctimeMs)) : ctimeMs;
    this.birthtimeMs = bigint ? BigInt(Math.trunc(birthtimeMs)) : birthtimeMs;
    this.atime = new Date(atimeMs);
    this.mtime = new Date(mtimeMs);
    this.ctime = new Date(ctimeMs);
    this.birthtime = new Date(birthtimeMs);
    this._type = type;
  }
  isFile() {
    return this._type === "file";
  }
  isDirectory() {
    return this._type === "directory";
  }
  isSymbolicLink() {
    return this._type === "symlink";
  }
  isBlockDevice() {
    return false;
  }
  isCharacterDevice() {
    return false;
  }
  isFIFO() {
    return false;
  }
  isSocket() {
    return false;
  }
}

class ReplayDirent {
  constructor(name, type, parentPath, bufferName = false) {
    this.name = bufferName ? Buffer.from(name) : name;
    this.parentPath = parentPath;
    this.path = parentPath;
    this._type = type;
  }
  isFile() {
    return this._type === "file";
  }
  isDirectory() {
    return this._type === "directory";
  }
  isSymbolicLink() {
    return this._type === "symlink";
  }
  isBlockDevice() {
    return false;
  }
  isCharacterDevice() {
    return false;
  }
  isFIFO() {
    return false;
  }
  isSocket() {
    return false;
  }
}

function statOptions(args) {
  const options = args[args.length - 1];
  return options && typeof options === "object" && !Array.isArray(options) ? options : {};
}

function statsForClassification(classification, filePath, options = {}) {
  const bigint = options.bigint === true;
  if (classification.type === "captured") return new ReplayStats(classification.file.stat, "file", bigint);
  if (classification.type === "sidecar") return new ReplayStats(classification.sidecar.stat, "file", bigint);
  if (classification.type === "directory") {
    const overrides = replayModel.directoryStats.get(keyFor(filePath)) || null;
    return new ReplayStats(
      { ...replayModel.captureDirectoryBase, ...(overrides || {}), mode: overrides?.mode ?? 0o40755 },
      "directory",
      bigint,
    );
  }
  if (
    (classification.type === "missing" || classification.type === "uncaptured") &&
    invalidEntry(options)
  ) {
    if (classification.type === "uncaptured") {
      recordReplay("uncapturedRead", "stat", filePath, "error", { errorCode: "ENOENT" });
    }
    return undefined;
  }
  if (classification.type === "uncaptured") {
    recordReplay("uncapturedRead", "stat", filePath, "error", { errorCode: "ENOENT" });
    throw enoent(filePath, "stat");
  }
  if (classification.type === "missing") throw enoent(filePath, "stat");
  return null;
}

function wrapStatSync(original, operation) {
  const wrapped = function replayStatSync(file, ...args) {
    const filePath = normalizePath(file);
    if (!filePath) return Reflect.apply(original, this, [file, ...args]);
    const classification = classifyRead(filePath);
    const synthetic = statsForClassification(classification, filePath, statOptions(args));
    if (synthetic !== null) return synthetic;
    try {
      const result = Reflect.apply(original, this, [file, ...args]);
      recordReplay("fallback", operation, filePath);
      return result;
    } catch (error) {
      recordReplay("fallbackMiss", operation, filePath, "error", { errorCode: String(error?.code || "ERROR") });
      throw error;
    }
  };
  return copyFunctionProperties(wrapped, original);
}

function wrapStatPromise(original, operation) {
  const wrapped = function replayStatPromise(file, ...args) {
    const filePath = normalizePath(file);
    if (!filePath) return Reflect.apply(original, this, [file, ...args]);
    try {
      const synthetic = statsForClassification(classifyRead(filePath), filePath, statOptions(args));
      if (synthetic !== null) return Promise.resolve(synthetic);
    } catch (error) {
      return promiseError(error);
    }
    return Promise.resolve(Reflect.apply(original, this, [file, ...args])).then(
      (result) => {
        recordReplay("fallback", operation, filePath);
        return result;
      },
      (error) => {
        recordReplay("fallbackMiss", operation, filePath, "error", { errorCode: String(error?.code || "ERROR") });
        throw error;
      },
    );
  };
  return copyFunctionProperties(wrapped, original);
}

function wrapStatCallback(original, operation) {
  const wrapped = function replayStatCallback(file, ...args) {
    const filePath = normalizePath(file);
    const index = callbackIndex(args);
    if (!filePath || index === -1) return Reflect.apply(original, this, [file, ...args]);
    const callback = args[index];
    try {
      const synthetic = statsForClassification(classifyRead(filePath), filePath, statOptions(args.slice(0, index)));
      if (synthetic !== null) {
        callbackLater(callback, null, synthetic);
        return;
      }
    } catch (error) {
      callbackLater(callback, error);
      return;
    }
    const forwarded = args.slice();
    forwarded[index] = function replayStatResult(error, value) {
      recordReplay(
        error ? "fallbackMiss" : "fallback",
        operation,
        filePath,
        error ? "error" : "ok",
        error ? { errorCode: String(error.code || "ERROR") } : {},
      );
      return Reflect.apply(callback, this, [error, value]);
    };
    return Reflect.apply(original, this, [file, ...forwarded]);
  };
  return copyFunctionProperties(wrapped, original);
}

function installStatReplay(name) {
  const syncOperation = `fs.${name}Sync`;
  const promiseOperation = `fs/promises.${name}`;
  const callbackOperation = `fs.${name}`;
  if (typeof fs[`${name}Sync`] === "function") {
    fs[`${name}Sync`] = wrapStatSync(fs[`${name}Sync`], syncOperation);
  }
  if (typeof fsp[name] === "function") fsp[name] = wrapStatPromise(fsp[name], promiseOperation);
  if (typeof fs[name] === "function") fs[name] = wrapStatCallback(fs[name], callbackOperation);
}

function directoryEntries(directoryPath, options = {}) {
  const listing = listingFor(directoryPath);
  if (!listing) return null;
  const withFileTypes = options.withFileTypes === true;
  const bufferNames = options.encoding === "buffer";
  return listing.entries.map((entry) =>
    withFileTypes
      ? new ReplayDirent(entry.name, entry.type, directoryPath, bufferNames)
      : bufferNames
        ? Buffer.from(entry.name)
        : entry.name,
  );
}

function readdirOptions(args) {
  const candidate = args[args.length - 1];
  return typeof candidate === "string" || (candidate && typeof candidate === "object" && !Array.isArray(candidate))
    ? candidate
    : {};
}

function wrapReaddirSync(original) {
  const wrapped = function replayReaddirSync(directory, ...args) {
    const directoryPath = normalizePath(directory);
    if (!directoryPath) return Reflect.apply(original, this, [directory, ...args]);
    if (replayModel.missingPaths.has(keyFor(directoryPath))) throw enoent(directoryPath, "scandir");
    const frozen = directoryEntries(directoryPath, readdirOptions(args));
    if (frozen) return frozen;
    if (!sourceRootFor(directoryPath) && !isWithin(replayModel.homeDir || directoryPath, directoryPath)) {
      return Reflect.apply(original, this, [directory, ...args]);
    }
    try {
      const result = Reflect.apply(original, this, [directory, ...args]);
      recordReplay("directoryFallback", "fs.readdirSync", directoryPath);
      return result;
    } catch (error) {
      recordReplay("directoryFallbackMiss", "fs.readdirSync", directoryPath, "error", {
        errorCode: String(error?.code || "ERROR"),
      });
      throw error;
    }
  };
  return copyFunctionProperties(wrapped, original);
}

function wrapReaddirPromise(original) {
  const wrapped = function replayReaddirPromise(directory, ...args) {
    const directoryPath = normalizePath(directory);
    if (!directoryPath) return Reflect.apply(original, this, [directory, ...args]);
    if (replayModel.missingPaths.has(keyFor(directoryPath))) {
      return promiseError(enoent(directoryPath, "scandir"));
    }
    const frozen = directoryEntries(directoryPath, readdirOptions(args));
    if (frozen) return Promise.resolve(frozen);
    if (!sourceRootFor(directoryPath) && !isWithin(replayModel.homeDir || directoryPath, directoryPath)) {
      return Reflect.apply(original, this, [directory, ...args]);
    }
    return Promise.resolve(Reflect.apply(original, this, [directory, ...args])).then(
      (result) => {
        recordReplay("directoryFallback", "fs/promises.readdir", directoryPath);
        return result;
      },
      (error) => {
        recordReplay("directoryFallbackMiss", "fs/promises.readdir", directoryPath, "error", {
          errorCode: String(error?.code || "ERROR"),
        });
        throw error;
      },
    );
  };
  return copyFunctionProperties(wrapped, original);
}

function wrapReaddirCallback(original) {
  const wrapped = function replayReaddirCallback(directory, ...args) {
    const directoryPath = normalizePath(directory);
    const index = callbackIndex(args);
    if (!directoryPath || index === -1) return Reflect.apply(original, this, [directory, ...args]);
    const callback = args[index];
    if (replayModel.missingPaths.has(keyFor(directoryPath))) {
      callbackLater(callback, enoent(directoryPath, "scandir"));
      return;
    }
    const frozen = directoryEntries(directoryPath, readdirOptions(args.slice(0, index)));
    if (frozen) {
      callbackLater(callback, null, frozen);
      return;
    }
    if (!sourceRootFor(directoryPath) && !isWithin(replayModel.homeDir || directoryPath, directoryPath)) {
      return Reflect.apply(original, this, [directory, ...args]);
    }
    const forwarded = args.slice();
    forwarded[index] = function replayReaddirResult(error, value) {
      recordReplay(
        error ? "directoryFallbackMiss" : "directoryFallback",
        "fs.readdir",
        directoryPath,
        error ? "error" : "ok",
        error ? { errorCode: String(error.code || "ERROR") } : {},
      );
      return Reflect.apply(callback, this, [error, value]);
    };
    return Reflect.apply(original, this, [directory, ...forwarded]);
  };
  return copyFunctionProperties(wrapped, original);
}

function installReaddirReplay() {
  fs.readdirSync = wrapReaddirSync(fs.readdirSync);
  fsp.readdir = wrapReaddirPromise(fsp.readdir);
  fs.readdir = wrapReaddirCallback(fs.readdir);
}

function wrapReadFileSync(original) {
  const wrapped = function replayReadFileSync(file, ...args) {
    const filePath = normalizePath(file);
    if (!filePath) return Reflect.apply(original, this, [file, ...args]);
    const classification = classifyRead(filePath);
    if (classification.type === "captured") return Reflect.apply(original, this, [classification.file.capturedPath, ...args]);
    if (classification.type === "uncaptured") {
      recordUnavailable(classification, "fs.readFileSync", filePath);
      throw enoent(filePath, "open");
    }
    if (classification.type === "missing") {
      recordUnavailable(classification, "fs.readFileSync", filePath);
      throw enoent(filePath, "open");
    }
    if (classification.type === "sidecar") throw enoent(filePath, "open");
    try {
      const result = Reflect.apply(original, this, [file, ...args]);
      if (classification.type === "fallback") recordReplay("fallback", "fs.readFileSync", filePath);
      return result;
    } catch (error) {
      if (classification.type === "fallback") {
        recordReplay("fallbackMiss", "fs.readFileSync", filePath, "error", {
          errorCode: String(error?.code || "ERROR"),
        });
      }
      throw error;
    }
  };
  return copyFunctionProperties(wrapped, original);
}

function wrapReadFilePromise(original) {
  const wrapped = function replayReadFilePromise(file, ...args) {
    const filePath = normalizePath(file);
    if (!filePath) return Reflect.apply(original, this, [file, ...args]);
    const classification = classifyRead(filePath);
    if (classification.type === "captured") {
      return Reflect.apply(original, this, [classification.file.capturedPath, ...args]);
    }
    if (classification.type === "uncaptured") {
      recordUnavailable(classification, "fs/promises.readFile", filePath);
      return promiseError(enoent(filePath, "open"));
    }
    if (classification.type === "missing") {
      recordUnavailable(classification, "fs/promises.readFile", filePath);
      return promiseError(enoent(filePath, "open"));
    }
    if (classification.type === "sidecar") return promiseError(enoent(filePath, "open"));
    return Promise.resolve(Reflect.apply(original, this, [file, ...args])).then(
      (result) => {
        if (classification.type === "fallback") recordReplay("fallback", "fs/promises.readFile", filePath);
        return result;
      },
      (error) => {
        if (classification.type === "fallback") {
          recordReplay("fallbackMiss", "fs/promises.readFile", filePath, "error", {
            errorCode: String(error?.code || "ERROR"),
          });
        }
        throw error;
      },
    );
  };
  return copyFunctionProperties(wrapped, original);
}

function wrapReadFileCallback(original) {
  const wrapped = function replayReadFileCallback(file, ...args) {
    const filePath = normalizePath(file);
    const index = callbackIndex(args);
    if (!filePath || index === -1) return Reflect.apply(original, this, [file, ...args]);
    const callback = args[index];
    const classification = classifyRead(filePath);
    if (classification.type === "captured") {
      return Reflect.apply(original, this, [classification.file.capturedPath, ...args]);
    }
    if (classification.type === "uncaptured") {
      recordUnavailable(classification, "fs.readFile", filePath);
      callbackLater(callback, enoent(filePath, "open"));
      return;
    }
    if (classification.type === "missing") {
      recordUnavailable(classification, "fs.readFile", filePath);
      callbackLater(callback, enoent(filePath, "open"));
      return;
    }
    if (classification.type === "sidecar") {
      callbackLater(callback, enoent(filePath, "open"));
      return;
    }
    const forwarded = args.slice();
    forwarded[index] = function replayReadFileResult(error, value) {
      if (classification.type === "fallback") {
        recordReplay(
          error ? "fallbackMiss" : "fallback",
          "fs.readFile",
          filePath,
          error ? "error" : "ok",
          error ? { errorCode: String(error.code || "ERROR") } : {},
        );
      }
      return Reflect.apply(callback, this, [error, value]);
    };
    return Reflect.apply(original, this, [file, ...forwarded]);
  };
  return copyFunctionProperties(wrapped, original);
}

function installReadFileReplay() {
  fs.readFileSync = wrapReadFileSync(fs.readFileSync);
  fsp.readFile = wrapReadFilePromise(fsp.readFile);
  fs.readFile = wrapReadFileCallback(fs.readFile);
}

function flagsWrite(flags) {
  if (typeof flags === "number") {
    const constants = fs.constants;
    return Boolean(
      flags &
        (constants.O_WRONLY |
          constants.O_RDWR |
          constants.O_CREAT |
          constants.O_TRUNC |
          constants.O_APPEND |
          constants.O_EXCL),
    );
  }
  return typeof flags === "string" && flags.includes("+") || /[wa]/.test(String(flags || ""));
}

function mappedOpenArgument(file, flags, write) {
  const filePath = normalizePath(file);
  if (!filePath) return { file };
  const classification = classifyRead(filePath);
  if (classification.type === "captured") {
    if (write) throw accessDenied(filePath, "open");
    return { file: classification.file.capturedPath, classification, filePath };
  }
  if (classification.type === "uncaptured") {
    recordUnavailable(classification, "fs.open", filePath);
    throw enoent(filePath, "open");
  }
  if (classification.type === "missing" || classification.type === "sidecar") {
    recordUnavailable(classification, "fs.open", filePath);
    throw enoent(filePath, "open");
  }
  return { file, classification, filePath };
}

function wrapOpenSync(original) {
  const wrapped = function replayOpenSync(file, flags = "r", ...args) {
    const mapped = mappedOpenArgument(file, flags, flagsWrite(flags));
    const result = Reflect.apply(original, this, [mapped.file, flags, ...args]);
    if (mapped.classification?.type === "fallback") recordReplay("fallback", "fs.openSync", mapped.filePath);
    return result;
  };
  return copyFunctionProperties(wrapped, original);
}

function wrapOpenPromise(original) {
  const wrapped = function replayOpenPromise(file, flags = "r", ...args) {
    let mapped;
    try {
      mapped = mappedOpenArgument(file, flags, flagsWrite(flags));
      return Promise.resolve(Reflect.apply(original, this, [mapped.file, flags, ...args])).then(
        (result) => {
          if (mapped.classification?.type === "fallback") recordReplay("fallback", "fs/promises.open", mapped.filePath);
          return result;
        },
      );
    } catch (error) {
      return promiseError(error);
    }
  };
  return copyFunctionProperties(wrapped, original);
}

function wrapOpenCallback(original) {
  const wrapped = function replayOpenCallback(file, flags = "r", ...args) {
    const index = callbackIndex(args);
    if (index === -1) return Reflect.apply(original, this, [file, flags, ...args]);
    const callback = args[index];
    let mapped;
    try {
      mapped = mappedOpenArgument(file, flags, flagsWrite(flags));
    } catch (error) {
      callbackLater(callback, error);
      return;
    }
    const forwarded = args.slice();
    forwarded[index] = function replayOpenResult(error, fd) {
      if (!error && mapped.classification?.type === "fallback") recordReplay("fallback", "fs.open", mapped.filePath);
      return Reflect.apply(callback, this, [error, fd]);
    };
    return Reflect.apply(original, this, [mapped.file, flags, ...forwarded]);
  };
  return copyFunctionProperties(wrapped, original);
}

function installOpenReplay() {
  fs.openSync = wrapOpenSync(fs.openSync);
  fsp.open = wrapOpenPromise(fsp.open);
  fs.open = wrapOpenCallback(fs.open);
}

function wrapCreateReadStream(original) {
  const wrapped = function replayCreateReadStream(file, ...args) {
    const filePath = normalizePath(file);
    if (!filePath) return Reflect.apply(original, this, [file, ...args]);
    const classification = classifyRead(filePath);
    if (classification.type === "captured") return Reflect.apply(original, this, [classification.file.capturedPath, ...args]);
    if (classification.type === "missing" || classification.type === "sidecar" || classification.type === "uncaptured") {
      recordUnavailable(classification, "fs.createReadStream", filePath);
      recordReplay(
        classification.type === "uncaptured" ? "uncapturedRead" : "missing",
        "fs.createReadStream",
        filePath,
        "error",
        { errorCode: "ENOENT" },
      );
      return new Readable({
        read() {
          this.destroy(enoent(filePath, "open"));
        },
      });
    }
    if (classification.type === "fallback") recordReplay("fallback", "fs.createReadStream", filePath);
    return Reflect.apply(original, this, [file, ...args]);
  };
  return copyFunctionProperties(wrapped, original);
}

function encodingResult(filePath, encoding) {
  return encoding === "buffer" ? Buffer.from(filePath) : filePath;
}

function wrapRealpathSync(original) {
  const wrapped = function replayRealpathSync(file, options) {
    const filePath = normalizePath(file);
    if (!filePath) return Reflect.apply(original, this, [file, options]);
    const classification = classifyRead(filePath);
    if (classification.type === "captured" || classification.type === "sidecar" || classification.type === "directory") {
      return encodingResult(filePath, typeof options === "string" ? options : options?.encoding);
    }
    if (classification.type === "uncaptured") {
      recordUnavailable(classification, "fs.realpathSync", filePath);
      throw enoent(filePath, "realpath");
    }
    if (classification.type === "missing") {
      recordUnavailable(classification, "fs.realpathSync", filePath);
      throw enoent(filePath, "realpath");
    }
    try {
      const result = Reflect.apply(original, this, [file, options]);
      recordReplay("fallback", "fs.realpathSync", filePath);
      if (classification.entry?.type === "symlink") {
        recordReplay("symlinkLimitation", "fs.realpathSync", filePath, "warning", {
          frozenType: "symlink",
        });
      }
      return result;
    } catch (error) {
      recordReplay("fallbackMiss", "fs.realpathSync", filePath, "error", {
        errorCode: String(error?.code || "ERROR"),
      });
      throw error;
    }
  };
  const wrappedNative = original.native
    ? copyFunctionProperties(function replayRealpathNativeSync(file, options) {
        return Reflect.apply(wrapped, factReplayThis(this), [file, options]);
      }, original.native)
    : undefined;
  wrappedNative && (wrapped.native = wrappedNative);
  return copyFunctionProperties(wrapped, original);
}

function factReplayThis(value) {
  return value;
}

function wrapRealpathPromise(original) {
  const wrapped = function replayRealpathPromise(file, options) {
    const filePath = normalizePath(file);
    if (!filePath) return Reflect.apply(original, this, [file, options]);
    const classification = classifyRead(filePath);
    if (classification.type === "captured" || classification.type === "sidecar" || classification.type === "directory") {
      return Promise.resolve(encodingResult(filePath, options));
    }
    if (classification.type === "uncaptured") {
      recordUnavailable(classification, "fs/promises.realpath", filePath);
      return promiseError(enoent(filePath, "realpath"));
    }
    if (classification.type === "missing") {
      recordUnavailable(classification, "fs/promises.realpath", filePath);
      return promiseError(enoent(filePath, "realpath"));
    }
    return Promise.resolve(Reflect.apply(original, this, [file, options])).then(
      (result) => {
        recordReplay("fallback", "fs/promises.realpath", filePath);
        if (classification.entry?.type === "symlink") {
          recordReplay("symlinkLimitation", "fs/promises.realpath", filePath, "warning", {
            frozenType: "symlink",
          });
        }
        return result;
      },
      (error) => {
        recordReplay("fallbackMiss", "fs/promises.realpath", filePath, "error", {
          errorCode: String(error?.code || "ERROR"),
        });
        throw error;
      },
    );
  };
  return copyFunctionProperties(wrapped, original);
}

function wrapRealpathCallback(original) {
  const wrapped = function replayRealpathCallback(file, ...args) {
    const filePath = normalizePath(file);
    const index = callbackIndex(args);
    if (!filePath || index === -1) return Reflect.apply(original, this, [file, ...args]);
    const callback = args[index];
    const classification = classifyRead(filePath);
    const options = args.slice(0, index)[0];
    if (classification.type === "captured" || classification.type === "sidecar" || classification.type === "directory") {
      callbackLater(callback, null, encodingResult(filePath, options));
      return;
    }
    if (classification.type === "uncaptured") {
      recordUnavailable(classification, "fs.realpath", filePath);
      callbackLater(callback, enoent(filePath, "realpath"));
      return;
    }
    if (classification.type === "missing") {
      recordUnavailable(classification, "fs.realpath", filePath);
      callbackLater(callback, enoent(filePath, "realpath"));
      return;
    }
    const forwarded = args.slice();
    forwarded[index] = function replayRealpathResult(error, value) {
      recordReplay(
        error ? "fallbackMiss" : "fallback",
        "fs.realpath",
        filePath,
        error ? "error" : "ok",
        error ? { errorCode: String(error.code || "ERROR") } : {},
      );
      if (!error && classification.entry?.type === "symlink") {
        recordReplay("symlinkLimitation", "fs.realpath", filePath, "warning", { frozenType: "symlink" });
      }
      return Reflect.apply(callback, this, [error, value]);
    };
    return Reflect.apply(original, this, [file, ...forwarded]);
  };
  return copyFunctionProperties(wrapped, original);
}

function installRealpathReplay() {
  fs.realpathSync = wrapRealpathSync(fs.realpathSync);
  fsp.realpath = wrapRealpathPromise(fsp.realpath);
  const callback = wrapRealpathCallback(fs.realpath);
  fs.realpath = callback;
}

function deniedPath(filePath) {
  return Boolean(capturedFile(filePath) || sidecarFile(filePath));
}

function checkWritePaths(args, positions) {
  for (const position of positions) {
    const filePath = normalizePath(args[position]);
    if (filePath && deniedPath(filePath)) {
      recordReplay("deniedWrite", "write", filePath, "error", { errorCode: "EACCES" });
      throw accessDenied(filePath, "open");
    }
  }
}

function wrapDeniedSync(original, positions, operation) {
  const wrapped = function replayDeniedSync(...args) {
    checkWritePaths(args, positions);
    return Reflect.apply(original, this, args);
  };
  return copyFunctionProperties(wrapped, original);
}

function wrapDeniedPromise(original, positions, operation) {
  const wrapped = function replayDeniedPromise(...args) {
    try {
      checkWritePaths(args, positions);
      return Reflect.apply(original, this, args);
    } catch (error) {
      return promiseError(error);
    }
  };
  return copyFunctionProperties(wrapped, original);
}

function wrapDeniedCallback(original, positions, operation) {
  const wrapped = function replayDeniedCallback(...args) {
    const index = callbackIndex(args);
    try {
      checkWritePaths(args, positions);
    } catch (error) {
      if (index === -1) throw error;
      callbackLater(args[index], error);
      return;
    }
    return Reflect.apply(original, this, args);
  };
  return copyFunctionProperties(wrapped, original);
}

function wrapDeniedStream(original, positions) {
  return copyFunctionProperties(function replayDeniedStream(...args) {
    checkWritePaths(args, positions);
    return Reflect.apply(original, this, args);
  }, original);
}

function installWriteDenial() {
  const single = ["writeFile", "appendFile", "truncate", "unlink", "rm", "rmdir", "mkdir", "chmod", "chown", "utimes", "lutimes"];
  const dual = ["copyFile", "cp", "rename", "link", "symlink"];
  for (const name of single) {
    if (typeof fs[name] === "function") fs[name] = wrapDeniedCallback(fs[name], [0], name);
    if (typeof fsp[name] === "function") fsp[name] = wrapDeniedPromise(fsp[name], [0], name);
    if (typeof fs[`${name}Sync`] === "function") {
      fs[`${name}Sync`] = wrapDeniedSync(fs[`${name}Sync`], [0], name);
    }
  }
  for (const name of dual) {
    if (typeof fs[name] === "function") fs[name] = wrapDeniedCallback(fs[name], [0, 1], name);
    if (typeof fsp[name] === "function") fsp[name] = wrapDeniedPromise(fsp[name], [0, 1], name);
    if (typeof fs[`${name}Sync`] === "function") fs[`${name}Sync`] = wrapDeniedSync(fs[`${name}Sync`], [0, 1], name);
  }
  if (typeof fs.createWriteStream === "function") {
    fs.createWriteStream = wrapDeniedStream(fs.createWriteStream, [0]);
  }
}

function installReadStreamReplay() {
  fs.createReadStream = wrapCreateReadStream(fs.createReadStream);
}

function forceReadOnly(options) {
  return {
    ...(options && typeof options === "object" ? options : {}),
    readOnly: true,
  };
}

function installSqliteReplay() {
  const OriginalDatabaseSync = sqlite.DatabaseSync;
  const ReplayDatabaseSync = new Proxy(OriginalDatabaseSync, {
    construct(target, args, newTarget) {
      const filePath = normalizePath(args[0]);
      if (!filePath) return Reflect.construct(target, args, newTarget);
      const classification = classifyRead(filePath);
      if (classification.type === "captured") {
        return Reflect.construct(
          target,
          [classification.file.capturedPath, forceReadOnly(args[1]), ...args.slice(2)],
          newTarget,
        );
      }
      if (classification.type === "uncaptured") {
        recordUnavailable(classification, "sqlite.DatabaseSync", filePath);
        throw enoent(filePath, "open");
      }
      if (classification.type === "sidecar" || classification.type === "missing") {
        recordUnavailable(classification, "sqlite.DatabaseSync", filePath);
        throw enoent(filePath, "open");
      }
      return Reflect.construct(target, args, newTarget);
    },
  });
  sqlite.DatabaseSync = ReplayDatabaseSync;

  const originalBackup = sqlite.backup;
  sqlite.backup = function replayBackup(database, file, ...args) {
    const filePath = normalizePath(file);
    if (filePath && deniedPath(filePath)) throw accessDenied(filePath, "open");
    return Reflect.apply(originalBackup, this, [database, file, ...args]);
  };

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

if (REPLAY_FILE) {
  replayModel = loadReplayModel(REPLAY_FILE);
  reportFile = path.join(replayModel.captureDirectory, `replay-${process.pid}.json`);
  installStatReplay("stat");
  installStatReplay("lstat");
  installReaddirReplay();
  installReadFileReplay();
  installOpenReplay();
  installReadStreamReplay();
  installRealpathReplay();
  installWriteDenial();
  installSqliteReplay();
  syncBuiltinESMExports();
  process.once("beforeExit", flushStartupReplayReport);
  process.once("exit", closeStartupReplayReport);
}
