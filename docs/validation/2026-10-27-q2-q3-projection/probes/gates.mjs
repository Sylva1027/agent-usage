import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve('output/q2-q3-projection-20261027/evidence');
const checks = [
  ['typecheck', ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.checkjs.json']],
  ['lint', ['node_modules/@biomejs/biome/bin/biome', 'check', '--formatter-enabled=false', '.']],
  ['format-check', ['node_modules/@biomejs/biome/bin/biome', 'format', '.']],
  ['full-test', ['--test', '--test-concurrency=1', 'test/**/*.test.js']],
];
const results = [];
for (const [name, args] of checks) {
  const log = path.join(root, `${name}.txt`), fd = fs.openSync(log, 'wx');
  const start = performance.now();
  let result;
  try { result = spawnSync(process.execPath, ['--max-old-space-size=1536', ...args], { stdio: ['ignore', fd, fd], timeout: 1_800_000 }); }
  finally { fs.closeSync(fd); }
  const row = { name, args, status: result.status, signal: result.signal, error: result.error?.message, ms: performance.now() - start };
  results.push(row);
  fs.writeFileSync(path.join(root, 'gates.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(row));
}
assert.ok(results.every(row => row.status === 0), 'retain first failing gate logs and diagnose before retrying');

