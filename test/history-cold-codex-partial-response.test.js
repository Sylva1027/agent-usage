import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryBackup, verifyHistoryBackup } from "../src/history-backup.js";
import { createHistoryArchiveCandidate, verifyHistoryArchiveCandidate } from "../src/history-archive.js";
import { PERF_SAMPLE_FIELDS, UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const COLD_END_MS = Date.parse("2026-10-04T12:02:00.000Z");
const MISSING_TIMING_DEPENDENCY_CODE = "HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_DEPENDENCIES_MISSING";
const PERF_COLUMNS = PERF_SAMPLE_FIELDS.map((entry) => entry.column);

function manifestPathFor(databaseFile) {
  const parsed = path.parse(databaseFile);
  return path.join(parsed.dir, `${parsed.name}.manifest.json`);
}

function sourceGraph(database, sampleKey, homeId, responseId) {
  const sample = database
    .prepare(`SELECT ${PERF_COLUMNS.join(", ")} FROM perf_samples WHERE sample_key = ?`)
    .get(sampleKey);
  assert.ok(sample, "the isolated source must retain the selected perf sample");

  const dependencies = database
    .prepare(
      `SELECT sample_key, source_path, role
       FROM perf_sample_sources
       WHERE sample_key = ?
       ORDER BY source_path, role`,
    )
    .all(sampleKey)
    .map((row) => ({ ...row }));
  assert.ok(dependencies.length > 0, "the selected sample must retain its rollout dependencies");

  const sourcePaths = [...new Set(dependencies.map((dependency) => String(dependency.source_path)))].sort();
  const identities = database
    .prepare(
      `SELECT path, kind, home_id, home_label, home_path
       FROM source_files
       WHERE path IN (${sourcePaths.map(() => "?").join(",")})
       ORDER BY path, kind, home_id, home_label, home_path`,
    )
    .all(...sourcePaths)
    .map((row) => ({ ...row }));
  assert.equal(identities.length, sourcePaths.length, "every rollout dependency must retain its source identity");

  const owners = database
    .prepare(
      `SELECT source_path, home_id, thread_id
       FROM perf_rollout_threads
       WHERE source_path IN (${sourcePaths.map(() => "?").join(",")})
       ORDER BY source_path`,
    )
    .all(...sourcePaths)
    .map((row) => ({ ...row }));
  assert.ok(owners.length > 0, "the selected sample must retain its rollout owners");

  const selectedLinkCount = Number(
    database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM perf_sample_sources AS dependencies
         JOIN perf_rollout_threads AS owners ON owners.source_path = dependencies.source_path
         JOIN perf_request_timing_threads AS timing
           ON timing.home_id = owners.home_id AND timing.thread_id = owners.thread_id
         WHERE dependencies.sample_key = ? AND timing.response_id = ?`,
      )
      .get(sampleKey, responseId).count,
  );
  const selectedEvidenceCount = Number(
    database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM perf_request_timing_evidence
         WHERE home_id = ? AND response_id = ?`,
      )
      .get(homeId, responseId).count,
  );
  const otherEvidenceCount = Number(
    database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM perf_request_timing_evidence AS evidence
         WHERE evidence.home_id = ? AND evidence.response_id <> ?
           AND EXISTS (
             SELECT 1
             FROM perf_sample_sources AS dependencies
             JOIN perf_rollout_threads AS owners ON owners.source_path = dependencies.source_path
             JOIN perf_request_timing_threads AS timing
               ON timing.home_id = owners.home_id AND timing.thread_id = owners.thread_id
             WHERE dependencies.sample_key = ?
               AND timing.home_id = evidence.home_id
               AND timing.response_id = evidence.response_id
           )`,
      )
      .get(homeId, responseId, sampleKey).count,
  );

  return {
    sample: { ...sample },
    dependencies,
    identities,
    owners,
    selectedLinkCount,
    selectedEvidenceCount,
    otherEvidenceCount,
  };
}

function generatingResponses(database, homeId, threadId, turnId) {
  const responses = new Set();
  for (const row of database.prepare("SELECT projection FROM perf_codex_projections WHERE home_id = ?").all(homeId)) {
    const projection = JSON.parse(String(row.projection));
    for (const record of projection.records ?? []) {
      if (
        record.kind === "token_usage_record" &&
        record.threadId === threadId &&
        record.turnId === turnId &&
        typeof record.responseId === "string" &&
        record.responseId !== ""
      ) {
        responses.add(record.responseId);
      }
    }
  }
  return [...responses].sort();
}

test("candidate rejects a cold Codex sample when one linked native response has no raw evidence", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const isolatedFile = path.join(fixture.serverOptions.homeDir, "cold-codex-partial-response-source.sqlite");
  const controlCandidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-partial-response-control.sqlite");
  const candidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-partial-response-candidate.sqlite");
  const candidateManifest = manifestPathFor(candidateFile);
  const tamperedCandidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-partial-response-tampered.sqlite");
  const repackedCandidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-partial-response-repacked.sqlite");
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(store);
    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    const selected = store.database
      .prepare(
        `SELECT sample_key, home_id
         FROM perf_samples AS samples
         WHERE ts_ms >= ? AND ts_ms < ?
           AND source_kind = 'codex'
           AND status = 'completed'
           AND timing_kind = 'request_e2e'
           AND timing_source = 'explicit'
           AND EXISTS (
             SELECT 1
             FROM perf_sample_sources AS dependencies
             JOIN perf_rollout_threads AS owners ON owners.source_path = dependencies.source_path
             JOIN perf_request_timing_threads AS timing
               ON timing.home_id = owners.home_id AND timing.thread_id = owners.thread_id
             WHERE dependencies.sample_key = samples.sample_key
           )
         ORDER BY ts_ms, sample_key
         LIMIT 1`,
      )
      .get(coldStartMs, COLD_END_MS);
    assert.ok(selected, "fixture must expose a cold completed explicit Codex sample");
    const sampleKey = String(selected.sample_key);
    const homeId = String(selected.home_id);
    const [, keyHomeId, threadId, turnId] = JSON.parse(sampleKey);
    assert.equal(keyHomeId, homeId);
    const responses = generatingResponses(store.database, homeId, threadId, turnId);
    assert.equal(responses.length, 1, "the selected cold turn must resolve to exactly one generating native response");
    const responseId = responses[0];
    const original = sourceGraph(store.database, sampleKey, homeId, responseId);
    assert.ok(original.selectedLinkCount > 0, "the generating response must retain its native link");
    assert.ok(original.selectedEvidenceCount > 0, "the generating response must initially retain raw evidence");
    assert.ok(original.otherEvidenceCount > 0, "the owner must retain valid sibling response evidence");

    await createHistoryArchiveCandidate(store.database, controlCandidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });
    await verifyHistoryArchiveCandidate(controlCandidateFile);
    assert.deepEqual(
      sourceGraph(store.database, sampleKey, homeId, responseId),
      original,
      "control creation must not mutate the source graph",
    );

    await backup(store.database, isolatedFile);
    const isolated = new DatabaseSync(isolatedFile);
    let partial;
    try {
      const deleted = isolated
        .prepare("DELETE FROM perf_request_timing_evidence WHERE home_id = ? AND response_id = ?")
        .run(homeId, responseId);
      assert.equal(Number(deleted.changes), original.selectedEvidenceCount);
      partial = sourceGraph(isolated, sampleKey, homeId, responseId);
      assert.equal(partial.selectedEvidenceCount, 0, "the generating response must retain no raw evidence");
      assert.ok(partial.selectedLinkCount > 0, "the generating response link must remain");
      assert.ok(partial.otherEvidenceCount > 0, "sibling response evidence must remain valid");
      assert.deepEqual(
        { ...partial, selectedEvidenceCount: original.selectedEvidenceCount },
        original,
        "removing one response's evidence must leave the sample, links, owners, and identities unchanged",
      );
    } finally {
      isolated.close();
    }

    const isolatedReadOnly = new DatabaseSync(isolatedFile, { readOnly: true });
    try {
      await assert.rejects(
        () =>
          createHistoryArchiveCandidate(isolatedReadOnly, candidateFile, {
            startMs: coldStartMs,
            endMs: COLD_END_MS,
          }),
        (error) => {
          assert.equal(error?.code, MISSING_TIMING_DEPENDENCY_CODE);
          return true;
        },
      );
      assert.deepEqual(
        sourceGraph(isolatedReadOnly, sampleKey, homeId, responseId),
        partial,
        "candidate rejection must not mutate the isolated source graph",
      );
    } finally {
      isolatedReadOnly.close();
    }

    assert.equal(existsSync(candidateFile), false, "candidate creation must not publish a destination database");
    assert.equal(existsSync(candidateManifest), false, "candidate creation must not publish a destination manifest");
    assert.deepEqual(
      sourceGraph(store.database, sampleKey, homeId, responseId),
      original,
      "isolated work must not mutate the source graph",
    );

    const controlSource = new DatabaseSync(controlCandidateFile, { readOnly: true });
    try {
      await backup(controlSource, tamperedCandidateFile);
    } finally {
      controlSource.close();
    }
    const tampered = new DatabaseSync(tamperedCandidateFile);
    try {
      const candidateEvidence = sourceGraph(tampered, sampleKey, homeId, responseId).selectedEvidenceCount;
      assert.equal(candidateEvidence, original.selectedEvidenceCount);
      const deleted = tampered
        .prepare("DELETE FROM perf_request_timing_evidence WHERE home_id = ? AND response_id = ?")
        .run(homeId, responseId);
      assert.equal(Number(deleted.changes), candidateEvidence);
    } finally {
      tampered.close();
    }

    const repackSource = new DatabaseSync(tamperedCandidateFile, { readOnly: true });
    try {
      await createHistoryBackup(repackSource, repackedCandidateFile);
    } finally {
      repackSource.close();
    }
    const outer = await verifyHistoryBackup(repackedCandidateFile);
    assert.equal(outer.ok, true, "the tampered candidate must retain a valid outer backup checksum");
    await assert.rejects(
      () => verifyHistoryArchiveCandidate(repackedCandidateFile),
      (error) => {
        assert.equal(error?.code, MISSING_TIMING_DEPENDENCY_CODE);
        return true;
      },
    );
  } finally {
    store.close();
    fixture.close();
  }
});
