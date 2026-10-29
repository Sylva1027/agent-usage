import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";

import { createUsageServer as createUsageServerBase, isFullDetailHeapAvailable, readJsonBody } from "../src/server.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";
import {
  getDefaultPricingCatalog,
  getPricingCatalog,
  MAX_PRICING_MODELS,
  runWithPricingCatalog,
  setPricingCatalog,
} from "../src/pricing.js";
import {
  GLM_PRICES_URL,
  KIMI_PRICES_URL,
  LITELLM_PRICES_URL,
  MIMO_PRICES_URL,
  MODEL_PRICES_URL,
  STEPFUN_PRICES_URL,
  USD_CNY_RATE_URL,
} from "../src/pricing-auto.js";

function createUsageServer(options = {}) {
  return createUsageServerBase({ pricingRefreshSchedulerEnabled: false, ...options });
}

function mimoPricingPage() {
  return `<!doctype html><html><body><h2>模型国内定价</h2><p>单位：元 / 百万 tokens；缓存写入限时免费</p><table>
    <tr><td>实时推理</td><td>模型</td><td>缓存输入</td><td>输入</td><td>输出</td></tr>
    <tr><td></td><td>mimo-v2.6-pro、mimo-v2.5-pro</td><td>¥0.025</td><td>¥3</td><td>¥6</td></tr>
    <tr><td></td><td>mimo-v2.6-flash、mimo-v2.5</td><td>¥0.02</td><td>¥1</td><td>¥2</td></tr>
    <tr><td></td><td>mimo-v2.6-pro-ultraspeed</td><td>¥0.25</td><td>¥30</td><td>¥60</td></tr>
    <tr><td>批量推理</td><td>mimo-v2.6-pro</td><td>¥0.01</td><td>¥1</td><td>¥2</td></tr>
  </table></body></html>`;
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

function r07ModelsDevCatalog(models) {
  return {
    openai: {
      models: Object.fromEntries(
        models.map((model, index) => [
          model,
          {
            modalities: { input: ["text"], output: ["text"] },
            cost: {
              input: index + 2,
              cache_read: 0.2,
              cache_write: 2.5,
              output: 10,
              tiers: [
                {
                  tier: { type: "context", size: 272_000 },
                  input: index + 4,
                  cache_read: 0.4,
                  cache_write: 5,
                  output: 15,
                },
              ],
            },
          },
        ]),
      ),
    },
  };
}

function r07PricingFetcher({ calls, models = [], rate = 6.8 }) {
  return async (url) => {
    calls.push(url);
    if (url === MODEL_PRICES_URL) {
      return new Response(JSON.stringify(r07ModelsDevCatalog(models)), { status: 200 });
    }
    if (url === LITELLM_PRICES_URL) return new Response(JSON.stringify({}), { status: 200 });
    if (url === USD_CNY_RATE_URL) {
      return new Response(
        JSON.stringify({
          base: "USD",
          quote: "CNY",
          date: "2026-10-26",
          rate: typeof rate === "function" ? rate() : rate,
        }),
        { status: 200 },
      );
    }
    return new Response("", { status: 200, headers: { "content-type": "text/html" } });
  };
}

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function localHourKey(value) {
  // API tests derive the expected bucket with the same local-time semantics as the dashboard.
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:00`;
}

function quotaTokenRow(timestamp, { resetsAtMs, windowMinutes = 300, limitId = "codex", usedPercent = 42 } = {}) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: 0,
          input_tokens: 0,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
        },
      },
      rate_limits: {
        limit_id: limitId,
        primary: {
          window_minutes: windowMinutes,
          resets_at: resetsAtMs / 1000,
          used_percent: usedPercent,
        },
      },
    },
  };
}

async function makeFixtureHome() {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "codex-server-"));
  const sessionDir = path.join(fakeHome, ".codex", "sessions", "2026", "05", "01");
  const sessionFile = path.join(sessionDir, "rollout.jsonl");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    sessionFile,
    jsonl([
      {
        timestamp: "2026-05-01T02:00:00.000Z",
        type: "session_meta",
        payload: { id: "server-1", source: "cli", originator: "codex-tui", cwd: "/work/cli" },
      },
      {
        timestamp: "2026-05-01T02:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              total_tokens: 123,
              input_tokens: 100,
              cached_input_tokens: 20,
              output_tokens: 23,
              reasoning_output_tokens: 5,
            },
          },
        },
      },
    ]),
  );
  return {
    homeDir: fakeHome,
    // Keep server tests independent from the developer's real ~/.codex-usage/imports.json.
    importStoreFile: path.join(fakeHome, ".codex-usage", "imports.json"),
    databaseFile: path.join(fakeHome, ".codex-usage", "usage-index.sqlite"),
    sessionFile,
  };
}

test("server serves the dashboard and usage API", async () => {
  const { homeDir, importStoreFile, databaseFile } = await makeFixtureHome();
  const server = createUsageServer({ homeDir, importStoreFile, databaseFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const page = await fetch(`${baseUrl}/`);
    const api = await fetch(`${baseUrl}/api/usage`);
    const recent = await fetch(`${baseUrl}/api/usage?preset=recent&recentValue=${encodeURIComponent("14天")}`);
    const hourly = await fetch(`${baseUrl}/api/usage?bucket=hour`);
    const json = await api.json();
    const recentJson = await recent.json();
    const hourlyJson = await hourly.json();

    assert.equal(page.status, 200);
    assert.match(await page.text(), /Agent Usage/);
    assert.equal(api.status, 200);
    assert.equal(json.summary.totals.total, 123);
    assert.equal(json.quota.asOf, json.summary.quota.asOf);
    assert.equal(json.quota.windows.quota_5h.state, "missing");
    assert.equal(recent.status, 200);
    assert.equal(recentJson.summary.range.preset, "recent");
    assert.equal(recentJson.summary.totals.total, 0);
    assert.equal(hourly.status, 200);
    assert.equal(hourlyJson.summary.range.bucket, "hour");
    assert.equal(hourlyJson.summary.timeline.length, 24);
    const activeTimelineRows = hourlyJson.summary.timeline.filter((row) => row.total.total > 0);
    assert.deepEqual(
      activeTimelineRows.map((row) => [row.key, row.total.total]),
      [[localHourKey("2026-05-01T02:01:00.000Z"), 123]],
    );
    const activeTimelineRow = activeTimelineRows[0];
    assert.equal(
      activeTimelineRow.models.reduce((sum, model) => sum + model.total.total, 0),
      activeTimelineRow.total.total,
    );
    assert.equal(typeof activeTimelineRow.costByModel, "object");
    assert.equal(typeof activeTimelineRow.pricedTokens, "number");
    assert.equal(typeof activeTimelineRow.unpricedTokens, "number");
    const timelineCost = hourlyJson.summary.timeline.reduce(
      (sum, row) => sum + Object.values(row.costByModel).reduce((slot, cost) => slot + cost.totalUsd, 0),
      0,
    );
    assert.ok(Math.abs(timelineCost - hourlyJson.summary.costEstimate.totalUsd) < 1e-12);
    assert.equal(json.metadata.eventCount, 1);
    assert.equal(json.metadata.sessionCount, 1);
    assert.equal(json.metadata.homes[0].status, "active");
    assert.equal(json.metadata.homes[0].eventCount, 1);
    assert.equal(json.report, undefined);
    assert.ok((await stat(databaseFile)).size > 0);

    const invalidDate = await fetch(`${baseUrl}/api/summary?preset=custom&startDate=2026-02-30`);
    const invalidBucket = await fetch(`${baseUrl}/api/summary?bucket=fortnight`);
    const invalidPreset = await fetch(`${baseUrl}/api/summary?preset=quarter`);
    const unavailableQuota = await fetch(`${baseUrl}/api/usage?preset=quota_5h`);
    const malformedPath = await fetch(`${baseUrl}/%E0%A4%A`);
    assert.equal(invalidDate.status, 400);
    assert.equal(invalidBucket.status, 400);
    assert.equal(invalidPreset.status, 400);
    assert.equal((await invalidPreset.json()).code, "INVALID_PRESET");
    assert.equal(unavailableQuota.status, 409);
    const unavailableQuotaBody = await unavailableQuota.json();
    assert.equal(unavailableQuotaBody.code, "QUOTA_WINDOW_UNAVAILABLE");
    assert.equal(unavailableQuotaBody.quota.windows.quota_5h.state, "missing");
    assert.equal(unavailableQuotaBody.summary, undefined);
    assert.equal(malformedPath.status, 400);

    const detailed = await fetch(`${baseUrl}/api/usage?detail=full`).then((response) => response.json());
    assert.equal(detailed.report.events[0].channel, "CLI");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("usage responses carry one exact pricing catalog and frozen snapshots stay pinned", async () => {
  const fixture = await makeFixtureHome();
  const originalPricing = getPricingCatalog();
  const server = createUsageServer(fixture);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const catalogWithStatus = await fetch(`${baseUrl}/api/pricing`).then((response) => response.json());
    const expected = {
      checkedAt: catalogWithStatus.checkedAt,
      version: catalogWithStatus.version,
      usdToCnyRate: catalogWithStatus.usdToCnyRate,
      source: catalogWithStatus.source,
      models: catalogWithStatus.models,
    };
    const full = await fetch(`${baseUrl}/api/usage?detail=full`).then((response) => response.json());
    const dashboard = await fetch(`${baseUrl}/api/usage?preset=all&view=dashboard`).then((response) => response.json());
    const summary = await fetch(`${baseUrl}/api/summary?preset=all`).then((response) => response.json());
    const paused = await fetch(`${baseUrl}/api/usage?preset=all&freeze=1`).then((response) => response.json());

    for (const body of [full, dashboard, summary, paused]) {
      assert.deepEqual(body.pricingCatalog, expected);
    }
    assert.deepEqual(full.report.pricingCatalog, expected);

    const changed = structuredClone(expected);
    changed.checkedAt = "2026-10-26";
    changed.usdToCnyRate += 0.1;
    changed.models["gpt-6-sol"].short.input += 7;
    setPricingCatalog(changed);

    const live = await fetch(`${baseUrl}/api/usage?preset=all&view=dashboard`).then((response) => response.json());
    const frozen = await fetch(`${baseUrl}/api/usage?preset=all&snapshot=${paused.snapshotId}`).then((response) =>
      response.json(),
    );
    assert.notEqual(live.pricingCatalog.version, expected.version);
    assert.deepEqual(frozen.pricingCatalog, expected);
    assert.deepEqual(frozen.periodComparison, paused.periodComparison);
    const frozenPricing = await fetch(`${baseUrl}/api/pricing?snapshot=${paused.snapshotId}`).then((response) =>
      response.json(),
    );
    assert.equal(frozenPricing.automatic.effectiveUsdToCnyRate, expected.usdToCnyRate);
  } finally {
    setPricingCatalog(originalPricing);
    await new Promise((resolve) => server.close(resolve));
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("snapshot captures pricing before backup and discovery leaves the request scope", async () => {
  const fixture = await makeFixtureHome();
  const originalPricing = getPricingCatalog();
  const projectRoot = path.join(fixture.homeDir, "snapshot-pricing-boundary");
  await mkdir(path.join(projectRoot, ".codex-usage"), { recursive: true });
  await writeFile(
    path.join(projectRoot, ".codex-usage", "usage.jsonl"),
    jsonl([
      {
        schema_version: "codex-usage.project-log.v1",
        timestamp: new Date().toISOString(),
        session_id: "snapshot-pricing-boundary",
        request_id: "snapshot-pricing-boundary",
        model: "gpt-snapshot-pricing-boundary",
        cwd: projectRoot,
        usage: { total: 1, input: 1, output: 0 },
      },
    ]),
  );
  const timers = [];
  const calls = [];
  const observedPricingVersions = [];
  const fetchPricing = r07PricingFetcher({ calls, models: ["gpt-snapshot-pricing-boundary"] });
  let pendingLiveCatalog = null;
  let liveCatalog = null;
  const server = createUsageServer({
    ...fixture,
    importDirs: [projectRoot],
    pricingDiscoveryDelayMs: 5_000,
    schedulePricingDiscovery(callback, delay) {
      const timer = { callback, delay };
      timers.push(timer);
      if (pendingLiveCatalog) liveCatalog = setPricingCatalog(pendingLiveCatalog);
      return timer;
    },
    cancelPricingDiscovery(timer) {
      timer.cancelled = true;
    },
    pricingFetcher: async (url) => {
      observedPricingVersions.push({ url, version: getPricingCatalog().version });
      return fetchPricing(url);
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const catalogA = await fetch(`${baseUrl}/api/pricing`).then((response) => response.json());
    pendingLiveCatalog = {
      checkedAt: "2026-10-27",
      version: catalogA.version,
      usdToCnyRate: catalogA.usdToCnyRate + 0.2,
      source: catalogA.source,
      models: structuredClone(catalogA.models),
    };
    pendingLiveCatalog.models["gpt-6-sol"].short.input += 1;

    const frozen = await fetch(`${baseUrl}/api/usage?preset=all&freeze=1`).then((response) => response.json());
    assert.ok(timers.length > 0);
    assert.ok(liveCatalog);
    assert.equal(frozen.pricingCatalog.version, catalogA.version);

    const snapshotPricing = await fetch(`${baseUrl}/api/pricing?snapshot=${frozen.snapshotId}`).then((response) =>
      response.json(),
    );
    assert.equal(snapshotPricing.version, catalogA.version);
    assert.equal(snapshotPricing.automatic.effectiveUsdToCnyRate, catalogA.usdToCnyRate);

    const inheritedTimer = timers.at(-1);
    observedPricingVersions.length = 0;
    await runWithPricingCatalog(catalogA, () => inheritedTimer.callback());
    assert.ok(observedPricingVersions.length > 0);
    assert.ok(
      observedPricingVersions.every((item) => item.version === liveCatalog.version),
      JSON.stringify(observedPricingVersions),
    );
  } finally {
    setPricingCatalog(originalPricing);
    await new Promise((resolve) => server.close(resolve));
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("server accepts named recent reset windows and calendar ranges", async () => {
  const fixture = await makeFixtureHome();
  const end = Date.now() - 60_000;
  const observed = new Date(end - 60_000).toISOString();
  await appendFile(
    fixture.sessionFile,
    jsonl([
      quotaTokenRow(observed, { resetsAtMs: end }),
      quotaTokenRow(new Date(end + 30_000).toISOString(), { resetsAtMs: end + 30_000 + 300 * 60_000 }),
      quotaTokenRow(observed, { resetsAtMs: end, windowMinutes: 10080 }),
      quotaTokenRow(new Date(end + 30_000).toISOString(), {
        resetsAtMs: end + 30_000 + 10080 * 60_000,
        windowMinutes: 10080,
      }),
    ]),
  );
  const server = createUsageServer(fixture);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const [value, bucket, slots] of [
      ["上一个5h", "quota_30m", null],
      ["上周", "day", null],
      ["上个月", "day", null],
      ["今年", "month", null],
    ]) {
      const query = new URLSearchParams({ preset: "recent", recentValue: value, bucket });
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/usage?${query}`);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.summary.range.bucket, bucket);
      if (["上周", "上一个5h"].includes(value)) {
        assert.equal(body.summary.range.windowEndExclusive, new Date(end).toISOString());
        assert.ok(body.summary.timeline.every((row) => row.total.total > 0));
      }
      if (slots) {
        assert.equal(body.summary.timeline.length, slots);
        assert.deepEqual(body.summary.records, {});
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("server reports unsupported stored imports instead of hiding them", async () => {
  const { homeDir, importStoreFile } = await makeFixtureHome();
  const unsupportedPath = path.join(homeDir, "plain-project");
  await mkdir(unsupportedPath, { recursive: true });
  await mkdir(path.dirname(importStoreFile), { recursive: true });
  await writeFile(importStoreFile, JSON.stringify({ imports: [{ path: unsupportedPath }] }));

  const server = createUsageServer({ homeDir, importStoreFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const imports = await fetch(`http://127.0.0.1:${port}/api/imports`).then((response) => response.json());

    assert.equal(imports.imports[0].type, "unsupported");
    assert.equal(imports.imports[0].path, unsupportedPath);
    assert.match(imports.imports[0].reason, /目录需要是 Codex home/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("server keeps full detail reports behind the documented 512MB heap budget", () => {
  assert.equal(isFullDetailHeapAvailable(511 * 1024 * 1024), false);
  assert.equal(isFullDetailHeapAvailable(512 * 1024 * 1024), true);
});

test("server reports status changes and refreshes cached usage reports", async () => {
  const { homeDir, importStoreFile, sessionFile } = await makeFixtureHome();
  const server = createUsageServer({ homeDir, importStoreFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const firstUsage = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());
    const unchanged = await fetch(`${baseUrl}/api/status?since=${firstUsage.fingerprint}`).then((response) =>
      response.json(),
    );

    assert.equal(firstUsage.summary.totals.total, 123);
    assert.match(firstUsage.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(unchanged.changed, false);

    await appendFile(
      sessionFile,
      `${JSON.stringify({
        timestamp: "2026-05-01T02:02:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              total_tokens: 200,
              input_tokens: 160,
              cached_input_tokens: 30,
              output_tokens: 40,
              reasoning_output_tokens: 7,
            },
          },
        },
      })}\n`,
    );

    const changed = await fetch(`${baseUrl}/api/status?since=${firstUsage.fingerprint}`).then((response) =>
      response.json(),
    );
    const refreshed = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());

    assert.equal(changed.changed, true);
    assert.notEqual(changed.fingerprint, firstUsage.fingerprint);
    assert.equal(refreshed.summary.totals.total, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("local Magpie ledgers never affect native HTTP publication or frozen snapshots", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const options = {
    ...fixture.serverOptions,
    lookupRequestTiming: () => ({
      state: "missing",
      durationMs: null,
      reportedOutputTokens: null,
      requestedModel: "",
      generation: null,
    }),
  };
  const ledgerFile = path.join(options.homeDir, ".config", "magpie", "usage.jsonl");
  const server = createUsageServer(options);
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const get = async (query) => {
      const response = await fetch(`${baseUrl}/api/${query}`);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    };
    const dashboard = await get("usage?preset=all&view=dashboard");
    const full = await get("usage?preset=all&detail=full&skipCheck=1");
    const frozen = await get("usage?preset=all&freeze=1&skipCheck=1");
    assert.equal(dashboard.summary.perf.models[0].n, 0);
    assert.equal(full.summary.perf.models[0].n, 0);
    assert.equal(frozen.fingerprint, dashboard.fingerprint);
    assert.equal((await get(`status?since=${dashboard.fingerprint}`)).changed, false);

    const timing = fixture.timingRecords[0];
    const ledgerRecord = {
      agent: "codex",
      provider: "codex",
      req: `codex/${timing.requestedModel}`,
      model: timing.requestedModel,
      response_id: timing.responseId,
      status: 200,
      ms: timing.durationMs,
      out: timing.reportedOutputTokens,
      generation: timing.generation,
      ep: "/backend-api/codex/responses",
    };
    const ledgerStates = [
      async () => {
        await mkdir(path.dirname(ledgerFile), { recursive: true });
        await writeFile(ledgerFile, jsonl([ledgerRecord]));
      },
      async () => {
        await appendFile(ledgerFile, jsonl([{ ...ledgerRecord, response_id: "appended-ledger-only-response" }]));
      },
      async () => {
        await writeFile(ledgerFile, "invalid\n");
      },
    ];
    for (const changeLedger of ledgerStates) {
      await changeLedger();
      const status = await get(`status?since=${dashboard.fingerprint}`);
      assert.equal(status.changed, false);
      assert.equal(status.fingerprint, dashboard.fingerprint);

      const dashboardAfter = await get("usage?preset=all&view=dashboard");
      assert.equal(dashboardAfter.fingerprint, dashboard.fingerprint);
      assert.deepEqual(dashboardAfter.summary.totals, dashboard.summary.totals);
      assert.deepEqual(dashboardAfter.summary.perf.models, dashboard.summary.perf.models);

      const fullAfter = await get("usage?preset=all&detail=full&skipCheck=1");
      assert.equal(fullAfter.fingerprint, full.fingerprint);
      assert.deepEqual(fullAfter.summary.totals, full.summary.totals);
      assert.deepEqual(fullAfter.summary.perf.models, full.summary.perf.models);

      const frozenAfter = await get(`usage?preset=all&snapshot=${frozen.snapshotId}`);
      assert.equal(frozenAfter.fingerprint, frozen.fingerprint);
      assert.deepEqual(frozenAfter.summary.perf.models, frozen.summary.perf.models);

      const evidenceDatabase = new DatabaseSync(options.databaseFile, { readOnly: true });
      try {
        assert.equal(
          Number(evidenceDatabase.prepare("SELECT COUNT(*) AS n FROM perf_request_timing_evidence").get().n),
          0,
        );
      } finally {
        evidenceDatabase.close();
      }
    }
  } finally {
    await server.close();
    fixture.close();
  }
});

test("explicit fixture timing evidence stays pending until another worker publishes it", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const store = new UsageStore(fixture.serverOptions);
  const first = createUsageServer(fixture.serverOptions);
  const second = createUsageServer(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    // This fixture models an explicit upstream timing import; it does not assert that native stream capture exists.
    await fixture.seedRequestTiming(store, fixture.timingRecords.slice(0, 1));
    await new Promise((resolve) => first.listen(0, "127.0.0.1", resolve));
    const firstBase = `http://127.0.0.1:${first.address().port}`;
    await new Promise((resolve) => second.listen(0, "127.0.0.1", resolve));
    const secondBase = `http://127.0.0.1:${second.address().port}`;
    const get = async (baseUrl, query) => {
      const response = await fetch(`${baseUrl}/api/${query}`);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    };

    const initial = await get(firstBase, "usage?preset=all&view=dashboard");
    assert.equal(initial.summary.perf.models[0].n, 1);
    const frozen = await get(firstBase, "usage?preset=all&freeze=1&skipCheck=1");
    assert.equal(frozen.fingerprint, initial.fingerprint);

    const home = store.homes.find((candidate) => path.resolve(candidate.path) === path.resolve(fixture.codexHome));
    assert.ok(home, "fixture must discover the Codex home before importing the remaining timing evidence");
    const imported = store.importRequestTimingEvidence({
      homeId: String(home.id),
      records: fixture.timingRecords.slice(1),
      reviewedOrigins: ["fixture@1"],
    });
    assert.equal(imported.changed, true);

    const pendingStatus = await get(firstBase, `status?since=${initial.fingerprint}`);
    assert.equal(pendingStatus.changed, true);
    assert.notEqual(pendingStatus.fingerprint, initial.fingerprint);
    const stillPublished = await get(firstBase, "usage?preset=all&view=dashboard&skipCheck=1");
    assert.equal(stillPublished.fingerprint, initial.fingerprint);
    assert.equal(stillPublished.summary.perf.models[0].n, 1);

    const publishedBySecond = await get(secondBase, "usage?preset=all&view=dashboard");
    assert.equal(publishedBySecond.summary.perf.models[0].n, fixture.expected.n);
    assert.equal(publishedBySecond.summary.perf.models[0].averageTps, fixture.expected.tps.pooled);

    const publishedStatus = await get(firstBase, `status?since=${pendingStatus.fingerprint}`);
    assert.equal(publishedStatus.changed, true);
    assert.equal(publishedStatus.fingerprint, publishedBySecond.fingerprint);
    const publishedByFirst = await get(firstBase, "usage?preset=all&view=dashboard");
    assert.equal(publishedByFirst.fingerprint, publishedBySecond.fingerprint);
    assert.deepEqual(publishedByFirst.summary.perf.models, publishedBySecond.summary.perf.models);

    const frozenAfter = await get(firstBase, `usage?preset=all&snapshot=${frozen.snapshotId}`);
    assert.equal(frozenAfter.fingerprint, frozen.fingerprint);
    assert.equal(frozenAfter.summary.perf.models[0].n, 1);
    assert.deepEqual(frozenAfter.summary.perf.models, frozen.summary.perf.models);

    const publishedFreeze = await get(firstBase, "usage?preset=all&freeze=1&skipCheck=1");
    assert.equal(publishedFreeze.fingerprint, publishedBySecond.fingerprint);
    assert.equal(publishedFreeze.summary.perf.models[0].n, fixture.expected.n);
  } finally {
    await first.close();
    await second.close();
    store.close();
    fixture.close();
  }
});

test("imported runtime stays bound to its database and ignores local Magpie ledgers", async () => {
  const fixture = await makeFixtureHome();
  const options = { ...fixture, env: {}, automaticDiscoveryEnabled: false };
  const ledgerFile = path.join(fixture.homeDir, ".config", "magpie", "usage.jsonl");
  let store = new UsageStore(options);
  let server;
  try {
    await mkdir(path.dirname(ledgerFile), { recursive: true });
    await writeFile(ledgerFile, "invalid\n");
    await store.sync({ options });
    store.close();
    store = null;
    server = createUsageServer({
      ...options,
      importContext: { pricingCatalog: structuredClone(getPricingCatalog()), serviceTierEvidenceSnapshot: null },
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const before = await fetch(`${baseUrl}/api/usage?preset=all`).then((response) => response.json());
    assert.equal(before.summary.totals.total, 123);
    const unchanged = await fetch(`${baseUrl}/api/status?since=${before.fingerprint}`).then((response) =>
      response.json(),
    );
    assert.equal(unchanged.changed, false);
    await appendFile(ledgerFile, "changed local ledger\n");
    const status = await fetch(`${baseUrl}/api/status?since=${before.fingerprint}`).then((response) => response.json());
    assert.equal(status.changed, false);
    assert.equal(status.fingerprint, before.fingerprint);
    const dashboard = await fetch(`${baseUrl}/api/usage?preset=all`).then((response) => response.json());
    assert.equal(dashboard.fingerprint, before.fingerprint);
    assert.equal(dashboard.summary.totals.total, 123);
    const frozen = await fetch(`${baseUrl}/api/usage?preset=all&freeze=1`).then((response) => response.json());
    assert.equal(frozen.fingerprint, before.fingerprint);
  } finally {
    store?.close();
    await server?.close();
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("paused usage keeps the same indexed data across range changes", async () => {
  const { homeDir, importStoreFile, databaseFile, sessionFile } = await makeFixtureHome();
  const server = createUsageServer({ homeDir, importStoreFile, databaseFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const paused = await fetch(`${baseUrl}/api/usage?preset=all&freeze=1`).then((response) => response.json());
    assert.equal(paused.summary.totals.total, 123);
    assert.ok(paused.snapshotId);

    await appendFile(
      sessionFile,
      `${JSON.stringify({
        timestamp: "2026-05-01T02:02:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              total_tokens: 200,
              input_tokens: 160,
              cached_input_tokens: 30,
              output_tokens: 40,
              reasoning_output_tokens: 7,
            },
          },
        },
      })}\n`,
    );

    const live = await fetch(`${baseUrl}/api/usage?preset=all`).then((response) => response.json());
    assert.equal(live.summary.totals.total, 200);

    for (const preset of ["all", "week", "month", "custom"]) {
      const range = preset === "custom" ? "&startDate=2026-05-01&endDate=2026-05-01" : "";
      const frozen = await fetch(`${baseUrl}/api/usage?preset=${preset}&snapshot=${paused.snapshotId}${range}`).then(
        (response) => response.json(),
      );
      assert.equal(frozen.summary.totals.total, preset === "all" || preset === "custom" ? 123 : 0);
      assert.equal(frozen.checkedAt, paused.checkedAt);
      assert.equal(frozen.snapshotId, paused.snapshotId);
      assert.equal(frozen.periodComparison.asOf, paused.periodComparison.asOf);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("quota API forces its server bucket, returns capability state, and keeps snapshots frozen", async () => {
  const { homeDir, importStoreFile, databaseFile, sessionFile } = await makeFixtureHome();
  const quotaFile = path.join(path.dirname(sessionFile), "quota.jsonl");
  const liveUsageFile = path.join(path.dirname(sessionFile), "live-usage.jsonl");
  const estimateNow = Date.now();
  const observedAtMs = estimateNow - 30_000;
  const resetsAtMs = estimateNow + 300 * 60_000 - 60_000;
  const quotaRow = quotaTokenRow(new Date(observedAtMs).toISOString(), { resetsAtMs });
  quotaRow.payload.rate_limits.secondary = {
    window_minutes: 10080,
    resets_at: (estimateNow + (10080 - 60) * 60_000) / 1000,
    used_percent: 5,
  };
  await writeFile(
    quotaFile,
    jsonl([
      {
        type: "session_meta",
        timestamp: new Date(observedAtMs - 1_000).toISOString(),
        payload: { id: "quota-window" },
      },
      quotaRow,
    ]),
  );
  const liveUsageAt = new Date(estimateNow - 10_000).toISOString();
  await writeFile(
    liveUsageFile,
    jsonl([
      {
        type: "session_meta",
        timestamp: liveUsageAt,
        payload: { id: "quota-usage", source: "cli", originator: "codex-tui", cwd: "/work/quota" },
      },
      { type: "turn_context", timestamp: liveUsageAt, payload: { model: "gpt-6-sol" } },
      {
        timestamp: liveUsageAt,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              total_tokens: 50,
              input_tokens: 40,
              cached_input_tokens: 5,
              output_tokens: 10,
              reasoning_output_tokens: 0,
            },
          },
        },
      },
    ]),
  );
  const server = createUsageServer({ homeDir, importStoreFile, databaseFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const liveResponse = await fetch(`${baseUrl}/api/usage?preset=quota_5h&bucket=month&detail=full`);
    const live = await liveResponse.json();
    assert.equal(liveResponse.status, 200);
    assert.equal(live.summary.range.bucket, "quota_30m");
    assert.equal(live.summary.range.quotaState, "available");
    assert.equal(live.summary.range.quotaReason, null);
    assert.equal(live.summary.range.asOf, live.quota.asOf);
    assert.equal(live.quota.windows.quota_5h.state, "available");
    assert.equal(live.summary.timeline.length, 10);
    assert.equal(live.summary.totals.total, 50);
    assert.equal(live.summary.comparison.previousRange, null);
    assert.equal(live.summary.comparison.label, "较上一5h");
    assert.deepEqual(live.summary.records, {});
    assert.equal(live.report, undefined);

    const liveWeekResponse = await fetch(`${baseUrl}/api/usage?preset=quota_week&bucket=month&view=dashboard`);
    const liveWeek = await liveWeekResponse.json();
    assert.equal(liveWeekResponse.status, 200);
    assert.equal(liveWeek.summary.range.bucket, "quota_24h");
    assert.equal(liveWeek.summary.range.quotaState, "available");
    assert.equal(liveWeek.summary.range.quotaReason, null);
    assert.equal(liveWeek.summary.timeline.length, 7);
    assert.equal(liveWeek.summary.totals.total, 50);

    const paused = await fetch(`${baseUrl}/api/usage?preset=quota_5h&freeze=1`).then((response) => response.json());
    assert.ok(paused.snapshotId);
    const frozen = await fetch(`${baseUrl}/api/usage?preset=quota_5h&snapshot=${paused.snapshotId}&bucket=month`).then(
      (response) => response.json(),
    );
    assert.equal(frozen.quota.asOf, paused.quota.asOf);
    assert.deepEqual(frozen.quota, paused.quota);
    assert.equal(frozen.summary.range.bucket, "quota_30m");
    assert.equal(frozen.summary.range.quotaState, "available");

    const excluded = await fetch(
      `${baseUrl}/api/summary?preset=quota_5h&exclude=${encodeURIComponent(live.metadata.homes[0].id)}`,
    ).then((response) => response.json());
    assert.equal(excluded.quota.windows.quota_5h.state, "available");
    assert.equal(excluded.summary.totals.total, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("server imports project usage log directories and refreshes usage data", async () => {
  const { homeDir, importStoreFile } = await makeFixtureHome();
  const projectRoot = path.join(homeDir, "openai_codex");
  await mkdir(path.join(projectRoot, ".codex-usage"), { recursive: true });
  await writeFile(
    path.join(projectRoot, ".codex-usage", "usage.jsonl"),
    jsonl([
      {
        schema_version: "codex-usage.project-log.v1",
        timestamp: "2026-05-31T12:00:00.000Z",
        source: "codex-oauth",
        channel: "Codex OAuth",
        project_root: projectRoot,
        cwd: projectRoot,
        session_id: "oauth-session",
        model: "gpt-5.5",
        usage: { total: 77, input: 50, cached: 10, output: 27, reasoning: 6 },
      },
    ]),
  );

  const server = createUsageServer({ homeDir, importStoreFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const before = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());
    const imported = await fetch(`${baseUrl}/api/imports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: projectRoot }),
    }).then((response) => response.json());
    const imports = await fetch(`${baseUrl}/api/imports`).then((response) => response.json());
    const after = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());

    assert.equal(before.summary.totals.total, 123);
    assert.equal(imported.import.type, "project-log");
    assert.equal(imported.import.path, projectRoot);
    assert.deepEqual(
      imports.imports.map((entry) => entry.path),
      [projectRoot],
    );
    assert.equal(after.summary.totals.total, 200);
    assert.deepEqual(
      after.summary.channels.map((channel) => [channel.name, channel.total.total]),
      [
        ["Codex", 123],
        ["Codex OAuth", 77],
      ],
    );
    assert.equal(
      after.metadata.homes.some((home) => home.kind === "project-log" && home.path === projectRoot),
      true,
    );

    const deleteResponse = await fetch(`${baseUrl}/api/imports?path=${encodeURIComponent(projectRoot)}`, {
      method: "DELETE",
    });
    const removed = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());

    assert.equal(deleteResponse.status, 200);
    assert.equal(removed.summary.totals.total, after.summary.totals.total);
    assert.ok(
      removed.summary.perf.missingSources.some(
        (source) =>
          source.path === path.join(projectRoot, ".codex-usage", "usage.jsonl") && source.kind === "project-log",
      ),
      "removed project-log source must remain diagnosed as missing",
    );
    assert.equal(
      removed.metadata.homes.some((home) => home.kind === "project-log" && home.path === projectRoot),
      false,
    );

    const restoredImport = await fetch(`${baseUrl}/api/imports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: projectRoot }),
    });
    const restored = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());
    assert.equal(restoredImport.status, 200);
    assert.equal(restored.summary.totals.total, after.summary.totals.total);
    assert.equal(restored.summary.perf.missingSources.length, 0);
    assert.equal(
      restored.metadata.homes.some((home) => home.kind === "project-log" && home.path === projectRoot),
      true,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("server imports a DSH home and labels it as DSH", async () => {
  const { homeDir, importStoreFile } = await makeFixtureHome();
  // 造一个独立的 DSH home（不放在 fakeHome/.dsh 下，避免被自动发现路径撞上）。
  const dshRoot = path.join(homeDir, "external-dsh");
  const dshSessionDir = path.join(dshRoot, "sessions", "--work-dsh--", "session-srv-1");
  await mkdir(dshSessionDir, { recursive: true });
  await writeFile(
    path.join(dshSessionDir, "session.v4.jsonl.zstd"),
    Buffer.concat([
      zstdCompressSync(
        Buffer.from(
          `${JSON.stringify({
            type: "session",
            version: 4,
            id: "session-srv-1",
            createdAt: Date.parse("2026-05-31T12:00:00.000Z"),
            cwd: "/work/dsh",
            isSeeded: false,
            delegationDepth: 0,
            agentPreset: "standard",
          })}\n`,
          "utf8",
        ),
      ),
      zstdCompressSync(
        Buffer.from(
          `${JSON.stringify({
            type: "request/header",
            seq: 2,
            time: Date.parse("2026-05-31T12:00:01.000Z"),
            data: { header: { config: { provider: "deepseek-account", model: "deepseek-flash" } } },
          })}\n${JSON.stringify({
            type: "assistant/message",
            seq: 3,
            time: Date.parse("2026-05-31T12:00:02.000Z"),
            data: {
              turn: 1,
              step: 1,
              usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 0, totalTokens: 160 },
            },
          })}\n`,
          "utf8",
        ),
      ),
    ]),
  );

  const server = createUsageServer({ homeDir, importStoreFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const before = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());
    const imported = await fetch(`${baseUrl}/api/imports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dshRoot }),
    }).then((response) => response.json());

    assert.equal(imported.import.type, "dsh-home");
    assert.equal(imported.import.path, dshRoot);
    assert.equal(imported.import.label, "DSH external-dsh");
    // DSH 没有单一数据库文件，不应带 dbFile / usageLogPath。
    assert.equal(imported.import.dbFile, undefined);
    assert.equal(imported.import.usageLogPath, undefined);

    const after = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());
    assert.equal(after.summary.totals.total, before.summary.totals.total + 160);
    assert.ok(after.summary.channels.some((channel) => channel.name === "DSH"));
    assert.equal(
      after.metadata.homes.some((home) => home.kind === "dsh" && home.path === dshRoot),
      true,
    );
    assert.deepEqual(after.metadata.harnessModels.DSH, ["deepseek-flash"]);

    const deleteResponse = await fetch(`${baseUrl}/api/imports?path=${encodeURIComponent(dshRoot)}`, {
      method: "DELETE",
    });
    const removed = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());
    assert.equal(deleteResponse.status, 200);
    assert.equal(removed.summary.totals.total, after.summary.totals.total);
    assert.ok(removed.summary.perf.missingSources.length > 0);
    assert.equal(
      removed.metadata.homes.some((home) => home.kind === "dsh" && home.path === dshRoot),
      false,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("server imports an OpenCode data dir and labels it as OpenCode", async () => {
  const { homeDir, importStoreFile } = await makeFixtureHome();
  // 造一个独立的 OpenCode 数据目录（不放在 fakeHome 下，避免被自动发现路径撞上）。
  const ocRoot = path.join(homeDir, "external-opencode");
  await mkdir(ocRoot, { recursive: true });
  const db = new DatabaseSync(path.join(ocRoot, "opencode.db"));
  try {
    db.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT, title TEXT, version TEXT, agent TEXT, model TEXT);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    db.prepare("INSERT INTO session_v2 (id, directory, title, version, agent, model) VALUES (?, ?, ?, ?, ?, ?)").run(
      "session-srv-1",
      "/work/oc",
      "oc title",
      "2.0.19",
      "build",
      null,
    );
    db.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "msg-srv-1",
      "session-srv-1",
      "assistant",
      0,
      Date.parse("2026-05-31T12:00:02.000Z"),
      Date.parse("2026-05-31T12:00:02.000Z"),
      JSON.stringify({
        time: { created: Date.parse("2026-05-31T12:00:02.000Z"), completed: Date.parse("2026-05-31T12:00:03.000Z") },
        model: { id: "test-model", providerID: "opencode" },
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 0 } },
      }),
    );
  } finally {
    db.close();
  }

  const server = createUsageServer({ homeDir, importStoreFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const before = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());
    const imported = await fetch(`${baseUrl}/api/imports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: ocRoot }),
    }).then((response) => response.json());

    assert.equal(imported.import.type, "opencode-home");
    assert.equal(imported.import.path, ocRoot);
    assert.equal(imported.import.label, "OpenCode external-opencode");
    // OpenCode 按数据目录导入，没有单一数据库文件，不应带 dbFile / usageLogPath。
    assert.equal(imported.import.dbFile, undefined);
    assert.equal(imported.import.usageLogPath, undefined);

    const after = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());
    assert.equal(after.summary.totals.total, before.summary.totals.total + 135);
    assert.ok(after.summary.channels.some((channel) => channel.name === "OpenCode"));
    assert.equal(
      after.metadata.homes.some((home) => home.kind === "opencode" && home.path === ocRoot),
      true,
    );

    const deleteResponse = await fetch(`${baseUrl}/api/imports?path=${encodeURIComponent(ocRoot)}`, {
      method: "DELETE",
    });
    const removed = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());
    assert.equal(deleteResponse.status, 200);
    assert.equal(removed.summary.totals.total, after.summary.totals.total);
    assert.ok(removed.summary.perf.missingSources.length > 0);
    assert.equal(
      removed.metadata.homes.some((home) => home.kind === "opencode" && home.path === ocRoot),
      false,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("server imports a Claude Code home and labels it as Claude Code", async () => {
  const { homeDir, importStoreFile } = await makeFixtureHome();
  // 造一个独立的 Claude Code home（不放在 fakeHome/.claude 下，避免被自动发现路径撞上）。
  const claudeRoot = path.join(homeDir, "external-claude");
  const projectDir = path.join(claudeRoot, "projects", "E--work-claude");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    path.join(projectDir, "session-srv-claude.jsonl"),
    jsonl([
      { type: "custom-title", customTitle: "server claude", sessionId: "session-srv-claude" },
      {
        type: "assistant",
        uuid: "uuid-srv-claude",
        timestamp: "2026-05-31T12:00:02.000Z",
        sessionId: "session-srv-claude",
        cwd: "/work/claude",
        requestedModel: "claude-sonnet-4-5",
        message: {
          id: "msg-srv-claude",
          model: "claude-sonnet-4-5",
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 5,
            output_tokens: 20,
          },
        },
      },
    ]),
  );

  const server = createUsageServer({ homeDir, importStoreFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const before = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());
    const imported = await fetch(`${baseUrl}/api/imports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: claudeRoot }),
    }).then((response) => response.json());

    assert.equal(imported.import.type, "claude-home");
    assert.equal(imported.import.path, claudeRoot);
    assert.equal(imported.import.label, "Claude Code external-claude");
    // Claude Code 按 home 导入，没有单一数据库文件，不应带 dbFile / usageLogPath。
    assert.equal(imported.import.dbFile, undefined);
    assert.equal(imported.import.usageLogPath, undefined);

    const after = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());
    assert.equal(after.summary.totals.total, before.summary.totals.total + 135);
    assert.ok(after.summary.channels.some((channel) => channel.name === "Claude"));
    assert.equal(
      after.metadata.homes.some((home) => home.kind === "claude" && home.path === claudeRoot),
      true,
    );
    assert.deepEqual(after.metadata.harnessModels.Claude, ["claude-sonnet-4-5"]);

    const deleteResponse = await fetch(`${baseUrl}/api/imports?path=${encodeURIComponent(claudeRoot)}`, {
      method: "DELETE",
    });
    const removed = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());
    assert.equal(deleteResponse.status, 200);
    assert.equal(removed.summary.totals.total, after.summary.totals.total);
    assert.ok(removed.summary.perf.missingSources.length > 0);
    assert.equal(
      removed.metadata.homes.some((home) => home.kind === "claude" && home.path === claudeRoot),
      false,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("server returns a picked directory from the local directory picker", async () => {
  const { homeDir, importStoreFile } = await makeFixtureHome();
  const pickedPath = path.join(homeDir, "picked-project");
  const server = createUsageServer({
    homeDir,
    importStoreFile,
    // Tests inject the picker so they never open an OS dialog.
    pickDirectory: async () => pickedPath,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/pick-directory`, {
      method: "POST",
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { path: pickedPath });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("JSON request parsing preserves UTF-8 split across chunks and returns client errors", async () => {
  const payload = Buffer.from(JSON.stringify({ path: "项目" }), "utf8");
  const split = payload.indexOf(Buffer.from("项目", "utf8")) + 1;
  const request = {
    async *[Symbol.asyncIterator]() {
      yield payload.subarray(0, split);
      yield payload.subarray(split);
    },
  };

  assert.deepEqual(await readJsonBody(request), { path: "项目" });

  await assert.rejects(
    readJsonBody({
      async *[Symbol.asyncIterator]() {
        yield Buffer.from("{invalid", "utf8");
      },
    }),
    (error) => error.statusCode === 400,
  );
  await assert.rejects(
    readJsonBody({
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(16_385, 32);
      },
    }),
    (error) => error.statusCode === 413,
  );
});

test("server starts directly when its script path contains spaces", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex server launch "));
  const homeDir = path.join(root, "fake home");
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const scriptFile = path.join(projectRoot, "src", "server.js");
  const child = spawn(process.execPath, [scriptFile], {
    cwd: projectRoot,
    env: {
      ...process.env,
      USERPROFILE: homeDir,
      HOME: homeDir,
      APPDATA: path.join(homeDir, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(homeDir, "AppData", "Local"),
      CODEX_USAGE_HOMES: "",
      CODEX_USAGE_IMPORT_DIRS: "",
      HOST: "127.0.0.1",
      PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const output = await new Promise((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for server startup: ${text}`)), 5_000);
      child.stdout.on("data", (chunk) => {
        text += chunk.toString();
        if (text.includes("Agent Usage dashboard:")) {
          clearTimeout(timer);
          resolve(text);
        }
      });
      child.stderr.on("data", (chunk) => {
        text += chunk.toString();
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        reject(new Error(`Server exited before startup with code ${code}: ${text}`));
      });
    });
    assert.match(output, /http:\/\/127\.0\.0\.1:\d+/);
  } finally {
    if (child.exitCode === null) child.kill();
    if (child.exitCode === null) {
      await new Promise((resolve) => child.once("close", resolve));
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("pricing refresh endpoint updates cached values and rejects an outdated editor", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-pricing-refresh-"));
  const calls = [];
  const server = createUsageServer({
    homeDir,
    pricingFetcher: async (url) => {
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
        url === USD_CNY_RATE_URL
          ? { base: "USD", quote: "CNY", date: "2026-09-28", rate: 6.82 }
          : url === LITELLM_PRICES_URL
            ? {
                "gpt-6-sol": {
                  litellm_provider: "openai",
                  input_cost_per_token: 0.000003,
                  output_cost_per_token: 0.000012,
                  input_cost_per_token_above_272k_tokens: 0.000006,
                  output_cost_per_token_above_272k_tokens: 0.000018,
                },
              }
            : {};
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    let original = await fetch(`${baseUrl}/api/pricing`).then((response) => response.json());
    const manualRate = structuredClone(original);
    manualRate.usdToCnyRate = 7.2;
    const manualRateSaved = await fetch(`${baseUrl}/api/pricing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(manualRate),
    });
    assert.equal(manualRateSaved.status, 200);
    assert.equal((await manualRateSaved.json()).usdToCnyRate, 7.2);

    const restoreRate = structuredClone(await fetch(`${baseUrl}/api/pricing`).then((response) => response.json()));
    restoreRate.restoreAutomaticExchangeRate = true;
    const restoredRate = await fetch(`${baseUrl}/api/pricing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(restoreRate),
    });
    assert.equal(restoredRate.status, 200, await restoredRate.clone().text());
    original = await fetch(`${baseUrl}/api/pricing`).then((response) => response.json());
    assert.equal(original.automatic.manualExchangeRate, false);
    assert.equal(original.usdToCnyRate, original.automatic.automaticUsdToCnyRate);

    const refreshed = await fetch(`${baseUrl}/api/pricing/refresh`, { method: "POST" }).then((response) =>
      response.json(),
    );
    assert.equal(refreshed.changed, true);
    assert.equal(refreshed.automaticModelCount, 34);
    assert.ok(refreshed.automaticModels.includes("gpt-6-sol"));
    assert.equal(refreshed.unmatchedModelCount, refreshed.totalModelCount - 34);
    assert.equal(calls.length, 7);
    const updated = await fetch(`${baseUrl}/api/pricing`).then((response) => response.json());
    assert.ok(updated.automatic.automaticModels.includes("gpt-6-sol"));
    assert.equal(updated.models["gpt-6-sol"].short.input, 3);
    assert.equal(updated.usdToCnyRate, 6.82);
    await fetch(`${baseUrl}/api/pricing/refresh`, { method: "POST" });
    assert.equal(calls.length, 7);
    const stale = await fetch(`${baseUrl}/api/pricing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(original),
    });
    assert.equal(stale.status, 409);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("pricing refresh API targets one model and keeps concurrent targets independent", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-pricing-target-"));
  const calls = [];
  const first = "gpt-r07-first";
  const second = "gpt-r07-second";
  let modelCalls = 0;
  let startedResolve;
  let releaseResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  const released = new Promise((resolve) => {
    releaseResolve = resolve;
  });
  const server = createUsageServer({
    homeDir,
    pricingFetcher: async (url) => {
      calls.push(url);
      if (url === MODEL_PRICES_URL) {
        modelCalls += 1;
        if (modelCalls === 1) {
          startedResolve();
          await released;
        }
        return new Response(JSON.stringify(r07ModelsDevCatalog([first, second])), { status: 200 });
      }
      if (url === LITELLM_PRICES_URL) return new Response(JSON.stringify({}), { status: 200 });
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await fetch(`${baseUrl}/api/pricing`);
    const matched = await fetch(`${baseUrl}/api/pricing/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-sol" }),
    }).then((response) => response.json());
    assert.deepEqual(matched.discovery.results, [{ model: "gpt-6-sol", status: "matched", reason: "exact" }]);
    assert.deepEqual(calls, []);

    for (const model of [null, "", "x".repeat(129)]) {
      const rejected = await fetch(`${baseUrl}/api/pricing/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
      });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).code, "INVALID_PRICING_MODEL");
    }

    const firstRequest = fetch(`${baseUrl}/api/pricing/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: first }),
    });
    await started;
    assert.deepEqual(calls, [MODEL_PRICES_URL, LITELLM_PRICES_URL]);

    const secondRequest = fetch(`${baseUrl}/api/pricing/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: second }),
    });
    await new Promise(setImmediate);
    assert.equal(calls.length, 2, "a different target waits for the active catalog mutation");

    releaseResolve();
    const [firstResponse, secondResponse] = await Promise.all([firstRequest, secondRequest]);
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.deepEqual((await firstResponse.json()).discovery.addedModels, [first]);
    assert.deepEqual((await secondResponse.json()).discovery.addedModels, [second]);
    assert.equal(calls.filter((url) => url === MODEL_PRICES_URL).length, 2);
    assert.equal(calls.filter((url) => url === LITELLM_PRICES_URL).length, 2);
  } finally {
    releaseResolve();
    await new Promise((resolve) => server.close(resolve));
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("pricing mutations keep a manual FX lock across save and refresh races", async () => {
  const fixture = await makeFixtureHome();
  const calls = [];
  let rate = 6.8;
  const server = createUsageServer({
    ...fixture,
    automaticDiscoveryEnabled: false,
    pricingFetcher: r07PricingFetcher({ calls, models: ["gpt-6-sol"], rate: () => rate }),
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await fetch(`${baseUrl}/api/pricing/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });

    const manual = await fetch(`${baseUrl}/api/pricing`).then((response) => response.json());
    manual.usdToCnyRate = 7.1;
    assert.equal(
      (
        await fetch(`${baseUrl}/api/pricing`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(manual),
        })
      ).status,
      200,
    );

    rate = 7.1;
    await fetch(`${baseUrl}/api/pricing/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    const equal = await fetch(`${baseUrl}/api/pricing`).then((response) => response.json());
    assert.equal(equal.usdToCnyRate, 7.1);
    assert.equal(equal.automatic.automaticUsdToCnyRate, 7.1);
    assert.equal(equal.automatic.manualExchangeRate, true);

    const draft = structuredClone(equal);
    const oldInput = draft.models["gpt-6-sol"].short.input;
    draft.models["gpt-6-sol"].short.input = oldInput + 1;
    rate = 6.8;
    const saveRequest = fetch(`${baseUrl}/api/pricing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    await new Promise(setImmediate);
    const refreshRequest = fetch(`${baseUrl}/api/pricing/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    const [saved, refreshed] = await Promise.all([saveRequest, refreshRequest]);
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.equal(refreshed.status, 200);

    const retained = await fetch(`${baseUrl}/api/pricing`).then((response) => response.json());
    assert.equal(retained.models["gpt-6-sol"].short.input, oldInput + 1);
    assert.equal(retained.usdToCnyRate, 7.1);
    assert.equal(retained.automatic.automaticUsdToCnyRate, 6.8);
    assert.equal(retained.automatic.manualExchangeRate, true);

    retained.restoreAutomaticExchangeRate = true;
    const restored = await fetch(`${baseUrl}/api/pricing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(retained),
    }).then((response) => response.json());
    assert.equal(restored.usdToCnyRate, 6.8);
    const restoredStatus = await fetch(`${baseUrl}/api/pricing`).then((response) => response.json());
    assert.equal(restoredStatus.automatic.manualExchangeRate, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("imported pricing runtime rejects saves and refreshes", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-pricing-imported-"));
  const catalog = structuredClone(getDefaultPricingCatalog());
  const server = createUsageServer({
    homeDir,
    automaticDiscoveryEnabled: false,
    importContext: { pricingCatalog: catalog, serviceTierEvidenceSnapshot: null },
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const pricing = await fetch(`${baseUrl}/api/pricing`).then((response) => response.json());
    assert.equal(pricing.automatic, null);
    const saved = await fetch(`${baseUrl}/api/pricing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(catalog),
    });
    assert.equal(saved.status, 405);
    assert.equal((await saved.json()).code, "IMPORT_PRICING_READ_ONLY");
    const refreshed = await fetch(`${baseUrl}/api/pricing/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-sol" }),
    });
    assert.equal(refreshed.status, 405);
    assert.equal((await refreshed.json()).code, "IMPORT_PRICING_READ_ONLY");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("failed pricing writes keep the prior effective catalog", async () => {
  const saveHome = await mkdtemp(path.join(tmpdir(), "codex-pricing-save-failure-"));
  const refreshHome = await mkdtemp(path.join(tmpdir(), "codex-pricing-refresh-failure-"));
  let saveServer = null;
  let refreshServer = null;
  try {
    saveServer = createUsageServer({ homeDir: saveHome, automaticDiscoveryEnabled: false });
    await new Promise((resolve) => saveServer.listen(0, "127.0.0.1", resolve));
    const saveBase = `http://127.0.0.1:${saveServer.address().port}`;
    const beforeSave = await fetch(`${saveBase}/api/pricing`).then((response) => response.json());
    const pricingPath = path.join(saveHome, ".codex-usage", "pricing.json");
    await mkdir(pricingPath, { recursive: true });
    const rejectedDraft = structuredClone(beforeSave);
    rejectedDraft.models["gpt-6-sol"].short.input += 1;
    const failedSave = await fetch(`${saveBase}/api/pricing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rejectedDraft),
    });
    assert.equal(failedSave.status, 400);
    const afterSave = await fetch(`${saveBase}/api/pricing`).then((response) => response.json());
    assert.equal(afterSave.version, beforeSave.version);
    assert.equal(afterSave.models["gpt-6-sol"].short.input, beforeSave.models["gpt-6-sol"].short.input);

    await mkdir(path.join(refreshHome, ".codex-usage", "pricing-auto.json"), { recursive: true });
    refreshServer = createUsageServer({
      homeDir: refreshHome,
      automaticDiscoveryEnabled: false,
      pricingFetcher: r07PricingFetcher({ calls: [], models: ["gpt-6-sol"], rate: 6.9 }),
    });
    await new Promise((resolve) => refreshServer.listen(0, "127.0.0.1", resolve));
    const refreshBase = `http://127.0.0.1:${refreshServer.address().port}`;
    const beforeRefresh = await fetch(`${refreshBase}/api/pricing`).then((response) => response.json());
    const failedRefresh = await fetch(`${refreshBase}/api/pricing/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(failedRefresh.status, 500);
    const afterRefresh = await fetch(`${refreshBase}/api/pricing`).then((response) => response.json());
    assert.equal(afterRefresh.version, beforeRefresh.version);
    assert.equal(afterRefresh.usdToCnyRate, beforeRefresh.usdToCnyRate);
  } finally {
    if (saveServer) await new Promise((resolve) => saveServer.close(resolve));
    if (refreshServer) await new Promise((resolve) => refreshServer.close(resolve));
    await rm(saveHome, { recursive: true, force: true });
    await rm(refreshHome, { recursive: true, force: true });
  }
});

test("pricing model activity keeps historical rates and honors a frozen usage snapshot", async () => {
  const fixture = await makeFixtureHome();
  const projectRoot = path.join(fixture.homeDir, "activity-project");
  const log = path.join(projectRoot, ".codex-usage", "usage.jsonl");
  await mkdir(path.dirname(log), { recursive: true });
  const row = (model, time) => ({
    schema_version: "codex-usage.project-log.v1",
    timestamp: new Date(time).toISOString(),
    session_id: model,
    request_id: model,
    model,
    cwd: projectRoot,
    usage: { total: 1, input: 1, output: 0 },
  });
  const now = Date.now();
  await writeFile(log, jsonl([row("retired-missing-model", now - 45 * 86400000), row("gpt-6-sol", now - 1000)]));
  const server = createUsageServer({ ...fixture, importDirs: [projectRoot], automaticDiscoveryEnabled: false });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const paused = await fetch(`${base}/api/usage?preset=all&freeze=1`).then((response) => response.json());
    assert.ok(paused.metadata.harnessModels.Codex.includes("retired-missing-model"));
    assert.deepEqual(paused.metadata.activeHarnessModels.Codex, ["gpt-6-sol"]);
    await appendFile(log, jsonl([row("new-active-missing", Date.now() - 1)]));
    await fetch(`${base}/api/usage?preset=all`);
    const latest = await fetch(`${base}/api/pricing`).then((response) => response.json());
    assert.equal(latest.usageCoverage.usedModelCount, 2);
    assert.ok(latest.models["gpt-6-sol"]);
    const frozen = await fetch(`${base}/api/pricing?snapshot=${paused.snapshotId}`).then((response) => response.json());
    assert.equal(frozen.modelActivity.modelUsageAsOf, paused.metadata.modelUsageAsOf);
    assert.deepEqual(frozen.modelActivity.activeHarnessModels, paused.metadata.activeHarnessModels);
    assert.equal(frozen.usageCoverage.usedModelCount, 1);
    assert.equal((await fetch(`${base}/api/pricing?snapshot=missing`)).status, 410);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("pricing coverage waits for the usage index and lists missing models", async () => {
  const fixture = await makeFixtureHome();
  const projectRoot = path.join(fixture.homeDir, "coverage-project");
  await mkdir(path.join(projectRoot, ".codex-usage"), { recursive: true });
  await writeFile(
    path.join(projectRoot, ".codex-usage", "usage.jsonl"),
    jsonl(
      ["gpt-daybreak-blue-latest", "mimo-v2.6-flash-free", "gpt-test-coverage"].map((model, index) => ({
        schema_version: "codex-usage.project-log.v1",
        timestamp: new Date(Date.now() - (index + 1) * 1000).toISOString(),
        session_id: `coverage-${index}`,
        request_id: `coverage-request-${index}`,
        model,
        cwd: projectRoot,
        usage: { total: 1, input: 1, cached: 0, cache_write_input_tokens: 0, output: 0 },
        service_tier: "standard",
      })),
    ),
  );
  const server = createUsageServer({ ...fixture, importDirs: [projectRoot] });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const before = await fetch(`${baseUrl}/api/pricing`).then((response) => response.json());
    assert.equal(before.usageCoverage.ready, false);

    await fetch(`${baseUrl}/api/usage?preset=all`);
    const after = await fetch(`${baseUrl}/api/pricing`).then((response) => response.json());
    assert.deepEqual(after.usageCoverage, {
      ready: true,
      usedModelCount: 3,
      matchedUsedModelCount: 2,
      freeRuleUsedModelCount: 1,
      missingUsedModels: [{ model: "gpt-test-coverage", harnesses: ["Codex"] }],
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("usage completion debounces missing-model discovery and keeps model IDs local", async () => {
  const fixture = await makeFixtureHome();
  const projectRoot = path.join(fixture.homeDir, "discovery-project");
  const laterProjectRoot = path.join(fixture.homeDir, "discovery-project-later");
  const afterCloseProjectRoot = path.join(fixture.homeDir, "discovery-project-after-close");
  await mkdir(path.join(projectRoot, ".codex-usage"), { recursive: true });
  await mkdir(path.join(laterProjectRoot, ".codex-usage"), { recursive: true });
  await mkdir(path.join(afterCloseProjectRoot, ".codex-usage"), { recursive: true });
  const usageLogPath = path.join(projectRoot, ".codex-usage", "usage.jsonl");
  const usageRow = (model, index) => ({
    schema_version: "codex-usage.project-log.v1",
    timestamp: new Date(Date.now() - (index + 1) * 1000).toISOString(),
    session_id: `discovery-session-${index}`,
    request_id: `discovery-request-${index}`,
    model,
    cwd: projectRoot,
    usage: { total: 1, input: 1, cached: 0, cache_write_input_tokens: 0, output: 0 },
  });
  await writeFile(usageLogPath, jsonl([usageRow("gpt-test-discovery", 0)]));
  const calls = [];
  const timers = [];
  const deferred = () => {
    /** @type {() => void} */
    let resolve;
    const promise = new Promise((settle) => {
      resolve = settle;
    });
    return { promise, resolve };
  };
  const blockedDiscoveries = [];
  let nextDiscoveryGate = null;
  const pricePayload = {
    openai: {
      models: {
        "gpt-test-discovery": {
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
  pricePayload.openai.models["gpt-next-discovery"] = structuredClone(pricePayload.openai.models["gpt-test-discovery"]);
  pricePayload.openai.models["gpt-after-close-discovery"] = structuredClone(
    pricePayload.openai.models["gpt-test-discovery"],
  );
  pricePayload.openai.models["gpt-close-successor"] = structuredClone(pricePayload.openai.models["gpt-test-discovery"]);
  const server = createUsageServer({
    ...fixture,
    importDirs: [projectRoot, laterProjectRoot, afterCloseProjectRoot],
    pricingDiscoveryDelayMs: 1_000,
    schedulePricingDiscovery(callback, delay) {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    cancelPricingDiscovery(timer) {
      timer.cancelled = true;
    },
    pricingFetcher: async (url) => {
      calls.push(url);
      if (nextDiscoveryGate && url === MODEL_PRICES_URL) {
        const gate = nextDiscoveryGate;
        nextDiscoveryGate = null;
        gate.started.resolve();
        await gate.released.promise;
      }
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
          ? pricePayload
          : url === LITELLM_PRICES_URL
            ? {}
            : { base: "USD", quote: "CNY", date: "2026-09-30", rate: 6.83 };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let closePromise = null;
  const closeDiscoveries = [];
  try {
    const waiting = await fetch(`${baseUrl}/api/pricing`).then((response) => response.json());
    assert.equal(waiting.usageCoverage.ready, false);
    const beforeUsageRefresh = await fetch(`${baseUrl}/api/pricing/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: false }),
    }).then((response) => response.json());
    assert.deepEqual(beforeUsageRefresh.discovery.results, [
      { model: "*", status: "deferred", reason: "usage-not-ready" },
    ]);
    assert.deepEqual(timers, []);

    await fetch(`${baseUrl}/api/usage?preset=all`).then((response) => response.json());
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 1_000);
    assert.deepEqual(calls, [
      MODEL_PRICES_URL,
      LITELLM_PRICES_URL,
      MIMO_PRICES_URL,
      STEPFUN_PRICES_URL,
      KIMI_PRICES_URL,
      GLM_PRICES_URL,
      USD_CNY_RATE_URL,
    ]);
    const firstGate = { started: deferred(), released: deferred() };
    blockedDiscoveries.push(firstGate);
    nextDiscoveryGate = firstGate;
    const firstDiscovery = timers[0].callback();
    await firstGate.started.promise;

    await writeFile(
      path.join(laterProjectRoot, ".codex-usage", "usage.jsonl"),
      jsonl([usageRow("gpt-next-discovery", 1)]),
    );
    await fetch(`${baseUrl}/api/usage?preset=all`).then((response) => response.json());
    const coverageDuringDiscovery = await fetch(`${baseUrl}/api/pricing`).then((response) => response.json());
    assert.deepEqual(coverageDuringDiscovery.usageCoverage.missingUsedModels.map((item) => item.model).sort(), [
      "gpt-next-discovery",
      "gpt-test-discovery",
    ]);
    assert.equal(timers.length, 2);
    firstGate.released.resolve();
    await firstDiscovery;

    const firstAdded = await fetch(`${baseUrl}/api/pricing`).then((response) => response.json());
    assert.equal(firstAdded.models["gpt-test-discovery"].short.input, 2);
    assert.equal(firstAdded.models["gpt-next-discovery"], undefined);
    const secondTimer = timers.find((timer) => !timer.cancelled && timer !== timers[0]);
    assert.ok(
      secondTimer,
      JSON.stringify({
        timers: timers.map((timer) => ({ cancelled: timer.cancelled, delay: timer.delay })),
        discoveryResults: firstAdded.automatic.discoveryResults,
        attemptedAt: firstAdded.automatic.discoveryAttemptedAt,
        missing: firstAdded.usageCoverage.missingUsedModels,
      }),
    );
    await secondTimer.callback();

    const after = await fetch(`${baseUrl}/api/pricing`).then((response) => response.json());
    assert.equal(after.models["gpt-next-discovery"].short.input, 2);
    assert.equal(after.usageCoverage.missingUsedModels.length, 0);
    assert.ok(
      calls.every((url) =>
        [
          MODEL_PRICES_URL,
          LITELLM_PRICES_URL,
          MIMO_PRICES_URL,
          STEPFUN_PRICES_URL,
          KIMI_PRICES_URL,
          GLM_PRICES_URL,
          USD_CNY_RATE_URL,
        ].includes(url),
      ),
    );

    await writeFile(
      path.join(afterCloseProjectRoot, ".codex-usage", "usage.jsonl"),
      jsonl([usageRow("gpt-after-close-discovery", 2)]),
    );
    await fetch(`${baseUrl}/api/usage?preset=all`).then((response) => response.json());
    const firstCloseTimer = timers.at(-1);
    const closeFirstGate = { started: deferred(), released: deferred() };
    blockedDiscoveries.push(closeFirstGate);
    nextDiscoveryGate = closeFirstGate;
    const firstCloseDiscovery = firstCloseTimer.callback();
    closeDiscoveries.push(firstCloseDiscovery);
    await closeFirstGate.started.promise;

    await writeFile(
      path.join(laterProjectRoot, ".codex-usage", "usage.jsonl"),
      jsonl([usageRow("gpt-next-discovery", 1), usageRow("gpt-close-successor", 3)]),
    );
    await fetch(`${baseUrl}/api/usage?preset=all`).then((response) => response.json());
    const mergedTimer = timers.at(-1);
    assert.notEqual(mergedTimer, firstCloseTimer);
    const closeSuccessorGate = { started: deferred(), released: deferred() };
    blockedDiscoveries.push(closeSuccessorGate);
    nextDiscoveryGate = closeSuccessorGate;
    const mergedCloseDiscovery = mergedTimer.callback();
    closeDiscoveries.push(mergedCloseDiscovery);

    await writeFile(
      path.join(afterCloseProjectRoot, ".codex-usage", "usage.jsonl"),
      jsonl([usageRow("gpt-after-close-discovery", 2), usageRow("gpt-close-cancelled", 4)]),
    );
    await fetch(`${baseUrl}/api/usage?preset=all`).then((response) => response.json());
    const pendingTimer = timers.at(-1);
    const timerCountAtClose = timers.length;
    assert.equal(pendingTimer.cancelled, undefined);

    const httpClosed = new Promise((resolve) => server.once("close", resolve));
    let closeSettled = false;
    closePromise = server.close();
    closePromise.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );
    assert.ok(closePromise instanceof Promise);
    await httpClosed;
    await new Promise(setImmediate);
    assert.equal(closeSettled, false, "close waits while an automatic pricing refresh is in flight");
    assert.equal(pendingTimer.cancelled, true);

    closeFirstGate.released.resolve();
    await closeSuccessorGate.started.promise;
    await new Promise(setImmediate);
    assert.equal(closeSettled, false, "close also waits for a coalesced successor refresh");
    closeSuccessorGate.released.resolve();
    await Promise.all([closePromise, firstCloseDiscovery, mergedCloseDiscovery]);
    assert.equal(closeSettled, true);
    assert.equal(timers.length, timerCountAtClose, "closed server schedules no further discovery timers");

    let callbackResolve;
    const callbackClosed = new Promise((resolve) => {
      callbackResolve = resolve;
    });
    assert.strictEqual(server.close(callbackResolve), server);
    await callbackClosed;
  } finally {
    for (const gate of blockedDiscoveries) gate.released.resolve();
    await Promise.allSettled(closeDiscoveries);
    if (closePromise) await closePromise.catch(() => {});
    else if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("pricing API validates, persists, and reprices indexed history", async () => {
  const fixture = await makeFixtureHome();
  const projectRoot = path.join(fixture.homeDir, "priced-project");
  await mkdir(path.join(projectRoot, ".codex-usage"), { recursive: true });
  await writeFile(
    path.join(projectRoot, ".codex-usage", "usage.jsonl"),
    jsonl([
      {
        schema_version: "codex-usage.project-log.v1",
        timestamp: "2026-05-31T12:00:00.000Z",
        session_id: "priced-session",
        request_id: "priced-request",
        model: "gpt-6-sol",
        cwd: projectRoot,
        usage: { total: 110, input: 100, cached: 20, cache_write_input_tokens: 0, output: 10 },
        service_tier: "standard",
      },
    ]),
  );
  const options = { ...fixture, importDirs: [projectRoot] };
  let server = createUsageServer(options);
  const listen = async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const close = async () => new Promise((resolve) => server.close(resolve));
  try {
    let baseUrl = await listen();
    const original = await fetch(`${baseUrl}/api/pricing`).then((response) => response.json());
    const before = await fetch(`${baseUrl}/api/usage?preset=all`).then((response) => response.json());
    assert.equal(original.models["gpt-6-sol"].short.input, 2);
    assert.ok(before.summary.costEstimate.totalUsd > 0);

    const invalid = structuredClone(original);
    invalid.models["gpt-6-sol"].short.input = -1;
    const rejected = await fetch(`${baseUrl}/api/pricing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(invalid),
    });
    assert.equal(rejected.status, 400);
    assert.equal(
      (await fetch(`${baseUrl}/api/pricing`).then((response) => response.json())).models["gpt-6-sol"].short.input,
      2,
    );

    const oversized = { ...original, padding: "x".repeat(128 * 1024) };
    const oversizedRejected = await fetch(`${baseUrl}/api/pricing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(oversized),
    });
    assert.equal(oversizedRejected.status, 413);

    const atCapacity = structuredClone(original);
    const remainingSlots = MAX_PRICING_MODELS - Object.keys(original.models).length;
    for (let index = 0; index < remainingSlots; index += 1) {
      atCapacity.models[`manual-capacity-${String(index).padStart(2, "0")}`] = structuredClone(
        original.models["gpt-6-sol"],
      );
    }
    const capacitySaved = await fetch(`${baseUrl}/api/pricing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(atCapacity),
    });
    assert.equal(capacitySaved.status, 200, await capacitySaved.clone().text());
    const capacityCatalog = await capacitySaved.json();
    assert.equal(Object.keys(capacityCatalog.models).length, MAX_PRICING_MODELS);

    const overCapacity = structuredClone(original);
    overCapacity.version = capacityCatalog.version;
    for (let index = 0; index <= remainingSlots; index += 1) {
      overCapacity.models[`manual-capacity-${String(index).padStart(2, "0")}`] = structuredClone(
        original.models["gpt-6-sol"],
      );
    }
    const capacityRejected = await fetch(`${baseUrl}/api/pricing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(overCapacity),
    });
    assert.equal(capacityRejected.status, 400);
    assert.equal((await capacityRejected.json()).code, "PRICING_CAPACITY");

    const updated = structuredClone(original);
    updated.version = capacityCatalog.version;
    updated.checkedAt = "2026-09-24";
    updated.models["gpt-6-sol"].short.input = 4;
    const saved = await fetch(`${baseUrl}/api/pricing`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(updated),
    });
    assert.equal(saved.status, 200);
    const savedCatalog = await saved.json();
    const after = await fetch(`${baseUrl}/api/usage?preset=all&skipCheck=1`).then((response) => response.json());
    assert.equal(savedCatalog.checkedAt, "2026-09-24");
    assert.equal(after.summary.costEstimate.priceCheckedAt, "2026-09-24");
    const changedStatus = await fetch(`${baseUrl}/api/status?since=${encodeURIComponent(before.fingerprint)}`).then(
      (response) => response.json(),
    );
    assert.equal(changedStatus.changed, true);
    assert.equal(changedStatus.fingerprint, after.fingerprint);
    assert.ok(Math.abs(after.summary.costEstimate.totalUsd - before.summary.costEstimate.totalUsd - 0.00016) < 1e-12);
    assert.equal(after.summary.totals.total, before.summary.totals.total);
    assert.ok((await stat(path.join(fixture.homeDir, ".codex-usage", "pricing.json"))).size > 0);

    await close();
    server = createUsageServer(options);
    baseUrl = await listen();
    const restarted = await fetch(`${baseUrl}/api/usage?preset=all`).then((response) => response.json());
    assert.equal(restarted.summary.costEstimate.totalUsd, after.summary.costEstimate.totalUsd);
    assert.equal(restarted.summary.costEstimate.priceCheckedAt, "2026-09-24");
  } finally {
    if (server.listening) await close();
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("usage API 按 exclude 参数过滤数据来源", async () => {
  const { homeDir, importStoreFile, databaseFile } = await makeFixtureHome();
  const server = createUsageServer({ homeDir, importStoreFile, databaseFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const base = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());
    assert.equal(base.summary.totals.total, 123);
    const homeId = base.metadata.homes[0].id;

    const filtered = await fetch(`${baseUrl}/api/usage?exclude=${encodeURIComponent(homeId)}`).then((response) =>
      response.json(),
    );
    assert.equal(filtered.summary.totals.total, 0);
    assert.equal(filtered.summary.eventCount, 0);
    assert.equal(filtered.periodComparison.models.length, 0);
    // 过滤只影响统计口径，来源列表要保持完整。
    assert.equal(filtered.metadata.homes[0].eventCount, 1);

    const summary = await fetch(`${baseUrl}/api/summary?exclude=${encodeURIComponent(homeId)}`).then((response) =>
      response.json(),
    );
    assert.equal(summary.summary.totals.total, 0);
    assert.equal(summary.periodComparison.models.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── D3 · server 侧：quota 的"当前时刻"语义不被复用冻结（先申请文件锁） ──────────────────────────
//
// 卡面明文：**server 测试先申请文件锁**。锁是 `%TEMP%` 下的 `.lock` 目录（原子 `mkdir`），
// 带过期回收（陈旧锁自动接管）；跑完删除，并用 `stat()` 证明**无残留**。
const D3_SERVER_LOCK_DIR = path.join(tmpdir(), "codex-usage-d3-server-test.lock");
const D3_LOCK_STALE_MS = 120_000;

async function acquireD3ServerLock(label) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await mkdir(D3_SERVER_LOCK_DIR, { recursive: false });
      await writeFile(
        path.join(D3_SERVER_LOCK_DIR, "owner.json"),
        JSON.stringify({ label, pid: process.pid, at: new Date().toISOString() }),
      );
      return {
        dir: D3_SERVER_LOCK_DIR,
        release: async () => {
          await rm(D3_SERVER_LOCK_DIR, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const info = await stat(D3_SERVER_LOCK_DIR).catch(() => null);
      if (info && Date.now() - info.mtimeMs > D3_LOCK_STALE_MS) {
        await rm(D3_SERVER_LOCK_DIR, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`D3 server 测试文件锁等待超时：${D3_SERVER_LOCK_DIR}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

test("D3 · quota API 的时刻语义：过期/新鲜随 asOf 现算，freeze 快照不被 live 新观测改写", async () => {
  const lock = await acquireD3ServerLock("d3-quota-clock");
  const { homeDir, importStoreFile, databaseFile, sessionFile } = await makeFixtureHome();
  const quotaFile = path.join(path.dirname(sessionFile), "quota-clock.jsonl");
  const estimateNow = Date.now();
  // ① 陈旧观测（11 分钟前 > 10 分钟阈值）但在窗口内 ⇒ 状态可用 + percentStale=true。
  const staleObservedAtMs = estimateNow - 11 * 60_000;
  const staleResetsAtMs = estimateNow + 240 * 60_000;
  await writeFile(
    quotaFile,
    jsonl([
      {
        type: "session_meta",
        timestamp: new Date(staleObservedAtMs - 1_000).toISOString(),
        payload: { id: "quota-clock" },
      },
      quotaTokenRow(new Date(staleObservedAtMs).toISOString(), {
        resetsAtMs: staleResetsAtMs,
        usedPercent: 42.5,
      }),
    ]),
  );
  const server = createUsageServer({ homeDir, importStoreFile, databaseFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const live1 = await fetch(`${baseUrl}/api/usage?preset=quota_5h&bucket=month`).then((response) => response.json());
    const window1 = live1.quota.windows.quota_5h;
    assert.equal(window1.state, "available");
    assert.equal(window1.usedPercent, 42.5);
    assert.equal(window1.percentStale, true, "① 观测已超 10 分钟 ⇒ percentStale=true（按请求时刻现算）");
    assert.equal(window1.windowStart, new Date(staleResetsAtMs - 300 * 60_000).toISOString());
    assert.equal(window1.windowEndExclusive, new Date(staleResetsAtMs).toISOString());
    assert.equal(live1.summary.range.asOf, live1.quota.asOf, "范围 asOf 与 quota.asOf 同源");
    assert.equal(
      live1.summary.range.end,
      new Date(Date.parse(live1.quota.asOf) - 1).toISOString(),
      "① 范围末端 = min(asOf, 窗口末端) − 1ms（时间派生字段随请求走）",
    );

    const paused = await fetch(`${baseUrl}/api/usage?preset=quota_5h&freeze=1`).then((response) => response.json());
    assert.ok(paused.snapshotId);
    const frozen1 = await fetch(`${baseUrl}/api/usage?preset=quota_5h&snapshot=${paused.snapshotId}&bucket=month`).then(
      (response) => response.json(),
    );
    assert.deepEqual(frozen1.quota, paused.quota, "冻结快照与暂停时刻逐字一致");

    // ② live 源出现**新观测**（新鲜：5 秒前）⇒ live 读数必须立即更新；冻结快照必须原样。
    const freshObservedAtMs = estimateNow - 5_000;
    const freshResetsAtMs = estimateNow + 300 * 60_000;
    await appendFile(
      quotaFile,
      jsonl([
        quotaTokenRow(new Date(freshObservedAtMs).toISOString(), { resetsAtMs: freshResetsAtMs, usedPercent: 88 }),
      ]),
    );
    const live2 = await fetch(`${baseUrl}/api/usage?preset=quota_5h&bucket=month`).then((response) => response.json());
    const window2 = live2.quota.windows.quota_5h;
    assert.equal(window2.usedPercent, 88, "② 新观测立即生效（沿 D1 修订机制）");
    assert.equal(
      window2.percentStale,
      false,
      "② 新观测新鲜 ⇒ percentStale 由 true 变 false（同一份源、不同 asOf 现算）",
    );
    assert.equal(window2.windowEndExclusive, new Date(freshResetsAtMs).toISOString());
    assert.notEqual(window2.windowEndExclusive, window1.windowEndExclusive);

    const frozen2 = await fetch(`${baseUrl}/api/usage?preset=quota_5h&snapshot=${paused.snapshotId}&bucket=month`).then(
      (response) => response.json(),
    );
    assert.deepEqual(frozen2.quota, paused.quota, "② 冻结快照**不被** live 新观测改写（自己的库 + 自己的 asOf）");
    assert.equal(frozen2.quota.windows.quota_5h.percentStale, true, "② 冻结快照保持暂停时刻的 stale 语义");
    assert.equal(frozen2.quota.windows.quota_5h.usedPercent, 42.5);
    assert.equal(frozen2.summary.range.asOf, paused.summary?.range?.asOf ?? paused.quota.asOf);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await lock.release();
    await rm(homeDir, { recursive: true, force: true });
  }
  assert.equal(await stat(D3_SERVER_LOCK_DIR).catch(() => null), null, "文件锁已释放（无残留）");
});

// ── D4 · server 侧：周期响应的 asOf 必须是"本次请求"的时刻（先申请文件锁） ────────────────────────
//
// 卡面明文：server 测试先申请文件锁（复用 D3 的锁实现，见文件上方）。判别力要点：
//   * 两次请求之间插入 ≥30ms 间隔 ⇒ 第二次的 `periodComparison.asOf` 必须落在**第二次请求**的时间窗
//     内（若命中路径把缓存的 asOf 原样返回，它就落在间隔之前 ⇒ 被抓）；
//   * 命中复用的静态部分（同一自然日 ⇒ 日历边界与合计）逐字不变；
//   * 新数据到达 ⇒ 合计增长（缓存按**实际变更**失效，而不是被命中键冻住）。

/** D4：本文件里最简的 `token_count` 行（`test/server.test.js` 只自带 `quotaTokenRow`）。 */
function d4TokenRow(timestamp, total) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: total,
          input_tokens: Math.max(total - 20, 1),
          cached_input_tokens: 0,
          output_tokens: 20,
          reasoning_output_tokens: 0,
        },
      },
    },
  };
}

test("D4 · 周期 API 的 asOf 仍新鲜 + 改数据立即失效（server，先申请文件锁）", async () => {
  const lock = await acquireD3ServerLock("d4-period-freshness");
  const { homeDir, importStoreFile, databaseFile, sessionFile } = await makeFixtureHome();
  const server = createUsageServer({ homeDir, importStoreFile, databaseFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await fetch(`${baseUrl}/api/usage?preset=all`).then((response) => response.json());
    const p1 = first.periodComparison;
    assert.ok(p1.totals.all.total > 0, "夹具的事件计入 all 周期");
    assert.ok(Date.parse(p1.asOf) > 0);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const requestStart = Date.now();
    const second = await fetch(`${baseUrl}/api/usage?preset=all`).then((response) => response.json());
    const requestEnd = Date.now();
    const p2 = second.periodComparison;
    assert.ok(
      Date.parse(p2.asOf) >= requestStart,
      `第二次请求的 asOf 必须落在本次请求窗口内（缓存时刻会是 ${p1.asOf}）`,
    );
    assert.ok(Date.parse(p2.asOf) <= requestEnd);
    assert.deepEqual(p2.periods, p1.periods, "同一自然日 ⇒ 日历边界逐字复用");
    assert.deepEqual(p2.totals, p1.totals, "命中路径复用静态合计");
    assert.deepEqual(p2.models, p1.models);

    // 新数据到达（下一次请求触发 sync）⇒ 合计必须立即增长。
    // ⚠️ 实测：`token_count` 的**累计总量必须递增**（夹具首行 123），否则产品按"陈旧快照"忽略该行。
    await appendFile(
      sessionFile,
      jsonl([{ type: "turn_context", payload: { model: "gpt-6-sol" } }, d4TokenRow("2026-05-01T02:02:00.000Z", 300)]),
    );
    const third = await fetch(`${baseUrl}/api/usage?preset=all`).then((response) => response.json());
    const p3 = third.periodComparison;
    assert.ok(
      p3.totals.all.total > p1.totals.all.total,
      `新数据 ⇒ 周期缓存按实际变更失效（${p1.totals.all.total} → ${p3.totals.all.total}）`,
    );

    // 冻结快照：asOf 与合计都绑在冻结时刻，不被随后的 live 变化改写。
    const paused = await fetch(`${baseUrl}/api/usage?preset=all&freeze=1`).then((response) => response.json());
    assert.ok(paused.snapshotId);
    await appendFile(
      sessionFile,
      jsonl([{ type: "turn_context", payload: { model: "gpt-6-mini" } }, d4TokenRow("2026-05-01T02:03:00.000Z", 400)]),
    );
    const frozenAgain = await fetch(`${baseUrl}/api/usage?preset=all&snapshot=${paused.snapshotId}`).then((response) =>
      response.json(),
    );
    assert.deepEqual(
      frozenAgain.periodComparison,
      paused.periodComparison,
      "冻结快照的周期响应逐字不变（asOf 也钉住）",
    );
    const liveAgain = await fetch(`${baseUrl}/api/usage?preset=all`).then((response) => response.json());
    assert.ok(
      liveAgain.periodComparison.totals.all.total > paused.periodComparison.totals.all.total,
      "live 继续增长，冻结侧不动",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await lock.release();
    await rm(homeDir, { recursive: true, force: true });
  }
  assert.equal(await stat(D3_SERVER_LOCK_DIR).catch(() => null), null, "文件锁已释放（无残留）");
});
