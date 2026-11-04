import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { launch, request, VARIANTS } from './runner.mjs';
import { productProjection } from './compat.mjs';

const directory = path.resolve(process.argv[2] || 'output/architecture-20261101/real-results');
await mkdir(directory, { recursive: true });
const fixture = JSON.parse(await readFile(process.argv[3] || 'output/architecture-20261101/real/fixture.json', 'utf8'));
const variants = process.argv.slice(4).length ? process.argv.slice(4) : VARIANTS;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
const expected = [...fixture.events].sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.eventId.localeCompare(b.eventId));
const expectedHash = digest(canonical(expected));
const businessFilters = ['all','today','week','month'].map(preset=>({ preset,now:fixture.context.generatedAt,calendarZone:'utc' }));
const baselineHashes = businessFilters.map(filters=>digest(canonical(productProjection({ events:expected,context:fixture.context },filters))));
const results = [];
for (const variant of variants) {
  let engine;
  const runDirectory = path.join(directory, variant+'-'+Date.now());
  await mkdir(runDirectory, { recursive:true });
  const start=performance.now();
  try {
    engine=await launch(variant,runDirectory);
    const commitStart=performance.now();
    for(let at=0;at<fixture.events.length;at+=10_000){
      await request(engine.baseUrl,'/api/commit',{sourceId:'real-part-'+String(at).padStart(8,'0'),events:fixture.events.slice(at,at+10_000),cursor:{end:Math.min(at+10_000,fixture.events.length)},...(at===0?{context:fixture.context}:{})});
    }
    const ingestMs=performance.now()-commitStart;
    const queryStart=performance.now();
    const summary=await request(engine.baseUrl,'/api/query');
    const coreQueryMs=performance.now()-queryStart;
    assert.equal(summary.eventCount,expected.length);
    const report=await request(engine.baseUrl,'/api/report');
    // All events share no identical timestamp/eventId pair, so the source-part tie breaker is immaterial.
    assert.equal(digest(canonical(report.events)),expectedHash);
    assert.deepEqual(report.context,fixture.context);
    for(let i=0;i<businessFilters.length;i++) assert.equal(digest(canonical(productProjection(report,businessFilters[i]))),baselineHashes[i]);
    results.push({variant,passed:true,eventCount:expected.length,ingestMs,coreQueryMs,elapsedMs:performance.now()-start,businessCases:businessFilters.length,eventHash:expectedHash});
  }catch(error){results.push({variant,passed:false,error:error.stack,stderr:engine?.stderr(),elapsedMs:performance.now()-start});}
  finally{await engine?.stop();}
  await writeFile(path.join(directory,'results.json'),JSON.stringify({passed:results.every(r=>r.passed),scope:'real frozen history parity; single-round times are diagnostics, not a performance acceptance',results},null,2));
  console.log(JSON.stringify(results.at(-1)));
}
if(results.some(r=>!r.passed))process.exitCode=1;
