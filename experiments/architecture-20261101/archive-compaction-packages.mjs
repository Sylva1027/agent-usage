import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compactHistoryArchivePackage } from "../../src/history-archive-compaction.js";
import { ROOT, BASE, read, save, diskBudget } from "./c1-datasets.mjs";
import { hashFile } from "./remaining-harness-delivery-prepare.mjs";
import { verifyEntries } from "./persistent-history-prepare.mjs";
import { correctResourceIdentity, parseResourceSample } from "./resource-identity-analysis.mjs";

const HERE=path.dirname(fileURLToPath(import.meta.url)), RESULT=path.join(ROOT,"output/archive-compaction-20261108");

// A parked child lets the same sampler observe construction and explicit maintenance from their first instruction.
export async function measureChild(script,args,directory,state=directory) {
  await mkdir(directory,{recursive:true}); const temp=path.join(directory,"tmp");await mkdir(temp);
  const child=fork(script,args,{execArgv:["--max-old-space-size=224","--max-semi-space-size=4"],windowsHide:true,
    stdio:["ignore","inherit","inherit","ipc"],env:{...process.env,TEMP:temp,TMP:temp}});
  const childExit=new Promise(resolve=>child.once("exit",(code,signal)=>resolve({code,signal})));
  const stop=path.join(directory,"sampler.stop");
  const sampler=spawn("pwsh",["-NoProfile","-File",path.join(HERE,"b2-attribution-resource.ps1"),"-ResultDir",directory,
    "-ServicePid",String(child.pid),"-RunnerPid",String(process.pid),"-StopFile",stop,"-StateDir",state,"-TempDir",temp,
    "-SampleIntervalMilliseconds","250"],{windowsHide:true,stdio:["ignore","inherit","inherit"]});
  const samplerExit=new Promise(resolve=>sampler.once("exit",resolve));
  try {
    const deadline=Date.now()+30000;
    while(!existsSync(path.join(directory,"resources.ndjson"))||!statSync(path.join(directory,"resources.ndjson")).size){
      assert(Date.now()<deadline&&sampler.exitCode===null,"sampler unavailable");await new Promise(resolve=>setTimeout(resolve,100));
    }
    child.send("start");const exit=await childExit;assert.equal(exit.code,0,JSON.stringify(exit));
  } finally {
    if(child.exitCode===null)child.kill();await writeFile(stop,"stop");assert.equal(await samplerExit,0);
  }
  const excluded=[], samples=(await readFile(path.join(directory,"resources.ndjson"),"utf8")).trim().split(/\r?\n/).map(line=>{
    const row=correctResourceIdentity(parseResourceSample(line));excluded.push(...row.excluded);return row.sample;
  });
  const result=await read(path.join(directory,"work.json"));
  const peak=key=>Math.max(...samples.map(row=>row.service[key]||0));
  const peakBytes=Math.max(peak("workingSetBytes"),peak("reportedPeakWorkingSetBytes"),result.resourceUsage.maxRSS*1024);
  const observed={peakBytes,cpuSeconds:peak("cpuSeconds"),logicalReadBytes:peak("logicalReadBytes"),logicalWriteBytes:peak("logicalWriteBytes"),
    statePeakBytes:Math.max(...samples.map(row=>row.state.totalBytes||0)),tempPeakBytes:Math.max(...samples.map(row=>row.temp.totalBytes||0)),excluded};
  const evidence={...result,observed,passed:peakBytes<=512*1024**2};await save(path.join(directory,"result.json"),evidence);
  assert(evidence.passed,"maintenance exceeds 512 MiB");return evidence;
}

async function buildOne(source,destination,directory) {
  const started=performance.now(),cpu=process.cpuUsage();
  const built=await compactHistoryArchivePackage(source,destination);
  await save(path.join(directory,"work.json"),{...built,source,wallMs:performance.now()-started,cpu:process.cpuUsage(cpu),
    resourceUsage:process.resourceUsage(),originalBytes:(await stat(source)).size,compactBytes:(await stat(destination)).size});
}

async function build(validationFile) {
  const validation=await read(validationFile);assert.equal(validation.passed,true,"B must pass before more real packages");
  await verifyEntries(validation.code);await verifyEntries(validation.logs);
  const finalFile=path.join(RESULT,"packages.json");assert(!existsSync(finalFile),"packages already prepared");
  const oldManifest=await read(path.join(ROOT,"output/archive-verification-reuse-20261108/manifest.json"));
  const stageA=await read(path.join(RESULT,"stage-a/gate.json"));assert.equal(stageA.passed,true);
  const packages=[];
  for(const label of ["current","year","two-years"]){
    const input=oldManifest.datasets.find(row=>row.label===label);
    const archives=input.entries.filter(row=>/archive-build[\\/]segment-\d+\.sqlite$/.test(row.file));
    assert.equal(archives.length,{current:1,year:4,"two-years":8}[label]);
    for(const original of archives){
      const index=Number(/segment-(\d+)\.sqlite$/.exec(original.file)[1]);let destination,evidenceFile;
      await verifyEntries([original]);await diskBudget(64);
      if(label==="two-years"&&index===0){
        assert.equal(path.resolve(original.file),path.resolve(stageA.source));
        destination=stageA.final;evidenceFile=path.join(RESULT,"stage-a/gate.json");
      }else{
        const directory=path.join(RESULT,"packages",label,`segment-${index}`);
        assert(!existsSync(directory),"a previous package attempt must be reviewed, never silently rebuilt");
        destination=path.join(directory,`segment-${index}.sqlite`);evidenceFile=path.join(directory,"result.json");
        await measureChild(fileURLToPath(import.meta.url),["worker",original.file,destination,directory],directory);
      }
      const newSha=await hashFile(destination),newBytes=(await stat(destination)).size;
      if(label==="two-years"&&index===0)assert.equal(newSha,"6d0199a0b46bdc70bd619747989d959d9bb67dd2a272b312ff1f177652f26289");
      await verifyEntries([original]);
      const previous={databaseFile:original.file,sha256:original.sha256,bytes:(await stat(original.file)).size},
        next={databaseFile:destination,sha256:newSha,bytes:newBytes};
      const measurementFile=evidenceFile,measurement=await read(measurementFile);
      const tables=label==="two-years"&&index===0?(await read(path.join(RESULT,"stage-a/exact-parity.json"))).value:measurement.tables;
      assert(tables.length>0);evidenceFile=path.join(path.dirname(destination),"evidence.json");
      await save(evidenceFile,{passed:true,previous,next,tables,measurementFile,measurementSha256:await hashFile(measurementFile)});
      packages.push({label,index,previous,next,evidenceFile,evidenceSha256:await hashFile(evidenceFile)});
      console.log(JSON.stringify({label,index,bytes:newBytes,completed:packages.length}));
    }
  }
  assert.equal(packages.length,13);await save(finalFile,{passed:true,validationFile,validationSha256:await hashFile(validationFile),packages});
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]==="worker")process.once("message",()=>buildOne(...process.argv.slice(3)).then(()=>process.disconnect()).catch(error=>{
    console.error(error);process.exitCode=1;process.disconnect();
  }));
  else if(process.argv[2]==="build")await build(process.argv[3]);
  else throw Error("build <B-validation> | worker <source> <destination> <result-directory>");
}
