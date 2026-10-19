/**
 * M0.3 DSH 来源探测模块（只读）。
 *
 * 复用生产 reader `readDshSessionRows()` 的逐帧解压与坏帧告警；本模块只做投影与配对，
 * 不修改任何生产代码。投影**只访问**：
 * - `session` 头的 `version`/`delegationDepth`/`agentPreset`（id 只用于内存内的会话分组，不落盘）；
 * - `request/header|request/context` 的 `data.header.config.{model,provider}`；
 * - `step/start` 的 `(data.turn, data.step, row.time)`；
 * - `assistant/message` 的 `(data.turn, data.step, row.time, data.usage.outputTokens)`。
 *
 * 不访问 `data.stream`、任何正文载体、`step/end` 的 data/time —— `guardData()` 用 Proxy
 * 在运行时拦下这些键，因此 `streamAccessed/contentAccessed/stepEndAccessed` 是**实测**结果，
 * 而不是硬编码声明。产物只含聚合计数/布尔/穷举枚举，不含路径、会话 ID、模型名或正文。
 *
 * 有界探测：按规范排序取首尾文件、全源最多 `maxRows` 行；截断时 `truncated/capped/complete`
 * 明确置位。含坏帧的文件其剩余记录同样不算完整来源（`complete=false` + `MALFORMED_FRAME`）。
 */
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

import { dshSessionFiles, readDshSessionRows } from "../../src/dsh-usage.js";
import { discoverDshHomes } from "../../src/usage-core.js";

/** 生产 reader 只认识已实测的 v4；更高版本不按 v4 硬解。 */
const SUPPORTED_SESSION_VERSION = 4;
/** 毫秒 epoch 的合理下界（2001-09-09T01:46:40Z）：低于它的"秒"时间戳按单位不符处理。 */
const MS_EPOCH_FLOOR = 1_000_000_000_000;
/** 单个 step 跨度的合理上界；超过即认为时间单位不匹配。 */
const MAX_PLAUSIBLE_STEP_SPAN_MS = 3_600_000;
/** §17.4 `LONG_WINDOW` 阈值：只提示，不剔除样本。 */
const LONG_WINDOW_MS = 300_000;

/** dropped 主原因优先级（§17.5 固定优先级）与其枚举值。 */
const REASON_PRIORITY = Object.freeze(["recordConflict", "modelAmbiguous", "terminal", "output", "duration"]);
const REASON_ENUM = Object.freeze({
  recordConflict: "record_conflict",
  modelAmbiguous: "model_ambiguous",
  terminal: "terminal_unverified",
  output: "output_missing_zero_invalid",
  duration: "duration_missing_nonpositive_invalid",
});

/** 正文载体键：命中即计数并返回 undefined，原文永不进入投影。 */
const STREAM_CARRIER_KEYS = new Set(["stream", "delta", "chunks", "chunk"]);
const CONTENT_CARRIER_KEYS = new Set([
  "content",
  "text",
  "message",
  "messages",
  "body",
  "prompt",
  "reasoning",
  "summary",
  "raw",
  "args",
  "toolCalls",
  "tool_calls",
  "result",
  "output",
]);

/** 逐列存在性上报的列名 —— 必须是外壳 `KNOWN_COLUMN_NAMES` 的在册名。 */
const COLUMN_NAMES = Object.freeze([
  "session",
  "request",
  "header",
  "context",
  "step_start",
  "step_end",
  "assistant_message",
  "agent_preset",
  "delegation_depth",
  "output_tokens_usage",
]);
const REQUIRED_COLUMN_NAMES = Object.freeze(["session", "step_start", "assistant_message", "output_tokens_usage"]);

function frameType(row) {
  return row && typeof row === "object" ? String(row.type ?? "") : "";
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function integer(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function stringField(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 只读访问守卫：包住 `data`，拦下 stream/正文载体键。
 * 命中时返回 undefined 并计数，原文永不进入投影结果。
 */
function guardData(data, access) {
  if (!data || typeof data !== "object") {
    return data;
  }
  return new Proxy(data, {
    get(target, property, receiver) {
      if (typeof property === "string") {
        if (STREAM_CARRIER_KEYS.has(property)) {
          access.stream += 1;
          return undefined;
        }
        if (CONTENT_CARRIER_KEYS.has(property)) {
          access.content += 1;
          return undefined;
        }
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/** 只取 `data.header.config.{model,provider}`；config 其余字段不读。 */
function readHeaderConfig(data) {
  const config = data?.header?.config;
  if (!config || typeof config !== "object") {
    return null;
  }
  return { model: stringField(config.model), provider: stringField(config.provider) };
}

/** 只取 `data.usage.outputTokens`；usage 其余字段（input/cache/total）不读。 */
function readUsageOutput(data) {
  const usage = data?.usage;
  if (!usage || typeof usage !== "object") {
    return { present: false, output: null, invalid: false };
  }
  const raw = usage.outputTokens;
  if (raw === undefined || raw === null) {
    return { present: false, output: null, invalid: false };
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) {
    return { present: true, output: null, invalid: true };
  }
  return { present: true, output: raw, invalid: false };
}

function createStats() {
  return {
    // 帧类型原始计数
    requestCount: 0,
    requestHeaderCount: 0,
    sessionHeaderCount: 0,
    stepStartCount: 0,
    assistantMessageCount: 0,
    outputTokensPresent: 0,
    // 终态证据（M0.6 决议 DSH-G1）：只统计 `step/end` **判别式**与其 (turn,step) 归位，
    // 不读取该帧的 data 其余键与 time。
    stepEndFrames: 0,
    stepEndUnkeyable: 0,
    completeEvidenceCount: 0,
    // 会话/版本/缺失
    sessionsWithHeader: 0,
    missingSessionHeader: 0,
    versionNonV4Count: 0,
    unknownVersions: 0,
    unsupportedVersionCount: 0,
    missingUsage: 0,
    missingStart: 0,
    missingTimestampCount: 0,
    outputMissingCount: 0,
    outputZeroCount: 0,
    negativeDurations: 0,
    badFrames: 0,
    malformedFrameCount: 0,
    errors: 0,
    // 配对与重复
    pairedCandidates: 0,
    unpairedCandidates: 0,
    duplicateStartFrames: 0,
    duplicateMessageFrames: 0,
    multipleStartCount: 0,
    multipleMessageCount: 0,
    consistentDuplicateCount: 0,
    conflictingRecords: 0,
    identityDuplicateCount: 0,
    identityDuplicateGroupCount: 0,
    uniqueIdentities: 0,
    stepReuseAcrossTurns: 0,
    // 时间单位
    timeUnitCheckedCount: 0,
    timeUnitMatchedCount: 0,
    secondUnitCount: 0,
    milliSecondUnitCount: 0,
    unitAmbiguous: false,
    // §17.5 分层
    eligible: 0,
    positiveOutput: 0,
    timedPositiveOutput: 0,
    completeTimedPositiveOutput: 0,
    sampled: 0,
    pending: 0,
    dropped: 0,
    unplaced: 0,
    // 模型/代理身份
    headerChanges: 0,
    subagentDepthSessions: 0,
    agentPresetSessions: 0,
    delegationSessions: 0,
    turnCount: 0,
    configFrames: 0,
    modelPresentFrames: 0,
    providerPresentFrames: 0,
    modelKeys: new Set(),
    providerKeys: new Set(),
    // 逐列观测
    observed: {
      session: false,
      request: false,
      header: false,
      context: false,
      step_start: false,
      step_end: false,
      assistant_message: false,
    },
    flagCounts: {},
    reasons: { recordConflict: 0, modelAmbiguous: 0, terminal: 0, output: 0, duration: 0 },
  };
}

function addFlag(stats, name, count = 1) {
  stats.flagCounts[name] = (stats.flagCounts[name] || 0) + count;
}

function groupFor(groups, turn, step) {
  const key = `${turn}:${step}`;
  let group = groups.get(key);
  if (!group) {
    group = { starts: [], messages: [], endFrames: [] };
    groups.set(key, group);
  }
  return group;
}

function createSessionState() {
  return {
    headerSeen: false,
    agentPresetSeen: false,
    depthSeen: false,
    groups: new Map(),
    stepTurns: new Map(),
    turns: new Set(),
    currentModel: "",
    currentProvider: "",
    previousHeaderKey: null,
    // 帧在**单文件**内的 0-based 序号：仅用于判定 step/end 是否落在最后一条
    // assistant/message 之后，从而作为该 step 的终态证据。不落盘、不是身份。
    frameIndex: 0,
  };
}

/** 第一遍：只读 `row.type`，统计帧类型与逐列存在性。 */
function observeRows(rows, stats) {
  for (const row of rows) {
    const type = frameType(row);
    if (type === "session") {
      stats.observed.session = true;
      stats.sessionHeaderCount += 1;
    } else if (type === "request/header") {
      stats.observed.request = true;
      stats.observed.header = true;
      stats.requestCount += 1;
      stats.requestHeaderCount += 1;
    } else if (type === "request/context") {
      stats.observed.request = true;
      stats.observed.context = true;
      stats.requestCount += 1;
    } else if (type === "step/start") {
      stats.observed.step_start = true;
      stats.stepStartCount += 1;
    } else if (type === "step/end") {
      // 只读判别式：step/end 的 data/time 一律不访问。
      // `data.turn`/`data.step` 由 pairRows() 按同一帧序单独解析；此处只记存在性，
      // 使 `step_end` 这条**终态证据**可以按 (turn,step) 归位（对位属上报口径，不新增读取）。
      stats.observed.step_end = true;
    } else if (type === "assistant/message") {
      stats.observed.assistant_message = true;
      stats.assistantMessageCount += 1;
    }
  }
}

/** 第二遍：只读允许的 (turn,step,time,usage) 与 header config，按会话累积配对状态。 */
function pairRows(rows, session, stats, access) {
  for (const row of rows) {
    // 每条帧占用一个**递增**序号（同一会话跨文件续号）：这是判定 `step/end` 是否落在
    // 本组最后一条 `assistant/message` **之后**的唯一依据。序号不落盘、不是身份。
    const frameIndex = session.frameIndex;
    session.frameIndex += 1;
    const type = frameType(row);
    if (type === "request/header" || type === "request/context") {
      const config = readHeaderConfig(guardData(row.data, access));
      if (!config) {
        continue;
      }
      stats.configFrames += 1;
      if (config.model) {
        session.currentModel = config.model;
        stats.modelPresentFrames += 1;
        stats.modelKeys.add(config.model);
      }
      if (config.provider) {
        session.currentProvider = config.provider;
        stats.providerPresentFrames += 1;
        stats.providerKeys.add(config.provider);
      }
      if (config.model || config.provider) {
        const key = `${config.model}\u0000${config.provider}`;
        if (session.previousHeaderKey !== null && key !== session.previousHeaderKey) {
          stats.headerChanges += 1;
        }
        session.previousHeaderKey = key;
      }
      continue;
    }
    if (type === "step/start") {
      const time = numeric(row.time);
      const data = guardData(row.data, access);
      const turn = integer(data?.turn);
      const step = integer(data?.step);
      if (time === null || turn === null || step === null) {
        stats.unplaced += 1;
        if (time === null) {
          stats.missingTimestampCount += 1;
        }
        addFlag(stats, "TIME_UNPLACED");
        continue;
      }
      const group = groupFor(session.groups, turn, step);
      group.starts.push({ time, model: session.currentModel, provider: session.currentProvider });
      addStepTurn(session, step, turn);
      continue;
    }
    if (type === "assistant/message") {
      const time = numeric(row.time);
      const data = guardData(row.data, access);
      const turn = integer(data?.turn);
      const step = integer(data?.step);
      const usage = readUsageOutput(data);
      if (usage.present) {
        stats.outputTokensPresent += 1;
      } else {
        stats.missingUsage += 1;
      }
      if (time === null || turn === null || step === null) {
        stats.unplaced += 1;
        if (time === null) {
          stats.missingTimestampCount += 1;
        }
        addFlag(stats, "TIME_UNPLACED");
        continue;
      }
      const group = groupFor(session.groups, turn, step);
      group.messages.push({
        time,
        output: usage.output,
        invalid: usage.invalid,
        model: session.currentModel,
        provider: session.currentProvider,
        frameIndex,
      });
      addStepTurn(session, step, turn);
      continue;
    }
    if (type === "step/end") {
      // 只取 `(data.turn, data.step)` 定位；`row.time` 与 `data` 其余键一律不访问。
      // 该帧的类型判别式在 prepareRows() 已读，此处仅为把**终态证据**按身份归位。
      const data = guardData(row.data, access);
      const turn = integer(data?.turn);
      const step = integer(data?.step);
      if (turn === null || step === null) {
        stats.stepEndUnkeyable += 1;
        continue;
      }
      stats.stepEndFrames += 1;
      const group = groupFor(session.groups, turn, step);
      group.endFrames.push({ frameIndex });
    }
    // 其余帧：只读取了 `type` 判别式，不访问 data/time。
  }
}

function addStepTurn(session, step, turn) {
  let set = session.stepTurns.get(step);
  if (!set) {
    set = new Set();
    session.stepTurns.set(step, set);
  }
  set.add(turn);
  session.turns.add(turn);
}

/** 按 (home_id, session_id, turn, step) 配对；重复一致折叠，冲突计数为诊断且不任选末条。 */
function evaluateGroups(groups, stats) {
  for (const group of groups.values()) {
    const { starts, messages, endFrames } = group;
    if (starts.length > 1) {
      stats.duplicateStartFrames += 1;
      stats.multipleStartCount += starts.length - 1;
    }
    if (messages.length > 1) {
      stats.duplicateMessageFrames += 1;
      stats.multipleMessageCount += messages.length - 1;
    }
    const folds = Math.max(0, starts.length - 1) + Math.max(0, messages.length - 1);
    const startSignature = new Set(starts.map((entry) => `${entry.time}`));
    const messageSignature = new Set(
      messages.map(
        (entry) => `${entry.time}|${entry.output === null ? "none" : entry.output}|${entry.invalid ? "i" : "v"}`,
      ),
    );
    const conflict = startSignature.size > 1 || messageSignature.size > 1;
    if (conflict) {
      stats.identityDuplicateGroupCount += 1;
      stats.identityDuplicateCount += folds;
    } else if (folds > 0) {
      stats.consistentDuplicateCount += folds;
    }

    if (starts.length === 0) {
      // 有 message 无 start：缺时长候选，仍属 eligible（§17.5）。
      stats.unpairedCandidates += messages.length;
      stats.missingStart += messages.length;
      stats.eligible += messages.length;
      addFlag(stats, "MISSING_DURATION", messages.length);
      stats.reasons.duration += messages.length;
      for (const entry of messages) {
        if (entry.output !== null && entry.output > 0) {
          stats.positiveOutput += 1;
        }
      }
      continue;
    }
    if (messages.length === 0) {
      // 有 start 无 message：**无输出候选**，不进 eligible、也**不判 pending**。
      // 依据：本投影虽读 `step/end` 的判别式，但无法区分「已开始但尚未产生 message」与
      // 「message 帧丢失/上游未写」；§17.5 仅允许**明确进行中**的候选进 pending，
      // 因此此处只记 `unpairedCandidates`（contract：DSH「有 start 无 message」不算 pending）。
      stats.unpairedCandidates += starts.length;
      continue;
    }

    stats.eligible += 1;
    stats.uniqueIdentities += 1;
    if (conflict) {
      // 同身份计数/时间冲突：不任选末条、不相加，整体置诊断。
      stats.conflictingRecords += 1;
      addFlag(stats, "RECORD_CONFLICT");
      stats.reasons.recordConflict += 1;
      continue;
    }
    stats.pairedCandidates += 1;

    // 重复但一致 → 折叠为一条（time/output 完全相同的记录不可区分，折叠不引入选择偏差）。
    const start = starts[0];
    const message = messages[0];
    stats.timeUnitCheckedCount += 1;
    const duration = message.time - start.time;
    const msConsistent =
      start.time >= MS_EPOCH_FLOOR &&
      message.time >= MS_EPOCH_FLOOR &&
      Math.abs(duration) <= MAX_PLAUSIBLE_STEP_SPAN_MS;
    if (msConsistent) {
      stats.timeUnitMatchedCount += 1;
      stats.milliSecondUnitCount += 1;
    } else {
      stats.secondUnitCount += 1;
    }

    if (message.output === null && !message.invalid) {
      stats.outputMissingCount += 1;
      addFlag(stats, "MISSING_OUTPUT");
      stats.reasons.output += 1;
      continue;
    }
    if (message.invalid) {
      addFlag(stats, "TOKEN_INVALID");
      stats.reasons.output += 1;
      continue;
    }
    if (message.output === 0) {
      stats.outputZeroCount += 1;
      addFlag(stats, "OUTPUT_ZERO");
      stats.reasons.output += 1;
      continue;
    }
    stats.positiveOutput += 1;

    if (duration < 0) {
      stats.negativeDurations += 1;
    }
    if (duration <= 0) {
      addFlag(stats, "DURATION_NONPOSITIVE");
      stats.reasons.duration += 1;
      continue;
    }
    if (!msConsistent) {
      stats.unitAmbiguous = true;
      addFlag(stats, "TIME_INVALID");
      stats.reasons.duration += 1;
      continue;
    }
    stats.timedPositiveOutput += 1;

    if (start.model !== message.model || start.provider !== message.provider) {
      // 同一 step 内请求作用域模型/供应商变更 → 模型归属歧义。
      addFlag(stats, "MODEL_AMBIGUOUS");
      stats.reasons.modelAmbiguous += 1;
      continue;
    }
    stats.completeTimedPositiveOutput += 1;
    if (duration > LONG_WINDOW_MS) {
      addFlag(stats, "LONG_WINDOW");
    }
    // 终态证据（M0.6 决议 DSH-G1）：`step/end` 的判别式是本投影**实际观测到**的帧，
    // 不读其 data/time；仅当它出现在本组最后一条 assistant/message **之后**时，
    // 才构成"该 step 的输出已收尾"的终态信号。
    // 无 step/end 时**绝不**把 message 当成终态 —— 那正是 §17.4 位 10 要防的"推定成功"。
    const lastMessageIndex = messages[messages.length - 1].frameIndex;
    const hasTerminalEndFrame = endFrames.length > 0 && endFrames.some((end) => end.frameIndex > lastMessageIndex);
    if (hasTerminalEndFrame) {
      stats.completeEvidenceCount += 1;
      stats.sampled += 1;
      continue;
    }
    addFlag(stats, "TERMINAL_UNVERIFIED");
    stats.reasons.terminal += 1;
  }
  // 分层恒等式（§17.5）。`pending` 只由**明确进行中**的证据产生，本来源没有这类证据，
  // 故恒为 0；这里只做纯重算，绝不把别的计数回填进来（回填曾导致 dropped = -1）。
  stats.dropped = stats.eligible - stats.sampled - stats.pending;
}

/**
 * 分层计数不变式自检（§17.5）。任何负数/非整数或恒等式破裂都直接抛内部错误 ——
 * 让外壳以 `PROBE_FAILED`（exit 4）落盘，而不是把 `dropped=-1` 这类破损计数写成"证据"。
 */
function assertLayerInvariants(stats) {
  const counters = [
    "eligible",
    "sampled",
    "dropped",
    "pending",
    "positiveOutput",
    "timedPositiveOutput",
    "completeTimedPositiveOutput",
    "unpairedCandidates",
    "stepEndFrames",
    "completeEvidenceCount",
  ];
  for (const name of counters) {
    const value = stats[name];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`DSH probe invariant violated: counter ${name} must be a non-negative safe integer`);
    }
  }
  if (stats.dropped !== stats.eligible - stats.sampled - stats.pending) {
    throw new Error("DSH probe invariant violated: eligible !== sampled + dropped + pending");
  }
  if (
    stats.sampled > stats.completeTimedPositiveOutput ||
    stats.completeTimedPositiveOutput > stats.timedPositiveOutput ||
    stats.timedPositiveOutput > stats.positiveOutput ||
    stats.positiveOutput > stats.eligible
  ) {
    throw new Error("DSH probe invariant violated: sampled <= completeTimedPositiveOutput <= ... <= eligible broken");
  }
  if (stats.sampled !== stats.completeEvidenceCount) {
    throw new Error("DSH probe invariant violated: sampled !== completeEvidenceCount");
  }
}

function dominantReason(reasons) {
  let bestKey = null;
  let bestCount = 0;
  for (const key of REASON_PRIORITY) {
    const count = reasons[key] || 0;
    if (count > 0 && count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }
  return bestKey ? REASON_ENUM[bestKey] : "none";
}

/** 规范排序后取首尾文件；`--full` 或文件数不超上限时全取。 */
function selectBoundedFiles(files, { maxFiles, full }) {
  if (full || !Number.isSafeInteger(maxFiles) || maxFiles <= 0 || files.length <= maxFiles) {
    return { selected: files, truncatedFiles: 0 };
  }
  const head = Math.ceil(maxFiles / 2);
  const tail = maxFiles - head;
  const selected = [...new Set([...files.slice(0, head), ...files.slice(files.length - tail)])].sort();
  return { selected, truncatedFiles: files.length - selected.length };
}

/** 只哈希文件规模/修改时刻，哈希输入不含路径；输出为脱敏摘要。 */
async function fingerprintFiles(files, homeCount) {
  const hash = createHash("sha256");
  let fileCount = 0;
  for (const file of files) {
    try {
      const info = await stat(file);
      fileCount += 1;
      hash.update(`${info.size}:${Math.floor(info.mtimeMs)}\n`);
    } catch {
      hash.update("unreadable\n");
    }
  }
  return { fingerprint: hash.digest("hex"), fileCount, homeCount, checkedAt: new Date().toISOString() };
}

function columnState(seen, structureObserved, fullyCovered) {
  if (seen) {
    return "present";
  }
  return structureObserved && fullyCovered ? "absent" : "unknown";
}

/**
 * DSH 来源探测入口。外壳传入的 `maxFiles/maxRows` 在 `full=true` 时为 null。
 * @param {{ maxFiles?: number|null, maxRows?: number|null, full?: boolean }} options
 */
export async function probe({ maxFiles = null, maxRows = null, full = false } = {}) {
  const startedMs = Date.now();
  const access = { stream: 0, content: 0 };
  const stats = createStats();

  const homes = await discoverDshHomes({ env: process.env });
  const discovered = [];
  for (const home of homes) {
    for (const file of await dshSessionFiles(home.path)) {
      discovered.push({ file, homeId: home.id });
    }
  }
  discovered.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
  const allFiles = discovered.map((entry) => entry.file);
  const sourceFingerprintBefore = await fingerprintFiles(allFiles, homes.length);

  const selection = selectBoundedFiles(allFiles, { maxFiles, full });
  const selectedFiles = new Set(selection.selected);
  const rowBudget = full || !Number.isSafeInteger(maxRows) || maxRows <= 0 ? Number.POSITIVE_INFINITY : maxRows;

  let rowsScanned = 0;
  let rowsRead = 0;
  let truncatedRows = 0;
  let truncatedFiles = selection.truncatedFiles;
  let filesScanned = 0;
  let budgetExhausted = false;
  const sessions = new Map();

  for (const entry of discovered) {
    if (!selectedFiles.has(entry.file)) {
      continue;
    }
    if (budgetExhausted) {
      truncatedFiles += 1;
      continue;
    }
    filesScanned += 1;
    let rows;
    let fileWarnings = 0;
    try {
      // 只读复用生产 reader 的逐帧解压与坏帧告警；告警原文（含路径）不落盘、不打印。
      rows = await readDshSessionRows(entry.file, {
        onWarning: () => {
          fileWarnings += 1;
        },
      });
    } catch {
      // 全部候选帧不可解压：整文件按坏帧处理，其记录不得称为完整来源。
      stats.badFrames += 1;
      stats.malformedFrameCount += 1;
      stats.errors += 1;
      continue;
    }
    if (fileWarnings > 0) {
      stats.badFrames += 1;
      stats.malformedFrameCount += 1;
    }
    rowsRead += rows.length;
    const remaining = rowBudget - rowsScanned;
    const usable = rows.length <= remaining ? rows : rows.slice(0, remaining);
    if (usable.length < rows.length) {
      truncatedRows += rows.length - usable.length;
      budgetExhausted = true;
    }
    rowsScanned += usable.length;
    observeRows(usable, stats);

    const header = usable.find((row) => frameType(row) === "session") ?? null;
    if (!header) {
      stats.missingSessionHeader += 1;
      stats.unplaced += usable.length;
      addFlag(stats, "TIME_UNPLACED", usable.length);
    } else {
      const version = numeric(header.version);
      if (version === null) {
        stats.unknownVersions += 1;
      } else if (Math.trunc(version) !== SUPPORTED_SESSION_VERSION) {
        // v4 之外的版本不按 v4 硬解（与生产 reader 一致）；其帧不进入配对。
        stats.versionNonV4Count += 1;
        stats.unsupportedVersionCount += 1;
        if (rowsScanned >= rowBudget) {
          budgetExhausted = true;
        }
        continue;
      }
      // 会话身份 = (home_id, session_id)；同一会话跨文件时配对状态合并。
      const sessionId = stringField(header.id) || `anonymous:${filesScanned}`;
      const sessionKey = `${entry.homeId}\u0000${sessionId}`;
      let session = sessions.get(sessionKey);
      if (!session) {
        session = createSessionState();
        sessions.set(sessionKey, session);
      }
      if (!session.headerSeen) {
        session.headerSeen = true;
        stats.sessionsWithHeader += 1;
      }
      if (!session.agentPresetSeen && typeof header.agentPreset === "string" && header.agentPreset.trim() !== "") {
        session.agentPresetSeen = true;
        stats.agentPresetSessions += 1;
      }
      const depth = numeric(header.delegationDepth);
      if (depth !== null) {
        if (!session.depthSeen) {
          session.depthSeen = true;
          stats.delegationSessions += 1;
        }
        if (depth > 0) {
          stats.subagentDepthSessions += 1;
        }
      }
      pairRows(usable, session, stats, access);
    }
    if (rowsScanned >= rowBudget) {
      budgetExhausted = true;
    }
  }

  for (const session of sessions.values()) {
    stats.turnCount += session.turns.size;
    for (const set of session.stepTurns.values()) {
      if (set.size > 1) {
        stats.stepReuseAcrossTurns += 1;
      }
    }
    evaluateGroups(session.groups, stats);
  }

  const sourceFingerprintAfter = await fingerprintFiles(allFiles, homes.length);
  const liveSourceChanged =
    Boolean(sourceFingerprintBefore.fingerprint) &&
    sourceFingerprintBefore.fingerprint !== sourceFingerprintAfter.fingerprint;

  const truncated = truncatedFiles > 0 || truncatedRows > 0;
  const complete =
    !truncated &&
    stats.badFrames === 0 &&
    stats.errors === 0 &&
    stats.missingSessionHeader === 0 &&
    stats.unsupportedVersionCount === 0 &&
    !liveSourceChanged &&
    filesScanned === allFiles.length;
  const coverageState = complete ? "ready" : "degraded";
  stats.dropped = stats.eligible - stats.sampled - stats.pending;
  assertLayerInvariants(stats);

  const warnings = [];
  if (allFiles.length === 0) {
    warnings.push({ code: "NO_SOURCE_FILES", count: 1 });
  }
  if (stats.badFrames > 0) {
    warnings.push({ code: "MALFORMED_FRAME", count: stats.badFrames });
  }
  if (stats.unsupportedVersionCount > 0) {
    warnings.push({ code: "UNSUPPORTED_SCHEMA", count: stats.unsupportedVersionCount });
  }
  if (liveSourceChanged) {
    warnings.push({ code: "LIVE_SOURCE_CHANGED", count: 1 });
  }
  const warningCounts = {};
  for (const warning of warnings) {
    if (warning.code !== "NO_SOURCE_FILES") {
      warningCounts[warning.code] = warning.count;
    }
  }

  const diagnosticReason = dominantReason(stats.reasons);
  const fullyCovered = filesScanned === allFiles.length && !truncated;
  const frameColumns = {
    session: columnState(stats.observed.session, rowsScanned > 0, fullyCovered),
    request: columnState(stats.observed.request, rowsScanned > 0, fullyCovered),
    header: columnState(stats.observed.header, rowsScanned > 0, fullyCovered),
    context: columnState(stats.observed.context, rowsScanned > 0, fullyCovered),
    step_start: columnState(stats.observed.step_start, rowsScanned > 0, fullyCovered),
    step_end: columnState(stats.observed.step_end, rowsScanned > 0, fullyCovered),
    assistant_message: columnState(stats.observed.assistant_message, rowsScanned > 0, fullyCovered),
    agent_preset: columnState(stats.agentPresetSessions > 0, stats.sessionsWithHeader > 0, fullyCovered),
    delegation_depth: columnState(stats.delegationSessions > 0, stats.sessionsWithHeader > 0, fullyCovered),
    output_tokens_usage: columnState(stats.outputTokensPresent > 0, stats.assistantMessageCount > 0, fullyCovered),
  };
  const requiredColumns = Object.fromEntries(REQUIRED_COLUMN_NAMES.map((name) => [name, frameColumns[name]]));
  const columnStates = { present: 0, absent: 0, unknown: 0, total: COLUMN_NAMES.length };
  for (const name of COLUMN_NAMES) {
    columnStates[frameColumns[name]] += 1;
  }

  const flagNames = Object.keys(stats.flagCounts).filter((name) => stats.flagCounts[name] > 0);
  const flagCount = flagNames.reduce((total, name) => total + stats.flagCounts[name], 0);
  const unitAmbiguous =
    stats.unitAmbiguous || (stats.timeUnitCheckedCount > 0 && stats.timeUnitMatchedCount < stats.timeUnitCheckedCount);
  const timeUnit =
    stats.timeUnitCheckedCount > 0 && stats.timeUnitMatchedCount === stats.timeUnitCheckedCount
      ? "milliseconds"
      : "unknown";
  const sourceVersion =
    stats.sessionsWithHeader > 0 && stats.versionNonV4Count === 0 && stats.unknownVersions === 0 ? "v4" : "unknown";
  // delegationDepth > 0 是**唯一**可证的 subagent 证据；depth == 0 不能反推 main。
  const allSubagentDepth = stats.sessionsWithHeader > 0 && stats.subagentDepthSessions === stats.sessionsWithHeader;

  const fields = {
    windowKind: "step",
    timingKind: "request_e2e",
    timingSource: "derived",
    durationBasis: "message_minus_start",
    durationProvenance: "timestamp_fallback",
    tokenScope: "reported_output_unspecified",
    statusKind: stats.completeEvidenceCount > 0 ? "completed" : "unverified",
    terminalFieldKind: stats.completeEvidenceCount > 0 ? "step_end_frame" : "absent",
    terminalEvidenceDecision: stats.completeEvidenceCount > 0 ? "proven_completed" : "unverified",
    agentKind: allSubagentDepth ? "subagent" : "unknown",
    agentKindMapping: allSubagentDepth ? "explicit_subagent_flag" : "unknown_default",
    agentNameEvidence: "agent_preset",
    agentRoleProvenance: "delegation_depth",
    modelEvidence: "request_scope",
    modelScope: "request_header",
    providerScope: "request_header",
    identityScheme: "turn_step",
    timeUnit,
    unitKind: timeUnit === "milliseconds" ? "ms" : "unknown",
    schemaKind: "dsh-jsonl",
    backend: "jsonl",
    sourceVersion,
    readOnlyStrategy: "file_read_only",
    coverageState,
    diagnosticReason: stats.completeEvidenceCount > 0 ? "none" : diagnosticReason,
    readOnly: true,
    projectionReady: true,
    streamAccessed: access.stream > 0,
    contentAccessed: access.content > 0,
    // `step/end` 的判别式被读取（终态证据所必需）；其 data 其余键与 time 仍未访问。
    stepEndAccessed: stats.stepEndFrames > 0 || stats.stepEndUnkeyable > 0,
    bodySentinelFound: false,
    duplicateCollapsed: stats.consistentDuplicateCount > 0,
    conflictDetected: stats.conflictingRecords > 0,
    pairingConsistent: stats.conflictingRecords === 0,
    identityUnique: stats.identityDuplicateGroupCount === 0,
    stepResetObserved: stats.stepReuseAcrossTurns > 0,
    modelChangedMidSession: stats.headerChanges > 0,
    unitAmbiguous,
    timestampFallbackUsed: true,
    explicitDurationUsed: false,
    completedExplicit: false,
    outputExplicit: true,
    allColumnsPresent: REQUIRED_COLUMN_NAMES.every((name) => frameColumns[name] === "present"),
    distinctModels: stats.modelKeys.size,
    distinctProviders: stats.providerKeys.size,
    turnCount: stats.turnCount,
    flagCount,
    columnCount: columnStates.total,
    presentColumnCount: columnStates.present,
    absentColumnCount: columnStates.absent,
    unknownColumnCount: columnStates.unknown,
    columns: frameColumns,
    requiredColumns,
    columnStates,
  };

  const scanned = {
    files: allFiles.length,
    filesDiscovered: allFiles.length,
    filesScanned,
    rowsScanned,
    rowsRead,
    homes: homes.length,
    sessions: allFiles.length,
    sessionsScanned: filesScanned,
    errors: stats.errors,
    requestCount: stats.requestCount,
    requestHeaderCount: stats.requestHeaderCount,
    sessionHeaderCount: stats.sessionHeaderCount,
    stepStartCount: stats.stepStartCount,
    assistantMessageCount: stats.assistantMessageCount,
    stepEndFrames: stats.stepEndFrames,
    stepEndUnkeyable: stats.stepEndUnkeyable,
    completeEvidenceCount: stats.completeEvidenceCount,
    pairedCandidates: stats.pairedCandidates,
    unpairedCandidates: stats.unpairedCandidates,
    duplicateStartFrames: stats.duplicateStartFrames,
    duplicateMessageFrames: stats.duplicateMessageFrames,
    multipleStartCount: stats.multipleStartCount,
    multipleMessageCount: stats.multipleMessageCount,
    consistentDuplicateCount: stats.consistentDuplicateCount,
    conflictingRecords: stats.conflictingRecords,
    identityDuplicateCount: stats.identityDuplicateCount,
    identityDuplicateGroupCount: stats.identityDuplicateGroupCount,
    uniqueIdentities: stats.uniqueIdentities,
    stepReuseAcrossTurns: stats.stepReuseAcrossTurns,
    headerChanges: stats.headerChanges,
    badFrames: stats.badFrames,
    malformedFrameCount: stats.malformedFrameCount,
    missingSessionHeader: stats.missingSessionHeader,
    missingStart: stats.missingStart,
    missingUsage: stats.missingUsage,
    outputMissingCount: stats.outputMissingCount,
    outputZeroCount: stats.outputZeroCount,
    negativeDurations: stats.negativeDurations,
    missingTimestampCount: stats.missingTimestampCount,
    versionNonV4Count: stats.versionNonV4Count,
    unsupportedVersionCount: stats.unsupportedVersionCount,
    timeUnitCheckedCount: stats.timeUnitCheckedCount,
    timeUnitMatchedCount: stats.timeUnitMatchedCount,
    secondUnitCount: stats.secondUnitCount,
    milliSecondUnitCount: stats.milliSecondUnitCount,
    eligible: stats.eligible,
    positiveOutput: stats.positiveOutput,
    timedPositiveOutput: stats.timedPositiveOutput,
    completeTimedPositiveOutput: stats.completeTimedPositiveOutput,
    sampled: stats.sampled,
    dropped: stats.dropped,
    // M0 返工（第 4 项）逐键复核结论：**本来源无需省略任何键**。
    // `pending` 的 0 属"结构事实"——本投影只承认**明确进行中**的证据，而 DSH 帧里没有这类证据
    // （见本文件 evaluateGroups() 的注释），故 0 是定义而非观测；其余键的 0 全部来自真实累加点
    // （missingStart/missingUsage/outputZeroCount/badFrames/malformedFrameCount/… 各有 `stats.* += 1`）。
    // 对比 Codex：那边 `errorRows` 等是**硬编码字面量 0**（属"未统计"）因而被省略。
    pending: stats.pending,
    unplaced: stats.unplaced,
    flagCount,
    flagMaskTotal: flagNames.length,
    bounded: !full,
    complete,
    capped: truncated,
    truncated,
    truncatedCount: truncatedRows,
    readOnly: true,
    projectionReady: true,
  };

  const decisions = {
    schemaKind: "dsh-jsonl",
    backend: "jsonl",
    coverageState,
    readOnly: true,
    readOnlyEnforced: true,
    projectionReady: true,
    identityUnique: stats.identityDuplicateGroupCount === 0,
    identitySchemeStable: true,
    optionalSourceUsed: false,
    optionalSourcePresent: false,
    fullScanRequested: full,
    filesDiscovered: allFiles.length,
    filesScanned,
    homeCount: homes.length,
    sourceCount: homes.length,
    durationMs: Date.now() - startedMs,
    checkedRowCount: rowsScanned,
    warningCounts,
    flagCounts: Object.fromEntries(flagNames.map((name) => [name, stats.flagCounts[name]])),
  };

  return {
    scanned,
    fields,
    decisions,
    warnings,
    sourceFingerprintBefore,
    sourceFingerprintAfter,
    liveSourceChanged,
  };
}
