import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const output=path.resolve('output/codex-incremental-visibility-20261027');
const evidence=path.resolve('docs/validation/2026-10-27-codex-incremental-visibility/evidence');
const read=(root,file)=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const browser=read(output,'browser-final-results.json');
assert.equal(browser.failure,undefined);
assert.deepEqual(browser.errors,[]);
assert.equal(browser.probeMode,'real 60 second cycles');
assert.equal(browser.cycles.length,40);
assert.equal(browser.walAfterClose,0);
const stats=values=>{
  const rows=[...values].sort((a,b)=>a-b);
  assert.ok(rows.length&&rows.every(Number.isFinite));
  return {n:rows.length,p50:rows[Math.ceil(rows.length*.5)-1],p95:rows[Math.ceil(rows.length*.95)-1],max:rows.at(-1)};
};
for(const [index,row]of browser.cycles.entries()) {
  assert.equal(row.index,index);
  assert.equal(row.delta,row.kind==='codex-append'?2000214:0);
  assert.ok(row.checkStartedAt>=row.writtenAt&&row.requestAt>=row.checkStartedAt);
  assert.ok(row.frames.some(frame=>frame.frameAt===row.tokenFrameAt));
  const frame=row.frames.find(frame=>frame.frameAt===row.timingFrameAt&&frame.frame.n===row.expectedStats.n);
  assert.ok(frame,'exact model n must exist on the measured timing frame');
  assert.equal(frame.frame.sampled,row.beforePerf.codexTimingCoverage.sampledOutputTokens+1000007);
  assert.equal(frame.frame.averageTps,row.expectedStats.averageTps);
  assert.notEqual(frame.frame.timingText,row.beforeTimingText);
  const model=row.afterPerf.models.find(item=>item.sourceKind==='codex'&&item.model==='gpt-6-sol'&&item.reasoningEffort==='high');
  for(const [key,value]of Object.entries(row.expectedStats))assert.equal(model[key],value);
  assert.ok(Number.isFinite(row.actualIntervalMs)&&row.actualIntervalMs>0);
  assert.equal(row.freshnessBudgetMs,row.actualIntervalMs+5000);
}
const grouped=Object.fromEntries(['codex-append','ledger'].map(kind=>{
  const rows=browser.cycles.filter(row=>row.kind===kind);
  assert.equal(rows.length,20);
  const token=kind==='codex-append'?stats(rows.map(row=>row.fromCheckTokenMs)):null;
  const tps=stats(rows.map(row=>row.fromCheckTpsMs));
  return [kind,{token,tps,fromWrite:stats(rows.map(row=>row.fromWriteMs)),
    g1Tps:{pass:tps.p95<=3000&&tps.max<=8000,p95OverMs:Math.max(0,tps.p95-3000),maxOverMs:Math.max(0,tps.max-8000)},
    g1Token:token?{pass:token.p95<=3000&&token.max<=8000}:null,
    freshnessFailures:rows.filter(row=>row.freshnessOverMs>0).map(row=>({index:row.index,overMs:row.freshnessOverMs})),
    configured65sFailures:rows.filter(row=>row.fromWriteMs>65000).map(row=>row.index)}];
}));
const comparisons=read(output,'comparison.json');
assert.equal(comparisons.equivalent,true);
const retained=read(output,'retained-results.json');
assert.equal(retained.equivalent,true);
const restoration=read(evidence,'browser-final-input-check.txt');
assert.equal(restoration.files,1630);
assert.equal(restoration.differences,0);
const controls=read(output,'browser-controls-results.json');
assert.equal(controls.failure,undefined);
assert.deepEqual(controls.errors,[]);
assert.deepEqual(controls.cycles.map(row=>row.kind),['claude','codex-new','codex-append','ledger']);
assert.equal(controls.walAfterClose,0);
const controlsRestoration=read(evidence,'browser-controls-input-check.txt');
assert.equal(controlsRestoration.differences,0);
const inputs=read(evidence,'inputs-final.json');
assert.equal(inputs.allEquivalent,true);
assert.equal(inputs.verifiedInputs,1633);
assert.equal(inputs.verifiedModules,57);
const summary={completedAt:browser.finishedAt,comparison:comparisons,changed:read(evidence,'changed-comparison.json'),
  browser:{groups:grouped,errors:browser.errors,actualInterval:stats(browser.cycles.map(row=>row.actualIntervalMs)),
    nodePeakRSSMiB:browser.maxRSSKiB/1024,maximumSampledWALBytes:Math.max(...browser.memory.map(row=>row.walBytes)),
    minimumSystemAvailableGiB:Math.min(...browser.memory.map(row=>row.freeGiB)),twoTabs:browser.twoTabs,walAfterClose:browser.walAfterClose},
  retained:{missingSources:retained.missingSources,before:retained.before,after:retained.after},
  controls:{cycles:controls.cycles.map(row=>({kind:row.kind,delta:row.delta,fromCheckMs:row.fromCheckMs})),errors:controls.errors,twoTabs:controls.twoTabs,walAfterClose:controls.walAfterClose},
  jobMemoryLimitMiB:7168,totalBudgetGiB:8,measuredJobPeak:null,restoration,controlsRestoration,inputs,
  limits:['1x frozen warm inputs; no real cold-disk or long-running production benchmark','Node RSS is not the whole Job peak','Backend one-turn append and browser two-turn append are different workloads']};
fs.writeFileSync(path.join(evidence,'summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
