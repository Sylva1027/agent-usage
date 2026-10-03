// P2.2d evidence: persistence, theme/language integration and storage failure.
//
// Verifies a chosen skin survives a reload, that a blocked localStorage never
// breaks the page and degrades to the no-skin default, that the mode switch
// re-resolves artwork, and that the user's other dashboard state is untouched.
//
// Usage: node docs/validation/2026-10-02-model-character-skins/p2-persistence-audit.mjs

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

const checks = [];
const detail = {};
const stubApi = (route) =>
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
  });

async function newPage(contextOptions = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    reducedMotion: "reduce",
    ...contextOptions,
  });
  await context.route("**/api/**", stubApi);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { context, page, errors };
}

try {
  // 1. A chosen skin survives a reload, including opacity 0.
  {
    const { context, page, errors } = await newPage();
    await page.goto(baseUrl, { waitUntil: "load" });
    await page.waitForTimeout(350);
    await page.evaluate(() => {
      window.__skinTestHook.selectSkin("grok");
      window.__skinTestHook.setOpacity(0);
    });
    await page.waitForTimeout(200);
    const stored = await page.evaluate(() => localStorage.getItem("codexUsageSkinV1"));
    assert.ok(stored, "preference must be written to storage");
    const parsed = JSON.parse(stored);
    assert.equal(parsed.skinId, "grok");
    assert.equal(parsed.opacity, 0, "opacity 0 must be persisted, not replaced by the default");
    assert.equal(parsed.version, 1);

    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(450);
    const after = await page.evaluate(() => ({
      preference: window.__skinTestHook.getPreference(),
      rootSkin: document.documentElement.dataset.skin,
      layerOpacity: getComputedStyle(document.getElementById("skinCharacters")).opacity,
      loaded: [...document.querySelectorAll("#skinCharacters img")].filter((i) => i.dataset.loaded === "1").length,
    }));
    assert.equal(after.preference.skinId, "grok", "skin must survive reload");
    assert.equal(after.preference.opacity, 0, "opacity 0 must survive reload");
    assert.equal(after.rootSkin, "grok", "the pre-paint bootstrap must restore the root state");
    assert.equal(after.layerOpacity, "0");
    assert.equal(after.loaded, 2, "artwork must be reloaded after the reload");
    assert.deepEqual(errors, []);
    checks.push("chosen skin and opacity 0 survive a reload through the pre-paint bootstrap");
    detail.reload = after;
    await context.close();
  }

  // 2. Blocked storage must not break the page; it degrades to no skin.
  {
    const { context, page, errors } = await newPage();
    await context.addInitScript(() => {
      // Simulate a locked-down browser where storage throws on every access.
      const thrower = () => {
        throw new DOMException("storage disabled", "SecurityError");
      };
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get: () => ({ getItem: thrower, setItem: thrower, removeItem: thrower, clear: thrower }),
      });
    });
    await page.goto(baseUrl, { waitUntil: "load" });
    await page.waitForTimeout(400);
    const degraded = await page.evaluate(() => ({
      skin: window.__skinTestHook?.getPreference?.().skinId ?? null,
      hookPresent: Boolean(window.__skinTestHook),
      totalTokens: document.querySelector("#totalTokens")?.textContent?.trim(),
    }));
    assert.equal(degraded.hookPresent, true, "the runtime must still initialise without storage");
    assert.equal(degraded.skin, "classic", "storage failure must degrade to the no-skin default");
    // Selecting still works in-memory even when it cannot be persisted.
    const stillWorks = await page.evaluate(() => {
      window.__skinTestHook.selectSkin("kimi");
      return window.__skinTestHook.getPreference().skinId;
    });
    assert.equal(stillWorks, "kimi", "selection must still work when persistence fails");
    assert.deepEqual(errors, [], `storage failure caused page errors: ${errors.join(", ")}`);
    checks.push("blocked localStorage degrades to no-skin with no page errors, selection still works");
    detail.blockedStorage = { ...degraded, stillWorks };
    await context.close();
  }

  // 3. Corrupt and wrong-version payloads degrade safely.
  {
    for (const [label, value] of [
      ["broken JSON", "{not json"],
      ["wrong version", JSON.stringify({ version: 9, skinId: "grok", showCharacters: false, opacity: 0.1 })],
      ["unknown skin", JSON.stringify({ version: 1, skinId: "ghost-skin", showCharacters: true, opacity: 0.5 })],
      ["array payload", JSON.stringify([1, 2, 3])],
    ]) {
      const { context, page, errors } = await newPage();
      await context.addInitScript(
        ([key, stored]) => {
          try {
            localStorage.setItem(key, stored);
          } catch {
            // ignore
          }
        },
        ["codexUsageSkinV1", value],
      );
      await page.goto(baseUrl, { waitUntil: "load" });
      await page.waitForTimeout(350);
      const result = await page.evaluate(() => window.__skinTestHook.getPreference());
      assert.equal(result.skinId, "classic", `${label} must degrade to no-skin`);
      assert.equal(result.opacity, 0.5, `${label} must fall back to the default opacity`);
      assert.deepEqual(errors, [], `${label} caused page errors: ${errors.join(", ")}`);
      await context.close();
    }
    checks.push("broken JSON, wrong version, unknown skin and array payloads all degrade to the no-skin default");
  }

  // 4. Switching theme re-resolves artwork to the other mode's files.
  {
    const { context, page, errors } = await newPage();
    await page.goto(baseUrl, { waitUntil: "load" });
    await page.waitForTimeout(350);
    await page.evaluate(() => window.__skinTestHook.selectSkin("qwen"));
    await page.waitForTimeout(400);
    const light = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      urls: [...document.querySelectorAll("#skinCharacters img")].map((i) => i.dataset.url),
    }));
    assert.ok(
      light.urls.every((url) => url?.includes("/light/")),
      `light mode must use light files, saw ${light.urls.join(", ")}`,
    );

    await page.locator("#themeToggle").click();
    await page.waitForTimeout(500);
    const dark = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      urls: [...document.querySelectorAll("#skinCharacters img")].map((i) => i.dataset.url),
      loaded: [...document.querySelectorAll("#skinCharacters img")].filter((i) => i.dataset.loaded === "1").length,
    }));
    assert.equal(dark.theme, "dark");
    assert.ok(
      dark.urls.every((url) => url?.includes("/dark/")),
      `dark mode must switch to dark files, saw ${dark.urls.join(", ")}`,
    );
    assert.equal(dark.loaded, 2, "both dark views must decode");
    assert.deepEqual(errors, []);
    checks.push("switching theme re-resolves both views to the other mode's files");
    detail.themeSwitch = { light, dark };
    await context.close();
  }

  // 5. Language switching must not disturb the skin or the dashboard state.
  {
    const { context, page, errors } = await newPage();
    await page.goto(baseUrl, { waitUntil: "load" });
    await page.waitForTimeout(350);
    await page.evaluate(() => {
      window.__skinTestHook.selectSkin("muse");
      window.__skinTestHook.setShowCharacters(false);
    });
    await page.waitForTimeout(300);
    await page.locator("#languageToggle").click();
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({
      skin: window.__skinTestHook.getPreference().skinId,
      showCharacters: window.__skinTestHook.getPreference().showCharacters,
      rootSkin: document.documentElement.dataset.skin,
      characters: document.getElementById("skinCharacters").dataset.skinCharacters,
    }));
    assert.equal(after.skin, "muse", "language switch must not change the skin");
    assert.equal(after.showCharacters, false, "language switch must not change the characters toggle");
    assert.equal(after.characters, "off", "the layer must stay hidden");
    assert.deepEqual(errors, []);
    checks.push("switching language leaves the skin and character toggle untouched");
    detail.languageSwitch = after;
    await context.close();
  }

  // 6. Business state must be unaffected by skin activity.
  {
    const { context, page, errors } = await newPage();
    await page.goto(baseUrl, { waitUntil: "load" });
    await page.waitForTimeout(350);
    const snapshotState = () =>
      page.evaluate(() => ({
        theme: document.documentElement.dataset.theme,
        localePressed: document.getElementById("languageToggle").getAttribute("aria-pressed"),
        excluded: document.getElementById("sourcePicker")?.innerHTML?.length ?? 0,
      }));
    const before = await snapshotState();
    await page.evaluate(() => window.__skinTestHook.selectSkin("mimo"));
    await page.waitForTimeout(300);
    await page.locator("#skinToggle").click();
    await page.waitForTimeout(200);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
    const after = await snapshotState();
    assert.equal(after.theme, before.theme, "theme must be unchanged by skin activity");
    assert.equal(after.localePressed, before.localePressed, "locale must be unchanged by skin activity");
    assert.deepEqual(errors, []);
    checks.push("theme and locale are untouched by skin selection and dialog use");
    detail.businessState = { before, after };
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`${checks.length} checks passed`);
for (const check of checks) console.log(`  PASS ${check}`);
console.log(JSON.stringify(detail, null, 2));
