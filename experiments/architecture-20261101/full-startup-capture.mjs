import { inventoryStartupInputs, captureStartupInputs } from './startup-inputs.mjs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const output = path.resolve('output/architecture-20261102/full-startup');
const rows = [];
for (const name of await readdir(path.join(output, 'audit'))) {
  for (const line of (await readFile(path.join(output, 'audit', name), 'utf8')).trim().split('\n')) if (line) rows.push(JSON.parse(line));
}
const insideHome = value => value.toLowerCase().startsWith(os.homedir().toLowerCase() + path.sep) && !value.toLowerCase().startsWith(path.join(os.homedir(), '.codex-usage').toLowerCase() + path.sep);
const paths = [...new Set(rows.filter(row => row.status === 'ok' && insideHome(row.path)).map(row => row.path))];
const extraFiles = [], directoryStats = {}, directories = [];
for (const file of paths) {
  const info = await stat(file).catch(() => null); if (!info) continue;
  if (info.isFile() && !/-wal$|-shm$/.test(file)) extraFiles.push(file);
  if (info.isDirectory()) {
    directoryStats[file] = { size: info.size, mtimeMs: info.mtimeMs, atimeMs: info.atimeMs, ctimeMs: info.ctimeMs, birthtimeMs: info.birthtimeMs };
    if (rows.some(row => row.path === file && row.status === 'ok' && row.operation.includes('readdir'))) {
      const entries = await readdir(file, { withFileTypes: true });
      directories.push({ logicalPath: file, entries: entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : e.isSymbolicLink() ? 'symlink' : 'other' })) });
    }
  }
}
const inventory = await inventoryStartupInputs({ outputDirectory: output });
console.log(JSON.stringify({ stage: 'inventory', summary: inventory.summary, auxiliaryFiles: extraFiles.length, directories: directories.length }));
const capture = await captureStartupInputs(inventory.manifest, { outputDirectory: output, extraFiles });
capture.manifest.directoryListings.after.push({ sourceId: 'audited-directories', homePath: os.homedir(), directories, failures: [] });
capture.manifest.directoryStats = directoryStats;
capture.manifest.missingPaths = [...new Set(rows.filter(r => r.status === 'error' && r.errorCode === 'ENOENT' && insideHome(r.path)).map(r => r.path))];
await writeFile(capture.manifestFile, JSON.stringify(capture.manifest, null, 2));
await writeFile(path.join(output, 'capture-pointer.json'), JSON.stringify({ file: capture.manifestFile, summary: capture.summary }, null, 2));
console.log(JSON.stringify({ stage: 'captured', file: capture.manifestFile, summary: capture.summary }));
