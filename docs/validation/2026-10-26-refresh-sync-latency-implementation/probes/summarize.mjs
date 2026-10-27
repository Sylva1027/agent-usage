import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const output='output/refresh-sync-latency-implementation';
const read=name=>JSON.parse(fs.readFileSync(path.join(output,name),'utf8'));
const stats=values=>{const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);return sorted.length?{n:sorted.length,p50:sorted[Math.ceil(sorted.length*.5)-1],p95:sorted[Math.ceil(sorted.length*.95)-1],max:sorted.at(-1)}:{n:0};};
const result={quantile:'nearest-rank: sorted[ceil(p*n)-1]',ab:read('comparison.json')};
const changed=read('changed-results.json');
assert.equal(changed.checkedNativeIncrements,20);assert.equal(changed.checkedClaudeIncrements,20);assert.equal(changed.checkedLedgerTimings,20);
result.changed=Object.fromEntries(['native-append','ledger-only','claude-append'].map(kind=>[kind,stats(changed.samples.filter(row=>row.label.startsWith(kind+'-sync-')).map(row=>row.ms))]));
const browser=read('browser-final-results.json');
assert.equal(browser.failure,undefined);assert.equal(browser.errors.length,0);assert.equal(browser.cycles.length,21);assert.equal(browser.probeMode,'real 60 second cycles');
const ordinary=browser.cycles.filter(row=>row.expectedDelta>0),ledgers=browser.cycles.filter(row=>row.kind==='ledger');
assert.equal(ordinary.length,15);assert.equal(ledgers.length,5);
for(const row of ordinary){assert.equal(row.delta,1000107);assert.ok(Number.isFinite(row.fromWriteMs));assert.ok(Number.isFinite(row.fromCheckMs));}
for(const row of ledgers){assert.equal(row.delta,0);assert.equal(row.statusChanged,true);assert.ok(Number.isFinite(row.fromCheckMs));}
const interval=stats(browser.ticks.slice(1).map((value,index)=>value-browser.ticks[index]));
result.browser={cyclePreset:browser.cyclePreset,cycles:browser.cycles.length,realTicks:browser.ticks.length,interval,groups:Object.fromEntries(['unchanged','claude','codex-new','codex-append','ledger'].map(kind=>{const rows=browser.cycles.filter(row=>row.kind===kind);return [kind,{n:rows.length,checkToFrame:stats(rows.map(row=>row.fromCheckMs)),writeToFrame:stats(rows.map(row=>row.fromWriteMs)),writeToCheck:stats(rows.map(row=>row.requestAt-row.writtenAt))}];})),firstBrowserMs:browser.firstBrowserMs,twoTabs:browser.twoTabs,http:browser.http,walBeforeClose:browser.walBeforeClose,walAfterClose:browser.walAfterClose,maxNodeRSSMiB:browser.maxRSSKiB/1024,minimumAvailableGiB:Math.min(...browser.memory.map(row=>row.freeGiB)),errorCount:browser.errors.length};
result.browser.warning='Browser subgroups have fewer than 20 observations; their p95 is descriptive, not a per-scenario acceptance claim.';
result.browser.g1={candidateP95Ms:3000,candidateMaxMs:8000,observedOrdinaryMaxMs:Math.max(...ordinary.map(row=>row.fromCheckMs)),allOrdinaryWithinMax:ordinary.every(row=>row.fromCheckMs<=8000)};
result.browser.g2={candidateAdditionalMs:5000,maxObservedIntervalMs:interval.max,maxWriteToFrameMs:Math.max(...browser.cycles.filter(row=>row.kind!=='unchanged').map(row=>row.fromWriteMs))};
result.browser.g2.violations=browser.cycles.filter(row=>row.kind!=='unchanged').flatMap(row=>{const index=browser.ticks.indexOf(row.checkStartedAt);assert.ok(index>0);const actualInterval=browser.ticks[index]-browser.ticks[index-1];return row.fromWriteMs>actualInterval+5000?[{index:row.index,kind:row.kind,writeToFrameMs:row.fromWriteMs,actualIntervalMs:actualInterval,overBudgetMs:row.fromWriteMs-actualInterval-5000}]:[];});
result.retained=read('retained-results.json');assert.equal(result.retained.equivalent,true);
result.quota={};
for(const mode of ['before','after']){
  const quota=read(`quota-${mode}-results.json`);assert.equal(quota.failure,undefined);assert.equal(quota.finalPreset,'today');assert.notEqual(quota.finalOutputText,quota.beforeOutputText);
  const beforeText=quota.beforeOutputText;
  const target=quota.frames.find(row=>row.at>=quota.triggerAt&&(row.frame?.outputText||row.outputText)!==beforeText);
  const off=quota.frames.find(row=>row.at>=quota.triggerAt&&!row.busy);
  assert.ok(target);assert.ok(off);
  if(mode==='before')assert.ok(quota.earlyBusyOffFrames>0);else assert.equal(quota.earlyBusyOffFrames,0);
  result.quota[mode]={n:1,fromTriggerToFrameMs:target.frameAt-quota.triggerAt,earlyBusyOffToTargetDomMs:Math.max(0,target.at-off.at),earlyBusyOffToTargetFrameMs:Math.max(0,target.frameAt-off.frameAt),beforeOutputText:beforeText,finalOutputText:quota.finalOutputText};
}
fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({changed:result.changed,browser:{...result.browser,http:undefined},quota:result.quota},null,2));
