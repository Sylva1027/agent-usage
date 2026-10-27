import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const output='output/refresh-sync-latency-implementation';
const privateRoot='.codex-usage/refresh-latency-20261026';
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const before=read(path.join(output,'before-results.json'));
const after=read(path.join(output,'after-results.json'));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const beforeSummaries=read(path.join(privateRoot,'implementation-before-summaries.json'));
const afterSummaries=read(path.join(privateRoot,'implementation-after-summaries.json'));
// The earlier PowerShell relocation parsed whole-second ISO strings as dates and omitted .000.
const restoreIso=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)?value.replace(/Z$/,'.000Z'):Array.isArray(value)?value.map(restoreIso):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,restoreIso(item)])):value;
for(const preset of ['today','month','all']) {
  const originalHash=before.samples.find(row=>row.label===`dashboard-${preset}-first`).hash;
  assert.equal(hash(restoreIso(beforeSummaries[preset])),originalHash,'Restored stored summary must reproduce the original in-process hash');
  assert.equal(hash(afterSummaries[preset]),originalHash,'Complete public summary must reproduce the before hash');
  assert.deepEqual(afterSummaries[preset],restoreIso(beforeSummaries[preset]));
}
for(const row of before.samples.filter(row=>row.hash))assert.equal(after.samples.find(other=>other.label===row.label)?.hash,row.hash,`summary ${row.label}`);
assert.equal(after.fingerprint,before.fingerprint,'same sources');
assert.deepEqual(after.tables,before.tables,'same logical table counts');
const stats=values=>{const sorted=[...values].sort((a,b)=>a-b);assert.ok(sorted.length);return {n:sorted.length,p50:sorted[Math.ceil(sorted.length*.5)-1],p95:sorted[Math.ceil(sorted.length*.95)-1],max:sorted.at(-1)};};
const labels={unchanged:'unchanged-sync-',today:'dashboard-today-warm-',month:'dashboard-month-warm-',all:'dashboard-all-warm-'};
const comparisons=Object.fromEntries(Object.entries(labels).map(([name,prefix])=>{
  const base=stats(before.samples.filter(row=>row.label.startsWith(prefix)).map(row=>row.ms));
  const next=stats(after.samples.filter(row=>row.label.startsWith(prefix)).map(row=>row.ms));
  assert.equal(base.n,20);assert.equal(next.n,20);
  return [name,{before:base,after:next,p95ReductionPercent:100*(1-next.p95/base.p95)}];
}));
const result={comparedAt:new Date().toISOString(),equivalent:true,ignoredFields:['summary.generatedAt','summary.perf.indexedAt','summary.perf.meta.indexedAt'],fingerprint:after.fingerprint,tables:after.tables,comparisons,maxNodeRSSMiB:{before:before.maxRSSKiB/1024,after:after.maxRSSKiB/1024},minimumAvailableGiB:{before:Math.min(...before.freeGiB),after:Math.min(...after.freeGiB)}};
fs.writeFileSync(path.join(output,'comparison.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
