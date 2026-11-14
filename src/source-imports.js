import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  classifyImportDirectory,
  discoverClaudeHomes,
  discoverCodexHomes,
  discoverDshHomes,
  discoverHermesHomes,
  discoverOpencodeHomes,
  discoverUsageSources,
  discoverWorkbuddyHomes,
  discoverZcodeHomes,
  importPathIdentity,
  sourceId,
} from "./usage-core.js";

export { importPathIdentity } from "./usage-core.js";

function importError(code, message, sourcePath = "") {
  return Object.assign(new Error(message), { code, path: sourcePath, statusCode: 400 });
}

export function normalizeImportPath(value, options = {}) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    throw importError("INVALID_IMPORT_PATH", "Enter a complete directory path.");
  let directory = value.trim().replace(/^(["'])(.*)\1$/, "$2");
  const home = options.homeDir || os.homedir();
  if (/^~(?:[/\\]|$)/.test(directory)) directory = home + directory.slice(1);
  if ((options.platform || process.platform) === "win32") {
    const env = options.env || process.env;
    directory = directory.replace(/^%(USERPROFILE|APPDATA|LOCALAPPDATA)%/i, (_, key) =>
      key.toUpperCase() === "USERPROFILE" ? home : env[key.toUpperCase()] || `%${key}%`,
    );
  }
  if (!path.isAbsolute(directory) || /^%[^%]+%/.test(directory))
    throw importError("INVALID_IMPORT_PATH", "Enter a complete directory path.", directory);
  return path.normalize(directory);
}

export async function scanImportSources(options = {}, confirmed = []) {
  const candidates = [];
  const errors = [];
  const roots = [];
  const scanOptions = { ...options, sourceCandidates: roots, discoveryErrors: errors };
  for (const discover of [
    discoverCodexHomes,
    discoverZcodeHomes,
    discoverDshHomes,
    discoverHermesHomes,
    discoverOpencodeHomes,
    discoverWorkbuddyHomes,
    discoverClaudeHomes,
  ]) {
    try {
      candidates.push(...(await discover(scanOptions)));
    } catch (error) {
      errors.push({ path: error.path || "", code: error.code || "IMPORT_SCAN_FAILED" });
    }
  }
  for (const configured of [
    { ...options, onlyConfiguredSources: true },
    { ...options, confirmedSources: confirmed.filter((entry) => entry.id) },
  ]) {
    try {
      candidates.push(...(await discoverUsageSources(configured)));
    } catch (error) {
      errors.push({ path: error.path || "", code: error.code || "IMPORT_SCAN_FAILED" });
    }
  }
  // Probe access separately: the parsers' legacy existence checks swallow permission errors.
  for (const root of new Set(roots)) {
    try {
      await readdir(root);
    } catch (error) {
      if (error.code !== "ENOENT") errors.push({ path: root, code: error.code || "IMPORT_SCAN_FAILED" });
    }
  }
  const known = new Set();
  for (const entry of confirmed) {
    try {
      known.add(await importPathIdentity(entry.path));
    } catch (error) {
      errors.push({ path: entry.path, code: error.code || "IMPORT_SCAN_FAILED" });
    }
  }
  const seen = new Set();
  const sources = [];
  for (const candidate of candidates) {
    try {
      const identity = await importPathIdentity(candidate.path);
      if (seen.has(identity)) continue;
      seen.add(identity);
      sources.push({ ...candidate, confirmed: known.has(identity) });
    } catch (error) {
      errors.push({ path: candidate.path, code: error.code || "IMPORT_SCAN_FAILED" });
    }
  }
  return {
    candidates: sources,
    errors,
    platform: options.platform || process.platform,
    homeDir: options.homeDir || os.homedir(),
  };
}

/** @param {any} options @param {() => Promise<any[]>} publishedHomes */
export function createSourceImports(options, publishedHomes) {
  const file = options.importStoreFile || path.join(options.homeDir || os.homedir(), ".codex-usage", "imports.json");
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();
  /** @template T @param {() => Promise<T>} task @returns {Promise<T>} */
  function serialize(task) {
    const result = tail.then(() => task());
    tail = result.catch(() => {});
    return result;
  }
  async function read() {
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (!value || (value.version !== undefined && ![1, 2].includes(value.version)))
        throw new Error("Unsupported imports manifest version.");
      const entries = Array.isArray(value) ? value : value.imports;
      if (!Array.isArray(entries)) throw new Error("Invalid imports manifest.");
      if (
        value.version === 2 &&
        entries.some(
          (entry) =>
            !entry ||
            ![entry.path, entry.id, entry.kind, entry.label].every(
              (field) => typeof field === "string" && field.length > 0,
            ) ||
            !path.isAbsolute(entry.path),
        )
      )
        throw new Error("Invalid confirmed source identity.");
      return {
        version: value.version || 1,
        imports: entries.map((entry) => (typeof entry === "string" ? { path: entry } : entry)),
        exists: true,
      };
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, imports: [], exists: false };
      if (!error.code) throw Object.assign(error, { code: "INVALID_IMPORT_MANIFEST", statusCode: 500, path: file });
      throw error;
    }
  }
  async function write(entries) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 2, imports: entries }, null, 2)}\n`, { flag: "wx" });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async function initialize() {
    const stored = await read();
    const entries = stored.version === 2 ? [...stored.imports] : await publishedHomes();
    const configured = await discoverUsageSources({ ...options, onlyConfiguredSources: true });
    const additions = [...configured];
    if (stored.version !== 2) {
      for (const old of stored.imports) {
        if (typeof old?.path !== "string" || !old.path) throw new Error("Invalid legacy import path.");
        const resolved = path.resolve(old.path);
        const found = await discoverUsageSources({
          homeDir: options.homeDir,
          env: {},
          onlyConfiguredSources: true,
          importDirs: [resolved],
        });
        additions.push(
          found[0] || {
            path: resolved,
            id: sourceId("extra", resolved),
            kind: "extra",
            label: `Imported ${path.basename(resolved)}`,
            imported: true,
          },
        );
      }
    }
    const known = new Set();
    for (const entry of entries) known.add(await importPathIdentity(entry.path));
    for (const entry of additions) {
      const identity = await importPathIdentity(entry.path);
      if (known.has(identity)) continue;
      known.add(identity);
      entries.push(entry);
    }
    if (stored.version !== 2 || entries.length !== stored.imports.length) {
      if (stored.exists && stored.version !== 2)
        await copyFile(file, `${file}.v1-backup`, 1).catch((error) => {
          if (error.code !== "EEXIST") throw error;
        });
      await write(entries);
    }
    return entries;
  }
  return {
    file,
    list: () => serialize(initialize),
    discover: async () => scanImportSources(options, (await read()).imports),
    add: (paths) =>
      serialize(async () => {
        const entries = await initialize();
        const priorCount = entries.length;
        const scan = await scanImportSources(options, entries);
        const known = new Map();
        for (const entry of entries) known.set(await importPathIdentity(entry.path), entry);
        const selected = [];
        for (const value of paths) {
          const directory = normalizeImportPath(value, options);
          const info = await stat(directory).catch((error) => {
            throw importError(error.code || "IMPORT_DIRECTORY_UNAVAILABLE", error.message, directory);
          });
          if (!info.isDirectory())
            throw importError("IMPORT_PATH_NOT_DIRECTORY", "Choose the containing directory, not a file.", directory);
          const classified = await classifyImportDirectory(directory);
          if (classified.type === "unsupported")
            throw importError("INVALID_IMPORT_DIRECTORY", classified.reason, directory);
          const identity = await importPathIdentity(classified.path);
          let entry = known.get(identity);
          if (!entry) {
            for (const candidate of scan.candidates) {
              if ((await importPathIdentity(candidate.path)) === identity) {
                const { confirmed: _confirmed, ...source } = candidate;
                entry = source;
                break;
              }
            }
            entry ||= (
              await discoverUsageSources({
                homeDir: options.homeDir,
                env: {},
                onlyConfiguredSources: true,
                importDirs: [classified.path],
              })
            )[0];
            if (!entry)
              throw importError("INVALID_IMPORT_DIRECTORY", "The directory is no longer available.", directory);
            known.set(identity, entry);
            entries.push(entry);
          }
          if (!selected.some((source) => source.id === entry.id)) selected.push(entry);
        }
        if (entries.length !== priorCount) await write(entries);
        return { imports: entries, selected };
      }),
    remove: (directory) =>
      serialize(async () => {
        const entries = await initialize();
        const identity = await importPathIdentity(normalizeImportPath(directory, options));
        const remaining = [];
        for (const entry of entries) if ((await importPathIdentity(entry.path)) !== identity) remaining.push(entry);
        await write(remaining);
        return remaining;
      }),
  };
}
