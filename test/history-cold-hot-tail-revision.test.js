import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";

const ARCHIVE_AUTHORITY_META = "history_archive_event_authority";

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
      payload: { id: "cold-hot-tail-session", source: "cli", cwd: codexHome },
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

function normalizeSummaryTimestamps(summary) {
  const normalized = structuredClone(summary);
  normalized.generatedAt = "";
  normalized.perf.indexedAt = "";
  normalized.perf.meta.indexedAt = "";
  return normalized;
}

test("unchanged authorized cold prefix allows a lower cumulative hot-tail revision", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-cold-hot-tail-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-cold-hot-tail.jsonl");
  const candidateFile = path.join(root, "cold-prefix.sqlite");
  const firstTimestamp = "2026-07-12T02:00:00.000Z";
  const secondTimestamp = "2026-07-12T02:01:00.000Z";
  const firstTimestampMs = Date.parse(firstTimestamp);
  const options = { homeDir: root, env: {}, extraHomes: codexHome, importDirs: [] };
  const archived = new UsageStore({ ...options, databaseFile: path.join(root, "archived.sqlite") });
  const oracle = new UsageStore({ ...options, databaseFile: path.join(root, "oracle.sqlite") });
  try {
    mkdirSync(path.dirname(usageFile), { recursive: true });
    const prefix = codexCumulativePrefix(codexHome, firstTimestamp, 100);
    const prefixBytes = Buffer.from(`${prefix}\n`);
    writeFileSync(usageFile, prefixBytes);
    await archived.sync({ options });

    await createHistoryArchiveCandidate(archived.database, candidateFile, {
      startMs: firstTimestampMs,
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

    const withHotThirty = `${prefix}\n${codexTokenLine(secondTimestamp, 130, 30)}\n`;
    writeFileSync(usageFile, withHotThirty);
    invalidateSource(archived, usageFile);
    await archived.sync({ options });
    assert.deepEqual(
      archived.database
        .prepare("SELECT total FROM events ORDER BY timestamp_ms")
        .all()
        .map((row) => Number(row.total)),
      [30],
    );

    const revised = `${prefix}\n${codexTokenLine(secondTimestamp, 120, 20)}\n`;
    writeFileSync(usageFile, revised);
    assert.deepEqual(readFileSync(usageFile).subarray(0, prefixBytes.length), prefixBytes);
    invalidateSource(archived, usageFile);
    await archived.sync({ options });
    await oracle.sync({ options });

    assert.equal(fileDigest(candidateFile), coldDigest);
    assert.equal(
      archived.warnings.some((warning) => warning.includes("no longer matches authorized cold archive segment")),
      false,
    );

    const actualEvents = await archived.publishedHistoryUsageEvents();
    const oracleEvents = oracle.publishedUsageEvents();
    assert.deepEqual(actualEvents, oracleEvents);
    assert.deepEqual(
      actualEvents.map((event) => event.total.total),
      [100, 20],
    );

    const periodOptions = { now: "2026-07-15T12:00:00.000Z", calendarZone: "utc" };
    const actualPeriod = await archived.periodComparisonHistory(periodOptions);
    const oraclePeriod = oracle.periodComparison(periodOptions);
    assert.deepEqual(actualPeriod, oraclePeriod);
    assert.equal(actualPeriod.totals.month.total, 120);
    assert.equal(actualPeriod.totals.all.total, 120);

    const summaryOptions = { preset: "all", ...periodOptions };
    const actualSummary = await archived.summarizeHistory(summaryOptions);
    const oracleSummary = oracle.summarize(summaryOptions);
    assert.deepEqual(normalizeSummaryTimestamps(actualSummary), normalizeSummaryTimestamps(oracleSummary));
    assert.equal(actualSummary.totals.total, 120);

    const replacedFacts = () =>
      archived.database
        .prepare(
          `SELECT fact_table, source_path, occurrence_count, payload
           FROM history_replaced_facts
           ORDER BY fact_table, source_path, payload_digest`,
        )
        .all()
        .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
    const firstReplacedFacts = replacedFacts();
    const removedHotThirty = firstReplacedFacts.filter(
      (row) => row.fact_table === "events" && row.source_path === usageFile && row.payload.total === 30,
    );
    assert.equal(removedHotThirty.length, 1);
    assert.equal(removedHotThirty[0].occurrence_count, 1);

    writeFileSync(usageFile, revised);
    invalidateSource(archived, usageFile);
    const repeated = await archived.sync({ options });
    assert.equal(repeated.updatedFileCount, 1);
    assert.deepEqual(replacedFacts(), firstReplacedFacts);
    assert.equal(
      (await archived.publishedHistoryUsageEvents()).reduce((sum, event) => sum + event.total.total, 0),
      120,
    );
  } finally {
    archived.close();
    oracle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
