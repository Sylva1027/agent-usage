import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { PERF_METHOD_VERSION } from "../src/perf-stats.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

const EVENT_AUTHORITY_KEY = "history_archive_event_authority";
const PERF_AUTHORITY_KEY = "history_archive_perf_authority";
const HOT_START_MS = Date.parse("2026-10-04T12:00:00.000Z");
const FILTERS = { preset: "all", now: "2026-10-04T13:00:00.000Z", calendarZone: "utc" };

function writeMeta(database, key, value) {
  database
    .prepare(
      `INSERT INTO store_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, JSON.stringify(value));
}

function fileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function stablePerf(summary) {
  const perf = structuredClone(summary.perf);
  // Index time records when this process read the same immutable inputs.
  perf.indexedAt = null;
  perf.meta.indexedAt = null;
  return perf;
}

test("overlapping hot and cold perf payloads conflict, then recover on the same store", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const homeDir = fixture.serverOptions.homeDir;
  const archivedOptions = {
    ...fixture.serverOptions,
    databaseFile: path.join(homeDir, "cold-perf-conflict-archived.sqlite"),
  };
  const oracleOptions = {
    ...fixture.serverOptions,
    databaseFile: path.join(homeDir, "cold-perf-conflict-oracle.sqlite"),
    importStoreFile: path.join(homeDir, "cold-perf-conflict-oracle-imports.json"),
  };
  const candidateFile = path.join(homeDir, "cold-perf-conflict-candidate.sqlite");
  const archived = new UsageStore(archivedOptions);
  const oracle = new UsageStore(oracleOptions);
  try {
    await archived.sync({ options: archivedOptions });
    await oracle.sync({ options: oracleOptions });

    const coldStartMs = Number(archived.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    await createHistoryArchiveCandidate(archived.database, candidateFile, {
      startMs: coldStartMs,
      endMs: HOT_START_MS,
    });
    const candidateDigest = fileSha256(candidateFile);
    const registered = await archived.registerHistoryArchiveCandidate(candidateFile);
    assert.equal(registered.databaseSha256, candidateDigest);

    const coldSamples = await archived.readHistoryArchivePerfSamples(registered.segmentId);
    const liveSamples = archived.perfCandidatesForRange({
      startMs: coldStartMs,
      endMs: HOT_START_MS - 1,
    });
    const liveByKey = new Map(liveSamples.map((sample) => [sample.sampleKey, sample]));
    const overlap = coldSamples.find((sample) => {
      const live = liveByKey.get(sample.sampleKey);
      return (
        live !== undefined &&
        sample.status === "completed" &&
        sample.outputTokens === null &&
        sample.durationMs === null &&
        sample.requestCount === 1 &&
        JSON.stringify(live) === JSON.stringify(sample)
      );
    });
    assert.ok(overlap, "fixture must retain an identical cold sample in both the candidate and live perf");
    assert.equal(overlap.sourceKind, "zcode");
    assert.equal(overlap.methodVersion, PERF_METHOD_VERSION);
    assert.equal(overlap.timingKind, "generation");
    assert.equal(overlap.tokenScope, "non_reasoning_output");
    assert.equal(overlap.timingSource, "unknown");

    archived.database.exec("BEGIN IMMEDIATE");
    try {
      writeMeta(archived.database, EVENT_AUTHORITY_KEY, {
        formatVersion: 1,
        segmentIds: [registered.segmentId],
      });
      writeMeta(archived.database, PERF_AUTHORITY_KEY, {
        formatVersion: 1,
        segments: [
          {
            segmentId: registered.segmentId,
            databaseSha256: registered.databaseSha256,
            sourceKinds: ["zcode"],
            methodVersions: [PERF_METHOD_VERSION],
          },
        ],
      });
      const deleted = archived.database.prepare("DELETE FROM events WHERE timestamp_ms < ?").run(HOT_START_MS);
      assert.ok(Number(deleted.changes) > 0, "fixture must archive a non-empty cold event range");
      archived.database.exec("COMMIT");
    } catch (error) {
      archived.database.exec("ROLLBACK");
      throw error;
    }

    const mutated = archived.database
      .prepare("UPDATE perf_samples SET duration_ms = ? WHERE sample_key = ?")
      .run(overlap.durationMs + 1, overlap.sampleKey);
    assert.equal(Number(mutated.changes), 1, "test must mutate one non-key field of the overlapping live sample");
    await assert.rejects(
      archived.summarizeHistory(FILTERS),
      (error) => error?.code === "HISTORY_ARCHIVE_PERF_SAMPLE_CONFLICT",
      "a differing full payload under the same sample_key must not be silently merged",
    );

    const restored = archived.database
      .prepare("UPDATE perf_samples SET duration_ms = ? WHERE sample_key = ?")
      .run(overlap.durationMs, overlap.sampleKey);
    assert.equal(Number(restored.changes), 1);
    const recovered = await archived.summarizeHistory(FILTERS);
    const oracleSummary = await oracle.summarizeHistory(FILTERS);
    assert.deepEqual(
      stablePerf(recovered),
      stablePerf(oracleSummary),
      "restoring the same value on the same store must recover the unarchived oracle's full stable perf",
    );
    assert.equal(fileSha256(candidateFile), candidateDigest, "conflict and recovery must not modify the cold segment");
  } finally {
    archived.close();
    oracle.close();
    fixture.close();
  }
});
