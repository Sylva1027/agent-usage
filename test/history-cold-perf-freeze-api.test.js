import assert from "node:assert/strict";
import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { PERF_METHOD_VERSION } from "../src/perf-stats.js";
import { createUsageServer } from "../src/server.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

const EVENT_AUTHORITY_KEY = "history_archive_event_authority";
const PERF_AUTHORITY_KEY = "history_archive_perf_authority";
const HOT_START_MS = Date.parse("2026-10-04T12:00:00.000Z");
const FILTERS = { preset: "all", now: "2026-10-04T13:00:00.000Z", calendarZone: "utc" };

function manifestPathFor(databaseFile) {
  const parsed = path.parse(databaseFile);
  return path.join(parsed.dir, `${parsed.name}.manifest.json`);
}

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

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test("cold perf authority stays self-contained in an HTTP snapshot after candidates move", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const homeDir = fixture.serverOptions.homeDir;
  const archivedFile = path.join(homeDir, "cold-perf-freeze-api-archived.sqlite");
  const oracleFile = path.join(homeDir, "cold-perf-freeze-api-oracle.sqlite");
  const candidateFile = path.join(homeDir, "cold-perf-freeze-api-candidate.sqlite");
  const candidateManifest = manifestPathFor(candidateFile);
  const archivedOptions = { ...fixture.serverOptions, databaseFile: archivedFile };
  const oracleOptions = {
    ...fixture.serverOptions,
    databaseFile: oracleFile,
    importStoreFile: path.join(homeDir, "cold-perf-freeze-api-oracle-imports.json"),
  };
  const archived = new UsageStore(archivedOptions);
  const oracle = new UsageStore(oracleOptions);
  let server;
  try {
    await archived.sync({ options: archivedOptions });
    await oracle.sync({ options: oracleOptions });
    const oraclePerf = stablePerfEvidence((await oracle.summarizeHistory(FILTERS)).perf);
    const coldStartMs = Number(archived.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    await createHistoryArchiveCandidate(archived.database, candidateFile, {
      startMs: coldStartMs,
      endMs: HOT_START_MS,
    });
    const registered = await archived.registerHistoryArchiveCandidate(candidateFile);
    const coldSample = archived
      .perfCandidatesForRange({ startMs: coldStartMs, endMs: HOT_START_MS - 1 })
      .find(
        (sample) =>
          sample.status === "completed" &&
          sample.outputTokens === null &&
          sample.durationMs === null &&
          sample.requestCount === 1,
      );
    assert.ok(coldSample, "fixture must expose a cold ZCode candidate with missing generation timing");
    assert.equal(coldSample.sourceKind, "zcode");
    assert.equal(coldSample.methodVersion, PERF_METHOD_VERSION);
    assert.equal(coldSample.timingKind, "generation");
    assert.equal(coldSample.tokenScope, "non_reasoning_output");
    assert.equal(coldSample.timingSource, "unknown");

    archived.database.exec("BEGIN IMMEDIATE");
    try {
      writeMeta(archived.database, EVENT_AUTHORITY_KEY, {
        formatVersion: 1,
        segmentIds: [registered.segmentId],
      });
      writeMeta(archived.database, PERF_AUTHORITY_KEY, {
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
      archived.database.prepare("DELETE FROM events WHERE timestamp_ms < ?").run(HOT_START_MS);
      const deleted = archived.database
        .prepare("DELETE FROM perf_samples WHERE sample_key = ?")
        .run(coldSample.sampleKey);
      assert.equal(Number(deleted.changes), 1, "test must evict one cold perf sample");
      archived.database.exec("COMMIT");
    } catch (error) {
      archived.database.exec("ROLLBACK");
      throw error;
    }
    archived.close();
    oracle.close();

    server = createUsageServer({
      ...archivedOptions,
      importStoreFile: path.join(homeDir, "cold-perf-freeze-api-imports.json"),
      heapSizeLimitBytes: 4 * 1024 * 1024 * 1024,
    });
    const baseUrl = await listen(server);
    const frozenResponse = await fetch(`${baseUrl}/api/usage?preset=all&calendarZone=utc&freeze=1`);
    const frozenText = await frozenResponse.text();
    assert.equal(frozenResponse.status, 200, frozenText);
    const frozen = JSON.parse(frozenText);
    assert.equal(typeof frozen.snapshotId, "string");
    assert.deepEqual(
      stablePerfEvidence(frozen.summary.perf),
      oraclePerf,
      "HTTP snapshot must initially include the complete cold perf carrier",
    );
    const liveDatabase = new DatabaseSync(archivedFile, { readOnly: true });
    try {
      assert.equal(
        liveDatabase.prepare("SELECT sample_key FROM perf_samples WHERE sample_key = ?").get(coldSample.sampleKey),
        undefined,
        "the server sync must not restore the evicted cold perf sample to hot",
      );
    } finally {
      liveDatabase.close();
    }

    renameSync(candidateFile, `${candidateFile}.moved`);
    renameSync(candidateManifest, `${candidateManifest}.moved`);
    assert.equal(existsSync(candidateFile), false);
    assert.equal(existsSync(candidateManifest), false);

    const snapshotUrl = `${baseUrl}/api/usage?preset=all&calendarZone=utc&snapshot=${frozen.snapshotId}`;
    const retainedResponse = await fetch(snapshotUrl);
    const retainedText = await retainedResponse.text();
    assert.equal(retainedResponse.status, 200, retainedText);
    const retained = JSON.parse(retainedText);
    assert.equal(retained.snapshotId, frozen.snapshotId);
    assert.deepEqual(
      stablePerfEvidence(retained.summary.perf),
      oraclePerf,
      "the same HTTP snapshot must retain perf after both original candidate files move",
    );

    const liveResponse = await fetch(`${baseUrl}/api/usage?preset=all&calendarZone=utc&freeze=1&skipCheck=1`);
    const liveText = await liveResponse.text();
    assert.equal(liveResponse.status, 500, liveText);
    const liveError = JSON.parse(liveText);
    assert.equal(liveError.code, "HISTORY_ARCHIVE_SEGMENT_NOT_FOUND");
    assert.equal(liveError.summary, undefined, "live failure must not publish a hot-only summary");
  } finally {
    if (server) await server.close();
    archived.close();
    oracle.close();
    fixture.close();
  }
});
