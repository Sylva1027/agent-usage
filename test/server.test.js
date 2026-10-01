import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";

import { createUsageServer, isFullDetailHeapAvailable, readJsonBody } from "../src/server.js";
import { MAX_PRICING_MODELS } from "../src/pricing.js";
import {
  GLM_PRICES_URL,
  KIMI_PRICES_URL,
  LITELLM_PRICES_URL,
  MIMO_PRICES_URL,
  MODEL_PRICES_URL,
  STEPFUN_PRICES_URL,
  USD_CNY_RATE_URL,
} from "../src/pricing-auto.js";

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

test("server accepts named recent reset windows and calendar ranges", async () => {
  const fixture = await makeFixtureHome();
  const end = Date.now() - 60_000;
  const observed = new Date(end - 60_000).toISOString();
  await appendFile(
    fixture.sessionFile,
    jsonl([
      quotaTokenRow(observed, { resetsAtMs: end }),
      quotaTokenRow(observed, { resetsAtMs: end, windowMinutes: 10080 }),
    ]),
  );
  const server = createUsageServer(fixture);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const [value, bucket, slots] of [
      ["上一个5h", "quota_30m", 10],
      ["上周", "quota_24h", 7],
      ["上个月", "day", null],
      ["今年", "month", null],
    ]) {
      const query = new URLSearchParams({ preset: "recent", recentValue: value, bucket });
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/usage?${query}`);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.summary.range.bucket, bucket);
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
    assert.equal(live.summary.comparison, null);
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

    await fetch(`${baseUrl}/api/imports?path=${encodeURIComponent(projectRoot)}`, { method: "DELETE" });
    const removed = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());

    assert.equal(removed.summary.totals.total, 123);
    assert.equal(
      removed.metadata.homes.some((home) => home.kind === "project-log" && home.path === projectRoot),
      false,
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

    await fetch(`${baseUrl}/api/imports?path=${encodeURIComponent(dshRoot)}`, { method: "DELETE" });
    const removed = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());
    assert.equal(removed.summary.totals.total, before.summary.totals.total);
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

    await fetch(`${baseUrl}/api/imports?path=${encodeURIComponent(ocRoot)}`, { method: "DELETE" });
    const removed = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());
    assert.equal(removed.summary.totals.total, before.summary.totals.total);
    assert.equal(
      removed.metadata.homes.some((home) => home.kind === "opencode" && home.path === ocRoot),
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
  let holdNextDiscovery = false;
  let signalDiscoveryStarted;
  let releaseDiscovery;
  const discoveryStarted = new Promise((resolve) => {
    signalDiscoveryStarted = resolve;
  });
  const blockedDiscovery = new Promise((resolve) => {
    releaseDiscovery = resolve;
  });
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
      if (holdNextDiscovery && url === MODEL_PRICES_URL) {
        holdNextDiscovery = false;
        signalDiscoveryStarted();
        await blockedDiscovery;
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
    holdNextDiscovery = true;
    const firstDiscovery = timers[0].callback();
    await discoveryStarted;

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
    releaseDiscovery();
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
    const pendingTimer = timers.at(-1);
    assert.equal(pendingTimer.cancelled, undefined);
    await new Promise((resolve) => server.close(resolve));
    assert.equal(pendingTimer.cancelled, true);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
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
