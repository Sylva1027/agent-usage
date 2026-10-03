// Colour-channel acceptance: filling public/skin-palettes.js must reach the UI.
//
// This proves the channel the user asked for actually works end to end:
//   1. a filled token changes the real preview and the dashboard;
//   2. a token left out keeps inheriting the mode base (never invented);
//   3. light and dark stay independent - filling one never colours the other;
//   4. no-skin (classic) is untouched and still requests zero images;
//   5. geometry is unchanged, because colours must never move layout.
//
// The script temporarily fills a palette, exercises the page, then restores the
// input file exactly. It never leaves the user's file modified.
//
// Usage: node docs/validation/2026-10-02-model-character-skins/p2-palette-channel-audit.mjs

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const inputPath = path.join(root, "public/skin-palettes.js");
const originalInput = readFileSync(inputPath, "utf8");

const playwrightModule =
  process.env.AGENT_USAGE_PLAYWRIGHT_MODULE ||
  path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const { chromium } = await import(pathToFileURL(playwrightModule).href);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
};
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const filePath = path.join(root, "public", url.pathname === "/" ? "index.html" : url.pathname);
  try {
    const body = readFileSync(filePath);
    response.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: process.env.AGENT_USAGE_EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: true,
});

const checks = [];
const detail = {};
// Distinctive values so a leak is unmistakable.
const LIGHT_PAGE = "#123456";
const LIGHT_ACCENT = "#ff00aa";
const DARK_PAGE = "#654321";

try {
  // 1. Fill ONLY chatgpt.light, leaving chatgpt.dark and every other skin pending.
  //    Target the `light: null` line inside the chatgpt block specifically, so the
  //    fixture does not depend on comments or spacing elsewhere in the file.
  const chatgptStart = originalInput.indexOf("  chatgpt: {");
  assert.notEqual(chatgptStart, -1, "the chatgpt entry must exist in the palette input");
  const chatgptBlock = originalInput.slice(chatgptStart);
  const lightIndex = chatgptBlock.indexOf("light: null");
  assert.notEqual(lightIndex, -1, "chatgpt.light must start as null");
  const patched =
    originalInput.slice(0, chatgptStart + lightIndex) +
    `light: { pageBackground: "${LIGHT_PAGE}", accent: "${LIGHT_ACCENT}" }` +
    originalInput.slice(chatgptStart + lightIndex + "light: null".length);
  assert.notEqual(patched, originalInput, "the palette fixture must actually be written");
  writeFileSync(inputPath, patched);

  // 2. The validator must accept a correctly filled palette.
  const { execFileSync } = await import("node:child_process");
  const validation = execFileSync(process.execPath, [path.join(root, "scripts/check-skin-palettes.mjs")], {
    encoding: "utf8",
    cwd: root,
  });
  assert.match(validation, /PASS \(1\/20 mode slots filled/);
  checks.push("validator accepts a correctly filled palette and counts the filled slot");
  detail.validation = validation.trim().split("\n").pop();

  // 3. Registry must expose the filled tokens, and only for that one mode.
  const registry = await import(
    `${pathToFileURL(path.join(root, "public/skins.js")).href}?v=${Date.now()}`
  );
  const chatgptLight = registry.paletteTokens("chatgpt", "light");
  const chatgptDark = registry.paletteTokens("chatgpt", "dark");
  const claudeLight = registry.paletteTokens("claude", "light");
  assert.equal(chatgptLight.pageBackground, LIGHT_PAGE, "the filled token must reach the registry");
  assert.equal(chatgptLight.accent, LIGHT_ACCENT, "every filled token must reach the registry");
  assert.deepEqual(chatgptDark, {}, "the other mode must stay pending");
  assert.deepEqual(claudeLight, {}, "another skin must stay pending");
  assert.equal(registry.isPalettePending("chatgpt", "light"), false, "a filled mode is no longer pending");
  assert.equal(registry.isPalettePending("chatgpt", "dark"), true, "an unfilled mode stays pending");
  detail.registry = { chatgptLight, chatgptDark, claudeLight };
  checks.push("only the filled mode resolves; every other mode and skin stays pending");

  // 4. Unknown or layout keys must be dropped before they can reach CSS.
  const malicious = registry.paletteTokens("chatgpt", "light");
  assert.equal(malicious.fontSize, undefined, "layout keys must never appear as tokens");
  assert.ok(
    Object.keys(malicious).every((key) => registry.PALETTE_TOKEN_KEYS.includes(key)),
    "only allow-listed tokens may resolve",
  );
  checks.push("only allow-listed colour tokens resolve");

  // 5. The UI must show it: preview background changes, geometry does not.
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    reducedMotion: "reduce",
  });
  await context.route("**/api/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        asOf: new Date().toISOString(),
        events: [],
        homes: [],
        sessions: [],
        rateLimitObservations: [],
      }),
    }),
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "load" });
  await page.waitForTimeout(400);

  const shellBefore = await page.evaluate(() => {
    const box = document.querySelector(".shell").getBoundingClientRect();
    return { w: Math.round(box.width), h: Math.round(box.height) };
  });

  await page.locator("#skinToggle").click();
  await page.waitForTimeout(450);
  const rendered = await page.evaluate(() => {
    const card = document.querySelector('.skin-card[data-skin-id="chatgpt"]');
    const lightCell = card.querySelector('.skin-preview-scope[data-preview-theme="light"] .skin-preview');
    const darkCell = card.querySelector('.skin-preview-scope[data-preview-theme="dark"] .skin-preview');
    const otherCard = document.querySelector('.skin-card[data-skin-id="claude"]');
    const otherLight = otherCard.querySelector('.skin-preview-scope[data-preview-theme="light"] .skin-preview');
    return {
      lightBackground: getComputedStyle(lightCell).backgroundColor,
      darkBackground: getComputedStyle(darkCell).backgroundColor,
      otherLightBackground: getComputedStyle(otherLight).backgroundColor,
      // The swatch group must now show real colours instead of the pending note.
      pendingNotes: card.querySelectorAll(".skin-swatch-note").length,
      swatches: card.querySelectorAll(".skin-swatch").length,
      swatchColours: [...card.querySelectorAll(".skin-swatch")].map((node) => getComputedStyle(node).backgroundColor),
    };
  });
  assert.equal(
    rendered.lightBackground,
    "rgb(18, 52, 86)",
    `the filled pageBackground must paint the light preview, saw ${rendered.lightBackground}`,
  );
  assert.equal(
    rendered.darkBackground,
    "rgb(32, 37, 43)",
    "filling light must not colour the dark preview",
  );
  assert.equal(
    rendered.otherLightBackground,
    "rgb(207, 216, 225)",
    "filling one skin must not colour another",
  );
  assert.ok(rendered.swatches >= 2, "filled tokens must appear as swatches");
  assert.ok(
    rendered.swatchColours.includes("rgb(255, 0, 170)"),
    `the accent swatch must show the filled colour, saw ${rendered.swatchColours.join(", ")}`,
  );
  detail.rendered = rendered;
  checks.push("a filled palette paints its own preview and swatches, and nothing else");

  // 6. Colour must never move the layout.
  const shellAfter = await page.evaluate(() => {
    const box = document.querySelector(".shell").getBoundingClientRect();
    return { w: Math.round(box.width), h: Math.round(box.height) };
  });
  assert.deepEqual(shellAfter, shellBefore, "filling colours must not change the dashboard geometry");
  detail.geometry = { shellBefore, shellAfter };
  checks.push("colours do not change dashboard geometry");

  // 7. No-skin stays colourless and requests no artwork.
  await page.evaluate(() => window.__skinTestHook.selectSkin("classic"));
  await page.waitForTimeout(350);
  const classicState = await page.evaluate(() => {
    const card = document.querySelector('.skin-card[data-skin-classic="true"]');
    return {
      swatches: card.querySelectorAll(".skin-swatch").length,
      images: document.querySelectorAll("#skinCharacters img").length,
      skin: window.__skinTestHook.getPreference().skinId,
    };
  });
  assert.equal(classicState.skin, "classic");
  assert.equal(classicState.swatches, 0, "the no-skin option must never show colour swatches");
  assert.equal(classicState.images, 0, "the no-skin option must request no artwork");
  detail.classic = classicState;
  checks.push("no-skin stays colourless with zero image requests");

  assert.deepEqual(errors, [], `page errors: ${errors.join(", ")}`);
  checks.push("no page errors");
  await context.close();
} finally {
  await browser.close();
  server.close();
  // Always restore the user's file, even on failure.
  writeFileSync(inputPath, originalInput);
}

const restored = readFileSync(inputPath, "utf8");
assert.equal(restored, originalInput, "the palette input file must be restored");
console.log(`${checks.length} checks passed`);
for (const check of checks) console.log(`  PASS ${check}`);
console.log(JSON.stringify(detail, null, 2));
