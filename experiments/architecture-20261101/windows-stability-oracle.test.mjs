import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readCodexQuotaObservations } from "../../src/codex-quota-cache.js";
import { createCostEstimateAccumulator, createEventPricing, getPricingCatalog, runWithPricingCatalog } from "../../src/pricing.js";
import { ensureHistoryProjectionTracking, readHistoryProjectionStamp } from "../../src/usage-history-projection-store.js";
import { loadServiceTierEvidence } from "../../src/service-tier-evidence.js";
import { readUsageSourceInputs } from "../../src/usage-source-inputs.js";
import { UsageStore } from "../../src/usage-store.js";
import { verifyStabilityBody } from "./windows-stability-oracle.mjs";

const BASE = Date.parse("2026-07-01T00:00:00.000Z"), DAY = 86_400_000;
const AS_OF = "2026-07-04T12:00:00.000Z", GENERATED = "2026-07-04T11:59:00.000Z";
const FILE = "projection-11111111-1111-4111-8111-111111111111.sqlite";
const FIELDS = ["total", "input", "cached", "output", "reasoning"];
const copy = (value) => JSON.parse(JSON.stringify(value));
const digest = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "windows-stability-oracle-")), home = path.join(root, "home"), state = path.join(root, "state");
  await mkdir(home); await mkdir(state);
  const databaseFile = path.join(state, "usage-index.sqlite"), cache = `${databaseFile}.history-cache`;
  await mkdir(cache);
  const main = new DatabaseSync(databaseFile), projection = new DatabaseSync(path.join(cache, FILE));
  t.after(async () => { projection.close(); main.close(); await rm(root, { recursive: true, force: true }); });
  main.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE store_meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE source_files(path TEXT PRIMARY KEY,kind TEXT,home_id TEXT,home_label TEXT,home_path TEXT);
    CREATE TABLE archive_segments(segment_id TEXT);
    CREATE TABLE rate_limit_observations(source_path TEXT);
    CREATE TABLE quota_usage_sources(source_path TEXT);
    CREATE TABLE usage_business_revision(singleton INTEGER PRIMARY KEY,revision INTEGER);
    INSERT INTO usage_business_revision VALUES(1,3);`);
  main.prepare("INSERT INTO store_meta VALUES(?,?)").run("fingerprint", "fixture-published-source");
  main.prepare("INSERT INTO store_meta VALUES(?,?)").run("generated_at", GENERATED);
  ensureHistoryProjectionTracking(main);
  projection.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE source_files(path TEXT PRIMARY KEY,kind TEXT,home_id TEXT,home_label TEXT,home_path TEXT);
    CREATE TABLE events(id INTEGER PRIMARY KEY,history_ordinal INTEGER,timestamp_ms INTEGER,session_id TEXT,
      home_id TEXT,home_label TEXT,source_path TEXT,channel TEXT,model TEXT,project TEXT,detail_mask INTEGER,
      cache_write_tokens INTEGER,cache_write_known INTEGER,request_input_tokens INTEGER,context_level TEXT,
      service_tier TEXT,price_version TEXT,total INTEGER,input INTEGER,cached INTEGER,output INTEGER,reasoning INTEGER);
    CREATE INDEX history_query_order ON events(timestamp_ms,history_ordinal);
    CREATE TABLE usage_history_projection_cache(singleton INTEGER PRIMARY KEY,format INTEGER,
      source_identity TEXT,inputs_json TEXT,calendar_zone TEXT,status TEXT);
    CREATE TABLE usage_all_summary_checkpoint(forbidden TEXT);
    INSERT INTO usage_all_summary_checkpoint VALUES('poisoned checkpoint must never be read');`);
  const homes = ["main", "dsh", "claude", "workbuddy", "zcode", "opencode"].map((kind, index) =>
    ({ id: `home-${index}`, label: kind, kind, path: path.join(home, kind) }));
  for (const h of homes) {
    await mkdir(h.path);
    for (const db of [main, projection]) db.prepare("INSERT INTO source_files VALUES(?,?,?,?,?)")
      .run(path.join(h.path, "source-does-not-exist"), h.kind, h.id, h.label, h.path);
  }
  const evidenceFile = path.join(homes[0].path, "logs_2.sqlite");
  const log = new DatabaseSync(evidenceFile);
  log.exec("CREATE TABLE logs(id INTEGER PRIMARY KEY,ts INTEGER,ts_nanos INTEGER,thread_id TEXT,target TEXT,feedback_log_body TEXT)");
  log.prepare("INSERT INTO logs VALUES(?,?,?,?,?,?)").run(1, Math.floor((BASE - 1000) / 1000), 0, "shared-session",
    "codex_core::session::handlers", 'Submission sub=Submission { id: "tiny", op: TurnInput { service_tier: Some(Some("fast")), collaboration_mode:');
  log.close();
  const catalog = copy(getPricingCatalog());
  catalog.models["custom-request-model"] = copy(catalog.models["gpt-6-sol"]);
  const models = ["openai/gpt-6-sol", "gpt-6-sol", "claude-sonnet-4-5-20250929", "deepseek-v4.1-flash", "vendor/custom-request-model", "unknown-oracle-model"];
  const rows = homes.map((h, index) => {
    const output = index === 0 ? 4_000_000_000_000_000 : index + 1;
    return { id: 6 - index, history_ordinal: index % 2 + 1, timestamp_ms: BASE + Math.floor(index / 2) * DAY,
      session_id: index < 2 ? "shared-session" : `session-${index}`, home_id: h.id, home_label: h.label,
      source_path: path.join(h.path, "source-does-not-exist"), channel: "misleading legacy channel", model: models[index], project: "/fixture",
      detail_mask: 15, cache_write_tokens: 10, cache_write_known: 1, request_input_tokens: 140,
      context_level: "short", service_tier: index === 0 ? "unknown" : "standard", price_version: "stale-recorded-version",
      total: 140 + output, input: 140, cached: 30, output, reasoning: 0 };
  });
  for (const row of rows) {
    projection.prepare(`INSERT INTO events(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`)
      .run(...Object.values(row));
  }
  const physical = await realpath(databaseFile), info = await stat(physical, { bigint: true });
  projection.prepare("INSERT INTO usage_history_projection_cache VALUES(1,1,?,?,?,'ready')")
    .run(`${physical}\0${info.dev}\0${info.ino}`, JSON.stringify(readHistoryProjectionStamp(main)), "fixture-local-calendar");
  await writeFile(path.join(cache, "current.json"), JSON.stringify({ format: 1, file: FILE }));
  const options = { homeDir: home, env: {}, databaseFile, pricingFile: path.join(state, "pricing.json"),
    automaticPricingFile: path.join(state, "pricing-auto.json"), importStoreFile: path.join(state, "imports.json") };
  const expected = homes.map((h) => {
    const own = rows.filter((row) => row.home_id === h.id);
    return { kind: h.kind, events: own.length, sessions: own.length,
      ...Object.fromEntries(FIELDS.map((field) => [field, own.reduce((n, row) => n + row[field], 0)])) };
  });
  return { root, state, home, main, projection, cache, rows, homes, options, catalog, evidenceFile,
    dataset: { home, expected, expectedSessions: 5 } };
}

async function bodyFor(f, { start = null, end = null, preset = "all", catalog = f.catalog, sha = false, excludeHomes = [], costOrder = null } = {}) {
  const rows = f.rows.filter((row) => (start === null || row.timestamp_ms >= Date.parse(start)) &&
    (end === null || row.timestamp_ms <= Date.parse(end)) && !excludeHomes.includes(row.home_id))
    .toSorted((a, b) => a.timestamp_ms - b.timestamp_ms || a.history_ordinal - b.history_ordinal);
  const evidence = loadServiceTierEvidence(f.homes);
  const cost = runWithPricingCatalog(catalog, () => {
    const pricing = createEventPricing(catalog.models), accumulator = createCostEstimateAccumulator({ modelName: pricing.costModelName });
    for (const row of costOrder??rows) {
      const event = { timestamp: row.timestamp_ms, sessionId: row.session_id, homeId: row.home_id, homeLabel: row.home_label,
        sourcePath: row.source_path, sourceKind: f.homes.find((h) => h.id === row.home_id).kind,
        channel: row.channel, model: row.model, project: row.project, detailMask: row.detail_mask,
        cacheWriteTokens: row.cache_write_tokens, cacheWriteKnown: Boolean(row.cache_write_known), requestInputTokens: row.request_input_tokens,
        contextLevel: row.context_level, serviceTier: evidence.resolve(row.session_id, row.timestamp_ms, row.service_tier),
        priceVersion: row.price_version, total: Object.fromEntries(FIELDS.map((field) => [field, row[field]])) };
      accumulator.add(event, pricing.estimate(event));
    }
    return accumulator.result();
  });
  const rawFingerprint = f.main.prepare("SELECT value FROM store_meta WHERE key='fingerprint'").get().value;
  let routing = (await readUsageSourceInputs(f.options, f.homes, rawFingerprint)).routingFingerprint;
  if (sha) {
    const hash = createHash("sha256").update(rawFingerprint).update("\0quota\0")
      .update(JSON.stringify(readCodexQuotaObservations({ ...f.options, homes: f.homes })));
    const files = [f.options.importStoreFile, ...f.homes.flatMap((h) =>
      ["config.toml", "settings.json", "config.json", "logs_2.sqlite", "logs_2.sqlite-wal"].map((name) => path.join(h.path, name)))].sort();
    for (const file of files) {
      try { const info = await stat(file); hash.update(JSON.stringify([file, info.size, info.mtimeMs])); }
      catch (error) { if (error.code !== "ENOENT") throw error; hash.update(JSON.stringify([file, "missing"])); }
    }
    routing = hash.digest("hex");
  }
  const asOf = new Date(AS_OF), day = `${asOf.getFullYear()}-${asOf.getMonth()}-${asOf.getDate()}:${AS_OF.slice(0, 10)}`;
  const generatedAt = f.main.prepare("SELECT value FROM store_meta WHERE key='generated_at'").get().value;
  return { fingerprint: digest(`${routing}\0${catalog.version}${day}`), usageVersion: "opaque-response-version", pricingCatalog: catalog,
    periodComparison: { asOf: AS_OF }, metadata: { generatedAt, homes: f.homes },
    summary: { generatedAt, range: { preset, start, end, calendarZone: "utc", bucket: "day" },
      totals: Object.fromEntries(FIELDS.map((field) => [field, rows.reduce((n, row) => n + row[field], 0)])),
      eventCount: rows.length, sessionCount: new Set(rows.map((row) => row.session_id)).size, costEstimate: cost } };
}

test("published SQL oracle streams legacy order with request catalog, source kinds, evidence and exact counts", async (t) => {
  const f = await fixture(t), body = await bodyFor(f);
  const originalPrepare = DatabaseSync.prototype.prepare, originalOpen = UsageStore.prototype.open, seen = [];
  DatabaseSync.prototype.prepare = function (sql) {
    assert.doesNotMatch(sql, /usage_all_summary|usage_rollup_|summary_state|\bFROM summaries\b/i, "oracle must not trust checkpoints");
    const statement = originalPrepare.call(this, sql);
    if (/^SELECT timestamp_ms, session_id/.test(sql)) {
      assert.match(sql, /ORDER BY timestamp_ms,history_ordinal/);
      statement.all = () => assert.fail("events must never be materialized");
      const iterate = statement.iterate;
      statement.iterate = function* (...params) {
        for (const row of iterate.call(this, ...params)) { seen.push([row[0], row[18]]); yield row; }
      };
    }
    return statement;
  };
  UsageStore.prototype.open = () => assert.fail("oracle must never open/import a UsageStore");
  let result;
  try {
    result = await verifyStabilityBody({ body, dataset: f.dataset, state: f.state, fullCost: true,
      ledger: { expected: { total: 0, input: 0, cached: 0, output: 0, reasoning: 0, events: 0, sessions: 0, cacheWrite: 0 } } });
  } finally { DatabaseSync.prototype.prepare = originalPrepare; UsageStore.prototype.open = originalOpen; }
  assert.equal(result.ok, true);
  assert.deepEqual(seen, f.rows.map((row) => [row.timestamp_ms, row.output]));
  assert.deepEqual(result.actual.costEstimate, body.summary.costEstimate);
  assert.equal(result.actual.sessionCount, 5, "shared session across two homes counts once");
  assert.equal(result.oracle.costEvents, 6);
  assert.equal(result.oracle.checkpointReads, 0);
  assert.equal(result.oracle.sourceImports, 0);
  assert.equal(result.oracle.databasesOpened, 2);
  assert.ok(result.oracle.wallMs >= 0 && result.oracle.cpuUserMs >= 0);
  assert.equal(result.actual.costEstimate.serviceTierUnknownRecords, 0, "unknown recorded Codex tier uses the evidence");
  for (const row of f.rows) await assert.rejects(readFile(row.source_path), { code: "ENOENT" });
  const sha = await verifyStabilityBody({ body: await bodyFor(f, { sha: true }), dataset: f.dataset, state: f.state });
  assert.equal(sha.ok, true, "E-volume SHA publication fingerprints also bind correctly");
});

test("single-archive all retains hot-then-cold order and revisions select the timestamp carrier", async t=>{
  const f=await fixture(t),file=path.join(f.root,"cold.sqlite"),cold=new DatabaseSync(file);
  const schema=f.projection.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='events'").get().sql;
  f.main.exec(schema);cold.exec(schema);
  for(const [i,row] of f.rows.entries()){
    const db=i<2?cold:f.main;
    db.prepare(`INSERT INTO events(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(()=>"?").join(",")})`).run(...Object.values(row));
  }
  cold.close();
  f.main.exec("ALTER TABLE archive_segments ADD COLUMN database_path TEXT; ALTER TABLE archive_segments ADD COLUMN start_ms INTEGER; ALTER TABLE archive_segments ADD COLUMN end_ms INTEGER");
  const id="a".repeat(64);f.main.prepare("INSERT INTO archive_segments VALUES(?,?,?,?)").run(id,file,BASE,BASE+DAY);
  f.main.prepare("INSERT INTO store_meta VALUES(?,?)").run("history_archive_event_authority",JSON.stringify({formatVersion:1,segmentIds:[id]}));
  f.projection.prepare("UPDATE usage_history_projection_cache SET inputs_json=?").run(JSON.stringify(readHistoryProjectionStamp(f.main)));
  const order=[...f.rows.slice(2).toSorted((a,b)=>a.id-b.id),...f.rows.slice(0,2).toSorted((a,b)=>a.id-b.id)];
  const body=await bodyFor(f,{costOrder:order}),canonical=await bodyFor(f);
  assert.notDeepEqual(body.summary.costEstimate,canonical.summary.costEstimate,"fixture exposes floating-point reassociation");
  const result=await verifyStabilityBody({body,dataset:f.dataset,state:f.state});
  assert.equal(result.passed,true);assert.equal(result.oracle.costOrder,"hot-then-single-archive");
  f.main.prepare("INSERT INTO store_meta VALUES(?,?)").run("history_archive_event_revisions",JSON.stringify({formatVersion:1,revisions:[]}));
  f.projection.prepare("UPDATE usage_history_projection_cache SET inputs_json=?").run(JSON.stringify(readHistoryProjectionStamp(f.main)));
  const revised=await verifyStabilityBody({body:await bodyFor(f),dataset:f.dataset,state:f.state});
  assert.equal(revised.passed,true);assert.equal(revised.oracle.costOrder,"timestamp-history-ordinal");
});

test("inclusive range, empty range, and exclusions use SQL facts; tiny money and count mismatches fail exactly", async (t) => {
  const f = await fixture(t), instant = new Date(BASE + DAY).toISOString();
  const body = await bodyFor(f, { preset: "custom", start: instant, end: instant });
  const result = await verifyStabilityBody({ body, dataset: f.dataset, state: f.state });
  assert.equal(result.ok, true); assert.equal(result.actual.eventCount, 2);
  const wrong = copy(body); wrong.summary.costEstimate.inputUsd += Number.EPSILON;
  await assert.rejects(verifyStabilityBody({ body: wrong, dataset: f.dataset, state: f.state }), /ordered legacy cost/);
  for (const field of ["eventCount", "sessionCount"]) {
    const broken = copy(body); broken.summary[field]++;
    await assert.rejects(verifyStabilityBody({ body: broken, dataset: f.dataset, state: f.state }), /SQL .*count/);
  }
  const badTokens = copy(body); badTokens.summary.totals.total++;
  await assert.rejects(verifyStabilityBody({ body: badTokens, dataset: f.dataset, state: f.state }), /SQL totals/);
  const empty = await bodyFor(f, { preset: "custom", start: "2027-01-01T00:00:00Z", end: "2027-01-02T00:00:00Z" });
  assert.equal((await verifyStabilityBody({ body: empty, dataset: f.dataset, state: f.state })).actual.eventCount, 0);
  const excludeHomes = [f.homes[0].id], excluded = await bodyFor(f, { excludeHomes });
  assert.equal((await verifyStabilityBody({ body: excluded, dataset: f.dataset, state: f.state, excludeHomes })).ok, true);
  const noCost = copy(body); noCost.summary.costEstimate = "deliberately unused";
  const basic = await verifyStabilityBody({ body: noCost, dataset: f.dataset, state: f.state, fullCost: false });
  assert.equal(basic.checks.cost, false); assert.equal(basic.oracle.costEvents, 0);
});

test("repricing and evidence recovery recompute; stale responses, missing projections, and concurrent publications retry", async (t) => {
  const f = await fixture(t), original = await bodyFor(f);
  const catalog = copy(f.catalog); catalog.version += "-changed"; catalog.models["gpt-6-sol"].short.output *= 2; catalog.usdToCnyRate = 8.123;
  const repriced = await bodyFor(f, { catalog });
  assert.notDeepEqual(repriced.summary.costEstimate, original.summary.costEstimate);
  assert.equal((await verifyStabilityBody({ body: repriced, dataset: f.dataset, state: f.state })).ok, true);
  assert.equal((await verifyStabilityBody({ body: original, dataset: f.dataset, state: f.state })).ok, true);
  const logs = new DatabaseSync(f.evidenceFile);
  try {
    logs.prepare("INSERT INTO logs SELECT 2,ts+1,ts_nanos,thread_id,target,replace(feedback_log_body,'fast','standard') FROM logs WHERE id=1").run();
  } finally { logs.close(); }
  const stale = await verifyStabilityBody({ body: original, dataset: f.dataset, state: f.state });
  assert.equal(stale.retry, true); assert.equal(stale.oracle.costEvents, 0);
  const changed = await bodyFor(f);
  assert.notDeepEqual(changed.summary.costEstimate, original.summary.costEstimate);
  assert.equal((await verifyStabilityBody({ body: changed, dataset: f.dataset, state: f.state })).ok, true);
  const recover = new DatabaseSync(f.evidenceFile);
  try { recover.prepare("DELETE FROM logs WHERE id>1").run(); }
  finally { recover.close(); }
  const recovered = await bodyFor(f);
  assert.deepEqual(recovered.summary.costEstimate, original.summary.costEstimate);
  assert.equal((await verifyStabilityBody({ body: recovered, dataset: f.dataset, state: f.state })).ok, true);
  const oldStream = UsageStore.prototype.costEventsForRange;
  UsageStore.prototype.costEventsForRange = function* (...args) {
    let first = true;
    for (const event of oldStream.apply(this, args)) {
      if (first) { first = false; f.main.prepare("UPDATE store_meta SET value=? WHERE key='generated_at'").run("new-publication"); }
      yield event;
    }
  };
  const deliberatelyWrong = copy(recovered); deliberatelyWrong.summary.eventCount++;
  let concurrent;
  try { concurrent = await verifyStabilityBody({ body: deliberatelyWrong, dataset: f.dataset, state: f.state }); }
  finally { UsageStore.prototype.costEventsForRange = oldStream; }
  assert.equal(concurrent.retry, true, "a changed publication takes precedence over correctness assertions");
  assert.match(concurrent.reason, /during the oracle/);
  await rm(path.join(f.cache, "current.json"));
  const absent = await verifyStabilityBody({ body: recovered, dataset: f.dataset, state: f.state });
  assert.equal(absent.retry, true); assert.match(absent.reason, /projection is unavailable/);
});

test("a stale projection stamp and an overlapping projection commit retry without certifying old facts", async (t) => {
  const f = await fixture(t), body = await bodyFor(f);
  const oldStamp = f.projection.prepare("SELECT inputs_json FROM usage_history_projection_cache").get().inputs_json;
  const staleStamp = JSON.parse(oldStamp); staleStamp.facts--;
  f.projection.prepare("UPDATE usage_history_projection_cache SET inputs_json=?").run(JSON.stringify(staleStamp));
  const stale = await verifyStabilityBody({ body, dataset: f.dataset, state: f.state });
  assert.equal(stale.retry, true); assert.equal(stale.oracle.costEvents, 0);
  f.projection.prepare("UPDATE usage_history_projection_cache SET inputs_json=?").run(oldStamp);
  const original = UsageStore.prototype.costEventsForRange;
  UsageStore.prototype.costEventsForRange = function* (...args) {
    let first = true;
    for (const event of original.apply(this, args)) {
      if (first) { first = false; f.projection.exec("UPDATE events SET total=total+1,output=output+1 WHERE id=1"); }
      yield event;
    }
  };
  let result;
  try { result = await verifyStabilityBody({ body, dataset: f.dataset, state: f.state }); }
  finally { UsageStore.prototype.costEventsForRange = original; }
  assert.equal(result.retry, true); assert.match(result.reason, /during the oracle/);
  assert.equal(result.oracle.costEvents, 6, "the pinned read finishes, then refuses the changed publication");
});

test("CLI writes passed, retry, and correctness failure receipts without using a seed", async (t) => {
  const f = await fixture(t), body = await bodyFor(f);
  async function cli(label, response) {
    const config = path.join(f.root, `${label}.json`), output = path.join(f.root, `${label}-result.json`);
    await writeFile(config, JSON.stringify({ body: response, dataset: f.dataset, state: f.state, output,
      seedFile: path.join(f.root, "nonexistent-private-seed.sqlite") }));
    const child = spawn(process.execPath, ["--max-old-space-size=224", fileURLToPath(new URL("./windows-stability-oracle.mjs", import.meta.url)), config],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (bytes) => { stdout += bytes; });
    child.stderr.on("data", (bytes) => { stderr += bytes; });
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    const result = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(JSON.parse(stdout.trim()), result, stderr);
    return { code, result };
  }
  const passed = await cli("passed", body);
  assert.equal(passed.code, 0); assert.equal(passed.result.passed, true);
  const stale = copy(body); stale.fingerprint = "old-publication";
  const retry = await cli("retry", stale);
  assert.equal(retry.code, 0); assert.equal(retry.result.passed, false); assert.equal(retry.result.retry, true);
  assert.match(retry.result.reason, /different publications/);
  const retried = await cli("retry", body);
  assert.equal(retried.code, 0); assert.equal(retried.result.passed, true, "the same output path supports a fresh response after retry");
  const wrong = copy(body); wrong.summary.eventCount++;
  const failure = await cli("failure", wrong);
  assert.equal(failure.code, 1); assert.equal(failure.result.passed, false); assert.equal(failure.result.retry, false);
  assert.match(failure.result.error.message, /SQL event count/);
});
