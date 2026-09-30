// OpenCode 用量数据源：读取 OpenCode 自己的 SQLite 会话库（session_v2 + session_message 表），
// 输出与 Codex / ZCode 会话日志一致的标准化用量事件。
//
// 口径依据（上游 v2 runner 写入的是互不重叠的拆分：input = nonCachedInputTokens、
// output = visibleOutputTokens，reasoning 与 cache.{read,write} 各自独立）：
//   input = tokens.input + tokens.cache.read + tokens.cache.write（总输入）
//   output = tokens.output + tokens.reasoning（总输出，折叠）
// 上游历史上 output 的含义变过（旧语义已含 reasoning），只支持 v2 会话，见版本守护。
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { LONG_CONTEXT_INPUT_THRESHOLD, pricingVersionForTimestamp } from "./pricing.js";
import { createRepositoryResolver } from "./repository-identity.js";
import { USAGE_DETAIL_MASK, emptyUsage, isZeroUsage, validateUsageDetails } from "../public/usage-fields.js";

// session_message 表的必需列。缺列说明 schema 又变了，整来源跳过并给出可诊断的警告。
const SESSION_MESSAGE_REQUIRED_COLUMNS = ["id", "session_id", "type", "seq", "time_created", "data"];
// 只支持 v2 语义（output 为可见输出、不含 reasoning）。旧语义折叠会重复计数。
const OPENCODE_SUPPORTED_SESSION_MAJOR = 2;
const SESSION_TITLE_LIMIT = 120;

function knownToken(value) {
  const number = Number(value);
  const known = value !== null && value !== undefined && value !== "" && Number.isFinite(number) && number >= 0;
  return { tokens: known ? number : 0, known };
}

// 上游 tokens 是互不重叠的拆分，重构成看板要求的超集口径：
// cached + cacheWrite ⊆ input（DSH 式的并列陷阱），reasoning ⊆ output。
export function opencodeUsageFromTokens(tokens = {}) {
  const cache = tokens.cache || {};
  const input = knownToken(tokens.input);
  const cacheRead = knownToken(cache.read);
  const cacheWrite = knownToken(cache.write);
  const output = knownToken(tokens.output);
  const reasoning = knownToken(tokens.reasoning);
  // cache.write 缺失只影响 cacheWrite 明细位，不污染 input（历史行可能没有该字段）。
  const inputKnown = input.known && cacheRead.known;
  const usage = {
    ...emptyUsage(),
    total: 0,
    input: input.tokens + cacheRead.tokens + cacheWrite.tokens,
    cached: cacheRead.tokens,
    output: output.tokens + reasoning.tokens,
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

function timestampMsFor(data, row) {
  const completed = Number(data?.time?.completed);
  if (Number.isFinite(completed) && completed > 0) {
    return completed;
  }
  const created = Number(data?.time?.created);
  if (Number.isFinite(created) && created > 0) {
    return created;
  }
  const rowTime = Number(row.time_created);
  return Number.isFinite(rowTime) && rowTime > 0 ? rowTime : null;
}

function sessionVersionMajor(version) {
  const text = String(version ?? "").trim();
  if (!text) {
    return null;
  }
  const major = Number(text.split(".")[0]);
  return Number.isInteger(major) && major >= 0 ? major : null;
}

function truncateName(value) {
  const text = String(value || "").trim();
  return text.length > SESSION_TITLE_LIMIT ? `${text.slice(0, SESSION_TITLE_LIMIT)}…` : text;
}

export async function opencodeDatabaseFiles(dataDir) {
  let entries;
  try {
    entries = await readdir(dataDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && /^opencode.*\.db$/.test(entry.name))
    .map((entry) => path.join(dataDir, entry.name))
    .sort();
}

export async function opencodeHomeLooksUsable(homePath) {
  return (await opencodeDatabaseFiles(homePath)).length > 0;
}

export async function opencodeSourceStat(dbFile) {
  // OpenCode 运行时新写入先落在 WAL 文件里，增量检测必须把 -wal 也算进指纹。
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

function openOpencodeDatabase(dbFile) {
  try {
    return new DatabaseSync(dbFile, { readOnly: true });
  } catch {
    // 崩溃残留的 WAL 需要恢复后才能只读打开，这种情况下退回普通打开。
    return new DatabaseSync(dbFile);
  }
}

function checkMessageTable(database, dbFile) {
  let columns;
  try {
    columns = database
      .prepare('PRAGMA table_info("session_message")')
      .all()
      .map((column) => column.name);
  } catch (error) {
    throw new Error(`无法读取 OpenCode 会话表 ${dbFile}: ${error.message}`);
  }
  const missing = SESSION_MESSAGE_REQUIRED_COLUMNS.filter((column) => !columns.includes(column));
  if (missing.length) {
    throw new Error(`OpenCode 会话表 ${dbFile} 缺少列 ${missing.join(", ")}，已跳过`);
  }
}

function loadSessions(database) {
  try {
    const sessions = new Map();
    for (const row of database.prepare("SELECT id, directory, title, version FROM session_v2").all()) {
      sessions.set(String(row.id || ""), row);
    }
    return sessions;
  } catch {
    // 会话表缺失只影响工作目录、标题与版本守护，用量事件仍要输出。
    return new Map();
  }
}

export async function streamOpencodeDbEvents(dbFile, source, onEvent, options = {}) {
  const resolveRepository = options.repositoryResolver || createRepositoryResolver();
  const onWarning = options.onWarning;
  const database = openOpencodeDatabase(dbFile);
  try {
    checkMessageTable(database, dbFile);
    const sessionsById = loadSessions(database);
    if (!sessionsById.size) {
      onWarning?.(`OpenCode 数据库 ${dbFile} 没有会话表或会话为空，工作目录与标题将缺失`);
    }
    const warnedSessions = new Set();

    const rows = database
      .prepare(
        "SELECT id, session_id, type, seq, time_created, data FROM session_message WHERE type = 'assistant' ORDER BY time_created, seq",
      )
      .iterate();
    for (const row of rows) {
      let data;
      try {
        data = JSON.parse(String(row.data));
      } catch {
        // 写入中断可能留下坏 JSON，跳过即可。
        continue;
      }
      if (!data?.tokens || typeof data.tokens !== "object") {
        continue;
      }

      const sessionId = String(row.session_id || "").trim() || String(row.id || "").trim();
      if (!sessionId) {
        continue;
      }
      const session = sessionsById.get(sessionId);
      const versionMajor = session ? sessionVersionMajor(session.version) : null;
      if (session && versionMajor !== null && versionMajor < OPENCODE_SUPPORTED_SESSION_MAJOR) {
        if (!warnedSessions.has(sessionId)) {
          warnedSessions.add(sessionId);
          onWarning?.(
            `OpenCode 会话 ${sessionId} 的版本为 v${session.version}，本版本只支持 v${OPENCODE_SUPPORTED_SESSION_MAJOR}，已跳过`,
          );
        }
        continue;
      }
      if (versionMajor === null && !warnedSessions.has(sessionId)) {
        warnedSessions.add(sessionId);
        onWarning?.(`OpenCode 会话 ${sessionId} 缺少可解析的版本号，已按 v${OPENCODE_SUPPORTED_SESSION_MAJOR} 解析`);
      }

      const timestampMs = timestampMsFor(data, row);
      if (timestampMs === null) {
        continue;
      }
      const { usage, detailMask, cacheWrite } = opencodeUsageFromTokens(data.tokens);
      if (isZeroUsage(usage)) {
        continue;
      }

      const cwd = String(session?.directory || "").trim();
      const repository = await resolveRepository(cwd);
      const inputKnown = Boolean(detailMask & USAGE_DETAIL_MASK.input);
      const timestamp = new Date(timestampMs).toISOString();
      const detailValidation = validateUsageDetails(usage, detailMask);
      const model = data?.model;
      await onEvent({
        eventId: `${sessionId}:${row.seq ?? timestampMs}`,
        timestampMs,
        timestamp,
        sessionId,
        homeId: source.id,
        homeLabel: source.label,
        homePath: source.path,
        channel: "OpenCode",
        source: "opencode",
        project: cwd,
        repositoryKey: repository.key,
        repositoryPath: repository.path,
        repositoryKind: repository.kind,
        conversationName: truncateName(session?.title),
        model: String(model?.id || "").trim() || "Unknown model",
        modelProvider: String(model?.providerID || "").trim(),
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

export async function parseOpencodeDb(dbFile, source, options = {}) {
  const sessions = new Map();
  const events = [];

  await streamOpencodeDbEvents(
    dbFile,
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
    },
    options,
  );

  return {
    sessions: [...sessions.values()],
    events,
  };
}
