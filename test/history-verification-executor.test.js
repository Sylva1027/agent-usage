import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { createUsageExecutor } from "../src/usage-executor.js";
import { UsageStore } from "../src/usage-store.js";
import { createUsageIntegrationFixture } from "../test-support/usage-fixture.mjs";

const FILTERS = { preset: "all", calendarZone: "utc", now: new Date("2026-10-06T12:00:00Z") };

test("sync and its dashboard share locked archive bytes; another executor only reuses semantic receipts", {
  skip: process.platform !== "win32",
}, async (t) => {
  const input = createUsageIntegrationFixture();
  const options = { ...input.serverOptions, executorIdleTimeoutMs: 60000 };
  const directory = path.dirname(options.databaseFile);
  const store = new UsageStore(options);
  let client;
  const originalArgs = [...process.execArgv];
  t.after(async () => {
    await client?.close();
    store.close();
    process.execArgv.splice(0, process.execArgv.length, ...originalArgs);
    input.close();
  });
  await store.sync();
  const candidates = [];
  for (const day of [3, 4]) {
    const file = path.join(directory, `verification-${day}.sqlite`);
    const start = Date.parse(`2026-10-0${day}T00:00:00Z`);
    await createHistoryArchiveCandidate(store.database, file, { startMs: start, endMs: start + 86400000 });
    candidates.push(file);
  }
  for (const file of candidates)
    await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, file));
  const rawFile = String(
    store.database.prepare("SELECT path FROM source_files WHERE kind='zcode' ORDER BY path LIMIT 1").get().path,
  );
  store.close();
  const log = path.join(directory, "verification-work.ndjson");
  writeFileSync(log, "");
  const probe = `\nimport {appendFileSync as logVerification} from 'node:fs';
    const testHash=hashFile;hashFile=async function(...args){const value=await testHash(...args);
      logVerification(${JSON.stringify(log)},JSON.stringify({pid:process.pid,kind:'hash',file:args[0]})+'\\n');return value;};
    const testEvidence=databaseEvidence;databaseEvidence=function(...args){
      logVerification(${JSON.stringify(log)},JSON.stringify({pid:process.pid,kind:'semantic'})+'\\n');return testEvidence(...args);};`;
  const loader = `import {registerHooks} from 'node:module';
    registerHooks({load(url,context,next){const result=next(url,context);if(!url.endsWith('/src/history-backup.js'))return result;
    return {...result,source:String(result.source)+${JSON.stringify(probe)}};}});`;
  process.execArgv.push("--import", `data:text/javascript,${encodeURIComponent(loader)}`);
  const rows = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  client = createUsageExecutor(options);
  await client.sync({ options });
  const initial = await client.dashboard(FILTERS, { includeDetails: false });
  assert.equal(rows().filter((row) => row.kind === "semantic").length, 2);

  const raw = new DatabaseSync(rawFile);
  try {
    raw.exec(`INSERT INTO model_usage(id,session_id,status,started_at,completed_at,duration_ms,
      input_tokens,output_tokens,agent,query_source,model_id,provider_id)
      VALUES('new-tail','new-tail','completed',1791201600000,1791201601000,1000,10,20,'','','small-model','fixture-provider')`);
  } finally {
    raw.close();
  }
  writeFileSync(log, "");
  await client.sync({ options });
  const next = await client.dashboard(FILTERS, { includeDetails: false });
  assert.equal(next.summary.totals.total, initial.summary.totals.total + 30);
  assert.equal(
    rows().filter((row) => row.kind === "hash").length,
    4,
    "two full hashes per package across sync and dashboard",
  );
  assert.equal(rows().filter((row) => row.kind === "semantic").length, 0);
  for (const file of candidates) {
    const writer = new DatabaseSync(file);
    try {
      writer.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; UPDATE events SET total=total; ROLLBACK");
    } finally {
      writer.close();
    }
  }
  const state = client.stateSnapshot();
  await client.close();
  client = createUsageExecutor(options);
  writeFileSync(log, "");
  await client.open({ frozen: state });
  const reopened = await client.dashboard(FILTERS, { includeDetails: false });
  assert.equal(reopened.summary.totals.total, next.summary.totals.total);
  assert.equal(rows().filter((row) => row.kind === "hash").length, 4);
  assert.equal(rows().filter((row) => row.kind === "semantic").length, 0, "completed proofs survive executor exit");
});
