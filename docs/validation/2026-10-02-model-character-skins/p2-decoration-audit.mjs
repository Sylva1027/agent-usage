// P2.1 evidence: the decoration layer must exist out of flow, load only the
// selected skin, and never change dashboard geometry when toggled.
//
// Usage: node docs/validation/2026-10-02-model-character-skins/p2-decoration-audit.mjs

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const playwrightModule =
  process.env.AGENT_USAGE_PLAYWRIGHT_MODULE ||
  path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const { chromium } = await import(pathToFileURL(playwrightModule).href);

// Minimal static file server over public/, so the audit exercises the real
// module graph and MIME handling rather than an inlined snapshot.
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
};
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "skin-p2-"));
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  let filePath = path.join(root, "public", url.pathname === "/" ? "index.html" : url.pathname);
  if (!filePath.startsWith(path.join(root, "public"))) {
    response.writeHead(403).end();
    return;
  }
  let body;
  try {
    body = readFileSync(filePath);
  } catch {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
  response.end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  executablePath: process.env.AGENT_USAGE_EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  locale: "zh-CN",
  timezoneId: "Asia/Shanghai",
  reducedMotion: "reduce",
});
// The dashboard wants live project data; stub it so the audit is deterministic
// and never touches the user's real usage databases.
await context.route("**/api/**", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      asOf: new Date().toISOString(),
      generatedAt: new Date().toISOString(),
      events: [],
      homes: [],
      sessions: [],
      rateLimitObservations: [],
    }),
  }),
);
const page = await context.newPage();
const pageErrors = [];
const requests = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("request", (request) => requests.push(request.url()));

const checks = [];
const detail = {};

try {
  await page.goto(baseUrl, { waitUntil: "load" });
  await page.waitForTimeout(400);

  // 1. The layer exists, outside .shell, out of normal flow.
  const layer = await page.evaluate(() => {
    const node = document.getElementById("skinCharacters");
    if (!node) return null;
    const style = getComputedStyle(node);
    return {
      exists: true,
      insideShell: Boolean(node.closest(".shell")),
      parent: node.parentElement?.tagName,
      position: style.position,
      pointerEvents: style.pointerEvents,
      ariaHidden: node.getAttribute("aria-hidden"),
      zIndex: style.zIndex,
      display: style.display,
    };
  });
  assert.ok(layer, "#skinCharacters must exist");
  assert.equal(layer.insideShell, false, "layer must sit outside .shell");
  assert.equal(layer.position, "fixed", "layer must be fixed");
  assert.equal(layer.pointerEvents, "none", "layer must not intercept clicks");
  assert.equal(layer.ariaHidden, "true");
  checks.push("decoration layer exists outside .shell, fixed, pointer-events none, aria-hidden");
  detail.layer = layer;

  // 2. Default state is the no-skin option, and it requests zero artwork.
  const initial = await page.evaluate(() => ({
    skin: document.documentElement.dataset.skin,
    characters: document.getElementById("skinCharacters").dataset.skinCharacters,
    display: getComputedStyle(document.getElementById("skinCharacters")).display,
  }));
  assert.equal(initial.skin, "classic", "first run must default to the no-skin option");
  assert.equal(initial.display, "none", "no-skin must not display the layer");
  const imageRequests = requests.filter((url) => url.includes("/assets/skins/"));
  assert.deepEqual(imageRequests, [], `no artwork may load for the no-skin option: ${imageRequests.join(", ")}`);
  checks.push("defaults to no-skin and loads zero artwork");
  detail.initial = initial;

  // 3. Geometry must be identical with the layer hidden. Capture a baseline.
  const measure = () =>
    page.evaluate(() => {
      const rect = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return { x: box.x, y: box.y, w: box.width, h: box.height };
      };
      return {
        shell: rect(".shell"),
        topbar: rect(".topbar"),
        body: rect("body"),
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
  const hiddenGeometry = await measure();
  detail.geometryHidden = hiddenGeometry;

  // 4. Selecting a character loads exactly its two light-mode files.
  await page.evaluate(() => window.__skinTestHook?.selectSkin("chatgpt"));
  await page.waitForTimeout(500);
  const active = await page.evaluate(() => {
    const node = document.getElementById("skinCharacters");
    const images = [...node.querySelectorAll("img")].map((image) => ({
      view: image.dataset.view,
      loaded: image.dataset.loaded,
      url: image.dataset.url,
      src: image.getAttribute("src"),
      natural: image.naturalWidth ? `${image.naturalWidth}x${image.naturalHeight}` : null,
    }));
    return { skin: document.documentElement.dataset.skin, characters: node.dataset.skinCharacters, images };
  });
  assert.equal(active.skin, "chatgpt");
  assert.equal(active.characters, "on");
  assert.equal(active.images.length, 2, "layer must hold exactly the two views");
  for (const image of active.images) {
    assert.ok(image.url?.includes("/assets/skins/light/ChatGPT-"), `unexpected url ${image.url}`);
    assert.ok(image.natural, `${image.view} must decode to real dimensions`);
  }
  const lightRequests = requests.filter((url) => url.includes("/assets/skins/"));
  assert.equal(lightRequests.length, 2, `expected exactly 2 artwork requests, saw ${lightRequests.length}`);
  checks.push("selecting one character loads exactly its 2 files for the current mode");
  detail.active = active;

  // 5. Toggling characters must not move a single existing box.
  await page.evaluate(() => window.__skinTestHook?.setShowCharacters(false));
  await page.waitForTimeout(250);
  const afterHide = await measure();
  assert.deepEqual(afterHide.shell, hiddenGeometry.shell, "hiding characters moved .shell");
  assert.deepEqual(afterHide.topbar, hiddenGeometry.topbar, "hiding characters moved .topbar");
  await page.evaluate(() => window.__skinTestHook?.setShowCharacters(true));
  await page.waitForTimeout(250);
  const afterShow = await measure();
  assert.deepEqual(afterShow.shell, hiddenGeometry.shell, "showing characters moved .shell");
  assert.deepEqual(afterShow.topbar, hiddenGeometry.topbar, "showing characters moved .topbar");
  assert.equal(afterShow.scrollWidth, hiddenGeometry.scrollWidth, "characters introduced horizontal overflow");
  checks.push("toggling characters does not move .shell/.topbar or add overflow");
  detail.geometryShown = afterShow;

  // 6. Opacity is applied to the layer only, and 0 survives.
  const opacity = await page.evaluate(async () => {
    window.__skinTestHook?.setOpacity(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const node = document.getElementById("skinCharacters");
    const shell = getComputedStyle(document.querySelector(".shell"));
    return { layer: getComputedStyle(node).opacity, shell: shell.opacity, root: document.documentElement.dataset.skinOpacity };
  });
  assert.equal(opacity.layer, "0", "opacity 0 must be applied, not replaced by the default");
  assert.equal(opacity.root, "0");
  assert.equal(opacity.shell, "1", "opacity must not touch the dashboard");
  checks.push("opacity applies to the layer only and 0 is preserved");
  detail.opacity = opacity;

  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(", ")}`);
  checks.push("no page errors");
} finally {
  await context.close();
  await browser.close();
  server.close();
}

console.log(`${checks.length} checks passed`);
for (const check of checks) console.log(`  PASS ${check}`);
console.log(JSON.stringify(detail, null, 2));
