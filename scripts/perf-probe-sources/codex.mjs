// Codex（~/.codex）只读有界探测：JSONL 元数据、终态与范围证据（M0.5）。
//
// 证据纪律（与方案 §17.1「Codex 去重和归属」和任务卡 M0.5 对齐）：
// - 只访问结构元数据：顶层 type、payload.type、payload.turn_id / thread_id / response_id、
//   item.type / id / started_at_ms / completed_at_ms、usage 的数值字段、终态的时间字段。
// - **绝不访问** item.content / summary_text / raw_content、task_complete.last_agent_message、
//   time_to_first_token_ms；不读取任何正文。
// - 内存里用不落盘的复合键（thread|turn|item、thread|turn|response）做去重、配对与跨度计算；
//   落盘产物里只有计数与固定枚举，**不出现任何原始 ID**。
// - 逐列存在性走 fields.columns / fields.requiredColumns（键名限外壳白名单）。
// - 分层计数走 scanned（§17.5 形状）；flag 计数走 decisions.flagCounts。

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

export const CODEX_PROBE_VERSION = "1";

/** 旧时段切点：与方案 §17.5 的 Codex byEra 切点一致（2026-09-28T01:00:57Z）。 */
export const ERA_CUTOFF_MS = Date.parse("2026-09-28T01:00:57Z");

/** 长轮阈值，与 §17.4 位 4（LONG_WINDOW，duration_ms > 300000）一致。 */
export const LONG_WINDOW_MS = 300000;

/** 秒级时间戳上界（epoch 秒约 1.8e9，epoch 毫秒约 1.8e12）。 */
const SECOND_LIKE_MAX = 1e11;

export const FLAG_NAMES_ORDERED = Object.freeze([
  "OUTPUT_ZERO",
  "DURATION_NONPOSITIVE",
  "LONG_WINDOW",
  "MULTI_REQUEST_TURN",
  "PARTIAL_ITEM_SPAN",
  "MISSING_DURATION",
  "MISSING_OUTPUT",
  "MODEL_AMBIGUOUS",
  "TERMINAL_UNVERIFIED",
  "SOURCE_FILTERED",
  "RECORD_CONFLICT",
  "OVERLAPPING_ITEM_SPAN",
  "TIME_INVALID",
  "TIME_UNPLACED",
  "METHOD_ESTIMATE",
  "TOKEN_INVALID",
]);

/**
 * JSONL 判别式（PascalCase）与 SQLite item_type（camelCase）的**两处显式映射**。
 * 刻意分开写、分开用：混用大小写是本卡点名要防的错误。
 */
export const JSONL_ITEM_TYPES = Object.freeze({ AgentMessage: "agentMessage", Reasoning: "reasoning" });
export const SQLITE_ITEM_TYPES = Object.freeze({ agentMessage: "agentMessage", reasoning: "reasoning" });

/** 顶层 JSONL 类型。 */
const TOP_TYPE = Object.freeze({
  sessionMeta: "session_meta",
  turnContext: "turn_context",
  tokenUsageRecord: "token_usage_record",
  eventMsg: "event_msg",
});

/** event_msg.payload.type 中本卡点名的三类。 */
const EVENT_TYPE = Object.freeze({
  itemCompleted: "item_completed",
  taskComplete: "task_complete",
  tokenCount: "token_count",
  taskStarted: "task_started",
});

/** JSONL 逐列存在性：只登记外壳 `KNOWN_COLUMN_NAMES` 在册的名字。 */
export const JSONL_COLUMN_NAMES = Object.freeze([
  "thread_id",
  "turn_id",
  "item_type",
  "started_at_ms",
  "completed_at_ms",
  "response_id",
  "turn_context",
  "event_msg",
  "item_completed",
  "task_complete",
  "turn_token_usage",
  "sessions_meta",
  "thread_source",
  "source_kind",
]);

export const SQLITE_COLUMN_NAMES = Object.freeze([
  "item_type",
  "item_id",
  "thread_id",
  "turn_id",
  "started_at_ms",
  "completed_at_ms",
  "turn_context", // thread_history.thread_turns：轮级 status/started_at/completed_at
  "item_completed", // thread_items：按 item 粒度投影（不读 item_json 正文）
  "task_complete", // thread_turns.status='completed'：与 JSONL task_complete 对照
]);

/** 可选只读候选：不预设必须接入，只报「投影自身覆盖」与「全 JSONL 候选覆盖」。 */
export const OPTIONAL_SQLITE_FILES = Object.freeze(["thread_history_1.sqlite", "state_5.sqlite"]);

const SESSION_DIRS = Object.freeze(["sessions", "archived_sessions"]);

const TARGET_ITEM_TYPES = Object.freeze(["agentMessage", "reasoning"]);

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function nonNegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isSecondLike(value) {
  return Number.isSafeInteger(value) && value > 0 && value < SECOND_LIKE_MAX;
}

function inc(map, key) {
  if (key) map[key] = (map[key] || 0) + 1;
}

function walkJsonl(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === ".tmp" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(full, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

/** 有界取样：按规范排序后取首尾 N 个，与 M0.1 CLI 的默认口径一致。 */
function sampleFiles(sorted, maxFiles) {
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0 || sorted.length <= maxFiles) return sorted;
  const head = Math.ceil(maxFiles / 2);
  const tail = maxFiles - head;
  return [...sorted.slice(0, head), ...(tail > 0 ? sorted.slice(-tail) : [])];
}

function listRollouts(homePath, { maxFiles = 4, full = false } = {}) {
  const found = [];
  for (const dir of SESSION_DIRS) {
    for (const filePath of walkJsonl(path.join(homePath, dir), [])) {
      found.push({ filePath, archived: dir === "archived_sessions" });
    }
  }
  found.sort((left, right) => (left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0));
  return { found, selected: full ? found : sampleFiles(found, maxFiles) };
}

function emptyJsonlFacts() {
  return {
    lines: 0,
    malformedJson: 0,
    nonObjectRows: 0,
    topLevelCounts: {},
    eventPayloadCounts: {},
    sessionMeta: {
      sourcePresent: false,
      sourceIsObject: false,
      sourceSubagentFlag: false,
      sourceThreadSpawn: false,
      threadSourcePresent: false,
      kind: "unknown",
    },
    turnContextRows: 0,
    turnContextWithTurnId: 0,
    turnContextWithModel: 0,
    turnContextWithEffort: 0,
    tokenUsageRecords: 0,
    withResponseId: 0,
    withThreadId: 0,
    withTurnId: 0,
    withUsage: 0,
    withTurnUsage: 0,
    itemCompletedRows: 0,
    itemWithId: 0,
    itemWithSpan: 0,
    itemMissingSpan: 0,
    taskCompleteRows: 0,
    taskCompleteWithSpan: 0,
    taskCompleteWithDurationMs: 0,
    taskCompleteSpanMatchesDuration: 0,
    unitSecondLikeRows: 0,
    unitMsLikeRows: 0,
    conflicts: {
      recordConflict: 0,
      requestSumMismatch: 0,
      crossCheckUnavailable: 0,
      modelAmbiguous: 0,
      spanConflict: 0,
      unkeyable: 0,
      crossRolloutDuplicate: 0,
      multiRolloutThreads: 0,
    },
    /** 累计输出交叉校验的三态计数：matched / conflict / unavailable。 */
    crossCheckStates: { matched: 0, conflict: 0, unavailable: 0 },
    /** 同一轮的证据来自一个以上 rollout 上下文的轮数（跨文件合并量）。 */
    crossFileMergedEvidence: 0,
  };
}

function mergeJsonlFacts(target, source) {
  target.lines += source.lines;
  target.malformedJson += source.malformedJson;
  target.nonObjectRows += source.nonObjectRows;
  for (const [key, value] of Object.entries(source.topLevelCounts))
    target.topLevelCounts[key] = (target.topLevelCounts[key] || 0) + value;
  for (const [key, value] of Object.entries(source.eventPayloadCounts))
    target.eventPayloadCounts[key] = (target.eventPayloadCounts[key] || 0) + value;
  for (const key of [
    "turnContextRows",
    "turnContextWithTurnId",
    "turnContextWithModel",
    "turnContextWithEffort",
    "tokenUsageRecords",
    "withResponseId",
    "withThreadId",
    "withTurnId",
    "withUsage",
    "withTurnUsage",
    "itemCompletedRows",
    "itemWithId",
    "itemWithSpan",
    "itemMissingSpan",
    "taskCompleteRows",
    "taskCompleteWithSpan",
    "taskCompleteWithDurationMs",
    "taskCompleteSpanMatchesDuration",
    "unitSecondLikeRows",
    "unitMsLikeRows",
  ]) {
    target[key] += source[key];
  }
  for (const [key, value] of Object.entries(source.conflicts)) target.conflicts[key] += value;
  for (const [key, value] of Object.entries(source.crossCheckStates || {})) {
    target.crossCheckStates[key] = (target.crossCheckStates[key] || 0) + value;
  }
  target.crossFileMergedEvidence += source.crossFileMergedEvidence || 0;
  const meta = source.sessionMeta;
  target.sessionMeta.sourcePresent ||= meta.sourcePresent;
  target.sessionMeta.sourceIsObject ||= meta.sourceIsObject;
  target.sessionMeta.sourceSubagentFlag ||= meta.sourceSubagentFlag;
  target.sessionMeta.sourceThreadSpawn ||= meta.sourceThreadSpawn;
  target.sessionMeta.threadSourcePresent ||= meta.threadSourcePresent;
  if (meta.kind !== "unknown" && target.sessionMeta.kind === "unknown") target.sessionMeta.kind = meta.kind;
}

export function createProbeFacts() {
  return emptyJsonlFacts();
}

// ---------------------------------------------------------------------------
// 单文件解析
// ---------------------------------------------------------------------------

function readRecordTimestamp(row) {
  const raw = row?.timestamp;
  if (typeof raw !== "string" || !raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function readSessionMeta(payload, facts) {
  const source = payload.source;
  const meta = facts.sessionMeta;
  meta.sourcePresent = source !== undefined && source !== null;
  if (isObject(source)) {
    meta.sourceIsObject = true;
    meta.kind = "object_structured";
    const subagent = source.subagent;
    if (isObject(subagent)) {
      meta.sourceSubagentFlag = true;
      if (isObject(subagent.thread_spawn)) meta.sourceThreadSpawn = true;
    }
  } else if (typeof source === "string") {
    meta.kind = "plain_string";
  } else if (!meta.sourcePresent) {
    meta.kind = "absent";
  }
  if (typeof payload.thread_source === "string" && payload.thread_source) meta.threadSourcePresent = true;
}

/**
 * 读取单个 rollout 文件的结构元数据。
 * 返回的 records 只含**结构字段**，不含任何正文。
 */
export function readRolloutRecords(filePath, facts = createProbeFacts()) {
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return { facts, records: [], readFailed: true };
  }
  const records = [];
  // rollout 上下文键只用文件名派生，不落盘；用于把不带 thread_id 的顶层记录
  // （turn_context / task_complete）归到正确的 rollout 上。
  const fileKey = path.basename(filePath);
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    facts.lines += 1;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      facts.malformedJson += 1;
      continue;
    }
    if (!isObject(row)) {
      facts.nonObjectRows += 1;
      continue;
    }
    const topType = text(row.type);
    inc(facts.topLevelCounts, topType);
    const payload = isObject(row.payload) ? row.payload : null;
    const atMs = readRecordTimestamp(row);

    if (topType === TOP_TYPE.sessionMeta) {
      if (payload) readSessionMeta(payload, facts);
      // 该 rollout 所属线程的**兜底来源**：session_meta 通常是一份 rollout 的首条记录。
      // 供「文件内没有任何带 thread_id 的 request/item」时推导归属，见 threadOfFileTurn。
      const metaId = text(payload?.id) || text(payload?.session_id);
      if (metaId) records.push({ kind: "session_meta", fileKey, threadId: metaId, atMs });
      continue;
    }

    if (topType === TOP_TYPE.turnContext) {
      facts.turnContextRows += 1;
      const turnId = text(payload?.turn_id);
      if (turnId) facts.turnContextWithTurnId += 1;
      const model = text(payload?.model);
      const effort = text(payload?.effort);
      if (model) facts.turnContextWithModel += 1;
      if (effort) facts.turnContextWithEffort += 1;
      records.push({ kind: "turn_context", fileKey, turnId, model, effort, atMs });
      continue;
    }

    if (topType === TOP_TYPE.tokenUsageRecord) {
      facts.tokenUsageRecords += 1;
      const threadId = text(payload?.thread_id);
      const turnId = text(payload?.turn_id);
      const responseId = text(payload?.response_id);
      if (threadId) facts.withThreadId += 1;
      if (turnId) facts.withTurnId += 1;
      if (responseId) facts.withResponseId += 1;
      const usage = isObject(payload?.usage) ? payload.usage : null;
      const turnUsage = isObject(payload?.turn_token_usage) ? payload.turn_token_usage : null;
      if (usage) facts.withUsage += 1;
      if (turnUsage) facts.withTurnUsage += 1;
      if (atMs !== null) {
        if (isSecondLike(atMs)) facts.unitSecondLikeRows += 1;
        else facts.unitMsLikeRows += 1;
      }
      records.push({
        kind: "request",
        fileKey,
        threadId,
        turnId,
        responseId,
        outputTokens: nonNegativeInt(usage?.output_tokens),
        turnOutputTokens: nonNegativeInt(turnUsage?.output_tokens),
        atMs,
        // 来源时序：记录在**本文件**中的行序（1-based）。跨文件时用
        // (timestamp, fileKey, lineOrdinal) 组合比较，见 orderKeyOf。
        lineOrdinal: facts.lines,
      });
      continue;
    }

    if (topType === TOP_TYPE.eventMsg) {
      const innerType = text(payload?.type);
      inc(facts.eventPayloadCounts, innerType);
      if (innerType === EVENT_TYPE.itemCompleted) {
        facts.itemCompletedRows += 1;
        const item = isObject(payload?.item) ? payload.item : null;
        const rawItemType = text(item?.type);
        const itemType = JSONL_ITEM_TYPES[rawItemType] || "other";
        const itemId = text(item?.id);
        const startedAtMs = nonNegativeInt(payload?.started_at_ms);
        const completedAtMs = nonNegativeInt(payload?.completed_at_ms);
        if (itemId) facts.itemWithId += 1;
        if (itemType !== "other") {
          if (startedAtMs !== null && completedAtMs !== null) facts.itemWithSpan += 1;
          else facts.itemMissingSpan += 1;
        }
        records.push({
          kind: "item",
          fileKey,
          itemType,
          itemTypeCase: itemType === "other" ? "unknown" : "pascal_case",
          itemId,
          threadId: text(payload?.thread_id),
          turnId: text(payload?.turn_id),
          startedAtMs,
          completedAtMs,
        });
        continue;
      }
      if (innerType === EVENT_TYPE.taskComplete) {
        facts.taskCompleteRows += 1;
        const startedAt = nonNegativeInt(payload?.started_at);
        const completedAt = nonNegativeInt(payload?.completed_at);
        const durationMs = nonNegativeInt(payload?.duration_ms);
        if (startedAt !== null && completedAt !== null) {
          facts.taskCompleteWithSpan += 1;
          if (durationMs !== null) {
            facts.taskCompleteWithDurationMs += 1;
            if (completedAt - startedAt === durationMs) facts.taskCompleteSpanMatchesDuration += 1;
          }
        }
        records.push({
          kind: "terminal",
          fileKey,
          turnId: text(payload?.turn_id),
          startedAt,
          completedAt,
          durationMs,
        });
        continue;
      }
      if (innerType === EVENT_TYPE.taskStarted) {
        records.push({ kind: "task_started", fileKey, turnId: text(payload?.turn_id), atMs });
      }
    }
    // 其余顶层类型（response_item / world_state / …）只进 topLevelCounts，不解析内容。
  }
  return { facts, records, readFailed: false };
}

// ---------------------------------------------------------------------------
// 去重、配对与归属
// ---------------------------------------------------------------------------

function keyOf(parts) {
  return parts.map((part) => String(part ?? "")).join("\u0001");
}

/**
 * 把三类记录归并成「轮」台账。
 *
 * 轮身份是 `(thread, turn)`（§17.1）。跨线程的同名 turn_id 因键里含 thread 而分开。
 *
 * `fileKey`（rollout 上下文）只用于把不带 `thread_id` 的顶层记录
 * （turn_context / task_complete）**推导**到正确的轮上，不参与轮身份。
 * 关键：同一 `(thread, turn)` 可能分布在**多个 rollout 文件**里（同线程多 rollout、重放、
 * 截断续写），因此该轮的全部 rollout 上下文都要参与合并 —— 不能只认首个文件的证据。
 */
export function buildTurnLedger(records, facts) {
  const turns = new Map();
  const threads = new Map();
  const terminalByTurn = new Map();
  /** fileKey -> (turnId -> threadId)：由该 rollout 内带 thread 与 turn 的记录建立归属。 */
  const threadByFileTurn = new Map();
  /**
   * fileKey -> threadId：由 session_meta 建立的「该 rollout 所属线程」。
   * 这是**兜底**归属来源——当某文件内找不到任何带 thread_id 的 request/item 时
   * （例如只含 turn_context + task_complete），仍然能把它归到正确的线程上。
   */
  const threadByFile = new Map();

  const noteThread = (fileKey, turnId, threadId) => {
    if (!fileKey || !turnId || !threadId) return;
    if (!threadByFileTurn.has(fileKey)) threadByFileTurn.set(fileKey, new Map());
    threadByFileTurn.get(fileKey).set(turnId, threadId);
  };
  /**
   * 该 rollout 上下文里 turnId 属于哪条线程。
   * 优先用文件内带 thread_id 的记录建立的精确映射；找不到时兜底用 session_meta 的线程。
   * 两者都没有 -> null：**不猜归属**，该证据保持 orphan。
   */
  const threadOfFileTurn = (fileKey, turnId) => {
    const precise = threadByFileTurn.get(fileKey)?.get(turnId);
    if (precise) return precise;
    return threadByFile.get(fileKey) ?? null;
  };

  const getTurn = (threadId, turnId) => {
    const key = keyOf([threadId, turnId]);
    let turn = turns.get(key);
    if (!turn) {
      turn = {
        key,
        threadId,
        turnId,
        /** 该轮出现过的**全部** rollout 上下文（用于合并跨文件证据）。 */
        fileKeys: new Set(),
        requests: new Map(),
        items: new Map(),
        terminals: [],
        taskStarts: [],
        modelKeys: new Set(),
        requestOutputSum: 0,
        attributedOutputSum: 0,
      };
      turns.set(key, turn);
    }
    return turn;
  };
  const getThread = (threadId) => {
    let thread = threads.get(threadId);
    if (!thread) {
      thread = { threadId, turnIds: new Set(), requestIds: new Set(), itemIds: new Set() };
      threads.set(threadId, thread);
    }
    return thread;
  };

  for (const record of records) {
    if (record.kind === "session_meta") {
      // 建立「该文件属于哪条线程」的兜底归属。同一文件可能有多条 session_meta（理论上），
      // 首条生效，后续同值可覆盖、异值不覆盖（避免用异常数据污染归属）。
      if (record.threadId && !threadByFile.has(record.fileKey)) {
        threadByFile.set(record.fileKey, record.threadId);
      }
      continue;
    }
    if (record.kind === "turn_context") {
      if (!record.turnId) continue;
      // 模型证据按精确 turn_id 登记；**归属延后**：顶层 turn_context 不带 thread_id，
      // 因此必须在同一文件的上下文里按 turn 归属，不能Key 到全局 turn_id。
      if (!terminalByTurn.has(`model:${record.turnId}`)) terminalByTurn.set(`model:${record.turnId}`, []);
      terminalByTurn
        .get(`model:${record.turnId}`)
        .push({ fileKey: record.fileKey, modelKey: `${record.model}|${record.effort}` });
      continue;
    }

    if (record.kind === "terminal") {
      if (!record.turnId) {
        facts.conflicts.unkeyable += 1;
        continue;
      }
      if (!terminalByTurn.has(`terminal:${record.turnId}`)) terminalByTurn.set(`terminal:${record.turnId}`, []);
      terminalByTurn.get(`terminal:${record.turnId}`).push(record);
      continue;
    }

    if (record.kind === "task_started") {
      if (record.turnId) {
        if (!terminalByTurn.has(`start:${record.turnId}`)) terminalByTurn.set(`start:${record.turnId}`, []);
        terminalByTurn.get(`start:${record.turnId}`).push(record);
      }
      continue;
    }

    if (record.kind === "request") {
      if (!record.threadId || !record.turnId) {
        facts.conflicts.unkeyable += 1;
        continue;
      }
      const turn = getTurn(record.threadId, record.turnId);
      turn.fileKeys.add(record.fileKey);
      noteThread(record.fileKey, record.turnId, record.threadId);
      const identity = record.responseId || `__no-response|${turn.requests.size}`;
      const existing = turn.requests.get(identity);
      if (existing) {
        if (existing.outputTokens !== record.outputTokens) {
          existing.conflict = true;
          facts.conflicts.recordConflict += 1;
        }
        existing.duplicates += 1;
        continue;
      }
      turn.requests.set(identity, {
        responseId: identity,
        outputTokens: record.outputTokens,
        turnOutputTokens: record.turnOutputTokens,
        atMs: record.atMs,
        lineOrdinal: record.lineOrdinal ?? null,
        fileKey: record.fileKey ?? null,
        duplicates: 0,
        conflict: false,
      });
      getThread(record.threadId).turnIds.add(record.turnId);
      getThread(record.threadId).requestIds.add(identity);
      continue;
    }

    if (record.kind === "item") {
      if (record.itemType === "other") continue;
      if (!record.threadId || !record.turnId || !record.itemId) {
        facts.conflicts.unkeyable += 1;
        continue;
      }
      const turn = getTurn(record.threadId, record.turnId);
      turn.fileKeys.add(record.fileKey);
      noteThread(record.fileKey, record.turnId, record.threadId);
      const existing = turn.items.get(record.itemId);
      if (existing) {
        const spanConflicts =
          (existing.startedAtMs ?? null) !== (record.startedAtMs ?? null) ||
          (existing.completedAtMs ?? null) !== (record.completedAtMs ?? null);
        if (spanConflicts) {
          existing.spanConflict = true;
          facts.conflicts.spanConflict += 1;
          facts.conflicts.recordConflict += 1;
        }
        existing.duplicates += 1;
        existing.startedAtMs ??= record.startedAtMs;
        existing.completedAtMs ??= record.completedAtMs;
        continue;
      }
      turn.items.set(record.itemId, {
        itemType: record.itemType,
        itemTypeCase: record.itemTypeCase,
        startedAtMs: record.startedAtMs,
        completedAtMs: record.completedAtMs,
        duplicates: 0,
        spanConflict: false,
      });
      getThread(record.threadId).turnIds.add(record.turnId);
      getThread(record.threadId).itemIds.add(record.itemId);
    }
  }

  // 终态/模型/起始证据的归属。
  //
  // 这些顶层记录**不带 thread_id**，所以归属只能靠「记录所在的 rollout 上下文」推导：
  // 在该 rollout 内，turnId 属于哪条线程（threadByFileTurn）就是它的轮身份。
  // 然后再按**复合轮身份 (thread, turn)** 合并 —— 同一轮的**全部** rollout 上下文都参与，
  // 而不是只认首个文件；否则同线程多 rollout 时后一个文件的证据会被整体丢弃。
  let crossFileMergedEvidence = 0;
  const evidenceFor = (kind, turn) => {
    const hits = [];
    for (const entry of terminalByTurn.get(`${kind}:${turn.turnId}`) || []) {
      // 该证据所在 rollout 里，这个 turnId 归属哪条线程？
      const owner = threadOfFileTurn(entry.fileKey, turn.turnId);
      if (owner === turn.threadId) hits.push(entry);
    }
    return hits;
  };

  for (const turn of turns.values()) {
    const models = evidenceFor("model", turn);
    for (const entry of models) turn.modelKeys.add(entry.modelKey);
    turn.terminals = evidenceFor("terminal", turn);
    turn.taskStarts = evidenceFor("start", turn);
    // 记录跨文件合并的量：同一轮的证据来自不止一个 rollout 上下文时计数。
    const evidenceFiles = new Set([...models, ...turn.terminals, ...turn.taskStarts].map((entry) => entry.fileKey));
    if (evidenceFiles.size > 1) crossFileMergedEvidence += 1;
  }
  facts.crossFileMergedEvidence = crossFileMergedEvidence;

  // 模型/effort 冲突：合并后的模型键集合 > 1 才是 MODEL_AMBIGUOUS。
  // 跨线程的重名 turn_id 因上面按线程过滤而互不影响。
  for (const turn of turns.values()) {
    if (turn.modelKeys.size > 1) facts.conflicts.modelAmbiguous += 1;
  }
  // 无法归属到任何轮的终态记录：单列，不进入任何分母。
  // 归属判据必须是**可推导出线程**（否则即使同名 turn_id 存在也不能算已归属），
  // 避免把一条无法定线程的终态错挂到同名的其他线程轮上。
  const orphanTerminals = [];
  for (const [key, value] of terminalByTurn.entries()) {
    if (!key.startsWith("terminal:")) continue;
    const turnId = key.slice("terminal:".length);
    for (const entry of value) {
      const owner = threadOfFileTurn(entry.fileKey, turnId);
      if (!owner || !turns.has(keyOf([owner, turnId]))) orphanTerminals.push(entry);
    }
  }

  // 跨 rollout / 重放重复：同线程多 rollout 的归属证据
  const rolloutsPerThread = new Map();
  for (const record of records) {
    const threadId = record.threadId || record.threadIdOfTurn || "";
    if (!threadId) continue;
    rolloutsPerThread.set(threadId, rolloutsPerThread.get(threadId) || 0);
  }
  for (const thread of threads.values()) {
    if (thread.turnIds.size > 1 && thread.itemIds.size > 0) {
      // 同线程多轮：无法据此判定多 rollout，真正的多 rollout 由文件数证据给出。
    }
  }

  return { turns, threads, orphanTerminals };
}

/**
 * 来源时序比较：判断哪条请求在**来源**里更靠后。
 *
 * 排序优先级（稳、且不依赖文件读取顺序）：
 *   1. timestamp（`atMs`）可比较时，按它排；这是来源自带的时序，最可信。
 *   2. 时间戳缺失或并列时，退化到「文件键 + 文件内行号」——这仍是**来源内的次序**，
 *      只是跨文件时的相对先后只能靠文件名裁定（见 handoff 的降级口径说明）。
 *   3. 都不可得时保持原样（返回 0），此时退化为插入顺序——会在 handoff 里如实登记。
 *
 * 注意：本函数只用于**选末条累计值**；`requestOutputSum` 是纯求和，与顺序无关。
 */
function compareBySourceOrder(left, right) {
  const leftTime = Number.isSafeInteger(left.atMs);
  const rightTime = Number.isSafeInteger(right.atMs);
  if (leftTime && rightTime && left.atMs !== right.atMs) return left.atMs - right.atMs;
  // 时间戳不可比（缺失或相等）时，用来源内的文件+行序兜底。
  if (leftTime && !rightTime) return -1;
  if (!leftTime && rightTime) return 1;
  const leftFile = left.fileKey || "";
  const rightFile = right.fileKey || "";
  if (leftFile !== rightFile) return leftFile < rightFile ? -1 : 1;
  const leftLine = Number.isSafeInteger(left.lineOrdinal) ? left.lineOrdinal : -1;
  const rightLine = Number.isSafeInteger(right.lineOrdinal) ? right.lineOrdinal : -1;
  return leftLine - rightLine;
}

/** 汇总单轮的层次与冲突信息。 */
export function classifyTurn(turn) {
  const items = [...turn.items.values()].filter(
    (item) => item.itemType === "agentMessage" || item.itemType === "reasoning",
  );
  const partialItems = items.filter(
    (item) =>
      !Number.isSafeInteger(item.startedAtMs) ||
      !Number.isSafeInteger(item.completedAtMs) ||
      item.completedAtMs - item.startedAtMs <= 0,
  ).length;
  const spans = items
    .map((item) => ({ start: item.startedAtMs, end: item.completedAtMs }))
    .filter((span) => Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) && span.end > span.start)
    .sort((left, right) => left.start - right.start);
  let overlapping = false;
  for (let index = 1; index < spans.length; index += 1)
    if (spans[index].start < spans[index - 1].end) overlapping = true;
  const spanSum = spans.reduce((sum, span) => sum + (span.end - span.start), 0);
  const maxSpan = spans.reduce((max, span) => Math.max(max, span.end - span.start), 0);

  const requests = [...turn.requests.values()];
  const outputKnown = requests.length > 0 && requests.every((request) => Number.isSafeInteger(request.outputTokens));
  const requestOutputSum = requests.reduce(
    (sum, request) => sum + (Number.isSafeInteger(request.outputTokens) ? request.outputTokens : 0),
    0,
  );

  // §17.1 第 5 条：去重请求 output 之和是分子主路径，**末条** turn_token_usage.output_tokens
  // 仅做交叉校验。累计值正常递增（4、11、…），因此**不能**要求所有累计值相等——
  // 那会把正常递增判为「不可校验」而静默跳过，错误的末条值就不产生冲突了。
  //
  // 「末条」必须按**来源时序**选，绝不能按 Map 插入顺序（= 文件读取顺序）：
  // 跨文件乱序读入时会选错末条，导致正确累计值被判冲突；
  // 且末条缺值时会错误回退到较早的值去校验。
  // 排序键见 orderKeyOf：优先 timestamp，其次 文件键 + 文件内行号。
  const ordered = [...requests].sort((left, right) => compareBySourceOrder(left, right));
  const lastRequest = ordered.length ? ordered[ordered.length - 1] : null;
  // 末条缺累计值 -> 不得回退到较早值，直接判 unavailable。
  const lastTurnLevel =
    lastRequest && Number.isSafeInteger(lastRequest.turnOutputTokens) ? lastRequest.turnOutputTokens : null;
  const crossCheckAvailable = lastTurnLevel !== null && outputKnown;
  const crossCheckMatched = crossCheckAvailable && lastTurnLevel === requestOutputSum;
  // 三态：available+matched / available+conflict / unavailable。
  const crossCheckState = !crossCheckAvailable ? "unavailable" : crossCheckMatched ? "matched" : "conflict";

  const requestTimes = requests.map((request) => request.atMs);
  const itemStarts = items.map((item) => item.startedAtMs);
  const secondLike = requestTimes.filter(isSecondLike);
  const msLikeItems = itemStarts.filter((value) => Number.isSafeInteger(value) && value >= SECOND_LIKE_MAX);
  const unitSpikes = secondLike.length > 0 && msLikeItems.length > 0 ? 1 : 0;

  return {
    targetItems: items.length,
    partialItems,
    spanSum,
    maxSpan,
    overlapping,
    requestCount: requests.length,
    outputKnown,
    requestOutputSum,
    crossCheckAvailable,
    crossCheckMatched,
    crossCheckState,
    lastTurnLevel,
    conflictingRequest: requests.some((request) => request.conflict),
    modelAmbiguous: turn.modelKeys.size > 1,
    unitSuspicious: unitSpikes > 0,
    finalized: turn.terminals.length > 0,
    taskStarts: turn.taskStarts.length,
  };
}

/**
 * 同线程跨轮出现不同模型标签的**诊断**信号。
 * 本卡不做跨轮继承、不把它当冲突：`modelEvidence = turn_context` 只认精确 turn_id。
 */
function hasModelChange(facts) {
  return facts.modelKeysPerThread ? facts.modelKeysPerThread.size > 0 : false;
}

// ---------------------------------------------------------------------------
// 可选 SQLite 只读探测（报告投影覆盖，不预设接入）
// ---------------------------------------------------------------------------

function tableNames(db) {
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
      .all()
      .map((row) => String(row.name));
  } catch {
    return null;
  }
}

function columnNames(db, table) {
  try {
    return db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name));
  } catch {
    return null;
  }
}

export function probeOptionalSqlite(homePath, files = OPTIONAL_SQLITE_FILES, jsonlIndex = null) {
  const result = {
    present: false,
    openedCount: 0,
    readOnlyFailedCount: 0,
    itemTypeCase: "unknown",
    files: {},
  };
  for (const file of files) {
    const filePath = path.join(homePath, file);
    if (!existsSync(filePath)) continue;
    result.present = true;
    const facts = {
      present: true,
      opened: false,
      readOnly: false,
      tables: null,
      // M0.6 决议 D：表存在性由 `tables` 直接判定，用于 `threadItemsTableCount` /
      // `threadTurnsTableCount` 两个在册计数键（原先只能借 `turn_context` 等名间接表达）。
      tablePresent: {},
      turnStatuses: {},
      itemTypes: {},
      targetItems: 0,
      withSpan: 0,
      withoutSpan: 0,
      spanEquivalence: {
        jsonlComparable: 0,
        sqliteWithSameItem: 0,
        sqliteWithSpan: 0,
        /** JSONL 缺有效跨度、SQLite 有有效跨度 —— 真正的补缺量。 */
        gapFillCount: 0,
        /** 两边都有跨度但不一致的值冲突量。 */
        spanMismatchCount: 0,
      },
      projections: {},
    };
    let db = null;
    try {
      db = new DatabaseSync(filePath, { readOnly: true });
      facts.opened = true;
      facts.readOnly = true;
      result.openedCount += 1;
      const tables = tableNames(db);
      facts.tables = tables;
      for (const name of ["thread_items", "thread_turns"]) {
        facts.tablePresent[name] = Boolean(tables?.includes(name));
      }
      if (tables?.includes("thread_items")) {
        const columns = columnNames(db, "thread_items") || [];
        facts.projections.thread_items = columns;
        if (columns.includes("item_type")) {
          for (const row of db.prepare("SELECT item_type, COUNT(*) AS c FROM thread_items GROUP BY item_type").all()) {
            facts.itemTypes[String(row.item_type)] = Number(row.c) || 0;
          }
        }
        if (columns.includes("started_at_ms") && columns.includes("completed_at_ms")) {
          const inList = Object.keys(SQLITE_ITEM_TYPES)
            .map((name) => `'${name}'`)
            .join(",");
          const span = db
            .prepare(
              `SELECT COUNT(*) AS n,
                      SUM(CASE WHEN started_at_ms IS NOT NULL AND completed_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS with_span
               FROM thread_items WHERE item_type IN (${inList})`,
            )
            .get();
          facts.targetItems = Number(span?.n) || 0;
          facts.withSpan = Number(span?.with_span) || 0;
          facts.withoutSpan = facts.targetItems - facts.withSpan;

          // 「投影自身覆盖」与「全 JSONL 候选覆盖」的交集：只做计数，不落盘任何原始 ID。
          // 若 SQLite 能给 JSONL 已见身份补上缺失跨度，才是真正的潜在增益。
          if (jsonlIndex && typeof jsonlIndex.has === "function") {
            const rows = db
              .prepare(
                `SELECT thread_id, turn_id, item_id, started_at_ms, completed_at_ms
                 FROM thread_items WHERE item_type IN (${inList})`,
              )
              .all();
            for (const row of rows) {
              const key = keyOf([row.thread_id, row.turn_id, row.item_id]);
              const jsonlSpan = jsonlIndex.get(key);
              // 只有 JSONL **已见**该身份时，交集才有意义；未见的身份属投影自身覆盖，不构成补缺证据。
              if (jsonlSpan === undefined) continue;
              facts.spanEquivalence.jsonlComparable += 1;
              facts.spanEquivalence.sqliteWithSameItem += 1;
              const sqliteHasValidSpan =
                Number.isSafeInteger(row.started_at_ms) &&
                Number.isSafeInteger(row.completed_at_ms) &&
                row.completed_at_ms - row.started_at_ms > 0;
              if (sqliteHasValidSpan) facts.spanEquivalence.sqliteWithSpan += 1;
              // **真正的补缺量**：JSONL 该身份无有效跨度，而 SQLite 有有效跨度。
              // 这才是「接入 SQLite 能带来增益」的正面证据。
              if (!jsonlSpan.valid && sqliteHasValidSpan) facts.spanEquivalence.gapFillCount += 1;
              // 反向：两边都有跨度时的冲突量（§17.1 第 8 条要求保留 JSONL 证据并标冲突）。
              if (jsonlSpan.valid && sqliteHasValidSpan && !sameSpan(jsonlSpan, row)) {
                facts.spanEquivalence.spanMismatchCount += 1;
              }
            }
          }
        }
      }
      if (tables?.includes("thread_turns")) {
        facts.projections.thread_turns = columnNames(db, "thread_turns");
        const columns = facts.projections.thread_turns || [];
        if (columns.includes("status")) {
          const statuses = {};
          for (const row of db.prepare("SELECT status, COUNT(*) AS c FROM thread_turns GROUP BY status").all()) {
            statuses[String(row.status)] = Number(row.c) || 0;
          }
          facts.turnStatuses = statuses;
        }
        if (columns.includes("completed_at") && columns.includes("started_at") && columns.includes("duration_ms")) {
          const span = db
            .prepare(
              `SELECT COUNT(*) AS n,
                      SUM(CASE WHEN started_at IS NOT NULL AND completed_at IS NOT NULL THEN 1 ELSE 0 END) AS with_span,
                      SUM(CASE WHEN duration_ms IS NOT NULL AND duration_ms > 0 THEN 1 ELSE 0 END) AS with_duration
               FROM thread_turns`,
            )
            .get();
          facts.turnSpanCoverage = {
            turns: Number(span?.n) || 0,
            withSpan: Number(span?.with_span) || 0,
            withPositiveDuration: Number(span?.with_duration) || 0,
          };
        }
      }
      let observed = Object.keys(facts.itemTypes).filter((name) =>
        TARGET_ITEM_TYPES.some((target) => target.toLowerCase() === name.toLowerCase()),
      );
      if (observed.length === 0) observed = TARGET_ITEM_TYPES;
      const allCamelLike = observed.every((name) => /^[a-z]/.test(name));
      const allPascalLike = observed.every((name) => /^[A-Z]/.test(name));
      result.itemTypeCase =
        allCamelLike && !allPascalLike ? "camel_case" : allPascalLike && !allCamelLike ? "pascal_case" : "mixed";
    } catch {
      facts.readOnlyFailed = true;
      result.readOnlyFailedCount += 1;
    } finally {
      try {
        db?.close();
      } catch {
        // 关闭失败不改变证据；只读打开已经失败时更不应掩盖。
      }
    }
    result.files[file] = facts;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 指纹与产物
// ---------------------------------------------------------------------------

function fingerprintOf(homePath, entries) {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const entry of [...entries].sort((left, right) => (left.filePath < right.filePath ? -1 : 1))) {
    try {
      const info = statSync(entry.filePath);
      bytes += info.size;
      hash.update(`${entry.filePath}\t${info.size}\t${info.mtimeMs}\n`);
    } catch {
      hash.update(`${entry.filePath}\t!unreadable\n`);
    }
  }
  hash.update(`${homePath}\n`);
  return { fingerprint: hash.digest("hex"), fileCount: entries.length, bytes };
}

function createCounters() {
  return {
    turns: 0,
    requests: 0,
    targetItems: 0,
    partialItems: 0,
    multiRequestTurns: 0,
    eligible: 0,
    sampled: 0,
    dropped: 0,
    pending: 0,
    unplaced: 0,
    dedupedRequests: 0,
    dedupedItems: 0,
    agentMessageItems: 0,
    reasoningItems: 0,
    droppedByReason: {},
    flagCounts: {},
  };
}

function bumpFlag(counters, name) {
  counters.flagCounts[name] = (counters.flagCounts[name] || 0) + 1;
}

function droppedReasonFor(info, { hasOutput, outputZero }) {
  if (info.conflictingRequest) return "record_conflict";
  if (info.modelAmbiguous) return "model_ambiguous";
  if (!info.finalized) return "terminal_unverified";
  if (!hasOutput || outputZero) return "output_missing_zero_invalid";
  if (info.overlapping) return "overlapping_item_span";
  if (info.partialItems > 0) return "partial_item_span";
  if (!(info.spanSum > 0)) return "duration_missing_nonpositive_invalid";
  return "none";
}

function eraOf(turn, info) {
  const samples = [
    ...[...turn.requests.values()].map((request) => request.atMs),
    ...[...turn.items.values()].map((item) => item.startedAtMs),
  ].filter((value) => Number.isSafeInteger(value) && value > 0);
  let sample = samples.length ? Math.min(...samples) : null;
  if (sample !== null && isSecondLike(sample)) sample *= 1000;
  if (sample === null) return info.partialItems >= info.targetItems && info.targetItems > 0 ? "legacy" : "recent";
  return sample < ERA_CUTOFF_MS ? "legacy" : "recent";
}

function emptyLayers() {
  const bucket = () => ({ raw: 0, positive: 0, fullSpan: 0, finalized: 0 });
  return { raw: 0, positive: 0, fullSpan: 0, finalized: 0, byEra: { recent: bucket(), legacy: bucket() } };
}

function buildFlagCounts(counters) {
  const out = {};
  for (const name of FLAG_NAMES_ORDERED) out[name] = counters.flagCounts[name] || 0;
  return out;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function probe({ maxFiles = 4, maxRows = 200, full = false } = {}) {
  const startedAt = Date.now();
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const { found, selected } = listRollouts(home, { maxFiles, full });
  const fingerprintBefore = fingerprintOf(home, found);

  const facts = createProbeFacts();
  const allRecords = [];
  const rowsBudget = full ? Number.POSITIVE_INFINITY : Math.max(0, nonNegativeInt(maxRows) ?? 0);
  let rowsScanned = 0;
  // 「实际读取的范围」与「进入统计的范围」是两件事：
  // - filesRead / rowsRead：真正 readFileSync 读过的文件数与解析到的行数；
  // - filesEnteredStats / rowsScanned：在行预算内真正进入台账（因此进入统计）的数量。
  // 预算耗尽提前退出时前者会大于后者，**不得用选中数冒充实际读取数**。
  let filesRead = 0;
  let rowsRead = 0;
  let filesEnteredStats = 0;
  let archivedFilesScanned = 0;
  let truncated = false;

  for (const entry of selected) {
    const detail = readRolloutRecords(entry.filePath, createProbeFacts());
    mergeJsonlFacts(facts, detail.facts);
    filesRead += 1;
    rowsRead += detail.facts.lines;
    if (entry.archived) archivedFilesScanned += 1;
    const remaining = Number.isFinite(rowsBudget) ? Math.max(0, rowsBudget - rowsScanned) : Number.POSITIVE_INFINITY;
    const take = Math.min(detail.records.length, remaining);
    if (take > 0) filesEnteredStats += 1;
    allRecords.push(...detail.records.slice(0, take));
    rowsScanned += take;
    facts.archivedFilesScanned = archivedFilesScanned;
    if (Number.isFinite(rowsBudget) && take < detail.records.length) {
      truncated = true;
      break;
    }
    if (Number.isFinite(rowsBudget) && rowsScanned >= rowsBudget) {
      truncated = true;
      break;
    }
  }
  facts.filesRead = filesRead;
  facts.rowsRead = rowsRead;
  // filesEnteredStats 无外壳在册键可承载，仅作内存诊断（交 M0.6 裁决是否新增键）。
  facts.filesEnteredStats = filesEnteredStats;
  void facts.filesEnteredStats;

  const { turns, threads, orphanTerminals } = buildTurnLedger(allRecords, facts);
  const counters = createCounters();
  const layers = emptyLayers();
  const modelKeysPerThread = new Map();

  for (const turn of turns.values()) {
    const info = classifyTurn(turn);
    counters.turns += 1;
    counters.requests += info.requestCount;
    counters.targetItems += info.targetItems;
    counters.partialItems += info.partialItems;
    for (const item of turn.items.values()) {
      if (item.itemType === "agentMessage") counters.agentMessageItems += 1;
      if (item.itemType === "reasoning") counters.reasoningItems += 1;
    }
    // 同线程跨轮模型标签集合：只用于「是否发生模型切换」的诊断布尔。
    const threadModels = modelKeysPerThread.get(turn.threadId) || new Set();
    for (const modelKey of turn.modelKeys) threadModels.add(modelKey);
    modelKeysPerThread.set(turn.threadId, threadModels);

    // §17.1：去重请求 output 之和是分子主路径；末条 turn_token_usage.output_tokens 仅做交叉校验。
    if (info.crossCheckState === "conflict") {
      facts.conflicts.requestSumMismatch += 1;
    }
    facts.crossCheckStates[info.crossCheckState] = (facts.crossCheckStates[info.crossCheckState] || 0) + 1;

    const hasOutput = info.outputKnown && info.requestOutputSum > 0;
    const outputZero = info.outputKnown && info.requestOutputSum === 0;
    const outputMissing = !info.outputKnown;
    const fullSpan = info.targetItems > 0 && info.partialItems === 0;
    const finalized = info.finalized;

    layers.raw += 1;
    const eraBucket = layers.byEra[eraOf(turn, info)];
    eraBucket.raw += 1;
    if (hasOutput) {
      layers.positive += 1;
      eraBucket.positive += 1;
    }
    if (hasOutput && fullSpan) {
      layers.fullSpan += 1;
      eraBucket.fullSpan += 1;
    }
    if (hasOutput && fullSpan && finalized) {
      layers.finalized += 1;
      eraBucket.finalized += 1;
    }

    // flag 计数：可重叠，不相加当 dropped。
    if (outputZero) bumpFlag(counters, "OUTPUT_ZERO");
    if (outputMissing) bumpFlag(counters, "MISSING_OUTPUT");
    if (info.partialItems > 0) bumpFlag(counters, "PARTIAL_ITEM_SPAN");
    if (!finalized) bumpFlag(counters, "TERMINAL_UNVERIFIED");
    else bumpFlag(counters, "METHOD_ESTIMATE");
    if (info.overlapping) bumpFlag(counters, "OVERLAPPING_ITEM_SPAN");
    if (info.requestCount > 1) {
      counters.multiRequestTurns += 1;
      bumpFlag(counters, "MULTI_REQUEST_TURN");
    }
    if (info.maxSpan > LONG_WINDOW_MS) bumpFlag(counters, "LONG_WINDOW");
    if (info.spanSum > LONG_WINDOW_MS) bumpFlag(counters, "LONG_WINDOW");
    if (info.conflictingRequest) bumpFlag(counters, "RECORD_CONFLICT");
    if (info.modelAmbiguous) bumpFlag(counters, "MODEL_AMBIGUOUS");
    if (info.crossCheckState === "conflict") bumpFlag(counters, "RECORD_CONFLICT");
    if (info.unitSuspicious) bumpFlag(counters, "TIME_INVALID");
    if (info.spanSum <= 0) {
      if (fullSpan && info.targetItems > 0) bumpFlag(counters, "MISSING_DURATION");
      else if (info.targetItems === 0) bumpFlag(counters, "MISSING_DURATION");
      else bumpFlag(counters, "DURATION_NONPOSITIVE");
    }

    counters.eligible += 1;
    const pendingCandidate = info.requestCount === 0 && !finalized;
    if (pendingCandidate) {
      counters.pending += 1;
    } else if (
      hasOutput &&
      fullSpan &&
      finalized &&
      !info.overlapping &&
      !info.modelAmbiguous &&
      !info.conflictingRequest &&
      info.crossCheckState !== "conflict" &&
      !info.unitSuspicious &&
      info.spanSum > 0
    ) {
      counters.sampled += 1;
    } else {
      counters.dropped += 1;
      const reason = droppedReasonFor(info, { hasOutput, outputZero });
      counters.droppedByReason[reason] = (counters.droppedByReason[reason] || 0) + 1;
    }
  }

  counters.dedupedRequests = [...turns.values()].reduce((sum, turn) => sum + turn.requests.size, 0);
  counters.dedupedItems = [...turns.values()].reduce((sum, turn) => sum + turn.items.size, 0);
  counters.unplaced = orphanTerminals.length;

  // 跨 rollout / 重放重复：以「同线程多 rollout」的结构计数表达，不含原始 ID。
  const multiRollout = countMultiRolloutThreads(found, selected, threads);

  const sqlite = probeOptionalSqlite(home, OPTIONAL_SQLITE_FILES, buildJsonlItemIndex(turns));
  const fingerprintAfter = fingerprintOf(home, found);
  const modelMoreThanOne = [...modelKeysPerThread.values()].some((keys) => keys.size > 1);
  facts.modelKeysPerThread = new Set(modelMoreThanOne ? ["changed"] : []);

  const warnings = [];
  const warn = (code, count) => {
    if (count > 0) warnings.push({ code, count });
  };
  warn("MALFORMED_JSON", facts.malformedJson);
  warn("UNKEYABLE_RECORD", facts.conflicts.unkeyable);
  if (selected.length === 0) warn("NO_SOURCE_FILES", 1);
  if (sqlite.readOnlyFailedCount > 0) warn("READ_ONLY_OPEN_FAILED", sqlite.readOnlyFailedCount);
  if (facts.unitSecondLikeRows > 0) warn("UNSUPPORTED_SCHEMA", facts.unitSecondLikeRows);

  const scanned = buildScanned({
    found,
    rowsScanned,
    filesRead,
    rowsRead,
    truncated,
    facts,
    layers,
    counters,
    multiRollout,
    sqlite,
  });
  const fields = buildFields({ facts, layers, counters, sqlite, selected });
  // decisions.filesScanned 直接取 scanned.filesScanned，保证同一物理量在产物里只有一个值。
  const decisions = buildDecisions({
    found,
    selected,
    filesScanned: scanned.filesScanned,
    layers,
    counters,
    sqlite,
    facts,
    startedAt,
    multiRollout,
  });
  const coverage = projectionCoverage(sqlite);

  return {
    scanned: { ...scanned, ...projectionScannedCounts(coverage) },
    fields: { ...fields, ...projectionFieldFacts(coverage) },
    decisions,
    warnings,
    sourceFingerprintBefore: fingerprintBefore,
    sourceFingerprintAfter: fingerprintAfter,
    liveSourceChanged: fingerprintBefore.fingerprint !== fingerprintAfter.fingerprint,
  };
}

/**
 * 可选投影的「投影自身覆盖」计数：只使用外壳 `SCANNED_COUNT_KEYS` 在册的名字
 * （uniqueIdentities / duplicateIdentities / missingCompleted / supportedVersions / …）。
 */
function projectionScannedCounts(coverage) {
  return {
    uniqueIdentities: coverage.itemTotal,
    duplicateIdentities: Math.max(0, coverage.itemTotal - coverage.itemWithSpan),
    missingCompleted: Math.max(0, coverage.itemTotal - coverage.itemWithSpan),
    supportedVersions: coverage.statusCompleted,
    unknownVersions: coverage.statusFailed,
    // M0 返工（第 4 项）：本来源的 SQLite 投影**不解析 item_json 正文**，因此没有
    // "坏 JSON 行"这一统计项。原先写死 `0` 会被读成"实测没有坏 JSON"，**省略**。
    // badJsonRows: （已省略，见上）
  };
}

/**
 * 可选投影的「投影自身覆盖」布尔证据。
 * 键名与布尔类型都必须在外壳白名单内（FIELDS_BOOLEAN_KEYS）。
 *
 * `optionalSourceWorthwhile` 的判据是**补缺量 > 0**（JSONL 缺跨度而 SQLite 有有效跨度），
 * 与 `sourceVerdictOf` 保持一致；交集为 0 时它是 false，含义是「**未观察到**增益」，
 * 而非「已证明无增益」—— 该区别由 `verdictEvidenceStrength` 另行表达。
 */
function projectionFieldFacts(coverage) {
  return {
    databaseIdentityStable: true,
    projectionReady: coverage.itemTotal > 0,
    optionalSourceWorthwhile: coverage.gapFillCount > 0,
  };
}

/** 可选投影的覆盖证据（供 fields/decisions 使用，不含原始 ID）。 */
function projectionCoverage(sqlite) {
  let itemTotal = 0;
  let itemWithSpan = 0;
  let turnTotal = 0;
  let turnWithSpan = 0;
  let turnWithPositiveDuration = 0;
  let statusCompleted = 0;
  let statusFailed = 0;
  let comparable = 0;
  let comparableWithSqliteSpan = 0;
  let gapFillCount = 0;
  let spanMismatchCount = 0;
  for (const entry of Object.values(sqlite.files || {})) {
    itemTotal += entry.targetItems || 0;
    itemWithSpan += entry.withSpan || 0;
    const turnSpan = entry.turnSpanCoverage;
    if (turnSpan) {
      turnTotal += turnSpan.turns || 0;
      turnWithSpan += turnSpan.withSpan || 0;
      turnWithPositiveDuration += turnSpan.withPositiveDuration || 0;
    }
    statusCompleted += entry.turnStatuses?.completed || 0;
    statusFailed += (entry.turnStatuses?.failed || 0) + (entry.turnStatuses?.interrupted || 0);
    const equivalence = entry.spanEquivalence;
    if (equivalence) {
      comparable += equivalence.jsonlComparable || 0;
      comparableWithSqliteSpan += equivalence.sqliteWithSpan || 0;
      gapFillCount += equivalence.gapFillCount || 0;
      spanMismatchCount += equivalence.spanMismatchCount || 0;
    }
  }
  return {
    itemTotal,
    itemWithSpan,
    turnTotal,
    turnWithSpan,
    turnWithPositiveDuration,
    statusCompleted,
    statusFailed,
    comparable,
    comparableWithSqliteSpan,
    gapFillCount,
    spanMismatchCount,
  };
}

/**
 * 同线程多 rollout 的结构计数。
 * rollout 文件名里带线程 id，但**不落盘**——这里只做「同线程 -> rollout 数 > 1」的组计数。
 */
function countMultiRolloutThreads(found, selected, threads) {
  void found;
  const perThread = new Map();
  for (const entry of selected) {
    const base = path.basename(entry.filePath, ".jsonl");
    const threadId = base.slice(-36);
    if (!threadId) continue;
    perThread.set(threadId, (perThread.get(threadId) || 0) + 1);
  }
  let multi = 0;
  for (const count of perThread.values()) if (count > 1) multi += 1;
  return { filesPerThread: perThread.size, multiRolloutGroups: multi, threadsInLedger: threads.size };
}

/** JSONL 已观测到的目标 item 身份 -> 该身份的跨度是否有效（只在内存里用，不落盘）。 */
function buildJsonlItemIndex(turns) {
  const index = new Map();
  for (const turn of turns.values()) {
    // 身份的 item 分量是 items 这个 Map 的**键**（台账里不重复存 itemId 字段）。
    for (const [itemId, item] of turn.items) {
      const valid =
        Number.isSafeInteger(item.startedAtMs) &&
        Number.isSafeInteger(item.completedAtMs) &&
        item.completedAtMs - item.startedAtMs > 0;
      index.set(keyOf([turn.threadId, turn.turnId, itemId]), {
        valid,
        startedAtMs: item.startedAtMs,
        completedAtMs: item.completedAtMs,
      });
    }
  }
  return index;
}

/** SQLite 行与 JSONL 身份的跨度是否完全一致。 */
function sameSpan(jsonlSpan, row) {
  return jsonlSpan.startedAtMs === row.started_at_ms && jsonlSpan.completedAtMs === row.completed_at_ms;
}

function buildScanned({
  found,
  rowsScanned,
  filesRead,
  rowsRead,
  truncated,
  facts,
  layers,
  counters,
  multiRollout,
  sqlite,
}) {
  // 不变式：filesScanned <= filesDiscovered === scanned.files。
  // filesScanned = **实际读取过的文件数**（不是选中数）：预算耗尽提前退出时不得多报。
  const filesScanned = Math.min(filesRead, found.length);
  return {
    files: found.length,
    filesDiscovered: found.length,
    filesScanned,
    // 「实际读取的范围」与「进入统计的范围」分开表达（只用外壳在册键）：
    // - rowsRead：读到的行总数（含未进入台账的）；
    // - rowsScanned：真正进入台账的行数；
    // - unparsedLines：读到了但未进入台账的行数（rowsRead - rowsScanned）；
    // - skipped：发现了但未读取的文件数（filesDiscovered - filesScanned）。
    // 文件粒度的「读了多少个」由 filesScanned 本身表达（= 实际读取的文件数）。
    rowsRead: rowsRead,
    rowsScanned,
    rows: facts.lines,
    homes: 1,
    sessions: filesScanned,
    sessionsScanned: filesScanned,
    events: facts.lines,
    items: counters.dedupedItems,
    bounded: true,
    complete: filesScanned === found.length,
    truncated,
    hasMore: truncated,
    // 进入统计的范围：真正进入台账的行数已在 rowsScanned；
    // 「读到了但未进入台账」用 unparsedLines 表达（外壳在册键）。
    // 「发现但未读取」用 skipped 表达。两者都只记计数、不含路径。
    unparsedLines: Math.max(0, rowsRead - rowsScanned),
    skipped: Math.max(0, found.length - filesScanned),
    // §17.5 分层
    eligible: counters.eligible,
    positiveOutput: layers.positive,
    timedPositiveOutput: layers.fullSpan,
    completeTimedPositiveOutput: layers.finalized,
    sampled: counters.sampled,
    dropped: counters.dropped,
    pending: counters.pending,
    unplaced: counters.unplaced,
    // M0.5 分层与决议
    dedupedRequests: counters.dedupedRequests,
    dedupedItems: counters.dedupedItems,
    collapsedRecords: countCollapsed(facts),
    conflictingRecords: facts.conflicts.recordConflict,
    partialItems: counters.partialItems,
    legacyRecords: layers.byEra.legacy.raw,
    recentRecords: layers.byEra.recent.raw,
    // 精确类型计数
    turnContextCount: facts.turnContextWithTurnId,
    tokenUsageRecordCount: facts.tokenUsageRecords,
    itemCompletedCount: facts.itemCompletedRows,
    taskCompleteCount: facts.taskCompleteRows,
    otherEventCount: otherEventCount(facts),
    // M0.6 决议 D：原先只能并入 otherEventCount 的真实结构名，现在逐类上报。
    // 顶层类型 `response_item` / `world_state`；
    responseItemCount: facts.topLevelCounts.response_item || 0,
    worldStateCount: facts.topLevelCounts.world_state || 0,
    // `event_msg.payload.type` 的其余在册类型。
    tokenCountEventCount: facts.eventPayloadCounts.token_count || 0,
    taskStartedCount: facts.eventPayloadCounts.task_started || 0,
    turnAbortedCount: facts.eventPayloadCounts.turn_aborted || 0,
    customToolCallCount: facts.eventPayloadCounts.custom_tool_call || 0,
    // SQLite 侧的表存在性（原先只能借在册名间接表达）与 `thread_turns.status` 取值枚举。
    threadItemsTableCount: sqliteTableCount(sqlite, "thread_items"),
    threadTurnsTableCount: sqliteTableCount(sqlite, "thread_turns"),
    threadTurnsCompletedCount: sqliteStatusCount(sqlite, "completed"),
    threadTurnsFailedCount: sqliteStatusCount(sqlite, "failed"),
    threadTurnsInterruptedCount: sqliteStatusCount(sqlite, "interrupted"),
    threadTurnsInProgressCount: sqliteStatusCount(sqlite, "inProgress"),
    sessionHeaderCount: facts.topLevelCounts.session_meta || 0,
    agentMessageItemCount: counters.agentMessageItems,
    reasoningItemCount: counters.reasoningItems,
    targetItemCount: counters.targetItems,
    requestCount: counters.requests,
    crossRolloutDuplicateCount: multiRollout.multiRolloutGroups,
    requestSumMismatchCount: countCrossCheckMismatch(facts),
    effortConflictCount: facts.conflicts.modelAmbiguous,
    terminalMissingCount: facts.taskCompleteRows > 0 ? 0 : counters.turns,
    secondUnitCount: facts.unitSecondLikeRows,
    milliSecondUnitCount: facts.unitMsLikeRows,
    missingItemSpanCount: facts.itemMissingSpan,
    // M0 返工（第 4 项）：本来源**未统计**"溢出跨度"与"缺时间戳的行"（前者无判据，
    // 后者由 `facts.itemMissingSpan` 另行表达）。原先写死 `0` 属"未统计"，**省略**。
    // overflowingSpanCount / missingTimestampCount: （已省略，见上）
    malformedJsonCount: facts.malformedJson,
    identityDuplicateGroupCount: multiRollout.multiRolloutGroups,
    consistentDuplicateCount: countConsistentDuplicates(facts),
    // task_complete 的秒/毫秒单位证据（§17.1 第 222 行要求的单位核对）
    timeUnitMatchedCount: facts.taskCompleteSpanMatchesDuration,
    timeUnitCheckedCount: facts.taskCompleteWithDurationMs,
    // 累计输出交叉校验的三态（M0.6 决议 A：**专用键**，不再借用 requestHeaderCount /
    // identityDuplicateCount —— 那两个键回到它们的字面含义，见下方注释）。
    // 每个参与校验的轮恰好落入且只落入一个状态：
    // - crossCheckMatchedCount：末条累计 == 去重请求之和；
    // - crossCheckConflictCount：可校验但两者不等（同时置 RECORD_CONFLICT）；
    // - crossCheckUnavailableCount：确实不可校验（末条累计缺失，或存在请求输出未知）；
    // - crossCheckAvailableCount：可校验轮数 = matched + conflict（= 三态的互补集）。
    // 恒等式：crossCheckAvailableCount + crossCheckUnavailableCount === eligible，
    // 且 crossCheckAvailableCount === crossCheckMatchedCount + crossCheckConflictCount。
    crossCheckMatchedCount: facts.crossCheckStates.matched || 0,
    crossCheckConflictCount: facts.crossCheckStates.conflict || 0,
    crossCheckUnavailableCount: facts.crossCheckStates.unavailable || 0,
    crossCheckAvailableCount: (facts.crossCheckStates.matched || 0) + (facts.crossCheckStates.conflict || 0),
    // requestHeaderCount / identityDuplicateCount 归来源各自字面含义；本来源不再借用：
    //   - requestHeaderCount：请求头（request/header）帧数 → **0 是结构事实**（Codex JSONL 无此帧），
    //     属于「已实测为 0」，保留输出；
    //   - identityDuplicateCount：身份重复组内被折叠的**额外行数** → **0 是结构事实**
    //     （本来源重复按跨度折叠而非按行折叠），保留输出。
    requestHeaderCount: 0,
    identityDuplicateCount: 0,
    jsonlCandidateTurnCount: counters.turns,
    sqliteCandidateCount: sqliteCandidateCount(sqlite),
    statusCompletedCount: layers.finalized,
    terminalUnverifiedCount: counters.flagCounts.TERMINAL_UNVERIFIED || 0,
    outputZeroCount: counters.flagCounts.OUTPUT_ZERO || 0,
    outputMissingCount: counters.flagCounts.MISSING_OUTPUT || 0,
    // M0 返工（第 4 项）：本来源**没有**事件级版本分类，`0` 只是"没统计"，不是"实测为 0"。
    // 定值上报会被机器消费者当成真值，故**省略该键**（读不到 = 不知道）。
    // unsupportedVersionCount: （已省略，见上）
    badJsonCount: facts.malformedJson,
    // M0 返工（第 4 项）：Codex 的**轮级终态只看 `task_complete`**，从不按 error/cancelled/retry
    // 分类（`turn_aborted` 仅作事件计数，不参与终态判定）。这三个键原先写死 `0`，
    // 属"未统计"却与"实测为 0"同形 —— 按用户裁定**省略**，不再冒充真值。
    // errorRows / cancelledRows / retryRows: （已省略，见上）
    flagCount: Object.values(counters.flagCounts).reduce((sum, value) => sum + value, 0),
    flagMaskTotal: Object.keys(counters.flagCounts).length,
    rawCount: layers.raw,
    positiveCount: layers.positive,
    afterFilterCount: layers.finalized,
    positiveDurationCount: layers.fullSpan,
    multipleStartCount: counters.multiRequestTurns,
  };
}

/**
 * M0.6 决议 D：可选 SQLite 里某张表是否**已只读打开并确认存在**（0/1）。
 * 表存在性是结构事实，不含任何行内容或原始 ID。
 */
function sqliteTableCount(sqlite, table) {
  return Object.values(sqlite?.files || {}).some((entry) => entry?.tablePresent?.[table]) ? 1 : 0;
}

/**
 * M0.6 决议 D：`thread_turns.status` 某个取值的行数合计。
 * 取值枚举来自实测（completed / failed / interrupted / inProgress），只报计数、不报行。
 */
function sqliteStatusCount(sqlite, status) {
  let total = 0;
  for (const entry of Object.values(sqlite?.files || {})) {
    total += entry?.turnStatuses?.[status] || 0;
  }
  return total;
}

function countCollapsed(facts) {
  // 同时刻同一 item 的重复行已在台账里折叠；这里报「非空跨度冲突」的反面证据。
  return Math.max(0, facts.itemCompletedRows - facts.itemWithId);
}

function countConsistentDuplicates(facts) {
  // 缺 id 的 item_completed 行无法形成稳定身份：累计 UNKEYABLE，不进入可去重 eligible。
  return Math.max(0, facts.itemCompletedRows - facts.itemWithId);
}

function countCrossCheckMismatch(facts) {
  // JSONL 同轮 request output 之和 vs 末条 turn_token_usage 的交叉校验差异，
  // 在台账里逐轮判定后累加到 facts.conflicts.requestSumMismatch。此处只做只读透传。
  return facts.conflicts.requestSumMismatch;
}

function sqliteCandidateCount(sqlite) {
  let total = 0;
  for (const entry of Object.values(sqlite.files || {})) total += entry.targetItems || 0;
  return total;
}

function otherEventCount(facts) {
  const total = Object.values(facts.eventPayloadCounts).reduce((sum, value) => sum + value, 0);
  const named =
    (facts.eventPayloadCounts.item_completed || 0) +
    (facts.eventPayloadCounts.task_complete || 0) +
    (facts.eventPayloadCounts.token_count || 0);
  return Math.max(0, total - named);
}

function unitKindOf(facts) {
  const seconds = facts.unitSecondLikeRows;
  const millis = facts.unitMsLikeRows;
  if (seconds > 0 && millis > 0) return "s_or_ms";
  if (seconds > 0) return "s";
  if (millis > 0) return "ms";
  return "unknown";
}

/**
 * 来源决议（三选一）。
 *
 * 判据是「**整请求输出能否对应到目标 item 时窗**」的可证明性，用不含原始 ID 的结构计数表达：
 *
 * - JSONL 自身已给出请求 (thread,turn,response) / 轮 (thread,turn) / item (thread,turn,item)
 *   身份、精确 turn_context 的模型证据、task_complete 终态，以及完整的目标 item 正跨度。
 * - 可选 SQLite 投影（thread_items / thread_turns）是否有增益，只看一个量：
 *   `gapFillCount` = **JSONL 该身份无有效跨度、而 SQLite 有有效跨度**的身份计数。
 *   这是「补缺量」的直接统计，不是「两者相等」这类间接条件。
 *
 * **表述纪律（必须遵守）**：本机实测的身份交集为 0，即 `jsonlComparable === 0`。
 * 此时结论只能是「**未观察到增益**」（→ `JSONL_ONLY`），
 * **不是**「已证明 SQLite 无增益」——交集为 0 属**证据不足**，不是**反证**。
 * 因此这里绝不因 `jsonlComparable === 0` 就宣称增益已被排除：
 * 该分支返回的 `JSONL_ONLY` 含义是「在本次观测范围内没有发现增益」。
 */
export function sourceVerdictOf(sqlite, selected) {
  if (selected.length === 0) return "UNSUPPORTED";
  if (!sqlite.present || sqlite.readOnlyFailedCount > 0) return "JSONL_ONLY";
  // 正面判据：确实存在「JSONL 缺跨度而 SQLite 有有效跨度」的补缺量。
  const gapFillTotal = Object.values(sqlite.files).reduce(
    (sum, entry) => sum + (entry.spanEquivalence?.gapFillCount || 0),
    0,
  );
  return gapFillTotal > 0 ? "OPTIONAL_SQLITE_WORTHWHILE" : "JSONL_ONLY";
}

/**
 * 决议的证据强度：把「未观察到增益」与「已排除增益」明确区分开。
 * 交集为 0（没有任何可比身份）时只能给 `not_observed_insufficient_evidence`。
 */
export function verdictEvidenceStrength(sqlite, selected) {
  if (selected.length === 0) return "source_absent";
  if (!sqlite.present || sqlite.readOnlyFailedCount > 0) return "optional_source_absent";
  const comparable = Object.values(sqlite.files).reduce(
    (sum, entry) => sum + (entry.spanEquivalence?.jsonlComparable || 0),
    0,
  );
  if (comparable === 0) return "not_observed_insufficient_evidence";
  return "observed_over_comparable_identities";
}

/** 可选源在本数据上的角色（外壳在册枚举：verification / gap_fill / none）。 */
export function optionalRoleOf(sqlite, selected) {
  if (selected.length === 0 || !sqlite.present) return "none";
  return sourceVerdictOf(sqlite, selected) === "OPTIONAL_SQLITE_WORTHWHILE" ? "gap_fill" : "none";
}

function buildFields({ facts, layers, counters, sqlite, selected, rolloutsPerThread }) {
  const columns = {};
  for (const name of JSONL_COLUMN_NAMES) columns[name] = jsonlColumnState(name, facts);
  for (const name of SQLITE_COLUMN_NAMES) columns[name] = sqliteColumnState(name, sqlite);
  const values = Object.values(columns);
  const present = values.filter((value) => value === "present").length;
  const absent = values.filter((value) => value === "absent").length;
  const unknown = values.filter((value) => value === "unknown").length;

  const columnStates = { present, absent, unknown, total: values.length };
  const base = {
    columns,
    requiredColumns: { ...columns },
    columnStates,
    timingKind: "item_span_estimate",
    tokenScope: "reported_output_includes_reasoning",
    windowKind: "turn",
    statusKind: layers.finalized > 0 ? "completed" : "unverified",
    agentKind: "unknown",
    modelEvidence: "turn_context",
    timingSource: "estimated",
    durationBasis: "item_span_sum",
    unitKind: unitKindOf(facts),
    schemaKind: "codex-jsonl",
    backend: "jsonl",
    sourceVerdict: sourceVerdictOf(sqlite, selected),
    // 身份/映射结论
    agentKindMapping: "unknown_default",
    agentNameEvidence: "session_meta",
    agentRoleProvenance: "explicit_flag",
    modelEvidenceDecision: "turn_context",
    // JSONL 顶层 turn_context 不带 provider 字段；provider 只出现在 session_meta。
    // M0.6 决议 D：白名单已收录 `session_meta` 取值，因此这里如实上报**来源位置**，
    // 而不是含糊的 unknown —— 同时仍然**不套用当前配置回填**历史 provider 值。
    providerMapping: "session_meta",
    providerScope: "unknown",
    modelScope: "turn_context",
    effortScope: "turn_context",
    itemTypeCase: "pascal_case",
    itemContentCase: "none",
    identityScheme: "request_item",
    terminalFieldKind: "task_complete",
    terminalEvidenceDecision: layers.finalized > 0 ? "proven_completed" : "unverified",
    itemAlignmentDecision: "cannot_prove",
    // 可选源的**角色**：确有补缺量 -> gap_fill；只在同一批身份上做校验 -> verification；
    // 无增益（含「交集为 0、未观察到增益」）-> none。与 sourceVerdict 同源判定。
    optionalSqliteRole: optionalRoleOf(sqlite, selected),
    // M0.6 决议 H：决议的**证据强度**现在有专用在册键，机器消费者可以区分
    // 「未观察到增益（证据不足）」与「已在可比身份上观察到（{补缺/无补缺}）」。
    // 取值域：source_absent / optional_source_absent / not_observed_insufficient_evidence /
    //         observed_over_comparable_identities / unknown / none。
    verdictEvidenceStrength: verdictEvidenceStrength(sqlite, selected),
    reasoningRelation: "included_in_output",
    durationProvenance: "timestamp_fallback",
    timeUnit: unitKindOf(facts) === "s" ? "seconds" : "milliseconds",
    readOnlyStrategy: "database_sync_readonly",
    coverageState: selected.length === 0 ? "degraded" : "ready",
    diagnosticReason: "none",
    modelFamily: "unknown",
    effortLevel: "unknown",
    databaseIdentityKind: "canonical_path",
    // 只读纪律：本卡必须全为 false
    itemContentAccessed: false,
    lastAgentMessageAccessed: false,
    ttftAccessed: false,
    ttftRead: false,
    contentAccessed: false,
    streamAccessed: false,
    stepEndAccessed: false,
    bodySentinelFound: false,
    // 结构证据
    archivedSessionsPresent: facts.archivedSessionsPresent || facts.archivedFilesScanned > 0,
    statePresent: sqlite.present,
    historyPresent: sqlite.present,
    projectionReady: sqlite.openedCount > 0,
    readOnly: true,
    walPresent: false,
    // 恒等式/一致性
    identityUnique: facts.conflicts.recordConflict === 0,
    duplicateCollapsed: true,
    conflictDetected: facts.conflicts.recordConflict > 0 || facts.conflicts.modelAmbiguous > 0,
    terminalFieldPresent: facts.taskCompleteRows > 0,
    completedExplicit: facts.taskCompleteWithSpan > 0,
    outputExplicit: facts.withUsage > 0,
    reasoningSeparate: false,
    agentRoleProven: facts.sessionMeta.sourceSubagentFlag || facts.sessionMeta.threadSourcePresent,
    mainProven: false,
    unitAmbiguous: unitKindOf(facts) === "s_or_ms",
    timestampFallbackUsed: true,
    explicitDurationUsed: false,
    limited: true,
    sampled: counters.sampled > 0,
    allColumnsPresent: absent === 0,
    reasoningRelationKnown: true,
    stepResetObserved: false,
    modelChangedMidSession: hasModelChange(facts),
    // 计数型补充
    turnCount: counters.turns,
    requestCount: counters.requests,
    itemCount: counters.targetItems,
    timedItemCount: layers.fullSpan,
    columnCount: values.length,
    presentColumnCount: present,
    absentColumnCount: absent,
    unknownColumnCount: unknown,
    distinctSessions: selected.length,
    distinctHomes: 1,
    flagCount: Object.keys(counters.flagCounts).length,
  };
  void rolloutsPerThread;
  void base.requiredColumns;
  return base;
}

function jsonlColumnState(name, facts) {
  switch (name) {
    case "thread_id":
      return facts.withThreadId > 0 || (facts.topLevelCounts.event_msg || 0) > 0 ? "present" : "absent";
    case "turn_id":
      return facts.turnContextWithTurnId > 0 || facts.withTurnId > 0 ? "present" : "absent";
    case "item_type":
      return facts.itemCompletedRows > 0 ? "present" : "absent";
    case "started_at_ms":
    case "completed_at_ms":
      return facts.itemCompletedRows > 0 ? "present" : "absent";
    case "response_id":
      return facts.withResponseId > 0 ? "present" : "absent";
    case "turn_context":
      return (facts.topLevelCounts.turn_context || 0) > 0 ? "present" : "absent";
    case "event_msg":
      return (facts.topLevelCounts.event_msg || 0) > 0 ? "present" : "absent";
    case "item_completed":
      return facts.itemCompletedRows > 0 ? "present" : "absent";
    case "task_complete":
      return facts.taskCompleteRows > 0 ? "present" : "absent";
    case "turn_token_usage":
      return facts.withTurnUsage > 0 ? "present" : "absent";
    case "thread_source":
      return facts.sessionMeta.threadSourcePresent ? "present" : "absent";
    case "source_kind":
      return facts.sessionMeta.sourcePresent ? "present" : "absent";
    case "sessions_meta":
      return (facts.topLevelCounts.session_meta || 0) > 0 ? "present" : "unknown";
    default:
      return "unknown";
  }
}

function sqliteColumnState(name, sqlite) {
  if (!sqlite.present) return "absent";
  const entries = Object.values(sqlite.files);
  if (entries.length === 0) return "unknown";
  const hasThreadItems = entries.some((entry) => (entry.tables || []).includes("thread_items"));
  const hasThreadTurns = entries.some((entry) => (entry.tables || []).includes("thread_turns"));
  if (["item_type", "item_id", "thread_id", "turn_id", "started_at_ms", "completed_at_ms"].includes(name)) {
    return hasThreadItems ? "present" : "unknown";
  }
  if (name === "item_completed") return hasThreadItems ? "present" : "unknown";
  if (name === "turn_context") {
    // 轮级 status/started_at/completed_at 落在 thread_turns（本卡的替代终态证据）。
    return hasThreadTurns ? "present" : hasThreadItems ? "unknown" : "absent";
  }
  if (name === "task_complete") {
    return entries.some((entry) => Object.keys(entry.turnStatuses || {}).length > 0) ? "present" : "unknown";
  }
  return "unknown";
}

function buildDecisions({ found, selected, filesScanned, layers, counters, sqlite, facts, startedAt, multiRollout }) {
  const decisions = {
    filesDiscovered: found.length,
    // 与 scanned.filesScanned **同源同值**：实际读取过的文件数（不是选中数）。
    // 同一物理量在产物里只允许一个值，见 handoffs/M0.5-返工2.md 的一致性自查。
    filesScanned,
    // 语义不同、**故意不改成实际值**：表达「本次是否请求了全量扫描」这一意图，
    // 与「实际扫描了多少个文件」是两件事（预算耗尽时 requested=true 而 scanned<discovered）。
    fullScanRequested: selected.length === found.length,
    schemaKind: "codex-jsonl",
    backend: "jsonl",
    sourceVerdict: sourceVerdictOf(sqlite, selected),
    coverageState: selected.length === 0 ? "degraded" : "ready",
    timingKind: "item_span_estimate",
    tokenScope: "reported_output_includes_reasoning",
    readOnly: true,
    readOnlyEnforced: true,
    identityUnique: facts.conflicts.recordConflict === 0,
    identitySchemeStable: true,
    optionalSourcePresent: sqlite.present,
    optionalSourceUsed: false,
    projectionReady: sqlite.openedCount > 0,
    indexPresent: false,
    walPresent: false,
    schemaDetected: true,
    homeCount: 1,
    sourceCount: SESSION_DIRS.length,
    openedDatabaseCount: sqlite.openedCount,
    checkedRowCount: facts.lines,
    durationMs: Math.max(0, Date.now() - startedAt),
    identityDuplicateGroupCount: multiRollout.multiRolloutGroups,
    warningCounts: {},
    flagCounts: buildFlagCounts(counters),
  };
  void layers;
  return decisions;
}
