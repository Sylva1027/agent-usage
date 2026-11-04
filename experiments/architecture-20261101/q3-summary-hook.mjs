import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { ROOT, versionSpec } from './q3-benchmark-support.mjs';

let indexExecHookInstalled = false;
const coldFunctions = {
  'src/usage-core.js': ['discoverUsageSources','buildUsageFingerprint','streamUsageFileEvents'],
  'src/usage-metadata-store.js': ['ensureUsageMetadataSchema','createGroupTimeIndex','prepareStoredMetadata','applyBatch'],
  'src/usage-rollups.js': ['createUsageRollups','rebuildUsageRollups','rebuildUsageRollupsFromSource',
    'rebuildUsageRollupsFromEvents','tryAppendUsageRollups','checkpointUsageRollups'],
};

export function createQ3Hook(variant, output) {
  const version = versionSpec(variant);
  const hashes = version.frozen ? JSON.parse(fs.readFileSync(version.hashesFile,'utf8')) : null;
  if (hashes) assert.equal(Object.keys(hashes).length, version.expectedFiles);
  if (output) fs.mkdirSync(output,{recursive:true});
  const coldContext = new AsyncLocalStorage();
  let coldSequence = 0;
  // Separate suffix: the existing runner/analyzer component stream stays unchanged.
  const coldEmit = record => {
    if (output) fs.appendFileSync(path.join(output,`cold-stage-${process.pid}.jsonl`),
      JSON.stringify({pid:process.pid,ppid:process.ppid,variant,...record})+'\n');
  };
  globalThis.__q3ColdWrap = (fn,label,details={}) => {
    if (!output) return fn;
    return function(...args) {
      const span={spanId:`${process.pid}:${++coldSequence}`,parentSpanId:coldContext.getStore()?.spanId??null,
        label,start:performance.timeOrigin+performance.now()};
      let finished=false;
      const finish=(error,value)=>{
        if(finished)return;finished=true;
        coldEmit({type:'span',...span,duration:performance.timeOrigin+performance.now()-span.start,error:error?.message,
          ...details,
          inputRows:label==='metadata.applyBatch'&&Array.isArray(args[2])?args[2].length:undefined,
          calendarZone:label.startsWith('rollups.')?args[1]?.calendarZone:undefined,
          days:label.startsWith('rollups.')&&Array.isArray(args[1]?.days)?args[1].days.length:undefined,
          parsedBytes:value?.parsedBytes,readBytes:value?.readBytes,journalBytes:value?.journalBytes,
          work:label==='metadata.prepareStoredMetadata'||label==='rollups.tryAppendUsageRollups'?value:undefined,
        });
      };
      return coldContext.run(span,()=>{
        try{
          const value=Reflect.apply(fn,this,args);
          if(value&&typeof value.then==='function')return value.then(result=>{finish(undefined,result);return result;},error=>{finish(error);throw error;});
          finish(undefined,value);return value;
        }catch(error){finish(error);throw error;}
      });
    };
  };
  if(output&&!indexExecHookInstalled){
    const exec=DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec=function(sql,...args){
      if(!/\b(?:CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX)\b/i.test(String(sql)))return Reflect.apply(exec,this,[sql,...args]);
      // Time the whole exec, including any companion statements and possible IF NOT EXISTS no-op.
      return globalThis.__q3ColdWrap(exec,'sqlite.indexDDL',{sql:String(sql)}).apply(this,[sql,...args]);
    };
    indexExecHookInstalled=true;
  }
  globalThis.__q3SummaryFinish = (owner,label,start,error,args) => {
    if (!output) return;
    const work = label === 'syncRound' ? owner.lastSyncRollupWork
      : label === 'prepareMetadataProjection' ? owner.lastMetadataWork
      : label === 'prepareHotRollups' ? owner.lastRollupWork
      : label === 'prepareAllSummaryProjection' ? owner.lastAllSummaryWork
      : label === 'prepareQuotaProjection' ? owner.lastQuotaWork : undefined;
    fs.appendFileSync(path.join(output,`component-${process.pid}.ndjson`),JSON.stringify({
      pid:process.pid,ppid:process.ppid,variant,at:Date.now(),label,preset:args[0]?.preset,start,
      duration:performance.timeOrigin+performance.now()-start,error:error?.message,work,
      quotaWork:owner.lastQuotaWork,
      quoteRows:owner.summaryProjectionCache?.quoteInputs?.length||0,
      quoteBytes:owner.summaryProjectionCache?.quoteInputs?.chunks?.reduce((n,c)=>n+c.numbers.buffer.byteLength,0)||0,
      memory:process.memoryUsage(),
    })+'\n');
  };
  const suffix = `\nfor(const name of ['prepareMetadataProjection','prepareHotRollups','prepareAllSummaryProjection','summarizeInReadTransactionCore','prepareQuotaProjection','metadata','periodComparison']) {
    const original=UsageStore.prototype[name];if(!original)continue;
    UsageStore.prototype[name]=function(...args){const began=performance.timeOrigin+performance.now();let failure;
      try{return Reflect.apply(original,this,args);}catch(error){failure=error;throw error;}
      finally{globalThis.__q3SummaryFinish(this,name,began,failure,args);}};
  }
  const originalSync=UsageStore.prototype.syncRound;
  UsageStore.prototype.syncRound=async function(...args){const began=performance.timeOrigin+performance.now();let failure;
    try{return await Reflect.apply(originalSync,this,args);}catch(error){failure=error;throw error;}
    finally{globalThis.__q3SummaryFinish(this,'syncRound',began,failure,args);}};\n`;
  const coldStoreSuffix = `\nfor(const name of ['open','syncRound','usageFiles','replaceFile','appendFile','recertifyUnchangedFile',
    'prepareMetadataProjection','prepareHotRollups','prepareQuotaProjection','prepareAllSummaryProjection']) {
    const original=UsageStore.prototype[name];if(typeof original==='function')
      UsageStore.prototype[name]=globalThis.__q3ColdWrap(original,'store.'+name);
  }\n`;
  const keyFor = relative => Object.hasOwn(hashes ?? {},relative) ? relative : relative.replaceAll(path.sep,'\\');
  return {
    load(url,context,nextLoad) {
      if (!url.startsWith('file:')) return nextLoad(url,context);
      const file = fileURLToPath(url), relative = path.relative(ROOT,file);
      let result;
      if (hashes && hashes[keyFor(relative)]) {
        const bytes = fs.readFileSync(path.join(version.directory,relative));
        assert.equal(createHash('sha256').update(bytes).digest('hex'),hashes[keyFor(relative)],`Frozen ${variant} source changed: ${relative}`);
        result = { format:'module',source:bytes.toString(),shortCircuit:true };
      } else result = nextLoad(url,context);
      if (hashes && relative.replaceAll(path.sep,'/') === 'src/server.js') {
        // Keep native/package paths at the workspace while serving this version's frozen page.
        assert.match(String(result.source), /const PUBLIC_DIR = [^\n]+;/);
        result.source = String(result.source).replace(/const PUBLIC_DIR = [^\n]+;/,
          `const PUBLIC_DIR = ${JSON.stringify(path.join(version.directory,'public'))};`);
      }
      const normalized=relative.replaceAll(path.sep,'/');
      if (normalized === 'src/usage-store.js') return { ...result,source:String(result.source)+suffix+coldStoreSuffix };
      const targets=coldFunctions[normalized];
      if(targets){
        const source=String(result.source),prefix=normalized==='src/usage-core.js'?'source':normalized==='src/usage-metadata-store.js'?'metadata':'rollups';
        const found=targets.filter(name=>new RegExp('\\bfunction\\s+'+name+'\\s*\\(').test(source));
        coldEmit({type:'coverage',module:normalized,functions:found});
        return {...result,source:source+'\n'+found.map(name=>`${name}=globalThis.__q3ColdWrap(${name},${JSON.stringify(prefix+'.'+name)});`).join('\n')};
      }
      return result;
    },
  };
}

if (process.env.Q3_VARIANT) registerHooks(createQ3Hook(process.env.Q3_VARIANT,process.env.Q3_TRACE_DIR));
