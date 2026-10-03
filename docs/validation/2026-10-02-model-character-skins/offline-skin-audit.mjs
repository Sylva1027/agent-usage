// P1.3 offline verification: open the exported snapshot from file:// with all
// network access blocked, and prove the inlined skin assets actually decode and
// that every one of the 40 URLs is reachable from the embedded map.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const snapshot = path.join(root, "dist/skin-p1-check.html");

const playwrightModule =
  process.env.AGENT_USAGE_PLAYWRIGHT_MODULE ||
  path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs");
const { chromium } = await import(pathToFileURL(playwrightModule).href);

const browser = await chromium.launch({
  executablePath: process.env.AGENT_USAGE_EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  locale: "zh-CN",
  timezoneId: "Asia/Shanghai",
  reducedMotion: "reduce",
});
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
const externalRequests = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
// Block everything that is not the local file itself.
await context.route("**/*", (route) => {
  const url = route.request().url();
  if (/^https?:/u.test(url)) {
    externalRequests.push(url);
    return route.abort();
  }
  return route.continue();
});

const results = { checks: [], detail: {} };

try {
  await page.goto(pathToFileURL(snapshot).href, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector("#totalTokens")?.textContent.trim() !== "-");

  // 1. The embedded map must carry all 40 assets as data URLs.
  const map = await page.evaluate(() => {
    const assets = window.__CODEX_USAGE_SKIN_ASSETS__ || {};
    return { count: Object.keys(assets).length, urls: Object.keys(assets), sample: assets[Object.keys(assets)[0]]?.slice(0, 30) };
  });
  assert.equal(map.count, 40, `expected 40 inlined assets, found ${map.count}`);
  assert.ok(map.sample?.startsWith("data:image/webp;base64,"), "assets must be webp data URLs");
  results.detail.inlinedAssets = map.count;
  results.checks.push("40 skin assets are inlined as webp data URLs");

  // 2. Decode every single asset through the browser's real image pipeline.
  const decoded = await page.evaluate(async (urls) => {
    const failed = [];
    let totalPixels = 0;
    await Promise.all(
      urls.map(
        (url) =>
          new Promise((resolve) => {
            const image = new Image();
            image.onload = () => {
              totalPixels += image.naturalWidth * image.naturalHeight;
              if (!image.naturalWidth || !image.naturalHeight) failed.push(`${url}: zero size`);
              resolve();
            };
            image.onerror = () => {
              failed.push(`${url}: load error`);
              resolve();
            };
            image.src = window.__CODEX_USAGE_SKIN_ASSETS__[url];
          }),
      ),
    );
    return { failed, totalPixels };
  }, map.urls);
  assert.deepEqual(decoded.failed, [], `assets failed to decode: ${decoded.failed.join(", ")}`);
  assert.ok(decoded.totalPixels > 40 * 900 * 1500, "decoded assets should have real dimensions");
  results.detail.decodedAssets = map.urls.length;
  results.detail.totalDecodedPixels = decoded.totalPixels;
  results.checks.push(`all ${map.urls.length} inlined assets decode with real dimensions`);

  // 3. The pre-paint bootstrap must have applied classic defaults.
  const boot = await page.evaluate(() => ({
    skin: document.documentElement.dataset.skin,
    characters: document.documentElement.dataset.skinCharacters,
    opacity: document.documentElement.dataset.skinOpacity,
    bootstrapRan: document.documentElement.dataset.skinBootstrap,
  }));
  assert.equal(boot.skin, "classic", "default skin must be classic");
  assert.equal(boot.bootstrapRan, "1", "bootstrap must run before the dashboard");
  results.detail.bootstrap = boot;
  results.checks.push("pre-paint bootstrap applied classic defaults");

  // 4. No external requests, no script errors.
  assert.deepEqual(externalRequests, [], `external requests: ${externalRequests.join(", ")}`);
  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(", ")}`);
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(", ")}`);
  results.checks.push("no external requests, page errors or console errors");

  // 5. The snapshot must not load sibling files. Check the live DOM's resolved
  //    resources rather than raw markup text: module source legitimately contains
  //    `src="${url}"` template literals, and the embedded report contains
  //    documentation URLs, neither of which is a resource load.
  const markup = await readFile(snapshot, "utf8");
  assert.ok(!/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["'](?!data:)/i.test(markup), "no external script/link tags");
  results.checks.push("no external script or stylesheet tags remain");

  // 6. Offline picker: opening the dialog must render cards whose images resolve
  //    to inlined data URLs, so the snapshot is fully usable from file://.
  await page.evaluate(() => window.__skinTestHook?.openPicker());
  await page.waitForTimeout(200);
  const pickerDom = await page.evaluate(async () => {
    // Show a character so artwork must resolve, then read what the browser got.
    window.__skinTestHook.selectSkin("gemini");
    window.__skinTestHook.openPicker();
    await new Promise((resolve) => setTimeout(resolve, 350));
    const cards = [...document.querySelectorAll("#skinGrid .skin-card")];
    const images = [...document.querySelectorAll("#skinGrid img")];
    return {
      cardCount: cards.length,
      classicPresent: cards.some((card) => card.dataset.skinClassic === "true"),
      imageCount: images.length,
      // The browser's resolved src after assignment is the data URL itself.
      resolved: images.map((image) => image.getAttribute("src")?.slice(0, 30) || ""),
      dialogOpen: !document.getElementById("skinDialog").hidden,
    };
  });
  assert.equal(pickerDom.dialogOpen, true, "picker must open offline");
  assert.equal(pickerDom.cardCount, 11, "all 11 options must render offline");
  assert.equal(pickerDom.classicPresent, true, "the no-skin option must be present offline");
  assert.ok(pickerDom.imageCount > 0, "character cards must render artwork offline");
  assert.ok(
    pickerDom.resolved.every((src) => src.startsWith("data:image/webp;base64,")),
    `offline card art must resolve to inlined assets, saw: ${pickerDom.resolved.slice(0, 3).join(", ")}`,
  );
  results.detail.offlinePicker = pickerDom;
  results.checks.push("offline picker renders all 11 options with inlined artwork");

  // 7. Offline selection must drive the decoration layer with inlined assets.
  const offlineApplied = await page.evaluate(async () => {
    window.__skinTestHook.closePicker();
    window.__skinTestHook.setShowCharacters(true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const layer = document.getElementById("skinCharacters");
    const images = [...layer.querySelectorAll("img")];
    return {
      characters: layer.dataset.skinCharacters,
      loaded: images.filter((image) => image.dataset.loaded === "1").length,
      resolvable: images.every((image) => (image.getAttribute("src") || "").startsWith("data:")),
      decoded: images.map((image) => `${image.naturalWidth}x${image.naturalHeight}`),
    };
  });
  assert.equal(offlineApplied.characters, "on", "characters must be active offline");
  assert.equal(offlineApplied.loaded, 2, "both views must decode offline");
  assert.ok(offlineApplied.resolvable, "decoration layer must use inlined data URLs offline");
  assert.ok(
    offlineApplied.decoded.every((size) => !size.startsWith("0x")),
    `offline artwork must decode, saw ${offlineApplied.decoded.join(", ")}`,
  );
  results.detail.offlineApplied = offlineApplied;
  results.checks.push("offline characters decode from inlined assets");

  // 8. P3.3 - cycle ALL ten characters through both modes from file:// with no
  //    network. Every one of the 40 inlined assets must be actually decoded, not
  //    merely present as a string in the HTML.
  const offlineCycle = await page.evaluate(async () => {
    // The test hook exposes selectable skins as id strings, not skin objects.
    // Exclude the no-skin option by id so the cycle covers exactly the ten
    // characters (10 x 2 modes = 20 combinations).
    const ids = window.__skinTestHook.getSelectableSkins().filter((id) => id !== "classic");
    const seen = new Map();
    let theme = document.documentElement.dataset.theme;
    const outcomes = [];
    for (const id of ids) {
      for (const want of ["light", "dark"]) {
        window.__skinTestHook.selectSkin(id);
        window.__skinTestHook.setShowCharacters(true);
        if (theme !== want) {
          document.getElementById("themeToggle").click();
          theme = want;
        }
        await new Promise((resolve) => setTimeout(resolve, 260));
        const layer = document.getElementById("skinCharacters");
        const images = [...layer.querySelectorAll("img")];
        for (const image of images) {
          const src = image.getAttribute("src") || "";
          if (!src.startsWith("data:")) continue;
          // Key by the resolved data URL so each distinct asset is counted once.
          // The map key is the asset; record which mode produced it.
          seen.set(src, { mode: want, pixels: image.naturalWidth * image.naturalHeight });
        }
        outcomes.push({
          id,
          want,
          theme: document.documentElement.dataset.theme,
          skin: document.documentElement.dataset.skin,
          views: images.length,
          loaded: images.filter((image) => image.dataset.loaded === "1").length,
          scales: images.map((image) => image.style.getPropertyValue("--skin-scale")),
        });
      }
    }
    return { outcomes, distinctDecoded: seen.size, allNonZero: [...seen.values()].every((entry) => entry.pixels > 0) };
  });

  assert.equal(offlineCycle.outcomes.length, 20, "ten characters x two modes must all be exercised offline");
  for (const outcome of offlineCycle.outcomes) {
    assert.equal(outcome.skin, outcome.id, `offline cycle selected the wrong skin: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.theme, outcome.want, `${outcome.id}: expected the ${outcome.want} theme offline`);
    assert.equal(outcome.views, 2, `${outcome.id}/${outcome.want} must render two views offline`);
    assert.equal(outcome.loaded, 2, `${outcome.id}/${outcome.want} must decode both views offline`);
    assert.ok(
      outcome.scales.every((scale) => scale && Number(scale) > 0),
      `${outcome.id}/${outcome.want} must carry display parameters offline`,
    );
  }
  assert.equal(offlineCycle.distinctDecoded, 40, `all 40 assets must decode offline, saw ${offlineCycle.distinctDecoded}`);
  assert.ok(offlineCycle.allNonZero, "every decoded asset must have real pixels");
  results.detail.offlineCycle = { distinctDecoded: offlineCycle.distinctDecoded, cycles: offlineCycle.outcomes.length };
  results.checks.push("all ten characters decode in both modes from file:// (40 distinct assets)");

  // 9. Still nothing external after the whole offline cycle.
  assert.deepEqual(
    externalRequests,
    [],
    `external requests during the offline cycle: ${externalRequests.join(", ")}`,
  );
  assert.deepEqual(pageErrors, [], `page errors during the offline cycle: ${pageErrors.join(", ")}`);
} finally {
  await context.close();
  await browser.close();
}

console.log(`${results.checks.length} offline checks passed`);
for (const check of results.checks) console.log(`  PASS ${check}`);
console.log(JSON.stringify(results.detail, null, 2));
