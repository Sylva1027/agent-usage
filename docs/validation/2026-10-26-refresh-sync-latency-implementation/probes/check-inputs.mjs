import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const frozen=JSON.parse(fs.readFileSync('.codex-usage/refresh-latency-20261026/freeze.json','utf8'));
const differences=[];
for (const entry of frozen.copied) {
  const mapping=frozen.mappings.find(row=>entry.file.toLowerCase().startsWith(row.original.toLowerCase()+path.sep));
  assert.ok(mapping);
  const file=path.join(mapping.copy,path.relative(mapping.original,entry.file));
  const stat=fs.statSync(file);
  const restored=/[\\/]\.claude[\\/]|[\\/]\.config[\\/]magpie[\\/]usage\.jsonl$/.test(entry.file);
  if(stat.size!==entry.bytes||(restored&&stat.mtimeMs!==entry.mtimeMs))differences.push({fileHash:createHash('sha256').update(entry.file).digest('hex'),bytes:stat.size,expectedBytes:entry.bytes,mtimeMs:stat.mtimeMs,expectedMtimeMs:entry.mtimeMs});
}
const result={checkedAt:new Date().toISOString(),files:frozen.copied.length,differences};
fs.writeFileSync('output/refresh-sync-latency-implementation/input-identity.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,differences:result.differences.length}));
assert.equal(differences.length,0,'Frozen source sizes and Node mtime signatures must match');
