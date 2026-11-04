import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageStore } from '../../src/usage-store.js';
import { UsageSourceProof } from '../../src/usage-source-proof.js';

class ShaProof extends UsageSourceProof { async provider() { return null; } }
const [label, mode, target] = process.argv.slice(2);
const options = root => ({ homeDir: root, databaseFile: path.join(root, 'state.sqlite'), env: {}, importDirs: [] });
function makeStore(root) {
  const store = new UsageStore(options(root));
  store.sourceProof = new ShaProof();
  return store;
}
const lines = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
const meta = { type: 'session_meta', timestamp: '2026-11-03T01:00:00Z', payload: {
  id: 'recovery-session', cwd: '', source: 'cli', originator: 'codex-tui', model_provider: 'openai',
} };
const context = { type: 'turn_context', payload: { model: 'gpt-6-sol' } };
const token = (total, minute) => ({ type: 'event_msg', timestamp: `2026-11-03T01:0${minute}:00Z`, payload: {
  type: 'token_count', info: { total_token_usage: { total_tokens: total, input_tokens: total,
    cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } },
} });
const park = async phase => {
  process.send({ phase });
  await new Promise(() => { setInterval(() => {}, 1000); });
};
if (mode === 'child') {
  const store = makeStore(label);
  await store.open();
  if (target === 'before-commit') {
    const capture = store.sourceProof.capture.bind(store.sourceProof);
    store.sourceProof.capture = async (...args) => { const result = await capture(...args); await park(target); return result; };
  } else {
    const method = target === 'after-commit' ? 'appendFile' : 'replaceFile';
    const original = store[method].bind(store);
    store[method] = async (...args) => { const result = await original(...args); if (result?.committed) await park(target); return result; };
  }
  await store.sync();
  throw new Error('Crash hook was not reached');
}
assert.match(label || '', /^[a-z0-9-]+$/i);
const directory = path.resolve('output/architecture-20261103/b2', label);
await mkdir(directory);
const results = [];
for (const scenario of ['before-commit', 'after-commit', 'dependency-commit']) {
  const root = path.join(directory, scenario);
  const sessions = path.join(root, '.codex/sessions');
  await mkdir(sessions, { recursive: true });
  const producer = path.join(sessions, 'z-producer.jsonl');
  const consumer = path.join(sessions, 'a-consumer.jsonl');
  await writeFile(producer, lines([meta, context, token(100, 1)]));
  if (scenario === 'dependency-commit') await writeFile(consumer, lines([meta, context, token(150, 2)]));
  let store = makeStore(root);
  await store.sync();
  const before = store.database.prepare('SELECT checkpoint_json FROM usage_source_progress WHERE source_path=?').get(producer);
  assert.ok(before);
  store.close();
  if (scenario === 'dependency-commit') await writeFile(producer, lines([meta, context, token(120, 1)]));
  else await appendFile(producer, lines([token(160, 3)]));
  const child = fork(fileURLToPath(import.meta.url), [root, 'child', scenario], {
    execArgv: ['--max-old-space-size=224', '--max-semi-space-size=4'], windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Crash hook timed out: ${stderr}`)), 15000);
      child.once('message', message => { clearTimeout(timer); assert.equal(message.phase, scenario); resolve(); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Premature exit ${code}: ${stderr}`)); });
    });
  } finally { child.kill('SIGKILL'); }
  const termination = await exited;
  store = makeStore(root);
  try {
    await store.open();
    const committedTotal = Number(store.database.prepare('SELECT SUM(total) total FROM events').get().total);
    assert.equal(committedTotal, scenario === 'before-commit' ? 100 : scenario === 'after-commit' ? 160 : 170);
    const pendingBefore = Number(store.database.prepare('SELECT COUNT(*) n FROM usage_source_reparse').get().n);
    if (scenario === 'dependency-commit') assert.ok(pendingBefore > 0);
    if (scenario === 'before-commit') assert.deepEqual(
      store.database.prepare('SELECT checkpoint_json FROM usage_source_progress WHERE source_path=?').get(producer), before);
    await store.sync();
    const total = Number(store.database.prepare('SELECT SUM(total) total FROM events').get().total);
    assert.equal(total, scenario === 'dependency-commit' ? 150 : 160);
    assert.equal(store.database.prepare('SELECT COUNT(*) n FROM usage_source_reparse').get().n, 0);
    const recovered = store.database.prepare('SELECT checkpoint_json FROM usage_source_progress WHERE source_path=?').get(producer);
    assert.equal(JSON.parse(recovered.checkpoint_json).offset, (await stat(producer)).size);
    await store.sync();
    assert.equal(Number(store.database.prepare('SELECT SUM(total) total FROM events').get().total), total);
    assert.equal(store.database.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    results.push({ scenario, termination, committedTotal, recoveredTotal: total, pendingBefore, passed: true });
  } finally { store.close(); }
}
await writeFile(path.join(directory, 'result.json'), JSON.stringify({ passed: true, results }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ passed: true, results }));
