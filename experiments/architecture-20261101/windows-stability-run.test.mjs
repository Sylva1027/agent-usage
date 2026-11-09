import assert from "node:assert/strict";
import { appendFile,mkdtemp,mkdir,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { LineTail,visibleInputs,expectedWindow,checkResponse,awaitFault,launchServer,pollResources,correctYearIdle,pollBrowser,mutationSessions,
  registerControlledExit,matchingControlledExit,waitUsageResponse,attachPage,retainedLedger,multitabSchedule } from "./windows-stability-run.mjs";

async function removeFixture(directory){
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir()));
  await rm(directory,{recursive:true,force:true});
}

test("concurrent source publication is checked by source counts rather than global append order",()=>{
  const kinds=["codex","dsh","claude","workbuddy","zcode","opencode"];
  const dataset={expected:kinds.map(kind=>({kind,events:1,total:10,input:8,cached:0,output:2,reasoning:0})),expectedSessions:6};
  const entry=kind=>({operation:"append",kind,timestampMs:1000,expectedDelta:160,deltaTokens:{input:140,cached:30,output:20,reasoning:kind==="dsh"?0:5}});
  const context={dataset,ledger:{entries:[entry("dsh"),entry("codex")]},rangeCache:new Map(),selectedSessions:new Map(kinds.map(kind=>[kind,kind]))};
  const body={metadata:{eventCount:7,sessionCount:6,homes:kinds.map(kind=>({kind:kind==="codex"?"main":kind,eventCount:kind==="codex"?2:1}))},
    periodComparison:{totals:{all:{total:220}}},summary:{timelineError:null,range:{preset:"all",start:new Date(0).toISOString(),end:new Date(2000).toISOString()},
      eventCount:7,sessionCount:6,totals:{total:220,input:188,cached:30,output:32,reasoning:5},channels:[]}};
  assert.deepEqual(visibleInputs(context,body).entries.map(row=>row.kind),["codex"]);
  checkResponse(context,body);
  body.summary.totals.output++;assert.throws(()=>checkResponse(context,body),/range output/);
});

test("line tail preserves split UTF-8 and incomplete records and rejects truncation",async t=>{
  const root=await mkdtemp(path.join(tmpdir(),"stability-tail-"));t.after(()=>removeFixture(root));
  const file=path.join(root,"stream.ndjson"),tail=new LineTail(file),bytes=Buffer.from('完整\nsecond\n');
  await writeFile(file,bytes.subarray(0,2));assert.deepEqual(await tail.read(),[]);
  await appendFile(file,bytes.subarray(2,9));assert.deepEqual(await tail.read(),["完整"]);
  await appendFile(file,bytes.subarray(9));assert.deepEqual(await tail.read(),["second"]);
  assert.deepEqual(await tail.read(),[]);await writeFile(file,"");await assert.rejects(()=>tail.read(),/truncated/);
});

test("closing a run cancels armed fault waits and prevents a replacement gateway",async()=>{
  const context={closing:true,control:"unread-control-path"};
  assert.equal(await awaitFault(context,{id:"cancelled"},true),undefined);
  await assert.rejects(()=>launchServer(context),/closing/);
});

test("a live executor is active work; the same memory fails only after a real quiet interval",async()=>{
  const now=Date.now(),root={pid:10,name:"node.exe",role:"service",parentPid:1},worker={pid:11,name:"node.exe",role:"service",parentPid:10};
  let sample={atUnixMs:now,service:{processCount:2,workingSetBytes:300*1048576},browser:{workingSetBytes:0},processes:[root,worker]};
  const context={inputs:[],actionTasks:new Set(),responseTasks:new Set(),lastActivityAtMs:now-120_000,
    resourceTails:[{servicePid:10,read:async()=>[JSON.stringify(sample)]}],
    resourceSummary:{samples:0,sampledPeakBytes:0,browserPeakBytes:0,cpuSeconds:0,readBytes:0,writeBytes:0,observerCpuSeconds:0,peakStorageBytes:0,peakWalBytes:0,excluded:[],idle:[]}};
  await pollResources(context);assert.equal(context.resourceSummary.idle.length,0);assert.equal(context.lastActivityAtMs,now);
  sample={...sample,atUnixMs:now+61_000,service:{processCount:1,workingSetBytes:300*1048576},processes:[root]};
  await assert.rejects(()=>pollResources(context),/Idle service tree exceeded 256/);
});

test("idle continuation removes recorded query activity but retains and rejects real idle excess",async t=>{
  const root=await mkdtemp(path.join(tmpdir(),"stability-idle-"));t.after(()=>removeFixture(root));
  await mkdir(path.join(root,"resources"));
  const now=Date.now(),bytes=270*1048576;
  await writeFile(path.join(root,"events.ndjson"),JSON.stringify({type:"browser",kind:"fetch-start",page:1,id:1,url:"/api/usage",clock:now})+"\n");
  const sample=atUnixMs=>({atUnixMs,service:{processCount:1,workingSetBytes:bytes},browser:{workingSetBytes:0},treeMetadata:{runnerPid:1},processes:[{pid:10,parentPid:1,name:"node.exe",role:"service"}]});
  await writeFile(path.join(root,"resources/resources.ndjson"),[sample(now+1000),sample(now+61000)].map(row=>JSON.stringify(row)).join("\n")+"\n");
  assert.equal((await correctYearIdle(root,{idle:[{atMs:now+1000,bytes}]})).idle.length,0);
  await assert.rejects(()=>correctYearIdle(root,{idle:[{atMs:now+61000,bytes}]}),/Correctly idle sample exceeds/);
});

test("paint evidence waits for the already-arrived response to finish validation and persistence",async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),"stability-paint-"));t.after(()=>removeFixture(directory));
  const clock=Date.now(),input={operation:"append",kind:"workbuddy",kindCount:1,landedAtMs:clock-1000};
  const context={directory,bodies:[],inputs:[input],responseTasks:new Set()};
  let complete;
  const pending=new Promise(resolve=>complete=()=>{context.bodies.push({page:0,total:160,preset:"all",atMs:clock-1,sequence:1,counts:{workbuddy:1},usageVersion:"new"});resolve();});
  context.responseTasks.add(pending);
  const page={isClosed:()=>false,evaluate:async()=>{setImmediate(complete);return {dropped:0,rows:[{kind:"paint",clock,total:"160"}]};}};
  context.pages=[page];context.ui={page};
  await pollBrowser(context);assert.equal(input.paintedAtMs,clock);assert.equal(input.landingToPaintMs,1000);
});

test("an all view in another tab confirms an input while the main tab changes scope, without borrowing another tab's response",async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),"stability-multitab-"));t.after(()=>removeFixture(directory));
  const clock=Date.now(),input={operation:"append",kind:"codex",kindCount:1,landedAtMs:clock-75747};
  let paintPage=1;
  const page=index=>({isClosed:()=>false,evaluate:async()=>({dropped:0,rows:paintPage===index?[{kind:"paint",clock,total:"160"}]:[]})});
  const pages=[page(0),page(1)],context={directory,pages,ui:{page:pages[0]},inputs:[input],responseTasks:new Set(),
    bodies:[{page:0,total:160,preset:"all",atMs:clock-1,sequence:1,counts:{codex:1},usageVersion:"other-tab"}]};
  await pollBrowser(context);assert.equal(input.paintedAtMs,undefined,"another tab's matching total is insufficient");
  context.bodies.push({...context.bodies[0],page:1,preset:"today",sequence:2});
  await pollBrowser(context);assert.equal(input.paintedAtMs,undefined,"a selected range cannot certify the all view");
  context.bodies.push({...context.bodies[0],page:1,usageVersion:null,sequence:3});
  await pollBrowser(context);assert.equal(input.paintedAtMs,undefined,"an uncertified response is insufficient");
  context.bodies.push({...context.bodies[0],page:1,usageVersion:"same-tab",sequence:4});
  await pollBrowser(context);assert.equal(input.paintedAtMs,clock);assert.equal(input.paintedPage,1);
  assert.equal(input.landingToPaintMs,75747);assert.equal(input.responseSequence,4);assert.equal(input.usageVersion,"same-tab");
});

test("range membership follows the mutation's actual session when a file contains multiple sessions",()=>{
  const seed=new DatabaseSync(":memory:");
  try{
    seed.exec("CREATE TABLE events(timestamp_ms,session_id,source_path,total,input,cached,output,reasoning);INSERT INTO events VALUES(0,'old','multi',15,10,2,5,0),(12,'latest','multi',15,10,2,5,0)");
    const ledger={plans:[{kind:"claude",filePath:"multi",deliveryPlan:{original:{sessionId:"old"}}}],byKind:{claude:{}}};
    const context={seed,selectedSessions:mutationSessions(ledger,seed),rangeCache:new Map()};
    assert.equal(context.selectedSessions.get("claude"),"old");
    const body={summary:{range:{preset:"week",start:new Date(10).toISOString(),end:new Date(20).toISOString()}}};
    const entry={kind:"claude",operation:"append",timestampMs:15,expectedDelta:160,deltaTokens:{input:140,cached:30,output:20,reasoning:5}};
    assert.equal(expectedWindow(context,body,{entries:[entry]}).sessions,2);
  }finally{seed.close();}
});

test("a versioned selected range proves fresh visibility only for contained inputs while all proof keeps its own clock",async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),"stability-view-"));t.after(()=>removeFixture(directory));
  const clock=Date.now(),input={operation:"append",kind:"workbuddy",kindCount:1,timestampMs:clock-50000,landedAtMs:clock-46027};
  const context={directory,bodies:[],inputs:[input],responseTasks:new Set()};let paintClock=clock;
  const page={isClosed:()=>false,evaluate:async()=>({dropped:0,rows:[{kind:"paint",clock:paintClock,total:"160"}]})};context.pages=[page];context.ui={page};
  const body={page:0,total:160,preset:"week",atMs:clock-1,sequence:1,counts:{workbuddy:1},usageVersion:"new",body:{summary:{range:{start:new Date(clock-1000).toISOString(),end:new Date(clock+1000).toISOString()}}}};
  context.bodies.push(body);await pollBrowser(context);assert.equal(input.viewVisibleAtMs,undefined,"metadata alone cannot prove an input outside the selected range");
  body.body.summary.range.start=new Date(clock-100000).toISOString();body.usageVersion=null;
  await pollBrowser(context);assert.equal(input.viewVisibleAtMs,undefined,"an unversioned response cannot complete refresh");
  body.usageVersion="new";await pollBrowser(context);assert.equal(input.viewVisibleAtMs,clock);assert.equal(input.viewLandingToPaintMs,46027);
  assert.equal(input.viewPreset,"week");assert.equal(input.paintedAtMs,undefined,"all remains unconfirmed");
  paintClock=clock+80000;context.bodies.push({...body,preset:"all",sequence:2,atMs:paintClock-1});await pollBrowser(context);
  assert.equal(input.viewVisibleAtMs,clock);assert.equal(input.paintedAtMs,paintClock);assert.equal(input.landingToPaintMs,126027);
});

test("only in-flight requests rejected by a recorded controlled exit enter recovery observation",()=>{
  const now=Date.now(),old={},fresh={},context={requestStarts:new WeakMap([[old,now-10],[fresh,now+10]])};
  registerControlledExit(context,{pid:123,point:"before-commit",commandId:"kill-1",killedAtMs:now,gatewayPid:1});
  const response=request=>({status:()=>500,request:()=>request});
  assert.equal(matchingControlledExit(context,response(old),{code:"EXECUTOR_EXITED"}).commandId,"kill-1");
  assert.equal(matchingControlledExit(context,response(fresh),{code:"EXECUTOR_EXITED"}),null);
  assert.equal(matchingControlledExit(context,response(old),{code:"SQLITE_ERROR"}),null);
  context.controlledExits[0].killedAtMs=now-300_001;
  assert.equal(matchingControlledExit(context,response(old),{code:"EXECUTOR_EXITED"}),null);
});

test("one response listener survives the controlled 500 and observes spontaneous recovery",async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),"stability-response-"));t.after(()=>removeFixture(directory));
  const request={},context={directory,requestStarts:new WeakMap([[request,Date.now()-10]])};
  registerControlledExit(context,{pid:123,point:"after-commit-before-notify",commandId:"kill-1",killedAtMs:Date.now(),gatewayPid:1});
  const response=(status,body)=>({status:()=>status,url:()=>"http://localhost/api/usage?preset=all",request:()=>request,json:async()=>body});
  const failed=response(500,{code:"EXECUTOR_EXITED"}),recovered=response(200,{summary:{totals:{total:160}}});let listeners=0;
  const page={waitForResponse:async predicate=>{listeners++;assert.equal(await predicate(failed),false);assert.equal(await predicate(recovered),true);return recovered;}};
  assert.equal(await waitUsageResponse(context,page,"all",160,1000),recovered);assert.equal(listeners,1);
  await assert.rejects(()=>waitUsageResponse({...context,controlledExits:[]},page,"all",160,1000),/EXECUTOR_EXITED/);
});

test("uncontrolled background usage errors remain a run failure",async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),"stability-error-"));t.after(()=>removeFixture(directory));
  const context={directory,failures:[],responseTasks:new Set()},page=new EventEmitter(),request={url:()=>"http://localhost/api/usage?preset=all"};
  await attachPage(context,page);page.emit("request",request);
  page.emit("response",{status:()=>500,url:request.url,request:()=>request,json:async()=>({code:"EXECUTOR_EXITED"})});
  await Promise.all(context.responseTasks);assert.equal(context.failures.length,1);assert.match(context.failures[0].message,/Unexpected usage HTTP error/);
});

test("an executor exit between snapshot and liveness confirmation cannot lower the active memory gate",async()=>{
  const now=Date.now(),gateway={pid:10,name:"node.exe",role:"service",workingSetBytes:200*1048576};
  const sample={atUnixMs:now,service:{processCount:1,workingSetBytes:gateway.workingSetBytes},browser:{workingSetBytes:0},processes:[gateway],
    tombstones:[{pid:11,role:"service",name:"node.exe",reason:"exited",identityEvidence:{pid:11},resourceSnapshot:{
      startTimeUtc:new Date(now-1000).toISOString(),workingSetBytes:320*1048576,reportedPeakWorkingSetBytes:330*1048576,cpuSeconds:1,logicalReadBytes:1,logicalWriteBytes:1}}]};
  const context={inputs:[],actionTasks:new Set(),responseTasks:new Set(),lastActivityAtMs:now,resourceTails:[{servicePid:10,read:async()=>[JSON.stringify(sample)]}],
    resourceSummary:{samples:0,sampledPeakBytes:0,browserPeakBytes:0,cpuSeconds:0,readBytes:0,writeBytes:0,observerCpuSeconds:0,peakStorageBytes:0,peakWalBytes:0,excluded:[],idle:[]}};
  await assert.rejects(()=>pollResources(context),/Service tree exceeded 512/);
  assert.equal(context.resourceSummary.sampledPeakBytes,520*1048576);
});

test("retained snapshots include late landed mutations once, preserve original backups and reject gaps or duplicate inputs",async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),"stability-ledger-"));t.after(()=>removeFixture(directory));
  const file=path.join(directory,"base.json"),mutations=path.join(directory,"mutations.ndjson"),delta={total:160,input:140,cached:30,output:20,reasoning:5,cacheWrite:10,events:1,sessions:0};
  const first={operation:"append",kind:"codex",ordinal:1},second={...first,ordinal:2,expectedDelta:160,expectedEventDelta:1,deltaSessions:0,deltaTokens:{input:140,cached:30,output:20,reasoning:5,cacheWrite:10},cumulative:{total_tokens:320}};
  const ledger={entries:[first],appendCount:1,revisionCount:0,expected:{...delta},plans:[{backupFile:"original-backup"}],byKind:{codex:{ordinals:[1],appendCount:1,expected:{...delta}}}};
  await writeFile(file,JSON.stringify(ledger));await writeFile(mutations,JSON.stringify(second)+"\n");
  const restored=await retainedLedger(file,mutations);assert.equal(restored.appendCount,2);assert.equal(restored.expected.total,320);
  assert.deepEqual(restored.byKind.codex.ordinals,[1,2]);assert.deepEqual(restored.byKind.codex.cumulative,{total_tokens:320});assert.equal(restored.plans[0].backupFile,"original-backup");
  await appendFile(mutations,JSON.stringify(second)+"\n");await assert.rejects(()=>retainedLedger(file,mutations),/Duplicate/);
  await writeFile(mutations,JSON.stringify({...second,ordinal:3})+"\n");await assert.rejects(()=>retainedLedger(file,mutations),/ordinal gap/);
  const third={...second,kind:"dsh",ordinal:3},fourth={...second,ordinal:4},fifth={...third,ordinal:5};
  const zero=Object.fromEntries(Object.keys(delta).map(key=>[key,0]));
  const concurrent={...ledger,entries:[first,third,second],appendCount:3,expected:Object.fromEntries(Object.entries(delta).map(([key,value])=>[key,value*3])),
    byKind:{codex:{ordinals:[1,2],appendCount:2,expected:{...delta}},dsh:{ordinals:[3],appendCount:1,expected:{...zero}}}};
  await writeFile(file,JSON.stringify(concurrent));await writeFile(mutations,[fifth,fourth].map(row=>JSON.stringify(row)).join("\n")+"\n");
  const parallel=await retainedLedger(file,mutations);assert.deepEqual(parallel.entries.map(row=>row.ordinal),[1,3,2,5,4]);assert.equal(parallel.appendCount,5);assert.equal(parallel.expected.total,800);
  await writeFile(file,JSON.stringify({...ledger,restoredAtMs:1}));await assert.rejects(()=>retainedLedger(file),/already restored/);
});

test("local reproduction preserves the original zero, one and two minute spacing without waiting an hour",()=>{
  const schedule=multitabSchedule();assert.equal(schedule.durationMs,300_000);assert.equal(schedule.appendCount,2);
  assert.deepEqual(schedule.events.map(row=>[row.atMs,row.type]),[[0,"append"],[0,"tabs-open"],[0,"scopes"],[60_000,"arm-before-commit"],[120_000,"append"]]);
  assert.deepEqual(schedule.events.filter(row=>row.type==="append").map(row=>row.ordinal),[1,2]);
});
