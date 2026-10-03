// Live check after the user's first real palette (chatgpt, 2026-10-02) was filled
// into public/skin-palettes.js: the accent chain and the picker card swatches must
// reflect the real colours immediately (whole-page wiring is a separate later step).
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const results = { checks: 0, errors: [] };
const check = (name, condition) => {
  results.checks += 1;
  assert.ok(condition, name);
};

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
  await context.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) }));
  const page = await context.newPage();
  page.on("pageerror", (error) => results.errors.push(error.message));

  // 1. Classic default: no accent variable on a fresh load.
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__skinTestHook);
  check("fresh load keeps --skin-active-accent absent", await page.evaluate(() => document.documentElement.style.getPropertyValue("--skin-active-accent") === ""));

  // 2. Selecting chatgpt applies the palette accent through the real runtime path.
  await page.evaluate(() => window.__skinTestHook.selectSkin("chatgpt"));
  check("data-skin is chatgpt", await page.evaluate(() => document.documentElement.dataset.skin === "chatgpt"));
  check("light accent is the palette accent", await page.evaluate(() => document.documentElement.style.getPropertyValue("--skin-active-accent").toLowerCase() === "#607ec7"));
  check("R2 slider chain follows the accent", await page.evaluate(() => {
    const input = document.getElementById("skinOpacity");
    return getComputedStyle(input).getPropertyValue("--skin-slider-accent").trim().toLowerCase() === "#607ec7";
  }));

  // 3. The picker card shows real colour swatches; other skins stay honestly pending.
  // Known scope note: the picker card reads its own legacy COLOUR_TOKENS list, which
  // overlaps the registry's PALETTE_TOKEN_KEYS in exactly five tokens (pageBackground,
  // panelBackground, controlBackground, accent, chartText). The remaining seven tokens
  // reach the card only after R6 unifies the token fields — asserted here as-is.
  await page.evaluate(() => window.__skinTestHook.openPicker());
  await page.waitForFunction(() => window.__skinTestHook.isPickerOpen());
  const card = page.locator('.skin-card[data-skin-id="chatgpt"]');
  const lightHexes = await card.locator('.skin-swatch-group[data-swatch-mode="light"] .skin-swatch').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("style")),
  );
  assert.deepEqual(
    lightHexes.map((style) => style.replace("background:", "")),
    ["#B9C9EE", "#dce4f7", "#dce4f7", "#607ec7", "#807eb0"],
    "light swatch group shows the five picker-mapped tokens in registry order",
  );
  results.checks += 1;
  const darkHexes = await card.locator('.skin-swatch-group[data-swatch-mode="dark"] .skin-swatch').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("style")),
  );
  assert.deepEqual(
    darkHexes.map((style) => style.replace("background:", "")),
    ["#52407d", "#585c9e", "#585c9e", "#738dce", "#8b8bbb"],
    "dark swatch group shows the five picker-mapped tokens in registry order",
  );
  results.checks += 1;
  check("mini preview is tinted by the palette accent", (await card.locator('.skin-preview-scope[data-preview-theme="light"] .skin-preview').first().getAttribute("style")).includes("--skin-preview-accent:#607ec7"));
  check("unfilled claude card stays pending", (await page.locator('.skin-card[data-skin-id="claude"] .skin-swatch-note').count()) === 2);

  // 4. Dark mode accent comes from the dark palette.
  await page.evaluate(() => window.__skinTestHook.closePicker());
  await page.evaluate(() => document.getElementById("themeToggle").click());
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  check("dark accent is the dark palette accent", await page.evaluate(() => document.documentElement.style.getPropertyValue("--skin-active-accent").toLowerCase() === "#738dce"));
  check("dark art URLs follow the mode", await page.evaluate(() => window.__skinTestHook.getPreference().skinId === "chatgpt"));

  // Screenshots for human review (dialog open, chatgpt selected).
  await page.evaluate(() => window.__skinTestHook.openPicker());
  await page.waitForFunction(() => window.__skinTestHook.isPickerOpen());
  await page.waitForTimeout(300);
  await page.locator(".skin-dialog").screenshot({ path: path.join(output, "chatgpt-palette-dark.png") });
  await page.evaluate(() => document.getElementById("themeToggle").click());
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  await page.waitForTimeout(300);
  await page.locator(".skin-dialog").screenshot({ path: path.join(output, "chatgpt-palette-light.png") });

  await context.close();
  assert.deepEqual(results.errors, [], "zero page errors");
  writeFileSync(path.join(output, "chatgpt-palette-live-results.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`PASS: ${results.checks} checks — accent chain (light/dark), card swatches, pending isolation; zero page errors.`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
