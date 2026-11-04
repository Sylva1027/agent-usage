import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
test('SQL probe records an expensive executed read and preserves result', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'startup-sql-'));
  try {
    const result = execFileSync(process.execPath, ['--import', './experiments/architecture-20261101/startup-sql-probe.mjs', '--input-type=module', '-e', `import{DatabaseSync}from'node:sqlite';JSON.parse('{"x":1}');const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE t(x)');db.prepare('INSERT INTO t VALUES (?)').run(1);console.log(db.prepare('WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<1000000) SELECT sum(n) AS total FROM x').get().total);db.close();`], { env: { ...process.env, ARCH_STARTUP_SQL_DIR: directory }, windowsHide: true, encoding: 'utf8' });
    assert.equal(result.trim(), '500000500000');
    const names = await readdir(directory);
    const rows = (await readFile(path.join(directory, names.find(n => n.endsWith('.ndjson'))), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(rows[0].method, 'get'); assert.ok(rows[0].duration >= 5); assert.match(rows[0].sql, /RECURSIVE/);
    const aggregate = JSON.parse(await readFile(path.join(directory, names.find(n => n.endsWith('.json'))), 'utf8'));
    assert.ok(aggregate.json.count >= 1); assert.ok(aggregate.json.totalMs >= 0);
    assert.ok(aggregate.sql.some(s => s.method === 'run' && s.count === 1)); assert.ok(aggregate.sql.some(s => s.method === 'exec'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
