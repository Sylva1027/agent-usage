import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

const AUTHORITY_KEY = "history_archive_event_authority";
const PERF_SOURCE_INVENTORY_KEY = "history_archive_perf_sources_v1";
const HOT_START_MS = Date.parse("2026-10-04T12:00:00.000Z");

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function writeAuthority(database, segmentId) {
  database
    .prepare(
      `INSERT INTO store_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(AUTHORITY_KEY, JSON.stringify({ formatVersion: 1, segmentIds: [segmentId] }));
}

test("cold event sealing keeps unplaced perf samples hot and out of bounded archive reads", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const homeDir = fixture.serverOptions.homeDir;
  const options = {
    ...fixture.serverOptions,
    databaseFile: path.join(homeDir, "cold-unplaced-retention.sqlite"),
  };
  const candidateFile = path.join(homeDir, "cold-unplaced-retention-candidate.sqlite");
  const store = new UsageStore(options);
  try {
    await store.sync({ options });
    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    const unplacedBefore = store.unplacedPerfSamples();
    if (unplacedBefore.length !== 1) {
      throw new Error(`fixture must expose exactly one unplaced perf sample, got ${unplacedBefore.length}`);
    }
    const unplacedKey = unplacedBefore[0].sampleKey;
    const unplacedSourcePath = unplacedBefore[0].sourcePath;

    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: coldStartMs,
      endMs: HOT_START_MS,
    });
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);

    store.database.exec("BEGIN IMMEDIATE");
    try {
      writeAuthority(store.database, registered.segmentId);
      store.database
        .prepare("DELETE FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ?")
        .run(coldStartMs, HOT_START_MS);
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }

    assert.deepEqual(
      store.unplacedPerfSamples(),
      unplacedBefore,
      "sealing cold events must not evict or rewrite the hot unplaced perf row",
    );

    const candidate = new DatabaseSync(candidateFile, { readOnly: true });
    let coldRows;
    let inventoryEntry;
    let boundedSampleKeys;
    try {
      const unplaced = candidate
        .prepare("SELECT sample_key, ts_ms FROM perf_samples WHERE sample_key = ?")
        .get(unplacedKey);
      if (!unplaced || unplaced.ts_ms !== null) {
        throw new Error("candidate must preserve the unplaced perf row with a NULL timestamp");
      }
      coldRows = candidate
        .prepare(
          `SELECT sample_key, ts_ms FROM perf_samples
           WHERE ts_ms >= ? AND ts_ms < ? ORDER BY sample_key`,
        )
        .all(coldStartMs, HOT_START_MS);
      boundedSampleKeys = candidate
        .prepare(
          `SELECT sample_key FROM perf_samples
           WHERE source_path = ? AND ts_ms >= ? AND ts_ms < ? ORDER BY sample_key`,
        )
        .all(unplacedSourcePath, coldStartMs, HOT_START_MS)
        .map((row) => String(row.sample_key));
      if (boundedSampleKeys.includes(unplacedKey)) {
        throw new Error("the bounded perf inventory must not contain the unplaced sample key");
      }
      const inventory = JSON.parse(
        String(candidate.prepare("SELECT value FROM store_meta WHERE key = ?").get(PERF_SOURCE_INVENTORY_KEY).value),
      );
      inventoryEntry = inventory.sources.find((source) => source.path === unplacedSourcePath);
      if (!inventoryEntry) {
        throw new Error(`candidate perf inventory is missing source ${unplacedSourcePath}`);
      }
    } finally {
      candidate.close();
    }

    assert.deepEqual(
      {
        sampleCount: inventoryEntry.sampleCount,
        sampleKeysSha256: inventoryEntry.sampleKeysSha256,
      },
      {
        sampleCount: boundedSampleKeys.length,
        sampleKeysSha256: sha256(boundedSampleKeys),
      },
      "the source inventory must describe only timestamped samples in the registered range",
    );

    const archivedRows = await store.readHistoryArchivePerfSamples(registered.segmentId);
    assert.deepEqual(
      archivedRows.map((sample) => [sample.sampleKey, sample.tsMs]),
      coldRows.map((row) => [String(row.sample_key), Number(row.ts_ms)]),
      "the archive reader must return only finite registered-range samples with their stored timestamps",
    );
  } finally {
    store.close();
    fixture.close();
  }
});
