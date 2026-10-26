import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  GLM_PRICES_URL,
  KIMI_PRICES_URL,
  LITELLM_PRICES_URL,
  MIMO_PRICES_URL,
  MODEL_PRICES_URL,
  STEPFUN_PRICES_URL,
  USD_CNY_RATE_URL,
} from "../src/pricing-auto.js";
import { getDefaultPricingCatalog, getPricingCatalog, resetPricingCatalog } from "../src/pricing.js";
import {
  automaticPricingFile,
  getAutomaticPricingStatus,
  loadPricingFile,
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

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function pricingFetcher({
  failSource = null,
  rate = 6.8,
  calls = null,
  modelsDev = modelCatalog(3, 12),
  liteLLM = {},
} = {}) {
  return async (url) => {
    calls?.push(url);
    if (Array.isArray(failSource) ? failSource.includes(url) : url === failSource) throw new Error(`${url} offline`);
    if (url === MODEL_PRICES_URL) return jsonResponse(modelsDev);
    if (url === LITELLM_PRICES_URL) return jsonResponse(liteLLM);
    if (url === USD_CNY_RATE_URL) return jsonResponse({ base: "USD", quote: "CNY", date: "2026-09-28", rate });
    if ([MIMO_PRICES_URL, STEPFUN_PRICES_URL, KIMI_PRICES_URL, GLM_PRICES_URL].includes(url)) {
      return new Response("", { status: 200, headers: { "content-type": "text/html" } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

async function temporaryHome() {
  return mkdtemp(path.join(process.cwd(), ".r04-"));
}

async function loadAutomaticCache(homeDir, value) {
  const cachePath = automaticPricingFile({ homeDir });
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(value));
  await loadPricingFile({ homeDir });
}

function recentAutomaticState({
  priceAttemptedAt = "2026-09-28T07:00:00.000Z",
  exchangeAttemptedAt = "2026-09-28T07:00:00.000Z",
} = {}) {
  const sourceResults = ["Models.dev", "LiteLLM", "Xiaomi MiMo", "StepFun", "Kimi", "GLM"].map((source) => ({
    source,
    attemptedAt: priceAttemptedAt,
    fetched: true,
    parsed: true,
    updatedModelCount: 0,
  }));
  return {
    priceAttemptedAt,
    priceUpdatedAt: priceAttemptedAt,
    pricePartialFailure: false,
    usdToCnyRate: 6.8,
    exchangeRateAttemptedAt: exchangeAttemptedAt,
    exchangeRateUpdatedAt: exchangeAttemptedAt,
    exchangeRateDate: "2026-09-27",
    priceUpdateSummary: { checkedAt: priceAttemptedAt, attemptedModelCount: 97, sourceResults },
    issues: [{ category: "prices", source: "LiteLLM", code: "error", message: "previous failure" }],
  };
}

function discoverableModelCatalog(model = "gpt-test-discovery") {
  return {
    openai: {
      models: {
        [model]: {
          modalities: { input: ["text"], output: ["text"] },
          cost: {
            input: 2,
            cache_read: 0.1,
            cache_write: 2.5,
            output: 10,
            tiers: [
              {
                tier: { type: "context", size: 272_000 },
                input: 4,
                cache_read: 0.2,
                cache_write: 5,
                output: 15,
              },
            ],
          },
        },
      },
    },
  };
}

test("partial price refresh exposes its persisted failure and real per-source results", async () => {
  const homeDir = await temporaryHome();
  const attemptedAt = "2026-09-28T08:00:00.000Z";
  try {
    await loadPricingFile({ homeDir });
    const before = getAutomaticPricingStatus();
    const result = await refreshAutomaticPricing({
      homeDir,
      force: true,
      now: new Date(attemptedAt),
      pricingFetcher: pricingFetcher({ failSource: GLM_PRICES_URL }),
    });

    assert.equal(result.pricesUpdated, true);
    assert.equal(result.pricePartialFailure, true);
    assert.equal(result.priceUpdateSummary.fetchedSourceCount, 5);
    const sourceResults = result.priceUpdateSummary.sourceResults;
    assert.equal(sourceResults.length, 6);
    assert.ok(sourceResults.every((source) => source.attemptedAt === attemptedAt));
    assert.deepEqual(
      sourceResults.find((source) => source.source === "Models.dev"),
      {
        source: "Models.dev",
        attemptedAt,
        fetched: true,
        parsed: true,
        updatedModelCount: 1,
      },
    );
    assert.deepEqual(
      sourceResults.find((source) => source.source === "LiteLLM"),
      {
        source: "LiteLLM",
        attemptedAt,
        fetched: true,
        parsed: true,
        updatedModelCount: 0,
      },
    );
    assert.deepEqual(
      sourceResults.find((source) => source.source === "GLM"),
      {
        source: "GLM",
        attemptedAt,
        fetched: false,
        parsed: null,
        updatedModelCount: 0,
      },
    );
    assert.notEqual(result.statusVersion, before.statusVersion);
    assert.equal(getAutomaticPricingStatus().pricePartialFailure, true);
    assert.deepEqual(getAutomaticPricingStatus().priceUpdateSummary.sourceResults, sourceResults);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("old cache without new fields remains readable and reports built-in FX", async () => {
  const homeDir = await temporaryHome();
  try {
    const cachePath = automaticPricingFile({ homeDir });
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(
      cachePath,
      JSON.stringify({
        pricePartialFailure: true,
        priceUpdateSummary: { checkedAt: "2026-09-27T08:00:00.000Z", attemptedModelCount: 97 },
        issues: [{ category: "prices", source: "LiteLLM", code: "error", message: "offline" }],
      }),
    );

    await loadPricingFile({ homeDir });
    const status = getAutomaticPricingStatus();
    assert.equal(status.pricePartialFailure, true);
    assert.equal(status.exchangeRateMode, "built-in");
    assert.deepEqual(status.priceUpdateSummary.sourceResults, []);
    assert.equal(status.effectiveUsdToCnyRate, getDefaultPricingCatalog().usdToCnyRate);
    assert.equal(status.issues[0].source, "LiteLLM");
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("manual FX takes precedence while the latest automatic quote remains visible", async () => {
  const homeDir = await temporaryHome();
  try {
    await loadPricingFile({ homeDir });
    await refreshAutomaticPricing({
      homeDir,
      force: true,
      now: new Date("2026-09-28T08:00:00.000Z"),
      pricingFetcher: pricingFetcher(),
    });
    const automaticStatus = getAutomaticPricingStatus();
    assert.equal(automaticStatus.exchangeRateMode, "automatic");
    assert.equal(automaticStatus.automaticUsdToCnyRate, 6.8);

    const catalog = getPricingCatalog();
    catalog.usdToCnyRate = 7.1;
    await savePricingFile({ homeDir }, catalog);
    const manualStatus = getAutomaticPricingStatus();
    assert.equal(manualStatus.exchangeRateMode, "manual");
    assert.equal(manualStatus.manualExchangeRate, true);
    assert.equal(manualStatus.effectiveUsdToCnyRate, 7.1);
    assert.equal(manualStatus.automaticUsdToCnyRate, 6.8);
    assert.notEqual(manualStatus.statusVersion, automaticStatus.statusVersion);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("only the exchange rate is fetched when its retry is due", async () => {
  const homeDir = await temporaryHome();
  const calls = [];
  const now = new Date("2026-09-28T08:00:00.000Z");
  try {
    await loadAutomaticCache(homeDir, recentAutomaticState({ exchangeAttemptedAt: "2026-09-27T06:00:00.000Z" }));
    const before = getAutomaticPricingStatus();

    const result = await refreshAutomaticPricing({
      homeDir,
      now,
      pricingFetcher: pricingFetcher({ calls }),
    });

    assert.deepEqual(calls, [USD_CNY_RATE_URL]);
    assert.equal(result.exchangeRateUpdated, true);
    assert.equal(result.exchangeRateAttemptedAt, now.toISOString());
    assert.equal(result.exchangeRateUpdatedAt, now.toISOString());
    assert.equal(result.priceAttemptedAt, before.priceAttemptedAt);
    assert.equal(result.priceUpdatedAt, before.priceUpdatedAt);
    assert.deepEqual(result.priceUpdateSummary, before.priceUpdateSummary);
    assert.deepEqual(result.issues, before.issues);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("missing model discovery fetches only its two sources and preserves maintenance state", async () => {
  const homeDir = await temporaryHome();
  const calls = [];
  const now = new Date("2026-09-28T08:00:00.000Z");
  try {
    await loadAutomaticCache(homeDir, recentAutomaticState());
    const beforeStatus = getAutomaticPricingStatus();
    const beforeModelCount = Object.keys(getPricingCatalog().models).length;

    const result = await refreshAutomaticPricing({
      homeDir,
      now,
      usedModels: ["gpt-test-discovery"],
      pricingFetcher: pricingFetcher({
        calls,
        modelsDev: discoverableModelCatalog(),
      }),
    });

    assert.deepEqual(calls, [MODEL_PRICES_URL, LITELLM_PRICES_URL]);
    assert.deepEqual(result.discovery.addedModels, ["gpt-test-discovery"]);
    assert.equal(getPricingCatalog().models["gpt-test-discovery"].short.input, 2);
    assert.equal(Object.keys(getPricingCatalog().models).length, beforeModelCount + 1);
    assert.equal(result.discoveryAttemptedAt["gpt-test-discovery"], now.toISOString());
    assert.equal(result.priceAttemptedAt, beforeStatus.priceAttemptedAt);
    assert.equal(result.priceUpdatedAt, beforeStatus.priceUpdatedAt);
    assert.equal(result.priceUpdateSummary.checkedAt, beforeStatus.priceUpdateSummary.checkedAt);
    assert.equal(result.priceUpdateSummary.attemptedModelCount, beforeStatus.priceUpdateSummary.attemptedModelCount);
    const beforeSources = new Map(
      beforeStatus.priceUpdateSummary.sourceResults.map((source) => [source.source, source]),
    );
    const afterSources = new Map(result.priceUpdateSummary.sourceResults.map((source) => [source.source, source]));
    assert.deepEqual(afterSources.get("Models.dev"), {
      source: "Models.dev",
      attemptedAt: now.toISOString(),
      fetched: true,
      parsed: true,
      updatedModelCount: 1,
    });
    assert.deepEqual(afterSources.get("LiteLLM"), {
      source: "LiteLLM",
      attemptedAt: now.toISOString(),
      fetched: true,
      parsed: true,
      updatedModelCount: 0,
    });
    for (const source of ["Xiaomi MiMo", "StepFun", "Kimi", "GLM"]) {
      assert.deepEqual(afterSources.get(source), beforeSources.get(source));
    }
    assert.deepEqual(result.issues, beforeStatus.issues);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("failed discovery fetches record no parsing and preserve unattempted source results", async () => {
  const homeDir = await temporaryHome();
  const calls = [];
  const now = new Date("2026-09-28T08:00:00.000Z");
  try {
    await loadAutomaticCache(homeDir, recentAutomaticState());
    const beforeStatus = getAutomaticPricingStatus();

    const result = await refreshAutomaticPricing({
      homeDir,
      now,
      usedModels: ["gpt-test-discovery"],
      pricingFetcher: pricingFetcher({
        calls,
        failSource: [MODEL_PRICES_URL, LITELLM_PRICES_URL],
      }),
    });

    assert.deepEqual(calls, [MODEL_PRICES_URL, LITELLM_PRICES_URL]);
    assert.deepEqual(result.discovery.results, [
      { model: "gpt-test-discovery", status: "error", reason: "source-error" },
    ]);
    const beforeSources = new Map(
      beforeStatus.priceUpdateSummary.sourceResults.map((source) => [source.source, source]),
    );
    const afterSources = new Map(result.priceUpdateSummary.sourceResults.map((source) => [source.source, source]));
    for (const source of ["Models.dev", "LiteLLM"]) {
      assert.deepEqual(afterSources.get(source), {
        source,
        attemptedAt: now.toISOString(),
        fetched: false,
        parsed: null,
        updatedModelCount: 0,
      });
    }
    for (const source of ["Xiaomi MiMo", "StepFun", "Kimi", "GLM"]) {
      assert.deepEqual(afterSources.get(source), beforeSources.get(source));
    }
    assert.equal(result.priceUpdateSummary.checkedAt, beforeStatus.priceUpdateSummary.checkedAt);
    assert.equal(result.priceUpdateSummary.attemptedModelCount, beforeStatus.priceUpdateSummary.attemptedModelCount);
    assert.equal(result.priceAttemptedAt, beforeStatus.priceAttemptedAt);
    assert.equal(result.priceUpdatedAt, beforeStatus.priceUpdatedAt);
    assert.deepEqual(result.issues, beforeStatus.issues);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("target refresh ignores due maintenance, FX, and unrelated missing models", async () => {
  const homeDir = await temporaryHome();
  const calls = [];
  const now = new Date("2026-09-28T08:00:00.000Z");
  try {
    const state = recentAutomaticState({
      priceAttemptedAt: "2026-09-26T07:00:00.000Z",
      exchangeAttemptedAt: "2026-09-26T07:00:00.000Z",
    });
    state.discoveryResults = [{ model: "gpt-other-missing", status: "deferred", reason: "context-policy-unknown" }];
    state.discoveryAttemptedAt = { "gpt-other-missing": "2026-09-28T07:00:00.000Z" };
    await loadAutomaticCache(homeDir, state);
    const before = getAutomaticPricingStatus();
    const modelsDev = discoverableModelCatalog();
    modelsDev.openai.models["gpt-other-missing"] =
      discoverableModelCatalog("gpt-other-missing").openai.models["gpt-other-missing"];

    const result = await refreshAutomaticPricing({
      homeDir,
      model: "gpt-test-discovery",
      usedModels: ["gpt-other-missing"],
      now,
      pricingFetcher: pricingFetcher({ calls, modelsDev }),
    });

    assert.deepEqual(calls, [MODEL_PRICES_URL, LITELLM_PRICES_URL]);
    assert.deepEqual(result.discovery.addedModels, ["gpt-test-discovery"]);
    assert.equal(getPricingCatalog().models["gpt-test-discovery"].short.input, 2);
    assert.equal(getPricingCatalog().models["gpt-other-missing"], undefined);
    assert.equal(result.priceAttemptedAt, before.priceAttemptedAt);
    assert.equal(result.priceUpdatedAt, before.priceUpdatedAt);
    assert.equal(result.exchangeRateAttemptedAt, before.exchangeRateAttemptedAt);
    assert.equal(result.priceUpdateSummary.checkedAt, before.priceUpdateSummary.checkedAt);
    const other = getAutomaticPricingStatus().discoveryResults.find((item) => item.model === "gpt-other-missing");
    assert.equal(other.status, "deferred");
    assert.equal(other.reason, "context-policy-unknown");
    assert.equal(getAutomaticPricingStatus().discoveryAttemptedAt["gpt-other-missing"], "2026-09-28T07:00:00.000Z");
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("a matched target reports a match without fetching", async () => {
  const homeDir = await temporaryHome();
  const calls = [];
  try {
    await loadAutomaticCache(
      homeDir,
      recentAutomaticState({
        priceAttemptedAt: "2026-09-25T07:00:00.000Z",
        exchangeAttemptedAt: "2026-09-25T07:00:00.000Z",
      }),
    );
    const before = getAutomaticPricingStatus();

    const result = await refreshAutomaticPricing({
      homeDir,
      model: "gpt-6-sol",
      now: new Date("2026-09-28T08:00:00.000Z"),
      pricingFetcher: pricingFetcher({ calls }),
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(result.discovery.results, [{ model: "gpt-6-sol", status: "matched", reason: "exact" }]);
    assert.equal(result.priceAttemptedAt, before.priceAttemptedAt);
    assert.equal(result.exchangeRateAttemptedAt, before.exchangeRateAttemptedAt);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("target network errors retry after one hour and then add only the target", async () => {
  const homeDir = await temporaryHome();
  const calls = [];
  const model = "gpt-network-pending";
  try {
    await loadAutomaticCache(homeDir, recentAutomaticState());
    await refreshAutomaticPricing({
      homeDir,
      model,
      now: new Date("2026-09-28T08:00:00.000Z"),
      pricingFetcher: pricingFetcher({ calls, failSource: [MODEL_PRICES_URL, LITELLM_PRICES_URL] }),
    });
    assert.deepEqual(getAutomaticPricingStatus().discoveryResults, [
      {
        model,
        status: "error",
        reason: "source-error",
        retryable: true,
        nextRetryAt: "2026-09-28T09:00:00.000Z",
      },
    ]);
    const callCount = calls.length;

    const cooling = await refreshAutomaticPricing({
      homeDir,
      model,
      now: new Date("2026-09-28T08:30:00.000Z"),
      pricingFetcher: pricingFetcher({ calls, modelsDev: discoverableModelCatalog(model) }),
    });
    assert.equal(calls.length, callCount);
    assert.deepEqual(cooling.discovery.results, [{ model, status: "deferred", reason: "retry-after" }]);

    const retried = await refreshAutomaticPricing({
      homeDir,
      model,
      now: new Date("2026-09-28T09:00:00.000Z"),
      pricingFetcher: pricingFetcher({ calls, modelsDev: discoverableModelCatalog(model) }),
    });
    assert.deepEqual(calls.slice(callCount), [MODEL_PRICES_URL, LITELLM_PRICES_URL]);
    assert.deepEqual(retried.discovery.addedModels, [model]);
    assert.deepEqual(getAutomaticPricingStatus().discoveryResults, [
      { model, status: "added", reason: null, retryable: false, nextRetryAt: null },
    ]);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("not-found discovery waits for a source or catalog change", async () => {
  const homeDir = await temporaryHome();
  const calls = [];
  const model = "gpt-not-found";
  const fetcher = () => pricingFetcher({ calls, modelsDev: {}, liteLLM: {} });
  try {
    await loadAutomaticCache(homeDir, recentAutomaticState());
    await refreshAutomaticPricing({
      homeDir,
      model,
      now: new Date("2026-09-28T08:00:00.000Z"),
      pricingFetcher: fetcher(),
    });
    assert.deepEqual(getAutomaticPricingStatus().discoveryResults, [
      {
        model,
        status: "deferred",
        reason: "not-found",
        retryable: true,
        nextRetryAt: null,
      },
    ]);
    const callCount = calls.length;

    await refreshAutomaticPricing({
      homeDir,
      model,
      now: new Date("2026-09-29T09:00:00.000Z"),
      pricingFetcher: fetcher(),
    });
    assert.equal(calls.length, callCount);

    await refreshAutomaticPricing({
      homeDir,
      model,
      force: true,
      now: new Date("2026-09-30T09:00:00.000Z"),
      pricingFetcher: fetcher(),
    });
    assert.equal(calls.length, callCount);
    assert.deepEqual(getAutomaticPricingStatus().discoveryResults, [
      {
        model,
        status: "deferred",
        reason: "not-found",
        retryable: true,
        nextRetryAt: null,
      },
    ]);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("an FX-only refresh does not reopen not-found discovery", async () => {
  const homeDir = await temporaryHome();
  const calls = [];
  const model = "gpt-not-found";
  try {
    await loadAutomaticCache(
      homeDir,
      recentAutomaticState({
        priceAttemptedAt: "2026-09-28T07:00:00.000Z",
        exchangeAttemptedAt: "2026-09-27T07:00:00.000Z",
      }),
    );
    await refreshAutomaticPricing({
      homeDir,
      model,
      now: new Date("2026-09-28T08:00:00.000Z"),
      pricingFetcher: pricingFetcher({ calls, modelsDev: {}, liteLLM: {} }),
    });
    const callCount = calls.length;

    const fxOnly = await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-09-28T08:30:00.000Z"),
      pricingFetcher: pricingFetcher({ calls, rate: 7.1, modelsDev: {}, liteLLM: {} }),
    });
    assert.deepEqual(calls.slice(callCount), [USD_CNY_RATE_URL]);
    assert.equal(fxOnly.exchangeRateUpdated, true);

    const afterFxCallCount = calls.length;
    await refreshAutomaticPricing({
      homeDir,
      model,
      now: new Date("2026-09-29T09:00:00.000Z"),
      pricingFetcher: pricingFetcher({ calls, modelsDev: {}, liteLLM: {} }),
    });
    assert.equal(calls.length, afterFxCallCount);
    assert.deepEqual(getAutomaticPricingStatus().discoveryResults, [
      {
        model,
        status: "deferred",
        reason: "not-found",
        retryable: true,
        nextRetryAt: null,
      },
    ]);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("successful full maintenance rechecks not-found with the same downloads", async () => {
  const homeDir = await temporaryHome();
  const calls = [];
  const model = "gpt-late-discovery";
  try {
    await loadAutomaticCache(
      homeDir,
      recentAutomaticState({
        priceAttemptedAt: "2026-09-27T07:00:00.000Z",
        exchangeAttemptedAt: "2026-09-28T07:00:00.000Z",
      }),
    );
    await refreshAutomaticPricing({
      homeDir,
      model,
      now: new Date("2026-09-28T07:30:00.000Z"),
      pricingFetcher: pricingFetcher({ calls, modelsDev: {}, liteLLM: {} }),
    });
    assert.equal(getAutomaticPricingStatus().discoveryResults[0].reason, "not-found");
    const callCount = calls.length;

    const maintained = await refreshAutomaticPricing({
      homeDir,
      now: new Date("2026-09-28T08:00:00.000Z"),
      pricingFetcher: pricingFetcher({ calls, modelsDev: discoverableModelCatalog(model) }),
    });

    assert.deepEqual(calls.slice(callCount), [
      MODEL_PRICES_URL,
      LITELLM_PRICES_URL,
      MIMO_PRICES_URL,
      STEPFUN_PRICES_URL,
      KIMI_PRICES_URL,
      GLM_PRICES_URL,
    ]);
    assert.equal(calls.filter((url) => url === MODEL_PRICES_URL).length, 2);
    assert.equal(calls.filter((url) => url === LITELLM_PRICES_URL).length, 2);
    assert.deepEqual(maintained.discovery.addedModels, [model]);
    assert.deepEqual(getAutomaticPricingStatus().discoveryResults, [
      { model, status: "added", reason: null, retryable: false, nextRetryAt: null },
    ]);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("terminal discovery results wait for a capability or mapping revision", async () => {
  const homeDir = await temporaryHome();
  const calls = [];
  const model = "vendor/non-openai-model";
  try {
    await loadAutomaticCache(homeDir, recentAutomaticState());
    await refreshAutomaticPricing({
      homeDir,
      model,
      now: new Date("2026-09-28T08:00:00.000Z"),
      pricingFetcher: pricingFetcher({ calls }),
    });
    assert.deepEqual(getAutomaticPricingStatus().discoveryResults, [
      {
        model,
        status: "rejected",
        reason: "unsupported-provider",
        retryable: false,
        nextRetryAt: null,
      },
    ]);
    const callCount = calls.length;

    await refreshAutomaticPricing({
      homeDir,
      model,
      force: true,
      now: new Date("2026-09-28T09:00:00.000Z"),
      pricingFetcher: pricingFetcher({ calls }),
    });
    assert.equal(calls.length, callCount);

    await refreshAutomaticPricing({
      homeDir,
      model,
      discoveryCapabilityRevision: "official-openai-discovery-v2",
      now: new Date("2026-09-28T10:00:00.000Z"),
      pricingFetcher: pricingFetcher({ calls }),
    });
    assert.deepEqual(calls.slice(callCount), [MODEL_PRICES_URL, LITELLM_PRICES_URL]);
    assert.equal(getAutomaticPricingStatus().discoveryAttemptedAt[model], "2026-09-28T10:00:00.000Z");
    const capabilityCallCount = calls.length;

    await refreshAutomaticPricing({
      homeDir,
      model,
      discoveryMappingSignature: "official-mapping-v2",
      now: new Date("2026-09-28T11:00:00.000Z"),
      pricingFetcher: pricingFetcher({ calls }),
    });
    assert.deepEqual(calls.slice(capabilityCallCount), [MODEL_PRICES_URL, LITELLM_PRICES_URL]);
    assert.equal(getAutomaticPricingStatus().discoveryAttemptedAt[model], "2026-09-28T11:00:00.000Z");
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("full maintenance fetches all six price sources without refreshing a recent exchange rate", async () => {
  const homeDir = await temporaryHome();
  const calls = [];
  const now = new Date("2026-09-29T08:00:00.000Z");
  try {
    await loadAutomaticCache(
      homeDir,
      recentAutomaticState({
        priceAttemptedAt: "2026-09-28T07:00:00.000Z",
        exchangeAttemptedAt: "2026-09-29T07:00:00.000Z",
      }),
    );
    const before = getAutomaticPricingStatus();

    const result = await refreshAutomaticPricing({
      homeDir,
      now,
      pricingFetcher: pricingFetcher({ calls }),
    });

    assert.deepEqual(calls, [
      MODEL_PRICES_URL,
      LITELLM_PRICES_URL,
      MIMO_PRICES_URL,
      STEPFUN_PRICES_URL,
      KIMI_PRICES_URL,
      GLM_PRICES_URL,
    ]);
    assert.equal(result.priceAttemptedAt, now.toISOString());
    assert.equal(result.priceUpdatedAt, now.toISOString());
    assert.ok(result.priceUpdateSummary.sourceResults.every((source) => source.attemptedAt === now.toISOString()));
    assert.ok(result.priceUpdateSummary.sourceResults.every((source) => source.fetched));
    assert.equal(result.exchangeRateAttemptedAt, before.exchangeRateAttemptedAt);
    assert.equal(result.exchangeRateUpdatedAt, before.exchangeRateUpdatedAt);
    assert.ok(!result.issues.some((issue) => issue.message === "previous failure"));
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});
