import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { UsageStore } from '../../src/usage-store.js';

const directory = path.resolve(process.argv[2] || 'output/architecture-20261101/real');
await mkdir(directory, { recursive: true });
const sourcePath = process.argv[3] || path.join(os.homedir(), '.codex-usage', 'usage-index.sqlite');
const databaseFile = path.join(directory, `baseline-${Date.now()}.sqlite`);
const source = new DatabaseSync(sourcePath, { readOnly: true });
try { await backup(source, databaseFile); } finally { source.close(); }
const store = new UsageStore({ databaseFile, homeDir: directory, env: {} });
try {
  await store.open();
  const report = await store.publishedHistoryUsageReport();
  const duplicates = new Map();
  const events = report.events.map(event => {
    const digest = createHash('sha256').update(JSON.stringify(event)).digest('hex');
    const occurrence = duplicates.get(digest) || 0; duplicates.set(digest, occurrence + 1);
    return { ...event, eventId: digest + ':' + occurrence };
  });
  const fixture = { sourceId: 'real-frozen-history', events, cursor: { snapshot: path.basename(databaseFile) },
    context: { ...report, events: undefined, generatedAt: new Date().toISOString(), warnings: [] } };
  const target = path.join(directory, 'fixture.json');
  await writeFile(target, JSON.stringify(fixture));
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ sourcePath, databaseFile, target, eventCount: events.length, kinds: [...new Set(report.homes.map(home=>home.kind))], sha256: createHash('sha256').update(JSON.stringify(fixture)).digest('hex') }, null, 2));
  console.log(JSON.stringify({ target, eventCount: events.length, homeCount: report.homes.length, kinds: [...new Set(report.homes.map(home=>home.kind))] }));
} finally { store.close(); }
