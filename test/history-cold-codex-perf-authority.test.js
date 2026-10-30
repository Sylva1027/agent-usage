import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createHistoryArchiveCandidate,
  historyArchivePerfDeletion,
  verifyHistoryArchiveCandidate,
} from "../src/history-archive.js";
import { PERF_METHOD_VERSION, PERF_TOKEN_SCOPE } from "../src/perf-stats.js";
import { PERF_SAMPLE_FIELDS, UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const COLD_END_MS = Date.parse("2026-10-04T12:02:00.000Z");
const TOKENIZER = "o200k_base";
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

function assertCurrentPerfAuthority(perf, oraclePerf) {
  const current = stablePerfEvidence(perf);
  assert.equal(current.meta.methodVersion, PERF_METHOD_VERSION);
  assert.deepEqual(current.meta, oraclePerf.meta, "current v8 authority metadata must match the oracle");
  assert.deepEqual(current.rankedHomeIds, oraclePerf.rankedHomeIds);
  assert.deepEqual(current.groups, oraclePerf.groups, "historical v5 must not change current v8 groups");
  assert.deepEqual(current.models, oraclePerf.models, "historical v5 must not change current v8 model values");
  assert.equal(current.coverage.sampled, oraclePerf.coverage.sampled);
  assert.deepEqual(current.codexTimingCoverage, oraclePerf.codexTimingCoverage);
}

function assertHistoricalV5Diagnostic(perf, oraclePerf) {
  assert.equal(perf.coverage.eligible, oraclePerf.coverage.eligible + 1);
  assert.equal(perf.coverage.dropped, oraclePerf.coverage.dropped + 1);
  assert.equal(perf.coverage.sampled, oraclePerf.coverage.sampled);
  assert.equal(perf.coverage.droppedByReason.historical_method, 1);
}

function rawPerfRows(database, where, ...params) {
  return database
    .prepare(`SELECT ${PERF_COLUMNS.join(", ")} FROM perf_samples WHERE ${where} ORDER BY sample_key`)
    .all(...params)
    .map((row) => ({ ...row }));
}

function installNativeMeasurements(fixture) {
  const measurements = new Map();
  for (const filePath of fixture.rolloutFiles) {
    const rows = readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
    for (const row of rows) {
      if (row.type !== "token_usage_record") continue;
      const responseId = String(row.payload.response_id);
      const outputTokens = Number(row.payload.usage.output_tokens);
      const durationMs = responseId.startsWith("response-25-") ? 200_000 : 1_000;
      row.payload.generation_timing = {
        schema_version: 5,
        tokenizer: TOKENIZER,
        clock: "transport_receive",
        output_tokens: outputTokens,
        observed_duration_ms: durationMs,
        windows: [{ start_ms: 0, end_ms: durationMs, output_tokens: outputTokens }],
      };
      measurements.set(responseId, { outputTokens, durationMs });
    }
    writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  }
  return measurements;
}

function insertHistoricalV5Sample(database, sampleKey, hotTsMs) {
  const source = database
    .prepare(`SELECT ${PERF_COLUMNS.join(", ")} FROM perf_samples WHERE sample_key = ?`)
    .get(sampleKey);
  assert.ok(source, "fixture must persist a current sample before cloning historical evidence");
  const row = { ...source };
  row.sample_key = JSON.stringify([...JSON.parse(sampleKey).slice(0, 4), `${JSON.parse(sampleKey)[4]}-legacy-v5`]);
  row.method_version = "tps-v5";
  row.token_scope = "non_reasoning_output";
  row.output_tokens = 17;
  row.duration_ms = 1_000;
  row.sample_flags = 0;
  row.diagnostic_reason = "";
  row.diagnostic_reason_chain = null;
  row.ts_ms = hotTsMs;
  database
    .prepare(
      `INSERT INTO perf_samples (${PERF_COLUMNS.join(", ")})
       VALUES (${PERF_COLUMNS.map(() => "?").join(", ")})`,
    )
    .run(...PERF_COLUMNS.map((column) => row[column]));
  return row;
}

test("schema5 Codex perf authority restores a measured cold sample without mixing historical v5", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const homeDir = fixture.serverOptions.homeDir;
  const options = {
    ...fixture.serverOptions,
    databaseFile: path.join(homeDir, "cold-codex-perf-authority.sqlite"),
  };
  const candidateFile = path.join(homeDir, "cold-codex-perf-authority-candidate.sqlite");
  const store = new UsageStore(options);
  try {
    const measurements = installNativeMeasurements(fixture);
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
    const persisted = store.database
      .prepare(
        `SELECT method_version, token_scope, output_tokens, duration_ms
         FROM perf_samples
         WHERE method_version = ? AND output_tokens > 0
         ORDER BY sample_key LIMIT 1`,
      )
      .get(PERF_METHOD_VERSION);
    assert.ok(persisted, "schema5 must persist at least one measured v6 sample");
    assert.deepEqual(
      { ...persisted },
      {
        method_version: PERF_METHOD_VERSION,
        token_scope: PERF_TOKEN_SCOPE,
        output_tokens: Number(persisted.output_tokens),
        duration_ms: Number(persisted.duration_ms),
      },
    );
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
    assert.equal(coldSample.tokenScope, PERF_TOKEN_SCOPE);

    const [, keyHomeId, , turnId, responseId] = JSON.parse(coldSample.sampleKey);
    assert.equal(keyHomeId, coldSample.homeId);
    assert.equal(typeof responseId, "string", "the schema5 cold Codex sample key must retain its response identity");
    assert.equal(typeof turnId, "string");
    const measurement = measurements.get(responseId);
    assert.ok(measurement, "the selected cold sample must have schema5 evidence");
    assert.equal(coldSample.outputTokens, measurement.outputTokens);
    assert.equal(coldSample.durationMs, measurement.durationMs);

    const historical = insertHistoricalV5Sample(store.database, coldSample.sampleKey, COLD_END_MS + 60_000);
    assert.deepEqual(
      {
        ...store.database
          .prepare(
            "SELECT method_version, token_scope, output_tokens, duration_ms FROM perf_samples WHERE sample_key = ?",
          )
          .get(historical.sample_key),
      },
      {
        method_version: "tps-v5",
        token_scope: "non_reasoning_output",
        output_tokens: 17,
        duration_ms: 1_000,
      },
      "historical v5 values stay readable",
    );
    const mixedSummary = await store.summarizeHistory(FILTERS);
    assertCurrentPerfAuthority(mixedSummary.perf, oraclePerf);
    assertHistoricalV5Diagnostic(mixedSummary.perf, oraclePerf);

    const hotRowsBefore = rawPerfRows(store.database, "ts_ms >= ?", COLD_END_MS);
    const unplacedRowsBefore = rawPerfRows(store.database, "ts_ms IS NULL");
    assert.ok(hotRowsBefore.length > 0, "fixture must retain hot Codex perf rows");
    assert.ok(
      historyArchivePerfDeletion(store.database, coldStartMs, COLD_END_MS),
      "history archive deletion must admit measured v6 samples using the unified token scope",
    );

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
    assert.ok(
      candidateColdSampleKeys.includes(coldSample.sampleKey),
      "history archive deletion must admit measured v6 samples using the unified token scope",
    );

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
    assertCurrentPerfAuthority(summary.perf, oraclePerf);
    assertHistoricalV5Diagnostic(summary.perf, oraclePerf);
  } finally {
    store.close();
    fixture.close();
  }
});
