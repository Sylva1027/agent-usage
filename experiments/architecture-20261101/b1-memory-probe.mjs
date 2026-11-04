import assert from 'node:assert/strict';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { registerHooks } from 'node:module';

const scale = process.argv[2] || '5x';
assert.ok(['1x', '5x', '10x'].includes(scale));
const run = { '1x': '1-1x', '5x': '2-5x', '10x': '3-10x' }[scale];
const directory = path.resolve('output/architecture-20261103/b1', `diagnostic-${scale}`);
mkdirSync(directory, { recursive: true });
const file = path.join(directory, 'usage-index.sqlite');
if (!existsSync(file)) {
  const original = new DatabaseSync(path.resolve(`output/architecture-20261102/full-startup/growth-standard-light-${run}/state/usage-index.sqlite`), { readOnly: true });
  try { await backup(original, file); } finally { original.close(); }
}
const marks = [];
const anonymousDatabases = new Set();
let probeDatabase = null;
function mark(stage) {
  let observedTemporaryDatabaseBytes = 0;
  for (const database of anonymousDatabases) {
    observedTemporaryDatabaseBytes += Number(database.prepare('PRAGMA page_count').get().page_count) * Number(database.prepare('PRAGMA page_size').get().page_size);
  }
  let observedTempTableBytes = 0;
  if (probeDatabase) {
    observedTempTableBytes = Number(probeDatabase.prepare('PRAGMA temp.page_count').get().page_count) * Number(probeDatabase.prepare('PRAGMA temp.page_size').get().page_size);
  }
  const row = { pid: process.pid, stage, ms: performance.now(), observedTemporaryDatabaseBytes, observedTempTableBytes, osPeakRssBytes: process.resourceUsage().maxRSS * 1024, ...process.memoryUsage(), cpu: process.cpuUsage() };
  marks.push(row);
  writeFileSync(path.join(directory, `marks-${process.pid}.json`), JSON.stringify(marks, null, 2));
  console.log(JSON.stringify(row));
}
globalThis.__b1Mark = mark;
globalThis.__b1ObserveAnonymous = database => {
  anonymousDatabases.add(database);
  const close = database.close.bind(database);
  database.close = () => {
    mark('anonymous-database:close');
    anonymousDatabases.delete(database);
    close();
  };
  return database;
};
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (url.endsWith('/src/usage-session-members.js') || url.endsWith('/src/usage-store.js')) {
    const source = String(loaded.source);
    assert.equal(source.split('new DatabaseSync("")').length, 2);
    return { ...loaded, source: source.replace('new DatabaseSync("")', 'globalThis.__b1ObserveAnonymous(new DatabaseSync(""))') };
  }
  if (!url.endsWith('/src/usage-core.js')) return loaded;
  let source = String(loaded.source);
  const start = source.indexOf('export function selectQuotaWindows(');
  const end = source.indexOf('\nexport ', start + 1);
  assert.ok(start >= 0 && end > start);
  let body = source.slice(start, end);
  for (const [anchor, label] of [
    ['  const unique = new Map();', 'selectQuotaWindows:start'],
    ['  const valid = [...unique.values()]', 'selectQuotaWindows:dedupComplete'],
    ['  const buckets = new Map();', 'selectQuotaWindows:validComplete'],
    ['  let limitId = null;', 'selectQuotaWindows:bucketsComplete'],
    ['  return { asOf, limitId, ignoredBucketCount, windows, previousWindows };', 'selectQuotaWindows:complete'],
  ]) {
    assert.ok(body.includes(anchor), anchor);
    body = body.replace(anchor, `  globalThis.__b1Mark(${JSON.stringify(label)});\n${anchor}`);
  }
  source = source.slice(0, start) + body + source.slice(end);
  return { ...loaded, source };
} });
const { UsageStore } = await import('../../src/usage-store.js');
const store = new UsageStore({ databaseFile: file });
await store.open();
probeDatabase = store.database;
store.homes = store.database.prepare('SELECT DISTINCT home_id AS id, home_label AS label, home_path AS path, kind FROM source_files').all();
for (const name of ['prepareHotRollups', 'prepareQuotaProjection', 'prepareRecordProjection', 'quotaObservations', 'aggregateRange', 'timelineRange', 'recordsForRange', 'buildRecordChampions', 'metadata', 'periodComparison', 'summarizeInReadTransactionCore', 'costEstimateRange', 'groupedRange']) {
  const original = store[name];
  store[name] = function (...args) {
    mark(`${name}:begin`);
    const value = original.apply(this, args);
    mark(`${name}:end`);
    return value;
  };
}
try {
  mark('open');
  const result = await store.dashboardHistory({ preset: process.argv[3] || 'today', bucket: 'hour', calendarZone: 'local', now: new Date('2026-11-02T19:00:00Z') }, { includeDetails: false });
  mark('dashboard:complete');
  writeFileSync(path.join(directory, `result-${process.pid}.json`), JSON.stringify({ metadata: result.metadata, totals: result.summary.totals, records: result.summary.records }));
} finally { store.close(); }
