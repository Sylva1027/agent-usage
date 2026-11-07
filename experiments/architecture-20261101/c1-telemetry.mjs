import "./first-update-telemetry.mjs";
import "./archive-verification-telemetry.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export function businessAsOf() {
  assert.ok(process.env.C1_BUSINESS_CLOCK_FILE, "year replay requires a clock file");
  const clock = JSON.parse(readFileSync(process.env.C1_BUSINESS_CLOCK_FILE, "utf8"));
  assert.equal(new Date(clock.asOf).toISOString(), clock.asOf, "invalid replay business asOf");
  assert.ok(clock.phase && clock.referencePhase, "missing replay phase");
  const directory = process.env.REMAINING_DELIVERY_TRACE;
  if (directory) appendFileSync(path.join(directory, `business-clock-${process.pid}.ndjson`), JSON.stringify({ ...clock, readAtMs: Date.now() }) + "\n");
  return new Date(clock.asOf);
}

export function projectionStorage(state) {
  const directory = path.join(state, "usage-index.sqlite.history-cache");
  const pointer = name => {
    try { return JSON.parse(readFileSync(path.join(directory, name), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  try {
    const current = pointer("current.json"), candidate = pointer("candidate.json"), files = [];
    for (const name of readdirSync(directory)) {
      try {
        const info = statSync(path.join(directory, name));
        if (info.isFile()) files.push({ name, bytes: info.size });
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const databases = files.filter(file => file.name.endsWith(".sqlite"));
    return { directory, present: true, current, candidate, files, databaseCount: databases.length,
      orphanDatabases: databases.filter(file => ![current?.file, candidate?.file].includes(file.name)).map(file => file.name),
      publishedBytes: files.filter(file => file.name === current?.file).reduce((n, file) => n + file.bytes, 0),
      candidateBytes: files.filter(file => file.name === candidate?.file).reduce((n, file) => n + file.bytes, 0),
      maintenanceLockBytes: files.filter(file => /^maintenance\.lock(?:$|-)/.test(file.name)).reduce((n, file) => n + file.bytes, 0),
      walBytes: files.filter(file => file.name.endsWith("-wal")).reduce((n, file) => n + file.bytes, 0),
      totalBytes: files.reduce((n, file) => n + file.bytes, 0) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { directory, present: false, current: null, candidate: null, files: [], databaseCount: 0, orphanDatabases: [],
      publishedBytes: 0, candidateBytes: 0, maintenanceLockBytes: 0, walBytes: 0, totalBytes: 0 };
  }
}

export function methodDiagnostics(prototype, names, owner) {
  for (const name of names) {
    const original = prototype[name];
    if (typeof original !== "function") continue;
    prototype[name] = function(...args) {
      const startedAtMs = Date.now(), started = performance.now(), before = this.summaryProjectionCache;
      const finish = error => appendFileSync(path.join(process.env.REMAINING_DELIVERY_TRACE, `method-${process.pid}.ndjson`),
        JSON.stringify({ pid: process.pid, method: `${owner}.${name}`, startedAtMs, endedAtMs: Date.now(), durationMs: performance.now() - started,
          error: error === undefined ? undefined : String(error?.stack || error), verifiedHistorySqlRead: this.verifiedHistorySqlRead === true,
          summaryProjectionCacheReused: before != null && before === this.summaryProjectionCache }) + "\n");
      let result;
      try { result = original.apply(this, args); }
      catch (error) { finish(error); throw error; }
      if (result?.then) return result.then(value => { finish(); return value; }, error => { finish(error); throw error; });
      finish(); return result;
    };
  }
}

if (process.env.REMAINING_DELIVERY_TRACE) registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.endsWith("/src/usage-source-rows.js")) return { ...result, source: `${result.source}\n
import {appendFileSync as c1SpoolAppend} from 'node:fs';
import c1SpoolPath from 'node:path';
const c1SpoolStart=Symbol(),c1SpoolReported=Symbol();
const c1SpoolOriginalSpill=UsageSourceRows.prototype.spill,c1SpoolOriginalClose=UsageSourceRows.prototype.close;
UsageSourceRows.prototype.spill=function(...args){
 this[c1SpoolStart]??=Date.now();return c1SpoolOriginalSpill.apply(this,args);
};
UsageSourceRows.prototype.close=function(...args){
 let failed=false,error;
 try{return c1SpoolOriginalClose.apply(this,args);}
 catch(failure){failed=true;error=String(failure?.stack||failure);throw failure;}
 finally{if(!this[c1SpoolReported])try{
  const stats=this.stats;
  if(stats.spilled){this[c1SpoolReported]=true;c1SpoolAppend(c1SpoolPath.join(process.env.REMAINING_DELIVERY_TRACE,'spool-'+process.pid+'.ndjson'),
   JSON.stringify({pid:process.pid,start:this[c1SpoolStart],end:Date.now(),stats,error})+'\\n');}
 }catch(telemetryError){if(!failed)throw telemetryError;}}
};\n` };
    if (url.endsWith("/src/server.js") && process.env.C1_BUSINESS_CLOCK_FILE) {
      const marker = "const asOf = frozen?.asOf || new Date();", source = String(result.source);
      assert.equal(source.split(marker).length, 2, "C1 /api/usage active business asOf binding changed");
      let replayed = source.replace(marker, "const asOf = frozen?.asOf || c1ReplayAsOf();");
      if (source.includes("function usageVersion(")) {
        const status = "const catalog = localPricingCatalog();\n        const asOf = new Date();";
        const notice = "usageVersion(status?.fingerprint, publishedSource, catalog)";
        assert.equal(source.split(status).length, 2, "C1 status calendar binding changed");
        assert.equal(source.split(notice).length, 2, "C1 notification calendar binding changed");
        replayed = replayed.replace(status, status.replace("new Date()", "c1ReplayAsOf()"))
          .replace(notice, "usageVersion(status?.fingerprint, publishedSource, catalog, c1ReplayAsOf())");
      }
      return { ...result, source: replayed +
        `\nimport {businessAsOf as c1ReplayAsOf} from ${JSON.stringify(import.meta.url)};\n` };
    }
    if (url.endsWith("/src/history-backup.js")) {
      if (!/async function hashFile\(file\)/.test(String(result.source))) throw Error("C1 archive hash binding changed");
      return { ...result, source: `${result.source}\n
import {appendFileSync as c1ArchiveAppend} from 'node:fs';
import c1ArchivePath from 'node:path';
const c1ArchiveOriginalHash = hashFile;
hashFile = async function(file) {
 const startedAtMs=Date.now(),started=performance.now();let result,error;
 try{result=await c1ArchiveOriginalHash(file);return result;}
 catch(failure){error=String(failure.stack||failure);throw failure;}
 finally{c1ArchiveAppend(c1ArchivePath.join(process.env.REMAINING_DELIVERY_TRACE,'archive-proof-'+process.pid+'.ndjson'),
  JSON.stringify({pid:process.pid,file,startedAtMs,endedAtMs:Date.now(),durationMs:performance.now()-started,
   bytes:result?.bytes??null,sha256:result?.sha256??null,error})+'\\n');}
};\n` };
    }
    if (url.endsWith("/src/usage-summary-cache.js") && process.env.C1_METHOD_DIAGNOSTIC === "1") return {
      ...result, source: `${result.source}\nimport {methodDiagnostics as c1MethodDiagnostics} from ${JSON.stringify(import.meta.url)};
c1MethodDiagnostics(UsageSummaryCache.prototype,['readSourceState'],'UsageSummaryCache');\n`,
    };
    if (!url.endsWith("/src/usage-store.js")) return result;
    return { ...result, source: `${result.source}\n
import {appendFileSync as c1HistoryAppend} from 'node:fs';
import c1HistoryPath from 'node:path';
import {projectionStorage as c1ProjectionStorage} from ${JSON.stringify(import.meta.url)};
const c1HistoryOriginal = UsageStore.prototype.withSqlHistoryReader;
UsageStore.prototype.withSqlHistoryReader = async function(...args) {
 const startedAtMs=Date.now();let error;
 try{return await c1HistoryOriginal.apply(this,args);}
 catch(failure){error=String(failure.stack||failure);throw failure;}
 finally{c1HistoryAppend(c1HistoryPath.join(process.env.REMAINING_DELIVERY_TRACE,'history-'+process.pid+'.ndjson'),
  JSON.stringify({pid:process.pid,startedAtMs,endedAtMs:Date.now(),work:this.lastHistoryQueryWork,error,
   projectionStorage:c1ProjectionStorage(c1HistoryPath.dirname(this.databaseFile)),
   inputVersion:this.historyProjectionModule?.readHistoryProjectionStamp(this.database),
   publishedVersion:this.historyProjectionStore?.query?.database.prepare('SELECT * FROM usage_history_projection_cache WHERE singleton=1').get(),
   tempPages:this.database?.prepare('PRAGMA temp.page_count').get(),memory:process.memoryUsage()})+'\\n');}
};
const c1FastHistoryOriginal = UsageStore.prototype.trySingleSqlHistoryDashboard;
if(typeof c1FastHistoryOriginal==='function') UsageStore.prototype.trySingleSqlHistoryDashboard = async function(...args) {
 const startedAtMs=Date.now(),started=performance.now(),before=this.historySqlDashboardCache?.store?.summaryProjectionCache;
 const result=await c1FastHistoryOriginal.apply(this,args);
 if(result!=null){
  const cache=this.historySqlDashboardCache;
  // The existing cache key already contains the verified segment record; no extra SQL or hash.
  const record=JSON.parse(cache.key)[2];
  c1HistoryAppend(c1HistoryPath.join(process.env.REMAINING_DELIVERY_TRACE,'fast-history-'+process.pid+'.ndjson'),
   JSON.stringify({pid:process.pid,startedAtMs,endedAtMs:Date.now(),durationMs:performance.now()-started,
    path:'single-archive-all',success:true,requestedPreset:args[0]?.preset,preset:result.summary?.range?.preset,
    bucket:args[0]?.bucket||'day',resolvedBucket:result.summary?.range?.bucket,segmentId:record.segment_id,
    summaryProjectionCacheReused:before!=null&&before===cache.store?.summaryProjectionCache})+'\\n');
 }
 return result;
};
${process.env.C1_METHOD_DIAGNOSTIC === "1" ? `import {methodDiagnostics as c1MethodDiagnostics} from ${JSON.stringify(import.meta.url)};
c1MethodDiagnostics(UsageStore.prototype,['checkSources','summarizeInReadTransaction','metadata','periodComparison'],'UsageStore');` : ""}\n` };
  },
});
