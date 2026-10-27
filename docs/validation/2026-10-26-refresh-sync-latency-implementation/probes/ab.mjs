import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {UsageStore} from '../../src/usage-store.js';
import {loadPricingFile} from '../../src/pricing-store.js';
import {getPricingCatalog} from '../../src/pricing.js';

const output = path.resolve('output/refresh-sync-latency-implementation');
const frozen = JSON.parse(fs.readFileSync('.codex-usage/refresh-latency-20261026/freeze.json', 'utf8'));
const mode = process.argv[2];
assert.ok(mode);
const rounds = mode.includes('short') ? 3 : 20;
const databaseFile = path.join(path.dirname(frozen.database), `implementation-${mode}-${process.pid}.sqlite`);
await fsp.copyFile(frozen.database, databaseFile, fs.constants.COPYFILE_EXCL);
const options = {...frozen.options, databaseFile, pricingRefreshSchedulerEnabled:false, automaticDiscoveryEnabled:false};
await loadPricingFile(options);
const store = new UsageStore(options);
const result = {mode, rounds, now:'2026-10-26T15:00:00.000Z', samples:[], freeGiB:[], maxRSSKiB:0, summaries:{}};
async function save() {
  await fsp.writeFile(path.join(path.dirname(frozen.database), `implementation-${mode}-summaries.json`), JSON.stringify(result.summaries));
  await fsp.writeFile(path.join(output, `${mode}-results.json`), JSON.stringify({...result, summaries:undefined}, null, 2));
}
async function timed(label, action) {
  const started = performance.now();
  const value = await action();
  const row = {label, ms:performance.now()-started, rss:process.memoryUsage().rss};
  if (label.includes('sync')) Object.assign(row, {updatedFileCount:value.updatedFileCount, fingerprint:value.fingerprint, warnings:store.perfState().sourceWarnings});
  if (value?.summary) {
    const summary = structuredClone(value.summary);
    delete summary.generatedAt;
    delete summary.perf.indexedAt;
    delete summary.perf.meta.indexedAt;
    row.hash = createHash('sha256').update(JSON.stringify(summary)).digest('hex');
    result.summaries[label.split('-')[1]] = summary;
  }
  result.samples.push(row);
  result.maxRSSKiB = Math.max(result.maxRSSKiB, process.resourceUsage().maxRSS);
  result.freeGiB.push(os.freemem()/2**30);
  assert.ok(result.freeGiB.at(-1) >= 4, 'system free-memory reserve');
  console.log(JSON.stringify(row));
  await save();
  return value;
}
try {
  await timed('open', () => store.open());
  await timed('catchup-sync', () => store.sync());
  let stable = 0;
  for (let index=0;index<8 && stable<2;index++) {
    const value = await timed(`settle-sync-${index}`, () => store.sync());
    stable = value.updatedFileCount === 0 ? stable+1 : 0;
  }
  assert.equal(stable,2);
  for (let index=0;index<rounds;index++) await timed(`unchanged-sync-${index}`, () => store.sync());
  for (const preset of ['today','month','all']) {
    const filters = {preset, bucket:preset==='today'?'hour':'day', calendarZone:'local', now:new Date(result.now), pricingModels:getPricingCatalog().models};
    await timed(`dashboard-${preset}-first`, () => store.dashboardHistory(filters, {includeDetails:false}));
    for (let index=0;index<rounds;index++) await timed(`dashboard-${preset}-warm-${index}`, () => store.dashboardHistory(filters, {includeDetails:false}));
  }
  result.tables = Object.fromEntries(['events','source_files','perf_samples','perf_codex_projections','perf_rollout_threads','archive_segments'].map(table=>[table,Number(store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)]));
  result.fingerprint=store.fingerprint;
} finally {
  store.close();
  result.finishedAt=new Date().toISOString();
  await save();
  for (const suffix of ['', '-wal', '-shm']) await fsp.rm(databaseFile+suffix,{force:true});
}
