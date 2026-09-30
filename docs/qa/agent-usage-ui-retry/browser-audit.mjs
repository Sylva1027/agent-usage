import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const output = path.dirname(fileURLToPath(import.meta.url));
const phase = process.argv.includes("--compare") ? "compare" : "audit";
const playwrightModule = process.env.AGENT_USAGE_PLAYWRIGHT_MODULE || path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const { chromium } = await import(pathToFileURL(playwrightModule).href);
const { createUsageServer } = await import(pathToFileURL(path.join(root, "src/server.js")).href);
const { buildUsageReport } = await import(pathToFileURL(path.join(root, "src/usage-core.js")).href);
const { renderStaticDashboardHtml } = await import(pathToFileURL(path.join(root, "src/static-export.js")).href);
const { getDefaultPricingCatalog } = await import(pathToFileURL(path.join(root, "src/pricing.js")).href);
const fixture = await mkdtemp(path.join(os.tmpdir(), "agent-usage-ui-qa-"));
const now = new Date();
const sourceUrl = "https://models.dev/api.json";
const defaults = getDefaultPricingCatalog();
const model = "gpt-6.1-sol";
const longModel = "research-model-with-a-very-long-experimental-name-2026-09-30-alpha-beta-gamma-delta-epsilon";
const projects = [
  ["research-repository-with-a-very-long-name-中英文数字-20260930-alpha-beta-gamma", longModel, [200, 0, 0, 0]],
  ["Alpha-模型项目-2026", "gpt-6-sol", [100, 900, 0, 0]],
  ["Beta-陶瓷界面-2026", model, [100, 900, 100, 0]],
  ["Gamma-GLM-数据分析-2026", "glm-5.3", [100, 900, 100, 200]],
  ["Free-免费规则-2026", "mimo-v2.6-flash-free", [50, 0, 0, 0]],
];
const importDirs = [];
let record = 0;
for (const [name, modelName, quantities] of projects) {
  const cwd = path.join(fixture, name);
  importDirs.push(cwd);
  await mkdir(path.join(cwd, ".codex-usage"), { recursive: true });
  const rows = quantities.flatMap((quantity, index) => {
    if (!quantity) return [];
    const date = new Date(now);
    if (index === 0) date.setMinutes(date.getMinutes() - 5);
    if (index === 1) date.setDate(date.getDate() - 1);
    if (index === 2) date.setDate(date.getDate() - 8);
    if (index === 3) date.setDate(date.getDate() - 45);
    const total = quantity * 10_000;
    record += 1;
    return [{ schema_version: "codex-usage.project-log.v1", timestamp: date.toISOString(), session_id: `qa-session-${record}`, request_id: `qa-request-${record}`, model: modelName, cwd, service_tier: modelName === model ? "priority" : "standard", usage: { total, input: total * 0.8, cached: total * 0.2, cache_write_input_tokens: total * 0.05, output: total * 0.2 } }];
  });
  await writeFile(path.join(cwd, ".codex-usage/usage.jsonl"), `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
}
const codex = path.join(fixture, ".codex/sessions");
await mkdir(codex, { recursive: true });
await writeFile(path.join(codex, "quota.jsonl"), [
  { timestamp: now.toISOString(), type: "session_meta", payload: { id: "qa-quota", source: "cli", originator: "codex-tui", cwd: fixture } },
  { timestamp: now.toISOString(), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }, rate_limits: { limit_id: "codex", primary: { used_percent: 42, window_minutes: 300, resets_at: Math.floor(now.getTime() / 1000) + 10_800 }, secondary: { used_percent: 20, window_minutes: 10_080, resets_at: Math.floor(now.getTime() / 1000) + 432_000 } } } },
].map(row => JSON.stringify(row)).join("\n"));
const pricingDir = path.join(fixture, ".codex-usage");
await mkdir(pricingDir, { recursive: true });
const metadata = tier => ({ checkedAt: now.toISOString(), origin: tier === "short" ? "mixed" : "remote", sourceUrl, providerId: "openai", providedFields: tier === "short" ? ["input", "output"] : ["input", "cachedInput", "cacheWrite", "output"], inheritedFields: tier === "short" ? ["cachedInput", "cacheWrite"] : [], fieldSources: { input: sourceUrl, output: sourceUrl }, ...(tier === "fast.long" ? { conflicts: [{ field: "input", sources: ["Models.dev", "LiteLLM"], values: [8, 9] }] } : {}) });
await writeFile(path.join(pricingDir, "pricing-auto.json"), JSON.stringify({
  priceUpdatedAt: now.toISOString(), priceAttemptedAt: now.toISOString(), exchangeRateDate: now.toISOString().slice(0, 10), exchangeRateUpdatedAt: now.toISOString(), usdToCnyRate: 6.8,
  models: { [model]: { ...defaults.models[model], source: sourceUrl } },
  modelMetadata: { [model]: Object.fromEntries(["short", "long", "fast.short", "fast.long"].map(tier => [tier, metadata(tier)])) },
  priceUpdateSummary: { attemptedModelCount: 82, verifiedModelCount: 1, changedModelCount: 0, partialModelCount: 1, conflictModelCount: 1, manualOverrideModelCount: 1, noValidMatchModelCount: 81, unsupportedCurrencyModelCount: 4 }, issues: [],
}));
await writeFile(path.join(pricingDir, "pricing.json"), JSON.stringify({ schemaVersion: 2, usdToCnyRate: 7.3, modelOverrides: { [model]: { short: { input: 2.2 } } } }));
const options = { homeDir: fixture, env: {}, importDirs, importStoreFile: path.join(pricingDir, "imports.json"), databaseFile: path.join(pricingDir, "usage.sqlite"), automaticDiscoveryEnabled: false, pricingFetcher: async () => { throw new Error("QA fixture: simulated upstream unavailable"); } };
const server = createUsageServer(options);
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const results = { date: now.toISOString(), phase, browser: null, fixture: "Synthetic project logs and pricing metadata; no personal data", checks: [], layouts: [], backgrounds: [], pageErrors: [], consoleErrors: [], externalRequests: [], fontRequests: [], fonts: [] };
let browser;
const sessions = [];
async function check(name, action) {
  try { const details = await action(); results.checks.push({ name, passed: true, ...(details ? { details } : {}) }); console.log(`PASS ${name}`); }
  catch (error) { results.checks.push({ name, passed: false, error: error.message }); console.log(`FAIL ${name}: ${error.message}`); }
}
async function observe(context, page, label) {
  page.on("pageerror", error => results.pageErrors.push({ label, message: error.message }));
  page.on("console", message => { if (message.type() === "error") results.consoleErrors.push({ label, message: message.text() }); });
  page.on("request", request => { if (request.resourceType() === "font") results.fontRequests.push(request.url()); });
  await context.route("**/*", route => {
    const url = route.request().url();
    if (/^https?:/u.test(url) && !url.startsWith(base)) { results.externalRequests.push(url); return route.abort(); }
    return route.continue();
  });
}
async function ready(page) {
  await page.waitForFunction(() => document.querySelector("#totalTokens")?.textContent.trim() !== "-" && document.querySelector("#modelComparisonTable table"));
  await settle(page);
}
async function settle(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function choose(page, theme, locale) {
  if (await page.locator("html").getAttribute("data-theme") !== theme) await page.locator("#themeToggle").click();
  if ((await page.locator("#languageToggle").getAttribute("aria-pressed") === "true") !== (locale === "en-US")) await page.locator("#languageToggle").click();
  await settle(page);
}
async function geometry(page) {
  return page.evaluate(() => {
    const rect = selector => { const box = document.querySelector(selector)?.getBoundingClientRect(); return box ? { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom } : null; };
    return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, background: getComputedStyle(document.body).backgroundColor, title: rect("h1"), actions: rect(".topbar-actions"), range: rect(".range-controls"), refresh: rect("#autoRefreshStatus"), last: rect("#lastSuccessfulCheck"), zone: rect("#calendarZoneSelect"), font: getComputedStyle(document.body).fontFamily };
  });
}
async function screenshot(page, name, fullPage = true) { await page.screenshot({ path: path.join(output, `${name}.png`), fullPage }); }
async function makePage(label, viewport = { width: 1440, height: 1100 }, scale = 1) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: scale, locale: "zh-CN", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await observe(context, page, label);
  sessions.push(context);
  return { context, page };
}
async function load(page, url = base) {
  await page.goto(url, { waitUntil: "networkidle" });
  await ready(page);
  if (await page.locator("#autoRefreshToggle").getAttribute("aria-pressed") === "true") await page.locator("#autoRefreshToggle").click();
}
function assertFits(value) { assert.ok(value.documentWidth <= value.width + 1 && value.bodyWidth <= value.width + 1, JSON.stringify(value)); }
async function matrix(page, prefix) {
  for (const width of [1440, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1100 });
    for (const theme of ["light", "dark"]) for (const locale of ["zh-CN", "en-US"]) {
      await choose(page, theme, locale);
      await page.evaluate(() => scrollTo(0, 0));
      const value = await geometry(page);
      results.layouts.push({ page: prefix, theme, locale, ...value });
      await check(`${prefix} ${width}px ${theme} ${locale} fits viewport`, () => assertFits(value));
      await check(`${prefix} ${width}px ${theme} ${locale} range labels fit controls`, async () => {
        const buttons = await page.locator("#presetButtons > button").evaluateAll(nodes => nodes.map(node => ({ label: node.textContent.trim(), width: node.clientWidth, contentWidth: node.scrollWidth })));
        assert.ok(buttons.every(button => button.contentWidth <= button.width + 1), JSON.stringify(buttons));
      });
      if ([1440, 390].includes(width)) {
        await screenshot(page, `${prefix}-${width}-${theme}-${locale}`);
        await screenshot(page, `${prefix}-${width}-${theme}-${locale}-top`, false);
      }
    }
  }
}
try {
  browser = await chromium.launch({ executablePath: process.env.AGENT_USAGE_EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  results.browser = `Microsoft Edge ${await browser.version()}`;
  const { page } = await makePage(phase);
  await load(page);
  await page.locator('[data-preset="all"]').click();
  await settle(page);
  if (phase === "compare") {
    const variants = { light: [["current", "#d7dfe6"], ["slightly-darker", "#cfd8e1"], ["darker", "#c5ced8"]], dark: [["current", "#252b31"], ["slightly-darker", "#20252b"], ["darker", "#1b2026"]] };
    for (const [theme, colors] of Object.entries(variants)) {
      await choose(page, theme, "zh-CN");
      const panelBefore = await page.locator(".metric").first().evaluate(node => getComputedStyle(node).backgroundImage);
      for (const [name, color] of colors) {
        await page.evaluate(color => document.documentElement.style.setProperty("--bg", color), color);
        await settle(page);
        const file = `background-${theme}-${name}`;
        await screenshot(page, file);
        const panelAfter = await page.locator(".metric").first().evaluate(node => getComputedStyle(node).backgroundImage);
        results.backgrounds.push({ theme, variant: name, color, file: `${file}.png`, panelMaterialUnchanged: panelBefore === panelAfter });
        console.log(`BACKGROUND ${theme} ${name} ${color}`);
      }
      await page.evaluate(() => document.documentElement.style.removeProperty("--bg"));
    }
  } else {
    await matrix(page, "live");
    await page.setViewportSize({ width: 1440, height: 1100 });
    await choose(page, "light", "zh-CN");
    await check("model and repository default ordering prioritizes today, week, month, all", async () => {
      for (const [id, expected] of [["modelComparisonTable", [longModel, "glm-5.3", model, "gpt-6-sol"]], ["repositoryComparisonTable", [projects[0][0], projects[3][0], projects[2][0], projects[1][0]]]]) {
        const rows = await page.locator(`#${id} tbody .comparison-row-label`).allTextContents();
        expected.forEach((name, index) => assert.ok(rows[index]?.includes(name), `${id}: ${JSON.stringify(rows)}`));
      }
    });
    await check("manual comparison sort cycles and returns to default", async () => {
      const button = page.locator('#modelComparisonTable [data-comparison-sort][data-period="today"]');
      await button.click(); await button.click();
      assert.equal(await button.locator("..").getAttribute("aria-sort"), "ascending");
      await button.click();
      const first = await page.locator("#modelComparisonTable tbody .comparison-row-label").first().textContent();
      assert.ok(first.includes(longModel));
    });
    await check("model and repository search supports matches and empty results", async () => {
      for (const [search, table] of [["modelComparisonSearch", "modelComparisonTable"], ["repositoryComparisonSearch", "repositoryComparisonTable"]]) {
        await page.locator(`#${search}`).fill("Gamma-no-such-result-123");
        assert.equal(await page.locator(`#${table} tbody tr`).count(), 0);
        await page.locator(`#${search}`).fill("gpt");
        await page.locator(`#${search}`).fill("");
        assert.ok(await page.locator(`#${table} tbody tr`).count() > 0);
      }
    });
    await check("timezone follows last-refresh label and updates timestamp", async () => {
      await page.locator("#calendarZoneSelect").selectOption("utc");
      await settle(page);
      assert.match(await page.locator("#lastSuccessfulCheck").textContent(), /UTC/u);
      const value = await geometry(page);
      assert.ok(value.zone.x >= value.last.right - 1, JSON.stringify(value));
      await page.locator("#calendarZoneSelect").selectOption("local");
    });
    await check("date picker closes with Escape and returns keyboard focus", async () => {
      await page.locator("#dateRangeButton").click();
      assert.equal(await page.locator("#dateRangePicker").evaluate(node => node.hidden), false);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#dateRangePicker").evaluate(node => node.hidden), true);
      assert.equal(await page.evaluate(() => document.activeElement.id), "dateRangeButton");
    });
    await check("date picker applies two dates and clears the custom range", async () => {
      await page.locator("#dateRangeButton").click();
      const days = await page.locator("#dateRangePicker [data-date]:not(:disabled)").evaluateAll(nodes => nodes.map(node => node.dataset.date));
      await page.locator(`#dateRangePicker [data-date="${days[10]}"]`).click();
      assert.equal(await page.locator("#dateRangePicker").evaluate(node => node.hidden), false);
      await page.locator(`#dateRangePicker [data-date="${days[13]}"]`).click();
      assert.equal(await page.locator("#dateRangePicker").evaluate(node => node.hidden), true);
      assert.equal(await page.locator("#dateRangeButton").evaluate(node => node.classList.contains("active")), true);
      await page.locator("#dateRangeButton").click();
      await page.locator("[data-date-picker-clear]").click();
      assert.equal(await page.locator("#dateRangeButton").evaluate(node => node.classList.contains("active")), false);
      await page.keyboard.press("Escape");
      await page.locator('[data-preset="all"]').click();
    });
    await check("recent-range menu selects year and quota controls select both windows", async () => {
      await page.locator("#recentMenuButton").click();
      await page.locator('[data-recent-option="今年"]').click();
      assert.equal(await page.locator("#recentRangeMenu").evaluate(node => node.hidden), true);
      await page.locator("#quotaPresetToggle").click();
      await page.locator("#quotaPresetToggle").click();
      await page.locator('[data-preset="all"]').click();
    });
    await check("source dialog excludes and restores a fixture data source", async () => {
      await page.locator("#importButton").click();
      const input = page.locator('#sourcePicker input[type="checkbox"]').nth(1);
      const before = await page.locator("#totalTokens").textContent();
      await input.uncheck();
      await page.waitForFunction(before => document.querySelector("#totalTokens").textContent !== before, before);
      await input.check();
      await page.waitForFunction(before => document.querySelector("#totalTokens").textContent === before, before);
      await screenshot(page, "source-dialog-light-zh", false);
      await page.locator("#cancelImportButton").click();
    });
    await check("source dialog closing restores opener focus", async () => {
      await page.locator("#importButton").click();
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#importDialog").evaluate(node => node.hidden), true);
      assert.equal(await page.evaluate(() => document.activeElement.id), "importButton");
      await page.locator("#addImportButton").click();
      await page.keyboard.press("Escape");
      assert.equal(await page.evaluate(() => document.activeElement.id), "addImportButton");
    });
    await check("source dialog keyboard navigation stays within the dialog", async () => {
      await page.locator("#importButton").click();
      await page.locator("#submitImportButton").focus();
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.querySelector("#importDialog").contains(document.activeElement)), true);
      await page.keyboard.press("Shift+Tab");
      assert.equal(await page.evaluate(() => document.activeElement.id), "submitImportButton");
    });
    await page.keyboard.press("Escape");
    await page.locator("#updatePricingButton").click();
    await page.locator('#pricingModelList [data-pricing-model="gpt-6.1-sol"]').waitFor();
    await check("search and directory input values share the theme text color", async () => {
      const themes = [];
      for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        const colors = await page.evaluate(() => ["modelComparisonSearch", "repositoryComparisonSearch", "pricingSearch", "importPath"].map(id => ({ id, value: getComputedStyle(document.getElementById(id)).color, placeholder: getComputedStyle(document.getElementById(id), "::placeholder").color, font: getComputedStyle(document.getElementById(id)).fontFamily })));
        assert.equal(new Set(colors.map(item => item.value)).size, 1, JSON.stringify(colors));
        assert.equal(new Set(colors.map(item => item.placeholder)).size, 1, JSON.stringify(colors));
        themes.push({ theme, colors });
      }
      await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
      return themes;
    });
    await check("model price editor exposes ordinary/Fast and short/long tiers with provenance", async () => {
      await page.locator(`[data-pricing-model="${model}"]`).click();
      assert.ok(await page.locator("#modelPricingFields input").count() >= 16);
      assert.match(await page.locator("#modelPricingNote").textContent(), /混合|继承|冲突/u);
      const input = page.locator("#modelPricingFields input").first();
      const original = await input.inputValue();
      await input.fill(String(Number(original) + 0.1));
      assert.equal(await page.locator("#applyModelPricingButton").isDisabled(), false);
      await input.fill(original);
      assert.equal(await page.locator("#applyModelPricingButton").isDisabled(), true);
      for (let step = 0; step < 24; step += 1) {
        await page.keyboard.press("Tab");
        const focus = await page.evaluate(() => ({ contained: document.querySelector("#modelPricingDialog").contains(document.activeElement), tag: document.activeElement.tagName, id: document.activeElement.id }));
        assert.ok(focus.contained || focus.tag === "BODY", `Tab ${step}: ${JSON.stringify(focus)}`);
      }
      await screenshot(page, "model-price-dialog-light-zh", false);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#modelPricingDialog").evaluate(node => node.open), false);
    });
    if (await page.locator("#modelPricingDialog").evaluate(node => node.open)) await page.locator("#cancelModelPricingButton").click();
    await check("restore automatic exchange rate can cancel without persisting", async () => {
      await page.locator("#restoreAutomaticRateButton").click();
      assert.equal(await page.locator("#usdToCnyRate").inputValue(), "6.8");
      await page.locator("#cancelPricingButton").click();
      const payload = await fetch(`${base}/api/pricing`).then(response => response.json());
      assert.equal(payload.usdToCnyRate, 7.3);
      assert.equal(payload.automatic.manualExchangeRate, true);
      await page.locator("#updatePricingButton").click();
      await page.locator("#restoreAutomaticRateButton").waitFor();
    });
    await check("restore automatic exchange rate saves without clearing model overrides", async () => {
      await page.locator("#restoreAutomaticRateButton").click();
      const response = page.waitForResponse(response => response.url() === `${base}/api/pricing` && response.request().method() === "PUT");
      await page.locator("#savePricingButton").click();
      assert.equal((await response).status(), 200);
      await page.locator("#pricingDialog").waitFor({ state: "hidden" });
      const payload = await fetch(`${base}/api/pricing`).then(response => response.json());
      assert.equal(payload.usdToCnyRate, 6.8);
      assert.equal(payload.automatic.manualExchangeRate, false);
      assert.equal(payload.models[model].short.input, 2.2);
    });
    await page.locator("#updatePricingButton").click();
    await page.locator("#pricingSearch").waitFor();
    await check("pricing scopes, search, empty state and download failure are usable", async () => {
      await page.locator('[data-pricing-scope="all"]').click();
      await page.locator("#pricingSearch").fill("glm");
      const expectedGlm = Object.keys(defaults.models).filter(name => name.includes("glm")).sort();
      assert.deepEqual((await page.locator("#pricingModelList [data-pricing-model]").evaluateAll(rows => rows.map(row => row.dataset.pricingModel))).sort(), expectedGlm);
      await page.locator("#pricingSearch").fill("definitely-not-a-listed-model");
      assert.equal(await page.locator("#pricingModelList [data-pricing-model]").count(), 0);
      await page.locator("#pricingSearch").fill("");
      const response = page.waitForResponse(response => response.url().endsWith("/api/pricing/refresh"));
      await page.locator("#refreshPricingButton").click();
      await response;
      await page.waitForFunction(() => document.querySelector("#pricingMessage").textContent.includes("QA fixture"));
      assert.equal(await page.locator("#usdToCnyRate").inputValue(), "6.8");
      await screenshot(page, "pricing-failure-light-zh", false);
    });
    await check("pricing dialog keyboard navigation stays within the dialog", async () => {
      await page.locator("#savePricingButton").focus();
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.querySelector("#pricingDialog").contains(document.activeElement)), true);
      await page.keyboard.press("Shift+Tab");
      assert.equal(await page.evaluate(() => document.activeElement.id), "savePricingButton");
    });
    await check("pricing dialog Escape restores opener focus", async () => {
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#pricingDialog").evaluate(node => node.hidden), true);
      assert.equal(await page.evaluate(() => document.activeElement.id), "updatePricingButton");
    });
    for (const theme of ["light", "dark"]) {
      await choose(page, theme, "en-US");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator("#updatePricingButton").click();
      await page.locator("#pricingSearch").waitFor();
      await check(`390px ${theme} English pricing dialog fits and empty text is localized`, async () => {
        const box = await page.locator("#pricingDialog .dialog").boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= 391, JSON.stringify(box));
        await page.locator("#pricingSearch").fill("definitely-not-a-listed-model");
        assert.match(await page.locator("#pricingModelList").textContent(), /No matching|No models/u);
        await screenshot(page, `pricing-empty-390-${theme}-en`, false);
        await page.locator("#pricingSearch").fill("");
      });
      await page.locator("#cancelPricingButton").click();
      await page.evaluate(() => { document.querySelector("#lastSuccessfulCheck").textContent = "Last refreshed Wednesday, September 30, 2026 at 23:59:59 UTC+08:00"; document.querySelector("#autoRefreshError").textContent = "Refresh failed: example-of-a-long-upstream-error-without-spaces-1234567890-1234567890"; });
      await page.evaluate(() => scrollTo(0, 0));
      const value = await geometry(page);
      await check(`390px ${theme} long refresh timestamp and error fit`, () => assertFits(value));
      await screenshot(page, `refresh-error-390-${theme}-en`);
      await screenshot(page, `refresh-error-390-${theme}-en-top`, false);
    }
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    const dom = await cdp.send("DOM.getDocument");
    for (const selector of ["h1", "h2", "#totalTokens"]) {
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: dom.root.nodeId, selector });
      results.fonts.push({ selector, ...(await cdp.send("CSS.getPlatformFontsForNode", { nodeId })) });
    }
    const report = await buildUsageReport(options);
    const file = path.join(fixture, "dashboard-fixture.html");
    await writeFile(file, renderStaticDashboardHtml({ ...report, generatedAt: now.toISOString(), asOf: now.toISOString() }));
    const { context: offlineContext, page: offline } = await makePage("offline");
    await offlineContext.setOffline(true);
    await load(offline, pathToFileURL(file).href);
    await offline.locator('[data-preset="all"]').click();
    await matrix(offline, "offline");
    await check("offline snapshot controls stay offline and interactive", async () => {
      assert.equal(await offline.locator("#autoRefreshToggle").isDisabled(), true);
      assert.equal(await offline.locator("#importButton").isDisabled(), true);
      assert.equal(await offline.locator("#updatePricingButton").isDisabled(), true);
      await offline.locator("#calendarZoneSelect").selectOption("utc");
      await offline.locator('[data-preset="month"]').click();
      await offline.locator("#modelComparisonSearch").fill("gpt");
      assert.ok(await offline.locator("#modelComparisonTable tbody tr").count() > 0);
      await offline.locator("#modelComparisonSearch").fill("");
      await offline.locator('[data-preset="all"]').click();
    });
    for (const mode of ["live", "offline"]) {
      const { context, page: zoomed } = await makePage(`${mode}-200-percent`, { width: 720, height: 550 }, 2);
      if (mode === "offline") await context.setOffline(true);
      await load(zoomed, mode === "offline" ? pathToFileURL(file).href : base);
      await zoomed.locator('[data-preset="all"]').click();
      for (const theme of ["light", "dark"]) for (const locale of ["zh-CN", "en-US"]) {
        await choose(zoomed, theme, locale);
        const value = await geometry(zoomed);
        results.layouts.push({ page: `${mode}-200-percent-equivalent`, theme, locale, physicalWidth: 1440, deviceScaleFactor: 2, ...value });
        await check(`${mode} 200% equivalent ${theme} ${locale} fits`, () => assertFits(value));
        if (locale === "en-US") await screenshot(zoomed, `${mode}-200-percent-${theme}-en`);
      }
    }
    const { page: polling } = await makePage("polling");
    let statusRequests = 0;
    let priceRequests = 0;
    polling.on("request", request => { if (request.url().includes("/api/status")) statusRequests += 1; });
    polling.on("request", request => { if (request.url().includes("/api/pricing/refresh")) priceRequests += 1; });
    await polling.clock.install({ time: now });
    await polling.goto(base, { waitUntil: "networkidle" });
    await ready(polling);
    await check("auto refresh timer pauses and resumes without duplicate polls", async () => {
      const first = statusRequests;
      await polling.clock.runFor(60_100);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(statusRequests, first + 1);
      await polling.locator("#autoRefreshToggle").click();
      const paused = statusRequests;
      await polling.clock.runFor(60_100);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(statusRequests, paused);
      await polling.locator("#autoRefreshToggle").click();
      await new Promise(resolve => setTimeout(resolve, 100));
      const resumed = statusRequests;
      await polling.clock.runFor(60_100);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(statusRequests, resumed + 1);
      assert.equal(priceRequests, 1);
      return { statusRequests, priceRequests, intervalMs: 60_000 };
    });
    await check("browser runs without script errors or external/font requests", () => {
      assert.deepEqual(results.pageErrors, []);
      assert.deepEqual(results.consoleErrors, []);
      assert.deepEqual(results.externalRequests, []);
      assert.deepEqual(results.fontRequests, []);
    });
  }
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(output, `${phase}-results.json`), `${JSON.stringify(results, null, 2)}\n`);
  const failures = results.checks.filter(item => !item.passed);
  console.log(JSON.stringify({ phase, passed: results.checks.length - failures.length, failed: failures.length, pageErrors: results.pageErrors, results: `${phase}-results.json` }));
  if (failures.length) process.exitCode = 1;
}
