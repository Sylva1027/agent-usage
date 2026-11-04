import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import * as candidate from '../../src/usage-quota-store.js';

const generation=process.argv[3]==='--q4'?'q4':'q3';
const root=path.resolve('output/architecture-20261104',generation);
const base=path.resolve(process.argv[2]);
assert.ok(base.startsWith(root+path.sep));
assert.ok(process.execArgv.includes('--max-old-space-size=224'));
assert.ok(process.execArgv.includes('--max-semi-space-size=4'));
const frozen=await import(pathToFileURL(path.resolve('output/architecture-20261104/q3/baseline/src/usage-quota-store.js')));
const read=async file=>JSON.parse(await readFile(file,'utf8'));
const analysis=await read(path.join(base,'analysis-page.json'));assert.equal(analysis.complete,true);
const results=[];
function fingerprint(iterable) {
  if(iterable===null)return {ambiguous:true,count:0,sha256:null};
  const hash=createHash('sha256');let count=0;
  for(const row of iterable){hash.update(JSON.stringify(row)).update('\n');count+=1;}
  return {ambiguous:false,count,sha256:hash.digest('hex')};
}
assert.equal(fingerprint([]).count,0);
for(const cell of ['1x-sha','10x-sha']) {
  const run=await read(path.join(base,'page',cell,'candidate/result.json'));assert.equal(run.passed,true);
  const database=new DatabaseSync(run.prepared.databaseFile,{readOnly:true});
  let cacheReads=0;
  // Both algorithms must calculate their answer, not read the candidate's cached JSON.
  const source={get isTransaction(){return database.isTransaction;},exec:sql=>database.exec(sql),prepare(sql){
    if(/FROM\s+usage_quota_window_cache\b/i.test(sql))return {get(){cacheReads+=1;return undefined;}};
    return database.prepare(sql);
  }};
  try {
    const official=JSON.parse(database.prepare("SELECT value FROM store_meta WHERE key='official_quota_observations'").get()?.value||'[]');
    const state=database.prepare('SELECT * FROM usage_quota_projection_state WHERE singleton=1').get();
    assert.equal(Number(state.queued),0);assert.equal(Number(state.rebuild),0);
    const asOf=Number(state.as_of_ms);
    const actual=candidate.selectStoredQuotaWindows(source,asOf,official);
    assert.notEqual(candidate.quotaProjectionWork(source).fallback,true,'The candidate must use its persistent projection.');
    const started=performance.now(),expected=frozen.selectStoredQuotaWindows(source,asOf,official);
    const referenceMs=performance.now()-started;
    assert.deepEqual(actual,expected,`${cell}: every current and previous window field`);
    const cycles=[];
    const limit=actual.limitId;
    if(limit)for(const minutes of [300,10_080]) {
      const current=fingerprint(candidate.iterateStoredQuotaWindows(source,limit,asOf,minutes,official));
      const original=fingerprint(frozen.iterateStoredQuotaWindows(source,limit,asOf,minutes,official));
      assert.deepEqual(current,original,`${cell}: complete ${minutes} minute cycle stream`);
      cycles.push({minutes,...current});
    }
    assert.ok(cacheReads>=2);
    results.push({cell,asOf:new Date(asOf).toISOString(),referenceMs,cacheReads,cycles,selection:actual,passed:true});
  }finally{database.close();}
}
await writeFile(path.join(base,'real-quota-parity.json'),JSON.stringify({passed:true,definition:'Closed private final DB, same asOf, cached JSON disabled, independent frozen Q2 SQL, streamed cycle hashes.',results},null,2)+'\n');
console.log(JSON.stringify({passed:true,results:results.map(({cell,referenceMs,cycles})=>({cell,referenceMs,cycles}))},null,2));
