import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createUsageServer } from "../../../src/server.js";
import { buildUsageReport } from "../../../src/usage-core.js";
import { assertSelfContainedStaticHtml, renderStaticDashboardHtml } from "../../../src/static-export.js";
import { SKINS } from "../../../public/skins.js";

const output = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(output, "../../..");
const baselineOnly = process.argv.includes("--baseline");
const fixture = await mkdtemp(path.join(os.tmpdir(), "frame-spotlight-"));
const now = new Date();
const importDirs = [];
for (const [index, name] of ["Alpha", "Beta", "Gamma"].entries()) {
  const directory = path.join(fixture, name);
  await mkdir(path.join(directory, ".codex-usage"), { recursive: true });
  importDirs.push(directory);
  const rows = [0, 1, 8, 40].map((days) => {
    const date = new Date(now); date.setDate(date.getDate() - days); date.setHours(10, 0, 0, 0);
    return { schema_version: "codex-usage.project-log.v1", timestamp: date.toISOString(), session_id: `${name}-${days}`, request_id: `${name}-${days}`, model: ["gpt-6.1-sol", "glm-5.3", "mimo-v2.6-flash-free"][index], cwd: directory, channel: ["Codex Desktop", "ZCode", "DSH"][index], usage: { total: 100000 * (index + 1), input: 80000 * (index + 1), cached: 40000 * (index + 1), output: 20000 * (index + 1), reasoning: 5000 } };
  });
  await writeFile(path.join(directory, ".codex-usage/usage.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n"));
}
const options = { homeDir: fixture, env: {}, importDirs, importStoreFile: path.join(fixture, "imports.json"), databaseFile: path.join(fixture, "usage.sqlite"), automaticDiscoveryEnabled: false, pricingFetcher: async () => { throw new Error("Isolated QA fixture: no upstream access"); } };
const server = createUsageServer(options);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const report = await buildUsageReport(options);
const snapshot = path.join(fixture, "dashboard.html");
const html = renderStaticDashboardHtml({ ...report, asOf: now.toISOString() });
assertSelfContainedStaticHtml(html);
await writeFile(snapshot, html);
const { chromium } = await import(pathToFileURL(path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs")));
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
const results = { checks: [], states: [], errors: [], externalRequests: [], fixture: "Synthetic project logs in a separate temporary home; no user data", snapshotBytes: Buffer.byteLength(html) };
const baseline = baselineOnly ? {} : JSON.parse(await readFile(path.join(output, "before-layout.json"), "utf8"));
const contexts = [];

async function tick(page) { await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function open({ offline = false, width = 2290, theme = "light", locale = "zh-CN", touch = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1100 }, locale, timezoneId: "Asia/Shanghai", reducedMotion: "reduce", hasTouch: touch, isMobile: touch });
  contexts.push(context);
  await context.addInitScript(({ theme, locale }) => {
    localStorage.setItem("codexUsageTheme", theme);
    localStorage.setItem("codexUsageLocale", locale);
    localStorage.setItem("codexUsageAutoRefresh", "off");
    localStorage.setItem("codexUsageSkinV1", JSON.stringify({ skinId: "classic", opacity: 50, showCharacters: true }));
    const actualMatchMedia = window.matchMedia.bind(window);
    const native = actualMatchMedia("(hover: hover) and (pointer: fine)");
    let override;
    const handlers = new Set();
    window.matchMedia = (query) => query !== native.media ? actualMatchMedia(query) : {
      get matches() { return override ?? native.matches; }, media: native.media,
      addEventListener: (_name, handler) => handlers.add(handler),
      removeEventListener: (_name, handler) => handlers.delete(handler),
    };
    window.__spotlightCapability = (next) => { override = next; for (const handler of handlers) handler({ matches: next, media: native.media }); };
    window.__spotlightPaintTimes = [];
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => raf((time) => {
      const start = performance.now(); callback(time);
      if (callback.name === "paint") window.__spotlightPaintTimes.push(performance.now() - start);
    });
  }, { theme, locale });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "file:") return route.continue();
    if (offline || url.origin !== base) { results.externalRequests.push(url.href); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => results.errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto(offline ? pathToFileURL(snapshot).href : base);
  await page.waitForFunction(() => window.__skinTestHook && document.querySelector("#modelComparisonTable table"));
  await page.locator('[data-preset="all"]').click();
  await tick(page);
  await page.mouse.move(0, 0);
  return { context, page };
}
async function geometry(page) {
  return page.evaluate(() => [...document.querySelectorAll(".shell,.topbar,.toolbar,.toolbar>.control-group,.metrics,.metric,.panel,.comparison-item,.theme-toggle,.panel-action,#presetButtons,.segmented-well,.date-range-button,.auto-refresh-well,.timeline-chart-well,.bar-track,.comparison-table-frame,.home-list,.cost-estimate-note,input[type=search]")].map((node) => {
    const box = node.getBoundingClientRect(), css = getComputedStyle(node);
    return { node: node.id || node.className, x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height, background: css.background, shadow: css.boxShadow, radius: css.borderRadius, overflow: css.overflow };
  }));
}
async function check(name, action) {
  await action(); results.checks.push(name); console.log(`PASS ${name}`);
}
async function hover(page, selector, { surface = false, dx, dy } = {}) {
  const locator = page.locator(selector).first();
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  const x = box.x + (dx ?? box.width / 2), y = box.y + (dy ?? (surface ? 6 : box.height / 2));
  await page.mouse.move(x, y); await tick(page);
  return { x, y, box };
}
async function active(page) {
  return page.evaluate(() => [...document.querySelectorAll("[data-spotlight-active]")].map((node) => {
    const css = getComputedStyle(node, "::after"), box = node.getBoundingClientRect();
    return { name: node.id || node.className, x: parseFloat(node.style.getPropertyValue("--spotlight-x")), y: parseFloat(node.style.getPropertyValue("--spotlight-y")), box: box.toJSON(), background: css.backgroundImage, mask: css.maskImage, transition: css.transitionDuration, overflow: getComputedStyle(node).overflow, isolation: getComputedStyle(node).isolation, position: getComputedStyle(node).position, pointerEvents: css.pointerEvents, z: css.zIndex };
  }));
}
async function assertActive(page, selector, point) {
  assert.equal(await page.locator("[data-spotlight-active]").count(), 1, `${selector} should own one light; point ${JSON.stringify(point)}`);
  assert.equal(await page.locator(selector).first().getAttribute("data-spotlight-active"), "");
  const [state] = await active(page);
  const border = await page.locator(selector).first().evaluate((node) => ({ left: parseFloat(getComputedStyle(node).borderLeftWidth), top: parseFloat(getComputedStyle(node).borderTopWidth) }));
  if (point) {
    assert.ok(Math.abs(state.x - (point.x - state.box.left - border.left)) < 1);
    assert.ok(Math.abs(state.y - (point.y - state.box.top - border.top)) < 1);
  }
  assert.equal(state.pointerEvents, "none"); assert.equal(state.z, "-1");
  assert.ok(state.background.startsWith("radial-gradient")); assert.ok(state.mask.includes("data:image/svg+xml"));
  return state;
}
async function roi(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  const radius = await page.locator(selector).first().evaluate((node) => parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0);
  return { x: Math.ceil(box.x + Math.min(radius + 4, box.width / 4)), y: Math.floor(box.y + box.height / 2 - 1), width: Math.max(1, Math.floor(box.width - 2 * Math.min(radius + 4, box.width / 4))), height: 2 };
}
async function behavior(page, prefix) {
  await page.setViewportSize({ width: 2290, height: 1100 });
  await page.evaluate(() => { if (document.documentElement.dataset.theme !== "dark") document.getElementById("themeToggle").click(); if (document.documentElement.lang !== "zh-CN") document.getElementById("languageToggle").click(); window.__skinTestHook.resetToClassic(); });
  await page.locator('[data-preset="week"]').click();
  await tick(page);
  await check(`${prefix}: all main outer surfaces, not just metrics`, async () => {
    const selectors = [".topbar", ...Array.from({ length: 3 }, (_, i) => `.toolbar>.control-group:nth-child(${i + 1})`), ...Array.from({ length: 12 }, (_, i) => `.metric >> nth=${i}`), ...Array.from({ length: 3 }, (_, i) => `.comparison-item >> nth=${i}`), ...Array.from({ length: 6 }, (_, i) => `.panel >> nth=${i}`)];
    for (const selector of selectors) {
      await page.mouse.move(0, 0); await tick(page); const before = (await geometry(page)).filter((row) => row.width || row.height);
      const point = await hover(page, selector, { surface: true });
      const state = await assertActive(page, selector, point);
      assert.deepEqual((await geometry(page)).filter((row) => row.width || row.height), before, "activation changes layout or original materials");
      results.states.push({ prefix, selector, ...state });
    }
    const names = await page.evaluate(() => [...document.querySelectorAll(".topbar-actions,.toolbar,.topbar>h1,.main-grid")].map((node) => ({ name: node.className, active: node.hasAttribute("data-spotlight-active") })));
    assert.ok(names.every((node) => !node.active));
  });
  await check(`${prefix}: nearest raised child and actual raised selection`, async () => {
    for (const selector of ["#skinToggle", "#languageToggle", "#themeToggle", '[data-preset="week"]', '#timelineModes [aria-pressed="true"]']) {
      const point = await hover(page, selector); await assertActive(page, selector, point);
    }
    const point = await hover(page, ".topbar", { surface: true }); await assertActive(page, ".topbar", point);
    const svg = await page.locator(".topbar").evaluate((node) => decodeURIComponent(node.style.getPropertyValue("--spotlight-mask")));
    assert.equal((svg.match(/rx=/g) || []).length, 3, "topbar light must cut out all three child buttons");
    const enabled = await page.locator(".shell .panel-action:not(:disabled),.shell .home-remove:not(:disabled)").count();
    for (let i = 0; i < enabled; i++) {
      const selector = `.shell .panel-action:not(:disabled),.shell .home-remove:not(:disabled) >> nth=${i}`;
      const point = await hover(page, selector); await assertActive(page, selector, point);
    }
  });
  await check(`${prefix}: every recess clears the previous light`, async () => {
    const selectors = [".metric strong", ".comparison-item:not(.comparison-unavailable)>strong", ".timeline-chart-well", ".bar-track", ".comparison-table-frame", ".home-list", ".cost-estimate-note", ".auto-refresh-well", ".date-range-button", "#modelComparisonSearch", "#repositoryComparisonSearch", ".recent-combobox", '#presetButtons>[data-preset="today"]', '#timelineModes>[aria-pressed="false"]'];
    for (const selector of selectors) {
      await hover(page, ".topbar", { surface: true });
      await hover(page, selector);
      assert.equal(await page.locator("[data-spotlight-active]").count(), 0, selector);
    }
  });
  await check(`${prefix}: existing well interiors are pixel-identical under parent light`, async () => {
    for (const [host, well] of [[".metric", ".metric strong"], [".chart-panel", ".timeline-chart-well"], [".detail-panel", ".bar-track"], [".homes-panel", ".home-list"], [".pricing-note-panel", ".cost-estimate-note"], [".period-comparison-panel", ".comparison-table-frame"], [".period-comparison-panel", "#modelComparisonSearch"], [".auto-refresh-status", ".auto-refresh-well"]]) {
      await page.locator(host).first().scrollIntoViewIfNeeded(); await page.mouse.move(0, 0); await tick(page);
      const clip = await roi(page, well), before = await page.screenshot({ clip });
      await hover(page, host, { surface: true }); await assertActive(page, host);
      assert.deepEqual(await page.screenshot({ clip }), before, `${host}/${well} pixels changed`);
    }
  });
  await check(`${prefix}: transparent and overlapping recesses really cut out parent light`, async () => {
    await page.evaluate(() => {
      const panel = document.createElement("section"); panel.className = "panel"; panel.id = "spotlightFixture";
      panel.style.cssText = "position:relative;width:500px;height:250px;margin:30px;";
      panel.innerHTML = '<div id="spotTransparentA" class="bar-track" style="position:absolute;left:30px;top:40px;width:210px;height:60px;background:transparent;box-shadow:none;border-radius:12px"></div><div id="spotTransparentB" class="bar-track" style="position:absolute;left:130px;top:60px;width:210px;height:60px;background:transparent;box-shadow:none;border-radius:12px"></div><span id="spotSolidText" style="position:absolute;left:25px;top:150px;color:white;font-size:32px;font-weight:900">READABLE 0123</span>';
      document.querySelector(".shell").append(panel);
    });
    await page.locator("#spotlightFixture").scrollIntoViewIfNeeded(); await page.mouse.move(0, 0); await tick(page);
    const clips = [await roi(page, "#spotTransparentA"), await roi(page, "#spotTransparentB")];
    const before = await Promise.all(clips.map((clip) => page.screenshot({ clip })));
    const box = await page.locator("#spotlightFixture").boundingBox();
    const litClip = { x: Math.floor(box.x + 100), y: Math.floor(box.y + 150), width: 120, height: 30 };
    const base = await page.screenshot({ clip: litClip });
    await page.locator("#spotSolidText").screenshot({ path: path.join(output, `${prefix}-text-before.png`) });
    await hover(page, "#spotlightFixture", { dx: 110, dy: 160 }); await assertActive(page, "#spotlightFixture");
    for (const [index, clip] of clips.entries()) assert.deepEqual(await page.screenshot({ clip }), before[index], "transparent or overlap cutout leaked");
    assert.notDeepEqual(await page.screenshot({ clip: litClip }), base, "raised surface must visibly light");
    await page.locator("#spotSolidText").screenshot({ path: path.join(output, `${prefix}-text-after.png`) });
    await page.screenshot({ path: path.join(output, `${prefix}-transparent-mask.png`), clip: box });
    await page.evaluate(() => document.getElementById("spotlightFixture").remove()); await tick(page);
    assert.equal(await page.locator("#spotlightFixture[data-spotlight-active]").count(), 0);
  });
  await check(`${prefix}: menus remain above frames and inset choices stay dark`, async () => {
    await page.locator("#recentMenuButton").click(); await tick(page);
    for (const selector of [".range-controls", "#recentRangeMenu", '#recentRangeMenu>[aria-selected="false"]:not(:disabled)']) {
      const point = await hover(page, selector, { surface: selector !== '#recentRangeMenu>[aria-selected="false"]:not(:disabled)', ...(selector === "#recentRangeMenu" ? { dy: 2 } : {}) });
      await assertActive(page, selector, point);
      const menu = await page.locator("#recentRangeMenu").boundingBox();
      const hit = await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest("#recentRangeMenu")), { x: menu.x + menu.width / 2, y: menu.y + menu.height / 2 });
      assert.ok(hit, "menu clipped or trapped behind later panels");
    }
    await hover(page, '#recentRangeMenu>[aria-selected="true"]'); assert.equal(await page.locator("[data-spotlight-active]").count(), 0);
    await page.locator("#recentMenuButton").click();
    await page.locator("#calendarZoneSelect").click(); await tick(page);
    await hover(page, "#calendarZoneMenu", { dy: 2 }); await assertActive(page, "#calendarZoneMenu");
    await page.locator('[data-calendar-zone="utc"]').click(); await tick(page); assert.equal(await page.locator("#calendarZoneValue").textContent(), "UTC+0");
    await page.locator("#calendarZoneSelect").click(); await page.locator('[data-calendar-zone="local"]').click(); await tick(page);
    await page.locator("#dateRangeButton").click(); await tick(page);
    for (const selector of [".date-range-controls", "#dateRangePicker", ".date-picker-nav", ".date-picker-day:not(.selected)"]) {
      const point = await hover(page, selector, { surface: [".date-range-controls", "#dateRangePicker"].includes(selector) });
      await assertActive(page, selector, point);
    }
    await page.locator('[data-date-picker-action="next"]').click(); await tick(page);
    assert.ok(await page.locator(".date-picker-day").count() === 42);
    await page.screenshot({ path: path.join(output, `${prefix}-calendar.png`), fullPage: true });
    await page.keyboard.press("Escape");
  });
  await check(`${prefix}: search, expansion and tooltip interaction`, async () => {
    await page.locator("#modelComparisonSearch").fill("gpt"); await tick(page);
    assert.equal(await page.locator("#modelComparisonTable tbody th").count(), 1);
    await page.locator("#modelComparisonSearch").fill("no-such-model-fixture"); await tick(page);
    assert.equal(await page.locator("#modelComparisonTable .empty").count(), 1);
    await hover(page, ".period-comparison-panel", { surface: true }); await assertActive(page, ".period-comparison-panel");
    await page.locator("#modelComparisonSearch").fill(""); await tick(page);
    await page.locator("#modelComparisonTable [data-period-expand]").first().click(); await tick(page);
    assert.ok(await page.locator(".comparison-detail-row").count() > 0);
    await hover(page, ".bar-row");
    assert.ok(await page.locator("#usageTooltip").isVisible());
    assert.equal(await page.locator("#usageTooltip[data-spotlight-active]").count(), 0);
  });
  await check(`${prefix}: internal scrollers clip holes and update stationary pointer coordinates`, async () => {
    await page.evaluate(() => {
      const panel = document.createElement("section"); panel.className = "panel"; panel.id = "spotScrollFixture"; panel.style.cssText = "position:relative;width:500px;height:260px;margin:30px";
      panel.innerHTML = '<div id="spotScrollPort" style="position:absolute;left:20px;top:80px;width:300px;height:90px;overflow:auto"><article id="spotScrollCard" class="metric" style="height:100px"><span>Nested frame</span><strong>100</strong></article><div class="bar-track" style="height:30px;margin-top:30px"></div><div style="height:200px"></div></div>';
      document.querySelector(".shell").append(panel);
    });
    await hover(page, "#spotScrollCard", { surface: true }); const initial = await assertActive(page, "#spotScrollCard");
    await page.evaluate(() => document.getElementById("spotScrollPort").scrollTop = 15); await tick(page);
    const moved = await assertActive(page, "#spotScrollCard"); assert.ok(Math.abs(moved.y - initial.y - 15) < 1);
    await hover(page, "#spotScrollFixture", { surface: true }); await assertActive(page, "#spotScrollFixture");
    await page.evaluate(() => document.getElementById("spotScrollPort").scrollTop = 160); await tick(page); await assertActive(page, "#spotScrollFixture");
    const bounds = await page.locator("#spotScrollPort").boundingBox();
    const mask = await page.locator("#spotScrollFixture").evaluate((node) => decodeURIComponent(node.style.getPropertyValue("--spotlight-mask")));
    const host = await page.locator("#spotScrollFixture").boundingBox();
    const visible = [...mask.matchAll(/<clipPath[^>]+><rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/g)].map((match) => match.slice(1).map(Number));
    for (const [, y, , height] of visible) assert.ok(y >= bounds.y - host.y - 1 && y + height <= bounds.y - host.y + bounds.height + 1, "offscreen hole leaked into heading");
    await page.evaluate(() => document.getElementById("spotScrollFixture").remove()); await tick(page);
  });
  await check(`${prefix}: templates rebuild under stationary cursor`, async () => {
    await hover(page, ".comparison-item", { surface: true });
    await page.evaluate(() => { window.__oldSpotlight = document.querySelector("[data-spotlight-active]"); document.getElementById("themeToggle").click(); });
    await tick(page); await assertActive(page, ".comparison-item");
    assert.equal(await page.evaluate(() => window.__oldSpotlight.isConnected), false);
    assert.equal(await page.evaluate(() => window.__oldSpotlight.hasAttribute("data-spotlight-active")), false);
  });
  await check(`${prefix}: real colours, classic fallback, both motion modes`, async () => {
    for (const theme of ["light", "dark"]) for (const skin of SKINS) {
      await page.evaluate(({ theme, skin }) => { if (document.documentElement.dataset.theme !== theme) document.getElementById("themeToggle").click(); window.__skinTestHook.selectSkin(skin); }, { theme, skin: skin.id });
      await tick(page); const point = await hover(page, ".topbar", { surface: true });
      const state = await assertActive(page, ".topbar", point);
      const expected = await page.evaluate(() => {
        const host = document.querySelector("[data-spotlight-active]"), css = getComputedStyle(host), probe = document.createElement("span");
        probe.style.background = `radial-gradient(circle ${host.style.getPropertyValue("--spotlight-radius")} at ${host.style.getPropertyValue("--spotlight-x")} ${host.style.getPropertyValue("--spotlight-y")}, color-mix(in srgb, ${css.getPropertyValue("--skin-active-accent").trim() || css.getPropertyValue("--blue").trim()} 22%, transparent), transparent 100%)`;
        document.body.append(probe); const value = getComputedStyle(probe).backgroundImage; probe.remove(); return value;
      });
      assert.equal(state.background, expected); assert.equal(state.transition, "0s");
      results.states.push({ prefix, skin: skin.id, theme, background: state.background });
    }
    const previous = (await active(page))[0];
    await page.evaluate(() => {
      const style = document.documentElement.style;
      window.__spotlightAccent = { value: style.getPropertyValue("--skin-active-accent"), priority: style.getPropertyPriority("--skin-active-accent") };
      style.setProperty("--skin-active-accent", "#ff0022");
    });
    await tick(page);
    const changed = (await active(page))[0];
    assert.notEqual(changed.background, previous.background, "accent fixture must recolour the stationary light");
    assert.equal(changed.x, previous.x); assert.equal(changed.y, previous.y);
    await page.evaluate(() => { const style = document.documentElement.style, saved = window.__spotlightAccent; if (saved.value) style.setProperty("--skin-active-accent", saved.value, saved.priority); else style.removeProperty("--skin-active-accent"); });
    await page.emulateMedia({ reducedMotion: "no-preference" }); await hover(page, ".topbar", { surface: true });
    assert.equal((await active(page))[0].transition, "0.12s");
    await page.emulateMedia({ reducedMotion: "reduce" }); await page.evaluate(() => window.__skinTestHook.resetToClassic());
  });
  await check(`${prefix}: scroll, resize, rapid movement and idle cleanup`, async () => {
    for (const width of [2290, 1900, 1600, 1440, 1024, 721, 390, 2290]) {
      await page.setViewportSize({ width, height: 1100 }); await tick(page);
      const point = await hover(page, ".topbar", { surface: true }); await assertActive(page, ".topbar", point);
      await page.evaluate(() => scrollBy(0, 35)); await tick(page);
      const states = await active(page);
      if (states.length) assert.ok(states[0].y >= -1 && states[0].y <= states[0].box.height + 1);
    }
    await page.evaluate(() => { window.__spotlightWrites = 0; window.__spotlightObserver = new MutationObserver((records) => { window.__spotlightWrites += records.length; }); window.__spotlightObserver.observe(document.querySelector(".shell"), { attributes: true, subtree: true, attributeFilter: ["style"] }); });
    const started = performance.now();
    for (let i = 0; i < 60; i++) { await page.mouse.move(600 + (i % 20) * 15, 45); }
    await tick(page);
    const durationMs = performance.now() - started;
    const writes = await page.evaluate(() => window.__spotlightWrites);
    await page.waitForTimeout(180);
    assert.equal(await page.evaluate(() => window.__spotlightWrites), writes, "idle pointer causes endless observer/RAF work");
    results.states.push({ prefix, rapidMoves: 60, durationMs, styleMutations: writes });
    await page.locator(".topbar").dispatchEvent("pointercancel", { pointerType: "mouse" }); await tick(page); assert.equal(await page.locator("[data-spotlight-active]").count(), 0);
    await hover(page, ".topbar", { surface: true }); await page.mouse.move(0, 0); await tick(page); assert.equal(await page.locator("[data-spotlight-active]").count(), 0);
    await hover(page, ".topbar", { surface: true }); await page.locator(".topbar").dispatchEvent("pointermove", { pointerType: "touch", clientX: 600, clientY: 45 }); await tick(page); assert.equal(await page.locator("[data-spotlight-active]").count(), 0);
    const point = await hover(page, ".topbar", { surface: true }); await assertActive(page, ".topbar", point);
    await page.evaluate(() => window.dispatchEvent(new Event("blur"))); await tick(page); assert.equal(await page.locator("[data-spotlight-active]").count(), 0);
    await page.evaluate(() => window.__spotlightObserver.disconnect());
    await page.locator('[data-preset="all"]').click(); await tick(page);
    assert.equal(await page.locator(".comparison-unavailable").count(), 1); await hover(page, ".comparison-unavailable", { surface: true }); await assertActive(page, ".comparison-unavailable");
    await page.locator('[data-preset="week"]').click();
    const samples = await page.evaluate(() => window.__spotlightPaintTimes);
    const sorted = [...samples].sort((a, b) => a - b);
    results.states.push({ prefix, paintSamples: samples.length, medianPaintMs: sorted[Math.floor(sorted.length / 2)], p95PaintMs: sorted[Math.floor(sorted.length * .95)], maxPaintMs: sorted.at(-1) });
    assert.ok(sorted[Math.floor(sorted.length * .95)] < 16, "lighting's p95 CPU work exceeds one 60Hz frame");
  });
  await check(`${prefix}: capability changes, visibility and state changes clear light`, async () => {
    await hover(page, ".topbar", { surface: true }); await assertActive(page, ".topbar");
    await page.evaluate(() => window.__spotlightCapability(false)); await tick(page); assert.equal(await page.locator("[data-spotlight-active]").count(), 0);
    await hover(page, ".topbar", { surface: true }); assert.equal(await page.locator("[data-spotlight-active]").count(), 0);
    await page.evaluate(() => window.__spotlightCapability(true)); await tick(page); assert.equal(await page.locator("[data-spotlight-active]").count(), 0);
    await hover(page, ".topbar", { surface: true }); await assertActive(page, ".topbar");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); await tick(page); assert.equal(await page.locator("[data-spotlight-active]").count(), 0);
    await hover(page, ".topbar", { surface: true });
    await page.evaluate(() => document.querySelector(".topbar").style.visibility = "hidden"); await tick(page); assert.equal(await page.locator("[data-spotlight-active]").count(), 0);
    await page.evaluate(() => document.querySelector(".topbar").style.removeProperty("visibility"));
    await hover(page, '[data-preset="week"]'); await assertActive(page, '[data-preset="week"]');
    await page.evaluate(() => document.querySelector('[data-preset="today"]').click()); await tick(page);
    assert.equal(await page.locator('[data-preset="week"][data-spotlight-active]').count(), 0);
    await page.locator('[data-preset="week"]').click();
  });
  await check(`${prefix}: independent skin dialog is unchanged`, async () => {
    await page.locator("#skinToggle").click(); await tick(page);
    assert.equal(await page.locator("[data-spotlight-active]").count(), 0, "opening a dialog clears the main light without a pointer move");
    await hover(page, ".skin-card"); assert.equal(await page.locator("[data-spotlight-active]").count(), 0);
    assert.equal(await page.locator(".skin-card").count(), 10);
    await page.keyboard.press("Escape");
    for (const id of ["importDialog", "pricingDialog"]) {
      await hover(page, ".topbar", { surface: true }); await assertActive(page, ".topbar");
      await page.evaluate((id) => document.getElementById(id).hidden = false, id); await tick(page);
      assert.equal(await page.locator("[data-spotlight-active]").count(), 0);
      await page.evaluate((id) => document.getElementById(id).hidden = true, id); await tick(page);
    }
  });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => { if (document.documentElement.dataset.theme !== theme) document.getElementById("themeToggle").click(); window.__skinTestHook.selectSkin("chatgpt"); }, theme);
    await hover(page, ".topbar", { surface: true });
    await page.screenshot({ path: path.join(output, `${prefix}-spotlight-title-${theme}.png`), fullPage: true });
    await hover(page, ".chart-panel", { surface: true });
    await page.screenshot({ path: path.join(output, `${prefix}-spotlight-panel-${theme}.png`), fullPage: true });
  }
}
async function hashProtected() {
  const hashes = {};
  async function walk(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await walk(file);
      else hashes[path.relative(root, file).replaceAll("\\", "/")] = createHash("sha256").update(await readFile(file)).digest("hex");
    }
  }
  for (const directory of ["public", "lineart assets"]) await walk(path.join(root, directory));
  return hashes;
}

try {
  for (const offline of [false, true]) {
    const { page, context } = await open({ offline });
    for (const width of [2290, 1440, 1024, 390]) for (const theme of ["light", "dark"]) for (const locale of ["zh-CN", "en-US"]) {
      await page.setViewportSize({ width, height: 1100 });
      await page.evaluate(({ theme, locale }) => {
        if (document.documentElement.dataset.theme !== theme) document.getElementById("themeToggle").click();
        if (document.documentElement.lang !== locale) document.getElementById("languageToggle").click();
      }, { theme, locale });
      await page.mouse.move(0, 0); await tick(page);
      const key = `${offline ? "offline" : "online"}-${width}-${theme}-${locale}`;
      const layout = await geometry(page);
      if (baselineOnly) baseline[key] = layout;
      else await check(`${key}: original geometry and materials`, () => assert.deepEqual(layout, baseline[key]));
      if (width === 2290 && locale === "zh-CN") await page.screenshot({ path: path.join(output, `${baselineOnly ? "before" : "after"}-${offline ? "offline" : "online"}-${theme}.png`), fullPage: true });
    }
    if (!baselineOnly) await behavior(page, offline ? "offline" : "online");
    await context.close();
  }
  if (baselineOnly) {
    await writeFile(path.join(output, "before-layout.json"), JSON.stringify(baseline, null, 2));
    await writeFile(path.join(output, "before-hashes.json"), JSON.stringify(await hashProtected(), null, 2));
  } else {
    for (const offline of [false, true]) {
      const { page, context } = await open({ offline, width: 390, touch: true });
      await check(`${offline ? "offline" : "online"}: actual coarse touch device never lights`, async () => {
        assert.equal(await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches), false);
        await page.touchscreen.tap(195, 45); await tick(page); assert.equal(await page.locator("[data-spotlight-active]").count(), 0);
        await page.locator(".topbar").dispatchEvent("pointermove", { pointerType: "touch", clientX: 195, clientY: 45 }); await page.evaluate(() => scrollBy(0, 200)); await tick(page);
        assert.equal(await page.locator("[data-spotlight-active]").count(), 0);
      });
      await context.close();
    }
    const { page, context } = await open();
    await check("ResizeObserver-unavailable fallback remains functional", async () => {
      await page.addInitScript(() => window.ResizeObserver = undefined); await page.reload(); await page.waitForFunction(() => window.__skinTestHook);
      const point = await hover(page, ".topbar", { surface: true }); await assertActive(page, ".topbar", point);
      await page.setViewportSize({ width: 1600, height: 1100 }); await tick(page); const next = await hover(page, ".topbar", { surface: true }); await assertActive(page, ".topbar", next);
    });
    await context.close();
    const before = JSON.parse(await readFile(path.join(output, "before-hashes.json"), "utf8"));
    const after = await hashProtected();
    results.changedProtectedFiles = Object.keys(before).filter((file) => before[file] !== after[file]);
    assert.deepEqual(results.changedProtectedFiles.sort(), ["public/app.js", "public/styles.css"]);
    results.unchangedProtectedFiles = Object.keys(before).length - results.changedProtectedFiles.length;
  }
  assert.deepEqual(results.errors, []);
  assert.deepEqual(results.externalRequests, []);
} finally {
  await browser.close(); await new Promise((resolve) => server.close(resolve));
  if (!baselineOnly) await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2));
  await unlink(snapshot);
}
