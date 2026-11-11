import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const config = JSON.parse(fs.readFileSync(process.env.LOCAL_SUMMARY_CASE_CONFIG, "utf8"));
await import(pathToFileURL(path.resolve("docs/validation/2026-10-29-local-summary-adoption/probes/hook.mjs")).href);
globalThis.__rustProfile = (stage, extra = {}) => {
  fs.appendFileSync(config.stageFile, JSON.stringify({at:performance.timeOrigin+performance.now(),pid:process.pid,stage,...process.memoryUsage(),maxRssKiB:process.resourceUsage().maxRSS,...extra})+"\n");
  if(process.env.RUST_PROFILE_GC==="1"&&globalThis.gc&&["perf.start","perf.selection.done"].includes(stage)) {
    globalThis.gc();
    fs.appendFileSync(config.stageFile, JSON.stringify({at:performance.timeOrigin+performance.now(),pid:process.pid,stage:stage+".after-gc",...process.memoryUsage(),maxRssKiB:process.resourceUsage().maxRSS,...extra})+"\n");
  }
};
globalThis.__rustProfileValue = (stage, run) => {
  globalThis.__rustProfile(stage+".start");
  try { return run(); } finally { globalThis.__rustProfile(stage+".done"); }
};
const { UsageStore } = await import(pathToFileURL(path.join(config.sourceRoot,"src/usage-store.js")).href);
const names = ["open","dashboardHistory","summarizeHistory","summarizeInReadTransactionCore","aggregateRange","timelineRange","costEstimateRange","perfSummaryForRange","buildPerfSummaryForRange","capturePerfCarrier","metadataHistory","periodComparisonHistory","periodAggregateCore","summaryProjectionKeys"];
for(const name of names) {
  const original=UsageStore.prototype[name];
  if(typeof original!=="function")throw Error("Missing profile method "+name);
  UsageStore.prototype[name]=function(...args){
    globalThis.__rustProfile(name+".start");
    let result;
    try {result=original.apply(this,args);}catch(error){globalThis.__rustProfile(name+".error");throw error;}
    if(result&&typeof result.then==="function")return result.finally(()=>globalThis.__rustProfile(name+".done"));
    globalThis.__rustProfile(name+".done");return result;
  };
}
for(const name of ["costEventsForRange","perfCandidatesForRange","unplacedPerfSamples"]){
 const original=UsageStore.prototype[name];
 UsageStore.prototype[name]=function(...args){
   const rows=original.apply(this,args);
   if(!rows||!rows[Symbol.iterator]||Array.isArray(rows))return rows;
   return(function*(){let count=0;globalThis.__rustProfile(name+".rows.start");try{for(const row of rows){count++;if(count%2000===0)globalThis.__rustProfile(name+".rows",{count});yield row;}}finally{globalThis.__rustProfile(name+".rows.done",{count});}})();
 };
}
globalThis.__rustProfile("process.ready");
