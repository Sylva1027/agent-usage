import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareScale, serverOptions, waitForServer, stopServer, openPage, painted, switchPreset,
  appendAndPaint, progressRows, hashFile, productionSourceSnapshot, sourceInventory, compareInventory, waitForPollingRecovery, sleep } from './b2-page-diagnostic.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const here=path.join(root,'experiments/architecture-20261101');
const parent=path.join(root,'output/architecture-20261103/b2');
const argument=(key,fallback)=>{const i=process.argv.indexOf(key);return i<0?fallback:process.argv[i+1];};
const label=argument('--label');assert.match(label||'',/^q0-[a-z0-9-]+$/);
const cell=argument('--cell','1x-sha');assert.match(cell,/^(1|10)x-(sha|native)$/);
const scale=cell.startsWith('10')?'10x':'1x';
const mode=argument('--mode','trace');assert.ok(['trace','control','heavy','recovery'].includes(mode));
const output=path.join(parent,label,cell);
const trialName=argument('--trial',mode);assert.match(trialName,/^[a-z0-9-]+$/);
const trial=path.join(output,trialName);
const preparedFile=path.join(output,'prepared.json');
const start=Date.now();
let server,sampler,browserState;
const result={schemaVersion:1,cell,mode,startedAt:new Date().toISOString(),passed:false,scopes:[],appends:[]};
const checkpoint=async()=>writeFile(path.join(trial,'result.json'),JSON.stringify(result,null,2)+'\n');

function browserTiming() {
  window.__q0Times=[];
  const now=()=>performance.timeOrigin+performance.now();
  const nativeFetch=window.fetch;
  window.fetch=async function(...args) {
    const row={type:'fetch',url:String(args[0]?.url||args[0]),start:now()};window.__q0Times.push(row);
    const response=await Reflect.apply(nativeFetch,this,args);row.headers=now();row.status=response.status;
    const json=response.json;
    response.json=async function(...values) {const body=await Reflect.apply(json,this,values);row.json=now();row.total=body.summary?.totals?.total;row.eventCount=body.summary?.eventCount;return body;};
    return response;
  };
  const EventSourceOriginal=window.EventSource;
  window.EventSource=function(...args) {
    const source=new EventSourceOriginal(...args);
    source.addEventListener('usage-synced',()=>window.__q0Times.push({type:'sse',at:now()}));
    return source;
  };
  window.EventSource.prototype=EventSourceOriginal.prototype;
  document.addEventListener('DOMContentLoaded',()=>{
    const target=document.querySelector('#totalTokens');if(!target)return;
    new MutationObserver(()=>{const row={type:'dom-total',at:now(),title:target.title};window.__q0Times.push(row);requestAnimationFrame(()=>requestAnimationFrame(()=>{row.paint=now();}));}).observe(target,{attributes:true,attributeFilter:['title']});
  });
}

async function launch(prepared) {
  const shutdownToken=createHash('sha256').update(trial+Date.now()).digest('hex');
  const configFile=path.join(trial,'server-config.json');
  await writeFile(configFile,JSON.stringify({gatewayHeapMb:512,executorHeapMb:224,options:serverOptions(prepared,shutdownToken)}));
  const env={...process.env,TMP:path.join(trial,'temp'),TEMP:path.join(trial,'temp')};
  delete env.NODE_OPTIONS;
  const args=['--max-old-space-size=512'];
  if(mode!=='control') {
    env.Q0_TRACE_DIR=path.join(trial,'trace');
    const {compile}=await import('./b2-attribution-transform.mjs');
    env.Q0_SOURCE_MAP=path.join(trial,'instrumented-sources.json');compile(env.Q0_SOURCE_MAP);
    args.push('--import',pathToFileURL(path.join(here,'b2-attribution-trace.mjs')).href);
  } else { delete env.Q0_TRACE_DIR; }
  if(mode==='heavy') {
    args.push('--cpu-prof',`--cpu-prof-dir=${path.join(trial,'trace')}`,'--heap-prof',`--heap-prof-dir=${path.join(trial,'trace')}`);
    env.Q0_HEAP_SNAPSHOT='1';
  }
  await mkdir(env.TEMP,{recursive:true});await mkdir(path.join(trial,'trace'),{recursive:true});
  args.push(path.join(here,'b2-page-diagnostic.mjs'),'--serve',configFile);
  const child=spawn(process.execPath,args,{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const ready=await waitForServer(child);
  return {child,ready,shutdownToken,configFile};
}
async function sample(prepared,pid) {
  const stopFile=path.join(trial,'resource-stop');
  const child=spawn('pwsh',['-NoProfile','-File',path.join(here,'b2-attribution-resource.ps1'),'-ResultDir',trial,
    '-ServicePid',String(pid),'-RunnerPid',String(process.pid),'-StopFile',stopFile,
    '-StateDir',prepared.stateDirectory,'-TempDir',path.join(trial,'temp'),'-SampleIntervalMilliseconds','500'],
    {cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',x=>{errors+=x;});
  await sleep(1500);assert.equal(child.exitCode,null,errors);
  return {child,stopFile,errors:()=>errors};
}
async function stopSampling() {
  if(!sampler)return;
  await writeFile(sampler.stopFile,'stop');
  const exit=await Promise.race([new Promise(r=>sampler.child.once('exit',r)),sleep(15000).then(()=>null)]);
  assert.equal(exit,0,sampler.errors());sampler=null;
}
async function warmRequest(page,preset,expected,label) {
  const began=Date.now();
  const responsePromise=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/api/usage'&&u.searchParams.get('preset')===preset;},{timeout:180000});
  await page.evaluate(v=>document.querySelector(`[data-preset="${v}"]`).click(),preset);
  const response=await responsePromise,body=await response.json();assert.equal(response.status(),200,JSON.stringify(body));
  if(preset==='all')assert.equal(body.summary.totals.total,expected);
  await painted(page,body.summary.totals.total);
  const row={name:label,preset,startedAtMs:began,endedAtMs:Date.now(),wallMs:Date.now()-began,cache:response.headers()['x-summary-cache'],total:body.summary.totals.total,eventCount:body.summary.eventCount};
  result.scopes.push(row);await checkpoint();return row;
}

await mkdir(output,{recursive:true});await mkdir(trial);
try {
  result.sourceBefore=await productionSourceSnapshot();
  result.toolHashes={};
  for(const name of ['b2-attribution-run.mjs','b2-attribution-trace.mjs','b2-attribution-transform.mjs','b2-attribution-resource.ps1','b2-page-diagnostic.mjs'])
    result.toolHashes[name]=await hashFile(path.join(here,name));
  const dataset=JSON.parse(await readFile(path.join(root,'output/architecture-20261103/growth-baseline',scale,'dataset.json'),'utf8'));
  let prepared;
  try { prepared=JSON.parse(await readFile(preparedFile,'utf8')); }
  catch(e) {
    if(e.code!=='ENOENT')throw e;
    const rawRoot=cell.endsWith('native')?path.join(os.tmpdir(),'codex-'+label,cell):path.join(output,'fixture');
    await mkdir(rawRoot,{recursive:true});
    const seed=path.join(root,'output/architecture-20261103/b2/page-e1-final-v8',scale,'.codex-usage');
    prepared=await prepareScale(dataset,rawRoot,seed);
    await writeFile(preparedFile,JSON.stringify(prepared,null,2));
  }
  result.prepared=prepared;
  server=await launch(prepared);result.server={pid:server.ready.pid,url:server.ready.url};
  sampler=await sample(prepared,server.ready.pid);
  const openedAt=Date.now();
  browserState=await openPage(server.ready.url,trial,[browserTiming]);
  result.preparation={startedAtMs:openedAt,endedAtMs:Date.now(),bootstrapMs:browserState.bootstrapMs,firstAll:browserState.all};
  const inventory=sourceInventory(prepared.databaseFile);
  result.initial={total:browserState.all.total,eventCount:browserState.all.eventCount,sourceFiles:inventory.files.length};
  if(mode==='control')compareInventory(inventory,dataset,prepared.home);
  let expected=result.initial.total;
  const previous=progressRows(prepared.databaseFile).find(x=>x.sourcePath===prepared.selected.codex.targetPath)?.checkpoint.state.previousCumulative;
  const state={codex:{cumulative:{total:0,input:0,cached:0,output:0,reasoning:0,...previous},nextTimestampMs:Date.now()},
    dsh:{nextSequence:Date.now()*10,nextTimestampMs:Date.now(),turn:1,step:1}};
  if(mode!=='heavy') {
    await warmRequest(browserState.page,'all',expected,'unchanged-all-1');
    await warmRequest(browserState.page,'all',expected,'unchanged-all-2');
  }
  const rounds=mode==='trace'?3:1;
  for(const kind of mode==='recovery'?[]:mode==='heavy'?['codex']:['codex','dsh']) {
    for(let i=0;i<rounds;i++) {
      expected+=kind==='codex'?1000:1900;
      await appendAndPaint(browserState.page,prepared,state,kind,'sse',result,expected);
      assert.equal(result.appends.at(-1).responseEventCount,result.initial.eventCount+result.appends.length);
      await checkpoint();
    }
    if(mode!=='heavy')for(const preset of ['today','week','all','all'])await warmRequest(browserState.page,preset,expected,`${kind}-switch-${preset}-${result.scopes.length}`);
  }
  if(mode==='recovery') {
    expected+=1000;
    const append=await appendAndPaint(browserState.page,prepared,state,'codex','sse-loss',result,expected);
    const recovery=await waitForPollingRecovery(browserState.page,expected);
    const bodyCount=await browserState.page.evaluate(value=>window.__q0Times.filter(x=>x.type==='fetch'&&x.total===value).at(-1)?.eventCount,expected);
    assert.equal(bodyCount,result.initial.eventCount+1);
    Object.assign(append,{...recovery,startedAtMs:append.startedAtMs,wallMs:Date.now()-append.startedAtMs,endedAtMs:Date.now(),responseEventCount:bodyCount,awaitingPollingRecovery:false});
    Object.assign(result.scopes.at(-1),append);await checkpoint();
  }
  const progress=progressRows(prepared.databaseFile);
  result.progress=[];
  for(const kind of ['codex','dsh']) {
    const source=prepared.selected[kind].targetPath;
    const row=progress.find(x=>x.sourcePath===source);assert.ok(row);
    assert.equal(row.checkpoint.offset,(await stat(source)).size);
    if(cell.endsWith('sha'))assert.equal(row.validation.kind,'sha256-prefix-v1');
    else assert.notEqual(row.validation.kind,'sha256-prefix-v1','native cell did not obtain a native checkpoint');
    result.progress.push({kind,offset:row.checkpoint.offset,validationKind:row.validation.kind});
  }
  assert.deepEqual(browserState.errors,[]);
  result.browserTimes=await browserState.page.evaluate(()=>window.__q0Times);
  result.final={total:expected,eventCount:result.initial.eventCount+result.appends.length};
  const db=new DatabaseSync(prepared.databaseFile,{readOnly:true});
  assert.equal(db.prepare('SELECT count(*) n FROM events').get().n,result.final.eventCount);
  assert.equal(db.prepare('SELECT sum(total) n FROM events').get().n,expected);
  assert.equal(db.prepare('SELECT count(*) n FROM usage_source_reparse').get().n,0);
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');db.close();
  for(const target of Object.values(prepared.selected))assert.equal((await hashFile(target.sourcePath)).sha256,target.sourceSha256);
  result.passed=true;
} catch(e) {result.failure={message:e.message,stack:e.stack};process.exitCode=1;}
finally {
  if(server)try{await stopServer(server,result);}catch(e){result.cleanupError=e.stack;process.exitCode=1;}
  if(browserState)await browserState.browser.close();
  try{await stopSampling();}catch(e){result.samplingError=e.stack;process.exitCode=1;}
  result.sourceAfter=await productionSourceSnapshot();
  assert.deepEqual(result.sourceAfter.files,result.sourceBefore.files);
  result.endedAt=new Date().toISOString();result.totalWallMs=Date.now()-start;await checkpoint();
  console.log(JSON.stringify({cell,mode,passed:result.passed,appends:result.appends.map(x=>({kind:x.kind,wallMs:x.wallMs})),failure:result.failure?.message,samplingError:result.samplingError,output:trial}));
}
