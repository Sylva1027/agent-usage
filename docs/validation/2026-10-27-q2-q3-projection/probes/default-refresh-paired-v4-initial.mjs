import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { UsageStore as BeforeStore } from './preimage/src/usage-store.js';
import { UsageStore as AfterStore } from './final-v4/src/usage-store.js';
import { loadPricingFile as loadBefore } from './preimage/src/pricing-store.js';
import { loadPricingFile as loadAfter } from './final-v4/src/pricing-store.js';
import { getPricingCatalog as beforeCatalog } from './preimage/src/pricing.js';
import { getPricingCatalog as afterCatalog } from './final-v4/src/pricing.js';

assert.notEqual(BeforeStore, AfterStore, 'A/B must use independent module trees');
assert.notEqual(process.env.REFRESH_PRODUCT_BEFORE, '1', 'direct preimage import supplies the baseline');
const root = path.resolve('output/q2-q3-projection-20261027');
const frozen = JSON.parse(fs.readFileSync('.codex-usage/refresh-latency-20261026/freeze.json', 'utf8'));
const physical = file => {
  const item = frozen.mappings.find(row => file.toLowerCase().startsWith(row.original.toLowerCase() + path.sep));
  assert.ok(item, 'private source mapping required');
  return path.join(item.copy, path.relative(item.original, file));
};
const preset = process.env.Q23_PRESET || 'today';
const rounds = Number(process.env.FOLLOWUP_ROUNDS || 20);
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 20);
const result = { preset, rounds, samples: [], pairs: [], maxRSSKiB: 0, minFreeGiB: Infinity, databases: [] };
const save = () => fs.writeFileSync(path.join(root, (process.env.Q23_RESULT || 'paired-results.json')), JSON.stringify(result, null, 2));
const entries = [];
const home = frozen.homes.find(row => row.kind === 'main');
const thread = randomUUID();
const logical = path.join(home.path, 'sessions', '2026', '10', '26', `rollout-refresh-diagnostic-${thread}.jsonl`);
const native = physical(logical);
const ledger = physical(path.join(frozen.home, '.config/magpie/usage.jsonl'));
const ledgerSize = fs.statSync(ledger).size;
const output = 1_000_007;
const responses = Array.from({ length: rounds }, () => 'resp_followup_' + randomUUID());
const total = store => Number(store.database.prepare('SELECT SUM(total) AS n FROM events').get().n);
function normalized(summary) {
  const value = structuredClone(summary);
  delete value.generatedAt;
  delete value.perf.indexedAt;
  delete value.perf.meta.indexedAt;
  return value;
}
async function measure(entry, phase, index) {
  const { store, mode, catalog } = entry;
  const start = performance.now();
  const status = await store.sync();
  const syncMs = performance.now() - start;
  const timelineBefore = store.__q23TimelineCalls || 0;
  const perfBefore = store.__q23PerfCalls || 0;
  const periodCacheSizeBeforeQuery = store.periodComparisonCache.size;
  const queryStart = performance.now();
  const dashboard = await store.dashboardHistory({ preset: preset, bucket: preset === 'today' ? 'hour' : 'day', calendarZone: 'local',
    now: new Date('2026-10-26T15:00:00.000Z'), pricingModels: catalog().models }, { includeDetails: false });
  const queryMs = performance.now() - queryStart;
  const summary = normalized(dashboard.summary);
  assert.equal(status.updatedFileCount, 0);
  assert.deepEqual(store.perfState().sourceWarnings, []);
  assert.equal(store.requestTimingDirtyThreadCount(), 0);
  if (phase === 'ledger') {
    assert.equal(Number(store.database.prepare('SELECT SUM(output_tokens) AS n FROM perf_samples WHERE source_path = ? AND duration_ms IS NOT NULL').get(logical).n), (index + 1) * output);
  }
  const row = { mode, phase, index, syncMs, queryMs, combinedMs: syncMs + queryMs,
    periodCacheSizeBeforeQuery, timelineCalls:(store.__q23TimelineCalls||0)-timelineBefore,perfCalls:(store.__q23PerfCalls||0)-perfBefore,
    summaryHash: createHash('sha256').update(JSON.stringify(summary)).digest('hex'),
    total: summary.totals.total, fingerprint: status.fingerprint,
    perfIndexVersion: summary.perf.indexVersion, rss: process.memoryUsage().rss };
  result.samples.push(row);
  result.maxRSSKiB = Math.max(result.maxRSSKiB, process.resourceUsage().maxRSS);
  result.minFreeGiB = Math.min(result.minFreeGiB, os.freemem() / 2 ** 30);
  assert.ok(result.minFreeGiB >= 4, 'system memory reserve');
  console.log(JSON.stringify(row));
  save();
  return { row, summary };
}
async function pair(phase, index) {
  const ordered = index % 2 === 0 ? entries : [...entries].reverse();
  const a = await measure(ordered[0], phase, index);
  const b = await measure(ordered[1], phase, index);
  assert.deepEqual(a.summary, b.summary, 'complete public summary A/B parity');
  assert.equal(a.row.fingerprint, b.row.fingerprint, 'source fingerprint parity');
  assert.equal(a.row.total, entries[0].tokens, 'no token changes in static or ledger-only rounds');
  result.pairs.push({ phase, index, order: ordered.map(row => row.mode), equal: true });
  save();
}
try {
  for (const [mode, Store, load, catalog] of [
    ['before', BeforeStore, loadBefore, beforeCatalog], ['after', AfterStore, loadAfter, afterCatalog],
  ]) {
    const databaseFile = path.join(path.dirname(frozen.database), `followup-paired-${mode}-${process.pid}.sqlite`);
    assert.equal(fs.existsSync(databaseFile), false);
    result.databases.push(databaseFile);
    await fsp.copyFile(frozen.database, databaseFile, fs.constants.COPYFILE_EXCL);
    const options = { ...frozen.options, databaseFile, automaticDiscoveryEnabled: false, pricingRefreshSchedulerEnabled: false };
    await load(options);
    const store = new Store(options);
    entries.push({ mode, store, catalog });
    await store.open();
    const timelineRange = store.timelineRange;
    store.timelineRange = function(...args) { this.__q23TimelineCalls=(this.__q23TimelineCalls||0)+1; return timelineRange.apply(this,args); };
    const perfSummary = store.perfSummaryForRange;
    store.perfSummaryForRange = function(...args) { this.__q23PerfCalls=(this.__q23PerfCalls||0)+1; return perfSummary.apply(this,args); };
    await store.sync();
    assert.equal((await store.sync()).updatedFileCount, 0);
    assert.equal((await store.sync()).updatedFileCount, 0);
  }
  assert.deepEqual(beforeCatalog(), afterCatalog(), 'same price catalog');
  for (const entry of entries) entry.tokens = total(entry.store);
  assert.equal(entries[0].tokens, entries[1].tokens);
  for (const entry of entries) {
    const dashboard = await entry.store.dashboardHistory({preset: preset,bucket: preset === 'today' ? 'hour' : 'day',calendarZone:'local',now:new Date('2026-10-26T15:00:00.000Z'),pricingModels:entry.catalog().models},{includeDetails:false});
    entry.tokens = dashboard.summary.totals.total;
  }
  assert.equal(entries[0].tokens, entries[1].tokens, 'same initial selected range');
  for (let index = 0; index < rounds; index++) await pair('static', index);
  result.completed = true;
} catch (error) {
  result.failure = { message: error.message, stack: error.stack };
  throw error;
} finally {
  for (const entry of entries) entry.store.close();
  fs.truncateSync(ledger, ledgerSize);
  await fsp.rm(native, { force: true });
  for (const database of result.databases) for (const suffix of ['', '-wal', '-shm']) await fsp.rm(database + suffix, { force: true });
  result.finishedAt = new Date().toISOString();
  save();
}




