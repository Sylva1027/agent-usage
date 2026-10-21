import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { readFile, writeFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCodexRollout } from '../../../src/perf-sources/codex-thread.js';
import { foldCodexRolloutMetadata } from '../../../src/perf-sources/codex-fold.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const prior = path.resolve(dir, '../2026-10-21-tps-measurement-correction');
const start = Date.parse('2026-10-20T16:00:00Z');
const end = Date.parse('2026-10-21T16:00:00Z');

function coverage(requests, timings) {
  const turns = new Map();
  for (const row of requests) {
    const key = JSON.stringify([row.threadId, row.turnId]);
    if (!turns.has(key)) turns.set(key, new Map());
    const bucket = turns.get(key);
    if (bucket.has(row.responseId)) assert.deepEqual(bucket.get(row.responseId), row, 'conflicting native request');
    bucket.set(row.responseId, row);
  }
  const out = { turns: turns.size, requests: 0, outputTokens: 0, timedRequests: 0, timedOutputTokens: 0,
    completeTurns: 0, partialTurns: 0, untimedTurns: 0, lostTimedRequests: 0, lostTimedOutputTokens: 0 };
  for (const rows of turns.values()) {
    let count = 0, output = 0;
    for (const row of rows.values()) {
      assert(Number.isSafeInteger(row.outputTokens) && row.outputTokens >= 0);
      out.requests++; out.outputTokens += row.outputTokens;
      const timing = timings.get(row.responseId);
      if (!timing) continue;
      assert.equal(timing.reportedOutputTokens, row.outputTokens);
      count++; output += row.outputTokens;
    }
    out.timedRequests += count; out.timedOutputTokens += output;
    if (count === rows.size) out.completeTurns++;
    else if (count > 0) {
      out.partialTurns++; out.lostTimedRequests += count; out.lostTimedOutputTokens += output;
    } else out.untimedTurns++;
  }
  return out;
}

const sample = [1, 2, 3].map(n => ({threadId:'t', turnId:n === 3 ? 'b' : 'a', responseId:String(n), outputTokens:10}));
const sampleTiming = new Map([['1',{reportedOutputTokens:10}],['3',{reportedOutputTokens:10}]]);
assert.deepEqual(coverage(sample, sampleTiming), {turns:2,requests:3,outputTokens:30,timedRequests:2,timedOutputTokens:20,
  completeTurns:1,partialTurns:1,untimedTurns:0,lostTimedRequests:1,lostTimedOutputTokens:10});
assert.deepEqual(coverage([...sample, sample[0]], sampleTiming), coverage(sample, sampleTiming));
assert.throws(() => coverage(sample, new Map([['1',{reportedOutputTokens:11}]])));
if (process.argv.includes('--check-isolation')) {
  const { createPerfCodexIntegrationFixture } = await import('../../../test-support/perf-fixture.mjs');
  const { UsageStore } = await import('../../../src/usage-store.js');
  const { buildUsageReport, summarizeUsage } = await import('../../../src/usage-core.js');
  const { appendFile, mkdir } = await import('node:fs/promises');
  const results = [];
  for (const mode of ['benign-append','ownership-change']) {
    const fixture = createPerfCodexIntegrationFixture();
    const store = new UsageStore(fixture.serverOptions);
    const activeFile = path.join(fixture.codexHome,'sessions/active/rollout.jsonl');
    const activeId='active-thread', turnId='active-turn', responseId='active-response';
    const at=Date.parse('2026-10-04T12:05:00Z');
    const rows=[
      {type:'session_meta',payload:{id:activeId}},
      {type:'turn_context',payload:{thread_id:activeId,turn_id:turnId,model:'active-model',effort:'high'}},
      {type:'token_usage_record',timestamp:new Date(at).toISOString(),payload:{thread_id:activeId,turn_id:turnId,
        response_id:responseId,usage:{output_tokens:100},turn_token_usage:{output_tokens:100}}},
      {type:'event_msg',payload:{type:'task_complete',thread_id:activeId,turn_id:turnId,
        started_at:(at-1000)/1000,completed_at:at/1000,duration_ms:1000}},
    ];
    const text=rows.map(r=>JSON.stringify(r)).join('\n')+'\n';
    const harmless=JSON.stringify({type:'world_state',payload:{}})+'\n';
    const mutation = mode==='benign-append' ? harmless
      : JSON.stringify({type:'session_meta',payload:{id:'fixture-codex-thread'}})+'\n';
    const summary = async () => store.summarize({preset:'all'});
    const historical = result => result.perf.models.find(row=>row.model===fixture.expected.model);
    try {
      await mkdir(path.dirname(activeFile),{recursive:true});
      await writeFile(activeFile,text);
      const timing={schemaVersion:1,evidenceOrigin:'fixture@1',responseId,requestedModel:'active-model',
        reportedOutputTokens:100,durationMs:1000,status:'completed',completedAtMs:null};
      fixture.addRequestTiming(activeId,timing);
      await store.sync({options:fixture.reportOptions});
      await fixture.seedRequestTiming(store);
      const homeId=store.homes.find(h=>path.resolve(h.path)===path.resolve(fixture.codexHome)).id;
      store.importRequestTimingEvidence({homeId,records:[timing],reviewedOrigins:['fixture@1']});
      await store.sync({options:fixture.reportOptions});
      assert.equal(historical(await summary()).n,25);
      const persisted=()=>store.database.prepare('SELECT * FROM perf_samples WHERE model=? ORDER BY sample_key')
        .all(fixture.expected.model);
      const before=persisted();
      await appendFile(activeFile,harmless);
      const original=store.replaceFile.bind(store);
      let injected=false;
      store.replaceFile=async (file,options)=>{
        const result=await original(file,options);
        if(file.filePath===activeFile && !injected){injected=true;await appendFile(activeFile,mutation);}
        return result;
      };
      try { await store.sync({options:fixture.reportOptions}); }
      finally { store.replaceFile=original; }
      assert(injected,'mutation must occur after planning and before publication verification');
      assert.match(store.readMeta('perf_source_warnings'),/LIVE_SOURCE_CHANGED/);
      assert.equal(historical(await summary()),undefined,'whole-home filter hides unchanged historical thread');
      assert.deepEqual(persisted(),before,'previous successful candidate rows remain untouched');
      const policy=JSON.parse(store.readMeta('perf_codex_publication_policy'));
      assert.equal(policy.partialHomes.some(h=>h.homeId===homeId),false);
      if(mode==='ownership-change'){
        await store.sync({options:fixture.reportOptions});
        assert.match(store.readMeta('perf_source_warnings'),/UNKEYABLE_RECORD/,
          'ignoring changed file would miss its new ownership evidence');
      }
      await writeFile(activeFile,text);
      await store.sync({options:fixture.reportOptions});
      assert.equal(historical(await summary()).n,25,'normal sync recovers without deleting old evidence');
      // The memory path sees the same instability when its builder is entered.
      let memoryInjected=false;
      const report=await buildUsageReport({...fixture.reportOptions,lookupRequestTiming(query){
        if(query.threadId===activeId && !memoryInjected){
          memoryInjected=true;
          // A synchronous append makes the injection independent of task scheduling.
          appendFileSync(activeFile,mutation);
        }
        return fixture.reportOptions.lookupRequestTiming(query);
      }});
      assert(memoryInjected,'memory builder must encounter active thread');
      const memorySummary=summarizeUsage(report,{preset:'all'});
      assert.equal(historical(memorySummary),undefined);
      assert(memorySummary.perf.sourceWarnings.some(w=>w.code==='LIVE_SOURCE_CHANGED'));
      await writeFile(activeFile,text);
      await store.sync({options:{...fixture.reportOptions,extraHomes:''}});
      assert.equal(historical(await summary()),undefined,'directory exclusion still applies');
      results.push({mode,mutationInjected:injected,unchangedHistoricalRows:before.length,
        hiddenOnLiveChange:true,memoryHiddenOnLiveChange:true,previousRowsPreserved:true,recoveredSamples:25,directoryExclusion:true});
    } finally {store.close();fixture.close();}
  }
  await writeFile(path.join(dir,'isolation-result.json'),JSON.stringify({results},null,2)+'\n');
  console.log(JSON.stringify({results}));
  process.exit(0);
}
if (!process.argv.includes('--run')) { console.log('audit self-check passed'); process.exit(0); }

const prepared = JSON.parse(await readFile(path.join(prior,'review/final-integration/production-prepared.json'),'utf8'));
const fixture = JSON.parse(await readFile(path.join(prior,'A/review/six-turn-request-fixture.json'),'utf8'));
const evidence = JSON.parse(await readFile(path.join(prepared.recovery,'timings.json'),'utf8'));
const times = new Set(fixture.turns.map(t => Date.parse(t.endedAt)));
const db = new DatabaseSync(path.join(prepared.recovery,'before.sqlite'),{readOnly:true});
let files;
try {
  const rows = db.prepare('SELECT sample_key,ts_ms FROM perf_samples WHERE model=?').all('opendesign/deepseek-v4.1-flash');
  const targets = rows.filter(row => times.has(row.ts_ms));
  assert.equal(targets.length,6);
  files = [...new Set(targets.flatMap(row => db.prepare('SELECT source_path FROM perf_sample_sources WHERE sample_key=?')
    .all(row.sample_key).map(x=>x.source_path)))];
} finally { db.close(); }
assert.equal(files.length,2);
const requests = [], reports = [], projections = [];
for (const [index,file] of files.entries()) {
  const before = await stat(file);
  const bytes = await readFile(file);
  const after = await stat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    reports.push({file:index+1, skipped:'changed-during-read'}); continue;
  }
  const types = {}, identityFields = new Set(), timingFields = new Set();
  let malformed = 0, requestRows = 0, requestRowsWithTiming = 0;
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let row; try { row=JSON.parse(line); } catch { malformed++; continue; }
    const p=row?.payload;
    if (!p || typeof p !== 'object') continue;
    const label = String(row.type)+'/'+String(p.type ?? '');
    types[label]=(types[label]??0)+1;
    for(const key of Object.keys(p)) {
      if (/^(response|request).*id$/i.test(key)) identityFields.add(key);
      if (/start|end|duration|latency|timestamp/i.test(key)) timingFields.add(key);
    }
    if (row.type !== 'token_usage_record') continue;
    requestRows++;
    if (Object.keys(p).some(key => /start|duration|latency/i.test(key))) requestRowsWithTiming++;
  }
  // Reuse the captured bytes, with the production ownership reader; never rescan the live file.
  const temp = await mkdtemp(path.join(os.tmpdir(),'codex-tps-followup-'));
  try {
    const copy = path.join(temp,'rollout.jsonl');
    await writeFile(copy,bytes);
    const rollout = await readCodexRollout(copy);
    for (const record of rollout.projection.records) record.sourcePath=file;
    projections.push(rollout.projection);
  } finally {
    assert.equal(path.dirname(temp),path.resolve(os.tmpdir()));
    assert(path.basename(temp).startsWith('codex-tps-followup-'));
    await rm(temp,{recursive:true,force:true});
  }
  reports.push({file:index+1,bytes:bytes.length,malformed,requestRows,requestRowsWithTiming,
    identityFields:[...identityFields].sort(),timingFields:[...timingFields].sort(),types});
}
const folded = foldCodexRolloutMetadata(evidence.homeId,projections);
let invalidFinishedTurns = 0;
for(const turn of folded.turns) {
  const at = turn.requests.at(-1)?.timestampMs;
  if (!turn.hasTaskComplete || !(at >= start && at < end)) continue;
  if (!turn.requestSetComplete || turn.recordConflictCount || turn.requestOutputSum === null) {
    invalidFinishedTurns++; continue;
  }
  for(const row of turn.requests) requests.push({threadId:turn.threadId,turnId:turn.turnId,
    responseId:row.responseId,outputTokens:row.outputTokens});
}
const result = {scope:'two previously reviewed rollouts; local day 2026-10-21; finished native turns only; timing evidence limited to reviewed 326 requests',
  checkedAt:new Date().toISOString(), files:reports,invalidFinishedTurns,
  coverage:coverage(requests,new Map(evidence.records.map(r=>[r.responseId,r])))};
assert.equal(result.coverage.timedRequests,326);
assert.equal(result.coverage.timedOutputTokens,233379);
await writeFile(path.join(dir,'audit-result.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
