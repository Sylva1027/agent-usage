/* Main only, after the execution slot is free:
 * cwd: E:/12 AI/ccusage/codex-usage; NODE_OPTIONS empty.
 * READER_LEDGER_RUN=reader-ledger-<unique>; READER_LEDGER_IDENTITY defaults to
 * output/codex-refresh-followup-20261027/probes/identity-after.json.
 * READER_LEDGER_CODE_ROOT defaults to this stage's private after-code (including package.json).
 * Every module is checked against identity-after even when its codeRoot field names current.
 * Launch with --import ./docs/validation/2026-10-27-codex-refresh-followup/probes/reader-ledger-hook.mjs
 * then this script; optional --candidates-only performs no overlay append.
 * Use scripts/run-with-memory-limit.ps1: LimitMiB 7168, TimeoutSeconds 900,
 * node --max-old-space-size=1536. No other job may share the 8 GiB budget.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const probe = globalThis.__readerLedgerProbe;
assert.ok(probe, 'launch with the independent reader-ledger-hook.mjs preload');
assert.ok(process.argv.slice(2).every(value => value === '--candidates-only'), 'only --candidates-only is supported');
const candidatesOnly = process.argv.includes('--candidates-only');
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
const result = { startedAt: new Date().toISOString(), codeRoot: probe.codeRoot, identityFile: probe.setup.identityFile,
  node: process.version, candidatesOnly, samples: [], ledger: probe.setup.ledger,
  context: { preset: 'all', bucket: 'day', calendarZone: 'local', now: '2026-10-26T15:00:00.000Z' },
  coverage: { realExecutor: false, nativeCandidate: false, ledgerOnly: false, sameWriter: false, concurrentPublishedReader: false },
  limits: ['One controlled timing record for existing native evidence; no rollout changes or production duration claim.',
    'Instrumented method times are inclusive; generator time includes its consumer between yields.',
    'No HTTP/browser, cold ATTACH, long-run distribution or whole-Job peak measurement.'] };
const save = () => fs.writeFileSync(path.join(probe.runDirectory, 'results.json'), JSON.stringify(result, null, 2));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function normalizedSummary(value, includePerf = true) {
  const summary = structuredClone(value.summary);
  delete summary.generatedAt;
  if (!includePerf) delete summary.perf;
  else if (summary.perf) { delete summary.perf.indexedAt; if (summary.perf.meta) delete summary.perf.meta.indexedAt; }
  return summary;
}
async function timed(label, action) {
  probe.label = label;
  const started = performance.now(), value = await action();
  const sample = { label, ms: performance.now() - started, rss: process.memoryUsage().rss };
  if (value?.summary) Object.assign(sample, { summaryHash: hash(normalizedSummary(value)),
    usageHash: hash(normalizedSummary(value, false)), totals: value.summary.totals, perf: value.summary.perf,
    status: value.status, range: value.summary.range });
  if (value?.updatedFileCount !== undefined) Object.assign(sample, { updatedFileCount: value.updatedFileCount, status: value });
  result.samples.push(sample);
  save();
  console.log(JSON.stringify({ label, ms: sample.ms, updatedFileCount: sample.updatedFileCount, summaryHash: sample.summaryHash }));
  return value;
}
const dashboard = label => timed(label, () => executor.dashboard({ ...result.context, now: new Date(result.context.now),
  pricingModels: getPricingCatalog().models }, { includeDetails: false }));
const sync = label => timed(label, () => executor.sync());
async function measure() {
  await timed('open-excluded', () => executor.open());
  await sync('catchup-excluded');
  let stable = 0;
  for (let index = 0; index < 4 && stable < 2; index++) {
    const status = await sync(`settle-excluded-${index}`);
    stable = status.updatedFileCount === 0 ? stable + 1 : 0;
  }
  assert.equal(stable, 2, 'frozen inputs did not settle within four rounds');
  const before = await dashboard('ledger-before-first');
  const warm = await dashboard('ledger-before-warm');
  assert.deepEqual(normalizedSummary(warm), normalizedSummary(before), 'same context changed before ledger append');
  probe.label = 'ledger-candidate-query';
  result.candidates = await executor.readerLedgerCandidates({ range: before.summary.range, models: before.summary.perf.models });
  const candidate = result.candidates.selected;
  save();
  if (!candidate) {
    result.notMeasured = result.candidates.reason;
    return;
  }
  result.coverage.nativeCandidate = true;
  if (candidatesOnly) {
    result.notMeasured = 'candidates-only: no ledger append requested';
    return;
  }
  probe.label = 'ledger-native-before';
  result.nativeBefore = await executor.readerLedgerInspect(candidate);
  assert.equal(result.nativeBefore.lookup.state, 'missing');
  assert.equal(result.nativeBefore.sample.duration_ms, null);
  const ledgerSize = fs.statSync(probe.overlayLedger).size;
  if (ledgerSize > 0) {
    const fd = fs.openSync(probe.overlayLedger, 'r'), last = Buffer.alloc(1);
    try { assert.equal(fs.readSync(fd, last, 0, 1, ledgerSize - 1), 1); }
    finally { fs.closeSync(fd); }
    if (last[0] !== 10) {
      result.notMeasured = 'frozen-ledger-has-incomplete-tail: overlay left byte-identical';
      return;
    }
  }
  result.overlayBeforeHash = probe.fileHash(probe.overlayLedger);
  assert.equal(result.overlayBeforeHash, probe.setup.ledger.initialHash, 'overlay changed before the single append');
  assert.equal(probe.mapped(probe.logicalLedger), probe.overlayLedger);
  assert.equal(probe.mapped(probe.frozenLedger), probe.frozenLedger, 'frozen physical ledger must not redirect');
  fs.appendFileSync(probe.overlayLedger, JSON.stringify(candidate.ledgerRow) + '\n');
  result.append = { row: candidate.ledgerRow, bytesBefore: ledgerSize, bytesAfter: fs.statSync(probe.overlayLedger).size,
    overlayHash: probe.fileHash(probe.overlayLedger), controlledDurationMs: candidate.durationMs };
  const pending = sync('ledger-only-sync');
  const both = await Promise.allSettled([pending, dashboard('ledger-during-sync')]);
  const failed = both.find(row => row.status === 'rejected');
  if (failed) throw failed.reason;
  const status = both[0].value, during = both[1].value;
  assert.equal(status.updatedFileCount, 0, 'ledger-only sync must not update source files');
  const after = await dashboard('ledger-after-first');
  const afterWarm = await dashboard('ledger-after-warm');
  probe.label = 'ledger-native-after';
  result.nativeAfter = await executor.readerLedgerInspect(candidate);
  assert.equal(result.nativeBefore.writer.reader, result.nativeAfter.writer.reader, 'writer replaced across ledger-only sync');
  result.coverage.sameWriter = true;
  assert.equal(result.nativeAfter.lookup.state, 'available');
  assert.equal(result.nativeAfter.lookup.durationMs, candidate.durationMs);
  assert.equal(result.nativeAfter.sample.duration_ms, candidate.expected.durationMs);
  assert.equal(result.nativeAfter.sample.output_tokens, candidate.expected.outputTokens);
  assert.equal(result.nativeAfter.dirtyThreads, 0, 'new timing must publish in this sync');
  for (const value of [during, after, afterWarm]) assert.deepEqual(normalizedSummary(value, false), normalizedSummary(before, false),
    'ledger-only changed usage tokens, timeline or cost');
  assert.deepEqual(normalizedSummary(afterWarm), normalizedSummary(after), 'same post-publication context changed');
  const sampledBefore = before.summary.perf.codexTimingCoverage.sampledOutputTokens;
  const sampledAfter = after.summary.perf.codexTimingCoverage.sampledOutputTokens;
  assert.equal(sampledAfter - sampledBefore, candidate.expected.outputTokens, 'exact native output must gain timing coverage');
  const beforeModel = before.summary.perf.models.find(row => row.key === candidate.modelKey);
  const afterModel = after.summary.perf.models.find(row => row.key === candidate.modelKey);
  assert.ok(afterModel && afterModel.averageTps !== null, 'matched native timing has no visible TPS');
  assert.equal(afterModel.n, (beforeModel?.n ?? 0) + 1, 'one native turn must join the timed model');
  assert.notEqual(afterModel.averageTps, beforeModel?.averageTps ?? null, 'target model TPS did not change');
  result.timingChange = { sampledBefore, sampledAfter, beforeModel, afterModel };
  result.coverage.ledgerOnly = true;
  const noop = await sync('ledger-after-no-op-sync');
  assert.equal(noop.updatedFileCount, 0);
  const afterNoop = await dashboard('ledger-after-no-op');
  assert.deepEqual(normalizedSummary(afterNoop), normalizedSummary(after), 'no-op lost or changed published timing');
  // Used after close to validate the actual reader role, without a barrier that changes scheduling.
  result.duringSummary = normalizedSummary(during);
  result.beforeSummary = normalizedSummary(before);
}
try { await measure(); }
catch (error) { result.failure = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally {
  probe.label = 'close';
  await executor.close();
  try {
    probe.verifyInputs();
    result.inputsUnchanged = true;
    const events = fs.readdirSync(probe.runDirectory).filter(name => /^events-\d+\.jsonl$/.test(name)).flatMap(name =>
      fs.readFileSync(path.join(probe.runDirectory, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
    const worker = events.find(row => row.kind === 'preload-ready' && row.role === 'executor-worker');
    assert.ok(worker && events.some(row => row.kind === 'sqlite-open' && row.threadId === worker.threadId && row.physical === probe.databaseFile));
    assert.ok(!events.some(row => row.kind === 'sqlite-open' && row.threadId === 0), 'main opened SQLite');
    assert.ok(events.some(row => row.kind === 'store-instrumented' && row.threadId === worker.threadId));
    result.coverage.realExecutor = true;
    const selections = events.filter(row => row.kind === 'dashboard-reader');
    const requests = events.filter(row => row.kind === 'request-complete' && row.type === 'dashboard');
    let previous;
    result.dashboardAttribution = requests.map(row => {
      assert.ok(row.keys.length > 0, 'missing hot projection keys');
      const key = row.keys.at(-1), selected = selections.find(item => item.threadId === row.threadId && item.requestId === row.requestId);
      assert.ok(selected, 'dashboard reader selection missing');
      const entry = { label: row.label, workerMs: row.ms, methods: row.methods, keys: row.keys, selected,
        readerChangedSincePreviousRequest: previous ? key.reader !== previous.reader : null,
        changedSincePreviousRequest: previous ? Object.keys(key.components).filter(name => key.components[name] !== previous.components[name]) : null };
      previous = key;
      return entry;
    });
    if (result.coverage.ledgerOnly) {
      const selected = selections.find(row => row.label === 'ledger-during-sync');
      result.concurrentSelection = selected;
      result.coverage.concurrentPublishedReader = selected?.role === 'published';
      if (result.coverage.concurrentPublishedReader) assert.deepEqual(result.duringSummary, result.beforeSummary, 'published reader exposed new/partial timing');
      else { result.concurrencyNotMeasured = 'during-sync dashboard selected writer; published-reader coverage is absent'; process.exitCode = 1; }
      const before = result.dashboardAttribution.find(row => row.label === 'ledger-before-warm');
      const after = result.dashboardAttribution.find(row => row.label === 'ledger-after-first');
      assert.equal(before.selected.state.reader, after.selected.state.reader);
    }
    result.instrumentationValidated = true;
  } catch (error) { result.validationFailure = { message: error.message, stack: error.stack }; process.exitCode = 1; }
  delete result.beforeSummary;
  delete result.duringSummary;
  result.finishedAt = new Date().toISOString();
  result.maxRSSKiB = process.resourceUsage().maxRSS;
  save();
}
console.log(JSON.stringify({ directory: probe.runDirectory, coverage: result.coverage, notMeasured: result.notMeasured,
  failure: result.failure, validationFailure: result.validationFailure, concurrencyNotMeasured: result.concurrencyNotMeasured }));
