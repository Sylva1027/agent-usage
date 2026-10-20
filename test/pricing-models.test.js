import assert from "node:assert/strict";
import test from "node:test";

import {
  buildModelActivity,
  modelActivityCutoff,
  buildUsagePricingCoverage,
  resolvePricingModel,
} from "../public/pricing-models.js";

test("model activity expires at one UTC calendar month and clamps month ends", () => {
  const now = "2026-10-01T04:05:06.007Z";
  const cutoff = Date.parse("2026-09-01T04:05:06.007Z");
  assert.equal(modelActivityCutoff(now), cutoff);
  assert.equal(new Date(modelActivityCutoff("2026-03-31T12:00:00Z")).toISOString(), "2026-02-28T12:00:00.000Z");
  assert.equal(new Date(modelActivityCutoff("2024-03-31T12:00:00Z")).toISOString(), "2024-02-29T12:00:00.000Z");
  const observations = [
    { harness: "Codex", model: "boundary", timestamp: cutoff },
    { harness: "Codex", model: "old", timestamp: cutoff - 1 },
    { harness: "Codex", model: "RECENT", timestamp: cutoff + 1 },
    { harness: "Codex", model: "recent", timestamp: Date.parse(now) + 1 },
    { harness: "ZCode", model: "future", timestamp: Date.parse(now) + 1 },
    { harness: "ZCode", model: "bad", timestamp: "invalid" },
    { harness: "DSH", model: "unknown model", timestamp: cutoff + 1 },
    { harness: "Claude", model: "claude-sonnet-4-5", timestamp: cutoff + 1 },
  ];
  const activity = buildModelActivity(observations, now);
  assert.deepEqual(activity.activeHarnessModels, {
    Codex: ["recent"],
    ZCode: [],
    DSH: [],
    OpenCode: [],
    Claude: ["claude-sonnet-4-5"],
  });
  assert.equal(activity.modelLastSeen.Codex.recent, cutoff + 1);
  const returned = buildModelActivity([...observations, { harness: "ZCode", model: "old", timestamp: now }], now);
  assert.deepEqual(returned.activeHarnessModels.ZCode, ["old"]);
  assert.deepEqual(buildModelActivity(observations, "2026-11-02T04:05:06Z").activeHarnessModels.Codex, []);
});

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

test("cached model indexes stay bound to the catalog object that produced them", () => {
  const catalogA = { "mimo-v2.6": {}, "mimo-v2.6-flash": {}, "gpt-6-sol": {} };
  const catalogB = { "other-model": {} };
  const raw = "mimo-v2.6-flash-202612";

  const first = resolvePricingModel(raw, catalogA); // builds A's index; longest suffix wins
  assert.deepEqual(first, { rawModel: raw, catalogKey: "mimo-v2.6-flash", matchType: "suffix" });
  assert.deepEqual(resolvePricingModel(raw, catalogB), { rawModel: raw, catalogKey: null, matchType: "missing" });
  // Interleaving again must reuse A's cached index rather than B's.
  assert.deepEqual(resolvePricingModel(raw, catalogA), first);
  assert.equal(resolvePricingModel("gpt-6-sol", catalogA).matchType, "exact");
  assert.equal(resolvePricingModel("gpt-6-sol", catalogB).matchType, "missing");
  // The same raw ID hits in one catalog object and misses in the other.
  assert.equal(resolvePricingModel("other-model", catalogB).catalogKey, "other-model");
  assert.equal(resolvePricingModel("other-model", catalogA).matchType, "missing");
});

test("a replaced catalog object is indexed immediately, including added key sets", () => {
  const before = { "gpt-6-sol": {} };
  const after = { "gpt-6-sol": {}, "gpt-7-preview": {} }; // new object, one added key
  assert.equal(resolvePricingModel("gpt-7-preview", before).matchType, "missing");
  assert.deepEqual(resolvePricingModel(" GPT-7-PREVIEW ", after), {
    rawModel: "GPT-7-PREVIEW",
    catalogKey: "gpt-7-preview",
    matchType: "exact",
  });
  // Neither object borrows the other's index, so no stale cross-talk either way.
  assert.equal(resolvePricingModel(" GPT-7-PREVIEW ", before).matchType, "missing");
  assert.equal(resolvePricingModel("gpt-6-sol", after).matchType, "exact");
  // A frozen catalog object is still cacheable and resolvable.
  assert.equal(resolvePricingModel("gpt-6-sol", Object.freeze({ "gpt-6-sol": {} })).matchType, "exact");
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

test("auto-review policy overrides old catalog entries and counts as covered free usage", () => {
  const models = { "codex-auto-review": {} };
  assert.deepEqual(resolvePricingModel(" CODEX-AUTO-REVIEW ", models), {
    rawModel: "CODEX-AUTO-REVIEW",
    catalogKey: null,
    matchType: "free",
  });
  assert.equal(resolvePricingModel("codex-auto-review", {}).matchType, "free");
  assert.equal(resolvePricingModel("codex-auto-review-other", {}).matchType, "missing");
  const coverage = buildUsagePricingCoverage({ Codex: ["codex-auto-review"] }, models);
  assert.equal(coverage.matchedUsedModelCount, 1);
  assert.equal(coverage.freeRuleUsedModelCount, 1);
  assert.deepEqual(coverage.missingUsedModels, []);
});
