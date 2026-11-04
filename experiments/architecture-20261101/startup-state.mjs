import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, readFile, copyFile, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function copyStartupState(outputDirectory, sourceRoot = path.join(os.homedir(), '.codex-usage')) {
  const physicalRoot = path.resolve(outputDirectory); await mkdir(physicalRoot, { recursive: true });
  const files = [];
  for (const name of ['usage-index.sqlite', 'usage-index.sqlite.summaries.sqlite', 'pricing.json', 'pricing-auto.json', 'imports.json', 'codex-quota.json']) {
    const source = path.join(sourceRoot, name), destination = path.join(physicalRoot, name);
    let info;
    try { info = await stat(source); } catch (error) { if (error.code === 'ENOENT') { files.push({ name, missing: true }); continue; } throw error; }
    if (name.endsWith('.sqlite')) {
      const db = new DatabaseSync(source, { readOnly: true }); try { await backup(db, destination); } finally { db.close(); }
    } else await copyFile(source, destination);
    await utimes(destination, info.atime, info.mtime);
    files.push({ name, bytes: info.size, mtimeMs: info.mtimeMs });
  }
  const result = { logicalRoot: path.resolve(sourceRoot), physicalRoot, capturedAt: new Date().toISOString(), files };
  await writeFile(path.join(physicalRoot, 'state-manifest.json'), JSON.stringify(result, null, 2));
  return result;
}

export async function privateStateOptions(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'state-manifest.json'), 'utf8'));
  return { logicalRoot: manifest.logicalRoot, physicalRoot: path.resolve(directory) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await copyStartupState(process.argv[2] || 'output/architecture-20261102/full-startup/seed')));
}
