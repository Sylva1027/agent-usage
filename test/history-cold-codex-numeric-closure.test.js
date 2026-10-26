import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryBackup, verifyHistoryBackup } from "../src/history-backup.js";
import { createHistoryArchiveCandidate, verifyHistoryArchiveCandidate } from "../src/history-archive.js";
import { lookupRequestTiming } from "../src/perf-request-timing-store.js";
import { resolveCodexTurnRequestTiming } from "../src/perf-sources/codex-request-timing.js";
import { PERF_SAMPLE_FIELDS, UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const COLD_END_MS = Date.parse("2026-10-04T12:02:00.000Z");
const TIMING_MISMATCH_CODE = "HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_MISMATCH";
const PERF_COLUMNS = PERF_SAMPLE_FIELDS.map((entry) => entry.column);

function manifestPathFor(databaseFile) {
  const parsed = path.parse(databaseFile);
  return path.join(parsed.dir, `${parsed.name}.manifest.json`);
}

function nativeRequests(database, homeId, threadId, turnId) {
  const requests = [];
  for (const row of database.prepare("SELECT projection FROM perf_codex_projections WHERE home_id = ?").all(homeId)) {
    const projection = JSON.parse(String(row.projection));
    for (const record of projection.records ?? []) {
      if (record.kind === "token_usage_record" && record.threadId === threadId && record.turnId === turnId) {
        requests.push({ ...record });
      }
    }
  }
  return requests.sort(
    (left, right) =>
      String(left.timestamp).localeCompare(String(right.timestamp)) ||
      String(left.responseId).localeCompare(String(right.responseId)),
  );
}

function nativeSnapshot(database, sampleKey, homeId, threadId, turnId) {
  const sample = database
    .prepare(`SELECT ${PERF_COLUMNS.join(", ")} FROM perf_samples WHERE sample_key = ?`)
    .get(sampleKey);
  assert.ok(sample, "the selected native source must retain its perf sample");

  const requests = nativeRequests(database, homeId, threadId, turnId);
  const responses = [...new Set(requests.map((request) => String(request.responseId)))].sort();
  assert.ok(responses.length > 0, "the selected turn must retain native request records");

  const dependencies = database
    .prepare(
      `SELECT sample_key, source_path, role
       FROM perf_sample_sources
       WHERE sample_key = ?
       ORDER BY source_path, role`,
    )
    .all(sampleKey)
    .map((row) => ({ ...row }));
  const sourcePaths = [...new Set(dependencies.map((dependency) => String(dependency.source_path)))].sort();
  assert.ok(sourcePaths.length > 0, "the selected sample must retain rollout dependencies");

  const identities = database
    .prepare(
      `SELECT path, kind, home_id, home_label, home_path
       FROM source_files
       WHERE path IN (${sourcePaths.map(() => "?").join(",")})
       ORDER BY path, kind, home_id, home_label, home_path`,
    )
    .all(...sourcePaths)
    .map((row) => ({ ...row }));
  assert.equal(identities.length, sourcePaths.length);

  const owners = database
    .prepare(
      `SELECT source_path, home_id, thread_id
       FROM perf_rollout_threads
       WHERE source_path IN (${sourcePaths.map(() => "?").join(",")})
       ORDER BY source_path`,
    )
    .all(...sourcePaths)
    .map((row) => ({ ...row }));
  assert.ok(owners.length > 0, "the selected sample must retain rollout owners");

  const links = database
    .prepare(
      `SELECT home_id, response_id, thread_id
       FROM perf_request_timing_threads
       WHERE home_id = ? AND response_id IN (${responses.map(() => "?").join(",")})
       ORDER BY response_id, thread_id`,
    )
    .all(homeId, ...responses)
    .map((row) => ({ ...row }));
  const evidence = database
    .prepare(
      `SELECT home_id, evidence_origin, response_id, variant_key, schema_version,
              requested_model, reported_output_tokens, duration_ms, status, completed_at_ms
       FROM perf_request_timing_evidence
       WHERE home_id = ? AND response_id IN (${responses.map(() => "?").join(",")})
       ORDER BY response_id, evidence_origin, variant_key`,
    )
    .all(homeId, ...responses)
    .map((row) => ({ ...row }));
  assert.equal(links.length, responses.length);
  assert.equal(evidence.length, responses.length);

  return {
    sample: { ...sample },
    requests,
    responses,
    dependencies,
    identities,
    owners,
    links,
    evidence,
  };
}

function recomputeNativeTiming(snapshot) {
  const evidenceByResponse = new Map(snapshot.evidence.map((row) => [String(row.response_id), row]));
  assert.equal(evidenceByResponse.size, snapshot.responses.length);
  const turn = {
    threadId: JSON.parse(snapshot.sample.sample_key)[2],
    turnId: JSON.parse(snapshot.sample.sample_key)[3],
    model: String(snapshot.sample.model),
    requests: snapshot.requests,
    requestSetComplete: true,
  };
  return resolveCodexTurnRequestTiming(String(snapshot.sample.home_id), turn, (query) => {
    const evidence = evidenceByResponse.get(String(query.responseId));
    if (!evidence) {
      return { state: "missing", durationMs: null, reportedOutputTokens: null, requestedModel: "" };
    }
    assert.equal(evidence.status, "completed");
    return {
      state: "available",
      durationMs: evidence.duration_ms,
      reportedOutputTokens: evidence.reported_output_tokens,
      requestedModel: evidence.requested_model,
    };
  });
}

test("candidate enforces bounded Codex request facts without depending on projection control state", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const isolatedFile = path.join(fixture.serverOptions.homeDir, "cold-codex-numeric-source.sqlite");
  const controlCandidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-numeric-control.sqlite");
  const candidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-numeric-candidate.sqlite");
  const repackWorkingFile = path.join(fixture.serverOptions.homeDir, "cold-codex-numeric-repack-working.sqlite");
  const repackedCandidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-numeric-repacked.sqlite");
  const legacyWorkingFile = path.join(fixture.serverOptions.homeDir, "cold-codex-numeric-legacy-working.sqlite");
  const legacyCandidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-numeric-legacy.sqlite");
  const candidateManifest = manifestPathFor(candidateFile);
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
    const original = nativeSnapshot(store.database, sampleKey, homeId, threadId, turnId);
    assert.equal(original.requests.length, original.sample.request_count);
    const nativeTiming = recomputeNativeTiming(original);
    assert.equal(nativeTiming.state, "complete");
    assert.equal(nativeTiming.durationMs, original.sample.duration_ms);

    await createHistoryArchiveCandidate(store.database, controlCandidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });
    await verifyHistoryArchiveCandidate(controlCandidateFile);
    assert.deepEqual(
      nativeSnapshot(store.database, sampleKey, homeId, threadId, turnId),
      original,
      "control creation must not mutate native facts",
    );

    const controlSource = new DatabaseSync(controlCandidateFile, { readOnly: true });
    let requestFacts;
    try {
      const requestFactsKey = `history_archive_${"codex_requests"}_v1`;
      const stored = controlSource.prepare("SELECT value FROM store_meta WHERE key = ?").get(requestFactsKey);
      assert.ok(stored, "candidate creation must persist the bounded Codex request facts");
      requestFacts = JSON.parse(String(stored.value));
      assert.equal(requestFacts.formatVersion, 1);
      assert.equal(requestFacts.startMs, coldStartMs);
      assert.equal(requestFacts.endMs, COLD_END_MS);
      assert.deepEqual(
        requestFacts.turns.find((turn) => turn.sampleKey === sampleKey),
        {
          sampleKey,
          sourceKind: "codex",
          homeId,
          sourcePath: String(original.sample.source_path),
          threadId,
          turnId,
          model: String(original.sample.model),
          requestSetComplete: true,
          requests: original.requests
            .map((request) => ({ responseId: String(request.responseId), outputTokens: Number(request.outputTokens) }))
            .sort((left, right) => left.responseId.localeCompare(right.responseId)),
        },
        "the persisted facts must be the minimal native request ledger",
      );
      await backup(controlSource, repackWorkingFile);
    } finally {
      controlSource.close();
    }

    const repackWorking = new DatabaseSync(repackWorkingFile);
    try {
      const projectionCount = Number(
        repackWorking.prepare("SELECT COUNT(*) AS count FROM perf_codex_projections").get().count,
      );
      assert.ok(projectionCount > 0);
      const deleted = repackWorking.prepare("DELETE FROM perf_codex_projections").run();
      assert.equal(Number(deleted.changes), projectionCount);
    } finally {
      repackWorking.close();
    }

    const repackSource = new DatabaseSync(repackWorkingFile, { readOnly: true });
    try {
      await createHistoryBackup(repackSource, repackedCandidateFile);
    } finally {
      repackSource.close();
    }
    const outer = await verifyHistoryBackup(repackedCandidateFile);
    assert.equal(outer.ok, true, "the projection-free candidate must retain a valid outer backup checksum");
    await verifyHistoryArchiveCandidate(repackedCandidateFile);

    const transferred = new DatabaseSync(repackedCandidateFile, { readOnly: true });
    try {
      assert.equal(
        Number(transferred.prepare("SELECT COUNT(*) AS count FROM perf_codex_projections").get().count),
        0,
        "the transferred candidate must contain no projection control rows",
      );
      const transferredTurn = requestFacts.turns.find((turn) => turn.sampleKey === sampleKey);
      assert.ok(transferredTurn);
      assert.deepEqual(
        resolveCodexTurnRequestTiming(
          transferredTurn.homeId,
          {
            threadId: transferredTurn.threadId,
            turnId: transferredTurn.turnId,
            model: transferredTurn.model,
            requests: transferredTurn.requests,
            requestSetComplete: transferredTurn.requestSetComplete,
          },
          (query) => lookupRequestTiming(transferred, query),
        ),
        nativeTiming,
        "the projection-free candidate must recompute from stored facts and native timing evidence",
      );
    } finally {
      transferred.close();
    }

    const legacySource = new DatabaseSync(controlCandidateFile, { readOnly: true });
    try {
      await backup(legacySource, legacyWorkingFile);
    } finally {
      legacySource.close();
    }
    const legacyWorking = new DatabaseSync(legacyWorkingFile);
    try {
      const removed = legacyWorking
        .prepare("DELETE FROM store_meta WHERE key = ?")
        .run(`history_archive_${"codex_requests"}_v1`);
      assert.equal(Number(removed.changes), 1);
    } finally {
      legacyWorking.close();
    }
    const legacySourceForRepack = new DatabaseSync(legacyWorkingFile, { readOnly: true });
    try {
      await createHistoryBackup(legacySourceForRepack, legacyCandidateFile);
    } finally {
      legacySourceForRepack.close();
    }
    await verifyHistoryArchiveCandidate(legacyCandidateFile);

    await backup(store.database, isolatedFile);
    const isolated = new DatabaseSync(isolatedFile);
    let mutated;
    try {
      const updated = isolated
        .prepare("UPDATE perf_samples SET duration_ms = duration_ms + 1 WHERE sample_key = ?")
        .run(sampleKey);
      assert.equal(Number(updated.changes), 1);
      mutated = nativeSnapshot(isolated, sampleKey, homeId, threadId, turnId);
      assert.equal(mutated.sample.duration_ms, original.sample.duration_ms + 1);
      assert.deepEqual(
        { ...mutated, sample: { ...mutated.sample, duration_ms: original.sample.duration_ms } },
        original,
        "the numeric mutation must leave every native timing fact unchanged",
      );
      assert.deepEqual(recomputeNativeTiming(mutated), nativeTiming);
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
          assert.equal(error?.code, TIMING_MISMATCH_CODE);
          return true;
        },
      );
      assert.deepEqual(
        nativeSnapshot(isolatedReadOnly, sampleKey, homeId, threadId, turnId),
        mutated,
        "candidate rejection must not mutate the isolated native facts",
      );
    } finally {
      isolatedReadOnly.close();
    }

    assert.equal(existsSync(candidateFile), false, "candidate creation must not publish a destination database");
    assert.equal(existsSync(candidateManifest), false, "candidate creation must not publish a destination manifest");
    assert.deepEqual(
      nativeSnapshot(store.database, sampleKey, homeId, threadId, turnId),
      original,
      "isolated numeric work must not mutate the native source",
    );
  } finally {
    store.close();
    fixture.close();
  }
});
