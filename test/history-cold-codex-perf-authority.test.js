import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate, verifyHistoryArchiveCandidate } from "../src/history-archive.js";
import { PERF_METHOD_VERSION } from "../src/perf-stats.js";
import { PERF_SAMPLE_FIELDS, UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const COLD_END_MS = Date.parse("2026-10-04T12:02:00.000Z");
const EVENT_AUTHORITY_KEY = "history_archive_event_authority";
const PERF_AUTHORITY_KEY = "history_archive_perf_authority";
const PERF_COMPONENT_KEYS = [
  "history_archive_perf_sources_v1",
  "history_archive_perf_samples_v1",
  "history_archive_perf_index_v1",
  "history_archive_perf_timing_v1",
];
const PERF_COLUMNS = PERF_SAMPLE_FIELDS.map((entry) => entry.column);
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

function stablePerfEvidence(perf) {
  const evidence = structuredClone(perf);
  evidence.indexedAt = null;
  evidence.meta.indexedAt = null;
  return evidence;
}

function rawPerfRows(database, where, ...params) {
  return database
    .prepare(`SELECT ${PERF_COLUMNS.join(", ")} FROM perf_samples WHERE ${where} ORDER BY sample_key`)
    .all(...params)
    .map((row) => ({ ...row }));
}

test("explicit Codex perf authority restores a timing-derived cold sample", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const homeDir = fixture.serverOptions.homeDir;
  const options = {
    ...fixture.serverOptions,
    databaseFile: path.join(homeDir, "cold-codex-perf-authority.sqlite"),
  };
  const candidateFile = path.join(homeDir, "cold-codex-perf-authority-candidate.sqlite");
  const store = new UsageStore(options);
  try {
    appendFileSync(
      fixture.rolloutFiles[0],
      `${JSON.stringify({
        timestamp: "2026-10-04T12:00:05.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { total_tokens: 100, input_tokens: 80, output_tokens: 20 } },
        },
      })}\n`,
    );
    await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(store);
    const oraclePerf = stablePerfEvidence((await store.summarizeHistory(FILTERS)).perf);

    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    const coldSamples = store.perfCandidatesForRange({
      startMs: coldStartMs,
      endMs: COLD_END_MS - 1,
    });
    const coldSample = coldSamples.find(
      (sample) => sample.status === "completed" && sample.outputTokens > 0 && sample.durationMs > 0,
    );
    assert.ok(coldSample, "fixture must expose a computable cold Codex perf sample");
    assert.equal(coldSample.sourceKind, "codex");
    assert.equal(coldSample.methodVersion, PERF_METHOD_VERSION);
    assert.equal(coldSample.timingKind, "generation");
    assert.equal(coldSample.timingSource, "explicit");

    const [, keyHomeId, threadId, turnId, responseId] = JSON.parse(coldSample.sampleKey);
    assert.equal(keyHomeId, coldSample.homeId);
    assert.equal(typeof responseId, "string", "the v3 cold Codex sample key must retain its response identity");
    const baseTiming = fixture.timingRecords.find((record) => record.responseId === responseId);
    assert.ok(baseTiming, "the selected cold sample must have fixture timing evidence");
    const nativeTiming = store.database
      .prepare(
        `SELECT evidence.reported_output_tokens, evidence.generation_json
         FROM perf_request_timing_evidence AS evidence
         JOIN perf_request_timing_threads AS links
           ON links.home_id = evidence.home_id AND links.response_id = evidence.response_id
         WHERE evidence.home_id = ? AND evidence.response_id = ? AND links.thread_id = ?`,
      )
      .all(coldSample.homeId, responseId, threadId)
      .map((row) => ({
        reportedOutputTokens: Number(row.reported_output_tokens),
        generation: JSON.parse(String(row.generation_json)),
      }));
    assert.deepEqual(
      nativeTiming,
      [{ reportedOutputTokens: baseTiming.reportedOutputTokens, generation: baseTiming.generation }],
      "the selected cold sample must be backed by its exact native Codex response evidence",
    );
    assert.equal(
      coldSample.outputTokens,
      baseTiming.generation.outputTokens - baseTiming.generation.startOutputTokens,
      "the v3 sample output must be the net non-reasoning generation count",
    );
    assert.equal(coldSample.durationMs, baseTiming.generation.durationMs);

    const hotRowsBefore = rawPerfRows(store.database, "ts_ms >= ?", COLD_END_MS);
    const unplacedRowsBefore = rawPerfRows(store.database, "ts_ms IS NULL");
    assert.ok(hotRowsBefore.length > 0, "fixture must retain hot Codex perf rows");

    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });
    const candidateDigest = fileSha256(candidateFile);
    const verified = await verifyHistoryArchiveCandidate(candidateFile);
    assert.equal(verified.ok, true);

    const candidate = new DatabaseSync(candidateFile, { readOnly: true });
    let candidateColdSampleKeys;
    try {
      const componentKeys = candidate
        .prepare(`SELECT key FROM store_meta WHERE key IN (?, ?, ?, ?) ORDER BY key`)
        .all(...PERF_COMPONENT_KEYS)
        .map((row) => String(row.key));
      assert.deepEqual(componentKeys, [...PERF_COMPONENT_KEYS].sort());
      candidateColdSampleKeys = candidate
        .prepare(`SELECT sample_key FROM perf_samples WHERE ts_ms >= ? AND ts_ms < ? ORDER BY sample_key`)
        .all(coldStartMs, COLD_END_MS)
        .map((row) => String(row.sample_key));
    } finally {
      candidate.close();
    }
    assert.ok(candidateColdSampleKeys.includes(coldSample.sampleKey));

    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    assert.equal(registered.databaseSha256, candidateDigest);
    store.database.exec("BEGIN IMMEDIATE");
    try {
      writeMeta(store.database, EVENT_AUTHORITY_KEY, {
        formatVersion: 1,
        segmentIds: [registered.segmentId],
      });
      writeMeta(store.database, PERF_AUTHORITY_KEY, {
        formatVersion: 1,
        segments: [
          {
            segmentId: registered.segmentId,
            databaseSha256: registered.databaseSha256,
            sourceKinds: ["codex"],
            methodVersions: [PERF_METHOD_VERSION],
          },
        ],
      });
      const deletedEvents = store.database.prepare("DELETE FROM events WHERE timestamp_ms < ?").run(COLD_END_MS);
      assert.ok(Number(deletedEvents.changes) > 0, "test must remove the candidate's cold event range");
      const deletedSample = store.database
        .prepare("DELETE FROM perf_samples WHERE sample_key = ?")
        .run(coldSample.sampleKey);
      assert.equal(Number(deletedSample.changes), 1, "test must remove exactly one cold perf sample");
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }

    assert.deepEqual(
      rawPerfRows(store.database, "ts_ms >= ?", COLD_END_MS),
      hotRowsBefore,
      "cold eviction must leave every hot perf column unchanged",
    );
    assert.deepEqual(
      rawPerfRows(store.database, "ts_ms IS NULL"),
      unplacedRowsBefore,
      "cold eviction must leave every unplaced perf column unchanged",
    );

    let summary;
    try {
      summary = await store.summarizeHistory(FILTERS);
    } catch (error) {
      assert.fail(
        `Codex cold perf authority must produce a summary, got ${error?.code ?? "(none)"}: ${error?.message ?? error}`,
      );
    } finally {
      assert.equal(fileSha256(candidateFile), candidateDigest, "summary reads must not modify the cold segment");
    }
    assert.deepEqual(
      stablePerfEvidence(summary.perf),
      oraclePerf,
      "explicit Codex authority must restore the complete unarchived perf evidence",
    );
  } finally {
    store.close();
    fixture.close();
  }
});
