import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
const base = path.resolve('.codex-usage/refresh-latency-20261026');
const frozen = JSON.parse(fs.readFileSync(path.join(base, 'freeze.json'), 'utf8'));
const source = frozen.sourceFiles.find(row => row.kind === 'zcode').filePath;
const mapping = frozen.mappings.find(row => source.startsWith(row.original));
const target = path.join(mapping.copy, path.relative(mapping.original, source));
const temporary = target + '.repaired-' + process.pid;
const reader = new DatabaseSync(source, {readOnly:true});
const schema = db => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
try {
  const before = schema(reader);
  assert.ok(before.length > 0, 'Source must have tables');
  await backup(reader, temporary);
  const copy = new DatabaseSync(temporary);
  try {
    copy.exec('PRAGMA journal_mode=DELETE');
    assert.deepEqual(schema(copy), before);
    assert.equal(copy.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.ok(fs.statSync(temporary).size > 0);
    const counts = Object.fromEntries(before.map(name => [name, Number(copy.prepare('SELECT count(*) AS n FROM "' + name.replaceAll('"','""') + '"').get().n)]));
    console.log(JSON.stringify({tables:before,counts,bytes:fs.statSync(temporary).size}));
  } finally { copy.close(); }
} finally { reader.close(); }
for (const suffix of ['','-wal','-shm']) if(fs.existsSync(target+suffix)) fs.renameSync(target+suffix,target+suffix+'.excluded-'+process.pid);
fs.renameSync(temporary,target);
