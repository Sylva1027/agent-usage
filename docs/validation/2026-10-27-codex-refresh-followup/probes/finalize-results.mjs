import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.resolve('output/codex-refresh-followup-20261027');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const stats = values => {
  const ordered = [...values].sort((a, b) => a - b), rank = q => ordered[Math.ceil(ordered.length * q) - 1];
  return { n: ordered.length, p50: rank(0.5), p95: rank(0.95), max: ordered.at(-1) };
};
const result = read('evidence/summary.json');
const before = read('before-results.json'), after = read('after-results.json');
const first = before.samples.filter(row => row.label.startsWith('dashboard-'));
const last = after.samples.filter(row => row.label.startsWith('dashboard-'));
assert.equal(first.length, 63);
assert.equal(last.length, 63);
for (const row of first) assert.equal(last.find(value => value.label === row.label)?.hash, row.hash, row.label);
assert.deepEqual(read('before-summaries.json'), read('after-summaries.json'));
assert.deepEqual(before.tables, after.tables);
assert.equal(before.fingerprint, after.fingerprint);
result.sequentialQueries = {};
for (const preset of ['today', 'month', 'all']) {
  result.sequentialQueries[preset] = Object.fromEntries([['before', before], ['after', after]].map(([mode, value]) => {
    const rows = value.samples.filter(row => row.label.startsWith(`dashboard-${preset}-warm-`));
    assert.equal(rows.length, 20);
    return [mode, stats(rows.map(row => row.ms))];
  }));
}
result.sequentialPublicSummaryHashes = 63;
result.tableCountsAndFingerprintEqual = true;
const queryPair = read('query-paired-results.json');
assert.equal(queryPair.completed, true);
assert.equal(queryPair.pairs.length, 60);
assert.ok(queryPair.pairs.every(row => row.equal));
result.interleavedQueries = { pairs: queryPair.pairs.length, summary: queryPair.summary,
  unchangedMethods: queryPair.methodsUnchanged, maxRSSKiB: queryPair.maxRSSKiB };
const exact = read('ledger-exact-results.json');
assert.equal(exact.completed, true);
assert.equal(exact.checks.length, 21);
assert.ok(exact.checks.every(row => row.verified));
const rates = exact.requests.map(row => row.output * 1000 / row.durationMs).sort((a, b) => a - b);
const durations = exact.requests.map(row => row.durationMs).sort((a, b) => a - b);
const rank = (rows, q) => rows[Math.ceil(rows.length * q) - 1];
const expected = { ...exact.finalSourcePerf.reference, averageTps: exact.finalSourcePerf.reference.outputTokens * 1000 / exact.finalSourcePerf.reference.durationMs,
  p10: rank(rates, 0.1), p50: rank(rates, 0.5), p90: rank(rates, 0.9) };
const model = exact.finalSourcePerf.summary.models[0], group = exact.finalSourcePerf.summary.groups[0];
assert.deepEqual({ n: model.n, averageTps: model.averageTps, p10: model.p10, p90: model.p90 },
  { n: expected.n, averageTps: expected.averageTps, p10: expected.p10, p90: expected.p90 });
assert.deepEqual(group.tps, { p10: expected.p10, p50: expected.p50, p90: expected.p90, pooled: expected.averageTps });
assert.deepEqual(group.durationMs, { p50: rank(durations, 0.5), p90: rank(durations, 0.9) });
result.ledgerExact = { rounds: 20, checks: 21, perTurnChecks: 420, allFiveTokenComponentsUnchanged: true, independentReference: expected, passed: true };
const reader = read('reader-ledger-actual-after/results.json');
assert.equal(reader.inputsUnchanged, true);
assert.ok(Object.values(reader.coverage).every(value => value === true));
assert.equal(reader.failure, undefined);
assert.equal(reader.validationFailure, undefined);
result.actualLedgerExecutor = { coverage: reader.coverage, sampledOutputDelta: reader.timingChange.sampledAfter - reader.timingChange.sampledBefore,
  beforeRevision: reader.nativeBefore.writer.storeRevision, afterRevision: reader.nativeAfter.writer.storeRevision };
const retained = read('retained-results.json');
assert.equal(retained.equivalent, true);
result.retained = retained;
const tail = read('evidence/gates-tail.json');
assert.equal(tail.status, 0);
for (const [file, hash] of Object.entries(tail.hashes)) {
  assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), hash, file);
}
const covered = new Set([...tail.completedPrefix, ...tail.resumedFiles]);
assert.deepEqual([...covered].sort(), tail.allFiles);
const failures = fs.readFileSync(path.join(root, 'evidence/full-test.txt'), 'utf8').split('\n').filter(line => line.startsWith('✖'));
assert.equal(failures.length, 1);
assert.ok(failures[0].includes('S1 · 无提交轮次'));
const tailLog = fs.readFileSync(path.join(root, 'evidence/full-test-tail.txt'), 'utf8');
assert.match(tailLog, /ℹ pass 316/);
assert.match(tailLog, /ℹ fail 0/);
result.testCoverage = { firstRun: '900 s controller timeout; no complete case summary', firstObservedFailures: failures,
  totalFiles: tail.allFiles.length, completedPrefixFiles: tail.completedPrefix.length, resumedAndRecheckedFiles: tail.resumedFiles.length,
  coveredFiles: covered.size, recheckPass: 316, recheckFail: 0, singleCompleteGreenRun: false };
const browserFile = path.join(root, 'browser-controls-results.json');
if (fs.existsSync(browserFile)) {
  const browser = read('browser-controls-results.json');
  assert.equal(browser.failure, undefined);
  assert.deepEqual(browser.errors, []);
  assert.equal(browser.cycles.length, 4);
  assert.equal(browser.walAfterClose, 0);
  assert.ok(browser.twoTabs);
  for (const row of browser.cycles) assert.ok(Number.isFinite(row.fromCheckMs) && row.delta === row.expectedDelta);
  const cycles = browser.cycles.map(({ kind, delta, fromWriteMs, fromCheckMs, requests }) => {
    const durations = Object.fromEntries(['/api/status', '/api/usage'].map(endpoint => {
      const started = requests.filter(row => row.type === 'request' && row.path === endpoint);
      const finished = requests.filter(row => row.type === 'response' && row.path === endpoint);
      assert.equal(started.length, 1, `${kind}: one ${endpoint} request`);
      assert.equal(finished.length, 1, `${kind}: one ${endpoint} response`);
      assert.equal(finished[0].status, 200);
      assert.ok(finished[0].at >= started[0].at);
      if (endpoint === '/api/usage') {
        assert.equal(started[0].preset, 'all');
        assert.equal(started[0].skipCheck, null);
      }
      return [endpoint, finished[0].at - started[0].at];
    }));
    return { kind, delta, fromWriteMs, fromCheckMs, requestToResponseMs: durations };
  });
  result.browserControls = { mode: browser.probeMode, cycles,
    twoTabs: browser.twoTabs, errors: browser.errors, walAfterClose: browser.walAfterClose, maxRSSKiB: browser.maxRSSKiB,
    realIntervalDistributionRetested: false };
}
const postGates = read('evidence/gates-post.json');
assert.ok(postGates.length === 2 && postGates.every(row => row.status === 0));
result.postGates = postGates;
result.resource.observedNodeProcessPeakMiB = Math.max(result.resource.pairedProcessMaxRSSKiB,
  queryPair.maxRSSKiB, result.browserControls?.maxRSSKiB ?? 0) / 1024;
const cleanup = read('evidence/cleanup.json');
assert.equal(cleanup.completed, true);
assert.equal(cleanup.files.length, 5);
assert.ok(cleanup.files.every(row => row.deleted && !fs.existsSync(row.path)));
result.cleanup = { databaseFiles: cleanup.files.length, bytes: cleanup.bytes, completed: true };
const inputs = JSON.parse(fs.readFileSync('docs/validation/2026-10-27-codex-refresh-followup/evidence/inputs-final.json', 'utf8'));
assert.equal(inputs.allEquivalent, true);
assert.equal(inputs.verifiedInputs, 1633);
assert.equal(inputs.verifiedModules, 98);
assert.equal(inputs.seedHash, 'cfc35c20b32efd09328fde9ba477d25be3ebac5da33e55a26d9555090a085bd5');
result.finalInputs = inputs;
result.finalizedAt = new Date().toISOString();
fs.writeFileSync(path.join(root, 'evidence/summary.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ queries: result.sequentialQueries, independentTPS: expected, coveredFiles: covered.size }, null, 2));
