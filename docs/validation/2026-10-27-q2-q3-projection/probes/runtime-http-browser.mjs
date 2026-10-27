import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createUsageServer } from './final-v4/src/server.js';
import { assistantRow, promptRow } from '../../test-support/claude-perf-fixture.mjs';
const require = createRequire(import.meta.url);
const {chromium} = require('C:/Users/Silver/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');
const privateRoot = path.resolve('.codex-usage/refresh-latency-20261026');
const evidence = path.resolve('output/q2-q3-projection-20261027');
const frozen = JSON.parse(fs.readFileSync(path.join(privateRoot,'freeze.json'),'utf8'));
const physical = file => {
  const entry = frozen.mappings.find(row => file.toLowerCase().startsWith(row.original.toLowerCase()+path.sep));
  assert.ok(entry,'Source must be isolated');
  return path.join(entry.copy,path.relative(entry.original,file));
};
const databaseFile = path.join(privateRoot,'incremental-http-browser-'+process.pid+'.sqlite');
await fsp.copyFile(frozen.database,databaseFile,fs.constants.COPYFILE_EXCL);
const moduleHashes = Object.fromEntries(['src/usage-store.js','src/usage-executor.js','src/server.js','public/app.js'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(evidence,'final-v4',file))).digest('hex')]));
const result = {moduleHashes,databaseFile,startedAt:new Date().toISOString(),http:[],browser:[],cycles:[],attempts:[],memory:[],errors:[]};
const save = () => fsp.writeFile(path.join(evidence,process.env.REFRESH_RESULT_FILE||'http-browser-results.json'),JSON.stringify(result,null,2));
const server = createUsageServer({...frozen.options,databaseFile,pricingFile:physical(path.join(frozen.home,'.codex-usage/pricing.json')),automaticPricingFile:physical(path.join(frozen.home,'.codex-usage/pricing-auto.json')),importStoreFile:physical(path.join(frozen.home,'.codex-usage/imports.json')),pricingRefreshSchedulerEnabled:false,automaticDiscoveryEnabled:false});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base = 'http://127.0.0.1:'+server.address().port;
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
let browser;
const originals = new Map();
const preserve = file => {if(!originals.has(file)){const stat=fs.statSync(file);originals.set(file,{size:stat.size,mtime:stat.mtime,atime:stat.atime});}};
const created=[];
const outputDelta=1_000_007,inputDelta=100,totalDelta=outputDelta+inputDelta;
const claude = physical(frozen.sourceFiles.filter(row=>row.kind==='claude').sort((a,b)=>fs.statSync(physical(b.filePath)).mtimeMs-fs.statSync(physical(a.filePath)).mtimeMs)[0].filePath);
const ledger = physical(path.join(frozen.home,'.config/magpie/usage.jsonl'));
const codexHome = frozen.homes.find(row=>row.kind==='main');
const threadId=randomUUID();
const nativeFile=physical(path.join(codexHome.path,'sessions','2026','10','26','rollout-refresh-diagnostic-'+threadId+'.jsonl'));
const responses=[];
const knownResponses=Array.from({length:64},()=> 'resp_visible_'+randomUUID());
const matchedDurations=[];
let nativeCount=0;
async function appendChange(kind,index) {
  const timestamp=new Date().toISOString();
  if(kind==='claude') {
    preserve(claude);
    const sessionId='refresh-diagnostic-'+process.pid;
    await fsp.appendFile(claude,'\n'+JSON.stringify(promptRow(Date.now()-1000,sessionId))+'\n'+JSON.stringify(assistantRow({ts:Date.now(),messageId:randomUUID(),sessionId,model:'deepseek-flash',inputTokens:inputDelta,outputTokens:outputDelta,stopReason:'end_turn'}))+'\n');
    return {kind,index,writtenAt:Date.now(),expectedDelta:totalDelta};
  }
  if(kind==='codex-new'||kind==='codex-append') {
    const rows=[];
    if(!fs.existsSync(nativeFile)) {
      await fsp.mkdir(path.dirname(nativeFile),{recursive:true});created.push(nativeFile);
      rows.push({timestamp,type:'session_meta',payload:{id:threadId,session_id:threadId,source:'cli',originator:'codex-tui',cwd:'C:/refresh-diagnostic'}});
    }
    for(let part=0;part<2;part++) {
    const responseId=part===0?knownResponses[nativeCount/2]:'resp_refresh_'+randomUUID(),turnId=randomUUID();
    if(part===0)matchedDurations.push(2000+(nativeCount/2)*1000);
    if(part===1)responses.push(responseId);nativeCount++;
    rows.push({timestamp,type:'turn_context',payload:{thread_id:threadId,turn_id:turnId,model:'gpt-6-sol',effort:'high'}});
    rows.push({timestamp,type:'token_usage_record',payload:{thread_id:threadId,turn_id:turnId,response_id:responseId,usage:{input_tokens:inputDelta,output_tokens:outputDelta}}});
    rows.push({timestamp,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{total_tokens:totalDelta*nativeCount,input_tokens:inputDelta*nativeCount,cached_input_tokens:0,output_tokens:outputDelta*nativeCount,reasoning_output_tokens:0}}}});
    rows.push({timestamp,type:'event_msg',payload:{type:'item_completed',thread_id:threadId,turn_id:turnId,item:{id:randomUUID(),type:'AgentMessage'},started_at_ms:Date.now()-1000,completed_at_ms:Date.now()}});
    rows.push({timestamp,type:'event_msg',payload:{type:'task_complete',thread_id:threadId,turn_id:turnId}});
    }
    await fsp.appendFile(nativeFile,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
    return {kind,index,writtenAt:Date.now(),expectedDelta:2*totalDelta,expectedCandidates:2,expectedSampled:outputDelta};
  }
  if(kind==='ledger') {
    preserve(ledger);
    const responseId=responses.shift();assert.ok(responseId,'Ledger row must match native request');
    await fsp.appendFile(ledger,JSON.stringify({agent:'codex',provider:'codex',req:'codex/gpt-6-sol',model:'gpt-6-sol',response_id:responseId,status:200,ms:3000+(index+1)*1000,out:outputDelta,stop:'completed',ep:'/backend-api/codex/responses'})+'\n');
    matchedDurations.push(3000+(index+1)*1000);
    return {kind,index,writtenAt:Date.now(),expectedDelta:0,expectedCandidates:0,expectedSampled:outputDelta};
  }
  return {kind,index,writtenAt:Date.now(),expectedDelta:0};
}
async function request(label,url) {
  const startedAt=Date.now(),started=performance.now();
  const response=await fetch(base+url); const data=await response.json();
  assert.equal(response.status,200,JSON.stringify({label,status:response.status,code:data.code}));
  const row={label,ms:performance.now()-started,startedAt,total:data.summary?.totals?.total,changed:data.changed,rss:process.memoryUsage().rss,maxRSSKiB:process.resourceUsage().maxRSS};
  result.http.push(row);console.log(JSON.stringify(row));await save();return data;
}
try {
 preserve(ledger);
 await fsp.appendFile(ledger,knownResponses.map((responseId,index)=>JSON.stringify({agent:'codex',provider:'codex',req:'codex/gpt-6-sol',model:'gpt-6-sol',response_id:responseId,status:200,ms:2000+index*1000,out:outputDelta,stop:'completed',ep:'/backend-api/codex/responses'})).join('\n')+'\n');
 await appendChange('codex-new',-1);await appendChange('ledger',-1);
 if(!process.argv.includes('--browser-only')) {
  await request('http-first-default','/api/usage?preset=today&view=dashboard');
  for(let i=0;i<3;i++) await request('http-default-'+i,'/api/usage?preset=today&view=dashboard');
  for(const preset of ['today','month','all']) for(let i=0;i<3;i++) await request('http-skip-'+preset+'-'+i,'/api/usage?skipCheck=1&view=dashboard&preset='+preset);
  for(let i=0;i<20;i++) await request('status-idle-'+i,'/api/status');
  const heavy=request('overlap-default','/api/usage?view=dashboard&preset=today');
  await sleep(100);
  await Promise.all([request('overlap-status','/api/status'),request('overlap-skip','/api/usage?skipCheck=1&view=dashboard&preset=month'),heavy]);
 }
  browser=await chromium.launch({headless:true,executablePath:'C:/Users/Silver/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',args:['--disable-dev-shm-usage','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding']});
  result.browserVersion=browser.version();
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN',timezoneId:'Asia/Shanghai'});
  await context.route('**/api/pricing/refresh',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({changed:false,statusChanged:false,pricesUpdated:false,exchangeRateUpdated:false,errors:[],issues:[]})}));
  const page=await context.newPage();
  const browserResponses=[];let statusCount=0;const statusSerials=new WeakMap();
  page.on('pageerror',error=>result.errors.push({type:'pageerror',message:error.message}));
  page.on('requestfailed',request=>result.errors.push({type:'requestfailed',url:new URL(request.url()).pathname,error:request.failure()?.errorText}));
  page.on('request',request=>{
    const url=new URL(request.url());if(url.pathname==='/api/status'){statusCount++;statusSerials.set(request,statusCount);}
    if(['/api/status','/api/usage'].includes(url.pathname))result.browser.push({type:'request',at:Date.now(),path:url.pathname,preset:url.searchParams.get('preset'),skipCheck:url.searchParams.get('skipCheck'),statusSerial:statusCount});
  });
  page.on('response',async response=>{
    const url=new URL(response.url());if(!['/api/status','/api/usage'].includes(url.pathname))return;
    try {await response.finished();const data=await response.json();const row={type:'response',at:Date.now(),path:url.pathname,preset:url.searchParams.get('preset'),status:response.status(),total:data.summary?.totals?.total,output:data.summary?.totals?.output,sampledOutput:data.summary?.perf?.codexTimingCoverage?.sampledOutputTokens,timingCounts:data.summary?.perf?.codexTimingCoverage?.counts,changed:data.changed,checkedAt:data.checkedAt,quotaState:data.summary?.range?.quotaState};result.browser.push(row);browserResponses.push(row);}catch(error){result.errors.push({type:'response-observer',message:error.message});}
  });
  await page.addInitScript(()=>{
    window.__refreshFrames=[];window.__refreshTicks=[];window.__refreshStatusFetches=[];window.__refreshActiveTick=null;
    const nativeInterval=window.setInterval;
    window.setInterval=function(callback,ms,...args){if(ms===60000){window.__refreshCheck=callback;window.__refreshIntervalInstalledAt=Date.now();}return nativeInterval(function(...rest){if(ms!==60000)return callback(...rest);const tick={at:Date.now(),previousAt:window.__refreshTicks.at(-1)??window.__refreshIntervalInstalledAt};window.__refreshTicks.push(tick.at);window.__refreshActiveTick=tick;try{return callback(...rest);}finally{window.__refreshActiveTick=null;}},ms,...args);};
    const nativeFetch=window.fetch;
    window.fetch=function(input,...args){const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.pathname==='/api/status')window.__refreshStatusFetches.push({serial:window.__refreshStatusFetches.length+1,at:Date.now(),tick:window.__refreshActiveTick});return nativeFetch.call(this,input,...args);};
    document.addEventListener('DOMContentLoaded',()=>{
      let previous='';
      const read=()=>{
        const total=document.querySelector('#totalTokens'),output=document.querySelector('#outputTokens'),spinner=document.querySelector('#autoRefreshSpinner');
        const timing=document.querySelector('#perfModels .perf-model-hero strong');
        const perf=window.__visibleState?.summary?.perf;
        const model=perf?.models?.find(row=>row.sourceKind==='codex'&&row.model==='gpt-6-sol'&&row.reasoningEffort==='high');
        return {total:total?.title||'',output:output?.title||'',text:total?.textContent||'',outputText:output?.textContent||'',timingText:timing?.textContent||'',sampled:perf?.codexTimingCoverage?.sampledOutputTokens,n:model?.n,averageTps:model?.averageTps,busy:spinner?.classList.contains('is-loading')||false};
      };
      const capture=()=>{
        const value=read();
        const key=JSON.stringify(value);if(key===previous)return;previous=key;
        const domAt=Date.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.__refreshFrames.push({...value,domAt,frameAt:Date.now(),frame:read()})));
      };
      new MutationObserver(capture).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['title','class']});capture();
    });
  });
  const firstAt=Date.now();
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>/^\d/.test(document.querySelector('#totalTokens')?.title||''),{},{timeout:120000});
  result.firstBrowserMs=Date.now()-firstAt;console.log(JSON.stringify({label:'browser-first',ms:result.firstBrowserMs}));
  await page.evaluate(async()=>{window.__visibleState=(await import('/app-state.js')).state;});
  result.cyclePreset='all';
  for(const preset of ['month','all','today','all']) {
    const start=Date.now();const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/usage'&&new URL(r.url()).searchParams.get('preset')===preset);
    await page.locator('[data-preset="'+preset+'"]').click();await (await response).finished();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    result.browser.push({type:'filter-complete',preset,ms:Date.now()-start});
  }
  const worstPhaseOnly=process.argv.includes('--worst-phase-only');
  result.probeMode=worstPhaseOnly?'real 60 second worst write phase controls':process.argv.includes('--probe-smoke')?'controlled manual smoke':'bounded real 60 second validation';
  result.clockMethod='browser fetch bound to its synchronous interval callback';
  const kinds=worstPhaseOnly?['codex-append','ledger']:Array.from({length:process.argv.includes('--probe-smoke')?2:3},()=>['codex-append','ledger']).flat();
  const ticker=setInterval(()=>{const row={at:Date.now(),rss:process.memoryUsage().rss,maxRSSKiB:process.resourceUsage().maxRSS,freeGiB:os.freemem()/2**30,walBytes:fs.existsSync(databaseFile+'-wal')?fs.statSync(databaseFile+'-wal').size:0,cpu:process.cpuUsage()};result.memory.push(row);console.log(JSON.stringify({label:'resource',...row}));},30000);
  try {
    for(let index=0;index<kinds.length;index++) {
      let initialStatus=statusCount;
      const before=await page.locator('#totalTokens').getAttribute('title');
      const beforeValue=Number(before.replaceAll(',',''));
      const beforeOutputText=await page.locator('#outputTokens').textContent();
      if(kinds[index]==='ledger'||kinds[index]==='codex-append') {
        await page.locator(`button[data-perf-model-key='["codex","gpt-6-sol","high",""]']`).click();
        await page.locator('#perfModels .perf-model-detail-panel').scrollIntoViewIfNeeded();
      } else await page.locator('#outputTokens').scrollIntoViewIfNeeded();
      const beforeTimingText=await page.locator('#perfModels .perf-model-hero strong').textContent();
      const beforeSampled=await page.evaluate(async()=>(await import('/app-state.js')).state.summary.perf.codexTimingCoverage.sampledOutputTokens);
      const beforePerf=await page.evaluate(()=>structuredClone(window.__visibleState.summary.perf));
      const beforeModel=beforePerf.models.find(row=>row.sourceKind==='codex'&&row.model==='gpt-6-sol'&&row.reasoningEffort==='high');
      let idleObservation={};
      if(worstPhaseOnly) {
        const idle=await page.waitForResponse(r=>new URL(r.url()).pathname==='/api/status',{timeout:90000});
        assert.equal((await idle.json()).changed,false,'Worst write phase must miss a real unchanged check');
        await idle.finished();
        await page.waitForFunction(()=>!document.querySelector('#autoRefreshSpinner')?.classList.contains('is-loading'),{},{timeout:120000});
        idleObservation={missedCheckStartedAt:await page.evaluate(()=>window.__refreshTicks.at(-1)),idleResponseAt:Date.now()};
        initialStatus=statusCount;
      }
      const change=await appendChange(kinds[index],index);
      if(worstPhaseOnly) {
        assert.ok(idleObservation.missedCheckStartedAt<=idleObservation.idleResponseAt);
        assert.ok(change.writtenAt-idleObservation.idleResponseAt<1000,'Write must follow the unchanged check within one second');
      }
      if(process.argv.includes('--probe-smoke')) setTimeout(()=>page.evaluate(()=>window.__refreshCheck()),250);
      const expected=beforeValue+change.expectedDelta;
      const startRows=result.browser.length;
      const statusResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/status',{timeout:90000});
      statusResponse.catch(()=>{});
      const targetRequest=await page.waitForRequest(r=>new URL(r.url()).pathname==='/api/status'&&statusCount>initialStatus,{timeout:90000});
      const requestObservedAt=Date.now();
      const fetchTiming=await page.evaluate(serial=>window.__refreshStatusFetches[serial-1],statusSerials.get(targetRequest));
      const requestAt=fetchTiming.at;
      const checkStartedAt=fetchTiming.tick?.at??null;
      const previousTickAt=fetchTiming.tick?.previousAt??null;
      result.attempts.push({index,kind:kinds[index],writtenAt:change.writtenAt,requestObservedAt,fetchTiming});
      if(!process.argv.includes('--probe-smoke'))assert.ok(checkStartedAt>=change.writtenAt&&checkStartedAt<=requestAt&&fetchTiming.tick,'Actual status fetch must be bound to its real browser interval callback: '+JSON.stringify(fetchTiming));
      const statusData=await (await statusResponse).json();
      if(statusData.changed) {
        const response=await page.waitForResponse(r=>new URL(r.url()).pathname==='/api/usage',{timeout:120000});await response.finished();
      }
      if(change.expectedSampled) {
        assert.equal(statusData.changed,true,'Native/ledger changes must trigger refresh');
        await page.waitForFunction(previous=>(document.querySelector('#perfModels .perf-model-hero strong')?.textContent||'')!==previous,beforeTimingText,{timeout:120000});
        const sampled=await page.evaluate(async()=>(await import('/app-state.js')).state.summary.perf.codexTimingCoverage.sampledOutputTokens);
        assert.equal(sampled-beforeSampled,change.expectedSampled,'The matched timing must be published in this cycle');
      }
      if(change.expectedDelta)await page.waitForFunction(value=>Number((document.querySelector('#totalTokens')?.title||'').replaceAll(',',''))===value,expected,{timeout:120000});
      await page.waitForFunction(()=>!document.querySelector('#autoRefreshSpinner')?.classList.contains('is-loading'),{},{timeout:120000});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const frames=await page.evaluate(()=>window.__refreshFrames.splice(0));
      const responseRows=result.browser.slice(startRows);
      const tokenFrame=frames.find(row=>row.frameAt>=requestAt&&Number(row.frame.total.replaceAll(',',''))===expected&&(!change.expectedDelta||row.frame.outputText!==beforeOutputText));
      const timingFrame=frames.find(row=>row.frameAt>=requestAt&&row.frame.timingText!==beforeTimingText&&row.frame.sampled===beforeSampled+change.expectedSampled&&row.frame.n===beforeModel.n+1);
      const matching=timingFrame;
      assert.ok(tokenFrame,'Exact new tokens must reach a measured frame');
      assert.ok(timingFrame,'Exact sampled tokens, model n and changed TPS text must reach a measured frame');
      const afterPerf=await page.evaluate(()=>structuredClone(window.__visibleState.summary.perf));
      assert.equal(afterPerf.codexTimingCoverage.recordedOutputTokens-beforePerf.codexTimingCoverage.recordedOutputTokens,change.expectedCandidates*outputDelta);
      const actualModel=afterPerf.models.find(row=>row.sourceKind==='codex'&&row.model==='gpt-6-sol'&&row.reasoningEffort==='high');
      const rates=matchedDurations.map(ms=>outputDelta*1000/ms).sort((a,b)=>a-b);
      const expectedStats={n:matchedDurations.length,averageTps:matchedDurations.length*outputDelta*1000/matchedDurations.reduce((sum,ms)=>sum+ms,0),p10:rates[Math.ceil(rates.length*.1)-1],p90:rates[Math.ceil(rates.length*.9)-1]};
      for(const [key,value]of Object.entries(expectedStats))assert.equal(actualModel[key],value,'independent controlled duration oracle: '+key);
      const afterValue=Number((await page.locator('#totalTokens').getAttribute('title')).replaceAll(',',''));
      assert.equal(afterValue,expected,'Controlled increment must be exactly visible');
      if(change.expectedDelta) assert.notEqual(await page.locator('#outputTokens').textContent(),beforeOutputText,'Increment must cross visible rounding');
      if(change.kind!=='unchanged') assert.ok(matching,'Every changed value must reach a measured frame');
      const row={...change,beforeOutputText,beforeTimingText,beforePerf,afterPerf,statusChanged:statusData.changed,checkStartedAt,requestAt,completedAt:Date.now(),expectedDelta:change.expectedDelta,delta:afterValue-beforeValue,tokenFrameAt:tokenFrame.frameAt,timingFrameAt:timingFrame.frameAt,fromCheckTokenMs:tokenFrame.frameAt-(checkStartedAt||requestAt),fromCheckTpsMs:timingFrame.frameAt-(checkStartedAt||requestAt),fromWriteMs:matching?matching.frameAt-change.writtenAt:null,fromCheckMs:matching?matching.frameAt-(checkStartedAt||requestAt):null,fromStatusRequestMs:matching?matching.frameAt-requestAt:null,frames,requests:responseRows};
      if(change.kind!=='unchanged')assert.ok(Number.isFinite(row.fromCheckMs)&&row.fromCheckMs>=0&&Number.isFinite(row.fromWriteMs)&&row.fromWriteMs>=0);
      Object.assign(row,idleObservation);
      row.writePhase=worstPhaseOnly?'after-unchanged-check':'after-prior-visible-frame';
      row.expectedStats=expectedStats;row.writePhaseAfterPreviousTickMs=worstPhaseOnly?change.writtenAt-idleObservation.missedCheckStartedAt:result.cycles.length?change.writtenAt-result.cycles.at(-1).checkStartedAt:null;
      row.actualIntervalMs=checkStartedAt&&previousTickAt?checkStartedAt-previousTickAt:null;
      row.freshnessBudgetMs=row.actualIntervalMs===null?null:row.actualIntervalMs+5000;
      row.freshnessOverMs=row.freshnessBudgetMs===null?null:Math.max(0,row.fromWriteMs-row.freshnessBudgetMs);
      result.cycles.push(row);console.log(JSON.stringify({label:'browser-cycle',index,kind:change.kind,delta:row.delta,fromWriteMs:row.fromWriteMs,fromCheckMs:row.fromCheckMs}));await save();
      if(os.freemem()<4*2**30)throw new Error('System available memory below reserve');
    }
  } finally {clearInterval(ticker);}
  result.ticks=await page.evaluate(()=>window.__refreshTicks);
  await page.screenshot({path:path.join(evidence,'browser-final.png'),fullPage:false});
  // Two real tabs share one server; issue ordinary filter reads concurrently.
  const second=await context.newPage();const secondStart=Date.now();
  const secondLoad=second.goto(base,{waitUntil:'domcontentloaded'}).then(()=>second.waitForFunction(()=>/^\d/.test(document.querySelector('#totalTokens')?.title||''),{},{timeout:120000}));
  const filterStart=Date.now();const filtered=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/usage');
  await page.locator('[data-preset="month"]').click();await (await filtered).finished();await secondLoad;
  result.twoTabs={secondLoadMs:Date.now()-secondStart,firstFilterAndJoinMs:Date.now()-filterStart};
  assert.deepEqual(result.errors,[],'Browser observers must have no errors');
  await second.close();await context.close();
} catch(error) {result.failure={message:error.message,stack:error.stack};console.error(error);process.exitCode=1;}
finally {
  if(browser)await browser.close();result.walBeforeClose=fs.existsSync(databaseFile+'-wal')?fs.statSync(databaseFile+'-wal').size:0;await server.close();result.walAfterClose=fs.existsSync(databaseFile+'-wal')?fs.statSync(databaseFile+'-wal').size:0;
  for(const [file,stat]of originals){fs.truncateSync(file,stat.size);fs.utimesSync(file,stat.atime,stat.mtime);}
  for(const file of created)fs.unlinkSync(file);
  result.finishedAt=new Date().toISOString();result.finalRss=process.memoryUsage().rss;result.maxRSSKiB=process.resourceUsage().maxRSS;await save();
}






