import assert from "node:assert/strict";
import { appendFile,mkdtemp,mkdir,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { LineTail,visibleInputs,expectedWindow,checkResponse,awaitFault,launchServer,pollResources,correctYearIdle,pollBrowser,mutationSessions } from "./windows-stability-run.mjs";

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
  const root=await mkdtemp(path.join(tmpdir(),"stability-tail-"));t.after(()=>rm(root,{recursive:true,force:true}));
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
  const root=await mkdtemp(path.join(tmpdir(),"stability-idle-"));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,"resources"));
  const now=Date.now(),bytes=270*1048576;
  await writeFile(path.join(root,"events.ndjson"),JSON.stringify({type:"browser",kind:"fetch-start",page:1,id:1,url:"/api/usage",clock:now})+"\n");
  const sample=atUnixMs=>({atUnixMs,service:{processCount:1,workingSetBytes:bytes},browser:{workingSetBytes:0},treeMetadata:{runnerPid:1},processes:[{pid:10,parentPid:1,name:"node.exe",role:"service"}]});
  await writeFile(path.join(root,"resources/resources.ndjson"),[sample(now+1000),sample(now+61000)].map(row=>JSON.stringify(row)).join("\n")+"\n");
  assert.equal((await correctYearIdle(root,{idle:[{atMs:now+1000,bytes}]})).idle.length,0);
  await assert.rejects(()=>correctYearIdle(root,{idle:[{atMs:now+61000,bytes}]}),/Correctly idle sample exceeds/);
});

test("paint evidence waits for the already-arrived response to finish validation and persistence",async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),"stability-paint-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const clock=Date.now(),input={operation:"append",kind:"workbuddy",kindCount:1,landedAtMs:clock-1000};
  const context={directory,bodies:[],inputs:[input],responseTasks:new Set()};
  let complete;
  const pending=new Promise(resolve=>complete=()=>{context.bodies.push({total:160,preset:"all",atMs:clock-1,sequence:1,counts:{workbuddy:1},usageVersion:"new"});resolve();});
  context.responseTasks.add(pending);
  const page={isClosed:()=>false,evaluate:async()=>{setImmediate(complete);return {dropped:0,rows:[{kind:"paint",clock,total:"160"}]};}};
  context.pages=[page];context.ui={page};
  await pollBrowser(context);assert.equal(input.paintedAtMs,clock);assert.equal(input.landingToPaintMs,1000);
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
