import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";

const ARCHIVE_AUTHORITY_META = "history_archive_event_authority";
const REVISION_META = "history_archive_event_revisions";
const ROLLUP_TABLES = [
  ["usage_rollup_daily", "calendar_zone, day_key, home_id"],
  ["usage_rollup_models", "calendar_zone, day_key, home_id, model"],
  ["usage_rollup_sessions", "calendar_zone, day_key, home_id, session_id"],
];

function projectLogLine(timestamp, sessionId, total) {
  return `${JSON.stringify({
    schema_version: "codex-usage.project-log.v1",
    timestamp,
    source: "test",
    channel: "Test",
    request_id: `request-${sessionId}`,
    project_root: "/work/removal",
    cwd: "/work/removal",
    session_id: sessionId,
    model: "gpt-6-sol",
    usage: {
      total,
      input: total - 20,
      cached: 0,
      output: 20,
      reasoning: 0,
    },
  })}\n`;
}

function codexTokenLine(timestamp, total, lastTotal) {
  return `${JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: total,
          input_tokens: total - 20,
          cached_input_tokens: 0,
          output_tokens: 20,
          reasoning_output_tokens: 0,
        },
        last_token_usage: {
          total_tokens: lastTotal,
          input_tokens: lastTotal - 10,
          cached_input_tokens: 0,
          output_tokens: 10,
          reasoning_output_tokens: 0,
        },
      },
    },
  })}\n`;
}

function fileDigest(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function invalidateSource(store, sourcePath) {
  store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?").run(sourcePath);
}

function tableRows(database, table, orderBy) {
  return database
    .prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`)
    .all()
    .map((row) => ({ ...row }));
}

async function removalState(store, usageFile, candidateFile, segmentId, summaryOptions) {
  return {
    revisionMeta: store.readMetaRaw(REVISION_META) ?? null,
    hotEventTotals: store.database
      .prepare("SELECT total FROM events ORDER BY timestamp_ms")
      .all()
      .map((row) => Number(row.total)),
    recoveryFacts: store.database
      .prepare("SELECT payload, occurrence_count FROM history_replaced_facts WHERE source_path = ? ORDER BY rowid")
      .all(usageFile)
      .map((row) => [JSON.parse(row.payload).total, Number(row.occurrence_count)]),
    publishedWarnings: (store.readPublishedFileWarnings()[usageFile] || []).map((warning) => ({
      code: warning.code,
      count: warning.count,
    })),
    dirtyDays: store.database
      .prepare("SELECT day_key FROM usage_rollup_dirty_days ORDER BY day_key")
      .all()
      .map((row) => String(row.day_key)),
    rollups: Object.fromEntries(
      ROLLUP_TABLES.map(([table, orderBy]) => [table, tableRows(store.database, table, orderBy)]),
    ),
    publicEvents: await store.publishedHistoryUsageEvents(),
    summaryTotal: (await store.summarizeHistory(summaryOptions)).totals.total,
    segmentTotals: (await store.readHistoryArchiveEvents(segmentId)).map((row) => Number(row.total)),
    candidateDigest: fileDigest(candidateFile),
  };
}

test("removing one middle cold event matches the unarchived oracle and retains recovery evidence", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-cold-prefix-removal-"));
  const projectRoot = path.join(root, "project");
  const usageFile = path.join(projectRoot, ".codex-usage", "usage.jsonl");
  const candidateFile = path.join(root, "cold-prefix.sqlite");
  const firstTimestamp = "2026-07-12T02:00:00.000Z";
  const secondTimestamp = "2026-07-12T02:00:30.000Z";
  const hotTimestamp = "2026-07-12T02:01:00.000Z";
  const removed = projectLogLine(firstTimestamp, "removed-session", 20);
  const retainedCold = projectLogLine(secondTimestamp, "retained-session", 100);
  const hot = projectLogLine(hotTimestamp, "hot-session", 30);
  const options = { homeDir: root, env: {}, importDirs: [projectRoot] };
  const archived = new UsageStore({ ...options, databaseFile: path.join(root, "archived.sqlite") });
  const oracle = new UsageStore({ ...options, databaseFile: path.join(root, "oracle.sqlite") });
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(usageFile, `${removed}${retainedCold}${hot}`);
    await archived.sync({ options });

    await createHistoryArchiveCandidate(archived.database, candidateFile, {
      startMs: Date.parse(firstTimestamp),
      endMs: Date.parse(hotTimestamp),
    });
    const registered = await archived.registerHistoryArchiveCandidate(candidateFile);
    const coldDigest = fileDigest(candidateFile);

    archived.database.exec("BEGIN IMMEDIATE");
    try {
      archived.database
        .prepare(
          `INSERT INTO store_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(ARCHIVE_AUTHORITY_META, JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }));
      archived.database.prepare("DELETE FROM events WHERE source_path = ?").run(usageFile);
      archived.database.exec("COMMIT");
    } catch (error) {
      archived.database.exec("ROLLBACK");
      throw error;
    }

    invalidateSource(archived, usageFile);
    await archived.sync({ options });
    assert.deepEqual(
      (await archived.publishedHistoryUsageEvents()).map((event) => event.total.total),
      [20, 100, 30],
    );
    assert.deepEqual(
      archived.database
        .prepare("SELECT total FROM events ORDER BY timestamp_ms")
        .all()
        .map((row) => Number(row.total)),
      [30],
    );

    // Keep the later cold 100 and hot 30: this is a valid middle removal, not a shortened tail.
    writeFileSync(usageFile, `${retainedCold}${hot}`);
    invalidateSource(archived, usageFile);
    let syncError;
    let syncResult;
    try {
      syncResult = await archived.sync({ options });
    } catch (error) {
      syncError = error;
    }

    await oracle.sync({ options });
    const actualEvents = await archived.publishedHistoryUsageEvents();
    const oracleEvents = oracle.publishedUsageEvents();
    const summaryOptions = {
      preset: "all",
      now: "2026-07-15T12:00:00.000Z",
      calendarZone: "utc",
    };
    const actualSummary = await archived.summarizeHistory(summaryOptions);
    const oracleSummary = oracle.summarize(summaryOptions);
    const revisionRaw = archived.readMetaRaw(REVISION_META);
    const revision = revisionRaw ? JSON.parse(revisionRaw) : null;
    const publishedWarnings = (archived.readPublishedFileWarnings()[usageFile] || []).map((warning) => ({
      code: warning.code,
      count: warning.count,
    }));
    const evidence = {
      syncError: syncError ? { code: syncError.code, message: syncError.message } : null,
      warnings: [...archived.warnings],
      perfState: syncResult?.perfState,
      publishedWarnings,
      actualEventTotals: actualEvents.map((event) => event.total.total),
      oracleEventTotals: oracleEvents.map((event) => event.total.total),
      eventsMatch: isDeepStrictEqual(actualEvents, oracleEvents),
      actualSummaryTotal: actualSummary.totals.total,
      oracleSummaryTotal: oracleSummary.totals.total,
      summaryTotalsMatch: isDeepStrictEqual(actualSummary.totals, oracleSummary.totals),
      hotEventTotals: archived.database
        .prepare("SELECT total FROM events ORDER BY timestamp_ms")
        .all()
        .map((row) => Number(row.total)),
      candidateDigestUnchanged: fileDigest(candidateFile) === coldDigest,
      segmentTotals: (await archived.readHistoryArchiveEvents(registered.segmentId)).map((row) => Number(row.total)),
      revisionRemoved:
        revision?.revisions.flatMap((entry) => entry.removed.map((delta) => [delta.payload.total, delta.count])) ?? [],
      recoveryFacts: archived.database
        .prepare("SELECT payload, occurrence_count FROM history_replaced_facts WHERE source_path = ? ORDER BY rowid")
        .all(usageFile)
        .map((row) => [JSON.parse(row.payload).total, Number(row.occurrence_count)]),
    };

    assert.deepEqual(evidence, {
      syncError: null,
      warnings: [`project-log 来源文件缩短（截断）：${usageFile}（丢失 1 条事件）`],
      perfState: "ready",
      publishedWarnings: [{ code: "PROJECT_LOG_TRUNCATED", count: 1 }],
      actualEventTotals: [100, 30],
      oracleEventTotals: [100, 30],
      eventsMatch: true,
      actualSummaryTotal: 130,
      oracleSummaryTotal: 130,
      summaryTotalsMatch: true,
      hotEventTotals: [30],
      candidateDigestUnchanged: true,
      segmentTotals: [20, 100],
      revisionRemoved: [[20, 1]],
      recoveryFacts: [],
    });

    const revisionBeforeForcedReparse = archived.readMetaRaw(REVISION_META);
    invalidateSource(archived, usageFile);
    const forcedReparse = await archived.sync({ options });
    const forcedReparseWarnings = (archived.readPublishedFileWarnings()[usageFile] || []).map((warning) => ({
      code: warning.code,
      count: warning.count,
    }));
    assert.deepEqual(
      {
        updatedFileCount: forcedReparse.updatedFileCount,
        perfState: forcedReparse.perfState,
        eventTotals: (await archived.publishedHistoryUsageEvents()).map((event) => event.total.total),
        summaryTotal: (await archived.summarizeHistory(summaryOptions)).totals.total,
        revisionStable: archived.readMetaRaw(REVISION_META) === revisionBeforeForcedReparse,
        warnings: [...archived.warnings],
        publishedWarnings: forcedReparseWarnings,
      },
      {
        updatedFileCount: 1,
        perfState: "ready",
        eventTotals: [100, 30],
        summaryTotal: 130,
        revisionStable: true,
        warnings: evidence.warnings,
        publishedWarnings: [{ code: "PROJECT_LOG_TRUNCATED", count: 1 }],
      },
    );

    const noop = await archived.sync({ options });
    assert.equal(noop.updatedFileCount, 0);
    assert.equal(noop.perfState, "ready");
    assert.deepEqual(archived.warnings, evidence.warnings);
    assert.deepEqual(
      (archived.readPublishedFileWarnings()[usageFile] || []).map((warning) => warning.code),
      ["PROJECT_LOG_TRUNCATED"],
    );
  } finally {
    archived.close();
    oracle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("non-project-log cold removal remains rejected without a project-log warning", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-cold-prefix-removal-codex-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-cold-prefix-removal.jsonl");
  const candidateFile = path.join(root, "cold-prefix.sqlite");
  const firstTimestamp = "2026-07-12T02:00:00.000Z";
  const secondTimestamp = "2026-07-12T02:00:30.000Z";
  const hotTimestamp = "2026-07-12T02:01:00.000Z";
  const context = [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "cold-prefix-removal-codex", source: "cli", cwd: codexHome },
    }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-luna" } }),
    "",
  ].join("\n");
  const removed = codexTokenLine(firstTimestamp, 20, 20);
  const retainedCold = codexTokenLine(secondTimestamp, 120, 100);
  const hot = codexTokenLine(hotTimestamp, 150, 30);
  const options = { homeDir: root, env: {}, extraHomes: codexHome, importDirs: [] };
  const store = new UsageStore({ ...options, databaseFile: path.join(root, "archived.sqlite") });
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(usageFile, `${context}${removed}${retainedCold}${hot}`);
    await store.sync({ options });

    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: Date.parse(firstTimestamp),
      endMs: Date.parse(hotTimestamp),
    });
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);

    store.database.exec("BEGIN IMMEDIATE");
    try {
      store.database
        .prepare(
          `INSERT INTO store_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(ARCHIVE_AUTHORITY_META, JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }));
      store.database.prepare("DELETE FROM events WHERE source_path = ?").run(usageFile);
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }

    invalidateSource(store, usageFile);
    await store.sync({ options });
    writeFileSync(usageFile, `${context}${retainedCold}${hot}`);
    invalidateSource(store, usageFile);
    const rejected = await store.sync({ options });

    assert.deepEqual(
      {
        updatedFileCount: rejected.updatedFileCount,
        eventTotals: (await store.publishedHistoryUsageEvents()).map((event) => event.total.total),
        hotEventTotals: store.database
          .prepare("SELECT total FROM events ORDER BY timestamp_ms")
          .all()
          .map((row) => Number(row.total)),
        revisionMeta: store.readMetaRaw(REVISION_META) ?? null,
        publishedWarnings: store.readPublishedFileWarnings()[usageFile] || [],
        rejection: store.warnings.filter((warning) => warning.includes("reparsed source removes or migrates")),
        truncation: store.warnings.filter((warning) => warning.includes("来源文件缩短（截断）")),
      },
      {
        updatedFileCount: 0,
        eventTotals: [20, 100, 30],
        hotEventTotals: [30],
        revisionMeta: null,
        publishedWarnings: [],
        rejection: [
          `无法索引 ${usageFile}: reparsed source removes or migrates cold events in authorized segment ${registered.segmentId}`,
        ],
        truncation: [],
      },
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("failed cold removal marker commit rolls back the whole replacement and retries cleanly", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-cold-prefix-removal-rollback-"));
  const projectRoot = path.join(root, "project");
  const usageFile = path.join(projectRoot, ".codex-usage", "usage.jsonl");
  const candidateFile = path.join(root, "cold-prefix.sqlite");
  const firstTimestamp = "2026-07-12T02:00:00.000Z";
  const secondTimestamp = "2026-07-12T02:00:30.000Z";
  const hotTimestamp = "2026-07-12T02:01:00.000Z";
  const removed = projectLogLine(firstTimestamp, "removed-session", 20);
  const retainedCold = projectLogLine(secondTimestamp, "retained-session", 100);
  const hot30 = projectLogLine(hotTimestamp, "hot-session", 30);
  const hot40 = projectLogLine(hotTimestamp, "hot-session", 40);
  const options = { homeDir: root, env: {}, importDirs: [projectRoot] };
  const store = new UsageStore({ ...options, databaseFile: path.join(root, "archived.sqlite") });
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(usageFile, `${removed}${retainedCold}${hot30}`);
    await store.sync({ options });

    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: Date.parse(firstTimestamp),
      endMs: Date.parse(hotTimestamp),
    });
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);

    store.database.exec("BEGIN IMMEDIATE");
    try {
      store.database
        .prepare(
          `INSERT INTO store_meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(ARCHIVE_AUTHORITY_META, JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }));
      store.database.prepare("DELETE FROM events WHERE source_path = ?").run(usageFile);
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }

    invalidateSource(store, usageFile);
    await store.sync({ options });
    const summaryOptions = {
      preset: "all",
      now: "2026-07-15T12:00:00.000Z",
      calendarZone: "utc",
    };
    const baseline = await removalState(store, usageFile, candidateFile, registered.segmentId, summaryOptions);

    store.database.exec(`
      CREATE TRIGGER fail_cold_removal_marker
      BEFORE UPDATE OF value ON store_meta
      WHEN OLD.key = 'perf_file_warnings'
        AND EXISTS (SELECT 1 FROM store_meta WHERE key = 'history_archive_event_revisions')
      BEGIN
        SELECT RAISE(ABORT, 'INJECTED_COLD_REMOVAL_MARKER_FAILURE');
      END
    `);
    writeFileSync(usageFile, `${retainedCold}${hot40}`);
    invalidateSource(store, usageFile);
    let syncFailure;
    try {
      await store.sync({ options });
    } catch (error) {
      syncFailure = error;
    } finally {
      store.database.exec("DROP TRIGGER IF EXISTS fail_cold_removal_marker");
    }

    const injectedMessages = [syncFailure?.message, ...store.warnings].filter((message) =>
      message?.includes("INJECTED_COLD_REMOVAL_MARKER_FAILURE"),
    );
    assert.equal(injectedMessages.length, 1);
    if (syncFailure) {
      assert.equal(syncFailure.message, "INJECTED_COLD_REMOVAL_MARKER_FAILURE");
    } else {
      assert.deepEqual(store.warnings, [`无法索引 ${usageFile}: INJECTED_COLD_REMOVAL_MARKER_FAILURE`]);
    }
    assert.deepEqual(
      await removalState(store, usageFile, candidateFile, registered.segmentId, summaryOptions),
      baseline,
    );

    // The failed transaction restored the stale source fingerprint, so retry needs no manual invalidation.
    const retried = await store.sync({ options });
    const finalState = await removalState(store, usageFile, candidateFile, registered.segmentId, summaryOptions);
    const revision = JSON.parse(finalState.revisionMeta);
    const utcRollup = store.database
      .prepare(
        `SELECT SUM(event_count) AS event_count, SUM(total) AS total
         FROM usage_rollup_daily WHERE calendar_zone = 'utc'`,
      )
      .get();
    assert.deepEqual(
      {
        updatedFileCount: retried.updatedFileCount,
        publicTotals: finalState.publicEvents.map((event) => event.total.total),
        summaryTotal: finalState.summaryTotal,
        hotEventTotals: finalState.hotEventTotals,
        recoveryFacts: finalState.recoveryFacts,
        publishedWarnings: finalState.publishedWarnings,
        revisionRemoved: revision.revisions.flatMap((entry) =>
          entry.removed.map((delta) => [delta.payload.total, delta.count]),
        ),
        segmentTotals: finalState.segmentTotals,
        candidateDigestUnchanged: finalState.candidateDigest === baseline.candidateDigest,
        utcRollup: { event_count: Number(utcRollup.event_count), total: Number(utcRollup.total) },
      },
      {
        updatedFileCount: 1,
        publicTotals: [100, 40],
        summaryTotal: 140,
        hotEventTotals: [40],
        recoveryFacts: [[30, 1]],
        publishedWarnings: [{ code: "PROJECT_LOG_TRUNCATED", count: 1 }],
        revisionRemoved: [[20, 1]],
        segmentTotals: [20, 100],
        candidateDigestUnchanged: true,
        utcRollup: { event_count: 2, total: 140 },
      },
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
