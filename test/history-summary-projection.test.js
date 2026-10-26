import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HistoryQuoteInputs } from "../src/history-quote-inputs.js";
import { getPricingCatalog, resetPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { serviceTierEvidenceFromSnapshot } from "../src/service-tier-evidence.js";
import { UsageStore } from "../src/usage-store.js";

const now = "2026-07-12T12:00:00.000Z";
const filters = { preset: "all", bucket: "day", calendarZone: "utc", now };

function event(overrides = {}) {
  return {
    source_path: "/fixture/usage.jsonl",
    timestamp_ms: Date.parse("2026-07-12T02:00:00.000Z"),
    session_id: "projection-session",
    home_id: "home-a",
    home_label: "Home A",
    channel: "CLI",
    project: "project-a",
    model: "gpt-6-sol",
    hour_key: "2026-07-12 02",
    day_key: "2026-07-12",
    week_key: "2026-07-06",
    month_key: "2026-07",
    detail_mask: 31,
    cache_write_tokens: 0,
    cache_write_known: 1,
    request_input_tokens: 0,
    context_level: "short",
    service_tier: "unknown",
    price_version: "fixture",
    total: 100,
    input: 80,
    cached: 0,
    output: 20,
    reasoning: 0,
    ...overrides,
  };
}

function insertEvent(store, row) {
  const columns = Object.keys(row);
  store.database
    .prepare(`INSERT INTO events (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...Object.values(row));
}

test("all-hot summary projection is reusable, isolated, and input-complete", async (t) => {
  const storeRoot = await mkdtemp(path.join(os.tmpdir(), "summary-projection-"));
  const databaseFile = path.join(storeRoot, "usage-index.sqlite");
  const originalCatalog = getPricingCatalog();
  let store;
  try {
    store = new UsageStore({ homeDir: storeRoot, databaseFile });
    await store.open();
    store.database
      .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("/fixture/usage.jsonl", "main", "home-a", "Home A", storeRoot, 1, 1, now);
    insertEvent(store, event());
    store.commitStoreRevision("fixture");

    let timelineCalls = 0;
    let factBuilds = 0;
    let costReads = 0;
    const costEventsForRange = store.costEventsForRange;
    store.costEventsForRange = function (...args) {
      costReads += 1;
      return costEventsForRange.apply(this, args);
    };
    let repositoryCalls = 0;
    const timelineRange = store.timelineRange;
    store.timelineRange = function (...args) {
      timelineCalls += 1;
      if (!args[2]?.factRows) factBuilds += 1;
      return timelineRange.apply(this, args);
    };
    const repositoriesRange = store.repositoriesRange;
    store.repositoriesRange = function (...args) {
      repositoryCalls += 1;
      return repositoriesRange.apply(this, args);
    };

    const first = store.summarize(filters);
    assert.ok(store.summaryProjectionCache?.key, "first all-hot summary must publish a projection");
    assert.equal(timelineCalls, 1);
    const second = store.summarize(filters);
    assert.deepEqual(second, first, "same inputs must return the same summary");
    assert.notStrictEqual(second.timeline, first.timeline, "each caller gets isolated projection rows");
    assert.equal(timelineCalls, 1, "same inputs must hit the projection");

    second.timeline[0].total.total = -1;
    second.channels[0].total.total = -1;
    second.costEstimate.totalUsd = -1;
    const afterMutation = store.summarize(filters);
    assert.equal(afterMutation.timeline[0].total.total, 100, "timeline mutation must stay caller-local");
    assert.equal(afterMutation.channels[0].total.total, 100, "channel mutation must stay caller-local");
    assert.ok(afterMutation.costEstimate.totalUsd >= 0, "cost mutation must stay caller-local");
    assert.equal(timelineCalls, 1, "caller mutation must not force or poison a rebuild");

    insertEvent(
      store,
      event({
        timestamp_ms: Date.parse("2026-07-12T03:00:00.000Z"),
        hour_key: "2026-07-12 03",
        model: "Projection-Future-Model",
        total: 200,
        input: 160,
        output: 40,
      }),
    );
    store.commitStoreRevision("fixture-event");
    const afterEvent = store.summarize(filters);
    assert.equal(afterEvent.totals.total, 300, "event change must invalidate the projection");
    assert.ok(timelineCalls > 1, "event change must rebuild the static rows");

    const initialVersion = originalCatalog.version;
    const scaleSolRates = (catalog) => {
      const entry = catalog.models["gpt-6-sol"];
      for (const rates of [entry.short, entry.long, entry.fast.short, entry.fast.long]) {
        for (const field of ["input", "cachedInput", "cacheWrite", "output"]) rates[field] *= 1000;
      }
    };
    const changedCatalogA = structuredClone(originalCatalog);
    scaleSolRates(changedCatalogA);
    const changedVersionA = setPricingCatalog(changedCatalogA).version;
    const changedCatalogB = structuredClone(changedCatalogA);
    scaleSolRates(changedCatalogB);
    const changedVersionB = setPricingCatalog(changedCatalogB).version;
    assert.notEqual(changedVersionA, initialVersion, "changed rates must change the catalog hash version");
    assert.notEqual(changedVersionA, changedVersionB, "same checkedAt content changes must change the catalog hash");
    const callsBeforePricing = timelineCalls;
    const factsBeforePricing = factBuilds;
    const repositoriesBeforePricing = repositoryCalls;
    const readsBeforePricing = costReads;
    const afterPricing = store.summarize(filters);
    assert.ok(timelineCalls > callsBeforePricing, "catalog content change must reprice events");
    assert.equal(factBuilds, factsBeforePricing, "rate-only changes must reuse timeline facts");
    assert.equal(repositoryCalls, repositoriesBeforePricing, "rate-only changes must reuse repository facts");
    assert.equal(costReads, readsBeforePricing, "rate-only changes replay the complete quote input without SQL rows");
    assert.notDeepEqual(afterPricing.costEstimate, afterEvent.costEstimate);
    assert.notEqual(afterPricing.costEstimate.priceVersions[0], initialVersion);
    assert.notEqual(afterPricing.costEstimate.totalUsd, afterEvent.costEstimate.totalUsd);
    const repricedCache = store.summaryProjectionCache;
    store.summaryProjectionCache = null;
    assert.deepEqual(afterPricing, store.summarize(filters), "repricing must equal a complete fresh projection");
    store.summaryProjectionCache = repricedCache;

    const changedFx = structuredClone(changedCatalogB);
    changedFx.usdToCnyRate *= 2;
    setPricingCatalog(changedFx);
    const factsBeforeFx = factBuilds;
    const repositoriesBeforeFx = repositoryCalls;
    const readsBeforeFx = costReads;
    const afterFx = store.summarize(filters);
    assert.equal(afterFx.costEstimate.totalUsd, afterPricing.costEstimate.totalUsd);
    assert.equal(afterFx.costEstimate.usdToCnyRate, changedFx.usdToCnyRate);
    assert.equal(factBuilds, factsBeforeFx, "FX-only changes must reuse timeline facts");
    assert.equal(repositoryCalls, repositoriesBeforeFx, "FX-only changes must reuse repositories");
    assert.equal(costReads, readsBeforeFx, "FX-only changes retain the same complete quote input");
    const fxCache = store.summaryProjectionCache;
    store.summaryProjectionCache = null;
    assert.deepEqual(afterFx, store.summarize(filters), "FX-only repricing must equal a full rebuild");
    store.summaryProjectionCache = fxCache;

    const changedModels = structuredClone(changedCatalogB);
    changedModels.models["projection-future-model"] = structuredClone(changedModels.models["gpt-6-sol"]);
    setPricingCatalog(changedModels);
    const factsBeforeModelChange = factBuilds;
    const afterModelChange = store.summarize(filters);
    assert.ok(factBuilds > factsBeforeModelChange, "a changed model mapping must rebuild facts");
    assert.ok(afterEvent.models.some((row) => row.name === "Projection-Future-Model"));
    assert.ok(afterModelChange.models.some((row) => row.name === "projection-future-model"));
    assert.ok(afterModelChange.timeline[0].models.some((row) => row.name === "projection-future-model"));

    setPricingCatalog(originalCatalog);
    const eventTime = Date.parse("2026-07-12T02:00:00.000Z");
    const standardEvidence = serviceTierEvidenceFromSnapshot({
      formatVersion: 1,
      threads: [{ threadId: "projection-session", turns: [{ time: eventTime - 1, tier: "standard" }] }],
    });
    const fastEvidence = serviceTierEvidenceFromSnapshot({
      formatVersion: 1,
      threads: [{ threadId: "projection-session", turns: [{ time: eventTime - 1, tier: "fast" }] }],
    });

    store.serviceTierEvidence = standardEvidence;
    store.serviceTierEvidenceInput = "fixture-standard-signature";
    const standardProjection = store.summarize(filters);
    const callsAfterStandard = timelineCalls;
    const standardCost = standardProjection.costEstimate.totalUsd;
    const standardAgain = store.summarize(filters);
    assert.deepEqual(standardAgain, standardProjection, "standard tier projection must hit");
    assert.equal(timelineCalls, callsAfterStandard, "standard tier cache hit must not rebuild timeline");

    const revisionBeforeTier = store.storeRevision;
    store.serviceTierEvidence = fastEvidence;
    store.serviceTierEvidenceInput = "fixture-fast-signature";
    const fastProjection = store.summarize(filters);
    assert.equal(store.storeRevision, revisionBeforeTier, "signature-only tier change must not advance storeRevision");
    assert.ok(timelineCalls > callsAfterStandard, "signature-only tier change must rebuild timeline");
    assert.notEqual(fastProjection.costEstimate.totalUsd, standardCost, "fast tier must change cost");
    const callsAfterFast = timelineCalls;
    const fastAgain = store.summarize(filters);
    assert.deepEqual(fastAgain, fastProjection, "repeated fast tier projection must hit");
    assert.equal(timelineCalls, callsAfterFast, "fast tier cache hit must not rebuild timeline");

    const nonAllFilters = { ...filters, preset: "today", bucket: "hour" };
    const nonAllCallsBefore = timelineCalls;
    const nonAllFirst = store.summarize(nonAllFilters);
    assert.equal(timelineCalls, nonAllCallsBefore + 1, "non-all hot-store path must run its full projection");
    const nonAllSecond = store.summarize(nonAllFilters);
    assert.equal(timelineCalls, nonAllCallsBefore + 2, "non-all hot-store path must not use the all-hot slot");
    assert.notStrictEqual(nonAllSecond.timeline, nonAllFirst.timeline);

    t.diagnostic(
      JSON.stringify({
        cachedKey: true,
        mutationIsolated: true,
        eventInvalidation: true,
        pricingVersions: { initialVersion, changedVersionA, changedVersionB },
        tierInvalidation: true,
        tierRevisionUnchanged: true,
        nonAllAlwaysRebuilds: true,
        timelineCalls,
      }),
    );
  } finally {
    store?.close();
    resetPricingCatalog();
    await rm(storeRoot, { recursive: true, force: true });
  }
});

test("exhausted quote capture keeps complete SQL repricing instead of publishing a prefix", async () => {
  const storeRoot = await mkdtemp(path.join(os.tmpdir(), "summary-quote-budget-"));
  const originalCatalog = getPricingCatalog();
  const append = HistoryQuoteInputs.prototype.append;
  const store = new UsageStore({ homeDir: storeRoot, databaseFile: path.join(storeRoot, "usage-index.sqlite") });
  try {
    await store.open();
    store.database
      .prepare("INSERT INTO source_files VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("/fixture/usage.jsonl", "main", "home-a", "Home A", storeRoot, 1, 1, now);
    insertEvent(store, event());
    insertEvent(store, event({ session_id: "budget-second", model: "glm-4.7" }));
    store.commitStoreRevision("quote-budget-fixture");
    HistoryQuoteInputs.prototype.append = function (...args) {
      this.maxBytes = 1024;
      return append.apply(this, args);
    };
    const first = store.summarize(filters);
    HistoryQuoteInputs.prototype.append = append;
    assert.equal(first.eventCount, 2);
    assert.equal(store.summaryProjectionCache.quoteInputs, null);
    let reads = 0;
    const costEvents = store.costEventsForRange;
    store.costEventsForRange = function (...args) {
      reads += 1;
      return costEvents.apply(this, args);
    };
    const changed = structuredClone(originalCatalog);
    changed.models["gpt-6-sol"].short.input *= 3;
    setPricingCatalog(changed);
    const after = store.summarize(filters);
    assert.equal(reads, 1, "an unavailable complete buffer uses the original SQL stream");
    assert.notDeepEqual(after.costEstimate, first.costEstimate);
    store.summaryProjectionCache = null;
    assert.deepEqual(after, store.summarize(filters));
  } finally {
    HistoryQuoteInputs.prototype.append = append;
    store.close();
    resetPricingCatalog();
    await rm(storeRoot, { recursive: true, force: true });
  }
});
