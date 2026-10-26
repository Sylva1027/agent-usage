import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

const HOT_START_MS = Date.parse("2026-10-04T12:00:00.000Z");
const AUTHORITY_KEY = "history_archive_event_authority";

function writeAuthority(database, segmentId) {
  database
    .prepare("INSERT INTO store_meta (key, value) VALUES (?, ?)")
    .run(AUTHORITY_KEY, JSON.stringify({ formatVersion: 1, segmentIds: [segmentId] }));
}

test("prepared cold summary is synchronous and preserves async summary behavior", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const databaseFile = path.join(fixture.serverOptions.homeDir, "prepared-summary.sqlite");
  const candidateFile = path.join(fixture.serverOptions.homeDir, "prepared-cold.sqlite");
  const options = { ...fixture.serverOptions, databaseFile };
  const store = new UsageStore(options);
  try {
    await store.sync({ options });
    const firstMs = Number(store.database.prepare("SELECT MIN(timestamp_ms) AS value FROM events").get().value);
    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: firstMs,
      endMs: HOT_START_MS,
    });
    const registered = await store.registerHistoryArchiveCandidate(candidateFile);
    store.database.exec("BEGIN IMMEDIATE");
    try {
      writeAuthority(store.database, registered.segmentId);
      store.database.prepare("DELETE FROM events WHERE timestamp_ms < ?").run(HOT_START_MS);
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }

    const filters = {
      preset: "custom",
      startDate: "2026-10-03",
      endDate: "2026-10-04",
      now: "2026-10-04T13:00:00.000Z",
      calendarZone: "utc",
    };
    const report = await store.publishedHistoryUsageReport({ includePerfCarrier: true });
    const prepared = store.summarizeHistoryReport(report, filters);
    assert.equal(prepared instanceof Promise, false);
    assert.deepEqual(prepared, await store.summarizeHistory(filters));
    assert.ok(Object.keys(prepared.records).length > 0);
    assert.ok(prepared.perf.models.length > 0);

    const excludedFilters = { ...filters, excludeHomes: [report.homes[0].id] };
    const excluded = store.summarizeHistoryReport(report, excludedFilters);
    assert.deepEqual(excluded, await store.summarizeHistory(excludedFilters));
    assert.ok(excluded.eventCount < prepared.eventCount);

    const compact = store.summarizeHistoryReport(report, filters, { includeDetails: false });
    assert.equal(compact.homes, undefined);
    assert.equal(compact.projects, undefined);
    assert.equal(compact.repositories, undefined);
  } finally {
    store.close();
    fixture.close();
  }
});
