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
const TIMING_MISMATCH_CODE = "HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_MISMATCH";
const PERF_COLUMNS = PERF_SAMPLE_FIELDS.map((entry) => entry.column);

function manifestPathFor(databaseFile) {
  const parsed = path.parse(databaseFile);
  return path.join(parsed.dir, `${parsed.name}.manifest.json`);
}

function nativeRequests(database, homeId, threadId, turnId, responseId) {
  const requests = [];
  for (const row of database.prepare("SELECT projection FROM perf_codex_projections WHERE home_id = ?").all(homeId)) {
    const projection = JSON.parse(String(row.projection));
    for (const record of projection.records ?? []) {
      if (
        record.kind === "token_usage_record" &&
        record.threadId === threadId &&
        record.turnId === turnId &&
        record.responseId === responseId
      ) {
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

function writeNativeRequestOutput(database, homeId, responseId, outputTokens) {
  const projections = database
    .prepare("SELECT path, projection FROM perf_codex_projections WHERE home_id = ? ORDER BY path")
    .all(homeId);
  const update = database.prepare("UPDATE perf_codex_projections SET projection = ? WHERE path = ?");
  for (const row of projections) {
    const projection = JSON.parse(String(row.projection));
    const request = (projection.records ?? []).find(
      (record) => record?.kind === "token_usage_record" && record.responseId === responseId,
    );
    if (!request) continue;
    request.outputTokens = outputTokens;
    update.run(JSON.stringify(projection), String(row.path));
    return;
  }
  assert.fail(`native response ${responseId} must have a token_usage_record`);
}

function nativeSnapshot(database, sampleKey, homeId, threadId, turnId, responseId) {
  const sample = database
    .prepare(`SELECT ${PERF_COLUMNS.join(", ")} FROM perf_samples WHERE sample_key = ?`)
    .get(sampleKey);
  assert.ok(sample, "the selected native source must retain its perf sample");

  const requests = nativeRequests(database, homeId, threadId, turnId, responseId);
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
              requested_model, reported_output_tokens, duration_ms, status, completed_at_ms,
              generation_json
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
  assert.equal(snapshot.requests.length, 1, "the selected schema3 response must have one native request record");
  const generation = snapshot.requests[0].nativeGeneration;
  assert.equal(Number.isSafeInteger(generation?.outputTokens), true);
  assert.equal(Number.isSafeInteger(generation?.durationMs), true);
  return {
    outputTokens: generation.outputTokens,
    durationMs: generation.durationMs,
  };
}

test("candidate enforces native projections and bounded Codex request facts", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const isolatedFile = path.join(fixture.serverOptions.homeDir, "cold-codex-numeric-source.sqlite");
  const controlCandidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-numeric-control.sqlite");
  const candidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-numeric-candidate.sqlite");
  const repackWorkingFile = path.join(fixture.serverOptions.homeDir, "cold-codex-numeric-repack-working.sqlite");
  const repackedCandidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-numeric-repacked.sqlite");
  const requestFactWorkingFile = path.join(
    fixture.serverOptions.homeDir,
    "cold-codex-numeric-request-fact-working.sqlite",
  );
  const requestFactCandidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-numeric-request-fact.sqlite");
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
         ORDER BY ts_ms, sample_key
         LIMIT 1`,
      )
      .get(coldStartMs, COLD_END_MS);
    assert.ok(selected, "fixture must expose a cold completed explicit Codex sample");
    const sampleKey = String(selected.sample_key);
    const homeId = String(selected.home_id);
    const [, keyHomeId, threadId, turnId, responseId] = JSON.parse(sampleKey);
    assert.equal(keyHomeId, homeId);
    assert.equal(typeof responseId, "string");
    const original = nativeSnapshot(store.database, sampleKey, homeId, threadId, turnId, responseId);
    assert.equal(original.requests.length, original.sample.request_count);
    const nativeMeasurement = recomputeNativeTiming(original);
    assert.equal(original.requests[0].outputTokens, original.sample.output_tokens);
    assert.deepEqual(nativeMeasurement, {
      outputTokens: Number(original.sample.output_tokens),
      durationMs: Number(original.sample.duration_ms),
    });

    await createHistoryArchiveCandidate(store.database, controlCandidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });
    await verifyHistoryArchiveCandidate(controlCandidateFile);
    assert.deepEqual(
      nativeSnapshot(store.database, sampleKey, homeId, threadId, turnId, responseId),
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
          requests: [{ responseId, outputTokens: Number(original.requests[0].outputTokens) }],
        },
        "the persisted facts must be the minimal native request ledger",
      );
      assert.equal(
        Number(
          controlSource
            .prepare(
              "SELECT COUNT(*) AS count FROM perf_codex_projections WHERE home_id = ? AND path = ? COLLATE NOCASE",
            )
            .get(homeId, String(original.sample.source_path)).count,
        ),
        1,
        "the candidate must retain the selected native projection",
      );
      await backup(controlSource, repackWorkingFile);
    } finally {
      controlSource.close();
    }

    const repackWorking = new DatabaseSync(repackWorkingFile);
    try {
      const deleted = repackWorking
        .prepare("DELETE FROM perf_codex_projections WHERE home_id = ? AND path = ? COLLATE NOCASE")
        .run(homeId, String(original.sample.source_path));
      assert.equal(Number(deleted.changes), 1, "the counterexample must remove only the selected native projection");
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
    assert.equal(outer.ok, true, "the projection-loss candidate must retain a valid outer backup checksum");
    await assert.rejects(
      () => verifyHistoryArchiveCandidate(repackedCandidateFile),
      (error) => {
        assert.equal(error?.code, TIMING_MISMATCH_CODE);
        return true;
      },
    );

    const requestFactSource = new DatabaseSync(controlCandidateFile, { readOnly: true });
    try {
      await backup(requestFactSource, requestFactWorkingFile);
    } finally {
      requestFactSource.close();
    }
    const requestFactWorking = new DatabaseSync(requestFactWorkingFile);
    try {
      const mutatedFacts = structuredClone(requestFacts);
      const mutatedTurn = mutatedFacts.turns.find((turn) => turn.sampleKey === sampleKey);
      assert.ok(mutatedTurn);
      mutatedTurn.requests[0].outputTokens += 1;
      const updated = requestFactWorking
        .prepare("UPDATE store_meta SET value = ? WHERE key = ?")
        .run(JSON.stringify(mutatedFacts), `history_archive_${"codex_requests"}_v1`);
      assert.equal(Number(updated.changes), 1);
    } finally {
      requestFactWorking.close();
    }
    const requestFactSourceForRepack = new DatabaseSync(requestFactWorkingFile, { readOnly: true });
    try {
      await createHistoryBackup(requestFactSourceForRepack, requestFactCandidateFile);
    } finally {
      requestFactSourceForRepack.close();
    }
    await assert.rejects(
      () => verifyHistoryArchiveCandidate(requestFactCandidateFile),
      (error) => {
        assert.equal(error?.code, TIMING_MISMATCH_CODE);
        return true;
      },
    );

    await backup(store.database, isolatedFile);
    const isolated = new DatabaseSync(isolatedFile);
    let mutated;
    try {
      const updated = isolated
        .prepare("UPDATE perf_samples SET duration_ms = duration_ms + 1 WHERE sample_key = ?")
        .run(sampleKey);
      assert.equal(Number(updated.changes), 1);
      mutated = nativeSnapshot(isolated, sampleKey, homeId, threadId, turnId, responseId);
      assert.equal(mutated.sample.duration_ms, original.sample.duration_ms + 1);
      assert.deepEqual(
        { ...mutated, sample: { ...mutated.sample, duration_ms: original.sample.duration_ms } },
        original,
        "the numeric mutation must leave every native timing fact unchanged",
      );
      assert.deepEqual(recomputeNativeTiming(mutated), nativeMeasurement);
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
        nativeSnapshot(isolatedReadOnly, sampleKey, homeId, threadId, turnId, responseId),
        mutated,
        "candidate rejection must not mutate the isolated native facts",
      );
    } finally {
      isolatedReadOnly.close();
    }

    assert.equal(existsSync(candidateFile), false, "candidate creation must not publish a destination database");
    assert.equal(existsSync(candidateManifest), false, "candidate creation must not publish a destination manifest");
    assert.deepEqual(
      nativeSnapshot(store.database, sampleKey, homeId, threadId, turnId, responseId),
      original,
      "isolated numeric work must not mutate the native source",
    );

    const outputMismatchFile = path.join(fixture.serverOptions.homeDir, "cold-codex-numeric-output-source.sqlite");
    const outputCandidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-numeric-output-candidate.sqlite");
    await backup(store.database, outputMismatchFile);
    const outputMismatch = new DatabaseSync(outputMismatchFile);
    try {
      const updated = outputMismatch
        .prepare("UPDATE perf_samples SET output_tokens = output_tokens + 1 WHERE sample_key = ?")
        .run(sampleKey);
      assert.equal(Number(updated.changes), 1);
    } finally {
      outputMismatch.close();
    }
    const outputMismatchReadOnly = new DatabaseSync(outputMismatchFile, { readOnly: true });
    try {
      await assert.rejects(
        () =>
          createHistoryArchiveCandidate(outputMismatchReadOnly, outputCandidateFile, {
            startMs: coldStartMs,
            endMs: COLD_END_MS,
          }),
        (error) => {
          assert.equal(error?.code, TIMING_MISMATCH_CODE);
          return true;
        },
      );
    } finally {
      outputMismatchReadOnly.close();
    }
    assert.equal(
      existsSync(outputCandidateFile),
      false,
      "a sample whose net output disagrees with generation evidence must not publish a candidate",
    );

    const rawUsageFile = path.join(fixture.serverOptions.homeDir, "cold-codex-numeric-raw-usage-source.sqlite");
    const rawUsageCandidateFile = path.join(
      fixture.serverOptions.homeDir,
      "cold-codex-numeric-raw-usage-candidate.sqlite",
    );
    const rawOutputTokens = Number(original.requests[0].outputTokens) + 1;
    await backup(store.database, rawUsageFile);
    const rawUsage = new DatabaseSync(rawUsageFile);
    try {
      writeNativeRequestOutput(rawUsage, homeId, responseId, rawOutputTokens);
    } finally {
      rawUsage.close();
    }
    const rawUsageReadOnly = new DatabaseSync(rawUsageFile, { readOnly: true });
    try {
      await createHistoryArchiveCandidate(rawUsageReadOnly, rawUsageCandidateFile, {
        startMs: coldStartMs,
        endMs: COLD_END_MS,
      });
    } finally {
      rawUsageReadOnly.close();
    }
    await verifyHistoryArchiveCandidate(rawUsageCandidateFile);
    const rawUsageCandidate = new DatabaseSync(rawUsageCandidateFile, { readOnly: true });
    try {
      const stored = rawUsageCandidate
        .prepare("SELECT value FROM store_meta WHERE key = ?")
        .get(`history_archive_${"codex_requests"}_v1`);
      const storedTurn = JSON.parse(String(stored.value)).turns.find((turn) => turn.sampleKey === sampleKey);
      assert.equal(storedTurn.requests[0].outputTokens, rawOutputTokens);
      const candidateSnapshot = nativeSnapshot(rawUsageCandidate, sampleKey, homeId, threadId, turnId, responseId);
      assert.equal(candidateSnapshot.sample.output_tokens, original.sample.output_tokens);
      assert.deepEqual(recomputeNativeTiming(candidateSnapshot), nativeMeasurement);
    } finally {
      rawUsageCandidate.close();
    }

    const invalidRawUsageFile = path.join(
      fixture.serverOptions.homeDir,
      "cold-codex-numeric-invalid-raw-usage-source.sqlite",
    );
    const invalidRawUsageCandidateFile = path.join(
      fixture.serverOptions.homeDir,
      "cold-codex-numeric-invalid-raw-usage-candidate.sqlite",
    );
    await backup(store.database, invalidRawUsageFile);
    const invalidRawUsage = new DatabaseSync(invalidRawUsageFile);
    try {
      writeNativeRequestOutput(invalidRawUsage, homeId, responseId, -1);
    } finally {
      invalidRawUsage.close();
    }
    const invalidRawUsageReadOnly = new DatabaseSync(invalidRawUsageFile, { readOnly: true });
    try {
      await assert.rejects(
        () =>
          createHistoryArchiveCandidate(invalidRawUsageReadOnly, invalidRawUsageCandidateFile, {
            startMs: coldStartMs,
            endMs: COLD_END_MS,
          }),
        (error) => {
          assert.equal(error?.code, TIMING_MISMATCH_CODE);
          return true;
        },
      );
    } finally {
      invalidRawUsageReadOnly.close();
    }
    assert.equal(
      existsSync(invalidRawUsageCandidateFile),
      false,
      "an invalid raw usage value must not publish a candidate",
    );
  } finally {
    store.close();
    fixture.close();
  }
});
