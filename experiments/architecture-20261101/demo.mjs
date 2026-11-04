import { mkdir, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { makeFixture } from './fixture.mjs';
import { ROOT, launch, request } from './runner.mjs';

const { values } = parseArgs({ options: { variant:{type:'string',default:'node-sqlite'}, fixture:{type:'string'}, port:{type:'string',default:'0'}, core:{type:'boolean'}, directory:{type:'string'} } });
const directory=path.resolve(values.directory || path.join('output/architecture-20261101/demo',values.variant+'-'+Date.now()));
await mkdir(directory,{recursive:true});
const fixture=values.fixture?JSON.parse(await readFile(values.fixture,'utf8')):makeFixture();
let engine, gateway, closing=false;
async function stop(){if(closing)return;closing=true;gateway?.kill();await engine?.stop();}
try{
  engine=await launch(values.variant,directory);
  for(let at=0;at<fixture.events.length;at+=10_000)await request(engine.baseUrl,'/api/commit',{
    sourceId:fixture.sourceId+'-'+at,events:fixture.events.slice(at,at+10_000),cursor:{end:at+10_000},...(at===0?{context:fixture.context}:{})});
  if(values.core){console.log(JSON.stringify({url:engine.baseUrl,engine:engine.baseUrl,directory,variant:values.variant}));}
  else{
    gateway=spawn(process.execPath,[path.join(ROOT,'product-server.mjs'),'--backend',engine.baseUrl,'--port',values.port],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    gateway.stderr.on('data',bytes=>process.stderr.write(bytes));
    let pending='';
    gateway.stdout.on('data',bytes=>{pending+=bytes;const newline=pending.indexOf('\n');if(newline>=0){const state=JSON.parse(pending.slice(0,newline));pending=pending.slice(newline+1);console.log(JSON.stringify({url:'http://127.0.0.1:'+state.port,engine:engine.baseUrl,directory,variant:values.variant,productFormulaLayer:'shared Node'}));}});
    gateway.once('error',error=>{console.error(error);process.exitCode=1;void stop();});
    gateway.once('exit',()=>void stop());
  }
  for(const signal of['SIGINT','SIGTERM'])process.once(signal,()=>void stop());
  engine.child.once('exit',()=>{gateway?.kill();});
}catch(error){await stop();throw error;}
