// M2.3：OpenCode v2 assistant 消息 reader（生产侧，单物理文件）。
//
// 权威依据：
// - 方案 `docs/plans/2026-10-03-model-latency-throughput-plan.md` §17.1:197-205（OpenCode 行）、§17.4、§17.5、§17.6
// - 冻结契约 `docs/validation/2026-10-04-perf-metrics/20261004T035100/source-contract.md`
//   §1.3（OpenCode 已确认事实）、§2-E（sampled 扣除集）、§2-F（TERMINAL_UNVERIFIED 产生条件）、§3（跨源共性口径 10 条）
// - 详细卡 `docs/plans/2026-10-04-model-tps-implementation/M2-source-readers.md` M2.3 节
//
// 分工：本 reader 输出 **raw 候选**（`PerfSampleRaw` 形状），由集成层调用 M1 的
// `normalizePerfSample()` 归一化。reader 不做 `unknown`→`""` 归一、不置 §17.4 位、不做去重/冲突/覆盖统计。
//
// 硬性约束（违反即越界）：
// 1. 只读打开（`DatabaseSync(..., {readOnly:true})`），**绝不回退可写**。有意**不复用**产品
//    `openOpencodeDatabase()`：它在崩溃残留 WAL 时退回普通打开，与本卡的只读纪律冲突。
// 2. **绝不 `SELECT data` 整串**：SQL 只投影普通列 + JSON **标量**，`OPENCODE_PERF_JSON_PATHS` 是唯一白名单。
//    `$.time.streamed`、`$.model.variant`、`$.content`、`item_json` 永不进入 SQL。
// 3. 坏 JSON 行**不中断整库**：主扫描用 `json_valid(m.data) = 1` 过滤，坏行另用计数查询记 `MALFORMED_JSON`。
//    每个 JSON 调用都包在 `CASE WHEN json_valid(m.data) = 1 ...` 里，因为 SQLite **不保证** WHERE 先于结果列求值。
// 4. `durationMs = completed - created`（两者均须存在）；**绝不使用 streamed**（它是 epoch 毫秒时间戳，不是布尔）。
// 5. `outputTokens` 只在 output 与 reasoning **各自已知**时相加；缺任一项 → `null`（不是 0）。
// 6. `data.agent` 只证明名称 → `agentKind='unknown'`；variant/effort/provider **缺证据不从当前配置回填**。
// 7. **未验证路径不投影**（裁定 AL-4）：`inputTokens` 仅为诊断（§17.1:200 自己标注"（诊断）"）、M1 内核
//    **不消费**它（不参与任何计数/比率，`perfGroupKey` 十个分量里没有它），而 `$.tokens.input` /
//    `$.tokens.cache.read` / `$.tokens.cache.write` **未经 M0 验证**（M0 只验了 `output`/`reasoning`）
//    ⇒ 三者不进入 SQL，`inputTokens` 恒为 `null`（§3 第 6 条同源原则：未验证的来源字段不得投影）。
//
// 本机（2026-10-04）只读侦察（`~/.local/share/opencode/opencode.db`，529 条 assistant 行）：
//   `$.finish` 只出现 3 个字面量：`tool-calls`(471)、`stop`(55)、`error`(3)；`$.error` 只在 error 行存在；
//   3 条 error 行**完全没有 `$.tokens`**；`$.time.completed` 与 `$.finish` 在全部 529 行都存在（本机无未收尾样本）；
//   `session_message.id` 是 TEXT 主键、全局唯一；5 个 token 路径在 526 行全是 `json_type='integer'`。
//   因此 cancelled / 未收尾两档在本机**不可观测**，只由合成夹具覆盖。

import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import { perfSampleKey } from "../perf-stats.js";

/** §17.1:195 的规范来源名。 */
export const OPENCODE_SOURCE_KIND = "opencode";

/**
 * perf 分组维度上的 `channel` 默认值（裁定 AL-5 冻结为**小写 kebab-case**，与 `sourceKind` 取值同风格）。
 *
 * ⚠️ **不要与产品/看板展示层的渠道标签混淆**：`src/opencode-usage.js` 里的 `channel: "OpenCode"`
 * 是**展示层**口径；本常量是 `perfGroupKey()`（`src/perf-stats.js:364-382`）的**第 3 个分组分量**，
 * 大小写不同会把同一来源的样本拆成两个统计组。`source.channel` 仍可覆盖（集成层若要区分子代理形态，
 * 应传 `"opencode-subagent"` 这类小写 kebab 值，而不是跟随展示层）。
 */
export const OPENCODE_CHANNEL = "opencode";

/** 只统计 assistant 消息行（§17.1:199 的 message 时窗）。 */
export const OPENCODE_ASSISTANT_TYPE = "assistant";

/**
 * `session_message` 必需列，与产品 `SESSION_MESSAGE_REQUIRED_COLUMNS` 逐字一致。
 * 缺列说明 schema 又变了：整文件按致命 `UNSUPPORTED_SCHEMA` 抛出，由集成层标 degraded。
 */
export const OPENCODE_MINIMUM_COLUMNS = Object.freeze(["id", "session_id", "type", "seq", "time_created", "data"]);

/** 只支持 v2 语义（output 为可见输出、不含 reasoning）；v1 折叠会重复计数。 */
export const OPENCODE_SUPPORTED_SESSION_MAJOR = 2;

/** 已证**完成**终态字面量（本机实测字面量）。 */
export const OPENCODE_FINISH_COMPLETED = Object.freeze(["stop", "tool-calls"]);

/** 已证**失败**终态字面量（本机实测：与 `$.error` 对象同时出现）。 */
export const OPENCODE_FINISH_FAILED = Object.freeze(["error"]);

/**
 * SQL 里唯一允许出现的 JSON 路径（顺序 = SELECT 顺序）。
 * 测试用「从 SQL 文本抽出的路径集合 === 本数组」双向锁定，任何一侧漂移都会红。
 *
 * **不含**输入侧三路径（`$.tokens.input` / `cache.read` / `cache.write`）：裁定 AL-4 判为越界，
 * 见文件头约束 7。也不含 `$.time.streamed` / `$.model.variant` / `$.content`。
 */
export const OPENCODE_PERF_JSON_PATHS = Object.freeze([
  "$.time.created",
  "$.time.completed",
  "$.tokens.output",
  "$.tokens.reasoning",
  "$.model.id",
  "$.model.providerID",
  "$.agent",
  "$.finish",
  "$.error",
]);

/**
 * JSON 标量闸门：只接受 text/integer/real。
 *
 * 为什么必须显式闸门：SQLite 的 `json_extract` 会把 JSON `true`/`false` **洗成 1/0**，
 * 把对象/数组洗成 JSON 文本。那样 `tokens.output: true` 会冒充"1 个 token"（本机实测确认），
 * 对象型 `model.id` 会冒充一个模型名。这里让非标量一律变 NULL，再由 M1 归类为 MISSING_*。
 * `$.error` 只取 `json_type`（存在性与类型），**从不读取它的值**（错误正文不属于本投影）。
 */
const SCALAR_GATE = "json_type(m.data, '%s') IN ('text','integer','real')";

/**
 * 依次替换 `%s`：`json_valid` 外层 CASE 是必需的——SQLite 不保证 WHERE 先于结果列求值，
 * 坏 JSON 行若先被求值会直接抛 `malformed JSON` 并中断整库。
 * @param {string} alias
 * @param {string} jsonPath
 * @returns {string}
 */
function scalarColumn(alias, jsonPath) {
  const gate = SCALAR_GATE.replace("%s", jsonPath);
  return [
    `       CASE WHEN json_valid(m.data) = 1 THEN`,
    `         CASE WHEN ${gate} THEN json_extract(m.data, '${jsonPath}') END`,
    `       END AS ${alias}`,
  ].join("\n");
}

/**
 * 冻结的主扫描 SQL：**只投影普通列与 JSON 标量**。
 * - `m.data` 只作为 `json_valid` / `json_type` / `json_extract` 的实参出现；
 * - `WHERE m.type = 'assistant' AND json_valid(m.data) = 1`：只取有效 JSON 的 assistant 行；
 * - `ORDER BY m.time_created, m.seq, m.id`：稳定迭代（`seq` 只用于排序，**不作身份**，§17.1:205）。
 * @returns {string}
 */
export function buildOpencodePerfSql() {
  return [
    "SELECT m.id AS message_id,",
    "       m.session_id AS session_id,",
    "       m.seq AS seq,",
    `${scalarColumn("created_ms", "$.time.created")},`,
    `${scalarColumn("completed_ms", "$.time.completed")},`,
    `${scalarColumn("output_tokens", "$.tokens.output")},`,
    `${scalarColumn("reasoning_tokens", "$.tokens.reasoning")},`,
    `${scalarColumn("model_id", "$.model.id")},`,
    `${scalarColumn("provider_id", "$.model.providerID")},`,
    `${scalarColumn("agent_name", "$.agent")},`,
    `${scalarColumn("finish_text", "$.finish")},`,
    "       CASE WHEN json_valid(m.data) = 1 THEN json_type(m.data, '$.error') END AS error_type",
    "  FROM session_message AS m",
    " WHERE m.type = 'assistant' AND json_valid(m.data) = 1",
    " ORDER BY m.time_created, m.seq, m.id",
  ].join("\n");
}

/**
 * 坏 JSON 行计数（**独立查询**，不进入主扫描）。
 *
 * `json_valid(x) IS NOT 1` 而不是 `<> 1`：本机实测 `json_valid(NULL)` 返回 NULL，
 * 而 `NULL <> 1` 是 NULL（不为真），会把 NULL `data` 行**漏计**。`IS NOT 1` 同时覆盖坏 JSON 与 NULL。
 * 只统计 assistant 行——非 assistant 行不会成为候选，与本投影无关。
 * @returns {string}
 */
export function buildOpencodeMalformedCountSql() {
  return [
    "SELECT count(*) AS malformed_rows FROM session_message",
    ` WHERE type = '${OPENCODE_ASSISTANT_TYPE}' AND json_valid(data) IS NOT 1`,
  ].join("\n");
}

/** `session_v2` 版本查询（表/列缺失时**非致命**：按未知版本放行并告警）。 */
export const OPENCODE_SESSION_VERSION_SQL = "SELECT id, version FROM session_v2";

/**
 * 致命读取错误：只读打开失败或 schema 不受支持。
 *
 * 集成层据 `code` 归入冻结的 `sourceWarnings` 码域（`READ_ONLY_OPEN_FAILED` / `UNSUPPORTED_SCHEMA`）
 * 并把该 home 标 degraded。`message` 已剔除原始库路径（§3 第 10 条：产物不含会话路径）。
 */
export class OpencodePerfReadError extends Error {
  /**
   * @param {"READ_ONLY_OPEN_FAILED" | "UNSUPPORTED_SCHEMA"} code
   * @param {string} message
   * @param {{homeId?: string, cause?: unknown}} [details]
   */
  constructor(code, message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "OpencodePerfReadError";
    this.code = code;
    this.sourceKind = OPENCODE_SOURCE_KIND;
    this.homeId = details.homeId ?? "";
  }
}

/**
 * 语义版本只解析**主版本**（与产品 `sessionVersionMajor()` 逐字一致）：
 * 不做数字比较、不做字典序比较，无法解析一律 `null`（= 未知档）。
 * @param {unknown} version
 * @returns {number | null}
 */
export function sessionVersionMajor(version) {
  const text = String(version ?? "").trim();
  if (text === "") return null;
  const major = Number(text.split(".")[0]);
  return Number.isInteger(major) && major >= 0 ? major : null;
}

/**
 * 规范数据库身份 = 解析后的绝对路径（Windows 下折叠大小写：同一个库不能有两个身份）。
 * 路径**只进入身份元组**，不写报告（§3 第 10 条）。
 * @param {unknown} dbFile
 * @returns {string}
 */
export function canonicalOpencodeDatabaseIdentity(dbFile) {
  if (typeof dbFile !== "string" || dbFile.trim() === "") return "";
  const resolved = path.resolve(dbFile.trim());
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function trimmedText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 时长（毫秒）= `completed − created`，**两者均须存在**（§17.1:198）。
 *
 * 任一侧缺失、非数值（含 JSON 文本/none）→ `null`，**绝不把缺失当 0**。
 * 负数/非整数照原样返回：时序矛盾与非法值由 M1 的 `DURATION_NONPOSITIVE` / `TIME_INVALID` 归类，
 * reader 不在这里吞掉证据。**绝不使用 `$.time.streamed`**（它是 epoch 毫秒时间戳，不是结束证据）。
 * @param {unknown} created
 * @param {unknown} completed
 * @returns {number | null}
 */
export function resolveOpencodeDuration(created, completed) {
  if (!isFiniteNumber(created) || !isFiniteNumber(completed)) return null;
  return /** @type {number} */ (completed) - /** @type {number} */ (created);
}

/**
 * 定位时间戳：优先 `completed`，其为空/非法时才用 `created`（§17.1:201「缺时长候选可用 created 定位诊断」）。
 * 只有正有限数才可用：0/负数由 M1 归为 `out_of_range`，不能顶替一个可用的定位值。
 * @param {unknown} created
 * @param {unknown} completed
 * @returns {number | null}
 */
export function resolveOpencodeTsMs(created, completed) {
  for (const candidate of [completed, created]) {
    if (isFiniteNumber(candidate) && /** @type {number} */ (candidate) > 0) return /** @type {number} */ (candidate);
  }
  return null;
}

/**
 * 总输出 = `output + reasoning`，**仅当两者各自已知且各自合法**（§17.1:199；契约 §1.3「合计规则」+ §3 第 5 条）。
 *
 * 「已知」= 有限数。任一侧缺失/非数值 → `null`（合计未知），**绝不把缺项当 0**；
 * 本来源真实存在的「`$.tokens` 整体缺失」正是 `MISSING_OUTPUT`，与"真 0"是两回事。
 *
 * **P1-2/1 修复（先校验、后相加）**：非法分量**不再借相加洗白**。实测过的三种洗白路径：
 * | 输入 | 修复前 | 修复前 M1 看到 | 修复后 |
 * | --- | --- | --- | --- |
 * | `-5 + 5` | `0` | `OUTPUT_ZERO`（**冒用合法数据的诊断标签**） | `-5` ⇒ `TOKEN_INVALID` |
 * | `10 + (-1)` | `9` | 无标记、进 TPS | `-1` ⇒ `TOKEN_INVALID` |
 * | `1.5 + 0.5` | `2` | 小数凑成合法整数、进 TPS | `1.5` ⇒ `TOKEN_INVALID` |
 *
 * 因此本函数**把第一个非法分量原样返回**：它是**非负安全整数**之外的真值，M1 会据它产出
 * `TOKEN_INVALID`（位 17，在扣除集内）并给出细分原因（`output_negative` / `output_not_integer` /
 * `output_not_safe_integer`）。**保留候选、保留原值、保留诊断** —— 绝不用 `null` 假装字段缺失，
 * 也绝不因发现异常就丢弃候选（那会让异常数据"从统计里消失"，看起来干净，实则丢失诊断信息）。
 *
 * `reasoning` 的**真 0 必须仍可解析**：0 是合法非负安全整数，不落入非法分支。
 * @param {unknown} output
 * @param {unknown} reasoning
 * @returns {number | null}
 */
export function combineOpencodeOutputTokens(output, reasoning) {
  if (!isFiniteNumber(output) || !isFiniteNumber(reasoning)) return null;
  const outputNumber = /** @type {number} */ (output);
  const reasoningNumber = /** @type {number} */ (reasoning);
  // 先分别验证每个分量为**非负安全整数**：任一非法就把它原样交给 M1 归类，绝不参与相加。
  if (!isSafeNonNegativeInteger(outputNumber)) return outputNumber;
  if (!isSafeNonNegativeInteger(reasoningNumber)) return reasoningNumber;
  const total = outputNumber + reasoningNumber;
  // ⚠️ **如实说明（2026-10-05，裁定 AY）**：下面这个分支**没有判别力** —— 两个路径都返回 `total`，
  // 与曾写过的 `isSafeNonNegativeInteger(total) ? total : total` **在全部输入上等价**。
  //
  // 用户复现 + Lead 核实：对当前写法施加"退回 no-op"变异 ⇒ **60/60、exit 0**（无操作变异）。
  // 该结论已撤回，**不得**再声称"本分支是承重改动"。
  //
  // **为何不改成一个真正有判别力的形态**：越界合计**由 M1 独立拦下**（实测 `9e15+9e15` /
  // `MAX_SAFE+MAX_SAFE` / `MAX_SAFE+1` **全部正确标 `TOKEN_INVALID`**）⇒ M1 已能归类，
  // reader 侧**不需要**再造哨兵值，改了反而**改变本函数的返回契约**（`number | null`）。
  // ⇒ **不为让变异转红而改产品**。保留此处仅为"相加后的值仍原样交给 M1"这一语义的自文档化。
  if (!isSafeNonNegativeInteger(total)) return total;
  return total;
}

/**
 * 非负安全整数：`TOKEN_INVALID` 的 reader 侧判别式（与 M1 `classifyInteger` 的
 * `not_number`/`not_integer`/`unsafe`/`negative` 分支同口径）。
 * @param {number} value
 * @returns {boolean}
 */
function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * 终态判定（§17.4 位 10 / §2-F 判据 2 / §17.1:222）。
 *
 * - `$.finish` 是**已核实的终态载体**（契约 §1.3）：`stop`/`tool-calls` → `completed`；
 *   `error`（或存在 `$.error` 对象）→ `failed` + `sourceFiltered`（M1 会据此置 `SOURCE_FILTERED`）。
 * - **无终态证据**（`finish` 缺失）→ `unverified`（M1 置 `TERMINAL_UNVERIFIED`）。
 * - **未识别字面量**（既不在完成集也不在失败集）→ 同样 `unverified`，且 `recognized=false` 供上层告警：
 *   本机全库只观测到 3 个字面量，出现第 4 个说明语义漂移，"语义不确定时不得给精确排名"。
 * - `cancelled` **不可达**：本来源**没有**任何取消证据（无取消列、无取消字面量），
 *   所以这里绝不把 `cancelled` 当作可能值——宁可为 `unverified`，也不伪造取消。
 * - `in_progress` 同样不可达：没有"明确进行中"的证据（§6.3：不可区分的两态不得只选一边）。
 * @param {unknown} finishText
 * @param {unknown} errorType `json_type(m.data,'$.error')` 的结果（或 null）
 * @returns {{status: "completed" | "failed" | "unverified", terminalVerified: boolean,
 *   sourceFiltered: boolean, filterReason: string, recognized: boolean}}
 */
export function classifyOpencodeTerminal(finishText, errorType) {
  const finish = trimmedText(finishText);
  const errorPresent = typeof errorType === "string" && errorType !== "null" && errorType !== "";
  if (finish === "" && !errorPresent) {
    return { status: "unverified", terminalVerified: false, sourceFiltered: false, filterReason: "", recognized: true };
  }
  if (OPENCODE_FINISH_FAILED.includes(finish) || errorPresent) {
    return {
      status: "failed",
      terminalVerified: true,
      sourceFiltered: true,
      filterReason: "source_failed",
      recognized: true,
    };
  }
  if (OPENCODE_FINISH_COMPLETED.includes(finish)) {
    return { status: "completed", terminalVerified: true, sourceFiltered: false, filterReason: "", recognized: true };
  }
  // 未识别字面量：不猜、不映射，交由 TERMINAL_UNVERIFIED 扣除。
  return {
    status: "unverified",
    terminalVerified: false,
    sourceFiltered: false,
    filterReason: "",
    recognized: false,
  };
}

/**
 * 代码单元比较（契约 AE-2：确定性排序禁用 `localeCompare`）。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareCodeUnits(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * 剔除驱动消息里的原始库路径（§3 第 10 条：产物不含会话路径）。
 * @param {unknown} error
 * @param {string} dbFile
 * @returns {string}
 */
function describeDriverError(error, dbFile) {
  const raw = error instanceof Error ? error.message : String(error);
  const secrets = [dbFile, canonicalOpencodeDatabaseIdentity(dbFile), path.dirname(dbFile)];
  let text = raw;
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("<db>");
  }
  return text;
}

/**
 * 只读打开 + **惰性打开的可读性探测**。
 *
 * SQLite 的打开是惰性的：非 SQLite 文件要到第一条语句才报错。因此"打不开"分两处捕获，
 * 都归 `READ_ONLY_OPEN_FAILED`——**绝不**像产品适配器那样退回可写打开。
 * @param {unknown} dbFile
 * @param {string} homeId
 * @returns {DatabaseSync}
 */
function openOpencodeDatabaseReadOnly(dbFile, homeId) {
  if (typeof dbFile !== "string" || dbFile.trim() === "") {
    throw new OpencodePerfReadError("READ_ONLY_OPEN_FAILED", "opencode 数据库路径为空", { homeId });
  }
  /** @type {DatabaseSync} */
  let database;
  try {
    database = new DatabaseSync(dbFile, { readOnly: true });
  } catch (error) {
    throw new OpencodePerfReadError(
      "READ_ONLY_OPEN_FAILED",
      `opencode 数据库只读打开失败：${describeDriverError(error, dbFile)}`,
      { homeId, cause: error },
    );
  }
  try {
    database.prepare("SELECT count(*) AS tables FROM sqlite_master").all();
  } catch (error) {
    try {
      database.close();
    } catch {
      // 关闭失败无需上报：原始失败原因更重要。
    }
    throw new OpencodePerfReadError(
      "READ_ONLY_OPEN_FAILED",
      `opencode 数据库只读读取失败：${describeDriverError(error, dbFile)}`,
      { homeId, cause: error },
    );
  }
  return database;
}

/**
 * `session_message` 必需列守护（先于任何行迭代）。
 * @param {DatabaseSync} database
 * @param {string} homeId
 * @param {string} dbFile
 */
function assertSessionMessageColumns(database, homeId, dbFile) {
  let columns;
  try {
    columns = database
      .prepare('PRAGMA table_info("session_message")')
      .all()
      .map((column) => String(/** @type {Record<string, unknown>} */ (column).name));
  } catch (error) {
    throw new OpencodePerfReadError(
      "UNSUPPORTED_SCHEMA",
      `无法读取 opencode 会话表结构：${describeDriverError(error, dbFile)}`,
      { homeId, cause: error },
    );
  }
  const missing = OPENCODE_MINIMUM_COLUMNS.filter((column) => !columns.includes(column));
  if (missing.length > 0) {
    throw new OpencodePerfReadError("UNSUPPORTED_SCHEMA", `opencode 会话表缺少必需列：${missing.join(", ")}`, {
      homeId,
    });
  }
}

/**
 * 读取会话版本表。表或 `version` 列不可用时返回 `null`（**非致命**）：
 * 版本证据缺失 ⇒ 全部行按"未知版本"放行并告警（现行 adapter 的「放行+警告」策略）。
 * @param {DatabaseSync} database
 * @returns {Map<string, number | null> | null}
 */
function readSessionVersions(database) {
  try {
    /** @type {Map<string, number | null>} */
    const versions = new Map();
    for (const row of database.prepare(OPENCODE_SESSION_VERSION_SQL).all()) {
      const record = /** @type {Record<string, unknown>} */ (row);
      versions.set(String(record.id ?? "").trim(), sessionVersionMajor(record.version));
    }
    return versions;
  } catch {
    return null;
  }
}

/**
 * @param {DatabaseSync} database
 * @returns {number}
 */
function countMalformedAssistantRows(database) {
  try {
    const row = /** @type {Record<string, unknown>} */ (database.prepare(buildOpencodeMalformedCountSql()).get() ?? {});
    const count = Number(row.malformed_rows);
    return Number.isSafeInteger(count) && count >= 0 ? count : 0;
  } catch {
    return 0;
  }
}

/**
 * @typedef {object} OpencodeRawPerfSample
 * @property {string} sourceKind
 * @property {string} homeId
 * @property {string} sourcePath
 * @property {string} channel
 * @property {string} databaseIdentity
 * @property {string} messageId
 * @property {Array<string | number>} identity
 * @property {string} sampleKey
 * @property {string} sessionId
 * @property {string} window
 * @property {string} timingKind
 * @property {string} timingSource
 * @property {string} tokenScope
 * @property {string} status
 * @property {boolean} terminalVerified
 * @property {boolean} inProgress
 * @property {boolean} cancelledByUser
 * @property {boolean} sourceFiltered
 * @property {string} filterReason
 * @property {string} agentKind
 * @property {string} agent
 * @property {string} model
 * @property {string} modelProvider
 * @property {string} reasoningEffort
 * @property {string} modelEvidence
 * @property {number | null} tsMs
 * @property {number | null} windowStartMs
 * @property {number | null} windowEndMs
 * @property {number | null} durationMs
 * @property {number | null} outputTokens
 * @property {number | null} inputTokens
 * @property {number | null} requestCount
 * @property {number | null} itemCount
 * @property {number | null} timedItemCount
 */

/**
 * @typedef {object} OpencodeReadStats
 * @property {string} sourceKind
 * @property {string} homeId
 * @property {string} sourcePath
 * @property {string} databaseIdentity
 * @property {number} rowsScanned 实际投影读取的 assistant 行数（坏 JSON 行不计）
 * @property {number} malformedJsonRows
 * @property {number} samples 已产出候选数
 * @property {number} unkeyable 无法成形身份的行数
 * @property {number} supportedRows
 * @property {number} legacyRows 因 v1 语义被排除的行数
 * @property {number} unknownVersionRows 版本证据缺失/不可解析但仍放行的行数
 * @property {number} unrecognizedTerminalRows 已放行但 `$.finish` 是未识别字面量的行数（语义漂移信号）
 * @property {number} completedMissingRows 已放行但 `$.time.completed` 不是可用数值的行数
 * @property {boolean} versionEvidenceAvailable `session_v2.version` 是否可用
 * @property {Array<{code: string, count: number}>} warnings 与 `onWarning` 同源同序
 */

/**
 * 逐条流式输出 OpenCode v2 assistant 消息候选（raw 形状，供集成层 `normalizePerfSample()`）。
 *
 * @param {string} dbFile 已发现的 `opencode*.db` 物理路径
 * @param {{id?: unknown, channel?: unknown}} source 归属 home（`id` 是身份元组第 2 项）
 * @param {(sample: OpencodeRawPerfSample) => unknown} onSample 逐条回调（可返回 Promise，会被 await）
 * @param {{onWarning?: (warning: {sourceKind: string, homeId: string, code: string, count: number}) => unknown}} [options]
 * @returns {Promise<OpencodeReadStats>}
 */
export async function streamOpencodePerfSamples(dbFile, source, onSample, options = {}) {
  const onWarning = typeof options?.onWarning === "function" ? options.onWarning : null;
  const homeId = trimmedText(source?.id);
  const channel = trimmedText(source?.channel) || OPENCODE_CHANNEL;
  const sourcePath = typeof dbFile === "string" ? dbFile : "";
  const databaseIdentity = canonicalOpencodeDatabaseIdentity(dbFile);

  const database = openOpencodeDatabaseReadOnly(dbFile, homeId);
  let rowsScanned = 0;
  let samples = 0;
  let unkeyable = 0;
  let malformedJsonRows = 0;
  let supportedRows = 0;
  let legacyRows = 0;
  let unknownVersionRows = 0;
  let unrecognizedTerminalRows = 0;
  let completedMissingRows = 0;
  let versionEvidenceAvailable = false;
  try {
    assertSessionMessageColumns(database, homeId, dbFile);
    const versionsById = readSessionVersions(database);
    versionEvidenceAvailable = versionsById !== null;
    malformedJsonRows = countMalformedAssistantRows(database);
    for (const raw of database.prepare(buildOpencodePerfSql()).iterate()) {
      const row = /** @type {Record<string, unknown>} */ (raw);
      rowsScanned += 1;

      // 身份 = (home_id, database_identity, message.id)（§17.1:197、:205）。
      // 无法成形身份的原始行**不写候选表**，只累计编码警告（§17.1:205、fixture-cases D-09）。
      const sampleKey = perfSampleKey(
        OPENCODE_SOURCE_KIND,
        homeId,
        databaseIdentity,
        /** @type {string | number} */ (row.message_id),
      );
      if (sampleKey === null) {
        unkeyable += 1;
        continue;
      }

      // 版本三档：supported 放行 / legacy 排除+告警 / unknown 放行+告警（契约 §1.3）。
      const sessionId = trimmedText(row.session_id);
      const major = versionsById === null ? null : (versionsById.get(sessionId) ?? null);
      if (major !== null && major < OPENCODE_SUPPORTED_SESSION_MAJOR) {
        legacyRows += 1;
        continue;
      }
      if (major === null) unknownVersionRows += 1;
      else supportedRows += 1;

      const terminal = classifyOpencodeTerminal(row.finish_text, row.error_type);
      if (!terminal.recognized) unrecognizedTerminalRows += 1;

      const createdMs = isFiniteNumber(row.created_ms) ? /** @type {number} */ (row.created_ms) : null;
      const completedMs = isFiniteNumber(row.completed_ms) ? /** @type {number} */ (row.completed_ms) : null;
      // 契约 §2-F 的 OpenCode 行把"结束证据"定义为 `data.finish`；`completed` 缺失属时间面（M1 归 MISSING_DURATION）。
      // 本计数器同时是"是否该改判 pending"的实测依据（本机全库为 0）。
      if (completedMs === null) completedMissingRows += 1;
      const model = trimmedText(row.model_id);
      const modelProvider = trimmedText(row.provider_id);
      const agent = trimmedText(row.agent_name);

      /** @type {OpencodeRawPerfSample} */
      const sample = {
        sourceKind: OPENCODE_SOURCE_KIND,
        homeId,
        sourcePath,
        channel,
        databaseIdentity,
        messageId: String(row.message_id),
        identity: [databaseIdentity, /** @type {string | number} */ (row.message_id)],
        sampleKey,
        sessionId,
        // §17.1:196/199/220：message 时窗 + 端到端计时 + 可见输出含 reasoning。
        window: "message",
        timingKind: "request_e2e",
        timingSource: "explicit",
        tokenScope: "visible_plus_reasoning",
        status: terminal.status,
        terminalVerified: terminal.terminalVerified,
        // 本来源没有取消/进行中的证据：绝不伪造（§2-F、§6.3）。
        inProgress: false,
        cancelledByUser: false,
        sourceFiltered: terminal.sourceFiltered,
        filterReason: terminal.filterReason,
        // `data.agent` 只证明名称，角色无证据（契约 §1.3、§3 第 4 条）；缺名称用空串（裁定 P）。
        agentKind: "unknown",
        agent,
        model,
        modelProvider,
        // variant/effort 缺证据**不从当前配置回填**（§3 第 6 条、§6.1-B4）。
        reasoningEffort: "",
        // 模型证据的名称类字面量无冻结值，交给 M0.6 裁定；此处不发明字面量。
        modelEvidence: "",
        tsMs: resolveOpencodeTsMs(createdMs, completedMs),
        // 观测边界 = [created, completed]（§17.1:222）；本来源两者的差恰好等于 durationMs。
        windowStartMs: createdMs,
        windowEndMs: completedMs,
        durationMs: resolveOpencodeDuration(createdMs, completedMs),
        outputTokens: combineOpencodeOutputTokens(row.output_tokens, row.reasoning_tokens),
        // 裁定 AL-4：`inputTokens` 恒 `null`。它只是诊断字段、M1 内核不消费，而输入侧三个 JSON 路径
        // （`$.tokens.input` / `cache.read` / `cache.write`）未经 M0 验证 ⇒ 不投影（§3 第 6 条同源原则）。
        // 产品适配器 `opencode-usage.js` 的 `input + cache.read + cache.write` 口径属看板展示层，不在此处复用。
        inputTokens: null,
        // 一条 assistant 消息 = 一个观测时窗；"1 条消息 = 1 次 provider 请求"未获证据，故不填。
        requestCount: null,
        itemCount: null,
        timedItemCount: null,
      };

      samples += 1;
      await onSample(sample);
    }
  } finally {
    database.close();
  }

  // 非致命诊断：聚合为冻结码域里的三个码，按码的代码单元序确定性推送（契约 §5 / 计划 §3:83）。
  /** @type {Array<{code: string, count: number}>} */
  const warnings = [];
  const counts = new Map();
  if (unkeyable > 0) counts.set("UNKEYABLE_RECORD", unkeyable);
  const unsupportedSchemaRows = legacyRows + unknownVersionRows + unrecognizedTerminalRows;
  if (unsupportedSchemaRows > 0) counts.set("UNSUPPORTED_SCHEMA", unsupportedSchemaRows);
  if (malformedJsonRows > 0) counts.set("MALFORMED_JSON", malformedJsonRows);
  for (const code of [...counts.keys()].sort(compareCodeUnits)) {
    const warning = { sourceKind: OPENCODE_SOURCE_KIND, homeId, code, count: /** @type {number} */ (counts.get(code)) };
    warnings.push(warning);
    await onWarning?.(warning);
  }

  return {
    sourceKind: OPENCODE_SOURCE_KIND,
    homeId,
    sourcePath,
    databaseIdentity,
    rowsScanned,
    malformedJsonRows,
    samples,
    unkeyable,
    supportedRows,
    legacyRows,
    unknownVersionRows,
    unrecognizedTerminalRows,
    completedMissingRows,
    versionEvidenceAvailable,
    warnings,
  };
}
