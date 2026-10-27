// W1：唯一数据库持有者（执行器）+ 主线程客户端。
//
// 目的：把**阻塞型**工作（HTTP summary/读路径 `summarize`/`summarizeInReadTransaction` 及其
// B2 `groupedRange`/B3 `costEventsForRange`/B4，以及同步 `syncRound`）移出 HTTP 事件环，
// 使轻量端点（`/api/status`、静态资源）在重请求在飞时仍能就地应答。
//
// 契约（刻意最小，**不是**通用 RPC/调度池）：
//   · 执行器 = **唯一**持有 `UsageStore`/`DatabaseSync` 连接者；主线程**不**再打开该库。
//   · 消息集固定为：`open` / `sync` / `dashboard` / `summarize` / `periodComparison` / `metadata` / `snapshot` /
//     `backupHistory` / `rebuildHistoryRollups` / `historyArchives` / `historyArchiveDays` / `historyArchiveEventPage` / `historyArchiveEventCommit` / `historyArchiveImport` /
//     `publishedUsageEvents` / `publishedUsageReport` / `perfPublicationState` / `close`（请求）+
//     `ready` / `response` / `state`（响应/状态发布）。
//   · 只有 `sync`/`backupHistory`/`snapshot`/`rebuildHistoryRollups`/`historyArchiveDays`/`historyArchiveEventPage`/`historyArchiveImport`/
//     `historyArchiveEventCommit`/`publishedUsageEvents`/`publishedUsageReport`/`perfPublicationState`/`close`
//     共享一条 worker 内串行尾链；其它读请求仍直接分派，不做全局串行化。
//   · 状态发布：每次操作**完成**后把不可变读侧快照 post 给主线程（`metadata`/`status`/`homes`/
//     `warnings`/`serviceTierEvidence`/`checkedAt`）。status 在同步繁忙时读快照，空闲时限时读取发布版本。
//   · 价目目录：**主线程**是唯一权威（它持有价目文件与自动刷新）；每次请求把 `getPricingCatalog()`
//     带上，执行器在自己的模块实例里 `setPricingCatalog` 对齐（否则执行器会用内置缺省价目算成本）。
//   · 生命周期：连接初始化/关闭归执行器；主线程 `close()` 后 `terminate()`，退出不留孤儿线程。
//   · 崩溃/超时：在飞请求收到**可重试**错误（`EXECUTOR_UNAVAILABLE`/`EXECUTOR_EXITED`/超时），
//     不做无限重试（完整恢复是 W3）。
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { backup } from "node:sqlite";
import { createHistoryBackup } from "./history-backup.js";
import { publishHistoryArchiveImport, stageHistoryArchiveSegments } from "./history-archive.js";
import { getPricingCatalog, runWithPricingCatalog, setPricingCatalog } from "./pricing.js";
import { serviceTierEvidenceFromSnapshot, serviceTierEvidenceSnapshot } from "./service-tier-evidence.js";
import { UsageStore } from "./usage-store.js";

const REQUEST_TIMEOUT_MS = 120_000;
const CLOSE_TIMEOUT_MS = 5_000;

/**
 * 结果里可能带**类实例**（如 tier resolver）⇒ `postMessage` 的 structured clone 会抛
 * `could not be cloned`。HTTP 层本来就只 `JSON.stringify` 这些结果，因此这里做同样的 JSON 往返，
 * 保证跨线程传的就是"HTTP 会发出的那份数据"（语义等价、且不引入第二套形状）。
 */
function toWire(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function serviceTierEvidenceForWire(evidence) {
  return evidence === null ? null : serviceTierEvidenceSnapshot(evidence);
}

function restoreServiceTierEvidenceRecord(record) {
  if (!record || typeof record !== "object" || !Object.hasOwn(record, "serviceTierEvidence")) return record;
  return {
    ...record,
    serviceTierEvidence:
      record.serviceTierEvidence === null ? null : serviceTierEvidenceFromSnapshot(record.serviceTierEvidence),
  };
}

/** 只丢掉函数（`onShutdown` 等）与其他不可克隆值，其余选项**原样**转发给执行器。 */
function executorOptions(options = {}) {
  const forwarded = {};
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === "function") continue;
    try {
      structuredClone(value);
      forwarded[key] = value;
    } catch {
      // 不可结构化克隆（函数/句柄等）⇒ 不转发（执行器不需要，也不能跨线程共享）。
    }
  }
  return forwarded;
}

/**
 * 把**任意**请求载荷变成可 `postMessage` 的形状：先试 structured clone（保类实例），
 * 失败才深拷贝并**只丢函数**。`sync` 的 `options` 里可能带 `schedulePricingDiscovery`/
 * `cancelPricingDiscovery` 这类注入桩（测试/CLI 用），它们过不了 structured clone。
 */
function toTransferable(value) {
  try {
    structuredClone(value);
    return value;
  } catch {
    if (typeof value === "function") return undefined;
    if (value === null || typeof value !== "object") return value;
    if (value instanceof Date) return value;
    if (Array.isArray(value)) {
      return value.map((item) => toTransferable(item)).filter((item) => item !== undefined);
    }
    const forwarded = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = toTransferable(item);
      if (converted !== undefined) forwarded[key] = converted;
    }
    return forwarded;
  }
}

function executorError(error, code) {
  const wrapped = new Error(error?.message ?? String(error));
  // `checkJs` 的 `Error` 类型上没有这些字段：用一次 JSDoc 断言把它们显式化，
  // **运行期行为逐字不变**（只是让 tsc 看得见 `code/statusCode/quota/retryable`）。
  const detail = /** @type {{ code?: string, statusCode?: number, quota?: unknown, retryable?: boolean }} */ (wrapped);
  detail.code = error?.code ?? code ?? "EXECUTOR_ERROR";
  // 保留 HTTP 层需要的字段（`QUOTA_WINDOW_UNAVAILABLE` 的 409 + quota 载荷全靠它）。
  if (error?.statusCode !== undefined && error.statusCode !== null) detail.statusCode = error.statusCode;
  if (error?.quota !== undefined) detail.quota = error.quota;
  detail.retryable = detail.statusCode === undefined;
  return wrapped;
}

/** 把主线程权威价目对齐到执行器的模块实例（版本相同则零开销跳过）。 */
function applyPricingCatalog(pricing) {
  if (!pricing || typeof pricing !== "object") return;
  if (getPricingCatalog().version === pricing.version) return;
  setPricingCatalog(pricing);
}

function diagnosticError(error, stage) {
  return {
    stage,
    message: error?.message ?? String(error),
    code: error?.code ?? null,
  };
}

/**
 * Try to truncate the WAL without waiting for an external reader. This is a
 * diagnostic operation: a busy reader or any SQLite error must never fail sync.
 * @param {import("node:sqlite").DatabaseSync | null | undefined} database
 */
export function checkpointUsageStore(database) {
  const started = performance.now();
  /** @type {{mode: string, busy: number | null, log: number | null, checkpointed: number | null, elapsedMs: number, error: {stage: string, message: string, code: string | null} | null, restoreError?: {stage: string, message: string, code: string | null}}} */
  const result = {
    mode: "truncate",
    busy: null,
    log: null,
    checkpointed: null,
    elapsedMs: 0,
    error: null,
  };
  let previousTimeout = null;
  try {
    if (!database || typeof database.prepare !== "function" || typeof database.exec !== "function") {
      throw new Error("checkpoint requires an open SQLite connection");
    }
    const row = database.prepare("PRAGMA busy_timeout").get();
    const timeout = Number(row?.timeout);
    if (!Number.isSafeInteger(timeout) || timeout < 0) {
      throw new Error(`invalid busy_timeout: ${String(row?.timeout)}`);
    }
    previousTimeout = timeout;
    database.exec("PRAGMA busy_timeout = 0");
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    result.busy = Number(checkpoint?.busy ?? 0);
    result.log = Number(checkpoint?.log ?? -1);
    result.checkpointed = Number(checkpoint?.checkpointed ?? -1);
  } catch (error) {
    result.error = diagnosticError(error, "checkpoint");
  } finally {
    if (previousTimeout !== null) {
      try {
        database.exec(`PRAGMA busy_timeout = ${previousTimeout}`);
      } catch (error) {
        const restoreError = diagnosticError(error, "restore-busy-timeout");
        if (result.error) result.restoreError = restoreError;
        else result.error = restoreError;
      }
    }
    result.elapsedMs = Math.max(0, Math.round((performance.now() - started) * 1000) / 1000);
  }
  return result;
}

/**
 * @param {{sync: (args: any) => Promise<any>, perfState: () => {sourceWarnings: Array<{sourceKind: string, code: string}>}}} store
 * @param {any} options
 */
export async function syncUsageStore(store, options) {
  const status = await store.sync({ options });
  const warnings = store.perfState().sourceWarnings;
  // A concurrent append can spoil one window; revalidate once before publishing its failure.
  if (warnings.length > 0 && warnings.every((w) => w.sourceKind === "codex" && w.code === "LIVE_SOURCE_CHANGED")) {
    return store.sync({ options });
  }
  return status;
}

function historyArchiveStatusError(code, message) {
  /** @type {Error & { code?: string }} */
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseHistoryArchiveAuthority(value, registeredSegmentIds) {
  if (value === undefined) return null;
  let authority;
  try {
    authority = JSON.parse(String(value));
  } catch {
    throw historyArchiveStatusError(
      "HISTORY_ARCHIVE_AUTHORITY_INVALID",
      "history archive event authority is not valid JSON",
    );
  }
  if (
    !authority ||
    typeof authority !== "object" ||
    Array.isArray(authority) ||
    Object.keys(authority).sort().join(",") !== "formatVersion,segmentIds" ||
    authority.formatVersion !== 1 ||
    !Array.isArray(authority.segmentIds) ||
    authority.segmentIds.some((segmentId) => typeof segmentId !== "string" || !/^[a-f0-9]{64}$/.test(segmentId)) ||
    new Set(authority.segmentIds).size !== authority.segmentIds.length
  ) {
    throw historyArchiveStatusError(
      "HISTORY_ARCHIVE_AUTHORITY_INVALID",
      "history archive event authority must be a version-1 unique segment id list",
    );
  }
  for (const segmentId of authority.segmentIds) {
    if (!registeredSegmentIds.has(segmentId)) {
      throw historyArchiveStatusError(
        "HISTORY_ARCHIVE_AUTHORITY_INVALID",
        `history archive authority references unregistered segment ${segmentId}`,
      );
    }
  }
  return authority;
}

async function historyArchiveFileStatus(databasePath) {
  try {
    return (await stat(databasePath)).isFile() ? "present" : "unreadable";
  } catch (error) {
    return error?.code === "ENOENT" || error?.code === "ENOTDIR" ? "missing" : "unreadable";
  }
}

/**
 * Read the registered archive inventory without verifying segment contents.
 * @param {{open: () => Promise<unknown>, database: import("node:sqlite").DatabaseSync}} store
 */
export async function readHistoryArchiveStatus(store) {
  try {
    await store.open();
  } catch (error) {
    throw historyArchiveStatusError(
      "HISTORY_ARCHIVES_UNAVAILABLE",
      `history archives are unavailable: ${error?.message ?? String(error)}`,
    );
  }

  let records;
  let authorityValue;
  try {
    records = store.database
      .prepare(
        `SELECT segment_id, database_path, start_ms, end_ms, event_count
         FROM archive_segments ORDER BY start_ms, segment_id`,
      )
      .all();
    authorityValue = store.database
      .prepare("SELECT value FROM store_meta WHERE key = ?")
      .get("history_archive_event_authority")?.value;
  } catch (error) {
    throw historyArchiveStatusError(
      "HISTORY_ARCHIVES_UNAVAILABLE",
      `history archive registry is unavailable: ${error?.message ?? String(error)}`,
    );
  }

  const registeredSegmentIds = new Set(records.map((record) => String(record.segment_id)));
  const authority = parseHistoryArchiveAuthority(authorityValue, registeredSegmentIds);
  const segments = await Promise.all(
    records.map(async (record) => ({
      segmentId: String(record.segment_id),
      startMs: Number(record.start_ms),
      endMs: Number(record.end_ms),
      eventCount: Number(record.event_count),
      status: await historyArchiveFileStatus(String(record.database_path)),
    })),
  );
  return {
    authority,
    segments,
    counts: {
      segments: segments.length,
      events: segments.reduce((sum, segment) => sum + segment.eventCount, 0),
    },
  };
}

/**
 * Aggregate one sealed archive segment by UTC calendar day without merging hot facts.
 * @param {{readHistoryArchiveEvents: (segmentId: string) => Promise<Array<Record<string, unknown>>>}} store
 * @param {string} segmentId
 */
export async function readHistoryArchiveDays(store, segmentId) {
  const rows = await store.readHistoryArchiveEvents(segmentId);
  const days = new Map();
  for (const row of rows) {
    const dayKey = new Date(Number(row.timestamp_ms)).toISOString().slice(0, 10);
    const day = days.get(dayKey) || {
      day: dayKey,
      eventCount: 0,
      totals: { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 },
    };
    day.eventCount += 1;
    day.totals.total += Number(row.total);
    day.totals.input += Number(row.input);
    day.totals.cached += Number(row.cached);
    day.totals.output += Number(row.output);
    day.totals.reasoning += Number(row.reasoning);
    days.set(dayKey, day);
  }
  return {
    segmentId,
    calendarZone: "utc",
    view: "sealed",
    days: [...days.values()].sort((left, right) => left.day.localeCompare(right.day)),
  };
}

// ---------------------------------------------------------------------------
// 执行器侧（worker）
// ---------------------------------------------------------------------------
if (!isMainThread && parentPort) {
  const store = new UsageStore(workerData.options);
  let storeStatus = null;
  let publishedStore = null;
  let publishedStatus = null;
  let publishedReady = Promise.resolve();
  let lastCheckpoint = null;
  let syncBackupTail = Promise.resolve();

  const postState = ({ includeHomes = false } = {}) => {
    const perf = store.perfPublicationState();
    parentPort.postMessage({
      type: "state",
      state: toWire({
        status: storeStatus,
        metadata: store.metadata(),
        checkedAt: store.checkedAt ?? storeStatus?.checkedAt ?? null,
        perfIndexVersion: perf.indexVersion,
        perfTimingRevision: perf.timingRevision,
        magpieTimingFingerprint: perf.magpieTimingFingerprint,
        lastCheckpoint,
        ...(includeHomes
          ? {
              homes: store.homes,
              warnings: [...store.warnings],
              serviceTierEvidence: serviceTierEvidenceForWire(store.serviceTierEvidence),
            }
          : {}),
      }),
    });
  };

  const postCheckpointDiagnostic = () => {
    try {
      parentPort.postMessage({ type: "state", state: toWire({ lastCheckpoint }) });
    } catch {
      // A diagnostic must never replace the original sync failure.
    }
  };

  const releasePublishedReader = () => {
    const reader = publishedStore;
    publishedStore = null;
    publishedStatus = null;
    if (!reader) return null;
    let cleanupError = null;
    try {
      reader.database.exec("ROLLBACK");
    } catch (error) {
      cleanupError = error;
    }
    try {
      reader.close();
    } catch (error) {
      cleanupError ??= error;
    }
    return cleanupError;
  };

  const serializeSyncBackup = (operation) => {
    const result = syncBackupTail.then(operation);
    // A failed operation must not poison later sync/backup requests.
    syncBackupTail = result.then(
      () => {},
      () => {},
    );
    return result;
  };

  const handle = async (message) => {
    switch (message.type) {
      case "open": {
        applyPricingCatalog(message.pricing);
        await store.open();
        if (message.imported) {
          store.serviceTierEvidence =
            message.serviceTierEvidence === null ? null : serviceTierEvidenceFromSnapshot(message.serviceTierEvidence);
          const report = await store.publishedHistoryUsageReport();
          store.homes = report.homes;
          store.checkedAt = new Date().toISOString();
          storeStatus = {
            fingerprint: store.fingerprint,
            generatedAt: store.generatedAt,
            checkedAt: store.checkedAt,
            missingSources: store.perfState().missingSources,
            magpieTimingFingerprint: store.perfPublicationState().magpieTimingFingerprint,
          };
        }
        postState({ includeHomes: true });
        return message.imported ? storeStatus : { opened: true };
      }
      case "sync": {
        // WAL readers can keep the last committed view without copying the database.
        publishedReady = (async () => {
          if (!storeStatus) return;
          const reader = new UsageStore({ databaseFile: store.databaseFile });
          try {
            await reader.open();
            reader.homes = structuredClone(store.homes);
            reader.warnings = [...store.warnings];
            reader.serviceTierEvidence = store.serviceTierEvidence;
            reader.database.exec("BEGIN");
            reader.database.prepare("SELECT id FROM events LIMIT 1").get();
            publishedStore = reader;
            publishedStatus = storeStatus;
          } catch (error) {
            reader.close();
            throw error;
          }
        })();
        let nextStatus;
        let failure = null;
        try {
          await publishedReady;
          nextStatus = await syncUsageStore(store, message.options);
        } catch (error) {
          failure = error;
        } finally {
          const readerError = releasePublishedReader();
          lastCheckpoint = checkpointUsageStore(store.database);
          publishedReady = Promise.resolve();
          if (!failure && readerError) failure = readerError;
        }
        if (failure) {
          postCheckpointDiagnostic();
          throw failure;
        }
        storeStatus = nextStatus;
        postState({ includeHomes: true });
        return storeStatus;
      }
      case "publishedUsageEvents": {
        return store.publishedUsageEvents();
      }
      case "publishedUsageReport": {
        return store.publishedHistoryUsageReport();
      }
      case "perfPublicationState": {
        await store.open();
        return store.perfPublicationState();
      }
      case "dashboard": {
        applyPricingCatalog(message.pricing);
        await publishedReady;
        const reader = publishedStore || store;
        const published = publishedStore ? publishedStatus : storeStatus;
        const status = published && {
          ...published,
          magpieTimingFingerprint: reader.perfPublicationState().magpieTimingFingerprint,
        };
        const filters = { ...(message.filters ?? {}) };
        const pricingModels = filters.pricingModels ?? getPricingCatalog().models;
        filters.pricingModels = pricingModels;
        if (filters.now !== undefined) filters.now = new Date(filters.now);
        const dashboard = await reader.dashboardHistory(filters, message.options ?? {});
        return {
          status,
          ...dashboard,
          pricingCatalog: getPricingCatalog(),
        };
      }
      case "summarize": {
        applyPricingCatalog(message.pricing);
        // `now`/`asOf` 在主线程是 `Date`，跨线程只能传字符串 ⇒ 这里显式复活成 `Date`
        // （否则 `summarize`/`periodComparison` 会拿到字符串，配额窗口/周期语义随之改变）。
        const filters = { ...(message.filters ?? {}) };
        filters.pricingModels ??= getPricingCatalog().models;
        if (filters.now !== undefined && !(filters.now instanceof Date)) filters.now = new Date(filters.now);
        return store.summarizeHistory(filters, message.options ?? {});
      }
      case "periodComparison": {
        applyPricingCatalog(message.pricing);
        const args = { ...(message.args ?? {}) };
        args.pricingModels ??= getPricingCatalog().models;
        if (args.now !== undefined && !(args.now instanceof Date)) args.now = new Date(args.now);
        return store.periodComparisonHistory(args);
      }
      case "metadata": {
        // 读侧时点：**必须**按调用方给的 `asOf` 现算，并包含已授权的冷事实。
        return store.metadataHistory(message.asOf ? new Date(message.asOf) : new Date());
      }
      case "snapshot": {
        // 用户主动 freeze：备份在**执行器内**完成（主线程不再持有连接做备份）。
        // `id`/`asOf`/`snapshots.set(...)` 是主线程簿记，这里只返回绑定该 `asOf` 的读侧状态。
        applyPricingCatalog(message.pricing);
        const pricingCatalog = getPricingCatalog();
        const asOf = message.asOf ? new Date(message.asOf) : new Date();
        const cleanupDirectory = `${message.databaseFile}.segments`;
        const cleanupDirectoryExisted = existsSync(cleanupDirectory);
        const databaseFileExisted = existsSync(message.databaseFile);
        let snapshotStore = null;
        let staged = false;
        try {
          await backup(store.database, message.databaseFile);
          snapshotStore = new UsageStore({ databaseFile: message.databaseFile });
          await snapshotStore.open();
          const hasSegments =
            Number(snapshotStore.database.prepare("SELECT COUNT(*) AS count FROM archive_segments").get().count) > 0;
          if (hasSegments) {
            // Cold readers must not depend on the live archive paths after freeze.
            const segments = await stageHistoryArchiveSegments(snapshotStore.database, cleanupDirectory);
            staged = true;
            snapshotStore.database.exec("BEGIN IMMEDIATE");
            try {
              const update = snapshotStore.database.prepare(
                "UPDATE archive_segments SET database_path = ? WHERE segment_id = ?",
              );
              for (const segment of segments.segments) {
                update.run(path.resolve(cleanupDirectory, segment.databaseFile), segment.segmentId);
              }
              snapshotStore.database.exec("COMMIT");
            } catch (error) {
              snapshotStore.database.exec("ROLLBACK");
              throw error;
            }
          }
          snapshotStore.homes = structuredClone(store.homes);
          snapshotStore.warnings = [...store.warnings];
          snapshotStore.serviceTierEvidence = store.serviceTierEvidence;
          const metadata = await snapshotStore.metadataHistory(asOf);
          postState({ includeHomes: true });
          return {
            status: storeStatus && {
              ...storeStatus,
              magpieTimingFingerprint: snapshotStore.perfPublicationState().magpieTimingFingerprint,
            },
            asOf: asOf.getTime(),
            metadata,
            homes: store.homes,
            warnings: [...store.warnings],
            serviceTierEvidence: serviceTierEvidenceForWire(store.serviceTierEvidence),
            pricingCatalog,
            checkedAt: store.checkedAt ?? storeStatus?.checkedAt ?? null,
            ...(staged ? { cleanupDirectory } : {}),
          };
        } catch (error) {
          snapshotStore?.close();
          snapshotStore = null;
          if (staged && !cleanupDirectoryExisted) {
            await rm(cleanupDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
          }
          if (!databaseFileExisted) {
            for (const file of [message.databaseFile, `${message.databaseFile}-wal`, `${message.databaseFile}-shm`]) {
              await rm(file, { force: true, maxRetries: 10, retryDelay: 50 });
            }
          }
          throw error;
        } finally {
          snapshotStore?.close();
        }
      }
      case "backupHistory": {
        applyPricingCatalog(message.pricing);
        const manifest = await createHistoryBackup(store.database, message.databaseFile, {
          serviceTierEvidence: store.serviceTierEvidence,
        });
        postState({ includeHomes: true });
        return manifest;
      }
      case "rebuildHistoryRollups": {
        await store.rebuildHistoryRollups();
        postState();
        return { rebuilt: true };
      }
      case "historyArchives": {
        return readHistoryArchiveStatus(store);
      }
      case "historyArchiveDays": {
        return readHistoryArchiveDays(store, message.segmentId);
      }
      case "historyArchiveEventPage": {
        return store.readHistoryArchiveEventPage(message.segmentId, message.page);
      }
      case "historyArchiveEventCommit": {
        const result = await store.commitHistoryArchiveEvents(message.plan);
        postState();
        return result;
      }
      case "historyArchiveImport": {
        const imported = await publishHistoryArchiveImport(message.sourceDirectory, message.importDirectory);
        return {
          runtimeFile: imported.runtimeFile,
          bundleDirectory: imported.bundleDirectory,
          markerFile: imported.markerFile,
          marker: imported.marker,
        };
      }
      case "close": {
        store.close();
        return { closed: true };
      }
      default:
        throw executorError(new Error(`unsupported executor message: ${String(message.type)}`), "EXECUTOR_BAD_MESSAGE");
    }
  };

  parentPort.on("message", (message) => {
    void (async () => {
      try {
        applyPricingCatalog(message.pricing);
        const priceScoped =
          message.type === "open" ||
          message.type === "dashboard" ||
          message.type === "summarize" ||
          message.type === "periodComparison" ||
          message.type === "snapshot" ||
          message.type === "backupHistory";
        const execute = () =>
          priceScoped ? runWithPricingCatalog(message.pricing, () => handle(message)) : handle(message);
        const result =
          message.type === "sync" ||
          message.type === "backupHistory" ||
          message.type === "snapshot" ||
          message.type === "rebuildHistoryRollups" ||
          message.type === "historyArchiveDays" ||
          message.type === "historyArchiveEventPage" ||
          message.type === "historyArchiveEventCommit" ||
          message.type === "historyArchiveImport" ||
          message.type === "publishedUsageEvents" ||
          message.type === "publishedUsageReport" ||
          message.type === "perfPublicationState" ||
          message.type === "close"
            ? await serializeSyncBackup(execute)
            : await execute();
        parentPort.postMessage({ type: "response", id: message.id, ok: true, result: toWire(result) });
        if (message.type === "close") {
          // 先让响应出队，再关闭端口让 worker **自然退出**（显式 `process.exit` 会在 Windows 上
          // 触发 libuv `UV_HANDLE_CLOSING` 断言）。
          setImmediate(() => parentPort.close());
        }
      } catch (error) {
        parentPort.postMessage({
          type: "response",
          id: message.id,
          ok: false,
          error: {
            message: error?.message ?? String(error),
            code: error?.code ?? "EXECUTOR_ERROR",
            statusCode: error?.statusCode ?? null,
            quota: error?.quota ?? null,
          },
        });
      }
    })();
  });
  parentPort.postMessage({ type: "ready" });
}

// ---------------------------------------------------------------------------
// 主线程侧（客户端）
// ---------------------------------------------------------------------------
/**
 * 建立唯一执行器，返回与 `UsageStore` **同名最小面**的客户端：
 * 读侧同步方法（`metadata`/`homes`/`warnings`/`serviceTierEvidence`/`checkedAt`）读**已发布快照**；
 * 阻塞方法（`sync`/`summarize`/`periodComparison`/`snapshot`/`backupHistory`/`rebuildHistoryRollups`）
 * 走消息，返回 Promise。
 */
export function createUsageExecutor(
  options = {},
  { requestTimeoutMs = REQUEST_TIMEOUT_MS, pricing = getPricingCatalog } = {},
) {
  const workerOptions = { workerData: { options: executorOptions(options) } };
  const emptyState = () => ({
    status: null,
    metadata: null,
    homes: null,
    warnings: [],
    serviceTierEvidence: null,
    checkedAt: null,
    perfIndexVersion: "",
    perfTimingRevision: "",
    magpieTimingFingerprint: "",
    lastCheckpoint: null,
  });
  let worker = null;
  let exitResolve = null;
  let exitPromise = Promise.resolve();
  let nextId = 1;
  const pending = new Map();
  /** 用户已显式 `close()` ⇒ **永久**不可用（不再重启）。 */
  let closed = false;
  /** 正在 `close()`（幂等；期间不重启）。 */
  let closing = false;
  let closePromise = null;
  let ready = false;
  /** 硬崩溃后的**就地重启**次数（一次重启 = 一次恢复；不做无限重试）。 */
  let restarts = 0;
  let state = emptyState();

  const rejectAll = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  /**
   * 拉起执行器线程（首次与**崩溃重启**共用）。重启时读侧快照归零：崩溃不得留下
   * 半发布/陈旧可见状态；发布本身也是单条 `state` 消息 ⇒ 已发布的一定是完整快照。
   */
  function spawn() {
    ready = false;
    state = emptyState();
    exitPromise = new Promise((resolve) => {
      exitResolve = resolve;
    });
    const created = new Worker(new URL("./usage-executor.js", import.meta.url), workerOptions);
    created.on("message", (message) => {
      if (worker !== created) return;
      if (message.type === "state") {
        state = { ...state, ...restoreServiceTierEvidenceRecord(message.state) };
        return;
      }
      if (message.type === "ready") {
        ready = true;
        return;
      }
      if (message.type === "response") {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok) {
          entry.resolve(entry.type === "snapshot" ? restoreServiceTierEvidenceRecord(message.result) : message.result);
        } else entry.reject(executorError(message.error, message.error?.code));
      }
    });
    created.on("error", (error) => {
      if (worker !== created) return;
      // `error` 后必然跟一个 `exit`：在途请求统一在 exit 处按可重试错误结算。
      rejectAll(executorError(error, "EXECUTOR_EXITED"));
    });
    created.on("exit", () => {
      if (worker !== created) return;
      worker = null;
      ready = false;
      exitResolve?.();
      exitResolve = null;
      rejectAll(executorError(new Error("usage executor exited"), "EXECUTOR_EXITED"));
      if (!closed) {
        // **硬崩溃**（不是用户 close）⇒ 清空可见状态，等**下一个请求**就地重启。
        state = emptyState();
      }
    });
    worker = created;
    return created;
  }

  spawn();

  const request = (type, payload = {}, { allowClosing = false } = {}) =>
    new Promise((resolve, reject) => {
      if (closed || (closing && !allowClosing)) {
        reject(executorError(new Error("usage executor is not available"), "EXECUTOR_UNAVAILABLE"));
        return;
      }
      if (!worker) {
        // **最小崩溃重启**：崩溃后的**下一个请求**就地拉起新执行器（一次尝试，不做无限重试）。
        restarts += 1;
        spawn();
      }
      const target = worker;
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(executorError(new Error(`usage executor request timed out: ${type}`), "EXECUTOR_TIMEOUT"));
      }, requestTimeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer, type });
      try {
        target.postMessage({ ...toTransferable({ type, id, ...payload }) });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(executorError(error, "EXECUTOR_UNAVAILABLE"));
      }
    });

  return {
    // —— 阻塞工作（消息） ——
    open: (payload = {}) => request("open", payload),
    sync: (payload = {}) => request("sync", { options: payload.options }),
    summarize: (filters = {}, summarizeOptions = {}) =>
      request("summarize", { filters, options: summarizeOptions, pricing: pricing() }),
    dashboard: (filters = {}, summarizeOptions = {}) =>
      request("dashboard", { filters, options: summarizeOptions, pricing: pricing() }),
    periodComparison: (args = {}) => request("periodComparison", { args, pricing: pricing() }),
    metadataFor: (asOf) => request("metadata", { asOf: asOf instanceof Date ? asOf.getTime() : asOf }),
    publishedUsageEvents: () => request("publishedUsageEvents"),
    publishedUsageReport: () => request("publishedUsageReport"),
    perfPublicationState: () => request("perfPublicationState"),
    snapshot: (payload = {}) => request("snapshot", { ...payload, pricing: pricing() }),
    backupHistory: (databaseFile) => request("backupHistory", { databaseFile, pricing: pricing() }),
    rebuildHistoryRollups: () => request("rebuildHistoryRollups"),
    historyArchives: () => request("historyArchives"),
    historyArchiveDays: (segmentId) => request("historyArchiveDays", { segmentId }),
    /** @param {string} segmentId @param {{startMs: number, endMs: number, afterId?: number, limit?: number}} page */
    historyArchiveEventPage: (segmentId, page) => request("historyArchiveEventPage", { segmentId, page }),
    /** @param {Record<string, any>} plan */
    commitHistoryArchiveEvents: (plan) => request("historyArchiveEventCommit", { plan }),
    /** @param {{ sourceDirectory?: string, importDirectory?: string }} [payload] */
    historyArchiveImport: ({ sourceDirectory, importDirectory } = {}) =>
      request("historyArchiveImport", { sourceDirectory, importDirectory }),
    close: () => {
      // 幂等：多次 `close()` 共享同一个 promise；`close()` 之后**永不**重启。
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        const target = worker;
        let closedCleanly = false;
        if (target) {
          const done = request("close", {}, { allowClosing: true }).then(
            () => {
              closedCleanly = true;
            },
            () => {},
          );
          await Promise.race([done, new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS))]);
          // 关闭期间崩溃 / 超时 ⇒ 强制终止（**仍要落定**，绝不让 `close()` 挂死）。
          if (!closedCleanly && worker === target) {
            try {
              await target.terminate();
            } catch {
              /* 已退出 */
            }
          }
        }
        // 等执行器真正退出：数据库连接释放后调用方才能安全删除库文件（Windows EBUSY）。
        await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS))]);
        closed = true;
        rejectAll(executorError(new Error("usage executor closed"), "EXECUTOR_CLOSED"));
      })();
      return closePromise;
    },
    /**
     * **仅故障注入/诊断**：强制终止当前执行器线程（模拟硬崩溃，例如外部 kill 或线程内致命错误）。
     * 产品路径不需要它；它让"崩溃→在途可重试→下一个请求恢复"可被确定性测试。
     */
    crashWorkerForTest: () => {
      const target = worker;
      if (!target) return Promise.resolve(false);
      return target.terminate().then(
        () => true,
        () => true,
      );
    },
    // —— 读侧快照（主线程就地应答；不碰库） ——
    get status() {
      return state.status;
    },
    get checkedAt() {
      return state.checkedAt;
    },
    get perfIndexVersion() {
      return state.perfIndexVersion;
    },
    get perfTimingRevision() {
      return state.perfTimingRevision;
    },
    get magpieTimingFingerprint() {
      return state.magpieTimingFingerprint;
    },
    get lastCheckpoint() {
      return state.lastCheckpoint;
    },
    get homes() {
      return state.homes ?? [];
    },
    get warnings() {
      return state.warnings ?? [];
    },
    get serviceTierEvidence() {
      return state.serviceTierEvidence;
    },
    get ready() {
      return ready;
    },
    /** 执行器线程是否**活着**（崩溃后未重启 ⇒ false；`close()` 后 ⇒ false）。 */
    get alive() {
      return Boolean(worker) && !closed;
    },
    /** 崩溃就地重启次数（0 = 未发生过硬崩溃）。 */
    get restarts() {
      return restarts;
    },
    metadata: () => state.metadata,
    get state() {
      return state;
    },
  };
}
