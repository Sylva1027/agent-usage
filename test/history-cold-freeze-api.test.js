import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { getPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { createUsageServer } from "../src/server.js";
import { UsageStore } from "../src/usage-store.js";

const COLD_TIME = "2026-07-12T02:00:00.000Z";
const HOT_TIME = "2026-07-12T02:01:00.000Z";
const COLD_MS = Date.parse(COLD_TIME);
const HOT_MS = Date.parse(HOT_TIME);
const SESSION_ID = "cold-freeze-api-session";

function tokenLine(timestamp, total, lastTotal) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: total,
          input_tokens: total - 20,
          cached_input_tokens: 0,
          output_tokens: 20,
          reasoning_output_tokens: 0,
        },
        last_token_usage: {
          total_tokens: lastTotal,
          input_tokens: lastTotal - 10,
          cached_input_tokens: 0,
          output_tokens: 10,
          reasoning_output_tokens: 0,
        },
      },
    },
  });
}

function sessionPrefix(codexHome) {
  return [
    JSON.stringify({
      type: "session_meta",
      payload: { id: SESSION_ID, source: "cli", cwd: codexHome },
    }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-sol" } }),
  ].join("\n");
}

function sourceOptions(root, codexHome) {
  return {
    homeDir: root,
    env: {},
    extraHomes: codexHome,
    importDirs: [],
    automaticDiscoveryEnabled: false,
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function keyFields(body) {
  return {
    summary: {
      total: body.summary.totals.total,
      eventCount: body.summary.eventCount,
      sessionCount: body.summary.sessionCount,
      homeCount: body.summary.homeCount,
    },
    metadata: {
      eventCount: body.metadata.eventCount,
      sessionCount: body.metadata.sessionCount,
      homeCount: body.metadata.homeCount,
      modelLastSeen: body.metadata.modelLastSeen,
    },
    period: {
      all: body.periodComparison.totals.all.total,
    },
  };
}

function costFields(summary) {
  return {
    totalUsd: summary.costEstimate.totalUsd,
    pricedTokens: summary.costEstimate.pricedTokens,
    priceCheckedAt: summary.costEstimate.priceCheckedAt,
  };
}

async function createArchivedFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "cold-freeze-api-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-cold-freeze.jsonl");
  const source = sourceOptions(root, codexHome);
  const segmentFile = path.join(root, "cold-segment.sqlite");
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(
      usageFile,
      `${sessionPrefix(codexHome)}\n${tokenLine(COLD_TIME, 100, 100)}\n${tokenLine(HOT_TIME, 130, 30)}\n`,
    );

    const oracle = new UsageStore({ ...source, databaseFile: path.join(root, "oracle.sqlite") });
    let oracleKeys;
    try {
      await oracle.sync({ options: source });
      const now = new Date();
      oracleKeys = keyFields({
        summary: oracle.summarize({ preset: "all", bucket: "day", calendarZone: "utc", now }),
        metadata: oracle.metadata(now),
        periodComparison: oracle.periodComparison({ now, calendarZone: "utc" }),
      });
    } finally {
      oracle.close();
    }

    const databaseFile = path.join(root, "usage-index.sqlite");
    const store = new UsageStore({ ...source, databaseFile });
    try {
      await store.sync({ options: source });
      await createHistoryArchiveCandidate(store.database, segmentFile, {
        startMs: COLD_MS,
        endMs: HOT_MS,
      });
      const registered = await store.registerHistoryArchiveCandidate(segmentFile);
      store.database
        .prepare("INSERT INTO store_meta (key, value) VALUES (?, ?)")
        .run(
          "history_archive_event_authority",
          JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }),
        );
      store.database.exec("BEGIN IMMEDIATE");
      try {
        store.database.prepare("DELETE FROM events WHERE source_path = ?").run(usageFile);
        store.database.exec("COMMIT");
      } catch (error) {
        store.database.exec("ROLLBACK");
        throw error;
      }
      store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(usageFile);
      await store.sync({ options: source });
    } finally {
      store.close();
    }

    return {
      root,
      segmentFile,
      oracleKeys,
      serverOptions: {
        ...source,
        databaseFile,
        importStoreFile: path.join(root, "imports.json"),
        heapSizeLimitBytes: 4 * 1024 * 1024 * 1024,
        pricingRefreshSchedulerEnabled: false,
      },
      close() {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    throw error;
  }
}

test("freeze and snapshot reads retain authorized cold history after the segment moves", async () => {
  const fixture = await createArchivedFixture();
  let server;
  try {
    server = createUsageServer(fixture.serverOptions);
    const baseUrl = await listen(server);
    const query = "preset=all&calendarZone=utc";
    const freezeResponse = await fetch(`${baseUrl}/api/summary?${query}&freeze=1`);
    const freezeText = await freezeResponse.text();
    assert.equal(freezeResponse.status, 200, freezeText);
    const frozen = JSON.parse(freezeText);
    assert.deepEqual(keyFields(frozen), fixture.oracleKeys, "freeze response");
    assert.equal(typeof frozen.snapshotId, "string");

    const snapshotUrl = `${baseUrl}/api/summary?${query}&snapshot=${frozen.snapshotId}`;
    const snapshotResponse = await fetch(snapshotUrl);
    const snapshotText = await snapshotResponse.text();
    assert.equal(snapshotResponse.status, 200, snapshotText);
    assert.deepEqual(keyFields(JSON.parse(snapshotText)), fixture.oracleKeys, "snapshot response");

    renameSync(fixture.segmentFile, `${fixture.segmentFile}.moved`);
    const movedResponse = await fetch(snapshotUrl);
    const movedText = await movedResponse.text();
    assert.equal(movedResponse.status, 200, movedText);
    assert.deepEqual(keyFields(JSON.parse(movedText)), fixture.oracleKeys, "snapshot after segment moved");

    const missingFreezeResponse = await fetch(`${baseUrl}/api/summary?${query}&freeze=1&skipCheck=1`);
    const missingFreezeText = await missingFreezeResponse.text();
    assert.equal(missingFreezeResponse.status, 500, missingFreezeText);
    const missingFreeze = JSON.parse(missingFreezeText);
    assert.equal(missingFreeze.code, "HISTORY_ARCHIVE_SEGMENT_NOT_FOUND");
    assert.equal(missingFreeze.summary, undefined, "a missing cold segment must not publish a hot-only summary");
    assert.notEqual(missingFreeze.summary?.totals?.total, 30);
    assert.notEqual(missingFreeze.summary?.totals?.total, 0);
  } finally {
    if (server) await server.close();
    fixture.close();
  }
});

test("cold HTTP freeze keeps catalog A costs after live pricing changes to B", async () => {
  const fixture = await createArchivedFixture();
  const originalCatalog = getPricingCatalog();
  const originalSummarizeHistoryReport = UsageStore.prototype.summarizeHistoryReport;
  let server;
  try {
    server = createUsageServer(fixture.serverOptions);
    const baseUrl = await listen(server);
    assert.equal((await fetch(`${baseUrl}/api/pricing`)).status, 200);

    const catalogAInput = structuredClone(originalCatalog);
    catalogAInput.checkedAt = "2026-10-22";
    const ratesA = catalogAInput.models["gpt-6-sol"];
    for (const rates of [ratesA.short, ratesA.long, ratesA.fast.short, ratesA.fast.long]) {
      rates.input += 1000;
      rates.cachedInput += 1000;
      rates.cacheWrite += 1000;
      rates.output += 1000;
    }
    const catalogA = setPricingCatalog(catalogAInput);

    const frozenResponse = await fetch(`${baseUrl}/api/summary?preset=all&calendarZone=utc&freeze=1&skipCheck=1`);
    const frozenText = await frozenResponse.text();
    assert.equal(frozenResponse.status, 200, frozenText);
    const frozen = JSON.parse(frozenText);
    const frozenCost = costFields(frozen.summary);
    assert.equal(frozen.summary.totals.total, 130);
    assert.ok(frozenCost.totalUsd > 0);
    assert.equal(frozenCost.priceCheckedAt, "2026-10-22");

    const catalogBInput = structuredClone(catalogA);
    catalogBInput.checkedAt = "2026-10-23";
    const ratesB = catalogBInput.models["gpt-6-sol"];
    for (const rates of [ratesB.short, ratesB.long, ratesB.fast.short, ratesB.fast.long]) {
      rates.input += 1000;
      rates.cachedInput += 1000;
      rates.cacheWrite += 1000;
      rates.output += 1000;
    }
    const catalogB = setPricingCatalog(catalogBInput);

    const liveResponse = await fetch(`${baseUrl}/api/summary?preset=all&calendarZone=utc&skipCheck=1`);
    assert.equal(liveResponse.status, 200);
    const liveCost = costFields((await liveResponse.json()).summary);
    assert.equal(liveCost.priceCheckedAt, "2026-10-23");
    assert.notEqual(liveCost.totalUsd, frozenCost.totalUsd);

    const snapshotUrl = `${baseUrl}/api/summary?preset=all&calendarZone=utc&snapshot=${frozen.snapshotId}`;
    const snapshotResponse = await fetch(snapshotUrl);
    assert.equal(snapshotResponse.status, 200);
    assert.deepEqual(costFields((await snapshotResponse.json()).summary), frozenCost);
    const snapshotPricing = await fetch(`${baseUrl}/api/pricing?snapshot=${frozen.snapshotId}`).then((response) =>
      response.json(),
    );
    assert.equal(snapshotPricing.version, catalogA.version);

    let failedStatus;
    let failedError;
    let catalogAfterFailure;
    UsageStore.prototype.summarizeHistoryReport = () => {
      throw new Error("INJECTED_COLD_SUMMARY_FAILURE");
    };
    try {
      const failedResponse = await fetch(snapshotUrl);
      failedStatus = failedResponse.status;
      failedError = (await failedResponse.json()).error;
      catalogAfterFailure = getPricingCatalog();
    } finally {
      UsageStore.prototype.summarizeHistoryReport = originalSummarizeHistoryReport;
    }
    assert.equal(failedStatus, 500);
    assert.equal(failedError, "INJECTED_COLD_SUMMARY_FAILURE");
    assert.deepEqual(catalogAfterFailure, catalogB);

    const recoveredSnapshot = await fetch(snapshotUrl).then((response) => response.json());
    assert.deepEqual(costFields(recoveredSnapshot.summary), frozenCost);
    const liveAfterRecovery = await fetch(`${baseUrl}/api/summary?preset=all&calendarZone=utc&skipCheck=1`).then(
      (response) => response.json(),
    );
    assert.deepEqual(costFields(liveAfterRecovery.summary), liveCost);
  } finally {
    UsageStore.prototype.summarizeHistoryReport = originalSummarizeHistoryReport;
    setPricingCatalog(originalCatalog);
    if (server) await server.close();
    fixture.close();
  }
});
