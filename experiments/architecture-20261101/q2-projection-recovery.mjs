import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageStore } from '../../src/usage-store.js';
import { prepareStoredMetadata, readStoredMetadata } from '../../src/usage-metadata-store.js';
import { tryAppendUsageRollups } from '../../src/usage-rollups.js';

const [label, mode, component, phase] = process.argv.slice(2);
const options = root => ({homeDir:root, databaseFile:path.join(root,'state.sqlite'), env:{}, importDirs:[], automaticDiscoveryEnabled:false});
const zoneIdentity = Intl.DateTimeFormat().resolvedOptions().timeZone || `offset:${new Date().getTimezoneOffset()}`;
function insert(db,n) {
  db.prepare(`INSERT INTO events(source_path,timestamp_ms,session_id,home_id,home_label,channel,project,model,
    hour_key,day_key,week_key,month_key,cwd,repository_key,repository_path,repository_kind,
    detail_mask,reconciliation_gap,total,input,cached,output,reasoning)
    VALUES('/fixture',?,'shared','main','main','main','fixture','gpt-6-sol','2026-11-03 00','2026-11-03','2026-11-02','2026-11',
    '/repo','repo','repo','git',15,0,?,0,0,0,0)`).run(Date.parse('2026-11-03T01:00:00Z')+n*1000,n*10);
}
if (mode === 'child') {
  const store = new UsageStore(options(label)); await store.open();
  const db = store.database;
  const crash = () => {
    process.send({component,phase});
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);
    throw new Error('Parent did not kill child');
  };
  const exec = db.exec.bind(db);
  db.exec = sql => {
    const boundary = component === 'metadata' ? sql === 'COMMIT' : sql === 'RELEASE usage_rollups_write';
    if (boundary && phase === 'before-commit') crash();
    const result = exec(sql);
    if (boundary && phase === 'after-commit') crash();
    return result;
  };
  if (component === 'metadata') prepareStoredMetadata(db,{batchSize:1});
  else assert.equal(tryAppendUsageRollups(db,{zoneIdentity}).applied,true);
  throw new Error('Crash point was not reached');
}
assert.match(label || '',/^q2-[a-z0-9-]+$/);
const directory = path.resolve('output/architecture-20261103/q2',label);
await mkdir(directory);
const results = [];
for (const component of ['metadata','rollups']) for (const phase of ['before-commit','after-commit']) {
  const root = path.join(directory,component+'-'+phase); await mkdir(root);
  let store = new UsageStore(options(root)); await store.open();
  store.database.prepare('INSERT INTO source_files VALUES(?,?,?,?,?,?,?,?)').run('/fixture','main','main','main','/fixture',1,1,'fixture');
  insert(store.database,1);insert(store.database,2);
  if (component === 'rollups') store.prepareHotRollups();
  insert(store.database,3);store.close();
  const child = fork(fileURLToPath(import.meta.url),[root,'child',component,phase],{
    execArgv:['--max-old-space-size=224','--max-semi-space-size=4'],windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],
  });
  let stderr='',received=false;
  child.stderr.on('data',x=>stderr+=x);
  child.on('message',message=>{assert.deepEqual(message,{component,phase});received=true;child.kill('SIGKILL');});
  const exit = await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));});
  assert.equal(received,true,stderr); assert.ok(exit.signal === 'SIGKILL' || exit.code !== 0);
  store = new UsageStore(options(root)); await store.open();
  try {
    let work;
    if (component === 'metadata') {
      work = prepareStoredMetadata(store.database,{batchSize:1});
      assert.equal(work.readEvents,phase === 'before-commit'?3:2);
      const result=readStoredMetadata(store.database,Number.MAX_SAFE_INTEGER);
      assert.equal(result.eventCount,3);assert.equal(result.sessionCount,1);
    } else {
      work=tryAppendUsageRollups(store.database,{zoneIdentity});
      assert.equal(work.applied,true);assert.equal(work.readEvents,phase === 'before-commit'?1:0);
      assert.equal(store.database.prepare("SELECT SUM(total) n FROM usage_rollup_daily WHERE calendar_zone='utc'").get().n,60);
    }
    assert.equal(store.database.prepare('PRAGMA quick_check').get().quick_check,'ok');
    results.push({component,phase,exit,work,passed:true});
  } finally {store.close();}
}
await writeFile(path.join(directory,'result.json'),JSON.stringify({passed:true,results},null,2)+'\n',{flush:true});
console.log(JSON.stringify({passed:true,results}));
