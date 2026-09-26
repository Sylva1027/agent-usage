import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { backup } from "node:sqlite";
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
  USAGE_PRESETS,
} from "./usage-core.js";
import { UsageStore } from "./usage-store.js";
import { getPricingCatalog, pricingVersionForTimestamp, setPricingCatalog, validatePricingCatalog } from "./pricing.js";
import { loadPricingFile, savePricingFile } from "./pricing-store.js";

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
  const recentBucket = preset === "recent" ? { "上一个5h": "quota_30m", "上周": "quota_24h", "上个月": "day", "今年": "month" }[recentValue] : null;
  if (!USAGE_PRESETS.includes(preset)) {
    throw httpError(400, `Invalid preset: ${preset}.`, "INVALID_PRESET");
  }
  const bucket = isQuotaPreset(preset)
    ? preset === "quota_5h" ? "quota_30m" : "quota_24h"
    : recentBucket || requestedBucket;
  const startDate = url.searchParams.get("startDate") || "";
  const endDate = url.searchParams.get("endDate") || "";
  const excludeHomes = (url.searchParams.get("exclude") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 200);

  if (!isQuotaPreset(preset) && !recentBucket && !["hour", "day", "week", "month"].includes(bucket)) {
    throw httpError(400, "Invalid bucket.", "INVALID_BUCKET");
  }
  if (preset === "custom") {
    if ((startDate && !isValidDateOnly(startDate)) || (endDate && !isValidDateOnly(endDate))) {
      throw httpError(400, "Invalid custom date.", "INVALID_DATE");
    }
    if (startDate && endDate && startDate > endDate) {
      throw httpError(400, "Start date must not be after end date.", "INVALID_DATE_RANGE");
    }
  }
  return { preset, bucket, startDate, endDate, recentValue, excludeHomes };
}

function withoutExcludedHomes(report, excludeHomes = []) {
  const excluded = new Set(excludeHomes.map(String));
  if (!excluded.size) {
    return report;
  }
  return {
    ...report,
    events: report.events.filter((event) => !excluded.has(String(event.homeId))),
    sessions: report.sessions.filter((session) => !excluded.has(String(session.homeId))),
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
  await writeFile(filePath, JSON.stringify({ imports: normalizeImportEntries(entries) }, null, 2) + "\n");
}

async function describeImportEntry(importPath) {
  const classified = await classifyImportDirectory(importPath);
  if (classified.type === "unsupported") {
    return classified;
  }
  return {
    type: classified.type,
    path: classified.path,
    label:
      classified.type === "project-log"
        ? `Project ${path.basename(classified.path) || classified.path}`
        : classified.type === "zcode-home"
          ? `ZCode ${path.basename(classified.path) || classified.path}`
          : `Imported ${path.basename(classified.path) || classified.path}`,
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
  const usageStore = new UsageStore(options);
  const pricingReady = loadPricingFile(options);
  let storeStatus = null;
  let syncPromise = null;
  let snapshotDirectoryPromise = null;
  const snapshots = new Map();

  async function createSnapshot({ check = false } = {}) {
    const status = await loadUsageStore({ check });
    const snapshotDirectory = await (snapshotDirectoryPromise ||= mkdtemp(path.join(os.tmpdir(), "codex-usage-snapshot-")));
    const id = randomUUID();
    const databaseFile = path.join(snapshotDirectory, `${id}.sqlite`);
    try {
      await backup(usageStore.database, databaseFile);
      const store = new UsageStore({ databaseFile });
      await store.open();
      store.homes = structuredClone(usageStore.homes);
      store.serviceTierEvidence = usageStore.serviceTierEvidence;
      store.warnings = [...usageStore.warnings];
      const snapshot = {
        store,
        status: { ...status, checkedAt: usageStore.checkedAt || status.checkedAt },
        asOf: new Date(),
        metadata: { ...store.metadata(), imports: await listImportEntries(options) },
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

  async function metadataForStore() {
    // The dashboard needs both active scan sources and stored imports that may currently be unsupported.
    return {
      ...usageStore.metadata(),
      imports: await listImportEntries(options),
    };
  }

  async function loadUsageStore({ check = true } = {}) {
    const currentUsageOptions = await usageOptions(options);
    if (syncPromise) {
      return syncPromise;
    }
    if (!check && storeStatus) return storeStatus;
    if (!syncPromise) {
      syncPromise = usageStore
        .sync({ options: currentUsageOptions })
        .then((status) => {
          storeStatus = status;
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
          sendJson(response, 200, getPricingCatalog());
          return;
        }
        if (request.method === "PUT") {
          let catalog;
          try {
            catalog = validatePricingCatalog(await readJsonBody(request, { maxBytes: 128 * 1024 }));
          } catch (error) {
            throw httpError(error.statusCode || 400, error.message, "INVALID_PRICING");
          }
          await savePricingFile(options, catalog);
          sendJson(response, 200, setPricingCatalog(catalog));
          return;
        }
        sendJson(response, 405, { error: "Method not allowed" });
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
            sendJson(response, 400, { code: "INVALID_IMPORT_DIRECTORY", error: entry.reason, path: entry.path });
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

      if (url.pathname === "/api/usage") {
        const filters = requestFilters(url);
        const detail = url.searchParams.get("detail");
        if (detail === "full" && !isQuotaPreset(filters.preset)) {
          if (!isFullDetailHeapAvailable()) {
            await loadUsageStore();
            const summary = usageStore.summarize({ ...filters, now: new Date() });
            sendJson(response, 413, {
              code: "FULL_DETAIL_UNAVAILABLE",
              error:
                "Full detail report is disabled in low-memory gateway mode. Restart with codex-usage gateway --memory-mb 512, or use npm run export for a static snapshot.",
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
            report,
            summary,
            quota: summary.quota,
            periodComparison: summarizePeriodComparison(report.events, { now: asOf }),
          });
          return;
        }

        const check = url.searchParams.get("skipCheck") !== "1";
        const requestedSnapshotId = url.searchParams.get("snapshot");
        const frozen = requestedSnapshotId
          ? snapshots.get(requestedSnapshotId)
          : url.searchParams.get("freeze") === "1"
            ? await createSnapshot({ check })
            : null;
        if (requestedSnapshotId && !frozen) throw httpError(410, "Snapshot is no longer available.", "SNAPSHOT_EXPIRED");
        const usage = frozen?.status || await loadUsageStore({ check });
        const store = frozen?.store || usageStore;
        const asOf = frozen?.asOf || new Date();
        Object.assign(filters, { now: asOf });
        const summary = store.summarize(filters, { includeDetails: url.searchParams.get("view") !== "dashboard" });
        sendJson(response, 200, {
          fingerprint: clientFingerprint(usage.fingerprint),
          checkedAt: usage.checkedAt,
          snapshotId: frozen?.id || requestedSnapshotId || null,
          metadata: frozen?.metadata || await metadataForStore(),
          summary,
          quota: summary.quota,
          periodComparison: store.periodComparison({ now: asOf, excludeHomes: filters.excludeHomes }),
        });
        return;
      }

      if (url.pathname === "/api/summary") {
        const filters = requestFilters(url);
        const usage = await loadUsageStore();
        const asOf = new Date();
        Object.assign(filters, { now: asOf });
        const summary = usageStore.summarize(filters);
        sendJson(response, 200, {
          fingerprint: clientFingerprint(usage.fingerprint),
          checkedAt: usage.checkedAt,
          metadata: await metadataForStore(),
          summary,
          quota: summary.quota,
          periodComparison: usageStore.periodComparison({ now: asOf, excludeHomes: filters.excludeHomes }),
        });
        return;
      }

      await serveStatic(url.pathname, response);
    } catch (error) {
      const statusCode = error.statusCode || (error.code === "QUOTA_WINDOW_UNAVAILABLE" ? 409 : error.code === "INVALID_PRESET" ? 400 : 500);
      sendJson(response, statusCode, {
        ...(error.code ? { code: error.code } : {}),
        error: error.message,
        ...(error.quota ? { quota: error.quota } : {}),
        stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
      });
    }
  });
  server.on("close", () => {
    usageStore.close();
    for (const snapshot of snapshots.values()) snapshot.store.close();
    snapshots.clear();
    if (snapshotDirectoryPromise) {
      void snapshotDirectoryPromise.then((directory) => rm(directory, { recursive: true, force: true }));
    }
  });
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
