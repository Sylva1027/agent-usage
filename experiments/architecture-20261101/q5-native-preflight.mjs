import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, open, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const label=process.argv[2];assert.match(label||'',/^q5-[a-z0-9-]+$/);
const base=path.resolve('output/architecture-20261104/q5/preflight',label);await mkdir(base,{recursive:true});
const executable=path.resolve('output/architecture-20261104/q5/baseline/native/windows-source-proof/bin/windows-source-proof.exe');
const roots=[{volume:'E',root:path.join(base,'e')},{volume:'C',root:path.join(os.tmpdir(),'codex-'+label,'native-preflight')}];
const results=[];
for(const entry of roots) {
  await mkdir(entry.root,{recursive:true});const file=path.join(entry.root,'source.jsonl');await writeFile(file,'initial\n');
  const child=spawn(executable,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let pending,buffer='',sequence=0,stderr='';
  child.stderr.on('data',chunk=>stderr+=chunk);
  child.stdout.on('data',chunk=>{buffer+=chunk;for(;;){const at=buffer.indexOf('\n');if(at<0)break;const text=buffer.slice(0,at);buffer=buffer.slice(at+1);const row=JSON.parse(text);if(pending){const p=pending;pending=null;clearTimeout(p.timer);p.resolve(row);}}});
  const request=async(op,offset,token)=>{
    const info=await stat(file,{bigint:true}),id=++sequence,start=performance.now();
    const response=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('native preflight timeout '+stderr));},4000);pending={resolve,reject,timer};
      child.stdin.write(JSON.stringify({id,op,path:file,offset,token,expected:{size:String(info.size),mtimeNs:String(info.mtimeNs)}})+'\n');});
    assert.equal(response.id,id);return {...response,wallMs:performance.now()-start};
  };
  const steps=[];
  try {
    const first=await request('begin',0);steps.push({op:'begin',...first});
    if(first.ok&&first.available){
      let proof=await request('advance',8,first.token);steps.push({op:'initial-seal',...proof});
      if(proof.ok&&proof.available){
        await appendFile(file,'append\n');const verified=await request('verify',8,proof.token);steps.push({op:'append-verify',...verified});
        if(verified.ok&&verified.available){proof=await request('advance',15,verified.token);steps.push({op:'append-advance',...proof});}
        if(proof.ok&&proof.available){const before=await stat(file),handle=await open(file,'r+');try{await handle.write(Buffer.from('changed'),0,7,0);}finally{await handle.close();}await utimes(file,before.atime,before.mtime);
          const changed=await request('verify',proof.offset,proof.token);steps.push({op:'same-size-rewrite',...changed});assert.equal(changed.ok,false,'native proof accepted a historical overwrite');}
      }
    }
    results.push({...entry,file,steps});
  } finally {child.stdin.end();if(child.exitCode===null)await new Promise(resolve=>{child.once('exit',resolve);setTimeout(()=>{child.kill();resolve();},1000).unref();});}
}
await writeFile(base+'/result.json',JSON.stringify({at:new Date().toISOString(),executable,results},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(results.map(r=>({volume:r.volume,root:r.root,steps:r.steps.map(({op,ok,available,reason,wallMs})=>({op,ok,available,reason,wallMs}))})),null,2));
