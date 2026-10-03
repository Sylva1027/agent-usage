// P3.3 acceptance: switching continuity and recovery.
//
// The first P3 pass ticked P3.3 without exercising these three user-visible
// paths, and all three were broken:
//   * hide characters -> show again lost the artwork permanently (the layer
//     forgot the URL while keeping `src` removed, so it never re-attached it and
//     still reported loaded=1);
//   * no-skin -> the same skin again had the same failure;
//   * a failed image request was cached forever, so it could never recover.
//
// This audit drives the real runtime through every one of those paths and checks
// the DOM actually holds decodable pixels at the end of each one.
//
// Usage: node docs/validation/2026-10-02-model-character-skins/p3-recovery-audit.mjs

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

// One specific front-view file can be made to fail on demand, so a transient
// image error can be injected and then lifted without touching the real tree.
// The failure test uses Mimo, which nothing earlier in this run has fetched:
// Chromium happily serves an already-decoded URL from its memory cache without
// consulting the route, so an injection against a warm file would silently be a
// no-op and the audit would pass for the wrong reason.
let blockingFront = false;
await context.route("**/assets/skins/light/Mimo-lineart.webp", (route) =>
  blockingFront ? route.abort("failed") : route.continue(),
);

const page = await context.newPage();
const pageErrors = [];
const artworkRequests = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("request", (request) => {
  if (request.url().includes("/assets/skins/")) artworkRequests.push(request.url().split("/").pop());
});

const checks = [];
const detail = {};

/** Read the decoration layer exactly as a user would see it. */
function readLayer(label) {
  return page.evaluate((tag) => {
    const layer = document.getElementById("skinCharacters");
    const shell = document.querySelector(".shell").getBoundingClientRect();
    return {
      label: tag,
      skin: document.documentElement.dataset.skin,
      characters: layer.dataset.skinCharacters,
      shell: { w: Math.round(shell.width), h: Math.round(shell.height) },
      images: [...layer.querySelectorAll("img")].map((image) => ({
        view: image.dataset.view,
        loaded: image.dataset.loaded,
        hasSrc: Boolean(image.getAttribute("src")),
        natural: image.naturalWidth * image.naturalHeight,
        visible: getComputedStyle(image).visibility === "visible",
        modeDir: /\/assets\/skins\/([^/]+)\//.exec(image.getAttribute("src") || "")?.[1] ?? null,
      })),
    };
  }, label);
}

/** The original defect's signature: claiming success without any pixels. */
function assertNoPhantomArtwork(state, step) {
  for (const image of state.images) {
    if (image.loaded === "1") {
      assert.ok(
        image.hasSrc && image.natural > 0,
        `${step}: ${image.view} claims loaded=1 without decodable artwork (${JSON.stringify(image)})`,
      );
    }
    if (image.hasSrc) {
      assert.ok(image.natural > 0 || image.loaded === "0", `${step}: ${image.view} holds an undecoded source`);
    }
  }
}

function assertBothViewsDecoded(state, step) {
  assert.equal(state.images.length, 2, `${step}: the layer must hold both views`);
  for (const image of state.images) {
    assert.equal(image.loaded, "1", `${step}: ${image.view} must decode (${JSON.stringify(image)})`);
    assert.ok(image.hasSrc, `${step}: ${image.view} must keep its source attached`);
    assert.ok(image.natural > 0, `${step}: ${image.view} must have real pixels`);
    assert.equal(image.visible, true, `${step}: ${image.view} must be visible`);
  }
}

try {
  await page.goto(baseUrl, { waitUntil: "load" });
  await page.waitForTimeout(400);

  const call = async (name, arg, wait = 400) => {
    await page.evaluate(([method, value]) => window.__skinTestHook[method](value), [name, arg]);
    await page.waitForTimeout(wait);
  };

  const baseline = await page.evaluate(() => {
    const shell = document.querySelector(".shell").getBoundingClientRect();
    return { w: Math.round(shell.width), h: Math.round(shell.height) };
  });

  // --- 1. Baseline: a fresh character load actually draws. -------------------
  await call("selectSkin", "grok");
  await call("setShowCharacters", true, 700);
  const first = await readLayer("first load");
  assertNoPhantomArtwork(first, "first load");
  assertBothViewsDecoded(first, "first load");
  assert.deepEqual(first.shell, baseline, "a normal skin switch must not move the dashboard");
  checks.push("a fresh character load decodes both views");
  detail.first = first;

  // --- 2. Hide characters, then show them again. ----------------------------
  await call("setShowCharacters", false, 300);
  const hidden = await readLayer("hidden");
  assert.equal(hidden.characters, "off");
  assert.equal(
    hidden.images.filter((image) => image.loaded === "1").length,
    0,
    "hiding characters must unload the artwork",
  );
  assertNoPhantomArtwork(hidden, "hidden");
  await call("setShowCharacters", true, 700);
  const reshown = await readLayer("re-shown");
  assertNoPhantomArtwork(reshown, "re-shown");
  assertBothViewsDecoded(reshown, "re-shown");
  assert.equal(reshown.skin, "grok");
  assert.deepEqual(reshown.shell, baseline, "re-showing characters must not move the dashboard");
  checks.push("hide then show re-attaches both views instead of leaving a blank layer");
  detail.reshown = reshown;

  // --- 3. No-skin, then the same skin again. --------------------------------
  await call("selectSkin", "classic", 300);
  const classic = await readLayer("classic");
  assert.equal(classic.skin, "classic");
  assert.equal(
    classic.images.filter((image) => image.loaded === "1").length,
    0,
    "no-skin must leave no loaded artwork",
  );
  assert.equal(classic.images.filter((image) => image.hasSrc).length, 0, "no-skin must hold no sources");
  await call("selectSkin", "grok", 700);
  const returned = await readLayer("returned from classic");
  assertNoPhantomArtwork(returned, "returned from classic");
  assertBothViewsDecoded(returned, "returned from classic");
  assert.deepEqual(returned.shell, baseline, "coming back from no-skin must not move the dashboard");
  checks.push("returning to no-skin and back restores the same character's artwork");
  detail.returned = returned;

  // --- 4. Theme round trip on the same skin. --------------------------------
  await page.evaluate(() => document.getElementById("themeToggle").click());
  await page.waitForTimeout(700);
  const dark = await readLayer("dark");
  assert.equal(dark.skin, "grok");
  assertNoPhantomArtwork(dark, "dark");
  assertBothViewsDecoded(dark, "dark");
  for (const image of dark.images) assert.equal(image.modeDir, "dark", "the dark theme must load dark-mode art");
  await page.evaluate(() => document.getElementById("themeToggle").click());
  await page.waitForTimeout(700);
  const backToLight = await readLayer("back to light");
  assertNoPhantomArtwork(backToLight, "back to light");
  assertBothViewsDecoded(backToLight, "back to light");
  for (const image of backToLight.images) {
    assert.equal(image.modeDir, "light", "returning to the light theme must load light-mode art");
  }
  assert.deepEqual(backToLight.shell, baseline, "the theme round trip must not move the dashboard");
  checks.push("a mode round trip reloads the matching artwork for both views");
  detail.modeRoundTrip = { dark, backToLight };

  // --- 5. A failing view hides itself and leaves the rest healthy. ----------
  // Mimo has not been fetched yet in this run, so the abort below really is the
  // first load of that file and the failure it produces is genuine.
  await call("selectSkin", "classic", 300);
  blockingFront = true;
  await call("selectSkin", "mimo", 800);
  const failed = await readLayer("front view failed");
  assertNoPhantomArtwork(failed, "front view failed");
  assert.equal(failed.skin, "mimo");
  assert.equal(failed.characters, "on", "one failed file must not switch the whole layer off");
  const failedSide = failed.images.find((image) => image.view === "side");
  const failedFront = failed.images.find((image) => image.view === "front");
  assert.equal(failedSide.loaded, "1", "the healthy view must still decode");
  assert.equal(failedFront.loaded, "0", "the failed view must not claim success");
  assert.equal(failedFront.hasSrc, false, "the failed view must drop its source");
  assert.equal(failedFront.visible, false, "the failed view must stay invisible");
  assert.deepEqual(failed.shell, baseline, "a failed asset must not move the dashboard");
  assert.deepEqual(pageErrors, [], `a failed image must not raise page errors: ${pageErrors.join(", ")}`);
  checks.push("a failed view hides itself, keeps its sibling and leaves the page healthy");
  detail.failed = failed;

  // --- 6. Lifting the error and re-applying the same skin recovers. ---------
  blockingFront = false;
  await call("selectSkin", "mimo", 900);
  const recovered = await readLayer("recovered");
  assertNoPhantomArtwork(recovered, "recovered");
  assertBothViewsDecoded(recovered, "recovered");
  assert.deepEqual(recovered.shell, baseline, "recovery must not move the dashboard");
  checks.push("re-applying the same skin after an error recovers both views");
  detail.recovered = recovered;

  // --- 7. The run as a whole stayed healthy. --------------------------------
  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(", ")}`);
  detail.artworkRequests = artworkRequests.length;
  checks.push("no page errors across the whole switching cycle");
} finally {
  await context.close();
  await browser.close();
  server.close();
}

console.log(`${checks.length} recovery checks passed`);
for (const check of checks) console.log(`  PASS ${check}`);
console.log(JSON.stringify(detail, null, 2));
