// P2.2a evidence: the skin entry button must be the same size and appearance as
// the existing language/theme buttons, sit immediately left of #languageToggle
// with no visible text, and not collide with the title or its neighbours.
//
// Usage: node docs/validation/2026-10-02-model-character-skins/p2-entry-button-audit.mjs

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

// Widths chosen to include every toolbar breakpoint and the narrowest layout.
const WIDTHS = [1920, 1680, 1440, 1280, 1024, 768, 390];
const THEMES = ["light", "dark"];

const checks = [];
const detail = { widths: {}, collisions: [], themeStyles: {}, wrap: {} };

try {
  for (const dark of [false, true]) {
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
    await page.goto(baseUrl, { waitUntil: "load" });
    await page.waitForTimeout(350);
    if (dark) {
      await page.locator("#themeToggle").click();
      await page.waitForTimeout(250);
    }
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);

      const measured = await page.evaluate(() => {
        const read = (selector) => {
          const node = document.querySelector(selector);
          if (!node) return null;
          const box = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return {
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            right: box.right,
            bottom: box.bottom,
            background: style.backgroundImage,
            borderRadius: style.borderRadius,
            borderTopColor: style.borderTopColor,
            boxShadow: style.boxShadow,
            color: style.color,
            // Visible text content, ignoring the aria-hidden icon.
            text: (node.textContent || "").trim(),
          };
        };
        return {
          title: read("h1"),
          skin: read("#skinToggle"),
          language: read("#languageToggle"),
          themeToggle: read("#themeToggle"),
          actions: read(".topbar-actions"),
          // Per-button geometry, so the wrapped row can be verified as one line.
          buttons: ["#skinToggle", "#languageToggle", "#themeToggle"].map((selector) => {
            const box = document.querySelector(selector).getBoundingClientRect();
            return { selector, x: box.x, y: box.y, right: box.right, bottom: box.bottom };
          }),
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        };
      });

      detail.widths[`${width}-${theme}`] = measured;

      assert.ok(measured.skin, `#skinToggle missing at ${width}px`);
      // 1. Identical size to the language toggle.
      assert.equal(
        `${measured.skin.width}x${measured.skin.height}`,
        `${measured.language.width}x${measured.language.height}`,
        `skin button size differs from language button at ${width}px`,
      );
      assert.equal(
        `${measured.skin.width}x${measured.skin.height}`,
        `${measured.themeToggle.width}x${measured.themeToggle.height}`,
        `skin button size differs from theme button at ${width}px`,
      );
      // 2. No visible text.
      assert.equal(measured.skin.text, "", `skin button must have no visible text at ${width}px`);
      // 3. Immediately left of the language toggle, aligned on the same row.
      assert.ok(
        measured.skin.right <= measured.language.x + 0.5,
        `skin button must sit left of the language button at ${width}px (${measured.skin.right} vs ${measured.language.x})`,
      );
      assert.equal(Math.round(measured.skin.y), Math.round(measured.language.y), `buttons not on one row at ${width}px`);
      // 4. Collision check. At 390px the topbar legitimately WRAPS (user ruling
      //    2026-10-02): the title takes row 1 and the three buttons take row 2.
      //    A collision therefore requires overlap on BOTH axes. At >=768px the
      //    buttons must share the title's row, which is the pre-existing layout.
      const actionRow = measured.actions.y;
      const titleRow = measured.title.y;
      const sameRow = Math.abs(actionRow - titleRow) < Math.max(measured.title.height, 24);
      const overlapsOnBothAxes =
        measured.title.bottom > measured.actions.y &&
        measured.title.y < measured.actions.bottom &&
        measured.title.right > measured.skin.x &&
        measured.title.x < measured.skin.right;
      assert.equal(overlapsOnBothAxes, false, `skin button collides with the title at ${width}px`);
      if (width >= 768) {
        assert.ok(sameRow, `buttons must share the title's row at ${width}px (no wrap above 390px)`);
      } else {
        // The accepted narrow layout: wrapped, but the row stays inside the bar
        // and all three buttons remain on one line together.
        assert.equal(sameRow, false, `390px is expected to wrap; layout changed without a ruling`);
        assert.ok(
          measured.actions.y >= measured.title.bottom,
          `wrapped actions row must sit below the title at ${width}px`,
        );
        assert.equal(
          new Set(measured.buttons.map((button) => Math.round(button.y))).size,
          1,
          `all three buttons must stay on one wrapped row at ${width}px`,
        );
      }
      detail.wrap[`${width}-${theme}`] = { titleRow, actionRow, sameRow };
      // 5. No horizontal overflow introduced.
      assert.ok(
        measured.scrollWidth <= measured.clientWidth + 1,
        `horizontal overflow at ${width}px: ${measured.scrollWidth} > ${measured.clientWidth}`,
      );
      // 6. Same material treatment as the language button.
      assert.equal(measured.skin.background, measured.language.background, `background differs at ${width}px`);
      assert.equal(measured.skin.borderRadius, measured.language.borderRadius, `radius differs at ${width}px`);
      assert.equal(measured.skin.boxShadow, measured.language.boxShadow, `shadow differs at ${width}px`);
      assert.equal(measured.skin.borderTopColor, measured.language.borderTopColor, `rim differs at ${width}px`);
    }

    detail.themeStyles[theme] = await page.evaluate(() => {
      const read = (selector) => {
        const node = document.querySelector(selector);
        const style = getComputedStyle(node);
        return { color: style.color, background: style.backgroundImage, borderRadius: style.borderRadius };
      };
      return { skin: read("#skinToggle"), language: read("#languageToggle"), theme: read("#themeToggle") };
    });

    // The icon must actually paint something inside the button box.
    const icon = await page.evaluate(() => {
      const svg = document.querySelector("#skinToggle svg");
      const box = svg.getBoundingClientRect();
      return { width: box.width, height: box.height, paths: svg.querySelectorAll("path").length };
    });
    assert.ok(icon.width > 0 && icon.height > 0, "skin icon must have a visible box");
    assert.ok(icon.paths >= 2, "clothes icon must draw a garment outline");
    detail.icon = icon;

    await context.close();
  }

  checks.push(`entry button matches both existing buttons in size and material at ${WIDTHS.length} widths x 2 themes`);
  checks.push("entry button carries no visible text and sits immediately left of #languageToggle");
  checks.push("no title collision and no horizontal overflow at any width");
  checks.push("light and dark computed styles match the sibling buttons");
} finally {
  await browser.close();
  server.close();
}

console.log(`${checks.length} checks passed`);
for (const check of checks) console.log(`  PASS ${check}`);
console.log("\nMeasured button size by width (skin / language / theme):");
for (const [key, value] of Object.entries(detail.widths)) {
  const size = (entry) => `${Math.round(entry.width)}x${Math.round(entry.height)}`;
  console.log(
    `  ${key.padEnd(14)} skin=${size(value.skin)} lang=${size(value.language)} theme=${size(value.themeToggle)} title.right=${Math.round(value.title.right)} skin.x=${Math.round(value.skin.x)}`,
  );
}
