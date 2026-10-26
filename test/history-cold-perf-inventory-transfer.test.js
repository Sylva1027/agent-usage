import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
import { PERF_SAMPLE_FIELDS, UsageStore } from "../src/usage-store.js";
import { createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

const HOT_START_MS = Date.parse("2026-10-04T12:00:00.000Z");
const PERF_SOURCE_INVENTORY_META_KEY = "history_archive_perf_sources_v1";
const PERF_COLUMNS = PERF_SAMPLE_FIELDS.map((entry) => entry.column);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fileSha256(filePath) {
  return sha256(readFileSync(filePath));
}

function decodedSampleAsSourceColumns(sample) {
  return Object.fromEntries(
    PERF_SAMPLE_FIELDS.map((entry) => [
      entry.column,
      entry.kind === "reasonChain" && sample[entry.field] !== null
        ? JSON.stringify(sample[entry.field])
        : sample[entry.field],
    ]),
  );
}

test("cold perf source inventory and samples survive complete bundle import after source removal", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const importRoot = await mkdtemp(path.join(os.tmpdir(), "cold-perf-inventory-transfer-"));
  const options = {
    ...fixture.serverOptions,
    databaseFile: path.join(fixture.serverOptions.homeDir, "cold-perf-inventory-transfer.sqlite"),
  };
  const candidateFile = path.join(fixture.serverOptions.homeDir, "cold-perf-inventory-transfer-candidate.sqlite");
  const candidateManifest = candidateFile.replace(/\.sqlite$/, ".manifest.json");
  const bundleDirectory = path.join(importRoot, "published");
  const importDirectory = path.join(importRoot, "imported");
  let store;
  let runtime;
  try {
    store = new UsageStore(options);
    await store.sync({ options });
    const coldStartMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    const sourceRows = store.database
      .prepare(
        `SELECT ${PERF_COLUMNS.join(", ")} FROM perf_samples
         WHERE ts_ms >= ? AND ts_ms < ? ORDER BY sample_key`,
      )
      .all(coldStartMs, HOT_START_MS)
      .map((row) => ({ ...row }));
    const identities = store.database
      .prepare(
        `SELECT sf.path, sf.kind, sf.home_id, sf.home_label, sf.home_path
         FROM perf_samples AS p
         JOIN source_files AS sf ON sf.path = p.source_path
         WHERE p.ts_ms >= ? AND p.ts_ms < ?
         GROUP BY sf.path, sf.kind, sf.home_id, sf.home_label, sf.home_path
         ORDER BY sf.path`,
      )
      .all(coldStartMs, HOT_START_MS)
      .map((row) => ({ ...row }));

    assert.ok(sourceRows.length > 0, "source SQL must find complete cold perf rows");
    assert.equal(identities.length, 1, "fixture must expose exactly one cold perf source");
    const identity = identities[0];
    const sampleKeys = sourceRows.map((row) => String(row.sample_key));
    const expectedInventory = {
      formatVersion: 1,
      sources: [
        {
          path: String(identity.path),
          kind: String(identity.kind),
          homeId: String(identity.home_id),
          homeLabel: String(identity.home_label),
          homePath: String(identity.home_path),
          sampleCount: sampleKeys.length,
          sampleKeysSha256: sha256(JSON.stringify(sampleKeys)),
          methodVersions: [...new Set(sourceRows.map((row) => String(row.method_version)))].sort(),
        },
      ],
    };

    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: coldStartMs,
      endMs: HOT_START_MS,
    });
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    await publishHistoryArchiveBundle(store.database, bundleDirectory);
    await publishHistoryArchiveImport(bundleDirectory, importDirectory);

    store.close();
    store = undefined;
    rmSync(candidateFile);
    rmSync(candidateManifest);
    assert.equal(existsSync(candidateFile), false);
    assert.equal(existsSync(candidateManifest), false);
    fixture.close();
    assert.equal(existsSync(String(identity.path)), false, "original ZCode source must be gone before runtime reads");

    const loaded = await loadHistoryArchiveImport(importDirectory);
    const runtimeRegistry = new DatabaseSync(loaded.runtimeFile, { readOnly: true });
    let segmentFile;
    try {
      const segment = runtimeRegistry
        .prepare(
          `SELECT database_path, database_sha256 FROM archive_segments
           WHERE segment_id = ?`,
        )
        .get(registered.segmentId);
      assert.ok(segment, "imported runtime must retain the registered segment");
      segmentFile = String(segment.database_path);
      assert.equal(fileSha256(segmentFile), String(segment.database_sha256));
    } finally {
      runtimeRegistry.close();
    }
    const segmentDigest = fileSha256(segmentFile);

    const segmentDatabase = new DatabaseSync(segmentFile, { readOnly: true });
    let inventoryBytes;
    try {
      const row = segmentDatabase
        .prepare("SELECT value FROM store_meta WHERE key = ?")
        .get(PERF_SOURCE_INVENTORY_META_KEY);
      assert.ok(row, "imported segment must retain the perf source inventory");
      inventoryBytes = String(row.value);
    } finally {
      segmentDatabase.close();
    }
    assert.equal(inventoryBytes, JSON.stringify(expectedInventory));
    assert.deepEqual(JSON.parse(inventoryBytes), expectedInventory);

    runtime = new UsageStore({
      homeDir: importRoot,
      env: {},
      importDirs: [],
      automaticDiscoveryEnabled: false,
      databaseFile: loaded.runtimeFile,
    });
    const actualRows = (await runtime.readHistoryArchivePerfSamples(registered.segmentId)).map(
      decodedSampleAsSourceColumns,
    );
    assert.deepEqual(actualRows, sourceRows, "every imported cold perf column must match source SQL");
    assert.equal(fileSha256(segmentFile), segmentDigest, "runtime perf reads must not modify the imported segment");
  } finally {
    runtime?.close();
    store?.close();
    fixture.close();
    await rm(importRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
