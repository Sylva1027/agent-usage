import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const base = path.resolve('output/architecture-20261103/growth-baseline');
const oldBase = path.resolve('output/architecture-20261102/full-startup');
const label = process.argv[2];
assert.match(label || '', /^[a-z0-9-]+$/i, 'Provide a new run label');
const selection = process.argv[3] || 'all';
assert.ok(['all', 'b1-paired', 'tiny', 'real', '1x', '5x', '10x'].includes(selection));
const directory = path.join(base, label); await mkdir(directory);
const schedule = selection === 'b1-paired'
  ? ['1x-before', '1x', '5x', '10x', '10x', '1x-before', '1x', '5x', '5x', '10x', '1x-before', '1x']
  : selection === 'all' ? ['1x', '5x', '10x', '10x', '1x', '5x', '5x', '10x', '1x'] : [selection];
const hashes = {};
for (const file of ['src/dsh-usage.js', 'src/usage-store.js', 'src/usage-record-store.js', 'src/usage-quota-store.js', 'src/usage-quota-source-store.js', 'src/usage-session-members.js', 'src/usage-rollups.js', 'public/timeline-utils.js', ...['growth-line-inputs.mjs', 'growth-sqlite-inputs.mjs', 'growth-run.mjs', 'growth-analyze.mjs', 'growth-resource-sampler.ps1', 'full-startup-run.mjs', 'startup-options.mjs', 'startup-trace.mjs', 'startup-state-overlay.mjs', 'startup-telemetry.mjs'].map(f => `experiments/architecture-20261101/${f}`)]) {
  hashes[file] = createHash('sha256').update(await readFile(file)).digest('hex');
}
const manifest = { label, createdAt: new Date().toISOString(), hashes, schedule, processCold: true, osCacheFlushed: false,
  sourceFilesystemReplay: false, gatewayOldSpaceMiB: 512, executorOldSpaceMiB: 224,
  implementation: process.env.ARCH_B1_BASELINE === '1' ? 'before-b1' : 'b1',
  baselineHashes: process.env.ARCH_B1_BASELINE === '1' || selection === 'b1-paired' ? JSON.parse(await readFile('output/architecture-20261103/b1/before-hashes.json', 'utf8')) : null, runs: [] };
const save = () => writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
await save();
function verify(file, dataset) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const facts = db.prepare(`SELECT s.kind,COUNT(e.id) events,SUM(e.total) total,SUM(e.input) input,
      SUM(e.cached) cached,SUM(e.output) output,SUM(e.reasoning) reasoning FROM source_files s
      LEFT JOIN events e ON e.source_path=s.path GROUP BY s.kind`).all()
      .map(r => ({ ...r, kind: ['main', 'extra', 'jetbrains'].includes(r.kind) ? 'codex' : r.kind })).sort((a,b) => a.kind.localeCompare(b.kind));
    assert.deepEqual(facts, dataset.expected.toSorted((a,b) => a.kind.localeCompare(b.kind)));
    const counts = db.prepare(`SELECT (SELECT COUNT(*) FROM source_files) files,
      (SELECT COUNT(DISTINCT home_id) FROM source_files) homes,
      (SELECT COUNT(*) FROM rate_limit_observations) quota,
      (SELECT COUNT(*) FROM archive_segments) coldSegments,
      (SELECT COUNT(*) FROM (SELECT DISTINCT home_id,session_id FROM events)) sessions,
      (SELECT MIN(timestamp_ms) FROM events) minTime,(SELECT MAX(timestamp_ms) FROM events) maxTime`).get();
    assert.equal(counts.files, dataset.expectedFiles); assert.equal(counts.homes, dataset.expectedHomes);
    assert.equal(counts.quota, dataset.expectedQuota); assert.equal(counts.coldSegments, 0);
    if (dataset.synthetic) {
      assert.equal(counts.minTime, Date.parse('2026-08-01T00:00:00Z'));
      assert.equal(counts.maxTime, Date.parse('2026-10-30T00:00:00Z'));
    }
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    return { passed: true, facts, counts };
  } finally { db.close(); }
}
for (const [index, scheduledName] of schedule.entries()) {
  const datasetName = scheduledName.replace(/-before$/, '');
  const baseline = scheduledName.endsWith('-before') || process.env.ARCH_B1_BASELINE === '1';
  const dataset = JSON.parse(await readFile(path.join(base, datasetName, 'dataset.json'), 'utf8'));
  const name = `growth-${label}-${index + 1}-${scheduledName}`;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('ARCH_') && !['ARCH_PLAYWRIGHT_MODULE', 'ARCH_CHROMIUM', 'ARCH_B1_BASELINE', 'ARCH_B1_PHASES'].includes(key)) delete env[key];
  if (baseline) env.ARCH_B1_BASELINE = '1'; else delete env.ARCH_B1_BASELINE;
  Object.assign(env, { ARCH_STATE_SEED: dataset.seed, ARCH_STARTUP_HOME_DIR: dataset.root,
    ARCH_STARTUP_OPTIONS_FILE: path.join(dataset.directory, 'options.json'), ARCH_FIRST_ONLY: '1',
    ARCH_NO_TRACE: '1', ARCH_RESOURCE_SAMPLER: '1', ARCH_FATAL_REPORT: '1', ARCH_CAPTURE_STDERR: '1', ARCH_STARTUP_TIMEOUT_MS: '900000' });
  console.log(JSON.stringify({ stage: 'start', name, dataset: datasetName }));
  const started = Date.now();
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['experiments/architecture-20261101/full-startup-run.mjs', name], { env, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', resolve);
  });
  const entry = { name, dataset: datasetName, implementation: baseline ? 'before-b1' : 'b1', exitCode, wallMs: Date.now() - started, output: path.join(oldBase, name) };
  try {
    entry.result = JSON.parse(await readFile(path.join(entry.output, 'result.json'), 'utf8'));
    if (!entry.result.failure && exitCode === 0) {
      entry.verification = verify(path.join(entry.output, 'state/usage-index.sqlite'), dataset);
      assert.equal(entry.result.metadata.eventCount, dataset.expected.reduce((n,f) => n + f.events, 0));
      assert.equal(entry.result.metadata.homeCount, dataset.expectedHomes);
      assert.deepEqual(entry.result.errors, []);
      assert.equal(entry.result.samplerExitCode, 0);
      assert.equal(entry.result.resourceSummary?.failure, null);
      const first = JSON.parse(await readFile(path.join(entry.output, 'first-response.json'), 'utf8'));
      // All fixed inputs end before today's date; the initialized zero title is explicitly checked by the browser runner.
      if (dataset.synthetic) assert.equal(first.summary.totals.total, 0);
    }
  } catch (error) { entry.verificationFailure = error.stack; if (entry.verification) entry.verification.passed = false; }
  const stateFiles = [];
  try { for (const file of await readdir(path.join(entry.output, 'state'))) stateFiles.push({ file, bytes: (await stat(path.join(entry.output, 'state', file))).size }); } catch {}
  entry.stateFiles = stateFiles;
  manifest.runs.push(entry); await save();
  console.log(JSON.stringify({ stage: 'finished', name, exitCode, firstPaintMs: entry.result?.firstPaintMs, valid: entry.verification?.passed || false, failure: entry.verificationFailure || entry.result?.failure }));
}
// Hash outside timed rebuilds, once after all runs, to detect source mutation without doubling each run's I/O.
manifest.inputIntegrity = [];
for (const datasetName of new Set(schedule.map(name => name.replace(/-before$/, '')))) {
  console.log(JSON.stringify({ stage: 'input-integrity', dataset: datasetName }));
  const dataset = JSON.parse(await readFile(path.join(base, datasetName, 'dataset.json'), 'utf8'));
  let mismatches = 0;
  for (const file of dataset.inputs) {
    const hash = createHash('sha256'); for await (const bytes of createReadStream(file.path)) hash.update(bytes);
    if (hash.digest('hex') !== file.sha256) mismatches += 1;
  }
  manifest.inputIntegrity.push({ dataset: datasetName, checked: dataset.inputs.length, mismatches });
  console.log(JSON.stringify({ stage: 'input-integrity-complete', dataset: datasetName, mismatches }));
}
manifest.finishedAt = new Date().toISOString(); await save();
if (manifest.runs.some(r => r.exitCode || !r.verification?.passed) || manifest.inputIntegrity.some(r => r.mismatches)) process.exitCode = 1;
