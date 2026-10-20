// Claude Code 用量数据源：读取 ~/.claude/projects 下的会话转录（JSONL）。
//
// 转录格式要点（Claude Code 2.1.x 实测）：
// - 每条 assistant 记录是**一个内容块一行**，同一 message.id 会重复 1–6 次；
//   直接累加会把 token 放大 2.5–3 倍。因此必须按 message.id 去重。
// - 子代理用量写在 <sessionId>/subagents/agent-<agentId>.jsonl，父转录里没有。
//   子代理文件会先写零用量占位块、最后一块才有真实 usage，去重时取 token 和最大者。
// - usage 的三个输入计数是**并列**的（input_tokens 不含缓存），必须重构成看板要求的
//   input 超集：input = input_tokens + cache_read + cache_creation，cached = cache_read。
// - 模型身份取 message.model（API 实际服务的线路模型）。requestedModel 是请求侧的
//   harness 别名：直连时是 tier/别名（如内置代理的 "haiku"），经网关时是路由名
//   （如 mythos-magpie-*）。网关会把真实上游模型写回响应，只有 message.model 能被
//   价目表识别；requestedModel 仅在 message.model 缺失或为占位符时回退。
// - tool-results/ 里是外部化的大工具输出（可达数十 MB），绝不读取。
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { readRolloutLines } from "./codex-rollout.js";
import { LONG_CONTEXT_INPUT_THRESHOLD, pricingVersionForTimestamp } from "./pricing.js";
import { createRepositoryResolver } from "./repository-identity.js";
import { USAGE_DETAIL_MASK, emptyUsage, isZeroUsage, validateUsageDetails } from "../public/usage-fields.js";

const PROJECTS_DIR = "projects";
const SUBAGENTS_DIR = "subagents";
const SESSION_TITLE_LIMIT = 120;

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function knownToken(value) {
  const number = Number(value);
  const known = value !== null && value !== undefined && value !== "" && Number.isFinite(number) && number >= 0;
  return { tokens: known ? number : 0, known };
}

function truncateName(value) {
  const text = String(value || "").trim();
  return text.length > SESSION_TITLE_LIMIT ? `${text.slice(0, SESSION_TITLE_LIMIT)}…` : text;
}

export async function claudeProjectsDirectory(homePath) {
  const directory = path.join(homePath, PROJECTS_DIR);
  return (await exists(directory)) ? directory : "";
}

/**
 * 判定一个目录是不是 Claude Code home。
 * 不能只看有没有 projects 目录：必须存在 <projects>/<encoded-cwd>/<sessionId>.jsonl。
 */
export async function claudeHomeLooksUsable(homePath) {
  const root = await claudeProjectsDirectory(homePath);
  if (!root) {
    return false;
  }
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const project of projects) {
    if (!project.isDirectory()) {
      continue;
    }
    let entries;
    try {
      entries = await readdir(path.join(root, project.name), { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))) {
      return true;
    }
  }
  return false;
}

/**
 * 收集主转录与子代理转录。
 * 显式跳过 tool-results/ 与 memory/：前者是外部化的大工具输出，后者是记忆文件。
 */
export async function claudeSessionFiles(homePath) {
  const root = await claudeProjectsDirectory(homePath);
  if (!root) {
    return [];
  }
  const files = [];
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const project of projects) {
    if (!project.isDirectory()) {
      continue;
    }
    const projectDir = path.join(root, project.name);
    let entries;
    try {
      entries = await readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(path.join(projectDir, entry.name));
        continue;
      }
      if (!entry.isDirectory() || entry.name === "tool-results" || entry.name === "memory") {
        continue;
      }
      // 子代理转录位于 <sessionId>/subagents/agent-<agentId>.jsonl。
      const subagentsDir = path.join(projectDir, entry.name, SUBAGENTS_DIR);
      let subagents;
      try {
        subagents = await readdir(subagentsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const agent of subagents) {
        if (agent.isFile() && agent.name.endsWith(".jsonl")) {
          files.push(path.join(subagentsDir, agent.name));
        }
      }
    }
  }
  return files.sort();
}

export async function claudeSourceStat(filePath) {
  const info = await stat(filePath);
  return { size: info.size, mtimeMs: info.mtimeMs };
}

// 上游 usage 是并列计数，重构成看板要求的超集口径：
// cached + cacheWrite ⊆ input，reasoning ⊆ output。
export function claudeUsageFromRaw(raw = {}) {
  const input = knownToken(raw.input_tokens);
  const cacheRead = knownToken(raw.cache_read_input_tokens);
  const cacheWrite = knownToken(raw.cache_creation_input_tokens);
  const output = knownToken(raw.output_tokens);
  const reasoning = knownToken(raw.output_tokens_details?.thinking_tokens);
  const inputKnown = input.known && cacheRead.known;
  const usage = {
    ...emptyUsage(),
    input: input.tokens + cacheRead.tokens + cacheWrite.tokens,
    cached: cacheRead.tokens,
    output: output.tokens,
    reasoning: reasoning.tokens,
  };
  usage.total = usage.input + usage.output;
  const detailMask =
    (inputKnown ? USAGE_DETAIL_MASK.input : 0) |
    (cacheRead.known ? USAGE_DETAIL_MASK.cached : 0) |
    (output.known ? USAGE_DETAIL_MASK.output : 0) |
    (reasoning.known ? USAGE_DETAIL_MASK.reasoning : 0) |
    (cacheWrite.known ? USAGE_DETAIL_MASK.cacheWrite : 0);
  return { usage, detailMask, cacheWrite };
}

// 只有部分模型有 Fast 档；无 Fast 的模型由计价端给出 standard 场景提示。
export function claudeServiceTier(usage = {}) {
  if (
    String(usage.speed || "")
      .trim()
      .toLowerCase() === "fast"
  ) {
    return "fast";
  }
  const tier = String(usage.service_tier || "")
    .trim()
    .toLowerCase();
  if (tier === "fast" || tier === "priority") return "fast";
  if (tier === "standard" || tier === "default") return "standard";
  return "unknown";
}

function tokenSum(usage) {
  return usage.total;
}

// 转录用 <synthetic> 标记本地生成的记录（不是模型响应），它没有可计价的身份。
function servedModel(record) {
  const wire = String(record.message?.model || "").trim();
  if (wire && !wire.startsWith("<")) {
    return wire;
  }
  return String(record.requestedModel || "").trim();
}

function eventFromRecord(record, usage, detailMask, cacheWrite, resolveRepository) {
  const sessionId = String(record.sessionId || "").trim();
  const timestampMs = Date.parse(record.timestamp);
  if (!sessionId || !Number.isFinite(timestampMs)) {
    return null;
  }
  const cwd = String(record.cwd || "").trim();
  const model = servedModel(record) || "Unknown model";
  const inputKnown = Boolean(detailMask & USAGE_DETAIL_MASK.input);
  const timestamp = new Date(timestampMs).toISOString();
  const detailValidation = validateUsageDetails(usage, detailMask);
  return {
    eventId: String(record.message?.id || record.uuid || `${sessionId}:${timestampMs}`),
    timestampMs,
    timestamp,
    sessionId,
    project: cwd,
    model,
    usage,
    detailMask: detailValidation.detailMask,
    reconciliationGap: detailValidation.reconciliationGap,
    cacheWriteTokens: cacheWrite.tokens,
    cacheWriteKnown: cacheWrite.known,
    requestInputTokens: inputKnown ? usage.input : 0,
    contextLevel: inputKnown ? (usage.input > LONG_CONTEXT_INPUT_THRESHOLD ? "long" : "short") : "unknown",
    serviceTier: claudeServiceTier(record.message?.usage),
    priceVersion: pricingVersionForTimestamp(timestamp),
    resolveRepository,
  };
}

/**
 * 单遍扫描一个转录文件，产出标准化用量事件。
 * 只读用量与元数据字段；message.content、工具参数与结果一律不读。
 * @param {string} filePath
 * @param {{ id: string, label: string, path: string }} source
 * @param {(event: any) => Promise<void> | void} onEvent
 */
export async function streamClaudeSessionEvents(filePath, source, onEvent, options = {}) {
  const resolveRepository = options.repositoryResolver || createRepositoryResolver();
  // 同一 message.id 只保留 token 和最大的一条：主文件是多块同值快照，
  // 子代理文件是零用量占位块 + 一个真实块。
  const bestByMessage = new Map();
  let conversationName = "";
  let malformed = 0;
  let missingMessageId = 0;

  for await (const line of readRolloutLines(filePath)) {
    if (!line.trim()) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    const type = String(record?.type || "");
    if (type === "custom-title" || type === "agent-name") {
      const title = String(record.customTitle || record.agentName || "").trim();
      if (title) {
        conversationName = truncateName(title);
      }
      continue;
    }
    if (type !== "assistant" || !record?.message?.usage) {
      continue;
    }
    const mapped = claudeUsageFromRaw(record.message.usage);
    if (isZeroUsage(mapped.usage)) {
      continue;
    }
    const key = String(record.message?.id || "").trim();
    if (!key) {
      missingMessageId += 1;
    }
    const identity = key || String(record.uuid || "");
    if (!identity) {
      continue;
    }
    const candidate = eventFromRecord(record, mapped.usage, mapped.detailMask, mapped.cacheWrite, resolveRepository);
    if (!candidate) {
      continue;
    }
    const previous = bestByMessage.get(identity);
    if (!previous || tokenSum(candidate.usage) > tokenSum(previous.usage)) {
      bestByMessage.set(identity, candidate);
    }
  }

  if (malformed > 0) {
    options.onWarning?.(`CLAUDE_MALFORMED_JSON:${malformed} (${filePath})`);
  }
  if (missingMessageId > 0) {
    options.onWarning?.(`CLAUDE_MISSING_MESSAGE_ID:${missingMessageId} (${filePath})`);
  }

  const events = [...bestByMessage.values()].sort(
    (left, right) => left.timestampMs - right.timestampMs || left.eventId.localeCompare(right.eventId),
  );
  for (const event of events) {
    const repository = await event.resolveRepository(event.project);
    await onEvent({
      eventId: event.eventId,
      timestampMs: event.timestampMs,
      timestamp: event.timestamp,
      sessionId: event.sessionId,
      homeId: source.id,
      homeLabel: source.label,
      homePath: source.path,
      channel: "Claude Code",
      source: "claude",
      project: event.project,
      repositoryKey: repository.key,
      repositoryPath: repository.path,
      repositoryKind: repository.kind,
      conversationName,
      model: event.model,
      modelProvider: "",
      usage: event.usage,
      detailMask: event.detailMask,
      reconciliationGap: event.reconciliationGap,
      cacheWriteTokens: event.cacheWriteTokens,
      cacheWriteKnown: event.cacheWriteKnown,
      requestInputTokens: event.requestInputTokens,
      contextLevel: event.contextLevel,
      serviceTier: event.serviceTier,
      priceVersion: event.priceVersion,
    });
  }
}

/** 供 buildUsageReport 使用：把一个 Claude Code home 下所有转录汇总成 { sessions, events }。 */
export async function parseClaudeSessions(homePath, source, options = {}) {
  const sessions = new Map();
  const events = [];

  for (const filePath of await claudeSessionFiles(homePath)) {
    await streamClaudeSessionEvents(
      filePath,
      source,
      (event) => {
        events.push({
          id: event.eventId,
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
          conversationName: event.conversationName,
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
          conversationName: event.conversationName,
          model: event.model,
          cliVersion: "",
          modelProvider: event.modelProvider,
          eventCount: 0,
          total: emptyUsage(),
        };
        if (event.timestampMs < Date.parse(session.firstAt)) {
          session.firstAt = event.timestamp;
        }
        if (event.timestampMs > Date.parse(session.lastAt)) {
          session.lastAt = event.timestamp;
        }
        if (event.conversationName) {
          session.conversationName = event.conversationName;
        }
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

  return {
    sessions: [...sessions.values()],
    events,
  };
}
