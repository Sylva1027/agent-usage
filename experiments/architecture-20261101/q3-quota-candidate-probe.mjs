import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { selectStoredQuotaWindows, quotaProjectionWork } from '../../src/usage-quota-store.js';

const root=path.resolve('output/architecture-20261104/q3');
const label=process.argv[2];assert.match(label||'',/^quota-candidate-[a-z0-9-]+$/);
assert.ok(process.execArgv.includes('--max-old-space-size=224'));
assert.ok(process.execArgv.includes('--max-semi-space-size=4'));
const prior=JSON.parse(readFileSync(path.join(root,'quota-probe-20261104-b/result.json'),'utf8'));
assert.equal(prior.passed,true);
const source=path.join(root,'quota-probe-20261104-b/quota-clone.sqlite');
assert.equal(existsSync(source+'-wal'),false,'Copy only the closed checkpointed private probe');
const before={size:statSync(source).size,mtimeMs:statSync(source).mtimeMs};
const directory=path.join(root,label);mkdirSync(directory);
const file=path.join(directory,'quota.sqlite');copyFileSync(source,file);
const oracle=await import(pathToFileURL(path.join(root,'baseline/src/usage-quota-store.js')));
let db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
const measurements=[];
const official=JSON.parse(db.prepare("SELECT value FROM store_meta WHERE key='official_quota_observations'").get()?.value||'[]');
function measure(name,asOf){const begin=performance.now();const result=selectStoredQuotaWindows(db,asOf,official);
 const row={name,elapsedMs:performance.now()-begin,work:{...quotaProjectionWork(db)},memory:process.memoryUsage(),result};measurements.push(row);console.log(JSON.stringify({name,elapsedMs:row.elapsedMs,work:row.work}));return result;}
try {
 const asOf=Date.parse(prior.asOf);
 const first=measure('initialize',asOf);
 assert.deepEqual(first,prior.measurements.find(row=>row.label==='new-observation').result);
 const originalFacts=db.prepare('SELECT COUNT(*) n,SUM(total) total FROM events').get();
 const next={...prior.insertion.row};next.line_number=Number(db.prepare('SELECT MAX(line_number) n FROM rate_limit_observations WHERE source_path=?').get(next.source_path).n)+1;
 next.observed_at_ms=asOf+1000;next.used_percent=55;
 const fields=Object.keys(next);
 db.prepare(`INSERT INTO rate_limit_observations(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`).run(...Object.values(next));
 const changed=measure('one-observation',asOf+1000);
 assert.equal(measurements.at(-1).work.rebuilt,false);assert.equal(measurements.at(-1).work.changes,1);
 db.exec('DELETE FROM usage_quota_window_cache');
 const began=performance.now();const expected=oracle.selectStoredQuotaWindows(db,asOf+1000,official);
 const oracleMs=performance.now()-began;assert.deepEqual(changed,expected);
 assert.deepEqual(measure('reuse',asOf+1000),expected);
 assert.deepEqual(db.prepare('SELECT COUNT(*) n,SUM(total) total FROM events').get(),originalFacts);
 assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');
 const storage=db.prepare("SELECT name,SUM(pgsize) bytes FROM dbstat WHERE name IN (SELECT name FROM sqlite_master WHERE tbl_name LIKE 'usage_quota_projection_%') GROUP BY name").all();
 db.close();db=new DatabaseSync(file);
 assert.deepEqual(measure('reopen-reuse',asOf+1000),expected);
 assert.deepEqual({size:statSync(source).size,mtimeMs:statSync(source).mtimeMs},before);
 writeFileSync(path.join(directory,'result.json'),JSON.stringify({passed:true,oracleMs,measurements,storage,sourceUnchanged:true},null,2)+'\n',{flush:true});
 console.log(JSON.stringify({passed:true,oracleMs,storageBytes:storage.reduce((n,r)=>n+r.bytes,0),directory}));
} finally {db.close();}
