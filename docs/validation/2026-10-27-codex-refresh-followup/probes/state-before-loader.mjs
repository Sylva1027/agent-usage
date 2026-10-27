import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
const before = path.join(root, 'output/codex-refresh-followup-20261027/preimage');
registerHooks({ load(url, context, next) {
  if (!url.startsWith('file:')) return next(url, context);
  const relative = path.relative(root, fileURLToPath(url));
  if (!relative.startsWith('src' + path.sep)) return next(url, context);
  const source = fs.readFileSync(path.join(before, relative));
  if (relative === path.join('src', 'usage-store.js')) {
    assert.equal(createHash('sha256').update(source).digest('hex'), '5a67983eed03d3224ba337980990d7392e64c7b1e154b5c14481fc0e3bbf1504');
  }
  return { format: 'module', source, shortCircuit: true };
} });
