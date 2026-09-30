export const MODEL_PRICES_URL = "https://models.dev/api.json";
export const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const STEPFUN_PRICES_URL = "https://platform.stepfun.com/docs/zh/guides/pricing/details";
export const MIMO_PRICES_URL = "https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go";
export const KIMI_PRICES_URL = "https://platform.kimi.com/docs/pricing/chat";
export const GLM_PRICES_URL = "https://docs.bigmodel.cn/cn/guide/start/pricing";
export const USD_CNY_RATE_URL = "https://api.frankfurter.dev/v2/rate/usd/cny";
export const AUTO_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const AUTO_RETRY_INTERVAL_MS = 60 * 60 * 1000;
export const PRICE_FETCH_TIMEOUT_MS = 30_000;
export const RATE_FETCH_TIMEOUT_MS = 10_000;

function finitePrice(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10_000;
}

function finiteRate(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10_000;
}

const MODELS_DEV_SOURCE_PROVIDERS = [
  ["developers.openai.com", "openai"],
  ["openai.com", "openai"],
  ["docs.x.ai", "xai"],
  ["x.ai", "xai"],
  ["ai.google.dev", "google"],
  ["qwencloud.com", "alibaba"],
  ["platform.minimax.io", "minimax"],
  ["dev.meta.ai", "meta"],
  ["platform.stepfun.com", "stepfun"],
  ["mimo.mi.com", "mimo"],
  ["platform.kimi.com", "kimi"],
  ["bigmodel.cn", "glm"],
];

const CNY_PRICE_SOURCE_MODELS = {
  stepfun: {
    source: STEPFUN_PRICES_URL,
    models: new Set(["step-5-preview", "step-3.7-flash", "step-3.5-flash", "step-3.5-flash-2603"]),
  },
  mimo: {
    source: MIMO_PRICES_URL,
    models: new Set(["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed", "mimo-v2.5-pro", "mimo-v2.5"]),
  },
  kimi: {
    source: KIMI_PRICES_URL,
    models: new Set(["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6"]),
  },
  glm: {
    source: GLM_PRICES_URL,
    models: new Set([
      "glm-5.3",
      "glm-5.3-flash",
      "glm-5.3-flashx",
      "glm-5.2",
      "glm-5.1",
      "glm-5-turbo",
      "glm-5",
      "glm-4.7-flashx",
      "glm-4.7-flash",
      "glm-4-plus",
      "glm-4-air-250414",
      "glm-4-airx",
      "glm-4-long",
      "glm-4-assistant",
      "glm-z1-air",
      "glm-z1-airx",
      "glm-z1-flashx",
      "glm-4-flashx-250414",
      "glm-4-flash-250414",
      "glm-z1-flash",
    ]),
  },
};

const MIMO_REALTIME_MODELS = CNY_PRICE_SOURCE_MODELS.mimo.models;

function providerFromOfficialSource(source) {
  if (typeof source !== "string") return null;
  let hostname;
  try {
    const url = new URL(source);
    if (url.protocol !== "https:") return null;
    hostname = url.hostname.toLowerCase();
  } catch {
    return null;
  }
  return (
    MODELS_DEV_SOURCE_PROVIDERS.find(([domain]) => hostname === domain || hostname.endsWith(`.${domain}`))?.[1] || null
  );
}

/** Return the provider identity carried by a verified provider/source mapping. */
const MODELS_DEV_PROVIDER_IDS = new Set(MODELS_DEV_SOURCE_PROVIDERS.map(([, provider]) => provider));

export function pricingSourceProviderFor(model, entry, knownProvider = null) {
  if (MODELS_DEV_PROVIDER_IDS.has(knownProvider)) return knownProvider;
  const sourceProvider = providerFromOfficialSource(entry?.source);
  if (sourceProvider) return sourceProvider;

  // OpenAI discovery entries retain their exact provider identity through the
  // automatic cache; the prefix is accepted only for this first-party API.
  if (String(model).toLowerCase().startsWith("gpt-")) return "openai";
  return null;
}

/** Return a provider only when the catalog entry identifies a USD API surface. */
export function pricingProviderFor(model, entry, knownProvider = null) {
  if ((entry?.currency || "USD").toUpperCase() !== "USD") return null;
  const provider = pricingSourceProviderFor(model, entry, knownProvider);
  return ["stepfun", "mimo", "kimi", "glm"].includes(provider) ? null : provider;
}

function exactProviderModel(providerModels, model) {
  if (!providerModels || typeof providerModels !== "object" || Array.isArray(providerModels)) return null;
  if (Object.hasOwn(providerModels, model)) return providerModels[model];
  const normalized = String(model).toLowerCase();
  const matches = Object.keys(providerModels).filter((key) => key.toLowerCase() === normalized);
  return matches.length === 1 ? providerModels[matches[0]] : null;
}

export function pricingSourceCoverage(models = {}, knownProviders = {}) {
  const providers = {};
  let supportedUsdModelCount = 0;
  let supportedCnyModelCount = 0;
  let unsupportedCurrencyModelCount = 0;
  for (const [model, entry] of Object.entries(models || {})) {
    const currency = (entry?.currency || "USD").toUpperCase();
    if (currency === "CNY") {
      const provider = pricingSourceProviderFor(model, entry, knownProviders[model]);
      const adapter = CNY_PRICE_SOURCE_MODELS[provider];
      if (adapter?.models.has(model.toLowerCase()) && entry?.source === adapter.source) {
        supportedCnyModelCount += 1;
        providers[provider] = (providers[provider] || 0) + 1;
      } else {
        unsupportedCurrencyModelCount += 1;
      }
      continue;
    }
    if (currency !== "USD") {
      unsupportedCurrencyModelCount += 1;
      continue;
    }
    const provider = pricingProviderFor(model, entry, knownProviders[model]);
    if (!provider) continue;
    supportedUsdModelCount += 1;
    providers[provider] = (providers[provider] || 0) + 1;
  }
  return {
    totalModelCount: Object.keys(models || {}).length,
    supportedModelCount: supportedUsdModelCount + supportedCnyModelCount,
    supportedUsdModelCount,
    supportedCnyModelCount,
    unsupportedCurrencyModelCount,
    providers,
  };
}

function newRatesWithMetadata(cost, previous) {
  if (!cost || !finitePrice(cost.input) || !finitePrice(cost.output)) return null;
  const inheritedFields = [];
  const cachedInput = finitePrice(cost.cache_read) ? cost.cache_read : previous.cachedInput;
  const cacheWrite = finitePrice(cost.cache_write) ? cost.cache_write : previous.cacheWrite;
  if (!finitePrice(cost.cache_read)) inheritedFields.push("cachedInput");
  if (!finitePrice(cost.cache_write)) inheritedFields.push("cacheWrite");
  return {
    rates: { input: cost.input, cachedInput, cacheWrite, output: cost.output },
    metadata: {
      origin: inheritedFields.length ? "mixed" : "remote",
      inheritedFields,
      providedFields: [
        "input",
        "output",
        ...(finitePrice(cost.cache_read) ? ["cachedInput"] : []),
        ...(finitePrice(cost.cache_write) ? ["cacheWrite"] : []),
      ],
    },
  };
}

function perMillion(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value * 1_000_000 : null;
}

function liteLLMRatesWithMetadata(row, previous, suffix = "") {
  const rates = strictLiteLLMRates(row, suffix);
  if (rates)
    return {
      rates,
      metadata: {
        origin: "remote",
        inheritedFields: [],
        providedFields: ["input", "cachedInput", "cacheWrite", "output"],
      },
    };
  const input = perMillion(row?.[`input_cost_per_token${suffix}`]);
  const output = perMillion(row?.[`output_cost_per_token${suffix}`]);
  if (!finitePrice(input) || !finitePrice(output)) return null;
  const cached = perMillion(row?.[`cache_read_input_token_cost${suffix}`]);
  const write = perMillion(row?.[`cache_creation_input_token_cost${suffix}`]);
  const inheritedFields = [];
  if (!finitePrice(cached)) inheritedFields.push("cachedInput");
  if (!finitePrice(write)) inheritedFields.push("cacheWrite");
  return {
    rates: {
      input,
      cachedInput: finitePrice(cached) ? cached : previous.cachedInput,
      cacheWrite: finitePrice(write) ? write : previous.cacheWrite,
      output,
    },
    metadata: {
      origin: inheritedFields.length ? "mixed" : "remote",
      inheritedFields,
      providedFields: [
        "input",
        "output",
        ...(finitePrice(cached) ? ["cachedInput"] : []),
        ...(finitePrice(write) ? ["cacheWrite"] : []),
      ],
    },
  };
}

function contextTiers(cost) {
  if (!Array.isArray(cost?.tiers)) return [];
  return cost.tiers.filter(
    (tier) => tier?.tier?.type === "context" && Number.isInteger(tier.tier.size) && tier.tier.size > 0,
  );
}

function liteLLMContextSuffixes(row) {
  const suffixes = new Set();
  for (const key of Object.keys(row || {})) {
    const match = /^input_cost_per_token_above_(\d+)k_tokens$/.exec(key);
    if (match) suffixes.add({ threshold: Number(match[1]) * 1000, suffix: `_above_${match[1]}k_tokens` });
  }
  return [...suffixes].sort((left, right) => left.threshold - right.threshold);
}

export function liteLLMPricePatches(payload, catalog) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid LiteLLM catalog.");
  const patches = {};
  for (const [model, entry] of Object.entries(catalog.models)) {
    if (pricingProviderFor(model, entry) !== "openai") continue;
    const row = payload[model] || payload[`openai/${model}`];
    if (row?.litellm_provider !== "openai") continue;
    const shortResult = liteLLMRatesWithMetadata(row, entry.short);
    if (!shortResult) continue;
    const patch = {
      short: shortResult.rates,
      source: LITELLM_PRICES_URL,
      __metadata: { short: { ...shortResult.metadata, sourceUrl: LITELLM_PRICES_URL } },
    };
    const originalLong = entry.long || entry.short;
    const tiers = liteLLMContextSuffixes(row);
    if (tiers.length === 1 && (!entry.longContextThreshold || entry.longContextThreshold === tiers[0].threshold)) {
      const longResult = liteLLMRatesWithMetadata(row, originalLong, tiers[0].suffix);
      if (longResult) {
        patch.long = longResult.rates;
        patch.longContextThreshold = tiers[0].threshold;
        patch.__metadata.long = { ...longResult.metadata, sourceUrl: LITELLM_PRICES_URL };
      }
    } else if (tiers.length === 0 && JSON.stringify(originalLong) === JSON.stringify(entry.short)) {
      patch.long = shortResult.rates;
      patch.__metadata.long = { ...shortResult.metadata, sourceUrl: LITELLM_PRICES_URL };
    }
    const fastShortResult =
      liteLLMRatesWithMetadata(row, entry.fast?.short || entry.short, "_priority") ||
      liteLLMRatesWithMetadata(row, entry.fast?.short || entry.short, "_fast");
    if (fastShortResult) {
      patch.fast = { short: fastShortResult.rates };
      patch.__metadata["fast.short"] = { ...fastShortResult.metadata, sourceUrl: LITELLM_PRICES_URL };
      if (tiers.length === 1 && tiers[0].threshold === 272_000) {
        const fastLongResult =
          liteLLMRatesWithMetadata(
            row,
            entry.fast?.long || entry.fast?.short || entry.long || entry.short,
            "_priority_above_272k_tokens",
          ) ||
          liteLLMRatesWithMetadata(
            row,
            entry.fast?.long || entry.fast?.short || entry.long || entry.short,
            "_fast_above_272k_tokens",
          );
        if (fastLongResult) {
          patch.fast.long = fastLongResult.rates;
          patch.__metadata["fast.long"] = { ...fastLongResult.metadata, sourceUrl: LITELLM_PRICES_URL };
        }
      }
    }
    patches[model] = patch;
  }
  return patches;
}

// Only exact provider/model IDs are used. The upstream catalog quotes USD per
// million tokens; CNY entries and uncertain aliases retain their local rates.
export function modelsDevPricePatches(payload, catalog, { providerByModel = {} } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid model catalog.");
  const patches = {};
  for (const [model, entry] of Object.entries(catalog.models)) {
    const provider = pricingProviderFor(model, entry, providerByModel[model]);
    const remote = provider && exactProviderModel(payload[provider]?.models, model);
    if (!remote) continue;
    const shortResult = newRatesWithMetadata(remote.cost, entry.short);
    if (!shortResult) continue;
    const patch = {
      short: shortResult.rates,
      source: MODEL_PRICES_URL,
      __metadata: {
        short: { ...shortResult.metadata, sourceUrl: MODEL_PRICES_URL, providerId: provider },
      },
    };
    const originalLong = entry.long || entry.short;
    const tiers = contextTiers(remote.cost);
    if (tiers.length === 1 && (!entry.longContextThreshold || entry.longContextThreshold === tiers[0].tier.size)) {
      const longResult = newRatesWithMetadata(tiers[0], originalLong);
      if (longResult) {
        patch.long = longResult.rates;
        patch.longContextThreshold = tiers[0].tier.size;
        patch.__metadata.long = { ...longResult.metadata, sourceUrl: MODEL_PRICES_URL, providerId: provider };
      }
    } else if (tiers.length === 0 && JSON.stringify(originalLong) === JSON.stringify(entry.short)) {
      patch.long = shortResult.rates;
      patch.__metadata.long = { ...shortResult.metadata, sourceUrl: MODEL_PRICES_URL, providerId: provider };
    }
    const fastCost = remote.cost?.fast || remote.cost?.priority || remote.fast || remote.priority;
    if (fastCost && typeof fastCost === "object") {
      const fastCostRates = fastCost.cost || fastCost;
      const fastShortResult = newRatesWithMetadata(fastCostRates, entry.fast?.short || entry.short);
      if (fastShortResult) {
        patch.fast = { short: fastShortResult.rates };
        patch.__metadata["fast.short"] = {
          ...fastShortResult.metadata,
          sourceUrl: MODEL_PRICES_URL,
          providerId: provider,
        };
      }
      const fastTiers = contextTiers(fastCostRates);
      if (
        fastTiers.length === 1 &&
        fastTiers[0].tier.size === (patch.longContextThreshold || entry.longContextThreshold)
      ) {
        const fastLongResult = newRatesWithMetadata(
          fastTiers[0],
          entry.fast?.long || entry.fast?.short || entry.long || entry.short,
        );
        if (fastLongResult) {
          patch.fast ||= {};
          patch.fast.long = fastLongResult.rates;
          patch.__metadata["fast.long"] = {
            ...fastLongResult.metadata,
            sourceUrl: MODEL_PRICES_URL,
            providerId: provider,
          };
        }
      }
    }
    patches[model] = patch;
  }
  return patches;
}

function htmlCellText(html) {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#yen;|&yen;/gi, "¥")
    .replace(/\s+/g, " ")
    .trim();
}

function mimoPriceNumber(cell) {
  const match = /[¥￥]\s*(\d+(?:\.\d+)?)/u.exec(cell);
  if (!match) return null;
  const value = Number(match[1]);
  return finitePrice(value) ? value : null;
}

function cnyTableNumber(cell) {
  if (/免费|不支持|—|-/u.test(cell)) return null;
  const normalized = cell.replace(/,/g, "").match(/\d+(?:\.\d+)?/u)?.[0];
  if (!normalized) return null;
  const value = Number(normalized);
  return finitePrice(value) ? value : null;
}

/**
 * @param {{ input: number, cachedInput: number, cacheWrite: number, output: number }} rates
 * @param {string} sourceUrl
 * @param {string} providerId
 * @param {{ longRates?: { input: number, cachedInput: number, cacheWrite: number, output: number }, longContextThreshold?: number }} [options]
 */
function officialCnyPatch(rates, sourceUrl, providerId, { longRates = rates, longContextThreshold } = {}) {
  const metadata = {
    origin: "remote",
    inheritedFields: [],
    providedFields: ["input", "cachedInput", "cacheWrite", "output"],
    sourceUrl,
    providerId,
  };
  return {
    short: rates,
    long: longRates,
    source: sourceUrl,
    ...(Number.isInteger(longContextThreshold) ? { longContextThreshold } : {}),
    __metadata: { short: { ...metadata }, long: { ...metadata } },
  };
}

/** Parse StepFun's official 1M-token real-time input/cache/output tables. */
export function stepFunPricePatches(payload, catalog) {
  if (typeof payload !== "string" || !payload.includes("计费单位")) {
    throw new Error("Invalid StepFun pricing page.");
  }
  const expected = Object.entries(catalog.models || {}).filter(
    ([model, entry]) =>
      (entry?.currency || "USD").toUpperCase() === "CNY" &&
      entry?.source === STEPFUN_PRICES_URL &&
      CNY_PRICE_SOURCE_MODELS.stepfun.models.has(model.toLowerCase()),
  );
  const ratesByModel = new Map();
  for (const tableMatch of payload.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/giu)) {
    const table = tableMatch[1];
    const tableText = htmlCellText(table);
    if (
      !/计费单位/u.test(tableText) ||
      !/输入价格\s*[（(]?缓存未命中/u.test(tableText) ||
      !/输入价格\s*[（(]?缓存命中/u.test(tableText) ||
      !/输出价格/u.test(tableText)
    )
      continue;
    for (const rowMatch of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)) {
      const cells = [...rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/giu)].map((match) =>
        htmlCellText(match[1]),
      );
      const model = cells[0]?.toLowerCase();
      if (
        !model ||
        !CNY_PRICE_SOURCE_MODELS.stepfun.models.has(model) ||
        cells[1]?.toLowerCase() !== "1m tokens" ||
        cells.length < 5
      )
        continue;
      const [input, cachedInput, output] = cells.slice(2, 5).map(cnyTableNumber);
      if ([input, cachedInput, output].some((value) => value === null)) continue;
      ratesByModel.set(model, { input, cachedInput, cacheWrite: 0, output });
    }
  }

  const patches = {};
  for (const [model] of expected) {
    const rates = ratesByModel.get(model.toLowerCase());
    if (rates) patches[model] = officialCnyPatch(rates, STEPFUN_PRICES_URL, "stepfun");
  }
  if (Object.keys(patches).length !== expected.length || !expected.length) {
    throw new Error(`StepFun price table matched ${Object.keys(patches).length}/${expected.length} supported models.`);
  }
  return patches;
}

/** Parse only the official Mainland China real-time token table, never Batch or overseas rates. */
export function mimoPricePatches(payload, catalog) {
  if (typeof payload !== "string" || !payload.includes("模型国内定价")) {
    throw new Error("Invalid MiMo pricing page.");
  }
  if (!/元\s*\/\s*百万\s*tokens/iu.test(payload) || !payload.includes("缓存写入") || !payload.includes("限时免费")) {
    throw new Error("MiMo pricing unit or cache-write rule changed.");
  }
  const headingIndex = payload.indexOf("模型国内定价");
  const tableStart = payload.indexOf("<table", headingIndex);
  const tableEnd = payload.indexOf("</table>", tableStart);
  if (tableStart < 0 || tableEnd < 0) throw new Error("MiMo domestic pricing table is missing.");
  const domesticTable = payload.slice(tableStart, tableEnd + "</table>".length);
  const ratesByModel = new Map();
  let inferenceMode = null;
  for (const rowMatch of domesticTable.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)) {
    const cells = [...rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/giu)].map((match) =>
      htmlCellText(match[1]),
    );
    if (!cells.length) continue;
    if (cells.some((cell) => cell.includes("实时推理"))) inferenceMode = "realtime";
    else if (cells.some((cell) => cell.includes("批量推理"))) inferenceMode = "batch";
    if (inferenceMode !== "realtime") continue;
    const modelCellIndex = cells.findIndex((cell) => /mimo-v\d/i.test(cell));
    if (modelCellIndex < 0) continue;
    const priceCells = cells.slice(modelCellIndex + 1, modelCellIndex + 4);
    if (priceCells.length !== 3) continue;
    const [cachedInput, input, output] = priceCells.map(mimoPriceNumber);
    if ([cachedInput, input, output].some((value) => value === null)) continue;
    const rates = { input, cachedInput, cacheWrite: 0, output };
    for (const match of cells[modelCellIndex].matchAll(/\bmimo-v\d[a-z0-9.-]*\b/giu)) {
      const model = match[0].toLowerCase();
      if (MIMO_REALTIME_MODELS.has(model)) ratesByModel.set(model, rates);
    }
  }

  const patches = {};
  for (const [model, entry] of Object.entries(catalog.models || {})) {
    if (
      (entry?.currency || "USD").toUpperCase() !== "CNY" ||
      entry?.source !== MIMO_PRICES_URL ||
      !MIMO_REALTIME_MODELS.has(model.toLowerCase())
    )
      continue;
    const rates = ratesByModel.get(model.toLowerCase());
    if (!rates) continue;
    patches[model] = officialCnyPatch(rates, MIMO_PRICES_URL, "mimo");
  }
  const expectedCount = Object.entries(catalog.models || {}).filter(
    ([model, entry]) =>
      (entry?.currency || "USD").toUpperCase() === "CNY" &&
      entry?.source === MIMO_PRICES_URL &&
      MIMO_REALTIME_MODELS.has(model.toLowerCase()),
  ).length;
  if (Object.keys(patches).length !== expectedCount || !expectedCount) {
    throw new Error(`MiMo price table matched ${Object.keys(patches).length}/${expectedCount} supported models.`);
  }
  return patches;
}

/** Parse the exact model rows embedded in Kimi's official pricing DocTable. */
export function kimiPricePatches(payload, catalog) {
  if (
    typeof payload !== "string" ||
    !payload.includes("此处 1M = 1,000,000") ||
    !payload.includes("缓存写入（TTL 5min）")
  ) {
    throw new Error("Kimi pricing units or cache rules changed.");
  }
  const expected = Object.entries(catalog.models || {}).filter(
    ([model, entry]) =>
      (entry?.currency || "USD").toUpperCase() === "CNY" &&
      entry?.source === KIMI_PRICES_URL &&
      CNY_PRICE_SOURCE_MODELS.kimi.models.has(model.toLowerCase()),
  );
  const ratesByModel = new Map();
  const rows = /\[\s*`([^`]+)`\s*,\s*`1M tokens`\s*,\s*((?:`[^`]*`\s*,\s*){2,5}`[^`]*`)\s*\]/gu;
  for (const match of payload.matchAll(rows)) {
    const model = match[1].toLowerCase();
    if (!CNY_PRICE_SOURCE_MODELS.kimi.models.has(model)) continue;
    const values = [...match[2].matchAll(/`([^`]*)`/gu)].map((value) => value[1]);
    const prices = values.map(cnyTableNumber);
    if (model === "kimi-k3" && prices.length === 6) {
      const [cacheWrite, , cachedInput, input, output] = prices;
      if ([cacheWrite, cachedInput, input, output].some((value) => value === null)) continue;
      ratesByModel.set(model, { input, cachedInput, cacheWrite, output });
    } else if (model !== "kimi-k3" && prices.length === 4) {
      const [cachedInput, input, output] = prices;
      if ([cachedInput, input, output].some((value) => value === null)) continue;
      ratesByModel.set(model, { input, cachedInput, cacheWrite: 0, output });
    }
  }

  const patches = {};
  for (const [model] of expected) {
    const rates = ratesByModel.get(model.toLowerCase());
    if (rates) patches[model] = officialCnyPatch(rates, KIMI_PRICES_URL, "kimi");
  }
  if (Object.keys(patches).length !== expected.length || !expected.length) {
    throw new Error(`Kimi price page matched ${Object.keys(patches).length}/${expected.length} supported models.`);
  }
  return patches;
}

function glmZeroOrRate(cell, { unsupportedIsZero = false } = {}) {
  if (/免费/u.test(cell) || (unsupportedIsZero && /不支持/u.test(cell))) return 0;
  return cnyTableNumber(cell);
}

/** Parse GLM's official per-million-token table, including only input-length tiers the catalog can express. */
export function glmPricePatches(payload, catalog) {
  if (
    typeof payload !== "string" ||
    !payload.includes("输入单价（元/百万 Tokens）") ||
    !payload.includes("输出单价（元/百万 Tokens）") ||
    !payload.includes("缓存存储（元/百万 Tokens/小时）") ||
    !payload.includes("缓存命中（元/百万 Tokens）")
  ) {
    throw new Error("GLM pricing units or cache fields changed.");
  }
  const expected = Object.entries(catalog.models || {}).filter(
    ([model, entry]) =>
      (entry?.currency || "USD").toUpperCase() === "CNY" &&
      entry?.source === GLM_PRICES_URL &&
      CNY_PRICE_SOURCE_MODELS.glm.models.has(model.toLowerCase()),
  );
  const rowsByModel = new Map();
  for (const tableMatch of payload.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/giu)) {
    const table = tableMatch[1];
    const tableText = htmlCellText(table);
    if (
      !tableText.includes("模型名称") ||
      !tableText.includes("输入单价") ||
      !tableText.includes("输出单价") ||
      !tableText.includes("缓存存储") ||
      !tableText.includes("缓存命中")
    )
      continue;
    for (const rowMatch of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)) {
      const cells = [...rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/giu)].map((match) =>
        htmlCellText(match[1]),
      );
      const model = cells[0]?.toLowerCase();
      if (!model || !CNY_PRICE_SOURCE_MODELS.glm.models.has(model) || cells.length < 6) continue;
      const [input, output, storage, cachedInput] = [
        glmZeroOrRate(cells[2]),
        glmZeroOrRate(cells[3]),
        /^(?:限时免费|免费)$/u.test(cells[4]) ? 0 : null,
        glmZeroOrRate(cells[5], { unsupportedIsZero: true }),
      ];
      if ([input, output, storage, cachedInput].some((value) => value === null)) continue;
      rowsByModel.set(model, [
        ...(rowsByModel.get(model) || []),
        { context: cells[1], rates: { input, cachedInput, cacheWrite: storage, output } },
      ]);
    }
  }

  const patches = {};
  for (const [model] of expected) {
    const rows = rowsByModel.get(model.toLowerCase()) || [];
    if (rows.length === 1 && /^\d+(?:k|m)$/iu.test(rows[0].context)) {
      patches[model] = officialCnyPatch(rows[0].rates, GLM_PRICES_URL, "glm");
      continue;
    }
    const shortRow = rows.find((row) => /^输入长度\s*\[\s*0\s*,\s*32k\s*\)$/iu.test(row.context));
    const longRow = rows.find((row) => /^输入长度\s*(?:≥|>=)\s*32k$/iu.test(row.context));
    if (rows.length === 2 && shortRow && longRow) {
      patches[model] = officialCnyPatch(shortRow.rates, GLM_PRICES_URL, "glm", {
        longRates: longRow.rates,
        longContextThreshold: 32_000,
      });
    }
  }

  if (Object.keys(patches).length !== expected.length || !expected.length) {
    throw new Error(
      `GLM price page matched ${Object.keys(patches).length}/${expected.length} safely supported models.`,
    );
  }
  return patches;
}

const UNIFORM_OPENAI_RATE_MODELS = new Set();
const RATE_TOLERANCE = 1e-7;

function strictModelsDevRates(source) {
  if (!source || typeof source !== "object") return null;
  const rates = {
    input: source.input,
    cachedInput: source.cache_read,
    cacheWrite: source.cache_write,
    output: source.output,
  };
  return Object.values(rates).every(finiteRate) ? rates : null;
}

function strictLiteLLMRates(row, suffix = "") {
  const rates = {
    input: perMillion(row?.[`input_cost_per_token${suffix}`]),
    cachedInput: perMillion(row?.[`cache_read_input_token_cost${suffix}`]),
    cacheWrite: perMillion(row?.[`cache_creation_input_token_cost${suffix}`]),
    output: perMillion(row?.[`output_cost_per_token${suffix}`]),
  };
  return Object.values(rates).every(finiteRate) ? rates : null;
}

function hasTextModality(entry) {
  const modalities = entry?.modalities;
  if (!modalities || typeof modalities !== "object") return true;
  for (const direction of ["input", "output"]) {
    const value = modalities[direction];
    if (value === undefined) continue;
    const values = Array.isArray(value)
      ? value.map((item) => String(item).toLowerCase())
      : [String(value).toLowerCase()];
    if (!values.includes("text")) return false;
  }
  return true;
}

function modelsDevNewCandidate(model, entry, uniformModels) {
  if (!entry || (entry.currency !== undefined && entry.currency !== "USD") || !hasTextModality(entry)) {
    return { reason: "unsupported-provider" };
  }
  const cost = entry.cost;
  const short = strictModelsDevRates(cost);
  if (!short) return { reason: "incomplete-rates" };
  const tiers = contextTiers(cost);
  if (tiers.length > 1) return { reason: "unsupported-context-policy" };
  let long = short;
  let longContextThreshold;
  if (tiers.length === 1) {
    long = strictModelsDevRates(tiers[0]);
    if (!long) return { reason: "incomplete-rates" };
    longContextThreshold = tiers[0].tier.size;
  } else if (!uniformModels.has(model) && cost?.context_policy !== "uniform") {
    return { reason: "context-policy-unknown" };
  }

  let fastShort = null;
  let fastLong = null;
  let fastSourceUrl = null;
  const fastEntry = cost?.fast || cost?.priority || entry.fast || entry.priority;
  if (fastEntry && typeof fastEntry === "object") {
    const fastCost = fastEntry.cost || fastEntry;
    fastShort = strictModelsDevRates(fastCost);
    const fastTiers = contextTiers(fastCost);
    if (fastTiers.length === 1 && fastTiers[0].tier.size === longContextThreshold)
      fastLong = strictModelsDevRates(fastTiers[0]);
    else if (fastTiers.length === 1) return { reason: "unsupported-context-policy" };
    if (fastTiers.length > 1) return { reason: "unsupported-context-policy" };
    if (!fastLong && fastTiers.length === 1) return { reason: "incomplete-rates" };
    if (fastShort) fastSourceUrl = MODEL_PRICES_URL;
    else fastLong = null;
  }
  return { short, long, longContextThreshold, fastShort, fastLong, sourceUrl: MODEL_PRICES_URL, fastSourceUrl };
}

function liteLLMNewCandidate(model, row, uniformModels) {
  if (row?.litellm_provider !== "openai" || (row.currency !== undefined && row.currency !== "USD")) {
    return { reason: "unsupported-provider" };
  }
  const short = strictLiteLLMRates(row);
  if (!short) return { reason: "incomplete-rates" };
  const tiers = liteLLMContextSuffixes(row);
  if (tiers.length > 1) return { reason: "unsupported-context-policy" };
  let long = short;
  let longContextThreshold;
  if (tiers.length === 1) {
    long = strictLiteLLMRates(row, tiers[0].suffix);
    if (!long) return { reason: "incomplete-rates" };
    longContextThreshold = tiers[0].threshold;
  } else if (!uniformModels.has(model) && row.context_policy !== "uniform") {
    return { reason: "context-policy-unknown" };
  }

  const fastShort = strictLiteLLMRates(row, "_priority") || strictLiteLLMRates(row, "_fast");
  let fastLong = null;
  if (fastShort && longContextThreshold === 272_000) {
    fastLong =
      strictLiteLLMRates(row, "_priority_above_272k_tokens") || strictLiteLLMRates(row, "_fast_above_272k_tokens");
  }
  return {
    short,
    long,
    longContextThreshold,
    fastShort,
    fastLong,
    sourceUrl: LITELLM_PRICES_URL,
    fastSourceUrl: fastShort ? LITELLM_PRICES_URL : null,
  };
}

function ratesEqual(left, right) {
  return left && right && Object.keys(left).every((key) => Math.abs(left[key] - right[key]) <= RATE_TOLERANCE);
}

function standardCandidatesEqual(left, right) {
  return (
    left.longContextThreshold === right.longContextThreshold &&
    ratesEqual(left.short, right.short) &&
    ratesEqual(left.long, right.long)
  );
}

function fastCandidatesEqual(left, right) {
  const sameOptionalRates = (first, second) =>
    first === null ? second === null : second !== null && ratesEqual(first, second);
  return sameOptionalRates(left.fastShort, right.fastShort) && sameOptionalRates(left.fastLong, right.fastLong);
}

function tierMetadata(sourceUrl, checkedAt, origin = "remote", inheritedFields = []) {
  return { sourceUrl: sourceUrl || null, checkedAt, origin, inheritedFields };
}

/**
 * Parse a first-seen OpenAI text model only when each required rate tier is evidenced.
 * @param {string} model
 * @param {{ modelsDevPayload?: object, liteLLMPayload?: object, checkedAt?: string, uniformModels?: Set<string> }} [options]
 */
export function parseOpenAIModelPricing(model, { modelsDevPayload, liteLLMPayload, checkedAt, uniformModels } = {}) {
  const normalized = String(model ?? "")
    .trim()
    .toLowerCase();
  if (
    !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(normalized) ||
    /(?:image|audio|transcription|\btts\b|embed|whisper|realtime|moderation)/i.test(normalized)
  ) {
    return { status: "rejected", reason: "unsupported-provider" };
  }
  const allowedUniformModels = uniformModels instanceof Set ? uniformModels : UNIFORM_OPENAI_RATE_MODELS;
  const modelsDevEntry = modelsDevPayload?.openai?.models?.[normalized];
  const liteLLMEntry = liteLLMPayload?.[normalized] || liteLLMPayload?.[`openai/${normalized}`];
  const liteProviderMismatch = liteLLMEntry && liteLLMEntry.litellm_provider !== "openai";
  if (!modelsDevEntry && !liteLLMEntry) return { status: "deferred", reason: "not-found" };
  if (liteProviderMismatch) return { status: "rejected", reason: "unsupported-provider" };

  const dev = modelsDevEntry && modelsDevNewCandidate(normalized, modelsDevEntry, allowedUniformModels);
  const lite = liteLLMEntry && liteLLMNewCandidate(normalized, liteLLMEntry, allowedUniformModels);
  const candidates = [dev, lite].filter((candidate) => candidate && !candidate.reason);
  if (!candidates.length) {
    if ([dev?.reason, lite?.reason].includes("unsupported-provider")) {
      return { status: "rejected", reason: "unsupported-provider" };
    }
    const reason =
      [dev?.reason, lite?.reason].find((item) => item === "unsupported-context-policy") ||
      [dev?.reason, lite?.reason].find((item) => item === "context-policy-unknown") ||
      [dev?.reason, lite?.reason].find((item) => item === "incomplete-rates") ||
      "not-found";
    return { status: "deferred", reason };
  }
  if (candidates.length === 2 && !standardCandidatesEqual(candidates[0], candidates[1])) {
    return { status: "rejected", reason: "conflict" };
  }

  const standard = dev && !dev.reason ? dev : lite;
  let fastSource = null;
  if (dev?.fastShort && lite?.fastShort && !fastCandidatesEqual(dev, lite)) {
    return { status: "rejected", reason: "conflict" };
  }
  if (dev?.fastShort) fastSource = dev;
  else if (lite?.fastShort) fastSource = lite;
  const fastShort =
    fastSource?.fastShort || Object.fromEntries(Object.entries(standard.short).map(([key, value]) => [key, value * 2]));
  const fastLong =
    fastSource?.fastLong || Object.fromEntries(Object.entries(standard.long).map(([key, value]) => [key, value * 2]));
  const at = checkedAt || new Date().toISOString();
  const pricing = {
    currency: "USD",
    source: standard.sourceUrl,
    short: standard.short,
    long: standard.long,
    fast: { short: fastShort, long: fastLong },
    ...(standard.longContextThreshold ? { longContextThreshold: standard.longContextThreshold } : {}),
  };
  const modelMetadata = {
    short: tierMetadata(standard.sourceUrl, at),
    long: tierMetadata(standard.sourceUrl, at),
    "fast.short": fastSource ? tierMetadata(fastSource.fastSourceUrl, at) : tierMetadata(null, at, "derived"),
    "fast.long": fastSource?.fastLong ? tierMetadata(fastSource.fastSourceUrl, at) : tierMetadata(null, at, "derived"),
  };
  return { status: "added", reason: null, model: normalized, pricing, modelMetadata };
}

export function frankfurterUsdCny(payload) {
  const rate = payload?.rate;
  const date = payload?.date;
  if (payload?.base !== "USD" || payload?.quote !== "CNY" || !finitePrice(rate) || rate < 1 || rate > 20)
    throw new Error("Invalid USD/CNY exchange rate.");
  const dateMs = typeof date === "string" ? Date.parse(`${date}T00:00:00Z`) : Number.NaN;
  if (
    typeof date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(dateMs) ||
    new Date(dateMs).toISOString().slice(0, 10) !== date
  )
    throw new Error("Invalid exchange rate date.");
  return { rate, date };
}

export async function fetchPricingJson(fetcher, url, options = {}) {
  const timeoutMs = options.timeoutMs ?? (url === USD_CNY_RATE_URL ? RATE_FETCH_TIMEOUT_MS : PRICE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length"));
    if (length > 10 * 1024 * 1024) throw new Error("Response is too large.");
    return await response.json();
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw Object.assign(new Error(`Timed out after ${timeoutMs / 1000}s.`), {
        code: "PRICING_TIMEOUT",
        timeoutMs,
      });
    }
    throw error;
  }
}

export async function fetchPricingText(fetcher, url, options = {}) {
  const timeoutMs = options.timeoutMs ?? PRICE_FETCH_TIMEOUT_MS;
  try {
    const response = await fetcher(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "text/html" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length"));
    if (length > 10 * 1024 * 1024) throw new Error("Response is too large.");
    const text = await response.text();
    if (text.length > 10 * 1024 * 1024) throw new Error("Response is too large.");
    return text;
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw Object.assign(new Error(`Timed out after ${timeoutMs / 1000}s.`), {
        code: "PRICING_TIMEOUT",
        timeoutMs,
      });
    }
    throw error;
  }
}
