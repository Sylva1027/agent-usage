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

function dependencySnapshot(database, sampleKey) {
  const sample = database
    .prepare(`SELECT ${PERF_COLUMNS.join(", ")} FROM perf_samples WHERE sample_key = ?`)
    .get(sampleKey);
  assert.ok(sample, "the isolated source must retain the selected perf sample");

  const sources = database
    .prepare(
      `SELECT dependencies.sample_key, dependencies.source_path, dependencies.role,
              owners.home_id, owners.thread_id
       FROM perf_sample_sources AS dependencies
       JOIN perf_rollout_threads AS owners ON owners.source_path = dependencies.source_path
       WHERE dependencies.sample_key = ?
       ORDER BY dependencies.source_path, dependencies.role`,
    )
    .all(sampleKey)
    .map((row) => ({ ...row }));
  assert.ok(sources.length > 0, "the selected sample must retain its rollout dependencies");

  const sourcePaths = [...new Set(sources.map((source) => String(source.source_path)))].sort();
  const identities = database
    .prepare(
      `SELECT path, kind, home_id, home_label, home_path
       FROM source_files
       WHERE path IN (${sourcePaths.map(() => "?").join(",")})
       ORDER BY path, kind, home_id, home_label, home_path`,
    )
    .all(...sourcePaths)
    .map((row) => ({ ...row }));
  assert.equal(identities.length, sourcePaths.length, "every perf dependency must retain its source identity");

  const owners = [
    ...new Map(
      sources.map((source) => [
        `${source.home_id}\u0000${source.thread_id}`,
        { home_id: String(source.home_id), thread_id: String(source.thread_id) },
      ]),
    ).values(),
  ];
  assert.equal(owners.length, 1, "the selected sample must belong to exactly one native owner");
  const timingLinkCount = Number(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM perf_request_timing_threads
         WHERE home_id = ? AND thread_id = ?`,
      )
      .get(owners[0].home_id, owners[0].thread_id).count,
  );
  const timingEvidence = database
    .prepare(
      `SELECT * FROM perf_request_timing_evidence
       WHERE home_id = ?
       ORDER BY evidence_origin, response_id, variant_key`,
    )
    .all(owners[0].home_id)
    .map((row) => ({ ...row }));

  return {
    sample: { ...sample },
    sources,
    identities,
    owner: owners[0],
    timingLinkCount,
    timingEvidence,
  };
}

test("schema3 candidate tolerates missing external timing links but rejects a missing native projection", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const isolatedFile = path.join(fixture.serverOptions.homeDir, "cold-codex-timing-orphan-source.sqlite");
  const candidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-timing-orphan-candidate.sqlite");
  const candidateManifest = manifestPathFor(candidateFile);
  const nativeCandidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-timing-native-candidate.sqlite");
  const tamperedFile = path.join(fixture.serverOptions.homeDir, "cold-codex-timing-native-tampered.sqlite");
  const repackedFile = path.join(fixture.serverOptions.homeDir, "cold-codex-timing-native-repacked.sqlite");
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
    assert.ok(selected, "fixture must expose a cold completed sample derived from explicit native timing");
    const sampleKey = String(selected.sample_key);
    const original = dependencySnapshot(store.database, sampleKey);
    assert.equal(original.sample.timing_source, "explicit");
    assert.ok(original.timingLinkCount > 0, "the native owner must initially retain request-timing links");

    await backup(store.database, isolatedFile);
    const isolated = new DatabaseSync(isolatedFile);
    let orphaned;
    try {
      const deleted = isolated
        .prepare("DELETE FROM perf_request_timing_threads WHERE home_id = ? AND thread_id = ?")
        .run(original.owner.home_id, original.owner.thread_id);
      assert.equal(Number(deleted.changes), original.timingLinkCount);
      orphaned = dependencySnapshot(isolated, sampleKey);
      assert.equal(orphaned.timingLinkCount, 0, "the isolated owner must retain no timing links");
      assert.deepEqual(
        orphaned.timingEvidence,
        original.timingEvidence,
        "removing timing links must leave the raw timing evidence rows unchanged",
      );
      assert.deepEqual(
        { ...orphaned, timingLinkCount: original.timingLinkCount },
        original,
        "removing timing links must leave the perf sample, owner, and source identities unchanged",
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
        dependencySnapshot(isolatedReadOnly, sampleKey),
        orphaned,
        "candidate creation must not mutate the isolated perf graph",
      );
    } finally {
      isolatedReadOnly.close();
    }

    assert.equal(existsSync(candidateFile), true, "schema3 must remain archivable without external timing links");
    assert.equal(existsSync(candidateManifest), true, "the schema3 candidate must publish its manifest");

    await createHistoryArchiveCandidate(store.database, nativeCandidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });
    await verifyHistoryArchiveCandidate(nativeCandidateFile);

    const candidateSource = new DatabaseSync(nativeCandidateFile, { readOnly: true });
    try {
      await backup(candidateSource, tamperedFile);
    } finally {
      candidateSource.close();
    }
    const tampered = new DatabaseSync(tamperedFile);
    try {
      const deleted = tampered
        .prepare("DELETE FROM perf_codex_projections WHERE home_id = ? AND path = ? COLLATE NOCASE")
        .run(original.owner.home_id, String(original.sample.source_path));
      assert.equal(Number(deleted.changes), 1, "the tampered candidate must lose its native projection");
    } finally {
      tampered.close();
    }

    const repackSource = new DatabaseSync(tamperedFile, { readOnly: true });
    try {
      await createHistoryBackup(repackSource, repackedFile);
    } finally {
      repackSource.close();
    }
    const outer = await verifyHistoryBackup(repackedFile);
    assert.equal(outer.ok, true, "the tampered candidate must retain a valid outer backup checksum");
    await assert.rejects(
      verifyHistoryArchiveCandidate(repackedFile),
      (error) => {
        assert.equal(error?.code, TIMING_MISMATCH_CODE);
        return true;
      },
      `verification accepted the missing native projection for ${original.owner.home_id}/${original.owner.thread_id}`,
    );
  } finally {
    store.close();
    fixture.close();
  }
});
