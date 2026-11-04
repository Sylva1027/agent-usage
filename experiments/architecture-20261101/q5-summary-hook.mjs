import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { appendFile, stat } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, versionSpec } from './q3-benchmark-support.mjs';

export const TRACE_LIMIT=8192;
export function catalogDigest(catalog) {
  const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'
    ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
  return createHash('sha256').update(JSON.stringify(ordered({checkedAt:catalog.checkedAt,
    usdToCnyRate:catalog.usdToCnyRate,models:catalog.models}))).digest('hex');
}

export function readCapturedPricing(file,expected) {
  assert.match(expected||'',/^[a-f0-9]{64}$/,'Q5 needs a shared captured catalog digest.');
  const capture=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.ok(capture.catalog?.models&&capture.catalog?.usdToCnyRate>0);
  assert.equal(catalogDigest(capture.catalog),expected,'Captured Q5 pricing changed.');
  return capture;
}

export function boundedTrace(file,defaults={},limit=TRACE_LIMIT) {
  let records=0,bytes=0,dropped=0,terminalRecords=0,terminalDropped=0;
  if(file)fs.mkdirSync(path.dirname(file),{recursive:true});
  return record=>{
    if(!file)return;
    const row=JSON.stringify({pid:process.pid,ppid:process.ppid,at:Date.now(),...defaults,...record})+'\n';
    if(records>=limit||bytes+Buffer.byteLength(row)>8*1024*1024) {
      if(!dropped++)fs.appendFileSync(file,JSON.stringify({type:'trace-truncated',at:Date.now(),limit})+'\n');
      const terminal=record.error||['hook-start','pricing-verified','native-error','native-protocol-failure'].includes(record.type)
        ||/^(?:store\.)?(?:open|syncRound|prepare.*Projection|summarizeInReadTransactionCore|metadata|periodComparison)$/.test(record.label??'');
      if(!terminal)return;
      if(terminalRecords++>=256||bytes+Buffer.byteLength(row)>9*1024*1024) {
        if(!terminalDropped++)fs.appendFileSync(file,JSON.stringify({type:'terminal-trace-truncated',at:Date.now()})+'\n');
        return;
      }
    }
    records++;bytes+=Buffer.byteLength(row);fs.appendFileSync(file,row);
  };
}

export function assertQ5TraceCoverage(rows) {
  assert.ok(!rows.some(row=>row.type?.includes('trace-truncated')),'Q5 trace truncated; required evidence is incomplete.');
  for(const label of ['store.syncRound','store.summarizeInReadTransactionCore'])
    assert.ok(rows.some(row=>row.label===label&&!row.error),`Required Q5 trace missing: ${label}`);
  const starts=rows.filter(row=>row.type==='hook-start');assert.ok(starts.length>0);
  for(const start of starts)assert.ok(rows.some(row=>row.pid===start.pid&&row.type==='pricing-verified'
    &&row.catalogSha256===start.catalogSha256),'Every Q5 process must verify the captured catalog.');
}

export function createQ5Hook(variant,output,{proofMode='sha',pricingFile,pricingSha256,selectedPaths}={}) {
  assert.ok(['sha','native'].includes(proofMode));
  const version=versionSpec(variant,{generation:'q5'});
  const capture=readCapturedPricing(pricingFile,pricingSha256);
  const hashes=version.frozen?JSON.parse(fs.readFileSync(version.hashesFile,'utf8')):null;
  const nativeHashes=version.frozen?JSON.parse(fs.readFileSync(version.nativeHashesFile,'utf8')):null;
  if(hashes)assert.equal(Object.keys(hashes).length,101);
  const verify=(relative,expected)=>{
    const bytes=fs.readFileSync(path.join(version.directory,relative));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),expected,`Frozen Q5 file changed: ${relative}`);
    return bytes;
  };
  if(nativeHashes)for(const [relative,expected] of Object.entries(nativeHashes))verify(relative,expected);
  const emit=boundedTrace(output&&path.join(output,`private-${process.pid}.jsonl`),{variant,proofMode});
  const component=boundedTrace(output&&path.join(output,`component-${process.pid}.ndjson`),{variant});
  const context=new AsyncLocalStorage();let sequence=0;
  const selected=selectedPaths&&new Set(selectedPaths),isSelected=file=>!selected||selected.has(file);
  globalThis.__q5Trace=(type,details={})=>{
    const file=details.path??context.getStore()?.path;
    if(type==='native-response'&&!isSelected(file))return;
    emit({type,parentSpanId:context.getStore()?.spanId,path:file,...details});
  };
  globalThis.__q5Pricing=catalog=>{
    const actual=catalogDigest(catalog);assert.equal(actual,pricingSha256,'Q5 effective catalog digest differs.');
    emit({type:'pricing-verified',catalogSha256:actual});return catalog;
  };
  globalThis.__q5Wrap=(fn,label)=>function(...args) {
    const start=performance.timeOrigin+performance.now(),spanId=`${process.pid}:${++sequence}`;
    const parentSpanId=context.getStore()?.spanId??null;
    const finish=(error,value)=>{
      const file=typeof args[0]==='string'?args[0]:args[0]?.filePath;
      if(!error&&(label.startsWith('proof.')||label.startsWith('native.')||['store.replaceFile','store.appendFile','store.recertifyUnchangedFile'].includes(label))&&!isSelected(file))return;
      const owner=this,method=label.split('.').at(-1),work=method==='syncRound'?owner?.lastSyncRollupWork
        :method==='prepareMetadataProjection'?owner?.lastMetadataWork:method==='prepareHotRollups'?owner?.lastRollupWork
        :method==='prepareAllSummaryProjection'?owner?.lastAllSummaryWork:method==='prepareQuotaProjection'?owner?.lastQuotaWork:undefined;
      const proofKind=value?.validation?.kind??value?.kind;
      const row={type:'span',label,spanId,parentSpanId,start,duration:performance.timeOrigin+performance.now()-start,
        error:error?.message,errorCode:error?.code,preset:args[0]?.preset,work,
        path:label.startsWith('proof.')||label.startsWith('native.')?args[0]:args[0]?.filePath,
        proofKind,outcome:error?'error':value===null?'null':value===undefined?'void':'returned',
        readBytes:value?.readBytes,prefixBytesRead:value?.prefixBytesRead,parsedBytes:value?.parsedBytes,journalBytes:value?.journalBytes,
        fingerprint:owner?.fingerprint,revision:owner?.storeRevision,reason:method==='commitStoreRevision'?args[0]:undefined};
      emit(row);
      if(label.startsWith('store.'))component({...row,label:method,memory:process.memoryUsage()});
    };
    return context.run({spanId,path:typeof args[0]==='string'?args[0]:args[0]?.filePath},()=>{
      try {
        const value=Reflect.apply(fn,this,args);
        if(value&&typeof value.then==='function')return value.then(result=>{finish(undefined,result);return result;},error=>{finish(error);throw error;});
        finish(undefined,value);return value;
      }catch(error){finish(error);throw error;}
    });
  };
  const wrapMethods=(type,names,prefix)=>`\nfor(const name of ${JSON.stringify(names)}) {
    const original=${type}.prototype[name];if(typeof original==='function')
      ${type}.prototype[name]=globalThis.__q5Wrap(original,${JSON.stringify(prefix)}+'.'+name);
  }\n`;
  const replace=(source,from,to,label)=>{
    assert.ok(source.includes(from),`Q5 hook coverage missing: ${label}`);return source.replace(from,to);
  };
  emit({type:'hook-start',catalogSha256:pricingSha256,nativeBinary:version.nativeBinary});
  return {load(url,ctx,next) {
    if(!url.startsWith('file:'))return next(url,ctx);
    const relative=path.relative(ROOT,fileURLToPath(url)).replaceAll(path.sep,'/');
    const key=Object.keys(hashes??{}).find(key=>key.replaceAll('\\','/')===relative);
    const result=key?{format:'module',shortCircuit:true,source:verify(key,hashes[key]).toString()}:next(url,ctx);
    let source=String(result.source);
    if(relative==='src/pricing.js') {
      source+=`\nconst q5OriginalSetPricing=setPricingCatalog;
        q5OriginalSetPricing(${JSON.stringify(capture.catalog)});globalThis.__q5Pricing(getPricingCatalog());
        setPricingCatalog=()=>globalThis.__q5Pricing(q5OriginalSetPricing(${JSON.stringify(capture.catalog)}));
        resetPricingCatalog=()=>setPricingCatalog();\n`;
    }else if(relative==='src/pricing-store.js') {
      source+=`\nloadPricingFile=async()=>{globalThis.__q5Pricing(getPricingCatalog());};
        ${capture.automaticStatus?'getAutomaticPricingStatus=()=>structuredClone('+JSON.stringify(capture.automaticStatus)+');':''}
        refreshAutomaticPricing=async()=>({changed:false,statusChanged:false,pricesUpdated:false,exchangeRateUpdated:false,
          errors:[],issues:[],...getAutomaticPricingStatus(),discovery:{addedModels:[],results:[]}});\n`;
    }else if(relative==='src/usage-source-proof.js') {
      if(proofMode==='sha')source+='\nUsageSourceProof.prototype.provider=async()=>null;\n';
      source+=wrapMethods('UsageSourceProof',['begin','verify','capture'],'proof');
    }else if(relative==='src/usage-source-native.js') {
      if(version.frozen)source+=`\nexecutablePath=()=>${JSON.stringify(version.nativeBinary)};\n`;
      source=replace(source,'function proofResult(response, offset, info, includeKind) {',
        `function proofResult(response, offset, info, includeKind) {
          globalThis.__q5Trace('native-response',{id:response?.id,ok:response?.ok,available:response?.available,
            reason:response?.reason,proofKind:response?.kind,journalBytes:response?.journalBytes,offset});`,'native response');
      source=replace(source,'child.on("error", () => this.#failProtocol());',
        `child.on("error", error => {globalThis.__q5Trace('native-error',{reason:error.message,code:error.code});this.#failProtocol();});`,'native spawn error');
      source=replace(source,'child.on("exit", () => {',
        `child.on("exit", (code,signal) => {globalThis.__q5Trace('native-exit',{code,signal});`,'native exit');
      source=replace(source,'#failProtocol() {',
        `#failProtocol() {globalThis.__q5Trace('native-protocol-failure',{reason:'helper protocol disabled',stack:new Error().stack});`,'native protocol');
      source+=wrapMethods('WindowsSourceProof',['begin','verify','advance'],'native');
    }else if(relative==='src/usage-store.js') {
      source+=wrapMethods('UsageStore',['open','syncRound','usageFiles','replaceFile','appendFile','recertifyUnchangedFile',
        'commitStoreRevision','prepareMetadataProjection','prepareHotRollups','prepareQuotaProjection',
        'prepareAllSummaryProjection','summarizeInReadTransactionCore','metadata','periodComparison'],'store');
    }else if(relative==='src/usage-source-watch.js') {
      source=replace(source,'function scheduleHint() {',
        `function scheduleHint() {globalThis.__q5Trace('watcher-hint');`,'watcher hint');
    }else if(relative==='src/server.js') {
      if(version.frozen)source=replace(source,source.match(/const PUBLIC_DIR = [^\n]+;/)?.[0]||'MISSING_PUBLIC_DIR',
        `const PUBLIC_DIR = ${JSON.stringify(path.join(version.directory,'public'))};`,'frozen public');
      source=replace(source,'function writeUsageEvent(response, event, data) {',
        `function writeUsageEvent(response, event, data) {globalThis.__q5Trace('sse-send',{event,fingerprint:data?.fingerprint,revision:data?.revision});`,'SSE send');
    }
    return {...result,source};
  }};
}

// Runs before the page code, with no production page changes.
export function observeQ5Delivery() {
  const rows=[];let dropped=0,sequence=0;
  const emit=(kind,details={})=>{
    if(rows.length>=4096){dropped++;return;}
    rows.push({kind,at:Date.now(),clock:performance.timeOrigin+performance.now(),...details});
  };
  window.__q5Delivery={rows,get dropped(){return dropped;}};
  const nativeFetch=window.fetch.bind(window),NativeEventSource=window.EventSource;
  window.fetch=async(...args)=>{
    const id=++sequence,url=args[0] instanceof Request?args[0].url:String(args[0]);emit('fetch-start',{id,url});
    try {
      const response=await nativeFetch(...args);emit('fetch-response',{id,url,status:response.status});
      if(new URL(url,location.href).pathname==='/api/usage')void response.clone().json().then(body=>emit('fetch-body',
        {id,fingerprint:body.fingerprint??body.summary?.fingerprint,revision:body.revision??body.summary?.revision,
          total:body.summary?.totals?.total,eventCount:body.summary?.eventCount}),error=>emit('fetch-body-error',{id,error:String(error)}));
      return response;
    }catch(error){emit('fetch-error',{id,url,error:String(error)});throw error;}
  };
  function Tracked(url,options) {
    const source=new NativeEventSource(url,options);
    for(const event of ['open','error','usage-synced'])source.addEventListener(event,message=>{
      let data;try{data=JSON.parse(message.data);}catch{}
      emit('page-receipt',{event,fingerprint:data?.fingerprint,revision:data?.revision});
    });
    return source;
  }
  Tracked.prototype=NativeEventSource.prototype;
  for(const key of ['CONNECTING','OPEN','CLOSED'])Object.defineProperty(Tracked,key,{value:NativeEventSource[key]});
  window.EventSource=Tracked;
  let last;
  const observer=new MutationObserver(()=>{
    const total=document.querySelector('#totalTokens')?.title;
    if(total===undefined||total===last)return;last=total;emit('dom-total',{total});
    requestAnimationFrame(()=>requestAnimationFrame(()=>emit('paint',{total})));
  });
  observer.observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['title']});
  window.addEventListener('error',event=>emit('page-error',{error:event.message}));
  window.addEventListener('unhandledrejection',event=>emit('page-error',{error:String(event.reason)}));
}

export const readQ5Delivery=page=>page.evaluate(()=>({rows:window.__q5Delivery?.rows??[],dropped:window.__q5Delivery?.dropped??0}));

export function q5PrivateRows(directory) {
  if(!fs.existsSync(directory))return [];
  return fs.readdirSync(directory).filter(name=>/^private-.*\.jsonl$/.test(name)).flatMap(name=>
    fs.readFileSync(path.join(directory,name),'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse));
}

export function q5AppendEvidence(rows,append,targetPath,progress) {
  const timeline=rows.filter(row=>(row.at??row.start)>=append.appendStartedAtMs
    &&(row.at??row.start)<=(append.endedAtMs??Date.now()));
  const proof=timeline.filter(row=>row.label?.startsWith('proof.')&&row.path===targetPath);
  const native=timeline.filter(row=>(row.type?.startsWith('native-')||row.label?.startsWith('native.'))&&row.path===targetPath);
  const proofKinds=[...new Set(proof.map(row=>row.proofKind).filter(Boolean))];
  const finalKind=progress?.validation?.kind;
  const verified=proof.some(row=>row.label==='proof.verify'&&row.proofKind==='ntfs-usn-v1'&&!row.error);
  const captured=proof.some(row=>row.label==='proof.capture'&&row.proofKind==='ntfs-usn-v1'&&!row.error);
  return {proofKind:finalKind,proofKinds,nativeFastPath:finalKind==='ntfs-usn-v1'&&verified&&captured,
    readBytes:proof.reduce((n,row)=>n+(row.readBytes||0),0),journalBytes:proof.reduce((n,row)=>n+(row.journalBytes||0),0),
    native,timeline};
}

// Preserve bootstrap failures even when openPage closes its browser before returning.
export const q5DiagnosticHook={load(url,ctx,next) {
  const result=next(url,ctx);
  if(url.startsWith('file:')&&fileURLToPath(url)===path.join(ROOT,'experiments/architecture-20261101/b2-page-diagnostic.mjs')) {
    const source=String(result.source),needle='} catch(error) {\n    await browser.close();';
    assert.ok(source.includes(needle),'Q5 bootstrap failure trace hook missing');
    return {...result,source:source.replace(needle,`} catch(error) {
      try{error.q5Delivery=await page.evaluate(()=>({rows:window.__q5Delivery?.rows??[],dropped:window.__q5Delivery?.dropped??0}));}catch{}
      await browser.close();`)};
  }
  return result;
}};

export async function appendQ5AndPaint(page,prepared,state,kind,details,expectedTotal,checkpoint,tools) {
  const target=prepared.selected[kind].targetPath;
  const row={id:`${kind}-${details.appends.length+1}`,kind,mode:'sse',expectedTotal,recordedAtMs:Date.now(),startedAtMs:Date.now(),status:'started'};
  details.appends.push(row);await checkpoint();
  let pending;
  try {
    row.bytesBefore=(await stat(target)).size;
    row.sseBefore=await page.evaluate(()=>window.__e1Diagnostic.usageSynced);
    row.totalBefore=Number(String(await page.locator('#totalTokens').getAttribute('title')).replace(/[^0-9]/g,''));
    await checkpoint();
    assert.equal(row.totalBefore,expectedTotal-(kind==='codex'?1000:1900));
    const bytes=kind==='codex'?tools.codexAppendRows(state.codex):tools.dshAppendFrame(state.dsh);
    row.appendedBytes=bytes.length;
    pending=page.waitForResponse(async response=>{
      const url=new URL(response.url());
      if(url.pathname!=='/api/usage'||(url.searchParams.get('preset')||'all')!=='all')return false;
      try{return Number((await response.json()).summary?.totals?.total)===expectedTotal;}catch{return false;}
    },{timeout:300000});
    void pending.catch(()=>{});
    row.startedAtMs=Date.now();row.appendStartedAtMs=row.startedAtMs;await appendFile(target,bytes);
    row.appendLandedAtMs=Date.now();row.status='landed';
    row.bytesAfter=(await stat(target)).size;row.inputGrowthBytes=row.bytesAfter-row.bytesBefore;await checkpoint();
    assert.equal(row.inputGrowthBytes,row.appendedBytes);
    const response=await pending,body=await response.json();
    Object.assign(row,{responseAtMs:Date.now(),responseStatus:response.status(),cache:response.headers()['x-summary-cache']||null,
      responseEventCount:body.summary?.eventCount,responseTotal:body.summary?.totals?.total,
      fingerprint:body.fingerprint??body.summary?.fingerprint,revision:body.revision??body.summary?.revision});
    await checkpoint();assert.equal(row.responseStatus,200);assert.equal(row.responseTotal,expectedTotal);
    await tools.painted(page,expectedTotal);row.paintedAtMs=Date.now();
    row.landingToPaintMs=row.paintedAtMs-row.appendLandedAtMs;
    row.sseAfter=await page.evaluate(()=>window.__e1Diagnostic.usageSynced);row.automaticSseObserved=row.sseAfter>row.sseBefore;
    row.endedAtMs=Date.now();row.wallMs=row.endedAtMs-row.startedAtMs;await checkpoint();
    assert.equal(row.automaticSseObserved,true,`${kind} append did not arrive through page SSE`);
    assert.equal(row.cache,'miss',`${kind} append was hidden by a stale summary-cache hit`);
    row.status='passed';details.scopes.push({name:row.id,...row});return row;
  }catch(error){row.status='failed';row.error={message:error.message,stack:error.stack};row.endedAtMs=Date.now();
    row.wallMs=row.endedAtMs-row.startedAtMs;await checkpoint();throw error;}
  finally{await checkpoint();}
}

if(process.env.Q5_VARIANT&&process.execArgv.some(arg=>arg.includes('q5-summary-hook.mjs')))registerHooks(createQ5Hook(process.env.Q5_VARIANT,process.env.Q5_TRACE_DIR,{
  proofMode:process.env.Q5_PROOF_MODE,pricingFile:process.env.Q5_PRICING_FILE,pricingSha256:process.env.Q5_PRICING_SHA256,
  selectedPaths:process.env.Q5_SELECTED_PATHS?JSON.parse(process.env.Q5_SELECTED_PATHS):undefined}));
