import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { UsageStore as BeforeStore } from './preimage/src/usage-store.js';
import { UsageStore as AfterStore } from './final-v4/src/usage-store.js';
import { loadPricingFile as beforeLoad } from './preimage/src/pricing-store.js';
import { loadPricingFile as afterLoad } from './final-v4/src/pricing-store.js';
import { getPricingCatalog as beforeCatalog } from './preimage/src/pricing.js';
import { getPricingCatalog as afterCatalog } from './final-v4/src/pricing.js';

assert.notEqual(process.env.REFRESH_PRODUCT_BEFORE, '1');
assert.equal(process.env.REFRESH_TRACE, '0');
assert.notEqual(BeforeStore, AfterStore);
const root = path.resolve('output/q2-q3-projection-20261027');
const frozen = JSON.parse(fs.readFileSync('.codex-usage/refresh-latency-20261026/freeze.json', 'utf8'));
const result = { samples: [], pairs: [], methodsUnchanged: [], maxRSSKiB: 0, completed: false };

const save = () => fs.writeFileSync(path.join(root, 'query-paired-results.json'), JSON.stringify(result, null, 2));
const entries = [];
const normalize = summary => {
  const value = structuredClone(summary);
  delete value.generatedAt;
  delete value.perf.indexedAt;
  delete value.perf.meta.indexedAt;
  return value;
};
const stats = rows => {
  const values = rows.map(row => row.ms).sort((a, b) => a - b);
  return { n: values.length, p50: values[Math.ceil(values.length * 0.5) - 1],
    p95: values[Math.ceil(values.length * 0.95) - 1], max: values.at(-1) };
};
async function query(entry, preset, index) {
  const start = performance.now();
  const value = await entry.store.dashboardHistory({ preset, bucket: preset === 'today' ? 'hour' : 'day',
    calendarZone: 'local', now: new Date('2026-10-26T15:00:00.000Z'), pricingModels: entry.catalog().models }, { includeDetails: false });
  const ms = performance.now() - start, summary = normalize(value.summary);
  const row = { mode: entry.mode, preset, index, ms, hash: createHash('sha256').update(JSON.stringify(summary)).digest('hex') };
  result.samples.push(row);
  result.maxRSSKiB = Math.max(result.maxRSSKiB, process.resourceUsage().maxRSS);
  console.log(JSON.stringify(row));
  save();
  assert.equal(value.metadata.generatedAt, entry.store.generatedAt, 'metadata clock must match its own publication');
  row.metadataGeneratedAt = value.metadata.generatedAt;
  const metadata = structuredClone(value.metadata);
  delete metadata.generatedAt;
  return { summary, metadata, periodComparison: value.periodComparison };
}
try {
  for (const [mode, Store, load, catalog] of [
    ['before', BeforeStore, beforeLoad, beforeCatalog], ['after', AfterStore, afterLoad, afterCatalog],
  ]) {
    const databaseFile = path.join(path.dirname(frozen.database), `followup-query-${mode}-${process.pid}.sqlite`);
    fs.copyFileSync(frozen.database, databaseFile, fs.constants.COPYFILE_EXCL);
    const options = { ...frozen.options, databaseFile, automaticDiscoveryEnabled: false, pricingRefreshSchedulerEnabled: false };
    await load(options);
    const store = new Store(options);
    entries.push({ mode, store, catalog, databaseFile });
    await store.open();
    await store.sync();
    assert.equal((await store.sync()).updatedFileCount, 0);
    assert.equal((await store.sync()).updatedFileCount, 0);
  }
  assert.deepEqual(beforeCatalog(), afterCatalog());
  for (const preset of ['today', 'month', 'all']) {
    assert.deepEqual(await query(entries[0], preset, -1), await query(entries[1], preset, -1));
    for (let index = 0; index < 20; index++) {
      const order = index % 2 === 0 ? entries : [...entries].reverse();
      const first = await query(order[0], preset, index), second = await query(order[1], preset, index);
      assert.deepEqual(first, second, 'paired complete public summary equality');
      result.pairs.push({ preset, index, order: order.map(row => row.mode), equal: true });
      save();
    }
  }
  result.summary = Object.fromEntries(['today', 'month', 'all'].map(preset => [preset,
    Object.fromEntries(['before', 'after'].map(mode => [mode, stats(result.samples.filter(row => row.preset === preset && row.mode === mode && row.index >= 0))]))]));
  result.completed = true;
} catch (error) {
  result.failure = { message: error.message, stack: error.stack };
  throw error;
} finally {
  for (const entry of entries) {
    entry.store.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(entry.databaseFile + suffix, { force: true });
  }
  result.finishedAt = new Date().toISOString();
  save();
}




