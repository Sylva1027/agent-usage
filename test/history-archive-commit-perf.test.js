import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  createHistoryArchiveCandidate,
  prepareHistoryArchiveCommit,
  verifyHistoryArchiveCandidate,
} from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

const HISTORICAL_METHOD_VERSION = "tps-v5";
const HOT_START_MS = Date.parse("2026-10-04T12:00:00.000Z");
const EVENT_AUTHORITY_KEY = "history_archive_event_authority";
const PERF_AUTHORITY_KEY = "history_archive_perf_authority";
const PUBLIC_FILTERS = { preset: "all", now: "2026-10-04T13:00:00.000Z", calendarZone: "utc" };
const PROTECTED_TABLES = Object.freeze([
  "source_files",
  "history_replaced_facts",
  "perf_sample_sources",
  "perf_rollout_threads",
  "perf_codex_projections",
  "workbuddy_generation_durations",
  "workbuddy_generation_duration_observations",
  "perf_request_timing_meta",
  "perf_request_timing_evidence",
  "perf_request_timing_threads",
  "perf_request_timing_dirty_threads",
]);

function rows(database, table, orderBy = "rowid") {
  return database
    .prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`)
    .all()
    .map((row) => ({ ...row }));
}

function snapshot(store) {
  const tables = [
    "events",
    "perf_samples",
    ...PROTECTED_TABLES,
    "archive_segments",
    "store_meta",
    "usage_rollup_format",
    "usage_rollup_days",
    "usage_rollup_daily",
    "usage_rollup_sessions",
    "usage_rollup_dirty_days",
  ];
  return {
    tables: Object.fromEntries(tables.map((table) => [table, rows(store.database, table)])),
    storeRevision: store.storeRevision,
    derivedRevision: store.derivedRevision,
    lastCommitReason: store.lastCommitReason,
  };
}

function protectedFacts(store) {
  return Object.fromEntries(PROTECTED_TABLES.map((table) => [table, rows(store.database, table)]));
}

function publicEvidence(summary, report) {
  const perf = structuredClone(summary.perf);
  perf.indexedAt = null;
  if (perf.meta) perf.meta.indexedAt = null;
  return {
    events: report.events,
    totals: summary.totals,
    costEstimate: summary.costEstimate,
    perf,
  };
}

test("ZCode perf moves with its archive event commit, rolls back, and replays", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const homeDir = fixture.serverOptions.homeDir;
  const archivedOptions = {
    ...fixture.serverOptions,
    databaseFile: path.join(homeDir, "archive-commit-perf-archived.sqlite"),
  };
  const oracleOptions = {
    ...fixture.serverOptions,
    databaseFile: path.join(homeDir, "archive-commit-perf-oracle.sqlite"),
    importStoreFile: path.join(homeDir, "archive-commit-perf-oracle-imports.json"),
  };
  const candidateFile = path.join(homeDir, "archive-commit-perf-candidate.sqlite");
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
    const plan = await prepareHistoryArchiveCommit(archived.database, candidateFile);
    const coldPerf = rows(
      archived.database,
      `perf_samples WHERE ts_ms >= ${coldStartMs} AND ts_ms < ${HOT_START_MS}`,
      "sample_key",
    );
    assert.ok(coldPerf.length > 0, "fixture must contain cold perf samples");
    assert.deepEqual(
      [...new Set(coldPerf.map((sample) => sample.source_kind))],
      ["zcode"],
      "the fixture must contain only ZCode perf samples",
    );
    assert.deepEqual(
      [...new Set(coldPerf.map((sample) => sample.method_version))],
      [HISTORICAL_METHOD_VERSION],
      "the fixture must retain its historical native-token method",
    );
    assert.deepEqual(
      plan.perfDeletion.sampleKeys,
      coldPerf.map((sample) => String(sample.sample_key)),
      "the plan must name the exact cold perf rows",
    );
    assert.equal(plan.perfDeletion.sourceKind, "zcode");
    assert.equal(plan.perfDeletion.methodVersion, HISTORICAL_METHOD_VERSION);
    assert.equal((await verifyHistoryArchiveCandidate(candidateFile)).ok, true);

    const hotPerfBefore = rows(
      archived.database,
      `perf_samples WHERE ts_ms >= ${HOT_START_MS} OR ts_ms IS NULL`,
      "sample_key",
    );
    const protectedBefore = protectedFacts(archived);
    const failedState = snapshot(archived);
    archived.database.exec(`
      CREATE TRIGGER fail_archive_perf_delete
      BEFORE DELETE ON perf_samples
      WHEN OLD.ts_ms >= ${coldStartMs} AND OLD.ts_ms < ${HOT_START_MS}
      BEGIN
        SELECT RAISE(ABORT, 'named archive perf failure');
      END;
    `);
    try {
      await assert.rejects(archived.commitHistoryArchiveEvents(plan), /named archive perf failure/);
    } finally {
      archived.database.exec("DROP TRIGGER fail_archive_perf_delete");
    }
    assert.deepEqual(snapshot(archived), failedState, "the named perf deletion failure must roll back every write");

    const oracleReport = await oracle.publishedHistoryUsageReport();
    const oracleSummary = await oracle.summarizeHistory(PUBLIC_FILTERS);
    const expected = publicEvidence(oracleSummary, oracleReport);

    const committed = await archived.commitHistoryArchiveEvents(plan);
    assert.equal(committed.inserted, true);
    assert.equal(committed.replay, false);
    assert.ok(committed.deletedEventCount > 0);
    assert.equal(committed.deletedPerfSampleCount, plan.perfDeletion.sampleKeys.length);
    assert.equal(
      archived.database
        .prepare("SELECT COUNT(*) AS count FROM perf_samples WHERE ts_ms >= ? AND ts_ms < ?")
        .get(coldStartMs, HOT_START_MS).count,
      0,
      "the sealed range must contain no hot perf rows after commit",
    );
    assert.deepEqual(
      rows(archived.database, `perf_samples WHERE ts_ms >= ${HOT_START_MS} OR ts_ms IS NULL`, "sample_key"),
      hotPerfBefore,
      "hot and unplaced perf rows must remain in the live carrier",
    );
    assert.deepEqual(
      protectedFacts(archived),
      protectedBefore,
      "source identities and dependency tables must stay hot",
    );
    assert.deepEqual(
      JSON.parse(
        archived.database.prepare("SELECT value FROM store_meta WHERE key = ?").get(EVENT_AUTHORITY_KEY).value,
      ),
      { formatVersion: 1, segmentIds: [committed.segmentId] },
    );
    assert.deepEqual(
      JSON.parse(archived.database.prepare("SELECT value FROM store_meta WHERE key = ?").get(PERF_AUTHORITY_KEY).value),
      {
        formatVersion: 1,
        segments: [
          {
            segmentId: committed.segmentId,
            databaseSha256: committed.segmentId,
            sourceKinds: ["zcode"],
            methodVersions: [HISTORICAL_METHOD_VERSION],
          },
        ],
      },
    );

    const archivedReport = await archived.publishedHistoryUsageReport();
    const archivedSummary = await archived.summarizeHistory(PUBLIC_FILTERS);
    assert.deepEqual(
      publicEvidence(archivedSummary, archivedReport),
      expected,
      "the committed cold perf carrier must match the unarchived oracle",
    );

    const afterCommit = snapshot(archived);
    const replay = await archived.commitHistoryArchiveEvents(plan);
    assert.equal(replay.inserted, false);
    assert.equal(replay.replay, true);
    assert.equal(replay.deletedEventCount, 0);
    assert.equal(replay.deletedPerfSampleCount, 0);
    assert.deepEqual(snapshot(archived), afterCommit, "replay must not change rows, authorities, or revisions");
  } finally {
    archived.close();
    oracle.close();
    fixture.close();
  }
});
