import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { OPENROUTER_PRICES_URL, parseCatalogModelPricing } from "../src/pricing-catalog.js";
import { readPricingSourceCatalogs, savePricingSourceCatalogs } from "../src/pricing-catalog-store.js";
import { MODEL_PRICES_URL, LITELLM_PRICES_URL, USD_CNY_RATE_URL } from "../src/pricing-auto.js";
import { getPricingCatalog, resetPricingCatalog } from "../src/pricing.js";
import {
  automaticPricingFile,
  loadPricingFile,
  refreshAutomaticPricing,
  savePricingFile,
  pricingSourceCatalogFile,
} from "../src/pricing-store.js";
import { readFile, writeFile } from "node:fs/promises";

function routerModel(id, pricing = { prompt: "0.000002", completion: "0.000008", input_cache_read: "0.0000005" }) {
  return { id, architecture: { output_modalities: ["text"] }, pricing };
}

test("catalog pricing prefers first-party models and converts OpenRouter reference units and context tiers", () => {
  const official = {
    google: { models: { "gemini-catalog-test": { cost: { input: 3, output: 12, cache_read: 0.3 } } } },
  };
  const openRouterPayload = { data: [routerModel("google/gemini-catalog-test")] };
  const primary = parseCatalogModelPricing("gemini-catalog-test", { modelsDevPayload: official, openRouterPayload });
  assert.equal(primary.pricing.source, MODEL_PRICES_URL);
  assert.equal(primary.pricing.short.input, 3);
  assert.deepEqual(primary.modelMetadata.short.inputFallbackFields, ["cacheWrite"]);
  const reference = parseCatalogModelPricing("gemini-catalog-test", { openRouterPayload });
  assert.deepEqual(reference.pricing.short, { input: 2, output: 8, cachedInput: 0.5, cacheWrite: 2 });
  assert.equal(reference.modelMetadata.short.origin, "reference");
  openRouterPayload.data[0].pricing.overrides = [{ min_prompt_tokens: 200_000, prompt: "0.000004" }];
  const tiered = parseCatalogModelPricing("gemini-catalog-test", { openRouterPayload });
  assert.equal(tiered.pricing.longContextThreshold, 200_000);
  assert.equal(tiered.pricing.long.input, 4);
  assert.equal(tiered.pricing.long.output, 8);
  assert.equal(tiered.pricing.long.cacheWrite, 4);
});

test("ambiguous IDs, paid variants, invalid cache prices and unsupported schedules cannot become base rates", () => {
  for (const data of [
    [routerModel("first/same-model"), routerModel("second/same-model")],
    [routerModel("first/same-model:free")],
    [routerModel("first/same-model:batch")],
    [routerModel("first/same-model", { prompt: "", completion: "0.00001" })],
    [routerModel("first/same-model", { prompt: "0.000001", completion: "0.00001", input_cache_read: "-1" })],
    [routerModel("first/same-model", { prompt: "0.000001", completion: "0.00001", request: "0.1" })],
    [
      routerModel("first/same-model", {
        prompt: "0.000001",
        completion: "0.00001",
        overrides: [{ utc_start: 0, utc_end: 1200, prompt: "0" }],
      }),
    ],
  ]) {
    assert.notEqual(parseCatalogModelPricing("same-model", { openRouterPayload: { data } }).status, "added");
  }
  const claude = parseCatalogModelPricing("claude-fable-99-2", {
    openRouterPayload: { data: [routerModel("anthropic/claude-fable-99.2")] },
  });
  assert.equal(claude.status, "added");
  assert.equal(claude.pricing.cacheWriteTtl, "5m");
});

test("first-party Fast tiers stay separate and malformed context tiers are deferred", () => {
  const cost = {
    input: 2,
    output: 8,
    tiers: [{ tier: { type: "context", size: 200_000 }, input: 4, output: 12 }],
    fast: { input: 6, output: 24 },
  };
  const modelsDevPayload = { google: { models: { "gemini-catalog-test": { cost } } } };
  const parsed = parseCatalogModelPricing("gemini-catalog-test", { modelsDevPayload });
  assert.equal(parsed.pricing.fast.short.input, 6);
  assert.equal(parsed.pricing.fast.long.input, 6);
  assert.equal(parsed.pricing.long.input, 4);
  for (const tiers of [{}, [null], [{ tier: { type: "time", size: 100 } }]]) {
    cost.tiers = tiers;
    assert.equal(
      parseCatalogModelPricing("gemini-catalog-test", { modelsDevPayload }).reason,
      "unsupported-context-policy",
    );
  }
});

test("source catalogs round-trip through long Windows paths", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pricing-catalog-long-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "long-directory-".repeat(16), "pricing-sources.sqlite");
  const catalogs = {
    [MODEL_PRICES_URL]: { payload: { google: { models: {} } }, fetchedAt: "2026-11-14T00:00:00Z" },
  };
  await savePricingSourceCatalogs(file, catalogs);
  assert.deepEqual(readPricingSourceCatalogs(file), catalogs);
  catalogs[MODEL_PRICES_URL].fetchedAt = "2026-11-15T00:00:00Z";
  await savePricingSourceCatalogs(file, catalogs);
  assert.deepEqual(readPricingSourceCatalogs(file), catalogs);
});

test("full catalogs persist only in SQLite until local usage matches, work offline and preserve manual prices", async (t) => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "pricing-catalog-"));
  t.after(async () => {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  });
  const modelsDev = {
    google: {
      models: {
        "gemini-archive-used": { release_date: "2026-11-12", cost: { input: 3, output: 12 } },
        "gemini-archive-unused": { release_date: "2026-11-13", cost: { input: 4, output: 16 } },
      },
    },
  };
  let routerInput = "0.000002";
  const fetcher = async (url) => {
    const json =
      url === MODEL_PRICES_URL
        ? modelsDev
        : url === LITELLM_PRICES_URL
          ? {}
          : url === OPENROUTER_PRICES_URL
            ? { data: [routerModel("vendor/orbit-archive-test", { prompt: routerInput, completion: "0.000008" })] }
            : url === USD_CNY_RATE_URL
              ? { base: "USD", quote: "CNY", date: "2026-11-14", rate: 6.8 }
              : null;
    return new Response(json ? JSON.stringify(json) : "", { status: 200 });
  };
  await loadPricingFile({ homeDir });
  await refreshAutomaticPricing({
    homeDir,
    force: true,
    usedModels: [],
    now: new Date("2026-11-14T00:00:00Z"),
    pricingFetcher: fetcher,
  });
  const archived = readPricingSourceCatalogs(pricingSourceCatalogFile({ homeDir }));
  assert.deepEqual(archived[MODEL_PRICES_URL].payload, modelsDev);
  assert.equal(archived[OPENROUTER_PRICES_URL].payload.data.length, 1);
  assert.equal(getPricingCatalog().models["gemini-archive-unused"], undefined);
  assert.equal(getPricingCatalog().models["orbit-archive-test"], undefined);
  await loadPricingFile({ homeDir });
  const fromCache = await refreshAutomaticPricing({
    homeDir,
    usedModels: ["gateway/orbit-archive-test", "google/gemini-archive-used"],
    now: new Date("2026-11-14T00:10:00Z"),
    pricingFetcher: () => {
      assert.fail("complete local catalog matches must not download again");
    },
  });
  assert.deepEqual(fromCache.discovery.addedModels, ["gemini-archive-used", "orbit-archive-test"]);
  assert.equal(getPricingCatalog().models["gemini-archive-unused"], undefined);
  assert.equal(getPricingCatalog().models["orbit-archive-test"].short.input, 2);
  assert.equal(fromCache.modelReleaseDates["gemini-archive-used"], "2026-11-12");
  const edited = getPricingCatalog();
  edited.models["orbit-archive-test"].short.input = 7;
  await savePricingFile({ homeDir }, edited);
  routerInput = "0.000004";
  const refreshed = await refreshAutomaticPricing({
    homeDir,
    force: true,
    now: new Date("2026-11-15T00:00:00Z"),
    pricingFetcher: fetcher,
  });
  assert.equal(refreshed.priceUpdatedAt, "2026-11-15T00:00:00.000Z");
  assert.ok(refreshed.priceUpdateSummary.verifiedModelCount >= 2);
  assert.equal(getPricingCatalog().models["orbit-archive-test"].short.input, 7);
  assert.equal(getPricingCatalog().models["orbit-archive-test"].long.input, 4);
  assert.equal(getPricingCatalog().models["gemini-archive-unused"], undefined);
  const stateFile = automaticPricingFile({ homeDir });
  const cache = JSON.parse(await readFile(stateFile, "utf8"));
  cache.pricePartialFailure = false;
  cache.exchangeRateAttemptedAt = "2026-11-13T00:00:00Z";
  await writeFile(stateFile, JSON.stringify(cache));
  await loadPricingFile({ homeDir });
  const fxOnly = await refreshAutomaticPricing({
    homeDir,
    now: new Date("2026-11-15T00:10:00Z"),
    pricingFetcher: async (url) => {
      assert.equal(url, USD_CNY_RATE_URL);
      return fetcher(url);
    },
  });
  assert.deepEqual(fxOnly.catalogSources, refreshed.catalogSources);
  await refreshAutomaticPricing({
    homeDir,
    force: true,
    now: new Date("2026-11-16T00:00:00Z"),
    pricingFetcher: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(
    readPricingSourceCatalogs(pricingSourceCatalogFile({ homeDir }))[OPENROUTER_PRICES_URL].fetchedAt,
    "2026-11-15T00:00:00.000Z",
  );
  assert.equal(getPricingCatalog().models["orbit-archive-test"].short.input, 7);
});
