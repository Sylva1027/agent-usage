import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const label=process.argv[2];assert.match(label||'',/^q5-[a-z0-9-]+$/);
const base=path.resolve('output/architecture-20261104/q5/sha-probe',label);await mkdir(base,{recursive:true});
const dataset=JSON.parse(await readFile('output/architecture-20261103/growth-baseline/10x/dataset.json','utf8'));
const source=dataset.inputs.filter(row=>row.kind==='codex'&&row.role==='usage-file').sort((a,b)=>b.sourceBytes-a.sourceBytes)[0];
assert.ok(source?.sourceBytes>1024*1024*1024);
const variants={baseline:await import(pathToFileURL(path.resolve('output/architecture-20261104/q5/baseline/src/usage-source-proof.js'))),
  candidate:await import('../../src/usage-source-proof.js')};
const rows=[];
for(const offset of [64*1024*1024,source.sourceBytes]) {
  const expected=createHash('sha256');for await(const bytes of createReadStream(source.path,{start:0,end:offset-1,highWaterMark:1024*1024}))expected.update(bytes);
  const digest=expected.digest('hex');if(offset===source.sourceBytes)assert.equal(digest,source.sha256);
  for(let rep=1;rep<=3;rep++)for(const variant of rep%2?['baseline','candidate']:['candidate','baseline']) {
    const module=variants[variant],info=await stat(source.path),validation={kind:module.USAGE_SOURCE_SHA_KIND,offset,digest,identity:module.usageSourceIdentity(info),ctimeMs:info.ctimeMs};
    const cpu=process.cpuUsage(),start=performance.now(),verified=await module.verifyUsageSourcePrefix(source.path,validation,offset,info);
    assert.ok(verified);const proof=await module.captureUsageSourcePrefix(source.path,offset,info,verified,{offset,digest});
    assert.equal(proof.validation.digest,digest);assert.equal(verified.readBytes+proof.readBytes,2*offset);
    const used=process.cpuUsage(cpu),row={variant,rep,prefixBytes:offset,wallMs:performance.now()-start,cpuMs:(used.user+used.system)/1000,readBytes:verified.readBytes+proof.readBytes};
    rows.push(row);console.log(JSON.stringify(row));
  }
}
await writeFile(base+'/result.json',JSON.stringify({sourceKey:source.key,definition:'Same frozen source, unchanged prefix verified before and after suffix boundary; no parsing or page cost.',rows},null,2)+'\n',{flag:'wx'});
