import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const output = path.join(root, 'output/codex-incremental-visibility-20261027/probes');
const identityFile = path.resolve(process.env.I1_IDENTITY || path.join(output, 'identity.json'));
const inside = (file, directory) => {
  const relative = path.relative(directory, path.resolve(file));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
assert.ok(inside(identityFile, output), 'identity must belong to this stage');
const rawReadFile = fs.readFileSync.bind(fs);
const rawStat = fs.statSync.bind(fs);
const rawOpen = fs.openSync.bind(fs);
const rawRead = fs.readSync.bind(fs);
const rawClose = fs.closeSync.bind(fs);
const rawAppend = fs.appendFileSync.bind(fs);
const rawRealpath = fs.realpathSync.bind(fs);
const hash = value => createHash('sha256').update(value).digest('hex');
const identityText = rawReadFile(identityFile, 'utf8');
const identity = JSON.parse(identityText);
assert.equal(identity.formatVersion, 1);
assert.equal(path.resolve(identity.root).toLowerCase(), root.toLowerCase());
const frozenRoot = path.join(root, '.codex-usage/refresh-latency-20261026');
assert.equal(path.resolve(identity.frozenRoot).toLowerCase(), frozenRoot.toLowerCase());
assert.ok(inside(identity.manifest, frozenRoot) && inside(identity.database, frozenRoot));
assert.ok(inside(identity.codeRoot, root), 'code must be a pinned local tree');
function fileHash(file) {
  const digest = createHash('sha256');
  const handle = rawOpen(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let count;
    while ((count = rawRead(handle, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, count));
  } finally { rawClose(handle); }
  return digest.digest('hex');
}
// Verification is outside measured roots and reads frozen copies only.
function verifyInputs() {
  for (const input of identity.inputs) {
    assert.ok(inside(input.path, frozenRoot) && inside(rawRealpath(input.path), frozenRoot));
    assert.equal(rawStat(input.path).size, input.size, 'frozen input size: ' + input.path);
    assert.equal(fileHash(input.path), input.sha256, 'frozen input digest: ' + input.path);
  }
}
verifyInputs();
const manifest = JSON.parse(rawReadFile(identity.manifest, 'utf8'));
const mappings = [...manifest.mappings].sort((a, b) => b.original.length - a.original.length);
for (const item of mappings) assert.ok(inside(item.copy, frozenRoot) && inside(rawRealpath(item.copy), frozenRoot));
const runName = process.env.I1_RUN || new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
assert.match(runName, /^[a-zA-Z0-9_-]+$/);
const runDirectory = path.join(output, 'runs', runName);
fs.mkdirSync(path.dirname(runDirectory), { recursive: true });
fs.mkdirSync(runDirectory, { recursive: false });
const databaseFile = path.join(runDirectory, 'usage-index.sqlite');
const stagesFile = path.join(runDirectory, 'stages.jsonl');
const sourceCode = new Map(identity.code.map(item => [item.path.replaceAll('\\', '/'), item.sha256]));
assert.ok(!sourceCode.has('src/perf-sources/codex-prefix-evidence.js'),
  'This synchronous baseline hook has no prefix-worker accounting; adapt it before measuring the worker implementation');
const storage = new AsyncLocalStorage();
const readerIds = new WeakMap();
const previousKeys = new WeakMap();
let readerSerial = 0;
const readerId = reader => {
  if (!readerIds.has(reader)) readerIds.set(reader, ++readerSerial);
  return readerIds.get(reader);
};
const fileIds = new Map();
const fileId = file => {
  if (!file) return null;
  const canonical = path.resolve(String(file)).toLowerCase();
  if (!fileIds.has(canonical)) fileIds.set(canonical, hash(canonical).slice(0, 20));
  return fileIds.get(canonical);
};
function bucket(context) {
  const frame = context.frame || { helper: 'other', kind: '', file: null };
  const key = JSON.stringify([context.phase || 'unclassified', frame.helper, frame.kind, frame.file]);
  if (!context.reads.has(key)) context.reads.set(key, {
    phase: context.phase || 'unclassified', ...frame, calls: 0, ms: 0,
    readCalls: 0, bytes: 0, statCalls: 0, statMs: 0,
  });
  return context.reads.get(key);
}
globalThis.__i1Begin = (helper, kind, file) => {
  const context = storage.getStore();
  if (!context) return () => {};
  const previous = context.frame;
  context.frame = { helper, kind: String(kind || ''), file: fileId(file) };
  const row = bucket(context), started = performance.now();
  row.calls++;
  return () => { row.ms += performance.now() - started; context.frame = previous; };
};
globalThis.__i1Call = (phase, action) => {
  const context = storage.getStore();
  if (!context) return action();
  const previous = context.phase;
  context.phase = phase;
  const metric = context.phases[phase] ||= { calls: 0, ms: 0 };
  metric.calls++;
  const started = performance.now();
  try {
    const result = action();
    assert.ok(!result || typeof result.then !== 'function', 'sync attribution scope received a promise');
    return result;
  } finally { metric.ms += performance.now() - started; context.phase = previous; }
};
fs.readSync = function (...args) {
  const count = rawRead(...args), context = storage.getStore();
  if (context) {
    context.readCalls++; context.bytes += count;
    const row = bucket(context); row.readCalls++; row.bytes += count;
  }
  return count;
};
function mapped(value) {
  if (typeof value === 'number') return value;
  const file = value instanceof URL ? fileURLToPath(value) : value;
  if (typeof file !== 'string') return value;
  const absolute = path.resolve(file);
  const item = mappings.find(entry => inside(absolute, entry.original));
  if (item) return path.join(item.copy, path.relative(item.original, absolute));
  for (const directory of ['src', 'public']) {
    if (inside(absolute, path.join(root, directory))) return path.join(identity.codeRoot, path.relative(root, absolute));
  }
  if (inside(absolute, frozenRoot) || inside(absolute, runDirectory) ||
      inside(absolute, output) || inside(absolute, identity.codeRoot) || inside(absolute, path.join(root, 'node_modules')) ||
      absolute === path.join(root, 'package.json') || absolute === identity.oldAfter.path) return absolute;
  throw new Error('Unmapped filesystem access refused: ' + absolute);
}
const reverse = file => {
  const item = mappings.find(entry => inside(file, entry.copy));
  return item ? path.join(item.original, path.relative(item.copy, file)) : file;
};
for (const name of ['readFileSync', 'openSync', 'statSync', 'lstatSync', 'existsSync', 'readdirSync', 'accessSync',
  'createReadStream', 'readFile', 'open', 'stat', 'lstat', 'readdir', 'access', 'opendir']) {
  const original = fs[name];
  if (typeof original !== 'function') continue;
  fs[name] = function (file, ...args) {
    const started = performance.now();
    try { return original.call(this, mapped(file), ...args); }
    finally {
      const context = storage.getStore();
      if (name === 'statSync' && context) { const row = bucket(context); row.statCalls++; row.statMs += performance.now() - started; }
    }
  };
}
fs.realpathSync = function (file, ...args) { return reverse(rawRealpath(mapped(file), ...args)); };
for (const name of ['readFile', 'open', 'stat', 'lstat', 'readdir', 'access', 'opendir', 'realpath']) {
  const original = fsp[name].bind(fsp);
  fsp[name] = function (file, ...args) {
    const result = original(mapped(file), ...args);
    return name === 'realpath' ? result.then(reverse) : result;
  };
}
function writable(file) {
  const physical = mapped(file);
  assert.ok(typeof physical === 'string' && inside(physical, runDirectory), 'write outside the private run refused');
  return physical;
}
for (const [api, names] of [[fs, ['writeFileSync', 'appendFileSync', 'mkdirSync', 'unlinkSync', 'rmSync']],
  [fsp, ['writeFile', 'appendFile', 'mkdir', 'unlink', 'rm']]]) {
  for (const name of names) {
    const original = api[name].bind(api);
    api[name] = function (file, ...args) { return original(writable(file), ...args); };
  }
}
for (const [api, names] of [[fs, ['copyFileSync', 'renameSync']], [fsp, ['copyFile', 'rename']]]) {
  for (const name of names) {
    const original = api[name].bind(api);
    api[name] = function (from, to, ...args) {
      return original(name.startsWith('rename') ? writable(from) : mapped(from), writable(to), ...args);
    };
  }
}
syncBuiltinESMExports();
globalThis.__I1DatabaseSync = class extends DatabaseSync {
  constructor(file, options = {}) {
    const physical = mapped(file);
    assert.ok(inside(physical, runDirectory) || (inside(physical, frozenRoot) && options.readOnly === true),
      'SQLite must use the run copy or read-only frozen sources');
    super(physical, options);
  }
};
function replaceOnce(source, before, after, label) {
  assert.equal(source.split(before).length - 1, 1, 'instrumentation anchor: ' + label);
  return source.replace(before, after);
}
function wrapHelper(source, signature, helper, kind, file) {
  const at = source.indexOf(signature);
  assert.ok(at >= 0 && source.indexOf(signature, at + 1) < 0, 'helper anchor: ' + helper);
  const start = at + signature.length, end = source.indexOf('\n}', start);
  assert.ok(end >= start);
  return source.slice(0, start) + `\nconst __i1Done = globalThis.__i1Begin(${JSON.stringify(helper)}, ${kind}, ${file}); try {\n` +
    source.slice(start, end) + '\n} finally { __i1Done(); }' + source.slice(end);
}
registerHooks({ load(url, context, nextLoad) {
  if (!url.startsWith('file:')) return nextLoad(url, context);
  const relative = path.relative(root, fileURLToPath(url)).replaceAll('\\', '/');
  if (!relative.startsWith('src/') && !relative.startsWith('public/')) return nextLoad(url, context);
  const expected = sourceCode.get(relative);
  assert.ok(expected, 'module absent from pinned tree: ' + relative);
  const bytes = rawReadFile(path.join(identity.codeRoot, relative));
  assert.equal(hash(bytes), expected, 'pinned source changed: ' + relative);
  let source = bytes.toString('utf8').replaceAll('\r\n', '\n');
  source = source.replaceAll('new DatabaseSync(', 'new globalThis.__I1DatabaseSync(');
  if (relative === 'src/usage-core.js') {
    source = wrapHelper(source, 'function perfContentFingerprint(kind, filePath) {', 'perfContentFingerprint', 'kind', 'filePath');
    source = wrapHelper(source, 'function perfFilePrefixEvidence(filePath) {', 'prefix', '"codex"', 'filePath');
    for (const [before, phase] of [
      ['perfHomeContentFingerprint(home, files, null, true)', 'window.before'],
      ['perfHomeContentFingerprint(home, afterFiles)', 'window.after'],
    ]) source = replaceOnce(source, '= ' + before + ';', '= globalThis.__i1Call(' + JSON.stringify(phase) + ', () => ' + before + ');', phase);
  }
  if (relative === 'src/usage-store.js') {
    source = wrapHelper(source, 'function enabledPerfSourceStat(kind, filePath) {', 'enabledPerfSourceStat', 'kind', 'filePath');
    const expression = 'perfFileNeedsRefresh(file.source.kind, file.filePath, publishedCodexFingerprints, publishedCodexWarnings)';
    source = replaceOnce(source, expression, 'globalThis.__i1Call("decision.metadata", () => ' + expression + ')', 'metadata');
    for (const [kind, reuse, phase, indent] of [
      ['kind', 'prescanReusedCurrent', 'decision.prescan', '            '],
      ['changedKind', 'reusedCurrent', 'decision.file', '        '],
    ]) {
      const expression = 'perfFileNeedsRefresh(\n' + [kind, 'file.filePath', 'this.publishedFileFingerprintsForRead()',
        'this.publishedFileWarningsForRead()', reuse].map(value => indent + '  ' + value + ',').join('\n') + '\n' + indent + ')';
      source = replaceOnce(source, expression, 'globalThis.__i1Call(' + JSON.stringify(phase) + ', () => ' + expression + ')', phase);
    }
    for (const [before, after, phase] of [
      ['const fingerprint = enabledPerfSourceStat(file.source.kind, file.filePath);',
        'const fingerprint = globalThis.__i1Call("rename", () => enabledPerfSourceStat(file.source.kind, file.filePath));', 'rename'],
      ['discovered.map((filePath) => enabledPerfSourceStat("codex", filePath))',
        'discovered.map((filePath) => globalThis.__i1Call("window.publish", () => enabledPerfSourceStat("codex", filePath)))', 'window.publish'],
      ['const statBefore = enabledPerfSourceStat(source.kind, filePath);',
        'const statBefore = globalThis.__i1Call("reader.before", () => enabledPerfSourceStat(source.kind, filePath));', 'reader.before'],
      ['const statAfter = enabledPerfSourceStat(source.kind, filePath);',
        'const statAfter = globalThis.__i1Call("reader.after", () => enabledPerfSourceStat(source.kind, filePath));', 'reader.after'],
    ]) source = replaceOnce(source, before, after, phase);
  }
  return { format: 'module', source, shortCircuit: true };
} });
function components(key) {
  return Object.fromEntries(key.split('\u0001').map(part => {
    const index = part.indexOf('\u0000');
    assert.ok(index > 0, 'unrecognized projection key component');
    return [part.slice(0, index), part.slice(index + 1)];
  }));
}
const changed = (before, after) => [...new Set([...Object.keys(before || {}), ...Object.keys(after)])]
  .filter(key => before?.[key] !== after[key]);
const { UsageStore } = await import(pathToFileURL(path.join(root, 'src/usage-store.js')).href);
const originalKeys = UsageStore.prototype.summaryProjectionKeys;
UsageStore.prototype.summaryProjectionKeys = function (...args) {
  const result = originalKeys.apply(this, args), context = storage.getStore();
  if (context) {
    const current = components(result.key), previous = previousKeys.get(this);
    const slot = this.summaryProjectionCache;
    context.keys.push({ reader: readerId(this), components: current,
      changedSincePrevious: changed(previous, current),
      changedSinceSlot: slot ? changed(components(slot.key), current) : null,
      slotPresent: Boolean(slot), factsHit: slot?.factsKey === result.factsKey, fullHit: slot?.key === result.key,
      now: context.now, lastCommitReason: this.lastCommitReason ?? null });
    previousKeys.set(this, current);
  }
  return result;
};
for (const name of ['timelineRange', 'groupedRange', 'perfSummaryForRange', 'capturePerfCarrier', 'buildPerfSummaryForRange',
  'recordsForRange', 'metadata', 'periodComparison']) {
  const original = UsageStore.prototype[name];
  assert.equal(typeof original, 'function', name);
  assert.notEqual(original.constructor.name, 'AsyncFunction', 'synchronous method: ' + name);
  UsageStore.prototype[name] = function (...args) {
    const started = performance.now();
    try { return original.apply(this, args); }
    finally {
      const context = storage.getStore();
      if (context) {
        const metric = context.methods[name] ||= { calls: 0, ms: 0 };
        metric.calls++; metric.ms += performance.now() - started;
      }
    }
  };
}
async function trace(label, store, action, now = null) {
  const context = { label, reader: readerId(store), now, reads: new Map(), readCalls: 0, bytes: 0, keys: [], methods: {}, phases: {},
    coverage: { synchronousReadSync: true, sqliteInternalReads: false, asyncReaderBytes: false, prefixWorkerReads: false } };
  const started = performance.now();
  try { return await storage.run(context, action); }
  catch (error) { context.error = { name: error.name, message: error.message }; throw error; }
  finally {
    const reads = [...context.reads.values()];
    assert.equal(reads.reduce((sum, row) => sum + row.bytes, 0), context.bytes, 'exclusive read-byte partition');
    assert.equal(reads.reduce((sum, row) => sum + row.readCalls, 0), context.readCalls, 'exclusive read-call partition');
    const { frame, phase, ...report } = context;
    rawAppend(stagesFile, JSON.stringify({ ...report, reads, ms: performance.now() - started,
      rss: process.memoryUsage().rss, maxRSSKiB: process.resourceUsage().maxRSS }) + '\n');
  }
}
globalThis.__i1Probe = { root, output, runDirectory, databaseFile, manifest, identityHash: hash(identityText),
  identity, mapped, trace, verifyInputs };
