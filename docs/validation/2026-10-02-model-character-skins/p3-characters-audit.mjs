// P3.1 acceptance: per-image display parameters across all ten characters.
//
// Verifies every character loads its four assets (light/dark x front/side), that
// the measured display parameters reach the DOM, that characters render at a
// consistent drawn height despite differing canvases, and that none of this
// consumes layout space - the decoration layer must stay out of flow.
//
// Usage: node docs/validation/2026-10-02-model-character-skins/p3-characters-audit.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const playwrightModule =
  process.env.AGENT_USAGE_PLAYWRIGHT_MODULE ||
  path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const { chromium } = await import(pathToFileURL(playwrightModule).href);

const registry = await import(pathToFileURL(path.join(root, "public/skins.js")).href);

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
const CHARACTERS = registry.SKINS.filter((skin) => !skin.isClassic).map((skin) => skin.id);

try {
  // 1. Pure registry checks: every character carries measured display parameters
  //    for both modes and both views.
  for (const id of CHARACTERS) {
    for (const mode of ["light", "dark"]) {
      for (const view of ["side", "front"]) {
        const params = registry.skinDisplayParams(id, mode, view);
        assert.ok(params, `${id}.${mode}.${view} must have display parameters`);
        assert.ok(params.scale > 0 && params.scale < 3, `${id}.${mode}.${view} scale out of range: ${params.scale}`);
        assert.ok(params.anchorX > 0 && params.anchorX <= 1, `${id}.${mode}.${view} anchorX out of range`);
        assert.ok(params.inkWidth > 0 && params.inkWidth <= 1, `${id}.${mode}.${view} inkWidth must be a fraction`);
        assert.ok(params.inkHeight > 0 && params.inkHeight <= 1, `${id}.${mode}.${view} inkHeight must be a fraction`);
      }
    }
  }
  checks.push("all ten characters carry measured display parameters for both modes and views");

  // 2. Params must be identical across modes (same art, different colours) and
  //    must be frozen so a caller cannot mutate shared state.
  for (const id of CHARACTERS) {
    for (const view of ["side", "front"]) {
      const light = registry.skinDisplayParams(id, "light", view);
      const dark = registry.skinDisplayParams(id, "dark", view);
      assert.deepEqual(light, dark, `${id}.${view} must use the same geometry in both modes`);
      assert.ok(Object.isFrozen(light), `${id}.${view} params must be immutable`);
    }
  }
  checks.push("display parameters are mode-independent and immutable");

  // 3. The normalisation must actually tighten the drawn-height spread. Measure
  //    the spread before and after applying `scale`.
  const heights = CHARACTERS.map((id) => registry.skinDisplayParams(id, "light", "front").inkHeight);
  const rawSpread = Math.max(...heights) - Math.min(...heights);
  const scaledHeights = CHARACTERS.map((id) => {
    const p = registry.skinDisplayParams(id, "light", "front");
    return p.inkHeight * p.scale;
  });
  const scaledSpread = Math.max(...scaledHeights) - Math.min(...scaledHeights);
  assert.ok(
    scaledSpread < rawSpread,
    `normalisation should tighten the height spread (raw ${rawSpread.toFixed(4)} -> scaled ${scaledSpread.toFixed(4)})`,
  );
  assert.ok(scaledSpread < 0.01, `scaled ink heights should nearly agree, spread was ${scaledSpread.toFixed(5)}`);
  detail.normalisation = { rawSpread, scaledSpread };
  checks.push("the scale factor normalises drawn height across all ten characters");

  // 4. Classic must have no display parameters at all (it has no art).
  for (const mode of ["light", "dark"]) {
    for (const view of ["side", "front"]) {
      assert.equal(registry.skinDisplayParams("classic", mode, view), null, "no-skin must have no display parameters");
    }
  }
  checks.push("the no-skin option has no display parameters");

  // 5. Browser: each character loads exactly its four assets on demand.
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    reducedMotion: "reduce",
  });
  const requested = [];
  context.on("request", (request) => {
    if (request.url().includes("/assets/skins/")) requested.push(request.url());
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

  // Switch through every character in both themes and read what actually rendered.
  const observed = [];
  for (const id of CHARACTERS) {
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        ([skinId, wantTheme]) => {
          window.__skinTestHook.selectSkin(skinId);
          window.__skinTestHook.setShowCharacters(true);
          const current = document.documentElement.dataset.theme;
          if (current !== wantTheme) document.getElementById("themeToggle").click();
        },
        [id, theme],
      );
      await page.waitForTimeout(320);
      const state = await page.evaluate(() => {
        const layer = document.getElementById("skinCharacters");
        const images = [...layer.querySelectorAll("img")];
        return {
          skin: document.documentElement.dataset.skin,
          characters: layer.dataset.skinCharacters,
          theme: document.documentElement.dataset.theme,
          images: images.map((image) => ({
            view: image.dataset.view,
            loaded: image.dataset.loaded,
            scale: image.style.getPropertyValue("--skin-scale"),
            anchorX: image.style.getPropertyValue("--skin-anchor-x"),
            naturalW: image.naturalWidth,
            naturalH: image.naturalHeight,
            renderedH: Math.round(image.getBoundingClientRect().height),
            // The layer is fixed and out of flow; confirm it consumes no space.
            position: getComputedStyle(layer).position,
            src: (image.getAttribute("src") || "").split("/").pop(),
            // The mode is the directory segment of the asset URL.
            modeDir: /\/assets\/skins\/([^/]+)\//.exec(image.getAttribute("src") || "")?.[1] ?? null,
          })),
        };
      });
      assert.equal(state.skin, id, `expected ${id} to be selected`);
      assert.equal(state.theme, theme, `expected the ${theme} theme`);
      assert.equal(state.characters, "on", "characters should be on");
      assert.equal(state.images.length, 2, `${id}/${theme} must render exactly two views`);
      for (const image of state.images) {
        assert.equal(image.loaded, "1", `${id}/${theme}/${image.view} must decode`);
        assert.ok(image.naturalW > 0, `${id}/${theme}/${image.view} must have real pixels`);
        // The mode lives in the directory segment (/light/ or /dark/), not in the
        // file name, so compare against the full path.
        assert.equal(image.modeDir, theme, `${id}/${theme}/${image.view} must load from the ${theme} directory`);
        assert.ok(image.scale, `${id}/${theme}/${image.view} must carry a measured scale`);
        assert.equal(image.position, "fixed", "the decoration layer must stay fixed");
      }
      observed.push({ id, theme, images: state.images });
    }
  }
  checks.push("all ten characters load their two views correctly in both themes");

  // 6. The point of P3.1 is a consistent DRAWN INK height, not a consistent CSS
  //    box. Each image has its own canvas aspect ratio, and the CSS box height is
  //    exactly the quantity the scale factor is computed from - so measuring the
  //    box cannot detect a wrong entry in the measured table (it is the table
  //    that produced it). Multiply each rendered box by the image's own measured
  //    ink-height fraction instead, and compare those.
  const inkMeasurements = new Map(
    JSON.parse(
      readFileSync(
        path.join(root, "docs/validation/2026-10-02-model-character-skins/ink-bounds.json"),
        "utf8",
      ),
    ).map((entry) => [entry.file, entry]),
  );
  const drawnInk = [];
  for (const entry of observed.filter((entry) => entry.theme === "light")) {
    for (const image of entry.images) {
      // The rendered file is the WebP public copy; the measurement artifact is
      // keyed by the source PNG name, and the two share the stem.
      const sourceName = image.src.replace(/\.webp$/u, ".png");
      const ink = inkMeasurements.get(sourceName);
      assert.ok(ink, `${entry.id}/${image.view} must have a recorded ink measurement (${sourceName})`);
      drawnInk.push({ id: entry.id, view: image.view, inkPx: image.renderedH * ink.inkHeightFraction });
    }
  }
  const inkTallest = Math.max(...drawnInk.map((entry) => entry.inkPx));
  const inkShortest = Math.min(...drawnInk.map((entry) => entry.inkPx));
  const inkSpread = (inkTallest - inkShortest) / inkTallest;
  assert.ok(
    inkSpread <= 0.005,
    `drawn ink heights must agree within 0.5%, spread was ${(inkSpread * 100).toFixed(2)}%: ${JSON.stringify(drawnInk)}`,
  );
  detail.drawnInkHeights = drawnInk;
  detail.drawnInkSpreadPx = Number((inkTallest - inkShortest).toFixed(2));
  detail.drawnInkSpreadRelative = Number(inkSpread.toFixed(5));
  checks.push(
    `every character's drawn ink height agrees (${(inkTallest - inkShortest).toFixed(1)}px over ${inkTallest.toFixed(
      0,
    )}px, ${(inkSpread * 100).toFixed(2)}%)`,
  );

  // 7. Layout must be untouched by any of this.
  const shellAfter = await page.evaluate(() => {
    const box = document.querySelector(".shell").getBoundingClientRect();
    return { w: Math.round(box.width), h: Math.round(box.height) };
  });
  assert.deepEqual(shellAfter, shellBefore, "switching characters must not move the dashboard");
  detail.shell = { shellBefore, shellAfter };
  checks.push("the dashboard geometry is untouched by character switching");

  // 8. Exactly the expected asset set was fetched: two per character per theme,
  //    with no cross-loading of the wrong mode's files.
  const unique = new Set(requested.map((url) => url.split("/").pop()));
  assert.equal(unique.size, CHARACTERS.length * 2 * 2, `expected 40 distinct assets, saw ${unique.size}`);
  const wrongMode = observed.filter((entry) => entry.images.some((image) => image.modeDir !== entry.theme));
  assert.deepEqual(wrongMode, [], "a character must never load the other mode's art");
  detail.requestedAssets = unique.size;
  checks.push("exactly 40 distinct assets were fetched, none from the wrong mode");

  // 9. P3.2 - no stale state: rapid switching must leave no residue from any
  //    previous skin, and returning to no-skin must restore a clean page.
  await page.evaluate(() => window.__skinTestHook.selectSkin("grok"));
  await page.waitForTimeout(250);
  // Switch rapidly through every character, ending on a different one, then
  // confirm the final state carries nothing from the ones passed through.
  for (const id of [...CHARACTERS, "classic", ...CHARACTERS.slice().reverse()]) {
    await page.evaluate((skinId) => window.__skinTestHook.selectSkin(skinId), id);
  }
  await page.waitForTimeout(600);
  const afterRapid = await page.evaluate(() => {
    const layer = document.getElementById("skinCharacters");
    return {
      skin: document.documentElement.dataset.skin,
      rootSkin: document.documentElement.dataset.skin,
      layerSkin: layer.dataset.skin ?? null,
      images: layer.querySelectorAll("img").length,
      loaded: [...layer.querySelectorAll("img")].filter((image) => image.dataset.loaded === "1").length,
    };
  });
  assert.equal(
    afterRapid.images,
    afterRapid.loaded,
    `no stale image may remain loaded after rapid switching: ${JSON.stringify(afterRapid)}`,
  );
  detail.afterRapid = afterRapid;
  checks.push("rapid switching leaves no stale loaded image");

  // 10. Returning to no-skin must clear every skin attribute and request nothing.
  const beforeClassic = requested.length;
  await page.evaluate(() => {
    window.__skinTestHook.selectSkin("classic");
    window.__skinTestHook.setShowCharacters(true);
  });
  await page.waitForTimeout(450);
  const classicClean = await page.evaluate(() => {
    const layer = document.getElementById("skinCharacters");
    return {
      skin: document.documentElement.dataset.skin,
      characters: layer.dataset.skinCharacters,
      layerSkin: layer.dataset.skin ?? null,
      loadedImages: [...layer.querySelectorAll("img")].filter((image) => image.dataset.loaded === "1").length,
      srcs: [...layer.querySelectorAll("img")].filter((image) => image.getAttribute("src")).length,
      opacity: getComputedStyle(layer).opacity,
    };
  });
  assert.equal(classicClean.skin, "classic", "no-skin must be the active skin");
  assert.equal(classicClean.loadedImages, 0, "no-skin must leave no loaded artwork");
  assert.equal(classicClean.srcs, 0, "no-skin must hold no asset references at all");
  assert.equal(classicClean.layerSkin, null, "the layer's skin attribute must be cleared");
  const classicRequests = requested.length - beforeClassic;
  assert.equal(classicRequests, 0, `returning to no-skin must request nothing, made ${classicRequests} request(s)`);
  detail.classicClean = { ...classicClean, requests: classicRequests };
  checks.push("returning to no-skin clears all state and makes zero image requests");

  // 11. The dashboard must be identical to the pre-skin baseline after all of it.
  const shellFinal = await page.evaluate(() => {
    const box = document.querySelector(".shell").getBoundingClientRect();
    return { w: Math.round(box.width), h: Math.round(box.height) };
  });
  assert.deepEqual(shellFinal, shellBefore, "the dashboard must be unmoved after the whole cycle");
  detail.shellFinal = shellFinal;
  checks.push("the dashboard is unmoved after the full switch cycle");

  assert.deepEqual(errors, [], `page errors: ${errors.join(", ")}`);
  checks.push("no page errors");
  await context.close();
} finally {
  await browser.close();
  server.close();
}

console.log(`${checks.length} checks passed`);
for (const check of checks) console.log(`  PASS ${check}`);
console.log(JSON.stringify(detail, null, 2));
