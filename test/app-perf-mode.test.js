import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { drawTimeline, renderTimelineLegendHtml } from "../public/app.js";
import { state } from "../public/app-state.js";
import { createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";
import { createUsageServer } from "../src/server.js";

const PLAYWRIGHT_CANDIDATES = [
  process.env.AGENT_USAGE_PLAYWRIGHT_MODULE,
  path.join(
    homedir(),
    ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs",
  ),
].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

async function resolveBrowserRuntime() {
  let chromium = null;
  for (const candidate of PLAYWRIGHT_CANDIDATES) {
    try {
      chromium = (await import(existsSync(candidate) ? pathToFileURL(candidate).href : candidate)).chromium || null;
    } catch {
      chromium = null;
    }
    if (chromium) break;
  }
  const executablePath = EDGE_CANDIDATES.find((candidate) => existsSync(candidate));
  return chromium && executablePath ? { chromium, executablePath } : null;
}

const browserRuntime = await resolveBrowserRuntime();

function addSyntheticCodexEstimate(perf) {
  const group = {
    sourceKind: "codex",
    homeId: "codex-synthetic-home",
    channel: "codex-main",
    agentKind: "main",
    agent: "",
    model: "gpt-m5-estimated",
    modelProvider: "fixture-openai",
    reasoningEffort: "high",
    timingKind: "item_span_estimate",
    tokenScope: "reported_output_includes_reasoning",
    n: 3,
    tps: { p10: 20.12, p50: 42.456, p90: 61.78, pooled: 40.25 },
    durationMs: { p50: 2000, p90: 3500 },
    sums: { outputTokens: 400, durationMs: 9950 },
    state: "ok",
    rank: null,
    insufficientSamples: true,
    warnings: ["METHOD_ESTIMATE"],
  };
  group.groupKey = JSON.stringify([
    group.sourceKind,
    group.homeId,
    group.channel,
    group.agentKind,
    group.agent,
    group.model,
    group.modelProvider,
    group.reasoningEffort,
    group.timingKind,
    group.tokenScope,
  ]);
  const bucket = {
    eligible: 3,
    positiveOutput: 3,
    timedPositiveOutput: 3,
    completeTimedPositiveOutput: 3,
    sampled: 3,
    dropped: 0,
    pending: 0,
    unplaced: 0,
    byFlag: { METHOD_ESTIMATE: 3 },
    droppedByReason: Object.fromEntries(Object.keys(perf.coverage.droppedByReason || {}).map((key) => [key, 0])),
    timingRate: 1,
    completeTimingRate: 1,
    sampleRate: 1,
    byEra: null,
  };
  perf.groups = [...(perf.groups || []), group];
  perf.coverage.byGroup ||= {};
  perf.coverage.byGroup[group.groupKey] = bucket;
  const diagnosticKey = JSON.stringify([
    "zcode",
    "zcode-small",
    "zcode",
    "unknown",
    "",
    "m5-missing-duration",
    "fixture-provider",
    "",
    "request_e2e",
    "reported_output_unspecified",
  ]);
  perf.coverage.byGroup[diagnosticKey] = {
    ...bucket,
    eligible: 3,
    positiveOutput: 2,
    timedPositiveOutput: 1,
    completeTimedPositiveOutput: 1,
    sampled: 0,
    dropped: 3,
    byFlag: { SOURCE_FILTERED: 1 },
    droppedByReason: {
      ...(bucket.droppedByReason || {}),
      output_missing_zero_invalid: 1,
      duration_missing_nonpositive_invalid: 1,
      source_filtered: 1,
    },
    timingRate: 0.5,
    completeTimingRate: 0.5,
    sampleRate: 0,
  };
  perf.coverage.bySource ||= {};
  perf.coverage.bySource.codex = {
    ...bucket,
    byEra: {
      recent: bucket,
      legacy: {
        ...bucket,
        eligible: 0,
        positiveOutput: 0,
        timedPositiveOutput: 0,
        completeTimedPositiveOutput: 0,
        sampled: 0,
        droppedByReason: bucket.droppedByReason,
        timingRate: null,
        completeTimingRate: null,
        sampleRate: null,
      },
    },
  };
  for (const key of ["eligible", "positiveOutput", "timedPositiveOutput", "completeTimedPositiveOutput", "sampled"]) {
    perf.coverage[key] = (perf.coverage[key] || 0) + bucket[key];
  }
  const missing = perf.coverage.byGroup[diagnosticKey];
  for (const key of ["eligible", "positiveOutput", "timedPositiveOutput", "completeTimedPositiveOutput", "dropped"]) {
    perf.coverage[key] = (perf.coverage[key] || 0) + missing[key];
  }
  for (const [key, value] of Object.entries(missing.droppedByReason)) {
    perf.coverage.droppedByReason[key] = (perf.coverage.droppedByReason[key] || 0) + value;
  }
  perf.coverage.timingRate = perf.coverage.positiveOutput
    ? perf.coverage.timedPositiveOutput / perf.coverage.positiveOutput
    : null;
  perf.coverage.completeTimingRate = perf.coverage.positiveOutput
    ? perf.coverage.completeTimedPositiveOutput / perf.coverage.positiveOutput
    : null;
  perf.coverage.sampleRate = perf.coverage.eligible ? perf.coverage.sampled / perf.coverage.eligible : null;
  perf.state = "degraded";
  perf.meta.state = "degraded";
  perf.degradedHomeIds = [...new Set([...(perf.degradedHomeIds || []), "dsh-fixture"])];
  perf.unsupportedSources = [...(perf.unsupportedSources || []), { kind: "future-source", homeId: "unsupported-home" }];
  const warning = { sourceKind: "dsh", homeId: "dsh-fixture", code: "LIVE_SOURCE_CHANGED", count: 1 };
  perf.sourceWarnings = [...(perf.sourceWarnings || []), warning];
  perf.meta.sourceWarnings = [...(perf.meta.sourceWarnings || []), warning];
}

function addSyntheticRankOrderGroups(perf) {
  const cases = [
    [
      { model: "m5-provider-rank-a", provider: "provider-A", effort: "", n: 20, p50: 100 },
      { model: "m5-provider-rank-b", provider: "provider-B", effort: "", n: 20, p50: 90 },
      { model: "m5-provider-small-a", provider: "provider-A", effort: "", n: 1, p50: 200 },
    ].map((group) => ({ ...group, channel: "m5-provider-order" })),
    [
      { model: "m5-effort-rank-high", provider: "provider-A", effort: "high", n: 20, p50: 100 },
      { model: "m5-effort-rank-low", provider: "provider-A", effort: "low", n: 20, p50: 90 },
      { model: "m5-effort-small-high", provider: "provider-A", effort: "high", n: 1, p50: 200 },
    ].map((group) => ({ ...group, channel: "m5-effort-order" })),
    [
      { model: "m5-effort-rank-1", provider: "provider-A", effort: "high", n: 20, p50: 100 },
      { model: "m5-effort-rank-2", provider: "provider-A", effort: "low", n: 20, p50: 90 },
      { model: "m5-effort-rank-3", provider: "provider-A", effort: "high", n: 20, p50: 80 },
    ].map((group) => ({ ...group, channel: "m5-ranked-effort-order" })),
  ];
  const rows = cases.flat().map(({ model, provider, effort, n, p50, channel }) => {
    const dimensions = [
      "zcode",
      "zcode-small",
      channel,
      "subagent",
      "m5-agent",
      model,
      provider,
      effort,
      "request_e2e",
      "reported_output_unspecified",
    ];
    const groupKey = JSON.stringify(dimensions);
    return {
      groupKey,
      sourceKind: dimensions[0],
      homeId: dimensions[1],
      channel: dimensions[2],
      agentKind: dimensions[3],
      agent: dimensions[4],
      model: dimensions[5],
      modelProvider: dimensions[6],
      reasoningEffort: dimensions[7],
      timingKind: dimensions[8],
      tokenScope: dimensions[9],
      n,
      tps: { p10: p50, p50, p90: p50, pooled: p50 },
      durationMs: { p50: 1000, p90: 1200 },
      sums: { outputTokens: n * 100, durationMs: n * 1000 },
      state: "ok",
      rank: null,
      insufficientSamples: n < 20,
      warnings: [],
    };
  });
  perf.groups.push(...rows);
  perf.coverage.byGroup ||= {};
  for (const row of rows) {
    const count = row.n;
    perf.coverage.byGroup[row.groupKey] = {
      eligible: count,
      positiveOutput: count,
      timedPositiveOutput: count,
      completeTimedPositiveOutput: count,
      sampled: count,
      dropped: 0,
      pending: 0,
      unplaced: 0,
      byFlag: {},
      droppedByReason: {},
      timingRate: 1,
      completeTimingRate: 1,
      sampleRate: 1,
    };
    for (const key of ["eligible", "positiveOutput", "timedPositiveOutput", "completeTimedPositiveOutput", "sampled"]) {
      perf.coverage[key] = (perf.coverage[key] || 0) + count;
    }
  }
  for (const key of ["timingRate", "completeTimingRate", "sampleRate"]) {
    const numerator =
      key === "timingRate"
        ? perf.coverage.timedPositiveOutput
        : key === "completeTimingRate"
          ? perf.coverage.completeTimedPositiveOutput
          : perf.coverage.sampled;
    const denominator = key === "sampleRate" ? perf.coverage.eligible : perf.coverage.positiveOutput;
    perf.coverage[key] = denominator ? numerator / denominator : null;
  }
}

function appendZcodeSample(homeDir) {
  const database = new DatabaseSync(path.join(homeDir, "zcode-ranked", "cli", "db", "db.sqlite"));
  try {
    database
      .prepare(
        "INSERT INTO model_usage (id, session_id, status, started_at, completed_at, duration_ms, input_tokens, output_tokens, agent, query_source, model_id, provider_id, first_token_at, time_to_first_token_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "m5-frozen-extra",
        "m5-frozen-session",
        "completed",
        1_791_081_600_000,
        1_791_081_600_500,
        500,
        1,
        999,
        "worker",
        "subagent",
        "ranked-model",
        "fixture-provider",
        null,
        null,
      );
  } finally {
    database.close();
  }
}

test("performance view keeps timeline modes separate and rejects the performance sentinel", () => {
  assert.equal(state.activeView, "timeline");
  assert.ok(["channel", "model", "cost"].includes(state.timelineMode));
  assert.throws(
    () => drawTimeline(null, [], [], new Map(), null, "performance", [], new Map()),
    /unsupported timeline mode/,
  );
  assert.throws(() => renderTimelineLegendHtml({}, "performance", new Map(), new Map()), /unsupported timeline mode/);

  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "all dashboard ids remain unique");
  assert.match(html, /id="perfModeButton"[^>]*data-active-view="performance"[^>]*aria-pressed="false"/);
  assert.match(html, /id="perfPanel"[^>]*hidden/);
  assert.match(html, /id="perfDetailList"[^>]*hidden/);
  assert.match(html, /id="timelineModes"[^>]*aria-label="查看方式"/);
  assert.match(html, /id="timelineChart"[^>]*tabindex="0"/);
});

test("isolated three-source dashboard supports performance view, keyboard, filters, and frozen refresh", {
  skip: !browserRuntime,
  timeout: 150_000,
}, async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode", "dsh", "opencode"] });
  const server = createUsageServer(fixture.serverOptions);
  let browser = null;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await browserRuntime.chromium.launch({ executablePath: browserRuntime.executablePath, headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
    });
    await context.addInitScript(() => {
      localStorage.setItem("codexUsageLocale", "zh-CN");
      localStorage.setItem("codexUsageTheme", "light");
      localStorage.setItem("codexUsageAutoRefresh", "on");
      localStorage.removeItem("codexUsageExcludedHomes");
    });
    const page = await context.newPage();
    const pageErrors = [];
    const apiSnapshots = [];
    const evidenceDir = process.env.PERF_UI_EVIDENCE_DIR;
    const saveScreenshot = async (name, { diagnostics = false } = {}) => {
      if (!evidenceDir) return;
      await page.evaluate((showDiagnostics) => {
        window.scrollTo(0, 0);
        const panel = document.querySelector("#perfPanel");
        const details = document.querySelector("#perfDetailList");
        if (panel) panel.scrollTop = showDiagnostics ? panel.scrollHeight : 0;
        if (details) details.scrollTop = 0;
      }, diagnostics);
      await page.screenshot({ path: path.join(evidenceDir, name), fullPage: true });
    };
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.route("**/api/usage**", async (route) => {
      try {
        const response = await route.fetch();
        const data = await response.json();
        if (data?.summary?.perf) {
          addSyntheticCodexEstimate(data.summary.perf);
          addSyntheticRankOrderGroups(data.summary.perf);
          const requestUrl = new URL(route.request().url());
          apiSnapshots.push({
            snapshot: requestUrl.searchParams.get("snapshot"),
            snapshotId: data.snapshotId || null,
            freeze: requestUrl.searchParams.get("freeze"),
            preset: requestUrl.searchParams.get("preset"),
            excluded: requestUrl.searchParams.get("exclude"),
            groups: structuredClone(data.summary.perf.groups),
          });
          await route.fulfill({
            status: response.status(),
            headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
            body: JSON.stringify(data),
          });
        } else {
          await route.fulfill({ response });
        }
      } catch (error) {
        await route.abort("failed").catch(() => {});
        pageErrors.push(`usage route: ${String(error)}`);
      }
    });

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.locator("#timelineChart").waitFor({ state: "visible" });
    let load = page.waitForResponse((response) => response.url().includes("/api/usage"));
    await page.locator("[data-preset='all']").click();
    await load;
    await page.locator("#timelineChart").waitFor({ state: "visible" });
    assert.ok(
      apiSnapshots.some((entry) => entry.preset === "all"),
      "the page loaded the actual all-range dashboard API",
    );
    const originalTimelineImage = await page.locator("#timelineChart").evaluate((canvas) => canvas.toDataURL());

    await page.locator("#perfModeButton").click();
    await page.locator("#perfPanel").waitFor({ state: "visible" });
    assert.equal(await page.locator("#perfModeButton").getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".timeline-chart-well").isHidden(), true);
    assert.equal(await page.locator("#timelineChart").getAttribute("tabindex"), "-1");
    assert.equal(await page.locator("#timelineChart").getAttribute("aria-hidden"), "true");
    for (const model of ["ranked-model", "small-model", "dsh-model", "opencode-model", "gpt-m5-estimated"]) {
      await page.locator("#perfList").getByText(model, { exact: true }).first().waitFor({ state: "visible" });
    }
    const allSnapshot = apiSnapshots.find((entry) => entry.preset === "all");
    assert.ok(allSnapshot, "the full-range API response is retained for group-index assertions");
    const rowState = await page.locator("#perfList .perf-model-row").evaluateAll((rows) =>
      rows.map((row) => ({
        model: row.querySelector(".perf-model-name")?.textContent,
        index: Number(row.dataset.perfGroupIndex),
      })),
    );
    const visibleModels = new Set(rowState.map((row) => row.model));
    for (const expected of [
      ["m5-provider-rank-a", "m5-provider-rank-b", "m5-provider-small-a"],
      ["m5-effort-rank-high", "m5-effort-rank-low", "m5-effort-small-high"],
      ["m5-effort-rank-1", "m5-effort-rank-2", "m5-effort-rank-3"],
    ]) {
      assert.ok(
        expected.every((model) => visibleModels.has(model)),
        `all interleaved fixture rows are visible: ${expected.join(", ")}`,
      );
      assert.deepEqual(
        rowState.filter((row) => expected.includes(row.model)).map((row) => row.model),
        expected,
      );
    }
    const originalApiIndex = allSnapshot.groups.findIndex((group) => group.model === "m5-provider-rank-b");
    const selectedRankingRow = page.locator(`#perfList .perf-model-row[data-perf-group-index="${originalApiIndex}"]`);
    assert.equal(await selectedRankingRow.locator(".perf-model-name").innerText(), "m5-provider-rank-b");
    await selectedRankingRow.click();
    assert.equal(await page.locator("#perfDetailList .perf-detail > h3").innerText(), "m5-provider-rank-b");
    assert.equal(await selectedRankingRow.getAttribute("aria-pressed"), "true");
    await page.locator("#perfList .perf-diagnostics").waitFor({ state: "visible", timeout: 5000 });
    assert.match(await page.locator("#perfCoverage").innerText(), /部分数据来源不可用/);
    assert.match(await page.locator("#perfCoverage").innerText(), /有不支持性能统计的来源/);
    assert.match(await page.locator("#perfCoverage").innerText(), /存在来源告警/);
    const coverageDisclosure = page.locator("#perfCoverage .perf-coverage-more");
    await coverageDisclosure.locator("summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(
      await coverageDisclosure.evaluate((node) => node.open),
      true,
      "the disclosure opens from the keyboard",
    );
    await coverageDisclosure.getByText(/LIVE_SOURCE_CHANGED/).waitFor({ state: "visible" });
    assert.match(await coverageDisclosure.innerText(), /LIVE_SOURCE_CHANGED/);
    assert.match(await coverageDisclosure.innerText(), /future-source/);
    await page.keyboard.press("Enter");
    assert.match(await page.locator("#perfList").innerText(), /样本不足/);
    assert.match(await page.locator("#perfList").innerText(), /缺少输出\/输出无效/);
    assert.match(await page.locator("#perfList").innerText(), /缺少时长\/时长无效/);
    assert.match(await page.locator("#perfList").innerText(), /代理未知/);

    const estimateRow = page.locator("#perfList .perf-model-row").filter({ hasText: "gpt-m5-estimated" });
    await estimateRow.click();
    assert.match(await page.locator("#perfDetailList").innerText(), /轮级 item 时窗 TPS 估算/);
    assert.match(await page.locator("#perfDetailList").innerText(), /p10 表示较慢端，p90 表示较快端/);
    assert.match(await page.locator("#perfDetailList").innerText(), /n\s*3/);
    assert.doesNotMatch(await page.locator("#perfPanel").innerText(), /TTFT|纯生成速度/);

    await page.locator("#perfModeButton").focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.matches("#perfCoverage summary")), true);
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("perf-model-row")), true);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    assert.equal(
      await page.locator("#perfPanel").isVisible(),
      true,
      "Escape does not discard or exit the selected view",
    );

    const transitionDuration = await page
      .locator("#perfModeButton")
      .evaluate((button) => getComputedStyle(button).transitionDuration);
    assert.equal(transitionDuration, "0s", "reduced-motion removes control transitions");
    if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
    await saveScreenshot("m5-light-zh-desktop.png");
    await saveScreenshot("m5-light-zh-diagnostics.png", { diagnostics: true });

    await page.locator("#languageToggle").click();
    await page
      .locator("#perfPanel")
      .getByText("Model output throughput", { exact: true })
      .waitFor({ state: "visible" });
    const englishCoverageDisclosure = page.locator("#perfCoverage .perf-coverage-more");
    if (!(await englishCoverageDisclosure.evaluate((node) => node.open))) {
      await englishCoverageDisclosure.locator("summary").click();
    }
    const englishEraText = await englishCoverageDisclosure.innerText();
    assert.match(englishEraText, /Codex · Recent/);
    assert.match(englishEraText, /Codex · History/);
    assert.doesNotMatch(englishEraText, /Codex · 近期|Codex · 历史/);
    await saveScreenshot("m5-light-en-desktop.png");
    await page.locator("#themeToggle").click();
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await saveScreenshot("m5-dark-en-desktop.png");
    await page.setViewportSize({ width: 900, height: 780 });
    await page.waitForTimeout(120);
    assert.equal(await page.locator("#perfPanel").evaluate((node) => node.scrollWidth <= node.clientWidth), true);
    assert.ok(
      await page
        .locator("#perfDetailList .perf-detail-meta dt")
        .first()
        .evaluate((node) => node.getBoundingClientRect().width >= 60),
    );
    await saveScreenshot("m5-dark-en-narrow.png");
    await page.locator("#languageToggle").click();
    await page.locator("#perfPanel").getByText("模型输出吞吐", { exact: true }).waitFor({ state: "visible" });
    const chineseCoverageDisclosure = page.locator("#perfCoverage .perf-coverage-more");
    if (!(await chineseCoverageDisclosure.evaluate((node) => node.open))) {
      await chineseCoverageDisclosure.locator("summary").click();
    }
    const chineseEraText = await chineseCoverageDisclosure.innerText();
    assert.match(chineseEraText, /Codex · 近期/);
    assert.match(chineseEraText, /Codex · 历史/);
    assert.doesNotMatch(chineseEraText, /Codex · Recent|Codex · History/);
    await saveScreenshot("m5-dark-zh-narrow.png");

    // Filtering and date/time-zone reloads stay on the performance view and use the same API groups.
    load = page.waitForResponse(
      (response) =>
        response.url().includes("/api/usage") && new URL(response.url()).searchParams.get("preset") === "week",
    );
    await page.locator("[data-preset='week']").click();
    await load;
    assert.equal(await page.locator("#perfPanel").isVisible(), true);
    await page.locator("#calendarZoneSelect").click();
    load = page.waitForResponse(
      (response) =>
        response.url().includes("/api/usage") && new URL(response.url()).searchParams.get("calendarZone") === "utc",
    );
    await page.locator("[data-calendar-zone='utc']").click();
    await load;
    assert.equal(await page.locator("#perfPanel").isVisible(), true);

    await page.locator("#addImportButton").click();
    const firstSource = page.locator("#sourcePicker input[data-source-id]").first();
    const sourceId = await firstSource.getAttribute("data-source-id");
    load = page.waitForResponse(
      (response) =>
        response.url().includes("/api/usage") &&
        new URL(response.url()).searchParams.get("exclude")?.includes(sourceId),
    );
    await firstSource.uncheck();
    await load;
    assert.equal(await page.locator("#perfPanel").isVisible(), true);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#importDialog").isHidden(), true);

    // Freeze a real server snapshot, mutate the backing source, then reload through the existing snapshot id.
    await page.locator("#autoRefreshToggle").click();
    load = page.waitForResponse(
      (response) => response.url().includes("/api/usage") && new URL(response.url()).searchParams.get("freeze") === "1",
    );
    await load;
    const frozen = apiSnapshots.at(-1);
    assert.equal(frozen.freeze, "1");
    const snapshotId = frozen.snapshotId;
    assert.ok(snapshotId, "freeze response supplies a snapshot id");
    appendZcodeSample(fixture.reportOptions.homeDir);
    const beforeSnapshotReload = frozen.groups.find((entry) => entry.model === "ranked-model")?.n;
    load = page.waitForResponse(
      (response) =>
        response.url().includes("/api/usage") && new URL(response.url()).searchParams.get("snapshot") === snapshotId,
    );
    await page.locator("#calendarZoneSelect").click();
    await page.locator("[data-calendar-zone='local']").click();
    await load;
    const snapshotReload = apiSnapshots.at(-1);
    assert.equal(snapshotReload.snapshot, snapshotId);
    assert.equal(snapshotReload.groups.find((entry) => entry.model === "ranked-model")?.n, beforeSnapshotReload);
    assert.equal(await page.locator("#perfPanel").isVisible(), true);

    // Exercise the product quota toggle and actual unavailable API response, then switch every timeline mode from a null summary.
    await page.evaluate(async () => {
      const { state } = await import("/app-state.js");
      state.metadata.homes.push({
        id: "m5-review-codex",
        kind: "codex",
        status: "active",
        path: "m5-synthetic-codex",
        label: "m5-review-codex",
      });
      document.querySelector("#quotaPresetToggle").disabled = false;
    });
    const quotaResponse = page.waitForResponse((response) => {
      const requestUrl = new URL(response.url());
      return requestUrl.pathname === "/api/usage" && requestUrl.searchParams.get("preset") === "quota_5h";
    });
    await page.locator("#quotaPresetToggle").click();
    assert.equal(
      (await quotaResponse).status(),
      409,
      "the fixture has no quota evidence and returns the real unavailable response",
    );
    await page.waitForFunction(async () => {
      const { state } = await import("/app-state.js");
      return state.summary === null && state.preset === "quota_5h" && Boolean(state.emptySummaryMessage);
    });
    const unavailableMessage = await page.evaluate(
      async () => (await import("/app-state.js")).state.emptySummaryMessage,
    );
    for (const mode of ["model", "cost", "channel"]) {
      await page.locator(`[data-timeline-mode='${mode}']`).click();
      assert.equal(await page.locator("#perfPanel").isHidden(), true);
      assert.equal(await page.locator(".timeline-chart-well").isVisible(), true);
      assert.equal(await page.locator("#timelineChart").getAttribute("tabindex"), "0");
      assert.equal(await page.locator("#timelineChart").getAttribute("aria-hidden"), null);
      assert.equal(await page.locator("#perfModeButton").getAttribute("aria-pressed"), "false");
      assert.equal(await page.locator(`[data-timeline-mode='${mode}']`).getAttribute("aria-pressed"), "true");
      assert.equal(
        await page.locator("#detailModeLabel").innerText(),
        { model: "按模型", cost: "按花销", channel: "按渠道" }[mode],
      );
      assert.match(
        await page.locator("#detailList").innerText(),
        new RegExp(unavailableMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      assert.equal((await page.locator("#timelineLegend").innerText()).trim(), "");
      assert.equal(await page.locator("#timelineRangeWarning").isHidden(), true);
    }
    const emptyTimelineImage = await page.locator("#timelineChart").evaluate((canvas) => canvas.toDataURL());
    assert.notEqual(
      emptyTimelineImage,
      originalTimelineImage,
      "the timeline redraws empty instead of exposing its previous bars",
    );
    await page.locator("#perfModeButton").click();
    assert.equal(await page.locator("#perfPanel").isVisible(), true);
    assert.equal(await page.locator("#perfModeButton").getAttribute("aria-pressed"), "true");
    assert.match(
      await page.locator("#perfList").innerText(),
      new RegExp(unavailableMessage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    load = page.waitForResponse(
      (response) =>
        response.url().includes("/api/usage") && new URL(response.url()).searchParams.get("preset") === "all",
    );
    await page.locator("[data-preset='all']").click();
    await load;
    await page.locator("#perfList .perf-model-row").first().waitFor({ state: "visible" });

    // The original time chart returns with its original keyboard and accessibility contract.
    await page.locator("[data-timeline-mode='channel']").focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#perfPanel").isHidden(), true);
    assert.equal(await page.locator(".timeline-chart-well").isVisible(), true);
    assert.equal(await page.locator("#timelineChart").getAttribute("tabindex"), "0");
    assert.equal(await page.locator("#timelineChart").getAttribute("aria-hidden"), null);
    await page.evaluate(() => {
      document.querySelector("#timelineChart").focus();
      document.querySelector("#perfModeButton").click();
    });
    assert.equal(await page.evaluate(() => document.activeElement?.id), "perfPanelTitle");
    assert.deepEqual(pageErrors, [], "the live page has no uncaught runtime errors");

    // Hold the initial usage API request while the page is empty and switch views before metadata/summary load.
    const loadingPage = await context.newPage();
    const loadingPageErrors = [];
    let releaseUsage;
    let signalUsageRequest;
    const usageGate = new Promise((resolve) => {
      releaseUsage = resolve;
    });
    const usageRequestStarted = new Promise((resolve) => {
      signalUsageRequest = resolve;
    });
    try {
      loadingPage.on("pageerror", (error) => loadingPageErrors.push(String(error)));
      await loadingPage.route("**/api/usage**", async (route) => {
        signalUsageRequest();
        await usageGate;
        await route.continue();
      });
      await loadingPage.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await usageRequestStarted;
      await loadingPage.locator("#perfModeButton").click();
      assert.equal(await loadingPage.locator("#perfPanel").isVisible(), true);
      assert.equal(await loadingPage.locator("#perfModeButton").getAttribute("aria-pressed"), "true");
      assert.match(await loadingPage.locator("#perfList").innerText(), /用量摘要暂不可用/);
      await loadingPage.locator("[data-timeline-mode='cost']").click();
      assert.equal(await loadingPage.locator("#perfPanel").isHidden(), true);
      assert.equal(await loadingPage.locator(".timeline-chart-well").isVisible(), true);
      assert.equal(await loadingPage.locator("#perfModeButton").getAttribute("aria-pressed"), "false");
      assert.equal(await loadingPage.locator("[data-timeline-mode='cost']").getAttribute("aria-pressed"), "true");
    } finally {
      releaseUsage();
      await loadingPage.close().catch(() => {});
    }
    assert.deepEqual(loadingPageErrors, [], "view switches during the initial load have no browser runtime errors");
    await context.close();
  } finally {
    await browser?.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    fixture.close();
  }
});
