import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BUSINESS_FIELDS, CELLS, Q4_VARIANTS, VARIANTS, assertQ4Matrix, assertSeedParity, coldDecision, coldStageFailures, finalQ4Cold, q4PageSeed, inside, normalizeBody, publishedAll } from './q3-benchmark-support.mjs';
import { assertQ5Matrix, q5Trials } from './q5-prepare.mjs';
import { readCapturedPricing, assertQ5TraceCoverage } from './q5-summary-hook.mjs';

const base=path.resolve(process.argv[2]||'output/architecture-20261103/q1/q1-20261103-c');
const continuation=process.argv[3]==='--continuation';
const q2=process.argv[3]==='--q2';
const q3=process.argv[3]==='--q3';
const generationAt=process.argv.indexOf('--generation');
if(generationAt>=0)assert.ok(['q4','q5'].includes(process.argv[generationAt+1]));
const q5=process.argv[3]==='--q5'||generationAt>=0&&process.argv[generationAt+1]==='q5';
const q4=process.argv[3]==='--q4'||generationAt>=0&&!q5;
const modern=q3||q4,generation=q4?'q4':q3?'q3':q2?'q2':'q1',variants=q4?Q4_VARIANTS:VARIANTS,pageRounds=q4?10:20;
const modeAt=process.argv.indexOf('--mode');
const q3Mode=modeAt<0?'cold':process.argv[modeAt+1];
if(modern)assert.ok(['cold','page'].includes(q3Mode));
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
if(q5){await analyzeQ5();process.exit(0);}
const results=[];
const runs=new Map(),missing=[];
let entries;
if(modern){
  const matrix=await read(path.join(base,'matrix.json'));
  if(q4){assert.equal(base,matrix.base);assertQ4Matrix(matrix,path.basename(base));}
  else {assert.equal(matrix.generation,'q3');assert.equal(matrix.prepared,true);assert.equal(matrix.trials.length,18);}
  entries=q3Mode==='cold'?matrix.trials:CELLS.flatMap(cell=>['baseline','candidate'].map(variant=>({cell,variant,directory:path.join(base,'page',cell,variant)})));
}else entries=['1x-sha','10x-sha'].flatMap(cell=>(continuation?['candidate']:['candidate','baseline']).map(variant=>({cell,variant,directory:path.join(variant==='baseline'?baselineBase:base,cell,variant)})));
for(const {cell,variant,directory,rep} of entries){
  assert.ok(!modern||inside(base,directory));
  let run;
  try{run=await read(path.join(directory,'result.json'));}
  catch(error){if(!modern||error.code!=='ENOENT')throw error;missing.push({cell,variant,rep,reserve:rep===3,directory});continue;}
  runs.set(`${cell}/${variant}/${rep??'page'}`,run);
  assert.equal(run.passed,true,`${cell}/${variant}`);
  if(modern){
    assert.equal(run.generation,generation);assert.equal(run.cell,cell);assert.equal(run.variant,variant);
    assert.equal(run.mode,q3Mode==='cold'?'cold-only':'page');
    if(q3Mode==='cold'){assert.equal(run.rep,rep);assert.equal(run.appends.length,0);}
    else{
      assert.equal(run.seedParity?.passed,true);assert.equal(run.rounds,pageRounds);
      for(const kind of ['codex','dsh'])assert.equal(run.appends.filter(append=>append.kind===kind).length,pageRounds);
      assertSeedParity(run.first.all,await read(run.continuedFrom));
      if(q4){
        assert.equal(run.appends.length,20);assert.equal(run.rep,null);
        const seed=await q4PageSeed(base,cell,variant,run.retrySeed===true);
        assert.equal(path.resolve(run.continuedFrom),seed.file);
        assert.deepEqual(run.prepared,seed.run.prepared);
        assert.deepEqual(run.sourceBefore,seed.run.sourceAfter);
        assert.equal(run.datasetSha256,seed.run.datasetSha256);
      }
    }
  }
  assert.deepEqual(run.sourceBefore,run.sourceAfter);
  assert.equal(run.progress.length,2);
  for(const progress of run.progress)assert.equal(progress.validation.kind,q4||(q3&&variant==='candidate')?'sha256-prefix-v2':'sha256-prefix-v1');
  const components=(await Promise.all((await readdir(path.join(directory,'components'))).filter(f=>f.endsWith('.ndjson')).map(f=>lines(path.join(directory,'components',f))))).flat();
  assert.equal(components.filter(x=>x.error).length,0);
  const coldStages=q4?(await Promise.all((await readdir(path.join(directory,'components'))).filter(f=>f.endsWith('.jsonl')).map(f=>lines(path.join(directory,'components',f))))).flat():undefined;
  const stageFailures=q4?coldStageFailures(coldStages):undefined;
  if(q4)assert.deepEqual(stageFailures.unhandled,[],'Only proved successful SOURCE_PROGRESS_UNSUPPORTED retries are recoveries.');
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
  if(modern)storage=run.finalView?.tables??run.initialView?.tables??[];
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
    ...(q4?{q4Storage:{initial:run.initialQ4Storage,final:run.finalQ4Storage,reopen:run.reopenQ4Storage},coldStages,recoveredSourceAttempts:stageFailures.recovered}:{}),
    scopes:Object.fromEntries(['today','week','all'].map(preset=>[preset,stats(run.scopes.filter(row=>row.name&&row.preset===preset).map(row=>row.wallMs))])),
  };
  results.push(result);
}
let q3Groups,needsSupplement,pageSeeds;
if(modern){
  for(const variant of variants){
    const snapshots=[...runs.values()].filter(run=>run.variant===variant);
    for(const run of snapshots)assert.deepEqual(run.sourceBefore,snapshots[0].sourceBefore,`${variant} source changed across ${generation.toUpperCase()} runs`);
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
  q3Groups=q3Mode==='cold'?CELLS.flatMap(cell=>variants.map(variant=>{
    const group=results.filter(row=>row.cell===cell&&row.variant===variant);
    const raw=group.map(row=>({rep:row.rep,wallMs:row.initialOpenThroughAllMs}));
    const decision=coldDecision(raw);
    if(q4)assert.ok(decision.supplementRequired||!raw.some(run=>run.rep===3),'Q4 rep3 requires spread over 5%.');
    return {cell,variant,runs:raw,wallMs:stats(raw.map(run=>run.wallMs)),...decision};
  })):undefined;
  needsSupplement=q3Mode==='cold'?q3Groups.filter(group=>group.nextRep===3):[];
  pageSeeds=q3Mode==='cold'?await Promise.all(CELLS.flatMap(cell=>['baseline','candidate'].map(async variant=>{
    if(q4){
      const group=q3Groups.find(group=>group.cell===cell&&group.variant===variant);
      return {cell,variant,preparedResult:group.complete?(await finalQ4Cold(base,cell,variant)).file:null};
    }
    const completed=results.filter(row=>row.cell===cell&&row.variant===variant).sort((a,b)=>b.rep-a.rep);
    return {cell,variant,preparedResult:completed.length?path.join(completed[0].directory,'result.json'):null};
  }))):undefined;
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
const complete=modern?(q3Mode==='cold'?q3Groups.every(group=>group.complete):results.length===4):true;
const output={schemaVersion:q4?4:q3?3:1,generatedAt:new Date().toISOString(),baselineBase,generation,mode:modern?q3Mode:undefined,
  complete,missing,needsSupplement,pageSeeds,coldGroups:q3Mode==='cold'?q3Groups:undefined,
  quotaWorkSemantics:modern?{source:'UsageStore.lastQuotaWork',changes:'Queue operations: insert=1, update=2; not SQL scanned rows.',
    endpointsAndCycles:'Actual counts reported by the projection; rebuilt/reused and fallback are preserved verbatim.',
    absent:q4?'Missing work remains absent.':'Frozen Q2 has no work API; missing work remains absent.'}:undefined,
  parity:{kind:modern?`${generation}-${q3Mode}`:continuation?'continuation':'baseline-candidate',groups:modern?results.length:continuation?2:4,fieldsPerGroup:fields.length,passed:complete},results};
await writeFile(path.join(base,modern?`analysis-${q3Mode}.json`:'analysis.json'),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({complete,needsSupplement,pageSeeds,parity:output.parity,results:results.map(({cell,variant,rep,appends,allCoreMs,storageBytes,ordinaryServiceRssMax,wholeServiceRssMax,maximumQuoteBytes})=>({cell,variant,rep,appends,allCoreMs,storageBytes,ordinaryServiceRssMax,wholeServiceRssMax,maximumQuoteBytes}))},null,2));

async function analyzeQ5() {
  const mode=modeAt<0?'page':process.argv[modeAt+1];assert.ok(['cold','page','setup'].includes(mode));
  const matrix=await read(path.join(base,'matrix.json'));assertQ5Matrix(matrix,path.basename(base));
  readCapturedPricing(matrix.pricing.file,matrix.pricing.catalogSha256);
  const entries=q5Trials(matrix.label).filter(row=>row.mode===(mode==='cold'?'cold-only':mode==='setup'?'setup-only':'page'));
  const results=[],missing=[],issues=[],runs=[];
  for(const entry of entries) {
    const file=entry.resultFile;let run;
    try{run=await read(file);}catch(error){if(error.code!=='ENOENT')throw error;missing.push(file);continue;}
    const problems=[];
    try {
      assert.equal(run.generation,'q5');assert.equal(run.cell,entry.cell);assert.equal(run.variant,entry.variant);assert.equal(run.mode,entry.mode);
      assert.deepEqual(run.sourceBefore,run.sourceAfter);
      if(run.status!=='ineligible'&&run.status!=='pending') {
        assert.equal(run.passed,true,run.failure?.message);assert.equal(run.pricing.catalogSha256,matrix.pricing.catalogSha256);
        assert.ok(run.pricingVerifications?.length>0);
        for(const row of run.pricingVerifications)assert.equal(row.catalogSha256,matrix.pricing.catalogSha256);
        assertQ5TraceCoverage(run.privateTrace??[]);
        assert.equal(run.resourceSpans?.length,mode==='page'?2:1);
        assert.ok(Number.isFinite(run.privateStateAfter?.totalBytes));
        if(mode==='page') {
          assert.equal(run.fixturePreparation?.factsIdentical,true);
          assert.equal(run.appends.length,20);
          for(const kind of ['codex','dsh'])assert.equal(run.appends.filter(row=>row.kind===kind).length,10);
          assert.ok(run.pageDelivery?.initial?.rows?.length>0&&run.pageDelivery?.reopen?.rows?.length>0);
          for(const phase of ['initial','reopen'])assert.equal(run.pageDelivery[phase].dropped,0);
          for(const append of run.appends) {
            assert.equal(append.status,'passed');assert.ok(Number.isFinite(append.appendLandedAtMs));
            assert.ok(append.evidence?.proofKind,'Append proof kind missing.');
            if(entry.cell.endsWith('native'))assert.equal(append.evidence.nativeFastPath,true,'SHA fallback is not native fast path.');
            else assert.equal(append.evidence.proofKind,'sha256-prefix-v2');
          }
        }else {assert.equal(run.appends.length,0);assert.ok(run.seedPublished);}
        runs.push(run);
      }
    }catch(error){problems.push(error.message);issues.push({file,message:error.message});}
    const resourceSpans=[];
    for(const span of run.resourceSpans??[]) {
      try{resourceSpans.push({...span,summary:await read(path.join(span.directory,'resources.json'))});}
      catch(error){if(error.code!=='ENOENT')throw error;const message=`Resource summary missing: ${span.directory}`;
        problems.push(message);issues.push({file,message});}
    }
    const windows=(run.appends??[]).map(append=>({...append,
      eligibleForComparison:run.passed===true&&!['ineligible','pending'].includes(run.status)&&append.status==='passed'
        &&(!entry.cell.endsWith('native')||append.evidence?.nativeFastPath===true),
      pageTimeline:(run.pageDelivery?.initial?.rows??[]).filter(row=>row.at>=append.startedAtMs&&row.at<=append.endedAtMs)}));
    results.push({cell:entry.cell,variant:entry.variant,mode:entry.mode,directory:entry.directory,
      status:run.status??(run.passed?'passed':'failed'),eligible:run.eligible??run.native?.eligible,
      failure:run.failure,problems,fixturePreparation:run.fixturePreparation,
      privateState:{before:run.privateStateBefore,after:run.privateStateAfter},resourceSpans,
      initialOpenThroughAllMs:run.first?run.first.endedAtMs-run.first.startedAtMs:null,
      native:run.native,pricingVerifications:run.pricingVerifications,pageDelivery:run.pageDelivery,
      privateTrace:run.privateTrace,windows,appends:Object.fromEntries(['codex','dsh'].map(kind=>[kind,
        stats(windows.filter(row=>row.kind===kind&&row.eligibleForComparison).map(row=>row.wallMs))]))});
  }
  for(const variant of ['baseline','candidate']) {
    const group=runs.filter(run=>run.variant===variant);
    for(const run of group)try{assert.deepEqual(run.sourceBefore,group[0].sourceBefore);}
    catch(error){issues.push({variant,message:error.message});}
  }
  if(mode==='page')for(const cell of [...new Set(runs.map(run=>run.cell))]) {
    const group=runs.filter(run=>run.cell===cell),first=group[0];
    for(const run of group)try {
      assert.equal(run.datasetSha256,first.datasetSha256);
      for(const select of [run=>run.first.all,publishedAll]) {
        const a=normalizeBody(select(run).body,run,true),b=normalizeBody(select(first).body,first,true);
        for(const key of BUSINESS_FIELDS)assert.deepEqual(a.summary[key],b.summary[key],`${cell} ${key}`);
        assert.deepEqual(a.metadata,b.metadata);assert.deepEqual(a.periodComparison,b.periodComparison);
      }
    }catch(error){issues.push({cell,message:error.message});}
  }
  const complete=missing.length===0&&issues.length===0&&results.length===entries.length&&results.every(row=>row.status==='passed');
  const output={schemaVersion:5,generation:'q5',mode,complete,missing,issues,
    comparisonScope:'baseline/candidate within the same canonical proof mode and volume; no cross-volume causal ratios',
    accounting:{canonicalInitializations:4,formalColdRegressions:2,setupNativeInitializations:2,pageCells:8,pageAppends:160,
      observedAppends:results.reduce((n,row)=>n+row.windows.length,0),setupAndRecertification:'separate from append windows'},
    parity:{kind:`q5-${mode}`,passed:complete},results};
  await writeFile(path.join(base,`analysis-${mode}.json`),JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify({complete,missing,issues,statuses:results.map(({cell,variant,status})=>({cell,variant,status}))},null,2));
}
