import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const probe = globalThis.__readerProbe;
assert.ok(probe, 'launch with --import ./docs/validation/2026-10-27-codex-refresh-followup/probes/reader-hook.mjs');
const rounds = Number(process.argv[2] ?? 3);
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 3, 'rounds must be 1..3');
const { createUsageExecutor } = await import(pathToFileURL(path.join(probe.codeRoot, 'src/usage-executor.js')).href);
const { loadPricingFile } = await import(pathToFileURL(path.join(probe.codeRoot, 'src/pricing-store.js')).href);
const { getPricingCatalog } = await import(pathToFileURL(path.join(probe.codeRoot, 'src/pricing.js')).href);
fs.copyFileSync(probe.manifest.database, probe.databaseFile, fs.constants.COPYFILE_EXCL);
const options = { ...probe.manifest.options, databaseFile: probe.databaseFile,
  pricingFile: probe.mapped(path.join(probe.manifest.home, '.codex-usage/pricing.json')),
  automaticPricingFile: probe.mapped(path.join(probe.manifest.home, '.codex-usage/pricing-auto.json')),
  automaticDiscoveryEnabled: false, pricingRefreshSchedulerEnabled: false };
await loadPricingFile(options);
const executor = createUsageExecutor(options);
const result = { rounds, codeRoot: probe.codeRoot, node: process.version, startedAt: new Date().toISOString(), samples: [],
  context: { preset: 'all', bucket: 'day', calendarZone: 'local', now: '2026-10-26T15:00:00.000Z', includeDetails: false },
  coverage: { realExecutor: true, getSummarySymbol: false, http: false, ledgerOnly: false, changedSources: false } };
const save = () => fs.writeFileSync(path.join(probe.runDirectory, 'results.json'), JSON.stringify(result, null, 2));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function normalizedSummary(value) {
  const summary = structuredClone(value.summary);
  delete summary.generatedAt;
  if (summary.perf) { delete summary.perf.indexedAt; if (summary.perf.meta) delete summary.perf.meta.indexedAt; }
  return summary;
}
async function timed(label, action) {
  probe.label = label;
  const started = performance.now(), value = await action();
  const row = { label, ms: performance.now() - started, rss: process.memoryUsage().rss };
  if (value?.summary) {
    row.summaryHash = hash(normalizedSummary(value));
    row.totals = value.summary.totals;
    row.status = value.status;
  }
  if (value?.updatedFileCount !== undefined) Object.assign(row, { updatedFileCount: value.updatedFileCount, status: value });
  result.samples.push(row);
  save();
  console.log(JSON.stringify(row));
  return value;
}
const dashboard = label => timed(label, () => executor.dashboard({ ...result.context, now: new Date(result.context.now),
  pricingModels: getPricingCatalog().models }, { includeDetails: false }));
const sync = label => timed(label, () => executor.sync());
let concurrent;
try {
  await timed('open-excluded', () => executor.open());
  await sync('catchup-excluded');
  let stable = 0;
  for (let index = 0; index < 4 && stable < 2; index++) {
    const status = await sync(`settle-excluded-${index}`);
    stable = status.updatedFileCount === 0 ? stable + 1 : 0;
  }
  assert.equal(stable, 2, 'frozen input did not settle within four rounds');
  for (let index = 0; index < rounds; index++) {
    const prefix = `round-${index}`;
    const first = await dashboard(`${prefix}-first`);
    const same = await dashboard(`${prefix}-same-context`);
    assert.deepEqual(normalizedSummary(same), normalizedSummary(first), 'identical context summary changed');
    concurrent = sync(`${prefix}-concurrent-sync`);
    // Both ordinary messages are sent immediately; the trace proves which reader actually served the dashboard.
    const during = await dashboard(`${prefix}-during-sync`);
    const concurrentStatus = await concurrent;
    concurrent = null;
    const after = await dashboard(`${prefix}-after-sync`);
    const noop = await sync(`${prefix}-no-op-sync`);
    assert.equal(concurrentStatus.updatedFileCount, 0, 'concurrent frozen sync was not no-op');
    assert.equal(noop.updatedFileCount, 0, 'frozen sync was not no-op');
    const afterNoop = await dashboard(`${prefix}-after-no-op`);
    for (const value of [during, after, afterNoop]) assert.deepEqual(normalizedSummary(value), normalizedSummary(first), 'no-op changed the summary');
    probe.label = `${prefix}-trace`;
    result.samples.push({ label: probe.label, state: await executor.readerTrace() });
    save();
  }
} catch (error) {
  result.failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  if (concurrent) await concurrent.catch(error => { result.concurrentFailure = error.message; });
  probe.label = 'close';
  await executor.close();
  try {
    probe.verifyInputs();
    result.inputsUnchanged = true;
    const events = fs.readdirSync(probe.runDirectory).filter(name => /^events-\d+\.jsonl$/.test(name)).flatMap(name =>
      fs.readFileSync(path.join(probe.runDirectory, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
    const worker = events.find(row => row.kind === 'preload-ready' && row.role === 'executor-worker');
    assert.ok(worker, 'no real executor preload evidence');
    assert.ok(events.some(row => row.kind === 'store-instrumented' && row.threadId === worker.threadId));
    assert.ok(!events.some(row => row.kind === 'sqlite-open' && row.threadId === 0), 'main opened SQLite');
    assert.ok(events.some(row => row.kind === 'sqlite-open' && row.threadId === worker.threadId && row.physical === probe.databaseFile));
    const selections = events.filter(row => row.kind === 'dashboard-reader');
    const requests = events.filter(row => row.kind === 'request-complete' && row.type === 'dashboard');
    const measured = requests.filter(row => /^round-/.test(row.label));
    assert.equal(measured.length, rounds * 5, 'missing dashboard request traces');
    assert.ok(measured.every(row => row.keys.length > 0), 'no hot projection key evidence; cold/uncacheable path requires separate analysis');
    let previous;
    result.dashboardAttribution = measured.map(row => {
      const current = row.keys.at(-1), selected = selections.find(item => item.threadId === row.threadId && item.requestId === row.requestId);
      const entry = { label: row.label, workerMs: row.ms, methods: row.methods, keys: row.keys, selected,
        readerChangedSincePreviousRequest: previous ? previous.reader !== current.reader : null,
        changedSincePreviousRequest: previous ? Object.keys(current.components).filter(key => previous.components[key] !== current.components[key]) : null };
      previous = current;
      return entry;
    });
    result.concurrentCoverage = { requested: rounds, publishedReader: selections.filter(row => /-during-sync$/.test(row.label) && row.role === 'published').length,
      selectedReaders: selections.filter(row => /-during-sync$/.test(row.label)).map(row => ({ label: row.label, role: row.role, reader: row.state.reader })) };
    result.prefixWorkerThreads = events.filter(row => row.kind === 'preload-ready' && row.role === 'prefix-worker').map(row => row.threadId);
    result.instrumentationValidated = true;
  } catch (error) {
    result.validationFailure = { message: error.message, stack: error.stack };
    process.exitCode = 1;
  }
  result.finishedAt = new Date().toISOString();
  result.maxRSSKiB = process.resourceUsage().maxRSS;
  save();
}
console.log(JSON.stringify({ directory: probe.runDirectory, failure: result.failure, validationFailure: result.validationFailure,
  concurrentCoverage: result.concurrentCoverage, inputsUnchanged: result.inputsUnchanged }));
