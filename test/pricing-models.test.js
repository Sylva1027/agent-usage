import assert from "node:assert/strict";
import test from "node:test";

import { buildUsagePricingCoverage, resolvePricingModel } from "../public/pricing-models.js";

test("pricing model resolution normalizes names and follows exact, alias, free, and suffix order", () => {
  const models = {
    "gpt-5.6": {},
    "gpt-5.6-sol": {},
    "gpt-6-sol": {},
    "mimo-v2.6": {},
    "mimo-v2.6-flash": {},
    "custom-free": {},
  };
  assert.deepEqual(resolvePricingModel(" GPT-6-SOL ", models), {
    rawModel: "GPT-6-SOL",
    catalogKey: "gpt-6-sol",
    matchType: "exact",
  });
  assert.equal(resolvePricingModel("gpt-daybreak-blue-latest", models).matchType, "alias");
  assert.equal(resolvePricingModel("gpt-daybreak-blue-latest", { "gpt-5.6": {} }).matchType, "missing");
  assert.equal(resolvePricingModel("gpt-6.1-sol", models).matchType, "missing");
  assert.deepEqual(resolvePricingModel("mimo-v2.6-flash-202609", models), {
    rawModel: "mimo-v2.6-flash-202609",
    catalogKey: "mimo-v2.6-flash",
    matchType: "suffix",
  });
  assert.equal(resolvePricingModel("mimo-v2.6-flash-free", models).matchType, "free");
  assert.equal(resolvePricingModel("custom-free", models).matchType, "exact");
  assert.equal(resolvePricingModel("  ", models).matchType, "missing");
  assert.equal(resolvePricingModel("Unknown model", models).matchType, "missing");
});

test("usage coverage counts normalized model IDs once across harnesses", () => {
  const coverage = buildUsagePricingCoverage(
    {
      Codex: ["gpt-daybreak-blue-latest", "mimo-v2.6-flash-free", "Mystery"],
      ZCode: ["GPT-DAYBREAK-BLUE-LATEST", " mystery ", "Unknown model", ""],
      DSH: [],
    },
    { "gpt-5.6-sol": {}, "mimo-v2.6-flash": {} },
  );
  assert.deepEqual(coverage, {
    ready: true,
    usedModelCount: 3,
    matchedUsedModelCount: 2,
    freeRuleUsedModelCount: 1,
    missingUsedModels: [{ model: "Mystery", harnesses: ["Codex", "ZCode"] }],
  });
  assert.equal(buildUsagePricingCoverage(null, {}, false).ready, false);
});
