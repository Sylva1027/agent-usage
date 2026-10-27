import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {UsageStore} from '../../src/usage-store.js';
const frozen=JSON.parse(fs.readFileSync('.codex-usage/refresh-latency-20261026/freeze.json','utf8'));
const db=path.join(path.dirname(frozen.database),`implementation-retained-${process.pid}.sqlite`);
fs.copyFileSync(frozen.database,db,fs.constants.COPYFILE_EXCL);
const store=new UsageStore({...frozen.options,databaseFile:db,automaticDiscoveryEnabled:false,pricingRefreshSchedulerEnabled:false});
const hash=rows=>createHash('sha256').update(JSON.stringify(rows)).digest('hex');
try {
 await store.open();
 const live=new Set(frozen.sourceFiles.map(row=>path.resolve(row.filePath).toLowerCase()));
 const missing=store.database.prepare('SELECT path FROM source_files ORDER BY path').all().map(row=>String(row.path)).filter(file=>!live.has(path.resolve(file).toLowerCase()));
 assert.equal(missing.length,6);
 const marks=missing.map(()=>'?').join(',');
 const facts=()=>Object.fromEntries([
  ['events',`SELECT * FROM events WHERE source_path IN (${marks}) ORDER BY id`],
  ['samples',`SELECT * FROM perf_samples WHERE source_path IN (${marks}) ORDER BY sample_key`],
  ['owners',`SELECT * FROM perf_rollout_threads WHERE source_path IN (${marks}) ORDER BY source_path,home_id,thread_id`],
  ['dependencies',`SELECT * FROM perf_sample_sources WHERE source_path IN (${marks}) ORDER BY sample_key,source_path,role`]
 ].map(([name,query])=>{const rows=store.database.prepare(query).all(...missing);return [name,{count:rows.length,hash:hash(rows)}];}));
 const before=facts();assert.equal(before.events.count,14416);assert.equal(before.samples.count,359);
 await store.sync();await store.sync();await store.sync();
 const after=facts();assert.deepEqual(after,before,'All retained raw rows must survive successful and stable rounds');
 const result={checkedAt:new Date().toISOString(),missingSources:missing.length,before,after,equivalent:true};
 fs.writeFileSync('output/codex-incremental-visibility-20261027/retained-results.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
} finally {store.close();for(const suffix of ['','-wal','-shm'])fs.rmSync(db+suffix,{force:true});}
