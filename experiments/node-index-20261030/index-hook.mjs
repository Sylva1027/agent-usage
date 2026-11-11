import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { threadId } from "node:worker_threads";

const config = JSON.parse(fs.readFileSync(process.env.LOCAL_SUMMARY_CASE_CONFIG, "utf8"));
await import(new URL("../../docs/validation/2026-10-29-local-summary-endurance/probes/hook.mjs", import.meta.url).href);
if (config.source === "profile") {
  const stage = (name, extra = {}) => fs.appendFileSync(config.stageFile, JSON.stringify({
    at: performance.timeOrigin + performance.now(), pid: process.pid, threadId, stage: name,
    ...process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS, ...extra,
  }) + "\n");
  globalThis.__indexStage = stage;
  const OriginalDatabase = globalThis.__localSummaryDatabase;
  globalThis.__localSummaryDatabase = class extends OriginalDatabase {
    prepare(sql) {
      const statement = super.prepare(sql);
      return new Proxy(statement, { get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (!["all", "get"].includes(key)) return value.bind(target);
        return (...args) => {
          const before = process.memoryUsage();
          const started = performance.now();
          const result = value.apply(target, args);
          const ms = performance.now() - started;
          const delta = process.memoryUsage().heapUsed - before.heapUsed;
          if (ms > 40 || delta > 2 ** 20 || (Array.isArray(result) && result.length > 4000)) {
            stage("sql." + key, { sql: sql.replace(/\s+/g, " ").slice(0, 450), ms, rows: Array.isArray(result) ? result.length : null, heapDelta: delta });
          }
          return result;
        };
      } });
    }
  };
  const { UsageStore } = await import(pathToFileURL(path.join(config.sourceRoot, "src/usage-store.js")).href);
  for (const name of ["open", "sync", "syncRound", "usageFiles", "replaceFile", "refreshWorkbuddyDurations", "dashboardHistory", "summarizeInReadTransactionCore", "metadataHistory", "periodComparisonHistory", "buildPerfSummaryForRange"]) {
    const original = UsageStore.prototype[name];
    if (typeof original !== "function") throw Error("Missing profile method " + name);
    UsageStore.prototype[name] = function(...args) {
      stage(name + ".start", name === "replaceFile" ? { kind: args[0]?.source?.kind } : {});
      const done = (value) => {
        stage(name + ".done", name === "syncRound" ? {
          updatedFileCount: value?.updatedFileCount,
          stagedThreads: [...this.codexThreadBuildPlan.values()].reduce((sum, plan) => sum + plan.staged.length, 0),
          retainedThreads: [...this.codexThreadBuildPlan.values()].reduce((sum, plan) => sum + plan.retained.length, 0),
        } : {});
        if (name === "open" && this.codexProjections && !this.codexProjections.__profiled) {
          const cache = this.codexProjections;
          cache.__profiled = true;
          let count = 0;
          for (const operation of ["lookup", "stage", "commit", "prune"]) {
            const run = cache[operation];
            if (typeof run !== "function") continue;
            cache[operation] = function(...values) {
              const before = process.memoryUsage().heapUsed, start = performance.now();
              const result = run.apply(this, values);
              count += 1;
              const delta = process.memoryUsage().heapUsed - before, ms = performance.now() - start;
              if (delta > 4 * 2 ** 20 || ms > 100 || count % 250 === 0) stage("projection." + operation, { count, ms, heapDelta: delta });
              return result;
            };
          }
        }
      };
      let result;
      try { result = original.apply(this, args); } catch (error) { stage(name + ".error"); throw error; }
      if (result?.then) return result.then(value => { done(value); return value; }, error => { stage(name + ".error"); throw error; });
      done(result);
      return result;
    };
  }
  stage("process.ready");
}
