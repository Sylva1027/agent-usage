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
const DISCOVERY_CAPABILITY_REVISION = "official-openai-discovery-v1";
const DISCOVERY_TERMINAL_REASONS = new Set(["unsupported-provider", "unsupported-context-policy"]);
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

function automaticBase(state = automatic) {
  const defaults = getDefaultPricingCatalog();
  return validatePricingCatalog({
    checkedAt: state.checkedAt || defaults.checkedAt,
    usdToCnyRate: state.usdToCnyRate || defaults.usdToCnyRate,
    models: overlay(defaults.models, state.models),
  });
}

function effectiveCatalog(state = automatic) {
  const base = automaticBase(state);
  const checkedAt =
    state.checkedAt && state.checkedAt > (manual.checkedAt || "")
      ? state.checkedAt
      : manual.checkedAt || base.checkedAt;
  return validatePricingCatalog({
    checkedAt,
    usdToCnyRate: manual.usdToCnyRate ?? base.usdToCnyRate,
    models: overlay(base.models, manual.modelOverrides),
  });
}

function applyCurrent() {
  return setPricingCatalog(effectiveCatalog());
}

function statusVersion(status) {
  const value = { ...status };
  delete value.statusVersion;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
}

function exchangeRateMode() {
  if (manual.usdToCnyRate !== undefined) return "manual";
  const automaticRate = Number(automatic.usdToCnyRate);
  return Number.isFinite(automaticRate) && automaticRate > 0 ? "automatic" : "built-in";
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
  if (!sources.length)
    return { rates: baseRates, metadata: existingMetadata, conflict: null, changed: false, updatedSources: [] };

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
    return { rates: baseRates, metadata: conflictMetadata, conflict: conflicts, changed: false, updatedSources: [] };
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
  const updatedSources = [...selectedSources]
    .filter((source) =>
      RATE_FIELDS.some(
        (field) => Object.is(source.rates[field], rates[field]) && !Object.is(rates[field], baseRates[field]),
      ),
    )
    .map((source) => source.name);
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
    updatedSources,
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
  const priceUpdateSummary = structuredClone(automatic.priceUpdateSummary || null);
  if (priceUpdateSummary && !Array.isArray(priceUpdateSummary.sourceResults)) priceUpdateSummary.sourceResults = [];
  const status = {
    priceSource: MODEL_PRICES_URL,
    fallbackPriceSource: LITELLM_PRICES_URL,
    cnyPriceSource: MIMO_PRICES_URL,
    exchangeRateSource: USD_CNY_RATE_URL,
    pricePartialFailure: automatic.pricePartialFailure === true,
    priceUpdatedAt: automatic.priceUpdatedAt || null,
    priceAttemptedAt: automatic.priceAttemptedAt || null,
    exchangeRateDate: automatic.exchangeRateDate || null,
    exchangeRateUpdatedAt: automatic.exchangeRateUpdatedAt || null,
    exchangeRateAttemptedAt: automatic.exchangeRateAttemptedAt || null,
    exchangeRateMode: exchangeRateMode(),
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
    discoveryResults: discoveryResultsWithPolicy(),
    discoveryAttemptedAt: structuredClone(automatic.discoveryAttemptedAt || {}),
    priceUpdateSummary,
    issues: structuredClone(automatic.issues || []),
  };
  return { ...status, statusVersion: statusVersion(status) };
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
  const hasManualExchangeRate = manual.usdToCnyRate !== undefined;
  const overrides = differences(base.models, normalized.models) || {};
  const next = {
    schemaVersion: 2,
    checkedAt: normalized.checkedAt,
    ...(saveOptions.restoreAutomaticExchangeRate === true ||
    (!hasManualExchangeRate && normalized.usdToCnyRate === base.usdToCnyRate)
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

function discoverySignature(options = {}) {
  return JSON.stringify([
    String(options.discoveryCapabilityRevision || DISCOVERY_CAPABILITY_REVISION),
    String(options.discoveryMappingSignature || ""),
  ]);
}

function modelDirectoryMarker(catalog) {
  return createHash("sha256")
    .update(JSON.stringify(Object.keys(catalog.models).sort()))
    .digest("hex")
    .slice(0, 12);
}

function discoverySourceMarker(state = automatic) {
  return JSON.stringify([modelDirectoryMarker(effectiveCatalog(state)), state.priceUpdatedAt || null]);
}

function discoveryResultFor(model) {
  const key = String(model ?? "")
    .trim()
    .toLowerCase();
  return [...(Array.isArray(automatic.discoveryResults) ? automatic.discoveryResults : [])]
    .reverse()
    .find((result) => String(result?.model || "").toLowerCase() === key);
}

function discoveryNeedsNetworkRetry(result) {
  return result?.status === "error" || ["source-error", "timeout", "error"].includes(result?.reason);
}

function discoveryPolicy(result, attemptedAt) {
  const attemptedMs = Date.parse(attemptedAt || "");
  const retryAt = (delayMs) => (Number.isFinite(attemptedMs) ? new Date(attemptedMs + delayMs).toISOString() : null);
  if (result?.status === "added" || result?.status === "matched") {
    return { retryable: false, nextRetryAt: null };
  }
  if (DISCOVERY_TERMINAL_REASONS.has(result?.reason)) {
    return { retryable: false, nextRetryAt: null };
  }
  if (discoveryNeedsNetworkRetry(result)) {
    return { retryable: true, nextRetryAt: retryAt(AUTO_RETRY_INTERVAL_MS) };
  }
  return { retryable: true, nextRetryAt: null };
}

function discoveryIsDue(model, nowMs, options = {}, sourceMarker) {
  const result = discoveryResultFor(model);
  if (!result) return true;
  if (result.status === "added" || result.status === "matched") return true;
  if (result.signature !== discoverySignature(options)) return true;
  const attemptedAt = automatic.discoveryAttemptedAt?.[String(model).toLowerCase()] || null;
  const policy = discoveryPolicy(result, attemptedAt);
  if (!policy.retryable) return false;
  if (!discoveryNeedsNetworkRetry(result)) {
    return !result.sourceMarker || result.sourceMarker !== sourceMarker;
  }
  if (options.force === true) return true;
  const retryMs = Date.parse(policy.nextRetryAt || "");
  return !Number.isFinite(retryMs) || nowMs >= retryMs;
}

function discoveryResultsWithPolicy() {
  return (Array.isArray(automatic.discoveryResults) ? automatic.discoveryResults : []).map((result) => {
    const model = String(result?.model || "")
      .trim()
      .toLowerCase();
    const attemptedAt = automatic.discoveryAttemptedAt?.[model] || result?.attemptedAt || null;
    return {
      model,
      status: result?.status || "error",
      reason: result?.reason ?? null,
      ...discoveryPolicy(result, attemptedAt),
    };
  });
}

function cooldownDiscoveryResult(model) {
  const result = discoveryResultFor(model);
  const attemptedAt = automatic.discoveryAttemptedAt?.[String(model).toLowerCase()] || null;
  const policy = result ? discoveryPolicy(result, attemptedAt) : null;
  if (result && (!policy.retryable || policy.nextRetryAt === null)) {
    return { model, status: result.status, reason: result.reason };
  }
  return { model, status: "deferred", reason: "retry-after" };
}

function storedDiscoveryRetryModels(models) {
  const seen = new Set();
  const results = [];
  for (const result of Array.isArray(automatic.discoveryResults) ? automatic.discoveryResults : []) {
    const model = String(result?.model || "")
      .trim()
      .toLowerCase();
    if (!model || seen.has(model)) continue;
    const attemptedAt = automatic.discoveryAttemptedAt?.[model] || null;
    if (!discoveryPolicy(result, attemptedAt).retryable || discoveryNeedsNetworkRetry(result)) continue;
    if (resolvePricingModel(model, models).matchType !== "missing") continue;
    seen.add(model);
    results.push(model);
  }
  return results.sort((left, right) => left.localeCompare(right));
}

function mergeDiscoveryResults(existing, updates) {
  const byModel = new Map(
    (Array.isArray(existing) ? existing : [])
      .filter((result) => result?.model)
      .map((result) => [String(result.model).toLowerCase(), result]),
  );
  for (const result of updates) byModel.set(result.model, result);
  return [...byModel.values()].sort((left, right) => left.model.localeCompare(right.model));
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
  const targetModel = typeof options.model === "string" ? options.model.trim() : "";
  const targeted = Boolean(targetModel);
  const observedModels = targeted ? [targetModel] : options.usedModels;
  const currentCatalog = getPricingCatalog();
  const sourceMarker = discoverySourceMarker();
  const missingCandidates =
    discoveryEnabled && discoveryReady ? missingObservedModels(observedModels, currentCatalog.models) : [];
  const matchedResults =
    discoveryEnabled && discoveryReady ? matchedObservedModels(observedModels, currentCatalog.models) : [];
  const maintainPrices =
    !targeted &&
    (force ||
      due(automatic.priceAttemptedAt, automatic.pricePartialFailure ? null : automatic.priceUpdatedAt, now.getTime()));
  const storedRetryModels =
    discoveryEnabled && discoveryReady && maintainPrices ? storedDiscoveryRetryModels(currentCatalog.models) : [];
  const normallyDue = missingCandidates.filter((model) =>
    discoveryIsDue(model, now.getTime(), { ...options, force }, sourceMarker),
  );
  const discoveryDue = [...new Set([...normallyDue, ...storedRetryModels])].sort((left, right) =>
    left.localeCompare(right),
  );
  const maintenanceOnlyDiscovery = new Set(
    maintainPrices ? discoveryDue.filter((model) => !normallyDue.includes(model)) : [],
  );
  const discoverPrices = discoveryDue.length > 0;
  const updateRate =
    !targeted && (force || due(automatic.exchangeRateAttemptedAt, automatic.exchangeRateUpdatedAt, now.getTime()));
  const cooldownResults = missingCandidates
    .filter((model) => !discoveryDue.includes(model))
    .map(cooldownDiscoveryResult);
  if (!maintainPrices && !discoverPrices && !updateRate) {
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
  const previousStatusVersion = getAutomaticPricingStatus().statusVersion;
  const results = await Promise.allSettled([
    maintainPrices || discoverPrices ? fetchPricingJson(fetcher, MODEL_PRICES_URL) : Promise.resolve(null),
    maintainPrices || discoverPrices ? fetchPricingJson(fetcher, LITELLM_PRICES_URL) : Promise.resolve(null),
    maintainPrices ? fetchPricingText(fetcher, MIMO_PRICES_URL) : Promise.resolve(null),
    maintainPrices ? fetchPricingText(fetcher, STEPFUN_PRICES_URL) : Promise.resolve(null),
    maintainPrices ? fetchPricingText(fetcher, KIMI_PRICES_URL) : Promise.resolve(null),
    maintainPrices ? fetchPricingText(fetcher, GLM_PRICES_URL) : Promise.resolve(null),
    updateRate ? fetchPricingJson(fetcher, USD_CNY_RATE_URL) : Promise.resolve(null),
  ]);
  const next = structuredClone(automatic);
  const previousIssues = Array.isArray(automatic.issues) ? automatic.issues : [];
  const issues = [];
  let pricesUpdated = false;
  let exchangeRateUpdated = false;
  const discoveryResults = [...matchedResults, ...cooldownResults];
  const addedModels = [];
  const defaultCatalog = automaticBase();
  if (maintainPrices) {
    next.priceAttemptedAt = timestamp;
    const sources = ["Models.dev", "LiteLLM", "Xiaomi MiMo", "StepFun", "Kimi", "GLM"];
    const candidateModels = overlay(defaultCatalog.models, manual.modelOverrides);
    const candidateCatalog = validatePricingCatalog({
      checkedAt: defaultCatalog.checkedAt,
      usdToCnyRate: defaultCatalog.usdToCnyRate,
      models: candidateModels,
    });
    const providerByModel = providerMapForModels(candidateCatalog.models, automatic.modelMetadata);
    const sourcePatches = [null, null, null, null, null, null];
    const parsedSources = [false, false, false, false, false, false];
    const sourceUpdatedModels = Array.from({ length: 6 }, () => new Set());
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
          parsedSources[index] = true;
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
      const selectedThresholdSource = thresholdSources.find((item) => item.threshold === selectedThreshold)?.source;
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
        for (const source of merged.updatedSources) {
          const index = sources.indexOf(source);
          if (index >= 0) sourceUpdatedModels[index].add(model);
        }
        modelTouched = true;
        changedTier ||= merged.changed;
      }
      const thresholdChanged =
        Number.isInteger(selectedThreshold) &&
        !thresholdConflict &&
        nextEntry.longContextThreshold !== selectedThreshold;
      if (Number.isInteger(selectedThreshold) && !thresholdConflict)
        Object.assign(nextEntry, { longContextThreshold: selectedThreshold });
      if (thresholdChanged && selectedThresholdSource) {
        const index = sources.indexOf(selectedThresholdSource);
        if (index >= 0) sourceUpdatedModels[index].add(model);
      }
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

    const sourceResultsBySource = new Map(
      (Array.isArray(next.priceUpdateSummary?.sourceResults) ? next.priceUpdateSummary.sourceResults : [])
        .filter((result) => isObject(result) && typeof result.source === "string")
        .map((result) => [result.source, result]),
    );
    for (const [index, source] of sources.entries()) {
      sourceResultsBySource.set(source, {
        source,
        attemptedAt: timestamp,
        fetched: results[index].status === "fulfilled",
        parsed: results[index].status === "rejected" ? null : parsedSources[index],
        updatedModelCount: sourceUpdatedModels[index].size,
      });
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
      sourceResults: sources.map((source) => sourceResultsBySource.get(source)),
    };

    if (pricesUpdated) next.checkedAt ||= timestamp.slice(0, 10);
    const priceIssues = issues.some((issue) => issue.category === "prices");
    const sourceSuccess = results.slice(0, 6).some((result) => result.status === "fulfilled");
    if (!priceIssues && sourceSuccess) next.priceUpdatedAt = timestamp;
    else if (pricesUpdated) next.priceUpdatedAt = timestamp;
    if (!allUpdatedModels.length && !discoveryDue.length && !priceIssues) {
      issues.push(pricingIssue("prices", "Models.dev / LiteLLM", new Error("No matching model prices were found.")));
    }
    next.pricePartialFailure = issues.some((issue) => issue.category === "prices");
  }
  if (discoverPrices) {
    next.discoveryAttemptedAt ||= {};
    const sourceUpdatedModels = [new Set(), new Set()];
    const storedDiscoveryResults = [];
    const resultSourceMarker = maintainPrices ? discoverySourceMarker(next) : sourceMarker;
    const recordDiscoveryResult = (model, status, reason) => {
      discoveryResults.push({ model, status, reason });
      const stored = {
        model,
        status,
        reason,
        signature: discoverySignature(options),
      };
      if (discoveryPolicy(stored, timestamp).retryable && !discoveryNeedsNetworkRetry(stored)) {
        stored.sourceMarker = resultSourceMarker;
      }
      storedDiscoveryResults.push(stored);
    };
    for (const model of discoveryDue) {
      if (maintenanceOnlyDiscovery.has(model) && results[0].status === "rejected" && results[1].status === "rejected") {
        continue;
      }
      next.discoveryAttemptedAt[model] = timestamp;
      try {
        if (results[0].status === "rejected" && results[1].status === "rejected") {
          const reason = [results[0].reason, results[1].reason].some((error) => error?.code === "PRICING_TIMEOUT")
            ? "timeout"
            : "source-error";
          recordDiscoveryResult(model, "error", reason);
          continue;
        }
        const parsed = parseOpenAIModelPricing(model, {
          modelsDevPayload: results[0].status === "fulfilled" ? results[0].value : undefined,
          liteLLMPayload: results[1].status === "fulfilled" ? results[1].value : undefined,
          checkedAt: timestamp,
        });
        if (parsed.status !== "added") {
          recordDiscoveryResult(model, parsed.status, parsed.reason);
          continue;
        }
        const modelCount = effectiveModelCount(overlay(defaultCatalog.models, next.models), manual.modelOverrides);
        if (modelCount >= MAX_PRICING_MODELS) {
          recordDiscoveryResult(model, "rejected", "catalog-capacity");
          continue;
        }
        next.models = overlay(next.models || {}, { [model]: parsed.pricing });
        next.modelMetadata ||= {};
        next.modelMetadata[model] = parsed.modelMetadata;
        const sourceIndex =
          parsed.pricing.source === MODEL_PRICES_URL ? 0 : parsed.pricing.source === LITELLM_PRICES_URL ? 1 : -1;
        if (sourceIndex >= 0) sourceUpdatedModels[sourceIndex].add(model);
        next.checkedAt = timestamp.slice(0, 10);
        addedModels.push(model);
        pricesUpdated = true;
        recordDiscoveryResult(model, "added", null);
      } catch (error) {
        recordDiscoveryResult(model, "error", error.code === "PRICING_TIMEOUT" ? "timeout" : "error");
      }
    }
    next.discoveryResults = mergeDiscoveryResults(next.discoveryResults, storedDiscoveryResults);
    if (!maintainPrices) {
      const sourceResultsBySource = new Map(
        (Array.isArray(next.priceUpdateSummary?.sourceResults) ? next.priceUpdateSummary.sourceResults : [])
          .filter((result) => isObject(result) && typeof result.source === "string")
          .map((result) => [result.source, result]),
      );
      for (const [index, source] of ["Models.dev", "LiteLLM"].entries()) {
        const fetched = results[index].status === "fulfilled";
        sourceResultsBySource.set(source, {
          source,
          attemptedAt: timestamp,
          fetched,
          parsed: results[index].status === "rejected" ? null : isObject(results[index].value),
          updatedModelCount: sourceUpdatedModels[index].size,
        });
      }
      next.priceUpdateSummary = {
        ...(next.priceUpdateSummary || {}),
        sourceResults: [...sourceResultsBySource.values()],
      };
    }
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
  next.issues = [
    ...previousIssues.filter((issue) =>
      issue?.category === "prices" ? !maintainPrices : issue?.category === "exchangeRate" ? !updateRate : true,
    ),
    ...issues,
  ];
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
    statusChanged: previousStatusVersion !== getAutomaticPricingStatus().statusVersion,
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
