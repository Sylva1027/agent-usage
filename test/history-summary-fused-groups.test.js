import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { UsageStore } from "../src/usage-store.js";

const NOW = "2026-10-26T12:00:00.000Z";
const FILTERS = { preset: "all", bucket: "day", calendarZone: "utc", now: NOW };

function event(overrides = {}) {
  return {
    source_path: "/fixture/main.jsonl",
    timestamp_ms: Date.parse("2026-10-01T02:00:00.000Z"),
    session_id: "session-a",
    home_id: "home-a",
    home_label: "Alpha Home",
    channel: "Mystery Channel",
    project: "Alpha",
    model: "gpt-6-sol",
    hour_key: "2026-10-01 02",
    day_key: "2026-10-01",
    week_key: "2026-09-28",
    month_key: "2026-10",
    detail_mask: 31,
    cache_write_tokens: 0,
    cache_write_known: 1,
    request_input_tokens: 0,
    context_level: "short",
    service_tier: "standard",
    price_version: "fixture",
    total: 100,
    input: 80,
    cached: 0,
    output: 20,
    reasoning: 0,
    ...overrides,
  };
}

function insertEvent(store, row) {
  const columns = Object.keys(row);
  store.database
    .prepare(`INSERT INTO events (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...Object.values(row));
}

function insertSource(store, source) {
  store.database
    .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(source.path, source.kind, source.homeId, source.homeLabel, `/fixture/${source.homeId}`, 1, 1, NOW);
}

function resolvedSummaryRange(range) {
  return {
    ...range,
    start: new Date(range.start),
    end: new Date(range.end),
  };
}

async function closeStore(store) {
  if (!store) return;
  try {
    store.database?.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    store.close();
  }
}

test("fused groups match SQL for source kind, exclusion, and sessions; ties and unavailable fusion fall back", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fused-summary-groups-"));
  const store = new UsageStore({ homeDir: root, databaseFile: path.join(root, "usage-index.sqlite") });
  try {
    await store.open();
    for (const source of [
      { path: "/fixture/main.jsonl", kind: "main", homeId: "home-a", homeLabel: "Same Home" },
      { path: "/fixture/zcode.jsonl", kind: "zcode", homeId: "home-b", homeLabel: "Same Home" },
      { path: "/fixture/claude.jsonl", kind: "claude", homeId: "home-c", homeLabel: "Other Home" },
      { path: "/fixture/opencode.jsonl", kind: "opencode", homeId: "home-excluded", homeLabel: "Excluded Home" },
    ]) {
      insertSource(store, source);
    }
    for (const row of [
      event({
        session_id: "codex-a",
        source_path: "/fixture/main.jsonl",
        home_label: "Same Home",
        project: "Alpha",
        total: 100,
      }),
      event({
        session_id: "codex-b",
        source_path: "/fixture/main.jsonl",
        home_label: "Same Home",
        project: "Beta",
        model: "gpt-6-nova",
        timestamp_ms: Date.parse("2026-10-01T03:00:00.000Z"),
        total: 20,
        input: 16,
        output: 4,
      }),
      event({
        session_id: "zcode-a",
        source_path: "/fixture/zcode.jsonl",
        home_id: "home-b",
        home_label: "Same Home",
        project: "项目甲",
        model: "gpt-6-luna",
        timestamp_ms: Date.parse("2026-10-01T04:00:00.000Z"),
        total: 200,
      }),
      event({
        session_id: "claude-a",
        source_path: "/fixture/claude.jsonl",
        home_id: "home-c",
        home_label: "Other Home",
        project: "项目乙",
        model: "gpt-6-terra",
        timestamp_ms: Date.parse("2026-10-01T05:00:00.000Z"),
        total: 300,
      }),
      event({
        session_id: "excluded-a",
        source_path: "/fixture/opencode.jsonl",
        home_id: "home-excluded",
        home_label: "Excluded Home",
        project: "Excluded",
        timestamp_ms: Date.parse("2026-10-01T06:00:00.000Z"),
        total: 400,
      }),
    ]) {
      insertEvent(store, row);
    }
    store.commitStoreRevision("fixture");

    const groupedCalls = [];
    const sqlGroupedRange = store.groupedRange.bind(store);
    store.groupedRange = (column, ...args) => {
      groupedCalls.push(column);
      return sqlGroupedRange(column, ...args);
    };

    const fused = store.summarize(FILTERS);
    assert.deepEqual(groupedCalls, [], "all-hot initial summary must use the fused groups");

    const range = resolvedSummaryRange(fused.range);
    assert.deepEqual(fused.channels, sqlGroupedRange("channel", range, "total DESC", []));
    assert.deepEqual(fused.models, sqlGroupedRange("model", range, "total DESC", []));
    assert.deepEqual(fused.homes, sqlGroupedRange("home_label", range, "total DESC", []));
    assert.deepEqual(fused.projects, sqlGroupedRange("project", range, "total DESC", []));

    assert.deepEqual(
      fused.channels.map((row) => row.key),
      ["OpenCode", "Claude", "ZCode", "Codex"],
    );
    assert.deepEqual(
      fused.channels.find((row) => row.key === "Codex"),
      {
        key: "Codex",
        name: "Codex",
        count: 2,
        sessions: 2,
        total: { total: 120, input: 96, cached: 0, output: 24, reasoning: 0 },
      },
    );
    assert.deepEqual(
      fused.projects.map((row) => row.key),
      ["Excluded", "项目乙", "项目甲", "Alpha", "Beta"],
    );
    assert.deepEqual(
      fused.models.map((row) => row.key),
      ["gpt-6-sol", "gpt-6-terra", "gpt-6-luna", "gpt-6-nova"],
    );
    assert.deepEqual(
      fused.homes.map((row) => row.key),
      ["Excluded Home", "Same Home", "Other Home"],
    );

    const excluded = ["home-excluded"];
    const fusedExcluded = store.summarize({ ...FILTERS, excludeHomes: excluded });
    assert.deepEqual(fusedExcluded.channels, sqlGroupedRange("channel", range, "total DESC", excluded));
    assert.deepEqual(fusedExcluded.models, sqlGroupedRange("model", range, "total DESC", excluded));
    assert.deepEqual(fusedExcluded.homes, sqlGroupedRange("home_label", range, "total DESC", excluded));
    assert.deepEqual(fusedExcluded.projects, sqlGroupedRange("project", range, "total DESC", excluded));
    assert.equal(
      fusedExcluded.channels.some((row) => row.key === "Excluded Home"),
      false,
    );
    assert.deepEqual(groupedCalls, [], "excluded all-hot summary must also use the fused groups");

    groupedCalls.length = 0;
    store.writeTransactionDepth = 1;
    try {
      const fallback = store.summarize(FILTERS);
      assert.deepEqual(fallback, fused, "old grouped SQL path must preserve the complete summary");
    } finally {
      store.writeTransactionDepth = 0;
    }
    assert.deepEqual(groupedCalls, ["channel", "model", "home_label", "project"]);

    insertEvent(
      store,
      event({
        session_id: "zcode-b",
        source_path: "/fixture/zcode.jsonl",
        home_id: "home-b",
        home_label: "Same Home",
        project: "项目甲",
        model: "gpt-6-luna",
        timestamp_ms: Date.parse("2026-10-01T06:00:00.000Z"),
        total: 100,
      }),
    );
    store.commitStoreRevision("tie");
    groupedCalls.length = 0;
    const tied = store.summarize(FILTERS);
    assert.deepEqual(groupedCalls, ["channel", "model", "project"]);
    assert.deepEqual(tied.channels, sqlGroupedRange("channel", range, "total DESC", []));
    assert.deepEqual(tied.models, sqlGroupedRange("model", range, "total DESC", []));
    assert.deepEqual(tied.homes, sqlGroupedRange("home_label", range, "total DESC", []));
    assert.deepEqual(tied.projects, sqlGroupedRange("project", range, "total DESC", []));
    assert.deepEqual(
      tied.projects.map((row) => row.key),
      ["Excluded", "项目乙", "项目甲", "Alpha", "Beta"],
    );

    t.diagnostic(
      JSON.stringify({
        sourceKindSemantics: fused.channels.map((row) => row.key),
        tiedChannels: tied.channels.map((row) => row.key),
        tiedModels: tied.models.map((row) => row.key),
        tiedProjects: tied.projects.map((row) => row.key),
        codexSessions: fused.channels.find((row) => row.key === "Codex")?.sessions,
        fallbackCalls: groupedCalls,
      }),
    );
  } finally {
    await closeStore(store);
    await rm(root, { recursive: true, force: true });
  }
});
