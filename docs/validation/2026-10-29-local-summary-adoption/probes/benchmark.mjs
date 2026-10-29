import fs from 'node:fs/promises';
import syncfs from 'node:fs';
import path from 'node:path';
import {fork,spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const evidence=path.resolve('output/local-summary-adoption-20261029');
const exp=JSON.parse(await fs.readFile(path.join(evidence,'experiment.json'),'utf8'));
const mode=process.argv[2]||'warm',name=process.argv[3]||mode;
const directory=path.join(exp.work,name);await fs.mkdir(directory,{recursive:true});
const config={...exp,options:{...exp.options,databaseFile:path.join(directory,'index.sqlite')}};
for(const suffix of ['','-wal','-shm','.summaries.sqlite','.summaries.sqlite-wal','.summaries.sqlite-shm'])await fs.rm(config.options.databaseFile+suffix,{force:true});
const seed=mode==='cold'?null:mode==='migration'?exp.legacyDatabase:exp.warmDatabase;
if(seed)await fs.copyFile(seed,config.options.databaseFile);
const configFile=path.join(directory,'config.json');await fs.writeFile(configFile,JSON.stringify(config));
const stateFile=path.join(directory,'state.json'),stopFile=path.join(directory,'stop');await fs.rm(stopFile,{force:true});
let state={case:name,phase:'startup',pids:[]};const save=()=>syncfs.writeFileSync(stateFile,JSON.stringify(state));save();
const sampleFile=path.join(evidence,name+'-memory.jsonl');
const sampler=spawn('pwsh',['-NoProfile','-File',exp.sampler,'-StateFile',stateFile,'-OutputFile',sampleFile,'-StopFile',stopFile],{windowsHide:true,stdio:'ignore'});
const events=[],responses=[];let service;
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const comparable=value=>Object.fromEntries(['summary','metadata','periodComparison','pricingCatalog','quota'].map(key=>[key,value[key]]));
const eventFd=syncfs.openSync(path.join(evidence,name+'-events.jsonl'),'w');
async function start(){
  service=fork(path.join(import.meta.dirname,'service.mjs'),[configFile],{execArgv:['--max-old-space-size=128','--import',pathToFileURL(exp.hookFile).href],env:{...process.env,LOCAL_SUMMARY_CASE_CONFIG:configFile},stdio:['ignore','ignore','pipe','ipc']});
  state.pids=[service.pid];save();
  let stderr='';service.stderr.on('data',b=>{stderr+=b;});
  service.on('message',message=>{
    const event={...message,at:Date.now(),phase:state.phase};syncfs.writeSync(eventFd,JSON.stringify(event)+'\n');
    if(message.type!=='memory')events.push(event);
    if(message.type==='child-start')state.pids.push(message.pid);
    if(message.type==='child-exit')state.pids=state.pids.filter(pid=>pid!==message.pid);
    save();
  });
  return await new Promise((resolve,reject)=>{
    service.once('exit',code=>reject(Error('Service exited '+code+' '+stderr)));
    service.on('message',m=>{if(m.type==='ready')resolve('http://127.0.0.1:'+m.port);});
  });
}
async function stop(){
  const target=service;if(target.exitCode!==null)return;
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{target.kill();reject(Error('Service close timeout'));},15000);
    target.once('exit',()=>{clearTimeout(timeout);resolve();});target.send({type:'close'});
  });
}
async function idle(){const until=performance.now()+10000;do{if(state.pids.length===1)return;await delay(50);}while(performance.now()<until);assert.fail('Calculator did not retire');}
let base;
async function request(label,query){
  state.phase=label;save();const before=events.filter(e=>e.type==='child-start').length;
  const start=performance.now(),response=await fetch(base+'/api/usage?'+new URLSearchParams(query),{signal:AbortSignal.timeout(900000)}),body=await response.json();
  const row={label,status:response.status,ms:performance.now()-start,cache:response.headers.get('x-summary-cache'),hash:response.ok?hash(comparable(body)):null,children:events.filter(e=>e.type==='child-start').length-before};responses.push(row);
  if(response.ok)await fs.writeFile(path.join(evidence,name+'-'+label+'.json'),JSON.stringify(comparable(body)));
  else await fs.writeFile(path.join(evidence,name+'-'+label+'-error.json'),JSON.stringify(body));
  console.log(JSON.stringify(row));await idle();return body;
}
const result={mode,name,startedAt:new Date().toISOString()};
try{
  base=await start();
  const today={preset:'today',bucket:'hour',calendarZone:'local',view:'dashboard'};
  const first=await request('today',today);assert(first.summary);
  const cached=await request('today-hit',today);assert.deepEqual(comparable(cached),comparable(first));assert.equal(responses.at(-1).cache,'hit');assert.equal(responses.at(-1).children,0);
  if(mode==='warm'){
    const {USAGE_PRESETS}=await import(pathToFileURL(path.join(config.sourceRoot,'src/usage-core.js')).href);
    const fiveHour=USAGE_PRESETS.find(preset=>preset.startsWith('quota')&&preset!=='quota_week');
    for(const preset of ['month','all','quota_week',fiveHour])await request(preset,{preset,bucket:preset==='quota_week'?'quota_24h':preset===fiveHour?'quota_30m':'day',calendarZone:'local',view:'dashboard'});
    const frozen=await request('freeze',{...today,freeze:'1'});assert(frozen.snapshotId);assert.deepEqual(comparable(frozen),comparable(first));
    const frozenAgain=await request('frozen',{...today,snapshot:frozen.snapshotId});assert.deepEqual(comparable(frozenAgain),comparable(frozen));
    state.phase='idle-10s';save();await delay(10000);assert.equal(state.pids.length,1);
    await stop();base=await start();
    const restored=await request('restart-hit',today);assert.deepEqual(comparable(restored),comparable(first));assert.equal(responses.at(-1).cache,'hit');assert.equal(responses.at(-1).children,0);
    for(let n=1;n<=5;n++)await request('unchanged-'+n,today);
  }
}catch(error){result.error={message:error.message,stack:error.stack};process.exitCode=1;}
finally{
  await stop();syncfs.closeSync(eventFd);state.pids=[];save();await fs.writeFile(stopFile,'stop');await new Promise(resolve=>{if(sampler.exitCode!==null)return resolve();sampler.once('exit',resolve);});
  const rows=(await fs.readFile(sampleFile,'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse).filter(r=>r.processes>0);
  result.memory={samples:rows.length,peakWorkingSetMiB:Math.max(...rows.map(r=>r.rss))/2**20,peakPrivateMiB:Math.max(...rows.map(r=>r.private))/2**20,within512MiB:rows.every(r=>r.rss<=512*2**20&&r.private<=512*2**20)};
  result.events=events;result.responses=responses;result.finishedAt=new Date().toISOString();
  await fs.writeFile(path.join(evidence,name+'-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({name,memory:result.memory,error:result.error}));
}
assert(!result.error);assert(result.memory.within512MiB,'Service plus calculator exceeded 512 MiB');
