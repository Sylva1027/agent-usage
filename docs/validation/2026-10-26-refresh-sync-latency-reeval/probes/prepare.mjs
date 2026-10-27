import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { discoverUsageSources } from '../../src/usage-core.js';
import { UsageStore } from '../../src/usage-store.js';
import { workbuddyTraceFiles } from '../../src/workbuddy-usage.js';

const root = process.cwd();
const home = os.homedir();
const privateRoot = path.join(root, '.codex-usage', 'refresh-latency-20261026');
const evidence = path.join(root, 'output', 'refresh-sync-latency-reeval-20261026');
await fsp.mkdir(privateRoot, { recursive: true });
const importsFile = path.join(home, '.codex-usage', 'imports.json');
const rawImports = fs.existsSync(importsFile) ? JSON.parse(await fsp.readFile(importsFile, 'utf8')) : [];
const importDirs = (Array.isArray(rawImports) ? rawImports : rawImports.imports || []).map(entry => typeof entry === 'string' ? entry : entry.path);
const options = { homeDir: home, importDirs };
const homes = await discoverUsageSources(options);
const temporaryStore = new UsageStore({ ...options, databaseFile: path.join(privateRoot, 'never-opened.sqlite') });
const discovered = await temporaryStore.usageFiles(homes);
if (discovered.failedHomes.length) throw new Error('Source discovery incomplete');
const mappings = [{ original: home, copy: path.join(privateRoot, 'home') }];
for (const [index, source] of homes.entries()) {
  if (!source.path.toLowerCase().startsWith(home.toLowerCase() + path.sep)) mappings.push({ original: source.path, copy: path.join(privateRoot, 'foreign', String(index)) });
}
mappings.sort((a, b) => b.original.length - a.original.length);
const mapped = file => {
  const absolute = path.resolve(file);
  const entry = mappings.find(item => absolute.toLowerCase() === item.original.toLowerCase() || absolute.toLowerCase().startsWith(item.original.toLowerCase() + path.sep));
  if (!entry) throw new Error('Unmapped source path');
  return path.join(entry.copy, path.relative(entry.original, absolute));
};
const files = new Set(discovered.files.map(file => file.filePath));
for (const source of homes) {
  if (source.kind === 'workbuddy') for (const file of await workbuddyTraceFiles(source.path)) files.add(file);
  for (const name of ['config.toml', 'settings.json', 'config.json']) {
    const file = path.join(source.path, name);
    if (fs.existsSync(file)) files.add(file);
  }
}
for (const name of ['imports.json', 'pricing.json', 'pricing-auto.json']) {
  const file = path.join(home, '.codex-usage', name);
  if (fs.existsSync(file)) files.add(file);
}
const ledger = path.join(home, '.config', 'magpie', 'usage.jsonl');
if (fs.existsSync(ledger)) files.add(ledger);
const kinds = {};
for (const file of discovered.files) {
  const row = kinds[file.source.kind] ||= { files: 0, bytes: 0 };
  row.files++;
  row.bytes += fs.statSync(file.filePath).size;
}
const inventory = { createdAt: new Date().toISOString(), home, root, privateRoot, mappings, options, homes, files: [...files], sourceFiles: discovered.files.map(file => ({ filePath: file.filePath, kind: file.source.kind })), kinds, freeGiB: os.freemem() / 2 ** 30 };
await fsp.writeFile(path.join(privateRoot, 'inventory.json'), JSON.stringify(inventory, null, 2));
console.log(JSON.stringify({ stage: 'inventory', homes: homes.length, files: files.size, kinds, freeGiB: inventory.freeGiB }));
if (!process.argv.includes('--freeze')) process.exit(0);
if (os.freemem() < 8 * 2 ** 30) throw new Error('Less than 8 GiB system available');
const copyStarted = performance.now();
let totalBytes = 0;
const copied = [];
for (const file of files) {
  const destination = mapped(file);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const alreadyFrozen = fs.existsSync(destination);
  const before = fs.statSync(alreadyFrozen ? destination : file);
  if (alreadyFrozen) {
    if (!before.isFile()) throw new Error('Invalid previous snapshot');
  } else if (/\.(sqlite|db)$/i.test(file)) {
    const reader = new DatabaseSync(file, { readOnly: true });
    try { await backup(reader, destination); } finally { reader.close(); }
  } else {
    // Freeze a bounded prefix: appends after the initial size belong to the live group.
    const input = fs.openSync(file, 'r');
    const output = fs.openSync(destination, 'wx');
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let offset = 0;
      while (offset < before.size) {
        const read = fs.readSync(input, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
        if (!read) throw new Error('Source truncated during freeze');
        fs.writeSync(output, buffer, 0, read);
        offset += read;
      }
    } finally { fs.closeSync(input); fs.closeSync(output); }
  }
  await fsp.utimes(destination, before.atime, before.mtime);
  const bytes = fs.statSync(destination).size;
  totalBytes += bytes;
  copied.push({ file, bytes, mtimeMs: before.mtimeMs });
}
const originalDatabase = path.join(home, '.codex-usage', 'usage-index.sqlite');
const database = path.join(privateRoot, 'seed.sqlite');
const reader = new DatabaseSync(originalDatabase, { readOnly: true });
try { await backup(reader, database); } finally { reader.close(); }
const inspection = new DatabaseSync(database);
inspection.exec('PRAGMA journal_mode=DELETE');
const tables = Object.fromEntries(['events', 'source_files', 'perf_samples', 'perf_codex_projections', 'perf_rollout_threads', 'archive_segments'].map(table => [table, Number(inspection.prepare('SELECT count(*) AS n FROM ' + table).get().n)]));
const schema = inspection.prepare('PRAGMA user_version').get();
inspection.close();
const hash = async file => {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
};
const sourceHashes = {};
for (const directory of ['src', 'public']) {
  for (const entry of fs.readdirSync(path.join(root, directory), { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && /\.(js|json|css|html)$/.test(entry.name)) {
      const file = path.join(entry.parentPath, entry.name);
      sourceHashes[path.relative(root, file).replaceAll('\\', '/')] = await hash(file);
    }
  }
}
await fsp.writeFile(path.join(privateRoot, 'freeze.json'), JSON.stringify({ ...inventory, copied, database, tables, schema, sourceHashes, elapsedMs: performance.now() - copyStarted }, null, 2));
await fsp.writeFile(path.join(evidence, 'baseline.json'), JSON.stringify({ capturedAt: new Date().toISOString(), sourceBytes: totalBytes, databaseBytes: fs.statSync(database).size, tables, schema, kinds, sourceHashes, freezeMs: performance.now() - copyStarted, rss: process.memoryUsage().rss, freeGiB: os.freemem() / 2 ** 30 }, null, 2));
console.log(JSON.stringify({ stage: 'frozen', sourceBytes: totalBytes, tables, schema, elapsedMs: performance.now() - copyStarted, rss: process.memoryUsage().rss }));
