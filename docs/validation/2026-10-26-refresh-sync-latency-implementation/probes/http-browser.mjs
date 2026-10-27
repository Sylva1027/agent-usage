import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createUsageServer } from '../../src/server.js';
import { assistantRow, promptRow } from '../../test-support/claude-perf-fixture.mjs';
const require = createRequire(import.meta.url);
const {chromium} = require('C:/Users/Silver/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');
const privateRoot = path.resolve('.codex-usage/refresh-latency-20261026');
const evidence = path.resolve('output/refresh-sync-latency-implementation');
const frozen = JSON.parse(fs.readFileSync(path.join(privateRoot,'freeze.json'),'utf8'));
const physical = file => {
  const entry = frozen.mappings.find(row => file.toLowerCase().startsWith(row.original.toLowerCase()+path.sep));
  assert.ok(entry,'Source must be isolated');
  return path.join(entry.copy,path.relative(entry.original,file));
};
const databaseFile = path.join(privateRoot,'implementation-http-browser-'+process.pid+'.sqlite');
await fsp.copyFile(frozen.database,databaseFile,fs.constants.COPYFILE_EXCL);
const result = {startedAt:new Date().toISOString(),http:[],browser:[],cycles:[],memory:[],errors:[]};
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
    const responseId='resp_refresh_'+randomUUID(),turnId=randomUUID(); responses.push(responseId);nativeCount++;
    const rows=[];
    if(!fs.existsSync(nativeFile)) {
      await fsp.mkdir(path.dirname(nativeFile),{recursive:true});created.push(nativeFile);
      rows.push({timestamp,type:'session_meta',payload:{id:threadId,session_id:threadId,source:'cli',originator:'codex-tui',cwd:'C:/refresh-diagnostic'}});
    }
    rows.push({timestamp,type:'turn_context',payload:{thread_id:threadId,turn_id:turnId,model:'gpt-6-sol',effort:'high'}});
    rows.push({timestamp,type:'token_usage_record',payload:{thread_id:threadId,turn_id:turnId,response_id:responseId,usage:{input_tokens:inputDelta,output_tokens:outputDelta}}});
    rows.push({timestamp,type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{total_tokens:totalDelta*nativeCount,input_tokens:inputDelta*nativeCount,cached_input_tokens:0,output_tokens:outputDelta*nativeCount,reasoning_output_tokens:0}}}});
    rows.push({timestamp,type:'event_msg',payload:{type:'item_completed',thread_id:threadId,turn_id:turnId,item:{id:randomUUID(),type:'AgentMessage'},started_at_ms:Date.now()-1000,completed_at_ms:Date.now()}});
    rows.push({timestamp,type:'event_msg',payload:{type:'task_complete',thread_id:threadId,turn_id:turnId}});
    await fsp.appendFile(nativeFile,rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
    return {kind,index,writtenAt:Date.now(),expectedDelta:totalDelta};
  }
  if(kind==='ledger') {
    preserve(ledger);
    const responseId=responses.shift();assert.ok(responseId,'Ledger row must match native request');
    await fsp.appendFile(ledger,JSON.stringify({agent:'codex',provider:'codex',req:'codex/gpt-6-sol',model:'gpt-6-sol',response_id:responseId,status:200,ms:2000+index,out:outputDelta,stop:'completed',ep:'/backend-api/codex/responses'})+'\n');
    return {kind,index,writtenAt:Date.now(),expectedDelta:0};
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
  const browserResponses=[];let statusCount=0;
  page.on('pageerror',error=>result.errors.push({type:'pageerror',message:error.message}));
  page.on('requestfailed',request=>result.errors.push({type:'requestfailed',url:new URL(request.url()).pathname,error:request.failure()?.errorText}));
  page.on('request',request=>{
    const url=new URL(request.url());if(url.pathname==='/api/status')statusCount++;
    if(['/api/status','/api/usage'].includes(url.pathname))result.browser.push({type:'request',at:Date.now(),path:url.pathname,preset:url.searchParams.get('preset'),skipCheck:url.searchParams.get('skipCheck'),statusSerial:statusCount});
  });
  page.on('response',async response=>{
    const url=new URL(response.url());if(!['/api/status','/api/usage'].includes(url.pathname))return;
    try {await response.finished();const data=await response.json();const row={type:'response',at:Date.now(),path:url.pathname,preset:url.searchParams.get('preset'),status:response.status(),total:data.summary?.totals?.total,output:data.summary?.totals?.output,sampledOutput:data.summary?.perf?.codexTimingCoverage?.sampledOutputTokens,timingCounts:data.summary?.perf?.codexTimingCoverage?.counts,changed:data.changed,checkedAt:data.checkedAt,quotaState:data.summary?.range?.quotaState};result.browser.push(row);browserResponses.push(row);}catch(error){result.errors.push({type:'response-observer',message:error.message});}
  });
  await page.addInitScript(()=>{
    window.__refreshFrames=[];window.__refreshTicks=[];
    const nativeInterval=window.setInterval;
    window.setInterval=function(callback,ms,...args){if(ms===60000)window.__refreshCheck=callback;return nativeInterval(function(...rest){if(ms===60000)window.__refreshTicks.push(Date.now());return callback(...rest);},ms,...args);};
    document.addEventListener('DOMContentLoaded',()=>{
      let previous='';
      const read=()=>{
        const total=document.querySelector('#totalTokens'),output=document.querySelector('#outputTokens'),spinner=document.querySelector('#autoRefreshSpinner');
        const timing=document.querySelector('#perfModels .perf-model-hero strong');
        return {total:total?.title||'',output:output?.title||'',text:total?.textContent||'',outputText:output?.textContent||'',timingText:timing?.textContent||'',busy:spinner?.classList.contains('is-loading')||false};
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
  result.cyclePreset='all';
  for(const preset of ['month','all','today','all']) {
    const start=Date.now();const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/usage'&&new URL(r.url()).searchParams.get('preset')===preset);
    await page.locator('[data-preset="'+preset+'"]').click();await (await response).finished();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    result.browser.push({type:'filter-complete',preset,ms:Date.now()-start});
  }
  result.probeMode=process.argv.includes('--probe-smoke')?'controlled manual smoke':'real 60 second cycles';
  const kinds=process.argv.includes('--probe-smoke')?['claude','codex-new','codex-append','ledger']:['unchanged','claude','codex-new','codex-append','ledger','claude','codex-append','ledger','claude','codex-append','ledger','claude','codex-append','ledger','claude','codex-append','ledger','claude','codex-append','claude','codex-append'];
  const ticker=setInterval(()=>{const row={at:Date.now(),rss:process.memoryUsage().rss,maxRSSKiB:process.resourceUsage().maxRSS,freeGiB:os.freemem()/2**30,walBytes:fs.existsSync(databaseFile+'-wal')?fs.statSync(databaseFile+'-wal').size:0,cpu:process.cpuUsage()};result.memory.push(row);console.log(JSON.stringify({label:'resource',...row}));},30000);
  try {
    for(let index=0;index<kinds.length;index++) {
      const initialStatus=statusCount;
      const before=await page.locator('#totalTokens').getAttribute('title');
      const beforeValue=Number(before.replaceAll(',',''));
      const beforeOutputText=await page.locator('#outputTokens').textContent();
      if(kinds[index]==='ledger') {
        await page.locator(`button[data-perf-model-key='["codex","gpt-6-sol","high",""]']`).click();
        await page.locator('#perfModels .perf-model-detail-panel').scrollIntoViewIfNeeded();
      } else await page.locator('#outputTokens').scrollIntoViewIfNeeded();
      const beforeTimingText=await page.locator('#perfModels .perf-model-hero strong').textContent();
      const beforeSampled=await page.evaluate(async()=>(await import('/app-state.js')).state.summary.perf.codexTimingCoverage.sampledOutputTokens);
      const change=await appendChange(kinds[index],index);
      if(process.argv.includes('--probe-smoke')) setTimeout(()=>page.evaluate(()=>window.__refreshCheck()),250);
      const expected=beforeValue+change.expectedDelta;
      const startRows=result.browser.length;
      const statusResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/status',{timeout:90000});
      const targetRequest=await page.waitForRequest(r=>new URL(r.url()).pathname==='/api/status'&&statusCount>initialStatus,{timeout:90000});
      const requestAt=Date.now();
      const checkStartedAt=await page.evaluate(()=>window.__refreshTicks.at(-1)||null);
      if(!process.argv.includes('--probe-smoke'))assert.ok(checkStartedAt>=change.writtenAt&&checkStartedAt<=requestAt,'Each real check must have its actual interval tick');
      const statusData=await (await statusResponse).json();
      if(statusData.changed) {
        const response=await page.waitForResponse(r=>new URL(r.url()).pathname==='/api/usage',{timeout:120000});await response.finished();
      }
      if(change.kind==='ledger') {
        assert.equal(statusData.changed,true,'Ledger-only changes must trigger refresh');
        await page.waitForFunction(previous=>(document.querySelector('#perfModels .perf-model-hero strong')?.textContent||'')!==previous,beforeTimingText,{timeout:120000});
        const sampled=await page.evaluate(async()=>(await import('/app-state.js')).state.summary.perf.codexTimingCoverage.sampledOutputTokens);
        assert.equal(sampled-beforeSampled,outputDelta,'The matched timing must be published in this cycle');
      }
      if(change.expectedDelta)await page.waitForFunction(value=>Number((document.querySelector('#totalTokens')?.title||'').replaceAll(',',''))===value,expected,{timeout:120000});
      await page.waitForFunction(()=>!document.querySelector('#autoRefreshSpinner')?.classList.contains('is-loading'),{},{timeout:120000});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const frames=await page.evaluate(()=>window.__refreshFrames.splice(0));
      const responseRows=result.browser.slice(startRows);
      const matching=frames.find(row=>row.frameAt>=requestAt&&(change.kind==='ledger'?row.frame.timingText!==beforeTimingText:Number(row.frame.total.replaceAll(',',''))===expected&&(!change.expectedDelta||row.frame.outputText!==beforeOutputText)));
      const afterValue=Number((await page.locator('#totalTokens').getAttribute('title')).replaceAll(',',''));
      assert.equal(afterValue,expected,'Controlled increment must be exactly visible');
      if(change.expectedDelta) assert.notEqual(await page.locator('#outputTokens').textContent(),beforeOutputText,'Increment must cross visible rounding');
      if(change.kind!=='unchanged') assert.ok(matching,'Every changed value must reach a measured frame');
      const row={...change,beforeOutputText,beforeTimingText,statusChanged:statusData.changed,checkStartedAt,requestAt,completedAt:Date.now(),expectedDelta:change.expectedDelta,delta:afterValue-beforeValue,fromWriteMs:matching?matching.frameAt-change.writtenAt:null,fromCheckMs:matching?matching.frameAt-(checkStartedAt||requestAt):null,fromStatusRequestMs:matching?matching.frameAt-requestAt:null,frames,requests:responseRows};
      if(change.kind!=='unchanged')assert.ok(Number.isFinite(row.fromCheckMs)&&row.fromCheckMs>=0&&Number.isFinite(row.fromWriteMs)&&row.fromWriteMs>=0);
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

