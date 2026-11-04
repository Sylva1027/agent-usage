import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, launch, request, VARIANTS } from './runner.mjs';
import { makeFixture } from './fixture.mjs';

const modulePath=process.env.ARCH_PLAYWRIGHT_MODULE;
if(!modulePath)throw Error('Set ARCH_PLAYWRIGHT_MODULE to the installed playwright/index.mjs');
const {chromium}=await import(pathToFileURL(modulePath));
const directory=path.resolve(process.argv[2]||'output/architecture-20261101/browser');await mkdir(directory,{recursive:true});
await mkdir('output/playwright',{recursive:true});
const variants=process.argv.slice(3).length?process.argv.slice(3):VARIANTS;
const browser=await chromium.launch({headless:true,...(process.env.ARCH_CHROMIUM?{executablePath:process.env.ARCH_CHROMIUM}:{})});
const results=[];
try{for(const variant of variants){
 let engine,gateway,context;const errors=[];
 try{
  const run=path.join(directory,variant+'-'+Date.now());await mkdir(run,{recursive:true});engine=await launch(variant,run);const fixture=makeFixture();await request(engine.baseUrl,'/api/commit',fixture);
  context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(engine.baseUrl);await page.waitForFunction(()=>document.body.dataset.visibleRevision==='1');
  assert.equal(await page.locator('#total').innerText(),'41220');
  await Promise.all([page.waitForResponse(r=>r.url().includes('/api/query')),page.locator('#range').selectOption('today')]);await page.waitForFunction(()=>document.querySelector('#refresh').disabled===false);
  await page.locator('#range').selectOption('all');await page.waitForFunction(()=>document.querySelector('#total').textContent==='41220');
  await page.locator('#live').uncheck();await page.waitForFunction(()=>document.querySelector('#refresh').disabled===false);
  const replacement=structuredClone(fixture);replacement.events=[{...fixture.events[0],total:{input:1,cached:0,output:1,reasoning:0,total:2}}];
  await request(engine.baseUrl,'/api/commit',replacement);
  await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('#refresh').disabled===false);assert.equal(await page.locator('#total').innerText(),'41220');
  await page.locator('#live').check();await page.waitForFunction(()=>document.body.dataset.visibleRevision==='2');assert.equal(await page.locator('#total').innerText(),'2');
  await page.screenshot({path:path.resolve('output/playwright/architecture-'+variant+'.png'),fullPage:true});
  await request(engine.baseUrl,'/api/commit',fixture);
  gateway=spawn(process.execPath,[path.join(ROOT,'product-server.mjs'),'--backend',engine.baseUrl,'--port','0'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stderr='';gateway.stderr.on('data',b=>stderr+=b);
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('gateway timeout: '+stderr)),10000);gateway.once('error',reject);gateway.stdout.on('data',b=>{try{const ready=JSON.parse(b.toString().trim());clearTimeout(timer);resolve(ready.port);}catch{}});});
  await page.goto('http://127.0.0.1:'+port);await page.waitForFunction(()=>document.querySelector('#totalTokens')?.textContent!=='-');
  await Promise.all([page.waitForResponse(r=>r.url().includes('/api/usage')),page.locator('[data-preset="all"]').click()]);
  const productTotal=await page.locator('#totalTokens').innerText();assert.ok(productTotal&&productTotal!=='-');
  await Promise.all([page.waitForResponse(r=>r.url().includes('/api/usage')),page.locator('[data-preset="week"]').click()]);
  await Promise.all([page.waitForResponse(r=>r.url().includes('/api/usage')),page.locator('#autoRefreshToggle').click()]);
  assert.deepEqual(errors,[]);results.push({variant,passed:true,checks:['core-page-range-switch','frozen-refresh-keeps-version','resume-displays-new-commit','existing-product-page-all-week-freeze'],productTotal});
 }catch(error){results.push({variant,passed:false,error:error.stack,pageErrors:errors});}
 finally{await context?.close();gateway?.kill();await engine?.stop();}
 await writeFile(path.join(directory,'results.json'),JSON.stringify({passed:results.every(r=>r.passed),results},null,2));console.log(JSON.stringify(results.at(-1)));
}}finally{await browser.close();}
if(results.some(r=>!r.passed))process.exitCode=1;
