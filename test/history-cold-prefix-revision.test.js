import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";

const ARCHIVE_AUTHORITY_META = "history_archive_event_authority";
const ROLLUP_TABLES = [
  ["usage_rollup_daily", "calendar_zone, day_key, home_id"],
  ["usage_rollup_models", "calendar_zone, day_key, home_id, model"],
  ["usage_rollup_sessions", "calendar_zone, day_key, home_id, session_id"],
];

function codexTokenLine(timestamp, total, lastTotal) {
  return JSON.stringify({
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
  });
}

function codexCumulativePrefix(codexHome, timestamp, total) {
  return [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "cold-prefix-revision-session", source: "cli", cwd: codexHome },
    }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-luna" } }),
    codexTokenLine(timestamp, total, total),
  ].join("\n");
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

function historySummaryEvidence(summary) {
  const evidence = structuredClone(summary);
  delete evidence.generatedAt;
  delete evidence.perf;
  return evidence;
}

async function coldRevisionEvidence(store, usageFile, candidateFile, summaryOptions) {
  return {
    candidateDigest: fileDigest(candidateFile),
    revisionMeta: store.readMetaRaw("history_archive_event_revisions"),
    hotEvents: tableRows(store.database, "events", "timestamp_ms"),
    replacedFacts: store.database
      .prepare("SELECT * FROM history_replaced_facts WHERE source_path = ? ORDER BY rowid")
      .all(usageFile)
      .map((row) => ({ ...row })),
    dirtyDays: store.database
      .prepare("SELECT day_key FROM usage_rollup_dirty_days ORDER BY day_key")
      .all()
      .map((row) => String(row.day_key)),
    rollups: Object.fromEntries(
      ROLLUP_TABLES.map(([table, orderBy]) => [table, tableRows(store.database, table, orderBy)]),
    ),
    publicEvents: await store.publishedHistoryUsageEvents(),
    summary: historySummaryEvidence(await store.summarizeHistory(summaryOptions)),
  };
}

function sourceFingerprint(store, sourcePath) {
  return { ...store.database.prepare("SELECT size, mtime_ms FROM source_files WHERE path = ?").get(sourcePath) };
}

test("revising a source cold prefix supersedes the archive without double counting", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-cold-prefix-revision-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-cold-prefix-revision.jsonl");
  const candidateFile = path.join(root, "cold-prefix.sqlite");
  const firstTimestamp = "2026-07-12T02:00:00.000Z";
  const secondTimestamp = "2026-07-12T02:01:00.000Z";
  const options = { homeDir: root, env: {}, extraHomes: codexHome, importDirs: [] };
  const archived = new UsageStore({ ...options, databaseFile: path.join(root, "archived.sqlite") });
  const oracle = new UsageStore({ ...options, databaseFile: path.join(root, "oracle.sqlite") });
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    const prefix100 = codexCumulativePrefix(codexHome, firstTimestamp, 100);
    writeFileSync(usageFile, `${prefix100}\n`);
    await archived.sync({ options });

    await createHistoryArchiveCandidate(archived.database, candidateFile, {
      startMs: Date.parse(firstTimestamp),
      endMs: Date.parse(secondTimestamp),
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

    writeFileSync(usageFile, `${prefix100}\n${codexTokenLine(secondTimestamp, 130, 30)}\n`);
    invalidateSource(archived, usageFile);
    await archived.sync({ options });
    assert.deepEqual(
      archived.database
        .prepare("SELECT total FROM events ORDER BY timestamp_ms")
        .all()
        .map((row) => Number(row.total)),
      [30],
    );

    const prefix90 = codexCumulativePrefix(codexHome, firstTimestamp, 90);
    writeFileSync(usageFile, `${prefix90}\n${codexTokenLine(secondTimestamp, 120, 30)}\n`);
    invalidateSource(archived, usageFile);

    let syncError;
    try {
      await archived.sync({ options });
    } catch (error) {
      syncError = error;
    }
    const reparseWarnings = archived.warnings.filter((warning) => warning.includes("cold archive segment"));
    if (syncError || reparseWarnings.length > 0) {
      assert.equal(reparseWarnings.length, syncError ? 0 : 1);
      if (syncError) assert.equal(syncError.code, "HISTORY_ARCHIVE_COLD_REPARSE_CHANGED");
      else assert.match(reparseWarnings[0], /reparsed source no longer matches authorized cold archive segment/);
      assert.equal(fileDigest(candidateFile), coldDigest);
      assert.deepEqual(
        (await archived.publishedHistoryUsageEvents()).map((event) => event.total.total),
        [100, 30],
      );
    }
    assert.equal(fileDigest(candidateFile), coldDigest);
    assert.deepEqual(
      archived.database
        .prepare("SELECT total FROM events ORDER BY timestamp_ms")
        .all()
        .map((row) => Number(row.total)),
      [30],
    );
    assert.deepEqual(
      (await archived.readHistoryArchiveEvents(registered.segmentId)).map((row) => Number(row.total)),
      [100],
    );
    const revisionMeta = JSON.parse(archived.readMetaRaw("history_archive_event_revisions"));
    assert.equal(revisionMeta.revisions.length, 1);
    assert.deepEqual(
      revisionMeta.revisions[0].removed.map((delta) => [delta.payload.total, delta.count]),
      [[100, 1]],
    );
    assert.deepEqual(
      revisionMeta.revisions[0].added.map((delta) => [delta.payload.total, delta.count]),
      [[90, 1]],
    );
    invalidateSource(archived, usageFile);
    await archived.sync({ options });
    assert.equal(archived.readMetaRaw("history_archive_event_revisions"), JSON.stringify(revisionMeta));

    await oracle.sync({ options });
    const actualEvents = await archived.publishedHistoryUsageEvents();
    const oracleEvents = oracle.publishedUsageEvents();
    assert.deepEqual(
      oracleEvents.map((event) => event.total.total),
      [90, 30],
    );
    assert.deepEqual(actualEvents, oracleEvents, syncError?.message || reparseWarnings.join("\n"));
    assert.equal(syncError, undefined);
    assert.deepEqual(archived.warnings, []);

    const summaryOptions = {
      preset: "all",
      now: "2026-07-15T12:00:00.000Z",
      calendarZone: "utc",
    };
    const actualSummary = await archived.summarizeHistory(summaryOptions);
    assert.equal(actualSummary.totals.total, 120);
    assert.equal(actualSummary.totals.total, oracle.summarize(summaryOptions).totals.total);
    const rollup = archived.database
      .prepare(
        `SELECT event_count, total FROM usage_rollup_daily
         WHERE calendar_zone = 'utc' AND day_key = '2026-07-12'`,
      )
      .get();
    assert.deepEqual(
      { event_count: Number(rollup.event_count), total: Number(rollup.total) },
      { event_count: 2, total: 120 },
    );

    const rollbackBaseline = await coldRevisionEvidence(archived, usageFile, candidateFile, summaryOptions);
    archived.database.exec(`
      CREATE TRIGGER fail_cold_revision_meta
      BEFORE UPDATE OF value ON store_meta
      WHEN OLD.key = 'history_archive_event_revisions'
      BEGIN
        SELECT RAISE(ABORT, 'INJECTED_COLD_REVISION_META_FAILURE');
      END
    `);
    const prefix80 = codexCumulativePrefix(codexHome, firstTimestamp, 80);
    writeFileSync(usageFile, `${prefix80}\n${codexTokenLine(secondTimestamp, 130, 50)}\n`);
    invalidateSource(archived, usageFile);
    const invalidatedFingerprint = sourceFingerprint(archived, usageFile);

    let syncFailure;
    try {
      await archived.sync({ options });
    } catch (error) {
      syncFailure = error;
    } finally {
      archived.database.exec("DROP TRIGGER IF EXISTS fail_cold_revision_meta");
    }
    const injectedMessages = [syncFailure?.message, ...archived.warnings].filter((message) =>
      message?.includes("INJECTED_COLD_REVISION_META_FAILURE"),
    );
    assert.equal(injectedMessages.length, 1);
    if (syncFailure) {
      assert.equal(syncFailure.message, "INJECTED_COLD_REVISION_META_FAILURE");
    } else {
      assert.deepEqual(archived.warnings, [`无法索引 ${usageFile}: INJECTED_COLD_REVISION_META_FAILURE`]);
    }

    assert.deepEqual(await coldRevisionEvidence(archived, usageFile, candidateFile, summaryOptions), rollbackBaseline);
    assert.deepEqual(sourceFingerprint(archived, usageFile), invalidatedFingerprint);

    // The failed transaction restored the invalidated fingerprint, so the new source is retried.
    await archived.sync({ options });

    const secondRevisionMeta = JSON.parse(archived.readMetaRaw("history_archive_event_revisions"));
    assert.equal(secondRevisionMeta.revisions.length, 1);
    assert.deepEqual(
      secondRevisionMeta.revisions[0].removed.map((delta) => [delta.payload.total, delta.count]),
      [[100, 1]],
    );
    assert.deepEqual(
      secondRevisionMeta.revisions[0].added.map((delta) => [delta.payload.total, delta.count]),
      [[80, 1]],
    );
    const replacedCold = archived.database
      .prepare(
        "SELECT occurrence_count, payload, method_version, revision_reason FROM history_replaced_facts WHERE source_path = ?",
      )
      .all(usageFile)
      .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
    assert.deepEqual(
      replacedCold.map((row) => [row.payload.total, Number(row.occurrence_count)]),
      [
        [90, 1],
        [30, 1],
      ],
    );
    for (const row of replacedCold) {
      assert.equal(row.method_version, "events.v1");
      assert.equal(row.revision_reason, "reparse_replaced");
    }

    await oracle.sync({ options });
    assert.deepEqual(
      (await archived.publishedHistoryUsageEvents()).map((event) => event.total.total),
      [80, 50],
    );
    const secondSummary = await archived.summarizeHistory(summaryOptions);
    assert.equal(secondSummary.totals.total, 130);
    assert.equal(secondSummary.totals.total, oracle.summarize(summaryOptions).totals.total);
    const utcRollup = archived.database
      .prepare(
        `SELECT SUM(event_count) AS event_count, SUM(total) AS total FROM usage_rollup_daily
         WHERE calendar_zone = 'utc' AND day_key = '2026-07-12'`,
      )
      .get();
    const localRollup = archived.database
      .prepare(
        `SELECT SUM(event_count) AS event_count, SUM(total) AS total FROM usage_rollup_daily
         WHERE calendar_zone = 'local'`,
      )
      .get();
    for (const zoneRollup of [utcRollup, localRollup]) {
      assert.deepEqual(
        { event_count: Number(zoneRollup.event_count), total: Number(zoneRollup.total) },
        { event_count: 2, total: 130 },
      );
    }
    assert.equal(fileDigest(candidateFile), coldDigest);
    assert.deepEqual(
      archived.database
        .prepare("SELECT total FROM events ORDER BY timestamp_ms")
        .all()
        .map((row) => Number(row.total)),
      [50],
    );
  } finally {
    archived.close();
    oracle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
