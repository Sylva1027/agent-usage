import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {instrumentMemory} from './windows-memory-lifetime-hook.mjs';

test('request diagnostics bind exact SHA bytes to the retained verification scope',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'archive-request-trace-'));
 try {
  const hook=new URL('./windows-memory-lifetime-hook.mjs',import.meta.url).href;
  const backup=new URL('../../src/history-backup.js',import.meta.url).href;
  const entry=path.join(root,'probe.mjs');
  fs.writeFileSync(entry,`import {DatabaseSync} from 'node:sqlite';import {createHistoryBackup,createHistoryVerificationScope,verifyHistoryBackup} from ${JSON.stringify(backup)};import {memoryRequest} from ${JSON.stringify(hook)};const db=new DatabaseSync(':memory:');db.exec("PRAGMA user_version=19;CREATE TABLE store_meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE source_files(path TEXT PRIMARY KEY,kind TEXT,home_id TEXT,home_label TEXT,home_path TEXT);CREATE TABLE events(id INTEGER PRIMARY KEY,source_path TEXT,timestamp_ms INTEGER,total INTEGER);CREATE TABLE rate_limit_observations(id INTEGER PRIMARY KEY);INSERT INTO events VALUES(1,'f',10,20)");const file=${JSON.stringify(path.join(root,'proof.sqlite'))};await createHistoryBackup(db,file);db.close();const scope=createHistoryVerificationScope({pinFiles:async()=>({check:async()=>true,close:async()=>{}})});try{for(const id of [17,18])await memoryRequest({id,type:'dashboard'},()=>scope.run(()=>verifyHistoryBackup(file)));}finally{await scope.close();}`);
  const result=spawnSync(process.execPath,['--import',hook,entry],{env:{...process.env,WINDOWS_MEMORY_DIAGNOSTIC_DIR:root},encoding:'utf8',windowsHide:true,timeout:20000});
  assert.equal(result.status,0,result.stderr);
  const rows=fs.readFileSync(path.join(root,`memory-${result.pid}.ndjson`),'utf8').trim().split('\n').map(JSON.parse);
  const hashes=rows.filter(x=>x.event==='archive-hash'&&x.scopeId);
  assert.equal(hashes.length,2);for(const x of hashes){assert.equal(x.bytes,fs.statSync(path.join(root,'proof.sqlite')).size);assert.equal(x.requestId,17);assert(x.wallMs>=0);}
  const runs=rows.filter(x=>x.event==='verification-run');assert.deepEqual(runs.map(x=>x.requestId),[17,18]);assert.equal(new Set(runs.map(x=>x.scopeId)).size,1);
 }finally{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert(path.basename(root).startsWith('archive-request-trace-'));fs.rmSync(root,{recursive:true,force:true});}
});

test('request diagnostic transformation accepts both runtimes and rejects unknown executor anchors',()=>{
 const url=new URL('../../src/usage-executor.js',import.meta.url),source=fs.readFileSync(url,'utf8');
 assert(instrumentMemory(url.href,source).includes('wmRequest(message'));
 assert.throws(()=>instrumentMemory(url.href,source.replace('  const initialize = async () => {','changed')),/anchor changed/);
});

test('the new closeout root stays private and does not change historical default paths',()=>{
 const module=new URL('./windows-stability-run.mjs',import.meta.url).href;
 const code=`import {CLOSEOUT_RESULT} from ${JSON.stringify(module)};console.log(CLOSEOUT_RESULT)`;
 const allowed=path.resolve('output/archive-request-lifetime-20261110');
 const good=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,WINDOWS_CLOSEOUT_ROOT:allowed},encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(good.status,0,good.stderr);assert.equal(good.stdout.trim(),allowed);
 const bad=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,WINDOWS_CLOSEOUT_ROOT:path.resolve('src')},encoding:'utf8',windowsHide:true,timeout:10000});
 assert.notEqual(bad.status,0);assert.match(bad.stderr,/Unknown private closeout root/);
});

test('browser polling defers only the runner-owned navigation and preserves page failures',async()=>{
 const {pollBrowser}=await import('./windows-stability-run.mjs');
 const context={pages:[],navigatingPages:new Set()};
 const page={isClosed:()=>false,evaluate:async()=>assert.fail('do not drain a page being initialized')};context.pages=[page];
 context.navigatingPages.add(page);await pollBrowser(context);
 context.navigatingPages.clear();
 page.evaluate=async()=>{context.navigatingPages.add(page);throw new Error('Execution context was destroyed, most likely because of a navigation');};
 await pollBrowser(context);
 context.navigatingPages.clear();page.evaluate=async()=>{throw new Error('Execution context was destroyed');};
 await assert.rejects(pollBrowser(context),/Execution context was destroyed/);
 page.evaluate=async()=>{context.navigatingPages.add(page);throw new Error('unexpected page failure');};
 await assert.rejects(pollBrowser(context),/unexpected page failure/);
});
