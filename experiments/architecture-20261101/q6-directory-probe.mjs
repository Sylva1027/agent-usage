import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFile, link, mkdir, mkdtemp, open, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUTPUT = path.join(ROOT, 'output/architecture-20261104/q6/directory');
const BINARY = path.join(ROOT, 'output/architecture-20261104/q6/probe-build/target/debug/q6-journal-probe.exe');

async function build() {
  const directory = path.dirname(path.dirname(path.dirname(BINARY)));
  await mkdir(directory, { recursive: true });
  const original = path.join(ROOT, 'native/windows-source-proof');
  const manifest = await readFile(path.join(original, 'Cargo.toml'), 'utf8');
  const source = fileURLToPath(new URL('./q6-journal-probe.rs', import.meta.url)).replaceAll('\\', '/');
  await writeFile(path.join(directory, 'Cargo.toml'), `${manifest}\n[[bin]]\nname = "q6-journal-probe"\npath = ${JSON.stringify(source)}\n`);
  await copyFile(path.join(original, 'Cargo.lock'), path.join(directory, 'Cargo.lock'));
  execFileSync('cargo', ['build', '--offline', '--locked', '--manifest-path', path.join(directory, 'Cargo.toml')],
    { stdio: 'inherit', windowsHide: true });
}

function helper() {
  const child = spawn(BINARY, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = [];
  let errors = '';
  child.stderr.on('data', bytes => { errors = (errors + bytes).slice(-4096); });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    const row = JSON.parse(line);
    if (row.phase === 'captured-cut') { pending[0]?.onCut?.(row); return; }
    const item = pending.shift();
    if (!item) return;
    clearTimeout(item.timer);
    try { item.resolve(JSON.parse(line)); } catch (error) { item.reject(error); }
  });
  const fail = error => {
    for (const item of pending.splice(0)) { clearTimeout(item.timer); item.reject(error); }
  };
  child.on('error', fail);
  const exited = new Promise(resolve => child.on('exit', (code, signal) => {
    fail(new Error(`probe exited ${code}/${signal}: ${errors}`));
    resolve({ code, signal });
  }));
  return {
    pid: child.pid,
    call: (value, onCut) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('probe deadline')); }, 5000);
      pending.push({ resolve, reject, timer, onCut });
      child.stdin.write(`${JSON.stringify(value)}\n`);
    }),
    close: async () => { child.stdin.end(); return exited; },
    abort: async () => { child.kill('SIGKILL'); return exited; },
  };
}

function changedIds(records) { return new Set(records.map(row => row.id)); }
function containsObject(records, object) { return object.ids.some(id => changedIds(records).has(id)); }
function selfCheck() {
  assert.equal(changedIds([{ id: 'a' }, { id: 'a' }]).size, 1);
  assert.ok(!changedIds([]).has('changed-file'));
  assert.deepEqual([...changedIds([{ id: 'a' }, { id: 'b' }])], ['a', 'b']);
  assert.ok(containsObject([{ id: 'v3' }], { ids: ['v2', 'v3'] }));
  assert.ok(!containsObject([{ id: 'other' }], { ids: ['v2', 'v3'] }));
}

async function run() {
  await mkdir(OUTPUT, { recursive: true });
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'q6-directory-'));
  const managed = path.join(fixture, 'managed');
  await mkdir(managed);
  const file = path.join(managed, 'long-open.jsonl');
  const writer = await open(file, 'a+');
  const result = { fixture, startedAt: new Date().toISOString(), sourceBytes: 0, helpers: [], cases: [],
    scope: 'raw journal capability witness; oracle IDs are obtained independently, not a production change collector' };
  let bridge = helper();
  result.helpers.push({ pid: bridge.pid });
  const value = async request => {
    const response = await bridge.call(request);
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.value;
  };
  const query = () => value({ op: 'query', path: managed });
  const read = (cursor, ids) => value({ op: 'read', path: managed, start: cursor.next,
    journalId: cursor.journalId, ids });
  try {
    await writer.write('warmup\n');
    await writer.sync();
    const object = await value({ op: 'object', path: file });
    await value({ op: 'seal', path: file });
    let cursor = await query();
    const rounds = [];
    for (let index = 0; index < 20; index++) {
      const before = (await stat(file)).size;
      await writer.write(`append-${String(index).padStart(2, '0')}\n`);
      await writer.sync();
      const observed = await read(cursor, object.ids);
      const after = (await stat(file)).size;
      assert.ok(after > before);
      rounds.push({ index, before, after, expectedIds: [object.id], records: observed.records,
        targetFound: containsObject(observed.records, object), start: cursor.next, end: observed.next });
      cursor = { ...cursor, next: observed.next };
    }
    const missing = rounds.filter(round => !round.targetFound);
    const settledReads = [];
    for (const delayMs of [250, 1000]) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      const observed = await read(cursor, object.ids);
      settledReads.push({ delayMs, targetFound: containsObject(observed.records, object), records: observed.records });
      cursor = { ...cursor, next: observed.next };
    }
    result.cases.push({ name: 'twenty-appends-with-writer-already-open-and-one-initial-file-seal',
      rounds, settledReads, missed: missing.length, pass: missing.length === 0 });

    // A directory close record must not be mistaken for a barrier on child handles.
    const rootSeal = await bridge.call({ op: 'seal', path: managed });
    const rootBoundary = await query();
    await writer.write('after-root-seal\n'); await writer.sync();
    const rootObserved = await read(rootBoundary, object.ids);
    result.cases.push({ name: 'directory-seal-does-not-reset-child-write-reasons', rootSeal,
      targetFound: containsObject(rootObserved.records, object), records: rootObserved.records });

    const nativeSeal = await value({ op: 'seal', path: file });
    const sealedObserved = await read(cursor, object.ids);
    assert.ok(containsObject(sealedObserved.records, object), 'positive control: per-file seal is visible');
    result.cases.push({ name: 'per-file-seal-positive-control', pass: true, nativeSeal,
      records: sealedObserved.records });

    const resetRounds = [];
    let resetCursor = await query();
    for (let index = 0; index < 20; index++) {
      await writer.write(`after-seal-${index}\n`); await writer.sync();
      const observed = await read(resetCursor, object.ids);
      const targetFound = containsObject(observed.records, object);
      await value({ op: 'seal', path: file });
      const afterSeal = await read({ ...resetCursor, next: observed.next }, object.ids);
      resetRounds.push({ index, targetFound, records: observed.records, sealRecords: afterSeal.records });
      resetCursor = { ...resetCursor, next: afterSeal.next };
    }
    result.cases.push({ name: 'explicit-file-seal-after-each-consumed-write', rounds: resetRounds,
      missed: resetRounds.filter(round => !round.targetFound).length });

    let namespaceBoundary = await query();
    const nested = path.join(managed, 'nested'); await mkdir(nested);
    const nestedFile = path.join(nested, 'new.jsonl'); await writeFile(nestedFile, 'new\n');
    const dirObject = await value({ op: 'object', path: nested });
    const fileObject = await value({ op: 'object', path: nestedFile });
    const namespaceIds = [...dirObject.ids, ...fileObject.ids];
    let rows = await read(namespaceBoundary, namespaceIds);
    assert.ok(containsObject(rows.records, fileObject));
    const fileRecord = rows.records.find(row => fileObject.ids.includes(row.id));
    const resolved = await bridge.call({ op: 'resolve', path: managed, id: fileRecord.id });
    result.cases.push({ name: 'new-nested-file', expectedIds: namespaceIds, observed: rows, resolved });
    namespaceBoundary = { ...namespaceBoundary, next: rows.next };
    const moved = path.join(managed, 'renamed'); await rename(nested, moved);
    rows = await read(namespaceBoundary, namespaceIds);
    assert.ok(containsObject(rows.records, dirObject));
    result.cases.push({ name: 'parent-rename', expectedDirtySubtree: ['nested/new.jsonl', 'renamed/new.jsonl'],
      childHasOwnRecord: containsObject(rows.records, fileObject), observed: rows });
    namespaceBoundary = { ...namespaceBoundary, next: rows.next };
    await rename(moved, path.join(fixture, 'outside-managed'));
    rows = await read(namespaceBoundary, namespaceIds);
    assert.ok(containsObject(rows.records, dirObject));
    result.cases.push({ name: 'subtree-moved-out-of-scope', observed: rows });

    const junction = path.join(managed, 'external-junction');
    await symlink(path.join(fixture, 'outside-managed'), junction, 'junction');
    const junctionObject = await value({ op: 'object', path: junction });
    const junctionResolved = await value({ op: 'resolve', path: managed, id: junctionObject.ids[1] });
    assert.ok((junctionObject.attributes & 0x400) !== 0);
    assert.ok((junctionResolved.attributes & 0x400) !== 0);
    const alias = path.join(fixture, 'outside-alias.jsonl');
    await link(file, alias);
    const aliasObject = await value({ op: 'object', path: alias });
    assert.deepEqual(aliasObject.ids, object.ids);
    assert.equal(aliasObject.links, 2);
    result.cases.push({ name: 'reparse-and-hardlink-identity-guards-are-observable', pass: true,
      junctionObject, junctionResolved, aliasObject,
      limitation: 'guard observations only; no production auto-fallback was added' });

    const moveInStart = await query();
    await rename(path.join(fixture, 'outside-managed'), path.join(managed, 'moved-back'));
    const movedBack = await read(moveInStart, namespaceIds);
    assert.ok(containsObject(movedBack.records, dirObject));
    const movedBackPath = await value({ op: 'resolve', path: managed, id: dirObject.ids[1] });
    assert.ok(movedBackPath.path.endsWith(`${path.sep}managed${path.sep}moved-back`));
    result.cases.push({ name: 'subtree-moved-into-scope', observed: movedBack, movedBackPath,
      limitation: 'directory event requires subtree reconciliation; descendants need not emit their own records' });

    const boundary = await query();
    const gap = await bridge.call({ op: 'read', path: managed, start: '-1', journalId: boundary.journalId, ids: [] });
    const reset = await bridge.call({ op: 'read', path: managed, start: boundary.next,
      journalId: (BigInt(boundary.journalId) ^ 1n).toString(), ids: [] });
    const inactive = await bridge.call({ op: 'query', path: OUTPUT });
    assert.equal(gap.ok, false); assert.equal(reset.ok, false); assert.equal(inactive.ok, false);
    result.cases.push({ name: 'invalid-cursor-and-ID-are-controlled-not-real-journal-reconfiguration', gap, reset, inactive });

    const scanStart = await query();
    const whileScanning = path.join(managed, 'created-while-scanning.jsonl');
    const resume = path.join(fixture, 'resume-probe');
    let writeDuringScan;
    const scanning = bridge.call({ op: 'read', path: managed, start: scanStart.next,
      journalId: scanStart.journalId, ids: [], allRecords: true, pauseUntil: resume }, () => {
      writeDuringScan = (async () => { await writeFile(whileScanning, 'scan\n'); await writeFile(resume, 'resume'); })();
    });
    const firstScan = await scanning;
    await writeDuringScan;
    assert.ok(firstScan.ok);
    const duringIdentity = await value({ op: 'object', path: whileScanning });
    assert.ok(!containsObject(firstScan.value.records, duringIdentity));
    const followingScan = await read({ ...scanStart, next: firstScan.value.next }, duringIdentity.ids);
    assert.ok(containsObject(followingScan.records, duringIdentity));
    result.cases.push({ name: 'write-after-captured-cut-before-journal-read-finishes', pass: true,
      expectedPath: whileScanning, firstScanContainsFile: false, followingScanContainsFile: true });

    const replayBoundary = await query();
    await value({ op: 'seal', path: file });
    const beforeRestart = await read(replayBoundary, object.ids);
    result.helpers.at(-1).exit = await bridge.abort();
    result.helpers.at(-1).killRequested = 'SIGKILL';
    bridge = helper(); result.helpers.push({ pid: bridge.pid });
    const afterRestart = await read(replayBoundary, object.ids);
    assert.deepEqual(afterRestart.records, beforeRestart.records);
    result.cases.push({ name: 'unacknowledged-cursor-replays-after-probe-restart', pass: true,
      limitation: 'does not test a collector publication transaction; no such collector has been implemented' });

    // Acknowledge the captured cut, not the later cursor after processing its files.
    const epochStart = await query();
    await writer.write('epoch-one\n'); await writer.sync();
    const epochOne = await value({ op: 'read', path: managed, start: epochStart.next,
      journalId: epochStart.journalId, ids: [], allRecords: true });
    const latePath = path.join(managed, 'created-during-processing.jsonl');
    await writeFile(latePath, 'late\n');
    await value({ op: 'seal', path: file });
    const lateIdentity = await value({ op: 'object', path: latePath });
    const processingEnd = await query();
    result.helpers.at(-1).exit = await bridge.close();
    bridge = helper(); result.helpers.push({ pid: bridge.pid });
    const epochTwo = await value({ op: 'read', path: managed, start: epochOne.next,
      journalId: epochStart.journalId, ids: [], allRecords: true });
    const resolutions = [];
    for (const id of changedIds(epochTwo.records)) {
      const resolved = await bridge.call({ op: 'resolve', path: managed, id });
      if (resolved.ok && resolved.value.path.replace(/^\\\\\?\\/, '').startsWith(`${managed}${path.sep}`)) {
        resolutions.push({ id, path: resolved.value.path });
      }
    }
    assert.ok(containsObject(epochTwo.records, lateIdentity), 'captured cut preserves the new file across restart');
    assert.ok(resolutions.some(row => row.path.endsWith(`${path.sep}created-during-processing.jsonl`)),
      'new file is discovered without an oracle ID filter or watcher');
    const tooLate = await read(processingEnd, lateIdentity.ids);
    assert.ok(!containsObject(tooLate.records, lateIdentity), 'negative control: acknowledging the later cut loses it');
    result.cases.push({ name: 'captured-cut-replays-new-unknown-file-created-during-processing', pass: true,
      firstCut: epochOne.next, processingEnd: processingEnd.next,
      expectedPath: latePath, actualPaths: resolutions, recordsScanned: epochTwo.scannedRecords,
      laterCutWouldLoseFile: true,
      limitation: 'capability probe only; collector facts/publication atomicity remains unimplemented' });
    result.sourceBytes = (await readFile(file)).length * 2 + 20;
    assert.ok(result.sourceBytes < 1024 * 1024);
    result.completeChangeSetEstablished = false;
    result.decision = 'complete-collector-not-established; naive-delta-and-per-file-seal-control-reported-separately';
  } finally {
    await writer.close();
    result.helpers.at(-1).exit = await bridge.close();
    result.finishedAt = new Date().toISOString();
    await writeFile(path.join(OUTPUT, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(JSON.stringify({ decision: result.decision, missedAppends: result.cases[0].missed,
    missedAfterExplicitSeal: result.cases.find(row => row.name === 'explicit-file-seal-after-each-consumed-write')?.missed,
    sourceBytes: result.sourceBytes, result: path.join(OUTPUT, 'result.json'), helpersExited: result.helpers.every(row => row.exit) }));
}

export { build as buildJournalProbe, helper as openJournalProbe };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  selfCheck();
  if (!process.argv.includes('--self-check')) {
    await build();
    if (!process.argv.includes('--build-only')) await run();
  } else console.log('Directory probe self-check passed.');
}
