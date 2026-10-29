import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createHistoryArchiveCandidate,
  prepareHistoryArchiveCommit,
  verifyHistoryArchiveCandidate,
} from "../src/history-archive.js";
import { createHistoryBackup, verifyHistoryBackup } from "../src/history-backup.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

test("v4 validates and commits v3 Codex request identities with their original native timing evidence", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync();
    await fixture.seedRequestTiming(store);
    store.database.prepare("UPDATE perf_samples SET method_version = 'tps-v3'").run();
    store.writeMeta("perf_method_version", "tps-v3");
    const filters = { preset: "all", now: "2026-10-04T13:00:00Z", calendarZone: "utc" };
    const before = await store.summarize(filters);
    assert.equal(before.perf.models[0].n, 26);
    const backupFile = path.join(fixture.serverOptions.homeDir, "v3-backup.sqlite");
    await createHistoryBackup(store.database, backupFile);
    await verifyHistoryBackup(backupFile);
    const bounds = store.database.prepare("SELECT MIN(ts_ms) AS start, MAX(ts_ms) + 1 AS end FROM perf_samples").get();
    const candidateFile = path.join(fixture.serverOptions.homeDir, "v3-candidate.sqlite");
    await createHistoryArchiveCandidate(store.database, candidateFile, { startMs: bounds.start, endMs: bounds.end });
    await verifyHistoryArchiveCandidate(candidateFile);
    const candidate = new DatabaseSync(candidateFile, { readOnly: true });
    try {
      const rows = candidate.prepare("SELECT sample_key, method_version FROM perf_samples").all();
      assert.equal(rows.length, 26);
      assert.ok(rows.every((row) => row.method_version === "tps-v3" && JSON.parse(row.sample_key).length === 5));
    } finally {
      candidate.close();
    }
    const plan = await prepareHistoryArchiveCommit(store.database, candidateFile);
    assert.equal(plan.perfDeletion.methodVersion, "tps-v3");
    const committed = await store.commitHistoryArchiveEvents(plan);
    assert.equal(committed.deletedPerfSampleCount, 26);
    const after = await store.summarizeHistory(filters);
    assert.deepEqual(after.perf.models, before.perf.models);
    assert.deepEqual(after.totals, before.totals);
  } finally {
    store.close();
    fixture.close();
  }
});
