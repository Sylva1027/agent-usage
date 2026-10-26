import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createHistoryArchiveCandidate,
  loadHistoryArchiveImport,
  publishHistoryArchiveBundle,
  publishHistoryArchiveImport,
} from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";

const ARCHIVE_AUTHORITY_META = "history_archive_event_authority";
const REVISION_META = "history_archive_event_revisions";

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
      payload: { id: "cold-revision-bundle-session", source: "cli", cwd: codexHome },
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

function replacedFacts(store, sourcePath) {
  return store.database
    .prepare("SELECT * FROM history_replaced_facts WHERE source_path = ? ORDER BY rowid")
    .all(sourcePath)
    .map((row) => ({ ...row }));
}

test("a revised cold segment survives bundle import without its original source", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-cold-revision-bundle-"));
  const codexHome = path.join(root, "codex-home");
  const usageFile = path.join(codexHome, "sessions", "2026", "07", "12", "rollout-cold-revision-bundle.jsonl");
  const candidateFile = path.join(root, "cold-prefix.sqlite");
  const candidateManifest = path.join(root, "cold-prefix.manifest.json");
  const bundleDirectory = path.join(root, "bundle");
  const importDirectory = path.join(root, "imported");
  const firstTimestamp = "2026-07-12T02:00:00.000Z";
  const secondTimestamp = "2026-07-12T02:01:00.000Z";
  const options = { homeDir: root, env: {}, extraHomes: codexHome, importDirs: [] };
  const archived = new UsageStore({ ...options, databaseFile: path.join(root, "archived.sqlite") });
  const oracle = new UsageStore({ ...options, databaseFile: path.join(root, "oracle.sqlite") });
  let importedStore;
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
    const candidateDigest = fileDigest(candidateFile);

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

    const prefix90 = codexCumulativePrefix(codexHome, firstTimestamp, 90);
    writeFileSync(usageFile, `${prefix90}\n${codexTokenLine(secondTimestamp, 120, 30)}\n`);
    invalidateSource(archived, usageFile);
    await archived.sync({ options });

    const prefix80 = codexCumulativePrefix(codexHome, firstTimestamp, 80);
    writeFileSync(usageFile, `${prefix80}\n${codexTokenLine(secondTimestamp, 110, 30)}\n`);
    invalidateSource(archived, usageFile);
    await archived.sync({ options });

    assert.equal(fileDigest(candidateFile), candidateDigest);
    assert.deepEqual(
      archived.database
        .prepare("SELECT total FROM events ORDER BY timestamp_ms")
        .all()
        .map((row) => Number(row.total)),
      [30],
    );
    assert.deepEqual(
      (await archived.publishedHistoryUsageEvents()).map((event) => event.total.total),
      [80, 30],
    );

    const originalRevisionMeta = archived.readMetaRaw(REVISION_META);
    const revisionMeta = JSON.parse(originalRevisionMeta);
    assert.equal(revisionMeta.revisions.length, 1);
    assert.deepEqual(
      revisionMeta.revisions[0].removed.map((delta) => [delta.payload.total, delta.count]),
      [[100, 1]],
    );
    assert.deepEqual(
      revisionMeta.revisions[0].added.map((delta) => [delta.payload.total, delta.count]),
      [[80, 1]],
    );
    const originalReplacedFacts = replacedFacts(archived, usageFile);
    assert.deepEqual(
      originalReplacedFacts.map((row) => [JSON.parse(row.payload).total, Number(row.occurrence_count)]),
      [[90, 1]],
    );

    await oracle.sync({ options });
    assert.deepEqual(
      oracle.publishedUsageEvents().map((event) => event.total.total),
      [80, 30],
    );

    await publishHistoryArchiveBundle(archived.database, bundleDirectory);
    await publishHistoryArchiveImport(bundleDirectory, importDirectory);
    archived.close();

    rmSync(usageFile);
    rmSync(candidateFile);
    rmSync(candidateManifest);
    assert.equal(existsSync(usageFile), false);
    assert.equal(existsSync(candidateFile), false);
    assert.equal(existsSync(candidateManifest), false);

    const loaded = await loadHistoryArchiveImport(importDirectory);
    assert.equal(loaded.ok, true);
    importedStore = new UsageStore({ ...options, databaseFile: loaded.runtimeFile });
    await importedStore.open();

    const importedEvents = await importedStore.publishedHistoryUsageEvents();
    assert.deepEqual(importedEvents, oracle.publishedUsageEvents());
    assert.deepEqual(
      importedEvents.map((event) => event.total.total),
      [80, 30],
    );

    const summaryOptions = {
      preset: "all",
      now: "2026-07-15T12:00:00.000Z",
      calendarZone: "utc",
    };
    const importedSummary = await importedStore.summarizeHistory(summaryOptions);
    const oracleSummary = oracle.summarize(summaryOptions);
    assert.equal(importedSummary.totals.total, 110);
    assert.deepEqual(importedSummary.totals, oracleSummary.totals);

    assert.equal(importedStore.readMetaRaw(REVISION_META), originalRevisionMeta);
    assert.deepEqual(replacedFacts(importedStore, usageFile), originalReplacedFacts);

    const segment = loaded.manifest.segments.find((entry) => entry.segmentId === registered.segmentId);
    assert.ok(segment);
    const importedSegmentFile = path.join(loaded.bundleDirectory, segment.databaseFile);
    assert.equal(fileDigest(importedSegmentFile), candidateDigest);
    const segmentDatabase = new DatabaseSync(importedSegmentFile, { readOnly: true });
    try {
      assert.deepEqual(
        segmentDatabase
          .prepare("SELECT total FROM events ORDER BY timestamp_ms")
          .all()
          .map((row) => Number(row.total)),
        [100],
      );
    } finally {
      segmentDatabase.close();
    }
  } finally {
    importedStore?.close();
    archived.close();
    oracle.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
