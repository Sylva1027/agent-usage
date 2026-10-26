import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { PERF_METHOD_VERSION } from "../src/perf-stats.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const COLD_END_MS = Date.parse("2026-10-04T12:02:00.000Z");
const EVENT_AUTHORITY_KEY = "history_archive_event_authority";
const PERF_AUTHORITY_KEY = "history_archive_perf_authority";
const INJECTED_FAILURE = "INJECTED_CODEX_REVISION_METADATA_FAILURE";
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

function hotAndRevisionState(database, sampleKey) {
  return {
    sample: database.prepare("SELECT * FROM perf_samples WHERE sample_key = ?").get(sampleKey),
    sampleSources: database
      .prepare("SELECT * FROM perf_sample_sources WHERE sample_key = ? ORDER BY source_path, role")
      .all(sampleKey),
    revisionMetadata: database
      .prepare("SELECT value FROM store_meta WHERE key = 'history_archive_perf_revisions'")
      .get()?.value,
    recoveryRows: database
      .prepare(
        `SELECT fact_table, source_path, payload_digest, occurrence_count, payload, recorded_at
         FROM history_replaced_facts
         WHERE fact_table IN ('perf_samples', 'perf_sample_sources')
         ORDER BY fact_table, source_path, payload_digest`,
      )
      .all(),
  };
}

function timingBoundaryState(database, homeId, responseId) {
  return {
    evidence: database
      .prepare(
        `SELECT * FROM perf_request_timing_evidence
         WHERE home_id = ? AND response_id = ?
         ORDER BY variant_key`,
      )
      .all(homeId, responseId),
    dirtyThreads: database
      .prepare("SELECT home_id, thread_id FROM perf_request_timing_dirty_threads ORDER BY home_id, thread_id")
      .all(),
    publicationMeta: database
      .prepare(
        `SELECT key, value FROM store_meta
         WHERE key IN ('perf_request_timing_published_revision', 'perf_request_timing_publication_seq')
         ORDER BY key`,
      )
      .all(),
  };
}

test("a revision metadata failure rolls back the whole Codex publication and retries cleanly", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const homeDir = fixture.serverOptions.homeDir;
  const archived = new UsageStore({
    ...fixture.serverOptions,
    databaseFile: path.join(homeDir, "cold-codex-revision-rollback-archived.sqlite"),
  });
  const oracle = new UsageStore({
    ...fixture.serverOptions,
    databaseFile: path.join(homeDir, "cold-codex-revision-rollback-oracle.sqlite"),
  });
  const candidateFile = path.join(homeDir, "cold-codex-revision-rollback-candidate.sqlite");
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
    const [, , threadId, turnId] = JSON.parse(coldSample.sampleKey);
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
      archived.database.exec("COMMIT");
    } catch (error) {
      archived.database.exec("ROLLBACK");
      throw error;
    }

    const archivedHomeId = codexHomeId(archived, fixture.codexHome);
    const oracleHomeId = codexHomeId(oracle, fixture.codexHome);
    const firstTiming = { ...baseTiming, durationMs: baseTiming.durationMs + 500 };
    archived.importRequestTimingEvidence({
      homeId: archivedHomeId,
      records: [firstTiming],
      reviewedOrigins: [firstTiming.evidenceOrigin],
    });
    oracle.importRequestTimingEvidence({
      homeId: oracleHomeId,
      records: [firstTiming],
      reviewedOrigins: [firstTiming.evidenceOrigin],
    });
    await archived.sync({ options: fixture.reportOptions });
    await oracle.sync({ options: fixture.reportOptions });

    const firstExpected = await oracle.summarizeHistory(FILTERS);
    const firstActual = await archived.summarizeHistory(FILTERS);
    assert.deepEqual(
      stablePerfEvidence(firstActual.perf),
      stablePerfEvidence(firstExpected.perf),
      "the first late evidence import must publish a valid typed delta",
    );
    const publishedState = hotAndRevisionState(archived.database, coldSample.sampleKey);
    assert.equal(typeof publishedState.revisionMetadata, "string");

    const secondTiming = { ...baseTiming, durationMs: baseTiming.durationMs + 750 };
    const secondTimingImport = archived.importRequestTimingEvidence({
      homeId: archivedHomeId,
      records: [secondTiming],
      reviewedOrigins: [secondTiming.evidenceOrigin],
    });
    oracle.importRequestTimingEvidence({
      homeId: oracleHomeId,
      records: [secondTiming],
      reviewedOrigins: [secondTiming.evidenceOrigin],
    });
    const importedState = timingBoundaryState(archived.database, archivedHomeId, responseId);
    const importedPublicationMeta = Object.fromEntries(
      importedState.publicationMeta.map((row) => [String(row.key), Number(row.value)]),
    );
    assert.ok(importedState.evidence.length > 0, "the second timing variant must create native evidence");
    assert.ok(
      importedState.dirtyThreads.some((row) => row.home_id === archivedHomeId && row.thread_id === threadId),
      "the imported timing variant must dirty the target thread",
    );
    assert.ok(
      Number(importedPublicationMeta.perf_request_timing_publication_seq) > 0 &&
        Number(importedPublicationMeta.perf_request_timing_published_revision) > 0,
      "the prior timing publication must expose non-zero sequence and revision counters",
    );
    archived.database.exec(`
      CREATE TRIGGER injected_revision_metadata_abort
      BEFORE UPDATE ON store_meta
      WHEN OLD.key = 'history_archive_perf_revisions'
      BEGIN
        SELECT RAISE(ABORT, '${INJECTED_FAILURE}');
      END
    `);

    const originalPrepare = DatabaseSync.prototype.prepare;
    let injectedFailureCount = 0;
    let injectedFailureMessage = "";
    DatabaseSync.prototype.prepare = function patchedPrepare(sql, ...args) {
      const statement = originalPrepare.call(this, sql, ...args);
      if (
        this !== archived.database ||
        !String(sql).includes("INSERT INTO store_meta") ||
        !String(sql).includes("ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      ) {
        return statement;
      }
      return {
        run(...params) {
          try {
            return statement.run(...params);
          } catch (error) {
            const message = String(error?.message ?? error);
            if (params[0] === "history_archive_perf_revisions" && message.includes(INJECTED_FAILURE)) {
              injectedFailureCount += 1;
              injectedFailureMessage = message;
            }
            throw error;
          }
        },
      };
    };
    let failedSync;
    let syncError;
    try {
      failedSync = await archived.sync({ options: fixture.reportOptions });
    } catch (error) {
      syncError = error;
    } finally {
      DatabaseSync.prototype.prepare = originalPrepare;
    }
    const failedPerfState = archived.perfState();
    assert.equal(syncError, undefined, "the home failure must be contained by the normal degraded sync path");
    assert.equal(injectedFailureCount, 1, "the named metadata trigger must fire exactly once");
    assert.match(injectedFailureMessage, new RegExp(INJECTED_FAILURE));
    assert.ok(
      failedSync?.degradedHomeIds.includes(archivedHomeId) === true,
      `the exact metadata failure must degrade the Codex home: ${JSON.stringify(failedSync)}`,
    );
    assert.ok(
      failedPerfState.sourceWarnings.some(
        (warning) => warning.homeId === archivedHomeId && warning.code === "READ_ONLY_OPEN_FAILED",
      ),
      "the failed publication must retain the existing encoded source warning",
    );
    assert.deepEqual(
      {
        hotAndRevision: hotAndRevisionState(archived.database, coldSample.sampleKey),
        timingBoundary: timingBoundaryState(archived.database, archivedHomeId, responseId),
      },
      {
        hotAndRevision: publishedState,
        timingBoundary: importedState,
      },
      "the failed publication must retain prior hot/revision/recovery facts and the independently imported dirty timing input",
    );

    archived.database.exec("DROP TRIGGER injected_revision_metadata_abort");
    await archived.sync({ options: fixture.reportOptions });
    await oracle.sync({ options: fixture.reportOptions });
    const expected = await oracle.summarizeHistory(FILTERS);
    const actual = await archived.summarizeHistory(FILTERS);
    assert.deepEqual(
      {
        candidateUnchanged: fileSha256(candidateFile) === candidateDigest,
        importChanged: secondTimingImport.changed,
        perf: stablePerfEvidence(actual.perf),
        recoveryRows: hotAndRevisionState(archived.database, coldSample.sampleKey).recoveryRows,
      },
      {
        candidateUnchanged: true,
        importChanged: true,
        perf: stablePerfEvidence(expected.perf),
        recoveryRows: publishedState.recoveryRows,
      },
      "retry without metadata repair must publish the full delta without duplicating recovery facts",
    );
  } finally {
    archived.close();
    oracle.close();
    fixture.close();
  }
});
