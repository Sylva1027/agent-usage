import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";

const active = new AsyncLocalStorage();
let sequence = 0;
export function mark(stage, details = {}) {
  appendFileSync(path.join(process.env.REMAINING_DELIVERY_TRACE, `verification-${process.pid}.ndjson`),
    JSON.stringify({ pid: process.pid, atMs: Date.now(), stage, parentId: active.getStore(), ...details }) + "\n");
}
export function span(stage, work, details = {}) {
  const id = `${process.pid}:${++sequence}`, parentId = active.getStore(), startedAtMs = Date.now(), started = performance.now();
  const stack = new Error().stack;
  const finish = (value, error) => mark(stage, { id, parentId, startedAtMs, endedAtMs: Date.now(), durationMs: performance.now() - started,
    stack, ...details, bytes: value?.bytes, sha256: value?.sha256,
    rows: value?.rows, tableRows: value?.tables && Object.fromEntries(Object.entries(value.tables).map(([name, row]) => [name, row.rows])),
    error: error && String(error.stack || error) });
  return active.run(id, () => {
    let value;
    try { value = work(); } catch (error) { finish(undefined, error); throw error; }
    if (value?.then) return value.then(result => { finish(result); return result; }, error => { finish(undefined, error); throw error; });
    finish(value); return value;
  });
}
export function methods(prototype, names, owner) {
  for (const name of names) {
    if (typeof prototype[name] !== "function") continue;
    const original = prototype[name];
    prototype[name] = function(...args) { return span(`${owner}.${name}`, () => original.apply(this, args)); };
  }
}

export function instrument(url, input) {
  let source = String(input), extra = "";
  const wrap = (name, stage = name, required = true) => {
    const found = new RegExp(`(?:async )?function ${name}\\(`).test(source);
    if (required) assert.ok(found, `verification telemetry binding changed: ${name}`);
    if (found) extra += `\nconst avOriginal_${name}=${name};${name}=function(...args){return avSpan(${JSON.stringify(stage)},()=>avOriginal_${name}.apply(this,args));};`;
  };
  if (url.endsWith("/src/history-backup.js")) {
    if (source.includes("async function verifyHistoryBackupInScope(")) {
      const marker = "assertDatabaseHash(await hashFile(databasePath), manifest.database);";
      assert.equal(source.split(marker).length, 3, "scoped verification hash phases changed");
      for (const stage of ["sha-before-lock", "sha-inside-lock"]) source = source.replace(marker,
        `assertDatabaseHash(await avSpan('${stage}',()=>hashFile(databasePath),{file:databasePath}), manifest.database);`);
      source = source.replace('entry.database.exec("BEGIN");', 'entry.database.exec("BEGIN");avMark("read-transaction-begin",{file:databasePath});')
        .replace("entry.schema = assertSupportedSchema(entry.database);", "entry.schema = assertSupportedSchema(entry.database);avMark('read-transaction-pinned',{file:databasePath});")
        .replace("this.database.close();", "this.database.close();avMark('read-transaction-released',{file:databasePath});");
      wrap("verifyHistoryBackupInScope");
      wrap("archiveGuard", "archive-file-guard", false);
    } else {
    for (const [binding, stage] of [["databaseHash", "sha-before-lock"], ["pinnedHash", "sha-inside-lock"]]) {
      const marker = `const ${binding} = await hashFile(databasePath);`;
      assert.equal(source.split(marker).length, 2, `verification hash phase changed: ${binding}`);
      source = source.replace(marker, `const ${binding} = await avSpan('${stage}',()=>hashFile(databasePath),{file:databasePath});`);
    }
    }
    wrap("databaseEvidence"); wrap("verifyHistoryBackupWithReader");
    // Scope edits to the verifier, preserving the backup creation/restore paths.
    if (!source.includes("async function verifyHistoryBackupInScope(")) {
    const start = source.indexOf("async function verifyHistoryBackupWithReader("), end = source.indexOf("export async function loadHistoryBackupContext", start);
    assert.ok(start >= 0 && end > start);
    const part = source.slice(start, end).replace('database.exec("BEGIN");', 'database.exec("BEGIN");avMark("read-transaction-begin",{file:databasePath});')
      .replace("const schema = assertSupportedSchema(database);", "const schema = assertSupportedSchema(database);avMark('read-transaction-pinned',{file:databasePath});")
      .replace("database.close();", "database.close();avMark('read-transaction-released',{file:databasePath});");
    source = source.slice(0, start) + part + source.slice(end);
    }
  } else if (url.endsWith("/src/history-archive.js")) {
    for (const name of ["verifyHistoryArchiveCandidateWithReader", "candidateMetadata", "eventEvidence", "sourceEvidence"]) wrap(name);
    const range = /const outside = Number\([\s\S]*?\n\s+\);/;
    assert.ok(range.test(source), "candidate range telemetry binding changed");
    source = source.replace(range, text => text.replace("Number(", "avSpan('candidate.range',()=>Number(").replace(/\);$/, "));"));
  } else if (url.endsWith("/src/usage-store.js")) {
    for (const name of ["assertHistoryArchiveRecordMatches", "historyArchiveAuthorizedSegmentIds", "historyArchiveSourceIdentities",
      "validateHistoryArchiveSourceRevisions", "historyArchiveEventRevisions"]) wrap(name);
    extra += "\navMethods(UsageStore.prototype,['checkSources','syncRound','replaceFile','appendFile','acquirePublishedHistoryReader','withVerifiedPublishedHistoryRead','withSqlHistoryReaderCore','trySqlHistoryDashboard','trySingleSqlHistoryDashboard','summarizeInReadTransaction','metadata','periodComparison'],'UsageStore');";
  } else if (url.endsWith("/src/usage-history-projection-store.js")) {
    extra += "\navMethods(HistoryProjectionStore.prototype,['lock','openPublished','prepare','applyDelta','publish','close'],'HistoryProjectionStore');";
  } else if (url.endsWith("/src/usage-source-native.js")) {
    extra += "\navMethods(WindowsSourceProof.prototype,Object.getOwnPropertyNames(WindowsSourceProof.prototype).filter(name=>/guard|lock|lease|close/i.test(name)),'WindowsSourceProof');";
  } else if (url.endsWith("/src/usage-executor.js")) {
    const marker = "  function spawn() {";
    assert.equal(source.split(marker).length, 2, "executor spawn telemetry binding changed");
    source = source.replace(marker, `${marker}\navMark('executor-spawn-request',{stack:new Error().stack,existingPid:worker?.pid});`);
    const created = "    worker = created;";
    assert.equal(source.split(created).length, 2, "executor child identity binding changed");
    source = source.replace(created, `${created}\navMark('executor-spawned',{childPid:created.pid,stack:new Error().stack});`);
    extra += "\n";
  } else return input;
  return source + `\nimport {span as avSpan,mark as avMark,methods as avMethods} from ${JSON.stringify(import.meta.url)};\n` + extra;
}

if (process.env.C1_ARCHIVE_TRACE === "1" && process.env.REMAINING_DELIVERY_TRACE) {
  mark("process-born", { ppid: process.ppid, role: process.env.CODEX_USAGE_EXECUTOR_CHILD === "1" ? "executor" : "gateway",
    startedAtMs: Date.now() - process.uptime() * 1000, execArgv: process.execArgv });
  process.once("exit", code => mark("process-exit", { code, usage: process.resourceUsage() }));
  registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    return { ...result, source: instrument(url, result.source) };
  } });
}
