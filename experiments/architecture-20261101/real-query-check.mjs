import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { VARIANTS, launch, request } from './runner.mjs';
import { productProjection } from './compat.mjs';
import { aggregateEvents } from './node/query.mjs';

const root=path.resolve('output/architecture-20261101/real-results');
const fixture=JSON.parse(await readFile('output/architecture-20261101/real/fixture.json','utf8'));
const sorted=[...fixture.events].sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.eventId.localeCompare(b.eventId));
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const expectedHash=hash(sorted);
const entries=await readdir(root,{withFileTypes:true});
const results=[];
for(const variant of VARIANTS){
 let engine;const directory=entries.filter(entry=>entry.isDirectory()&&entry.name.startsWith(variant+'-')).map(entry=>entry.name).sort().at(-1);
 try{
  if(!directory)throw Error('Missing prior real import for '+variant);
  engine=await launch(variant,path.join(root,directory));
  const started=performance.now();const query=await request(engine.baseUrl,'/api/query');const queryMs=performance.now()-started;
  assert.deepEqual({...query,revision:undefined},{...aggregateEvents(sorted),revision:undefined});
  const report=await request(engine.baseUrl,'/api/report');assert.equal(hash(report.events),expectedHash);
  for(const preset of['all','today','week','month']){const filters={preset,now:fixture.context.generatedAt,calendarZone:'utc'};assert.equal(hash(productProjection(report,filters)),hash(productProjection({events:sorted,context:fixture.context},filters)));}
  const cursor=await request(engine.baseUrl,'/api/cursors');assert.equal(cursor.revision,report.revision);assert.equal(Object.hasOwn(cursor,'events'),false);
  results.push({variant,passed:true,eventCount:sorted.length,directory,queryMs,eventHash:expectedHash,coreGroupsEqual:true,businessCases:4});
 }catch(error){results.push({variant,passed:false,error:error.stack,stderr:engine?.stderr()});}
 finally{await engine?.stop();}
 await writeFile(path.join(root,'final-query-results.json'),JSON.stringify({passed:results.every(r=>r.passed),scope:'latest binary against prior full import; single diagnostic query, not p95',results},null,2));console.log(JSON.stringify(results.at(-1)));
}
if(results.some(r=>!r.passed))process.exitCode=1;
