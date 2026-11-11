import assert from "node:assert/strict";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";
import childProcess from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { getPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { createUsageServer } from "../src/server.js";
import { createUsageExecutor } from "../src/usage-executor.js";
import { UsageStore } from "../src/usage-store.js";
import { UsageSummaryCache } from "../src/usage-summary-cache.js";
import { createUsageIntegrationFixture } from "../test-support/usage-fixture.mjs";

const WINDOWS = { skip: process.platform !== "win32", timeout: 30_000 };
const FILTERS = { preset: "all", calendarZone: "utc", now: new Date("2026-10-06T12:00:00Z") };
const QUERY = "/api/usage?preset=all&view=dashboard&calendarZone=utc";
const LOCK_ERRORS = new Set(["EACCES", "EPERM", "EBUSY"]);
const FACT_COLUMNS = "source_path,timestamp_ms,session_id,home_id,total,input,cached,output,reasoning";

async function fixture(t) {
  const input = createUsageIntegrationFixture();
  const options = { ...input.serverOptions, executorIdleTimeoutMs: 60_000 };
  const directory = path.dirname(options.databaseFile);
  const store = new UsageStore(options),
    argv = [...process.execArgv],
    pricing = getPricingCatalog();
  const archives = [],
    requests = [],
    replies = [];
  let client, server;
  t.after(async () => {
    try {
      await server?.close();
      await client?.close();
    } finally {
      store.close();
      process.execArgv.splice(0, process.execArgv.length, ...argv);
      t.mock.restoreAll();
      syncBuiltinESMExports();
      setPricingCatalog(pricing);
      input.close();
    }
  });
  await store.sync();
  const expectedFacts = store.database.prepare(`SELECT id,${FACT_COLUMNS} FROM events`).all();
  const rawFiles = store.database.prepare("SELECT path FROM source_files WHERE kind='zcode' ORDER BY path").all();
  const touchSources = () => {
    for (const { path: file } of rawFiles) {
      const database = new DatabaseSync(String(file));
      try {
        // Change source bytes so sync verifies cold facts without changing any usage event.
        database.exec(`CREATE TABLE IF NOT EXISTS lifecycle_trigger(generation INTEGER);
          INSERT INTO lifecycle_trigger VALUES(1)`);
      } finally {
        database.close();
      }
    }
  };
  for (const day of [3, 4]) {
    const file = path.join(directory, `lifecycle-${day}.sqlite`);
    const startMs = Date.parse(`2026-10-0${day}T00:00:00Z`);
    await createHistoryArchiveCandidate(store.database, file, { startMs, endMs: startMs + 86_400_000 });
    archives.push(file);
  }
  for (const file of archives)
    await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, file));
  store.close();

  const log = path.join(directory, "verification-lifecycle.ndjson");
  const failSync = path.join(directory, "fail-sync-once");
  const blockVerification = path.join(directory, "block-verification-once");
  writeFileSync(log, "");
  const record = `\nimport {appendFileSync as lifecycleAppend} from 'node:fs';
    const lifecycleRecord=value=>lifecycleAppend(${JSON.stringify(log)},JSON.stringify({pid:process.pid,...value})+'\\n');`;
  const probes = {
    "/src/history-backup.js": `${record}
      import {existsSync as lifecycleBlockExists,unlinkSync as lifecycleBlockUnlink} from 'node:fs';
      const lifecycleHash=hashFile;hashFile=async function(...args){const result=await lifecycleHash(...args);
        lifecycleRecord({kind:'hash',file:args[0],bytes:result.bytes});return result;};
      const lifecycleEvidence=databaseEvidence;databaseEvidence=function(...args){
        const file=args[0].prepare('PRAGMA database_list').all().find(row=>row.name==='main').file;
        if(lifecycleBlockExists(${JSON.stringify(blockVerification)})){
          lifecycleBlockUnlink(${JSON.stringify(blockVerification)});
          lifecycleRecord({kind:'verification-blocked',file});
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);
          throw new Error('verification worker was not killed');
        }
        const result=lifecycleEvidence(...args);lifecycleRecord({kind:'semantic-complete',file});return result;};`,
    "/src/history-archive.js": `${record}
      const lifecycleSources=sourceEvidence;sourceEvidence=function(...args){const result=lifecycleSources(...args);
        lifecycleRecord({kind:'candidate-semantic-complete'});return result;};`,
    "/src/usage-history-projection-store.js": `${record}
      const lifecycleReceipts=HistoryProjectionStore.prototype.verificationReceipts;
      HistoryProjectionStore.prototype.verificationReceipts=function(...args){
        const receipts=lifecycleReceipts.apply(this,args);return {
          has:key=>{const hit=receipts.has(key);lifecycleRecord({kind:'receipt-has',key,hit});return hit;},
          add:key=>{receipts.add(key);lifecycleRecord({kind:'receipt-add',key});}
        };};`,
    "/src/usage-source-native.js": `${record}
      let lifecycleSequence=0;
      const lifecycleLock=WindowsSourceProof.prototype.lockFiles;
      WindowsSourceProof.prototype.lockFiles=async function(files){
        const lease=await lifecycleLock.call(this,files);if(!lease)return null;
        const id=process.pid+':'+(++lifecycleSequence);let closed=false;
        lifecycleRecord({kind:'lease-open',id,files});
        return {check:()=>lease.check(),close:async()=>{
          if(closed)return;closed=true;await lease.close();lifecycleRecord({kind:'lease-close',id});}};
      };`,
    "/src/usage-store.js": `\nimport {existsSync as lifecycleExists,unlinkSync as lifecycleUnlink} from 'node:fs';
      const lifecycleSync=UsageStore.prototype.sync;
      UsageStore.prototype.sync=async function(...args){const result=await lifecycleSync.apply(this,args);
        if(lifecycleExists(${JSON.stringify(failSync)})){lifecycleUnlink(${JSON.stringify(failSync)});
          throw Object.assign(new Error('injected failure after archive verification'),{code:'LIFECYCLE_SYNC_FAILURE'});}
        return result;};`,
  };
  const loader = `import {registerHooks} from 'node:module';const probes=${JSON.stringify(probes)};
    registerHooks({load(url,context,next){const result=next(url,context);
      const suffix=Object.keys(probes).find(suffix=>url.endsWith(suffix));
      return suffix?{...result,source:String(result.source)+probes[suffix]}:result;}});`;
  process.execArgv.push("--import", `data:text/javascript,${encodeURIComponent(loader)}`);
  const fork = childProcess.fork;
  t.mock.method(childProcess, "fork", (...args) => {
    const child = fork(...args),
      pending = new Map(),
      send = child.send;
    t.mock.method(child, "send", function (message, ...rest) {
      requests.push(message);
      pending.set(message.id, message.type);
      return send.call(this, message, ...rest);
    });
    child.on("message", (message) => {
      if (message.type !== "response") return;
      replies.push({ ...message, type: pending.get(message.id) });
      pending.delete(message.id);
    });
    return child;
  });
  syncBuiltinESMExports();
  client = createUsageExecutor(options, { requestTimeoutMs: 10_000 });
  const rows = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  return {
    options,
    client,
    archives,
    requests,
    replies,
    failSync,
    blockVerification,
    expectedFacts,
    expected: input.expected,
    rows,
    files: archives.flatMap((file) => [file, file.replace(/\.sqlite$/, ".manifest.json")]),
    hashes: () => rows().filter((row) => row.kind === "hash" && archives.includes(row.file)),
    async sync() {
      touchSources();
      return client.sync({ options });
    },
    reset() {
      writeFileSync(log, "");
      requests.length = replies.length = 0;
    },
    async serve() {
      touchSources();
      server = createUsageServer(options);
      await listenOnFetchPort(server);
      return `http://127.0.0.1:${server.address().port}`;
    },
  };
}

function filesWritable(files) {
  for (const file of files) {
    try {
      closeSync(openSync(file, "r+"));
    } catch (error) {
      if (LOCK_ERRORS.has(error.code)) return false;
      throw error;
    }
  }
  return true;
}

function assertHeld(f, files = f.files) {
  assert.ok(
    f.rows().some((row) => row.kind === "lease-open"),
    "the real native helper must acquire a lease",
  );
  for (const file of files)
    assert.throws(
      () => closeSync(openSync(file, "r+")),
      (error) => LOCK_ERRORS.has(error.code),
      file,
    );
}

function assertReleased(f) {
  assert.equal(filesWritable(f.files), true, "archive and manifest write handles are released");
  for (const file of f.archives) {
    const writer = new DatabaseSync(file);
    try {
      writer.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK");
    } finally {
      writer.close();
    }
  }
}

function assertLeasesClosed(rows) {
  const opened = rows.filter((row) => row.kind === "lease-open");
  assert.ok(opened.length > 0, "exercise actual native leases");
  for (const { id } of opened)
    assert.equal(rows.filter((row) => row.kind === "lease-close" && row.id === id).length, 1, id);
}

async function until(check, message) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(10);
  }
  assert.fail(message);
}

test(
  "superseding sync retires its old scope; the handoff is consumed once and explicit release forces fresh SHA",
  WINDOWS,
  async (t) => {
    const f = await fixture(t);
    await f.sync();
    assertHeld(f);
    const first = f.rows().filter((row) => row.kind === "lease-open");
    assert.equal(first.length, 2);
    const before = f.rows().length,
      hashes = f.hashes().length;
    await f.sync();
    const replacement = f.rows().slice(before);
    for (const { id } of first) {
      const closed = replacement.findIndex((row) => row.kind === "lease-close" && row.id === id);
      assert.ok(closed >= 0 && closed < replacement.findIndex((row) => row.kind === "lease-open"));
    }
    assert.equal(f.hashes().length - hashes, 4, "a superseding operation hashes both packages twice");
    assertHeld(f);
    const retained = f.hashes().length;
    await f.client.dashboard(FILTERS, { includeDetails: false });
    assert.equal(f.hashes().length, retained, "the first dashboard consumes the sync's pinned readers");
    assertReleased(f);
    await f.client.dashboard(FILTERS, { includeDetails: false });
    assert.equal(f.hashes().length - retained, 4, "a second dashboard gets a new operation");
    assertReleased(f);

    await f.sync();
    assertHeld(f);
    const released = f.hashes().length;
    await f.client.releaseHistoryVerification();
    await f.client.releaseHistoryVerification();
    assertReleased(f);
    await f.client.dashboard(FILTERS, { includeDetails: false });
    const fresh = f.hashes().slice(released);
    assert.equal(fresh.length, 4, "an explicitly released handoff cannot suppress the next full hashes");
    for (const file of f.archives) {
      const manifest = JSON.parse(readFileSync(file.replace(/\.sqlite$/, ".manifest.json"), "utf8"));
      assert.deepEqual(
        fresh.filter((row) => row.file === file).map((row) => row.bytes),
        [manifest.database.bytes, manifest.database.bytes],
      );
    }
    const dashboards = f.requests.filter((message) => message.type === "dashboard");
    assert.ok(Number.isSafeInteger(dashboards[0].historyVerification));
    assert.equal(dashboards[1].historyVerification, null);
    assert.equal(dashboards[2].historyVerification, null);
    assert.equal(f.requests.filter((message) => message.type === "releaseHistoryVerification").length, 1);
    assertReleased(f);
    assertLeasesClosed(f.rows());
  },
);

test("a sync failure after verification releases archive locks", WINDOWS, async (t) => {
  const f = await fixture(t);
  writeFileSync(f.failSync, "fail after the real sync has verified its archives");
  await assert.rejects(f.sync(), { code: "LIFECYCLE_SYNC_FAILURE" });
  assertReleased(f);
  assertLeasesClosed(f.rows());
});

test(
  "killing incomplete verification publishes no receipt; recovery fully verifies every fact once",
  WINDOWS,
  async (t) => {
    const f = await fixture(t);
    writeFileSync(f.blockVerification, "stop before the first semantic proof completes");
    const interrupted = f.sync();
    const rejected = assert.rejects(interrupted, { code: "EXECUTOR_EXITED" });
    try {
      await until(
        () => f.rows().some((row) => row.kind === "verification-blocked"),
        "the worker must stop inside semantic verification before it can publish a receipt",
      );
      const rows = f.rows(),
        blocked = rows.find((row) => row.kind === "verification-blocked");
      assert.equal(f.hashes().filter((row) => row.file === blocked.file).length, 2);
      assert.ok(rows.some((row) => row.kind === "receipt-has" && row.hit === false));
      assert.equal(rows.filter((row) => row.kind === "receipt-add").length, 0);
      assert.equal(rows.filter((row) => row.kind === "semantic-complete").length, 0);
      const lease = rows.find((row) => row.kind === "lease-open" && row.files.includes(blocked.file));
      assert.ok(lease);
      assertHeld(f, lease.files);
    } finally {
      assert.equal(await f.client.crashWorkerForTest(), true);
      await rejected;
    }
    await until(() => filesWritable(f.files), "the native helper must release leases after executor death");
    assertReleased(f);
    assert.equal(f.rows().filter((row) => row.kind === "receipt-add").length, 0);
    f.reset();

    await f.sync();
    const recovered = await f.client.dashboard(FILTERS, { includeDetails: false });
    assert.equal(recovered.summary.eventCount, f.expected.usage.eventCount);
    for (const [name, value] of Object.entries(f.expected.usage.totals))
      assert.equal(recovered.summary.totals[name], value, name);
    assert.equal(f.hashes().length, 4);
    assert.equal(f.rows().filter((row) => row.kind === "semantic-complete").length, 2);
    assert.equal(f.rows().filter((row) => row.kind === "candidate-semantic-complete").length, 2);
    for (const file of f.archives) {
      assert.equal(f.hashes().filter((row) => row.file === file).length, 2);
      assert.equal(f.rows().filter((row) => row.kind === "semantic-complete" && row.file === file).length, 1);
    }
    const physical = [];
    for (const file of [f.options.databaseFile, ...f.archives]) {
      const database = new DatabaseSync(file, { readOnly: true });
      try {
        physical.push(...database.prepare(`SELECT id,${FACT_COLUMNS} FROM events`).all());
      } finally {
        database.close();
      }
    }
    const canonical = (rows) => rows.map((row) => JSON.stringify(row)).sort();
    assert.deepEqual(canonical(physical), canonical(f.expectedFacts), "original event IDs and facts survive the crash");
    const cache = `${f.options.databaseFile}.history-cache`;
    const published = JSON.parse(readFileSync(path.join(cache, "current.json"), "utf8"));
    const database = new DatabaseSync(path.join(cache, published.file), { readOnly: true });
    try {
      const actual = database.prepare(`SELECT ${FACT_COLUMNS} FROM events`).all();
      const expected = f.expectedFacts.map(({ id: _id, ...row }) => row);
      assert.deepEqual(canonical(actual), canonical(expected), "recovered projection contains the exact fact multiset");
    } finally {
      database.close();
    }
    assertReleased(f);
    assertLeasesClosed(f.rows());
  },
);

test("the HTTP cache-hit branch releases the pending native handoff without a dashboard IPC", WINDOWS, async (t) => {
  const f = await fixture(t);
  await f.sync();
  const cached = await f.client.dashboard(FILTERS, { includeDetails: false });
  await f.client.close();
  f.reset();
  // Cold publication currently declines HTTP caching; supply a real captured payload at that boundary.
  t.mock.method(UsageSummaryCache.prototype, "get", async () => cached);
  const base = await f.serve();
  const response = await fetch(base + QUERY, { signal: t.signal });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(response.headers.get("x-summary-cache"), "hit");
  assert.deepEqual(body.summary.totals, cached.summary.totals);
  assert.ok(f.requests.some((message) => message.type === "sync"));
  assert.equal(f.requests.filter((message) => message.type === "releaseHistoryVerification").length, 1);
  assert.equal(f.requests.filter((message) => message.type === "dashboard").length, 0);
  assertReleased(f);
  assertLeasesClosed(f.rows());
});

test("an aborted HTTP request releases its handoff when the existing executor work finishes", WINDOWS, async (t) => {
  const f = await fixture(t);
  const entered = Promise.withResolvers(),
    resume = Promise.withResolvers();
  const controller = new AbortController();
  t.after(() => {
    controller.abort();
    resume.resolve();
  });
  t.mock.method(UsageSummaryCache.prototype, "get", async () => {
    entered.resolve();
    await resume.promise;
    return null;
  });
  const base = await f.serve();
  const request = fetch(base + QUERY, { signal: AbortSignal.any([controller.signal, t.signal]) });
  const aborted = assert.rejects(request, { name: "AbortError" });
  try {
    await Promise.race([entered.promise, request.then(() => assert.fail("request completed before the cache gate"))]);
    assertHeld(f);
    controller.abort();
    await aborted;
  } finally {
    resume.resolve();
  }
  // There is no executor AbortSignal API: cancellation lets the already-started operation finish.
  await until(
    () => f.replies.some((reply) => reply.type === "dashboard" && reply.ok) && filesWritable(f.files),
    "finishing a disconnected request must release all archive readers",
  );
  assertReleased(f);
  assertLeasesClosed(f.rows());
});
