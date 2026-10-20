import { mkdir, stat } from "node:fs/promises";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { plainRolloutPath } from "./codex-rollout.js";

import {
  COMPARISON_PERIOD_KEYS,
  buildPerfStatsBlock,
  buildUsageFingerprint,
  discoverSessionFiles,
  discoverUsageSources,
  isQuotaPreset,
  planStableCodexHome,
  perfStatsRangeBounds,
  previousUsageRange,
  resolveDateRange,
  selectQuotaWindows,
  streamUsageFileEvents,
  usageComparisonFromAggregates,
} from "./usage-core.js";
import { createRepositoryResolver } from "./repository-identity.js";
import {
  createCostEstimateAccumulator,
  createEventCostMemo,
  estimateCostForEvents,
  estimateEventCost,
  getPricingCatalog,
} from "./pricing.js";
import { loadServiceTierEvidence } from "./service-tier-evidence.js";
import { buildModelActivity, CODEX_AUTO_REVIEW_MODEL, isCodexAutoReview } from "../public/pricing-models.js";
import { zcodeSourceStat } from "./zcode-usage.js";
import { dshSessionFiles } from "./dsh-usage.js";
import { opencodeDatabaseFiles, opencodeSourceStat } from "./opencode-usage.js";
import { claudeSessionFiles } from "./claude-code-usage.js";
import { isPerfSourceEnabled, streamPerfSamplesForFile, classifyPerfSources } from "./perf-sources/index.js";
import {
  buildCodexThreadPerfSamples,
  codexSampleAllowed,
  codexSampleThreadId,
  createCodexProjectionCache,
  createCodexPublishFilter,
  decodeCodexPublicationPolicy,
  encodeCodexPublicationPolicy,
  rankedCodexHomeIds,
  CODEX_PUBLICATION_POLICY_REVISION,
} from "./perf-sources/codex-thread.js";
import { PERF_METHOD_VERSION, PERF_SOURCE_WARNING_CODES, canonicalPerfSourceKind } from "./perf-stats.js";
import { createHash } from "node:crypto";
import {
  buildTimelineRows,
  sourceGroup,
  homeSourceKinds,
  deriveTimelineBucket,
  quotaRecordsForRange,
  quotaRecordValues,
} from "../public/timeline-utils.js";

export const STORE_SCHEMA_VERSION = 16;
const CODEX_ROLLOUT_READER_VERSION = "zstd-jsonl-v1";

/**
 * W4-b1 / D1：`buildRecordChampions` 的**默认**逐行计价函数（= 模块级的 `estimateEventCost`）。
 *
 * 存在的理由：该方法的源码里有一行 `const estimate = estimateEventCost({…})`，被共享门禁
 * （`tools/lib/instrument.mjs` 的 `fullHistoryPricingRows` 锚点）**逐字节**锚定。为了在不改锚点的
 * 前提下让它走 memo，把计价函数作为**末位参数注入**（默认值就是这个别名）。
 */
const DEFAULT_EVENT_COST_ESTIMATOR = estimateEventCost;

/**
 * M3.1：`perf_samples` 的**单一字段映射表** —— 编码、解码、INSERT 列序、SELECT 列序全部由它驱动。
 *
 * `kind` 决定 SQL 类型与 JS 侧取值域：
 * - `text` → `TEXT NOT NULL`：归一化样本里名称/身份/口径类字段**恒为字符串**（缺失是空串，裁定 P），
 *   列声明 `NOT NULL` 是为了不让"缺失"多出第二个字面量 `NULL`。
 * - `integer` → `INTEGER`（**可空**）：度量类字段"未知"是 `NULL`、真实 0 是 `0`。若写成
 *   `NOT NULL DEFAULT 0`，这条规则被**结构性破坏**，而且写入方总会给值，测试不会发现（裁定 AO-3）。
 * - `flags` → `INTEGER NOT NULL DEFAULT 0`：位域不是度量，"没有任何位"本来就等于 0（§17.4）。
 * - `reasonChain` → `TEXT`（**可空**）：JSON 数组文本；`NULL`（没有链）与 `'[]'`（链已算出且为空）
 *   是两种状态，必须可区分（裁定 AO-1/AO-3）。
 *
 * 顺序 = DDL 列顺序 = INSERT/SELECT 参数顺序；测试用 `PRAGMA table_info(perf_samples)` 与之双向锁定。
 * @typedef {{ field: string, column: string, kind: "text" | "integer" | "flags" | "reasonChain", notNull: boolean, primaryKey?: boolean }} PerfSampleFieldSpec
 */

/** @type {ReadonlyArray<PerfSampleFieldSpec>} */
export const PERF_SAMPLE_FIELDS = Object.freeze([
  { field: "sampleKey", column: "sample_key", kind: "text", notNull: true, primaryKey: true },
  { field: "sourcePath", column: "source_path", kind: "text", notNull: true },
  { field: "sourceKind", column: "source_kind", kind: "text", notNull: true },
  { field: "homeId", column: "home_id", kind: "text", notNull: true },
  { field: "channel", column: "channel", kind: "text", notNull: true },
  { field: "agentKind", column: "agent_kind", kind: "text", notNull: true },
  { field: "agent", column: "agent", kind: "text", notNull: true },
  { field: "sessionId", column: "session_id", kind: "text", notNull: true },
  { field: "turnKey", column: "turn_key", kind: "text", notNull: true },
  { field: "model", column: "model", kind: "text", notNull: true },
  { field: "modelProvider", column: "model_provider", kind: "text", notNull: true },
  { field: "reasoningEffort", column: "reasoning_effort", kind: "text", notNull: true },
  { field: "modelEvidence", column: "model_evidence", kind: "text", notNull: true },
  { field: "window", column: "window", kind: "text", notNull: true },
  { field: "timingKind", column: "timing_kind", kind: "text", notNull: true },
  { field: "timingSource", column: "timing_source", kind: "text", notNull: true },
  { field: "tokenScope", column: "token_scope", kind: "text", notNull: true },
  { field: "status", column: "status", kind: "text", notNull: true },
  { field: "tsMs", column: "ts_ms", kind: "integer", notNull: false },
  { field: "windowStartMs", column: "window_start_ms", kind: "integer", notNull: false },
  { field: "windowEndMs", column: "window_end_ms", kind: "integer", notNull: false },
  { field: "durationMs", column: "duration_ms", kind: "integer", notNull: false },
  { field: "outputTokens", column: "output_tokens", kind: "integer", notNull: false },
  { field: "inputTokens", column: "input_tokens", kind: "integer", notNull: false },
  { field: "requestCount", column: "request_count", kind: "integer", notNull: false },
  { field: "itemCount", column: "item_count", kind: "integer", notNull: false },
  { field: "timedItemCount", column: "timed_item_count", kind: "integer", notNull: false },
  { field: "sampleFlags", column: "sample_flags", kind: "flags", notNull: true },
  { field: "diagnosticReason", column: "diagnostic_reason", kind: "text", notNull: true },
  { field: "diagnosticReasonChain", column: "diagnostic_reason_chain", kind: "reasonChain", notNull: false },
  { field: "methodVersion", column: "method_version", kind: "text", notNull: true },
]);

/**
 * `perf_samples` 的冻结 DDL（**字面量，不从映射表生成**）。
 *
 * 为什么用字面量：若从映射表生成，"改映射表"会顺带改 schema —— 一次看起来无害的编辑就变成
 * 迁移语义变化（AN-9 那类陷阱）。字面量 + 测试断言「`PRAGMA table_info` 与映射表逐列相等」
 * 才能让两侧任何漂移都变红。
 *
 * 这是自 v2 以来**首次真正 `CREATE TABLE` 的迁移**（AN-5）：外键与级联删除在本仓库从未演练，
 * 因此 `STRICT`、`IF NOT EXISTS`、`REFERENCES … ON DELETE CASCADE`、三个索引都必须在测试里
 * **实测**，不得以"写了"当证据。
 *
 * 数值列一律**可空**（AO-3）：`NULL` = 该度量未知，`0` = 真实 0。
 */
const PERF_SAMPLES_DDL = `
      CREATE TABLE IF NOT EXISTS perf_samples (
        sample_key TEXT PRIMARY KEY,
        source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
        source_kind TEXT NOT NULL CHECK (source_kind <> ''),
        home_id TEXT NOT NULL CHECK (home_id <> ''),
        channel TEXT NOT NULL,
        agent_kind TEXT NOT NULL CHECK (agent_kind IN ('main', 'subagent', 'unknown')),
        agent TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_key TEXT NOT NULL,
        model TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        model_evidence TEXT NOT NULL,
        window TEXT NOT NULL,
        timing_kind TEXT NOT NULL CHECK (timing_kind IN ('request_e2e', 'item_span_estimate')),
        timing_source TEXT NOT NULL,
        token_scope TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'cancelled', 'in_progress', 'unverified')),
        ts_ms INTEGER,
        window_start_ms INTEGER,
        window_end_ms INTEGER,
        duration_ms INTEGER,
        output_tokens INTEGER,
        input_tokens INTEGER,
        request_count INTEGER,
        item_count INTEGER,
        timed_item_count INTEGER,
        sample_flags INTEGER NOT NULL DEFAULT 0,
        diagnostic_reason TEXT NOT NULL,
        diagnostic_reason_chain TEXT,
        method_version TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS perf_samples_source_path_idx ON perf_samples(source_path);
      CREATE INDEX IF NOT EXISTS perf_samples_home_ts_idx ON perf_samples(home_id, ts_ms);
      CREATE INDEX IF NOT EXISTS perf_samples_source_kind_home_ts_idx ON perf_samples(source_kind, home_id, ts_ms);
`;

/** 冻结的三个索引：名字 → 列顺序。自检要逐个核对 `PRAGMA index_info`（同名索引可能挂在别的表上，被 `IF NOT EXISTS` 静默忽略）。 */
/** @type {ReadonlyArray<[string, ReadonlyArray<string>]>} */
const PERF_SAMPLES_INDEXES = Object.freeze([
  ["perf_samples_source_path_idx", ["source_path"]],
  ["perf_samples_home_ts_idx", ["home_id", "ts_ms"]],
  ["perf_samples_source_kind_home_ts_idx", ["source_kind", "home_id", "ts_ms"]],
]);

const PERF_CODEX_INDEX_DDL = `
  CREATE TABLE IF NOT EXISTS perf_sample_sources (
    sample_key TEXT NOT NULL REFERENCES perf_samples(sample_key) ON DELETE CASCADE,
    source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('primary', 'dependency')),
    PRIMARY KEY (sample_key, source_path)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS perf_sample_sources_path_idx ON perf_sample_sources(source_path);
  CREATE TABLE IF NOT EXISTS perf_rollout_threads (
    source_path TEXT PRIMARY KEY REFERENCES source_files(path) ON DELETE CASCADE,
    home_id TEXT NOT NULL CHECK (home_id <> ''),
    thread_id TEXT NOT NULL CHECK (thread_id <> '')
  ) STRICT;
  CREATE INDEX IF NOT EXISTS perf_rollout_threads_home_thread_idx ON perf_rollout_threads(home_id, thread_id);
`;

/**
 * T1（本计划**首次** schema bump，13 → 14）：Codex 标准化投影的**私有持久表**。**只建表 + 索引，不回填。**
 *
 * 动机是 C6 的实测（不是推测）：`src/perf-sources/codex-thread.js:575` 在"有文件真变"的那一轮逐文件
 * 遍历**全部**路径，而被 LRU 逐出的条目在 `lookup` 处必然 `undefined` ⇒ `:590-592` 直接
 * `readCodexRolloutMetadata()` **全文读**。C6 §3 实测 `r3parse = 1 + 逐出数`（缺省 64 MiB 下
 * 2× ⇒ 84 份 / 893,718,901 B；4× ⇒ 363 份 / 3,766,975,634 B），§3.2 又实测真变后缓存**塌缩**
 * （1,086 → 202 条，逐出 1,246）⇒ 退化会自我放大。本表让被逐出的投影不必重新解析全文。
 *
 * 只存**规范投影**（`readCodexRolloutMetadata()` 返回对象的 JSON 文本），**严禁** raw JSONL；
 * 列定义与不变量逐项见 `handoffs/T1-design.md` §2（含 §0 修订 1 的两处"与内存键同形"）。
 *
 * `STRICT` 与本仓其它新表（`perf_samples`/`perf_sample_sources`/`perf_rollout_threads`）一致：
 * 它不新增列，但把"类型写错"从静默 coerce 变成硬失败。
 */
const PERF_CODEX_PROJECTIONS_DDL = `
  CREATE TABLE IF NOT EXISTS perf_codex_projections (
    path TEXT PRIMARY KEY,
    home_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    method_version TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    projection TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS perf_codex_projections_home_idx ON perf_codex_projections(home_id);
`;

/** 冻结列序（`name` / `type` / `pk` / `notnull`），逐个核对；本机实测 STRICT 表的主键列 `notnull=1`。 */
const PERF_CODEX_PROJECTION_COLUMNS = Object.freeze([
  ["path", "TEXT", 1, 1],
  ["home_id", "TEXT", 0, 1],
  ["kind", "TEXT", 0, 1],
  ["method_version", "TEXT", 0, 1],
  ["fingerprint", "TEXT", 0, 1],
  ["bytes", "INTEGER", 0, 1],
  ["projection", "TEXT", 0, 1],
  ["updated_at", "TEXT", 0, 1],
]);

/** 冻结索引：名字 → 列序。
 * @type {ReadonlyArray<readonly [string, readonly string[]]>}
 */
const PERF_CODEX_PROJECTIONS_INDEXES = Object.freeze([["perf_codex_projections_home_idx", ["home_id"]]]);

/**
 * 自检 `perf_codex_projections` 的**实际** schema 是否等于冻结 DDL（列名/类型/可空性/主键 + 索引列序 + `STRICT`）。
 *
 * 与 `assertPerfSamplesSchema` 同因：`CREATE TABLE IF NOT EXISTS` 只按**名字**判断存在性 ——
 * 同名 VIEW 会静默通过（一列都没建）、同名索引挂错表也会静默通过。没有这道自检，"迁移成功"
 * 可能只是"什么都没建"，而 `user_version` 已经抬到 14。它是 `migrate()` 事务内的最后一步：
 * 不符即抛 ⇒ 回滚 ⇒ 版本保持 13，下次打开重试。
 * @param {import("node:sqlite").DatabaseSync} database
 */
function assertPerfCodexProjectionsSchema(database) {
  const actualColumns = database.prepare("PRAGMA table_info(perf_codex_projections)").all();
  if (actualColumns.length !== PERF_CODEX_PROJECTION_COLUMNS.length) {
    throw new PerfSampleCodecError(
      "PERF_CODEX_PROJECTION_SCHEMA_MISMATCH",
      `perf_codex_projections 列数 ${actualColumns.length} ≠ 冻结 ${PERF_CODEX_PROJECTION_COLUMNS.length}`,
    );
  }
  for (const [index, [name, type, pk, notNull]] of PERF_CODEX_PROJECTION_COLUMNS.entries()) {
    const row = actualColumns[index];
    if (
      String(row.name) !== name ||
      String(row.type || "").toUpperCase() !== type ||
      Number(row.pk) !== pk ||
      Number(row.notnull) !== notNull
    ) {
      throw new PerfSampleCodecError(
        "PERF_CODEX_PROJECTION_SCHEMA_MISMATCH",
        `perf_codex_projections 列 ${index} 实际 ${String(row.name)}/${String(row.type)}/notnull=${Number(row.notnull)}/pk=${Number(row.pk)} ≠ 冻结 ${name}/${type}/notnull=${notNull}/pk=${pk}`,
      );
    }
  }
  const indexNames = new Set(
    database
      .prepare("PRAGMA index_list(perf_codex_projections)")
      .all()
      .map((row) => String(row.name)),
  );
  for (const [indexName, columns] of PERF_CODEX_PROJECTIONS_INDEXES) {
    if (!indexNames.has(indexName)) {
      throw new PerfSampleCodecError(
        "PERF_CODEX_PROJECTION_SCHEMA_MISMATCH",
        `perf_codex_projections 缺少索引 ${indexName}`,
      );
    }
    const actual = database
      .prepare(`PRAGMA index_info(${indexName})`)
      .all()
      .map((row) => String(row.name));
    if (JSON.stringify(actual) !== JSON.stringify(columns)) {
      throw new PerfSampleCodecError(
        "PERF_CODEX_PROJECTION_SCHEMA_MISMATCH",
        `索引 ${indexName} 列序 ${actual.join(",")} ≠ ${columns.join(",")}`,
      );
    }
  }
  const ddl = String(
    database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'perf_codex_projections'").get()
      ?.sql ?? "",
  );
  if (!ddl.includes("STRICT")) {
    throw new PerfSampleCodecError("PERF_CODEX_PROJECTION_SCHEMA_MISMATCH", "perf_codex_projections 不是 STRICT 表");
  }
}

function assertPerfCodexIndexSchema(database) {
  const expected = [
    ["perf_sample_sources", ["sample_key", "source_path", "role"], ["perf_sample_sources_path_idx"]],
    ["perf_rollout_threads", ["source_path", "home_id", "thread_id"], ["perf_rollout_threads_home_thread_idx"]],
  ];
  for (const [table, columns, indexes] of expected) {
    const actual = database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name));
    if (JSON.stringify(actual) !== JSON.stringify(columns)) {
      throw new PerfSampleCodecError("PERF_CODEX_SCHEMA_MISMATCH", `${table} columns do not match the M7 contract`);
    }
    const actualIndexes = new Set(
      database
        .prepare(`PRAGMA index_list(${table})`)
        .all()
        .map((row) => String(row.name)),
    );
    for (const index of indexes) {
      if (!actualIndexes.has(index)) {
        throw new PerfSampleCodecError("PERF_CODEX_SCHEMA_MISMATCH", `${table} is missing index ${index}`);
      }
    }
  }
  const sampleSourceFks = database.prepare("PRAGMA foreign_key_list(perf_sample_sources)").all();
  const rolloutFks = database.prepare("PRAGMA foreign_key_list(perf_rollout_threads)").all();
  if (
    !sampleSourceFks.some(
      (row) => row.table === "perf_samples" && row.from === "sample_key" && row.on_delete === "CASCADE",
    ) ||
    !sampleSourceFks.some(
      (row) => row.table === "source_files" && row.from === "source_path" && row.on_delete === "CASCADE",
    ) ||
    !rolloutFks.some((row) => row.table === "source_files" && row.from === "source_path" && row.on_delete === "CASCADE")
  ) {
    throw new PerfSampleCodecError(
      "PERF_CODEX_SCHEMA_MISMATCH",
      "M7 dependency tables must cascade from their parents",
    );
  }
}

/**
 * 把 reader 的编码 warning（`{ sourceKind, homeId, code, count }`）转成既有 warnings 数组里的字符串。
 * **只输出编码后的四要素**，不含路径与内容（方案 `:62` 的字段取用与持久化限制）。
 * @param {any} warning
 */
function formatPerfWarning(warning) {
  const kind = typeof warning?.sourceKind === "string" ? warning.sourceKind : "unknown";
  const homeId = typeof warning?.homeId === "string" ? warning.homeId : "";
  const code = typeof warning?.code === "string" ? warning.code : "UNKNOWN";
  const count = Number.isFinite(Number(warning?.count)) ? Number(warning.count) : 0;
  return `性能来源告警 ${kind}/${homeId}: ${code} ×${count}`;
}

/** 编解码/自检失败。`code` 属于冻结小集合，`message` 只含列名与字面量，绝不含会话内容或路径。 */ export class PerfSampleCodecError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "PerfSampleCodecError";
    this.code = code;
  }
}

/**
 * 自检 `perf_samples` 的**实际** schema 是否等于冻结 DDL（列名/类型/可空性/主键 + 三个索引及其列序）。
 *
 * 为什么必须自检（本机实测，🟦）：`CREATE TABLE IF NOT EXISTS` 与 `CREATE INDEX IF NOT EXISTS`
 * 只按**名字**判断存在性 ——
 * ① 同名对象是 `VIEW` 时，建表语句**静默通过**（一个字段都没建）；
 * ② 同名索引挂在**别的表**上时，建索引语句也**静默通过**（索引根本没建到本表）；
 * ③ 形状不对的旧 `perf_samples` 更是原样留下。
 * 没有这道自检，"迁移成功"可能只是"什么都没建"，而 `user_version` 已经抬到 12（AN-6：数字
 * 看起来合理，provenance 是假的）。它是 `migrate()` 事务内的最后一步：不符即抛 ⇒ 回滚 ⇒ 版本不动。
 * @param {import("node:sqlite").DatabaseSync} database
 */
function assertPerfSamplesSchema(database) {
  const actualColumns = database.prepare("PRAGMA table_info(perf_samples)").all();
  if (actualColumns.length !== PERF_SAMPLE_FIELDS.length) {
    throw new PerfSampleCodecError(
      "PERF_SAMPLES_SCHEMA_MISMATCH",
      `perf_samples 列数 ${actualColumns.length} ≠ 冻结 ${PERF_SAMPLE_FIELDS.length}`,
    );
  }
  for (const [index, entry] of PERF_SAMPLE_FIELDS.entries()) {
    const row = actualColumns[index];
    const expectedType = entry.kind === "text" || entry.kind === "reasonChain" ? "TEXT" : "INTEGER";
    const actualType = String(row.type || "").toUpperCase();
    const pkMatches = Number(row.pk) === (entry.primaryKey ? 1 : 0);
    // STRICT 表的主键列隐含 NOT NULL（本机实测 `table_info` 报 notnull=1）。这里接受
    // "notnull=1" 与 "pk=1 的主键列 notnull=0" 两种报告，避免把 SQLite 的报告差异当成 schema 漂移；
    // "主键不可为 NULL"仍由 pk 位保证（实测：写 NULL 主键报 NOT NULL constraint failed）。
    const notNullMatches = Number(row.notnull) === (entry.notNull ? 1 : 0) || (entry.primaryKey === true && pkMatches);
    if (String(row.name) !== entry.column || actualType !== expectedType || !pkMatches || !notNullMatches) {
      throw new PerfSampleCodecError(
        "PERF_SAMPLES_SCHEMA_MISMATCH",
        `perf_samples 列 ${index} 实际 ${String(row.name)}/${actualType}/notnull=${Number(row.notnull)}/pk=${Number(row.pk)} ≠ 冻结 ${entry.column}/${expectedType}`,
      );
    }
  }
  const indexNames = new Set(
    database
      .prepare("PRAGMA index_list(perf_samples)")
      .all()
      .map((row) => String(row.name)),
  );
  for (const [name, columns] of PERF_SAMPLES_INDEXES) {
    if (!indexNames.has(name)) {
      throw new PerfSampleCodecError("PERF_SAMPLES_SCHEMA_MISMATCH", `perf_samples 缺少索引 ${name}`);
    }
    const actualColumnsOfIndex = database
      .prepare(`PRAGMA index_info(${name})`)
      .all()
      .map((row) => String(row.name));
    if (JSON.stringify(actualColumnsOfIndex) !== JSON.stringify(columns)) {
      throw new PerfSampleCodecError(
        "PERF_SAMPLES_SCHEMA_MISMATCH",
        `索引 ${name} 实际列 ${actualColumnsOfIndex.join(",")} ≠ 冻结 ${columns.join(",")}`,
      );
    }
  }
}

/** INSERT 列序与占位符都由映射表生成（不手写列名，也不可能与 SELECT 漂移）。 */
const PERF_SAMPLE_INSERT_SQL = `INSERT INTO perf_samples (${PERF_SAMPLE_FIELDS.map((entry) => entry.column).join(", ")}) VALUES (${PERF_SAMPLE_FIELDS.map(() => "?").join(", ")})`;

/** 全列 SELECT（**不用 `SELECT *`**：列序与映射表一致，才是可预测的解码输入）。 */
const PERF_SAMPLE_SELECT_SQL = `SELECT ${PERF_SAMPLE_FIELDS.map((entry) => entry.column).join(", ")} FROM perf_samples`;

/**
 * 归一化样本 → SQLite 行（键为 snake_case 列名，可直接绑定参数）。
 *
 * 校验是**有意的最后一道防线**：M3.2 必须在同一事务里写"已归一化"的样本，但调用点很容易误传
 * reader 的 raw 候选（它也有 `outputTokens` 之类的同名键，但值域不受 M1 保证）。这里的校验让
 * 误传**当场报错并指出字段名**，而不是把 `undefined` 交给驱动（实测驱动抛
 * `Provided value cannot be bound to SQLite parameter 1.`，不含字段名）或让 STRICT 的无损换算
 * 悄悄把 `"7"` 变成 7。
 *
 * 多出的键被忽略（不静默丢数据：`decode(encode(s))` 的逐字段往返测试会因 M1 新增字段而变红）。
 * @param {unknown} sample
 * @returns {Record<string, string | number | null>}
 */
export function encodePerfSample(sample) {
  if (sample === null || typeof sample !== "object") {
    throw new PerfSampleCodecError("INVALID_SAMPLE", "perf 样本必须是对象");
  }
  /** @type {Record<string, string | number | null>} */
  const row = {};
  for (const entry of PERF_SAMPLE_FIELDS) {
    const value = /** @type {Record<string, unknown>} */ (sample)[entry.field];
    if (value === undefined) {
      throw new PerfSampleCodecError("MISSING_FIELD", `perf 样本缺少字段 ${entry.field}（不得用 NULL 代替缺失字段）`);
    }
    if (entry.kind === "text") {
      if (typeof value !== "string") {
        throw new PerfSampleCodecError("INVALID_FIELD_TYPE", `${entry.field} 必须是字符串，收到 ${typeof value}`);
      }
      row[entry.column] = value;
    } else if (entry.kind === "integer") {
      if (value !== null && !Number.isSafeInteger(value)) {
        throw new PerfSampleCodecError("INVALID_FIELD_TYPE", `${entry.field} 必须是安全整数或 null`);
      }
      row[entry.column] = /** @type {number | null} */ (value);
    } else if (entry.kind === "flags") {
      if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0) {
        throw new PerfSampleCodecError("INVALID_FIELD_TYPE", `${entry.field} 必须是非负安全整数`);
      }
      row[entry.column] = /** @type {number} */ (value);
    } else {
      if (value === null) {
        row[entry.column] = null;
      } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
        row[entry.column] = JSON.stringify(value);
      } else {
        throw new PerfSampleCodecError("INVALID_FIELD_TYPE", `${entry.field} 必须是字符串数组或 null`);
      }
    }
  }
  return row;
}

/**
 * SQLite 行 → 归一化样本形状（`decode(encode(s))` 与 `s` 逐字段深等，含 `null`/`0` 与 `[]`/`null` 的区分）。
 *
 * 解码**不做归一化**：不补默认值、不把 `NULL` 折成 0、不把 `'[]'` 折成 `NULL`。读到不符合冻结
 * schema 的值时抛 {@link PerfSampleCodecError}（AN-6：宁可响亮失败，也不写出"看起来合理"的假值）。
 * @param {unknown} row
 * @returns {import("./usage-types.js").PerfSampleRowDecoded}
 */
export function decodePerfSample(row) {
  if (row === null || typeof row !== "object") {
    throw new PerfSampleCodecError("INVALID_ROW", "perf 行必须是对象");
  }
  /** @type {Record<string, unknown>} */
  const sample = {};
  for (const entry of PERF_SAMPLE_FIELDS) {
    const value = /** @type {Record<string, unknown>} */ (row)[entry.column];
    if (value === undefined) {
      throw new PerfSampleCodecError("MISSING_COLUMN", `perf 行缺少列 ${entry.column}`);
    }
    if (entry.kind === "reasonChain") {
      if (value === null) {
        sample[entry.field] = null;
        continue;
      }
      if (typeof value !== "string") {
        throw new PerfSampleCodecError("INVALID_REASON_CHAIN", `${entry.column} 必须是 JSON 数组文本或 NULL`);
      }
      /** @type {unknown} */
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new PerfSampleCodecError("INVALID_REASON_CHAIN", `${entry.column} 不是合法 JSON 文本`);
      }
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
        throw new PerfSampleCodecError("INVALID_REASON_CHAIN", `${entry.column} 不是字符串数组`);
      }
      sample[entry.field] = parsed;
      continue;
    }
    if (entry.kind === "text") {
      if (typeof value !== "string") {
        throw new PerfSampleCodecError("INVALID_COLUMN_TYPE", `${entry.column} 必须是字符串`);
      }
    } else if (entry.kind === "integer") {
      // 度量列**可空**：`NULL` 是"未知"、`0` 是"真实 0"（AO-3）。只有 flags 是 NOT NULL。
      if (value !== null && !Number.isSafeInteger(value)) {
        throw new PerfSampleCodecError("INVALID_COLUMN_TYPE", `${entry.column} 必须是安全整数或 NULL`);
      }
    } else if (!Number.isSafeInteger(value)) {
      throw new PerfSampleCodecError("INVALID_COLUMN_TYPE", `${entry.column} 必须是安全整数`);
    }
    sample[entry.field] = value;
  }
  return /** @type {import("./usage-types.js").PerfSampleRowDecoded} */ (sample);
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localHourKey(date) {
  const hour = String(date.getHours()).padStart(2, "0");
  return `${localDateKey(date)} ${hour}:00`;
}

function startOfLocalWeek(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return start;
}

/** @returns {import("./usage-types.js").UsageTotals} */
function usageFromRow(row) {
  const values = row || {};
  return {
    total: Number(values.total || 0),
    input: Number(values.input || 0),
    cached: Number(values.cached || 0),
    output: Number(values.output || 0),
    reasoning: Number(values.reasoning || 0),
  };
}

const COST_EVENT_COLUMNS =
  "timestamp_ms, session_id, home_id, channel, model, detail_mask, cache_write_tokens, cache_write_known, request_input_tokens, context_level, service_tier, price_version, total, input, cached, output, reasoning";

/** @returns {import("./usage-types.js").IndexedCostEvent} */
function costEventFromRow(row, tierEvidence, sourceKind) {
  const timestamp = Number(row.timestamp_ms);
  const sessionId = String(row.session_id);
  return {
    timestamp,
    sessionId,
    homeId: String(row.home_id),
    sourceKind,
    channel: String(row.channel),
    model: String(row.model),
    detailMask: Number(row.detail_mask || 0),
    cacheWriteTokens: Number(row.cache_write_tokens || 0),
    cacheWriteKnown: Boolean(row.cache_write_known),
    requestInputTokens: Number(row.request_input_tokens || 0),
    contextLevel: String(row.context_level),
    serviceTier: tierEvidence?.resolve(sessionId, timestamp, String(row.service_tier)) || String(row.service_tier),
    priceVersion: String(row.price_version),
    total: usageFromRow(row),
  };
}

function rangeParameters(range) {
  const start = range.start ? range.start.getTime() : null;
  const end = range.end ? range.end.getTime() : null;
  return [start, start, end, end];
}

/**
 * M3.3：单个范围边界 → 毫秒数。**与 M1 `perfRangeBoundMs`（`src/perf-stats.js:1410`）同规则**：
 * `null`/`undefined` ⇒ `null`（无界）；`Date` ⇒ `getTime()`；有限数字 ⇒ 原值；
 * 其余（`NaN`、Invalid Date、字符串、对象）⇒ 抛 `TypeError`。
 *
 * 为什么必须抛而不是当成无界：`ts < NaN` 恒为 `false`，静默接受非法边界会**悄悄取消失效的前提**，
 * 让"范围内"变成一个没人检查过的更大集合。
 * @param {unknown} value
 * @returns {number | null}
 */
function perfRangeBoundMs(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    if (!Number.isFinite(time)) {
      throw new TypeError("perf range bounds must be finite millisecond numbers or Dates");
    }
    return time;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new TypeError("perf range bounds must be finite millisecond numbers or Dates");
}

/**
 * M3.3：把范围对象规范化成三个毫秒边界。
 *
 * **只认 M1 的键名** `{ startMs, endMs, windowEndExclusiveMs }`（值可为数字或 `Date`）。
 * 这是刻意的、而非疏漏：
 *
 * 🟩 实测（M3.3 探针）：`selectPerfSamples` **只读这三个键名**。若把 `usage-core` 的配额形状
 * `{ start, end, windowEndExclusive }` 原样交给 M1，三个绑定全部落成 `undefined` ⇒
 * `perfRangeBoundMs(undefined)` 返回 `null` ⇒ **M1 把它当成无界范围**，静默放行全部样本。
 *
 * 因此本方法**不得**为了"兼容"而额外识别 `start`/`end`/`windowEndExclusive`：那会让 SQL 路径
 * 带边界、而 M1 路径无界，两条路径给出**不同的集合** —— 恰是本卡最难发现的失败模式。
 * `M4-summary-and-api.md:13` 要求 SQLite 与内存两端 `summary.perf` 的计数完全相同，
 * 这只有在两端收到**同一个范围的同一份表达**时才能成立。
 *
 * 于是：范围一律由调用方（M4）解析成 `{ startMs, endMs, windowEndExclusiveMs }` 后**同时**喂给
 * 两条路径。传入 `usage-core` 的原始形状会被显式拒绝（见下），以免"看起来能用"。
 * @param {any} range
 */
function perfRangeBounds(range) {
  if (range === null || range === undefined) {
    return { startMs: null, endMs: null, windowEndExclusiveMs: null };
  }
  if (typeof range !== "object" || range instanceof Date) {
    throw new TypeError("perf range must be an object with startMs/endMs/windowEndExclusiveMs");
  }
  // 拒绝 usage-core 的原始配额形状：它带 start/end/windowEndExclusive 却没有 M1 的键名。
  // 静默接受会让 SQL 有界、M1 无界（实测成因见上），因此这里必须**响亮地**失败。
  const looksLikeRawQuotaRange =
    range.startMs === undefined &&
    range.endMs === undefined &&
    range.windowEndExclusiveMs === undefined &&
    (range.start !== undefined || range.end !== undefined || range.windowEndExclusive !== undefined);
  if (looksLikeRawQuotaRange) {
    throw new TypeError(
      "perf range must use M1 keys (startMs/endMs/windowEndExclusiveMs); " +
        "convert the usage-core range first so both paths share one expression",
    );
  }
  return {
    startMs: perfRangeBoundMs(range.startMs),
    endMs: perfRangeBoundMs(range.endMs),
    windowEndExclusiveMs: perfRangeBoundMs(range.windowEndExclusiveMs),
  };
}

/**
 * M3.3：规范化排除列表。空白字符串**不算**有效排除项（与 M1 的 trim 规则一致），
 * 否则 `[""]` 会让 `home_id <> ''` 意外排掉所有 home。
 * @param {Iterable<unknown> | string | null | undefined} raw
 * @returns {string[]}
 */
function normalizeExcludedHomeIds(raw) {
  if (raw === null || raw === undefined) return [];
  if (typeof raw === "string" || typeof raw[Symbol.iterator] !== "function") {
    throw new TypeError("excludedHomeIds must be an array or Set of home ids");
  }
  const seen = new Set();
  for (const entry of raw) {
    if (typeof entry === "string" && entry.trim() !== "") seen.add(entry.trim());
  }
  return [...seen];
}

function eventRangeFilter(range) {
  if (!isQuotaPreset(range?.preset) && !range?.quotaWindow && !range?.quotaPreset) {
    return {
      sql: "(? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?)",
      params: rangeParameters(range),
    };
  }
  const predicates = ["LOWER(TRIM(model)) <> ?"];
  const params = [CODEX_AUTO_REVIEW_MODEL];
  if (range.start) {
    predicates.push("timestamp_ms >= ?");
    params.push(range.start.getTime());
  }
  if (range.end) {
    predicates.push("timestamp_ms <= ?");
    params.push(range.end.getTime());
  }
  return { sql: predicates.length ? predicates.join(" AND ") : "1 = 1", params };
}

function eventRangeScope(range, scope) {
  const filter = eventRangeFilter(range);
  return {
    sql: withScope(filter.sql, scope),
    params: [...filter.params, ...scope.params],
  };
}

function scopeFilterSql(excludeHomes = []) {
  const ids = (excludeHomes || []).map((value) => String(value)).filter(Boolean);
  if (!ids.length) {
    return { sql: "", params: [] };
  }
  return { sql: `home_id NOT IN (${ids.map(() => "?").join(", ")})`, params: ids };
}

// New Record 系统的指标定义：sum 系按周期求和求最大，ratio 按命中率最大，
// count 按去重数量最大；cost 系按汇率折算后的可比金额最大。
const RECORD_METRICS = Object.freeze({
  totalTokens: { kind: "sum", field: "total", title: "总 tokens 最高" },
  inputTokens: { kind: "sum", field: "input", title: "总输入最高" },
  cachedTokens: { kind: "sum", field: "cached", title: "缓存读取最高" },
  outputTokens: { kind: "sum", field: "output", title: "输出最高" },
  reasoningTokens: { kind: "sum", field: "reasoning", title: "推理输出最高" },
  sessionCount: { kind: "count", field: "sessions", title: "会话最多" },
  modelCount: { kind: "count", field: "models", title: "模型数量最多" },
  cacheHitRate: { kind: "ratio", title: "缓存命中最高" },
  totalCost: { kind: "cost", field: "total", title: "估算花销最高" },
  inputCost: { kind: "cost", field: "input", title: "缓外输入花销最高" },
  cachedCost: { kind: "cost", field: "cached", title: "缓存输入花销最高" },
  outputCost: { kind: "cost", field: "output", title: "输出花销最高" },
});

const RECORD_UNIT_LABELS = Object.freeze({ day: "一日", week: "一周", month: "一个月" });

/**
 * M3.4：`perf_state` 的**取值域**。
 *
 * - `uninitialized`：`store_meta` 里**没有** `perf_state` 键（从未同步过）。
 *   **它不是持久化取值** —— 只是读取投影对"键缺失"的表达（AN-6：0/空 必须与键缺失可区分）。
 * - `rebuilding`：一次**有变更**的 sync 已经开始、整轮尚未成功结束。
 * - `ready`：整轮已启用来源成功完成。
 * - `degraded`：整轮结束但**部分受限**（主源文件不可读、坏帧/坏行致候选不完整，或单文件替换失败）。
 */
const PERF_STATES = Object.freeze(new Set(["rebuilding", "ready", "degraded"]));

/** 三态的具名常量（避免散落的字符串字面量漂移）。 */
const PERF_STATE_REBUILDING = "rebuilding";
const PERF_STATE_READY = "ready";
const PERF_STATE_DEGRADED = "degraded";

/**
 * 来源指纹的内容探测宽度：**首尾各 64KiB**。
 * 依据（我实测）：`size + mtimeMs` 无法检出"同尺寸 + 同 mtime tick 的原地改写"，
 * 而 SQLite 经常原地改写页面 ⇒ 必须补内容摘要。64KiB 足以覆盖 SQLite 文件头
 * （含 page count / change counter）与尾部新增页，成本固定、不随库大小增长。
 */
const CONTENT_PROBE_BYTES = 64 * 1024;

/**
 * M3.4 返工 **BB-1**：已启用来源的**主库 + WAL** 指纹（同步读取，供"读取前后比较"）。
 *
 * 用户明示"**主库＋WAL**"：ZCode 的新数据先落 `-wal`，**主库可能完全不变** ⇒ 只比主库会漏检。
 *
 * ⚠️ **我实测出 `size + mtimeMs` 本身不足**（这是这次返工中**我自己发现**的第二个缺口）：
 * ```
 * 同尺寸(4096→4096) + 同 mtime tick 的**原地改写** ⇒ size+mtime 指纹完全相同
 * ```
 * SQLite 恰恰**经常原地改写页面**（尺寸不变）⇒ 只靠 `size+mtime` 会漏检用户报告的
 * "追加记录后版本不变"。因此本指纹在 `size:mtime` 之外**再纳入内容摘要**
 * （`sha256` 覆盖主库 + `-wal` 的**首尾各 64KiB**，兼顾成本与灵敏度）。
 *
 * **同步**实现：要在**同一处**取前/后两次快照，因此用 `node:fs` 的**同步** API ——
 * 且**不可能**被 await 让出而被别的写入者插入（那正是本检测要抓的情形）。
 *
 * @param {string} kind 规范来源 kind
 * @param {string} filePath 物理文件路径
 * @returns {string | null} 指纹串；文件不存在/不可 stat ⇒ `null`（**不编造**，AQ-5）
 */
function enabledPerfSourceStat(kind, filePath) {
  if (!isPerfSourceEnabled(kind)) return null;
  try {
    const main = statSync(filePath);
    let size = main.size;
    let mtimeMs = main.mtimeMs;
    const walPath = `${filePath}-wal`;
    const wal = statSync(walPath, { throwIfNoEntry: false });
    const walSize = wal === undefined ? 0 : wal.size;
    if (wal !== undefined) {
      // 与 `zcodeSourceStat` 同一算法：`-wal` 计入大小、mtime 取较大者。
      size += wal.size;
      mtimeMs = Math.max(mtimeMs, wal.mtimeMs);
    }
    // 内容摘要：首尾各 64KiB（SQLite 头 + 追加/改写的尾部页都能覆盖）。
    const digest = createHash("sha256");
    /** @type {[string, number][]} */
    const contentParts = [
      [filePath, main.size],
      [walPath, walSize],
    ];
    for (const [file, fileSize] of contentParts) {
      if (fileSize <= 0) continue;
      const headLength = Math.min(fileSize, CONTENT_PROBE_BYTES);
      const head = openSync(file, "r");
      try {
        const buffer = Buffer.alloc(headLength);
        const read = readSync(head, buffer, 0, headLength, 0);
        digest.update(buffer.subarray(0, read));
        if (fileSize > CONTENT_PROBE_BYTES) {
          // 尾部（可能正是新追加的页所在）
          const tailLength = Math.min(fileSize, CONTENT_PROBE_BYTES);
          const tailBuffer = Buffer.alloc(tailLength);
          const tailRead = readSync(head, tailBuffer, 0, tailLength, fileSize - tailLength);
          digest.update(tailBuffer.subarray(0, tailRead));
        }
      } finally {
        closeSync(head);
      }
    }
    return `${size}:${mtimeMs}:${digest.digest("hex").slice(0, 32)}`;
  } catch {
    return null;
  }
}

/**
 * A readable enabled source needs extraction when its published candidates are
 * stale or when this version of the store has never published that file's
 * reader diagnostics. An empty warning array is a completed extraction.
 *
 * S2 卡（同稳定窗口的探针去重）：`reusedCurrent` 是**同一验证窗口**内已经取得的等价内容摘要。
 *
 * 实测口径（`S2\measure-s2-probes.mjs`）：一轮 `sync()` 对同一个 Codex rollout 会做多次
 * "内容是否变了"的判定 ——
 *   ① codex 回路的 `metadataChanged`（是否要重新规划该 home）；
 *   ② `planStableCodexHome` 的**读取前**摘要（`window.before.fileFingerprints`）；
 *   ③ `planStableCodexHome` 的**读取后**摘要（`window.after.fileFingerprints`）；
 *   ④ 逐文件循环的"要不要重解析这份文件的用量"判定；
 *   ⑤ 发布前复核（`windowPublish`）。
 *
 * ③ 与 ④ 之间**没有对该文件的任何读取**：③ 在整文件解析**之后**取，④ 只是决定"要不要再读一次"。
 * 两者属于**同一个"读取后"验证窗口** ⇒ ④ 直接复用 ③ 的摘要，不必再 stat + 读首尾 64KiB + sha256。
 *
 * 卡面边界（"前后/发布窗口分别新鲜"）——本卡**刻意不**做两件事：
 *   * 不把 ① 的摘要喂给 ②：② 是稳定性判据的**前半**，喂给它会把检测区间从"读取期间"放宽到
 *     "上一条判定之后"，把当前能成功发布的轮次误报成 `LIVE_SOURCE_CHANGED`；
 *   * 不把 ③ 的摘要喂给 ⑤：⑤ 的**职责**就是再取一次快照，喂给它会让发布前复核恒真、
 *     读取期间变化检测静默失效。
 *
 * 窗口失效（`plan` 不稳定/不可用、该文件不在窗口内、或来源身份规范后不是 codex）⇒ 调用方拿不到
 * 复用值（`undefined`）⇒ **重新探针**（即修复前行为）。
 *
 * @param {string} kind
 * @param {string} filePath
 * @param {Record<string, string>} publishedFingerprints
 * @param {Record<string, {sourceKind: string, homeId: string, code: string, count: number}[]>} publishedWarnings
 * @param {string | undefined} [reusedCurrent] 复用值；`undefined` ⇒ 真实探针
 */
function perfFileNeedsExtraction(kind, filePath, publishedFingerprints, publishedWarnings, reusedCurrent) {
  const current = reusedCurrent === undefined ? enabledPerfSourceStat(kind, filePath) : reusedCurrent;
  if (current === null) return false;
  return (
    publishedFingerprints[filePath] === undefined ||
    current !== publishedFingerprints[filePath] ||
    !Object.hasOwn(publishedWarnings, filePath)
  );
}

function perfFileNeedsRefresh(kind, filePath, publishedFingerprints, publishedWarnings, reusedCurrent) {
  if (canonicalizeKind(kind) !== "codex") {
    return perfFileNeedsExtraction(kind, filePath, publishedFingerprints, publishedWarnings, reusedCurrent);
  }
  const current = reusedCurrent === undefined ? enabledPerfSourceStat(kind, filePath) : reusedCurrent;
  return (
    current !== null && (publishedFingerprints[filePath] === undefined || current !== publishedFingerprints[filePath])
  );
}

/**
 * S2 卡：**规范物理路径** —— 复用摘要的键必须是物理文件本身，而不是它的某种写法。
 *
 * 只做绝对化 + Windows 大小写折叠。**不做** `realpath`：那会引入额外 I/O，并且会把符号链接与
 * `-wal` 折叠的语义从"路径"改成"目标"，而指纹算法本身要求按**调用方给的路径**读 `-wal`。
 * @param {string} filePath
 */
function canonicalPerfProbePath(filePath) {
  const text = String(filePath ?? "");
  if (text === "") return text;
  const resolved = path.resolve(text);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * C1 卡：**确定性内容失败码** —— 由文件内容本身决定、重试不会自愈的失败。
 *
 * 卡面明文"**仅稳定验证完成的确定性失败可复用**"，因此这里用**允许清单**而不是排除清单：
 * 只有列出的码才可能进入稳定失败尝试记录。**刻意排除**（卡面"`LIVE_SOURCE_CHANGED`、读取失败和
 * 发布失败不缓存为可跳过状态"）：
 *   * `READ_ONLY_OPEN_FAILED`（读取失败：占用/权限/IO ⇒ 瞬态，必须保留恢复路径）；
 *   * `LIVE_SOURCE_CHANGED`（读取期间来源变化 ⇒ 本轮判定"不可证"，绝不缓存）；
 *   * `OPTIONAL_SOURCE_UNAVAILABLE` 与任何未冻结码 —— `perfWarningCodeForError` 会把未冻结码
 *     折成 `READ_ONLY_OPEN_FAILED`，因此"未知原因"天然落在允许清单之外。
 */
const CODEX_DETERMINISTIC_FAILURE_CODES = Object.freeze(
  new Set(["MALFORMED_JSON", "MALFORMED_FRAME", "UNSUPPORTED_SCHEMA", "UNKEYABLE_RECORD", "AGGREGATE_OVERFLOW"]),
);

/**
 * C1 卡：稳定失败记录的**方法版本**（解析方法 + 发布策略）。
 *
 * 卡面"签名包含 home、完整排序路径集、内容指纹和**方法版本**"、"方法版本改变立即重试"：
 * 解析器口径（`PERF_METHOD_VERSION`）或发布策略修订（`CODEX_PUBLICATION_POLICY_REVISION`）任一
 * 变化 ⇒ 旧记录在命中判定里立即失配并被清除。
 */
function codexStableAttemptMethodVersion() {
  return `${PERF_METHOD_VERSION}:${CODEX_PUBLICATION_POLICY_REVISION}`;
}

/**
 * C1 卡：一个 Codex home 的**当前内容签名**（排序后的完整路径集 + 逐文件内容指纹）。
 *
 * 逐文件用 {@link enabledPerfSourceStat} —— 它与 `usage-core.js` 的 `perfContentFingerprint` 是
 * **逐字镜像**（同 `-wal` 折叠、同首尾各 64KiB 摘要、同 `size:mtimeMs:digest.slice(0,32)` 串形，
 * S2 已按同一算法对齐并有对拍测试），因此这里取到的指纹串与 `planStableCodexHome()` 返回的
 * `window.after.fileFingerprints` **可直接逐字比较**，无需再引入共享探针服务或新导出。
 *
 * 内容探针**不是**全文解析：成本固定为首尾各 64KiB（卡面"内容探针字节另计"）。
 * 任一文件取不到指纹（不可读）⇒ 返回 `null`：签名**不可证** ⇒ 调用方必须重新规划。
 *
 * @param {string} kind 发现时给出的原始 kind（`main`/`codex` 等同义别名）
 * @param {string[]} filePaths
 * @returns {{ paths: string[], fileFingerprints: Record<string, string> } | null}
 */
function codexHomeContentSignature(kind, filePaths) {
  const paths = [...filePaths].sort();
  /** @type {Record<string, string>} */
  const fileFingerprints = {};
  for (const filePath of paths) {
    const fingerprint = enabledPerfSourceStat(kind, filePath);
    if (fingerprint === null) return null;
    fileFingerprints[filePath] = fingerprint;
  }
  return { paths, fileFingerprints };
}

/**
 * C4 卡：**"这个线程必须重新构建候选吗？"** —— 这是"只构建/发布受影响线程"的**唯一**判据。
 *
 * 候选是 `(homeId, threadId, 排序后的 rollout 投影集)` 的**纯函数**：`buildCodexThreadPerfSamples()`
 * 只读入参，不读时间、不读全局、不读磁盘（它的入参是 planner 已经证明过的标准化投影）。
 * 因此三个**可判定身份**分量逐字相同 ⇒ 入参逐字相同 ⇒ 候选逐字相同 ⇒ **无需重建**。
 *
 * 身份分量（与 C3 的投影复用同一纪律：可判定、不绑时间、不绑全局、`undefined` 一律当"要建"）：
 *   ① **归属**：`threadId` 必须**已经发布过**（`perf_rollout_threads` / 已发布候选的归属）。
 *      新线程、身份重归属（同一物理文件改挂到另一个 threadId）、跨 home 迁移 ⇒ 未发布过 ⇒ 必建。
 *   ② **依赖集合**：当前**完整** rollout 路径集（含归档片段在内的全部物理 rollout）必须与已发布的
 *      逐字相同 —— 新增 / 删除 / 重命名 / 归档迁移都会让集合不同 ⇒ 必建。
 *   ③ **内容**：每个 rollout 的**本轮读取后**指纹必须与**已提交**指纹（产生当前候选的那一次发布）
 *      逐字相同。已提交指纹只在"该线程被发布"时写入（`replaceFile` 对 codex **不写**指纹）⇒
 *      `undefined` 即"从未发布过" ⇒ 必建。
 *
 * ⚠️ **不得**把任一分量换成"上一轮的结论"（跨轮粘缓存是明确错误）：`afterFingerprints` 是本轮
 * 稳定窗口**刚刚**取得的摘要，`publishedFingerprints` 是库里已提交的事实，二者比较才是判据。
 *
 * @param {{ threadId: string, rolloutFiles: string[] }} thread 当前线程（`rolloutFiles` 已排序、完整）
 * @param {Set<string>} oldThreadIds 已发布过的线程 id
 * @param {Map<string, Set<string>>} oldPathsByThread 已发布线程 → 其完整物理路径集
 * @param {Record<string, string>} afterFingerprints 本轮**读取后**稳定窗口的逐文件指纹
 * @param {Record<string, string>} publishedFingerprints 已提交的逐文件指纹
 * @returns {boolean} `true` = 必须重新构建（`false` = 可原样复用已发布候选）
 */
function codexThreadNeedsBuild(thread, oldThreadIds, oldPathsByThread, afterFingerprints, publishedFingerprints) {
  if (!(oldThreadIds instanceof Set) || !oldThreadIds.has(thread.threadId)) return true;
  const oldPaths = oldPathsByThread instanceof Map ? oldPathsByThread.get(thread.threadId) : undefined;
  // 有归属却取不到路径集 ⇒ 不可判定 ⇒ 重算（绝不假设"没变"）。
  if (!(oldPaths instanceof Set) || oldPaths.size !== thread.rolloutFiles.length) return true;
  for (const filePath of thread.rolloutFiles) {
    if (!oldPaths.has(filePath)) return true;
    const after = afterFingerprints?.[filePath];
    if (typeof after !== "string" || after !== publishedFingerprints?.[filePath]) return true;
  }
  return false;
}

/**
 * M3.4 返工 **BB-3** + 返工2 **BC-2**：`perf_index_version` 的取值。
 *
 * **Lead 更正的 D3 定义**：版本号**不得**只是"来源集合标识"，必须纳入**已发布文件指纹**。
 * **用户第二轮复现（BC-2）**："**不要在整轮结束时重新 stat 上游并把它称作发布指纹。**"
 *
 * ⇒ 本函数**不再 stat 上游**。它聚合：
 *   ① 参与性能索引的来源身份；
 *   ② 已提交的物理文件归属；
 *   ③ 已在文件事务内提交的指纹（`perf_file_fingerprints`，随候选 COMMIT/ROLLBACK）。
 * Codex 的 homes/files 由调用方按 `perf_rollout_threads` 过滤，避免把已发现但未发布的 rollout
 * 混入版本；其他来源继续使用 `source_files` 与本轮启用 home 集合。
 *
 * 语义后果（正是卡片要求的四条）：
 * - **失败回滚保留旧指纹**：事务回滚 ⇒ 映射未变 ⇒ 版本不变；
 * - **真实删除移除分量**：`sync()` 删除 `source_files` 行时也从指纹映射清除该文件（见 `sync()`）；
 * - **成功发布 ⇒ 版本变化**：新指纹随同一次 `COMMIT` 生效 ⇒ 版本随内容变；
 * - **未启用来源不影响**：其 `kind` 不满足 `isPerfSourceEnabled` ⇒ 不入聚合。
 *
 * @param {ReadonlyArray<{id?: string, kind?: string, sourceKind?: string, path?: string, usageLogPath?: string}>} homes
 * @param {Record<string, string>} publishedFingerprints 已提交的 `path → 指纹` 映射
 * @param {ReadonlyArray<{path?: string, kind?: string, home_id?: string, home_path?: string}>} publishedFiles
 */
function buildPublishedSourcesFingerprint(homes, publishedFingerprints, publishedFiles = []) {
  const byPath = publishedFingerprints || {};
  const parts = [];
  const rowsByHome = new Map();
  for (const row of publishedFiles || []) {
    const key = `${canonicalizeKind(row?.kind)}\u0000${String(row?.home_id ?? "")}`;
    const rows = rowsByHome.get(key) || [];
    rows.push(row);
    rowsByHome.set(key, rows);
  }
  for (const home of homes || []) {
    const kind = canonicalizeKind(String(home?.kind ?? home?.sourceKind ?? ""));
    if (!isPerfSourceEnabled(kind)) continue;
    const homeId = String(home?.id ?? "");
    const homePath = typeof home?.path === "string" ? home.path : "";
    // Home identity remains present even when discovery finds zero physical files.
    parts.push(JSON.stringify(["home", kind, homeId]));
    const rows = rowsByHome.get(`${kind}\u0000${homeId}`) || [];
    for (const row of rows) {
      if (homePath !== "" && String(row?.home_path ?? "") !== homePath) continue;
      const filePath = String(row?.path ?? "");
      if (filePath === "") continue;
      // The published fingerprint is written in the same transaction as the
      // candidate rows. Missing means the physical file has not been extracted
      // successfully; never restat upstream while constructing this version.
      parts.push(JSON.stringify(["file", kind, homeId, filePath, byPath[filePath] ?? "unpublished"]));
    }
  }
  const unique = [...new Set(parts)].sort();
  return createHash("sha256").update(unique.join("\n")).digest("hex");
}

/**
 * M3.4：把**逐文件失败**投影成只含编码后四字段的源告警列表。
 *
 * **卡片明文**："仅 API 投影编码后的 `sourceKind/homeId/code/count`，**不输出路径**"。
 *
 * ⚠️ **必须按失败文件归因，不得按"本轮扫描过的 home"归因** —— 我第一版用后者，
 * 实测出**误归因**：home-A 成功、home-B 失败，结果**两个 home 都被记成 `INDEX_FAILED`**。
 * 这违反 AN-6（"每一个持久化的数字/归因都必须可追溯到一次真实计算"）。⇒ 改为在
 * `sync()` 循环里**只对真正抛错的那个文件**记一条。
 *
 * `count` = **同一 (sourceKind, homeId, code) 的失败文件数**（真实计数，不是常量 1）。
 * 失败文件的**原文告警**（含路径）仍进 `sync()` 的内存 `warnings`（供 CLI 展示），
 * 但**绝不入 `store_meta`**。
 *
 * **BB-4**：`code` 由调用方给出且**必须落在 M1 冻结码域内**（见 `perfWarningCodeForError`）。
 * 归因键包含 `code` ⇒ `LIVE_SOURCE_CHANGED` 与 `READ_ONLY_OPEN_FAILED` 各成一条，不互相覆盖。
 * @param {{sourceKind: string, homeId: string, code?: string, sourcePath?: string}[]} failures
 */
function projectSourceFailures(failures) {
  if (!failures || failures.length === 0) return [];
  const counts = new Map();
  const countedPaths = new Map();
  for (const failure of failures) {
    const homeId = String(failure?.homeId ?? "").trim();
    const sourceKind = String(failure?.sourceKind ?? "").trim();
    const code = String(failure?.code ?? "").trim();
    // 取不到 home 时**不编造**归因（不写空 id 占位），直接跳过 —— 宁缺勿错（AN-6）。
    if (homeId === "") continue;
    // 码缺失时**不猜**（不落一个不在冻结域内的码）⇒ 直接跳过并在下面由断言守住。
    if (code === "") continue;
    const key = `${sourceKind}\u0000${homeId}\u0000${code}`;
    const sourcePath = typeof failure?.sourcePath === "string" ? failure.sourcePath : "";
    if (sourcePath !== "") {
      const paths = countedPaths.get(key) || new Set();
      if (paths.has(sourcePath)) continue;
      paths.add(sourcePath);
      countedPaths.set(key, paths);
    }
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => {
    const [sourceKind, homeId, code] = key.split("\u0000");
    return { sourceKind, homeId, code, count };
  });
}

/**
 * Aggregate persisted reader diagnostics and file failures into the public
 * four-field warning shape. Reader counts are per-file counts and must be
 * summed, while file failures without a count contribute one each.
 * @param {{sourceKind: string, homeId: string, code?: string, count?: number}[]} entries
 */
function projectSourceWarnings(entries) {
  if (!entries || entries.length === 0) return [];
  const counts = new Map();
  for (const entry of entries) {
    const homeId = String(entry?.homeId ?? "").trim();
    const sourceKind = String(entry?.sourceKind ?? "").trim();
    const code = String(entry?.code ?? "").trim();
    if (homeId === "" || sourceKind === "" || code === "") continue;
    const rawCount = Number(entry?.count ?? 1);
    const count = Number.isSafeInteger(rawCount) && rawCount > 0 ? rawCount : 1;
    const key = `${sourceKind}\u0000${homeId}\u0000${code}`;
    counts.set(key, (counts.get(key) || 0) + count);
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [sourceKind, homeId, code] = key.split("\u0000");
      return { sourceKind, homeId, code, count };
    })
    .sort(
      (a, b) =>
        a.sourceKind.localeCompare(b.sourceKind) || a.homeId.localeCompare(b.homeId) || a.code.localeCompare(b.code),
    );
}

/** 读取投影中额外允许的**非持久化**取值（仅表示"键缺失"）。 */
const PERF_STATE_UNINITIALIZED = "uninitialized";

/**
 * M3.4 返工 **BB-4**：把 `replaceFile` 抛出的错误映射到 **M1 冻结告警码**。
 *
 * **用户的复现**：原实现硬写 `INDEX_FAILED`，把它交给**真实 `summarizePerf`** 会直接抛
 * `TypeError: sourceWarnings.code INDEX_FAILED is outside the frozen §3:83 domain`
 * ⇒ **形状一致 ≠ 码域兼容**（Lead 更正 BA-4）。
 *
 * **我实测出的关键事实（这决定了本裁决）**：reader **已经**在自己的错误对象上带了**冻结码**：
 * ```
 * 坏文件（非 SQLite）→ ZcodeReadOnlyOpenError, code = "READ_ONLY_OPEN_FAILED"
 * 缺表（空 SQLite）  → ZcodeReadOnlyOpenError, code = "UNSUPPORTED_SCHEMA"
 * 文件不存在         → ZcodeReadOnlyOpenError, code = "READ_ONLY_OPEN_FAILED"
 * ```
 * ⇒ **无需新增码、无需解冻 M1**：应当**透传 reader 自己的码**（它比本层更懂失败原因），
 * 这也天然满足"按**实际失败原因**使用冻结编码"。
 *
 * **兜底**：非 reader 的失败（如 SQLite 层的 `ERR_SQLITE_ERROR`/FK 787）在冻结域内**最接近**
 * `READ_ONLY_OPEN_FAILED` —— 其语义是"**只读读取该来源失败**"。⚠️ **我登记其中的语义偏差**：
 * FK/约束类错误严格说不是"open failed"，但它是**读该来源文件失败**这一上位概念，
 * 且**八码中无一更贴切**（`UNSUPPORTED_SCHEMA` 专指结构不符、`MALFORMED_*` 专指帧/行解析）。
 * ⇒ 选择"复用 + 显式登记偏差"，**而非自行新增码**（那需要用户批准解冻 M1）。
 * @param {any} error
 */
function perfWarningCodeForError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  // reader 自己的冻结码优先（`ZcodeReadOnlyOpenError.code` / `OpencodePerfReadError.code`）。
  if (PERF_SOURCE_WARNING_CODES.has(code)) return code;
  return "READ_ONLY_OPEN_FAILED";
}

/**
 * 把 discovery 给出的原始 kind 规范化成**规范 perf kind**（`extra`/`main` → `codex`），
 * 与 `classifyPerfSources` 的口径一致，避免 `unsupportedSources` 用 `codex` 而归因用 `extra`。
 * @param {string} kindRaw
 */
function canonicalizeKind(kindRaw) {
  try {
    return canonicalPerfSourceKind(kindRaw);
  } catch {
    return String(kindRaw ?? "");
  }
}

// ---------------------------------------------------------------------------
// T1：Codex 标准化投影的**私有持久化读写接缝**（`handoffs/T1-design.md` §2/§4）。
//
// ⚠️ 本段只**提供**接缝。**T2（2026-10-09）已接线**：接点是 `open()` 尾部的一行
// `this.codexProjections = createPersistentCodexProjectionCache({ … })`（见该行前后注释）
// —— 必须在 `open()` 里而不是构造器里：构造器里 `this.database` 还是 `null`（见 `:1784`），
// 那时接线只会拿到 `database = null` ⇒ 退化成纯内存缓存（缺口一个都不闭合）。`open()` 尾部也是
// **唯一**能保证 `perf_codex_projections` 已存在的位置（v13→14 迁移 / v0 建库都在 `migrate` 段）。
// planner 的调用点一个都没改（`:3022` `retainHomes`、`:3200` 传 `projectionCache`、
// `:3202-3204` `commit/rollback/prune`、`:4684` `clear()`），因此 `planStableCodexHome` 的签名行
// （B2 锚点）逐字节不变。
// ---------------------------------------------------------------------------

/** 私有表名（唯一；写进报告）。 */
export const CODEX_PROJECTION_STORE_TABLE = "perf_codex_projections";

/**
 * T1：`src/perf-sources/codex-thread.js:293-298` 的 `canonicalProjectionPath()` 的**逐字节镜像**。
 *
 * 为什么必须镜像而不是只 `path.resolve()`（设计页 §0 修订 1②）：持久表的 `path` 主键必须
 * **等于内存缓存的键**（`entries()[].path`，见 `codex-thread.js:518`）。只 resolve 的话，同一物理
 * 文件的两种大小写写法会落成**两行**、且 DB 键 ≠ 内存键，而 `prune(homeId, expectedPaths)`
 * （`:481` 用同一个规范化函数）又会按内存键去删 ⇒ 行删不掉。
 *
 * 不能直接 import：该函数未导出，且改 `codex-thread.js` 属 T2 范围；本仓对此有既有惯例
 * ——"镜像 + 对拍测试"（`codex-thread.js:289-290` 的自述）。对拍在
 * `test/perf-projection-store.test.js`：拿真实 `createCodexProjectionCache().entries()` 逐字节比对，
 * **不许**只靠"看起来一样"。
 */
function canonicalProjectionStorePath(filePath) {
  const text = String(filePath ?? "");
  if (text === "") return text;
  const resolved = path.resolve(text);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * T1：`codex-thread.js:352-373`（`indexFor` + `currentFingerprint`）的**逐字节镜像**。
 *
 * 指纹是投影的身份来源，持久行只在"与内存 `lookup()` 收到的同一份指纹逐字节相同"时才可复用。
 * `indexFor` 的**对象身份绑定**必须一并镜像：换指纹对象即重建索引，否则"路径 → 指纹"会停在上一轮
 * 的取值上，让一个**真变了**的文件因旧指纹恰好等于旧条目而被当作未变（那正是 `:347-351` 要防的
 * "粘缓存"错误）。`Object.hasOwn` 快路径也要镜像：它是"发现路径与窗口键逐字相同"的零分配分支，
 * 返回值可能与折叠后的索引取值不同（大小写变体），两条路径必须各自对拍。
 * @returns {(fingerprints: Record<string, string> | null | undefined, filePath: string) => string | undefined}
 */
function createProjectionFingerprintReader() {
  let pathIndex = null;
  return (fingerprints, filePath) => {
    if (!fingerprints || typeof fingerprints !== "object") return undefined;
    if (Object.hasOwn(fingerprints, filePath)) {
      const direct = fingerprints[filePath];
      return typeof direct === "string" && direct !== "" ? direct : undefined;
    }
    if (!pathIndex || pathIndex.forFingerprints !== fingerprints) {
      const byPath = new Map();
      for (const [candidate, fingerprint] of Object.entries(fingerprints)) {
        byPath.set(canonicalProjectionStorePath(candidate), fingerprint);
      }
      pathIndex = { forFingerprints: fingerprints, byPath };
    }
    const value = pathIndex.byPath.get(canonicalProjectionStorePath(filePath));
    return typeof value === "string" && value !== "" ? value : undefined;
  };
}

/**
 * T1：`codex-thread.js:307-313` 的 `projectionByteEstimate()` 的**逐字节镜像**（设计页 §6.2 要求
 * "字节口径与内存同一个函数"必须是被测到的事实，不是声明）。对拍见 `test/perf-projection-store.test.js`
 * （与真实缓存的 `entries()[].bytes` / `stats().bytes` 比对）。
 *
 * 第二个形参只为**避免重复序列化**：`stage()` 必须先把投影序列化成落盘的 `projection` 文本，传入它即可
 * —— `serialized.length` 与 `JSON.stringify(projection).length` 逐字节相同。
 * @param {unknown} projection
 * @param {string} [serialized]
 */
export function projectionStoreByteEstimate(projection, serialized) {
  if (typeof serialized === "string") return serialized.length;
  try {
    return JSON.stringify(projection)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * T1：把内存投影缓存（`createCodexProjectionCache()`，`codex-thread.js:328`）包上**私有持久层**。
 *
 * 与内存缓存**一一对应**（设计页 §4）：
 *   * `lookup` → 内存未命中时查私有表；命中即**水合**（交回内存缓存，等稳定窗口 `commit` 提升）；
 *   * `stage` → 透传内存，并记下"本轮真实读到"的行，**只有 `commit` 才落盘**；
 *   * `commit` → 内存提升 + 该 home 的行在**同一事务**内写库（失败整体回滚 ⇒ 不留半行）；
 *   * `rollback` → 内存丢弃 + **不写库**（失效即重算）；
 *   * `prune(homeId, expectedPaths)` → 删本 home 不在当前路径集的行；
 *   * `retainHomes(ids)` → 删其余 home 的行；**只保留当前版本**（path 是主键，插入即替换）；
 *   * `clear()` → 只清内存侧；**不清表**（跨实例复用正是 T2 的目的）。
 *
 * 失败降级：持久层是**缓存**，来源才是事实 ⇒ 任何读写失败都**不抛**、不打断 sync；blob 损坏即
 * **miss + 删该行**（"失效即重算"）。债以计数器暴露（`stats().persistence`），不静默吞掉。
 *
 * @param {{
 *   database?: import("node:sqlite").DatabaseSync | null,
 *   inner?: ReturnType<typeof createCodexProjectionCache>,
 *   methodVersion?: string,
 *   now?: () => string,
 * }} [options]
 */
export function createPersistentCodexProjectionCache({
  database = null,
  inner = createCodexProjectionCache(),
  methodVersion,
  now = () => new Date().toISOString(),
} = {}) {
  // 缺省取内存缓存**自己**报告的方法版本（`stats().methodVersion` =
  // `${PERF_METHOD_VERSION}:${CODEX_PROJECTION_METHOD_VERSION}`，`codex-thread.js:282-284`）——
  // 它正是 `lookup()` 在 `:418` 比较的、`entries()` 在 `:518` 暴露的**同一个字符串**。
  // 显式传入只为测试能分别 bump 两个组成部分（设计页 §6.2）。
  const currentMethodVersion = String(methodVersion ?? inner.stats().methodVersion);
  const fingerprintOf = createProjectionFingerprintReader();
  /** homeId → Map<规范路径, 待落盘行>：**只**记本轮真实 `stage()` 的条目（水合回来的不重写）。 */
  const freshRows = new Map();
  let savepointCounter = 0;
  const counters = {
    persistedRows: 0,
    hydratedRows: 0,
    prunedRows: 0,
    retainedRows: 0,
    invalidatedRows: 0,
    corruptRows: 0,
    staleFingerprintRows: 0,
    foreignHomeRows: 0,
    kindMismatchRows: 0,
    writeFailures: 0,
    writeTransactions: 0,
  };

  const SELECT_ROW =
    "SELECT home_id, kind, method_version, fingerprint, bytes, projection FROM perf_codex_projections WHERE path = ?";
  const DELETE_ROW = "DELETE FROM perf_codex_projections WHERE path = ?";
  const COUNT_ROWS = "SELECT COUNT(*) AS n FROM perf_codex_projections";
  const UPSERT_ROW = `INSERT INTO perf_codex_projections
      (path, home_id, kind, method_version, fingerprint, bytes, projection, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      home_id = excluded.home_id,
      kind = excluded.kind,
      method_version = excluded.method_version,
      fingerprint = excluded.fingerprint,
      bytes = excluded.bytes,
      projection = excluded.projection,
      updated_at = excluded.updated_at`;

  /**
   * 一批写操作包在**一个事务**里（用 `SAVEPOINT` 而不是 `BEGIN`：`SAVEPOINT` 在"外层已有事务"时
   * 同样正确嵌套、外层没有事务时 `RELEASE` 就是真实提交，因此无论 `UsageStore` 的调用时序如何都
   * 不会出现 "cannot start a transaction within a transaction"）。任何失败 ⇒ 回滚到该保存点 +
   * 计 `writeFailures` + 返回 `false`，**不抛**。
   * @param {() => void} work
   */
  const runInSavepoint = (work) => {
    if (!database) return false;
    savepointCounter += 1;
    const name = `t1_projection_write_${savepointCounter}`;
    let begun = false;
    try {
      database.exec(`SAVEPOINT ${name}`);
      begun = true;
      work();
      database.exec(`RELEASE ${name}`);
      counters.writeTransactions += 1;
      return true;
    } catch {
      if (begun) {
        // 连接已不可用 ⇒ 回滚也会抛；SQLite 在关闭时会丢弃未提交事务（"不留半行"由它兜底）。
        try {
          database.exec(`ROLLBACK TO ${name}`);
        } catch {
          /* 已在上面登记 writeFailures；这里不再二次抛 */
        }
        try {
          database.exec(`RELEASE ${name}`);
        } catch {
          /* 同上 */
        }
      }
      counters.writeFailures += 1;
      return false;
    }
  };

  /** 删单行（定向失效）。失败不抛。 */
  const deleteRow = (canonicalPath) => {
    if (!database) return false;
    try {
      database.prepare(DELETE_ROW).run(canonicalPath);
      return true;
    } catch {
      counters.writeFailures += 1;
      return false;
    }
  };

  /** 只读计数；失败返回 `null`（区别于"0 行"）。 */
  const readRowCount = () => {
    if (!database) return null;
    try {
      return Number(database.prepare(COUNT_ROWS).get()?.n ?? 0);
    } catch {
      counters.writeFailures += 1;
      return null;
    }
  };

  return {
    /** 见 `codex-thread.js:397`：`undefined` = "不可复用" ⇒ 调用方必须走真实全文读。 */
    /**
     * @param {{homeId?: string, kind?: string, filePath?: string, fingerprints?: Record<string, string>, methodVersion?: string}} [options={}]
     */
    lookup({ homeId, kind, filePath, fingerprints, methodVersion: requestedMethodVersion } = {}) {
      // ① 先走内存（与今日逐字节同一条路径；命中就连指纹都不再算）。
      const memory = inner.lookup({ homeId, kind, filePath, fingerprints, methodVersion: requestedMethodVersion });
      if (memory !== undefined) return memory;
      // ② 只有 codex rollout 才有这张表（与 `:399` 的来源守卫同款）。
      if (canonicalizeKind(kind) !== "codex") return undefined;
      const canonicalPath = canonicalProjectionStorePath(filePath);
      if (canonicalPath === "") return undefined;
      // ③ 本轮窗口必须**已经**取得"读取前"指纹（`:402-404` 同款守卫）：没有 ⇒ 不可复用。
      const fingerprint = fingerprintOf(fingerprints, /** @type {string} */ (filePath));
      if (fingerprint === undefined) return undefined;
      if (!database) return undefined;
      let row;
      try {
        row = database.prepare(SELECT_ROW).get(canonicalPath);
      } catch {
        counters.writeFailures += 1;
        return undefined;
      }
      if (row === undefined) return undefined;
      const expectedMethodVersion = String(requestedMethodVersion ?? currentMethodVersion);
      // ④ 逐条**定向**失效（**绝不**无条件标脏全库）：三类不符各删该行并计数，然后当作 miss。
      if (String(row.method_version) !== expectedMethodVersion) {
        deleteRow(canonicalPath);
        counters.invalidatedRows += 1;
        return undefined;
      }
      if (String(row.fingerprint) !== fingerprint) {
        deleteRow(canonicalPath);
        counters.staleFingerprintRows += 1;
        return undefined;
      }
      if (String(row.home_id) !== String(homeId ?? "")) {
        deleteRow(canonicalPath);
        counters.foreignHomeRows += 1;
        return undefined;
      }
      if (canonicalizeKind(/** @type {string} */ (row.kind)) !== canonicalizeKind(kind)) {
        deleteRow(canonicalPath);
        counters.kindMismatchRows += 1;
        return undefined;
      }
      // ⑤ 损坏 blob ⇒ miss + 删行，**不抛**（`JSON.parse` 抛错会被这里接住，sync 不被打断）。
      let projection;
      try {
        projection = JSON.parse(String(row.projection));
      } catch {
        projection = undefined;
      }
      if (!projection || typeof projection !== "object") {
        deleteRow(canonicalPath);
        counters.corruptRows += 1;
        return undefined;
      }
      // ⑥ 水合：交回内存缓存（只有稳定窗口的 `commit()` 才会把它提升为可复用条目）。**不**记入
      // `freshRows` ⇒ `commit()` 不会把这些行再写一遍（否则每轮都是全表写放大）。
      inner.stage({ homeId, kind, filePath, fingerprints, projection, methodVersion: expectedMethodVersion });
      counters.hydratedRows += 1;
      return projection;
    },

    /** 透传内存 `stage()`，并把"本轮真实读到"的行记下（落盘延迟到 `commit`）。 */
    stage(args = {}) {
      const ok = inner.stage(args);
      if (!ok) return false;
      const canonicalPath = canonicalProjectionStorePath(args.filePath);
      const id = String(args.homeId ?? "");
      let text;
      try {
        text = JSON.stringify(args.projection);
      } catch {
        text = undefined;
      }
      // 不可序列化的投影不落盘（内存侧仍然可用）：本函数的返回语义只关于内存暂存是否成功。
      if (canonicalPath === "" || text === undefined) return true;
      let bucket = freshRows.get(id);
      if (bucket === undefined) {
        bucket = new Map();
        freshRows.set(id, bucket);
      }
      bucket.set(canonicalPath, {
        path: canonicalPath,
        home_id: id,
        kind: canonicalizeKind(args.kind),
        method_version: String(args.methodVersion ?? currentMethodVersion),
        fingerprint: fingerprintOf(args.fingerprints, args.filePath),
        bytes: projectionStoreByteEstimate(args.projection, text),
        projection: text,
        updated_at: now(),
      });
      return true;
    },

    /** 稳定窗口成立 ⇒ 内存提升 + 本 home 的行**单事务**落盘。 */
    commit(homeId) {
      const promoted = inner.commit(homeId);
      const id = String(homeId ?? "");
      const bucket = freshRows.get(id);
      freshRows.delete(id);
      if (bucket === undefined || bucket.size === 0) return promoted;
      const rows = [...bucket.values()];
      const ok = runInSavepoint(() => {
        const statement = database.prepare(UPSERT_ROW);
        for (const row of rows) {
          statement.run(
            row.path,
            row.home_id,
            row.kind,
            row.method_version,
            row.fingerprint,
            row.bytes,
            row.projection,
            row.updated_at,
          );
        }
      });
      if (ok) counters.persistedRows += rows.length;
      return promoted;
    },

    /** 窗口不可证/不稳定 ⇒ 内存丢弃 + **不写库**。 */
    rollback(homeId) {
      const had = inner.rollback(homeId);
      freshRows.delete(String(homeId ?? ""));
      return had;
    },

    /** 只保留该 home 当前的物理文件集（替换 / 删除 / 重命名淘汰），内存与库同一条契约。 */
    prune(homeId, filePaths) {
      const dropped = inner.prune(homeId, filePaths);
      const id = String(homeId ?? "");
      const keep = new Set((filePaths ?? []).map(canonicalProjectionStorePath));
      const bucket = freshRows.get(id);
      if (bucket !== undefined) {
        for (const candidate of [...bucket.keys()]) if (!keep.has(candidate)) bucket.delete(candidate);
      }
      if (!database) return dropped;
      let victims;
      try {
        // 先只读选出受害者（**未命中就不开写事务** ⇒ 稳态轮不产生写放大），再单事务删。
        victims = database
          .prepare("SELECT path FROM perf_codex_projections WHERE home_id = ?")
          .all(id)
          .map((row) => String(row.path))
          .filter((candidate) => !keep.has(candidate));
      } catch {
        counters.writeFailures += 1;
        return dropped;
      }
      if (victims.length === 0) return dropped;
      const ok = runInSavepoint(() => {
        const statement = database.prepare(DELETE_ROW);
        for (const victim of victims) statement.run(victim);
      });
      if (ok) counters.prunedRows += victims.length;
      return dropped;
    },

    /** home 整体消失（来源移除 / 归档迁移 / 别名变化）⇒ 淘汰内存与库里它的全部条目。 */
    retainHomes(homeIds) {
      const dropped = inner.retainHomes(homeIds);
      const keep = new Set([...(homeIds ?? [])].map((homeId) => String(homeId)));
      for (const id of [...freshRows.keys()]) if (!keep.has(id)) freshRows.delete(id);
      if (!database) return dropped;
      let victims;
      try {
        if (keep.size === 0) {
          victims = database
            .prepare("SELECT path FROM perf_codex_projections")
            .all()
            .map((row) => String(row.path));
        } else {
          const placeholders = [...keep].map(() => "?").join(", ");
          victims = database
            .prepare(`SELECT path FROM perf_codex_projections WHERE home_id NOT IN (${placeholders})`)
            .all(...keep)
            .map((row) => String(row.path));
        }
      } catch {
        counters.writeFailures += 1;
        return dropped;
      }
      if (victims.length === 0) return dropped;
      const ok = runInSavepoint(() => {
        const statement = database.prepare(DELETE_ROW);
        for (const victim of victims) statement.run(victim);
      });
      if (ok) counters.retainedRows += victims.length;
      return dropped;
    },

    /**
     * 方法版本变更的**定向**失效：只删 `method_version <> 当前值` 的行，返回**前后行数**。
     *
     * 这是"只失效必要行、**严禁**无条件标脏全库"（卡面明文）的显式入口；`lookup()` 里那条同规则的
     * 逐行删除是它的按需版本。**不**动 `source_files` / `events` / `perf_samples` 一个字节。
     * @returns {{ before: number | null, after: number | null, deleted: number, methodVersion: string }}
     */
    invalidateStaleMethodVersions() {
      const before = readRowCount();
      let deleted = 0;
      if (database) {
        const ok = runInSavepoint(() => {
          deleted = Number(
            database.prepare("DELETE FROM perf_codex_projections WHERE method_version <> ?").run(currentMethodVersion)
              .changes ?? 0,
          );
        });
        if (!ok) deleted = 0;
      }
      counters.invalidatedRows += deleted;
      return { before, after: readRowCount(), deleted, methodVersion: currentMethodVersion };
    },

    /** 只清**内存**侧：设计页 §4 明文 `close()` **不清表**（跨实例复用正是 T2 的目的）。 */
    clear() {
      inner.clear();
      freshRows.clear();
    },

    /** 只读视图，透传内存（证据/测试用；调用方不得改写）。 */
    entries() {
      return inner.entries();
    },

    /** 当前生效的复合方法版本（= `entries()[].methodVersion`）。 */
    methodVersion() {
      return currentMethodVersion;
    },

    /**
     * 私有表的行数（诊断用，**另开**：刻意不进 `stats()`）。
     *
     * 为什么必须另开（C3 政策断言会踩到的陷阱）：`stats().entries` 是**纯内存**口径，C3 断言
     * "sync 后 entries === 3"、"close() 后 entries === 0"。持久化存在的意义正是"内存归零但投影不丢"
     * ⇒ 若把持久行也算进 `stats()`，那两条断言会因**表里的行**而虚高/不复零，语义也错。
     * @returns {number | null} `null` = 读不到（连接不可用）
     */
    persistedRowCount() {
      return readRowCount();
    },

    stats() {
      return {
        ...inner.stats(),
        persistence: { table: CODEX_PROJECTION_STORE_TABLE, methodVersion: currentMethodVersion, ...counters },
      };
    },
  };
}

/**
 * @typedef {object} PerfStateProjection
 * @property {"uninitialized" | "rebuilding" | "ready" | "degraded"} state
 * @property {string} indexVersion
 * @property {string} methodVersion
 * @property {string} indexedAt
 * @property {string[]} degradedHomeIds
 * @property {{sourceKind: string, homeId: string, code: string, count: number}[]} sourceWarnings
 * @property {string | undefined} codexPublicationPolicy
 */

/** 解码 `store_meta` 里的 JSON 字符串数组；缺键/坏值一律 `[]`（不抛错，读取路径不得因元数据坏掉而失败）。 */
function decodeJsonStringArray(raw) {
  if (raw === undefined || raw === "") return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => typeof entry === "string");
  } catch {
    return [];
  }
}

/**
 * 解码 `perf_source_warnings`。**只投影编码后的 `sourceKind/homeId/code/count`**，
 * **绝不输出路径**（卡片明文）。形状不符的条目**丢弃**而不是猜测补齐。
 * @returns {{sourceKind: string, homeId: string, code: string, count: number}[]}
 */
function decodeJsonWarnings(raw) {
  if (raw === undefined || raw === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      sourceKind: String(entry.sourceKind ?? ""),
      homeId: String(entry.homeId ?? ""),
      code: String(entry.code ?? ""),
      count: Number.isFinite(Number(entry.count)) ? Number(entry.count) : 0,
    }));
}

/** 退化 home id 规范化：去空白、去空串、去重、稳定排序（保证同输入同持久值）。 */
function normalizeDegradedHomeIds(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((entry) => String(entry).trim()).filter((entry) => entry !== ""))].sort();
}

/**
 * 源告警规范化：**只保留 `sourceKind/homeId/code/count` 四个字段**，
 * 从而在结构上保证**不写出路径**（即使上游多传了 `path` 也会被丢弃）。
 */
function normalizeSourceWarnings(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => ({
      sourceKind: String(entry?.sourceKind ?? "").trim(),
      homeId: String(entry?.homeId ?? "").trim(),
      code: String(entry?.code ?? "").trim(),
      count: Number.isFinite(Number(entry?.count)) ? Number(entry.count) : 0,
    }))
    .filter((entry) => entry.sourceKind !== "" || entry.homeId !== "" || entry.code !== "");
}

function recordUnitBoundaries(key, unit, zone = "local") {
  if (unit === "day") {
    const start = parseDateKey(key, zone);
    return start ? [start.getTime(), addDaysMs(start, 1)] : null;
  }
  if (unit === "week") {
    const start = parseDateKey(key, zone);
    return start ? [start.getTime(), addDaysMs(start, 7)] : null;
  }
  const match = /^(\d{4})-(\d{2})$/.exec(key || "");
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  return zone === "utc"
    ? [Date.UTC(year, month, 1), Date.UTC(year, month + 1, 1)]
    : [new Date(year, month, 1).getTime(), new Date(year, month + 1, 1).getTime()];
}

function parseDateKey(key, zone = "local") {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  return zone === "utc" ? new Date(Date.UTC(year, month, day)) : new Date(year, month, day);
}

function addDaysMs(date, days) {
  return date.getTime() + days * 24 * 60 * 60 * 1000;
}

function withScope(baseSql, scope) {
  return scope.sql ? `${baseSql} AND ${scope.sql}` : baseSql;
}

/**
 * S1（published 映射解码复用）：**同步轮次内**复用的已解码 published 映射视图。
 *
 * 修复前两份 sidecar map（`perf_file_fingerprints` / `perf_file_warnings`）在逐文件校验
 * 循环里被**反复**取串 + `JSON.parse` + 归一化（真实隔离输入单轮实测 453 / 456 次解码）。
 * 本视图让**同一轮**内只解码一次，是全轮唯一的权威取值来源。
 *
 * 语义边界（**不是**通用长期缓存，也不是 `readMetaRaw` 缓存）：
 * - 生命周期 = 单个 `sync()` 调用：`sync()` 建立，轮末（成功/抛错）一律丢弃；
 * - `sync()` 之外 `store.publishedFileMapsView === null` ⇒ 读路径与修复前**逐字相同**；
 * - 两份 map 每轮**至多解码一次**（首次访问才解码）；
 * - **只有成功 `COMMIT` 之后**才用已提交的对象更新视图；事务 `ROLLBACK`/抛错时视图保持旧值
 *   ⇒ 失败轮次的新值**不会**泄漏进视图；
 * - `fingerprintsForRound()` / `warningsForRound()` 返回**新对象**（与
 *   `readPublishedFileFingerprints()` 每次新建对象的既有契约一致）⇒ 调用方的 `delete`/
 *   展开不会污染视图。
 *
 * @param {UsageStore} store
 */
function createPublishedFileMapsView(store) {
  return {
    /** @type {Record<string, string> | null} */
    fingerprints: null,
    /** @type {Record<string, {sourceKind: string, homeId: string, code: string, count: number}[]> | null} */
    warnings: null,
    /** 本轮已提交的 `path → 指纹` 映射（首次访问解码一次）；返回新对象。 */
    fingerprintsForRound() {
      if (this.fingerprints === null) this.fingerprints = store.readPublishedFileFingerprints();
      return { ...this.fingerprints };
    },
    /** 本轮已提交的 `path → 告警` 映射（首次访问解码一次）；返回新对象。 */
    warningsForRound() {
      if (this.warnings === null) this.warnings = store.readPublishedFileWarnings();
      return { ...this.warnings };
    },
    /**
     * 成功 `COMMIT` 之后写回视图。`null` = 本次提交**没有改**这份 map
     * （Codex 文件事务只写告警；已启用非 Codex 文件事务两份都写）。
     * @param {Record<string, string> | null} fingerprints
     * @param {Record<string, {sourceKind: string, homeId: string, code: string, count: number}[]> | null} warnings
     */
    commit(fingerprints, warnings) {
      if (fingerprints !== null) this.fingerprints = { ...fingerprints };
      if (warnings !== null) this.warnings = { ...warnings };
    },
  };
}

export class UsageStore {
  constructor(options = {}) {
    this.options = options;
    this.metadataCache = null;
    /**
     * D4：`metadata()` 观测聚合的**静态输入**（`events` 未过滤分组行 + 全表最大 timestamp）。
     *
     * 契约（本卡红线）：缓存里**只有静态输入**——数据库行本身；`asOf` 的**未来事件过滤**与
     * `buildModelActivity` 的时间派生量一律每次现算。命中条件见 {@link UsageStore#metadata}。
     * @type {{ revision: number, rows: object[], maxTimestampMs: number } | null}
     */
    this.metadataObservationCache = null;
    this.periodComparisonCache = new Map();
    /**
     * W4-b1 / D1：**实例私有**的"事件级计价" memo（跨形状共享）。
     *
     * 键 = `eventCostMemoKey(event)` = 事件**全部计价输入** + `activePricing.version`（`pricing.js`）；
     * 值 = `estimateEventCost(event)` 的返回对象。**不含** `preset`/`bucket`/`calendarZone`/`excludeHomes`/
     * `now` ⇒ 同一份事件在 `today` / `all` 等不同形状间只算一次（R1 "命中也在付" 的止血点）。
     *
     * 有界与失效（卡面红线）：
     *   * **有界**：默认 64 MiB；`beginRound`/`endRound` 期间放宽到 192 MiB（规格 `:159` 的首轮上限），
     *     轮末收敛回 64 MiB；超出按插入顺序逐出最旧条目（逐出只影响**成本**，不影响**正确性**）；
     *   * **失效**：`syncDerivedRevision()`（= `storeRevision` 前进）与 `close()` 清空。由于键里已含
     *     "内容 + 价目版本"，清空**只影响内存**、不会造成陈旧命中 —— 这是**保守**的额外失效，不是
     *     正确性的必要条件（契约见 `pricing.js:createEventCostMemo`）。
     */
    this.eventCostMemo = createEventCostMemo();
    this.databaseFile =
      options.databaseFile || path.join(options.homeDir || os.homedir(), ".codex-usage", "usage-index.sqlite");
    this.database = null;
    this.homes = [];
    this.warnings = [];
    this.generatedAt = "";
    this.fingerprint = "";
    this.checkedAt = "";
    this.repositoryResolver = createRepositoryResolver();
    this.serviceTierEvidence = null;
    /** S1：**同步轮次内**已解码的 published 映射视图（轮外恒为 `null`）。 */
    this.publishedFileMapsView = null;
    /**
     * C1 卡：**实例私有**的"稳定失败尝试记录"（`homeId → record`）。
     *
     * 只承载**确定性内容失败**（见 {@link CODEX_DETERMINISTIC_FAILURE_CODES}）的稳定验证结果，
     * 用于在下一轮**跳过整 home 全文规划**。它不是通用缓存、不进 schema、不进公开 report、
     * 不跨实例：`close()` 清空（卡面"实例私有"、"close/open 使记录失效"）。
     */
    this.codexStableAttempts = new Map();
    /**
     * C3 卡：**实例私有**的"未变文件标准化投影"缓存（`readCodexRolloutMetadata` 的返回对象）。
     *
     * 键 = 规范物理路径，身份 = **本轮读取前的窗口指纹 + 来源 + 方法版本 + home**。
     * 只有**稳定窗口**（读取前/后内容指纹与路径集逐字一致）的投影才会被提升为可复用条目；
     * 替换 / 删除 / home 消失 / `close()` 四条淘汰路径见 `prune` / `retainHomes` / `clear`。
     * 容量（1×/2×/4×）由 C6 裁定；本卡只保证**有界**（每路径至多一条 + 默认 64 MiB LRU 上限）。
     *
     * **T2 卡（2026-10-09）**：这里只是"**未 open** 的缺省值"（纯内存，与 T1 接线前逐字节等价）。
     * 一旦 `open()` 成功，本字段会被换成 T1 的**私有持久投影**包装（`open()` 尾部一行）——内存侧
     * 语义完全不变（同一个 `createCodexProjectionCache()` 作 `inner`），多出来的只是"内存未命中时
     * 再查一次 `perf_codex_projections`"。因此原注释里"不落盘、不跨实例"只对**内存侧**成立：
     * 投影**可以**跨 `close()/open()` 与跨进程复用（这正是 T2 的目的），但**不入** `store_meta`、
     * **不进**公开 report、**不新增** meta 键。
     */
    this.codexProjections = createCodexProjectionCache();
    /**
     * C4 卡：**最近一轮**的"受影响 / 原样保留"线程集合（`homeId → {staged, retained}`）。
     *
     * 只作**证据与测试**的只读视图：不参与任何产品判定，不进 schema、不进公开 report、不落盘、
     * 不跨实例（`close()` 清空）。每轮在被规划到的 home 上覆盖式写入 ⇒ 无跨轮累积。
     * * `staged` = 本轮**重新构建**候选的线程（`codexThreadNeedsBuild` 判为 true）；
     * * `retained` = 本轮**未受影响**、因此其已发布候选被**原样保留**（不 delete/insert）的线程。
     * 发布阶段"旧线程是否已不存在"用的是同一份当前线程集（见 `plan.threadPaths`）。
     * @type {Map<string, {staged: string[], retained: string[]}>}
     */
    this.codexThreadBuildPlan = new Map();
    // ── D1 卡：实例修订 + 外部提交检测 ────────────────────────────────────────────────────────
    /**
     * D1：**实例修订号** —— "这个实例看到的、**已提交的**库内容"的版本。
     *
     * 只在**成功的提交**上 +1（见 {@link UsageStore#commitStoreRevision} 的各调用点）：
     *   * **用量**：`replaceFile` 的 `COMMIT`（`source_files` + `events`，以及同一事务里的
     *     `rate_limit_observations` ⇒ **quota** 观测行）；
     *   * **perf 发布**：codex 发布事务的 `COMMIT`（staged/replaced 线程写候选）；
     *   * **真删除**：codex 发布事务里的 `DELETE FROM source_files`、非 codex 来源的真实删除；
     *   * **读取窗口内变化**：置脏 `UPDATE source_files SET size = -1, mtime_ms = -1`；
     *   * **home**：home 集合形状变化（`homeSetChanged`）；
     *   * **service-tier evidence**：证据**输入**签名变化（见 {@link UsageStore#serviceTierEvidenceSignature}）。
     *
     * ⚠️ **例行时刻元数据不作为用量变化**（卡面明文）：`generated_at` / `perf_indexed_at` /
     * `checkedAt` / 每轮重写的 `perf_file_fingerprints` 都**不**推进修订 —— 否则每个 no-op 轮都会
     * 失效派生缓存，C5 已接受的"无实际变更保留派生缓存"契约当场被破坏。
     *
     * 另一条腿是**外部提交**（别的连接提交的）：`PRAGMA data_version` 只会因**其他连接**的提交而变，
     * 本连接自己的提交**不**改它 ⇒ 两条腿必须分开，见 {@link UsageStore#detectExternalCommit}。
     */
    this.storeRevision = 0;
    /** D1：派生缓存（`metadataCache` / `periodComparisonCache`）当前对齐到的修订。 */
    this.derivedRevision = 0;
    /** D1：本连接上一次观察到的 `PRAGMA data_version`（外部提交检测的基准，`open()` 里取初值）。 */
    this.observedDataVersion = 0;
    /** D1：检出过多少次**外部提交**（诊断用；不落盘、不进 report、不建计数表）。 */
    this.externalCommitCount = 0;
    /** D1：最近一次推进修订的理由（诊断用；同上）。 */
    this.lastCommitReason = "";
    /**
     * D1：本连接上**自己开的**写事务深度（只有 `replaceFile` 会跨 `await`，因此只需要它）。
     * `> 0` ⇒ 读路径读到的是**未提交**状态 ⇒ `metadata()` / `periodComparison()` **不落**派生缓存
     * （验收："事务内已读的派生缓存被安全清理"；预防 + 回滚时再清一次，见
     * {@link UsageStore#rollbackReplaceFileTransaction}）。
     */
    this.writeTransactionDepth = 0;
    /** D1：`service-tier evidence` 的输入签名（`null` = 还没算过；见 `serviceTierEvidenceSignature`）。 */
    this.serviceTierEvidenceInput = null;
    /**
     * D2：**完整 scope 的历史冠军** memo（单槽，见 {@link UsageStore#recordsForRange}）。
     *
     * 实例私有、不落盘、不进 schema、不进公开 report：`key` 是六项输入的规范串
     * （数据修订 / 价目版本 / 汇率 / service-tier evidence 签名 / 时区 / 规范排除集合），
     * `champions` 是 `buildRecordChampions()` 的产物。键不等 ⇒ 立即重算；
     * 写事务内（`writeTransactionDepth > 0`）**不读也不写**（D1 的回滚语义）。
     * `close()`/`open()` 一律复位（连接级状态）。
     * @type {{ key: string, champions: Record<string, Record<string, { period: string, value: number }>> } | null}
     */
    this.recordChampionCache = null;
    /**
     * D3：**已提交 quota 观测的规范映射**（单槽，见 {@link UsageStore#quotaObservations}）。
     *
     * 契约（本卡红线）：缓存里**只有静态输入**——`rate_limit_observations` 已提交行的字段映射。
     * **不含**任何时间派生字段（窗口边界 / `state` / `percentStale` / 倒计时 / reset 语义）：
     * 那些一律由消费者**每次**用当前或冻结的 `asOf` 现算（`selectQuotaWindows(rows, asOf)`、
     * `resolveDateRange({ …filters, now: asOf, quota })`），因此"冻结快照"与"live 读数"各按自己的
     * `asOf` 成立。
     *
     * 键 = D1 的实例修订（`storeRevision`）；`syncDerivedRevision()` / `open()` / `close()` 复位；
     * 写事务内（`writeTransactionDepth > 0`）**不读也不写**（D1 的回滚语义）。
     * @type {{ revision: number, rows: object[] } | null}
     */
    this.quotaObservationCache = null;
  }

  async open() {
    if (this.database) {
      return;
    }
    this.metadataCache = null;
    this.periodComparisonCache.clear();
    // D4：观测聚合缓存同为连接级状态（键含实例修订，但连接/库可能已换）⇒ 重开时一并复位。
    this.metadataObservationCache = null;
    // D2：历史冠军 memo 是**连接级**状态（键含实例修订，但连接/库可能已换）⇒ 重开时一并复位。
    this.recordChampionCache = null;
    // D3：quota 观测映射同为连接级状态（键含实例修订，但连接/库可能已换）⇒ 重开时一并复位。
    this.quotaObservationCache = null;
    await mkdir(path.dirname(this.databaseFile), { recursive: true });
    this.database = new DatabaseSync(this.databaseFile);
    this.database.function("usage_source_group", (channel, kind) => sourceGroup(channel, String(kind ?? "")));
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS store_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_files (
        path TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        home_id TEXT NOT NULL,
        home_label TEXT NOT NULL,
        home_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        indexed_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
        timestamp_ms INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        home_id TEXT NOT NULL,
        home_label TEXT NOT NULL,
        channel TEXT NOT NULL,
        project TEXT NOT NULL,
        model TEXT NOT NULL,
        hour_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        week_key TEXT NOT NULL,
        month_key TEXT NOT NULL,
        cwd TEXT NOT NULL DEFAULT '',
        repository_key TEXT NOT NULL DEFAULT 'unknown:cwd',
        repository_path TEXT NOT NULL DEFAULT 'Unknown cwd',
        repository_kind TEXT NOT NULL DEFAULT 'unknown',
        detail_mask INTEGER NOT NULL DEFAULT 0,
        reconciliation_gap INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_known INTEGER NOT NULL DEFAULT 0,
        request_input_tokens INTEGER NOT NULL DEFAULT 0,
        context_level TEXT NOT NULL DEFAULT 'unknown',
        service_tier TEXT NOT NULL DEFAULT 'unknown',
        price_version TEXT NOT NULL DEFAULT '',
        total INTEGER NOT NULL,
        input INTEGER NOT NULL,
        cached INTEGER NOT NULL,
        output INTEGER NOT NULL,
        reasoning INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS rate_limit_observations (
        source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
        line_number INTEGER NOT NULL CHECK (line_number > 0),
        role TEXT NOT NULL CHECK (role IN ('primary', 'secondary')),
        observed_at_ms INTEGER NOT NULL,
        limit_id TEXT NOT NULL,
        limit_name TEXT,
        plan_type TEXT,
        window_minutes REAL NOT NULL CHECK (window_minutes > 0),
        resets_at_ms INTEGER NOT NULL,
        used_percent REAL CHECK (used_percent IS NULL OR (used_percent >= 0 AND used_percent <= 100)),
        PRIMARY KEY (source_path, line_number, role)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_timestamp_idx ON events(timestamp_ms);
      CREATE INDEX IF NOT EXISTS events_home_idx ON events(home_id);
      CREATE INDEX IF NOT EXISTS events_channel_idx ON events(channel);
      CREATE INDEX IF NOT EXISTS events_project_idx ON events(project);
      CREATE INDEX IF NOT EXISTS events_model_idx ON events(model);
      CREATE INDEX IF NOT EXISTS rate_limit_window_lookup_idx ON rate_limit_observations(limit_id, window_minutes, observed_at_ms DESC);
      CREATE INDEX IF NOT EXISTS rate_limit_source_line_idx ON rate_limit_observations(source_path, line_number);
    `);
    let version = Number(this.database.prepare("PRAGMA user_version").get().user_version || 0);
    /**
     * 独立事务的迁移段：`BEGIN IMMEDIATE` → SQL → **事务内自检** → 抬版本 → `COMMIT`。
     * `verify` 可选：只在事务内核对"实际 schema 等于冻结 DDL"，不符即抛 ⇒ `ROLLBACK` ⇒
     * 版本保持旧值（不得把旧索引当成已升级；`CREATE TABLE IF NOT EXISTS` 会静默接受错形状的旧表）。
     * @param {string} sql @param {number} nextVersion @param {(() => void) | undefined} [verify]
     */
    const migrate = (sql, nextVersion, verify) => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(sql);
        if (verify) verify();
        this.database.exec(`PRAGMA user_version = ${nextVersion}`);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        this.database.close();
        this.database = null;
        throw error;
      }
    };
    if (version === 1) {
      migrate(
        [
          "ALTER TABLE events ADD COLUMN cwd TEXT NOT NULL DEFAULT '';",
          "ALTER TABLE events ADD COLUMN repository_key TEXT NOT NULL DEFAULT 'unknown:cwd';",
          "ALTER TABLE events ADD COLUMN repository_path TEXT NOT NULL DEFAULT 'Unknown cwd';",
          "ALTER TABLE events ADD COLUMN repository_kind TEXT NOT NULL DEFAULT 'unknown';",
          "ALTER TABLE events ADD COLUMN detail_mask INTEGER NOT NULL DEFAULT 0;",
          "ALTER TABLE events ADD COLUMN reconciliation_gap INTEGER NOT NULL DEFAULT 0;",
          "UPDATE events SET cwd = project;",
          "UPDATE source_files SET size = -1, mtime_ms = -1;",
        ].join("\n"),
        2,
      );
      version = 2;
    }
    if (version === 2) {
      migrate(
        [
          "ALTER TABLE events ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;",
          "ALTER TABLE events ADD COLUMN cache_write_known INTEGER NOT NULL DEFAULT 0;",
          "ALTER TABLE events ADD COLUMN request_input_tokens INTEGER NOT NULL DEFAULT 0;",
          "ALTER TABLE events ADD COLUMN context_level TEXT NOT NULL DEFAULT 'unknown';",
          "ALTER TABLE events ADD COLUMN service_tier TEXT NOT NULL DEFAULT 'unknown';",
          "ALTER TABLE events ADD COLUMN price_version TEXT NOT NULL DEFAULT '';",
          "UPDATE source_files SET size = -1, mtime_ms = -1;",
        ].join("\n"),
        3,
      );
      version = 3;
    }
    if (version === 3) {
      migrate(
        `
        UPDATE source_files SET size = -1, mtime_ms = -1
        WHERE path IN (SELECT DISTINCT source_path FROM events WHERE context_level = 'unknown' AND total > 0);
      `,
        4,
      );
      version = 4;
    }
    if (version === 4) {
      migrate(
        `
        UPDATE source_files SET size = -1, mtime_ms = -1
        WHERE path IN (
          SELECT source_path FROM events WHERE session_id IN (
            SELECT session_id FROM events GROUP BY session_id HAVING COUNT(DISTINCT source_path) > 1
          )
        );
      `,
        5,
      );
      version = 5;
    }
    if (version === 5) {
      migrate(
        `
        UPDATE source_files SET size = -1, mtime_ms = -1
        WHERE kind IN ('main', 'jetbrains', 'extra', 'codex')
          AND lower(path) LIKE '%.jsonl';
      `,
        6,
      );
      version = 6;
    }
    if (version === 6) {
      // Earlier quota parsing looked for limit_id inside primary/secondary.
      // Codex writes it on rate_limits, so unchanged session files need a reindex.
      migrate(
        `
        UPDATE source_files SET size = -1, mtime_ms = -1
        WHERE kind IN ('main', 'jetbrains', 'extra', 'codex')
          AND lower(path) LIKE '%.jsonl';
      `,
        7,
      );
      version = 7;
    }
    if (version === 7) {
      // A new rollout can inherit cumulative token counters from another
      // conversation. Recompute Codex events from their first request usage.
      migrate(
        `
        UPDATE source_files SET size = -1, mtime_ms = -1
        WHERE kind IN ('main', 'jetbrains', 'extra', 'codex')
          AND lower(path) LIKE '%.jsonl';
      `,
        8,
      );
      version = 8;
    }
    if (version === 8) {
      // v9 新增 DSH 数据源。表结构没变，因此无需重扫既有数据；
      // 旧索引里不存在 kind='dsh' 的行，升级后第一次 sync 会直接纳入它们。
      // 这里只抬版本号，为将来真正需要重扫的迁移留出位置。
      // 落点必须用字面量：若用 STORE_SCHEMA_VERSION 常量，后续抬版本会静默跳过新迁移。
      migrate("SELECT 1;", 9);
      version = 9;
    }
    if (version === 9) {
      // v10 新增 OpenCode 数据源。同 v9，表结构没变，只抬版本号；
      // 旧索引里不存在 kind='opencode' 的行，升级后第一次 sync 会直接纳入它们。
      migrate("SELECT 1;", 10);
      version = 10;
    }
    if (version === 10) {
      // DSH v4 input is uncached input. Re-read unchanged source files so
      // nonzero cache writes become part of total input in historical events.
      migrate("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE kind = 'dsh';", 11);
      version = 11;
    }
    if (version === 11) {
      // v12 是自 v2 以来首次真正 CREATE TABLE 的迁移（AN-5）：建 `perf_samples` + 三个索引，
      // 并在**同一事务内**执行无 WHERE 的标脏（让既有三源重新提取候选，方案 §4:58）。
      //
      // ① 落点用**字面量** 12（不用常量）：常量落点会让后续抬版本静默跳过新迁移（`:399` 的既有约定）。
      // ② 自检**必须在事务内**：`CREATE TABLE IF NOT EXISTS` 撞上错形状的旧表 / 同名 VIEW，
      //    或索引名被别的表占用时都会**静默通过**；自检失败即回滚，`user_version` 保持 11，
      //    下次打开重试，不会留下"标了 12 却没有表"的半成品。
      // ③ 这段必须留在**这里**，不得挪进上面那个无条件的建表块：那个块在读取版本号之前执行、
      //    且在事务之外，一旦挪过去，失败的迁移会留下已建的 `perf_samples`（gate H 的实测会变红）。
      //
      // 没有这一支，`STORE_SCHEMA_VERSION = 12` 会让所有既有 v11 真库在下面的守卫处直接抛错（AN-2）。
      migrate(`${PERF_SAMPLES_DDL}\nUPDATE source_files SET size = -1, mtime_ms = -1;`, 12, () =>
        assertPerfSamplesSchema(this.database),
      );
      version = 12;
    }
    if (version === 12) {
      // M7 stores cross-rollout sample dependencies and the stable thread identity
      // of every Codex rollout, including files that currently produce no sample.
      // Re-read Codex JSONL so the new identity table is complete before publication.
      migrate(
        `${PERF_CODEX_INDEX_DDL}\nUPDATE source_files SET size = -1, mtime_ms = -1 WHERE kind IN ('main', 'jetbrains', 'extra', 'codex') AND lower(path) LIKE '%.jsonl';`,
        13,
        () => assertPerfCodexIndexSchema(this.database),
      );
      version = 13;
    }
    if (version === 13) {
      // T1（本计划**首次** schema bump）：只建 Codex 投影私有表 + `(home_id)` 索引，**不回填**。
      //
      // ① 落点用**字面量**（`version === 13` / `migrate(..., 14)`），与上面各段同一约定：
      //    只要用常量落点，后续抬版本就会静默跳过新迁移。
      // ② **不回填**是设计要求（设计页 §3）：空表 ⇒ 迁移后第一次 sync 仍然全文读 ⇒ 与今日
      //    **逐字节等价**。这条有实测（`T1/verify-t1.mjs`：同一夹具上"旧程序 vs 新程序" A/B 对比）。
      // ③ 这里**不**做任何 `UPDATE source_files SET size = -1`（v12 段那种无条件标脏）：否则
      //    "只失效必要行、**不**无条件标脏全库"（卡面明文）当场失效。
      // ④ `IF NOT EXISTS` + 事务内自检 ⇒ 幂等且中断可重入：失败即 ROLLBACK，`user_version` 保持 13，
      //    下次打开重试；不会留下"标了 14 却没有表"的半成品。
      migrate(PERF_CODEX_PROJECTIONS_DDL, 14, () => assertPerfCodexProjectionsSchema(this.database));
      version = 14;
    }
    if (version === 14) {
      // v15 新增 Claude Code 数据源。同 v9（DSH）、v10（OpenCode）：表结构没变，只抬版本号；
      // 旧索引里不存在 kind='claude' 的行，升级后第一次 sync 会直接纳入它们。
      // 落点同样用字面量，避免后续抬版本时静默跳过新迁移。
      migrate("SELECT 1;", 15);
      version = 15;
    }
    if (version === 15) {
      // v16：Claude Code 的模型身份从 requestedModel（harness 别名/网关路由名）改为
      // message.model（API 实际服务的线路模型）。事件表结构没变，但已索引的 Claude 事件
      // 带着旧身份 ⇒ 必须重读这些转录，否则旧行会一直停在别名上。
      // 只标脏 kind = 'claude'：其它来源的解析语义未变，不为其付出全量重读。
      migrate("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE kind = 'claude';", 16);
      version = 16;
    }
    if (version !== 0 && version !== STORE_SCHEMA_VERSION) {
      this.database.close();
      this.database = null;
      throw new Error(`不支持的用量索引版本：${version}`);
    }
    if (version === 0) {
      // 全新库：这个分支被**无条件**标成常量当前值（AN-9），因此它**结构上不可能**覆盖
      // v11→12 迁移 —— 建表放在抬版本之前，中途失败留下的库仍是 version 0，下次打开可自愈。
      this.database.exec(PERF_SAMPLES_DDL);
      assertPerfSamplesSchema(this.database);
      this.database.exec(PERF_CODEX_INDEX_DDL);
      assertPerfCodexIndexSchema(this.database);
      // T1：全新库同样无条件建这张表（结构上与 v13→14 迁移不可互相覆盖：建表在抬版本之前，
      // 中途失败留下的库仍是 version 0，下次打开可自愈）。
      this.database.exec(PERF_CODEX_PROJECTIONS_DDL);
      assertPerfCodexProjectionsSchema(this.database);
      this.database.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`);
    }
    this.database.exec("CREATE INDEX IF NOT EXISTS events_repository_idx ON events(repository_key)");
    this.database.exec("CREATE INDEX IF NOT EXISTS events_source_path_idx ON events(source_path)");
    if (this.readMetaRaw("codex_rollout_reader_version") !== CODEX_ROLLOUT_READER_VERSION) {
      // Re-read existing Codex events once: readline used to split valid Unicode JSON strings.
      this.database.exec("BEGIN");
      try {
        this.database.exec(
          "UPDATE source_files SET size = -1, mtime_ms = -1 WHERE kind IN ('main', 'jetbrains', 'extra', 'codex')",
        );
        this.writeMeta("codex_rollout_reader_version", CODEX_ROLLOUT_READER_VERSION);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    this.generatedAt = this.readMeta("generated_at");
    this.fingerprint = this.readMeta("fingerprint");
    // ── T2 卡：把 T1 的**私有持久投影**接到 planner 实际使用的实例字段 ─────────────────────────
    // 位置必须在这里（`open()` 尾部），两个理由都是硬性的：
    //   ① 构造器里 `this.database` 还是 `null`（见构造函数首行）⇒ 那时接线等于**没有持久层**；
    //   ② 上面 `migrate(...14...)` / `version === 0` 两段已保证 `perf_codex_projections` 存在 ——
    //      提前接线会让每次 `lookup` 都撞 "no such table"（T1 的降级会把它记成 `writeFailures`
    //      并回落全文读：仍然是"正确"的，但那等于持久化没生效，且计数器会常年带噪）。
    // 语义：内存侧仍是同一个 `createCodexProjectionCache()`（缺省 64 MiB LRU，**预算不变**），
    // 只是 `lookup` 在内存未命中时**先查一次持久表**（指纹/方法版本/home/kind 四道守卫 + 损坏即
    // miss+删行），命中就水合返回 ⇒ `planCodexHomeThreads`（`codex-thread.js:583`）**不调用**
    // `readCodexRolloutMetadata()`。`stage/commit/rollback/prune/retainHomes/clear` 的事务与失效
    // 契约全部沿用 T1，一行未改。`close()` 只清内存侧、**不清表**（跨实例/跨进程复用正是本卡目的）。
    this.codexProjections = createPersistentCodexProjectionCache({ database: this.database });
    // ── D1 卡：外部提交检测的**基准** ──────────────────────────────────────────────────────────
    // 必须在**所有迁移/建表之后**取：上面那些 `BEGIN IMMEDIATE … COMMIT` 是**本连接**的提交，
    // `PRAGMA data_version` 不会因它们而变；而基准取早了会把"自己迁移"误判成"外部提交"。
    this.observedDataVersion = this.readDataVersion();
    // 两个派生缓存刚在上面清空 ⇒ 它们与当前修订是**对齐**的（`open()` 不是一次提交）。
    this.derivedRevision = this.storeRevision;
  }

  // ── D1 卡：实例修订 / 外部提交检测 / 写事务卫生 ────────────────────────────────────────────

  /**
   * D1：读**同连接**的 `PRAGMA data_version`。
   *
   * SQLite 语义（这是本卡成立的前提）：**别的连接**提交过 ⇒ 该值变化；**本连接自己**的提交
   * **不**改它。⇒ 自身提交必须走 {@link UsageStore#commitStoreRevision} 的**显式修订**，
   * 外部提交才走这里的比对（卡面："自身提交仍用显式修订"）。
   *
   * 读不到（未 `open()` / 库刚被关掉）时返回上次观察值 ⇒ **永不抛**（读路径不得因它失败）。
   * @returns {number}
   */
  readDataVersion() {
    if (!this.database) return this.observedDataVersion;
    try {
      return Number(this.database.prepare("PRAGMA data_version").get()?.data_version ?? 0) || 0;
    } catch {
      return this.observedDataVersion;
    }
  }

  /**
   * D1：**自身成功提交** ⇒ 显式修订 +1。
   *
   * ⚠️ 只能在**已经 `COMMIT`** 之后调用；回滚路径一律**不**调用（验收："回滚不伪造成功变更"）。
   * @param {string} reason 提交类别（诊断用：`usage` / `usage+quota` / `perf` / `usage-delete` /
   *   `live-dirty` / `home` / `service-tier`）。
   * @returns {number} 新的修订号
   */
  commitStoreRevision(reason = "commit") {
    this.storeRevision += 1;
    this.lastCommitReason = String(reason);
    return this.storeRevision;
  }

  /**
   * D1：检出**外部提交**（同连接 `PRAGMA data_version` 变化 ⇒ 别的连接提交过）。
   *
   * 命中 ⇒ ① 修订 +1（这是一次**真实的、已提交的**视图变化）② **重载必要元数据**：
   * `generated_at` / `fingerprint` 由**提交方**写进 `store_meta`，本实例内存里的副本已过期。
   * 派生缓存不在这里直接清 —— 统一由 {@link UsageStore#syncDerivedRevision} 按"修订对齐"清。
   * @returns {boolean} 本次是否检出外部提交
   */
  detectExternalCommit() {
    if (!this.database) return false;
    const observed = this.readDataVersion();
    if (observed === this.observedDataVersion) return false;
    this.observedDataVersion = observed;
    this.externalCommitCount += 1;
    this.commitStoreRevision("external");
    try {
      this.generatedAt = this.readMeta("generated_at");
      this.fingerprint = this.readMeta("fingerprint");
    } catch {
      // 库在两步之间被换掉/关掉 ⇒ 保持原值：读路径不得因为"元数据重载"而抛错。
    }
    return true;
  }

  /**
   * D1：把派生缓存对齐到当前修订（`metadataCache` / `periodComparisonCache` 的**统一**失效入口）。
   *
   * 读路径（`metadata()` / `periodComparison()`）与轮末都必须先过这里：修订前进过 ⇒ 两个缓存一起失效
   * （它们都是**用量侧**派生：`events` 聚合 + home 形状 + service-tier evidence）。
   * @returns {boolean} 本次是否发生了失效
   */
  syncDerivedRevision() {
    this.detectExternalCommit();
    if (this.derivedRevision === this.storeRevision) return false;
    this.metadataCache = null;
    this.periodComparisonCache.clear();
    // D4：观测聚合缓存同为"用量侧静态输入"派生物 ⇒ 与上面两个缓存同一失效入口。
    this.metadataObservationCache = null;
    // D3：quota 观测的**规范映射**同为"用量侧静态输入"派生物 ⇒ 与上面两个缓存同一失效入口。
    this.quotaObservationCache = null;
    // W4-b1 / D1：事件计价 memo 的输入是"事件内容 + 生效价目"，**不含**修订；这里清空是**保守**的
    // 内存卫生（旧修订的事件可能已被删除/重写），不是正确性的必要条件 —— 键不同就绝不会命中。
    this.eventCostMemo.clear("store-revision");
    this.derivedRevision = this.storeRevision;
    return true;
  }

  /**
   * D1：`service-tier evidence` 的**输入签名**（只读 `statSync`，不落盘、不进 report）。
   *
   * 证据来自各 home 的 `logs_2.sqlite`（`loadServiceTierEvidence`）；这里取主库 **+ `-wal`** 的
   * `size`/`mtimeMs`（与 `opencodeSourceStat` 同一手法：WAL 里的新行也算变化）。
   *
   * 为什么用**输入签名**而不是 resolver 身份：`loadServiceTierEvidence` **每轮**都返回一个新对象，
   * 拿身份当"变化"会让每个 no-op 轮都推进修订（违反卡面"无变化同步保留缓存"）。
   * @param {any[]} homes
   * @returns {string}
   */
  serviceTierEvidenceSignature(homes = []) {
    const files = [
      ...new Set(
        homes
          .filter((home) => home?.path && home.kind !== "project-log" && home.kind !== "zcode")
          .map((home) => path.join(String(home.path), "logs_2.sqlite")),
      ),
    ].sort();
    return files
      .map((filePath) => {
        let size = -1;
        let mtimeMs = -1;
        try {
          const main = statSync(filePath);
          size = main.size;
          mtimeMs = main.mtimeMs;
          try {
            const wal = statSync(`${filePath}-wal`);
            size += wal.size;
            mtimeMs = Math.max(mtimeMs, wal.mtimeMs);
          } catch {
            // 没有 `-wal`（非 WAL 模式 / 已 checkpoint）⇒ 主库指纹即全部输入。
          }
        } catch {
          // 取不到指纹（文件不存在/不可读）同样是一个**输入状态**（用 -1 表示）⇒ 保持确定性。
        }
        return `${filePath}\u0000${size}\u0000${mtimeMs}`;
      })
      .join("\n");
  }

  /**
   * D1：`replaceFile` 的回滚出口（**唯一的跨 `await` 写事务**）。
   *
   * 验收明文："回滚 ⇒ **不伪造成功变更**；事务内已读的派生缓存被**安全清理**"。
   *   * 这里**不**推进修订（那次替换没有提交）；
   *   * 事务内可能被读到的派生缓存**一律清掉**（配合 `writeTransactionDepth > 0` 时的"不落缓存"，
   *     保证不会留下与已提交状态不符的缓存）。
   */
  rollbackReplaceFileTransaction() {
    if (this.writeTransactionDepth > 0) this.writeTransactionDepth -= 1;
    this.metadataCache = null;
    this.periodComparisonCache.clear();
    // D4：回滚后派生缓存一并失效（含观测聚合）。
    this.metadataObservationCache = null;
  }

  readMeta(key) {
    return String(this.database.prepare("SELECT value FROM store_meta WHERE key = ?").get(key)?.value || "");
  }

  /** 与 {@link UsageStore#readMeta} 同义，但**保留 `undefined`** —— 用于区分"键缺失"与"空串"（AN-6）。 */
  readMetaRaw(key) {
    const row = this.database.prepare("SELECT value FROM store_meta WHERE key = ?").get(key);
    return row === undefined ? undefined : String(row.value);
  }

  writeMeta(key, value) {
    this.database
      .prepare(
        "INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, String(value));
  }

  /**
   * M3.4：读出 **perf 状态机**的持久化投影（供 `summarize` 在同一读事务内调用）。
   *
   * ⚠️ 必须在**读事务内**调用：`perf_state` 由 `sync()` 在多处写入（每次 `replaceFile`
   * 之间都会变），事务外读取会拿到**撕裂**的状态与候选。
   *
   * **AN-6**：`perf_state` 键**缺失**（从未同步）与 `"ready"` 是**两件事** ⇒ 分别返回
   * `state: "uninitialized"` 与 `state: "ready"`。`degradedHomeIds`/`sourceWarnings`
   * 缺键时返回 `[]`（那是"没有退化项"的真实含义，与上面的"状态未知"不同）。
   * @returns {PerfStateProjection}
   */
  perfState() {
    const rawState = this.readMetaRaw("perf_state");
    const degradedRaw = this.readMetaRaw("perf_degraded_home_ids");
    const warningsRaw = this.readMetaRaw("perf_source_warnings");
    return {
      // `uninitialized` 是**读取投影专有**的取值（键缺失），不属于持久化三态。
      state: /** @type {PerfStateProjection["state"]} */ (
        rawState === undefined || rawState === "" ? PERF_STATE_UNINITIALIZED : rawState
      ),
      indexVersion: this.readMeta("perf_index_version"),
      methodVersion: this.readMeta("perf_method_version"),
      indexedAt: this.readMeta("perf_indexed_at"),
      degradedHomeIds: decodeJsonStringArray(degradedRaw),
      sourceWarnings: decodeJsonWarnings(warningsRaw),
      codexPublicationPolicy: this.readMetaRaw("perf_codex_publication_policy"),
    };
  }

  /** M3.4：写入 perf 状态机三态。`state` 必须是已知取值（AN-6：不得写入未定义状态）。 */
  /**
   * M3.4 返工2 **BC-2**：读取**已成功发布**的逐文件指纹映射（`path → 指纹`）。
   *
   * 该映射只能由 `replaceFile` 在**文件替换事务内**写入 ⇒ 它是一份
   * "**与已提交候选同源**"的指纹表，而不是"当前上游的实时状态"。
   * 缺键/坏值一律 `{}`（读取路径不得因元数据坏掉而失败）。
   * @returns {Record<string, string>}
   */
  readPublishedFileFingerprints() {
    const raw = this.readMetaRaw("perf_file_fingerprints");
    if (typeof raw !== "string" || raw === "") return {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      /** @type {Record<string, string>} */
      const out = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * Read the last successfully published reader warnings for each physical file.
   * This sidecar is committed atomically with that file's candidates, so an
   * interrupted/failed replacement cannot erase diagnostics for old rows.
   * @returns {Record<string, {sourceKind: string, homeId: string, code: string, count: number}[]>}
   */
  readPublishedFileWarnings() {
    const raw = this.readMetaRaw("perf_file_warnings");
    if (typeof raw !== "string" || raw === "") return {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      /** @type {Record<string, {sourceKind: string, homeId: string, code: string, count: number}[]>} */
      const out = {};
      for (const [filePath, warnings] of Object.entries(parsed)) {
        if (Array.isArray(warnings)) out[filePath] = normalizeSourceWarnings(warnings);
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * S1：**本轮**（`sync()` 内）已解码的 published 指纹映射 —— 轮内全轮复用同一份，整轮至多
   * 解码一次；`sync()` 之外（视图为 `null`）与 `readPublishedFileFingerprints()` 逐字等价。
   * 返回值是**新对象**，调用方可自由 `delete`/展开。
   * @returns {Record<string, string>}
   */
  publishedFileFingerprintsForRound() {
    const view = this.publishedFileMapsView;
    return view === null ? this.readPublishedFileFingerprints() : view.fingerprintsForRound();
  }

  /**
   * S1：**本轮**（`sync()` 内）已解码的 published 告警映射 —— 轮内全轮复用同一份，整轮至多
   * 解码一次；`sync()` 之外（视图为 `null`）与 `readPublishedFileWarnings()` 逐字等价。
   * 返回值是**新对象**（数组分量共享，读方只做键级改写）。
   * @returns {Record<string, {sourceKind: string, homeId: string, code: string, count: number}[]>}
   */
  publishedFileWarningsForRound() {
    const view = this.publishedFileMapsView;
    return view === null ? this.readPublishedFileWarnings() : view.warningsForRound();
  }

  /**
   * S2 卡：从**已经完成的稳定窗口**里取出该物理文件的等价内容摘要；取不到就返回 `undefined`
   * （调用方必须重新探针）。
   *
   * 窗口身份 = `planStableCodexHome()` 返回的**对象本身**（卡面要求"缓存绑定窗口身份/版本，
   * 而不是绑时间或全局"）。因此：
   *   * 未规划 / 规划失败（`codexPlans` 无该 home 的条目）⇒ 不复用；
   *   * `window.ok !== true`（home 不可用）⇒ 不复用；
   *   * `window.stable !== true`（**读取期间来源变化** / 文件集合变化 / 规划出错）⇒ 不复用；
   *   * `window.after.complete !== true`（有文件不可读 ⇒ 快照不可证）⇒ 不复用；
   *   * 该文件不在 `after.fileFingerprints` 里（**新观测**：新文件或路径变化）⇒ 不复用。
   * 任何一条不满足，调用方走原路径（`enabledPerfSourceStat` 真实探针）。
   *
   * ⚠️ 只对 **Codex rollout** 生效：`main`/`jetbrains`/`extra` 都会被 `canonicalizeKind` 折成
   * `codex`；其它来源（zcode/dsh/opencode）没有这种"整 home 解析前后摘要"的窗口，一律重新探针。
   *
   * @param {any} plan `codexPlans.get(homeId)` 的条目（或 undefined）
   * @param {string} kind 发现时给出的原始 kind（可能是 `main`/`extra` 等别名）
   * @param {string} filePath
   * @returns {string | undefined}
   */
  codexWindowedProbeValue(plan, kind, filePath) {
    if (canonicalizeKind(kind) !== "codex") return undefined;
    const window = plan?.window;
    if (window?.ok !== true || window.stable !== true) return undefined;
    const after = window.after;
    if (after?.complete !== true) return undefined;
    const fileFingerprints = after.fileFingerprints;
    if (!fileFingerprints || typeof fileFingerprints !== "object") return undefined;
    // 快路径：发现路径与窗口键逐字相同（本轮实测 100% 命中，零额外分配）。
    if (Object.hasOwn(fileFingerprints, filePath)) return fileFingerprints[filePath];
    // 慢路径：同一物理文件的另一种写法（大小写/相对路径/分隔符）—— 规范化后查找，索引只建一次。
    let index = plan.probePathIndex;
    if (!index || index.forWindow !== after) {
      index = new Map();
      for (const [candidate, fingerprint] of Object.entries(fileFingerprints)) {
        index.set(canonicalPerfProbePath(candidate), fingerprint);
      }
      index.forWindow = after;
      plan.probePathIndex = index;
    }
    return index.get(canonicalPerfProbePath(filePath));
  }

  /**
   * C2 卡：从**复用轮的稳定失败签名**里取出该物理文件的等价内容摘要；取不到返回 `undefined`
   * （调用方必须走真实探针）。
   *
   * 这是 C1 收益与 S2 收益**不叠加**的补丁：C1 的复用轮**不进入** `codexPlans`，于是 S2 的
   * "读取后稳定窗口"不存在 ⇒ 逐文件判据只能对签名里那 362 个文件**再取一遍**内容摘要
   * （C1 交付态实测：复用轮 `store.decision.loop` 从 88 回到 449，多出 361 次重复探针）。
   * 本方法把**同一次**轮首探针的结果直接供给消费点，于是"同一物理文件在同一轮只取一次摘要"。
   *
   * ⚠️ 与 S2 的 {@link UsageStore#codexWindowedProbeValue} **同型守卫、同三条红线**：
   *   1. 摘要来源 = `codexStableAttemptMatch()` 在**本轮轮首**对完整排序路径集的逐文件
   *      `enabledPerfSourceStat`（首尾各 64KiB，**不是**全文解析）。从取值到消费点之间
   *      **没有对该文件的任何读取**（复用轮不调用 `planStableCodexHome`；整文件用量读取
   *      `usageFiles()` 发生在**签名之前**）⇒ 消费点拿到的是本文件最近一次真实观测。
   *   2. **不喂发布前复核**（`store.windowPrePublish`）：复用轮该 home 不在 `codexPlans`
   *      ⇒ 复核本轮**根本不执行**；本方法的消费点只有"`pendingChange` 预扫"与"逐文件判据"。
   *      一旦有人把它接到复核上，`LIVE_SOURCE_CHANGED` 就会静默失效（`mut-publish-reuses-after`）。
   *   3. **不喂 `window.after` / 不把 `window.before` 当 `window.after`**：本方法不引入任何窗口绑定，
   *      它的来源是独立探针，不是任何窗口的 before/after 分量。
   *
   * 守卫（任一条不满足 ⇒ `undefined` ⇒ 真实探针）：
   *   * `canonicalizeKind(kind) !== "codex"`（签名只覆盖 codex rollout 文件集合）；
   *   * 本轮该 home 没有命中记录（签名 `undefined`）；
   *   * 该路径不在签名里（新增/删除/重命名/写法不同且规范化后仍不命中）。
   *
   * @param {{ paths: string[], fileFingerprints: Record<string, string>, probePathIndex?: Map<string, string> & { forSignature?: Record<string, string> } } | undefined} signature
   * @param {string} kind 发现时给出的原始 kind（`main`/`jetbrains`/`extra` 等同义别名）
   * @param {string} filePath
   * @returns {string | undefined}
   */
  codexReusedProbeValue(signature, kind, filePath) {
    if (canonicalizeKind(kind) !== "codex") return undefined;
    const fileFingerprints = signature?.fileFingerprints;
    if (!fileFingerprints || typeof fileFingerprints !== "object") return undefined;
    // 快路径：发现路径与签名键逐字相同（本轮隔离输入 100% 命中，零额外分配）。
    if (Object.hasOwn(fileFingerprints, filePath)) return fileFingerprints[filePath];
    // 慢路径：同一物理文件的另一种写法（大小写/相对路径/分隔符）—— 规范化后查找，索引只建一次。
    // 索引的身份是**签名对象本身**（`forSignature` 绑 `fileFingerprints` 而不是绑时间）：换签名
    // 必须重建，否则调用方会拿到上一个签名的事实（过期摘要 = 静默跳过一次真实变更）。
    let index = signature.probePathIndex;
    if (!index || index.forSignature !== fileFingerprints) {
      index = new Map();
      for (const [candidate, fingerprint] of Object.entries(fileFingerprints)) {
        index.set(canonicalPerfProbePath(candidate), fingerprint);
      }
      index.forSignature = fileFingerprints;
      signature.probePathIndex = index;
    }
    return index.get(canonicalPerfProbePath(filePath));
  }

  /**
   * C1 卡：**稳定失败尝试记录**的命中判定 —— 这是**唯一**允许"跳过整 home 规划"的入口。
   *
   * 命中必须同时满足（任一条不满足 ⇒ **立刻清除**旧记录并返回 `null`，调用方走原规划路径）：
   *   1. **方法版本**相同（`PERF_METHOD_VERSION` + `CODEX_PUBLICATION_POLICY_REVISION`）；
   *   2. **home 身份**相同（id + kind + path —— 跨 home 迁移/别名变化/换 home 目录都失效）；
   *   3. **完整排序路径集**逐字相同（新增/删除/重命名 rollout 立即失效）；
   *   4. **逐文件内容指纹**逐字相同（同尺寸同 mtime 的原地改写、SQLite WAL 改写都失效）；
   *   5. 当前签名**可证**（任一文件取不到指纹 ⇒ `null` ⇒ 不复用）。
   *
   * ⚠️ 与 S2 的范式一致：复用绑定的是**可判定的身份/版本**（home 对象 + 本轮路径集 + 逐文件内容
   * 指纹 + 方法版本），**不绑时间、不绑全局**，也不跨实例。窗口失效 ⇒ 立刻重新计算。
   *
   * ⚠️ 命中判定**只做内容探针**（首尾各 64KiB），不读全文、不调用 `readCodexRolloutMetadata`；
   * 而且只有**该 home 已有记录**时才探针（无记录 ⇒ 直接返回 `null`，零额外 I/O）。
   *
   * @param {string} homeId
   * @param {any} home 本轮 discovery 给出的 home（或旧行重建的等价对象）
   * @param {string[]} expectedPaths 本轮发现到的该 home 完整物理路径集
   * @returns {any | null} 命中的记录（**只读**，调用方不得就地改写）
   */
  codexStableAttemptMatch(homeId, home, expectedPaths) {
    const attempt = this.codexStableAttempts.get(homeId);
    if (attempt === undefined) return null;
    /** 失配 ⇒ 记录已陈旧：**立刻清除**，绝不让它在下一次签名恰好重现时被误用。 */
    const stale = () => {
      this.codexStableAttempts.delete(homeId);
      return null;
    };
    if (attempt.methodVersion !== codexStableAttemptMethodVersion()) return stale();
    if (String(home?.id ?? "") !== attempt.homeId) return stale();
    if (String(home?.kind ?? "") !== attempt.homeKind) return stale();
    if (String(home?.path ?? "") !== attempt.homePath) return stale();
    const expected = [...expectedPaths].sort();
    if (expected.length !== attempt.paths.length) return stale();
    for (const [index, filePath] of expected.entries()) {
      if (filePath !== attempt.paths[index]) return stale();
    }
    const current = codexHomeContentSignature(home?.kind, expected);
    if (current === null) return stale();
    for (const filePath of attempt.paths) {
      if (current.fileFingerprints[filePath] !== attempt.fileFingerprints[filePath]) return stale();
    }
    return attempt;
  }

  writePerfState(state, { degradedHomeIds = [], sourceWarnings = [] } = {}) {
    if (!PERF_STATES.has(state)) {
      throw new TypeError(`perf_state must be one of ${[...PERF_STATES].join("/")}, got ${JSON.stringify(state)}`);
    }
    this.writeMeta("perf_state", state);
    // 两个列表值以**本地 JSON** 存储（`store_meta.value` 是 STRICT TEXT ⇒ 必须自行编码）。
    this.writeMeta("perf_degraded_home_ids", JSON.stringify(normalizeDegradedHomeIds(degradedHomeIds)));
    this.writeMeta("perf_source_warnings", JSON.stringify(normalizeSourceWarnings(sourceWarnings)));
  }

  /**
   * M3.1 写入原语：把一个**已归一化**的 `PerfSample` 写进 `perf_samples`。
   *
   * 只绑定参数、不拼 SQL、不拼身份（列序由 `PERF_SAMPLE_FIELDS` 决定）。身份由
   * `sampleKey` 原样携带（M1 的规范 JSON 元组），这里既不解析也不重建。
   * 外键要求 `source_path` 已存在于 `source_files`（M3.2 在同一事务里先写来源行）。
   * @param {unknown} sample
   */
  insertPerfSample(sample) {
    const row = encodePerfSample(sample);
    return this.database.prepare(PERF_SAMPLE_INSERT_SQL).run(...PERF_SAMPLE_FIELDS.map((entry) => row[entry.column]));
  }

  /**
   * M3.1 读取原语：按主键读回一个候选并解码（全列，`decode(encode(s))` 与 `s` 同形）。
   * 范围查询属于 M3.3，不在这里实现。
   * @param {unknown} sampleKey
   * @returns {import("./usage-types.js").PerfSampleRowDecoded | null}
   */
  perfSampleByKey(sampleKey) {
    const row = this.database.prepare(`${PERF_SAMPLE_SELECT_SQL} WHERE sample_key = ?`).get(String(sampleKey));
    return row === undefined ? null : decodePerfSample(row);
  }

  /**
   * M3.3：按范围与来源取候选，**只做范围/来源限制**，不做任何统计。
   *
   * 与 M1 内存路径（`selectPerfSamples`）**逐字同形**是硬性要求，因此：
   * - 上下界规则完全照抄 `perfTsInRange`（`src/perf-stats.js:1431`）：`startMs` inclusive、
   *   `endMs` inclusive，且 **`windowEndExclusiveMs` 存在时 `endMs` 被忽略**。后者之所以重要：
   *   配额 range 同时带 `end`（= `effectiveEndExclusive - 1`）与一个**更晚的** `windowEndExclusive`，
   *   若把两者都塞进 SQL，`end` 会把 `windowEndExclusive` 之前、`end` 之后的样本错误地挡掉
   *   （探针实测：实验 A/B 的 eligible 集合确实不同）。
   * - 边界值用 `perfRangeBoundMs` 的同一套校验（Date 或有限数字；非有限值抛 `TypeError`）。
   *   绝不用 `(? IS NULL OR ...)` 那种写法糊弄非法值 —— `ts < NaN` 恒 false 会**静默禁用**边界。
   * - `excludedHomeIds` 按 **`home_id`** 过滤（不是 `channel`/`source_kind`）：同一规范来源下
   *   多个 home 的 `channel` 完全相同，只有 `home_id` 能区分。
   * - `ts_ms IS NULL` 的 unplaced 候选**不进本方法**（它们没有位置，塞进当前范围会污染 eligible）；
   *   用 {@link UsageStore#unplacedPerfSamples} 单独取。
   *
   * @param {{ startMs?: unknown, endMs?: unknown, windowEndExclusiveMs?: unknown } | null} range
   * @param {Iterable<string>} [excludedHomeIds]
   * @returns {import("./usage-types.js").PerfSampleRowDecoded[]} 按 `sample_key` 升序（稳定）
   */
  perfCandidatesForRange(range, excludedHomeIds = []) {
    const bounds = perfRangeBounds(range);
    const excluded = normalizeExcludedHomeIds(excludedHomeIds);

    const predicates = ["ts_ms IS NOT NULL"];
    const params = [];
    if (bounds.startMs !== null) {
      predicates.push("ts_ms >= ?");
      params.push(bounds.startMs);
    }
    if (bounds.windowEndExclusiveMs !== null) {
      // 与 `perfTsInRange` 同序：window 存在则**忽略** endMs。
      predicates.push("ts_ms < ?");
      params.push(bounds.windowEndExclusiveMs);
    } else if (bounds.endMs !== null) {
      predicates.push("ts_ms <= ?");
      params.push(bounds.endMs);
    }
    for (const homeId of excluded) {
      predicates.push("home_id <> ?");
      params.push(homeId);
    }

    const sql = `${PERF_SAMPLE_SELECT_SQL} WHERE ${predicates.join(" AND ")} ORDER BY sample_key`;
    // 全列解码，**不得**跳过：AP-4 已实测 STRICT 会把 `'7'` 无损换算成 7 ⇒ 信任库中值会出错。
    // Decode as rows arrive so raw SQL rows and decoded samples never coexist in full.
    return Array.from(this.database.prepare(sql).iterate(...params), decodePerfSample);
  }

  /**
   * M3.3：`ts_ms IS NULL` 的 unplaced 候选，供全历史来源诊断。
   *
   * **刻意与 {@link UsageStore#perfCandidatesForRange} 分开**：unplaced 没有时间位置，
   * 放进当前范围会把"无位置"混成"在范围内"，从而污染 eligible 与分母。
   * @param {Iterable<string>} [excludedHomeIds]
   * @returns {import("./usage-types.js").PerfSampleRowDecoded[]} 按 `sample_key` 升序
   */
  unplacedPerfSamples(excludedHomeIds = []) {
    const excluded = normalizeExcludedHomeIds(excludedHomeIds);
    const predicates = ["ts_ms IS NULL"];
    const params = [];
    for (const homeId of excluded) {
      predicates.push("home_id <> ?");
      params.push(homeId);
    }
    return Array.from(
      this.database
        .prepare(`${PERF_SAMPLE_SELECT_SQL} WHERE ${predicates.join(" AND ")} ORDER BY sample_key`)
        .iterate(...params),
      decodePerfSample,
    );
  }

  /**
   * D5：`rankedHomeIds` 需要的**必要身份列**投影（`sample_key` / `source_kind` / `home_id`）。
   *
   * 取排名只需要"哪些 home 有候选"与 Codex 候选的线程身份（`sample_key` 里的
   * `["codex", homeId, threadId, turnId]`），**不需要**解码全量样本 JSON
   * （`decodePerfSample` 会逐列校验并 `JSON.parse` 诊断链）。
   *
   * 行集与旧实现 `perfCandidatesForRange(null) ∪ unplacedPerfSamples()` 的并集**逐行同集**：
   * 前者 `ts_ms IS NOT NULL`、后者 `ts_ms IS NULL`，两者都不带 home 排除 ⇒ 并集就是全表；
   * 本方法无 `WHERE`、无 `ORDER BY`（调用方只用集合，最终由 `Set` + 默认排序定序）。
   *
   * ⚠️ 边界（D5 §5 已记录）：本方法**不做**行级解码校验 ⇒ 范围外的坏行不会在这里响亮失败；
   * 范围内的坏行仍由 `perfCandidatesForRange` 的解码路径响亮失败（该路径继续服务统计块）。
   * @returns {ReadonlyArray<{ sampleKey: string, sourceKind: string, homeId: string }>}
   */
  perfSampleIdentities() {
    return Array.from(
      this.database.prepare("SELECT sample_key, source_kind, home_id FROM perf_samples").iterate(),
      (row) => ({
        sampleKey: String(row.sample_key ?? ""),
        sourceKind: String(row.source_kind ?? ""),
        homeId: String(row.home_id ?? ""),
      }),
    );
  }

  async usageFiles(homes) {
    const files = [];
    const warnings = [];
    /** @type {any[]} */
    const failedHomes = [];
    for (const home of homes) {
      try {
        if (home.kind === "project-log" && home.usageLogPath) {
          files.push({ filePath: home.usageLogPath, source: home, info: await stat(home.usageLogPath) });
          continue;
        }
        if (home.kind === "zcode" && home.usageLogPath) {
          files.push({ filePath: home.usageLogPath, source: home, info: await zcodeSourceStat(home.usageLogPath) });
          continue;
        }
        if (home.kind === "dsh") {
          // DSH 的用量按会话分散在多个日志文件里，逐个纳入增量索引
          // （每个文件各自按 size+mtime 判定是否需要重解析）。
          for (const filePath of await dshSessionFiles(home.path)) {
            files.push({ filePath, source: home, info: await stat(filePath) });
          }
          continue;
        }
        if (home.kind === "opencode") {
          // 单个数据目录下可能有多个数据库（opencode.db、opencode-<channel>.db），
          // 逐个纳入增量索引（含 -wal 指纹）。
          for (const filePath of await opencodeDatabaseFiles(home.path)) {
            files.push({ filePath, source: home, info: await opencodeSourceStat(filePath) });
          }
          continue;
        }
        if (home.kind === "claude") {
          // Claude Code 的用量按会话转录分散在 projects/**/*.jsonl（含 subagents），
          // 每个文件各自按 size+mtime 判定是否需要重解析。
          for (const filePath of await claudeSessionFiles(home.path)) {
            files.push({ filePath, source: home, info: await stat(filePath) });
          }
          continue;
        }
        for (const filePath of await discoverSessionFiles(home.path)) {
          files.push({ filePath, source: home, info: await stat(filePath) });
        }
      } catch (error) {
        failedHomes.push({ id: home.id, path: home.path });
        warnings.push(`无法读取 ${home.path}: ${error.message}`);
      }
    }
    return { files, warnings, failedHomes };
  }

  /**
   * @param {any} file
   * @param {{
   *   onWarning?: (warning: string) => void,
   *   liveChangeWarnings?: any[],
   *   liveChangedPaths?: Set<string>,
   *   blockedHomeIds?: Set<string>,
   *   committedFingerprints?: Map<string, string>,
   *   onPerfWarning?: (warning: any) => void,
   * }} [options]
   */
  async replaceFile(
    { filePath, source, info },
    { onWarning, liveChangeWarnings, liveChangedPaths, blockedHomeIds, committedFingerprints, onPerfWarning } = {},
  ) {
    const database = this.database;
    const codexThreaded = canonicalizeKind(source.kind || "codex") === "codex";
    const siblingPath = filePath.endsWith(".jsonl.zst") ? plainRolloutPath(filePath) : `${filePath}.zst`;
    const sibling = codexThreaded
      ? database.prepare("SELECT path FROM source_files WHERE path = ? AND home_id = ?").get(siblingPath, source.id)
      : null;
    const representationFingerprint =
      codexThreaded && (filePath.endsWith(".jsonl.zst") || sibling)
        ? enabledPerfSourceStat(source.kind, filePath)
        : undefined;
    const insertSource = database.prepare(`
      INSERT INTO source_files (path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        kind = excluded.kind,
        home_id = excluded.home_id,
        home_label = excluded.home_label,
        home_path = excluded.home_path,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        indexed_at = excluded.indexed_at
    `);
    const insertEvent = database.prepare(`
      INSERT INTO events (
        source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
        hour_key, day_key, week_key, month_key, cwd, repository_key, repository_path, repository_kind,
        detail_mask, reconciliation_gap, cache_write_tokens, cache_write_known, request_input_tokens,
        context_level, service_tier, price_version, total, input, cached, output, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRateLimitObservation = database.prepare(`
      INSERT INTO rate_limit_observations (
        source_path, line_number, role, observed_at_ms, limit_id, limit_name,
        plan_type, window_minutes, resets_at_ms, used_percent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const previousStatement = database.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS total,
        COALESCE(SUM(input), 0) AS input, COALESCE(SUM(cached), 0) AS cached,
        COALESCE(SUM(output), 0) AS output, COALESCE(SUM(reasoning), 0) AS reasoning,
        MIN(detail_mask & 1) AS input_known, MIN(detail_mask & 2) AS cached_known,
        MIN(detail_mask & 4) AS output_known, MIN(detail_mask & 8) AS reasoning_known,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        MIN(cache_write_known) AS cache_write_known
      FROM events WHERE session_id = ? AND home_id = ? AND source_path <> ? AND timestamp_ms < ?
    `);
    const previousCumulativeForSession = (sessionId, timestamp) => {
      const timestampMs = Date.parse(timestamp);
      if (!Number.isFinite(timestampMs)) return null;
      const earlier = previousStatement.get(sessionId, source.id, filePath, timestampMs);
      if (!earlier.count) return null;
      return {
        usage: usageFromRow(earlier),
        detailMask:
          Number(earlier.input_known || 0) |
          Number(earlier.cached_known || 0) |
          Number(earlier.output_known || 0) |
          Number(earlier.reasoning_known || 0),
        cacheWrite: { tokens: Number(earlier.cache_write_tokens || 0), known: Boolean(earlier.cache_write_known) },
      };
    };
    /** D1：本事务是否真的写入了 **quota 观测行**（`rate_limit_observations`）—— 修订理由用。 */
    let quotaWritten = false;
    const filePerfWarnings = [];
    database.exec("BEGIN IMMEDIATE");
    // D1：这是**唯一**跨 `await` 的写事务（下面的 `streamUsageFileEvents` / `streamPerfSamplesForFile`）
    // ⇒ 读路径可能在本事务开着的时候被调用。深度 > 0 时 `metadata()`/`periodComparison()` **不落**缓存。
    this.writeTransactionDepth += 1;
    try {
      insertSource.run(
        filePath,
        source.kind || "codex",
        source.id,
        source.label,
        source.path,
        info.size,
        info.mtimeMs,
        new Date().toISOString(),
      );
      database.prepare("DELETE FROM events WHERE source_path = ?").run(filePath);
      database.prepare("DELETE FROM rate_limit_observations WHERE source_path = ?").run(filePath);
      // A representation change replaces its old events inside this rollback-able transaction.
      if (sibling) database.prepare("DELETE FROM source_files WHERE path = ?").run(sibling.path);
      // M3.2：性能候选的**显式**替换。必须显式 DELETE —— `source_files` 行是上面的 upsert，
      // **没有**被删除，因此 `ON DELETE CASCADE` 在这条路径上**不会触发**（M3.1 实测级联只在
      // 真删父行时生效）。旧候选保留在同一事务里，任何后续失败都会被 ROLLBACK 一起撤销。
      if (!codexThreaded) database.prepare("DELETE FROM perf_samples WHERE source_path = ?").run(filePath);
      await streamUsageFileEvents(
        filePath,
        source,
        (event) => {
          const date = new Date(event.timestampMs);
          insertEvent.run(
            filePath,
            event.timestampMs,
            event.sessionId,
            event.homeId,
            event.homeLabel,
            event.channel,
            event.project || "Unknown cwd",
            event.model || "Unknown model",
            localHourKey(date),
            localDateKey(date),
            localDateKey(startOfLocalWeek(date)),
            localDateKey(date).slice(0, 7),
            event.project || "",
            event.repositoryKey || "unknown:cwd",
            event.repositoryPath || "Unknown cwd",
            event.repositoryKind || "unknown",
            Number(event.detailMask || 0),
            Number(event.reconciliationGap || 0),
            Number(event.cacheWriteTokens || 0),
            event.cacheWriteKnown ? 1 : 0,
            Number(event.requestInputTokens || 0),
            event.contextLevel || "unknown",
            event.serviceTier || "unknown",
            event.priceVersion || "",
            event.usage.total,
            event.usage.input,
            event.usage.cached,
            event.usage.output,
            event.usage.reasoning,
          );
        },
        {
          repositoryResolver: this.repositoryResolver,
          previousCumulativeForSession,
          onRateLimit: ["main", "jetbrains", "extra", "codex"].includes(source.kind)
            ? (observation) => {
                insertRateLimitObservation.run(
                  filePath,
                  observation.lineNumber,
                  observation.role,
                  observation.observedAtMs,
                  observation.limitId,
                  observation.limitName,
                  observation.planType,
                  observation.windowMinutes,
                  observation.resetsAtMs,
                  observation.usedPercent,
                );
                // D1：quota 观测行确实落进**本事务** ⇒ 提交后它也是修订覆盖面的一部分（卡面"quota 发布"）。
                quotaWritten = true;
              }
            : undefined,
          onWarning,
        },
      );
      // M3.2：性能候选。位置在 events 之后、COMMIT 之前，与前三类共享**同一个** `BEGIN IMMEDIATE`
      // 事务 ⇒ 任一类失败都会一起回滚（gate A 逐类实测）。
      //
      // Codex 的整线程候选由 M7 sync 阶段发布，不能在单文件事务里拆轮；
      // project-log 结构上不支持性能候选。
      /** S1：本次事务写回的指纹映射（`null` = 本次没改指纹，例如 Codex 文件）。成功 `COMMIT` 后写回轮内视图。 */
      let committedFingerprintMap = null;
      if (isPerfSourceEnabled(source.kind) && canonicalizeKind(source.kind) !== "codex") {
        const insertPerfSample = database.prepare(PERF_SAMPLE_INSERT_SQL);
        // ⚠️ 归属必须是 `filePath`，**不能**用 `source.path`：`perf_samples.source_path` 有外键指向
        // `source_files(path)`，而 `source_files` 的主键是**物理文件路径**。对单文件来源（ZCode 的
        // `db.sqlite`）两者相同，但对**多文件**来源（DSH/Codex 用同一个 home 发现 N 个文件）`source.path`
        // 是**目录**，用它必触 `errcode 787`（本卡冒烟实测）。卡片 `M3-index.md:15` 写的
        // `sourcePath = source.path` 只在单文件来源下成立 —— 已在 M3.2 报告 §6 登记为需裁定项。
        // 覆盖 `sourcePath` **不影响身份**：`sampleKey` 在 reader 里已由原始身份元组算好（M1:340
        // 只用 sourceKind/homeId/identity），本层不重算、也不重建。
        //
        // ── M3.4 返工 BB-1：**读取期间来源变化**检测 ──────────────────────────────
        // 用户在"reader 读完、事务提交前追加一行"时复现了静默 `ready`（索引 3 行 / 上游 4 行）。
        // 根因：本段读完即写、`COMMIT` 之前**没有任何前后比较**。
        //
        // 判据：读取**前后**各取一次来源指纹（**主库 + WAL**，见 `perfSourceStat`），
        // 不等 ⇒ 写入 `degraded` + `LIVE_SOURCE_CHANGED`（冻结码），并**确保下次重新提取**
        // （把 `source_files.size/mtime_ms` 置 `-1` ⇒ 下一轮判据必然认为"已变"）。
        //
        // ⚠️ 比较必须在 **`COMMIT` 之前**进行（此刻本事务尚未提交，但文件指纹是**文件系统**事实，
        // 不受本事务影响）⇒ 一旦检出变化，就**不发布 `ready`**。
        //
        // ── M3.4 返工2 BC-1（用户第二轮复现）：**"指纹取不到"同样是候选不完整的证据** ──
        // 用户复现 `{"case":"source-deleted-after-read","state":"ready","sourceExists":false}`。
        // **根因**：原判据是 `statBefore !== null && statAfter !== null && statBefore !== statAfter`
        // —— **三重合取**把"读后取不到指纹"排除在"变化"之外 ⇒ 文件已消失却仍发布 `ready`。
        //
        // ⇒ **正确判据**：`statBefore` 必须可得（读之前文件必然存在，取不到说明它一开始就不可读，
        // 由 `onWarning`/catch 另路处理）；而 `statAfter` **取不到**（`null`）本身就是
        // "读完之后来源不再可读"的证据 —— 与"指纹变了"同属**候选不完整**，且更强。
        const statBefore = enabledPerfSourceStat(source.kind, filePath);
        await streamPerfSamplesForFile(
          filePath,
          { ...source, path: filePath },
          (sample) => {
            const row = encodePerfSample(sample);
            insertPerfSample.run(...PERF_SAMPLE_FIELDS.map((entry) => row[entry.column]));
          },
          {
            onWarning: (warning) => {
              filePerfWarnings.push(warning);
              onPerfWarning?.(warning);
              onWarning?.(formatPerfWarning(warning));
            },
          },
        );
        const statAfter = enabledPerfSourceStat(source.kind, filePath);
        // 变化 = ① 指纹不同（读期间被追加/改写），或 ② 读后**取不到**指纹（文件消失/不可读）。
        const fingerprintChanged = statBefore !== null && statAfter !== statBefore;
        if (fingerprintChanged) {
          // 本轮读到的候选**不完整**（上游在读期间又写入了，或读取后来源已被移除）。
          // 记编码告警 + 记受阻 home + 把文件置脏以强制下一轮重提取。
          //
          // **BC-1 裁决（见报告 §2）**：用 `LIVE_SOURCE_CHANGED`。
          // **依据**：该码定义为"live source changed"；文件在 `statBefore` 时**存在**、
          // 到 `statAfter` 时**取不到**，即"来源在**读取窗口内**发生了变化"—— 这是**字面为真**，
          // 不是类比。而 `READ_ONLY_OPEN_FAILED` 已被 reader 自身失败（文件坏/缺表）占用，
          // 复用它会把**两种不同成因**混成一个码，破坏归因（AN-6）。
          liveChangeWarnings.push({
            sourceKind: canonicalizeKind(source.kind),
            homeId: String(source.id ?? ""),
            code: "LIVE_SOURCE_CHANGED",
            count: 1,
          });
          // `blockedHomeIds` 由 `sync()` 拥有（本方法不能直接访问其作用域）⇒ 经 options 注入。
          blockedHomeIds?.add(String(source.id ?? ""));
          liveChangedPaths.add(filePath);
          // ── 返工3（第三轮外部复核 P2）：检出读取期间变化 ⇒ **本文件整笔替换回滚** ──────
          // 复核复现：本轮提交 3 行候选、却把**读后（已含新增记录）**的 `statAfter` 记成它们的
          // 已发布指纹 ⇒ 下一轮恢复为 4 行候选、状态回到 `ready`，而**版本完全不变**
          // （`{"degraded":{"rows":3},"recovered":{"rows":4},"versionChanged":false}`）。
          // 根因：把元数据与候选放进**同一个事务**，只保证两者**一起提交**，
          //       **不保证它们描述的是同一份数据** —— 读后的上游可以包含 reader 没读到的新记录。
          //
          // ⇒ 采信"**这份读取不可信**"：整笔回滚本次替换（保留**上一次成功**的候选与指纹），
          //    由上面的 `liveChangedPaths` 置脏保证**下一轮重试**；只有读取前后指纹一致时
          //    才把候选与指纹**一起**发布 ⇒ `perf_index_version` 永远描述已提交的候选。
          //
          // ⚠️ 不得改用 `statBefore` 充当"本次候选的指纹"：追加可能落在 `statBefore` 之后、
          //    reader 读取之前 ⇒ `statBefore` **同样**不保证对应实际解析结果（复核明文警告）。
          database.exec("ROLLBACK");
          // D1：**回滚不得伪造成功变更** —— 这里只复原事务深度并安全清理可能已在事务内被读到的
          // 派生缓存；修订**不**推进（本次替换整体没提交）。置脏由下面的 `liveChangedPaths` 负责。
          this.rollbackReplaceFileTransaction();
          return { committed: false, quotaWritten: false };
        }
        // ── BC-2：把**本次候选对应的**已发布指纹写进**同一个事务** ────────────────
        // 用户复现 `{"case":"failed-publication","state":"degraded","versionChanged":true}`：
        // 索引保留旧成功候选，版本却表征了**没有发布**的上游文件。
        //
        // **我实测的关键机制**（这是本修复的支点）：`store_meta` 的写在
        // `BEGIN IMMEDIATE … COMMIT` 内**随 `ROLLBACK` 一起回滚**（实测：初始 `old` →
        // 事务内读到 `new` → `ROLLBACK` 后回到 `old`）。
        // ⇒ 把**每个文件**的已发布指纹写在这里，就**结构性地**保证了
        // "版本只描述与候选**同一次 COMMIT** 成功发布的数据" —— 不依赖任何事后补算。
        //
        // `statAfter` 为 `null`（读后不可读）时**移除**该文件分量：它已无可用"已发布"状态，
        // 留着会让版本表征一个不再成立的事实。
        // S1：轮内复用已解码视图（整轮至多解码一次）；**成功 `COMMIT` 后**才写回视图。
        const nextFingerprints = { ...(this.publishedFileFingerprintsForRound() || {}) };
        if (statAfter !== null) {
          nextFingerprints[filePath] = statAfter;
        } else {
          delete nextFingerprints[filePath];
        }
        this.writeMeta("perf_file_fingerprints", JSON.stringify(nextFingerprints));
        committedFingerprintMap = nextFingerprints;
        if (committedFingerprints) {
          // 供 `sync()` 在同一轮内聚合（避免再次 stat 上游）。
          for (const [p, fp] of Object.entries(nextFingerprints)) committedFingerprints.set(p, fp);
        }
      }
      const nextFileWarnings = this.publishedFileWarningsForRound();
      if (isPerfSourceEnabled(source.kind) && canonicalizeKind(source.kind) !== "codex") {
        nextFileWarnings[filePath] = normalizeSourceWarnings(filePerfWarnings);
      } else if (canonicalizeKind(source.kind) !== "codex") {
        delete nextFileWarnings[filePath];
      }
      this.writeMeta("perf_file_warnings", JSON.stringify(nextFileWarnings));
      if (
        representationFingerprint !== undefined &&
        (representationFingerprint === null ||
          enabledPerfSourceStat(source.kind, filePath) !== representationFingerprint)
      ) {
        throw Object.assign(new Error("Codex rollout changed during representation indexing"), {
          code: "LIVE_SOURCE_CHANGED",
        });
      }
      database.exec("COMMIT");
      // D1：**提交成功** ⇒ 写事务结束（深度复原）。修订的推进放在调用点（`sync()`）：只有调用点
      // 才知道本次替换是"成功的用量提交"还是"回滚后由置脏强制重试"。
      if (this.writeTransactionDepth > 0) this.writeTransactionDepth -= 1;
      // S1：**只有成功提交**才写回轮内视图 —— 上面两个 `ROLLBACK` 分支（读取期间来源变化、
      // 事务内任何抛错）都保留旧值，失败轮次的新值不会泄漏进视图。
      this.publishedFileMapsView?.commit(committedFingerprintMap, nextFileWarnings);
      // D1：告诉调用点"这一次替换真的提交了"（+ 有没有 quota 观测行）⇒ 调用点据此推进修订。
      return { committed: true, quotaWritten };
    } catch (error) {
      database.exec("ROLLBACK");
      // D1：抛错 ⇒ 整个替换事务回滚 ⇒ **不推进修订**，只复原深度 + 安全清理事务内的派生缓存。
      this.rollbackReplaceFileTransaction();
      throw error;
    }
  }

  /**
   * 同步轮次入口。S1：本轮**私有**的 published 映射视图在这里建立，并在轮末（成功或抛错）
   * 一律丢弃 ⇒ 既保证"整轮至多解码一次"，又保证视图**不会**跨轮变成长期缓存。
   * @param {{ options?: any }} [args]
   */
  async sync(args = {}) {
    const view = createPublishedFileMapsView(this);
    this.publishedFileMapsView = view;
    try {
      return await this.syncRound(args);
    } finally {
      if (this.publishedFileMapsView === view) this.publishedFileMapsView = null;
    }
  }

  /**
   * 轮内实现（只由 {@link UsageStore#sync} 调用）：`sync()` 建立的 published 映射视图
   * 在本方法执行期间有效。
   * @param {{ options?: any }} [args]
   */
  async syncRound({ options } = {}) {
    await this.open();
    // D1：轮首先**检出外部提交**（同连接 `PRAGMA data_version`）⇒ 失效派生缓存 + 重载必要元数据，
    // 这样本轮的"要不要保留缓存"判定（轮末守卫）以及随后的读路径都建立在正确的修订上。
    this.syncDerivedRevision();
    const syncOptions = options || this.options;
    this.options = syncOptions;
    const homes = await discoverUsageSources(syncOptions);

    const { files, warnings, failedHomes = [] } = await this.usageFiles(homes);
    const status = await buildUsageFingerprint({ ...syncOptions, homes, scannedFiles: files, failedHomes });
    const knownFiles = new Set(files.map((file) => file.filePath));
    const failedHomeIds = new Set(failedHomes.map((home) => home.id));
    const failedHomePaths = new Set(failedHomes.map((home) => home.path));
    let updatedFileCount = 0;
    /**
     * C5 卡：**本轮是否真的写了用量数据**（= 派生缓存的输入是否变了）。
     *
     * `this.metadataCache` 与 `this.periodComparisonCache` 的输入**只有用量侧**：
     * `metadata()` 读 `events` + 本轮 home 集合（`metadata()` 里的 `events` 聚合与 `this.homes`），
     * `periodComparison()` 走 `periodAggregate()` —— 那条 SQL **只读 `events`**，
     * 不用价目、不用 `source_files`、不用任何 perf 表。
     *
     * 因此"要不要清空派生缓存"必须由**真正的数据变更点**决定，而不是由"源指纹变了""本轮开过
     * 什么事务"决定（卡面："主审检查真正的数据变更点，不只凭源 fingerprint 判断"）。下面每个
     * 真的写了 `events` / `source_files` 的地方都**显式**记一笔 —— 这份清单就是报告里"提交路径
     * 清单"的可执行版本。**perf 侧**（`perf_samples` / `perf_sample_sources` /
     * `perf_rollout_threads` / `perf_file_fingerprints` / `perf_file_warnings` / 策略）与**例行
     * 时刻元数据**（`generated_at` / `perf_indexed_at`）**不在**这两个缓存的输入里 ⇒ 不得让它们
     * 触发失效。
     *
     * ⚠️ 反向红线：**每一次**对 `events` / `source_files` 的写都必须在这里记一笔，漏记会让派生
     * 缓存保留过期结果。写点共 4 处（见 `C5/out/measure-c5.json` 的 `submitPaths` 与报告 §提交路径清单）：
     *   ① `replaceFile` 成功（写 `source_files` + `events`）；
     *   ② codex 发布事务**真实删除**路径（`DELETE FROM source_files`，`events` 经
     *      `ON DELETE CASCADE` 一并消失）；
     *   ③ 非 codex 来源的真实删除（同上）；
     *   ④ `liveChangedPaths` 的置脏 `UPDATE source_files`（强制下一轮重提取）。
     */
    let usageDerivedChanged = false;
    const changedSessions = new Set();
    /** M3.4：本轮**受阻**的 home（文件不可读或替换失败）⇒ 计入 `perf_degraded_home_ids`。 */
    const blockedHomeIds = new Set();
    /** M3.4：**逐文件**的失败归因（只记真正抛错的文件，避免误归因到成功的 home）。 */
    const fileFailures = [];
    /** M3.4 返工 **BB-1**：读取期间来源变化的告警（冻结码 `LIVE_SOURCE_CHANGED`）。 */
    const liveChangeWarnings = [];
    /** M3.4 返工 **BB-1**：读取期间变过的文件 ⇒ 必须置脏以强制下一轮重提取。 */
    const liveChangedPaths = new Set();
    /** M3.4 返工2 **BC-2**：因**真实删除**而移除的指纹分量（需写回映射）。 */
    const removedFingerprintPaths = new Set();
    /** Successful physical-file deletion also clears its committed reader diagnostics. */
    const removedSourcePaths = new Set();
    const previousCodexThreadsByPath = new Map();
    const addPreviousCodexThread = (sourcePath, homeId, threadId) => {
      const associations = previousCodexThreadsByPath.get(sourcePath) || [];
      if (!associations.some((entry) => entry.homeId === homeId && entry.threadId === threadId)) {
        associations.push({ homeId, threadId });
        previousCodexThreadsByPath.set(sourcePath, associations);
      }
    };
    for (const row of this.database.prepare("SELECT source_path, home_id, thread_id FROM perf_rollout_threads").all()) {
      addPreviousCodexThread(String(row.source_path), String(row.home_id), String(row.thread_id));
    }
    for (const row of this.database
      .prepare(`
      SELECT DISTINCT dependencies.source_path, rollouts.home_id, rollouts.thread_id
      FROM perf_sample_sources AS dependencies
      JOIN perf_rollout_threads AS rollouts ON rollouts.source_path = dependencies.source_path
    `)
      .all()) {
      addPreviousCodexThread(String(row.source_path), String(row.home_id), String(row.thread_id));
    }
    let codexPendingChange = false;
    /**
     * C1 卡：本轮**候选**的稳定失败尝试记录（`homeId → candidate`）。
     *
     * 只在"规划确实完成了一次**稳定验证**、且失败码全属确定性内容码"时写入；是否**提交**到
     * `this.codexStableAttempts` 由轮末的 {@link codexBlockEvents} 快照比对决定 —— 任何**后续**
     * 受阻（读取失败 / 发布前复核 `LIVE_SOURCE_CHANGED` / 发布事务 `ROLLBACK` / 跨 home 冲突 /
     * 用量侧失败 / 策略编码失败）都会让记录作废。
     */
    const codexStableAttemptCandidates = new Map();
    /**
     * C2 卡：**复用轮**里从命中记录取回的逐文件内容签名（`homeId → {paths, fileFingerprints}`）。
     *
     * 只在"该 home 本轮命中稳定失败记录、因此**跳过**整 home 规划"时写入。它是 C1 与 S2 的
     * **收益叠加补丁**：同一批文件在同一轮里只做一次内容摘要（C1 交付态实测复用轮
     * `store.decision.loop` 从 88 回到 449 ⇒ 其中 361 次是对签名里已有文件的重复探针 ⇒ 归零）。
     *
     * 生命周期严格限定在**本轮**：轮内局部 `Map`，**不挂 `this`、不落盘**，`syncRound` 返回即回收
     * （与 S2 的 `plan.probePathIndex` 同一纪律：缓存身份 = 本轮对象本身，不绑时间、不跨轮）。
     * @type {Map<string, {paths: string[], fileFingerprints: Record<string, string>}>}
     */
    const codexReusedSignatures = new Map();
    /**
     * C1 卡：本轮每个 home 被**判为受阻**的次数（**所有**受阻路径统一计数）。
     *
     * 为什么需要它：一条记录只有在"规划那一刻之后**没有**任何新的受阻事件"时才可信。用计数快照
     * 比对（而不是只看 `blockedHomeIds.has`）才能区分两种情况 ——
     *   * 规划本身就**确定性受阻**（`blockCodexHome` 在记录之前调用，计数已含在内）；
     *   * 规划之后**又**受阻（计数变大 ⇒ 记录作废）。
     * @type {Map<string, number>}
     */
    const codexBlockEvents = new Map();
    const bumpCodexBlockEvent = (homeId) => {
      if (!homeId) return;
      codexBlockEvents.set(homeId, (codexBlockEvents.get(homeId) || 0) + 1);
    };
    const addCodexAffectedThread = (homeId, threadId) => {
      if (!homeId || !threadId) return;
      if (!codexOldThreadIdsByHome.has(homeId)) codexOldThreadIdsByHome.set(homeId, new Set());
      codexOldThreadIdsByHome.get(homeId).add(threadId);
    };
    const blockCodexHome = (homeId, error, sourcePath = "") => {
      if (!homeId) return;
      bumpCodexBlockEvent(homeId);
      blockedHomeIds.add(homeId);
      fileFailures.push({
        sourceKind: "codex",
        homeId,
        code: perfWarningCodeForError(error),
        sourcePath,
      });
    };
    const codexFiles = files.filter((file) => canonicalizeKind(file.source?.kind) === "codex");
    const currentCodexPaths = new Set(codexFiles.map((file) => file.filePath));
    const publishedCodexFingerprints = this.publishedFileFingerprintsForRound();
    const publishedCodexWarnings = this.publishedFileWarningsForRound();
    const oldCodexRows = this.database
      .prepare("SELECT path, kind, home_id, home_label, home_path, size, mtime_ms FROM source_files")
      .all()
      .filter((row) => canonicalizeKind(String(row.kind ?? "")) === "codex");
    const oldCodexRowsByHome = new Map();
    const oldCodexRowsByPath = new Map();
    for (const row of oldCodexRows) {
      const homeId = String(row.home_id ?? "");
      const rows = oldCodexRowsByHome.get(homeId) || [];
      rows.push(row);
      oldCodexRowsByHome.set(homeId, rows);
      oldCodexRowsByPath.set(String(row.path), row);
    }
    const codexFilesByHome = new Map();
    for (const file of codexFiles) {
      const homeId = String(file.source?.id ?? "");
      const homeFiles = codexFilesByHome.get(homeId) || [];
      homeFiles.push(file);
      codexFilesByHome.set(homeId, homeFiles);
    }

    const codexOldThreadIdsByHome = new Map();
    const codexOldThreadPathsByHome = new Map();
    for (const [sourcePath, associations] of previousCodexThreadsByPath) {
      for (const previous of associations) {
        addCodexAffectedThread(previous.homeId, previous.threadId);
        const byThread = codexOldThreadPathsByHome.get(previous.homeId) || new Map();
        const paths = byThread.get(previous.threadId) || new Set();
        paths.add(sourcePath);
        byThread.set(previous.threadId, paths);
        codexOldThreadPathsByHome.set(previous.homeId, byThread);
      }
    }
    const codexOldSampleKeysByHome = new Map();
    const codexHomesWithUnkeyableOldSamples = new Set();
    for (const row of this.database
      .prepare("SELECT sample_key, home_id FROM perf_samples WHERE source_kind = 'codex'")
      .all()) {
      const homeId = String(row.home_id ?? "");
      const sampleKey = String(row.sample_key ?? "");
      const threadId = codexSampleThreadId({ sourceKind: "codex", homeId, sampleKey });
      if (!threadId) {
        codexHomesWithUnkeyableOldSamples.add(homeId);
        continue;
      }
      addCodexAffectedThread(homeId, threadId);
      const byThread = codexOldSampleKeysByHome.get(homeId) || new Map();
      const keys = byThread.get(threadId) || new Set();
      keys.add(sampleKey);
      byThread.set(threadId, keys);
      codexOldSampleKeysByHome.set(homeId, byThread);
    }

    const codexHomeById = new Map(
      homes
        .filter((home) => canonicalizeKind(String(home?.kind ?? home?.sourceKind ?? "")) === "codex")
        .map((home) => [String(home.id ?? ""), home]),
    );
    const priorPolicy = decodeCodexPublicationPolicy(this.readMetaRaw("perf_codex_publication_policy"));
    const policyNeedsUpgrade = !priorPolicy.usable || priorPolicy.revision !== CODEX_PUBLICATION_POLICY_REVISION;
    const priorPartialHomeIds = new Set(
      (priorPolicy.usable ? priorPolicy.partialHomes : []).map((entry) => entry.homeId),
    );
    const priorDegradedHomeIds = new Set(decodeJsonStringArray(this.readMetaRaw("perf_degraded_home_ids")));
    const partialHomesById = new Map(
      (priorPolicy.usable ? priorPolicy.partialHomes : []).map((entry) => [
        entry.homeId,
        new Set(entry.blockedThreadIds),
      ]),
    );
    let policyUpgradeComplete = true;
    if (policyNeedsUpgrade) {
      partialHomesById.clear();
      codexPendingChange = true;
    }

    const allCodexHomeIds = new Set([
      ...codexHomeById.keys(),
      ...oldCodexRowsByHome.keys(),
      ...codexOldThreadIdsByHome.keys(),
      ...priorPartialHomeIds,
    ]);
    // C1 卡：本轮**不再存在**的 home ⇒ 清掉它的稳定失败尝试记录（真实删除 / 归档迁移 / 来源移除）。
    for (const staleHomeId of [...this.codexStableAttempts.keys()]) {
      if (!allCodexHomeIds.has(staleHomeId)) this.codexStableAttempts.delete(staleHomeId);
    }
    // C3 卡：**home 整体消失**（来源移除 / 归档迁移 / 别名变化）⇒ 连带淘汰它的投影条目。
    this.codexProjections.retainHomes(allCodexHomeIds);
    const crossHomeBlockedIds = new Set();
    for (const file of codexFiles) {
      const currentHomeId = String(file.source?.id ?? "");
      const oldRow = oldCodexRowsByPath.get(file.filePath);
      const oldHomeIds = new Set((previousCodexThreadsByPath.get(file.filePath) || []).map((entry) => entry.homeId));
      if (oldRow) oldHomeIds.add(String(oldRow.home_id ?? ""));
      for (const oldHomeId of oldHomeIds) {
        if (oldHomeId === "" || oldHomeId === currentHomeId) continue;
        crossHomeBlockedIds.add(oldHomeId);
        crossHomeBlockedIds.add(currentHomeId);
        blockCodexHome(
          oldHomeId,
          Object.assign(new Error("Codex rollout moved across homes"), { code: "UNKEYABLE_RECORD" }),
          file.filePath,
        );
        blockCodexHome(
          currentHomeId,
          Object.assign(new Error("Codex rollout moved across homes"), { code: "UNKEYABLE_RECORD" }),
          file.filePath,
        );
      }
    }

    const codexPlans = new Map();
    // C4：每轮重建"受影响 / 保留"视图（`syncRound` 每轮进入一次 ⇒ 不跨轮累积）。
    this.codexThreadBuildPlan = new Map();
    for (const homeId of [...allCodexHomeIds].sort()) {
      const currentHome = codexHomeById.get(homeId);
      const oldRows = oldCodexRowsByHome.get(homeId) || [];
      const home =
        currentHome ||
        (oldRows[0]
          ? {
              id: homeId,
              label: String(oldRows[0].home_label ?? "Codex"),
              path: String(oldRows[0].home_path ?? ""),
              kind: "codex",
            }
          : null);
      if (!home) continue;
      const homeFiles = codexFilesByHome.get(homeId) || [];
      const expectedPaths = homeFiles.map((file) => file.filePath).sort();
      const oldPaths = oldRows.map((row) => String(row.path));
      const pathSetChanged =
        oldPaths.length !== expectedPaths.length || oldPaths.some((filePath) => !expectedPaths.includes(filePath));
      const metadataChanged = homeFiles.some((file) => {
        const existing = oldCodexRowsByPath.get(file.filePath);
        const sameMetadata = Boolean(
          existing &&
            Number(existing.size) === file.info.size &&
            Number(existing.mtime_ms) === file.info.mtimeMs &&
            existing.kind === (file.source.kind || "codex") &&
            existing.home_id === file.source.id &&
            existing.home_label === file.source.label &&
            existing.home_path === file.source.path,
        );
        const hasCurrentOwnership = (previousCodexThreadsByPath.get(file.filePath) || []).some(
          (entry) => entry.homeId === homeId,
        );
        return (
          !sameMetadata ||
          perfFileNeedsRefresh(file.source.kind, file.filePath, publishedCodexFingerprints, publishedCodexWarnings) ||
          !hasCurrentOwnership
        );
      });
      const shouldPlan =
        policyNeedsUpgrade ||
        priorDegradedHomeIds.has(homeId) ||
        priorPartialHomeIds.has(homeId) ||
        pathSetChanged ||
        metadataChanged ||
        codexHomesWithUnkeyableOldSamples.has(homeId);
      if (!shouldPlan) {
        // C1 卡：本轮**无需**规划 ⇒ 旧记录不再适用（该 home 已不处于"稳定失败"状态）。
        // 保留它只会在未来签名恰好重现时误用一条**来自另一个 DB 状态**的受阻投影。
        this.codexStableAttempts.delete(homeId);
        continue;
      }
      codexPendingChange = true;
      partialHomesById.delete(homeId);
      if (crossHomeBlockedIds.has(homeId)) {
        // C1：本轮**新**出现的跨 home 冲突 ⇒ 旧记录（来自另一个归属状态）立即作废。
        this.codexStableAttempts.delete(homeId);
        if (policyNeedsUpgrade) policyUpgradeComplete = false;
        continue;
      }
      if (codexHomesWithUnkeyableOldSamples.has(homeId)) {
        // C1：旧候选身份不可判定 ⇒ 必须重新规划；旧记录作废。
        this.codexStableAttempts.delete(homeId);
        blockCodexHome(
          homeId,
          Object.assign(new Error("Old Codex candidate identity is invalid"), { code: "UNKEYABLE_RECORD" }),
        );
        if (policyNeedsUpgrade) policyUpgradeComplete = false;
        continue;
      }
      if (failedHomeIds.has(homeId) || failedHomePaths.has(String(home.path ?? ""))) {
        // The failedHomes pass below records this once. Adding it here too would
        // inflate the warning count for the same failed discovery.
        // C1：发现阶段失败 ⇒ 旧记录作废（下一轮发现恢复后会重新规划一次）。
        this.codexStableAttempts.delete(homeId);
        if (policyNeedsUpgrade) policyUpgradeComplete = false;
        continue;
      }
      try {
        // ── C1 卡：稳定失败尝试记录命中 ⇒ **跳过整 home 全文规划** ────────────────────────────
        // 位置是刻意的：必须排在 `crossHomeBlockedIds` / `codexHomesWithUnkeyableOldSamples` /
        // `failedHomeIds` 三个守卫**之后** —— 那三条是**本轮**新出现的受阻原因，任何一条成立都
        // 必须重新判断，绝不能被一条旧记录盖住。
        //
        // 命中后的效果（逐条与原路径等价，见报告"实现行为"）：
        //   * **不**调用 `planStableCodexHome` ⇒ 零全文解析、零 `buildCodexThreadPerfSamples`；
        //   * 本 home **不进入** `codexPlans` ⇒ 发布循环不触碰它 ⇒ 已发布候选（健康兄弟线程）
        //     原样保留，不做 delete/insert、不空发布；
        //   * 记录里的 `partialHomes`（被隔离线程）与逐文件告警**原样重新投影** ⇒ 告警既不丢失
        //     也不累加，`perf_degraded_home_ids` / `perf_codex_publication_policy` 与原路径一致。
        const reusedAttempt = this.codexStableAttemptMatch(homeId, home, expectedPaths);
        if (reusedAttempt !== null) {
          // C2 卡：把命中判定**刚刚取到**的逐文件签名留给本轮逐文件判据（`pendingChange` 预扫同）。
          // 位置就在命中判定内部 —— 签名与消费点之间**没有**对该文件的任何读取（红线 ①，见
          // `codexReusedProbeValue` 的注释与报告「实现行为」的逐条论证）。
          // `paths` 取**副本**、`fileFingerprints` 只读共享：路径索引会挂到这里的包装对象上，
          // 绝不写进 `this.codexStableAttempts` 里的那条记录。
          codexReusedSignatures.set(homeId, {
            paths: [...reusedAttempt.paths],
            fileFingerprints: reusedAttempt.fileFingerprints,
          });
          if (reusedAttempt.blockedHomeWarnings.length > 0) {
            for (const warning of reusedAttempt.blockedHomeWarnings) {
              blockCodexHome(
                homeId,
                Object.assign(new Error("Codex home planning was incomplete"), { code: warning.code }),
                warning.sourcePath,
              );
            }
          } else {
            partialHomesById.set(homeId, new Set(reusedAttempt.blockedThreadIds));
            for (const failure of reusedAttempt.failedThreads) {
              const failedPaths = failure.failedFilePaths || [];
              if (failedPaths.length === 0) fileFailures.push({ sourceKind: "codex", homeId, code: failure.reason });
              else {
                fileFailures.push(
                  ...failedPaths.map((sourcePath) => ({
                    sourceKind: "codex",
                    homeId,
                    code: failure.reason,
                    sourcePath,
                  })),
                );
              }
            }
          }
          // C2 卡：**不得**因为"本轮走的是复用"就放弃重建发布策略。
          //
          // C1 在这里写的是 `if (policyNeedsUpgrade) policyUpgradeComplete = false;`。后果：策略键
          // 缺失/损坏/版本不符时，只要记录一直命中，`perf_codex_publication_policy` 就**永远写不
          // 回去**（每轮都判 `needsUpgrade`、每轮都放弃写）。而消费者是按**库里的策略 + 库里的
          // `perf_degraded_home_ids`** 建发布过滤器的（`createCodexPublishFilter`）⇒ 一个"部分受限"
          // 的 home 会被当成**整 home 排除**，它的健康兄弟线程静默掉出排名 —— 与"复用轮告警/排名
          // 与未复用臂逐项相同"的验收直接冲突。
          //
          // 复用重放出的 partial 集合**就是**上一轮写进策略的那份投影，本轮具备把策略重建出来的
          // 全部信息 ⇒ 这里不再放弃重建。写出来只会比"键一直缺失"更保守（缺项 home 仍按整 home
          // 排除），不会放松任何排除。home 级受阻（`blockedHomeWarnings` 非空）本来就**不进入**
          // 策略，它的语义就是整 home 排除。
          continue;
        }
        // ── C3 卡：整 home 规划（含**未变文件标准化投影复用**）────────────────────────────
        // 浅拷贝只为把实例私有投影缓存交给 planner（`planStableCodexHome` 的签名行是 B2 的锚点，
        // 逐字节不可改 ⇒ 缓存挂属性而不是新增形参；`home` 本身不被改写）。
        // `finally` 保证**无论规划是否抛错**都做一次收尾：
        //   * 稳定窗口（`window.stable === true`，即读取前/后内容指纹与路径集逐字一致）⇒ `commit`
        //     （只有这一刻的投影才算"可复用"）；
        //   * 其余（不可证/不稳定/抛错）⇒ `rollback` **丢弃**本轮暂存（失效即重算，绝不粘到下一轮）；
        //   * `prune`：只保留本轮发现到的当前路径（替换/删除/重命名淘汰）。
        let window = null;
        try {
          window = await planStableCodexHome({ ...home, projectionCache: this.codexProjections }, expectedPaths);
        } finally {
          if (window !== null && window.stable === true) this.codexProjections.commit(homeId);
          else this.codexProjections.rollback(homeId);
          this.codexProjections.prune(homeId, expectedPaths);
        }
        if (!window.ok || !window.stable || !window.plan?.ok) {
          const code =
            window.code ??
            window.plan?.homeBlocking?.[0]?.code ??
            window.plan?.unownedFiles?.[0]?.code ??
            "UNKEYABLE_RECORD";
          const failures = [...(window.plan?.homeBlocking ?? []), ...(window.plan?.unownedFiles ?? [])];
          /** C1：本轮**实际写出**的 home 级受阻告警（供稳定失败记录原样重放）。 */
          const blockedHomeWarnings = [];
          if (code === "LIVE_SOURCE_CHANGED" || failures.length === 0) {
            blockedHomeWarnings.push({ code, sourcePath: "" });
            blockCodexHome(homeId, Object.assign(new Error("Codex home planning was incomplete"), { code }));
          } else {
            for (const failure of failures) {
              const failureCode = PERF_SOURCE_WARNING_CODES.has(failure.code) ? failure.code : "READ_ONLY_OPEN_FAILED";
              blockedHomeWarnings.push({ code: failureCode, sourcePath: String(failure.filePath ?? "") });
              blockCodexHome(
                homeId,
                Object.assign(new Error("Codex home planning was incomplete"), { code: failureCode }),
                String(failure.filePath ?? ""),
              );
            }
          }
          // C1：只有"稳定验证已完成（`stable` + 前后快照可证）**且**全部失败码都是确定性内容码"
          // 才允许记录 —— 卡面"仅稳定验证完成的确定性失败可复用"。`LIVE_SOURCE_CHANGED`、
          // `READ_ONLY_OPEN_FAILED` 与任何未冻结码都落在允许清单之外，因此永不进入记录。
          if (
            window.stable === true &&
            window.after?.complete === true &&
            blockedHomeWarnings.length > 0 &&
            blockedHomeWarnings.every((warning) => CODEX_DETERMINISTIC_FAILURE_CODES.has(warning.code))
          ) {
            codexStableAttemptCandidates.set(homeId, {
              home,
              expectedPaths,
              window,
              failedThreads: null,
              blockedHomeWarnings,
              blockEvents: codexBlockEvents.get(homeId) || 0,
            });
          }
          if (policyNeedsUpgrade) policyUpgradeComplete = false;
          continue;
        }
        // ── C4 卡：**只构建受影响线程**（判据见 `codexThreadNeedsBuild` 的注释）────────────
        // 未受影响的线程**根本不调用** `buildCodexThreadPerfSamples()` ⇒ 它们的已发布候选
        // （`perf_samples` / `perf_sample_sources` / `perf_rollout_threads` 行）原样保留，
        // 发布循环既不会 delete 也不会 insert（见「Publish only ...」段的 C4 注释）。
        // ⚠️ 归属证明（`window.plan.threads`）**完全不变**：受影响集合只决定"要不要重跑 builder"，
        // **不**决定"这个文件属于哪个线程"—— 后者仍由 planner 的完整文件集证明。
        const stageOldThreadIds = codexOldThreadIdsByHome.get(homeId) || new Set();
        const stageOldPathsByThread = codexOldThreadPathsByHome.get(homeId) || new Map();
        const stagedThreads = [];
        const retainedThreadIds = [];
        for (const thread of window.plan.threads) {
          const rolloutFiles = thread.rollouts.map((rollout) => rollout.filePath).sort();
          if (
            !codexThreadNeedsBuild(
              { threadId: thread.threadId, rolloutFiles },
              stageOldThreadIds,
              stageOldPathsByThread,
              window.after.fileFingerprints,
              publishedCodexFingerprints,
            )
          ) {
            retainedThreadIds.push(thread.threadId);
            continue;
          }
          const built = buildCodexThreadPerfSamples(homeId, thread.threadId, thread.rollouts);
          stagedThreads.push({
            homeId,
            threadId: thread.threadId,
            rolloutFiles,
            samples: built.samples,
            warnings: built.warnings,
            fingerprints: Object.fromEntries(
              thread.rollouts.map((rollout) => [rollout.filePath, window.after.fileFingerprints[rollout.filePath]]),
            ),
          });
        }
        codexPlans.set(homeId, {
          home,
          expectedPaths,
          window,
          stagedThreads,
          // C4：全部**当前存在**的线程及其完整路径集 —— 发布阶段判定"旧线程是否已消失"
          // 与"路径转移冲突"都必须看**全部**当前线程，而不是只看本轮重建的那一批。
          threadPaths: window.plan.threads.map((thread) => ({
            threadId: thread.threadId,
            filePaths: thread.rollouts.map((rollout) => rollout.filePath).sort(),
          })),
          retainedThreadIds,
          failedThreads: window.plan.failedThreads,
        });
        // C4：证据/测试用只读视图（覆盖式写入，无跨轮累积）。
        this.codexThreadBuildPlan.set(homeId, {
          staged: stagedThreads.map((staged) => staged.threadId),
          retained: [...retainedThreadIds],
        });
        if (window.plan.failedThreads.length > 0) {
          const blockedThreadIds = new Set(window.plan.failedThreads.map((entry) => entry.threadId));
          partialHomesById.set(homeId, blockedThreadIds);
          for (const failure of window.plan.failedThreads) {
            const failedPaths = failure.failedFilePaths || [];
            if (failedPaths.length === 0) fileFailures.push({ sourceKind: "codex", homeId, code: failure.reason });
            else {
              fileFailures.push(
                ...failedPaths.map((sourcePath) => ({ sourceKind: "codex", homeId, code: failure.reason, sourcePath })),
              );
            }
          }
          // C1 卡：一次**稳定验证完成**的"部分失败"（可隔离的确定性坏内容）⇒ 记录候选。
          // 提交与否在轮末按 `codexBlockEvents` 快照比对决定（发布前复核/发布事务/跨 home 冲突
          // 任一后续受阻都会作废它）。`blockedThreadIds` 用轮末的**最终**集合（还会并入
          // `blockedOldThreadIds`），见轮末提交段。
          if (
            window.stable === true &&
            window.after?.complete === true &&
            window.plan.failedThreads.every((entry) => CODEX_DETERMINISTIC_FAILURE_CODES.has(entry.reason))
          ) {
            codexStableAttemptCandidates.set(homeId, {
              home,
              expectedPaths,
              window,
              failedThreads: window.plan.failedThreads,
              blockedHomeWarnings: null,
              blockEvents: codexBlockEvents.get(homeId) || 0,
            });
          }
        }
      } catch (error) {
        blockCodexHome(homeId, error);
        if (policyNeedsUpgrade) policyUpgradeComplete = false;
      }
    }
    for (const homeId of crossHomeBlockedIds) {
      partialHomesById.delete(homeId);
      if (policyNeedsUpgrade) policyUpgradeComplete = false;
    }

    /**
     * M3.4 **D1**：`"有变更的 sync"` 的判据 = **本轮将实际重解析的文件数 > 0**。
     *
     * 这里做一次**预扫**（与循环内同一判据的**只读**版本），只用来决定"要不要在开始前标
     * `rebuilding`"。**不预扫就无法在"开始前"判断**，而卡片明确要求"**开始有变更的
     * sync 前**标 `rebuilding`" —— 即无变更的轮次**不得**翻转状态（否则每次 `--check`
     * 式的空轮都会把库短暂标成 rebuilding，下游会拒绝一次本来就完整的排名）。
     *
     * 判据的**权威**仍是循环内的实时判断（它还要看 `earlierFileChanged` 的会话级联）；
     * 预扫只是它的**保守超集**，因此可能出现"预扫说有变更、实际全被跳过"的轮次 ——
     * 那时会在结尾把状态写回 `ready`，**不会**留下错误的 `rebuilding`（见结尾的兜底）。
     */
    const pendingChange =
      codexPendingChange ||
      files.some((file) => {
        const existing = this.database
          .prepare("SELECT size, mtime_ms, kind, home_id, home_label, home_path FROM source_files WHERE path = ?")
          .get(file.filePath);
        if (!existing) return true;
        if (
          Number(existing.size) === file.info.size &&
          Number(existing.mtime_ms) === file.info.mtimeMs &&
          existing.kind === (file.source.kind || "codex") &&
          existing.home_id === file.source.id &&
          existing.home_label === file.source.label &&
          existing.home_path === file.source.path
        ) {
          // ── B7（返工2 新发现）：`size + mtimeMs` **不足以**判定"未变" ──
          // 我实测：**同尺寸原地改写并把 mtime 钉成同一整毫秒** ⇒ 两个分量**完全相同**，
          // 但文件内容已变 ⇒ 若只看 size/mtime 会**整轮跳过**该文件（`replaceFile` 调用次数 = 0），
          // 版本与候选都不更新。⇒ 再把**内容指纹**（`enabledPerfSourceStat`，含首尾 64KiB 摘要）
          // 与**已发布指纹**比对，**不同则视为有变更**。
          //
          // M4.5 distinguishes disabled sources (current=null, retain size/mtime
          // behavior) from newly enabled sources (no published extraction, backfill).
          const kind = String(file.source?.kind ?? "");
          // M4.5: a newly enabled source may already have unchanged usage rows but
          // no published perf extraction. Also backfill legacy rows that predate
          // the per-file warning sidecar. An explicit [] means extraction completed.
          // C2：同一份内容签名也喂给预扫（口径与逐文件判据一致，卡面"贯通 `pendingChange`"）。
          // ⚠️ **结构性不可达**：`pendingChange = codexPendingChange || files.some(...)`，而"命中复用"
          // 要求 `shouldPlan === true`，该分支同时把 `codexPendingChange` 置 `true` ⇒ `files.some`
          // 被 `||` 短路。因此这一行**不改变任何计数**（`store.decision.prescan` 仍恒为 0，报告
          // 「未测/边界」有断言与 `proof-prescan-dead.mjs` 的仪器化证明）；保留它是为了让"签名同时
          // 供给两个判据"这条不变量在源码上显式，将来若有人去掉短路，它仍然是正确的一侧。
          const prescanReusedCurrent = this.codexReusedProbeValue(
            codexReusedSignatures.get(String(file.source?.id ?? "")),
            kind,
            file.filePath,
          );
          if (
            perfFileNeedsRefresh(
              kind,
              file.filePath,
              this.publishedFileFingerprintsForRound(),
              this.publishedFileWarningsForRound(),
              prescanReusedCurrent,
            )
          ) {
            return true;
          }
          return false;
        }
        return true;
      });

    // ★ 卡片明文：**开始有变更的 sync 前**标 `rebuilding`。
    // 此刻写入是**事务外**（autocommit）⇒ 立即可被随后的 `summarize` 读到，
    // 这正是"同步期间调用 summarize 得到 rebuilding"能够成立的原因。
    if (pendingChange) {
      this.writePerfState(PERF_STATE_REBUILDING, { degradedHomeIds: [], sourceWarnings: [] });
    }

    for (const file of files) {
      const existing = this.database
        .prepare("SELECT size, mtime_ms, kind, home_id, home_label, home_path FROM source_files WHERE path = ?")
        .get(file.filePath);
      const previousSessions = existing
        ? this.database
            .prepare("SELECT DISTINCT session_id FROM events WHERE source_path = ?")
            .all(file.filePath)
            .map((row) => row.session_id)
        : [];
      const earlierFileChanged = previousSessions.some((sessionId) => changedSessions.has(sessionId));
      if (
        !earlierFileChanged &&
        existing &&
        Number(existing.size) === file.info.size &&
        Number(existing.mtime_ms) === file.info.mtimeMs &&
        existing.kind === (file.source.kind || "codex") &&
        existing.home_id === file.source.id &&
        existing.home_label === file.source.label &&
        existing.home_path === file.source.path
      ) {
        // ── B7（返工2 新发现，与上方预扫**同一判据**）──
        // `size + mtimeMs` 全同**不蕴含**内容未变（实测：同尺寸 + 同整毫秒 mtime 的原地改写）。
        // M4.5: also extract an enabled source with no published fingerprint
        // or no committed per-file warning entry. Disabled sources still have
        // currentStat=null and are skipped; successful n=0 extraction writes []
        // so it is not repeated.
        const changedKind = String(file.source?.kind ?? "");
        // S2：**读取后稳定窗口**内的等价摘要复用 —— 该 rollout 本轮已在 codex 规划里被整文件解析过，
        // 且此后没有再次读取它；窗口不可用/失效时返回 `undefined` ⇒ 走下面的真实探针。
        const windowedCurrent = this.codexWindowedProbeValue(
          codexPlans.get(String(file.source?.id ?? "")),
          changedKind,
          file.filePath,
        );
        // C2：**复用轮**（C1 稳定失败记录命中 ⇒ 该 home 本轮不在 `codexPlans` 里）改用 C1 的稳定签名。
        // 两者**互斥**且各自有守卫："窗口"只在"本 home 本轮做过规划"时非 `undefined`，"签名"只在
        // "本 home 本轮命中记录"时存在 —— 二者不可能同时成立，故这个优先级顺序不承载语义，
        // 只是把"同一物理文件同一轮只取一次真实摘要"这条纪律落到两个来源上。
        const reusedCurrent =
          windowedCurrent === undefined
            ? this.codexReusedProbeValue(
                codexReusedSignatures.get(String(file.source?.id ?? "")),
                changedKind,
                file.filePath,
              )
            : windowedCurrent;
        if (
          !perfFileNeedsRefresh(
            changedKind,
            file.filePath,
            this.publishedFileFingerprintsForRound(),
            this.publishedFileWarningsForRound(),
            reusedCurrent,
          )
        ) {
          continue;
        }
      }
      try {
        const replaceOutcome = await this.replaceFile(file, {
          onWarning: (warning) => warnings.push(warning),
          liveChangeWarnings,
          liveChangedPaths,
          blockedHomeIds,
        });
        for (const row of this.database
          .prepare("SELECT DISTINCT session_id FROM events WHERE source_path = ?")
          .all(file.filePath)) {
          changedSessions.add(row.session_id);
        }
        updatedFileCount += 1;
        // C5 提交点 ①：`replaceFile` 成功 ⇒ `source_files` 与 `events` 都被写过。
        usageDerivedChanged = true;
        // D1：**只有真的 `COMMIT` 了**才推进实例修订 —— 读取窗口内变化那条路径会整笔 `ROLLBACK`
        // 并返回 `committed: false`（那种情况由下面的 `liveChangedPaths` 置脏点推进修订）。
        if (replaceOutcome?.committed) {
          this.commitStoreRevision(replaceOutcome.quotaWritten ? "usage+quota" : "usage");
        }
      } catch (error) {
        // ⚠️ **保留原用量告警**（用户明示）：这条字符串带着路径与原因，是**用量侧**的告警，
        // 不因我们另外做 perf 归因而被吞掉。
        warnings.push(`无法索引 ${file.filePath}: ${error.message}`);
        // M3.4: performance failure attribution only applies to enabled sources;
        // usage-side failures from unsupported/unregistered sources stay usage warnings.
        const kindRaw = String(file.source?.kind ?? file.source?.sourceKind ?? "");
        if (file.source?.id && isPerfSourceEnabled(kindRaw)) {
          // C1：用量侧受阻同样算一次"受阻事件" ⇒ 该 home 的稳定失败记录候选作废。
          bumpCodexBlockEvent(String(file.source.id));
          blockedHomeIds.add(String(file.source.id));
          // BB-4：归因码**取 reader 自己带的冻结码**（见 `perfWarningCodeForError`）。
          fileFailures.push({
            sourceKind: canonicalizeKind(kindRaw),
            homeId: String(file.source.id),
            code: perfWarningCodeForError(error),
            sourcePath: file.filePath,
          });
        }
      }
    }

    for (const [homeId, plan] of codexPlans) {
      if (blockedHomeIds.has(homeId)) {
        partialHomesById.delete(homeId);
        if (policyNeedsUpgrade) policyUpgradeComplete = false;
        continue;
      }
      try {
        const discovered = (await discoverSessionFiles(plan.home.path)).sort();
        const pathsStable =
          discovered.length === plan.expectedPaths.length &&
          discovered.every((filePath, index) => filePath === plan.expectedPaths[index]);
        const currentFingerprints = pathsStable
          ? discovered.map((filePath) => enabledPerfSourceStat("codex", filePath))
          : [];
        const unreadable = currentFingerprints.some((fingerprint) => fingerprint === null);
        const contentsStable =
          pathsStable &&
          !unreadable &&
          discovered.every(
            (filePath, index) => currentFingerprints[index] === plan.window.after.fileFingerprints[filePath],
          );
        if (!contentsStable) {
          blockCodexHome(
            homeId,
            Object.assign(new Error("Codex source changed or became unreadable before publication"), {
              code: unreadable ? "READ_ONLY_OPEN_FAILED" : "LIVE_SOURCE_CHANGED",
            }),
          );
          partialHomesById.delete(homeId);
          if (policyNeedsUpgrade) policyUpgradeComplete = false;
        }
      } catch (error) {
        blockCodexHome(homeId, error);
        partialHomesById.delete(homeId);
        if (policyNeedsUpgrade) policyUpgradeComplete = false;
      }
    }

    // Publish only fully staged threads. A failed current thread keeps its old
    // publication; a path owned by that retained graph can never be rebound.
    //
    // C4 卡：本段只对**受影响线程**做替换事务 ——
    //   * `stagedThreads` = 本轮**受影响**的当前线程（planner 证明过的新归属 / 路径集变化 / 内容变化）；
    //   * `retainedThreadIds` = 本轮**未受影响**的当前线程 ⇒ 已发布候选**原样保留**：既不
    //     `DELETE FROM perf_samples` / `perf_rollout_threads`，也不重新 `INSERT`，更不空发布；
    //   * 旧线程若**已不存在**（删除 / 归档迁走 / 重归属到别的 threadId）仍必须清掉它的行 ⇒
    //     见下面 `replaceOldThreadIds` 的第二个析取项。
    for (const [homeId, plan] of codexPlans) {
      if (blockedHomeIds.has(homeId)) {
        partialHomesById.delete(homeId);
        if (policyNeedsUpgrade) policyUpgradeComplete = false;
        continue;
      }
      const failedThreadIds = new Set(plan.failedThreads.map((entry) => entry.threadId));
      const failedPaths = new Set(plan.failedThreads.flatMap((entry) => entry.filePaths));
      const oldThreadIds = codexOldThreadIdsByHome.get(homeId) || new Set();
      const oldPathsByThread = codexOldThreadPathsByHome.get(homeId) || new Map();
      const blockedOldThreadIds = new Set();
      for (const threadId of oldThreadIds) {
        const oldPaths = oldPathsByThread.get(threadId) || new Set();
        if (failedThreadIds.has(threadId) || [...oldPaths].some((sourcePath) => failedPaths.has(sourcePath))) {
          blockedOldThreadIds.add(threadId);
        }
      }
      // C4：冲突检测必须覆盖**全部当前线程**（不只是本轮重建的那一批）—— 一个未受影响、
      // 因此不重建的线程，只要它的某个 rollout 仍被**受阻的旧线程**持有，同样是"路径转移冲突"，
      // 必须整 home 受阻（否则会在保留旧图的同时把同一路径重新绑定给新线程）。
      const pathTransferConflict = plan.threadPaths.some((thread) =>
        thread.filePaths.some((sourcePath) =>
          (previousCodexThreadsByPath.get(sourcePath) || []).some(
            (entry) => entry.homeId === homeId && blockedOldThreadIds.has(entry.threadId),
          ),
        ),
      );
      if (pathTransferConflict) {
        blockCodexHome(
          homeId,
          Object.assign(new Error("A failed old Codex thread still owns a planned rollout"), {
            code: "UNKEYABLE_RECORD",
          }),
        );
        partialHomesById.delete(homeId);
        if (policyNeedsUpgrade) policyUpgradeComplete = false;
        continue;
      }

      // Retained old graphs remain recoverable in storage, but neither identity
      // may contribute to the partial publication while the replacement fails.
      const blockedThreadIds = partialHomesById.get(homeId) || new Set();
      for (const threadId of failedThreadIds) blockedThreadIds.add(threadId);
      for (const threadId of blockedOldThreadIds) blockedThreadIds.add(threadId);
      if (blockedThreadIds.size > 0) partialHomesById.set(homeId, blockedThreadIds);

      const stagedThreads = plan.stagedThreads;
      const stagedThreadIds = new Set(stagedThreads.map((staged) => staged.threadId));
      const currentThreadIds = new Set(plan.threadPaths.map((thread) => thread.threadId));
      // C4：旧线程要删除+重插 ⟺ （本轮受影响）或（本轮已不存在）。**当前存在且未受影响**的
      // 旧线程不在其中 ⇒ 它的候选与指纹/告警分量原样留在库里。
      const replaceOldThreadIds = [...oldThreadIds].filter(
        (threadId) =>
          !blockedOldThreadIds.has(threadId) && (stagedThreadIds.has(threadId) || !currentThreadIds.has(threadId)),
      );
      const nextFingerprints = { ...this.publishedFileFingerprintsForRound() };
      const nextWarnings = this.publishedFileWarningsForRound();
      const oldPathsToClear = new Set();
      for (const threadId of replaceOldThreadIds) {
        for (const sourcePath of oldPathsByThread.get(threadId) || []) oldPathsToClear.add(sourcePath);
      }
      const currentPathSet = new Set(plan.expectedPaths);
      for (const row of oldCodexRowsByHome.get(homeId) || []) {
        const sourcePath = String(row.path);
        if (currentPathSet.has(sourcePath)) continue;
        const retainedOwner = (previousCodexThreadsByPath.get(sourcePath) || []).some(
          (entry) => entry.homeId !== homeId || blockedOldThreadIds.has(entry.threadId),
        );
        if (!retainedOwner) oldPathsToClear.add(sourcePath);
      }
      const deletedCodexPaths = [...oldPathsToClear].filter((sourcePath) => !currentCodexPaths.has(sourcePath));
      // C4 卡：本 home **没有**受影响线程、没有要清掉的旧线程、也没有真实删除 ⇒ **整个替换事务都不开**。
      // 这就是"无关线程复用已发布候选（不 delete/insert、不空发布）"的可执行判据：一个只被
      // 未受影响线程占据的 home，本轮的 `perf_samples` / `perf_sample_sources` /
      // `perf_rollout_threads` 行**一个字节都不动**，也不会留下空发布。
      if (replaceOldThreadIds.length === 0 && stagedThreads.length === 0 && deletedCodexPaths.length === 0) continue;

      // D1：本事务**全同步**（没有 `await`）⇒ 读路径不可能插进来读到未提交状态，因此**不需要**
      // `writeTransactionDepth` 记账（深度只服务 `replaceFile` 那个跨 `await` 的事务）。
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const committedDeletedPaths = [];
        for (const threadId of replaceOldThreadIds) {
          for (const sampleKey of codexOldSampleKeysByHome.get(homeId)?.get(threadId) || []) {
            this.database.prepare("DELETE FROM perf_samples WHERE sample_key = ?").run(sampleKey);
          }
        }
        for (const threadId of replaceOldThreadIds) {
          this.database
            .prepare("DELETE FROM perf_rollout_threads WHERE home_id = ? AND thread_id = ?")
            .run(homeId, threadId);
        }
        for (const sourcePath of oldPathsToClear) delete nextWarnings[sourcePath];

        for (const staged of stagedThreads) {
          for (const sourcePath of staged.rolloutFiles) {
            this.database
              .prepare("INSERT INTO perf_rollout_threads (source_path, home_id, thread_id) VALUES (?, ?, ?)")
              .run(sourcePath, homeId, staged.threadId);
          }
          for (const sample of staged.samples) {
            this.insertPerfSample(sample);
            for (const sourcePath of staged.rolloutFiles) {
              this.database
                .prepare("INSERT INTO perf_sample_sources (sample_key, source_path, role) VALUES (?, ?, ?)")
                .run(sample.sampleKey, sourcePath, sourcePath === sample.sourcePath ? "primary" : "dependency");
            }
          }
          if (staged.rolloutFiles.length > 0)
            nextWarnings[staged.rolloutFiles[0]] = normalizeSourceWarnings(staged.warnings);
          Object.assign(nextFingerprints, staged.fingerprints);
        }

        for (const sourcePath of deletedCodexPaths) {
          const retainedOwner = (previousCodexThreadsByPath.get(sourcePath) || []).some(
            (entry) => entry.homeId !== homeId || blockedOldThreadIds.has(entry.threadId),
          );
          if (retainedOwner) continue;
          this.database.prepare("DELETE FROM source_files WHERE path = ?").run(sourcePath);
          delete nextFingerprints[sourcePath];
          delete nextWarnings[sourcePath];
          committedDeletedPaths.push(sourcePath);
        }
        this.writeMeta("perf_file_fingerprints", JSON.stringify(nextFingerprints));
        this.writeMeta("perf_file_warnings", JSON.stringify(nextWarnings));
        if (this.database.prepare("PRAGMA foreign_key_check").all().length > 0) {
          throw Object.assign(new Error("Codex publication violated a foreign key"), { code: "READ_ONLY_OPEN_FAILED" });
        }
        this.database.exec("COMMIT");
        // S1：成功提交后写回轮内视图；失败（下面的 catch 回滚）时视图保持旧值。
        this.publishedFileMapsView?.commit(nextFingerprints, nextWarnings);
        for (const sourcePath of committedDeletedPaths) {
          removedSourcePaths.add(sourcePath);
          removedFingerprintPaths.add(sourcePath);
        }
        // C5 提交点 ②：发布事务里**真实删除**了 `source_files` 行 ⇒ `events` 经
        // `ON DELETE CASCADE` 一并消失（删的是 codex 路径，但它同样可能有用量行）。
        if (committedDeletedPaths.length > 0) usageDerivedChanged = true;
        // D1：本事务是**成功提交**的 ⇒ 显式修订。两类都要覆盖（卡面"实际用量 / perf 发布"）：
        //   * **perf 候选发布**：本事务真的改写了 `perf_samples` / `perf_rollout_threads`
        //     （`replaceOldThreadIds` = 清掉旧线程的候选，`stagedThreads` = 写入新候选）；
        //   * **用量侧真删**：`committedDeletedPaths` 非空 ⇒ 上面的 `events` 也真的少了行。
        // ⚠️ 卡面明文"**例行时刻元数据不作为用量变化**"：本事务里 `perf_file_fingerprints` /
        // `perf_file_warnings` 的每轮重写**不算**内容变化 —— 它们只在这两类真实变化**同时发生**时
        // 被顺带写，因此上面按 `replaceOldThreadIds`/`stagedThreads`/`committedDeletedPaths` 判定。
        if (replaceOldThreadIds.length > 0 || stagedThreads.length > 0) this.commitStoreRevision("perf");
        if (committedDeletedPaths.length > 0) this.commitStoreRevision("usage-delete");
      } catch (error) {
        this.database.exec("ROLLBACK");
        blockCodexHome(homeId, error);
        partialHomesById.delete(homeId);
        if (policyNeedsUpgrade) policyUpgradeComplete = false;
      }
    }

    // **BC-2 判据（见报告 §3）**：区分"**真实删除**"与"**受阻**"——靠**下一轮 discovery 的事实**：
    //   - **受阻**：文件仍被 discovery 发现（在 `knownFiles` 里）⇒ 只是读不到 ⇒ 保留 `source_files`
    //     行与指纹映射，并计入 `degraded`（候选保留供回滚、但被 D4 排除出排名）；
    //   - **真实删除**：文件**不再**出现在本轮 `files` 里（且其 home 未失败、**未被发现**）⇒
    //     删除 `source_files` 行（候选经 `ON DELETE CASCADE` 一并清除），并**同步删除指纹分量**
    //     ⇒ 版本不再表征一个已不存在的来源。
    //   ⚠️ 这正是 `★4` 已立的区分（"文件整体消失"≠"文件存在但不可读"），本修复**不破坏**它，
    //     只是把**指纹映射**也按同一判据同步。
    const publishedFingerprintsBefore = this.publishedFileFingerprintsForRound();
    for (const row of this.database.prepare("SELECT path, kind, home_id, home_path FROM source_files").all()) {
      if (!knownFiles.has(row.path) && !failedHomeIds.has(row.home_id) && !failedHomePaths.has(row.home_path)) {
        if (canonicalizeKind(String(row.kind)) === "codex") continue;
        this.database.prepare("DELETE FROM source_files WHERE path = ?").run(row.path);
        removedSourcePaths.add(String(row.path));
        // C5 提交点 ③：非 codex 来源的真实删除 ⇒ `events` 经 `ON DELETE CASCADE` 一并消失。
        usageDerivedChanged = true;
        // D1：这条 `DELETE` 是一条独立的 autocommit 语句 ⇒ 已经提交，推进修订。
        this.commitStoreRevision("usage-delete");
        // 真实删除 ⇒ 移除该文件的已发布指纹分量（否则版本会表征不存在的来源）。
        const removedPath = String(row.path);
        if (Object.hasOwn(publishedFingerprintsBefore, removedPath)) {
          delete publishedFingerprintsBefore[removedPath];
          removedFingerprintPaths.add(removedPath);
        }
      }
    }

    // M3.4 返工 **BB-1**：读取期间变过的文件 ⇒ **确保下次重新提取**。
    // 做法：把 `source_files.size/mtime_ms` 置 `-1`（沿用 v12 迁移的同一"置脏"手法）
    // ⇒ 下一轮增量判据（`size===info.size && mtime===info.mtimeMs`）**必然**不成立 ⇒ 重解析。
    // ⚠️ 这**不影响**本轮已写入的候选（它们留在库里供失败回滚），但 `perf_state=degraded`
    // 已把它们**排除出默认排名**（D4）⇒ 陈旧候选绝不会静默参与排名。
    for (const path of liveChangedPaths) {
      this.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(path);
    }
    // C5 提交点 ④：置脏写的就是 `source_files`（下一轮必然重提取 ⇒ 用量行随后必变）。
    if (liveChangedPaths.size > 0) usageDerivedChanged = true;
    // D1：置脏的 `UPDATE` 已提交（autocommit）⇒ 推进修订。注意**不**在这里推进"替换成功"的修订
    // —— 那个文件的替换事务已经整笔 `ROLLBACK` 了（`replaceFile` 返回 `committed: false`）。
    if (liveChangedPaths.size > 0) this.commitStoreRevision("live-dirty");

    // ── M3.4：解析本轮最终状态 ───────────────────────────────────────────────
    //
    // 三类"受阻"来源**必须分开**（卡片明文，不可混淆）：
    //   ① `failedHomes`：home 在**发现阶段**就失败（目录读不了）⇒ 其文件**根本没进本轮扫描**。
    //      这些 home 的旧候选**仍在库里**（三段合取保护），因此属于"当前排名不可信"，
    //      必须计入退化 —— 否则它们的陈旧候选会**悄悄参与排名**（卡片明文禁止）。
    //   ② `blockedHomeIds`：文件被发现、但 `replaceFile` 抛错 ⇒ 该 home 候选**不完整**。
    //   ③ `unsupportedSources`：来源**未启用**（如 `project-log`/未注册 kind）⇒ **不是退化**，
    //      单列即可，**不得令其他来源退化**。
    //
    // ⚠️ **BB-2（用户复现）**：① 与 ② 都**必须先问"该来源是否启用"**。用户注入**未启用
    // Codex 来源**的用量失败后得到 `perf_state=degraded`，且同一 home **同时**出现在
    // `unsupported` 与 `degraded` 两个列表 —— 直接违反上面 ③ 的明文。原代码在 ① 与 ② 处
    // 都**无条件** `blockedHomeIds.add(...)`（注释写了规则、代码没执行）。
    for (const home of failedHomes) {
      const kindRaw = String(home?.kind ?? home?.sourceKind ?? "");
      // 未启用来源的失败与 perf 无关（它根本没有 perf reader）⇒ **不得**计入 perf 退化。
      if (home?.id && isPerfSourceEnabled(kindRaw)) {
        blockedHomeIds.add(String(home.id));
        fileFailures.push({
          sourceKind: canonicalizeKind(kindRaw),
          homeId: String(home.id),
          code: "READ_ONLY_OPEN_FAILED",
        });
      }
    }
    // 三组必须分开：`enabled` 不列入；`notEnabled`/`unsupported` 单列。
    const classified = classifyPerfSources(homes);
    const unsupportedSources = [...classified.notEnabled, ...classified.unsupported];

    let policyRawToWrite;
    if (!policyNeedsUpgrade || policyUpgradeComplete) {
      try {
        policyRawToWrite = encodeCodexPublicationPolicy(
          [...partialHomesById.entries()].map(([homeId, blockedThreadIds]) => ({
            homeId,
            blockedThreadIds: [...blockedThreadIds],
          })),
        );
      } catch (error) {
        for (const homeId of codexPlans.keys()) blockCodexHome(homeId, error);
        // C2 卡：策略编码失败 ⇒ 本轮的 partial 投影**无法持久化**。复用轮里"刚刚重放的那份投影"
        // **不在** `codexPlans` 里，所以它既不会被上面的循环归因，也会在 `partialHomesById.clear()`
        // 之后**从 degraded 里消失** —— 那等于让一个确定性受阻的 home 静默写 `ready`，直接违反
        // `encodeCodexPublicationPolicy` 的契约（"绝不能因此写 `ready`"）。因此：
        //   * 用**同一个** `blockCodexHome` 给它归因（与规划路径同型、倍率相同 ⇒ 下一轮不会膨胀）；
        //   * 丢弃它的稳定失败记录 —— 那份投影没有被持久化，留着只会下一轮再失败（"记录粘住"）。
        // 删记录只是"放弃跳过"，下一轮必然重新规划并重建记录 ⇒ 确定性的自愈路径。
        for (const homeId of partialHomesById.keys()) {
          if (!codexPlans.has(homeId)) blockCodexHome(homeId, error);
          this.codexStableAttempts.delete(homeId);
        }
        partialHomesById.clear();
        policyRawToWrite = "";
        policyUpgradeComplete = false;
      }
    }

    // ── C1 卡：**提交**本轮的稳定失败尝试记录 ───────────────────────────────────────────────
    //
    // 判据是**本轮受阻事件的计数快照比对**，而不是"最终是否 degraded"：
    //   * 规划本身就**确定性受阻**的 home，其 `blockCodexHome` 调用发生在快照**之前**，
    //     计数相等 ⇒ 允许提交（否则 home 级坏内容永远无法复用，正是本卡要打的靶子）；
    //   * 规划之后**又**受阻（发布前复核 `LIVE_SOURCE_CHANGED`、发布事务 `ROLLBACK`、
    //     跨 home 冲突、用量侧失败、策略编码失败）⇒ 计数变大 ⇒ **丢弃**记录
    //     （卡面："发布失败不缓存为可跳过状态"）。
    // 计数相等时还要**清除**该 home 的旧记录，避免"本轮结果不可记录但旧记录仍在"的残留。
    for (const [homeId, candidate] of codexStableAttemptCandidates) {
      const blockEvents = codexBlockEvents.get(homeId) || 0;
      if (blockEvents !== candidate.blockEvents) {
        this.codexStableAttempts.delete(homeId);
        continue;
      }
      const paths = [...candidate.expectedPaths];
      const afterFingerprints = candidate.window?.after?.fileFingerprints ?? {};
      this.codexStableAttempts.set(homeId, {
        homeId,
        homeKind: String(candidate.home?.kind ?? ""),
        homePath: String(candidate.home?.path ?? ""),
        methodVersion: codexStableAttemptMethodVersion(),
        paths,
        fileFingerprints: Object.fromEntries(paths.map((filePath) => [filePath, afterFingerprints[filePath]])),
        // 两种形态：home 级受阻（非空告警列表）与"部分失败"（非空 blockedThreadIds）。
        blockedHomeWarnings: candidate.blockedHomeWarnings ?? [],
        blockedThreadIds: [...(partialHomesById.get(homeId) ?? [])].sort(),
        failedThreads: (candidate.failedThreads ?? []).map((entry) => ({
          threadId: entry.threadId,
          reason: entry.reason,
          failedFilePaths: [...(entry.failedFilePaths || [])],
        })),
      });
    }

    const degradedHomeSet = new Set(blockedHomeIds);
    for (const homeId of partialHomesById.keys()) degradedHomeSet.add(homeId);
    const degradedHomeIds = [...degradedHomeSet].sort();
    const nextState = degradedHomeIds.length > 0 ? PERF_STATE_DEGRADED : PERF_STATE_READY;

    this.serviceTierEvidence = loadServiceTierEvidence(homes);
    // D1：**service-tier evidence 的成功提交**。注意 `loadServiceTierEvidence` **每轮**都返回**新对象**
    // ⇒ 用对象身份当"变化"会让每个 no-op 轮都推进修订（违反卡面"无变化同步保留缓存"），
    // 所以用**输入签名**（各 home 的 `logs_2.sqlite` 主库 + `-wal`）判定，见
    // {@link UsageStore#serviceTierEvidenceSignature}。
    const serviceTierSignature = this.serviceTierEvidenceSignature(homes);
    if (this.serviceTierEvidenceInput !== null && serviceTierSignature !== this.serviceTierEvidenceInput) {
      this.commitStoreRevision("service-tier");
    }
    this.serviceTierEvidenceInput = serviceTierSignature;
    this.homes = homes;
    this.warnings = warnings;
    this.generatedAt = new Date().toISOString();
    this.fingerprint = status.fingerprint;
    this.checkedAt = status.checkedAt;
    const publishedFingerprints = this.publishedFileFingerprintsForRound();
    for (const removedPath of removedFingerprintPaths) delete publishedFingerprints[removedPath];
    const publishedWarnings = this.publishedFileWarningsForRound();
    for (const removedPath of removedSourcePaths) delete publishedWarnings[removedPath];

    // **D3 + BC-2**：`perf_index_version` = **已提交指纹 + 来源身份** 的聚合。
    // ⚠️ **不再**在整轮结束时重新 stat 上游（用户在 BC-2 中复现了由此产生的错误版本）。
    const sourceFileRows = this.database.prepare("SELECT path, kind, home_id, home_path FROM source_files").all();
    const codexHomePaths = new Map(
      homes
        .filter((home) => canonicalizeKind(String(home?.kind ?? home?.sourceKind ?? "")) === "codex")
        .map((home) => [String(home?.id ?? ""), String(home?.path ?? "")]),
    );
    const codexFileRows = this.database
      .prepare(`
        SELECT rollouts.source_path AS path, rollouts.home_id AS home_id
        FROM perf_rollout_threads AS rollouts
        JOIN source_files AS files ON files.path = rollouts.source_path
      `)
      .all();
    const publishedCodexHomeIds = new Set(codexFileRows.map((row) => String(row.home_id)));
    const retainedCodexHomes = [];
    for (const homeId of publishedCodexHomeIds) {
      if (codexHomePaths.has(homeId) || !blockedHomeIds.has(homeId)) continue;
      const oldHome = oldCodexRowsByHome.get(homeId)?.[0];
      if (!oldHome) continue;
      const homePath = String(oldHome.home_path ?? "");
      codexHomePaths.set(homeId, homePath);
      retainedCodexHomes.push({
        id: homeId,
        label: String(oldHome.home_label ?? "Codex"),
        path: homePath,
        kind: "codex",
      });
    }
    const publishedCodexFiles = codexFileRows.map((row) => ({
      path: String(row.path),
      kind: "codex",
      home_id: String(row.home_id),
      home_path: codexHomePaths.get(String(row.home_id)) || "",
    }));
    const fingerprintHomes = [...homes, ...retainedCodexHomes].filter((home) => {
      const kind = canonicalizeKind(String(home?.kind ?? home?.sourceKind ?? ""));
      return kind !== "codex" || publishedCodexHomeIds.has(String(home?.id ?? ""));
    });
    const publishedFiles = sourceFileRows
      .filter((row) => canonicalizeKind(String(row.kind ?? "")) !== "codex")
      .concat(publishedCodexFiles);
    const publishedFingerprint = buildPublishedSourcesFingerprint(
      fingerprintHomes,
      publishedFingerprints,
      publishedFiles,
    );
    // 源告警只投影 {sourceKind, homeId, code, count}（**不含路径**）。
    // Preserve successful per-file reader diagnostics (for example UNKEYABLE_RECORD)
    // alongside current file failures. Sidecar entries describe committed rows;
    // summing their original counts keeps indexed warnings aligned with memory.
    const committedFileWarnings = [];
    const warningsByPath = publishedWarnings;
    for (const row of publishedFiles) {
      if (!isPerfSourceEnabled(String(row.kind ?? ""))) continue;
      committedFileWarnings.push(...(warningsByPath[String(row.path)] || []));
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.writeMeta("generated_at", this.generatedAt);
      this.writeMeta("fingerprint", this.fingerprint);
      this.writeMeta("perf_file_fingerprints", JSON.stringify(publishedFingerprints));
      this.writeMeta("perf_file_warnings", JSON.stringify(publishedWarnings));
      this.writeMeta("perf_method_version", PERF_METHOD_VERSION);
      this.writeMeta("perf_index_version", publishedFingerprint);
      this.writeMeta("perf_indexed_at", this.generatedAt);
      this.writePerfState(nextState, {
        degradedHomeIds,
        sourceWarnings: projectSourceWarnings([
          ...committedFileWarnings,
          ...projectSourceFailures([...fileFailures, ...liveChangeWarnings]),
        ]),
      });
      if (policyRawToWrite !== undefined) this.writeMeta("perf_codex_publication_policy", policyRawToWrite);
      // 未启用来源单列（不改 `perf_state`，**不令其他来源退化**）。
      this.writeMeta("perf_unsupported_sources", JSON.stringify(unsupportedSources));
      this.database.exec("COMMIT");
      // S1：轮级发布成功提交 ⇒ 视图与已提交的库状态对齐（回滚则保持旧值）。
      this.publishedFileMapsView?.commit(publishedFingerprints, publishedWarnings);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    // ── C5：派生缓存**定向失效**（不再"每轮无条件清空"）────────────────────────────────
    // 卡面："无实际变更时……**不无条件清空派生缓存**"。两个缓存都是**用量侧**派生：
    //   * `metadataCache`：`events` 聚合 + `this.homes`（见 `metadata()`）；
    //   * `periodComparisonCache`：`periodAggregate()` 的 `events` 聚合（键已含时区/日期/排除集）。
    // ⇒ 判据只有两条**真实事实**：① 本轮是否写过用量数据（`usageDerivedChanged`，见上面的提交点
    // ①②③④）；② 本轮 home 集合是否变过（缓存里存着建它那一刻的 home 形状）。
    // 无实际变更的轮次**保留**昂贵的派生结构（不清空），只把**按契约每轮更新**的例行时刻字段
    // 刷进去 —— `generatedAt` 的语义是"最近一轮成功 sync 的时刻"（本轮开头重取、
    // `generated_at` / `perf_indexed_at` 在同一轮的末期元数据事务里每轮写入），绝不能因为保留
    // 缓存而被冻住。
    const currentHomeShape = homes
      .map((home) => `${home?.kind}\u0000${home?.id}\u0000${home?.label}\u0000${home?.path}`)
      .join("\n");
    const cachedHomeShape = (this.metadataCache?.homes ?? [])
      .map((home) => `${home?.kind}\u0000${home?.id}\u0000${home?.label}\u0000${home?.path}`)
      .join("\n");
    const homeSetChanged = this.metadataCache !== null && cachedHomeShape !== currentHomeShape;
    // ── D1：实例修订 / 外部提交（**统一**的失效判据；守卫块本身逐字未动，见下）──────────────────
    // D1 ①：home 集合形状变化本身就是一次**成功提交**（读路径的 `metadata().homes` 会变）。
    if (homeSetChanged) this.commitStoreRevision("home");
    // D1 ②：外部提交（同连接 `PRAGMA data_version` 变化）⇒ 修订 +1 + 重载必要元数据。
    this.detectExternalCommit();
    // D1 ③：把 D1 的理由折进 C5 的守卫。⚠️ 下面 6 行是**共享门禁锚点**
    // （`tools/lib/instrument.mjs` 的 usage-store 组 + `C5/mutation-c5.mjs` 的 `C5_TAIL` 都逐字匹配它）
    // ⇒ 一个字节都不能改；这里只把"修订前进过"等价为"派生缓存的输入变了"。
    if (this.storeRevision !== this.derivedRevision) usageDerivedChanged = true;
    if (usageDerivedChanged || homeSetChanged) {
      this.metadataCache = null;
      this.periodComparisonCache.clear();
      this.metadataObservationCache = null;
    } else if (this.metadataCache !== null) {
      this.metadataCache.generatedAt = this.generatedAt;
      this.metadataCache.warnings = this.warnings;
    }
    // D1：轮末把"缓存 ↔ 修订"的对齐落到当前值。不变量：走到这里若缓存被**保留**，则修订必然没前进过
    // （否则上面的折行已把 `usageDerivedChanged` 置真）⇒ 这行对保留分支是恒等赋值、对失效分支是记账。
    this.derivedRevision = this.storeRevision;
    return { ...status, updatedFileCount, perfState: nextState, degradedHomeIds, unsupportedSources };
  }

  /**
   * D3：**已提交 quota 观测的规范映射**（`rate_limit_observations` 行 ⇒ 规范对象，单槽复用）。
   *
   * 契约（本卡红线）：这里**只缓存静态输入**。返回对象里只有"已提交观测行"的字段
   * （`source_path` / `line_number` / `role` / `observed_at_ms` / `limit_id` / `limit_name` /
   * `plan_type` / `window_minutes` / `resets_at_ms` / `used_percent`），**没有任何时间派生字段**：
   * 窗口边界、`state`（available / waiting / missing / ambiguous）、`percentStale`、倒计时、reset
   * 语义一律由消费者**每次**用当前或冻结的 `asOf` 现算（`selectQuotaWindows(rows, asOf)`；
   * `resolveDateRange({ …filters, now: asOf, quota })`）。`resetsAtMs` 是**观测里的原始输入**，
   * 不是"相对现在的重置语义"。
   *
   * 为什么复用：同一次 `summarizeInReadTransaction` 里它被调用**两次**（`:4834` 选窗口 +
   * `:4918` 逐范围记录），而且每次 `summarize` 至少调用一次 ⇒ 缓存后
   * "**一次读取 + 一次规范映射，两个消费者共用**"（`selectQuotaWindows` 与
   * `quotaRecordsForRange` 都只读这份映射，不复制、不改写）。
   *
   * 失效（沿 D1 机制，不自建 TTL / 事件总线 / 计数表）：键 = `this.storeRevision`
   * （自身写入、外部提交 `PRAGMA data_version`、service-tier evidence 都会推进它）；
   * `syncDerivedRevision()` / `open()` / `close()` 复位；写事务内
   * （`writeTransactionDepth > 0`）读到的是**未提交**状态 ⇒ **不读也不写**（D1 的回滚语义）。
   *
   * @returns {object[]} 规范映射本身（**只读**；调用方不得就地改写）
   */
  quotaObservations() {
    // D1：读路径先对齐修订（外部提交在这里被检出 ⇒ 缓存失效 + 必要元数据重载）。
    this.syncDerivedRevision();
    // D1：写事务内**不读也不写**共享缓存（读到的是未提交状态 ⇒ 回滚后它会说谎）。
    const cacheable = this.writeTransactionDepth === 0;
    if (cacheable && this.quotaObservationCache?.revision === this.storeRevision) {
      return this.quotaObservationCache.rows;
    }
    const rows = this.database
      .prepare(`
      SELECT source_path, line_number, role, observed_at_ms, limit_id, limit_name,
        plan_type, window_minutes, resets_at_ms, used_percent
      FROM rate_limit_observations INDEXED BY rate_limit_window_lookup_idx
      ORDER BY limit_id ASC, window_minutes ASC, observed_at_ms DESC
    `)
      .all()
      .map((row) => ({
        sourcePath: row.source_path,
        lineNumber: Number(row.line_number),
        role: row.role,
        observedAtMs: Number(row.observed_at_ms),
        limitId: row.limit_id,
        limitName: row.limit_name,
        planType: row.plan_type,
        windowMinutes: Number(row.window_minutes),
        resetsAtMs: Number(row.resets_at_ms),
        usedPercent: row.used_percent === null ? null : Number(row.used_percent),
      }));
    if (cacheable) this.quotaObservationCache = { revision: this.storeRevision, rows };
    return rows;
  }

  nonCodexHomeIds() {
    // 限额窗口只衡量 Codex 用量：main/jetbrains/extra/codex 之外的目录（zcode、dsh、opencode、project-log）
    // 只在普通范围里计入统计，不能进入限额聚合。
    return this.database
      .prepare(
        "SELECT DISTINCT home_id AS id FROM source_files WHERE kind NOT IN ('main', 'jetbrains', 'extra', 'codex')",
      )
      .all()
      .map((row) => row.id)
      .filter((id) => typeof id === "string" && id.length > 0);
  }

  metadata(asOf = new Date()) {
    // D1：读路径先对齐修订（外部提交在这里被检出 ⇒ 缓存失效 + 必要元数据重载）。
    this.syncDerivedRevision();
    // D1：写事务内读到的是**未提交**状态 ⇒ 这一轮**不落**共享缓存（验收："事务内已读的派生缓存
    // 被安全清理" —— 预防 + 回滚时再清一次，见 `rollbackReplaceFileTransaction`）。
    const cacheable = this.writeTransactionDepth === 0;
    /** D1：不可缓存时（写事务内）用的**本次调用**快照；绝不写回 `this.metadataCache`。 */
    let builtMetadata = null;
    if (!this.metadataCache) {
      const totals = this.database
        .prepare("SELECT COUNT(*) AS event_count, COUNT(DISTINCT session_id) AS session_count FROM events")
        .get();
      const homeRows = new Map(
        this.database
          .prepare(`
          SELECT home_id, COUNT(*) AS event_count, COUNT(DISTINCT session_id) AS session_count
          FROM events GROUP BY home_id
        `)
          .all()
          .map((row) => [row.home_id, row]),
      );
      // 按实际使用记录给出各 harness（Codex / ZCode / DSH / OpenCode / Claude）用到的模型名称。
      const harnessModels = {
        Codex: new Set(),
        ZCode: new Set(),
        DSH: new Set(),
        OpenCode: new Set(),
        Claude: new Set(),
      };
      for (const row of this.database.prepare("SELECT DISTINCT channel, model FROM events").all()) {
        const model = String(row.model || "").trim();
        if (!model || model.toLocaleLowerCase() === "unknown model") continue;
        const channel = String(row.channel || "").toLowerCase();
        const bucket = channel.startsWith("zcode")
          ? "ZCode"
          : channel.startsWith("dsh")
            ? "DSH"
            : channel.startsWith("opencode")
              ? "OpenCode"
              : channel.startsWith("claude")
                ? "Claude"
                : "Codex";
        harnessModels[bucket].add(model);
      }
      builtMetadata = {
        generatedAt: this.generatedAt,
        eventCount: Number(totals.event_count || 0),
        sessionCount: Number(totals.session_count || 0),
        homeCount: this.homes.length,
        harnessModels: {
          Codex: [...harnessModels.Codex].sort((a, b) => a.localeCompare(b)),
          ZCode: [...harnessModels.ZCode].sort((a, b) => a.localeCompare(b)),
          DSH: [...harnessModels.DSH].sort((a, b) => a.localeCompare(b)),
          OpenCode: [...harnessModels.OpenCode].sort((a, b) => a.localeCompare(b)),
          Claude: [...harnessModels.Claude].sort((a, b) => a.localeCompare(b)),
        },
        homes: this.homes.map((home) => {
          const row = homeRows.get(home.id);
          return {
            ...home,
            status: row ? "active" : "no-events",
            eventCount: Number(row?.event_count || 0),
            sessionCount: Number(row?.session_count || 0),
          };
        }),
        warnings: this.warnings,
      };
      // D1：写事务内**不落**共享缓存；正常路径（深度 0）才把它提升为实例级派生缓存。
      if (cacheable) this.metadataCache = builtMetadata;
    }
    // Re-evaluate time even without new files; exclude future events before MAX.
    //
    // D4：观测聚合按**实际变更**复用（键 = D1 的 `storeRevision`）。缓存里只有**静态输入**
    // ——`events` 的原始分组行 `{channel, model, home_id, last_seen}`（未过滤）——而 `asOf`
    // 的时间语义仍**每次现算**：
    //   * `asOf >= 全表最大 timestamp`（不存在未来事件）⇒ `timestamp_ms <= asOf` 是**恒等**过滤
    //     ⇒ 直接复用未过滤行（该次请求 0 次查询、0 行映射）；
    //   * `asOf < 全表最大 timestamp`（确有未来事件）⇒ "哪些事件算未来"随 `asOf` 变化 ⇒ **必须**
    //     每次按当前 `asOf` 现算，**绝不**使用缓存（未来事件过滤语义不得被缓存吃掉）。
    const asOfMs = asOf.getTime();
    const sourceKinds = homeSourceKinds(this.homes);
    /** `timestamp_ms <= cutoffMs` 的分组 MAX；`cutoffMs === null` 表示未过滤（用于静态输入）。 */
    const queryObservationRows = (cutoffMs) => {
      const sql = `SELECT channel, model, home_id, MAX(timestamp_ms) AS last_seen FROM events${
        cutoffMs === null ? "" : " WHERE timestamp_ms <= ?"
      } GROUP BY channel, model, home_id`;
      return cutoffMs === null ? this.database.prepare(sql).all() : this.database.prepare(sql).all(cutoffMs);
    };
    let observationRows = null;
    if (cacheable) {
      const cached = this.metadataObservationCache;
      if (!cached || cached.revision !== this.storeRevision) {
        const rows = queryObservationRows(null);
        this.metadataObservationCache = {
          revision: this.storeRevision,
          rows,
          maxTimestampMs: rows.reduce((max, row) => Math.max(max, Number(row.last_seen)), -Infinity),
        };
      }
      const memo = this.metadataObservationCache;
      observationRows = asOfMs >= memo.maxTimestampMs ? memo.rows : queryObservationRows(asOfMs);
    } else {
      // D1：写事务内读到的是**未提交**状态 ⇒ 不读也不写共享缓存，用本次调用快照。
      observationRows = queryObservationRows(asOfMs);
    }
    const observations = observationRows.map((row) => {
      const group = sourceGroup(row.channel, sourceKinds.get(String(row.home_id)));
      return {
        model: row.model,
        timestamp: Number(row.last_seen),
        harness: ["ZCode", "DSH", "OpenCode", "Claude"].includes(group) ? group : "Codex",
      };
    });
    // D1：可缓存时用实例级缓存（同一对象、可被 C5 用例按引用断言）；写事务内用本次快照。
    return {
      ...structuredClone(this.metadataCache ?? builtMetadata),
      ...buildModelActivity(observations, asOf),
    };
  }

  aggregateRange(range, excludeHomes = []) {
    const scope = scopeFilterSql(excludeHomes);
    const where = eventRangeScope(range, scope);
    return this.database
      .prepare(`
        SELECT
          COUNT(*) AS event_count,
          COUNT(DISTINCT session_id) AS session_count,
          COUNT(DISTINCT home_id) AS home_count,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM events
        WHERE ${where.sql}
      `)
      .get(...where.params);
  }

  groupedRange(column, range, orderBy = "total DESC", excludeHomes = []) {
    const allowedColumns = new Set([
      "channel",
      "home_label",
      "model",
      "project",
      "hour_key",
      "day_key",
      "week_key",
      "month_key",
    ]);
    if (!allowedColumns.has(column)) {
      throw new Error(`不支持的聚合字段：${column}`);
    }
    const dimension =
      column === "channel" && !isQuotaPreset(range.preset) && !range.quotaWindow && !range.quotaPreset
        ? "usage_source_group(channel, (SELECT kind FROM source_files WHERE path = events.source_path))"
        : column;
    const scope = scopeFilterSql(excludeHomes);
    const where = eventRangeScope(range, scope);
    const rows = this.database
      .prepare(`
        SELECT
          ${dimension} AS key,
          COUNT(*) AS count,
          COUNT(DISTINCT session_id) AS sessions,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM events
        WHERE ${where.sql}
        GROUP BY ${dimension}
        ORDER BY ${orderBy}
      `)
      .all(...where.params);
    return rows.map((row) => ({
      key: row.key,
      name: row.key,
      count: Number(row.count || 0),
      sessions: Number(row.sessions || 0),
      total: usageFromRow(row),
    }));
  }

  /** @param {import("./usage-types.js").UsageRange} range
   * @returns {Generator<import("./usage-types.js").IndexedCostEvent>}
   */
  *costEventsForRange(range, excludeHomes = []) {
    const scope = scopeFilterSql(excludeHomes);
    const where = eventRangeScope(range, scope);
    const statement = this.database.prepare(`SELECT ${COST_EVENT_COLUMNS} FROM events WHERE ${where.sql}`);
    const sourceKinds = homeSourceKinds(this.homes);
    for (const row of statement.iterate(...where.params)) {
      yield costEventFromRow(row, this.serviceTierEvidence, sourceKinds.get(String(row.home_id)));
    }
  }

  /** @param {import("./usage-types.js").UsageRange} range */
  costEstimateRange(range, excludeHomes = []) {
    return this.withEventCostMemoRound(() =>
      estimateCostForEvents(this.costEventsForRange(range, excludeHomes), {
        estimateEventCost: (event) => this.eventCostMemo.estimate(event),
      }),
    );
  }

  /**
   * W4-b1 / D1：把一段"逐事件计价"包成 memo 的**一轮**。
   *
   * 轮内放宽到 `hardMaxBytes`（192 MiB），保证"本轮的中间结果"不会因为刚好越线而被立刻逐出；
   * 轮末收敛回 `maxBytes`（64 MiB）。可嵌套（深度计数）—— 一次 `summarize` 会同时进入
   * `buildRecordChampions` 与 `timelineRange`。
   * @template T
   * @param {() => T} run
   * @returns {T}
   */
  withEventCostMemoRound(run) {
    this.eventCostMemo.beginRound();
    try {
      return run();
    } finally {
      this.eventCostMemo.endRound();
    }
  }

  /** @param {import("./usage-types.js").UsageRange} range
   * @param {string} bucket
   * @param {{ onEstimate?: (event: any, estimate: any) => void, excludeHomes?: string[] }} [options]
   */
  timelineRange(range, bucket, { onEstimate, excludeHomes = [] } = {}) {
    // W4-b1 / D1：同一个事件对象的计价在**同一请求内**只应发生一次（此前 `buildRecordChampions`
    // 与这里会对同一份全历史各算一遍），跨请求则由 memo 直接复用。
    return this.withEventCostMemoRound(() =>
      buildTimelineRows(this.costEventsForRange(range, excludeHomes), range, bucket, {
        sourceKinds: homeSourceKinds(this.homes),
        estimateCost: (event) => this.eventCostMemo.estimate(event),
        onEstimate,
      }),
    );
  }

  repositoriesRange(range, excludeHomes = []) {
    const scope = scopeFilterSql(excludeHomes);
    const where = eventRangeScope(range, scope);
    const rows = this.database
      .prepare(`
        SELECT
          repository_key AS key,
          MIN(repository_path) AS name,
          MAX(repository_kind) AS kind,
          COUNT(DISTINCT NULLIF(cwd, '')) AS path_count,
          COUNT(*) AS count,
          COUNT(DISTINCT session_id) AS sessions,
          json_group_array(DISTINCT session_id) AS session_ids,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM events
        WHERE ${where.sql}
        GROUP BY repository_key
        ORDER BY total DESC, name ASC
      `)
      .all(...where.params);
    return rows.map((row) => ({
      key: row.key,
      name: row.name,
      kind: row.kind,
      pathCount: Number(row.path_count || 0),
      count: Number(row.count || 0),
      sessions: Number(row.sessions || 0),
      sessionIds: JSON.parse(String(row.session_ids || "[]")),
      total: usageFromRow(row),
    }));
  }

  periodAggregate(groupColumn, nameColumn, _now, ranges, { includeKind = false, excludeHomes = [] } = {}) {
    const dimensionKey = groupColumn;
    const dimensions = dimensionKey
      ? `${dimensionKey} AS dimension_key, ${includeKind ? `MIN(${nameColumn}) AS dimension_name, MIN(repository_kind) AS dimension_kind, COUNT(DISTINCT NULLIF(cwd, '')) AS path_count` : `${nameColumn} AS dimension_name`},`
      : "";
    const fields = [
      ["total", "total"],
      ["input", "CASE WHEN (detail_mask & 1) != 0 THEN input ELSE 0 END"],
      ["inputUnavailableTokens", "CASE WHEN (detail_mask & 1) = 0 THEN total ELSE 0 END"],
      ["cached", "CASE WHEN (detail_mask & 2) != 0 THEN cached ELSE 0 END"],
      ["cachedUnavailableTokens", "CASE WHEN (detail_mask & 2) = 0 THEN total ELSE 0 END"],
      ["uncachedInput", "CASE WHEN (detail_mask & 3) = 3 THEN MAX(input - cached, 0) ELSE 0 END"],
      ["uncachedInputUnavailableTokens", "CASE WHEN (detail_mask & 3) != 3 THEN total ELSE 0 END"],
      ["cacheRateInput", "CASE WHEN (detail_mask & 3) = 3 THEN input ELSE 0 END"],
      ["cacheRateCached", "CASE WHEN (detail_mask & 3) = 3 THEN cached ELSE 0 END"],
      ["output", "CASE WHEN (detail_mask & 4) != 0 THEN output ELSE 0 END"],
      ["outputUnavailableTokens", "CASE WHEN (detail_mask & 4) = 0 THEN total ELSE 0 END"],
      ["reasoning", "CASE WHEN (detail_mask & 8) != 0 THEN reasoning ELSE 0 END"],
      ["reasoningUnavailableTokens", "CASE WHEN (detail_mask & 8) = 0 THEN total ELSE 0 END"],
      ["unattributedDetailTokens", "CASE WHEN (detail_mask & 15) != 15 THEN total ELSE 0 END"],
      ["inconsistentTokens", "CASE WHEN (detail_mask & 16) != 0 THEN total ELSE 0 END"],
      ["reconciliationGap", "reconciliation_gap"],
    ];
    const parameters = [];
    const measures = [];
    for (const period of COMPARISON_PERIOD_KEYS) {
      for (const [field, expression] of fields) {
        measures.push(
          `COALESCE(SUM(CASE WHEN (? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?) THEN ${expression} ELSE 0 END), 0) AS "${period}__${field}"`,
        );
        parameters.push(...rangeParameters(ranges[period]));
      }
    }
    const select = `SELECT ${dimensions} ${measures.join(", ")} FROM events`;
    const scope = scopeFilterSql(excludeHomes);
    const where = scope.sql ? ` WHERE ${scope.sql}` : "";
    const groupBy = dimensionKey ? ` GROUP BY ${dimensionKey}` : "";
    const orderBy = dimensionKey ? " ORDER BY all__total DESC, dimension_name ASC" : "";
    const rows = this.database.prepare(`${select}${where}${groupBy}${orderBy}`).all(...parameters, ...scope.params);
    return rows.map((row) => {
      const result = {
        key: dimensionKey ? String(row.dimension_key) : "all",
        name: dimensionKey ? String(row.dimension_name) : "全部",
        periods: Object.fromEntries(
          COMPARISON_PERIOD_KEYS.map((period) => [
            period,
            Object.fromEntries(fields.map(([field]) => [field, Number(row[`${period}__${field}`] || 0)])),
          ]),
        ),
      };
      if (includeKind) {
        result.kind = row.dimension_kind;
        result.pathCount = Number(row.path_count || 0);
      }

      return result;
    });
  }

  periodComparison(options = {}) {
    // D1：读路径先对齐修订（外部提交在这里被检出 ⇒ 缓存失效 + 必要元数据重载）。
    this.syncDerivedRevision();
    // D1：写事务内**不读也不写**共享缓存（读到的是未提交状态 ⇒ 回滚后它会说谎）。
    const cacheable = this.writeTransactionDepth === 0;
    const now = options.now ? new Date(options.now) : new Date();
    const excludeHomes = options.excludeHomes || [];
    const zone = options.calendarZone === "utc" ? "utc" : "local";
    const cacheKey = `${zone}|${zone === "utc" ? now.toISOString().slice(0, 10) : localDateKey(now)}|${[...excludeHomes].map(String).sort().join(",")}`;
    const cached = cacheable ? this.periodComparisonCache.get(cacheKey) : undefined;
    if (cached) return { ...structuredClone(cached), asOf: now.toISOString() };
    const scope = scopeFilterSql(excludeHomes);
    const bounds = this.database
      .prepare(
        `SELECT MIN(timestamp_ms) AS minimum, MAX(timestamp_ms) AS maximum FROM events${scope.sql ? ` WHERE ${scope.sql}` : ""}`,
      )
      .get(...scope.params);
    const timestamps =
      bounds.minimum === null
        ? []
        : [
            { timestamp: new Date(Number(bounds.minimum)).toISOString() },
            { timestamp: new Date(Number(bounds.maximum)).toISOString() },
          ];
    const ranges = Object.fromEntries(
      COMPARISON_PERIOD_KEYS.map((key) => [
        key,
        resolveDateRange({ preset: key, now, calendarZone: zone }, timestamps),
      ]),
    );
    const models = this.periodAggregate("model", "model", now, ranges, { excludeHomes });
    const totals = models.length
      ? Object.fromEntries(
          COMPARISON_PERIOD_KEYS.map((period) => {
            const periodTotals = {};
            for (const model of models) {
              for (const [field, value] of Object.entries(model.periods[period])) {
                periodTotals[field] = (periodTotals[field] || 0) + value;
              }
            }
            return [period, periodTotals];
          }),
        )
      : this.periodAggregate(null, null, now, ranges, { excludeHomes })[0].periods;
    const value = {
      periods: COMPARISON_PERIOD_KEYS.map((key) => ({
        key,
        start: ranges[key].start?.toISOString() || null,
        end: ranges[key].end?.toISOString() || null,
      })),
      totals,
      models,
      repositories: this.periodAggregate("repository_key", "repository_path", now, ranges, {
        includeKind: true,
        excludeHomes,
      }),
    };
    // D1：只有**不在写事务里**才写共享缓存（写事务内的结果只用于本次调用）。
    if (cacheable) {
      this.periodComparisonCache.clear();
      this.periodComparisonCache.set(cacheKey, value);
    }
    return { ...structuredClone(value), asOf: now.toISOString() };
  }

  // New Record：对日/周/月三种自然周期求各指标的历史最高期（严格新高、至少两期可比），
  // 只有纪录期完整落在所选范围内时才计为“在所选时间范围创下”。
  /**
   * D2：**完整 scope 的历史冠军**与“纪录期是否完整落在当前范围”**分离**。
   *
   * 为什么能分离：冠军只在**全历史**上选（SQL 的 `where` 只来自 `excludeHomes`，`range` **从不**
   * 进入 WHERE）⇒ 冠军选择与 `range` 无关；`range` 只参与 `recordsWithinRange()` 里的包含判定。
   *
   * memo = **一条**（单槽，不是 Map、不是框架、不落盘），键是**六项**输入的身份：
   *   ① 数据修订（D1 的 `storeRevision`，由 `syncDerivedRevision()` 对齐）
   *   ② 价目目录版本（`getPricingCatalog().version`）
   *   ③ `usdToCnyRate`
   *   ④ service-tier evidence 的输入签名（与 `serviceTierEvidenceInput` 同口径）
   *   ⑤ 时区（`range.calendarZone`：`local` / `utc`）
   *   ⑥ **规范化后的排除集合**（`excludeHomes` 去重 + 排序）
   * 改变任一项 ⇒ 键不等 ⇒ **立即重算**。失效**不靠 TTL、不靠新事件总线**：数据侧由 D1 的修订
   * 前进驱动，价目 / 汇率由 `getPricingCatalog()` 驱动。
   *
   * ⚠️ **遵守 D1 的写事务门**：`writeTransactionDepth > 0` 时读到的是**未提交**状态 ⇒
   * **不读也不写**这条 memo，只在本次调用内算局部值（与 `metadata()` / `periodComparison()` 同款）。
   * @param {import("./usage-types.js").UsageRange} range
   */
  recordsForRange(range, excludeHomes = []) {
    // D2：读路径先对齐修订（外部提交在这里被检出 ⇒ 数据侧输入立即失效），与 metadata()/periodComparison() 同款。
    this.syncDerivedRevision();
    // D2 复用 D1 的门：写事务内不读也不写共享 memo。
    const cacheable = this.writeTransactionDepth === 0;
    const zone = range.calendarZone === "utc" ? "utc" : "local";
    const scope = scopeFilterSql(excludeHomes);
    const where = scope.sql ? `WHERE ${scope.sql}` : "";
    const catalog = getPricingCatalog();
    const rate = Number(catalog.usdToCnyRate);
    const usdToCnyRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    // ⑥ 规范排除集合：`NOT IN (…)` 与顺序、重复无关 ⇒ 去重 + 排序后作为 memo 键的一部分。
    const canonicalExcludedHomes = [...new Set((excludeHomes || []).map((value) => String(value)).filter(Boolean))]
      .sort()
      .join("\u0000");
    const memoKey = [
      `data-revision\u0000${this.storeRevision}`,
      `pricing-catalog\u0000${String(catalog.version ?? "")}`,
      `usd-to-cny-rate\u0000${usdToCnyRate}`,
      `service-tier-evidence\u0000${this.serviceTierEvidenceInput === null ? "<unsynced>" : this.serviceTierEvidenceInput}`,
      `calendar-zone\u0000${zone}`,
      `excluded-homes\u0000${canonicalExcludedHomes}`,
    ].join("\u0001");
    const memoized = cacheable && this.recordChampionCache?.key === memoKey ? this.recordChampionCache.champions : null;
    // W4-b1 / D1：全历史扫描的逐行计价也走同一个事件计价 memo（整段包成**一轮**：轮内放宽到
    // 192 MiB，轮末收敛回 64 MiB），并注入给 `buildRecordChampions` —— 注入而非改源码形状，
    // 共享门禁的锚点因此**零变更**。
    const champions =
      memoized ??
      this.withEventCostMemoRound(() =>
        this.buildRecordChampions(zone, where, scope.params, usdToCnyRate, (event) =>
          this.eventCostMemo.estimate(event),
        ),
      );
    if (cacheable && memoized === null) this.recordChampionCache = { key: memoKey, champions };
    return this.recordsWithinRange(champions, range, zone);
  }

  /**
   * D2：`recordsForRange` 的**与 `range` 无关**的那一半 —— 全历史扫描（逐事件计价 + 日/周/月
   * 三种自然周期的槽位累加）与**冠军选择**（“至少两期可比” + **严格**新高）。
   *
   * 返回值：`{ day|week|month: { [metric]: { period, value } } }`。某个指标在该周期单位上
   * **没有**严格新高（含**并列**、期数不足两期）时该键**缺失** —— 即“平局不点亮”。
   * 冠军期的**范围包含判定不在这里**（见 `recordsWithinRange`）。
   */
  buildRecordChampions(zone, where, params, usdToCnyRate, estimateEventCost = DEFAULT_EVENT_COST_ESTIMATOR) {
    const periods = { day: new Map(), week: new Map(), month: new Map() };
    const ensureSlot = (unit, key) => {
      let slot = periods[unit].get(key);
      if (!slot) {
        slot = {
          key,
          total: 0,
          input: 0,
          cached: 0,
          output: 0,
          reasoning: 0,
          sessions: new Set(),
          models: new Set(),
          cost: { total: 0, input: 0, cached: 0, output: 0 },
        };
        periods[unit].set(key, slot);
      }
      return slot;
    };

    // Record ranking scans the full scoped history. Its pricing projection is
    // intentionally smaller: estimates use the active catalog and do not read
    // stored price_version or repository display fields. session_id remains
    // necessary to resolve service-tier evidence.
    const statement = this.database.prepare(`
      SELECT timestamp_ms, day_key, week_key, month_key, session_id, model, channel, home_id,
        total, input, cached, output, reasoning, detail_mask, cache_write_tokens,
        cache_write_known, request_input_tokens, context_level, service_tier
      FROM events ${where}
    `);
    // W4-b1 / D1：逐行计价走**注入**的 `estimateEventCost`（默认仍是模块函数；`recordsForRange`
    // 注入 memo）。为什么用注入而不是在这里直接写 `this.eventCostMemo.estimate`：**不改变**共享门禁
    // （`tools/lib/instrument.mjs`）锚定的那两行源码形状 —— 锚点是"共享期望值文件"，改它要单列一节
    // 并做双向失败语义证明（见 W4-b1 报告 §共享门禁）；注入式改动**零锚点变更**。
    const sourceKinds = homeSourceKinds(this.homes);
    for (const row of statement.iterate(...params)) {
      const estimate = estimateEventCost({
        timestamp: Number(row.timestamp_ms),
        model: String(row.model),
        sourceKind: sourceKinds.get(String(row.home_id)),
        channel: String(row.channel),
        detailMask: Number(row.detail_mask || 0),
        cacheWriteTokens: Number(row.cache_write_tokens || 0),
        cacheWriteKnown: Boolean(row.cache_write_known),
        requestInputTokens: Number(row.request_input_tokens || 0),
        contextLevel: row.context_level,
        serviceTier:
          this.serviceTierEvidence?.resolve(
            String(row.session_id),
            Number(row.timestamp_ms),
            String(row.service_tier),
          ) || String(row.service_tier),
        total: {
          total: Number(row.total || 0),
          input: Number(row.input || 0),
          cached: Number(row.cached || 0),
          output: Number(row.output || 0),
          reasoning: Number(row.reasoning || 0),
        },
      });
      // 跨币种比较与图表比例一致：统一折算到人民币。
      const scale = estimate.currency === "CNY" ? 1 : usdToCnyRate;
      const date = zone === "utc" ? new Date(Number(row.timestamp_ms)) : null;
      const utcDay = date?.toISOString().slice(0, 10);
      const utcWeek = date
        ? new Date(
            Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((date.getUTCDay() || 7) - 1)),
          )
            .toISOString()
            .slice(0, 10)
        : null;
      for (const unit of ["day", "week", "month"]) {
        const key =
          zone === "utc"
            ? unit === "day"
              ? utcDay
              : unit === "week"
                ? utcWeek
                : utcDay.slice(0, 7)
            : String(row[`${unit}_key`] || "");
        const slot = ensureSlot(unit, key);
        slot.total += Number(row.total || 0);
        slot.input += Number(row.input || 0);
        slot.cached += Number(row.cached || 0);
        slot.output += Number(row.output || 0);
        slot.reasoning += Number(row.reasoning || 0);
        slot.sessions.add(row.session_id);
        slot.models.add(row.model);
        slot.cost.total += Number(estimate.totalUsd || 0) * scale;
        slot.cost.input += Number(estimate.inputUsd || 0) * scale;
        slot.cost.cached += Number(estimate.cachedInputUsd || 0) * scale;
        slot.cost.output += Number(estimate.outputUsd || 0) * scale;
      }
    }

    const slotValues = (slot) => ({
      totalTokens: slot.total,
      inputTokens: slot.input,
      cachedTokens: slot.cached,
      outputTokens: slot.output,
      reasoningTokens: slot.reasoning,
      sessionCount: slot.sessions.size,
      modelCount: slot.models.size,
      cacheHitRate: slot.input > 0 ? slot.cached / slot.input : null,
      totalCost: slot.cost.total,
      inputCost: slot.cost.input,
      cachedCost: slot.cost.cached,
      outputCost: slot.cost.output,
    });

    // ── 冠军选择（**与 `range` 无关**）：严格新高 + 至少两期可比 ─────────────────────────────
    const champions = { day: {}, week: {}, month: {} };
    for (const metric of Object.keys(RECORD_METRICS)) {
      for (const unit of ["day", "week", "month"]) {
        const ranked = [...periods[unit].values()]
          .map((slot) => ({ key: slot.key, value: slotValues(slot)[metric] }))
          .filter((entry) => Number.isFinite(entry.value) && entry.value > 0)
          .sort((left, right) => right.value - left.value);
        // “至少两期可比”：少于两期无从比较；**并列**（前两名相等）不是新高 ⇒ 不点亮。
        if (ranked.length < 2 || ranked[0].value <= ranked[1].value) continue;
        champions[unit][metric] = { period: ranked[0].key, value: ranked[0].value };
      }
    }
    return champions;
  }

  /**
   * D2：`recordsForRange` 的**与 `range` 有关**的那一半 —— 只做“冠军期是否**完整**落在所选
   * 范围内”的包含判定（日/周/月的边界由 `recordUnitBoundaries` 给出），并按
   * `day → week → month` 取**第一个**被包含的单位（逐字保持原先的优先级与 `break`）。
   */
  recordsWithinRange(champions, range, zone) {
    const rangeStartMs = range?.start ? range.start.getTime() : null;
    const rangeEndMs = range?.end ? range.end.getTime() : null;
    const records = {};
    for (const [metric, definition] of Object.entries(RECORD_METRICS)) {
      for (const unit of ["day", "week", "month"]) {
        const champion = champions[unit][metric];
        if (!champion) continue;
        const boundaries = recordUnitBoundaries(champion.period, unit, zone);
        if (!boundaries) continue;
        const [periodStart, periodEnd] = boundaries;
        if (rangeStartMs !== null && periodStart < rangeStartMs) continue;
        if (rangeEndMs !== null && periodEnd - 1 > rangeEndMs) continue;
        records[metric] = {
          title: `${definition.title}的${RECORD_UNIT_LABELS[unit]}`,
          unit,
          period: champion.period,
          value: champion.value,
        };
        break;
      }
    }
    return records;
  }

  summarize(filters = {}, options = {}) {
    this.database.exec("BEGIN");
    try {
      const summary = this.summarizeInReadTransaction(filters, options);
      this.database.exec("COMMIT");
      return summary;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  summarizeInReadTransaction(filters = {}, { includeDetails = true } = {}) {
    const excludeHomes = filters.excludeHomes || [];
    const asOf = filters.now ? new Date(filters.now) : new Date();
    const quota = selectQuotaWindows(this.quotaObservations(), asOf);
    const scope = scopeFilterSql(excludeHomes);
    const bounds = this.database
      .prepare(
        `SELECT MIN(timestamp_ms) AS minimum, MAX(timestamp_ms) AS maximum FROM events${scope.sql ? ` WHERE ${scope.sql}` : ""}`,
      )
      .get(...scope.params);
    const boundaryEvents = [];
    if (bounds.minimum !== null) {
      boundaryEvents.push({ timestamp: new Date(Number(bounds.minimum)).toISOString() });
    }
    if (bounds.maximum !== null) {
      boundaryEvents.push({ timestamp: new Date(Number(bounds.maximum)).toISOString() });
    }
    const range = resolveDateRange({ ...filters, now: asOf, quota }, boundaryEvents);
    const quotaPreset = isQuotaPreset(range.preset) || Boolean(range.quotaWindow);
    const scopeExclusions = quotaPreset ? [...new Set([...excludeHomes, ...this.nonCodexHomeIds()])] : excludeHomes;
    const aggregate = this.aggregateRange(range, scopeExclusions);
    const totals = usageFromRow(aggregate);
    const previousRange = quotaPreset ? null : previousUsageRange(range);
    const previousAggregate = previousRange ? this.aggregateRange(previousRange, excludeHomes) : null;
    const comparison = quotaPreset
      ? null
      : usageComparisonFromAggregates({
          range,
          currentTotals: totals,
          previousTotals: usageFromRow(previousAggregate),
          previousEventCount: Number(previousAggregate?.event_count || 0),
          previousSessionCount: Number(previousAggregate?.session_count || 0),
          now: asOf,
        });
    const bucket = deriveTimelineBucket(
      range,
      range.bucket ||
        (quotaPreset ? (range.preset === "quota_5h" ? "quota_30m" : "quota_24h") : filters.bucket || "day"),
    );
    let timeline = [];
    let timelineError = null;
    let costEstimate;
    const costAccumulator = createCostEstimateAccumulator();
    try {
      timeline = this.timelineRange(range, bucket, {
        onEstimate: (event, estimate) => costAccumulator.add(event, estimate),
        excludeHomes: scopeExclusions,
      });
      costEstimate = costAccumulator.result();
    } catch (error) {
      if (error.code !== "TIMELINE_RANGE_TOO_LARGE") throw error;
      timelineError = error.message;
      costEstimate = this.costEstimateRange(range, scopeExclusions);
    }
    const summary = {
      generatedAt: this.generatedAt,
      range: {
        preset: range.preset,
        start: range.start ? range.start.toISOString() : null,
        end: range.end ? range.end.toISOString() : null,
        bucket,
        calendarZone: range.calendarZone || "local",
        rolling: Boolean(range.rolling),
        ...(quotaPreset
          ? {
              quotaWindow: true,
              recentValue: range.recentValue,
              quotaPreset: range.quotaPreset,
              asOf: range.asOf.toISOString(),
              windowStart: range.start.toISOString(),
              windowEndExclusive: range.windowEndExclusive.toISOString(),
              observedAt: range.observedAt?.toISOString() || null,
              usedPercent: range.usedPercent,
              percentStale: range.percentStale,
              limitId: range.limitId,
              quotaState: range.quotaState,
              quotaReason: range.quotaReason,
              ...(range.durationMinutes === undefined
                ? {}
                : { durationMinutes: range.durationMinutes, plannedResetAt: range.plannedResetAt }),
            }
          : {}),
      },
      totals,
      comparison,
      costEstimate,
      records:
        range.preset === "all"
          ? {}
          : quotaPreset
            ? quotaRecordsForRange(range, quota, this.quotaObservations(), (window) => {
                const row = window === range ? aggregate : this.aggregateRange(window, scopeExclusions);
                const cost = window === range ? costEstimate : this.costEstimateRange(window, scopeExclusions);
                return {
                  eventCount: Number(row.event_count),
                  values: quotaRecordValues(
                    usageFromRow(row),
                    cost,
                    Number(row.session_count),
                    getPricingCatalog().usdToCnyRate,
                  ),
                };
              })
            : this.recordsForRange(range, scopeExclusions),
      eventCount: Number(aggregate.event_count || 0),
      sessionCount: Number(aggregate.session_count || 0),
      homeCount: Number(aggregate.home_count || 0),
      timeline,
      timelineError,
      quota,
      channels: this.groupedRange("channel", range, "total DESC", scopeExclusions),
      models: this.groupedRange("model", range, "total DESC", scopeExclusions),
    };

    /**
     * M3.4：把 **perf 状态机**接进读路径。
     *
     * ⚠️ **必须在同一读事务内读取**（本方法已由 `summarize` 包在 `BEGIN … COMMIT` 里）：
     * `perf_state` 会在一轮 sync 的多次 `replaceFile` **之间**变化，事务外读会拿到撕裂的
     * "状态 + 候选"组合。
     *
     * **D4**：`degraded` 时默认排名**只含未受阻 home** —— 卡片明文"旧成功候选可保留在
     * 数据库以便失败回滚，但**不得悄悄参与当前排名**"。受阻 home 的陈旧候选仍在库里
     * （回滚可用），但被**明确排除在 `rankedHomeIds` 之外**，且**指名**列在
     * `degradedHomeIds` 里，使下游**无法**把它当作干净排名（AN-6：归因字段本身是验收对象）。
     */
    const perfState = this.perfState();
    const degraded = new Set(perfState.degradedHomeIds);
    const publicationPolicy = decodeCodexPublicationPolicy(perfState.codexPublicationPolicy);
    const partialHomes = publicationPolicy.usable ? publicationPolicy.partialHomes : [];
    const partialHomeIds = new Set(partialHomes.map((entry) => entry.homeId));
    const publicationFilter = createCodexPublishFilter(perfState.degradedHomeIds, partialHomes);

    // ── M4.2：**与内存路径同一个统计入口** ────────────────────────────────────
    //
    // ⚠️ 范围必须由本模块**先转成 M1 的键名**再同时喂给 SQL 与 `summarizePerf`：
    //    `perfRangeBounds` 明文拒绝 usage-core 的原始形状（`start/end/windowEndExclusive`），
    //    否则"SQL 有界而 M1 无界"，两端计数必然分叉（M3 记录过同一实测成因）。
    const perfBounds = perfStatsRangeBounds(range);
    // 卡片明文："`degraded` 时按 M3.4 排除受阻 home 并显示告警"。M3.4 只在 `rankedHomeIds`
    // 里排除了受阻 home；**统计侧必须同样排除**，否则受阻 home 的陈旧候选仍会进入 `groups`。
    const perfExclusions = [
      ...new Set([...scopeExclusions, ...perfState.degradedHomeIds.filter((homeId) => !partialHomeIds.has(homeId))]),
    ];
    const publishableInRange = (sample) =>
      codexSampleAllowed(publicationFilter, sample) && (!quotaPreset || !isCodexAutoReview(sample.model));
    const perfStats = buildPerfStatsBlock({
      // ⚠️ **必须并入 unplaced**：`perfCandidatesForRange` 刻意排除 `ts_ms IS NULL`
      //（M3.3 的设计），但内存路径把 unplaced 样本一并交给 M1（它们进 `coverage.unplaced`）。
      // 若索引路径不并入，`coverage.unplaced` 会恒为 0 ⇒ 两端计数分叉（卡片明文要求
      // "所有计数相同"，并把 unplaced 列为固定 fixture 之一）。
      samples: [
        ...this.perfCandidatesForRange(perfBounds, perfExclusions),
        ...this.unplacedPerfSamples(perfExclusions),
      ].filter(publishableInRange),
      bounds: perfBounds,
      excludedHomeIds: perfExclusions,
      // 与内存路径同形（`perfMeta.knownSources`）：未启用/不支持来源也申报，供 M1 单列。
      knownSources: (this.homes || []).map((home) => ({
        kind: canonicalPerfSourceKind(home?.kind),
        homeId: String(home?.id ?? ""),
      })),
      meta: {
        methodVersion: perfState.methodVersion,
        state: perfState.state,
        indexVersion: perfState.indexVersion ?? null,
        indexedAt: perfState.indexedAt ?? null,
        sourceWarnings: perfState.sourceWarnings,
      },
    });

    summary.perf = {
      state: perfState.state,
      // `rebuilding` 时**不得**把部分候选当 ready 排名 ⇒ 显式告知调用者。
      ready: perfState.state === PERF_STATE_READY,
      methodVersion: perfState.methodVersion,
      indexVersion: perfState.indexVersion,
      indexedAt: perfState.indexedAt,
      degradedHomeIds: perfState.degradedHomeIds,
      // M4.3 返工1（复核 §3）：顶层与 `meta.sourceWarnings` 用**同一份**规范结果 —— 内核会按冻结
      // 码域过滤掉域外码、并补算 `AGGREGATE_OVERFLOW` 等运行期告警，而 `perfState.sourceWarnings`
      // 只是持久化的原始状态告警 ⇒ 两者曾实测不一致（meta 有 overflow、顶层为 []）。
      // `perfState` 仍作为**内部状态**读取（持久数据与冻结内核都不动）。
      sourceWarnings: perfStats.meta.sourceWarnings,
      unsupportedSources: decodeJsonWarnings(this.readMetaRaw("perf_unsupported_sources")),
      // 默认排名应包含的 home：库里出现过、且**未**被标退化的。
      rankedHomeIds: (() => {
        // D5：只读**必要身份列**（`perfSampleIdentities()`），不再为取排名解码全量样本 JSON。
        // 判定逐项沿用原实现：Codex 走**同一个** `rankedCodexHomeIds`（其内部用
        // `codexSampleAllowed` ⇒ `publicationFilter.threadAllowed` + `codexSampleThreadId`
        // 的线程身份校验），非 Codex 只要求 home 未被标退化。行集 = 全表（与旧实现同集）。
        const identities = this.perfSampleIdentities();
        const codexHomeIds = rankedCodexHomeIds(publicationFilter, identities);
        const otherHomeIds = identities
          .filter((sample) => sample.sourceKind !== "codex")
          .filter((sample) => !degraded.has(sample.homeId))
          .map((sample) => sample.homeId)
          .filter(Boolean);
        return [...new Set([...codexHomeIds, ...otherHomeIds])].sort();
      })(),
      // M4.2：冻结的 `PerfSummary` 三件套（`usage-types.js:178`）。`state='rebuilding'`
      //（含读取投影专有的 `uninitialized`）时 `groups` 为空 —— **不返回部分排名**（卡片明文）。
      groups: perfStats.groups,
      coverage: perfStats.coverage,
      meta: perfStats.meta,
    };

    if (includeDetails) {
      summary.homes = this.groupedRange("home_label", range, "total DESC", scopeExclusions);
      summary.projects = this.groupedRange("project", range, "total DESC", scopeExclusions);
      summary.repositories = this.repositoriesRange(range, scopeExclusions);
    }
    return summary;
  }

  close() {
    // C1 卡：**实例私有**记录在 `close()` 时清空 —— 卡面/规格明文"close/open、实例销毁和方法变更
    // 使记录失效"。记录不跨实例、不跨 close 存活（重开后重新预热一次规划）。
    this.codexStableAttempts.clear();
    // C3 卡：投影缓存同为**实例私有** ⇒ `close()` 一并清空（重开后重新预热一次；不跨实例）。
    this.codexProjections.clear();
    this.codexThreadBuildPlan.clear();
    // D1：派生缓存与写事务深度都是**连接级**状态 ⇒ `close()` 一并复位；`open()` 会把
    // `observedDataVersion` 重新取基准（外部提交检测在重开后**从零**开始计），
    // 而 `storeRevision` 是这个**实例**的单调修订号，跨 `close()/open()` 保留。
    this.metadataCache = null;
    this.periodComparisonCache.clear();
    // D4：观测聚合缓存同为连接级状态（`storeRevision` 跨 close/open **保留** ⇒ 必须显式复位）。
    this.metadataObservationCache = null;
    // D2：历史冠军 memo 同为连接级状态（且 `storeRevision` 跨 close/open **保留** ⇒ 只靠键
    // 不足以保证"重开后一定重算"，必须显式复位）。
    this.recordChampionCache = null;
    // D3：quota 观测映射同为连接级状态（`storeRevision` 跨 close/open **保留** ⇒ 必须显式复位）。
    this.quotaObservationCache = null;
    // W4-b1 / D1：事件计价 memo 是**实例私有** ⇒ `close()` 一并清空（重开后重新预热一次；
    // 不跨实例）。键里已含内容与价目版本，所以这里同样是内存卫生而非正确性要求。
    this.eventCostMemo.clear("close");
    this.derivedRevision = this.storeRevision;
    this.writeTransactionDepth = 0;
    if (!this.database) {
      return;
    }
    this.database.close();
    this.database = null;
  }
}
