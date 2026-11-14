import assert from "node:assert/strict";
import test from "node:test";
import { pricingProviderGroups, pricingUpdateTimestamp } from "../public/app.js";
import { state } from "../public/app-state.js";
import { modelReleaseDatesFromCatalog, pricingReleaseDate } from "../public/pricing-directory.js";

test("used models merge across harnesses and sort by release date, including historical and missing models", () => {
  const previous = { ...state };
  try {
    state.pricingSearch = "";
    state.metadata = { harnessModels: { Codex: ["unused-stale-response"] } };
    state.pricingCatalog = {
      models: { "gpt-test-old": {}, "gpt-test-new": {}, "claude-unused": {} },
      automatic: { modelReleaseDates: { "gpt-test-old": "2026-01-02", "gpt-test-new": "2026-01-03" } },
      modelActivity: {
        activeHarnessModels: {},
        harnessModels: {
          Codex: ["gpt-test-old", "route/gpt-test-new", "codex-auto-review"],
          ZCode: ["gpt-test-new", "route/gpt-test-old", "vendor/unknown-model"],
          Hermes: ["unknown-model", "workbuddy-ai/hy4free"],
        },
      },
    };
    const groups = pricingProviderGroups();
    assert.deepEqual(
      groups.map((group) => group.id),
      ["openai", "tencent", "other"],
    );
    assert.deepEqual(
      groups[0].models.map((row) => row.model),
      ["gpt-test-new", "gpt-test-old", "codex-auto-review"],
    );
    assert.equal(groups[0].models.at(-1).matchType, "free");
    assert.equal(groups[2].models.length, 1);
    assert.equal(groups[2].models[0].matchType, "missing");
    state.pricingSearch = "openai";
    assert.equal(pricingProviderGroups().length, 1);
    state.pricingSearch = "test-new";
    assert.equal(pricingProviderGroups()[0].models.length, 1);
    state.pricingSearch = "unused";
    assert.deepEqual(pricingProviderGroups(), []);
    state.pricingSearch = "";
    state.pricingCatalog.modelActivity.harnessModels = {};
    assert.deepEqual(pricingProviderGroups(), [], "an empty snapshot does not borrow live models");
  } finally {
    Object.assign(state, previous);
  }
});

test("release dates use first-party model identities and valid publication dates", () => {
  const dates = modelReleaseDatesFromCatalog({
    openai: { models: { "gpt-new": { release_date: "2026-11-14" }, "gpt-invalid": { release_date: "2026-02-30" } } },
    alibaba: { models: { "deepseek-new": { release_date: "2026-11-13" }, "qwen-new": { release_date: "2026-11-12" } } },
    openrouter: { models: { "gpt-new": { release_date: "2026-11-15" } } },
  });
  assert.deepEqual(dates, { "gpt-new": "2026-11-14", "qwen-new": "2026-11-12" });
  assert.equal(pricingReleaseDate("GPT-NEW", dates), "2026-11-14");
  assert.equal(pricingReleaseDate("unknown"), "");
  assert.equal(pricingReleaseDate("gemini-4-hydrogen"), "2026-11-12");
});

test("manufacturers use Chinese domestic names and sort by used model count with Other last", () => {
  const previous = { ...state };
  try {
    state.pricingSearch = "";
    state.pricingCatalog = {
      models: {},
      modelActivity: {
        harnessModels: {
          Codex: ["deepseek-new-a", "deepseek-new-b", "minimax-new", "gpt-test", "unknown-a", "unknown-b", "unknown-c"],
          ZCode: ["route/deepseek-new-a"],
        },
      },
    };
    const groups = pricingProviderGroups();
    assert.deepEqual(
      groups.map((group) => group.id),
      ["deepseek", "openai", "minimax", "other"],
    );
    assert.equal(groups[0].name, "深度求索");
    assert.equal(groups[2].name, "稀宇科技");
    assert.equal(groups[0].models.length, 2);
    assert.equal(groups.at(-1).models.length, 3);
    state.pricingSearch = "deepseek";
    assert.equal(pricingProviderGroups()[0].name, "深度求索");
  } finally {
    Object.assign(state, previous);
  }
});

test("price update timestamps use the requested local minute format", () => {
  assert.equal(pricingUpdateTimestamp(new Date(2026, 10, 14, 9, 5).toISOString()), "2026-11-14-09:05");
  assert.equal(pricingUpdateTimestamp("2026-11-14"), "2026-11-14-00:00");
  assert.equal(pricingUpdateTimestamp(null), "—");
  assert.equal(pricingUpdateTimestamp("invalid"), "—");
});

test("unread models lead provider ordering by model identity, not catalog additions or usage counts", () => {
  const previous = { ...state };
  try {
    state.pricingSearch = "";
    state.pricingSeenModels = new Set(["gpt-a", "gpt-b", "gpt-c", "deepseek-old", "glm-old"]);
    state.pricingCatalog = {
      models: { "claude-unused": {} },
      modelActivity: {
        harnessModels: {
          Codex: [
            "gpt-a",
            "gpt-b",
            "gpt-c",
            "deepseek-old",
            "deepseek-new",
            "glm-old",
            "glm-new",
            "gemini-new",
            "unknown-a",
            "unknown-b",
            "unknown-c",
            "unknown-d",
          ],
          ZCode: ["route/DEEPSEEK-OLD"],
        },
      },
    };
    assert.deepEqual(
      pricingProviderGroups().map((group) => group.id),
      ["deepseek", "zai", "google", "other", "openai"],
    );
    state.pricingSeenModels.add("deepseek-new");
    assert.deepEqual(
      pricingProviderGroups().map((group) => group.id),
      ["zai", "google", "other", "openai", "deepseek"],
    );
    for (const group of pricingProviderGroups()) {
      for (const row of group.models) state.pricingSeenModels.add(row.model.toLowerCase());
    }
    assert.deepEqual(
      pricingProviderGroups().map((group) => group.id),
      ["openai", "deepseek", "zai", "google", "other"],
    );
    state.pricingCatalog.models = { ...state.pricingCatalog.models, "deepseek-unused": {} };
    state.pricingCatalog.modelActivity.harnessModels.ZCode.push("route/DEEPSEEK-NEW");
    assert.ok(pricingProviderGroups().every((group) => !group.hasUnread));
    state.pricingCatalog.modelActivity.harnessModels.ZCode.push("deepseek-latest");
    assert.equal(pricingProviderGroups()[0].id, "deepseek");
    assert.equal(pricingProviderGroups()[0].hasUnread, true);
    state.pricingSearch = "deepseek-old";
    assert.equal(pricingProviderGroups()[0].hasUnread, false, "search only acknowledges models actually shown");
    state.pricingSearch = "";
    assert.equal(pricingProviderGroups()[0].hasUnread, true, "search does not clear unseen models");
  } finally {
    Object.assign(state, previous);
  }
});

test("catalog metadata can name a newly encountered manufacturer without showing unused rows", () => {
  const previous = { ...state };
  try {
    state.pricingSearch = "";
    state.pricingCatalog = {
      models: { "orbit-test": {}, "unused-test": {} },
      modelActivity: { harnessModels: { Codex: ["vendor/orbit-test"] } },
      automatic: {
        modelMetadata: {
          "orbit-test": { short: { providerId: "new-vendor", providerName: "New Vendor" } },
          "unused-test": { short: { providerId: "unused-vendor" } },
        },
      },
    };
    const groups = pricingProviderGroups();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].name, "New Vendor");
    assert.equal(groups[0].models[0].model, "orbit-test");
  } finally {
    Object.assign(state, previous);
  }
});
