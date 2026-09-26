// ZCode 用量数据源：读取 ZCode 自己的 SQLite 会话库（model_usage 表），
// 输出与 Codex 会话日志一致的标准化用量事件。
import { stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { LONG_CONTEXT_INPUT_THRESHOLD, pricingVersionForTimestamp } from "./pricing.js";
import { createRepositoryResolver } from "./repository-identity.js";
import { USAGE_DETAIL_MASK, emptyUsage, isZeroUsage, validateUsageDetails } from "./usage-fields.js";

// 相对 ZCode home 目录的数据库位置，按顺序探测。
const ZCODE_DB_RELATIVE_PATHS = [
  ["cli", "db", "db.sqlite"],
  ["db", "db.sqlite"],
];
const SESSION_TITLE_LIMIT = 120;

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function zcodeDatabaseFile(homePath) {
  for (const segments of ZCODE_DB_RELATIVE_PATHS) {
    const candidate = path.join(homePath, ...segments);
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return "";
}

export async function zcodeHomeLooksUsable(homePath) {
  return Boolean(await zcodeDatabaseFile(homePath));
}

export async function zcodeSourceStat(dbFile) {
  // ZCode 运行时新写入先落在 WAL 文件里，增量检测必须把 -wal 也算进指纹。
  const main = await stat(dbFile);
  let size = main.size;
  let mtimeMs = main.mtimeMs;
  try {
    const wal = await stat(`${dbFile}-wal`);
    size += wal.size;
    mtimeMs = Math.max(mtimeMs, wal.mtimeMs);
  } catch {
    // 没有 WAL 文件时主库就是最新状态。
  }
  return { size, mtimeMs };
}

function openZcodeDatabase(dbFile) {
  try {
    return new DatabaseSync(dbFile, { readOnly: true });
  } catch {
    // 崩溃残留的 WAL 需要恢复后才能只读打开，这种情况下退回普通打开。
    return new DatabaseSync(dbFile);
  }
}

function knownToken(value) {
  const number = Number(value);
  const known = value !== null && value !== undefined && value !== "" && Number.isFinite(number) && number >= 0;
  return { tokens: known ? number : 0, known };
}

function usageFromRow(row) {
  const input = knownToken(row.input_tokens);
  const cached = knownToken(row.cache_read_input_tokens);
  const output = knownToken(row.output_tokens);
  const reasoning = knownToken(row.reasoning_tokens);
  const usage = {
    ...emptyUsage(),
    input: input.tokens,
    cached: cached.tokens,
    output: output.tokens,
    reasoning: reasoning.tokens,
  };
  const providedTotal = row.computed_total_tokens ?? row.provider_total_tokens;
  const total = knownToken(providedTotal);
  usage.total = total.known ? total.tokens : usage.input + usage.output;
  const detailMask =
    (input.known ? USAGE_DETAIL_MASK.input : 0) |
    (cached.known ? USAGE_DETAIL_MASK.cached : 0) |
    (output.known ? USAGE_DETAIL_MASK.output : 0) |
    (reasoning.known ? USAGE_DETAIL_MASK.reasoning : 0);
  return { usage, detailMask, cacheWrite: knownToken(row.cache_creation_input_tokens) };
}

function timestampMsFor(row) {
  const completed = Number(row.completed_at);
  if (Number.isFinite(completed) && completed > 0) {
    return completed;
  }
  const started = Number(row.started_at);
  return Number.isFinite(started) && started > 0 ? started : null;
}

export function zcodeChannel(row) {
  return row.query_source === "subagent" || row.task_type === "subagent_child"
    ? "ZCode Subagent"
    : "ZCode";
}

function sessionDirectory(sessionsById, sessionId, depth = 0) {
  const row = sessionsById.get(sessionId);
  if (!row || depth > 5) {
    return "";
  }
  const directory = String(row.directory || row.path || "").trim();
  if (directory) {
    return directory;
  }
  return sessionDirectory(sessionsById, String(row.parent_id || "").trim(), depth + 1);
}

function truncateName(value) {
  const text = String(value || "").trim();
  return text.length > SESSION_TITLE_LIMIT ? `${text.slice(0, SESSION_TITLE_LIMIT)}…` : text;
}

export async function streamZcodeDbEvents(dbFile, source, onEvent, options = {}) {
  const resolveRepository = options.repositoryResolver || createRepositoryResolver();
  const database = openZcodeDatabase(dbFile);
  try {
    let sessionsById = new Map();
    try {
      for (const row of database.prepare("SELECT * FROM session").all()) {
        sessionsById.set(String(row.id || ""), row);
      }
    } catch {
      // 会话表缺失只影响工作目录归属，用量事件仍要输出。
      sessionsById = new Map();
    }

    for (const row of database.prepare("SELECT * FROM model_usage ORDER BY completed_at, id").iterate()) {
      const timestampMs = timestampMsFor(row);
      if (timestampMs === null) {
        continue;
      }
      const { usage, detailMask, cacheWrite } = usageFromRow(row);
      if (isZeroUsage(usage)) {
        continue;
      }

      const sessionId = String(row.session_id || "").trim() || `zcode:${row.id}`;
      const cwd = sessionDirectory(sessionsById, sessionId);
      const repository = await resolveRepository(cwd);
      const inputKnown = Boolean(detailMask & USAGE_DETAIL_MASK.input);
      const timestamp = new Date(timestampMs).toISOString();
      const detailValidation = validateUsageDetails(usage, detailMask);
      await onEvent({
        eventId: String(row.id || `${sessionId}:${timestampMs}`),
        timestampMs,
        timestamp,
        sessionId,
        homeId: source.id,
        homeLabel: source.label,
        homePath: source.path,
        channel: zcodeChannel(row),
        source: "zcode",
        project: cwd,
        repositoryKey: repository.key,
        repositoryPath: repository.path,
        repositoryKind: repository.kind,
        conversationName: truncateName(sessionsById.get(sessionId)?.title),
        model: String(row.model_id || "").trim() || "Unknown model",
        modelProvider: String(row.provider_id || "").trim(),
        usage,
        detailMask: detailValidation.detailMask,
        reconciliationGap: detailValidation.reconciliationGap,
        cacheWriteTokens: cacheWrite.tokens,
        cacheWriteKnown: cacheWrite.known,
        requestInputTokens: inputKnown ? usage.input : 0,
        contextLevel: inputKnown ? (usage.input > LONG_CONTEXT_INPUT_THRESHOLD ? "long" : "short") : "unknown",
        serviceTier: "unknown",
        priceVersion: pricingVersionForTimestamp(timestamp),
      });
    }
  } finally {
    database.close();
  }
}

export async function parseZcodeDb(dbFile, source, options = {}) {
  const sessions = new Map();
  const events = [];

  await streamZcodeDbEvents(dbFile, source, (event) => {
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
      filePath: dbFile,
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
  }, options);

  return {
    sessions: [...sessions.values()],
    events,
  };
}
