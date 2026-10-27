import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const folder=path.resolve('output/refresh-sync-latency-reeval-20261026');
const frozen=JSON.parse(fs.readFileSync(path.resolve('.codex-usage/refresh-latency-20261026/freeze.json'),'utf8'));
const db=new DatabaseSync(frozen.database,{readOnly:true});
const current=new Set(frozen.sourceFiles.map(row=>row.filePath));
const codex=db.prepare("SELECT path, home_id, size FROM source_files WHERE kind IN ('main','codex','jetbrains','extra')").all();
const missing=codex.filter(row=>!current.has(row.path));
const inspection={codexSourceRows:codex.length,discoveredCodexFiles:frozen.sourceFiles.filter(row=>row.kind==='main').length,retainedMissingCodexRows:missing.length,retainedMissingBytes:missing.reduce((n,row)=>n+row.size,0),retainedMissingEvents:0,retainedMissingPerfSamples:0,archiveSegments:Number(db.prepare('SELECT count(*) AS n FROM archive_segments').get().n)};
for(const row of missing){inspection.retainedMissingEvents+=Number(db.prepare('SELECT count(*) AS n FROM events WHERE source_path=?').get(row.path).n);inspection.retainedMissingPerfSamples+=Number(db.prepare('SELECT count(*) AS n FROM perf_samples WHERE source_path=?').get(row.path).n);}
db.close();
fs.writeFileSync(path.join(folder,'retained-path-inspection.json'),JSON.stringify(inspection,null,2));
const baseline=JSON.parse(fs.readFileSync(path.join(folder,'valid-baseline-results.json'),'utf8'));
const stat=values=>{const sorted=[...values].sort((a,b)=>a-b);return {n:values.length,p50:sorted[Math.ceil(.5*sorted.length)-1],p95:sorted[Math.ceil(.95*sorted.length)-1],max:sorted.at(-1)};};
const summary={inspection,stats:{}};
for(const group of ['unchanged-sync','dashboard-today','dashboard-month','dashboard-all']){
 const rows=baseline.samples.filter(row=>row.label.startsWith(group));summary.stats[group]={all:stat(rows.map(row=>row.ms)),first:rows[0]?.ms,...(group.startsWith('dashboard')?{warm:stat(rows.slice(1).map(row=>row.ms)),hashCount:new Set(rows.map(row=>row.hash)).size}:{fingerprints:new Set(rows.map(row=>row.fingerprint)).size,warnings:rows.flatMap(row=>row.warnings).length})};
}
fs.writeFileSync(path.join(folder,'baseline-summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
