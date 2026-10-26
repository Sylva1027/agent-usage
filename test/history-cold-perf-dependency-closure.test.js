import assert from "node:assert/strict";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryBackup, verifyHistoryBackup } from "../src/history-backup.js";
import { createHistoryArchiveCandidate, verifyHistoryArchiveCandidate } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const COLD_END_MS = Date.parse("2026-10-04T12:02:00.000Z");
const MISSING_DEPENDENCY_CODE = "HISTORY_ARCHIVE_CANDIDATE_PERF_DEPENDENCIES_MISMATCH";

async function copyDatabase(sourceFile, destinationFile) {
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  try {
    await backup(source, destinationFile);
  } finally {
    source.close();
  }
}

function readDependency(database, sampleKey, sourcePath) {
  return database
    .prepare(
      `SELECT dependencies.sample_key, dependencies.source_path, dependencies.role,
              owners.home_id, owners.thread_id,
              (
                SELECT COUNT(*) FROM perf_request_timing_threads AS timing
                WHERE timing.home_id = owners.home_id AND timing.thread_id = owners.thread_id
              ) AS timing_link_count
       FROM perf_sample_sources AS dependencies
       JOIN perf_rollout_threads AS owners ON owners.source_path = dependencies.source_path
       WHERE dependencies.sample_key = ? AND dependencies.source_path = ?`,
    )
    .get(sampleKey, sourcePath);
}

test("an archive candidate with a missing cold perf dependency is not accepted as a complete capability", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const candidateFile = path.join(fixture.serverOptions.homeDir, "cold-perf-closure-candidate.sqlite");
  const tamperedFile = path.join(fixture.serverOptions.homeDir, "cold-perf-closure-tampered.sqlite");
  const repackedFile = path.join(fixture.serverOptions.homeDir, "cold-perf-closure-repacked.sqlite");
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(store);
    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    const sourceSelection = store.database
      .prepare(
        `SELECT samples.sample_key, samples.source_path AS primary_source_path, samples.ts_ms,
                dependencies.source_path AS dependency_source_path, dependencies.role,
                owners.home_id, owners.thread_id
         FROM perf_samples AS samples
         JOIN perf_sample_sources AS dependencies ON dependencies.sample_key = samples.sample_key
         JOIN perf_rollout_threads AS owners ON owners.source_path = dependencies.source_path
         WHERE samples.ts_ms >= ? AND samples.ts_ms < ?
           AND dependencies.role = 'dependency'
           AND EXISTS (
             SELECT 1 FROM perf_request_timing_threads AS timing
             WHERE timing.home_id = owners.home_id AND timing.thread_id = owners.thread_id
           )
         ORDER BY samples.ts_ms, samples.sample_key, dependencies.source_path
         LIMIT 1`,
      )
      .get(coldStartMs, COLD_END_MS);
    if (!sourceSelection) {
      throw new Error("fixture must expose a cold sample with a logged dependency and native timing link");
    }
    const sourceDependency = readDependency(
      store.database,
      sourceSelection.sample_key,
      sourceSelection.dependency_source_path,
    );
    if (!sourceDependency || Number(sourceDependency.timing_link_count) === 0) {
      throw new Error("source dependency must retain its rollout owner and native timing links");
    }

    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });
    await verifyHistoryArchiveCandidate(candidateFile);

    const candidate = new DatabaseSync(candidateFile, { readOnly: true });
    let candidateDependency;
    try {
      candidateDependency = readDependency(
        candidate,
        sourceSelection.sample_key,
        sourceSelection.dependency_source_path,
      );
    } finally {
      candidate.close();
    }
    assert.deepEqual(
      candidateDependency,
      sourceDependency,
      "candidate creation must preserve the source-locked dependency, owner, and native timing relation",
    );

    await copyDatabase(candidateFile, tamperedFile);
    const tampered = new DatabaseSync(tamperedFile);
    try {
      const deleted = tampered
        .prepare(
          `DELETE FROM perf_sample_sources
           WHERE sample_key = ? AND source_path = ? AND role = 'dependency'`,
        )
        .run(sourceDependency.sample_key, sourceDependency.source_path);
      if (Number(deleted.changes) !== 1) {
        throw new Error("test must delete exactly one dependency relation from the copied candidate");
      }
      if (
        Number(
          tampered
            .prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE sample_key = ?")
            .get(sourceDependency.sample_key).count,
        ) !== 1
      ) {
        throw new Error("the referenced perf sample must remain present after deleting its dependency");
      }
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
    if (!outer.ok) {
      throw new Error("repacked candidate must retain a valid outer backup checksum");
    }

    await assert.rejects(
      verifyHistoryArchiveCandidate(repackedFile),
      (error) => error?.code === MISSING_DEPENDENCY_CODE,
      `verification accepted an incomplete cold perf graph: deleted (${sourceDependency.sample_key}, ${sourceDependency.source_path}) for ${sourceDependency.home_id}/${sourceDependency.thread_id}`,
    );
  } finally {
    store.close();
    fixture.close();
  }
});
