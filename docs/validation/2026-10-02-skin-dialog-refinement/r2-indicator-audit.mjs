// R2: actual browser states, isolated palette fixtures, pre-app paint and offline UI.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderStaticDashboardHtml } from "../../../src/static-export.js";

const output = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(output, "../../..");
const fixture = { generatedAt: "2026-10-02T00:00:00.000Z", asOf: "2026-10-02T00:00:00.000Z", events: [], homes: [], sessions: [], warnings: [], rateLimitObservations: [] };
const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".webp": "image/webp" };
const server = createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  const file = path.resolve(root, "public", `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(`${path.join(root, "public")}${path.sep}`)) return response.writeHead(404).end();
  try { response.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" }); response.end(readFileSync(file)); }
  catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const playwrightPath = process.env.AGENT_USAGE_PLAYWRIGHT_MODULE || path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const { chromium } = await import(pathToFileURL(playwrightPath).href);
const browser = await chromium.launch({ executablePath: process.env.AGENT_USAGE_EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
const results = { checks: [], states: [], errors: [], externalOfflineRequests: [] };
const tempDir = mkdtempSync(path.join(os.tmpdir(), "skin-r2-"));
const snapshot = path.join(tempDir, "indicator.html");
const baseline = JSON.parse(readFileSync(path.join(output, "r1-results.json"), "utf8"));

async function contextFor(theme, custom = false, restored = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
  await context.addInitScript(({ theme, restored }) => {
    // Do not overwrite later persisted changes on reload.
    if (!localStorage.getItem("codexUsageTheme")) localStorage.setItem("codexUsageTheme", theme);
    localStorage.setItem("codexUsageLocale", "zh-CN");
    if (restored && !localStorage.getItem("codexUsageSkinV1")) localStorage.setItem("codexUsageSkinV1", JSON.stringify({ version: 1, skinId: "chatgpt", showCharacters: false, opacity: 0 }));
  }, { theme, restored });
  await context.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) }));
  if (custom) await context.route("**/skin-palettes.js", (route) => route.fulfill({ contentType: "text/javascript", body: 'export const SKIN_PALETTES = {chatgpt:{light:{accent:"#a658ff"},dark:{accent:"#f79c43"}}};' }));
  return context;
}

async function inspect(page, label, active, expectedAccent = null, compareGeometry = true) {
  const state = await page.evaluate(() => {
    const style = (selector) => getComputedStyle(document.querySelector(selector));
    const bounds = (node) => { const b = node.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
    return {
      skin: document.documentElement.dataset.skin, theme: document.documentElement.dataset.theme,
      stroke: style(".skin-icon-accent").stroke, filter: style(".skin-icon-accent").filter,
      outline: style(".skin-icon-outline").stroke, outlineFilter: style(".skin-icon-outline").filter,
      svgFilter: style("#skinToggle svg").filter,
      neutral: style(".language-divider").color,
      selected: style(document.documentElement.dataset.theme === "dark" ? "#themeToggle .theme-moon" : "#themeToggle .theme-sun").stroke,
      neighbourFilter: style(document.documentElement.dataset.theme === "dark" ? "#themeToggle .theme-moon" : "#themeToggle .theme-sun").filter,
      expanded: document.querySelector("#skinToggle").getAttribute("aria-expanded"),
      accentOverride: document.documentElement.style.getPropertyValue("--skin-active-accent"),
      geometry: [...document.querySelectorAll(".shell, .topbar, .topbar-actions, .toolbar, .metrics, .main-grid, .bottom-grid, .panel, .metric, .comparison-strip")].map((node) => ({ className: node.className, ...bounds(node) })),
    };
  });
  assert.equal(state.outline, state.neutral, `${label}: outline neutral`);
  assert.equal(state.outlineFilter, "none", `${label}: outline has no glow`);
  assert.equal(state.svgFilter, "none", `${label}: SVG has no whole-icon glow`);
  assert.equal(state.stroke, active ? expectedAccent || state.selected : state.neutral, `${label}: correct bar colour`);
  if (active) {
    assert.notEqual(state.filter, "none", `${label}: active bar glows`);
    assert.ok(state.filter.includes("3px"), `${label}: existing glow radius`);
    if (!expectedAccent) assert.equal(state.filter, state.neighbourFilter, `${label}: same glow as neighbouring button`);
  } else assert.equal(state.filter, "none", `${label}: classic bar unlit`);
  if (compareGeometry) assert.deepEqual(state.geometry, baseline.observations[`${state.theme}/zh-CN/1440`].geometry, `${label}: dashboard geometry unchanged`);
  results.states.push({ label, ...state });
  return state;
}

try {
  for (const theme of ["light", "dark"]) {
    const context = await contextFor(theme);
    const page = await context.newPage();
    page.on("pageerror", (error) => results.errors.push(error.message));
    await page.goto(url); await page.waitForFunction(() => window.__skinTestHook); await page.evaluate(() => document.fonts.ready);
    await inspect(page, `${theme}: classic closed`, false);
    await page.locator("#skinToggle").click(); await inspect(page, `${theme}: classic open/focused`, false);
    await page.evaluate(() => window.__skinTestHook.closePicker());
    const ids = await page.evaluate(() => window.__skinTestHook.getSelectableSkins().filter((id) => id !== "classic"));
    assert.equal(ids.length, 10);
    for (const id of ids) {
      await page.evaluate((id) => { window.__skinTestHook.setShowCharacters(true); window.__skinTestHook.setOpacity(0.5); window.__skinTestHook.selectSkin(id); }, id);
      await inspect(page, `${theme}/${id}: selected closed`, true);
      await page.locator("#skinToggle").click(); await inspect(page, `${theme}/${id}: selected open`, true);
      await page.evaluate(() => window.__skinTestHook.closePicker());
      await page.evaluate(() => window.__skinTestHook.setShowCharacters(false)); await inspect(page, `${theme}/${id}: hidden`, true);
      await page.evaluate(() => { window.__skinTestHook.setShowCharacters(true); window.__skinTestHook.setOpacity(0); }); await inspect(page, `${theme}/${id}: opacity 0`, true);
    }
    await page.reload(); await page.waitForFunction(() => window.__skinTestHook); await inspect(page, `${theme}: refresh restored`, true);
    await page.locator(".topbar").screenshot({ path: path.join(output, `r2-active-${theme}.png`) });
    await page.evaluate(() => window.__skinTestHook.resetToClassic()); await inspect(page, `${theme}: reset classic`, false);
    await page.locator("#skinToggle").hover(); await inspect(page, `${theme}: classic hovered`, false);
    await page.locator(".topbar").screenshot({ path: path.join(output, `r2-classic-${theme}.png`) });
    await context.close();
  }
  results.checks.push("all ten skins in both modes: closed/open, hidden, zero opacity, refresh, classic and hover; geometry preserved");

  const custom = await contextFor("light", true);
  const customPage = await custom.newPage(); customPage.on("pageerror", (error) => results.errors.push(error.message));
  await customPage.goto(url); await customPage.waitForFunction(() => window.__skinTestHook);
  await customPage.evaluate(() => window.__skinTestHook.selectSkin("chatgpt")); await inspect(customPage, "fixture: light accent", true, "rgb(166, 88, 255)");
  await customPage.locator("#themeToggle").click(); await inspect(customPage, "fixture: dark accent", true, "rgb(247, 156, 67)");
  await customPage.evaluate(() => window.__skinTestHook.selectSkin("kimi")); const pending = await inspect(customPage, "fixture: another skin uses base", true); assert.equal(pending.accentOverride, "");
  await customPage.evaluate(() => window.__skinTestHook.resetToClassic()); const cleared = await inspect(customPage, "fixture: classic clears override", false); assert.equal(cleared.accentOverride, "");
  await custom.close(); results.checks.push("isolated per-mode accents update, glow follows same colour, pending/classic clear stale overrides");

  for (const theme of ["light", "dark"]) {
    const context = await contextFor(theme, false, true);
    await context.route("**/app.js", (route) => route.abort());
    const page = await context.newPage(); await page.goto(url);
    assert.equal(await page.evaluate(() => Boolean(window.__skinTestHook)), false);
    await inspect(page, `${theme}: bootstrap before app`, true, null, false);
    await context.close();
  }
  results.checks.push("restored skin glows from bootstrap and CSS before app initialization, even hidden at zero opacity");

  writeFileSync(snapshot, renderStaticDashboardHtml(fixture));
  const offline = await contextFor("dark");
  await offline.route("**/*", (route) => { if (/^https?:/.test(route.request().url())) { results.externalOfflineRequests.push(route.request().url()); return route.abort(); } return route.continue(); });
  const offlinePage = await offline.newPage(); offlinePage.on("pageerror", (error) => results.errors.push(error.message));
  await offlinePage.goto(pathToFileURL(snapshot).href); await offlinePage.waitForFunction(() => window.__skinTestHook);
  // Offline controls intentionally differ from the live fixture: compare to
  // that snapshot's own classic geometry, never the live dashboard geometry.
  const offlineBase = await inspect(offlinePage, "file:// classic baseline", false, null, false);
  await offlinePage.evaluate(() => window.__skinTestHook.selectSkin("chatgpt"));
  const offlineDark = await inspect(offlinePage, "file:// dark selected", true, null, false);
  assert.deepEqual(offlineDark.geometry, offlineBase.geometry);
  await offlinePage.locator("#themeToggle").click();
  const offlineLight = await inspect(offlinePage, "file:// light switched", true, null, false);
  assert.deepEqual(offlineLight.geometry, offlineBase.geometry);
  await offlinePage.reload(); await offlinePage.waitForFunction(() => window.__skinTestHook);
  const offlineRestored = await inspect(offlinePage, "file:// refresh", true, null, false);
  assert.deepEqual(offlineRestored.geometry, offlineBase.geometry);
  await offlinePage.evaluate(() => window.__skinTestHook.resetToClassic());
  const offlineClassic = await inspect(offlinePage, "file:// classic", false, null, false);
  assert.deepEqual(offlineClassic.geometry, offlineBase.geometry);
  await offline.close(); assert.deepEqual(results.externalOfflineRequests, []);
  results.checks.push("generated single-file export: selected bar, mode switch, refresh and classic with zero network requests");
  assert.deepEqual(results.errors, []);
  writeFileSync(path.join(output, "r2-results.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`PASS: ${results.states.length} actual browser states; ${results.errors.length} page errors; ${results.externalOfflineRequests.length} offline external requests.`);
  for (const check of results.checks) console.log(`PASS: ${check}`);
} finally {
  await browser.close(); await new Promise((resolve) => server.close(resolve));
  try { unlinkSync(snapshot); } catch {}
  rmdirSync(tempDir);
}
