import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath,pathToFileURL } from "node:url";
import {ROOT,BASE,DAY,KINDS,read,save,diskBudget,inside,datasetOptions} from "./c1-datasets.mjs";

const SCRIPT=fileURLToPath(import.meta.url),HERE=path.dirname(SCRIPT),TIMEOUT=1800000;
const clock=()=>performance.timeOrigin+performance.now();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const runtimeSpec=()=>read(process.env.C1_RUNTIME_SPEC || path.join(BASE,`${process.env.C1_RUNTIME||"baseline"}.json`));
const serving=process.argv[2]==="--serve";
const {waitForServer,painted}=serving?{}:await import("./b2-page-diagnostic.mjs");
const {observeQ5Delivery,readQ5Delivery}=serving?{}:await import("./q5-summary-hook.mjs");

async function launch(runtime,dataset,state,directory,suffix="",clockFile=null){
  const token=randomUUID(),config=path.join(directory,`server${suffix}.json`),nodes=path.join(directory,"nodes");
  await mkdir(nodes,{recursive:true});await mkdir(path.join(directory,"temp"),{recursive:true});
  await save(config,{runtime,clockFile,options:{...datasetOptions(dataset.home,state),shutdownToken:token}});
  const env={...process.env,REMAINING_DELIVERY_TRACE:nodes,TEMP:path.join(directory,"temp"),TMP:path.join(directory,"temp")};
  delete env.NODE_OPTIONS;
  delete env.C1_BUSINESS_CLOCK_FILE;
  if(clockFile)env.C1_BUSINESS_CLOCK_FILE=clockFile;
  for(const name of Object.keys(env))if(/^(ARCH_|Q[0-9]+_|B3_HISTORY_)/.test(name))delete env[name];
  const startedAtMs=clock();
  const child=spawn(process.execPath,["--max-old-space-size=512","--import",pathToFileURL(path.join(HERE,"c1-telemetry.mjs")).href,SCRIPT,"--serve",config],{cwd:ROOT,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  const out=await import("node:fs");const stdout=out.createWriteStream(path.join(directory,`stdout${suffix}.log`));const stderr=out.createWriteStream(path.join(directory,`stderr${suffix}.log`));
  child.stdout.pipe(stdout);child.stderr.pipe(stderr);
  try{return {child,ready:await waitForServer(child),token,startedAtMs};}
  catch(error){if(child.exitCode===null)child.kill();throw error;}
}

async function stop(server){
  if(!server||server.child.exitCode!==null)return;
  const ended=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{server.child.kill();reject(Error("C1 server shutdown timed out"));},30000);server.child.once("exit",(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
  const response=await fetch(server.ready.url+"/internal/shutdown",{method:"POST",headers:{"x-codex-usage-shutdown-token":server.token},signal:AbortSignal.timeout(20000)});
  assert.equal(response.status,202);const outcome=await ended;assert.equal(outcome.code,0);return outcome;
}

async function sampling(server,state,directory,suffix=""){
  const target=path.join(directory,`resources${suffix}`);await mkdir(target);const stopFile=path.join(target,"stop");
  const args=["-NoProfile","-File",path.join(HERE,"b2-attribution-resource.ps1"),"-ResultDir",target,"-ServicePid",String(server.ready.pid),"-RunnerPid",String(process.pid),"-StateDir",state,"-TempDir",path.join(directory,"temp"),"-StopFile",stopFile,"-SampleIntervalMilliseconds","250"];
  const pwsh=process.env.C1_MANIFEST?(await read(process.env.C1_MANIFEST)).runtime.pwsh.path:"pwsh";
  const child=spawn(pwsh,args,{cwd:ROOT,windowsHide:true,stdio:["ignore","pipe","pipe"]});let stderr="";child.stdout.resume();child.stderr.on("data",bytes=>{stderr+=bytes;});
  const ended=new Promise(resolve=>child.once("exit",resolve));
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){try{if((await stat(path.join(target,"resources.ndjson"))).size)break;}catch(error){if(error.code!=="ENOENT")throw error;}assert.equal(child.exitCode,null,stderr);await sleep(100);}
  assert.ok(Date.now()<deadline,"sampler startup timed out");
  return {async stop(){await writeFile(stopFile,"stop");const timer=setTimeout(()=>child.kill(),30000);try{assert.equal(await ended,0,stderr);}finally{clearTimeout(timer);}}};
}

async function browser(){
  const spec=await read(path.join(ROOT,"output/b3-mixed-history-20261107/matrix.json"));
  const {chromium}=await import(pathToFileURL(spec.runtime.playwright.file));
  const instance=await chromium.launch({headless:true,executablePath:spec.runtime.chromium.file});
  const context=await instance.newContext({viewport:{width:1440,height:1000}});
  await context.addInitScript(observeQ5Delivery);await context.addInitScript(()=>localStorage.setItem("codexUsageCalendarZoneV2","utc"));
  const page=await context.newPage();page.setDefaultTimeout(TIMEOUT);page.setDefaultNavigationTimeout(TIMEOUT);return {instance,context,page};
}

async function responseFor(page,preset,expectedTotal,timeout=TIMEOUT){
  return page.waitForResponse(async response=>{
    const url=new URL(response.url());if(url.pathname!=="/api/usage"||url.searchParams.get("preset")!==preset)return false;
    if(response.status()>=400)return true;
    if(expectedTotal===undefined)return true;
    try{const body=await response.json();return body.summary?.totals?.total===expectedTotal||
      body.metadata?.warnings?.some(warning=>/requires one row per timestamp\/session|reparsed source removes or migrates cold events/.test(String(warning)));}catch{return false;}
  },{timeout});
}

async function scope(page,preset,total,directory,name=preset){
  const start=clock(),pending=responseFor(page,preset,total);void pending.catch(()=>{});
  await page.locator(`[data-preset="${preset}"]`).click();const response=await pending;const body=await response.json();
  assert.equal(response.status(),200,JSON.stringify(body));await painted(page,body.summary.totals.total,TIMEOUT);
  const result={preset,wallMs:clock()-start,startedAtMs:start,endedAtMs:clock(),total:body.summary.totals.total,events:body.summary.eventCount,cache:response.headers()["x-summary-cache"]};
  await save(path.join(directory,`${name}.json`),body);return {result,body};
}

function verifyHot(file,dataset){
  const db=new DatabaseSync(file,{readOnly:true});try{
    const rows=db.prepare(`SELECT sf.kind,COUNT(e.id) events,COUNT(DISTINCT e.session_id) sessions,COUNT(DISTINCT sf.path) files,
      SUM(e.total) total,SUM(e.input) input,SUM(e.cached) cached,SUM(e.output) output,SUM(e.reasoning) reasoning
      FROM source_files sf LEFT JOIN events e ON sf.path=e.source_path GROUP BY sf.kind`).all().map(row=>({...row,kind:["main","extra","jetbrains","codex"].includes(row.kind)?"codex":row.kind}));
    const fields=["kind","events","sessions","files","total","input","cached","output","reasoning"];
    const normalized=list=>list.map(row=>Object.fromEntries(fields.map(field=>[field,row[field]]))).sort((a,b)=>a.kind.localeCompare(b.kind));
    assert.deepEqual(normalized(rows),normalized(dataset.expected));
    const quota=Number(db.prepare("SELECT COUNT(*) n FROM rate_limit_observations").get().n);assert.equal(quota,dataset.expectedQuota);
    const counts=db.prepare("SELECT COUNT(*) events,COUNT(DISTINCT session_id) sessions,MIN(timestamp_ms) minimum,MAX(timestamp_ms) maximum FROM events").get();
    assert.equal(counts.sessions,dataset.expectedSessions);assert.equal(db.prepare("PRAGMA quick_check").get().quick_check,"ok");
    assert.equal(Math.floor(Number(counts.minimum)/DAY)*DAY,dataset.startMs,"actual first input day");
    assert.equal((Math.floor(Number(counts.maximum)/DAY)+1)*DAY,dataset.endMs,"actual last input day");
    let locality=null;
    if(dataset.synthetic){
      const sessions=`SELECT sf.kind,e.session_id,MIN(e.timestamp_ms) first,MAX(e.timestamp_ms) last
        FROM events e JOIN source_files sf ON sf.path=e.source_path GROUP BY sf.kind,e.session_id`;
      const maxSpan=Number(db.prepare(`SELECT MAX(last-first) span FROM (${sessions})`).get().span);
      assert.ok(maxSpan<=49*DAY,"synthetic sessions must remain within their source block");
      const overlaps=db.prepare(`WITH bounds AS (${sessions}),ordered AS (
        SELECT *,LAG(last) OVER(PARTITION BY kind ORDER BY first,last,session_id) previous
        FROM bounds WHERE kind IN ('zcode','opencode'))
        SELECT kind,COUNT(*) overlaps FROM ordered WHERE first<previous GROUP BY kind`).all();
      assert.equal(overlaps.length,0,"SQLite sessions must occupy contiguous time groups");
      locality={maxSessionSpanMs:maxSpan,sqliteSessionOverlaps:overlaps};
    }
    return {passed:true,rows,counts,quota,locality};
  }finally{db.close();}
}

async function verifyCapacity(label){
  const dataset=await read(path.join(BASE,"datasets",label,"dataset.json"));
  const verification=verifyHot(path.join(dataset.root,"seed-state/usage-index.sqlite"),dataset);
  const archive=await read(path.join(dataset.root,"archive-build/result.json"));
  assert.equal(archive.passed,true);assert.equal(archive.packages.length,Math.ceil((dataset.days-30)/90));
  const db=new DatabaseSync(path.join(dataset.root,"seed-state/usage-index.sqlite"),{readOnly:true});
  let cursor=dataset.startMs;
  try{for(const entry of archive.packages){
    assert.equal(entry.startMs,cursor);assert.equal(entry.endMs,Math.min(cursor+90*DAY,dataset.endMs-30*DAY));
    const expected=Number(db.prepare("SELECT COUNT(*) n FROM events WHERE timestamp_ms>=? AND timestamp_ms<?").get(entry.startMs,entry.endMs).n);
    assert.ok(expected>0,"archive interval must contain real facts");assert.equal(entry.eventCount,expected);cursor=entry.endMs;
  }}finally{db.close();}
  assert.equal(cursor,dataset.endMs-30*DAY);
  const proof={passed:true,label,verification,packages:archive.packages.map(({startMs,endMs,eventCount})=>({startMs,endMs,eventCount})),at:new Date().toISOString()};
  await save(path.join(dataset.root,"capacity-proof.json"),proof);console.log(JSON.stringify({label,verified:true,events:verification.counts.events,locality:verification.locality}));
}

async function rebuild(label){
  const dataset=await read(path.join(BASE,"datasets",label,"dataset.json"));await diskBudget();
  const state=dataset.state;assert.ok(inside(BASE,state));await assert.rejects(stat(path.join(state,"usage-index.sqlite")),{code:"ENOENT"});
  const directory=path.join(dataset.root,"rebuild");await mkdir(directory);const runtime=(await runtimeSpec()).directory;
  const result={label,baseline:"d31c3e0",runtime,layout:"hot",passed:false,errors:[],scopes:[],startedAt:new Date().toISOString(),sourceChecksIncluded:true};let server,sampler,ui;
  try{
    ui=await browser();ui.page.on("pageerror",error=>result.errors.push(String(error.stack??error)));
    server=await launch(runtime,dataset,state,directory);sampler=await sampling(server,state,directory);
    const first=responseFor(ui.page,"today");void first.catch(()=>{});result.requestAtMs=clock();
    await ui.page.goto(server.ready.url,{waitUntil:"domcontentloaded"});const firstResponse=await first,firstBody=await firstResponse.json();
    assert.equal(firstResponse.status(),200,JSON.stringify(firstBody));await painted(ui.page,firstBody.summary.totals.total,TIMEOUT);
    result.defaultPaintWallMs=clock()-server.startedAtMs;await save(path.join(directory,"default.json"),firstBody);
    const expectedTotal=dataset.expected.reduce((sum,row)=>sum+row.total,0);const expectedEvents=dataset.expected.reduce((sum,row)=>sum+row.events,0);
    const all=await scope(ui.page,"all",expectedTotal,directory,"all");result.all=all.result;result.completeAllWallMs=all.result.endedAtMs-server.startedAtMs;
    assert.equal(all.body.summary.eventCount,expectedEvents);assert.equal(all.body.summary.sessionCount,dataset.expectedSessions);
    assert.equal(all.body.metadata.eventCount,expectedEvents);assert.equal(all.body.periodComparison.totals.all.total,expectedTotal);assert.deepEqual(result.errors,[]);
    result.delivery=await readQ5Delivery(ui.page);await ui.page.screenshot({path:path.join(directory,"all.png"),fullPage:true});
    await ui.instance.close();ui=null;result.shutdown=await stop(server);server=null;await sampler.stop();sampler=null;
    result.verification=verifyHot(path.join(state,"usage-index.sqlite"),dataset);
    const seed=path.join(dataset.root,"seed-state");await cp(state,seed,{recursive:true,force:false,errorOnExist:true});
    result.seed=seed;result.passed=true;
  }catch(error){result.failure={message:error.message,stack:error.stack,code:error.code};process.exitCode=1;}
  finally{
    if(ui)await ui.instance.close();if(server)await stop(server).catch(error=>{result.cleanupError=error.stack;process.exitCode=1;});if(sampler)await sampler.stop();
    result.endedAt=new Date().toISOString();await save(path.join(directory,"result.json"),result);
  }
  console.log(JSON.stringify({label,passed:result.passed,defaultPaintWallMs:result.defaultPaintWallMs,completeAllWallMs:result.completeAllWallMs,failure:result.failure?.message}));
}

async function mixed(label){
  const dataset=await read(path.join(BASE,"datasets",label,"dataset.json"));await diskBudget();
  const state=path.join(dataset.root,"state-mixed");await cp(path.join(dataset.root,"seed-state"),state,{recursive:true,force:false,errorOnExist:true});
  const directory=path.join(dataset.root,"archive-build");await mkdir(directory);const runtime=(await runtimeSpec()).directory;
  const started=clock();const {UsageStore}=await import(pathToFileURL(path.join(runtime,"src/usage-store.js")));
  const {createHistoryArchiveCandidate,prepareHistoryArchiveCommit}=await import(pathToFileURL(path.join(runtime,"src/history-archive.js")));
  const store=new UsageStore({databaseFile:path.join(state,"usage-index.sqlite")});await store.open();
  const result={label,runtime,passed:false,packages:[],startedAt:new Date().toISOString()};
  try{
    const cutoff=dataset.endMs-30*DAY,candidates=[];
    for(let start=dataset.startMs;start<cutoff;start+=90*DAY){
      const end=Math.min(cutoff,start+90*DAY),file=path.join(directory,`segment-${candidates.length}.sqlite`),begin=clock();
      await createHistoryArchiveCandidate(store.database,file,{startMs:start,endMs:end});candidates.push({file,startMs:start,endMs:end,createMs:clock()-begin});
      console.log(JSON.stringify({label,prepared:candidates.length,range:[start,end]}));
    }
    for(const candidate of candidates){const begin=clock();const plan=await prepareHistoryArchiveCommit(store.database,candidate.file);const committed=await store.commitHistoryArchiveEvents(plan);
      result.packages.push({...candidate,...committed,commitMs:clock()-begin,bytes:(await stat(candidate.file)).size});console.log(JSON.stringify({label,committed:result.packages.length,events:committed.eventCount}));}
    result.hotFacts=Number(store.database.prepare("SELECT COUNT(*) n FROM events").get().n);
    assert.equal(result.hotFacts+result.packages.reduce((sum,item)=>sum+item.eventCount,0),dataset.expected.reduce((sum,row)=>sum+row.events,0));
    assert.equal(store.database.prepare("PRAGMA quick_check").get().quick_check,"ok");result.passed=true;
  }catch(error){result.failure={message:error.message,stack:error.stack,code:error.code};process.exitCode=1;}
  finally{store.close();result.wallMs=clock()-started;result.resourceUsage=process.resourceUsage();result.memory=process.memoryUsage();
    if(result.passed){const begin=clock();await cp(state,path.join(dataset.root,"seed-mixed"),{recursive:true,force:false,errorOnExist:true});result.seedCopyMs=clock()-begin;}
    result.endedAt=new Date().toISOString();await save(path.join(directory,"result.json"),result);}
  console.log(JSON.stringify({label,mixedReady:result.passed,packages:result.packages.length,wallMs:result.wallMs,failure:result.failure?.message}));
}

const TOKEN_FIELDS=["total","input","cached","output","reasoning"];
function expectedAll(dataset){return {events:dataset.expected.reduce((sum,row)=>sum+row.events,0),sessions:dataset.expectedSessions,
  ...Object.fromEntries(TOKEN_FIELDS.map(field=>[field,dataset.expected.reduce((sum,row)=>sum+row[field],0)]))};}

function checkBody(body,expected,global=expected){
  assert.equal(body.summary.timelineError,null);
  assert.equal(body.summary.eventCount,expected.events);assert.equal(body.summary.sessionCount,expected.sessions);
  for(const field of TOKEN_FIELDS)assert.equal(body.summary.totals[field],expected[field],field);
  assert.equal(body.metadata.eventCount,global.events);assert.equal(body.metadata.sessionCount,global.sessions);
  assert.equal(body.periodComparison.totals.all.total,global.total);
}

function expectedRange(dataset,range){
  const db=new DatabaseSync(path.join(dataset.root,"seed-state/usage-index.sqlite"),{readOnly:true});
  try{return {...db.prepare(`SELECT COUNT(*) events,COUNT(DISTINCT session_id) sessions,
    ${TOKEN_FIELDS.map(field=>`COALESCE(SUM(${field}),0) ${field}`).join(",")}
    FROM events WHERE timestamp_ms>=? AND timestamp_ms<=?`).get(Date.parse(range.start),Date.parse(range.end))};}
  finally{db.close();}
}

async function customScope(page,dataset,directory){
  const cutoff=dataset.endMs-30*DAY,start=new Date(cutoff-2*DAY).toISOString().slice(0,10),end=new Date(cutoff+2*DAY).toISOString().slice(0,10);
  const startedAtMs=clock();await page.locator("#dateRangeButton").click();
  for(const date of [start,end]){
    for(let attempts=0;!(await page.locator(`[data-date="${date}"]`).count());attempts++){
      assert.ok(attempts<30,"custom calendar navigation exceeded the declared history");
      const visible=await page.locator(".date-picker-day:not(.outside-month)").first().getAttribute("data-date");
      await page.locator(`[data-date-picker-action="${date<visible?"prev":"next"}"]`).click();
    }
    if(date===end){
      const pending=responseFor(page,"custom");void pending.catch(()=>{});await page.locator(`[data-date="${date}"]`).click();
      const response=await pending,body=await response.json();assert.equal(response.status(),200,JSON.stringify(body));
      await painted(page,body.summary.totals.total,TIMEOUT);await save(path.join(directory,"custom.json"),body);
      return {body,result:{preset:"custom",start,end,startedAtMs,endedAtMs:clock(),wallMs:clock()-startedAtMs,total:body.summary.totals.total,events:body.summary.eventCount}};
    }
    await page.locator(`[data-date="${date}"]`).click();
  }
}

async function mutation(page,plan,method,expected,directory,name){
  const before=await readQ5Delivery(page),pending=responseFor(page,"all",expected.total);void pending.catch(()=>{});
  const changed=await method(plan);await save(path.join(directory,`${name}-landed.json`),changed);
  const response=await pending,body=await response.json();
  assert.equal(response.status(),200,JSON.stringify(body));checkBody(body,expected);await painted(page,expected.total,TIMEOUT);
  const delivery=await readQ5Delivery(page);assert.equal(delivery.dropped,0);
  const rows=delivery.rows.slice(before.rows.length),paint=rows.find(row=>row.kind==="paint"&&Number(String(row.total).replace(/[^0-9]/g,""))===expected.total);
  assert.ok(rows.some(row=>row.kind==="page-receipt"&&row.event==="usage-synced"),"mutation requires committed-source notification");
  assert.ok(paint,"correct new-value frame is missing");assert.ok(paint.clock>=changed.landedAtMs);
  await save(path.join(directory,`${name}.json`),body);
  return {name,...changed,expected:{...expected},actualPaintMs:paint.clock-changed.landedAtMs,confirmedMs:clock()-changed.landedAtMs,endedAtMs:clock()};
}

async function scene(label,layout,runName=layout,reuseQueries=null){
  const diagnostic=process.env.C1_ARCHIVE_PROFILE==="diagnostic";
  if(diagnostic)assert.ok(label==="two-years"&&layout==="mixed"&&runName==="mixed-diagnostic","fixed diagnostic only");
  assert.ok(["hot","mixed"].includes(layout));assert.match(runName,/^[a-z0-9-]+$/);
  const dataset=await read(path.join(BASE,"datasets",label,"dataset.json"));await diskBudget();
  const {scenePaths,verifyScene,writeReplayClock}=await import("./persistent-history-prepare.mjs");
  const paths=scenePaths(dataset,layout,runName),{directory,state}=paths;
  let evidence=null;
  if(process.env.C1_RESULT_ROOT){
    assert.ok(process.env.C1_MANIFEST&&process.env.C1_RUNTIME_SPEC,"separate results require explicit manifest and runtime spec");
    assert.equal(reuseQueries,null,"new fixed groups must measure their own queries");
    const verify=process.env.C1_ARCHIVE_PROFILE==="compaction"?(await import("./archive-compaction-prepare.mjs")).verifyScene:
      process.env.C1_ARCHIVE_PROFILE?(await import("./archive-verification-prepare.mjs")).verifyScene:verifyScene;
    evidence=await verify(process.env.C1_MANIFEST,label,layout,runName,process.env.C1_RUNTIME_SPEC);
  }
  await mkdir(path.dirname(directory),{recursive:true});await mkdir(directory);
  const replay=evidence?.clockReplay,clockFile=replay?path.join(directory,"business-clock.json"):null,phaseWrites=[];
  if(evidence&&label==="year"&&!process.env.C1_ARCHIVE_PROFILE)assert.ok(replay,"year candidate requires explicit historical replay");
  const phase=async name=>{if(replay)phaseWrites.push(await writeReplayClock(clockFile,replay,name));};
  await assert.rejects(stat(state),{code:"ENOENT"});
  await cp(paths.seed,state,{recursive:true,force:false,errorOnExist:true});
  if(process.env.C1_ARCHIVE_PROFILE==="compaction"&&layout==="mixed"&&evidence?.variant==="candidate")
    await (await import("./archive-compaction-prepare.mjs")).installScenePackages(process.env.C1_MANIFEST,label,state);
  const spec=await runtimeSpec(),runtime=spec.directory;
  const {projectionStorage}=await import("./c1-telemetry.mjs");
  const storage=[{phase:"old-index-start",atMs:clock(),...projectionStorage(state)}];
  if(evidence)assert.equal(storage[0].databaseCount,0,"initialization must start from an old index without a projection");
  let previousQueries=null;
  if(reuseQueries){
    assert.match(reuseQueries,/^[a-z0-9-]+$/);
    previousQueries=await read(path.join(dataset.root,`scene-${reuseQueries}/result.json`));
    assert.equal(previousQueries.label,label);assert.equal(previousQueries.layout,layout);
    assert.deepEqual(previousQueries.scopes.map(row=>row.preset),["today","week","custom","all"]);
  }
  const {prepareC1Mutations,appendC1Mutation,reviseC1Mutation,restoreC1Mutations}=await import("./c1-source-mutations.mjs");
  const plans=await prepareC1Mutations(dataset,{databaseFile:path.join(dataset.root,"seed-state/usage-index.sqlite"),runtimeDirectory:runtime,directory:path.join(directory,"mutations"),
    replayTimestamps:replay?Object.fromEntries(replay.mutations.map(row=>[row.kind,row.timestampMs])):null});
  for(const plan of plans)assert.equal(plan.sha256,dataset.files.find(file=>path.resolve(file.path)===path.resolve(plan.filePath))?.sha256,"source bytes must match the original capacity input");
  if(replay)for(const plan of plans)assert.equal(plan.filePath,replay.mutations.find(row=>row.kind===plan.kind)?.filePath,"historical replay must mutate the same original source");
  await save(path.join(directory,"mutation-plans.json"),plans);
  const resetStarted=clock(),sourceReset=await restoreC1Mutations(plans);
  const result={label,layout,runtime,baseline:spec.commit||spec.baseline||"d31c3e0",evidence,storage,sourceMetadataCondition:"six files restored using fixed seed mtime targets; ctime changes and real validation remains enabled",sourceReset,sourceResetMs:clock()-resetStarted,passed:false,scopes:[],changes:[],errors:[],startedAt:new Date().toISOString()};
  if(replay)result.clockReplay={fingerprint:evidence.clockReplayFingerprint,clockFile,phaseWrites,boundary:replay.boundary};
  if(reuseQueries)result.reusedQueryScopesFrom=reuseQueries;
  let server,sampler,ui;
  try{
    ui=await browser();ui.page.on("pageerror",error=>result.errors.push(String(error.stack??error)));
    await phase("default");server=await launch(runtime,dataset,state,directory,"",clockFile);sampler=await sampling(server,state,directory);
    const pending=responseFor(ui.page,"today");void pending.catch(()=>{});await ui.page.goto(server.ready.url,{waitUntil:"domcontentloaded"});
    const first=await pending,firstBody=await first.json();assert.equal(first.status(),200,JSON.stringify(firstBody));await painted(ui.page,firstBody.summary.totals.total,TIMEOUT);
    result.defaultPaintWallMs=clock()-server.startedAtMs;checkBody(firstBody,expectedRange(dataset,firstBody.summary.range),expectedAll(dataset));await save(path.join(directory,"default.json"),firstBody);
    await phase("initial-all");const expected=expectedAll(dataset),initial=await scope(ui.page,"all",expected.total,directory,"initial-all");checkBody(initial.body,expected);result.initialAll=initial.result;
    result.initialServiceWallMs=clock()-server.startedAtMs;
    result.serviceStartedAtMs=server.startedAtMs;
    storage.push({phase:"initial-all",atMs:clock(),...projectionStorage(state)});
    if(diagnostic){
      result.profile="diagnostic";
    }else if(previousQueries){
      for(const name of ["today","week","custom","back-all"]){
        const body=await read(path.join(dataset.root,`scene-${reuseQueries}/${name}.json`));
        checkBody(body,expectedRange(dataset,body.summary.range),expected);
        if(name==="today")for(const field of ["start","end","calendarZone"])assert.equal(body.summary.range[field],firstBody.summary.range[field],"a changed calendar day requires fresh range checks");
      }
      result.scopes=previousQueries.scopes.map(row=>({...row,reusedFrom:reuseQueries}));
    }else{
      for(const preset of ["today","week"]){await phase(preset);const value=await scope(ui.page,preset,undefined,directory);checkBody(value.body,expectedRange(dataset,value.body.summary.range),expected);result.scopes.push(value.result);}
      await phase("custom");const custom=await customScope(ui.page,dataset,directory);checkBody(custom.body,expectedRange(dataset,custom.body.summary.range),expected);result.scopes.push(custom.result);
      await phase("back-all");const back=await scope(ui.page,"all",expected.total,directory,"back-all");checkBody(back.body,expected);result.scopes.push(back.result);
    }
    if(evidence&&!diagnostic){
      await phase("repeat-all");
      const repeat=await scope(ui.page,"all",expected.total,directory,"repeat-all");checkBody(repeat.body,expected);
      const deadline=Date.now()+30000;let exited;
      while(Date.now()<deadline&&!exited){
        for(const file of await readdir(path.join(directory,"nodes")))if(/^node-.*\.jsonl$/.test(file)){
          const rows=(await readFile(path.join(directory,"nodes",file),"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));
          exited=rows.find(row=>row.role==="executor"&&row.code===0&&row.endedAtMs>=result.initialAll.startedAtMs)||exited;
        }
        if(!exited)await sleep(100);
      }
      assert.ok(exited,"executor idle exit must be observed without extending its lifetime");
      await sleep(500);
      await phase("after-executor-exit-all");
      const startedAtMs=clock(),url=new URL("/api/usage",server.ready.url);
      url.search=new URLSearchParams({preset:"all",bucket:"day",recentValue:"今年",calendarZone:"utc",view:"dashboard"});
      const response=await ui.page.request.get(url.href,{timeout:TIMEOUT}),body=await response.json();
      assert.equal(response.status(),200,JSON.stringify(body));assert.equal(response.headers()["x-summary-cache"],"miss","executor reuse probe must reach business query, not HTTP cache");
      checkBody(body,expected);
      const {executorReuseParity}=await import("./persistent-history-analyze.mjs");executorReuseParity(body,initial.body,Boolean(replay));
      await save(path.join(directory,"after-executor-exit-all.json"),body);
      result.reuseChecks={repeat:repeat.result,executorExit:exited,afterExit:{preset:"all",bucket:"day",recentValue:"今年",cache:"miss",
        cacheBypass:"unused recentValue only; same all/day business context",startedAtMs,endedAtMs:clock(),wallMs:clock()-startedAtMs}};
    }
    for(const plan of plans.filter(plan=>!diagnostic||["codex","zcode"].includes(plan.kind))){
      await phase(`append-${plan.kind}`);
      expected.events++;expected.total+=160;expected.input+=140;expected.cached+=30;expected.output+=20;expected.reasoning+=["codex","zcode","opencode","workbuddy"].includes(plan.kind)?5:0;
      result.changes.push(await mutation(ui.page,plan,appendC1Mutation,expected,directory,`append-${plan.kind}`));
      storage.push({phase:`append-${plan.kind}`,atMs:clock(),...projectionStorage(state)});
    }
    if(!diagnostic){
    expected.total+=19;expected.output+=19;
    await phase("revision-zcode");
    result.changes.push(await mutation(ui.page,plans.find(plan=>plan.kind==="zcode"),reviseC1Mutation,expected,directory,"revision-zcode"));
    storage.push({phase:"revision-zcode",atMs:clock(),...projectionStorage(state)});
    }
    result.delivery=await readQ5Delivery(ui.page);await ui.page.screenshot({path:path.join(directory,"final.png"),fullPage:true});
    await ui.page.close();await stop(server);server=null;await sampler.stop();sampler=null;
    storage.push({phase:"closed",atMs:clock(),...projectionStorage(state)});
    ui.page=await ui.context.newPage();ui.page.setDefaultTimeout(TIMEOUT);ui.page.setDefaultNavigationTimeout(TIMEOUT);
    await phase("reopen-all");server=await launch(runtime,dataset,state,directory,"-reopen",clockFile);sampler=await sampling(server,state,directory,"-reopen");
    const reopened=responseFor(ui.page,"today");void reopened.catch(()=>{});await ui.page.goto(server.ready.url,{waitUntil:"domcontentloaded"});
    const reopenedResponse=await reopened;assert.equal(reopenedResponse.status(),200,await reopenedResponse.text());
    const value=await scope(ui.page,"all",expected.total,directory,"reopen-all");checkBody(value.body,expected);
    result.reopen={...value.result,serviceStartedAtMs:server.startedAtMs,wallMs:clock()-server.startedAtMs};result.reopenDelivery=await readQ5Delivery(ui.page);
    assert.deepEqual(result.errors,[]);result.expected=expected;result.passed=true;
  }catch(error){result.failure={message:error.message,stack:error.stack,code:error.code};process.exitCode=1;}
  finally{
    if(ui)await ui.instance.close();if(server)await stop(server).catch(error=>{result.cleanupError=error.stack;process.exitCode=1;});if(sampler)await sampler.stop();
    storage.push({phase:"reopen-closed",atMs:clock(),...projectionStorage(state)});
    try{result.restoredSources=await restoreC1Mutations(plans);result.rawRestored=true;}
    catch(error){result.passed=false;result.restoreFailure=error.stack;process.exitCode=1;}
    if(evidence)try{
      const {verifyEntries,verifyFrozenRuntime}=await import("./persistent-history-prepare.mjs");
      const manifest=await read(process.env.C1_MANIFEST);
      await verifyEntries(manifest.tools);if(manifest.workspace.length)await verifyEntries(manifest.workspace);await verifyFrozenRuntime(spec);
      if(process.env.C1_ARCHIVE_PROFILE)await verifyEntries(manifest.datasets.find(row=>row.label===label).entries);
    }
    catch(error){result.passed=false;result.integrityFailure=error.stack;process.exitCode=1;}
    result.endedAt=new Date().toISOString();await save(path.join(directory,"result.json"),result);
  }
  console.log(JSON.stringify({label,layout,passed:result.passed,firstAllMs:result.initialAll?.wallMs,appends:result.changes.map(row=>[row.name,row.actualPaintMs]),reopenMs:result.reopen?.wallMs,failure:result.failure?.message}));
}

export { launch, stop, sampling, browser, responseFor, scope, expectedAll, checkBody };

if(process.argv[1]&&path.resolve(process.argv[1])===SCRIPT){
if(serving){
  const config=await read(process.argv[3]);const {createUsageServer}=await import(pathToFileURL(path.join(config.runtime,"src/server.js")));
  let server,closing=false;async function close(){if(closing)return;closing=true;await new Promise(resolve=>server.close(resolve));process.exit(0);}
  server=createUsageServer({...config.options,onShutdown:()=>void close()});server.on("error",error=>{console.error(error.stack);process.exit(1);});
  server.listen(0,"127.0.0.1",()=>console.log(JSON.stringify({stage:"server-ready",pid:process.pid,port:server.address().port,url:`http://127.0.0.1:${server.address().port}`})));
  process.once("SIGTERM",()=>void close());process.once("SIGINT",()=>void close());
}else if(process.argv[2]==="rebuild")await rebuild(process.argv[3]);
else if(process.argv[2]==="mixed")await mixed(process.argv[3]);
else if(process.argv[2]==="scene")await scene(process.argv[3],process.argv[4],process.argv[5],process.argv[6]);
else if(process.argv[2]==="verify")await verifyCapacity(process.argv[3]);
else throw Error("rebuild <dataset> | mixed <dataset> | scene <dataset> <hot|mixed> [name] | verify <dataset>");
}
