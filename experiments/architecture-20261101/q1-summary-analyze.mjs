import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BUSINESS_FIELDS, CELLS, VARIANTS, assertSeedParity, coldDecision, inside, normalizeBody, publishedAll } from './q3-benchmark-support.mjs';

const base=path.resolve(process.argv[2]||'output/architecture-20261103/q1/q1-20261103-c');
const continuation=process.argv[3]==='--continuation';
const q2=process.argv[3]==='--q2';
const q3=process.argv[3]==='--q3';
const modeAt=process.argv.indexOf('--mode');
const q3Mode=modeAt<0?'cold':process.argv[modeAt+1];
if(q3)assert.ok(['cold','page'].includes(q3Mode));
const baselineBase=q2&&process.argv[4]?path.resolve(process.argv[4]):base;
const read=async file=>JSON.parse(await readFile(file,'utf8'));
const lines=async file=>(await readFile(file,'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const stats=values=>{
  const ordered=values.filter(Number.isFinite).sort((a,b)=>a-b),n=ordered.length;
  return n?{n,min:ordered[0],median:n%2?ordered[n>>1]:(ordered[n/2-1]+ordered[n/2])/2,max:ordered.at(-1)}:null;
};
const maximum=values=>{const finite=values.filter(Number.isFinite);return finite.length?Math.max(...finite):null;};
const fields=['totals','costEstimate','eventCount','sessionCount','homeCount','timeline','timelineError','channels','models'];
const business=summary=>Object.fromEntries(fields.map(key=>[key,summary[key]]));
const results=[];
const runs=new Map(),missing=[];
let entries;
if(q3){
  const matrix=await read(path.join(base,'matrix.json'));
  assert.equal(matrix.generation,'q3');assert.equal(matrix.prepared,true);assert.equal(matrix.trials.length,18);
  entries=q3Mode==='cold'?matrix.trials:CELLS.flatMap(cell=>['baseline','candidate'].map(variant=>({cell,variant,directory:path.join(base,'page',cell,variant)})));
}else entries=['1x-sha','10x-sha'].flatMap(cell=>(continuation?['candidate']:['candidate','baseline']).map(variant=>({cell,variant,directory:path.join(variant==='baseline'?baselineBase:base,cell,variant)})));
for(const {cell,variant,directory,rep} of entries){
  assert.ok(!q3||inside(base,directory));
  let run;
  try{run=await read(path.join(directory,'result.json'));}
  catch(error){if(!q3||error.code!=='ENOENT')throw error;missing.push({cell,variant,rep,reserve:rep===3,directory});continue;}
  runs.set(`${cell}/${variant}/${rep??'page'}`,run);
  assert.equal(run.passed,true,`${cell}/${variant}`);
  if(q3){
    assert.equal(run.generation,'q3');assert.equal(run.cell,cell);assert.equal(run.variant,variant);
    assert.equal(run.mode,q3Mode==='cold'?'cold-only':'page');
    if(q3Mode==='cold'){assert.equal(run.rep,rep);assert.equal(run.appends.length,0);}
    else{
      assert.equal(run.seedParity?.passed,true);assert.equal(run.rounds,20);
      for(const kind of ['codex','dsh'])assert.equal(run.appends.filter(append=>append.kind===kind).length,20);
      assertSeedParity(run.first.all,await read(run.continuedFrom));
    }
  }
  assert.deepEqual(run.sourceBefore,run.sourceAfter);
  assert.equal(run.progress.length,2);
  for(const progress of run.progress)assert.equal(progress.validation.kind,q3&&variant==='candidate'?'sha256-prefix-v2':'sha256-prefix-v1');
  const components=(await Promise.all((await readdir(path.join(directory,'components'))).filter(f=>f.endsWith('.ndjson')).map(f=>lines(path.join(directory,'components',f))))).flat();
  assert.equal(components.filter(x=>x.error).length,0);
  const samples=await lines(path.join(directory,'resources.ndjson'));
  const resources=await read(path.join(directory,'resources.json'));
  const ordinary=samples.filter(x=>x.atUnixMs>=run.first.endedAtMs && x.atUnixMs<(run.reopen?.startedAtMs??Date.parse(run.endedAt)));
  const sum=(rows,key)=>rows.reduce((n,r)=>n+(Number(r.service[key])||0),0);
  const windows=run.appends.map(append=>{
    const rows=components.filter(r=>r.start>=append.startedAtMs&&r.start<=append.endedAtMs);
    const measured=samples.filter(r=>r.atUnixMs>=append.startedAtMs&&r.atUnixMs<=append.endedAtMs);
    const prepare=rows.filter(r=>r.label==='prepareAllSummaryProjection'&&r.work);
    return {kind:append.kind,wallMs:append.wallMs,summaryMs:rows.filter(r=>r.label==='summarizeInReadTransactionCore'&&r.preset==='all').map(r=>r.duration),
      viewMs:prepare.map(r=>r.duration),viewWork:prepare.map(r=>r.work),
      metadataMs:rows.filter(r=>r.label==='metadata').map(r=>r.duration),
      periodMs:rows.filter(r=>r.label==='periodComparison').map(r=>r.duration),
      quotaMs:rows.filter(r=>r.label==='prepareQuotaProjection').map(r=>r.duration),
      quotaWork:rows.filter(r=>r.label==='prepareQuotaProjection'&&r.work!==undefined).map(r=>r.work),
      metadataWork:rows.filter(r=>r.label==='prepareMetadataProjection'&&r.work).map(r=>r.work),
      rollupWork:rows.filter(r=>r.label==='prepareHotRollups'&&r.work).map(r=>r.work),
      syncRollupWork:rows.filter(r=>r.label==='syncRound'&&r.work).map(r=>r.work),
      cpuSeconds:sum(measured,'cpuSecondsIncrement'),logicalReadBytes:sum(measured,'logicalReadBytesIncrement'),logicalWriteBytes:sum(measured,'logicalWriteBytesIncrement')};
  });
  if(q2&&variant==='candidate')for(const window of windows){
    assert.equal(window.syncRollupWork.length,1);
    assert.equal(window.syncRollupWork[0].applied,true);
    assert.equal(window.syncRollupWork[0].readEvents,1);
    assert.ok(window.rollupWork.length>0&&window.rollupWork.every(work=>work.applied&&work.readEvents===0));
    assert.ok(window.metadataWork.some(work=>work.readEvents===1));
    assert.ok(window.metadataWork.every(work=>!work.rebuilt&&work.readEvents<=1));
  }
  let storage;
  if(q3)storage=run.finalView?.tables??run.initialView?.tables??[];
  else{
    const db=new DatabaseSync(run.prepared.databaseFile,{readOnly:true});
    try{storage=db.prepare("SELECT name,SUM(pgsize) bytes FROM dbstat WHERE name IN (SELECT name FROM sqlite_master WHERE tbl_name LIKE 'usage_all_%') GROUP BY name").all();}
    finally{db.close();}
  }
  const resourceSpans=[];
  for(const span of run.resourceSpans??[])resourceSpans.push({...span,summary:await read(path.join(span.directory,'resources.json'))});
  const result={cell,variant,rep,directory,initialEvents:run.first.all.eventCount,initialAllWallMs:run.first.all.wallMs,
    initialOpenThroughAllMs:run.first.endedAtMs-run.first.startedAtMs,reopenThroughAllMs:run.reopen?run.reopen.endedAtMs-run.reopen.startedAtMs:null,
    appends:Object.fromEntries(['codex','dsh'].map(kind=>[kind,stats(windows.filter(r=>r.kind===kind).map(r=>r.wallMs))])),windows,
    ordinaryServiceRssMax:maximum(ordinary.map(r=>r.service.workingSetBytes)),
    ordinaryServicePrivateMax:maximum(ordinary.map(r=>r.service.privateBytes)),
    wholeServiceRssMax:resources.service.peakSampledWorkingSetBytes,
    wholeBrowserRssMax:resources.browser.peakSampledWorkingSetBytes,
    wholeObserverCpuSeconds:resources.observer.cpuSecondsUsed,
    resourceSpans,reopenServiceRssMax:resourceSpans.find(span=>span.name==='reopen')?.summary.service.peakSampledWorkingSetBytes??null,
    initialView:run.initialView,finalView:run.finalView,storage,storageBytes:storage.reduce((n,r)=>n+Number(r.bytes),0),
    maximumQuoteBytes:maximum(components.map(r=>r.quoteBytes)),
    allCoreMs:stats(components.filter(r=>r.label==='summarizeInReadTransactionCore'&&r.preset==='all').map(r=>r.duration)),
    firstViewBuild:components.find(r=>r.work?.rebuilt),reusedViewMs:stats(components.filter(r=>r.work?.reused).map(r=>r.duration)),
    resourceState:resources.state,resourceTemp:resources.temp,
    q2Storage:run.finalQ2Storage,
    scopes:Object.fromEntries(['today','week','all'].map(preset=>[preset,stats(run.scopes.filter(row=>row.name&&row.preset===preset).map(row=>row.wallMs))])),
  };
  results.push(result);
}
let q3Groups,needsSupplement,pageSeeds;
if(q3){
  for(const variant of VARIANTS){
    const snapshots=[...runs.values()].filter(run=>run.variant===variant);
    for(const run of snapshots)assert.deepEqual(run.sourceBefore,snapshots[0].sourceBefore,`${variant} source changed across Q3 runs`);
  }
  for(const cell of CELLS){
    const cellRuns=[...runs.values()].filter(run=>run.cell===cell);
    for(const run of cellRuns){
      assert.equal(run.datasetSha256,cellRuns[0].datasetSha256);
      for(const [name,select] of [['initial',r=>r.first.all],...(q3Mode==='page'?[['final',publishedAll]]:[])]){
        const a=normalizeBody(select(run).body,run,name==='final');
        const b=normalizeBody(select(cellRuns[0]).body,cellRuns[0],name==='final');
        for(const key of BUSINESS_FIELDS)assert.deepEqual(a.summary[key],b.summary[key],`${cell} ${name} ${key}`);
        assert.deepEqual(a.metadata,b.metadata,`${cell} ${name} metadata`);
        assert.deepEqual(a.periodComparison,b.periodComparison,`${cell} ${name} periods`);
      }
    }
  }
  q3Groups=q3Mode==='cold'?CELLS.flatMap(cell=>VARIANTS.map(variant=>{
    const group=results.filter(row=>row.cell===cell&&row.variant===variant);
    const raw=group.map(row=>({rep:row.rep,wallMs:row.initialOpenThroughAllMs}));
    return {cell,variant,runs:raw,wallMs:stats(raw.map(run=>run.wallMs)),...coldDecision(raw)};
  })):undefined;
  needsSupplement=q3Mode==='cold'?q3Groups.filter(group=>group.nextRep===3):[];
  pageSeeds=q3Mode==='cold'?CELLS.flatMap(cell=>['baseline','candidate'].map(variant=>{
    const completed=results.filter(row=>row.cell===cell&&row.variant===variant).sort((a,b)=>b.rep-a.rep);
    return {cell,variant,preparedResult:completed.length?path.join(completed[0].directory,'result.json'):null};
  })):undefined;
}else{
for(const cell of ['1x-sha','10x-sha']){
  const a=await read(path.join(base,cell,'candidate/result.json'));
  if(continuation){
    assert.equal(a.seedParity.passed,true);
    const previous=await read(a.continuedFrom);
    assert.deepEqual(business(a.first.all.body.summary),business(previous.reopen.firstAll.body.summary),`${cell} continuation exact core parity`);
    continue;
  }
  const b=await read(path.join(baselineBase,cell,'baseline/result.json'));
  for(const [name,select] of [['initial',r=>r.first.all.body.summary],['final',r=>r.reopen.firstAll.body.summary]]){
    assert.deepEqual(business(select(a)),business(select(b)),`${cell} ${name} exact core business parity`);
  }
  if(q2){
    const normalize=(value,run,final=false)=>{
      const ids=new Map(run.first.all.body.metadata.homes.map(home=>[home.id,home.kind+':'+path.relative(run.prepared.home,home.path)]));
      const walk=(item)=>{
        if(Array.isArray(item))return item.map(walk);
        if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item)
          .filter(([key])=>!['generatedAt','asOf','modelUsageAsOf'].includes(key)&&!(final&&['modelLastSeen','activeHarnessModels'].includes(key)))
          .map(([key,v])=>[key,walk(v)]));
        if(typeof item==='string')return ids.get(item)??item.split(run.prepared.home).join('<home>');
        return item;
      };return walk(value);
    };
    for(const [name,select] of [['initial',r=>r.first.all.body],['final',r=>r.reopen.firstAll.body]]){
      assert.deepEqual(normalize(select(a).periodComparison,a),normalize(select(b).periodComparison,b),`${cell} ${name} exact periods`);
      assert.deepEqual(normalize(select(a).metadata,a,name==='final'||Boolean(a.continuedFrom)),normalize(select(b).metadata,b,name==='final'||Boolean(b.continuedFrom)),`${cell} ${name} metadata`);
    }
  }
}
}
const complete=q3?(q3Mode==='cold'?q3Groups.every(group=>group.complete):results.length===4):true;
const output={schemaVersion:q3?3:1,generatedAt:new Date().toISOString(),baselineBase,generation:q3?'q3':q2?'q2':'q1',mode:q3?q3Mode:undefined,
  complete,missing,needsSupplement,pageSeeds,coldGroups:q3Mode==='cold'?q3Groups:undefined,
  quotaWorkSemantics:q3?{source:'UsageStore.lastQuotaWork',changes:'Queue operations: insert=1, update=2; not SQL scanned rows.',
    endpointsAndCycles:'Actual counts reported by the projection; rebuilt/reused and fallback are preserved verbatim.',
    absent:'Frozen Q2 has no work API; missing work remains absent.'}:undefined,
  parity:{kind:q3?`q3-${q3Mode}`:continuation?'continuation':'baseline-candidate',groups:q3?results.length:continuation?2:4,fieldsPerGroup:fields.length,passed:complete},results};
await writeFile(path.join(base,q3?`analysis-${q3Mode}.json`:'analysis.json'),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({complete,needsSupplement,pageSeeds,parity:output.parity,results:results.map(({cell,variant,rep,appends,allCoreMs,storageBytes,ordinaryServiceRssMax,wholeServiceRssMax,maximumQuoteBytes})=>({cell,variant,rep,appends,allCoreMs,storageBytes,ordinaryServiceRssMax,wholeServiceRssMax,maximumQuoteBytes}))},null,2));
