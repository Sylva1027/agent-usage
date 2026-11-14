import { createHash } from "node:crypto";
import { lstat, opendir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { discoverUsageSources } from "./usage-core.js";
import { readUsageSourceProgress } from "./usage-source-progress.js";
import { windowsSourceProofPosition } from "./usage-source-native.js";
import { readUsageSourceInputs } from "./usage-source-inputs.js";

export const USAGE_SOURCE_CATALOG_TABLE = "usage_source_catalog";
const TOPOLOGY = 0x100 | 0x200 | 0x1000 | 0x2000 | 0x10000 | 0x100000;
const CREATE = 0x100;
const CLOSE = 0x80000000;
const normal = (value) => path.resolve(value.replace(/^\\\\\?\\/, "")).toLowerCase();
const within = (file, root) => file === root || file.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const unavailable = (message) => Object.assign(new Error(message), { code: "SOURCE_COVERAGE_UNAVAILABLE" });

export function ensureUsageSourceCatalog(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS usage_source_catalog (
    path TEXT PRIMARY KEY, volume TEXT NOT NULL, id64 TEXT NOT NULL, id128 TEXT NOT NULL,
    role TEXT NOT NULL, payload TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  CREATE INDEX IF NOT EXISTS usage_source_catalog_id64 ON usage_source_catalog(volume,id64);
  CREATE INDEX IF NOT EXISTS usage_source_catalog_id128 ON usage_source_catalog(volume,id128)`);
  const installed = Number(
    database
      .prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name GLOB 'usage_source_catalog_*'")
      .get().n,
  );
  for (const table of [
    "source_files",
    "usage_source_progress",
    "usage_source_reparse",
    "rate_limit_observations",
    "quota_usage_sources",
  ]) {
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      database.exec(`CREATE TRIGGER IF NOT EXISTS usage_source_catalog_${table}_${operation}
        BEFORE ${operation} ON ${table}
        WHEN EXISTS(SELECT 1 FROM usage_source_catalog WHERE path='' AND ready=1)
        BEGIN UPDATE usage_source_catalog SET ready=0 WHERE path=''; END`);
    }
  }
  for (const [operation, condition] of [
    ["INSERT", "NEW.path<>''"],
    ["UPDATE", "OLD.path<>'' OR NEW.path<>''"],
    ["DELETE", "OLD.path<>''"],
  ]) {
    database.exec(`CREATE TRIGGER IF NOT EXISTS usage_source_catalog_inventory_${operation}
      BEFORE ${operation} ON usage_source_catalog WHEN ${condition}
      BEGIN UPDATE usage_source_catalog SET ready=0 WHERE path='' AND ready=1; END`);
  }
  if (installed !== 18) database.prepare("UPDATE usage_source_catalog SET ready=0 WHERE path='' AND ready=1").run();
}

function context(options) {
  const { sourceCandidates: _candidates, shutdownToken: _shutdownToken, ...rest } = options;
  return digest(JSON.stringify([3, rest, options.env || process.env, process.platform]));
}

function revision(store) {
  return Number(
    store.database.prepare("SELECT revision FROM usage_business_revision WHERE singleton=1").get().revision,
  );
}

function parse(row) {
  try {
    return row ? JSON.parse(String(row.payload)) : null;
  } catch {
    return null;
  }
}

function progressSeal(store, file) {
  const progress = readUsageSourceProgress(store.database, file);
  if (!progress || progress.validation.offset !== progress.checkpoint.offset) return null;
  return windowsSourceProofPosition(progress.validation);
}

/** Rebuildable identities only. Facts and parser checkpoints remain in their existing tables. */
export class UsageSourceAcquisition {
  constructor(store) {
    this.store = store;
    this.work = null;
  }

  async provider() {
    const native = await this.store.sourceProof.provider?.();
    return native?.journal && native?.changes && native?.object && native?.resolve ? native : null;
  }

  invalidate() {
    this.store.database.prepare("UPDATE usage_source_catalog SET ready=0 WHERE path='' AND ready=1").run();
  }

  state(options) {
    const row = this.store.database.prepare("SELECT * FROM usage_source_catalog WHERE path='' AND ready=1").get();
    const state = parse(row);
    return state?.format === 1 &&
      state.directoryCoverage === 1 &&
      Array.isArray(state.watchedParents) &&
      Array.isArray(state.homes) &&
      state.homes.every(
        (home) => home && [home.id, home.path, home.label, home.kind].every((field) => typeof field === "string"),
      ) &&
      Array.isArray(state.warnings) &&
      Array.isArray(state.missingSources) &&
      Array.isArray(state.scopes) &&
      state.scopes.length > 0 &&
      state.scopes.every((root) => typeof root === "string") &&
      Array.isArray(state.volumes) &&
      state.volumes.length > 0 &&
      state.volumes.every(
        (cursor) =>
          cursor &&
          [cursor.volume, cursor.path, cursor.journalId, cursor.nextUsn].every((field) => typeof field === "string"),
      ) &&
      state.context === context(options) &&
      state.revision === revision(this.store) &&
      state.fingerprint === this.store.readMetaRaw("fingerprint")
      ? state
      : null;
  }

  async beginFull(options) {
    if (this.store.database.isTransaction || this.store.writeTransactionDepth) return null;
    const native = await this.provider();
    if (!native) return null;
    if (!(await native.journal(options.homeDir || os.homedir()))) return null;
    const candidates = [];
    const homes = await discoverUsageSources({ ...options, sourceCandidates: candidates });
    const auxiliary = await readUsageSourceInputs(options, homes, "");
    const scopes = [...new Set([...candidates, ...homes.map((h) => h.path), ...auxiliary.files].map(normal))];
    if (!scopes.length || scopes.length > 256 || scopes.some((root) => within(normal(this.store.databaseFile), root)))
      return null;
    const volumes = new Map();
    const guards = new Set();
    const watchedParents = new Set();
    for (const scope of scopes) {
      let existing = scope;
      while (true) {
        try {
          await stat(existing);
          break;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          const parent = path.dirname(existing);
          if (parent === existing) return null;
          existing = parent;
        }
      }
      const object = await native.object(existing);
      if (!object || object.attributes & 0x400) return null;
      if (existing !== scope) watchedParents.add(normal(existing));
      if (!volumes.has(object.volume)) {
        const cursor = await native.journal(existing);
        if (!cursor || cursor.volume !== object.volume) return null;
        volumes.set(object.volume, { path: existing, ...cursor });
      }
      for (let directory = existing; ; directory = path.dirname(directory)) {
        guards.add(directory);
        if (path.dirname(directory) === directory) break;
      }
    }
    this.invalidate();
    return {
      format: 1,
      context: context(options),
      scopes,
      volumes: [...volumes.values()],
      guards: [...guards],
      homes,
      watchedParents: [...watchedParents],
      auxiliary: auxiliary.inputs,
      dataVersion: Number(this.store.database.prepare("PRAGMA data_version").get().data_version),
    };
  }

  find(volume, id) {
    const column = id.length === 16 ? "id64" : "id128";
    return this.store.database
      .prepare(`SELECT * FROM usage_source_catalog WHERE volume=? AND ${column}=? AND path<>''`)
      .get(volume, id);
  }

  additionSource(state, filePath, directory) {
    const matches = state.homes.filter((home) => {
      const relative = path.relative(normal(home.path), normal(filePath)).split(path.sep);
      if (
        !relative.length ||
        relative.includes("..") ||
        relative.some((part) => [".tmp", "node_modules"].includes(part))
      )
        return false;
      if (home.kind === "dsh")
        return (
          relative[0] === "sessions" &&
          relative.length <= (directory ? 4 : 5) &&
          (directory || /^session\.v4\.jsonl\.zstd$/.test(path.basename(filePath)))
        );
      return (
        ["main", "extra", "jetbrains", "codex"].includes(home.kind) &&
        ["sessions", "archived_sessions"].includes(relative[0]) &&
        (directory || filePath.endsWith(".jsonl"))
      );
    });
    if (matches.length !== 1) throw unavailable("new source is outside a unique supported home");
    // A nested discovery root may become another harness when its first log appears.
    const homePath = normal(matches[0].path),
      candidate = normal(filePath);
    if (
      state.scopes.some(
        (root) => root !== homePath && within(root, homePath) && (within(candidate, root) || within(root, candidate)),
      )
    )
      throw unavailable("new source overlaps another discovery scope");
    return matches[0];
  }

  async interval(state, native, bootstrap = false) {
    const deadline = performance.now() + 2000;
    const dirty = new Set();
    const volumes = [];
    const addedFiles = new Map(),
      directories = [];
    let records = 0,
      journalBytes = 0;
    for (const cursor of state.volumes) {
      if (performance.now() > deadline) throw unavailable("change resolution budget exceeded");
      const interval = await native.changes(cursor.path, cursor);
      if (!interval)
        throw unavailable(
          `journal interval unavailable${
            native.lastDirectoryFailure?.operation === "changes" ? `: ${native.lastDirectoryFailure.reason}` : ""
          }`,
        );
      volumes.push({ ...cursor, nextUsn: interval.nextUsn });
      journalBytes += interval.journalBytes;
      const unknown = new Map();
      for (const record of interval.records) {
        if (performance.now() > deadline) throw unavailable("change resolution budget exceeded");
        if (++records > 2048) throw unavailable("change budget exceeded");
        const known = this.find(cursor.volume, record.id);
        const value = parse(known);
        // A content seal never authorizes namespace changes, including moves out of scope.
        if (known && record.reason & TOPOLOGY) throw unavailable("known namespace changed");
        if (record.reason === CLOSE) continue;
        if (known?.role === "file") {
          if (value?.seal && (!bootstrap || value.covered !== false) && BigInt(record.usn) <= BigInt(value.seal))
            continue;
          if (!value?.supported) throw unavailable("other source changed");
          dirty.add(String(known.path));
          continue;
        }
        if (known) throw unavailable("discovery directory changed");
        if (record.reason & 0x10000) throw unavailable("ambiguous hardlink change");
        const previous = unknown.get(record.id);
        unknown.set(record.id, {
          ...record,
          reason: (previous?.reason || 0) | record.reason,
          moved: previous?.moved || (previous && previous.parent !== record.parent),
        });
      }
      const newDirectories = new Map();
      let pending = [...unknown.values()],
        progressed = true;
      while (pending.length && progressed) {
        progressed = false;
        const remaining = [];
        for (const record of pending) {
          if (performance.now() > deadline) throw unavailable("change resolution budget exceeded");
          const parent = this.find(cursor.volume, record.parent) || newDirectories.get(record.parent);
          if (parent?.role === "directory") {
            if (
              bootstrap ||
              state.directoryCoverage !== 1 ||
              record.moved ||
              !(record.reason & CREATE) ||
              record.reason & (TOPOLOGY & ~CREATE)
            )
              throw unavailable("managed directory changed");
            const object = await native.resolve(cursor.path, record.id);
            if (
              !object ||
              (record.id.length === 16 ? object.id64 : object.id128) !== record.id ||
              object.volume !== cursor.volume ||
              object.attributes & 0x400 ||
              (!(object.attributes & 16) && object.links !== 1)
            )
              throw unavailable("new source identity unavailable");
            const parentPath = path.dirname(object.path);
            const currentParent = await native.object(parentPath);
            const parentId = record.parent.length === 16 ? currentParent?.id64 : currentParent?.id128;
            if (
              !currentParent ||
              currentParent.volume !== cursor.volume ||
              parentId !== record.parent ||
              currentParent.attributes & 0x400 ||
              normal(parentPath) !== parent.path
            )
              throw unavailable("new source parent identity changed");
            const directory = Boolean(object.attributes & 16);
            const source = this.additionSource(state, object.path, directory);
            const entry = { path: normal(object.path), role: "directory", object };
            if (directory) {
              directories.push(entry);
              newDirectories.set(object.id64, entry);
              newDirectories.set(object.id128, entry);
            } else {
              const filePath = path.resolve(object.path.replace(/^\\\\\?\\/, ""));
              if (
                this.store.database.prepare("SELECT 1 FROM source_files WHERE path=?").get(filePath) ||
                state.missingSources.some((missing) => normal(missing.path) === normal(filePath)) ||
                (source.kind !== "dsh" &&
                  (await lstat(`${filePath}.zst`).catch((error) => {
                    if (error.code === "ENOENT") return undefined;
                    throw error;
                  })))
              )
                throw unavailable("returned source or alternate representation requires full verification");
              const info = await stat(filePath);
              if (!info.isFile() || info.nlink !== 1) throw unavailable("new source alias changed");
              addedFiles.set(normal(filePath), {
                filePath,
                source,
                info,
                force: true,
                readMode: "incremental",
                additionIdentity: object,
              });
            }
            progressed = true;
          } else if (state.directoryCoverage !== 1 || (parent && state.watchedParents.includes(String(parent.path)))) {
            const object = await native.resolve(cursor.path, record.id);
            const resolved = object || (await native.resolve(cursor.path, record.parent));
            if (!resolved || resolved.attributes & 0x400 || resolved.links > 1) throw unavailable("unresolved change");
            const resolvedPath = normal(resolved.path);
            if (state.scopes.some((root) => within(resolvedPath, root) || (object && within(root, resolvedPath))))
              throw unavailable("uncatalogued source or discovery change");
          } else remaining.push(record);
        }
        pending = remaining;
      }
    }
    if (performance.now() > deadline) throw unavailable("change resolution budget exceeded");
    return {
      volumes,
      dirty: [...dirty].sort(),
      records,
      journalBytes,
      addedFiles: [...addedFiles.values()],
      directories,
    };
  }

  async file(filePath) {
    const row = this.store.database
      .prepare("SELECT * FROM usage_source_catalog WHERE path=? AND role='file'")
      .get(normal(filePath));
    const value = parse(row);
    if (!value?.supported || typeof value.filePath !== "string" || normal(value.filePath) !== row.path)
      throw unavailable("dependency outside supported sources");
    const source = this.store.database.prepare("SELECT * FROM source_files WHERE path=?").get(value.filePath);
    if (!source || !["main", "extra", "jetbrains", "codex", "dsh"].includes(String(source.kind)))
      throw unavailable("source binding changed");
    const info = await stat(value.filePath);
    if (!info.isFile() || info.nlink !== 1) throw unavailable("source alias changed");
    return {
      filePath: value.filePath,
      source: {
        id: String(source.home_id),
        kind: String(source.kind),
        path: String(source.home_path),
        label: String(source.home_label),
      },
      info,
      force: true,
      readMode: value.readMode || "incremental",
    };
  }

  async prepare(options, hints = null) {
    this.work = { mode: "fallback", reason: "not initialized" };
    if (this.store.database.isTransaction || this.store.writeTransactionDepth) return null;
    try {
      const dataVersion = Number(this.store.database.prepare("PRAGMA data_version").get().data_version);
      const state = this.state(options);
      if (state?.warnings.length) throw unavailable("source warnings require full verification");
      // shortcut: Hermes needs a full SQLite snapshot until WAL change proofs are available.
      if (this.store.database.prepare("SELECT 1 FROM source_files WHERE kind='hermes' LIMIT 1").get())
        throw unavailable("Hermes source requires a full snapshot");
      const native = state && (await this.provider());
      if (!native) return null;
      const inputs = await readUsageSourceInputs(options, state.homes, "");
      if (inputs.inputs !== state.auxiliary) throw unavailable("auxiliary input changed");
      // An open SQLite writer can change its WAL without another main-file journal record.
      const sqliteFiles = this.store.database
        .prepare("SELECT path FROM source_files WHERE kind IN ('zcode','opencode','hermes')")
        .all()
        .map((row) => ({ filePath: String(row.path) }));
      const fingerprints = await this.store.usageFileFingerprints(sqliteFiles);
      const catalogFile = this.store.database.prepare(
        "SELECT payload FROM usage_source_catalog WHERE path=? AND role='file'",
      );
      for (const [filePath, fingerprint] of fingerprints) {
        if (!fingerprint || fingerprint !== parse(catalogFile.get(normal(filePath)))?.fingerprint)
          throw unavailable("SQLite source or WAL changed");
      }
      const interval = await this.interval(state, native);
      const paths = new Set(interval.dirty);
      for (const row of this.store.database
        .prepare("SELECT source_path FROM usage_source_reparse LIMIT 2049")
        .iterate())
        paths.add(String(row.source_path));
      if (paths.size + interval.addedFiles.length > 2048) throw unavailable("dependency budget exceeded");
      const files = [...interval.addedFiles];
      for (const file of paths) files.push(await this.file(file));
      const preferred = new Set((hints?.paths || []).map((hint) => normal(hint.path)));
      files.sort((a, b) => Number(preferred.has(normal(b.filePath))) - Number(preferred.has(normal(a.filePath))));
      const plan = {
        ...state,
        volumes: interval.volumes,
        files,
        dataVersion,
        directories: interval.directories,
        fileCount: state.fileCount + interval.addedFiles.length,
      };
      this.work = {
        mode: "certified",
        selectedFiles: files.length,
        addedFiles: interval.addedFiles.length,
        addedDirectories: interval.directories.length,
        records: interval.records,
        journalBytes: interval.journalBytes,
      };
      return plan;
    } catch (error) {
      if (error.code !== "SOURCE_COVERAGE_UNAVAILABLE" && !["ENOENT", "EACCES", "EPERM"].includes(error.code))
        throw error;
      this.work = { mode: "fallback", reason: error.message };
      return null;
    }
  }

  async checkUnchanged(options) {
    const changes = Number(this.store.database.prepare("SELECT total_changes() n").get().n);
    const plan = await this.prepare(options);
    if (!plan || plan.files.length || plan.directories?.length) return null;
    const input = await readUsageSourceInputs(options, plan.homes, "");
    if (
      input.inputs !== plan.auxiliary ||
      Number(this.store.database.prepare("PRAGMA data_version").get().data_version) !== plan.dataVersion ||
      Number(this.store.database.prepare("SELECT total_changes() n").get().n) !== changes ||
      this.state(options)?.revision !== plan.revision
    )
      return null;
    const status = {
      fingerprint: plan.fingerprint,
      checkedAt: new Date().toISOString(),
      generatedAt: this.store.generatedAt,
      fileCount: plan.fileCount,
      homeCount: plan.homes.length,
      updatedFileCount: 0,
      missingSources: plan.missingSources,
      acquisition: {
        format: 1,
        homes: plan.homes,
        auxiliary: input.inputs,
        cuts: plan.volumes.map(({ volume, journalId, nextUsn }) => ({ volume, journalId, nextUsn })),
      },
    };
    // Save progress at half the existing journal budget, without regenerating unchanged facts.
    if (this.work.records >= 1024 || this.work.journalBytes >= 2 * 1024 * 1024) {
      this.store.homes = plan.homes;
      this.store.warnings = [...plan.warnings];
      const receipt = await this.complete(options, plan, [], status);
      if (!receipt) return null;
      status.acquisition = receipt;
    }
    return status;
  }

  put(filePath, object, role, payload) {
    this.store.database
      .prepare(`INSERT OR REPLACE INTO usage_source_catalog
      (path,volume,id64,id128,role,payload) VALUES(?,?,?,?,?,?)`)
      .run(normal(filePath), object.volume, object.id64, object.id128, role, JSON.stringify(payload));
  }

  async inventoryDirectory(directory, native) {
    if (
      this.store.database
        .prepare("SELECT 1 FROM usage_source_catalog WHERE path=? AND role='directory'")
        .get(normal(directory))
    )
      return;
    const object = await native.object(directory);
    if (!object || !(object.attributes & 16) || object.attributes & 0x400)
      throw unavailable("directory coverage unavailable");
    this.put(directory, object, "directory", {});
    const entries = await opendir(directory);
    for await (const entry of entries) {
      if (entry.isSymbolicLink()) throw unavailable("reparse entry in source directory");
      if (entry.isDirectory()) await this.inventoryDirectory(path.join(directory, entry.name), native);
    }
  }

  async capture(file, native, bootstrap = false) {
    const info = await stat(file.filePath);
    const object = await native.object(file.filePath);
    if (object?.links !== 1 || object.attributes & 0x400) throw unavailable("source identity unavailable");
    if (
      file.additionIdentity &&
      (object.volume !== file.additionIdentity.volume ||
        object.id64 !== file.additionIdentity.id64 ||
        object.id128 !== file.additionIdentity.id128)
    )
      throw unavailable("new source identity changed before publication");
    const supported =
      ["main", "extra", "jetbrains", "codex", "dsh"].includes(file.source.kind) &&
      (file.source.kind === "dsh" || file.filePath.endsWith(".jsonl"));
    let seal = progressSeal(this.store, file.filePath);
    const progress = supported ? readUsageSourceProgress(this.store.database, file.filePath) : null;
    const readMode = progress ? "incremental" : "full";
    let covered = true;
    if (supported && progress) {
      if (bootstrap && !(await this.store.recertifyUnchangedFile({ ...file, info }, progress))) {
        // Flush a concurrent append without acknowledging its unparsed bytes.
        if (!seal || !(await native.begin(file.filePath, 0, info)))
          throw unavailable("source checkpoint cannot be sealed");
      }
      seal = progressSeal(this.store, file.filePath);
      if (!seal || seal.volume !== object.volume || seal.id64 !== object.id64 || seal.id128 !== object.id128)
        throw unavailable("source checkpoint identity changed");
    } else if (supported && windowsSourceProofPosition(file.sourceValidation)) {
      seal = windowsSourceProofPosition(file.sourceValidation);
    } else {
      const fence = await native.begin(file.filePath, 0, info);
      const proof = fence && (await native.advance(file.filePath, fence, 0, info));
      if (!proof) throw unavailable("other source cannot be observed");
      seal = windowsSourceProofPosition(proof.validation);
      covered = false;
    }
    if (!seal || seal.volume !== object.volume || seal.id64 !== object.id64 || seal.id128 !== object.id128)
      throw unavailable("source observation identity changed");
    return {
      object,
      value: {
        filePath: file.filePath,
        source: file.source,
        supported,
        seal: seal.seal,
        fingerprint: file.acquisitionFingerprint,
        indexedAt: this.store.database.prepare("SELECT indexed_at FROM source_files WHERE path=?").get(file.filePath)
          ?.indexed_at,
        readMode,
        covered,
      },
    };
  }

  async complete(options, plan, files, status, bootstrap = false) {
    if (!plan) return null;
    try {
      const native = await this.provider();
      if (!native) throw unavailable("native helper unavailable");
      // Directory identities and files become authorized only with the final cut.
      for (const directory of plan.directories || []) {
        const current = await native.object(directory.path);
        if (
          !current ||
          current.volume !== directory.object.volume ||
          current.id64 !== directory.object.id64 ||
          current.id128 !== directory.object.id128 ||
          current.attributes & 0x400
        )
          throw unavailable("new directory changed before publication");
      }
      if (bootstrap) {
        this.store.database.exec("DELETE FROM usage_source_catalog");
        const directories = new Set(plan.guards);
        for (const file of files) {
          for (let dir = path.dirname(file.filePath); ; dir = path.dirname(dir)) {
            directories.add(dir);
            if (path.dirname(dir) === dir) break;
          }
        }
        for (const dir of directories) {
          const object = await native.object(dir);
          if (!object || object.attributes & 0x400) throw unavailable("directory identity unavailable");
          this.put(dir, object, "guard", {});
        }
        for (const scope of plan.scopes) {
          let info;
          try {
            info = await lstat(scope);
          } catch (error) {
            if (error.code === "ENOENT") continue;
            throw error;
          }
          if (info.isSymbolicLink()) throw unavailable("reparse source root");
          if (info.isDirectory()) await this.inventoryDirectory(scope, native);
        }
        for (const file of files) {
          // Single-file imports may live outside the discovered home tree.
          const parent = path.dirname(file.filePath);
          if (
            !this.store.database
              .prepare("SELECT 1 FROM usage_source_catalog WHERE path=? AND role='directory'")
              .get(normal(parent))
          ) {
            const object = await native.object(parent);
            if (!object || object.attributes & 0x400) throw unavailable("source parent unavailable");
            this.put(parent, object, "directory", {});
          }
        }
        plan.directoryCoverage = 1;
      }
      for (const file of files) {
        const captured = await this.capture(file, native, bootstrap);
        this.put(file.filePath, captured.object, "file", captured.value);
      }
      if (bootstrap) {
        const interval = await this.interval(plan, native, true);
        plan.volumes = interval.volumes;
        // Repair only to the captured cut. Do not chase writes arriving during this repair.
        if (interval.dirty.length) {
          const selected = [];
          for (const file of interval.dirty) selected.push(await this.file(file));
          const repaired = await this.store.syncRound({
            options,
            acquisitionPlan: {
              ...plan,
              files: selected,
              fingerprint: status.fingerprint,
              fileCount: status.fileCount,
              missingSources: status.missingSources,
              warnings: [...this.store.warnings],
            },
          });
          Object.assign(status, repaired);
          for (const file of this.store.acquisitionFiles) {
            const captured = await this.capture(file, native);
            this.put(file.filePath, captured.object, "file", captured.value);
          }
        }
      }
      const inputs = await readUsageSourceInputs(options, this.store.homes, "");
      if (inputs.inputs !== plan.auxiliary) throw unavailable("auxiliary inputs changed while synchronizing");
      const state = {
        format: 1,
        context: context(options),
        scopes: plan.scopes,
        volumes: plan.volumes,
        directoryCoverage: plan.directoryCoverage,
        watchedParents: plan.watchedParents,
        homes: this.store.homes,
        warnings: this.store.warnings,
        missingSources: status.missingSources,
        fingerprint: status.fingerprint,
        fileCount: status.fileCount,
        revision: revision(this.store),
        auxiliary: inputs.inputs,
      };
      this.store.database.exec("BEGIN IMMEDIATE");
      try {
        if (Number(this.store.database.prepare("PRAGMA data_version").get().data_version) !== plan.dataVersion)
          throw unavailable("external database commit during acquisition");
        for (const directory of plan.directories || []) this.put(directory.path, directory.object, "directory", {});
        this.store.database
          .prepare(`INSERT OR REPLACE INTO usage_source_catalog VALUES('','','','','state',?,1)`)
          .run(JSON.stringify(state));
        this.store.database.exec("COMMIT");
      } catch (error) {
        this.store.database.exec("ROLLBACK");
        throw error;
      }
      return {
        format: 1,
        homes: state.homes,
        auxiliary: inputs.inputs,
        cuts: state.volumes.map(({ volume, journalId, nextUsn }) => ({ volume, journalId, nextUsn })),
      };
    } catch (error) {
      this.invalidate();
      this.work = { mode: "fallback", reason: error.message };
      if (error.code !== "SOURCE_COVERAGE_UNAVAILABLE" && !["ENOENT", "EACCES", "EPERM"].includes(error.code))
        throw error;
      return null;
    }
  }
}
