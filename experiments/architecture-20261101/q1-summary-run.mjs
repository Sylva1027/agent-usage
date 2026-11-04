import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertQ4Matrix, assertSeedParity, coldDecision, q4PageSeed, inside, runOptions, versionSpec } from './q3-benchmark-support.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const here=path.join(root,'experiments/architecture-20261101');
const options=runOptions(process.argv.slice(2));
const {generation,label,cell,variant,preparedResult,scale,trial,rounds,mode,rep,base}=options;
const modern=generation==='q3'||generation==='q4';
const retrySeed=process.argv.includes('--retry-seed');
if(retrySeed)assert.ok(generation==='q4'&&mode==='page');
if(process.argv.includes('--describe')){console.log(JSON.stringify(options,null,2));process.exit(0);}
const { prepareScale, serverOptions, waitForServer, stopServer, openPage, painted, appendAndPaint,
  progressRows, hashFile, sourceInventory, compareInventory, sleep } = await import('./b2-page-diagnostic.mjs');
const result={generation,cell,variant,mode,rep,rounds,startedAt:new Date().toISOString(),passed:false,scopes:[],appends:[],resourceSpans:[]};
if(retrySeed)result.retrySeed=true;
let server,sampler,browserState;
function observeDelivery() {
  const records=[];window.__q4Delivery=records;
  const fetch=window.fetch.bind(window),EventSource=window.EventSource;
  window.fetch=(...args)=>{records.push({kind:'fetch',at:Date.now(),url:String(args[0]),sse:window.__e1Diagnostic?.usageSynced});return fetch(...args);};
  function Tracked(url,options){const source=new EventSource(url,options);
    for(const kind of ['open','error','usage-synced'])source.addEventListener(kind,()=>records.push({kind,at:Date.now(),sse:window.__e1Diagnostic?.usageSynced}));
    return source;
  }
  Tracked.prototype=EventSource.prototype;
  for(const key of ['CONNECTING','OPEN','CLOSED'])Object.defineProperty(Tracked,key,{value:EventSource[key]});
  window.EventSource=Tracked;
}
const checkpoint=async()=>{
  const temporary=path.join(trial,'result.pending.json');
  await writeFile(temporary,JSON.stringify(result,null,2)+'\n',{flush:true});
  await rename(temporary,path.join(trial,'result.json'));
};
async function sourceHashes() {
  if(modern&&variant!=='candidate'){
    const version=versionSpec(variant,{generation}),hashes=JSON.parse(await readFile(version.hashesFile,'utf8'));
    assert.equal(Object.keys(hashes).length,version.expectedFiles);
    for(const [relative,expected] of Object.entries(hashes))assert.equal((await hashFile(path.join(version.directory,relative))).sha256,expected);
    return hashes;
  }
  const hashes={};
  for(const folder of ['src','public'])for(const name of await readdir(path.join(root,folder),{recursive:true})){
    if(generation!=='q4'&&!(modern?/\.(js|css|html|json)$/:/\.(js|css|html)$/).test(name))continue;
    const file=path.join(root,folder,name);if(!(await stat(file)).isFile())continue;
    hashes[path.relative(root,file)]=(await hashFile(file)).sha256;
  }
  return hashes;
}

async function launch(prepared,suffix='') {
  const shutdownToken=createHash('sha256').update(trial+suffix+Date.now()).digest('hex');
  const configFile=path.join(trial,`server-config${suffix}.json`);
  await writeFile(configFile,JSON.stringify({gatewayHeapMb:512,executorHeapMb:224,options:serverOptions(prepared,shutdownToken)}));
  const env={...process.env,Q1_VARIANT:variant,Q1_TRACE_DIR:path.join(trial,'components'),TMP:path.join(trial,'temp'),TEMP:path.join(trial,'temp')};
  if(generation==='q3'){env.Q3_VARIANT=variant;env.Q3_TRACE_DIR=env.Q1_TRACE_DIR;}
  else {delete env.Q3_VARIANT;delete env.Q3_TRACE_DIR;}
  if(generation==='q4'){env.Q4_VARIANT=variant;env.Q4_TRACE_DIR=env.Q1_TRACE_DIR;}
  else {delete env.Q4_VARIANT;delete env.Q4_TRACE_DIR;}
  if(generation==='q4'&&mode==='page')env.Q4_FIXED_PRICING='1';else delete env.Q4_FIXED_PRICING;
  delete env.NODE_OPTIONS;
  await mkdir(env.TEMP,{recursive:true});
  const child=spawn(process.execPath,['--max-old-space-size=512','--import',pathToFileURL(path.join(here,`${generation}-summary-hook.mjs`)).href,
    path.join(here,'b2-page-diagnostic.mjs'),'--serve',configFile],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  try{const ready=await waitForServer(child);return {child,ready,shutdownToken,configFile};}
  catch(error){if(child.exitCode===null)child.kill();throw error;}
}
async function startSampling(prepared,suffix='') {
  const directory=suffix?path.join(trial,'resources'+suffix):trial;
  await mkdir(directory,{recursive:true});
  const stopFile=path.join(directory,'resource-stop');
  const span={name:suffix?'reopen':'initial',servicePid:server.ready.pid,directory,startedAtMs:Date.now()};
  result.resourceSpans.push(span);
  const child=spawn('pwsh',['-NoProfile','-File',path.join(here,'b2-attribution-resource.ps1'),'-ResultDir',directory,
    '-ServicePid',String(server.ready.pid),'-RunnerPid',String(process.pid),'-StopFile',stopFile,
    '-StateDir',prepared.stateDirectory,'-TempDir',path.join(trial,'temp'),'-SampleIntervalMilliseconds','500'],
    {cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let error='';child.stderr.on('data',x=>error+=x);
  await sleep(1500);assert.equal(child.exitCode,null,error);return {child,stopFile,span,error:()=>error};
}
async function stopSampling() {
  if(!sampler)return;
  const current=sampler;sampler=null;
  await writeFile(current.stopFile,'stop');
  if(current.child.exitCode===null){
    let timer;
    try{
      const exit=await Promise.race([new Promise(resolve=>current.child.once('exit',resolve)),new Promise((_,reject)=>{
        timer=setTimeout(()=>{current.child.kill();reject(new Error('resource sampler did not stop'));},30000);
      })]);
      assert.equal(exit,0,current.error());
    }finally{clearTimeout(timer);}
  }else assert.equal(current.child.exitCode,0,current.error());
  current.span.endedAtMs=Date.now();
}
async function request(preset,expected,name) {
  const startedAtMs=Date.now(),page=browserState.page;
  const pending=page.waitForResponse(r=>{const u=new URL(r.url());return u.pathname==='/api/usage'&&u.searchParams.get('preset')===preset;},{timeout:300000});
  await page.evaluate(p=>document.querySelector(`[data-preset="${p}"]`).click(),preset);
  const response=await pending,body=await response.json();assert.equal(response.status(),200,JSON.stringify(body));
  if(preset==='all')assert.equal(body.summary.totals.total,expected);
  await painted(page,body.summary.totals.total);
  const row={name,preset,startedAtMs,endedAtMs:Date.now(),wallMs:Date.now()-startedAtMs,cache:response.headers()['x-summary-cache']};
  result.scopes.push(row);await checkpoint();return row;
}
function viewStats(prepared) {
  const db=new DatabaseSync(prepared.databaseFile,{readOnly:true});
  const present=db.prepare("SELECT 1 FROM sqlite_master WHERE name='usage_all_summary_state'").get();
  const value=present?{
    state:db.prepare('SELECT * FROM usage_all_summary_state').get(),
    members:db.prepare('SELECT COUNT(*) n FROM usage_all_summary_members').get().n,
    checkpoints:db.prepare('SELECT COUNT(*) n,SUM(length(state_json)) bytes,MAX(length(state_json)) maxBytes FROM usage_all_summary_checkpoints').get(),
    tables:db.prepare("SELECT name,SUM(pgsize) bytes FROM dbstat WHERE name LIKE 'usage_all_%' GROUP BY name").all(),
  }:null;db.close();return value;
}
function q2Storage(prepared) {
  const db=new DatabaseSync(prepared.databaseFile,{readOnly:true});
  try{return db.prepare(`SELECT name,SUM(pgsize) bytes FROM dbstat WHERE name IN (
    SELECT name FROM sqlite_master WHERE tbl_name LIKE 'usage_metadata_%'
      OR tbl_name LIKE 'usage_rollup_progress%' OR name='events_metadata_group_time_idx'
  ) GROUP BY name`).all();}finally{db.close();}
}
function q4Storage(prepared) {
  const db=new DatabaseSync(prepared.databaseFile,{readOnly:true});
  try{return db.prepare(`SELECT s.name,s.tbl_name AS tableName,s.type,COALESCE(p.bytes,0) AS bytes
    FROM sqlite_master s LEFT JOIN (SELECT name,SUM(pgsize) bytes FROM dbstat GROUP BY name) p ON p.name=s.name
    WHERE s.type IN ('table','index') ORDER BY s.name`).all();}finally{db.close();}
}
await mkdir(trial,{recursive:true});
await assert.rejects(stat(path.join(trial,'result.json')),e=>e.code==='ENOENT');
try {
  result.sourceBefore=await sourceHashes();
  const datasetFile=path.join(root,'output/architecture-20261103/growth-baseline',scale,'dataset.json');
  const dataset=JSON.parse(await readFile(datasetFile,'utf8'));
  if(modern){
    const matrixFile=path.join(base,'matrix.json'),matrix=JSON.parse(await readFile(matrixFile,'utf8'));
    if(generation==='q4')assertQ4Matrix(matrix,label);
    else {assert.equal(matrix.prepared,true,'Prepare every Q3 mirror before certification.');
      assert.equal(matrix.label,label);assert.equal(matrix.trials.length,18);}
    for(const entry of matrix.trials)await stat(entry.preparedFile);
    result.matrixFile=matrixFile;
    result.datasetSha256=(await hashFile(datasetFile)).sha256;
    if(matrix.datasets)assert.equal(result.datasetSha256,matrix.datasets[scale].sha256);
    if(mode==='cold-only'&&rep===3){
      const previous=[];
      for(const n of [1,2]){
        const run=JSON.parse(await readFile(path.join(trial,'..',`rep-${n}`,'result.json'),'utf8'));
        assert.equal(run.passed,true);previous.push({rep:n,wallMs:run.first.endedAtMs-run.first.startedAtMs});
      }
      assert.equal(coldDecision(previous).supplementRequired,true,'rep3 is reserved for groups differing by more than 5%.');
    }
  }
  const seed=preparedResult?JSON.parse(await readFile(preparedResult,'utf8')):null;
  if(seed){
    assert.equal(seed.passed,true);assert.equal(seed.cell,cell);assert.equal(seed.variant,variant);
    const generationRoot=path.join(root,modern?'output/architecture-20261104':'output/architecture-20261103',generation);
    assert.ok(inside(generationRoot,seed.prepared.databaseFile));
    if(modern){
      assert.equal(seed.generation,generation);assert.deepEqual(seed.sourceAfter,result.sourceBefore);
      assert.equal(seed.datasetSha256,result.datasetSha256);
      assert.ok(seed.publishedInputs,'Q3 seed must save its published source hashes.');
      for(const [kind,selected] of Object.entries(seed.prepared.selected))
        assert.deepEqual(await hashFile(selected.targetPath),seed.publishedInputs[kind],`seed ${kind} content changed`);
    }
    if(generation==='q4'){
      const final=await q4PageSeed(base,cell,variant,retrySeed);
      assert.equal(path.resolve(preparedResult),final.file,'Q4 page must continue its matching final cold result.');
    }
    result.continuedFrom=path.resolve(preparedResult);
  }
  const mirrorRoot=cell.endsWith('native')?path.join(os.tmpdir(),'codex-'+label,cell,variant):path.join(trial,'fixture');
  const prepared=seed?.prepared || (generation!=='q1'
    ? JSON.parse(await readFile(path.join(trial,'prepared.json'),'utf8'))
    : await prepareScale(dataset,mirrorRoot,path.join(root,'output/architecture-20261103/b2/page-e1-final-v8',scale,'.codex-usage')));
  if(modern&&mode==='cold-only'){
    assert.ok(inside(trial,prepared.databaseFile));
    await assert.rejects(stat(prepared.databaseFile),error=>error.code==='ENOENT');
  }
  if(generation==='q4'){
    const fixture=seed?path.dirname(path.resolve(preparedResult)):trial;
    for(const file of [prepared.home,prepared.databaseFile,prepared.stateDirectory])assert.ok(inside(fixture,file));
    for(const kind of ['codex','dsh']){
      assert.ok(inside(prepared.home,prepared.selected[kind].targetPath));
      assert.equal((await stat(prepared.selected[kind].targetPath)).nlink,1,'Q4 appends require independent copies.');
    }
  }
  result.prepared=prepared;await checkpoint();
  server=await launch(prepared);result.server={pid:server.ready.pid,url:server.ready.url};
  sampler=await startSampling(prepared);
  const start=Date.now();browserState=await openPage(server.ready.url,trial,generation==='q4'?[observeDelivery]:[]);
  result.first={startedAtMs:start,endedAtMs:Date.now(),bootstrapMs:browserState.bootstrapMs,all:browserState.all};
  if(seed){
    result.seedParity=assertSeedParity(browserState.all,seed);
  }else compareInventory(sourceInventory(prepared.databaseFile),dataset,prepared.home);
  const initial=browserState.all;let expected=initial.total;
  result.initialView=viewStats(prepared);await checkpoint();
  if(generation!=='q1')result.initialQ2Storage=q2Storage(prepared);
  if(generation==='q4')result.initialQ4Storage=q4Storage(prepared);
  if(mode!=='cold-only'){
  await request('all',expected,'unchanged-all');
  const previous=progressRows(prepared.databaseFile).find(x=>x.sourcePath===prepared.selected.codex.targetPath)?.checkpoint.state.previousCumulative;
  const state={codex:{cumulative:{total:0,input:0,cached:0,output:0,reasoning:0,...previous},nextTimestampMs:Date.now()},
    dsh:{nextSequence:Date.now()*10,nextTimestampMs:Date.now(),turn:1,step:1}};
  for(const kind of ['codex','dsh']) {
    for(let i=0;i<rounds;i++) {
      expected+=kind==='codex'?1000:1900;
      await appendAndPaint(browserState.page,prepared,state,kind,'sse',result,expected);
      assert.equal(result.appends.at(-1).responseEventCount,initial.eventCount+result.appends.length);
      await checkpoint();
    }
    for(const preset of ['today','week','all','all'])await request(preset,expected,`${kind}-${preset}-${result.scopes.length}`);
  }
  result.finalView=viewStats(prepared);
  }
  if(generation!=='q1')result.finalQ2Storage=q2Storage(prepared);
  if(generation==='q4')result.finalQ4Storage=q4Storage(prepared);
  const db=new DatabaseSync(prepared.databaseFile,{readOnly:true});
  assert.equal(db.prepare('SELECT count(*) n FROM events').get().n,initial.eventCount+result.appends.length);
  assert.equal(db.prepare('SELECT sum(total) n FROM events').get().n,expected);
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');db.close();
  result.progress=progressRows(prepared.databaseFile).filter(x=>Object.values(prepared.selected).some(y=>x.sourcePath===y.targetPath));
  for(const selected of Object.values(prepared.selected)){
    assert.equal(result.progress.find(x=>x.sourcePath===selected.targetPath).checkpoint.offset,(await stat(selected.targetPath)).size);
    assert.equal((await hashFile(selected.sourcePath)).sha256,selected.sourceSha256);
  }
  result.publishedInputs={};
  for(const [kind,selected] of Object.entries(prepared.selected))result.publishedInputs[kind]=await hashFile(selected.targetPath);
  result.published={firstAll:browserState.all,appends:result.appends.length};
  assert.deepEqual(browserState.errors,[]);
  if(mode!=='cold-only'){
  await browserState.browser.close();browserState=null;
  await stopServer(server,result);server=null;
  await stopSampling();
  // Restart the full service and executor against the already published view.
  const reopened=Date.now();server=await launch(prepared,'-reopen');
  sampler=await startSampling(prepared,'-reopen');
  browserState=await openPage(server.ready.url,trial);
  assert.equal(browserState.all.total,expected);
  result.reopen={startedAtMs:reopened,endedAtMs:Date.now(),firstAll:browserState.all};
  result.published.firstAll=browserState.all;
  if(generation==='q4')result.reopenQ4Storage=q4Storage(prepared);
  assert.deepEqual(browserState.errors,[]);
  }
  result.passed=true;
} catch(error){result.failure={message:error.message,stack:error.stack};process.exitCode=1;}
finally {
  if(generation==='q4'&&browserState)try{result.pageDelivery=await browserState.page.evaluate(()=>window.__q4Delivery??[]);}catch{}
  if(browserState)try{await browserState.browser.close();}catch(error){result.cleanupError=error.stack;result.passed=false;process.exitCode=1;}
  if(server)try{await stopServer(server,result);}catch(error){result.cleanupError=error.stack;result.passed=false;process.exitCode=1;}
  try{await stopSampling();}catch(error){result.cleanupError=error.stack;result.passed=false;process.exitCode=1;}
  try{result.sourceAfter=await sourceHashes();assert.deepEqual(result.sourceAfter,result.sourceBefore);}
  catch(error){result.failure??={message:error.message,stack:error.stack};result.passed=false;process.exitCode=1;}
  result.endedAt=new Date().toISOString();await checkpoint();
  console.log(JSON.stringify({cell,variant,passed:result.passed,appends:result.appends.map(x=>({kind:x.kind,wallMs:x.wallMs})),failure:result.failure?.message,output:trial}));
}
