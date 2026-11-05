import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { BASE, ROOT, HERE, sha } from "./q9-benchmark.mjs";

export function sqlCounts(sql) {
  const compact = sql.replace(/\s+/g, " ").trim();
  const deletes = [...compact.matchAll(/(?:^|;)\s*DELETE\s+FROM\s+["`\[]?usage_source_catalog\b([^;]*)/gi)];
  return { catalogDeleteStatements: deletes.length,
    catalogClearStatements: deletes.filter((m) => !/\bWHERE\b/i.test(m[1])).length,
    wholeInventoryReads: /^SELECT\b/i.test(compact) && /\bFROM\s+(?:main\.)?(?:source_files|usage_source_catalog)\b/i.test(compact)
      && !/\bLIMIT\b|\b(?:path|id64|id128)\s*(?:=|IN\s*\()/i.test(compact) ? 1 : 0 };
}

const configFile = process.env.Q6_PERFORMANCE_CONFIG;
if (configFile) {
  delete process.env.Q6_PERFORMANCE_CONFIG;
  const baselineHashes = JSON.parse(readFileSync(path.join(BASE, "q8-hashes.json"), "utf8"));
  // Keep the reused harness fixed even while the working checkout advances.
  registerHooks({ load(url, context, next) {
    if (!url.startsWith("file:")) return next(url, context);
    const relative = path.relative(ROOT, fileURLToPath(url)).replaceAll(path.sep, "/");
    if (!Object.hasOwn(baselineHashes, relative) || !/\.(js|mjs)$/.test(relative)) return next(url, context);
    const bytes = readFileSync(path.join(BASE, "versions/q8", relative)); assert.equal(sha(bytes), baselineHashes[relative]);
    return { source: bytes.toString(), format: "module", shortCircuit: true };
  } });
  const { createQ6PerformanceHook } = await import("./q6-performance-hook.mjs");
  process.env.Q6_PERFORMANCE_CONFIG = configFile;
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  const existing = createQ6PerformanceHook(config), counters = globalThis.__q6Counters;
  Object.assign(counters, { catalogDeleteStatements: 0, catalogClearStatements: 0, wholeInventoryReads: 0,
    fullInventoryPasses: 0, inventoryDirectoryCalls: 0, capturedFiles: 0 });
  const file = path.join(config.output, `q9-${process.pid}.ndjson`);
  const emit = (row) => appendFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), ...row }) + "\n");
  const originalPrepare = DatabaseSync.prototype.prepare, originalExec = DatabaseSync.prototype.exec;
  const countSql = (sql, count) => {
    for (const [key, n] of Object.entries(count)) counters[key] += n;
    emit({ label: "sql-inventory", sql, counts: count });
  };
  DatabaseSync.prototype.exec = function (sql) {
    const count = sqlCounts(sql);
    if (Object.values(count).some(Boolean)) countSql(sql, count);
    return originalExec.call(this, sql);
  };
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = originalPrepare.call(this, sql), count = sqlCounts(sql);
    if (Object.values(count).some(Boolean)) for (const name of ["run", "get", "all", "iterate"]) {
      const original = statement[name];
      statement[name] = function (...args) { countSql(sql, count); return original.apply(this, args); };
    }
    return statement;
  };
  globalThis.__q9Acquisition = (fn, name) => function (...args) {
    if (name === "complete" && args[4] === true) counters.fullInventoryPasses++;
    if (name === "inventoryDirectory") counters.inventoryDirectoryCalls++;
    if (name === "capture") counters.capturedFiles++;
    return fn.apply(this, args);
  };
  emit({ label: "q9-hook-start", variant: config.version.variant, proofMode: config.proofMode,
    counters: Object.keys(counters), helper: config.version.helperSha256 });
  registerHooks({ load(url, context, next) {
    const result = existing.load(url, context, next);
    if (!url.startsWith("file:")) return result;
    const relative = path.relative(ROOT, fileURLToPath(url)).replaceAll(path.sep, "/");
    if (relative === "src/usage-store.js") return { ...result, source: result.source + `\nif(typeof UsageStore.prototype.checkSources==='function')
      UsageStore.prototype.checkSources=globalThis.__q6Wrap(UsageStore.prototype.checkSources,'store.checkSources');\n` };
    if (relative === "src/usage-source-acquisition.js") return { ...result, source: result.source + `\nfor(const name of ['complete','inventoryDirectory','capture']) {
      const fn=UsageSourceAcquisition.prototype[name];if(typeof fn==='function')UsageSourceAcquisition.prototype[name]=globalThis.__q9Acquisition(fn,name);
    }\n` };
    if (relative === "src/server.js") {
      const needle = "function writeUsageEvent(response, event, data) {";
      assert.equal(String(result.source).split(needle).length, 2, "SSE instrumentation anchor changed");
      globalThis.__q9Sse = (event, data) => emit({ label: "sse-send", event, fingerprint: data?.fingerprint, revision: data?.revision });
      return { ...result, source: result.source.replace(needle, needle + "globalThis.__q9Sse(event,data);") };
    }
    return result;
  } });
}
