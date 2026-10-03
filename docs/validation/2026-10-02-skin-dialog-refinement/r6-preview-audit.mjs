// R6 uses an isolated fixture server/browser; it never reads live usage data.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderStaticDashboardHtml } from "../../../src/static-export.js";
import { SKINS } from "../../../public/skins.js";

const output = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(output, "../../..");
const fixture = { generatedAt: "2026-10-02T00:00:00.000Z", asOf: "2026-10-02T00:00:00.000Z", events: [], homes: [], sessions: [], warnings: [], rateLimitObservations: [] };
const skins = SKINS.filter((skin) => !skin.isClassic);
const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".webp": "image/webp" };
const server = createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  const file = path.resolve(root, "public", `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(`${path.join(root, "public")}${path.sep}`)) return response.writeHead(404).end();
  try { response.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" }); response.end(readFileSync(file)); }
  catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const playwrightPath = process.env.AGENT_USAGE_PLAYWRIGHT_MODULE || path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const { chromium } = await import(pathToFileURL(playwrightPath).href);
const browser = await chromium.launch({ executablePath: process.env.AGENT_USAGE_EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });

function protectedHashes() {
  const hashes = {};
  function walk(directory) {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else hashes[file] = createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex");
    }
  }
  for (const directory of ["public", "src", "lineart assets/light", "lineart assets/dark"]) walk(directory);
  return hashes;
}

async function references() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1040 }, deviceScaleFactor: 1 });
  await page.setContent(`<style>body{margin:0;background:#fff;font:16px Arial}.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;padding:12px}.cell{position:relative;text-align:center;height:495px;overflow:hidden}.cell img{height:450px;width:auto}.name{display:block;height:24px}.guide{position:absolute;left:0;right:0;border-top:1px dashed #bbb;color:#777;text-align:left;font-size:10px}</style><div class="grid">${skins.map((skin) => `<div class="cell"><b class="name">${skin.name}</b><img src="${base}${skin.variants.light.assets.front}">${[.1,.2,.3,.4,.5].map((y) => `<span class="guide" style="top:${24+y*450}px">${y}</span>`).join("")}</div>`).join("")}</div>`);
  await page.evaluate(() => Promise.all([...document.images].map((image) => image.decode())));
  await page.screenshot({ path: path.join(output, "r6-source-fronts.png") });
  writeFileSync(path.join(output, "r6-before-hashes.json"), `${JSON.stringify(protectedHashes(), null, 2)}\n`);
  await page.close();
}

async function openFixture(theme, width, height, locale = "zh-CN") {
  const context = await browser.newContext({ viewport: { width, height }, locale, timezoneId: "Asia/Shanghai", reducedMotion: "reduce", deviceScaleFactor: 2 });
  await context.addInitScript(({ theme, locale }) => {
    localStorage.setItem("codexUsageTheme", theme);
    localStorage.setItem("codexUsageLocale", locale);
  }, { theme, locale });
  await context.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) }));
  const page = await context.newPage();
  page.on("pageerror", (error) => results.errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => window.__skinTestHook);
  await page.evaluate(() => document.fonts.ready);
  const geometry = await mainGeometry(page);
  await page.locator("#skinToggle").click();
  await page.evaluate(async () => {
    for (const image of document.querySelectorAll(".skin-preview-art")) image.loading = "eager";
    await Promise.all([...document.querySelectorAll(".skin-preview-art")].map((image) => image.decode()));
  });
  return { context, page, geometry };
}

async function screenshots() {
  for (const theme of ["light", "dark"]) {
    const { context, page } = await openFixture(theme, 1440, 900);
    await page.locator(".skin-dialog").screenshot({ path: path.join(output, `r6-${theme}-1440.png`) });
    if (theme === "light") for (const skin of skins) {
      await page.locator(`.skin-card[data-skin-id="${skin.id}"] .skin-card-previews`).screenshot({ path: path.join(output, `r6-preview-${skin.id}.png`) });
    }
    await context.close();
  }
}

// Visually identified face and central torso rectangles on the original front
// canvas, in fractions. These are independent audit landmarks, not runtime
// layout data. Hair, horns, hands, props and skirts may extend beyond them.
const landmarks = {
  chatgpt: { face: [.40, .125, .52, .185], torso: [.40, .22, .56, .42] },
  claude: { face: [.42, .077, .55, .14], torso: [.45, .20, .57, .39] },
  glm: { face: [.41, .105, .54, .165], torso: [.44, .24, .56, .43] },
  gemini: { face: [.42, .123, .56, .19], torso: [.43, .235, .57, .435] },
  deepseek: { face: [.43, .12, .56, .195], torso: [.42, .225, .58, .43] },
  kimi: { face: [.44, .095, .57, .16], torso: [.43, .22, .60, .42] },
  qwen: { face: [.42, .10, .56, .175], torso: [.42, .225, .57, .44] },
  grok: { face: [.49, .18, .62, .245], torso: [.49, .28, .64, .50] },
  muse: { face: [.41, .136, .55, .202], torso: [.44, .25, .58, .47] },
  mimo: { face: [.41, .125, .55, .21], torso: [.43, .24, .58, .44] },
};
const results = { states: [], compositionChecks: 0, errors: [], externalOfflineRequests: [], protectedChanges: [] };

async function mainGeometry(page) {
  return page.evaluate(() => [...document.querySelectorAll(".shell, .topbar, .toolbar, .metrics, .main-grid, .bottom-grid, .panel, .metric")].map((node) => {
    const b = node.getBoundingClientRect(); return { className: node.className, x: b.x, y: b.y, width: b.width, height: b.height };
  }));
}

async function measure(page) {
  return page.evaluate((landmarks) => {
    const rect = (node) => { const b = node.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right, bottom: b.bottom }; };
    const cards = [...document.querySelectorAll(".skin-card")];
    const grid = document.querySelector("#skinGrid");
    const dialog = document.querySelector(".skin-dialog");
    const rows = new Map();
    for (const card of cards) { const y = Math.round(rect(card).y); rows.set(y, (rows.get(y) || 0) + 1); }
    const previews = cards.flatMap((card) => [...card.querySelectorAll(".skin-preview-cell")].map((cell) => {
      const stage = cell.querySelector(".skin-preview");
      const image = cell.querySelector(".skin-preview-art");
      const ui = cell.querySelector(".skin-preview-ui");
      const b = rect(stage); const ink = rect(image); const sample = rect(ui);
      const imageStyle = getComputedStyle(image); const stageStyle = getComputedStyle(stage);
      const local = (r) => ({ x: r.x - b.x, y: r.y - b.y, width: r.width, height: r.height, right: r.right - b.x, bottom: r.bottom - b.y });
      const landmark = (fractions) => ({ x: ink.x - b.x + fractions[0] * ink.width, y: ink.y - b.y + fractions[1] * ink.height,
        right: ink.x - b.x + fractions[2] * ink.width, bottom: ink.y - b.y + fractions[3] * ink.height });
      const framing = Object.fromEntries(["anchor-x", "stage-x", "top", "scale"].map((name) => [name, imageStyle.getPropertyValue(`--skin-preview-${name}`).trim()]));
      return { id: card.dataset.skinId, mode: cell.dataset.previewTheme, width: b.width, height: b.height, image: local(ink), ui: local(sample),
        face: landmark(landmarks[card.dataset.skinId].face), torso: landmark(landmarks[card.dataset.skinId].torso), framing,
        opacity: imageStyle.opacity, pointerEvents: imageStyle.pointerEvents, zIndex: imageStyle.zIndex,
        background: stageStyle.backgroundColor, overflow: stageStyle.overflow, isolation: stageStyle.isolation,
        blur: getComputedStyle(ui).backdropFilter, src: image.getAttribute("src"), decoded: image.complete && image.naturalWidth > 0,
        aspectRatio: ink.width / ink.height, sourceAspectRatio: image.naturalWidth / image.naturalHeight,
        chartBarWidths: [...ui.querySelectorAll(".skin-preview-bar")].map((bar) => rect(bar).width),
        colourGroups: card.querySelectorAll("[data-swatch-mode]").length };
    }));
    return { previews, ids: cards.map((card) => card.dataset.skinId), rowCounts: [...rows.values()], columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
      galleryCount: dialog.querySelectorAll(".skin-gallery-well").length, galleryParent: grid.parentElement.classList.contains("skin-gallery-well"),
      gridPadding: getComputedStyle(grid).padding, gridOverflowY: grid.scrollHeight - grid.clientHeight, gridOverflowX: grid.scrollWidth - grid.clientWidth,
      dialogOverflowY: dialog.scrollHeight - dialog.clientHeight, pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      controlsVisible: ["#skinOpacity", "#resetSkinClassicButton", "#closeSkinDialogButton"].every((selector) => { const b = rect(document.querySelector(selector)); return b.y >= 0 && b.bottom <= innerHeight && b.x >= 0 && b.right <= innerWidth; }) };
  }, landmarks);
}

function assertComposition(state, label, width, offline = false) {
  results.compositionChecks += 1;
  assert.deepEqual(state.ids, skins.map((skin) => skin.id), `${label}: ten cards in registry order`);
  assert.equal(state.previews.length, 20, `${label}: both modes on every card`);
  assert.equal(state.galleryCount, 1, `${label}: R5's shared well remains`);
  assert.equal(state.galleryParent, true, `${label}: grid remains in the well`);
  assert.equal(state.columns, width >= 1024 ? 5 : width > 720 ? 3 : 2, `${label}: responsive columns`);
  assert.ok(state.controlsVisible && state.dialogOverflowY === 0, `${label}: controls remain accessible`);
  assert.ok(state.gridOverflowX <= 1 && state.pageOverflowX <= 1, `${label}: no horizontal overflow`);
  if (width >= 1024) {
    assert.deepEqual(state.rowCounts, [5, 5], `${label}: five by two`);
    assert.ok(state.gridOverflowY <= 1, `${label}: desktop still fits`);
  }
  for (const p of state.previews) {
    const name = `${label}/${p.id}/${p.mode}`;
    assert.equal(p.decoded, true, `${name}: actual image decoded`);
    assert.equal(p.opacity, "0.5", `${name}: fixed comparison opacity`);
    assert.equal(p.pointerEvents, "none", `${name}: art never intercepts selection`);
    assert.equal(p.zIndex, "auto", `${name}: art not raised over UI`);
    assert.equal(p.overflow, "hidden", `${name}: isolated stage crops its artwork`);
    assert.equal(p.isolation, "isolate", `${name}: independent stacking scope`);
    assert.equal(p.blur, "none", `${name}: no blur over the character`);
    assert.ok(p.height >= 104, `${name}: comparison stage not compressed`);
    assert.ok(Math.abs(p.aspectRatio - p.sourceAspectRatio) < .0002, `${name}: undistorted original proportions`);
    assert.ok(p.chartBarWidths.every((value) => value >= 2), `${name}: three meaningful sample bars remain`);
    assert.equal(p.colourGroups, 2, `${name}: both palette labels remain`);
    assert.ok(p.ui.width / p.width <= .42, `${name}: interface stays on the left`);
    // Independent face/core rectangles must stay fully in the stage and wholly
    // to the right of the UI; decorative extrema are deliberately allowed out.
    for (const kind of ["face", "torso"]) {
      const area = p[kind];
      assert.ok(area.x >= p.ui.right + 1, `${name}: ${kind} clear of UI (${area.x} vs ${p.ui.right})`);
      assert.ok(area.x >= 1 && area.y >= 1 && area.right <= p.width - 1 && area.bottom <= p.height - 1,
        `${name}: ${kind} visible within stage ${JSON.stringify(area)} (${p.width}x${p.height})`);
    }
    assert.ok(p.image.bottom > p.height + 30, `${name}: upper body framing, skirt deliberately cropped`);
    if (offline) assert.match(p.src, /^data:image\/webp;base64,/, `${name}: export uses its inlined artwork`);
    else assert.equal(p.src, skins.find((skin) => skin.id === p.id).variants[p.mode].assets.front, `${name}: correct mode asset`);
  }
  for (const skin of skins) {
    const [light, dark] = state.previews.filter((p) => p.id === skin.id);
    assert.deepEqual(light.framing, dark.framing, `${label}/${skin.id}: identical mode framing`);
    assert.notEqual(light.background, dark.background, `${label}/${skin.id}: independent mode background`);
  }
}

async function audit() {
  const cases = [[1440, 900], [1280, 800], [1024, 768], [1023, 768], [768, 1024], [390, 844], [360, 800]];
  for (const theme of ["light", "dark"]) for (const locale of ["zh-CN", "en-US"]) for (const [width, height] of cases) {
    const { context, page, geometry } = await openFixture(theme, width, height, locale);
    const label = `${theme}/${locale}/${width}x${height}`;
    const state = await measure(page);
    assertComposition(state, label, width);
    assert.deepEqual(await mainGeometry(page), geometry, `${label}: opening preserves main geometry`);
    results.states.push({ label, ...state });
    if (locale === "zh-CN" && [1440, 1024, 390].includes(width)) {
      await page.locator(".skin-dialog").screenshot({ path: path.join(output, `r6-${theme}-${width}.png`) });
      if (theme === "light" && [1440, 390].includes(width)) for (const skin of skins) {
        await page.locator(`.skin-card[data-skin-id="${skin.id}"] .skin-card-previews`).screenshot({ path: path.join(output, `r6-preview-${skin.id}${width === 390 ? "-390" : ""}.png`) });
      }
    }
    // The art must not intercept the click. Main opacity, hide/show and rerender
    // paths must never alter the fixed 50% comparison or its per-card framing.
    await page.locator('.skin-card[data-skin-id="deepseek"] .skin-preview-art').first().click();
    assert.equal(await page.evaluate(() => window.__skinTestHook.getPreference().skinId), "deepseek");
    await page.locator("#skinOpacity").fill("0");
    await page.locator("#skinOpacity").dispatchEvent("input");
    await page.locator("#skinCharactersToggle").uncheck();
    await page.evaluate(async () => { for (const image of document.querySelectorAll(".skin-preview-art")) image.loading = "eager"; await Promise.all([...document.querySelectorAll(".skin-preview-art")].map((image) => image.decode())); });
    assertComposition(await measure(page), `${label}: hidden/0%`, width);
    assert.deepEqual(await mainGeometry(page), geometry, `${label}: selection/controls preserve main geometry`);
    await page.keyboard.press("Escape");
    assert.deepEqual(await mainGeometry(page), geometry, `${label}: close preserves main geometry`);
    await context.close();
  }
  // Actual single-file exporter, opened with all network disabled, in both modes.
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "skin-r6-"));
  const snapshot = path.join(tempDir, "picker.html");
  try {
    writeFileSync(snapshot, renderStaticDashboardHtml(fixture));
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, locale: "zh-CN", reducedMotion: "reduce" });
      await context.addInitScript((value) => localStorage.setItem("codexUsageTheme", value), theme);
      await context.route("**/*", (route) => { if (/^https?:/.test(route.request().url())) { results.externalOfflineRequests.push(route.request().url()); return route.abort(); } return route.continue(); });
      const page = await context.newPage();
      page.on("pageerror", (error) => results.errors.push(error.message));
      await page.goto(pathToFileURL(snapshot).href);
      await page.waitForFunction(() => window.__skinTestHook);
      const geometry = await mainGeometry(page);
      await page.locator("#skinToggle").click();
      await page.evaluate(async () => { for (const image of document.querySelectorAll(".skin-preview-art")) image.loading = "eager"; await Promise.all([...document.querySelectorAll(".skin-preview-art")].map((image) => image.decode())); });
      const state = await measure(page);
      assertComposition(state, `offline/${theme}`, 1024, true);
      results.states.push({ label: `offline/${theme}`, ...state, previews: state.previews.map((p) => ({ ...p, src: p.src.slice(0, 40), dataUrlLength: p.src.length })) });
      await page.locator('.skin-card[data-skin-id="mimo"]').click();
      await page.locator("#resetSkinClassicButton").click();
      assert.equal(await page.evaluate(() => window.__skinTestHook.getPreference().skinId), "classic");
      assert.deepEqual(await mainGeometry(page), geometry, `offline/${theme}: main layout preserved`);
      await context.close();
    }
  } finally {
    // Exact disposable child path under OS temp, created above, never workspace.
    rmSync(snapshot);
    rmdirSync(tempDir);
  }
  const before = JSON.parse(readFileSync(path.join(output, "r6-before-hashes.json"), "utf8"));
  const after = protectedHashes();
  assert.deepEqual(Object.keys(after), Object.keys(before), "no source or asset additions/removals");
  results.protectedChanges = Object.keys(after).filter((file) => before[file] !== after[file]);
  assert.deepEqual(results.protectedChanges.sort(), ["public/skin-picker.js", "public/skins.css"], "only two authorized production files changed since R5");
  results.protectedUnchanged = Object.keys(after).length - results.protectedChanges.length;
  assert.deepEqual(results.errors, [], "zero page errors");
  assert.deepEqual(results.externalOfflineRequests, [], "zero offline external requests");
  writeFileSync(path.join(output, "r6-results.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`PASS: R6 - ${results.states.length} layouts, ${results.compositionChecks} checked states, 20 previews per state; clear faces/torso, independent 50% opacity, intact R5 well, unchanged page layout and forbidden production files, both offline modes.`);
}

try {
  if (process.argv.includes("--references")) await references();
  else if (process.argv.includes("--screens")) await screenshots();
  else await audit();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
