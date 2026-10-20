import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import v8 from "node:v8";

import {
  buildUsageFingerprint,
  buildUsageReport,
  classifyImportDirectory,
  isQuotaPreset,
  selectQuotaWindows,
  summarizePeriodComparison,
  summarizeUsage,
  toPublicUsageReport,
  USAGE_PRESETS,
} from "./usage-core.js";
import { UsageStore } from "./usage-store.js";
import { createUsageExecutor } from "./usage-executor.js";
import { loadServiceTierEvidence } from "./service-tier-evidence.js";
import { buildUsagePricingCoverage } from "../public/pricing-models.js";
import { AUTO_RETRY_INTERVAL_MS } from "./pricing-auto.js";
import { getPricingCatalog, pricingVersionForTimestamp, validatePricingCatalog } from "./pricing.js";
import {
  getAutomaticPricingStatus,
  loadPricingFile,
  MAX_PRICING_MODELS,
  refreshAutomaticPricing,
  savePricingFile,
} from "./pricing-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const MIN_FULL_DETAIL_HEAP_BYTES = 512 * 1024 * 1024;
const DEFAULT_IMPORT_STORE_FILE = path.join(os.homedir(), ".codex-usage", "imports.json");
const execFileAsync = promisify(execFile);

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
  // Character skin display copies are committed WebP (implementation plan 3.4).
  [".webp", "image/webp"],
]);

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function isValidDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function requestFilters(url) {
  const preset = url.searchParams.get("preset") || "all";
  const requestedBucket = url.searchParams.get("bucket") || "day";
  const recentValue = url.searchParams.get("recentValue") || "";
  const recentBucket =
    preset === "recent"
      ? { 上一个5h: "quota_30m", 上周: "quota_24h", 上个月: "day", 今年: "month" }[recentValue]
      : null;
  if (!USAGE_PRESETS.includes(preset)) {
    throw httpError(400, `Invalid preset: ${preset}.`, "INVALID_PRESET");
  }
  const bucket = isQuotaPreset(preset)
    ? preset === "quota_5h"
      ? "quota_30m"
      : "quota_24h"
    : recentBucket || requestedBucket;
  const startDate = url.searchParams.get("startDate") || "";
  const endDate = url.searchParams.get("endDate") || "";
  const calendarZone = url.searchParams.get("calendarZone") || "local";
  const excludeHomes = (url.searchParams.get("exclude") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 200);

  if (!isQuotaPreset(preset) && !recentBucket && !["hour", "day", "week", "month"].includes(bucket)) {
    throw httpError(400, "Invalid bucket.", "INVALID_BUCKET");
  }
  if (!["local", "utc"].includes(calendarZone)) {
    throw httpError(400, "Invalid calendar zone.", "INVALID_CALENDAR_ZONE");
  }
  if (preset === "custom") {
    if ((startDate && !isValidDateOnly(startDate)) || (endDate && !isValidDateOnly(endDate))) {
      throw httpError(400, "Invalid custom date.", "INVALID_DATE");
    }
    if (startDate && endDate && startDate > endDate) {
      throw httpError(400, "Start date must not be after end date.", "INVALID_DATE_RANGE");
    }
  }
  return { preset, bucket, startDate, endDate, recentValue, excludeHomes, calendarZone };
}

/**
 * M4.3：把来源排除**同时**作用到公开报告的三段（`events`/`sessions`）与**内部候选载体**
 *（`perfSamples`）。导出以便直接对本函数做定向变异（只看黑盒响应无法区分"这一层过滤"
 * 与"下游 `summarizePerf` 的排除参数"—— 两者对计数等价）。
 */
export function withoutExcludedHomes(report, excludeHomes = []) {
  const excluded = new Set(excludeHomes.map(String));
  if (!excluded.size) {
    return report;
  }
  return {
    ...report,
    events: report.events.filter((event) => !excluded.has(String(event.homeId))),
    sessions: report.sessions.filter((session) => !excluded.has(String(session.homeId))),
    // M4.3（卡片明文）：来源排除必须**同时**作用于内部 `perfSamples`，否则内存路径
    //（`detail=full`）与索引路径对同一个 `exclude=` 会算出不同的 `summary.perf`。
    perfSamples: report.perfSamples?.filter((sample) => !excluded.has(String(sample.homeId))),
  };
}

export function isFullDetailHeapAvailable(heapSizeLimitBytes = v8.getHeapStatistics().heap_size_limit) {
  return heapSizeLimitBytes >= MIN_FULL_DETAIL_HEAP_BYTES;
}

function configuredImportDirs(options = {}) {
  if (Array.isArray(options.importDirs)) {
    return options.importDirs;
  }
  if (typeof options.importDirs === "string") {
    return options.importDirs.split(path.delimiter).filter(Boolean);
  }
  return [];
}

function importStoreFile(options = {}) {
  return options.importStoreFile || DEFAULT_IMPORT_STORE_FILE;
}

function normalizeImportEntries(entries = []) {
  const seen = new Set();
  const normalized = [];
  for (const entry of entries) {
    const rawPath = typeof entry === "string" ? entry : entry?.path;
    if (!rawPath) {
      continue;
    }
    const resolved = path.resolve(rawPath);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    normalized.push({ path: resolved });
  }
  return normalized;
}

async function readImportEntries(options = {}) {
  try {
    const text = await readFile(importStoreFile(options), "utf8");
    const parsed = JSON.parse(text);
    return normalizeImportEntries(Array.isArray(parsed) ? parsed : parsed.imports);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeImportEntries(options, entries) {
  const filePath = importStoreFile(options);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify({ imports: normalizeImportEntries(entries) }, null, 2)}\n`);
}

export async function describeImportEntry(importPath) {
  const classified = await classifyImportDirectory(importPath);
  if (classified.type === "unsupported") {
    return classified;
  }
  const name = path.basename(classified.path) || classified.path;
  const label =
    classified.type === "project-log"
      ? `Project ${name}`
      : classified.type === "zcode-home"
        ? `ZCode ${name}`
        : classified.type === "dsh-home"
          ? `DSH ${name}`
          : classified.type === "opencode-home"
            ? `OpenCode ${name}`
            : classified.type === "claude-home"
              ? `Claude Code ${name}`
              : `Imported ${name}`;
  return {
    type: classified.type,
    path: classified.path,
    label,
    ...(classified.usageLogPath ? { usageLogPath: classified.usageLogPath } : {}),
    ...(classified.dbFile ? { dbFile: classified.dbFile } : {}),
  };
}

async function listImportEntries(options = {}) {
  const storedEntries = await readImportEntries(options);
  const described = [];
  for (const entry of storedEntries) {
    described.push(await describeImportEntry(entry.path));
  }
  return described;
}

async function usageOptions(options = {}) {
  const storedEntries = await readImportEntries(options);
  const importDirs = [...configuredImportDirs(options), ...storedEntries.map((entry) => entry.path)];
  return { ...options, importDirs };
}

function clientFingerprint(sourceFingerprint) {
  return createHash("sha256").update(sourceFingerprint).update("\0").update(pricingVersionForTimestamp()).digest("hex");
}

function httpError(statusCode, message, code) {
  /** @type {Error & { statusCode?: number, code?: string }} */
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

export async function readJsonBody(request, { maxBytes = 16_384 } = {}) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.length;
    if (byteLength > maxBytes) {
      throw httpError(413, "Request body too large");
    }
    chunks.push(buffer);
  }
  if (!byteLength) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw httpError(400, "Request body must be a JSON object.");
    }
    return body;
  } catch (error) {
    if (error.statusCode) throw error;
    throw httpError(400, "Invalid JSON request body.");
  }
}

async function pickDirectoryWithSystemDialog() {
  // The browser cannot expose absolute local paths, so the local server opens
  // the native macOS folder picker and returns only the selected path.
  if (process.platform !== "darwin") {
    throw new Error("Directory picker is only available on macOS; enter the path manually.");
  }

  try {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'POSIX path of (choose folder with prompt "选择要导入的 Agent Usage 目录")',
    ]);
    return stdout.trim();
  } catch (error) {
    if (error.code === 1 && String(error.stderr || "").includes("-128")) {
      return "";
    }
    throw error;
  }
}

function pickDirectory(options = {}) {
  // Tests and future desktop shells can inject a picker without changing routes.
  return options.pickDirectory ? options.pickDirectory() : pickDirectoryWithSystemDialog();
}

async function serveStatic(requestPath, response) {
  const normalized = requestPath === "/" ? "/index.html" : requestPath;
  let decoded;
  try {
    decoded = decodeURIComponent(normalized);
  } catch {
    sendText(response, 400, "Bad request");
    return;
  }
  const filePath = path.resolve(PUBLIC_DIR, `.${decoded}`);
  const relativePath = path.relative(PUBLIC_DIR, filePath);
  if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": MIME_TYPES.get(path.extname(filePath)) || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    sendText(response, 404, "Not found");
  }
}

export function createUsageServer(options = {}) {
  // W1：阻塞工作（`sync`/`summarize`/`periodComparison`/`snapshot`）移入**唯一**持有
  // `DatabaseSync` 的执行器；主线程只保留读侧快照与轻量端点（`/api/status` 就地扫 fs）。
  const usageStore = createUsageExecutor(options);
  const pricingReady = loadPricingFile(options);
  let pricingRefreshPromise = null;
  let pricingRefreshOptions = null;
  let pricingRefreshPending = null;
  let storeStatus = null;
  let syncPromise = null;
  let snapshotDirectoryPromise = null;
  let discoveryTimer = null;
  let discoveryTimerSignature = null;
  let activeDiscoverySignature = null;
  let serverClosed = false;
  const snapshots = new Map();

  function usedModelNames(value) {
    const groups = Array.isArray(value)
      ? [value]
      : value && typeof value === "object"
        ? Object.values(value).filter(Array.isArray)
        : [];
    return [
      ...new Set(
        groups
          .flat()
          .map((model) => String(model ?? "").trim())
          .filter(Boolean),
      ),
    ].sort();
  }

  function mergeRefreshOptions(left, right) {
    return {
      force: left.force === true || right.force === true,
      discoveryReady: left.discoveryReady !== false || right.discoveryReady !== false,
      automaticDiscoveryEnabled: options.automaticDiscoveryEnabled !== false,
      usedModels: [...new Set([...usedModelNames(left.usedModels), ...usedModelNames(right.usedModels)])].sort(),
    };
  }

  function requestPricingRefresh(refreshOptions) {
    const normalized = {
      ...refreshOptions,
      automaticDiscoveryEnabled: options.automaticDiscoveryEnabled !== false,
    };
    if (!pricingRefreshPromise) {
      pricingRefreshOptions = normalized;
      pricingRefreshPromise = refreshAutomaticPricing({ ...options, ...normalized }).finally(() => {
        pricingRefreshPromise = null;
        pricingRefreshOptions = null;
      });
      return pricingRefreshPromise;
    }

    const activeOptions = pricingRefreshOptions || {};
    const changedCandidates =
      JSON.stringify(usedModelNames(activeOptions.usedModels)) !==
      JSON.stringify(usedModelNames(normalized.usedModels));
    if (normalized.force || changedCandidates) {
      pricingRefreshPending = pricingRefreshPending
        ? mergeRefreshOptions(pricingRefreshPending, normalized)
        : mergeRefreshOptions(activeOptions, normalized);
      const active = pricingRefreshPromise;
      return active.then((result) => {
        const pending = pricingRefreshPending;
        if (!pending) return result;
        pricingRefreshPending = null;
        return requestPricingRefresh(pending);
      });
    }
    return pricingRefreshPromise;
  }

  function clearDiscoveryTimer() {
    if (discoveryTimer === null) return;
    (options.cancelPricingDiscovery || clearTimeout)(discoveryTimer);
    discoveryTimer = null;
    discoveryTimerSignature = null;
  }

  function scheduleUsageDiscovery(harnessModels) {
    if (serverClosed || options.automaticDiscoveryEnabled === false || storeStatus === null) return;
    const missing = buildUsagePricingCoverage(harnessModels, getPricingCatalog().models, true)
      .missingUsedModels.map((item) => item.model.toLowerCase())
      .sort();
    if (!missing.length) {
      clearDiscoveryTimer();
      return;
    }
    const nowValue =
      typeof options.pricingDiscoveryNow === "function"
        ? options.pricingDiscoveryNow()
        : options.pricingDiscoveryNow || new Date();
    const nowMs = nowValue instanceof Date ? nowValue.getTime() : Date.parse(nowValue);
    const attemptedAt = getAutomaticPricingStatus().discoveryAttemptedAt || {};
    const dueModels = missing.filter((model) => {
      const lastAttempt = Date.parse(attemptedAt[model] || "");
      return !Number.isFinite(lastAttempt) || !Number.isFinite(nowMs) || nowMs - lastAttempt >= AUTO_RETRY_INTERVAL_MS;
    });
    if (!dueModels.length) {
      clearDiscoveryTimer();
      return;
    }

    const signature = JSON.stringify(dueModels);
    if (signature === activeDiscoverySignature || signature === discoveryTimerSignature) return;
    clearDiscoveryTimer();
    discoveryTimerSignature = signature;
    const schedule = options.schedulePricingDiscovery || setTimeout;
    discoveryTimer = schedule(async () => {
      discoveryTimer = null;
      discoveryTimerSignature = null;
      if (serverClosed || storeStatus === null) return;
      activeDiscoverySignature = signature;
      try {
        const models = usageStore.metadata().harnessModels;
        await requestPricingRefresh({ force: false, usedModels: models, discoveryReady: true });
      } catch {
        // A background source or disk failure is returned by the pricing API on its next explicit refresh.
      } finally {
        activeDiscoverySignature = null;
        if (!serverClosed && storeStatus !== null) scheduleUsageDiscovery(usageStore.metadata().harnessModels);
      }
    }, options.pricingDiscoveryDelayMs ?? 1_000);
    discoveryTimer?.unref?.();
  }

  async function createSnapshot({ check = false } = {}) {
    const status = await loadUsageStore({ check });
    snapshotDirectoryPromise ||= mkdtemp(path.join(os.tmpdir(), "codex-usage-snapshot-"));
    const snapshotDirectory = await snapshotDirectoryPromise;
    const id = randomUUID();
    const databaseFile = path.join(snapshotDirectory, `${id}.sqlite`);
    try {
      // `id` / `asOf` / `snapshots.set(...)` 是**纯主线程簿记**（快照句柄与淘汰策略属 HTTP 层）；
      // 连接归执行器独占 ⇒ 备份只能在执行器内做，它返回绑定该 `asOf` 的读侧状态。
      const asOf = new Date();
      const frozen = await usageStore.snapshot({ databaseFile, asOf: asOf.getTime() });
      const store = new UsageStore({ databaseFile });
      await store.open();
      store.homes = structuredClone(frozen.homes ?? []);
      // 证据 resolver 是**类实例**（`resolve()`），过不了跨线程 JSON ⇒ 在冻结副本自己的
      // homes 上重建一份（与执行器 `sync` 时用的是同一个工厂与同一份输入，语义等价）。
      store.serviceTierEvidence = loadServiceTierEvidence(store.homes);
      store.warnings = [...(frozen.warnings ?? [])];
      const snapshot = {
        store,
        status: { ...status, checkedAt: frozen.checkedAt || status.checkedAt },
        asOf,
        metadata: { ...frozen.metadata, imports: await listImportEntries(options) },
        databaseFile,
      };
      snapshots.set(id, snapshot);
      while (snapshots.size > 8) {
        const oldestId = snapshots.keys().next().value;
        const oldest = snapshots.get(oldestId);
        snapshots.delete(oldestId);
        oldest.store.close();
        await rm(oldest.databaseFile, { force: true });
      }
      return { id, ...snapshot };
    } catch (error) {
      await rm(databaseFile, { force: true });
      throw error;
    }
  }

  async function metadataForStore(asOf = new Date()) {
    // The dashboard needs both active scan sources and stored imports that may currently be unsupported.
    // `metadata` 的时点必须**按请求的 `asOf`** 现算（主线程的读侧快照只是"最后一次发布"，忽略时点）。
    return {
      ...(await usageStore.metadataFor(asOf)),
      imports: await listImportEntries(options),
    };
  }

  function usagePricingCoverage(metadata = undefined) {
    if (storeStatus === null && !metadata) return buildUsagePricingCoverage(null, getPricingCatalog().models, false);
    return buildUsagePricingCoverage(
      (metadata || usageStore.metadata()).activeHarnessModels,
      getPricingCatalog().models,
      true,
    );
  }

  async function loadUsageStore({ check = true } = {}) {
    const currentUsageOptions = await usageOptions(options);
    if (!check && storeStatus && usageStore.status) return storeStatus;
    if (syncPromise) {
      return syncPromise;
    }
    if (!syncPromise) {
      syncPromise = usageStore
        .sync({ options: currentUsageOptions })
        .then((status) => {
          storeStatus = status;
          scheduleUsageDiscovery(usageStore.metadata().harnessModels);
          return status;
        })
        .finally(() => {
          syncPromise = null;
        });
    }
    return syncPromise;
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");

    try {
      await pricingReady;
      if (url.pathname === "/api/pricing") {
        if (request.method === "GET") {
          const snapshotId = url.searchParams.get("snapshot");
          const snapshot = snapshotId ? snapshots.get(snapshotId) : null;
          if (snapshotId && !snapshot) throw httpError(410, "Snapshot is no longer available.", "SNAPSHOT_EXPIRED");
          const metadata = snapshot?.metadata || (storeStatus === null ? undefined : usageStore.metadata());
          sendJson(response, 200, {
            ...getPricingCatalog(),
            automatic: getAutomaticPricingStatus(),
            usageCoverage: usagePricingCoverage(metadata),
            modelActivity: metadata
              ? {
                  activeHarnessModels: metadata.activeHarnessModels,
                  modelLastSeen: metadata.modelLastSeen,
                  modelUsageAsOf: metadata.modelUsageAsOf,
                }
              : null,
          });
          return;
        }
        if (request.method === "PUT") {
          let catalog;
          let restoreAutomaticExchangeRate = false;
          try {
            const body = await readJsonBody(request, { maxBytes: 128 * 1024 });
            restoreAutomaticExchangeRate = body.restoreAutomaticExchangeRate === true;
            if (body.version && body.version !== getPricingCatalog().version) {
              throw httpError(
                409,
                "Pricing changed while this editor was open. Reopen it and retry.",
                "PRICING_CHANGED",
              );
            }
            if (
              body.models &&
              typeof body.models === "object" &&
              !Array.isArray(body.models) &&
              Object.keys(body.models).length > MAX_PRICING_MODELS
            ) {
              throw httpError(
                400,
                `Pricing catalog cannot contain more than ${MAX_PRICING_MODELS} models.`,
                "PRICING_CAPACITY",
              );
            }
            catalog = validatePricingCatalog(body);
          } catch (error) {
            throw httpError(error.statusCode || 400, error.message, error.code || "INVALID_PRICING");
          }
          await savePricingFile(options, catalog, {
            restoreAutomaticExchangeRate,
          });
          sendJson(response, 200, getPricingCatalog());
          return;
        }
        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }

      if (url.pathname === "/api/pricing/refresh") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        const body = await readJsonBody(request);
        const discoveryReady = storeStatus !== null;
        const refreshResult = await requestPricingRefresh({
          force: body.force === true,
          usedModels: discoveryReady ? usageStore.metadata().harnessModels : [],
          discoveryReady,
        });
        sendJson(
          response,
          200,
          discoveryReady
            ? refreshResult
            : {
                ...refreshResult,
                discovery: {
                  addedModels: [],
                  results: [{ model: "*", status: "deferred", reason: "usage-not-ready" }],
                },
              },
        );
        return;
      }

      if (url.pathname === "/api/status") {
        const status = await buildUsageFingerprint(await usageOptions(options));
        const since = url.searchParams.get("since") || "";
        sendJson(response, 200, {
          fingerprint: clientFingerprint(status.fingerprint),
          changed: since ? clientFingerprint(status.fingerprint) !== since : true,
          checkedAt: status.checkedAt,
        });
        return;
      }

      if (url.pathname === "/api/imports") {
        if (request.method === "GET") {
          sendJson(response, 200, { imports: await listImportEntries(options) });
          return;
        }

        if (request.method === "POST") {
          const body = await readJsonBody(request);
          if (!body.path) {
            sendJson(response, 400, { code: "MISSING_IMPORT_PATH", error: "Missing import directory path." });
            return;
          }
          const entry = await describeImportEntry(body.path);
          if (entry.type === "unsupported") {
            sendJson(response, 400, {
              code: "INVALID_IMPORT_DIRECTORY",
              error: "reason" in entry ? entry.reason : "Unsupported import directory.",
              path: entry.path,
            });
            return;
          }
          const entries = normalizeImportEntries([...(await readImportEntries(options)), entry]);
          await writeImportEntries(options, entries);
          storeStatus = null;
          sendJson(response, 200, {
            import: entry,
            imports: await listImportEntries(options),
          });
          return;
        }

        if (request.method === "DELETE") {
          const targetPath = path.resolve(url.searchParams.get("path") || "");
          const entries = (await readImportEntries(options)).filter((entry) => entry.path !== targetPath);
          await writeImportEntries(options, entries);
          storeStatus = null;
          sendJson(response, 200, { imports: await listImportEntries(options) });
          return;
        }

        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }

      if (url.pathname === "/internal/shutdown") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }
        if (!options.shutdownToken || request.headers["x-codex-usage-shutdown-token"] !== options.shutdownToken) {
          sendJson(response, 403, { error: "Forbidden" });
          return;
        }
        response.writeHead(202, { "cache-control": "no-store" });
        response.end();
        setImmediate(() => options.onShutdown?.());
        return;
      }

      if (url.pathname === "/api/pick-directory") {
        if (request.method !== "POST") {
          sendJson(response, 405, { error: "Method not allowed" });
          return;
        }

        sendJson(response, 200, { path: await pickDirectory(options) });
        return;
      }

      if (url.pathname === "/api/usage" || url.pathname === "/api/summary") {
        const filters = requestFilters(url);
        const check = url.searchParams.get("skipCheck") !== "1";
        // 已有快照先查找并校验；新快照只在请求组合受支持时创建。
        const requestedSnapshotId = url.searchParams.get("snapshot");
        const requestedFreeze = url.searchParams.get("freeze") === "1";
        let frozen = requestedSnapshotId ? snapshots.get(requestedSnapshotId) : null;
        if (requestedSnapshotId && !frozen) {
          throw httpError(410, "Snapshot is no longer available.", "SNAPSHOT_EXPIRED");
        }
        const wantsFullDetail =
          url.pathname === "/api/usage" && url.searchParams.get("detail") === "full" && !isQuotaPreset(filters.preset);
        const snapshotCoupled = Boolean(frozen) || requestedFreeze;

        if (wantsFullDetail) {
          // M4.3 返工1：`detail=full` 走的是**内存**报告路径（`buildUsageReport`），它读的是当前
          // 文件系统，无法与某个已冻结的 SQLite/`asOf` 对齐。冻结请求**不得**用 live 结果冒充 ⇒
          // 明确拒绝并登记该参数组合（卡片允许"提供同一冻结数据"或"明确拒绝"二选一）。
          // 未知 snapshot 的 410 校验已在上面完成，这里只处理"与冻结组合"。
          if (snapshotCoupled) {
            sendJson(response, 400, {
              code: "SNAPSHOT_FULL_DETAIL_UNSUPPORTED",
              error:
                "detail=full cannot be combined with snapshot= or freeze=1: the full report is built from in-memory sources and cannot be bound to a frozen snapshot.",
            });
            return;
          }
          if (!isFullDetailHeapAvailable()) {
            await loadUsageStore();
            const summary = await usageStore.summarize({ ...filters, now: new Date() });
            sendJson(response, 413, {
              code: "FULL_DETAIL_UNAVAILABLE",
              error:
                "Full detail report is disabled in low-memory gateway mode. Restart with codex-usage gateway --memory-mb 512.",
              quota: summary.quota,
            });
            return;
          }

          const currentUsageOptions = await usageOptions(options);
          const status = await buildUsageFingerprint(currentUsageOptions);
          const fullReport = await buildUsageReport(currentUsageOptions);
          const report = withoutExcludedHomes(fullReport, filters.excludeHomes);
          const asOf = new Date();
          const quota = selectQuotaWindows(fullReport.rateLimitObservations || [], asOf);
          Object.assign(filters, { now: asOf, quota });
          const summary = summarizeUsage(report, filters);
          sendJson(response, 200, {
            fingerprint: clientFingerprint(status.fingerprint),
            checkedAt: status.checkedAt,
            metadata: {
              generatedAt: fullReport.generatedAt,
              eventCount: fullReport.events.length,
              sessionCount: fullReport.sessions.length,
              homeCount: fullReport.homes.length,
              homes: fullReport.homes,
              imports: await listImportEntries(options),
              warnings: fullReport.warnings,
            },
            report: toPublicUsageReport(report),
            summary,
            quota: summary.quota,
            periodComparison: summarizePeriodComparison(report.events, {
              now: asOf,
              calendarZone: filters.calendarZone,
            }),
          });
          return;
        }

        // 拒绝全文组合后再分配名额，避免失败请求创建不可用快照并淘汰旧快照。
        if (!frozen && requestedFreeze) frozen = await createSnapshot({ check });

        // 默认聚合入口与 `/api/summary` 共用同一套冻结选择：冻结时 summary、metadata、quota、
        // periodComparison 与 `asOf` **全部**绑定该冻结 store（不能只冻结 perf、其余字段走 live）。
        const usage = frozen?.status || (await loadUsageStore({ check }));
        const store = frozen?.store || usageStore;
        const asOf = frozen?.asOf || new Date();
        Object.assign(filters, { now: asOf });
        if (!frozen) {
          const result = await usageStore.dashboard(filters, {
            includeDetails: url.pathname !== "/api/usage" || url.searchParams.get("view") !== "dashboard",
          });
          const published = result.status || usage;
          sendJson(response, 200, {
            fingerprint: clientFingerprint(published.fingerprint),
            checkedAt: published.checkedAt,
            snapshotId: requestedSnapshotId || null,
            metadata: { ...result.metadata, imports: await listImportEntries(options) },
            summary: result.summary,
            quota: result.summary.quota,
            periodComparison: result.periodComparison,
          });
          return;
        }
        const summary =
          url.pathname === "/api/usage"
            ? await store.summarize(filters, { includeDetails: url.searchParams.get("view") !== "dashboard" })
            : await store.summarize(filters);
        sendJson(response, 200, {
          fingerprint: clientFingerprint(usage.fingerprint),
          checkedAt: usage.checkedAt,
          snapshotId: frozen?.id || requestedSnapshotId || null,
          metadata: frozen?.metadata || (await metadataForStore(asOf)),
          summary,
          quota: summary.quota,
          periodComparison: await store.periodComparison({
            now: asOf,
            excludeHomes: filters.excludeHomes,
            calendarZone: filters.calendarZone,
          }),
        });
        return;
      }

      await serveStatic(url.pathname, response);
    } catch (error) {
      const statusCode =
        error.statusCode ||
        (error.code === "QUOTA_WINDOW_UNAVAILABLE" ? 409 : error.code === "INVALID_PRESET" ? 400 : 500);
      sendJson(response, statusCode, {
        ...(error.code ? { code: error.code } : {}),
        error: error.message,
        ...(error.quota ? { quota: error.quota } : {}),
        stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
      });
    }
  });
  let executorClosePromise = null;
  function closeUsageExecutor() {
    executorClosePromise ||= Promise.resolve(usageStore.close()).catch(() => {});
    return executorClosePromise;
  }
  server.on("close", () => {
    serverClosed = true;
    clearDiscoveryTimer();
    void closeUsageExecutor();
    for (const snapshot of snapshots.values()) snapshot.store.close();
    snapshots.clear();
    if (snapshotDirectoryPromise) {
      void snapshotDirectoryPromise.then((directory) => rm(directory, { recursive: true, force: true }));
    }
  });
  // W1：执行器独占数据库连接 ⇒ `server.close(cb)` 的回调必须等它**真正退出**再触发，
  // 否则调用方（测试 / CLI）随后删除临时目录会在 Windows 上 EBUSY。
  // W1-b：补**显式 Promise/flush 语义** —— `server.close()`（**无**回调）返回 Promise，且只有在执行器
  // 释放连接之后才 settle，调用方可以直接 `await server.close()` 再删库目录；带回调形式保持兼容
  // （仍返回 `server`，`test/server.test.js` 逐字节不变）。
  const closeHttpServer = server.close.bind(server);
  // `checkJs` 里 `Server#close` 的声明只允许返回 `Server`，而 W1-b 的**无回调**形式**故意**返回 Promise
  // （调用方 `await server.close()`）；用一次 JSDoc 断言保留该契约，**运行期逐字不变**。
  /** @type {(callback?: (err?: Error) => void) => unknown} */
  const closeWithExecutorRelease = (callback) => {
    const done = new Promise((resolve) => closeHttpServer(() => resolve())).then(async () => {
      await closeUsageExecutor();
      // A refresh can start its merged successor in a fulfillment continuation.
      while (pricingRefreshPromise) await pricingRefreshPromise.catch(() => {});
    });
    if (typeof callback === "function") {
      done.then(
        () => callback(),
        () => callback(),
      );
      return server;
    }
    return done;
  };
  server.close = /** @type {typeof server.close} */ (closeWithExecutorRelease);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 3765);
  const host = process.env.HOST || "127.0.0.1";
  const server = createUsageServer();
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`Agent Usage dashboard: http://${host}:${actualPort}`);
  });
}
