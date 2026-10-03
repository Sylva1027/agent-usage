import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SKINS } from "../../../public/skins.js";
import { assertSelfContainedStaticHtml, renderStaticDashboardHtml } from "../../../src/static-export.js";

const output = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(output, "../../..");
const fixture = { generatedAt: "2026-10-02T00:00:00Z", asOf: "2026-10-02T00:00:00Z", events: [], homes: [], sessions: [], warnings: [], rateLimitObservations: [] };
const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".webp": "image/webp" };
const server = createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  const file = path.resolve(root, "public", `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(`${path.join(root, "public")}${path.sep}`)) return response.writeHead(404).end();
  try {
    response.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" });
    response.end(readFileSync(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const temporary = mkdtempSync(path.join(os.tmpdir(), "skin-face-centering-"));
const snapshot = path.join(temporary, "dashboard.html");
const offlineHtml = renderStaticDashboardHtml(fixture);
assertSelfContainedStaticHtml(offlineHtml);
writeFileSync(snapshot, offlineHtml);
const { chromium } = await import(pathToFileURL(path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs")));
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
const characters = SKINS.filter((skin) => !skin.isClassic);
const faces = Object.fromEntries(characters.map((skin) => [skin.id, skin.variants.light.display]));
const cases = [[2560, 1080], [2290, 1260], [2290, 900], [1920, 1080], [1600, 900], [1600, 600], [1440, 900], [1024, 768], [721, 900], [720, 900], [390, 844]];
const results = { states: [], checks: [], errors: [], externalRequests: [], revealSamples: 0 };
const faceCrops = [];

async function tick(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function geometry(page) {
  return page.evaluate(() => [...document.querySelectorAll(".shell,.topbar,.toolbar,.metrics,.metric,.panel,.main-grid,.bottom-grid,.theme-toggle")].map((node) => {
    const rect = node.getBoundingClientRect();
    return { name: node.id || node.className, x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
  }));
}

async function ready(page) {
  await page.waitForFunction(() => [...document.querySelectorAll("#skinCharacters img")].length === 2 && [...document.querySelectorAll("#skinCharacters img")].every((image) => image.dataset.loaded === "1" && image.naturalWidth > 0));
  await tick(page);
}

async function inspect(page) {
  return page.evaluate((faces) => {
    const layer = document.getElementById("skinCharacters"), shell = document.querySelector(".shell");
    const viewport = layer.getBoundingClientRect(), board = shell.getBoundingClientRect();
    const hidden = getComputedStyle(layer).display === "none";
    const skin = document.documentElement.dataset.skin;
    const images = [...layer.querySelectorAll("img")].map((image) => {
      const params = faces[skin][image.dataset.view], { faceLeft, faceX, faceRight } = params.face;
      const box = image.getBoundingClientRect();
      const left = Math.min(viewport.right, Math.max(viewport.left, board.left));
      const right = Math.min(viewport.right, Math.max(left, board.right));
      const desired = image.dataset.view === "side" ? (viewport.left + left) / 2 : (right + viewport.right) / 2;
      const min = viewport.left + (faceX - faceLeft) * box.width;
      const max = viewport.right - (faceRight - faceX) * box.width;
      const expected = Math.min(max, Math.max(min, desired));
      const actual = box.left + faceX * box.width;
      return { view: image.dataset.view, width: box.width, height: box.height, expectedHeight: innerHeight * 0.78 * params.scale, desired, expected, actual, error: Math.abs(actual - expected), constrained: Math.abs(desired - expected) > 0.01, faceLeft: box.left + faceLeft * box.width, faceRight: box.left + faceRight * box.width, centered: image.dataset.faceCentered, bottom: box.bottom, visibility: getComputedStyle(image).visibility, transformTransition: getComputedStyle(image).transitionProperty };
    });
    return { skin, hidden, layer: viewport.toJSON(), board: board.toJSON(), opacity: getComputedStyle(layer).opacity, images };
  }, faces);
}

function verify(state) {
  if (state.hidden) return;
  for (const image of state.images) {
    assert.equal(image.centered, "1");
    assert.ok(image.error <= 1, `${state.skin}/${image.view}: ${image.error}px error`);
    assert.ok(image.faceLeft >= state.layer.left - 1 && image.faceRight <= state.layer.right + 1, "face must fit viewport");
    assert.ok(Math.abs(image.height - image.expectedHeight) < 1, "height normalization must be unchanged");
    assert.ok(Math.abs(image.bottom - state.layer.bottom) < 1, "bottom baseline must be unchanged");
    assert.ok(!image.transformTransition.includes("transform"), "position must not animate");
  }
}

async function open({ offline = false, reducedMotion = "reduce", noObserver = false, restored = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 2290, height: 1260 }, reducedMotion, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  await context.addInitScript(({ noObserver, restored }) => {
    if (noObserver) window.ResizeObserver = undefined;
    if (restored) localStorage.setItem("codexUsageSkinV1", JSON.stringify({ version: 1, skinId: "chatgpt", showCharacters: true, opacity: 0.5 }));
    window.__faceRevealSamples = [];
    new MutationObserver((changes) => {
      for (const change of changes) {
        const image = change.target;
        if (image.dataset.loaded === "1" && image.closest("#skinCharacters") && getComputedStyle(image.parentElement).display !== "none") {
          window.__faceRevealSamples.push({ view: image.dataset.view, centered: image.dataset.faceCentered, width: image.getBoundingClientRect().width });
        }
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-loaded"] });
  }, { noObserver, restored });
  const requests = [];
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "file:") return route.continue();
    if (offline || url.origin !== base) {
      results.externalRequests.push(url.href);
      return route.abort();
    }
    if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) });
    return route.continue();
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("requestfailed", (request) => consoleErrors.push(`${request.url()}: ${request.failure()?.errorText}`));
  page.on("pageerror", (error) => results.errors.push(error.message));
  page.on("request", (request) => { if (request.url().includes("/assets/skins/")) requests.push(request.url()); });
  await page.goto(offline ? pathToFileURL(snapshot).href : base);
  await page.waitForFunction(() => window.__skinTestHook).catch(async (error) => {
    console.log(JSON.stringify({ errors: results.errors, consoleErrors, text: await page.locator("body").innerText(), scripts: await page.evaluate(() => [...document.scripts].map((script) => script.src)) }));
    throw error;
  });
  return { context, page, requests };
}

try {
  for (const offline of [false, true]) {
    const { context, page, requests } = await open({ offline });
    for (const [width, height] of cases) {
      await page.setViewportSize({ width, height });
      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => { if (document.documentElement.dataset.theme !== theme) document.getElementById("themeToggle").click(); window.__skinTestHook.resetToClassic(); }, theme);
        await tick(page);
        const baseline = await geometry(page);
        for (const skin of characters) {
          await page.evaluate((id) => window.__skinTestHook.selectSkin(id), skin.id);
          await ready(page);
          const state = await inspect(page);
          assert.equal(state.hidden, width <= 720, `${skin.id}/${theme}/${width} phone visibility`);
          verify(state);
          assert.deepEqual(await geometry(page), baseline, `${skin.id}/${width}/${theme} must not move dashboard frames`);
          results.states.push({ offline, width, height, theme, ...state });
          if (!offline && width === 2290 && height === 1260 && theme === "light") {
            for (const view of ["side", "front"]) {
              const x = view === "side" ? 0 : state.board.right;
              const cropWidth = view === "side" ? state.board.left : width - state.board.right;
              const image = await page.screenshot({ clip: { x, y: 250, width: cropWidth, height: 400 } });
              faceCrops.push({ name: skin.name, view, image: image.toString("base64") });
            }
          }
          if (!offline && width === 2290 && height === 1260 && ["chatgpt", "muse", "mimo"].includes(skin.id)) await page.screenshot({ path: path.join(output, `${skin.id}-${theme}-2290.png`) });
          if (!offline && width === 1600 && height === 900 && skin.id === "chatgpt") await page.screenshot({ path: path.join(output, `chatgpt-${theme}-1600.png`) });
        }
      }
    }
    await page.setViewportSize({ width: 2290, height: 1260 });
    await tick(page);
    verify(await inspect(page));
    const imageRequests = requests.length;
    for (const width of [2200, 2100, 1920, 1800, 1600, 1500, 1440, 1300, 1024, 721, 720, 721, 1600, 2290]) {
      await page.setViewportSize({ width, height: 1260 }); await tick(page); verify(await inspect(page));
    }
    assert.equal(requests.length, imageRequests, "resizing must not re-request artwork");
    const fixed = await inspect(page);
    await page.evaluate(() => scrollTo(0, 500)); await tick(page);
    assert.deepEqual((await inspect(page)).images, fixed.images, "scrolling must not change fixed artwork");
    await page.evaluate(() => scrollTo(0, 0));
    // Existing board moves (a future layout or browser environment) must be
    // measured rather than assuming a centred 1440px shell.
    await page.evaluate(() => { document.querySelector(".shell").style.width = "1300px"; document.querySelector(".shell").style.marginLeft = "500px"; });
    await tick(page); verify(await inspect(page));
    await page.evaluate(() => document.querySelector(".shell").removeAttribute("style"));
    await tick(page); verify(await inspect(page));
    const beforeOpacity = (await inspect(page)).images;
    await page.evaluate(() => window.__skinTestHook.setOpacity(0)); await tick(page);
    assert.equal((await inspect(page)).opacity, "0");
    assert.deepEqual((await inspect(page)).images, beforeOpacity);
    await page.evaluate(() => { window.__skinTestHook.setOpacity(0.5); window.__skinTestHook.setShowCharacters(false); });
    assert.equal(await page.locator("#skinCharacters").getAttribute("data-skin-characters"), "off");
    await page.evaluate(() => window.__skinTestHook.setShowCharacters(true)); await ready(page); verify(await inspect(page));
    await page.evaluate(() => { for (const id of ["chatgpt", "claude", "mimo", "grok"]) window.__skinTestHook.selectSkin(id); });
    await ready(page); assert.equal((await inspect(page)).skin, "grok"); verify(await inspect(page));
    await page.evaluate(() => { window.__skinTestHook.selectSkin("mimo"); window.__skinTestHook.resetToClassic(); });
    await tick(page); await tick(page);
    assert.equal(await page.locator("#skinCharacters img[src]").count(), 0);
    await page.evaluate(() => window.__skinTestHook.selectSkin("chatgpt")); await ready(page); verify(await inspect(page));
    await page.reload(); await ready(page); verify(await inspect(page));
    const revealed = await page.evaluate(() => window.__faceRevealSamples);
    assert.ok(revealed.length >= 2);
    assert.ok(revealed.every((entry) => entry.centered === "1" && entry.width > 0), "restored images must be positioned before they become visible");
    results.revealSamples += revealed.length;
    results.checks.push(`${offline ? "offline" : "online"}: 220 states; resize, hidden-phone restoration, scroll, asymmetric board, opacity, show/hide, stale loads, classic return, and reload`);
    await context.close();
    console.log(`${offline ? "Offline" : "Online"} 220-state matrix passed.`);
  }
  for (const options of [{ reducedMotion: "no-preference", restored: true }, { noObserver: true }]) {
    const { context, page } = await open(options);
    if (!options.restored) await page.evaluate(() => window.__skinTestHook.selectSkin("chatgpt"));
    await ready(page); verify(await inspect(page));
    await page.setViewportSize({ width: 1440, height: 700 }); await tick(page); verify(await inspect(page));
    await page.setViewportSize({ width: 2290, height: 900 }); await tick(page); verify(await inspect(page));
    results.checks.push(options.noObserver ? "resize fallback without ResizeObserver" : "no-preference and first-paint restored skin");
    await context.close();
  }
  {
    const { context, page } = await open();
    await page.evaluate(() => document.getElementById("languageToggle").click());
    await page.evaluate(() => window.__skinTestHook.selectSkin("muse"));
    await ready(page); verify(await inspect(page));
    assert.equal(await page.locator("html").getAttribute("lang"), "en-US");
    await page.evaluate(() => {
      document.documentElement.style.scrollbarGutter = "stable both-edges";
      document.documentElement.style.overflowY = "scroll";
      document.body.style.minHeight = "3000px";
    });
    await tick(page); verify(await inspect(page));
    await page.evaluate(() => {
      document.documentElement.style.removeProperty("scrollbar-gutter");
      document.documentElement.style.removeProperty("overflow-y");
      document.body.style.removeProperty("min-height");
    });
    await tick(page); verify(await inspect(page));
    await page.setViewportSize({ width: 1600, height: 1400 }); await tick(page); verify(await inspect(page));
    results.checks.push("English UI, scrollbar gutter appearance/removal, and tall narrow desktop");
    await context.close();
  }
  const { context, page } = await open();
  let blocked = true;
  await context.route("**/assets/skins/light/Mimo-lineart.webp", (route) => blocked ? route.abort("failed") : route.continue());
  await page.evaluate(() => window.__skinTestHook.selectSkin("mimo"));
  await page.waitForFunction(() => document.querySelector('#skinCharacters img[data-view="side"]').dataset.loaded === "1" && !document.querySelector('#skinCharacters img[data-view="front"]').hasAttribute("src"));
  blocked = false;
  await page.evaluate(() => window.__skinTestHook.selectSkin("mimo"));
  await ready(page); verify(await inspect(page));
  results.checks.push("one-view failure does not remove its sibling; failed view retries and recentres");
  await context.close();
  const gallery = await browser.newPage({ viewport: { width: 850, height: 2110 }, deviceScaleFactor: 1 });
  for (let group = 0; group < 2; group += 1) {
    const content = faceCrops.slice(group * 10, group * 10 + 10).map((crop) => `<section><div>${crop.name} · ${crop.view} · 2290px light</div><img src="data:image/png;base64,${crop.image}"></section>`).join("");
    await gallery.setContent(`<!doctype html><style>body{margin:0;display:grid;grid-template-columns:repeat(2,425px);font-family:Arial}section{height:422px}div{height:22px;line-height:22px;font-size:13px}img{display:block;width:425px;height:400px}</style>${content}`);
    await gallery.evaluate(() => Promise.all([...document.images].map((image) => image.decode())));
    await gallery.screenshot({ path: path.join(output, `rendered-faces-${group + 1}.png`) });
  }
  await gallery.close();
  assert.deepEqual(results.errors, []);
  assert.deepEqual(results.externalRequests, []);
  const before = JSON.parse(readFileSync(path.join(output, "before-hashes.json")));
  const changed = Object.entries(before).filter(([relative, hash]) => createHash("sha256").update(readFileSync(path.join(root, relative))).digest("hex") !== hash).map(([relative]) => relative);
  assert.deepEqual(changed.sort(), ["public/skin-ui.js", "public/skins.css", "public/skins.js", "test/skins.test.js"].sort());
  results.protected = { changed, unchanged: Object.keys(before).length - changed.length };
  writeFileSync(path.join(output, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ states: results.states.length, checks: results.checks.length, errors: results.errors.length, protected: results.protected }));
} finally {
  await browser.close();
  server.close();
  unlinkSync(snapshot);
  rmdirSync(temporary);
}
