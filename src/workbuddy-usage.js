// WorkBuddy 用量数据源：读取 ~/.workbuddy-ai/projects 下的会话转录（JSONL）。
//
// 转录格式要点（WorkBuddy 实测）：
// - 一条模型响应会写成**多条**记录（`function_call` 每个工具调用一行，`message` 一行），
//   其中只有一条携带 `providerData.usage`；同一 `providerData.messageId` 的多行是**同一次**响应。
//   直接累加会把 token 放大数倍，因此必须按 messageId 去重。
// - 用量挂在 `providerData.usage`，字段是**超集口径**（与 Claude Code 相反）：
//   `inputTokens` **已含**缓存，`outputTokens` **已含** reasoning ⇒ 不能再相加。
//   三份冗余（`providerData.usage` / `providerData.rawUsage` / `message.usage`）只取第一份。
// - Auto 模式（`model === "default-model"` 或 `requestModelName === "Auto"`）没有确定的线路模型，
//   无法计价 ⇒ 整条排除（用户裁决，见实施计划 §0）。
// - 生成时长不在会话转录里，只在 `<home>/traces/<pid>/trace_*.jsonl` 的 `span_end` 记录上
//   （`span.type === "generation"`，`duration` 毫秒，`toolOutput` 里 `[0].id` 是 messageId）。
// - `<sessionId>/tool-results/**` 是外部化的大工具输出（可达数十 MB），绝不读取。
import { closeSync, openSync, readSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { readRolloutLines } from "./codex-rollout.js";
import { LONG_CONTEXT_INPUT_THRESHOLD, pricingVersionForTimestamp } from "./pricing.js";
import { createRepositoryResolver } from "./repository-identity.js";
import { USAGE_DETAIL_MASK, emptyUsage } from "../public/usage-fields.js";

export const WORKBUDDY_KIND = "workbuddy";
export const WORKBUDDY_CHANNEL = "WorkBuddy";

const PROJECTS_DIR = "projects";
const TRACES_DIR = "traces";
const TOOL_RESULTS_DIR = "tool-results";
const TRACE_FILE_PREFIX = "trace_";
const JSONL_SUFFIX = ".jsonl";
const HEAD_PROBE_BYTES = 64 * 1024;
const HOME_PROBE_FILE_LIMIT = 3;
const UNKNOWN_PROJECT = "Unknown cwd";
const UNKNOWN_MODEL = "Unknown model";
// 只有这两类记录可能携带一次模型响应的用量；其余类型（session-meta / function_call_result /
// reasoning / ai-title / file-history-snapshot）即使被构造出 `providerData.usage` 也不得产事件。
const USAGE_RECORD_TYPES = Object.freeze(new Set(["function_call", "message"]));

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function directoryEntries(target) {
  try {
    return await readdir(target, { withFileTypes: true });
  } catch {
    return [];
  }
}

function knownToken(value) {
  const number = Number(value);
  const known = value !== null && value !== undefined && value !== "" && Number.isFinite(number) && number >= 0;
  return { tokens: known ? number : 0, known };
}

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function timestampMsOf(record) {
  const raw = record?.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const parsed = Date.parse(String(raw ?? ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * 递归收集 `projects/**` 下的会话转录，显式跳过 `tool-results/**`。
 * 排序按路径 code-unit（`sort()` 默认序），保证跨平台稳定。
 * @param {string} root
 * @param {string[]} [files]
 * @returns {Promise<string[]>}
 */
async function walkSessionFiles(root, files = []) {
  for (const entry of await directoryEntries(root)) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === TOOL_RESULTS_DIR) continue;
      await walkSessionFiles(fullPath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(JSONL_SUFFIX)) files.push(fullPath);
  }
  return files;
}

export async function workbuddyProjectsDirectory(homePath) {
  const directory = path.join(homePath, PROJECTS_DIR);
  return (await exists(directory)) ? directory : "";
}

/** 读文件头 64 KiB，用于"内容判别"（只看前缀，不整文件读）。 */
function readHead(filePath) {
  const handle = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(HEAD_PROBE_BYTES);
    const read = readSync(handle, buffer, 0, HEAD_PROBE_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(handle);
  }
}

/**
 * 判定一个目录是不是 WorkBuddy home。
 *
 * 纯目录结构不够：`~/.workbuddy-ai` 同时满足 `claudeHomeLooksUsable`（`projects/<slug>/*.jsonl`）与
 * `codexHomeLooksUsable`（`sessions/`），必须靠**内容**区分。判据是 `projects/<slug>/*.jsonl` 的
 * 前 64 KiB 里出现 `"type":"session-meta"` 或 `"type":"function_call"`，最多探测 3 个文件。
 * @param {string} homePath
 * @returns {Promise<boolean>}
 */
export async function workbuddyHomeLooksUsable(homePath) {
  const root = await workbuddyProjectsDirectory(homePath);
  if (!root) return false;
  let probed = 0;
  for (const project of await directoryEntries(root)) {
    if (!project.isDirectory() || project.name === TOOL_RESULTS_DIR) continue;
    for (const entry of await directoryEntries(path.join(root, project.name))) {
      if (!entry.isFile() || !entry.name.endsWith(JSONL_SUFFIX)) continue;
      probed += 1;
      let head = "";
      try {
        head = readHead(path.join(root, project.name, entry.name));
      } catch {
        head = "";
      }
      if (head.includes('"type":"session-meta"') || head.includes('"type":"function_call"')) return true;
      if (probed >= HOME_PROBE_FILE_LIMIT) return false;
    }
  }
  return false;
}

/**
 * 一个 WorkBuddy home 下的全部会话转录。
 * @param {string} homePath
 * @returns {Promise<string[]>}
 */
export async function workbuddySessionFiles(homePath) {
  const root = await workbuddyProjectsDirectory(homePath);
  if (!root) return [];
  return (await walkSessionFiles(root)).sort();
}

function isAutoRecord(providerData) {
  if (trimmed(providerData.model) === "default-model") return true;
  return trimmed(providerData.requestModelName).toLowerCase() === "auto";
}

/**
 * 从一条带 `providerData.usage` 的记录映射出看板口径。
 *
 * 与 Claude Code 的关键差异：`inputTokens` 本身就是请求侧总量（含缓存），`outputTokens` 含
 * reasoning ⇒ 直接取用，不做加法，也不做三份冗余的交叉校验。
 */
function usageFromProviderData(providerData) {
  const usage = providerData?.usage || {};
  const input = knownToken(usage.inputTokens);
  const output = knownToken(usage.outputTokens);
  const cached = knownToken(usage.inputTokensDetails?.[0]?.cached_tokens);
  const reasoning = knownToken(usage.outputTokensDetails?.[0]?.reasoning_tokens);
  const totalRaw = knownToken(usage.totalTokens);
  const cacheWrite = knownToken(providerData?.rawUsage?.cache_creation_input_tokens);
  const mapped = {
    ...emptyUsage(),
    input: input.tokens,
    cached: cached.tokens,
    output: output.tokens,
    reasoning: reasoning.tokens,
  };
  mapped.total = totalRaw.known ? totalRaw.tokens : mapped.input + mapped.output;
  const detailMask =
    (input.known ? USAGE_DETAIL_MASK.input : 0) |
    (cached.known ? USAGE_DETAIL_MASK.cached : 0) |
    (output.known ? USAGE_DETAIL_MASK.output : 0) |
    (reasoning.known ? USAGE_DETAIL_MASK.reasoning : 0);
  return { usage: mapped, detailMask, inputKnown: input.known, cacheWrite };
}

/**
 * 单遍扫描一个 WorkBuddy 会话转录，产出标准化用量事件。
 * @param {string} filePath
 * @param {{ id?: unknown, label?: unknown, path?: unknown }} source
 * @param {(event: any) => Promise<void> | void} onEvent
 * @param {{ repositoryResolver?: any, onWarning?: (warning: string) => void }} [options]
 */
export async function streamWorkbuddySessionEvents(filePath, source, onEvent, options = {}) {
  const resolveRepository = options.repositoryResolver || createRepositoryResolver();
  const fallbackSessionId = path.basename(filePath, JSONL_SUFFIX);
  const seen = new Set();
  const events = [];
  let malformed = 0;

  for await (const line of readRolloutLines(filePath)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (!USAGE_RECORD_TYPES.has(String(record?.type || ""))) continue;
    const providerData = record?.providerData;
    if (!providerData || !providerData.usage) continue;
    const messageId = trimmed(providerData.messageId);
    if (!messageId) continue;
    // 同一次响应只产一个事件：用量只挂在其中一条记录上，这里的 Set 是防御而非主路径。
    if (seen.has(messageId)) continue;
    // Auto 没有确定的线路模型，无法计价 ⇒ 整条排除（用户裁决）。
    if (isAutoRecord(providerData)) continue;
    const timestampMs = timestampMsOf(record);
    if (!Number.isFinite(timestampMs)) continue;
    seen.add(messageId);

    const { usage, detailMask, inputKnown, cacheWrite } = usageFromProviderData(providerData);
    const timestamp = new Date(timestampMs).toISOString();
    events.push({
      messageId,
      timestampMs,
      timestamp,
      sessionId: trimmed(record.sessionId) || fallbackSessionId,
      project: trimmed(record.cwd) || UNKNOWN_PROJECT,
      model: trimmed(providerData.model) || UNKNOWN_MODEL,
      usage,
      detailMask,
      cacheWriteTokens: cacheWrite.tokens,
      cacheWriteKnown: cacheWrite.known,
      requestInputTokens: inputKnown ? usage.input : 0,
      contextLevel: inputKnown ? (usage.input > LONG_CONTEXT_INPUT_THRESHOLD ? "long" : "short") : "unknown",
      serviceTier: "unknown",
      priceVersion: pricingVersionForTimestamp(timestamp),
    });
  }

  if (malformed > 0) options.onWarning?.(`WORKBUDDY_MALFORMED_JSON:${malformed} (${filePath})`);

  events.sort((left, right) => left.timestampMs - right.timestampMs || left.messageId.localeCompare(right.messageId));
  for (const event of events) {
    const repository = await resolveRepository(event.project);
    await onEvent({
      timestampMs: event.timestampMs,
      timestamp: event.timestamp,
      sessionId: event.sessionId,
      homeId: source.id,
      homeLabel: source.label,
      homePath: source.path,
      channel: WORKBUDDY_CHANNEL,
      source: WORKBUDDY_KIND,
      project: event.project,
      repositoryKey: repository.key,
      repositoryPath: repository.path,
      repositoryKind: repository.kind,
      // messageId 只供 perf reader 查表用：`insertEvent` 不读它、索引投影也不带它 ⇒ 不进库、不进 API。
      messageId: event.messageId,
      model: event.model,
      modelProvider: "",
      usage: event.usage,
      detailMask: event.detailMask,
      reconciliationGap: 0,
      cacheWriteTokens: event.cacheWriteTokens,
      cacheWriteKnown: event.cacheWriteKnown,
      requestInputTokens: event.requestInputTokens,
      contextLevel: event.contextLevel,
      serviceTier: event.serviceTier,
      priceVersion: event.priceVersion,
    });
  }
}

/** 供报告路径使用：把一个 WorkBuddy home 下所有会话汇总成 `{ sessions, events }`。 */
export async function parseWorkbuddySessions(homePath, source, options = {}) {
  const sessions = new Map();
  const events = [];

  for (const filePath of await workbuddySessionFiles(homePath)) {
    await streamWorkbuddySessionEvents(
      filePath,
      source,
      (event) => {
        events.push({
          id: event.messageId,
          sessionId: event.sessionId,
          timestamp: event.timestamp,
          homeId: event.homeId,
          homeLabel: event.homeLabel,
          homePath: event.homePath,
          channel: event.channel,
          source: event.source,
          originator: "",
          cwd: event.project,
          repositoryKey: event.repositoryKey,
          repositoryPath: event.repositoryPath,
          repositoryKind: event.repositoryKind,
          conversationName: "",
          model: event.model,
          total: event.usage,
          detailMask: event.detailMask,
          reconciliationGap: event.reconciliationGap,
          cacheWriteTokens: event.cacheWriteTokens,
          cacheWriteKnown: event.cacheWriteKnown,
          requestInputTokens: event.requestInputTokens,
          contextLevel: event.contextLevel,
          serviceTier: event.serviceTier,
          priceVersion: event.priceVersion,
        });

        const session = sessions.get(event.sessionId) || {
          id: event.sessionId,
          filePath,
          firstAt: event.timestamp,
          lastAt: event.timestamp,
          homeId: event.homeId,
          homeLabel: event.homeLabel,
          homePath: event.homePath,
          channel: event.channel,
          source: event.source,
          originator: "",
          cwd: event.project,
          conversationName: "",
          model: event.model,
          cliVersion: "",
          modelProvider: "",
          eventCount: 0,
          total: emptyUsage(),
        };
        if (event.timestampMs < Date.parse(session.firstAt)) session.firstAt = event.timestamp;
        if (event.timestampMs > Date.parse(session.lastAt)) session.lastAt = event.timestamp;
        session.eventCount += 1;
        session.model = event.model;
        for (const field of ["total", "input", "cached", "output", "reasoning"]) {
          session.total[field] += event.usage[field] || 0;
        }
        sessions.set(event.sessionId, session);
      },
      options,
    );
  }

  return { sessions: [...sessions.values()], events };
}

/** `<home>/traces/<pid>/trace_*.jsonl` 的绝对路径（不存在时为空数组）。 */
export async function workbuddyTraceFiles(homePath) {
  const root = path.join(homePath, TRACES_DIR);
  const files = [];
  for (const entry of await directoryEntries(root)) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    for (const file of await directoryEntries(directory)) {
      if (file.isFile() && file.name.startsWith(TRACE_FILE_PREFIX) && file.name.endsWith(JSONL_SUFFIX)) {
        files.push(path.join(directory, file.name));
      }
    }
  }
  return files.sort();
}

/**
 * 单个 trace 文件里的 generation span。
 * @param {string} filePath
 * @param {{ onWarning?: (warning: string) => void }} [options]
 * @returns {Promise<Array<{ messageId: string, durationMs: number, endedAtMs: number | null }>>}
 */
export async function workbuddyTraceSpans(filePath, options = {}) {
  const spans = [];
  let malformed = 0;
  for await (const line of readRolloutLines(filePath)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (row?.type !== "span_end") continue;
    const span = row.span;
    if (!span || span.type !== "generation" || span.status !== "ok") continue;
    let output;
    try {
      output = JSON.parse(span.toolOutput);
    } catch {
      malformed += 1;
      continue;
    }
    const messageId = trimmed(Array.isArray(output) ? output[0]?.id : "");
    if (!messageId) {
      malformed += 1;
      continue;
    }
    const durationMs = Number(span.duration);
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) continue;
    const endedAtMs = Date.parse(String(span.endedAt ?? ""));
    spans.push({
      messageId,
      durationMs,
      endedAtMs: Number.isFinite(endedAtMs) ? endedAtMs : null,
    });
  }
  if (malformed > 0) options.onWarning?.(`WORKBUDDY_TRACE_MALFORMED_JSON:${malformed} (${filePath})`);
  return spans;
}

/**
 * 扫 trace 文件，取 `generation` span 的**直接观测时长**。
 *
 * 只收 `status === "ok"` 的 span；`toolOutput` 是 JSON 字符串，`[0].id` 即该次响应的 messageId。
 * `duration` 必须是正整数毫秒 —— 非正/非整数一律丢弃（不制造 `DURATION_NONPOSITIVE` 样本）。
 * @param {string} homePath
 * @param {{ onWarning?: (warning: string) => void }} [options]
 * @returns {Promise<Array<{ messageId: string, durationMs: number, endedAtMs: number | null }>>}
 */
export async function workbuddyGenerationSpans(homePath, options = {}) {
  const spans = [];
  for (const filePath of await workbuddyTraceFiles(homePath)) {
    spans.push(...(await workbuddyTraceSpans(filePath, options)));
  }
  return spans;
}
