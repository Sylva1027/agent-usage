import fs from "node:fs/promises";
import syncfs from "node:fs";
import path from "node:path";
import {fork,spawn} from "node:child_process";
import {pathToFileURL} from "node:url";
import assert from "node:assert/strict";
import {setTimeout as delay} from "node:timers/promises";
const exp=JSON.parse(await fs.readFile("output/rust-integration-20261030/experiment.json","utf8"));
const name=process.argv[2]||"profile-1";
const directory=path.join(exp.work,name);await fs.mkdir(directory,{recursive:true});
const config={...exp,sourceRoot:exp.profileRoot,options:{...exp.options,databaseFile:path.join(directory,"index.sqlite")},stageFile:path.join(exp.evidence,name+"-stages.jsonl"),hookFile:path.resolve("experiments/rust-integration-20261030/profile-hook.mjs")};
for(const suffix of ["","-wal","-shm",".summaries.sqlite",".summaries.sqlite-wal",".summaries.sqlite-shm"])await fs.rm(config.options.databaseFile+suffix,{force:true});
await fs.copyFile(exp.warmDatabase,config.options.databaseFile);await fs.writeFile(config.stageFile,"");
const configFile=path.join(directory,"config.json");await fs.writeFile(configFile,JSON.stringify(config));
const stateFile=path.join(directory,"state.json"),stopFile=path.join(directory,"stop");await fs.rm(stopFile,{force:true});
const state={case:name,phase:"startup",pids:[]};const save=()=>syncfs.writeFileSync(stateFile,JSON.stringify(state));save();
const sampleFile=path.join(exp.evidence,name+"-memory.jsonl");
const sampler=spawn("pwsh",["-NoProfile","-File",exp.sampler,"-StateFile",stateFile,"-OutputFile",sampleFile,"-StopFile",stopFile],{windowsHide:true,stdio:"ignore"});
const service=fork(path.resolve("docs/validation/2026-10-29-local-summary-adoption/probes/service.mjs"),[configFile],{execArgv:[...(process.env.RUST_PROFILE_GC==="1"?["--expose-gc"]:[]),"--max-old-space-size=128","--import",pathToFileURL(config.hookFile).href],env:{...process.env,LOCAL_SUMMARY_CASE_CONFIG:configFile},stdio:["ignore","ignore","pipe","ipc"]});
state.pids.push(service.pid);save();let stderr="";service.stderr.on("data",b=>stderr+=b);const events=[];
service.on("message",m=>{events.push({...m,at:performance.timeOrigin+performance.now(),phase:state.phase});if(m.type==="child-start")state.pids.push(m.pid);if(m.type==="child-exit")state.pids=state.pids.filter(p=>p!==m.pid);save();});
const exit=new Promise(resolve=>service.once("close",resolve));
const rows=[];
try{
 const base=await new Promise((resolve,reject)=>{service.once("exit",code=>reject(Error(code+" "+stderr)));service.on("message",m=>{if(m.type==="ready")resolve("http://127.0.0.1:"+m.port);});});
 for(const preset of ["today","all"]){state.phase=preset;save();const at=performance.now();const response=await fetch(base+"/api/usage?"+new URLSearchParams({preset,bucket:preset==="today"?"hour":"day",calendarZone:"local",view:"dashboard"}));const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));rows.push({preset,ms:performance.now()-at});await fs.writeFile(path.join(exp.evidence,name+"-"+preset+".json"),JSON.stringify(body));const until=performance.now()+10000;while(state.pids.length>1&&performance.now()<until)await delay(25);assert.equal(state.pids.length,1);}
}finally{
 service.send({type:"close"});await exit;state.pids=[];save();await fs.writeFile(stopFile,"stop");await new Promise(resolve=>sampler.exitCode!==null?resolve():sampler.once("close",resolve));await fs.writeFile(path.join(exp.evidence,name+"-events.json"),JSON.stringify(events));await fs.writeFile(path.join(exp.evidence,name+"-result.json"),JSON.stringify(rows));
}
console.log(JSON.stringify(rows));
