import { writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import sqlite from 'node:sqlite';

const phases = {};
function timed(label, work) {
  const start = performance.now(), cpu = process.cpuUsage();
  const finish = () => {
    const row = phases[label] ??= { calls: 0, ms: 0, cpuMs: 0 };
    const used = process.cpuUsage(cpu);
    row.calls++; row.ms += performance.now() - start; row.cpuMs += (used.user + used.system) / 1000;
  };
  try {
    const value = work();
    if (value?.then) return value.finally(finish);
    finish(); return value;
  } catch (error) { finish(); throw error; }
}
globalThis.__b1Time = timed;
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith('/src/usage-store.js')) return result;
  const methods = ['syncRound', 'replaceFile', 'prepareHotRollups', 'prepareQuotaProjection', 'prepareRecordProjection', 'quotaObservations', 'recordsForRange', 'buildRecordChampions', 'timelineRange', 'metadata', 'periodComparison', 'summarizeInReadTransactionCore'];
  return { ...result, source: String(result.source) + `\nfor (const name of ${JSON.stringify(methods)}) {
    const original = UsageStore.prototype[name];
    if (original) UsageStore.prototype[name] = function(...args) {
      return globalThis.__b1Time(name, () => Reflect.apply(original, this, args));
    };
  }` };
} });
const labels = new WeakMap();
const prepare = sqlite.DatabaseSync.prototype.prepare;
sqlite.DatabaseSync.prototype.prepare = function(sql, ...args) {
  const statement = Reflect.apply(prepare, this, [sql, ...args]);
  if (/INSERT INTO usage_rollup_repositories/.test(sql)) labels.set(statement, 'repository-rollup-insert');
  return statement;
};
const run = sqlite.StatementSync.prototype.run;
sqlite.StatementSync.prototype.run = function(...args) {
  const label = labels.get(this);
  return label ? timed(label, () => Reflect.apply(run, this, args)) : Reflect.apply(run, this, args);
};
process.once('exit', () => writeFileSync(path.join(process.env.ARCH_STARTUP_RESULT_DIR, `b1-phases-${process.pid}.json`), JSON.stringify(phases, null, 2)));
