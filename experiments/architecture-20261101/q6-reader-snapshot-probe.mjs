import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openEpochFixture } from './q6-epoch-fixture.mjs';

const script = fileURLToPath(import.meta.url);
if (process.argv[2] === '--child') {
  const [root, dbPath, file] = process.argv.slice(3);
  const h = await openEpochFixture({ root, dbPath });
  try {
    await appendFile(file, 'second\n');
    const result = await h.round();
    assert.equal(result.changed, 1);
    console.log(JSON.stringify(result));
  } finally { await h.close(); }
} else {
  const h = await openEpochFixture({ label: 'reader-snapshot' });
  const original = DatabaseSync.prototype.prepare;
  const result = { root: h.root, dbPath: h.dbPath, journalPid: h.journal.pid };
  let armed = false;
  try {
    const file = path.join(h.root, 'source.jsonl');
    await writeFile(file, 'first\n');
    await h.initialize();
    const before = h.snapshot();
    DatabaseSync.prototype.prepare = function (sql) {
      const statement = original.call(this, sql);
      if (!armed || sql !== 'SELECT value FROM state WHERE id=1') return statement;
      return { get(...args) {
        const row = statement.get(...args);
        armed = false;
        const output = execFileSync(process.execPath, [script, '--child', h.root, h.dbPath, file],
          { encoding: 'utf8', windowsHide: true, timeout: 15000 });
        result.child = JSON.parse(output);
        return row;
      } };
    };
    armed = true;
    const overlapping = h.snapshot();
    DatabaseSync.prototype.prepare = original;
    const after = h.snapshot();
    assert.deepEqual(overlapping, before, 'read transaction must keep both files and cursor from the old version');
    assert.equal(after.files[0].text, 'first\nsecond\n');
    assert.ok(BigInt(after.state.next) > BigInt(before.state.next));
    assert.notEqual(after.files[0].digest, before.files[0].digest);
    const quiet = await h.round();
    assert.equal(quiet.changed, 0);
    Object.assign(result, { passed: true, sourceBytes: 13, oldCut: before.state.next,
      overlappingCut: overlapping.state.next, newCut: after.state.next,
      overlappingText: overlapping.files[0].text, newText: after.files[0].text, quiet });
    console.log('Concurrent commit preserved the complete old read snapshot; the following read saw the complete new version.');
  } finally {
    DatabaseSync.prototype.prepare = original;
    result.exit = await h.close();
    await writeFile('output/architecture-20261104/q6-closure/reader-snapshot/result.json', `${JSON.stringify(result, null, 2)}\n`);
  }
}
