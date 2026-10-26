import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryBackup } from "../src/history-backup.js";
import {
  createHistoryArchiveCandidate,
  HISTORY_ARCHIVE_CODEX_REQUESTS_META_KEY,
  prepareHistoryArchiveCommit,
  verifyHistoryArchiveCandidate,
} from "../src/history-archive.js";
import { PERF_METHOD_VERSION } from "../src/perf-stats.js";
import { PERF_SAMPLE_FIELDS, UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const COLD_END_MS = Date.parse("2026-10-04T12:02:00.000Z");
const PUBLIC_FILTERS = { preset: "all", now: "2026-10-04T13:00:00.000Z", calendarZone: "utc" };
const PERF_COLUMNS = PERF_SAMPLE_FIELDS.map((entry) => entry.column);
const RETAINED_GRAPH_TABLES = Object.freeze([
  ["source_files", "path"],
  ["perf_rollout_threads", "source_path"],
  ["perf_codex_projections", "path"],
  ["perf_request_timing_meta", "singleton"],
  ["perf_request_timing_evidence", "home_id, evidence_origin, response_id, variant_key"],
  ["perf_request_timing_threads", "home_id, response_id, thread_id"],
  ["perf_request_timing_dirty_threads", "home_id, thread_id"],
]);

function fileSha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function rows(database, sql, ...params) {
  return database
    .prepare(sql)
    .all(...params)
    .map((row) => ({ ...row }));
}

function perfRows(database, where, ...params) {
  return rows(
    database,
    `SELECT ${PERF_COLUMNS.join(", ")} FROM perf_samples WHERE ${where} ORDER BY sample_key`,
    ...params,
  );
}

function dependencyRows(database, sampleKeys) {
  return rows(
    database,
    `SELECT sample_key, source_path, role FROM perf_sample_sources
     WHERE sample_key IN (SELECT value FROM json_each(?))
     ORDER BY sample_key, source_path`,
    JSON.stringify(sampleKeys),
  );
}

function commitRollbackState(database, startMs, endMs, sampleKeys) {
  return {
    events: rows(
      database,
      "SELECT * FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ? ORDER BY id",
      startMs,
      endMs,
    ),
    perf: perfRows(database, "ts_ms >= ? AND ts_ms < ?", startMs, endMs),
    dependencies: dependencyRows(database, sampleKeys),
    registry: rows(database, "SELECT * FROM archive_segments ORDER BY segment_id"),
    authority: rows(
      database,
      `SELECT key, value FROM store_meta
       WHERE key IN ('history_archive_event_authority', 'history_archive_perf_authority')
       ORDER BY key`,
    ),
  };
}

function retainedGraph(database) {
  return Object.fromEntries(
    RETAINED_GRAPH_TABLES.map(([table, orderBy]) => [
      table,
      rows(database, `SELECT * FROM ${table} ORDER BY ${orderBy}`),
    ]),
  );
}

function publicEvidence(report, summary) {
  const perf = structuredClone(summary.perf);
  perf.indexedAt = null;
  perf.meta.indexedAt = null;
  return {
    events: report.events,
    totals: summary.totals,
    costEstimate: summary.costEstimate,
    perf,
  };
}

function insertUnplacedSample(store, templateSampleKey) {
  const [template] = rows(
    store.database,
    `SELECT ${PERF_COLUMNS.join(", ")} FROM perf_samples WHERE sample_key = ?`,
    templateSampleKey,
  );
  assert.ok(template, "the fixture must provide a cold sample to model an unplaced sample");
  const keyParts = JSON.parse(String(template.sample_key));
  assert.equal(keyParts.length, 4);
  keyParts[3] = "turn-unplaced";
  const sampleKey = JSON.stringify(keyParts);
  const unplaced = {
    ...template,
    sample_key: sampleKey,
    turn_key: "turn-unplaced",
    ts_ms: null,
    window_start_ms: null,
    window_end_ms: null,
  };
  store.database
    .prepare(
      `INSERT INTO perf_samples (${PERF_COLUMNS.join(", ")})
       VALUES (${PERF_COLUMNS.map(() => "?").join(", ")})`,
    )
    .run(...PERF_COLUMNS.map((column) => unplaced[column]));
  const dependencies = rows(
    store.database,
    `SELECT source_path, role FROM perf_sample_sources WHERE sample_key = ? ORDER BY source_path`,
    templateSampleKey,
  );
  assert.ok(dependencies.length > 0);
  const insertDependency = store.database.prepare(
    "INSERT INTO perf_sample_sources (sample_key, source_path, role) VALUES (?, ?, ?)",
  );
  for (const dependency of dependencies) {
    insertDependency.run(sampleKey, dependency.source_path, dependency.role);
  }
  return sampleKey;
}

test("formal Codex perf commit moves supported cold tps-v2 samples and replays exactly", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const homeDir = fixture.serverOptions.homeDir;
  const archivedOptions = {
    ...fixture.serverOptions,
    databaseFile: path.join(homeDir, "archive-commit-codex-archived.sqlite"),
  };
  const oracleOptions = {
    ...fixture.serverOptions,
    databaseFile: path.join(homeDir, "archive-commit-codex-oracle.sqlite"),
    importStoreFile: path.join(homeDir, "archive-commit-codex-oracle-imports.json"),
  };
  const candidateFile = path.join(homeDir, "archive-commit-codex-candidate.sqlite");
  const archived = new UsageStore(archivedOptions);
  const oracle = new UsageStore(oracleOptions);
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
    await archived.sync({ options: archivedOptions });
    await oracle.sync({ options: oracleOptions });
    await fixture.seedRequestTiming(archived);
    await fixture.seedRequestTiming(oracle);

    const coldStartMs = Number(archived.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    assert.ok(Number.isSafeInteger(coldStartMs) && coldStartMs < COLD_END_MS);
    const coldPerf = perfRows(archived.database, "ts_ms >= ? AND ts_ms < ?", coldStartMs, COLD_END_MS);
    assert.ok(coldPerf.length > 0, "fixture must contain cold Codex perf samples");
    assert.deepEqual([...new Set(coldPerf.map((sample) => sample.source_kind))], ["codex"]);
    assert.deepEqual(
      [...new Set(coldPerf.map((sample) => sample.method_version))],
      [PERF_METHOD_VERSION],
      "formal commit coverage must start with supported tps-v2 samples",
    );
    assert.ok(
      coldPerf.every((sample) => sample.status === "completed"),
      "cold formal-commit samples must be completed",
    );
    const missingDependencies = Number(
      archived.database
        .prepare(
          `SELECT COUNT(*) AS count FROM perf_samples AS samples
           WHERE samples.ts_ms >= ? AND samples.ts_ms < ?
             AND NOT EXISTS (
               SELECT 1 FROM perf_sample_sources AS dependencies
               WHERE dependencies.sample_key = samples.sample_key
             )`,
        )
        .get(coldStartMs, COLD_END_MS).count,
    );
    assert.equal(missingDependencies, 0, "the cold samples must retain their real dependency graph");
    const nativeTimingSamples = Number(
      archived.database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM perf_samples AS samples
           WHERE samples.ts_ms >= ? AND samples.ts_ms < ?
             AND samples.timing_source = 'explicit'
             AND EXISTS (
               SELECT 1
               FROM perf_sample_sources AS dependencies
               JOIN perf_rollout_threads AS owners ON owners.source_path = dependencies.source_path
               JOIN perf_request_timing_threads AS links
                 ON links.home_id = owners.home_id AND links.thread_id = owners.thread_id
               JOIN perf_request_timing_evidence AS evidence
                 ON evidence.home_id = links.home_id AND evidence.response_id = links.response_id
               WHERE dependencies.sample_key = samples.sample_key
             )`,
        )
        .get(coldStartMs, COLD_END_MS).count,
    );
    assert.ok(nativeTimingSamples > 0, "at least one cold sample must use explicit native timing evidence");

    const unplacedKey = insertUnplacedSample(archived, coldPerf[0].sample_key);
    assert.equal(insertUnplacedSample(oracle, coldPerf[0].sample_key), unplacedKey);
    const coldKeys = coldPerf.map((sample) => String(sample.sample_key));
    const coldDependencies = dependencyRows(archived.database, coldKeys);
    assert.ok(coldDependencies.length > 0);
    const outOfRangeBefore = perfRows(archived.database, "ts_ms >= ?", COLD_END_MS);
    const unplacedBefore = perfRows(archived.database, "ts_ms IS NULL");
    assert.ok(outOfRangeBefore.length > 0, "fixture must retain out-of-range perf samples");
    assert.equal(unplacedBefore.length, 1, "the test must retain exactly one unplaced perf sample");
    const retainedKeys = [...outOfRangeBefore, ...unplacedBefore].map((sample) => String(sample.sample_key));
    const retainedDependenciesBefore = dependencyRows(archived.database, retainedKeys);
    const graphBefore = retainedGraph(archived.database);

    const oracleReport = await oracle.publishedHistoryUsageReport();
    const oracleSummary = await oracle.summarizeHistory(PUBLIC_FILTERS);
    const expected = publicEvidence(oracleReport, oracleSummary);

    await createHistoryArchiveCandidate(archived.database, candidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });
    const candidateDigest = fileSha256(candidateFile);
    const candidate = new DatabaseSync(candidateFile, { readOnly: true });
    try {
      assert.deepEqual(
        perfRows(candidate, "ts_ms >= ? AND ts_ms < ?", coldStartMs, COLD_END_MS),
        coldPerf,
        "the candidate must contain every cold sample before formal commit",
      );
      assert.deepEqual(
        dependencyRows(candidate, coldKeys),
        coldDependencies,
        "the candidate must contain the cold dependency rows",
      );
    } finally {
      candidate.close();
    }

    const plan = await prepareHistoryArchiveCommit(archived.database, candidateFile);
    assert.ok(plan.perfDeletion, "formal prepare must include supported cold Codex tps-v2 perf deletion");
    assert.deepEqual(plan.perfDeletion.sampleKeys, coldKeys);
    assert.equal(plan.perfDeletion.sourceKind, "codex");
    assert.equal(plan.perfDeletion.methodVersion, PERF_METHOD_VERSION);

    const legacyDatabase = path.join(homeDir, "archive-commit-codex-legacy.sqlite");
    const legacyCandidate = path.join(homeDir, "archive-commit-codex-legacy-candidate.sqlite");
    const candidateSource = new DatabaseSync(candidateFile, { readOnly: true });
    try {
      await backup(candidateSource, legacyDatabase);
    } finally {
      candidateSource.close();
    }
    const legacy = new DatabaseSync(legacyDatabase);
    try {
      assert.equal(
        Number(
          legacy.prepare("DELETE FROM store_meta WHERE key = ?").run(HISTORY_ARCHIVE_CODEX_REQUESTS_META_KEY).changes,
        ),
        1,
        "the legacy candidate must omit the native Codex request manifest",
      );
    } finally {
      legacy.close();
    }
    const legacySource = new DatabaseSync(legacyDatabase, { readOnly: true });
    try {
      await createHistoryBackup(legacySource, legacyCandidate);
    } finally {
      legacySource.close();
    }
    await verifyHistoryArchiveCandidate(legacyCandidate);
    const legacyPerfBefore = perfRows(oracle.database, "ts_ms >= ? AND ts_ms < ?", coldStartMs, COLD_END_MS);
    const legacyPlan = await prepareHistoryArchiveCommit(oracle.database, legacyCandidate);
    assert.equal(
      Object.hasOwn(legacyPlan, "perfDeletion"),
      false,
      "a verified legacy candidate without Codex request facts must not authorize perf deletion",
    );
    const legacyCommit = await oracle.commitHistoryArchiveEvents(legacyPlan);
    assert.equal(legacyCommit.inserted, true);
    assert.ok(legacyCommit.deletedEventCount > 0, "the legacy candidate must still commit its events");
    assert.equal(legacyCommit.deletedPerfSampleCount, 0);
    assert.equal(
      oracle.database.prepare("SELECT 1 FROM store_meta WHERE key = 'history_archive_perf_authority'").get(),
      undefined,
      "the events-only legacy commit must not write a perf authority",
    );
    assert.deepEqual(
      perfRows(oracle.database, "ts_ms >= ? AND ts_ms < ?", coldStartMs, COLD_END_MS),
      legacyPerfBefore,
      "events-only legacy commit must leave the unsupported perf range hot",
    );
    const legacyReplayPlan = await prepareHistoryArchiveCommit(oracle.database, legacyCandidate);
    const legacyReplay = await oracle.commitHistoryArchiveEvents(legacyReplayPlan);
    assert.equal(legacyReplay.replay, true);
    assert.equal(legacyReplay.deletedPerfSampleCount, 0);
    assert.deepEqual(
      perfRows(oracle.database, "ts_ms >= ? AND ts_ms < ?", coldStartMs, COLD_END_MS),
      legacyPerfBefore,
      "replaying the events-only legacy commit must not delete hot perf",
    );

    const rollbackBefore = commitRollbackState(archived.database, coldStartMs, COLD_END_MS, coldKeys);
    const coldKeyList = coldKeys.map((sampleKey) => `'${sampleKey.replaceAll("'", "''")}'`).join(", ");
    archived.database.exec(`
      CREATE TRIGGER inject_codex_perf_dependency_failure
      AFTER DELETE ON perf_sample_sources
      WHEN OLD.sample_key IN (${coldKeyList})
      BEGIN
        SELECT RAISE(ABORT, 'INJECTED_CODEX_PERF_DEPENDENCY_FAILURE');
      END;
    `);
    try {
      await assert.rejects(
        archived.commitHistoryArchiveEvents(plan),
        (error) => error instanceof Error && error.message.includes("INJECTED_CODEX_PERF_DEPENDENCY_FAILURE"),
        "the dependency cascade must abort the commit with the named failure",
      );
    } finally {
      archived.database.exec("DROP TRIGGER inject_codex_perf_dependency_failure");
    }
    assert.deepEqual(
      commitRollbackState(archived.database, coldStartMs, COLD_END_MS, coldKeys),
      rollbackBefore,
      "the cascade failure must roll back cold links, perf, events, registry, and authority",
    );
    assert.equal(fileSha256(candidateFile), candidateDigest, "the failed commit must not modify the candidate segment");

    const committed = await archived.commitHistoryArchiveEvents(plan);
    assert.equal(committed.inserted, true);
    assert.equal(committed.replay, false);
    assert.equal(committed.deletedPerfSampleCount, coldKeys.length);
    assert.equal(
      archived.database
        .prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE ts_ms >= ? AND ts_ms < ?")
        .get(coldStartMs, COLD_END_MS).count,
      0,
      "the sealed range must contain no hot perf rows after commit",
    );
    assert.deepEqual(
      perfRows(archived.database, "ts_ms >= ?", COLD_END_MS),
      outOfRangeBefore,
      "out-of-range perf samples must remain unchanged",
    );
    assert.deepEqual(
      perfRows(archived.database, "ts_ms IS NULL"),
      unplacedBefore,
      "unplaced perf samples must remain unchanged",
    );
    assert.deepEqual(
      dependencyRows(archived.database, coldKeys),
      [],
      "cold dependency rows must follow the sample cascade out of the hot carrier",
    );
    assert.deepEqual(
      dependencyRows(archived.database, retainedKeys),
      retainedDependenciesBefore,
      "hot and unplaced dependency rows must remain unchanged",
    );
    assert.deepEqual(retainedGraph(archived.database), graphBefore, "the native dependency graph must remain hot");
    assert.equal(fileSha256(candidateFile), candidateDigest, "commit must not modify the candidate segment");

    const archivedReport = await archived.publishedHistoryUsageReport();
    const archivedSummary = await archived.summarizeHistory(PUBLIC_FILTERS);
    assert.deepEqual(
      publicEvidence(archivedReport, archivedSummary),
      expected,
      "formal commit must preserve complete public history evidence",
    );

    const replay = await archived.commitHistoryArchiveEvents(plan);
    assert.equal(replay.inserted, false);
    assert.equal(replay.replay, true);
    assert.equal(replay.deletedPerfSampleCount, 0);
    assert.deepEqual(
      perfRows(archived.database, "ts_ms >= ?", COLD_END_MS),
      outOfRangeBefore,
      "replay must not duplicate out-of-range perf samples",
    );
    assert.deepEqual(
      perfRows(archived.database, "ts_ms IS NULL"),
      unplacedBefore,
      "replay must not duplicate unplaced perf samples",
    );
    assert.deepEqual(retainedGraph(archived.database), graphBefore, "replay must preserve the retained graph");
    assert.equal(fileSha256(candidateFile), candidateDigest, "replay must not modify the candidate segment");
    const replayedReport = await archived.publishedHistoryUsageReport();
    const replayedSummary = await archived.summarizeHistory(PUBLIC_FILTERS);
    assert.deepEqual(
      publicEvidence(replayedReport, replayedSummary),
      expected,
      "replay must preserve complete public history evidence without duplication",
    );
  } finally {
    archived.close();
    oracle.close();
    fixture.close();
  }
});
