import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import v8 from 'node:v8';
import { zstdCompressSync } from 'node:zlib';
import { Q5_ROOT, ROOT, inside, versionSpec } from './q3-benchmark-support.mjs';
import { verifyQ5Frozen } from './q5-prepare.mjs';
import { appendQ5AndPaint, assertQ5TraceCoverage, catalogDigest, observeQ5Delivery,
  q5AppendEvidence, q5DiagnosticHook, q5PrivateRows, readCapturedPricing, readQ5Delivery } from './q5-summary-hook.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=async file=>JSON.parse(await readFile(file,'utf8'));
async function save(file,value) {
  await writeFile(file+'.pending',JSON.stringify(value,null,2)+'\n',{flush:true});await rename(file+'.pending',file);
}

async function sourceHashes(variant) {
  const version=versionSpec(variant,{generation:'q5'}),baseline=versionSpec('baseline',{generation:'q5'});
  const keys=Object.keys({...await read(baseline.hashesFile),...await read(baseline.nativeHashesFile)});
  const hashes={};for(const relative of keys)hashes[relative]=hash(await readFile(path.join(version.directory,relative)));
  return hashes;
}

async function fixture(directory,home,pricingInput) {
  const stateDirectory=path.join(directory,'state'),originals=path.join(directory,'originals');
  await mkdir(stateDirectory,{recursive:true});await mkdir(originals);
  for(const name of ['pricing-auto.json','pricing.json']) {
    try{await copyFile(path.join(pricingInput,name),path.join(stateDirectory,name));}
    catch(error){if(error.code!=='ENOENT'||name!=='pricing.json')throw error;}
  }
  const now=Date.now(),usage={total_tokens:100,input_tokens:100,cached_input_tokens:0,output_tokens:0,reasoning_output_tokens:0};
  const codex=Buffer.from([
    {timestamp:new Date(now).toISOString(),type:'session_meta',payload:{id:'q5-browser-codex',cwd:home,source:'cli',originator:'codex-tui'}},
    {type:'turn_context',payload:{model:'gpt-5.1-codex'}},
    {timestamp:new Date(now).toISOString(),type:'event_msg',payload:{type:'token_count',info:{total_token_usage:usage,last_token_usage:usage}}},
  ].map(row=>JSON.stringify(row)).join('\n')+'\n');
  const dsh=zstdCompressSync(Buffer.from([
    {type:'session',version:4,id:'q5-browser-dsh',cwd:home,delegationDepth:0,createdAt:now},
    {type:'request/header',seq:1,time:now,data:{header:{config:{model:'deepseek-chat',provider:'deepseek'}}}},
    {type:'assistant/message',seq:2,time:now,data:{turn:1,step:1,usage:{inputTokens:10,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:20,totalTokens:30}}},
  ].map(row=>JSON.stringify(row)).join('\n')+'\n'));
  const selected={};
  for(const [kind,bytes,relative] of [['codex',codex,'.codex/sessions/smoke.jsonl'],
    ['dsh',dsh,'.dsh/sessions/smoke/browser/session.v4.jsonl.zstd']]) {
    const sourcePath=path.join(originals,kind),targetPath=path.join(home,relative);
    await mkdir(path.dirname(targetPath),{recursive:true});await writeFile(sourcePath,bytes);await copyFile(sourcePath,targetPath);
    assert.equal((await stat(targetPath)).nlink,1);
    selected[kind]={sourcePath,targetPath,sourceSha256:hash(bytes),sourceBytes:bytes.length};
  }
  return {home,stateDirectory,selected,databaseFile:path.join(stateDirectory,'usage-index.sqlite'),
    importStoreFile:path.join(stateDirectory,'imports.json'),pricingFile:path.join(stateDirectory,'pricing.json'),
    automaticPricingFile:path.join(stateDirectory,'pricing-auto.json')};
}

function observeReady() {
  const Source=window.EventSource;
  window.EventSource=class extends Source {
    constructor(...args){super(...args);this.addEventListener('ready',()=>{window.__q5SmokeReady=true;});}
  };
}

async function runCell(base,variant,proofMode,matrix,pricingFile,tools) {
  const directory=path.join(base,`${variant}-${proofMode}`);await mkdir(directory);
  const home=proofMode==='native'?path.join(os.tmpdir(),'codex-q5-browser-smoke',path.basename(base),variant,'home'):path.join(directory,'home');
  if(proofMode==='native'&&process.platform==='win32')assert.equal(path.parse(home).root.toUpperCase(),'C:\\');
  const result={kind:'q5-browser-smoke',timingSample:false,variant,proofMode,passed:false,appends:[],scopes:[],
    heaps:{gatewayMb:512,executorMb:224,executorSemiSpaceMb:4},startedAt:new Date().toISOString()};
  const file=path.join(directory,'result.json'),traceDirectory=path.join(directory,'components');
  let child,server,browser;
  const checkpoint=async()=>{
    if(browser)try{result.pageDelivery=await readQ5Delivery(browser.page);}catch(error){result.deliveryError=error.message;}
    await save(file,result);
  };
  try {
    result.sourceBefore=await sourceHashes(variant);
    const prepared=await fixture(directory,home,matrix.pricing.inputDirectory);result.prepared=prepared;await checkpoint();
    const shutdownToken=randomUUID(),config=path.join(directory,'server-config.json');
    await writeFile(config,JSON.stringify({gatewayHeapMb:512,executorHeapMb:224,options:tools.serverOptions(prepared,shutdownToken)}));
    const env={...process.env,Q5_VARIANT:variant,Q5_PROOF_MODE:proofMode,Q5_TRACE_DIR:traceDirectory,
      Q5_PRICING_FILE:pricingFile,Q5_PRICING_SHA256:matrix.pricing.catalogSha256,
      Q5_SELECTED_PATHS:JSON.stringify(Object.values(prepared.selected).map(row=>row.targetPath))};
    for(const key of ['NODE_OPTIONS','Q1_VARIANT','Q2_VARIANT','Q3_VARIANT','Q4_VARIANT','Q4_FIXED_PRICING'])delete env[key];
    child=childProcess.spawn(process.execPath,['--max-old-space-size=512','--import',pathToFileURL(path.join(here,'q5-summary-hook.mjs')).href,
      fileURLToPath(import.meta.url),'--serve-smoke',config],{cwd:ROOT,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',bytes=>appendFileSync(path.join(directory,'server.stdout.log'),bytes));
    child.stderr.on('data',bytes=>appendFileSync(path.join(directory,'server.stderr.log'),bytes));
    server={child,ready:await tools.waitForServer(child),shutdownToken};
    const script=await fetch(server.ready.url+'/app.js');assert.equal(script.status,200);
    assert.equal(hash(Buffer.from(await script.arrayBuffer())),result.sourceBefore['public/app.js']);
    browser=await tools.openPage(server.ready.url,directory,[observeQ5Delivery,observeReady]);
    browser.page.setDefaultTimeout(30000);
    const wait=browser.page.waitForResponse.bind(browser.page);
    browser.page.waitForResponse=(predicate,options)=>wait(predicate,{...options,timeout:30000});
    await browser.page.waitForFunction(()=>window.__q5SmokeReady===true,null,{timeout:30000});
    result.first=browser.all;await checkpoint();
    assert.equal(browser.all.total,130);assert.equal(browser.all.eventCount,2);
    assert.equal(catalogDigest(browser.all.body.pricingCatalog),matrix.pricing.catalogSha256);
    const progress=tools.progressRows(prepared.databaseFile),expectedKind=proofMode==='native'?'ntfs-usn-v1':'sha256-prefix-v2';
    for(const selected of Object.values(prepared.selected))assert.equal(progress.find(row=>row.sourcePath===selected.targetPath)?.validation.kind,expectedKind);
    const previous=progress.find(row=>row.sourcePath===prepared.selected.codex.targetPath).checkpoint.state.previousCumulative;
    const state={codex:{cumulative:{...previous},nextTimestampMs:Date.now()+1000},
      dsh:{nextSequence:3,nextTimestampMs:Date.now()+1000,turn:2,step:2}};
    let expected=130;
    for(const kind of ['codex','dsh']) {
      expected+=kind==='codex'?1000:1900;
      try {await appendQ5AndPaint(browser.page,prepared,state,kind,result,expected,checkpoint,
        {...tools,painted:(page,total)=>tools.painted(page,total,30000)});}
      finally {
        const append=result.appends.at(-1),row=tools.progressRows(prepared.databaseFile).find(row=>row.sourcePath===prepared.selected[kind].targetPath);
        append.evidence=q5AppendEvidence(q5PrivateRows(traceDirectory),append,prepared.selected[kind].targetPath,row);await checkpoint();
      }
      const append=result.appends.at(-1);assert.equal(append.responseEventCount,2+result.appends.length);
      assert.equal(append.evidence.proofKind,expectedKind);
      if(proofMode==='native'){assert.equal(append.evidence.nativeFastPath,true);assert.equal(append.evidence.readBytes,0);}
      assert.ok(append.evidence.timeline.some(row=>row.type==='sse-send'&&row.event==='usage-synced'));
      assert.ok(result.pageDelivery.rows.some(row=>row.kind==='page-receipt'&&row.event==='usage-synced'
        &&row.at>=append.appendStartedAtMs&&row.at<=append.endedAtMs));
    }
    const db=new DatabaseSync(prepared.databaseFile,{readOnly:true});
    try {assert.equal(db.prepare('SELECT count(*) n FROM events').get().n,4);
      assert.equal(db.prepare('SELECT sum(total) n FROM events').get().n,3030);
      assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');}finally{db.close();}
    for(const selected of Object.values(prepared.selected))assert.equal(hash(await readFile(selected.sourcePath)),selected.sourceSha256);
    assert.deepEqual(browser.errors,[]);assert.equal(result.pageDelivery.dropped,0);
    await browser.page.screenshot({path:path.join(directory,'page-final.png'),fullPage:true});
    result.functionalPassed=true;result.passed=true;
  }catch(error){result.failure={message:error.message,stack:error.stack};
    if(error.q5Delivery)result.pageDelivery=error.q5Delivery;}
  finally {
    await checkpoint();
    if(browser)try{await browser.browser.close();}catch(error){result.cleanupError=error.message;result.passed=false;}
    if(server)try{await tools.stopServer(server,result);}catch(error){result.cleanupError=error.message;result.passed=false;}
    else if(child?.exitCode===null)child.kill();
    try {
      result.privateTrace=q5PrivateRows(traceDirectory);assertQ5TraceCoverage(result.privateTrace);
      result.runtime=(await readFile(path.join(directory,'runtime.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
      assert.ok(result.runtime.some(row=>row.role==='gateway'&&row.execArgv.includes('--max-old-space-size=512')));
      const workers=result.runtime.filter(row=>row.role==='executor');assert.ok(workers.length>0);
      for(const worker of workers){assert.equal(worker.execArgv.filter(arg=>arg.startsWith('--max-old-space-size=')).at(-1),'--max-old-space-size=224');
        assert.ok(worker.execArgv.includes('--max-semi-space-size=4'));}
      result.sourceAfter=await sourceHashes(variant);result.codeStable=JSON.stringify(result.sourceAfter)===JSON.stringify(result.sourceBefore);
      assert.equal(result.codeStable,true,'Code changed during smoke; rerun after notification edits settle.');
      readCapturedPricing(pricingFile,matrix.pricing.catalogSha256);
    }catch(error){result.failure??={message:error.message,stack:error.stack};result.passed=false;}
    result.endedAt=new Date().toISOString();await save(file,result);
    console.log(JSON.stringify({variant,proofMode,passed:result.passed,codeStable:result.codeStable,appends:result.appends.length,failure:result.failure?.message,file}));
  }
  return result;
}

async function main() {
  const label=process.argv[2]||'q5-20261104-a';assert.match(label,/^q5-[a-z0-9-]+$/);
  const run=process.argv[3]||`smoke-${new Date().toISOString().replace(/\D/g,'')}-${process.pid}`;assert.match(run,/^[a-z0-9-]+$/);
  const matrixFile=path.join(Q5_ROOT,label,'matrix.json'),matrix=await read(matrixFile);assert.equal(matrix.prepared,true);
  const base=path.join(Q5_ROOT,'browser-smoke',run);assert.ok(inside(Q5_ROOT,base));await mkdir(base,{recursive:true});
  await assert.rejects(stat(path.join(base,'result.json')),error=>error.code==='ENOENT');
  await verifyQ5Frozen();readCapturedPricing(matrix.pricing.file,matrix.pricing.catalogSha256);
  const pricingFile=path.join(base,'captured-pricing.json');await copyFile(matrix.pricing.file,pricingFile);
  registerHooks(q5DiagnosticHook);const tools=await import('./b2-page-diagnostic.mjs');
  const result={kind:'q5-browser-smoke',timingSample:false,matrixFile,pricing:{file:pricingFile,catalogSha256:matrix.pricing.catalogSha256},cells:[]};
  for(const variant of ['baseline','candidate'])for(const mode of ['sha','native']) {
    result.cells.push(await runCell(base,variant,mode,matrix,pricingFile,tools));await save(path.join(base,'result.json'),result);
  }
  result.passed=result.cells.every(cell=>cell.passed)&&result.cells.length===4;
  const candidates=result.cells.filter(cell=>cell.variant==='candidate');
  if(JSON.stringify(candidates[0].sourceBefore)!==JSON.stringify(candidates[1].sourceBefore)) {
    result.passed=false;result.failure='Candidate code differed between SHA/native cells; rerun after edits settle.';
  }
  result.pageCells=4;result.appends=result.cells.reduce((n,cell)=>n+cell.appends.length,0);
  await save(path.join(base,'result.json'),result);
  console.log(JSON.stringify({passed:result.passed,cells:4,appends:result.appends,timingSample:false,file:path.join(base,'result.json')}));
  if(!result.passed)process.exitCode=1;
}

if(process.argv[2]==='--serve-smoke') {
  const config=path.resolve(process.argv[3]),runtime=path.join(path.dirname(config),'runtime.jsonl');
  appendFileSync(runtime,JSON.stringify({role:'gateway',pid:process.pid,execArgv:process.execArgv,heapLimitBytes:v8.getHeapStatistics().heap_size_limit})+'\n');
  const fork=childProcess.fork;
  childProcess.fork=(...args)=>{const child=Reflect.apply(fork,childProcess,args);
    appendFileSync(runtime,JSON.stringify({role:'executor',pid:child.pid,ppid:process.pid,module:args[0],execArgv:args[2]?.execArgv})+'\n');return child;};
  syncBuiltinESMExports();const {serveMain}=await import('./b2-page-diagnostic.mjs');await serveMain(config);
}else if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
