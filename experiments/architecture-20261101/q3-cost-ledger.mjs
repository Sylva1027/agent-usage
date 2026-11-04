import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const base=path.resolve(process.argv[2]);
assert.match(base.replaceAll('\\','/'), /\/output\/architecture-20261104\/q3\/q3-[a-z0-9-]+$/);
const read=async file=>JSON.parse(await readFile(file,'utf8'));
const rows=async file=>(await readFile(file,'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse);
const stats=values=>{const v=values.sort((a,b)=>a-b),n=v.length;return n?{n,min:v[0],median:n%2?v[n>>1]:(v[n/2-1]+v[n/2])/2,max:v.at(-1)}:null;};

function coveredMs(intervals) {
  let total=0,end=-Infinity;
  for(const [start,stop] of intervals.sort((a,b)=>a[0]-b[0])) { total+=Math.max(0,stop-Math.max(start,end));end=Math.max(end,stop); }
  return total;
}
assert.equal(coveredMs([[0,3],[1,2],[2,5],[8,10]]),7);
const cold=await read(path.join(base,'analysis-cold.json'));
const page=await read(path.join(base,'analysis-page.json'));
assert.equal(cold.complete,true);assert.equal(page.complete,true);
const ledger=[];
for(const analysis of [cold,page]) for(const entry of analysis.results) {
  const run=await read(path.join(entry.directory,'result.json'));assert.equal(run.passed,true);
  const trace=(await Promise.all((await readdir(path.join(entry.directory,'components')))
    .filter(name=>name.startsWith('cold-stage-')&&name.endsWith('.jsonl'))
    .map(name=>rows(path.join(entry.directory,'components',name))))).flat().filter(row=>row.type==='span');
  const children=new Map();
  for(const span of trace) {assert.ok(Number.isFinite(span.duration)&&span.duration>=0);const key=span.parentSpanId;
    if(!children.has(key))children.set(key,[]);children.get(key).push(span);}
  const grouped={};
  for(const span of trace) {
    const item=grouped[span.label]??={calls:0,inclusiveMs:0,exclusiveMs:0,inputRows:0};
    item.calls+=1;item.inclusiveMs+=span.duration;item.inputRows+=span.inputRows??0;
    const intervals=(children.get(span.spanId)??[]).map(child=>[Math.max(span.start,child.start),Math.min(span.start+span.duration,child.start+child.duration)]).filter(([a,b])=>b>a);
    item.exclusiveMs+=Math.max(0,span.duration-coveredMs(intervals));
  }
  const spans=[];
  for(const span of run.resourceSpans)spans.push({name:span.name,...await read(path.join(span.directory,'resources.json'))});
  const db=new DatabaseSync(run.prepared.databaseFile,{readOnly:true});
  let storage;
  try {storage=db.prepare(`SELECT name,SUM(pgsize) bytes FROM dbstat GROUP BY name`).all();}
  finally{db.close();}
  const bytes=prefix=>storage.filter(row=>row.name.startsWith(prefix)).reduce((n,row)=>n+Number(row.bytes),0);
  ledger.push({mode:analysis.mode,cell:entry.cell,variant:entry.variant,rep:entry.rep,
    initialOpenThroughAllMs:entry.initialOpenThroughAllMs,stages:grouped,resources:spans.map(span=>({name:span.name,service:span.service,browser:span.browser,observer:span.observer,state:span.state,temp:span.temp})),
    storage:{totalPagesBytes:storage.reduce((n,row)=>n+Number(row.bytes),0),quotaBytes:bytes('usage_quota_projection_'),metadataBytes:bytes('usage_metadata_')+bytes('events_metadata_group_time_idx'),allBytes:bytes('usage_all_')},
    quota:entry.windows?.filter(row=>row.kind==='codex').map(row=>({wallMs:row.wallMs,quotaMs:row.quotaMs,quotaWork:row.quotaWork})),
  });
}
const med=(scale,variant)=>cold.coldGroups.find(row=>row.cell===scale&&row.variant===variant).wallMs.median;
const gates={};
for(const scale of ['1x-sha','10x-sha']) {
  const current=page.results.find(row=>row.cell===scale&&row.variant==='baseline');
  const candidate=page.results.find(row=>row.cell===scale&&row.variant==='candidate');
  const codex=candidate.windows.filter(row=>row.kind==='codex');
  assert.equal(codex.length,20);
  assert.ok(codex.every(row=>row.quotaMs.length>0&&row.quotaWork.length>0),'Quota preparation needs observed timings and work.');
  const quota=stats(codex.map(row=>row.quotaMs.reduce((n,ms)=>n+ms,0)));
  gates[scale]={coldFasterThanQ2:med(scale,'candidate')<med(scale,'baseline'),coldWithinPreQ2:med(scale,'candidate')<=med(scale,'preq2')*1.05,
    quotaMedianMs:quota?.median,quota300ms:quota?.median<=300,
    quotaIncremental:codex.every(row=>row.quotaWork.some(work=>work.changes>0&&!work.rebuilt&&!work.fallback)),
    codexMedianMs:candidate.appends.codex.median,codex7s:scale==='10x-sha'?candidate.appends.codex.median<=7000:null,
    dshRatio:candidate.appends.dsh.median/current.appends.dsh.median,
    ordinaryMemoryRatio:candidate.ordinaryServiceRssMax/current.ordinaryServiceRssMax,
    ordinaryMemoryWithin10Percent:candidate.ordinaryServiceRssMax<=current.ordinaryServiceRssMax*1.1,
    maximumServiceBytes:Math.max(...ledger.filter(row=>row.cell===scale&&row.variant==='candidate').flatMap(row=>row.resources.map(span=>span.service.peakSampledWorkingSetBytes))),
  };
  gates[scale].memoryWithin512MiB=gates[scale].maximumServiceBytes<=512*1024*1024;
}
gates.quota10xTo1x=gates['10x-sha'].quotaMedianMs/gates['1x-sha'].quotaMedianMs;
gates.quotaGrowthWithin30Percent=gates.quota10xTo1x<=1.3;
await writeFile(path.join(base,'cost-ledger.json'),JSON.stringify({generatedAt:new Date().toISOString(),definitions:{
  inclusive:'Contains child spans; do not add across labels.',exclusive:'Subtracts the union of directly instrumented child intervals; uninstrumented work stays with its parent.',
  storage:'Current closed DB pages; cold databases later used by page continuations contain those append mutations.',io:'Windows logical process I/O, not physical disk bytes.',
},gates,ledger},null,2)+'\n');
console.log(JSON.stringify({gates,runs:ledger.length},null,2));
