import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, unlink, rmdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lastStaticExportStats, renderStaticDashboardHtml } from "../../../src/static-export.js";

const output = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(output, "../../..");
const publicRoot = path.join(root, "public");
const fixture = {
  generatedAt: "2026-10-03T00:00:00.000Z",
  asOf: "2026-10-03T00:00:00.000Z",
  events: [],
  homes: [],
  sessions: [],
  warnings: [],
  rateLimitObservations: [],
};
const offered = ["chatgpt", "claude", "deepseek", "kimi", "muse"];
const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".webp": "image/webp" };
const server = createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  const file = path.resolve(publicRoot, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(`${publicRoot}${path.sep}`)) return response.writeHead(404).end();
  try {
    response.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" });
    response.end(readFileSync(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const temporary = await mkdtemp(path.join(os.tmpdir(), "codex-usage-v060-"));
const offlineFile = path.join(temporary, "snapshot.html");
await writeFile(offlineFile, renderStaticDashboardHtml(fixture));
const results = { checks: 0, states: [], errors: [], offlineRequests: [], export: lastStaticExportStats() };
const check = (condition, description) => {
  results.checks++;
  assert.ok(condition, description);
};
let browser;
try {
  const playwrightFile = process.env.AGENT_USAGE_PLAYWRIGHT_MODULE || path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
  const { chromium } = await import(pathToFileURL(playwrightFile).href);
  browser = await chromium.launch({ executablePath: process.env.AGENT_USAGE_EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
  for (const surface of ["online", "offline"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", reducedMotion: "reduce" });
    if (surface === "online") await context.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) }));
    else await context.route(/^https?:/, (route) => { results.offlineRequests.push(route.request().url()); return route.abort(); });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on("pageerror", (error) => results.errors.push(`${surface}: ${error.message}`));
    await page.goto(surface === "online" ? `http://127.0.0.1:${server.address().port}/` : pathToFileURL(offlineFile).href);
    await page.waitForFunction(() => Boolean(window.__skinTestHook));
    for (const mode of ["light", "dark"]) {
      if (mode === "dark") await page.locator("#themeToggle").click();
      await page.locator("#skinToggle").click();
      assert.deepEqual(await page.locator(".skin-card").evaluateAll((cards) => cards.map((card) => card.dataset.skinId)), offered);
      results.checks++;
      for (const skin of offered) {
        await page.locator(`.skin-card[data-skin-id="${skin}"]`).click();
        await page.waitForFunction(() => [...document.querySelectorAll(".skin-preview-art")].every((image) => image.complete && image.naturalWidth > 0));
        check(await page.locator(".skin-card-selected-dot").count() === 1, `${surface}/${mode}/${skin}: one selected dot`);
        check(await page.locator('.skin-card[aria-checked="true"]').getAttribute("data-skin-id") === skin, "selection follows clicked card");
        check(await page.locator(".skin-card-selected-dot").textContent() === "", "selection has no visible text");
        const appearance = await page.locator(`.skin-card[data-skin-id="${skin}"] .skin-card-selected-dot`).evaluate((node) => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, glow: getComputedStyle(node).boxShadow }));
        check(appearance.width === 7 && appearance.height === 7 && appearance.glow !== "none", "selected dot has round-sized geometry and glow");
        const preference = await page.evaluate(() => window.__skinTestHook.getPreference());
        check(preference.skinId === skin, "runtime selection agrees with picker");
      }
      check(await page.locator(".skin-swatch").count() === 0, "no colour swatches");
      check(await page.locator(".skin-preview").count() === 10, "five dual-mode thumbnails");
      await page.locator('.skin-card[data-skin-id="kimi"]').click();
      await page.locator(".skin-dialog").screenshot({ path: path.join(output, `${surface}-${mode}.png`) });
      await page.locator("#closeSkinDialogButton").click();
      await page.reload();
      await page.waitForFunction(() => window.__skinTestHook?.getPreference().skinId === "kimi");
      check(await page.locator("html").getAttribute("data-skin") === "kimi", "selected skin restores after reload");
    }
    for (const [width, height] of [[1440, 900], [1024, 768], [768, 900], [390, 844], [1440, 320]]) {
      await page.setViewportSize({ width, height });
      await page.locator("#skinToggle").click();
      const layout = await page.locator(".skin-dialog").evaluate((dialog) => {
        const grid = dialog.querySelector(".skin-grid");
        const well = dialog.querySelector(".skin-gallery-well");
        const cards = [...grid.querySelectorAll(".skin-card")].map((card) => card.getBoundingClientRect());
        const frame = dialog.getBoundingClientRect();
        return { rows: new Set(cards.map((card) => Math.round(card.top))).size, wellHeight: well.getBoundingClientRect().height, cardHeight: Math.max(...cards.map((card) => card.height)), overflowX: grid.scrollWidth - grid.clientWidth, scrolls: grid.scrollHeight > grid.clientHeight + 1, frameFits: frame.top >= -1 && frame.bottom <= window.innerHeight + 1 };
      });
      check(layout.overflowX <= 1 && layout.frameFits, `${surface}/${width}: no horizontal overflow or clipped dialog`);
      if (width >= 1024) check(layout.rows === 1, "desktop five skins share one row");
      if (width >= 1024 && height > 320) check(Math.abs(layout.wellHeight - layout.cardHeight - 28) < 2, "well hugs one row plus padding");
      if (height === 320) check(layout.scrolls, "short screen scrolls card area");
      results.states.push({ surface, width, height, ...layout });
      await page.locator("#closeSkinDialogButton").click();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator("#skinToggle").click();
    await page.locator('.skin-card[data-skin-id="kimi"]').focus();
    await page.keyboard.press("End");
    check(await page.locator('.skin-card[aria-checked="true"]').getAttribute("data-skin-id") === "muse", "End selects final offered skin");
    await page.keyboard.press("ArrowRight");
    check(await page.locator('.skin-card[aria-checked="true"]').getAttribute("data-skin-id") === "chatgpt", "keyboard wraps across five skins");
    await page.locator("#resetSkinClassicButton").click();
    check(await page.locator(".skin-card-selected-dot").count() === 0, "simple mode has no selected character");
    check(await page.locator("#resetSkinClassicButton").getAttribute("aria-pressed") === "true", "simple mode marks its own control");
    await page.locator("#closeSkinDialogButton").click();
    check(await page.locator('[data-recent-option="上周"]').textContent() === "上一个7d", "Chinese previous window label");
    await page.locator("#languageToggle").click();
    check(await page.locator('[data-recent-option="上周"]').textContent() === "Last 7d", "English label remains Last 7d");
    await page.locator("#skinToggle").click();
    check(await page.locator("#skinDialogTitle").textContent() === "Waifu", "English dialog name");
    await context.close();
  }
  check(results.errors.length === 0, `no page errors: ${results.errors.join("; ")}`);
  check(results.offlineRequests.length === 0, "offline snapshot makes no HTTP requests");
  check(results.export.inlinedSkinAssets === 40, "all registry assets remain embedded");
  await writeFile(path.join(output, "ui-results.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`UI audit PASS: ${results.checks} checks; ${results.states.length} layouts; no page errors or offline HTTP requests`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await unlink(offlineFile);
  await rmdir(temporary);
}
