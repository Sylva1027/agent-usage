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
const TIMING_MISMATCH_CODE = "HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_MISMATCH";
const PERF_COLUMNS = PERF_SAMPLE_FIELDS.map((entry) => entry.column);

function manifestPathFor(databaseFile) {
  const parsed = path.parse(databaseFile);
  return path.join(parsed.dir, `${parsed.name}.manifest.json`);
}

function linkedTimingGraph(database, sampleKey) {
  const sample = database
    .prepare(`SELECT ${PERF_COLUMNS.join(", ")} FROM perf_samples WHERE sample_key = ?`)
    .get(sampleKey);
  assert.ok(sample, "the isolated source must retain the selected perf sample");

  const owners = database
    .prepare(
      `SELECT DISTINCT owners.home_id, owners.thread_id
       FROM perf_sample_sources AS dependencies
       JOIN perf_rollout_threads AS owners ON owners.source_path = dependencies.source_path
       WHERE dependencies.sample_key = ?
       ORDER BY owners.home_id, owners.thread_id`,
    )
    .all(sampleKey)
    .map((row) => ({ home_id: String(row.home_id), thread_id: String(row.thread_id) }));
  assert.equal(owners.length, 1, "the selected sample must belong to exactly one native owner");

  const links = database
    .prepare(
      `SELECT home_id, response_id, thread_id
       FROM perf_request_timing_threads
       WHERE home_id = ? AND thread_id = ?
       ORDER BY response_id`,
    )
    .all(owners[0].home_id, owners[0].thread_id)
    .map((row) => ({ ...row }));
  assert.ok(links.length > 0, "the native owner must retain request-timing links");

  const responseIds = links.map((link) => String(link.response_id));
  const evidence = database
    .prepare(
      `SELECT *
       FROM perf_request_timing_evidence
       WHERE home_id = ? AND response_id IN (${responseIds.map(() => "?").join(",")})
       ORDER BY evidence_origin, response_id, variant_key`,
    )
    .all(owners[0].home_id, ...responseIds)
    .map((row) => ({ ...row }));

  return {
    sample: { ...sample },
    owner: owners[0],
    links,
    evidence,
  };
}

test("schema3 candidate tolerates removed external timing evidence but requires native projections", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const isolatedFile = path.join(fixture.serverOptions.homeDir, "cold-codex-linked-evidence-source.sqlite");
  const controlCandidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-linked-evidence-control.sqlite");
  const candidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-linked-evidence-candidate.sqlite");
  const candidateManifest = manifestPathFor(candidateFile);
  const tamperedCandidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-linked-evidence-tampered.sqlite");
  const repackedCandidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-linked-evidence-repacked.sqlite");
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(store);
    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    const selected = store.database
      .prepare(
        `SELECT samples.sample_key
         FROM perf_samples AS samples
         WHERE samples.ts_ms >= ? AND samples.ts_ms < ?
           AND samples.source_kind = 'codex'
           AND samples.status = 'completed'
           AND samples.timing_kind = 'generation'
           AND samples.timing_source = 'explicit'
           AND EXISTS (
             SELECT 1
             FROM perf_sample_sources AS dependencies
             JOIN perf_rollout_threads AS owners ON owners.source_path = dependencies.source_path
             JOIN perf_request_timing_threads AS timing
               ON timing.home_id = owners.home_id AND timing.thread_id = owners.thread_id
             WHERE dependencies.sample_key = samples.sample_key
           )
         ORDER BY samples.ts_ms, samples.sample_key
         LIMIT 1`,
      )
      .get(coldStartMs, COLD_END_MS);
    assert.ok(selected, "fixture must expose a linked cold sample derived from explicit native timing");
    const sampleKey = String(selected.sample_key);
    const original = linkedTimingGraph(store.database, sampleKey);
    assert.equal(original.sample.timing_source, "explicit");
    assert.ok(original.evidence.length > 0, "the native links must initially resolve raw timing evidence");

    await createHistoryArchiveCandidate(store.database, controlCandidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });
    await verifyHistoryArchiveCandidate(controlCandidateFile);

    await backup(store.database, isolatedFile);
    const isolated = new DatabaseSync(isolatedFile);
    let unlinkedEvidence;
    try {
      const responseIds = original.links.map((link) => String(link.response_id));
      const deleted = isolated
        .prepare(
          `DELETE FROM perf_request_timing_evidence
           WHERE home_id = ? AND response_id IN (${responseIds.map(() => "?").join(",")})`,
        )
        .run(original.owner.home_id, ...responseIds);
      assert.equal(Number(deleted.changes), original.evidence.length);
      unlinkedEvidence = linkedTimingGraph(isolated, sampleKey);
      assert.equal(unlinkedEvidence.evidence.length, 0, "linked responses must retain no raw timing evidence");
      assert.deepEqual(
        { ...unlinkedEvidence, evidence: original.evidence },
        original,
        "removing raw evidence must leave the perf sample, owner, and timing links unchanged",
      );
    } finally {
      isolated.close();
    }

    const isolatedReadOnly = new DatabaseSync(isolatedFile, { readOnly: true });
    try {
      await createHistoryArchiveCandidate(isolatedReadOnly, candidateFile, {
        startMs: coldStartMs,
        endMs: COLD_END_MS,
      });
      await verifyHistoryArchiveCandidate(candidateFile);
      assert.deepEqual(
        linkedTimingGraph(isolatedReadOnly, sampleKey),
        unlinkedEvidence,
        "candidate creation must not mutate the isolated perf/timing graph",
      );
    } finally {
      isolatedReadOnly.close();
    }

    assert.equal(existsSync(candidateFile), true, "schema3 must remain archivable without external timing evidence");
    assert.equal(existsSync(candidateManifest), true, "the schema3 candidate must publish its manifest");

    const controlSource = new DatabaseSync(controlCandidateFile, { readOnly: true });
    try {
      await backup(controlSource, tamperedCandidateFile);
    } finally {
      controlSource.close();
    }
    const tampered = new DatabaseSync(tamperedCandidateFile);
    try {
      const candidateGraph = linkedTimingGraph(tampered, sampleKey);
      const deleted = tampered
        .prepare("DELETE FROM perf_codex_projections WHERE home_id = ? AND path = ? COLLATE NOCASE")
        .run(candidateGraph.owner.home_id, String(candidateGraph.sample.source_path));
      assert.equal(Number(deleted.changes), 1, "the repacked candidate must lose its selected native projection");
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
        assert.equal(error?.code, TIMING_MISMATCH_CODE);
        return true;
      },
    );
  } finally {
    store.close();
    fixture.close();
  }
});

test("explicit tps-v3 candidates still require external request timing evidence", async () => {
  const fixture = createPerfCodexIntegrationFixture({ nativeTiming: false });
  const controlCandidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-v3-linked-control.sqlite");
  const isolatedFile = path.join(fixture.serverOptions.homeDir, "cold-codex-v3-linked-source.sqlite");
  const candidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-v3-linked-candidate.sqlite");
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(store);
    const updateLegacySample = store.database.prepare(
      `UPDATE perf_samples
       SET method_version = 'tps-v3',
           token_scope = 'non_reasoning_output',
           timing_kind = 'generation',
           timing_source = 'explicit',
           window = 'request',
           output_tokens = ?,
           duration_ms = ?
       WHERE sample_key = ?`,
    );
    for (const row of store.database.prepare("SELECT sample_key FROM perf_samples").all()) {
      const responseId = JSON.parse(String(row.sample_key))[4];
      const timing = fixture.timingRecords.find((record) => record.responseId === responseId);
      assert.ok(timing, "every explicit v3 sample must retain its external timing row");
      updateLegacySample.run(timing.reportedOutputTokens, timing.generation.durationMs, String(row.sample_key));
    }
    assert.deepEqual(
      store.database
        .prepare("SELECT DISTINCT method_version FROM perf_samples ORDER BY method_version")
        .all()
        .map((row) => String(row.method_version)),
      ["tps-v3"],
    );

    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    await createHistoryArchiveCandidate(store.database, controlCandidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });
    await verifyHistoryArchiveCandidate(controlCandidateFile);

    const selected = store.database
      .prepare(
        `SELECT sample_key, home_id
         FROM perf_samples
         WHERE ts_ms >= ? AND ts_ms < ?
         ORDER BY ts_ms, sample_key
         LIMIT 1`,
      )
      .get(coldStartMs, COLD_END_MS);
    assert.ok(selected);
    const [, , , , responseId] = JSON.parse(String(selected.sample_key));

    await backup(store.database, isolatedFile);
    const isolated = new DatabaseSync(isolatedFile);
    try {
      const deleted = isolated
        .prepare("DELETE FROM perf_request_timing_evidence WHERE home_id = ? AND response_id = ?")
        .run(String(selected.home_id), responseId);
      assert.ok(Number(deleted.changes) > 0, "the explicit v3 sample must lose its external timing evidence");
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
    } finally {
      isolatedReadOnly.close();
    }
    assert.equal(existsSync(candidateFile), false, "a v3 candidate without external timing must not be published");
  } finally {
    store.close();
    fixture.close();
  }
});
