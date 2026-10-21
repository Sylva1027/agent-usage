// M3.2：性能候选的**来源注册表与调度器**。
//
// 这是集成层（不是 reader 层）：它决定"哪些来源已启用"，并把**已启用**来源的物理文件交给对应
// reader。M7 adds Codex through the thread-level aggregator; it must never use
// this physical-file dispatcher. project-log remains structurally unsupported.
//
// 三条必须守住的语义（都有实测依据）：
//
// 1. **`not_enabled` ≠ `degraded`**🟩。未启用来源**不是**失败来源：它没有候选、没有分母，
//    因此**不产生 0 TPS**，也**不得**让其他来源退化（M3.4 的 `unsupportedSources` 单列它们）。
//    把"没实现"和"读坏了"混成一个状态，会让 UI 把未启用源显示成"0 TPS 的性能最差来源"。
// 2. **`unsupported` 是终态**🟩：project-log 没有计时字段，方案 `:60` 规定它**不生成**性能观测。
//    它与 `not_enabled` 的区别是"将来也不会启用"（除非新增该来源的计时语义）。
// 3. **本模块不写库、不碰索引**🟩：它只调用 reader 并把候选交给调用方给的回调。事务、删除与
//    插入全部由 `UsageStore.replaceFile()` 拥有 —— 这样"同一事务内替换四类数据"才有可能。

import { canonicalPerfSourceKind, normalizePerfSample, PERF_SOURCE_KINDS } from "../perf-stats.js";
import { streamZcodePerfSamples } from "./zcode.js";
import { streamDshPerfSamples } from "./dsh.js";
import { streamOpencodePerfSamples } from "./opencode.js";
import { streamWorkbuddyPerfSamples } from "./workbuddy.js";

// Codex candidates must be folded across every rollout in a thread. This sentinel
// keeps it enabled for source classification while rejecting accidental per-file use.
async function rejectCodexFileDispatch() {
  throw Object.assign(new Error("Codex performance candidates must be read by thread"), { code: "UNSUPPORTED_SCHEMA" });
}

/**
 * @typedef {(filePath: string, source: any, onSample: (sample: any) => void, options?: any) => Promise<any>} PerfSourceReader
 */

/**
 * 状态枚举：`enabled` 已启用 / `not_enabled` 尚未接入（将来会） / `unsupported` 结构上不支持。
 * @typedef {"enabled" | "not_enabled" | "unsupported"} PerfSourceRegistrationState
 */

/**
 * 注册表。**只列已启用的来源**；未列出的一律按 `not_enabled` 处理（默认拒绝，避免"忘了注册
 * 就等于悄悄启用"）。新增来源的 process（M4.5/M4.6/M7）在此登记，不改本模块其他部分。
 *
 * `kind` 是**规范来源 kind**（M1 `canonicalPerfSourceKind` 的出口）。注意现有 discovery 用
 * `main/jetbrains/extra/codex` 表示 Codex 并映射到 `codex`，所以这里登记的是规范值。
 * @type {ReadonlyMap<string, PerfSourceReader>}
 */
export const PERF_SOURCE_READERS = new Map(
  /** @type {[string, PerfSourceReader][]} */ ([
    ["zcode", streamZcodePerfSamples],
    ["dsh", streamDshPerfSamples],
    ["opencode", streamOpencodePerfSamples],
    ["codex", rejectCodexFileDispatch],
    ["workbuddy", streamWorkbuddyPerfSamples],
  ]),
);

/** 结构上不支持性能观测的来源 kind（方案 `:60`）。规范 kind 与原始 kind 都登记。 */
export const PERF_UNSUPPORTED_KINDS = Object.freeze(new Set(["project-log"]));

/**
 * 查询一个来源的注册状态。
 *
 * `unsupported` 优先于 `not_enabled`：project-log 即使将来被别人"顺手注册"也仍是 unsupported。
 * @param {unknown} kindRaw discovery 给出的原始 kind（可能含 `main/jetbrains/extra` 等别名）
 * @returns {{ kind: string, state: PerfSourceRegistrationState, reader: ((filePath: string, source: any, onSample: (sample: any) => void, options?: any) => Promise<any>) | null }}
 */
export function resolvePerfSourceReader(kindRaw) {
  const kind = canonicalPerfSourceKind(kindRaw);
  if (PERF_UNSUPPORTED_KINDS.has(kind) || PERF_UNSUPPORTED_KINDS.has(String(kindRaw))) {
    return { kind, state: "unsupported", reader: null };
  }
  const reader = PERF_SOURCE_READERS.get(kind);
  if (!reader) {
    return { kind, state: "not_enabled", reader: null };
  }
  return { kind, state: "enabled", reader };
}

/** 该 kind 是否已启用（`replaceFile` 只需回答这一个问题）。 */
export function isPerfSourceEnabled(kindRaw) {
  return resolvePerfSourceReader(kindRaw).state === "enabled";
}

/**
 * 已启用来源的规范 kind 列表（供 M3.4 写 `unsupportedSources` 与 M4.3 投影）。
 * 顺序固定，便于测试与输出稳定。
 */
export function enabledPerfSourceKinds() {
  return PERF_SOURCE_KINDS.filter((kind) => PERF_SOURCE_READERS.has(kind));
}

/**
 * 把发现到的来源分类成 `{ enabled, notEnabled, unsupported }` 三组（**规范 kind**）。
 * 供 M3.4/M4 组装 coverage 时使用：三组必须**分开**呈现，不能合并成一个"失败源"列表。
 * @param {ReadonlyArray<{ kind?: unknown, id?: unknown, homeId?: unknown }>} sources
 */
export function classifyPerfSources(sources) {
  const enabled = [];
  const notEnabled = [];
  const unsupported = [];
  for (const source of sources || []) {
    const kindRaw = source?.kind;
    const kind = canonicalPerfSourceKind(kindRaw);
    const homeId = typeof source?.id === "string" ? source.id : typeof source?.homeId === "string" ? source.homeId : "";
    const entry = { kind, homeId };
    const state = resolvePerfSourceReader(kindRaw).state;
    if (state === "enabled") enabled.push(entry);
    else if (state === "unsupported") unsupported.push(entry);
    else notEnabled.push(entry);
  }
  return { enabled, notEnabled, unsupported };
}

/**
 * 调度：对一个**已启用**来源的物理文件跑 reader，把每条**归一化**候选交给 `onSample`。
 *
 * 归一化在这里做（而不是在 `replaceFile` 里）：reader 出口是 raw 候选（36 键），
 * `perf_samples` 存的是归一化样本（31 字段）—— M3.1 实测两者的差集是 10 个出 / 5 个入，
 * 不做这一步就必然 `MISSING_FIELD`。
 *
 * 返回 `{ state, stats, warnings }`：
 * - `state = "not_enabled" | "unsupported"`⇒ 未跑 reader，`stats = null`（**不伪造 0**）
 * - `state = "enabled"` ⇒ `stats` 保留各 reader 自己的计数形状，不用于重算统计。
 *
 * **致命错误照旧抛出**（reader 的只读打开/schema 失败），由 `replaceFile` 回滚并让调用方标
 * degraded —— 本模块**不吞**异常。
 * @param {string} filePath
 * @param {{ id?: unknown, path?: unknown, kind?: unknown, label?: unknown }} source
 * @param {(sample: any) => void} onSample
 * @param {{ onWarning?: (warning: any) => void, lookupGenerationDuration?: (messageId: string) => any }} [options]
 */
export async function streamPerfSamplesForFile(filePath, source, onSample, options = {}) {
  const { kind, state, reader } = resolvePerfSourceReader(source?.kind);
  if (state !== "enabled" || reader === null) {
    return { state, kind, stats: null, warnings: [] };
  }
  /** @type {any[]} */
  const warnings = [];
  // DSH reader can recover readable frames, but an incomplete file must not be
  // published as ready. Stage its candidates until structured diagnostics pass.
  // Other sources retain their existing streaming behavior.
  const staged = kind === "dsh" ? [] : null;
  const stats = await reader(
    filePath,
    source,
    (raw) => {
      const normalized = normalizeRawSample(raw);
      if (normalized !== null) {
        if (staged !== null) staged.push(normalized);
        else onSample(normalized);
      }
    },
    {
      onWarning: (warning) => {
        warnings.push(warning);
        if (staged === null) options.onWarning?.(warning);
      },
      // WorkBuddy：时长不在会话转录里，由 store 从 `workbuddy_generation_durations` 查表提供。
      // 其它 reader 忽略这个字段（各自的时间戳/时长语义与它无关）。
      lookupGenerationDuration: options.lookupGenerationDuration,
    },
  );
  if (staged !== null) {
    // One failure per physical file, matching M3 projectSourceFailures and the
    // memory catch path. Do not also emit this as a callback warning (double count).
    const code = ["MALFORMED_FRAME", "MALFORMED_JSON", "UNSUPPORTED_SCHEMA"].find((candidate) =>
      warnings.some((warning) => warning.code === candidate),
    );
    if (code) {
      const error = new Error("DSH performance source integrity check failed");
      Object.assign(error, { code });
      throw error;
    }
    for (const warning of warnings) options.onWarning?.(warning);
    for (const sample of staged) onSample(sample);
  }
  return { state, kind, stats, warnings };
}

/**
 * raw 候选 → 归一化样本。单独导出以便测试直接锁定"归一化这一步真的做了"。
 *
 * 依赖 M1 的 `normalizePerfSample`（**冻结** `af5fa41c…`）；这里**不重新实现**任何语义，
 * 只负责搬运与"不可归一化就丢弃并计数"。
 * @param {any} raw
 * @returns {any | null}
 */
export function normalizeRawSample(raw) {
  const result = normalizePerfSample(raw);
  return result.sample ?? null;
}
