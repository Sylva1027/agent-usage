import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { createReadStream,createWriteStream } from "node:fs";
import { appendFile, copyFile, cp, mkdir, open, readFile, readdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath,pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { createInterface } from "node:readline";
import { ROOT,BASE,read,datasetOptions,diskBudget } from "./c1-datasets.mjs";
import { browser,stop,expectedAll } from "./c1-run.mjs";
import { waitForServer,painted } from "./b2-page-diagnostic.mjs";
import { projectionStorage } from "./c1-telemetry.mjs";
import { prepareStabilityMutations,appendStabilityMutation,reviseStabilityMutation,restoreStabilityMutations } from "./windows-stability-mutations.mjs";
import { stabilitySchedule,closeoutSchedule,CLOSEOUT_PROFILE,STABILITY_KINDS,quantiles,protectionPassed } from "./windows-stability-schedule.mjs";
import { correctResourceIdentity,parseResourceSample,resourceSnapshotRows } from "./resource-identity-analysis.mjs";
import { measureChild } from "./archive-compaction-packages.mjs";

const SELF=fileURLToPath(import.meta.url),HERE=path.dirname(SELF);
const SERVER=path.join(HERE,"windows-stability-server.mjs");
export const RESULT=path.join(ROOT,"output/windows-stability-20261109");
const FORMAL=path.join(RESULT,"formal-v2");
const COMPACTION=path.join(ROOT,"output/archive-compaction-20261108");
export const RECOVERY_RESULT=path.join(ROOT,"output/windows-stability-recovery-20261109");
export const MULTITAB_RESULT=path.join(ROOT,"output/windows-multitab-20261109");
export const CLOSEOUT_RESULT=path.join(ROOT,"output/windows-parallel-20261109");
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fieldNames=["total","input","cached","output","reasoning"];
const family=kind=>["main","extra","jetbrains"].includes(kind)?"codex":kind;
const channelKind={Codex:"codex",DSH:"dsh",Claude:"claude",WorkBuddy:"workbuddy",ZCode:"zcode",OpenCode:"opencode"};
let activeContext;

function createContext(values){
  return {...values,rangeCache:new Map(),inputs:[],bodies:[],responseTasks:new Set(),failures:[],pages:[],responseSequence:0,navigationSequence:0,
    resourceTails:[],resourceSummary:{samples:0,sampledPeakBytes:0,browserPeakBytes:0,writeBytes:0,readBytes:0,cpuSeconds:0,observerCpuSeconds:0,peakStorageBytes:0,peakWalBytes:0,idle:[],excluded:[]},
    actionTasks:new Set(),oracleChildren:new Set(),lastActivityAtMs:Date.now(),serverGeneration:0,uiTail:Promise.resolve(),closing:false};
}

export class LineTail {
  offset=0;rest="";decoder=new StringDecoder("utf8");
  constructor(file){this.file=file;}
  async read(){
    let size;try{size=(await stat(this.file)).size;}catch(error){if(error.code==="ENOENT")return [];throw error;}
    assert.ok(size>=this.offset,"Telemetry file was truncated");
    if(size===this.offset)return [];
    const handle=await open(this.file,"r");let text=this.rest;
    try{while(this.offset<size){const buffer=Buffer.alloc(Math.min(size-this.offset,2*1024*1024));const {bytesRead}=await handle.read(buffer,0,buffer.length,this.offset);if(!bytesRead)break;this.offset+=bytesRead;text+=this.decoder.write(buffer.subarray(0,bytesRead));}}
    finally{await handle.close();}
    const lines=text.split("\n");this.rest=lines.pop();return lines.filter(Boolean);
  }
}

async function startSampler(context,suffix=""){
  const target=path.join(context.directory,`resources${suffix}`);await mkdir(target);
  const stopFile=path.join(target,"stop"),args=["-NoProfile","-File",path.join(HERE,"windows-stability-resource.ps1"),"-ResultDir",target,
    "-ServicePid",String(context.server.ready.pid),"-RunnerPid",String(process.pid),"-StateDir",context.state,"-TempDir",path.join(context.directory,"temp"),
    "-StopFile",stopFile,"-SampleIntervalMilliseconds","250"];
  const child=spawn("pwsh",args,{cwd:ROOT,windowsHide:true,stdio:["ignore","pipe","pipe"]});let stderr="";child.stdout.resume();child.stderr.on("data",bytes=>stderr+=bytes);
  const ended=new Promise(resolve=>child.once("exit",resolve));const tail=new LineTail(path.join(target,"resources.ndjson"));
  tail.servicePid=context.server.ready.pid;
  const deadline=Date.now()+30_000;
  try{
    while(Date.now()<deadline){try{if((await stat(tail.file)).size)break;}catch(error){if(error.code!=="ENOENT")throw error;}assert.equal(child.exitCode,null,stderr);await pause(100);}
    assert.ok(Date.now()<deadline,"Sampler failed to start");
  }catch(error){child.kill();throw error;}
  context.resourceTails.push(tail);
  return {async stop(){await writeFile(stopFile,"stop");const timer=setTimeout(()=>child.kill(),30_000);try{assert.equal(await ended,0,stderr);}finally{clearTimeout(timer);}}};
}

async function save(file,value) {
  await mkdir(path.dirname(file),{recursive:true});
  const temporary=`${file}.${process.pid}.tmp`;
  await writeFile(temporary,JSON.stringify(value,null,2)+"\n",{flush:true});await rename(temporary,file);
}
async function log(context,type,details={}) {
  await appendFile(path.join(context.directory,"events.ndjson"),JSON.stringify({...details,atMs:Date.now(),type})+"\n");
}

function mutationSessions(ledger,seed){
  return new Map(ledger.plans.map(plan=>[plan.kind,plan.deliveryPlan?.original?.sessionId??ledger.byKind[plan.kind].sessionId??
    seed.prepare("SELECT session_id FROM events WHERE source_path=? ORDER BY timestamp_ms DESC LIMIT 1").get(plan.filePath).session_id]));
}

function visibleInputs(context,body) {
  const counts=Object.fromEntries(STABILITY_KINDS.map(kind=>[kind,0]));
  for(const home of body.metadata.homes) {
    const kind=family(home.kind);if(Object.hasOwn(counts,kind))counts[kind]+=home.eventCount;
  }
  const entries=[];
  for(const kind of STABILITY_KINDS) {
    const base=context.dataset.expected.find(row=>family(row.kind)===kind)?.events??0;
    const count=counts[kind]-base;
    assert.ok(Number.isSafeInteger(count)&&count>=0,`Invalid published count for ${kind}`);
    const available=context.ledger.entries.filter(row=>row.operation==="append"&&row.kind===kind);
    assert.ok(count<=available.length,`Published ${kind} input is absent from the ledger`);
    counts[kind]=count;entries.push(...available.slice(0,count));
  }
  const base=expectedAll(context.dataset),appends=entries.length;
  assert.equal(body.metadata.eventCount,base.events+appends,"metadata mixes fact versions");
  assert.equal(body.metadata.sessionCount,base.sessions,"existing-session append changed global deduplication");
  const revisionDelta=body.periodComparison.totals.all.total-base.total-appends*160;
  const revisions=context.ledger.entries.filter(row=>row.operation==="revision");
  let sum=0,chosen=revisionDelta===0?0:-1;
  for(const [i,row] of revisions.entries()){sum+=row.outputDelta;if(sum===revisionDelta)chosen=i+1;}
  assert.ok(chosen>=0,`Unexplained published total delta ${revisionDelta}`);
  entries.push(...revisions.slice(0,chosen));
  return {counts,entries,revisionCount:chosen};
}

function expectedWindow(context,body,visible) {
  const range=body.summary.range;
  const start=Date.parse(range.start),end=Date.parse(range.end);
  assert.ok(Number.isFinite(start)&&Number.isFinite(end));
  const key=`${start}:${end}`;
  let base=context.rangeCache.get(key);
  if(!base){
    if(range.preset==="all")base={...expectedAll(context.dataset),present:[...context.selectedSessions.values()]};
    else {
      const db=context.seed;
      base={...db.prepare(`SELECT COUNT(*) events,COUNT(DISTINCT session_id) sessions,${fieldNames.map(field=>`COALESCE(SUM(${field}),0) ${field}`).join(",")} FROM events WHERE timestamp_ms>=? AND timestamp_ms<=?`).get(start,end)};
      const ids=[...new Set(context.selectedSessions.values())];
      base.present=db.prepare(`SELECT DISTINCT session_id FROM events WHERE timestamp_ms>=? AND timestamp_ms<=? AND session_id IN (${ids.map(()=>"?").join(",")})`).all(start,end,...ids).map(row=>row.session_id);
    }
    context.rangeCache.set(key,base);
  }
  const expected={...base},sessions=new Set(base.present);
  for(const entry of visible.entries){
    if(entry.timestampMs<start||entry.timestampMs>end)continue;
    expected.total+=entry.expectedDelta;
    if(entry.operation==="append"){
      expected.events++;for(const field of fieldNames.filter(field=>field!=="total"))expected[field]+=entry.deltaTokens[field];
      sessions.add(context.selectedSessions.get(entry.kind));
    }else expected.output+=entry.outputDelta;
  }
  expected.sessions=base.sessions+sessions.size-new Set(base.present).size;
  return expected;
}

function checkResponse(context,body) {
  assert.equal(body.summary.timelineError,null);
  const visible=visibleInputs(context,body),expected=expectedWindow(context,body,visible);
  assert.equal(body.summary.eventCount,expected.events,"range event count");
  assert.equal(body.summary.sessionCount,expected.sessions,"range distinct sessions");
  for(const field of fieldNames)assert.equal(body.summary.totals[field],expected[field],`range ${field}`);
  if(body.summary.range.preset==="all")for(const channel of body.summary.channels){
    const kind=channelKind[channel.key];assert.ok(kind,`Unknown channel ${channel.key}`);
    const original=context.dataset.expected.find(row=>family(row.kind)===kind);
    const n=visible.counts[kind],delta=kind==="zcode"?visible.entries.filter(row=>row.operation==="revision").reduce((sum,row)=>sum+row.outputDelta,0):0;
    assert.equal(channel.count,original.events+n,`${kind} count`);
    assert.equal(channel.total.total,original.total+n*160+delta,`${kind} total`);
  }
  return visible;
}

function registerControlledExit(context,receipt){
  assert.ok(Number.isSafeInteger(receipt.pid)&&receipt.pid>0&&Number.isFinite(receipt.killedAtMs));
  assert.ok(receipt.commandId&&["before-commit","after-commit-before-notify"].includes(receipt.point));
  (context.controlledExits??=[]).push({...receipt});
}

function matchingControlledExit(context,response,body){
  if(response.status()!==500||body?.code!=="EXECUTOR_EXITED")return null;
  const start=context.requestStarts?.get(response.request());
  if(!Number.isFinite(start))return null;
  return [...(context.controlledExits??[])].reverse().find(row=>start<=row.killedAtMs&&Date.now()-row.killedAtMs<=300_000)??null;
}

async function waitUsageResponse(context,page,preset,total,timeoutMs=300_000){
  return page.waitForResponse(async response=>{
    const url=new URL(response.url());
    if(url.pathname!=="/api/usage"||url.searchParams.get("preset")!==preset)return false;
    if(response.status()===200)return total===undefined||(await response.json()).summary?.totals?.total===total;
    const body=await response.json(),fault=matchingControlledExit(context,response,body);
    assert.ok(fault,JSON.stringify({status:response.status(),body}));
    await log(context,"waiting-for-fault-recovery",{commandId:fault.commandId,pid:fault.pid,preset});return false;
  },{timeout:timeoutMs});
}

async function stabilityScope(context,page,preset,total,directory,name=preset){
  const startedAtMs=Date.now(),pending=waitUsageResponse(context,page,preset,total);void pending.catch(()=>{});
  await page.locator(`[data-preset="${preset}"]`).click();
  const response=await pending,body=await response.json();
  await painted(page,body.summary.totals.total,300_000);
  const result={preset,wallMs:Date.now()-startedAtMs,startedAtMs,endedAtMs:Date.now(),total:body.summary.totals.total,
    events:body.summary.eventCount,cache:response.headers()["x-summary-cache"]};
  await save(path.join(directory,`${name}.json`),body);return {result,body};
}

async function attachPage(context,page) {
  context.requestStarts??=new WeakMap();
  page.on("pageerror",error=>context.failures.push({atMs:Date.now(),type:"pageerror",message:String(error)}));
  page.on("request",request=>{if(new URL(request.url()).pathname==="/api/usage"){context.lastActivityAtMs=Date.now();context.requestStarts.set(request,Date.now());}});
  page.on("response",response=>{
    const url=new URL(response.url());if(url.pathname!=="/api/usage")return;
    context.lastActivityAtMs=Date.now();
    const pending=(async()=>{
      const receivedAtMs=Date.now();
      if(response.status()!==200){
        const body=await response.json(),fault=matchingControlledExit(context,response,body);
        await log(context,"http-error",{status:response.status(),code:body.code,url:url.pathname+url.search,
          requestStartedAtMs:context.requestStarts.get(response.request())??null,controlledFaultId:fault?.commandId??null});
        assert.ok(fault,`Unexpected usage HTTP error: ${JSON.stringify(body)}`);return;
      }
      const body=await response.json();
      const visible=checkResponse(context,body),sequence=++context.responseSequence;
      await save(path.join(context.directory,"responses",`${String(sequence).padStart(5,"0")}.json`),body);
      const row={atMs:receivedAtMs,page:context.pages.indexOf(page),sequence,preset:body.summary.range.preset,total:body.summary.totals.total,
        range:{start:body.summary.range.start,end:body.summary.range.end},usageVersion:body.usageVersion,fingerprint:body.fingerprint,counts:visible.counts,revisionCount:visible.revisionCount,body};
      context.bodies.push(row);if(context.bodies.length>32)context.bodies.shift();
      context.lastBody=row;
      await log(context,"response",{...row,body:undefined});
    })().catch(error=>context.failures.push({atMs:Date.now(),type:"response-check",message:error.message,stack:error.stack}));
    context.responseTasks.add(pending);void pending.finally(()=>{context.responseTasks.delete(pending);context.lastActivityAtMs=Date.now();});
  });
}

async function launchServer(context,suffix="",port=0) {
  assert.ok(!context.closing,"Context is closing");
  const directory=context.directory,token=randomUUID(),configFile=path.join(directory,`server${suffix}.json`);
  const trace=path.join(directory,"nodes"),temp=path.join(directory,"temp");await mkdir(trace,{recursive:true});await mkdir(temp,{recursive:true});
  await save(configFile,{runtime:context.runtime,port,options:{...datasetOptions(context.dataset.home,context.state),shutdownToken:token}});
  const env={...process.env,REMAINING_DELIVERY_TRACE:trace,TEMP:temp,TMP:temp,WINDOWS_STABILITY_CONTROL_DIR:context.control,
    C1_ARCHIVE_TRACE:"1",C1_METHOD_DIAGNOSTIC:"1"};
  delete env.NODE_OPTIONS;delete env.C1_BUSINESS_CLOCK_FILE;
  const startedAtMs=Date.now();
  const child=spawn(process.execPath,["--max-old-space-size=512","--import",pathToFileURL(path.join(HERE,"c1-telemetry.mjs")).href,
    "--import",pathToFileURL(path.join(HERE,"windows-stability-hook.mjs")).href,SERVER,configFile],{cwd:ROOT,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  child.stdout.pipe(createWriteStream(path.join(directory,`stdout${suffix}.log`)));child.stderr.pipe(createWriteStream(path.join(directory,`stderr${suffix}.log`)));
  try{
    const server={child,ready:await waitForServer(child),token,startedAtMs};
    if(context.closing){await stop(server);throw Error("Context closed during server startup");}return server;
  }catch(error){child.kill();throw error;}
}

async function loadPage(context,page=context.ui.page) {
  const pending=waitUsageResponse(context,page,"today");void pending.catch(()=>{});
  await page.goto(context.server.ready.url,{waitUntil:"domcontentloaded"});
  const response=await pending;assert.equal(response.status(),200,await response.text());
  await painted(page,(await response.json()).summary.totals.total,1_800_000);
  if(context.profile===CLOSEOUT_PROFILE)await log(context,"startup-today",{page:context.pages.indexOf(page),startedAtMs:context.server.startedAtMs,wallMs:Date.now()-context.server.startedAtMs});
  await stabilityScope(context,page,"all",context.requiredAllTotal,context.directory,`initial-all-${++context.navigationSequence}`);
  if(context.profile===CLOSEOUT_PROFILE)await log(context,"startup-all",{page:context.pages.indexOf(page),startedAtMs:context.server.startedAtMs,wallMs:Date.now()-context.server.startedAtMs});
}

async function pollBrowser(context) {
  for(const page of context.pages){
    if(page.isClosed())continue;
    let observed;
    try{observed=await page.evaluate(()=>({rows:window.__q5Delivery?.rows.splice(0)??[],dropped:window.__q5Delivery?.dropped??0}));}
    catch(error){if(page.isClosed())continue;throw error;}
    assert.equal(observed.dropped,0,"browser delivery evidence truncated");
    await Promise.all(context.responseTasks);
    for(const row of observed.rows){
      await log(context,"browser",{page:context.pages.indexOf(page),...row});
      if(row.kind!=="paint")continue;
      const total=Number(String(row.total).replace(/[^0-9]/g,""));
      const pageIndex=context.pages.indexOf(page);
      const body=[...context.bodies].reverse().find(value=>value.page===pageIndex&&value.total===total&&value.usageVersion&&value.atMs<=row.clock+1000);
      if(!body)continue;
      for(const input of context.inputs){
        if(row.clock<input.landedAtMs)continue;
        const included=input.operation==="append"?body.counts[input.kind]>=input.kindCount:
          body.revisionCount>=input.revisionIndex&&body.usageVersion!==input.beforeVersion;
        if(!included)continue;
        const range=body.body?.summary?.range,withinView=body.preset==="all"||input.operation==="append"&&
          input.timestampMs>=Date.parse(range?.start)&&input.timestampMs<=Date.parse(range?.end);
        // Range navigation must not turn an already painted fresh value into a publication timeout.
        if(!input.viewVisibleAtMs&&withinView){Object.assign(input,{viewVisibleAtMs:row.clock,viewLandingToPaintMs:row.clock-input.landedAtMs,
          viewPreset:body.preset,viewPage:pageIndex,viewResponseSequence:body.sequence,viewUsageVersion:body.usageVersion});await log(context,"view-visible",input);}
        if(!input.paintedAtMs&&body.preset==="all"){Object.assign(input,{paintedAtMs:row.clock,paintedPage:pageIndex,landingToPaintMs:row.clock-input.landedAtMs,responseSequence:body.sequence,usageVersion:body.usageVersion});context.lastActivityAtMs=Math.max(context.lastActivityAtMs,row.clock);await log(context,"input-visible",input);}
      }
    }
  }
}

async function verifyFull(context,name) {
  for(let attempt=0;attempt<3;attempt++){
  await Promise.all(context.responseTasks);
  const row=[...context.bodies].reverse().find(value=>value.preset==="all");assert.ok(row,"all response missing");
  const cost=row.body.summary.costEstimate;
  await context.ui.page.waitForFunction(async expected=>{
    const {formatCostAmount}=await import("/app.js");
    const tokens=Number(String(document.querySelector("#totalTokens")?.title).replace(/[^0-9]/g,""));
    return tokens===expected.total&&document.querySelector("#totalCost")?.textContent===formatCostAmount((expected.usd??0)+(expected.cny??0)/expected.rate,"USD");
  },{total:row.body.summary.totals.total,usd:cost.totalUsd,cny:cost.totalCny,rate:row.body.pricingCatalog.usdToCnyRate},{timeout:300_000});
  const label=`${name}-${attempt}`,config=path.join(context.directory,`oracle-${label}.json`),result=path.join(context.directory,`oracle-${label}-result.json`);
  const expectedDelta={total:0,input:0,cached:0,output:0,reasoning:0,events:0,sessions:0};
  for(const entry of visibleInputs(context,row.body).entries){expectedDelta.total+=entry.expectedDelta;
    if(entry.operation==="append"){expectedDelta.events++;for(const field of fieldNames.filter(field=>field!=="total"))expectedDelta[field]+=entry.deltaTokens[field];}
    else expectedDelta.output+=entry.outputDelta;
  }
  await save(config,{body:row.body,dataset:{home:context.dataset.home,expected:context.dataset.expected,expectedSessions:context.dataset.expectedSessions},state:context.state,expectedDelta,output:result});
  const child=spawn(process.execPath,["--max-old-space-size=224",path.join(HERE,"windows-stability-oracle.mjs"),config],{cwd:ROOT,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  context.oracleChildren.add(child);child.once("exit",()=>context.oracleChildren.delete(child));
  child.stdout.pipe(createWriteStream(path.join(context.directory,`oracle-${label}.log`)));child.stderr.pipe(createWriteStream(path.join(context.directory,`oracle-${label}-stderr.log`)));
  const code=await new Promise((resolve,reject)=>{child.once("exit",resolve);child.once("error",reject);});assert.equal(code,0,`Independent oracle ${name} failed`);
  const receipt=await read(result);await log(context,"oracle",{name,attempt,result:receipt});
  if(receipt.retry){await stabilityScope(context,context.ui.page,"all",undefined,context.directory,`oracle-retry-${label}`);continue;}
  assert.equal(receipt.passed,true);return receipt;
  }
  throw Error(`Oracle publication did not stabilize: ${name}`);
}

async function recoverAppendLedger(directory,expectedCount,withRevision=false){
  const ledger=await read(path.join(directory,"mutations/ledger.json"));
  assert.equal(ledger.appendCount,0);assert.equal(ledger.entries.length,0);
  for await(const line of createInterface({input:createReadStream(path.join(ledger.directory,"mutations.ndjson")),crlfDelay:Infinity})){
    if(!line.trim())continue;const row=JSON.parse(line);assert.ok(row.operation==="append"||withRevision&&row.operation==="revision");
    const own=ledger.byKind[row.kind],counter=row.operation==="append"?"appendCount":"revisionCount";
    if(row.operation==="append")own.ordinals.push(row.ordinal);own[counter]++;ledger[counter]++;ledger.entries.push(row);
    const delta={...row.deltaTokens,total:row.expectedDelta,events:row.expectedEventDelta,sessions:row.deltaSessions};
    for(const [field,value] of Object.entries(delta)){ledger.expected[field]+=value;own.expected[field]+=value;}
    if(row.cumulative)own.cumulative=row.cumulative;if(row.seq!==undefined){own.seq=row.seq;own.turn=row.turn;}
  }
  assert.equal(ledger.appendCount,expectedCount);
  if(withRevision){
    assert.equal(ledger.revisionCount,1);
    const plan=ledger.plans.find(row=>row.kind==="zcode"),db=new DatabaseSync(plan.filePath,{readOnly:true});
    try{
      const row={...db.prepare("SELECT * FROM model_usage WHERE id=?").get(plan.deliveryPlan.original.raw.id)},original=plan.deliveryPlan.original.raw;
      const delta=ledger.entries.filter(entry=>entry.operation==="revision").reduce((sum,entry)=>sum+entry.outputDelta,0);
      assert.equal(Number(row.output_tokens),Number(original.output_tokens)+delta);
      ledger.byKind.zcode.revisedRaw=row;
    }finally{db.close();}
  }
  return ledger;
}

async function retainedLedger(snapshotFile,mutationsFile){
  const ledger=await read(snapshotFile),seen=new Set(ledger.entries.map(row=>`${row.operation}/${row.ordinal}`));
  const baseCounts={appendCount:ledger.appendCount,revisionCount:ledger.revisionCount};
  assert.equal(seen.size,ledger.entries.length,"Duplicate retained input");
  if(mutationsFile)for await(const line of createInterface({input:createReadStream(mutationsFile),crlfDelay:Infinity})){
    if(!line.trim())continue;const row=JSON.parse(line);
    assert.ok(["append","revision"].includes(row.operation));
    assert.ok(!seen.has(`${row.operation}/${row.ordinal}`),"Duplicate continuation input");seen.add(`${row.operation}/${row.ordinal}`);
    const own=ledger.byKind[row.kind],counter=row.operation==="append"?"appendCount":"revisionCount";
    assert.ok(Number.isSafeInteger(row.ordinal)&&row.ordinal>baseCounts[counter],"Continuation ordinal overlaps snapshot");
    if(row.operation==="append")own.ordinals.push(row.ordinal);own[counter]++;ledger[counter]++;ledger.entries.push(row);
    const delta={...row.deltaTokens,total:row.expectedDelta,events:row.expectedEventDelta,sessions:row.deltaSessions};
    for(const [field,value] of Object.entries(delta)){ledger.expected[field]+=value;own.expected[field]+=value;}
    if(row.cumulative)own.cumulative=row.cumulative;if(row.seq!==undefined){own.seq=row.seq;own.turn=row.turn;}
  }
  for(const operation of ["append","revision"]){
    const count=ledger[operation==="append"?"appendCount":"revisionCount"],rows=ledger.entries.filter(row=>row.operation===operation);
    assert.equal(rows.length,count);assert.deepEqual(rows.map(row=>row.ordinal).sort((a,b)=>a-b),Array.from({length:count},(_,i)=>i+1),"Continuation ordinal gap");
  }
  assert.ok(!ledger.restoredAtMs&&!ledger.restoring,"Retained sources were already restored");return ledger;
}

function multitabSchedule(){
  return {version:1,mode:"multitab-local",label:"two-years",durationMs:300_000,appendCount:2,events:[
    {atMs:0,type:"append",kind:"codex",ordinal:1,category:"ordinary",id:"multitab-codex"},
    {atMs:0,type:"tabs-open",id:"multitab-tabs"},
    {atMs:0,type:"scopes",id:"multitab-scopes"},
    {atMs:60_000,type:"arm-before-commit",id:"multitab-before"},
    {atMs:120_000,type:"append",kind:"dsh",ordinal:2,category:"ordinary-during-arm-before-commit",id:"multitab-dsh"},
  ]};
}

async function recoverPaintInputs(context){
  const rows=[];
  for await(const line of createInterface({input:createReadStream(path.join(context.directory,"events.ndjson")),crlfDelay:Infinity}))if(line.trim())rows.push(JSON.parse(line));
  context.inputs=rows.filter(row=>row.type==="input-landed").map(({type,atMs,...row})=>row);
  const prior=(await read(path.join(context.directory,"result-diagnostic.json"))).inputs;
  for(const input of context.inputs)Object.assign(input,prior.find(row=>row.eventId===input.eventId)??{});
  const responses=rows.filter(row=>row.type==="response"&&row.preset==="all");
  const corrected=[];
  for(const paint of rows.filter(row=>row.type==="browser"&&row.page===0&&row.kind==="paint")){
    const total=Number(String(paint.total).replace(/[^0-9]/g,""));
    const response=[...responses].reverse().find(row=>row.total===total&&row.atMs<=paint.clock+1000);
    if(!response)continue;
    checkResponse(context,await read(path.join(context.directory,"responses",`${String(response.sequence).padStart(5,"0")}.json`)));
    for(const input of context.inputs){
      if(input.paintedAtMs||paint.clock<input.landedAtMs||response.counts[input.kind]<input.kindCount)continue;
      Object.assign(input,{paintedAtMs:paint.clock,landingToPaintMs:paint.clock-input.landedAtMs,responseSequence:response.sequence,usageVersion:response.usageVersion});
      corrected.push({...input});await log(context,"input-visible",input);
    }
  }
  const interrupted=context.inputs.filter(row=>!row.paintedAtMs);
  for(const input of interrupted)input.timingInterruption={reason:"Probe closed the service after missing an earlier valid paint; new input was already landing",atMs:Date.now()};
  await save(path.join(context.directory,"paint-order-correction.json"),{corrected,interrupted:interrupted.map(row=>row.eventId),standardsChanged:false});
}

async function correctYearIdle(directory,summary){
  const activity=[],requests=new Set();
  for await(const line of createInterface({input:createReadStream(path.join(directory,"events.ndjson")),crlfDelay:Infinity})){
    if(!line.trim())continue;const row=JSON.parse(line);if(row.type!=="browser")continue;const key=`${row.page}:${row.id}`;
    if(row.kind==="fetch-start"){
      if(new URL(row.url,"http://localhost").pathname==="/api/usage")requests.add(key);else requests.delete(key);
    }
    if(requests.has(key)&&row.kind.startsWith("fetch-"))activity.push(row.clock);
  }
  activity.sort((a,b)=>a-b);let next=0,last=-Infinity;
  const keep=new Map(summary.idle.map(row=>[row.atMs,row])),discarded=[];
  for await(const line of createInterface({input:createReadStream(path.join(directory,"resources/resources.ndjson")),crlfDelay:Infinity})){
    if(!line.trim())continue;const sample=correctResourceIdentity(parseResourceSample(line)).sample;
    while(next<activity.length&&activity[next]<=sample.atUnixMs)last=Math.max(last,activity[next++]);
    if(sample.processes.some(row=>row.role==="service"&&row.name.toLowerCase()==="node.exe"&&row.parentPid!==sample.treeMetadata.runnerPid))last=sample.atUnixMs;
    if(keep.has(sample.atUnixMs)&&(sample.service.processCount===0||sample.atUnixMs-last<60_000)){
      discarded.push({atMs:sample.atUnixMs,bytes:keep.get(sample.atUnixMs).bytes,reason:"query/executor activity within the prior 60 seconds, or service already stopped"});keep.delete(sample.atUnixMs);
    }
  }
  summary.idle=[...keep.values()];
  await save(path.join(directory,"idle-classification-correction.json"),{discarded,kept:summary.idle.length,limitBytes:256*1048576,standardsChanged:false});
  assert.ok(summary.idle.every(row=>row.bytes<=256*1048576),"Correctly idle sample exceeds budget");return summary;
}

async function prepareContext(label,{smoke=false,resume=false,restartEndurance=false}={}) {
  await diskBudget(64);
  const directory=path.join(smoke?RESULT:FORMAL,smoke?"smoke":"diagnostic",label);
  if(resume){assert.ok(["year","two-years"].includes(label));assert.equal((await read(path.join(directory,"result-diagnostic.json"))).passed,label==="year"||restartEndurance);}
  else await mkdir(directory,{recursive:false});
  const manifest=await read(path.join(COMPACTION,"manifest.json")),runtime=await read(manifest.candidateFile);
  const reuseUpgrade=!smoke&&label==="two-years";
  const dataset=await read(path.join(BASE,"datasets",label,"dataset.json")),state=reuseUpgrade?path.join(COMPACTION,"upgrades/two-years/state"):path.join(directory,"state"),seedDirectory=path.join(directory,"oracle-seed");
  if(!resume)await cp(path.join(dataset.root,"seed-state"),seedDirectory,{recursive:true,force:false,errorOnExist:true});
  if(resume)assert.equal(projectionStorage(state).databaseCount,1);
  else if(reuseUpgrade){assert.equal((await read(path.join(COMPACTION,"upgrades/two-years/result.json"))).passed,true);assert.equal(projectionStorage(state).databaseCount,1);}
  else {
    await cp(path.join(dataset.root,smoke?"seed-state":"seed-mixed"),state,{recursive:true,force:false,errorOnExist:true});
    if(!smoke){
      const config=path.join(directory,"prepare-state.json"),preparation=path.join(directory,"prepare-state");
      await save(config,{options:datasetOptions(dataset.home,state),runtime:runtime.directory,packages:manifest.compactPackages.filter(row=>row.label===label)});
      await measureChild(SERVER,["prepare-state",config,preparation],preparation,state);
    }
  }
  const control=path.join(directory,"control");if(!resume)await mkdir(control);
  const seed=new DatabaseSync(path.join(seedDirectory,"usage-index.sqlite"),{readOnly:true});
  const ledger=resume?await recoverAppendLedger(directory,label==="year"?7:restartEndurance?16:5,restartEndurance):await prepareStabilityMutations(dataset,path.join(directory,"mutations"),{databaseFile:path.join(seedDirectory,"usage-index.sqlite"),runtimeDirectory:runtime.directory});
  const selectedSessions=mutationSessions(ledger,seed);
  const context=createContext({directory,state,control,seed,seedDirectory,ledger,selectedSessions,runtime:runtime.directory,dataset,smoke});
  activeContext=context;
  if(resume){
    context.inputs=(await read(path.join(directory,"result-diagnostic.json"))).inputs;
    if(restartEndurance){
      context.inputs.push(...(await read(path.join(directory,"result-endurance-sessions-interruption.json"))).inputs);
      context.inputs=context.inputs.map(({type,atMs,...row})=>row);
    }
    context.responseSequence=Math.max(0,...(await readdir(path.join(directory,"responses"))).map(name=>Number(name.replace(/\.json$/,""))).filter(Number.isFinite));
    context.navigationSequence=restartEndurance?200:100;
    for(const name of ["closed.json","resource-summary.json"])await copyFile(path.join(directory,name),path.join(directory,`failed-${label==="year"?"idle":restartEndurance?"sessions":"paint"}-${name}`));
    context.resourceSummary=await read(path.join(directory,"resource-summary.json"));
    if(label==="year"){
      context.resourceSummary=await correctYearIdle(directory,context.resourceSummary);
      assert.equal(await stat(path.join(directory,"evidence-original.sqlite")).then(()=>true,error=>error.code==="ENOENT"?false:Promise.reject(error)),false,"This continuation expects the generated evidence database");
      context.evidence={file:path.join(dataset.home,".codex/logs_2.sqlite"),existing:false};
    }else if(!restartEndurance)await recoverPaintInputs(context);
  }
  await save(path.join(directory,restartEndurance?"preparation-sessions-resume.json":resume?"preparation-resume.json":"preparation.json"),{label,runtime:runtime.directory,state,stateOrigin:resume?`same ${label} state after probe interruption`:reuseUpgrade?"same physical primary and projection from completed two-year upgrade":"isolated seed copy",seedDirectory,ledgerFile:path.join(ledger.directory,"ledger.json"),startedAtMs:Date.now(),projection:projectionStorage(state)});
  context.ui=await browser();context.pages=[context.ui.page];await attachPage(context,context.ui.page);
  const suffix=restartEndurance?"-sessions-resume":resume?"-resume":"";
  context.server=await launchServer(context,suffix);context.sampler=await startSampler(context,suffix);await loadPage(context);
  await Promise.all(context.responseTasks);context.lastActivityAtMs=Date.now();return context;
}

async function pollResources(context) {
  for(const tail of context.resourceTails)for(const line of await tail.read()){
    const corrected=correctResourceIdentity(parseResourceSample(line)),sample=corrected.sample,summary=context.resourceSummary;
    const observed=resourceSnapshotRows(sample),activeBytes=observed.filter(row=>row.role==="service").reduce((sum,row)=>sum+(row.workingSetBytes??0),0);
    summary.samples++;summary.sampledPeakBytes=Math.max(summary.sampledPeakBytes,sample.service.workingSetBytes,activeBytes);
    summary.browserPeakBytes=Math.max(summary.browserPeakBytes,sample.browser.workingSetBytes);
    summary.cpuSeconds+=sample.service.cpuSecondsIncrement??0;summary.readBytes+=sample.service.logicalReadBytesIncrement??0;summary.writeBytes+=sample.service.logicalWriteBytesIncrement??0;
    summary.observerCpuSeconds=Math.max(summary.observerCpuSeconds,sample.observer?.cpuSeconds??0);
    summary.peakStorageBytes=Math.max(summary.peakStorageBytes,sample.state?.observedBytes??0);summary.peakWalBytes=Math.max(summary.peakWalBytes,sample.sqlite?.categoryBytes?.wal??0);
    summary.excluded.push(...corrected.excluded);
    const executorActive=observed.some(row=>row.role==="service"&&row.name?.toLowerCase()==="node.exe"&&row.pid!==tail.servicePid);
    if(executorActive)context.lastActivityAtMs=Math.max(context.lastActivityAtMs,sample.atUnixMs);
    if(Math.max(sample.service.workingSetBytes,activeBytes)>512*1048576)throw Error(`Service tree exceeded 512 MiB: ${Math.max(sample.service.workingSetBytes,activeBytes)}`);
    if(sample.service.processCount>0&&!executorActive&&!context.inputs.some(row=>!row.paintedAtMs)&&!context.actionTasks.size&&!context.responseTasks.size&&sample.atUnixMs-context.lastActivityAtMs>=60_000){
      const serviceRows=sample.processes.filter(row=>row.role==="service");
      const handles=serviceRows.every(row=>row.handleCount!==null&&row.handleCount!==undefined)?serviceRows.reduce((sum,row)=>sum+row.handleCount,0):null;
      summary.idle.push({atMs:sample.atUnixMs,bytes:sample.service.workingSetBytes,handles,tempFiles:sample.temp?.fileCount??null,
        ...(context.profile===CLOSEOUT_PROFILE?{walBytes:sample.sqlite?.categoryBytes?.wal??null,privateBytes:sample.service.privateBytes??null}: {})});
      if(sample.service.workingSetBytes>256*1048576)throw Error("Idle service tree exceeded 256 MiB");
    }
  }
}

async function checkDeadlines(context) {
  if(context.failures.length)throw Error(JSON.stringify(context.failures.at(-1)));
  const now=Date.now();
  for(const input of context.inputs)if(!input.viewVisibleAtMs&&!input.paintedAtMs){
    const allowance=input.category==="ordinary"?120_000:300_000;
    if(now-input.landedAtMs>allowance)throw Error(`Unpublished input exceeded ${allowance}ms: ${input.eventId}`);
  }
  await pollResources(context);
}

async function drain(context,deadlineMs=300_000,actionAllowance=0) {
  const deadline=Date.now()+deadlineMs;
  while(Date.now()<deadline&&!context.closing){
    await pollBrowser(context);await checkDeadlines(context);
    if(!context.inputs.some(row=>!row.paintedAtMs)&&context.actionTasks.size<=actionAllowance&&!context.responseTasks.size)return;
    await pause(500);
  }
  throw Error("Work did not drain within 300 seconds");
}

async function control(context,name,value) {
  const file=path.join(context.control,`${name}.json`);
  assert.equal(await stat(file).then(()=>true,error=>error.code==="ENOENT"?false:Promise.reject(error)),false,"Control already armed");
  await save(file,value);await log(context,"control-armed",{name,...value});
}

async function killOwnedTree(server) {
  assert.equal(server.child.exitCode,null,"Owned gateway already exited");
  const child=spawn("taskkill",["/PID",String(server.child.pid),"/T","/F"],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let text="";child.stdout.on("data",bytes=>text+=bytes);child.stderr.on("data",bytes=>text+=bytes);
  assert.equal(await new Promise(resolve=>child.once("exit",resolve)),0,text);
}

async function awaitFault(context,event,gateway) {
  const tails=new Map(),deadline=Date.now()+300_000;
  while(Date.now()<deadline&&!context.closing){
    for(const name of await readdir(context.control))if(/^events-\d+\.ndjson$/.test(name)){
      if(!tails.has(name))tails.set(name,new LineTail(path.join(context.control,name)));
      for(const line of await tails.get(name).read()){
        const row=JSON.parse(line);if(row.event!=="fault-parked"||row.commandId!==event.id)continue;
        assert.equal(row.role,"executor");assert.equal(row.ppid,context.server.ready.pid,"Fault target must be the current gateway's child");
        await log(context,"fault-observed",row);
        if(gateway){
          const port=context.server.ready.port;await killOwnedTree(context.server);await context.sampler.stop();if(context.closing)return;
          context.server=await launchServer(context,`-recovery-${++context.serverGeneration}`,port);context.sampler=await startSampler(context,`-recovery-${context.serverGeneration}`);
          await log(context,"gateway-restarted",{pid:context.server.ready.pid,port});
        } else {
          process.kill(row.pid,"SIGKILL");registerControlledExit(context,{pid:row.pid,point:row.point,commandId:event.id,killedAtMs:Date.now(),gatewayPid:row.ppid});
          await log(context,"executor-killed",{pid:row.pid,point:row.point,commandId:event.id});
        }
        return;
      }
    }
    await pause(100);
  }
  if(!context.closing)throw Error(`Fault point was never reached: ${event.id}`);
}

async function runScopes(context,event) {
  const page=context.ui.page;
  for(const preset of ["today","week"]){const row=await stabilityScope(context,page,preset,undefined,context.directory,`${event.id}-${preset}`);await log(context,"scope",{eventId:event.id,...row.result});}
  const start=new Date(context.dataset.endMs-32*86_400_000).toISOString().slice(0,10),end=new Date(context.dataset.endMs-28*86_400_000).toISOString().slice(0,10);
  const customStartedAtMs=Date.now();
  await page.locator("#dateRangeButton").click();
  for(const date of [start,end]){
    for(let i=0;!(await page.locator(`[data-date="${date}"]`).count());i++){
      assert.ok(i<36,"Custom calendar navigation exceeded history");
      const visible=await page.locator(".date-picker-day:not(.outside-month)").first().getAttribute("data-date");
      await page.locator(`[data-date-picker-action="${date<visible?"prev":"next"}"]`).click();
    }
    const pending=date===end?waitUsageResponse(context,page,"custom"):null;void pending?.catch(()=>{});await page.locator(`[data-date="${date}"]`).click();
    if(pending){const response=await pending;assert.equal(response.status(),200);const body=await response.json();await painted(page,body.summary.totals.total,300_000);
      if(context.profile===CLOSEOUT_PROFILE)await log(context,"scope",{eventId:event.id,preset:"custom",wallMs:Date.now()-customStartedAtMs,startedAtMs:customStartedAtMs,endedAtMs:Date.now()});}
  }
  const all=await stabilityScope(context,page,"all",undefined,context.directory,`${event.id}-all`);await log(context,"scope",{eventId:event.id,...all.result});
}

async function changePrice(context,restore) {
  const changedAtMs=Date.now();
  const response=await fetch(context.server.ready.url+"/api/pricing");assert.equal(response.status,200);const catalog=await response.json();
  context.originalCatalog??=structuredClone(catalog);
  const next=structuredClone(restore?context.originalCatalog:catalog);
  next.version=catalog.version;
  if(!restore){
    const model=next.models["gpt-6-sol"]??next.models[Object.keys(next.models)[0]];
    assert.ok(model?.short,"Real priced model missing");
    for(const name of ["input","cachedInput","cacheWrite","output"])if(Number.isFinite(model.short[name]))model.short[name]*=1.125;
    next.usdToCnyRate+=.01;
  }
  const updated=await fetch(context.server.ready.url+"/api/pricing",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(next)});
  const text=await updated.text();assert.equal(updated.status,200,text);const savedCatalog=JSON.parse(text);
  await log(context,restore?"price-restored":"price-changed",{previousVersion:catalog.version,version:savedCatalog.version});
  const deadline=Date.now()+300_000;
  while(Date.now()<deadline&&!context.closing){
    if(context.bodies.some(row=>row.preset==="all"&&row.body.pricingCatalog.version===savedCatalog.version&&row.atMs>=changedAtMs)){
      await verifyFull(context,`price-${restore?"restore":"change"}-${Date.now()}`);return;
    }
    await pause(250);
  }
  throw Error("Changed pricing was not published within 300 seconds");
}

async function changeEvidence(context,restore) {
  const changedAtMs=Date.now(),beforeVersion=context.lastBody?.usageVersion;
  const file=path.join(context.dataset.home,".codex/logs_2.sqlite");
  if(!context.evidence){
    const existing=await stat(file).then(()=>true,error=>error.code==="ENOENT"?false:Promise.reject(error));
    const backup=path.join(context.directory,"evidence-original.sqlite");if(existing)await copyFile(file,backup);
    context.evidence={file,backup,existing,mtimeMs:existing?(await stat(file)).mtimeMs:null};
  }
  const db=new DatabaseSync(file);
  try{
    db.exec("CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY,ts INTEGER,ts_nanos INTEGER,thread_id TEXT,target TEXT,feedback_log_body TEXT)");
    if(restore){assert.ok(context.evidence.rowId);db.prepare("DELETE FROM logs WHERE id=?").run(context.evidence.rowId);}
    else {
      const session=context.selectedSessions.get("codex"),at=Date.now()-86_400_000;
      const text='Submission sub=Submission { id: "windows-stability", op: TurnInput { service_tier: Some(Some("priority")), collaboration_mode: None } }';
      const inserted=db.prepare("INSERT INTO logs(ts,ts_nanos,thread_id,target,feedback_log_body) VALUES(?,0,?,'codex_core::session::handlers',?)").run(Math.floor(at/1000),session,text);
      context.evidence.rowId=Number(inserted.lastInsertRowid);
    }
  }finally{db.close();}
  await log(context,restore?"evidence-restored":"evidence-changed",{file,rowId:context.evidence.rowId});
  const deadline=Date.now()+300_000;
  while(Date.now()<deadline&&!context.closing){
    if(context.bodies.some(row=>row.preset==="all"&&row.usageVersion!==beforeVersion&&row.atMs>=changedAtMs)){
      await verifyFull(context,`evidence-${restore?"restore":"change"}-${changedAtMs}`);return;
    }
    await pause(250);
  }
  if(!context.closing)throw Error("Changed evidence was not published within 300 seconds");
}

async function dispatch(context,event) {
  context.lastActivityAtMs=Date.now();await log(context,"scheduled-event",{event});
  if(event.type==="append"){
    const timestampMs=event.late?Date.now()-86_400_000:Date.now();
    const receipt=await appendStabilityMutation(context.ledger,event.kind,{ordinal:context.ordinalOffset+event.ordinal,timestampMs,category:event.category});
    const input={...receipt,eventId:event.id,kindCount:context.ledger.byKind[event.kind].appendCount};context.inputs.push(input);await log(context,"input-landed",input);return;
  }
  if(event.type==="revision"){
    const receipt=await reviseStabilityMutation(context.ledger,{outputDelta:event.outputDelta,category:event.category});
    const input={...receipt,eventId:event.id,revisionIndex:context.ledger.revisionCount,beforeVersion:context.lastBody?.usageVersion};context.inputs.push(input);await log(context,"input-landed",input);return;
  }
  if(event.type==="cycle-drain"){
    const cycle=context.phaseSchedule.cycles.find(row=>row.cycle===event.cycle),lastInputAtMs=context.phaseStartedAtMs+cycle.lastInputAtMs;
    await drain(context,Math.max(0,lastInputAtMs+300_000-Date.now()),1);
    await log(context,"cycle-drained",{cycle:event.cycle,lastInputAtMs,drainMs:Math.max(0,Date.now()-lastInputAtMs),projection:projectionStorage(context.state)});return;
  }
  if(event.type==="scopes"){
    const queued=context.uiTail.then(()=>runScopes(context,event));context.uiTail=queued.catch(()=>{});return queued;
  }
  if(event.type==="tabs-open"){
    for(let i=0;i<2;i++){const page=await context.ui.context.newPage();page.setDefaultTimeout(300_000);await attachPage(context,page);context.pages.push(page);await loadPage(context,page);}return;
  }
  if(event.type==="tabs-close"){for(const page of context.pages.slice(1))await page.close();context.pages=context.pages.slice(0,1);return;}
  if(event.type==="drop-hint")return control(context,"drop-watch-hint",{id:event.id});
  if(event.type==="disconnect"){
    const session=await context.ui.context.newCDPSession(context.ui.page);await session.send("Network.enable");
    await session.send("Network.emulateNetworkConditions",{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});
    await pause(3000);await session.send("Network.emulateNetworkConditions",{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});await session.detach();return;
  }
  if(event.type.startsWith("arm-")){
    await control(context,"pause-sync",{id:event.id,point:event.type==="arm-after-commit"?"after-commit-before-notify":"before-commit"});
    return awaitFault(context,event,event.type==="arm-gateway-exit");
  }
  if(event.type.startsWith("price-"))return changePrice(context,event.type==="price-restore");
  if(event.type.startsWith("evidence-"))return changeEvidence(context,event.type==="evidence-restore");
  if(event.type==="writer-lock"){
    const db=new DatabaseSync(path.join(context.state,"usage-index.sqlite"));const startedAtMs=Date.now();
    try{db.exec("BEGIN IMMEDIATE");await pause(3000);db.exec("COMMIT");const checkpoint=db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();await log(context,"write-lock",{durationMs:Date.now()-startedAtMs,checkpoint});}
    finally{try{if(db.isTransaction)db.exec("ROLLBACK");}finally{db.close();}}return;
  }
  throw Error(`Unknown scheduled action ${event.type}`);
}

async function runPhase(context,schedule,{resumeOffsetMs=0}={}) {
  const phaseStart=Date.now()-resumeOffsetMs,firstInput=resumeOffsetMs?0:context.inputs.length,resourceStart=context.resourceSummary.samples;
  context.ordinalOffset=resumeOffsetMs?0:context.ledger.appendCount;
  context.phaseSchedule=schedule;context.phaseStartedAtMs=phaseStart;
  const original=resumeOffsetMs?await read(path.join(context.directory,`schedule-${schedule.mode}.json`)):null;
  await save(path.join(context.directory,`schedule-${schedule.mode}${resumeOffsetMs?"-continuation":""}.json`),{...schedule,startedAtMs:original?.startedAtMs??phaseStart,ordinalOffset:context.ordinalOffset,
    ...(resumeOffsetMs?{resumedAtMs:Date.now(),resumeOffsetMs,pauseMs:phaseStart-original.startedAtMs}:{})});
  const result={mode:schedule.mode,label:schedule.label,...(schedule.profile?{profile:schedule.profile,observationVersion:2}:{}),startedAtMs:phaseStart,plannedDurationMs:schedule.durationMs,passed:false,inputs:[],errors:[]};
  if(resumeOffsetMs)result.continuation={originalStartedAtMs:original.startedAtMs,resumeOffsetMs,pauseMs:phaseStart-original.startedAtMs};
  let eventIndex=resumeOffsetMs?schedule.events.filter(row=>row.atMs<=resumeOffsetMs).length:0,lastStatus=0;
  try{
    while(Date.now()-phaseStart<schedule.durationMs){
      const elapsed=Date.now()-phaseStart;
      while(eventIndex<schedule.events.length&&schedule.events[eventIndex].atMs<=elapsed){
        const event=schedule.events[eventIndex++];
        const task=dispatch(context,event).catch(error=>context.failures.push({atMs:Date.now(),type:"scheduled-action",eventId:event.id,message:error.message,stack:error.stack}));
        context.actionTasks.add(task);void task.finally(()=>{context.actionTasks.delete(task);context.lastActivityAtMs=Date.now();});
      }
      await pollBrowser(context);await checkDeadlines(context);
      if(Date.now()-lastStatus>=30_000){
        lastStatus=Date.now();await save(path.join(context.resultRoot??RESULT,"status.json"),{phase:schedule.mode,label:schedule.label,elapsedMs:elapsed,plannedMs:schedule.durationMs,
          injected:context.inputs.length-firstInput,visible:context.inputs.slice(firstInput).filter(row=>row.paintedAtMs).length,
          pendingActions:context.actionTasks.size,failures:context.failures,servicePeakMiB:context.resourceSummary.sampledPeakBytes/1048576});
        console.log(JSON.stringify({phase:schedule.mode,label:schedule.label,elapsedMinutes:Math.floor(elapsed/60_000),injected:context.inputs.length-firstInput,pending:context.inputs.filter(row=>!row.paintedAtMs).length}));
      }
      await pause(500);
    }
    assert.equal(eventIndex,schedule.events.length);
    const stoppedAtMs=Date.now();await drain(context);
    result.drainMs=Date.now()-stoppedAtMs;
    await stabilityScope(context,context.ui.page,"all",undefined,context.directory,`${schedule.mode}-final-all`);await Promise.all(context.responseTasks);
    result.oracle=context.smoke?{skipped:"Hot-only driver smoke; cold projection cost oracle has independent fixture tests."}:await verifyFull(context,`${schedule.mode}-final`);
    result.inputs=context.inputs.slice(firstInput).map(row=>({...row}));
    assert.equal(result.inputs.filter(row=>row.operation==="append").length,schedule.appendCount);
    assert.ok(result.inputs.every(row=>row.paintedAtMs));
    result.observedDurationMs=stoppedAtMs-phaseStart;result.resourceSamples=context.resourceSummary.samples-resourceStart;
    result.passed=true;
  }catch(error){result.errors.push({message:error.message,stack:error.stack});throw error;}
  finally{result.endedAtMs=Date.now();result.inputs=context.inputs.slice(firstInput);await save(path.join(context.directory,`result-${schedule.mode}.json`),result);}
  return result;
}

async function idleAndReopen(context) {
  const stoppedInputAtMs=Date.now();await drain(context);
  const idleStarted=Date.now();
  while(Date.now()-idleStarted<120_000){await pollBrowser(context);await checkDeadlines(context);await pause(1000);}
  await context.ui.page.screenshot({path:path.join(context.directory,"final.png"),fullPage:true});
  const before=projectionStorage(context.state);await context.ui.page.close();await stop(context.server);await context.sampler.stop();
  await pollResources(context);await log(context,"normal-close",{drainMs:idleStarted-stoppedInputAtMs,projection:projectionStorage(context.state)});
  context.ui.page=await context.ui.context.newPage();context.pages=[context.ui.page];await attachPage(context,context.ui.page);
  const startedAtMs=Date.now();context.server=await launchServer(context,"-final-reopen");context.sampler=await startSampler(context,"-final-reopen");
  await loadPage(context);await pollBrowser(context);await drain(context);
  const reopen={wallMs:Date.now()-startedAtMs,startedAtMs,endedAtMs:Date.now(),before,after:projectionStorage(context.state)};
  await save(path.join(context.directory,"final-reopen.json"),reopen);await verifyFull(context,"reopen");return reopen;
}

async function finishContext(context,{failed=false,retainSources=false}={}) {
  context.closing=true;
  const errors=[];
  try{await context.ui?.instance.close();}catch(error){errors.push(String(error));}
  for(const child of context.oracleChildren)if(child.exitCode===null)child.kill();
  await Promise.allSettled(context.actionTasks);
  try{await stop(context.server);}catch(error){errors.push(String(error));}
  try{await context.sampler?.stop();}catch(error){errors.push(String(error));}
  try{await pollResources(context);}catch(error){errors.push(String(error));}
  context.seed?.close();
  if(!failed&&!retainSources){
    try{await restoreStabilityMutations(context.ledger);}catch(error){errors.push(String(error));}
    if(context.evidence){
      const {file,backup,existing,mtimeMs}=context.evidence;
      try{
        for(const suffix of ["-wal","-shm","-journal"])await unlink(file+suffix).catch(error=>{if(error.code!=="ENOENT")throw error;});
        if(existing){await copyFile(backup,file);await utimes(file,mtimeMs/1000,mtimeMs/1000);}else await unlink(file);
      }catch(error){errors.push(String(error));}
    }
  }
  await save(path.join(context.directory,"resource-summary.json"),context.resourceSummary);
  await save(path.join(context.directory,"closed.json"),{failed,errors,rawRestored:!failed&&!retainSources&&!errors.length,
    ...(retainSources?{retainedForNextStage:true}:{}),projection:projectionStorage(context.state),atMs:Date.now()});
  assert.deepEqual(errors,[],"Context cleanup or resource checks failed");
}

async function primaryIdentity(file){
  const info=await stat(file,{bigint:true});return {dev:info.dev.toString(),ino:info.ino.toString()};
}

function closeoutEntryCounts(ledger, committedByKind) {
  const rawByKind=Object.fromEntries(STABILITY_KINDS.map(kind=>[kind,ledger.entries.filter(row=>row.operation==="append"&&row.kind===kind).length]));
  const pending=[];
  for(const kind of STABILITY_KINDS){
    const count=committedByKind[kind];assert.ok(Number.isSafeInteger(count)&&count>=0&&count<=rawByKind[kind],`Invalid committed ${kind} count`);
    pending.push(...ledger.entries.filter(row=>row.operation==="append"&&row.kind===kind).slice(count));
  }
  return {rawAppendCount:ledger.appendCount,committedAppendCount:Object.values(committedByKind).reduce((a,b)=>a+b,0),
    revisionCount:ledger.revisionCount,rawByKind,committedByKind,pending};
}

async function registerCloseoutEntry(configFile) {
  const config=await read(configFile),ledger=await retainedLedger(config.baseLedgerFile,config.baseMutationsFile);
  const start=Math.min(...ledger.entries.filter(row=>row.operation==="append").map(row=>row.timestampMs));
  assert.ok(Number.isFinite(start));
  const primary=path.join(config.state,"usage-index.sqlite"),db=new DatabaseSync(primary,{readOnly:true});
  const committedByKind={};
  try{for(const kind of STABILITY_KINDS){
    const plans=ledger.plans.filter(row=>row.kind===kind);assert.equal(plans.length,1);
    committedByKind[kind]=db.prepare("SELECT COUNT(*) n FROM events WHERE source_path=? AND timestamp_ms>=?").get(plans[0].filePath,start).n;
  }}finally{db.close();}
  const counts=closeoutEntryCounts(ledger,committedByKind),sources=[];
  const {streamUsageFileEvents}=await import(pathToFileURL(path.join(config.runtime,"src/usage-core.js")));
  for(const plan of ledger.plans){
    let raw=0;
    await streamUsageFileEvents(plan.filePath,plan.source,event=>{if(event.timestampMs>=start)raw++;},{repositoryResolver:cwd=>({key:cwd,path:cwd,kind:"directory"}),onWarning:warning=>assert.fail(JSON.stringify(warning))});
    assert.equal(raw,counts.rawByKind[plan.kind],`Raw ${plan.kind} no longer matches retained ledger`);
    const hash=createHash("sha256");for await(const bytes of createReadStream(plan.filePath))hash.update(bytes);
    sources.push({kind:plan.kind,file:plan.filePath,bytes:(await stat(plan.filePath)).size,sha256:hash.digest("hex")});
  }
  const result={profile:CLOSEOUT_PROFILE,version:1,registeredAtMs:Date.now(),...counts,primary,identity:await primaryIdentity(primary),
    projection:projectionStorage(config.state),sources,baseLedgerFile:config.baseLedgerFile,baseMutationsFile:config.baseMutationsFile};
  await mkdir(path.dirname(config.entryFile),{recursive:true});
  await writeFile(config.entryFile,JSON.stringify(result,null,2)+"\n",{flag:"wx",flush:true});return result;
}

async function closeoutPreflight() {
  const names=["normal","before","after","closed-tabs"],groups=[];
  for(const name of names){const file=path.join(CLOSEOUT_RESULT,`browser-preflight/browser-combined-${name}.json`),receipt=await read(file);
    assert.equal(receipt.passed,true);assert.equal(receipt.profile,CLOSEOUT_PROFILE);assert.equal(receipt.observationVersion,2);
    assert.equal(receipt.appendCount,name==="closed-tabs"?7:1);groups.push({name,file,sha256:createHash("sha256").update(await readFile(file)).digest("hex")});}
  const result={profile:CLOSEOUT_PROFILE,observationVersion:2,passed:true,appendCount:10,groups};
  await writeFile(path.join(CLOSEOUT_RESULT,"preflight.json"),JSON.stringify(result,null,2)+"\n",{flag:"wx",flush:true});return result;
}

async function freezeCloseoutRuntime(source,destination) {
  const {runtimeFiles}=await import("./archive-compaction-prepare.mjs"),{hashFile,verifyRuntime}=await import("./remaining-harness-delivery-prepare.mjs");
  source=path.resolve(source);destination=path.resolve(destination);
  assert.equal(path.dirname(destination),CLOSEOUT_RESULT,"Freeze runtime directly under private closeout root");
  await mkdir(destination,{recursive:false});const hashes={};
  for(const relative of await runtimeFiles(source)){
    const file=path.join(destination,relative);await mkdir(path.dirname(file),{recursive:true});await copyFile(path.join(source,relative),file);
    hashes[relative]=await hashFile(path.join(source,relative));
  }
  const spec={profile:CLOSEOUT_PROFILE,directory:destination,source,hashes};await verifyRuntime(spec);
  await writeFile(destination+".json",JSON.stringify(spec,null,2)+"\n",{flag:"wx",flush:true});return spec;
}

async function closeoutConfigs() {
  const directory=path.join(CLOSEOUT_RESULT,"configs");await mkdir(directory,{recursive:false});
  const retained={baseLedgerFile:path.join(MULTITAB_RESULT,"endurance/two-years/base-ledger.json"),baseMutationsFile:path.join(MULTITAB_RESULT,"endurance/two-years/mutations/mutations.ndjson"),entryFile:path.join(CLOSEOUT_RESULT,"retained-entry.json")};
  const entry={...retained,runtime:path.join(CLOSEOUT_RESULT,"baseline-runtime"),state:path.join(COMPACTION,"upgrades/two-years/state")};
  await writeFile(path.join(directory,"entry.json"),JSON.stringify(entry,null,2)+"\n",{flag:"wx"});
  const files=[];
  for(const label of ["current","year","two-years"])for(const variant of ["baseline","candidate"]){
    const config={profile:CLOSEOUT_PROFILE,mode:"closeout-short",label,variant,runtime:path.join(CLOSEOUT_RESULT,`${variant}-runtime`),
      datasetFile:path.join(BASE,`datasets/${label}/dataset.json`),seedDirectory:label==="two-years"?path.join(FORMAL,`diagnostic/${label}/oracle-seed`):path.join(BASE,`datasets/${label}/seed-state`),
      state:path.join(CLOSEOUT_RESULT,`fixtures/${label}/${variant}-state`),directory:path.join(CLOSEOUT_RESULT,`short/${label}/${variant}`),
      preflightFile:path.join(CLOSEOUT_RESULT,"preflight.json"),...(label==="two-years"?retained:{})};
    const file=path.join(directory,`${label}-${variant}.json`);await writeFile(file,JSON.stringify(config,null,2)+"\n",{flag:"wx"});files.push(file);
    await mkdir(path.dirname(config.directory),{recursive:true});
    if(label==="two-years"&&variant==="candidate")await writeFile(path.join(directory,"soak.json"),JSON.stringify({...config,mode:"closeout-soak",state:path.join(CLOSEOUT_RESULT,"fixtures/two-years/soak-state"),directory:path.join(CLOSEOUT_RESULT,"soak")},null,2)+"\n",{flag:"wx"});
  }
  await writeFile(path.join(directory,"serial.json"),JSON.stringify({profile:CLOSEOUT_PROFILE,groups:files},null,2)+"\n",{flag:"wx"});return files;
}

function inheritCloseoutLedger(ledger,base) {
  assert.equal(ledger.entries.length,0);
  ledger.entries=structuredClone(base.entries);ledger.expected=structuredClone(base.expected);
  ledger.appendCount=base.appendCount;ledger.revisionCount=base.revisionCount;
  for(const kind of STABILITY_KINDS){
    const original=base.byKind[kind],own=ledger.byKind[kind];
    Object.assign(own,{ordinals:[...original.ordinals],expected:{...original.expected},appendCount:original.appendCount,revisionCount:original.revisionCount});
  }
  return ledger;
}

function assertCloseoutProjection(label,projection,archiveCount) {
  // The single-archive all fast path does not create a persistent projection.
  assert.ok(projection.databaseCount===1||label==="current"&&archiveCount===1&&projection.databaseCount===0,
    "Main must prepare the mixed query path before timing");
}

async function runCloseout(configFile) {
  const config=await read(configFile);assert.equal(config.profile,CLOSEOUT_PROFILE);
  assert.ok(["baseline","candidate"].includes(config.variant));
  const schedule=closeoutSchedule(config.mode,config.label);
  if(config.mode==="closeout-soak")assert.equal(config.variant,"candidate");
  const preflight=await read(config.preflightFile);assert.equal(preflight.profile,CLOSEOUT_PROFILE);assert.equal(preflight.passed,true);
  assert.deepEqual(preflight.groups.map(row=>row.name).sort(),["after","before","closed-tabs","normal"]);
  for(const group of preflight.groups)assert.equal(createHash("sha256").update(await readFile(group.file)).digest("hex"),group.sha256,"Browser preflight receipt changed");
  const directory=path.resolve(config.directory),relative=path.relative(CLOSEOUT_RESULT,directory);
  assert.ok(relative&&!relative.startsWith("..")&&!path.isAbsolute(relative),"Closeout output must be private and new");
  await mkdir(directory,{recursive:false});
  const resultFile=path.join(directory,"result.json"),result={profile:CLOSEOUT_PROFILE,version:1,observationVersion:2,
    mode:config.mode,label:config.label,variant:config.variant,runtime:config.runtime,startedAtMs:Date.now(),passed:false,phases:[]};
  await save(resultFile,result);let context;
  try{
    const dataset=await read(config.datasetFile),seedDirectory=config.seedDirectory;
    const stateDb=new DatabaseSync(path.join(config.state,"usage-index.sqlite"),{readOnly:true});let archiveCount;
    try{archiveCount=stateDb.prepare("SELECT COUNT(*) n FROM archive_segments").get().n;}finally{stateDb.close();}
    assertCloseoutProjection(config.label,projectionStorage(config.state),archiveCount);
    let base;
    if(config.baseLedgerFile){
      base=await retainedLedger(config.baseLedgerFile,config.baseMutationsFile);
      const entry=await read(config.entryFile);assert.equal(entry.profile,CLOSEOUT_PROFILE);
      assert.equal(entry.rawAppendCount,base.appendCount);assert.equal(entry.revisionCount,base.revisionCount);
      for(const source of entry.sources){const hash=createHash("sha256");for await(const bytes of createReadStream(source.file))hash.update(bytes);assert.equal(hash.digest("hex"),source.sha256,"Registered retained source changed");}
      result.entry=entry;
    }
    const ledger=await prepareStabilityMutations(dataset,path.join(directory,"mutations"),{databaseFile:path.join(seedDirectory,"usage-index.sqlite"),runtimeDirectory:config.runtime});
    if(base)inheritCloseoutLedger(ledger,base);
    await save(path.join(directory,"base-ledger.json"),ledger);
    const seed=new DatabaseSync(path.join(seedDirectory,"usage-index.sqlite"),{readOnly:true}),controlDirectory=path.join(directory,"control");await mkdir(controlDirectory);
    context=createContext({directory,state:config.state,control:controlDirectory,seed,seedDirectory,ledger,selectedSessions:mutationSessions(ledger,seed),
      runtime:config.runtime,dataset,profile:CLOSEOUT_PROFILE,resultRoot:directory,requiredAllTotal:expectedAll(dataset).total+ledger.expected.total});
    activeContext=context;
    await save(path.join(directory,"preparation.json"),{...config,baseAppendCount:ledger.appendCount,baseRevisionCount:ledger.revisionCount,projection:projectionStorage(context.state),
      heaps:{gatewayOldMiB:512,executorOldMiB:224,executorSemiMiB:4,nodeOptionsRemoved:true}});
    context.ui=await browser();context.pages=[context.ui.page];await attachPage(context,context.ui.page);
    context.server=await launchServer(context);context.sampler=await startSampler(context);await loadPage(context);
    await verifyFull(context,"initial");delete context.requiredAllTotal;
    result.phases.push(await runPhase(context,schedule));
    result.reopen=await idleAndReopen(context);await save(path.join(directory,"end-ledger.json"),ledger);
    await finishContext(context);context=null;activeContext=null;result.passed=true;
  }catch(error){result.failure={message:error.message,stack:error.stack};if(context)await finishContext(context,{failed:true}).catch(cleanup=>result.cleanupError=String(cleanup));throw error;}
  finally{result.endedAtMs=Date.now();await save(resultFile,result);}
  return result;
}

async function recoveryProjectionWork(directory){
  const rows=[];
  for(const name of await readdir(directory))if(/^events-\d+\.ndjson$/.test(name)){
    for await(const line of createInterface({input:createReadStream(path.join(directory,name)),crlfDelay:Infinity})){
      if(!line.trim())continue;const row=JSON.parse(line);if(row.event==="projection")rows.push(row);
    }
  }
  assert.ok(rows.length,"Recovery projection reuse was not observed");
  assert.ok(rows.every(row=>row.coldCopied===0&&row.fullRebuild===false),"Recovery copied or rebuilt cold projection");
  return {coldCopied:0,fullRebuild:false,samples:rows.length};
}

async function runRecovery({multitab=false,mode="endurance"}={}){
  const resultRoot=multitab?path.join(MULTITAB_RESULT,mode):RECOVERY_RESULT,resultFile=path.join(resultRoot,"result.json");
  assert.equal(await stat(resultFile).then(()=>true,error=>error.code==="ENOENT"?false:Promise.reject(error)),false,"Never overwrite a recovery run");
  const preflight=await read(path.join(resultRoot,"preflight.json"));
  assert.equal(preflight.passed,true);assert.ok(preflight.groups.every(row=>row.passed));
  assert.deepEqual(preflight.groups.map(row=>row.name).sort(),multitab?["combined-after","combined-before","combined-normal"]:["after-commit","before-commit","resources","sse"]);
  assert.ok(Object.keys(preflight.toolHashes??{}).length,"Preflight hashes are required");
  for(const [relative,expected] of Object.entries(preflight.toolHashes)){
    assert.equal(createHash("sha256").update(await readFile(path.join(ROOT,relative))).digest("hex"),expected,`Preflight code changed: ${relative}`);
  }
  await diskBudget(64);
  const result={kind:multitab?"windows-multitab":"windows-stability-recovery",mode,...(multitab?{observationVersion:2}:{}),startedAtMs:Date.now(),baseAppendCount:48,baseRevisionCount:1,phases:[],passed:false};
  await save(resultFile,result);let context;
  try{
    const origin=path.join(FORMAL,"diagnostic/two-years"),directory=path.join(resultRoot,"two-years");await mkdir(directory);
    const manifest=await read(path.join(COMPACTION,"manifest.json")),runtime=await read(preflight.runtimeFile??manifest.candidateFile);
    const dataset=await read(path.join(BASE,"datasets/two-years/dataset.json")),state=path.join(COMPACTION,"upgrades/two-years/state");
    const primary=path.join(state,"usage-index.sqlite"),beforeIdentity=await primaryIdentity(primary),beforeProjection=projectionStorage(state);
    assert.equal(beforeProjection.databaseCount,1);
    let ledger;
    if(!multitab)ledger=await recoverAppendLedger(origin,48,true);
    else if(mode==="local")ledger=await retainedLedger(path.join(RECOVERY_RESULT,"two-years/base-ledger.json"),path.join(RECOVERY_RESULT,"two-years/mutations/mutations.ndjson"));
    else{
      const priorMode=mode==="local-verify"?"local":preflight.localMode;
      assert.ok(["local","local-verify"].includes(priorMode));
      const prior=await read(path.join(MULTITAB_RESULT,priorMode,"result.json"));assert.equal(prior.passed,true);
      ledger=await retainedLedger(path.join(MULTITAB_RESULT,priorMode,"two-years/end-ledger.json"));
    }
    assert.equal(ledger.appendCount,multitab?(mode==="local"?80:preflight.baseAppendCount):48);
    result.baseAppendCount=ledger.appendCount;result.baseRevisionCount=ledger.revisionCount;
    ledger.directory=path.join(directory,"mutations");ledger.runId=randomUUID();await mkdir(ledger.directory);
    await save(path.join(directory,"base-ledger.json"),ledger);
    const start=Math.min(...ledger.entries.filter(row=>row.operation==="append").map(row=>row.timestampMs));
    const beforeDb=new DatabaseSync(primary,{readOnly:true});let beforeRecent;
    try{beforeRecent=beforeDb.prepare("SELECT COUNT(*) n FROM events WHERE timestamp_ms>=?").get(start).n;}finally{beforeDb.close();}
    assert.equal(beforeRecent,result.baseAppendCount-(multitab&&mode!=="local"?0:1),"Preserved state changed before recovery");
    const seedDirectory=path.join(origin,"oracle-seed"),seed=new DatabaseSync(path.join(seedDirectory,"usage-index.sqlite"),{readOnly:true});
    const control=path.join(directory,"control");await mkdir(control);
    context=createContext({directory,state,control,seed,seedDirectory,ledger,selectedSessions:mutationSessions(ledger,seed),runtime:runtime.directory,dataset,
      resultRoot,requiredAllTotal:expectedAll(dataset).total+ledger.expected.total});activeContext=context;
    await save(path.join(directory,"preparation.json"),{state,runtime:runtime.directory,origin,seedDirectory,beforeIdentity,beforeProjection,baseAppendCount:result.baseAppendCount,beforeRecent});
    context.ui=await browser();context.pages=[context.ui.page];await attachPage(context,context.ui.page);
    const recoveryStarted=Date.now();context.server=await launchServer(context);context.sampler=await startSampler(context);await loadPage(context);
    await pollBrowser(context);await Promise.all(context.responseTasks);
    const body=[...context.bodies].reverse().find(row=>row.preset==="all")?.body;assert.ok(body);
    assert.equal(body.metadata.eventCount,expectedAll(dataset).events+result.baseAppendCount);
    const db=new DatabaseSync(primary,{readOnly:true});let afterRecent;
    try{afterRecent=db.prepare("SELECT COUNT(*) n FROM events WHERE timestamp_ms>=?").get(start).n;}finally{db.close();}
    assert.equal(afterRecent,result.baseAppendCount);
    const oracle=await verifyFull(context,"recovery");
    const afterIdentity=await primaryIdentity(primary),afterProjection=projectionStorage(state);
    assert.deepEqual(afterIdentity,beforeIdentity);assert.equal(afterProjection.current.file,beforeProjection.current.file);
    const projection=await recoveryProjectionWork(control),recovery={passed:true,wallMs:Date.now()-recoveryStarted,expectedAppends:result.baseAppendCount,beforeRecent,afterRecent,
      samePrimaryIdentity:true,sameProjectionFile:true,...projection,oracle,startedAtMs:recoveryStarted,endedAtMs:Date.now()};
    assert.ok(recovery.wallMs<=300_000,"Two-year recovery exceeded 300 seconds");await save(path.join(directory,"recovery.json"),recovery);result.recovery=recovery;
    if(multitab&&mode==="endurance")await copyFile(path.join(MULTITAB_RESULT,"local/two-years/recovery.json"),path.join(directory,"pending-recovery.json"));
    delete context.requiredAllTotal;
    await context.sampler.stop();await pollResources(context);await save(path.join(directory,"resource-summary-recovery.json"),context.resourceSummary);
    context.sampler=await startSampler(context,"-endurance");
    result.phases.push(await runPhase(context,multitab&&mode!=="endurance"?multitabSchedule():stabilitySchedule("endurance")));
    await save(path.join(directory,"end-ledger.json"),context.ledger);
    if(!multitab||mode==="endurance")result.reopen=await idleAndReopen(context);
    await finishContext(context,{retainSources:multitab&&mode!=="endurance"});context=null;activeContext=null;result.passed=true;
  }catch(error){result.failure={message:error.message,stack:error.stack};if(context)await finishContext(context,{failed:true}).catch(cleanup=>result.cleanupError=String(cleanup));throw error;}
  finally{result.endedAtMs=Date.now();await save(resultFile,result);}
  console.log(JSON.stringify({passed:result.passed,baseAppendCount:result.baseAppendCount,phases:result.phases.map(row=>({mode:row.mode,inputs:row.inputs.length,passed:row.passed}))}));
}

async function runAll({smoke=false,resumeYear=false,resumePaint=false,restartEndurance=false}={}) {
  await mkdir(path.join(smoke?RESULT:FORMAL,smoke?"smoke":"diagnostic"),{recursive:true});
  const runFile=path.join(smoke?RESULT:FORMAL,smoke?"smoke-result.json":"result.json");
  const exists=await stat(runFile).then(()=>true,error=>error.code==="ENOENT"?false:Promise.reject(error));
  assert.equal(exists,resumeYear||resumePaint||restartEndurance,"Result exists; use only the explicit probe continuation");
  let result={startedAtMs:Date.now(),smoke,phases:[],passed:false};let context;
  if(resumeYear){
    result=await read(runFile);
    assert.equal(result.failure?.message,"Idle service tree exceeded 256 MiB");
    assert.deepEqual(result.phases.map(row=>[row.label,row.passed]),[["current",true],["year",true]]);
    await writeFile(path.join(FORMAL,"result-idle-interruption.json"),JSON.stringify(result,null,2)+"\n",{flag:"wx",flush:true});
    result.continuation={atMs:Date.now(),reason:"Completed year inputs preserved; correct activity classification, then finish idle/reopen only",original:"result-idle-interruption.json"};
    delete result.failure;delete result.cleanupError;delete result.endedAtMs;
  }
  let paintOffsetMs=0;
  if(resumePaint){
    result=await read(runFile);assert.equal(result.failure?.message,"Unpublished input exceeded 120000ms: diagnostic-two-years-0007");
    assert.deepEqual(result.phases.map(row=>[row.label,row.passed]),[["current",true],["year",true]]);
    await writeFile(path.join(FORMAL,"result-paint-interruption.json"),JSON.stringify(result,null,2)+"\n",{flag:"wx",flush:true});
    const directory=path.join(FORMAL,"diagnostic/two-years"),phase=await read(path.join(directory,"result-diagnostic.json")),schedule=await read(path.join(directory,"schedule-diagnostic.json"));
    paintOffsetMs=phase.endedAtMs-schedule.startedAtMs;
    await writeFile(path.join(directory,"result-diagnostic-paint-interruption.json"),JSON.stringify(phase,null,2)+"\n",{flag:"wx",flush:true});
    result.continuations=[result.continuation,{atMs:Date.now(),reason:"Valid WorkBuddy paint preceded response persistence; preserve and resume remaining diagnostic schedule",original:"result-paint-interruption.json"}];
    delete result.failure;delete result.cleanupError;delete result.endedAtMs;
  }
  if(restartEndurance){
    result=await read(runFile);assert.ok(result.failure?.message.includes("17 !== 15"));
    assert.deepEqual(result.phases.map(row=>[row.label,row.passed]),[["current",true],["year",true],["two-years",true]]);
    await writeFile(path.join(FORMAL,"result-sessions-interruption.json"),JSON.stringify(result,null,2)+"\n",{flag:"wx",flush:true});
    const directory=path.join(FORMAL,"diagnostic/two-years");
    for(const prefix of ["result","schedule"]){const content=await readFile(path.join(directory,`${prefix}-endurance.json`));await writeFile(path.join(directory,`${prefix}-endurance-sessions-interruption.json`),content,{flag:"wx",flush:true});}
    result.interruptedEndurance={result:"diagnostic/two-years/result-endurance-sessions-interruption.json",schedule:"diagnostic/two-years/schedule-endurance-sessions-interruption.json",reason:"Wrong test session selection; independent scoped SQL and ordered cost prove 17 sessions is correct",inputs:(await read(path.join(directory,"result-endurance-sessions-interruption.json"))).inputs};
    result.continuations.push({atMs:Date.now(),reason:result.interruptedEndurance.reason,original:"result-sessions-interruption.json"});
    delete result.failure;delete result.cleanupError;delete result.endedAtMs;
  }
  try{
    for(const label of smoke?["tiny"]:resumePaint||restartEndurance?["two-years"]:resumeYear?["year","two-years"]:["current","year","two-years"]){
      const resume=resumeYear&&label==="year"||(resumePaint||restartEndurance)&&label==="two-years";
      context=await prepareContext(label,{smoke,resume,restartEndurance});
      if(!resume)await save(path.join(context.directory,"initial-body.json"),context.lastBody?.body??{});
      if(!smoke)await verifyFull(context,restartEndurance?"sessions-resume":resume?"idle-resume":"initial");
      const schedule=smoke?{...stabilitySchedule("diagnostic","current"),mode:"smoke",label:"tiny",durationMs:20_000,
        appendCount:6,events:STABILITY_KINDS.map((kind,i)=>({id:`smoke-${i}`,atMs:i*1500,type:"append",kind,ordinal:i+1,inputClass:"ordinary",category:"ordinary"}))}:stabilitySchedule("diagnostic",label);
      if(!resume||resumePaint)result.phases.push(await runPhase(context,schedule,{resumeOffsetMs:resumePaint?paintOffsetMs:0}));
      if(!smoke&&label==="two-years"){
        await context.sampler.stop();await pollResources(context);
        await save(path.join(context.directory,restartEndurance?"resource-summary-sessions-preparation.json":"resource-summary-diagnostic.json"),context.resourceSummary);
        context.sampler=await startSampler(context,restartEndurance?"-endurance-accepted":"-endurance");
        const endurance=stabilitySchedule("endurance");
        if(restartEndurance){endurance.eventIdPrefix="endurance-accepted";endurance.events=endurance.events.map(event=>({...event,id:event.id.replace(/^endurance-/,"endurance-accepted-")}));}
        result.phases.push(await runPhase(context,endurance));
      }
      if(!smoke)result.reopen=await idleAndReopen(context);
      await finishContext(context);context=null;activeContext=null;
      await save(runFile,{...result,status:"running"});
    }
    result.passed=true;
  }catch(error){context??=activeContext;result.failure={message:error.message,stack:error.stack};if(context)await finishContext(context,{failed:true}).catch(cleanup=>result.cleanupError=String(cleanup));throw error;}
  finally{result.endedAtMs=Date.now();await save(runFile,result);}
  console.log(JSON.stringify({passed:result.passed,phases:result.phases.map(row=>({mode:row.mode,label:row.label,passed:row.passed,inputs:row.inputs.length}))}));
}

export { visibleInputs,expectedWindow,checkResponse,awaitFault,launchServer,pollResources,correctYearIdle,pollBrowser,mutationSessions,recoverAppendLedger,
  attachPage,loadPage,stabilityScope,waitUsageResponse,registerControlledExit,matchingControlledExit,retainedLedger,multitabSchedule,
  closeoutEntryCounts,inheritCloseoutLedger,assertCloseoutProjection,registerCloseoutEntry,runCloseout };

if(process.argv[1]&&path.resolve(process.argv[1])===SELF){
  if(process.argv[2]==="closeout-freeze")await freezeCloseoutRuntime(process.argv[3],process.argv[4]);
  else if(process.argv[2]==="closeout-configs")await closeoutConfigs();
  else if(process.argv[2]==="closeout-preflight")await closeoutPreflight();
  else if(process.argv[2]==="closeout-entry")await registerCloseoutEntry(process.argv[3]);
  else if(process.argv[2]==="closeout-run")await runCloseout(process.argv[3]);
  else {
  assert.ok(["run","smoke","resume-year-idle","resume-paint-order","restart-endurance","recover-and-soak","multitab-local","multitab-local-verify","multitab-endurance"].includes(process.argv[2]),"Unknown stability command");
  if(process.argv[2].startsWith("multitab-"))await runRecovery({multitab:true,mode:process.argv[2].slice("multitab-".length)});
  else if(process.argv[2]==="recover-and-soak")await runRecovery();
  else await runAll({smoke:process.argv[2]==="smoke",resumeYear:process.argv[2]==="resume-year-idle",resumePaint:process.argv[2]==="resume-paint-order",restartEndurance:process.argv[2]==="restart-endurance"});
  }
}
