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
const PERF_REVISIONS_KEY = "history_archive_perf_revisions";
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

function replacePerfSample(database, sample) {
  const columns = Object.keys(sample).filter((column) => column !== "sample_key");
  database
    .prepare(
      `UPDATE perf_samples
       SET ${columns.map((column) => `${column} = ?`).join(", ")}
       WHERE sample_key = ?`,
    )
    .run(...columns.map((column) => sample[column]), sample.sample_key);
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

test("explicit perf revisions apply late timing without trusting an undeclared hot payload", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const homeDir = fixture.serverOptions.homeDir;
  const archived = new UsageStore({
    ...fixture.serverOptions,
    databaseFile: path.join(homeDir, "cold-perf-revision-archived.sqlite"),
  });
  const oracle = new UsageStore({
    ...fixture.serverOptions,
    databaseFile: path.join(homeDir, "cold-perf-revision-oracle.sqlite"),
  });
  const candidateFile = path.join(homeDir, "cold-perf-revision-candidate.sqlite");
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
    assert.equal(oldSampleRow.status, "completed");
    assert.equal(oldSampleRow.timing_kind, "generation");
    assert.equal(oldSampleRow.timing_source, "explicit");

    await createHistoryArchiveCandidate(archived.database, candidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });
    const candidateDatabase = new DatabaseSync(candidateFile, { readOnly: true });
    let candidateLinkedEvidence;
    try {
      candidateLinkedEvidence = linkedTimingEvidence(candidateDatabase, oldSampleRow.sample_key);
    } finally {
      candidateDatabase.close();
    }
    const originalLinkedEvidence = candidateLinkedEvidence.filter((row) => row.response_id === responseId);
    assert.ok(originalLinkedEvidence.length > 0, "the selected explicit sample must have candidate-native evidence");
    assert.ok(
      originalLinkedEvidence.length < candidateLinkedEvidence.length,
      "the missing-evidence counterexample must retain sibling response evidence",
    );
    assert.equal(
      new Set(
        originalLinkedEvidence.map((row) =>
          JSON.stringify([row.home_id, row.evidence_origin, row.response_id, row.variant_key]),
        ),
      ).size,
      originalLinkedEvidence.length,
      "each removed evidence payload must identify one immutable candidate row",
    );
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

    const lateTiming = {
      ...baseTiming,
      evidenceOrigin: "0-late@1",
      durationMs: baseTiming.durationMs + 500,
      generation: { ...baseTiming.generation, durationMs: baseTiming.generation.durationMs + 500 },
    };
    fixture.writeNativeTiming([lateTiming]);
    const archivedHomeId = codexHomeId(archived, fixture.codexHome);
    const oracleHomeId = codexHomeId(oracle, fixture.codexHome);
    archived.importRequestTimingEvidence({
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
    const oracleNewSampleRow = {
      ...oracle.database.prepare("SELECT * FROM perf_samples WHERE sample_key = ?").get(coldSample.sampleKey),
    };
    const syncedRevisionValue = archived.readMetaRaw(PERF_REVISIONS_KEY);
    assert.equal(typeof syncedRevisionValue, "string");
    const revision = JSON.parse(syncedRevisionValue);
    const sampleRevision = revision.revisions.find(
      (entry) =>
        entry.factTable === "perf_samples" &&
        entry.added.some((delta) => delta.payload.sample_key === oldSampleRow.sample_key),
    );
    const nativeMeasurementRevision = revision.revisions.find(
      (entry) =>
        entry.factTable === "codex_output_measurements" &&
        entry.added.some((delta) => delta.payload.sample_key === oldSampleRow.sample_key),
    );
    const timingRevision = revision.revisions.find((entry) => entry.factTable === "perf_request_timing_evidence");
    assert.ok(sampleRevision, "sync must generate the effective perf sample revision");
    assert.ok(nativeMeasurementRevision, "sync must generate the scalar native measurement revision");
    assert.ok(timingRevision, "sync must retain the external timing evidence revision");
    const nativeMeasurement = nativeMeasurementRevision.added.find(
      (delta) => delta.payload.sample_key === oldSampleRow.sample_key,
    );
    assert.ok(nativeMeasurement);
    assert.equal(nativeMeasurement.payload.home_id, oldSampleRow.home_id);
    assert.equal(nativeMeasurement.payload.source_path, oldSampleRow.source_path);
    assert.equal(nativeMeasurement.payload.measurement.outputTokens, oldSampleRow.output_tokens);
    assert.equal(nativeMeasurement.payload.measurement.durationMs, lateTiming.generation.durationMs);
    const sourceIdentity = { ...sampleRevision.sourceIdentity };

    archived.database.prepare("DELETE FROM store_meta WHERE key = ?").run(PERF_REVISIONS_KEY);

    await assert.rejects(
      archived.summarizeHistory(FILTERS),
      (error) => error.code === "HISTORY_ARCHIVE_PERF_SAMPLE_CONFLICT",
      "without an overlay the immutable cold sample must still conflict with the recomputed hot sample",
    );

    archived.database.exec("BEGIN IMMEDIATE");
    try {
      replacePerfSample(archived.database, oldSampleRow);
      writeMeta(archived.database, PERF_REVISIONS_KEY, revision);
      archived.database.exec("COMMIT");
    } catch (error) {
      archived.database.exec("ROLLBACK");
      throw error;
    }
    const actual = await archived.summarizeHistory(FILTERS);
    assert.deepEqual(
      stablePerfEvidence(actual.perf),
      stablePerfEvidence(expected.perf),
      "the explicit sample and timing deltas must match the unarchived oracle",
    );

    archived.database.exec("BEGIN IMMEDIATE");
    try {
      replacePerfSample(archived.database, oracleNewSampleRow);
      archived.database.exec("COMMIT");
    } catch (error) {
      archived.database.exec("ROLLBACK");
      throw error;
    }
    const deduplicated = await archived.summarizeHistory(FILTERS);
    assert.deepEqual(
      stablePerfEvidence(deduplicated.perf),
      stablePerfEvidence(expected.perf),
      "a hot sample equal to the final effective payload must deduplicate normally",
    );

    archived.database.exec("BEGIN IMMEDIATE");
    try {
      replacePerfSample(archived.database, { ...oracleNewSampleRow, duration_ms: oracleNewSampleRow.duration_ms + 1 });
      archived.database.exec("COMMIT");
    } catch (error) {
      archived.database.exec("ROLLBACK");
      throw error;
    }
    await assert.rejects(
      archived.summarizeHistory(FILTERS),
      (error) => error.code === "HISTORY_ARCHIVE_PERF_SAMPLE_CONFLICT",
      "a third hot payload for a revised sample key must still conflict",
    );

    const removedOnlyRevision = {
      formatVersion: 1,
      revisions: revision.revisions.map((entry) => (entry === sampleRevision ? { ...entry, added: [] } : entry)),
    };
    archived.database.exec("BEGIN IMMEDIATE");
    try {
      replacePerfSample(archived.database, oldSampleRow);
      writeMeta(archived.database, PERF_REVISIONS_KEY, removedOnlyRevision);
      archived.database.exec("COMMIT");
    } catch (error) {
      archived.database.exec("ROLLBACK");
      throw error;
    }
    await assert.rejects(
      archived.summarizeHistory(FILTERS),
      (error) =>
        error.code === "HISTORY_ARCHIVE_REVISION_INVALID" && error.message.includes(String(oldSampleRow.sample_key)),
      "removing a sample must not silently break its native Codex request facts",
    );

    const duplicateRemovalRevision = structuredClone(revision);
    const duplicateSampleRevision = duplicateRemovalRevision.revisions.find(
      (entry) =>
        entry.factTable === "perf_samples" &&
        entry.added.some((delta) => delta.payload.sample_key === oldSampleRow.sample_key),
    );
    assert.ok(duplicateSampleRevision);
    duplicateSampleRevision.removed.push(structuredClone(duplicateSampleRevision.removed[0]));
    archived.database.exec("BEGIN IMMEDIATE");
    try {
      replacePerfSample(archived.database, oldSampleRow);
      writeMeta(archived.database, PERF_REVISIONS_KEY, duplicateRemovalRevision);
      archived.database.exec("COMMIT");
    } catch (error) {
      archived.database.exec("ROLLBACK");
      throw error;
    }
    await assert.rejects(
      archived.summarizeHistory(FILTERS),
      (error) => error.code === "HISTORY_ARCHIVE_REVISION_INVALID",
      "repeated removed deltas must consume immutable candidate rows cumulatively",
    );

    const missingNativeMeasurementRevision = {
      formatVersion: 1,
      revisions: revision.revisions.filter((entry) => entry.factTable !== "codex_output_measurements"),
    };
    archived.database.exec("BEGIN IMMEDIATE");
    try {
      replacePerfSample(archived.database, oldSampleRow);
      writeMeta(archived.database, PERF_REVISIONS_KEY, missingNativeMeasurementRevision);
      archived.database.exec("COMMIT");
    } catch (error) {
      archived.database.exec("ROLLBACK");
      throw error;
    }
    await assert.rejects(
      archived.summarizeHistory(FILTERS),
      (error) =>
        error.code === "HISTORY_ARCHIVE_REVISION_INVALID" &&
        error.message.includes(String(oldSampleRow.sample_key)) &&
        /native|measurement|contradict/i.test(error.message),
      "an effective v6 Codex sample must retain its scalar native measurement revision",
    );

    const invalidSourceIdentity = { ...sourceIdentity, home_label: "wrong-home-label" };
    const invalidRevision = {
      ...revision,
      revisions: revision.revisions.map((entry) => ({ ...entry, sourceIdentity: invalidSourceIdentity })),
    };
    writeMeta(archived.database, PERF_REVISIONS_KEY, invalidRevision);
    await assert.rejects(
      archived.summarizeHistory(FILTERS),
      (error) => error.code === "HISTORY_ARCHIVE_REVISION_INVALID",
      "a revision must exactly bind its verified source identity",
    );

    const excessiveRemoval = structuredClone(revision);
    const excessiveSampleRevision = excessiveRemoval.revisions.find(
      (entry) =>
        entry.factTable === "perf_samples" &&
        entry.added.some((delta) => delta.payload.sample_key === oldSampleRow.sample_key),
    );
    assert.ok(excessiveSampleRevision);
    excessiveSampleRevision.removed[0].count = 2;
    writeMeta(archived.database, PERF_REVISIONS_KEY, excessiveRemoval);
    await assert.rejects(
      archived.summarizeHistory(FILTERS),
      (error) => error.code === "HISTORY_ARCHIVE_REVISION_INVALID",
      "a revision cannot remove more rows than the immutable candidate contains",
    );
    assert.equal(fileSha256(candidateFile), candidateDigest);
  } finally {
    archived.close();
    oracle.close();
    fixture.close();
  }
});
