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

test("candidate rejects a linked cold Codex sample whose raw timing evidence is gone", async () => {
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
           AND samples.timing_kind = 'request_e2e'
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
        linkedTimingGraph(isolatedReadOnly, sampleKey),
        unlinkedEvidence,
        "candidate rejection must not mutate the isolated perf/timing graph",
      );
    } finally {
      isolatedReadOnly.close();
    }

    assert.equal(existsSync(candidateFile), false, "candidate creation must not publish a destination database");
    assert.equal(existsSync(candidateManifest), false, "candidate creation must not publish a destination manifest");

    const controlSource = new DatabaseSync(controlCandidateFile, { readOnly: true });
    try {
      await backup(controlSource, tamperedCandidateFile);
    } finally {
      controlSource.close();
    }
    const tampered = new DatabaseSync(tamperedCandidateFile);
    try {
      const candidateGraph = linkedTimingGraph(tampered, sampleKey);
      assert.ok(candidateGraph.evidence.length > 0, "the normal candidate must contain the linked raw evidence");
      const responseIds = candidateGraph.links.map((link) => String(link.response_id));
      const deleted = tampered
        .prepare(
          `DELETE FROM perf_request_timing_evidence
           WHERE home_id = ? AND response_id IN (${responseIds.map(() => "?").join(",")})`,
        )
        .run(candidateGraph.owner.home_id, ...responseIds);
      assert.equal(Number(deleted.changes), candidateGraph.evidence.length);
      assert.equal(
        linkedTimingGraph(tampered, sampleKey).evidence.length,
        0,
        "the repacked candidate must retain no linked raw evidence",
      );
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
