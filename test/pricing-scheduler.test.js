import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getDefaultPricingCatalog,
  getPricingCatalog,
  resetPricingCatalog,
  runWithPricingCatalog,
  setPricingCatalog,
} from "../src/pricing.js";
import {
  GLM_PRICES_URL,
  LITELLM_PRICES_URL,
  MIMO_PRICES_URL,
  MODEL_PRICES_URL,
  STEPFUN_PRICES_URL,
  USD_CNY_RATE_URL,
  KIMI_PRICES_URL,
} from "../src/pricing-auto.js";
import { automaticPricingFile } from "../src/pricing-store.js";
import { createUsageServer } from "../src/server.js";

const HOUR_MS = 60 * 60 * 1000;

function modelsDevCatalog() {
  return {
    openai: {
      models: {
        "gpt-6-sol": {
          cost: {
            input: 3,
            output: 12,
            cache_read: 0.3,
            cache_write: 3.75,
          },
        },
      },
    },
  };
}

function pricingFetcher({ calls, failGlm = false, beforeFetch = null } = {}) {
  return async (url) => {
    calls.push(url);
    await beforeFetch?.(url);
    if (failGlm && url === GLM_PRICES_URL) throw new Error("GLM offline");
    if (url === MODEL_PRICES_URL) {
      return new Response(JSON.stringify(modelsDevCatalog()), { status: 200 });
    }
    if (url === LITELLM_PRICES_URL) return new Response("{}", { status: 200 });
    if (url === USD_CNY_RATE_URL) {
      return new Response(JSON.stringify({ base: "USD", quote: "CNY", date: "2026-10-26", rate: 6.8 }), {
        status: 200,
      });
    }
    if ([MIMO_PRICES_URL, STEPFUN_PRICES_URL, KIMI_PRICES_URL, GLM_PRICES_URL].includes(url)) {
      return new Response("", { status: 200, headers: { "content-type": "text/html" } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
}

function fakeScheduler() {
  const timers = [];
  return {
    timers,
    schedule(callback, delay) {
      const timer = {
        callback,
        delay,
        cancelled: false,
        unrefCalls: 0,
        unref() {
          this.unrefCalls += 1;
        },
      };
      timers.push(timer);
      return timer;
    },
    cancel(timer) {
      timer.cancelled = true;
    },
  };
}

async function waitUntil(predicate, message) {
  for (let index = 0; index < 500; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(message);
}

async function createFixtureServer(options = {}, automaticState = null, beforeListen = null) {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-pricing-scheduler-"));
  if (automaticState) {
    const cacheFile = automaticPricingFile({ homeDir });
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(automaticState));
  }
  const server = createUsageServer({
    homeDir,
    databaseFile: path.join(homeDir, ".codex-usage", "usage-index.sqlite"),
    automaticDiscoveryEnabled: false,
    ...options,
  });
  await beforeListen?.(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { homeDir, server };
}

function recentAutomaticState(now, { pricePartialFailure = false } = {}) {
  const timestamp = now.toISOString();
  return {
    priceAttemptedAt: timestamp,
    priceUpdatedAt: timestamp,
    pricePartialFailure,
    exchangeRateAttemptedAt: timestamp,
    exchangeRateUpdatedAt: timestamp,
    exchangeRateDate: "2026-10-26",
    usdToCnyRate: 6.8,
  };
}

async function closeFixture(fixture) {
  await fixture.server.close();
  await rm(fixture.homeDir, { recursive: true, force: true });
}

test("scheduler checks after pricing is ready, honors 24h success, and exits request pricing", async () => {
  const originalPricing = getPricingCatalog();
  const calls = [];
  const observedVersions = [];
  const scheduler = fakeScheduler();
  let now = new Date("2026-10-26T00:00:00.000Z");
  const fixture = await createFixtureServer(
    {
      schedulePricingRefresh: scheduler.schedule,
      cancelPricingRefresh: scheduler.cancel,
      pricingRefreshNow: () => now,
      pricingFetcher: pricingFetcher({
        calls,
        beforeFetch: () => observedVersions.push(getPricingCatalog().version),
      }),
    },
    recentAutomaticState(now),
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      assert.equal(scheduler.timers.length, 0, "constructing the server must not start a network check");
      assert.equal(calls.length, 0);
    },
  );

  try {
    await waitUntil(() => scheduler.timers.length === 1, "startup check did not schedule the next timer");
    assert.equal(calls.length, 0);
    assert.equal(scheduler.timers[0].delay, HOUR_MS);
    assert.equal(scheduler.timers[0].unrefCalls, 1);

    now = new Date(now.getTime() + HOUR_MS);
    scheduler.timers[0].callback();
    await waitUntil(() => scheduler.timers.length === 2, "the 1h due check did not reschedule");
    assert.equal(calls.length, 0, "a successful refresh must wait for the 24h threshold");

    const catalogA = getPricingCatalog();
    const catalogB = structuredClone(catalogA);
    catalogB.models["gpt-6-sol"].short.input += 1;
    const liveCatalog = setPricingCatalog(catalogB);
    observedVersions.length = 0;
    now = new Date(now.getTime() + 23 * HOUR_MS);
    await runWithPricingCatalog(catalogA, scheduler.timers[1].callback);
    await waitUntil(() => scheduler.timers.length === 3, "the 24h check did not reschedule");
    assert.equal(calls.length, 7);
    assert.ok(observedVersions.length > 0);
    assert.ok(observedVersions.every((version) => version === liveCatalog.version));
  } finally {
    await closeFixture(fixture);
    setPricingCatalog(originalPricing);
  }
});

test("scheduler retries a partial price failure after one hour", async () => {
  const originalPricing = getPricingCatalog();
  const calls = [];
  const scheduler = fakeScheduler();
  let now = new Date("2026-10-26T00:00:00.000Z");
  const fixture = await createFixtureServer(
    {
      schedulePricingRefresh: scheduler.schedule,
      cancelPricingRefresh: scheduler.cancel,
      pricingRefreshNow: () => now,
      pricingFetcher: pricingFetcher({ calls, failGlm: true }),
    },
    recentAutomaticState(now, { pricePartialFailure: true }),
  );

  try {
    await waitUntil(() => scheduler.timers.length === 1, "startup check did not schedule the next timer");
    assert.equal(calls.length, 0);
    now = new Date(now.getTime() + HOUR_MS);
    scheduler.timers[0].callback();
    await waitUntil(() => scheduler.timers.length === 2, "the retry did not reschedule");
    assert.equal(calls.length, 6, "a failed price check must retry after one hour without refetching FX");
  } finally {
    await closeFixture(fixture);
    setPricingCatalog(originalPricing);
  }
});

test("scheduler coalesces with an in-flight manual refresh", async () => {
  const originalPricing = getPricingCatalog();
  const calls = [];
  const scheduler = fakeScheduler();
  let now = new Date("2026-10-26T00:00:00.000Z");
  let gate = null;
  const fixture = await createFixtureServer(
    {
      schedulePricingRefresh: scheduler.schedule,
      cancelPricingRefresh: scheduler.cancel,
      pricingRefreshNow: () => now,
      pricingFetcher: pricingFetcher({
        calls,
        beforeFetch: async (url) => {
          if (url !== MODEL_PRICES_URL || !gate) return;
          const activeGate = gate;
          gate = null;
          activeGate.started();
          await activeGate.released;
        },
      }),
    },
    recentAutomaticState(now),
  );

  try {
    await waitUntil(() => scheduler.timers.length === 1, "startup check did not schedule the next timer");
    assert.equal(calls.length, 0);
    let startedResolve;
    let releaseResolve;
    const started = new Promise((resolve) => {
      startedResolve = resolve;
    });
    const released = new Promise((resolve) => {
      releaseResolve = resolve;
    });
    gate = { started: startedResolve, released };

    const baseUrl = `http://127.0.0.1:${fixture.server.address().port}`;
    const manual = fetch(`${baseUrl}/api/pricing/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    await started;
    assert.equal(calls.length, 7);

    now = new Date(now.getTime() + HOUR_MS);
    scheduler.timers[0].callback();
    await new Promise(setImmediate);
    assert.equal(calls.length, 7, "a scheduler check must not duplicate an active global refresh");

    releaseResolve();
    assert.equal((await manual).status, 200);
    await waitUntil(() => scheduler.timers.length === 2, "the scheduler did not resume after the shared refresh");
    assert.equal(calls.length, 7);
  } finally {
    gate = null;
    await closeFixture(fixture);
    setPricingCatalog(originalPricing);
  }
});

test("hourly metadata discovery uses the ready usage scope without forcing six-source maintenance", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-pricing-scheduler-metadata-"));
  const projectRoot = path.join(homeDir, "project");
  let now = new Date("2026-10-26T00:00:00.000Z");
  const cacheFile = automaticPricingFile({ homeDir });
  await mkdir(path.dirname(cacheFile), { recursive: true });
  await mkdir(path.join(projectRoot, ".codex-usage"), { recursive: true });
  await writeFile(cacheFile, JSON.stringify(recentAutomaticState(now)));
  await writeFile(
    path.join(projectRoot, ".codex-usage", "usage.jsonl"),
    `${JSON.stringify({
      schema_version: "codex-usage.project-log.v1",
      timestamp: now.toISOString(),
      session_id: "scheduler-metadata",
      request_id: "scheduler-metadata",
      model: "gpt-scheduler-discovery",
      cwd: projectRoot,
      usage: { total: 1, input: 1, output: 0 },
    })}\n`,
  );
  const calls = [];
  const scheduler = fakeScheduler();
  const discoveryTimers = [];
  const server = createUsageServer({
    homeDir,
    databaseFile: path.join(homeDir, ".codex-usage", "usage-index.sqlite"),
    importDirs: [projectRoot],
    schedulePricingRefresh: scheduler.schedule,
    cancelPricingRefresh: scheduler.cancel,
    schedulePricingDiscovery(callback, delay) {
      const timer = { callback, delay };
      discoveryTimers.push(timer);
      return timer;
    },
    cancelPricingDiscovery(timer) {
      timer.cancelled = true;
    },
    pricingRefreshNow: () => now,
    pricingFetcher: pricingFetcher({ calls }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    await waitUntil(() => scheduler.timers.length === 1, "startup check did not schedule the next timer");
    assert.equal(calls.length, 0);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${baseUrl}/api/usage?preset=all`)).status, 200);
    assert.equal(discoveryTimers.length, 1);

    now = new Date(now.getTime() + HOUR_MS);
    scheduler.timers[0].callback();
    await waitUntil(() => scheduler.timers.length === 2, "metadata discovery did not reschedule");
    assert.deepEqual(calls, [MODEL_PRICES_URL, LITELLM_PRICES_URL]);
  } finally {
    await server.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("close cancels scheduling, waits for the active check, and never reschedules", async () => {
  const originalPricing = getPricingCatalog();
  const calls = [];
  const scheduler = fakeScheduler();
  let startedResolve;
  let releaseResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  const released = new Promise((resolve) => {
    releaseResolve = resolve;
  });
  let gated = false;
  const fixture = await createFixtureServer({
    schedulePricingRefresh: scheduler.schedule,
    cancelPricingRefresh: scheduler.cancel,
    pricingRefreshNow: () => new Date("2026-10-26T00:00:00.000Z"),
    pricingFetcher: pricingFetcher({
      calls,
      beforeFetch: async (url) => {
        if (gated || url !== MODEL_PRICES_URL) return;
        gated = true;
        startedResolve();
        await released;
      },
    }),
  });

  await started;
  let closed = false;
  const closing = fixture.server.close().then(() => {
    closed = true;
  });
  await new Promise(setImmediate);
  assert.equal(closed, false, "close must wait for the active scheduler refresh");
  releaseResolve();
  await closing;
  await new Promise(setImmediate);
  assert.equal(scheduler.timers.length, 0);
  assert.equal(calls.length, 7);
  setPricingCatalog(originalPricing);
  await rm(fixture.homeDir, { recursive: true, force: true });
});

test("read-only import runtime never starts the scheduler", async () => {
  const scheduler = fakeScheduler();
  const calls = [];
  const fixture = await createFixtureServer({
    importContext: {
      pricingCatalog: getDefaultPricingCatalog(),
      automaticPricingStatus: null,
      serviceTierEvidenceSnapshot: null,
    },
    schedulePricingRefresh: scheduler.schedule,
    cancelPricingRefresh: scheduler.cancel,
    pricingFetcher: pricingFetcher({ calls }),
  });

  try {
    await new Promise(setImmediate);
    assert.equal(scheduler.timers.length, 0);
    assert.deepEqual(calls, []);
  } finally {
    await closeFixture(fixture);
  }
});

test("terminal and untimed discovery results do not requeue the fake discovery timer", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-pricing-scheduler-discovery-"));
  const projectRoot = path.join(homeDir, "project");
  const pricingCache = automaticPricingFile({ homeDir });
  await mkdir(path.dirname(pricingCache), { recursive: true });
  await mkdir(path.join(projectRoot, ".codex-usage"), { recursive: true });
  await writeFile(
    pricingCache,
    JSON.stringify({
      discoveryAttemptedAt: {
        "gpt-terminal-discovery": "2026-10-20T00:00:00.000Z",
        "gpt-untimed-discovery": "2026-10-20T00:00:00.000Z",
      },
      discoveryResults: [
        { model: "gpt-terminal-discovery", status: "rejected", reason: "unsupported-provider" },
        { model: "gpt-untimed-discovery", status: "deferred", reason: "not-found" },
      ],
    }),
  );
  await writeFile(
    path.join(projectRoot, ".codex-usage", "usage.jsonl"),
    `${JSON.stringify({
      schema_version: "codex-usage.project-log.v1",
      timestamp: new Date().toISOString(),
      session_id: "scheduler-terminal",
      request_id: "scheduler-terminal",
      model: "gpt-terminal-discovery",
      cwd: projectRoot,
      usage: { total: 1, input: 1, output: 0 },
    })}\n${JSON.stringify({
      schema_version: "codex-usage.project-log.v1",
      timestamp: new Date().toISOString(),
      session_id: "scheduler-untimed",
      request_id: "scheduler-untimed",
      model: "gpt-untimed-discovery",
      cwd: projectRoot,
      usage: { total: 1, input: 1, output: 0 },
    })}\n`,
  );
  const discoveryTimers = [];
  const server = createUsageServer({
    homeDir,
    databaseFile: path.join(homeDir, ".codex-usage", "usage-index.sqlite"),
    importDirs: [projectRoot],
    pricingRefreshSchedulerEnabled: false,
    schedulePricingDiscovery(callback, delay) {
      const timer = { callback, delay };
      discoveryTimers.push(timer);
      return timer;
    },
    cancelPricingDiscovery(timer) {
      timer.cancelled = true;
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${baseUrl}/api/usage?preset=all`)).status, 200);
    const pricing = await fetch(`${baseUrl}/api/pricing`).then((response) => response.json());
    assert.deepEqual(
      discoveryTimers,
      [],
      JSON.stringify({
        results: pricing.automatic.discoveryResults,
        missing: pricing.usageCoverage.missingUsedModels,
      }),
    );
  } finally {
    await server.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test.after(() => {
  resetPricingCatalog();
});
