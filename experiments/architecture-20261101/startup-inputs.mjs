import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import { discoverUsageSources } from "../../src/usage-core.js";
import { UsageStore } from "../../src/usage-store.js";

const MANIFEST_SCHEMA = "codex-usage.startup-inputs.v1";
const CAPTURE_SCHEMA = "codex-usage.startup-inputs-capture.v1";
const SIX_SOURCE_KINDS = new Set(["codex", "zcode", "dsh", "opencode", "claude", "workbuddy"]);
const DISCOVERY_ENV_KEYS = Object.freeze([
  "APPDATA",
  "CLAUDE_CONFIG_DIR",
  "CODEX_USAGE_CLAUDE",
  "CODEX_USAGE_CLAUDE_HOMES",
  "CODEX_USAGE_DSH",
  "CODEX_USAGE_DSH_HOMES",
  "CODEX_USAGE_HOMES",
  "CODEX_USAGE_IMPORT_DIRS",
  "CODEX_USAGE_OPENCODE",
  "CODEX_USAGE_OPENCODE_HOMES",
  "CODEX_USAGE_WORKBUDDY",
  "CODEX_USAGE_WORKBUDDY_HOMES",
  "CODEX_USAGE_ZCODE",
  "CODEX_USAGE_ZCODE_HOMES",
  "LOCALAPPDATA",
]);

function isoFromMs(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function statRecord(info) {
  if (!info) return null;
  return {
    size: Number(info.size),
    mtimeMs: Number(info.mtimeMs),
    mtime: isoFromMs(info.mtimeMs),
    atimeMs: Number(info.atimeMs),
    ctimeMs: Number(info.ctimeMs),
    birthtimeMs: Number(info.birthtimeMs),
    mode: Number(info.mode),
    modeOctal: `0o${(Number(info.mode) & 0o7777).toString(8)}`,
    dev: String(info.dev),
    ino: String(info.ino),
    nlink: Number(info.nlink),
  };
}

async function statOptional(filePath) {
  try {
    return statRecord(await stat(filePath));
  } catch (error) {
    return error?.code === "ENOENT" ? null : { error: String(error?.message || error), code: error?.code || null };
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertOutputDirectory(outputDirectory) {
  if (typeof outputDirectory !== "string" || outputDirectory.trim() === "") {
    throw new TypeError("outputDirectory must be a non-empty string");
  }
  return path.resolve(outputDirectory);
}

function outputPath(root, relativePath) {
  const candidate = path.resolve(root, relativePath);
  if (!isWithin(root, candidate)) {
    throw Object.assign(new Error("capture output path escapes outputDirectory"), {
      code: "OUTPUT_PATH_ESCAPE",
    });
  }
  return candidate;
}

function sourceFamily(kind) {
  return ["main", "jetbrains", "extra", "codex"].includes(String(kind)) ? "codex" : String(kind);
}

function sourceSnapshot(source) {
  return {
    id: source.id,
    label: source.label,
    kind: source.kind,
    path: path.resolve(source.path),
    usageLogPath: source.usageLogPath ? path.resolve(source.usageLogPath) : null,
    imported: Boolean(source.imported),
  };
}

function logicalFileId(filePath) {
  return createHash("sha256").update(path.resolve(filePath)).digest("hex").slice(0, 20);
}

async function isSqliteFile(filePath) {
  let handle;
  try {
    handle = await open(filePath, "r");
    const bytes = Buffer.alloc(16);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytesRead === 16 && bytes.equals(Buffer.from("SQLite format 3\0", "binary"));
  } finally {
    await handle?.close();
  }
}

async function readImportEntries(importStoreFile) {
  try {
    const parsed = JSON.parse(await readFile(importStoreFile, "utf8"));
    const entries = Array.isArray(parsed) ? parsed : parsed?.imports;
    if (!Array.isArray(entries)) {
      throw new TypeError("imports.json must contain an array or an imports array");
    }
    const seen = new Set();
    const paths = [];
    for (const entry of entries) {
      const rawPath = typeof entry === "string" ? entry : entry?.path;
      if (typeof rawPath !== "string" || rawPath.trim() === "") continue;
      const resolved = path.resolve(rawPath);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      paths.push(resolved);
    }
    return { status: "read", file: path.resolve(importStoreFile), importDirs: paths, warnings: [] };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { status: "missing", file: path.resolve(importStoreFile), importDirs: [], warnings: [] };
    }
    return {
      status: "invalid",
      file: path.resolve(importStoreFile),
      importDirs: [],
      warnings: [`无法读取导入配置: ${error.message}`],
    };
  }
}

function configuredImportDirs(options) {
  if (Array.isArray(options.importDirs)) return options.importDirs.filter((value) => typeof value === "string" && value);
  if (typeof options.importDirs === "string") return options.importDirs.split(path.delimiter).filter(Boolean);
  return [];
}

async function readActiveIndex(activeIndexFile) {
  const fileStat = await statOptional(activeIndexFile);
  if (!fileStat) {
    return { status: "missing", bySource: [], sixSourceFileCount: 0, sixSourceKnownBytes: 0, warnings: [] };
  }
  if (fileStat.error) {
    return { status: "unreadable", bySource: [], sixSourceFileCount: 0, sixSourceKnownBytes: 0, warnings: [fileStat.error] };
  }

  let database;
  try {
    database = new DatabaseSync(activeIndexFile, { readOnly: true });
    database.exec("PRAGMA query_only = ON");
    const rows = database
      .prepare(
        `SELECT kind, COUNT(*) AS file_count, SUM(CASE WHEN size >= 0 THEN size ELSE 0 END) AS known_bytes
         FROM source_files
         GROUP BY kind
         ORDER BY kind`,
      )
      .all();
    const families = new Map();
    for (const row of rows) {
      const family = sourceFamily(row.kind);
      const current = families.get(family) || { kind: family, fileCount: 0, knownBytes: 0 };
      current.fileCount += Number(row.file_count || 0);
      current.knownBytes += Number(row.known_bytes || 0);
      families.set(family, current);
    }
    const bySource = [...families.values()].sort((left, right) => left.kind.localeCompare(right.kind));
    const sixSources = bySource.filter((row) => SIX_SOURCE_KINDS.has(row.kind));
    return {
      status: "read",
      file: path.resolve(activeIndexFile),
      stat: fileStat,
      bySource,
      sixSourceFileCount: sixSources.reduce((sum, row) => sum + row.fileCount, 0),
      sixSourceKnownBytes: sixSources.reduce((sum, row) => sum + row.knownBytes, 0),
      warnings: [],
    };
  } catch (error) {
    return {
      status: "unreadable",
      file: path.resolve(activeIndexFile),
      stat: fileStat,
      bySource: [],
      sixSourceFileCount: 0,
      sixSourceKnownBytes: 0,
      warnings: [`无法只读活动索引: ${error.message}`],
    };
  } finally {
    database?.close();
  }
}

function plainSourceInfo(info) {
  return info ? { size: Number(info.size), mtimeMs: Number(info.mtimeMs) } : null;
}

async function inventoryFile(file) {
  const filePath = path.resolve(file.filePath);
  const info = await lstat(filePath);
  if (!info.isFile()) {
    throw Object.assign(new Error("startup input must be a regular file"), { code: "SOURCE_NOT_REGULAR_FILE" });
  }
  return {
    id: logicalFileId(filePath),
    logicalPath: filePath,
    sourceId: file.source.id,
    sourceKind: file.source.kind,
    sourceLabel: file.source.label,
    sourceHomePath: path.resolve(file.source.path),
    role: "usage-file",
    storageType: (await isSqliteFile(filePath)) ? "sqlite" : "file",
    stat: statRecord(info),
    discoveryStat: plainSourceInfo(file.info),
    sidecars:
      (await isSqliteFile(filePath))
        ? {
            wal: await statOptional(`${filePath}-wal`),
            shm: await statOptional(`${filePath}-shm`),
          }
        : {},
  };
}

function summarizeInventory(manifest) {
  const bySource = {};
  for (const file of manifest.files) {
    const family = sourceFamily(file.sourceKind);
    const current = bySource[family] || { fileCount: 0, knownBytes: 0 };
    current.fileCount += 1;
    current.knownBytes += Number(file.discoveryStat?.size ?? file.stat.size);
    bySource[family] = current;
  }
  return {
    sourceCount: manifest.sources.length,
    fileCount: manifest.files.length,
    knownBytes: Object.values(bySource).reduce((sum, row) => sum + row.knownBytes, 0),
    bySource,
    failedHomeCount: manifest.failedHomes.length,
    warningCount: manifest.warnings.length,
    activeIndexStatus: manifest.activeIndex.status,
  };
}

/**
 * Discover the real usage inputs used by the application.
 * The manifest contains private source paths and must stay under an ignored output directory.
 */
export async function inventoryStartupInputs({ outputDirectory, options = {} } = {}) {
  const root = assertOutputDirectory(outputDirectory);
  const homeDir = path.resolve(options.homeDir || os.homedir());
  const env = options.env || process.env;
  const importStoreFile = path.resolve(
    options.importStoreFile || path.join(homeDir, ".codex-usage", "imports.json"),
  );
  const activeIndexFile = path.resolve(
    options.activeIndexFile || path.join(homeDir, ".codex-usage", "usage-index.sqlite"),
  );
  const importStore = await readImportEntries(importStoreFile);
  const importDirs = [...configuredImportDirs(options), ...importStore.importDirs];
  const discoveryOptions = {
    ...options,
    homeDir,
    env,
    importDirs,
  };

  const [sources, activeIndex] = await Promise.all([
    discoverUsageSources(discoveryOptions),
    readActiveIndex(activeIndexFile),
  ]);
  const store = new UsageStore({ homeDir, databaseFile: activeIndexFile });
  let usageInventory;
  try {
    usageInventory = await store.usageFiles(sources);
  } finally {
    store.close();
  }

  const files = [];
  const fileErrors = [];
  for (const file of usageInventory.files) {
    try {
      files.push(await inventoryFile(file));
    } catch (error) {
      fileErrors.push({
        logicalPath: path.resolve(file.filePath),
        sourceId: file.source.id,
        code: error?.code || null,
        message: String(error?.message || error),
      });
    }
  }
  files.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));

  const warnings = [...importStore.warnings, ...usageInventory.warnings, ...activeIndex.warnings];
  if (fileErrors.length) warnings.push(`有 ${fileErrors.length} 个 discovery 文件在取 stat 时失败`);
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA,
    generatedAt: new Date().toISOString(),
    private: true,
    scope: {
      usageFilesOnly: true,
      originalInputsComplete: false,
      note:
        "清单覆盖应用 usageFiles 发现并解析的文件及显式 extraFiles；未递归枚举来源 home 中所有潜在辅助配置，不能声称全部原始输入已冻结。",
    },
    discovery: {
      homeDir,
      platform: options.platform || os.platform(),
      importDirs,
      env: Object.fromEntries(
        DISCOVERY_ENV_KEYS.flatMap((key) => (env[key] === undefined ? [] : [[key, String(env[key])]])),
      ),
    },
    importStore,
    activeIndex,
    sources: sources.map(sourceSnapshot),
    files,
    warnings,
    failedHomes: usageInventory.failedHomes,
    fileErrors,
  };

  await mkdir(root, { recursive: true });
  const manifestFile = outputPath(root, "startup-inputs.manifest.json");
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { manifest, manifestFile, summary: summarizeInventory(manifest) };
}

function normalizeExtraFile(manifest, candidate, index) {
  const rawPath = typeof candidate === "string" ? candidate : candidate?.path;
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new TypeError(`extraFiles[${index}] must be a path or an object with path`);
  }
  const logicalPath = path.resolve(rawPath);
  const requestedSourceId = typeof candidate === "object" ? candidate.sourceId : null;
  const source =
    (requestedSourceId && manifest.sources.find((item) => item.id === requestedSourceId)) ||
    manifest.sources
      .filter((item) => isWithin(item.path, logicalPath))
      .sort((left, right) => right.path.length - left.path.length)[0];
  return {
    id: logicalFileId(logicalPath),
    logicalPath,
    sourceId: source?.id || "extra",
    sourceKind: candidate?.sourceKind || source?.kind || "extra",
    sourceLabel: candidate?.sourceLabel || source?.label || "Extra startup input",
    sourceHomePath: path.resolve(candidate?.sourceHomePath || source?.path || path.dirname(logicalPath)),
    role: candidate?.role || "auxiliary",
    storageType: candidate?.storageType || "auto",
  };
}

function normalizeCaptureEntries(manifest, extraFiles) {
  const entries = [];
  const seen = new Set();
  for (const file of manifest.files) {
    const logicalPath = path.resolve(file.logicalPath);
    const sourceHomePath = path.resolve(file.sourceHomePath);
    if (!isWithin(sourceHomePath, logicalPath)) {
      throw Object.assign(new Error("manifest file escapes its source home"), { code: "SOURCE_PATH_ESCAPE" });
    }
    entries.push({ ...file, logicalPath, sourceHomePath });
    seen.add(logicalPath);
  }
  extraFiles.forEach((candidate, index) => {
    const entry = normalizeExtraFile(manifest, candidate, index);
    if (seen.has(entry.logicalPath)) return;
    seen.add(entry.logicalPath);
    entries.push(entry);
  });
  return entries.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
}

function direntType(entry) {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

async function listAncestors(manifestEntries) {
  const byRoot = new Map();
  for (const entry of manifestEntries) {
    let directory = path.dirname(entry.logicalPath);
    const directories = [];
    while (isWithin(entry.sourceHomePath, directory)) {
      directories.push(directory);
      if (directory === entry.sourceHomePath) break;
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    const key = `${entry.sourceId}\0${entry.sourceHomePath}`;
    const root = byRoot.get(key) || {
      sourceId: entry.sourceId,
      homePath: entry.sourceHomePath,
      directories: new Set(),
      failures: [],
    };
    directories.forEach((item) => root.directories.add(item));
    byRoot.set(key, root);
  }

  const result = [];
  for (const root of byRoot.values()) {
    const directories = [];
    for (const directory of [...root.directories].sort()) {
      try {
        const entries = await readdir(directory, { withFileTypes: true });
        directories.push({
          logicalPath: directory,
          entries: entries
            .map((entry) => ({ name: entry.name, type: direntType(entry) }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        });
      } catch (error) {
        root.failures.push({
          logicalPath: directory,
          code: error?.code || null,
          message: String(error?.message || error),
        });
      }
    }
    result.push({
      sourceId: root.sourceId,
      homePath: root.homePath,
      directories,
      failures: root.failures,
    });
  }
  return result.sort((left, right) => {
    const bySource = left.sourceId.localeCompare(right.sourceId);
    return bySource || left.homePath.localeCompare(right.homePath);
  });
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function sqliteSidecars(filePath) {
  return {
    wal: await statOptional(`${filePath}-wal`),
    shm: await statOptional(`${filePath}-shm`),
  };
}

async function captureSqlite(sourcePath, destination) {
  const database = new DatabaseSync(sourcePath, { readOnly: true });
  let journalMode = null;
  try {
    database.exec("PRAGMA query_only = ON");
    journalMode = String(database.prepare("PRAGMA journal_mode").get()?.journal_mode || "");
    await backup(database, destination);
  } finally {
    database.close();
  }

  let quickCheck;
  let capturedJournalMode;
  const capturedDatabase = new DatabaseSync(destination, { readOnly: true });
  try {
    capturedJournalMode = String(capturedDatabase.prepare("PRAGMA journal_mode").get()?.journal_mode || "");
    quickCheck = String(capturedDatabase.prepare("PRAGMA quick_check").get()?.quick_check || "");
  } finally {
    capturedDatabase.close();
  }
  return {
    method: "sqlite-backup",
    sourceJournalMode: journalMode,
    capturedJournalMode,
    quickCheck,
    committedWalIncluded: journalMode === "wal",
  };
}

function stableBetween(before, after) {
  return (
    Boolean(before) &&
    Boolean(after) &&
    !before.error &&
    !after.error &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs
  );
}

function optionalStable(before, after) {
  if (!before && !after) return true;
  return stableBetween(before, after);
}

async function captureOne(entry, destination, relativePath) {
  const sourceInfo = await lstat(entry.logicalPath);
  if (!sourceInfo.isFile()) {
    throw Object.assign(new Error("startup input must be a regular file"), { code: "SOURCE_NOT_REGULAR_FILE" });
  }
  const sourceBefore = statRecord(sourceInfo);
  const sqlite = entry.storageType === "sqlite" || (await isSqliteFile(entry.logicalPath));
  const sidecarsBefore = await sqliteSidecars(entry.logicalPath);

  let sqliteState = null;
  if (sqlite) {
    sqliteState = await captureSqlite(entry.logicalPath, destination);
  } else {
    await copyFile(entry.logicalPath, destination);
  }

  await utimes(destination, sourceBefore.atimeMs / 1000, sourceBefore.mtimeMs / 1000);
  const sourceAfter = await statOptional(entry.logicalPath);
  const sidecarsAfter = await sqliteSidecars(entry.logicalPath);
  const capturedStat = statRecord(await stat(destination));
  const sha256 = await hashFile(destination);
  return {
    id: entry.id,
    logicalPath: entry.logicalPath,
    capturedPath: relativePath,
    sourceId: entry.sourceId,
    sourceKind: entry.sourceKind,
    sourceLabel: entry.sourceLabel,
    sourceHomePath: entry.sourceHomePath,
    role: entry.role,
    storageType: sqlite ? "sqlite" : "file",
    inventoryStat: entry.stat || null,
    sourceBefore,
    sourceAfter,
    sidecarsBefore,
    sidecarsAfter,
    sourceStable:
      stableBetween(sourceBefore, sourceAfter) &&
      optionalStable(sidecarsBefore.wal, sidecarsAfter.wal) &&
      optionalStable(sidecarsBefore.shm, sidecarsAfter.shm),
    capturedStat,
    mtimePreserved: Math.abs(capturedStat.mtimeMs - sourceBefore.mtimeMs) < 0.001,
    sha256,
    sqlite: sqliteState,
  };
}

/**
 * Copy a previously inventoried input set. Capture is intentionally a separate
 * explicit step because a real set can be several gigabytes.
 */
export async function captureStartupInputs(manifest, { outputDirectory, extraFiles = [] } = {}) {
  if (!manifest || manifest.schemaVersion !== MANIFEST_SCHEMA || !Array.isArray(manifest.files)) {
    throw new TypeError(`manifest must use ${MANIFEST_SCHEMA}`);
  }
  const root = assertOutputDirectory(outputDirectory);
  const entries = normalizeCaptureEntries(manifest, extraFiles);
  for (const entry of entries) {
    if (isWithin(root, entry.logicalPath)) {
      throw Object.assign(new Error("startup input must not be inside outputDirectory"), {
        code: "SOURCE_INSIDE_OUTPUT",
      });
    }
  }

  await mkdir(root, { recursive: true });
  const listingsBefore = await listAncestors(entries);
  const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "");
  const captureDirectory = outputPath(root, `capture-${stamp}-${randomBytes(4).toString("hex")}`);
  await mkdir(captureDirectory, { recursive: false });
  await mkdir(outputPath(captureDirectory, "files"), { recursive: false });

  const captured = [];
  const failures = [];
  for (const [index, entry] of entries.entries()) {
    const sourceKey = createHash("sha256").update(String(entry.sourceId)).digest("hex").slice(0, 12);
    const basename = path.basename(entry.logicalPath).replaceAll(/[^A-Za-z0-9._-]/g, "_") || "input";
    const relativePath = path.posix.join("files", sourceKey, `${String(index).padStart(4, "0")}-${basename}`);
    const destination = outputPath(captureDirectory, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      captured.push(await captureOne(entry, destination, relativePath));
    } catch (error) {
      failures.push({
        id: entry.id,
        logicalPath: entry.logicalPath,
        sourceId: entry.sourceId,
        code: error?.code || null,
        message: String(error?.message || error),
      });
    }
  }
  const listingsAfter = await listAncestors(entries);
  const logicalRoots = new Map();
  for (const entry of entries) {
    logicalRoots.set(`${entry.sourceId}\0${entry.sourceHomePath}`, {
      id: entry.sourceId,
      kind: entry.sourceKind,
      label: entry.sourceLabel,
      path: entry.sourceHomePath,
    });
  }
  const captureManifest = {
    schemaVersion: CAPTURE_SCHEMA,
    generatedAt: new Date().toISOString(),
    private: true,
    sourceManifestGeneratedAt: manifest.generatedAt || null,
    captureDirectory: await realpath(captureDirectory),
    scope: {
      capturedUsageAndExplicitFilesOnly: true,
      originalInputsComplete: false,
      note:
        "该快照只包含 manifest usage files 与本次显式 extraFiles；来源 home 内未枚举的辅助文件未冻结，不能用它宣称完整原始输入已捕获。",
    },
    logicalRoots: [...logicalRoots.values()].sort((left, right) => {
      const byId = left.id.localeCompare(right.id);
      return byId || left.path.localeCompare(right.path);
    }),
    files: captured,
    directoryListings: {
      before: listingsBefore,
      after: listingsAfter,
    },
    failures,
  };
  const captureManifestFile = outputPath(captureDirectory, "capture.manifest.json");
  await writeFile(captureManifestFile, `${JSON.stringify(captureManifest, null, 2)}\n`, { mode: 0o600 });
  const summary = {
    fileCount: captured.length,
    failureCount: failures.length,
    knownBytes: captured.reduce((sum, file) => sum + Number(file.capturedStat.size || 0), 0),
    sqliteCount: captured.filter((file) => file.storageType === "sqlite").length,
    sourceChangedCount: captured.filter((file) => !file.sourceStable).length,
    directoryListingFailureCount: [...listingsBefore, ...listingsAfter].reduce(
      (sum, rootListing) => sum + rootListing.failures.length,
      0,
    ),
    originalInputsComplete: false,
  };
  return { manifest: captureManifest, manifestFile: captureManifestFile, summary };
}
