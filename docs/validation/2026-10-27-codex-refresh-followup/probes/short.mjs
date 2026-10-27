import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const probe = globalThis.__i1Probe;
assert.ok(probe, 'launch with --import ./output/codex-refresh-followup-20261027/probes/hook.mjs');
const { root, manifest, runDirectory, databaseFile, trace } = probe;
const { UsageStore } = await import(pathToFileURL(path.join(root, 'src/usage-store.js')).href);
const { loadPricingFile } = await import(pathToFileURL(path.join(root, 'src/pricing-store.js')).href);
const { getPricingCatalog } = await import(pathToFileURL(path.join(root, 'src/pricing.js')).href);
const mode = process.argv[2] || 'sync';
assert.ok(['sync', 'query'].includes(mode), 'mode must be sync or query');
fs.copyFileSync(manifest.database, databaseFile, fs.constants.COPYFILE_EXCL);
const options = { ...manifest.options, databaseFile,
  pricingFile: probe.mapped(path.join(manifest.home, '.codex-usage/pricing.json')),
  automaticPricingFile: probe.mapped(path.join(manifest.home, '.codex-usage/pricing-auto.json')),
  pricingRefreshSchedulerEnabled: false, automaticDiscoveryEnabled: false };
await loadPricingFile(options);
const store = new UsageStore(options);
const results = { mode, identityHash: probe.identityHash, node: process.version, startedAt: new Date().toISOString(),
  codeRoot: probe.identity.codeRoot, samples: [], oldAfterBaseline: null };
function state() {
  return { revision: store.storeRevision, derivedRevision: store.derivedRevision, dataVersion: store.readDataVersion(),
    totalChanges: Number(store.database.prepare('SELECT total_changes() AS value').get().value),
    lastCommitReason: store.lastCommitReason ?? null, fingerprint: store.fingerprint };
}
async function timed(label, action, now) {
  const before = state(), started = performance.now();
  const value = await trace(label, store, action, now?.toISOString() ?? null);
  const row = { label, ms: performance.now() - started, before, after: state() };
  if (value?.updatedFileCount !== undefined) row.updatedFileCount = value.updatedFileCount;
  if (value?.summary) {
    const summary = structuredClone(value.summary);
    delete summary.generatedAt;
    if (summary.perf) { delete summary.perf.indexedAt; if (summary.perf.meta) delete summary.perf.meta.indexedAt; }
    row.summaryHash = createHash('sha256').update(JSON.stringify(summary)).digest('hex');
    row.total = value.summary.totals.total;
  }
  results.samples.push(row);
  fs.writeFileSync(path.join(runDirectory, 'results.json'), JSON.stringify(results, null, 2));
  return value;
}
try {
  await store.open();
  await timed('catchup-excluded', () => store.sync());
  // Bounded preparation only; an unstable frozen input must not silently become a long benchmark.
  let stable = 0;
  for (let index = 0; index < 4 && stable < 2; index++) {
    const status = await timed('settle-excluded-' + index, () => store.sync());
    stable = status.updatedFileCount === 0 ? stable + 1 : 0;
  }
  assert.equal(stable, 2, 'frozen input did not settle within four rounds');
  if (mode === 'sync') {
    await timed('unchanged-sync', () => store.sync());
  } else {
    const now = new Date('2026-10-26T15:00:00.000Z');
    const query = (label, preset = 'all', asOf = now) => timed(label, () => store.dashboardHistory({
      preset, bucket: 'day', calendarZone: 'local', now: asOf, pricingModels: getPricingCatalog().models,
    }, { includeDetails: false }), asOf);
    await query('all-first');
    await query('all-same-context');
    await query('all-now-only', 'all', new Date(now.getTime() + 1000));
    await timed('no-op-sync', () => store.sync());
    await query('all-after-no-op');
    await query('month-first', 'month');
    await query('month-warm', 'month');
    const oldFile = probe.identity.oldAfter.path;
    // Use the old report once as context, never as a new paired A/B measurement.
    const oldText = fs.readFileSync(oldFile, 'utf8');
    assert.equal(createHash('sha256').update(oldText).digest('hex'), probe.identity.oldAfter.sha256, 'old baseline changed');
    const baseline = JSON.parse(oldText);
    results.oldAfterBaseline = { path: path.relative(root, oldFile), now: baseline.now,
      samples: baseline.samples.filter(row => ['dashboard-all-first', 'dashboard-all-warm-0',
        'dashboard-month-first', 'dashboard-month-warm-0'].includes(row.label)) };
  }
} finally {
  store.close();
  probe.verifyInputs();
  results.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(runDirectory, 'results.json'), JSON.stringify(results, null, 2));
  // Keep the private run database for Main's diagnosis; no source copy or old evidence is modified.
}
console.log(JSON.stringify({ directory: runDirectory, samples: results.samples.length, identityHash: probe.identityHash }));
