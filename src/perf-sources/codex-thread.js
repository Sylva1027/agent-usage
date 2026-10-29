import { createHash } from "node:crypto";
import path from "node:path";

import { PERF_METHOD_VERSION, canonicalPerfSourceKind, normalizePerfSample } from "../perf-stats.js";
import { buildCodexResponseCandidates } from "./codex-candidates.js";
import { foldCodexRolloutMetadata } from "./codex-fold.js";
import { readCodexRolloutMetadata } from "./codex-jsonl.js";

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasUnknownStructure(stats) {
  return stats.unknownTopLevelTypes > 0 || stats.unknownEventTypes > 0 || stats.unknownItemTypes > 0;
}

function hasUnreadableRows(stats) {
  return (
    stats.malformedJsonLines > 0 || stats.nonObjectRows > 0 || stats.invalidPayloadRows > 0 || stats.invalidItemRows > 0
  );
}

function hasUnsupportedRows(stats) {
  return hasUnreadableRows(stats) || hasUnknownStructure(stats);
}

function currentHistoryBaseStart(header) {
  if (!header.historyBasePresent) return 0;
  if (
    !header.historyBaseIsObject ||
    !header.historyBaseThreadIdPresent ||
    typeof header.historyBaseThreadId !== "string" ||
    header.historyBaseThreadId === "" ||
    !header.historyBaseEndOrdinalPresent ||
    !Number.isSafeInteger(header.historyBaseEndOrdinalExclusive) ||
    header.historyBaseEndOrdinalExclusive < 0 ||
    !header.historyBaseEndByteOffsetPresent ||
    !Number.isSafeInteger(header.historyBaseEndByteOffset) ||
    header.historyBaseEndByteOffset < 0
  ) {
    return null;
  }
  return header.historyBaseEndOrdinalExclusive;
}

function provePaginatedChildOwnership(projection, headers) {
  const { stats, ordinalSequence } = projection;
  // A boundary cannot explain a malformed row or unknown schema: every row
  // must be understood before missing identities can be assigned by segment.
  if (
    hasUnsupportedRows(stats) ||
    stats.invalidSessionMetaPayloads > 0 ||
    stats.sessionMetaWithoutThreadId > 0 ||
    stats.ambiguousSessionMetaThreadId !== 1 ||
    headers.length !== 2
  ) {
    return null;
  }

  const [child, parent] = headers;
  if (
    child.sourceKind !== "structured" ||
    child.explicitSubagent !== true ||
    child.explicitThreadSpawn !== true ||
    child.historyModePresent !== true ||
    child.historyModeType !== "string" ||
    child.historyMode !== "paginated" ||
    parent.historyModePresent !== true ||
    parent.historyModeType !== "string" ||
    parent.historyMode !== "paginated" ||
    typeof child.threadId !== "string" ||
    child.threadId === "" ||
    typeof parent.threadId !== "string" ||
    parent.threadId === "" ||
    child.threadId === parent.threadId ||
    child.sessionId !== parent.threadId ||
    child.parentThreadId !== parent.threadId ||
    child.forkedFromId !== parent.threadId ||
    parent.sessionId !== parent.threadId ||
    child.subagentHistoryStartOrdinalPresent !== true ||
    !Number.isSafeInteger(child.subagentHistoryStartOrdinal) ||
    child.subagentHistoryStartOrdinal < 0
  ) {
    return null;
  }

  const childBaseStart = currentHistoryBaseStart(child);
  if (childBaseStart === null || currentHistoryBaseStart(parent) === null) return null;
  // Validate a copied parent checkpoint as header metadata, but never use it as
  // the physical ordinal start for the child rollout.

  if (
    !ordinalSequence ||
    ordinalSequence.rowCount !== stats.linesRead ||
    ordinalSequence.invalidCount !== 0 ||
    ordinalSequence.duplicateCount !== 0 ||
    ordinalSequence.physicalOrderReversalCount !== 0 ||
    ordinalSequence.gapCount !== 0 ||
    !Number.isSafeInteger(ordinalSequence.firstOrdinal) ||
    !Number.isSafeInteger(ordinalSequence.lastOrdinal) ||
    ordinalSequence.firstOrdinal !== childBaseStart ||
    ordinalSequence.firstLineNumber !== child.lineNumber ||
    ordinalSequence.secondLineNumber !== parent.lineNumber ||
    !Number.isSafeInteger(child.ordinal) ||
    !Number.isSafeInteger(parent.ordinal) ||
    child.ordinal !== ordinalSequence.firstOrdinal ||
    parent.ordinal <= child.ordinal
  ) {
    return null;
  }

  const boundary = child.subagentHistoryStartOrdinal;
  const lastOrdinal = ordinalSequence.lastOrdinal;
  const maximumBoundary = lastOrdinal === Number.MAX_SAFE_INTEGER ? lastOrdinal : lastOrdinal + 1;
  if (boundary <= parent.ordinal || boundary > maximumBoundary) return null;

  const missingThreadIdCount = projection.records.filter(
    (record) => record.kind !== "session_meta" && (typeof record.threadId !== "string" || record.threadId === ""),
  ).length;
  if (missingThreadIdCount !== stats.recordsWithoutThreadId) return null;

  const childRecords = [];
  let inheritedProjectedRecordCount = 0;
  for (const record of projection.records) {
    if (record === child) {
      childRecords.push(record);
      continue;
    }
    if (record.kind === "session_meta") continue;
    if (!Number.isSafeInteger(record.ordinal) || record.ordinal < 0) return null;

    const inherited = record.ordinal < boundary;
    const expectedThreadId = inherited ? parent.threadId : child.threadId;
    if (record.threadId && record.threadId !== expectedThreadId) return null;
    if (inherited) {
      inheritedProjectedRecordCount += 1;
      continue;
    }
    childRecords.push(record.threadId ? record : { ...record, threadId: child.threadId });
  }

  return {
    threadId: child.threadId,
    kind: "paginated-child",
    boundaryOrdinal: boundary,
    lineageThreadId: parent.threadId,
    inheritedProjectedRecordCount,
    projection: {
      ...projection,
      // Exclude the copied parent header and inherited rows before M6.2 folding.
      // `filePath` remains the complete physical rollout dependency.
      records: childRecords,
      ownershipProof: {
        kind: "paginated-child",
        boundaryOrdinal: boundary,
        lineageThreadId: parent.threadId,
        inheritedProjectedRecordCount,
      },
    },
  };
}

/**
 * Prove ordinary single-thread ownership, or the one accepted paginated child shape.
 *
 * @returns {{threadId: string, kind: string, projection: object, boundaryOrdinal?: number, lineageThreadId?: string, inheritedProjectedRecordCount?: number}|null}
 */
function proveCodexOwnership(projection) {
  const { records, stats } = projection;
  const headers = records.filter((record) => record.kind === "session_meta");
  if (
    stats.invalidSessionMetaPayloads > 0 ||
    stats.sessionMetaWithoutThreadId > 0 ||
    stats.ambiguousSessionMetaThreadId > 1 ||
    headers.length === 0 ||
    headers.some((header) => typeof header.threadId !== "string" || header.threadId === "")
  ) {
    return null;
  }

  const headerIds = new Set(headers.map((header) => header.threadId));
  if (headerIds.size > 1) return provePaginatedChildOwnership(projection, headers);
  if (headerIds.size !== 1 || stats.recordsWithoutThreadId > 0) return null;

  const threadIds = new Set(records.map((record) => record.threadId).filter(Boolean));
  const threadId = [...headerIds][0];
  if (threadIds.size !== 1 || !threadIds.has(threadId)) return null;
  return { threadId, kind: "single-thread", projection };
}

/**
 * Evaluate one M6 projection. Strict reads and home planning share the same
 * ownership proof so neither can accept a rollout the other rejects.
 */
function evaluateCodexProjection(projection) {
  const { stats } = projection;
  const ownershipProof = proveCodexOwnership(projection);
  const unknown = hasUnknownStructure(stats);
  if (hasUnreadableRows(stats)) {
    return {
      ok: false,
      threadId: ownershipProof?.threadId ?? null,
      ownershipProof,
      projection: ownershipProof?.projection ?? projection,
      code: "MALFORMED_JSON",
      message: "Codex rollout contains unreadable JSONL records",
      isolatable: Boolean(ownershipProof) && !unknown,
    };
  }
  if (unknown) {
    return {
      ok: false,
      threadId: ownershipProof?.threadId ?? null,
      ownershipProof,
      projection: ownershipProof?.projection ?? projection,
      code: "UNSUPPORTED_SCHEMA",
      message: "Codex rollout contains unsupported record types",
      isolatable: false,
    };
  }
  if (!ownershipProof) {
    return {
      ok: false,
      threadId: null,
      ownershipProof: null,
      projection,
      code: "UNKEYABLE_RECORD",
      message: "Codex rollout thread identity is incomplete or ambiguous",
      isolatable: false,
    };
  }
  return {
    ok: true,
    threadId: ownershipProof.threadId,
    ownershipProof,
    projection: ownershipProof.projection,
    code: null,
    message: "",
    isolatable: false,
  };
}

/** Read and validate the stable thread identity from one M6 metadata projection. */
export async function readCodexRollout(filePath) {
  const resolvedPath = path.resolve(filePath);
  const projection = await readCodexRolloutMetadata(resolvedPath);
  const verdict = evaluateCodexProjection(projection);
  if (!verdict.ok) throw failure(verdict.code, verdict.message);
  return { filePath: resolvedPath, threadId: verdict.threadId, projection: verdict.projection };
}

// ---------------------------------------------------------------------------
// C3 卡：**未变文件的标准化投影复用**（私有、内存、有界）。
//
// 靶子（B3 基线）：任何"有变更"的轮次都对**全部** rollout 做全文解析
//   （`readCodexRolloutMetadataCalls = 362` / `1 274 551 054 B`）。
// 本段把 `readCodexRolloutMetadata()` 的**标准化结果**（`{records, stats, ordinalSequence}`）
// 按"**本轮读取前**内容指纹"存下来；下一轮该文件指纹逐字相同就**直接复用**对象，
// **不再打开文件**。卡面明文：**不存原始 JSONL、不另写 parser**；完整文件集合仍参与
// 归属证明与前后稳定性验证（`planStableCodexHome` 的两侧指纹与路径集比较原样保留）。
//
// ⚠️ 与 S2/C1/C2 的同一条纪律：复用的身份是**可判定的对象/版本**（本轮窗口指纹 + 来源 +
// 方法版本 + home），**不绑时间、不绑全局**；窗口不可用 ⇒ `undefined` ⇒ 真实读取。
// 跨轮**粘**缓存（按路径直接返回上一轮的结论）是明确错误。
// ---------------------------------------------------------------------------

/**
 * C3：投影的**方法版本**。
 *
 * `PERF_METHOD_VERSION`（标准化口径）+ 本段的投影解析版本。二者任一变化 ⇒ 旧投影立即失效。
 * ⚠️ 任何改变 `readCodexRolloutMetadata()` 返回形状或类型识别的改动（`codex-jsonl.js`）**必须**同时 bump
 * `CODEX_PROJECTION_METHOD_VERSION`，否则复用会把旧形状喂给新消费者。
 */
export const CODEX_PROJECTION_METHOD_VERSION = "codex-projection-v5";

/** C3：一个投影缓存实例的默认字节预算（计划 §5 P2b「初始每实例投影缓存预算 64 MiB」）。 */
export const DEFAULT_CODEX_PROJECTION_CACHE_BYTES = 64 * 1024 * 1024;

function codexProjectionMethodVersion() {
  return `${PERF_METHOD_VERSION}:${CODEX_PROJECTION_METHOD_VERSION}`;
}

/**
 * C3：规范物理路径 —— 复用摘要的键必须是**物理文件本身**，而不是它的某种写法。
 *
 * 只做绝对化 + Windows 大小写折叠（与 `usage-store.js` 的 `canonicalPerfProbePath` 同型；
 * 后者是 store 的私有函数，跨模块 import 会成环，故按本仓既有的"镜像 + 对拍测试"惯例本地实现）。
 * **不做** `realpath`：那会引入额外 I/O，并把符号链接与 `-wal` 折叠的语义从"路径"改成"目标"。
 */
function canonicalProjectionPath(filePath) {
  const text = String(filePath ?? "");
  if (text === "") return text;
  const resolved = path.resolve(text);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * C3：投影的**字节口径** = `JSON.stringify(projection)` 的长度（UTF-16 码元 ≈ 序列化字节）。
 *
 * 只在 `stage()` 时算一次 —— 代价相对它伴随的那次整文件解析可忽略。真实**常驻堆**按本仓已登记的
 * "堆/序列化比 1.706"折算（run README 的容量警示）；两个口径的实测值都写在
 * `C3\out\measure-c3-memory.json` 里，容量裁定归 C6。
 */
function projectionByteEstimate(projection) {
  try {
    return JSON.stringify(projection)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * A3: retain only a compact identity of the projection proven inside the
 * stable planner window. Lazy hydration must reproduce this identity before it
 * may be staged or built; this prevents a post-window read from being cached
 * under the pre-window fingerprint.
 */
function codexProjectionDigest(projection) {
  try {
    const text = JSON.stringify(projection);
    if (typeof text !== "string") return null;
    return createHash("sha256").update(text).digest("hex");
  } catch {
    return null;
  }
}

/**
 * C3：**实例私有**的标准化投影缓存。由 `UsageStore` 持有一个实例，`close()` 时清空。
 *
 * 生命周期与有界性：
 *   * 一个规范路径**最多一条**条目 —— 插入即替换（只保留**当前文件版本**）；
 *   * `prune(homeId, paths)` 淘汰该 home 中**已不存在**的路径（替换 / 删除 / 重命名 / 归档迁移）；
 *   * `retainHomes(ids)` 淘汰**整个 home 消失**的条目；
 *   * `commit(homeId)` 只在**稳定窗口**（读取前/后指纹与路径集逐字一致）成立时把本轮暂存提升为
 *     可复用条目；不稳定/不可证 ⇒ `rollback(homeId)` **丢弃**（失效即重算，不粘到下一轮）；
 *   * `maxBytes`（默认 64 MiB）超出时按插入顺序逐出最旧条目（LRU）—— 逐出只影响**成本**，不影响正确性。
 *
 * @param {{ maxBytes?: number }} [options]
 */
export function createCodexProjectionCache({ maxBytes = DEFAULT_CODEX_PROJECTION_CACHE_BYTES } = {}) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : Number.POSITIVE_INFINITY;
  /** @type {Map<string, {projection: object, fingerprint: string, homeId: string, methodVersion: string, bytes: number}>} */
  const committed = new Map();
  /** @type {Map<string, Map<string, any>>} homeId → 本轮暂存（只有稳定窗口才提升） */
  const staged = new Map();
  let retainedBytes = 0;
  let pathIndex = null;
  const counters = {
    hits: 0,
    misses: 0,
    staleFingerprint: 0,
    staleMethodVersion: 0,
    foreignHome: 0,
    evictions: 0,
    commits: 0,
    rollbacks: 0,
  };

  /**
   * 路径索引：绑定 `fingerprints` **对象身份**（同 C2 `codexReusedProbeValue` 的 `forSignature`）。
   * 换对象 ⇒ **必须重建** —— 否则"路径 → 指纹"会停在上一轮的取值上，让一个**真的变了**的文件
   * 因为旧指纹恰好等于旧条目而被当作未变（这正是"粘缓存"要防的那一类错误）。
   */
  const indexFor = (fingerprints) => {
    if (!pathIndex || pathIndex.forFingerprints !== fingerprints) {
      const byPath = new Map();
      for (const [candidate, fingerprint] of Object.entries(fingerprints)) {
        byPath.set(canonicalProjectionPath(candidate), fingerprint);
      }
      pathIndex = { forFingerprints: fingerprints, byPath };
    }
    return pathIndex.byPath;
  };

  /** 本轮窗口里该路径的指纹；`undefined` ⇒ 该文件不在窗口内 ⇒ 不可复用。 */
  const currentFingerprint = (fingerprints, filePath) => {
    if (!fingerprints || typeof fingerprints !== "object") return undefined;
    // 快路径：发现路径与窗口键逐字相同（隔离输入 100% 命中，零额外分配）。
    if (Object.hasOwn(fingerprints, filePath)) {
      const value = fingerprints[filePath];
      return typeof value === "string" && value !== "" ? value : undefined;
    }
    const value = indexFor(fingerprints).get(canonicalProjectionPath(filePath));
    return typeof value === "string" && value !== "" ? value : undefined;
  };

  const drop = (canonicalPath) => {
    const entry = committed.get(canonicalPath);
    if (entry === undefined) return false;
    committed.delete(canonicalPath);
    retainedBytes -= entry.bytes ?? 0;
    return true;
  };

  const evictToLimit = () => {
    while (retainedBytes > limit && committed.size > 0) {
      const oldest = committed.keys().next();
      if (oldest.done) break;
      drop(oldest.value);
      counters.evictions += 1;
    }
  };

  return {
    /**
     * 在**全文读取之前**查一次投影。`undefined` = "不可复用" ⇒ 调用方必须走真实
     * `readCodexRolloutMetadata()`（**绝不能**把 `undefined` 当"未变"）。
     * @param {{homeId?: string, kind?: string, filePath?: string, fingerprints?: Record<string, string>, methodVersion?: string}} [options={}]
     */
    lookup({ homeId, kind, filePath, fingerprints, methodVersion } = {}) {
      // 守卫 ① 来源：非 codex 绝不与 codex 投影互相冒充。
      if (canonicalPerfSourceKind(kind) !== "codex") return undefined;
      const canonicalPath = canonicalProjectionPath(filePath);
      if (canonicalPath === "") return undefined;
      // 守卫 ② 窗口：本轮必须**已经**取得指纹（读取前摘要）；没有 ⇒ 不可复用。
      const current = currentFingerprint(fingerprints, filePath);
      if (current === undefined) return undefined;
      // 守卫 ③ 路径索引（`currentFingerprint` 内绑定指纹对象身份）。
      const entry = committed.get(canonicalPath);
      if (entry === undefined) {
        counters.misses += 1;
        return undefined;
      }
      // 守卫 ④ 指纹：**失效即删**，绝不复用旧投影。
      if (entry.fingerprint !== current) {
        drop(canonicalPath);
        counters.staleFingerprint += 1;
        return undefined;
      }
      // 守卫 ⑤ 方法版本（缺省 = 本实例当前版本；显式传入时以传入为准，便于把这条不变量钉进测试）。
      if (entry.methodVersion !== (methodVersion ?? codexProjectionMethodVersion())) {
        drop(canonicalPath);
        counters.staleMethodVersion += 1;
        return undefined;
      }
      // 守卫 ⑥ home 身份：同一物理文件换了 home（跨 home 迁移）⇒ 不当同一条目复用。
      if (entry.homeId !== String(homeId ?? "")) {
        counters.foreignHome += 1;
        return undefined;
      }
      // LRU：命中即移到队尾。
      committed.delete(canonicalPath);
      committed.set(canonicalPath, entry);
      counters.hits += 1;
      return entry.projection;
    },
    /**
     * 暂存一次**真实读取**的标准化投影；只有 `commit()` 才让它变得可复用。
     * @param {{homeId?: string, kind?: string, filePath?: string, fingerprints?: Record<string, string>, projection?: object, methodVersion?: string}} [options={}]
     */
    stage({ homeId, kind, filePath, fingerprints, projection, methodVersion } = {}) {
      if (canonicalPerfSourceKind(kind) !== "codex") return false;
      if (!projection || typeof projection !== "object") return false;
      const canonicalPath = canonicalProjectionPath(filePath);
      if (canonicalPath === "") return false;
      const fingerprint = currentFingerprint(fingerprints, filePath);
      if (fingerprint === undefined) return false;
      const id = String(homeId ?? "");
      let bucket = staged.get(id);
      if (bucket === undefined) {
        bucket = new Map();
        staged.set(id, bucket);
      }
      bucket.set(canonicalPath, {
        projection,
        fingerprint,
        homeId: id,
        methodVersion: methodVersion ?? codexProjectionMethodVersion(),
        bytes: projectionByteEstimate(projection),
      });
      return true;
    },
    /** 稳定窗口（或已证明的 append 子集）⇒ 把本轮暂存提升为可复用条目（返回提升的条目数）。 */
    commit(homeId, excludedPaths = []) {
      const bucket = staged.get(homeId);
      staged.delete(homeId);
      if (bucket === undefined || bucket.size === 0) return 0;
      const excluded = new Set((excludedPaths ?? []).map(canonicalProjectionPath));
      let promoted = 0;
      for (const [canonicalPath, entry] of bucket) {
        if (excluded.has(canonicalPath)) continue;
        const previous = committed.get(canonicalPath);
        if (previous !== undefined) retainedBytes -= previous.bytes ?? 0;
        committed.delete(canonicalPath);
        committed.set(canonicalPath, entry);
        retainedBytes += entry.bytes ?? 0;
        promoted += 1;
      }
      if (promoted === 0) return 0;
      counters.commits += 1;
      evictToLimit();
      return promoted;
    },
    /** 窗口不可证/不稳定 ⇒ **丢弃**本轮暂存（失效即重算，不粘住）。 */
    rollback(homeId) {
      const had = staged.delete(homeId);
      counters.rollbacks += 1;
      return had;
    },
    /** Drop one path from committed and staged memory after a lazy identity mismatch. */
    discard(filePath) {
      const canonicalPath = canonicalProjectionPath(filePath);
      if (canonicalPath === "") return false;
      let dropped = drop(canonicalPath);
      for (const bucket of staged.values()) {
        if (bucket.delete(canonicalPath)) dropped = true;
      }
      return dropped;
    },
    /** 只保留该 home 当前的物理文件集（替换 / 删除 / 重命名淘汰）。 */
    prune(homeId, filePaths) {
      const keep = new Set((filePaths ?? []).map(canonicalProjectionPath));
      const id = String(homeId ?? "");
      let dropped = 0;
      for (const [canonicalPath, entry] of [...committed]) {
        if (entry.homeId !== id || keep.has(canonicalPath)) continue;
        drop(canonicalPath);
        dropped += 1;
      }
      return dropped;
    },
    /** home 整体消失（来源移除 / 归档迁移 / 别名变化）⇒ 淘汰它的全部条目。 */
    retainHomes(homeIds) {
      const keep = new Set([...(homeIds ?? [])].map((homeId) => String(homeId)));
      let dropped = 0;
      for (const [canonicalPath, entry] of [...committed]) {
        if (keep.has(entry.homeId)) continue;
        drop(canonicalPath);
        dropped += 1;
      }
      for (const id of [...staged.keys()]) if (!keep.has(id)) staged.delete(id);
      return dropped;
    },
    clear() {
      committed.clear();
      staged.clear();
      retainedBytes = 0;
      pathIndex = null;
    },
    /**
     * 只读视图（**返回实时引用**，供证据/容量脚本与"planner/builder 不改写缓存对象"的断言使用；
     * 不参与产品逻辑，调用方不得改写返回的对象）。
     */
    entries() {
      return [...committed.entries()].map(([canonicalPath, entry]) => ({
        path: canonicalPath,
        homeId: entry.homeId,
        fingerprint: entry.fingerprint,
        methodVersion: entry.methodVersion,
        bytes: entry.bytes,
        projection: entry.projection,
      }));
    },
    stats() {
      let stagedEntries = 0;
      for (const bucket of staged.values()) stagedEntries += bucket.size;
      return {
        entries: committed.size,
        stagedEntries,
        bytes: retainedBytes,
        maxBytes: limit === Number.POSITIVE_INFINITY ? null : limit,
        methodVersion: codexProjectionMethodVersion(),
        ...counters,
      };
    },
  };
}

/**
 * M8.2 §4.1: one complete ownership plan for a Codex home, built from the file
 * set the caller already discovered.
 *
 * The caller owns file discovery and the before/after content-fingerprint
 * window; this function never touches the filesystem beyond one metadata
 * projection per file and never imports usage-core/store, so it stays callable
 * from both the store and the in-memory path.
 *
 * Every discovered file must land in exactly one provable bucket. If any file
 * has no reliable ownership, or fails in a non-isolatable way, the whole home
 * is blocked and `threads` is empty — the caller must not publish a success
 * subset of a home whose completeness was not proven.
 *
 * @param {string} homeId
 * @param {string[]} filePaths every current rollout file for this home
 * @param {{ projectionCache?: any, fingerprints?: Record<string, string>, kind?: string, methodVersion?: string }} [options]
 *   C3：`projectionCache` = 实例私有投影缓存（缺省 ⇒ 与今日行为逐字节等价：**永远真读**）；
 *   `fingerprints` = **同一窗口的"读取前"内容指纹**（`planStableCodexHome` 的
 *   `before.fileFingerprints`），它是投影的身份来源，**不是**新增的摘要；
 *   `kind` = 发现时给出的原始 kind（`main`/`jetbrains`/`extra` 等同义别名）。
 *   `projectionCache.lazyRollouts === true` 时，整 home 扫描只保留轻量归属索引；
 *   受影响线程通过 `loadRollouts()` 在构建前逐文件水合。
 */
export async function planCodexHomeThreads(homeId, filePaths, options = {}) {
  if (typeof homeId !== "string" || homeId.trim() === "")
    throw new TypeError("Codex homeId must be a non-empty string");
  if (!Array.isArray(filePaths)) throw new TypeError("Codex rollout paths must be an array");

  const projectionCache = options?.projectionCache;
  const fingerprints = options?.fingerprints;
  const sourceKind = options?.kind ?? "codex";
  const methodVersion = options?.methodVersion ?? codexProjectionMethodVersion();
  const lazyRollouts = projectionCache?.lazyRollouts === true;

  const ownedByThread = new Map();
  const failedByThread = new Map();
  const unownedFiles = [];
  const homeBlocking = [];

  const loadProjection = async (resolvedPath) => {
    let projection = projectionCache?.lookup({
      homeId,
      kind: sourceKind,
      filePath: resolvedPath,
      fingerprints,
      methodVersion,
      transient: lazyRollouts,
    });
    if (projection !== undefined) return { projection, cacheHit: true };
    projection = await readCodexRolloutMetadata(resolvedPath);
    return { projection, cacheHit: false };
  };

  const stageProjection = (resolvedPath, projection) => {
    // The lazy path stages only projections needed for an affected thread.
    // It persists through the store's per-thread commit and never populates
    // the in-memory full-home projection map.
    projectionCache?.stage({
      homeId,
      kind: sourceKind,
      filePath: resolvedPath,
      fingerprints,
      projection,
      methodVersion,
      transient: lazyRollouts,
    });
  };

  for (const filePath of [...filePaths].sort(compareText)) {
    const resolvedPath = path.resolve(filePath);
    // ── C3 卡：**在全文读取之前**按路径/来源/指纹/方法查私有投影 ────────────────────────────
    // 指纹来自**同一验证窗口的"读取前"摘要**（`planStableCodexHome` 的
    // `before = perfHomeContentFingerprint(home, files)`），从取值到本消费点之间**没有对该文件的
    // 任何读取**（卡面红线 ① 的同型论证）。`undefined` ⇒ 走真实 `readCodexRolloutMetadata()`。
    // 归属证明与前后稳定性验证**完全不变**：命中的投影照样过 `evaluateCodexProjection()`，
    // `before`/`after` 两侧指纹与完整路径集也照样逐字比较。
    let loaded;
    try {
      // The eager path keeps the existing stage-before-verdict behavior. The
      // lazy path drops each proof-only projection before reading the next file.
      loaded = await loadProjection(resolvedPath);
    } catch (error) {
      homeBlocking.push({ filePath: resolvedPath, code: String(error?.code ?? "IO_ERROR") });
      continue;
    }
    const { projection } = loaded;
    if (!lazyRollouts && !loaded.cacheHit) stageProjection(resolvedPath, projection);
    const verdict = evaluateCodexProjection(projection);
    // Strict reads and planning use this same proof and accepted projection.
    const provenId = verdict.ownershipProof?.threadId ?? null;
    if (!provenId) {
      unownedFiles.push({ filePath: resolvedPath, code: verdict.code });
      continue;
    }
    if (verdict.ok) {
      if (!ownedByThread.has(provenId)) ownedByThread.set(provenId, []);
      // The eager path retains the child-only projection for the builder. The
      // lazy path retains only identity and rehydrates before an affected build.
      // Either way, filePath names the entire physical rollout dependency.
      const projectionDigest = lazyRollouts ? codexProjectionDigest(verdict.projection) : null;
      if (lazyRollouts && projectionDigest === null) {
        homeBlocking.push({ filePath: resolvedPath, code: "UNSUPPORTED_SCHEMA", threadId: provenId });
        continue;
      }
      ownedByThread.get(provenId).push({
        filePath: resolvedPath,
        threadId: provenId,
        ...(lazyRollouts ? { projectionDigest } : { projection: verdict.projection }),
      });
      continue;
    }
    if (!verdict.isolatable) {
      homeBlocking.push({ filePath: resolvedPath, code: verdict.code, threadId: provenId });
      continue;
    }
    if (!failedByThread.has(provenId)) failedByThread.set(provenId, []);
    failedByThread.get(provenId).push({ filePath: resolvedPath, code: verdict.code });
  }

  // §4.1(4): a thread with any isolatable failure loses its WHOLE current
  // candidate set — bad lines are never skipped while the rest of the same
  // thread is published.
  const threads = [];
  const failedThreads = [];
  for (const [threadId, rollouts] of ownedByThread) {
    const failures = failedByThread.get(threadId);
    if (!failures) {
      if (lazyRollouts) {
        threads.push({
          threadId,
          rollouts,
          async loadRollouts() {
            const hydrated = [];
            for (const rollout of rollouts) {
              const loaded = await loadProjection(rollout.filePath);
              const { projection } = loaded;
              const verdict = evaluateCodexProjection(projection);
              if (!verdict.ok) throw failure(verdict.code, verdict.message);
              if (verdict.threadId !== threadId) {
                throw failure("UNKEYABLE_RECORD", "Codex rollout ownership changed between planning and lazy loading");
              }
              if (codexProjectionDigest(verdict.projection) !== rollout.projectionDigest) {
                projectionCache?.invalidate?.({
                  homeId,
                  kind: sourceKind,
                  filePath: rollout.filePath,
                  fingerprints,
                  methodVersion,
                });
                throw Object.assign(
                  failure("LIVE_SOURCE_CHANGED", "Codex rollout changed after the stable planning window"),
                  { filePath: rollout.filePath },
                );
              }
              if (!loaded.cacheHit) stageProjection(rollout.filePath, projection);
              hydrated.push({
                filePath: rollout.filePath,
                threadId,
                projection: verdict.projection,
              });
            }
            return hydrated;
          },
        });
      } else {
        threads.push({ threadId, rollouts });
      }
      continue;
    }
    failedThreads.push({
      threadId,
      reason: failures[0].code,
      failedFilePaths: failures.map((failure) => failure.filePath),
      filePaths: [...rollouts.map((rollout) => rollout.filePath), ...failures.map((failure) => failure.filePath)],
    });
  }
  for (const [threadId, failures] of failedByThread) {
    if (ownedByThread.has(threadId)) continue;
    failedThreads.push({
      threadId,
      reason: failures[0].code,
      failedFilePaths: failures.map((failure) => failure.filePath),
      filePaths: failures.map((failure) => failure.filePath),
    });
  }

  const ok = homeBlocking.length === 0 && unownedFiles.length === 0;
  return {
    homeId,
    ok,
    threads: ok ? threads : [],
    failedThreads: ok ? failedThreads : [],
    unownedFiles,
    homeBlocking,
  };
}

/**
 * Build normalized M1 candidates for one confirmed thread and its complete rollout set.
 * @param {{lookupRequestTiming?: import("./codex-candidates.js").CodexRequestTimingLookup}} [options]
 */
export function buildCodexThreadPerfSamples(homeId, threadId, rollouts, options = {}) {
  if (typeof homeId !== "string" || homeId.trim() === "")
    throw new TypeError("Codex homeId must be a non-empty string");
  if (typeof threadId !== "string" || threadId.trim() === "") throw new TypeError("Codex threadId must be non-empty");
  if (!Array.isArray(rollouts) || rollouts.length === 0) throw new TypeError("Codex thread rollouts must be non-empty");

  const ordered = [...rollouts].sort((a, b) => compareText(a.filePath, b.filePath));
  if (ordered.some((rollout) => rollout.threadId !== threadId)) {
    throw failure("UNSUPPORTED_SCHEMA", "Codex thread rollouts contain conflicting thread identities");
  }
  const rolloutFiles = ordered.map((rollout) => rollout.filePath);
  const folded = foldCodexRolloutMetadata(
    homeId,
    ordered.map((rollout) => rollout.projection),
  );
  const built = buildCodexResponseCandidates(homeId, folded, rolloutFiles, options);
  const sourcePath = rolloutFiles[0];
  const samples = built.candidates.map((candidate) => {
    const normalized = normalizePerfSample({ ...candidate, sourcePath });
    if (!normalized.sample)
      throw failure(normalized.warningCode || "UNKEYABLE_RECORD", "Codex turn could not be normalized");
    return normalized.sample;
  });
  const missingTurnIdentityCount = ordered.reduce(
    (count, rollout) =>
      count +
      rollout.projection.records.filter(
        (record) =>
          ["token_usage_record", "response_item", "item_completed", "task_complete"].includes(record.kind) &&
          (typeof record.turnId !== "string" || record.turnId === ""),
      ).length,
    0,
  );
  const warnings = [...built.warnings];
  if (missingTurnIdentityCount > 0) {
    warnings.push({ sourceKind: "codex", homeId, code: "UNKEYABLE_RECORD", count: missingTurnIdentityCount });
  }
  return { samples, warnings, rolloutFiles };
}

// ---------------------------------------------------------------------------
// M8.2 §4.2: internal publication policy and the shared publish filter.
//
// The store persists the policy in `store_meta`; the in-memory path builds the
// same structure for this round. Both then filter candidates through the SAME
// predicate so their groups/coverage/sourceWarnings agree on the same source
// data. The policy carries internal identities only (home ids, thread ids) —
// never paths or bodies — and is never serialized into the public API, the
// frozen snapshot, or the full report.
// ---------------------------------------------------------------------------

export const CODEX_PUBLICATION_POLICY_REVISION = 2;

/**
 * Validate and merge policy entries. Shared by the encoder, the decoder and the
 * filter so the three entry points can never drift apart.
 *
 * Two rules matter:
 * - ANY invalid entry fails the whole permission set. Entries are never skipped
 *   and bad thread ids are never filtered out, because doing so would turn a
 *   malformed permission into a valid-looking empty `blockedThreadIds` and
 *   silently re-enable a home that must stay excluded.
 * - Duplicate homes take the UNION of their blocked thread ids. A later entry —
 *   including an empty one — must never revoke an earlier block.
 *
 * @returns {{ok: true, partialHomes: Array<{homeId: string, blockedThreadIds: string[]}>} | {ok: false}}
 */
function mergeCodexPolicyEntries(entries) {
  if (!Array.isArray(entries)) return { ok: false };
  const merged = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false };
    if (typeof entry.homeId !== "string" || entry.homeId === "") return { ok: false };
    if (!Array.isArray(entry.blockedThreadIds)) return { ok: false };
    const ids = merged.get(entry.homeId) ?? new Set();
    for (const threadId of entry.blockedThreadIds) {
      if (typeof threadId !== "string" || threadId === "") return { ok: false };
      ids.add(threadId);
    }
    merged.set(entry.homeId, ids);
  }
  const partialHomes = [...merged.entries()]
    .map(([homeId, ids]) => ({ homeId, blockedThreadIds: [...ids].sort(compareText) }))
    .sort((left, right) => compareText(left.homeId, right.homeId));
  return { ok: true, partialHomes };
}

/**
 * Encode the internal policy. Deduplicated and stably sorted so an unchanged
 * plan encodes byte-identically: changing only the exclusion list must not
 * churn the published content version.
 *
 * Throws on an invalid plan. The sync caller must treat that as a planning or
 * publication failure for this round — never as a reason to write `ready` or to
 * persist an emptied permission and keep publishing.
 */
export function encodeCodexPublicationPolicy(partialHomes) {
  const merged = mergeCodexPolicyEntries(partialHomes ?? []);
  if (!merged.ok) throw new TypeError("Codex publication policy contains an invalid entry");
  return JSON.stringify({ revision: CODEX_PUBLICATION_POLICY_REVISION, partialHomes: merged.partialHomes });
}

/**
 * Decode the internal policy. A missing key, unparsable value, wrong revision,
 * or malformed entry yields NO permission. A bad entry is never laxly filtered
 * into an empty `blockedThreadIds`, which would silently re-enable a whole home
 * that must stay excluded.
 */
export function decodeCodexPublicationPolicy(raw) {
  const denied = { revision: CODEX_PUBLICATION_POLICY_REVISION, partialHomes: [], usable: false };
  if (typeof raw !== "string" || raw === "") return denied;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return denied;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return denied;
  if (parsed.revision !== CODEX_PUBLICATION_POLICY_REVISION) return denied;
  const merged = mergeCodexPolicyEntries(parsed.partialHomes);
  if (!merged.ok) return denied;
  return { revision: parsed.revision, partialHomes: merged.partialHomes, usable: true };
}

/**
 * Build the shared publish filter.
 *
 * Order matters: first compute whole-home exclusions, then exclude
 * `blockedThreadIds` inside homes that hold partial permission. Only homes in
 * `partialHomes` may keep their good threads in the ranking; every other
 * excluded home follows the existing whole-home exclusion.
 *
 * An invalid permission set grants NO partial permission at all, so the homes
 * it mentions stay under whole-home exclusion rather than being let through.
 */
export function createCodexPublishFilter(degradedHomeIds, partialHomes) {
  const degraded = new Set((degradedHomeIds ?? []).filter((homeId) => typeof homeId === "string" && homeId !== ""));
  const permitted = new Map();
  const merged = mergeCodexPolicyEntries(partialHomes ?? []);
  if (merged.ok) {
    for (const entry of merged.partialHomes) permitted.set(entry.homeId, new Set(entry.blockedThreadIds));
  }
  const homeAllowed = (homeId) => !degraded.has(homeId) || permitted.has(homeId);
  // An unidentifiable thread inside a permitted home is excluded: we cannot
  // prove it is not one of the blocked threads.
  const threadAllowed = (homeId, threadId) => {
    if (!homeAllowed(homeId)) return false;
    const blocked = permitted.get(homeId);
    if (!blocked) return true;
    return typeof threadId === "string" && threadId !== "" && !blocked.has(threadId);
  };
  return {
    homeAllowed,
    threadAllowed,
    degradedHomeIds: [...degraded].sort(compareText),
    permittedHomeIds: [...permitted.keys()].sort(compareText),
  };
}

/**
 * The v3 Codex sample identity is
 * `["codex", homeId, threadId, turnId, responseId]`; the readable legacy v2
 * identity ends at turnId. Every present part must be a non-empty string and
 * the key home must match `sample.homeId` verbatim. `PerfSample.sessionId` and
 * the SQL `session_id` must never be used here.
 */
export function codexSampleThreadId(sample) {
  if (sample?.sourceKind !== "codex") return null;
  const homeId = typeof sample.homeId === "string" ? sample.homeId : "";
  if (homeId === "") return null;
  const key = sample.sampleKey;
  if (typeof key !== "string" || key === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(key);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || (parsed.length !== 4 && parsed.length !== 5)) return null;
  const [sourceKind, keyHomeId, threadId, turnId, responseId] = parsed;
  if (sourceKind !== "codex" || keyHomeId !== homeId) return null;
  if (typeof threadId !== "string" || threadId === "") return null;
  if (typeof turnId !== "string" || turnId === "") return null;
  if (parsed.length === 5 && (typeof responseId !== "string" || responseId === "")) return null;
  return threadId;
}

/** Non-Codex samples pass through untouched; Codex samples obey the filter. */
export function codexSampleAllowed(filter, sample) {
  if (sample?.sourceKind !== "codex") return true;
  const homeId = typeof sample.homeId === "string" ? sample.homeId : "";
  return filter.threadAllowed(homeId, codexSampleThreadId(sample));
}

/**
 * `rankedHomeIds` must come from the SAME filtered candidates, not from
 * "the database has this home" minus every excluded home. Only Codex samples
 * contribute — a Codex ranking must not list a home seen solely in another
 * source.
 */
export function rankedCodexHomeIds(filter, samples) {
  const homeIds = new Set();
  for (const sample of samples ?? []) {
    if (sample?.sourceKind !== "codex") continue;
    if (!codexSampleAllowed(filter, sample)) continue;
    if (typeof sample.homeId === "string" && sample.homeId !== "") homeIds.add(sample.homeId);
  }
  return [...homeIds].sort(compareText);
}
