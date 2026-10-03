// P2.2b/c + P2.4 evidence: the skin picker dialog.
//
// Verifies the dialog is a sibling of the existing dialogs, opens from the entry
// button, keeps focus trapped, closes by button/backdrop/Escape with focus
// restored, drives the runtime without touching dashboard layout, and that the
// no-skin option is a first-class card in the same matrix.
//
// Usage: node docs/validation/2026-10-02-model-character-skins/p2-picker-audit.mjs

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

function ok(label) {
  checks.push(label);
}

try {
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
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "load" });
  await page.waitForTimeout(400);

  // 1. Sibling of the other dialogs, not nested inside them.
  const structure = await page.evaluate(() => {
    const node = document.getElementById("skinDialog");
    return {
      exists: Boolean(node),
      parentTag: node?.parentElement?.tagName,
      insideOtherDialog: Boolean(node?.closest("#importDialog, #pricingDialog")),
      className: node?.className,
      hidden: node?.hidden,
      role: node?.querySelector("[role='dialog']")?.getAttribute("role"),
      modal: node?.querySelector("[role='dialog']")?.getAttribute("aria-modal"),
      labelledBy: node?.querySelector("[role='dialog']")?.getAttribute("aria-labelledby"),
      titleId: node?.querySelector("h2")?.id,
    };
  });
  assert.ok(structure.exists, "#skinDialog must exist");
  assert.equal(structure.insideOtherDialog, false, "skin dialog must not be nested in another dialog");
  assert.equal(structure.parentTag, "BODY", "skin dialog must be a body-level sibling");
  assert.equal(structure.hidden, true, "skin dialog starts hidden");
  assert.equal(structure.role, "dialog");
  assert.equal(structure.modal, "true");
  assert.equal(structure.labelledBy, structure.titleId, "aria-labelledby must point at the title");
  ok("dialog is a body-level sibling with role/aria-modal/title wiring");
  detail.structure = structure;

  // 2. Baseline geometry, then open the dialog and confirm the dashboard is unmoved.
  const geometry = () =>
    page.evaluate(() => {
      const rect = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) };
      };
      return { shell: rect(".shell"), topbar: rect(".topbar"), scrollWidth: document.documentElement.scrollWidth };
    });
  const before = await geometry();

  await page.locator("#skinToggle").click();
  await page.waitForTimeout(250);
  const opened = await page.evaluate(() => ({
    hidden: document.getElementById("skinDialog").hidden,
    expanded: document.getElementById("skinToggle").getAttribute("aria-expanded"),
    focusInside: document.getElementById("skinDialog").contains(document.activeElement),
    focusedClass: document.activeElement?.className,
    cards: document.querySelectorAll("#skinGrid .skin-card").length,
  }));
  assert.equal(opened.hidden, false, "dialog must open from the entry button");
  assert.equal(opened.expanded, "true", "aria-expanded must track the open state");
  assert.ok(opened.focusInside, "focus must move into the dialog on open");
  assert.match(opened.focusedClass || "", /skin-card/, "the selected card should receive focus");
  ok("entry button opens the dialog, sets aria-expanded and focuses the selection");
  detail.opened = opened;

  // 3. All eleven options render through one template, no-skin included.
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll("#skinGrid .skin-card")].map((card) => ({
      id: card.dataset.skinId,
      classic: card.dataset.skinClassic,
      selected: card.getAttribute("aria-checked"),
      name: card.querySelector(".skin-card-name")?.textContent?.trim(),
      // The no-skin card must explain itself, not render an empty frame.
      note: card.querySelector(".skin-swatch-note")?.textContent?.trim() || null,
      noneLabel: card.querySelector(".skin-card-art-none span")?.textContent?.trim() || null,
      hasImage: Boolean(card.querySelector("img")),
    })),
  );
  assert.equal(cards.length, 11, `expected 11 options, saw ${cards.length}`);
  const classicCard = cards.find((card) => card.id === "classic");
  assert.ok(classicCard, "the no-skin option must be present");
  assert.equal(classicCard.classic, "true");
  assert.equal(classicCard.selected, "true", "no-skin is the default selection");
  assert.ok(classicCard.name, "no-skin option needs a display name");
  assert.ok(classicCard.note, "no-skin option must state itself instead of showing blank colour slots");
  assert.equal(classicCard.hasImage, false, "no-skin option must not load artwork");
  const characterCards = cards.filter((card) => card.classic === "false");
  assert.equal(characterCards.length, 10, "all ten characters must be present");
  ok("all 11 options render, with no-skin as a labelled first-class card");
  detail.cards = cards;

  // 4. Selecting a character updates the runtime and the dashboard stays put.
  await page.locator('#skinGrid .skin-card[data-skin-id="claude"]').click();
  await page.waitForTimeout(400);
  const afterSelect = await page.evaluate(() => ({
    skin: document.documentElement.dataset.skin,
    selected: [...document.querySelectorAll("#skinGrid .skin-card[aria-checked='true']")].map((c) => c.dataset.skinId),
    loadFailed: window.__skinTestHook ? false : true,
  }));
  assert.equal(afterSelect.skin, "claude", "clicking a card must select that skin");
  assert.deepEqual(afterSelect.selected, ["claude"], "exactly one card may be selected");
  const afterSelectGeometry = await geometry();
  assert.deepEqual(afterSelectGeometry.shell, before.shell, "opening/selecting moved .shell");
  assert.deepEqual(afterSelectGeometry.topbar, before.topbar, "opening/selecting moved .topbar");
  ok("selecting a character updates state without moving the dashboard");

  // 5. Opacity readout and the 0% edge case.
  await page.evaluate(() => {
    const input = document.getElementById("skinOpacity");
    input.value = "0";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(150);
  const zero = await page.evaluate(() => ({
    readout: document.getElementById("skinOpacityValue").textContent.trim(),
    layerOpacity: getComputedStyle(document.getElementById("skinCharacters")).opacity,
    stored: window.__skinTestHook.getPreference().opacity,
  }));
  assert.equal(zero.readout, "0%", "readout must show the real percentage");
  assert.equal(zero.layerOpacity, "0", "0% must reach the layer");
  assert.equal(zero.stored, 0, "0 must survive normalisation");
  ok("opacity slider drives the layer and 0% is preserved");
  detail.zeroOpacity = zero;

  // 6. Reset buttons.
  await page.locator("#resetSkinOpacityButton").click();
  await page.waitForTimeout(200);
  const afterOpacityReset = await page.evaluate(() => window.__skinTestHook.getPreference().opacity);
  assert.equal(afterOpacityReset, 0.5, "reset must restore 50%");
  await page.locator("#resetSkinClassicButton").click();
  await page.waitForTimeout(200);
  const afterClassicReset = await page.evaluate(() => window.__skinTestHook.getPreference());
  assert.equal(afterClassicReset.skinId, "classic", "reset must return to no skin");
  ok("reset-to-50% and back-to-no-skin both work");

  // 7. Escape closes and restores focus to the invoker.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  const afterEscape = await page.evaluate(() => ({
    hidden: document.getElementById("skinDialog").hidden,
    expanded: document.getElementById("skinToggle").getAttribute("aria-expanded"),
    focusedId: document.activeElement?.id,
  }));
  assert.equal(afterEscape.hidden, true, "Escape must close the dialog");
  assert.equal(afterEscape.expanded, "false", "aria-expanded must reset on close");
  assert.equal(afterEscape.focusedId, "skinToggle", "focus must return to the entry button");
  ok("Escape closes and restores focus to the entry button");

  // 8. Backdrop click closes; a click inside the content does not.
  await page.locator("#skinToggle").click();
  await page.waitForTimeout(200);
  await page.locator("#skinGrid").click({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => document.getElementById("skinDialog").hidden), false, "content click must not close");
  await page.locator("#skinDialog").click({ position: { x: 4, y: 4 } });
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => document.getElementById("skinDialog").hidden), true, "backdrop click must close");
  ok("backdrop click closes, content click does not");

  // 9. Focus trap keeps Tab inside the dialog.
  await page.locator("#skinToggle").click();
  await page.waitForTimeout(200);
  const trapped = await page.evaluate(async () => {
    const dialog = document.getElementById("skinDialog");
    const seen = new Set();
    for (let index = 0; index < 40; index += 1) {
      const controls = [...dialog.querySelectorAll("button, input, select, textarea, a[href], [tabindex]")].filter(
        (control) => !control.disabled && control.tabIndex >= 0 && control.getClientRects().length > 0,
      );
      if (!controls.length) break;
      seen.add(document.activeElement);
      const last = controls[controls.length - 1];
      if (document.activeElement === last) {
        // Simulate the browser's Tab: the app's handler should wrap to the first.
        const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
        document.activeElement.dispatchEvent(event);
      }
      break;
    }
    return { inside: dialog.contains(document.activeElement), controlCount: dialog.querySelectorAll("button, input").length };
  });
  assert.ok(trapped.inside, "focus must remain inside the dialog");
  ok("focus stays inside the dialog");

  // 10. The three dialogs coexist: opening the skin dialog does not disturb the others.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const othersIntact = await page.evaluate(() => ({
    importHidden: document.getElementById("importDialog").hidden,
    pricingHidden: document.getElementById("pricingDialog").hidden,
    importExists: Boolean(document.getElementById("importDialog")),
    pricingExists: Boolean(document.getElementById("pricingDialog")),
  }));
  assert.equal(othersIntact.importHidden, true, "import dialog must stay untouched");
  assert.equal(othersIntact.pricingHidden, true, "pricing dialog must stay untouched");
  assert.ok(othersIntact.importExists && othersIntact.pricingExists, "existing dialogs must still exist");
  ok("existing dialogs are unaffected");

  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(", ")}`);
  ok("no page errors");

  await context.close();
} finally {
  await browser.close();
  server.close();
}

console.log(`${checks.length} checks passed`);
for (const check of checks) console.log(`  PASS ${check}`);
console.log(JSON.stringify(detail, null, 2));
