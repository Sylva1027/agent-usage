import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate, readCodexNativeMeasurements } from "../src/history-archive.js";
import { OUTPUT_TIME_RESOLUTION_MS } from "../src/perf-output-tokens.js";
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

function writeSampleAndRevision(database, sample, revision) {
  database.exec("BEGIN IMMEDIATE");
  try {
    replacePerfSample(database, sample);
    writeMeta(database, PERF_REVISIONS_KEY, revision);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
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

function codexRequestFacts(database) {
  const rows = database
    .prepare("SELECT key, value FROM store_meta WHERE key GLOB 'history_archive_codex_*_v1' ORDER BY key")
    .all()
    .map((row) => ({ key: String(row.key), value: String(row.value) }));
  assert.equal(rows.length, 1, "the candidate must expose one Codex request-facts component");
  return rows[0];
}

function timingEvidence(database, homeId, responseId) {
  return database
    .prepare(
      `SELECT *
       FROM perf_request_timing_evidence
       WHERE home_id = ? AND response_id = ?
       ORDER BY evidence_origin, variant_key`,
    )
    .all(homeId, responseId)
    .map((row) => ({ ...row }));
}

function factRevision(root, factTable, sampleKey) {
  const matches = root.revisions.filter(
    (entry) =>
      entry.factTable === factTable &&
      [...entry.removed, ...entry.added].some((delta) => String(delta.payload.sample_key) === sampleKey),
  );
  assert.equal(matches.length, 1, `the late timing revision must contain exactly one ${factTable} entry`);
  return matches[0];
}

function sampleRevision(root, sampleKey) {
  return factRevision(root, "perf_samples", sampleKey);
}

test("an effective typed Codex perf revision cannot contradict unchanged native timing", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const homeDir = fixture.serverOptions.homeDir;
  const archived = new UsageStore({
    ...fixture.serverOptions,
    databaseFile: path.join(homeDir, "cold-codex-effective-numeric-archived.sqlite"),
  });
  const oracle = new UsageStore({
    ...fixture.serverOptions,
    databaseFile: path.join(homeDir, "cold-codex-effective-numeric-oracle.sqlite"),
  });
  const candidateFile = path.join(homeDir, "cold-codex-effective-numeric-candidate.sqlite");
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
    const coldSampleRow = {
      ...archived.database.prepare("SELECT * FROM perf_samples WHERE sample_key = ?").get(coldSample.sampleKey),
    };
    assert.equal(coldSampleRow.method_version, PERF_METHOD_VERSION);
    const siblingSampleKey = String(
      archived.database
        .prepare(
          `SELECT sample_key
           FROM perf_samples
           WHERE home_id = ? AND source_path = ? AND sample_key <> ?
           ORDER BY sample_key
           LIMIT 1`,
        )
        .get(coldSampleRow.home_id, coldSampleRow.source_path, coldSampleRow.sample_key).sample_key,
    );
    assert.notEqual(siblingSampleKey, coldSample.sampleKey);
    assert.notEqual(JSON.parse(siblingSampleKey)[4], responseId);

    await createHistoryArchiveCandidate(archived.database, candidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });
    const candidateDigest = fileSha256(candidateFile);
    const candidateDatabase = new DatabaseSync(candidateFile, { readOnly: true });
    let requestFacts;
    let candidateNativeMeasurements;
    try {
      requestFacts = codexRequestFacts(candidateDatabase);
      candidateNativeMeasurements = readCodexNativeMeasurements(
        candidateDatabase,
        candidateDatabase.prepare("SELECT * FROM perf_samples ORDER BY sample_key").all(),
      );
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
    archived.importRequestTimingEvidence({
      homeId: codexHomeId(archived, fixture.codexHome),
      records: [lateTiming],
      reviewedOrigins: [lateTiming.evidenceOrigin],
    });
    oracle.importRequestTimingEvidence({
      homeId: codexHomeId(oracle, fixture.codexHome),
      records: [lateTiming],
      reviewedOrigins: [lateTiming.evidenceOrigin],
    });
    await archived.sync({ options: fixture.reportOptions });
    await oracle.sync({ options: fixture.reportOptions });

    const expected = await oracle.summarizeHistory(FILTERS);
    const baseline = await archived.summarizeHistory(FILTERS);
    assert.deepEqual(
      stablePerfEvidence(baseline.perf),
      stablePerfEvidence(expected.perf),
      "the typed late-timing revision must first match the unarchived oracle",
    );

    const revisionMetadata = archived.database
      .prepare("SELECT value FROM store_meta WHERE key = ?")
      .get(PERF_REVISIONS_KEY)?.value;
    assert.equal(typeof revisionMetadata, "string");
    const revisionRoot = JSON.parse(String(revisionMetadata));
    const revision = sampleRevision(revisionRoot, String(coldSample.sampleKey));
    const nativeMeasurementRevision = factRevision(
      revisionRoot,
      "codex_output_measurements",
      String(coldSample.sampleKey),
    );
    const originalAdded = revision.added.find(
      (delta) => String(delta.payload.sample_key) === String(coldSample.sampleKey),
    );
    assert.ok(originalAdded, "the selected sample must have one effective typed payload");
    const originalNativeMeasurement = nativeMeasurementRevision.added.find(
      (delta) => String(delta.payload.sample_key) === String(coldSample.sampleKey),
    );
    assert.ok(originalNativeMeasurement, "the selected sample must have one scalar native measurement payload");
    const siblingCandidateMeasurement = candidateNativeMeasurements.get(siblingSampleKey);
    assert.ok(siblingCandidateMeasurement, "the sibling response must have candidate native measurement evidence");
    assert.equal(
      candidateNativeMeasurements.get(String(coldSample.sampleKey)).samplingWindowMs,
      OUTPUT_TIME_RESOLUTION_MS,
      "the native cold candidate must preserve the current 100 ms sampling precision",
    );
    assert.equal(
      siblingCandidateMeasurement.samplingWindowMs,
      OUTPUT_TIME_RESOLUTION_MS,
      "sibling native candidates must preserve the current 100 ms sampling precision",
    );
    assert.equal(
      originalNativeMeasurement.payload.measurement.samplingWindowMs,
      OUTPUT_TIME_RESOLUTION_MS,
      "the native cold revision must carry the current 100 ms sampling precision",
    );
    const originalHotSample = {
      ...archived.database.prepare("SELECT * FROM perf_samples WHERE sample_key = ?").get(coldSample.sampleKey),
    };
    assert.deepEqual(
      originalHotSample,
      originalAdded.payload,
      "the hot sample must mirror the typed effective payload before the counterexample",
    );

    const originalTimingEvidence = timingEvidence(archived.database, String(originalAdded.payload.home_id), responseId);
    assert.ok(originalTimingEvidence.length > 0);
    const preserved = {
      candidateDigest,
      requestFacts,
      timingEvidence: originalTimingEvidence,
    };

    const mutatedRoot = structuredClone(revisionRoot);
    const mutatedRevision = sampleRevision(mutatedRoot, String(coldSample.sampleKey));
    const mutatedAdded = mutatedRevision.added.find(
      (delta) => String(delta.payload.sample_key) === String(coldSample.sampleKey),
    );
    assert.ok(mutatedAdded);
    mutatedAdded.payload.duration_ms += 1;
    assert.deepEqual(
      { ...mutatedAdded.payload, duration_ms: originalAdded.payload.duration_ms },
      originalAdded.payload,
      "the counterexample must change only the effective duration",
    );

    let summaryError;
    writeSampleAndRevision(archived.database, mutatedAdded.payload, mutatedRoot);
    try {
      try {
        await archived.summarizeHistory(FILTERS);
      } catch (error) {
        summaryError = error;
      }
      assert.deepEqual(
        {
          candidateDigest: fileSha256(candidateFile),
          requestFacts: (() => {
            const database = new DatabaseSync(candidateFile, { readOnly: true });
            try {
              return codexRequestFacts(database);
            } finally {
              database.close();
            }
          })(),
          timingEvidence: timingEvidence(archived.database, String(originalAdded.payload.home_id), responseId),
        },
        preserved,
        "the numeric revision counterexample must not rewrite native timing facts or the candidate",
      );
      assert.ok(summaryError, "an effective duration must reject when it contradicts unchanged native timing");
      assert.equal(summaryError.code, "HISTORY_ARCHIVE_REVISION_INVALID");
      assert.ok(summaryError.message.includes(String(coldSample.sampleKey)));
      assert.match(summaryError.message, /duration/i);
      assert.match(summaryError.message, /native/i);
    } finally {
      writeSampleAndRevision(archived.database, originalHotSample, revisionRoot);
    }

    const assertRevisionRejected = async (candidateRoot, message, messagePattern) => {
      writeSampleAndRevision(archived.database, originalHotSample, candidateRoot);
      try {
        await assert.rejects(
          archived.summarizeHistory(FILTERS),
          (error) => error.code === "HISTORY_ARCHIVE_REVISION_INVALID" && messagePattern.test(String(error.message)),
          message,
        );
      } finally {
        writeSampleAndRevision(archived.database, originalHotSample, revisionRoot);
      }
    };

    const missingNativeRoot = structuredClone(revisionRoot);
    missingNativeRoot.revisions = missingNativeRoot.revisions.filter(
      (entry) => entry.factTable !== "codex_output_measurements",
    );
    await assertRevisionRejected(
      missingNativeRoot,
      "removing the scalar native measurement revision must reject the effective sample",
      /native|measurement|contradict/i,
    );

    const damagedWindowRoot = structuredClone(revisionRoot);
    const damagedNativeRevision = factRevision(
      damagedWindowRoot,
      "codex_output_measurements",
      String(coldSample.sampleKey),
    );
    const damagedNativeMeasurement = damagedNativeRevision.added.find(
      (delta) => String(delta.payload.sample_key) === String(coldSample.sampleKey),
    );
    assert.ok(damagedNativeMeasurement);
    damagedNativeMeasurement.payload.measurement.windows[0].endMs =
      damagedNativeMeasurement.payload.measurement.windows[0].startMs;
    await assertRevisionRejected(
      damagedWindowRoot,
      "a damaged native measurement window must reject",
      /measurement|scalar|window|native/i,
    );

    const missingPrecisionRoot = structuredClone(revisionRoot);
    const missingPrecisionNativeRevision = factRevision(
      missingPrecisionRoot,
      "codex_output_measurements",
      String(coldSample.sampleKey),
    );
    const missingPrecisionNativeMeasurement = missingPrecisionNativeRevision.added.find(
      (delta) => String(delta.payload.sample_key) === String(coldSample.sampleKey),
    );
    assert.ok(missingPrecisionNativeMeasurement);
    delete missingPrecisionNativeMeasurement.payload.measurement.samplingWindowMs;
    await assertRevisionRejected(
      missingPrecisionRoot,
      "a current v8 native measurement without 100 ms precision must reject",
      /native|measurement|precision|window|contradict/i,
    );

    const wrongPrecisionRoot = structuredClone(revisionRoot);
    const wrongPrecisionNativeRevision = factRevision(
      wrongPrecisionRoot,
      "codex_output_measurements",
      String(coldSample.sampleKey),
    );
    const wrongPrecisionNativeMeasurement = wrongPrecisionNativeRevision.added.find(
      (delta) => String(delta.payload.sample_key) === String(coldSample.sampleKey),
    );
    assert.ok(wrongPrecisionNativeMeasurement);
    wrongPrecisionNativeMeasurement.payload.measurement.samplingWindowMs = OUTPUT_TIME_RESOLUTION_MS - 1;
    await assertRevisionRejected(
      wrongPrecisionRoot,
      "a current v8 native measurement with noncanonical precision must reject",
      /native|measurement|precision|window|contradict/i,
    );

    const crossResponseRoot = structuredClone(revisionRoot);
    const crossResponseNativeRevision = factRevision(
      crossResponseRoot,
      "codex_output_measurements",
      String(coldSample.sampleKey),
    );
    const crossResponseAdded = crossResponseNativeRevision.added.find(
      (delta) => String(delta.payload.sample_key) === String(coldSample.sampleKey),
    );
    assert.ok(crossResponseAdded);
    crossResponseNativeRevision.removed = [
      {
        payload: {
          sample_key: siblingSampleKey,
          source_path: coldSampleRow.source_path,
          home_id: coldSampleRow.home_id,
          measurement: structuredClone(siblingCandidateMeasurement),
        },
        count: 1,
      },
    ];
    crossResponseAdded.payload.sample_key = siblingSampleKey;
    await assertRevisionRejected(
      crossResponseRoot,
      "a native measurement moved to a sibling response identity must reject",
      /native|measurement|sample|contradict/i,
    );

    assert.deepEqual(
      timingEvidence(archived.database, String(originalAdded.payload.home_id), responseId),
      originalTimingEvidence,
      "the native measurement counterexamples must not rewrite external timing evidence",
    );
    assert.equal(fileSha256(candidateFile), candidateDigest);

    const restored = await archived.summarizeHistory(FILTERS);
    assert.deepEqual(
      stablePerfEvidence(restored.perf),
      stablePerfEvidence(expected.perf),
      "restoring the original revision must recover the unarchived oracle",
    );
    assert.equal(fileSha256(candidateFile), candidateDigest);
  } finally {
    archived.close();
    oracle.close();
    fixture.close();
  }
});
