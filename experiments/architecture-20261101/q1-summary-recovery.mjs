import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageStore } from '../../src/usage-store.js';
import { buildStoredAllSummary, readStoredAllSummary } from '../../src/usage-all-summary-store.js';

const [label,childMode,phase]=process.argv.slice(2);
const filters={preset:'all',calendarZone:'utc',now:new Date('2026-11-03T12:00:00Z')};
const details={includeDetails:false};
const storeOptions=root=>({homeDir:root,databaseFile:path.join(root,'state.sqlite'),env:{},importDirs:[],automaticDiscoveryEnabled:false});
if(childMode==='child'){
  const store=new UsageStore(storeOptions(label));await store.sync();
  const input=store.allSummaryOptions(filters,details);assert.ok(input);input.batchSize=1;
  const crash=()=>{process.send({point:phase});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);throw new Error('Parent did not kill crash child');};
  if(phase==='before-commit'){
    const iterate=input.eventsAfter;
    input.eventsAfter=function*(position,limit){for(const event of iterate(position,limit)){yield event;crash();}};
  }else input.afterBatch=crash;
  buildStoredAllSummary(input);throw new Error('Crash point was not reached');
}
assert.match(label||'',/^q1-[a-z0-9-]+$/);
const directory=path.resolve('output/architecture-20261103/q1',label);await mkdir(directory);
const results=[];
for(const point of ['before-commit','after-commit']){
  const root=path.join(directory,point),sessions=path.join(root,'.codex/sessions');await mkdir(sessions,{recursive:true});
  const rows=[{type:'session_meta',timestamp:'2026-11-03T01:00:00Z',payload:{id:'summary-recovery',source:'cli',originator:'codex-tui',cwd:''}},
    {type:'turn_context',payload:{model:'gpt-6-sol'}},
    ...[1,2,3].map(n=>({type:'event_msg',timestamp:`2026-11-03T01:0${n}:00Z`,payload:{type:'token_count',info:{last_token_usage:{total_tokens:10,input_tokens:5,output_tokens:5}}}}))];
  await writeFile(path.join(sessions,'rollout.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const child=fork(fileURLToPath(import.meta.url),[root,'child',point],{execArgv:['--max-old-space-size=224','--max-semi-space-size=4'],windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  let error='';child.stderr.on('data',text=>error+=text);
  let received=false;child.on('message',message=>{assert.equal(message.point,point);received=true;child.kill('SIGKILL');});
  const exited=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));});
  assert.equal(exited.signal,'SIGKILL',JSON.stringify({exited,error}));
  assert.equal(received,true);
  const store=new UsageStore(storeOptions(root));await store.sync();
  try{
    assert.equal(store.database.prepare('SELECT COUNT(*) n FROM events').get().n,3);
    const input=store.allSummaryOptions(filters,details);assert.ok(input);
    assert.equal(readStoredAllSummary(input),null);
    const pending=store.database.prepare('SELECT status FROM usage_all_summary_state').get();
    assert.equal(pending?.status,point==='after-commit'?'building':undefined);
    const actual=await store.summarizeHistory(filters,details),work=store.lastAllSummaryWork;
    assert.equal(work.readEvents,point==='after-commit'?2:3);
    assert.equal(actual.eventCount,3);assert.equal(actual.totals.total,30);
    const original=store.allSummaryOptions;store.allSummaryOptions=()=>null;
    const expected=await store.summarizeHistory(filters,details);store.allSummaryOptions=original;
    assert.deepEqual(actual,expected);
    assert.equal(store.database.prepare('PRAGMA quick_check').get().quick_check,'ok');
    results.push({point,exit:exited,statusBefore:pending?.status||'absent',work,eventCount:actual.eventCount,total:actual.totals.total,parity:true});
  }finally{store.close();}
}
await writeFile(path.join(directory,'result.json'),JSON.stringify({passed:true,results},null,2)+'\n');
console.log(JSON.stringify({passed:true,results}));
