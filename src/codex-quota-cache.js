import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const FORMAT_VERSION = 1;
const RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const OFFICIAL_READ_TIMEOUT_MS = 30 * 1000;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const QUOTA_SOURCE_PATH = "codex-quota.json";
const QUOTA_WINDOW_MINUTES = new Set([300, 10_080]);
const recoveryFlights = new Map();

/** @param {any} [options] */
export function codexQuotaFile(options = {}) {
  return options.codexQuotaFile || path.join(options.homeDir || os.homedir(), ".codex-usage", "codex-quota.json");
}

function emptyCache() {
  return { formatVersion: FORMAT_VERSION, lastAttemptAtMs: 0, snapshots: [], recoveryEnabled: false };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeWindow(raw) {
  if (!isRecord(raw)) throw new TypeError("quota window must be an object");
  const windowDurationMins = Number(raw.windowDurationMins);
  const resetsAt = Number(raw.resetsAt);
  const usedPercent = raw.usedPercent === null || raw.usedPercent === undefined ? null : Number(raw.usedPercent);
  if (!Number.isFinite(windowDurationMins) || windowDurationMins <= 0) {
    throw new TypeError("windowDurationMins must be positive");
  }
  if (!Number.isFinite(resetsAt) || resetsAt <= 0) throw new TypeError("resetsAt must be positive");
  if (usedPercent !== null && (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100)) {
    throw new TypeError("usedPercent must be between 0 and 100");
  }
  return { usedPercent, windowDurationMins, resetsAt };
}

function normalizeSnapshot(raw, fallbackObservedAtMs) {
  if (!isRecord(raw)) throw new TypeError("quota snapshot must be an object");
  const observedAtMs =
    raw.observedAtMs === undefined || raw.observedAtMs === null ? fallbackObservedAtMs : Number(raw.observedAtMs);
  if (!Number.isFinite(observedAtMs) || observedAtMs < 0) throw new TypeError("observedAtMs must be valid");
  if (!isRecord(raw.rateLimitsByLimitId)) throw new TypeError("rateLimitsByLimitId must be an object");

  const rateLimitsByLimitId = {};
  let firstPlanType = null;
  for (const [key, rawBucket] of Object.entries(raw.rateLimitsByLimitId)) {
    if (!isRecord(rawBucket)) throw new TypeError("quota bucket must be an object");
    const limitId = optionalString(rawBucket.limitId) || optionalString(key);
    if (!limitId) throw new TypeError("quota bucket limitId is missing");
    const bucketPlanType = optionalString(rawBucket.planType);
    firstPlanType ||= bucketPlanType;
    const primary =
      rawBucket.primary === null || rawBucket.primary === undefined ? null : normalizeWindow(rawBucket.primary);
    const secondary =
      rawBucket.secondary === null || rawBucket.secondary === undefined ? null : normalizeWindow(rawBucket.secondary);
    if (!primary && !secondary) continue;
    rateLimitsByLimitId[limitId] = { limitId, planType: bucketPlanType, primary, secondary };
  }
  if (!Object.keys(rateLimitsByLimitId).length) throw new TypeError("quota snapshot has no usable windows");

  return {
    observedAtMs,
    accountFingerprint: optionalString(raw.accountFingerprint),
    planType: optionalString(raw.planType) || firstPlanType,
    rateLimitsByLimitId,
  };
}

function normalizeCache(raw) {
  if (
    !isRecord(raw) ||
    raw.formatVersion !== FORMAT_VERSION ||
    !Array.isArray(raw.snapshots) ||
    !Number.isFinite(Number(raw.lastAttemptAtMs)) ||
    Number(raw.lastAttemptAtMs) < 0
  ) {
    return emptyCache();
  }
  try {
    const snapshots = raw.snapshots.map((snapshot) => normalizeSnapshot(snapshot, null));
    return {
      formatVersion: FORMAT_VERSION,
      lastAttemptAtMs: Number(raw.lastAttemptAtMs),
      snapshots,
      recoveryEnabled: raw.recoveryEnabled === true,
    };
  } catch {
    return emptyCache();
  }
}

/** @param {any} [options] */
export function readCodexQuotaCache(options = {}) {
  try {
    return normalizeCache(JSON.parse(readFileSync(codexQuotaFile(options), "utf8")));
  } catch {
    return emptyCache();
  }
}

/** @param {any} cache */
export function quotaCacheObservations(cache) {
  const normalized = normalizeCache(cache);
  const observations = [];
  normalized.snapshots.forEach((snapshot, snapshotIndex) => {
    for (const bucket of Object.values(snapshot.rateLimitsByLimitId)) {
      for (const role of ["primary", "secondary"]) {
        const window = bucket[role];
        if (!window || !QUOTA_WINDOW_MINUTES.has(window.windowDurationMins)) continue;
        observations.push({
          sourcePath: `${QUOTA_SOURCE_PATH}#${snapshot.accountFingerprint || "unknown"}:${bucket.limitId}`,
          lineNumber: snapshotIndex + 1,
          role,
          observedAtMs: snapshot.observedAtMs,
          limitId: bucket.limitId,
          limitName: null,
          planType: snapshot.planType,
          windowMinutes: window.windowDurationMins,
          resetsAtMs: window.resetsAt * 1000,
          usedPercent: window.usedPercent,
        });
      }
    }
  });
  return observations;
}

/** @param {any} [options] */
export function readCodexQuotaObservations(options = {}) {
  if (Array.isArray(options.homes)) {
    const expectedMainHome = path.resolve(options.homeDir || os.homedir(), ".codex");
    const hasMainHome = options.homes.some(
      (home) => home?.kind === "main" && typeof home.path === "string" && path.resolve(home.path) === expectedMainHome,
    );
    if (!hasMainHome) return [];
  }
  return quotaCacheObservations(readCodexQuotaCache(options));
}

function nowMs(options) {
  const value = typeof options.quotaNow === "function" ? options.quotaNow() : options.quotaNow;
  const valueMs =
    value === undefined
      ? Date.now()
      : value instanceof Date
        ? value.getTime()
        : typeof value === "number"
          ? value
          : Date.parse(value);
  if (!Number.isFinite(valueMs)) throw new RangeError("quotaNow must be a valid date or timestamp");
  return valueMs;
}

function snapshotContentKey(snapshot) {
  return JSON.stringify({
    accountFingerprint: snapshot.accountFingerprint,
    planType: snapshot.planType,
    rateLimitsByLimitId: snapshot.rateLimitsByLimitId,
  });
}

function latestSnapshot(cache, atMs) {
  let latest = null;
  for (const snapshot of cache.snapshots) {
    if (snapshot.observedAtMs <= atMs && (!latest || snapshot.observedAtMs >= latest.observedAtMs)) {
      latest = snapshot;
    }
  }
  return latest;
}

function snapshotSuppressionDeadline(snapshot) {
  let deadline = Number.POSITIVE_INFINITY;
  for (const bucket of Object.values(snapshot.rateLimitsByLimitId)) {
    for (const window of [bucket.primary, bucket.secondary]) {
      if (!window) continue;
      const resetMs = window.resetsAt * 1000;
      const startMs = resetMs - window.windowDurationMins * 60_000;
      if (startMs <= snapshot.observedAtMs && snapshot.observedAtMs < resetMs) deadline = Math.min(deadline, resetMs);
    }
  }
  return deadline === Number.POSITIVE_INFINITY ? 0 : deadline;
}

function writeCache(file, cache) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporary,
      `${JSON.stringify(
        {
          formatVersion: FORMAT_VERSION,
          lastAttemptAtMs: cache.lastAttemptAtMs,
          snapshots: cache.snapshots,
          recoveryEnabled: cache.recoveryEnabled === true,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function recoverOnce(quota, preset, options, file, atMs) {
  const cache = readCodexQuotaCache(options);
  const window = quota?.windows?.[preset];
  if (window?.state !== "missing" && window?.state !== "waiting") return false;
  if (cache.recoveryEnabled !== true && options.officialQuotaRecoveryEnabled !== true) return false;
  if (atMs - cache.lastAttemptAtMs < RETRY_COOLDOWN_MS) return false;

  const latest = latestSnapshot(cache, atMs);
  if (latest && atMs < snapshotSuppressionDeadline(latest)) return false;

  let rawSnapshot = null;
  try {
    const reader = options.readOfficialCodexQuota || readOfficialCodexQuota;
    rawSnapshot = await reader(options);
  } catch {
    writeCache(file, { ...cache, lastAttemptAtMs: atMs });
    return false;
  }

  let snapshot = null;
  if (rawSnapshot !== null) {
    try {
      snapshot = normalizeSnapshot(rawSnapshot, atMs);
    } catch {
      writeCache(file, { ...cache, lastAttemptAtMs: atMs });
      return false;
    }
  }

  const next = { ...cache, lastAttemptAtMs: atMs, snapshots: [...cache.snapshots] };
  let changed = false;
  if (snapshot) {
    const existing = new Set(cache.snapshots.map(snapshotContentKey));
    if (!existing.has(snapshotContentKey(snapshot))) {
      next.snapshots.push(snapshot);
      changed = true;
    }
  }
  writeCache(file, next);
  return changed;
}

/** @param {any} quota @param {string} preset @param {any} [options] */
export async function recoverCodexQuota(quota, preset, options = {}) {
  if (!["quota_5h", "quota_week"].includes(preset)) return false;
  const window = quota?.windows?.[preset];
  if (window?.state !== "missing" && window?.state !== "waiting") return false;
  const cache = readCodexQuotaCache(options);
  if (cache.recoveryEnabled !== true && options.officialQuotaRecoveryEnabled !== true) return false;

  const file = codexQuotaFile(options);
  const key = path.resolve(file);
  let flight = recoveryFlights.get(key);
  if (!flight) {
    flight = recoverOnce(quota, preset, options, file, nowMs(options)).finally(() => {
      if (recoveryFlights.get(key) === flight) recoveryFlights.delete(key);
    });
    recoveryFlights.set(key, flight);
  }
  return flight;
}

function resolveCodexCommand(options) {
  const injected = options.codexExecutable;
  if (injected) {
    const extension = path.extname(injected).toLowerCase();
    return [".js", ".mjs", ".cjs"].includes(extension)
      ? { command: process.execPath, prefix: [injected] }
      : { command: injected, prefix: [] };
  }

  const pathEntries = String(options.env?.PATH || process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  if (process.platform === "win32") {
    for (const directory of pathEntries) {
      const candidate = path.join(directory, "codex.exe");
      if (existsSync(candidate)) return { command: candidate, prefix: [] };
    }
    const architecture =
      process.arch === "arm64"
        ? { packageName: "codex-win32-arm64", target: "aarch64-pc-windows-msvc" }
        : { packageName: "codex-win32-x64", target: "x86_64-pc-windows-msvc" };
    for (const directory of pathEntries) {
      for (const packageRoot of [
        path.join(directory, "node_modules", "@openai", "codex", "node_modules", "@openai", architecture.packageName),
        path.join(directory, "node_modules", "@openai", architecture.packageName),
        path.join(directory, "node_modules", "@openai", "codex"),
        directory,
      ]) {
        const candidate = path.join(packageRoot, "vendor", architecture.target, "bin", "codex.exe");
        if (existsSync(candidate)) return { command: candidate, prefix: [] };
      }
    }
  } else {
    for (const directory of pathEntries) {
      const candidate = path.join(directory, "codex");
      if (existsSync(candidate)) return { command: candidate, prefix: [] };
    }
  }
  throw new Error("Unable to find the official Codex executable");
}

function isApiKeyAccount(result) {
  const account = result?.account || result;
  const type = String(account?.type || "")
    .replace(/[^a-z]/gi, "")
    .toLowerCase();
  return type === "apikey";
}

function normalizedOfficialSnapshot(accountResult, limitsResult, observedAtMs) {
  const account = accountResult?.account || accountResult;
  const rateLimitsByLimitId = isRecord(limitsResult?.rateLimitsByLimitId)
    ? limitsResult.rateLimitsByLimitId
    : isRecord(limitsResult?.rateLimits)
      ? { codex: limitsResult.rateLimits }
      : null;
  const buckets = rateLimitsByLimitId ? Object.values(rateLimitsByLimitId) : [];
  const firstBucket = buckets.find(isRecord);
  const accountFingerprint =
    typeof limitsResult?.accountId === "string"
      ? createHash("sha256").update(limitsResult.accountId).digest("hex")
      : null;
  return normalizeSnapshot(
    {
      observedAtMs,
      accountFingerprint,
      planType:
        optionalString(firstBucket?.planType) ||
        optionalString(limitsResult?.planType) ||
        optionalString(account?.planType),
      rateLimitsByLimitId,
    },
    observedAtMs,
  );
}

/** @param {any} [options] */
export async function readOfficialCodexQuota(options = {}) {
  const { command, prefix } = resolveCodexCommand(options);
  const scratch = mkdtempSync(path.join(os.tmpdir(), "codex-usage-quota-"));
  const args = [...prefix, "app-server", "--listen", "stdio://", "-c", `sqlite_home=${JSON.stringify(scratch)}`];
  const env = { ...process.env, ...options.env };
  if (options.homeDir) env.CODEX_HOME = path.join(options.homeDir, ".codex");

  const child = spawn(command, args, {
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const childClosed = new Promise((resolve) => {
    child.once("close", resolve);
    child.once("error", resolve);
  });
  const reader = createInterface({ input: child.stdout });
  const pending = new Map();
  const deadline = Date.now() + OFFICIAL_READ_TIMEOUT_MS;
  let nextId = 0;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let protocolFailure = null;

  const fail = (error) => {
    protocolFailure ||= error;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  reader.on("line", (line) => {
    stdoutBytes += Buffer.byteLength(line) + 1;
    if (stdoutBytes > MAX_STDOUT_BYTES) {
      fail(new Error("Codex quota response exceeded the output limit"));
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(`${message.error.code}: ${message.error.message}`));
    else entry.resolve(message.result);
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_STDERR_BYTES) fail(new Error("Codex quota stderr exceeded the output limit"));
  });
  child.on("error", fail);
  child.on("close", (code) => {
    if (pending.size) fail(protocolFailure || new Error(`Codex app-server exited with code ${code}`));
  });
  child.stdin.on("error", fail);

  const call = (method, params) =>
    new Promise((resolve, reject) => {
      if (protocolFailure) {
        reject(protocolFailure);
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        reject(new Error("Codex quota read timed out"));
        return;
      }
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex quota read timed out: ${method}`));
      }, remaining);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });

  try {
    await call("initialize", {
      clientInfo: { name: "codex-usage", title: "Codex Usage", version: "0.8.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    const account = await call("account/read", { refreshToken: false });
    if (isApiKeyAccount(account)) return null;
    const limits = await call("account/rateLimits/read", {});
    return normalizedOfficialSnapshot(account, limits, nowMs(options));
  } finally {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
    reader.close();
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    let closeTimer;
    await Promise.race([
      childClosed,
      new Promise((resolve) => {
        closeTimer = setTimeout(resolve, 1000);
        closeTimer.unref();
      }),
    ]);
    clearTimeout(closeTimer);
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
  }
}
