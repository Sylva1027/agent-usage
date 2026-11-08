import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { instrument } from "./windows-stability-hook.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const hook = new URL("./windows-stability-hook.mjs", import.meta.url).href;
const c1 = new URL("./c1-telemetry.mjs", import.meta.url).href;
const moduleUrl = file => pathToFileURL(path.join(root, file)).href;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture() {
  const directory = mkdtempSync(path.join(root, "output", "windows-stability-hook-tiny-"));
  const control = path.join(directory, "control"), trace = path.join(directory, "c1");
  mkdirSync(control); mkdirSync(trace);
  const cleanup = () => {
    // Resolve and check before recursive deletion on Windows.
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(root, "output"));
    assert.ok(path.basename(directory).startsWith("windows-stability-hook-tiny-"));
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  };
  return { directory, control, trace, cleanup };
}

function rows(directory) {
  return readdirSync(directory).filter(name => /^events-\d+\.ndjson$/.test(name)).flatMap(name =>
    readFileSync(path.join(directory, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
}

async function waitFor(check, description) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`tiny fixture timed out: ${description}`);
}

async function script(t, code, { enabled = true, telemetry = false, ipc = false } = {}) {
  const f = fixture(), file = path.join(f.directory, "fixture.mjs");
  writeFileSync(file, code);
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.CODEX_USAGE_EXECUTOR_CHILD;
  delete env.C1_BUSINESS_CLOCK_FILE;
  delete env.REMAINING_DELIVERY_TRACE;
  delete env.C1_ARCHIVE_TRACE;
  delete env.WINDOWS_STABILITY_CONTROL_DIR;
  if (enabled) env.WINDOWS_STABILITY_CONTROL_DIR = f.control;
  if (telemetry) env.REMAINING_DELIVERY_TRACE = f.trace;
  env.TEMP = env.TMP = path.join(f.directory, "temp");
  mkdirSync(env.TEMP);
  const execArgv = [...(telemetry ? ["--import", c1] : []), "--import", hook];
  const child = ipc ? fork(file, [], { execArgv, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] }) :
    spawn(process.execPath, [...execArgv, file], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "", stdout = "";
  const messages = [];
  child.stderr.on("data", data => { stderr += data; });
  child.stdout.on("data", data => { stdout += data; });
  child.on("message", message => messages.push(message));
  const ended = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    // A failed assertion must not leave a parked executor orphaned.
    for (const row of rows(f.control).filter(row => row.event === "executor-spawn")) {
      if (rows(f.control).some(exit => exit.event === "executor-exit" && exit.childPid === row.childPid)) continue;
      try { process.kill(row.childPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await ended;
    f.cleanup();
  });
  return { ...f, child, messages, ended,
    async done() { const exit = await ended; assert.equal(exit.code, 0, stderr); return { stdout, stderr }; },
    async message(type) { return waitFor(() => {
      const message = messages.find(item => item.type === type);
      if (!message) assert.equal(child.exitCode, null, stderr);
      return message;
    }, type); },
  };
}

test("disabled import is inert; all current anchors fail closed when changed", async t => {
  const f = await script(t, `import {UsageStore} from ${JSON.stringify(moduleUrl("src/usage-store.js"))};
    console.log(UsageStore.prototype.sync.name);`, { enabled: false });
  assert.match((await f.done()).stdout, /sync/);
  assert.deepEqual(readdirSync(f.control), []);
  for (const name of ["usage-store", "usage-executor", "usage-source-watch", "usage-history-projection-store", "server"]) {
    const url = moduleUrl(`src/${name}.js`), source = readFileSync(fileURLToPath(url), "utf8");
    assert.notEqual(instrument(url, source), source);
    assert.throws(() => instrument(url, "export const changed = true;"), /Windows stability/);
  }
  assert.equal(instrument("node:fs", null), null);
});

test("one command drops one debounced watch hint and releases retention", async t => {
  const f = await script(t, `
    import assert from 'node:assert/strict';
    import {writeFileSync} from 'node:fs';
    import path from 'node:path';
    import {createUsageSourceWatcher} from ${JSON.stringify(moduleUrl("src/usage-source-watch.js"))};
    const control=process.env.WINDOWS_STABILITY_CONTROL_DIR;
    writeFileSync(path.join(control,'drop-watch-hint.json'),JSON.stringify({id:'drop-1'}));
    let callback,tick,delivered=0,retained=0;
    const watcher=createUsageSourceWatcher({discoverRoots:async()=>[{path:control}],
      watchFile:(root,options,fn)=>{callback=fn;return {close(){},on(){}};},
      schedule:fn=>{tick=fn;return 1;},cancel(){},
      retainPending:()=>{retained++;return ()=>retained--;},onHint:()=>delivered++});
    await watcher.start();
    for(let i=0;i<2;i++){callback('change','source.jsonl');tick();await new Promise(resolve=>setImmediate(resolve));}
    assert.equal(delivered,1);assert.equal(retained,0);await watcher.stop();
  `);
  await f.done();
  const events = rows(f.control);
  assert.equal(events.filter(row => row.event === "watch-hint-dropped").length, 1);
  assert.equal(events.filter(row => row.event === "watch-hint").length, 1);
  assert.ok(readdirSync(f.control).includes("drop-watch-hint.drop-1.claimed.json"));
});

function executorScript() {
  return `
    import assert from 'node:assert/strict';
    import {mkdirSync,appendFileSync,writeFileSync} from 'node:fs';
    import path from 'node:path';
    import {fileURLToPath} from 'node:url';
    import {createUsageExecutor} from ${JSON.stringify(moduleUrl("src/usage-executor.js"))};
    const root=path.dirname(fileURLToPath(import.meta.url));
    const file=path.join(root,'.codex','sessions','tiny.jsonl');mkdirSync(path.dirname(file),{recursive:true});
    const token=n=>JSON.stringify({type:'event_msg',timestamp:'2026-11-09T01:00:0'+n+'Z',
      payload:{type:'token_count',info:{total_token_usage:{total_tokens:n*10,input_tokens:n*10},
      last_token_usage:{total_tokens:10,input_tokens:10}}}})+'\\n';
    writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:'tiny',cwd:root,source:'cli'}})+'\\n'+
      JSON.stringify({type:'turn_context',payload:{model:'gpt-6-sol'}})+'\\n'+token(1));
    const options={homeDir:root,env:{},importDirs:[],databaseFile:path.join(root,'index.sqlite'),automaticDiscoveryEnabled:false};
    const client=createUsageExecutor(options);const release=client.retainWorker();
    await client.sync({options});appendFileSync(file,token(2));
    process.send({type:'ready',executorPid:client.pid,file,databaseFile:options.databaseFile});
    process.on('message',async message=>{
      if(message.type==='sync'){
        try{await client.sync({options});process.send({type:'unexpected-success'});}
        catch(error){process.send({type:'sync-failed',code:error.code});}
      }
      if(message.type==='recover'){
        await client.sync({options});const report=await client.dashboard({preset:'all',calendarZone:'utc'},{includeDetails:false});
        assert.equal(report.summary.eventCount,2);assert.equal(report.summary.totals.total,20);
        release();process.send({type:'recovered'});
      }
      if(message.type==='close'){await client.close();process.disconnect();}
    });
  `;
}

for (const point of ["before-commit", "after-commit-before-notify"]) test(`${point}: real executor kill preserves the correct facts and recovers`, async t => {
  const f = await script(t, executorScript(), { telemetry: true, ipc: true });
  const ready = await f.message("ready");
  writeFileSync(path.join(f.control, "pause-sync.json"), JSON.stringify({ id: "kill-1", point,
    executorPid: ready.executorPid, sourcePath: ready.file }));
  f.child.send({ type: "sync" });
  const marker = await waitFor(() => {
    const events = rows(f.control), marker = events.find(row => row.event === "fault-parked");
    if (!marker && f.messages.some(row => ["unexpected-success", "sync-failed"].includes(row.type)))
      assert.fail(JSON.stringify({ messages: f.messages, events: events.slice(-18) }));
    return marker;
  }, point);
  assert.equal(marker.pid, ready.executorPid);
  assert.equal(marker.role, "executor");
  assert.equal(marker.point, point);
  assert.equal(marker.transaction, point === "before-commit");
  assert.ok(marker.cpu.user >= 0 && marker.usage.maxRSS > 0 && marker.memory.rss > 0);
  const db = new DatabaseSync(ready.databaseFile, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events").get().n, point === "before-commit" ? 1 : 2);
    assert.equal(db.prepare("SELECT SUM(total) n FROM events").get().n, point === "before-commit" ? 10 : 20);
  } finally { db.close(); }
  const childRows = rows(f.control).filter(row => row.pid === marker.pid);
  const start = childRows.findLastIndex(row => row.event === "sync-start");
  assert.ok(!childRows.slice(start).some(row => row.event === "ipc" && row.direction === "send" && ["state", "response"].includes(row.type)));
  process.kill(marker.pid, "SIGKILL");
  assert.equal((await f.message("sync-failed")).code, "EXECUTOR_EXITED");
  f.child.send({ type: "recover" });
  await f.message("recovered");
  await waitFor(() => rows(f.control).some(row => row.event === "process-exit" && row.role === "executor"), "normal idle exit");
  f.child.send({ type: "close" });
  await f.done();
  const events = rows(f.control);
  assert.equal(events.filter(row => row.event === "fault-parked").length, 1);
  assert.ok(events.some(row => row.event === "executor-exit" && row.childPid === marker.pid));
  assert.ok(events.some(row => row.event === "serial-end" && row.depth === 0));
  assert.ok(events.some(row => row.event === "request-finished" && row.depth === 0));
  assert.ok(events.some(row => row.event === "round-end" && row.updatedFiles === 1 && row.cpuDelta.user >= 0));
  assert.ok(events.filter(row => row.event === "process-born" && row.role === "executor").every(row => row.execArgv.includes(hook)));
  assert.ok(readdirSync(f.trace).some(name => /^sync-\d+\.ndjson$/.test(name)), "C1 sync telemetry retained");
  assert.ok(readdirSync(f.trace).some(name => /^node-\d+\.jsonl$/.test(name)), "C1 normal-exit resource telemetry retained");
});

test("tiny cold projection reports rebuild, zero-copy reuse, and actual ZCode net delta", async t => {
  const f = await script(t, `
    import assert from 'node:assert/strict';
    import {renameSync} from 'node:fs';
    import path from 'node:path';
    import {fileURLToPath} from 'node:url';
    import {DatabaseSync} from 'node:sqlite';
    import {UsageStore} from ${JSON.stringify(moduleUrl("src/usage-store.js"))};
    import {createHistoryArchiveCandidate,prepareHistoryArchiveCommit} from ${JSON.stringify(moduleUrl("src/history-archive.js"))};
    import {createRemainingHarnessFixture,insertDatabaseEvent,FIXTURE_TIME} from ${JSON.stringify(moduleUrl("test-support/remaining-harness-fixture.mjs"))};
    const root=path.dirname(fileURLToPath(import.meta.url)),home=path.join(root,'.zcode'),dir=path.join(home,'cli','db');
    const input=createRemainingHarnessFixture(dir,'zcode',3),source=path.join(dir,'db.sqlite');renameSync(input.filePath,source);
    const options={homeDir:root,env:{},importDirs:[home],databaseFile:path.join(root,'index.sqlite'),automaticDiscoveryEnabled:false};
    const store=new UsageStore(options);store.sourceProof.provider=async()=>null;
    try{
      await store.sync();
      const candidate=path.join(root,'archive.sqlite');
      await createHistoryArchiveCandidate(store.database,candidate,{startMs:FIXTURE_TIME,endMs:FIXTURE_TIME+2});
      await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database,candidate));
      const filters={preset:'all',calendarZone:'utc',now:new Date(FIXTURE_TIME+60000)};
      const read=()=>store.withSqlHistoryReader(reader=>reader.summarize(filters,{includeDetails:false}));
      assert.equal((await read()).eventCount,3);
      const db=new DatabaseSync(source);try{insertDatabaseEvent(db,'zcode',3);}finally{db.close();}
      await store.sync();assert.equal((await read()).eventCount,4);await read();
    }finally{store.close();}
  `, { telemetry: true });
  await f.done();
  const events = rows(f.control), projection = events.filter(row => row.event === "projection");
  assert.ok(projection.some(row => row.fullRebuild === true && row.coldCopied > 0), JSON.stringify(projection));
  assert.ok(projection.some(row => row.fullRebuild === false && row.coldCopied === 0));
  assert.ok(events.some(row => row.event === "zcode-projection-delta" && row.netAdded === 1 && row.added === 1 && row.removed === 0));
});
