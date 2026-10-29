import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

const HOT_START_MS = Date.parse("2026-10-04T12:00:00.000Z");

function stableSummaryEvidence(summary) {
  const perf = structuredClone(summary.perf);
  perf.indexedAt = null;
  perf.meta.indexedAt = null;
  return {
    eventCount: summary.eventCount,
    sessionCount: summary.sessionCount,
    homeCount: summary.homeCount,
    totals: summary.totals,
    perf,
  };
}

test("formally evicting cold events and perf keeps cold metrics in summarizeHistory", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const homeDir = fixture.serverOptions.homeDir;
  const archivedFile = path.join(homeDir, "cold-perf-archived.sqlite");
  const oracleFile = path.join(homeDir, "cold-perf-oracle.sqlite");
  const candidateFile = path.join(homeDir, "cold-perf-candidate.sqlite");
  const archivedOptions = { ...fixture.serverOptions, databaseFile: archivedFile };
  const oracleOptions = {
    ...fixture.serverOptions,
    databaseFile: oracleFile,
    importStoreFile: path.join(homeDir, "cold-perf-oracle-imports.json"),
  };
  const archived = new UsageStore(archivedOptions);
  const oracle = new UsageStore(oracleOptions);
  try {
    await archived.sync({ options: archivedOptions });
    await oracle.sync({ options: oracleOptions });

    const coldStartMs = Number(archived.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    await createHistoryArchiveCandidate(archived.database, candidateFile, {
      startMs: coldStartMs,
      endMs: HOT_START_MS,
    });
    const plan = await prepareHistoryArchiveCommit(archived.database, candidateFile);

    const selectSample = (startMs, endMs) =>
      archived.database
        .prepare(
          `SELECT sample_key, ts_ms, output_tokens, duration_ms, model
           FROM perf_samples
           WHERE ts_ms >= ? AND ts_ms < ?
             AND output_tokens IS NULL
             AND duration_ms IS NULL
             AND status = 'completed'
             AND timing_kind = 'generation'
             AND request_count = 1
           ORDER BY ts_ms, sample_key
           LIMIT 1`,
        )
        .get(startMs, endMs);
    const coldSample = selectSample(coldStartMs, HOT_START_MS);
    const hotSample = selectSample(HOT_START_MS, Number.MAX_SAFE_INTEGER);
    if (!coldSample || !hotSample) {
      throw new Error("fixture did not expose cold and hot missing-generation ZCode candidates");
    }
    assert.ok(plan.perfDeletion.sampleKeys.includes(String(coldSample.sample_key)));
    const committed = await archived.commitHistoryArchiveEvents(plan);
    const remainingSampleKeys = archived.database
      .prepare("SELECT sample_key FROM perf_samples ORDER BY sample_key")
      .all()
      .map((row) => String(row.sample_key));
    assert.ok(
      !remainingSampleKeys.includes(String(coldSample.sample_key)),
      "the formal commit must remove the selected cold sample from hot perf_samples",
    );
    assert.ok(
      remainingSampleKeys.includes(String(hotSample.sample_key)),
      "the formal commit must retain the hot sample outside the sealed range",
    );
    const segmentBefore = await archived.readHistoryArchiveEvents(committed.segmentId);

    const filters = { preset: "all", now: "2026-10-04T13:00:00.000Z", calendarZone: "utc" };
    const archivedSummary = await archived.summarizeHistory(filters);
    const oracleSummary = await oracle.summarizeHistory(filters);
    const segmentAfter = await archived.readHistoryArchiveEvents(committed.segmentId);

    assert.deepEqual(
      segmentAfter,
      segmentBefore,
      "reading committed cold perf samples must not change the immutable segment payload",
    );
    assert.deepEqual(
      stableSummaryEvidence(archivedSummary),
      stableSummaryEvidence(oracleSummary),
      "formal cold event/perf eviction must leave complete usage and perf coverage equal to the hot oracle",
    );
  } finally {
    archived.close();
    oracle.close();
    fixture.close();
  }
});
