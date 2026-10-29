import assert from "node:assert/strict";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryArchiveCandidate, verifyHistoryArchiveCandidate } from "../src/history-archive.js";
import { createHistoryBackup } from "../src/history-backup.js";
import { PERF_METHOD_VERSION } from "../src/perf-stats.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

const EVENT_AUTHORITY_KEY = "history_archive_event_authority";
const PERF_AUTHORITY_KEY = "history_archive_perf_authority";
const MISSING_COMPONENT_KEY = "history_archive_perf_index_v1";
const HOT_START_MS = Date.parse("2026-10-04T12:00:00.000Z");
const FILTERS = { preset: "all", now: "2026-10-04T13:00:00.000Z", calendarZone: "utc" };

function writeMeta(database, key, value) {
  database
    .prepare(
      `INSERT INTO store_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, JSON.stringify(value));
}

function eventAuthority(registered) {
  return { formatVersion: 1, segmentIds: [registered.segmentId] };
}

function perfAuthority(registered, segmentOverrides = {}) {
  return {
    formatVersion: 1,
    segments: [
      {
        segmentId: registered.segmentId,
        databaseSha256: registered.databaseSha256,
        sourceKinds: ["zcode"],
        methodVersions: [PERF_METHOD_VERSION],
        ...segmentOverrides,
      },
    ],
  };
}

function archiveHotTail(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const deleted = database.prepare("DELETE FROM events WHERE timestamp_ms < ?").run(HOT_START_MS);
    assert.ok(Number(deleted.changes) > 0, "guard fixture must archive a non-empty cold event range");
    // Keep the hot-only fallback observable instead of serving archived totals from rollups.
    database.exec(`
      DELETE FROM usage_rollup_models;
      DELETE FROM usage_rollup_sessions;
      DELETE FROM usage_rollup_daily;
      DELETE FROM usage_rollup_days;
    `);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function repackWithoutMeta(sourceFile, stagingFile, destinationFile, key) {
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  try {
    await backup(source, stagingFile);
  } finally {
    source.close();
  }
  const staging = new DatabaseSync(stagingFile);
  try {
    const removed = staging.prepare("DELETE FROM store_meta WHERE key = ?").run(key);
    assert.equal(Number(removed.changes), 1, `repacked candidate must remove exactly one ${key} row`);
    await createHistoryBackup(staging, destinationFile);
  } finally {
    staging.close();
  }
}

test("perf authority without its event authority rejects instead of returning a hot-only summary", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const options = {
    ...fixture.serverOptions,
    databaseFile: path.join(fixture.serverOptions.homeDir, "cold-perf-guard-missing-event.sqlite"),
  };
  const candidateFile = path.join(fixture.serverOptions.homeDir, "cold-perf-guard-missing-event-candidate.sqlite");
  const store = new UsageStore(options);
  try {
    await store.sync({ options });
    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: coldStartMs,
      endMs: HOT_START_MS,
    });
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);

    const marker = perfAuthority(registered);
    store.database.exec("BEGIN IMMEDIATE");
    try {
      writeMeta(store.database, EVENT_AUTHORITY_KEY, eventAuthority(registered));
      writeMeta(store.database, PERF_AUTHORITY_KEY, marker);
      store.database.prepare("DELETE FROM store_meta WHERE key = ?").run(EVENT_AUTHORITY_KEY);
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }
    archiveHotTail(store.database);

    assert.equal(
      store.database.prepare("SELECT 1 AS present FROM store_meta WHERE key = ?").get(EVENT_AUTHORITY_KEY),
      undefined,
      "the guard must keep the persisted perf marker without the event marker",
    );
    assert.deepEqual(
      JSON.parse(store.database.prepare("SELECT value FROM store_meta WHERE key = ?").get(PERF_AUTHORITY_KEY).value),
      marker,
    );
    assert.ok(
      Number(store.database.prepare("SELECT COUNT(*) AS count FROM events").get().count) > 0,
      "the current fallback must still have hot data to return",
    );

    await assert.rejects(
      store.summarizeHistory(FILTERS),
      (error) => error?.code === "HISTORY_ARCHIVE_PERF_AUTHORITY_MISMATCH",
      "a perf marker without its same-segment event marker must not return a hot-only partial success",
    );
  } finally {
    store.close();
    fixture.close();
  }
});

test("perf authority rejects unknown source kinds and method versions as invalid", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const options = {
    ...fixture.serverOptions,
    databaseFile: path.join(fixture.serverOptions.homeDir, "cold-perf-guard-invalid-marker.sqlite"),
  };
  const candidateFile = path.join(fixture.serverOptions.homeDir, "cold-perf-guard-invalid-marker-candidate.sqlite");
  const store = new UsageStore(options);
  try {
    await store.sync({ options });
    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: coldStartMs,
      endMs: HOT_START_MS,
    });
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    writeMeta(store.database, EVENT_AUTHORITY_KEY, eventAuthority(registered));
    archiveHotTail(store.database);

    const variants = [
      { label: "unknown source kind", segment: { sourceKinds: ["dsh"] } },
      { label: "unknown method version", segment: { methodVersions: ["tps-v0"] } },
    ];
    for (const variant of variants) {
      writeMeta(store.database, PERF_AUTHORITY_KEY, perfAuthority(registered, variant.segment));
      await assert.rejects(
        store.summarizeHistory(FILTERS),
        (error) => error?.code === "HISTORY_ARCHIVE_PERF_AUTHORITY_INVALID",
        `${variant.label} must fail with the exact invalid-authority code`,
      );
    }
    const duplicateSegment = {
      segmentId: registered.segmentId,
      databaseSha256: registered.databaseSha256,
      sourceKinds: ["zcode"],
      methodVersions: [PERF_METHOD_VERSION],
    };
    writeMeta(store.database, PERF_AUTHORITY_KEY, {
      formatVersion: 1,
      segments: [duplicateSegment, duplicateSegment],
    });
    await assert.rejects(
      store.summarizeHistory(FILTERS),
      (error) => error?.code === "HISTORY_ARCHIVE_PERF_AUTHORITY_INVALID",
      "a duplicate segment id must be rejected rather than read twice",
    );
  } finally {
    store.close();
    fixture.close();
  }
});

test("perf authority binds its declared source kind to the cold segment samples", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const options = {
    ...fixture.serverOptions,
    databaseFile: path.join(fixture.serverOptions.homeDir, "cold-perf-guard-kind-binding.sqlite"),
  };
  const candidateFile = path.join(fixture.serverOptions.homeDir, "cold-perf-guard-kind-binding-candidate.sqlite");
  const store = new UsageStore(options);
  try {
    await store.sync({ options });
    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: coldStartMs,
      endMs: HOT_START_MS,
    });
    const verified = await verifyHistoryArchiveCandidate(candidateFile);
    assert.equal(verified.ok, true);
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    writeMeta(store.database, EVENT_AUTHORITY_KEY, eventAuthority(registered));
    writeMeta(store.database, PERF_AUTHORITY_KEY, perfAuthority(registered, { sourceKinds: ["codex"] }));
    archiveHotTail(store.database);

    await assert.rejects(
      store.summarizeHistory(FILTERS),
      (error) => error?.code === "HISTORY_ARCHIVE_PERF_AUTHORITY_MISMATCH",
      "a codex declaration must not authorize the candidate's actual ZCode perf samples",
    );
  } finally {
    store.close();
    fixture.close();
  }
});

test("perf authority rejects a verified candidate that lacks one required component", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const homeDir = fixture.serverOptions.homeDir;
  const options = {
    ...fixture.serverOptions,
    databaseFile: path.join(homeDir, "cold-perf-guard-missing-component.sqlite"),
  };
  const candidateFile = path.join(homeDir, "cold-perf-guard-missing-component-candidate.sqlite");
  const stagingFile = path.join(homeDir, "cold-perf-guard-missing-component-staging.sqlite");
  const repackedFile = path.join(homeDir, "cold-perf-guard-missing-component-repacked.sqlite");
  const store = new UsageStore(options);
  try {
    await store.sync({ options });
    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: coldStartMs,
      endMs: HOT_START_MS,
    });
    await repackWithoutMeta(candidateFile, stagingFile, repackedFile, MISSING_COMPONENT_KEY);

    const verified = await verifyHistoryArchiveCandidate(repackedFile);
    assert.equal(verified.ok, true, "legacy event verification must still accept the repacked candidate");
    const registered = await store.registerHistoryArchiveCandidate(repackedFile);
    writeMeta(store.database, EVENT_AUTHORITY_KEY, eventAuthority(registered));
    writeMeta(store.database, PERF_AUTHORITY_KEY, perfAuthority(registered));
    archiveHotTail(store.database);

    await assert.rejects(
      store.summarizeHistory(FILTERS),
      (error) => error?.code === "HISTORY_ARCHIVE_PERF_AUTHORITY_MISMATCH",
      "perf summary must reject a missing required component after the outer backup already verified",
    );
  } finally {
    store.close();
    fixture.close();
  }
});
