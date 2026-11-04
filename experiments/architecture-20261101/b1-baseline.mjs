import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const files = new Map(['src/usage-store.js', 'src/usage-rollups.js', 'public/timeline-utils.js'].map(file => [
  new URL(`../../${file}`, import.meta.url).href,
  new URL(`../../output/architecture-20261103/b1/${file.split('/').at(-1)}.before`, import.meta.url),
]));
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (!files.has(url)) return loaded;
  const source = readFileSync(files.get(url), 'utf8');
  assert.ok(source.length > 1000, 'Missing saved B1 baseline');
  return { ...loaded, source };
} });
