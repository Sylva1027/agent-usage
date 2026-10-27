import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve('output/codex-refresh-followup-20261027/evidence');
const files = [...fs.globSync('test/**/*.test.js')].map(file => file.replaceAll('\\', '/')).sort();
const boundary = files.indexOf('test/ui-geometry.test.js');
assert.ok(boundary > 0, 'timeout boundary must exist in the same ordered full-suite manifest');
const tail = ['test/perf-store.test.js', ...files.slice(boundary)];
const result = { allFiles: files, completedPrefix: files.slice(0, boundary), recheckedAfterContractCorrection: 'test/perf-store.test.js',
  resumedFiles: tail, hashes: Object.fromEntries(tail.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')])),
  firstRun: { status: 'timed-out', timeoutMs: 900000, log: 'full-test.txt' },
  coverage: 'initial serial run completed files before ui-geometry; rerun starts inclusively at that file' };
const fd = fs.openSync(path.join(root, 'full-test-tail.txt'), 'wx');
const start = performance.now();
let run;
try { run = spawnSync(process.execPath, ['--max-old-space-size=1536', '--test', '--test-concurrency=1', ...tail],
  { stdio: ['ignore', fd, fd], timeout: 900000 }); }
finally { fs.closeSync(fd); }
Object.assign(result, { status: run.status, signal: run.signal, error: run.error?.message, ms: performance.now() - start });
fs.writeFileSync(path.join(root, 'gates-tail.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ status: run.status, prefixFiles: boundary, resumedFiles: tail.length, totalFiles: files.length, ms: result.ms }));
assert.equal(run.status, 0, 'tail/contract recheck must pass; retain failure logs');
