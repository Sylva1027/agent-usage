import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, appendFile, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { writeRawFixture, NOW } from './fixture.mjs';
import { collectAndCommit } from './node/collector.mjs';
import { launch, request, VARIANTS } from './runner.mjs';

const directory=path.resolve(process.argv[2]||'output/architecture-20261101/collector-verification');
const variants=process.argv.slice(3).length?process.argv.slice(3):VARIANTS;
await mkdir(directory,{recursive:true});
const results=[];
for(const variant of variants){
  let engine;const checks=[];
  const run=path.join(directory,variant+'-'+Date.now());await mkdir(run,{recursive:true});
  try{
    const fixture=await writeRawFixture(path.join(run,'raw'));
    engine=await launch(variant,run);
    for(const source of fixture.sources)await collectAndCommit(engine.baseUrl,source);
    const before=await request(engine.baseUrl,'/api/report');
    assert.equal(before.events.length,2);assert.equal(before.events.find(e=>e.homeId==='raw-codex-home').total.total,110);assert.equal(before.events.find(e=>e.homeId==='raw-dsh-home').total.total,130);
    checks.push('codex-and-multiframe-dsh-through-real-parsers');
    const same=await collectAndCommit(engine.baseUrl,fixture.sources[0],{previousCursor:before.cursors['raw-codex']});
    assert.equal(same.unchanged,true);assert.equal((await request(engine.baseUrl,'/api/status')).revision,before.revision);
    checks.push('unchanged-content-keeps-revision');
    const frozen=await request(engine.baseUrl,'/api/freeze',{});
    const row={...fixture.codexRows[2],timestamp:'2026-11-01T12:01:00.000Z',payload:{type:'token_count',info:{total_token_usage:{input_tokens:150,cached_input_tokens:20,output_tokens:20,reasoning_output_tokens:2,total_tokens:170}}}};
    await appendFile(fixture.sources[0].path,JSON.stringify(row)+'\n');
    await collectAndCommit(engine.baseUrl,fixture.sources[0]);
    assert.equal((await request(engine.baseUrl,'/api/query')).totals.total,300);
    assert.equal((await request(engine.baseUrl,'/api/query?snapshot='+frozen.snapshot)).totals.total,240);
    checks.push('cumulative-delta-append-and-freeze');
    const accepted=await request(engine.baseUrl,'/api/report');
    const validCodex=await readFile(fixture.sources[0].path);
    await appendFile(fixture.sources[0].path,'{"broken":');
    await assert.rejects(collectAndCommit(engine.baseUrl,fixture.sources[0]));
    assert.deepEqual(await request(engine.baseUrl,'/api/report'),accepted);
    await writeFile(fixture.sources[0].path,validCodex);
    const dshBefore=await readFile(fixture.sources[1].path);
    await appendFile(fixture.sources[1].path,Buffer.from([0x28,0xb5,0x2f,0xfd,0]));
    await assert.rejects(collectAndCommit(engine.baseUrl,fixture.sources[1]));
    assert.deepEqual(await request(engine.baseUrl,'/api/report'),accepted);
    await writeFile(fixture.sources[1].path,dshBefore);
    checks.push('partial-line-and-corrupt-frame-preserve-facts-and-cursors');
    const info=await stat(fixture.sources[0].path);
    const rewritten=validCodex.toString().replace('"input_tokens":150','"input_tokens":160').replace('"total_tokens":170','"total_tokens":180');
    assert.equal(Buffer.byteLength(rewritten),validCodex.length);
    await writeFile(fixture.sources[0].path,rewritten);await utimes(fixture.sources[0].path,info.atime,info.mtime);
    await collectAndCommit(engine.baseUrl,fixture.sources[0],{previousCursor:accepted.cursors['raw-codex']});
    assert.equal((await request(engine.baseUrl,'/api/query')).totals.total,310);
    checks.push('same-size-same-mtime-rewrite-detected');
    await engine.crash();engine=await launch(variant,run);
    assert.equal((await request(engine.baseUrl,'/api/query')).totals.total,310);
    checks.push('collected-facts-survive-restart');
    results.push({variant,passed:true,checks});
  }catch(error){results.push({variant,passed:false,checks,error:error.stack,stderr:engine?.stderr()});}
  finally{await engine?.stop();}
  await writeFile(path.join(directory,'results.json'),JSON.stringify({passed:results.every(r=>r.passed),collector:'shared current-product Node readers; native parsers not yet ported',results},null,2));
  console.log(JSON.stringify(results.at(-1)));
}
if(results.some(r=>!r.passed))process.exitCode=1;
