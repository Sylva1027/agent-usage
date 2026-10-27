import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = path.resolve('output/codex-refresh-followup-20261027/evidence');
const results = [];
for (const [name, args] of [
  ['lint-post', ['check', '--formatter-enabled=false', '.']],
  ['format-check-post', ['format', '.']],
]) {
  const fd = fs.openSync(path.join(directory, `${name}.txt`), 'wx');
  const start = performance.now();
  let result;
  try {
    result = spawnSync(process.execPath, ['--max-old-space-size=512', 'node_modules/@biomejs/biome/bin/biome', ...args],
      { stdio: ['ignore', fd, fd], timeout: 120_000 });
  } finally { fs.closeSync(fd); }
  results.push({ name, status: result.status, signal: result.signal, error: result.error?.message, ms: performance.now() - start });
}
fs.writeFileSync(path.join(directory, 'gates-post.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
assert.ok(results.every(result => result.status === 0));
