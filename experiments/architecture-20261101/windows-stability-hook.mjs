import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";

/* Experiment only. Load the gateway with both --import c1-telemetry.mjs and
 * --import windows-stability-hook.mjs; executor fork inherits process.execArgv.
 * NODE_OPTIONS="--import=file:///.../windows-stability-hook.mjs" also works for
 * direct entry points, but c1-run.launch deletes NODE_OPTIONS. Main uses its own
 * tiny --serve entry with explicit imports; this hook never edits c1-run.
 *
 * Set WINDOWS_STABILITY_CONTROL_DIR to a private directory. Atomically rename a
 * complete JSON file into drop-watch-hint.json: {id:"lost-hint-1"}, or into
 * pause-sync.json: {id:"crash-1",point:"before-commit"}, with the alternative
 * point "after-commit-before-notify". Optional executorPid/sourcePath narrow a
 * pause to that executor/source. Arm before the sync; do not replace an armed
 * command. Consumption renames it to <name>.<id>.claimed.json, once across PIDs.
 * Tail events-<pid>.ndjson for fault-parked, then kill precisely its pid. The
 * parked process cannot progress; after 30s it fails instead of resuming.
 *
 * after-commit-before-notify means successful UsageStore.sync (including source
 * acquisition completion), before returning to executor checkpoint/postState.
 * before-commit covers the three source-fact COMMIT sites, excluding schema,
 * metadata, recertification and projection-only commits. No fact commit means
 * no pause. This does not claim every file in a multi-file sync is atomic.
 *
 * Prices: use existing PUT /api/pricing (GET then edit the real catalog); direct
 * file writes alone are not reloaded by a running gateway. Evidence: mutate the
 * isolated real evidence input and let normal discovery run. No fake API.
 * Resource rows contain cumulative native resourceUsage and per-span cpuUsage;
 * SIGKILL has no JS exit handler: combine fault-parked + executor-exit with the
 * existing 250ms Windows sampler for final CPU/I/O/high-water evidence.
 */
const directory = process.env.WINDOWS_STABILITY_CONTROL_DIR;
const role = process.env.CODEX_USAGE_EXECUTOR_CHILD === "1" ? "executor" : "gateway";
const instance = randomUUID(), startedAtMs = Date.now() - process.uptime() * 1000;
const active = new AsyncLocalStorage();
const parked = new Int32Array(new SharedArrayBuffer(4));
let sequence = 0, serialDepth = 0;

function resources() {
  return { cpu: process.cpuUsage(), usage: process.resourceUsage(), memory: process.memoryUsage() };
}

export function mark(event, details = {}) {
  if (!directory) return;
  const context = active.getStore();
  appendFileSync(path.join(directory, `events-${process.pid}.ndjson`), JSON.stringify({
    event, pid: process.pid, ppid: process.ppid, instance, startedAtMs, role, atMs: Date.now(),
    requestId: context?.requestId, syncId: context?.sync?.id, roundId: context?.roundId, ...details,
  }) + "\n");
}

function command(name) {
  let value;
  try { value = JSON.parse(readFileSync(path.join(directory, `${name}.json`), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    mark("control-error", { name, error: String(error) });
    throw error;
  }
  try {
    assert.ok(value && typeof value === "object", "control must be an object");
    assert.match(value.id, /^[a-zA-Z0-9_-]{1,80}$/, "control id must be a short filename-safe string");
    if (name === "pause-sync") {
      assert.ok(["before-commit", "after-commit-before-notify"].includes(value.point), "unknown fault point");
      if (value.executorPid !== undefined) assert.ok(Number.isSafeInteger(value.executorPid) && value.executorPid > 0);
      if (value.sourcePath !== undefined) assert.ok(typeof value.sourcePath === "string" && path.isAbsolute(value.sourcePath));
    }
  } catch (error) { mark("control-error", { name, error: String(error) }); throw error; }
  return value;
}

function claim(name, value) {
  try { renameSync(path.join(directory, `${name}.json`), path.join(directory, `${name}.${value.id}.claimed.json`)); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  mark("control-consumed", { name, commandId: value.id });
  return true;
}

function matches(value, point, source) {
  return value?.point === point && (value.executorPid === undefined || value.executorPid === process.pid) &&
    (value.sourcePath === undefined || path.resolve(value.sourcePath) === path.resolve(source.filePath));
}

function park(value, details) {
  mark("fault-parked", { commandId: value.id, point: value.point, ...details, ...resources() });
  Atomics.wait(parked, 0, 0, 30_000);
  mark("fault-timeout", { commandId: value.id, point: value.point, ...resources() });
  throw new Error(`Windows stability driver did not kill parked executor: ${value.id}`);
}

export function watchHint(hints, onHint) {
  const value = command("drop-watch-hint");
  const details = { paths: hints.paths.length, unknown: hints.unknown, firstPath: hints.paths[0]?.path };
  if (value && claim("drop-watch-hint", value)) {
    mark("watch-hint-dropped", { commandId: value.id, ...details });
    return;
  }
  mark("watch-hint", details);
  return onHint?.(hints);
}

export function factCommit(store, database, commit, source) {
  const context = active.getStore(), sync = context?.sync;
  const details = { ...source, roundId: context?.roundId, databaseFile: store.databaseFile, transaction: database.isTransaction };
  const value = role === "executor" && sync ? command("pause-sync") : null;
  if (matches(value, "before-commit", source) && claim("pause-sync", value)) park(value, details);
  const result = commit();
  if (sync) {
    sync.commits += 1;
    if (matches(value, "after-commit-before-notify", source)) sync.after = { value, details };
  }
  mark("fact-commit", { ...details, commits: sync?.commits, ...resources() });
  return result;
}

function wrap(prototype, name, invoke) {
  const original = prototype[name];
  assert.equal(typeof original, "function", `Windows stability method changed: ${name}`);
  prototype[name] = function (...args) { return invoke.call(this, original, args); };
}

export function instrumentStore(prototype) {
  wrap(prototype, "sync", async function (original, args) {
    const parent = active.getStore();
    if (parent?.sync?.store === this) return original.apply(this, args);
    const sync = { id: `${instance}:${++sequence}`, store: this, commits: 0, after: null };
    return active.run({ ...parent, sync }, async () => {
      const start = performance.now(), cpu = process.cpuUsage();
      mark("sync-start", { databaseFile: this.databaseFile, certifiedOnly: args[0]?.certifiedOnly === true, ...resources() });
      let result, error;
      try {
        result = await original.apply(this, args);
        if (sync.after) {
          const { value, details } = sync.after, current = command("pause-sync");
          if (current?.id === value.id && matches(current, value.point, details) && claim("pause-sync", current))
            park(current, { ...details, transaction: this.database.isTransaction, commits: sync.commits, fingerprint: result?.fingerprint });
        }
        return result;
      } catch (failure) { error = String(failure.stack || failure); throw failure; }
      finally {
        mark("sync-end", { durationMs: performance.now() - start, cpuDelta: process.cpuUsage(cpu),
          commits: sync.commits, updatedFiles: result?.updatedFileCount, fingerprint: result?.fingerprint,
          acquisitionWork: this.lastAcquisitionWork, error, ...resources() });
      }
    });
  });
  wrap(prototype, "syncRound", async function (original, args) {
    const context = active.getStore(), roundId = `${instance}:${++sequence}`;
    return active.run({ ...context, roundId }, async () => {
      const start = performance.now(), cpu = process.cpuUsage();
      mark("round-start", { databaseFile: this.databaseFile });
      let result, error;
      try { result = await original.apply(this, args); return result; }
      catch (failure) { error = String(failure.stack || failure); throw failure; }
      finally {
        mark("round-end", { durationMs: performance.now() - start, cpuDelta: process.cpuUsage(cpu),
          updatedFiles: result?.updatedFileCount, fingerprint: result?.fingerprint, sourceWork: this.lastSyncSourceWork,
          rollupWork: this.lastSyncRollupWork, error, ...resources() });
      }
    });
  });
  for (const name of ["reuseSourcePrefix", "replaceFile", "appendFile"]) wrap(prototype, name, async function (original, args) {
    const start = performance.now();
    let result, error;
    try { result = await original.apply(this, args); return result; }
    catch (failure) { error = String(failure.stack || failure); throw failure; }
    finally {
      mark("source-end", { method: name, filePath: args[0].filePath, kind: args[0].source.kind,
        durationMs: performance.now() - start, committed: result?.committed === true, appended: result?.appended,
        reusedEvents: result?.reusedEvents, insertedEvents: result?.insertedEvents, parsedBytes: result?.parsedBytes, error });
    }
  });
}

export function instrumentProjection(prototype) {
  for (const name of ["prepare", "applyDelta", "publish"]) wrap(prototype, name, function (original, args) {
    const start = performance.now();
    let error;
    try { return original.apply(this, args); }
    catch (failure) { error = String(failure.stack || failure); throw failure; }
    finally {
      // Snapshots of the same work object are not additive counters.
      mark("projection", { method: name, directory: this.directory, file: this.file, candidateFile: this.candidateFile,
        durationMs: performance.now() - start, work: this.work,
        coldCopied: this.work?.coldCopied ?? null, fullRebuild: this.work?.rebuilt ?? null, error });
    }
  });
}

export function projectionSource(query, captured, row, work) {
  const kind = captured.prepare("SELECT kind FROM source_files WHERE path=?").get(row.path)?.kind ||
    query.database.prepare("SELECT kind FROM source_files WHERE path=?").get(row.path)?.kind;
  if (kind !== "zcode") return work();
  const counts = query.database.prepare("SELECT COALESCE(SUM(added),0) added,COALESCE(SUM(removed),0) removed FROM history_query_changes");
  const before = counts.get(), result = work(), after = counts.get();
  const added = Number(after.added) - Number(before.added), removed = Number(after.removed) - Number(before.removed);
  mark("zcode-projection-delta", { sourcePath: row.path, mode: row.mode, added, removed, netAdded: added - removed });
  return result;
}

export function serial(operation) {
  const queueId = `${instance}:${++sequence}`, queuedAtMs = Date.now();
  serialDepth += 1;
  mark("serial-queued", { queueId, depth: serialDepth });
  return async () => {
    mark("serial-start", { queueId, depth: serialDepth, queuedAtMs });
    try { return await operation(); }
    finally { serialDepth -= 1; mark("serial-end", { queueId, depth: serialDepth }); }
  };
}

export function ipc(direction, message) {
  mark("ipc", { direction, type: message.type, requestId: message.id, ok: message.ok,
    fingerprint: message.state?.status?.fingerprint, checkedAt: message.state?.checkedAt,
    pricingVersion: message.pricing?.version, errorCode: message.error?.code });
}

export function request(message, operation) {
  return active.run({ requestId: message.id }, operation);
}

export function instrument(url, input) {
  if (!/\/src\/(?:usage-store|usage-executor|usage-source-watch|usage-history-projection-store|server)\.js$/.test(url)) return input;
  let source = String(input);
  const replace = (from, to) => {
    assert.equal(source.split(from).length, 2, `Windows stability anchor changed: ${url}: ${from}`);
    source = source.replace(from, to);
  };
  if (url.endsWith("/src/usage-store.js")) {
    for (const name of ["reuseSourcePrefix", "replaceFile", "appendFile"]) {
      const start = source.indexOf(`  async ${name}(`), end = source.indexOf("\n  }", start);
      assert.ok(start >= 0 && end > start, `Windows stability fact method changed: ${name}`);
      const part = source.slice(start, end), anchor = 'database.exec("COMMIT");';
      assert.equal(part.split(anchor).length, 2, `Windows stability fact COMMIT changed: ${name}`);
      source = source.slice(0, start) + part.replace(anchor,
        `wsFactCommit(this,database,()=>database.exec("COMMIT"),{method:${JSON.stringify(name)},filePath,kind:source.kind});`) + source.slice(end);
    }
    source += "\nwsInstrumentStore(UsageStore.prototype);\n";
  } else if (url.endsWith("/src/usage-source-watch.js")) {
    replace("pending = onHint?.(hints);", "pending = wsWatchHint(hints,onHint);");
  } else if (url.endsWith("/src/usage-history-projection-store.js")) {
    const anchor = 'if (row.mode === "append") query.add(rows, "hot");\n        else query.replaceRows("hot", String(row.path), rows);';
    replace(anchor, `wsProjectionSource(query,captured,row,()=>{${anchor}});`);
    source += "\nwsInstrumentProjection(HistoryProjectionStore.prototype);\n";
  } else if (url.endsWith("/src/usage-executor.js")) {
    const syncCall = "nextStatus = await syncUsageStore(store, message.options, message.certifiedOnly, message.sourceHints);";
    replace(syncCall, "nextStatus = await wsRequest(message,()=>syncUsageStore(store, message.options, message.certifiedOnly, message.sourceHints));");
    replace("const result = syncBackupTail.then(operation);", "const result = syncBackupTail.then(wsSerial(operation));");
    replace('childProcess.on("message", (message) => {', 'childProcess.on("message", (message) => {wsIpc("receive",message);');
    replace("childSend.call(childProcess, message, (error) => {", 'wsIpc("send",message);childSend.call(childProcess, message, (error) => {');
    replace("    worker = created;", `    worker = created;
      wsMark('executor-spawn',{childPid:created.pid});
      created.once('exit',(code,signal)=>wsMark('executor-exit',{childPid:created.pid,code,signal}));`);
    replace('      const message = /** @type {any} */ (rawMessage);', '      const message = /** @type {any} */ (rawMessage);wsIpc("parent-receive",message);');
    replace("pending.set(id, { resolve, reject, timer, type });", "pending.set(id, { resolve, reject, timer, type });wsMark('request-queued',{requestId:id,type,childPid:target.pid,depth:pending.size});");
    replace("pending.delete(message.id);", "pending.delete(message.id);wsMark('request-finished',{requestId:message.id,type:entry.type,childPid:created.pid,depth:pending.size,ok:message.ok});");
    replace("    pending.clear();", "    wsMark('requests-rejected',{depth:pending.size,errorCode:error.code});pending.clear();");
  } else if (url.endsWith("/src/server.js")) {
    replace("    lastUsageEventVersion = version;", "    lastUsageEventVersion = version;wsMark('usage-notify',{...data,clients:usageEventClients.size});");
    replace("    if (syncPromise) {\n      return syncPromise;", "    if (syncPromise) {\n      wsMark('sync-joined');return syncPromise;");
  }
  return source + `\nimport {mark as wsMark,factCommit as wsFactCommit,watchHint as wsWatchHint,
    instrumentStore as wsInstrumentStore,instrumentProjection as wsInstrumentProjection,
    projectionSource as wsProjectionSource,serial as wsSerial,ipc as wsIpc,request as wsRequest} from ${JSON.stringify(import.meta.url)};\n`;
}

if (directory) {
  assert.ok(path.isAbsolute(directory), "WINDOWS_STABILITY_CONTROL_DIR must be absolute");
  mkdirSync(directory, { recursive: true });
  mark("process-born", { execArgv: process.execArgv, ...resources() });
  process.once("exit", code => mark("process-exit", { code, ...resources() }));
  registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    return { ...result, source: instrument(url, result.source) };
  } });
}
