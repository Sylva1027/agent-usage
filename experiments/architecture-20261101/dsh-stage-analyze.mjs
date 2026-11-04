import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const label = process.argv[2];
const output = path.resolve('output/architecture-20261103/dsh-stage', label);
const manifest = JSON.parse(readFileSync(path.join(output, 'manifest.json')));
assert.equal(manifest.runs.length, manifest.diagnostic ? 2 : 6);
const base = path.resolve('output/architecture-20261102/full-startup');
const quote = name => `"${name.replaceAll('"', '""')}"`;
function facts(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(['events', 'rate_limit_observations', 'quota_usage_sources', 'source_files'].map(table => {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name)
        .filter(name => name !== 'id' && name !== 'indexed_at');
      const list = columns.map(quote).join(',');
      const hash = createHash('sha256'); let count = 0;
      for (const row of db.prepare(`SELECT ${list} FROM ${table} ORDER BY ${list}`).iterate()) {
        hash.update(JSON.stringify(row)).update('\n'); count++;
      }
      return [table, { count, sha256: hash.digest('hex') }];
    }));
  } finally { db.close(); }
}
const runs = manifest.runs.map(run => {
  assert.equal(run.exitCode, 0);
  const directory = path.join(base, run.name);
  const result = JSON.parse(readFileSync(path.join(directory, 'result.json')));
  assert.equal(result.status, 200); assert(!result.failure); assert.deepEqual(result.errors, []);
  const processes = readdirSync(directory).filter(name => /^process-.*\.ndjson$/.test(name)).map(name => {
    const records = readFileSync(path.join(directory, name), 'utf8').trim().split('\n').map(JSON.parse);
    const exit = records.findLast(record => record.type === 'exit'); assert(exit, `Missing process exit: ${name}`);
    assert.equal(exit.code, 0);
    return { executor: records[0].execArgv.some(arg => arg === '--max-old-space-size=224'),
      cpuSeconds: (exit.cpu.user + exit.cpu.system) / 1e6, peakRssMiB: exit.resource.maxRSS / 1024 };
  });
  return { ...run, firstPaintSeconds: result.firstPaintMs / 1000,
    cpuSeconds: processes.reduce((sum, p) => sum + p.cpuSeconds, 0),
    executorPeakRssMiB: Math.max(...processes.filter(p => p.executor).map(p => p.peakRssMiB)),
    sumOfProcessPeaksMiB: processes.reduce((sum, p) => sum + p.peakRssMiB, 0),
    metadata: { eventCount: result.metadata.eventCount, sessionCount: result.metadata.sessionCount,
      homeCount: result.metadata.homeCount },
    facts: facts(path.join(directory, 'state/usage-index.sqlite')) };
});
for (const run of runs) { assert.deepEqual(run.facts, runs[0].facts); assert.deepEqual(run.metadata, runs[0].metadata); }
const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length / 2)];
const summary = Object.fromEntries(['baseline','candidate'].map(variant => {
  const selected = runs.filter(run => run.variant === variant); assert.equal(selected.length, manifest.diagnostic ? 1 : 3);
  return [variant, Object.fromEntries(['firstPaintSeconds','cpuSeconds','executorPeakRssMiB','sumOfProcessPeaksMiB'].map(metric =>
    [metric, { median: median(selected.map(run => run[metric])), min: Math.min(...selected.map(run => run[metric])),
      max: Math.max(...selected.map(run => run[metric])) }]))];
}));
const report = { pass: true, diagnostic: Boolean(manifest.diagnostic), summary, runs, notes: ['Three standard samples or one diagnostic sample per variant; no p95 claim.',
  'Per-process peak RSS includes its full lifetime. Sum of peaks is a conservative sum, not a simultaneous service-tree peak.',
  'CPU is summed across recorded service processes; browser excluded. No OS file-cache flush.'] };
writeFileSync(path.join(output, 'analysis.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ pass: true, summary, facts: runs[0].facts }, null, 2));
