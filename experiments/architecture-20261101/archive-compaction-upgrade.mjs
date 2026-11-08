import assert from "node:assert/strict";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ROOT, BASE, read, save, datasetOptions, diskBudget } from "./c1-datasets.mjs";
import { launch, stop, sampling, browser, responseFor, scope, expectedAll, checkBody } from "./c1-run.mjs";
import { painted } from "./b2-page-diagnostic.mjs";
import { projectionStorage } from "./c1-telemetry.mjs";
import { exactParity, regressionPassed } from "./persistent-history-analyze.mjs";
import { verifyEntries, verifyFrozenRuntime } from "./persistent-history-prepare.mjs";
import { hashFile } from "./remaining-harness-delivery-prepare.mjs";
import { measureChild } from "./archive-compaction-packages.mjs";

const RESULT=path.join(ROOT,"output/archive-compaction-20261108"),clock=()=>performance.timeOrigin+performance.now();

export function upgradeMapping(records,packages,databaseFile) {
  assert.equal(records.length,packages.length);
  const entries=records.map(previous=>{
    const replacement=packages.find(row=>row.previous.sha256===previous.segment_id);
    assert(replacement,"unmapped registered package");
    assert.equal(previous.database_sha256,replacement.previous.sha256);
    assert.equal(path.resolve(previous.database_path),replacement.previous.databaseFile);
    return {previous,next:{...previous,segment_id:replacement.next.sha256,database_sha256:replacement.next.sha256,
      database_path:replacement.next.databaseFile}};
  });
  return {format:1,databaseFile:path.resolve(databaseFile),packages:entries};
}

async function maintenance(configFile,directory) {
  const config=await read(configFile),runtime=await read(config.runtimeFile);await verifyFrozenRuntime(runtime);
  const {UsageStore}=await import(pathToFileURL(path.join(runtime.directory,"src/usage-store.js")));
  const {switchHistoryArchivePackages}=await import(pathToFileURL(path.join(runtime.directory,"src/history-archive-compaction.js")));
  const started=performance.now(),cpu=process.cpuUsage();
  const store=new UsageStore(datasetOptions(config.home,config.state));let result;
  try {
    await store.open();const mapping=upgradeMapping(store.database.prepare("SELECT * FROM archive_segments ORDER BY start_ms,segment_id").all(),config.packages,store.databaseFile);
    await save(path.join(directory,"compaction.json"),mapping);
    result=await switchHistoryArchivePackages(store,mapping);
    assert.equal(result.switched,config.packages.length);
    assert.equal(result.projection.rebuilt,false);assert.equal(result.projection.coldCopied,0);
  }finally{store.close();}
  await save(path.join(directory,"work.json"),{result,wallMs:performance.now()-started,cpu:process.cpuUsage(cpu),
    resourceUsage:process.resourceUsage(),projection:projectionStorage(config.state)});
}

async function pagePair(runtime,dataset,state,directory,clockFile,setup=false) {
  await mkdir(directory);let server,sampler,ui;const result={passed:false,storage:[]};
  try{
    ui=await browser();const errors=[];ui.page.on("pageerror",error=>errors.push(String(error)));
    for(const [index,name] of (setup?["first"]:["first","reopen"]).entries()){
      if(index){ui.page=await ui.context.newPage();ui.page.setDefaultTimeout(1800000);ui.page.setDefaultNavigationTimeout(1800000);}
      server=await launch(runtime,dataset,state,directory,index?"-reopen":"",clockFile);sampler=await sampling(server,state,directory,index?"-reopen":"");
      const pending=responseFor(ui.page,"today");void pending.catch(()=>{});await ui.page.goto(server.ready.url,{waitUntil:"domcontentloaded"});
      const response=await pending,body=await response.json();assert.equal(response.status(),200,JSON.stringify(body));
      await painted(ui.page,body.summary.totals.total,1800000);const defaultMs=clock()-server.startedAtMs;
      const all=await scope(ui.page,"all",expectedAll(dataset).total,directory,`${name}-all`);checkBody(all.body,expectedAll(dataset));
      result[name]={startedAtMs:server.startedAtMs,endedAtMs:clock(),wallMs:clock()-server.startedAtMs,defaultMs};
      await ui.page.close();await stop(server);server=null;await sampler.stop();sampler=null;
      result.storage.push({phase:name,...projectionStorage(state)});
    }
    assert.deepEqual(errors,[]);result.passed=true;
  }catch(error){result.failure={message:error.message,stack:error.stack};throw error;}
  finally{
    if(ui)await ui.instance.close();if(server)await stop(server);if(sampler)await sampler.stop();await save(path.join(directory,"result.json"),result);
  }
  return result;
}

async function upgrade(label) {
  assert(["current","year","two-years"].includes(label));await diskBudget(64);
  const manifestFile=path.join(RESULT,"manifest.json"),{verifyManifest}=await import("./archive-compaction-prepare.mjs"),manifest=await verifyManifest(manifestFile);
  const {validationGate}=await import("./archive-compaction-run.mjs");await validationGate(manifest.validationFile,manifest);
  for(const variant of ["baseline","candidate"]){
    const group=manifest.groups.find(row=>row.label===label&&row.layout==="mixed"&&row.variant===variant);
    const scene=await read(path.join(RESULT,"datasets",label,`scene-${group.name}/result.json`));assert.equal(scene.passed,true);assert.equal(scene.rawRestored,true);
  }
  const dataset=await read(path.join(BASE,"datasets",label,"dataset.json")),directory=path.join(RESULT,"upgrades",label),state=path.join(directory,"state");
  await mkdir(path.dirname(directory),{recursive:true});await mkdir(directory);
  await cp(path.join(dataset.root,"seed-mixed"),state,{recursive:true,force:false,errorOnExist:true});
  assert.equal(projectionStorage(state).databaseCount,0);
  const before=await read(manifest.baselineFile),after=await read(manifest.candidateFile),clockFile=path.join(directory,"clock.json");
  await save(clockFile,{asOf:new Date().toISOString(),phase:"upgrade",referencePhase:"upgrade"});
  const oldEnv={...process.env};Object.assign(process.env,{C1_MANIFEST:manifestFile,C1_ARCHIVE_TRACE:"1",C1_METHOD_DIAGNOSTIC:"1"});
  const result={label,passed:false,manifestSha256:await hashFile(manifestFile),candidateFingerprint:manifest.candidateFingerprint,
    setupBoundary:"Old runtime builds the existing projection from an isolated old index; no raw reimport. The same primary file and projection stay in place across upgrade."};
  try {
    result.setup=await pagePair(before.directory,dataset,state,path.join(directory,"setup"),clockFile,true);
    assert.equal(projectionStorage(state).databaseCount,1);
    result.baseline=await pagePair(before.directory,dataset,state,path.join(directory,"baseline"),clockFile);
    const configFile=path.join(directory,"maintenance.json");
    await save(configFile,{runtimeFile:manifest.candidateFile,home:dataset.home,state,packages:manifest.compactPackages.filter(row=>row.label===label)});
    result.maintenance=await measureChild(fileURLToPath(import.meta.url),["worker",configFile,path.join(directory,"maintenance")],path.join(directory,"maintenance"),state);
    result.candidate=await pagePair(after.directory,dataset,state,path.join(directory,"candidate"),clockFile);
    result.latencies=[];
    for(const phase of ["first","reopen"]){
      exactParity(await read(path.join(directory,"candidate",`${phase}-all.json`)),await read(path.join(directory,"baseline",`${phase}-all.json`)),false,true);
      const baselineMs=result.baseline[phase].wallMs,candidateMs=result.candidate[phase].wallMs;
      result.latencies.push({name:phase,baselineMs,candidateMs,passed:regressionPassed(baselineMs,candidateMs)});
    }
    const continued=await(await import("./archive-compaction-continuation.mjs")).continuation(manifest,manifestFile);
    result.passed=result.latencies.every(row=>row.passed);await verifyEntries(continued?.tools??manifest.tools);await verifyEntries(manifest.workspace);
    await verifyEntries(manifest.datasets.find(row=>row.label===label).entries);
  }catch(error){result.failure={message:error.message,stack:error.stack};throw error;}
  finally{
    for(const name of ["C1_MANIFEST","C1_ARCHIVE_TRACE","C1_METHOD_DIAGNOSTIC"]){if(oldEnv[name]===undefined)delete process.env[name];else process.env[name]=oldEnv[name];}
    await save(path.join(directory,"result.json"),result);
  }
  console.log(JSON.stringify({label,passed:result.passed,latencies:result.latencies,maintenanceMs:result.maintenance.wallMs}));
  assert(result.passed,"upgrade latency gate failed");
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]==="worker")process.once("message",()=>maintenance(...process.argv.slice(3)).then(()=>process.disconnect()).catch(error=>{console.error(error);process.exitCode=1;process.disconnect();}));
  else if(process.argv[2]==="run")await upgrade(process.argv[3]);
  else throw Error("run <current|year|two-years> | worker <config> <directory>");
}
