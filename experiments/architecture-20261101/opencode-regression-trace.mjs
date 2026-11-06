import "./first-update-telemetry.mjs";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";

const rows = [];
let dropped = 0;
globalThis.__ocTrace = (value) => {
  if (rows.length < 8192) rows.push({ pid: process.pid, at: Date.now(), ...value });
  else dropped++;
};
globalThis.__ocMeasure = (target, names, prefix) => {
  for (const name of names) {
    const original = target[name];
    assert.equal(typeof original, "function", `${prefix}.${name}`);
    target[name] = function (...args) {
      const start = Date.now(), clock = performance.now(), cpu = process.cpuUsage();
      const state = () => name === "prepareAllSummaryProjection"
        ? this.database?.prepare("SELECT context_key,status,target_revision,published_revision,force_rebuild FROM usage_all_summary_state WHERE singleton=1").get() : undefined;
      const before = state();
      const end = (value, error) => {
        const durationMs = performance.now() - clock;
        if (name !== "open" || durationMs >= 0.3) globalThis.__ocTrace({ name: `${prefix}.${name}`, start, durationMs,
          cpu: process.cpuUsage(cpu), preset: args[0]?.preset, error: error?.message,
          ...(name === "prepareAllSummaryProjection" ? { before, after: state(), work: this.lastAllSummaryWork } : {}),
          ...(name === "prepareHotRollups" ? { work: this.lastRollupWork } : {}),
          ...(name === "prepareMetadataProjection" ? { work: this.lastMetadataWork } : {}),
          ...(name === "get" ? { hit: Boolean(value) } : {}) });
        return value;
      };
      try {
        const value = original.apply(this, args);
        return value?.then ? value.then((v) => end(v), (e) => { end(null, e); throw e; }) : end(value);
      } catch (error) { end(null, error); throw error; }
    };
  }
};
process.once("exit", () => {
  if (process.env.REMAINING_DELIVERY_TRACE) appendFileSync(path.join(process.env.REMAINING_DELIVERY_TRACE,
    `detail-${process.pid}.ndjson`), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n${JSON.stringify({ dropped })}\n`);
});

registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!/\/src\/usage-(?:core|store|summary-cache|executor)\.js$/.test(url)) return result;
  let source = String(result.source);
  if (url.endsWith("/src/usage-core.js")) {
    for (const name of ["discoverUsageSources", "buildUsageFingerprint"]) {
      const marker = `export async function ${name}(`;
      assert.ok(source.includes(marker), marker);
      source = source.replace(marker, `async function ocOriginal_${name}(`);
      source += `\nexport async function ${name}(...args) {
        const start=Date.now(),clock=performance.now();
        try{return await ocOriginal_${name}(...args);}
        finally{globalThis.__ocTrace({name:'core.${name}',start,durationMs:performance.now()-clock});}
      }`;
    }
  }
  if (url.endsWith("/src/usage-store.js")) source += `\n globalThis.__ocMeasure(UsageStore.prototype,
    ['open','usageFiles','syncRound','dashboardHistory','prepareAllSummaryProjection','prepareRecordProjection',
    'prepareMetadataProjection','prepareHotRollups','prepareQuotaProjection','summarizeInReadTransactionCore','metadata','periodComparison'],'store');`;
  if (url.endsWith("/src/usage-summary-cache.js")) source += `\n globalThis.__ocMeasure(UsageSummaryCache.prototype,
    ['readSourceState','readCertifiedSourceState','readPublication','get','publish','stateFor','retainedState'],'cache');`;
  if (url.endsWith("/src/usage-executor.js")) {
    for (const [marker, insert] of [
      ['const executeMessage = async (message) => {', "globalThis.__ocTrace({name:'ipc-received',id:message.id,type:message.type,version:message.pricing?.version});"],
      ['const handle = async (message) => {', "globalThis.__ocTrace({name:'ipc-execute',id:message.id,type:message.type,version:message.pricing?.version});"],
    ]) {
      assert.ok(source.includes(marker), marker);
      source = source.replace(marker, `${marker}${insert}`);
    }
  }
  return { ...result, source };
} });
