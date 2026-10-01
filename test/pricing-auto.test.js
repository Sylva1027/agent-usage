import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  fetchPricingJson,
  fetchPricingText,
  frankfurterUsdCny,
  GLM_PRICES_URL,
  glmPricePatches,
  KIMI_PRICES_URL,
  kimiPricePatches,
  LITELLM_PRICES_URL,
  liteLLMPricePatches,
  MIMO_PRICES_URL,
  mimoPricePatches,
  MODEL_PRICES_URL,
  modelsDevPricePatches,
  parseOpenAIModelPricing,
  pricingSourceCoverage,
  STEPFUN_PRICES_URL,
  stepFunPricePatches,
  USD_CNY_RATE_URL,
} from "../src/pricing-auto.js";
import {
  getDefaultPricingCatalog,
  getPricingCatalog,
  resetPricingCatalog,
  MAX_PRICING_MODELS,
} from "../src/pricing.js";
import {
  getAutomaticPricingStatus,
  automaticPricingFile,
  loadPricingFile,
  pricingFile,
  refreshAutomaticPricing,
  savePricingFile,
} from "../src/pricing-store.js";

function modelCatalog(input, output) {
  return {
    openai: {
      models: {
        "gpt-6-sol": {
          cost: {
            input,
            output,
            cache_read: input / 10,
            cache_write: input * 1.25,
            tiers: [
              {
                tier: { type: "context", size: 272_000 },
                input: input * 2,
                output: output * 1.5,
                cache_read: input / 5,
                cache_write: input * 2.5,
              },
            ],
          },
        },
      },
    },
  };
}

function mimoPricingPage() {
  return `<!doctype html><html><body><h2>模型国内定价</h2><p>单位：元 / 百万 tokens；缓存写入：限时免费</p><table>
    <tr><th>计费类型</th><th>模型</th><th>缓存输入</th><th>输入</th><th>输出</th></tr>
    <tr><td>实时推理</td><td>模型</td><td>缓存输入价格</td><td>输入价格</td><td>输出价格</td></tr>
    <tr><td></td><td>mimo-v2.6-pro、mimo-v2.5-pro</td><td>¥0.025</td><td>¥3</td><td>¥6</td></tr>
    <tr><td></td><td>mimo-v2.6-flash、mimo-v2.5</td><td>¥0.02</td><td>¥1</td><td>¥2</td></tr>
    <tr><td></td><td>mimo-v2.6-pro-ultraspeed</td><td>¥0.25</td><td>¥30</td><td>¥60</td></tr>
    <tr><td>批量推理</td><td>mimo-v2.6-pro</td><td>¥0.01</td><td>¥1</td><td>¥2</td></tr>
  </table><h2>海外模型价格</h2></body></html>`;
}

function stepfunPricingPage() {
  return `<!doctype html><html><body><table><thead><tr><th>模型</th><th>计费单位</th><th>输入价格（缓存未命中）</th><th>输入价格（缓存命中）</th><th>输出价格</th></tr></thead><tbody>
    <tr><td><code>step-5-preview</code></td><td>1M tokens</td><td>7 元</td><td>0.35 元</td><td>20 元</td></tr>
    <tr><td><code>step-3.7-flash</code></td><td>1M tokens</td><td>1.35 元</td><td>0.27 元</td><td>8.1 元</td></tr>
    <tr><td><code>step-3.5-flash</code></td><td>1M tokens</td><td>0.7 元</td><td>0.14 元</td><td>2.1 元</td></tr>
    <tr><td><code>step-3.5-flash-2603</code></td><td>1M tokens</td><td>0.7 元</td><td>0.14 元</td><td>2.1 元</td></tr>
  </tbody></table></body></html>`;
}

function kimiPricingPage() {
  return [
    "此处 1M = 1,000,000 tokens。缓存写入（TTL 5min）和缓存写入（TTL 1h）。",
    "rows:[[ `kimi-k3`,`1M tokens`,`¥20.00`,`¥40.00`,`¥2.00`,`¥20.00`,`¥100.00`,`1,048,576 tokens` ]]",
    "rows:[[ `kimi-k2.7-code`,`1M tokens`,`¥1.30`,`¥6.50`,`¥27.00`,`262,144 tokens` ],[ `kimi-k2.7-code-highspeed`,`1M tokens`,`¥2.60`,`¥13.00`,`¥54.00`,`262,144 tokens` ],[ `kimi-k2.6`,`1M tokens`,`¥1.10`,`¥6.50`,`¥27.00`,`262,144 tokens` ]]",
  ].join("\n");
}

function glmPricingPage() {
  const rows = [
    ["GLM-5.3", "1M", "8", "28", "限时免费", "2"],
    ["GLM-5.3-Flash", "1M", "0.8", "2.8", "限时免费", "0.23"],
    ["GLM-5.3-FlashX", "1M", "2", "7", "限时免费", "0.57"],
    ["GLM-5.2", "1M", "8", "28", "限时免费", "2"],
    ["GLM-5.1", "输入长度 [0, 32K)", "6", "24", "限时免费", "1.3"],
    ["GLM-5.1", "输入长度 ≥32K", "8", "28", "限时免费", "2"],
    ["GLM-5-Turbo", "输入长度 [0, 32K)", "5", "22", "限时免费", "1.2"],
    ["GLM-5-Turbo", "输入长度 ≥32K", "7", "26", "限时免费", "1.8"],
    ["GLM-5", "输入长度 [0, 32K)", "4", "18", "限时免费", "1"],
    ["GLM-5", "输入长度 ≥32K", "6", "22", "限时免费", "1.5"],
    ["GLM-4.7-FlashX", "200K", "0.5", "3", "限时免费", "0.1"],
    ["GLM-4.7-Flash", "200K", "免费", "免费", "限时免费", "免费"],
    ["GLM-4-Plus", "128K", "5", "5", "限时免费", "2.5"],
    ["GLM-4-Air-250414", "128K", "0.5", "0.5", "限时免费", "0.25"],
    ["GLM-4-AirX", "8K", "10", "10", "限时免费", "不支持"],
    ["GLM-4-Long", "1M", "1", "1", "限时免费", "0.5"],
    ["GLM-4-Assistant", "128K", "5", "5", "限时免费", "不支持"],
    ["GLM-Z1-Air", "128K", "0.5", "0.5", "限时免费", "不支持"],
    ["GLM-Z1-AirX", "32K", "5", "5", "限时免费", "不支持"],
    ["GLM-Z1-FlashX", "128K", "0.1", "0.1", "限时免费", "不支持"],
    ["GLM-4-FlashX-250414", "128K", "0.1", "0.1", "限时免费", "0.05"],
    ["GLM-4-Flash-250414", "128K", "免费", "免费", "限时免费", "不支持"],
    ["GLM-Z1-Flash", "128K", "免费", "免费", "限时免费", "不支持"],
    ["GLM-4.7", "输入 [0, 32K)，输出 [0, 0.2K)", "2", "8", "限时免费", "0.4"],
    ["GLM-4.7", "输入 [0, 32K)，输出 ≥0.2K", "3", "14", "限时免费", "0.6"],
    ["GLM-4.5-Air", "输入 [0, 32K)，输出 [0, 0.2K)", "0.8", "2", "限时免费", "0.16"],
  ];
  return `<html><body><table><thead><tr><th>模型名称</th><th>上下文</th><th>输入单价（元/百万 Tokens）</th><th>输出单价（元/百万 Tokens）</th><th>缓存存储（元/百万 Tokens/小时）</th><th>缓存命中（元/百万 Tokens）</th></tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></body></html>`;
}

function stubFetch(prices, rate, calls) {
  return async (url) => {
    calls.push(url);
    if (url === MIMO_PRICES_URL)
      return new Response(mimoPricingPage(), { status: 200, headers: { "content-type": "text/html" } });
    if (url === STEPFUN_PRICES_URL)
      return new Response(stepfunPricingPage(), { status: 200, headers: { "content-type": "text/html" } });
    if (url === KIMI_PRICES_URL)
      return new Response(kimiPricingPage(), { status: 200, headers: { "content-type": "text/html" } });
    if (url === GLM_PRICES_URL)
      return new Response(glmPricingPage(), { status: 200, headers: { "content-type": "text/html" } });
    const payload =
      url === MODEL_PRICES_URL
        ? prices
        : url === LITELLM_PRICES_URL
          ? {}
          : { base: "USD", quote: "CNY", date: "2026-09-28", rate };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("a damaged automatic cache falls back to the built-in catalog", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-auto-damaged-cache-"));
  try {
    await mkdir(path.dirname(automaticPricingFile({ homeDir })), { recursive: true });
    await writeFile(automaticPricingFile({ homeDir }), "{ damaged cache");
    await loadPricingFile({ homeDir });
    assert.equal(getPricingCatalog().models["gpt-6-sol"].short.input, 2);
    assert.equal(getAutomaticPricingStatus().automaticModelCount, 0);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("automatic prices require exact provider/model matches and compatible long tiers", () => {
  const catalog = getDefaultPricingCatalog();
  const patches = modelsDevPricePatches(modelCatalog(3, 12), catalog);
  assert.deepEqual(patches["gpt-6-sol"].short, { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 12 });
  assert.deepEqual(patches["gpt-6-sol"].long, { input: 6, cachedInput: 0.6, cacheWrite: 7.5, output: 18 });
  assert.equal(patches["gpt-6-sol"].source, MODEL_PRICES_URL);
  assert.equal(patches["deepseek-flash"], undefined);
  const missingLongTier = modelsDevPricePatches(
    { openai: { models: { "gpt-6-sol": { cost: { input: 3, output: 12 } } } } },
    catalog,
  )["gpt-6-sol"];
  assert.deepEqual(missingLongTier.short, { input: 3, cachedInput: 0.2, cacheWrite: 2.5, output: 12 });
  assert.equal(missingLongTier.long, undefined, "an absent long tier does not reuse a generic 272K threshold");
  const fallback = liteLLMPricePatches(
    {
      "gpt-6-sol": {
        litellm_provider: "openai",
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000012,
        cache_read_input_token_cost: 0.0000003,
        input_cost_per_token_above_272k_tokens: 0.000006,
        output_cost_per_token_above_272k_tokens: 0.000018,
      },
    },
    catalog,
  );
  assert.equal(fallback["gpt-6-sol"].long.input, 6);
  assert.equal(fallback["gpt-6-sol"].short.output, 12);
  assert.equal(fallback["gpt-6-sol"].source, LITELLM_PRICES_URL);
  assert.throws(() => frankfurterUsdCny({ base: "USD", quote: "EUR", date: "2026-09-28", rate: 6.8 }));
  assert.throws(() => frankfurterUsdCny({ base: "USD", quote: "CNY", date: "2026-02-30", rate: 6.8 }));
});

test("official CNY source adapters cover providers with lossless catalog rates", () => {
  const catalog = getDefaultPricingCatalog();
  const coverage = pricingSourceCoverage(catalog.models);
  assert.equal(coverage.totalModelCount, 103);
  assert.equal(coverage.supportedModelCount, 99);
  assert.equal(coverage.supportedUsdModelCount, 66);
  assert.equal(coverage.supportedCnyModelCount, 33);
  assert.equal(coverage.unsupportedCurrencyModelCount, 4);
  assert.deepEqual(coverage.providers, {
    anthropic: 17,
    openai: 7,
    xai: 8,
    alibaba: 9,
    google: 12,
    minimax: 8,
    meta: 5,
    stepfun: 4,
    mimo: 5,
    kimi: 4,
    glm: 20,
  });

  const stepfunPatches = stepFunPricePatches(stepfunPricingPage(), catalog);
  assert.deepEqual(stepfunPatches["step-5-preview"].short, {
    input: 7,
    cachedInput: 0.35,
    cacheWrite: 0,
    output: 20,
  });
  assert.equal(stepfunPatches["step-3.5-flash-2603"].source, STEPFUN_PRICES_URL);
  assert.equal(stepfunPatches["step-3.5-flash-2603"].__metadata.short.providerId, "stepfun");
  assert.equal(Object.keys(stepfunPatches).length, 4);

  const mimoPatches = mimoPricePatches(mimoPricingPage(), catalog);
  assert.deepEqual(mimoPatches["mimo-v2.6-pro"].short, {
    input: 3,
    cachedInput: 0.025,
    cacheWrite: 0,
    output: 6,
  });
  assert.deepEqual(mimoPatches["mimo-v2.6-pro-ultraspeed"].long, {
    input: 30,
    cachedInput: 0.25,
    cacheWrite: 0,
    output: 60,
  });
  assert.equal(mimoPatches["mimo-v2.6-pro"].source, MIMO_PRICES_URL);
  assert.equal(mimoPatches["mimo-v2.6-pro"].__metadata.short.providerId, "mimo");
  assert.equal(mimoPatches["deepseek-flash"], undefined, "MiMo's source cannot update another provider's CNY model");
  assert.throws(() => mimoPricePatches(mimoPricingPage().replace("百万 tokens", "千 tokens"), catalog));

  const kimiPatches = kimiPricePatches(kimiPricingPage(), catalog);
  assert.deepEqual(kimiPatches["kimi-k3"].short, {
    input: 20,
    cachedInput: 2,
    cacheWrite: 20,
    output: 100,
  });
  assert.deepEqual(kimiPatches["kimi-k2.7-code-highspeed"].long, {
    input: 13,
    cachedInput: 2.6,
    cacheWrite: 0,
    output: 54,
  });
  assert.equal(kimiPatches["kimi-k2.7-code"].__metadata.short.providerId, "kimi");
  assert.equal(Object.keys(kimiPatches).length, 4);

  const glmPatches = glmPricePatches(glmPricingPage(), catalog);
  assert.deepEqual(glmPatches["glm-5.1"].short, {
    input: 6,
    cachedInput: 1.3,
    cacheWrite: 0,
    output: 24,
  });
  assert.deepEqual(glmPatches["glm-5.1"].long, {
    input: 8,
    cachedInput: 2,
    cacheWrite: 0,
    output: 28,
  });
  assert.equal(glmPatches["glm-5.1"].longContextThreshold, 32_000);
  assert.deepEqual(glmPatches["glm-4.7-flash"].short, {
    input: 0,
    cachedInput: 0,
    cacheWrite: 0,
    output: 0,
  });
  assert.equal(glmPatches["glm-4.7"], undefined, "input and output tiers cannot be reduced to one catalog tier");
  assert.equal(glmPatches["glm-4.5-air"], undefined, "input and output tiers cannot be reduced to one catalog tier");
  assert.equal(glmPatches["glm-5.3"].__metadata.short.providerId, "glm");
  assert.equal(Object.keys(glmPatches).length, 20);

  const patches = modelsDevPricePatches(
    {
      alibaba: { models: { "qwen3.8-max": { cost: { input: 0.8, output: 3.2 } } } },
      minimax: { models: { "MiniMax-M2.7": { cost: { input: 0.3, output: 1.2 } } } },
      meta: { models: { "muse-spark-1.3": { cost: { input: 1.25, output: 4.25, cache_read: 0.15 } } } },
      deepseek: { models: { "deepseek-flash": { cost: { input: 1, output: 4 } } } },
    },
    catalog,
  );
  assert.deepEqual(patches["qwen3.8-max"].short, {
    input: 0.8,
    cachedInput: catalog.models["qwen3.8-max"].short.cachedInput,
    cacheWrite: catalog.models["qwen3.8-max"].short.cacheWrite,
    output: 3.2,
  });
  assert.equal(patches["qwen3.8-max"].__metadata.short.providerId, "alibaba");
  assert.equal(patches["minimax-m2.7"].__metadata.short.providerId, "minimax");
  assert.equal(patches["muse-spark-1.3"].__metadata.short.providerId, "meta");
  assert.equal(patches["deepseek-flash"], undefined, "USD aggregation must not overwrite CNY entries");
});

function discoveryModelsDev({
  model = "gpt-test-discovery",
  shortInput = 2,
  longInput = 4,
  tiers = true,
  cacheWrite = 2.5,
} = {}) {
  const cost = {
    input: shortInput,
    cache_read: 0.1,
    cache_write: cacheWrite,
    output: 10,
    ...(tiers
      ? {
          tiers: [
            {
              tier: { type: "context", size: 272_000 },
              input: longInput,
              cache_read: 0.2,
              cache_write: 5,
              output: 15,
            },
          ],
        }
      : {}),
  };
  return { openai: { models: { [model]: { modalities: { input: ["text"], output: ["text"] }, cost } } } };
}

function discoveryLiteLLM({
  model = "gpt-test-discovery",
  input = 2,
  longInput = 4,
  provider = "openai",
  complete = true,
  long = true,
} = {}) {
  return {
    [model]: {
      litellm_provider: provider,
      input_cost_per_token: input / 1_000_000,
      cache_read_input_token_cost: 0.1 / 1_000_000,
      ...(complete ? { cache_creation_input_token_cost: 2.5 / 1_000_000 } : {}),
      output_cost_per_token: 10 / 1_000_000,
      ...(long
        ? {
            input_cost_per_token_above_272k_tokens: longInput / 1_000_000,
            cache_read_input_token_cost_above_272k_tokens: 0.2 / 1_000_000,
            cache_creation_input_token_cost_above_272k_tokens: 5 / 1_000_000,
            output_cost_per_token_above_272k_tokens: 15 / 1_000_000,
          }
        : {}),
    },
  };
}

test("new OpenAI discovery requires complete evidenced tiers and records provenance", () => {
  const checkedAt = "2026-09-30T12:00:00.000Z";
  const both = parseOpenAIModelPricing("gpt-test-discovery", {
    modelsDevPayload: discoveryModelsDev(),
    liteLLMPayload: discoveryLiteLLM(),
    checkedAt,
  });
  assert.equal(both.status, "added");
  assert.equal(both.pricing.currency, "USD");
  assert.equal(both.pricing.longContextThreshold, 272_000);
  assert.deepEqual(both.pricing.short, { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 });
  assert.deepEqual(both.pricing.fast.short, { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 });
  assert.deepEqual(both.modelMetadata.short, {
    sourceUrl: MODEL_PRICES_URL,
    checkedAt,
    origin: "remote",
    inheritedFields: [],
  });
  assert.equal(both.modelMetadata["fast.short"].origin, "derived");

  assert.equal(
    parseOpenAIModelPricing("gpt-test-discovery", {
      modelsDevPayload: discoveryModelsDev(),
      liteLLMPayload: {},
      checkedAt,
    }).status,
    "added",
    "a complete Models.dev candidate can succeed on its own",
  );
  assert.equal(
    parseOpenAIModelPricing("gpt-test-discovery", {
      modelsDevPayload: {},
      liteLLMPayload: discoveryLiteLLM(),
      checkedAt,
    }).status,
    "added",
    "a complete LiteLLM candidate can succeed on its own",
  );
});

test("new OpenAI discovery rejects uncertain, incomplete, conflicting, and non-text candidates", () => {
  const parse = (modelsDevPayload, liteLLMPayload = {}) =>
    parseOpenAIModelPricing("gpt-test-discovery", { modelsDevPayload, liteLLMPayload });
  const flat = discoveryModelsDev({ tiers: false });
  assert.deepEqual(parse(flat), { status: "deferred", reason: "context-policy-unknown" });
  assert.deepEqual(parse(discoveryModelsDev({ cacheWrite: null })), {
    status: "deferred",
    reason: "incomplete-rates",
  });
  assert.deepEqual(parse(discoveryModelsDev({}), discoveryLiteLLM({ input: 3 })), {
    status: "rejected",
    reason: "conflict",
  });
  assert.deepEqual(parse({}, discoveryLiteLLM({ provider: "anthropic" })), {
    status: "rejected",
    reason: "unsupported-provider",
  });
  assert.deepEqual(parse({}, discoveryLiteLLM({ long: false })), {
    status: "deferred",
    reason: "context-policy-unknown",
  });
  assert.deepEqual(
    parse({
      openai: { models: { "gpt-test-discovery": { modalities: { input: ["image"], output: ["image"] }, cost: {} } } },
    }),
    { status: "rejected", reason: "unsupported-provider" },
  );
  assert.deepEqual(parseOpenAIModelPricing("openai/gpt-test-discovery", {}), {
    status: "rejected",
    reason: "unsupported-provider",
  });
});

function discoveryFetch(modelsDevPayload, liteLLMPayload = {}, calls = [], rate = 6.83) {
  return async (url) => {
    calls.push(url);
    if (url === MIMO_PRICES_URL)
      return new Response(mimoPricingPage(), { status: 200, headers: { "content-type": "text/html" } });
    if (url === STEPFUN_PRICES_URL)
      return new Response(stepfunPricingPage(), { status: 200, headers: { "content-type": "text/html" } });
    if (url === KIMI_PRICES_URL)
      return new Response(kimiPricingPage(), { status: 200, headers: { "content-type": "text/html" } });
    if (url === GLM_PRICES_URL)
      return new Response(glmPricingPage(), { status: 200, headers: { "content-type": "text/html" } });
    const payload =
      url === MODEL_PRICES_URL
        ? modelsDevPayload
        : url === LITELLM_PRICES_URL
          ? liteLLMPayload
          : { base: "USD", quote: "CNY", date: "2026-09-30", rate };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("discovered OpenAI models persist provenance and receive later automatic updates", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-auto-discovery-"));
  try {
    await loadPricingFile({ homeDir });
    const first = await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-09-30T12:00:00Z"),
      usedModels: { Codex: ["gpt-test-discovery"] },
      pricingFetcher: discoveryFetch(discoveryModelsDev(), discoveryLiteLLM()),
    });
    assert.deepEqual(first.discovery.addedModels, ["gpt-test-discovery"]);
    assert.equal(first.discovery.results[0].status, "added");
    assert.equal(getPricingCatalog().models["gpt-test-discovery"].short.input, 2);
    assert.equal(first.modelMetadata["gpt-test-discovery"].short.origin, "remote");

    const cache = JSON.parse(await readFile(automaticPricingFile({ homeDir }), "utf8"));
    assert.equal(cache.models["gpt-test-discovery"].short.input, 2);
    assert.equal(cache.models["gpt-test-discovery"].__metadata, undefined);
    assert.equal(cache.modelMetadata["gpt-test-discovery"]["fast.short"].origin, "derived");
    assert.equal(cache.discoveryAttemptedAt["gpt-test-discovery"], "2026-09-30T12:00:00.000Z");

    await loadPricingFile({ homeDir });
    assert.equal(getPricingCatalog().models["gpt-test-discovery"].short.input, 2);
    const second = await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-10-01T12:00:00Z"),
      usedModels: { Codex: ["gpt-test-discovery"] },
      pricingFetcher: discoveryFetch(
        discoveryModelsDev({ shortInput: 3, longInput: 6 }),
        discoveryLiteLLM({ input: 3, longInput: 6 }),
      ),
    });
    assert.equal(second.pricesUpdated, true);
    assert.equal(getPricingCatalog().models["gpt-test-discovery"].short.input, 3);
    assert.equal(getPricingCatalog().models["gpt-test-discovery"].long.input, 6);
    assert.equal(getPricingCatalog().models["gpt-test-discovery"].short.output, 10);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("first-party provider identity survives the aggregated source cache on later updates", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-auto-xai-recheck-"));
  const xaiCatalog = (input) => ({ xai: { models: { "grok-4.7": { cost: { input, output: input * 3 } } } } });
  try {
    await loadPricingFile({ homeDir });
    const first = await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-09-30T12:00:00Z"),
      pricingFetcher: discoveryFetch(xaiCatalog(2)),
    });
    assert.equal(first.automaticModelCount, 34);
    assert.equal(first.modelMetadata["grok-4.7"].short.providerId, "xai");

    await loadPricingFile({ homeDir });
    const second = await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-10-01T12:00:00Z"),
      pricingFetcher: discoveryFetch(xaiCatalog(3)),
    });
    assert.equal(second.pricesUpdated, true);
    assert.equal(getPricingCatalog().models["grok-4.7"].short.input, 3);
    assert.equal(second.priceSourceCoverage.providers.xai, 8);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("failed automatic-cache writes restore the previous catalog and metadata", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-auto-write-failure-"));
  try {
    const cachePath = automaticPricingFile({ homeDir });
    await mkdir(cachePath, { recursive: true });
    await loadPricingFile({ homeDir });
    const beforeCatalog = getPricingCatalog();
    const beforeStatus = getAutomaticPricingStatus();
    await assert.rejects(
      refreshAutomaticPricing({
        homeDir,
        force: true,
        now: new Date("2026-09-30T12:00:00Z"),
        usedModels: ["gpt-test-write-failure"],
        pricingFetcher: discoveryFetch(
          discoveryModelsDev({ model: "gpt-test-write-failure" }),
          discoveryLiteLLM({ model: "gpt-test-write-failure" }),
        ),
      }),
    );
    assert.deepEqual(getPricingCatalog(), beforeCatalog);
    assert.equal(getAutomaticPricingStatus().statusVersion, beforeStatus.statusVersion);
    assert.equal(getAutomaticPricingStatus().automaticModelCount, 0);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("existing partial price updates record inherited fields, while source conflicts keep prior rates", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-auto-provenance-"));
  try {
    await loadPricingFile({ homeDir });
    await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-09-30T12:00:00Z"),
      pricingFetcher: discoveryFetch({
        openai: { models: { "gpt-6-sol": { cost: { input: 3, cache_read: 0.3, output: 12 } } } },
      }),
    });
    const metadata = getAutomaticPricingStatus().modelMetadata["gpt-6-sol"].short;
    assert.equal(getPricingCatalog().models["gpt-6-sol"].short.cacheWrite, 2.5);
    assert.equal(metadata.origin, "mixed");
    assert.deepEqual(metadata.inheritedFields, ["cacheWrite"]);
    assert.equal(metadata.inheritedFrom.cacheWrite.origin, "built-in");

    resetPricingCatalog();
    await loadPricingFile({ homeDir });
    const before = structuredClone(getPricingCatalog().models["gpt-6-sol"].short);
    const conflictingLite = {
      "gpt-6-sol": {
        litellm_provider: "openai",
        input_cost_per_token: 0.0000031,
        cache_read_input_token_cost: 0.0000003,
        cache_creation_input_token_cost: 0.00000375,
        output_cost_per_token: 0.000012,
      },
    };
    const conflict = await refreshAutomaticPricing({
      homeDir,
      force: true,
      now: new Date("2026-09-30T13:00:00Z"),
      pricingFetcher: discoveryFetch(modelCatalog(5, 20), conflictingLite),
    });
    assert.deepEqual(getPricingCatalog().models["gpt-6-sol"].short, before);
    assert.ok(conflict.discovery.results.some((item) => item.model === "gpt-6-sol" && item.reason === "conflict"));
    assert.ok(getAutomaticPricingStatus().modelMetadata["gpt-6-sol"].short.conflicts.length > 0);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("discovery-only status changes do not report a price change and retry on the next eligible attempt", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-auto-status-only-"));
  const calls = [];
  try {
    await loadPricingFile({ homeDir });
    const first = await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-09-30T12:00:00Z"),
      usedModels: ["gpt-test-pending"],
      pricingFetcher: discoveryFetch(discoveryModelsDev({ model: "gpt-test-pending", tiers: false }), {}, calls, 6.72),
    });
    assert.equal(first.changed, false);
    assert.equal(first.statusChanged, true);
    assert.deepEqual(first.discovery.results, [
      { model: "gpt-test-pending", status: "deferred", reason: "context-policy-unknown" },
    ]);
    const beforeCooldownCalls = calls.length;
    const cooldown = await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-09-30T12:30:00Z"),
      usedModels: ["gpt-test-pending"],
      pricingFetcher: discoveryFetch({}, {}, calls),
    });
    assert.equal(calls.length, beforeCooldownCalls);
    assert.equal(cooldown.changed, false);
    assert.equal(cooldown.statusChanged, false);
    assert.deepEqual(cooldown.discovery.results, [
      { model: "gpt-test-pending", status: "deferred", reason: "retry-after" },
    ]);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("discovery accepts one complete source, respects cooldown, and force bypasses it", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-auto-discovery-fallback-"));
  const calls = [];
  try {
    await loadPricingFile({ homeDir });
    const first = await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-09-30T12:00:00Z"),
      usedModels: ["gpt-test-discovery"],
      pricingFetcher: discoveryFetch({}, discoveryLiteLLM(), calls),
    });
    assert.deepEqual(first.discovery.addedModels, ["gpt-test-discovery"]);
    const requestCount = calls.length;
    const cooldown = await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-09-30T12:30:00Z"),
      usedModels: ["gpt-test-discovery", "gpt-test-pending"],
      pricingFetcher: discoveryFetch(discoveryModelsDev({ model: "gpt-test-pending", tiers: false }), {}, calls),
    });
    assert.equal(
      calls.length,
      requestCount + 6,
      "discovery fetches price sources without forcing an exchange-rate check",
    );
    assert.deepEqual(cooldown.discovery.results, [
      { model: "gpt-test-discovery", status: "matched", reason: "exact" },
      { model: "gpt-test-pending", status: "deferred", reason: "context-policy-unknown" },
    ]);
    const failedAt = getAutomaticPricingStatus().discoveryAttemptedAt["gpt-test-pending"];
    const repeated = await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-09-30T13:00:00Z"),
      usedModels: ["gpt-test-pending"],
      pricingFetcher: discoveryFetch(discoveryModelsDev({ model: "gpt-test-pending", tiers: false }), {}, calls),
    });
    assert.equal(calls.length, requestCount + 6);
    assert.deepEqual(repeated.discovery.results, [
      { model: "gpt-test-pending", status: "deferred", reason: "retry-after" },
    ]);
    assert.equal(getAutomaticPricingStatus().discoveryAttemptedAt["gpt-test-pending"], failedAt);

    const beforeForcedRefresh = calls.length;
    const forced = await refreshAutomaticPricing({
      homeDir,
      force: true,
      now: new Date("2026-09-30T13:00:01Z"),
      usedModels: ["gpt-test-pending"],
      pricingFetcher: discoveryFetch({}, discoveryLiteLLM({ model: "gpt-test-pending" }), calls),
    });
    assert.deepEqual(forced.discovery.addedModels, ["gpt-test-pending"]);
    assert.deepEqual(calls.slice(beforeForcedRefresh), [
      MODEL_PRICES_URL,
      LITELLM_PRICES_URL,
      MIMO_PRICES_URL,
      STEPFUN_PRICES_URL,
      KIMI_PRICES_URL,
      GLM_PRICES_URL,
      USD_CNY_RATE_URL,
    ]);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("discovery can be disabled and reports capacity per model without dropping cached prices", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-auto-discovery-capacity-"));
  try {
    await loadPricingFile({ homeDir });
    const result = await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-09-30T12:00:00Z"),
      usedModels: ["gpt-test-disabled"],
      automaticDiscoveryEnabled: false,
      pricingFetcher: discoveryFetch({}, discoveryLiteLLM()),
    });
    assert.deepEqual(result.discovery.addedModels, []);
    assert.equal(getPricingCatalog().models["gpt-test-disabled"], undefined);

    const catalog = getPricingCatalog();
    const sample = structuredClone(catalog.models["gpt-6-sol"]);
    const remainingSlots = MAX_PRICING_MODELS - Object.keys(catalog.models).length - 1;
    for (let index = 0; index < remainingSlots; index += 1) {
      catalog.models[`manual-test-${String(index).padStart(2, "0")}`] = sample;
    }
    await savePricingFile({ homeDir }, catalog);
    const modelsDev = discoveryModelsDev({ model: "gpt-test-over-capacity" });
    modelsDev.openai.models["gpt-test-at-capacity"] = discoveryModelsDev({
      model: "gpt-test-at-capacity",
    }).openai.models["gpt-test-at-capacity"];
    modelsDev.openai.models["gpt-6-sol"] = discoveryModelsDev({
      model: "gpt-6-sol",
      shortInput: 3,
      longInput: 6,
    }).openai.models["gpt-6-sol"];
    const liteLLM = {
      ...discoveryLiteLLM({ model: "gpt-test-over-capacity" }),
      ...discoveryLiteLLM({ model: "gpt-test-at-capacity" }),
      ...discoveryLiteLLM({ model: "gpt-6-sol", input: 3, longInput: 6 }),
    };
    const discovery = await refreshAutomaticPricing({
      homeDir,
      force: true,
      now: new Date("2026-10-01T12:00:00Z"),
      usedModels: ["gpt-test-over-capacity", "gpt-test-at-capacity"],
      pricingFetcher: discoveryFetch(modelsDev, liteLLM),
    });
    const cached = getAutomaticPricingStatus();
    assert.equal(getPricingCatalog().models["manual-test-12"].short.input, 2);
    assert.deepEqual(discovery.discovery.addedModels, ["gpt-test-at-capacity"]);
    assert.equal(getPricingCatalog().models["gpt-test-at-capacity"].short.input, 2);
    assert.equal(getPricingCatalog().models["gpt-6-sol"].short.input, 3);
    assert.equal(getPricingCatalog().models["gpt-test-over-capacity"], undefined);
    assert.ok(
      cached.discoveryResults.some(
        (item) => item.model === "gpt-test-over-capacity" && item.reason === "catalog-capacity",
      ),
    );
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("automatic updates are cached and leave edited rates and exchange rate intact", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-auto-pricing-"));
  try {
    await loadPricingFile({ homeDir });
    const calls = [];
    const fetcher = stubFetch(modelCatalog(3, 12), 6.8, calls);
    const first = await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-09-28T08:00:00Z"),
      pricingFetcher: fetcher,
    });
    assert.equal(first.changed, true);
    assert.equal(first.automaticModelCount, 34);
    assert.equal(first.totalModelCount, Object.keys(getDefaultPricingCatalog().models).length);
    assert.equal(first.unmatchedModelCount, first.totalModelCount - 34);
    assert.equal(first.priceUpdateSummary.attemptedModelCount, 99);
    assert.equal(first.priceUpdateSummary.verifiedModelCount, 34);
    assert.equal(first.priceUpdateSummary.unsupportedCurrencyModelCount, 4);
    assert.equal(first.priceUpdateSummary.fetchedSourceCount, 6);
    assert.ok(first.automaticModels.includes("glm-5.3"));
    assert.ok(first.automaticModels.includes("glm-5.1"));
    assert.ok(first.automaticModels.includes("kimi-k3"));
    assert.ok(first.automaticModels.includes("mimo-v2.6-pro"));
    assert.ok(first.automaticModels.includes("step-5-preview"));
    assert.deepEqual(calls, [
      MODEL_PRICES_URL,
      LITELLM_PRICES_URL,
      MIMO_PRICES_URL,
      STEPFUN_PRICES_URL,
      KIMI_PRICES_URL,
      GLM_PRICES_URL,
      USD_CNY_RATE_URL,
    ]);
    assert.equal(getPricingCatalog().models["gpt-6-sol"].short.input, 3);
    assert.equal(getPricingCatalog().models["gpt-6-sol"].fast.short.input, 4);
    assert.equal(getPricingCatalog().models["mimo-v2.6-pro"].currency, "CNY");
    assert.equal(first.modelMetadata["mimo-v2.6-pro"].short.sourceUrl, MIMO_PRICES_URL);
    assert.equal(getPricingCatalog().models["glm-5.1"].longContextThreshold, 32_000);
    assert.equal(first.modelMetadata["glm-5.1"].long.sourceUrl, GLM_PRICES_URL);
    assert.equal(getPricingCatalog().usdToCnyRate, 6.8);
    await refreshAutomaticPricing({ homeDir, now: new Date("2026-09-28T09:00:00Z"), pricingFetcher: fetcher });
    assert.equal(calls.length, 7);

    const edited = getPricingCatalog();
    edited.checkedAt = "2026-09-28";
    edited.models["gpt-6-sol"].short.input = 11;
    edited.usdToCnyRate = 7.1;
    await savePricingFile({ homeDir }, edited);
    const saved = JSON.parse(await readFile(pricingFile({ homeDir }), "utf8"));
    assert.equal(saved.schemaVersion, 2);
    assert.equal(saved.modelOverrides["gpt-6-sol"].short.input, 11);
    assert.equal(saved.modelOverrides["gpt-6-sol"].short.output, undefined);
    assert.deepEqual(getAutomaticPricingStatus().manualModels, ["gpt-6-sol"]);

    await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-09-29T09:00:00Z"),
      pricingFetcher: stubFetch(modelCatalog(5, 20), 6.9, calls),
    });
    assert.equal(getPricingCatalog().models["gpt-6-sol"].short.input, 11);
    assert.equal(getPricingCatalog().models["gpt-6-sol"].short.output, 20);
    assert.equal(getPricingCatalog().usdToCnyRate, 7.1);
    await loadPricingFile({ homeDir });
    assert.equal(getPricingCatalog().models["gpt-6-sol"].short.input, 11);
    assert.equal(getPricingCatalog().models["gpt-6-sol"].short.output, 20);
    assert.equal(getAutomaticPricingStatus().manualExchangeRate, true);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("restoring the automatic exchange rate is explicit and preserves manual model prices", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-auto-restore-rate-"));
  try {
    await loadPricingFile({ homeDir });
    await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-09-28T12:00:00Z"),
      pricingFetcher: discoveryFetch(modelCatalog(3, 12), {}, [], 6.8),
    });

    const edited = getPricingCatalog();
    edited.usdToCnyRate = 7.1;
    edited.models["gpt-6-sol"].short.input = 9;
    await savePricingFile({ homeDir }, edited);
    assert.equal(getAutomaticPricingStatus().manualExchangeRate, true);

    await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-09-29T12:00:00Z"),
      pricingFetcher: discoveryFetch(modelCatalog(5, 20), {}, [], 6.9),
    });
    const staleDraft = getPricingCatalog();
    staleDraft.usdToCnyRate = 6.8;
    await savePricingFile({ homeDir }, staleDraft, { restoreAutomaticExchangeRate: true });

    assert.equal(getPricingCatalog().usdToCnyRate, 6.9, "restore intent follows the latest automatic rate");
    assert.equal(getPricingCatalog().models["gpt-6-sol"].short.input, 9, "model overrides remain intact");
    assert.equal(getAutomaticPricingStatus().manualExchangeRate, false);
    const saved = JSON.parse(await readFile(pricingFile({ homeDir }), "utf8"));
    assert.equal(saved.usdToCnyRate, undefined);
    assert.equal(saved.modelOverrides["gpt-6-sol"].short.input, 9);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("equal official rates verify coverage while unsupported context tiers remain local", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-auto-equal-rates-"));
  try {
    await loadPricingFile({ homeDir });
    const result = await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-09-30T12:00:00Z"),
      pricingFetcher: discoveryFetch(modelCatalog(2, 10)),
    });
    assert.equal(result.pricesUpdated, true, "the verified provider context threshold is saved");
    assert.equal(result.changed, true);
    assert.ok(result.automaticModels.includes("gpt-6-sol"));
    assert.equal(result.priceUpdateSummary.verifiedModelCount, 34);
    assert.equal(result.priceUpdateSummary.changedModelCount, 1, "only the newly verified context threshold changed");
    assert.equal(result.priceUpdateSummary.partialModelCount, 1, "the provider has no matching fast-tier quote");
    assert.equal(result.modelMetadata["gpt-6-sol"].short.providerId, "openai");
    assert.equal(getPricingCatalog().models["glm-4.7"].longContextThreshold, 32_000);
    assert.equal(result.modelMetadata["glm-4.7"]?.long?.sourceUrl, undefined);
    assert.equal(getPricingCatalog().models["glm-5.1"].longContextThreshold, 32_000);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("price-source timeout keeps successful matches and retries the partial update", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-auto-pricing-partial-"));
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url === LITELLM_PRICES_URL) {
      const error = new Error("Timed out after 30s.");
      error.code = "PRICING_TIMEOUT";
      error.timeoutMs = 30_000;
      throw error;
    }
    return stubFetch(modelCatalog(3, 12), 6.8, [])(url);
  };
  try {
    await loadPricingFile({ homeDir });
    const result = await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-09-28T08:00:00Z"),
      pricingFetcher: fetcher,
    });
    assert.equal(result.pricesUpdated, true);
    assert.equal(result.exchangeRateUpdated, true);
    assert.deepEqual(result.issues, [
      {
        category: "prices",
        source: "LiteLLM",
        code: "timeout",
        message: "Timed out after 30s.",
        timeoutMs: 30_000,
      },
    ]);
    assert.match(result.errors[0], /LiteLLM.*Timed out/);
    assert.ok(result.automaticModels.includes("gpt-6-sol"));
    await refreshAutomaticPricing({ homeDir, now: new Date("2026-09-28T08:30:00Z"), pricingFetcher: fetcher });
    assert.equal(calls.length, 7);
    await refreshAutomaticPricing({ homeDir, now: new Date("2026-09-28T09:01:00Z"), pricingFetcher: fetcher });
    assert.equal(calls.length, 13);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("catalog fetch reports an identifiable timeout", async () => {
  const waitingFetch = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      // A real pending request keeps Node alive; AbortSignal.timeout alone is unref'ed.
      const pendingRequest = setTimeout(() => reject(new Error("Request did not abort")), 1_000);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(pendingRequest);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  await assert.rejects(fetchPricingJson(waitingFetch, MODEL_PRICES_URL, { timeoutMs: 10 }), (error) => {
    assert.equal(error.code, "PRICING_TIMEOUT");
    assert.equal(error.timeoutMs, 10);
    return true;
  });
});

test("MiMo pricing pages are fetched as bounded HTML text", async () => {
  const page = mimoPricingPage();
  let request;
  const result = await fetchPricingText(
    async (_url, options) => {
      request = options;
      return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
    },
    MIMO_PRICES_URL,
    { timeoutMs: 1_000 },
  );
  assert.equal(result, page);
  assert.equal(request.headers.accept, "text/html");
  assert.ok(request.signal instanceof AbortSignal);
});

test("failed online updates retain local prices and retry after an hour", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-auto-pricing-failure-"));
  let calls = 0;
  const failingFetch = async () => {
    calls += 1;
    throw new Error("offline");
  };
  try {
    await loadPricingFile({ homeDir });
    const initial = getPricingCatalog();
    const result = await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-09-28T08:00:00Z"),
      pricingFetcher: failingFetch,
    });
    assert.equal(result.changed, false);
    assert.equal(result.errors.length, 7);
    assert.equal(getPricingCatalog().usdToCnyRate, initial.usdToCnyRate);
    await refreshAutomaticPricing({ homeDir, now: new Date("2026-09-28T08:30:00Z"), pricingFetcher: failingFetch });
    assert.equal(calls, 7);
    await refreshAutomaticPricing({ homeDir, now: new Date("2026-09-28T09:01:00Z"), pricingFetcher: failingFetch });
    assert.equal(calls, 14);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("legacy default exchange rate does not block automatic exchange updates", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-legacy-auto-rate-"));
  try {
    const legacy = getDefaultPricingCatalog();
    legacy.models["gpt-6-sol"].short.input = 9;
    await mkdir(path.dirname(pricingFile({ homeDir })), { recursive: true });
    await writeFile(pricingFile({ homeDir }), JSON.stringify(legacy));
    await loadPricingFile({ homeDir });
    await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-09-28T08:00:00Z"),
      pricingFetcher: stubFetch({}, 6.83, []),
    });
    assert.equal(getPricingCatalog().models["gpt-6-sol"].short.input, 9);
    assert.equal(getPricingCatalog().usdToCnyRate, 6.83);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("a failed refresh retries after an hour even when an older cache exists", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-auto-retry-"));
  try {
    await loadPricingFile({ homeDir });
    await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-09-28T08:00:00Z"),
      pricingFetcher: stubFetch(modelCatalog(3, 12), 6.8, []),
    });
    let calls = 0;
    const failingFetch = async () => {
      calls += 1;
      throw new Error("offline");
    };
    await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-09-29T08:01:00Z"),
      pricingFetcher: failingFetch,
    });
    await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-09-29T08:30:00Z"),
      pricingFetcher: failingFetch,
    });
    assert.equal(calls, 7);
    await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-09-29T09:02:00Z"),
      pricingFetcher: failingFetch,
    });
    assert.equal(calls, 14);
    assert.equal(getPricingCatalog().usdToCnyRate, 6.8);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});
