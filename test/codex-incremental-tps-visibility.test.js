import assert from "node:assert/strict";
import test from "node:test";

import { UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const FILTERS = { preset: "all", now: new Date("2026-10-04T13:00:00.000Z"), calendarZone: "utc" };

async function withStore(run) {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync();
    const homeId = String(store.homes.find((home) => home.path === fixture.codexHome).id);
    const importRecords = (records) =>
      store.importRequestTimingEvidence({
        homeId,
        records,
        reviewedOrigins: [...new Set(records.map((row) => row.evidenceOrigin))],
      });
    await run({ fixture, store, importRecords });
  } finally {
    store.close();
    fixture.close();
  }
}

function stableSummary(store) {
  const summary = structuredClone(store.summarize(FILTERS));
  delete summary.generatedAt;
  delete summary.perf.indexedAt;
  delete summary.perf.meta.indexedAt;
  return summary;
}

test("Codex explicit timing arrival publishes only measured requests and preserves native usage", async () => {
  await withStore(async ({ fixture, store, importRecords }) => {
    const before = stableSummary(store);
    assert.equal(before.perf.coverage.eligible, fixture.expected.n);
    assert.equal(before.perf.coverage.sampled, 0);
    importRecords(fixture.timingRecords.slice(0, -2));
    assert.deepEqual(stableSummary(store), before, "evidence import alone does not publish performance");
    assert.notEqual(store.perfPublicationState().timingRevision, "");
    await store.sync();
    const partial = stableSummary(store);
    assert.equal(partial.perf.coverage.sampled, fixture.expected.n - 2);
    assert.deepEqual(partial.totals, before.totals);
    importRecords(fixture.timingRecords.slice(-2));
    await store.sync();
    const complete = stableSummary(store);
    assert.equal(complete.perf.coverage.sampled, fixture.expected.n);
    assert.equal(complete.perf.models[0].averageTps, fixture.expected.tps.pooled);
    assert.deepEqual(complete.totals, before.totals);
    assert.notEqual(complete.perf.indexVersion, partial.perf.indexVersion);
    assert.equal(store.perfPublicationState().timingRevision, "");
    assert.equal(store.requestTimingDirtyThreadCount(), 0);
    assert.equal(importRecords(fixture.timingRecords).changed, false);
    await store.sync();
    assert.deepEqual(stableSummary(store), complete);
  });
});

test("Codex timing import rollback preserves the published result and retries the same evidence", async () => {
  await withStore(async ({ fixture, store, importRecords }) => {
    const before = stableSummary(store);
    const revision = store.perfPublicationState();
    store.database.exec(`CREATE TEMP TRIGGER reject_timing BEFORE INSERT ON perf_request_timing_evidence
      BEGIN SELECT RAISE(FAIL, 'injected timing import failure'); END`);
    assert.throws(() => importRecords(fixture.timingRecords), /injected timing import failure/);
    assert.deepEqual(stableSummary(store), before);
    assert.deepEqual(store.perfPublicationState(), revision);
    assert.equal(store.requestTimingDirtyThreadCount(), 0);
    assert.equal(Number(store.database.prepare("SELECT COUNT(*) AS n FROM perf_request_timing_evidence").get().n), 0);
    store.database.exec("DROP TRIGGER reject_timing");
    assert.equal(importRecords(fixture.timingRecords).changed, true);
    await store.sync();
    const recovered = stableSummary(store);
    assert.equal(recovered.perf.coverage.sampled, fixture.expected.n);
    assert.deepEqual(recovered.totals, before.totals);
    assert.notEqual(recovered.perf.indexVersion, before.perf.indexVersion);
  });
});
