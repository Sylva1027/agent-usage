import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AUTO_REFRESH_INTERVAL_MS,
  AUTO_RETRY_INTERVAL_MS,
  fetchPricingText,
  fetchPricingJson,
  GLM_PRICES_URL,
  glmPricePatches,
  frankfurterUsdCny,
  LITELLM_PRICES_URL,
  liteLLMPricePatches,
  MIMO_PRICES_URL,
  mimoPricePatches,
  MODEL_PRICES_URL,
  modelsDevPricePatches,
  parseOpenAIModelPricing,
  KIMI_PRICES_URL,
  kimiPricePatches,
  STEPFUN_PRICES_URL,
  stepFunPricePatches,
  pricingSourceProviderFor,
  pricingSourceCoverage,
  USD_CNY_RATE_URL,
} from "./pricing-auto.js";
import {
  getDefaultPricingCatalog,
  getPricingCatalog,
  mergePricingCatalog,
  setPricingCatalog,
  validatePricingCatalog,
  MAX_PRICING_MODELS,
} from "./pricing.js";
import { resolvePricingModel } from "../public/pricing-models.js";

const RATE_FIELDS = ["input", "cachedInput", "cacheWrite", "output"];
export { MAX_PRICING_MODELS };
const PRICE_CONFLICT_TOLERANCE = 1e-7;

let automatic = {};
let manual = {};

export function pricingFile(options = {}) {
  return options.pricingFile || path.join(options.homeDir || os.homedir(), ".codex-usage", "pricing.json");
}

export function automaticPricingFile(options = {}) {
  return options.automaticPricingFile || path.join(path.dirname(pricingFile(options)), "pricing-auto.json");
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function overlay(base, patch) {
  const result = structuredClone(base);
  if (!isObject(patch)) return result;
  for (const [key, value] of Object.entries(patch)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    result[key] = isObject(value) && isObject(result[key]) ? overlay(result[key], value) : structuredClone(value);
  }
  return result;
}

function differences(base, current) {
  if (Array.isArray(base) && Array.isArray(current)) {
    return base.length === current.length &&
      base.every((value, index) => differences(value, current[index]) === undefined)
      ? undefined
      : current;
  }
  if (!isObject(base) || !isObject(current)) return Object.is(base, current) ? undefined : current;
  const result = {};
  for (const [key, value] of Object.entries(current)) {
    const difference = differences(base[key], value);
    if (difference !== undefined) result[key] = difference;
  }
  return Object.keys(result).length ? result : undefined;
}

function automaticBase() {
  const defaults = getDefaultPricingCatalog();
  return validatePricingCatalog({
    checkedAt: automatic.checkedAt || defaults.checkedAt,
    usdToCnyRate: automatic.usdToCnyRate || defaults.usdToCnyRate,
    models: overlay(defaults.models, automatic.models),
  });
}

function applyCurrent() {
  const base = automaticBase();
  const checkedAt =
    automatic.checkedAt && automatic.checkedAt > (manual.checkedAt || "")
      ? automatic.checkedAt
      : manual.checkedAt || base.checkedAt;
  return setPricingCatalog({
    checkedAt,
    usdToCnyRate: manual.usdToCnyRate ?? base.usdToCnyRate,
    models: overlay(base.models, manual.modelOverrides),
  });
}

function statusVersion() {
  const value = {
    modelMetadata: automatic.modelMetadata || {},
    discoveryResults: automatic.discoveryResults || [],
    discoveryAttemptedAt: automatic.discoveryAttemptedAt || {},
    priceUpdateSummary: automatic.priceUpdateSummary || null,
    priceAttemptedAt: automatic.priceAttemptedAt || null,
    exchangeRateAttemptedAt: automatic.exchangeRateAttemptedAt || null,
    issues: automatic.issues || [],
  };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
}

function effectivePriceVersion(catalog) {
  const models = Object.fromEntries(
    Object.keys(catalog.models)
      .sort()
      .map((model) => {
        const pricing = { ...catalog.models[model] };
        delete pricing.source;
        return [model, pricing];
      }),
  );
  return createHash("sha256")
    .update(JSON.stringify({ usdToCnyRate: catalog.usdToCnyRate, models }))
    .digest("hex");
}

function ratePatchAt(patch, tier) {
  if (tier === "fast.short") return patch?.fast?.short || null;
  if (tier === "fast.long") return patch?.fast?.long || null;
  return patch?.[tier] || null;
}

function metadataAt(patch, tier) {
  const saved = patch?.__metadata?.[tier];
  if (saved) return saved;
  return patch?.source
    ? { sourceUrl: patch.source, origin: "remote", inheritedFields: [], providedFields: RATE_FIELDS }
    : null;
}

function mergeRateTier(baseRates, existingMetadata, providerPatches, tier, checkedAt) {
  const sourceNames = ["Models.dev", "LiteLLM", "Xiaomi MiMo", "StepFun", "Kimi", "GLM"];
  const sources = providerPatches
    .map((patch, index) => ({
      rates: ratePatchAt(patch, tier),
      metadata: metadataAt(patch, tier),
      name: sourceNames[index],
    }))
    .filter((source) => source.rates && source.metadata);
  if (!sources.length) return { rates: baseRates, metadata: existingMetadata, conflict: null, changed: false };

  const sourceFields = new Map(
    sources.map((source) => [
      source,
      new Set(Array.isArray(source.metadata.providedFields) ? source.metadata.providedFields : RATE_FIELDS),
    ]),
  );
  const conflicts = [];
  for (let leftIndex = 0; leftIndex < sources.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < sources.length; rightIndex += 1) {
      const left = sources[leftIndex];
      const right = sources[rightIndex];
      for (const field of RATE_FIELDS) {
        if (
          sourceFields.get(left).has(field) &&
          sourceFields.get(right).has(field) &&
          Math.abs(left.rates[field] - right.rates[field]) > PRICE_CONFLICT_TOLERANCE
        ) {
          conflicts.push({ field, sources: [left.name, right.name], values: [left.rates[field], right.rates[field]] });
        }
      }
    }
  }
  if (conflicts.length) {
    const conflictMetadata = {
      ...(existingMetadata || {}),
      checkedAt,
      origin: existingMetadata?.origin || "built-in",
      conflicts,
    };
    return { rates: baseRates, metadata: conflictMetadata, conflict: conflicts, changed: false };
  }

  const rates = { ...baseRates };
  const selectedSources = new Set();
  const inheritedFields = [];
  const fieldSources = {};
  const inheritedFrom = {};
  for (const field of RATE_FIELDS) {
    const source =
      sources.find((candidate) => candidate.name === "Models.dev" && sourceFields.get(candidate).has(field)) ||
      sources.find((candidate) => sourceFields.get(candidate).has(field));
    if (source) {
      rates[field] = source.rates[field];
      selectedSources.add(source);
      fieldSources[field] = source.metadata.sourceUrl || null;
    } else {
      inheritedFields.push(field);
      const sourceUrl = existingMetadata?.fieldSources?.[field] || existingMetadata?.sourceUrl || null;
      inheritedFrom[field] = {
        ...(sourceUrl ? { sourceUrl } : {}),
        origin: existingMetadata?.origin || "built-in",
      };
    }
  }
  const sourceUrls = [...new Set([...selectedSources].map((source) => source.metadata.sourceUrl).filter(Boolean))];
  const providerIds = [...new Set([...selectedSources].map((source) => source.metadata.providerId).filter(Boolean))];
  const origin =
    selectedSources.size === 0
      ? existingMetadata?.origin || "built-in"
      : selectedSources.size > 1 || inheritedFields.length > 0
        ? "mixed"
        : "remote";
  const metadata = {
    sourceUrl: sourceUrls.length === 1 ? sourceUrls[0] : null,
    checkedAt,
    origin,
    inheritedFields,
    fieldSources,
    inheritedFrom,
    ...(providerIds.length === 1 ? { providerId: providerIds[0] } : {}),
    providedFields: RATE_FIELDS.filter((field) => !inheritedFields.includes(field)),
  };
  return {
    rates,
    metadata,
    conflict: null,
    changed: !RATE_FIELDS.every((field) => Object.is(rates[field], baseRates[field])),
  };
}

function autoProvenanceForModel(metadata = {}) {
  const sourceUrls = new Set([
    MODEL_PRICES_URL,
    LITELLM_PRICES_URL,
    STEPFUN_PRICES_URL,
    MIMO_PRICES_URL,
    KIMI_PRICES_URL,
    GLM_PRICES_URL,
  ]);
  return Object.entries(metadata).filter(
    ([tier, item]) =>
      ["short", "long", "fast.short", "fast.long"].includes(tier) &&
      sourceUrls.has(item?.sourceUrl) &&
      ["remote", "mixed"].includes(item?.origin),
  );
}

function providerMapForModels(models, metadata = {}) {
  const defaults = getDefaultPricingCatalog().models;
  const providers = {};
  for (const [model, entry] of Object.entries(models || {})) {
    const cachedProvider = Object.values(metadata[model] || {}).find((item) => item?.providerId)?.providerId;
    const provider =
      cachedProvider || pricingSourceProviderFor(model, defaults[model]) || pricingSourceProviderFor(model, entry);
    if (provider) providers[model] = provider;
  }
  return providers;
}

function automaticCoverage(models, metadata, cachedModels) {
  const automaticModels = new Set(Object.keys(cachedModels || {}));
  const partialModels = new Set();
  for (const [model, entry] of Object.entries(models || {})) {
    const automaticTiers = autoProvenanceForModel(metadata?.[model]);
    if (!automaticTiers.length) continue;
    automaticModels.add(model);
    const requiredTiers = ["short", ...(entry?.long ? ["long"] : [])];
    if (entry?.fast) requiredTiers.push("fast.short", ...(entry.fast.long ? ["fast.long"] : []));
    const tiersByName = new Map(automaticTiers);
    const complete = requiredTiers.every((tier) => {
      const item = tiersByName.get(tier);
      return item?.origin === "remote" && item.inheritedFields?.length === 0;
    });
    if (!complete) partialModels.add(model);
  }
  for (const model of automaticModels) {
    if (!Object.hasOwn(metadata || {}, model) || autoProvenanceForModel(metadata?.[model]).length === 0)
      partialModels.add(model);
  }
  return {
    automaticModels: [...automaticModels].sort(),
    partialAutomaticModels: [...partialModels].sort(),
  };
}

export function getAutomaticPricingStatus() {
  const catalog = getPricingCatalog();
  const automaticRateCatalog = automaticBase();
  const autoCoverage = automaticCoverage(catalog.models, automatic.modelMetadata, automatic.models);
  const knownProviders = providerMapForModels(catalog.models, automatic.modelMetadata);
  const automaticModels = autoCoverage.automaticModels;
  const manualModels = Object.keys(manual.modelOverrides || {}).sort();
  const totalModelCount = Object.keys(catalog.models).length;
  return {
    priceSource: MODEL_PRICES_URL,
    fallbackPriceSource: LITELLM_PRICES_URL,
    cnyPriceSource: MIMO_PRICES_URL,
    exchangeRateSource: USD_CNY_RATE_URL,
    priceUpdatedAt: automatic.priceUpdatedAt || null,
    priceAttemptedAt: automatic.priceAttemptedAt || null,
    exchangeRateDate: automatic.exchangeRateDate || null,
    exchangeRateUpdatedAt: automatic.exchangeRateUpdatedAt || null,
    exchangeRateAttemptedAt: automatic.exchangeRateAttemptedAt || null,
    automaticUsdToCnyRate: automaticRateCatalog.usdToCnyRate,
    effectiveUsdToCnyRate: catalog.usdToCnyRate,
    automaticModelCount: automaticModels.length,
    partialAutomaticModelCount: autoCoverage.partialAutomaticModels.length,
    partialAutomaticModels: autoCoverage.partialAutomaticModels,
    totalModelCount,
    maxModelCount: MAX_PRICING_MODELS,
    unmatchedModelCount: Math.max(0, totalModelCount - automaticModels.length),
    automaticModels,
    priceSourceCoverage: pricingSourceCoverage(catalog.models, knownProviders),
    manualModelCount: manualModels.length,
    manualModels,
    manualExchangeRate: manual.usdToCnyRate !== undefined,
    modelMetadata: structuredClone(automatic.modelMetadata || {}),
    discoveryResults: structuredClone(automatic.discoveryResults || []),
    discoveryAttemptedAt: structuredClone(automatic.discoveryAttemptedAt || {}),
    priceUpdateSummary: structuredClone(automatic.priceUpdateSummary || null),
    issues: structuredClone(automatic.issues || []),
    statusVersion: statusVersion(),
  };
}

export async function loadPricingFile(options = {}) {
  automatic = {};
  manual = {};
  let cached;
  try {
    cached = await readJson(automaticPricingFile(options));
  } catch {
    // A damaged download cache must not prevent use of the built-in catalog.
    cached = null;
  }
  if (isObject(cached)) {
    try {
      automatic = cached;
      automaticBase();
    } catch {
      automatic = {};
    }
  }
  const saved = await readJson(pricingFile(options));
  if (isObject(saved)) {
    if (saved.schemaVersion === 2) {
      manual = saved;
    } else {
      // Legacy full catalogs become field-level overrides so untouched rates
      // can continue to receive automatic updates.
      try {
        let oldCatalog;
        try {
          oldCatalog = validatePricingCatalog(saved);
        } catch {
          oldCatalog = validatePricingCatalog(mergePricingCatalog(saved));
        }
        manual = {
          schemaVersion: 2,
          checkedAt: oldCatalog.checkedAt,
          ...(saved.usdToCnyRate === undefined || oldCatalog.usdToCnyRate === getDefaultPricingCatalog().usdToCnyRate
            ? {}
            : { usdToCnyRate: oldCatalog.usdToCnyRate }),
          modelOverrides:
            differences(validatePricingCatalog(getDefaultPricingCatalog()).models, oldCatalog.models) || {},
        };
      } catch {
        manual = {};
      }
    }
  }
  try {
    applyCurrent();
  } catch {
    manual = {};
    applyCurrent();
  }
}

export async function savePricingFile(options, catalog, saveOptions = {}) {
  const normalized = validatePricingCatalog(catalog);
  if (Object.keys(normalized.models).length > MAX_PRICING_MODELS) {
    throw new Error(`Pricing catalog cannot contain more than ${MAX_PRICING_MODELS} models.`);
  }
  const base = automaticBase();
  const overrides = differences(base.models, normalized.models) || {};
  const next = {
    schemaVersion: 2,
    checkedAt: normalized.checkedAt,
    ...(saveOptions.restoreAutomaticExchangeRate === true || normalized.usdToCnyRate === base.usdToCnyRate
      ? {}
      : { usdToCnyRate: normalized.usdToCnyRate }),
    modelOverrides: overrides,
  };
  await writeJson(pricingFile(options), next);
  manual = next;
  applyCurrent();
}

function due(lastAttempt, lastSuccess, nowMs) {
  const attemptedMs = Date.parse(lastAttempt || "");
  if (!Number.isFinite(attemptedMs)) return true;
  const successMs = Date.parse(lastSuccess || "");
  return (
    nowMs - attemptedMs >=
    (Number.isFinite(successMs) && successMs >= attemptedMs ? AUTO_REFRESH_INTERVAL_MS : AUTO_RETRY_INTERVAL_MS)
  );
}

function pricingIssue(category, source, error) {
  return {
    category,
    source,
    code: error.code === "PRICING_TIMEOUT" ? "timeout" : "error",
    message: error.message,
    ...(error.timeoutMs ? { timeoutMs: error.timeoutMs } : {}),
  };
}

function observedModelNames(usedModels) {
  const names = Array.isArray(usedModels)
    ? usedModels
    : usedModels && typeof usedModels === "object"
      ? Object.values(usedModels).flatMap((models) => (Array.isArray(models) ? models : []))
      : [];
  return [...new Set(names.map((model) => String(model ?? "").trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function missingObservedModels(usedModels, models) {
  const seen = new Set();
  const missing = [];
  for (const name of observedModelNames(usedModels)) {
    const resolved = resolvePricingModel(name, models);
    if (resolved.matchType !== "missing") continue;
    const model = resolved.rawModel.toLowerCase();
    if (seen.has(model)) continue;
    seen.add(model);
    missing.push(model);
  }
  return missing.sort((left, right) => left.localeCompare(right));
}

function matchedObservedModels(usedModels, models) {
  const results = [];
  for (const name of observedModelNames(usedModels)) {
    const resolved = resolvePricingModel(name, models);
    if (resolved.matchType === "missing") continue;
    results.push({ model: resolved.rawModel.toLowerCase(), status: "matched", reason: resolved.matchType });
  }
  return results;
}

function sourcesProvideTier(modelsDevPatch, liteLLMPatch, tier) {
  const fields = new Set();
  for (const patch of [modelsDevPatch, liteLLMPatch]) {
    const metadata = metadataAt(patch, tier);
    if (!metadata) continue;
    for (const field of metadata.providedFields || RATE_FIELDS) fields.add(field);
  }
  return RATE_FIELDS.every((field) => fields.has(field));
}

function tierRates(entry, tier) {
  if (tier === "fast.short") return entry?.fast?.short || entry?.short || null;
  if (tier === "fast.long") return entry?.fast?.long || entry?.fast?.short || entry?.long || entry?.short || null;
  if (tier === "long") return entry?.long || entry?.short || null;
  return entry?.short || null;
}

function writeTier(entry, tier, rates) {
  if (tier === "fast.short" || tier === "fast.long") {
    entry.fast ||= {};
    entry.fast[tier.slice(5)] = rates;
  } else {
    entry[tier] = rates;
  }
}

function effectiveModelCount(models, modelOverrides) {
  return new Set([...Object.keys(models || {}), ...Object.keys(modelOverrides || {})]).size;
}

export async function refreshAutomaticPricing(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const timestamp = now.toISOString();
  const force = options.force === true;
  const fetcher = options.pricingFetcher || globalThis.fetch;
  const discoveryEnabled = options.automaticDiscoveryEnabled !== false;
  const discoveryReady = options.discoveryReady !== false;
  const currentCatalog = getPricingCatalog();
  const missingCandidates =
    discoveryEnabled && discoveryReady ? missingObservedModels(options.usedModels, currentCatalog.models) : [];
  const matchedResults =
    discoveryEnabled && discoveryReady ? matchedObservedModels(options.usedModels, currentCatalog.models) : [];
  const discoveryDue = missingCandidates.filter(
    (model) => force || due(automatic.discoveryAttemptedAt?.[model], null, now.getTime()),
  );
  const updatePrices =
    force ||
    discoveryDue.length > 0 ||
    due(automatic.priceAttemptedAt, automatic.pricePartialFailure ? null : automatic.priceUpdatedAt, now.getTime());
  const updateRate = force || due(automatic.exchangeRateAttemptedAt, automatic.exchangeRateUpdatedAt, now.getTime());
  const cooldownResults = missingCandidates
    .filter((model) => !discoveryDue.includes(model))
    .map((model) => ({ model, status: "deferred", reason: "retry-after" }));
  if (!updatePrices && !updateRate) {
    return {
      changed: false,
      statusChanged: false,
      pricesUpdated: false,
      exchangeRateUpdated: false,
      errors: [],
      issues: [],
      ...getAutomaticPricingStatus(),
      discovery: { addedModels: [], results: [...matchedResults, ...cooldownResults] },
    };
  }

  const previousPriceVersion = effectivePriceVersion(currentCatalog);
  const previousStatusVersion = statusVersion();
  const results = await Promise.allSettled([
    updatePrices ? fetchPricingJson(fetcher, MODEL_PRICES_URL) : Promise.resolve(null),
    updatePrices ? fetchPricingJson(fetcher, LITELLM_PRICES_URL) : Promise.resolve(null),
    updatePrices ? fetchPricingText(fetcher, MIMO_PRICES_URL) : Promise.resolve(null),
    updatePrices ? fetchPricingText(fetcher, STEPFUN_PRICES_URL) : Promise.resolve(null),
    updatePrices ? fetchPricingText(fetcher, KIMI_PRICES_URL) : Promise.resolve(null),
    updatePrices ? fetchPricingText(fetcher, GLM_PRICES_URL) : Promise.resolve(null),
    updateRate ? fetchPricingJson(fetcher, USD_CNY_RATE_URL) : Promise.resolve(null),
  ]);
  const next = structuredClone(automatic);
  const issues = [];
  let pricesUpdated = false;
  let exchangeRateUpdated = false;
  const discoveryResults = [...matchedResults, ...cooldownResults];
  const addedModels = [];
  if (updatePrices) {
    next.priceAttemptedAt = timestamp;
    const sources = ["Models.dev", "LiteLLM", "Xiaomi MiMo", "StepFun", "Kimi", "GLM"];
    const defaultCatalog = automaticBase();
    const candidateModels = overlay(defaultCatalog.models, manual.modelOverrides);
    const candidateCatalog = validatePricingCatalog({
      checkedAt: defaultCatalog.checkedAt,
      usdToCnyRate: defaultCatalog.usdToCnyRate,
      models: candidateModels,
    });
    const providerByModel = providerMapForModels(candidateCatalog.models, automatic.modelMetadata);
    const sourcePatches = [null, null, null, null, null, null];
    const parsers = [
      modelsDevPricePatches,
      liteLLMPricePatches,
      mimoPricePatches,
      stepFunPricePatches,
      kimiPricePatches,
      glmPricePatches,
    ];
    for (const [index, parser] of parsers.entries()) {
      if (results[index].status === "fulfilled") {
        try {
          sourcePatches[index] =
            index === 0
              ? parser(results[index].value, candidateCatalog, { providerByModel })
              : parser(results[index].value, candidateCatalog);
        } catch (error) {
          issues.push(pricingIssue("prices", sources[index], error));
        }
      } else {
        issues.push(pricingIssue("prices", sources[index], results[index].reason));
      }
    }

    const allUpdatedModels = [...new Set(sourcePatches.flatMap((patch) => Object.keys(patch || {})))].sort();
    const sourceCoverage = pricingSourceCoverage(candidateCatalog.models, providerByModel);
    const verifiedModels = new Set();
    const changedModels = new Set();
    const partialModels = new Set();
    const conflictedModels = new Set();
    const manualOverrideModels = new Set();
    for (const model of allUpdatedModels) {
      const devPatch = sourcePatches[0]?.[model] || null;
      const litePatch = sourcePatches[1]?.[model] || null;
      const modelPatches = sourcePatches.map((patch) => patch?.[model] || null);
      const baseEntry = defaultCatalog.models[model] || null;
      const candidateEntry = candidateCatalog.models[model];
      /** @type {import("./pricing.js").PriceModel} */
      const nextEntry = structuredClone(
        baseEntry ||
          candidateEntry || {
            currency: candidateEntry?.currency || "USD",
            short: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 },
            ...(candidateEntry?.source ? { source: candidateEntry.source } : {}),
          },
      );
      const existingMetadata = { ...(next.modelMetadata?.[model] || {}) };
      let changedTier = false;
      let conflicted = false;
      let modelTouched = false;

      const thresholdSources = modelPatches.flatMap((patch, index) =>
        Number.isInteger(patch?.longContextThreshold)
          ? [{ source: sources[index], threshold: patch.longContextThreshold }]
          : [],
      );
      const selectedThreshold = thresholdSources[0]?.threshold;
      const thresholdConflict = new Set(thresholdSources.map((item) => item.threshold)).size > 1;
      const tiers = ["short", "long", "fast.short", "fast.long"];
      for (const tier of tiers) {
        if (!modelPatches.some((patch) => ratePatchAt(patch, tier))) continue;
        if (!baseEntry && !sourcesProvideTier(devPatch, litePatch, tier)) continue;
        if (tier === "long" && thresholdConflict) {
          conflicted = true;
          existingMetadata.long = {
            ...(existingMetadata.long || {}),
            checkedAt: timestamp,
            origin: existingMetadata.long?.origin || "built-in",
            conflicts: [
              {
                field: "longContextThreshold",
                sources: thresholdSources.map((item) => item.source),
                values: thresholdSources.map((item) => item.threshold),
              },
            ],
          };
          continue;
        }
        const baseRates =
          tierRates(baseEntry || candidateEntry, tier) || Object.fromEntries(RATE_FIELDS.map((field) => [field, 0]));
        const storedMetadata = existingMetadata[tier];
        const sourceMetadata = storedMetadata || {
          sourceUrl: baseEntry?.source || null,
          origin: [
            MODEL_PRICES_URL,
            LITELLM_PRICES_URL,
            STEPFUN_PRICES_URL,
            MIMO_PRICES_URL,
            KIMI_PRICES_URL,
            GLM_PRICES_URL,
          ].includes(baseEntry?.source)
            ? "remote"
            : "built-in",
          fieldSources: {},
        };
        const merged = mergeRateTier(baseRates, sourceMetadata, modelPatches, tier, timestamp);
        existingMetadata[tier] = merged.metadata || existingMetadata[tier];
        if (merged.conflict) {
          conflicted = true;
          continue;
        }
        writeTier(nextEntry, tier, merged.rates);
        modelTouched = true;
        changedTier ||= merged.changed;
      }
      const thresholdChanged =
        Number.isInteger(selectedThreshold) &&
        !thresholdConflict &&
        nextEntry.longContextThreshold !== selectedThreshold;
      if (Number.isInteger(selectedThreshold) && !thresholdConflict)
        Object.assign(nextEntry, { longContextThreshold: selectedThreshold });
      const preferredSource = modelPatches.find((patch) => patch?.source)?.source;
      if (preferredSource) nextEntry.source = preferredSource;
      if (Object.keys(existingMetadata).length) {
        next.modelMetadata ||= {};
        next.modelMetadata[model] = existingMetadata;
      }
      if (changedTier || thresholdChanged || (modelTouched && !baseEntry)) {
        next.models = overlay(next.models || {}, { [model]: nextEntry });
        pricesUpdated = true;
      }
      if (conflicted) {
        conflictedModels.add(model);
        discoveryResults.push({ model, status: "rejected", reason: "conflict" });
      } else if (modelTouched) {
        verifiedModels.add(model);
        if (changedTier || thresholdChanged) changedModels.add(model);
        if (Object.hasOwn(manual.modelOverrides || {}, model)) manualOverrideModels.add(model);
        const requiredTiers = [
          "short",
          ...(candidateEntry?.long ? ["long"] : []),
          ...(candidateEntry?.fast?.short ? ["fast.short"] : []),
          ...(candidateEntry?.fast?.long ? ["fast.long"] : []),
        ];
        const suppliedTiers = requiredTiers.filter((tier) => modelPatches.some((patch) => ratePatchAt(patch, tier)));
        const hasInheritedFields = requiredTiers.some((tier) => existingMetadata[tier]?.inheritedFields?.length > 0);
        if (suppliedTiers.length < requiredTiers.length || hasInheritedFields) partialModels.add(model);
      }
    }

    next.priceUpdateSummary = {
      checkedAt: timestamp,
      attemptedModelCount: sourceCoverage.supportedModelCount,
      sourceMatchedModelCount: allUpdatedModels.length,
      verifiedModelCount: verifiedModels.size,
      changedModelCount: changedModels.size,
      partialModelCount: partialModels.size,
      conflictModelCount: conflictedModels.size,
      manualOverrideModelCount: manualOverrideModels.size,
      noValidMatchModelCount: Math.max(0, sourceCoverage.supportedModelCount - allUpdatedModels.length),
      unsupportedCurrencyModelCount: sourceCoverage.unsupportedCurrencyModelCount,
      providers: sourceCoverage.providers,
      fetchedSourceCount: results.slice(0, 6).filter((result) => result.status === "fulfilled").length,
    };

    if (discoveryEnabled && discoveryReady && discoveryDue.length) {
      next.discoveryAttemptedAt ||= {};
      for (const model of discoveryDue) {
        next.discoveryAttemptedAt[model] = timestamp;
        try {
          if (results[0].status === "rejected" && results[1].status === "rejected") {
            const reason = [results[0].reason, results[1].reason].some((error) => error?.code === "PRICING_TIMEOUT")
              ? "timeout"
              : "source-error";
            discoveryResults.push({ model, status: "error", reason });
            continue;
          }
          const parsed = parseOpenAIModelPricing(model, {
            modelsDevPayload: results[0].status === "fulfilled" ? results[0].value : undefined,
            liteLLMPayload: results[1].status === "fulfilled" ? results[1].value : undefined,
            checkedAt: timestamp,
          });
          if (parsed.status !== "added") {
            discoveryResults.push({ model, status: parsed.status, reason: parsed.reason });
            continue;
          }
          const modelCount = effectiveModelCount(overlay(defaultCatalog.models, next.models), manual.modelOverrides);
          if (modelCount >= MAX_PRICING_MODELS) {
            discoveryResults.push({ model, status: "rejected", reason: "catalog-capacity" });
            continue;
          }
          next.models = overlay(next.models || {}, { [model]: parsed.pricing });
          next.modelMetadata ||= {};
          next.modelMetadata[model] = parsed.modelMetadata;
          next.checkedAt = timestamp.slice(0, 10);
          addedModels.push(model);
          pricesUpdated = true;
          discoveryResults.push({ model, status: "added", reason: null });
        } catch (error) {
          discoveryResults.push({
            model,
            status: "error",
            reason: error.code === "PRICING_TIMEOUT" ? "timeout" : "error",
          });
        }
      }
      next.discoveryResults = discoveryResults;
    }

    if (pricesUpdated) next.checkedAt ||= timestamp.slice(0, 10);
    const priceIssues = issues.some((issue) => issue.category === "prices");
    const sourceSuccess = results.slice(0, 6).some((result) => result.status === "fulfilled");
    if (!priceIssues && sourceSuccess) next.priceUpdatedAt = timestamp;
    else if (pricesUpdated) next.priceUpdatedAt = timestamp;
    if (!allUpdatedModels.length && !discoveryDue.length && !priceIssues) {
      issues.push(pricingIssue("prices", "Models.dev / LiteLLM", new Error("No matching model prices were found.")));
    }
    next.pricePartialFailure = issues.some((issue) => issue.category === "prices");
    next.issues = issues;
  }
  if (updateRate) {
    next.exchangeRateAttemptedAt = timestamp;
    if (results[6].status === "fulfilled") {
      try {
        const { rate, date } = frankfurterUsdCny(results[6].value);
        next.usdToCnyRate = rate;
        next.exchangeRateDate = date;
        next.exchangeRateUpdatedAt = timestamp;
        exchangeRateUpdated = true;
      } catch (error) {
        issues.push(pricingIssue("exchangeRate", "Frankfurter", error));
      }
    } else {
      issues.push(pricingIssue("exchangeRate", "Frankfurter", results[6].reason));
    }
  }
  next.issues = issues;
  const previous = automatic;
  automatic = next;
  try {
    applyCurrent();
    await writeJson(automaticPricingFile(options), next);
  } catch (error) {
    automatic = previous;
    applyCurrent();
    throw error;
  }
  const errors = issues.map(
    (issue) => `${issue.category === "prices" ? "Price" : "Exchange rate"} update (${issue.source}): ${issue.message}`,
  );
  return {
    changed: previousPriceVersion !== effectivePriceVersion(getPricingCatalog()),
    statusChanged: previousStatusVersion !== statusVersion(),
    pricesUpdated,
    exchangeRateUpdated,
    errors,
    issues,
    discovery: {
      addedModels,
      results: discoveryResults.sort((left, right) => left.model.localeCompare(right.model)),
    },
    ...getAutomaticPricingStatus(),
  };
}
