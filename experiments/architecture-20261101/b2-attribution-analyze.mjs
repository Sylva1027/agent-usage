import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function unionMs(intervals, start=-Infinity, end=Infinity) {
  const parts=intervals.map(([a,b])=>[Math.max(a,start),Math.min(b,end)]).filter(([a,b])=>b>a).sort((a,b)=>a[0]-b[0]);
  let total=0,tail=-Infinity;
  for(const [a,b] of parts){total+=Math.max(0,b-Math.max(a,tail));tail=Math.max(tail,b);}
  return total;
}
function json(file){return JSON.parse(readFileSync(file,'utf8'));}
function ndjson(file){return readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}
function scopeResources(samples,start,end) {
  const rows=samples.filter(x=>x.atUnixMs>=start&&x.atUnixMs<=end);
  if(!rows.length)return null;
  const peak=rows.reduce((a,b)=>a.service.workingSetBytes>b.service.workingSetBytes?a:b);
  const sum=field=>rows.reduce((n,x)=>n+(x.service[field]??0),0);
  return {samples:rows.length,first:rows[0].atUnixMs,last:rows.at(-1).atUnixMs,
    rssPeak:peak.service.workingSetBytes,privatePeak:Math.max(...rows.map(x=>x.service.privateBytes)),
    cpuSecondsObserved:sum('cpuSecondsIncrement'),logicalReadObserved:sum('logicalReadBytesIncrement'),logicalWriteObserved:sum('logicalWriteBytesIncrement'),
    peakProcesses:peak.processes.filter(x=>x.role==='service').map(x=>({pid:x.pid,name:x.name,rss:x.workingSetBytes,privateBytes:x.privateBytes})),
    statePeak:Math.max(...rows.map(x=>x.state.totalBytes??0)),tempPeak:Math.max(...rows.map(x=>x.temp.totalBytes??0)),
    tempStatuses:[...new Set(rows.map(x=>x.temp.status))]};
}
export function analyze(trial) {
  const result=json(path.join(trial,'result.json'));
  const traceDir=path.join(trial,'trace');
  const records=existsSync(traceDir)?readdirSync(traceDir).filter(x=>/^q0-trace-\d+\.ndjson$/.test(x)).flatMap(x=>ndjson(path.join(traceDir,x))):[];
  const spans=records.filter(x=>x.type==='span');
  const childMap=new Map();
  for(const s of spans)if(s.parentId){const list=childMap.get(s.parentId)||[];list.push(s);childMap.set(s.parentId,list);}
  const samples=existsSync(path.join(trial,'resources.ndjson'))?ndjson(path.join(trial,'resources.ndjson')):[];
  const scopes=result.scopes.map(scope=>{
    const start=scope.startedAtMs,end=scope.endedAtMs,groups={};
    for(const s of spans) {
      const overlap=Math.max(0,Math.min(end,s.start+s.duration)-Math.max(start,s.start));
      if(!overlap)continue;
      const children=(childMap.get(s.id)||[]).map(c=>[c.start,c.start+c.duration]);
      const exclusive=Math.max(0,overlap-unionMs(children,Math.max(start,s.start),Math.min(end,s.start+s.duration)));
      const g=groups[s.label]??={calls:0,inclusiveMs:0,selfWallMs:0,cpuMsInclusiveCompleteCalls:0,partialCalls:0,counters:{},io:{},quoteRowsMax:0,quoteBufferBytesMax:0};
      g.calls++;g.inclusiveMs+=overlap;g.selfWallMs+=exclusive;
      if(s.start>=start&&s.start+s.duration<=end) {
        g.cpuMsInclusiveCompleteCalls+=s.cpuMs||0;
        for(const [name,c] of Object.entries(s.counters||{})){const d=g.counters[name]??={calls:0,ms:0};d.calls+=c.calls;d.ms+=c.ms;}
        for(const [name,n] of Object.entries(s.io||{}))g.io[name]=(g.io[name]||0)+n;
      } else g.partialCalls++;
      g.quoteRowsMax=Math.max(g.quoteRowsMax,s.quoteRows||0,s.memoryAfter?.quoteRows||0);
      g.quoteBufferBytesMax=Math.max(g.quoteBufferBytesMax,s.quoteArrayBufferBytes||0,s.memoryAfter?.quoteArrayBufferBytes||0);
    }
    const apiRequests=spans.filter(s=>s.label==='server.handleRequest'&&s.start>=start&&s.start<end).map(s=>({url:s.url,start:s.start,ms:s.duration}));
    const roots=spans.filter(s=>s.pid===result.server.pid&&s.start<end&&s.start+s.duration>start&&(s.label==='server.handleRequest'||s.label==='server.requestUsageWake'));
    const occupied=unionMs(roots.map(s=>[s.start,s.start+s.duration]),start,end);
    const browser=(result.browserTimes||[]).filter(x=>(x.at||x.start)>=start&&(x.at||x.start)<=end);
    const fetches=browser.filter(x=>x.type==='fetch'&&x.url.includes('/api/usage?'));
    let browserChain=null;
    if(scope.kind) {
      const request=fetches.find(x=>x.total===scope.expectedTotal&&Number.isFinite(x.json));
      const sse=request&&browser.filter(x=>x.type==='sse'&&x.at<=request.start).at(-1);
      const dom=request&&browser.find(x=>x.type==='dom-total'&&Number(String(x.title).replace(/[^0-9]/g,''))===scope.expectedTotal&&Number.isFinite(x.paint));
      if(request&&sse&&dom)browserChain={landingToSse:sse.at-start,sseToFetch:request.start-sse.at,
        fetchToJson:request.json-request.start,jsonToTitlePaint:dom.paint-request.json,
        titlePaintToFinalObserver:end-dom.paint,totalObservedMs:end-start};
    }
    const syncs=spans.filter(s=>s.label==='store.syncRound'&&s.start>=start&&s.start<end).map(s=>({pid:s.pid,ms:s.duration,sourceWork:s.sourceWork}));
    return {...scope,groups,apiRequests,syncs,browser,fetches,browserChain,
      gatewayRootUnionMs:occupied,outsideGatewayRootsMs:end-start-occupied,
      resources:scopeResources(samples,start,end)};
  });
  const processMemory={};
  for(const r of records){
    const m=r.memoryAfter||r.memory;if(!m)continue;
    const x=processMemory[r.pid]??={rssMax:0,heapUsedMax:0,externalMax:0,arrayBuffersMax:0,quoteBuffersMax:0};
    for(const [field,key] of [['rss','rssMax'],['heapUsed','heapUsedMax'],['external','externalMax'],['arrayBuffers','arrayBuffersMax'],['quoteArrayBufferBytes','quoteBuffersMax']])x[key]=Math.max(x[key],m[field]||0);
  }
  const resourceSummary=existsSync(path.join(trial,'resources.json'))?json(path.join(trial,'resources.json')):null;
  const nodeCpuAtExit=records.filter(x=>x.type==='exit'&&x.cpuUsage).map(x=>({pid:x.pid,role:x.pid===result.server.pid?'gateway':'executor',cpuSeconds:(x.cpuUsage.user+x.cpuUsage.system)/1e6,lifetimeMaxRssKiB:x.resourceUsage?.maxRSS}));
  const temporarySqlite=spans.filter(x=>x.temporarySqlite).map(x=>({pid:x.pid,label:x.label,at:x.start,...x.temporarySqlite}));
  return {trial,cell:result.cell,mode:result.mode,passed:result.passed,initial:result.initial,final:result.final,
    failure:result.failure,cleanupError:result.cleanupError,samplingError:result.samplingError,
    traceRecords:records.length,spanCount:spans.length,processMemory,nodeCpuAtExit,temporarySqlite,resourceSummary,scopes,
    semantics:'Inclusive spans overlap; selfWall subtracts direct-child interval union within a process and includes waits. Do not sum across processes. OS I/O deltas are sampled logical transfers with first/last/short-lived gaps. FS counters describe their specific API delivery, not physical I/O.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const trial=path.resolve(process.argv[2]);
  const result=analyze(trial);
  const file=path.join(trial,'analysis.json');writeFileSync(file,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({file,cell:result.cell,mode:result.mode,passed:result.passed,spans:result.spanCount,
    rssPeak:result.resourceSummary?.service?.peakSampledWorkingSetBytes,
    appends:result.scopes.filter(x=>x.kind).map(x=>({kind:x.kind,wallMs:x.wallMs,syncs:x.syncs,groups:Object.fromEntries(Object.entries(x.groups).filter(([k])=>/store\.(timelineRange|prepareQuotaProjection|periodComparison|summarizeInReadTransactionCore|metadata|groupedRange)|source\.proof\.(verifyUsage|captureUsage)|usage-summary-cache\.(readSourceState|publish)/.test(k)).map(([k,v])=>[k,{calls:v.calls,ms:v.inclusiveMs,selfMs:v.selfWallMs,counters:v.counters,io:v.io}]))}))}));
}
