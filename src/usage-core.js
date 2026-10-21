import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRepositoryResolver } from "./repository-identity.js";
import { readRolloutLines, plainRolloutPath } from "./codex-rollout.js";
import {
  createCostEstimateAccumulator,
  estimateCostForEvents,
  estimateEventCost,
  LONG_CONTEXT_INPUT_THRESHOLD,
  pricingVersionForTimestamp,
} from "./pricing.js";
import { loadServiceTierEvidence } from "./service-tier-evidence.js";
import { isCodexAutoReview } from "../public/pricing-models.js";
import {
  USAGE_DETAIL_MASK,
  USAGE_FIELDS,
  emptyUsage,
  isZeroUsage,
  validateUsageDetails,
} from "../public/usage-fields.js";
import { streamZcodeDbEvents, parseZcodeDb, zcodeDatabaseFile, zcodeSourceStat } from "./zcode-usage.js";
import { dshSessionFiles, dshHomeLooksUsable, parseDshSessions, streamDshSessionEvents } from "./dsh-usage.js";
import {
  claudeHomeLooksUsable,
  claudeSessionFiles,
  parseClaudeSessions,
  streamClaudeSessionEvents,
} from "./claude-code-usage.js";
import {
  parseWorkbuddySessions,
  streamWorkbuddySessionEvents,
  workbuddyHomeLooksUsable,
  workbuddySessionFiles,
} from "./workbuddy-usage.js";
import {
  opencodeDatabaseFiles,
  opencodeHomeLooksUsable,
  opencodeSourceStat,
  parseOpencodeDb,
  streamOpencodeDbEvents,
} from "./opencode-usage.js";
// ── M4.1：内存性能候选载体需要 M1 的冻结口径与 M3 的来源调度器（**只读导入**）──────────
// ⚠️ 这里**只导入**、**不修改** M3 拥有的 `perf-sources/index.js`（其注册表就是"哪些来源已启用"
// 的**唯一**判据）；也不修改 M3 的 `usage-store.js`（该文件正在第三轮外部复验，
// 改动会作废已提交的 `E0A3BA46…` 哈希）。
import {
  canonicalPerfSourceKind,
  PERF_METHOD_VERSION,
  PERF_SOURCE_WARNING_CODES,
  summarizePerf,
} from "./perf-stats.js";
import { classifyPerfSources, isPerfSourceEnabled, streamPerfSamplesForFile } from "./perf-sources/index.js";
import {
  buildCodexThreadPerfSamples,
  codexSampleAllowed,
  createCodexPublishFilter,
  decodeCodexPublicationPolicy,
  encodeCodexPublicationPolicy,
  planCodexHomeThreads,
} from "./perf-sources/codex-thread.js";
import {
  buildTimelineRows,
  channelForRange,
  homeSourceKinds,
  deriveTimelineBucket,
  resolveNamedRecentRange,
  completedQuotaWindows,
} from "../public/timeline-utils.js";
import {
  COMPARISON_PERIOD_KEYS,
  MS_PER_DAY,
  calendarPresetRange,
  endOfLocalDay,
  startOfLocalDay,
  startOfLocalWeek,
  summarizePeriodComparison,
} from "../public/period-comparison.js";

export { COMPARISON_PERIOD_KEYS, summarizePeriodComparison };

const SESSION_DIRS = ["sessions", "archived_sessions"];
const PROJECT_USAGE_DIR = ".codex-usage";
const PROJECT_USAGE_FILE = "usage.jsonl";
const PROJECT_LOG_SCHEMA_VERSION = "codex-usage.project-log.v1";
const MS_PER_MINUTE = 60 * 1000;
const QUOTA_WINDOW_MINUTES = Object.freeze({ quota_5h: 300, quota_week: 10080 });
const QUOTA_PERCENT_STALE_AFTER_MS = 10 * 60 * 1000;
export const USAGE_PRESETS = Object.freeze([
  "today",
  "week",
  "month",
  "all",
  "recent",
  "custom",
  "quota_5h",
  "quota_week",
]);
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
  const known =
    Object.hasOwn(raw, "cache_write_input_tokens") &&
    value !== null &&
    value !== "" &&
    Number.isFinite(Number(value)) &&
    Number(value) >= 0;
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
  /** @type {Array<[keyof import("./usage-types.js").UsageTotals, number]>} */
  const detailFields = [
    ["input", USAGE_DETAIL_MASK.input],
    ["cached", USAGE_DETAIL_MASK.cached],
    ["output", USAGE_DETAIL_MASK.output],
    ["reasoning", USAGE_DETAIL_MASK.reasoning],
  ];
  for (const [field, bit] of detailFields) {
    if (lastMask & bit && (!(deltaMask & bit) || last[field] !== delta[field])) return false;
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
    const known =
      Object.hasOwn(raw, key) && value !== null && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;
    return known ? mask | (1 << index) : mask;
  }, 0);
}

function projectLogDetailMask(raw = {}) {
  const has = (...keys) =>
    keys.some((key) => {
      const value = raw[key];
      return (
        Object.hasOwn(raw, key) &&
        value !== null &&
        value !== "" &&
        Number.isFinite(Number(value)) &&
        Number(value) >= 0
      );
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

/** @param {number} currentMask @param {number} previousMask */
function diffUsage(
  current,
  previous,
  currentMask = USAGE_DETAIL_MASK.complete,
  previousMask = USAGE_DETAIL_MASK.complete,
) {
  const diff = emptyUsage();
  diff.total = Math.max(0, (current.total || 0) - (previous.total || 0));
  let detailMask = 0;
  /** @type {Array<[keyof import("./usage-types.js").UsageTotals, number]>} */
  const detailFields = [
    ["input", USAGE_DETAIL_MASK.input],
    ["cached", USAGE_DETAIL_MASK.cached],
    ["output", USAGE_DETAIL_MASK.output],
    ["reasoning", USAGE_DETAIL_MASK.reasoning],
  ];
  for (const [field, bit] of detailFields) {
    if (currentMask & bit && previousMask & bit) {
      diff[field] = Math.max(0, (current[field] || 0) - (previous[field] || 0));
      detailMask |= bit;
    }
  }
  return { usage: diff, detailMask };
}

function initialRequestUsage(cumulative, cumulativeMask, last, lastMask, diff, hasUsageInFile) {
  if (hasUsageInFile || !last || diff.total <= last.total || !last.total) return null;
  const required = USAGE_DETAIL_MASK.input | USAGE_DETAIL_MASK.output;
  if ((lastMask & required) !== required || (cumulativeMask & required) !== required) return null;
  for (const field of USAGE_FIELDS) {
    if (last[field] > cumulative[field]) return null;
  }
  // A new rollout can inherit a counter from its parent conversation. Only the
  // last request is attributable to this file when the first delta is larger.
  return { usage: last, detailMask: lastMask };
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
  // ZCode、DSH、OpenCode 与 Claude Code 的判据更具体，必须先于 Codex 判断。
  // codexHomeLooksUsable 只看「有没有 sessions 目录」，而 ~/.dsh/sessions 与 ~/.claude/sessions
  // 恰好同名，若先判 Codex，DSH/Claude home 会被误判成 codex-home。
  const zcodeDbFile = await zcodeDatabaseFile(resolved);
  if (zcodeDbFile) {
    return {
      type: "zcode-home",
      path: resolved,
      dbFile: zcodeDbFile,
    };
  }

  if (await dshHomeLooksUsable(resolved)) {
    return {
      type: "dsh-home",
      path: resolved,
    };
  }

  if (await opencodeHomeLooksUsable(resolved)) {
    return {
      type: "opencode-home",
      path: resolved,
    };
  }

  // WorkBuddy 必须判在 Claude Code **之前**：`~/.workbuddy-ai/projects/<slug>/*.jsonl` 会被
  // `claudeHomeLooksUsable` 的纯结构判据命中，靠内容（session-meta / function_call）才能区分。
  // 但也不能挪到 Codex 之前的最前面：ZCode/DSH/OpenCode 的判据更具体，保持现有相对次序。
  if (await workbuddyHomeLooksUsable(resolved)) {
    return {
      type: "workbuddy-home",
      path: resolved,
    };
  }

  if (await claudeHomeLooksUsable(resolved)) {
    return {
      type: "claude-home",
      path: resolved,
    };
  }

  if (await codexHomeLooksUsable(resolved)) {
    return {
      type: "codex-home",
      path: resolved,
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
    reason: `目录需要是 Codex home、ZCode home、DSH home、OpenCode 数据目录、Claude Code home、WorkBuddy home，或包含 ${PROJECT_USAGE_DIR}/${PROJECT_USAGE_FILE}`,
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
      await addHome(`JetBrains ${productName}`, path.join(jetbrainsRoot, productName, "aia", "codex"), "jetbrains");
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

export async function discoverDshHomes(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const envHomes = options.extraDshHomes || env.CODEX_USAGE_DSH_HOMES || "";
  const homes = [];
  const seen = new Set();

  if (env.CODEX_USAGE_DSH === "0") {
    return homes;
  }

  async function addHome(label, homePath) {
    const resolved = path.resolve(homePath);
    if (seen.has(resolved) || !(await dshHomeLooksUsable(resolved))) {
      return;
    }
    seen.add(resolved);
    // DSH 的用量分散在 sessions/**/session.v*.jsonl.zstd 多个文件里，
    // 不像 ZCode 那样有单一数据库，所以这里不设 usageLogPath。
    homes.push({
      id: sourceId("dsh", resolved),
      label,
      path: resolved,
      kind: "dsh",
    });
  }

  await addHome("Main DSH", path.join(homeDir, ".dsh"));

  for (const extraHome of envHomes.split(path.delimiter).filter(Boolean)) {
    await addHome(`DSH ${path.basename(extraHome) || extraHome}`, extraHome);
  }

  return homes;
}

function opencodeDataDirs({ homeDir, env }) {
  // OpenCode 数据目录因平台而异（Windows 本机实测为 XDG 风格路径），逐个探测。
  const dirs = [path.join(homeDir, ".local", "share", "opencode")];
  if (env.APPDATA) {
    dirs.push(path.join(env.APPDATA, "opencode"));
  }
  if (env.LOCALAPPDATA) {
    dirs.push(path.join(env.LOCALAPPDATA, "opencode"));
  }
  dirs.push(path.join(homeDir, "Library", "Application Support", "opencode"));
  return uniquePaths(dirs.filter(Boolean));
}

export async function discoverOpencodeHomes(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const envHomes = options.extraOpencodeHomes || env.CODEX_USAGE_OPENCODE_HOMES || "";
  const homes = [];
  const seen = new Set();

  if (env.CODEX_USAGE_OPENCODE === "0") {
    return homes;
  }

  async function addHome(label, homePath) {
    const resolved = path.resolve(homePath);
    if (seen.has(resolved) || !(await opencodeHomeLooksUsable(resolved))) {
      return;
    }
    seen.add(resolved);
    // 单个数据目录下可能有多个数据库（opencode.db、opencode-<channel>.db），
    // 用量在消费时按目录展开，所以这里不设 usageLogPath。
    homes.push({
      id: sourceId("opencode", resolved),
      label,
      path: resolved,
      kind: "opencode",
    });
  }

  for (const dataDir of opencodeDataDirs({ homeDir, env })) {
    await addHome("Main OpenCode", dataDir);
  }

  for (const extraHome of envHomes.split(path.delimiter).filter(Boolean)) {
    await addHome(`OpenCode ${path.basename(extraHome) || extraHome}`, extraHome);
  }

  return homes;
}

export async function discoverClaudeHomes(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const envHomes = options.extraClaudeHomes || env.CODEX_USAGE_CLAUDE_HOMES || "";
  const homes = [];
  const seen = new Set();

  if (env.CODEX_USAGE_CLAUDE === "0") {
    return homes;
  }

  async function addHome(label, homePath) {
    const resolved = path.resolve(homePath);
    if (seen.has(resolved) || !(await claudeHomeLooksUsable(resolved))) {
      return;
    }
    seen.add(resolved);
    // 用量分散在 projects/**/*.jsonl（含 subagents），不像 ZCode 那样有单一数据库。
    homes.push({
      id: sourceId("claude", resolved),
      label,
      path: resolved,
      kind: "claude",
    });
  }

  await addHome("Main Claude Code", path.join(homeDir, ".claude"));
  // CLAUDE_CONFIG_DIR 是 Claude Code 自己的 home 覆盖变量，与默认位置并存时都要发现。
  if (env.CLAUDE_CONFIG_DIR) {
    await addHome(
      `Claude Code ${path.basename(env.CLAUDE_CONFIG_DIR) || env.CLAUDE_CONFIG_DIR}`,
      env.CLAUDE_CONFIG_DIR,
    );
  }

  for (const extraHome of envHomes.split(path.delimiter).filter(Boolean)) {
    await addHome(`Claude Code ${path.basename(extraHome) || extraHome}`, extraHome);
  }

  return homes;
}

export async function discoverWorkbuddyHomes(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const envHomes = options.extraWorkbuddyHomes || env.CODEX_USAGE_WORKBUDDY_HOMES || "";
  const homes = [];
  const seen = new Set();

  if (env.CODEX_USAGE_WORKBUDDY === "0") {
    return homes;
  }

  async function addHome(label, homePath) {
    const resolved = path.resolve(homePath);
    if (seen.has(resolved) || !(await workbuddyHomeLooksUsable(resolved))) {
      return;
    }
    seen.add(resolved);
    // 用量分散在 projects/**/*.jsonl（含按会话分目录的转录），不像 ZCode 那样有单一数据库。
    homes.push({
      id: sourceId("workbuddy", resolved),
      label,
      path: resolved,
      kind: "workbuddy",
    });
  }

  await addHome("Main WorkBuddy", path.join(homeDir, ".workbuddy-ai"));

  for (const extraHome of envHomes.split(path.delimiter).filter(Boolean)) {
    await addHome(`WorkBuddy ${path.basename(extraHome) || extraHome}`, extraHome);
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

  for (const dshHome of await discoverDshHomes(options)) {
    if (seenPaths.has(dshHome.path)) {
      continue;
    }
    seenPaths.add(dshHome.path);
    sources.push(dshHome);
  }

  for (const opencodeHome of await discoverOpencodeHomes(options)) {
    if (seenPaths.has(opencodeHome.path)) {
      continue;
    }
    seenPaths.add(opencodeHome.path);
    sources.push(opencodeHome);
  }

  for (const claudeHome of await discoverClaudeHomes(options)) {
    if (seenPaths.has(claudeHome.path)) {
      continue;
    }
    seenPaths.add(claudeHome.path);
    sources.push(claudeHome);
  }

  for (const workbuddyHome of await discoverWorkbuddyHomes(options)) {
    if (seenPaths.has(workbuddyHome.path)) {
      continue;
    }
    seenPaths.add(workbuddyHome.path);
    sources.push(workbuddyHome);
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

    if (classified.type === "dsh-home") {
      if (seenPaths.has(classified.path)) {
        continue;
      }
      seenPaths.add(classified.path);
      sources.push({
        id: sourceId("dsh", classified.path),
        label: `DSH ${path.basename(classified.path) || classified.path}`,
        path: classified.path,
        kind: "dsh",
        imported: true,
      });
      continue;
    }

    if (classified.type === "opencode-home") {
      if (seenPaths.has(classified.path)) {
        continue;
      }
      seenPaths.add(classified.path);
      sources.push({
        id: sourceId("opencode", classified.path),
        label: `OpenCode ${path.basename(classified.path) || classified.path}`,
        path: classified.path,
        kind: "opencode",
        imported: true,
      });
      continue;
    }

    if (classified.type === "claude-home") {
      if (seenPaths.has(classified.path)) {
        continue;
      }
      seenPaths.add(classified.path);
      sources.push({
        id: sourceId("claude", classified.path),
        label: `Claude Code ${path.basename(classified.path) || classified.path}`,
        path: classified.path,
        kind: "claude",
        imported: true,
      });
      continue;
    }

    if (classified.type === "workbuddy-home") {
      if (seenPaths.has(classified.path)) {
        continue;
      }
      seenPaths.add(classified.path);
      sources.push({
        id: sourceId("workbuddy", classified.path),
        label: `WorkBuddy ${path.basename(classified.path) || classified.path}`,
        path: classified.path,
        kind: "workbuddy",
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
  try {
    await stat(root);
  } catch (error) {
    if (error?.code === "ENOENT") return files;
    throw error;
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".tmp" || entry.name === "node_modules") {
        continue;
      }
      await walkJsonlFiles(fullPath, files);
    } else if (entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.zst"))) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function discoverSessionFiles(homePath) {
  const groups = await Promise.all(SESSION_DIRS.map((dir) => walkJsonlFiles(path.join(homePath, dir), [])));
  const files = groups.flat().sort();
  const key = (file) => (process.platform === "win32" ? file.toLowerCase() : file);
  const paths = new Set(files.map(key));
  return files.filter((file) => file === plainRolloutPath(file) || !paths.has(key(plainRolloutPath(file))));
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
      const details = info || (await stat(filePath));
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
    if (home.kind === "dsh") {
      let sessionFiles;
      try {
        sessionFiles = await dshSessionFiles(home.path);
      } catch (error) {
        hash.update(`!discover-failed:${error.code || "unreadable"}\n`);
        continue;
      }
      for (const file of sessionFiles) await addFile(file);
      continue;
    }
    if (home.kind === "opencode") {
      // 单个数据目录下可能有多个数据库，逐个纳入指纹（含 -wal）。
      let dbFiles;
      try {
        dbFiles = await opencodeDatabaseFiles(home.path);
      } catch (error) {
        hash.update(`!discover-failed:${error.code || "unreadable"}\n`);
        continue;
      }
      for (const dbFile of dbFiles) {
        try {
          await addFile(dbFile, await opencodeSourceStat(dbFile));
        } catch (error) {
          hash.update(`!discover-failed:${error.code || "unreadable"}\n`);
        }
      }
      continue;
    }
    if (home.kind === "claude") {
      let sessionFiles;
      try {
        sessionFiles = await claudeSessionFiles(home.path);
      } catch (error) {
        hash.update(`!discover-failed:${error.code || "unreadable"}\n`);
        continue;
      }
      for (const file of sessionFiles) await addFile(file);
      continue;
    }
    if (home.kind === "workbuddy") {
      let sessionFiles;
      try {
        sessionFiles = await workbuddySessionFiles(home.path);
      } catch (error) {
        hash.update(`!discover-failed:${error.code || "unreadable"}\n`);
        continue;
      }
      for (const file of sessionFiles) await addFile(file);
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
  const normalize = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
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
  const base = path.basename(plainRolloutPath(filePath), ".jsonl");
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

/** @param {any} row @param {{ sourcePath?: string, lineNumber?: number, onWarning?: (warning: string) => void }} [options] */
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
    const windowMinutes =
      raw?.window_minutes === "" || raw?.window_minutes === null ? NaN : Number(raw?.window_minutes);
    const resetSeconds = raw?.resets_at === "" || raw?.resets_at === null ? NaN : Number(raw?.resets_at);
    const resetsAtMs = resetSeconds * 1000;
    const hasPercent =
      raw && Object.hasOwn(raw, "used_percent") && raw.used_percent !== null && raw.used_percent !== "";
    const usedPercent = hasPercent ? Number(raw.used_percent) : null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) reason = "窗口数据格式无效";
    else if (!Number.isFinite(observedAtMs)) reason = "观察时间无效";
    else if (rootLimitId && windowLimitId && rootLimitId !== windowLimitId) reason = "顶层与窗口 limit_id 冲突";
    else if (!limitId) reason = "limit_id 为空";
    else if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) reason = "window_minutes 必须是正数";
    else if (
      !Number.isFinite(resetSeconds) ||
      resetSeconds <= 0 ||
      !Number.isFinite(resetsAtMs) ||
      Number.isNaN(new Date(resetsAtMs).getTime())
    )
      reason = "resets_at 无效";
    else if (hasPercent && (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100))
      reason = "used_percent 必须在 0 到 100 之间";
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
      limitName:
        typeof rateLimits.limit_name === "string"
          ? rateLimits.limit_name
          : typeof raw.limit_name === "string"
            ? raw.limit_name
            : null,
      planType:
        typeof rateLimits.plan_type === "string"
          ? rateLimits.plan_type
          : typeof raw.plan_type === "string"
            ? raw.plan_type
            : null,
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
  const reasonCode =
    new Map([
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
  const asOfMs =
    asOfValue instanceof Date ? asOfValue.getTime() : typeof asOfValue === "number" ? asOfValue : Date.parse(asOfValue);
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
    return (
      typeof id === "string" &&
      id.trim() &&
      Number.isFinite(observedAt) &&
      Number.isFinite(windowMinutes) &&
      windowMinutes > 0 &&
      Number.isFinite(resetsAtMs)
    );
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
      const candidates = repeated.sort(
        (left, right) => right[1].count - left[1].count || right[1].latestObservedAtMs - left[1].latestObservedAtMs,
      );
      ignoredBucketCount = buckets.size - candidates.length;
      if (
        candidates.length > 1 &&
        candidates[0][1].count === candidates[1][1].count &&
        candidates[0][1].latestObservedAtMs === candidates[1][1].latestObservedAtMs
      ) {
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
    const bucketObservations = buckets
      .get(limitId)
      .observations.filter(
        (observation) => Number(observation.windowMinutes ?? observation.window_minutes) === windowMinutes,
      );
    const observedBeforeAsOf = bucketObservations.filter(
      (observation) => Number(observationValue(observation, "observedAtMs", "observed_at_ms")) <= asOfMs,
    );
    const current = observedBeforeAsOf.filter((observation) => {
      const endMs = Number(observationValue(observation, "resetsAtMs", "resets_at_ms"));
      const startMs = endMs - windowMinutes * MS_PER_MINUTE;
      return startMs <= asOfMs && asOfMs < endMs;
    });
    if (current.length) {
      const latestObservedAtMs = Math.max(
        ...current.map((observation) => Number(observationValue(observation, "observedAtMs", "observed_at_ms"))),
      );
      const latest = current.filter(
        (observation) => Number(observationValue(observation, "observedAtMs", "observed_at_ms")) === latestObservedAtMs,
      );
      const endPoints = new Set(
        latest.map((observation) => Number(observationValue(observation, "resetsAtMs", "resets_at_ms"))),
      );
      if (endPoints.size > 1) {
        windows[preset] = unavailableQuotaWindow("ambiguous", "同一观察时刻存在相互冲突的限额重置时间。");
        continue;
      }
      const windowEndMs = endPoints.values().next().value;
      const percents = new Set(
        latest.map((observation) => {
          const value = observationValue(observation, "usedPercent", "used_percent");
          return value === null || value === undefined ? null : Number(value);
        }),
      );
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
    const hasExpiredObservation = observedBeforeAsOf.some(
      (observation) => Number(observationValue(observation, "resetsAtMs", "resets_at_ms")) <= asOfMs,
    );
    windows[preset] = hasExpiredObservation
      ? unavailableQuotaWindow("waiting", "等待新的限额记录")
      : unavailableQuotaWindow("missing", "尚未发现当前限额窗口的 Codex 记录。");
  }
  const previousWindows = {};
  for (const [preset, minutes] of Object.entries(QUOTA_WINDOW_MINUTES)) {
    const completed = bucketAmbiguous
      ? null
      : completedQuotaWindows(buckets.get(limitId)?.observations, limitId, asOfMs, minutes);
    previousWindows[preset] =
      completed === null
        ? unavailableQuotaWindow(
            "ambiguous",
            preset === "quota_week"
              ? "上一周限额记录存在冲突，无法确认周期边界。"
              : "同一观察时刻存在相互冲突的限额重置时间。",
          )
        : completed.at(-1) || unavailableQuotaWindow("missing", "尚未发现上一限额窗口的 Codex 记录。");
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
  /** @type {number} */
  let previousCumulativeMask = USAGE_DETAIL_MASK.complete;
  let previousCumulativeCacheWrite = { tokens: 0, known: false };
  let baselineLoaded = false;
  let hasUsageInFile = false;
  const finalUsage = emptyUsage();
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
    const { cumulative, cumulativeMask, cumulativeCacheWrite, last, lastMask, lastCacheWrite, serviceTier } =
      readTokenUsage(row.payload, row);
    let increment = emptyUsage();
    let detailMask = 0;
    let cacheWrite = { tokens: 0, known: false };
    let lastMatchesDelta = false;
    if (cumulative) {
      const diff = diffUsage(cumulative, previousCumulative, cumulativeMask, previousCumulativeMask);
      const selected =
        initialRequestUsage(cumulative, cumulativeMask, last, lastMask, diff.usage, hasUsageInFile) || diff;
      increment = selected.usage;
      detailMask = selected.detailMask;
      lastMatchesDelta = Boolean(last && lastUsageMatchesDelta(last, lastMask, increment, detailMask));
      cacheWrite = cacheWriteForEvent({
        cumulative: cumulativeCacheWrite,
        previous: previousCumulativeCacheWrite,
        last: lastCacheWrite,
        lastMatches: lastMatchesDelta,
      });
      previousCumulative = cumulative;
      previousCumulativeMask = cumulativeMask;
      previousCumulativeCacheWrite = cumulativeCacheWrite;
    } else if (last) {
      increment = last;
      detailMask = lastMask;
      cacheWrite = lastCacheWrite;
    }
    if (!isZeroUsage(increment)) hasUsageInFile = true;
    addUsage(finalUsage, increment);
    const requestUsage = last && (!cumulative || lastMatchesDelta) ? last : null;
    const context = contextForEvent(
      Boolean(requestUsage),
      requestUsage || increment,
      requestUsage ? lastMask : detailMask,
    );

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
      sourceKind: home.kind,
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
    session: events.length
      ? {
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
        }
      : null,
    events,
    rateLimitObservations,
  };
}

async function* readJsonlRows(filePath, { withLineNumbers = false } = {}) {
  let lineNumber = 0;
  for await (const line of readRolloutLines(filePath)) {
    lineNumber += 1;
    if (!line.trim()) {
      continue;
    }
    try {
      const row = JSON.parse(line);
      yield withLineNumbers ? { row, lineNumber } : row;
    } catch {
      if (filePath.endsWith(".jsonl.zst")) throw new Error(`Invalid compressed rollout JSON at line ${lineNumber}`);
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
  /** @type {number} */
  let previousCumulativeMask = USAGE_DETAIL_MASK.complete;
  let previousCumulativeCacheWrite = { tokens: 0, known: false };
  let baselineLoaded = false;
  let hasUsageInFile = false;

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
    const { cumulative, cumulativeMask, cumulativeCacheWrite, last, lastMask, lastCacheWrite, serviceTier } =
      readTokenUsage(row.payload, row);
    let increment = emptyUsage();
    let detailMask = 0;
    let cacheWrite = { tokens: 0, known: false };
    let lastMatchesDelta = false;
    if (cumulative) {
      const diff = diffUsage(cumulative, previousCumulative, cumulativeMask, previousCumulativeMask);
      const selected =
        initialRequestUsage(cumulative, cumulativeMask, last, lastMask, diff.usage, hasUsageInFile) || diff;
      increment = selected.usage;
      detailMask = selected.detailMask;
      lastMatchesDelta = Boolean(last && lastUsageMatchesDelta(last, lastMask, increment, detailMask));
      cacheWrite = cacheWriteForEvent({
        cumulative: cumulativeCacheWrite,
        previous: previousCumulativeCacheWrite,
        last: lastCacheWrite,
        lastMatches: lastMatchesDelta,
      });
      previousCumulative = cumulative;
      previousCumulativeMask = cumulativeMask;
      previousCumulativeCacheWrite = cumulativeCacheWrite;
    } else if (last) {
      increment = last;
      detailMask = lastMask;
      cacheWrite = lastCacheWrite;
    }
    if (!isZeroUsage(increment)) hasUsageInFile = true;
    const requestUsage = last && (!cumulative || lastMatchesDelta) ? last : null;
    const context = contextForEvent(
      Boolean(requestUsage),
      requestUsage || increment,
      requestUsage ? lastMask : detailMask,
    );

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
      sourceKind: home.kind,
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
  if (source.kind === "dsh") {
    await streamDshSessionEvents(filePath, source, onEvent, options);
    return;
  }
  if (source.kind === "opencode") {
    await streamOpencodeDbEvents(filePath, source, onEvent, options);
    return;
  }
  if (source.kind === "claude") {
    await streamClaudeSessionEvents(filePath, source, onEvent, options);
    return;
  }
  if (source.kind === "workbuddy") {
    await streamWorkbuddySessionEvents(filePath, source, onEvent, options);
    return;
  }
  await streamSessionUsageFileEvents(filePath, source, onEvent, options);
}

async function parseSessionFileForIndex(
  filePath,
  home,
  intern,
  resolveRepository,
  previousCumulativeForSession,
  onRateLimit,
  onWarning,
) {
  const events = [];
  await streamSessionUsageFileEvents(
    filePath,
    home,
    (event) => {
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
    },
    { repositoryResolver: resolveRepository, previousCumulativeForSession, onRateLimit, onWarning },
  );
  return events;
}

async function parseProjectUsageLogFileForIndex(filePath, source, intern, resolveRepository) {
  const events = [];
  await streamProjectUsageFileEvents(
    filePath,
    source,
    (event) => {
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
    },
    { repositoryResolver: resolveRepository },
  );
  return events;
}

async function parseClaudeForIndex(filePath, source, intern, resolveRepository, onWarning) {
  const events = [];
  await streamClaudeSessionEvents(
    filePath,
    source,
    (event) => {
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
    },
    { repositoryResolver: resolveRepository, onWarning },
  );
  return events;
}

async function parseWorkbuddyForIndex(filePath, source, intern, resolveRepository, onWarning) {
  const events = [];
  await streamWorkbuddySessionEvents(
    filePath,
    source,
    (event) => {
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
    },
    { repositoryResolver: resolveRepository, onWarning },
  );
  return events;
}

async function parseZcodeDbForIndex(dbFile, source, intern, resolveRepository) {
  const events = [];
  await streamZcodeDbEvents(
    dbFile,
    source,
    (event) => {
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
    },
    { repositoryResolver: resolveRepository },
  );
  return events;
}

/** 把一个 DSH home 下所有会话日志摊平成索引事件。 */
async function parseDshForIndex(homePath, source, intern, resolveRepository, onWarning) {
  const events = [];
  let sessionFiles = [];
  try {
    sessionFiles = await dshSessionFiles(homePath);
  } catch (error) {
    onWarning?.(`无法读取 ${homePath}: ${error.message}`);
    return events;
  }

  for (const filePath of sessionFiles) {
    try {
      await streamDshSessionEvents(
        filePath,
        source,
        (event) => {
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
            priceVersion: event.priceVersion,
          });
        },
        { repositoryResolver: resolveRepository, onWarning },
      );
    } catch (error) {
      onWarning?.(`无法解析 ${filePath}: ${error.message}`);
    }
  }
  return events;
}

/** 把一个 OpenCode 数据库的用量摊平成索引事件。 */
async function parseOpencodeDbForIndex(dbFile, source, intern, resolveRepository, onWarning) {
  const events = [];
  await streamOpencodeDbEvents(
    dbFile,
    source,
    (event) => {
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
        priceVersion: event.priceVersion,
      });
    },
    { repositoryResolver: resolveRepository, onWarning },
  );
  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// M4.1：内存报告的性能候选载体（`UsageReport.perfSamples` / `UsageReport.perfMeta`）
//
// 卡片 `M4-summary-and-api.md:7,9` 的硬约束，逐条落到本段：
//   ① 与用量事件**同一份 `homes` 列表**、沿用既有物理文件发现逻辑 ⇒ **不发明新 home**；
//   ② use the M3 source registry; M7 reads Codex through one thread aggregation, not per file;
//   ③ 某个 home 报错**只**把该 home 标 `degraded`，**其他来源继续**；
//   ④ `UsageReport` **增加**两个字段，`report.events` 与旧 CLI JSON 字段**一个都不动**；
//   ⑤ 候选读取**前后**各算一次 `buildUsageFingerprint`（同一 homes 列表）：相同才允许把该
//      指纹当作 `perfMeta.indexVersion`；不同则 `state='degraded'` + `LIVE_SOURCE_CHANGED`；
//   ⑥ 独立再次只读扫描源：**不复用**旧 reader 的可写兜底 —— 本段只经 `streamPerfSamplesForFile`
//      （M2 的 `readOnly: true` reader），本层**不写库、不碰索引**。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * M4.1：原始 kind → **规范 perf kind**（`extra`/`main` → `codex`）。
 *
 * ⚠️ 与 `usage-store.js:761` 的私有同名实现**同源重复**：M3 的文件正在第三轮外部复验，
 * 本卡**不得**改动它（会作废已提交的 `E0A3BA46…`）。两者的差异由 M4.2 的跨路径 parity 用例兜住；
 * 未来 M3 若有计划内变更，可把该函数提升为共享导出以消除重复。
 * @param {unknown} kindRaw
 */
function canonicalPerfKind(kindRaw) {
  try {
    return canonicalPerfSourceKind(kindRaw);
  } catch {
    return String(kindRaw ?? "");
  }
}

/**
 * M4.1：失败 → **冻结码域内**的归因码。与 `usage-store.js:749` 同源重复（理由同上）。
 *
 * reader 自带的冻结码优先（它比本层更懂失败原因）；其余兜底 `READ_ONLY_OPEN_FAILED`。
 * ⚠️ 该兜底的**语义偏差**（约束类错误并非严格"open failed"）已由 M3.2 登记，本层**沿用不另立**。
 * @param {any} error
 */
function perfWarningCodeForError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (PERF_SOURCE_WARNING_CODES.has(code)) return code;
  return "READ_ONLY_OPEN_FAILED";
}

/**
 * M4.1：源告警**只保留四要素** —— 结构上保证不把路径/正文/线程 ID 带进 `perfMeta`。
 * @param {any} entry
 */
function normalizePerfWarningEntry(entry) {
  return {
    sourceKind: String(entry?.sourceKind ?? "").trim(),
    homeId: String(entry?.homeId ?? "").trim(),
    code: String(entry?.code ?? "").trim(),
    count: Number.isFinite(Number(entry?.count)) ? Number(entry.count) : 0,
  };
}

/**
 * M4.1：源告警投影 —— **按 `(sourceKind, homeId, code)` 聚合计数**；
 * `reader 的物理文件 count 按记录数累加，与 store 告警投影保持一致（跨路径 parity 的前提）。
 *
 * ⚠️ 与 M3.4 一致：**取不到 homeId 的条目直接跳过**（"宁缺勿错"，AN-6）——下游不得看到
 * 一条**无法归因**的告警。本函数因此可能**吞掉**极边缘的"全局指纹变了但没有任何已启用 home
 * 可归因"的 `LIVE_SOURCE_CHANGED`（详见 `collectMemoryPerfCarrier` 的登记注释）。
 * @param {any[]} failures
 */
function projectPerfSourceFailures(failures) {
  if (!failures || failures.length === 0) return [];
  const counts = new Map();
  for (const failure of failures) {
    const homeId = String(failure?.homeId ?? "").trim();
    const sourceKind = String(failure?.sourceKind ?? "").trim();
    const code = String(failure?.code ?? "").trim();
    if (homeId === "" || sourceKind === "" || code === "") continue;
    const key = `${sourceKind}\u0000${homeId}\u0000${code}`;
    // Reader warnings may already summarize several records in one physical file;
    // read failures are emitted with count=1. Preserve either count shape.
    const rawCount = Number(failure?.count ?? 1);
    const count = Number.isSafeInteger(rawCount) && rawCount > 0 ? rawCount : 1;
    counts.set(key, (counts.get(key) || 0) + count);
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [sourceKind, homeId, code] = key.split("\u0000");
      return { sourceKind, homeId, code, count };
    })
    .sort((a, b) => {
      if (a.sourceKind !== b.sourceKind) return a.sourceKind < b.sourceKind ? -1 : 1;
      if (a.homeId !== b.homeId) return a.homeId < b.homeId ? -1 : 1;
      if (a.code !== b.code) return a.code < b.code ? -1 : 1;
      return 0;
    });
}

/**
 * M4.1：一个 home 的**物理 perf 文件** —— 沿用既有发现逻辑，**不发明新 home**。
 *
 * 只对**已启用**来源调用：未启用来源既不读文件，也不得因文件不可读而令 perf 退化
 * （M3.4 BB-2 的明文："未启用来源…不令其他来源退化"）。
 * @param {any} home
 * @returns {Promise<string[]>}
 */
async function perfPhysicalFilesForHome(home) {
  // project-log 是**结构上不支持**性能观测的终态（方案 `:60`）；正常不会走到这里（未启用），
  // 这里显式返回空集，避免将来"顺手注册"后拿它的 `usageLogPath` 去当目录扫。
  if (home.kind === "project-log") return [];
  if (home.kind === "zcode") return home.usageLogPath ? [home.usageLogPath] : [];
  if (home.kind === "dsh") return await dshSessionFiles(home.path);
  if (home.kind === "opencode") return await opencodeDatabaseFiles(home.path);
  return await discoverSessionFiles(home.path);
}

/**
 * M4.1 返工1（复核 P2）：已启用来源的**内容探测宽度** —— **首尾各 64KiB**。
 *
 * 与 `usage-store.js:577` 的 `CONTENT_PROBE_BYTES` **同值同义**（见下方镜像说明）。
 */
const PERF_CONTENT_PROBE_BYTES = 64 * 1024;

/**
 * M4.1 返工1（复核 P2）：**已启用来源的单个物理文件内容指纹**。
 *
 * ⚠️ 这是 `usage-store.js:599` `enabledPerfSourceStat()` 的**逐字镜像**（同 `-wal` 折叠、
 * 同首尾 64KiB 摘要、同 `size:mtimeMs:digest.slice(0,32)` 串形、同"不可读 ⇒ null"）。
 *
 * **为什么不直接 import**：该函数是 `usage-store.js` 的**私有**函数，而该文件是 M3 的所有物、
 * 已在第四轮外部复核**通过**（受测哈希 `e0a3ba46…`）。为它加一个 `export` 会改变已验收产物
 * ⇒ 需重开 M3 复核。按模块边界串行交接的成本高于本次收益，故**镜像**并配**防漂移对拍**：
 * `test/perf-summary-parity.test.js` 的 `★M4.1-e` 把本地镜像与 **store 实际发布的
 * `perf_file_fingerprints`**（由 M3 同一函数产出）逐字比较 ⇒ 两实现一旦分歧即转红。
 * 已登记待办：M4 收口时把该函数提升为共享导出以消除镜像（需与 M3 所有者串行交接并重记哈希）。
 *
 * **同步**实现（`node:fs` 同步 API）：前/后两次快照必须在**同一处**取得，不能被 `await`
 * 让出而插入别的写入者 —— 那正是本检测要抓的情形。
 *
 * @param {string} kind 规范来源 kind
 * @param {string} filePath 物理文件路径
 * @returns {string | null} 指纹串；未启用/不可 stat/不可读 ⇒ `null`（**不编造**）
 */
function perfContentFingerprint(kind, filePath) {
  if (!isPerfSourceEnabled(kind)) return null;
  try {
    const main = statSync(filePath);
    let size = main.size;
    let mtimeMs = main.mtimeMs;
    const walPath = `${filePath}-wal`;
    const wal = statSync(walPath, { throwIfNoEntry: false });
    const walSize = wal === undefined ? 0 : wal.size;
    if (wal !== undefined) {
      // 与 `zcodeSourceStat` / M3 镜像同一算法：`-wal` 计入大小、mtime 取较大者。
      size += wal.size;
      mtimeMs = Math.max(mtimeMs, wal.mtimeMs);
    }
    const digest = createHash("sha256");
    /** @type {[string, number][]} */
    const contentParts = [
      [filePath, main.size],
      [walPath, walSize],
    ];
    for (const [file, fileSize] of contentParts) {
      if (fileSize <= 0) continue;
      const headLength = Math.min(fileSize, PERF_CONTENT_PROBE_BYTES);
      const handle = openSync(file, "r");
      try {
        const buffer = Buffer.alloc(headLength);
        const read = readSync(handle, buffer, 0, headLength, 0);
        digest.update(buffer.subarray(0, read));
        if (fileSize > PERF_CONTENT_PROBE_BYTES) {
          // 尾部（可能正是新追加/改写的页所在）
          const tailLength = Math.min(fileSize, PERF_CONTENT_PROBE_BYTES);
          const tailBuffer = Buffer.alloc(tailLength);
          const tailRead = readSync(handle, tailBuffer, 0, tailLength, fileSize - tailLength);
          digest.update(tailBuffer.subarray(0, tailRead));
        }
      } finally {
        closeSync(handle);
      }
    }
    return `${size}:${mtimeMs}:${digest.digest("hex").slice(0, 32)}`;
  } catch {
    return null;
  }
}

/**
 * M4.1 返工1：一个已启用 home 的**内容指纹**（覆盖它**全部**物理文件，含文件增删）。
 *
 * 逐文件用 `perfContentFingerprint`；文件路径排序后参与摘要 ⇒ 与发现顺序无关、可复现。
 * `complete=false` 表示有文件取不到指纹（不可读）⇒ 该 home 的版本分量不可证。
 *
 * @param {any} home
 * @param {string[]} files
 * @returns {{ fingerprint: string, complete: boolean, fileFingerprints: Record<string, string> }}
 */
function perfHomeContentFingerprint(home, files) {
  const hash = createHash("sha256");
  let complete = true;
  /** @type {Record<string, string>} */
  const fileFingerprints = {};
  for (const filePath of [...files].sort()) {
    const fingerprint = perfContentFingerprint(home?.kind, filePath);
    if (fingerprint === null) complete = false;
    else fileFingerprints[filePath] = fingerprint;
    hash.update(`${filePath}\t${fingerprint ?? "!"}\n`);
  }
  return { fingerprint: hash.digest("hex"), complete, fileFingerprints };
}

/**
 * M4.1 返工1（复核 P1）：**已启用性能来源**的内容指纹聚合 —— 内存 `indexVersion` 的唯一来源。
 *
 * 与 M3.4 的 `buildPublishedSourcesFingerprint`（`usage-store.js:664`）**同口径**：
 * 只聚合**已启用**来源（该函数注释明文"未启用来源不影响：其 kind 不满足 isPerfSourceEnabled
 * ⇒ 不入聚合"），按 `homes` 顺序取身份 + 逐 home 内容指纹 ⇒ 内容变则版本变。
 * ⚠️ 与索引路径**不承诺逐字相等**（索引聚合"已提交的逐文件指纹"，内存聚合"当前内容指纹"；
 * 构造不同）—— M4.2 的 parity 范围不含 `indexVersion`。
 *
 * @param {any[]} homes 只传**已启用** home
 * @param {Map<string, string>} fingerprints homeId → 内容指纹
 */
function aggregatePerfContentFingerprint(homes, fingerprints) {
  const hash = createHash("sha256");
  for (const home of homes) {
    const homeId = String(home?.id ?? "");
    hash.update(`${homeId}\t${canonicalPerfKind(home?.kind)}\t${fingerprints.get(homeId) ?? "!"}\n`);
  }
  return hash.digest("hex");
}

/**
 * M4.1 返工2（复核2 P2）：**整轮基线 / 整轮结束**用的逐 home 内容指纹 —— **重新发现**文件集合。
 *
 * ⚠️ 复核2 明文："后续多文件来源的后置文件集合也应重新发现，不能用旧列表声称覆盖文件增删。"
 * ⇒ 本函数每次都重新走 `perfPhysicalFilesForHome`，**不复用**局部窗口的 `files` 列表。
 *
 * @param {any} home
 * @returns {Promise<{ fingerprint: string, complete: boolean } | null>} 发现失败/取不到 ⇒ null
 */
async function perfHomeRoundFingerprint(home) {
  try {
    const files = await perfPhysicalFilesForHome(home);
    return perfHomeContentFingerprint(home, files);
  } catch {
    return null;
  }
}

/**
 * Plan one complete Codex home inside a discovery/content stability window.
 * The fingerprint deliberately covers the existing first/last 64 KiB probe per
 * file, not unread bytes in the middle; the file set itself is compared exactly.
 *
 * @param {any} home
 * @param {string[] | undefined} [expectedFilePaths] optional caller discovery to detect drift since its scan
 * @returns {Promise<{ok: boolean, stable: boolean, code: string|null, files: string[], plan: any|null, before: any|null, after: any|null}>}
 */
export async function planStableCodexHome(home, expectedFilePaths) {
  let files = [];
  let before = null;
  let plan = null;
  let afterFiles = null;
  let after = null;
  let planningError = null;
  let scanError = null;

  try {
    files = (await perfPhysicalFilesForHome(home)).slice().sort();
    before = perfHomeContentFingerprint(home, files);
  } catch (error) {
    scanError = error;
  }

  if (scanError === null) {
    try {
      // C3 卡：把**同一窗口的"读取前"内容指纹**（`before.fileFingerprints`）与实例私有投影缓存
      // 交给 planner ⇒ 指纹未变的文件**在全文读取之前**就命中标准化投影，不再打开文件。
      // ⚠️ 缓存**不通过新增形参**传递：`planStableCodexHome(home, expectedFilePaths)` 这一行是
      // B2 的 26 个锚点之一（`tools/lib/instrument.mjs:440`），逐字节不可改 ⇒ 它挂在 `home` 对象上
      // （store 侧用浅拷贝传入，不改动 store 持有的 home，也不引入任何模块级/全局状态）。
      // `projectionCache` 缺省 ⇒ planner 与今日行为逐字节等价（永远真读）。
      plan = await planCodexHomeThreads(String(home?.id ?? ""), files, {
        projectionCache: home?.projectionCache,
        fingerprints: before?.fileFingerprints,
        kind: home?.kind,
      });
    } catch (error) {
      planningError = error;
    }
    try {
      afterFiles = (await perfPhysicalFilesForHome(home)).slice().sort();
      after = perfHomeContentFingerprint(home, afterFiles);
    } catch (error) {
      scanError = error;
    }
  }

  if (scanError !== null || before === null || after === null || afterFiles === null) {
    return {
      ok: false,
      stable: false,
      code: perfWarningCodeForError(scanError ?? planningError),
      files,
      plan,
      before,
      after,
    };
  }

  const samePaths = (left, right) =>
    left.length === right.length && left.every((filePath, index) => filePath === right[index]);
  const expected = Array.isArray(expectedFilePaths) ? expectedFilePaths.slice().sort() : null;
  if (!before.complete || !after.complete) {
    return { ok: false, stable: false, code: "READ_ONLY_OPEN_FAILED", files, plan, before, after };
  }
  if (
    !samePaths(files, afterFiles) ||
    (expected !== null && !samePaths(expected, files)) ||
    before.fingerprint !== after.fingerprint
  ) {
    return { ok: false, stable: false, code: "LIVE_SOURCE_CHANGED", files, plan, before, after };
  }
  if (planningError !== null) {
    return {
      ok: false,
      stable: true,
      code: perfWarningCodeForError(planningError),
      files,
      plan,
      before,
      after,
    };
  }
  if (!plan?.ok) {
    const code = plan?.homeBlocking?.[0]?.code ?? plan?.unownedFiles?.[0]?.code ?? "UNKEYABLE_RECORD";
    return {
      ok: false,
      stable: true,
      code: PERF_SOURCE_WARNING_CODES.has(code) ? code : "READ_ONLY_OPEN_FAILED",
      files,
      plan,
      before,
      after,
    };
  }
  return { ok: true, stable: true, code: null, files, plan, before, after };
}

/**
 * M4.2：内存路径版的"非 Codex home"集合 —— 与 `UsageStore#nonCodexHomeIds()` **同口径**
 *（store 侧是 SQL `source_files.kind NOT IN ('main','jetbrains','extra','codex')`）。
 * 卡片明文："限额筛选继续使用现有 `quotaPreset` 判定与非 Codex home 排除。"
 * @param {any[]} homes
 * @returns {string[]} 排序去重的 homeId（空 id 不计）
 */
function perfNonCodexHomeIds(homes) {
  const ids = new Set();
  for (const home of homes || []) {
    const id = String(home?.id ?? "");
    if (id === "") continue;
    if (canonicalPerfSourceKind(home?.kind) === "codex") continue;
    ids.add(id);
  }
  return [...ids].sort();
}

/**
 * M4.2：把 `resolveDateRange` 的结果转成 **M1 的边界键名**（`{startMs, endMs, windowEndExclusiveMs}`）。
 *
 * ⚠️ **为什么必须是"同一个转换"**：M1 的 `perfTsInRange` 只认这三个键名；而 SQL 侧
 * `perfCandidatesForRange` 也走同一套键。卡片明文"两端 `summary.perf` 的计数完全相同"，
 * 这只有在两条路径收到**同一个范围的同一份表达**时才成立 —— 若内存侧漏了
 * `windowEndExclusiveMs`（配额范围同时带 `end` 与更晚的 `windowEndExclusive`），SQL 有界而
 * M1 无界，计数必然分叉（M3 的 `perfRangeBounds` 注释记录了同一实测成因）。
 *
 * 接受 `Date` 或有限数字；**非有限值响亮抛错**（`ts < NaN` 恒 false 会静默禁用边界）。
 *
 * @param {any} range `resolveDateRange` 的输出，或已是 M1 键名的对象，或 null
 * @returns {{ startMs: number | null, endMs: number | null, windowEndExclusiveMs: number | null }}
 */
export function perfStatsRangeBounds(range) {
  if (range === null || range === undefined) {
    return { startMs: null, endMs: null, windowEndExclusiveMs: null };
  }
  if (typeof range !== "object" || range instanceof Date) {
    throw new TypeError("perf range must be an object with startMs/endMs/windowEndExclusiveMs");
  }
  // 已转换的形状优先；否则读 usage-core 的原始键名（`start`/`end`/`windowEndExclusive`）。
  const rawStart = range.startMs !== undefined ? range.startMs : range.start;
  const rawEnd = range.endMs !== undefined ? range.endMs : range.end;
  const rawWindow = range.windowEndExclusiveMs !== undefined ? range.windowEndExclusiveMs : range.windowEndExclusive;
  return {
    startMs: perfStatsBoundMs(rawStart),
    endMs: perfStatsBoundMs(rawEnd),
    windowEndExclusiveMs: perfStatsBoundMs(rawWindow),
  };
}

/** @param {unknown} value @returns {number | null} */
function perfStatsBoundMs(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    if (!Number.isFinite(time)) {
      throw new TypeError("perf range bounds must be finite millisecond numbers or Dates");
    }
    return time;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new TypeError("perf range bounds must be finite millisecond numbers or Dates");
}

/**
 * M4.2：**两条生产汇总路径唯一的 perf 统计入口**（卡片明文"调用同一函数"）。
 *
 * 内存路径（`summarizeUsage`）与索引路径（`UsageStore.summarizeInReadTransaction`）都调它，
 * 因此分位、pooled、coverage 与排序**不可能**出现第二套实现。
 *
 * ⚠️ 输入 `bounds` 必须已由 {@link perfStatsRangeBounds} 转换过（索引路径的 SQL 与这里收到
 * **同一个对象**，见 M3 `perfRangeBounds` 的注释）。
 *
 * `state='rebuilding'`（含 store 的读取投影专有值 `uninitialized`）时**不返回部分排名**
 * （卡片明文）：候选集合是中途快照，给出 `rank` 就是把不完整数据当干净排名。此时仍返回
 * `coverage` 与 `meta`（诊断用），但 `groups` 为空数组。
 *
 * ⚠️ `sourceWarnings` 先经冻结码域过滤：M1.3 的 `summarizePerf` 对域外码**抛错**（有意 fail-loud），
 * 但读路径不得因**自己库里的坏元数据**而整体失败（M3.4 对指纹表已定同一条"读取路径不得因元数据
 * 坏掉而失败"的规矩）。
 *
 * @param {{ samples: any[], bounds: {startMs: number|null, endMs: number|null, windowEndExclusiveMs: number|null}, excludedHomeIds?: string[] | Set<string>, knownSources?: any[], meta?: any }} input
 * @returns {{ groups: any[], coverage: any, meta: any }}
 */
export function buildPerfStatsBlock(input) {
  const meta = input?.meta ?? {};
  const rawState = meta.state;
  // `uninitialized` 是 M3.4 读取投影的专有取值（键缺失），不属于 M1 的三态 ⇒ 映射成 `rebuilding`
  // （两者同义：还没有可信排名）。M1 会校验 `state` 取值，直接传 `uninitialized` 会抛 TypeError。
  const state =
    rawState === undefined || rawState === null || rawState === "" || rawState === "uninitialized"
      ? "rebuilding"
      : rawState;
  const sourceWarnings = Array.isArray(meta.sourceWarnings)
    ? meta.sourceWarnings.filter((entry) => PERF_SOURCE_WARNING_CODES.has(entry?.code))
    : [];
  const result = summarizePerf(input?.samples ?? [], {
    range: input?.bounds ?? null,
    excludedHomeIds: input?.excludedHomeIds ?? [],
    knownSources: input?.knownSources ?? [],
    meta: { ...meta, state, sourceWarnings },
  });
  return {
    groups: state === "rebuilding" ? [] : result.groups,
    coverage: result.coverage,
    meta: result.meta,
  };
}

/**
 * M4.1：收集内存报告的 perf 候选与元数据。**不抛错**（任何来源失败都降级为状态/告警）。
 *
 * **两个指纹、两个轴**（M4.1 返工1，复核 P1/P2 要求"区分用量全局指纹和已启用性能来源的指纹"）：
 *
 * 1. **用量全局指纹**（`buildUsageFingerprint`，size/mtime，覆盖**全部** homes 含未启用来源）
 *    —— 卡片明文要求的"同一 `homes` 列表前后各算一次"仍然保留，但**只用来表达"整份报告的上游
 *    在读取期间动过"**：写入 `usageFingerprintStable`。它**不**产生受阻 home、**不**产生
 *    `LIVE_SOURCE_CHANGED`、**不**影响 `state` 与排名。
 *    ⚠️ 复核 P1 明确否定了上一版的"兜底连坐"（全局变了但无已启用 home 能定位 ⇒ 给每个已启用
 *    home 合成 `LIVE_SOURCE_CHANGED`）：那会把 unsupported 来源的变化错误归因
 *    给稳定的 ZCode，令正常排名消失。**归因必须有该 home 自己的证据。**
 *
 * 2. **已启用性能来源内容指纹**（`perfContentFingerprint`，含首尾 64KiB 摘要）—— `state`、
 *    `degradedHomeIds`、`LIVE_SOURCE_CHANGED`、排名与 `indexVersion` 的**唯一依据**：
 *    - **整轮核对**（复核2 P2 明文要求）：在**整轮候选读取开始前**与**全部读取结束后**，
 *      对每个已启用 home 各取一次内容指纹（`perfHomeRoundFingerprint`，**结束时重新发现**文件
 *      集合），两者不同 ⇒ **只标该 home** `degraded` + `LIVE_SOURCE_CHANGED`。这覆盖
 *      "先读完的 home 在后续读取期间被改写"——局部窗口对此**必然漏检**（它的后置指纹早已取完）；
 *    - **局部窗口**（保留，用于更紧的归因）：每个 home 在它自己的读取前后各取一次，同样只标它；
 *    - `indexVersion` = **整轮结束**时的内容指纹聚合（`aggregatePerfContentFingerprint`，只含已启用
 *      来源，与 M3.4 `buildPublishedSourcesFingerprint` 同口径）⇒ **内容变则版本变**；
 *    - 任一已启用 home 的指纹不可取得或任一核对发现不同 ⇒ `indexVersion=null`（版本不可证）。
 *    ⚠️ 复核 P2 明确否定了上一版只比 `size+mtime`：**同尺寸 + 同 mtime 的原地改写会漏检**
 *    （SQLite 经常原地改写页面），使两份报告共用同一版本号。
 *    ⚠️ 但**读取失败**（文件不可读但内容稳定）**不**使版本失效：版本描述**上游快照**，
 *    "完整性受损"由 `state`/`degradedHomeIds` 承担 —— 两者是**不同的轴**（实测 `★M4.1-b`）。
 *
 * 极端情形：本轮**一个已启用 home 都没有**（纯 Codex 安装）⇒ 无候选、无可归因对象，
 * `state='ready'` 且 `indexVersion` = 空集聚合（此时没有候选会被误当干净排名，也没有被连坐的
 * 正常来源）。
 *
 * @param {any} homes
 * @param {any} [options]
 * @returns {Promise<{ perfSamples: any[], perfMeta: any }>}
 */
async function collectMemoryPerfCarrier(homes, options = {}) {
  /** @type {any[]} */
  const perfSamples = [];
  /** @type {any[]} */
  const rawWarnings = [];
  const degradedHomeIds = new Set();
  const wholeHomeCodexBlocks = new Set();
  /** @type {{homeId: string, blockedThreadIds: string[]}[]} */
  const partialHomes = [];
  const enabledHomes = (homes || []).filter((home) => isPerfSourceEnabled(home?.kind));

  // ① 用量全局指纹（卡片明文：同一 homes 列表，**含未启用来源**）—— 只表达"整份报告的上游动过"。
  const usageFingerprintBefore = await buildUsageFingerprint({ ...options, homes });

  /** 已启用 home → **整轮结束**时的内容指纹（`indexVersion` 的分量）。 */
  const perfFingerprintsAfter = new Map();
  /** 本轮已记录过 `LIVE_SOURCE_CHANGED` 的 home（避免整轮核对与局部窗口重复计数）。 */
  const liveChangedHomes = new Set();
  let perfFingerprintStable = true;

  // ② 整轮**基线**（复核2 P2）：在候选读取开始前，对每个已启用 home 取一次可归因的内容指纹。
  //    没有它就无法发现"先读完的 home 在后续读取期间被改写"。
  /** @type {Map<string, { fingerprint: string, complete: boolean } | null>} */
  const roundStart = new Map();
  for (const home of enabledHomes) {
    roundStart.set(String(home.id ?? ""), await perfHomeRoundFingerprint(home));
  }

  // ③ 逐已启用 home：Codex 先完整规划再 build；其他来源沿用原逐文件读取窗口。
  for (const home of enabledHomes) {
    const homeId = String(home.id ?? "");
    const kind = canonicalPerfKind(home.kind);

    let files = null;
    let before = null;
    let after = null;

    if (kind === "codex") {
      const window = await planStableCodexHome(home);
      files = window.files;
      before = window.before;
      after = window.after;
      if (!window.stable) perfFingerprintStable = false;
      if (!window.ok) {
        degradedHomeIds.add(homeId);
        wholeHomeCodexBlocks.add(homeId);
        const code = String(window.code ?? "READ_ONLY_OPEN_FAILED");
        if (code === "LIVE_SOURCE_CHANGED") {
          if (!liveChangedHomes.has(homeId)) {
            liveChangedHomes.add(homeId);
            rawWarnings.push({ sourceKind: kind, homeId, code, count: 1 });
          }
        } else {
          const counts = new Map();
          const failures = [...(window.plan?.homeBlocking ?? []), ...(window.plan?.unownedFiles ?? [])];
          for (const failure of failures) {
            const failureCode = PERF_SOURCE_WARNING_CODES.has(failure.code) ? failure.code : "READ_ONLY_OPEN_FAILED";
            counts.set(failureCode, (counts.get(failureCode) ?? 0) + 1);
          }
          if (counts.size === 0) counts.set(code, 1);
          for (const [failureCode, count] of counts) {
            rawWarnings.push({ sourceKind: kind, homeId, code: failureCode, count });
          }
        }
      } else {
        const stagedSamples = [];
        const stagedWarnings = [];
        try {
          for (const thread of window.plan.threads) {
            const built = buildCodexThreadPerfSamples(homeId, thread.threadId, thread.rollouts);
            stagedSamples.push(...built.samples);
            stagedWarnings.push(...built.warnings);
          }
          if (window.plan.failedThreads.length > 0) {
            const blockedThreadIds = window.plan.failedThreads.map((thread) => thread.threadId).sort();
            const failedFileCount = window.plan.failedThreads.reduce(
              (count, thread) => count + thread.failedFilePaths.length,
              0,
            );
            degradedHomeIds.add(homeId);
            partialHomes.push({ homeId, blockedThreadIds });
            rawWarnings.push({ sourceKind: kind, homeId, code: "MALFORMED_JSON", count: failedFileCount });
          }
          perfSamples.push(...stagedSamples);
          rawWarnings.push(...stagedWarnings);
        } catch (error) {
          degradedHomeIds.add(homeId);
          wholeHomeCodexBlocks.add(homeId);
          rawWarnings.push({
            sourceKind: kind,
            homeId,
            code: perfWarningCodeForError(error),
            count: 1,
          });
        }
      }
    } else {
      try {
        files = await perfPhysicalFilesForHome(home);
      } catch (error) {
        degradedHomeIds.add(homeId);
        rawWarnings.push({
          sourceKind: kind,
          homeId,
          code: perfWarningCodeForError(error),
          count: 1,
        });
      }

      // ⚠️ 前置内容指纹只覆盖每文件首尾各 64KiB 摘要，不是未读取字节的全文件哈希。
      before = files === null ? null : perfHomeContentFingerprint(home, files);
      for (const filePath of files || []) {
        try {
          await streamPerfSamplesForFile(
            filePath,
            // ⚠️ 与 `usage-store.js:1536` **同一手法**：把 `source.path` 覆盖成**物理文件路径**，
            //    使归一化样本的 `sourcePath` 与 SQLite 路径的 `source_path` **逐字一致** ——
            //    这是 M4.2 跨路径 parity 的前提（`sourcePath` 参与 M1 的重复候选取舍）。
            { ...home, path: filePath },
            (sample) => {
              perfSamples.push(sample);
            },
            {
              onWarning: (warning) => {
                // 卡片明文："收集 perfSamples 与**编码** perfWarnings"。
                // 非致命告警不把 home 标退化。M4.5 的 DSH 完整性告警由 dispatcher
                // 转成带冻结码的异常，走下面的 catch，与索引回滚路径同源。
                rawWarnings.push(normalizePerfWarningEntry(warning));
              },
            },
          );
        } catch (error) {
          degradedHomeIds.add(homeId);
          rawWarnings.push({
            sourceKind: kind,
            homeId,
            code: perfWarningCodeForError(error),
            count: 1,
          });
        }
      }
      after = files === null ? null : perfHomeContentFingerprint(home, files);
    }

    if (kind !== "codex" && before !== null && after !== null) {
      if (!before.complete || !after.complete) perfFingerprintStable = false;
      if (before.fingerprint !== after.fingerprint) {
        // **该 home 自己的**变化证据 ⇒ 只标它（复核 P1：不连坐无关来源）。
        degradedHomeIds.add(homeId);
        if (!liveChangedHomes.has(homeId)) {
          liveChangedHomes.add(homeId);
          rawWarnings.push({ sourceKind: kind, homeId, code: "LIVE_SOURCE_CHANGED", count: 1 });
        }
        perfFingerprintStable = false;
      }
    } else if (kind !== "codex" && (before === null || after === null)) {
      // 取不到指纹（发现失败 / 文件不可读）⇒ 该 home 的版本分量不可证。
      perfFingerprintStable = false;
    }
  }

  // ④ **整轮结束核对**（复核2 P2）：全部读取结束后，对每个已启用 home **重新发现**文件集合并再取
  //    一次内容指纹，与整轮基线比较。局部窗口无法覆盖"先读完的 home 在后续读取期间被改写"
  //    （它的后置指纹早已取完）—— 这正是复核2 复现的漏检。
  //    ⚠️ 只阻断**实际变化**的 home；**不**恢复"全局变化连坐所有 home"（复核 P1 已否决）。
  for (const home of enabledHomes) {
    const homeId = String(home.id ?? "");
    const kind = canonicalPerfKind(home.kind);
    const start = roundStart.get(homeId) ?? null;
    const end = await perfHomeRoundFingerprint(home);

    if (end !== null) {
      perfFingerprintsAfter.set(homeId, end.fingerprint);
      if (!end.complete) perfFingerprintStable = false;
    } else {
      // 整轮结束仍取不到 ⇒ 无法核对，版本不可证（**不**据此阻断 home：没有"它变了"的证据）。
      perfFingerprintStable = false;
    }
    if (start === null || end === null) {
      perfFingerprintStable = false;
      if (kind === "codex") {
        degradedHomeIds.add(homeId);
        wholeHomeCodexBlocks.add(homeId);
        if (!liveChangedHomes.has(homeId)) {
          liveChangedHomes.add(homeId);
          rawWarnings.push({ sourceKind: kind, homeId, code: "READ_ONLY_OPEN_FAILED", count: 1 });
        }
      }
    } else {
      if (!start.complete || (kind === "codex" && !end.complete)) {
        perfFingerprintStable = false;
        if (kind === "codex") {
          degradedHomeIds.add(homeId);
          wholeHomeCodexBlocks.add(homeId);
          if (!liveChangedHomes.has(homeId)) {
            liveChangedHomes.add(homeId);
            rawWarnings.push({ sourceKind: kind, homeId, code: "READ_ONLY_OPEN_FAILED", count: 1 });
          }
        }
      }
      if (start.fingerprint !== end.fingerprint) {
        degradedHomeIds.add(homeId);
        if (kind === "codex") wholeHomeCodexBlocks.add(homeId);
        if (!liveChangedHomes.has(homeId)) {
          liveChangedHomes.add(homeId);
          rawWarnings.push({ sourceKind: kind, homeId, code: "LIVE_SOURCE_CHANGED", count: 1 });
        }
        perfFingerprintStable = false;
      }
    }
  }

  // ⑤ 用量全局后置指纹。⚠️ **必须比 `.fingerprint` 字段，不能比整个返回值**：
  //    `buildUsageFingerprint` 返回 `{ fingerprint, fileCount, homeCount, checkedAt }`，其中
  //    `checkedAt` **每次调用都变**、对象身份也每次不同 ⇒ 比整个对象会把"没变化"永远判成
  //    "变化"（本卡实测：`★M4.1-a` 由此转红，探针 `review/M4/probe-m41-fingerprint.mjs`）。
  //    它只影响 `usageFingerprintStable`，**不**影响归因/排名/版本（复核 P1）。
  const usageFingerprintAfter = await buildUsageFingerprint({ ...options, homes });
  const usageFingerprintStable = usageFingerprintBefore.fingerprint === usageFingerprintAfter.fingerprint;

  const degradedList = [...degradedHomeIds].sort();
  const state = degradedList.length > 0 ? "degraded" : "ready";
  const classified = classifyPerfSources(homes);
  const finalPartialHomes = partialHomes.filter((entry) => !wholeHomeCodexBlocks.has(entry.homeId));
  const publicationFilter = createCodexPublishFilter(degradedList, finalPartialHomes);
  const rankedHomeIds = [
    ...new Set(
      perfSamples
        .filter((sample) => {
          const homeId = String(sample?.homeId ?? "");
          if (homeId === "") return false;
          return sample?.sourceKind === "codex"
            ? codexSampleAllowed(publicationFilter, sample)
            : !degradedHomeIds.has(homeId);
        })
        .map((sample) => String(sample.homeId)),
    ),
  ].sort();
  const codexPublicationPolicy = encodeCodexPublicationPolicy(finalPartialHomes);

  return {
    perfSamples,
    perfMeta: {
      state,
      ready: state === "ready",
      methodVersion: PERF_METHOD_VERSION,
      // 已启用性能来源**内容**指纹的聚合（与 M3.4 `buildPublishedSourcesFingerprint` 同口径：
      // 只含已启用来源）⇒ **内容变则版本变**；任一已启用 home 的指纹不可取得或前后不同 ⇒ `null`
      //（一个描述不了所载候选的版本号就是"元数据说谎"，同 M3.4 BC-2 的裁决）。
      indexVersion: perfFingerprintStable ? aggregatePerfContentFingerprint(enabledHomes, perfFingerprintsAfter) : null,
      indexedAt: new Date().toISOString(),
      degradedHomeIds: degradedList,
      sourceWarnings: projectPerfSourceFailures(rawWarnings),
      // 与 M3.4 的 `perf_unsupported_sources` 同形同源（`{kind, homeId}[]`，规范 kind）。
      unsupportedSources: [...classified.notEnabled, ...classified.unsupported],
      // 供 M4.2 直接传给 `summarizePerf({ knownSources })`：AH-5 要求**对象数组**。
      knownSources: (homes || []).map((home) => ({
        kind: canonicalPerfKind(home?.kind),
        homeId: String(home?.id ?? ""),
      })),
      // 与 M3.4 读投影同义：库/载体里出现过、且**未**受阻的 home（D4 的默认排名集合）。
      rankedHomeIds,
      codexPublicationPolicy,
      // ⚠️ 复核 P1/P2 的"两个轴"：**用量全局指纹**（含未启用来源）是否稳定。
      //    `false` ⇒ 整份报告的上游在读取期间动过（**整体**版本是否可证由此字段单独表达）；
      //    **不**意味着任何已启用 home 受阻 —— 那只看 `degradedHomeIds`（归因必须有该 home 的证据）。
      usageFingerprintStable,
      // **已启用性能来源**的内容指纹是否全部可取得且前后一致（`indexVersion` 的发布条件，显式化）。
      perfFingerprintStable,
    },
  };
}

/**
 * M4.3：**公开投影白名单** —— 原 `UsageReport` 只恰好有 6 个字段；M4.1 往 `report` 上挂了
 * `perfSamples`（含 `sampleKey`/`sourcePath`/`sessionId`/`turnKey` 与**物理会话路径**）与 `perfMeta`。
 * 公开序列化必须**显式投影**，不得再靠对象展开。
 *
 * 脱敏依据（冻结契约 §3 第 10 条，`source-contract.md:515`）：持久/公开产物**不含**
 * thread/response/item 原始 ID、**会话路径**、标题、content、args、item_json；上游方案
 * `docs/plans/2026-10-03-model-latency-throughput-plan.md:73` 明文"`/api/usage?detail=full`
 * 与 CLI `json` 的公开 report 须在汇总后投影原有公开字段，**不序列化内部
 * `perfSamples/sampleKey/sourcePath`**"。
 *
 * ⚠️ 这是**白名单**：将来往 `UsageReport` 加字段必须同时改这里，否则字段不公开 ——
 * 这正是本卡要的语义：内部载体默认不可见。
 * @param {any} report
 * @returns {any} 只含既有公开字段的浅投影（数组按引用共享，不深拷贝）
 */
export function toPublicUsageReport(report) {
  if (!report || typeof report !== "object") {
    return report;
  }
  return {
    events: report.events,
    generatedAt: report.generatedAt,
    homes: report.homes,
    rateLimitObservations: report.rateLimitObservations,
    sessions: report.sessions,
    warnings: report.warnings,
  };
}

/**
 * M4.3：取 `report.perfSamples` **按 home 排除**后的副本，用于内存路径的 `detail=full`。
 *
 * 为什么必须有这一步（M4.3-R1）：`summarizeUsage` 会把 `filters.excludeHomes` 传给
 * `summarizePerf` ⇒ 上游方案 `docs/plans/2026-10-03-model-latency-throughput-plan.md:66`
 * 要求"两条生产汇总路径使用**同一候选过滤**…对同一 fixture 的 `summary.perf` 一致"。
 * 若内存路径把**未过滤**的候选交给汇总，则同一 `preset=all&exclude=<home>` 在
 * `/api/usage`（索引）与 `/api/usage?detail=full`（内存）会给出**不同的 perf**。
 * 卡片明文："`withoutExcludedHomes()` 必须**同时过滤内部 `perfSamples` 或把过滤严格传给统计函数**"。
 * @param {any} report
 * @param {string[]} [excludeHomes]
 * @returns {any} `perfSamples` 已排除的浅拷贝（仍含内部载体，调用方需自行投影）
 */
export function withoutExcludedPerfSources(report, excludeHomes = []) {
  if (!report || typeof report !== "object" || !Array.isArray(report.perfSamples)) {
    return report;
  }
  const excluded = new Set((excludeHomes || []).map(String));
  if (excluded.size === 0) {
    return report;
  }
  return {
    ...report,
    perfSamples: report.perfSamples.filter((sample) => !excluded.has(String(sample?.homeId ?? ""))),
  };
}

/** @returns {Promise<import("./usage-types.js").UsageReport & { perfSamples: any[], perfMeta: any }>} */
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

    if (home.kind === "dsh") {
      try {
        const parsed = await parseDshSessions(home.path, home, {
          repositoryResolver,
          onWarning: (warning) => warnings.push(warning),
        });
        sessions.push(...parsed.sessions);
        events.push(...parsed.events);
      } catch (error) {
        warnings.push(`无法解析 ${home.path}: ${error.message}`);
      }
      continue;
    }

    if (home.kind === "opencode") {
      for (const dbFile of await opencodeDatabaseFiles(home.path)) {
        try {
          const parsed = await parseOpencodeDb(dbFile, home, {
            repositoryResolver,
            onWarning: (warning) => warnings.push(warning),
          });
          sessions.push(...parsed.sessions);
          events.push(...parsed.events);
        } catch (error) {
          warnings.push(`无法解析 ${dbFile}: ${error.message}`);
        }
      }
      continue;
    }

    if (home.kind === "claude") {
      try {
        const parsed = await parseClaudeSessions(home.path, home, {
          repositoryResolver,
          onWarning: (warning) => warnings.push(warning),
        });
        sessions.push(...parsed.sessions);
        events.push(...parsed.events);
      } catch (error) {
        warnings.push(`无法解析 ${home.path}: ${error.message}`);
      }
      continue;
    }

    const threadNames = await readSessionThreadNames(home.path);
    if (home.kind === "workbuddy") {
      // ⚠️ 报告路径的事件形状与 store 路径**不同**：这里的 `total` 是**用量对象**（与
      // parseClaudeSessions 同形），不是标量 —— 直接把流事件塞进 `events` 会让
      // `summarizeUsage` 读不到 `event.total.total`。因此复用 `parseWorkbuddySessions` 的投影。
      try {
        const parsed = await parseWorkbuddySessions(home.path, home, {
          repositoryResolver,
          onWarning: (warning) => warnings.push(warning),
        });
        sessions.push(...parsed.sessions);
        events.push(...parsed.events);
      } catch (error) {
        warnings.push(`无法解析 ${home.path}: ${error.message}`);
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
          rememberSessionUsage(
            previousBySession,
            event.sessionId,
            event.total,
            event.detailMask,
            event.cacheWriteTokens,
            event.cacheWriteKnown,
          );
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

  // ── M4.1：内存性能候选载体 ─────────────────────────────────────────────────
  // 位置刻意在**用量事件全部收集完之后**（卡片明文"完成现有事件收集后"）：这样
  // `perfMeta.indexVersion` 的"读取前后"窗口只覆盖 perf 读取本身，不含用量解析。
  // ⚠️ 该函数**不抛错**（逐来源失败降级为状态/告警）⇒ 内存报告不会因 perf 失败而整体失败。
  const { perfSamples, perfMeta } = await collectMemoryPerfCarrier(homes, options);

  return {
    generatedAt: new Date().toISOString(),
    homes,
    sessions,
    events,
    rateLimitObservations,
    warnings,
    // 新增两个字段；上面六个（含旧 CLI JSON 依赖的 `events`）**逐字未动**。
    perfSamples,
    perfMeta,
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
        events.push(
          ...(await parseProjectUsageLogFileForIndex(home.usageLogPath, home, interner.intern, repositoryResolver)),
        );
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

    if (home.kind === "dsh") {
      events.push(
        ...(await parseDshForIndex(home.path, home, interner.intern, repositoryResolver, (warning) =>
          warnings.push(warning),
        )),
      );
      continue;
    }

    if (home.kind === "opencode") {
      for (const dbFile of await opencodeDatabaseFiles(home.path)) {
        try {
          events.push(
            ...(await parseOpencodeDbForIndex(dbFile, home, interner.intern, repositoryResolver, (warning) =>
              warnings.push(warning),
            )),
          );
        } catch (error) {
          warnings.push(`无法解析 ${dbFile}: ${error.message}`);
        }
      }
      continue;
    }

    if (home.kind === "claude") {
      for (const filePath of await claudeSessionFiles(home.path)) {
        try {
          events.push(
            ...(await parseClaudeForIndex(filePath, home, interner.intern, repositoryResolver, (warning) =>
              warnings.push(warning),
            )),
          );
        } catch (error) {
          warnings.push(`无法解析 ${filePath}: ${error.message}`);
        }
      }
      continue;
    }

    const previousBySession = new Map();
    if (home.kind === "workbuddy") {
      for (const filePath of await workbuddySessionFiles(home.path)) {
        try {
          events.push(
            ...(await parseWorkbuddyForIndex(filePath, home, interner.intern, repositoryResolver, (warning) =>
              warnings.push(warning),
            )),
          );
        } catch (error) {
          warnings.push(`无法解析 ${filePath}: ${error.message}`);
        }
      }
      continue;
    }

    let files = [];
    try {
      files = await discoverSessionFiles(home.path);
    } catch (error) {
      warnings.push(`无法读取 ${home.path}: ${error.message}`);
      continue;
    }

    for (const file of files) {
      try {
        const parsed = await parseSessionFileForIndex(
          file,
          home,
          interner.intern,
          repositoryResolver,
          (sessionId) => previousBySession.get(sessionId),
          (observation) => rateLimitObservations.push(observation),
          (warning) => warnings.push(warning),
        );
        events.push(...parsed);
        for (const event of parsed) {
          rememberSessionUsage(
            previousBySession,
            interner.values[event.s],
            event,
            event.detailMask,
            event.cacheWriteTokens,
            event.cacheWriteKnown,
          );
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

function addLocalDays(date, days, zone = "local") {
  const next = new Date(date);
  if (zone === "utc") next.setUTCDate(next.getUTCDate() + days);
  else next.setDate(next.getDate() + days);
  return next;
}

function parseDateStart(value, zone = "local") {
  return value ? new Date(`${value}T00:00:00${zone === "utc" ? "Z" : ""}`) : null;
}

function parseDateEnd(value, zone = "local") {
  return value ? new Date(`${value}T23:59:59.999${zone === "utc" ? "Z" : ""}`) : null;
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function subtractMonthsClamped(date, months, zone = "local") {
  const year = zone === "utc" ? date.getUTCFullYear() : date.getFullYear();
  const month = zone === "utc" ? date.getUTCMonth() : date.getMonth();
  const day = zone === "utc" ? date.getUTCDate() : date.getDate();
  const target = zone === "utc" ? new Date(Date.UTC(year, month - months, 1)) : new Date(year, month - months, 1);
  const targetYear = zone === "utc" ? target.getUTCFullYear() : target.getFullYear();
  const targetMonth = zone === "utc" ? target.getUTCMonth() : target.getMonth();
  const clampedDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return zone === "utc"
    ? new Date(
        Date.UTC(
          targetYear,
          targetMonth,
          clampedDay,
          date.getUTCHours(),
          date.getUTCMinutes(),
          date.getUTCSeconds(),
          date.getUTCMilliseconds(),
        ),
      )
    : new Date(
        targetYear,
        targetMonth,
        clampedDay,
        date.getHours(),
        date.getMinutes(),
        date.getSeconds(),
        date.getMilliseconds(),
      );
}

function parseRecentValue(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\s+/g, "");
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

function recentDateRange(value, now, zone = "local") {
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
    ? addLocalDays(startOfLocalDay(now, zone), 1 - parsed.days, zone)
    : startOfLocalDay(subtractMonthsClamped(now, parsed.months, zone), zone);
  return {
    start,
    end: endOfLocalDay(now, zone),
    preset: "recent",
  };
}

/** @returns {import("./usage-types.js").UsageRange} */
export function resolveDateRange(filters = {}, events = []) {
  return resolveDateRangeFromTimestamps(
    filters,
    events.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite),
  );
}

/** @returns {import("./usage-types.js").UsageRange} */
function resolveDateRangeFromTimestamps(filters = {}, timestamps = []) {
  // Report and index summaries share this resolver to avoid date-range drift.
  const now = filters.now ? new Date(filters.now) : new Date();
  const zone = filters.calendarZone === "utc" ? "utc" : "local";
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
    if (
      !Number.isFinite(windowStartMs) ||
      !Number.isFinite(windowEndExclusiveMs) ||
      !Number.isFinite(asOfMs) ||
      windowEndExclusiveMs - windowStartMs !== expectedDuration ||
      windowStartMs > asOfMs ||
      asOfMs >= windowEndExclusiveMs
    ) {
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
      calendarZone: zone,
    };
  }
  if (preset === "today" || preset === "week" || preset === "month" || preset === "all") {
    return calendarPresetRange(preset, now, zone, timestamps);
  }
  if (preset === "custom") {
    return {
      start: parseDateStart(filters.startDate, zone),
      end: parseDateEnd(filters.endDate, zone),
      preset,
      calendarZone: zone,
    };
  }
  if (preset === "recent") {
    const named = resolveNamedRecentRange(filters.recentValue, now, filters.quota, zone);
    if (named) {
      if ("quotaState" in named && named.quotaState === "missing")
        throw new QuotaWindowUnavailableError(named.quotaPreset, filters.quota);
      return { ...named, calendarZone: zone };
    }
    const range = recentDateRange(filters.recentValue, now, zone);
    if (range) {
      return { ...range, calendarZone: zone };
    }
  }

  return calendarPresetRange("all", now, zone, timestamps);
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

/** @returns {import("./usage-types.js").UsageRange} */
function indexDateRange(filters = {}, events = []) {
  return resolveDateRangeFromTimestamps(filters, events.map((event) => event.t).filter(Number.isFinite));
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
  const zone = range.calendarZone === "utc" ? "utc" : "local";
  if (range.preset === "today") {
    const previousDay = addLocalDays(startOfLocalDay(range.start, zone), -1, zone);
    return {
      start: previousDay,
      end: endOfLocalDay(previousDay, zone),
    };
  }
  if (range.preset === "week") {
    const previousWeekStart = addLocalDays(startOfLocalWeek(range.start, zone), -7, zone);
    return {
      start: previousWeekStart,
      end: endOfLocalDay(addLocalDays(previousWeekStart, 6, zone), zone),
    };
  }
  if (range.preset === "month") {
    const currentMonthStart = startOfLocalDay(range.start, zone);
    return {
      start:
        zone === "utc"
          ? new Date(Date.UTC(currentMonthStart.getUTCFullYear(), currentMonthStart.getUTCMonth() - 1, 1))
          : new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() - 1, 1),
      end: new Date(currentMonthStart.getTime() - 1),
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
  return (
    {
      today: "较昨日",
      week: "较上周",
      month: "较上月",
      custom: "较上一等长周期",
      recent: "较上一等长周期",
    }[preset] || "暂无对比"
  );
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
    calendarZone: range.calendarZone || "local",
    rolling: Boolean(range.rolling),
    ...(range.quotaWindow
      ? {
          quotaWindow: true,
          recentValue: range.recentValue,
          quotaPreset: range.quotaPreset,
          asOf: range.asOf.toISOString(),
          windowStart: range.start.toISOString(),
          windowEndExclusive: range.windowEndExclusive.toISOString(),
          observedAt: range.observedAt?.toISOString() || null,
          usedPercent: range.usedPercent,
          percentStale: range.percentStale,
          limitId: range.limitId,
          quotaState: range.quotaState,
          quotaReason: range.quotaReason,
          ...(range.durationMinutes === undefined
            ? {}
            : { durationMinutes: range.durationMinutes, plannedResetAt: range.plannedResetAt }),
        }
      : {}),
  };
}

export function summarizeUsageIndex(index, filters = {}) {
  const strings = index.strings;
  const sourceKinds = homeSourceKinds(index.homes);
  const { quota, asOf } = summaryQuotaContext(index.rateLimitObservations, filters);
  const range = indexDateRange({ ...filters, quota, now: asOf }, index.events);
  const quotaPreset = isQuotaPreset(range.preset) || Boolean(range.quotaWindow);
  const bucket = deriveTimelineBucket(
    range,
    range.bucket || (quotaPreset ? (range.preset === "quota_5h" ? "quota_30m" : "quota_24h") : filters.bucket || "day"),
  );
  const now = range.asOf || asOf;
  const events = index.events.filter((event) => {
    if (quotaPreset && isCodexAutoReview(strings[event.m])) return false;
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
  const comparison = quotaPreset
    ? null
    : usageComparison({
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
        homeId: strings[event.h],
        sourceKind: sourceKinds.get(String(strings[event.h])),
        model: strings[event.m] || "Unknown model",
        total: {
          total: event.total,
          input: event.input,
          cached: event.cached,
          output: event.output,
          reasoning: event.reasoning,
        },
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
  const { timeline, timelineError } = buildTimelineRowsWithLimit(timelineEvents(), range, bucket, {
    sourceKinds,
    estimateCost: estimateEventCost,
    onEstimate: (event, estimate) => costAccumulator.add(event, estimate),
  });
  const costEstimate = timelineError ? estimateCostForEvents(timelineEvents()) : costAccumulator.result();

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
    channels: groupIndexedEvents(index, events, (event) =>
      channelForRange(strings[event.c], range, sourceKinds.get(String(strings[event.h]))),
    ),
    homes: groupIndexedEvents(index, events, (event) => strings[event.l]),
    models: groupIndexedEvents(index, events, (event) => strings[event.m] || "Unknown model"),
    projects: groupIndexedEvents(index, events, (event) => strings[event.p] || "Unknown cwd"),
    repositories: groupIndexedRepositories(index, events),
  };
}

/** @param {import("./usage-types.js").UsageReport} report
 * @returns {import("./usage-types.js").UsageSummary}
 */
export function summarizeUsage(report, filters = {}) {
  const sourceKinds = homeSourceKinds(report.homes);
  // M4.3（M4.3-R1）：来源排除必须**先**作用于候选、再进入统计 —— 卡片明文"范围和来源过滤
  // **先统一作用于候选**，再作分组"，上游方案 :66 要求两条生产路径用**同一候选过滤**。
  // 索引路径的 SQL 候选查询天生带 `scopeExclusions`；内存路径此前只把 `excludeHomes` 当作
  // `summarizePerf` 的排除参数，候选**没有**先过滤。对计数等价，但违反了明文顺序。这里显式对齐。
  const perfReport = withoutExcludedPerfSources(
    report,
    Array.isArray(filters.excludeHomes) ? filters.excludeHomes : [],
  );
  const { quota, asOf } = summaryQuotaContext(report.rateLimitObservations, filters);
  const range = resolveDateRange({ ...filters, quota, now: asOf }, report.events);
  const quotaPreset = isQuotaPreset(range.preset) || Boolean(range.quotaWindow);
  const bucket = deriveTimelineBucket(
    range,
    range.bucket || (quotaPreset ? (range.preset === "quota_5h" ? "quota_30m" : "quota_24h") : filters.bucket || "day"),
  );
  const now = range.asOf || asOf;
  const events = report.events.filter((event) => {
    if (quotaPreset && isCodexAutoReview(event.model)) return false;
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
  const comparison = quotaPreset
    ? null
    : usageComparison({
        range,
        allEvents: report.events,
        eventTime: (event) => Date.parse(event.timestamp),
        eventSession: (event) => event.sessionId,
        addEventUsage: (sum, event) => addUsage(sum, event.total),
        currentTotals: totals,
        now,
      });
  const costAccumulator = createCostEstimateAccumulator();
  const { timeline, timelineError } = buildTimelineRowsWithLimit(events, range, bucket, {
    sourceKinds,
    estimateCost: estimateEventCost,
    onEstimate: (event, estimate) => costAccumulator.add(event, estimate),
  });
  const costEstimate = timelineError ? estimateCostForEvents(events) : costAccumulator.result();

  /** @type {import("./usage-types.js").UsageSummary & { perf?: any }} */
  const summary = {
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
    channels: groupByUsage(events, (event) =>
      channelForRange(event.channel, range, sourceKinds.get(String(event.homeId))),
    ),
    homes: groupByUsage(events, (event) => event.homeLabel),
    models: groupByUsage(events, (event) => event.model || "Unknown model"),
    projects: groupByUsage(events, (event) => event.cwd || "Unknown cwd"),
    repositories: groupRepositories(events),
  };

  // ── M4.2：`summary.perf` ────────────────────────────────────────────────────
  //
  // 形状 = M3.4 读投影字段的**同义等价物**（`state/ready/methodVersion/indexVersion/
  // indexedAt/degradedHomeIds/sourceWarnings/unsupportedSources/rankedHomeIds`）
  // **加上冻结的 `PerfSummary` 三件套 `{groups, coverage, meta}`**（`usage-types.js:178`）。
  //
  // ⚠️ **契约冲突与裁定（M4.2-R1）**：M1 冻结的 typedef 只描述 `{groups, coverage, meta}`，
  //   而 M3.4 已验收的索引路径把 `summary.perf` 实现成**状态投影**（且 M3 的
  //   `test/perf-state.test.js:278,557` 断言 `summary.perf.state`，那些测试文件属 M3、
  //   本卡**不得改**）。⇒ 裁定为**加法超集**：既有键**一个不改**，只新增三件套，
  //   两条路径产出**同一组键**。下游按冻结形状读 `groups/coverage/meta` 即可。
  if (Array.isArray(perfReport.perfSamples)) {
    // `perfMeta` 尚未并入 `UsageReport` typedef（M4.1 已登记的边界：`src/usage-types.js` 属 M3）
    // ⇒ 本卡用局部交叉类型读取，不改 M3 文件。
    const perfMeta = /** @type {any} */ (perfReport).perfMeta ?? {};
    const degraded = Array.isArray(perfMeta.degradedHomeIds) ? perfMeta.degradedHomeIds : [];
    const decodedPolicy = decodeCodexPublicationPolicy(perfMeta.codexPublicationPolicy);
    const partialHomes = decodedPolicy.usable ? decodedPolicy.partialHomes : [];
    const partialHomeIds = new Set(partialHomes.map((entry) => entry.homeId));
    const publishFilter = createCodexPublishFilter(degraded, partialHomes);
    // 卡片明文："**范围和来源过滤先统一作用于候选**，再作分组" —— 索引路径的候选由
    // `perfCandidatesForRange(range, scopeExclusions)` 过滤，内存路径必须在同一处对齐：
    // ① 显式 `excludeHomes`（索引侧 `scopeExclusions` 的第一项）；
    // ② 普通 degraded home 整体排除；经 policy 许可的 Codex partial home 只排 blockedThreadIds；
    // ③ 配额范围下的**非 Codex home**（索引侧 `nonCodexHomeIds()`，卡片明文沿用该判定）。
    // ⚠️ 只作用于 `summary.perf`，**不**改 `totals/channels/models/timeline`（卡片明文）。
    const excludeHomes = Array.isArray(filters.excludeHomes) ? filters.excludeHomes : [];
    const perfExclusions = [
      ...new Set([
        ...excludeHomes,
        ...degraded.filter((homeId) => !partialHomeIds.has(homeId)),
        ...(quotaPreset ? perfNonCodexHomeIds(report.homes) : []),
      ]),
    ];
    const publishableSamples = perfReport.perfSamples.filter(
      (sample) => codexSampleAllowed(publishFilter, sample) && (!quotaPreset || !isCodexAutoReview(sample.model)),
    );
    const degradedHomeIds = new Set(degraded);
    const rankedHomeIds = [
      ...new Set(
        report.perfSamples
          .filter((sample) => {
            const homeId = String(sample?.homeId ?? "");
            return sample?.sourceKind === "codex"
              ? codexSampleAllowed(publishFilter, sample)
              : !degradedHomeIds.has(homeId);
          })
          .map((sample) => String(sample?.homeId ?? ""))
          .filter(Boolean),
      ),
    ].sort();
    const perfStats = buildPerfStatsBlock({
      samples: publishableSamples,
      bounds: perfStatsRangeBounds(range),
      excludedHomeIds: perfExclusions,
      knownSources: perfMeta.knownSources ?? [],
      meta: {
        methodVersion: perfMeta.methodVersion,
        state: perfMeta.state,
        indexVersion: perfMeta.indexVersion ?? null,
        indexedAt: perfMeta.indexedAt ?? null,
        sourceWarnings: perfMeta.sourceWarnings ?? [],
      },
    });
    summary.perf = {
      state: perfMeta.state ?? "ready",
      ready: perfMeta.ready ?? perfMeta.state === "ready",
      methodVersion: perfMeta.methodVersion ?? PERF_METHOD_VERSION,
      indexVersion: perfMeta.indexVersion ?? null,
      indexedAt: perfMeta.indexedAt ?? null,
      degradedHomeIds: degraded,
      // M4.3 返工1（复核 §3，M4.2 复核 R3 遗留项）：顶层与 `meta.sourceWarnings` 必须是**同一份
      // 规范结果**。此前顶层直接用原始状态告警（`perfMeta.sourceWarnings`），而内核会按冻结码域
      // 过滤并补算 `AGGREGATE_OVERFLOW` ⇒ 实测出现"meta 有 overflow 告警、顶层却是 `[]`"。
      // 这里复用内核输出，**不**另写过滤/排序/合并逻辑；12 键形状不变。
      sourceWarnings: perfStats.meta.sourceWarnings,
      unsupportedSources: perfMeta.unsupportedSources ?? [],
      rankedHomeIds,
      groups: perfStats.groups,
      coverage: perfStats.coverage,
      meta: perfStats.meta,
    };
  }

  return summary;
}
