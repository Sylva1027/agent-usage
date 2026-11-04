import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('state overlay redirects fs and SQLite writes while preserving logical source paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'startup-overlay-'));
  try {
    const logicalRoot = path.join(root, 'logical'), physicalRoot = path.join(root, 'private');
    await mkdir(logicalRoot); await mkdir(physicalRoot);
    await writeFile(path.join(logicalRoot, 'config.json'), 'original'); await writeFile(path.join(physicalRoot, 'config.json'), 'copy');
    await writeFile(path.join(root, 'outside.json'), 'source');
    const code = `import fs from 'node:fs';import{readFile,writeFile}from'node:fs/promises';import{DatabaseSync}from'node:sqlite';
      const target=process.env.ARCH_TEST_LOGICAL; if(await readFile(target+'/config.json','utf8')!=='copy')throw Error('read mismatch');
      await writeFile(target+'/config.json','changed');fs.writeFileSync(target+'/sync.json','sync');
      const db=new DatabaseSync(target+'/index.sqlite');db.exec('CREATE TABLE t(value TEXT)');db.prepare('INSERT INTO t VALUES (?)').run('saved');db.close();
      console.log(await readFile(process.env.ARCH_TEST_OUTSIDE,'utf8'));`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', pathToFileURL(path.resolve('experiments/architecture-20261101/startup-state-overlay.mjs')).href, '--input-type=module', '-e', code],
      { windowsHide: true, env: { ...process.env, ARCH_STARTUP_STATE_MAP: JSON.stringify({ logicalRoot, physicalRoot }), ARCH_TEST_LOGICAL: logicalRoot, ARCH_TEST_OUTSIDE: path.join(root, 'outside.json') } });
    assert.equal(stdout.trim(), 'source');
    assert.equal(await readFile(path.join(logicalRoot, 'config.json'), 'utf8'), 'original');
    assert.equal(await readFile(path.join(physicalRoot, 'config.json'), 'utf8'), 'changed');
    assert.equal(await readFile(path.join(physicalRoot, 'sync.json'), 'utf8'), 'sync');
    await assert.rejects(readFile(path.join(logicalRoot, 'index.sqlite')), { code: 'ENOENT' });
    assert.ok((await readFile(path.join(physicalRoot, 'index.sqlite'))).length > 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
