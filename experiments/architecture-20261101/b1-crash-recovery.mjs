import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { buildStoredRecordChampions, readStoredRecordChampions } from '../../src/usage-record-store.js';

const label = process.argv[2];
assert.match(label || '', /^[a-z0-9-]+$/i);
const directory = path.resolve('output/architecture-20261103/b1', label);
const crashedFile = path.join(directory, 'crashed.sqlite');
const marker = path.join(directory, 'committed.json');
function options(database) {
  return { database, key: 'b1-real-kill|utc', factsKey: 'fixed-facts', zone: 'utc',
    estimateRow: row => ({ totalUsd: Number(row.total) / 1e6, inputUsd: Number(row.input) / 1e6,
      cachedInputUsd: Number(row.cached) / 1e6, outputUsd: Number(row.output) / 1e6 }) };
}

if (process.argv[3] === 'child') {
  const database = new DatabaseSync(crashedFile);
  database.exec('PRAGMA journal_mode=WAL');
  buildStoredRecordChampions({ ...options(database), batchSize: 1024, afterBatch(batch) {
    writeFileSync(marker, JSON.stringify(batch));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  } });
  throw new Error('Child should have been terminated at its first committed batch');
} else {
  await mkdir(directory);
  const source = new DatabaseSync(path.resolve('output/architecture-20261102/full-startup/growth-standard-light-1-1x/state/usage-index.sqlite'), { readOnly: true });
  const facts = database => database.prepare(`SELECT COUNT(*) count, SUM(total) total, SUM(input) input,
    SUM(cached) cached, SUM(output) output, SUM(reasoning) reasoning FROM events`).get();
  let initial;
  try {
    initial = facts(source);
    await backup(source, crashedFile);
    await backup(source, path.join(directory, 'clean.sqlite'));
  } finally { source.close(); }
  const child = spawn(process.execPath, ['--max-old-space-size=224', '--max-semi-space-size=4', process.argv[1], label, 'child'],
    { env: { ...process.env, NODE_OPTIONS: '' }, windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'] });
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  let timer;
  await Promise.race([new Promise((resolve, reject) => {
    let polls = 0;
    timer = setInterval(() => {
      if (existsSync(marker)) { clearInterval(timer); resolve(); }
      else if (++polls >= 600) { clearInterval(timer); reject(new Error('No checkpoint within 60 seconds')); }
    }, 100);
  }), exit.then(result => { throw new Error(`Child exited before checkpoint: ${JSON.stringify(result)}`); })]).catch(error => {
    clearInterval(timer); child.kill(); throw error;
  });
  assert.equal(child.kill(), true);
  const killed = await exit;
  const crashed = new DatabaseSync(crashedFile);
  const clean = new DatabaseSync(path.join(directory, 'clean.sqlite'));
  let evidence;
  try {
    assert.deepEqual(facts(crashed), initial);
    assert.equal(readStoredRecordChampions(options(crashed)), null, 'Partial work cannot be published');
    const committed = JSON.parse(await readFile(marker, 'utf8'));
    let firstResumed = null;
    const resumed = buildStoredRecordChampions({ ...options(crashed), afterBatch: batch => { firstResumed ??= batch; } });
    assert.ok(firstResumed.lastEventId > committed.lastEventId);
    const expected = buildStoredRecordChampions(options(clean));
    assert.deepEqual(resumed, expected);
    assert.deepEqual(facts(crashed), initial);
    assert.equal(crashed.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    evidence = { passed: true, killed, committed, firstResumed, facts: initial,
      partialUnpublished: true, resumedEqualsClean: true, integrity: 'ok' };
  } finally { crashed.close(); clean.close(); }
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(evidence, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(evidence));
}
