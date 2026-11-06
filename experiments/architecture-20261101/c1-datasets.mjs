import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { generateLineInputs } from "./growth-line-inputs.mjs";
import { generateSqliteInputs } from "./growth-sqlite-inputs.mjs";
import { hashFile } from "./remaining-harness-delivery-prepare.mjs";

export const ROOT=fileURLToPath(new URL("../../",import.meta.url));
export const BASE=path.join(ROOT,"output/c1-long-history-20261107");
export const DAY=86400000;
export const KINDS=["codex","dsh","claude","workbuddy","zcode","opencode"];
const HOMES={codex:".codex",dsh:".dsh",claude:".claude",workbuddy:".workbuddy-ai",zcode:".zcode",opencode:".opencode"};
const family=kind=>["main","extra","jetbrains","codex"].includes(kind)?"codex":kind;
const key=value=>createHash("sha256").update(String(value)).digest("hex").slice(0,20);
export const read=async file=>JSON.parse(await readFile(file,"utf8"));
export async function save(file,value){await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value,null,2)+"\n",{flag:"wx",flush:true});}
export function inside(parent,file){const relative=path.relative(path.resolve(parent),path.resolve(file));return !!relative&&!relative.startsWith("..")&&!path.isAbsolute(relative);}

export async function diskBudget(requiredGiB=64){
  const info=await statfs(BASE,{bigint:true});const free=info.bavail*info.bsize;
  assert.ok(free>BigInt(requiredGiB)*1073741824n,`C1 needs ${requiredGiB} GiB free; has ${free} bytes`);
  return {freeBytes:Number(free),requiredGiB};
}

export function datasetOptions(home,state){return {homeDir:home,env:{},importDirs:[],
  extraHomes:"",extraZcodeHomes:"",extraDshHomes:"",extraOpencodeHomes:path.join(home,".opencode"),
  extraClaudeHomes:"",extraWorkbuddyHomes:"",automaticDiscoveryEnabled:false,pricingRefreshSchedulerEnabled:false,
  databaseFile:path.join(state,"usage-index.sqlite"),importStoreFile:path.join(state,"imports.json"),
  pricingFile:path.join(state,"pricing.json"),automaticPricingFile:path.join(state,"pricing-auto.json")};}

export function longPlan(profile,days){
  assert.ok(Number.isSafeInteger(days)&&days>=profile.days);
  const startMs=profile.endMs-days*DAY,lines=[];
  const referenceSpan=profile.days*DAY;
  for(let block=0;profile.endMs-block*referenceSpan>startMs;block++){
    const endMs=profile.endMs-block*referenceSpan;
    const blockStart=Math.max(startMs,endMs-referenceSpan);
    const ratio=(endMs-blockStart)/referenceSpan;
    for(const kind of KINDS.filter(kind=>!["zcode","opencode"].includes(kind))){
      const candidates=profile.files.filter(file=>file.kind===kind);
      const selected=ratio===1?candidates:[...candidates].sort((a,b)=>key(`${block}:${a.key}`).localeCompare(key(`${block}:${b.key}`))).slice(0,Math.max(1,Math.round(candidates.length*ratio)));
      for(const original of selected){
        const prefix=`b${String(block).padStart(3,"0")}`;
        const range=original.timeRange;
        const begin=blockStart+Math.floor((range.startMs-profile.startMs)*ratio);
        const end=Math.min(endMs-1,blockStart+Math.floor((range.endMs-profile.startMs)*ratio));
        lines.push({...original,key:prefix+original.key,sessionKey:`${prefix}:${original.sessionKey}`,
          timeRange:{startMs:Math.min(begin,endMs-2),endMs:Math.max(Math.min(begin,endMs-2)+1,end)}});
      }
    }
  }
  const ratio=days/profile.days;
  const sqlite=profile.files.filter(file=>["zcode","opencode"].includes(file.kind)).map(file=>({...file,
    events:Math.max(1,Math.round(file.events*ratio)),sessions:Math.max(1,Math.round(file.sessions*ratio)),
    sourceBytes:Math.ceil(file.sourceBytes*ratio)}));
  const totals=KINDS.map(kind=>{
    const files=lines.filter(file=>file.kind===kind);const sql=sqlite.find(file=>file.kind===kind);
    const events=sql?.events??files.reduce((sum,file)=>sum+file.events,0);
    const sessions=sql?.sessions??new Set(files.filter(file=>file.events).map(file=>file.sessionKey)).size;
    return {kind,events,sessions,files:sql?1:files.length,total:events*15,input:events*10,cached:events*2,output:events*5,reasoning:["dsh","claude"].includes(kind)?0:events};
  });
  return {days,startMs,endMs:profile.endMs,lines,sqlite,expected:totals,
    expectedQuota:lines.reduce((sum,file)=>sum+(file.kind==="codex"?file.quotaObservations:0),0),
    expectedFiles:lines.length+sqlite.length,
    expectedSessions:totals.reduce((sum,item)=>sum+item.sessions,0),
    decodedBytes:lines.reduce((sum,file)=>sum+file.decodedBytes,0),
    sourceBytesEstimate:lines.reduce((sum,file)=>sum+file.sourceBytes,0)+sqlite.reduce((sum,file)=>sum+file.sourceBytes,0)};
}

export async function preflight(){
  await mkdir(BASE,{recursive:true});const disk=await diskBudget(320);
  const source=await read(path.join(ROOT,"output/architecture-20261103/growth-baseline/profile.json"));
  const capture=await read(source.captureFile);
  const db=new DatabaseSync(path.join(ROOT,"output/b3-mixed-history-20261107/seed-state/usage-index.sqlite"),{readOnly:true});
  try{
    const bounds=db.prepare("SELECT MIN(timestamp_ms) min,MAX(timestamp_ms) max,COUNT(*) events FROM events").get();
    const startMs=Math.floor(Number(bounds.min)/DAY)*DAY,endMs=(Math.floor(Number(bounds.max)/DAY)+1)*DAY;
    const homes=new Map(db.prepare("SELECT kind,home_path FROM source_files GROUP BY kind,home_path").all().map(row=>[family(row.kind),row.home_path]));
    const boundsFor=db.prepare("SELECT MIN(timestamp_ms) min,MAX(timestamp_ms) max,COUNT(DISTINCT repository_key) projects FROM events WHERE source_path=?");
    const projectFor=db.prepare("SELECT repository_key,COUNT(*) n FROM events WHERE source_path=? GROUP BY repository_key ORDER BY n DESC,repository_key LIMIT 1");
    const files=source.files.map(file=>{
      const relative=path.relative(file.originalHome,file.logicalPath);assert.ok(relative&&!relative.startsWith("..")&&!path.isAbsolute(relative));
      const mirrored=path.join(homes.get(file.kind),relative);const bounds=boundsFor.get(mirrored);
      return {...file,frames:file.compressed&&file.kind!=="dsh"?1:file.frames,
        projectKey:key(projectFor.get(mirrored)?.repository_key??`${file.kind}:unknown`),projects:Math.max(1,Number(bounds.projects)),
        timeRange:{startMs:bounds.min===null?startMs:Number(bounds.min),endMs:bounds.max===null?endMs-1:Math.max(Number(bounds.min)+1,Number(bounds.max))}};
    });
    const expected=db.prepare(`SELECT s.kind,COUNT(e.id) events,COUNT(DISTINCT e.session_id) sessions,
      SUM(e.total) total,SUM(e.input) input,SUM(e.cached) cached,SUM(e.output) output,SUM(e.reasoning) reasoning,
      COUNT(DISTINCT s.path) files FROM source_files s LEFT JOIN events e ON s.path=e.source_path GROUP BY s.kind`).all().map(row=>({...row,kind:family(row.kind)}));
    const profile={sourceProfile:path.join(ROOT,"output/architecture-20261103/growth-baseline/profile.json"),
      captureFile:source.captureFile,captureDirectory:capture.captureDirectory,days:(endMs-startMs)/DAY,startMs,endMs,
      expected,expectedEvents:Number(bounds.events),expectedSessions:expected.reduce((sum,row)=>sum+row.sessions,0),
      expectedQuota:Number(db.prepare("SELECT COUNT(*) n FROM rate_limit_observations").get().n),files};
    assert.equal(profile.days,49);assert.equal(profile.expectedEvents,146412);assert.equal(profile.expectedSessions,1729);
    await save(path.join(BASE,"profile.json"),profile);
    const year=longPlan(profile,365),two=longPlan(profile,730);
    await save(path.join(BASE,"plan-year.json"),year);await save(path.join(BASE,"plan-two-years.json"),two);
    const summary={baseline:"d31c3e0",createdAt:new Date().toISOString(),disk,sourceProfileDays:profile.days,
      budgets:{prepGiB:256,freeReserveGiB:64,gatewayOldMiB:512,executorOldMiB:224,executorSemiMiB:4,serviceTreePeakMiB:512},
      datasets:[{label:"current",days:49,events:146412,sessions:1729,files:1968,archivePackages:1},
        ...[["year",year],["two-years",two]].map(([label,plan])=>({label,days:plan.days,events:plan.expected.reduce((sum,row)=>sum+row.events,0),sessions:plan.expectedSessions,files:plan.expectedFiles,
          sourceBytesEstimate:plan.sourceBytesEstimate,decodedBytes:plan.decodedBytes,archivePackages:Math.ceil((plan.days-30)/90)}))]};
    await save(path.join(BASE,"preflight.json"),summary);console.log(JSON.stringify(summary));
  }finally{db.close();}
}

export async function generate(label){
  assert.ok(["current","year","two-years","tiny"].includes(label));await diskBudget();
  const profile=await read(path.join(BASE,"profile.json"));const root=path.join(BASE,"datasets",label),home=path.join(root,"home");
  await assert.rejects(stat(root),{code:"ENOENT"});await mkdir(home,{recursive:true});
  let files=[],expected,expectedQuota,expectedSessions,days,startMs,endMs;
  if(label==="current"){
    const capture=await read(profile.captureFile);days=profile.days;startMs=profile.startMs;endMs=profile.endMs;
    for(const [index,file] of capture.files.entries()){
      const kind=family(file.sourceKind),relative=path.relative(file.sourceHomePath,file.logicalPath);
      assert.ok(relative&&!relative.startsWith("..")&&!path.isAbsolute(relative));const target=path.join(home,HOMES[kind],relative);
      await mkdir(path.dirname(target),{recursive:true});await copyFile(path.join(capture.captureDirectory,file.capturedPath),target);
      if(file.storageType==="sqlite"){const db=new DatabaseSync(target);try{db.exec("PRAGMA journal_mode=DELETE");}finally{db.close();}}
      files.push({kind,path:target,role:file.role,sourceBytes:(await stat(target)).size,compressed:file.logicalPath.endsWith(".zst")||kind==="dsh"});
      if(index%250===0)console.log(JSON.stringify({label,copied:index+1,total:capture.files.length}));
    }
    expected=profile.expected;expectedQuota=profile.expectedQuota;expectedSessions=profile.expectedSessions;
  }else{
    let plan=label==="tiny"?longPlan(profile,49):await read(path.join(BASE,`plan-${label}.json`));
    if(label==="tiny"){
      plan={...plan,lines:KINDS.filter(kind=>!["zcode","opencode"].includes(kind)).map(kind=>{
        const file=plan.lines.find(file=>file.kind===kind&&file.events);return {...file,events:4,rows:16,decodedBytes:16000,sourceBytes:12000,compressed:kind==="dsh",frames:kind==="dsh"?2:0,quotaObservations:kind==="codex"?5:0};
      }),sqlite:plan.sqlite.map(file=>({...file,events:8,sessions:4,projects:2,sourceBytes:131072})),expected:[],expectedQuota:5,expectedSessions:12};
      plan.expected=KINDS.map(kind=>{const events=["zcode","opencode"].includes(kind)?8:4;return {kind,events,sessions:events===8?4:1,files:1,total:events*15,input:events*10,cached:events*2,output:events*5,reasoning:["dsh","claude"].includes(kind)?0:events};});
    }
    ({days,startMs,endMs,expected,expectedQuota,expectedSessions}=plan);
    const lines=await generateLineInputs({root:home,scale:1,files:plan.lines,onProgress:(file,index,total)=>{
      if(index%200===0||index===total-1)console.log(JSON.stringify({label,generated:index+1,total,kind:file.kind}));
    }});
    files.push(...lines.files.map(file=>({...file,role:"usage-file"})));
    const sqlite=await generateSqliteInputs({root:home,scale:1,files:plan.sqlite,timeRange:{startMs,endMs:endMs-1},sessionOrder:"contiguous"});
    files.push(...sqlite.map(file=>({...file,path:path.join(home,file.relativePath),role:"usage-file",events:file.eventCount})));
  }
  for(const file of files)file.sha256=await hashFile(file.path);
  const state=path.join(root,"state-hot");await mkdir(state,{recursive:true});
  const dataset={label,root,home,state,options:datasetOptions(home,state),days,startMs,endMs,expected,expectedQuota,expectedSessions,
    expectedFiles:files.filter(file=>file.role==="usage-file").length,files,synthetic:label!=="current",
    sourceBytes:files.reduce((sum,file)=>sum+file.sourceBytes,0),completedAt:new Date().toISOString()};
  await save(path.join(root,"dataset.json"),dataset);console.log(JSON.stringify({label,complete:true,files:files.length,events:expected.reduce((sum,row)=>sum+row.events,0),sourceBytes:dataset.sourceBytes}));return dataset;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv[2]==="preflight")await preflight();else if(process.argv[2]==="generate")await generate(process.argv[3]);else throw Error("preflight | generate <current|year|two-years|tiny>");
}
