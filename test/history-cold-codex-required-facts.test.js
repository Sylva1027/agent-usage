import assert from "node:assert/strict";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryBackup } from "../src/history-backup.js";
import { createHistoryArchiveCandidate, verifyHistoryArchiveCandidate } from "../src/history-archive.js";
import { PERF_METHOD_VERSION } from "../src/perf-stats.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const COLD_END_MS = Date.parse("2026-10-04T12:02:00.000Z");
const EVENT_AUTHORITY_KEY = "history_archive_event_authority";
const PERF_AUTHORITY_KEY = "history_archive_perf_authority";
const FILTERS = { preset: "all", now: "2026-10-04T13:00:00.000Z", calendarZone: "utc" };

function writeMeta(database, key, value) {
  database
    .prepare(
      `INSERT INTO store_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, JSON.stringify(value));
}

function codexRequestFactsKey(database) {
  const keys = database
    .prepare("SELECT key FROM store_meta WHERE key GLOB 'history_archive_codex_*_v1' ORDER BY key")
    .all()
    .map((row) => String(row.key));
  assert.equal(keys.length, 1, "the candidate must contain one native Codex request-facts component");
  return keys[0];
}

async function repackWithoutKey(sourceFile, stagingFile, destinationFile, key) {
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  try {
    await backup(source, stagingFile);
  } finally {
    source.close();
  }
  const staging = new DatabaseSync(stagingFile);
  try {
    const removed = staging.prepare("DELETE FROM store_meta WHERE key = ?").run(key);
    assert.equal(Number(removed.changes), 1, `the isolated copy must remove exactly one ${key} row`);
    await createHistoryBackup(staging, destinationFile);
  } finally {
    staging.close();
  }
}

test("explicit Codex perf authority requires the native request-facts component", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const homeDir = fixture.serverOptions.homeDir;
  const candidateFile = path.join(homeDir, "cold-codex-required-facts-candidate.sqlite");
  const stagingFile = path.join(homeDir, "cold-codex-required-facts-staging.sqlite");
  const repackedFile = path.join(homeDir, "cold-codex-required-facts-repacked.sqlite");
  const store = new UsageStore({
    ...fixture.serverOptions,
    databaseFile: path.join(homeDir, "cold-codex-required-facts.sqlite"),
  });
  try {
    await store.sync({ options: fixture.reportOptions });
    await fixture.seedRequestTiming(store);
    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: coldStartMs,
      endMs: COLD_END_MS,
    });

    const candidate = new DatabaseSync(candidateFile, { readOnly: true });
    let requestFactsKey;
    try {
      requestFactsKey = codexRequestFactsKey(candidate);
    } finally {
      candidate.close();
    }
    await repackWithoutKey(candidateFile, stagingFile, repackedFile, requestFactsKey);

    const verified = await verifyHistoryArchiveCandidate(repackedFile);
    assert.equal(verified.ok, true, "legacy candidate verification must accept the missing optional component");
    const registered = await store.registerHistoryArchiveCandidate(repackedFile);
    const legacyEvents = await store.readHistoryArchiveEvents(registered.segmentId);
    assert.equal(legacyEvents.length, Number(registered.eventCount));

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
      store.database.prepare("DELETE FROM events WHERE timestamp_ms < ?").run(COLD_END_MS);
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }

    await assert.rejects(
      store.summarizeHistory(FILTERS),
      (error) => error?.code === "HISTORY_ARCHIVE_PERF_AUTHORITY_MISMATCH",
      "an explicit Codex perf authority must not omit its native request-facts component",
    );
  } finally {
    store.close();
    fixture.close();
  }
});
