// R3 replaces the old 11-card/5+5+1 assertions; old P2 evidence is preserved.
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
const cases = [[1440, 900], [1280, 800], [1024, 768], [1023, 768], [768, 1024], [390, 844]];
const ids = ["chatgpt", "claude", "glm", "gemini", "deepseek", "kimi", "qwen", "grok", "muse", "mimo"];
const results = { cases: [], errors: [], externalOfflineRequests: [] };
const tempDir = mkdtempSync(path.join(os.tmpdir(), "skin-r3-"));
const snapshot = path.join(tempDir, "picker.html");

async function mainGeometry(page) {
  return page.evaluate(() => [...document.querySelectorAll(".shell, .topbar, .toolbar, .metrics, .main-grid, .bottom-grid, .panel, .metric")].map((node) => {
    const b = node.getBoundingClientRect(); return { className: node.className, x: b.x, y: b.y, width: b.width, height: b.height };
  }));
}

async function matrix(page, width, label) {
  const value = await page.evaluate(() => {
    const grid = document.querySelector("#skinGrid");
    const dialog = document.querySelector(".skin-dialog");
    const reference = document.querySelector("#importDialog .dialog");
    const material = (node) => { const s = getComputedStyle(node); return { background: s.backgroundImage, radius: s.borderRadius, shadow: s.boxShadow, padding: s.padding }; };
    const cards = [...grid.querySelectorAll(".skin-card")];
    const rows = new Map();
    for (const card of cards) { const y = Math.round(card.getBoundingClientRect().y); rows.set(y, (rows.get(y) || 0) + 1); }
    const box = dialog.getBoundingClientRect();
    return {
      ids: cards.map((card) => card.dataset.skinId), rows: [...rows.values()], columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
      previews: cards.map((card) => [...card.querySelectorAll(".skin-preview-cell")].map((cell) => {
        const stage = cell.querySelector(".skin-preview"); const image = cell.querySelector("img");
        return { mode: cell.dataset.previewTheme, height: stage.getBoundingClientRect().height, background: getComputedStyle(stage).backgroundColor, src: image.getAttribute("src"), opacity: getComputedStyle(image).opacity };
      })),
      notes: cards.map((card) => card.querySelectorAll("[data-swatch-mode]").length),
      selected: cards.filter((card) => card.getAttribute("aria-checked") === "true").map((card) => card.dataset.skinId),
      registry: window.__skinTestHook.getSelectableSkins(), preference: window.__skinTestHook.getPreference(),
      gridOverflowY: grid.scrollHeight - grid.clientHeight, gridOverflowX: grid.scrollWidth - grid.clientWidth,
      dialogOverflowY: dialog.scrollHeight - dialog.clientHeight, dialogOverflowX: dialog.scrollWidth - dialog.clientWidth,
      pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dialogBox: { x: box.x, y: box.y, width: box.width, height: box.height },
      controlsVisible: ["#skinOpacity", "#resetSkinClassicButton", "#closeSkinDialogButton"].every((selector) => { const b = document.querySelector(selector).getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth; }),
      material: material(dialog), referenceMaterial: material(reference),
    };
  });
  assert.deepEqual(value.ids, ids, `${label}: ten cards, exact registry order`);
  assert.equal(value.registry.length, 11, `${label}: classic remains registered`);
  assert.ok(value.registry.includes("classic"));
  assert.equal(value.columns, width >= 1024 ? 5 : width > 720 ? 3 : 2, `${label}: breakpoint columns`);
  assert.ok(value.controlsVisible, `${label}: controls always visible`);
  assert.ok(Math.max(value.gridOverflowX, value.dialogOverflowX, value.pageOverflowX) <= 1, `${label}: no horizontal scroll`);
  assert.equal(value.dialogOverflowY, 0, `${label}: outer dialog does not scroll`);
  assert.deepEqual(value.material, value.referenceMaterial, `${label}: shared dialog material`);
  assert.ok(value.notes.every((count) => count === 2), `${label}: both palette groups visible`);
  for (const previews of value.previews) {
    assert.deepEqual(previews.map((p) => p.mode), ["light", "dark"]);
    assert.ok(previews.every((p) => p.height >= 104 && p.opacity === "0.5"), `${label}: previews not compressed`);
    assert.notEqual(previews[0].background, previews[1].background, `${label}: independent light/dark base`);
  }
  if (width >= 1024) {
    assert.deepEqual(value.rows, [5, 5], `${label}: exactly two desktop rows`);
    assert.ok(value.gridOverflowY <= 1, `${label}: whole desktop comparison fits`);
  }
  results.cases.push({ label, ...value });
  return value;
}

try {
  for (const theme of ["light", "dark"]) for (const locale of ["zh-CN", "en-US"]) for (const [width, height] of cases) {
    const context = await browser.newContext({ viewport: { width, height }, locale, timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
    await context.addInitScript(({ theme, locale }) => { localStorage.setItem("codexUsageTheme", theme); localStorage.setItem("codexUsageLocale", locale); }, { theme, locale });
    await context.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) }));
    const page = await context.newPage(); page.on("pageerror", (error) => results.errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForFunction(() => window.__skinTestHook); await page.evaluate(() => document.fonts.ready);
    const geometry = await mainGeometry(page);
    await page.locator("#skinToggle").click();
    const label = `${theme}/${locale}/${width}x${height}`;
    const initial = await matrix(page, width, label);
    assert.equal(initial.preference.skinId, "classic"); assert.deepEqual(initial.selected, []);
    assert.deepEqual(await mainGeometry(page), geometry, `${label}: opening does not change main layout`);
    await page.locator('.skin-card[data-skin-id="deepseek"]').click();
    const selected = await matrix(page, width, `${label}: selected`);
    assert.deepEqual(selected.selected, ["deepseek"]); assert.equal(selected.preference.skinId, "deepseek");
    assert.deepEqual(await mainGeometry(page), geometry, `${label}: selection does not change main layout`);
    await page.locator("#resetSkinClassicButton").click();
    assert.equal(await page.evaluate(() => window.__skinTestHook.getPreference().skinId), "classic");
    assert.equal(await page.locator('.skin-card[aria-checked="true"]').count(), 0);
    assert.equal(await page.locator("#skinGrid").evaluate((grid) => grid.scrollTop), 0, `${label}: classic returns to top`);
    if (locale === "zh-CN" && [1440, 1024, 390].includes(width)) {
      if (width >= 1024) await page.waitForFunction(() => [...document.querySelectorAll(".skin-preview-art")].every((img) => img.complete && img.naturalWidth > 0));
      await page.locator(".skin-dialog").screenshot({ path: path.join(output, `r3-${theme}-${width}.png`) });
    }
    await page.keyboard.press("Escape"); assert.equal(await page.evaluate(() => document.activeElement.id), "skinToggle");
    assert.equal(await page.evaluate(() => window.__skinTestHook.isPickerOpen()), false);
    if (width === 390) {
      await page.evaluate(() => window.__skinTestHook.selectSkin("mimo"));
      await page.locator("#skinToggle").click();
      await page.waitForFunction(() => document.activeElement.dataset.skinId === "mimo");
      assert.equal(await page.evaluate(() => {
        const card = document.querySelector('.skin-card[data-skin-id="mimo"]').getBoundingClientRect();
        const grid = document.querySelector("#skinGrid").getBoundingClientRect();
        return card.top >= grid.top - 1 && card.bottom <= grid.bottom + 1;
      }), true, `${label}: selected last card is visible on reopening`);
      await page.keyboard.press("Escape");
    }
    await context.close();
  }
  writeFileSync(snapshot, renderStaticDashboardHtml(fixture));
  const offline = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await offline.route("**/*", (route) => { if (/^https?:/.test(route.request().url())) { results.externalOfflineRequests.push(route.request().url()); return route.abort(); } return route.continue(); });
  const page = await offline.newPage(); page.on("pageerror", (error) => results.errors.push(error.message));
  await page.goto(pathToFileURL(snapshot).href); await page.waitForFunction(() => window.__skinTestHook); await page.locator("#skinToggle").click();
  const fileMatrix = await matrix(page, 1440, "file:// 1440");
  assert.ok(fileMatrix.previews.flat().every((p) => p.src.startsWith("data:image/webp;base64,")));
  await page.waitForFunction(() => [...document.querySelectorAll(".skin-preview-art")].every((img) => img.complete && img.naturalWidth > 0));
  await page.locator('.skin-card[data-skin-id="chatgpt"]').click(); assert.equal(await page.evaluate(() => window.__skinTestHook.getPreference().skinId), "chatgpt");
  await page.locator("#resetSkinClassicButton").click(); assert.equal(await page.evaluate(() => window.__skinTestHook.getPreference().skinId), "classic");
  await offline.close(); assert.deepEqual(results.errors, []); assert.deepEqual(results.externalOfflineRequests, []);
  writeFileSync(path.join(output, "r3-results.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`PASS: ${results.cases.length} matrix states; 24 viewport/theme/language combinations; zero page errors and offline external requests.`);
} finally {
  await browser.close(); await new Promise((resolve) => server.close(resolve));
  try { unlinkSync(snapshot); } catch {}
  rmdirSync(tempDir);
}
