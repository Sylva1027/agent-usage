import fs from 'node:fs/promises';
import path from 'node:path';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {pathToFileURL} from 'node:url';
const config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const originalFork=cp.fork;
cp.fork=function(file,args,options){
  const child=originalFork(file,args,options);
  if(String(file).endsWith('usage-executor.js')){
    process.send?.({type:'child-start',pid:child.pid,execArgv:child.spawnargs.slice(1)});
    child.once('exit',(code,signal)=>process.send?.({type:'child-exit',pid:child.pid,code,signal}));
  }
  return child;
};
syncBuiltinESMExports();
const {createUsageServer}=await import(pathToFileURL(path.join(config.sourceRoot,'src/server.js')).href);
const server=createUsageServer({...config.options,pricingRefreshSchedulerEnabled:false,automaticDiscoveryEnabled:false});
const memory=setInterval(()=>process.send?.({type:'memory',...process.memoryUsage()}),200);
process.on('message',async message=>{
  if(message.type==='close'){
    clearInterval(memory);
    await server.close();
    process.disconnect();
  }
});
server.listen(0,'127.0.0.1',()=>process.send?.({type:'ready',pid:process.pid,port:server.address().port}));
