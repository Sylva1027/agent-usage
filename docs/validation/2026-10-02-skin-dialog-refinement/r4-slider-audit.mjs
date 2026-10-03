// R4 audit: the opacity slider must drop the shared input chrome and draw its
// track/thumb from the project material, fill with the R2 accent source, and
// keep value/readout/fill in sync across every path that changes opacity.
// Chromium's getComputedStyle does not resolve ::-webkit-slider-* pseudo
// elements, so painted results are verified by pixel-sampling an element
// screenshot; the declared recipes are verified from the stylesheet itself.
// Old P2/P3 evidence is preserved; this file only covers the R4 contract.
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
const playwrightPath = process.env.AGENT_USAGE_PLAYWRIGHT_MODULE || path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const { chromium } = await import(pathToFileURL(playwrightPath).href);
const browser = await chromium.launch({ executablePath: process.env.AGENT_USAGE_EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
const results = { checks: 0, states: [], errors: [], externalOfflineRequests: [] };
const tempDir = mkdtempSync(path.join(os.tmpdir(), "skin-r4-"));
const snapshot = path.join(tempDir, "slider.html");

// Final theme accents (styles.css ceramic block): --blue light #007d91, dark
// #6cdae2; the well colours --ceramic-well light #ced8e1, dark #232b32.
const THEME_ACCENT = { light: "#007d91", dark: "#6cdae2" };
const ACCENT_RGB = { light: [0, 125, 145], dark: [108, 218, 226], injected: [255, 136, 0] };
const WELL_RGB = { light: [206, 216, 225], dark: [35, 43, 50] };
// Whole-page wiring (2026-10-02): a selected character skin drives the accent
// AND the ceramic well from its palette, so skin-carrying cases read their
// expectations from the same derivation the runtime uses.
const { paletteDeclarations } = await import(pathToFileURL(path.join(root, "public/skins.js")).href);
const chatgptDarkWiring = Object.fromEntries(paletteDeclarations("chatgpt", "dark"));
const hexToRgb = (value) => {
  const full = value.replace("#", "");
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
};

async function mainGeometry(page) {
  return page.evaluate(() => [...document.querySelectorAll(".shell, .topbar, .toolbar, .metrics, .main-grid, .bottom-grid, .panel, .metric")].map((node) => {
    const b = node.getBoundingClientRect(); return { className: node.className, x: b.x, y: b.y, width: b.width, height: b.height };
  }));
}

async function sliderState(page) {
  return page.evaluate(() => {
    const input = document.querySelector("#skinOpacity");
    const style = getComputedStyle(input);
    const rules = {};
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        const selector = rule.selectorText || "";
        if (selector.includes("::-webkit-slider-runnable-track") && selector.includes("skin-opacity-row")) rules.track = rule.style.cssText;
        if (selector.includes("::-webkit-slider-thumb") && selector.includes("skin-opacity-row")) rules.thumb = rule.style.cssText;
      }
    }
    return {
      value: input.value,
      output: document.querySelector("#skinOpacityValue").textContent,
      fillVariable: input.style.getPropertyValue("--skin-opacity-fill").trim(),
      computedAccent: style.getPropertyValue("--skin-slider-accent").trim(),
      preference: window.__skinTestHook.getPreference().opacity,
      chrome: {
        appearance: style.appearance,
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        boxShadow: style.boxShadow,
        borderWidth: style.borderTopWidth,
        borderRadius: style.borderRadius,
        height: style.height,
        padding: style.padding,
      },
      rules,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

/** Painted proof: sample the track's middle row left/right of the fill edge. */
async function sliderPixels(page) {
  const png = await page.locator("#skinOpacity").screenshot();
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  return page.evaluate(async (src) => {
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = src; });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const y = Math.floor(canvas.height / 2);
    const sample = (x) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3);
    // 15% / 65% stay clear of the thumb, which travels 0..144px and is ~16px wide.
    return { width: canvas.width, left: sample(Math.floor(canvas.width * 0.15)), right: sample(Math.floor(canvas.width * 0.65)) };
  }, dataUrl);
}

function closeTo(pixel, target, tolerance = 48) {
  return pixel.every((channel, index) => Math.abs(channel - target[index]) <= tolerance);
}

function assertSliderState(state, pixels, label, { theme, accent, well, percent }) {
  results.checks += 1;
  results.states.push({ label, theme, percent, fillVariable: state.fillVariable, computedAccent: state.computedAccent, pixels });
  const accentRgb = accent ? hexToRgb(accent) : ACCENT_RGB[theme];
  const wellRgb = well ? hexToRgb(well) : WELL_RGB[theme];
  // No inherited input chrome: the reset must win over styles.css input rules.
  assert.equal(state.chrome.appearance, "none", `${label}: appearance reset`);
  assert.equal(state.chrome.backgroundColor, "rgba(0, 0, 0, 0)", `${label}: no well background on the input box`);
  assert.equal(state.chrome.backgroundImage, "none", `${label}: no gradient on the input box`);
  assert.equal(state.chrome.boxShadow, "none", `${label}: no input shadow on the input box`);
  assert.equal(state.chrome.borderWidth, "0px", `${label}: no input border`);
  assert.equal(state.chrome.borderRadius, "0px", `${label}: no input radius`);
  assert.equal(state.chrome.padding, "0px", `${label}: no input padding`);
  // Declared recipes (getComputedStyle cannot resolve the vendor pseudo rules).
  assert.ok(state.rules.track?.includes("linear-gradient"), `${label}: track rule paints the fill gradient`);
  assert.ok(state.rules.track?.includes("var(--skin-slider-accent)"), `${label}: filled segment reads the R2 accent chain`);
  assert.ok(state.rules.track?.includes("var(--ceramic-well)"), `${label}: unfilled segment reads the well colour`);
  assert.ok(state.rules.track?.includes("var(--skin-opacity-fill)"), `${label}: fill stop follows the synced variable`);
  assert.ok(state.rules.track?.includes("var(--neo-inset-small)"), `${label}: track keeps the light inset well`);
  assert.ok(state.rules.thumb?.includes("linear-gradient(145deg"), `${label}: thumb uses the ceramic gradient`);
  assert.ok(state.rules.thumb?.includes("var(--neo-raised-small)"), `${label}: thumb keeps the raised rim`);
  // The accent chain resolves live to the effective accent.
  assert.equal(state.computedAccent, accent || THEME_ACCENT[theme], `${label}: effective accent is ${accent || THEME_ACCENT[theme]}`);
  // Value, readout, fill variable and stored preference agree.
  assert.equal(state.value, String(percent), `${label}: range value`);
  assert.equal(state.output, `${percent}%`, `${label}: readout`);
  assert.equal(state.fillVariable, `${percent}%`, `${label}: fill variable`);
  assert.ok(Math.abs(state.preference - percent / 100) < 1e-9, `${label}: stored preference`);
  assert.equal(state.overflowX, 0, `${label}: no horizontal overflow`);
  // Painted result: the fill boundary sits where the percentage says it does.
  // Sample points: 15% (x=24) and 65% (x=104) of the 160px track, both outside
  // the thumb's travel for every tested percentage.
  const leftIsAccent = percent > 19;
  const rightIsAccent = percent > 69;
  assert.equal(closeTo(pixels.left, leftIsAccent ? accentRgb : wellRgb), true, `${label}: left of the edge paints ${leftIsAccent ? "accent" : "well"} (${pixels.left})`);
  assert.equal(closeTo(pixels.right, rightIsAccent ? accentRgb : wellRgb), true, `${label}: right of the edge paints ${rightIsAccent ? "accent" : "well"} (${pixels.right})`);
}

async function openDialog(context, theme) {
  await context.addInitScript((value) => localStorage.setItem("codexUsageTheme", value), theme);
  await context.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) }));
  const page = await context.newPage();
  page.on("pageerror", (error) => results.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__skinTestHook);
  await page.evaluate(() => document.fonts.ready);
  await page.locator("#skinToggle").click();
  return page;
}

async function runTheme(theme) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
  const page = await openDialog(context, theme);
  const geometry = await mainGeometry(page);

  // Default 50% on first open, accent falls back to the theme blue.
  let state = await sliderState(page);
  assertSliderState(state, await sliderPixels(page), `${theme}: default`, { theme, percent: 50 });
  assert.deepEqual(await mainGeometry(page), geometry, `${theme}: opening does not change main layout`);

  // Focus ring comes from the shared input rule, like every other control.
  // Script focus() does not trigger :focus-visible, so arrive by real Tab presses.
  await page.evaluate(() => document.activeElement?.blur());
  let tabbed = 0;
  while ((await page.evaluate(() => document.activeElement?.id)) !== "skinOpacity" && tabbed < 25) {
    await page.keyboard.press("Tab");
    tabbed += 1;
  }
  assert.equal(await page.evaluate(() => document.activeElement?.id), "skinOpacity", `${theme}: Tab reaches the slider`);
  const focus = await page.evaluate(() => { const s = getComputedStyle(document.querySelector("#skinOpacity")); return { width: s.outlineWidth, color: s.outlineColor, style: s.outlineStyle }; });
  assert.equal(focus.style, "solid", `${theme}: focus outline present`);
  assert.equal(focus.width, "2px", `${theme}: focus outline matches the shared 2px rule`);
  assert.equal(focus.color, theme === "light" ? "rgb(0, 125, 145)" : "rgb(108, 218, 226)", `${theme}: focus outline uses the theme accent`);

  // Keyboard endpoints and steps keep everything in sync.
  await page.keyboard.press("Home");
  assertSliderState(await sliderState(page), await sliderPixels(page), `${theme}: keyboard Home`, { theme, percent: 0 });
  await page.keyboard.press("ArrowUp");
  assertSliderState(await sliderState(page), await sliderPixels(page), `${theme}: keyboard step`, { theme, percent: 1 });
  await page.keyboard.press("End");
  assertSliderState(await sliderState(page), await sliderPixels(page), `${theme}: keyboard End`, { theme, percent: 100 });

  // A skin palette accent (R2's variable) recolours the fill; removal restores.
  await page.evaluate(() => document.documentElement.style.setProperty("--skin-active-accent", "#ff8800"));
  state = await sliderState(page);
  assert.equal(state.computedAccent, "#ff8800", `${theme}: palette accent reaches the slider chain`);
  assertSliderState(state, await sliderPixels(page), `${theme}: palette accent`, { theme, accent: "#ff8800", percent: 100 });
  await page.evaluate(() => document.documentElement.style.removeProperty("--skin-active-accent"));
  state = await sliderState(page);
  assertSliderState(state, await sliderPixels(page), `${theme}: fallback restored`, { theme, percent: 100 });

  // Programmatic runtime change reaches the slider through the picker sync.
  await page.evaluate(() => window.__skinTestHook.setOpacity(0.8));
  assertSliderState(await sliderState(page), await sliderPixels(page), `${theme}: programmatic`, { theme, percent: 80 });
  assert.deepEqual(await mainGeometry(page), geometry, `${theme}: slider use does not change main layout`);

  // The value survives a reload and is restored into the control.
  await page.reload();
  await page.waitForFunction(() => window.__skinTestHook);
  await page.locator("#skinToggle").click();
  assertSliderState(await sliderState(page), await sliderPixels(page), `${theme}: reload restore`, { theme, percent: 80 });
  await page.locator(".skin-dialog").screenshot({ path: path.join(output, `r4-slider-${theme}.png`) });
  await context.close();
}

async function runRestoreCase(theme, stored, percent, label, accent, well) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
  await context.addInitScript(({ themeValue, preference }) => {
    localStorage.setItem("codexUsageTheme", themeValue);
    localStorage.setItem("codexUsageSkinV1", preference);
  }, { themeValue: theme, preference: JSON.stringify(stored) });
  await context.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) }));
  const page = await context.newPage();
  page.on("pageerror", (error) => results.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__skinTestHook);
  await page.locator("#skinToggle").click();
  assertSliderState(await sliderState(page), await sliderPixels(page), `${theme}: ${label}`, { theme, accent, well, percent });
  await context.close();
}

try {
  for (const theme of ["light", "dark"]) await runTheme(theme);
  await runRestoreCase("light", { version: 1, skinId: "classic", showCharacters: true, opacity: 0.35 }, 35, "restored 35%");
  await runRestoreCase("dark", { version: 1, skinId: "classic", showCharacters: true, opacity: 0 }, 0, "restored 0%");
  // Whole-page wiring (2026-10-02): a restored character skin drives --blue to
  // its own accent and the ceramic well to its derived well, so the painted
  // track pixels come from chatgpt's dark palette via the shared derivation.
  await runRestoreCase(
    "dark",
    { version: 1, skinId: "chatgpt", showCharacters: true, opacity: 0.5 },
    50,
    "restored character skin 50%",
    chatgptDarkWiring["--skin-active-accent"],
    chatgptDarkWiring["--ceramic-well"],
  );

  // Offline: the inlined stylesheet and picker must behave identically from file://.
  writeFileSync(snapshot, renderStaticDashboardHtml(fixture));
  const offline = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await offline.route("**/*", (route) => { if (/^https?:/.test(route.request().url())) { results.externalOfflineRequests.push(route.request().url()); return route.abort(); } return route.continue(); });
  const page = await offline.newPage();
  page.on("pageerror", (error) => results.errors.push(error.message));
  await page.goto(pathToFileURL(snapshot).href);
  await page.waitForFunction(() => window.__skinTestHook);
  await page.locator("#skinToggle").click();
  assertSliderState(await sliderState(page), await sliderPixels(page), "offline: default", { theme: "light", percent: 50 });
  await page.locator("#skinOpacity").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  assertSliderState(await sliderState(page), await sliderPixels(page), "offline: keyboard", { theme: "light", percent: 48 });
  await offline.close();

  assert.deepEqual(results.errors, [], "zero page errors");
  assert.deepEqual(results.externalOfflineRequests, [], "zero external requests offline");
  writeFileSync(path.join(output, "r4-results.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`PASS: R4 slider audit - ${results.checks} checked states across both themes plus restore cases and file://; zero page errors and offline external requests.`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  try { unlinkSync(snapshot); } catch {}
  rmdirSync(tempDir);
}
