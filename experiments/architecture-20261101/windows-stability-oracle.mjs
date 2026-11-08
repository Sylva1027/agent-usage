import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath,pathToFileURL } from "node:url";

import { homeSourceKinds } from "../../public/timeline-utils.js";
import { readCodexQuotaObservations } from "../../src/codex-quota-cache.js";
import { createCostEstimateAccumulator, createEventPricing, runWithPricingCatalog } from "../../src/pricing.js";
import { loadServiceTierEvidence } from "../../src/service-tier-evidence.js";
import { readHistoryProjectionStamp, sameHistoryProjectionStamp } from "../../src/usage-history-projection-store.js";
import { readUsageSourceInputs } from "../../src/usage-source-inputs.js";
import { UsageStore } from "../../src/usage-store.js";

const fields = ["total", "input", "cached", "output", "reasoning"];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const retry = (reason) => Object.assign(new Error(reason), { oracleRetry: true });

function responseRange(body) {
  const value = body.summary?.range ?? body.range;
  assert.ok(value && typeof value.preset === "string", "response range is required");
  assert.ok(!value.quotaWindow && !value.quotaPreset && !["quota_5h", "quota_week"].includes(value.preset),
    "stability oracle supports calendar ranges, not quota classification");
  const date = (text) => {
    if (text === null) return null;
    assert.equal(typeof text, "string", "range boundaries must be ISO dates or null");
    const result = new Date(text);
    assert.ok(Number.isFinite(result.getTime()), "invalid range boundary");
    return result;
  };
  return { ...value, start: date(value.start), end: date(value.end) };
}

async function pointer(cache) {
  let text;
  try { text = await readFile(path.join(cache, "current.json"), "utf8"); }
  catch (error) { if (error.code === "ENOENT") throw retry("published projection is unavailable"); throw error; }
  const value = JSON.parse(text);
  assert.ok(value?.format === 1 && /^projection-[a-f0-9-]{36}\.sqlite$/.test(value.file), "invalid published projection pointer");
  return value.file;
}

function openReadonly(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { db.exec("PRAGMA busy_timeout=0; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE"); return db; }
  catch (error) { db.close(); throw error; }
}

function publication(database) {
  database.exec("BEGIN");
  try {
    const meta = database.prepare("SELECT value FROM store_meta WHERE key=?");
    return { fingerprint: meta.get("fingerprint")?.value, generatedAt: meta.get("generated_at")?.value,
      stamp: readHistoryProjectionStamp(database) };
  } finally { database.exec("ROLLBACK"); }
}

async function physicalIdentity(file) {
  const physical = await realpath(file);
  const info = await stat(physical, { bigint: true });
  return `${physical}\0${info.dev}\0${info.ino}`;
}

// SHA acquisition and native acquisition use different metadata fingerprints; mirror both published contracts.
async function dependencyRoutes(options, homes, fingerprint) {
  const prices = new Set([options.pricingFile, options.automaticPricingFile]);
  const files = new Set([...prices, options.importStoreFile].filter(Boolean));
  for (const home of homes) {
    for (const name of ["config.toml", "settings.json", "config.json", "logs_2.sqlite", "logs_2.sqlite-wal"])
      files.add(path.join(home.path, name));
  }
  const routing = createHash("sha256").update(fingerprint);
  routing.update("\0quota\0").update(JSON.stringify(readCodexQuotaObservations({ ...options, homes })));
  for (const file of [...files].sort()) {
    let observation;
    try { const info = await stat(file); observation = JSON.stringify([file, info.size, info.mtimeMs]); }
    catch (error) { if (error.code !== "ENOENT") throw error; observation = JSON.stringify([file, "missing"]); }
    if (!prices.has(file)) routing.update(observation);
  }
  const native = await readUsageSourceInputs(options, homes, fingerprint);
  return { sha: routing.digest("hex"), native: native.routingFingerprint };
}

function matchesResponse(body, published, routes, asOf) {
  if (body.summary.generatedAt !== published.generatedAt || body.metadata?.generatedAt !== published.generatedAt) return false;
  const day = `${asOf.getFullYear()}-${asOf.getMonth()}-${asOf.getDate()}:${asOf.toISOString().slice(0, 10)}`;
  return Object.values(routes).some((routing) => body.fingerprint === hash(`${routing}\0${body.pricingCatalog.version}${day}`));
}

function aggregate(database, range, excludeHomes) {
  const conditions = [], params = [];
  if (range.start) { conditions.push("timestamp_ms>=?"); params.push(range.start.getTime()); }
  if (range.end) { conditions.push("timestamp_ms<=?"); params.push(range.end.getTime()); }
  if (excludeHomes.length) { conditions.push(`home_id NOT IN (${excludeHomes.map(() => "?").join(",")})`); params.push(...excludeHomes); }
  const row = database.prepare(`SELECT COUNT(*) AS events,COUNT(DISTINCT session_id) AS sessions,
    ${fields.map((field) => `COALESCE(SUM(${field}),0) AS ${field}`).join(",")}
    FROM events${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}`).get(...params);
  return { totals: Object.fromEntries(fields.map((field) => [field, Number(row[field])])),
    eventCount: Number(row.events), sessionCount: Number(row.sessions) };
}

function singleArchiveCostDatabase(main, databaseFile, range) {
  if(range.preset!=="all")return null;
  const records=main.prepare("SELECT * FROM archive_segments").all();
  const meta=main.prepare("SELECT value FROM store_meta WHERE key=?");
  if(records.length!==1||meta.get("history_archive_event_revisions"))return null;
  const authorized=JSON.parse(meta.get("history_archive_event_authority")?.value??"null");
  if(authorized?.formatVersion!==1||authorized.segmentIds?.length!==1||authorized.segmentIds[0]!==records[0].segment_id)return null;
  const record=records[0],db=openReadonly(record.database_path);
  try{
    db.prepare("ATTACH DATABASE ? AS history_hot").run(`${pathToFileURL(databaseFile).href}?mode=ro`);
    const columns=db.prepare("PRAGMA history_hot.table_info(events)").all();
    const shape=rows=>JSON.stringify(rows.map(({name,type})=>[name,type]));
    if(shape(columns)!==shape(db.prepare("PRAGMA main.table_info(events)").all())){db.close();return null;}
    assert.equal(db.prepare("SELECT 1 FROM history_hot.events WHERE timestamp_ms>=? AND timestamp_ms<? LIMIT 1").get(record.start_ms,record.end_ms),undefined,"single archive overlaps hot facts");
    const quote=name=>`"${String(name).replaceAll('"','""')}"`;
    const hasCwd=columns.some(row=>row.name==="cwd");
    const selection=columns.map(({name})=>name==="project"&&hasCwd?"CASE WHEN cwd = '' THEN 'Unknown cwd' ELSE cwd END AS project":quote(name)).join(",");
    db.exec(`CREATE TEMP VIEW events AS SELECT ${selection} FROM history_hot.events UNION ALL SELECT ${selection} FROM main.events; BEGIN`);
    return db;
  }catch(error){db.close();throw error;}
}

function checkLedger(actual, dataset, delta, range, excludeHomes) {
  if (delta === undefined) return false;
  assert.ok(range.preset === "all" && !excludeHomes.length, "global ledger deltas require an unexcluded all range");
  assert.ok(Array.isArray(dataset.expected), "dataset.expected is required for ledger checks");
  if (typeof delta === "number") delta = { total: delta };
  for (const [field, value] of Object.entries(delta)) {
    if (field === "cacheWrite") continue;
    assert.ok([...fields, "events", "sessions"].includes(field) && Number.isSafeInteger(value), "invalid expectedDelta field");
    const baseline = field === "sessions" ? dataset.expectedSessions : dataset.expected.reduce((sum, row) => sum + Number(row[field]), 0);
    assert.ok(Number.isSafeInteger(baseline), `missing dataset baseline for ${field}`);
    const observed = field === "events" ? actual.eventCount : field === "sessions" ? actual.sessionCount : actual.totals[field];
    assert.equal(observed, baseline + value, `ledger expectation differs for ${field}`);
  }
  return true;
}

/** Read published SQL facts only; expectedDelta uses ledger.expected fields and overrides ledger when supplied.
 * Requires a current projection and a calendar response with its original catalog/asOf; never builds a missing projection.
 */
export async function verifyStabilityBody({ body, dataset, state, fullCost = true, expectedDelta, ledger,
  excludeHomes = [], sourceOptions = {} }) {
  const started = performance.now(), cpu = process.cpuUsage(), usage = process.resourceUsage(), memory = process.memoryUsage();
  const oracle = { costEvents: 0, aggregateQueries: 0, databasesOpened: 0, checkpointReads: 0, sourceImports: 0,
    rssBeforeBytes: memory.rss, heapBeforeBytes: memory.heapUsed, observedPeakRssBytes: memory.rss };
  const resources = () => {
    const after = process.resourceUsage(), consumed = process.cpuUsage(cpu), mem = process.memoryUsage();
    return { ...oracle, wallMs: performance.now() - started, cpuUserMs: consumed.user / 1000, cpuSystemMs: consumed.system / 1000,
      fsReadOperations: after.fsRead - usage.fsRead, fsWriteOperations: after.fsWrite - usage.fsWrite,
      rssAfterBytes: mem.rss, heapAfterBytes: mem.heapUsed, observedPeakRssBytes: Math.max(oracle.observedPeakRssBytes, mem.rss) };
  };
  let main, projection, costDatabase, outcome, failure;
  try {
    assert.ok(body?.summary && body.pricingCatalog?.version, "response summary and request pricingCatalog are required");
    assert.ok(!body.snapshotId, "frozen responses require their own frozen state");
    const range = responseRange(body);
    const asOf = new Date(body.periodComparison?.asOf ?? body.quota?.asOf ?? body.summary.quota?.asOf);
    assert.ok(Number.isFinite(asOf.getTime()), "response asOf is required to bind the publication day");
    const databaseFile = path.join(path.resolve(state), "usage-index.sqlite"), cache = `${databaseFile}.history-cache`;
    const options = { homeDir: dataset.home, env: {}, databaseFile,
      pricingFile: path.join(state, "pricing.json"), automaticPricingFile: path.join(state, "pricing-auto.json"),
      importStoreFile: path.join(state, "imports.json"), ...sourceOptions };
    const homes = body.metadata?.homes;
    assert.ok(Array.isArray(homes) && homes.every((home) => typeof home.path === "string"), "published metadata homes are required");
    const file = await pointer(cache), identity = await physicalIdentity(databaseFile);
    main = openReadonly(databaseFile); oracle.databasesOpened++;
    const mainVersion = main.prepare("PRAGMA data_version").get().data_version;
    const published = publication(main);
    if (!published.stamp || !published.fingerprint) throw retry("history publication stamp is unavailable");
    const routes = await dependencyRoutes(options, homes, published.fingerprint);
    if (!matchesResponse(body, published, routes, asOf)) throw retry("response and current facts/dependencies are different publications");
    projection = openReadonly(path.join(cache, file)); oracle.databasesOpened++;
    const projectionVersion = projection.prepare("PRAGMA data_version").get().data_version;
    projection.exec("BEGIN");
    const header = projection.prepare("SELECT * FROM usage_history_projection_cache WHERE singleton=1").get();
    if (header?.format !== 1 || header.status !== "ready" || header.source_identity !== identity ||
      !sameHistoryProjectionStamp(JSON.parse(header.inputs_json), published.stamp))
      throw retry("published projection does not match the response facts");
    const reader = new UsageStore({ databaseFile });
    reader.database = projection;
    reader.homes = homes;
    reader.historyDiskRead = reader.historyPersistentRead = true;
    const publishedHomes = reader.publishedUsageHomes();
    reader.historySourceKinds = homeSourceKinds(publishedHomes);
    for (const source of publishedHomes) {
      if (!homes.some((home) => ["id", "label", "path", "kind"].every((field) => home[field] === source[field])))
        throw retry("response and projection home identities differ");
    }
    reader.serviceTierEvidence = loadServiceTierEvidence(homes);
    const actual = aggregate(projection, range, excludeHomes); oracle.aggregateQueries++;
    if(fullCost){
      costDatabase=singleArchiveCostDatabase(main,databaseFile,range);
      oracle.costOrder=costDatabase?"hot-then-single-archive":"timestamp-history-ordinal";
      if(costDatabase){oracle.databasesOpened++;reader.database=costDatabase;reader.historyDiskRead=reader.historyPersistentRead=false;}
    }
    if (fullCost) actual.costEstimate = runWithPricingCatalog(body.pricingCatalog, () => {
      const pricing = createEventPricing(body.pricingCatalog.models);
      const accumulator = createCostEstimateAccumulator({ modelName: pricing.costModelName });
      for (const event of reader.costEventsForRange(range, excludeHomes)) {
        accumulator.add(event, pricing.estimate(event));
        oracle.costEvents++;
        if (oracle.costEvents % 4096 === 0) oracle.observedPeakRssBytes = Math.max(oracle.observedPeakRssBytes, process.memoryUsage.rss());
      }
      return accumulator.result();
    });
    if(costDatabase?.isTransaction)costDatabase.exec("ROLLBACK");
    projection.exec("ROLLBACK");
    const afterRoutes = await dependencyRoutes(options, homes, published.fingerprint);
    if (file !== await pointer(cache) || identity !== await physicalIdentity(databaseFile) ||
      mainVersion !== main.prepare("PRAGMA data_version").get().data_version ||
      projectionVersion !== projection.prepare("PRAGMA data_version").get().data_version ||
      JSON.stringify(publication(main)) !== JSON.stringify(published) || JSON.stringify(routes) !== JSON.stringify(afterRoutes))
      throw retry("publication changed during the oracle read");
    assert.deepEqual(actual.totals, body.summary.totals, "SQL totals differ from response");
    assert.equal(actual.eventCount, body.summary.eventCount, "SQL event count differs from response");
    assert.equal(actual.sessionCount, body.summary.sessionCount, "SQL distinct session count differs from response");
    if (fullCost) {
      assert.equal(oracle.costEvents, actual.eventCount, "cost stream did not cover every scoped fact");
      assert.deepEqual(actual.costEstimate, body.summary.costEstimate, "ordered legacy cost differs from response");
    }
    const ledgerChecked = checkLedger(actual, dataset, expectedDelta ?? ledger?.expected, range, excludeHomes);
    return outcome = { passed: true, ok: true, retry: false, checks: { totals: true, events: true, sessions: true, cost: Boolean(fullCost), ledger: ledgerChecked },
      actual, projection: { file: path.join(cache, file), stamp: published.stamp },
      publication: { fingerprint: body.fingerprint, usageVersion: body.usageVersion ?? null, generatedAt: published.generatedAt } };
  } catch (error) {
    if (error.oracleRetry || error.code === "ENOENT" || /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/.test(`${error.code} ${error.message}`))
      return outcome = { passed: false, ok: false, retry: true, reason: error.message };
    failure = error;
    throw error;
  } finally {
    costDatabase?.close();
    try { if (projection?.isTransaction) projection.exec("ROLLBACK"); }
    finally {
      try { projection?.close(); } finally {
        try { main?.close(); } finally {
          if (outcome) outcome.oracle = resources();
          if (failure) failure.oracle = resources();
        }
      }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(await readFile(process.argv[2], "utf8"));
  let result;
  try { result = await verifyStabilityBody(config); }
  catch (error) {
    result = { passed: false, ok: false, retry: false,
      error: { name: error.name, message: error.message, actual: error.actual, expected: error.expected }, oracle: error.oracle };
    process.exitCode = 1;
  }
  await writeFile(config.output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
}
