import assert from 'node:assert/strict';
import { mkdir, mkdtemp, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { UsageStore } from '../../src/usage-store.js';

const root = path.resolve('output/architecture-20261102/upstream-review');
const { UsageStore: OriginalStore } = await import(pathToFileURL(path.join(root, 'source/src/usage-store.js')));
const fixture = await mkdtemp(path.join(root, 'semantic-check-'));
const sessions = path.join(fixture, '.codex/sessions/2026/07/12');
await mkdir(sessions, { recursive: true });
const usage = total => ({ total_tokens: total, input_tokens: total - 20, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0 });
const files = ['a', 'b'].map(name => path.join(sessions, `${name}.jsonl`));
for (const [index, file] of files.entries()) {
  const rows = [
    { type: 'session_meta', payload: { id: 'comparison-shared-session', source: 'cli', originator: 'codex-tui', cwd: fixture } },
    { type: 'turn_context', payload: { model: 'gpt-6-sol' } },
    { type: 'event_msg', timestamp: `2026-07-12T0${index + 1}:00:00Z`, payload: { type: 'token_count', info: {
      total_token_usage: usage(index ? 160 : 100),
      last_token_usage: index ? { ...usage(60), input_tokens: 60, output_tokens: 0 } : usage(100),
    } } },
  ];
  await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}
const versions = [ ['upstream', OriginalStore], ['current', UsageStore] ];
const stores = versions.map(([name, Store]) => [name, new Store({ homeDir: fixture, env: {}, databaseFile: path.join(fixture, `${name}.sqlite`) })]);
const result = { fixture: 'two files, same session; cumulative 100 then 160, second request 60', beforeRemoval: {}, afterRemoval: {} };
const totals = store => ({ ...store.database.prepare('SELECT COUNT(*) events,COALESCE(SUM(total),0) total FROM events').get() });
try {
  for (const [name, store] of stores) { await store.sync(); result.beforeRemoval[name] = totals(store); }
  assert.equal(result.beforeRemoval.upstream.total, 260);
  assert.equal(result.beforeRemoval.current.total, 160);
  for (const file of files) await unlink(file);
  for (const [name, store] of stores) { await store.sync(); result.afterRemoval[name] = totals(store); }
  assert.equal(result.afterRemoval.upstream.total, 0);
  assert.equal(result.afterRemoval.current.total, 160);
  result.pass = true;
  await writeFile(path.join(root, 'semantic-check.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  for (const [, store] of stores) store.close();
}
