import fs from 'node:fs';
import path from 'node:path';
const folder=path.resolve('output/refresh-sync-latency-reeval-20261026');
export const stats=values=>{const rows=values.filter(Number.isFinite).sort((a,b)=>a-b);return {n:rows.length,p50:rows[Math.ceil(rows.length*.5)-1]??null,p95:rows[Math.ceil(rows.length*.95)-1]??null,max:rows.at(-1)??null};};
const read=name=>JSON.parse(fs.readFileSync(path.join(folder,name),'utf8'));
const stages=name=>fs.readFileSync(path.join(folder,name),'utf8').trim().split(/\r?\n/).map(JSON.parse);
const base=read('valid-baseline-results.json'),http=read('http-results.json');
const traces=stages('valid-baseline-stages.jsonl');
const sync=traces.filter(row=>row.root==='sync').slice(3);
const result={quantile:'nearest-rank: sorted[ceil(p*n)-1]',baseline:{},http:{},syncStages:{},browser:null};
for(const key of ['unchanged-sync','dashboard-today','dashboard-month','dashboard-all']){
  const rows=base.samples.filter(row=>row.label.startsWith(key));result.baseline[key]={all:stats(rows.map(row=>row.ms)),firstMs:rows[0]?.ms,...(key.startsWith('dashboard')?{warm:stats(rows.slice(1).map(row=>row.ms)),distinctSummaryHashes:new Set(rows.map(row=>row.hash)).size}:{distinctFingerprints:new Set(rows.map(row=>row.fingerprint)).size,warnings:rows.flatMap(row=>row.warnings).length})};
}
for(const key of ['copyFingerprints','copyWarnings','prefix','prefixRead','otherReadSync','fold','importMagpieRequestTimings','syncRound'])result.syncStages[key]={ms:stats(sync.map(row=>row.metrics[key]?.ms)),calls:stats(sync.map(row=>row.metrics[key]?.calls)),itemsOrBytes:stats(sync.map(row=>row.metrics[key]?.extra))};
for(const key of ['http-first-default','http-default','http-skip-today','http-skip-month','http-skip-all','status-idle','overlap-default','overlap-status','overlap-skip'])result.http[key]=stats(http.http.filter(row=>row.label===key||row.label.startsWith(key+'-')).map(row=>row.ms));
const sessions=['browser-session1-results.json','browser-session2-results.json'].map(read);
const live={startedAt:sessions[0].startedAt,finishedAt:sessions.at(-1).finishedAt,browserVersion:sessions.at(-1).browserVersion,firstBrowserMs:sessions.map(row=>row.firstBrowserMs),browser:sessions.flatMap(row=>row.browser),memory:sessions.flatMap(row=>row.memory),errors:sessions.flatMap(row=>row.errors),twoTabs:sessions.at(-1).twoTabs,maxRSSKiB:Math.max(...sessions.map(row=>row.maxRSSKiB??Math.max(...row.memory.map(sample=>sample.maxRSSKiB))))};
const cycles=sessions.flatMap((session,index)=>(session.cycles??[]).map(row=>({...row,session:index+1})));
const groups={};
for(const kind of new Set(cycles.map(row=>row.kind))){const rows=cycles.filter(row=>row.kind===kind);groups[kind]={n:rows.length,fromCheckMs:stats(rows.filter(row=>row.expectedDelta>0).map(row=>row.fromCheckMs)),fromWriteMs:stats(rows.filter(row=>row.expectedDelta>0).map(row=>row.fromWriteMs)),statusChanged:rows.map(row=>row.statusChanged),deltas:rows.map(row=>row.delta)};}
const active=cycles.filter(row=>row.expectedDelta>0);
const gaps=[];
for(const row of active){const target=row.frames.find(frame=>Number(frame.total.replaceAll(',',''))===Number(row.frames.at(-1).total.replaceAll(',',''))&&frame.domAt>=row.requestAt);const off=row.frames.find(frame=>!frame.busy&&frame.domAt>=row.requestAt+1000);if(target&&off)gaps.push({index:row.index,offToTargetDomMs:target.domAt-off.domAt,offToTargetFrameMs:target.frameAt-off.frameAt});}
const intervals=sessions.flatMap(session=>session.cycles.slice(1).map((row,index)=>row.requestAt-session.cycles[index].requestAt));
result.browser={startedAt:live.startedAt,finishedAt:live.finishedAt,version:live.browserVersion,firstMs:live.firstBrowserMs,n:cycles.length,sessions:sessions.map(row=>({startedAt:row.startedAt,finishedAt:row.finishedAt,n:row.cycles.length})),groups,active:{fromCheckMs:stats(active.map(row=>row.fromCheckMs)),fromWriteMs:stats(active.map(row=>row.fromWriteMs))},requestIntervalsMs:stats(intervals),spinnerToTarget:gaps,filters:live.browser.filter(row=>row.type==='filter-complete'),twoTabs:live.twoTabs,errors:live.errors,memory:{nodePeakRSSKiB:live.maxRSSKiB,minSystemFreeGiB:Math.min(...live.memory.map(row=>row.freeGiB)),rssSamples:live.memory.map(row=>row.rss)}};
fs.writeFileSync(path.join(folder,'summary.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
