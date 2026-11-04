import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageStore } from '../../src/usage-store.js';
import { UsageSourceProof } from '../../src/usage-source-proof.js';
import { tryInitializeUsageRollups, tryAppendUsageRollups } from '../../src/usage-rollups.js';

const [label,mode,stage,phase]=process.argv.slice(2);
assert.match(label||'',/^q4-[a-z0-9-]+$/);
const base=path.resolve('output/architecture-20261104/q4/recovery',label);
const heap=['--max-old-space-size=224','--max-semi-space-size=4'];
const zoneIdentity=Intl.DateTimeFormat().resolvedOptions().timeZone;
const self=fileURLToPath(import.meta.url);
const rowCount=321;
async function open(root) {
  const store=new UsageStore({homeDir:root,databaseFile:path.join(root,'usage.sqlite'),automaticDiscoveryEnabled:false});
  await store.open();store.sourceProof=new UsageSourceProof();store.sourceProof.provider=async()=>null;
  store.repositoryResolver=cwd=>({key:'directory:'+cwd,path:cwd,kind:'directory'});
  return store;
}
const source=root=>({id:'recovery',label:'Recovery',path:root,kind:'main'});
const facts=db=>{
  const rows=db.prepare('SELECT * FROM events ORDER BY id').all();
  return {count:rows.length,sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};
};
async function replace(store,root) {
  const filePath=path.join(root,'usage.jsonl');
  return store.replaceFile({filePath,source:source(root),info:await stat(filePath)});
}
function park(store) {
  process.send({pid:process.pid,stage,phase,isTransaction:store.database.isTransaction,execArgv:process.execArgv,facts:facts(store.database)});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);
  throw new Error('Parent did not terminate parked child');
}
async function kill(stage,phase) {
  const child=fork(self,[label,'child',stage,phase],{execArgv:heap,windowsHide:true,
    env:{...process.env,NODE_OPTIONS:''},stdio:['ignore','pipe','pipe','ipc']});
  let stderr='',message,requested=false;
  child.stderr.on('data',chunk=>stderr+=chunk);child.stdout.resume();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('No checkpoint: '+stderr));},30000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.on('message',value=>{
      try { assert.equal(message,undefined);message=value;assert.equal(value.pid,child.pid);
        assert.equal(value.stage,stage);assert.equal(value.phase,phase);assert.deepEqual(value.execArgv,heap);
        assert.equal(value.isTransaction,phase==='before-commit');requested=child.kill('SIGKILL');assert.equal(requested,true);
      } catch(error){child.kill('SIGKILL');clearTimeout(timer);reject(error);}
    });
    child.once('close',(code,signal)=>{clearTimeout(timer);
      try{assert.ok(message,stderr);assert.ok(requested);assert.ok(code!==0||signal!==null);resolve({checkpoint:message,code,signal,requested});}
      catch(error){reject(error);}
    });
  });
}
if(mode==='child') {
  assert.ok(['facts','rollups'].includes(stage));assert.ok(['before-commit','after-commit'].includes(phase));
  const root=path.join(base,stage+'-'+phase),store=await open(root),exec=store.database.exec.bind(store.database);
  let nesting=0;
  store.database.exec=sql=>{
    const text=String(sql).trim();
    if(stage==='rollups'&&text==='SAVEPOINT usage_rollups_write')nesting++;
    const boundary=stage==='facts'?text==='COMMIT':text==='RELEASE usage_rollups_write'&&nesting===1;
    if(boundary&&phase==='before-commit')park(store);
    const result=exec(sql);
    if(stage==='rollups'&&text==='RELEASE usage_rollups_write')nesting--;
    if(boundary&&phase==='after-commit')park(store);
    return result;
  };
  if(stage==='facts')await replace(store,root);else tryInitializeUsageRollups(store.database,{zoneIdentity});
  throw new Error('No commit boundary reached');
} else {
  assert.equal(mode,undefined);await mkdir(base,{recursive:true});
  const results=[];
  for(const stage of ['facts','rollups'])for(const phase of ['before-commit','after-commit']) {
    const root=path.join(base,stage+'-'+phase);await mkdir(root);
    const usage=n=>({total_tokens:n,input_tokens:n,cached_input_tokens:0,output_tokens:0,reasoning_output_tokens:0});
    const rows=[{type:'session_meta',payload:{id:'recovery',cwd:'/recovery',source:'cli',originator:'codex-tui'}},
      {type:'turn_context',payload:{model:'gpt-6-sol'}},
      ...Array.from({length:rowCount},(_,i)=>({timestamp:new Date(Date.parse('2026-11-04T01:00:00Z')+i*1000).toISOString(),type:'event_msg',
        payload:{type:'token_count',info:{total_token_usage:usage(i+1),last_token_usage:usage(1)}}}))];
    await writeFile(path.join(root,'usage.jsonl'),rows.map(JSON.stringify).join('\n')+'\n');
    const seed=await open(root);if(stage==='rollups')await replace(seed,root);seed.close();
    const killed=await kill(stage,phase),store=await open(root);
    try {
      assert.equal(facts(store.database).count,stage==='facts'&&phase==='before-commit'?0:rowCount);
      if(stage==='facts'&&phase==='before-commit')await replace(store,root);
      const before=facts(store.database);
      assert.equal(before.count,rowCount);
      assert.deepEqual(store.database.prepare('SELECT total FROM events ORDER BY id').all().map(row=>row.total),Array(rowCount).fill(1));
      assert.equal(store.database.prepare('SELECT COUNT(*) n FROM usage_source_progress').get().n,1);
      const certified=store.database.prepare('SELECT certified FROM usage_rollup_progress').get().certified;
      assert.equal(certified,stage==='rollups'&&phase==='after-commit'?1:0);
      const work=tryInitializeUsageRollups(store.database,{zoneIdentity});
      if(!certified)assert.equal(work.applied,true);
      assert.equal(tryAppendUsageRollups(store.database,{zoneIdentity}).readEvents,0);
      for(const zone of ['utc','local'])assert.deepEqual({...store.database.prepare('SELECT SUM(event_count) n,SUM(total) total FROM usage_rollup_daily WHERE calendar_zone=?').get(zone)},{n:rowCount,total:rowCount});
      assert.deepEqual(facts(store.database),before);
      assert.equal(store.database.prepare('PRAGMA quick_check').get().quick_check,'ok');
      results.push({stage,phase,killed,facts:before,passed:true});
    } finally {store.close();}
  }
  await writeFile(path.join(base,'result.json'),JSON.stringify({passed:true,results},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({passed:true,cases:results.length}));
}
