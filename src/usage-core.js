import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import { createRepositoryResolver } from "./repository-identity.js";
import { createCostEstimateAccumulator, estimateCostForEvents, estimateEventCost, LONG_CONTEXT_INPUT_THRESHOLD, pricingVersionForTimestamp } from "./pricing.js";
import { loadServiceTierEvidence } from "./service-tier-evidence.js";
import { USAGE_DETAIL_INCONSISTENT, USAGE_DETAIL_MASK, USAGE_FIELDS, emptyUsage, isZeroUsage, validateUsageDetails } from "./usage-fields.js";
import { streamZcodeDbEvents, parseZcodeDb, zcodeDatabaseFile, zcodeSourceStat } from "./zcode-usage.js";
import { buildTimelineRows, resolveNamedRecentRange } from "../public/timeline-utils.js";

const SESSION_DIRS = ["sessions", "archived_sessions"];
const PROJECT_USAGE_DIR = ".codex-usage";
const PROJECT_USAGE_FILE = "usage.jsonl";
const PROJECT_LOG_SCHEMA_VERSION = "codex-usage.project-log.v1";
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;
const QUOTA_WINDOW_MINUTES = Object.freeze({ quota_5h: 300, quota_week: 10080 });
const QUOTA_PERCENT_STALE_AFTER_MS = 10 * 60 * 1000;
export const USAGE_PRESETS = Object.freeze(["today", "week", "month", "all", "recent", "custom", "quota_5h", "quota_week"]);
const USAGE_DETAIL_KEYS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"];

export { emptyUsage, USAGE_DETAIL_MASK };

export function isQuotaPreset(preset) {
  return Object.hasOwn(QUOTA_WINDOW_MINUTES, preset);
}

export class InvalidPresetError extends Error {
  constructor(preset) {
    super(`无效的时间范围：${String(preset)}`);
    this.name = "InvalidPresetError";
    this.code = "INVALID_PRESET";
  }
}

export class QuotaWindowUnavailableError extends Error {
  constructor(preset, quota) {
    const window = quota?.windows?.[preset];
    super(window?.reason || "当前没有可用的 Codex 限额窗口。");
    this.name = "QuotaWindowUnavailableError";
    this.code = "QUOTA_WINDOW_UNAVAILABLE";
    this.preset = preset;
    this.quota = quota || null;
    this.state = window?.state || "missing";
  }
}

function usageFromRaw(raw = {}) {
  return {
    total: Number(raw.total_tokens || 0),
    input: Number(raw.input_tokens || 0),
    cached: Number(raw.cached_input_tokens || 0),
    output: Number(raw.output_tokens || 0),
    reasoning: Number(raw.reasoning_output_tokens || 0),
  };
}

function readCacheWrite(raw = {}) {
  const value = raw.cache_write_input_tokens;
  const known = Object.hasOwn(raw, "cache_write_input_tokens") && value !== null && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;
  return { tokens: known ? Number(value) : 0, known };
}

function readServiceTier(row = {}, payload = {}) {
  const values = [
    payload.info?.response?.service_tier,
    payload.response?.service_tier,
    row.response?.service_tier,
    payload.info?.service_tier,
    payload.service_tier,
    row.service_tier,
  ];
  const value = values.find((candidate) => typeof candidate === "string" && candidate.trim());
  return value ? value.trim().toLowerCase() : "unknown";
}

function lastUsageMatchesDelta(last, lastMask, delta, deltaMask) {
  const required = USAGE_DETAIL_MASK.input | USAGE_DETAIL_MASK.output;
  if ((lastMask & required) !== required || (deltaMask & required) !== required) return false;
  for (const [field, bit] of [
    ["input", USAGE_DETAIL_MASK.input],
    ["cached", USAGE_DETAIL_MASK.cached],
    ["output", USAGE_DETAIL_MASK.output],
    ["reasoning", USAGE_DETAIL_MASK.reasoning],
  ]) {
    if ((lastMask & bit) && (!(deltaMask & bit) || last[field] !== delta[field])) return false;
  }
  return true;
}

function cacheWriteForEvent({ cumulative, previous, last, lastMatches }) {
  if (!cumulative) return last || { tokens: 0, known: false };
  const hasDelta = cumulative.known && previous.known;
  const deltaTokens = hasDelta ? Math.max(0, cumulative.tokens - previous.tokens) : 0;
  if (lastMatches && last?.known) {
    if (hasDelta && deltaTokens !== last.tokens) return { tokens: 0, known: false };
    return last;
  }
  return hasDelta ? { tokens: deltaTokens, known: true } : { tokens: 0, known: false };
}

function contextForEvent(matches, usage, mask) {
  if (!matches || !(mask & USAGE_DETAIL_MASK.input)) return { requestInputTokens: 0, contextLevel: "unknown" };
  return {
    requestInputTokens: usage.input,
    contextLevel: usage.input > LONG_CONTEXT_INPUT_THRESHOLD ? "long" : "short",
  };
}

function usageDetailMask(raw = {}, keys = USAGE_DETAIL_KEYS) {
  return keys.reduce((mask, key, index) => {
    const value = raw[key];
    const known = Object.hasOwn(raw, key) && value !== null && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;
    return known ? mask | (1 << index) : mask;
  }, 0);
}

function projectLogDetailMask(raw = {}) {
  const has = (...keys) =>
    keys.some((key) => {
      const value = raw[key];
      return Object.hasOwn(raw, key) && value !== null && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;
    });
  return (
    (has("input", "input_tokens") ? USAGE_DETAIL_MASK.input : 0) |
    (has("cached", "cached_input_tokens") ? USAGE_DETAIL_MASK.cached : 0) |
    (has("output", "output_tokens") ? USAGE_DETAIL_MASK.output : 0) |
    (has("reasoning", "reasoning_output_tokens") ? USAGE_DETAIL_MASK.reasoning : 0)
  );
}

function addUsage(target, usage) {
  for (const field of USAGE_FIELDS) {
    target[field] += usage[field] || 0;
  }
  return target;
}

function diffUsage(current, previous, currentMask = USAGE_DETAIL_MASK.complete, previousMask = USAGE_DETAIL_MASK.complete) {
  const diff = emptyUsage();
  diff.total = Math.max(0, (current.total || 0) - (previous.total || 0));
  let detailMask = 0;
  for (const [field, bit] of [
    ["input", USAGE_DETAIL_MASK.input],
    ["cached", USAGE_DETAIL_MASK.cached],
    ["output", USAGE_DETAIL_MASK.output],
    ["reasoning", USAGE_DETAIL_MASK.reasoning],
  ]) {
    if ((currentMask & bit) && (previousMask & bit)) {
      diff[field] = Math.max(0, (current[field] || 0) - (previous[field] || 0));
      detailMask |= bit;
    }
  }
  return { usage: diff, detailMask };
}

function rememberSessionUsage(baselines, sessionId, usage, detailMask, cacheWriteTokens, cacheWriteKnown) {
  const baseline = baselines.get(sessionId) || {
    usage: emptyUsage(),
    detailMask: USAGE_DETAIL_MASK.complete,
    cacheWrite: { tokens: 0, known: true },
  };
  addUsage(baseline.usage, usage);
  baseline.detailMask &= detailMask & USAGE_DETAIL_MASK.complete;
  baseline.cacheWrite.tokens += cacheWriteTokens || 0;
  baseline.cacheWrite.known &&= Boolean(cacheWriteKnown);
  baselines.set(sessionId, baseline);
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function sourceId(kind, sourcePath) {
  const normalizedPath = path.resolve(sourcePath).replace(/\\/g, "/");
  const identity = process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return `${kind}-${digest}`;
}

async function codexHomeLooksUsable(homePath) {
  const checks = await Promise.all([
    exists(path.join(homePath, "sessions")),
    exists(path.join(homePath, "archived_sessions")),
    exists(path.join(homePath, "state_5.sqlite")),
  ]);
  return checks.some(Boolean);
}

function uniquePaths(paths) {
  const seen = new Set();
  const unique = [];
  for (const candidate of paths.filter(Boolean)) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    unique.push(resolved);
  }
  return unique;
}

function optionImportDirs(options = {}) {
  const env = options.env || process.env;
  const configured = [];
  if (Array.isArray(options.importDirs)) {
    configured.push(...options.importDirs);
  } else if (typeof options.importDirs === "string") {
    configured.push(...options.importDirs.split(path.delimiter));
  }
  if (env.CODEX_USAGE_IMPORT_DIRS) {
    configured.push(...env.CODEX_USAGE_IMPORT_DIRS.split(path.delimiter));
  }
  return uniquePaths(configured);
}

export async function classifyImportDirectory(importPath) {
  const resolved = path.resolve(importPath);
  if (await codexHomeLooksUsable(resolved)) {
    return {
      type: "codex-home",
      path: resolved,
    };
  }

  const zcodeDbFile = await zcodeDatabaseFile(resolved);
  if (zcodeDbFile) {
    return {
      type: "zcode-home",
      path: resolved,
      dbFile: zcodeDbFile,
    };
  }

  const directUsageLogPath = path.join(resolved, PROJECT_USAGE_FILE);
  if (path.basename(resolved) === PROJECT_USAGE_DIR && (await exists(directUsageLogPath))) {
    return {
      type: "project-log",
      path: path.dirname(resolved),
      usageLogPath: directUsageLogPath,
    };
  }

  const usageLogPath = path.join(resolved, PROJECT_USAGE_DIR, PROJECT_USAGE_FILE);
  if (await exists(usageLogPath)) {
    return {
      type: "project-log",
      path: resolved,
      usageLogPath,
    };
  }

  return {
    type: "unsupported",
    path: resolved,
    reason: `目录需要是 Codex home、ZCode home，或包含 ${PROJECT_USAGE_DIR}/${PROJECT_USAGE_FILE}`,
  };
}

function jetBrainsRoots({ homeDir, platform, env }) {
  const roots = [path.join(homeDir, "Library", "Caches", "JetBrains")];

  if (platform === "win32") {
    roots.push(
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "JetBrains") : "",
      env.APPDATA ? path.join(env.APPDATA, "JetBrains") : "",
      path.join(homeDir, "AppData", "Local", "JetBrains"),
      path.join(homeDir, "AppData", "Roaming", "JetBrains"),
    );
  }

  return uniquePaths(roots);
}

export async function discoverCodexHomes(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const platform = options.platform || os.platform();
  const envHomes = options.extraHomes || env.CODEX_USAGE_HOMES || "";
  const homes = [];
  const seen = new Set();

  async function addHome(label, homePath, kind = "codex") {
    const resolved = path.resolve(homePath);
    if (seen.has(resolved) || !(await codexHomeLooksUsable(resolved))) {
      return;
    }
    seen.add(resolved);
    homes.push({
      id: sourceId(kind, resolved),
      label,
      path: resolved,
      kind,
    });
  }

  await addHome("Main Codex", path.join(homeDir, ".codex"), "main");

  for (const jetbrainsRoot of jetBrainsRoots({ homeDir, platform, env })) {
    if (!(await exists(jetbrainsRoot))) {
      continue;
    }
    for (const entry of await readdir(jetbrainsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const productName = entry.name;
      await addHome(
        `JetBrains ${productName}`,
        path.join(jetbrainsRoot, productName, "aia", "codex"),
        "jetbrains",
      );
    }
  }

  for (const extraHome of envHomes.split(path.delimiter).filter(Boolean)) {
    await addHome(`Extra ${path.basename(extraHome)}`, extraHome, "extra");
  }

  return homes;
}

export async function discoverZcodeHomes(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const envHomes = options.extraZcodeHomes || env.CODEX_USAGE_ZCODE_HOMES || "";
  const homes = [];
  const seen = new Set();

  if (env.CODEX_USAGE_ZCODE === "0") {
    return homes;
  }

  async function addHome(label, homePath) {
    const resolved = path.resolve(homePath);
    if (seen.has(resolved)) {
      return;
    }
    const dbFile = await zcodeDatabaseFile(resolved);
    if (!dbFile) {
      return;
    }
    seen.add(resolved);
    homes.push({
      id: sourceId("zcode", resolved),
      label,
      path: resolved,
      kind: "zcode",
      usageLogPath: dbFile,
    });
  }

  await addHome("Main ZCode", path.join(homeDir, ".zcode"));

  for (const extraHome of envHomes.split(path.delimiter).filter(Boolean)) {
    await addHome(`ZCode ${path.basename(extraHome) || extraHome}`, extraHome);
  }

  return homes;
}

export async function discoverUsageSources(options = {}) {
  const sources = await discoverCodexHomes(options);
  const seenPaths = new Set(sources.map((source) => source.path));
  const seenProjectLogs = new Set();

  for (const zcodeHome of await discoverZcodeHomes(options)) {
    if (seenPaths.has(zcodeHome.path)) {
      continue;
    }
    seenPaths.add(zcodeHome.path);
    sources.push(zcodeHome);
  }

  for (const importDir of optionImportDirs(options)) {
    const classified = await classifyImportDirectory(importDir);
    if (classified.type === "codex-home") {
      if (seenPaths.has(classified.path)) {
        continue;
      }
      seenPaths.add(classified.path);
      sources.push({
        id: sourceId("extra", classified.path),
        label: `Imported ${path.basename(classified.path) || classified.path}`,
        path: classified.path,
        kind: "extra",
        imported: true,
      });
      continue;
    }

    if (classified.type === "zcode-home") {
      if (seenPaths.has(classified.path)) {
        continue;
      }
      seenPaths.add(classified.path);
      sources.push({
        id: sourceId("zcode", classified.path),
        label: `ZCode ${path.basename(classified.path) || classified.path}`,
        path: classified.path,
        kind: "zcode",
        usageLogPath: classified.dbFile,
        imported: true,
      });
      continue;
    }

    if (classified.type !== "project-log") {
      continue;
    }

    if (seenProjectLogs.has(classified.usageLogPath)) {
      continue;
    }
    seenProjectLogs.add(classified.usageLogPath);
    sources.push({
      id: sourceId("project-log", classified.usageLogPath),
      label: `Project ${path.basename(classified.path) || classified.path}`,
      path: classified.path,
      kind: "project-log",
      usageLogPath: classified.usageLogPath,
      imported: true,
    });
  }

  return sources;
}

async function walkJsonlFiles(root, files = []) {
  if (!(await exists(root))) {
    return files;
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".tmp" || entry.name === "node_modules") {
        continue;
      }
      await walkJsonlFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function discoverSessionFiles(homePath) {
  const groups = await Promise.all(
    SESSION_DIRS.map((dir) => walkJsonlFiles(path.join(homePath, dir), [])),
  );
  return groups.flat().sort();
}

export async function buildUsageFingerprint(options = {}) {
  const homes = options.homes || (await discoverUsageSources(options));
  const hash = createHash("sha256");
  let fileCount = 0;
  const scannedByHome = new Map();
  for (const entry of options.scannedFiles || []) {
    const files = scannedByHome.get(entry.source.id) || [];
    files.push(entry);
    scannedByHome.set(entry.source.id, files);
  }
  const failedHomeIds = new Set((options.failedHomes || []).map((home) => home.id));

  async function addFile(filePath, info = null) {
    try {
      const details = info || await stat(filePath);
      fileCount += 1;
      hash.update(`${filePath}\t${details.size}\t${details.mtimeMs}\n`);
    } catch (error) {
      hash.update(`${filePath}\t!${error.code || "unreadable"}\n`);
    }
  }

  for (const home of homes) {
    hash.update(`${home.id}\t${home.label}\t${home.path}\t${home.kind || ""}\t${home.usageLogPath || ""}\n`);
    if (Array.isArray(options.scannedFiles)) {
      for (const entry of scannedByHome.get(home.id) || []) await addFile(entry.filePath, entry.info);
      if (failedHomeIds.has(home.id)) hash.update("!scan-failed\n");
      continue;
    }
    if (home.kind === "project-log" && home.usageLogPath) {
      await addFile(home.usageLogPath);
      continue;
    }
    if (home.kind === "zcode" && home.usageLogPath) {
      try {
        await addFile(home.usageLogPath, await zcodeSourceStat(home.usageLogPath));
      } catch (error) {
        hash.update(`!discover-failed:${error.code || "unreadable"}\n`);
      }
      continue;
    }
    let files;
    try {
      files = await discoverSessionFiles(home.path);
    } catch (error) {
      hash.update(`!discover-failed:${error.code || "unreadable"}\n`);
      continue;
    }
    for (const file of files) await addFile(file);
  }

  return {
    fingerprint: hash.digest("hex"),
    fileCount,
    homeCount: homes.length,
    checkedAt: new Date().toISOString(),
  };
}

export function classifyChannel({ originator, source, homeLabel }) {
  const normalize = (value) => String(value || "").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const normalizedSource = normalize(source);
  const text = `${normalize(originator)} ${normalizedSource} ${normalize(homeLabel)}`;
  if (text.includes("jetbrains")) {
    return "JetBrains PyCharm";
  }
  if (text.includes("codex desktop")) {
    return "Codex Desktop";
  }
  if (normalizedSource === "cli" || text.includes("codex tui") || text.includes("codex cli")) {
    return "CLI";
  }
  if (normalizedSource === "exec" || text.includes("codex exec")) {
    return "Codex Exec";
  }
  if (normalizedSource === "vscode" || /(^|\s)(vscode|vs code)(\s|$)/.test(text) || text.includes("chrome extension")) {
    return "Editor Integration";
  }
  return originator || source || homeLabel || "Unknown";
}

function fallbackSessionId(filePath) {
  const base = path.basename(filePath, ".jsonl");
  return base.replace(/^rollout-/, "") || filePath;
}

function readTokenUsage(payload, row = {}) {
  const info = payload?.info || {};
  const cumulativeRaw = info.total_token_usage;
  const lastRaw = info.last_token_usage;
  const cumulative = cumulativeRaw ? usageFromRaw(cumulativeRaw) : null;
  const last = lastRaw ? usageFromRaw(lastRaw) : null;
  return {
    cumulative,
    cumulativeMask: cumulativeRaw ? usageDetailMask(cumulativeRaw) : 0,
    cumulativeCacheWrite: readCacheWrite(cumulativeRaw),
    last,
    lastMask: lastRaw ? usageDetailMask(lastRaw) : 0,
    lastCacheWrite: readCacheWrite(lastRaw),
    serviceTier: readServiceTier(row, payload),
  };
}

function invalidRateLimitWarning(sourcePath, lineNumber, role, reason) {
  return `无法索引 Codex 限额观察值 ${sourcePath}:${lineNumber} (${role})：${reason}`;
}

export function parseRateLimitObservations(row, { sourcePath = "", lineNumber = 0, onWarning } = {}) {
  if (row?.type !== "event_msg" || row?.payload?.type !== "token_count" || !Object.hasOwn(row.payload, "rate_limits")) {
    return [];
  }
  const rateLimits = row.payload.rate_limits;
  if (rateLimits === null || rateLimits === undefined) return [];
  if (typeof rateLimits !== "object" || Array.isArray(rateLimits)) {
    onWarning?.(invalidRateLimitWarning(sourcePath, lineNumber, "primary/secondary", "rate_limits 格式无效"));
    return [];
  }
  const observedAtMs = Date.parse(row.timestamp || "");
  const observations = [];
  for (const role of ["primary", "secondary"]) {
    if (!Object.hasOwn(rateLimits, role) || rateLimits[role] === null || rateLimits[role] === undefined) continue;
    const raw = rateLimits[role];
    let reason = "";
    const rootLimitId = typeof rateLimits.limit_id === "string" ? rateLimits.limit_id.trim() : "";
    const windowLimitId = typeof raw?.limit_id === "string" ? raw.limit_id.trim() : "";
    const limitId = rootLimitId || windowLimitId;
    const windowMinutes = raw?.window_minutes === "" || raw?.window_minutes === null ? NaN : Number(raw?.window_minutes);
    const resetSeconds = raw?.resets_at === "" || raw?.resets_at === null ? NaN : Number(raw?.resets_at);
    const resetsAtMs = resetSeconds * 1000;
    const hasPercent = raw && Object.hasOwn(raw, "used_percent") && raw.used_percent !== null && raw.used_percent !== "";
    const usedPercent = hasPercent ? Number(raw.used_percent) : null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) reason = "窗口数据格式无效";
    else if (!Number.isFinite(observedAtMs)) reason = "观察时间无效";
    else if (rootLimitId && windowLimitId && rootLimitId !== windowLimitId) reason = "顶层与窗口 limit_id 冲突";
    else if (!limitId) reason = "limit_id 为空";
    else if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) reason = "window_minutes 必须是正数";
    else if (!Number.isFinite(resetSeconds) || resetSeconds <= 0 || !Number.isFinite(resetsAtMs) || Number.isNaN(new Date(resetsAtMs).getTime())) reason = "resets_at 无效";
    else if (hasPercent && (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100)) reason = "used_percent 必须在 0 到 100 之间";
    if (reason) {
      onWarning?.(invalidRateLimitWarning(sourcePath, lineNumber, role, reason));
      continue;
    }
    observations.push({
      sourcePath,
      lineNumber,
      role,
      observedAtMs,
      limitId,
      limitName: typeof rateLimits.limit_name === "string" ? rateLimits.limit_name :
        typeof raw.limit_name === "string" ? raw.limit_name : null,
      planType: typeof rateLimits.plan_type === "string" ? rateLimits.plan_type :
        typeof raw.plan_type === "string" ? raw.plan_type : null,
      windowMinutes,
      resetsAtMs,
      usedPercent,
    });
  }
  return observations;
}

function observationKey(observation, index) {
  const sourcePath = observation.sourcePath ?? observation.source_path;
  const lineNumber = observation.lineNumber ?? observation.line_number;
  const role = observation.role;
  return sourcePath !== undefined && lineNumber !== undefined && role
    ? `${sourcePath}\u0000${lineNumber}\u0000${role}`
    : `unkeyed\u0000${index}`;
}

function observationValue(observation, camelName, snakeName) {
  return observation?.[camelName] ?? observation?.[snakeName];
}

function unavailableQuotaWindow(state, reason) {
  const reasonCode = new Map([
    ["存在多个无法区分的 Codex 限额桶。", "multiple-buckets"],
    ["尚未发现 Codex 限额记录。", "no-records"],
    ["同一观察时刻存在相互冲突的限额重置时间。", "conflicting-reset"],
    ["等待新的限额记录", "waiting"],
    ["尚未发现当前限额窗口的 Codex 记录。", "missing-window"],
    ["限额窗口边界无效。", "invalid-boundaries"],
  ]).get(reason) || state;
  return {
    state,
    reason,
    reasonCode,
    windowStart: null,
    windowEndExclusive: null,
    observedAt: null,
    usedPercent: null,
    percentStale: null,
  };
}

export function selectQuotaWindows(observations = [], asOfValue = new Date()) {
  const asOfMs = asOfValue instanceof Date
    ? asOfValue.getTime()
    : typeof asOfValue === "number" ? asOfValue : Date.parse(asOfValue);
  if (!Number.isFinite(asOfMs)) throw new RangeError("asOf must be a valid date.");
  const asOf = new Date(asOfMs).toISOString();
  const unique = new Map();
  observations.forEach((observation, index) => {
    const key = observationKey(observation, index);
    if (!unique.has(key)) unique.set(key, observation);
  });
  const valid = [...unique.values()].filter((observation) => {
    const id = observationValue(observation, "limitId", "limit_id");
    const observedAt = Number(observationValue(observation, "observedAtMs", "observed_at_ms"));
    const windowMinutes = Number(observation.windowMinutes ?? observation.window_minutes);
    const resetsAtMs = Number(observationValue(observation, "resetsAtMs", "resets_at_ms"));
    return typeof id === "string" && id.trim() && Number.isFinite(observedAt) && Number.isFinite(windowMinutes) && windowMinutes > 0 && Number.isFinite(resetsAtMs);
  });
  const buckets = new Map();
  for (const observation of valid) {
    const id = observationValue(observation, "limitId", "limit_id");
    const observedAtMs = Number(observationValue(observation, "observedAtMs", "observed_at_ms"));
    const bucket = buckets.get(id) || { count: 0, latestObservedAtMs: -Infinity, observations: [] };
    bucket.count += 1;
    bucket.latestObservedAtMs = Math.max(bucket.latestObservedAtMs, observedAtMs);
    bucket.observations.push(observation);
    buckets.set(id, bucket);
  }

  let limitId = null;
  let ignoredBucketCount = 0;
  let bucketAmbiguous = false;
  if (buckets.size === 1) {
    limitId = buckets.keys().next().value;
  } else if (buckets.size > 1) {
    const repeated = [...buckets].filter(([, bucket]) => bucket.count > 1);
    if (!repeated.length) {
      bucketAmbiguous = true;
    } else {
      const candidates = repeated.sort((left, right) =>
        right[1].count - left[1].count || right[1].latestObservedAtMs - left[1].latestObservedAtMs,
      );
      ignoredBucketCount = buckets.size - candidates.length;
      if (candidates.length > 1 && candidates[0][1].count === candidates[1][1].count && candidates[0][1].latestObservedAtMs === candidates[1][1].latestObservedAtMs) {
        bucketAmbiguous = true;
      } else {
        limitId = candidates[0][0];
      }
    }
  }

  const windows = {};
  for (const [preset, windowMinutes] of Object.entries(QUOTA_WINDOW_MINUTES)) {
    if (bucketAmbiguous) {
      windows[preset] = unavailableQuotaWindow("ambiguous", "存在多个无法区分的 Codex 限额桶。");
      continue;
    }
    if (!limitId) {
      windows[preset] = unavailableQuotaWindow("missing", "尚未发现 Codex 限额记录。");
      continue;
    }
    const bucketObservations = buckets.get(limitId).observations.filter((observation) =>
      Number(observation.windowMinutes ?? observation.window_minutes) === windowMinutes,
    );
    const observedBeforeAsOf = bucketObservations.filter((observation) =>
      Number(observationValue(observation, "observedAtMs", "observed_at_ms")) <= asOfMs,
    );
    const current = observedBeforeAsOf.filter((observation) => {
      const endMs = Number(observationValue(observation, "resetsAtMs", "resets_at_ms"));
      const startMs = endMs - windowMinutes * MS_PER_MINUTE;
      return startMs <= asOfMs && asOfMs < endMs;
    });
    if (current.length) {
      const latestObservedAtMs = Math.max(...current.map((observation) => Number(observationValue(observation, "observedAtMs", "observed_at_ms"))));
      const latest = current.filter((observation) => Number(observationValue(observation, "observedAtMs", "observed_at_ms")) === latestObservedAtMs);
      const endPoints = new Set(latest.map((observation) => Number(observationValue(observation, "resetsAtMs", "resets_at_ms"))));
      if (endPoints.size > 1) {
        windows[preset] = unavailableQuotaWindow("ambiguous", "同一观察时刻存在相互冲突的限额重置时间。");
        continue;
      }
      const windowEndMs = endPoints.values().next().value;
      const percents = new Set(latest.map((observation) => {
        const value = observationValue(observation, "usedPercent", "used_percent");
        return value === null || value === undefined ? null : Number(value);
      }));
      const usedPercent = percents.size === 1 ? percents.values().next().value : null;
      const windowStartMs = windowEndMs - windowMinutes * MS_PER_MINUTE;
      windows[preset] = {
        state: "available",
        reason: null,
        windowStart: new Date(windowStartMs).toISOString(),
        windowEndExclusive: new Date(windowEndMs).toISOString(),
        observedAt: new Date(latestObservedAtMs).toISOString(),
        usedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
        percentStale: asOfMs - latestObservedAtMs > QUOTA_PERCENT_STALE_AFTER_MS,
      };
      continue;
    }
    const hasExpiredObservation = observedBeforeAsOf.some((observation) =>
      Number(observationValue(observation, "resetsAtMs", "resets_at_ms")) <= asOfMs,
    );
    windows[preset] = hasExpiredObservation
      ? unavailableQuotaWindow("waiting", "等待新的限额记录")
      : unavailableQuotaWindow("missing", "尚未发现当前限额窗口的 Codex 记录。");
  }
  const previousWindows = {};
  for (const [preset, minutes] of Object.entries(QUOTA_WINDOW_MINUTES)) {
    const cutoff = windows[preset]?.state === "available" ? Date.parse(windows[preset].windowStart) : asOfMs;
    const candidates = (buckets.get(limitId)?.observations || []).filter(row => {
      const observed = Number(observationValue(row, "observedAtMs", "observed_at_ms"));
      const end = Number(observationValue(row, "resetsAtMs", "resets_at_ms"));
      return Number(row.windowMinutes ?? row.window_minutes) === minutes && observed <= asOfMs && observed < end && end <= cutoff;
    });
    if (!candidates.length || bucketAmbiguous || windows[preset]?.state === "ambiguous") {
      previousWindows[preset] = unavailableQuotaWindow("missing", "尚未发现上一限额窗口的 Codex 记录。");
      continue;
    }
    const latestTime = candidates.reduce((max, row) => Math.max(max, Number(observationValue(row, "observedAtMs", "observed_at_ms"))), -Infinity);
    const latest = candidates.filter(row => Number(observationValue(row, "observedAtMs", "observed_at_ms")) === latestTime);
    const ends = new Set(latest.map(row => Number(observationValue(row, "resetsAtMs", "resets_at_ms"))));
    if (ends.size !== 1) {
      previousWindows[preset] = unavailableQuotaWindow("ambiguous", "同一观察时刻存在相互冲突的限额重置时间。");
      continue;
    }
    const end = [...ends][0];
    previousWindows[preset] = { state: "available", reason: null,
      windowStart: new Date(end - minutes * MS_PER_MINUTE).toISOString(),
      windowEndExclusive: new Date(end).toISOString(), observedAt: new Date(latestTime).toISOString() };
  }
  return { asOf, limitId, ignoredBucketCount, windows, previousWindows };
}

export async function parseSessionFile(filePath, home, options = {}) {
  const resolveRepository = options.repositoryResolver || createRepositoryResolver();
  const threadNames = options.threadNames || new Map();
  const meta = {
    id: fallbackSessionId(filePath),
    source: "",
    originator: "",
    cwd: "",
    cliVersion: "",
    modelProvider: "",
  };
  let model = "";
  let firstAt = "";
  let lastAt = "";
  let previousCumulative = emptyUsage();
  let previousCumulativeMask = USAGE_DETAIL_MASK.complete;
  let previousCumulativeCacheWrite = { tokens: 0, known: false };
  let baselineLoaded = false;
  let finalUsage = emptyUsage();
  let tokenEventCount = 0;
  const events = [];
  const rateLimitObservations = [];

  // Stream JSONL rows so full-detail reports do not read large session files at once.
  for await (const { row, lineNumber } of readJsonlRows(filePath, { withLineNumbers: true })) {
    if (row.timestamp) {
      firstAt ||= row.timestamp;
      lastAt = row.timestamp;
    }

    if (row.type === "session_meta") {
      meta.id = row.payload?.id || meta.id;
      meta.source = row.payload?.source || meta.source;
      meta.originator = row.payload?.originator || meta.originator;
      meta.cwd = row.payload?.cwd || meta.cwd;
      meta.cliVersion = row.payload?.cli_version || meta.cliVersion;
      meta.modelProvider = row.payload?.model_provider || meta.modelProvider;
      continue;
    }

    if (row.type === "turn_context") {
      model = row.payload?.model || model;
      continue;
    }

    if (row.type !== "event_msg" || row.payload?.type !== "token_count") {
      continue;
    }

    const observations = parseRateLimitObservations(row, {
      sourcePath: filePath,
      lineNumber,
      onWarning: options.onWarning,
    });
    rateLimitObservations.push(...observations);
    for (const observation of observations) {
      await options.onRateLimit?.(observation);
    }

    if (!baselineLoaded && options.previousCumulativeForSession) {
      const baseline = await options.previousCumulativeForSession(meta.id, row.timestamp || lastAt);
      if (baseline) {
        previousCumulative = baseline.usage;
        previousCumulativeMask = baseline.detailMask;
        previousCumulativeCacheWrite = baseline.cacheWrite;
      }
      baselineLoaded = true;
    }
    const { cumulative, cumulativeMask, cumulativeCacheWrite, last, lastMask, lastCacheWrite, serviceTier } = readTokenUsage(row.payload, row);
    let increment = emptyUsage();
    let detailMask = 0;
    let cacheWrite = { tokens: 0, known: false };
    let lastMatchesDelta = false;
    if (cumulative) {
      const diff = diffUsage(cumulative, previousCumulative, cumulativeMask, previousCumulativeMask);
      increment = diff.usage;
      detailMask = diff.detailMask;
      lastMatchesDelta = Boolean(last && lastUsageMatchesDelta(last, lastMask, increment, detailMask));
      cacheWrite = cacheWriteForEvent({ cumulative: cumulativeCacheWrite, previous: previousCumulativeCacheWrite, last: lastCacheWrite, lastMatches: lastMatchesDelta });
      previousCumulative = cumulative;
      previousCumulativeMask = cumulativeMask;
      previousCumulativeCacheWrite = cumulativeCacheWrite;
      finalUsage = cumulative;
    } else if (last) {
      increment = last;
      detailMask = lastMask;
      cacheWrite = lastCacheWrite;
      addUsage(finalUsage, last);
    }
    const requestUsage = last && (!cumulative || lastMatchesDelta) ? last : null;
    const context = contextForEvent(Boolean(requestUsage), requestUsage || increment, requestUsage ? lastMask : detailMask);

    if (isZeroUsage(increment)) {
      continue;
    }

    const timestamp = row.timestamp || lastAt || firstAt;
    if (!Number.isFinite(Date.parse(timestamp))) {
      continue;
    }

    tokenEventCount += 1;
    const channel = classifyChannel({
      originator: meta.originator,
      source: meta.source,
      homeLabel: home.homeLabel || home.label,
    });
    const repository = await resolveRepository(meta.cwd);
    const detailValidation = validateUsageDetails(increment, detailMask);
    events.push({
      id: `${meta.id}:${tokenEventCount}`,
      sessionId: meta.id,
      timestamp,
      homeId: home.homeId || home.id,
      homeLabel: home.homeLabel || home.label,
      homePath: home.homePath || home.path,
      channel,
      source: meta.source,
      originator: meta.originator,
      cwd: meta.cwd,
      repositoryKey: repository.key,
      repositoryPath: repository.path,
      repositoryKind: repository.kind,
      conversationName: threadNames.get(meta.id) || "",
      model,
      total: increment,
      detailMask: detailValidation.detailMask,
      reconciliationGap: detailValidation.reconciliationGap,
      cacheWriteTokens: cacheWrite.tokens,
      cacheWriteKnown: cacheWrite.known,
      requestInputTokens: context.requestInputTokens,
      contextLevel: context.contextLevel,
      serviceTier,
      priceVersion: pricingVersionForTimestamp(row.timestamp || lastAt || firstAt),
    });
  }

  if (!events.length && !rateLimitObservations.length) {
    return null;
  }

  const channel = classifyChannel({
    originator: meta.originator,
    source: meta.source,
    homeLabel: home.homeLabel || home.label,
  });

  return {
    session: events.length ? {
      id: meta.id,
      filePath,
      firstAt,
      lastAt,
      homeId: home.homeId || home.id,
      homeLabel: home.homeLabel || home.label,
      homePath: home.homePath || home.path,
      channel,
      source: meta.source,
      originator: meta.originator,
      cwd: meta.cwd,
      conversationName: threadNames.get(meta.id) || "",
      model,
      cliVersion: meta.cliVersion,
      modelProvider: meta.modelProvider,
      eventCount: events.length,
      total: finalUsage,
    } : null,
    events,
    rateLimitObservations,
  };
}

async function* readJsonlRows(filePath, { withLineNumbers = false } = {}) {
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) {
      continue;
    }
    try {
      const row = JSON.parse(line);
      yield withLineNumbers ? { row, lineNumber } : row;
    } catch {
      // Ignore malformed JSONL rows from interrupted writes.
    }
  }
}

export async function readSessionThreadNames(homePath) {
  const threadNames = new Map();
  const indexPath = path.join(homePath, "session_index.jsonl");
  if (!(await exists(indexPath))) {
    return threadNames;
  }
  try {
    for await (const row of readJsonlRows(indexPath)) {
      const id = String(row.id || "").trim();
      const name = String(row.thread_name || "").trim();
      if (id && name) {
        threadNames.set(id, name);
      }
    }
  } catch {
    // Thread names are optional metadata; usage aggregation must still work if the index is unreadable.
  }
  return threadNames;
}

function usageFromProjectLog(raw = {}) {
  const usage = raw || {};
  const input = Number(usage.input ?? usage.input_tokens ?? 0);
  const cached = Number(usage.cached ?? usage.cached_input_tokens ?? 0);
  const output = Number(usage.output ?? usage.output_tokens ?? 0);
  const reasoning = Number(usage.reasoning ?? usage.reasoning_output_tokens ?? 0);
  const total = Number(usage.total ?? usage.total_tokens ?? input + output);
  return { total, input, cached, output, reasoning };
}

function projectLogTimestamp(row) {
  return row.timestamp || row.created_at || row.createdAt || "";
}

function projectLogSource(row) {
  return row.source || "project-log";
}

function projectLogChannel(row) {
  if (row.channel) {
    return row.channel;
  }
  return projectLogSource(row) === "codex-oauth" ? "Codex OAuth" : "Project Log";
}

function projectLogUsage(row) {
  return usageFromProjectLog(row.usage || row.token_usage || row.total_token_usage || {});
}

function projectLogSessionId(row, source, rowNumber) {
  return row.session_id || row.sessionId || row.request_id || row.requestId || `${source.id}:${rowNumber}`;
}

function isSupportedProjectLogRow(row) {
  return !row.schema_version || row.schema_version === PROJECT_LOG_SCHEMA_VERSION;
}

async function parseProjectUsageLogFile(filePath, source, options = {}) {
  const resolveRepository = options.repositoryResolver || createRepositoryResolver();
  const sessions = new Map();
  const events = [];
  let rowNumber = 0;

  for await (const row of readJsonlRows(filePath)) {
    rowNumber += 1;
    if (!isSupportedProjectLogRow(row)) {
      continue;
    }
    const timestamp = projectLogTimestamp(row);
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time)) {
      continue;
    }
    const rawUsage = row.usage || row.token_usage || row.total_token_usage || {};
    const usage = projectLogUsage(row);
    const cacheWrite = readCacheWrite(rawUsage);
    const detailMask = projectLogDetailMask(rawUsage);
    const requestLinked = Boolean(row.request_id || row.requestId || row.response_id || row.responseId);
    const context = contextForEvent(requestLinked, usage, detailMask);
    if (isZeroUsage(usage)) {
      continue;
    }

    const sessionId = projectLogSessionId(row, source, rowNumber);
    const sourceName = projectLogSource(row);
    const channel = projectLogChannel(row);
    const cwd = row.cwd || row.project_root || row.projectRoot || source.path;
    const repository = await resolveRepository(cwd);
    const model = row.model || "Unknown model";
    const detailValidation = validateUsageDetails(usage, detailMask);
    const event = {
      id: row.event_id || row.eventId || row.request_id || row.requestId || `${sessionId}:${events.length + 1}`,
      sessionId,
      timestamp,
      homeId: source.id,
      homeLabel: source.label,
      homePath: source.path,
      channel,
      source: sourceName,
      originator: "",
      cwd,
      repositoryKey: repository.key,
      repositoryPath: repository.path,
      repositoryKind: repository.kind,
      model,
      total: usage,
      detailMask: detailValidation.detailMask,
      reconciliationGap: detailValidation.reconciliationGap,
      cacheWriteTokens: cacheWrite.tokens,
      cacheWriteKnown: cacheWrite.known,
      requestInputTokens: context.requestInputTokens,
      contextLevel: context.contextLevel,
      serviceTier: readServiceTier(row, rawUsage),
      priceVersion: pricingVersionForTimestamp(timestamp),
    };
    events.push(event);

    const session = sessions.get(sessionId) || {
      id: sessionId,
      filePath,
      firstAt: timestamp,
      lastAt: timestamp,
      homeId: source.id,
      homeLabel: source.label,
      homePath: source.path,
      channel,
      source: sourceName,
      originator: "",
      cwd,
      model,
      cliVersion: "",
      modelProvider: "",
      eventCount: 0,
      total: emptyUsage(),
    };
    if (time < Date.parse(session.firstAt)) {
      session.firstAt = timestamp;
    }
    if (time > Date.parse(session.lastAt)) {
      session.lastAt = timestamp;
    }
    session.eventCount += 1;
    session.model = model;
    addUsage(session.total, usage);
    sessions.set(sessionId, session);
  }

  return {
    sessions: [...sessions.values()],
    events,
  };
}

function createStringInterner() {
  const values = [];
  const ids = new Map();
  return {
    values,
    intern(value) {
      const text = value || "";
      const existing = ids.get(text);
      if (existing !== undefined) {
        return existing;
      }
      const id = values.length;
      ids.set(text, id);
      values.push(text);
      return id;
    },
  };
}

async function streamSessionUsageFileEvents(filePath, home, onEvent, options = {}) {
  const resolveRepository = options.repositoryResolver || createRepositoryResolver();
  const meta = {
    id: fallbackSessionId(filePath),
    source: "",
    originator: "",
    cwd: "",
  };
  let model = "";
  let firstAt = "";
  let lastAt = "";
  let previousCumulative = emptyUsage();
  let previousCumulativeMask = USAGE_DETAIL_MASK.complete;
  let previousCumulativeCacheWrite = { tokens: 0, known: false };
  let baselineLoaded = false;

  for await (const { row, lineNumber } of readJsonlRows(filePath, { withLineNumbers: true })) {
    if (row.timestamp) {
      firstAt ||= row.timestamp;
      lastAt = row.timestamp;
    }

    if (row.type === "session_meta") {
      meta.id = row.payload?.id || meta.id;
      meta.source = row.payload?.source || meta.source;
      meta.originator = row.payload?.originator || meta.originator;
      meta.cwd = row.payload?.cwd || meta.cwd;
      continue;
    }

    if (row.type === "turn_context") {
      model = row.payload?.model || model;
      continue;
    }

    if (row.type !== "event_msg" || row.payload?.type !== "token_count") {
      continue;
    }

    for (const observation of parseRateLimitObservations(row, {
      sourcePath: filePath,
      lineNumber,
      onWarning: options.onWarning,
    })) {
      await options.onRateLimit?.(observation);
    }

    if (!baselineLoaded && options.previousCumulativeForSession) {
      const baseline = await options.previousCumulativeForSession(meta.id, row.timestamp || lastAt);
      if (baseline) {
        previousCumulative = baseline.usage;
        previousCumulativeMask = baseline.detailMask;
        previousCumulativeCacheWrite = baseline.cacheWrite;
      }
      baselineLoaded = true;
    }
    const { cumulative, cumulativeMask, cumulativeCacheWrite, last, lastMask, lastCacheWrite, serviceTier } = readTokenUsage(row.payload, row);
    let increment = emptyUsage();
    let detailMask = 0;
    let cacheWrite = { tokens: 0, known: false };
    let lastMatchesDelta = false;
    if (cumulative) {
      const diff = diffUsage(cumulative, previousCumulative, cumulativeMask, previousCumulativeMask);
      increment = diff.usage;
      detailMask = diff.detailMask;
      lastMatchesDelta = Boolean(last && lastUsageMatchesDelta(last, lastMask, increment, detailMask));
      cacheWrite = cacheWriteForEvent({ cumulative: cumulativeCacheWrite, previous: previousCumulativeCacheWrite, last: lastCacheWrite, lastMatches: lastMatchesDelta });
      previousCumulative = cumulative;
      previousCumulativeMask = cumulativeMask;
      previousCumulativeCacheWrite = cumulativeCacheWrite;
    } else if (last) {
      increment = last;
      detailMask = lastMask;
      cacheWrite = lastCacheWrite;
    }
    const requestUsage = last && (!cumulative || lastMatchesDelta) ? last : null;
    const context = contextForEvent(Boolean(requestUsage), requestUsage || increment, requestUsage ? lastMask : detailMask);

    if (isZeroUsage(increment)) {
      continue;
    }

    const channel = classifyChannel({
      originator: meta.originator,
      source: meta.source,
      homeLabel: home.homeLabel || home.label,
    });
    const timestamp = row.timestamp || lastAt || firstAt;
    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(timestampMs)) {
      continue;
    }
    const repository = await resolveRepository(meta.cwd);
    const detailValidation = validateUsageDetails(increment, detailMask);
    await onEvent({
      timestampMs,
      sessionId: meta.id,
      homeId: home.homeId || home.id,
      homeLabel: home.homeLabel || home.label,
      channel,
      project: meta.cwd,
      repositoryKey: repository.key,
      repositoryPath: repository.path,
      repositoryKind: repository.kind,
      model,
      usage: increment,
      detailMask: detailValidation.detailMask,
      reconciliationGap: detailValidation.reconciliationGap,
      cacheWriteTokens: cacheWrite.tokens,
      cacheWriteKnown: cacheWrite.known,
      requestInputTokens: context.requestInputTokens,
      contextLevel: context.contextLevel,
      serviceTier,
      priceVersion: pricingVersionForTimestamp(timestamp),
    });
  }
}

async function streamProjectUsageFileEvents(filePath, source, onEvent, options = {}) {
  const resolveRepository = options.repositoryResolver || createRepositoryResolver();
  let rowNumber = 0;

  for await (const row of readJsonlRows(filePath)) {
    rowNumber += 1;
    if (!isSupportedProjectLogRow(row)) {
      continue;
    }
    const timestamp = projectLogTimestamp(row);
    const time = Date.parse(timestamp);
    if (!Number.isFinite(time)) {
      continue;
    }
    const rawUsage = row.usage || row.token_usage || row.total_token_usage || {};
    const usage = projectLogUsage(row);
    const cacheWrite = readCacheWrite(rawUsage);
    const detailMask = projectLogDetailMask(rawUsage);
    const requestLinked = Boolean(row.request_id || row.requestId || row.response_id || row.responseId);
    const context = contextForEvent(requestLinked, usage, detailMask);
    if (isZeroUsage(usage)) {
      continue;
    }

    const cwd = row.cwd || row.project_root || row.projectRoot || source.path;
    const repository = await resolveRepository(cwd);
    const detailValidation = validateUsageDetails(usage, detailMask);
    await onEvent({
      timestampMs: time,
      sessionId: projectLogSessionId(row, source, rowNumber),
      homeId: source.id,
      homeLabel: source.label,
      channel: projectLogChannel(row),
      project: cwd,
      repositoryKey: repository.key,
      repositoryPath: repository.path,
      repositoryKind: repository.kind,
      model: row.model || "Unknown model",
      usage,
      detailMask: detailValidation.detailMask,
      reconciliationGap: detailValidation.reconciliationGap,
      cacheWriteTokens: cacheWrite.tokens,
      cacheWriteKnown: cacheWrite.known,
      requestInputTokens: context.requestInputTokens,
      contextLevel: context.contextLevel,
      serviceTier: readServiceTier(row, row),
      priceVersion: pricingVersionForTimestamp(timestamp),
    });
  }
}

export async function streamUsageFileEvents(filePath, source, onEvent, options = {}) {
  if (source.kind === "project-log") {
    await streamProjectUsageFileEvents(filePath, source, onEvent, options);
    return;
  }
  if (source.kind === "zcode") {
    await streamZcodeDbEvents(filePath, source, onEvent, options);
    return;
  }
  await streamSessionUsageFileEvents(filePath, source, onEvent, options);
}

async function parseSessionFileForIndex(filePath, home, intern, resolveRepository, previousCumulativeForSession, onRateLimit, onWarning) {
  const events = [];
  await streamSessionUsageFileEvents(filePath, home, (event) => {
    events.push({
      t: event.timestampMs,
      s: intern(event.sessionId),
      h: intern(event.homeId),
      l: intern(event.homeLabel),
      c: intern(event.channel),
      p: intern(event.project),
      rk: intern(event.repositoryKey),
      rp: intern(event.repositoryPath),
      rt: intern(event.repositoryKind),
      m: intern(event.model),
      total: event.usage.total,
      input: event.usage.input,
      cached: event.usage.cached,
      output: event.usage.output,
      reasoning: event.usage.reasoning,
      detailMask: event.detailMask,
      reconciliationGap: event.reconciliationGap,
      cacheWriteTokens: event.cacheWriteTokens,
      cacheWriteKnown: event.cacheWriteKnown,
      requestInputTokens: event.requestInputTokens,
      contextLevel: intern(event.contextLevel),
      serviceTier: intern(event.serviceTier),
      priceVersion: intern(event.priceVersion),
    });
  }, { repositoryResolver: resolveRepository, previousCumulativeForSession, onRateLimit, onWarning });
  return events;
}

async function parseProjectUsageLogFileForIndex(filePath, source, intern, resolveRepository) {
  const events = [];
  await streamProjectUsageFileEvents(filePath, source, (event) => {
    events.push({
      t: event.timestampMs,
      s: intern(event.sessionId),
      h: intern(event.homeId),
      l: intern(event.homeLabel),
      c: intern(event.channel),
      p: intern(event.project),
      rk: intern(event.repositoryKey),
      rp: intern(event.repositoryPath),
      rt: intern(event.repositoryKind),
      m: intern(event.model),
      total: event.usage.total,
      input: event.usage.input,
      cached: event.usage.cached,
      output: event.usage.output,
      reasoning: event.usage.reasoning,
      detailMask: event.detailMask,
      reconciliationGap: event.reconciliationGap,
      cacheWriteTokens: event.cacheWriteTokens,
      cacheWriteKnown: event.cacheWriteKnown,
      requestInputTokens: event.requestInputTokens,
      contextLevel: intern(event.contextLevel),
      serviceTier: intern(event.serviceTier),
      priceVersion: intern(event.priceVersion),
    });
  }, { repositoryResolver: resolveRepository });
  return events;
}

async function parseZcodeDbForIndex(dbFile, source, intern, resolveRepository) {
  const events = [];
  await streamZcodeDbEvents(dbFile, source, (event) => {
    events.push({
      t: event.timestampMs,
      s: intern(event.sessionId),
      h: intern(event.homeId),
      l: intern(event.homeLabel),
      c: intern(event.channel),
      p: intern(event.project),
      rk: intern(event.repositoryKey),
      rp: intern(event.repositoryPath),
      rt: intern(event.repositoryKind),
      m: intern(event.model),
      total: event.usage.total,
      input: event.usage.input,
      cached: event.usage.cached,
      output: event.usage.output,
      reasoning: event.usage.reasoning,
      detailMask: event.detailMask,
      reconciliationGap: event.reconciliationGap,
      cacheWriteTokens: event.cacheWriteTokens,
      cacheWriteKnown: event.cacheWriteKnown,
      requestInputTokens: event.requestInputTokens,
      contextLevel: intern(event.contextLevel),
      serviceTier: intern(event.serviceTier),
      priceVersion: intern(event.priceVersion),
    });
  }, { repositoryResolver: resolveRepository });
  return events;
}

export async function buildUsageReport(options = {}) {
  const homes = options.homes || (await discoverUsageSources(options));
  const repositoryResolver = createRepositoryResolver();
  const sessions = [];
  const events = [];
  const rateLimitObservations = [];
  const warnings = [];

  for (const home of homes) {
    if (home.kind === "project-log" && home.usageLogPath) {
      try {
        const parsed = await parseProjectUsageLogFile(home.usageLogPath, home, { repositoryResolver });
        sessions.push(...parsed.sessions);
        events.push(...parsed.events);
      } catch (error) {
        warnings.push(`无法解析 ${home.usageLogPath}: ${error.message}`);
      }
      continue;
    }

    if (home.kind === "zcode" && home.usageLogPath) {
      try {
        const parsed = await parseZcodeDb(home.usageLogPath, home, { repositoryResolver });
        sessions.push(...parsed.sessions);
        events.push(...parsed.events);
      } catch (error) {
        warnings.push(`无法解析 ${home.usageLogPath}: ${error.message}`);
      }
      continue;
    }

    const threadNames = await readSessionThreadNames(home.path);
    const previousBySession = new Map();
    let files = [];
    try {
      files = await discoverSessionFiles(home.path);
    } catch (error) {
      warnings.push(`无法读取 ${home.path}: ${error.message}`);
      continue;
    }

    for (const file of files) {
      try {
        const parsed = await parseSessionFile(file, home, {
          repositoryResolver,
          threadNames,
          previousCumulativeForSession: (sessionId) => previousBySession.get(sessionId),
          onWarning: (warning) => warnings.push(warning),
        });
        if (!parsed) {
          continue;
        }
        if (parsed.session) sessions.push(parsed.session);
        events.push(...parsed.events);
        rateLimitObservations.push(...parsed.rateLimitObservations);
        for (const event of parsed.events) {
          rememberSessionUsage(previousBySession, event.sessionId, event.total, event.detailMask, event.cacheWriteTokens, event.cacheWriteKnown);
        }
      } catch (error) {
        warnings.push(`无法解析 ${file}: ${error.message}`);
      }
    }
  }

  const tierEvidence = loadServiceTierEvidence(homes);
  for (const event of events) {
    event.serviceTier = tierEvidence.resolve(event.sessionId, Date.parse(event.timestamp), event.serviceTier);
  }
  events.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  sessions.sort((a, b) => Date.parse(a.lastAt) - Date.parse(b.lastAt));

  return {
    generatedAt: new Date().toISOString(),
    homes,
    sessions,
    events,
    rateLimitObservations,
    warnings,
  };
}

export async function buildUsageIndex(options = {}) {
  const homes = options.homes || (await discoverUsageSources(options));
  const repositoryResolver = createRepositoryResolver();
  const warnings = [];
  const events = [];
  const rateLimitObservations = [];
  const interner = createStringInterner();

  for (const home of homes) {
    if (home.kind === "project-log" && home.usageLogPath) {
      try {
        events.push(...(await parseProjectUsageLogFileForIndex(home.usageLogPath, home, interner.intern, repositoryResolver)));
      } catch (error) {
        warnings.push(`无法解析 ${home.usageLogPath}: ${error.message}`);
      }
      continue;
    }

    if (home.kind === "zcode" && home.usageLogPath) {
      try {
        events.push(...(await parseZcodeDbForIndex(home.usageLogPath, home, interner.intern, repositoryResolver)));
      } catch (error) {
        warnings.push(`无法解析 ${home.usageLogPath}: ${error.message}`);
      }
      continue;
    }

    const previousBySession = new Map();
    let files = [];
    try {
      files = await discoverSessionFiles(home.path);
    } catch (error) {
      warnings.push(`无法读取 ${home.path}: ${error.message}`);
      continue;
    }

    for (const file of files) {
      try {
      const parsed = await parseSessionFileForIndex(file, home, interner.intern, repositoryResolver,
          (sessionId) => previousBySession.get(sessionId),
          (observation) => rateLimitObservations.push(observation),
          (warning) => warnings.push(warning));
        events.push(...parsed);
        for (const event of parsed) {
          rememberSessionUsage(previousBySession, interner.values[event.s], event, event.detailMask, event.cacheWriteTokens, event.cacheWriteKnown);
        }
      } catch (error) {
        warnings.push(`无法解析 ${file}: ${error.message}`);
      }
    }
  }

  const tierEvidence = loadServiceTierEvidence(homes);
  for (const event of events) {
    const tier = tierEvidence.resolve(interner.values[event.s], event.t, interner.values[event.serviceTier]);
    event.serviceTier = interner.intern(tier);
  }
  events.sort((a, b) => a.t - b.t);

  return {
    generatedAt: new Date().toISOString(),
    homes,
    warnings,
    strings: interner.values,
    events,
    rateLimitObservations,
    sessionCount: new Set(events.map((event) => event.s)).size,
  };
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function startOfLocalWeek(date) {
  const start = startOfLocalDay(date);
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return start;
}

function addLocalDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function parseDateStart(value) {
  return value ? new Date(`${value}T00:00:00`) : null;
}

function parseDateEnd(value) {
  return value ? new Date(`${value}T23:59:59.999`) : null;
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function subtractMonthsClamped(date, months) {
  const target = new Date(date.getFullYear(), date.getMonth() - months, 1);
  const day = Math.min(date.getDate(), daysInMonth(target.getFullYear(), target.getMonth()));
  return new Date(
    target.getFullYear(),
    target.getMonth(),
    day,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
}

function parseRecentValue(value) {
  const normalized = String(value || "").trim().replace(/\s+/g, "");
  if (normalized === "半年") {
    return { months: 6 };
  }
  if (normalized === "一年") {
    return { months: 12 };
  }
  const dayMatch = normalized.match(/^([1-9]\d*)天$/);
  if (dayMatch) {
    return { days: Number(dayMatch[1]) };
  }
  const weekMatch = normalized.match(/^([1-9]\d*)周$/);
  if (weekMatch) {
    return { days: Number(weekMatch[1]) * 7 };
  }
  const monthMatch = normalized.match(/^([1-9]\d*)个月$/);
  if (monthMatch) {
    return { months: Number(monthMatch[1]) };
  }
  const yearMatch = normalized.match(/^([1-9]\d*)年$/);
  if (yearMatch) {
    return { months: Number(yearMatch[1]) * 12 };
  }
  return null;
}

function recentDateRange(value, now) {
  const parsed = parseRecentValue(value);
  if (!parsed) {
    return null;
  }
  if (parsed.days === 1) {
    return {
      start: new Date(now.getTime() - MS_PER_DAY),
      end: now,
      preset: "recent",
      rolling: true,
    };
  }
  const start = parsed.days
    ? addLocalDays(startOfLocalDay(now), 1 - parsed.days)
    : startOfLocalDay(subtractMonthsClamped(now, parsed.months));
  return {
    start,
    end: endOfLocalDay(now),
    preset: "recent",
  };
}

export function resolveDateRange(filters = {}, events = []) {
  return resolveDateRangeFromTimestamps(
    filters,
    events.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite),
  );
}

function resolveDateRangeFromTimestamps(filters = {}, timestamps = []) {
  // Report and index summaries share this resolver to avoid date-range drift.
  const now = filters.now ? new Date(filters.now) : new Date();
  const preset = filters.preset || "all";
  if (!USAGE_PRESETS.includes(preset)) {
    throw new InvalidPresetError(preset);
  }
  if (isQuotaPreset(preset)) {
    const quota = filters.quota;
    const quotaWindow = quota?.windows?.[preset];
    if (quotaWindow?.state !== "available") {
      throw new QuotaWindowUnavailableError(preset, quota);
    }
    const windowStartMs = Date.parse(quotaWindow.windowStart || "");
    const windowEndExclusiveMs = Date.parse(quotaWindow.windowEndExclusive || "");
    const asOfMs = Date.parse(quota?.asOf || "");
    const expectedDuration = QUOTA_WINDOW_MINUTES[preset] * MS_PER_MINUTE;
    if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndExclusiveMs) || !Number.isFinite(asOfMs) ||
        windowEndExclusiveMs - windowStartMs !== expectedDuration || windowStartMs > asOfMs || asOfMs >= windowEndExclusiveMs) {
      throw new QuotaWindowUnavailableError(preset, {
        ...quota,
        windows: { ...quota?.windows, [preset]: unavailableQuotaWindow("ambiguous", "限额窗口边界无效。") },
      });
    }
    const effectiveEndExclusiveMs = Math.min(asOfMs, windowEndExclusiveMs);
    return {
      start: new Date(windowStartMs),
      // Existing event queries use inclusive ends. Subtracting one millisecond
      // preserves the required [start, effectiveEndExclusive) window.
      end: new Date(effectiveEndExclusiveMs - 1),
      endExclusive: new Date(effectiveEndExclusiveMs),
      windowEndExclusive: new Date(windowEndExclusiveMs),
      asOf: new Date(asOfMs),
      observedAt: quotaWindow.observedAt ? new Date(quotaWindow.observedAt) : null,
      usedPercent: quotaWindow.usedPercent ?? null,
      percentStale: Boolean(quotaWindow.percentStale),
      limitId: quota.limitId || null,
      quotaState: "available",
      quotaReason: null,
      quotaWindow: true,
      preset,
      rolling: false,
    };
  }
  if (preset === "today") {
    return { start: startOfLocalDay(now), end: endOfLocalDay(now), preset };
  }
  if (preset === "week") {
    return { start: startOfLocalWeek(now), end: endOfLocalDay(now), preset };
  }
  if (preset === "month") {
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1),
      end: endOfLocalDay(now),
      preset,
    };
  }
  if (preset === "custom") {
    return {
      start: parseDateStart(filters.startDate),
      end: parseDateEnd(filters.endDate),
      preset,
    };
  }
  if (preset === "recent") {
    const named = resolveNamedRecentRange(filters.recentValue, now, filters.quota);
    if (named) {
      if (named.quotaState === "missing") throw new QuotaWindowUnavailableError(named.quotaPreset, filters.quota);
      return named;
    }
    const range = recentDateRange(filters.recentValue, now);
    if (range) {
      return range;
    }
  }

  if (!timestamps.length) {
    return { start: null, end: null, preset: "all" };
  }
  let earliestTimestamp = timestamps[0];
  let latestTimestamp = timestamps[0];
  for (const timestamp of timestamps) {
    if (timestamp < earliestTimestamp) {
      earliestTimestamp = timestamp;
    }
    if (timestamp > latestTimestamp) {
      latestTimestamp = timestamp;
    }
  }
  return {
    start: startOfLocalDay(new Date(earliestTimestamp)),
    end: endOfLocalDay(new Date(latestTimestamp)),
    preset: "all",
  };
}

function groupByUsage(events, keyFn, options = {}) {
  const groups = new Map();
  for (const event of events) {
    const key = keyFn(event);
    const current = groups.get(key) || {
      key,
      name: key,
      count: 0,
      sessions: new Set(),
      total: emptyUsage(),
      channelGroups: options.includeChannels ? new Map() : null,
    };
    current.count += 1;
    current.sessions.add(event.sessionId);
    addUsage(current.total, event.total);
    if (current.channelGroups) {
      const channelKey = event.channel || "Unknown";
      const channel = current.channelGroups.get(channelKey) || {
        key: channelKey,
        name: channelKey,
        count: 0,
        sessions: new Set(),
        total: emptyUsage(),
      };
      channel.count += 1;
      channel.sessions.add(event.sessionId);
      addUsage(channel.total, event.total);
      current.channelGroups.set(channelKey, channel);
    }
    groups.set(key, current);
  }
  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      name: group.name,
      count: group.count,
      sessions: group.sessions.size,
      total: group.total,
      ...(group.channelGroups
        ? {
            channels: [...group.channelGroups.values()]
              .map((channel) => ({
                key: channel.key,
                name: channel.name,
                count: channel.count,
                sessions: channel.sessions.size,
                total: channel.total,
              }))
              .sort((a, b) => b.total.total - a.total.total),
          }
        : {}),
    }))
    .sort((a, b) => b.total.total - a.total.total);
}

function groupRepositories(events) {
  const groups = new Map();
  for (const event of events) {
    const key = event.repositoryKey || `directory:${event.cwd || "Unknown cwd"}`;
    const group = groups.get(key) || {
      key,
      name: event.repositoryPath || event.cwd || "Unknown cwd",
      count: 0,
      sessions: new Set(),
      pathCount: 0,
      pathSet: new Set(),
      kind: event.repositoryKind || "directory",
      total: emptyUsage(),
    };
    const repositoryPath = event.repositoryPath || event.cwd || "Unknown cwd";
    if (repositoryPath < group.name) group.name = repositoryPath;
    group.count += 1;
    group.sessions.add(event.sessionId);
    if (event.cwd) {
      group.pathSet.add(event.cwd);
    }
    addUsage(group.total, event.total);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const { sessions, pathSet, ...row } = group;
      return {
        ...row,
        sessions: sessions.size,
        sessionIds: [...sessions],
        pathCount: pathSet.size,
      };
    })
    .sort((a, b) => b.total.total - a.total.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function indexDateRange(filters = {}, events = []) {
  return resolveDateRangeFromTimestamps(
    filters,
    events.map((event) => event.t).filter(Number.isFinite),
  );
}

function addIndexedUsage(target, event) {
  for (const field of USAGE_FIELDS) {
    target[field] += event[field] || 0;
  }
  return target;
}

function groupIndexedEvents(index, events, keyFn, options = {}) {
  const groups = new Map();
  for (const event of events) {
    const key = keyFn(event) || "Unknown";
    const current = groups.get(key) || {
      key,
      name: key,
      count: 0,
      sessions: new Set(),
      total: emptyUsage(),
      channelGroups: options.includeChannels ? new Map() : null,
    };
    current.count += 1;
    current.sessions.add(event.s);
    addIndexedUsage(current.total, event);
    if (current.channelGroups) {
      const channelKey = index.strings[event.c] || "Unknown";
      const channel = current.channelGroups.get(channelKey) || {
        key: channelKey,
        name: channelKey,
        count: 0,
        sessions: new Set(),
        total: emptyUsage(),
      };
      channel.count += 1;
      channel.sessions.add(event.s);
      addIndexedUsage(channel.total, event);
      current.channelGroups.set(channelKey, channel);
    }
    groups.set(key, current);
  }
  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      name: group.name,
      count: group.count,
      sessions: group.sessions.size,
      total: group.total,
      ...(group.channelGroups
        ? {
            channels: [...group.channelGroups.values()]
              .map((channel) => ({
                key: channel.key,
                name: channel.name,
                count: channel.count,
                sessions: channel.sessions.size,
                total: channel.total,
              }))
              .sort((a, b) => b.total.total - a.total.total),
          }
        : {}),
    }))
    .sort((a, b) => b.total.total - a.total.total);
}

function groupIndexedRepositories(index, events) {
  const groups = new Map();
  for (const event of events) {
    const strings = index.strings;
    const key = strings[event.rk] || `directory:${strings[event.p] || "Unknown cwd"}`;
    const group = groups.get(key) || {
      key,
      name: strings[event.rp] || strings[event.p] || "Unknown cwd",
      kind: strings[event.rt] || "directory",
      count: 0,
      sessions: new Set(),
      pathSet: new Set(),
      total: emptyUsage(),
    };
    const repositoryPath = strings[event.rp] || strings[event.p] || "Unknown cwd";
    if (repositoryPath < group.name) group.name = repositoryPath;
    group.count += 1;
    group.sessions.add(event.s);
    const cwd = strings[event.p];
    if (cwd) {
      group.pathSet.add(cwd);
    }
    addIndexedUsage(group.total, event);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const { sessions, pathSet, ...row } = group;
      return {
        ...row,
        sessions: sessions.size,
        sessionIds: [...sessions].map((sessionId) => index.strings[sessionId] || String(sessionId)),
        pathCount: pathSet.size,
      };
    })
    .sort((a, b) => b.total.total - a.total.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function usageIndexMetadata(index) {
  const homeStats = homeStatsFromIndex(index);
  return {
    generatedAt: index.generatedAt,
    eventCount: index.events.length,
    sessionCount: index.sessionCount,
    homeCount: index.homes.length,
    homes: index.homes.map((home) => ({
      ...home,
      ...(homeStats.get(home.id) || {
        status: "no-events",
        eventCount: 0,
        sessionCount: 0,
      }),
    })),
    warnings: index.warnings,
  };
}

function homeStatsFromIndex(index) {
  // Attach per-home activity counts without expanding the compact index into full events.
  const stats = new Map();
  for (const event of index.events) {
    const homeId = index.strings[event.h] || "";
    const current = stats.get(homeId) || {
      status: "active",
      eventCount: 0,
      sessions: new Set(),
    };
    current.eventCount += 1;
    current.sessions.add(event.s);
    stats.set(homeId, current);
  }
  return new Map(
    [...stats.entries()].map(([homeId, stat]) => [
      homeId,
      {
        status: stat.eventCount > 0 ? "active" : "no-events",
        eventCount: stat.eventCount,
        sessionCount: stat.sessions.size,
      },
    ]),
  );
}

export function previousUsageRange(range) {
  if (!range.start || !range.end || range.preset === "all") {
    return null;
  }
  if (range.preset === "today") {
    const previousDay = addLocalDays(startOfLocalDay(range.start), -1);
    return {
      start: previousDay,
      end: endOfLocalDay(previousDay),
    };
  }
  if (range.preset === "week") {
    const previousWeekStart = addLocalDays(startOfLocalWeek(range.start), -7);
    return {
      start: previousWeekStart,
      end: endOfLocalDay(addLocalDays(previousWeekStart, 6)),
    };
  }
  if (range.preset === "month") {
    const currentMonthStart = new Date(range.start.getFullYear(), range.start.getMonth(), 1);
    return {
      start: new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() - 1, 1),
      end: endOfLocalDay(new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth(), 0)),
    };
  }
  const durationMs = range.end.getTime() - range.start.getTime() + 1;
  return {
    start: new Date(range.start.getTime() - durationMs),
    end: new Date(range.start.getTime() - 1),
  };
}

function rangeDurationMs(range) {
  if (!range?.start || !range?.end) {
    return 0;
  }
  return Math.max(0, range.end.getTime() - range.start.getTime() + 1);
}

function currentElapsedMs(range, now) {
  if (!range?.start || !range?.end || Number.isNaN(now?.getTime())) {
    return rangeDurationMs(range);
  }
  const boundedEnd = Math.min(range.end.getTime(), Math.max(range.start.getTime(), now.getTime()));
  return Math.max(0, boundedEnd - range.start.getTime() + 1);
}

function averageTrend(currentTotals, previousTotals, range, previousRange, now) {
  const previousDurationMs = rangeDurationMs(previousRange);
  const elapsedMs = currentElapsedMs(range, now);
  const averageBaselineTotal = previousDurationMs
    ? Math.round((previousTotals.total * elapsedMs) / previousDurationMs)
    : 0;
  return {
    averageBaselineTotal,
    averageDelta: currentTotals.total - averageBaselineTotal,
    averagePercentChange: percentChange(currentTotals.total, averageBaselineTotal),
  };
}

function percentChange(current, previous) {
  if (!previous) {
    return null;
  }
  return Math.round(((current - previous) / previous) * 10_000) / 100;
}

function comparisonLabel(preset) {
  return {
    today: "较昨日",
    week: "较上周",
    month: "较上月",
    custom: "较上一等长周期",
    recent: "较上一等长周期",
  }[preset] || "暂无对比";
}

function usageComparison({ range, allEvents, eventTime, eventSession, addEventUsage, currentTotals, now }) {
  // 保持调用方事件结构不变，只在这里统一计算上一周期和趋势。
  const previousRange = previousUsageRange(range);
  if (!previousRange) {
    return usageComparisonFromAggregates({ range, currentTotals, now });
  }
  const previousEvents = allEvents.filter((event) => {
    const time = eventTime(event);
    return Number.isFinite(time) && time >= previousRange.start.getTime() && time <= previousRange.end.getTime();
  });
  const previousTotals = previousEvents.reduce((sum, event) => addEventUsage(sum, event), emptyUsage());
  const previousSessions = new Set(previousEvents.map(eventSession));
  return usageComparisonFromAggregates({
    range,
    currentTotals,
    previousTotals,
    previousEventCount: previousEvents.length,
    previousSessionCount: previousSessions.size,
    now,
  });
}

export function usageComparisonFromAggregates({
  range,
  currentTotals,
  previousTotals = emptyUsage(),
  previousEventCount = 0,
  previousSessionCount = 0,
  now,
}) {
  const previousRange = previousUsageRange(range);
  if (!previousRange) {
    return {
      label: comparisonLabel(range.preset),
      previousRange: null,
      previousTotals: emptyUsage(),
      previousEventCount: 0,
      previousSessionCount: 0,
      totalDelta: currentTotals.total,
      percentChange: null,
      averageBaselineTotal: 0,
      averageDelta: currentTotals.total,
      averagePercentChange: null,
    };
  }
  const average = averageTrend(currentTotals, previousTotals, range, previousRange, now);

  return {
    label: comparisonLabel(range.preset),
    previousRange: {
      start: previousRange.start.toISOString(),
      end: previousRange.end.toISOString(),
    },
    previousTotals,
    previousEventCount,
    previousSessionCount,
    totalDelta: currentTotals.total - previousTotals.total,
    percentChange: percentChange(currentTotals.total, previousTotals.total),
    ...average,
  };
}

export const COMPARISON_PERIOD_KEYS = ["today", "week", "month", "all"];

function emptyPeriodMetrics() {
  return {
    total: 0,
    input: 0,
    inputUnavailableTokens: 0,
    cached: 0,
    cachedUnavailableTokens: 0,
    uncachedInput: 0,
    uncachedInputUnavailableTokens: 0,
    cacheRateInput: 0,
    cacheRateCached: 0,
    output: 0,
    outputUnavailableTokens: 0,
    reasoning: 0,
    reasoningUnavailableTokens: 0,
    unattributedDetailTokens: 0,
    inconsistentTokens: 0,
    reconciliationGap: 0,
  };
}

function addPeriodEvent(target, event) {
  const usage = event.total || emptyUsage();
  const total = Number(usage.total || 0);
  const mask = Number.isInteger(event.detailMask) ? event.detailMask : USAGE_DETAIL_MASK.complete;
  target.total += total;
  if (mask & USAGE_DETAIL_MASK.input) {
    target.input += Number(usage.input || 0);
  } else {
    target.inputUnavailableTokens += total;
  }
  if (mask & USAGE_DETAIL_MASK.cached) {
    target.cached += Number(usage.cached || 0);
  } else {
    target.cachedUnavailableTokens += total;
  }
  if ((mask & (USAGE_DETAIL_MASK.input | USAGE_DETAIL_MASK.cached)) === (USAGE_DETAIL_MASK.input | USAGE_DETAIL_MASK.cached)) {
    target.uncachedInput += Math.max(0, Number(usage.input || 0) - Number(usage.cached || 0));
    target.cacheRateInput += Number(usage.input || 0);
    target.cacheRateCached += Number(usage.cached || 0);
  } else {
    target.uncachedInputUnavailableTokens += total;
  }
  if (mask & USAGE_DETAIL_MASK.output) {
    target.output += Number(usage.output || 0);
  } else {
    target.outputUnavailableTokens += total;
  }
  if (mask & USAGE_DETAIL_MASK.reasoning) {
    target.reasoning += Number(usage.reasoning || 0);
  } else {
    target.reasoningUnavailableTokens += total;
  }
  if ((mask & USAGE_DETAIL_MASK.complete) !== USAGE_DETAIL_MASK.complete) {
    target.unattributedDetailTokens += total;
  }
  if (mask & USAGE_DETAIL_INCONSISTENT) {
    target.inconsistentTokens += total;
  }
  target.reconciliationGap += Number(event.reconciliationGap || 0);
}

function comparisonRow(map, key, name, event, periodKeys, { includeRepositoryMetadata = false } = {}) {
  let row = map.get(key);
  if (!row) {
    row = {
      key,
      name,
      ...(includeRepositoryMetadata
        ? { kind: event.repositoryKind || "directory", pathSet: new Set() }
        : {}),
      periods: Object.fromEntries(periodKeys.map((period) => [period, emptyPeriodMetrics()])),
    };
    map.set(key, row);
  } else if (includeRepositoryMetadata && name < row.name) {
    row.name = name;
  }
  if (includeRepositoryMetadata && event.cwd) {
    row.pathSet.add(event.cwd);
  }

  return row;
}

export function summarizePeriodComparison(events = [], options = {}) {
  const asOf = options.now ? new Date(options.now) : new Date();
  const timestamps = events
    .map((event) => ({ timestamp: event.timestamp }))
    .filter((event) => Number.isFinite(Date.parse(event.timestamp)));
  const ranges = Object.fromEntries(
    COMPARISON_PERIOD_KEYS.map((key) => [key, resolveDateRange({ preset: key, now: asOf }, timestamps)]),
  );
  const rows = { models: new Map(), repositories: new Map() };
  const totals = Object.fromEntries(COMPARISON_PERIOD_KEYS.map((key) => [key, emptyPeriodMetrics()]));

  for (const event of events) {
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp)) {
      continue;
    }
    const modelKey = event.model || "Unknown model";
    const repositoryKey = event.repositoryKey || `directory:${event.cwd || "Unknown cwd"}`;
    const modelRow = comparisonRow(rows.models, modelKey, modelKey, event, COMPARISON_PERIOD_KEYS);
    const repositoryRowKey = repositoryKey;
    const repositoryName = event.repositoryPath || event.cwd || "Unknown cwd";
    const repositoryRow = comparisonRow(rows.repositories, repositoryRowKey, repositoryName, event, COMPARISON_PERIOD_KEYS, {
      includeRepositoryMetadata: true,
    });

    for (const period of COMPARISON_PERIOD_KEYS) {
      const range = ranges[period];
      if ((range.start && timestamp < range.start.getTime()) || (range.end && timestamp > range.end.getTime())) {
        continue;
      }
      addPeriodEvent(totals[period], event);
      addPeriodEvent(modelRow.periods[period], event);
      addPeriodEvent(repositoryRow.periods[period], event);
    }
  }

  function sortedRows(map) {
    return [...map.values()]
      .map((row) => {
        const { pathSet, ...result } = row;
        return pathSet
          ? { ...result, pathCount: pathSet.size }
          : result;
      })
      .sort((a, b) => b.periods.all.total - a.periods.all.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  return {
    asOf: asOf.toISOString(),
    periods: COMPARISON_PERIOD_KEYS.map((key) => ({
      key,
      start: ranges[key].start?.toISOString() || null,
      end: ranges[key].end?.toISOString() || null,
    })),
    totals,
    models: sortedRows(rows.models),
    repositories: sortedRows(rows.repositories),
  };
}

function buildTimelineRowsWithLimit(events, range, bucket, options = {}) {
  try {
    return { timeline: buildTimelineRows(events, range, bucket, options), timelineError: null };
  } catch (error) {
    if (error.code !== "TIMELINE_RANGE_TOO_LARGE") throw error;
    return { timeline: [], timelineError: error.message };
  }
}

function summaryQuotaContext(observations, filters) {
  const initialAsOf = filters.quota?.asOf || filters.now || new Date();
  const quota = filters.quota || selectQuotaWindows(observations || [], initialAsOf);
  return { quota, asOf: new Date(quota.asOf) };
}

function summaryRangeFields(range, bucket) {
  return {
    preset: range.preset,
    start: range.start ? range.start.toISOString() : null,
    end: range.end ? range.end.toISOString() : null,
    bucket,
    rolling: Boolean(range.rolling),
    ...(range.quotaWindow ? {
      quotaWindow: true, recentValue: range.recentValue, quotaPreset: range.quotaPreset,
      asOf: range.asOf.toISOString(),
      windowStart: range.start.toISOString(),
      windowEndExclusive: range.windowEndExclusive.toISOString(),
      observedAt: range.observedAt?.toISOString() || null,
      usedPercent: range.usedPercent,
      percentStale: range.percentStale,
      limitId: range.limitId,
      quotaState: range.quotaState,
      quotaReason: range.quotaReason,
    } : {}),
  };
}

export function summarizeUsageIndex(index, filters = {}) {
  const strings = index.strings;
  const { quota, asOf } = summaryQuotaContext(index.rateLimitObservations, filters);
  const range = indexDateRange({ ...filters, quota, now: asOf }, index.events);
  const quotaPreset = isQuotaPreset(range.preset) || Boolean(range.quotaWindow);
  const bucket = range.bucket || (quotaPreset ? range.preset === "quota_5h" ? "quota_30m" : "quota_24h" : filters.bucket || "day");
  const now = range.asOf || asOf;
  const events = index.events.filter((event) => {
    if (!Number.isFinite(event.t)) {
      return false;
    }
    if (range.start && event.t < range.start.getTime()) {
      return false;
    }
    if (range.end && event.t > range.end.getTime()) {
      return false;
    }
    return true;
  });

  const sessionIds = new Set(events.map((event) => event.s));
  const totals = events.reduce((sum, event) => addIndexedUsage(sum, event), emptyUsage());
  const comparison = quotaPreset ? null : usageComparison({
    range,
    allEvents: index.events,
    eventTime: (event) => event.t,
    eventSession: (event) => event.s,
    addEventUsage: addIndexedUsage,
    currentTotals: totals,
    now,
  });
  function* timelineEvents() {
    for (const event of events) {
      yield {
        timestamp: event.t,
        sessionId: strings[event.s] || String(event.s),
        channel: strings[event.c] || "Unknown",
        model: strings[event.m] || "Unknown model",
        total: { total: event.total, input: event.input, cached: event.cached, output: event.output, reasoning: event.reasoning },
        detailMask: event.detailMask,
        cacheWriteTokens: event.cacheWriteTokens,
        cacheWriteKnown: Boolean(event.cacheWriteKnown),
        contextLevel: strings[event.contextLevel] || event.contextLevel,
        requestInputTokens: event.requestInputTokens,
        serviceTier: strings[event.serviceTier] || event.serviceTier,
        priceVersion: strings[event.priceVersion] || event.priceVersion,
      };
    }
  }
  const costAccumulator = createCostEstimateAccumulator();
  const { timeline, timelineError } = buildTimelineRowsWithLimit(
    timelineEvents(),
    range,
    bucket,
    {
      estimateCost: estimateEventCost,
      onEstimate: (event, estimate) => costAccumulator.add(event, estimate),
    },
  );
  const costEstimate = timelineError
    ? estimateCostForEvents(timelineEvents())
    : costAccumulator.result();

  return {
    generatedAt: index.generatedAt,
    range: summaryRangeFields(range, bucket),
    totals,
    comparison,
    quota,
    costEstimate,
    eventCount: events.length,
    sessionCount: sessionIds.size,
    homeCount: new Set(events.map((event) => event.h)).size,
    timeline,
    timelineError,
    channels: groupIndexedEvents(index, events, (event) => strings[event.c]),
    homes: groupIndexedEvents(index, events, (event) => strings[event.l]),
    models: groupIndexedEvents(index, events, (event) => strings[event.m] || "Unknown model"),
    projects: groupIndexedEvents(index, events, (event) => strings[event.p] || "Unknown cwd"),
    repositories: groupIndexedRepositories(index, events),
  };
}

export function summarizeUsage(report, filters = {}) {
  const { quota, asOf } = summaryQuotaContext(report.rateLimitObservations, filters);
  const range = resolveDateRange({ ...filters, quota, now: asOf }, report.events);
  const quotaPreset = isQuotaPreset(range.preset) || Boolean(range.quotaWindow);
  const bucket = range.bucket || (quotaPreset ? range.preset === "quota_5h" ? "quota_30m" : "quota_24h" : filters.bucket || "day");
  const now = range.asOf || asOf;
  const events = report.events.filter((event) => {
    const date = new Date(event.timestamp);
    if (Number.isNaN(date.getTime())) {
      return false;
    }
    if (range.start && date < range.start) {
      return false;
    }
    if (range.end && date > range.end) {
      return false;
    }
    return true;
  });

  const sessionIds = new Set(events.map((event) => event.sessionId));
  const totals = events.reduce((sum, event) => addUsage(sum, event.total), emptyUsage());
  const comparison = quotaPreset ? null : usageComparison({
    range,
    allEvents: report.events,
    eventTime: (event) => Date.parse(event.timestamp),
    eventSession: (event) => event.sessionId,
    addEventUsage: (sum, event) => addUsage(sum, event.total),
    currentTotals: totals,
    now,
  });
  const costAccumulator = createCostEstimateAccumulator();
  const { timeline, timelineError } = buildTimelineRowsWithLimit(
    events,
    range,
    bucket,
    {
      estimateCost: estimateEventCost,
      onEstimate: (event, estimate) => costAccumulator.add(event, estimate),
    },
  );
  const costEstimate = timelineError ? estimateCostForEvents(events) : costAccumulator.result();

  return {
    generatedAt: report.generatedAt,
    range: summaryRangeFields(range, bucket),
    totals,
    comparison,
    quota,
    costEstimate,
    eventCount: events.length,
    sessionCount: sessionIds.size,
    homeCount: new Set(events.map((event) => event.homeId)).size,
    timeline,
    timelineError,
    channels: groupByUsage(events, (event) => event.channel),
    homes: groupByUsage(events, (event) => event.homeLabel),
    models: groupByUsage(events, (event) => event.model || "Unknown model"),
    projects: groupByUsage(events, (event) => event.cwd || "Unknown cwd"),
    repositories: groupRepositories(events),
  };
}
