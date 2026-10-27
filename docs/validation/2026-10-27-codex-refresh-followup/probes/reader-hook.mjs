import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { isMainThread, parentPort, threadId, workerData } from 'node:worker_threads';

const root = path.resolve('E:/12 AI/ccusage/codex-usage');
assert.equal(process.cwd().toLowerCase(), root.toLowerCase(), 'fixed repository cwd required');
assert.ok(!process.env.NODE_OPTIONS, 'use this preload alone; NODE_OPTIONS must be empty');
const prefixWorker = !isMainThread && workerData?.task === 'codex-prefix-window';
const executorWorker = !isMainThread && !prefixWorker && workerData?.options;
assert.ok(isMainThread || prefixWorker || executorWorker, 'unexpected worker entry');
const stage = path.join(root, 'output/codex-refresh-followup-20261027');
const codeRoot = path.join(stage, 'preimage');
const probeRoot = path.join(root, 'docs/validation/2026-10-27-codex-refresh-followup/probes');
const frozenRoot = path.join(root, '.codex-usage/refresh-latency-20261026');
const identityFile = path.join(stage, 'probes/identity-before.json');
const raw = Object.fromEntries(['readFileSync', 'statSync', 'existsSync', 'openSync', 'readSync', 'closeSync',
  'realpathSync', 'appendFileSync', 'writeFileSync', 'readdirSync'].map(name => [name, fs[name].bind(fs)]));
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (file, directory) => {
  const relative = path.relative(directory, path.resolve(file));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};
function physicalInside(file, directory) {
  assert.ok(inside(file, directory), 'path escaped private root: ' + file);
  let ancestor = file;
  while (!raw.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  assert.ok(inside(raw.realpathSync(ancestor), raw.realpathSync(directory)), 'reparse point escaped private root: ' + file);
}
physicalInside(stage, root);
physicalInside(codeRoot, stage);
physicalInside(probeRoot, root);
physicalInside(frozenRoot, root);
const identityText = raw.readFileSync(identityFile, 'utf8');
const identity = JSON.parse(identityText);
assert.equal(identity.formatVersion, 1);
assert.equal(path.resolve(identity.root).toLowerCase(), root.toLowerCase());
assert.equal(path.resolve(identity.codeRoot).toLowerCase(), codeRoot.toLowerCase(), 'reader probe requires this round preimage');
assert.equal(path.resolve(identity.frozenRoot).toLowerCase(), frozenRoot.toLowerCase());
assert.equal(path.resolve(identity.manifest).toLowerCase(), path.join(frozenRoot, 'freeze.json').toLowerCase());
const manifest = JSON.parse(raw.readFileSync(identity.manifest, 'utf8'));
assert.equal(path.resolve(identity.database).toLowerCase(), path.resolve(manifest.database).toLowerCase());
const mappings = [...manifest.mappings].sort((a, b) => b.original.length - a.original.length);
for (const item of mappings) physicalInside(item.copy, frozenRoot);
function fileHash(file) {
  const digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), fd = raw.openSync(file, 'r');
  try { for (let n; (n = raw.readSync(fd, buffer, 0, buffer.length, null)) > 0;) digest.update(buffer.subarray(0, n)); }
  finally { raw.closeSync(fd); }
  return digest.digest('hex');
}
function verifyInputs() {
  for (const input of identity.inputs) {
    physicalInside(input.path, frozenRoot);
    assert.equal(raw.statSync(input.path).size, input.size, 'frozen input size: ' + input.path);
    assert.equal(fileHash(input.path), input.sha256, 'frozen input hash: ' + input.path);
  }
}
const hookHash = hash(raw.readFileSync(fileURLToPath(import.meta.url)));
const runName = process.env.READER_RUN || `reader-${Date.now()}-${process.pid}`;
assert.match(runName, /^reader-[a-zA-Z0-9_-]+$/);
const runDirectory = path.join(stage, runName);
const setupFile = path.join(runDirectory, 'setup.json');
let setup;
if (isMainThread) {
  verifyInputs();
  fs.mkdirSync(runDirectory, { recursive: false });
  physicalInside(runDirectory, stage);
  const code = Object.fromEntries(identity.code.map(item => [item.path.replaceAll('\\', '/'), item.sha256]));
  setup = { hookHash, identityHash: hash(identityText), codeRoot, code, node: process.version,
    frozenDatabase: identity.database, inputCount: identity.inputs.length, startedAt: new Date().toISOString() };
  raw.writeFileSync(setupFile, JSON.stringify(setup, null, 2), { flag: 'wx' });
  process.env.READER_RUN = runName;
  process.env.READER_SETUP_HASH = fileHash(setupFile);
} else {
  physicalInside(runDirectory, stage);
  assert.equal(fileHash(setupFile), process.env.READER_SETUP_HASH, 'worker setup changed');
  setup = JSON.parse(raw.readFileSync(setupFile, 'utf8'));
  assert.equal(setup.hookHash, hookHash, 'worker preload differs');
  assert.equal(setup.identityHash, hash(identityText), 'worker frozen identity differs');
}
const databaseFile = path.join(runDirectory, 'usage-index.sqlite');
const eventsFile = path.join(runDirectory, `events-${threadId}.jsonl`);
const storage = new AsyncLocalStorage(), readers = new WeakMap(), previousKeys = new WeakMap();
let readerSerial = 0, stateSerial = 0, publishedSerial = 0;
const readerId = store => {
  if (!store) return null;
  if (!readers.has(store)) readers.set(store, `${threadId}:${++readerSerial}`);
  return readers.get(store);
};
function event(kind, detail = {}) {
  const context = storage.getStore();
  raw.appendFileSync(eventsFile, JSON.stringify({ kind, threadId, at: performance.now(),
    requestId: context?.id ?? null, label: context?.label ?? null, ...detail }) + '\n');
}
function components(key) {
  return Object.fromEntries(key.split('\u0001').map(part => {
    const split = part.indexOf('\u0000');
    assert.ok(split > 0, 'unknown key format');
    return [part.slice(0, split), part.slice(split + 1)];
  }));
}
const diff = (a, b) => [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].filter(key => a?.[key] !== b?.[key]);
assert.deepEqual(components('a\u0000one\u0000two\u0001b\u00003'), { a: 'one\u0000two', b: '3' });
assert.deepEqual(diff({ a: '1' }, { a: '2' }), ['a']);
assert.equal(inside(path.join(runDirectory, '..', 'escape.sqlite'), runDirectory), false);
function snapshot(store) {
  if (!store) return null;
  const slot = store.summaryProjectionCache, quote = slot?.quoteInputs;
  return { reader: readerId(store), open: Boolean(store.database), storeRevision: store.storeRevision,
    derivedRevision: store.derivedRevision, lastCommitReason: store.lastCommitReason,
    totalChanges: store.database ? Number(store.database.prepare('SELECT total_changes() AS n').get().n) : null,
    dataVersion: store.database ? store.readDataVersion() : null, writeTransactionDepth: store.writeTransactionDepth,
    cache: { slots: slot ? 1 : 0, components: slot ? components(slot.key) : null,
      rows: slot ? Object.fromEntries(Object.entries(slot.projection).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])) : {},
      quoteRows: quote?.length ?? 0, quoteEstimatedBytes: quote?.bytes ?? 0,
      periodComparisonEntries: store.periodComparisonCache.size, metadataPresent: Boolean(store.metadataCache) } };
}
function mapped(value) {
  if (typeof value === 'number') return value;
  const file = value instanceof URL ? fileURLToPath(value) : value;
  assert.equal(typeof file, 'string', 'unexpected filesystem path');
  const absolute = path.resolve(file);
  const mapping = mappings.find(item => inside(absolute, item.original));
  const physical = mapping ? path.join(mapping.copy, path.relative(mapping.original, absolute)) : absolute;
  const directory = [frozenRoot, runDirectory, codeRoot, probeRoot].find(item => inside(physical, item));
  if (directory) { physicalInside(physical, directory); return physical; }
  if (physical === path.join(root, 'package.json')) return physical;
  throw new Error('unmapped filesystem access refused: ' + physical);
}
const writable = value => {
  const file = mapped(value);
  physicalInside(file, runDirectory);
  return file;
};
const reverse = file => {
  const mapping = mappings.find(item => inside(file, item.copy));
  return mapping ? path.join(mapping.original, path.relative(mapping.copy, file)) : file;
};
for (const name of ['readFileSync', 'statSync', 'lstatSync', 'existsSync', 'readdirSync', 'accessSync',
  'createReadStream', 'readFile', 'stat', 'lstat', 'readdir', 'access', 'opendir']) {
  const original = fs[name].bind(fs);
  fs[name] = (file, ...args) => original(mapped(file), ...args);
}
for (const api of [fs, fsp]) {
  for (const name of api === fs ? ['openSync', 'open'] : ['open']) {
    const original = api[name].bind(api);
    api[name] = (file, flags, ...args) => {
      const writing = typeof flags === 'number' ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0 : /[wa+]/.test(flags || 'r');
      return original(writing ? writable(file) : mapped(file), flags, ...args);
    };
  }
  for (const name of api === fs ? ['writeFileSync', 'appendFileSync', 'mkdirSync', 'unlinkSync', 'rmSync', 'createWriteStream'] : ['writeFile', 'appendFile', 'mkdir', 'unlink', 'rm']) {
    const original = api[name].bind(api);
    api[name] = (file, ...args) => original(writable(file), ...args);
  }
  for (const name of api === fs ? ['copyFileSync', 'renameSync'] : ['copyFile', 'rename']) {
    const original = api[name].bind(api);
    api[name] = (from, to, ...args) => original(name.startsWith('rename') ? writable(from) : mapped(from), writable(to), ...args);
  }
}
fs.realpathSync = (file, ...args) => reverse(raw.realpathSync(mapped(file), ...args));
for (const name of ['readFile', 'stat', 'lstat', 'readdir', 'access', 'opendir', 'realpath']) {
  const original = fsp[name].bind(fsp);
  fsp[name] = (file, ...args) => {
    const value = original(mapped(file), ...args);
    return name === 'realpath' ? value.then(reverse) : value;
  };
}
syncBuiltinESMExports();
globalThis.__ReaderDatabaseSync = class extends DatabaseSync {
  constructor(file, options = {}) {
    const physical = mapped(file);
    const runDatabase = physical.toLowerCase() === databaseFile.toLowerCase();
    assert.ok(runDatabase || (inside(physical, frozenRoot) && options.readOnly === true &&
      physical.toLowerCase() !== path.resolve(identity.database).toLowerCase()), 'SQLite escaped run copy/read-only frozen source');
    assert.ok(!isMainThread, 'main thread must not open SQLite');
    super(physical, options);
    event('sqlite-open', { physical, readOnly: options.readOnly === true });
  }
  prepare(sql) {
    assert.ok(!/\bATTACH\b/i.test(sql), 'this hot-seed probe does not permit SQLite ATTACH');
    return super.prepare(sql);
  }
  exec(sql) {
    assert.ok(!/\bATTACH\b/i.test(sql), 'this hot-seed probe does not permit SQLite ATTACH');
    return super.exec(sql);
  }
};
const probe = globalThis.__readerProbe = {
  root, codeRoot, runDirectory, databaseFile, manifest, setup, mapped, verifyInputs, label: null, writer: null,
  snapshot, event,
  published(reader, status) { publishedSerial++; event('reader-published', { publishedSerial, stateSerial, status, state: snapshot(reader) }); },
  select(reader, role, status) { event('dashboard-reader', { role, publishedSerial, stateSerial, status, state: snapshot(reader) }); },
  async request(message, action) {
    assert.ok(executorWorker, 'executor handler must run in the real executor worker');
    const context = { id: message.id, label: message.__readerLabel ?? message.type, type: message.type, methods: {}, keys: [] };
    const before = snapshot(probe.writer), started = performance.now();
    return storage.run(context, async () => {
      try { return await action(); }
      catch (error) { context.error = { message: error.message, code: error.code }; throw error; }
      finally { event('request-complete', { type: message.type, before, after: snapshot(probe.writer),
        stateSerial, publishedSerial, ms: performance.now() - started, methods: context.methods, keys: context.keys,
        error: context.error, rss: process.memoryUsage().rss }); }
    });
  },
  installStore(UsageStore) {
    const keys = UsageStore.prototype.summaryProjectionKeys;
    UsageStore.prototype.summaryProjectionKeys = function (...args) {
      const started = performance.now(), value = keys.apply(this, args), keyBuildMs = performance.now() - started;
      const slot = this.summaryProjectionCache, current = components(value.key);
      const entry = { reader: readerId(this), keyBuildMs, components: current, changedSincePrevious: diff(previousKeys.get(this), current),
        changedSinceSlot: slot ? diff(components(slot.key), current) : null,
        slotPresent: Boolean(slot), factsHit: slot?.factsKey === value.factsKey, fullHit: slot?.key === value.key };
      previousKeys.set(this, current);
      storage.getStore()?.keys.push(entry);
      event('projection-keys', entry);
      return value;
    };
    for (const name of ['dashboardHistory', 'summarizeHistory', 'summarizeInReadTransaction', 'summarizeInReadTransactionCore',
      'timelineRange', 'costEventsForRange', 'groupedRange', 'perfSummaryForRange', 'capturePerfCarrier',
      'buildPerfSummaryForRange', 'metadataHistory', 'periodComparisonHistory', 'open', 'sync', 'syncRound', 'close',
      'commitStoreRevision', 'syncDerivedRevision']) {
      const original = UsageStore.prototype[name];
      assert.equal(typeof original, 'function', 'missing measured method: ' + name);
      const finish = (store, started, before) => {
        const context = storage.getStore(), key = `${readerId(store)}/${name}`;
        if (context) {
          const metric = context.methods[key] ||= { calls: 0, ms: 0 };
          metric.calls++; metric.ms += performance.now() - started;
        }
        if (name === 'open' && !before.open) event('reader-opened', { state: snapshot(store) });
        if (name === 'close') event('reader-closed', { before, after: snapshot(store) });
        if (name === 'dashboardHistory') event('dashboard-method-complete', { state: snapshot(store) });
        if (['commitStoreRevision', 'syncDerivedRevision'].includes(name) &&
          (before.revision !== store.storeRevision || before.derived !== store.derivedRevision))
          event('revision', { method: name, reader: readerId(store), before, revision: store.storeRevision,
            derived: store.derivedRevision, lastCommitReason: store.lastCommitReason });
      };
      const before = store => name === 'close' ? snapshot(store) :
        { open: Boolean(store.database), revision: store.storeRevision, derived: store.derivedRevision };
      UsageStore.prototype[name] = original.constructor.name === 'GeneratorFunction' ? function* (...args) {
        const started = performance.now(), state = before(this);
        try { return yield* original.apply(this, args); } finally { finish(this, started, state); }
      } : original.constructor.name === 'AsyncFunction' ? async function (...args) {
        const started = performance.now(), state = before(this);
        try { return await original.apply(this, args); } finally { finish(this, started, state); }
      } : function (...args) {
        const started = performance.now(), state = before(this);
        try { return original.apply(this, args); } finally { finish(this, started, state); }
      };
    }
    event('store-instrumented');
  },
};
if (executorWorker) {
  assert.equal(path.resolve(workerData.options.databaseFile).toLowerCase(), databaseFile.toLowerCase());
  const post = parentPort.postMessage.bind(parentPort);
  parentPort.postMessage = (message, ...args) => {
    const value = post(message, ...args);
    if (message.type === 'state') event('state-posted', { stateSerial: ++stateSerial, state: message.state, writer: snapshot(probe.writer) });
    return value;
  };
}
function once(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, 'instrumentation anchor: ' + before);
  return source.replace(before, after);
}
function productRelative(file) {
  for (const base of [codeRoot, root]) {
    const relative = path.relative(base, file).replaceAll('\\', '/');
    if (/^(src|public)\//.test(relative)) return relative;
  }
  return null;
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (!result.url.startsWith('file:')) return result;
    const file = fileURLToPath(result.url), relative = productRelative(file);
    if (relative) return { ...result, url: pathToFileURL(path.join(codeRoot, relative)).href };
    assert.ok(inside(file, probeRoot) && path.basename(file).startsWith('reader-'), 'module outside pinned code/probe: ' + file);
    return result;
  },
  load(url, context, nextLoad) {
    if (!url.startsWith('file:')) return nextLoad(url, context);
    const file = fileURLToPath(url), relative = productRelative(file);
    if (!relative) return nextLoad(url, context);
    assert.equal(url, pathToFileURL(path.join(codeRoot, relative)).href, 'module URL escaped private code');
    physicalInside(file, codeRoot);
    const bytes = raw.readFileSync(file);
    assert.equal(hash(bytes), setup.code[relative], 'pinned module changed: ' + relative);
    let source = bytes.toString('utf8').replaceAll('\r\n', '\n');
    source = source.replaceAll('new DatabaseSync(', 'new globalThis.__ReaderDatabaseSync(');
    if (relative === 'src/usage-store.js') source += '\nglobalThis.__readerProbe.installStore(UsageStore);\n';
    if (relative === 'src/usage-executor.js') {
      source = once(source, 'const store = new UsageStore(workerData.options);',
        'const store = new UsageStore(workerData.options); globalThis.__readerProbe.writer = store;');
      source = once(source, 'publishedStatus = storeStatus;', 'publishedStatus = storeStatus; globalThis.__readerProbe.published(reader, publishedStatus);');
      source = once(source, 'const reader = publishedStore;', 'const reader = publishedStore; globalThis.__readerProbe.event("reader-release", {state: globalThis.__readerProbe.snapshot(reader)});');
      source = once(source, 'const reader = publishedStore || store;',
        'const reader = publishedStore || store; globalThis.__readerProbe.select(reader, publishedStore ? "published" : "writer", publishedStore ? publishedStatus : storeStatus);');
      source = once(source, 'switch (message.type) {', 'switch (message.type) {\ncase "readerTrace": return { writer: globalThis.__readerProbe.snapshot(store), published: globalThis.__readerProbe.snapshot(publishedStore), status: storeStatus, publishedStatus };');
      source = once(source, 'priceScoped ? runWithPricingCatalog(message.pricing, () => handle(message)) : handle(message);',
        'globalThis.__readerProbe.request(message, () => priceScoped ? runWithPricingCatalog(message.pricing, () => handle(message)) : handle(message));');
      source = once(source, 'target.postMessage({ ...toTransferable({ type, id, ...payload }) });',
        'target.postMessage({ ...toTransferable({ type, id, ...payload, __readerLabel: globalThis.__readerProbe.label }) });');
      source = once(source, 'open: (payload = {}) => request("open", payload),',
        'readerTrace: () => request("readerTrace"),\n    open: (payload = {}) => request("open", payload),');
    }
    event('module-loaded', { relative, url, sha256: setup.code[relative], sqliteConstructorsGuarded: true });
    return { format: 'module', source, shortCircuit: true };
  },
});
event('preload-ready', { role: isMainThread ? 'main' : prefixWorker ? 'prefix-worker' : 'executor-worker',
  hookHash, identityHash: setup.identityHash, codeRoot });
