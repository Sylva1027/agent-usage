import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { UsageStore } from "../src/usage-store.js";

const NOW = "2026-10-26T12:00:00.000Z";
const RANGE = {
  preset: "custom",
  start: new Date("2026-07-12T00:00:00.000Z"),
  end: new Date("2026-07-12T23:59:59.999Z"),
  calendarZone: "utc",
};
const FILTERS = { preset: "all", bucket: "day", calendarZone: "utc", now: NOW };
const EVENT_FIELDS = [
  "cacheWriteKnown",
  "cacheWriteTokens",
  "channel",
  "contextLevel",
  "detailMask",
  "homeId",
  "homeLabel",
  "model",
  "priceVersion",
  "project",
  "requestInputTokens",
  "serviceTier",
  "sessionId",
  "sourceKind",
  "sourcePath",
  "timestamp",
  "total",
];
const USAGE_FIELDS = ["cached", "input", "output", "reasoning", "total"];
const HOMES = [
  { id: "home-codex", label: "Codex", path: "/fixture/home-codex", kind: "codex" },
  { id: "home-zcode", label: "ZCode", path: "/fixture/home-zcode", kind: "zcode" },
  { id: "home-other", label: "Other", path: "/fixture/home-other", kind: "other" },
];
const ROWS = [
  {
    source_path: "/fixture/codex.jsonl",
    timestamp_ms: Date.parse("2026-07-12T02:00:00.000Z"),
    session_id: "tiered",
    home_id: "home-codex",
    home_label: "Codex",
    channel: "CLI",
    project: "alpha",
    model: "gpt-6.1-sol",
    hour_key: "2026-07-12 02",
    day_key: "2026-07-12",
    week_key: "2026-07-06",
    month_key: "2026-07",
    detail_mask: 31,
    cache_write_tokens: 0,
    cache_write_known: 1,
    request_input_tokens: 100,
    context_level: "long",
    service_tier: "standard",
    price_version: "fixture-a",
    total: 110,
    input: 100,
    cached: 20,
    output: 10,
    reasoning: 0,
  },
  {
    source_path: "/fixture/zcode.jsonl",
    timestamp_ms: Date.parse("2026-07-12T03:00:00.000Z"),
    session_id: "negative",
    home_id: "home-zcode",
    home_label: "ZCode",
    channel: "ZCode",
    project: "beta",
    model: "glm-4.7",
    hour_key: "2026-07-12 03",
    day_key: "2026-07-12",
    week_key: "2026-07-06",
    month_key: "2026-07",
    detail_mask: 0,
    cache_write_tokens: -3,
    cache_write_known: 0,
    request_input_tokens: -2,
    context_level: "unknown",
    service_tier: "mystery",
    price_version: "fixture-b",
    total: -11,
    input: -10,
    cached: 0,
    output: -1,
    reasoning: 0,
  },
  {
    source_path: "/fixture/other.jsonl",
    timestamp_ms: Date.parse("2026-07-12T04:00:00.000Z"),
    session_id: "zeros",
    home_id: "home-other",
    home_label: "Other",
    channel: "Other",
    project: "gamma",
    model: "unknown-model",
    hour_key: "2026-07-12 04",
    day_key: "2026-07-12",
    week_key: "2026-07-06",
    month_key: "2026-07",
    detail_mask: 0,
    cache_write_tokens: 0,
    cache_write_known: 0,
    request_input_tokens: 0,
    context_level: "unknown",
    service_tier: "unknown",
    price_version: "",
    total: 0,
    input: 0,
    cached: 0,
    output: 0,
    reasoning: 0,
  },
];
const EXPECTED_EVENTS = [
  {
    timestamp: Date.parse("2026-07-12T02:00:00.000Z"),
    sessionId: "tiered",
    homeId: "home-codex",
    homeLabel: "Codex",
    sourcePath: "/fixture/codex.jsonl",
    sourceKind: "codex",
    channel: "CLI",
    model: "gpt-6.1-sol",
    project: "alpha",
    detailMask: 31,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    requestInputTokens: 100,
    contextLevel: "long",
    serviceTier: "fast",
    priceVersion: "fixture-a",
    total: { total: 110, input: 100, cached: 20, output: 10, reasoning: 0 },
  },
  {
    timestamp: Date.parse("2026-07-12T03:00:00.000Z"),
    sessionId: "negative",
    homeId: "home-zcode",
    homeLabel: "ZCode",
    sourcePath: "/fixture/zcode.jsonl",
    sourceKind: "zcode",
    channel: "ZCode",
    model: "glm-4.7",
    project: "beta",
    detailMask: 0,
    cacheWriteTokens: -3,
    cacheWriteKnown: false,
    requestInputTokens: -2,
    contextLevel: "unknown",
    serviceTier: "mystery",
    priceVersion: "fixture-b",
    total: { total: -11, input: -10, cached: 0, output: -1, reasoning: 0 },
  },
  {
    timestamp: Date.parse("2026-07-12T04:00:00.000Z"),
    sessionId: "zeros",
    homeId: "home-other",
    homeLabel: "Other",
    sourcePath: "/fixture/other.jsonl",
    sourceKind: "other",
    channel: "Other",
    model: "unknown-model",
    project: "gamma",
    detailMask: 0,
    cacheWriteTokens: 0,
    cacheWriteKnown: false,
    requestInputTokens: 0,
    contextLevel: "unknown",
    serviceTier: "unknown",
    priceVersion: "",
    total: { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 },
  },
];

function insertSource(store, sourcePath, kind, homeId, homeLabel) {
  store.database
    .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(sourcePath, kind, homeId, homeLabel, `/fixture/${homeId}`, 1, 1, NOW);
}

function insertEvent(store, row) {
  const columns = Object.keys(row);
  store.database
    .prepare(`INSERT INTO events (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...columns.map((column) => row[column]));
}

function instrumentCostStatement(store, mode) {
  const originalPrepare = store.database.prepare;
  const seen = [];
  let setReturnArraysCalled = false;
  store.database.prepare = function (sql) {
    const statement = originalPrepare.call(this, sql);
    if (!sql.startsWith("SELECT timestamp_ms, session_id, home_id")) return statement;
    return new Proxy(statement, {
      get(target, property) {
        if (property === "setReturnArrays") {
          if (mode === "missing") return undefined;
          if (typeof target.setReturnArrays !== "function") return undefined;
          return (enabled) => {
            setReturnArraysCalled = true;
            return target.setReturnArrays(enabled);
          };
        }
        if (property === "iterate") {
          return (...args) => {
            const iterator = target.iterate(...args);
            return (function* () {
              for (const row of iterator) {
                seen.push(Array.isArray(row));
                yield row;
              }
            })();
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return {
    seen,
    get setReturnArraysCalled() {
      return setReturnArraysCalled;
    },
    restore() {
      store.database.prepare = originalPrepare;
    },
  };
}

function readEvents(store, mode, includeRepositories = false) {
  const probe = instrumentCostStatement(store, mode);
  try {
    return { events: [...store.costEventsForRange(RANGE, [], includeRepositories)], probe };
  } finally {
    probe.restore();
  }
}

function summarize(store, mode) {
  store.summaryProjectionCache = null;
  store.eventCostMemo.clear("cost-row-arrays-test");
  const probe = instrumentCostStatement(store, mode);
  try {
    return { summary: store.summarize(FILTERS), probe };
  } finally {
    probe.restore();
  }
}

test("cost row arrays preserve the named-row contract and full summary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cost-row-arrays-"));
  const store = new UsageStore({ homeDir: root, databaseFile: path.join(root, "usage-index.sqlite") });
  try {
    await store.open();
    const supportsReturnArrays = typeof store.database.prepare("SELECT 1 AS one").setReturnArrays === "function";
    if (Number(process.versions.node.split(".")[0]) >= 24) {
      assert.equal(supportsReturnArrays, true, "Node 24 must expose StatementSync.setReturnArrays");
    }
    for (const home of HOMES) {
      insertSource(store, `/fixture/${home.kind}.jsonl`, home.kind, home.id, home.label);
    }
    for (const row of ROWS) insertEvent(store, row);
    store.homes = HOMES;
    store.generatedAt = NOW;
    store.warnings = [];
    store.serviceTierEvidence = {
      resolve(sessionId, _timestamp, stored) {
        return sessionId === "tiered" ? "fast" : stored;
      },
    };
    store.serviceTierEvidenceInput = "fixture-tier-signature";

    const objectRead = readEvents(store, "missing");
    assert.equal(objectRead.probe.setReturnArraysCalled, false);
    assert.deepEqual(objectRead.probe.seen, [false, false, false]);
    assert.deepEqual(objectRead.events, EXPECTED_EVENTS, "object oracle must cover every selected column");
    const repositories = readEvents(store, "missing", true);
    assert.deepEqual(
      repositories.events,
      EXPECTED_EVENTS.map((event) => ({
        ...event,
        repositoryKey: "unknown:cwd",
        repositoryPath: "Unknown cwd",
        repositoryKind: "unknown",
        cwd: "",
        reconciliationGap: 0,
      })),
    );
    assert.deepEqual(readEvents(store, "native", true).events, repositories.events);

    if (supportsReturnArrays) {
      const arrayRead = readEvents(store, "native");
      assert.equal(arrayRead.probe.setReturnArraysCalled, true);
      assert.deepEqual(arrayRead.probe.seen, [true, true, true]);
      assert.deepEqual(arrayRead.events, objectRead.events, "native arrays must equal the object oracle");
      for (const event of arrayRead.events) {
        assert.deepEqual(Object.keys(event).sort(), EVENT_FIELDS);
        assert.deepEqual(Object.keys(event.total).sort(), USAGE_FIELDS);
      }
      assert.equal(arrayRead.events[0].serviceTier, "fast");
      assert.equal(arrayRead.events[1].total.total, -11);
      assert.equal(arrayRead.events[2].total.total, 0);
    } else {
      const fallbackRead = readEvents(store, "native");
      assert.equal(fallbackRead.probe.setReturnArraysCalled, false);
      assert.deepEqual(fallbackRead.probe.seen, [false, false, false]);
      assert.deepEqual(fallbackRead.events, objectRead.events, "old runtimes must retain the object path");
    }

    const objectSummary = summarize(store, "missing");
    assert.equal(objectSummary.probe.setReturnArraysCalled, false);
    assert.ok(objectSummary.probe.seen.length > 0 && objectSummary.probe.seen.every((value) => value === false));
    if (supportsReturnArrays) {
      const arraySummary = summarize(store, "native");
      assert.equal(arraySummary.probe.setReturnArraysCalled, true);
      assert.ok(arraySummary.probe.seen.length > 0 && arraySummary.probe.seen.every(Boolean));
      assert.deepEqual(arraySummary.summary, objectSummary.summary, "full summary must be unchanged");
    } else {
      const fallbackSummary = summarize(store, "native");
      assert.equal(fallbackSummary.probe.setReturnArraysCalled, false);
      assert.ok(fallbackSummary.probe.seen.length > 0 && fallbackSummary.probe.seen.every((value) => value === false));
      assert.deepEqual(fallbackSummary.summary, objectSummary.summary, "old runtime summary must be unchanged");
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
