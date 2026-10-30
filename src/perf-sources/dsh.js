/**
 * DSH（DeepSeek Harness）生成 TPS 候选 reader（只读）。
 *
 * 读一个物理会话日志（`session.v4.jsonl.zstd`，多帧拼接），按稳定的
 * `(sessionId,turn,step)` 输出可归属模型的候选。成功 message 自身的 usage 与 stream
 * 可证明用量闭合、状态与接收时钟；DSH 未提供精确的生成 token offset 和生成时段，因此
 * 当前候选不提供生成 N/D，也不从首末接收批次推导 TPS。解压、坏帧告警与 v4 守护复用
 * `readDshSessionRows()`。
 *
 * 投影**只访问**：
 * - `session` 头的 `id`/`version`/`delegationDepth`/`agentPreset`；
 * - `request/header`、`request/context` 的 `data.header.config.{model,provider}`；
 * - `step/start` 的 `data.{turn,step}` 与 `row.time`；
 * - `llm/retry-started` 的 `data.{turn,step}` 与 `row.time`（仅作最终尝试起点）；
 * - 成功 `assistant/message` 的 `data.{turn,step}`、`row.time`、
 *   `data.message.source.{model,provider}`、`data.usage.{outputTokens,reasoningTokens}`
 *   与同一 `data.stream` 的时间/空串结构；
 * - 步骤结束帧（裁定 G / M0.6 / task-24 裁定 (B)）**只取 `data.{turn,step}` 定位键与帧序**，
 *   它的 `row.time` 与 `data` 其余键**从不访问**。
 *
 * stream 只用于校验 packed 记录、重建边界并区分空串与真实空白；text/args 原文不离开本函数，
 * 不进入候选、日志或告警。**不访问** message 正文载体或步骤结束帧的产物载荷与时间戳。
 *
 * 身份：`sampleKey = JSON.stringify(['dsh', homeId, sessionId, turn, step])` —— 逐帧 `(turn,step)`
 * 按键分组，且 turn 参与身份，因此**跨 turn 的 step 重置**与**两会话相同的 `(turn,step)`** 都不碰撞。
 *
 * 帧序：帧序号**逐帧递增**（每条记录一个序号）。这是"步骤结束帧严格晚于该组最后一条
 * assistant/message"的唯一依据；序号在循环内自增（M0.3 曾把自增写在循环外，导致同文件所有帧
 * 共用一个序号、正常完成的 step 永远进不了样本，参见 `handoffs/M0.3-返工.md`）。
 */
import { DSH_SESSION_FORMAT_VERSION, dshSessionHeader, streamDshSessionRows } from "../dsh-usage.js";
import { PERF_EPOCH_MS_MIN, normalizePerfSample } from "../perf-stats.js";
import { readOutputObservations } from "../perf-output-observations.js";

/** 冻结码域（实施计划 §3:83）中本 reader 会用到的码。 */
const MALFORMED_FRAME_CODE = "MALFORMED_FRAME";
const MALFORMED_JSON_CODE = "MALFORMED_JSON";
const UNSUPPORTED_SCHEMA_CODE = "UNSUPPORTED_SCHEMA";
const UNKEYABLE_RECORD_CODE = "UNKEYABLE_RECORD";
/**
 * `src/dsh-usage.js` 为坏 JSON 行新增的告警前缀：`MALFORMED_JSON:<count> <人类可读文本>`。
 *
 * ⚠️ **这是妥协通道，不是设计（登记为技术债）**。现有 `onWarning` 是字符串回调（改签名会
 * 外溢到本卡无权修改的调用方），返回的又是 `rows` 数组（改成对象会破坏已冻结的
 * `scripts/perf-probe-sources/dsh.mjs`），因此**字符串是唯一可用通道**：count 由本卡在
 * dsh-usage 侧写入、在此按锚定前缀读回，不匹配就退化为 1。
 *
 * **M3/M4 若需要该计数，不得依赖字符串解析**：应在后续卡让 `readDshSessionRows` 返回
 * **结构化计数**（或新增结构化诊断回调），届时本前缀与这段读回逻辑应一并删除。
 */
const MALFORMED_JSON_PREFIX = /^MALFORMED_JSON:(\d+)\b/;

/** 步骤结束帧的判别式字面量（裁定 G：只据它做归属与帧序判定，不读其载荷）。 */
const STEP_END_TYPE = "step/end";
const RETRY_STARTED_TYPE = "llm/retry-started";
const SUCCESS_FINISH_KINDS = new Set(["stop", "tool-calls", "max-tokens"]);
const GENERATION_BLOCK_TYPES = new Set(["reasoning", "text", "tool-call"]);
const DSH_ALL_GENERATION_PROVIDERS = new Set(["deepseek-account", "deepseek-official"]);

function trimmedText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** 有限数（含 0/负数）：只用于时间差与帧序相关的算术，不做任何范围裁决。 */
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 请求诊断时窗的单位检查。只有两端都达到既有 epoch-ms 阈值时才计算诊断差值；
 * 不换算原值，也不把该差值交给生成 TPS。
 * @param {unknown} value
 * @returns {boolean}
 */
function isEpochMsUnit(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= PERF_EPOCH_MS_MIN;
}

/** 身份整数：`(turn,step)` 必须是安全非负整数，否则该帧无法形成稳定身份。 */
function identityInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** 值签名：只用于"重复一致则折叠 / 不一致则冲突"，不参与任何选择。 */
function valueTag(value) {
  if (value === undefined) {
    return "u";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "number") {
    return `n:${value}`;
  }
  if (typeof value === "string") {
    return `s:${value}`;
  }
  return `o:${JSON.stringify(value)}`;
}

function startKey(entry) {
  return valueTag(entry.time);
}

function messageKey(entry) {
  return [
    valueTag(entry.messageId),
    valueTag(entry.time),
    valueTag(entry.output),
    valueTag(entry.reasoning),
    valueTag(entry.effort),
    entry.generation.timingKey,
    entry.generation.allGenerationTimingKey,
    entry.generation.successful,
    entry.generation.usageParity,
  ].join("|");
}

function nonNegativeSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function stringArray(value) {
  return Array.isArray(value) && value.every((member) => typeof member === "string") ? value : null;
}

/**
 * 从一条成功 message 的同一 `data` 读取 N/D。返回的字符串只在函数内用于空串/空白边界，
 * 结果仅含数字、布尔与穷举状态。
 * @param {unknown} data
 */
export function inspectDshAssistantGeneration(data) {
  const root = data !== null && typeof data === "object" ? /** @type {any} */ (data) : {};
  const usage = root.usage !== null && typeof root.usage === "object" ? root.usage : null;
  const reportedOutputTokens = usage?.outputTokens;
  const reportedReasoningTokens = usage?.reasoningTokens;
  const outputTokens = nonNegativeSafeInteger(reportedOutputTokens);
  const reasoningTokens =
    outputTokens !== null &&
    nonNegativeSafeInteger(reportedReasoningTokens) !== null &&
    reportedReasoningTokens <= outputTokens
      ? reportedReasoningTokens
      : null;
  const nonReasoningTokens = outputTokens !== null && reasoningTokens !== null ? outputTokens - reasoningTokens : null;
  // The stream has receive timestamps but no token offset at its first received batch.
  // Consequently there is no exact generation numerator even when usage is fully known.
  const sampleOutputTokens = null;

  const emptyTiming = (state) => ({
    state,
    durationMs: null,
    windowStartMs: null,
    windowEndMs: null,
    timingKey: state,
  });
  const makeTiming = (state, firstTime, lastTime, interleaved = false) => {
    if (state !== "complete") {
      return emptyTiming(state);
    }
    if (interleaved) {
      return emptyTiming("reasoning_interleaved");
    }
    if (!isEpochMsUnit(firstTime) || !isEpochMsUnit(lastTime)) {
      return emptyTiming("unit_invalid");
    }
    const durationMs = lastTime - firstTime;
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
      return {
        ...emptyTiming("window_nonpositive"),
        timingKey: `window_nonpositive:${durationMs}`,
      };
    }
    return {
      state: "known",
      durationMs,
      windowStartMs: firstTime,
      windowEndMs: lastTime,
      timingKey: `known:${firstTime}:${lastTime}:${durationMs}`,
    };
  };

  let streamValid = false;
  let streamState = "missing_stream";
  let usageChunks = 0;
  let finishChunks = 0;
  let finishKind = null;
  let streamOutputTokens = null;
  let usageParity = false;
  let successFinish = false;
  let successful = false;
  let allGenerationTiming = emptyTiming("missing_stream");
  let nonReasoningTiming = emptyTiming("missing_stream");
  const stream = root.stream;
  if (!Array.isArray(stream)) {
    if (stream !== undefined && stream !== null) {
      streamState = "invalid_stream";
      allGenerationTiming = emptyTiming(streamState);
      nonReasoningTiming = emptyTiming(streamState);
    }
  } else if (stream.length > 0) {
    streamValid = true;
    streamState = "incomplete_success";
    let previousTime = null;
    /** @type {{ time: number } | null} */
    let firstAllBoundary = null;
    /** @type {{ time: number } | null} */
    let lastAllBoundary = null;
    /** @type {{ time: number } | null} */
    let firstNonReasoningBoundary = null;
    /** @type {{ time: number } | null} */
    let lastNonReasoningBoundary = null;
    let reasoningAfterOutput = false;
    let interleavedReasoning = false;
    let invalid = false;
    const finishKinds = new Set();
    const streamOutputs = [];

    const acceptTime = (time) => {
      if (!Number.isSafeInteger(time) || (previousTime !== null && time < previousTime)) {
        invalid = true;
        return false;
      }
      previousTime = time;
      return true;
    };
    const acceptMember = (time, type, value) => {
      if (!acceptTime(time)) {
        return;
      }
      if (type === "reasoning" && value !== "") {
        const boundary = { time };
        firstAllBoundary ??= boundary;
        lastAllBoundary = boundary;
        if (firstNonReasoningBoundary !== null) {
          reasoningAfterOutput = true;
        }
      } else if ((type === "text" || type === "tool-args") && value !== "") {
        if (reasoningAfterOutput) {
          interleavedReasoning = true;
        }
        const boundary = { time };
        firstAllBoundary ??= boundary;
        lastAllBoundary = boundary;
        firstNonReasoningBoundary ??= boundary;
        lastNonReasoningBoundary = boundary;
        reasoningAfterOutput = false;
      }
    };

    for (const record of stream) {
      if (invalid) {
        break;
      }
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        invalid = true;
        break;
      }
      if (record.type === "text-chunks" || record.type === "reasoning-chunks") {
        const texts = stringArray(record.texts);
        if (
          texts === null ||
          texts.length === 0 ||
          !Number.isSafeInteger(record.time0) ||
          nonNegativeSafeInteger(record.index) === null ||
          !Array.isArray(record.dt) ||
          record.dt.some((gap) => !Number.isSafeInteger(gap)) ||
          record.dt.length !== texts.length - 1
        ) {
          invalid = true;
          break;
        }
        let time = record.time0;
        for (let index = 0; index < texts.length; index += 1) {
          if (index > 0) {
            time += record.dt[index - 1];
            if (!Number.isSafeInteger(time)) {
              invalid = true;
              break;
            }
          }
          acceptMember(time, record.type === "text-chunks" ? "text" : "reasoning", texts[index]);
          if (invalid) {
            break;
          }
        }
        continue;
      }
      if (record.type === "tool-call-chunks") {
        const args = stringArray(record.args);
        if (
          args === null ||
          args.length === 0 ||
          typeof record.id !== "string" ||
          record.id.length === 0 ||
          (Object.hasOwn(record, "name") && (typeof record.name !== "string" || record.name.length === 0)) ||
          !Number.isSafeInteger(record.time0) ||
          nonNegativeSafeInteger(record.index) === null ||
          !Array.isArray(record.dt) ||
          record.dt.some((gap) => !Number.isSafeInteger(gap)) ||
          record.dt.length !== args.length - 1
        ) {
          invalid = true;
          break;
        }
        let time = record.time0;
        for (let index = 0; index < args.length; index += 1) {
          if (index > 0) {
            time += record.dt[index - 1];
            if (!Number.isSafeInteger(time)) {
              invalid = true;
              break;
            }
          }
          // Tool name is metadata; only a non-empty generated argument fragment is a boundary.
          acceptMember(time, "tool-args", args[index]);
          if (invalid) {
            break;
          }
        }
        continue;
      }
      if (record.type === "chunk") {
        if (
          !Number.isSafeInteger(record.time) ||
          record.chunk === null ||
          typeof record.chunk !== "object" ||
          Array.isArray(record.chunk)
        ) {
          invalid = true;
          break;
        }
        const chunk = record.chunk;
        if (chunk.type === "text-delta") {
          if (typeof chunk.text !== "string") {
            invalid = true;
            break;
          }
          acceptMember(record.time, "text", chunk.text);
        } else if (chunk.type === "reasoning-delta") {
          if (typeof chunk.text !== "string") {
            invalid = true;
            break;
          }
          acceptMember(record.time, "reasoning", chunk.text);
        } else if (chunk.type === "tool-call-delta") {
          if (typeof chunk.argumentsDelta !== "string") {
            invalid = true;
            break;
          }
          acceptMember(record.time, "tool-args", chunk.argumentsDelta);
        } else if (chunk.type === "block-start") {
          if (!GENERATION_BLOCK_TYPES.has(chunk.blockType)) {
            invalid = true;
            break;
          }
          acceptTime(record.time);
        } else if (chunk.type === "block-end") {
          if (
            chunk.block === null ||
            typeof chunk.block !== "object" ||
            Array.isArray(chunk.block) ||
            !GENERATION_BLOCK_TYPES.has(chunk.block.type)
          ) {
            invalid = true;
            break;
          }
          acceptTime(record.time);
        } else if (chunk.type === "usage") {
          usageChunks += 1;
          const streamUsage = chunk.usage !== null && typeof chunk.usage === "object" ? chunk.usage : null;
          streamOutputs.push(nonNegativeSafeInteger(streamUsage?.outputTokens));
          acceptTime(record.time);
        } else if (chunk.type === "finish") {
          finishChunks += 1;
          const kind = typeof chunk.reason?.kind === "string" ? chunk.reason.kind : "";
          if (kind !== "") {
            finishKinds.add(kind);
          }
          acceptTime(record.time);
        } else if (chunk.type === "message_start" || chunk.type === "message_delta") {
          // Known wire metadata; it contributes only to the stream clock.
          acceptTime(record.time);
        } else {
          invalid = true;
          break;
        }
        continue;
      }
      invalid = true;
    }

    if (invalid) {
      streamValid = false;
      streamState = "invalid_stream";
      allGenerationTiming = emptyTiming(streamState);
      nonReasoningTiming = emptyTiming(streamState);
    } else {
      const firstAllTime = firstAllBoundary?.time;
      const lastAllTime = lastAllBoundary?.time;
      const firstNonReasoningTime = firstNonReasoningBoundary?.time;
      const lastNonReasoningTime = lastNonReasoningBoundary?.time;
      allGenerationTiming =
        firstAllTime === undefined || lastAllTime === undefined
          ? emptyTiming("no_output")
          : makeTiming("complete", firstAllTime, lastAllTime);
      nonReasoningTiming =
        firstNonReasoningTime === undefined || lastNonReasoningTime === undefined
          ? emptyTiming("no_output")
          : makeTiming("complete", firstNonReasoningTime, lastNonReasoningTime, interleavedReasoning);

      streamOutputTokens =
        usageChunks === 1 && streamOutputs.length === 1 && streamOutputs[0] !== null ? streamOutputs[0] : null;
      finishKind = finishKinds.size === 1 ? [...finishKinds][0] : null;
      const last = stream.at(-1);
      const lastIsFinish = last?.type === "chunk" && last.chunk?.type === "finish";
      successFinish =
        finishChunks === 1 && lastIsFinish && finishKinds.size === 1 && SUCCESS_FINISH_KINDS.has(finishKind);
      usageParity = outputTokens !== null && streamOutputTokens !== null && outputTokens === streamOutputTokens;
      successful = successFinish && usageParity;
      if (successful) {
        streamState = "success";
      }
    }
  } else if (stream.length === 0) {
    streamValid = true;
    streamState = "incomplete_success";
    allGenerationTiming = emptyTiming("no_output");
    nonReasoningTiming = emptyTiming("no_output");
  }

  const allGenerationSampleOutputTokens = null;
  if (!successful) {
    allGenerationTiming = emptyTiming(
      allGenerationTiming.state === "invalid_stream" ? "invalid_stream" : "not_successful",
    );
  }

  return {
    reportedOutputTokens,
    reportedReasoningTokens,
    outputTokens,
    reasoningTokens,
    nonReasoningTokens,
    sampleOutputTokens,
    allGenerationSampleOutputTokens,
    streamValid,
    streamState,
    usageChunks,
    finishChunks,
    finishKind,
    streamOutputTokens,
    usageParity,
    successFinish,
    successful,
    timingState: nonReasoningTiming.state,
    durationMs: nonReasoningTiming.durationMs,
    windowStartMs: nonReasoningTiming.windowStartMs,
    windowEndMs: nonReasoningTiming.windowEndMs,
    timingKey: nonReasoningTiming.timingKey,
    allGenerationTimingState: allGenerationTiming.state,
    allGenerationDurationMs: allGenerationTiming.durationMs,
    allGenerationWindowStartMs: allGenerationTiming.windowStartMs,
    allGenerationWindowEndMs: allGenerationTiming.windowEndMs,
    allGenerationTimingKey: allGenerationTiming.timingKey,
  };
}

/**
 * 单会话内的请求作用域追踪（裁定 P / M2.2 要求 3）。
 *
 * `request/header|context` **开启**一个请求作用域；它归**随后第一条**带 `(turn,step)` 的帧所有。
 * 同一 turn 内的后续帧复用已开启的作用域；**新 turn 而没有新 header 时，作用域是空模型**
 * —— 绝不把上一轮的模型套到无 header 的下一请求（M0 未证明 header 作用域时 model 留空）。
 * @param {{
 *   pendingHeader: {model: string, provider: string, effort: string} | null,
 *   currentHeader: {model: string, provider: string, effort: string} | null,
 *   active: {
 *     turn: number,
 *     model: string,
 *     provider: string,
 *     effort: string,
 *     proven: boolean,
 *     evidence: string
 *   } | null
 * }} state
 * @param {number} turn
 */
function claimScope(state, turn) {
  if (state.pendingHeader) {
    state.active = {
      turn,
      model: state.pendingHeader.model,
      provider: state.pendingHeader.provider,
      effort: state.pendingHeader.effort,
      proven: true,
      evidence: "request_scope",
    };
    state.pendingHeader = null;
    return state.active;
  }
  if (state.active && state.active.turn === turn) {
    return state.active;
  }
  state.active = { turn, model: "", provider: "", effort: "", proven: false, evidence: "request_scope" };
  return state.active;
}

/**
 * A successful message carries its own canonical provider/model source. DSH only emits a
 * request header when the effective header changes, so the latest header is also retained
 * for effort. The message source can therefore prove scope on a later turn without
 * borrowing that proof into an unrelated header-less record.
 * @param {any} row
 * @param {number} turn
 * @param {{model: string, provider: string, effort: string, proven: boolean, evidence: string}} requestScope
 * @param {{model: string, provider: string, effort: string} | null} currentHeader
 */
function messageSourceScope(row, turn, requestScope, currentHeader) {
  const source = row?.data?.message?.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return null;
  }
  const model = trimmedText(source.model);
  const provider = trimmedText(source.provider);
  if (model === "" && provider === "") {
    return null;
  }
  return {
    turn,
    model: model || requestScope.model || currentHeader?.model || "",
    provider: provider || requestScope.provider || currentHeader?.provider || "",
    effort: requestScope.effort || currentHeader?.effort || "",
    proven: true,
    evidence: "message_source",
  };
}

/**
 * Collapse a parsed row before it crosses the async-generator boundary. The successful message's
 * stream is inspected immediately; its text/args payload is not retained by the TPS groups.
 * @param {any} row
 */
function projectDshPerfRow(row) {
  const type = typeof row?.type === "string" ? row.type : "";
  const data = row?.data;
  if (type === "request/header" || type === "request/context") {
    const config = data?.header?.config;
    return {
      type,
      data: {
        header: {
          config:
            config && typeof config === "object"
              ? {
                  model: config.model,
                  provider: config.provider,
                  reasoningEffort: config.reasoningEffort,
                }
              : null,
        },
      },
    };
  }
  if (type === "step/start" || type === RETRY_STARTED_TYPE) {
    return {
      type,
      time: row?.time,
      data: { turn: data?.turn, step: data?.step },
    };
  }
  if (type === "assistant/message") {
    const turn = data?.turn;
    const step = data?.step;
    const source = data?.message?.source;
    return {
      type,
      time: row?.time,
      data: {
        turn,
        step,
        generation:
          identityInteger(turn) !== null && identityInteger(step) !== null ? inspectDshAssistantGeneration(data) : null,
        message:
          source && typeof source === "object" && !Array.isArray(source)
            ? { id: data.message.id, source: { model: source.model, provider: source.provider } }
            : undefined,
      },
    };
  }
  if (STEP_END_TYPE === type) {
    return { type, data: { turn: data?.turn, step: data?.step } };
  }
  return { type };
}

/**
 * 输出一条规范候选。返回 `true` 表示已通过 `normalizePerfSample()` 并交给 `onSample`。
 * @param {any} group
 * @param {{ homeId: string, sessionId: string, filePath: string, channel: string, agentKind: string, agent: string, lookupOutput: Function }} session
 * @param {(sample: any) => Promise<void> | void} onSample
 * @param {(code: string, count?: number) => void} addWarning
 * @returns {Promise<boolean>}
 */
async function emitGroup(group, session, onSample, addWarning) {
  const stepStart = group.starts.length > 0 ? group.starts[0] : null;
  const message = group.messages.length > 0 ? group.messages[0] : null;
  if (!message) {
    // 有 start 无 message：**不是候选**（无输出可统计；M0 契约：不进 eligible）。不产候选、不置 pending。
    return false;
  }
  // 同 step 重试时，最终 message 前的最后一条 retry-started 才是本次模型调用起点。
  const retryStart = group.retryStarts.filter((entry) => entry.frameIndex < message.frameIndex).at(-1) ?? null;
  const start = retryStart ?? stepStart;

  const startTimes = new Set(group.starts.map(startKey));
  const messageTimes = new Set(group.messages.map(messageKey));
  const recordConflict = startTimes.size > 1 || messageTimes.size > 1;

  // ---- 代表对：**文档顺序第一条**，与"较快时窗"无关（冲突时不任选较快/较慢，也不求和）。
  const startScope = stepStart?.proven ? stepStart : null;
  const messageScope = message.proven ? message : null;
  const scope = messageScope ?? startScope;

  // ---- P1-3：模型歧义必须看**全部成员**的**已证明**证据，不能只看代表对。
  // 只看首条 start 与首条 message 时，同组后续成员关联到另一个模型会**完全不报**：
  // 实测 A/B 与 B/A 两组同身份记录都只留下一个干净候选（无 MODEL_AMBIGUOUS）。
  // 计数式判据（"取值集合大小 ≤ 1"）天然对顺序对称：正序/反序结果相同。
  // **只算 `proven` 的成员**：`claimScope` 会把"新 turn 且无 header"标记为
  // `proven:false, model:""`，那是**未证明**而非**不一致** —— 放进来会造成误报。
  const provenScopes = [...group.starts, ...group.messages].filter((entry) => entry.proven);
  const modelValues = new Set(provenScopes.map((entry) => entry.model));
  const providerValues = new Set(provenScopes.map((entry) => entry.provider));
  const effortValues = new Set(provenScopes.map((entry) => entry.effort));
  // M1 的 `MODEL_AMBIGUOUS` 只有**一个位**，因此 model 或 provider 任一不一致都置位。
  //
  // ⚠️ **裁定 AU / D3（拒绝）**：本 reader **不得**为"模型变了还是 provider 变了"写 `filterReason`。
  // 实测依据（Lead，`perf-stats.js:804-806`）：**只要 `filterReason !== ""` 就必置 `SOURCE_FILTERED`，
  // 无任何豁免**。而 `SOURCE_FILTERED` 的语义是"**来源侧**失败/取消/重试"，不是"同 step 内模型歧义"。
  // 借用该通道会让一个**模型歧义**样本同时声称"来源侧失败" —— **制造一条不成立的因果**，
  // 恰是 P1-3 所修缺陷的**镜像**（P1-3 是"该报的没报"，借道是"报了不该报的"）。
  // 若确需细分，正确路径是在 M1 **增加独立位**，不得借用 `filterReason`。
  const modelAmbiguous = modelValues.size > 1 || providerValues.size > 1;
  const effortConflict = effortValues.size > 1;
  const generationConflict = recordConflict || modelAmbiguous || effortConflict;

  // Original callback clocks stay diagnostic; the companion uses transport batches.
  const startTime = start ? finiteNumber(start.time) : null;
  const messageTime = finiteNumber(message.time);
  const unitsComparable = isEpochMsUnit(startTime) && isEpochMsUnit(messageTime);
  const reportedDurationMs =
    start && unitsComparable && startTime !== null && messageTime !== null ? messageTime - startTime : null;
  const officialAllGeneration = DSH_ALL_GENERATION_PROVIDERS.has(scope?.provider ?? "");
  const measured = generationConflict
    ? null
    : session.lookupOutput(session.sessionId, message.messageId, scope?.model ?? "", scope?.provider ?? "");
  const generationOutputTokens = measured?.outputTokens ?? null;
  const generationDurationMs = measured?.durationMs ?? null;
  const generationWindowStartMs = generationConflict
    ? null
    : officialAllGeneration
      ? message.generation.allGenerationWindowStartMs
      : message.generation.windowStartMs;
  const generationWindowEndMs = generationConflict
    ? null
    : officialAllGeneration
      ? message.generation.allGenerationWindowEndMs
      : message.generation.windowEndMs;
  const finishKind = message.generation.finishKind;
  const finishFailed = finishKind === "error" || finishKind === "failed";
  const finishCancelled = finishKind === "aborted" || finishKind === "cancelled" || finishKind === "canceled";
  const lastMessageFrameIndex = group.messages[group.messages.length - 1].frameIndex;
  const terminalVerified = group.ends.some((entry) => entry.frameIndex > lastMessageFrameIndex);
  const status = finishFailed
    ? "failed"
    : finishCancelled
      ? "cancelled"
      : message.generation.successFinish || terminalVerified
        ? "completed"
        : "unverified";

  /** @type {Record<string, unknown>} */
  const raw = {
    sourceKind: "dsh",
    homeId: session.homeId,
    // 规范身份元组：['dsh', homeId, sessionId, turn, step]（turn 参与 → 跨 turn 的 step 重置不碰撞）。
    identity: [session.sessionId, group.turn, group.step],
    sessionId: session.sessionId,
    turn: group.turn,
    step: group.step,
    turnKey: String(group.turn),
    sourcePath: session.filePath,
    channel: session.channel,
    agentKind: session.agentKind,
    agent: session.agent,
    model: scope ? scope.model : "",
    modelProvider: scope ? scope.provider : "",
    reasoningEffort: scope ? scope.effort : "",
    // 名字类字段：无证据就是空串（M1.1 的 nameOrEmpty 口径），不写 "unknown"。
    modelEvidence: scope ? (scope.evidence ?? "request_scope") : "",
    recordConflict: generationConflict,
    modelAmbiguous,
    window: "request",
    timingKind: "generation",
    tokenScope: "visible_output_o200k_base",
    timingSource: measured ? "explicit" : "unknown",
    tsMs: message.time,
    windowStartMs: measured ? null : generationWindowStartMs,
    windowEndMs: measured ? null : generationWindowEndMs,
    durationMs: generationDurationMs,
    outputTokens: generationOutputTokens,
    status,
    reportedDurationMs,
    reportedOutputTokens: message.generation.reportedOutputTokens,
    reportedReasoningTokens: message.generation.reportedReasoningTokens,
    reportedStreamOutputTokens: message.generation.streamOutputTokens,
    usageParity: message.generation.usageParity,
    generationState: message.generation.streamState,
  };
  // 裁定 AU / D3：**此处刻意不写 `filterReason`**（"模型变了 / provider 变了"的细分）。
  // 理由见上方 `modelAmbiguous` 定义处的长注：`filterReason !== ""` 会被 M1 无条件映射为
  // `SOURCE_FILTERED`，即"来源侧失败"。一个模型歧义样本不该同时声称来源侧失败。
  // 细分需求若成立，应走 M1 独立位，而不是借这个通道。
  // 完整成功 stream 已决定 status；step/end 只为缺少 stream 终态的旧记录提供完成证据。
  if (terminalVerified) {
    raw.terminalVerified = true;
  }

  const normalized = normalizePerfSample(raw);
  if (!normalized.sample) {
    addWarning(normalized.warningCode ?? UNKEYABLE_RECORD_CODE, 1);
    return false;
  }
  await onSample(normalized.sample);
  return true;
}

/**
 * 逐条产出 DSH 的生成 TPS 候选。
 * @param {string} filePath 物理会话日志路径（`sourcePath` 的来源）
 * @param {{ id?: unknown, label?: unknown, path?: unknown } | string} source 源描述；`source.id` 是 `homeId`
 * @param {(sample: any) => Promise<void> | void} onSample 规范候选回调（按文件内出现顺序）
 * @param {{ onWarning?: (warning: { sourceKind: string, homeId: string, code: string, count: number }) => void }} [options]
 *        非致命诊断回调，形状固定为 `{sourceKind, homeId, code, count}`；坏帧/坏行使该文件 degraded
 * @returns {Promise<{ sampleCount: number, stepEndFrames: number, warnings: Array<{ sourceKind: string, homeId: string, code: string, count: number }> }>}
 */
export async function streamDshPerfSamples(filePath, source, onSample, { onWarning } = {}) {
  const homeId = typeof source === "string" ? source.trim() : trimmedText(source?.id);
  /** @type {Map<string, number>} */
  const warningCounts = new Map();
  /** @type {Map<string, number>} */
  const parserWarningCounts = new Map();
  /** @type {Map<string, number>} */
  const rowWarningCounts = new Map();
  const addTo = (counts, code, count = 1) => {
    if (typeof code !== "string" || code === "" || !Number.isSafeInteger(count) || count <= 0) {
      return;
    }
    counts.set(code, (counts.get(code) ?? 0) + count);
  };
  const addParserWarning = (code, count = 1) => addTo(parserWarningCounts, code, count);
  const addWarning = (code, count = 1) => addTo(rowWarningCounts, code, count);
  const mergeWarnings = () => {
    for (const counts of [parserWarningCounts, rowWarningCounts]) {
      for (const [code, count] of counts) {
        warningCounts.set(code, (warningCounts.get(code) ?? 0) + count);
      }
      counts.clear();
    }
  };
  const warningList = () =>
    [...warningCounts.entries()].map(([code, count]) => ({ sourceKind: "dsh", homeId, code, count }));
  const flushWarnings = () => {
    if (typeof onWarning !== "function") {
      return;
    }
    for (const warning of warningList()) {
      onWarning(warning);
    }
  };

  let header = null;
  let session = null;
  const scopeState = { pendingHeader: null, currentHeader: null, active: null };
  /**
   * 分组键用 JSON 元组（**不是**拼接分隔符）：键空间里没有任何字符串拼接，
   * 因此"分隔符可能出现在数据里"的碰撞问题不存在。
   * @type {Map<string, { turn: number, step: number, starts: any[], retryStarts: any[], messages: any[], ends: any[] }>}
   */
  const groups = new Map();
  const groupFor = (turn, step) => {
    const key = JSON.stringify([turn, step]);
    let group = groups.get(key);
    if (!group) {
      group = { turn, step, starts: [], retryStarts: [], messages: [], ends: [] };
      groups.set(key, group);
    }
    return group;
  };

  // 帧序**逐帧递增**：每条记录占一个序号（与 M0.3-返工 的判别式同序数口径）。
  let frameIndex = 0;
  let stepEndFrames = 0;
  const processRow = (row, currentFrameIndex) => {
    const type = typeof row?.type === "string" ? row.type : "";
    if (type === "request/header" || type === "request/context") {
      const config = row?.data?.header?.config;
      if (config && typeof config === "object") {
        // Scope is fixed per source/provider/model/effort. The effort key is read only to
        // prevent samples from one reviewed range being mixed with another.
        const header = {
          model: trimmedText(config.model),
          provider: trimmedText(config.provider),
          effort: trimmedText(config.reasoningEffort),
        };
        scopeState.pendingHeader = header;
        scopeState.currentHeader = header;
      }
      return;
    }
    if (type === "step/start") {
      const turn = identityInteger(row?.data?.turn);
      const step = identityInteger(row?.data?.step);
      if (turn === null || step === null) {
        addWarning(UNKEYABLE_RECORD_CODE, 1);
        return;
      }
      const scope = claimScope(scopeState, turn);
      groupFor(turn, step).starts.push({
        time: row?.time,
        model: scope.model,
        provider: scope.provider,
        effort: scope.effort,
        proven: scope.proven,
      });
      return;
    }
    if (type === "assistant/message") {
      const turn = identityInteger(row?.data?.turn);
      const step = identityInteger(row?.data?.step);
      if (turn === null || step === null) {
        addWarning(UNKEYABLE_RECORD_CODE, 1);
        return;
      }
      const requestScope = claimScope(scopeState, turn);
      const scope = messageSourceScope(row, turn, requestScope, scopeState.currentHeader) ?? requestScope;
      const generation = row?.data?.generation;
      groupFor(turn, step).messages.push({
        time: row?.time,
        messageId: row?.data?.message?.id,
        output: generation.reportedOutputTokens,
        reasoning: generation.reportedReasoningTokens,
        generation,
        model: scope.model,
        provider: scope.provider,
        effort: scope.effort,
        evidence: scope.evidence,
        proven: scope.proven,
        frameIndex: currentFrameIndex,
      });
      return;
    }
    if (type === RETRY_STARTED_TYPE) {
      const turn = identityInteger(row?.data?.turn);
      const step = identityInteger(row?.data?.step);
      if (turn === null || step === null) {
        addWarning(UNKEYABLE_RECORD_CODE, 1);
        return;
      }
      groupFor(turn, step).retryStarts.push({ time: row?.time, frameIndex: currentFrameIndex });
      return;
    }
    if (type === STEP_END_TYPE) {
      const turn = identityInteger(row?.data?.turn);
      const step = identityInteger(row?.data?.step);
      if (turn === null || step === null) {
        addWarning(UNKEYABLE_RECORD_CODE, 1);
        return;
      }
      stepEndFrames += 1;
      groupFor(turn, step).ends.push({ frameIndex: currentFrameIndex });
    }
    // 其余帧：只看了 `type` 判别式，不读 data/time。
  };

  // 第一遍只建立薄 header 并汇总 parser 诊断；晚到 header 不再把 header
  // 前的完整 raw row 留在数组中。第二遍从头投影，帧序仍覆盖每一条记录。
  for await (const row of streamDshSessionRows(filePath, {
    onWarning: (text) => {
      const matched = MALFORMED_JSON_PREFIX.exec(typeof text === "string" ? text : "");
      if (matched) {
        addParserWarning(MALFORMED_JSON_CODE, Number(matched[1]));
      } else {
        // `streamDshSessionRows` 只可能再发出帧级（损坏帧/空帧）告警。
        addParserWarning(MALFORMED_FRAME_CODE, 1);
      }
    },
    projectRow: (row) => (row?.type === "session" ? row : null),
  })) {
    if (header === null && row?.type === "session") {
      header = dshSessionHeader([row]);
    }
  }

  mergeWarnings();
  if (!header || header.id === "") {
    // 没有会话头就没有稳定身份：**不产出候选**（无 sessionId ⇒ 身份元组不成立），只记编码原因。
    addWarning(UNKEYABLE_RECORD_CODE, 1);
    mergeWarnings();
    flushWarnings();
    return { sampleCount: 0, stepEndFrames: 0, warnings: warningList() };
  }
  // 版本闸门必须**在投影之前**：非 v4 一律不按 v4 硬解（生产 `streamDshSessionEvents()`
  // 同口径；此时连帧都不看，因此 `stepEndFrames` 恒为 0）。
  if (header.version !== null && header.version !== DSH_SESSION_FORMAT_VERSION) {
    // 与生产 `streamDshSessionEvents()` 同口径：只拒绝**明确的**非 v4 版本。
    addWarning(UNSUPPORTED_SCHEMA_CODE, 1);
    mergeWarnings();
    flushWarnings();
    return { sampleCount: 0, stepEndFrames: 0, warnings: warningList() };
  }

  session = {
    homeId,
    sessionId: header.id,
    filePath,
    // `channel` 是 **perf 分组维度**（`perfGroupKey` 第 3 分量，`src/perf-stats.js:364-382`），
    // 与产品展示层的渠道标签是两回事：口径不一致会把同一来源拆成不同组；因此按裁定 AL-5
    // 冻结为**小写 kebab-case**（与 `sourceKind` 取值同形；zcode 已是 `zcode`/`zcode-subagent`）。
    // 旧值 `"DSH"` / `"DSH Subagent"`（含大写与空格）已废弃，不得回退。
    channel: header.delegationDepth > 0 ? "dsh-subagent" : "dsh",
    // 裁定 P：名与 kind 分离。delegationDepth > 0 是唯一可证的 subagent 证据；depth=0 一律 unknown。
    agentKind: header.delegationDepth > 0 ? "subagent" : "unknown",
    agent: header.agentPreset,
    lookupOutput: await readOutputObservations(filePath, "dsh"),
  };

  for await (const row of streamDshSessionRows(filePath, { projectRow: projectDshPerfRow })) {
    const currentFrameIndex = frameIndex;
    frameIndex += 1;
    processRow(row, currentFrameIndex);
  }

  let sampleCount = 0;
  for (const group of groups.values()) {
    if (await emitGroup(group, session, onSample, addWarning)) {
      sampleCount += 1;
    }
  }

  mergeWarnings();
  flushWarnings();
  return { sampleCount, stepEndFrames, warnings: warningList() };
}
