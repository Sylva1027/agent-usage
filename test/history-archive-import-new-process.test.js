import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  createHistoryArchiveCandidate,
  loadHistoryArchiveImport,
  publishHistoryArchiveBundle,
  publishHistoryArchiveImport,
} from "../src/history-archive.js";
import { PERF_METHOD_VERSION } from "../src/perf-stats.js";
import { getPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { savePricingFile } from "../src/pricing-store.js";
import { serviceTierEvidenceFromSnapshot, serviceTierEvidenceSnapshot } from "../src/service-tier-evidence.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

const EVENT_AUTHORITY_KEY = "history_archive_event_authority";
const PERF_AUTHORITY_KEY = "history_archive_perf_authority";
const HOT_START_MS = Date.parse("2026-10-04T12:00:00.000Z");

const CHILD_SOURCE = `
const { loadPricingFile } = await import(process.env.PRICING_STORE_MODULE_URL);
const { getPricingCatalog } = await import(process.env.PRICING_MODULE_URL);
const { createHistoryArchiveImportServer } = await import(process.env.SERVER_MODULE_URL);
let server;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server?.close();
  process.exit(0);
}
try {
  await loadPricingFile({ pricingFile: process.env.PRICING_B_FILE });
  const ambientPricing = getPricingCatalog();
  server = await createHistoryArchiveImportServer(process.env.IMPORT_DIRECTORY, {
    homeDir: process.env.CHILD_HOME,
    importStoreFile: process.env.IMPORT_STORE_FILE,
    pricingFile: process.env.PRICING_B_FILE,
    automaticDiscoveryEnabled: false,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  console.log(\`A20_READY \${JSON.stringify({
    pid: process.pid,
    port: address.port,
    ambientPricingVersion: ambientPricing.version,
    ambientPricingCheckedAt: ambientPricing.checkedAt,
  })}\`);
  process.stdin.setEncoding("utf8");
  process.stdin.once("data", stop);
  process.once("SIGTERM", stop);
} catch (error) {
  console.error(error?.stack ?? String(error));
  process.exit(1);
}
`;

function writeMeta(database, key, value) {
  database
    .prepare(
      `INSERT INTO store_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, JSON.stringify(value));
}

function stablePerfEvidence(perf) {
  const evidence = structuredClone(perf);
  evidence.indexedAt = null;
  evidence.meta.indexedAt = null;
  return evidence;
}

function addRates(catalog, model, increment, fast = false) {
  const rates = catalog.models[model];
  for (const rate of fast ? [rates.fast.short, rates.fast.long] : [rates.short, rates.long]) {
    rate.input += increment;
    rate.cachedInput += increment;
    rate.cacheWrite += increment;
    rate.output += increment;
  }
}

function addFixtureModelPrices(catalog, standardIncrement, fastIncrement) {
  for (const model of ["small-model", "ranked-model"]) {
    catalog.models[model] = structuredClone(catalog.models["gpt-6-sol"]);
    addRates(catalog, model, standardIncrement);
    addRates(catalog, model, fastIncrement, true);
  }
}

async function prepareArchivedFixture(root) {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const databaseFile = path.join(root, "archive.sqlite");
  const candidateFile = path.join(root, "candidate.sqlite");
  const bundleDirectory = path.join(root, "bundle");
  const options = {
    ...fixture.serverOptions,
    databaseFile,
    importStoreFile: path.join(root, "source-imports.json"),
  };
  const store = new UsageStore(options);
  try {
    await store.sync({ options });
    const threads = store.database
      .prepare(
        `SELECT session_id AS threadId, MIN(timestamp_ms) AS time
         FROM events GROUP BY session_id ORDER BY session_id`,
      )
      .all()
      .map((row) => ({ threadId: String(row.threadId), time: Number(row.time) }));
    assert.ok(threads.length > 0, "real fixture must contain cost-bearing events");
    const serviceTierEvidence = serviceTierEvidenceFromSnapshot({
      formatVersion: 1,
      threads: threads.map(({ threadId, time }) => ({ threadId, turns: [{ time, tier: "priority" }] })),
    });
    const startMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    const endMs = HOT_START_MS;
    store.serviceTierEvidence = serviceTierEvidence;
    store.homes = store.publishedUsageHomes();
    const sourceSummary = await store.summarizeHistory({ preset: "all" });
    assert.ok(sourceSummary.perf.coverage.eligible > 0, "unarchived oracle must contain eligible perf records");
    assert.ok(sourceSummary.perf.coverage.sampled > 0, "unarchived oracle must contain real perf samples");
    const unplacedBefore = store.unplacedPerfSamples();
    const hotBefore = store.perfCandidatesForRange({ startMs: endMs, endMs: Number.MAX_SAFE_INTEGER });
    assert.ok(unplacedBefore.length > 0, "fixture must preserve unplaced perf rows outside the archive range");
    assert.ok(hotBefore.length > 0, "fixture must preserve positioned hot perf rows outside the archive range");

    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs,
      endMs,
    });
    const candidatePerf = store.perfCandidatesForRange({ startMs, endMs: endMs - 1 });
    assert.ok(
      candidatePerf.some((sample) => sample.status === "completed" && sample.durationMs > 0 && sample.outputTokens > 0),
      "candidate must contain a real positive duration/output perf sample",
    );
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    writeMeta(store.database, EVENT_AUTHORITY_KEY, {
      formatVersion: 1,
      segmentIds: [registered.segmentId],
    });
    writeMeta(store.database, PERF_AUTHORITY_KEY, {
      formatVersion: 1,
      segments: [
        {
          segmentId: registered.segmentId,
          databaseSha256: registered.databaseSha256,
          sourceKinds: ["zcode"],
          methodVersions: [PERF_METHOD_VERSION],
        },
      ],
    });
    store.database.exec("BEGIN IMMEDIATE");
    try {
      store.database.prepare("DELETE FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ?").run(startMs, endMs);
      store.database.prepare("DELETE FROM perf_samples WHERE ts_ms >= ? AND ts_ms < ?").run(startMs, endMs);
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }
    assert.deepEqual(store.unplacedPerfSamples(), unplacedBefore, "cold-range eviction must keep unplaced perf rows");
    assert.deepEqual(
      store.perfCandidatesForRange({ startMs: endMs, endMs: Number.MAX_SAFE_INTEGER }),
      hotBefore,
      "cold-range eviction must keep positioned hot perf rows",
    );

    const postStore = new UsageStore(options);
    let postEvictionSummary;
    try {
      await postStore.open();
      postStore.serviceTierEvidence = serviceTierEvidence;
      postStore.homes = postStore.publishedUsageHomes();
      postEvictionSummary = await postStore.summarizeHistory({ preset: "all" });
    } finally {
      postStore.close();
    }
    assert.deepEqual(postEvictionSummary.totals, sourceSummary.totals);
    assert.deepEqual(postEvictionSummary.costEstimate, sourceSummary.costEstimate);
    assert.deepEqual(
      stablePerfEvidence(postEvictionSummary.perf),
      stablePerfEvidence(sourceSummary.perf),
      "candidate carrier plus retained hot/unplaced perf must equal the unarchived oracle",
    );

    await publishHistoryArchiveBundle(store.database, bundleDirectory, { serviceTierEvidence });
    const sourcePaths = store.database
      .prepare("SELECT path FROM source_files ORDER BY path")
      .all()
      .map((row) => String(row.path));
    assert.ok(sourcePaths.length > 0, "fixture must expose real source files");
    return {
      bundleDirectory,
      candidateFile,
      databaseFile,
      fixture,
      options,
      serviceTierEvidence,
      sourcePaths,
      sourceSummary,
      retainedHotPerfCount: hotBefore.length,
      retainedUnplacedPerfCount: unplacedBefore.length,
    };
  } catch (error) {
    fixture.close();
    throw error;
  } finally {
    store.close();
  }
}

function startChildImportServer(scriptFile, environment) {
  const child = spawn(process.execPath, [scriptFile], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child server startup timeout\n${stderr}`)), 15_000);
    const inspect = () => {
      const match = stdout.match(/^A20_READY (.+)$/m);
      if (!match) return;
      clearTimeout(timer);
      resolve(JSON.parse(match[1]));
    };
    child.stdout.on("data", inspect);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`child server exited before ready: code=${code} signal=${signal}\n${stderr}`));
    });
  });
  return { child, ready, stderr: () => stderr };
}

async function stopChild(child) {
  if (child.exitCode !== null) {
    return { pid: child.pid, code: child.exitCode, signal: child.signalCode };
  }
  try {
    child.stdin.write("shutdown\n");
    child.stdin.end();
  } catch {
    // The exit state below is the authoritative cleanup result.
  }
  const exited = once(child, "exit").then(([code, signal]) => ({ pid: child.pid, code, signal }));
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 5_000));
  let result = await Promise.race([exited, timeout]);
  if (result === null) {
    child.kill();
    const [code, signal] = await once(child, "exit");
    result = { pid: child.pid, code, signal };
  }
  return result;
}

async function fetchSummary(baseUrl) {
  const response = await fetch(`${baseUrl}/api/summary?preset=all&skipCheck=1`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).summary;
}

test("an independent process serves the imported frozen cost, tier, totals, and non-empty perf", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-import-new-process-"));
  const importDirectory = path.join(root, "imported");
  const childHome = path.join(root, "child-home");
  const childScriptFile = path.join(root, "child-server.mjs");
  const originalCatalog = getPricingCatalog();
  let child;
  let cleanupEvidence;
  let fixture;
  try {
    mkdirSync(childHome);
    const catalogAInput = {
      checkedAt: "2026-10-22",
      usdToCnyRate: originalCatalog.usdToCnyRate,
      models: structuredClone(originalCatalog.models),
    };
    addFixtureModelPrices(catalogAInput, 1000, 2000);
    const ratesA = catalogAInput.models["small-model"];
    assert.notEqual(ratesA.fast.short.input, ratesA.short.input);
    const catalogA = setPricingCatalog(catalogAInput);
    const prepared = await prepareArchivedFixture(root);
    fixture = prepared.fixture;
    const sourceSummary = prepared.sourceSummary;
    t.diagnostic(
      `retained outside archive: hot perf=${prepared.retainedHotPerfCount} unplaced perf=${prepared.retainedUnplacedPerfCount}`,
    );
    assert.ok(sourceSummary.totals.total > 0);
    assert.ok(sourceSummary.perf.coverage.eligible > 0);
    assert.ok(sourceSummary.perf.coverage.sampled > 0);
    assert.ok(sourceSummary.costEstimate.pricedRecords > 0);
    assert.equal(sourceSummary.costEstimate.priceCheckedAt, "2026-10-22");
    assert.equal(sourceSummary.costEstimate.serviceTierUnknownRecords, 0);

    await publishHistoryArchiveImport(prepared.bundleDirectory, importDirectory);
    const loaded = await loadHistoryArchiveImport(importDirectory);
    assert.equal(loaded.context.pricingCatalog.version, catalogA.version);
    assert.deepEqual(
      serviceTierEvidenceSnapshot(loaded.context.serviceTierEvidence),
      serviceTierEvidenceSnapshot(prepared.serviceTierEvidence),
    );

    const catalogBInput = {
      checkedAt: "2026-10-23",
      usdToCnyRate: originalCatalog.usdToCnyRate,
      models: structuredClone(originalCatalog.models),
    };
    addFixtureModelPrices(catalogBInput, 3, 7);
    const catalogB = setPricingCatalog(catalogBInput);
    const bStore = new UsageStore(prepared.options);
    let bSummary;
    try {
      await bStore.open();
      bStore.serviceTierEvidence = prepared.serviceTierEvidence;
      bStore.homes = bStore.publishedUsageHomes();
      bSummary = await bStore.summarizeHistory({ preset: "all" });
    } finally {
      bStore.close();
    }
    assert.deepEqual(bSummary.totals, sourceSummary.totals);
    assert.equal(bSummary.costEstimate.priceCheckedAt, "2026-10-23");
    assert.notEqual(bSummary.costEstimate.totalUsd, sourceSummary.costEstimate.totalUsd);
    t.diagnostic(
      `perf eligible=${sourceSummary.perf.coverage.eligible} sampled=${sourceSummary.perf.coverage.sampled}; ` +
        `cost A=${sourceSummary.costEstimate.totalUsd} B=${bSummary.costEstimate.totalUsd}`,
    );

    const pricingBFile = path.join(root, "pricing-B.json");
    await savePricingFile({ pricingFile: pricingBFile }, catalogB);

    let movedSourceCount = 0;
    for (const sourcePath of new Set(prepared.sourcePaths)) {
      if (existsSync(sourcePath)) {
        renameSync(sourcePath, `${sourcePath}.a20-moved`);
        movedSourceCount += 1;
      }
      assert.equal(existsSync(sourcePath), false, `original source path must be absent: ${sourcePath}`);
    }
    assert.ok(movedSourceCount > 0, "test must move real original source files");
    t.diagnostic(`moved source files=${movedSourceCount}`);
    for (const originalPath of [prepared.databaseFile, prepared.candidateFile, prepared.bundleDirectory]) {
      if (existsSync(originalPath)) renameSync(originalPath, `${originalPath}.a20-moved`);
      assert.equal(existsSync(originalPath), false, `original path must be absent: ${originalPath}`);
    }

    writeFileSync(childScriptFile, CHILD_SOURCE);

    const started = startChildImportServer(childScriptFile, {
      CHILD_HOME: childHome,
      IMPORT_DIRECTORY: importDirectory,
      IMPORT_STORE_FILE: path.join(childHome, "imports.json"),
      PRICING_B_FILE: pricingBFile,
      PRICING_MODULE_URL: pathToFileURL(path.join(process.cwd(), "src", "pricing.js")).href,
      PRICING_STORE_MODULE_URL: pathToFileURL(path.join(process.cwd(), "src", "pricing-store.js")).href,
      SERVER_MODULE_URL: pathToFileURL(path.join(process.cwd(), "src", "server.js")).href,
    });
    child = started.child;
    const ready = await started.ready;
    assert.equal(ready.pid, child.pid);
    assert.notEqual(ready.pid, process.pid);
    assert.equal(ready.ambientPricingVersion, catalogB.version);
    assert.equal(ready.ambientPricingCheckedAt, catalogB.checkedAt);
    assert.notEqual(catalogB.checkedAt, catalogA.checkedAt);

    const baseUrl = `http://127.0.0.1:${ready.port}`;
    const pricingResponse = await fetch(`${baseUrl}/api/pricing`);
    assert.equal(pricingResponse.status, 200, await pricingResponse.clone().text());
    assert.equal((await pricingResponse.json()).version, catalogA.version);
    const importedSummary = await fetchSummary(baseUrl);
    assert.deepEqual(importedSummary.totals, sourceSummary.totals);
    assert.deepEqual(importedSummary.costEstimate, sourceSummary.costEstimate);
    assert.deepEqual(stablePerfEvidence(importedSummary.perf), stablePerfEvidence(sourceSummary.perf));
    assert.equal(importedSummary.costEstimate.priceCheckedAt, "2026-10-22");
    assert.equal(importedSummary.costEstimate.serviceTierUnknownRecords, 0);
    assert.ok(importedSummary.perf.coverage.sampled > 0);

    cleanupEvidence = await stopChild(child);
    child = undefined;
    assert.equal(cleanupEvidence.code, 0);
    t.diagnostic(`child pid=${cleanupEvidence.pid} exit=${cleanupEvidence.code}`);
  } finally {
    if (child) {
      cleanupEvidence = await stopChild(child).catch((error) => ({ error: error.message }));
      child = undefined;
    }
    if (cleanupEvidence) t.diagnostic(`child cleanup ${JSON.stringify(cleanupEvidence)}`);
    fixture?.close();
    setPricingCatalog(originalCatalog);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
