import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const COLD_END_MS = Date.parse("2026-10-04T12:02:00.000Z");

function fileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function timingDependencyGraph(database) {
  const coldSample = database
    .prepare(
      `SELECT sample_key FROM perf_samples
       WHERE ts_ms < ? ORDER BY ts_ms, sample_key LIMIT 1`,
    )
    .get(COLD_END_MS);
  assert.ok(coldSample, "fixture must have a cold perf sample");

  const sampleOwners = database
    .prepare(
      `SELECT DISTINCT owners.home_id, owners.thread_id
       FROM perf_sample_sources AS dependencies
       JOIN perf_rollout_threads AS owners ON owners.source_path = dependencies.source_path
       WHERE dependencies.sample_key = ?
       ORDER BY owners.home_id, owners.thread_id`,
    )
    .all(String(coldSample.sample_key));
  assert.equal(sampleOwners.length, 1, "the cold sample must belong to exactly one Codex thread");
  const homeId = String(sampleOwners[0].home_id);
  const threadId = String(sampleOwners[0].thread_id);

  const samples = database
    .prepare(
      `SELECT samples.*
       FROM perf_samples AS samples
       WHERE EXISTS (
         SELECT 1
         FROM perf_sample_sources AS dependencies
         JOIN perf_rollout_threads AS owners ON owners.source_path = dependencies.source_path
         WHERE dependencies.sample_key = samples.sample_key
           AND owners.home_id = ? AND owners.thread_id = ?
       )
       ORDER BY samples.ts_ms, samples.sample_key`,
    )
    .all(homeId, threadId)
    .map((row) => ({ ...row }));

  const sampleSources = database
    .prepare(
      `SELECT dependencies.*
       FROM perf_sample_sources AS dependencies
       WHERE EXISTS (
         SELECT 1
         FROM perf_sample_sources AS related
         JOIN perf_rollout_threads AS owners ON owners.source_path = related.source_path
         WHERE related.sample_key = dependencies.sample_key
           AND owners.home_id = ? AND owners.thread_id = ?
       )
       ORDER BY dependencies.sample_key, dependencies.source_path`,
    )
    .all(homeId, threadId)
    .map((row) => ({ ...row }));

  const rolloutThreads = database
    .prepare(
      `SELECT * FROM perf_rollout_threads
       WHERE home_id = ? AND thread_id = ? ORDER BY source_path`,
    )
    .all(homeId, threadId)
    .map((row) => ({ ...row }));

  const sourcePaths = [...new Set([...sampleSources, ...rolloutThreads].map((row) => String(row.source_path)))].sort();
  const sourceFiles = database
    .prepare(
      `SELECT * FROM source_files
       WHERE path IN (${sourcePaths.map(() => "?").join(",")}) ORDER BY path`,
    )
    .all(...sourcePaths)
    .map((row) => ({ ...row }));

  const timingMeta = database
    .prepare("SELECT * FROM perf_request_timing_meta ORDER BY singleton")
    .all()
    .map((row) => ({ ...row }));
  const timingThreads = database
    .prepare(
      `SELECT * FROM perf_request_timing_threads
       WHERE home_id = ? AND thread_id = ? ORDER BY response_id, thread_id`,
    )
    .all(homeId, threadId)
    .map((row) => ({ ...row }));
  const timingEvidence = database
    .prepare(
      `SELECT evidence.*
       FROM perf_request_timing_evidence AS evidence
       JOIN perf_request_timing_threads AS links
         ON links.home_id = evidence.home_id AND links.response_id = evidence.response_id
       WHERE links.home_id = ? AND links.thread_id = ?
       ORDER BY evidence.evidence_origin, evidence.response_id, evidence.variant_key`,
    )
    .all(homeId, threadId)
    .map((row) => ({ ...row }));
  const timingDirtyThreads = database
    .prepare(
      `SELECT * FROM perf_request_timing_dirty_threads
       WHERE home_id = ? AND thread_id = ? ORDER BY home_id, thread_id`,
    )
    .all(homeId, threadId)
    .map((row) => ({ ...row }));

  return {
    homeId,
    threadId,
    selectedColdSampleKey: String(coldSample.sample_key),
    samples,
    sampleSources,
    rolloutThreads,
    sourceFiles,
    timingMeta,
    timingThreads,
    timingEvidence,
    timingDirtyThreads,
  };
}

function assertTimingDependencyClosure(graph, expectedTimingCount) {
  const linkKeys = new Set(graph.timingThreads.map((row) => `${row.home_id}\u0000${row.response_id}`));
  const sourcePaths = new Set(graph.sourceFiles.map((row) => String(row.path)));
  const dependentPaths = new Set(
    [...graph.sampleSources, ...graph.rolloutThreads].map((row) => String(row.source_path)),
  );

  assert.ok(expectedTimingCount > 0, "fixture must contain request-timing evidence");
  assert.equal(graph.timingEvidence.length, expectedTimingCount, "every fixture timing record must be present");
  assert.equal(
    graph.timingThreads.length,
    expectedTimingCount,
    "every fixture timing record must have one native link",
  );
  for (const evidence of graph.timingEvidence) {
    assert.ok(
      linkKeys.has(`${evidence.home_id}\u0000${evidence.response_id}`),
      `timing evidence ${evidence.home_id}/${evidence.response_id} must have a native thread link`,
    );
  }
  for (const sourcePath of dependentPaths) {
    assert.ok(sourcePaths.has(sourcePath), `perf dependency ${sourcePath} must have a source identity`);
  }
}

test("cold Codex request-timing dependencies survive in an archive candidate", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const candidateFile = path.join(fixture.serverOptions.homeDir, "cold-timing-candidate.sqlite");
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(store);
    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    const sourceBefore = timingDependencyGraph(store.database);
    assertTimingDependencyClosure(sourceBefore, fixture.timingRecords.length);

    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });
    const sourceAfter = timingDependencyGraph(store.database);
    assert.deepEqual(sourceAfter, sourceBefore, "candidate creation must not mutate the source timing graph");

    const digestBefore = fileSha256(candidateFile);
    const candidate = new DatabaseSync(candidateFile, { readOnly: true });
    let candidateGraph;
    try {
      candidateGraph = timingDependencyGraph(candidate);
    } finally {
      candidate.close();
    }
    assert.deepEqual(candidateGraph, sourceAfter, "the candidate must preserve every thread timing dependency row");

    for (const graph of [sourceAfter, candidateGraph]) {
      assert.ok(
        graph.samples.some((sample) => Number(sample.ts_ms) < COLD_END_MS),
        "the shared thread must have cold perf samples",
      );
      assert.ok(
        graph.samples.some((sample) => Number(sample.ts_ms) >= COLD_END_MS),
        "the shared thread must also have hot perf samples",
      );
      assert.ok(
        graph.sampleSources.some((source) => source.role === "dependency"),
        "the graph must include cross-rollout dependency rows",
      );
    }
    assert.equal(fileSha256(candidateFile), digestBefore, "reading the candidate must not modify it");
  } finally {
    store.close();
    fixture.close();
  }
});
