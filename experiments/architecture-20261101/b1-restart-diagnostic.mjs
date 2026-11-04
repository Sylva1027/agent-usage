import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const label = process.argv[2], matrix = process.argv[3];
for (const value of [label, matrix]) assert.match(value || '', /^[a-z0-9-]+$/i);
const directory = path.resolve('output/architecture-20261103/b1', label);
await mkdir(directory);
const manifest = JSON.parse(await readFile(path.resolve('output/architecture-20261103/growth-baseline', matrix, 'manifest.json'), 'utf8'));
const initial = manifest.runs.find(run => run.dataset === '10x' && run.implementation === 'b1' && run.verification?.passed);
assert.ok(initial, 'Need a completed 10x candidate');
const dataset = JSON.parse(await readFile('output/architecture-20261103/growth-baseline/10x/dataset.json', 'utf8'));
let seed = path.join(initial.output, 'state');
const runs = [];
for (let index = 1; index <= 2; index++) {
  const name = `${label}-${index}`;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('ARCH_')) delete env[key];
  Object.assign(env, { ARCH_STATE_SEED: seed, ARCH_STARTUP_HOME_DIR: dataset.root,
    ARCH_STARTUP_OPTIONS_FILE: path.join(dataset.directory, 'options.json'), ARCH_FIRST_ONLY: '1', ARCH_NO_TRACE: '1',
    ARCH_B1_PHASES: '1', ARCH_RESOURCE_SAMPLER: '1', ARCH_FATAL_REPORT: '1', ARCH_CAPTURE_STDERR: '1' });
  const child = spawn(process.execPath, ['experiments/architecture-20261101/full-startup-run.mjs', name], { env, windowsHide: true, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0);
  const output = path.resolve('output/architecture-20261102/full-startup', name);
  const result = JSON.parse(await readFile(path.join(output, 'result.json'), 'utf8'));
  assert.ok(!result.failure);
  assert.equal(result.metadata.eventCount, 1464120);
  const phases = [];
  for (const file of await readdir(output)) if (/^b1-phases-.*\.json$/.test(file)) phases.push(JSON.parse(await readFile(path.join(output, file), 'utf8')));
  const database = new DatabaseSync(path.join(output, 'state/usage-index.sqlite'), { readOnly: true });
  try {
    assert.equal(database.prepare('SELECT COUNT(*) value FROM events').get().value, 1464120);
    assert.equal(database.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  } finally { database.close(); }
  runs.push({ index, output, firstPaintMs: result.firstPaintMs, summaryCache: result.summaryCache, phases });
  seed = path.join(output, 'state');
}
await writeFile(path.join(directory, 'result.json'), JSON.stringify({ passed: true, note: 'Two process-cold unchanged-source diagnostics, not a p95 or OS-cold acceptance.', runs }, null, 2), { flag: 'wx' });
console.log(JSON.stringify(runs));
