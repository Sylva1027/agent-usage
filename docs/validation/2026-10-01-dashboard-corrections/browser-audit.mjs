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
  ["research-repository-with-a-very-long-name-中英文数字-20260930-alpha-beta-gamma", longModel, [1, 0, 0, 0]],
  ["Alpha-模型项目-2026", "gpt-6-sol", [100, 900, 0, 0]],
  ["Beta-陶瓷界面-2026", model, [100, 900, 100, 0]],
  ["Gamma-GLM-数据分析-2026", "glm-5.3", [100, 900, 100, 200]],
  ["Free-免费规则-2026", "mimo-v2.6-flash-free", [50, 0, 0, 0]],
];
projects.push(["Retired-fixture-project", "retired-model-fixture", [0, 0, 0, 200]]);
const importDirs = [];
let record = 0;
for (const [name, modelName, quantities] of projects) {
  const cwd = path.join(fixture, name);
  importDirs.push(cwd);
  if (name.startsWith("research")) await mkdir(path.join(cwd, ".git"), {recursive:true});
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
    return [{ schema_version: "codex-usage.project-log.v1", timestamp: date.toISOString(), session_id: `qa-session-${record}`, request_id: `qa-request-${record}`, model: modelName, cwd, channel: name.startsWith("Alpha") ? "ZCode Subagent" : name.startsWith("Beta") ? "DSH Subagent" : name.startsWith("Gamma") ? "OpenCode" : "Codex Desktop", service_tier: modelName === model ? "priority" : "standard", usage: { total, input: total * 0.8, cached: total * 0.2, cache_write_input_tokens: total * 0.05, output: total * 0.2 } }];
  });
  await writeFile(path.join(cwd, ".codex-usage/usage.jsonl"), `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
}
const codex = path.join(fixture, ".codex/sessions");
await mkdir(codex, { recursive: true });
await writeFile(path.join(codex, "quota.jsonl"), [
  { timestamp: now.toISOString(), type: "session_meta", payload: { id: "qa-quota", source: "cli", originator: "codex-tui", cwd: fixture } },
  { timestamp: now.toISOString(), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }, rate_limits: { limit_id: "codex", primary: { used_percent: 42, window_minutes: 300, resets_at: Math.floor(now.getTime() / 1000) + 10_800 }, secondary: { used_percent: 20, window_minutes: 10_080, resets_at: Math.floor(now.getTime() / 1000) + 432_000 } } } },
].map(row => JSON.stringify(row)).join("\n"));
for (const [source, quantity] of [["cli",50],["exec",80]]) {
  const usage = {total_tokens:quantity,input_tokens:quantity-10,cached_input_tokens:0,output_tokens:10,reasoning_output_tokens:0};
  await writeFile(path.join(codex,`${source}-usage.jsonl`), [
    {timestamp:now.toISOString(),type:"session_meta",payload:{id:`qa-${source}`,source,cwd:fixture}},
    {timestamp:now.toISOString(),type:"event_msg",payload:{type:"token_count",info:{total_token_usage:usage,last_token_usage:usage}}}
  ].map(row=>JSON.stringify(row)).join("\n"));
}
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
  
}
function assertFits(value) { assert.ok(value.documentWidth <= value.width + 1 && value.bodyWidth <= value.width + 1, JSON.stringify(value)); }
async function matrix(page, prefix) {
  for (const width of [1440, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1100 });
    for (const theme of ["light", "dark"]) for (const locale of ["zh-CN", "en-US"]) {
      await choose(page, theme, locale);
      await page.evaluate(() => scrollTo(0, 0));
      const material = await page.evaluate(() => {
        const style = selector => getComputedStyle(document.querySelector(selector));
        const title = style('h1');
        const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        return { titleColor: title.color, titleSurface: title.backgroundColor, titleSize: title.fontSize, titleWeight: title.fontWeight, titleShadow: title.textShadow, frameShadow: title.boxShadow, actionShadow: style('.topbar-actions').boxShadow, wellShadow: style('.auto-refresh-well').boxShadow, rangeShadow: style('.range-controls').boxShadow, date: box('.date-range-controls'), well: box('.auto-refresh-well'), toggle: box('#autoRefreshToggle'), heading: box('.auto-refresh-label'), zone: box('#calendarZoneSelect') };
      });
      await check(`${prefix} ${width}px ${theme} ${locale} frames and inset`, async () => {
        assert.equal(material.titleColor, material.titleSurface);
        assert.ok(parseFloat(material.titleSize) >= 32 && Number(material.titleWeight) >= 800);
        assert.notEqual(material.frameShadow, 'none'); assert.notEqual(material.actionShadow, 'none');
        assert.ok(material.wellShadow.includes('inset'));
        assert.ok(material.toggle.x - material.heading.right < 12);
        if (width >= 1180) {
          const frames = await page.locator('.toolbar > .control-group').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
          assert.ok(frames.every(box => Math.abs(box.y - frames[0].y) < 1 && Math.abs(box.bottom - frames[0].bottom) < 1));
        }
      });
      const value = { ...await geometry(page), material };
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
  const { page } = await makePage('online');
  await load(page);
  await page.locator('[data-preset="all"]').click();
  await matrix(page, 'online');
  await page.setViewportSize({width:1440,height:1100});
  await choose(page,'light','zh-CN');
  await check('normal range merges product channels; Codex quota keeps raw channels', async () => {
    const labels = () => page.locator('#detailList .bar-name').allTextContents();
    assert.deepEqual((await labels()).sort(),['Codex','DSH','OpenCode','ZCode'].sort());
    await page.locator('#quotaPresetToggle').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#detailList .bar-name')].some(node=>node.textContent==='Codex Exec'));
    assert.deepEqual((await labels()).sort(),['CLI','Codex Exec'].sort());
    await page.locator('[data-preset="all"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#detailList .bar-name').length===4);
  });
  await check('Git stays first through descending, ascending and default UI sort', async () => {
    const title = () => page.locator('#repositoryComparisonTable tbody tr .comparison-row-label').first().getAttribute('title');
    assert.ok((await title()).startsWith('research-repository'));
    for(const period of ['today','week','month','all']) for(let step=0;step<3;step++) {
      await page.locator(`#repositoryComparisonTable [data-period="${period}"][data-comparison-sort]`).click();
      assert.ok((await title()).startsWith('research-repository'));
    }
  });
  await check('timezone keyboard, persistence, dismissal and focus', async () => {
    const control = page.locator('#calendarZoneSelect');
    await control.focus(); await page.keyboard.press('ArrowDown');
    assert.equal(await control.getAttribute('aria-expanded'),'true');
    await page.keyboard.press('End'); await page.keyboard.press('Enter');
    assert.equal(await control.getAttribute('aria-expanded'),'false');
    assert.equal(await page.evaluate(() => document.activeElement.id),'calendarZoneSelect');
    assert.equal(await page.evaluate(() => localStorage.getItem('codexUsageCalendarZoneV2')),'utc');
    await page.reload(); await ready(page);
    assert.equal(await page.locator('#calendarZoneValue').textContent(),'UTC+0');
    await control.click(); await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id),'calendarZoneSelect');
    await control.click(); await page.locator('h1').click();
    assert.equal(await control.getAttribute('aria-expanded'),'false');
    await control.click(); await page.locator('[data-calendar-zone="local"]').click();
    await control.click(); await page.keyboard.press('Tab');
    assert.equal(await control.getAttribute('aria-expanded'),'false');
    await control.click(); await screenshot(page,'timezone-menu',false); await page.keyboard.press('Escape');
  });
  await check('scan source entry replaces header import and main badge', async () => {
    assert.equal(await page.locator('#importButton').count(),0);
    const badges=await page.locator('#homes .home-kind, .homes-panel .home-kind').allTextContents();
    assert.ok(badges.length && !badges.includes('main') && badges.includes('codex'));
    await page.locator('#addImportButton').click();
    await page.locator('#importDialog').waitFor({state:'visible'});
    assert.ok(await page.locator('#sourcePicker input').count() > 0);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id),'addImportButton');
  });
  await check('pricing and timeline use identical recessed material', async () => {
    await page.locator('#updatePricingButton').click();
    await page.locator('#pricingDialog').waitFor({state:'visible'});
    await page.waitForFunction(() => document.querySelector('#pricingModelList')?.children.length > 0);
    const styles = await page.evaluate(() => ['#timelineModes','#pricingScope'].map(selector => {
      const s=getComputedStyle(document.querySelector(selector));return {shadow:s.boxShadow,background:s.backgroundColor,radius:s.borderRadius};
    }));
    assert.deepEqual(styles[0],styles[1]);assert.ok(styles[0].shadow.includes('inset'));
    const selected = await page.evaluate(() => ['#timelineModes button[aria-pressed="true"]','#pricingScope button[aria-pressed="true"]'].map(selector => { const s=getComputedStyle(document.querySelector(selector)); return {shadow:s.boxShadow,background:s.backgroundImage,color:s.color,border:s.borderColor,radius:s.borderRadius}; }));
    assert.deepEqual(selected[0],selected[1]);
    assert.ok(!(await page.locator('#pricingModelList').textContent()).includes('retired-model-fixture'));
    await page.locator('[data-pricing-scope="all"]').click();
    assert.equal(await page.locator('[data-pricing-scope="all"]').getAttribute('aria-pressed'),'true');
    await page.locator('#pricingSearch').fill('retired-model-fixture');
    assert.ok((await page.locator('#pricingModelList').textContent()).includes('retired-model-fixture'));
    await page.locator('#pricingSearch').fill('');
    await page.keyboard.press('Escape');
    for(const width of [1440,390]) for(const theme of ['light','dark']) for(const locale of ['zh-CN','en-US']) {
      await page.setViewportSize({width,height:width===390?844:1100});
      await choose(page,theme,locale);
      await page.locator('#updatePricingButton').click();
      await page.waitForFunction(() => document.querySelector('#pricingModelList')?.children.length > 0);
      await page.locator('[data-pricing-scope="all"]').click();
      const dimensions=await page.locator('#pricingScope > button').evaluateAll(nodes=>nodes.map(node=>({width:node.getBoundingClientRect().width,client:node.clientWidth,scroll:node.scrollWidth})));
      assert.ok(Math.abs(dimensions[0].width-dimensions[1].width)<1);
      assert.ok(dimensions.every(button=>button.scroll<=button.client+1));
      await screenshot(page,`pricing-${width}-${theme}-${locale}`,false);
      await page.keyboard.press('Escape');
    }
    await page.setViewportSize({width:1440,height:1100});await choose(page,'light','zh-CN');
    await page.locator('#updatePricingButton').click();
    await page.waitForFunction(() => document.querySelector('#pricingModelList')?.children.length > 0);
    await screenshot(page,'pricing-shared-well',false);
    await page.keyboard.press('Escape');
  });
  await check('refresh switch adjacent text and error wraps inside inset', async () => {
    await page.locator('#autoRefreshToggle').click();
    assert.equal(await page.locator('#autoRefreshToggle').getAttribute('aria-pressed'),'false');
    await page.setViewportSize({width:390,height:844});
    await page.clock.install();
    await page.route('**/api/status*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic refresh failure'})}));
    const loaded = page.waitForResponse(response => response.url().includes('/api/usage'));
    await page.locator('#autoRefreshToggle').click();
    await loaded; await settle(page);
    await page.clock.runFor(60_001);
    await page.waitForFunction(() => document.querySelector('#autoRefreshError').classList.contains('is-error')); 
    const bounds=await page.evaluate(() => {
      const well=document.querySelector('.auto-refresh-well').getBoundingClientRect();const error=document.querySelector('#autoRefreshError').getBoundingClientRect();
      return {fits:error.left>=well.left && error.right<=well.right && error.bottom<=well.bottom, text:document.querySelector('#autoRefreshError').textContent};
    });assert.ok(bounds.fits);await screenshot(page,'refresh-error-mobile',false);
    await page.unroute('**/api/status*');
    await page.locator('#autoRefreshToggle').click();
  });
  const report = await buildUsageReport(options);
  const file=path.join(fixture,'dashboard-fixture.html');
  await writeFile(file,renderStaticDashboardHtml({...report,generatedAt:now.toISOString(),asOf:now.toISOString()}));
  const {context:offlineContext,page:offline}=await makePage('offline');
  await offlineContext.setOffline(true);await load(offline,pathToFileURL(file).href);
  await offline.locator('[data-preset="all"]').click();
  await matrix(offline,'offline');
  await check('offline calendar recalculation and disabled mutation controls',async()=>{
    assert.equal(await offline.locator('#autoRefreshToggle').isDisabled(),true);
    assert.equal(await offline.locator('#addImportButton').isDisabled(),true);
    assert.equal(await offline.locator('#updatePricingButton').isDisabled(),true);
    assert.equal(await offline.locator('#importButton').count(),0);
    await offline.locator('#calendarZoneSelect').click();
    await offline.locator('[data-calendar-zone="utc"]').click();
    assert.equal(await offline.locator('#calendarZoneValue').textContent(),'UTC+0');
    await offline.locator('[data-preset="month"]').click();await settle(offline);
  });
  await check('no browser runtime errors or external requests',()=>{
    assert.deepEqual(results.pageErrors,[]);assert.deepEqual(results.externalRequests,[]);
  });
} finally {
  for(const context of sessions) await context.close();
  if(browser) await browser.close();
  await new Promise(resolve=>server.close(resolve));
  results.passed=results.checks.every(check=>check.passed);
  await writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2));
}
if(!results.passed) process.exitCode=1;
