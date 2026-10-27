import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHistoryArchiveCandidate } from "../src/history-archive.js";
import { getPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { UsageStore } from "../src/usage-store.js";

const NOW = "2026-07-12T12:00:00.000Z";
const SOURCES = [
  { id: "a", kind: "main", label: "Same Home" },
  { id: "b", kind: "zcode", label: "Same Home" },
  { id: "c", kind: "claude", label: "第三家" },
];

function insertEvent(
  store,
  {
    home = "a",
    day = "2026-07-12",
    total = 100,
    model = "gpt-6-sol",
    project = "/work/Alpha",
    session = "shared",
  } = {},
) {
  const source = SOURCES.find((candidate) => candidate.id === home);
  const row = {
    source_path: `/fixture/${home}`,
    timestamp_ms: Date.parse(`${day}T02:00:00.000Z`),
    session_id: session,
    home_id: home,
    home_label: source.label,
    channel: "CLI",
    project,
    cwd: project,
    model,
    hour_key: `${day} 02`,
    day_key: day,
    week_key: day < "2026-07-06" ? "2026-06-29" : "2026-07-06",
    month_key: day.slice(0, 7),
    detail_mask: 31,
    cache_write_tokens: 0,
    cache_write_known: 1,
    request_input_tokens: 0,
    context_level: "short",
    service_tier: "standard",
    price_version: "fixture",
    total,
    input: total - 1,
    cached: 0,
    output: 1,
    reasoning: 0,
  };
  const columns = Object.keys(row);
  store.database
    .prepare(`INSERT INTO events (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...Object.values(row));
}

async function fixture(action, { seed = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "incremental-query-projection-"));
  const store = new UsageStore({ homeDir: root, databaseFile: path.join(root, "usage.sqlite"), importDirs: [] });
  try {
    await store.open();
    for (const source of SOURCES) {
      store.database
        .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(`/fixture/${source.id}`, source.kind, source.id, source.label, `/fixture/home-${source.id}`, 1, 1, NOW);
    }
    store.homes = SOURCES.map((source) => ({
      id: source.id,
      kind: source.kind,
      label: source.label,
      path: `/fixture/home-${source.id}`,
    }));
    store.generatedAt = NOW;
    if (seed) {
      for (const row of [
        { home: "b", day: "2026-06-30", total: 40, model: "gpt-6-nova", project: "/work/项目甲" },
        { day: "2026-07-06", total: 17 },
        {},
        { total: 30, model: "Q1-Mapped-Model", project: "/work/Beta" },
        { home: "b", total: 200, model: "gpt-6-nova", project: "/work/项目甲" },
        { home: "c", total: 300, project: "/work/项目乙", session: "third" },
      ])
        insertEvent(store, row);
    }
    store.commitStoreRevision("q1-fixture");
    await action(store, root);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

// The established write-depth gate provides the unchanged SQL grouping reference.
function compareWithSql(store, filters, includeDetails = true) {
  const calls = [];
  const groupedRange = store.groupedRange;
  store.groupedRange = function (column, ...args) {
    calls.push(column);
    return groupedRange.call(this, column, ...args);
  };
  try {
    const actual = store.summarize({ now: NOW, calendarZone: "utc", bucket: "day", ...filters }, { includeDetails });
    const fusedCalls = [...calls];
    calls.length = 0;
    store.writeTransactionDepth += 1;
    let expected;
    try {
      expected = store.summarize({ now: NOW, calendarZone: "utc", bucket: "day", ...filters }, { includeDetails });
    } finally {
      store.writeTransactionDepth -= 1;
    }
    assert.deepEqual(actual, expected, "every summary field must match the SQL grouping reference");
    assert.deepEqual(calls, includeDetails ? ["channel", "model", "home_label", "project"] : ["channel", "model"]);
    return { actual, fusedCalls };
  } finally {
    store.groupedRange = groupedRange;
  }
}

test("Q1: timeline grouping preserves complete summaries across scope, dates, details and pricing", async () => {
  const originalCatalog = getPricingCatalog();
  try {
    await fixture(async (store) => {
      const first = compareWithSql(store, { preset: "month" });
      assert.deepEqual(first.fusedCalls, [], "untied month dimensions must share the existing timeline scan");
      assert.equal(first.actual.totals.total, 647);
      const cases = [
        [{ preset: "today" }, true],
        [{ preset: "today", excludeHomes: ["c"] }, false],
        [{ preset: "week", calendarZone: "local", excludeHomes: ["c", "c"] }, true],
        [{ preset: "month", calendarZone: "local", excludeHomes: ["a"] }, false],
        [{ preset: "custom", startDate: "2026-07-06", endDate: "2026-07-12" }, true],
        [{ preset: "all" }, false],
      ];
      for (const [filters, details] of cases) compareWithSql(store, filters, details);

      const catalog = structuredClone(originalCatalog);
      catalog.models["gpt-6-sol"].short.input *= 4;
      catalog.usdToCnyRate *= 2;
      catalog.models["q1-mapped-model"] = structuredClone(catalog.models["gpt-6-sol"]);
      setPricingCatalog(catalog);
      const repriced = compareWithSql(store, { preset: "month" }).actual;
      assert.ok(repriced.costEstimate.totalUsd > first.actual.costEstimate.totalUsd);
      assert.ok(repriced.models.some((row) => row.key === "q1-mapped-model"));
      for (const [filters, details] of cases) compareWithSql(store, filters, details);

      insertEvent(store, { total: 7, session: "new-session" });
      store.commitStoreRevision("q1-new-event");
      assert.equal(compareWithSql(store, { preset: "month" }).actual.totals.total, 654);
    });
  } finally {
    setPricingCatalog(originalCatalog);
  }
});

test("Q1: tied dimensions retain SQLite ordering and per-dimension SQL fallback", async () => {
  await fixture(
    async (store) => {
      insertEvent(store, { project: "/work/\u{10000}", model: "Tie-A" });
      insertEvent(store, { home: "b", project: "/work/\ue000", model: "Tie-B" });
      store.commitStoreRevision("q1-ties");
      const { actual, fusedCalls } = compareWithSql(store, { preset: "month" });
      assert.deepEqual(fusedCalls, ["channel", "model", "project"]);
      assert.equal(actual.homes.length, 1, "the untied home dimension remains fused");
    },
    { seed: false },
  );
});

test("Q1: an actual cold archive keeps the unverified SQL gate and complete carrier summaries", async () => {
  await fixture(async (store, root) => {
    const filters = { preset: "month", now: NOW, bucket: "day", calendarZone: "utc" };
    const expected = compareWithSql(store, filters, false).actual;
    const candidate = path.join(root, "cold.sqlite");
    const hotStart = Date.parse("2026-07-10T00:00:00.000Z");
    await createHistoryArchiveCandidate(store.database, candidate, {
      startMs: Date.parse("2026-06-01T00:00:00.000Z"),
      endMs: hotStart,
    });
    const registered = await store.registerHistoryArchiveCandidate(candidate);
    store.database.exec("BEGIN IMMEDIATE");
    try {
      store.writeMeta(
        "history_archive_event_authority",
        JSON.stringify({ formatVersion: 1, segmentIds: [registered.segmentId] }),
      );
      store.database.prepare("DELETE FROM events WHERE timestamp_ms < ?").run(hotStart);
      store.database.exec("COMMIT");
    } catch (error) {
      store.database.exec("ROLLBACK");
      throw error;
    }
    store.commitStoreRevision("q1-cold-authority");
    assert.equal(Number(store.database.prepare("SELECT COUNT(*) AS n FROM archive_segments").get().n), 1);
    assert.ok(!store.verifiedHistorySqlRead, "this store has not activated the verified SQL union reader");
    assert.deepEqual(
      compareWithSql(store, filters, false).fusedCalls,
      ["channel", "model"],
      "authority on an unverified SQL reader must keep both grouping queries",
    );
    assert.equal(store.summaryProjectionCache, null, "month must not create an all projection slot");
    const timelineRange = store.timelineRange;
    store.timelineRange = () => {
      throw new Error("unverified cold month must use the complete carrier");
    };
    try {
      assert.deepEqual(await store.summarizeHistory(filters, { includeDetails: false }), expected);
    } finally {
      store.timelineRange = timelineRange;
    }
  });
});
