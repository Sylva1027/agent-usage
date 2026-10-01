import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import { runInNewContext } from "node:vm";

import { CLAUDE_MODEL_SNAPSHOTS, resolvePricingModel } from "../public/pricing-models.js";
import { pricingScenarioNotes, renderPricingSourceLinksHtml, setSummaryFilters, summarize } from "../public/app.js";
import {
  modelsDevPricePatches,
  MODEL_PRICES_URL,
  USD_CNY_RATE_URL,
  pricingSourceCoverage,
  parseOpenAIModelPricing,
} from "../src/pricing-auto.js";
import {
  ANTHROPIC_PRICING_SOURCE,
  MAX_PRICING_MODELS,
  estimateEventCost,
  getDefaultPricingCatalog,
  getPricingCatalog,
  mergePricingCatalog,
  resetPricingCatalog,
  validatePricingCatalog,
} from "../src/pricing.js";
import {
  loadPricingFile,
  refreshAutomaticPricing,
  savePricingFile,
  getAutomaticPricingStatus,
} from "../src/pricing-store.js";
import { dshUsageFromRaw } from "../src/dsh-usage.js";
import { opencodeUsageFromTokens } from "../src/opencode-usage.js";
import { validateUsageDetails } from "../public/usage-fields.js";
import { UsageStore, STORE_SCHEMA_VERSION } from "../src/usage-store.js";
import { buildUsageReport, summarizeUsage } from "../src/usage-core.js";
import { renderStaticDashboardHtml } from "../src/static-export.js";

function event(overrides = {}) {
  return {
    model: "claude-haiku-4-5",
    usage: { total: 10_500, input: 10_000, cached: 8_000, output: 500, reasoning: 100 },
    detailMask: 47,
    cacheWriteTokens: 1_000,
    cacheWriteKnown: true,
    requestInputTokens: 10_000,
    contextLevel: "short",
    serviceTier: "standard",
    ...overrides,
  };
}

function remote(cost = {}) {
  return { cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25, ...cost } };
}

test("Claude catalog prices current cache-read exceptions and declared Fast SKUs independently", () => {
  const catalog = getDefaultPricingCatalog();
  assert.equal(Object.keys(catalog.models).filter((key) => key.startsWith("claude-")).length, 17);
  assert.equal(catalog.models["claude-opus-5-5"].short.cachedInput, 0.2);
  assert.equal(catalog.models["claude-fable-5-1"].short.cachedInput, 0.25);
  assert.equal(catalog.models["claude-sonnet-4-6"].short.output, 15);
  assert.equal(catalog.models["claude-sonnet-5-5"].short.output, 10);
  assert.equal(catalog.models["claude-opus-5-5"].fast.short.input, 8);
  assert.equal(catalog.models["claude-opus-4-6"].fast, undefined);
  for (const [name, entry] of Object.entries(catalog.models).filter(([key]) => key.startsWith("claude-"))) {
    assert.equal(entry.currency, "USD", name);
    assert.equal(entry.source, ANTHROPIC_PRICING_SOURCE, name);
    assert.equal(entry.cacheWriteTtl, "5m", name);
  }
});

test("Claude pinned snapshots and namespace aliases resolve without future-version prefix borrowing", () => {
  const models = getDefaultPricingCatalog().models;
  for (const [snapshot, key] of Object.entries(CLAUDE_MODEL_SNAPSHOTS)) {
    assert.equal(resolvePricingModel(snapshot.toUpperCase(), models).catalogKey, key);
    assert.equal(resolvePricingModel(`anthropic/${snapshot}`, models).catalogKey, key);
  }
  assert.equal(resolvePricingModel("anthropic/claude-sonnet-4-6", models).catalogKey, "claude-sonnet-4-6");
  for (const unknown of [
    "claude-sonnet-4-9",
    "claude-opus-5-6",
    "claude-sonnet-4-5-20991231",
    "anthropic.claude-sonnet-4-5-20250929-v1:0",
    "claude-haiku-4-5@20251001",
  ]) {
    assert.equal(resolvePricingModel(unknown, models).matchType, "missing", unknown);
  }
  assert.equal(resolvePricingModel("claude-sonnet-4-9-free", models).matchType, "free");
  assert.equal(resolvePricingModel("claude-sonnet-4-9", { ...models, "claude-sonnet-4-9": {} }).matchType, "exact");
  assert.equal(estimateEventCost(event({ model: "claude-sonnet-4-9" })).priceSource, "");
});

test("Claude fee splits cache writes from input and marks unknown TTL; known 1h writes stay unpriced", () => {
  const estimate = estimateEventCost(event());
  assert.ok(Math.abs(estimate.totalUsd - 0.00555) < 1e-12);
  assert.equal(estimate.pricedTokens, 10_500);
  assert.equal(estimate.cacheWriteInputUsd, 0.00125);
  assert.ok(estimate.unpricedReasons.includes("cache-write-ttl-unknown-5m-scenario"));
  assert.ok(
    !estimateEventCost(event({ cacheWriteTtl: "5m" })).unpricedReasons.includes("cache-write-ttl-unknown-5m-scenario"),
  );
  const oneHour = estimateEventCost(event({ cacheWriteTtl: "1h" }));
  assert.equal(oneHour.cacheWriteInputUsd, 0);
  assert.equal(oneHour.unpricedTokens, 1_000);
  assert.equal(oneHour.pricedTokens, 9_500);
  assert.ok(Math.abs(oneHour.totalUsd - 0.0043) < 1e-12);
  assert.ok(oneHour.unpricedReasons.includes("cache-write-ttl-unsupported"));
  const noWrite = estimateEventCost(event({ cacheWriteTokens: 0 }));
  assert.ok(!noWrite.unpricedReasons.includes("cache-write-ttl-unknown-5m-scenario"));
});

test("Claude modern contexts keep uniform fees and unsupported Fast models use an explicit Standard scenario", () => {
  const regular = estimateEventCost(event({ model: "claude-sonnet-4-6" }));
  const long = estimateEventCost(
    event({ model: "claude-sonnet-4-6", requestInputTokens: 900_000, contextLevel: "long" }),
  );
  assert.equal(long.totalUsd, regular.totalUsd);
  const unsupportedFast = estimateEventCost(event({ model: "claude-sonnet-4-6", serviceTier: "fast" }));
  assert.equal(unsupportedFast.totalUsd, regular.totalUsd);
  assert.ok(unsupportedFast.unpricedReasons.includes("fast-pricing-unavailable-standard-scenario"));
  const opus = estimateEventCost(event({ model: "claude-opus-5-5" }));
  assert.equal(estimateEventCost(event({ model: "claude-opus-5-5", serviceTier: "fast" })).totalUsd, opus.totalUsd * 2);
  const legacy = estimateEventCost(event({ model: "claude-opus-4-1", requestInputTokens: 300_000 }));
  assert.ok(legacy.unpricedReasons.includes("legacy-context-pricing-unverified-standard-scenario"));
  const unknown = estimateEventCost(event({ model: "claude-sonnet-4-9" }));
  const unknownFast = estimateEventCost(event({ model: "claude-sonnet-4-9", serviceTier: "fast" }));
  assert.equal(unknownFast.totalUsd, unknown.totalUsd);
  assert.ok(unknownFast.unpricedReasons.includes("fast-pricing-unavailable-standard-scenario"));
});

test("expanded capacity accepts a savable 256-model catalog and distinguishes capacity from missing built-ins", () => {
  const catalog = getDefaultPricingCatalog();
  const slots = MAX_PRICING_MODELS - Object.keys(catalog.models).length;
  for (let index = 0; index < slots; index++)
    catalog.models[`custom-${index}`] = structuredClone(catalog.models["gpt-6-sol"]);
  assert.equal(Object.keys(validatePricingCatalog(catalog).models).length, MAX_PRICING_MODELS);
  assert.ok(Buffer.byteLength(JSON.stringify(catalog)) < 128 * 1024);
  catalog.models.extra = catalog.models["gpt-6-sol"];
  assert.throws(() => validatePricingCatalog(catalog), /at most 256 models/);
  const legacy = getDefaultPricingCatalog();
  for (const key of Object.keys(legacy.models).filter((key) => key.startsWith("claude-"))) delete legacy.models[key];
  legacy.models["gpt-6-sol"].short.input = 9;
  const merged = validatePricingCatalog(mergePricingCatalog(legacy));
  assert.equal(merged.models["gpt-6-sol"].short.input, 9);
  assert.equal(merged.models["claude-haiku-4-5"].cacheWriteTtl, "5m");
});

test("Anthropic automatic patches isolate providers, pinned identities, 5m writes and Fast capability", () => {
  const catalog = getDefaultPricingCatalog();
  const payload = {
    anthropic: { models: { "claude-haiku-4-5-20251001": remote() } },
    openrouter: { models: { "claude-sonnet-4-6": remote({ input: 99 }) } },
  };
  const patch = modelsDevPricePatches(payload, catalog);
  assert.equal(patch["claude-haiku-4-5"].short.input, 1);
  assert.equal(patch["claude-haiku-4-5"].__metadata.short.providerId, "anthropic");
  assert.equal(patch["claude-sonnet-4-6"], undefined);
  payload.anthropic.models["claude-haiku-4-5"] = remote({
    cache_write: 2,
    cache_write_ttl: "1h",
    fast: { input: 2, output: 10 },
  });
  delete payload.anthropic.models["claude-haiku-4-5-20251001"];
  const oneHour = modelsDevPricePatches(payload, catalog)["claude-haiku-4-5"];
  assert.equal(oneHour.short.cacheWrite, 1.25);
  assert.ok(oneHour.__metadata.short.inheritedFields.includes("cacheWrite"));
  assert.equal(oneHour.fast, undefined);
  payload.anthropic.models["claude-haiku-4-5-20251001"] = remote({ input: 2 });
  assert.equal(modelsDevPricePatches(payload, catalog)["claude-haiku-4-5"], undefined);
  payload.anthropic.models["claude-sonnet-4-6"] = remote({
    tiers: [{ tier: { type: "context", size: 200_000 }, input: 6, output: 30 }],
  });
  assert.equal(modelsDevPricePatches(payload, catalog)["claude-sonnet-4-6"], undefined);
  assert.equal(pricingSourceCoverage(catalog.models).providers.anthropic, 17);
  assert.equal(
    parseOpenAIModelPricing("claude-sonnet-4-9", {
      modelsDevPayload: { openai: { models: { "claude-sonnet-4-9": remote({ context_policy: "uniform" }) } } },
    }).reason,
    "unsupported-provider",
  );
});

test("Anthropic automatic refresh persists provider identity and keeps manual fields through later updates and failure", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "claude-pricing-"));
  try {
    await loadPricingFile({ homeDir });
    let input = 1.2;
    const pricingFetcher = async (url) =>
      new Response(
        url === MODEL_PRICES_URL
          ? JSON.stringify({
              anthropic: { models: { "claude-haiku-4-5": remote({ input, cache_write: input * 1.25 }) } },
            })
          : url === USD_CNY_RATE_URL
            ? JSON.stringify({ base: "USD", quote: "CNY", date: "2026-10-01", rate: 6.8 })
            : "{}",
      );
    await refreshAutomaticPricing({ homeDir, force: true, pricingFetcher });
    assert.equal(getPricingCatalog().models["claude-haiku-4-5"].short.input, 1.2);
    const edited = getPricingCatalog();
    edited.models["claude-haiku-4-5"].short.input = 7;
    await savePricingFile({ homeDir }, edited);
    input = 1.4;
    await refreshAutomaticPricing({ homeDir, force: true, pricingFetcher });
    await loadPricingFile({ homeDir });
    const price = getPricingCatalog().models["claude-haiku-4-5"];
    assert.equal(price.short.input, 7);
    assert.equal(price.short.cacheWrite, 1.75);
    assert.equal(price.cacheWriteTtl, "5m");
    assert.equal(getAutomaticPricingStatus().modelMetadata["claude-haiku-4-5"].short.providerId, "anthropic");
    const failure = await refreshAutomaticPricing({
      homeDir,
      force: true,
      pricingFetcher: async () => {
        throw new Error("offline");
      },
    });
    assert.ok(failure.issues.length > 0);
    assert.deepEqual(getPricingCatalog().models["claude-haiku-4-5"], price);
  } finally {
    resetPricingCatalog();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("DSH and OpenCode count nonzero Claude writes once, including when the provider total is absent", () => {
  for (const totalTokens of [10_500, undefined]) {
    const mapped = dshUsageFromRaw({
      inputTokens: 1_000,
      cacheReadTokens: 8_000,
      cacheWriteTokens: 1_000,
      outputTokens: 500,
      totalTokens,
    });
    assert.equal(mapped.usage.input, 10_000);
    assert.equal(mapped.usage.total, 10_500);
    assert.equal(mapped.requestInputTokens, 10_000);
    assert.equal(validateUsageDetails(mapped.usage, mapped.detailMask).reconciliationGap, 0);
    assert.ok(Math.abs(estimateEventCost(event({ ...mapped })).totalUsd - 0.00555) < 1e-12);
  }
  const mapped = opencodeUsageFromTokens({
    input: 1_000,
    cache: { read: 8_000, write: 1_000 },
    output: 400,
    reasoning: 100,
  });
  assert.equal(mapped.usage.total, 10_500);
  assert.equal(mapped.usage.output, 500);
  assert.ok(
    Math.abs(estimateEventCost(event({ usage: mapped.usage, detailMask: mapped.detailMask })).totalUsd - 0.00555) <
      1e-12,
  );
});

test("v9 and v10 indexes mark only unchanged DSH files for reindexing", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "claude-index-"));
  try {
    for (const previousVersion of [9, 10]) {
      const databaseFile = path.join(homeDir, `index-${previousVersion}.sqlite`);
      const initial = new UsageStore({ homeDir, databaseFile });
      await initial.open();
      for (const kind of ["dsh", "opencode", "zcode", "main"])
        initial.database
          .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(`${kind}.log`, kind, kind, kind, homeDir, 99, 123, "2026-10-01");
      initial.database.exec(`PRAGMA user_version = ${previousVersion}`);
      initial.close();
      const migrated = new UsageStore({ homeDir, databaseFile });
      try {
        await migrated.open();
        assert.equal(migrated.database.prepare("PRAGMA user_version").get().user_version, STORE_SCHEMA_VERSION);
        for (const row of migrated.database.prepare("SELECT kind, size, mtime_ms FROM source_files").all()) {
          assert.equal(row.size, row.kind === "dsh" ? -1 : 99);
          assert.equal(row.mtime_ms, row.kind === "dsh" ? -1 : 123);
        }
      } finally {
        migrated.close();
      }
    }
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("Claude scenario notes and source links are visible in both supported languages", () => {
  const reasons = ["cache-write-ttl-unknown-5m-scenario", "legacy-context-pricing-unverified-standard-scenario"];
  assert.match(pricingScenarioNotes(reasons, "zh-CN").join(";"), /5 分钟/);
  assert.match(pricingScenarioNotes(reasons, "en-US").join(";"), /5-minute/);
  assert.match(renderPricingSourceLinksHtml([ANTHROPIC_PRICING_SOURCE], ["USD"]), /Anthropic 定价/);
});

test("Claude DSH history, manual repricing and TTL notes agree between memory, SQLite and static export", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "claude-three-path-"));
  const store = new UsageStore({ homeDir, env: {}, databaseFile: path.join(homeDir, "usage.sqlite") });
  const asOf = new Date("2026-10-01T12:00:00Z");
  try {
    await loadPricingFile({ homeDir });
    const sessionDir = path.join(homeDir, ".dsh", "sessions", "fixture", "claude-session");
    await mkdir(sessionDir, { recursive: true });
    const rows = [
      {
        type: "session",
        version: 4,
        id: "claude-session",
        createdAt: asOf.getTime() - 2000,
        cwd: homeDir,
        delegationDepth: 0,
      },
      {
        type: "request/header",
        seq: 1,
        time: asOf.getTime() - 1000,
        data: { header: { config: { provider: "anthropic", model: "claude-haiku-4-5-20251001" } } },
      },
      {
        type: "assistant/message",
        seq: 2,
        time: asOf.getTime() - 500,
        data: {
          turn: 1,
          step: 1,
          usage: {
            inputTokens: 1_000,
            cacheReadTokens: 8_000,
            cacheWriteTokens: 1_000,
            outputTokens: 500,
            totalTokens: 10_500,
          },
        },
      },
    ];
    await writeFile(
      path.join(sessionDir, "session.v4.jsonl.zstd"),
      zstdCompressSync(Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)),
    );
    await store.sync();
    const report = await buildUsageReport({ homeDir, env: {}, asOf });
    assert.equal(report.events.length, 1);
    const filters = { preset: "all", bucket: "day", calendarZone: "utc", now: asOf };
    const check = (expected) => {
      const memory = summarizeUsage(report, filters);
      const indexed = store.summarize(filters);
      const html = renderStaticDashboardHtml({ ...report, asOf: asOf.toISOString() });
      const data = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .map((match) => match[1])
        .find((script) => script.includes("window.__CODEX_USAGE_REPORT__ ="));
      assert.ok(data);
      const sandbox = { window: {} };
      runInNewContext(data, sandbox);
      setSummaryFilters({ ...filters, excludedHomes: [], startDate: "", endDate: "", recentValue: "" });
      const snapshot = summarize(JSON.parse(JSON.stringify(sandbox.window.__CODEX_USAGE_REPORT__)));
      for (const result of [memory, indexed, snapshot]) {
        assert.equal(result.totals.input, 10_000);
        assert.equal(result.totals.total, 10_500);
        assert.ok(Math.abs(result.costEstimate.totalUsd - expected) < 1e-12);
        assert.ok(result.costEstimate.unpricedReasons.includes("cache-write-ttl-unknown-5m-scenario"));
        assert.ok(result.timeline[0].scenarioReasons.includes("cache-write-ttl-unknown-5m-scenario"));
      }
    };
    check(0.00555);
    const edited = getPricingCatalog();
    edited.models["claude-haiku-4-5"].short.input = 2;
    edited.models["claude-haiku-4-5"].long.input = 2;
    await savePricingFile({ homeDir }, edited);
    check(0.00655);
    assert.equal(report.events[0].total.input, 10_000);
  } finally {
    resetPricingCatalog();
    setSummaryFilters({ preset: "today", bucket: "hour", calendarZone: "local", now: null, excludedHomes: [] });
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
