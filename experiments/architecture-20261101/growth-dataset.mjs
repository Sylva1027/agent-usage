import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generateLineInputs } from './growth-line-inputs.mjs';
import { generateSqliteInputs } from './growth-sqlite-inputs.mjs';

const base = path.resolve('output/architecture-20261103/growth-baseline');
const oldBase = path.resolve('output/architecture-20261102/full-startup');
const profile = JSON.parse(await readFile(path.join(base, 'profile.json'), 'utf8'));
const capture = JSON.parse(await readFile(profile.captureFile, 'utf8'));
const family = kind => ['main', 'extra', 'jetbrains', 'codex'].includes(kind) ? 'codex' : kind;
const homes = { codex: '.codex', dsh: '.dsh', claude: '.claude', workbuddy: '.workbuddy-ai', zcode: '.zcode', opencode: '.opencode' };
const mode = process.argv[2];
assert.ok(['real', '1', '5', '10', 'tiny'].includes(mode), 'Choose real, 1, 5, 10, or tiny');
const scale = mode === 'tiny' || mode === 'real' ? 1 : Number(mode);
const directory = path.join(base, mode === 'real' || mode === 'tiny' ? mode : `${scale}x`);
const resumeLines = process.argv.includes('--resume-lines');
if (resumeLines) assert.equal(mode, '10', 'Resume is only for the recorded 10x preparation failure');
if (!resumeLines) await mkdir(directory);
const root = path.join(directory, 'home'); await mkdir(root, { recursive: resumeLines });
let files = profile.files.map(f => ({ ...f, frames: f.compressed && f.kind !== 'dsh' ? 1 : f.frames }));
if (mode === 'tiny') {
  files = Object.keys(homes).flatMap(kind => files.filter(f => f.kind === kind).slice(0, kind === 'codex' ? 2 : 1))
    .map(f => ({ ...f, events: 4, rows: 15, quotaObservations: f.kind === 'codex' ? 3 : 0,
      decodedBytes: 15000, sourceBytes: f.kind === 'zcode' || f.kind === 'opencode' ? 1024 * 1024 : 8000,
      sessions: 2, frames: f.compressed ? 2 : 0 }));
}
const copied = [];
function relocated(file) {
  const kind = family(file.sourceKind);
  assert.ok(homes[kind], `Unknown source family: ${kind}`);
  const relative = path.relative(file.sourceHomePath, file.logicalPath);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Captured file outside source home');
  return path.join(root, homes[kind], relative);
}
async function copyCaptured(file) {
  const target = relocated(file);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.resolve(capture.captureDirectory, file.capturedPath), target, { preserveTimestamps: true });
  // Only fixture copies are normalized; source readers must not create WAL sidecars during repeated runs.
  if (file.storageType === 'sqlite') {
    const db = new DatabaseSync(target); try { db.exec('PRAGMA journal_mode=DELETE'); } finally { db.close(); }
  }
  copied.push({ kind: family(file.sourceKind), role: file.role, path: target, sourceBytes: (await stat(target)).size });
}
let generated = [];
if (mode === 'real') {
  for (const [index, file] of capture.files.entries()) {
    await copyCaptured(file);
    if (index % 250 === 0) console.log(JSON.stringify({ mode, copied: index + 1, total: capture.files.length }));
  }
} else {
  const lineCache = path.join(directory, 'line-inputs.json');
  const lines = resumeLines ? JSON.parse(await readFile(lineCache, 'utf8')) : await generateLineInputs({ root, scale, files: files.filter(f => !['zcode', 'opencode'].includes(f.kind)),
    onProgress: (file, index, total) => { if (index % 100 === 0 || index === total - 1) console.log(JSON.stringify({ mode, generated: index + 1, total, kind: file.kind })); } });
  assert.equal(lines.scale, scale); assert.equal(lines.files.length, files.filter(f => !['zcode', 'opencode'].includes(f.kind)).length);
  if (!resumeLines) await writeFile(lineCache, JSON.stringify(lines, null, 2));
  generated.push(...lines.files.map(f => ({ ...f, role: 'usage-file' })));
  const sqlite = await generateSqliteInputs({ root, scale, files: files.filter(f => ['zcode', 'opencode'].includes(f.kind)) });
  generated.push(...sqlite.map(f => ({ ...f, path: path.join(root, f.relativePath), events: f.eventCount, role: 'usage-file' })));
  for (const file of capture.files.filter(f => f.role === 'auxiliary')) await copyCaptured(file);
}
const inputs = [...copied, ...generated];
for (const [index, file] of inputs.entries()) {
  const hash = createHash('sha256'); for await (const bytes of createReadStream(file.path)) hash.update(bytes);
  file.sha256 = hash.digest('hex');
  if (index % 300 === 0) console.log(JSON.stringify({ mode, hashed: index + 1, total: inputs.length }));
}
const seed = path.join(directory, 'seed-empty');
await cp(path.join(oldBase, 'seed-empty'), seed, { recursive: true, preserveTimestamps: true });
const stateManifest = JSON.parse(await readFile(path.join(seed, 'state-manifest.json'), 'utf8'));
stateManifest.logicalRoot = path.join(root, '.codex-usage'); stateManifest.physicalRoot = seed;
await writeFile(path.join(seed, 'state-manifest.json'), JSON.stringify(stateManifest, null, 2));
const options = { homeDir: root, env: {}, importDirs: [], extraHomes: '', extraZcodeHomes: '', extraDshHomes: '',
  extraOpencodeHomes: path.join(root, '.opencode'), extraClaudeHomes: '', extraWorkbuddyHomes: '',
  automaticDiscoveryEnabled: false, pricingRefreshSchedulerEnabled: false };
await writeFile(path.join(directory, 'options.json'), JSON.stringify(options, null, 2));
const fields = ['total', 'input', 'cached', 'output', 'reasoning'];
let expected;
if (mode === 'real') {
  const db = new DatabaseSync(path.join(oldBase, 'formal-index-stage-empty-detail/state/usage-index.sqlite'), { readOnly: true });
  try {
    expected = db.prepare(`SELECT s.kind,COUNT(e.id) events,${fields.map(f => `SUM(e.${f}) ${f}`).join(',')}
      FROM source_files s LEFT JOIN events e ON e.source_path=s.path GROUP BY s.kind`).all().map(r => ({ ...r, kind: family(r.kind) }));
  } finally { db.close(); }
} else {
  expected = Object.keys(homes).map(kind => {
    const events = files.filter(f => f.kind === kind).reduce((n, f) => n + f.events * scale, 0);
    return { kind, events, total: events * 15, input: events * 10, cached: events * 2, output: events * 5,
      reasoning: ['dsh', 'claude'].includes(kind) ? 0 : events };
  });
}
const manifest = { mode, scale, createdAt: new Date().toISOString(), private: true, directory, root, seed,
  profile: path.join(base, 'profile.json'), sourceFilesystemReplay: false, expected,
  expectedFiles: files.length, expectedHomes: 6,
  expectedQuota: files.reduce((n, f) => n + f.quotaObservations * scale, 0),
  synthetic: mode !== 'real', fixedTimeSpanDays: mode === 'real' ? null : 90, coldSegments: 0,
  inputs, totals: { sourceBytes: inputs.filter(f => f.role === 'usage-file').reduce((n, f) => n + f.sourceBytes, 0),
    auxiliaryBytes: inputs.filter(f => f.role === 'auxiliary').reduce((n, f) => n + f.sourceBytes, 0),
    decodedBytes: mode === 'real' ? files.reduce((n,f) => n + f.decodedBytes, 0) : generated.reduce((n, f) => n + (f.decodedBytes || 0), 0),
    rows: mode === 'real' ? files.reduce((n,f) => n + f.rows, 0) : generated.reduce((n, f) => n + (f.rows || f.rawRows || 0), 0) } };
assert.equal(inputs.filter(f => f.role === 'usage-file').length, files.length);
assert.equal(expected.reduce((n, f) => n + f.events, 0), files.reduce((n, f) => n + f.events * scale, 0));
await writeFile(path.join(directory, 'dataset.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ mode, complete: true, totals: manifest.totals, expected }));
