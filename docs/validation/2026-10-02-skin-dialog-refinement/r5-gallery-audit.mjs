// R5 audit: the ten comparison cards must sit in ONE continuous gallery well -
// dialog shell -> well -> cards - with the recessed material of the dashboard's
// comparison-table-frame, a light card rise above the shared floor, the pressed
// state on selection, and no per-row frames. The well floor's continuity is
// proven by pixel-sampling the well with the cards temporarily hidden (their
// shadows would otherwise bleed into the samples); old evidence is preserved.
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
const tempDir = mkdtempSync(path.join(os.tmpdir(), "skin-r5-"));
const snapshot = path.join(tempDir, "gallery.html");

// Final ceramic tokens: --ceramic-well light #ced8e1 / dark #232b32; the dialog
// shell surface --neo-surface light #dbe2e8 / dark #292f35. The floor must read
// as the well, not as a second copy of the shell.
const WELL_RGB = { light: [206, 216, 225], dark: [35, 43, 50] };
const SHELL_RGB = { light: [219, 226, 232], dark: [41, 47, 53] };

async function mainGeometry(page) {
  return page.evaluate(() => [...document.querySelectorAll(".shell, .topbar, .toolbar, .metrics, .main-grid, .bottom-grid, .panel, .metric")].map((node) => {
    const b = node.getBoundingClientRect(); return { className: node.className, x: b.x, y: b.y, width: b.width, height: b.height };
  }));
}

async function wellState(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector(".skin-dialog");
    const well = document.querySelector(".skin-gallery-well");
    if (!well) return { present: false };
    const grid = document.querySelector("#skinGrid");
    const wellStyle = getComputedStyle(well);
    const wellBox = well.getBoundingClientRect();
    const cards = [...grid.querySelectorAll(".skin-card")];
    const rules = {};
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        const selector = rule.selectorText || "";
        if (selector === ".skin-gallery-well") rules.well = rule.style.cssText;
        if (selector === ".skin-gallery-well::after") rules.overlay = rule.style.cssText;
        if (selector === ".skin-card") rules.card = rule.style.cssText;
      }
    }
    const rows = new Map();
    for (const card of cards) { const y = Math.round(card.getBoundingClientRect().y); rows.set(y, (rows.get(y) || 0) + 1); }
    const cardBoxes = cards.map((card) => {
      const b = card.getBoundingClientRect();
      const previews = card.querySelector(".skin-card-previews").getBoundingClientRect();
      const colours = card.querySelector(".skin-card-colours").getBoundingClientRect();
      const style = getComputedStyle(card);
      // Card-relative offsets: absolute viewport y differs per row by design.
      return { top: b.top, bottom: b.bottom, height: b.height, previewsTopRel: Math.round(previews.top - b.top), coloursBottomRel: Math.round(b.bottom - colours.bottom), background: style.backgroundImage, shadow: style.boxShadow, borderColor: style.borderTopColor };
    });
    return {
      present: true,
      isGridParent: grid.parentElement === well,
      wellCount: dialog.querySelectorAll(".skin-gallery-well").length,
      wellChildren: [...well.children].map((node) => node.id || node.className),
      material: { background: wellStyle.backgroundColor, shadow: wellStyle.boxShadow, radius: wellStyle.borderRadius },
      gridPadding: Number.parseInt(getComputedStyle(grid).paddingTop, 10),
      rules,
      cardCount: cards.length,
      rowCounts: [...rows.values()].sort((a, b) => b - a),
      columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
      wellBox: { top: wellBox.top, bottom: wellBox.bottom, left: wellBox.left, right: wellBox.right },
      firstRowTop: Math.min(...cardBoxes.slice(0, 5).map((c) => c.top)),
      lastRowBottom: Math.max(...cardBoxes.slice(-5).map((c) => c.bottom)),
      cardBoxes,
      gridOverflowY: grid.scrollHeight - grid.clientHeight,
      gridOverflowX: grid.scrollWidth - grid.clientWidth,
      dialogOverflowY: dialog.scrollHeight - dialog.clientHeight,
      pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      controlsVisible: ["#skinOpacity", "#resetSkinClassicButton", "#closeSkinDialogButton"].every((selector) => { const b = document.querySelector(selector).getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth; }),
    };
  });
}

/**
 * Continuity proof: hide the cards (their raised shadows would bleed into the
 * samples), screenshot the well, and verify the exposed floor is one uniform
 * stretch of well colour across a visible inter-card gap and the foot padding
 * strip. On scrolled screens the first visible vertical gap is used.
 */
async function wellFloorPixels(page) {
  await page.evaluate(() => { document.querySelectorAll(".skin-card").forEach((card) => { card.style.visibility = "hidden"; }); });
  const png = await page.locator(".skin-gallery-well").screenshot();
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const pixels = await page.evaluate(async (src) => {
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = src; });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const well = document.querySelector(".skin-gallery-well").getBoundingClientRect();
    const cards = [...document.querySelectorAll(".skin-card")].map((card) => card.getBoundingClientRect());
    const sample = (x, y) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3);
    // Vertical gaps between consecutive cards whose midpoint is actually visible.
    const visibleGaps = [];
    for (let index = 0; index < cards.length - 1; index += 1) {
      const mid = (cards[index].bottom + cards[index + 1].top) / 2;
      const y = Math.round(mid - well.top);
      if (cards[index + 1].top >= cards[index].bottom - 1 && y >= 12 && y <= canvas.height - 12) visibleGaps.push(y);
    }
    const gapY = visibleGaps.length ? visibleGaps[0] : null;
    const footY = Math.round(well.height - 7);
    return {
      gapSamples: gapY === null ? [] : [0.2, 0.4, 0.6, 0.8].map((f) => sample(Math.round(canvas.width * f), gapY)),
      footSamples: [0.25, 0.75].map((f) => sample(Math.round(canvas.width * f), footY)),
      gapY, footY,
    };
  }, dataUrl);
  await page.evaluate(() => { document.querySelectorAll(".skin-card").forEach((card) => { card.style.visibility = ""; }); });
  return pixels;
}

function near(pixel, target, tolerance) {
  return pixel.every((channel, index) => Math.abs(channel - target[index]) <= tolerance);
}

function distance(a, b) {
  return Math.hypot(...a.map((channel, index) => channel - b[index]));
}

function assertWell(state, pixels, label, { theme, perRow = 5 }) {
  results.checks += 1;
  results.states.push({ label, theme, material: state.material, rowCounts: state.rowCounts, pixels: { gapSamples: pixels.gapSamples, footSamples: pixels.footSamples } });
  const wellRgb = WELL_RGB[theme];
  const shellRgb = SHELL_RGB[theme];
  // Structure: one well wrapping the grid, nothing else beside it.
  assert.equal(state.present, true, `${label}: well present`);
  assert.equal(state.isGridParent, true, `${label}: well wraps #skinGrid`);
  assert.equal(state.wellCount, 1, `${label}: exactly one well, no per-row frames`);
  assert.deepEqual(state.wellChildren, ["skinGrid"], `${label}: the well contains only the grid`);
  assert.equal(state.cardCount, 10, `${label}: ten cards inside the well`);
  // Recessed material, shared with comparison-table-frame.
  assert.equal(state.material.background, theme === "light" ? "rgb(206, 216, 225)" : "rgb(35, 43, 50)", `${label}: well floor is --ceramic-well`);
  assert.ok(state.material.shadow.includes("inset"), `${label}: well keeps the inset shading`);
  assert.equal(state.material.radius, "16px", `${label}: well uses the project's rounded edge`);
  // Shadow room: the padding lives inside the scroll container, so the cards'
  // raised shadows render into it instead of being hard-clipped at the edges.
  assert.ok(state.gridPadding >= 12 && state.gridPadding <= 16, `${label}: grid padding inside the 12-16px reference`);
  assert.ok(state.rules.well?.includes("var(--ceramic-well)") && state.rules.well?.includes("var(--neo-inset)"), `${label}: well rule reads the shared tokens`);
  assert.ok(state.rules.overlay?.includes("var(--neo-inset)") && state.rules.overlay?.includes("pointer-events: none"), `${label}: inset overlay stays above scroll, never intercepts`);
  // Cards rise lightly above the floor; selection presses back down.
  assert.ok(state.rules.card?.includes("var(--neo-raised-small)"), `${label}: card rule reads the light raise`);
  assert.ok(state.cardBoxes.every((box) => box.shadow !== "none"), `${label}: every card has the raised shadow`);
  assert.ok(state.cardBoxes.every((box) => box.background.includes("linear-gradient")), `${label}: card surface is the ceramic gradient, not the well colour`);
  // Geometry: when everything fits, the floor spans both rows with padding.
  assert.ok(state.rowCounts.every((count) => count === perRow), `${label}: ${perRow} cards per row`);
  if (state.gridOverflowY <= 1) {
    assert.ok(state.wellBox.top <= state.firstRowTop - state.gridPadding + 1 && state.wellBox.bottom >= state.lastRowBottom + state.gridPadding - 1, `${label}: one floor under both rows`);
  }
  // Continuity: the exposed floor is uniform well colour across the gap and foot.
  for (const sample of [...pixels.gapSamples, ...pixels.footSamples]) {
    assert.ok(near(sample, wellRgb, 10), `${label}: floor sample ${sample} is the well colour`);
    assert.ok(distance(sample, wellRgb) < distance(sample, shellRgb), `${label}: floor sample ${sample} reads as well, not shell`);
  }
  // Aligned sections: previews and colour groups sit at the same card-relative
  // position on every card, in both rows.
  const previewOffsets = state.cardBoxes.map((box) => box.previewsTopRel);
  const colourOffsets = state.cardBoxes.map((box) => box.coloursBottomRel);
  assert.ok(Math.max(...previewOffsets) - Math.min(...previewOffsets) <= 1, `${label}: previews aligned across cards`);
  assert.ok(Math.max(...colourOffsets) - Math.min(...colourOffsets) <= 1, `${label}: colour groups pinned to the same foot line`);
  const heights = state.cardBoxes.map((box) => box.height);
  assert.ok(Math.max(...heights) - Math.min(...heights) <= 2, `${label}: ten cards share one height`);
}

async function runTheme(theme) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
  await context.addInitScript((value) => localStorage.setItem("codexUsageTheme", value), theme);
  await context.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) }));
  const page = await context.newPage();
  page.on("pageerror", (error) => results.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__skinTestHook);
  await page.evaluate(() => document.fonts.ready);
  const geometry = await mainGeometry(page);

  await page.locator("#skinToggle").click();
  let state = await wellState(page);
  assertWell(state, await wellFloorPixels(page), `${theme}: 1440 gallery`, { theme });
  assert.equal(state.columns, 5, `${theme}: five columns`);
  assert.ok(state.gridOverflowY <= 1 && state.dialogOverflowY === 0, `${theme}: desktop comparison fits without scrolling`);
  assert.equal(state.pageOverflowX, 0, `${theme}: no horizontal overflow`);
  assert.deepEqual(await mainGeometry(page), geometry, `${theme}: opening does not change main layout`);

  // Selection presses the card into the shared pressed state. Whole-page wiring
  // (2026-10-02) drives --blue from the selected skin's accent, so the pressed
  // edge is the skin accent (deepseek #88a4dd/#96afe1), not the theme default.
  await page.locator('.skin-card[data-skin-id="deepseek"]').click();
  state = await wellState(page);
  const selectedBox = state.cardBoxes[4];
  const others = state.cardBoxes.filter((_, index) => index !== 4);
  const selectedRgb = theme === "light" ? "rgb(136, 164, 221)" : "rgb(150, 175, 225)";
  assert.equal(selectedBox.borderColor, selectedRgb, `${theme}: selected card edge is the theme accent`);
  assert.ok(selectedBox.shadow.includes("inset"), `${theme}: selected card uses the pressed inset`);
  assert.ok(others.every((box) => box.borderColor !== selectedRgb), `${theme}: unselected cards keep the neutral edge`);
  await page.locator("#resetSkinClassicButton").click();
  assert.deepEqual(await mainGeometry(page), geometry, `${theme}: selection does not change main layout`);

  // The tight desktop trio must still fit inside the well without scrolling.
  for (const [width, height] of [[1280, 800], [1024, 768]]) {
    const tight = await browser.newContext({ viewport: { width, height }, locale: "zh-CN", reducedMotion: "reduce" });
    await tight.addInitScript((value) => localStorage.setItem("codexUsageTheme", value), theme);
    await tight.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) }));
    const tightPage = await tight.newPage();
    tightPage.on("pageerror", (error) => results.errors.push(error.message));
    await tightPage.goto(`http://127.0.0.1:${server.address().port}/`);
    await tightPage.waitForFunction(() => window.__skinTestHook);
    await tightPage.locator("#skinToggle").click();
    const tightState = await wellState(tightPage);
    assertWell(tightState, await wellFloorPixels(tightPage), `${theme}: ${width} gallery`, { theme });
    assert.ok(tightState.gridOverflowY <= 1 && tightState.dialogOverflowY === 0, `${theme}: ${width}x${height} fits without scrolling`);
    await tight.close();
  }

  // Narrow screen: the comparison scrolls INSIDE the well; controls stay put.
  const narrow = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "zh-CN", reducedMotion: "reduce" });
  await narrow.addInitScript((value) => localStorage.setItem("codexUsageTheme", value), theme);
  await narrow.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) }));
  const narrowPage = await narrow.newPage();
  narrowPage.on("pageerror", (error) => results.errors.push(error.message));
  await narrowPage.goto(`http://127.0.0.1:${server.address().port}/`);
  await narrowPage.waitForFunction(() => window.__skinTestHook);
  await narrowPage.locator("#skinToggle").click();
  const narrowState = await wellState(narrowPage);
  assertWell(narrowState, await wellFloorPixels(narrowPage), `${theme}: 390 gallery`, { theme, perRow: 2 });
  assert.equal(narrowState.columns, 2, `${theme}: two columns on phones`);
  assert.ok(narrowState.gridOverflowY > 0, `${theme}: comparison scrolls inside the well`);
  assert.equal(narrowState.dialogOverflowY, 0, `${theme}: the dialog itself never scrolls`);
  assert.ok(narrowState.controlsVisible, `${theme}: controls remain accessible`);
  assert.equal(narrowState.pageOverflowX, 0, `${theme}: no horizontal overflow`);
  if (theme === "light") await narrowPage.locator(".skin-dialog").screenshot({ path: path.join(output, "r5-light-390.png") });
  await narrow.close();

  await page.locator(".skin-dialog").screenshot({ path: path.join(output, `r5-${theme}-1440.png`) });
  await context.close();
}

try {
  for (const theme of ["light", "dark"]) await runTheme(theme);

  // Offline: the wrapper and its material must survive the single-file export.
  writeFileSync(snapshot, renderStaticDashboardHtml(fixture));
  const offline = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await offline.route("**/*", (route) => { if (/^https?:/.test(route.request().url())) { results.externalOfflineRequests.push(route.request().url()); return route.abort(); } return route.continue(); });
  const page = await offline.newPage();
  page.on("pageerror", (error) => results.errors.push(error.message));
  await page.goto(pathToFileURL(snapshot).href);
  await page.waitForFunction(() => window.__skinTestHook);
  await page.locator("#skinToggle").click();
  const offlineState = await wellState(page);
  assertWell(offlineState, await wellFloorPixels(page), "offline: gallery", { theme: "light" });
  await offline.close();

  assert.deepEqual(results.errors, [], "zero page errors");
  assert.deepEqual(results.externalOfflineRequests, [], "zero external requests offline");
  writeFileSync(path.join(output, "r5-results.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`PASS: R5 gallery audit - ${results.checks} checked states across both themes, the desktop trio, 390px and file://; zero page errors and offline external requests.`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  try { unlinkSync(snapshot); } catch {}
  rmdirSync(tempDir);
}
