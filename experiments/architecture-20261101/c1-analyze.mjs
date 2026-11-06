import { createReadStream } from "node:fs";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { BASE,read,save } from "./c1-datasets.mjs";

async function lines(file,visit){
  const rows=createInterface({input:createReadStream(file),crlfDelay:Infinity});
  for await(const line of rows)if(line.trim())visit(JSON.parse(line));
}

async function resources(directory){
  const result={servicePeakBytes:0,reportedServicePeakBytes:0,otherServicePeakBytes:0,browserPeakBytes:0,statePeakBytes:0,walPeakBytes:0,visibleTempPeakBytes:0,historyScratchPeakLogicalBytes:0,historyPrepares:[],cpuSeconds:0,logicalReadBytes:0,logicalWriteBytes:0,samples:0,activeSamples:0,missingMemorySamples:0,nodeHighWater:[]};
  for(const entry of await readdir(directory,{withFileTypes:true}))if(entry.isDirectory()&&entry.name.startsWith("resources")){
    await lines(path.join(directory,entry.name,"resources.ndjson"),row=>{
      result.samples++;result.servicePeakBytes=Math.max(result.servicePeakBytes,row.service.workingSetBytes??0);
      if(row.service.processCount>0){
        result.activeSamples++;
        if(row.service.memoryAvailableProcessCount!==row.service.processCount||!Number.isFinite(row.service.workingSetBytes)||!Number.isFinite(row.service.reportedPeakWorkingSetBytes))result.missingMemorySamples++;
        else result.reportedServicePeakBytes=Math.max(result.reportedServicePeakBytes,row.service.reportedPeakWorkingSetBytes);
      }
      result.otherServicePeakBytes=Math.max(result.otherServicePeakBytes,row.processes.filter(item=>item.role==="service"&&item.name.toLowerCase()!=="node.exe").reduce((sum,item)=>sum+(item.reportedPeakWorkingSetBytes??0),0));
      result.browserPeakBytes=Math.max(result.browserPeakBytes,row.browser.workingSetBytes??0);
      result.statePeakBytes=Math.max(result.statePeakBytes,row.state.totalBytes??0);
      result.walPeakBytes=Math.max(result.walPeakBytes,row.state.categoryBytes?.wal??0);
      result.visibleTempPeakBytes=Math.max(result.visibleTempPeakBytes,row.temp.totalBytes??0);
      result.cpuSeconds+=row.service.cpuSecondsIncrement??0;
      result.logicalReadBytes+=row.service.logicalReadBytesIncrement??0;
      result.logicalWriteBytes+=row.service.logicalWriteBytesIncrement??0;
    });
  }
  for(const file of await readdir(path.join(directory,"nodes")))if(/^node-.*\.jsonl$/.test(file)){
    await lines(path.join(directory,"nodes",file),row=>result.nodeHighWater.push({pid:row.pid,role:row.role,startedAtMs:row.startedAtMs,endedAtMs:row.endedAtMs,maxRssBytes:row.usage.maxRSS*1024,code:row.code,heapLimit:row.heapLimit,execArgv:row.execArgv}));
  }
  for(const file of await readdir(path.join(directory,"nodes")))if(/^history-.*\.ndjson$/.test(file)){
    await lines(path.join(directory,"nodes",file),row=>{
      result.historyPrepares.push(row);
      if(!row.error&&Number.isFinite(row.work?.scratchBytes))result.historyScratchPeakLogicalBytes=Math.max(result.historyScratchPeakLogicalBytes,row.work.scratchBytes);
    });
  }
  const expectedGateways=(await readdir(directory)).filter(file=>/^server(?:-reopen)?\.json$/.test(file)).length;
  result.nodeEvidenceComplete=expectedGateways>0&&result.nodeHighWater.filter(row=>row.role==="gateway").length===expectedGateways&&result.nodeHighWater.some(row=>row.role==="executor")&&
    result.nodeHighWater.every(row=>row.code===0&&Number.isFinite(row.maxRssBytes)&&row.maxRssBytes>0&&Number.isFinite(row.startedAtMs)&&Number.isFinite(row.endedAtMs)&&row.endedAtMs>=row.startedAtMs);
  const lastArg=(row,name)=>row.execArgv.filter(arg=>arg.startsWith(name+"=")).at(-1)?.split("=")[1];
  result.defaultHeapsPassed=result.nodeHighWater.length>0&&result.nodeHighWater.every(row=>lastArg(row,"--max-old-space-size")===(row.role==="executor"?"224":"512")&&
    (row.role!=="executor"||lastArg(row,"--max-semi-space-size")==="4"));
  result.nodePeakEnvelopeBytes=Math.max(0,...result.nodeHighWater.map(point=>result.nodeHighWater.filter(row=>row.startedAtMs<=point.startedAtMs&&row.endedAtMs>=point.startedAtMs).reduce((sum,row)=>sum+row.maxRssBytes,0)));
  result.memoryEnvelopeBytes=Math.max(result.servicePeakBytes,result.reportedServicePeakBytes,result.nodePeakEnvelopeBytes+result.otherServicePeakBytes);
  result.memoryPassed=result.activeSamples>0&&result.missingMemorySamples===0&&result.nodeEvidenceComplete&&result.defaultHeapsPassed&&result.memoryEnvelopeBytes<=512*1048576;
  return result;
}

function core(body){
  const groups=rows=>rows.map(({key,count,sessions,total})=>({key,count,sessions,total})).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  const value=body.summary;
  return {summary:{range:value.range,totals:value.totals,eventCount:value.eventCount,sessionCount:value.sessionCount,
    homeCount:value.homeCount,channels:groups(value.channels),models:groups(value.models),
    timeline:value.timeline.map(row=>({key:row.key,count:row.count,sessions:row.sessions,total:row.total,channels:groups(row.channels),models:groups(row.models)}))},
    periodComparison:body.periodComparison};
}

function stripClock(value){
  if(Array.isArray(value))return value.map(stripClock);
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).filter(([name])=>!["generatedAt","asOf","checkedAt"].includes(name)).map(([name,item])=>[name,stripClock(item)]));
  return value;
}

function exactDifference(actual,expected,where="$",differences=[]){
  if(Object.is(actual,expected))return differences;
  if(actual&&expected&&typeof actual==="object"&&typeof expected==="object"){
    for(const key of new Set([...Object.keys(actual),...Object.keys(expected)]))exactDifference(actual[key],expected[key],`${where}.${key}`,differences);
  }else if(differences.length<30)differences.push({where,actual,expected});
  return differences;
}

function comparableSummary(body,commonAsOf){
  const next=structuredClone(body.summary),comparison=next.comparison,range=next.range;
  if(comparison?.previousRange){
    const trend=asOf=>{
      const start=Date.parse(range.start),end=Date.parse(range.end),now=Date.parse(asOf);
      const duration=Date.parse(comparison.previousRange.end)-Date.parse(comparison.previousRange.start)+1;
      assert.ok([start,end,now,duration].every(Number.isFinite)&&duration>0,"comparison clock inputs must be valid");
      const baseline=Math.round(comparison.previousTotals.total*Math.max(0,Math.min(end,Math.max(start,now))-start+1)/duration);
      return {averageBaselineTotal:baseline,averageDelta:next.totals.total-baseline,
        averagePercentChange:baseline?Math.round((next.totals.total-baseline)/baseline*10000)/100:null};
    };
    for(const [name,expected] of Object.entries(trend(body.metadata.modelUsageAsOf)))assert.equal(comparison[name],expected,`actual ${name} must match its observation time`);
    Object.assign(comparison,trend(commonAsOf));
  }
  delete next.quota;
  return stripClock(next);
}

const selection=await read(path.join(BASE,"selected-runs.json"));
const result={baseline:"d31c3e0",selection,datasets:[],standards:{servicePeakBytes:512*1048576,samplesPerGroup:1,groups:6},issues:[],createdAt:new Date().toISOString()};
const expectedLabels=["current","year","two-years"];
if(new Set(selection.datasets.map(row=>row.label)).size!==selection.datasets.length||selection.datasets.some(row=>!expectedLabels.includes(row.label)))throw Error("invalid or duplicate dataset selection");
for(const label of expectedLabels)if(!selection.datasets.some(row=>row.label===label))result.issues.push({label,phase:"not-run",reason:selection.deferred?.[label]??"No completed scenes selected"});
for(const chosen of selection.datasets){
  const {label}=chosen;
  const root=path.join(BASE,"datasets",label),dataset=await read(path.join(root,"dataset.json"));
  const rebuilt=await read(path.join(root,"rebuild/result.json"));
  const record={label,days:dataset.days,events:dataset.expected.reduce((sum,row)=>sum+row.events,0),sessions:dataset.expectedSessions,
    files:dataset.expectedFiles,sourceBytes:dataset.sourceBytes,rebuild:{...rebuilt,resources:await resources(path.join(root,"rebuild"))},scenes:[],parity:[]};
  delete record.rebuild.delivery;
  record.capacityProof=await read(path.join(root,"capacity-proof.json"));
  if(!record.capacityProof.passed)result.issues.push({label,phase:"capacity-proof"});
  for(const layout of ["hot","mixed"]){
    const directory=path.join(root,`scene-${chosen[layout]}`),scene=await read(path.join(directory,"result.json"));
    if(scene.label!==label||scene.layout!==layout)throw Error("selected scene identity mismatch");
    const measured=await resources(directory);delete scene.delivery;delete scene.reopenDelivery;
    const publications=[];
    for(const file of await readdir(path.join(directory,"nodes")))if(/^prefix-.*\.ndjson$/.test(file))await lines(path.join(directory,"nodes",file),row=>publications.push(row));
    scene.publications=scene.changes.map(change=>{
      const kind=change.name.split("-").at(-1),family=value=>["main","extra","jetbrains","codex"].includes(value)?"codex":value;
      const receipts=publications.filter(row=>family(row.kind)===kind&&row.endedAtMs>=change.landedAtMs&&row.startedAtMs<=change.endedAtMs);
      return {name:change.name,calls:receipts.length,eventMutations:receipts.reduce((sum,row)=>sum+row.eventMutations,0),
        reusedPrefix:receipts.filter(row=>row.result?.reusedPrefix).length,errors:receipts.filter(row=>row.error).map(row=>row.error)};
    });
    const reusedRangeResources=scene.reusedQueryScopesFrom?await resources(path.join(root,`scene-${scene.reusedQueryScopesFrom}`)):null;
    record.scenes.push({...scene,resources:measured,reusedRangeResources});
    if(reusedRangeResources&&!reusedRangeResources.memoryPassed)result.issues.push({label,layout,kind:"reused-range-resources",memoryPassed:false});
    if(!scene.passed||!measured.memoryPassed)result.issues.push({label,layout,failure:scene.failure,memoryPassed:measured.memoryPassed});
  }
  if(label==="current"){
    record.controls=[];
    for(const scene of record.scenes){
      const layout=scene.layout,directory=path.join(root,`scene-${chosen.controls[layout]}`),before=await read(path.join(directory,"result.json"));
      const control={layout,baselinePassed:before.passed,latencies:[],exactSameLayout:[]};
      if(before.passed&&scene.passed){
        const reset=value=>value.sourceReset?.map(({kind,sha256,mtimeMs})=>({kind,sha256,mtimeMs}));
        const resetDifferences=exactDifference(reset(scene),reset(before));
        control.sourceResetMatched=resetDifferences.length===0&&Boolean(scene.sourceReset&&before.sourceReset);
        if(!control.sourceResetMatched)result.issues.push({label,layout,kind:"source-reset-mismatch",differences:resetDifferences});
        const pairs=[...["defaultPaintWallMs","initialServiceWallMs"].map(name=>[name,before[name],scene[name]]),
          ["first-all",before.initialAll.wallMs,scene.initialAll.wallMs],
          ["reopen",before.reopen.wallMs,scene.reopen.wallMs],
          ...scene.changes.map(change=>[change.name,before.changes.find(item=>item.name===change.name)?.actualPaintMs,change.actualPaintMs]),
          ...scene.scopes.map(item=>[item.preset,before.scopes.find(row=>row.preset===item.preset)?.wallMs,item.wallMs])];
        control.latencies=pairs.map(([name,baselineMs,candidateMs])=>({name,baselineMs,candidateMs,extraMs:candidateMs-baselineMs,
          ratio:candidateMs/baselineMs,passed:!(candidateMs>baselineMs*1.1&&candidateMs-baselineMs>100)}));
        for(const name of ["initial-all","today","week","custom","back-all",...['codex','dsh','claude','workbuddy','zcode','opencode'].map(kind=>`append-${kind}`),"revision-zcode","reopen-all"]){
          const old=await read(path.join(directory,`${name}.json`)),now=await read(path.join(root,`scene-${chosen[layout]}/${name}.json`));
          const comparedAsOf=old.metadata.modelUsageAsOf;
          const differences=exactDifference(comparableSummary(now,comparedAsOf),comparableSummary(old,comparedAsOf));
          control.exactSameLayout.push({name,passed:differences.length===0,differences,comparedAsOf});
        }
        if(control.latencies.some(row=>!row.passed)||control.exactSameLayout.some(row=>!row.passed))result.issues.push({label,layout,kind:"control",control});
      }else result.issues.push({label,layout,kind:scene.passed?"baseline-failed-control":"candidate-failed-control",failure:before.failure});
      record.controls.push(control);
    }
  }
  const archive=await read(path.join(root,"archive-build/result.json"));record.archive=archive;
  if(!rebuilt.passed||!record.rebuild.resources.memoryPassed||!archive.passed)result.issues.push({label,phase:"build",passed:rebuilt.passed,memoryPassed:record.rebuild.resources.memoryPassed,archivePassed:archive.passed});
  for(const name of ["initial-all","today","week","custom","back-all",...['codex','dsh','claude','workbuddy','zcode','opencode'].map(kind=>`append-${kind}`),"revision-zcode","reopen-all"]){
    try{
      const queryCase=["today","week","custom","back-all"].includes(name);
      const sceneFor=layout=>queryCase?record.scenes.find(item=>item.layout===layout).reusedQueryScopesFrom||chosen[layout]:chosen[layout];
      const hot=await read(path.join(root,`scene-${sceneFor('hot')}/${name}.json`)),mixed=await read(path.join(root,`scene-${sceneFor('mixed')}/${name}.json`));
      const differences=exactDifference(stripClock(core(mixed)),stripClock(core(hot)));
      record.parity.push({name,passed:differences.length===0,differences});
      if(differences.length)result.issues.push({label,name,kind:"exact-parity",differences});
    }catch(error){result.issues.push({label,name,kind:"missing-parity",message:error.message});}
  }
  record.archiveBytes=archive.packages.reduce((sum,item)=>sum+item.bytes,0);
  result.datasets.push(record);
}
result.passed=result.issues.length===0;
await save(path.join(BASE,process.argv[2]??"analysis.json"),result);
console.log(JSON.stringify({passed:result.passed,issues:result.issues,datasets:result.datasets.map(row=>({label:row.label,events:row.events,rebuildMs:row.rebuild.completeAllWallMs,scenes:row.scenes.map(scene=>({layout:scene.layout,passed:scene.passed,firstAllMs:scene.initialAll?.wallMs,servicePeakMiB:scene.resources.servicePeakBytes/1048576,appends:scene.changes.map(change=>[change.name,change.actualPaintMs]),reopenMs:scene.reopen?.wallMs}))}))}));
if(!result.passed)process.exitCode=1;
