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

function linkedTimingEvidence(database, sampleKey) {
  return database
    .prepare(
      `SELECT DISTINCT evidence.*
       FROM perf_sample_sources AS dependencies
       JOIN perf_rollout_threads AS owners ON owners.source_path = dependencies.source_path
       JOIN perf_request_timing_threads AS timing
         ON timing.home_id = owners.home_id AND timing.thread_id = owners.thread_id
       JOIN perf_request_timing_evidence AS evidence
         ON evidence.home_id = timing.home_id AND evidence.response_id = timing.response_id
       WHERE dependencies.sample_key = ?
       ORDER BY evidence.home_id, evidence.evidence_origin, evidence.response_id, evidence.variant_key`,
    )
    .all(String(sampleKey))
    .map((row) => ({ ...row }));
}

function sortRevisionEvidence(rows) {
  return [...rows].sort(
    (left, right) =>
      String(left.payload?.evidence_origin ?? "").localeCompare(String(right.payload?.evidence_origin ?? "")) ||
      String(left.payload?.response_id ?? "").localeCompare(String(right.payload?.response_id ?? "")) ||
      String(left.payload?.variant_key ?? "").localeCompare(String(right.payload?.variant_key ?? "")),
  );
}

function codexHomeId(store, codexHome) {
  const home = store.homes.find((candidate) => path.resolve(candidate.path) === path.resolve(codexHome));
  assert.ok(home, "fixture must discover the Codex home");
  return String(home.id);
}

test("a late native Codex timing revision revises the authorized cold perf sample", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const homeDir = fixture.serverOptions.homeDir;
  const archivedDatabaseFile = path.join(homeDir, "cold-codex-late-timing-archived.sqlite");
  const archived = new UsageStore({
    ...fixture.serverOptions,
    databaseFile: archivedDatabaseFile,
  });
  const oracle = new UsageStore({
    ...fixture.serverOptions,
    databaseFile: path.join(homeDir, "cold-codex-late-timing-oracle.sqlite"),
  });
  const candidateFile = path.join(homeDir, "cold-codex-late-timing-candidate.sqlite");
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
    const [, , , , responseId] = JSON.parse(coldSample.sampleKey);
    assert.equal(typeof responseId, "string");
    const baseTiming = fixture.timingRecords.find((record) => record.responseId === responseId);
    assert.ok(baseTiming, "the selected cold sample must have native timing evidence");
    const oldSampleRow = {
      ...archived.database.prepare("SELECT * FROM perf_samples WHERE sample_key = ?").get(coldSample.sampleKey),
    };

    await createHistoryArchiveCandidate(archived.database, candidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });
    const candidateDigest = fileSha256(candidateFile);
    const candidateDatabase = new DatabaseSync(candidateFile, { readOnly: true });
    let candidateTimingEvidence;
    try {
      candidateTimingEvidence = linkedTimingEvidence(candidateDatabase, coldSample.sampleKey);
    } finally {
      candidateDatabase.close();
    }
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

    const lateTiming = {
      ...baseTiming,
      evidenceOrigin: "0-late@1",
      durationMs: baseTiming.durationMs + 500,
      generation: { ...baseTiming.generation, durationMs: baseTiming.generation.durationMs + 500 },
    };
    fixture.writeNativeTiming([lateTiming]);
    const archivedHomeId = codexHomeId(archived, fixture.codexHome);
    const oracleHomeId = codexHomeId(oracle, fixture.codexHome);
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
    const concurrentDatabase = new DatabaseSync(archivedDatabaseFile);
    let mutationError = null;
    concurrentDatabase.exec("PRAGMA busy_timeout = 1");
    const mutateMeta = concurrentDatabase.prepare(
      `INSERT INTO store_meta (key, value) VALUES ('__perf_revision_input_race', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    let mutation = 0;
    const mutationTimer = setInterval(() => {
      try {
        mutateMeta.run(String(++mutation));
      } catch (error) {
        if (!/busy|locked/i.test(String(error?.message ?? error))) mutationError ??= error;
      }
    }, 1);
    try {
      await assert.rejects(
        archived.sync({ options: fixture.reportOptions }),
        (error) => error?.code === "HISTORY_ARCHIVE_PERF_REVISION_INPUT_CHANGED",
        "an external commit during candidate verification must reject for a clean retry",
      );
    } finally {
      clearInterval(mutationTimer);
      concurrentDatabase.close();
    }
    assert.ifError(mutationError);
    assert.ok(mutation > 0, "the race test must commit at least one external metadata change");

    await archived.sync({ options: fixture.reportOptions });
    await oracle.sync({ options: fixture.reportOptions });

    const replacedPayloads = archived.database
      .prepare(
        `SELECT payload FROM history_replaced_facts
         WHERE fact_table = 'perf_samples' AND source_path = ?
         ORDER BY recorded_at, payload_digest`,
      )
      .all(String(oldSampleRow.source_path))
      .map((row) => JSON.parse(String(row.payload)));
    const expected = await oracle.summarizeHistory(FILTERS);
    const oracleNewSampleRow = {
      ...oracle.database.prepare("SELECT * FROM perf_samples WHERE sample_key = ?").get(coldSample.sampleKey),
    };
    const archivedNewSampleRow = {
      ...archived.database.prepare("SELECT * FROM perf_samples WHERE sample_key = ?").get(coldSample.sampleKey),
    };
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
    assert.equal(typeof revisionMetadata, "string");
    assert.deepEqual(
      {
        candidateDigest: fileSha256(candidateFile),
        importChanged: archivedTimingImport.changed,
        oldSamplePayload: replacedPayloads.find(
          (payload) => payload.sample_key === coldSample.sampleKey && payload.duration_ms === oldSampleRow.duration_ms,
        ),
      },
      { candidateDigest, importChanged: true, oldSamplePayload: oldSampleRow },
      "the late revision must preserve the immutable segment and retain the replaced effective sample",
    );
    assert.deepEqual(
      {
        differsFromOld: JSON.stringify(oracleNewSampleRow) !== JSON.stringify(oldSampleRow),
        archivedNewSampleRow,
      },
      { differsFromOld: true, archivedNewSampleRow: oracleNewSampleRow },
      "the archived live recomputation must equal the oracle's real post-revision sample",
    );

    let actual;
    try {
      actual = await archived.summarizeHistory(FILTERS);
    } catch (error) {
      assert.fail(
        `late timing revision must merge with the authorized cold sample, got ${error?.code ?? "(none)"}: ${
          error?.message ?? error
        }`,
      );
    }
    assert.deepEqual(
      stablePerfEvidence(actual.perf),
      stablePerfEvidence(expected.perf),
      "late timing revision must match the unarchived oracle perf",
    );

    await archived.sync({ options: fixture.reportOptions });
    assert.deepEqual(
      {
        candidateDigest: fileSha256(candidateFile),
        revisionMetadata: archived.database
          .prepare("SELECT value FROM store_meta WHERE key = 'history_archive_perf_revisions'")
          .get()?.value,
        recoveryRows: archived.database
          .prepare(
            `SELECT fact_table, source_path, payload_digest, occurrence_count, payload, recorded_at
             FROM history_replaced_facts
             WHERE fact_table IN ('perf_samples', 'perf_sample_sources')
             ORDER BY fact_table, source_path, payload_digest`,
          )
          .all(),
      },
      { candidateDigest, revisionMetadata, recoveryRows },
      "a no-op sync must not rewrite the revision metadata, recovery facts, or immutable candidate",
    );

    const secondLateTiming = {
      ...baseTiming,
      evidenceOrigin: "0-late@0",
      durationMs: baseTiming.durationMs + 750,
      generation: { ...baseTiming.generation, durationMs: baseTiming.generation.durationMs + 750 },
    };
    fixture.writeNativeTiming([secondLateTiming]);
    const secondTimingImport = archived.importRequestTimingEvidence({
      homeId: archivedHomeId,
      records: [secondLateTiming],
      reviewedOrigins: [secondLateTiming.evidenceOrigin],
    });
    oracle.importRequestTimingEvidence({
      homeId: oracleHomeId,
      records: [secondLateTiming],
      reviewedOrigins: [secondLateTiming.evidenceOrigin],
    });
    await archived.sync({ options: fixture.reportOptions });
    await oracle.sync({ options: fixture.reportOptions });

    const candidateEvidenceKeys = new Set(
      candidateTimingEvidence.map((row) =>
        JSON.stringify([row.home_id, row.evidence_origin, row.response_id, row.variant_key]),
      ),
    );
    const expectedTimingAdded = linkedTimingEvidence(oracle.database, coldSample.sampleKey)
      .filter(
        (row) =>
          !candidateEvidenceKeys.has(
            JSON.stringify([row.home_id, row.evidence_origin, row.response_id, row.variant_key]),
          ),
      )
      .map((payload) => ({ payload, count: 1 }));
    const secondRevisionValue = archived.database
      .prepare("SELECT value FROM store_meta WHERE key = 'history_archive_perf_revisions'")
      .get()?.value;
    const secondRevisions = JSON.parse(String(secondRevisionValue)).revisions.filter(
      (entry) => entry.segmentId === registered.segmentId,
    );
    const secondTimingRevision = secondRevisions.find((entry) => entry.factTable === "perf_request_timing_evidence");
    const secondSampleRevision = secondRevisions.find((entry) => entry.factTable === "perf_samples");
    const previousTimingRevision = JSON.parse(String(revisionMetadata)).revisions.find(
      (entry) => entry.segmentId === registered.segmentId && entry.factTable === "perf_request_timing_evidence",
    );
    const secondExpected = await oracle.summarizeHistory(FILTERS);
    const secondActual = await archived.summarizeHistory(FILTERS);
    assert.deepEqual(
      {
        candidateDigest: fileSha256(candidateFile),
        importChanged: secondTimingImport.changed,
        sampleAdded: secondSampleRevision.added,
        sourceIdentity: secondTimingRevision.sourceIdentity,
        timingAdded: sortRevisionEvidence(secondTimingRevision.added),
      },
      {
        candidateDigest,
        importChanged: true,
        sampleAdded: [
          {
            payload: {
              ...oracle.database.prepare("SELECT * FROM perf_samples WHERE sample_key = ?").get(coldSample.sampleKey),
            },
            count: 1,
          },
        ],
        sourceIdentity: previousTimingRevision.sourceIdentity,
        timingAdded: sortRevisionEvidence(expectedTimingAdded),
      },
      "a second late evidence variant must retain its real payload and cumulative revision metadata",
    );
    assert.deepEqual(
      stablePerfEvidence(secondActual.perf),
      stablePerfEvidence(secondExpected.perf),
      "the second late evidence import must remain equal to the unarchived oracle",
    );
  } finally {
    archived.close();
    oracle.close();
    fixture.close();
  }
});
