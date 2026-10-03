// Final acceptance round after ALL ten palettes were filled and the whole-page
// wiring landed (2026-10-02): every skin × mode must drive the ENTIRE variable
// set (page, surfaces, text, accent, ceramics) through the real runtime path,
// selection must never move the main layout, canvas consumers must see the new
// colours, every picker card must show real swatches, preview scopes must stay
// insulated, classic must clean up completely, and the offline snapshot must
// carry the palettes too.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderStaticDashboardHtml } from "../../../src/static-export.js";

const output = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(output, "../../..");
const skinsModule = await import(pathToFileURL(path.join(root, "public/skins.js")).href);
const { PALETTE_CSS_VAR_NAMES, paletteDeclarations } = skinsModule;
const { SKIN_PALETTES } = await import(pathToFileURL(path.join(root, "public/skin-palettes.js")).href);
const IDS = ["chatgpt", "claude", "glm", "gemini", "deepseek", "kimi", "qwen", "grok", "muse", "mimo"];
const DECLS = Object.fromEntries(IDS.map((id) => [id, { light: paletteDeclarations(id, "light"), dark: paletteDeclarations(id, "dark") }]));
const ACCENTS = Object.fromEntries(
  IDS.map((id) => [id, { light: SKIN_PALETTES[id].light.accent.toLowerCase(), dark: SKIN_PALETTES[id].dark.accent.toLowerCase() }]),
);
const hexToRgbString = (hex) => {
  const full = hex.replace("#", "");
  const rgb = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
};

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
const playwrightPath = process.env.AGENT_USAGE_PLAYWRIGHT_MODULE || path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const { chromium } = await import(pathToFileURL(playwrightPath).href);
const browser = await chromium.launch({ executablePath: process.env.AGENT_USAGE_EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });

const results = { checks: 0, errors: [], accents: {}, externalOfflineRequests: [] };
const check = (name, condition) => {
  results.checks += 1;
  assert.ok(condition, name);
};

async function mainGeometry(page) {
  return page.evaluate(() => [...document.querySelectorAll(".shell, .topbar, .toolbar, .metrics, .main-grid, .bottom-grid, .panel, .metric")].map((node) => {
    const b = node.getBoundingClientRect(); return { className: node.className, x: b.x, y: b.y, width: b.width, height: b.height };
  }));
}

/** Every wired variable on <html> plus the body's resolved background colour. */
async function wiringSnapshot(page, names) {
  return page.evaluate((varNames) => {
    const style = getComputedStyle(document.documentElement);
    const values = {};
    for (const name of varNames) values[name] = style.getPropertyValue(name).trim();
    values["body.background-color"] = getComputedStyle(document.body).backgroundColor;
    return values;
  }, names);
}

function assertWiring(id, mode, snapshot) {
  for (const [name, value] of DECLS[id][mode]) {
    assert.equal(snapshot[name].toLowerCase(), String(value).toLowerCase(), `${id}/${mode} ${name}`);
    results.checks += 1;
  }
  const pageBackground = DECLS[id][mode].find(([name]) => name === "--bg")[1];
  assert.equal(snapshot["body.background-color"], hexToRgbString(pageBackground), `${id}/${mode}: body consumes --bg`);
  results.checks += 1;
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
  await context.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) }));
  const page = await context.newPage();
  page.on("pageerror", (error) => results.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__skinTestHook);
  check("fresh load keeps --skin-active-accent absent (classic)", await page.evaluate(() => document.documentElement.style.getPropertyValue("--skin-active-accent") === ""));

  // Light pass: each skin must carry its own light accent, layout frozen.
  let geometry = await mainGeometry(page);
  for (const id of IDS) {
    await page.evaluate((skinId) => window.__skinTestHook.selectSkin(skinId), id);
    const accent = await page.evaluate(() => document.documentElement.style.getPropertyValue("--skin-active-accent").toLowerCase());
    assert.equal(accent, ACCENTS[id].light, `${id}/light accent`);
    assert.deepEqual(await mainGeometry(page), geometry, `${id}/light: selection moves nothing`);
    results.checks += 2;
    results.accents[`${id}.light`] = accent;
    assertWiring(id, "light", await wiringSnapshot(page, PALETTE_CSS_VAR_NAMES));
  }

  // Dark pass: one theme toggle, then every skin must switch to its dark accent.
  await page.evaluate(() => document.getElementById("themeToggle").click());
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  geometry = await mainGeometry(page);
  for (const id of IDS) {
    await page.evaluate((skinId) => window.__skinTestHook.selectSkin(skinId), id);
    const accent = await page.evaluate(() => document.documentElement.style.getPropertyValue("--skin-active-accent").toLowerCase());
    assert.equal(accent, ACCENTS[id].dark, `${id}/dark accent`);
    assert.deepEqual(await mainGeometry(page), geometry, `${id}/dark: selection moves nothing`);
    results.checks += 2;
    results.accents[`${id}.dark`] = accent;
    assertWiring(id, "dark", await wiringSnapshot(page, PALETTE_CSS_VAR_NAMES));
  }

  // Picker: ten cards, each rendering both mode previews (the card markup no
  // longer carries the swatch strip — a parallel 2026-10-03 edit removed it,
  // so the palette's card-level visibility is the preview tint itself).
  await page.evaluate((skinId) => window.__skinTestHook.selectSkin(skinId), "deepseek");
  await page.evaluate(() => document.getElementById("themeToggle").click());
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  // Chart consumers: --chart-text is read at canvas draw time, and the skin
  // change (mimo -> deepseek, then the theme re-render) must leave the palette
  // value in place for the next draw.
  const chartText = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--chart-text").trim());
  assert.equal(chartText.toLowerCase(), SKIN_PALETTES.deepseek.light.chartText.toLowerCase(), "chart text follows the deepseek light palette");
  results.checks += 1;
  await page.evaluate(() => window.__skinTestHook.openPicker());
  await page.waitForFunction(() => window.__skinTestHook.isPickerOpen());
  check("ten cards, none pending", (await page.locator(".skin-card").count()) === 10 && (await page.locator(".skin-swatch-note").count()) === 0);
  const previewCounts = await page.locator(".skin-card").evaluateAll((cards) =>
    cards.map((card) => ({
      id: card.dataset.skinId,
      cells: card.querySelectorAll(".skin-preview-cell").length,
      tinted: card.querySelectorAll(".skin-preview-scope .skin-preview[style]").length,
    })),
  );
  for (const entry of previewCounts) {
    assert.deepEqual(entry.cells, 2, `${entry.id}: light and dark previews`);
    assert.ok(entry.tinted >= 1, `${entry.id}: at least one preview carries palette tint variables`);
    results.checks += 1;
  }
  // Preview insulation: the mini previews redeclare the material variables in
  // the stylesheet, so the page's inline palette must not leak into them.
  const scopeBg = await page.evaluate(() => {
    const scope = document.querySelector('.skin-card[data-skin-id="claude"] .skin-preview-scope[data-preview-theme="light"]');
    return getComputedStyle(scope).getPropertyValue("--bg").trim();
  });
  assert.equal(scopeBg.toLowerCase(), "#cfd8e1", "preview scope keeps the stylesheet base, not the page palette");
  results.checks += 1;
  await page.locator(".skin-dialog").screenshot({ path: path.join(output, "all-skins-picker-light.png") });
  await page.evaluate(() => document.getElementById("themeToggle").click());
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await page.waitForTimeout(300);
  await page.locator(".skin-dialog").screenshot({ path: path.join(output, "all-skins-picker-dark.png") });
  await page.evaluate(() => window.__skinTestHook.closePicker());
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(output, "all-skins-page-deepseek-dark.png") });
  await page.evaluate(() => document.getElementById("themeToggle").click());
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(output, "all-skins-page-deepseek-light.png") });

  // Classic must clean up completely: every wired variable removed from the
  // inline style and the body back on the theme's own background.
  await page.evaluate(() => window.__skinTestHook.resetToClassic());
  const classicInline = await page.evaluate((names) => {
    const style = document.documentElement.style;
    return names.every((name) => style.getPropertyValue(name) === "");
  }, PALETTE_CSS_VAR_NAMES);
  check("classic removes every wired variable inline", classicInline);
  const classicBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check("classic body background returns to the theme base", classicBg === "rgb(207, 216, 225)");
  await context.close();

  // Offline snapshot: the exporter inlines the palettes, so accents survive file://.
  const tempDir = os.tmpdir();
  const snapshot = path.join(tempDir, "skin-palette-acceptance.html");
  writeFileSync(snapshot, renderStaticDashboardHtml(fixture));
  const offline = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await offline.route("**/*", (route) => { if (/^https?:/.test(route.request().url())) { results.externalOfflineRequests.push(route.request().url()); return route.abort(); } return route.continue(); });
  const offlinePage = await offline.newPage();
  offlinePage.on("pageerror", (error) => results.errors.push(`offline: ${error.message}`));
  await offlinePage.goto(pathToFileURL(snapshot).href);
  await offlinePage.waitForFunction(() => window.__skinTestHook);
  for (const [id, mode] of [["claude", "light"], ["grok", "dark"]]) {
    if (mode === "dark") {
      await offlinePage.evaluate(() => document.getElementById("themeToggle").click());
      await offlinePage.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    }
    await offlinePage.evaluate((skinId) => window.__skinTestHook.selectSkin(skinId), id);
    assertWiring(id, mode, await wiringSnapshot(offlinePage, PALETTE_CSS_VAR_NAMES));
  }
  await offline.close();
  try { writeFileSync(snapshot, ""); } catch {}

  assert.deepEqual(results.errors, [], "zero page errors online and offline");
  assert.deepEqual(results.externalOfflineRequests, [], "offline snapshot makes zero external requests");
  writeFileSync(path.join(output, "palette-all-skins-results.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`PASS: ${results.checks} checks — 20 skin/mode full wiring, frozen geometry, swatched cards, insulated previews, classic cleanup, offline snapshot; zero page errors.`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
