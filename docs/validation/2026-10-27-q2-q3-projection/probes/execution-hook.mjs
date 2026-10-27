import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { threadId } from 'node:worker_threads';

const instances = new WeakMap();
let next = 0;
globalThis.__q23Execution = (store, method, ms, result, error, module) => {
  if (!process.env.Q23_LOG_FILE) return;
  if (!instances.has(store)) instances.set(store, ++next);
  const row = { at: Date.now(), pid: process.pid, threadId, instance: instances.get(store),
    method, ms, transaction: store.database?.isTransaction ?? null,
    writeDepth: store.writeTransactionDepth, file: store.databaseFile,
    result: method === 'captureUsageProjection' ? Boolean(result) : method === 'adoptUsageProjection' ? result : undefined,
    module, mappingActive: typeof globalThis.__refreshMap === 'function',
    homeMapped: typeof globalThis.__refreshMap === 'function' && store.options?.homeDir
      ? globalThis.__refreshMap(store.options.homeDir) !== store.options.homeDir : null,
    error: error?.message };
  fs.appendFileSync(process.env.Q23_LOG_FILE, JSON.stringify(row) + '\n');
};
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith('/src/usage-store.js') || result.format !== 'module') return result;
  const suffix = `
for (const method of ['captureUsageProjection', 'adoptUsageProjection', 'timelineRange', 'perfSummaryForRange']) {
  const original = UsageStore.prototype[method];
  if (!original) continue;
  UsageStore.prototype[method] = function(...args) {
    const started = performance.now(); let value, error;
    try { value = original.apply(this, args); return value; }
    catch (failure) { error = failure; throw failure; }
    finally { globalThis.__q23Execution(this, method, performance.now() - started, value, error, ${JSON.stringify(url)}); }
  };
}
`;
  return { ...result, source: String(result.source) + suffix };
} });
