import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openEpochFixture } from './q6-epoch-fixture.mjs';
import { openJournalProbe } from './q6-directory-probe.mjs';

const HERE = fileURLToPath(import.meta.url);
const OUTPUT = path.resolve('output/architecture-20261104/q6-closure/concurrent');
const CLOSE = 0x80000000;
const BASE = Buffer.from('{"q6":"base"}\n');
const DELTA = Buffer.from('{"q6":"delta"}\n');
const LATE = Buffer.from('{"q6":"late"}\n');
const EDIT = Buffer.from('"EDIT"');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const text = bytes => bytes.toString('utf8');
const bytesOf = row => Buffer.from(row.payload, 'base64');
const big = value => BigInt(value);

let report;
const childProcess = createRequire(import.meta.url)('node:child_process');
const originalSpawn = childProcess.spawn;
const helperChildren = [];
childProcess.spawn = function (...args) {
  const spawned = originalSpawn.apply(this, args);
  if (/(?:windows-source-proof|q6-journal-probe)\.exe$/i.test(String(args[0]))) {
    const row = { pid: spawned.pid, exited: false };
    helperChildren.push(row);
    spawned.once('exit', () => { row.exited = true; });
  }
  return spawned;
};
syncBuiltinESMExports();

function selfCheck() {
  assert.equal(EDIT.length, 6);
  assert.equal(BASE.length, 14);
  assert.equal(text(Buffer.concat([BASE.subarray(0, 6), EDIT, BASE.subarray(12)])), '{"q6":"EDIT"}\n');
  assert.equal(sha256(BASE), sha256(Buffer.from(BASE)));
  assert.equal(parseArgs('{"phase":"beforeCommit"}').phase, 'beforeCommit');
  console.log('Concurrent probe self-check passed.');
}

function parseArgs(value) { return JSON.parse(value); }

function pass(name, expected, actual) {
  assert.ok(typeof expected === 'string' && expected.length, 'expected outcome must be explicit');
  assert.ok(actual.nativeAvailable !== false, `${name}: native proof unavailable`);
  assert.ok(actual.sourceBytes <= 1024 * 1024, `${name}: small snapshot budget exceeded`);
  report.cases.push({ name, expected, actual, passed: true, nativeAvailable: true });
  console.log(`PASS ${name}`);
  return actual;
}

async function each(name, body) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'q6-epoch-'));
  const root = path.join(fixtureRoot, 'managed');
  await mkdir(root);
  const dbPath = path.join(OUTPUT, name, 'state.sqlite');
  await mkdir(path.dirname(dbPath), { recursive: true });
  const data = { name, fixtureRoot, root, dbPath, label: path.join('concurrent', name) };
  try {
    const actual = await body(data);
    pass(name, actual.expected, actual);
  } catch (error) {
    report.cases.push({ name, expected: actualMessage(data), actual: { error: String(error?.stack || error) }, passed: false });
    throw error;
  } finally {
    const absolute = path.resolve(fixtureRoot);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
    assert.ok(path.basename(absolute).startsWith('q6-epoch-'));
    assert.equal(path.basename(root), 'managed');
    await rm(absolute, { recursive: true, force: true });
  }
}

function actualMessage(data) { return report.cases.find(row => row.name === data.name)?.expected || 'case completes'; }

async function source(data, name = 'source.jsonl', initial = BASE) {
  const file = path.join(data.root, name);
  await writeFile(file, initial);
  return file;
}

async function append(file, value = DELTA) {
  await writeFile(file, value, { flag: 'a' });
  return readFile(file);
}

async function rewriteAndRestoreMtime(file) {
  const before = await stat(file);
  const exact = await stat(file, { bigint: true });
  const handle = await open(file, 'r+');
  try {
    await handle.write(EDIT, 0, EDIT.length, 6);
    await handle.sync();
  } finally { await handle.close(); }
  const clock = openJournalProbe();
  try {
    const response = await clock.call({ op: 'restore-mtime', path: file, mtimeNs: exact.mtimeNs.toString() });
    assert.ok(response.ok, JSON.stringify(response));
  } finally { await clock.close(); }
  const after = await stat(file);
  const exactAfter = await stat(file, { bigint: true });
  const bytes = await readFile(file);
  assert.equal(after.size, before.size, 'equal-length prefix rewrite must preserve size');
  assert.equal(exactAfter.mtimeNs, exact.mtimeNs, 'mtime must be restored to the exact Windows tick');
  return { bytes, sizeBefore: before.size, sizeAfter: after.size,
    mtimeMsBefore: before.mtimeMs, mtimeMsAfter: after.mtimeMs,
    mtimeNsBefore: exact.mtimeNs.toString(), mtimeNsAfter: exactAfter.mtimeNs.toString(),
    mtimeNsDelta: (exactAfter.mtimeNs - exact.mtimeNs).toString(),
    mtimeRestoredExactly: exactAfter.mtimeNs === exact.mtimeNs,
    oldText: text(BASE), newText: text(bytes) };
}

function openPublished(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  return {
    read() {
      db.exec('BEGIN');
      try {
        const value = db.prepare('SELECT value FROM state WHERE id=1').get().value;
        const files = db.prepare('SELECT path,value FROM files ORDER BY path').all().map(row => ({ path: row.path, ...parseArgs(row.value) }));
        return { state: value ? parseArgs(value) : null, files };
      } finally { db.exec('COMMIT'); }
    },
    close: () => db.close(),
  };
}

async function openCase(data) {
  return openEpochFixture({ label: data.label, root: data.root, dbPath: data.dbPath });
}

function assertNativeRow(row, bytes, prior = null) {
  assert.ok(row?.validation?.token?.startsWith('ntfs-usn-v1:'), 'native proof token missing');
  const token = row.validation.token.split(':');
  assert.equal(row.size, bytes.length);
  assert.equal(row.digest, sha256(bytes));
  assert.equal(row.text, text(bytes));
  assert.equal(bytesOf(row).compare(bytes), 0, 'payload differs from independent source bytes');
  assert.ok(row.ids.includes(token[4]), 'token identity is not bound to the published object');
  assert.equal(big(row.seal), BigInt(`0x${token[2]}`), 'stored seal differs from token seal');
  assert.equal(row.validation.offset, bytes.length, 'token offset differs from payload size');
  assert.equal(BigInt(`0x${token[6]}`), big(bytes.length), 'encoded token offset differs from payload size');
  if (prior) {
    assert.deepEqual(row.ids, prior.ids, 'object identity changed');
    assert.equal(token[3], prior.validation.token.split(':')[3], 'volume identity changed');
    assert.equal(token[4], prior.validation.token.split(':')[4], '128-bit file identity changed');
    assert.equal(row.validation.identity, prior.validation.identity, 'exact source identity changed');
  }
}

function published(fixture, file) {
  const snapshot = fixture.snapshot();
  const row = snapshot.files.find(item => item.path === file);
  assert.ok(row, 'published row missing');
  return { snapshot, row };
}

function assertPublished(fixture, file, expectedBytes, prior = null) {
  const { snapshot, row } = published(fixture, file);
  assertNativeRow(row, expectedBytes, prior);
  return { snapshot, row };
}

async function init(fixture, hook) {
  const result = await fixture.initialize({ hook });
  assert.equal(result.completed, true);
  assert.equal(result.initialized, true);
  assert.equal(result.cut, fixture.snapshot().state.next, 'initialize must ack its captured cut');
  return result;
}

async function round(fixture, options = {}) {
  const result = await fixture.round(options);
  assert.equal(result.completed, true);
  assert.equal(result.initialized, false);
  return result;
}

function rejection(error) {
  assert.ok(error, 'expected a fail-closed rejection');
  assert.ok(error.code === 'COVERAGE_UNAVAILABLE' || error.code === 'LIVE_SOURCE_CHANGED',
    `unexpected error ${error.code}: ${error.message}`);
  return { code: error.code, message: error.message };
}

async function rejected(promise, label) {
  try { await promise; } catch (error) { return rejection(error); }
  throw new Error(`${label}: expected rejection did not occur`);
}

function bindResult(expected, details, sourceBytes) {
  return { expected, sourceBytes, nativeAvailable: true, ...details };
}

async function initializeWithHook(data, phase, mutate, expectedAssertion) {
  const file = await source(data);
  const fixture = await openCase(data);
  const external = openPublished(data.dbPath);
  let injection;
  let externalBeforeCommit;
  let cutAtStart;
  let failed;
  const seeded = external.read();
  const hook = async (where, detail) => {
    if (where === 'afterStartCut') cutAtStart = detail.start.next;
    if (where === phase && !injection) {
      injection = await mutate(file);
      if (where === 'beforeCommit') externalBeforeCommit = external.read();
    }
  };
  try {
    let result;
    try { result = await init(fixture, hook); }
    catch (error) {
      failed = rejection(error);
      const old = external.read();
      assert.deepEqual(old, seeded, 'failed initialize must leave the previous published state and files unchanged');
      result = await init(fixture);
    }
    const { snapshot, row } = published(fixture, file);
    const bytes = await readFile(file);
    assertNativeRow(row, bytesOf(row));
    assert.ok(expectedAssertion({ failed, phase, row, bytes, injection, quiet: null }),
      'published payload violates this case-specific expectation');
    const beforeQuiet = { ...fixture.work };
    const quiet = await round(fixture);
    const afterQuiet = published(fixture, file);
    assert.ok(injection, 'the requested source mutation must actually occur');
    assertNativeRow(afterQuiet.row, await readFile(file));
    if (phase === 'beforeCommit') {
      assert.deepEqual(bytesOf(row), BASE);
      assert.deepEqual(externalBeforeCommit, seeded);
    }
    return { expected: 'reject stale captures or retain later writes; the following round matches independent source bytes',
      phase, injection, failed, init: result, externalBeforeCommit, cutAtStart, seeded,
      acknowledgedCut: snapshot.state.next, sealedText: row.text, sealedDigest: row.digest,
      sealedSeal: row.seal, sealedToken: row.validation.token, sealedIds: row.ids,
      sourceBytes: bytes.length, sourceText: text(bytes), publishedText: row.text,
      publishedMatchesIndependentBytes: bytes.compare(bytesOf(row)) === 0,
      quiet, quietText: afterQuiet.row.text, quietSeal: afterQuiet.row.seal,
      reads: fixture.work.reads, seals: fixture.work.seals, workBeforeQuiet: beforeQuiet,
      workAfterQuiet: { ...fixture.work }, externalPublishedText: external.read().files[0]?.text ?? null };
  } finally { external.close(); await fixture.close(); }
}

async function continuousAfterSeal(data) {
  const file = await source(data);
  const fixture = await openCase(data);
  let writes = 0;
  let cutAtStart;
  let afterSealHooks = 0;
  const hook = async (where, detail) => {
    if (where === 'afterStartCut') cutAtStart = detail.start.next;
    if (where === 'afterSeal' && writes < 3) {
      afterSealHooks++;
      const value = Buffer.from(`{"q6":"w${writes++}"}\n`);
      await append(file, value);
    }
  };
  try {
    const result = await init(fixture, hook);
    const first = fixture.snapshot();
    const bytes = await readFile(file);
    assertNativeRow(first.files[0], Buffer.concat([BASE, Buffer.from('{"q6":"w0"}\n')]));
    assert.equal(afterSealHooks, 2, 'one initial capture and one targeted repair each trigger another write');
    assert.equal(result.cut, first.state.next);
    const afterInit = { ...fixture.work };
    const following = await round(fixture);
    const beforeQuiet = { ...fixture.work };
    const quiet = await round(fixture);
    const rounds = [following, quiet];
    assert.equal(fixture.work.reads, beforeQuiet.reads);
    assert.equal(fixture.work.seals, beforeQuiet.seals);
    const last = fixture.snapshot();
    const finalBytes = await readFile(file);
    assertNativeRow(last.files[0], finalBytes, first.files[0]);
    assert.equal(last.files[0].text, text(finalBytes));
    assert.equal(rounds.at(-1).changed, 0, 'a finite quiet round must be reached');
    return bindResult('initialize completes with B despite continuous afterSeal writes; captured cut is exact and a finite sequence of rounds reaches changed=0',
      { cutAtStart, init: result, afterSealHooks, writes, acknowledgedCut: first.state.next,
        sealedText: first.files[0].text, sealedDigest: first.files[0].digest, sealedSeal: first.files[0].seal,
        sealedToken: first.files[0].validation.token, sealedIds: first.files[0].ids,
        rounds, followupReads: fixture.work.reads - afterInit.reads, quietReadsDelta: fixture.work.reads - beforeQuiet.reads,
        sourceText: text(finalBytes), publishedText: last.files[0].text,
        publishedDigest: last.files[0].digest, publishedSeal: last.files[0].seal,
        initializationCapturedText: first.files[0].text,
        work: { ...fixture.work } }, finalBytes.length);
  } finally { await fixture.close(); }
}

async function quietCertificate(data) {
  const file = await source(data);
  const fixture = await openCase(data);
  try {
    const result = await init(fixture);
    const baseline = fixture.snapshot().files[0];
    const rounds = [];
    for (let index = 0; index < 3; index++) rounds.push(await round(fixture));
    const after = fixture.snapshot();
    const bytes = await readFile(file);
    assert.equal(rounds.every(item => item.changed === 0), true);
    assert.equal(fixture.work.reads, 1, 'quiet rounds must not reread all files');
    assert.equal(fixture.work.seals, 1, 'quiet rounds must not reseal all files');
    assertNativeRow(after.files[0], bytes, baseline);
    return bindResult('three quiet rounds have changed=0, reads=1, seals=1, and retain exact bound payload/identity/offset/seal',
      { init: result, rounds, reads: fixture.work.reads, seals: fixture.work.seals,
        coveredRecords: fixture.work.trace.length, coveredUSNs: fixture.work.trace.map(row => row.usn),
        publishedSeal: after.files[0].seal, publishedDigest: after.files[0].digest,
        publishedSize: after.files[0].size, publishedOffset: after.files[0].validation.offset,
        publishedToken: after.files[0].validation.token, publishedIds: after.files[0].ids,
        sourceText: text(bytes), publishedText: after.files[0].text }, bytes.length);
  } finally { await fixture.close(); }
}

async function closeData(data, negativeControl) {
  const file = await source(data);
  const fixture = await openCase(data);
  try {
    const result = await init(fixture);
    const expected = Buffer.concat([BASE, DELTA]);
    await append(file);
    const object = await fixture.invoke({ op: 'object', path: file });
    const journalId = fixture.snapshot().state.journalId;
    const pending = await fixture.invoke({ op: 'read', path: data.root, start: result.cut,
      journalId, ids: [], allRecords: true });
    const ownRecords = pending.records.filter(record => object.ids.includes(record.id));
    assert.ok(ownRecords.length > 0, 'positive control needs a real record for the fixture file');
    const changed = await round(fixture, { negativeControl });
    const { snapshot, row } = published(fixture, file);
    const bytes = await readFile(file);
    assert.equal(bytes.compare(expected), 0);
    if (!negativeControl) assertNativeRow(row, bytes);
    return { expected: negativeControl ? 'observe the CLOSE-drop variant without fabricating a missing write'
        : 'normal handling publishes exact independent source bytes', negativeControl, result, changed, ownRecords,
      closeWithDataRecords: ownRecords.filter(record => (record.reason & CLOSE) !== 0 && (record.reason & ~CLOSE) !== 0),
      acknowledgedCut: snapshot.state.next, sourceText: text(bytes), publishedText: row.text,
      publishedDigest: row.digest, publishedSeal: row.seal, publishedToken: row.validation.token,
      omissionObserved: changed.changed !== 1 || row.text !== text(bytes),
      sourceBytes: bytes.length, nativeAvailable: true };
  } finally { await fixture.close(); }
}

async function lateAck(data, negativeControl) {
  const file = await source(data);
  const lateFile = path.join(data.root, 'late.jsonl');
  const fixture = await openCase(data);
  let captured;
  let lateIds;
  const hook = async (where, detail) => {
    if (where !== 'afterCut') return;
    captured = detail.cut;
    await writeFile(lateFile, LATE);
    lateIds = (await fixture.invoke({ op: 'object', path: lateFile })).ids;
  };
  try {
    const result = await init(fixture);
    const changed = await round(fixture, { hook, negativeControl });
    const { snapshot } = published(fixture, file);
    const replay = await fixture.invoke({ op: 'read', path: data.root, start: snapshot.state.next,
      journalId: snapshot.state.journalId, ids: [], allRecords: true });
    const lateFound = lateIds.some(id => replay.records.some(record => record.id === id));
    const bytes = await readFile(lateFile);
    if (negativeControl) {
      assert.ok(big(snapshot.state.next) > big(captured));
      assert.equal(lateFound, false);
      assert.ok(!snapshot.files.some(row => row.path === lateFile));
    } else {
      assert.equal(snapshot.state.next, captured);
      assert.ok(lateFound);
      await rejected(round(fixture), 'new file must request reconciliation');
      await init(fixture);
      assertPublished(fixture, lateFile, bytes);
    }
    return { expected: negativeControl ? 'wrong late acknowledgement demonstrably loses the real new file'
        : 'captured cut retains the new file and reconciliation recovers exact bytes',
      negativeControl, result, changed, captured, acknowledgedCut: snapshot.state.next,
      lateIds, lateFound, replayRecordCount: replay.records.length,
      lateText: text(bytes), publishedFiles: snapshot.files.map(row => row.path),
      sourceBytes: (await readFile(file)).length + bytes.length, nativeAvailable: true };
  } finally { await fixture.close(); }
}

async function outside(data) {
  const file = await source(data);
  const outsideFile = path.join(path.dirname(data.root), 'outside.jsonl');
  await writeFile(outsideFile, Buffer.from('{"q6":"outside"}\n'));
  const fixture = await openCase(data);
  try {
    const result = await init(fixture);
    const before = fixture.snapshot();
    const quiet = await round(fixture);
    const after = fixture.snapshot();
    const bytes = await readFile(file);
    assert.equal(quiet.changed, 0);
    assert.equal(after.state.next, quiet.cut);
    assertNativeRow(after.files[0], bytes, before.files[0]);
    return bindResult('outside-root record does not dirty the managed file; quiet round keeps exact payload and advances only its captured cut',
      { result, quiet, outsideBytes: (await readFile(outsideFile)).length,
        sourceText: text(bytes), publishedText: after.files[0].text,
        publishedDigest: after.files[0].digest, publishedSeal: after.files[0].seal,
        work: { ...fixture.work } }, bytes.length + (await readFile(outsideFile)).length);
  } finally { await fixture.close(); }
}

async function hardlink(data) {
  const file = await source(data);
  const alias = path.join(path.dirname(data.root), 'alias.jsonl');
  const { link } = await import('node:fs/promises');
  const fixture = await openCase(data);
  try {
    const result = await init(fixture);
    const before = fixture.snapshot();
    await link(file, alias);
    const failed = await rejected(round(fixture), 'hardlink guard');
    const after = fixture.snapshot();
    const bytes = await readFile(file);
    assert.equal((await stat(file)).nlink, 2);
    assert.equal(after.state.next, before.state.next);
    assert.deepEqual(after.files, before.files);
    assertNativeRow(after.files[0], bytes, before.files[0]);
    return bindResult('hardlink TOPOLOGY evidence fails closed; cursor, payload and certificate remain unchanged',
      { result, failed, links: (await stat(file)).nlink, beforeCut: before.state.next,
        afterCut: after.state.next, sourceText: text(bytes), publishedText: after.files[0].text,
        publishedDigest: after.files[0].digest, publishedSeal: after.files[0].seal }, bytes.length);
  } finally { await fixture.close(); await rm(alias, { force: true }); }
}

async function child(plan) {
  const data = { root: plan.root, dbPath: plan.dbPath, label: plan.label };
  await append(plan.file, Buffer.from('{"q6":"crash"}\n'));
  const fixture = await openCase(data);
  const hook = async phase => {
    if (phase !== plan.phase) return;
    await writeFile(plan.marker, JSON.stringify({ phase, pid: process.pid,
      sourceText: text(await readFile(plan.file)),
      helperPids: helperChildren.filter(row => !row.exited).map(row => row.pid) }));
    await new Promise(resolve => setTimeout(resolve, 30000));
  };
  try { await round(fixture, { hook }); } finally { await fixture.close(); }
}

async function realKill(data, phase) {
  const file = await source(data);
  const marker = path.join(OUTPUT, 'children', `${data.name}-${phase}.marker`);
  const seed = await openCase(data);
  try { await init(seed); } finally { await seed.close(); }
  const seedReader = openPublished(data.dbPath);
  const seedState = seedReader.read(); seedReader.close();
  await rm(marker, { force: true });
  const plan = { phase, marker, root: data.root, dbPath: data.dbPath, label: data.label, file };
  const spawned = spawn(process.execPath, [HERE, '--child', JSON.stringify(plan)],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  spawned.stdout.setEncoding('utf8'); spawned.stderr.setEncoding('utf8');
  spawned.stdout.on('data', value => { stdout += value; });
  spawned.stderr.on('data', value => { stderr += value; });
  const exit = new Promise(resolve => spawned.on('exit', (code, signal) => resolve({ code, signal })));
  const dead = Date.now() + 20000;
  let markerValue;
  while (Date.now() < dead) {
    try { markerValue = parseArgs(await readFile(marker, 'utf8')); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert.ok(markerValue, `child marker missing: ${stderr || stdout}`);
  assert.equal(markerValue.pid, spawned.pid, 'marker must belong to this child');
  const before = markerValue.helperPids;
  assert.equal(before.length, 2, 'both native helpers must be running before kill');
  for (const pid of before) assert.equal(process.kill(pid, 0), true, `helper ${pid} is not running`);
  process.kill(spawned.pid, 'SIGKILL');
  const killed = await exit;
  assert.ok(killed.signal === 'SIGKILL' || (process.platform === 'win32' && killed.code === 1 && killed.signal === null),
    `unexpected child exit ${JSON.stringify(killed)}`);
  await new Promise(resolve => setTimeout(resolve, 250));
  const after = before.map(pid => {
    try { process.kill(pid, 0); return pid; } catch (error) { assert.equal(error.code, 'ESRCH'); return null; }
  }).filter(pid => pid !== null);
  const leaked = after;
  assert.deepEqual(leaked, [], 'native helpers must not outlive their parent');
  const external = openPublished(data.dbPath);
  const onDisk = external.read();
  external.close();
  const reopened = await openCase(data);
  try {
    const beforeReplay = reopened.snapshot();
    assert.equal(beforeReplay.state.root, data.root, 'reopened root binding changed');
    assertNativeRow(beforeReplay.files[0], bytesOf(beforeReplay.files[0]));
    const replay = await round(reopened);
    const afterReplay = reopened.snapshot();
    const bytes = await readFile(file);
    assertNativeRow(afterReplay.files[0], bytes, beforeReplay.files[0]);
    const quiet = await round(reopened);
    assert.equal(quiet.changed, 0, 'replay must not recount the same delta');
    assert.equal(reopened.work.seals, replay.changed, 'seals must match the actual replayed delta count');
  return { phase, marker: markerValue, killed, helperPidsBeforeKill: before,
    helperPidsAfterKill: after, leakedHelpers: leaked, seedState: seedState.state?.next ?? null,
      onDiskState: onDisk.state?.next ?? null, onDiskText: onDisk.files[0]?.text ?? null,
      reopenedBefore: { cut: beforeReplay.state.next, text: beforeReplay.files[0].text,
        seal: beforeReplay.files[0].seal, token: beforeReplay.files[0].validation.token,
        identity: beforeReplay.files[0].validation.identity }, replay,
      reopenedAfter: { cut: afterReplay.state.next, text: afterReplay.files[0].text,
        digest: afterReplay.files[0].digest, size: afterReplay.files[0].size,
        seal: afterReplay.files[0].seal, token: afterReplay.files[0].validation.token },
      quiet, sourceText: text(bytes), publishedText: afterReplay.files[0].text,
      sourceBytes: bytes.length, nativeAvailable: true, work: { ...reopened.work },
      expected: phase === 'beforeCommit'
        ? 'kill before COMMIT leaves old facts/ack together; reopened SQLite replays the exact delta once and quiet round changed=0'
        : 'kill after COMMIT leaves new facts/ack together; reopened SQLite replay changed=0 and quiet round changed=0' };
  } finally { await reopened.close(); await rm(marker, { force: true }); }
}

async function main() {
  await mkdir(path.join(OUTPUT, 'children'), { recursive: true });
  report = { startedAt: new Date().toISOString(), platform: process.platform, node: process.version,
    scope: 'small full-read snapshots; SQLite FULL transactions; no production facts or service touched', cases: [] };
  const cases = [
    ['init-continuous-afterSeal', continuousAfterSeal],
    ['afterRead-append', data => initializeWithHook(data, 'afterRead', append,
      ({ failed, row, bytes }) => Boolean(failed) && bytes.compare(bytesOf(row)) === 0)],
    ['afterSeal-append', data => initializeWithHook(data, 'afterSeal', append,
      ({ row, bytes, injection }) => bytes.compare(bytesOf(row)) === 0 && row.text === text(injection))],
    ['beforeCommit-append', data => initializeWithHook(data, 'beforeCommit', append,
      ({ row }) => row.text === text(BASE))],
    ['afterRead-prefix-EDIT-mtime', data => initializeWithHook(data, 'afterRead', rewriteAndRestoreMtime,
      ({ failed, row, bytes }) => Boolean(failed) && bytes.compare(bytesOf(row)) === 0)],
    ['afterSeal-prefix-EDIT-mtime', data => initializeWithHook(data, 'afterSeal', rewriteAndRestoreMtime,
      ({ row, bytes, injection }) => bytes.compare(bytesOf(row)) === 0 && row.text === text(injection.bytes))],
    ['beforeCommit-prefix-EDIT-mtime', data => initializeWithHook(data, 'beforeCommit', rewriteAndRestoreMtime,
      ({ row }) => row.text === text(BASE))],
    ['quiet-bound-certificate', quietCertificate],
    ['close-with-DATA-normal', data => closeData(data, null)],
    ['close-with-DATA-drop-close', data => closeData(data, 'drop-close')],
    ['late-ack-normal', data => lateAck(data, null)],
    ['late-ack-negative', data => lateAck(data, 'late-ack')],
    ['outside-root-record', outside],
    ['hardlink-guard', hardlink],
    ['beforeCommit-SIGKILL', data => realKill(data, 'beforeCommit')],
    ['afterCommit-SIGKILL', data => realKill(data, 'afterCommit')],
  ];
  let completed = 0;
  for (const [name, body] of cases) {
    try { await each(name, body); completed++; }
    catch (error) {
      report.error = { case: name, message: String(error?.stack || error) };
      break;
    }
  }
  report.completed = completed;
  report.total = cases.length;
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(OUTPUT, 'result.json'), `${JSON.stringify({ ...report, cases: report.cases.map(({ actual, ...rest }) => ({ ...rest, observation: actual })) }, null, 2)}\n`);
  console.log(JSON.stringify({ completed, total: cases.length, result: path.join(OUTPUT, 'result.json'), error: report.error?.message || null }));
  if (report.error) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === HERE) {
  if (process.argv.includes('--self-check')) selfCheck();
  else if (process.argv.includes('--child')) await child(parseArgs(process.argv[process.argv.indexOf('--child') + 1]));
  else await main();
}
