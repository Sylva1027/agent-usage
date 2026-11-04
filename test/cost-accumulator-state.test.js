import assert from "node:assert/strict";
import test from "node:test";

import {
  COST_ACCUMULATOR_STATE_VERSION,
  createCostEstimateAccumulator,
  getPricingCatalog,
  runWithPricingCatalog,
} from "../src/pricing.js";

const DETAIL_ALL = 7;

function event(model = "gpt-6-sol", total = { total: 100, input: 80, cached: 20, output: 20 }) {
  return { model, detailMask: DETAIL_ALL, total };
}

function estimate(overrides = {}) {
  return {
    model: "gpt-6-sol",
    currency: "USD",
    priceVersion: "v1",
    priceSource: "source-a",
    inputUsd: 0,
    cachedInputUsd: 0,
    cacheWriteInputUsd: 0,
    outputUsd: 0,
    totalUsd: 0,
    pricedTokens: 100,
    unpricedTokens: 0,
    minimumEstimatedTokens: 0,
    minimumRateModels: [],
    unpricedModels: [],
    unpricedReasons: [],
    serviceTierUnknownTokens: 0,
    contextUnknownTokens: 0,
    cacheWriteUnknownTokens: 0,
    ...overrides,
  };
}

function roundtrip(value) {
  return JSON.parse(JSON.stringify(value));
}

const metadata = {
  usdToCnyRate: 6.25,
  priceCheckedAt: "2026-11-03",
};

test("checkpoint restore preserves the exact floating-point accumulation order", () => {
  const expected = createCostEstimateAccumulator(metadata);
  expected.add(event(), estimate({ inputUsd: 0.1, totalUsd: 0.1, pricedTokens: 1 }));
  expected.add(event(), estimate({ inputUsd: 0.2, totalUsd: 0.2, pricedTokens: 1 }));

  const checkpoint = roundtrip(expected.snapshot());
  const restored = createCostEstimateAccumulator({ ...metadata, state: checkpoint });
  expected.add(event(), estimate({ inputUsd: 0.3, totalUsd: 0.3, pricedTokens: 1 }));
  restored.add(event(), estimate({ inputUsd: 0.3, totalUsd: 0.3, pricedTokens: 1 }));

  assert.equal((0.1 + 0.2) + 0.3, 0.6000000000000001);
  assert.equal(restored.result().totalUsd, expected.result().totalUsd);
  assert.deepEqual(restored.result(), expected.result());
});

test("checkpoint restore retains independent USD and CNY buckets", () => {
  const accumulator = createCostEstimateAccumulator(metadata);
  accumulator.add(
    event(),
    estimate({
      inputUsd: 0.125,
      cachedInputUsd: 0.025,
      cacheWriteInputUsd: 0.05,
      outputUsd: 0.2,
      totalUsd: 0.4,
    }),
  );
  accumulator.add(
    event("step-5-preview"),
    estimate({
      model: "step-5-preview",
      currency: "CNY",
      priceVersion: "cn-v1",
      priceSource: "source-cny",
      inputUsd: 1.1,
      cachedInputUsd: 0.2,
      cacheWriteInputUsd: 0.3,
      outputUsd: 0.7,
      totalUsd: 2.3,
    }),
  );

  const snapshot = roundtrip(accumulator.snapshot());
  const restored = createCostEstimateAccumulator({ ...metadata, state: snapshot });
  const result = restored.result();

  assert.deepEqual(result.currencies, ["USD", "CNY"]);
  assert.equal(result.totalUsd, 0.4);
  assert.equal(result.totalCny, 2.3);
  assert.deepEqual(snapshot.byCurrency.CNY, {
    inputUsd: 1.1,
    cachedInputUsd: 0.2,
    cacheWriteInputUsd: 0.3,
    outputUsd: 0.7,
    totalUsd: 2.3,
    records: 1,
  });
  assert.deepEqual(result, accumulator.result());
});

test("checkpoint restore retains unknown, minimum-rate, cache-write, and price-source state", () => {
  const accumulator = createCostEstimateAccumulator({
    ...metadata,
    modelName: (value) => value,
  });
  accumulator.add(
    event("mystery-model"),
    estimate({
      model: "mystery-model",
      priceVersion: "v2",
      priceSource: "source-b",
      inputUsd: 0.01,
      cacheWriteInputUsd: 0.02,
      totalUsd: 0.03,
      pricedTokens: 9,
      unpricedTokens: 7,
      minimumEstimatedTokens: 5,
      minimumRateModels: ["mystery-model"],
      unpricedModels: ["mystery-model"],
      unpricedReasons: ["missing-detail", "unknown-model-price-minimum-scenario"],
      serviceTierUnknownTokens: 4,
      contextUnknownTokens: 3,
      cacheWriteUnknownTokens: 2,
    }),
  );
  accumulator.add(event("gpt-6-sol"), estimate({ priceSource: "source-a" }));

  const snapshot = roundtrip(accumulator.snapshot());
  const restored = createCostEstimateAccumulator({
    ...metadata,
    state: snapshot,
    modelName: (value) => value,
  });
  const result = restored.result();

  assert.equal(result.unpricedTokens, 7);
  assert.equal(result.minimumEstimatedTokens, 5);
  assert.equal(result.cacheWriteUnknownTokens, 2);
  assert.equal(result.unpricedRecords, 1);
  assert.equal(result.minimumEstimatedRecords, 1);
  assert.equal(result.serviceTierUnknownRecords, 1);
  assert.equal(result.contextUnknownRecords, 1);
  assert.equal(result.cacheWriteUnknownRecords, 1);
  assert.deepEqual(result.unpricedModels, ["mystery-model"]);
  assert.deepEqual(result.minimumRateModels, ["mystery-model"]);
  assert.deepEqual(result.unpricedReasons, ["missing-detail", "unknown-model-price-minimum-scenario"]);
  assert.deepEqual(result.priceVersions, ["v1", "v2"]);
  assert.deepEqual(result.priceSources, ["source-a", "source-b"]);
  assert.equal(result.modelCount, 2);
  assert.deepEqual(result, accumulator.result());
});

test("empty snapshots restart from zero and current metadata stays live", () => {
  const empty = createCostEstimateAccumulator();
  const state = roundtrip(empty.snapshot());
  const restored = createCostEstimateAccumulator({ state });
  assert.deepEqual(restored.result(), empty.result());

  const current = getPricingCatalog();
  const catalog = {
    ...current,
    checkedAt: "2030-01-02",
    usdToCnyRate: 9.75,
  };
  const catalogResult = runWithPricingCatalog(catalog, () =>
    createCostEstimateAccumulator({ state }).result(),
  );
  assert.equal(catalogResult.usdToCnyRate, 9.75);
  assert.equal(catalogResult.priceCheckedAt, "2030-01-02");

  const overridden = createCostEstimateAccumulator({ ...metadata, state }).result();
  assert.equal(overridden.usdToCnyRate, metadata.usdToCnyRate);
  assert.equal(overridden.priceCheckedAt, metadata.priceCheckedAt);

  restored.add(event(), estimate({ totalUsd: 1, inputUsd: 1, pricedTokens: 100 }));
  const fresh = createCostEstimateAccumulator();
  fresh.add(event(), estimate({ totalUsd: 1, inputUsd: 1, pricedTokens: 100 }));
  assert.deepEqual(restored.result(), fresh.result());
});

test("snapshots are compact, independent, and do not share restored Sets", () => {
  const source = createCostEstimateAccumulator({
    ...metadata,
    modelName: (value) => value,
  });
  source.add(event("gpt-6-sol"), estimate({ totalUsd: 1 }));
  const state = roundtrip(source.snapshot());
  const originalState = structuredClone(state);

  assert.deepEqual(Object.keys(state).sort(), ["byCurrency", "sets", "totals", "version"]);
  assert.equal(state.version, COST_ACCUMULATOR_STATE_VERSION);
  assert.deepEqual(Object.keys(state.sets).sort(), [
    "minimumRateModels",
    "models",
    "priceSources",
    "priceVersions",
    "unpricedModels",
    "unpricedReasons",
  ]);
  assert.equal("events" in state, false);
  assert.equal("items" in state, false);

  const left = createCostEstimateAccumulator({ state, modelName: (value) => value });
  const right = createCostEstimateAccumulator({ state, modelName: (value) => value });
  left.add(event("left-model"), estimate({ model: "left-model" }));
  right.add(event("right-model"), estimate({ model: "right-model" }));

  assert.deepEqual(state, originalState);
  assert.deepEqual(left.snapshot().sets.models, ["gpt-6-sol", "left-model"]);
  assert.deepEqual(right.snapshot().sets.models, ["gpt-6-sol", "right-model"]);
  state.sets.models.push("mutated-after-restore");
  assert.deepEqual(left.snapshot().sets.models, ["gpt-6-sol", "left-model"]);

  const mutableSnapshot = source.snapshot();
  mutableSnapshot.sets.models.push("mutated-snapshot");
  assert.equal(source.result().modelCount, 1);
});

test("damaged state is rejected with an identifiable TypeError", () => {
  const state = roundtrip(createCostEstimateAccumulator().snapshot());
  const assertInvalid = (candidate) => {
    assert.throws(
      () => createCostEstimateAccumulator({ state: candidate }),
      (error) =>
        error instanceof TypeError &&
        error.code === "ERR_INVALID_COST_ACCUMULATOR_STATE" &&
        error.message.startsWith("Invalid cost accumulator state:"),
    );
  };

  assertInvalid({ ...state, version: COST_ACCUMULATOR_STATE_VERSION + 1 });
  assertInvalid({ ...state, totals: { ...state.totals, totalUsd: Number.NaN } });
  assertInvalid({ ...state, sets: { ...state.sets, models: ["gpt-6-sol", "gpt-6-sol"] } });
  assertInvalid({ ...state, sets: { ...state.sets, models: null } });
  assertInvalid({ ...state, unexpected: true });
});
