import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {createUsageServer} from '../../src/server.js';
import {assistantRow,promptRow} from '../../test-support/claude-perf-fixture.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/Silver/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');
const baseDir=path.resolve('.codex-usage/refresh-latency-20261026');
const outDir=path.resolve('output/refresh-sync-latency-reeval-20261026');
const frozen=JSON.parse(fs.readFileSync(path.join(baseDir,'freeze.json'),'utf8'));
const source=frozen.sourceFiles.find(row=>row.kind==='claude').filePath;
const mapping=frozen.mappings.find(row=>source.startsWith(row.original));
const file=path.join(mapping.copy,path.relative(mapping.original,source));
const original=fs.statSync(file);
const databaseFile=path.join(baseDir,'quota-branch-'+process.pid+'.sqlite');
fs.copyFileSync(frozen.database,databaseFile,fs.constants.COPYFILE_EXCL);
const result={scenario:'Synthetic metadata transition removes all selectable Codex sources during a quota auto-check; second request uses real server',requests:[],frames:[],errors:[]};
const server=createUsageServer({...frozen.options,databaseFile,pricingFile:path.join(baseDir,'home/.codex-usage/pricing.json'),automaticPricingFile:path.join(baseDir,'home/.codex-usage/pricing-auto.json'),pricingRefreshSchedulerEnabled:false,automaticDiscoveryEnabled:false});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
let browser;
try {
 browser=await chromium.launch({headless:true,executablePath:'C:/Users/Silver/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe'});
 const page=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'Asia/Shanghai'});
 await page.route('**/api/pricing/refresh',route=>route.fulfill({status:200,contentType:'application/json',body:'{"changed":false,"statusChanged":false,"errors":[],"issues":[]}'}));
 await page.addInitScript(()=>{
  window.__frames=[];
  const interval=window.setInterval;
  window.setInterval=(callback,ms,...args)=>{if(ms===60000)window.__autoCheck=callback;return interval(callback,ms,...args);};
  document.addEventListener('DOMContentLoaded',()=>{let last='';new MutationObserver(()=>{
   const value={at:Date.now(),busy:document.querySelector('#autoRefreshSpinner')?.classList.contains('is-loading')||false,total:document.querySelector('#totalTokens')?.title||'',output:document.querySelector('#outputTokens')?.title||'',outputText:document.querySelector('#outputTokens')?.textContent||''};
   const key=JSON.stringify([value.busy,value.total,value.outputText]);if(key===last)return;last=key;
   requestAnimationFrame(()=>requestAnimationFrame(()=>window.__frames.push({...value,frameAt:Date.now()})));
  }).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','title']});});
 });
 page.on('request',request=>{const url=new URL(request.url());if(['/api/usage','/api/status'].includes(url.pathname))result.requests.push({type:'request',at:Date.now(),path:url.pathname,preset:url.searchParams.get('preset'),skipCheck:url.searchParams.get('skipCheck')});});
 page.on('response',response=>{const url=new URL(response.url());if(['/api/usage','/api/status'].includes(url.pathname))result.requests.push({type:'response-headers',at:Date.now(),path:url.pathname,preset:url.searchParams.get('preset'),status:response.status()});});
 page.on('pageerror',error=>result.errors.push(error.message));
 await page.goto(base,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>/^\d/.test(document.querySelector('#totalTokens')?.title||''),{},{timeout:120000});
 const before=Number((await page.locator('#totalTokens').getAttribute('title')).replaceAll(',',''));
 result.beforeOutputText=await page.locator('#outputTokens').textContent();
 fs.appendFileSync(file,'\n'+JSON.stringify(promptRow(Date.now()-1000,'quota-diagnostic'))+'\n'+JSON.stringify(assistantRow({ts:Date.now(),sessionId:'quota-diagnostic',messageId:randomUUID(),model:'deepseek-flash',inputTokens:100,outputTokens:1000007,stopReason:'end_turn'}))+'\n');
 let intercepted=0;
 await page.route('**/api/usage?**',async route=>{
  if(!new URL(route.request().url()).searchParams.get('preset')?.startsWith('quota_'))return route.continue();
  intercepted++;assert.equal(intercepted,1);
  const response=await fetch(base+'/api/usage?view=dashboard&preset=today');assert.equal(response.status,200);
  const payload=await response.json();payload.metadata.homes=[];payload.metadata.imports=[];
  result.firstPayloadAt=Date.now();
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(payload)});
 });
 result.triggerAt=Date.now();
 await page.evaluate(async()=>{const {state}=await import('/app-state.js');state.preset='quota_5h';state.bucket='quota_30m';window.__autoCheck();});
 await page.waitForFunction(expected=>Number((document.querySelector('#totalTokens')?.title||'').replaceAll(',',''))===expected,before+1000107,{timeout:120000});
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 result.frames=await page.evaluate(()=>window.__frames);
 result.finalPreset=await page.evaluate(async()=>(await import('/app-state.js')).state.preset);
 result.finalTotal=Number((await page.locator('#totalTokens').getAttribute('title')).replaceAll(',',''));
 result.finalOutputText=await page.locator('#outputTokens').textContent();assert.notEqual(result.finalOutputText,result.beforeOutputText);
 assert.equal(result.finalPreset,'today');assert.equal(result.finalTotal-before,1000107);assert.equal(intercepted,1);
 assert.ok(result.requests.some(row=>row.type==='request'&&row.preset==='today'&&row.skipCheck==='1'&&row.at>result.triggerAt));
 result.nodeMaxRSSKiB=process.resourceUsage().maxRSS;
 await page.close();
}catch(error){result.failure={message:error.message,stack:error.stack};process.exitCode=1;}
finally{if(browser)await browser.close();await server.close();fs.truncateSync(file,original.size);fs.utimesSync(file,original.atime,original.mtime);fs.writeFileSync(path.join(outDir,'quota-branch-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
