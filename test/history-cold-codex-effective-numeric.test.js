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

function sampleRevision(root, sampleKey) {
  const matches = root.revisions.filter(
    (entry) =>
      entry.factTable === "perf_samples" && entry.added.some((delta) => String(delta.payload.sample_key) === sampleKey),
  );
  assert.equal(matches.length, 1, "the late timing revision must add exactly one typed payload for the sample");
  return matches[0];
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
    const candidateDatabase = new DatabaseSync(candidateFile, { readOnly: true });
    let requestFacts;
    try {
      requestFacts = codexRequestFacts(candidateDatabase);
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

    const lateTiming = { ...baseTiming, durationMs: baseTiming.durationMs + 500 };
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
    const originalAdded = revision.added.find(
      (delta) => String(delta.payload.sample_key) === String(coldSample.sampleKey),
    );
    assert.ok(originalAdded, "the selected sample must have one effective typed payload");
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
