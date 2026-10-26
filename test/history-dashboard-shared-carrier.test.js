import assert from "node:assert/strict";
import { mkdtemp, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { UsageStore } from "../src/usage-store.js";
import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { createUsageServer } from "../src/server.js";
import test from "node:test";
test("cold dashboard shares one verified carrier and preserves existing component contracts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ret-dashboard-carrier-"));
  const start = Date.parse("2026-01-02T03:04:05Z");
  const file = path.join(dir, "usage.sqlite"),
    segment = path.join(dir, "segment.sqlite");
  const options = { homeDir: dir, databaseFile: file, env: {}, importDirs: [], pricingRefreshSchedulerEnabled: false };
  const store = new UsageStore(options);
  let server;
  const filters = { preset: "all", bucket: "day", calendarZone: "utc", now: new Date("2026-01-03T12:00:00Z") };
  let calls = 0;
  try {
    await store.open();
    store.database
      .prepare("INSERT INTO source_files VALUES(?,?,?,?,?,?,?,?)")
      .run("/fixture/source", "codex", "h", "Home", "/fixture/home", 1, 1, "now");
    for (const [offset, total] of [
      [0, 100],
      [60000, 30],
    ])
      store.database
        .prepare(
          `INSERT INTO events(source_path,timestamp_ms,session_id,home_id,home_label,channel,project,model,hour_key,day_key,week_key,month_key,total,input,cached,output,reasoning) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          "/fixture/source",
          start + offset,
          "session",
          "h",
          "Home",
          "CLI",
          "fixture",
          "gpt-6-sol",
          "2026-01-02 03",
          "2026-01-02",
          "2025-12-29",
          "2026-01",
          total,
          total,
          0,
          0,
          0,
        );
    store.homes = [{ id: "h", label: "Home", path: "/fixture/home", kind: "codex" }];
    store.generatedAt = "2026-01-03T00:00:00Z";
    const original = store.historyArchiveEventUnionForRange;
    store.historyArchiveEventUnionForRange = function (...args) {
      calls++;
      return original.apply(this, args);
    };
    const hot = await store.dashboardHistory(filters);
    assert.equal(hot.summary.totals.total, 130);
    assert.equal(calls, 0, "all-hot retains existing SQL path");
    await createHistoryArchiveCandidate(store.database, segment, { startMs: start, endMs: start + 60000 });
    const plan = await prepareHistoryArchiveCommit(store.database, segment);
    await store.commitHistoryArchiveEvents(plan);
    const individual = {
      summary: await store.summarizeHistory(filters),
      metadata: await store.metadataHistory(filters.now),
      periodComparison: await store.periodComparisonHistory({ now: filters.now, calendarZone: "utc" }),
    };
    assert.equal(calls, 3, "baseline separately decodes cold union three times");
    calls = 0;
    const combined = await store.dashboardHistory(filters);
    assert.equal(
      calls,
      store.database.isTransaction === false ? 0 : 1,
      "SQL-capable readers avoid the full carrier; older Node retains it",
    );
    assert.deepEqual(combined, individual, "all fields incl complete cost/perf/metadata/period must be unchanged");
    const noNow = await store.dashboardHistory({ preset: "all", calendarZone: "utc" });
    assert.equal(noNow.summary.totals.total, 130);
    assert.equal(noNow.metadata.eventCount, 2);
    assert(Number.isFinite(Date.parse(noNow.metadata.modelUsageAsOf)), "omitted now retains the metadata default");
    const excludedFilters = { ...filters, excludeHomes: ["h"] };
    const excluded = await store.dashboardHistory(excludedFilters);
    assert.deepEqual(excluded, {
      summary: await store.summarizeHistory(excludedFilters),
      metadata: await store.metadataHistory(filters.now),
      periodComparison: await store.periodComparisonHistory({
        now: filters.now,
        calendarZone: "utc",
        excludeHomes: ["h"],
      }),
    });
    assert.equal(excluded.summary.totals.total, 0);
    assert.equal(excluded.metadata.eventCount, 2, "metadata inventory stays unfiltered");
    const weekFilters = { ...filters, preset: "week" };
    assert.deepEqual(await store.dashboardHistory(weekFilters, { includeDetails: false }), {
      summary: await store.summarizeHistory(weekFilters, { includeDetails: false }),
      metadata: await store.metadataHistory(filters.now),
      periodComparison: await store.periodComparisonHistory({ now: filters.now, calendarZone: "utc" }),
    });
    await rename(segment, `${segment}.moved`);
    await assert.rejects(store.dashboardHistory(filters), /ENOENT/);
    await rename(`${segment}.moved`, segment);
    assert.deepEqual(await store.dashboardHistory(filters), individual);
    store.close();
    server = createUsageServer(options);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}/api/summary?preset=all`;
    const response = await fetch(url);
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.summary.totals.total, 130);
    assert.equal(payload.metadata.eventCount, 2);
    await rename(segment, `${segment}.moved`);
    const missing = await fetch(`${url}&skipCheck=1`);
    assert.equal(missing.status, 500, "missing segment must not return cached/partial dashboard");
    await rename(`${segment}.moved`, segment);
    await server.close();
    server = null;
  } finally {
    if (server) await server.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
