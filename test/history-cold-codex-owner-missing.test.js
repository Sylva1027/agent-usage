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

function sourceGraph(database, sampleKey) {
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

  return {
    sample: { ...sample },
    dependencies,
    identities,
    owners,
  };
}

test("candidate rejects a cold explicit Codex sample whose rollout owner is missing", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const isolatedFile = path.join(fixture.serverOptions.homeDir, "cold-codex-owner-missing-source.sqlite");
  const controlCandidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-owner-missing-control.sqlite");
  const candidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-owner-missing-candidate.sqlite");
  const candidateManifest = manifestPathFor(candidateFile);
  const tamperedCandidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-owner-missing-tampered.sqlite");
  const repackedCandidateFile = path.join(fixture.serverOptions.homeDir, "cold-codex-owner-missing-repacked.sqlite");
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
    const originalSource = sourceGraph(store.database, sampleKey);
    assert.ok(originalSource.owners.length > 0, "the selected sample must reference rollout owners");

    await createHistoryArchiveCandidate(store.database, controlCandidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });
    await verifyHistoryArchiveCandidate(controlCandidateFile);
    assert.deepEqual(sourceGraph(store.database, sampleKey), originalSource, "control creation must not mutate source");

    await backup(store.database, isolatedFile);
    const isolated = new DatabaseSync(isolatedFile);
    let missingOwner;
    try {
      const sourcePaths = originalSource.owners.map((owner) => String(owner.source_path));
      const deleted = isolated
        .prepare(
          `DELETE FROM perf_rollout_threads
           WHERE source_path IN (${sourcePaths.map(() => "?").join(",")})`,
        )
        .run(...sourcePaths);
      assert.equal(Number(deleted.changes), originalSource.owners.length);
      missingOwner = sourceGraph(isolated, sampleKey);
      assert.equal(missingOwner.owners.length, 0, "the isolated sample must retain no rollout owner");
      assert.deepEqual(
        { ...missingOwner, owners: originalSource.owners },
        originalSource,
        "removing the rollout owner must leave the sample, dependencies, and source identities unchanged",
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
        sourceGraph(isolatedReadOnly, sampleKey),
        missingOwner,
        "candidate rejection must not mutate the isolated source graph",
      );
    } finally {
      isolatedReadOnly.close();
    }

    assert.equal(existsSync(candidateFile), false, "candidate creation must not publish a destination database");
    assert.equal(existsSync(candidateManifest), false, "candidate creation must not publish a destination manifest");
    assert.deepEqual(sourceGraph(store.database, sampleKey), originalSource, "isolated work must not mutate source");

    const controlSource = new DatabaseSync(controlCandidateFile, { readOnly: true });
    try {
      await backup(controlSource, tamperedCandidateFile);
    } finally {
      controlSource.close();
    }
    const tampered = new DatabaseSync(tamperedCandidateFile);
    try {
      const sourcePaths = originalSource.owners.map((owner) => String(owner.source_path));
      const deleted = tampered
        .prepare(
          `DELETE FROM perf_rollout_threads
           WHERE source_path IN (${sourcePaths.map(() => "?").join(",")})`,
        )
        .run(...sourcePaths);
      assert.equal(Number(deleted.changes), originalSource.owners.length);
      const removedIndex = tampered.prepare("DELETE FROM store_meta WHERE key = 'history_archive_perf_index_v1'").run();
      assert.equal(Number(removedIndex.changes), 1);
      assert.equal(sourceGraph(tampered, sampleKey).owners.length, 0);
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
