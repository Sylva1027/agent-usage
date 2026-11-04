import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ROOT } from './runner.mjs';

const directory = path.resolve(process.argv[2] || 'output/architecture-20261102');
const baselines = JSON.parse(await readFile('output/architecture-20261101/baseline-hashes.json', 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const product = [];
for (const entry of baselines) {
  const actual = sha256(await readFile(entry.Path));
  product.push({ path: path.relative(process.cwd(), entry.Path), sha256: actual, unchanged: actual.toUpperCase() === entry.Hash });
}
assert.ok(product.every(entry => entry.unchanged), 'Product source changed');
const experiment = [];
async function inventory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['target', 'node_modules', '.git'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await inventory(file);
    else if (/\.(mjs|rs|toml|lock|md|html|json)$/.test(file)) experiment.push({ path: path.relative(ROOT, file), sha256: sha256(await readFile(file)) });
  }
}
await inventory(ROOT);
const binary = path.join(ROOT, 'native/target/release/architecture-prototype.exe');
const fixtureFile = path.resolve('output/architecture-20261101/real/fixture.json');
const fixtureHash = sha256(await readFile(fixtureFile));
const manifest = JSON.parse(await readFile('output/architecture-20261101/real/manifest.json', 'utf8'));
assert.equal(fixtureHash, manifest.sha256);
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', windowsHide: true }).trim();
const evidence = { recordedAt: new Date().toISOString(), gitHead: run('git', ['rev-parse', 'HEAD']), node: process.version,
  rust: run('rustc', ['--version']), cargo: run('cargo', ['--version']), platform: process.platform, arch: process.arch,
  osRelease: os.release(), cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, totalMemory: os.totalmem(),
  fixture: { sha256: fixtureHash, bytes: (await stat(fixtureFile)).size, eventCount: manifest.eventCount },
  nativeBinary: { sha256: sha256(await readFile(binary)), bytes: (await stat(binary)).size }, product, experiment };
await writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ productUnchanged: product.length, experiments: experiment.length, fixtureSha256: fixtureHash, cpu: evidence.cpu }));
