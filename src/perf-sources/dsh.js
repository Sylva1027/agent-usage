/**
 * M2.2 DSH（DeepSeek Harness）step 请求时窗 reader（只读）。
 *
 * 读一个物理会话日志（`session.v4.jsonl.zstd`，多帧拼接），用回调逐条输出
 * `normalizePerfSample()` 认可的标准候选。解压、坏帧告警与 v4 守护复用生产
 * `readDshSessionRows()`；本文件不碰任何生产写入路径。
 *
 * 投影**只访问**：
 * - `session` 头的 `id`/`version`/`delegationDepth`/`agentPreset`；
 * - `request/header`、`request/context` 的 `data.header.config.{model,provider}`；
 * - `step/start` 的 `data.{turn,step}` 与 `row.time`；
 * - `llm/retry-started` 的 `data.{turn,step}` 与 `row.time`（仅作最终尝试起点）；
 * - `assistant/message` 的 `data.{turn,step}`、`row.time`、`data.usage.outputTokens`；
 * - 步骤结束帧（裁定 G / M0.6 / task-24 裁定 (B)）**只取 `data.{turn,step}` 定位键与帧序**，
 *   它的 `row.time` 与 `data` 其余键**从不访问**。
 *
 * **不访问**：`data` 的流式载荷键、任何正文载体（message 文本等）、步骤结束帧的产物载荷与时间戳。
 * 产物只含规范候选与聚合计数/布尔/穷举枚举，不含正文；`sampleKey` 由规范元组序列化而来。
 *
 * 身份：`sampleKey = JSON.stringify(['dsh', homeId, sessionId, turn, step])` —— 逐帧 `(turn,step)`
 * 按键分组，且 turn 参与身份，因此**跨 turn 的 step 重置**与**两会话相同的 `(turn,step)`** 都不碰撞。
 *
 * 帧序：帧序号**逐帧递增**（每条记录一个序号）。这是"步骤结束帧严格晚于该组最后一条
 * assistant/message"的唯一依据；序号在循环内自增（M0.3 曾把自增写在循环外，导致同文件所有帧
 * 共用一个序号、正常完成的 step 永远进不了样本，参见 `handoffs/M0.3-返工.md`）。
 */
import { DSH_SESSION_FORMAT_VERSION, dshSessionHeader, readDshSessionRows } from "../dsh-usage.js";
import { PERF_EPOCH_MS_MIN, normalizePerfSample } from "../perf-stats.js";

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

function trimmedText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** 有限数（含 0/负数）：只用于时间差与帧序相关的算术，不做任何范围裁决。 */
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 端点观测时间的**单位闸门**（P1-2）。`true` = 与 `PERF_EPOCH_MS_MIN` 同单位（毫秒）。
 *
 * 依据 §3 第 7 条（绝对秒时间戳必须先转毫秒）与裁定 T（该阈值属方法元数据、可更新），
 * 复用 M1 的**同一常量**，避免把阈值复制成第二个漂移点。
 *
 * **为什么必须在 reader 侧做**：M1 对 `tsMs` 有单位闸门（秒级 ⇒ `timestamp_unit_unsupported`
 * ⇒ 位 15 `TIME_UNPLACED` ⇒ 不进 eligible），但**对 `durationMs` 没有单位闸门** —— 秒/毫秒
 * 混淆只会得到 `LONG_WINDOW`（位 4，**提示位、仍然进 sampled**）。实测证据：`durationMs =
 * 1789000000000` 时 M1 给出 `flags=["LONG_WINDOW"], reason="status_missing"`，即
 * **一个时长约 56 年的候选照样进 TPS**。因此 reader 必须自己判单位。
 *
 * 判据只用了"时间戳必须 ≥ `PERF_EPOCH_MS_MIN`"这一个**已冻结**的规则：
 * - 本世纪（≈2001-09-09T01:46:40Z 起）的真实 epoch 毫秒必然 ≥ 1e12；
 * - 秒级出现在 `1e9` 量级，与 `1e12` 差三个数量级；
 * - 日志内以**纳秒/微秒**为单位时 `1e12` 对应 1970-01-01T00:16:40Z（早于任何会话），
 *   与本世纪的真实时间戳同时出现即说明两单位不同。
 *
 * **只翻转单位标记，绝不换算**（不乘 1000、不改写原值）：换算会凭空造出一个未曾观测的时刻。
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
  return `${valueTag(entry.time)}|${valueTag(entry.output)}`;
}

/**
 * 单会话内的请求作用域追踪（裁定 P / M2.2 要求 3）。
 *
 * `request/header|context` **开启**一个请求作用域；它归**随后第一条**带 `(turn,step)` 的帧所有。
 * 同一 turn 内的后续帧复用已开启的作用域；**新 turn 而没有新 header 时，作用域是空模型**
 * —— 绝不把上一轮的模型套到无 header 的下一请求（M0 未证明 header 作用域时 model 留空）。
 * @param {{ pendingHeader: {model: string, provider: string} | null, active: {turn: number, model: string, provider: string, proven: boolean} | null }} state
 * @param {number} turn
 */
function claimScope(state, turn) {
  if (state.pendingHeader) {
    state.active = {
      turn,
      model: state.pendingHeader.model,
      provider: state.pendingHeader.provider,
      proven: true,
    };
    state.pendingHeader = null;
    return state.active;
  }
  if (state.active && state.active.turn === turn) {
    return state.active;
  }
  state.active = { turn, model: "", provider: "", proven: false };
  return state.active;
}

/**
 * 输出一条规范候选。返回 `true` 表示已通过 `normalizePerfSample()` 并交给 `onSample`。
 * @param {any} group
 * @param {{ homeId: string, sessionId: string, filePath: string, channel: string, agentKind: string, agent: string }} session
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
  // M1 的 `MODEL_AMBIGUOUS` 只有**一个位**，因此 model 或 provider 任一不一致都置位。
  //
  // ⚠️ **裁定 AU / D3（拒绝）**：本 reader **不得**为"模型变了还是 provider 变了"写 `filterReason`。
  // 实测依据（Lead，`perf-stats.js:804-806`）：**只要 `filterReason !== ""` 就必置 `SOURCE_FILTERED`，
  // 无任何豁免**。而 `SOURCE_FILTERED` 的语义是"**来源侧**失败/取消/重试"，不是"同 step 内模型歧义"。
  // 借用该通道会让一个**模型歧义**样本同时声称"来源侧失败" —— **制造一条不成立的因果**，
  // 恰是 P1-3 所修缺陷的**镜像**（P1-3 是"该报的没报"，借道是"报了不该报的"）。
  // 若确需细分，正确路径是在 M1 **增加独立位**，不得借用 `filterReason`。
  const modelAmbiguous = modelValues.size > 1 || providerValues.size > 1;

  // ---- P1-2：时长既要求两端可算，也要求**两端单位一致**（P1-2 判别式，见 `isEpochMsUnit`）。
  // 单位不一致时**保留候选**、`durationMs` 保持 `null`，并把两个原值端点交给 M1 的单位闸门
  // （见下方 `windowStartMs`/`windowEndMs` 赋值处，那里列出实测否决的两条路）。
  // 绝不把混合单位相减的结果交给 M1 —— 那会得到 `LONG_WINDOW`（提示位、仍进 TPS）。
  // 判别式把所有"两端都可算"与"单位一致"拆成正交两轴，因此 `null`/缺 start 一律走
  // `MISSING_DURATION`，只有"两值都在、单位不同"才走 `TIME_INVALID`。
  const startTime = start ? finiteNumber(start.time) : null;
  const messageTime = finiteNumber(message.time);
  // 缺 start 时 `startUnitOk` 必为 false，但那是**量级缺失**、不是**单位混淆**：必须靠
  // `startTime !== null && messageTime !== null` 把这两个情形分开，否则"缺 start"会被
  // 误报成 `TIME_INVALID`（实测过：缺 start 的候选一度得到 `timingSource='mixed'`）。
  const unitMismatch =
    startTime !== null && messageTime !== null && isEpochMsUnit(startTime) !== isEpochMsUnit(messageTime);
  const unitsComparable = isEpochMsUnit(startTime) && isEpochMsUnit(messageTime);
  const durationMs =
    start && unitsComparable && startTime !== null && messageTime !== null ? messageTime - startTime : null;

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
    // 名字类字段：无证据就是空串（M1.1 的 nameOrEmpty 口径），不写 "unknown"。
    modelEvidence: scope ? "request_scope" : "",
    recordConflict,
    modelAmbiguous,
    tsMs: message.time,
    durationMs,
    outputTokens: message.output,
  };
  if (durationMs !== null) {
    raw.timingSource = "timestamp_fallback";
  } else if (unitMismatch) {
    // P1-2：把**未经换算的原值端点**交给 M1 自己的时间单位闸门，由它置 `TIME_INVALID`
    // （实测 `window_start_unit_unsupported`，位 14、在扣除集内）。
    // ⚠️ 实测否决的两条路：① 直接传 `durationMs = ` 混合相减结果 ⇒ 只得到 `LONG_WINDOW`
    // （提示位、仍进 TPS）；② 只传 `timingSource:'mixed'` ⇒ M1 对 `timingSource` **没有**任何
    // 时间位映射，仍只有 `MISSING_DURATION`。窗口键是 M1 唯一会据**单位**判非法的入参。
    raw.windowStartMs = startTime;
    raw.windowEndMs = messageTime;
  }
  // 裁定 AU / D3：**此处刻意不写 `filterReason`**（"模型变了 / provider 变了"的细分）。
  // 理由见上方 `modelAmbiguous` 定义处的长注：`filterReason !== ""` 会被 M1 无条件映射为
  // `SOURCE_FILTERED`，即"来源侧失败"。一个模型歧义样本不该同时声称来源侧失败。
  // 细分需求若成立，应走 M1 独立位，而不是借这个通道。
  // 终态证据（裁定 G / task-24 裁定 (B)）：**当且仅当**本组存在严格晚于最后一条
  // assistant/message 的步骤结束帧。绝不用 message 本身推断完成（§17.4 位 10）。
  const lastMessageFrameIndex = group.messages[group.messages.length - 1].frameIndex;
  const terminalVerified = group.ends.some((entry) => entry.frameIndex > lastMessageFrameIndex);
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
 * 逐条产出 DSH 的 step 请求时窗候选。
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
  const addWarning = (code, count = 1) => {
    if (typeof code !== "string" || code === "" || !Number.isSafeInteger(count) || count <= 0) {
      return;
    }
    warningCounts.set(code, (warningCounts.get(code) ?? 0) + count);
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

  const rows = await readDshSessionRows(filePath, {
    onWarning: (text) => {
      const matched = MALFORMED_JSON_PREFIX.exec(typeof text === "string" ? text : "");
      if (matched) {
        addWarning(MALFORMED_JSON_CODE, Number(matched[1]));
      } else {
        // `readDshSessionRows` 只可能再发出帧级（损坏帧/空帧）告警。
        addWarning(MALFORMED_FRAME_CODE, 1);
      }
    },
  });

  const header = dshSessionHeader(rows);
  if (!header || header.id === "") {
    // 没有会话头就没有稳定身份：**不产出候选**（无 sessionId ⇒ 身份元组不成立），只记编码原因。
    addWarning(UNKEYABLE_RECORD_CODE, 1);
    flushWarnings();
    return { sampleCount: 0, stepEndFrames: 0, warnings: warningList() };
  }
  // 版本闸门必须**在投影之前**：非 v4 一律不按 v4 硬解（生产 `streamDshSessionEvents()`
  // 同口径；此时连帧都不看，因此 `stepEndFrames` 恒为 0）。
  if (header.version !== null && header.version !== DSH_SESSION_FORMAT_VERSION) {
    // 与生产 `streamDshSessionEvents()` 同口径：只拒绝**明确的**非 v4 版本。
    addWarning(UNSUPPORTED_SCHEMA_CODE, 1);
    flushWarnings();
    return { sampleCount: 0, stepEndFrames: 0, warnings: warningList() };
  }

  const session = {
    homeId,
    sessionId: header.id,
    filePath,
    // `channel` 是 **perf 分组维度**（`perfGroupKey` 第 3 分量，`src/perf-stats.js:364-382`），
    // 与产品展示层的渠道标签是两回事：口径不一致会把同一来源拆成不同组，因此按裁定 AL-5
    // 冻结为**小写 kebab-case**（与 `sourceKind` 取值同形；zcode 已是 `zcode`/`zcode-subagent`）。
    // 旧值 `"DSH"` / `"DSH Subagent"`（含大写与空格）已废弃，不得回退。
    channel: header.delegationDepth > 0 ? "dsh-subagent" : "dsh",
    // 裁定 P：名与 kind 分离。delegationDepth > 0 是唯一可证的 subagent 证据；depth=0 一律 unknown。
    agentKind: header.delegationDepth > 0 ? "subagent" : "unknown",
    agent: header.agentPreset,
  };

  const scopeState = { pendingHeader: null, active: null };
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
  for (const row of rows) {
    const currentFrameIndex = frameIndex;
    frameIndex += 1;
    const type = typeof row?.type === "string" ? row.type : "";
    if (type === "request/header" || type === "request/context") {
      const config = row?.data?.header?.config;
      if (config && typeof config === "object") {
        // 只取两个名字键；config 其余键（effort 等）一律不读。
        scopeState.pendingHeader = {
          model: trimmedText(config.model),
          provider: trimmedText(config.provider),
        };
      }
      continue;
    }
    if (type === "step/start") {
      const turn = identityInteger(row?.data?.turn);
      const step = identityInteger(row?.data?.step);
      if (turn === null || step === null) {
        addWarning(UNKEYABLE_RECORD_CODE, 1);
        continue;
      }
      const scope = claimScope(scopeState, turn);
      groupFor(turn, step).starts.push({
        time: row?.time,
        model: scope.model,
        provider: scope.provider,
        proven: scope.proven,
      });
      continue;
    }
    if (type === "assistant/message") {
      const turn = identityInteger(row?.data?.turn);
      const step = identityInteger(row?.data?.step);
      if (turn === null || step === null) {
        addWarning(UNKEYABLE_RECORD_CODE, 1);
        continue;
      }
      const scope = claimScope(scopeState, turn);
      const usage = row?.data?.usage;
      // 只取 `outputTokens` **原值**（缺 → undefined）；input/cache/total 一概不读。
      const output = usage && typeof usage === "object" ? usage.outputTokens : undefined;
      groupFor(turn, step).messages.push({
        time: row?.time,
        output,
        model: scope.model,
        provider: scope.provider,
        proven: scope.proven,
        frameIndex: currentFrameIndex,
      });
      continue;
    }
    if (type === RETRY_STARTED_TYPE) {
      const turn = identityInteger(row?.data?.turn);
      const step = identityInteger(row?.data?.step);
      if (turn === null || step === null) {
        addWarning(UNKEYABLE_RECORD_CODE, 1);
        continue;
      }
      groupFor(turn, step).retryStarts.push({ time: row?.time, frameIndex: currentFrameIndex });
      continue;
    }
    if (type === STEP_END_TYPE) {
      const turn = identityInteger(row?.data?.turn);
      const step = identityInteger(row?.data?.step);
      if (turn === null || step === null) {
        addWarning(UNKEYABLE_RECORD_CODE, 1);
        continue;
      }
      stepEndFrames += 1;
      groupFor(turn, step).ends.push({ frameIndex: currentFrameIndex });
    }
    // 其余帧：只看了 `type` 判别式，不读 data/time。
  }

  let sampleCount = 0;
  for (const group of groups.values()) {
    if (await emitGroup(group, session, onSample, addWarning)) {
      sampleCount += 1;
    }
  }

  flushWarnings();
  return { sampleCount, stepEndFrames, warnings: warningList() };
}
