import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {UsageStore} from '../../src/usage-store.js';
import {loadPricingFile} from '../../src/pricing-store.js';
import {assistantRow,promptRow} from '../../test-support/claude-perf-fixture.mjs';

const output=path.resolve('output/refresh-sync-latency-implementation');
const frozen=JSON.parse(fs.readFileSync('.codex-usage/refresh-latency-20261026/freeze.json','utf8'));
const physical=file=>{const mapping=frozen.mappings.find(row=>file.toLowerCase().startsWith(row.original.toLowerCase()+path.sep));assert.ok(mapping);return path.join(mapping.copy,path.relative(mapping.original,file));};
const db=path.join(path.dirname(frozen.database),`implementation-changed-${process.pid}.sqlite`);
await fsp.copyFile(frozen.database,db,fs.constants.COPYFILE_EXCL);
const options={...frozen.options,databaseFile:db,automaticDiscoveryEnabled:false,pricingRefreshSchedulerEnabled:false};
await loadPricingFile(options);
const store=new UsageStore(options);
const home=frozen.homes.find(row=>row.kind==='main');
const thread=randomUUID();
const logical=path.join(home.path,'sessions','2026','10','26',`rollout-refresh-diagnostic-${thread}.jsonl`);
const native=physical(logical);
const ledger=physical(path.join(frozen.home,'.config/magpie/usage.jsonl'));
const claude=physical(frozen.sourceFiles.find(row=>row.kind==='claude').filePath);
const originals=new Map([ledger,claude].map(file=>[file,fs.statSync(file)]));
const result={samples:[],maxRSSKiB:0,freeGiB:[],delta:{input:100,output:1000007,total:1000107}};
const responses=[];
let nativeCount=0;
const save=()=>fsp.writeFile(path.join(output,'changed-results.json'),JSON.stringify(result,null,2));
async function sync(label) {
 const started=performance.now();const status=await store.sync();
 const row={label,ms:performance.now()-started,updatedFileCount:status.updatedFileCount,sourceWarnings:store.perfState().sourceWarnings,rss:process.memoryUsage().rss};
 result.samples.push(row);result.maxRSSKiB=Math.max(result.maxRSSKiB,process.resourceUsage().maxRSS);result.freeGiB.push(os.freemem()/2**30);
 assert.ok(result.freeGiB.at(-1)>=4);assert.deepEqual(row.sourceWarnings,[]);
 console.log(JSON.stringify(row));await save();return status;
}
async function appendNative() {
 nativeCount++;const turn=randomUUID(),response='resp_refresh_'+randomUUID();responses.push(response);
 const timestamp='2026-10-26T15:00:00.000Z';const rows=[];
 if(nativeCount===1)rows.push({timestamp,type:'session_meta',payload:{id:thread,session_id:thread,source:'cli',originator:'codex-tui'}});
 rows.push({timestamp,type:'turn_context',payload:{thread_id:thread,turn_id:turn,model:'gpt-6-sol',effort:'high'}});
 rows.push({timestamp,type:'token_usage_record',payload:{thread_id:thread,turn_id:turn,response_id:response,usage:{input_tokens:result.delta.input,output_tokens:result.delta.output}}});
 rows.push({timestamp,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{total_tokens:result.delta.total*nativeCount,input_tokens:result.delta.input*nativeCount,cached_input_tokens:0,output_tokens:result.delta.output*nativeCount,reasoning_output_tokens:0}}}});
 rows.push({timestamp,type:'event_msg',payload:{type:'item_completed',thread_id:thread,turn_id:turn,item:{id:randomUUID(),type:'AgentMessage'},started_at_ms:Date.now()-1000,completed_at_ms:Date.now()}});
 rows.push({timestamp,type:'event_msg',payload:{type:'task_complete',thread_id:thread,turn_id:turn}});
 await fsp.mkdir(path.dirname(native),{recursive:true});await fsp.appendFile(native,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
}
const total=()=>Number(store.database.prepare('SELECT SUM(total) AS n FROM events').get().n);
try {
 await store.open();await sync('catchup-sync');await sync('settle-sync-0');await sync('settle-sync-1');
 await appendNative();await sync('native-prime-sync');
 for(let i=0;i<20;i++) {
  const before=total();await appendNative();const status=await sync(`native-append-sync-${i}`);
  assert.equal(total()-before,result.delta.total);assert.equal(status.updatedFileCount,1);
 }
 const beforeLedger=total();
 for(let i=0;i<20;i++) {
  const row={agent:'codex',provider:'codex',req:'codex/gpt-6-sol',model:'gpt-6-sol',response_id:responses[i+1],status:200,ms:2000+i,out:result.delta.output,stop:'completed',ep:'/backend-api/codex/responses'};
  await fsp.appendFile(ledger,JSON.stringify(row)+'\n');const status=await sync(`ledger-only-sync-${i}`);
  assert.equal(status.updatedFileCount,0);assert.equal(total(),beforeLedger);assert.equal(store.requestTimingDirtyThreadCount(),0);
  const sampled=Number(store.database.prepare('SELECT SUM(output_tokens) AS n FROM perf_samples WHERE source_path = ? AND duration_ms IS NOT NULL').get(logical).n||0);
  assert.equal(sampled,(i+1)*result.delta.output,'matched timing must publish in this sync');
 }
 for(let i=0;i<20;i++) {
  const before=total(),sessionId=`refresh-changed-${process.pid}`;
  await fsp.appendFile(claude,'\n'+JSON.stringify(promptRow(Date.now()-1000,sessionId))+'\n'+JSON.stringify(assistantRow({ts:Date.now(),sessionId,messageId:randomUUID(),model:'deepseek-flash',inputTokens:result.delta.input,outputTokens:result.delta.output,stopReason:'end_turn'}))+'\n');
  const status=await sync(`claude-append-sync-${i}`);assert.equal(status.updatedFileCount,1);assert.equal(total()-before,result.delta.total);
 }
 result.checkedNativeIncrements=20;result.checkedLedgerTimings=20;result.checkedClaudeIncrements=20;
} finally {
 store.close();
 for(const [file,info]of originals){fs.truncateSync(file,info.size);fs.utimesSync(file,info.atime,info.mtime);}
 await fsp.rm(native,{force:true});
 for(const suffix of ['', '-wal','-shm'])await fsp.rm(db+suffix,{force:true});
 result.finishedAt=new Date().toISOString();await save();
}
