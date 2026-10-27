import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { isMainThread, threadId, workerData } from 'node:worker_threads';

const prefixWorker = !isMainThread && workerData?.task === 'codex-prefix-window';
assert.ok(isMainThread || prefixWorker, 'this hook supports direct UsageStore runs and their prefix workers');
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
if (prefixWorker) {
  assert.equal(hash(identityText), process.env.I1_VERIFIED_IDENTITY, 'worker inherited a different input identity');
} else {
  verifyInputs();
  process.env.I1_VERIFIED_IDENTITY = hash(identityText);
  process.env.I1_IDENTITY = identityFile;
}
const manifest = JSON.parse(rawReadFile(identity.manifest, 'utf8'));
const mappings = [...manifest.mappings].sort((a, b) => b.original.length - a.original.length);
for (const item of mappings) assert.ok(inside(item.copy, frozenRoot) && inside(rawRealpath(item.copy), frozenRoot));
const runName = process.env.I1_RUN || new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
assert.match(runName, /^[a-zA-Z0-9_-]+$/);
const runDirectory = path.join(output, 'runs', runName);
if (prefixWorker) {
  assert.ok(rawStat(runDirectory).isDirectory(), 'worker requires the existing parent run directory');
} else {
  fs.mkdirSync(path.dirname(runDirectory), { recursive: true });
  fs.mkdirSync(runDirectory, { recursive: false });
  process.env.I1_RUN = runName;
}
const databaseFile = path.join(runDirectory, 'usage-index.sqlite');
const stagesFile = path.join(runDirectory, 'stages.jsonl');
const sourceCode = new Map(identity.code.map(item => [item.path.replaceAll('\\', '/'), item.sha256]));
const hookHash = hash(rawReadFile(fileURLToPath(import.meta.url)));
const loadedModules = new Map();
if (prefixWorker) assert.equal(hookHash, process.env.I1_VERIFIED_HOOK, 'worker preload changed during the run');
else process.env.I1_VERIFIED_HOOK = hookHash;
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
function readKey(row) { return JSON.stringify([row.threadId, row.phase, row.helper, row.kind, row.file]); }
function bucket(context) {
  const frame = context.frame || { helper: 'other', kind: '', file: null };
  const row = { threadId, phase: context.phase || 'unclassified', ...frame };
  const key = readKey(row);
  if (!context.reads.has(key)) context.reads.set(key, {
    ...row, calls: 0, ms: 0,
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
// Only the already-async planning function uses this scope; synchronous helpers stay synchronous.
globalThis.__i1Window = async (phase, action) => {
  const context = storage.getStore();
  if (!context) return action();
  const previous = context.phase, started = performance.now();
  const metric = context.phases[phase] ||= { calls: 0, ms: 0 };
  metric.calls++;
  context.phase = phase;
  try { return await action(); }
  finally { metric.ms += performance.now() - started; context.phase = previous; }
};
function checkPartition(context, reads) {
  assert.equal(reads.reduce((sum, row) => sum + row.bytes, 0), context.bytes, 'exclusive read-byte partition');
  assert.equal(reads.reduce((sum, row) => sum + row.readCalls, 0), context.readCalls, 'exclusive read-call partition');
}
globalThis.__i1WorkerResult = action => {
  assert.ok(prefixWorker, 'worker evidence must be collected in a prefix worker');
  const context = { reads: new Map(), bytes: 0, readCalls: 0, localBytes: 0, localReadCalls: 0, phases: {} };
  const started = performance.now();
  const value = storage.run(context, () => globalThis.__i1Call('window.before', action));
  const reads = [...context.reads.values()];
  checkPartition(context, reads);
  assert.ok(loadedModules.has('src/usage-core.js'), 'worker core helper instrumentation missing');
  assert.equal(reads.filter(row => row.helper === 'perfContentFingerprint').reduce((sum, row) => sum + row.calls, 0),
    workerData.files.length, 'worker file helper coverage is incomplete');
  if (value.complete) assert.equal(reads.filter(row => row.helper === 'prefix').reduce((sum, row) => sum + row.calls, 0),
    workerData.files.length, 'complete worker window is missing prefix helper evidence');
  const memory = process.memoryUsage();
  return { ...value, __i1ReadEvidence: {
    threadId, pid: process.pid, hookHash, identityHash: hash(identityText),
    files: workerData.files.length, bytes: context.bytes, readCalls: context.readCalls,
    reads, phases: context.phases, ms: performance.now() - started,
    heapUsed: memory.heapUsed, heapTotal: memory.heapTotal,
  } };
};
globalThis.__i1ExpectWorker = () => {
  const context = storage.getStore();
  assert.ok(context && isMainThread, 'prefix worker spawned outside an attributed root');
  context.workersExpected++;
};
globalThis.__i1MergeWorker = value => {
  const context = storage.getStore(), report = value?.__i1ReadEvidence;
  assert.ok(context && report, 'prefix worker result has no attributed read evidence');
  assert.equal(report.hookHash, hookHash, 'worker/main hook mismatch');
  assert.equal(report.identityHash, hash(identityText), 'worker/main identity mismatch');
  assert.ok(Number.isInteger(report.threadId) && report.threadId > 0 && report.pid === process.pid);
  assert.ok(!context.workers.some(worker => worker.threadId === report.threadId), 'duplicate worker result');
  checkPartition(report, report.reads);
  for (const row of report.reads) {
    assert.equal(row.threadId, report.threadId, 'worker read row belongs to another thread');
    assert.ok(!context.reads.has(readKey(row)), 'worker read evidence counted twice');
    context.reads.set(readKey(row), row);
  }
  context.bytes += report.bytes;
  context.readCalls += report.readCalls;
  const { reads, ...summary } = report;
  context.workers.push(summary);
  const { __i1ReadEvidence, ...original } = value;
  return original;
};
fs.readSync = function (...args) {
  const count = rawRead(...args), context = storage.getStore();
  if (context) {
    context.readCalls++; context.bytes += count;
    context.localReadCalls++; context.localBytes += count;
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
function productRelative(url) {
  if (!url.startsWith('file:')) return null;
  const file = fileURLToPath(url);
  const relative = path.relative(inside(file, identity.codeRoot) ? identity.codeRoot : root, file).replaceAll('\\', '/');
  return relative.startsWith('src/') || relative.startsWith('public/') ? relative : null;
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    const relative = productRelative(result.url);
    return relative ? { ...result, url: pathToFileURL(path.join(root, relative)).href } : result;
  },
  load(url, context, nextLoad) {
  if (!url.startsWith('file:')) return nextLoad(url, context);
  const relative = productRelative(url);
  if (!relative) return nextLoad(url, context);
  const canonical = pathToFileURL(path.join(root, relative)).href;
  assert.equal(url, canonical, 'product module bypassed canonical resolve');
  const expected = sourceCode.get(relative);
  assert.ok(expected, 'module absent from pinned tree: ' + relative);
  const bytes = storage.run(undefined, () => rawReadFile(path.join(identity.codeRoot, relative)));
  assert.equal(hash(bytes), expected, 'pinned source changed: ' + relative);
  let source = bytes.toString('utf8').replaceAll('\r\n', '\n');
  source = source.replaceAll('new DatabaseSync(', 'new globalThis.__I1DatabaseSync(');
  loadedModules.set(relative, { url, sha256: expected });
  if (relative === 'src/usage-core.js') {
    source = wrapHelper(source, 'function perfContentFingerprint(kind, filePath) {', 'perfContentFingerprint', 'kind', 'filePath');
    source = wrapHelper(source, 'function perfFilePrefixEvidence(filePath) {', 'prefix', '"codex"', 'filePath');
    if (source.includes('async function codexPlanningFingerprint(home, files) {')) {
      source = replaceOnce(source, 'before = await codexPlanningFingerprint(home, files);',
        'before = await globalThis.__i1Window("window.before", () => codexPlanningFingerprint(home, files));', 'window.before.async');
      source = replaceOnce(source, 'const worker = new Worker(new URL(import.meta.url), {',
        'globalThis.__i1ExpectWorker();\n          const worker = new Worker(new URL(import.meta.url), {', 'worker.expected');
      source = replaceOnce(source, 'result = value;', 'result = globalThis.__i1MergeWorker(value);', 'worker.merge');
      source = replaceOnce(source,
        'parentPort.postMessage(perfHomeContentFingerprint({ kind: workerData.kind }, workerData.files, null, true));',
        'parentPort.postMessage(globalThis.__i1WorkerResult(() => perfHomeContentFingerprint({ kind: workerData.kind }, workerData.files, null, true)));',
        'worker.result');
    } else {
      source = replaceOnce(source, '= perfHomeContentFingerprint(home, files, null, true);',
        '= globalThis.__i1Call("window.before", () => perfHomeContentFingerprint(home, files, null, true));', 'window.before.sync');
    }
    source = replaceOnce(source, '= perfHomeContentFingerprint(home, afterFiles);',
      '= globalThis.__i1Call("window.after", () => perfHomeContentFingerprint(home, afterFiles));', 'window.after');
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
  if (relative === 'src/usage-store.js') source += '\nexport const __i1HookHash = ' + JSON.stringify(hookHash) + ';\n';
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
// A worker must finish preload before its core entry executes and posts its result.
if (!prefixWorker) {
const storeModule = await import(pathToFileURL(path.join(root, 'src/usage-store.js')).href);
assert.equal(storeModule.__i1HookHash, hookHash, 'UsageStore module was cached or loaded without this hook');
for (const file of ['src/usage-store.js', 'src/usage-core.js']) assert.ok(loadedModules.has(file), 'missing instrumented module: ' + file);
const { UsageStore } = storeModule;
fs.writeFileSync(path.join(runDirectory, 'setup.json'), JSON.stringify({ hookHash, identityHash: hash(identityText),
  loadedModules: Object.fromEntries(loadedModules), sqliteConstructorMapped: true, prefixWorkerAccounting: true }, null, 2));
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
  assert.ok(store instanceof UsageStore, 'trace received a different UsageStore module instance');
  const context = { label, reader: readerId(store), now, reads: new Map(), readCalls: 0, bytes: 0,
    localBytes: 0, localReadCalls: 0, workersExpected: 0, workers: [], keys: [], methods: {}, phases: {},
    instrumentation: { hookHash, sqliteConstructorMapped: true },
    coverage: { synchronousReadSync: true, sqliteInternalReads: false, asyncReaderBytes: false, prefixWorkerReads: true } };
  const started = performance.now();
  try { return await storage.run(context, action); }
  catch (error) { context.error = { name: error.name, message: error.message }; throw error; }
  finally {
    const reads = [...context.reads.values()];
    checkPartition(context, reads);
    assert.equal(context.localBytes + context.workers.reduce((sum, worker) => sum + worker.bytes, 0), context.bytes);
    assert.equal(context.localReadCalls + context.workers.reduce((sum, worker) => sum + worker.readCalls, 0), context.readCalls);
    const requiresSyncScopes = label.includes('sync') || label.startsWith('catchup') || label.startsWith('settle');
    const attributed = reads.some(row => row.helper !== 'other' && row.calls > 0);
    context.instrumentation.valid = context.workers.length === context.workersExpected &&
      (!requiresSyncScopes || (attributed && Object.keys(context.phases).length > 0));
    const { frame, phase, ...report } = context;
    rawAppend(stagesFile, JSON.stringify({ ...report, reads, ms: performance.now() - started,
      rss: process.memoryUsage().rss, maxRSSKiB: process.resourceUsage().maxRSS }) + '\n');
    assert.ok(context.instrumentation.valid, 'helper scopes or worker evidence missing; sample retained as invalid');
  }
}
globalThis.__i1Probe = { root, output, runDirectory, databaseFile, manifest, identityHash: hash(identityText),
  identity, mapped, trace, verifyInputs, UsageStore, hookHash };
}
