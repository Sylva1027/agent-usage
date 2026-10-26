import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createCostEstimateAccumulator,
  createEventCostMemo,
  CNY_PRICING_SOURCES,
  estimateCostForEvents,
  estimateCostForGroups,
  estimateEventCost,
  getPricingCatalog,
  isPeakPricingTime,
  setPricingCatalog,
  resetPricingCatalog,
  runWithPricingCatalog,
  LONG_CONTEXT_INPUT_THRESHOLD,
} from "../src/pricing.js";
import { loadPricingFile } from "../src/pricing-store.js";
import { canonicalModelName, isCodexAutoReview } from "../public/pricing-models.js";

test("API cost estimate prices uncached input, cached input, and output separately", () => {
  const estimate = estimateCostForEvents([
    {
      model: "gpt-6-sol",
      detailMask: 15,
      cacheWriteTokens: 0,
      cacheWriteKnown: true,
      contextLevel: "short",
      serviceTier: "standard",
      total: { total: 110, input: 100, cached: 20, output: 10, reasoning: 4 },
    },
  ]);

  assert.equal(estimate.inputUsd, 0.00016);
  assert.equal(estimate.cachedInputUsd, 0.000004);
  assert.equal(estimate.outputUsd, 0.0001);
  assert.equal(estimate.totalUsd, 0.000264);
  assert.equal(estimate.cacheHitRate, 0.2);
  assert.equal(estimate.modelCount, 1);
  assert.equal(estimate.pricedTokens, 110);
  assert.equal(estimate.unpricedTokens, 0);
});

test("GPT-6.1 Sol uses its independent Standard and Fast rates", () => {
  const event = {
    model: "gpt-6.1-sol",
    detailMask: 15,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    requestInputTokens: 10_000,
    serviceTier: "standard",
    total: { total: 11_000, input: 10_000, cached: 5_000, output: 1_000 },
  };
  const standard = estimateEventCost(event);
  assert.ok(Math.abs(standard.totalUsd - 0.0205) < 1e-12);
  assert.deepEqual(standard.minimumRateModels, []);
  assert.ok(!standard.unpricedReasons.includes("unknown-model-price-minimum-scenario"));
  assert.ok(standard.unpricedReasons.includes("request-context-unknown-minimum-scenario") === false);

  const fast = estimateEventCost({ ...event, serviceTier: "fast" });
  assert.ok(Math.abs(fast.totalUsd - 0.041) < 1e-12);
  assert.ok(Math.abs(estimateEventCost({ ...event, serviceTier: "priority" }).totalUsd - 0.041) < 1e-12);

  const gpt6 = estimateEventCost({ ...event, model: "gpt-6-sol" });
  assert.ok(Math.abs(gpt6.totalUsd - 0.021) < 1e-12);
});

test("GPT-6.1 Sol prices cache writes and selects context from one request only", () => {
  const event = {
    model: "gpt-6.1-sol",
    detailMask: 15,
    serviceTier: "standard",
    cacheWriteKnown: true,
    cacheWriteTokens: 1_000,
    requestInputTokens: 10_000,
    total: { total: 11_000, input: 10_000, cached: 4_000, output: 1_000 },
  };
  assert.ok(Math.abs(estimateEventCost(event).totalUsd - 0.0229) < 1e-12);

  const contextEvent = {
    ...event,
    cacheWriteTokens: 0,
    total: { total: 301_000, input: 300_000, cached: 0, output: 1_000 },
  };
  const exact = estimateEventCost({ ...contextEvent, requestInputTokens: 272_000 });
  const over = estimateEventCost({ ...contextEvent, requestInputTokens: 272_001 });
  assert.equal(exact.contextLevel, "short");
  assert.ok(Math.abs(exact.totalUsd - (300_000 * 2 + 1_000 * 10) / 1_000_000) < 1e-12);
  assert.equal(over.contextLevel, "long");
  assert.ok(Math.abs(over.totalUsd - (300_000 * 4 + 1_000 * 15) / 1_000_000) < 1e-12);

  const parsedShort = estimateEventCost({ ...contextEvent, requestInputTokens: undefined, contextLevel: "short" });
  assert.equal(parsedShort.contextLevel, "short", "large accumulated input cannot override a known short request");
  const unknown = estimateEventCost({ ...contextEvent, requestInputTokens: undefined, contextLevel: "unknown" });
  assert.equal(unknown.contextLevel, "unknown");
  assert.ok(unknown.unpricedReasons.includes("request-context-unknown-minimum-scenario"));
});

test("Codex and Work GPT-6.1 Sol use short rates at every length without rewriting request context", () => {
  const base = {
    model: "gpt-6.1-sol",
    serviceTier: "standard",
    cacheWriteKnown: true,
    cacheWriteTokens: 50_000,
    contextLevel: "long",
    total: { total: 601_000, input: 600_000, cached: 100_000, output: 1_000 },
  };
  const shortPrice = (450_000 * 2 + 100_000 * 0.1 + 50_000 * 2.5 + 1_000 * 10) / 1_000_000;
  for (const sourceKind of ["main", "jetbrains", "extra", "codex"]) {
    for (const requestInputTokens of [272_000, 272_001, 300_000, 500_000, 500_001, 600_000]) {
      const event = { ...base, sourceKind, requestInputTokens };
      const standard = estimateEventCost(event);
      assert.ok(Math.abs(standard.totalUsd - shortPrice) < 1e-12);
      assert.equal(standard.contextLevel, requestInputTokens > 272_000 ? "long" : "short");
      assert.ok(Math.abs(estimateEventCost({ ...event, serviceTier: "fast" }).totalUsd - shortPrice * 2) < 1e-12);
      assert.ok(Math.abs(estimateEventCost({ ...event, serviceTier: "priority" }).totalUsd - shortPrice * 2) < 1e-12);
    }
    const unknown = estimateEventCost({ ...base, sourceKind, contextLevel: "unknown" });
    assert.equal(unknown.contextLevel, "unknown");
    assert.equal(unknown.contextUnknownTokens, 0);
    assert.ok(!unknown.unpricedReasons.includes("request-context-unknown-minimum-scenario"));
    assert.ok(Math.abs(unknown.totalUsd - shortPrice) < 1e-12);
  }
  for (const sourceKind of [undefined, "project-log", "zcode", "dsh", "opencode", "unknown"]) {
    const external = estimateEventCost({
      ...base,
      sourceKind,
      requestInputTokens: 600_000,
      channel: "Codex Desktop",
      source: "codex-oauth",
    });
    assert.ok(Math.abs(external.totalUsd - 2.085) < 1e-12, `${sourceKind} must keep API long pricing`);
  }
  assert.equal(
    estimateEventCost({ ...base, sourceKind: "main", model: "gpt-6-sol" }).totalUsd,
    estimateEventCost({ ...base, model: "gpt-6-sol" }).totalUsd,
  );
  assert.ok(
    Math.abs(
      estimateEventCost({ ...base, sourceKind: "main", model: "GPT-6.1-SOL-2026-10-12" }).totalUsd - shortPrice,
    ) < 1e-12,
  );
});

test("Codex context policy survives saved and updated API long rates and preserves manual short rates", () => {
  const original = getPricingCatalog();
  try {
    const changed = structuredClone(original);
    changed.models["gpt-6.1-sol"].short = { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 12 };
    changed.models["gpt-6.1-sol"].long = { input: 99, cachedInput: 9.9, cacheWrite: 100, output: 99 };
    changed.models["gpt-6.1-sol"].longContextThreshold = 1;
    setPricingCatalog(changed);
    const event = {
      model: "gpt-6.1-sol",
      sourceKind: "main",
      requestInputTokens: 600_000,
      serviceTier: "standard",
      cacheWriteKnown: true,
      cacheWriteTokens: 0,
      total: { total: 600_100, input: 600_000, cached: 0, output: 100 },
    };
    assert.ok(Math.abs(estimateEventCost(event).totalUsd - 1.8012) < 1e-12);
    assert.ok(Math.abs(estimateEventCost({ ...event, sourceKind: "project-log" }).totalUsd - 59.4099) < 1e-12);
    changed.models["gpt-6.1-sol"].long.input = 199;
    setPricingCatalog(changed);
    assert.ok(Math.abs(estimateEventCost(event).totalUsd - 1.8012) < 1e-12);
  } finally {
    setPricingCatalog(original);
  }
});

test("unknown prices and incomplete details use minimum catalog rates", () => {
  const estimate = estimateCostForEvents([
    {
      model: "gpt-6-sol",
      detailMask: 3,
      total: { total: 30, input: 25, cached: 5, output: 0 },
    },
    {
      model: "custom-review-model",
      detailMask: 15,
      total: { total: 50, input: 40, cached: 10, output: 10 },
    },
    {
      model: "Unknown model",
      detailMask: 15,
      total: { total: 20, input: 15, cached: 5, output: 5 },
    },
  ]);

  assert.ok(Math.abs(estimate.totalUsd - 0.00009298) < 1e-12);
  assert.equal(estimate.cacheHitRate, 20 / 80);
  assert.equal(estimate.modelCount, 2);
  assert.equal(estimate.pricedTokens, 100);
  assert.equal(estimate.unpricedTokens, 0);
  assert.equal(estimate.minimumEstimatedTokens, 95);
  assert.deepEqual(estimate.unpricedModels, []);
  assert.deepEqual(estimate.minimumRateModels, ["custom-review-model", "Unknown model"]);
});

test("cost accumulator counts canonical model identities while diagnostics keep raw names", () => {
  const event = {
    detailMask: 15,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    contextLevel: "short",
    serviceTier: "standard",
    total: { total: 100, input: 80, cached: 20, output: 20, reasoning: 0 },
  };
  const estimate = estimateCostForEvents([
    { ...event, model: "deepseek-v4.1-flash" },
    { ...event, model: "group/deepseek" },
    { ...event, model: "custom-review-model" },
  ]);

  assert.equal(estimate.modelCount, 2);
  assert.deepEqual(estimate.minimumRateModels, ["custom-review-model"]);
});

test("request pricing context survives await even when the global catalog changes", async () => {
  const original = getPricingCatalog();
  try {
    const candidateA = structuredClone(original);
    candidateA.checkedAt = "2026-10-25";
    candidateA.models["gpt-6-sol"].short.input = 3;
    const catalogA = setPricingCatalog(candidateA);
    const candidateB = structuredClone(original);
    candidateB.checkedAt = "2026-10-26";
    candidateB.models["gpt-6-sol"].short.input = 9;
    const catalogB = setPricingCatalog(candidateB);

    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const pending = runWithPricingCatalog(catalogA, async () => {
      await gate;
      return estimateCostForEvents([
        {
          model: "gpt-6-sol",
          detailMask: 15,
          cacheWriteTokens: 0,
          cacheWriteKnown: true,
          contextLevel: "short",
          serviceTier: "standard",
          total: { total: 1_000_000, input: 1_000_000, cached: 0, output: 0 },
        },
      ]);
    });

    setPricingCatalog(catalogB);
    release();
    const estimate = await pending;

    assert.equal(estimate.totalUsd, 3);
    assert.deepEqual(estimate.priceVersions, [catalogA.version]);
    assert.equal(getPricingCatalog().version, catalogB.version);
  } finally {
    setPricingCatalog(original);
  }
});
test("grouped store rows produce the same aggregate as individual events", () => {
  const event = {
    model: "gpt-6-luna",
    detailMask: 15,
    total: { total: 120, input: 100, cached: 60, output: 20 },
  };
  const expected = estimateCostForEvents([event]);
  const actual = estimateCostForGroups([{ model: event.model, detailMask: event.detailMask, ...event.total }]);

  assert.deepEqual(actual, expected);
});

test("long-context rates apply to the full request only when input exceeds 272K", () => {
  const base = {
    model: "gpt-6-sol",
    detailMask: 7,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    serviceTier: "standard",
  };
  assert.equal(LONG_CONTEXT_INPUT_THRESHOLD, 272_000);
  const exact = estimateEventCost({
    ...base,
    contextLevel: "short",
    total: { total: 272_000, input: 272_000, cached: 0, output: 0 },
  });
  const over = estimateEventCost({
    ...base,
    contextLevel: "long",
    total: { total: 272_101, input: 272_001, cached: 0, output: 100 },
  });
  assert.equal(exact.inputUsd, 0.544);
  assert.equal(over.inputUsd, 1.088004);
  assert.equal(over.outputUsd, 0.0015);
});

test("Fast and legacy priority service tiers double the Standard estimate", () => {
  const event = {
    model: "gpt-6-sol",
    detailMask: 7,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    contextLevel: "short",
    total: { total: 110, input: 100, cached: 20, output: 10 },
  };
  const standard = estimateEventCost({ ...event, serviceTier: "standard" });
  const fast = estimateEventCost({ ...event, serviceTier: "fast" });
  const priority = estimateEventCost({ ...event, serviceTier: "priority" });
  const unknown = estimateEventCost(event);
  assert.equal(fast.totalUsd, standard.totalUsd * 2);
  assert.equal(priority.totalUsd, fast.totalUsd);
  assert.equal(unknown.totalUsd, standard.totalUsd);
  assert.equal(unknown.serviceTierUnknownTokens, 110);
  assert.ok(unknown.unpricedReasons.includes("service-tier-unknown-standard-scenario"));
});

test("missing cache-write detail prices known cache and uses lowest eligible input rate", () => {
  const estimate = estimateEventCost({
    model: "gpt-6-sol",
    detailMask: 7,
    contextLevel: "short",
    serviceTier: "standard",
    total: { total: 110, input: 100, cached: 20, output: 10 },
  });
  assert.equal(estimate.inputUsd, 0.00016);
  assert.equal(estimate.cachedInputUsd, 0.000004);
  assert.equal(estimate.cacheWriteInputUsd, 0);
  assert.equal(estimate.outputUsd, 0.0001);
  assert.equal(estimate.totalUsd, 0.000264);
  assert.equal(estimate.pricedTokens, 110);
  assert.equal(estimate.unpricedTokens, 0);
  assert.equal(estimate.minimumEstimatedTokens, 80);
  assert.equal(estimate.cacheWriteUnknownTokens, 80);
});
test("missing cache-write detail selects the cheaper eligible custom rate", () => {
  const catalog = getPricingCatalog();
  catalog.models["gpt-6-sol"].short.input = 3;
  catalog.models["gpt-6-sol"].short.cachedInput = 0.3;
  catalog.models["gpt-6-sol"].short.cacheWrite = 1;
  try {
    setPricingCatalog({ checkedAt: catalog.checkedAt, models: catalog.models });
    const estimate = estimateEventCost({
      model: "gpt-6-sol",
      detailMask: 7,
      contextLevel: "short",
      serviceTier: "standard",
      total: { total: 110, input: 100, cached: 20, output: 10 },
    });
    assert.ok(Math.abs(estimate.totalUsd - 0.000186) < 1e-12);
    assert.equal(estimate.cacheWriteInputUsd, 0.00008);
    assert.equal(estimate.minimumEstimatedTokens, 80);
    assert.equal(estimate.cacheWriteUnknownTokens, 80);
  } finally {
    resetPricingCatalog();
  }
});
test("known total and output infer input while preserving known cached tokens", () => {
  const estimate = estimateEventCost({
    model: "gpt-6-sol",
    detailMask: 6,
    contextLevel: "short",
    serviceTier: "standard",
    total: { total: 110, cached: 20, output: 10 },
  });
  assert.equal(estimate.totalUsd, 0.000264);
  assert.equal(estimate.cachedInputUsd, 0.000004);
  assert.equal(estimate.minimumEstimatedTokens, 80);
  assert.equal(estimate.cacheWriteUnknownTokens, 80);
  assert.equal(estimate.pricedTokens, 110);
});

test("人民币模型按元计价并标记 CNY", () => {
  const estimate = estimateEventCost({
    model: "mimo-v2.6-pro",
    channel: "ZCode",
    contextLevel: "short",
    detailMask: 15,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    timestamp: "2026-09-25T04:00:00.000Z",
    total: { total: 110, input: 100, cached: 20, output: 10, reasoning: 0 },
  });

  assert.equal(estimate.currency, "CNY");
  assert.ok(Math.abs(estimate.inputUsd - (80 * 3) / 1_000_000) < 1e-12);
  assert.ok(Math.abs(estimate.cachedInputUsd - (20 * 0.025) / 1_000_000) < 1e-12);
  assert.ok(Math.abs(estimate.outputUsd - (10 * 6) / 1_000_000) < 1e-12);
  assert.ok(Math.abs(estimate.totalUsd - (240 + 0.5 + 60) / 1_000_000) < 1e-12);
  assert.equal(estimate.pricingStatus, "estimated");
  assert.ok(estimate.priceSource.includes("mimo.mi.com"));
});

test("DeepSeek 谷时段按 5 折计价", () => {
  const base = {
    model: "deepseek-flash",
    contextLevel: "short",
    detailMask: 15,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    total: { total: 110, input: 100, cached: 20, output: 10, reasoning: 0 },
  };
  const peak = estimateEventCost({ ...base, timestamp: "2026-09-22T02:00:00.000Z" }); // 周二北京时间 10:00 高峰
  const weekdayOffPeak = estimateEventCost({ ...base, timestamp: "2026-09-22T05:00:00.000Z" }); // 周二 13:00 谷时
  const weekend = estimateEventCost({ ...base, timestamp: "2026-09-26T02:00:00.000Z" }); // 周六 10:00 谷时

  assert.equal(peak.currency, "CNY");
  assert.ok(Math.abs(peak.totalUsd - (80 * 2 + 20 * 0.04 + 10 * 8) / 1_000_000) < 1e-12);
  assert.ok(Math.abs(weekdayOffPeak.totalUsd - peak.totalUsd * 0.5) < 1e-15);
  assert.ok(Math.abs(weekend.totalUsd - peak.totalUsd * 0.5) < 1e-15);
  assert.ok(!peak.unpricedReasons.includes("off-peak-pricing-applied"));
  assert.ok(weekdayOffPeak.unpricedReasons.includes("off-peak-pricing-applied"));
  assert.ok(weekend.unpricedReasons.includes("off-peak-pricing-applied"));
});

test("八个 DeepSeek 原始名共用官方价与峰谷边界", () => {
  const models = getPricingCatalog().models;
  const names = [
    "deepseek-v4.1-flash",
    "opendesign/deepseek-v4.1-flash",
    "workbuddy-ai/deepseek-v4.1-flash",
    "workbuddy-ai/deepseek-v4.1-flash-sg",
    "opencode-go/deepseek-v4.1-flash",
    "deepseek-flash",
    "deepseek-v4.1-flash-sg",
    "group/deepseek",
  ];
  for (const name of names) assert.equal(canonicalModelName(name, models), "deepseek-flash");

  const event = {
    detailMask: 15,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    contextLevel: "short",
    serviceTier: "standard",
    total: { total: 110, input: 100, cached: 20, output: 10, reasoning: 0 },
  };
  const instants = [
    ["09:00 peak start", "2026-09-22T01:00:00.000Z"],
    ["10:00 peak", "2026-09-22T02:00:00.000Z"],
    ["12:00 peak end", "2026-09-22T04:00:00.000Z"],
    ["13:00 off-peak", "2026-09-22T05:00:00.000Z"],
    ["14:00 peak start", "2026-09-22T06:00:00.000Z"],
    ["18:00 peak end", "2026-09-22T10:00:00.000Z"],
  ];
  const peakAmount = (80 * 2 + 20 * 0.04 + 10 * 8) / 1_000_000;

  for (const [label, timestamp] of instants) {
    const expected = estimateEventCost({ ...event, model: "deepseek-flash", timestamp });
    for (const model of names) {
      const actual = estimateEventCost({ ...event, model, timestamp });
      assert.equal(actual.totalUsd, expected.totalUsd, `${label}: ${model}`);
      assert.equal(actual.currency, "CNY", `${label}: ${model}`);
      assert.equal(actual.priceSource, CNY_PRICING_SOURCES.deepseek, `${label}: ${model}`);
    }
  }

  assert.ok(
    Math.abs(
      estimateEventCost({ ...event, model: "deepseek-flash", timestamp: instants[0][1] }).totalUsd - peakAmount,
    ) < 1e-15,
  );
  assert.ok(
    Math.abs(
      estimateEventCost({ ...event, model: "deepseek-flash", timestamp: instants[2][1] }).totalUsd - peakAmount * 0.5,
    ) < 1e-15,
  );
});

test("残留自动缓存条目不会抢走 DeepSeek 别名的官方键", () => {
  const catalog = getPricingCatalog();
  const residual = structuredClone(catalog.models["deepseek-flash"]);
  residual.currency = "USD";
  residual.source = CNY_PRICING_SOURCES.qwen;
  residual.short = { input: 9, cachedInput: 0.9, cacheWrite: 0, output: 18 };
  residual.long = { input: 9, cachedInput: 0.9, cacheWrite: 0, output: 18 };
  catalog.models["deepseek-v4-flash-0731"] = residual;

  try {
    setPricingCatalog(catalog);
    assert.equal(Object.hasOwn(getPricingCatalog().models, "deepseek-v4-flash-0731"), true);
    const event = {
      model: "deepseek-flash",
      detailMask: 15,
      cacheWriteTokens: 0,
      cacheWriteKnown: true,
      contextLevel: "short",
      serviceTier: "standard",
      timestamp: "2026-09-22T02:00:00.000Z",
      total: { total: 110, input: 100, cached: 20, output: 10, reasoning: 0 },
    };
    const expected = estimateEventCost(event);
    for (const model of ["deepseek-v4.1-flash", "workbuddy-ai/deepseek-v4.1-flash-sg", "group/deepseek"]) {
      const actual = estimateEventCost({ ...event, model });
      assert.equal(actual.totalUsd, expected.totalUsd, model);
      assert.equal(actual.priceSource, CNY_PRICING_SOURCES.deepseek, model);
    }
  } finally {
    resetPricingCatalog();
  }
});

test("峰谷区间端点为左闭右开，跨日区间不命中", () => {
  const entry = {
    offPeakMultiplier: 0.5,
    peakTimezone: "Asia/Shanghai",
    peakWindows: [{ days: [2], ranges: [["09:00", "12:00"]] }],
  };
  // 2026-09-22 是周二；UTC+8 下 01:00Z = 09:00、04:00Z = 12:00。
  assert.equal(isPeakPricingTime(entry, Date.parse("2026-09-22T01:00:00.000Z")), true); // start 闭
  assert.equal(isPeakPricingTime(entry, Date.parse("2026-09-22T03:59:00.000Z")), true);
  assert.equal(isPeakPricingTime(entry, Date.parse("2026-09-22T04:00:00.000Z")), false); // end 开
  assert.equal(isPeakPricingTime(entry, Date.parse("2026-09-22T00:59:00.000Z")), false); // start 之前

  // 现状不支持跨日区间（start > end ⇒ 恒不命中）；本卡不修，仅锁定行为。
  const overnight = {
    offPeakMultiplier: 0.5,
    peakTimezone: "Asia/Shanghai",
    peakWindows: [{ days: [2, 3], ranges: [["22:00", "06:00"]] }],
  };
  assert.equal(isPeakPricingTime(overnight, Date.parse("2026-09-22T15:00:00.000Z")), false); // 周二 23:00
  assert.equal(isPeakPricingTime(overnight, Date.parse("2026-09-22T20:00:00.000Z")), false); // 周三 04:00
});

test("复用峰谷 formatter 不串用不同 peakWindows 的判定结果", () => {
  const base = { offPeakMultiplier: 0.5, peakTimezone: "Asia/Shanghai" };
  const morning = { ...base, peakWindows: [{ days: [2], ranges: [["09:00", "12:00"]] }] };
  const evening = { ...base, peakWindows: [{ days: [2], ranges: [["13:00", "18:00"]] }] };
  const ts = Date.parse("2026-09-22T01:00:00.000Z"); // 周二 09:00
  assert.equal(isPeakPricingTime(morning, ts), true);
  assert.equal(isPeakPricingTime(evening, ts), false);
  assert.equal(isPeakPricingTime(evening, ts), false); // 反向顺序再跑，确认缓存只作用于 formatter
  assert.equal(isPeakPricingTime(morning, ts), true);
  assert.equal(isPeakPricingTime({ ...morning, peakTimezone: "UTC" }, ts), false); // 同一 peakWindows、换时区
});

test("非法 peakTimezone 在构造处抛 RangeError，失败不被缓存", () => {
  const entry = {
    offPeakMultiplier: 0.5,
    peakTimezone: "Not/AZone",
    peakWindows: [{ days: [2], ranges: [["09:00", "12:00"]] }],
  };
  const ts = Date.parse("2026-09-22T01:00:00.000Z");
  assert.throws(() => isPeakPricingTime(entry, ts), RangeError);
  assert.throws(() => isPeakPricingTime(entry, ts), RangeError); // 第二次仍抛：失败路径不入缓存
  assert.equal(isPeakPricingTime({ ...entry, peakTimezone: "UTC" }, ts), false); // 合法时区不受污染
});

test("GLM-4.7 按输入上下文与输出长度分档计价", () => {
  const build = (input, output) => ({
    model: "glm-4.7",
    channel: "ZCode",
    detailMask: 15,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    requestInputTokens: input,
    total: { total: input + output, input, cached: 0, output, reasoning: 0 },
  });
  const shortShortOutput = estimateEventCost(build(10_000, 100)); // 输出<200 → 2/8
  const shortLongOutput = estimateEventCost(build(10_000, 500)); // 输出≥200 → 3/14
  const long = estimateEventCost(build(100_000, 100)); // 输入≥32K → 4/16

  assert.ok(Math.abs(shortShortOutput.totalUsd - (10_000 * 2 + 100 * 8) / 1_000_000) < 1e-12);
  assert.ok(Math.abs(shortLongOutput.totalUsd - (10_000 * 3 + 500 * 14) / 1_000_000) < 1e-12);
  assert.ok(Math.abs(long.totalUsd - (100_000 * 4 + 100 * 16) / 1_000_000) < 1e-12);
  assert.equal(shortShortOutput.contextLevel, "short");
  assert.equal(long.contextLevel, "long");
});

test("kimi-k3 缓存写入按 5 分钟 TTL 档计价", () => {
  const estimate = estimateEventCost({
    model: "kimi-k3",
    channel: "ZCode",
    contextLevel: "short",
    detailMask: 15,
    cacheWriteTokens: 1_000,
    cacheWriteKnown: true,
    total: { total: 21_000, input: 20_000, cached: 5_000, output: 1_000, reasoning: 0 },
  });

  assert.ok(Math.abs(estimate.cacheWriteInputUsd - (1_000 * 20) / 1_000_000) < 1e-12);
  assert.ok(Math.abs(estimate.totalUsd - (14_000 * 20 + 5_000 * 2 + 1_000 * 20 + 1_000 * 100) / 1_000_000) < 1e-12);
  assert.equal(estimate.pricingStatus, "estimated");
});

test("混合币种汇总按美元与人民币分列", () => {
  const estimate = estimateCostForEvents([
    {
      model: "gpt-6-sol",
      detailMask: 15,
      contextLevel: "short",
      cacheWriteTokens: 0,
      cacheWriteKnown: true,
      total: { total: 110, input: 100, cached: 20, output: 10 },
    },
    {
      model: "mimo-v2.6-pro",
      channel: "ZCode",
      detailMask: 15,
      contextLevel: "short",
      cacheWriteTokens: 0,
      cacheWriteKnown: true,
      total: { total: 110, input: 100, cached: 20, output: 10 },
    },
  ]);

  assert.deepEqual(estimate.currencies, ["USD", "CNY"]);
  assert.ok(Math.abs(estimate.totalUsd - 0.000264) < 1e-12);
  assert.ok(Math.abs(estimate.totalCny - (240 + 0.5 + 60) / 1_000_000) < 1e-12);
  assert.equal(estimate.totalCny > 0 && estimate.totalUsd > 0, true);
});

test("未知模型按事件渠道决定回退币种", () => {
  const cny = estimateEventCost({
    model: "mystery-model",
    channel: "ZCode Subagent",
    detailMask: 15,
    total: { total: 100, input: 80, cached: 0, output: 20 },
  });
  const usd = estimateEventCost({
    model: "mystery-model",
    channel: "CLI",
    detailMask: 15,
    total: { total: 100, input: 80, cached: 0, output: 20 },
  });

  assert.equal(cny.currency, "CNY");
  assert.equal(usd.currency, "USD");
  assert.equal(cny.pricingStatus, "minimum-estimate");
  assert.deepEqual(cny.minimumRateModels, ["mystery-model"]);
});

test("codex-auto-review is free despite stale rates, missing details, and Fast mode", () => {
  const catalog = getPricingCatalog();
  const unknownEvent = {
    model: "unknown-billable",
    detailMask: 15,
    cacheWriteKnown: true,
    cacheWriteTokens: 0,
    serviceTier: "standard",
    contextLevel: "short",
    total: { total: 110, input: 100, cached: 20, output: 10 },
  };
  const unknownCost = estimateEventCost(unknownEvent).totalUsd;
  setPricingCatalog({
    ...catalog,
    models: {
      ...catalog.models,
      "codex-auto-review": {
        short: { input: 0.000001, cachedInput: 0.000001, cacheWrite: 0.000001, output: 0.000001 },
      },
    },
  });
  try {
    assert.equal(
      estimateEventCost(unknownEvent).totalUsd,
      unknownCost,
      "exempt stale rates cannot lower paid-model fallback costs",
    );
    for (const model of ["codex-auto-review", " CODEX-AUTO-REVIEW "]) {
      for (const details of [{}, { detailMask: 15, cacheWriteKnown: true, cacheWriteTokens: 0, serviceTier: "fast" }]) {
        const event = { model, total: { total: 110, input: 100, cached: 20, output: 10 }, ...details };
        const estimate = estimateEventCost(event);
        assert.equal(estimate.totalUsd, 0);
        assert.equal(estimate.pricedTokens, 110);
        assert.equal(estimate.unpricedTokens, 0);
        assert.equal(estimate.minimumEstimatedTokens, 0);
        assert.equal(estimate.pricingStatus, "estimated");
        assert.deepEqual(estimate.unpricedReasons, []);
        assert.deepEqual(estimate.minimumRateModels, []);
        assert.equal(estimate.serviceTierUnknownTokens, 0);
        assert.equal(estimate.contextUnknownTokens, 0);
        assert.equal(estimate.cacheWriteUnknownTokens, 0);
        assert.ok(estimate.priceSource.includes("help.openai.com"));
        const accumulator = createCostEstimateAccumulator();
        accumulator.add(event, estimate);
        assert.equal(accumulator.result().minimumEstimatedRecords, 0);
      }
    }
    assert.equal(estimateEventCost({ model: "codex-auto-review", total: { total: 0 } }).totalUsd, 0);
    assert.ok(estimateEventCost({ model: "gpt-6-sol", total: { total: 110 } }).totalUsd > 0);
    assert.equal(
      estimateEventCost({ model: "codex-auto-review-other", total: { total: 110 } }).pricingStatus,
      "minimum-estimate",
    );
  } finally {
    resetPricingCatalog();
  }
});

test("-free 后缀的未收录模型按零费率估算", () => {
  const build = (model, extra = {}) => ({
    model,
    channel: "OpenCode",
    detailMask: 15,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    contextLevel: "short",
    serviceTier: "standard",
    total: { total: 110, input: 100, cached: 20, output: 10 },
    ...extra,
  });

  for (const model of ["longcat-2.5-preview-free", "space-bunny-free"]) {
    const estimate = estimateEventCost(build(model));
    assert.equal(estimate.totalUsd, 0, model);
    assert.equal(estimate.pricedTokens, 110, model);
    assert.equal(estimate.pricingStatus, "estimated", model);
    assert.equal(estimate.minimumEstimatedTokens, 0, model);
    assert.deepEqual(estimate.minimumRateModels, [], model);
    assert.ok(!estimate.unpricedReasons.includes("unknown-model-price-minimum-scenario"), model);
  }
  // 大小写不敏感。
  assert.equal(estimateEventCost(build("LONGCAT-2.5-PREVIEW-FREE")).totalUsd, 0);
});

test("-free 零费率优先于前缀匹配", () => {
  const build = (model, channel) => ({
    model,
    channel,
    detailMask: 15,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    contextLevel: "short",
    serviceTier: "standard",
    total: { total: 110, input: 100, cached: 20, output: 10 },
  });

  // 若被前缀规则吸收，mimo-v2.6-flash-free 会按 CNY 费率估出正数，
  // muse-spark-1.3-contributor-free 会按 USD 费率估出正数。
  for (const model of ["mimo-v2.6-flash-free", "muse-spark-1.3-contributor-free"]) {
    assert.equal(estimateEventCost(build(model, "OpenCode")).totalUsd, 0, model);
    assert.equal(estimateEventCost(build(model, "ZCode")).totalUsd, 0, model);
  }
  // 币种仍按渠道回退（金额为 0）。
  assert.equal(estimateEventCost(build("mimo-v2.6-flash-free", "ZCode")).currency, "CNY");
  assert.equal(estimateEventCost(build("mimo-v2.6-flash-free", "OpenCode")).currency, "USD");
});

test("价目表精确键优先于 -free 零费率", () => {
  const catalog = getPricingCatalog();
  setPricingCatalog({
    checkedAt: catalog.checkedAt,
    usdToCnyRate: catalog.usdToCnyRate,
    models: {
      ...catalog.models,
      "my-model-free": { short: { input: 1, cachedInput: 0.1, cacheWrite: 0, output: 2 } },
    },
  });
  try {
    const estimate = estimateEventCost({
      model: "my-model-free",
      channel: "OpenCode",
      detailMask: 15,
      cacheWriteTokens: 0,
      cacheWriteKnown: true,
      contextLevel: "short",
      serviceTier: "standard",
      total: { total: 110, input: 100, cached: 20, output: 10 },
    });
    assert.ok(estimate.totalUsd > 0, "精确键应按自定义费率计价");
  } finally {
    resetPricingCatalog();
  }
});

test("-free 模型不误伤付费模型与未知模型兜底", () => {
  const build = (model) => ({
    model,
    channel: "OpenCode",
    detailMask: 15,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    contextLevel: "short",
    serviceTier: "standard",
    total: { total: 110, input: 100, cached: 20, output: 10 },
  });

  const paid = estimateEventCost(build("mimo-v2.6-flash"));
  assert.equal(paid.currency, "CNY");
  assert.ok(paid.totalUsd > 0, "付费模型费率不变");
  const unknown = estimateEventCost(build("mystery-model"));
  assert.equal(unknown.pricingStatus, "minimum-estimate", "非 -free 未知模型仍走最低费率兜底");
});

test("-free 事件不计入最低估算汇总", () => {
  const freeEvent = {
    model: "space-bunny-free",
    channel: "OpenCode",
    detailMask: 15,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    contextLevel: "short",
    serviceTier: "standard",
    total: { total: 110, input: 100, cached: 20, output: 10 },
  };
  const unknownEvent = { ...freeEvent, model: "mystery-model" };
  const accumulator = createCostEstimateAccumulator();
  accumulator.add(freeEvent, estimateEventCost(freeEvent));
  accumulator.add(unknownEvent, estimateEventCost(unknownEvent));
  const result = accumulator.result();
  assert.equal(result.minimumEstimatedRecords, 1);
  assert.deepEqual(result.minimumRateModels, ["mystery-model"]);
});

test("官方声明的快速模式费率优先于双倍兜底", () => {
  const build = (model, extra = {}) => ({
    model,
    detailMask: 15,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    serviceTier: "fast",
    total: { total: 301_000, input: 300_000, cached: 0, output: 1_000, reasoning: 0 },
    ...extra,
  });
  // grok-4.7 长上下文：官方 Fast 价 6/1.5/0/18，而非标准价（4/1/0/12）的两倍。
  const grokFast = estimateEventCost(build("grok-4.7", { requestInputTokens: 300_000 }));
  assert.ok(Math.abs(grokFast.totalUsd - (300_000 * 6 + 1_000 * 18) / 1_000_000) < 1e-12);
  // gpt-6-sol 的官方 Fast 价即标准价 2 倍，与兜底一致。
  const gptFast = estimateEventCost(build("gpt-6-sol", { contextLevel: "short" }));
  assert.ok(Math.abs(gptFast.totalUsd - (300_000 * 4 + 1_000 * 20) / 1_000_000) < 1e-12);
});

test("价目只保留文本/推理模型，媒体类 API 不入库", () => {
  const { models } = getPricingCatalog();
  for (const mediaModel of [
    "step-1o-turbo-vision",
    "glm-5v-turbo",
    "glm-4.6v",
    "glm-4.6v-flashx",
    "glm-4.5v",
    "glm-ocr",
  ]) {
    assert.ok(!(mediaModel in models), `${mediaModel} 应已移除`);
  }
  assert.ok(models["grok-4.7"].longContextThreshold, "新服务商模型已录入");
  assert.ok(models["qwen3.8-max"], "qwen 模型已录入");
  assert.ok(models["gemini-2.5-flash"].fast, "gemini 快速模式费率已录入");
  assert.ok(models["minimax-m3"].fast, "minimax priority 费率已录入");
  assert.ok(models["muse-spark-1.3"], "meta 模型已录入");
});

test("汇率随价目保存，非法汇率被拒绝", () => {
  const catalog = getPricingCatalog();
  assert.equal(catalog.usdToCnyRate, 6.72);
  const estimate = estimateCostForEvents([
    {
      model: "gpt-6-sol",
      detailMask: 15,
      contextLevel: "short",
      cacheWriteTokens: 0,
      cacheWriteKnown: true,
      total: { total: 110, input: 100, cached: 20, output: 10 },
    },
  ]);
  assert.equal(estimate.usdToCnyRate, 6.72);

  try {
    setPricingCatalog({ checkedAt: "2026-09-25", usdToCnyRate: 7.8, models: getPricingCatalog().models });
    assert.equal(getPricingCatalog().usdToCnyRate, 7.8);
    assert.throws(
      () => setPricingCatalog({ checkedAt: "2026-09-25", usdToCnyRate: -1, models: getPricingCatalog().models }),
      /USD to CNY rate/,
    );
  } finally {
    resetPricingCatalog();
  }
});

test("旧版价目文件加载时补齐新增内置模型并保留自定义价", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-pricing-migrate-"));
  await mkdir(path.join(homeDir, ".codex-usage"), { recursive: true });
  await writeFile(
    path.join(homeDir, ".codex-usage", "pricing.json"),
    JSON.stringify({
      checkedAt: "2026-09-23",
      models: {
        "gpt-6-sol": {
          short: { input: 9, cachedInput: 9, cacheWrite: 9, output: 9 },
          long: { input: 9, cachedInput: 9, cacheWrite: 9, output: 9 },
        },
        "gpt-6.1-sol": {
          short: { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 12 },
          long: { input: 99, cachedInput: 99, cacheWrite: 99, output: 99 },
        },
      },
    }),
  );

  await loadPricingFile({ homeDir });
  try {
    const catalog = getPricingCatalog();
    assert.equal(catalog.checkedAt, "2026-09-23");
    assert.equal(catalog.models["gpt-6-sol"].short.input, 9);
    // 旧文件缺少的结构性字段（快速模式价等）从内置官方价目补齐，不被顶掉。
    assert.deepEqual(catalog.models["gpt-6-sol"].fast.short, { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 });
    assert.equal(catalog.models["deepseek-flash"].currency, "CNY");
    assert.equal(catalog.models["glm-4.7"].outputThreshold, 200);
    const event = {
      model: "gpt-6.1-sol",
      sourceKind: "main",
      serviceTier: "standard",
      contextLevel: "long",
      requestInputTokens: 600_000,
      detailMask: 15,
      cacheWriteKnown: true,
      cacheWriteTokens: 0,
      total: { total: 600_100, input: 600_000, cached: 0, output: 100, reasoning: 0 },
    };
    assert.ok(Math.abs(estimateEventCost(event).totalUsd - 1.8012) < 1e-12);
    assert.ok(Math.abs(estimateEventCost({ ...event, sourceKind: "project-log" }).totalUsd - 59.4099) < 1e-12);
  } finally {
    resetPricingCatalog();
  }
});

test("模型索引按 models 对象身份缓存：改键集合后立即命中，重置后不串用", () => {
  const base = {
    contextLevel: "short",
    detailMask: 15,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    serviceTier: "standard",
    total: { total: 110, input: 100, cached: 20, output: 10, reasoning: 0 },
  };
  const model = "zz-r2-cache-probe-model"; // 内置价目无此前缀，只能靠新键命中
  const before = estimateEventCost({ ...base, model });
  assert.equal(before.pricingStatus, "minimum-estimate");
  assert.ok(before.unpricedReasons.includes("unknown-model-price-minimum-scenario"));
  assert.equal(before.minimumEstimatedTokens, 110);

  const catalog = getPricingCatalog();
  assert.equal(Object.keys(catalog.models).length, 101);
  catalog.models[model] = structuredClone(catalog.models["gpt-6-sol"]);
  try {
    // setPricingCatalog 走 validatePricingCatalog，产出全新 models 对象；
    // 新增的键必须在同一进程内立刻命中，不能命中旧索引。
    setPricingCatalog({ checkedAt: catalog.checkedAt, models: catalog.models });
    const priced = estimateEventCost({ ...base, model });
    assert.equal(priced.pricingStatus, "estimated");
    assert.deepEqual(priced.unpricedReasons, []);
    assert.ok(Math.abs(priced.totalUsd - 0.000264) < 1e-12);
    // 同一个输入对象再 set 一次：activePricing.models 仍是全新对象，索引必须重建后立即命中。
    setPricingCatalog({ checkedAt: catalog.checkedAt, models: catalog.models });
    assert.equal(estimateEventCost({ ...base, model }).pricingStatus, "estimated");
  } finally {
    resetPricingCatalog();
  }

  // resetPricingCatalog 复用内置 MODEL_PRICES 对象身份（缓存条目"复活"），
  // 但索引仍是该对象键集合的索引：新键回到 missing，行为与改前一致。
  const reset = estimateEventCost({ ...base, model });
  assert.equal(reset.pricingStatus, "minimum-estimate");
  assert.ok(reset.unpricedReasons.includes("unknown-model-price-minimum-scenario"));
  // 内置模型在 reset 后仍按内置价目计价（复活的索引没有指向被替换的目录）。
  assert.equal(estimateEventCost({ ...base, model: "gpt-6-sol" }).pricingStatus, "estimated");
});

function minimumRatesOracle(catalog, contextLevel, currency) {
  const fields = ["input", "cachedInput", "cacheWrite", "output"];
  const contexts = contextLevel === "unknown" ? ["short", "long"] : [contextLevel];
  const candidates = Object.entries(catalog.models)
    .filter(([model, entry]) => !isCodexAutoReview(model) && (entry.currency || "USD") === currency)
    .flatMap(([, entry]) => contexts.map((context) => entry[context]).filter(Boolean))
    .filter((rates) => fields.some((field) => rates[field] > 0));
  if (!candidates.length) return null;
  return Object.fromEntries(fields.map((field) => [field, Math.min(...candidates.map((rates) => rates[field]))]));
}

function setCurrencyRates(catalog, currency, short, long = short) {
  for (const entry of Object.values(catalog.models)) {
    if ((entry.currency || "USD") !== currency) continue;
    entry.short = { ...short };
    entry.long = { ...long };
  }
  return catalog;
}

function unknownMinimumEvent(channel = "CLI", contextLevel = "short") {
  return {
    model: "zz-minimum-rates-probe",
    channel,
    contextLevel,
    detailMask: 15,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    serviceTier: "standard",
    total: { total: 110, input: 100, cached: 20, output: 10, reasoning: 0 },
  };
}

function unknownMinimumUsd(rates) {
  return (80 * rates.input + 20 * rates.cachedInput + 10 * rates.output) / 1_000_000;
}

test("未知模型完整计价与独立最低费率 oracle 一致", () => {
  const catalog = getPricingCatalog();
  catalog.checkedAt = "2026-10-23";
  const rates = { input: 10, cachedInput: 1, cacheWrite: 0, output: 20 };
  setCurrencyRates(catalog, "USD", rates);

  try {
    setPricingCatalog(catalog);
    const active = getPricingCatalog();
    const actual = estimateEventCost(unknownMinimumEvent());
    const oracle = minimumRatesOracle(active, "short", "USD");
    assert.deepEqual(oracle, rates);
    assert.deepEqual(actual, {
      model: "zz-minimum-rates-probe",
      currency: "USD",
      priceVersion: active.version,
      priceSource: "",
      serviceTier: "standard",
      contextLevel: "short",
      inputUsd: (80 * rates.input) / 1_000_000,
      cachedInputUsd: (20 * rates.cachedInput) / 1_000_000,
      cacheWriteInputUsd: 0,
      outputUsd: (10 * rates.output) / 1_000_000,
      totalUsd: unknownMinimumUsd(rates),
      pricedTokens: 110,
      unpricedTokens: 0,
      minimumEstimatedTokens: 110,
      minimumRateModels: ["zz-minimum-rates-probe"],
      unpricedModels: [],
      unpricedReasons: ["unknown-model-price-minimum-scenario"],
      serviceTierUnknownTokens: 0,
      contextUnknownTokens: 0,
      cacheWriteUnknownTokens: 0,
      pricingStatus: "minimum-estimate",
    });
  } finally {
    resetPricingCatalog();
  }
});

test("最低费率缓存随同日期价目替换及 A→B→A 正确失效", () => {
  const base = getPricingCatalog();
  base.checkedAt = "2026-10-23";
  const catalogA = setCurrencyRates(
    setCurrencyRates(
      structuredClone(base),
      "USD",
      { input: 10, cachedInput: 1, cacheWrite: 0, output: 20 },
      {
        input: 20,
        cachedInput: 2,
        cacheWrite: 0,
        output: 40,
      },
    ),
    "CNY",
    { input: 30, cachedInput: 3, cacheWrite: 0, output: 60 },
    { input: 40, cachedInput: 4, cacheWrite: 0, output: 80 },
  );
  const catalogB = setCurrencyRates(
    setCurrencyRates(
      structuredClone(base),
      "USD",
      { input: 50, cachedInput: 5, cacheWrite: 0, output: 100 },
      {
        input: 60,
        cachedInput: 6,
        cacheWrite: 0,
        output: 120,
      },
    ),
    "CNY",
    { input: 70, cachedInput: 7, cacheWrite: 0, output: 140 },
    { input: 80, cachedInput: 8, cacheWrite: 0, output: 160 },
  );
  const events = [
    unknownMinimumEvent("CLI", "short"),
    unknownMinimumEvent("CLI", "long"),
    unknownMinimumEvent("ZCode", "short"),
    unknownMinimumEvent("ZCode", "long"),
  ];
  const expectedTotals = (catalog) =>
    events.map((event) =>
      unknownMinimumUsd(
        minimumRatesOracle(
          catalog,
          event.contextLevel,
          event.channel.toLocaleLowerCase().startsWith("zcode") ? "CNY" : "USD",
        ),
      ),
    );
  const assertTotals = (estimates, expected, label) => {
    for (const [index, estimate] of estimates.entries()) {
      assert.ok(Math.abs(estimate.totalUsd - expected[index]) < 1e-12, `${label} event ${index}`);
    }
  };

  try {
    setPricingCatalog(catalogA);
    const versionA = getPricingCatalog().version;
    const firstA = events.map(estimateEventCost);
    assertTotals(firstA, expectedTotals(catalogA), "catalog A");

    setPricingCatalog(catalogB);
    const versionB = getPricingCatalog().version;
    const valuesB = events.map(estimateEventCost);
    assert.equal(
      versionB === versionA,
      false,
      "same checkedAt with different models must get a different catalog hash",
    );
    assert.notDeepEqual(valuesB, firstA);
    assertTotals(valuesB, expectedTotals(catalogB), "catalog B");

    setPricingCatalog(catalogA);
    assert.deepEqual(events.map(estimateEventCost), firstA);
  } finally {
    resetPricingCatalog();
  }

  const defaultRates = minimumRatesOracle(getPricingCatalog(), "short", "USD");
  assert.ok(Math.abs(estimateEventCost(unknownMinimumEvent()).totalUsd - unknownMinimumUsd(defaultRates)) < 1e-12);
});

test("价目替换后事件 memo 不复用旧目录结果", () => {
  const catalogA = getPricingCatalog();
  const catalogB = structuredClone(catalogA);
  catalogB.models["deepseek-flash"].short = { input: 4, cachedInput: 0.08, cacheWrite: 0, output: 16 };
  catalogB.models["deepseek-flash"].long = { input: 4, cachedInput: 0.08, cacheWrite: 0, output: 16 };
  const event = {
    model: "deepseek-v4.1-flash",
    detailMask: 15,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    contextLevel: "short",
    serviceTier: "standard",
    timestamp: "2026-09-22T02:00:00.000Z",
    total: { total: 110, input: 100, cached: 20, output: 10, reasoning: 0 },
  };
  const memo = createEventCostMemo();

  try {
    setPricingCatalog(catalogA);
    const first = memo.estimate(event);
    setPricingCatalog(catalogB);
    const second = memo.estimate(event);
    assert.equal(memo.stats().misses, 2, "目录版本变化必须新增一次未命中");
    assert.notEqual(second.priceVersion, first.priceVersion);
    assert.ok(Math.abs(second.totalUsd - first.totalUsd * 2) < 1e-15);
    assert.deepEqual(second, estimateEventCost(event));
  } finally {
    resetPricingCatalog();
  }
});
