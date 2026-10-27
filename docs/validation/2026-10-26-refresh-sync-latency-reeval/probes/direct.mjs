import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { UsageStore } from '../../src/usage-store.js';
import { discoverUsageSources } from '../../src/usage-core.js';
import { loadPricingFile } from '../../src/pricing-store.js';
import { getPricingCatalog } from '../../src/pricing.js';

const evidence = path.resolve('output/refresh-sync-latency-reeval-20261026');
const privateRoot = path.resolve('.codex-usage/refresh-latency-20261026');
const frozen = JSON.parse(fs.readFileSync(path.join(privateRoot, 'freeze.json'), 'utf8'));
const mode = process.argv[2] || 'smoke';
const control = mode.startsWith('control');
const databaseFile = path.join(privateRoot, mode + '-' + process.pid + '.sqlite');
await fsp.copyFile(frozen.database, databaseFile, fs.constants.COPYFILE_EXCL);
const options = { ...frozen.options, databaseFile, pricingRefreshSchedulerEnabled: false };
await loadPricingFile(options);
const store = new UsageStore(options);
const results = { mode, startedAt: new Date().toISOString(), samples: [], memory: [], freeGiB: os.freemem()/2**30 };
const timed = async (label, action) => {
  const beforeFiles = label.includes('sync') ? new Map(store.database.prepare('SELECT path,kind,size,mtime_ms FROM source_files').all().map(row => [row.path, JSON.stringify(row)])) : null;
  const started = performance.now();
  const value = await action();
  const row = { label, ms: performance.now() - started, rss: process.memoryUsage().rss, maxRSSKiB: process.resourceUsage().maxRSS };
  if (label.includes('sync')) {
    row.updatedFileCount = value.updatedFileCount; row.fingerprint = value.fingerprint;
    row.changedKinds = store.database.prepare('SELECT path,kind,size,mtime_ms FROM source_files').all().filter(item => beforeFiles.get(item.path) !== JSON.stringify(item)).map(item => item.kind);
    row.warnings = store.perfState().sourceWarnings.map(item => ({ sourceKind: item.sourceKind, code: item.code }));
  }
  else if (value?.summary) { row.totals = value.summary.totals; row.hash = createHash('sha256').update(JSON.stringify(value.summary)).digest('hex'); }
  results.samples.push(row);
  console.log(JSON.stringify(row));
  await fsp.writeFile(path.join(evidence, mode + '-results.json'), JSON.stringify(results, null, 2));
  if (os.freemem() < 4 * 2 ** 30) throw new Error('System memory reserve fell below 4 GiB');
  return value;
};
try {
  await timed('open', () => store.open());
  const homes = await discoverUsageSources(frozen.options);
  assert.equal(homes.length, frozen.homes.length, 'Frozen source discovery must preserve homes');
  const found = await store.usageFiles(homes);
  assert.equal(found.failedHomes.length, 0);
  assert.equal(found.files.length, frozen.sourceFiles.length, 'Frozen discovery must preserve file count');
  await timed('catchup-sync', () => store.sync({ options }));
  let stable = 0;
  for (let index = 0; index < 6 && stable < 2; index++) {
    const value = await timed('settle-sync-' + index, () => store.sync({ options }));
    stable = value.updatedFileCount === 0 ? stable + 1 : 0;
  }
  assert.equal(stable, 2, 'Frozen source set must settle before unchanged measurements');
  const rounds = control ? 3 : mode === 'supplement' ? 0 : mode === 'smoke' ? 1 : 20;
  for (let index = 0; index < rounds; index++) await timed('unchanged-sync-' + index, () => store.sync({ options }));
  const now = new Date(control || mode === 'supplement' ? JSON.parse(fs.readFileSync(path.join(evidence,'valid-baseline-results.json'),'utf8')).startedAt : results.startedAt);
  for (const preset of ['today', 'month', 'all']) {
    for (let index = 0; index < (control ? 3 : mode === 'supplement' ? 21 : mode === 'smoke' ? 1 : 20); index++) {
      await timed('dashboard-' + preset + '-' + index, () => store.dashboardHistory({ preset, bucket: preset === 'today' ? 'hour' : 'day', calendarZone: 'local', now, pricingModels: getPricingCatalog().models }, { includeDetails: false }));
    }
  }
} finally {
  store.close();
  results.finishedAt = new Date().toISOString();
  results.finalRss = process.memoryUsage().rss;
  await fsp.writeFile(path.join(evidence, mode + '-results.json'), JSON.stringify(results, null, 2));
}
