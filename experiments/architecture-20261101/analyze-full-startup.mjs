import { refreshSummaryClock } from '../../src/usage-summary-cache.js';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const base = path.resolve('output/architecture-20261102/full-startup');
const label = process.env.ARCH_FULL_RUN_LABEL ? '-' + process.env.ARCH_FULL_RUN_LABEL : '';
const results = [];
for (const entry of await readdir(base, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const directory = path.join(base, entry.name);
  if (await readFile(path.join(directory, 'INVALID.json')).then(() => true, () => false)) continue;
  const result = await readFile(path.join(directory, 'result.json'), 'utf8').then(JSON.parse, () => null); if (!result) continue;
  const spans = [];
  for (const name of await readdir(path.join(directory, 'trace')).catch(() => [])) if (name.endsWith('.ndjson')) {
    for (const line of (await readFile(path.join(directory, 'trace', name), 'utf8')).trim().split('\n')) if (line) spans.push(JSON.parse(line));
  }
  const cutoff = Date.parse(result.startedAt) + (result.firstPaintMs || Infinity);
  const labels = {};
  for (const span of spans.filter(s => s.start < cutoff)) {
    const row = labels[span.label] ||= { count: 0, totalMs: 0, maxMs: 0, errors: 0 };
    const duration = Math.min(span.duration, cutoff - span.start);
    row.count++; row.totalMs += duration; row.maxMs = Math.max(row.maxMs, duration); if (span.status !== 'ok') row.errors++;
  }
  const memories = [];
  for (const name of await readdir(directory)) if (/^process-.*\.ndjson$/.test(name)) {
    for (const line of (await readFile(path.join(directory, name), 'utf8')).trim().split('\n')) if (line) memories.push(JSON.parse(line));
  }
  const pids = [...new Set(memories.map(m => m.pid))];
  const resources = pids.map(pid => { const rows = memories.filter(m => m.pid === pid); return { pid, ppid: rows[0].ppid, argv: rows[0].argv, heapFlags: rows[0].execArgv, peakRss: Math.max(...rows.map(m => m.rss)), peakHeapUsed: Math.max(...rows.map(m => m.heapUsed)), exit: rows.at(-1).type === 'exit' ? rows.at(-1).code : null }; });
  const stages = await readFile(path.join(directory, 'prototype-stages.ndjson'), 'utf8').then(s => s.trim().split('\n').filter(Boolean).map(JSON.parse), () => []);
  results.push({ ...result, labels, resources, prototypeStages: stages });
}
const pairs = [];
function equalBusiness(actual, expected) {
  if (typeof actual === 'number' && typeof expected === 'number') return Number.isInteger(actual) && Number.isInteger(expected) ? actual === expected : Math.abs(actual - expected) <= 1e-8;
  if (Array.isArray(actual) && Array.isArray(expected)) return actual.length === expected.length && actual.every((v, i) => equalBusiness(v, expected[i]));
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const keys = Object.keys(actual).sort(), other = Object.keys(expected).sort();
    return JSON.stringify(keys) === JSON.stringify(other) && keys.every(k => equalBusiness(actual[k], expected[k]));
  }
  return actual === expected;
}
for (const scenario of ['indexed', 'pending']) {
  const formal = results.find(r => r.name === `formal-${scenario}-u1${label}`); if (!formal?.total) continue;
    const sameClock = body => refreshSummaryClock(body, new Date(formal.startedAt));
    const expected = sameClock(JSON.parse(await readFile(path.join(formal.output, 'first-response.json'), 'utf8')));
  for (const variant of ['node-sqlite', 'rust-sqlite', 'rust-redb', 'rust-duckdb']) {
    const row = results.find(r => r.name === `${variant}-${scenario}-u1${label}`); if (!row?.total) continue;
    const actual = sameClock(JSON.parse(await readFile(path.join(row.output, 'first-response.json'), 'utf8')));
    const checks = [];
    const check = (label, a, b) => { checks.push(equalBusiness(a, b) ? { label, equal: true } : { label, equal: false, actual: a, expected: b }); };
    const fields = ['totals', 'eventCount', 'sessionCount', 'homeCount', 'costEstimate', 'channels', 'models', 'timeline', 'comparison'];
    for (const name of fields) check('today.' + name, actual.summary[name], expected.summary[name]);
    for (const preset of ['all', 'today', 'week', 'month']) {
      const a = await readFile(path.join(row.output, `response-${preset}.json`), 'utf8').then(JSON.parse, () => null);
      const b = await readFile(path.join(formal.output, `response-${preset}.json`), 'utf8').then(JSON.parse, () => null);
      if (!a || !b) continue;
      sameClock(a); sameClock(b);
      for (const name of fields) check(preset + '.' + name, a.summary[name], b.summary[name]);
    }
    pairs.push({ variant, scenario, pass: checks.every(c => c.equal), checks });
  }
}
const output = { generatedAt: new Date().toISOString(), results, pairs };
await writeFile(path.join(base, `analysis${label}.json`), JSON.stringify(output, null, 2));
console.log(JSON.stringify({ results: results.map(r => ({ name: r.name, firstPaintMs: r.firstPaintMs, cache: r.summaryCache, failure: r.failure, parsedFiles: r.labels['usage-store.replaceFile']?.count, gate: r.labels['server.loadUsageStore']?.maxMs, dashboard: r.labels['usage-store.dashboardHistory']?.maxMs })), parity: pairs.map(({ variant, scenario, pass, checks }) => ({ variant, scenario, pass, failures: checks.filter(c => !c.equal) })) }, null, 2));
