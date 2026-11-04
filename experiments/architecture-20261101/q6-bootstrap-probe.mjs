import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const PROJECT = fileURLToPath(new URL('../../', import.meta.url));
const OUTPUT = path.join(PROJECT, 'output/architecture-20261104/q6-closure/bootstrap');
const NATIVE = 'ntfs-usn-v1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const rel = (root, file) => path.relative(root, file).replaceAll('\\', '/');
const short = value => value ? `${value.code || value.name}: ${value.message}` : null;

// Wrap child_process.spawn before dynamic imports so both native helpers are tracked.
const childProcess = createRequire(import.meta.url)('node:child_process');
const originalSpawn = childProcess.spawn;
const trackedHelpers = [];
childProcess.spawn = function (...args) {
  const child = originalSpawn.apply(this, args);
  const row = { pid: child.pid, command: String(args[0]), exit: null };
  trackedHelpers.push(row);
  child.on('exit', (code, signal) => { row.exit = { code, signal }; });
  return child;
};
syncBuiltinESMExports();
const { openEpochFixture } = await import('./q6-epoch-fixture.mjs');

let registry = [];
const tempRoots = [];
async function trackedFixture(options) {
  const fixture = await openEpochFixture(options);
  registry.push({ fixture, closed: false });
  return fixture;
}
async function closeFixture(fixture) {
  const row = registry.find(entry => entry.fixture === fixture);
  if (!row || row.closed) return;
  row.closed = true;
  row.closeResult = await settle(() => fixture.close());
}

function selfCheck() {
  assert.equal(rel('C:\\x\\managed', 'C:\\x\\managed\\a\\b'), 'a/b');
  assert.equal(sha(Buffer.from('abc')), sha(Buffer.from('abc')));
  assert.notEqual(sha(Buffer.from('abc')), sha(Buffer.from('abd')));
  assert.deepEqual([{ path: 'b', text: '2' }, { path: 'a', text: '1' }]
    .sort((a, b) => a.path.localeCompare(b.path)).map(row => row.path), ['a', 'b']);
  const boundary = path.resolve(os.tmpdir(), 'q6-epoch-temp-abcdef', 'managed');
  const temp = path.dirname(boundary);
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temp).startsWith('q6-epoch-temp-'));
  assert.equal(path.basename(boundary), 'managed');
  assert.equal(path.resolve('a', '..', 'b'), path.resolve('b'));
  console.log('Bootstrap probe self-check passed.');
}

async function independentFs(root) {
  const files = {}, directories = [];
  async function visit(directory) {
    const info = await lstat(directory);
    if (info.isSymbolicLink()) throw new Error(`junction not expected in oracle: ${directory}`);
    directories.push(rel(root, directory));
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) {
        const bytes = await readFile(candidate);
        files[rel(root, candidate)] = { text: bytes.toString('utf8'), digest: sha(bytes), size: bytes.length };
      } else throw new Error(`unexpected entry: ${candidate}`);
    }
  }
  await visit(root);
  return { files, directories: directories.sort() };
}

function published(snapshot) {
  assert.ok(snapshot.state, 'published snapshot requires committed state');
  return {
    state: { format: snapshot.state.format, root: snapshot.state.root, next: snapshot.state.next,
      directories: snapshot.state.directories.map(row => rel(snapshot.state.root, row.path)).sort() },
    files: Object.fromEntries(snapshot.files.map(row => {
      const payload = Buffer.from(row.payload, 'base64');
      assert.equal(payload.length, row.size);
      assert.equal(sha(payload), row.digest);
      assert.equal(payload.toString('utf8'), row.text);
      assert.equal(row.validation?.kind, NATIVE, 'native source proof must be present');
      assert.equal(row.validation.offset, row.size);
      assert.equal(BigInt(row.seal), BigInt(`0x${row.validation.token.split(':')[2]}`));
      assert.ok(row.ids.includes(row.validation.token.split(':')[4]));
      return [rel(snapshot.state.root, row.path), { text: row.text, digest: row.digest, size: row.size }];
    })),
  };
}

function externalState(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('BEGIN');
    return { state: JSON.parse(db.prepare('SELECT value FROM state WHERE id=1').get()?.value || 'null'),
      rows: db.prepare('SELECT path,value FROM files ORDER BY path').all().length };
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
}

function assertPublished(actual, expected, message) {
  assert.ok(actual.state, `${message}: no published state`);
  assert.deepEqual(actual.files, expected.files, `${message}: path/text oracle mismatch`);
  assert.deepEqual(actual.state.directories, expected.directories, `${message}: directory path oracle mismatch`);
}

async function settle(run) {
  try { return { value: await run(), error: null }; }
  catch (error) { return { value: null, error }; }
}

async function rootFor() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'q6-epoch-temp-'));
  tempRoots.push(path.resolve(temp));
  const root = path.join(temp, 'managed');
  await mkdir(root, { recursive: true });
  return root;
}

async function seed(root) {
  await mkdir(path.join(root, 'codex', 'deep', 'empty'), { recursive: true });
  await mkdir(path.join(root, 'dsh', 'nested'), { recursive: true });
  await mkdir(path.join(root, 'empty-source'), { recursive: true });
  await writeFile(path.join(root, 'codex', 'one.jsonl'), '{"i":1}\n');
  await writeFile(path.join(root, 'codex', 'deep', 'two.jsonl'), '{"i":2}\n');
  await writeFile(path.join(root, 'dsh', 'nested', 'frame.dsh'), 'FRAME-A\n');
  await stat(path.join(root, 'codex', 'deep', 'empty'));
}

async function newFixture(label, options = {}) {
  const root = await rootFor();
  if (options.seed !== false) await seed(root);
  const dbPath = path.join(OUTPUT, label, `state-${Math.random().toString(36).slice(2, 9)}.sqlite`);
  const fixture = await trackedFixture({ label, root, dbPath });
  return { root, dbPath, fixture };
}

function nativeEvidence(fixture) {
  return { reads: fixture.work.reads, seals: fixture.work.seals, committed: fixture.work.committed,
    nativeProofs: fixture.snapshot().files.filter(row => row.validation?.kind === NATIVE).length };
}

async function caseStable(label, temp) {
  const { root, dbPath, fixture } = await newFixture(label);
  const operations = ['mkdir two sources, one nested deep directory and two empty directories',
    'write three small UTF-8 source files', 'one initialize attempt'];
  const expected = { ...await independentFs(root), operations };
  const external = [];
  const init = await fixture.initialize({ hook: async (phase, detail) => {
    if (phase === 'beforeCommit') external.push(externalState(detail.dbPath));
    if (phase === 'afterCommit') external.push(externalState(detail.dbPath));
  } });
  assert.equal(external[0].state, null, 'external connection must see the old state before commit');
  assert.ok(external[1].state, 'external connection must see the new state after commit');
  assert.equal(external[0].rows, 0);
  const actual = { ...published(fixture.snapshot()), operations: [],
    native: nativeEvidence(fixture), init, externalBeforeCommit: external[0] };
  assert.equal(init.completed, true);
  assert.equal(actual.native.nativeProofs, Object.keys(expected.files).length);
  assert.equal(actual.native.seals, Object.keys(expected.files).length);
  assertPublished(actual, expected, label);
  return { name: label, operations, expected, actual, pass: true };
}

async function caseNewAfterEnumerate(label, temp, directory) {
  const { root, fixture } = await newFixture(label);
  const lateFile = path.join(root, 'codex', ...(directory ? ['newdir', 'late.jsonl'] : ['late.jsonl']));
  const lateText = '{"late":true}\n';
  const first = await settle(() => fixture.initialize({ hook: async (phase, detail) => {
    if (phase !== 'afterEnumerate') return;
    if (directory) await mkdir(path.dirname(lateFile), { recursive: true });
    await writeFile(lateFile, lateText);
  } }));
  assert.ok(first.error, 'new object after enumerate must not publish a partial listing');
  const failedSnapshot = fixture.snapshot();
  assert.equal(failedSnapshot.state, null);
  assert.equal(failedSnapshot.files.length, 0);
  const expected = { ...await independentFs(root), operations: [
    directory ? 'afterEnumerate: create nested directory and file' : 'afterEnumerate: create a new file',
    'first explicit attempt rejects; retry uses the same root and database'] };
  const second = await fixture.initialize();
  const actual = { ...published(fixture.snapshot()), firstError: short(first.error),
    firstStateIsNull: failedSnapshot.state === null, retry: second, native: nativeEvidence(fixture) };
  assert.equal(actual.native.nativeProofs, Object.keys(expected.files).length);
  assertPublished(actual, expected, label);
  return { name: label, operations: expected.operations, expected, actual, pass: true };
}

async function caseAfterSealContinual(label, temp) {
  const { root, fixture } = await newFixture(label);
  let writes = 0;
  const hook = async (phase, detail) => {
    if (phase !== 'afterSeal') return;
    writes++;
    const handle = await open(detail.file, 'a');
    try { await handle.write(`late-${writes}\n`); await handle.sync(); } finally { await handle.close(); }
  };
  const init = await fixture.initialize({ hook });
  const initial = published(fixture.snapshot());
  const filesystem = await independentFs(root);
  const stale = Object.keys(initial.files).filter(file => initial.files[file].text !== filesystem.files[file].text);
  assert.ok(stale.length > 0, 'afterSeal writes must remain outside the finite initialization cut');
  const beforeRound = { ...fixture.work };
  const firstRound = await fixture.round();
  const afterFirst = published(fixture.snapshot());
  const stillStale = Object.keys(afterFirst.files).filter(file => afterFirst.files[file].text !== filesystem.files[file].text);
  const recoveryRounds = [firstRound];
  let current = afterFirst;
  while (!Object.keys(current.files).every(file => current.files[file].text === filesystem.files[file].text)) {
    const round = await fixture.round();
    recoveryRounds.push(round);
    current = published(fixture.snapshot());
    if (recoveryRounds.length > 4) break;
  }
  const final = current;
  assert.deepEqual(final.files, filesystem.files, 'next rounds must replay exact latest bytes');
  const roundReads = fixture.work.reads - beforeRound.reads;
  const roundSeals = fixture.work.seals - beforeRound.seals;
  assert.ok(roundReads <= Object.keys(filesystem.files).length * 2,
    'rounds must not repeatedly full-read the directory');
  return { name: label, operations: [`afterSeal append once for each of ${writes} captured files`,
    'initialize finite cut', `${recoveryRounds.length} quiet round(s)`],
    expected: { files: filesystem.files, directories: filesystem.directories,
      staleAfterInit: stale, staleAfterFirstRound: stillStale, replayedExactly: true },
    actual: { initial, final, init, rounds: recoveryRounds, roundReads, roundSeals,
      work: { ...fixture.work }, native: nativeEvidence(fixture) },
    pass: true };
}

async function caseRename(label, temp, caseOnly) {
  const { root, fixture } = await newFixture(label);
  const oldDir = path.join(root, 'codex', 'nested');
  const newDir = caseOnly ? path.join(root, 'codex', 'NESTED') : path.join(root, 'codex', 'renamed');
  await mkdir(oldDir);
  await writeFile(path.join(oldDir, 'alpha.jsonl'), 'alpha\n');
  let firstError;
  const first = await settle(() => fixture.initialize({ hook: async phase => {
    if (phase === 'afterEnumerate') await rename(oldDir, newDir);
  } }));
  firstError = short(first.error);
  assert.ok(first.error, 'directory rename during initialization must not publish a partial listing');
  assert.equal(fixture.snapshot().state, null);
  const retry = await fixture.initialize();
  const expected = await independentFs(root);
  const actual = { ...published(fixture.snapshot()), firstError, retry,
    native: nativeEvidence(fixture) };
  assertPublished(actual, expected, label);
  assert.equal(actual.native.nativeProofs, Object.keys(expected.files).length);
  return { name: label, operations: [`afterEnumerate rename codex/nested to ${path.basename(newDir)}`,
    'first attempt rejects; explicit fresh initialize re-enumerates actual names'], expected, actual, pass: true };
}

async function caseFreshFailure(label, temp) {
  const { root, dbPath, fixture } = await newFixture(label);
  const first = await settle(() => fixture.initialize({ hook: async phase => {
    if (phase === 'afterEnumerate') await writeFile(path.join(root, 'codex', 'late.jsonl'), 'late\n');
  } }));
  const before = fixture.snapshot();
  await closeFixture(fixture);
  const reopened = await trackedFixture({ label, root, dbPath });
  const after = reopened.snapshot();
  assert.equal(before.state, null);
  assert.equal(after.state, null);
  assert.equal(after.files.length, 0);
  return { name: label, operations: ['fail first initialize afterEnumerate', 'close and reopen same fixture'],
    expected: { firstError: true, stateBeforeClose: null, stateAfterReopen: null, publishedFiles: 0 },
    actual: { firstError: short(first.error), stateBeforeClose: before.state,
      stateAfterReopen: after.state, publishedFiles: after.files.length }, pass: true };
}

async function caseOpenWriter(label) {
  const { root, fixture } = await newFixture(label, { seed: false });
  const file = path.join(root, 'open.jsonl');
  const writer = await open(file, 'a+');
  const attempts = [];
  let expected = 'before-init\n';
  try {
    await writer.write(expected); await writer.sync();
    for (let index = 0; index < 3; index++) {
      const attempt = await settle(() => fixture.initialize());
      attempts.push({ completed: Boolean(attempt.value), error: short(attempt.error) });
      if (attempt.value) break;
      assert.equal(attempt.error.code, 'COVERAGE_UNAVAILABLE');
      assert.equal(fixture.snapshot().state, null);
    }
    assert.ok(attempts.at(-1).completed, 'an already-open writer must not prevent bounded initialization');
    for (let index = 0; index < 20; index++) {
      const line = `open-${index}\n`; expected += line;
      await writer.write(line); await writer.sync();
      const round = await fixture.round();
      assert.equal(round.changed, 1);
      assert.equal(fixture.snapshot().files[0].text, expected);
      assert.equal((await readFile(file, 'utf8')), expected);
    }
    const oracle = await independentFs(root);
    const actual = published(fixture.snapshot());
    assertPublished(actual, oracle, label);
    return { name: label, pass: true, expected: oracle,
      actual: { ...actual, attempts, rounds: 20, writerOpenedBeforeInitialization: true } };
  } finally { await writer.close(); }
}

async function caseFileCaseRename(label) {
  const { root, fixture } = await newFixture(label);
  const before = path.join(root, 'codex', 'one.jsonl');
  const after = path.join(root, 'codex', 'ONE.JSONL');
  const attempt = await settle(() => fixture.initialize({ hook: async phase => {
    if (phase === 'afterEnumerate') await rename(before, after);
  } }));
  assert.equal(attempt.error?.code, 'COVERAGE_UNAVAILABLE');
  assert.match(attempt.error.message, /namespace evidence/);
  assert.equal(fixture.snapshot().state, null);
  await fixture.initialize();
  const expected = await independentFs(root);
  const actual = published(fixture.snapshot());
  assert.ok(Object.hasOwn(actual.files, 'codex/ONE.JSONL'));
  assertPublished(actual, expected, label);
  return { name: label, pass: true, expected, actual, firstError: short(attempt.error) };
}

async function casePublishedFailure(label, temp) {
  const { root, dbPath, fixture } = await newFixture(label);
  await fixture.initialize();
  const beforeRaw = fixture.snapshot();
  const before = published(beforeRaw);
  const oldNext = fixture.snapshot().state.next;
  const outside = path.join(path.dirname(root), 'outside');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'outside.txt'), 'outside\n');
  const junction = path.join(root, 'codex', 'junction');
  const junctionAttempt = await settle(async () => {
    await symlink(outside, junction, 'junction');
    return (await lstat(junction)).isSymbolicLink();
  });
  let junctionFailure = null;
  if (junctionAttempt.value) {
    const attempt = await settle(() => fixture.initialize());
    junctionFailure = short(attempt.error);
    await unlink(junction);
    assert.ok(junctionFailure, 'reparse directory must not be silently skipped');
  }
  const alias = path.join(root, 'codex', 'alias.jsonl');
  await link(path.join(root, 'codex', 'one.jsonl'), alias);
  const beforeCommit = [];
  let failed;
  try {
    await fixture.initialize({ hook: async (phase, detail) => {
      if (phase === 'beforeCommit') beforeCommit.push(externalState(detail.dbPath));
    } });
  } catch (error) { failed = short(error); }
  assert.ok(failed, 'hardlink alias must cause a conservative initialization failure');
  await unlink(alias);
  const after = published(fixture.snapshot());
  assert.deepEqual(after, before);
  assert.equal(after.state.next, oldNext);
  assert.equal(beforeCommit.length, 0, 'no external pre-commit write should have occurred');
  assert.deepEqual(externalState(dbPath).state, fixture.snapshot().state);
  const externalDuringCommit = [];
  const retries = [];
  let recovered = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await settle(() => fixture.initialize({ hook: async (phase, detail) => {
      if (phase === 'beforeCommit') externalDuringCommit.push(externalState(detail.dbPath));
    } }));
    retries.push({ attempt, result: result.value, error: short(result.error) });
    if (result.value) { recovered = result.value; break; }
  }
  assert.ok(recovered, 'explicit retries must eventually publish after alias removal');
  assert.deepEqual(externalDuringCommit.at(0).state, beforeRaw.state,
    'external connection must observe the prior committed state during beforeCommit');
  assert.ok(externalDuringCommit.at(0).rows > 0);
  const final = published(fixture.snapshot());
  assert.deepEqual(final.files, (await independentFs(root)).files);
  return { name: label, operations: ['publish one complete version', 'create junction and hardlink alias',
    'initialization attempts must conservatively reject', 'remove junction and alias separately',
    'explicit retries and external independent connection during beforeCommit'],
    expected: { publishedUnchangedBeforeRecovery: before, stateNext: oldNext, externalPreCommit: [] },
    actual: { junctionCreated: junctionAttempt.value || false, junctionError: short(junctionAttempt.error),
      junctionFailure, publishedAfterFailure: after, stateNext: after.state.next, failure: failed,
      externalPreCommit: beforeCommit, externalAfter: externalState(dbPath).state,
      retries, externalDuringCommit, recovered, final: final.files }, pass: true };
}

async function run() {
  await mkdir(OUTPUT, { recursive: true });
  const result = { startedAt: new Date().toISOString(), scope: 'ten small full-read initialization cases; no product collector',
    helpers: [], cases: [], cleanup: null };
  const cases = [
    ['stable-multilayer-two-sources-empty-dirs', caseStable],
    ['after-enumerate-new-file', (label, root) => caseNewAfterEnumerate(label, root, false)],
    ['after-enumerate-new-nested-dir', (label, root) => caseNewAfterEnumerate(label, root, true)],
    ['after-seal-continual-writes', caseAfterSealContinual],
    ['parent-rename', (label, root) => caseRename(label, root, false)],
    ['case-only-rename', (label, root) => caseRename(label, root, true)],
    ['fresh-init-failure-reopen', caseFreshFailure],
    ['published-init-failure-preserves-old', casePublishedFailure],
    ['writer-already-open-at-bootstrap', caseOpenWriter],
    ['file-case-rename-not-covered-by-content-seal', caseFileCaseRename],
  ];
  try {
    for (const [label, test] of cases) {
      const start = Date.now();
      let entry;
      try { entry = await test(label); }
      catch (error) { entry = { name: label, pass: false, error: short(error), stack: error?.stack }; }
      entry.ms = Date.now() - start;
      result.cases.push(entry);
      console.log(JSON.stringify({ case: label, pass: entry.pass, error: entry.error || null }));
    }
  } finally {
    for (const row of registry) {
      if (row.closed) continue;
      row.closed = true;
      row.closeResult = await settle(() => row.fixture.close());
    }
    result.helpers = trackedHelpers.map(row => ({ ...row }));
    result.finishedAt = new Date().toISOString();
    const junctions = [];
    async function collect(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) junctions.push(candidate);
        else if (entry.isDirectory()) await collect(candidate);
      }
    }
    const cleanup = [];
    for (const resolved of tempRoots) {
      const expectedParent = path.resolve(os.tmpdir());
      assert.equal(path.dirname(path.resolve(resolved)), expectedParent, 'cleanup outside os.tmpdir');
      assert.ok(path.basename(path.resolve(resolved)).startsWith('q6-epoch-temp-'), 'cleanup outside owned prefix');
      await collect(resolved);
      cleanup.push({ absolute: path.resolve(resolved), parent: expectedParent });
    }
    for (const junction of junctions) {
      assert.equal((await lstat(junction)).isSymbolicLink(), true);
      await unlink(junction);
    }
    for (const row of cleanup) await rm(row.absolute, { recursive: true, force: true });
    result.cleanup = { prefix: 'q6-epoch-temp-', roots: cleanup.map(row => row.absolute),
      junctionsRemoved: junctions.length, removed: true };
    result.summary = { passed: result.cases.filter(row => row.pass).length,
      failed: result.cases.filter(row => !row.pass).length,
      helpersExited: result.helpers.every(row => row.exit),
      fixtureCloses: registry.map(row => ({ closed: row.closed, error: short(row.closeResult?.error) })) };
    await writeFile(path.join(OUTPUT, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(JSON.stringify({ result: path.join(OUTPUT, 'result.json'), ...result.summary }));
  if (result.summary.failed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selfCheck();
  if (!process.argv.includes('--self-check')) await run();
}
