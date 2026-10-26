import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { PERF_METHOD_VERSION } from "../src/perf-stats.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const COLD_END_MS = Date.parse("2026-10-04T12:02:00.000Z");
const EVENT_AUTHORITY_KEY = "history_archive_event_authority";
const PERF_AUTHORITY_KEY = "history_archive_perf_authority";
const FILTERS = { preset: "all", now: "2026-10-04T13:00:00.000Z", calendarZone: "utc" };

function fileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
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

function codexHomeId(store, codexHome) {
  const home = store.homes.find((candidate) => path.resolve(candidate.path) === path.resolve(codexHome));
  assert.ok(home, "fixture must discover the Codex home");
  return String(home.id);
}

test("a late Codex timing revision follows a physically evicted cold sample", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const homeDir = fixture.serverOptions.homeDir;
  const archived = new UsageStore({
    ...fixture.serverOptions,
    databaseFile: path.join(homeDir, "cold-codex-evicted-late-timing-archived.sqlite"),
  });
  const oracle = new UsageStore({
    ...fixture.serverOptions,
    databaseFile: path.join(homeDir, "cold-codex-evicted-late-timing-oracle.sqlite"),
  });
  const candidateFile = path.join(homeDir, "cold-codex-evicted-late-timing-candidate.sqlite");
  try {
    await archived.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(archived);
    await oracle.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(oracle);

    const coldStartMs = Number(archived.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    const coldSample = archived
      .perfCandidatesForRange({ startMs: coldStartMs, endMs: COLD_END_MS })
      .find((sample) => sample.status === "completed" && sample.outputTokens > 0 && sample.durationMs > 0);
    assert.ok(coldSample, "fixture must expose a computable cold Codex perf sample");
    const [, , , turnId] = JSON.parse(coldSample.sampleKey);
    const turnNumber = Number(/^turn-(\d+)$/.exec(String(turnId))?.[1]);
    assert.ok(Number.isSafeInteger(turnNumber));
    const responseId = `response-${turnNumber}-1`;
    const baseTiming = fixture.timingRecords.find((record) => record.responseId === responseId);
    assert.ok(baseTiming, "the selected cold sample must have native timing evidence");

    await createHistoryArchiveCandidate(archived.database, candidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });
    const candidateDigest = fileSha256(candidateFile);
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
      archived.database.prepare("DELETE FROM events WHERE timestamp_ms < ?").run(COLD_END_MS);
      archived.database.prepare("DELETE FROM perf_samples WHERE sample_key = ?").run(coldSample.sampleKey);
      archived.database.exec("COMMIT");
    } catch (error) {
      archived.database.exec("ROLLBACK");
      throw error;
    }

    const archivedHomeId = codexHomeId(archived, fixture.codexHome);
    const oracleHomeId = codexHomeId(oracle, fixture.codexHome);
    const retained = {
      evicted: archived.database
        .prepare("SELECT 1 AS present FROM perf_samples WHERE sample_key = ?")
        .get(coldSample.sampleKey),
      rolloutOwners: Number(
        archived.database
          .prepare("SELECT COUNT(*) AS count FROM perf_rollout_threads WHERE home_id = ?")
          .get(archivedHomeId).count,
      ),
      timingLinks: Number(
        archived.database
          .prepare("SELECT COUNT(*) AS count FROM perf_request_timing_threads WHERE home_id = ? AND response_id = ?")
          .get(archivedHomeId, responseId).count,
      ),
      timingEvidence: Number(
        archived.database
          .prepare("SELECT COUNT(*) AS count FROM perf_request_timing_evidence WHERE home_id = ? AND response_id = ?")
          .get(archivedHomeId, responseId).count,
      ),
    };
    assert.deepEqual(
      retained,
      { evicted: undefined, rolloutOwners: 3, timingLinks: 1, timingEvidence: 1 },
      "the fixture must physically evict only the cold sample and retain its native dependency graph",
    );

    const beforeOracle = await oracle.summarizeHistory(FILTERS);
    const beforeArchived = await archived.summarizeHistory(FILTERS);
    assert.deepEqual(
      stablePerfEvidence(beforeArchived.perf),
      stablePerfEvidence(beforeOracle.perf),
      "the evicted cold sample must be recovered from the authorized segment before the late revision",
    );

    const lateTiming = { ...baseTiming, durationMs: baseTiming.durationMs + 500 };
    const archivedTimingImport = archived.importRequestTimingEvidence({
      homeId: archivedHomeId,
      records: [lateTiming],
      reviewedOrigins: [lateTiming.evidenceOrigin],
    });
    oracle.importRequestTimingEvidence({
      homeId: oracleHomeId,
      records: [lateTiming],
      reviewedOrigins: [lateTiming.evidenceOrigin],
    });
    await archived.sync({ options: fixture.reportOptions });
    await oracle.sync({ options: fixture.reportOptions });

    const expected = await oracle.summarizeHistory(FILTERS);
    let actual;
    try {
      actual = await archived.summarizeHistory(FILTERS);
    } catch (error) {
      const revisionValue = archived.database
        .prepare("SELECT value FROM store_meta WHERE key = 'history_archive_perf_revisions'")
        .get()?.value;
      const revisions = revisionValue === undefined ? [] : JSON.parse(String(revisionValue)).revisions;
      const evictedSampleRevised = revisions.some(
        (entry) =>
          entry.factTable === "perf_samples" &&
          [...entry.removed, ...entry.added].some((delta) => delta.payload.sample_key === coldSample.sampleKey),
      );
      assert.fail(
        `an evicted cold sample must follow a late timing revision, got ${error?.code ?? "(none)"}: ${
          error?.message ?? error
        }; revisions=${revisionValue === undefined ? "missing" : "present"}; evictedSampleRevised=${
          evictedSampleRevised
        }; candidateUnchanged=${fileSha256(candidateFile) === candidateDigest}`,
      );
    }
    assert.deepEqual(
      {
        candidateUnchanged: fileSha256(candidateFile) === candidateDigest,
        importChanged: archivedTimingImport.changed,
        perf: stablePerfEvidence(actual.perf),
      },
      {
        candidateUnchanged: true,
        importChanged: true,
        perf: stablePerfEvidence(expected.perf),
      },
      "the late revision must automatically overlay the evicted cold sample without changing the segment",
    );

    const revisionMetadata = archived.database
      .prepare("SELECT value FROM store_meta WHERE key = 'history_archive_perf_revisions'")
      .get()?.value;
    const recoveryRows = archived.database
      .prepare(
        `SELECT fact_table, source_path, payload_digest, occurrence_count, payload, recorded_at
         FROM history_replaced_facts
         WHERE fact_table IN ('perf_samples', 'perf_sample_sources')
         ORDER BY fact_table, source_path, payload_digest`,
      )
      .all();
    await archived.sync({ options: fixture.reportOptions });
    const stableAfterNoop = await archived.summarizeHistory(FILTERS);
    assert.deepEqual(
      {
        candidateDigest: fileSha256(candidateFile),
        perf: stablePerfEvidence(stableAfterNoop.perf),
        recoveryRows: archived.database
          .prepare(
            `SELECT fact_table, source_path, payload_digest, occurrence_count, payload, recorded_at
             FROM history_replaced_facts
             WHERE fact_table IN ('perf_samples', 'perf_sample_sources')
             ORDER BY fact_table, source_path, payload_digest`,
          )
          .all(),
        revisionMetadata: archived.database
          .prepare("SELECT value FROM store_meta WHERE key = 'history_archive_perf_revisions'")
          .get()?.value,
      },
      {
        candidateDigest,
        perf: stablePerfEvidence(expected.perf),
        recoveryRows,
        revisionMetadata,
      },
      "a same-content sync must keep the overlay, recovery facts, and original segment stable",
    );
  } finally {
    archived.close();
    oracle.close();
    fixture.close();
  }
});
