import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serverOptions, waitForServer, stopServer, openPage, painted } from './b2-page-diagnostic.mjs';

const root=path.resolve('output/architecture-20261104/q4/page-smoke-'+process.argv[2]);
assert.match(process.argv[2]||'',/^[a-z0-9-]+$/);await mkdir(root);
const home=path.join(root,'home'),stateDirectory=path.join(home,'.codex-usage');
await mkdir(path.join(home,'.codex/sessions'),{recursive:true});await mkdir(stateDirectory);
const raw=path.join(home,'.codex/sessions/smoke.jsonl');
await copyFile('output/architecture-20261104/q4/recovery/q4-20261104-b/facts-before-commit/usage.jsonl',raw);
const prepared={home,stateDirectory,databaseFile:path.join(stateDirectory,'usage-index.sqlite'),
  importStoreFile:path.join(stateDirectory,'imports.json'),pricingFile:path.join(stateDirectory,'pricing.json'),
  automaticPricingFile:path.join(stateDirectory,'pricing-auto.json')};
const shutdownToken='q4-smoke-'+process.pid,configFile=path.join(root,'config.json');
await writeFile(configFile,JSON.stringify({gatewayHeapMb:512,executorHeapMb:224,options:serverOptions(prepared,shutdownToken)}));
const child=spawn(process.execPath,['--max-old-space-size=512','experiments/architecture-20261101/b2-page-diagnostic.mjs','--serve',configFile],
  {windowsHide:true,env:{...process.env,NODE_OPTIONS:''},stdio:['ignore','pipe','pipe']});
let page,server;
try {
  const ready=await waitForServer(child);server={child,ready,shutdownToken};
  page=await openPage(ready.url,root);assert.equal(page.all.total,321);
  const response=page.page.waitForResponse(async response=>{
    if(new URL(response.url()).pathname!=='/api/usage')return false;
    try{return (await response.json()).summary?.totals?.total===322;}catch{return false;}
  },{timeout:30000});
  const usage=n=>({total_tokens:n,input_tokens:n,cached_input_tokens:0,output_tokens:0,reasoning_output_tokens:0});
  await appendFile(raw,JSON.stringify({timestamp:'2026-11-04T01:06:00Z',type:'event_msg',
    payload:{type:'token_count',info:{total_token_usage:usage(322),last_token_usage:usage(1)}}})+'\n');
  assert.equal((await response).status(),200);await painted(page.page,322);assert.deepEqual(page.errors,[]);
  await writeFile(path.join(root,'result.json'),JSON.stringify({passed:true,totalBefore:321,totalAfter:322,errors:page.errors},null,2));
  console.log(JSON.stringify({passed:true,totalBefore:321,totalAfter:322}));
} finally {
  if(page)await page.browser.close();
  if(server)await stopServer(server,{});else if(child.exitCode===null)child.kill();
}
