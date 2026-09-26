import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { estimateCostForEvents, estimateCostForGroups, estimateEventCost, getPricingCatalog, setPricingCatalog, resetPricingCatalog, LONG_CONTEXT_INPUT_THRESHOLD } from "../src/pricing.js";
import { loadPricingFile } from "../src/pricing-store.js";

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
test("grouped store rows produce the same aggregate as individual events", () => {
  const event = {
    model: "gpt-6-luna",
    detailMask: 15,
    total: { total: 120, input: 100, cached: 60, output: 20 },
  };
  const expected = estimateCostForEvents([event]);
  const actual = estimateCostForGroups([
    { model: event.model, detailMask: event.detailMask, ...event.total },
  ]);

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
  } finally {
    resetPricingCatalog();
  }
});