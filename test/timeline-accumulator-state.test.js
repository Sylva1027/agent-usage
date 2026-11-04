import assert from "node:assert/strict";
import test from "node:test";

import { buildTimelineRows, createTimelineAccumulator } from "../public/timeline-utils.js";

const usage = (total) => ({
  total,
  input: total,
  cached: 0,
  output: 0,
  reasoning: 0,
});

const event = (timestamp, sessionId, channel = "CLI", model = "gpt-6-sol", total = 10) => ({
  timestamp,
  sessionId,
  channel,
  model,
  total: usage(total),
});

const estimate = (currency, totalUsd, pricingStatus = "unknown") => ({
  currency,
  totalUsd,
  pricedTokens: 0,
  unpricedTokens: 7,
  minimumEstimatedTokens: 5,
  serviceTierUnknownTokens: 3,
  contextUnknownTokens: 2,
  cacheWriteUnknownTokens: 1,
  pricingStatus,
  unpricedReasons: ["fast-pricing-unavailable-example"],
});

test("JSON snapshot roundtrip keeps mixed costs, member dedupe, sorting, and pure result", () => {
  const range = { calendarZone: "utc" };
  const accumulator = createTimelineAccumulator(range, "day");
  const later = event("2026-10-02T12:00:00.000Z", "shared", "CLI", "mystery-model", 20);
  const earlier = event("2026-10-01T12:00:00.000Z", "shared", "ZCode", "mystery-model", 10);
  accumulator.add(later, estimate("USD", 0.2));
  accumulator.add(earlier, estimate("CNY", 1.5, "unavailable"));

  const snapshot = accumulator.snapshot();
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('"events"'), false);
  const firstResult = accumulator.result();
  firstResult[0].total.total = 999;
  assert.deepEqual(accumulator.snapshot(), snapshot, "result materialization must not mutate accumulator state");

  const restored = createTimelineAccumulator(range, "day", {
    state: JSON.parse(serialized),
  });
  const repeated = event("2026-10-02T13:00:00.000Z", "shared", "CLI", "mystery-model", 5);
  accumulator.add(repeated, estimate("USD", 0.1));
  restored.add(repeated, estimate("USD", 0.1));
  assert.deepEqual(restored.result(), accumulator.result());

  const [octoberFirst, octoberSecond] = restored.result();
  assert.deepEqual([octoberFirst.key, octoberSecond.key], ["2026-10-01", "2026-10-02"]);
  assert.equal(octoberSecond.sessions, 1);
  const costs = restored.result().flatMap((row) => Object.values(row.costByModel));
  assert.deepEqual(costs.map((cost) => cost.currency).sort(), ["CNY", "USD"]);
  assert.ok(costs.every((cost) => cost.unpricedTokens > 0));
  assert.deepEqual(
    [...new Set(restored.result().flatMap((row) => row.scenarioReasons || []))],
    ["fast-pricing-unavailable-example"],
  );
});

test("snapshot omits empty slots and a range override only changes materialized boundaries", () => {
  const range = {
    preset: "custom",
    start: "2026-10-01T00:00:00.000Z",
    end: "2026-10-04T23:59:59.999Z",
    calendarZone: "utc",
  };
  const accumulator = createTimelineAccumulator(range, "day");
  accumulator.add(event("2026-10-01T12:00:00.000Z", "a", "CLI", "m1", 4));
  accumulator.add(event("2026-10-03T12:00:00.000Z", "b", "CLI", "m1", 6));
  const state = JSON.parse(JSON.stringify(accumulator.snapshot()));
  assert.equal(state.rows.length, 2);

  const restored = createTimelineAccumulator(range, "day", { state });
  assert.deepEqual(
    restored.result().map((row) => [row.key, row.total.total]),
    [
      ["2026-10-01", 4],
      ["2026-10-02", 0],
      ["2026-10-03", 6],
      ["2026-10-04", 0],
    ],
  );
  const beforeOverride = restored.snapshot();
  assert.deepEqual(
    restored.result({ ...range, end: "2026-10-05T23:59:59.999Z" }).map((row) => [row.key, row.total.total]),
    [
      ["2026-10-01", 4],
      ["2026-10-02", 0],
      ["2026-10-03", 6],
      ["2026-10-04", 0],
      ["2026-10-05", 0],
    ],
  );
  assert.deepEqual(restored.snapshot(), beforeOverride);
});

test("custom persistent member sets receive stable scopes and restore saved counts on demand", () => {
  const persisted = new Map();
  const createdScopes = [];
  const restoredCounts = [];
  let snapshotCalls = 0;
  const createSessionSet = (scope, savedCount) => {
    const key = JSON.stringify(scope);
    createdScopes.push(scope);
    if (!persisted.has(key)) persisted.set(key, new Set());
    const values = persisted.get(key);
    if (savedCount !== undefined) {
      restoredCounts.push([scope, savedCount]);
      assert.equal(savedCount, values.size);
    }
    return {
      add(value) {
        values.add(String(value));
        return this;
      },
      get size() {
        return values.size;
      },
    };
  };
  const snapshotSessionSet = (set) => {
    snapshotCalls += 1;
    return set.size;
  };
  const options = { createSessionSet, snapshotSessionSet };
  const accumulator = createTimelineAccumulator({ calendarZone: "utc" }, "day", options);
  accumulator.add(event("2026-10-01T12:00:00.000Z", "same"));
  assert.equal(snapshotCalls, 0);
  assert.equal(accumulator.result()[0].sessions, 1);

  const state = JSON.parse(JSON.stringify(accumulator.snapshot()));
  assert.ok(snapshotCalls > 0);
  const restored = createTimelineAccumulator({ calendarZone: "utc" }, "day", { ...options, state });
  restored.add(event("2026-10-01T13:00:00.000Z", "same"));
  assert.equal(restored.result()[0].sessions, 1);

  const expectedScopes = [
    ["2026-10-01", "sessions"],
    ["2026-10-01", "channel", "Codex"],
    ["2026-10-01", "model", "gpt-6-sol"],
  ];
  assert.deepEqual(
    new Set(createdScopes.map((scope) => JSON.stringify(scope))),
    new Set(expectedScopes.map(JSON.stringify)),
  );
  assert.deepEqual(
    restoredCounts.map(([, count]) => count),
    [1, 1, 1],
  );
});

test("buildTimelineRows matches the shared accumulator with facts and existing options", () => {
  const events = [
    event("2026-10-01T12:00:00.000Z", "a", "CLI", "gpt-6-sol", 10),
    event("2026-10-02T12:00:00.000Z", "b", "ZCode", "gpt-6-luna", 20),
  ];
  const range = {
    preset: "custom",
    start: "2026-10-01T00:00:00.000Z",
    end: "2026-10-03T23:59:59.999Z",
    calendarZone: "utc",
  };
  const factRows = [
    {
      key: "2026-10-01",
      count: 9,
      sessions: 2,
      total: usage(99),
      channels: [{ key: "fact", name: "fact", count: 9, sessions: 2, total: usage(99) }],
      models: [],
    },
  ];
  const buildOptions = () => ({
    factRows,
    estimateCost: (item) => ({ ...estimate("USD", item.total.total / 10), pricingStatus: "estimated" }),
  });

  const expected = buildTimelineRows(events, range, "day", buildOptions());
  const accumulator = createTimelineAccumulator(range, "day", buildOptions());
  for (const item of events) accumulator.add(item);
  assert.deepEqual(accumulator.result(), expected);
  assert.equal(expected[0].count, 9);
  assert.equal(expected[0].total.total, 99);
  assert.equal(expected[2].total.total, 0);
});

test("broken accumulator state is rejected", () => {
  assert.throws(
    () => createTimelineAccumulator({}, "day", { state: { version: 2, bucket: "day", rows: [] } }),
    (error) => error.code === "TIMELINE_STATE_INVALID" && /unsupported version/.test(error.message),
  );
  assert.throws(
    () => createTimelineAccumulator({}, "day", { state: { version: 1, bucket: "month", rows: [] } }),
    (error) => error.code === "TIMELINE_STATE_INVALID" && /bucket/.test(error.message),
  );
});
