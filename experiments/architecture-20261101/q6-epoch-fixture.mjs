import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UsageSourceProof } from '../../src/usage-source-proof.js';
import { openJournalProbe } from './q6-directory-probe.mjs';

const CLOSE = 0x80000000;
const TOPOLOGY = 0x100 | 0x200 | 0x1000 | 0x2000 | 0x10000 | 0x100000;
const MAX_BYTES = 1024 * 1024;
const normal = value => path.resolve(value.replace(/^\\\\\?\\/, '')).toLowerCase();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Small experimental snapshots, not a production history importer. */
export async function openEpochFixture({ label = 'case', root, dbPath } = {}) {
  root ||= path.join(await mkdtemp(path.join(os.tmpdir(), 'q6-epoch-')), 'managed');
  root = path.resolve(root);
  assert.equal(path.basename(root), 'managed');
  const scope = path.relative(path.resolve(os.tmpdir()), root).split(path.sep);
  assert.ok(scope[0].startsWith('q6-epoch-') && !scope.includes('..') && !path.isAbsolute(scope[0]));
  await mkdir(root, { recursive: true });
  dbPath ||= path.resolve(`output/architecture-20261104/q6-closure/${label}/state.sqlite`);
  dbPath = path.resolve(dbPath);
  assert.ok(dbPath.startsWith(`${path.resolve('output/architecture-20261104/q6-closure')}${path.sep}`));
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT);
    INSERT OR IGNORE INTO state VALUES(1,NULL);
    CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  const journal = openJournalProbe();
  const proof = new UsageSourceProof();
  const work = { reads: 0, seals: 0, committed: 0, trace: [] };
  const invoke = async request => {
    const response = await journal.call(request);
    if (!response.ok) throw Object.assign(new Error(response.error), { code: 'COVERAGE_UNAVAILABLE' });
    return response.value;
  };
  const query = () => invoke({ op: 'query', path: root });
  const hookCall = async (hook, phase, detail = {}) => { await hook?.(phase, { root, dbPath, ...detail }); };
  const snapshot = () => {
    if (db.isTransaction) throw fail('writer transaction cannot serve a published snapshot');
    db.exec('SAVEPOINT epoch_read');
    try {
      return { state: JSON.parse(db.prepare('SELECT value FROM state WHERE id=1').get().value || 'null'),
        files: db.prepare('SELECT path,value FROM files ORDER BY path').all().map(stored => {
          const row = JSON.parse(stored.value);
          const bytes = Buffer.from(row.payload, 'base64');
          const token = row.validation.token.split(':');
          assert.equal(bytes.length, row.size); assert.equal(digest(bytes), row.digest);
          assert.ok(row.ids.includes(token[4]));
          assert.equal(BigInt(row.seal), BigInt(`0x${token[2]}`));
          assert.equal(row.validation.offset, row.size);
          return { path: stored.path, ...row };
        }) };
    } finally { db.exec('RELEASE epoch_read'); }
  };
  const readInterval = async cursor => invoke({ op: 'read', path: root,
    start: cursor.next, journalId: cursor.journalId, ids: [], allRecords: true });
  const within = candidate => normal(candidate) === normal(root) || normal(candidate).startsWith(`${normal(root)}${path.sep}`);
  const fail = reason => Object.assign(new Error(reason), { code: 'COVERAGE_UNAVAILABLE' });

  async function capture(file, hook) {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_BYTES || info.nlink !== 1) throw fail('unsupported source identity or size');
    const fence = await proof.begin(file, info);
    if (!fence) throw fail('native source boundary unavailable');
    await hookCall(hook, 'beforeRead', { file });
    const bytes = await readFile(file); work.reads++;
    assert.equal(bytes.length, info.size);
    await hookCall(hook, 'afterRead', { file, bytes: Buffer.from(bytes) });
    const captured = await proof.capture(file, info.size, info, fence);
    if (!captured.validation.token) throw fail('native source boundary missing');
    work.seals++;
    const object = await invoke({ op: 'object', path: file });
    const token = captured.validation.token.split(':');
    if (!object.ids.includes(token[4]) || object.links !== 1 || (object.attributes & 0x400)) throw fail('source rebound');
    const row = { ids: object.ids, seal: BigInt(`0x${token[2]}`).toString(), size: bytes.length,
      digest: digest(bytes), payload: bytes.toString('base64'), text: bytes.toString('utf8'), validation: captured.validation };
    await hookCall(hook, 'afterSeal', { file, row });
    return row;
  }

  async function refresh(file, previous, hook) {
    const row = await capture(file, hook);
    if (row.ids[1] !== previous.ids[1]) throw fail('source identity changed during a targeted repair');
    return row;
  }

  async function enumerate() {
    const files = [], directories = [];
    async function visit(directory) {
      const object = await invoke({ op: 'object', path: directory });
      if (object.attributes & 0x400) throw fail('reparse directory');
      directories.push({ path: directory, ids: object.ids });
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw fail('reparse entry');
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile()) files.push(file);
        else throw fail('unknown directory entry');
      }
    }
    await visit(root);
    return { files: files.sort(), directories };
  }

  async function classify(records, files, directories, { acceptCovered = true, dropClose = false } = {}) {
    const byId = new Map();
    for (const [file, row] of files) for (const id of row.ids) byId.set(id, { file, row });
    const directoryIds = new Set(directories.flatMap(row => row.ids));
    const dirty = new Set();
    for (const record of records) {
      if (dropClose && (record.reason & CLOSE)) continue; // Deliberately unsafe negative control.
      const known = byId.get(record.id);
      if (known && (record.reason & TOPOLOGY)) throw fail('namespace evidence is not certified by a content boundary');
      if (acceptCovered && known && BigInt(record.usn) <= BigInt(known.row.seal)) {
        work.trace.push({ kind: 'covered-record', id: record.id, usn: record.usn, seal: known.row.seal });
        continue;
      }
      if (record.reason === CLOSE) continue;
      if (known) {
        dirty.add(known.file); continue;
      }
      if (directoryIds.has(record.id) || directoryIds.has(record.parent)) throw fail('managed directory changed');
      const resolved = await journal.call({ op: 'resolve', path: root, id: record.id });
      if (record.reason & 0x10000) throw fail('ambiguous hardlink change');
      if (resolved.ok) {
        if (within(resolved.value.path) || resolved.value.links > 1 || (resolved.value.attributes & 0x400))
          throw fail('unknown or ambiguous object');
      } else {
        const parent = await journal.call({ op: 'resolve', path: root, id: record.parent });
        if (!parent.ok || within(parent.value.path) || (parent.value.attributes & 0x400))
          throw fail('unknown or ambiguous parent');
      }
    }
    return [...dirty].sort();
  }

  async function commit(state, files, hook) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM files');
      const insert = db.prepare('INSERT INTO files VALUES(?,?)');
      let total = 0;
      for (const [file, row] of files) { total += row.size; insert.run(file, JSON.stringify(row)); }
      assert.ok(total <= MAX_BYTES, 'this fixture only permits small snapshot transactions');
      db.prepare('UPDATE state SET value=? WHERE id=1').run(JSON.stringify(state));
      await hookCall(hook, 'beforeCommit', { state });
      db.exec('COMMIT'); work.committed++;
      await hookCall(hook, 'afterCommit', { state });
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  }

  async function initialize({ hook } = {}) {
    const start = await query();
    await hookCall(hook, 'afterStartCut', { start });
    const listing = await enumerate();
    await hookCall(hook, 'afterEnumerate', { listing });
    const files = new Map();
    let total = 0;
    for (const file of listing.files) {
      const row = await capture(file, hook);
      total += row.size;
      if (total > MAX_BYTES) throw fail('small fixture byte budget exceeded');
      files.set(file, row);
    }
    const interval = await readInterval(start);
    const dirty = await classify(interval.records, files, listing.directories);
    // Repair to the already captured cut; later writes remain replayable, without waiting for global quiet.
    for (const file of dirty) files.set(file, await refresh(file, files.get(file), hook));
    const state = { format: 1, root, journalId: start.journalId, next: interval.next, directories: listing.directories };
    await hookCall(hook, 'afterValidation', { state });
    await commit(state, files, hook);
    return { completed: true, initialized: true, changed: files.size, cut: state.next };
  }

  async function round({ hook, negativeControl = null } = {}) {
    const previous = snapshot();
    if (!previous.state) throw fail('initialization incomplete');
    if (previous.state.root !== root) throw fail('source root binding changed');
    const interval = await readInterval(previous.state);
    await hookCall(hook, 'afterCut', { cut: interval.next });
    const files = new Map(previous.files.map(({ path: file, ...row }) => [file, row]));
    const dirty = await classify(interval.records, files, previous.state.directories,
      { dropClose: negativeControl === 'drop-close' });
    await hookCall(hook, 'afterClassify', { dirty });
    for (const file of dirty) files.set(file, await refresh(file, files.get(file), hook));
    const next = negativeControl === 'late-ack' ? (await query()).next : interval.next;
    const state = { ...previous.state, next };
    await commit(state, files, hook);
    return { completed: true, initialized: false, changed: dirty.length, cut: next };
  }

  return { root, dbPath, journal, proof, work, invoke, query, initialize, round, snapshot,
    close: async () => { proof.close(); db.close(); return journal.close(); } };
}
