import assert from "node:assert/strict";
import test from "node:test";

import { buildTimelineRows } from "../public/timeline-utils.js";
import { HISTORY_QUOTE_INPUT_MAX_BYTES, HistoryQuoteInputs } from "../src/history-quote-inputs.js";
import { estimateCostForEvents, estimateEventCost, getPricingCatalog, runWithPricingCatalog } from "../src/pricing.js";

function event(index) {
  return {
    timestamp: Date.parse("2026-07-12T02:00:00Z") + (index % 48) * 3_600_000,
    sessionId: `session-${index % 17}`,
    channel: index % 3 ? "CLI" : "ZCode",
    model: ["gpt-6-sol", "glm-4.7", "claude-opus-5-5", "unknown-model", "gpt-6-sol-free", "   "][index % 6],
    sourceKind: index % 2 ? "main" : undefined,
    detailMask: 47,
    cacheWriteTokens: index % 4 ? 3 : -0,
    cacheWriteKnown: index % 3 !== 0,
    cacheWriteTtl: [undefined, null, "5m", "1h"][index % 4],
    requestInputTokens: index % 2 ? 272_001 : 10_000,
    contextLevel: index % 2 ? "unknown" : "short",
    serviceTier: ["standard", "fast", "unknown"][index % 3],
    total: { total: 10_500, input: 10_000, cached: index % 97, output: 500, reasoning: index % 5 },
  };
}

test("compact quote inputs replay original quotes, order, and bucket costs across chunks after real repricing", () => {
  const events = Array.from({ length: 16_385 }, (_, index) => event(index));
  const buffer = new HistoryQuoteInputs();
  const range = { preset: "all", calendarZone: "utc" };
  const first = buildTimelineRows(events, range, "day", {
    estimateCost: estimateEventCost,
    onEstimate(item, _estimate, key) {
      buffer.append(item, key);
    },
  });
  assert.equal(buffer.finish(), buffer);
  assert.equal(buffer.length, events.length);
  assert.ok(buffer.bytes < HISTORY_QUOTE_INPUT_MAX_BYTES);
  let index = 0;
  for (const item of buffer.events()) {
    const original = events[index++];
    assert.deepEqual(estimateEventCost(item), estimateEventCost(original));
    for (const field of [
      "timestamp",
      "model",
      "channel",
      "sourceKind",
      "detailMask",
      "cacheWriteTokens",
      "cacheWriteKnown",
      "cacheWriteTtl",
      "requestInputTokens",
      "contextLevel",
      "serviceTier",
    ]) {
      assert.ok(Object.is(item[field], original[field]), field);
    }
  }
  const changed = getPricingCatalog();
  changed.version += "-compact-replay";
  changed.models["gpt-6-sol"].short.input *= 3;
  changed.models["gpt-6-sol"].currency = "CNY";
  changed.models["glm-4.7"].outputThreshold = 1000;
  changed.models["claude-opus-5-5"].short.cacheWrite *= 2;
  runWithPricingCatalog(changed, () => {
    assert.deepEqual(estimateCostForEvents(buffer.events()), estimateCostForEvents(events));
    assert.deepEqual(
      buildTimelineRows(buffer.events(), range, "day", {
        estimateCost: estimateEventCost,
        factRows: first,
        eventBucketKey: (item) => item.quoteBucketKey,
      }),
      buildTimelineRows(events, range, "day", { estimateCost: estimateEventCost }),
    );
  });
});

test("budget exhaustion and unsupported inputs discard the whole prefix without interrupting full pricing", () => {
  const events = Array.from({ length: 32 }, (_, index) => event(index));
  const budget = new HistoryQuoteInputs(1024);
  const observed = [];
  buildTimelineRows(events, { preset: "all", calendarZone: "utc" }, "day", {
    estimateCost: estimateEventCost,
    onEstimate(item, estimate, key) {
      budget.append(item, key);
      observed.push(estimate);
    },
  });
  assert.equal(budget.finish(), null);
  assert.equal(budget.length, 0);
  assert.equal(budget.chunks.length, 0);
  assert.deepEqual(observed, events.map(estimateEventCost));
  assert.throws(() => [...budget.events()], /not complete/);
  const partial = new HistoryQuoteInputs(2_000_000);
  partial.append(events[0], "2026-07-12");
  assert.equal(partial.length, 1);
  const largeNames = events.map((item, index) => ({ ...item, model: `unique-${index}-${"x".repeat(8000)}` }));
  const complete = [];
  buildTimelineRows(largeNames, { preset: "all", calendarZone: "utc" }, "day", {
    estimateCost: estimateEventCost,
    onEstimate(item, estimate, key) {
      partial.append(item, key);
      complete.push(estimate);
    },
  });
  assert.equal(partial.finish(), null);
  assert.equal(partial.length, 0, "an exhausted dictionary discards its previously retained prefix");
  assert.equal(partial.chunks.length, 0);
  assert.deepEqual(complete, largeNames.map(estimateEventCost));
  const interrupted = new HistoryQuoteInputs();
  interrupted.append(events[0], "2026-07-12");
  assert.equal(interrupted.length, 1);
  interrupted.append({ ...events[1], detailMask: 256 }, "2026-07-12");
  assert.equal(interrupted.finish(), null);
  assert.equal(interrupted.chunks.length, 0);
});
