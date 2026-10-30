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
import { PERF_TOKEN_SCOPE } from "../src/perf-stats.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

for (const historicalMethod of ["tps-v3", "tps-v6", "tps-v7"]) {
  test(`current archive validates historical ${historicalMethod} identities with original evidence`, async () => {
    const fixture = createPerfCodexIntegrationFixture();
    const store = new UsageStore(fixture.serverOptions);
    try {
      await store.sync();
      if (historicalMethod === "tps-v3") await fixture.seedRequestTiming(store);
      store.database
        .prepare(
          `UPDATE perf_samples
         SET method_version = ?, token_scope = ?`,
        )
        .run(historicalMethod, historicalMethod === "tps-v3" ? "non_reasoning_output" : PERF_TOKEN_SCOPE);
      store.writeMeta("perf_method_version", historicalMethod);
      const filters = { preset: "all", now: "2026-10-04T13:00:00Z", calendarZone: "utc" };
      const before = await store.summarize(filters);
      assert.deepEqual(before.perf.groups, []);
      assert.equal(before.perf.coverage.sampled, 0);
      assert.equal(before.perf.models.length, 1);
      assert.deepEqual(
        {
          sourceKind: before.perf.models[0].sourceKind,
          model: before.perf.models[0].model,
          window: before.perf.models[0].window,
          state: before.perf.models[0].state,
          n: before.perf.models[0].n,
          averageTps: before.perf.models[0].averageTps,
          p10: before.perf.models[0].p10,
          p90: before.perf.models[0].p90,
          candidateCount: before.perf.models[0].candidateCount,
        },
        {
          sourceKind: "codex",
          model: "codex-fixture-model",
          window: "request",
          state: "missing_duration",
          n: 0,
          averageTps: null,
          p10: null,
          p90: null,
          candidateCount: 26,
        },
        `${historicalMethod} retains its identity-only missing-duration row without entering current statistics`,
      );
      const backupFile = path.join(fixture.serverOptions.homeDir, `${historicalMethod}-backup.sqlite`);
      await createHistoryBackup(store.database, backupFile);
      await verifyHistoryBackup(backupFile);
      const bounds = store.database
        .prepare("SELECT MIN(ts_ms) AS start, MAX(ts_ms) + 1 AS end FROM perf_samples")
        .get();
      const candidateFile = path.join(fixture.serverOptions.homeDir, `${historicalMethod}-candidate.sqlite`);
      await createHistoryArchiveCandidate(store.database, candidateFile, { startMs: bounds.start, endMs: bounds.end });
      await verifyHistoryArchiveCandidate(candidateFile);
      const candidate = new DatabaseSync(candidateFile, { readOnly: true });
      try {
        const rows = candidate.prepare("SELECT sample_key, method_version FROM perf_samples").all();
        assert.equal(rows.length, 26);
        assert.ok(
          rows.every((row) => row.method_version === historicalMethod && JSON.parse(row.sample_key).length === 5),
        );
      } finally {
        candidate.close();
      }
      const plan = await prepareHistoryArchiveCommit(store.database, candidateFile);
      assert.equal(plan.perfDeletion.methodVersion, historicalMethod);
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
}
