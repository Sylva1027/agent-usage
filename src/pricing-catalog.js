import { canonicalModelName } from "../public/pricing-models.js";
import { pricingProvider } from "../public/pricing-directory.js";
import { MODEL_PRICES_URL, parseOpenAIModelPricing } from "./pricing-auto.js";

export const OPENROUTER_PRICES_URL = "https://openrouter.ai/api/v1/models";

function catalogIdentity(value) {
  return canonicalModelName(value, {})
    .toLowerCase()
    .replace(/^(claude-(?:opus|sonnet|haiku|fable)-\d+)\.(\d+)/, "$1-$2");
}

function exactModel(models, model) {
  const matches = Object.entries(models || {}).filter(([id]) => catalogIdentity(id) === model);
  return matches.length === 1 ? matches[0][1] : null;
}

function rate(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10_000;
}

function tokenPrice(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?(?:e-?\d+)?$/i.test(value)) return Number.NaN;
  const price = Number(value) * 1_000_000;
  return rate(price) ? price : Number.NaN;
}

function routerCost(pricing = {}) {
  return {
    input: tokenPrice(pricing.prompt),
    output: tokenPrice(pricing.completion),
    cache_read: tokenPrice(pricing.input_cache_read),
    cache_write: tokenPrice(pricing.input_cache_write),
  };
}

function candidate(
  cost,
  tiers,
  { source, providerId, checkedAt, providerName = undefined, cacheWriteTtl = undefined },
) {
  if (!rate(cost?.input) || !rate(cost?.output)) return { status: "deferred", reason: "incomplete-rates" };
  if (tiers.length > 1) return { status: "deferred", reason: "unsupported-context-policy" };
  const metadata = {};
  const rates = (value, tier) => {
    const inputFallbackFields = [];
    const optional = (key, field) => {
      if (value[key] !== undefined && !rate(value[key])) return Number.NaN;
      if (rate(value[key])) return value[key];
      inputFallbackFields.push(field);
      return value.input;
    };
    const result = {
      input: value.input,
      cachedInput: optional("cache_read", "cachedInput"),
      cacheWrite: optional("cache_write", "cacheWrite"),
      output: value.output,
    };
    metadata[tier] = {
      sourceUrl: source,
      providerId,
      ...(providerName ? { providerName } : {}),
      checkedAt,
      origin: source === OPENROUTER_PRICES_URL ? "reference" : "remote",
      inheritedFields: [],
      inputFallbackFields,
    };
    return Object.values(result).every(rate) ? result : null;
  };
  const short = rates(cost, "short");
  const long = tiers.length ? rates({ ...cost, ...tiers[0].cost }, "long") : short;
  if (!short || !long) return { status: "deferred", reason: "incomplete-rates" };
  if (!tiers.length) metadata.long = { ...metadata.short };
  return {
    status: "added",
    reason: null,
    pricing: {
      currency: "USD",
      source,
      short,
      long,
      ...(tiers.length ? { longContextThreshold: tiers[0].threshold } : {}),
      ...(cacheWriteTtl ? { cacheWriteTtl } : {}),
    },
    modelMetadata: metadata,
  };
}

function modelsDevCandidate(cost, options) {
  const tiers = cost?.tiers || [];
  if (
    !Array.isArray(tiers) ||
    tiers.some((tier) => tier?.tier?.type !== "context" || !Number.isInteger(tier.tier.size) || tier.tier.size <= 0)
  ) {
    return { status: "deferred", reason: "unsupported-context-policy" };
  }
  if (
    options.providerId === "anthropic" &&
    [cost, ...tiers].some(
      (tier) =>
        (tier?.cache_write_ttl !== undefined && tier.cache_write_ttl !== "5m") ||
        (rate(tier?.cache_write) && Math.abs(tier.cache_write - tier.input * 1.25) > 1e-7),
    )
  ) {
    return { status: "deferred", reason: "incomplete-rates" };
  }
  return candidate(
    cost,
    tiers.map((tier) => ({ threshold: tier.tier.size, cost: tier })),
    options,
  );
}

/**
 * Select exact first-party rows, then OpenRouter reference prices; never import unused rows.
 * @param {string} rawModel
 * @param {{ modelsDevPayload?: object, liteLLMPayload?: object, openRouterPayload?: object, checkedAt?: string }} [options]
 */
export function parseCatalogModelPricing(
  rawModel,
  { modelsDevPayload, liteLLMPayload, openRouterPayload, checkedAt } = {},
) {
  const model = catalogIdentity(rawModel);
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(model)) return { status: "rejected", reason: "unsupported-provider" };
  const provider = pricingProvider(model).id;
  const official = parseOpenAIModelPricing(model, { modelsDevPayload, liteLLMPayload, checkedAt });
  if (official.status === "added" || official.reason === "conflict") return official;
  const entry =
    provider !== "openai" && provider !== "other" ? exactModel(modelsDevPayload?.[provider]?.models, model) : null;
  if (
    entry &&
    (!entry.currency || entry.currency === "USD") &&
    (!entry.modalities?.output || (Array.isArray(entry.modalities.output) && entry.modalities.output.includes("text")))
  ) {
    const options = {
      source: MODEL_PRICES_URL,
      providerId: provider,
      checkedAt,
      cacheWriteTtl: provider === "anthropic" ? "5m" : undefined,
    };
    const parsed = modelsDevCandidate(entry.cost, options);
    const fast = entry.cost?.fast || entry.cost?.priority || entry.fast || entry.priority;
    if (parsed.status === "added" && fast) {
      const parsedFast = modelsDevCandidate(fast.cost || fast, options);
      if (parsedFast.status !== "added") return parsedFast;
      if (
        parsedFast.pricing.longContextThreshold !== undefined &&
        parsedFast.pricing.longContextThreshold !== parsed.pricing.longContextThreshold
      ) {
        return { status: "deferred", reason: "unsupported-context-policy" };
      }
      Object.assign(parsed.pricing, { fast: { short: parsedFast.pricing.short, long: parsedFast.pricing.long } });
      parsed.modelMetadata["fast.short"] = parsedFast.modelMetadata.short;
      parsed.modelMetadata["fast.long"] = parsedFast.modelMetadata.long;
    }
    if (parsed.status === "added") return parsed;
    if (parsed.reason === "unsupported-context-policy") return parsed;
  }
  const matches = (Array.isArray(openRouterPayload?.data) ? openRouterPayload.data : []).filter(
    (row) => typeof row?.id === "string" && catalogIdentity(row.id) === model,
  );
  if (matches.length !== 1) return provider === "openai" ? official : { status: "deferred", reason: "not-found" };
  const row = matches[0];
  if (!Array.isArray(row.architecture?.output_modalities) || !row.architecture.output_modalities.includes("text"))
    return { status: "rejected", reason: "unsupported-provider" };
  const prices = row.pricing;
  if (!prices || (prices.request !== undefined && Number(prices.request) !== 0))
    return { status: "deferred", reason: "incomplete-rates" };
  const overrides = prices.overrides || [];
  const keys = new Set(["min_prompt_tokens", "prompt", "completion", "input_cache_read", "input_cache_write"]);
  if (
    !Array.isArray(overrides) ||
    overrides.some(
      (tier) =>
        !Number.isInteger(tier?.min_prompt_tokens) ||
        tier.min_prompt_tokens <= 0 ||
        Object.keys(tier).some((key) => !keys.has(key)),
    )
  ) {
    return { status: "deferred", reason: "unsupported-context-policy" };
  }
  return candidate(
    routerCost(prices),
    overrides.map((tier) => ({ threshold: tier.min_prompt_tokens, cost: routerCost({ ...prices, ...tier }) })),
    {
      source: OPENROUTER_PRICES_URL,
      providerId: provider === "other" ? row.id.split("/")[0] : provider,
      checkedAt,
      providerName:
        provider === "other"
          ? typeof row.name === "string" && row.name.includes(":")
            ? row.name.split(":")[0].trim()
            : row.id.split("/")[0]
          : undefined,
      cacheWriteTtl: provider === "anthropic" ? "5m" : undefined,
    },
  );
}
