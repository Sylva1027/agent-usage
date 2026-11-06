import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BASE = path.join(ROOT, "output/b3-mixed-history-20261107");
const label = process.env.B3_HISTORY_LABEL || "final-d";
assert.match(label,/^[a-z0-9-]+$/);
const RESULTS = path.join(BASE, "history", label);
const SCRIPT = fileURLToPath(import.meta.url);
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = async (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", flush: true });
const now = new Date("2026-11-06T12:00:00Z");

if (process.argv[2] === "prepare") {
  const { UsageStore } = await import("../../src/usage-store.js");
  const { createHistoryArchiveCandidate } = await import("../../src/history-archive.js");
  const dir = path.join(BASE, "history"); await mkdir(dir);
  const seed = path.join(ROOT, "output/opencode-regression-20261106/seed-state/usage-index.sqlite");
  // The preceding isolated seed contains the same frozen six-source corpus; no live index is read.
  assert.ok((await stat(seed)).isFile());
  const input = new DatabaseSync(seed, { readOnly: true });
  const bounds = input.prepare("SELECT MIN(timestamp_ms) AS min,MAX(timestamp_ms) AS max,COUNT(*) AS n FROM events").get();
  const edges = [Number(bounds.min)];
  for (let i = 1; i < 5; i++) edges.push(Number(input.prepare("SELECT timestamp_ms FROM events ORDER BY timestamp_ms LIMIT 1 OFFSET ?").get(Math.floor(Number(bounds.n) * i / 5)).timestamp_ms));
  edges.push(Number(bounds.max) + 1);
  assert.equal(new Set(edges).size, edges.length);
  const shapes = [];
  for (const [name, spans, revision] of [
    ["hot", [], false], ["one", [[edges[0],edges[4]]], false],
    ["four", edges.slice(0,4).map((edge,i) => [edge,edges[i+1]]), false],
    ["revised", null, true],
  ]) {
    const file = path.join(dir, `${name}.sqlite`);
    if (revision) await copyFile(shapes.find((shape) => shape.name === "four").file, file);
    else await backup(input,file);
    const store = new UsageStore({ databaseFile:file }); await store.open();
    const archives = [];
    if (!revision) {
      const candidates = [];
      for (const [index,[startMs,endMs]] of spans.entries()) {
        const candidate = path.join(dir, `${name}-${index}.sqlite`);
        await createHistoryArchiveCandidate(store.database,candidate,{startMs,endMs});
        candidates.push(candidate);
      }
      for (const candidate of candidates) {
        const registered = await store.registerHistoryArchiveCandidate(candidate);
        archives.push(registered.segmentId);
      }
      if (archives.length) {
        store.writeMeta("history_archive_event_authority",JSON.stringify({formatVersion:1,segmentIds:archives}));
        for (const [start,end] of spans) store.database.prepare("DELETE FROM events WHERE timestamp_ms>=? AND timestamp_ms<?").run(start,end);
      }
    } else {
      const record = store.database.prepare("SELECT * FROM archive_segments ORDER BY start_ms DESC LIMIT 1").get();
      const cold = new DatabaseSync(record.database_path,{readOnly:true});
      const rows = cold.prepare("SELECT * FROM events ORDER BY id LIMIT 2").all(); cold.close();
      const changes = new Map();
      for (const [index,row] of rows.entries()) {
        const sourceIdentity = {...store.database.prepare("SELECT path,kind,home_id,home_label,home_path FROM source_files WHERE path=?").get(row.source_path)};
        const entry = changes.get(row.source_path) ?? {segmentId:record.segment_id,databaseSha256:record.database_sha256,sourceIdentity,removed:[],added:[]};
        const {id,...payload} = row; entry.removed.push({payload,count:1});
        if (!index) entry.added.push({payload:{...payload,total:Number(payload.total)+17,input:Number(payload.input)+17},count:1});
        changes.set(row.source_path,entry);
      }
      store.writeMeta("history_archive_event_revisions",JSON.stringify({formatVersion:1,revisions:[...changes.values()]}));
    }
    const segments = store.database.prepare("SELECT * FROM archive_segments ORDER BY start_ms").all();
    store.database.exec("PRAGMA wal_checkpoint(TRUNCATE)"); store.close();
    shapes.push({name,file,segments,revision});
  }
  input.close();
  const start = new Date(edges[3]).toISOString().slice(0,10),end = new Date(edges[5]-1).toISOString().slice(0,10);
  await save(path.join(dir,"fixtures.json"),{bounds,edges,shapes,custom:{preset:"custom",startDate:start,endDate:end},now:now.toISOString()});
  console.log(JSON.stringify({prepared:true,events:bounds.n,shapes:shapes.length,start,end}));
} else if (process.argv[2] === "measure") {
  const [variant,name,scope] = process.argv.slice(3);
  const fixture = await json(path.join(BASE,"history/fixtures.json"));
  const shape = fixture.shapes.find((item) => item.name===name); assert.ok(shape);
  const dir = path.join(RESULTS,`${name}-${scope}-${variant}`); await mkdir(dir);
  const file = path.join(dir,"query.sqlite"); await copyFile(shape.file,file);
  let verifiedBytes = 0;
  const packages = new Set(shape.segments.map((record) => path.resolve(record.database_path)));
  const original = fs.createReadStream;
  fs.createReadStream = function(file,...args) {
    const stream = original.call(this,file,...args);
    if (packages.has(path.resolve(String(file)))) stream.on("data", (chunk) => {verifiedBytes+=chunk.length;});
    return stream;
  }; syncBuiltinESMExports();
  const source = path.join(BASE,"versions",variant === "oracle" ? "baseline" : variant);
  const {UsageStore} = await import(pathToFileURL(path.join(source,"src/usage-store.js")));
  const store = new UsageStore({databaseFile:file});
  const filters={...(scope==="all"?{preset:"all"}:fixture.custom),calendarZone:"utc",now:new Date(fixture.now)};
  const started = performance.now(); await store.open(); const opened = performance.now();
  try {
    const result = await store.dashboardHistory(filters,{includeDetails:false});
    const completed = performance.now();
    const usage = process.resourceUsage();
    await save(path.join(dir,"response.json"),result);
    await save(path.join(dir,"result.json"),{variant,name,scope,passed:true,openMs:opened-started,queryMs:completed-opened,
      totalMs:completed-started,maxRssMiB:usage.maxRSS/1024,memory:process.memoryUsage(),cpuMicros:usage.userCPUTime+usage.systemCPUTime,
      fsRead:usage.fsRead,fsWrite:usage.fsWrite,verifiedBytes,work:store.lastHistoryQueryWork??null,events:result.metadata.eventCount,
      heapsMiB:{old:Number(process.execArgv.find(arg=>arg.startsWith("--max-old-space-size="))?.split("=")[1] ?? 0),semi:4},node:process.version});
  } finally {store.close();}
} else if (process.argv[2] === "matrix") {
  const fixture=await json(path.join(BASE,"history/fixtures.json")); const results=[]; await mkdir(RESULTS,{recursive:true});
  for (const [index,shape] of fixture.shapes.entries()) for (const scope of ["all","custom"])
    for (const variant of index%2?["candidate","baseline"]:["baseline","candidate"]) {
      const name=`${shape.name}-${scope}-${variant}`;
      const result=await new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,["--max-old-space-size=224","--max-semi-space-size=4",SCRIPT,"measure",variant,shape.name,scope],{cwd:ROOT,windowsHide:true,stdio:["ignore","pipe","pipe"]});
        let log=""; child.stdout.on("data",(chunk)=>{log+=chunk;});child.stderr.on("data",(chunk)=>{log+=chunk;});
        child.on("error",reject);child.on("exit",async(code,signal)=>{
          try {await save(path.join(RESULTS,`${name}-exit.json`),{code,signal,log});resolve({name,code,signal});}catch(error){reject(error);}
        });
      });results.push(result);console.log(JSON.stringify(result));
    }
  await save(path.join(RESULTS,"matrix-exits.json"),results);
 } else if (process.argv[2] === "oracle") {
  const fixture=await json(path.join(BASE,"history/fixtures.json"));
  for(const shape of fixture.shapes.filter(shape=>shape.segments.length)) {
    const baseline=await json(path.join(RESULTS,shape.name+'-custom-baseline-exit.json'));
    if(baseline.code===0) continue;
    const result=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,["--max-old-space-size=512","--max-semi-space-size=4",SCRIPT,"measure","oracle",shape.name,"custom"],{cwd:ROOT,windowsHide:true,stdio:["ignore","pipe","pipe"]});
      let log="";child.stdout.on("data",chunk=>{log+=chunk;});child.stderr.on("data",chunk=>{log+=chunk;});
      child.on("error",reject);child.on("exit",(code,signal)=>resolve({code,signal,log}));
    });
    await save(path.join(RESULTS,shape.name+'-custom-oracle-exit.json'),result);
    assert.equal(result.code,0,'expanded-heap correctness oracle must complete');
    console.log(JSON.stringify({oracle:shape.name,code:result.code,oldSpaceMiB:512,performanceSample:false}));
  }
} else if (process.argv[2] === "analyze") {
  const fixture=await json(path.join(BASE,"history/fixtures.json"));const rows=[];
  for(const shape of fixture.shapes) for(const scope of ["all","custom"]){
    const pair={shape:shape.name,scope};
    for(const variant of ["baseline","candidate"]){
      const name=`${shape.name}-${scope}-${variant}`,exit=await json(path.join(RESULTS,`${name}-exit.json`));
      if(exit.code!==0) { assert.equal(exit.code,134,"only confirmed heap exhaustion is an accepted old-control failure"); assert.match(exit.log,/heap out of memory/); }
      pair[variant]=exit.code===0?await json(path.join(RESULTS,name,"result.json")):{failed:true,code:exit.code,signal:exit.signal};
    }
    assert.equal(pair.candidate.failed,undefined,`${shape.name}/${scope} candidate must complete`);
    assert.ok(pair.candidate.maxRssMiB<=512,"isolated query exceeds the memory ceiling");
    if(!pair.baseline.failed){
      const before=await json(path.join(RESULTS,`${shape.name}-${scope}-baseline/response.json`));
      const after=await json(path.join(RESULTS,`${shape.name}-${scope}-candidate/response.json`));
      assert.deepEqual(after,before,`${shape.name}/${scope} exact business parity`);pair.exactParity=true;
    }else {
      const name=shape.name+'-'+scope+'-oracle',exit=await json(path.join(RESULTS,name+'-exit.json'));
      assert.equal(exit.code,0);const before=await json(path.join(RESULTS,name,'response.json'));
      const after=await json(path.join(RESULTS,shape.name+'-'+scope+'-candidate','response.json'));
      assert.deepEqual(after,before,shape.name+'/'+scope+' expanded-heap correctness oracle');
      pair.exactParity=true;pair.oracle=await json(path.join(RESULTS,name,'result.json'));
    }
    rows.push(pair);
  }
  await save(path.join(RESULTS,"analysis.json"),{rows});console.log(JSON.stringify({rows:rows.length,completed:rows.filter(row=>!row.candidate.failed).length,exactParity:rows.filter(row=>row.exactParity).length}));
} else throw Error("prepare | matrix | oracle | measure <variant> <shape> <scope> | analyze");
