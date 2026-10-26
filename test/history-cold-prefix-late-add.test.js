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
      payload: { id: "cold-prefix-late-add-session", source: "cli", cwd: codexHome },
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

test("a late cold event append produces one revision delta without copying the original event", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-cold-prefix-late-add-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-cold-prefix-late-add.jsonl");
  const candidateFile = path.join(root, "cold-prefix.sqlite");
  const firstTimestamp = "2026-07-12T02:00:00.000Z";
  const addedTimestamp = "2026-07-12T02:00:30.000Z";
  const hotTimestamp = "2026-07-12T02:01:00.000Z";
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

    writeFileSync(usageFile, `${prefix100}\n${codexTokenLine(hotTimestamp, 130, 30)}\n`);
    invalidateSource(archived, usageFile);
    await archived.sync({ options });
    assert.deepEqual(
      (await archived.publishedHistoryUsageEvents()).map((event) => event.total.total),
      [100, 30],
    );

    writeFileSync(
      usageFile,
      [prefix100, codexTokenLine(addedTimestamp, 120, 20), codexTokenLine(hotTimestamp, 150, 30), ""].join("\n"),
    );
    invalidateSource(archived, usageFile);
    await archived.sync({ options });

    const revisionMeta = JSON.parse(archived.readMetaRaw("history_archive_event_revisions"));
    assert.equal(revisionMeta.revisions.length, 1);
    assert.deepEqual(revisionMeta.revisions[0].removed, []);
    assert.deepEqual(
      revisionMeta.revisions[0].added.map((delta) => [delta.payload.total, delta.count]),
      [[20, 1]],
    );

    await oracle.sync({ options });
    const actualEvents = await archived.publishedHistoryUsageEvents();
    const oracleEvents = oracle.publishedUsageEvents();
    assert.deepEqual(
      actualEvents.map((event) => event.total.total),
      [100, 20, 30],
    );
    assert.deepEqual(actualEvents, oracleEvents);
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
    assert.equal(fileDigest(candidateFile), coldDigest);
    assert.equal(
      Number(
        archived.database
          .prepare("SELECT COUNT(*) AS count FROM history_replaced_facts WHERE source_path = ?")
          .get(usageFile).count,
      ),
      0,
    );
    assert.deepEqual(archived.warnings, []);

    const summaryOptions = {
      preset: "all",
      now: "2026-07-15T12:00:00.000Z",
      calendarZone: "utc",
    };
    const summary = await archived.summarizeHistory(summaryOptions);
    assert.equal(summary.totals.total, 150);
    assert.equal(summary.totals.total, oracle.summarize(summaryOptions).totals.total);
    for (const zone of ["utc", "local"]) {
      const rollup = archived.database
        .prepare(
          `SELECT SUM(event_count) AS event_count, SUM(total) AS total
           FROM usage_rollup_daily WHERE calendar_zone = ?`,
        )
        .get(zone);
      assert.deepEqual(
        { event_count: Number(rollup.event_count), total: Number(rollup.total) },
        { event_count: 3, total: 150 },
      );
    }
  } finally {
    archived.close();
    oracle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
