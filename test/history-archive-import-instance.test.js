import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createHistoryArchiveCandidate,
  loadHistoryArchiveImport,
  publishHistoryArchiveBundle,
} from "../src/history-archive.js";
import { getPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { savePricingFile } from "../src/pricing-store.js";
import { createHistoryArchiveImportServer, createUsageServer as createUsageServerBase } from "../src/server.js";
import { serviceTierEvidenceFromSnapshot } from "../src/service-tier-evidence.js";
import { UsageStore } from "../src/usage-store.js";

const START_MS = Date.parse("2026-10-02T03:04:05.000Z");
const END_MS = START_MS + 60_000;
const THREAD_ID = "import-instance-thread";

function createUsageServer(options = {}) {
  return createUsageServerBase({ pricingRefreshSchedulerEnabled: false, ...options });
}

function writeMeta(database, key, value) {
  database
    .prepare(
      `INSERT INTO store_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, JSON.stringify(value));
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function costEvidence(summary) {
  return summary.costEstimate;
}

function stablePerfEvidence(perf) {
  const evidence = structuredClone(perf);
  evidence.indexedAt = null;
  evidence.meta.indexedAt = null;
  return evidence;
}

async function summary(baseUrl) {
  const response = await fetch(`${baseUrl}/api/summary?preset=all&skipCheck=1`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).summary;
}

async function createFixture(root) {
  const sourceDirectory = path.join(root, "source");
  const databaseFile = path.join(sourceDirectory, "usage.sqlite");
  const candidateFile = path.join(sourceDirectory, "candidate.sqlite");
  const bundleDirectory = path.join(root, "bundle");
  const store = new UsageStore({ homeDir: sourceDirectory, databaseFile, importDirs: [] });
  try {
    await store.open();
    const sourcePath = path.join(sourceDirectory, "source.jsonl");
    store.database
      .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sourcePath, "codex", "home", "Home", sourceDirectory, 1, 1, "2026-10-02T03:05:00.000Z");
    store.database
      .prepare(
        `INSERT INTO events (
          source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
          hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sourcePath,
        START_MS,
        THREAD_ID,
        "home",
        "Home",
        "main",
        "project",
        "gpt-6-sol",
        "hour",
        "day",
        "week",
        "month",
        20,
        18,
        0,
        2,
        0,
      );
    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: START_MS,
      endMs: END_MS,
    });
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    writeMeta(store.database, "history_archive_event_authority", {
      formatVersion: 1,
      segmentIds: [registered.segmentId],
    });
    store.database.prepare("DELETE FROM events WHERE source_path = ?").run(sourcePath);
    return { databaseFile, candidateFile, bundleDirectory, registered, sourcePath };
  } finally {
    store.close();
  }
}

test("imported runtime adopts bundle pricing and tier evidence without changing the ordinary server", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-archive-import-instance-"));
  const importDirectory = path.join(root, "imported");
  const originalCatalog = getPricingCatalog();
  let sourceServer;
  let importedServer;
  let ordinaryServer;
  try {
    const fixture = await createFixture(root);
    const catalogAInput = {
      checkedAt: "2026-10-22",
      usdToCnyRate: originalCatalog.usdToCnyRate,
      models: structuredClone(originalCatalog.models),
    };
    const ratesA = catalogAInput.models["gpt-6-sol"];
    for (const rates of [ratesA.short, ratesA.long, ratesA.fast.short, ratesA.fast.long]) {
      rates.input += 1000;
      rates.cachedInput += 1000;
      rates.cacheWrite += 1000;
      rates.output += 1000;
    }
    const catalogA = setPricingCatalog(catalogAInput);

    const serviceTierEvidence = serviceTierEvidenceFromSnapshot({
      formatVersion: 1,
      threads: [{ threadId: THREAD_ID, turns: [{ time: START_MS, tier: "priority" }] }],
    });
    const sourceStore = new UsageStore({
      homeDir: root,
      databaseFile: fixture.databaseFile,
      importDirs: [],
    });
    let sourceSummary;
    let sourceCost;
    let sourcePerf;
    try {
      await sourceStore.open();
      sourceStore.serviceTierEvidence = serviceTierEvidence;
      sourceStore.homes = sourceStore.publishedUsageHomes();
      sourceSummary = await sourceStore.summarizeHistory({ preset: "all" });
      sourceCost = costEvidence(sourceSummary);
      sourcePerf = stablePerfEvidence(sourceSummary.perf);
    } finally {
      sourceStore.close();
    }
    assert.equal(sourceSummary.totals.total, 20);
    assert.equal(sourceCost.priceCheckedAt, "2026-10-22");
    assert.equal(sourceCost.serviceTierUnknownRecords, 0);

    const publisher = new UsageStore({
      homeDir: root,
      databaseFile: fixture.databaseFile,
      importDirs: [],
    });
    try {
      await publisher.open();
      await publishHistoryArchiveBundle(publisher.database, fixture.bundleDirectory, {
        serviceTierEvidence,
      });
    } finally {
      publisher.close();
    }

    sourceServer = createUsageServer({
      homeDir: root,
      databaseFile: fixture.databaseFile,
      importStoreFile: path.join(root, "source-imports.json"),
      automaticDiscoveryEnabled: false,
    });
    const sourceUrl = await listen(sourceServer);
    assert.equal((await fetch(`${sourceUrl}/api/pricing`)).status, 200);
    const importedResponse = await fetch(`${sourceUrl}/api/history/imports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceDirectory: fixture.bundleDirectory, importDirectory }),
    });
    assert.equal(importedResponse.status, 201, await importedResponse.clone().text());
    const loaded = await loadHistoryArchiveImport(importDirectory);
    assert.equal(loaded.context.pricingCatalog.version, catalogA.version);
    assert.equal(loaded.context.serviceTierEvidence.resolve(THREAD_ID, START_MS), "priority");
    await sourceServer.close();
    sourceServer = undefined;
    renameSync(fixture.databaseFile, `${fixture.databaseFile}.moved`);
    renameSync(fixture.candidateFile, `${fixture.candidateFile}.moved`);
    renameSync(fixture.bundleDirectory, `${fixture.bundleDirectory}.moved`);

    const catalogBInput = {
      checkedAt: "2026-10-23",
      usdToCnyRate: originalCatalog.usdToCnyRate,
      models: structuredClone(originalCatalog.models),
    };
    const ratesB = catalogBInput.models["gpt-6-sol"];
    for (const rates of [ratesB.short, ratesB.long, ratesB.fast.short, ratesB.fast.long]) {
      rates.input += 1;
      rates.cachedInput += 1;
      rates.cacheWrite += 1;
      rates.output += 1;
    }
    const catalogB = setPricingCatalog(catalogBInput);
    const pricingBFile = path.join(root, "pricing-B.json");
    await savePricingFile({ pricingFile: pricingBFile }, catalogB);

    importedServer = await createHistoryArchiveImportServer(importDirectory, {
      homeDir: root,
      importStoreFile: path.join(root, "imported-imports.json"),
      pricingFile: pricingBFile,
      automaticDiscoveryEnabled: false,
    });
    const importedUrl = await listen(importedServer);
    const importedPricingResponse = await fetch(`${importedUrl}/api/pricing`);
    assert.equal(importedPricingResponse.status, 200);
    assert.equal((await importedPricingResponse.json()).version, catalogA.version);
    const runtimeSummary = await summary(importedUrl);
    assert.deepEqual(runtimeSummary.totals, sourceSummary.totals);
    assert.deepEqual(costEvidence(runtimeSummary), sourceCost);
    assert.deepEqual(stablePerfEvidence(runtimeSummary.perf), sourcePerf);

    const fullDetailResponse = await fetch(`${importedUrl}/api/usage?detail=full&preset=all&skipCheck=1`);
    assert.equal(fullDetailResponse.status, 400);
    assert.equal((await fullDetailResponse.json()).code, "IMPORT_FULL_DETAIL_UNSUPPORTED");

    const importedPricingPut = await fetch(`${importedUrl}/api/pricing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(catalogB),
    });
    assert.equal(importedPricingPut.status, 405);
    assert.equal((await importedPricingPut.json()).code, "IMPORT_PRICING_READ_ONLY");
    assert.equal(
      (await fetch(`${importedUrl}/api/pricing`).then((response) => response.json())).version,
      catalogA.version,
    );

    const ordinaryDatabaseFile = path.join(root, "ordinary.sqlite");
    const ordinaryStore = new UsageStore({ homeDir: root, databaseFile: ordinaryDatabaseFile, importDirs: [] });
    try {
      await ordinaryStore.open();
      ordinaryStore.database
        .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(path.join(root, "ordinary-source.jsonl"), "codex", "home", "Home", root, 1, 1, "2026-10-02T03:05:00.000Z");
      ordinaryStore.database
        .prepare(
          `INSERT INTO events (
            source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
            hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          path.join(root, "ordinary-source.jsonl"),
          START_MS,
          "ordinary-thread",
          "home",
          "Home",
          "main",
          "project",
          "gpt-6-sol",
          "hour",
          "day",
          "week",
          "month",
          20,
          18,
          0,
          2,
          0,
        );
    } finally {
      ordinaryStore.close();
    }
    ordinaryServer = createUsageServer({
      homeDir: root,
      databaseFile: ordinaryDatabaseFile,
      importStoreFile: path.join(root, "ordinary-imports.json"),
      pricingFile: pricingBFile,
      automaticDiscoveryEnabled: false,
    });
    const ordinaryUrl = await listen(ordinaryServer);
    assert.equal((await (await fetch(`${ordinaryUrl}/api/pricing`)).json()).version, catalogB.version);
    assert.equal((await summary(ordinaryUrl)).costEstimate.priceCheckedAt, "2026-10-23");

    const frozenResponse = await fetch(`${importedUrl}/api/summary?preset=all&freeze=1&skipCheck=1`);
    assert.equal(frozenResponse.status, 200, await frozenResponse.clone().text());
    const frozen = await frozenResponse.json();
    assert.equal(frozen.summary.costEstimate.priceCheckedAt, "2026-10-22");
    assert.equal(frozen.summary.costEstimate.serviceTierUnknownRecords, 0);
    const frozenPricingResponse = await fetch(`${importedUrl}/api/pricing?snapshot=${frozen.snapshotId}`);
    assert.equal(frozenPricingResponse.status, 200);
    assert.equal((await frozenPricingResponse.json()).version, catalogA.version);

    const markerFile = path.join(importDirectory, "import.complete.json");
    const marker = readFileSync(markerFile, "utf8");
    writeFileSync(markerFile, "{");
    await assert.rejects(createHistoryArchiveImportServer(importDirectory), {
      code: "HISTORY_ARCHIVE_IMPORT_BAD_MARKER",
    });
    writeFileSync(markerFile, marker);
  } finally {
    setPricingCatalog(originalCatalog);
    await importedServer?.close();
    await ordinaryServer?.close();
    await sourceServer?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
