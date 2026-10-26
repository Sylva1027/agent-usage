import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createHistoryBackup } from "../src/history-backup.js";
import { createHistoryArchiveCandidate, verifyHistoryArchiveCandidate } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

const PERF_SOURCE_INVENTORY_META_KEY = "history_archive_perf_sources_v1";
const CANDIDATE_META_KEY = "history_archive_candidate";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function repackCandidate(sourceFile, stagingFile, destinationFile, mutateInventory) {
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  try {
    await backup(source, stagingFile);
  } finally {
    source.close();
  }
  const database = new DatabaseSync(stagingFile);
  try {
    if (mutateInventory === null) {
      database.prepare("DELETE FROM store_meta WHERE key = ?").run(PERF_SOURCE_INVENTORY_META_KEY);
    } else {
      const row = database.prepare("SELECT value FROM store_meta WHERE key = ?").get(PERF_SOURCE_INVENTORY_META_KEY);
      assert.ok(row, "source candidate must contain perf source inventory before mutation");
      const inventory = JSON.parse(String(row.value));
      mutateInventory(inventory);
      database
        .prepare("UPDATE store_meta SET value = ? WHERE key = ?")
        .run(JSON.stringify(inventory), PERF_SOURCE_INVENTORY_META_KEY);
    }
    await createHistoryBackup(database, destinationFile);
  } finally {
    database.close();
  }
}

test("candidate perf source inventory explicitly covers a perf-only ZCode source", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const options = {
    ...fixture.serverOptions,
    databaseFile: path.join(fixture.serverOptions.homeDir, "cold-perf-capability.sqlite"),
  };
  const isolatedFile = path.join(fixture.serverOptions.homeDir, "cold-perf-capability-isolated.sqlite");
  const candidateFile = path.join(fixture.serverOptions.homeDir, "cold-perf-capability-candidate.sqlite");
  const store = new UsageStore(options);
  let isolated;
  let candidate;
  try {
    await store.sync({ options });
    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    const target = store.database
      .prepare("SELECT source_path FROM events WHERE timestamp_ms = ? ORDER BY source_path LIMIT 1")
      .get(coldStartMs);
    assert.ok(target, "fixture must have an event at the cold boundary");
    const targetPath = String(target.source_path);
    const targetMaxTs = Number(
      store.database.prepare("SELECT MAX(ts_ms) AS value FROM perf_samples WHERE source_path = ?").get(targetPath)
        .value,
    );
    const anchor = store.database
      .prepare(
        `SELECT source_path, MIN(timestamp_ms) AS ts_ms FROM events
         WHERE source_path <> ? GROUP BY source_path HAVING MIN(timestamp_ms) > ?
         ORDER BY ts_ms LIMIT 1`,
      )
      .get(targetPath, targetMaxTs);
    assert.ok(anchor, "fixture must retain another event source after the cold perf source");
    const endMs = Number(anchor.ts_ms) + 1;

    await backup(store.database, isolatedFile);
    isolated = new DatabaseSync(isolatedFile);
    isolated.prepare("DELETE FROM events WHERE source_path = ?").run(targetPath);

    assert.equal(
      Number(isolated.prepare("SELECT COUNT(*) AS count FROM events WHERE source_path = ?").get(targetPath).count),
      0,
      "target source must have no events in the isolated candidate input",
    );
    assert.ok(
      Number(
        isolated
          .prepare(
            "SELECT COUNT(*) AS count FROM events WHERE source_path <> ? AND timestamp_ms >= ? AND timestamp_ms < ?",
          )
          .get(targetPath, coldStartMs, endMs).count,
      ) > 0,
      "another event source must keep the candidate buildable",
    );

    const identity = isolated
      .prepare("SELECT path, kind, home_id, home_label, home_path FROM source_files WHERE path = ?")
      .get(targetPath);
    assert.ok(identity, "perf-only source identity must remain in source_files");
    const coldSamples = isolated
      .prepare(
        `SELECT sample_key, method_version FROM perf_samples
         WHERE source_path = ? AND ts_ms >= ? AND ts_ms < ? ORDER BY sample_key`,
      )
      .all(targetPath, coldStartMs, endMs);
    const coldSampleKeys = coldSamples.map((row) => String(row.sample_key));
    const methodVersions = [...new Set(coldSamples.map((row) => String(row.method_version)))].sort();
    assert.ok(coldSampleKeys.length > 0, "perf-only source must retain cold samples");
    const perfSourceCount = Number(
      isolated
        .prepare(
          `SELECT COUNT(DISTINCT source_path) AS count FROM perf_samples
           WHERE ts_ms >= ? AND ts_ms < ?`,
        )
        .get(coldStartMs, endMs).count,
    );

    const missingIdentityFile = path.join(fixture.serverOptions.homeDir, "cold-perf-capability-missing-source.sqlite");
    await backup(isolated, missingIdentityFile);
    const missingIdentity = new DatabaseSync(missingIdentityFile);
    try {
      missingIdentity.exec("PRAGMA foreign_keys = OFF");
      missingIdentity.prepare("DELETE FROM source_files WHERE path = ?").run(targetPath);
      assert.ok(
        Number(
          missingIdentity
            .prepare(
              `SELECT COUNT(*) AS count FROM perf_samples
               WHERE source_path = ? AND ts_ms >= ? AND ts_ms < ?`,
            )
            .get(targetPath, coldStartMs, endMs).count,
        ) > 0,
        "missing-identity fixture must retain target perf samples",
      );
    } finally {
      missingIdentity.close();
    }

    await createHistoryArchiveCandidate(isolated, candidateFile, { startMs: coldStartMs, endMs });
    isolated.close();
    isolated = undefined;
    await verifyHistoryArchiveCandidate(candidateFile);

    candidate = new DatabaseSync(candidateFile, { readOnly: true });
    assert.deepEqual(
      candidate
        .prepare(
          `SELECT sample_key FROM perf_samples
           WHERE source_path = ? AND ts_ms >= ? AND ts_ms < ? ORDER BY sample_key`,
        )
        .all(targetPath, coldStartMs, endMs)
        .map((row) => String(row.sample_key)),
      coldSampleKeys,
      "candidate must retain every cold perf sample from the perf-only source",
    );
    assert.ok(
      candidate.prepare("SELECT 1 AS present FROM source_files WHERE path = ?").get(targetPath),
      "candidate must retain the perf-only source identity",
    );
    assert.equal(
      Number(candidate.prepare("SELECT COUNT(*) AS count FROM events WHERE source_path = ?").get(targetPath).count),
      0,
      "target source must remain perf-only in the candidate",
    );

    const eventMetadata = JSON.parse(
      String(candidate.prepare("SELECT value FROM store_meta WHERE key = ?").get(CANDIDATE_META_KEY).value),
    );
    assert.equal(eventMetadata.sources.rows, 1, "events-v1 source evidence must cover only the remaining event source");

    const expectedInventorySource = {
      path: String(identity.path),
      kind: String(identity.kind),
      homeId: String(identity.home_id),
      homeLabel: String(identity.home_label),
      homePath: String(identity.home_path),
      sampleCount: coldSampleKeys.length,
      sampleKeysSha256: sha256(JSON.stringify(coldSampleKeys)),
      methodVersions,
    };
    const inventoryRow = candidate
      .prepare("SELECT value FROM store_meta WHERE key = ?")
      .get(PERF_SOURCE_INVENTORY_META_KEY);
    assert.ok(
      inventoryRow,
      `candidate must store its perf source inventory under ${PERF_SOURCE_INVENTORY_META_KEY}; events-v1 source evidence omits ${targetPath} (${expectedInventorySource.sampleCount} cold samples, sampleKeysSha256 ${expectedInventorySource.sampleKeysSha256})`,
    );
    const inventory = JSON.parse(String(inventoryRow.value));
    assert.deepEqual(Object.keys(inventory).sort(), ["formatVersion", "sources"]);
    assert.equal(inventory.formatVersion, 1);
    const targetEvidence = inventory.sources.filter(
      (source) => source.path === expectedInventorySource.path && source.kind === expectedInventorySource.kind,
    );
    assert.equal(targetEvidence.length, 1, "perf-only source must appear exactly once in the perf source inventory");
    assert.deepEqual(targetEvidence[0], expectedInventorySource);
    assert.equal(inventory.sources.length, perfSourceCount, "inventory must cover every finite-ts perf source");

    candidate.close();
    candidate = undefined;

    const missingCandidateFile = path.join(
      fixture.serverOptions.homeDir,
      "cold-perf-capability-missing-candidate.sqlite",
    );
    const missingSource = new DatabaseSync(missingIdentityFile, { readOnly: true });
    try {
      await assert.rejects(
        () =>
          createHistoryArchiveCandidate(missingSource, missingCandidateFile, {
            startMs: coldStartMs,
            endMs,
          }),
        (error) => {
          assert.equal(error.code, "HISTORY_ARCHIVE_CANDIDATE_PERF_SOURCE_MISSING");
          return true;
        },
      );
    } finally {
      missingSource.close();
    }

    const forgedVariants = [
      {
        name: "sample-count",
        code: "HISTORY_ARCHIVE_CANDIDATE_PERF_SOURCES_MISMATCH",
        mutate: (forged) => {
          forged.sources[0].sampleCount += 1;
        },
      },
      {
        name: "sample-digest",
        code: "HISTORY_ARCHIVE_CANDIDATE_PERF_SOURCES_MISMATCH",
        mutate: (forged) => {
          const digest = forged.sources[0].sampleKeysSha256;
          forged.sources[0].sampleKeysSha256 = `${digest.slice(0, -1)}${digest.endsWith("0") ? "1" : "0"}`;
        },
      },
      {
        name: "format-version",
        code: "HISTORY_ARCHIVE_CANDIDATE_PERF_SOURCES_BAD_METADATA",
        mutate: (forged) => {
          forged.formatVersion = 2;
        },
      },
    ];
    for (const variant of forgedVariants) {
      const stagingFile = path.join(fixture.serverOptions.homeDir, `forged-${variant.name}-staging.sqlite`);
      const forgedFile = path.join(fixture.serverOptions.homeDir, `forged-${variant.name}.sqlite`);
      await repackCandidate(candidateFile, stagingFile, forgedFile, variant.mutate);
      await assert.rejects(
        () => verifyHistoryArchiveCandidate(forgedFile),
        (error) => {
          assert.equal(error.code, variant.code, `${variant.name} inventory forgery must be rejected`);
          return true;
        },
      );
    }

    const legacyStagingFile = path.join(fixture.serverOptions.homeDir, "legacy-no-inventory-staging.sqlite");
    const legacyFile = path.join(fixture.serverOptions.homeDir, "legacy-no-inventory.sqlite");
    await repackCandidate(candidateFile, legacyStagingFile, legacyFile, null);
    const legacy = await verifyHistoryArchiveCandidate(legacyFile);
    assert.ok(legacy.candidate);
    const legacyDatabase = new DatabaseSync(legacyFile, { readOnly: true });
    try {
      assert.equal(
        legacyDatabase.prepare("SELECT value FROM store_meta WHERE key = ?").get(PERF_SOURCE_INVENTORY_META_KEY),
        undefined,
      );
      assert.ok(
        Number(legacyDatabase.prepare("SELECT COUNT(*) AS count FROM events").get().count) > 0,
        "legacy candidate without perf source inventory must still expose events",
      );
    } finally {
      legacyDatabase.close();
    }
  } finally {
    candidate?.close();
    isolated?.close();
    store.close();
    fixture.close();
  }
});
