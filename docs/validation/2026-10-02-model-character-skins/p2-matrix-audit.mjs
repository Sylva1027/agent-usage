// P2.3 evidence: the dual light/dark preview matrix.
//
// Verifies each card shows BOTH modes side by side regardless of the page theme,
// that a preview reproduces its own mode's real base values even inside the
// opposite theme, that the shared mini template is identical for every skin,
// that pending colours are labelled honestly rather than invented, and that a
// palette override for one mode never leaks into another skin or the page.
//
// Usage: node docs/validation/2026-10-02-model-character-skins/p2-matrix-audit.mjs

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

// Ground truth for the two modes, measured from the page itself in probe-theme-tokens.mjs.
const LIGHT_BG = "rgb(207, 216, 225)";
const DARK_BG = "rgb(32, 37, 43)";

const checks = [];
const detail = {};

try {
  for (const pageTheme of ["light", "dark"]) {
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
    if (pageTheme === "dark") {
      await page.locator("#themeToggle").click();
      await page.waitForTimeout(300);
    }
    await page.locator("#skinToggle").click();
    await page.waitForTimeout(450);

    const matrix = await page.evaluate(() => {
      const cards = [...document.querySelectorAll("#skinGrid .skin-card")];
      return cards.map((card) => {
        const cells = [...card.querySelectorAll(".skin-preview-scope")];
        const read = (cell) => {
          const preview = cell.querySelector(".skin-preview");
          const style = getComputedStyle(preview);
          const scopeStyle = getComputedStyle(cell);
          const image = preview.querySelector("img");
          return {
            theme: cell.dataset.previewTheme,
            background: style.backgroundColor,
            ink: scopeStyle.getPropertyValue("--ink").trim(),
            pageToken: scopeStyle.getPropertyValue("--bg").trim(),
            hasArtwork: Boolean(image),
            artworkSrc: image?.getAttribute("src") || null,
            // The mini template pieces, to prove every skin renders the same set.
            title: Boolean(preview.querySelector(".skin-preview-title")),
            lines: preview.querySelectorAll(".skin-preview-line").length,
            bars: preview.querySelectorAll(".skin-preview-bar").length,
            button: Boolean(preview.querySelector(".skin-preview-button")),
            artOpacity: image ? getComputedStyle(image).opacity : null,
          };
        };
        return {
          id: card.dataset.skinId,
          classic: card.dataset.skinClassic === "true",
          name: card.querySelector(".skin-card-name")?.textContent?.trim(),
          ariaLabel: card.getAttribute("aria-label"),
          selected: card.getAttribute("aria-checked") === "true",
          cells: cells.map(read),
          pendingNotes: card.querySelectorAll(".skin-swatch-note").length,
        };
      });
    });

    assert.equal(matrix.length, 11, "all 11 options must be in the matrix");

    // 1. Every card shows exactly two previews: one light, one dark.
    for (const card of matrix) {
      const themes = card.cells.map((cell) => cell.theme);
      assert.deepEqual(themes, ["light", "dark"], `${card.id} must show both modes side by side`);
    }
    checks.push(`[${pageTheme} page] every card shows both light and dark previews`);

    // 2. Each preview must render its OWN mode's base, independent of the page
    //    theme. This is the core requirement of plan 4.4.
    for (const card of matrix) {
      const light = card.cells[0];
      const dark = card.cells[1];
      assert.equal(light.background, LIGHT_BG, `${card.id} light preview must use the light base on a ${pageTheme} page`);
      assert.equal(dark.background, DARK_BG, `${card.id} dark preview must use the dark base on a ${pageTheme} page`);
      assert.equal(light.pageToken, "#cfd8e1", `${card.id} light preview must carry the light token`);
      assert.equal(dark.pageToken, "#20252b", `${card.id} dark preview must carry the dark token`);
      // Ink polarity must flip too, not just the background.
      assert.notEqual(light.ink, dark.ink, `${card.id} modes must not share ink colour`);
    }
    checks.push(`[${pageTheme} page] each preview reproduces its own mode's base and ink`);

    // 3. Character cards show mode-appropriate artwork; the no-skin card shows none.
    for (const card of matrix) {
      if (card.classic) {
        assert.equal(card.cells[0].hasArtwork, false, "no-skin must not show light artwork");
        assert.equal(card.cells[1].hasArtwork, false, "no-skin must not show dark artwork");
        continue;
      }
      assert.ok(card.cells[0].artworkSrc?.includes("/light/"), `${card.id} light preview must use light files`);
      assert.ok(card.cells[1].artworkSrc?.includes("/dark/"), `${card.id} dark preview must use dark files`);
      // Fixed 50% reference opacity, independent of the page's character opacity.
      assert.equal(card.cells[0].artOpacity, "0.5", `${card.id} artwork must sit at the 50% reference`);
      assert.equal(card.cells[1].artOpacity, "0.5", `${card.id} artwork must sit at the 50% reference`);
    }
    checks.push(`[${pageTheme} page] light/dark artwork is mode-correct at a fixed 50% reference`);

    // 4. Every card uses the same mini template.
    for (const card of matrix) {
      const shape = card.cells.map((cell) => `${cell.title}|${cell.lines}|${cell.bars}|${cell.button}`);
      assert.deepEqual(shape, ["true|2|3|true", "true|2|3|true"], `${card.id} must use the shared mini template`);
    }
    checks.push(`[${pageTheme} page] all cards render one shared mini template`);

    // 5. Palette is unspecified everywhere this round, so it must be labelled.
    for (const card of matrix) {
      if (card.classic) continue;
      assert.ok(card.pendingNotes >= 1, `${card.id} must label its unspecified palette instead of inventing colours`);
    }
    checks.push(`[${pageTheme} page] unspecified palettes are labelled, never invented`);

    // 6. The no-skin card must be selected by default and name itself for AT.
    const classic = matrix.find((card) => card.classic);
    assert.ok(classic, "no-skin option must exist");
    assert.equal(classic.selected, true, "no-skin is the default selection");
    assert.ok(classic.ariaLabel?.includes("无皮肤"), "no-skin accessible name must state that no skin is used");
    checks.push(`[${pageTheme} page] no-skin is default and named for assistive tech`);

    // 6b. The no-skin option must be first in the matrix, so it is visible the
    //     instant the picker opens - never behind scrolling or searching
    //     (plan 1 item 11). Assert both DOM order and on-screen position.
    assert.equal(matrix[0].classic, true, "the no-skin option must be the first card in the matrix");
    const noSkinVisibility = await page.evaluate(() => {
      const classicCard = document.querySelector('#skinGrid .skin-card[data-skin-classic="true"]');
      const backdrop = document.getElementById("skinDialog");
      const rect = classicCard.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        backdropScrollTop: backdrop.scrollTop,
        viewportHeight: window.innerHeight,
        visibleWithoutScrolling: rect.top >= 0 && rect.bottom <= window.innerHeight && backdrop.scrollTop === 0,
      };
    });
    assert.equal(
      noSkinVisibility.visibleWithoutScrolling,
      true,
      `[${pageTheme}] the no-skin option must be visible without scrolling, saw ${JSON.stringify(noSkinVisibility)}`,
    );
    detail[`noSkinVisibility-${pageTheme}`] = noSkinVisibility;
    checks.push(`[${pageTheme} page] no-skin is first and visible without any scrolling`);

    // 6c. The no-skin option must render its own mode's base plus an explicit
    //     note - not a blank frame, a broken image or a "colours pending" label.
    const classicPreview = await page.evaluate(() => {
      const card = document.querySelector('#skinGrid .skin-card[data-skin-classic="true"]');
      const cells = [...card.querySelectorAll(".skin-preview-scope")];
      return {
        noteCount: card.querySelectorAll(".skin-preview-none-label").length,
        pendingCount: card.querySelectorAll(".skin-swatch-note").length,
        labels: cells.map((cell) => cell.querySelector(".skin-preview-none-label")?.textContent?.trim() || null),
        backgrounds: cells.map((cell) => getComputedStyle(cell.querySelector(".skin-preview")).backgroundColor),
        brokenImages: [...card.querySelectorAll("img")].filter((img) => img.complete && img.naturalWidth === 0).length,
      };
    });
    assert.equal(classicPreview.noteCount, 2, "both no-skin previews must carry an explicit note");
    assert.deepEqual(classicPreview.labels, ["无皮肤", "无皮肤"], "the note must say no skin is used");
    assert.deepEqual(
      classicPreview.backgrounds,
      [LIGHT_BG, DARK_BG],
      "the no-skin previews must show their own mode's real page base",
    );
    assert.equal(classicPreview.brokenImages, 0, "the no-skin card must not render broken images");
    detail[`classicPreview-${pageTheme}`] = classicPreview;
    checks.push(`[${pageTheme} page] no-skin preview shows its mode's base with an explicit note, no broken image`);

    // 7. Pagination: 10 cards + no-skin, five per row on a wide desktop.
    const layout = await page.evaluate(() => {
      const cards = [...document.querySelectorAll("#skinGrid .skin-card")];
      const rows = new Map();
      for (const card of cards) {
        const y = Math.round(card.getBoundingClientRect().y);
        rows.set(y, (rows.get(y) || 0) + 1);
      }
      const grid = getComputedStyle(document.getElementById("skinGrid"));
      const dialog = document.getElementById("skinDialog");
      const section = dialog.querySelector(".skin-dialog");
      return {
        rows: [...rows.values()],
        columns: grid.gridTemplateColumns.split(" ").length,
        dialogHeight: section.getBoundingClientRect().height,
        viewportHeight: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    });
    assert.equal(layout.columns, 5, `[${pageTheme}] wide desktop must use five columns`);
    // Eleven options at five per row: the ten characters plus the compact
    // no-skin card, which occupies the leftover cell.
    assert.deepEqual(layout.rows, [5, 5, 1], `[${pageTheme}] expected a 5+5+1 matrix, saw ${layout.rows}`);
    assert.ok(
      layout.dialogHeight <= layout.viewportHeight,
      `[${pageTheme}] dialog must fit the viewport (${layout.dialogHeight} vs ${layout.viewportHeight})`,
    );
    detail[`layout-${pageTheme}`] = layout;
    checks.push(`[${pageTheme} page] five columns, 5+5+1 matrix, dialog fits the viewport`);

    // 8. Dashboard must not move because the dialog opened (spot check).
    assert.ok(layout.scrollWidth <= layout.clientWidth + 1, "no horizontal overflow");
    assert.deepEqual(errors, [], `[${pageTheme}] page errors: ${errors.join(", ")}`);
    detail[`matrix-${pageTheme}`] = matrix.map((card) => ({
      id: card.id,
      light: card.cells[0].background,
      dark: card.cells[1].background,
      art: [card.cells[0].artworkSrc?.split("/").pop(), card.cells[1].artworkSrc?.split("/").pop()],
    }));

    await context.close();
  }

  // 9. A palette override must stay inside its own scope: it must not change the
  //    page, another skin, or the other mode. Uses an injected fixture only.
  {
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
    await page.locator("#skinToggle").click();
    await page.waitForTimeout(300);

    const isolation = await page.evaluate(() => {
      const pageBgBefore = getComputedStyle(document.body).backgroundColor;
      // Inject a fixture palette on ONE light preview only.
      const target = document.querySelector('.skin-card[data-skin-id="claude"] .skin-preview-scope[data-preview-theme="light"]');
      const preview = target.querySelector(".skin-preview");
      preview.style.setProperty("--skin-preview-page", "#123456");
      const neighbour = document.querySelector(
        '.skin-card[data-skin-id="claude"] .skin-preview-scope[data-preview-theme="dark"] .skin-preview',
      );
      const otherSkin = document.querySelector(
        '.skin-card[data-skin-id="kimi"] .skin-preview-scope[data-preview-theme="light"] .skin-preview',
      );
      return {
        pageBgBefore,
        pageBgAfter: getComputedStyle(document.body).backgroundColor,
        target: getComputedStyle(preview).backgroundColor,
        sameSkinOtherMode: getComputedStyle(neighbour).backgroundColor,
        otherSkinLight: getComputedStyle(otherSkin).backgroundColor,
      };
    });
    assert.equal(isolation.target, "rgb(18, 52, 86)", "the fixture palette must apply to its own preview");
    assert.equal(isolation.sameSkinOtherMode, DARK_BG, "a light override must not touch the dark preview");
    assert.equal(isolation.otherSkinLight, LIGHT_BG, "a palette must not leak to another skin");
    assert.equal(isolation.pageBgAfter, isolation.pageBgBefore, "a preview palette must not repaint the page");
    detail.isolation = isolation;
    checks.push("a palette override stays inside one preview scope");
    await context.close();
  }

  // 10. Small screens must keep the no-skin option visible and must still show
  //     BOTH colour groups without requiring a click per option (plan 4.4).
  {
    for (const [width, height] of [
      [1024, 768],
      [768, 1024],
      [390, 844],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height },
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
      await page.waitForTimeout(350);
      await page.locator("#skinToggle").click();
      await page.waitForTimeout(450);

      const narrow = await page.evaluate(() => {
        const cards = [...document.querySelectorAll("#skinGrid .skin-card")];
        const classicCard = document.querySelector('#skinGrid .skin-card[data-skin-classic="true"]');
        const rect = classicCard.getBoundingClientRect();
        // Count how many cards show two labelled previews WITHOUT being clicked.
        const withBothPreviews = cards.filter((card) => card.querySelectorAll(".skin-preview-scope").length === 2).length;
        const rows = new Map();
        for (const card of cards) {
          const y = Math.round(card.getBoundingClientRect().y);
          rows.set(y, (rows.get(y) || 0) + 1);
        }
        return {
          columns: getComputedStyle(document.getElementById("skinGrid")).gridTemplateColumns.split(" ").length,
          rows: [...rows.values()],
          classicFirst: cards[0].dataset.skinClassic === "true",
          classicVisible: rect.top >= 0 && rect.bottom <= window.innerHeight,
          classicWidth: Math.round(rect.width),
          withBothPreviews,
          totalCards: cards.length,
          labels: [...classicCard.querySelectorAll(".skin-preview-mode")].map((node) => node.textContent.trim()),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });

      assert.equal(narrow.classicFirst, true, `${width}px: no-skin must stay first`);
      assert.equal(narrow.classicVisible, true, `${width}px: no-skin must be visible without scrolling`);
      assert.equal(
        narrow.withBothPreviews,
        narrow.totalCards,
        `${width}px: every card must show both colour groups without a click`,
      );
      assert.deepEqual(narrow.labels, ["浅色", "深色"], `${width}px: both modes must be labelled`);
      assert.ok(narrow.columns >= 2, `${width}px: grid must keep at least two columns`);
      assert.ok(narrow.overflow <= 1, `${width}px: no horizontal overflow, saw ${narrow.overflow}`);
      assert.deepEqual(errors, [], `${width}px page errors: ${errors.join(", ")}`);
      detail[`narrow-${width}`] = narrow;
      checks.push(`[${width}px] no-skin visible and all cards show both colour groups without clicking`);
      await context.close();
    }
  }
  // 11. Fit-to-viewport: the dialog must show all eleven options with both colour
  //     groups without internal scrolling at the reference desktop widths, and at
  //     narrow widths the no-skin option must still be visible immediately.
  {
    for (const [width, height] of [
      [1920, 1080],
      [1440, 900],
      [1280, 800],
      [1024, 768],
      [768, 1024],
      [390, 844],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height },
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
      await page.locator("#skinToggle").click();
      await page.waitForTimeout(450);
      const fit = await page.evaluate(() => {
        const dialog = document.querySelector(".skin-dialog");
        const cards = [...document.querySelectorAll("#skinGrid .skin-card")];
        const last = cards[cards.length - 1].getBoundingClientRect();
        const classic = document.querySelector('#skinGrid .skin-card[data-skin-classic="true"]').getBoundingClientRect();
        return {
          dialogHeight: Math.round(dialog.getBoundingClientRect().height),
          contentHeight: dialog.scrollHeight,
          clientHeight: dialog.clientHeight,
          internalScroll: dialog.scrollHeight > dialog.clientHeight + 1,
          overflowBy: Math.max(0, dialog.scrollHeight - dialog.clientHeight),
          lastCardInView: last.bottom <= window.innerHeight + 1,
          classicInView: classic.top >= 0 && classic.bottom <= window.innerHeight,
          withBothPreviews: cards.filter((card) => card.querySelectorAll(".skin-preview-scope").length === 2).length,
          totalCards: cards.length,
        };
      });

      // Every option keeps both colour groups at every size.
      assert.equal(fit.withBothPreviews, fit.totalCards, `${width}x${height}: every card needs both colour groups`);
      // The no-skin option is always visible on open.
      assert.equal(fit.classicInView, true, `${width}x${height}: the no-skin option must be visible on open`);
      // The reference desktop widths must not scroll internally at all.
      if (width >= 1280) {
        assert.equal(
          fit.internalScroll,
          false,
          `${width}x${height}: the reference desktop widths must fit without internal scrolling ` +
            `(overflows by ${fit.overflowBy}px)`,
        );
        assert.equal(fit.lastCardInView, true, `${width}x${height}: the last card must be on screen`);
      }
      detail[`fit-${width}x${height}`] = fit;
      checks.push(`[${width}x${height}] layout fits with all options reachable`);
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`${checks.length} checks passed`);
for (const check of checks) console.log(`  PASS ${check}`);
console.log(JSON.stringify(detail, null, 2));
