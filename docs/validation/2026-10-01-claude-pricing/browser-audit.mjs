import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdCompressSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const output = path.dirname(fileURLToPath(import.meta.url));
const playwrightModule = process.env.AGENT_USAGE_PLAYWRIGHT_MODULE || path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const { chromium } = await import(pathToFileURL(playwrightModule).href);
const { createUsageServer } = await import(pathToFileURL(path.join(root, "src/server.js")).href);
const { buildUsageReport } = await import(pathToFileURL(path.join(root, "src/usage-core.js")).href);
const { renderStaticDashboardHtml } = await import(pathToFileURL(path.join(root, "src/static-export.js")).href);
const fixture = await mkdtemp(path.join(os.tmpdir(), "claude-browser-qa-"));
const now = new Date();
for (const [id, model] of [["priced", "claude-haiku-4-5-20251001"], ["unknown", "claude-sonnet-4-9"]]) {
  const directory = path.join(fixture, ".dsh", "sessions", "fixture", id);
  await mkdir(directory, { recursive: true });
  const rows = [
    { type: "session", version: 4, id, createdAt: now.getTime() - 2000, cwd: fixture, delegationDepth: 0 },
    { type: "request/header", seq: 1, time: now.getTime() - 1000, data: { header: { config: { provider: "anthropic", model } } } },
    { type: "assistant/message", seq: 2, time: now.getTime() - 500, data: { turn: 1, step: 1, usage: id === "priced" ? { inputTokens: 1_000, cacheReadTokens: 8_000, cacheWriteTokens: 1_000, outputTokens: 500, totalTokens: 10_500 } : { inputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, totalTokens: 5 } } },
  ];
  await writeFile(path.join(directory, "session.v4.jsonl.zstd"), zstdCompressSync(Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n")));
}
const pricingDir = path.join(fixture, ".codex-usage");
const server = createUsageServer({ homeDir: fixture, env: {}, importDirs: [], importStoreFile: path.join(pricingDir, "imports.json"), databaseFile: path.join(pricingDir, "usage.sqlite"), automaticDiscoveryEnabled: false, pricingFetcher: async () => { throw new Error("QA: simulated upstream unavailable"); } });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const results = { date: now.toISOString(), fixture: "Synthetic DSH v4 logs; pinned Claude ID, nonzero writes, unknown version; isolated home and database", browser: null, checks: [], layouts: [], pageErrors: [], consoleErrors: [], externalRequests: [] };
let browser;
async function check(name, action) {
  try { const details = await action(); results.checks.push({ name, passed: true, ...(details ? { details } : {}) }); console.log(`PASS ${name}`); }
  catch (error) { results.checks.push({ name, passed: false, error: error.message }); console.log(`FAIL ${name}: ${error.message}`); }
}
async function settle(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function ready(page) { await page.waitForFunction(() => document.querySelector("#modelComparisonTable table")); await settle(page); }
async function choose(page, theme, locale) {
  if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#themeToggle").click();
  if ((await page.locator("#languageToggle").getAttribute("aria-pressed") === "true") !== (locale === "en-US")) await page.locator("#languageToggle").click();
  await settle(page);
}
async function makePage(label, offline = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", error => results.pageErrors.push({ label, message: error.message }));
  page.on("console", message => { if (message.type() === "error") results.consoleErrors.push({ label, message: message.text() }); });
  await context.route("**/*", route => {
    const url = route.request().url();
    if (/^https?:/u.test(url) && !url.startsWith(base)) { results.externalRequests.push(url); return route.abort(); }
    return route.continue();
  });
  if (offline) await context.setOffline(true);
  return page;
}
async function matrix(page, prefix) {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1100 });
    for (const theme of ["light", "dark"]) for (const locale of ["zh-CN", "en-US"]) {
      const name = `${prefix}-${width}-${theme}-${locale}`;
      await choose(page, theme, locale);
      await check(`${name}: fees, TTL and Anthropic source visible`, async () => {
        const note = await page.locator("#costEstimateNote").textContent();
        assert.match(note, locale === "en-US" ? /5-minute/ : /5 分钟/);
        assert.match(note, /Anthropic/);
        assert.equal(await page.locator('#costEstimateNote a[href="https://platform.claude.com/docs/en/about-claude/pricing"]').count(), 1);
        assert.equal(await page.locator('#costEstimateNote a[href*="openai.com"]').count(), 0);
        assert.match(await page.locator("#modelComparisonTable").textContent(), /claude-haiku-4-5-20251001/);
        await page.locator('[data-timeline-mode="cost"]').click();
        await page.locator("#timelineChart").focus();
        assert.match(await page.locator("#usageTooltip").textContent(), locale === "en-US" ? /5-minute/ : /5 分钟/);
        await page.locator('[data-timeline-mode="channel"]').click();
      });
      await check(`${name}: viewport fits`, async () => {
        const layout = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
        results.layouts.push({ name, ...layout });
        assert.ok(layout.documentWidth <= width + 1 && layout.bodyWidth <= width + 1, JSON.stringify(layout));
      });
      if (prefix === "live") await check(`${name}: editable USD rate and TTL scenario`, async () => {
        await page.locator("#updatePricingButton").click();
        await page.locator('[data-pricing-model="claude-haiku-4-5"]').click();
        assert.match(await page.locator("#modelPricingTitle").textContent(), /USD/);
        assert.match(await page.locator("#modelPricingNote").textContent(), locale === "en-US" ? /5-minute/ : /5 分钟/);
        assert.equal(await page.locator('#modelPricingFields input[data-context="short"][data-field="cacheWrite"]').inputValue(), "1.25");
        await page.screenshot({ path: path.join(output, `${name}-editor.png`) });
        await page.locator("#cancelModelPricingButton").click();
        await page.locator("#cancelPricingButton").click();
      });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
    }
  }
}
try {
  browser = await chromium.launch({ executablePath: process.env.AGENT_USAGE_EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  results.browser = `Microsoft Edge ${await browser.version()}`;
  const page = await makePage("live");
  await page.goto(base, { waitUntil: "networkidle" });
  await ready(page);
  if (await page.locator("#autoRefreshToggle").getAttribute("aria-pressed") === "true") await page.locator("#autoRefreshToggle").click();
  await page.locator('[data-preset="all"]').click();
  await settle(page);
  await matrix(page, "live");
  await page.setViewportSize({ width: 1440, height: 1100 });
  await choose(page, "light", "zh-CN");
  await check("unknown Claude version remains missing and is not borrowed or auto-created", async () => {
    await page.locator("#updatePricingButton").click();
    const row = page.locator('#pricingModelList [aria-label="claude-sonnet-4-9"]');
    assert.match(await row.textContent(), /缺少费率/);
    const catalog = await (await fetch(`${base}/api/pricing`)).json();
    assert.equal(catalog.models["claude-sonnet-4-9"], undefined);
    assert.equal(Object.keys(catalog.models).length, 103);
    await page.locator("#cancelPricingButton").click();
  });
  await check("price editor saves manual input and reprices existing history", async () => {
    const before = (await (await fetch(`${base}/api/summary?preset=all`)).json()).summary;
    await page.locator("#updatePricingButton").click();
    await page.locator('[data-pricing-model="claude-haiku-4-5"]').click();
    for (const context of ["short", "long"]) await page.locator(`#modelPricingFields input[data-context="${context}"][data-field="input"]`).fill("2");
    await page.locator("#applyModelPricingButton").click();
    await page.locator("#savePricingButton").click();
    await page.waitForFunction(() => document.querySelector("#pricingDialog").hidden);
    const after = (await (await fetch(`${base}/api/summary?preset=all`)).json()).summary;
    assert.deepEqual(after.totals, before.totals);
    assert.ok(Math.abs(after.costEstimate.totalUsd - before.costEstimate.totalUsd - 0.001) < 1e-12);
    await page.locator("#updatePricingButton").click();
    assert.match(await page.locator('[data-pricing-model="claude-haiku-4-5"]').textContent(), /手动覆盖/);
    await page.locator("#cancelPricingButton").click();
    return { beforeUsd: before.costEstimate.totalUsd, afterUsd: after.costEstimate.totalUsd, tokens: after.totals.total };
  });
  await check("simulated refresh failure retains manual price and Claude metadata", async () => {
    await page.locator("#updatePricingButton").click();
    const responsePromise = page.waitForResponse(response => response.url().endsWith("/api/pricing/refresh") && response.request().method() === "POST");
    await page.locator("#refreshPricingButton").click();
    await responsePromise;
    await page.waitForFunction(() => !document.querySelector("#refreshPricingButton").disabled);
    const catalog = await (await fetch(`${base}/api/pricing`)).json();
    assert.equal(catalog.models["claude-haiku-4-5"].short.input, 2);
    assert.equal(catalog.models["claude-haiku-4-5"].cacheWriteTtl, "5m");
    assert.ok(catalog.automatic.issues.length > 0);
    await page.locator("#cancelPricingButton").click();
  });
  const report = await buildUsageReport({ homeDir: fixture, env: {}, asOf: now });
  const snapshot = path.join(output, "snapshot.html");
  await writeFile(snapshot, renderStaticDashboardHtml({ ...report, asOf: now.toISOString() }));
  const offline = await makePage("offline", true);
  await offline.goto(pathToFileURL(snapshot).href, { waitUntil: "load" });
  await ready(offline);
  await offline.locator('[data-preset="all"]').click();
  await matrix(offline, "offline");
  await check("offline snapshot disables saving and network refresh", async () => {
    assert.equal(await offline.locator("#updatePricingButton").isDisabled(), true);
    assert.equal(await offline.locator("#autoRefreshToggle").isDisabled(), true);
  });
  await check("no script errors or external page requests", () => {
    assert.deepEqual(results.pageErrors, []);
    assert.deepEqual(results.consoleErrors, []);
    assert.deepEqual(results.externalRequests, []);
  });
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(fixture).startsWith("claude-browser-qa-"));
  await rm(fixture, { recursive: true, force: true });
  await writeFile(path.join(output, "browser-results.json"), `${JSON.stringify(results, null, 2)}\n`);
  const failures = results.checks.filter(item => !item.passed);
  console.log(JSON.stringify({ passed: results.checks.length - failures.length, failed: failures.length, results: "browser-results.json" }));
  if (failures.length) process.exitCode = 1;
}
