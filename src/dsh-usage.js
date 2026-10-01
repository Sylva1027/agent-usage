// DSH（DeepSeek Harness）用量数据源：读取 ~/.dsh/sessions 下的会话日志。
//
// 日志格式要点（v4，实测）：
// - 文件为 session.v4.jsonl.zstd，是**多帧拼接**的 zstd（流式追加），不是单一帧。
//   zstdDecompressSync 整文件解压只会解出第一帧且不报错，因此必须逐帧解压。
// - 第一帧是会话头 { type: "session", id, cwd, delegationDepth, createdAt, ... }。
// - 用量只出现在 assistant/message 记录的 data.usage 上，且是 per-request 增量。
// - 模型来自 request/header 的 data.header.config.model（逐请求记录）。
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { LONG_CONTEXT_INPUT_THRESHOLD, pricingVersionForTimestamp } from "./pricing.js";
import { createRepositoryResolver } from "./repository-identity.js";
import { USAGE_DETAIL_MASK, emptyUsage, isZeroUsage, validateUsageDetails } from "../public/usage-fields.js";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
// 只认识已实测的 v4 格式；更高版本应在解析前显式拒绝，而不是按 v4 硬解。
export const DSH_SESSION_FORMAT_VERSION = 4;
const SESSION_FILE_PATTERN = /^session\.v(\d+)\.jsonl\.zstd$/;
const SESSIONS_DIR = "sessions";
const SESSION_TITLE_LIMIT = 120;
// input/cached/output 三项在 v4 中恒定存在；reasoning 不由 DSH 提供。
const DSH_KNOWN_DETAIL_MASK = USAGE_DETAIL_MASK.input | USAGE_DETAIL_MASK.cached | USAGE_DETAIL_MASK.output;

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInt(value) {
  const number = numeric(value);
  return number === null || number < 0 ? 0 : Math.floor(number);
}

export async function dshSessionsDirectory(homePath) {
  const directory = path.join(homePath, SESSIONS_DIR);
  return (await exists(directory)) ? directory : "";
}

/**
 * 判定一个目录是不是 DSH home。
 * 不能只看「有没有 sessions 目录」——Codex home 也有 sessions，
 * 而 Codex 的残留临时目录（sessions/.tmp）里同样有 jsonl 文件。
 * 因此必须确认存在 DSH 命名的会话日志：sessions/<cwd-slug>/<sessionId>/session.v<N>.jsonl.zstd。
 */
export async function dshHomeLooksUsable(homePath) {
  const root = await dshSessionsDirectory(homePath);
  if (!root) {
    return false;
  }
  let slugs;
  try {
    slugs = await readdir(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const slug of slugs) {
    if (!slug.isDirectory() || slug.name === ".tmp" || slug.name === "node_modules") {
      continue;
    }
    let sessions;
    try {
      sessions = await readdir(path.join(root, slug.name), { withFileTypes: true });
    } catch {
      continue;
    }
    // 只要有任意一个会话目录里存在 v<N> 日志即可确认这是 DSH home。
    for (const session of sessions) {
      if (!session.isDirectory()) {
        continue;
      }
      let files;
      try {
        files = await readdir(path.join(root, slug.name, session.name));
      } catch {
        continue;
      }
      if (files.some((name) => SESSION_FILE_PATTERN.test(name))) {
        return true;
      }
    }
  }
  return false;
}

/** 递归收集会话日志；深度受限以避开 tsx 等附属目录。 */
export async function dshSessionFiles(homePath) {
  const root = await dshSessionsDirectory(homePath);
  if (!root) {
    return [];
  }
  const files = [];
  async function walk(directory, depth) {
    if (depth > 3) {
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".tmp" || entry.name === "node_modules") {
          continue;
        }
        await walk(fullPath, depth + 1);
      } else if (entry.isFile() && SESSION_FILE_PATTERN.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }
  await walk(root, 0);
  return files.sort();
}

export async function dshSourceStat(filePath) {
  const info = await stat(filePath);
  return { size: info.size, mtimeMs: info.mtimeMs };
}

/**
 * 逐帧解压一个会话日志并产出每一行 JSON。
 * 用「魔数位置」作为帧边界：实测样本中每个魔数位置都是真实帧起点，
 * 但实现仍按「能否解压」容错，坏帧只记警告、不中断整个文件。
 * @param {string} filePath
 * @param {{ onWarning?: (warning: string) => void }} [options]
 */
export async function readDshSessionRows(filePath, { onWarning } = {}) {
  const buffer = await readFile(filePath);
  const offsets = [];
  for (let at = buffer.indexOf(ZSTD_MAGIC); at !== -1; at = buffer.indexOf(ZSTD_MAGIC, at + ZSTD_MAGIC.length)) {
    offsets.push(at);
  }

  const chunks = [];
  let failedFrames = 0;
  offsets.forEach((start, index) => {
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length;
    let decompressed = null;
    try {
      decompressed = zstdDecompressSync(buffer.subarray(start, end));
    } catch {
      decompressed = null;
    }
    // 注意：zstdDecompressSync 对畸形帧可能抛错，也可能静默返回空 buffer，
    // 所以「解出空内容」也必须算作坏帧，否则损坏帧会被当成空记录悄悄放过。
    // DSH 从不写空帧（每帧至少一条 JSON），因此这个判据是安全的。
    if (!decompressed?.length) {
      failedFrames += 1;
      return;
    }
    chunks.push(decompressed.toString("utf8"));
  });

  if (!chunks.length) {
    throw new Error(`无法解压 DSH 会话日志（${offsets.length} 个候选帧全部失败）`);
  }
  if (failedFrames) {
    onWarning?.(`DSH 会话日志 ${filePath} 有 ${failedFrames} 个损坏帧或空帧被跳过`);
  }

  const rows = [];
  for (const line of chunks.join("").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      rows.push(JSON.parse(line));
    } catch {
      // 写入中断可能留下半行，跳过即可。
    }
  }
  return rows;
}

/** 解析会话头；缺失时返回 null（调用方据此跳过该文件）。 */
export function dshSessionHeader(rows = []) {
  const row = rows.find((entry) => entry?.type === "session");
  if (!row) {
    return null;
  }
  const version = numeric(row.version);
  return {
    id: String(row.id || "").trim(),
    version,
    cwd: String(row.cwd || "").trim(),
    delegationDepth: nonNegativeInt(row.delegationDepth),
    createdAtMs: numeric(row.createdAt),
    agentPreset: String(row.agentPreset || "").trim(),
  };
}

/**
 * 把 DSH 的并列表述重构成看板口径。
 *
 * DSH 的 data.usage 是四个**并列**计数：inputTokens 是未命中输入，
 * 与 cacheReadTokens 相加才等于总输入。而看板要求 cached 是 input 的**子集**
 * （见 public/usage-fields.js 与 src/pricing.js 的 cached <= input 不变量），
 * 否则缓存明细会被撤销、计价退化为「最低费率估算」、命中率还会超过 100%。
 * 所以这里把两者相加得到超集 input，cacheReadTokens 作为其中命中部分。
 * @param {any} raw data.usage
 */
export function dshUsageFromRaw(raw) {
  const inputTokens = nonNegativeInt(raw?.inputTokens);
  const cacheReadTokens = nonNegativeInt(raw?.cacheReadTokens);
  const cacheWriteTokens = nonNegativeInt(raw?.cacheWriteTokens);
  const outputTokens = nonNegativeInt(raw?.outputTokens);
  const input = inputTokens + cacheReadTokens + cacheWriteTokens;
  const total = numeric(raw?.totalTokens);
  const usage = {
    ...emptyUsage(),
    total: total === null ? input + outputTokens : Math.floor(total),
    input,
    cached: cacheReadTokens,
    output: outputTokens,
    reasoning: 0,
  };
  const detailMask = DSH_KNOWN_DETAIL_MASK | USAGE_DETAIL_MASK.cacheWrite;
  return { usage, detailMask, cacheWriteTokens, cacheWriteKnown: true, requestInputTokens: input };
}

/**
 * 单遍扫描一个会话日志，产出标准化用量事件。
 * 只读用量与元数据字段；message/content/stream/tool 参数与结果一律不读。
 * @param {string} filePath
 * @param {{ id: string, label: string, path: string }} source
 * @param {(event: any) => Promise<void> | void} onEvent
 */
export async function streamDshSessionEvents(filePath, source, onEvent, options = {}) {
  const resolveRepository = options.repositoryResolver || createRepositoryResolver();
  const rows = await readDshSessionRows(filePath, options);
  const header = dshSessionHeader(rows);
  if (!header) {
    return;
  }
  if (header.version !== null && header.version !== DSH_SESSION_FORMAT_VERSION) {
    options.onWarning?.(
      `DSH 会话日志 ${filePath} 的格式版本为 v${header.version}，本版本只支持 v${DSH_SESSION_FORMAT_VERSION}，已跳过`,
    );
    return;
  }

  const sessionId = header.id || path.basename(path.dirname(filePath));
  const channel = header.delegationDepth > 0 ? "DSH Subagent" : "DSH";
  const cwd = header.cwd;
  const repository = await resolveRepository(cwd);

  let model = "";
  let modelProvider = "";
  let conversationName = "";

  for (const row of rows) {
    const type = String(row?.type || "");
    const data = row?.data;

    if (type === "request/header" || type === "request/context") {
      const config = data?.header?.config;
      model = String(config?.model || data?.model || model || "").trim();
      modelProvider = String(config?.provider || data?.provider || modelProvider || "").trim();
      continue;
    }
    if (type === "session/title") {
      const title = String(data?.title || "").trim();
      if (title) {
        conversationName = title.length > SESSION_TITLE_LIMIT ? `${title.slice(0, SESSION_TITLE_LIMIT)}…` : title;
      }
      continue;
    }
    if (type !== "assistant/message" || !data?.usage) {
      continue;
    }

    const timestampMs = numeric(row.time);
    if (timestampMs === null) {
      continue;
    }

    const mapped = dshUsageFromRaw(data.usage);
    if (isZeroUsage(mapped.usage)) {
      continue;
    }
    const timestamp = new Date(timestampMs).toISOString();
    const detailValidation = validateUsageDetails(mapped.usage, mapped.detailMask);
    await onEvent({
      eventId: `${sessionId}:${row.seq ?? timestampMs}`,
      timestampMs,
      timestamp,
      sessionId,
      homeId: source.id,
      homeLabel: source.label,
      homePath: source.path,
      channel,
      source: "dsh",
      project: cwd,
      repositoryKey: repository.key,
      repositoryPath: repository.path,
      repositoryKind: repository.kind,
      conversationName,
      model: model || "Unknown model",
      modelProvider,
      usage: mapped.usage,
      detailMask: detailValidation.detailMask,
      reconciliationGap: detailValidation.reconciliationGap,
      cacheWriteTokens: mapped.cacheWriteTokens,
      cacheWriteKnown: mapped.cacheWriteKnown,
      requestInputTokens: mapped.requestInputTokens,
      contextLevel:
        mapped.requestInputTokens > LONG_CONTEXT_INPUT_THRESHOLD
          ? "long"
          : mapped.requestInputTokens > 0
            ? "short"
            : "unknown",
      serviceTier: "unknown",
      priceVersion: pricingVersionForTimestamp(timestamp),
      turn: nonNegativeInt(data.turn),
      step: nonNegativeInt(data.step),
    });
  }
}

/** 供 buildUsageReport 使用：把一个 DSH home 下所有会话汇总成 { sessions, events }。 */
export async function parseDshSessions(homePath, source, options = {}) {
  const sessions = new Map();
  const events = [];

  for (const filePath of await dshSessionFiles(homePath)) {
    await streamDshSessionEvents(
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
        if (event.modelProvider) {
          session.modelProvider = event.modelProvider;
        }
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
