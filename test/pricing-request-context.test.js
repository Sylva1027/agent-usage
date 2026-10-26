import assert from "node:assert/strict";
import test from "node:test";

import { canonicalModelName } from "../public/pricing-models.js";
import { buildTimelineRows } from "../public/timeline-utils.js";
import {
  createCostEstimateAccumulator,
  createEventPricing,
  estimateCostForEvents,
  estimateEventCost,
  getPricingCatalog,
  runWithPricingCatalog,
} from "../src/pricing.js";

function event(model, extra = {}) {
  return {
    model,
    timestamp: Date.parse("2026-07-12T02:00:00Z"),
    sessionId: "pricing-request",
    channel: "CLI",
    detailMask: 47,
    total: { total: 10_500, input: 10_000, cached: 2_000, output: 500, reasoning: 100 },
    cacheWriteTokens: 1_000,
    cacheWriteKnown: true,
    cacheWriteTtl: "5m",
    requestInputTokens: 10_000,
    contextLevel: "short",
    serviceTier: "standard",
    ...extra,
  };
}

test("one request shares model interpretation while retaining complete original quotes and display names", () => {
  const models = getPricingCatalog().models;
  const events = [
    ...Object.keys(models).map((name) => event(name)),
    ...[" GPT-6-SOL ", "openai/gpt-6-sol", "gpt-6-sol-free", "unknown-model", "", "   ", null, 0].map((name) =>
      event(name),
    ),
    event("glm-4.7", { total: { total: 10_100, input: 10_000, cached: 0, output: 100 } }),
    event("gpt-6.1-sol", { requestInputTokens: 272_001, sourceKind: "main", serviceTier: "fast" }),
    event("claude-opus-5-5", { serviceTier: "fast", cacheWriteTtl: "1h" }),
    event("unknown-model", { channel: "ZCode", contextLevel: "unknown", serviceTier: "unknown" }),
    event("gpt-6-sol", { total: { total: 100, input: 90, cached: 80, output: 90 }, cacheWriteKnown: false }),
  ];
  const pricing = createEventPricing(models);
  const accumulator = createCostEstimateAccumulator({ modelName: pricing.costModelName });
  for (const item of events) {
    const estimate = pricing.estimate(item);
    assert.deepEqual(estimate, estimateEventCost(item), String(item.model));
    assert.equal(pricing.modelName(item.model), canonicalModelName(item.model, models));
    accumulator.add(item, estimate);
  }
  assert.deepEqual(accumulator.result(), estimateCostForEvents(events));
  const options = { pricingModels: models };
  const range = { preset: "all", calendarZone: "utc" };
  assert.deepEqual(
    buildTimelineRows(events, range, "day", {
      ...options,
      estimateCost: pricing.estimate,
      modelName: pricing.modelName,
    }),
    buildTimelineRows(events, range, "day", { ...options, estimateCost: estimateEventCost }),
  );
  assert.equal(pricing.modelName("   "), "", "display whitespace keeps its existing empty identity");
  assert.equal(pricing.estimate(event("   ")).model, "Unknown model", "quotes retain the existing unknown fallback");
  const displayModels = { ...models, "custom-request-model": models["gpt-6-sol"] };
  const custom = createEventPricing(displayModels);
  const routed = event("vendor/custom-request-model");
  assert.equal(custom.modelName(routed.model), "custom-request-model");
  assert.deepEqual(custom.estimate(routed), estimateEventCost(routed), "display catalog never changes quote rates");
});

test("request model dictionaries follow actual bound catalogs across async work and catalog replacement", async () => {
  const a = getPricingCatalog();
  const b = structuredClone(a);
  b.version += "-request-b";
  b.models["gpt-6-sol"].short.input *= 3;
  b.models["gpt-6-sol"].currency = "CNY";
  b.models["new-model"] = structuredClone(b.models["gpt-6-sol"]);
  const item = event("gpt-6-sol");
  const shared = createEventPricing();
  const before = runWithPricingCatalog(a, () => shared.estimate(item));
  const changed = runWithPricingCatalog(b, () => shared.estimate(item));
  assert.notDeepEqual(changed, before);
  assert.deepEqual(
    changed,
    runWithPricingCatalog(b, () => estimateEventCost(item)),
  );
  assert.deepEqual(
    runWithPricingCatalog(a, () => shared.estimate(item)),
    before,
  );
  const results = await Promise.all(
    [a, b].map((catalog) =>
      runWithPricingCatalog(catalog, async () => {
        const pricing = createEventPricing(catalog.models);
        const events = [item, event("new-model"), event("openai/gpt-6-sol")];
        const first = events.map(pricing.estimate);
        await Promise.resolve();
        assert.deepEqual(events.map(pricing.estimate), events.map(estimateEventCost));
        assert.deepEqual(events.map(pricing.estimate), first);
        return first;
      }),
    ),
  );
  assert.notDeepEqual(results[0], results[1]);
});

test("excess or long model names use complete streaming quotes after the small dictionary fills", () => {
  const pricing = createEventPricing();
  const names = [...Array.from({ length: 1030 }, (_, index) => `unknown-${index}`), "x".repeat(2048), "gpt-6-sol"];
  const events = names.map((name) => event(name));
  const accumulator = createCostEstimateAccumulator({ modelName: pricing.costModelName });
  for (const item of events) {
    const estimate = pricing.estimate(item);
    assert.deepEqual(estimate, estimateEventCost(item));
    accumulator.add(item, estimate);
  }
  assert.deepEqual(accumulator.result(), estimateCostForEvents(events));
});
