import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('output/codex-refresh-followup-20261027');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const stats = values => {
  const rows = [...values].sort((a, b) => a - b);
  return { n: rows.length, p50: rows[Math.ceil(rows.length * 0.5) - 1], p95: rows[Math.ceil(rows.length * 0.95) - 1], max: rows.at(-1) };
};
const paired = read('paired-results.json');
assert.equal(paired.completed, true);
assert.equal(paired.pairs.length, 40);
const result = { paired: {}, io: {}, resource: { totalBudgetGiB: 8, realJobLimitMiB: 7168,
  pairedProcessMaxRSSKiB: paired.maxRSSKiB, pairedMinSystemFreeGiB: paired.minFreeGiB, wholeJobPeakMeasured: false } };
for (const phase of ['static', 'ledger']) {
  result.paired[phase] = {};
  for (const mode of ['before', 'after']) {
    const rows = paired.samples.filter(row => row.phase === phase && row.mode === mode);
    assert.equal(rows.length, 20);
    result.paired[phase][mode] = Object.fromEntries(['syncMs', 'queryMs', 'combinedMs'].map(key => [key, stats(rows.map(row => row[key]))]));
  }
  result.paired[phase].perPairImprovement = stats(Array.from({ length: 20 }, (_, index) => {
    const before = paired.samples.find(row => row.phase === phase && row.index === index && row.mode === 'before');
    const after = paired.samples.find(row => row.phase === phase && row.index === index && row.mode === 'after');
    assert.equal(before.summaryHash, after.summaryHash);
    assert.equal(before.fingerprint, after.fingerprint);
    return before.syncMs - after.syncMs;
  }));
}
for (const mode of ['before', 'after']) {
  const traces = fs.readFileSync(path.join(root, 'probes/runs', `prescan-${mode}`, 'stages.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const row = traces.find(row => row.label === 'unchanged-sync');
  assert.equal(row.instrumentation.valid, true);
  result.io[mode] = { bytes: row.bytes, readCalls: row.readCalls, phases: Object.keys(row.phases) };
}
result.io.reducedBytes = result.io.before.bytes - result.io.after.bytes;
result.io.reducedReadCalls = result.io.before.readCalls - result.io.after.readCalls;
assert.equal(result.io.reducedBytes, 170361023);
assert.equal(result.io.after.phases.includes('decision.prescan'), false);
result.completePublicSummaryPairs = paired.pairs.length;
result.generatedAt = new Date().toISOString();
fs.writeFileSync(path.join(root, 'evidence/summary.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
