import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { distribution } from './product-benchmark-support.mjs';
import { VARIANTS } from './runner.mjs';

const directory = path.resolve(process.argv[2] || 'output/architecture-20261102/windows-matrix');
const matrix = JSON.parse(await readFile(path.join(directory, 'results.json'), 'utf8'));
const expected = matrix.results.some(r => r.variant === 'b0') ? ['b0', ...VARIANTS] : VARIANTS;
assert.deepEqual(matrix.results.map(r => r.variant).sort(), [...expected].sort(), 'All requested architecture groups must have results');
const results = [];
for (const result of matrix.results) {
  const raw = JSON.parse(await readFile(path.join(directory, result.variant, 'samples.json'), 'utf8'));
  if (result.passed) {
    for (const name of ['reload', 'switching', 'publication']) assert.equal(raw[name].length, matrix.samples, `${result.variant} ${name} incomplete`);
    const publications = raw.stages.filter(r => r.scenario === 'publication');
    assert.equal(publications.length, matrix.samples);
    assert.equal(new Set(publications.map(r => r.revision)).size, matrix.samples);
  }
  const timings = {};
  for (const scenario of ['switch', 'publication']) {
    const rows = raw.stages.filter(row => row.scenario === scenario);
    const measured = {};
    for (const name of ['feed', 'projection', 'core', 'response']) {
      const values = rows.map(row => Number(row.timing?.match(new RegExp(`(?:^|, )${name};dur=([\\d.]+)`))?.[1])).filter(Number.isFinite);
      if (values.length) measured[name] = { ...distribution(values), mean: values.reduce((sum, n) => sum + n, 0) / values.length };
    }
    if (scenario === 'publication' && rows.length) measured.commit = { ...distribution(rows.map(r => r.commitMs)), mean: rows.reduce((sum, row) => sum + row.commitMs, 0) / rows.length };
    timings[scenario] = measured;
  }
  const byPreset = {};
  for (const [i, preset] of ['today', 'week', 'month', 'all'].entries()) {
    const values = raw.switching.filter((_, index) => index % 4 === i);
    if (values.length) byPreset[preset] = distribution(values);
  }
  const memory = {};
  for (const scope of ['service', 'browser']) {
    const rows = raw.resourceSamples.map(row => row[scope]);
    if (rows.length) memory[scope] = {
      n: rows.length,
      minPrivateMiB: Math.min(...rows.map(r => r.privateBytes)) / 1024 ** 2,
      maxPrivateMiB: Math.max(...rows.map(r => r.privateBytes)) / 1024 ** 2,
      minWorkingSetMiB: Math.min(...rows.map(r => r.workingSet)) / 1024 ** 2,
      maxWorkingSetMiB: Math.max(...rows.map(r => r.workingSet)) / 1024 ** 2,
    };
  }
  results.push({ ...result, coldObservedMs: raw.cold, timings, byPreset, memory, diagnostics: raw.diagnostics });
}
const analysis = { ...matrix, results, percentileMethod: 'nearest rank, all 100 samples retained; timeouts/failures are not successful samples',
  memoryMethod: 'process tree private bytes and summed working set at discrete samples; not peak, idle and active can differ' };
await writeFile(path.join(directory, 'analysis.json'), JSON.stringify(analysis, null, 2));
for (const r of results) console.log(JSON.stringify({ variant: r.variant, passed: r.passed, switching: r.switching || r.partial?.switching, publication: r.publication,
  publicationStages: r.timings.publication, memory: r.memory, diagnostics: r.diagnostics }));
