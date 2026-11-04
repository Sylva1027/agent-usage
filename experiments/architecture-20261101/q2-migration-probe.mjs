import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UsageStore } from '../../src/usage-store.js';
import { prepareStoredMetadata } from '../../src/usage-metadata-store.js';

const base=path.resolve(process.argv[2]);
const destination=path.join(base,'migration');await mkdir(destination);
const results=[];
for(const scale of ['1x','10x']) {
  const run=JSON.parse(await readFile(path.join(base,scale+'-sha/baseline/result.json'),'utf8'));
  assert.equal(run.passed,true);
  const file=path.join(destination,scale+'.sqlite');
  // The baseline service is closed; copying its checkpointed private fixture is safe.
  const source=new DatabaseSync(run.prepared.databaseFile);
  try {
    assert.equal(source.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy,0);
  } finally {source.close();}
  await copyFile(run.prepared.databaseFile,file);
  const before=new DatabaseSync(file,{readOnly:true});
  const facts=db=>db.prepare(`SELECT COUNT(*) n,SUM(total) total,SUM(input) input,SUM(output) output,
    SUM(cached) cached,SUM(reasoning) reasoning FROM events`).get();
  const expected=facts(before);
  assert.equal(before.prepare("SELECT 1 FROM sqlite_master WHERE name='usage_metadata_state'").get(),undefined);
  before.close();
  const store=new UsageStore({databaseFile:file,homeDir:destination,env:{},importDirs:[],automaticDiscoveryEnabled:false});
  const opened=performance.now();await store.open();const openMs=performance.now()-opened;
  try {
    const rollupsStarted=performance.now();store.prepareHotRollups();
    const rollupPreparationMs=performance.now()-rollupsStarted;
    const started=performance.now();const work=prepareStoredMetadata(store.database);
    const metadataBuildMs=performance.now()-started;
    assert.deepEqual(facts(store.database),expected);
    assert.equal(work.readEvents,expected.n);
    assert.equal(store.database.prepare('PRAGMA quick_check').get().quick_check,'ok');
    const storage=store.database.prepare(`SELECT name,SUM(pgsize) bytes FROM dbstat WHERE name IN (
      SELECT name FROM sqlite_master WHERE tbl_name LIKE 'usage_metadata_%'
      OR tbl_name LIKE 'usage_rollup_progress%' OR name='events_metadata_group_time_idx') GROUP BY name`).all();
    results.push({scale,openMs,rollupPreparationMs,rollupWork:store.lastRollupWork,metadataBuildMs,work,counts:expected,storage,factCountsAndTokenTotalsUnchanged:true});
  } finally {store.close();}
}
await writeFile(path.join(destination,'result.json'),JSON.stringify({passed:true,results},null,2)+'\n',{flush:true});
console.log(JSON.stringify({passed:true,results}));
