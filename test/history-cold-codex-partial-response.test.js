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

test("v3 candidate selects the exact response and ignores a missing sibling evidence row", async () => {
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
    const turnSamples = store.database
      .prepare(
        `SELECT sample_key, home_id, ts_ms
         FROM perf_samples AS samples
         WHERE ts_ms >= ? AND ts_ms < ?
           AND source_kind = 'codex'
           AND status = 'completed'
           AND timing_kind = 'generation'
           AND timing_source = 'explicit'
           AND EXISTS (
             SELECT 1
             FROM perf_sample_sources AS dependencies
             JOIN perf_rollout_threads AS owners ON owners.source_path = dependencies.source_path
             JOIN perf_request_timing_threads AS timing
               ON timing.home_id = owners.home_id AND timing.thread_id = owners.thread_id
             WHERE dependencies.sample_key = samples.sample_key
           )
         ORDER BY ts_ms, sample_key`,
      )
      .all(coldStartMs, Date.parse("2026-10-04T12:05:00.000Z"));
    const selected = turnSamples.find((row) => {
      const key = JSON.parse(String(row.sample_key));
      return key[3] === "turn-25" && key[4] === "response-25-1";
    });
    assert.ok(selected, "fixture must expose a cold completed explicit Codex sample");
    const sampleKey = String(selected.sample_key);
    const homeId = String(selected.home_id);
    const endMs = Number(selected.ts_ms) + 1;
    const [, keyHomeId, threadId, turnId, responseId] = JSON.parse(sampleKey);
    assert.equal(keyHomeId, homeId);
    assert.equal(responseId, "response-25-1");
    const responses = generatingResponses(store.database, homeId, threadId, turnId);
    assert.deepEqual(responses, ["response-25-1", "response-25-2"]);
    const siblingResponseId = "response-25-2";
    const original = sourceGraph(store.database, sampleKey, homeId, responseId);
    assert.ok(original.selectedLinkCount > 0, "the generating response must retain its native link");
    assert.ok(original.selectedEvidenceCount > 0, "the generating response must initially retain raw evidence");
    assert.ok(original.otherEvidenceCount > 0, "the owner must retain valid sibling response evidence");
    const sibling = sourceGraph(store.database, sampleKey, homeId, siblingResponseId);
    assert.ok(sibling.selectedEvidenceCount > 0, "the sibling response must initially retain raw evidence");

    await createHistoryArchiveCandidate(store.database, controlCandidateFile, {
      startMs: coldStartMs,
      endMs,
    });
    await verifyHistoryArchiveCandidate(controlCandidateFile);
    assert.deepEqual(
      sourceGraph(store.database, sampleKey, homeId, responseId),
      original,
      "control creation must not mutate the source graph",
    );

    await backup(store.database, isolatedFile);
    const isolated = new DatabaseSync(isolatedFile);
    let siblingMissing;
    try {
      const deleted = isolated
        .prepare("DELETE FROM perf_request_timing_evidence WHERE home_id = ? AND response_id = ?")
        .run(homeId, siblingResponseId);
      assert.equal(Number(deleted.changes), sibling.selectedEvidenceCount);
      siblingMissing = sourceGraph(isolated, sampleKey, homeId, responseId);
      assert.equal(siblingMissing.selectedEvidenceCount, original.selectedEvidenceCount);
      assert.equal(siblingMissing.selectedLinkCount, original.selectedLinkCount);
      assert.equal(
        siblingMissing.otherEvidenceCount,
        original.otherEvidenceCount - sibling.selectedEvidenceCount,
        "removing the sibling evidence must reduce only the sibling contribution",
      );
      assert.deepEqual(
        { ...siblingMissing, otherEvidenceCount: original.otherEvidenceCount },
        original,
        "removing a sibling's evidence must leave the selected response's facts unchanged",
      );
    } finally {
      isolated.close();
    }

    const isolatedReadOnly = new DatabaseSync(isolatedFile, { readOnly: true });
    try {
      await createHistoryArchiveCandidate(isolatedReadOnly, candidateFile, {
        startMs: coldStartMs,
        endMs,
      });
      await verifyHistoryArchiveCandidate(candidateFile);
      assert.deepEqual(
        sourceGraph(isolatedReadOnly, sampleKey, homeId, responseId),
        siblingMissing,
        "candidate creation must not mutate the isolated source graph",
      );
    } finally {
      isolatedReadOnly.close();
    }

    assert.equal(
      existsSync(candidateFile),
      true,
      "the selected response must remain archivable without its sibling evidence",
    );
    assert.equal(existsSync(candidateManifest), true, "the selected response candidate must publish its manifest");
    assert.deepEqual(
      sourceGraph(store.database, sampleKey, homeId, responseId),
      original,
      "isolated work must not mutate the source graph",
    );

    const missingTargetFile = path.join(
      fixture.serverOptions.homeDir,
      "cold-codex-partial-response-target-missing.sqlite",
    );
    await backup(store.database, missingTargetFile);
    const missingTarget = new DatabaseSync(missingTargetFile);
    try {
      const deleted = missingTarget
        .prepare("DELETE FROM perf_request_timing_evidence WHERE home_id = ? AND response_id = ?")
        .run(homeId, responseId);
      assert.equal(Number(deleted.changes), original.selectedEvidenceCount);
    } finally {
      missingTarget.close();
    }
    const missingTargetReadOnly = new DatabaseSync(missingTargetFile, { readOnly: true });
    try {
      await assert.rejects(
        () =>
          createHistoryArchiveCandidate(
            missingTargetReadOnly,
            path.join(fixture.serverOptions.homeDir, "cold-codex-partial-response-target-candidate.sqlite"),
            { startMs: coldStartMs, endMs },
          ),
        (error) => {
          assert.equal(error?.code, MISSING_TIMING_DEPENDENCY_CODE);
          return true;
        },
      );
    } finally {
      missingTargetReadOnly.close();
    }

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
