import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

// Main runs this alone in the existing 7168 MiB Job, heap <=1536 MiB.
// REFRESH_TRACE=0 Q23_LOG_FILE=<fresh log>; FOLLOWUP_ROUNDS defaults to 3, accepts 20.
// Primary scenario: warm each writer ONCE, then only query published readers during sync.
const root = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(root, '../..');
assert.equal(path.resolve(process.cwd()), repository, 'run from the repository root');
assert.equal(process.env.REFRESH_TRACE, '0', 'REFRESH_TRACE=0 is required before preloading hooks');
assert.notEqual(process.env.REFRESH_PRODUCT_BEFORE, '1', 'before is after-q2-v4, never the original preimage');
assert.ok(process.env.Q23_LOG_FILE, 'Q23_LOG_FILE is required for actual reader attribution');
const logFile = path.resolve(process.env.Q23_LOG_FILE);
process.env.Q23_LOG_FILE = logFile;
for (const name of ['runtime-hook.mjs', 'execution-hook.mjs']) {
  assert.ok(process.execArgv.some(argument => argument.endsWith('/' + name)),
    'supply ' + name + ' as a real CLI --import so workers inherit it');
}
const rounds = Number(process.env.FOLLOWUP_ROUNDS || 3);
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 20, 'FOLLOWUP_ROUNDS must be 1..20');
const resultFile = path.resolve(root, process.env.Q23_RESULT || 'q3-smoke.json');
assert.notEqual(resultFile, logFile, 'result and execution log must be separate files');
const frozen = JSON.parse(fs.readFileSync(path.join(repository, '.codex-usage/refresh-latency-20261026/freeze.json'), 'utf8'));
const context = { preset: 'all', bucket: 'day', calendarZone: 'local', now: '2026-10-26T15:00:00.000Z' };
const runId = `${process.pid}-${randomUUID()}`;
const result = { runId, rounds, startedAt: new Date().toISOString(), context, logFile,
  scenario: 'warm-writer-once-then-continuous-published-reader-only', samples: [], pairs: [], databases: [],
  summaryIgnoredPaths: ['generatedAt', 'perf.indexedAt', 'perf.meta.indexedAt'],
  metadataPolicy: 'Raw metadata retained. Every field is compared exactly; generatedAt is separately verified against each side previous publication, with both raw values reported.',
  periodPolicy: 'Entire periodComparison compared exactly, including fixed asOf.',
  seed: { file: frozen.database, bytes: fs.statSync(frozen.database).size }, completed: false };
const entries = [];
const hash = value => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
const save = () => fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
const info = error => ({ name: error.name, message: error.message, code: error.code, stack: error.stack });
const offset = () => fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
const sameFile = (a, b) => typeof a === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const identity = row => `${row.pid}:${row.threadId}:${row.instance}`;
function trace(start, end, entry) {
  return fs.readFileSync(logFile).subarray(start, end).toString('utf8').split(/\r?\n/).filter(Boolean)
    .map(line => JSON.parse(line)).filter(row => sameFile(row.file, entry.databaseFile));
}
function moduleHashes(codeRoot) {
  return Object.fromEntries(['src/usage-executor.js', 'src/usage-store.js', 'src/service-tier-evidence.js',
    'src/pricing-store.js', 'src/pricing.js', 'package.json'].map(file =>
    [file, createHash('sha256').update(fs.readFileSync(path.join(codeRoot, file))).digest('hex')]));
}
function summary(value) {
  const copy = structuredClone(value.summary);
  delete copy.generatedAt;
  if (copy.perf) { delete copy.perf.indexedAt; if (copy.perf.meta) delete copy.perf.meta.indexedAt; }
  return copy;
}
function compare(left, right, label) {
  assert.deepEqual(summary(left), summary(right), `${label}: complete summary`);
  assert.deepEqual(left.periodComparison, right.periodComparison, `${label}: complete periodComparison`);
  assert.deepEqual(Object.keys(left.metadata).sort(), Object.keys(right.metadata).sort(), `${label}: metadata shape`);
  for (const key of Object.keys(left.metadata)) {
    if (key !== 'generatedAt') assert.deepEqual(left.metadata[key], right.metadata[key], `${label}: metadata.${key}`);
  }
  return { summaryEqual: true, periodComparisonExact: true, metadataStableFieldsExact: true,
    metadataRawExact: isDeepStrictEqual(left.metadata, right.metadata),
    metadataGeneratedAt: { left: left.metadata.generatedAt, right: right.metadata.generatedAt } };
}
function publication(value, expected) {
  assert.ok(expected?.generatedAt, 'a prior successful publication is required');
  assert.equal(value.status.checkedAt, expected.checkedAt, 'dashboard must serve the previous publication');
  assert.equal(value.status.fingerprint, expected.fingerprint);
  assert.equal(value.summary.generatedAt, expected.generatedAt);
  if (Object.hasOwn(value.metadata, 'generatedAt')) {
    assert.equal(value.metadata.generatedAt, expected.generatedAt, 'metadata publication clock must be exact');
  }
  if (Object.hasOwn(value.periodComparison, 'asOf')) assert.equal(value.periodComparison.asOf, context.now);
}
async function timed(entry, phase, index, action) {
  const row = { mode: entry.mode, phase, index, databaseFile: entry.databaseFile, startedAt: new Date().toISOString() };
  result.samples.push(row);
  const started = performance.now();
  try {
    const value = await action();
    row.ms = performance.now() - started;
    row.responseHash = hash(value);
    if (value?.summary) {
      row.summaryHash = hash(summary(value));
      row.summaryRawHash = hash(value.summary);
      row.metadataHash = hash(value.metadata);
      row.periodComparisonHash = hash(value.periodComparison);
      row.payload = { summary: summary(value), metadata: value.metadata, periodComparison: value.periodComparison };
      row.status = value.status; // checkedAt belongs to this side's own sync round, not A/B equality.
      row.summaryClocks = { generatedAt: value.summary.generatedAt,
        perfIndexedAt: value.summary.perf?.indexedAt, perfMetaIndexedAt: value.summary.perf?.meta?.indexedAt };
    } else row.status = value;
    return { value, row };
  } catch (error) {
    row.ms ??= performance.now() - started;
    row.error = info(error);
    throw error;
  }
}
const dashboard = entry => entry.executor.dashboard({ ...context, now: new Date(context.now),
  pricingModels: entry.catalog().models }, { includeDetails: false });
async function measure(entry, index) {
  const prior = entry.lastSync;
  const startOffset = offset();
  const started = performance.now();
  let syncSettled = false;
  // Attach both rejection handlers immediately, including during the 100 ms delay.
  const syncing = timed(entry, 'sync', index, () => entry.executor.sync()).then(
    value => { syncSettled = true; return { value }; }, error => { syncSettled = true; return { error }; });
  await delay(100);
  const dashboardOffsetMs = performance.now() - started;
  const syncPendingAtDashboardStart = !syncSettled;
  const reading = timed(entry, 'dashboard-during-sync', index, () => dashboard(entry)).then(
    value => ({ value }), error => ({ error }));
  const [sync, read] = await Promise.all([syncing, reading]);
  const combinedMs = performance.now() - started;
  const endOffset = offset();
  const row = { mode: entry.mode, phase: 'combined', index, ms: combinedMs, dashboardOffsetMs,
    syncPendingAtDashboardStart, traceStart: startOffset, traceEnd: endOffset };
  result.samples.push(row);
  save();
  if (sync.error) throw sync.error;
  if (read.error) throw read.error;
  row.syncMs = sync.value.row.ms;
  row.dashboardMs = read.value.row.ms;
  row.responseHash = hash([sync.value.row.responseHash, read.value.row.responseHash]);
  const events = trace(startOffset, endOffset, entry);
  row.execution = events;
  assert.ok(events.length > 0, 'worker execution-hook records are required');
  assert.ok(events.every(event => !event.error), 'hook recorded an operation failure');
  assert.ok(events.every(event => event.mappingActive && event.homeMapped !== false), 'worker must use private source mapping');
  assert.ok(events.every(event => path.resolve(fileURLToPath(event.module)) === path.join(entry.codeRoot, 'src/usage-store.js')), 'worker loaded wrong module tree');
  const perf = events.filter(event => event.method === 'perfSummaryForRange');
  assert.equal(perf.length, 1, 'exactly one target perf read is expected');
  row.reader = identity(perf[0]);
  assert.notEqual(row.reader, entry.writer, 'during-sync dashboard selected writer instead of published reader');
  assert.equal(perf[0].transaction, true, 'published reader must still hold its read transaction');
  assert.equal(perf[0].writeDepth, 0);
  assert.ok(perf[0].threadId > 0, 'SQLite work must run in the actual executor worker');
  assert.equal(syncPendingAtDashboardStart, true, 'sync finished before the delayed dashboard was sent');
  assert.ok(!entry.readers.has(row.reader), 'each sync must create a new published reader');
  entry.readers.add(row.reader);
  row.timelineCalls = events.filter(event => event.method === 'timelineRange').length;
  if (entry.mode === 'after') {
    const captures = events.filter(event => event.method === 'captureUsageProjection');
    const adopts = events.filter(event => event.method === 'adoptUsageProjection');
    assert.equal(captures.length, 2, 'capture and post-pin source recheck must both run');
    assert.equal(adopts.length, 1, 'continuous reuse must survive without rewarming the writer');
    for (const capture of captures) {
      assert.equal(identity(capture), entry.writer);
      assert.equal(capture.result, true, 'writer capture or post-pin recheck missed in the continuous scenario');
    }
    assert.equal(identity(adopts[0]), row.reader);
    assert.equal(adopts[0].result, true, 'published reader did not adopt the usage payload');
    assert.equal(row.timelineCalls, 0, 'accepted usage must avoid the timeline scan');
  }
  assert.equal(sync.value.value.updatedFileCount, 0, 'frozen formal sync must be a no-op');
  assert.equal(sync.value.value.fingerprint, prior.fingerprint, 'published source signature changed');
  publication(read.value.value, prior);
  row.withInitialWarm = compare(read.value.value, entry.reference, `${entry.mode} round ${index} continuity`);
  entry.lastSync = { ...sync.value.value, generatedAt: entry.executor.metadata().generatedAt };
  save();
  return { value: read.value.value, row };
}
try {
  for (const [mode, directory] of [['before', 'after-q2-v4'], ['after', 'final-v4']]) {
    const codeRoot = path.join(root, directory);
    const executorModule = await import(pathToFileURL(path.join(codeRoot, 'src/usage-executor.js')).href);
    const pricingModule = await import(pathToFileURL(path.join(codeRoot, 'src/pricing.js')).href);
    const { loadPricingFile } = await import(pathToFileURL(path.join(codeRoot, 'src/pricing-store.js')).href);
    const databaseFile = path.join(root, `q3-executor-${mode}-${runId}.sqlite`);
    assert.equal(fs.existsSync(databaseFile), false);
    result.databases.push(databaseFile);
    await fsp.copyFile(frozen.database, databaseFile, fs.constants.COPYFILE_EXCL);
    const options = { ...frozen.options, databaseFile, automaticDiscoveryEnabled: false, pricingRefreshSchedulerEnabled: false };
    await loadPricingFile(options);
    const entry = { mode, codeRoot, databaseFile, catalog: pricingModule.getPricingCatalog,
      executor: executorModule.createUsageExecutor(options, { pricing: pricingModule.getPricingCatalog }),
      moduleHashes: moduleHashes(codeRoot), readers: new Set() };
    entries.push(entry);
    result[mode] = { codeRoot, databaseFile, moduleHashes: entry.moduleHashes };
    await timed(entry, 'open-excluded', -1, () => entry.executor.open());
    await timed(entry, 'catchup-excluded', -1, () => entry.executor.sync());
    let stableRounds = 0;
    for (let index = 0; index < 8 && stableRounds < 2; index++) {
      const stable = await timed(entry, 'stable-sync-excluded', index, () => entry.executor.sync());
      stableRounds = stable.value.updatedFileCount === 0 ? stableRounds + 1 : 0;
      entry.lastSync = { ...stable.value, generatedAt: entry.executor.metadata().generatedAt };
    }
    assert.equal(stableRounds, 2, 'two consecutive no-op rounds are required before measuring');
  }
  assert.deepEqual(entries[0].catalog(), entries[1].catalog(), 'both module trees must load the same pricing');
  assert.notStrictEqual(entries[0].executor, entries[1].executor);
  for (const entry of entries) {
    const start = offset();
    const warm = await timed(entry, 'writer-warm-once-excluded', -1, () => dashboard(entry));
    const events = trace(start, offset(), entry).filter(event => event.method === 'perfSummaryForRange');
    assert.equal(events.length, 1, 'initial writer identity must be observable');
    entry.writer = identity(events[0]);
    entry.reference = warm.value;
    publication(warm.value, entry.lastSync);
    result[entry.mode].writer = entry.writer;
  }
  result.initialWarmParity = compare(entries[0].reference, entries[1].reference, 'initial warm A/B');
  save();
  for (let index = 0; index < rounds; index++) {
    const order = index % 2 === 0 ? entries : [...entries].reverse();
    const first = await measure(order[0], index);
    const second = await measure(order[1], index);
    const before = order[0].mode === 'before' ? first : second;
    const after = order[0].mode === 'after' ? first : second;
    const pair = { index, order: order.map(entry => entry.mode), parity: compare(before.value, after.value, `pair ${index}`),
      before: before.row, after: after.row, dashboardSavedMs: before.row.dashboardMs - after.row.dashboardMs,
      combinedSavedMs: before.row.ms - after.row.ms };
    result.pairs.push(pair);
    for (const entry of entries) assert.deepEqual(moduleHashes(entry.codeRoot), entry.moduleHashes, 'module tree changed during paired run');
    save();
    console.log(JSON.stringify({ index, order: pair.order, before: before.row.dashboardMs, after: after.row.dashboardMs,
      dashboardSavedMs: pair.dashboardSavedMs, combinedSavedMs: pair.combinedSavedMs, metadataRawExact: pair.parity.metadataRawExact }));
  }
  result.completed = true;
} catch (error) {
  result.failure = info(error);
  process.exitCode = 1;
} finally {
  result.cleanupErrors = [];
  for (const entry of entries) {
    try { await timed(entry, 'close-excluded', -1, () => entry.executor.close()); }
    catch (error) { result.cleanupErrors.push(info(error)); }
  }
  for (const databaseFile of result.databases) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { await fsp.rm(databaseFile + suffix, { force: true, maxRetries: 10, retryDelay: 50 }); }
      catch (error) { result.cleanupErrors.push(info(error)); }
    }
  }
  if (result.cleanupErrors.length) { result.completed = false; process.exitCode = 1; }
  result.finishedAt = new Date().toISOString();
  result.mainProcessMaxRSSKiB = process.resourceUsage().maxRSS; // Not the whole Job peak.
  save();
}
console.log(JSON.stringify({ resultFile, logFile, completed: result.completed, pairs: result.pairs.length,
  failure: result.failure, cleanupErrors: result.cleanupErrors }));






