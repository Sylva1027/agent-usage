import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import fsp from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {prepareScale} from './b2-page-diagnostic.mjs';
import { transform, compile } from './b2-attribution-transform.mjs';
import { unionMs } from './b2-attribution-analyze.mjs';
import { summarizeCpu, summarizeHeap } from './b2-attribution-profiles.mjs';

test('profile summaries preserve sample weights and hide string payloads', () => {
  const cpu=summarizeCpu({nodes:[{id:1,callFrame:{functionName:'work',url:'fixture',lineNumber:0}}],samples:[1,1],timeDeltas:[100,300],startTime:0,endTime:400});
  assert.equal(cpu.top[0].sampledMs,0.4);assert.equal(cpu.top[0].line,1);
  const heap=summarizeHeap({snapshot:{meta:{node_fields:['type','name','id','self_size','edge_count'],node_types:[['object','string']],edge_fields:['type','name_or_index','to_node'],edge_types:[['property','weak']]}},nodes:[0,0,1,24,1,1,1,2,16,0],edges:[0,2,5],strings:['Holder','private fixture string','value']});
  assert.equal(heap.totalSelfBytes,40);assert.ok(!JSON.stringify(heap).includes('private fixture string'));
});

test('nested and concurrent child intervals are subtracted only once', () => {
  assert.equal(unionMs([[0,6],[3,9],[4,5]],0,10),9);
  assert.equal(unionMs([[0,6],[3,9],[12,14]],4,13),6);
  assert.equal(unionMs([],0,10),0);
});

test('injected production modules parse without changing their exports', () => {
  for(const file of ['src/server.js','src/usage-store.js','src/usage-executor.js','src/pricing.js']) {
    const s=transform(readFileSync(file,'utf8'),file);
    assert.equal(ts.createSourceFile(file,s,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS).parseDiagnostics.length,0,file);
    const exports=text=>[...text.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_]+)/gm)].map(x=>x[1]);
    assert.deepEqual(exports(s),exports(readFileSync(file,'utf8')),file);
  }
});

test('private mirror falls back to independent copies when hardlinks are denied', async()=>{
  const base=await fsp.mkdtemp(path.join(os.tmpdir(),'codex-q0-copy-'));
  const home=path.join(base,'source'),seed=path.join(base,'seed');await fsp.mkdir(home);await fsp.mkdir(seed);
  const inputs=[];
  for(const [name,kind,compressed] of [['a.jsonl','codex',false],['b.zst','dsh',true],['c.jsonl','claude',false],['config.toml','codex',false],['settings.json','claude',false]]) {
    const body=Buffer.from(name),file=path.join(home,name);await fsp.writeFile(file,body);
    inputs.push({path:file,kind,compressed,key:name[0],sessionKey:'fixture',role:name==='config.toml'||name==='settings.json'?'auxiliary':'usage-file',sourceBytes:body.length,sha256:createHash('sha256').update(body).digest('hex')});
  }
  await fsp.writeFile(path.join(seed,'pricing-auto.json'),'{}');await fsp.writeFile(path.join(seed,'codex-quota.json'),'[]');
  const link=fsp.link;let prepared;
  try {fsp.link=async()=>{throw Object.assign(new Error('fixture denied'),{code:'EPERM'});};syncBuiltinESMExports();prepared=await prepareScale({root:home,scale:1,inputs},path.join(base,'run'),seed);}
  finally {fsp.link=link;syncBuiltinESMExports();}
  assert.equal(prepared.mirror.fallbackCopies,1);
  const original=await fsp.stat(path.join(home,'c.jsonl')),copy=await fsp.stat(path.join(prepared.home,'c.jsonl'));
  assert.notEqual(String(original.ino),String(copy.ino));assert.equal(await fsp.readFile(path.join(prepared.home,'c.jsonl'),'utf8'),'c.jsonl');
});
test('nested spans preserve sync/async errors, iterator values and real file reads', () => {
  const directory=mkdtempSync(path.join(os.tmpdir(),'codex-q0-test-'));
  const sourceMap=path.join(directory,'sources.json');compile(sourceMap);
  const module=pathToFileURL(path.resolve('experiments/architecture-20261101/b2-attribution-trace.mjs')).href;
  const r=spawnSync(process.execPath,['--import',module,'--input-type=module','-e',`
    import assert from 'node:assert/strict';
    import {open} from 'node:fs/promises';
    const q=globalThis.__q0;
    const inner=q.wrap(async()=>{const h=await open('package.json','r');const b=Buffer.alloc(13);const r=await h.read(b,0,13,0);await h.close();return r.bytesRead;},'fixture.inner');
    const outer=q.wrap(async()=>{assert.equal(await inner(),13);const it=q.iterator(function*(){yield 1;yield 2;},'rows')();assert.deepEqual([...it],[1,2]);return 9;},'fixture.outer');
    assert.equal(await outer(),9);
    assert.throws(q.wrap(()=>{throw new Error('sentinel')},'fixture.error'),/sentinel/);
    await assert.rejects(q.wrap(async()=>{throw new Error('async sentinel')},'fixture.asyncError')(),/async sentinel/);
    const {UsageStore}=await import('./src/usage-store.js'); assert.equal(typeof UsageStore,'function');
  `],{encoding:'utf8',env:{...process.env,Q0_TRACE_DIR:directory,Q0_SOURCE_MAP:sourceMap}});
  assert.equal(r.status,0,r.stderr);
  const rows=readFileSync(path.join(directory,readdirSync(directory).find(x=>x.endsWith('.ndjson'))),'utf8').trim().split('\n').map(JSON.parse);
  const inner=rows.find(x=>x.label==='fixture.inner'), outer=rows.find(x=>x.label==='fixture.outer');
  assert.equal(inner.parentId,outer.id); assert.equal(inner.io.fileHandleReadBytes,13);
  assert.equal(outer.counters.rows.calls,2);
  assert.ok(outer.duration>=inner.duration);
  assert.equal(rows.filter(x=>x.status==='error').length,2);
});
