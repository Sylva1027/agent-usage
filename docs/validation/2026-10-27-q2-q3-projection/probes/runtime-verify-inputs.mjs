import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const root=process.cwd();
const stage=path.join(root,'output/q2-q3-projection-20261027');
const text=fs.readFileSync(path.join(stage,'probes/identity-after.json'),'utf8');
const identity=JSON.parse(text);
const frozen=path.join(root,'.codex-usage/refresh-latency-20261026');
const inside=(file,directory)=>{
  const relative=path.relative(directory,fs.realpathSync(file));
  assert.ok(relative!== '..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative));
};
const buffer=Buffer.alloc(1024*1024);
function digest(file) {
  const hash=createHash('sha256'),fd=fs.openSync(file,'r');
  try { for(let n;(n=fs.readSync(fd,buffer,0,buffer.length,null))>0;)hash.update(buffer.subarray(0,n)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
let bytes=0;
for(const item of identity.inputs) {
  inside(item.path,frozen);
  assert.equal(fs.statSync(item.path).size,item.size,'frozen input size');
  assert.equal(digest(item.path),item.sha256,'frozen input bytes: '+path.relative(frozen,item.path));
  bytes+=item.size;
}
for(const item of identity.code) {
  const current=path.join(root,item.path);
  inside(current,root);
  assert.equal(digest(current),item.sha256,'frozen product module: '+item.path);
}
const result={checkedAt:new Date().toISOString(),identityHash:createHash('sha256').update(text).digest('hex'),
  verifiedInputs:identity.inputs.length,verifiedBytes:bytes,verifiedModules:identity.code.length,
  allEquivalent:true,seedHash:digest(identity.database),nodePeakRSSMiB:process.resourceUsage().maxRSS/1024};
fs.writeFileSync(path.join(root,'docs/validation/2026-10-27-q2-q3-projection/evidence/inputs-final.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));



