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
import { createHash } from "node:crypto";
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
const LOGS_DIR = "logs";
const TOOL_RESULTS_DIR = "tool-results";
const TRACE_FILE_PREFIX = "trace_";
const JSONL_SUFFIX = ".jsonl";
const LOG_SUFFIX = ".log";
const HEAD_PROBE_BYTES = 64 * 1024;
const HOME_PROBE_FILE_LIMIT = 3;
const LOG_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SANDBOX_DIR = "sandbox";
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

function nonNegativeInteger(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function nonNegativeNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function contentTypes(record, field = "content") {
  const content = record?.[field];
  if (!Array.isArray(content)) return [];
  return content.map((item) => trimmed(item?.type) || (item === null ? "null" : typeof item));
}

function readProbeBytes(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = readSync(handle, buffer, read, length - read, position + read);
    if (count === 0) break;
    read += count;
  }
  if (read !== length) throw new Error("SHORT_LOG_PROBE");
  return buffer;
}

function logContentProbe(filePath, size) {
  const handle = openSync(filePath, "r");
  try {
    if (size <= HEAD_PROBE_BYTES) return readProbeBytes(handle, size, 0);
    const half = HEAD_PROBE_BYTES / 2;
    return Buffer.concat([readProbeBytes(handle, half, 0), readProbeBytes(handle, half, Math.max(0, size - half))]);
  } finally {
    closeSync(handle);
  }
}

async function discoverWorkbuddyLogFiles(homePath) {
  const root = path.join(homePath, LOGS_DIR);
  let rootEntries;
  try {
    const info = await stat(root);
    if (!info.isDirectory()) return { files: [], complete: true };
    rootEntries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    return { files: [], complete: error?.code === "ENOENT" };
  }

  const files = [];
  let complete = true;
  const walk = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      complete = false;
      return;
    }
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== SANDBOX_DIR) await walk(filePath);
      } else if (entry.isFile() && entry.name.endsWith(LOG_SUFFIX)) {
        files.push(filePath);
      }
    }
  };
  for (const day of rootEntries) {
    if (day.isDirectory() && LOG_DAY_PATTERN.test(day.name)) {
      await walk(path.join(root, day.name));
    }
  }
  return { files: files.sort(), complete };
}

/**
 * Bounded WorkBuddy log discovery. The probe covers the first and last 32 KiB
 * of large files and the whole file below 64 KiB; it never returns log text.
 * @param {string} homePath
 * @returns {Promise<{
 *   files: string[],
 *   entries: Array<{ filePath: string, size: number, mtimeMs: number }>,
 *   fingerprints: Record<string, string>,
 *   fingerprint: string,
 *   complete: boolean
 * }>}
 */
export async function workbuddyLogSnapshot(homePath) {
  const discovered = await discoverWorkbuddyLogFiles(homePath);
  const entries = [];
  /** @type {Record<string, string>} */
  const fingerprints = {};
  const aggregate = createHash("sha256");
  let complete = discovered.complete;

  for (const filePath of discovered.files) {
    try {
      const info = await stat(filePath);
      const probe = logContentProbe(filePath, info.size);
      const digest = createHash("sha256");
      digest.update(filePath);
      digest.update("\0");
      digest.update(String(info.size));
      digest.update("\0");
      digest.update(String(info.mtimeMs));
      digest.update("\0");
      digest.update(probe);
      const fingerprint = digest.digest("hex");
      entries.push({ filePath, size: info.size, mtimeMs: info.mtimeMs });
      fingerprints[filePath] = fingerprint;
      aggregate.update(`${filePath}\t${fingerprint}\n`);
    } catch {
      complete = false;
      aggregate.update(`${filePath}\t!\n`);
    }
  }

  return {
    files: discovered.files,
    entries,
    fingerprints,
    fingerprint: aggregate.digest("hex"),
    complete,
  };
}

function reasoningTimingState({
  textFirstMs,
  textTotalMs,
  thinkFirstMs,
  thinkTotalMs,
  thinkChars,
  thinkBytes,
  thinkEvents,
}) {
  const reasoningEvidence = (thinkChars ?? 0) > 0 || (thinkBytes ?? 0) > 0 || (thinkEvents ?? 0) > 0;
  if (!reasoningEvidence) return "none";
  if (
    textFirstMs === null ||
    textTotalMs === null ||
    thinkFirstMs === null ||
    thinkTotalMs === null ||
    thinkTotalMs <= 0
  ) {
    return "unknown";
  }
  if (thinkFirstMs >= textFirstMs) return "at_or_after_text";
  if (thinkFirstMs + thinkTotalMs > textFirstMs) return "overlaps_text";
  return "before_text";
}

function normalizeTextTimingEnd(record) {
  const messageId = trimmed(record?.message_id);
  if (!messageId) return null;
  const outputTokens = nonNegativeInteger(record.completion_tokens);
  const httpBeginStatusCode = nonNegativeInteger(record.http_begin_status_code);
  const httpEndStatusCode = nonNegativeInteger(record.http_end_status_code);
  const textFirstMs = nonNegativeNumber(record.text_first_cost_ms);
  const textTotalMs = nonNegativeNumber(record.text_total_cost_ms);
  const textChars = nonNegativeInteger(record.text_content_chars);
  const textBytes = nonNegativeInteger(record.text_content_bytes);
  const textEvents = nonNegativeInteger(record.text_total_tokens);
  const thinkFirstMs = nonNegativeNumber(record.think_first_cost_ms);
  const thinkTotalMs = nonNegativeNumber(record.think_total_cost_ms);
  const thinkChars = nonNegativeInteger(record.think_content_chars);
  const thinkBytes = nonNegativeInteger(record.think_content_bytes);
  const thinkEvents = nonNegativeInteger(record.think_total_tokens);
  const finishFlag = trimmed(record.finish_flag);
  const finishReason = trimmed(record.finish_reason);
  const modelError = trimmed(record.model_error);
  const traceId = trimmed(record.trace_id);
  const conversationRequestId = trimmed(record.conversation_request_id);
  const model = trimmed(record.model);
  const terminal =
    finishFlag === "done" &&
    finishReason === "stop" &&
    modelError === "" &&
    (httpBeginStatusCode === null || httpBeginStatusCode === 200) &&
    (httpEndStatusCode === null || httpEndStatusCode === 200);
  const textTiming = textFirstMs !== null && textTotalMs !== null && textTotalMs > 0;
  const textEvidence =
    textChars !== null && textChars > 0 && textBytes !== null && textBytes > 0 && textEvents !== null && textEvents > 0;
  const reasoningTiming = reasoningTimingState({
    textFirstMs,
    textTotalMs,
    thinkFirstMs,
    thinkTotalMs,
    thinkChars,
    thinkBytes,
    thinkEvents,
  });
  const phaseGate = Object.freeze({
    terminal,
    textTiming,
    textEvidence,
    reasoningTiming,
  });
  const evidence = [
    messageId,
    outputTokens,
    finishFlag,
    finishReason,
    modelError,
    httpBeginStatusCode,
    httpEndStatusCode,
    traceId,
    conversationRequestId,
    model,
    textFirstMs,
    textTotalMs,
    textChars,
    textBytes,
    textEvents,
    thinkFirstMs,
    thinkTotalMs,
    thinkChars,
    thinkBytes,
    thinkEvents,
  ];
  const evidenceKey = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
  return {
    messageId,
    outputTokens,
    finishFlag,
    finishReason,
    modelError,
    httpBeginStatusCode,
    httpEndStatusCode,
    traceId,
    conversationRequestId,
    model,
    textFirstMs,
    textTotalMs,
    textChars,
    textBytes,
    textEvents,
    thinkFirstMs,
    thinkTotalMs,
    thinkChars,
    thinkBytes,
    thinkEvents,
    durationMs: textTotalMs !== null && textTotalMs > 0 ? textTotalMs : null,
    phaseGate,
    evidenceKey,
  };
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

function sessionRecordEvidence(record) {
  const providerData = record?.providerData || {};
  const mappedUsage = providerData.usage ? usageFromProviderData(providerData) : null;
  return {
    type: trimmed(record?.type),
    role: trimmed(record?.role),
    status: trimmed(record?.status),
    contentTypes: contentTypes(record),
    rawContentTypes: contentTypes(record, "rawContent"),
    hasUsage: Boolean(providerData.usage),
    outputTokens:
      mappedUsage && (mappedUsage.detailMask & USAGE_DETAIL_MASK.output) !== 0 ? mappedUsage.usage.output : null,
    reasoningTokens:
      mappedUsage && (mappedUsage.detailMask & USAGE_DETAIL_MASK.reasoning) !== 0 ? mappedUsage.usage.reasoning : null,
    traceId: trimmed(providerData.traceId),
    conversationRequestId: trimmed(providerData.conversationRequestId),
    model: trimmed(providerData.model),
  };
}

function buildSessionNativeProof(group) {
  const usageRecords = group.records.filter((record) => record.hasUsage);
  const messages = group.records.filter((record) => record.type === "message");
  const reasoning = group.records.filter((record) => record.type === "reasoning");
  const usage = usageRecords.length === 1 ? usageRecords[0] : null;
  const outputTokens = usage?.outputTokens ?? null;
  const reasoningTokens = usage?.reasoningTokens ?? null;
  const usageKnown =
    usage !== null &&
    Number.isSafeInteger(outputTokens) &&
    outputTokens >= 0 &&
    Number.isSafeInteger(reasoningTokens) &&
    reasoningTokens >= 0 &&
    outputTokens >= reasoningTokens;
  const message = messages.length === 1 ? messages[0] : null;
  const messageTextOnly =
    message !== null &&
    message.role === "assistant" &&
    message.status === "completed" &&
    message.contentTypes.length === 1 &&
    ["text", "output_text"].includes(message.contentTypes[0]);
  const reasoningRecord = reasoning.length === 1 ? reasoning[0] : null;
  const reasoningBeforeText =
    reasoningTokens === 0
      ? reasoning.length === 0
      : reasoningTokens !== null &&
        reasoningTokens > 0 &&
        reasoningRecord !== null &&
        group.records.indexOf(reasoningRecord) < group.records.indexOf(message);
  const completeOutput =
    messageTextOnly &&
    group.records.length === messages.length + reasoning.length &&
    (reasoningTokens === 0 ||
      (reasoningTokens !== null &&
        reasoningTokens > 0 &&
        reasoning.length === 1 &&
        group.records.length === 2 &&
        group.records[0] === reasoningRecord &&
        group.records[1] === message &&
        reasoningRecord.rawContentTypes.length === 1 &&
        reasoningRecord.rawContentTypes[0] === "reasoning_text"));
  const traceIds = [...group.traceIds];
  const conversationRequestIds = [...group.conversationRequestIds];
  return {
    recordCount: group.records.length,
    usageCount: usageRecords.length,
    messageCount: messages.length,
    reasoningCount: reasoning.length,
    outputTokens,
    reasoningTokens,
    nonReasoningTokens:
      usageKnown && reasoningTokens !== null && outputTokens !== null ? outputTokens - reasoningTokens : null,
    model: usage?.model || "",
    traceId: traceIds.length === 1 ? traceIds[0] : "",
    traceIdCount: traceIds.length,
    conversationRequestId: conversationRequestIds.length === 1 ? conversationRequestIds[0] : "",
    conversationRequestIdCount: conversationRequestIds.length,
    completeOutput,
    reasoningBeforeText,
    textOnly: usageKnown && completeOutput,
  };
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
  const groups = new Map();
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
    const providerData = record?.providerData;
    const messageId = trimmed(providerData?.messageId);
    if (!messageId) continue;
    const group = groups.get(messageId) || {
      records: [],
      usageRecords: [],
      traceIds: new Set(),
      conversationRequestIds: new Set(),
    };
    const evidence = sessionRecordEvidence(record);
    group.records.push(evidence);
    if (evidence.traceId) group.traceIds.add(evidence.traceId);
    if (evidence.conversationRequestId) group.conversationRequestIds.add(evidence.conversationRequestId);
    if (USAGE_RECORD_TYPES.has(evidence.type) && providerData.usage) {
      group.usageRecords.push({ record, providerData });
    }
    groups.set(messageId, group);
  }

  if (malformed > 0) options.onWarning?.(`WORKBUDDY_MALFORMED_JSON:${malformed} (${filePath})`);

  const events = [];
  for (const [messageId, group] of groups) {
    const selected = group.usageRecords.find(({ record, providerData }) => {
      if (isAutoRecord(providerData)) return false;
      return Number.isFinite(timestampMsOf(record));
    });
    if (!selected) continue;
    const { record, providerData } = selected;
    const timestampMs = timestampMsOf(record);
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
      nativeProof: buildSessionNativeProof(group),
    });
  }
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
      nativeProof: event.nativeProof,
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

/**
 * Map every usage message to the session files that contain it. Used only when a
 * new trace duration has no published sample path to jump from.
 * @param {string} homePath
 * @returns {Promise<Map<string, Set<string>>>}
 */
export async function workbuddySessionMessageFiles(homePath) {
  const byMessage = new Map();
  for (const filePath of await workbuddySessionFiles(homePath)) {
    const seen = new Set();
    for await (const line of readRolloutLines(filePath)) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!USAGE_RECORD_TYPES.has(String(record?.type || ""))) continue;
      const providerData = record?.providerData;
      if (!providerData?.usage) continue;
      const messageId = trimmed(providerData.messageId);
      if (!messageId || seen.has(messageId)) continue;
      seen.add(messageId);
      const files = byMessage.get(messageId) || new Set();
      files.add(filePath);
      byMessage.set(messageId, files);
    }
  }
  return byMessage;
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

/**
 * Parse only `qua.end` scalar evidence from one bounded log file.
 * @param {string} filePath
 * @param {{ onWarning?: (warning: string) => void }} [options]
 */
export async function workbuddyTextTimingSpans(filePath, options = {}) {
  const spans = [];
  let malformed = 0;
  for await (const line of readRolloutLines(filePath)) {
    if (!line.includes("qua.end")) continue;
    const brace = line.indexOf("{");
    if (brace < 0) {
      malformed += 1;
      continue;
    }
    let record;
    try {
      record = JSON.parse(line.slice(brace));
    } catch {
      malformed += 1;
      continue;
    }
    const normalized = normalizeTextTimingEnd(record);
    if (normalized !== null) spans.push(normalized);
  }
  if (malformed > 0) options.onWarning?.(`WORKBUDDY_LOG_MALFORMED_JSON:${malformed} (${filePath})`);
  return spans;
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
 * One discovery/stat pass for the trace dependency. The caller compares snapshots
 * around candidate reads; unreadable entries make `complete=false`.
 * @param {string} homePath
 * @returns {Promise<{ files: string[], entries: Array<{ filePath: string, size: number, mtimeMs: number }>, complete: boolean }>}
 */
export async function workbuddyTraceSnapshot(homePath) {
  const files = await workbuddyTraceFiles(homePath);
  const entries = [];
  let complete = true;
  for (const filePath of files) {
    try {
      const info = await stat(filePath);
      entries.push({ filePath, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      complete = false;
    }
  }
  return { files, entries, complete };
}

const TRACE_PROVIDER_KEYS = new Set(["id", "created", "model", "object", "choices", "usage"]);
const TRACE_CHOICE_KEYS = new Set(["index", "logprobs", "finish_reason", "message"]);
const TRACE_MESSAGE_KEYS = new Set(["role", "content", "refusal", "tool_calls"]);
const TOOL_SPAN_TYPES = new Set(["function", "custom", "agent"]);

function traceOutputEvidence(span) {
  let output;
  try {
    output = JSON.parse(span?.toolOutput);
  } catch {
    return null;
  }
  const provider = Array.isArray(output) && output.length === 1 ? output[0] : null;
  const choices = provider?.choices;
  const choice = Array.isArray(choices) && choices.length === 1 ? choices[0] : null;
  const message = choice?.message;
  const usage = provider?.usage;
  const completionTokens = nonNegativeInteger(usage?.completion_tokens);
  const reasoningTokens = nonNegativeInteger(usage?.completion_tokens_details?.reasoning_tokens);
  const nonTextDetails = {
    accepted: nonNegativeInteger(usage?.completion_tokens_details?.accepted_prediction_tokens),
    audio: nonNegativeInteger(usage?.completion_tokens_details?.audio_tokens),
    rejected: nonNegativeInteger(usage?.completion_tokens_details?.rejected_prediction_tokens),
    cached: nonNegativeInteger(usage?.completion_tokens_details?.cached_tokens),
  };
  const contentChars = typeof message?.content === "string" ? [...message.content].length : null;
  const refusalAbsent = message?.refusal === undefined || message?.refusal === null || trimmed(message.refusal) === "";
  const toolCallsAbsent =
    message?.tool_calls === undefined || (Array.isArray(message.tool_calls) && message.tool_calls.length === 0);
  const unexpectedProviderKeysAbsent =
    provider !== null &&
    typeof provider === "object" &&
    Object.keys(provider).every((key) => TRACE_PROVIDER_KEYS.has(key));
  const unexpectedChoiceKeysAbsent =
    choice !== null && typeof choice === "object" && Object.keys(choice).every((key) => TRACE_CHOICE_KEYS.has(key));
  const unexpectedMessageKeysAbsent =
    message !== null && typeof message === "object" && Object.keys(message).every((key) => TRACE_MESSAGE_KEYS.has(key));
  const truncatedFields = Array.isArray(span?.attributes?.tracePayloadTruncatedFields)
    ? span.attributes.tracePayloadTruncatedFields.map(String)
    : [];
  const outputComplete = span?.attributes?.tracePayloadTruncated !== true || !truncatedFields.includes("toolOutput");
  const textOnly =
    trimmed(provider?.object) === "chat.completion" &&
    Array.isArray(output) &&
    output.length === 1 &&
    Array.isArray(choices) &&
    choices.length === 1 &&
    trimmed(choice?.finish_reason) === "stop" &&
    typeof message?.content === "string" &&
    contentChars !== null &&
    contentChars > 0 &&
    refusalAbsent &&
    toolCallsAbsent &&
    unexpectedProviderKeysAbsent &&
    unexpectedChoiceKeysAbsent &&
    unexpectedMessageKeysAbsent;
  const nonTextDetailsKnownZero = Object.values(nonTextDetails).every((value) => value === 0);
  return {
    messageId: trimmed(provider?.id),
    model: trimmed(provider?.model),
    providerObject: trimmed(provider?.object),
    providerItems: Array.isArray(output) ? output.length : null,
    choices: Array.isArray(choices) ? choices.length : null,
    finishReason: trimmed(choice?.finish_reason),
    contentChars,
    outputTokens: completionTokens,
    reasoningTokens,
    nonReasoningTokens:
      completionTokens !== null && reasoningTokens !== null && completionTokens >= reasoningTokens
        ? completionTokens - reasoningTokens
        : null,
    nonTextDetails,
    nonTextDetailsKnownZero,
    outputComplete,
    textOnly,
    truncatedFields,
  };
}

function traceSpanGraphByTrace(spanGraph) {
  const byTrace = new Map();
  for (const span of spanGraph) {
    if (!span.traceId) continue;
    const spans = byTrace.get(span.traceId) || [];
    spans.push(span);
    byTrace.set(span.traceId, spans);
  }
  return byTrace;
}

function descendantToolSpans(generation, graph) {
  const byId = new Map(graph.map((span) => [span.spanId, span]));
  const descendants = [];
  for (const span of graph) {
    let cursor = span;
    const seen = new Set();
    while (cursor?.parentId && !seen.has(cursor.parentId)) {
      seen.add(cursor.parentId);
      if (cursor.parentId === generation.spanId) {
        if (TOOL_SPAN_TYPES.has(span.type)) descendants.push(span);
        break;
      }
      cursor = byId.get(cursor.parentId);
    }
  }
  return descendants;
}

/**
 * 单个 trace 文件里的 generation span。`durationMs` 仍是既有 E2E 诊断；
 * `evidence` 只保留完成纯正文/N 校验所需的标量与 span 图，不返回正文。
 * @param {string} filePath
 * @param {{ onWarning?: (warning: string) => void }} [options]
 * @returns {Promise<Array<{
 *   messageId: string,
 *   durationMs: number,
 *   endedAtMs: number | null,
 *   evidence: Record<string, unknown>
 * }>>}
 */
export async function workbuddyTraceSpans(filePath, options = {}) {
  const generationRows = [];
  const spanGraph = [];
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
    if (!span) continue;
    const graphEntry = {
      traceId: trimmed(span.traceId),
      spanId: trimmed(span.spanId),
      parentId: trimmed(span.parentId),
      type: trimmed(span.type),
    };
    if (graphEntry.traceId && graphEntry.spanId) spanGraph.push(graphEntry);
    if (span.type !== "generation" || span.status !== "ok") continue;
    const output = traceOutputEvidence(span);
    if (output === null || !output.messageId) {
      malformed += 1;
      continue;
    }
    generationRows.push({ span, output });
  }

  const graphByTrace = traceSpanGraphByTrace(spanGraph);
  const spans = [];
  for (const { span, output } of generationRows) {
    const durationMs = Number(span.duration);
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) continue;
    const traceId = trimmed(span.traceId);
    const spanId = trimmed(span.spanId);
    const graph = traceId ? (graphByTrace.get(traceId) ?? []) : [];
    const generation = { spanId, parentId: trimmed(span.parentId), type: "generation" };
    const descendants = descendantToolSpans(generation, graph);
    const endedAtMs = Date.parse(String(span.endedAt ?? ""));
    spans.push({
      messageId: output.messageId,
      durationMs,
      endedAtMs: Number.isFinite(endedAtMs) ? endedAtMs : null,
      evidence: {
        ...output,
        status: trimmed(span.status),
        traceId,
        spanId,
        parentId: trimmed(span.parentId),
        durationMs,
        descendantToolCount: descendants.length,
        traceGraphComplete: malformed === 0 && Boolean(traceId) && Boolean(spanId),
        traceSpanGraph: graph,
      },
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
 * @param {{ files?: string[], onWarning?: (warning: string) => void }} [options]
 * @returns {Promise<Array<{ messageId: string, durationMs: number, endedAtMs: number | null }>>}
 */
export async function workbuddyGenerationSpans(homePath, options = {}) {
  const spans = [];
  for (const filePath of options.files ?? (await workbuddyTraceFiles(homePath))) {
    spans.push(...(await workbuddyTraceSpans(filePath, options)));
  }
  return spans;
}

function endReasoningBeforeText(end, reasoningTokens) {
  if (end.textFirstMs === null || end.textTotalMs === null || end.thinkFirstMs === null || end.thinkTotalMs === null) {
    return false;
  }
  if (reasoningTokens === 0) {
    return end.phaseGate.reasoningTiming === "none";
  }
  return reasoningTokens > 0 && end.phaseGate.reasoningTiming === "before_text";
}

function mergedTraceGraph(generationSpans, traceId) {
  const byId = new Map();
  for (const generation of generationSpans) {
    const evidence = generation?.evidence;
    if (!evidence || evidence.traceId !== traceId || !Array.isArray(evidence.traceSpanGraph)) continue;
    for (const span of evidence.traceSpanGraph) {
      if (span?.spanId) byId.set(span.spanId, span);
    }
  }
  return [...byId.values()];
}

/**
 * Join normalized `qua.end` records with one trace generation per messageId.
 * Session usage/order remains in `event.nativeProof`; the reader closes that
 * third side before using this result as an explicit text timing.
 * @param {Array<Record<string, any>>} textSpans
 * @param {Array<Record<string, any>>} generationSpans
 * @returns {(messageId: string) => Record<string, any> | null}
 */
export function createWorkbuddyTextTimingLookup(textSpans, generationSpans) {
  const endsByMessage = new Map();
  for (const span of textSpans) {
    const messageId = trimmed(span?.messageId);
    if (!messageId) continue;
    const ends = endsByMessage.get(messageId) || new Map();
    ends.set(String(span.evidenceKey), span);
    endsByMessage.set(messageId, ends);
  }
  const generationsByMessage = new Map();
  for (const span of generationSpans) {
    const messageId = trimmed(span?.messageId);
    if (!messageId) continue;
    const generations = generationsByMessage.get(messageId) || [];
    generations.push(span);
    generationsByMessage.set(messageId, generations);
  }

  return (messageId) => {
    const ends = endsByMessage.get(trimmed(messageId));
    if (ends?.size !== 1) return null;
    const generations = generationsByMessage.get(trimmed(messageId));
    if (generations?.length !== 1) return null;
    const end = [...ends.values()][0];
    const generation = generations[0];
    const trace = generation?.evidence;
    if (!trace) return null;
    if (
      end.phaseGate?.terminal !== true ||
      end.phaseGate?.textTiming !== true ||
      end.phaseGate?.textEvidence !== true ||
      !Number.isSafeInteger(end.outputTokens) ||
      end.outputTokens < 0 ||
      !Number.isSafeInteger(end.textFirstMs) ||
      !Number.isSafeInteger(end.textTotalMs) ||
      end.textTotalMs <= 0 ||
      !Number.isSafeInteger(end.textChars) ||
      end.textChars <= 0 ||
      !Number.isSafeInteger(end.textBytes) ||
      end.textBytes <= 0 ||
      !Number.isSafeInteger(end.textEvents) ||
      end.textEvents <= 0
    ) {
      return null;
    }
    if (
      trace.status !== "ok" ||
      trace.finishReason !== "stop" ||
      trace.outputComplete !== true ||
      trace.textOnly !== true ||
      trace.nonTextDetailsKnownZero !== true ||
      trace.traceGraphComplete !== true ||
      !Number.isSafeInteger(trace.outputTokens) ||
      !Number.isSafeInteger(trace.reasoningTokens) ||
      trace.reasoningTokens < 0 ||
      trace.outputTokens < trace.reasoningTokens ||
      trace.outputTokens !== end.outputTokens ||
      trace.nonReasoningTokens <= 1 ||
      !endReasoningBeforeText(end, trace.reasoningTokens)
    ) {
      return null;
    }
    const graph = mergedTraceGraph(generationSpans, trace.traceId);
    const descendants = descendantToolSpans(
      { spanId: trace.spanId, parentId: trace.parentId, type: "generation" },
      graph,
    );
    if (descendants.length !== 0) return null;
    return {
      durationMs: end.textTotalMs,
      outputTokens: end.outputTokens,
      reasoningTokens: trace.reasoningTokens,
      nonReasoningTokens: trace.nonReasoningTokens,
      textFirstMs: end.textFirstMs,
      textTotalMs: end.textTotalMs,
      textChars: end.textChars,
      textBytes: end.textBytes,
      textEvents: end.textEvents,
      thinkFirstMs: end.thinkFirstMs,
      thinkTotalMs: end.thinkTotalMs,
      thinkChars: end.thinkChars,
      thinkBytes: end.thinkBytes,
      thinkEvents: end.thinkEvents,
      model: end.model,
      endTraceId: end.traceId,
      generationTraceId: trace.traceId,
      conversationRequestId: end.conversationRequestId,
      evidenceKey: end.evidenceKey,
    };
  };
}
