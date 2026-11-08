import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { compactHistoryDatabase, compareHistoryDatabases as compareDatabases } from "../../src/history-compact.js";
import { correctResourceIdentity, parseResourceSample } from "./resource-identity-analysis.mjs";

const ROOT = path.resolve("output/archive-compaction-20261108");
const WORK = path.join(ROOT, "stage-a");
const SOURCE = path.resolve("output/c1-long-history-20261107/datasets/two-years/archive-build/segment-0.sqlite");
const save = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });

export { compareHistoryDatabases as compareDatabases } from "../../src/history-compact.js";

async function worker() {
  const sha = [];
  registerHooks({ load(url, context, next) {
    const loaded = next(url, context);
    if (!url.endsWith("/src/history-backup.js")) return loaded;
    let source = String(loaded.source);
    const start = "async function hashFile(file) {", end = 'return { bytes, sha256: hash.digest("hex") };';
    assert.equal(source.split(start).length, 2); assert.equal(source.split(end).length, 2);
    source=source.replace(start, `${start}\n const measuredAt = performance.now();`)
      .replace(end, `const result = { bytes, sha256: hash.digest("hex") }; globalThis.__archiveCompactionSha.push({file,ms:performance.now()-measuredAt,...result}); return result;`);
    return { ...loaded, source };
  }});
  globalThis.__archiveCompactionSha=sha;
  const { verifyHistoryArchiveCandidate } = await import("../../src/history-archive.js");
  const { createHistoryBackup } = await import("../../src/history-backup.js");
  const { serviceTierEvidenceFromSnapshot } = await import("../../src/service-tier-evidence.js");
  const phases=[];
  const phase=async(name, work) => {
    process.send?.({phase:name}); const begin=performance.now(), cpu=process.cpuUsage(), hashAt=sha.length;
    const value=await work();
    phases.push({name,ms:performance.now()-begin,cpu:process.cpuUsage(cpu),sha:sha.slice(hashAt),resources:process.resourceUsage()});
    await save(path.join(WORK,`${name}.json`), {phase:phases.at(-1),value}); return value;
  };
  const old = await phase("old-verification",()=>verifyHistoryArchiveCandidate(SOURCE));
  const scratch=path.join(WORK,"compact-work.sqlite"), final=path.join(WORK,"segment-0.sqlite");
  await phase("construction", async()=> {
    const result=await compactHistoryDatabase(SOURCE,scratch);
    const db=new DatabaseSync(scratch,{readOnly:true});
    try { await createHistoryBackup(db,final,{pricingCatalog:old.manifest.pricing.catalog,
      serviceTierEvidence: old.manifest.serviceTierEvidence ? serviceTierEvidenceFromSnapshot(old.manifest.serviceTierEvidence.snapshot) : null}); }
    finally { db.close(); }
    await rm(scratch); return result;
  });
  await phase("new-verification",()=>verifyHistoryArchiveCandidate(final));
  const tables=await phase("exact-parity",()=>compareDatabases(SOURCE,final));
  const originalBytes=(await stat(SOURCE)).size, compactBytes=(await stat(final)).size;
  const sum=(name)=>phases.find(row=>row.name===name).sha.reduce((n,row)=>n+row.ms,0);
  assert.equal(phases[0].sha.length,2); assert.equal(phases[2].sha.length,2);
  const result={source:SOURCE,final,originalBytes,compactBytes,sizeRatio:compactBytes/originalBytes,
    oldShaMs:sum("old-verification"),newShaMs:sum("new-verification"),shaRatio:sum("new-verification")/sum("old-verification"),
    phases,exactTables:tables.length,exactRows:tables.reduce((n,row)=>n+row.rows,0),pid:process.pid,resources:process.resourceUsage(),
    gates:{exact:true,size:compactBytes/originalBytes<=0.6,sha:sum("new-verification")/sum("old-verification")<=0.65}};
  await save(path.join(WORK,"result.json"),result); process.send?.({done:true});
}

async function run() {
  assert(!existsSync(WORK),"stage A already exists; do not overwrite a trial"); await mkdir(WORK);
  const temp=path.join(WORK,"tmp"); await mkdir(temp);
  const child=fork(fileURLToPath(import.meta.url),["worker"],{execArgv:["--max-old-space-size=224","--max-semi-space-size=4"],stdio:["ignore","inherit","inherit","ipc"],windowsHide:true,env:{...process.env,TEMP:temp,TMP:temp}});
  const childExit=new Promise(resolve=>child.on("exit",(code,signal)=>resolve({code,signal})));
  child.on("message",message=>console.log(JSON.stringify(message)));
  const stop=path.join(WORK,"sampler.stop");
  const sampler=spawn("pwsh",["-NoProfile","-File",path.resolve("experiments/architecture-20261101/b2-attribution-resource.ps1"),
    "-ResultDir",WORK,"-ServicePid",String(child.pid),"-RunnerPid",String(process.pid),"-StopFile",stop,"-StateDir",WORK,"-TempDir",temp,"-SampleIntervalMilliseconds","250"],{stdio:["ignore","inherit","inherit"],windowsHide:true});
  const samplerExit=new Promise(resolve=>sampler.on("exit",code=>resolve(code)));
  try {
    const deadline=Date.now()+30000;
    while (!existsSync(path.join(WORK,"resources.ndjson")) || statSync(path.join(WORK,"resources.ndjson")).size===0) {
      assert(Date.now()<deadline && sampler.exitCode===null,"resource sampler failed to start");
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    child.send("start"); const exit=await childExit; assert.equal(exit.code,0,JSON.stringify(exit));
  } finally {
    if(child.exitCode===null) child.kill();
    await writeFile(stop,"stop"); assert.equal(await samplerExit,0,"resource sampler failed");
  }
  const corrections=[];
  const samples=(await readFile(path.join(WORK,"resources.ndjson"),"utf8")).trim().split(/\r?\n/).map(line=>{
    const result=correctResourceIdentity(parseResourceSample(line)); corrections.push(...result.excluded); return result.sample;
  });
  const result=JSON.parse(await readFile(path.join(WORK,"result.json"),"utf8"));
  const max=(field)=>Math.max(...samples.map(row=>row.service[field]||0));
  const peakBytes=Math.max(max("workingSetBytes"),max("reportedPeakWorkingSetBytes"),result.resources.maxRSS*1024);
  result.observed={peakBytes,logicalReadBytes:max("logicalReadBytes"),logicalWriteBytes:max("logicalWriteBytes"),excluded:corrections};
  result.gates.memory=peakBytes<=512*1024**2;result.passed=Object.values(result.gates).every(Boolean);
  await save(path.join(WORK,"gate.json"),result);console.log(JSON.stringify({gates:result.gates,passed:result.passed,sizeRatio:result.sizeRatio,shaRatio:result.shaRatio,peakBytes}));
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv[2]==="worker") process.once("message",()=>worker().then(()=>process.disconnect()).catch(error=>{console.error(error);process.exitCode=1;process.disconnect();}));
  else if(process.argv[2]==="run") await run();
  else throw new Error("expected run or worker");
}
