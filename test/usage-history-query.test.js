import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { UsageHistoryQuery } from "../src/usage-history-query.js";
import { createStoredQuotaSourceResolver } from "../src/usage-quota-source-store.js";

const canonical = (row, excluded) => Object.fromEntries(Object.keys(row).filter((key) => !excluded.includes(key)).sort().map((key) => [key, row[key]]));

test("captured quota ties preserve original rowids despite reversed unordered reads", () => {
  const source=new DatabaseSync(":memory:");let query;
  try {
    source.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,timestamp_ms INTEGER,source_path TEXT,value TEXT);
      CREATE TABLE quota_usage_sources(source_path TEXT,home_id TEXT,session_id TEXT,timestamp_ms INTEGER,quota_source TEXT,until_ms INTEGER,
        PRIMARY KEY(source_path,session_id,timestamp_ms));
      INSERT INTO quota_usage_sources(rowid,source_path,home_id,session_id,timestamp_ms,quota_source,until_ms)
        VALUES(100,'plan','home','session',10,'plan',0),(7,'credits','home','session',10,'credits',100);
      PRAGMA reverse_unordered_selects=ON`);
    const expected=createStoredQuotaSourceResolver(source,null)("home","session",20);
    assert.equal(expected,"plan");
    query=new UsageHistoryQuery(source,canonical);
    assert.equal(createStoredQuotaSourceResolver(query.database,null)("home","session",20),expected);
    assert.deepEqual(query.database.prepare("SELECT rowid FROM quota_usage_sources ORDER BY rowid").all().map(row=>row.rowid),[7,100]);
  } finally {query?.close();source.close();}
});

test("disk history ordering matches JS payload ordering for UTF-16 ties and duplicate ids", () => {
  const source = new DatabaseSync(":memory:");
  let query;
  try {
    source.exec("CREATE TABLE events(id INTEGER PRIMARY KEY,timestamp_ms INTEGER,source_path TEXT,value TEXT)");
    const rows = ["\ue000", "𐀀", "α", "😀"].map((value) => ({id:1,timestamp_ms:10,source_path:"source",value}));
    query = new UsageHistoryQuery(source, canonical);
    query.add(rows,"cold");
    const expected = rows.map((row) => JSON.stringify(canonical(row,["id"]))).sort().map((row) => JSON.parse(row).value);
    query.finish(["timestamp_ms","source_path","value"]);
    assert.deepEqual(query.database.prepare("SELECT value FROM events ORDER BY id").all().map((row) => row.value),expected);
    assert.equal(source.prepare("SELECT COUNT(*) AS n FROM events").get().n,0);
    assert.equal(source.isTransaction,false);
  } finally {query?.close();source.close();}
});

test("a large equal-timestamp group spills without changing exact payload order", () => {
  const source = new DatabaseSync(":memory:");
  let query;
  try {
    source.exec("CREATE TABLE events(id INTEGER PRIMARY KEY,timestamp_ms INTEGER,source_path TEXT,value TEXT)");
    query = new UsageHistoryQuery(source,canonical);
    function* rows() {
      for(let index=2999;index>=0;index--) yield {id:index,timestamp_ms:10,source_path:"source",value:`${String(index).padStart(6,"0")}${"x".repeat(800)}`};
    }
    query.database.exec("BEGIN");query.add(rows(),"cold");query.database.exec("COMMIT");
    query.finish(["timestamp_ms","source_path","value"]);
    assert.equal(query.database.prepare("SELECT COUNT(*) AS n FROM events").get().n,3000);
    assert.equal(query.database.prepare("SELECT value FROM events ORDER BY id LIMIT 1").get().value.slice(0,6),"000000");
    assert.equal(query.sortStats.spilled,true);
    assert.ok(query.sortStats.peakMemoryBytes<2*1048576+8192);
  } finally {query?.close();source.close();}
});

for(const finished of [false,true]) test(`killed disposable history ${finished?"after":"before"} materialization leaves no temp files`, async () => {
  const directory=await mkdtemp(path.join(os.tmpdir(),"usage-history-kill-"));
  const code=`
    import {DatabaseSync} from 'node:sqlite';
    import {UsageHistoryQuery} from ${JSON.stringify(new URL("../src/usage-history-query.js",import.meta.url).href)};
    const source=new DatabaseSync(':memory:');
    source.exec('CREATE TABLE events(id INTEGER PRIMARY KEY,timestamp_ms INTEGER,source_path TEXT,value TEXT)');
    const canonical=${canonical.toString()};
    const query=new UsageHistoryQuery(source,canonical);
    function* rows(){for(let i=0;i<8000;i++)yield {id:i,timestamp_ms:i,source_path:'source',value:'x'.repeat(800)};}
    query.database.exec('BEGIN');query.add(rows(),'cold');query.database.exec('COMMIT');
    ${finished?"query.finish(['timestamp_ms','source_path','value']);":""}
    process.send({ready:true,bytes:query.bytes});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);
  `;
  const child=spawn(process.execPath,["--input-type=module","-e",code],{windowsHide:true,env:{...process.env,TEMP:directory,TMP:directory,SQLITE_TMPDIR:directory},stdio:["ignore","ignore","pipe","ipc"]});
  let errors="";child.stderr.on("data",chunk=>{errors+=chunk;});
  try {
    const [message]=await Promise.race([once(child,"message"),once(child,"exit").then(()=>{throw Error(errors);})]);
    assert.equal(message.ready,true);assert.ok(message.bytes>2*1048576);
    const ended=once(child,"exit");child.kill("SIGKILL");await ended;
    assert.deepEqual(await readdir(directory),[]);
  } finally {if(child.exitCode===null&&!child.signalCode)child.kill();await rm(directory,{recursive:true,force:true});}
});
