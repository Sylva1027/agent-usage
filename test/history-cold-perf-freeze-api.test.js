import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { PERF_METHOD_VERSION, PERF_TOKEN_SCOPE } from "../src/perf-stats.js";
import { createUsageServer } from "../src/server.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture, createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

const EVENT_AUTHORITY_KEY = "history_archive_event_authority";
const PERF_AUTHORITY_KEY = "history_archive_perf_authority";
const HOT_START_MS = Date.parse("2026-10-04T12:00:00.000Z");
const CODEX_HOT_START_MS = Date.parse("2026-10-04T12:01:00.000Z");
const TOKENIZER = "o200k_base";
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

function installSchema3Measurements(fixture) {
  for (const filePath of fixture.rolloutFiles) {
    const rows = readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
    for (const row of rows) {
      if (row.type !== "token_usage_record") continue;
      const responseId = String(row.payload.response_id);
      const outputTokens = Number(row.payload.usage.output_tokens);
      const durationMs = responseId.startsWith("response-25-") ? 200_000 : 1_000;
      row.payload.generation_timing = {
        schema_version: 4,
        tokenizer: TOKENIZER,
        clock: "transport_receive",
        output_tokens: outputTokens,
        observed_duration_ms: durationMs,
        windows: [{ start_ms: 0, end_ms: durationMs, output_tokens: outputTokens }],
      };
    }
    writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  }
}

test("historical v5 perf authority stays self-contained in an HTTP snapshot after candidates move", async () => {
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
    assert.ok(coldSample, "fixture must expose a historical v5 ZCode sample");
    assert.equal(coldSample.sourceKind, "zcode");
    assert.equal(coldSample.methodVersion, "tps-v5");
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
            methodVersions: [coldSample.methodVersion],
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

test("Codex schema4 v6 perf stays self-contained in a frozen HTTP snapshot after cold candidates move", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const homeDir = fixture.serverOptions.homeDir;
  const archivedFile = path.join(homeDir, "codex-cold-perf-freeze-api-archived.sqlite");
  const oracleFile = path.join(homeDir, "codex-cold-perf-freeze-api-oracle.sqlite");
  const candidateFile = path.join(homeDir, "codex-cold-perf-freeze-api-candidate.sqlite");
  const candidateManifest = manifestPathFor(candidateFile);
  const archivedOptions = { ...fixture.serverOptions, databaseFile: archivedFile };
  const oracleOptions = {
    ...fixture.serverOptions,
    databaseFile: oracleFile,
    importStoreFile: path.join(homeDir, "codex-cold-perf-freeze-api-oracle-imports.json"),
  };
  const archived = new UsageStore(archivedOptions);
  const oracle = new UsageStore(oracleOptions);
  let server;
  try {
    installSchema3Measurements(fixture);
    await archived.sync({ options: archivedOptions });
    await oracle.sync({ options: oracleOptions });
    const oraclePerf = stablePerfEvidence((await oracle.summarizeHistory(FILTERS)).perf);
    const coldStartMs = Number(archived.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    const coldSample = archived
      .perfCandidatesForRange({ startMs: coldStartMs, endMs: CODEX_HOT_START_MS - 1 })
      .find((sample) => sample.status === "completed" && sample.outputTokens > 0 && sample.durationMs > 0);
    assert.ok(coldSample, "fixture must expose a measured cold schema4 sample");
    assert.equal(coldSample.sourceKind, "codex");
    assert.equal(coldSample.methodVersion, PERF_METHOD_VERSION);
    assert.equal(coldSample.tokenScope, PERF_TOKEN_SCOPE);
    assert.equal(coldSample.timingSource, "explicit");

    await createHistoryArchiveCandidate(archived.database, candidateFile, {
      startMs: coldStartMs,
      endMs: CODEX_HOT_START_MS,
    });
    const registered = await archived.registerHistoryArchiveCandidate(candidateFile);
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
            sourceKinds: ["codex"],
            methodVersions: [PERF_METHOD_VERSION],
          },
        ],
      });
      archived.database.prepare("DELETE FROM events WHERE timestamp_ms < ?").run(CODEX_HOT_START_MS);
      const deleted = archived.database
        .prepare("DELETE FROM perf_samples WHERE sample_key = ?")
        .run(coldSample.sampleKey);
      assert.equal(Number(deleted.changes), 1, "test must evict one cold schema4 sample");
      archived.database.exec("COMMIT");
    } catch (error) {
      archived.database.exec("ROLLBACK");
      throw error;
    }
    archived.close();
    oracle.close();

    server = createUsageServer({
      ...archivedOptions,
      importStoreFile: path.join(homeDir, "codex-cold-perf-freeze-api-imports.json"),
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
      "HTTP snapshot must include the complete schema4 v6 perf carrier",
    );

    renameSync(candidateFile, `${candidateFile}.moved`);
    renameSync(candidateManifest, `${candidateManifest}.moved`);
    const snapshotUrl = `${baseUrl}/api/usage?preset=all&calendarZone=utc&snapshot=${frozen.snapshotId}`;
    const retainedResponse = await fetch(snapshotUrl);
    const retainedText = await retainedResponse.text();
    assert.equal(retainedResponse.status, 200, retainedText);
    const retained = JSON.parse(retainedText);
    assert.equal(retained.snapshotId, frozen.snapshotId);
    assert.deepEqual(
      stablePerfEvidence(retained.summary.perf),
      oraclePerf,
      "the frozen snapshot must retain schema4 v6 perf after both candidate files move",
    );
  } finally {
    if (server) await server.close();
    archived.close();
    oracle.close();
    fixture.close();
  }
});
