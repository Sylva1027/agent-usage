import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";
import { createUsageRollups } from "../src/usage-rollups.js";

const START_MS = Date.parse("2026-01-02T03:04:05.000Z");
const END_MS = START_MS + 60_000;
const AUTHORITY_META = "history_archive_event_authority";
const PROTECTED_FACT_TABLES = Object.freeze([
  "source_files",
  "history_replaced_facts",
  "perf_samples",
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
    "source_files",
    "history_replaced_facts",
    "perf_samples",
    "perf_sample_sources",
    "perf_rollout_threads",
    "perf_request_timing_threads",
    "perf_request_timing_evidence",
    "perf_request_timing_dirty_threads",
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

function nonEmptyProtectedFacts(store) {
  return Object.fromEntries(
    PROTECTED_FACT_TABLES.map((table) => [table, rows(store.database, table)]).filter(
      ([, tableRows]) => tableRows.length > 0,
    ),
  );
}

function assertProtectedFactsUnchanged(store, expected, message) {
  for (const [table, tableRows] of Object.entries(expected)) {
    assert.deepEqual(rows(store.database, table), tableRows, `${message}: ${table}`);
  }
}

async function fixture(root) {
  const databaseFile = path.join(root, "source.sqlite");
  const candidateFile = path.join(root, "candidate.sqlite");
  const sourcePath = path.join(root, "source.jsonl");
  const outsidePath = path.join(root, "outside.jsonl");
  const store = new UsageStore({ homeDir: root, env: {}, importDirs: [], databaseFile });
  try {
    await store.open();
    await store.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    const insertSource = store.database.prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    insertSource.run(sourcePath, "codex", "home", "Home", root, 1, 1, "2026-01-02T03:05:00.000Z");
    insertSource.run(outsidePath, "codex", "outside", "Outside", root, 1, 1, "2026-01-02T03:06:00.000Z");
    const insertEvent = store.database.prepare(`
    INSERT INTO events (
      source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
      hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    for (const [offset, sessionId, total] of [
      [0, "in-range-a", 20],
      [1, "in-range-b", 10],
    ]) {
      insertEvent.run(
        sourcePath,
        START_MS + offset,
        sessionId,
        "home",
        "Home",
        "main",
        "project",
        "gpt-6-luna",
        "hour",
        "day",
        "week",
        "month",
        total,
        total,
        0,
        0,
        0,
      );
    }
    insertEvent.run(
      outsidePath,
      END_MS,
      "outside",
      "outside",
      "Outside",
      "main",
      "project",
      "gpt-6-luna",
      "hour",
      "day",
      "week",
      "month",
      5,
      5,
      0,
      0,
      0,
    );
    store.database
      .prepare(
        `INSERT INTO history_replaced_facts (
           fact_table, source_kind, home_id, source_path, payload_digest, occurrence_count, payload,
           source_home_label, source_home_path, method_version, revision_reason, recorded_at
         ) VALUES ('events', 'codex', 'home', ?, 'digest', 1, '{}', 'Home', ?, 'events.v1', 'reparse', 'now')`,
      )
      .run(sourcePath, root);
    store.database
      .prepare(
        `INSERT INTO perf_samples (
           sample_key, source_path, source_kind, home_id, channel, agent_kind, agent, session_id,
           turn_key, model, model_provider, reasoning_effort, model_evidence, window, timing_kind,
           timing_source, token_scope, status, ts_ms, window_start_ms, window_end_ms, duration_ms,
           output_tokens, input_tokens, request_count, item_count, timed_item_count, sample_flags,
           diagnostic_reason, diagnostic_reason_chain, method_version
         ) VALUES (
           '["codex","home","thread","turn"]', ?, 'codex', 'home', 'main', 'main', 'codex', 'in-range-a',
           'turn', 'gpt-6-luna', 'openai', 'high', 'reported', 'request', 'request_e2e', 'timestamp_fallback',
           'reported_output_includes_reasoning', 'completed', ?, ?, ?, 1000, 1, 1, 1, 1, 1, 0, '', '', 'tps-v2'
         )`,
      )
      .run(sourcePath, START_MS, START_MS, END_MS);
    store.database
      .prepare(
        `INSERT INTO perf_sample_sources (sample_key, source_path, role)
         VALUES ('["codex","home","thread","turn"]', ?, 'dependency')`,
      )
      .run(sourcePath);
    store.database
      .prepare("INSERT INTO perf_rollout_threads (source_path, home_id, thread_id) VALUES (?, 'home', 'thread')")
      .run(sourcePath);
    store.database
      .prepare(
        "INSERT INTO perf_request_timing_threads (home_id, response_id, thread_id) VALUES ('home', 'response', 'thread')",
      )
      .run();
    store.database
      .prepare(
        `INSERT INTO perf_request_timing_evidence (
           home_id, evidence_origin, response_id, variant_key, schema_version, requested_model,
           reported_output_tokens, duration_ms, status, completed_at_ms
         ) VALUES ('home', 'native', 'response', 'variant', 1, 'gpt-6-luna', 1, 1000, 'completed', ?)`,
      )
      .run(START_MS + 1000);
    store.database
      .prepare("INSERT INTO perf_request_timing_dirty_threads (home_id, thread_id) VALUES ('home', 'thread')")
      .run();
    createUsageRollups(store.database);

    await createHistoryArchiveCandidate(store.database, candidateFile, { startMs: START_MS, endMs: END_MS });
    const plan = await prepareHistoryArchiveCommit(store.database, candidateFile);
    return { store, candidateFile, plan, sourcePath, outsidePath };
  } catch (error) {
    store.close();
    throw error;
  }
}

test("event commit rejects changed input, accepts restored bytes, and replays exactly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-commit-"));
  let store;
  try {
    const fixtureState = await fixture(root);
    store = fixtureState.store;
    const { plan } = fixtureState;
    const event = store.database.prepare("SELECT * FROM events WHERE timestamp_ms = ?").get(START_MS);
    const before = snapshot(store);
    const publishedBeforeCommit = await store.publishedHistoryUsageEvents();
    const protectedBeforeCommit = nonEmptyProtectedFacts(store);
    assert.deepEqual(Object.keys(protectedBeforeCommit).sort(), [
      "history_replaced_facts",
      "perf_request_timing_dirty_threads",
      "perf_request_timing_evidence",
      "perf_request_timing_meta",
      "perf_request_timing_threads",
      "perf_rollout_threads",
      "perf_sample_sources",
      "perf_samples",
      "source_files",
    ]);

    store.database.prepare("UPDATE events SET total = total + 1 WHERE id = ?").run(event.id);
    const changed = snapshot(store);
    await assert.rejects(
      store.commitHistoryArchiveEvents(plan),
      (error) => error?.code === "HISTORY_ARCHIVE_SOURCE_CHANGED",
    );
    assert.deepEqual(snapshot(store), changed, "changed input must reject without writes");

    const restore = store.database.prepare("UPDATE events SET total = ? WHERE id = ?");
    restore.run(event.total, event.id);
    assert.deepEqual(snapshot(store), before, "restoring the exact payload must restore the source facts");
    const result = await store.commitHistoryArchiveEvents(plan);
    assert.equal(result.inserted, true);
    assert.equal(result.replay, false);
    assert.equal(result.deletedEventCount, 2);
    assert.equal(
      store.database
        .prepare("SELECT COUNT(*) AS count FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ?")
        .get(START_MS, END_MS).count,
      0,
      "the sealed range must contain no hot events after commit",
    );
    assert.deepEqual(
      await store.publishedHistoryUsageEvents(),
      publishedBeforeCommit,
      "the complete published event carrier must be recovered from the committed cold segment",
    );
    assertProtectedFactsUnchanged(
      store,
      protectedBeforeCommit,
      "commit must preserve every non-empty protected fact table",
    );
    const after = snapshot(store);
    assert.equal(after.tables.archive_segments.length, 1);
    assert.deepEqual(JSON.parse(after.tables.store_meta.find((row) => row.key === AUTHORITY_META).value), {
      formatVersion: 1,
      segmentIds: [result.segmentId],
    });

    const replay = await store.commitHistoryArchiveEvents(plan);
    assert.equal(replay.inserted, false);
    assert.equal(replay.replay, true);
    assert.equal(replay.deletedEventCount, 0);
    assert.deepEqual(
      await store.publishedHistoryUsageEvents(),
      publishedBeforeCommit,
      "replay must preserve the complete cold-recovered event carrier",
    );
    assertProtectedFactsUnchanged(
      store,
      protectedBeforeCommit,
      "replay must preserve every non-empty protected fact table",
    );
    assert.deepEqual(snapshot(store), after, "replay must not change committed state or revisions");

    const candidateBytes = readFileSync(fixtureState.candidateFile);
    writeFileSync(fixtureState.candidateFile, Buffer.concat([candidateBytes, Buffer.from([0])]));
    await assert.rejects(
      store.commitHistoryArchiveEvents(plan),
      (error) => error?.code === "HISTORY_BACKUP_SIZE_MISMATCH",
    );
    assert.deepEqual(snapshot(store), after, "candidate damage must reject replay without writes");
    writeFileSync(fixtureState.candidateFile, candidateBytes);
    assert.equal((await store.commitHistoryArchiveEvents(plan)).replay, true);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("a named dirty-mark failure rolls back registration, authority, deletions, and rollups", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-commit-fault-"));
  let store;
  try {
    const fixtureState = await fixture(root);
    store = fixtureState.store;
    const before = snapshot(store);
    store.database.exec(`
      -- BEFORE also fires when INSERT OR IGNORE finds the seeded dirty row.
      CREATE TRIGGER fail_archive_dirty_mark
      BEFORE INSERT ON usage_rollup_dirty_days
      WHEN NEW.day_key = '2026-01-02'
      BEGIN
        SELECT RAISE(ABORT, 'named archive dirty failure');
      END;
    `);
    try {
      await assert.rejects(store.commitHistoryArchiveEvents(fixtureState.plan), /named archive dirty failure/);
    } finally {
      store.database.exec("DROP TRIGGER fail_archive_dirty_mark");
    }
    assert.deepEqual(snapshot(store), before, "failure must roll back every mutation");
    const retried = await store.commitHistoryArchiveEvents(fixtureState.plan);
    assert.equal(retried.inserted, true);
    assert.equal(retried.deletedEventCount, 2);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("plan is bound to the canonical source database", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-archive-commit-bound-"));
  const otherRoot = await mkdtemp(path.join(os.tmpdir(), "history-archive-commit-other-"));
  let store;
  let other;
  try {
    const fixtureState = await fixture(root);
    store = fixtureState.store;
    other = new UsageStore({
      homeDir: otherRoot,
      env: {},
      importDirs: [],
      databaseFile: path.join(otherRoot, "other.sqlite"),
    });
    await other.open();
    createUsageRollups(other.database);
    const before = snapshot(other);
    await assert.rejects(
      other.commitHistoryArchiveEvents(fixtureState.plan),
      (error) => error?.code === "HISTORY_ARCHIVE_COMMIT_SOURCE_MISMATCH",
    );
    assert.deepEqual(snapshot(other), before);
    assert.equal(realpathSync.native(path.resolve(store.databaseFile)), fixtureState.plan.source.databaseFile);
  } finally {
    other?.close();
    store?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await rm(otherRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
