import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {UsageStore} from '../../src/usage-store.js';
import {loadPricingFile} from '../../src/pricing-store.js';
import {getPricingCatalog} from '../../src/pricing.js';
const folder=path.resolve('output/refresh-sync-latency-reeval-20261026');
const privateRoot=path.resolve('.codex-usage/refresh-latency-20261026');
const frozen=JSON.parse(fs.readFileSync(path.join(privateRoot,'freeze.json'),'utf8'));
const now=new Date(JSON.parse(fs.readFileSync(path.join(folder,'valid-baseline-results.json'),'utf8')).startedAt);
// These three fields record publication wall time; retain all revisions, costs, coverage and warnings.
const normalize=value=>{const copy=structuredClone(value);delete copy.generatedAt;delete copy.perf?.indexedAt;delete copy.perf?.meta?.indexedAt;return copy;};
const result={whitelist:['summary.generatedAt','summary.perf.indexedAt','summary.perf.meta.indexedAt'],comparisons:[],timing:{},queryStages:{}};
const outputs=[];
for(const mode of ['control-on','control-off']){
 const run=JSON.parse(fs.readFileSync(path.join(folder,mode+'-results.json'),'utf8'));
 assert.ok(run.finishedAt);assert.ok(run.samples.filter(row=>row.label.startsWith('unchanged-sync')).every(row=>row.updatedFileCount===0&&row.warnings.length===0));
 result.timing[mode]=run.samples.filter(row=>row.label.startsWith('unchanged-sync')).map(row=>row.ms);
 const candidates=fs.readdirSync(privateRoot).filter(name=>new RegExp('^'+mode+'-\\d+\\.sqlite$').test(name));assert.equal(candidates.length,1);
 const options={...frozen.options,databaseFile:path.join(privateRoot,candidates[0])};await loadPricingFile(options);
 const store=new UsageStore(options);const values={};
 try{await store.open();for(const preset of ['today','month','all']){const value=await store.dashboardHistory({preset,bucket:preset==='today'?'hour':'day',calendarZone:'local',now,pricingModels:getPricingCatalog().models},{includeDetails:false});values[preset]=normalize(value.summary);}}finally{store.close();}
 outputs.push({fingerprint:run.samples.find(row=>row.label==='unchanged-sync-0').fingerprint,values});
}
assert.equal(outputs[0].fingerprint,outputs[1].fingerprint);
for(const preset of ['today','month','all']){const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');const left=digest(outputs[0].values[preset]),right=digest(outputs[1].values[preset]);assert.equal(left,right,'Control summary mismatch: '+preset);result.comparisons.push({preset,equal:true,sha256:left});}
const traces=fs.readFileSync(path.join(folder,'control-on-stages.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse).filter(row=>row.root==='dashboardHistory');
for(const [index,preset]of ['today','month','all'].entries()){const group=traces.slice(index*3,index*3+3);result.queryStages[preset]=group.map(row=>Object.fromEntries(Object.entries(row.metrics).filter(([name])=>['groupedRange','costEstimateRange','timelineRange','repositoriesRange','perfSummaryForRange','buildPerfSummaryForRange'].includes(name))));}
fs.writeFileSync(path.join(folder,'control-parity.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
