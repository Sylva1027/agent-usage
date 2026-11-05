import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Import the existing loader without its environment-driven auto-registration.
const configPath = process.env.Q6_PERFORMANCE_CONFIG;
delete process.env.Q6_PERFORMANCE_CONFIG;
const { createQ6PerformanceHook } = await import("./q6-performance-hook.mjs");
process.env.Q6_PERFORMANCE_CONFIG = configPath;
assert.ok(configPath);
const config = JSON.parse(readFileSync(configPath, "utf8"));
const existing = createQ6PerformanceHook(config);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const file = path.join(config.output, `reopen-${process.pid}.ndjson`);
const hash = (value) => createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
const emit = (row) => appendFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), ...row }) + "\n");
globalThis.__q7Wrap = (original, name) => function (...args) {
  const start = performance.timeOrigin + performance.now();
  const capture = (value, error) => {
    const work = this.lastAllSummaryWork;
    const row = { name, start, duration: performance.timeOrigin + performance.now() - start,
      error: error?.message, preset: args[0]?.preset, work: name === "prepareAllSummaryProjection" ? work : undefined,
      quotaWork: name === "prepareQuotaProjection" ? this.lastQuotaWork : undefined,
      metadataWork: name === "prepareMetadataProjection" ? this.lastMetadataWork : undefined,
      rollupWork: name === "prepareHotRollups" ? this.lastRollupWork : undefined };
    if (name === "allSummaryOptions" || name === "recordProjectionOptions") {
      row.context = { key: value?.key, eligible: Boolean(value), evidence: hash(this.serviceTierEvidenceInput),
        homes: hash(this.homes), schema: this.database?.prepare("PRAGMA main.schema_version").get()?.schema_version };
    }
    emit(row);
    return value;
  };
  try {
    const value = original.apply(this, args);
    return value?.then ? value.then((result) => capture(result), (error) => { capture(null, error); throw error; }) : capture(value);
  } catch (error) { capture(null, error); throw error; }
};
registerHooks({ load(url, context, next) {
  const result = existing.load(url, context, next);
  if (!url.startsWith("file:")) return result;
  const relative = path.relative(root, fileURLToPath(url)).replaceAll(path.sep, "/");
  if (!config.diagnostic) {
    if (relative === "src/usage-store.js") return { ...result, source: result.source + `\nif(typeof UsageStore.prototype.checkSources==='function')
      UsageStore.prototype.checkSources=globalThis.__q6Wrap(UsageStore.prototype.checkSources,'store.checkSources');\n` };
    return result;
  }
  if (relative === "src/usage-store.js") {
    const names = ["open", "dashboardHistory", "summarizeHistory", "summarizeInReadTransactionCore",
      "prepareHotRollups", "prepareQuotaProjection", "prepareRecordProjection", "prepareAllSummaryProjection",
      "prepareMetadataProjection", "metadataHistory", "periodComparisonHistory", "allSummaryOptions", "recordProjectionOptions"];
    return { ...result, source: result.source + `\nfor(const name of ${JSON.stringify(names)}) {
      const fn=UsageStore.prototype[name];if(typeof fn==='function')UsageStore.prototype[name]=globalThis.__q7Wrap(fn,name);
    }\n` };
  }
  if (relative === "src/usage-summary-cache.js") return { ...result, source: result.source + `\nfor(const name of ['get','publish','stateFor','readPublication']) {
    const fn=UsageSummaryCache.prototype[name];if(typeof fn==='function')UsageSummaryCache.prototype[name]=globalThis.__q7Wrap(fn,'cache.'+name);
  }\n` };
  return result;
} });
