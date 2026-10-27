import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sqlite from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isMainThread } from 'node:worker_threads';

const root = process.cwd();
const privateRoot = path.join(root, '.codex-usage', 'refresh-latency-20261026');
const manifest = JSON.parse(fs.readFileSync(path.join(privateRoot, 'freeze.json'), 'utf8'));
const append = fs.appendFileSync.bind(fs);
const realpath = fs.realpathSync.bind(fs);
const originalExists = fs.existsSync.bind(fs);
const resolved = value => value instanceof URL ? fileURLToPath(value) : value;
const inside = (file, directory) => file.toLowerCase() === directory.toLowerCase() || file.toLowerCase().startsWith(directory.toLowerCase() + path.sep);
const map = value => {
  value = resolved(value);
  if (typeof value !== 'string' || !path.isAbsolute(value)) return value;
  const absolute = path.resolve(value);
  if (process.env.REFRESH_PRODUCT_BEFORE === '1' && inside(absolute, root)) {
    const preimage = path.join(root, 'output/codex-incremental-visibility-20261027/preimage', path.relative(root, absolute));
    if (path.relative(root, absolute).split(path.sep)[0] === 'public' && originalExists(preimage)) return preimage;
  }
  if (/\\(?:\.cache\\codex-runtimes|AppData\\Local\\(?:ms-playwright|Temp))(?:\\|$)/i.test(absolute)) return value;
  const item = manifest.mappings.find(entry => inside(absolute, entry.original));
  return item ? path.join(item.copy, path.relative(item.original, absolute)) : value;
};
const reverse = value => {
  if (typeof value !== 'string') return value;
  const item = manifest.mappings.find(entry => inside(value, entry.copy));
  return item ? path.join(item.original, path.relative(item.copy, value)) : value;
};
globalThis.__refreshMap = map;
globalThis.__refreshContext = new AsyncLocalStorage();
const metric = (label, ms = 0, extra = 0) => {
  const context = globalThis.__refreshContext.getStore();
  if (!context) return;
  const value = context.metrics[label] ||= { calls: 0, ms: 0, extra: 0 };
  value.calls++; value.ms += ms; value.extra += extra;
};
globalThis.__refreshMetric = metric;
globalThis.__refreshBegin = label => {
  const started = performance.now();
  const context = globalThis.__refreshContext.getStore();
  const previous = context?.tag;
  if (context) context.tag = label;
  return () => { metric(label, performance.now() - started); if (context) context.tag = previous; };
};
const mapSizes = new WeakMap();
globalThis.__refreshCopy = (label, value) => {
  if (!mapSizes.has(value)) mapSizes.set(value, Object.keys(value).length);
  const started = performance.now();
  const copy = { ...value };
  metric(label, performance.now() - started, mapSizes.get(value));
  return copy;
};
const originalReadSync = fs.readSync.bind(fs);
fs.readSync = function (...args) {
  const count = originalReadSync(...args);
  const context = globalThis.__refreshContext.getStore();
  if (context) metric(context.tag === 'prefix' ? 'prefixRead' : 'otherReadSync', 0, count);
  return count;
};
for (const name of ['readFileSync', 'openSync', 'statSync', 'lstatSync', 'existsSync', 'readdirSync', 'accessSync', 'createReadStream', 'readFile', 'open', 'stat', 'lstat', 'readdir', 'access', 'opendir']) {
  const original = fs[name];
  if (typeof original === 'function') fs[name] = function (file, ...args) { return original.call(this, map(file), ...args); };
}
fs.realpathSync = function (file, ...args) { return reverse(realpath(map(file), ...args)); };
for (const name of ['readFile', 'open', 'stat', 'lstat', 'readdir', 'access', 'opendir', 'realpath']) {
  const original = fsp[name].bind(fsp);
  fsp[name] = async function (file, ...args) {
    const value = await original(map(file), ...args);
    return name === 'realpath' ? reverse(value) : value;
  };
}
syncBuiltinESMExports();
const NativeDatabaseSync = sqlite.DatabaseSync;
globalThis.__RefreshDatabaseSync = class extends NativeDatabaseSync {
  constructor(file, options = {}) { super(map(file), options); }
};
function wrapSourceFunction(source, expression, label) {
  const match = source.match(expression);
  if (!match) throw new Error('Instrumentation anchor missing: ' + label);
  const start = match.index + match[0].length;
  const end = source.indexOf('\n}', start);
  if (end < 0) throw new Error('Function end missing: ' + label);
  return source.slice(0, start) + '\nconst __refreshDone = globalThis.__refreshBegin("' + label + '"); try {\n' + source.slice(start, end) + '\n} finally { __refreshDone(); }' + source.slice(end);
}
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.startsWith('file:') || !url.includes('/src/') || result.format !== 'module') return result;
  let source = String(result.source);
  if (process.env.REFRESH_PRODUCT_BEFORE === '1') {
    const relative = path.relative(root, fileURLToPath(url));
    const preimage = path.join(root, 'output/codex-incremental-visibility-20261027/preimage', relative);
    if (originalExists(preimage)) source = fs.readFileSync(preimage, 'utf8');
  }
  source = source.replaceAll('new DatabaseSync(', 'new globalThis.__RefreshDatabaseSync(');
  if (process.env.REFRESH_TRACE !== '0') {
    if (url.endsWith('/usage-store.js')) {
      source = source.replace('return { ...this.fingerprints };', 'return globalThis.__refreshCopy("copyFingerprints", this.fingerprints);');
      source = source.replace('return { ...this.warnings };', 'return globalThis.__refreshCopy("copyWarnings", this.warnings);');
      source = source.replace('return { ...this.readFingerprints() };', 'return globalThis.__refreshCopy("copyFingerprints", this.readFingerprints());');
      source = source.replace('return { ...this.readWarnings() };', 'return globalThis.__refreshCopy("copyWarnings", this.readWarnings());');
      source = source.replace('      if (!shouldPlan) {', '      globalThis.__refreshMetric("planReasons:" + JSON.stringify({policyNeedsUpgrade,degraded:priorDegradedHomeIds.has(homeId),partial:priorPartialHomeIds.has(homeId),dirty:dirtyTimingThreadIds.size,pathSetChanged,metadataChanged,unkeyable:codexHomesWithUnkeyableOldSamples.has(homeId)}));\n      if (!shouldPlan) {');
      source = source.replace('        return (\n          !sameMetadata ||', '        if (!sameMetadata) globalThis.__refreshMetric("planMetadataMismatch");\n        if (!hasCurrentOwnership) globalThis.__refreshMetric("planMissingOwnership");\n        return (\n          !sameMetadata ||');
    }
    if (url.endsWith('/usage-core.js')) source = wrapSourceFunction(source, /function perfFilePrefixEvidence\(filePath\) \{/, 'prefix');
    if (url.endsWith('/codex-fold.js')) source = wrapSourceFunction(source, /export function foldCodexRolloutMetadata[^\{]+\{/, 'fold');
  }
  return { ...result, source };
} });

if (process.env.REFRESH_TRACE !== '0') {
  const { UsageStore } = await import('../../src/usage-store.js');
  const methodNames = ['sync', 'syncRound', 'importMagpieRequestTimings', 'usageFiles', 'open', 'dashboardHistory', 'trySqlHistoryDashboard', 'summarizeHistory', 'summarizeInReadTransaction', 'metadata', 'metadataHistory', 'periodComparison', 'periodComparisonHistory', 'recordsForRange', 'buildRecordChampions', 'timelineRange', 'costEstimateRange', 'groupedRange', 'repositoriesRange', 'perfSummaryForRange', 'buildPerfSummaryForRange', 'publishedFileFingerprintsForRound', 'publishedFileWarningsForRound'];
  for (const name of methodNames) {
    const original = UsageStore.prototype[name];
    if (typeof original !== 'function') continue;
    if (original.constructor.name === 'AsyncFunction') {
      UsageStore.prototype[name] = async function (...args) {
        const run = async () => {
          const started = performance.now();
          try { return await original.apply(this, args); } finally { metric(name, performance.now() - started); }
        };
        if (!['sync', 'dashboardHistory'].includes(name) || globalThis.__refreshContext.getStore()) return run();
        const context = { root: name, startedAt: new Date().toISOString(), metrics: {} };
        const started = performance.now(), cpu = process.cpuUsage();
        let result;
        try { result = await globalThis.__refreshContext.run(context, run); return result; }
        finally {
          context.ms = performance.now() - started;
          context.cpu = process.cpuUsage(cpu);
          context.rss = process.memoryUsage().rss;
          context.maxRSSKiB = process.resourceUsage().maxRSS;
          context.pid = process.pid;
          context.mainThread = isMainThread;
          if (name === 'sync') context.updatedFileCount = result?.updatedFileCount;
          append(path.join(root, 'output/codex-incremental-visibility-20261027', process.env.REFRESH_TRACE_FILE || 'stages.jsonl'), JSON.stringify(context) + '\n');
        }
      };
    } else {
      UsageStore.prototype[name] = function (...args) {
        const started = performance.now();
        try { return original.apply(this, args); } finally { metric(name, performance.now() - started); }
      };
    }
  }
}



