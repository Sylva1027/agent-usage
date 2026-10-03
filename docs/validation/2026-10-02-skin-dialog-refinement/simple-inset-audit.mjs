// Simple-mode inset correction: match the selected recent-range menu item.
// Reuse keyboard/preference regressions; keep R7/R8 evidence immutable.
// No live API or browser profile.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, unlinkSync, rmdirSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderStaticDashboardHtml } from "../../../src/static-export.js";

const output = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(output, "../../..");
const fixture = { generatedAt: "2026-10-02T00:00:00.000Z", asOf: "2026-10-02T00:00:00.000Z", events: [], homes: [], sessions: [], warnings: [], rateLimitObservations: [] };
const mime = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".webp": "image/webp" };
const server = createServer((request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  const file = path.resolve(root, "public", `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(`${path.join(root, "public")}${path.sep}`)) return response.writeHead(404).end();
  try { response.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" }); response.end(readFileSync(file)); }
  catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { chromium } = await import(pathToFileURL(process.env.AGENT_USAGE_PLAYWRIGHT_MODULE || path.join(os.homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs")).href);
const browser = await chromium.launch({ executablePath: process.env.AGENT_USAGE_EDGE_PATH || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
const results = { states: [], errors: [], externalRequests: [], checkedClosures: 0, checkedPointerPresses: 0 };
const tempDir = mkdtempSync(path.join(os.tmpdir(), "skin-simple-inset-"));
const snapshot = path.join(tempDir, "picker.html");
const cases = [[1440, 900], [1280, 800], [1024, 768], [1023, 768], [768, 1024], [390, 844], [360, 800]];
const ids = ["chatgpt", "claude", "glm", "gemini", "deepseek", "kimi", "qwen", "grok", "muse", "mimo"];
const copyBaseline = JSON.parse(readFileSync(path.join(output, "r8-before-copy.json"), "utf8"));

async function geometry(page) {
  return page.evaluate(() => [...document.querySelectorAll(".shell, .topbar, .toolbar, .metrics, .main-grid, .bottom-grid, .panel, .metric")].map((node) => {
    const b = node.getBoundingClientRect(); return { className: node.className, x: b.x, y: b.y, width: b.width, height: b.height };
  }));
}

async function state(page) {
  return page.evaluate(() => {
    const style = (node) => { const s = getComputedStyle(node); return { minHeight: s.minHeight, padding: s.padding, radius: s.borderRadius, background: s.backgroundImage, colour: s.color, edgeTop: s.borderTopColor, edgeBottom: s.borderBottomColor, shadow: s.boxShadow, transition: s.transition, fontSize: s.fontSize, fontWeight: s.fontWeight }; };
    const grid = document.querySelector("#skinGrid");
    const dialog = document.querySelector(".skin-dialog");
    const simple = document.querySelector("#resetSkinClassicButton");
    const close = document.querySelector("#closeSkinDialogButton");
    const cards = [...grid.querySelectorAll(".skin-card")];
    const rows = new Map();
    for (const card of cards) { const y = Math.round(card.getBoundingClientRect().y); rows.set(y, (rows.get(y) || 0) + 1); }
    const focus = document.activeElement;
    const focusedBox = focus.getBoundingClientRect(); const gridBox = grid.getBoundingClientRect();
    const dialogChildren = [...dialog.children];
    return {
      ids: cards.map((card) => card.dataset.skinId), selected: cards.filter((card) => card.getAttribute("aria-checked") === "true").map((card) => card.dataset.skinId),
      tabStops: cards.filter((card) => card.tabIndex === 0).map((card) => card.dataset.skinId), focusId: focus.id || focus.dataset.skinId,
      focusedCardVisible: !focus.classList.contains("skin-card") || (focusedBox.top >= gridBox.top - 1 && focusedBox.bottom <= gridBox.bottom + 1),
      simplePressed: simple.getAttribute("aria-pressed"), simpleText: simple.textContent, closeText: close.textContent,
      footerIds: [...dialog.querySelector(".dialog-actions").children].map((node) => node.id), footerAtEnd: dialog.lastElementChild.classList.contains("dialog-actions"),
      footerFixed: getComputedStyle(dialog.lastElementChild).flexShrink === "0", headingButtons: dialog.querySelectorAll(".dialog-heading button").length,
      removedReset: !document.querySelector("#resetSkinOpacityButton"), oldActionWrapper: dialog.querySelectorAll(".skin-control-actions").length,
      simpleStyle: style(simple), closeStyle: style(close), referenceStyle: style(document.querySelector("#cancelImportButton")),
      selectedReferenceStyle: style(document.querySelector('#recentRangeMenu button[aria-selected="true"]')),
      simpleGlow: getComputedStyle(simple).textShadow, selectedReferenceGlow: getComputedStyle(document.querySelector('#recentRangeMenu button[aria-selected="true"]')).textShadow,
      simpleInHeading: simple.parentElement.classList.contains("dialog-heading"),
      simpleRightAligned: Math.abs(simple.getBoundingClientRect().right - simple.parentElement.getBoundingClientRect().right) < 1,
      simpleLevelWithTitle: Math.abs((simple.getBoundingClientRect().top + simple.getBoundingClientRect().bottom - document.querySelector("#skinDialogTitle").getBoundingClientRect().top - document.querySelector("#skinDialogTitle").getBoundingClientRect().bottom) / 2) < 1,
      footerAlign: getComputedStyle(dialog.lastElementChild).justifyContent, preference: window.__skinTestHook.getPreference(),
      pageTheme: document.documentElement.dataset.theme, locale: localStorage.getItem("codexUsageLocale"), business: { range: document.querySelector("#rangeLabel").textContent, modelSearch: document.querySelector("#modelComparisonSearch").value, repositorySearch: document.querySelector("#repositoryComparisonSearch").value },
      accentFilter: getComputedStyle(document.querySelector(".skin-icon-accent")).filter, accentOverride: document.documentElement.style.getPropertyValue("--skin-active-accent"),
      paletteOverrides: [...document.documentElement.style].filter((name) => name.startsWith("--") && name !== "--skin-active-accent"), artCount: document.querySelectorAll("#skinCharacters img[src]").length,
      rowCounts: [...rows.values()], columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length, gridOverflowY: grid.scrollHeight - grid.clientHeight,
      dialogOverflowY: dialog.scrollHeight - dialog.clientHeight, pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      controlsVisible: ["#skinOpacity", "#resetSkinClassicButton", "#closeSkinDialogButton"].every((selector) => { const b = document.querySelector(selector).getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth; }),
      // R6 framing/50% stays independent of the main opacity controls.
      previewCount: dialog.querySelectorAll(".skin-preview-art").length,
      fixedPreviewOpacity: [...dialog.querySelectorAll(".skin-preview-art")].every((image) => getComputedStyle(image).opacity === "0.5"),
      retainedCopy: Boolean(dialog.querySelector(".dialog-copy")),
      dialogSections: dialogChildren.map((node) => node.className),
      sectionGap: parseFloat(getComputedStyle(dialog).rowGap),
      sectionGaps: dialogChildren.slice(1).map((node, index) => node.getBoundingClientRect().top - dialogChildren[index].getBoundingClientRect().bottom),
      otherDialogCopyCount: document.querySelectorAll("#importDialog .dialog-copy, #pricingDialog .dialog-copy").length,
      labelledTitle: document.getElementById(dialog.getAttribute("aria-labelledby"))?.textContent,
      previewLabels: dialog.querySelectorAll(".skin-preview-mode").length,
    };
  });
}

async function focusIs(page, id) {
  await page.waitForFunction((id) => (document.activeElement.id || document.activeElement.dataset.skinId) === id, id);
}

async function closed(page, label) {
  await page.waitForFunction(() => !window.__skinTestHook.isPickerOpen());
  await focusIs(page, "skinToggle");
  assert.equal(await page.locator("#skinToggle").getAttribute("aria-expanded"), "false", `${label}: invoker collapsed`);
  results.checkedClosures += 1;
}

async function run(theme, locale, width, height, offline = false) {
  const label = `${offline ? "offline/" : ""}${theme}/${locale}/${width}x${height}`;
  const context = await browser.newContext({ viewport: { width, height }, locale, timezoneId: "Asia/Shanghai", reducedMotion: "reduce" });
  await context.addInitScript(({ theme, locale }) => { localStorage.setItem("codexUsageTheme", theme); localStorage.setItem("codexUsageLocale", locale); }, { theme, locale });
  if (offline) await context.route("**/*", (route) => {
    if (/^https?:/.test(route.request().url())) { results.externalRequests.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  else await context.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) }));
  const page = await context.newPage();
  page.on("pageerror", (error) => results.errors.push(error.message));
  await page.goto(offline ? pathToFileURL(snapshot).href : `http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__skinTestHook);
  await page.evaluate(() => document.fonts.ready);
  await page.locator("#modelComparisonSearch").fill("r8 preserved model query");
  await page.locator("#repositoryComparisonSearch").fill("r8 preserved repository query");
  // Filling the below-fold searches scrolls the automation viewport. Compare
  // layout at a common scroll position, before the toolbar click can scroll it.
  await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector("#skinToggle").focus({ preventScroll: true }); });
  const baseline = await geometry(page);
  await page.locator("#skinToggle").click(); await focusIs(page, "resetSkinClassicButton");
  const initial = await state(page);
  assert.deepEqual(initial.ids, ids, `${label}: ten cards`);
  assert.equal(initial.removedReset, true); assert.equal(initial.oldActionWrapper, 0); assert.equal(initial.headingButtons, 1);
  assert.deepEqual(initial.footerIds, ["closeSkinDialogButton"]);
  assert.ok(initial.simpleInHeading && initial.simpleRightAligned && initial.simpleLevelWithTitle, `${label}: simple mode is on the right of the title`);
  assert.ok(initial.footerAtEnd && initial.footerFixed && initial.controlsVisible);
  assert.equal(initial.footerAlign, "flex-end");
  assert.equal(initial.simpleText, locale === "en-US" ? "Simple mode" : "简洁模式");
  assert.equal(initial.closeText, locale === "en-US" ? "Close" : "关闭");
  assert.equal(initial.simplePressed, "true"); assert.deepEqual(initial.selected, []); assert.deepEqual(initial.tabStops, ["chatgpt"]);
  assert.deepEqual(initial.closeStyle, initial.referenceStyle, `${label}: close uses the actual shared button recipe`);
  assert.equal(initial.closeStyle.minHeight, "36px"); assert.equal(initial.closeStyle.radius, "11px"); assert.equal(initial.closeStyle.padding, "0px 12px");
  // Menu options use compact height/type. Compare the inset material to the
  // actual selected option; keep standalone-action sizing equal to Close.
  const { transition: simpleTransition, padding: simplePadding, minHeight: simpleHeight, fontSize: simpleSize, ...simpleMaterial } = initial.simpleStyle;
  const { transition: referenceTransition, padding: referencePadding, minHeight: referenceHeight, fontSize: referenceSize, ...referenceMaterial } = initial.selectedReferenceStyle;
  assert.deepEqual(simpleMaterial, referenceMaterial, `${label}: selected simple mode uses the actual dashboard material, shape and emphasis`);
  assert.equal(simplePadding, initial.closeStyle.padding, `${label}: standalone action spacing follows the common close action`);
  assert.equal(simpleHeight, initial.closeStyle.minHeight);
  assert.equal(simpleSize, initial.closeStyle.fontSize);
  assert.ok(initial.simpleStyle.shadow.includes("inset"), `${label}: active simple mode is recessed`);
  assert.equal(initial.simpleGlow, initial.selectedReferenceGlow, `${label}: selected labels share the same subtle glow`);
  assert.equal(initial.retainedCopy, false, `${label}: redundant paragraph removed`);
  assert.deepEqual(initial.dialogSections, ["dialog-heading", "skin-controls", "skin-gallery-well", "dialog-actions"], `${label}: final reading order with no replacement copy`);
  assert.ok(initial.sectionGaps.every((gap) => Math.abs(gap - initial.sectionGap) < 1), `${label}: normal shared section spacing without an empty paragraph slot`);
  assert.equal(initial.otherDialogCopyCount, 2, `${label}: other dialogs retain their guidance`);
  assert.equal(initial.labelledTitle, locale === "en-US" ? "Model Character Skin" : "模型角色皮肤");
  assert.equal(initial.previewLabels, 20, `${label}: mode labels remain available`);
  assert.equal(initial.columns, width >= 1024 ? 5 : width > 720 ? 3 : 2);
  assert.equal(initial.dialogOverflowY, 0); assert.equal(initial.pageOverflowX, 0);
  if (width >= 1024) { assert.deepEqual(initial.rowCounts, [5, 5]); assert.ok(initial.gridOverflowY <= 1); }
  assert.deepEqual(await geometry(page), baseline, `${label}: opening leaves dashboard geometry`);

  // Focus trap wraps in both directions; group is one tab stop, not ten.
  await page.keyboard.press("Tab"); await focusIs(page, "skinOpacity");
  await page.keyboard.press("Tab"); await focusIs(page, "chatgpt");
  await page.keyboard.press("Tab"); await focusIs(page, "closeSkinDialogButton");
  await page.keyboard.press("Tab"); await focusIs(page, "resetSkinClassicButton");
  await page.keyboard.press("Shift+Tab"); await focusIs(page, "closeSkinDialogButton");
  await page.keyboard.press("Shift+Tab"); await focusIs(page, "chatgpt");
  await page.keyboard.press("Enter"); await focusIs(page, "chatgpt");
  assert.equal((await state(page)).preference.skinId, "chatgpt");
  const active = await state(page);
  assert.deepEqual(active.simpleStyle, { ...active.referenceStyle, radius: "10px" }, `${label}: inactive simple mode uses common standalone ceramic material and selector radius`);
  assert.equal(active.simplePressed, "false"); assert.notEqual(active.accentFilter, "none");
  if (!offline && locale === "zh-CN" && width === 1440) {
    await page.locator("#resetSkinClassicButton").hover();
    await page.mouse.down();
    const held = await state(page);
    for (const property of ["background", "edgeTop", "edgeBottom", "shadow"]) assert.equal(held.simpleStyle[property], held.selectedReferenceStyle[property], `${label}: pointer-down uses the reference inset ${property}`);
    assert.equal(held.preference.skinId, "chatgpt", `${label}: pointer-down has not activated the mode yet`);
    await page.mouse.up(); await focusIs(page, "resetSkinClassicButton");
    assert.equal((await state(page)).simplePressed, "true");
    await page.locator('.skin-card[data-skin-id="chatgpt"]').click(); await focusIs(page, "chatgpt");
    await page.mouse.move(0, 0);
    results.checkedPointerPresses += 1;
  }

  for (const [key, expected] of [["ArrowRight", "claude"], ["ArrowDown", "glm"], ["ArrowUp", "claude"], ["ArrowLeft", "chatgpt"], ["ArrowLeft", "mimo"], ["ArrowRight", "chatgpt"], ["End", "mimo"], ["Home", "chatgpt"]]) {
    await page.keyboard.press(key); await focusIs(page, expected);
    const selected = await state(page);
    assert.deepEqual(selected.selected, [expected]); assert.deepEqual(selected.tabStops, [expected]);
    assert.ok(selected.focusedCardVisible, `${label}/${key}: radio visible in the scroll area`);
  }
  await page.keyboard.press("Space");
  assert.equal((await state(page)).preference.skinId, "chatgpt", `${label}: native button Space selects`);
  await page.locator("#skinOpacity").fill("35"); await page.locator("#skinOpacity").dispatchEvent("input");
  await page.locator("#skinCharactersToggle").uncheck();
  const settings = await state(page);
  await page.locator("#resetSkinClassicButton").click(); await focusIs(page, "resetSkinClassicButton");
  const simple = await state(page);
  assert.deepEqual(simple.preference, { ...settings.preference, skinId: "classic" }, `${label}: only skinId resets`);
  assert.equal(simple.pageTheme, settings.pageTheme); assert.equal(simple.locale, settings.locale); assert.deepEqual(simple.business, settings.business);
  assert.equal(simple.business.modelSearch, "r8 preserved model query"); assert.equal(simple.business.repositorySearch, "r8 preserved repository query");
  assert.equal(simple.simplePressed, "true"); assert.deepEqual(simple.selected, []); assert.equal(simple.artCount, 0);
  assert.equal(simple.accentFilter, "none"); assert.equal(simple.accentOverride, ""); assert.deepEqual(simple.paletteOverrides, []);
  assert.ok(simple.fixedPreviewOpacity && simple.previewCount === 20); assert.ok(await page.evaluate(() => window.__skinTestHook.isPickerOpen()));
  assert.deepEqual(await geometry(page), baseline, `${label}: selection/reset leaves dashboard geometry`);

  if (!offline && locale === "zh-CN" && [1440, 1024, 390].includes(width)) {
    await page.evaluate(async () => { for (const image of document.querySelectorAll(".skin-preview-art")) image.loading = "eager"; await Promise.all([...document.querySelectorAll(".skin-preview-art")].map((image) => image.decode())); });
    await page.locator(".skin-dialog").screenshot({ path: path.join(output, `simple-inset-${theme}-${width}.png`) });
  }
  // Close button, Escape and backdrop share invoker/focus restoration.
  await page.locator("#closeSkinDialogButton").click(); await closed(page, label);
  await page.locator("#skinToggle").click(); await focusIs(page, "resetSkinClassicButton");
  await page.keyboard.press("Escape"); await closed(page, label);
  await page.locator("#skinToggle").click(); await focusIs(page, "resetSkinClassicButton");
  await page.locator("#skinDialog").click({ position: { x: 2, y: 2 } }); await closed(page, label);

  // A selected last-row card gets focus and scroll visibility on reopening.
  await page.evaluate(() => window.__skinTestHook.selectSkin("mimo"));
  await page.locator("#skinToggle").click(); await focusIs(page, "mimo");
  assert.ok((await state(page)).focusedCardVisible);
  await page.keyboard.press("Escape"); await closed(page, label);
  // Persisted 0%/35% and hidden-characters survive reopening/reload.
  await page.evaluate(() => window.__skinTestHook.setOpacity(0));
  await page.reload(); await page.waitForFunction(() => window.__skinTestHook);
  await page.locator("#skinToggle").click(); await focusIs(page, "mimo");
  const restored = await state(page);
  assert.equal(restored.preference.opacity, 0); assert.equal(restored.preference.showCharacters, false);
  await page.locator("#resetSkinClassicButton").click();
  assert.equal((await state(page)).preference.opacity, 0);
  results.states.push({ label, initial, active, simple, restored });
  await context.close();
}

try {
  const html = readFileSync(path.join(root, "public/index.html"), "utf8");
  const i18n = readFileSync(path.join(root, "public/i18n.js"), "utf8");
  const css = readFileSync(path.join(root, "public/skins.css"), "utf8");
  assert.ok(!html.includes(copyBaseline.removedCopy));
  assert.ok(!i18n.includes(copyBaseline.removedCopy) && !i18n.includes("Each skin uses its own artwork"), "removed paragraph has no dedicated English translation");
  assert.ok(!css.includes(".dialog-copy"), "no orphaned skin-specific copy style");
  assert.deepEqual([...html.matchAll(/<p class="dialog-copy">([^<]*)<\/p>/g)].map((match) => match[1]), copyBaseline.otherDialogCopies, "other dialog guidance remains byte-for-byte unchanged");
  for (const theme of ["light", "dark"]) for (const locale of ["zh-CN", "en-US"]) for (const [width, height] of cases) await run(theme, locale, width, height);
  writeFileSync(snapshot, renderStaticDashboardHtml(fixture));
  for (const theme of ["light", "dark"]) await run(theme, "en-US", 1024, 768, true);
  // Only the shared style changes from the previous header-button correction.
  const baseline = JSON.parse(readFileSync(path.join(output, "simple-inset-before-hashes.json"), "utf8"));
  const changed = Object.keys(baseline).filter((file) => createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex") !== baseline[file]);
  assert.deepEqual(changed.sort(), ["public/styles.css"]);
  results.productionChangesSinceR8 = changed;
  results.protectedUnchangedSinceR8 = Object.keys(baseline).length - changed.length;
  results.removedCopyAndTranslation = true;
  results.otherDialogCopyPreserved = true;
  assert.deepEqual(results.errors, []); assert.deepEqual(results.externalRequests, []);
  writeFileSync(path.join(output, "simple-inset-results.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`PASS: simple inset - ${results.states.length} contexts, top-right header placement, matching recent-menu inset material and glow, ${results.checkedClosures} closures, keyboard radios, preserved preferences and main geometry, both file:// modes.`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  if (process.env.SKIN_BUTTON_KEEP_SNAPSHOT !== "1") {
    try { unlinkSync(snapshot); } catch {}
    rmdirSync(tempDir);
  }
}
