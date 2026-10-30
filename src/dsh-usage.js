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

function dshFrameOffsets(buffer) {
  const offsets = [];
  for (let at = buffer.indexOf(ZSTD_MAGIC); at !== -1; at = buffer.indexOf(ZSTD_MAGIC, at + ZSTD_MAGIC.length)) {
    offsets.push(at);
  }
  return offsets;
}

/**
 * 逐帧解压一个会话日志并逐行产出 JSON。
 *
 * 压缩文件本身仍一次读入（当前样本约 11 MiB）；关键是**不再**把全部解压帧转成字符串后
 * `join().split()`，也不把全部 row 留给调用方。每帧只保留 pending line，并逐行 yield。
 * 这样 usage / perf 两个消费端都可以在单行投影完成后立即释放原 row。
 *
 * 用「魔数位置」作为帧边界：实测样本中每个魔数位置都是真实帧起点，
 * 但实现仍按「能否解压」容错，坏帧只记警告、不中断整个文件。
 * @param {string} filePath
 * @param {{
 *   onWarning?: (warning: string) => void,
 *   projectRow?: (row: any) => any | null
 * }} [options] `projectRow` is the internal hot-path projection; omitting it preserves the public full-row stream.
 */
export async function* streamDshSessionRows(filePath, { onWarning, projectRow } = {}) {
  const buffer = await readFile(filePath);
  const offsets = dshFrameOffsets(buffer);
  let successfulFrames = 0;
  let failedFrames = 0;
  let malformedLines = 0;
  let pending = "";

  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index];
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
      continue;
    }
    successfulFrames += 1;

    // 与冻结实现逐帧 `Buffer.toString("utf8")` 后 join 的语义一致：若写入方把
    // UTF-8 码点拆到两个 zstd 帧，两帧各自产生 replacement character，而不是
    // 在本内存优化中悄悄把它拼回原码点。
    let text = `${pending}${decompressed.toString("utf8")}`;
    pending = "";
    decompressed = null;
    let lineStart = 0;
    let line;
    let row;
    const projectedRows = projectRow ? [] : null;
    for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", lineStart)) {
      line = text.slice(lineStart, newline);
      lineStart = newline + 1;
      if (!line.trim()) {
        continue;
      }
      try {
        row = JSON.parse(line);
      } catch {
        // 写入中断可能留下半行：仍然跳过（用量事件行为不变），只把**行数**单独计数。
        malformedLines += 1;
        continue;
      }
      if (projectRow) {
        const projected = projectRow(row);
        if (projected !== null) {
          projectedRows.push(projected);
        }
      } else {
        yield row;
      }
    }
    pending = text.slice(lineStart);
    if (projectedRows) {
      row = undefined;
      line = undefined;
      text = "";
      decompressed = null;
      for (const projected of projectedRows) {
        yield projected;
      }
    }
  }

  if (successfulFrames === 0) {
    throw new Error(`无法解压 DSH 会话日志（${offsets.length} 个候选帧全部失败）`);
  }
  // 与旧数组 API 对齐：坏帧只在全文件扫描完成后汇总一次，且先于坏 JSON 告警。
  if (failedFrames) {
    onWarning?.(`DSH 会话日志 ${filePath} 有 ${failedFrames} 个损坏帧或空帧被跳过`);
  }

  if (pending.trim()) {
    let row;
    try {
      row = JSON.parse(pending);
    } catch {
      malformedLines += 1;
    }
    if (row !== undefined) {
      pending = "";
      if (projectRow) {
        const projected = projectRow(row);
        row = undefined;
        if (projected !== null) {
          yield projected;
        }
      } else {
        yield row;
      }
    }
  }
  if (malformedLines) {
    // ⚠️ 前缀是**妥协通道**：M2.2 reader（`src/perf-sources/dsh.js`）靠锚定前缀
    // `^MALFORMED_JSON:(\d+)\b` 把它映射为 `{code:MALFORMED_JSON,count}`。之所以只能走字符串：
    // 告警文本里除了这个数字**没有**别处能拿到坏行数，而 `rows` 的数组形状与「帧告警不含数字」
    // 的性质都被已冻结的 `scripts/perf-probe-sources/dsh.mjs` 依赖，改成对象式告警或元组
    // 返回值都会外溢。**技术债**：后续卡若需要该计数，应让本函数返回**结构化计数**或提供
    // 结构化诊断回调，届时本前缀应删除；在此之前 M3/M4 **不得**依赖字符串解析取数。
    // 原帧级告警文本保持不变；本行只新增，不改变任何既有调用方的行为。
    onWarning?.(
      `MALFORMED_JSON:${malformedLines} DSH 会话日志 ${filePath} 有 ${malformedLines} 行 JSON 无法解析被跳过`,
    );
  }
}

/**
 * 兼容收集器：保留既有数组 API（scripts/probe 与直接调用方依赖），但内部已逐行流式解析。
 * 新的大文件消费路径应使用 {@link streamDshSessionRows}，避免重新收回全部 row。
 * @param {string} filePath
 * @param {{ onWarning?: (warning: string) => void }} [options]
 */
export async function readDshSessionRows(filePath, options = {}) {
  const rows = [];
  for await (const row of streamDshSessionRows(filePath, options)) {
    rows.push(row);
  }
  return rows;
}

function dshSessionHeaderFromRow(row) {
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

/** 解析会话头；缺失时返回 null（调用方据此跳过该文件）。 */
export function dshSessionHeader(rows = []) {
  return dshSessionHeaderFromRow(rows.find((entry) => entry?.type === "session"));
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

function projectDshSessionHeaderRow(row) {
  return row?.type === "session"
    ? {
        type: "session",
        header: dshSessionHeaderFromRow(row),
      }
    : null;
}

/** Keep only fields consumed by usage events; message content and stream never cross the yield boundary. */
function projectDshUsageRow(row) {
  const type = row?.type;
  const data = row?.data;
  if (type === "request/header" || type === "request/context") {
    const config = data?.header?.config;
    return {
      type,
      data: {
        header: { config: { model: config?.model, provider: config?.provider } },
        model: data?.model,
        provider: data?.provider,
      },
    };
  }
  if (type === "session/title") {
    return { type, data: { title: data?.title } };
  }
  if (type === "assistant/message") {
    return {
      type,
      time: row?.time,
      seq: row?.seq,
      data: {
        usage: data?.usage,
        turn: data?.turn,
        step: data?.step,
      },
    };
  }
  return null;
}

/**
 * 两遍扫描一个会话日志，产出标准化用量事件。
 * 第一遍只保存薄 header 与 parser 告警；第二遍从头投影全部行。这样既不在
 * 晚到 header 时保留全部原始 row，也能保证 parser 告警先于任何事件回调。
 * 只读用量与元数据字段；message/content/stream/tool 参数与结果一律不读。
 * @param {string} filePath
 * @param {{ id: string, label: string, path: string }} source
 * @param {(event: any) => Promise<void> | void} onEvent
 */
export async function streamDshSessionEvents(filePath, source, onEvent, options = {}) {
  const resolveRepository = options.repositoryResolver || createRepositoryResolver();
  const parserWarnings = [];
  let header = null;
  let model = "";
  let modelProvider = "";
  let conversationName = "";

  for await (const row of streamDshSessionRows(filePath, {
    onWarning: (warning) => parserWarnings.push(warning),
    projectRow: projectDshSessionHeaderRow,
  })) {
    if (header === null) {
      header = row.header;
    }
  }

  // 冻结实现先解压并解析完整文件、发出 parser 告警，之后才开始投影。
  for (const warning of parserWarnings) {
    options.onWarning?.(warning);
  }
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

  const processRow = async (row) => {
    const type = String(row?.type || "");
    const data = row?.data;

    if (type === "request/header" || type === "request/context") {
      const config = data?.header?.config;
      model = String(config?.model || data?.model || model || "").trim();
      modelProvider = String(config?.provider || data?.provider || modelProvider || "").trim();
      return;
    }
    if (type === "session/title") {
      const title = String(data?.title || "").trim();
      if (title) {
        conversationName = title.length > SESSION_TITLE_LIMIT ? `${title.slice(0, SESSION_TITLE_LIMIT)}…` : title;
      }
      return;
    }
    if (type !== "assistant/message" || !data?.usage) {
      return;
    }

    const timestampMs = numeric(row.time);
    if (timestampMs === null) {
      return;
    }

    const mapped = dshUsageFromRaw(data.usage);
    if (isZeroUsage(mapped.usage)) {
      return;
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
  };

  for await (const row of streamDshSessionRows(filePath, { projectRow: projectDshUsageRow })) {
    await processRow(row);
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
