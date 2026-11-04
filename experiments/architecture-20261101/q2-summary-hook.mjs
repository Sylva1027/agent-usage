import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const baseline=path.join(root,'output/architecture-20261103/q2/baseline');
const hashes=JSON.parse(fs.readFileSync(path.join(baseline,'../baseline-hashes.json'),'utf8'));
const frozen=process.env.Q1_VARIANT==='baseline',output=process.env.Q1_TRACE_DIR;
if(output)fs.mkdirSync(output,{recursive:true});
globalThis.__q2Finish=(owner,label,start,error,args)=>{
 if(!output)return;
 fs.appendFileSync(path.join(output,`component-${process.pid}.ndjson`),JSON.stringify({
  pid:process.pid,at:Date.now(),label,preset:args[0]?.preset,start,duration:performance.timeOrigin+performance.now()-start,
  error:error?.message,work:label==='syncRound'?owner.lastSyncRollupWork:label==='prepareMetadataProjection'?owner.lastMetadataWork:label==='prepareHotRollups'?owner.lastRollupWork:label==='prepareAllSummaryProjection'?owner.lastAllSummaryWork:undefined,
  quoteRows:owner.summaryProjectionCache?.quoteInputs?.length||0,
  quoteBytes:owner.summaryProjectionCache?.quoteInputs?.chunks?.reduce((n,c)=>n+c.numbers.buffer.byteLength,0)||0,
  memory:process.memoryUsage(),
 })+'\n');
};
registerHooks({load(url,ctx,next){
 const result=next(url,ctx);if(!url.startsWith('file:'))return result;
 const relative=path.relative(root,fileURLToPath(url));let source=result.source;
 if(frozen&&hashes[relative]){const bytes=fs.readFileSync(path.join(baseline,relative));assert.equal(createHash('sha256').update(bytes).digest('hex'),hashes[relative]);source=bytes.toString();}
 if(relative.split(path.sep).join('/')==='src/usage-store.js')source=String(source)+`\nfor(const name of ['prepareMetadataProjection','prepareHotRollups','prepareAllSummaryProjection','summarizeInReadTransactionCore','prepareQuotaProjection','metadata','periodComparison']) {
  const original=UsageStore.prototype[name];if(!original)continue;
  UsageStore.prototype[name]=function(...args){const began=performance.timeOrigin+performance.now();let failure;
   try{return Reflect.apply(original,this,args);}catch(error){failure=error;throw error;}
   finally{globalThis.__q2Finish(this,name,began,failure,args);}};
 }
 const sync=UsageStore.prototype.syncRound;
 UsageStore.prototype.syncRound=async function(...args){const began=performance.timeOrigin+performance.now();let failure;
  try{return await Reflect.apply(sync,this,args);}catch(error){failure=error;throw error;}
  finally{globalThis.__q2Finish(this,'syncRound',began,failure,args);}};\n`;
 return {...result,source};
}});
